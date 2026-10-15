import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import * as shared from "../../../packages/production-pipeline/src/maintenance.js";
import { publicMaintenanceReport } from "../src/maintenance-gate.js";

type Gate = shared.MaintenanceGateSnapshot;
type PublicStatus = ReturnType<typeof publicMaintenanceReport> & {
  detail?: { aggregate?: PublicStatus };
  servers?: PublicStatus[];
};
interface Health {
  status: string;
  release: string;
  maintenance: PublicStatus;
}
interface ColdIdentity {
  previousRelease: string;
  candidateRelease: string;
  container: { id: string; image: string };
  brokerRelease: string;
  candidateEndpoints: string[];
}
interface ColdEvidence extends ColdIdentity {
  kind: "cold-upgrade";
  bootstrap: false;
  ingress: { closed: true; drained: true; statePath: string };
  writersStopped: true;
  integrity: { complete: true; quiescent: true };
  observedAt: string;
}
interface ColdAbortEvidence extends Omit<ColdEvidence, "kind" | "bootstrap" | "writersStopped" | "candidateEndpoints"> {
  kind: "cold-abort";
  writersRestored: true;
  candidateWritersStopped: true;
}
interface Control {
  coldPreflight(owner: string, identity: unknown): Promise<void>;
  coldEnter(owner: string, evidence: unknown): Promise<Gate>;
  coldAbort(owner: string, evidence: unknown): Promise<Gate>;
  initialize(owner: string): Promise<Gate>;
  status(): Promise<{ gate: Gate; holderCount: number }>;
  preflight(endpoints: string[]): Promise<unknown>;
  drain(owner: string, endpoints: string[]): Promise<Gate>;
  freeze(owner: string, endpoints: string[]): Promise<Gate>;
  verify(owner: string, endpoints: string[], release: string): Promise<Gate>;
  reopen(owner: string, endpoints: string[], release: string): Promise<Gate>;
  recover(owner: string): Promise<Gate>;
}
interface Service {
  coordinator: shared.MaintenanceCoordinator;
  integrity: { complete: boolean; issues?: unknown[] };
  aggregate?: Service;
  children: Service[];
}
type HealthHook = (endpoint: string, value: Health) => Promise<Health>;

const controllerUrl = new URL("../../../scripts/production-maintenance.mjs", import.meta.url).href;
const { maintenanceControl } = await import(controllerUrl) as {
  maintenanceControl(
    module: typeof shared,
    directory: string,
    readHealth: (endpoint: string) => Promise<Health>,
  ): Control;
};
const OLD_RELEASE = "b".repeat(40);
const NEW_RELEASE = "a".repeat(40);
const APP = "http://127.0.0.1:4310/api/health";
const BROKER = "unix:/isolated-maintenance/broker.sock";
const ENDPOINTS = [APP, BROKER];
const OWNER = "deploy-current";
const COLD_APP = "http://127.0.0.1:4317/api/health";
const COLD_ENDPOINTS = [COLD_APP, BROKER];
const OLD_IMAGE = `sha256:${"c".repeat(64)}`;

function coldEvidence(directory: string): ColdEvidence {
  return {
    kind: "cold-upgrade", bootstrap: false, previousRelease: OLD_RELEASE, candidateRelease: NEW_RELEASE,
    container: { id: "legacy-container", image: OLD_IMAGE }, brokerRelease: "/srv/broker/previous",
    candidateEndpoints: [...COLD_ENDPOINTS],
    ingress: { closed: true, drained: true, statePath: path.join(directory, "private-ingress.json") },
    writersStopped: true, integrity: { complete: true, quiescent: true }, observedAt: new Date().toISOString(),
  };
}

function abortEvidence(original: ColdEvidence): ColdAbortEvidence {
  return {
    kind: "cold-abort", previousRelease: original.previousRelease, candidateRelease: original.candidateRelease,
    container: { id: "restored-container", image: original.container.image }, brokerRelease: original.brokerRelease,
    ingress: { ...original.ingress }, writersRestored: true, candidateWritersStopped: true,
    integrity: { complete: true, quiescent: true }, observedAt: new Date().toISOString(),
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve; });
  }
}

