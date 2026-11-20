import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const MAINTENANCE_ADMISSION_PROTOCOL = "video-factory/maintenance-admission-v2";
export const MAINTENANCE_ADMISSION_HEADER = "x-video-factory-admission";
export type MaintenanceGateState = "open" | "draining" | "frozen";

export interface MaintenanceGateSnapshot {
  state: MaintenanceGateState;
  owner: string;
  updatedAt: string;
  generation: number;
}

export interface AdmissionEntry {
  id: string;
  rootId: string;
  serviceId: string;
  kind: string;
  startedAt: string;
  parentId?: string;
}
export type MaintenanceAdmissionEntry = AdmissionEntry;

export interface MaintenanceAdmission extends AdmissionEntry {
  hold(promise: Promise<unknown>): void;
}

export interface MaintenanceAdmissionReport {
  protocol: typeof MAINTENANCE_ADMISSION_PROTOCOL;
  serviceId: string;
  pid: number;
  updatedAt: string;
  enabled: boolean;
  gateView: MaintenanceGateSnapshot | null;
  inflight: AdmissionEntry[];
  holders: AdmissionEntry[];
  ownCount: number;
  globalCount: number;
  integrity: { complete: boolean; issueCount: number };
  quiescent: boolean;
}

export class MaintenancePausedError extends Error {
  constructor(readonly state: MaintenanceGateState, readonly owner: string) {
    super(`Maintenance ${state}; work is paused.`);
    this.name = "MaintenancePausedError";
  }
}

export interface MaintenanceCoordinatorOptions {
  directory?: string;
  serviceId?: string;
  now?: () => Date;
}

interface ActiveAdmission {
  entry: AdmissionEntry;
  token: MaintenanceAdmission;
  holds: Set<Promise<void>>;
  version: number;
  acceptingHolds: boolean;
  released: boolean;
  releasePromise?: Promise<void> | undefined;
}

interface AdmissionContext {
  token: MaintenanceAdmission;
  record: ActiveAdmission;
  directory: string | undefined;
}

const admissionContext = new AsyncLocalStorage<AdmissionContext>();
const admissionContexts = new WeakMap<MaintenanceAdmission, AdmissionContext>();
const lockContexts = new AsyncLocalStorage<{ directory: string; active: boolean }>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_ATTEMPTS = 500;
const LOCK_RETRY_MS = 10;

/** 同一共享目录的准入、登记和状态切换使用同一个 mkdir 锁；残留锁不自动接管。 */
export async function withMaintenanceLock<T>(directory: string, operation: () => Promise<T> | T): Promise<T> {
  const root = path.resolve(directory);
  const held = lockContexts.getStore();
  if (held?.active && held.directory === root) {
    throw new Error("Maintenance lock is not reentrant; use the locked transition helper.");
  }
  await ensureDirectory(root);
  const lockPath = path.join(root, ".admission.lock");
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o770 });
      acquired = true;
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (attempt + 1 === LOCK_ATTEMPTS) throw new Error("Maintenance lock is busy; manual recovery may be required.");
      await delay(LOCK_RETRY_MS);
    }
  }
  if (!acquired) throw new Error("Maintenance lock was not acquired.");
  const context = { directory: root, active: true };
  try {
    await ensureSharedDirectoryMode(lockPath);
    return await lockContexts.run(context, operation);
  } finally {
    context.active = false;
    await rmdir(lockPath);
  }
}

export async function readMaintenanceGate(directory: string): Promise<MaintenanceGateSnapshot> {
  const gate = await readJson(path.join(directory, "gate.json"), "gate");
  if (!isRecord(gate)
    || !["open", "draining", "frozen"].includes(String(gate.state))
    || !isLabel(gate.owner) || !isTimestamp(gate.updatedAt)
    || !Number.isSafeInteger(gate.generation) || (gate.generation as number) < 0) {
    throw new Error("Maintenance gate is structurally invalid.");
  }
  return {
    state: gate.state as MaintenanceGateState, owner: gate.owner, updatedAt: gate.updatedAt,
    generation: gate.generation as number,
  };
}

export async function transitionMaintenanceGate(
  directory: string, state: MaintenanceGateState, owner: string,
): Promise<MaintenanceGateSnapshot> {
  return withMaintenanceLock(directory, () => transitionMaintenanceGateLocked(directory, state, owner));
}

