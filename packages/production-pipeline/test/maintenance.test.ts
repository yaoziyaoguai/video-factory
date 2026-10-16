import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAINTENANCE_ADMISSION_HEADER, MAINTENANCE_ADMISSION_PROTOCOL,
  MaintenanceCoordinator, MaintenancePausedError, holdMaintenanceWork, maintenanceRequestHeaders,
  readMaintenanceGate, runWithMaintenanceAdmission, transitionMaintenanceGate,
  transitionMaintenanceGateLocked, withMaintenanceLock,
} from "../src/maintenance.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vf-shared-maintenance-"));
  // macOS tmpdir 可能继承非当前成员的 wheel 组，内核会清掉其 setgid；夹具明确模拟已配置共享组。
  await chown(root, process.getuid!(), process.getgid!());
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext) {
  const root = await temporaryDirectory(t);
  const directory = path.join(root, "maintenance");
  await transitionMaintenanceGate(directory, "open", "installation");
  const coordinator = new MaintenanceCoordinator({ directory, serviceId: "studio" });
  return { root, directory, coordinator };
}

// 独立 Node 进程通过 IPC 精确控制锁持有点；不靠 sleep 猜测竞态先后。
const childScript = `
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MaintenanceCoordinator, transitionMaintenanceGateLocked, withMaintenanceLock } from ${JSON.stringify(new URL("../src/maintenance.ts", import.meta.url).href)};
const [directory, action] = process.argv.slice(2);
const inbox = [];
const waiters = [];
process.on('message', value => { const waiter = waiters.shift(); waiter ? waiter(value) : inbox.push(value); });
const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiters.push(resolve));
const send = value => process.send(value);
try {
  if (action === 'hold-open-lock' || action === 'drain-under-lock') {
    await withMaintenanceLock(directory, async () => {
      if (action === 'drain-under-lock') await transitionMaintenanceGateLocked(directory, 'draining', 'deploy-race');
      send({ type: 'locked' });
      await next();
      if (action === 'drain-under-lock') {
        const { holders } = JSON.parse(await readFile(path.join(directory, 'holders.json'), 'utf8'));
        send({ type: 'while-locked', count: holders.length });
        await next();
      }
    });
    send({ type: 'unlocked' });
  } else if (action === 'admit') {
    const coordinator = new MaintenanceCoordinator({ directory, serviceId: 'child-' + process.pid });
    send({ type: 'attempting' });
    try {
      const token = await coordinator.admit('child-work');
      send({ type: 'admitted', id: token.id });
      await next();
      await coordinator.release(token);
      send({ type: 'released' });
    } catch (error) { send({ type: 'rejected', name: error.name }); }
  } else if (action === 'drain') {
    send({ type: 'attempting' });
    await withMaintenanceLock(directory, async () => {
      await transitionMaintenanceGateLocked(directory, 'draining', 'deploy-race');
    });
    send({ type: 'drained' });
  }
  process.disconnect();
} catch (error) {
  send({ type: 'error', name: error.name, message: error.message });
  process.exitCode = 1;
  process.disconnect();
}
`;

interface ChildMessage { type: string; id?: string; name?: string; message?: string; count?: number }
async function childActor(t: TestContext, root: string, directory: string, action: string) {
  const script = path.join(root, `actor-${randomUUID()}.mjs`);
  await writeFile(script, childScript);
  const child = fork(script, [directory, action], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    execArgv: ["--import", fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url))],
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const messages: ChildMessage[] = [];
  const waiters: Array<{ resolve: (value: ChildMessage) => void; reject: (error: Error) => void }> = [];
  let ended = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { ended = true; resolve(code); });
  });
  child.on("message", (message: ChildMessage) => {
    const waiting = waiters.shift();
    if (waiting) waiting.resolve(message); else messages.push(message);
  });
  child.once("close", () => {
    for (const waiting of waiters.splice(0)) waiting.reject(new Error(`Child exited before message: ${output}`));
  });
  t.after(async () => {
    if (!ended) child.kill();
    await exit;
  });
  return {
    child,
    messages,
    next(): Promise<ChildMessage> {
      if (messages.length) return Promise.resolve(messages.shift()!);
      if (ended) return Promise.reject(new Error(`Child already exited: ${output}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child message timeout: ${output}`)), 15_000);
        waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      });
    },
    async done() { assert.equal(await exit, 0, output); },
  };
}

