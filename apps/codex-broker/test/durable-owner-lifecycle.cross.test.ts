import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBrokerServer } from "../src/broker-server.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";

const childFixture = fileURLToPath(new URL("./fixtures/durable-owner-child.ts", import.meta.url));
const contract = taskContractDescriptorFor("topic-ideas");

describe("durable broker owner and shutdown lifecycle", () => {
  it("G02 rejects a second process that targets the same durable store", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-owner-process-"));
    const records = path.join(directory, "records");
    const firstSocket = path.join(directory, "first.sock");
    const secondSocket = path.join(directory, "second.sock");
    const first = spawn(process.execPath, ["--import", "tsx", childFixture, firstSocket, records, "hold"]);
    t.after(async () => {
      await stopChild(first);
      await rm(directory, { recursive: true, force: true });
    });

    const ready = await childReady(first);
    const lockBefore = await readFile(path.join(records, ".owner.lock"), "utf8");
    const storeIdBefore = (await readFile(path.join(records, ".store-id"), "utf8")).trim();
    const competitor = await execChild(secondSocket, records, "probe");

    assert.equal(competitor.code, 23, competitor.stderr);
    assert.match(competitor.stderr, /active or unverifiable owner/);
    assert.equal(await readFile(path.join(records, ".owner.lock"), "utf8"), lockBefore);
    assert.equal((await readFile(path.join(records, ".store-id"), "utf8")).trim(), storeIdBefore);
    await assert.rejects(() => access(secondSocket), (error: unknown) => hasCode(error, "ENOENT"));
    const health = await request(firstSocket, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).storeId, storeIdBefore);
    assert.equal(ready.storeId, storeIdBefore);
  });

  it("G02 reclaims a parseable owner lock only after its PID is confirmed dead", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-owner-stale-"));
    const records = path.join(directory, "records");
    const socketPath = path.join(directory, "worker.sock");
    await mkdir(records, { recursive: true });
    await writeFile(path.join(records, ".owner.lock"), `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: "11111111-2222-3333-4444-555555555555",
    })}\n`, "utf8");
    try {
      const result = await execChild(socketPath, records, "probe");
      assert.equal(result.code, 0, result.stderr);
      await assert.rejects(() => access(path.join(records, ".owner.lock")), (error: unknown) => hasCode(error, "ENOENT"));
      assert.match((await readFile(path.join(records, ".store-id"), "utf8")).trim(), /^vfs_store_[a-f0-9]{32}$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("G04 waits for active completion persistence before releasing the store", async () => {
    const fixture = await startControlledBroker(1_000);
    try {
      const body = await durableBody(fixture.socketPath, "graceful-active");
      const accepted = await request(fixture.socketPath, "POST", "/v1/tasks", body);
      assert.equal(accepted.status, 202);
      await waitFor(() => fixture.calls.length === 1);
      const closing = fixture.server.close();
      fixture.gates[0]!.resolve();
      await closing;

      const record = JSON.parse(await readFile(recordPath(fixture.records, "graceful-active"), "utf8"));
      assert.equal(record.state, "completed");
      assert.deepEqual(record.outcome.ok, true);

      const replay = await startControlledBroker(1_000, fixture.directory, fixture.records, "replacement.sock");
      try {
        const response = await request(replay.socketPath, "POST", "/v1/tasks", body);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).state, "completed_success");
        assert.equal(replay.calls.length, 0);
      } finally {
        await replay.server.close();
      }
    } finally {
      for (const gate of fixture.gates) gate.resolve();
      await fixture.server.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("G04 keeps the owner fence after a shutdown deadline until old work settles", async () => {
    const fixture = await startControlledBroker(20);
    try {
      const body = await durableBody(fixture.socketPath, "deadline-active");
      assert.equal((await request(fixture.socketPath, "POST", "/v1/tasks", body)).status, 202);
      await waitFor(() => fixture.calls.length === 1);
      await fixture.server.close();
      const accepted = JSON.parse(await readFile(recordPath(fixture.records, "deadline-active"), "utf8"));
      assert.equal(accepted.state, "accepted");

      const competitor = new CodexBrokerServer({
        socketPath: path.join(fixture.directory, "too-early.sock"),
        idempotencyDirectory: fixture.records,
        executor: controlledExecutor([], []),
      });
      await assert.rejects(() => competitor.start(), /active or unverifiable owner/);
      await competitor.close();

      fixture.gates[0]!.resolve();
      await waitFor(async () => {
        try {
          await access(path.join(fixture.records, ".owner.lock"));
          return false;
        } catch (error) {
          return hasCode(error, "ENOENT");
        }
      });
      const completed = JSON.parse(await readFile(recordPath(fixture.records, "deadline-active"), "utf8"));
      assert.equal(completed.state, "completed");
    } finally {
      for (const gate of fixture.gates) gate.resolve();
      await fixture.server.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("G04 persists a queued shutdown rejection as terminal not_accepted", async () => {
    const fixture = await startControlledBroker(1_000);
    try {
      const activeBody = await durableBody(fixture.socketPath, "shutdown-active");
      const queuedBody = await durableBody(fixture.socketPath, "shutdown-queued");
      assert.equal((await request(fixture.socketPath, "POST", "/v1/tasks", activeBody)).status, 202);
      assert.equal((await request(fixture.socketPath, "POST", "/v1/tasks", queuedBody)).status, 202);
      await waitFor(() => fixture.calls.length === 1);
      const closing = fixture.server.close();
      fixture.gates[0]!.resolve();
      await closing;
      assert.equal(fixture.calls.length, 1);
      const queuedRecord = JSON.parse(await readFile(recordPath(fixture.records, "shutdown-queued"), "utf8"));
      assert.equal(queuedRecord.state, "not_accepted");
      assert.equal(queuedRecord.outcome.status, 503);

      const replay = await startControlledBroker(1_000, fixture.directory, fixture.records, "queued-replay.sock");
      try {
        const response = await request(replay.socketPath, "POST", "/v1/tasks", queuedBody);
        assert.equal(response.status, queuedRecord.outcome.status);
        assert.equal(JSON.parse(response.body).state, "not_accepted");
        assert.equal(JSON.parse(response.body).error, queuedRecord.outcome.message);
        assert.equal(replay.calls.length, 0);
      } finally {
        await replay.server.close();
      }
    } finally {
      for (const gate of fixture.gates) gate.resolve();
      await fixture.server.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;
  constructor() { this.promise = new Promise<void>((resolve) => { this.resolve = resolve; }); }
}

function controlledExecutor(calls: unknown[], gates: Deferred[]) {
  return {
    identity: { profileId: "fixture", providerId: "openai", modelId: "gpt-5.4", taskKinds: ["topic-ideas"] },
    async runTask(task: { kind: "topic-ideas"; expectedContractDigest?: string }) {
      calls.push(task);
      const gate = new Deferred();
      gates.push(gate);
      await gate.promise;
      return {
        output: "{\"ideas\":[]}",
        trace: {
          taskKind: task.kind,
          promptVersion: contract.promptVersion,
          contractDigest: task.expectedContractDigest,
          prompt: "shutdown fixture",
          providerId: "openai",
          modelId: "gpt-5.4",
        },
      };
    },
  } as never;
}

async function startControlledBroker(
  shutdownTimeoutMs: number,
  directory?: string,
  records?: string,
  socketName = "worker.sock",
) {
  const root = directory ?? await mkdtemp(path.join(tmpdir(), "vf-owner-lifecycle-"));
  const recordDirectory = records ?? path.join(root, "records");
  const socketPath = path.join(root, socketName);
  const calls: unknown[] = [];
  const gates: Deferred[] = [];
  const server = new CodexBrokerServer({
    socketPath,
    idempotencyDirectory: recordDirectory,
    executor: controlledExecutor(calls, gates),
    concurrency: 1,
    maxBacklog: 4,
    shutdownTimeoutMs,
  });
  await server.start();
  return { directory: root, records: recordDirectory, socketPath, server, calls, gates };
}

async function durableBody(socketPath: string, requestId: string): Promise<string> {
  const health = JSON.parse((await request(socketPath, "GET", "/health")).body);
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId,
    kind: "topic-ideas",
    payload: { signals: [] },
    expectedContractDigest: contract.digest,
    brokerBinding: {
      version: health.taskBindingVersion,
      storeId: health.storeId,
      providerId: health.providerId,
      modelId: health.modelId,
    },
  });
}

function request(socketPath: string, method: string, requestPath: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function childReady(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n")[0];
      if (line) resolve(JSON.parse(line));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => reject(new Error(`owner child exited ${String(code)}: ${stderr}`)));
  });
}

function execChild(socketPath: string, records: string, mode: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", childFixture, socketPath, records, mode], { timeout: 5_000 }, (error, _stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stderr });
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function recordPath(directory: string, requestId: string): string {
  return path.join(directory, `${createHash("sha256").update(requestId).digest("hex")}.json`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