/** 调用方可在同锁内先核对 live service 报告；不得脱离 withMaintenanceLock 调用。 */
export async function transitionMaintenanceGateLocked(
  directory: string, state: MaintenanceGateState, owner: string,
): Promise<MaintenanceGateSnapshot> {
  assertMaintenanceLock(directory);
  if (!["open", "draining", "frozen"].includes(state) || !isLabel(owner)) {
    throw new Error("Invalid maintenance transition.");
  }
  let current: MaintenanceGateSnapshot;
  try {
    current = await readMaintenanceGate(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT") || state !== "open") throw error;
    let holders: AdmissionEntry[];
    try { holders = await readMaintenanceHolders(directory); }
    catch (holderError) {
      if (!hasCode(holderError, "ENOENT")) throw holderError;
      holders = [];
      await writeHolders(directory, holders);
    }
    if (holders.length > 0) throw new Error("Maintenance initialization requires no existing holders.");
    const initial: MaintenanceGateSnapshot = { state, owner, updatedAt: new Date().toISOString(), generation: 0 };
    await writeJsonAtomically(path.join(directory, "gate.json"), initial);
    return initial;
  }
  const holders = await readMaintenanceHolders(directory);
  if (current.state === "open") {
    if (state === "frozen") throw new Error("Maintenance must drain before freezing.");
    if (state === "open" && owner !== current.owner) throw new Error("Maintenance owner does not match.");
  } else if (owner !== current.owner) {
    throw new Error("Maintenance owner does not match.");
  } else if (current.state === "frozen" && state === "draining") {
    throw new Error("Frozen maintenance cannot return to draining.");
  }
  if (state === "frozen" && holders.length > 0) throw new Error("Maintenance still has active holders.");
  if (state === current.state && owner === current.owner) return current;
  if (current.generation === Number.MAX_SAFE_INTEGER) throw new Error("Maintenance generation is exhausted.");
  const next = { state, owner, updatedAt: new Date().toISOString(), generation: current.generation + 1 };
  await writeJsonAtomically(path.join(directory, "gate.json"), next);
  return next;
}

export class MaintenanceCoordinator {
  readonly serviceId: string;
  private readonly directory: string | undefined;
  private readonly now: () => Date;
  private readonly active = new Map<string, ActiveAdmission>();

  constructor(options: MaintenanceCoordinatorOptions = {}) {
    this.directory = options.directory?.trim() ? path.resolve(options.directory) : undefined;
    this.serviceId = options.serviceId ?? `${process.pid}-${randomUUID()}`;
    if (!isLabel(this.serviceId) || this.serviceId === "." || this.serviceId === "..") {
      throw new Error("Invalid maintenance service id.");
    }
    this.now = options.now ?? (() => new Date());
  }

  get enabled(): boolean { return this.directory !== undefined; }

  async readGate(): Promise<MaintenanceGateSnapshot | null> {
    return this.directory ? readMaintenanceGate(this.directory) : null;
  }

  async admit(kind: string, parentId?: string): Promise<MaintenanceAdmission> {
    if (!isLabel(kind) || (parentId !== undefined && !UUID.test(parentId))) {
      throw new Error("Invalid maintenance admission.");
    }
    const id = randomUUID();
    let entry: AdmissionEntry;
    if (this.directory) {
      entry = await withMaintenanceLock(this.directory, async () => {
        const gate = await readMaintenanceGate(this.directory!);
        const holders = await readMaintenanceHolders(this.directory!);
        const parent = parentId === undefined ? undefined : holders.find((holder) => holder.id === parentId);
        if (parentId !== undefined && !parent) throw new Error("Maintenance parent admission is not active.");
        if (gate.state === "frozen" || (gate.state === "draining" && !parent)) {
          throw new MaintenancePausedError(gate.state, gate.owner);
        }
        const accepted = this.entry(id, kind, parent);
        await writeHolders(this.directory!, [...holders, accepted]);
        return accepted;
      });
    } else {
      const parent = parentId === undefined ? undefined : this.active.get(parentId)?.entry;
      if (parentId !== undefined && !parent) throw new Error("Maintenance parent admission is not active.");
      entry = this.entry(id, kind, parent);
    }
    const record: ActiveAdmission = {
      entry, token: undefined as unknown as MaintenanceAdmission, holds: new Set(), version: 0,
      acceptingHolds: true, released: false,
    };
    const token: MaintenanceAdmission = Object.freeze({
      ...entry,
      hold(promise: Promise<unknown>): void {
        if (!record.acceptingHolds || record.released) throw new Error("Maintenance admission is already closing.");
        record.version += 1;
        const settled = Promise.resolve(promise).then(() => undefined, () => undefined);
        record.holds.add(settled);
        void settled.then(() => record.holds.delete(settled));
      },
    });
    record.token = token;
    this.active.set(id, record);
    admissionContexts.set(token, { token, record, directory: this.directory });
    return token;
  }

  release(token: MaintenanceAdmission): Promise<void> {
    const context = admissionContexts.get(token);
    const record = this.active.get(token.id);
    if (context?.record.released) return Promise.resolve();
    if (!record || record.token !== token) return Promise.reject(new Error("Maintenance admission does not belong to this coordinator."));
    if (record.releasePromise) return record.releasePromise;
    const pending = this.finishRelease(record);
    record.releasePromise = pending;
    void pending.catch(() => { record.releasePromise = undefined; });
    return pending;
  }

  private async finishRelease(record: ActiveAdmission): Promise<void> {
    try {
      for (;;) {
        await Promise.allSettled([...record.holds]);
        const version = record.version;
        const remove = async (): Promise<boolean> => {
          if (record.holds.size > 0 || record.version !== version) return false;
          // 从最后一次检查到停止接收 hold 之间无 await；并发 admit 在共享锁内与删除串行。
          record.acceptingHolds = false;
          if (this.directory) {
            const holders = await readMaintenanceHolders(this.directory);
            const stored = holders.find((holder) => holder.id === record.entry.id);
            if (!stored || !sameEntry(stored, record.entry)) {
              throw new Error("Maintenance holder is missing or inconsistent.");
            }
            await writeHolders(this.directory, holders.filter((holder) => holder.id !== record.entry.id));
          }
          record.released = true;
          this.active.delete(record.entry.id);
          return true;
        };
        if (this.directory ? await withMaintenanceLock(this.directory, remove) : await remove()) return;
      }
    } catch (error) {
      // 写失败保留本地与磁盘 holder，允许显式重试；不能把失败释放伪装成静止。
      record.acceptingHolds = !record.released;
      throw error;
    }
  }

  async withAdmission<T>(
    kind: string, operation: (token: MaintenanceAdmission) => Promise<T> | T, parentId?: string,
  ): Promise<T> {
    const inherited = admissionContext.getStore();
    const parent = parentId ?? (inherited?.directory === this.directory && !inherited?.record.released ? inherited?.token.id : undefined);
    const token = await this.admit(kind, parent);
    try { return await runWithMaintenanceAdmission(token, () => operation(token)); }
    finally { await this.release(token); }
  }

  async announceStartup(): Promise<void> { await this.report(); }

  currentInflight(): AdmissionEntry[] { return [...this.active.values()].map(({ entry }) => ({ ...entry })); }

  async report(integrity?: { complete: boolean; issues?: unknown[] }): Promise<MaintenanceAdmissionReport> {
    const report = async (): Promise<MaintenanceAdmissionReport> => {
      const gate = await this.readGate();
      const inflight = this.currentInflight();
      const holders = this.directory ? await readMaintenanceHolders(this.directory) : inflight;
      const holdersById = new Map(holders.map((holder) => [holder.id, holder]));
      const missingOwnHolders = inflight.filter((entry) => {
        const holder = holdersById.get(entry.id);
        return !holder || !sameEntry(holder, entry);
      }).length;
      const issueCount = (integrity?.issues?.length ?? 0) + missingOwnHolders;
      const complete = integrity?.complete === true && issueCount === 0;
      const result: MaintenanceAdmissionReport = {
        protocol: MAINTENANCE_ADMISSION_PROTOCOL, serviceId: this.serviceId, pid: process.pid,
        updatedAt: this.now().toISOString(), enabled: this.enabled, gateView: gate,
        inflight, holders, ownCount: inflight.length, globalCount: holders.length,
        integrity: { complete, issueCount }, quiescent: complete && holders.length === 0,
      };
      if (this.directory) {
        const services = path.join(this.directory, "services");
        await ensureDirectory(services);
        await writeJsonAtomically(path.join(services, `${encodeURIComponent(this.serviceId)}.json`), result);
      }
      return result;
    };
    return this.directory ? withMaintenanceLock(this.directory, report) : report();
  }

  private entry(id: string, kind: string, parent?: AdmissionEntry): AdmissionEntry {
    return {
      id, rootId: parent?.rootId ?? id, serviceId: this.serviceId, kind,
      startedAt: this.now().toISOString(), ...(parent ? { parentId: parent.id } : {}),
    };
  }
}

export function runWithMaintenanceAdmission<T>(token: MaintenanceAdmission, operation: () => T): T {
  const context = admissionContexts.get(token);
  if (!context || context.record.released) throw new Error("Maintenance admission is not active in this process.");
  return admissionContext.run(context, operation);
}

export function holdMaintenanceWork<T>(promise: Promise<T>): Promise<T> {
  admissionContext.getStore()?.token.hold(promise);
  return promise;
}

export function maintenanceRequestHeaders(): Record<string, string> {
  const context = admissionContext.getStore();
  return context?.directory && !context.record.released && context.record.acceptingHolds
    ? { [MAINTENANCE_ADMISSION_HEADER]: context.token.id } : {};
}

export async function readMaintenanceHolders(directory: string): Promise<AdmissionEntry[]> {
  const record = await readJson(path.join(directory, "holders.json"), "holders");
  if (!isRecord(record) || record.protocol !== MAINTENANCE_ADMISSION_PROTOCOL || !Array.isArray(record.holders)) {
    throw new Error("Maintenance holders are structurally invalid.");
  }
  const seen = new Set<string>();
  const holders: AdmissionEntry[] = [];
  for (const entry of record.holders) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)
      || seen.has(entry.id) || typeof entry.rootId !== "string" || !UUID.test(entry.rootId)
      || !isLabel(entry.serviceId) || !isLabel(entry.kind) || !isTimestamp(entry.startedAt)
      || (entry.parentId !== undefined && (typeof entry.parentId !== "string" || !UUID.test(entry.parentId)))
      || (entry.parentId === undefined && entry.rootId !== entry.id)
      || entry.parentId === entry.id) {
      throw new Error("Maintenance holder is structurally invalid.");
    }
    seen.add(entry.id);
    holders.push({
      id: entry.id, rootId: entry.rootId, serviceId: entry.serviceId, kind: entry.kind, startedAt: entry.startedAt,
      ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
    });
  }
  const byId = new Map(holders.map((entry) => [entry.id, entry]));
  for (const entry of holders) {
    const ancestors = new Set([entry.id]);
    let current = entry;
    while (current.parentId && byId.has(current.parentId)) {
      const parent = byId.get(current.parentId)!;
      if (ancestors.has(parent.id) || parent.rootId !== entry.rootId) {
        throw new Error("Maintenance holder ancestry is inconsistent.");
      }
      ancestors.add(parent.id);
      current = parent;
    }
  }
  return holders;
}