async function fixture(t: TestContext, initialOwner: string | null = "installation") {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-maintenance-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let timestamp = Date.now();
  const service = (serviceId: string): Service => ({
    coordinator: new shared.MaintenanceCoordinator({
      directory,
      serviceId,
      now: () => new Date(++timestamp),
    }),
    integrity: { complete: true },
    children: [],
  });
  const app = service("app-epoch-1");
  const broker = service("broker-epoch-1");
  const registry = service("registry-epoch-1");
  const model = service("model-epoch-1");
  broker.aggregate = registry;
  registry.children.push(model);
  const running = new Map([
    [APP, { release: OLD_RELEASE, service: app }],
    [BROKER, { release: OLD_RELEASE, service: broker }],
  ]);
  const calls: string[] = [];
  let hook: HealthHook | undefined;
  const publish = async (entry: Service): Promise<PublicStatus> => ({
    ...publicMaintenanceReport(await entry.coordinator.report(entry.integrity)),
    ...(entry.aggregate ? { detail: { aggregate: await publish(entry.aggregate) } } : {}),
    ...(entry.children.length ? { servers: await Promise.all(entry.children.map(publish)) } : {}),
  });
  const health = async (endpoint: string): Promise<Health> => {
    calls.push(endpoint);
    const entry = running.get(endpoint);
    assert.ok(entry, `unexpected health endpoint ${endpoint}`);
    const value = { status: "ok", release: entry.release, maintenance: await publish(entry.service) };
    return hook ? hook(endpoint, value) : value;
  };
  const control = maintenanceControl(shared, directory, health);
  if (initialOwner !== null) await control.initialize(initialOwner);
  const reportPath = (entry: Service) => path.join(directory, "services", `${encodeURIComponent(entry.coordinator.serviceId)}.json`);
  return {
    directory, app, broker, registry, model, running, calls, control, service, health, reportPath,
    setHook(value?: HealthHook) { hook = value; },
    async readRecord(owner = OWNER) {
      return JSON.parse(await readFile(path.join(directory, `deployment-${owner}.json`), "utf8")) as {
        owner: string;
        kind?: string;
        cold?: ColdEvidence;
        retryOf?: string;
        bootstrap: boolean;
        serviceIds: string[];
        previous: Array<{ endpoint: string; release: string; serviceId: string }>;
      };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function coldFixture(t: TestContext) {
  const f = await fixture(t, null);
  const app = f.running.get(APP)!;
  f.running.delete(APP);
  f.running.set(COLD_APP, app);
  for (const entry of f.running.values()) entry.release = NEW_RELEASE;
  return f;
}

async function directorySnapshot(directory: string): Promise<Record<string, string | null>> {
  const entries: Record<string, string | null> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".admission.lock") continue;
    if (entry.isDirectory()) {
      entries[`${entry.name}/`] = null;
      for (const [child, value] of Object.entries(await directorySnapshot(path.join(directory, entry.name)))) {
        entries[`${entry.name}/${child}`] = value;
      }
    } else entries[entry.name] = await readFile(path.join(directory, entry.name), "utf8");
  }
  return entries;
}

async function rejectedWithoutWrites(f: Fixture, action: () => Promise<unknown>, error?: RegExp) {
  const before = await directorySnapshot(f.directory);
  if (error) await assert.rejects(action, error);
  else await assert.rejects(action);
  assert.deepEqual(await directorySnapshot(f.directory), before);
}

async function rejectedWithoutGateChange(f: Fixture, action: () => Promise<unknown>, error?: RegExp) {
  const gate = await readFile(path.join(f.directory, "gate.json"), "utf8");
  if (error) await assert.rejects(action, error);
  else await assert.rejects(action);
  assert.equal(await readFile(path.join(f.directory, "gate.json"), "utf8"), gate);
}

async function mutateLocalReport(f: Fixture, service: Service, mutate: (report: Record<string, unknown>) => void) {
  await shared.withMaintenanceLock(f.directory, async () => {
    const file = f.reportPath(service);
    const report = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    mutate(report);
    await writeFile(file, JSON.stringify(report));
  });
}

describe("production cold maintenance controller", () => {
  it("enters an absent gate through official locked transitions without classifying legacy as bootstrap", async (t) => {
    const f = await coldFixture(t);
    const evidence = coldEvidence(f.directory);
    const transitions: string[] = [];
    const control = maintenanceControl({
      ...shared,
      async transitionMaintenanceGateLocked(directory, state, owner) {
        transitions.push(state);
        const record = await f.readRecord();
        assert.equal(record.kind, "cold-upgrade");
        assert.deepEqual(record.cold, evidence);
        return shared.transitionMaintenanceGateLocked(directory, state, owner);
      },
    }, f.directory, f.health);
    const frozen = await control.coldEnter(OWNER, evidence);
    assert.deepEqual(transitions, ["open", "draining", "frozen"]);
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.owner, OWNER);
    assert.equal(frozen.generation, 2);
    const record = await f.readRecord();
    assert.equal(record.bootstrap, false);
    assert.deepEqual(record.previous, []);
    assert.deepEqual(record.serviceIds, []);
    assert.deepEqual(record.cold, evidence);
    assert.equal((await stat(path.join(f.directory, `deployment-${OWNER}.json`))).mode & 0o777, 0o600);
    assert.deepEqual(await shared.readMaintenanceHolders(f.directory), []);
    assert.deepEqual(f.calls, []);
    await assert.rejects(() => f.app.coordinator.admit("new-root"), shared.MaintenancePausedError);
  });

  it("waits for the actual shared admission lock before writing any cold state", async (t) => {
    const f = await coldFixture(t);
    const held = new Deferred<void>();
    const release = new Deferred<void>();
    const blocked = shared.withMaintenanceLock(f.directory, async () => { held.resolve(); await release.promise; });
    await held.promise;
    let finished = false;
    const entering = f.control.coldEnter(OWNER, coldEvidence(f.directory)).finally(() => { finished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(finished, false);
      assert.deepEqual(await directorySnapshot(f.directory), {});
    } finally { release.resolve(); await blocked; }
    assert.equal((await entering).state, "frozen");
  });

  const invalidEnter = [
    ["null", () => null], ["array", () => []],
    ...["kind", "bootstrap", "previousRelease", "candidateRelease", "container", "brokerRelease", "candidateEndpoints", "ingress",
      "writersStopped", "integrity", "observedAt"].map((key) => [
      `missing ${key}`, (value: Record<string, unknown>) => { delete value[key]; return value; },
    ] as const),
    ["bootstrap true", (value) => ({ ...value, bootstrap: true })],
    ["wrong kind", (value) => ({ ...value, kind: "bootstrap" })],
    ["short previous SHA", (value) => ({ ...value, previousRelease: OLD_RELEASE.slice(0, 12) })],
    ["uppercase candidate SHA", (value) => ({ ...value, candidateRelease: NEW_RELEASE.toUpperCase() })],
    ["array SHA", (value) => ({ ...value, candidateRelease: [NEW_RELEASE] })],
    ["identical releases", (value) => ({ ...value, candidateRelease: OLD_RELEASE })],
    ["empty container ID", (value) => ({ ...value, container: { id: " ", image: OLD_IMAGE } })],
    ["image tag", (value) => ({ ...value, container: { id: "old", image: "latest" } })],
    ["short image digest", (value) => ({ ...value, container: { id: "old", image: "sha256:abcd" } })],
    ["relative broker", (value) => ({ ...value, brokerRelease: "releases/old" })],
    ["control character path", (value) => ({ ...value, brokerRelease: "/releases/old\n" })],
    ["writers not stopped", (value) => ({ ...value, writersStopped: false })],
    ["ingress open", (value) => ({ ...value, ingress: { closed: false, drained: true, statePath: "/private/state" } })],
    ["ingress not drained", (value) => ({ ...value, ingress: { closed: true, drained: false, statePath: "/private/state" } })],
    ["relative ingress path", (value) => ({ ...value, ingress: { closed: true, drained: true, statePath: "state" } })],
    ["incomplete integrity", (value) => ({ ...value, integrity: { complete: false, quiescent: true } })],
    ["not quiescent", (value) => ({ ...value, integrity: { complete: true, quiescent: false } })],
    ["empty endpoints", (value) => ({ ...value, candidateEndpoints: [] })],
    ["missing broker endpoint", (value) => ({ ...value, candidateEndpoints: [COLD_APP] })],
    ["duplicate endpoints", (value) => ({ ...value, candidateEndpoints: [COLD_APP, COLD_APP] })],
    ["wrong app endpoint", (value) => ({ ...value, candidateEndpoints: [APP, BROKER] })],
    ["relative socket", (value) => ({ ...value, candidateEndpoints: [COLD_APP, "unix:broker.sock"] })],
    ["non-string endpoint", (value) => ({ ...value, candidateEndpoints: [COLD_APP, 123] })],
    ["invalid timestamp", (value) => ({ ...value, observedAt: "yesterday" })],
    ["rolled date", (value) => ({ ...value, observedAt: "2026-02-30T00:00:00.000Z" })],
    ["stale timestamp", (value) => ({ ...value, observedAt: new Date(Date.now() - 121_000).toISOString() })],
    ["future timestamp", (value) => ({ ...value, observedAt: new Date(Date.now() + 60_000).toISOString() })],
  ] satisfies Array<readonly [string, (value: Record<string, unknown>) => unknown]>;
  for (const [reason, corrupt] of invalidEnter) {
    it(`rejects ${reason} entry evidence without any writes`, async (t) => {
      const f = await coldFixture(t);
      await rejectedWithoutWrites(f, () => f.control.coldEnter(OWNER, corrupt({ ...coldEvidence(f.directory) })));
      assert.deepEqual(await readdir(f.directory), []);
    });
  }

  for (const entry of ["gate.json", "holders.json", "services", "deployment-other.json", "deployment-cold-abort-other.json", "unrecognized"]) {
    it(`rejects initial existing ${entry} even without a readable gate`, async (t) => {
      const f = await coldFixture(t);
      if (entry === "services") await mkdir(path.join(f.directory, entry));
      else await writeFile(path.join(f.directory, entry), "{}");
      await rejectedWithoutWrites(f, () => f.control.coldPreflight(OWNER, coldEvidence(f.directory)));
      await rejectedWithoutWrites(f, () => f.control.coldEnter(OWNER, coldEvidence(f.directory)));
    });
  }

  for (const state of ["open", "draining", "frozen"] as const) {
    it(`does not take over an existing ${state} gate or its original holder`, async (t) => {
      const f = await fixture(t);
      let task: shared.MaintenanceAdmission | undefined;
      if (state !== "frozen") task = await f.app.coordinator.admit("original-writer");
      if (state !== "open") await f.control.drain("original-owner", ENDPOINTS);
      if (state === "frozen") await f.control.freeze("original-owner", ENDPOINTS);
      await rejectedWithoutWrites(f, () => f.control.coldPreflight(OWNER, coldEvidence(f.directory)));
      await rejectedWithoutWrites(f, () => f.control.coldEnter(OWNER, coldEvidence(f.directory)));
      if (task) await f.app.coordinator.release(task);
    });
  }

  it("preflights without creating gate or recovery state and rechecks state at entry", async (t) => {
    const f = await coldFixture(t);
    const identity = coldEvidence(f.directory);
    await f.control.coldPreflight(OWNER, {
      previousRelease: identity.previousRelease, candidateRelease: identity.candidateRelease,
      container: { image: identity.container.image }, brokerRelease: identity.brokerRelease,
      candidateEndpoints: identity.candidateEndpoints,
    });
    assert.deepEqual(await readdir(f.directory), []);
    await f.control.initialize("other-owner");
    await rejectedWithoutWrites(f, () => f.control.coldEnter(OWNER, identity));
  });

  it("serializes competing cold owners and preserves the winner's exclusive evidence", async (t) => {
    const f = await coldFixture(t);
    const evidence = coldEvidence(f.directory);
    const results = await Promise.allSettled([
      f.control.coldEnter("cold-one", evidence), f.control.coldEnter("cold-two", evidence),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const gate = await shared.readMaintenanceGate(f.directory);
    const loser = gate.owner === "cold-one" ? "cold-two" : "cold-one";
    await assert.rejects(() => f.readRecord(loser), { code: "ENOENT" });
    await rejectedWithoutWrites(f, () => f.control.coldEnter(gate.owner, evidence));
    await rejectedWithoutWrites(f, () => f.control.coldAbort(loser, abortEvidence(evidence)), /owner|phase/);
  });

  it("keeps cold maintenance frozen when ordinary recover or freeze is requested", async (t) => {
    const f = await coldFixture(t);
    await f.control.coldEnter(OWNER, coldEvidence(f.directory));
    await rejectedWithoutWrites(f, () => f.control.recover(OWNER), /cold-abort/);
    await rejectedWithoutWrites(f, () => f.control.freeze(OWNER, []), /cold-enter/);
    assert.deepEqual(f.calls, []);
  });

  it("binds cold candidate release and the complete endpoint set before any live observation", async (t) => {
    const f = await coldFixture(t);
    await f.control.coldEnter(OWNER, coldEvidence(f.directory));
    for (const method of ["verify", "reopen"] as const) {
      for (const release of [OLD_RELEASE, NEW_RELEASE.slice(0, 12), "d".repeat(40)]) {
        await rejectedWithoutWrites(f, () => f.control[method](OWNER, COLD_ENDPOINTS, release), /candidate release/);
      }
      for (const endpoints of [[], [COLD_APP], [BROKER], [COLD_APP, COLD_APP], [COLD_APP, "unix:/other.sock"], [APP, BROKER]]) {
        await rejectedWithoutWrites(f, () => f.control[method](OWNER, endpoints, NEW_RELEASE), /candidate endpoints/);
      }
    }
    assert.deepEqual(f.calls, []);
    const frozen = await f.control.verify(OWNER, [...COLD_ENDPOINTS].reverse(), NEW_RELEASE);
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.generation, 2);
    assert.equal((await f.control.reopen(OWNER, COLD_ENDPOINTS, NEW_RELEASE)).state, "open");
    await rejectedWithoutWrites(f, () => f.control.coldEnter("next-cold", coldEvidence(f.directory)));
    await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, abortEvidence(coldEvidence(f.directory))), /owner|phase/);
  });

  it("retains exact v2 live release, report integrity and on-disk equality checks for cold candidates", async (t) => {
    const f = await coldFixture(t);
    await f.control.coldEnter(OWNER, coldEvidence(f.directory));
    f.running.get(BROKER)!.release = OLD_RELEASE;
    await rejectedWithoutGateChange(f, () => f.control.verify(OWNER, COLD_ENDPOINTS, NEW_RELEASE), /release/);
    f.running.get(BROKER)!.release = NEW_RELEASE;
    f.setHook(async (_endpoint, value) => {
      value.maintenance.protocol = "video-factory/maintenance-admission-v1";
      return value;
    });
    await rejectedWithoutGateChange(f, () => f.control.verify(OWNER, COLD_ENDPOINTS, NEW_RELEASE), /protocol/);
    f.setHook();
    f.model.integrity = { complete: false };
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, COLD_ENDPOINTS, NEW_RELEASE), /not completely drained/);
    f.model.integrity = { complete: true };
    f.setHook(async (endpoint, value) => {
      if (endpoint === COLD_APP) await mutateLocalReport(f, f.app, (report) => { report.updatedAt = "2000-01-01T00:00:00.000Z"; });
      return value;
    });
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, COLD_ENDPOINTS, NEW_RELEASE), /report.*changed/);
    f.setHook();
    assert.equal((await f.control.reopen(OWNER, COLD_ENDPOINTS, NEW_RELEASE)).state, "open");
  });

  const invalidAbort = [
    ["wrong previous source", (value) => ({ ...value, previousRelease: "d".repeat(40) })],
    ["wrong candidate", (value) => ({ ...value, candidateRelease: "d".repeat(40) })],
    ["wrong image", (value) => ({ ...value, container: { id: "restored", image: `sha256:${"d".repeat(64)}` } })],
    ["wrong broker artifact", (value) => ({ ...value, brokerRelease: "/srv/broker/different" })],
    ["wrong ingress", (value) => ({ ...value, ingress: { closed: true, drained: true, statePath: "/other/state" } })],
    ["stale evidence", (value) => ({ ...value, observedAt: new Date(Date.now() - 121_000).toISOString() })],
    ["future evidence", (value) => ({ ...value, observedAt: new Date(Date.now() + 60_000).toISOString() })],
    ["earlier observation", (value) => ({ ...value, observedAt: new Date(Date.now() - 60_000).toISOString() })],
    ["candidate still running", (value) => ({ ...value, candidateWritersStopped: false })],
    ["missing candidate stop proof", (value) => { delete value.candidateWritersStopped; return value; }],
    ["originals not restored", (value) => ({ ...value, writersRestored: false })],
    ["incomplete restored integrity", (value) => ({ ...value, integrity: { complete: false, quiescent: true } })],
    ["wrong abort kind", (value) => ({ ...value, kind: "cold-upgrade" })],
  ] satisfies Array<readonly [string, (value: Record<string, unknown>) => unknown]>;
  for (const [reason, corrupt] of invalidAbort) {
    it(`rejects cold abort with ${reason} without touching original evidence`, async (t) => {
      const f = await coldFixture(t);
      const original = coldEvidence(f.directory);
      await f.control.coldEnter(OWNER, original);
      await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, corrupt({ ...abortEvidence(original) })));
    });
  }

  it("rejects abort by another owner and any residual holder", async (t) => {
    const f = await coldFixture(t);
    const evidence = coldEvidence(f.directory);
    const frozen = await f.control.coldEnter(OWNER, evidence);
    await rejectedWithoutWrites(f, () => f.control.coldAbort("other-owner", abortEvidence(evidence)), /owner|phase/);
    const other = await fixture(t);
    const holder = await other.app.coordinator.admit("residual");
    const residual = await readFile(path.join(other.directory, "holders.json"));
    await other.app.coordinator.release(holder);
    await shared.withMaintenanceLock(f.directory, () => writeFile(path.join(f.directory, "holders.json"), residual));
    await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, abortEvidence(evidence)), /active holders/);
    assert.deepEqual(await shared.readMaintenanceGate(f.directory), frozen);
  });

  it("rejects ordinary deployment records and draining gates for cold abort", async (t) => {
    const f = await fixture(t);
    const evidence = abortEvidence(coldEvidence(f.directory));
    await f.control.drain(OWNER, ENDPOINTS);
    await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, evidence), /owner|phase/);
    await f.control.freeze(OWNER, ENDPOINTS);
    await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, evidence), /cold upgrade record/);
  });

  for (const reason of ["ownCount", "globalCount", "inflight", "holders", "gate", "identity", "protocol", "malformed"] as const) {
    it(`refuses cold abort with ${reason} in a candidate's stale service report`, async (t) => {
      const f = await coldFixture(t);
      const original = coldEvidence(f.directory);
      await f.control.coldEnter(OWNER, original);
      await f.app.coordinator.report({ complete: true });
      await mutateLocalReport(f, f.app, (report) => {
        if (reason === "ownCount" || reason === "globalCount") report[reason] = 1;
        if (reason === "inflight" || reason === "holders") report[reason] = [{}];
        if (reason === "gate") report.gateView = { state: "open", owner: "other", generation: 0 };
        if (reason === "identity") report.serviceId = "unrelated";
        if (reason === "protocol") report.protocol = "video-factory/maintenance-admission-v1";
      });
      if (reason === "malformed") await writeFile(f.reportPath(f.app), "{");
      await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, abortEvidence(original)));
    });
  }

  it("durably aborts with a new container ID, preserves original evidence and snapshots idle candidate reports", async (t) => {
    const f = await coldFixture(t);
    const original = coldEvidence(f.directory);
    const frozen = await f.control.coldEnter(OWNER, original);
    const originalBytes = await readFile(path.join(f.directory, `deployment-${OWNER}.json`), "utf8");
    // 未启动完成的候选也能回滚：完整静止证明来自已停候选、已恢复原版本的宿主复核。
    await f.app.coordinator.report();
    const reportBytes = await readFile(f.reportPath(f.app));
    const proof = abortEvidence(original);
    const opened = await f.control.coldAbort(OWNER, proof);
    assert.equal(opened.state, "open");
    assert.equal(opened.owner, OWNER);
    assert.equal(opened.generation, frozen.generation + 1);
    assert.equal(await readFile(path.join(f.directory, `deployment-${OWNER}.json`), "utf8"), originalBytes);
    const aborted = JSON.parse(await readFile(path.join(f.directory, `deployment-cold-abort-${OWNER}.json`), "utf8"));
    assert.equal(aborted.kind, "cold-abort");
    assert.deepEqual(aborted.cold, proof);
    assert.deepEqual(aborted.frozenGate, frozen);
    assert.deepEqual(aborted.serviceReports, [{ name: path.basename(f.reportPath(f.app)), sha256: createHash("sha256").update(reportBytes).digest("hex") }]);
    assert.equal((await stat(path.join(f.directory, `deployment-cold-abort-${OWNER}.json`))).mode & 0o777, 0o600);
    await rejectedWithoutWrites(f, () => f.control.coldAbort(OWNER, proof), /owner|phase/);
    await rejectedWithoutWrites(f, () => f.control.coldEnter(OWNER, coldEvidence(f.directory)), /owner/);
    const retry = { ...coldEvidence(f.directory), candidateRelease: "d".repeat(40), container: proof.container };
    await f.control.coldPreflight("cold-retry", retry);
    assert.equal((await f.control.coldEnter("cold-retry", retry)).state, "frozen");
    assert.equal((await f.readRecord("cold-retry")).retryOf, OWNER);
    assert.equal(await readFile(f.reportPath(f.app), "utf8"), reportBytes.toString("utf8"));
    assert.equal((await f.control.coldAbort("cold-retry", abortEvidence(retry))).state, "open");
    assert.equal((await f.control.coldEnter("cold-third", coldEvidence(f.directory))).state, "frozen");
    assert.equal((await f.readRecord("cold-third")).retryOf, "cold-retry");
  });

  for (const changed of ["source", "image", "broker", "changed report", "extra report", "missing report", "recovery file", "gate generation", "holder"] as const) {
    it(`rejects cold retry when ${changed} differs from the aborted provenance`, async (t) => {
      const f = await coldFixture(t);
      const original = coldEvidence(f.directory);
      await f.control.coldEnter(OWNER, original);
      await f.app.coordinator.report({ complete: true });
      await f.control.coldAbort(OWNER, abortEvidence(original));
      const retry = coldEvidence(f.directory);
      if (changed === "source") retry.previousRelease = "d".repeat(40);
      if (changed === "image") retry.container.image = `sha256:${"d".repeat(64)}`;
      if (changed === "broker") retry.brokerRelease = "/srv/broker/other";
      if (changed === "changed report") await f.app.coordinator.report({ complete: true });
      if (changed === "extra report") await f.broker.coordinator.report({ complete: true });
      if (changed === "missing report") await rm(f.reportPath(f.app));
      if (changed === "recovery file") await writeFile(path.join(f.directory, "deployment-unknown.json"), "{}");
      if (changed === "gate generation") {
        await shared.transitionMaintenanceGate(f.directory, "draining", OWNER);
        await shared.transitionMaintenanceGate(f.directory, "open", OWNER);
      }
      const holder = changed === "holder" ? await f.app.coordinator.admit("new-work") : undefined;
      await rejectedWithoutWrites(f, () => f.control.coldPreflight("cold-retry", retry));
      await rejectedWithoutWrites(f, () => f.control.coldEnter("cold-retry", retry));
      if (holder) await f.app.coordinator.release(holder);
    });
  }

  it("supports CLI cold-preflight, cold-enter and cold-abort using host-private JSON paths", async (t) => {
    const f = await coldFixture(t);
    const proofDirectory = await mkdtemp(path.join(tmpdir(), "vf-cold-host-proof-"));
    t.after(() => rm(proofDirectory, { recursive: true, force: true }));
    const proofFile = path.join(proofDirectory, "proof.json");
    const proof = coldEvidence(proofDirectory);
    await writeFile(proofFile, JSON.stringify(proof), { mode: 0o600 });
    const command = (operation: string, args: string[]) => promisify(execFile)(process.execPath, [
      "--import", "tsx", fileURLToPath(controllerUrl),
      fileURLToPath(new URL("../../../packages/production-pipeline/src/maintenance.ts", import.meta.url)),
      f.directory, operation, OWNER, ...args,
    ]);
    await command("cold-preflight", [proofFile]);
    assert.deepEqual(await readdir(f.directory), []);
    await assert.rejects(() => command("cold-enter", []), /requires exactly one/);
    await assert.rejects(() => command("cold-enter", [proofFile, proofFile]), /requires exactly one/);
    assert.equal(JSON.parse((await command("cold-enter", [proofFile])).stdout).state, "frozen");
    await writeFile(proofFile, JSON.stringify(abortEvidence(proof)), { mode: 0o600 });
    const result = await command("cold-abort", [proofFile]);
    assert.equal(JSON.parse(result.stdout).state, "open");
    assert.ok(!result.stdout.includes(proof.container.id));
    assert.ok(!result.stdout.includes(proof.brokerRelease));
  });
});

