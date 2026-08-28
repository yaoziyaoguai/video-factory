import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexBrokerServer } from "../src/broker-server.js";
import {
  CodexExecutor,
  CodexExecutorError,
  codexExecutorProfileFor,
  type CodexExecutionOptions,
  type CodexExecutionResult,
  type CodexExecutorProfile,
  type ValidatedTask,
} from "../src/codex-executor.js";

class ScriptedExecutor extends CodexExecutor {
  readonly calls: ValidatedTask[] = [];

  constructor(
    private readonly script: (task: ValidatedTask, options?: CodexExecutionOptions) => CodexExecutionResult | Promise<CodexExecutionResult>,
    profile?: CodexExecutorProfile,
  ) {
    super({ workspaceRoot: "/nonexistent-codex-broker", ...(profile !== undefined ? { profile } : {}) });
  }

  async runTask(task: ValidatedTask, options: CodexExecutionOptions = {}): Promise<CodexExecutionResult> {
    this.calls.push(task);
    return this.script(task, options);
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve; });
  }
}

interface BrokerHandle {
  socketPath: string;
  server: CodexBrokerServer;
  close(): Promise<void>;
}

interface BrokerSpec {
  script?: (task: ValidatedTask, options?: CodexExecutionOptions) => CodexExecutionResult | Promise<CodexExecutionResult>;
  concurrency?: number;
  maxBacklog?: number;
  maxBodyBytes?: number;
  shutdownTimeoutMs?: number;
  now?: () => Date;
  profile?: CodexExecutorProfile;
}

async function startBroker(spec: BrokerSpec = {}): Promise<BrokerHandle> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-broker-http-"));
  const socketPath = path.join(directory, "worker.sock");
  const server = new CodexBrokerServer({
    socketPath,
    executor: new ScriptedExecutor(
      spec.script ?? (() => ({ output: "{\"ideas\":[]}" })),
      spec.profile,
    ),
    ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
    ...(spec.maxBacklog !== undefined ? { maxBacklog: spec.maxBacklog } : {}),
    ...(spec.maxBodyBytes !== undefined ? { maxBodyBytes: spec.maxBodyBytes } : {}),
    ...(spec.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: spec.shutdownTimeoutMs } : {}),
    ...(spec.now !== undefined ? { now: spec.now } : {}),
  });
  await server.start();
  return {
    socketPath,
    server,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface BrokerResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function brokerRequest(
  socketPath: string,
  options: { method: string; path: string; body?: string; chunked?: boolean },
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: options.method,
      path: options.path,
      headers: options.body !== undefined && !options.chunked
        ? { "content-length": String(Buffer.byteLength(options.body)) }
        : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function abortableBrokerRequest(
  socketPath: string,
  options: { method: string; path: string; body: string },
): { abort(): void; response: Promise<BrokerResponse> } {
  let request!: http.ClientRequest;
  const response = new Promise<BrokerResponse>((resolve, reject) => {
    request = http.request({
      socketPath,
      method: options.method,
      path: options.path,
      headers: { "content-length": String(Buffer.byteLength(options.body)) },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
  return { abort: () => request.destroy(), response };
}

async function healthReport(socketPath: string): Promise<Record<string, unknown>> {
  const response = await brokerRequest(socketPath, { method: "GET", path: "/health" });
  assert.equal(response.status, 200);
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function topicTaskBody(label: string): string {
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "topic-ideas",
    payload: {
      signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: `热点 ${label}` }],
    },
  });
}

function scriptTaskBody(label: string): string {
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "script-draft",
    payload: {
      brief: {
        title: `脚本 ${label}`,
        angle: "验证生产任务优先级",
        audience: "短视频创作者",
        nicheSlug: "qa",
        platform: "douyin",
        durationSeconds: 24,
      },
    },
  });
}

function visualReviewTaskBody(): string {
  const jpeg = Buffer.alloc(512 * 1024);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  const sha256 = createHash("sha256").update(jpeg).digest("hex");
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "visual-review",
    payload: {
      durationMs: 1_000,
      frames: [0, 1_000].map((timecodeMs) => ({
        timecodeMs,
        sha256,
        jpegBase64: jpeg.toString("base64"),
      })),
    },
  });
}