async function writeHolders(directory: string, holders: AdmissionEntry[]): Promise<void> {
  await writeJsonAtomically(path.join(directory, "holders.json"), { protocol: MAINTENANCE_ADMISSION_PROTOCOL, holders });
}

async function writeJsonAtomically(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let created = false;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o660);
    created = true;
    try {
      // umask 不应去掉共享组写权限；父目录 setgid 提供组继承，不更换 owner/group。
      await handle.chmod(0o660);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, destination);
    published = true;
  } finally {
    if (created && !published) await rm(temporary, { force: true });
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o770 });
  if (created !== undefined) await ensureSharedDirectoryMode(directory);
}

async function ensureSharedDirectoryMode(directory: string): Promise<void> {
  // Linux 从宿主预设的 setgid 父目录继承共享组；受限服务不能再次显式设置 setgid。
  if (((await stat(directory)).mode & 0o7777) !== 0o2770) await chmod(directory, 0o2770);
}

async function readJson(file: string, label: string): Promise<unknown> {
  const bytes = await readFile(file, "utf8");
  try { return JSON.parse(bytes); }
  catch { throw new Error(`Maintenance ${label} is not valid JSON.`); }
}

function assertMaintenanceLock(directory: string): void {
  const held = lockContexts.getStore();
  if (!held?.active || held.directory !== path.resolve(directory)) {
    throw new Error("Maintenance transition requires its shared lock.");
  }
}
function sameEntry(left: AdmissionEntry, right: AdmissionEntry): boolean {
  return left.id === right.id && left.rootId === right.rootId && left.parentId === right.parentId
    && left.serviceId === right.serviceId && left.kind === right.kind && left.startedAt === right.startedAt;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}
function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