describe("production maintenance controller", () => {
  it("drains, freezes and reopens only after every candidate reports the exact release", async (t) => {
    const f = await fixture(t);
    const draining = await f.control.drain(OWNER, ENDPOINTS);
    assert.equal(draining.state, "draining");
    const record = await f.readRecord();
    assert.equal(record.owner, OWNER);
    assert.deepEqual(new Set(record.serviceIds), new Set([
      "app-epoch-1", "broker-epoch-1", "registry-epoch-1", "model-epoch-1",
    ]));
    assert.deepEqual(record.previous.map(({ release }) => release), [OLD_RELEASE, OLD_RELEASE]);
    const frozen = await f.control.freeze(OWNER, [...ENDPOINTS].reverse());
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.generation, draining.generation + 1);
    f.running.get(APP)!.release = NEW_RELEASE;
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, ENDPOINTS, NEW_RELEASE), /release/);
    f.running.get(BROKER)!.release = NEW_RELEASE;
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, ENDPOINTS, NEW_RELEASE.slice(0, 12)), /release/);
    const opened = await f.control.reopen(OWNER, [...ENDPOINTS].reverse(), NEW_RELEASE);
    assert.equal(opened.state, "open");
    assert.equal(opened.generation, frozen.generation + 1);
    const next = await f.app.coordinator.admit("new-work");
    await f.app.coordinator.release(next);
  });

  it("verifies a candidate without leaving FROZEN and rejects an incorrect release", async (t) => {
    const f = await fixture(t);
    await f.control.drain(OWNER, ENDPOINTS);
    const frozen = await f.control.freeze(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.verify(OWNER, ENDPOINTS, NEW_RELEASE), /release/);
    for (const entry of f.running.values()) entry.release = NEW_RELEASE;
    const verified = await f.control.verify(OWNER, ENDPOINTS, NEW_RELEASE);
    assert.deepEqual(verified, frozen);
    assert.deepEqual(await shared.readMaintenanceGate(f.directory), frozen);
    await assert.rejects(() => f.app.coordinator.admit("new-root"), shared.MaintenancePausedError);
  });

  it("requires an empty holder barrier before consulting health and retains the active holder", async (t) => {
    const f = await fixture(t);
    const task = await f.app.coordinator.admit("long-task");
    await f.control.drain(OWNER, ENDPOINTS);
    const calls = f.calls.length;
    await rejectedWithoutGateChange(f, () => f.control.freeze(OWNER, ENDPOINTS), /active holders/);
    assert.equal(f.calls.length, calls);
    assert.equal((await shared.readMaintenanceHolders(f.directory))[0]?.id, task.id);
    await f.app.coordinator.release(task);
    assert.equal((await f.control.freeze(OWNER, ENDPOINTS)).state, "frozen");
  });

  it("rejects a gate generation round trip during live health observation", async (t) => {
    const f = await fixture(t);
    await f.control.drain(OWNER, ENDPOINTS);
    const before = await shared.readMaintenanceGate(f.directory);
    f.setHook(async (endpoint, value) => {
      if (endpoint === APP) {
        await shared.transitionMaintenanceGate(f.directory, "open", OWNER);
        await shared.transitionMaintenanceGate(f.directory, "draining", OWNER);
      }
      return value;
    });
    await assert.rejects(() => f.control.freeze(OWNER, ENDPOINTS), /generation|different maintenance gate/);
    const after = await shared.readMaintenanceGate(f.directory);
    assert.equal(after.state, "draining");
    assert.equal(after.owner, OWNER);
    assert.equal(after.generation, before.generation + 2);
  });

  for (const mismatch of ["serviceId", "updatedAt", "gateView", "invalid-json", "missing"] as const) {
    it(`rejects a local report ${mismatch} mismatch after live health succeeds`, async (t) => {
      const f = await fixture(t);
      await f.control.drain(OWNER, ENDPOINTS);
      f.setHook(async (endpoint, value) => {
        if (endpoint === APP) {
          if (mismatch === "invalid-json") await writeFile(f.reportPath(f.app), "{");
          else if (mismatch === "missing") await rm(f.reportPath(f.app));
          else await mutateLocalReport(f, f.app, (report) => {
            if (mismatch === "serviceId") report.serviceId = "app-stale-epoch";
            if (mismatch === "updatedAt") report.updatedAt = "2000-01-01T00:00:00.000Z";
            if (mismatch === "gateView") report.gateView = { ...value.maintenance.gateView, generation: -1 };
          });
        }
        return value;
      });
      await rejectedWithoutGateChange(f, () => f.control.freeze(OWNER, ENDPOINTS));
    });
  }

  for (const source of ["live-app", "live-model", "local-app", "local-model"] as const) {
    it(`rejects incomplete run integrity reported by ${source}`, async (t) => {
      const f = await fixture(t);
      await f.control.drain(OWNER, ENDPOINTS);
      const entry = source.endsWith("app") ? f.app : f.model;
      if (source.startsWith("live")) entry.integrity = { complete: false, issues: ["unreadable_run"] };
      else f.setHook(async (endpoint, value) => {
        if (endpoint === (source.endsWith("app") ? APP : BROKER)) {
          await mutateLocalReport(f, entry, (report) => { report.integrity = { complete: false, issueCount: 1 }; });
        }
        return value;
      });
      await rejectedWithoutGateChange(f, () => f.control.freeze(OWNER, ENDPOINTS), /not completely drained|incomplete/);
    });
  }

  it("rejects old maintenance protocols before changing the open gate", async (t) => {
    const f = await fixture(t);
    f.setHook(async (_endpoint, value) => {
      value.maintenance.protocol = "video-factory/maintenance-admission-v1";
      return value;
    });
    await rejectedWithoutGateChange(f, () => f.control.drain(OWNER, ENDPOINTS), /protocol/);
    await assert.rejects(() => f.readRecord(), { code: "ENOENT" });
  });

  it("waits for every outstanding health observation before returning a protocol failure", async (t) => {
    const f = await fixture(t);
    const appObserved = new Deferred<void>();
    const brokerObserved = new Deferred<void>();
    const releaseBroker = new Deferred<void>();
    f.setHook(async (endpoint, value) => {
      if (endpoint === APP) {
        value.maintenance.protocol = "video-factory/maintenance-admission-v1";
        appObserved.resolve();
      } else {
        brokerObserved.resolve();
        await releaseBroker.promise;
      }
      return value;
    });
    let returned = false;
    const result = f.control.drain(OWNER, ENDPOINTS).then(
      () => { returned = true; return undefined; },
      (error: unknown) => { returned = true; return error; },
    );
    try {
      await Promise.all([appObserved.promise, brokerObserved.promise]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(returned, false);
    } finally { releaseBroker.resolve(); }
    const error = await result;
    assert.ok(error instanceof Error);
    assert.match(error.message, /protocol/);
    assert.equal((await shared.readMaintenanceGate(f.directory)).state, "open");
    await assert.rejects(() => f.readRecord(), { code: "ENOENT" });
  });

  it("keeps health and controller observations free of internal holder identities", async (t) => {
    const f = await fixture(t);
    const parent = await f.app.coordinator.admit("request");
    const child = await f.model.coordinator.admit("background-task", parent.id);
    const observations = [await f.health(APP), await f.health(BROKER), await f.control.preflight(ENDPOINTS), await f.control.status()];
    for (const observation of observations) {
      const json = JSON.stringify(observation);
      assert.ok(!json.includes(parent.id));
      assert.ok(!json.includes(child.id));
      assert.ok(!json.includes('"holders"'));
      assert.ok(!json.includes('"inflight"'));
    }
    const local = await readFile(f.reportPath(f.app), "utf8");
    assert.ok(local.includes(parent.id));
    assert.ok(local.includes(child.id));
    await f.app.coordinator.release(parent);
    await f.model.coordinator.release(child);
  });

  it("allows draining recovery with a long task only while original versions and identities remain", async (t) => {
    const f = await fixture(t);
    const task = await f.app.coordinator.admit("long-task");
    await f.control.drain(OWNER, ENDPOINTS);
    const original = await readFile(path.join(f.directory, "holders.json"), "utf8");
    f.running.get(BROKER)!.release = NEW_RELEASE;
    await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /release/);
    f.running.get(BROKER)!.release = OLD_RELEASE;
    assert.equal((await f.control.recover(OWNER)).state, "open");
    assert.equal(await readFile(path.join(f.directory, "holders.json"), "utf8"), original);
    assert.equal(f.app.coordinator.currentInflight()[0]?.id, task.id);
    await f.app.coordinator.release(task);
  });

  for (const restarted of ["app", "registry", "model"] as const) {
    it(`refuses draining recovery when the original ${restarted} epoch restarted`, async (t) => {
      const f = await fixture(t);
      await f.control.drain(OWNER, ENDPOINTS);
      const replacement = f.service(`${restarted}-epoch-2`);
      if (restarted === "app") f.running.get(APP)!.service = replacement;
      if (restarted === "registry") {
        replacement.children.push(f.model);
        f.broker.aggregate = replacement;
      }
      if (restarted === "model") f.registry.children.splice(0, 1, replacement);
      await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /restarted/);
    });
  }

  it("permits newly registered child services without losing any original service identity", async (t) => {
    const f = await fixture(t);
    await f.control.drain(OWNER, ENDPOINTS);
    f.registry.children.push(f.service("model-newly-registered"));
    assert.equal((await f.control.recover(OWNER)).state, "open");
  });

  it("requires frozen recovery to be empty and complete before restoring the exact old versions", async (t) => {
    const f = await fixture(t);
    await f.control.drain(OWNER, ENDPOINTS);
    await f.control.freeze(OWNER, ENDPOINTS);
    f.model.integrity = { complete: false, issues: ["unreadable_run"] };
    await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /not completely drained/);
    f.model.integrity = { complete: true };
    f.running.get(APP)!.release = NEW_RELEASE;
    await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /release/);
    f.running.get(APP)!.release = OLD_RELEASE;
    assert.equal((await f.control.recover(OWNER)).state, "open");
  });

  it("does not reopen a frozen gate with residual holders even if live reports previously looked idle", async (t) => {
    const f = await fixture(t);
    const task = await f.app.coordinator.admit("long-task");
    const residual = await readFile(path.join(f.directory, "holders.json"), "utf8");
    await f.app.coordinator.release(task);
    await f.control.drain(OWNER, ENDPOINTS);
    await f.control.freeze(OWNER, ENDPOINTS);
    await shared.withMaintenanceLock(f.directory, () => writeFile(path.join(f.directory, "holders.json"), residual));
    const calls = f.calls.length;
    await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /active holders/);
    assert.equal(f.calls.length, calls);
  });

  it("keeps a stale deployment owner from reopening a newer owner's gate", async (t) => {
    const f = await fixture(t);
    await f.control.drain("deploy-old", ENDPOINTS);
    await f.control.recover("deploy-old");
    await f.control.drain(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.recover("deploy-old"), /owner|phase/);
    await f.control.freeze(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.reopen("deploy-old", ENDPOINTS, OLD_RELEASE), /owner|phase/);
  });

  it("serializes simultaneous deployment owners without allowing the loser to recover the winner", async (t) => {
    const f = await fixture(t);
    const allObserved = new Deferred<void>();
    let observations = 0;
    f.setHook(async (_endpoint, value) => {
      if (++observations === 4) allObserved.resolve();
      await allObserved.promise;
      return value;
    });
    const results = await Promise.allSettled([
      f.control.drain("deploy-one", ENDPOINTS),
      f.control.drain("deploy-two", ENDPOINTS),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const gate = await shared.readMaintenanceGate(f.directory);
    const loser = gate.owner === "deploy-one" ? "deploy-two" : "deploy-one";
    assert.equal(gate.state, "draining");
    f.setHook();
    await rejectedWithoutGateChange(f, () => f.control.recover(loser));
    assert.equal((await f.control.recover(gate.owner)).state, "open");
  });

  it("does not use initialize to reopen an existing open, draining or frozen gate", async (t) => {
    const f = await fixture(t, OWNER);
    await rejectedWithoutGateChange(f, () => f.control.initialize(OWNER), /initialized/);
    await f.control.drain(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.initialize(OWNER), /initialized/);
    await f.control.freeze(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.initialize(OWNER), /initialized/);
  });

  it("requires all original endpoints to freeze and a nonempty unique candidate set to reopen", async (t) => {
    const f = await fixture(t);
    await f.control.drain(OWNER, ENDPOINTS);
    for (const endpoints of [[], [APP], [APP, APP], [APP, "unix:/isolated-maintenance/other.sock"]]) {
      await rejectedWithoutGateChange(f, () => f.control.freeze(OWNER, endpoints), /every original/);
    }
    await f.control.freeze(OWNER, ENDPOINTS);
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, [], NEW_RELEASE), /candidate/);
    await rejectedWithoutGateChange(f, () => f.control.reopen(OWNER, [APP, APP], NEW_RELEASE), /duplicated/);
  });

  it("permits an explicitly recorded first installation but cannot recover frozen bootstrap without original services", async (t) => {
    const f = await fixture(t, OWNER);
    await f.control.drain(OWNER, []);
    const record = await f.readRecord();
    assert.equal(record.bootstrap, true);
    assert.deepEqual(record.previous, []);
    assert.equal((await f.control.freeze(OWNER, [])).state, "frozen");
    await rejectedWithoutGateChange(f, () => f.control.recover(OWNER), /no prior services/);
    for (const entry of f.running.values()) entry.release = NEW_RELEASE;
    assert.equal((await f.control.reopen(OWNER, ENDPOINTS, NEW_RELEASE)).state, "open");
  });

  for (const existing of ["owner", "generation", "service-report", "holder"] as const) {
    it(`does not disguise existing ${existing} evidence as an empty first installation`, async (t) => {
      const f = await fixture(t, existing === "owner" ? "other-owner" : OWNER);
      let task: shared.MaintenanceAdmission | undefined;
      if (existing === "generation") {
        await shared.transitionMaintenanceGate(f.directory, "draining", OWNER);
        await shared.transitionMaintenanceGate(f.directory, "open", OWNER);
      }
      if (existing === "service-report") await f.app.coordinator.report({ complete: true });
      if (existing === "holder") task = await f.app.coordinator.admit("active");
      await rejectedWithoutGateChange(f, () => f.control.drain(OWNER, []));
      await assert.rejects(() => f.readRecord(), { code: "ENOENT" });
      if (task) await f.app.coordinator.release(task);
    });
  }
});
