import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexBrokerServer } from "../src/broker-server.js";
import {
  CodexExecutor,
  CodexExecutorError,
  codexExecutorProfileFor,
  modelIdForTask,
  parseTaskRequest,
  type CodexExecutionOptions,
  type CodexExecutionResult,
  type CodexExecutorProfile,
  type ValidatedTask,
} from "../src/codex-executor.js";
import { BROKER_TASK_KINDS, taskContractDescriptorFor } from "../src/task-definitions.js";
import { TASK_BINDING_VERSION } from "../src/task-binding.js";

class ScriptedExecutor extends CodexExecutor {
  readonly calls: ValidatedTask[] = [];

  constructor(
    private readonly script: (task: ValidatedTask, options?: CodexExecutionOptions) => CodexExecutionResult | Promise<CodexExecutionResult>,
    profile?: CodexExecutorProfile,
    candidates?: readonly string[],
  ) {
    super({
      workspaceRoot: "/nonexistent-codex-broker",
      ...(profile !== undefined ? { profile } : {}),
      ...(candidates !== undefined ? { modelCandidates: candidates } : {}),
    });
  }

  async runTask(task: ValidatedTask, options: CodexExecutionOptions = {}): Promise<CodexExecutionResult> {
    this.calls.push(task);
    const result = await this.script(task, options);
    // 合同保护任务（含 topic-ideas）要求 trace 证明同一合同；与真实 CodexExecutor 一致。
    if (task.expectedContractDigest && result.trace?.contractDigest === undefined) {
      return {
        ...result,
        trace: {
          taskKind: task.kind,
          promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
          contractDigest: task.expectedContractDigest,
          prompt: "test",
          providerId: this.identity.providerId,
          // 与真实执行器同源：覆盖优先，否则回落身份。用身份默认值会让"按请求换模型"看起来
          // 像是执行器返回了别的绑定。
          modelId: options.model ?? modelIdForTask(this.identity, task),
          ...result.trace,
        },
      };
    }
    return result;
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
  directory: string;
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
  modelCandidates?: readonly string[];
  durableIdempotency?: boolean;
  durableSessions?: boolean;
}

async function startBroker(spec: BrokerSpec = {}): Promise<BrokerHandle> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-broker-http-"));
  const socketPath = path.join(directory, "worker.sock");
  const server = new CodexBrokerServer({
    socketPath,
    executor: new ScriptedExecutor(
      spec.script ?? (() => ({ output: "{\"ideas\":[]}" })),
      spec.profile,
      spec.modelCandidates,
    ),
    ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
    ...(spec.maxBacklog !== undefined ? { maxBacklog: spec.maxBacklog } : {}),
    ...(spec.maxBodyBytes !== undefined ? { maxBodyBytes: spec.maxBodyBytes } : {}),
    ...(spec.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: spec.shutdownTimeoutMs } : {}),
    ...(spec.now !== undefined ? { now: spec.now } : {}),
    ...(spec.durableIdempotency ? { idempotencyDirectory: path.join(directory, "idempotency") } : {}),
    ...(spec.durableSessions ? { sessionDirectory: path.join(directory, "sessions") } : {}),
  });
  await server.start();
  return {
    directory,
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
  options: { method: string; path: string; body?: string; chunked?: boolean; headers?: Record<string, string> },
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: options.method,
      path: options.path,
      headers: {
        ...options.headers,
        ...(options.body !== undefined && !options.chunked
          ? { "content-length": String(Buffer.byteLength(options.body)) }
          : {}),
      },
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

// durable 模式（accept/poll）：POST 返回 202 后轮询 GET 原任务直到终态。
async function postTaskAwaitOutcome(
  socketPath: string,
  body: string,
): Promise<BrokerResponse> {
  const first = await brokerRequest(socketPath, { method: "POST", path: "/v1/tasks", body });
  if (first.status !== 202) return first;
  const requestId = (JSON.parse(first.body) as { requestId: string }).requestId;
  const binding = (JSON.parse(first.body) as { binding: Record<string, unknown> }).binding;
  for (;;) {
    const poll = await brokerRequest(socketPath, {
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(requestId)}`,
      headers: queryHeaders(binding),
    });
    if (poll.status === 200) {
      const state = JSON.parse(poll.body) as {
        accepted?: boolean;
        state?: string;
        ok?: boolean;
        outcome?: { status: number; message: string; failureKind?: string; failureDetails?: unknown; outcomeUncertain?: boolean };
      };
      if (state.accepted === true) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (state.state === "completed_failure" && state.ok !== true) {
        // 完成失败以 200 信封交付：还原为原始错误状态供既有断言使用。
        return {
          status: state.outcome?.status ?? 500,
          headers: poll.headers,
          body: JSON.stringify({
            error: state.outcome?.message ?? "Codex task failed.",
            ...(state.outcome?.failureKind ? { failureKind: state.outcome.failureKind } : {}),
            ...(state.outcome?.failureDetails ? { failureDetails: state.outcome.failureDetails } : {}),
            ...(state.outcome?.outcomeUncertain ? { outcomeUncertain: true } : {}),
          }),
        };
      }
    }
    return poll;
  }
}

function queryHeaders(binding: Record<string, unknown>): Record<string, string> {
  return {
    "x-video-factory-binding-version": String(binding.version),
    "x-video-factory-store-id": String(binding.storeId),
    "x-video-factory-provider-id": String(binding.providerId),
    "x-video-factory-model-id": String(binding.modelId),
    "x-video-factory-request-digest": String(binding.requestDigest),
    "x-video-factory-task-kind": String(binding.kind),
    "x-video-factory-contract-digest": binding.contractDigest === null ? "none" : String(binding.contractDigest),
    "x-video-factory-session-digest": String(binding.sessionDigest),
  };
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
    requestId: `topic-${label.replace(/[^A-Za-z0-9._:-]/g, "-")}`,
    kind: "topic-ideas",
    payload: {
      signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: `热点 ${label}` }],
    },
    // topic-ideas 现在是合同保护任务：真实客户端（REQUIRED_CODEX_TASK_CONTRACT_DIGESTS）总是携带摘要。
    expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
  });
}

function scriptTaskBody(label: string): string {
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: `script-${label.replace(/[^A-Za-z0-9._:-]/g, "-")}`,
    kind: "script-draft",
    expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
    payload: {
      brief: {
        title: `脚本 ${label}`,
        angle: "验证生产任务优先级",
        audience: "短视频创作者",
        nicheSlug: "qa",
        platform: "douyin",
        durationSeconds: 24,
        productionCapabilities: {
          assetProviders: [],
          editing: { sourceRangeReuse: true, staticEditorialCard: false },
          audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
        },
      },
    },
  });
}

function visualReviewTaskBody(): string {
  const jpeg = Buffer.alloc(256 * 1024);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  const sha256 = createHash("sha256").update(jpeg).digest("hex");
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: "visual-review-fixture",
    kind: "visual-review",
    expectedContractDigest: taskContractDescriptorFor("visual-review").digest,
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

// 请求通过信封里的 brokerBinding.modelId 声明它要用哪个模型；这里按真实客户端的形状构造，
// 即先读 /health 拿身份，再把身份里的 modelId 换成自己选的那个。
function topicTaskBodyWithModel(label: string, identity: Record<string, unknown>, modelId: string): string {
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: `topic-${label.replace(/[^A-Za-z0-9._:-]/g, "-")}`,
    kind: "topic-ideas",
    payload: {
      signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: `热点 ${label}` }],
    },
    expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
    brokerBinding: {
      version: TASK_BINDING_VERSION,
      storeId: identity.storeId,
      providerId: identity.providerId,
      modelId,
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
      assert.deepEqual(report.taskKinds, BROKER_TASK_KINDS);
      assert.deepEqual(report.taskContracts, Object.fromEntries(
        BROKER_TASK_KINDS.map((kind) => [kind, taskContractDescriptorFor(kind).digest]),
      ));
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

  it("reports the DeepSeek text identity and accepts text tasks through the same isolated profile", async () => {
    let executed = false;
    const broker = await startBroker({
      profile: codexExecutorProfileFor("deepseek"),
      script: () => {
        executed = true;
        return { output: "{}" };
      },
    });
    try {
      const report = await healthReport(broker.socketPath);
      assert.equal(report.profileId, "deepseek");
      assert.equal(report.providerId, "deepseek");
      assert.equal(report.modelId, "deepseek-flash");
      assert.deepEqual(report.taskKinds, BROKER_TASK_KINDS);

      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: scriptTaskBody("deepseek-script"),
      });
      assert.equal(response.status, 200);
      assert.equal(executed, true);
    } finally {
      await broker.close();
    }
  });
});

describe("CodexBrokerServer POST /v1/tasks", () => {
  it("coalesces and durably replays an accepted request without rerunning the model", async () => {
    let calls = 0;
    const release = new Deferred<void>();
    const broker = await startBroker({
      durableIdempotency: true,
      script: async () => {
        calls += 1;
        await release.promise;
        return { output: "{\"ideas\":[]}" };
      },
    });
    try {
      const body = topicTaskBody("durable");
      const first = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body });
      const second = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body });
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      await waitFor(() => calls === 1);
      release.resolve();
      const replayOutcome = await postTaskAwaitOutcome(broker.socketPath, body);
      assert.equal(replayOutcome.status, 200);
      assert.equal(JSON.parse(replayOutcome.body).ok, true);
      assert.equal(calls, 1);

      const changed = JSON.parse(body) as { payload: { signals: Array<{ title: string }> } };
      changed.payload.signals[0]!.title = "不同任务";
      assert.equal((await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(changed),
      })).status, 409);
      assert.equal(calls, 1);
    } finally {
      await broker.close();
    }
  });

  it("keeps an uncertain accepted task durable and never replays the same request id", async () => {
    let calls = 0;
    const broker = await startBroker({
      durableIdempotency: true,
      script: () => {
        calls += 1;
        throw new CodexExecutorError("provider response stream ended after acceptance", false, {
          outcomeUncertain: true,
          failureKind: "model_provider_transient",
          details: {
            category: "network",
            reasonCode: "response_stream_interrupted",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
          },
        });
      },
    });
    try {
      const body = topicTaskBody("accepted-uncertain");
      const requestId = String((JSON.parse(body) as { requestId: string }).requestId);

      const first = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body });

      assert.equal(first.status, 202);
      const firstEnvelope = JSON.parse(first.body) as { accepted: boolean; binding: Record<string, unknown> };
      assert.equal(firstEnvelope.accepted, true);
      const durableRecordPath = path.join(
        broker.directory,
        "idempotency",
        `${createHash("sha256").update(requestId).digest("hex")}.json`,
      );
      await waitFor(async () => {
        if (calls !== 1) return false;
        try {
          const persisted = JSON.parse(await readFile(durableRecordPath, "utf8")) as { uncertainty?: unknown };
          return persisted.uncertainty !== undefined;
        } catch {
          return false;
        }
      });
      const record = JSON.parse(await readFile(durableRecordPath, "utf8")) as { version: number; state: string };
      assert.equal(record.version, 3);
      assert.equal(record.state, "accepted");

      const query = await brokerRequest(broker.socketPath, {
        method: "GET", path: `/v1/tasks/${encodeURIComponent(requestId)}`,
        headers: queryHeaders(firstEnvelope.binding),
      });
      assert.equal(query.status, 200);
      assert.equal(JSON.parse(query.body).state, "accepted_unknown");
      assert.ok(Number.isFinite(Date.parse(JSON.parse(query.body).localExecutionEndedAt)));
      assert.equal(JSON.parse(query.body).failureDetails.reasonCode, "response_stream_interrupted");

      const replay = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body });
      assert.equal(replay.status, 202);
      assert.equal(calls, 1);
    } finally {
      await broker.close();
    }
  });

  it("keeps real Codex thread ids host-side and rejects cross-role session reuse", async () => {
    const threadId = "019c0000-0000-7000-8000-000000000001";
    const receivedSessionIds: Array<string | undefined> = [];
    const broker = await startBroker({
      durableSessions: true,
      script: (_task, options) => {
        receivedSessionIds.push(options?.sessionId);
        return { output: "{\"ideas\":[]}", sessionId: options?.sessionId ?? threadId };
      },
    });
    try {
      const firstBody = JSON.parse(topicTaskBody("session-first")) as Record<string, unknown>;
      firstBody.sessionKey = "run-1:topic-editor:produce";
      const first = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(firstBody),
      });
      assert.equal(first.status, 200);
      const firstEnvelope = JSON.parse(first.body) as { sessionHandle?: string; sessionId?: string };
      assert.match(firstEnvelope.sessionHandle ?? "", /^vfs_/);
      assert.equal(firstEnvelope.sessionId, undefined);

      const secondBody = { ...firstBody,
        requestId: "topic-session-second",
        sessionHandle: firstEnvelope.sessionHandle,
      };
      const second = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(secondBody),
      });
      assert.equal(second.status, 200);
      assert.deepEqual(receivedSessionIds, [undefined, threadId]);

      const crossed = { ...secondBody, requestId: "topic-session-crossed", sessionKey: "run-2:other-role:audit" };
      const rejected = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(crossed),
      });
      assert.equal(rejected.status, 409);
      assert.equal(receivedSessionIds.length, 2);
    } finally {
      await broker.close();
    }
  });

  it("rebuilds a missing session registry entry from the atomic completed task record", async () => {
    const threadId = "019c0000-0000-7000-8000-000000000021";
    const handle = `vfs_${"r".repeat(32)}`;
    let calls = 0;
    const broker = await startBroker({
      durableIdempotency: true,
      durableSessions: true,
      script: (_task, options) => {
        calls += 1;
        assert.equal(options?.sessionId, threadId);
        return { output: "{\"ideas\":[]}", sessionId: threadId };
      },
    });
    try {
      const body = JSON.parse(topicTaskBody("atomic-session-recovery")) as Record<string, unknown>;
      body.sessionKey = "run-atomic:topic-editor:produce";
      const task = parseTaskRequest(body, codexExecutorProfileFor("openai").identity);
      const digest = createHash("sha256").update(JSON.stringify({
        identity: codexExecutorProfileFor("openai").identity,
        task,
        session: { key: body.sessionKey },
      })).digest("hex");
      const idempotencyDirectory = path.join(broker.directory, "idempotency");
      await mkdir(idempotencyDirectory, { recursive: true });
      await writeFile(
        path.join(idempotencyDirectory, `${createHash("sha256").update(String(body.requestId)).digest("hex")}.json`),
        `${JSON.stringify({
          version: 2,
          requestId: body.requestId,
          digest,
          state: "completed",
          outcome: {
            ok: true,
            output: "{\"ideas\":[]}",
            sessionHandle: handle,
            trace: {
              taskKind: "topic-ideas",
              promptVersion: taskContractDescriptorFor("topic-ideas").promptVersion,
              contractDigest: taskContractDescriptorFor("topic-ideas").digest,
              prompt: "legacy fixture",
              providerId: "openai",
              modelId: "codex-default",
            },
          },
          sessionRecord: {
            version: 1,
            handle,
            key: body.sessionKey,
            taskKind: "topic-ideas",
            threadId,
          },
        })}\n`,
        "utf8",
      );

      const recovered = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(body),
      });
      assert.equal(recovered.status, 200);
      assert.equal(JSON.parse(recovered.body).sessionHandle, handle);
      assert.equal(calls, 0);

      const resumed = await postTaskAwaitOutcome(broker.socketPath, JSON.stringify({ ...body, requestId: "atomic-session-resume", sessionHandle: handle }));
      assert.equal(resumed.status, 200);
      assert.equal(calls, 1);
    } finally {
      await broker.close();
    }
  });

  it("serializes different requests that resume the same role session", async () => {
    const threadId = "019c0000-0000-7000-8000-000000000031";
    const releaseFirst = new Deferred<void>();
    let resumeCalls = 0;
    const broker = await startBroker({
      durableSessions: true,
      concurrency: 2,
      script: async (_task, options) => {
        if (options?.sessionId) {
          resumeCalls += 1;
          if (resumeCalls === 1) await releaseFirst.promise;
        }
        return { output: "{\"ideas\":[]}", sessionId: options?.sessionId ?? threadId };
      },
    });
    try {
      const firstBody = JSON.parse(topicTaskBody("session-lock-create")) as Record<string, unknown>;
      firstBody.sessionKey = "run-lock:topic-editor:produce";
      const created = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: JSON.stringify(firstBody) });
      const handle = JSON.parse(created.body).sessionHandle as string;
      const firstResume = brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify({ ...firstBody, requestId: "session-lock-a", sessionHandle: handle }),
      });
      await waitFor(() => resumeCalls === 1);
      const secondResume = brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify({ ...firstBody, requestId: "session-lock-b", sessionHandle: handle }),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(resumeCalls, 1);
      releaseFirst.resolve();
      assert.equal((await firstResume).status, 200);
      assert.equal((await secondResume).status, 200);
      assert.equal(resumeCalls, 2);
    } finally {
      releaseFirst.resolve();
      await broker.close();
    }
  });

  it("rejects a resumed command that reports a different Codex thread", async () => {
    const firstThread = "019c0000-0000-7000-8000-000000000041";
    const wrongThread = "019c0000-0000-7000-8000-000000000042";
    const broker = await startBroker({
      durableSessions: true,
      script: (_task, options) => ({
        output: "{\"ideas\":[]}",
        sessionId: options?.sessionId ? wrongThread : firstThread,
      }),
    });
    try {
      const body = JSON.parse(topicTaskBody("session-rebind-create")) as Record<string, unknown>;
      body.sessionKey = "run-rebind:topic-editor:produce";
      const created = await brokerRequest(broker.socketPath, { method: "POST", path: "/v1/tasks", body: JSON.stringify(body) });
      const handle = JSON.parse(created.body).sessionHandle as string;
      const rejected = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify({ ...body, requestId: "session-rebind-resume", sessionHandle: handle }),
      });
      assert.equal(rejected.status, 422);
      assert.match(JSON.parse(rejected.body).error, /different role session/);
    } finally {
      await broker.close();
    }
  });

  it("fails closed instead of silently replaying a pre-session result without role continuity", async () => {
    let calls = 0;
    const broker = await startBroker({
      durableIdempotency: true,
      durableSessions: true,
      script: () => {
        calls += 1;
        return { output: "{\"ideas\":[]}" };
      },
    });
    try {
      const body = JSON.parse(topicTaskBody("legacy-session-replay")) as Record<string, unknown>;
      body.sessionKey = "legacy-run:topic-editor:produce";
      const task = parseTaskRequest(body, codexExecutorProfileFor("openai").identity);
      const digest = createHash("sha256").update(JSON.stringify({
        identity: codexExecutorProfileFor("openai").identity,
        task,
      })).digest("hex");
      const idempotencyDirectory = path.join(broker.directory, "idempotency");
      await mkdir(idempotencyDirectory, { recursive: true });
      await writeFile(
        path.join(idempotencyDirectory, `${createHash("sha256").update(String(body.requestId)).digest("hex")}.json`),
        `${JSON.stringify({
          version: 1,
          requestId: body.requestId,
          digest,
          state: "completed",
          outcome: { ok: true, output: "{\"ideas\":[]}" },
        })}\n`,
        "utf8",
      );

      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 409);
      assert.equal(calls, 0);
    } finally {
      await broker.close();
    }
  });

  it("fails closed when a requested role session cannot be persisted", async () => {
    const missingRegistry = await startBroker({
      script: () => ({ output: "{\"ideas\":[]}", sessionId: "019c0000-0000-7000-8000-000000000001" }),
    });
    const missingThread = await startBroker({ durableSessions: true });
    const invalidThread = await startBroker({
      durableSessions: true,
      script: () => ({ output: "{\"ideas\":[]}", sessionId: "not-a-codex-thread" }),
    });
    const request = (label: string): string => {
      const body = JSON.parse(topicTaskBody(label)) as Record<string, unknown>;
      body.sessionKey = `run-1:${label}:produce`;
      return JSON.stringify(body);
    };
    try {
      const noRegistry = await brokerRequest(missingRegistry.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: request("missing-registry"),
      });
      assert.equal(noRegistry.status, 409);

      const noThread = await brokerRequest(missingThread.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: request("missing-thread"),
      });
      assert.equal(noThread.status, 422);

      const badThread = await brokerRequest(invalidThread.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: request("invalid-thread"),
      });
      assert.equal(badThread.status, 422);
    } finally {
      await missingRegistry.close();
      await missingThread.close();
      await invalidThread.close();
    }
  });

  it("accepts bounded visual-review requests on both OpenAI and DeepSeek profiles", async () => {
    const deepseek = await startBroker({
      profile: codexExecutorProfileFor("deepseek"),
      script: (task) => {
        assert.equal(task.kind, "visual-review");
        return {
          output: "{}",
          trace: {
            taskKind: task.kind,
            promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
            contractDigest: task.expectedContractDigest!,
            prompt: "test",
            providerId: "deepseek",
            modelId: "deepseek-flash",
          },
        };
      },
    });
    const openai = await startBroker({
      script: (task) => {
        assert.equal(task.kind, "visual-review");
        return {
          output: "{}",
          trace: {
            taskKind: task.kind,
            promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
            contractDigest: task.expectedContractDigest!,
            prompt: "test",
            providerId: "openai",
            modelId: "codex-default",
          },
        };
      },
    });
    const body = visualReviewTaskBody();
    try {
      const accepted = await brokerRequest(deepseek.socketPath, {
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
      await deepseek.close();
      await openai.close();
    }
  });

  it("rejects executor results whose trace does not match the accepted task binding", async () => {
    const cases = [
      { name: "provider", trace: { providerId: "deepseek" }, reasonCode: "binding_mismatch" },
      { name: "model", trace: { modelId: "other-model" }, reasonCode: "binding_mismatch" },
      { name: "kind", trace: { taskKind: "script-draft" as const }, reasonCode: "binding_mismatch" },
      { name: "digest", trace: { contractDigest: "0".repeat(64) }, reasonCode: "contract_mismatch" },
    ];
    for (const testCase of cases) {
      let calls = 0;
      const broker = await startBroker({
        script: (task) => {
          calls += 1;
          return {
            output: "{\"ideas\":[]}",
            trace: {
              taskKind: task.kind,
              promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
              contractDigest: task.expectedContractDigest!,
              prompt: "test",
              providerId: "openai",
              modelId: "codex-default",
              ...testCase.trace,
            },
          };
        },
      });
      try {
        const response = await brokerRequest(broker.socketPath, {
          method: "POST",
          path: "/v1/tasks",
          body: topicTaskBody(`wrong-trace-${testCase.name}`),
        });
        assert.equal(response.status, 422);
        assert.equal(JSON.parse(response.body).failureDetails.reasonCode, testCase.reasonCode);
        assert.equal(calls, 1);
      } finally {
        await broker.close();
      }
    }
  });

  it("returns the executor output and maps malformed requests and oversized bodies", async () => {
    const broker = await startBroker();
    const small = await startBroker({ maxBodyBytes: 32 });
    try {
      const ok = await postTaskAwaitOutcome(broker.socketPath, topicTaskBody("ok"));
      assert.equal(ok.status, 200);
      const okEnvelope = JSON.parse(ok.body) as { ok: boolean; output: string };
      assert.equal(okEnvelope.ok, true);
      assert.equal(okEnvelope.output, "{\"ideas\":[]}");
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
      assert.match(JSON.parse(rejectedProtocol.body).error, /broker input contract/);

      const forbidden = JSON.parse(topicTaskBody("forbidden")) as { payload: Record<string, unknown> };
      forbidden.payload.command = "sk-test-secret /Users/private/project";
      const rejectedKey = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: JSON.stringify(forbidden),
      });
      assert.equal(rejectedKey.status, 400);
      assert.match(JSON.parse(rejectedKey.body).error, /broker input contract/);
      const rejectedKeyBody = JSON.parse(rejectedKey.body) as {
        error: string;
        failureDetails: Record<string, unknown>;
      };
      assert.equal(rejectedKeyBody.failureDetails.fieldPath, "payload.command");
      assert.equal(rejectedKeyBody.failureDetails.reasonCode, "input_contract");
      assert.equal(rejectedKeyBody.failureDetails.taskKind, "topic-ideas");
      assert.equal(rejectedKeyBody.failureDetails.accepted, false);
      assert.match(String(rejectedKeyBody.failureDetails.requestIdHash), /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(rejectedKeyBody), /sk-test-secret|\/Users\/private/);
      assert.equal((await healthReport(broker.socketPath)).completed, 1, "rejected input must not reach the executor");

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
        if (call === 3) {
          throw new CodexExecutorError(
            "Authorization: Bearer eyJhbGciOi-secret OPENAI_API_KEY=plain-secret",
            false,
            {
              details: {
                category: "invalid_request",
                reasonCode: "1308",
                requestIdHash: "a".repeat(64),
                providerId: "deepseek",
                modelId: "deepseek-flash",
                providerWaitMs: 37,
              },
            },
          );
        }
        throw new Error("unexpected executor crash");
      },
    });
    try {
      const transient = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("SECRET-PAYLOAD-MARKER"),
      });
      assert.equal(transient.status, 422);
      assert.equal(transient.headers["retry-after"], undefined);
      assert.match(JSON.parse(transient.body).error, /timed out/i);
      assert.doesNotMatch(transient.body, /Agent|Codex bridge|host-only broker|socket/i);
      assert.equal(JSON.parse(transient.body).failureKind, "model_provider_transient");
      assert.doesNotMatch(transient.body, /SECRET-PAYLOAD-MARKER/);

      const terminal = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("terminal"),
      });
      assert.equal(terminal.status, 422);
      assert.equal(terminal.headers["retry-after"], undefined);
      assert.match(JSON.parse(terminal.body).error, /invalid JSON/);
      assert.equal(JSON.parse(terminal.body).failureKind, undefined);

      const credentialDiagnostic = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("credential-diagnostic"),
      });
      assert.equal(credentialDiagnostic.status, 422);
      assert.doesNotMatch(credentialDiagnostic.body, /Bearer|eyJhbGci|OPENAI_API_KEY|plain-secret/);
      assert.equal(JSON.parse(credentialDiagnostic.body).error, "The model could not complete this step.");
      const failureDetails = JSON.parse(credentialDiagnostic.body).failureDetails as Record<string, unknown>;
      assert.equal(typeof failureDetails.queueWaitMs, "number");
      delete failureDetails.queueWaitMs;
      assert.deepEqual(failureDetails, {
        category: "invalid_request",
        reasonCode: "1308",
        requestIdHash: "a".repeat(64),
        providerId: "deepseek",
        modelId: "deepseek-flash",
        providerWaitMs: 37,
      });
      assert.doesNotMatch(credentialDiagnostic.body, /Agent|Codex bridge|host-only broker|socket/i);

      const unknown = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("unknown"),
      });
      assert.equal(unknown.status, 500);
      assert.equal(JSON.parse(unknown.body).error, "The model service could not complete this step.");
      assert.equal(JSON.parse(unknown.body).failureKind, undefined);
      assert.doesNotMatch(unknown.body, /SECRET-PAYLOAD-MARKER/);

      const report = await healthReport(broker.socketPath);
      assert.equal(report.failed, 4);
      assert.equal(report.completed, 0);
    } finally {
      await broker.close();
    }
  });

  it("preserves a transient provider outage without exposing the CLI diagnostic", async () => {
    const broker = await startBroker({
      script: () => {
        throw new CodexExecutorError(
          "Codex exited with code 1. HTTP 429 Too Many Requests OPENAI_API_KEY=host-secret",
          true,
        );
      },
    });
    try {
      const response = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: topicTaskBody("provider-outage"),
      });

      assert.equal(response.status, 422);
      assert.match(JSON.parse(response.body).error, /temporarily unavailable/i);
      assert.doesNotMatch(response.body, /429|Too Many Requests|OPENAI_API_KEY|host-secret/);
    } finally {
      await broker.close();
    }
  });

  it("durably preserves and replays a completed no-output failure for downstream candidate fallback", async () => {
    let calls = 0;
    const broker = await startBroker({
      durableIdempotency: true,
      script: () => {
        calls += 1;
        throw new CodexExecutorError(
          "Codex produced an empty output.",
          false,
          { failureKind: "model_provider_no_output" },
        );
      },
    });
    try {
      const body = topicTaskBody("no-output");
      const requestId = String((JSON.parse(body) as { requestId: string }).requestId);
      const response = await postTaskAwaitOutcome(broker.socketPath, body);

      assert.equal(response.status, 422);
      assert.equal(JSON.parse(response.body).error, "the model returned an empty result.");
      assert.equal(JSON.parse(response.body).failureKind, "model_provider_no_output");
      const record = JSON.parse(await readFile(path.join(
        broker.directory,
        "idempotency",
        `${createHash("sha256").update(requestId).digest("hex")}.json`,
      ), "utf8")) as { version: number; state: string; outcome: Record<string, unknown> };
      assert.equal(record.version, 3);
      assert.equal(record.state, "completed");
      assert.equal(record.outcome.ok, false);
      assert.equal(record.outcome.status, 422);
      assert.equal(record.outcome.failureKind, "model_provider_no_output");

      const replayed = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body,
      });
      assert.equal(replayed.status, 200);
      assert.equal(JSON.parse(replayed.body).state, "completed_failure");
      assert.equal(JSON.parse(replayed.body).outcome.failureKind, "model_provider_no_output");
      assert.equal(calls, 1);
    } finally {
      await broker.close();
    }
  });

  it("keeps an unverifiable legacy completed failure immutable and requires a new requestId for recovery", async () => {
    let calls = 0;
    const broker = await startBroker({
      durableIdempotency: true,
      script: () => {
        calls += 1;
        throw new CodexExecutorError(
          "Codex produced an empty output.",
          false,
          { failureKind: "model_provider_no_output" },
        );
      },
    });
    try {
      const oldBody = JSON.parse(topicTaskBody("legacy-no-output")) as Record<string, unknown>;
      const task = parseTaskRequest(oldBody, codexExecutorProfileFor("openai").identity);
      const digest = createHash("sha256").update(JSON.stringify({
        identity: codexExecutorProfileFor("openai").identity,
        task,
      })).digest("hex");
      const recordPath = path.join(
        broker.directory,
        "idempotency",
        `${createHash("sha256").update(String(oldBody.requestId)).digest("hex")}.json`,
      );
      const legacyRecord = `${JSON.stringify({
        version: 1,
        requestId: oldBody.requestId,
        digest,
        state: "completed",
        outcome: { ok: false, status: 422, message: "The model could not complete this step." },
      }, null, 2)}\n`;
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, legacyRecord, "utf8");

      const replayed = await brokerRequest(broker.socketPath, {
        method: "POST", path: "/v1/tasks", body: JSON.stringify(oldBody),
      });
      assert.equal(replayed.status, 409);
      assert.equal(JSON.parse(replayed.body).failureKind, "binding_conflict");
      assert.equal(calls, 0);
      assert.equal(await readFile(recordPath, "utf8"), legacyRecord);

      const recovered = await postTaskAwaitOutcome(broker.socketPath, JSON.stringify({ ...oldBody, requestId: "recovered-no-output" }));
      assert.equal(recovered.status, 422);
      assert.equal(JSON.parse(recovered.body).failureKind, "model_provider_no_output");
      assert.equal(calls, 1);
      assert.equal(await readFile(recordPath, "utf8"), legacyRecord);
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
      script: (task) => {
        assert.equal(task.kind, "topic-ideas");
        const title = (task.payload.signals[0] as { title: string }).title;
        order.push(`start:${title}`);
        const gate = new Deferred<void>();
        gates.push(gate);
        return gate.promise.then(() => {
          order.push(`end:${title}`);
          return {
            output: "{\"done\":true}",
            trace: {
              taskKind: task.kind,
              promptVersion: "queue-test-v1",
              prompt: "queue test",
              providerId: "openai",
              modelId: "codex-default",
            },
          };
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
      const secondTrace = JSON.parse(secondDone.body).trace as { queueWaitMs?: number };
      assert.equal(typeof secondTrace.queueWaitMs, "number");
      assert.ok(secondTrace.queueWaitMs! >= 0);

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
      const activeEnvelope = JSON.parse(activeDone.body) as { ok: boolean; output: string };
      assert.equal(activeEnvelope.ok, true);
      assert.equal(activeEnvelope.output, "{\"late\":true}");
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

describe("CodexBrokerServer reviewed model overrides", () => {
  const REVIEWED = ["gpt-5.6-sol", "gpt-6-astra"];

  it("announces the reviewed candidate table only when one is configured", async () => {
    const withoutTable = await startBroker({ script: () => ({ output: "{}" }) });
    const withTable = await startBroker({ modelCandidates: REVIEWED, script: () => ({ output: "{}" }) });
    try {
      // 未配置候选表的健康响应必须逐字段不变：既有部署不该因为这个能力而被改动。
      assert.equal("modelCandidates" in await healthReport(withoutTable.socketPath), false);
      assert.deepEqual((await healthReport(withTable.socketPath)).modelCandidates, REVIEWED);
    } finally {
      await withoutTable.close();
      await withTable.close();
    }
  });

  it("runs a reviewed candidate model and echoes it in the result binding", async () => {
    const broker = await startBroker({ modelCandidates: REVIEWED, script: () => ({ output: "{\"ideas\":[]}" }) });
    try {
      const identity = await healthReport(broker.socketPath);
      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBodyWithModel("override-ok", identity, "gpt-6-astra"),
      });

      assert.equal(response.status, 200);
      const envelope = JSON.parse(response.body) as { ok: boolean; trace: { modelId: string } };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.trace.modelId, "gpt-6-astra");
    } finally {
      await broker.close();
    }
  });

  it("rejects an unreviewed model before acceptance and never runs the task", async () => {
    let calls = 0;
    const broker = await startBroker({
      modelCandidates: REVIEWED,
      script: () => {
        calls += 1;
        return { output: "{\"ideas\":[]}" };
      },
    });
    try {
      const identity = await healthReport(broker.socketPath);
      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBodyWithModel("override-bad", identity, "gpt-9-unreviewed"),
      });

      // 400 而不是受理后的 422：客户端必须能用修正后的模型重试同一个 requestId。
      assert.equal(response.status, 400);
      assert.equal((JSON.parse(response.body) as { failureKind: string }).failureKind, "contract_rejected");
      assert.equal(calls, 0);
    } finally {
      await broker.close();
    }
  });

  it("rejects every model override when the broker has no candidate table", async () => {
    const broker = await startBroker({
      // 安全默认：没有候选表就等于没有可覆盖的模型，包括看起来"合理"的模型名。
      script: () => ({ output: "{\"ideas\":[]}" }),
    });
    try {
      const identity = await healthReport(broker.socketPath);
      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBodyWithModel("override-closed", identity, "gpt-6-astra"),
      });

      assert.equal(response.status, 400);
      assert.equal((JSON.parse(response.body) as { failureKind: string }).failureKind, "contract_rejected");
    } finally {
      await broker.close();
    }
  });

  it("keeps accepting a request that declares the broker default model", async () => {
    const broker = await startBroker({ modelCandidates: REVIEWED, script: () => ({ output: "{\"ideas\":[]}" }) });
    try {
      const identity = await healthReport(broker.socketPath);
      const response = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBodyWithModel("override-default", identity, "codex-default"),
      });

      assert.equal(response.status, 200);
      assert.equal((JSON.parse(response.body) as { trace: { modelId: string } }).trace.modelId, "codex-default");
    } finally {
      await broker.close();
    }
  });

  it("pins the chosen model into the durable binding so a replay cannot silently switch it", async () => {
    const broker = await startBroker({
      durableIdempotency: true,
      modelCandidates: REVIEWED,
      script: () => ({ output: "{\"ideas\":[]}" }),
    });
    try {
      const identity = await healthReport(broker.socketPath);
      const astra = await postTaskAwaitOutcome(
        broker.socketPath,
        topicTaskBodyWithModel("durable-model", identity, "gpt-6-astra"),
      );
      assert.equal(astra.status, 200);
      assert.equal(JSON.parse(astra.body).ok, true);

      // 同一 requestId 换个已审核模型重放＝另一个执行，必须冲突而不是复用旧结果。
      const switched = await brokerRequest(broker.socketPath, {
        method: "POST",
        path: "/v1/tasks",
        body: topicTaskBodyWithModel("durable-model", identity, "gpt-5.6-sol"),
      });
      assert.equal(switched.status, 409);
      assert.equal((JSON.parse(switched.body) as { failureKind: string }).failureKind, "binding_conflict");
    } finally {
      await broker.close();
    }
  });
});