async function readFileText(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

describe("CodexBrokerServer routes", () => {
  it("serves health without touching the executor and rejects unknown routes and methods", async () => {
    const broker = await startBroker({
      now: () => new Date("2026-08-26T08:00:00.000Z"),
      script: () => {
        throw new Error("health must never run a task");
      },
    });
    try {
      const report = await healthReport(broker.socketPath);
      assert.equal(report.protocolVersion, "video-factory/codex-bridge-v2");
      assert.equal(report.profileId, "openai");
      assert.equal(report.providerId, "openai");
      assert.equal(report.modelId, "codex-default");
      assert.deepEqual(report.taskKinds, ["topic-ideas", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review"]);
      assert.equal(report.active, 0);
      assert.equal(report.queued, 0);
      assert.equal(report.capacity, 1);
      assert.equal(report.completed, 0);
      assert.equal(report.failed, 0);
      assert.equal(report.startedAt, "2026-08-26T08:00:00.000Z");

      const notFound = await brokerRequest(broker.socketPath, { method: "GET", path: "/nope" });
      assert.equal(notFound.status, 404);
      const wrongMethodHealth = await brokerRequest(broker.socketPath, { method: "DELETE", path: "/health" });
      assert.equal(wrongMethodHealth.status, 405);
      const wrongMethodTasks = await brokerRequest(broker.socketPath, { method: "GET", path: "/v1/tasks" });
      assert.equal(wrongMethodTasks.status, 405);
    } finally {
      await broker.close();
    }
  });

  it("reports the ZAI identity and rejects tasks outside that profile before execution", async () => {
    let executed = false;
    const broker = await startBroker({
      profile: codexExecutorProfileFor("zai"),
      script: () => {
        executed = true;
        return { output: "{}" };
      },
    });
    try {
      const report = await healthReport(broker.socketPath);
      assert.equal(report.profileId, "zai");
      assert.equal(report.providerId, "zai-bigmodel-api");
      assert.equal(report.modelId, "glm-5.3-flash");
      assert.deepEqual(report.taskKinds, ["visual-review"]);

      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBody("wrong-profile"),
      });
      assert.equal(response.status, 400);
      assert.match(JSON.parse(response.body).error, /not allowed for broker profile 'zai'/);
      assert.equal(executed, false);
    } finally {
      await broker.close();
    }
  });
});

describe("CodexBrokerServer POST /v1/tasks", () => {
  it("accepts bounded visual-review requests on both OpenAI and ZAI profiles", async () => {
    const zai = await startBroker({
      profile: codexExecutorProfileFor("zai"),
      script: (task) => {
        assert.equal(task.kind, "visual-review");
        return { output: "{}" };
      },
    });
    const openai = await startBroker({
      script: (task) => {
        assert.equal(task.kind, "visual-review");
        return { output: "{}" };
      },
    });
    const body = visualReviewTaskBody();
    try {
      const accepted = await brokerRequest(zai.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body,
      });
      assert.equal(accepted.status, 200);

      const openaiAccepted = await brokerRequest(openai.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body,
      });
      assert.equal(openaiAccepted.status, 200);
    } finally {
      await zai.close();
      await openai.close();
    }
  });

  it("returns the executor output and maps malformed requests and oversized bodies", async () => {
    const broker = await startBroker();
    const small = await startBroker({ maxBodyBytes: 32 });
    try {
      const ok = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("ok") });
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.body), { ok: true, output: "{\"ideas\":[]}" });
      assert.equal((await healthReport(broker.socketPath)).completed, 1);

      const badJson = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: "not json" });
      assert.equal(badJson.status, 400);
      assert.match(JSON.parse(badJson.body).error, /not valid JSON/);

      const badProtocol = JSON.parse(topicTaskBody("protocol")) as Record<string, unknown>;
      badProtocol.protocolVersion = "video-factory/legacy";
      const rejectedProtocol = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: JSON.stringify(badProtocol),
      });
      assert.equal(rejectedProtocol.status, 400);
      assert.match(JSON.parse(rejectedProtocol.body).error, /protocol version/);

      const forbidden = JSON.parse(topicTaskBody("forbidden")) as { payload: Record<string, unknown> };
      forbidden.payload.command = "rm -rf /";
      const rejectedKey = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: JSON.stringify(forbidden),
      });
      assert.equal(rejectedKey.status, 400);
      assert.match(JSON.parse(rejectedKey.body).error, /not allowed/);

      const declaredTooBig = await brokerRequest(small.socketPath, {
        method: "POST", path: "/v1/tasks", body: "x".repeat(64),
      });
      assert.equal(declaredTooBig.status, 413);
      const streamedTooBig = await brokerRequest(small.socketPath, {
        method: "POST", path: "/v1/tasks", body: "y".repeat(64), chunked: true,
      });
      assert.equal(streamedTooBig.status, 413);
    } finally {
      await broker.close();
      await small.close();
    }
  });

  it("maps transient, terminal, and unknown failures without echoing payload content", async () => {
    let call = 0;
    const broker = await startBroker({
      script: () => {
        call += 1;
        if (call === 1) throw new CodexExecutorError("codex timed out after 1ms.", true);
        if (call === 2) throw new CodexExecutorError("Codex output is not valid JSON.", false);
        throw new Error("unexpected executor crash");
      },
    });
    try {
      const transient = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("SECRET-PAYLOAD-MARKER"),
      });
      assert.equal(transient.status, 422);
      assert.equal(transient.headers["retry-after"], undefined);
      assert.match(JSON.parse(transient.body).error, /transiently/);
      assert.doesNotMatch(transient.body, /SECRET-PAYLOAD-MARKER/);

      const terminal = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("terminal"),
      });
      assert.equal(terminal.status, 422);
      assert.equal(terminal.headers["retry-after"], undefined);
      assert.match(JSON.parse(terminal.body).error, /not valid JSON/);

      const unknown = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("unknown"),
      });
      assert.equal(unknown.status, 500);
      assert.match(JSON.parse(unknown.body).error, /failed to run the task/);
      assert.doesNotMatch(unknown.body, /SECRET-PAYLOAD-MARKER/);

      const report = await healthReport(broker.socketPath);
      assert.equal(report.failed, 3);
      assert.equal(report.completed, 0);
    } finally {
      await broker.close();
    }
  });
});

