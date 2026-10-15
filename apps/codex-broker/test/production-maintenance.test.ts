import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
interface Control {
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

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve; });
  }
}

async function fixture(t: TestContext, initialOwner = "installation") {
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
  await control.initialize(initialOwner);
  const reportPath = (entry: Service) => path.join(directory, "services", `${encodeURIComponent(entry.coordinator.serviceId)}.json`);
  return {
    directory, app, broker, registry, model, running, calls, control, service, health, reportPath,
    setHook(value?: HealthHook) { hook = value; },
    async readRecord(owner = OWNER) {
      return JSON.parse(await readFile(path.join(directory, `deployment-${owner}.json`), "utf8")) as {
        owner: string;
        bootstrap: boolean;
        serviceIds: string[];
        previous: Array<{ endpoint: string; release: string; serviceId: string }>;
      };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

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
