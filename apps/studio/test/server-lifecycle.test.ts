import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
type ChildEvent = { event: string; address?: string; count?: number };

async function start(t: TestContext, mode = "idle") {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-lifecycle-"));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers/server-lifecycle-child.ts"), directory, mode], {
    cwd: repositoryRoot, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += String(bytes); });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const events: ChildEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { events.push(JSON.parse(line) as ChildEvent); });
  t.after(async () => {
    // 仅清理由本测试创建且未正常退出的子进程，防止失败用例残留监听器。
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    lines.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function event(name: string): Promise<ChildEvent> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = events.find((entry) => entry.event === name);
      if (value) return value;
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      assert.ok(Date.now() < deadline, `Missing event ${name}: ${stderr}`);
      await delay(10);
    }
  }
  const ready = await event("ready");
  return {
    directory, child, exited, events, event, address: ready.address!,
    allow: (name: string) => writeFile(path.join(directory, name), "ready\n"),
    async assertCleanExit() {
      assert.deepEqual(await exited, [0, null], stderr);
      const holders = JSON.parse(await readFile(path.join(directory, "maintenance/holders.json"), "utf8"));
      assert.deepEqual(holders.holders, []);
    },
  };
}

describe("Studio process lifecycle", { timeout: 20_000 }, () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`naturally exits an idle real Node server on ${signal}`, async (t) => {
      const h = await start(t);
      assert.equal((await fetch(`${h.address}/api/health`)).status, 200);
      h.child.kill(signal);
      await h.assertCleanExit();
    });
  }

  it("closes SSE and waits for background descendants and durable admission release across repeated signals", async (t) => {
    const h = await start(t);
    const response = await fetch(`${h.address}/api/runs/run-1/events`);
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    await reader.read();
    const accepted = await fetch(`${h.address}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(accepted.status, 200);
    await accepted.json();
    h.child.kill("SIGTERM");
    await h.event("closing");
    await h.event("unsubscribed");
    h.child.kill("SIGINT");
    await delay(80);
    assert.equal(h.child.exitCode, null, "pending unref work must keep the process alive");
    assert.equal(h.child.signalCode, null);
    assert.equal(h.events.filter((entry) => entry.event === "closing").length, 1);
    const holders = JSON.parse(await readFile(path.join(h.directory, "maintenance/holders.json"), "utf8"));
    assert.equal(holders.holders.length, 1);
    await h.allow("finish-work");
    await delay(80);
    assert.equal(h.child.exitCode, null, "a descendant admitted after shutdown must still finish");
    await h.allow("finish-descendant");
    await h.assertCleanExit();
    for (const name of ["work.done", "descendant.done"]) {
      assert.equal(await readFile(path.join(h.directory, name), "utf8"), "complete\n");
    }
    while (!(await reader.read()).done) { /* 等服务端结束 SSE。 */ }
  });

  it("waits for a disconnected request's pending admission and releases it without running its handler", async (t) => {
    const h = await start(t, "admission");
    const pending = request(`${h.address}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" } });
    pending.on("error", () => undefined);
    pending.end("{}");
    await h.event("admitting");
    pending.destroy();
    h.child.kill("SIGTERM");
    await delay(80);
    assert.equal(h.child.exitCode, null, "pending admission must not outlive the process");
    assert.equal(h.child.signalCode, null);
    await h.allow("finish-admission");
    await h.assertCleanExit();
    assert.equal(h.events.some((entry) => entry.event === "handler"), false);
  });

  it("stops scheduling recovery and waits for the admitted recovery write", async (t) => {
    const h = await start(t, "recovery");
    await h.event("recovery");
    h.child.kill("SIGTERM");
    await h.event("closing");
    const count = h.events.filter((entry) => entry.event === "recovery").length;
    await delay(100);
    assert.equal(h.events.filter((entry) => entry.event === "recovery").length, count);
    assert.equal(h.child.exitCode, null);
    await h.allow("finish-recovery");
    await h.assertCleanExit();
    assert.equal(await readFile(path.join(h.directory, "recovery.done"), "utf8"), "complete\n");
  });

  it("waits for service completion even when only an unref timer remains", async (t) => {
    const h = await start(t, "service");
    h.child.kill("SIGINT");
    await h.event("service-drain");
    await delay(80);
    assert.equal(h.child.exitCode, null);
    await h.allow("finish-service");
    await h.assertCleanExit();
    assert.equal(await readFile(path.join(h.directory, "service.done"), "utf8"), "complete\n");
  });
});