describe("CodexBrokerServer queue", () => {
  it("enforces concurrency and backlog with FIFO release and accurate counters", async () => {
    const gates: Array<Deferred<void>> = [];
    const order: string[] = [];
    const broker = await startBroker({
      concurrency: 1,
      maxBacklog: 1,
      script: (task) => {
        assert.equal(task.kind, "topic-ideas");
        const title = (task.payload.signals[0] as { title: string }).title;
        order.push(`start:${title}`);
        const gate = new Deferred<void>();
        gates.push(gate);
        return gate.promise.then(() => {
          order.push(`end:${title}`);
          return { output: "{\"done\":true}" };
        });
      },
    });
    try {
      const first = brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("A") });
      await waitFor(() => gates.length === 1);
      const second = brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("B") });
      await waitFor(async () => (await healthReport(broker.socketPath)).queued === 1);
      const third = brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("C") });

      const busy = await third;
      assert.equal(busy.status, 503);
      assert.equal(busy.headers["retry-after"], "5");
      assert.match(JSON.parse(busy.body).error, /backlog is full/);

      const midReport = await healthReport(broker.socketPath);
      assert.equal(midReport.active, 1);
      assert.equal(midReport.queued, 1);
      assert.equal(midReport.capacity, 1);

      gates[0]!.resolve();
      await waitFor(() => gates.length === 2);
      assert.deepEqual(order, ["start:热点 A", "end:热点 A", "start:热点 B"]);
      const firstDone = await first;
      assert.equal(firstDone.status, 200);

      gates[1]!.resolve();
      const secondDone = await second;
      assert.equal(secondDone.status, 200);

      const finalReport = await healthReport(broker.socketPath);
      assert.equal(finalReport.active, 0);
      assert.equal(finalReport.queued, 0);
      assert.equal(finalReport.completed, 2);
      assert.equal(finalReport.failed, 0);
    } finally {
      for (const gate of gates) gate.resolve();
      await broker.close();
    }
  });

  it("runs queued production work before background topic analysis", async () => {
    const gates: Array<Deferred<void>> = [];
    const order: string[] = [];
    const broker = await startBroker({
      concurrency: 1,
      maxBacklog: 4,
      script: (task) => {
        order.push(task.kind);
        const gate = new Deferred<void>();
        gates.push(gate);
        return gate.promise.then(() => ({ output: "{\"done\":true}" }));
      },
    });
    try {
      const activeBackground = brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("active"),
      });
      await waitFor(() => gates.length === 1);
      const queuedBackground = brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("queued"),
      });
      const queuedProduction = brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: scriptTaskBody("priority"),
      });
      await waitFor(async () => (await healthReport(broker.socketPath)).queued === 2);

      gates[0]!.resolve();
      await waitFor(() => gates.length === 2);
      assert.deepEqual(order, ["topic-ideas", "script-draft"]);

      gates[1]!.resolve();
      await waitFor(() => gates.length === 3);
      gates[2]!.resolve();
      assert.equal((await activeBackground).status, 200);
      assert.equal((await queuedProduction).status, 200);
      assert.equal((await queuedBackground).status, 200);
    } finally {
      for (const gate of gates) gate.resolve();
      await broker.close();
    }
  });

  it("removes a queued task when its client disconnects before execution", async () => {
    const gate = new Deferred<void>();
    const calls: string[] = [];
    const broker = await startBroker({
      concurrency: 1,
      maxBacklog: 4,
      script: (task) => {
        calls.push(task.kind);
        return gate.promise.then(() => ({ output: "{\"done\":true}" }));
      },
    });
    try {
      const active = brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("active"),
      });
      await waitFor(() => calls.length === 1);
      const abandoned = abortableBrokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: scriptTaskBody("abandoned"),
      });
      await waitFor(async () => (await healthReport(broker.socketPath)).queued === 1);

      abandoned.abort();
      await assert.rejects(abandoned.response);
      await waitFor(async () => (await healthReport(broker.socketPath)).queued === 0);
      gate.resolve();
      assert.equal((await active).status, 200);
      assert.deepEqual(calls, ["topic-ideas"]);
    } finally {
      gate.resolve();
      await broker.close();
    }
  });

  it("cancels active work when its client disconnects and releases capacity", async () => {
    let aborted = false;
    let calls = 0;
    const broker = await startBroker({
      concurrency: 1,
      script: (_task, options) => {
        calls += 1;
        if (calls > 1) return { output: "{\"done\":true}" };
        return new Promise<CodexExecutionResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new CodexExecutorError("cancelled", true));
          }, { once: true });
        });
      },
    });
    try {
      const abandoned = abortableBrokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("active-abandoned"),
      });
      await waitFor(async () => (await healthReport(broker.socketPath)).active === 1);
      abandoned.abort();
      await assert.rejects(abandoned.response);
      await waitFor(async () => aborted && (await healthReport(broker.socketPath)).active === 0);

      const next = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: scriptTaskBody("after-cancel"),
      });
      assert.equal(next.status, 200);
      assert.equal(calls, 2);
    } finally {
      await broker.close();
    }
  });
});

