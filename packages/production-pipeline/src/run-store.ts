import { link, open, mkdir, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowRun } from "@video-factory/workflow-core";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_TEMP_FILE = /^run\.json\.tmp-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STALE_LOCK_AGE_MS = 60_000;

/** 容错扫描认定的具体问题；detail 只携带位置/字段等脱敏事实，不包含原文件正文。 */
export type RunScanProblem = "invalid_json" | "invalid_structure" | "missing_run_json";

export interface RunScanIssue {
  runId: string;
  problem: RunScanProblem;
  detail?: string;
}

export interface RunScanResult<TInitialInput = unknown> {
  /** 可验证的健康记录，排序与 list() 相同；不包含任何问题目录。 */
  runs: WorkflowRun<TInitialInput>[];
  issues: RunScanIssue[];
  /** 只有零问题且没有吞掉任何系统错误时才为 true；不完整扫描不得用于全局完整性决策。 */
  complete: boolean;
}

export class FileRunStore {
  constructor(private readonly root: string) {}

  async create(run: WorkflowRun): Promise<void> {
    const runDirectory = this.runDirectory(run.id);
    await mkdir(runDirectory, { recursive: true });
    const destination = this.runPath(run.id);
    // 初创必须是防覆盖的原子发布：临时文件完整落盘后用 hard link 一次性出现，
    // 目标已存在时失败而不是覆盖；文件系统不支持则显式失败，不退化为直写最终文件。
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // 写入/发布前失败：清掉本次临时文件，不留下半个最终文件。
      await rm(temporary, { force: true });
      throw error;
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      if (hasCode(error, "EEXIST")) {
        throw new Error(`Run '${run.id}' already exists.`);
      }
      if (isHardLinkUnsupported(error)) {
        throw new Error(
          `Run store cannot atomically publish '${run.id}' on this filesystem (${(error as NodeJS.ErrnoException).code}).`,
        );
      }
      throw error;
    }
    let published = true;
    try {
      await this.syncPublishedDirectory(runDirectory);
    } catch (error) {
      // 发布后的目录sync失败：完整最终文件已经存在，保留它并报告错误，不回滚删除。
      published = false;
      throw new Error(
        `Run '${run.id}' was fully written but publishing it durably failed: ${(error as Error).message}`,
      );
    } finally {
      if (published) {
        await rm(temporary, { force: true });
      }
    }
  }

  async load<TInitialInput = unknown>(runId: string): Promise<WorkflowRun<TInitialInput>> {
    const payload = await readFile(this.runPath(runId), "utf8");
    const parsed = JSON.parse(payload) as WorkflowRun<TInitialInput>;
    const structureProblem = runStructureProblem(parsed, runId);
    if (structureProblem) {
      // 坏结构记录在读取边界显式失败，不让缺字段漏到排序/恢复处炸成整批失败。
      throw new Error(`Run '${runId}' record is structurally invalid: ${structureProblem}.`);
    }
    return parsed;
  }

  async list<TInitialInput = unknown>(): Promise<WorkflowRun<TInitialInput>[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const runs: WorkflowRun<TInitialInput>[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        runs.push(await this.load<TInitialInput>(entry.name));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    return runs.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
  }

  /**
   * 容错扫描：健康浏览与启动/周期恢复使用；list() 保持严格合同不变。
   * 坏文件原位保留；EACCES/EIO 等系统错误显式传播，只有真正的记录损坏进入 issues。
   */
  async scan<TInitialInput = unknown>(): Promise<RunScanResult<TInitialInput>> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { runs: [], issues: [], complete: true };
      }
      throw error;
    }

    const runs: WorkflowRun<TInitialInput>[] = [];
    const issues: RunScanIssue[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      let payload: string;
      try {
        payload = await readFile(this.runPath(entry.name), "utf8");
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          // 缺 run.json：除明确的临时残留外，任何已有数据都使扫描不完整，
          // 不能只按 nodes/ 白名单推断其它业务目录是 scratch。
          if (await hasFormalRunData(path.join(this.root, entry.name))) {
            issues.push({ runId: entry.name, problem: "missing_run_json" });
          }
          continue;
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // V8 的解析错误消息可能引用原文件片段，诊断不带它，避免泄露正文。
        issues.push({ runId: entry.name, problem: "invalid_json", detail: `run.json is not valid JSON (${Buffer.byteLength(payload)} bytes)` });
        continue;
      }
      const structureProblem = runStructureProblem(parsed, entry.name);
      if (structureProblem) {
        issues.push({ runId: entry.name, problem: "invalid_structure", detail: structureProblem });
        continue;
      }
      runs.push(parsed as WorkflowRun<TInitialInput>);
    }

    runs.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
    return { runs, issues, complete: issues.length === 0 };
  }

  async remove(runId: string): Promise<void> {
    await this.withLock(runId, async () => {
      await this.load(runId);
      await rm(this.runDirectory(runId), { recursive: true });
    });
  }

  async save(run: WorkflowRun, expectedRevision: number): Promise<void> {
    await this.withLock(run.id, async () => {
      const current = await this.load(run.id);
      if (current.revision !== expectedRevision || run.revision !== expectedRevision + 1) {
        throw new StaleRunRevisionError(run.id, expectedRevision, current.revision);
      }
      await this.writeAtomically(run);
    });
  }

  async checkpoint(run: WorkflowRun): Promise<void> {
    await this.withLock(run.id, async () => {
      const current = await this.load(run.id);
      if (current.revision !== run.revision) {
        throw new StaleRunRevisionError(run.id, run.revision, current.revision);
      }
      await this.writeAtomically(run);
    });
  }

  async update<TInitialInput = unknown>(
    runId: string,
    transition: (current: WorkflowRun<TInitialInput>) => Promise<WorkflowRun<TInitialInput>>,
  ): Promise<WorkflowRun<TInitialInput>> {
    return this.withLock(runId, async () => {
      const current = await this.load<TInitialInput>(runId);
      const updated = await transition(current);
      if (updated.id !== current.id || updated.revision !== current.revision + 1) {
        throw new StaleRunRevisionError(runId, current.revision, updated.revision);
      }
      await this.writeAtomically(updated);
      return updated;
    });
  }

  runDirectory(runId: string): string {
    validateRunId(runId);
    return path.join(this.root, runId);
  }

  runPath(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private async writeAtomically(run: WorkflowRun): Promise<void> {
    const destination = this.runPath(run.id);
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  }

  /** 发布后同步目录；protected 便于在受控测试中模拟发布期sync失败。 */
  protected async syncPublishedDirectory(runDirectory: string): Promise<void> {
    const handle = await open(runDirectory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.runDirectory(runId), "run.lock");
    const lock = await this.acquireLock(runId, lockPath);
    try {
      return await operation();
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }

  private async acquireLock(runId: string, lockPath: string): Promise<FileHandle> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(lockPath, "wx");
        try {
          await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
          return lock;
        } catch (error) {
          try {
            await lock.close();
          } finally {
            await rm(lockPath, { force: true });
          }
          throw error;
        }
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        if (attempt === 0 && await isStaleLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new RunLockedError(runId);
      }
    }
    throw new RunLockedError(runId);
  }
}

