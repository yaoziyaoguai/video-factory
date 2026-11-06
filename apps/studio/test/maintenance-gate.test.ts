import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  holdMaintenanceWork, maintenanceRequestHeaders, runWithMaintenanceAdmission, transitionMaintenanceGate,
} from "@video-factory/production-pipeline/maintenance";
import { MAINTENANCE_ADMISSION_PROTOCOL, MaintenanceGate, StudioMaintenanceError } from "../src/server/maintenance-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await transitionMaintenanceGate(directory, "open", "setup");
  const gate = new MaintenanceGate({ directory });
  await gate.announceStartup();
  return { directory, gate };
}

async function drain(directory: string) {
  await transitionMaintenanceGate(directory, "draining", "deploy-1");
}

describe("MaintenanceGate", () => {
  it("persists ownership before admission and leaves startup integrity unproven", async (t) => {
    const { directory, gate } = await setup(t);
    const startup = await gate.report();
    assert.equal(startup.protocol, MAINTENANCE_ADMISSION_PROTOCOL);
    assert.equal(startup.quiescent, false);
    const token = await gate.admit("POST /api/runs");
    assert.equal((await gate.report({ complete: true })).holders.length, 1);
    const saved = JSON.parse(await readFile(path.join(directory, "holders.json"), "utf8"));
    assert.equal(saved.holders[0].id, token.id);
    await gate.release(token);
    assert.equal((await gate.report({ complete: true })).quiescent, true);
  });

  it("rejects new work while draining or frozen without altering ownership", async (t) => {
    const { directory, gate } = await setup(t);
    await drain(directory);
    await assert.rejects(() => gate.admit("POST /api/runs"), (error: unknown) => {
      assert.ok(error instanceof StudioMaintenanceError);
      assert.equal(error.state, "draining");
      assert.equal(error.owner, "deploy-1");
      return true;
    });
    assert.equal(gate.currentInflight().length, 0);
    await transitionMaintenanceGate(directory, "frozen", "deploy-1");
    await assert.rejects(() => gate.admit("POST /api/runs"), /frozen/);
  });

  it("counts admitted work across gate closure and refuses to freeze until release", async (t) => {
    const { directory, gate } = await setup(t);
    const token = await gate.admit("POST /api/runs");
    await drain(directory);
    assert.equal((await gate.report({ complete: true })).quiescent, false);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-1"));
    await gate.release(token);
    await transitionMaintenanceGate(directory, "frozen", "deploy-1");
    assert.equal((await gate.currentGate())?.state, "frozen");
  });

  it("release waits for dynamically retained descendants and their finally work", async (t) => {
    const { directory, gate } = await setup(t);
    const first = deferred();
    const second = deferred();
    const descendantStarted = deferred();
    const token = await gate.admit("POST /api/runs");
    runWithMaintenanceAdmission(token, () => {
      holdMaintenanceWork(first.promise.then(() => {
        holdMaintenanceWork(second.promise);
        descendantStarted.resolve();
      }));
    });
    const released = gate.release(token);
    first.resolve();
    await descendantStarted.promise;
    await drain(directory);
    assert.equal((await gate.report({ complete: true })).holders.length, 1);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-1"));
    second.resolve();
    await released;
    assert.equal((await gate.report({ complete: true })).holders.length, 0);
  });

  it("fails closed for missing, malformed and unreadable configured gate state", async (t) => {
    const { directory, gate } = await setup(t);
    await writeFile(path.join(directory, "gate.json"), "{not json");
    await assert.rejects(() => gate.currentGate());
    await assert.rejects(() => gate.admit("POST /api/runs"));
    await rm(path.join(directory, "gate.json"));
    await assert.rejects(() => gate.currentGate());
    const locked = path.join(directory, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await assert.rejects(() => new MaintenanceGate({ directory: locked }).admit("POST /api/runs"),
        (error: NodeJS.ErrnoException) => error.code === "EACCES");
    } finally { await chmod(locked, 0o700); }
  });

  it("is explicitly disabled without a configured directory", async () => {
    const gate = new MaintenanceGate();
    const token = await gate.admit("POST /api/runs");
    assert.deepEqual(runWithMaintenanceAdmission(token, maintenanceRequestHeaders), {});
    await gate.release(token);
    assert.equal(gate.enabled, false);
  });
});