describe("CodexBrokerServer lifecycle", () => {
  it("closes idempotently, rejects queued tasks, and lets active tasks finish", async () => {
    const gates: Array<Deferred<void>> = [];
    const broker = await startBroker({
      concurrency: 1,
      maxBacklog: 5,
      script: () => {
        const gate = new Deferred<void>();
        gates.push(gate);
        return gate.promise.then(() => ({ output: "{\"late\":true}" }));
      },
    });
    try {
      const active = brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("active") });
      await waitFor(() => gates.length === 1);
      const queued = brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: topicTaskBody("queued") });
      await waitFor(async () => (await healthReport(broker.socketPath)).queued === 1);

      // close 停止 listen 后新连接可能直接 ECONNREFUSED，因此不再对"迟到的 HTTP 请求"做断言。
      const closing = broker.server.close();
      gates[0]!.resolve();

      const activeDone = await active;
      assert.equal(activeDone.status, 200);
      assert.deepEqual(JSON.parse(activeDone.body), { ok: true, output: "{\"late\":true}" });
      const queuedDone = await queued;
      assert.equal(queuedDone.status, 503);
      assert.match(JSON.parse(queuedDone.body).error, /shutting down/);
      await closing;
      await broker.server.close();
    } finally {
      for (const gate of gates) gate.resolve();
      await broker.close();
    }
  });

  it("refuses to touch a non-socket file and cannot be preempted while another broker listens", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-broker-file-"));
    const filePath = path.join(directory, "worker.sock");
    await writeFile(filePath, "plain file", "utf8");
    const naive = new CodexBrokerServer({
      socketPath: filePath,
      executor: new ScriptedExecutor(() => ({ output: "{}" })),
    });
    try {
      await assert.rejects(() => naive.start(), /not a Unix socket/);
      await naive.close();
      assert.equal(await readFileText(filePath), "plain file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const broker = await startBroker();
    try {
      const competitor = new CodexBrokerServer({
        socketPath: broker.socketPath,
        executor: new ScriptedExecutor(() => ({ output: "{}" })),
      });
      await assert.rejects(() => competitor.start(), /already listening/);
      await competitor.close();
      const report = await healthReport(broker.socketPath);
      assert.equal(report.protocolVersion, "video-factory/codex-bridge-v2");
    } finally {
      await broker.close();
    }
  });

  it("close before start does not throw", async () => {
    const server = new CodexBrokerServer({
      socketPath: "/nonexistent/video-factory-codex/worker.sock",
      executor: new ScriptedExecutor(() => ({ output: "{}" })),
    });
    await server.close();
    await server.close();
  });
});