export class RunLockedError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' is locked by another writer.`);
    this.name = "RunLockedError";
  }
}

export class StaleRunRevisionError extends Error {
  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stale run revision for '${runId}': expected ${expectedRevision}, current revision is ${actualRevision}.`,
    );
    this.name = "StaleRunRevisionError";
  }
}

function validateRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`Unsafe run id '${runId}'.`);
  }
}

function isHardLinkUnsupported(error: unknown): boolean {
  return hasCode(error, "EPERM") || hasCode(error, "EOPNOTSUPP") || hasCode(error, "ENOSYS")
    || hasCode(error, "EXDEV") || hasCode(error, "EINVAL");
}

/** 只豁免本 store 的临时文件与空 scratch；未知文件/目录也不能作为完整扫描的依据。 */
async function hasFormalRunData(runDirectory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && RUN_TEMP_FILE.test(entry.name)) continue;
    // 旧 scratch 夹具使用空 tmp/；名称本身不能豁免其中可能残留的正式数据。
    if (entry.isDirectory() && entry.name === "tmp"
      && (await readdir(path.join(runDirectory, entry.name))).length === 0) continue;
    return true;
  }
  return false;
}

/**
 * 扫描/排序/恢复必需的最小结构校验；只检查这些路径真正读取的字段，
 * 不要求可选字段存在，保证合法历史记录仍可通过。
 */
function runStructureProblem(run: unknown, runId: string): string | undefined {
  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    return "record is not a JSON object";
  }
  const record = run as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id !== runId) {
    return "id does not match its directory";
  }
  if (typeof record.startedAt !== "string" || record.startedAt.length === 0) {
    return "startedAt is not a timestamp string";
  }
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 0) {
    return "revision is not a non-negative integer";
  }
  if (typeof record.status !== "string" || record.status.length === 0) {
    return "status is not a string";
  }
  const nodeRunsProblem = arrayStructureProblem(record.nodeRuns, "nodeRuns", "object");
  if (nodeRunsProblem) return nodeRunsProblem;
  for (const field of [
    "artifacts", "interventions", "decisions", "executionPlan", "executionReceipts",
    "spendAuthorizations", "creativeReviewOperations", "reviewContinuationOperations",
  ]) {
    if (record[field] === undefined) continue;
    const problem = arrayStructureProblem(record[field], field, "object");
    if (problem) return problem;
  }
  if (record.consumedSpendAuthorizationIds !== undefined) {
    const problem = arrayStructureProblem(record.consumedSpendAuthorizationIds, "consumedSpendAuthorizationIds", "string");
    if (problem) return problem;
  }
  for (const [index, node] of (record.nodeRuns as Record<string, unknown>[]).entries()) {
    const location = `nodeRuns[${index}]`;
    for (const field of ["nodeId", "status"]) {
      if (typeof node[field] !== "string" || node[field].length === 0) {
        return `${location}.${field} is not a non-empty string`;
      }
    }
    for (const field of ["artifactIds", "outcomeUncertainOperationIds"]) {
      if (node[field] === undefined) continue;
      const problem = arrayStructureProblem(node[field], `${location}.${field}`, "string");
      if (problem) return problem;
    }
    for (const field of ["qualityGateResults", "optionalReviewOperationRefs"]) {
      if (node[field] === undefined) continue;
      const problem = arrayStructureProblem(node[field], `${location}.${field}`, "object");
      if (problem) return problem;
    }
    for (const [gateIndex, result] of ((node.qualityGateResults ?? []) as Record<string, unknown>[]).entries()) {
      if (result.reasons === undefined) continue;
      const problem = arrayStructureProblem(result.reasons, `${location}.qualityGateResults[${gateIndex}].reasons`, "string");
      if (problem) return problem;
    }
    for (const field of ["inputState", "outputState"]) {
      const state = node[field];
      if (state === undefined) continue;
      if (!isRecord(state)) return `${location}.${field} is not a JSON object`;
      const versionsLocation = `${location}.${field}.versions`;
      const problem = arrayStructureProblem(state.versions, versionsLocation, "object");
      if (problem) return problem;
      const idFields = field === "outputState" ? ["artifactIds", "inputVersionIds"] : ["upstreamVersionIds"];
      for (const [versionIndex, version] of (state.versions as Record<string, unknown>[]).entries()) {
        for (const idField of idFields) {
          if (version[idField] === undefined) continue;
          const idsProblem = arrayStructureProblem(version[idField], `${versionsLocation}[${versionIndex}].${idField}`, "string");
          if (idsProblem) return idsProblem;
        }
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayStructureProblem(value: unknown, field: string, element: "object" | "string"): string | undefined {
  if (!Array.isArray(value)) return `${field} is not an array`;
  const invalidIndex = value.findIndex((item) => element === "object" ? !isRecord(item) : typeof item !== "string");
  if (invalidIndex >= 0) return `${field}[${invalidIndex}] is not a ${element === "object" ? "JSON object" : "string"}`;
  return undefined;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0) {
      return !isProcessAlive(payload.pid);
    }
  } catch {
    // A malformed lock is reclaimed only after a conservative age threshold.
  }

  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > STALE_LOCK_AGE_MS;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}