function signal(child: ChildProcess): void { child.send({ continue: true }); }

describe("shared maintenance coordinator", { concurrency: false }, () => {
  it("allows unconfigured local work without forwarding admission headers", async () => {
    const coordinator = new MaintenanceCoordinator({ serviceId: "local" });
    assert.equal(coordinator.enabled, false);
    assert.equal(await coordinator.readGate(), null);
    await coordinator.withAdmission("local-operation", async (token) => {
      assert.equal(coordinator.currentInflight().length, 1);
      assert.deepEqual(maintenanceRequestHeaders(), {});
      holdMaintenanceWork(Promise.resolve());
      await coordinator.withAdmission("local-child", (child) => {
        assert.equal(child.rootId, token.id);
        assert.equal(child.parentId, token.id);
      });
    });
    assert.equal(coordinator.currentInflight().length, 0);
    assert.equal((await coordinator.report()).quiescent, false);
    assert.equal((await coordinator.report({ complete: true })).quiescent, true);
  });

  it("fails closed for missing, malformed and unreadable configured gates", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const gatePath = path.join(directory, "gate.json");
    const original = await readFile(gatePath, "utf8");
    await rm(gatePath);
    await assert.rejects(() => coordinator.readGate(), { code: "ENOENT" });
    await assert.rejects(() => coordinator.admit("missing"), { code: "ENOENT" });
    await assert.rejects(() => coordinator.announceStartup(), { code: "ENOENT" });
    for (const payload of ["{PRIVATE_SECRET", "null", "[]", JSON.stringify({ state: "open", owner: "x" }),
      JSON.stringify({ state: "wrong", owner: "x", updatedAt: new Date().toISOString(), generation: 0 })]) {
      await writeFile(gatePath, payload);
      await assert.rejects(() => coordinator.admit("malformed"), (error: Error) => !error.message.includes("PRIVATE_SECRET"));
      await assert.rejects(() => coordinator.report({ complete: true }));
    }
    await writeFile(gatePath, original);
    const originalRead = fs.readFile;
    const failure = Object.assign(new Error("injected read failure"), { code: "EIO" });
    const mock = t.mock.method(fs, "readFile", async (...args: unknown[]) => {
      if (args[0] === gatePath) throw failure;
      return Reflect.apply(originalRead, fs, args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => coordinator.admit("unreadable"), (error) => error === failure);
      await assert.rejects(() => transitionMaintenanceGate(directory, "draining", "deploy"), (error) => error === failure);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(coordinator.currentInflight(), []);
  });

  it("initializes only OPEN and fences state transitions by owner, generation and global holders", async (t) => {
    const root = await temporaryDirectory(t);
    const directory = path.join(root, "maintenance");
    await assert.rejects(() => transitionMaintenanceGate(directory, "draining", "deploy"));
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"));
    const initial = await transitionMaintenanceGate(directory, "open", "installation");
    assert.equal(initial.generation, 0);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"));
    const coordinator = new MaintenanceCoordinator({ directory });
    const token = await coordinator.admit("active");
    const draining = await transitionMaintenanceGate(directory, "draining", "deploy");
    assert.equal(draining.generation, 1);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"), /active holders/);
    await assert.rejects(() => transitionMaintenanceGate(directory, "open", "old-owner"), /owner/);
    await assert.rejects(() => transitionMaintenanceGate(directory, "draining", "old-owner"), /owner/);
    await coordinator.release(token);
    const frozen = await withMaintenanceLock(directory, () => transitionMaintenanceGateLocked(directory, "frozen", "deploy"));
    assert.equal(frozen.generation, 2);
    assert.deepEqual(await transitionMaintenanceGate(directory, "frozen", "deploy"), frozen);
    await assert.rejects(() => coordinator.admit("frozen"), MaintenancePausedError);
    await assert.rejects(() => transitionMaintenanceGateLocked(directory, "open", "deploy"), /shared lock/);
    const reopened = await transitionMaintenanceGate(directory, "open", "deploy");
    assert.equal(reopened.generation, 3);
    await transitionMaintenanceGate(directory, "draining", "next-owner");
    await assert.rejects(() => transitionMaintenanceGate(directory, "open", "deploy"), /owner/);
  });

  it("permits only active-parent continuations during draining and rejects released or forged parents in OPEN", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const broker = new MaintenanceCoordinator({ directory, serviceId: "broker" });
    await assert.rejects(() => broker.admit("forged", randomUUID()), /not active/);
    const root = await coordinator.admit("root");
    await transitionMaintenanceGate(directory, "draining", "deploy");
    await assert.rejects(() => broker.admit("new-root"), MaintenancePausedError);
    const child = await broker.admit("continued", root.id);
    assert.equal(child.rootId, root.rootId);
    await coordinator.release(root);
    await assert.rejects(() => broker.admit("released-parent", root.id), /not active/);
    const grandchild = await broker.admit("grandchild", child.id);
    assert.equal(grandchild.rootId, root.id);
    await broker.release(child);
    assert.equal((await broker.report({ complete: true })).globalCount, 1);
    await transitionMaintenanceGate(directory, "open", "deploy");
    await assert.rejects(() => broker.admit("released-in-open", child.id), /not active/);
    await broker.release(grandchild);
    assert.equal((await coordinator.report({ complete: true })).quiescent, true);
  });

  it("release is idempotent and waits for holds that append grandchildren after release started", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const root = await coordinator.admit("root");
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const secondAdded = deferred();
    const thirdAdded = deferred();
    runWithMaintenanceAdmission(root, () => {
      assert.equal(maintenanceRequestHeaders()[MAINTENANCE_ADMISSION_HEADER], root.id);
      root.hold(first.promise.then(() => {
        holdMaintenanceWork(second.promise.then(() => {
          root.hold(third.promise);
          thirdAdded.resolve();
        }));
        secondAdded.resolve();
      }));
    });
    const releasing = coordinator.release(root);
    assert.equal(coordinator.release(root), releasing);
    await transitionMaintenanceGate(directory, "draining", "deploy");
    first.resolve();
    await secondAdded.promise;
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"), /active holders/);
    second.resolve();
    await thirdAdded.promise;
    assert.equal((await coordinator.report({ complete: true })).globalCount, 1);
    third.resolve();
    await releasing;
    await coordinator.release(root);
    await transitionMaintenanceGate(directory, "frozen", "deploy");
    assert.throws(() => root.hold(Promise.resolve()), /closing/);
    assert.deepEqual(maintenanceRequestHeaders(), {});
  });

  it("keeps ALS continuations registered through failed operations and held rejections", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const pending = deferred();
    const started = deferred();
    const failure = new Error("business failure");
    const result = coordinator.withAdmission("root", async (root) => {
      await transitionMaintenanceGate(directory, "draining", "deploy");
      await coordinator.withAdmission("nested", (child) => {
        assert.equal(child.parentId, root.id);
        assert.equal(maintenanceRequestHeaders()[MAINTENANCE_ADMISSION_HEADER], child.id);
      });
      holdMaintenanceWork(pending.promise);
      started.resolve();
      throw failure;
    });
    const rejected = assert.rejects(result, (error) => error === failure);
    await started.promise;
    assert.equal((await coordinator.report({ complete: true })).globalCount, 1);
    pending.reject(new Error("held failure"));
    await rejected;
    assert.equal((await coordinator.report({ complete: true })).globalCount, 0);
  });

  it("startup and per-service reports retain global holders and omit business issue payloads", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const token = await coordinator.admit("root");
    const restarted = new MaintenanceCoordinator({ directory, serviceId: "studio" });
    const broker = new MaintenanceCoordinator({ directory, serviceId: "broker/model" });
    await restarted.announceStartup();
    await broker.announceStartup();
    const report = await restarted.report({ complete: true });
    assert.equal(report.ownCount, 0);
    assert.equal(report.globalCount, 1);
    assert.equal(report.quiescent, false);
    assert.equal(report.holders[0]?.id, token.id);
    const unsafe = await broker.report({ complete: true, issues: [{ payload: "PRIVATE_SECRET" }] });
    assert.deepEqual(unsafe.integrity, { complete: false, issueCount: 1 });
    assert.equal(JSON.stringify(unsafe).includes("PRIVATE_SECRET"), false);
    assert.deepEqual((await readdir(path.join(directory, "services"))).sort(), ["broker%2Fmodel.json", "studio.json"]);
    const disk = await readFile(path.join(directory, "services", "broker%2Fmodel.json"), "utf8");
    assert.equal(disk.includes("PRIVATE_SECRET"), false);
    assert.equal(JSON.parse(disk).protocol, MAINTENANCE_ADMISSION_PROTOCOL);
    await coordinator.release(token);
  });

  it("does not report quiescent when a live local holder has disappeared from the persistent set", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const token = await coordinator.admit("root");
    const holdersPath = path.join(directory, "holders.json");
    const original = await readFile(holdersPath, "utf8");
    await writeFile(holdersPath, JSON.stringify({ protocol: MAINTENANCE_ADMISSION_PROTOCOL, holders: [] }));
    const report = await coordinator.report({ complete: true });
    assert.equal(report.globalCount, 0);
    assert.equal(report.ownCount, 1);
    assert.equal(report.quiescent, false);
    assert.deepEqual(report.integrity, { complete: false, issueCount: 1 });
    await assert.rejects(() => coordinator.release(token), /missing or inconsistent/);
    await writeFile(holdersPath, original);
    await coordinator.release(token);
  });

  it("fails closed on corrupt or missing holders without repairing them or clearing ownership", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const token = await coordinator.admit("root");
    await transitionMaintenanceGate(directory, "draining", "deploy");
    const holdersPath = path.join(directory, "holders.json");
    const original = await readFile(holdersPath, "utf8");
    const own = JSON.parse(original).holders[0];
    const malformed = ["{PRIVATE_SECRET", "[]", "{}", JSON.stringify({ protocol: MAINTENANCE_ADMISSION_PROTOCOL, holders: [null] }),
      JSON.stringify({ protocol: MAINTENANCE_ADMISSION_PROTOCOL, holders: [own, own] })];
    for (const bytes of malformed) {
      await writeFile(holdersPath, bytes);
      await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"));
      await assert.rejects(() => coordinator.admit("child", token.id));
      await assert.rejects(() => coordinator.release(token));
      await assert.rejects(() => coordinator.announceStartup());
      assert.equal(await readFile(holdersPath, "utf8"), bytes);
      assert.equal(coordinator.currentInflight().length, 1);
    }
    await rm(holdersPath);
    await assert.rejects(() => coordinator.report({ complete: true }), { code: "ENOENT" });
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy"), { code: "ENOENT" });
    await writeFile(holdersPath, original);
    await coordinator.release(token);
  });

  it("never admits after a holder write failure and preserves holders after a release write failure", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const holdersPath = path.join(directory, "holders.json");
    const initial = await readFile(holdersPath, "utf8");
    const originalRename = fs.rename;
    const failure = Object.assign(new Error("injected disk failure"), { code: "EIO" });
    const inject = () => {
      const mock = t.mock.method(fs, "rename", async (...args: unknown[]) => {
        if (args[1] === holdersPath) throw failure;
        return Reflect.apply(originalRename, fs, args);
      });
      syncBuiltinESMExports();
      return () => { mock.mock.restore(); syncBuiltinESMExports(); };
    };
    let restore = inject();
    try { await assert.rejects(() => coordinator.admit("failed-admit"), (error) => error === failure); }
    finally { restore(); }
    assert.deepEqual(coordinator.currentInflight(), []);
    assert.equal(await readFile(holdersPath, "utf8"), initial);
    const token = await coordinator.admit("root");
    const beforeRelease = await readFile(holdersPath, "utf8");
    restore = inject();
    try { await assert.rejects(() => coordinator.release(token), (error) => error === failure); }
    finally { restore(); }
    assert.equal(coordinator.currentInflight().length, 1);
    assert.equal(await readFile(holdersPath, "utf8"), beforeRelease);
    assert.equal((await coordinator.report({ complete: true })).quiescent, false);
    assert.equal((await readdir(directory)).some((name) => name.includes(".tmp-")), false);
    await coordinator.release(token);
    assert.equal((await coordinator.report({ complete: true })).quiescent, true);
  });

  it("uses group-writable files and setgid directories without changing existing directory permissions", async (t) => {
    const { directory, coordinator } = await fixture(t);
    assert.equal((await stat(directory)).mode & 0o7777, 0o2770);
    await coordinator.announceStartup();
    for (const file of ["gate.json", "holders.json", "services/studio.json"]) {
      assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o660);
    }
    assert.equal((await stat(path.join(directory, "services"))).mode & 0o7777, 0o2770);
    await chmod(directory, 0o2775);
    await coordinator.report();
    assert.equal((await stat(directory)).mode & 0o7777, 0o2775);
    await withMaintenanceLock(directory, async () => {
      assert.equal((await stat(path.join(directory, ".admission.lock"))).mode & 0o7777, 0o2770);
      await assert.rejects(() => withMaintenanceLock(directory, async () => undefined), /not reentrant/);
    });
  });

  it("uses inherited setgid permissions when the service forbids explicit setgid syscalls", async (t) => {
    const { directory, coordinator } = await fixture(t);
    const originalMkdir = fs.mkdir;
    const originalChmod = fs.chmod;
    const denied = () => Object.assign(new Error("RestrictSUIDSGID denied explicit setgid"), { code: "EPERM" });
    const mkdirMock = t.mock.method(fs, "mkdir", async (target: string, options: { mode?: number; recursive?: boolean }) => {
      if ((options?.mode ?? 0) & 0o2000) throw denied();
      let existed = true;
      try { await stat(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      const created = await originalMkdir(target, options);
      if (!existed && ((await stat(path.dirname(target))).mode & 0o2000)) {
        // 在非 Linux 测试机模拟内核继承；服务本身仍禁止显式设置该位。
        await originalChmod(target, 0o2770);
      }
      return created;
    });
    const chmodMock = t.mock.method(fs, "chmod", async (target: string, mode: number) => {
      if (mode & 0o2000) throw denied();
      await originalChmod(target, mode);
    });
    syncBuiltinESMExports();
    try {
      await coordinator.announceStartup();
      await coordinator.withAdmission("sandboxed-work", async () => undefined);
      const report = await coordinator.report({ complete: true });
      assert.equal(report.quiescent, true);
      assert.equal(report.globalCount, 0);
      assert.equal((await stat(path.join(directory, "services"))).mode & 0o7777, 0o2770);
      await withMaintenanceLock(directory, async () => {
        assert.equal((await stat(path.join(directory, ".admission.lock"))).mode & 0o7777, 0o2770);
      });
    } finally {
      mkdirMock.mock.restore(); chmodMock.mock.restore(); syncBuiltinESMExports();
    }
  });

  it("orders a contending process admission after a locked DRAINING transition", { timeout: 30_000 }, async (t) => {
    const { root, directory, coordinator } = await fixture(t);
    const closer = await childActor(t, root, directory, "drain-under-lock");
    assert.equal((await closer.next()).type, "locked");
    const admission = await childActor(t, root, directory, "admit");
    assert.equal((await admission.next()).type, "attempting");
    assert.equal((await readMaintenanceGate(directory)).state, "draining");
    signal(closer.child);
    assert.deepEqual(await closer.next(), { type: "while-locked", count: 0 });
    assert.deepEqual(admission.messages, []);
    signal(closer.child);
    assert.equal((await closer.next()).type, "unlocked");
    const denied = await admission.next();
    assert.equal(denied.type, "rejected");
    assert.equal(denied.name, "MaintenancePausedError");
    await closer.done(); await admission.done();
    assert.equal((await coordinator.report({ complete: true })).globalCount, 0);
  });

  it("counts a prior independent-process admission while drain closes and blocks freeze until release", { timeout: 30_000 }, async (t) => {
    const { root, directory, coordinator } = await fixture(t);
    const admission = await childActor(t, root, directory, "admit");
    assert.equal((await admission.next()).type, "attempting");
    const accepted = await admission.next();
    assert.equal(accepted.type, "admitted");
    const closer = await childActor(t, root, directory, "drain");
    assert.equal((await closer.next()).type, "attempting");
    assert.equal((await closer.next()).type, "drained");
    await closer.done();
    const report = await coordinator.report({ complete: true });
    assert.equal(report.globalCount, 1);
    assert.equal(report.ownCount, 0);
    assert.equal(report.holders[0]?.id, accepted.id);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-race"), /active holders/);
    signal(admission.child);
    assert.equal((await admission.next()).type, "released");
    await admission.done();
    await transitionMaintenanceGate(directory, "frozen", "deploy-race");
  });

  it("never reclaims a leftover lock on a timeout", { timeout: 15_000 }, async (t) => {
    const { directory, coordinator } = await fixture(t);
    const lock = path.join(directory, ".admission.lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "owner-evidence"), "preserve");
    await assert.rejects(() => coordinator.admit("blocked"), /lock is busy/);
    assert.equal(await readFile(path.join(lock, "owner-evidence"), "utf8"), "preserve");
    assert.equal(coordinator.currentInflight().length, 0);
  });
});
