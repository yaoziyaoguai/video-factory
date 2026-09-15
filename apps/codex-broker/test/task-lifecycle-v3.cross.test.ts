import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CodexBridgeClient,
  CodexBridgeError,
  type CodexPreparedOperation,
} from "../../../packages/production-pipeline/src/codex-chat.js";
import { CodexAssetSemanticRanker } from "../../../packages/production-pipeline/src/asset-semantic-ranker.js";
import { runRoleAgentLoop, RoleAgentLoopError } from "../../../packages/production-pipeline/src/role-agent-loop.js";
import { isModelProviderFailure } from "../../../packages/production-pipeline/src/model-fallback.js";
import { formatTopicStrategy } from "../../studio/src/server/topic-ideas-payload.js";
import { CodexBrokerServer } from "../src/broker-server.js";
import { CodexExecutorError } from "../src/codex-executor.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";

const contract = taskContractDescriptorFor("topic-ideas");
const payload = { signals: [{ id: "signal-1", platform: "test", rank: 1, title: "恢复合同" }] };
const threadId = "11111111-2222-3333-4444-555555555555";

describe("durable task lifecycle v3", () => {
  for (const legacyPending of [false, true]) it(`preserves queue rejection and later retry without session rebuild (legacy pending=${legacyPending})`, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await setup(t, async () => { await gate; return success(); }, 1, 1);
    const active = await request(fixture.socketPath, "POST", "/v1/tasks", await fixture.body("holding-queue"));
    await waitFor(() => fixture.calls.length === 1);
    const queued = await request(fixture.socketPath, "POST", "/v1/tasks", await fixture.body("queued-holder"));
    await delay(20);
    let stored: unknown;
    const requestIds: string[] = [];
    let firstPrepared: CodexPreparedOperation | undefined;
    const execute = () => runRoleAgentLoop({
      role: "选题", contractVersion: "queue-retry-v1", criteria: ["真实来源"], maxIterations: 1, deferAudit: true,
      checkpoint: { key: "queue-retry", load: async () => stored, save: async (value) => { stored = structuredClone(value); } },
      produce: async (_revision, operation) => {
        requestIds.push(operation.requestId);
        return operation.preparedOperation
          ? fixture.client.observePrepared(operation.preparedOperation)
          : fixture.client.runTaskDetailed("topic-ideas", payload, operation.requestId, operation.session, {
            ...operation.requestOptions,
            beforeSubmit: async (prepared) => {
              firstPrepared ??= structuredClone(prepared);
              await operation.requestOptions.beforeSubmit?.(prepared);
            },
          });
      },
      audit: async () => { throw new Error("not expected"); },
      validate: (value) => value,
    });
    try {
      await assert.rejects(execute, (error: unknown) => {
        assert.ok(error instanceof RoleAgentLoopError);
        assert.equal(error.agentLoop.modelCallCount, 0);
        assert.ok(error.sourceError instanceof CodexBridgeError);
        assert.equal(error.sourceError.stage, "not_accepted");
        assert.equal(error.sourceError.statusCode, 503);
        assert.match(error.sourceError.message, /backlog/);
        return true;
      });
      assert.equal(requestIds.length, 1);
    } finally { release(); }
    await fixture.complete(active);
    await fixture.complete(queued);
    if (legacyPending) {
      const checkpoint = stored as Record<string, unknown>;
      checkpoint.operationGenerations = {};
      checkpoint.pendingOperation = {
        phase: "produce", iteration: 1, operationKey: "0:1:produce", generation: 0,
        operation: firstPrepared,
      };
    }
    const result = await execute();
    assert.deepEqual(result.output, { ideas: [] });
    assert.equal(requestIds.length, legacyPending ? 3 : 2);
    assert.notEqual(requestIds[0], requestIds.at(-1));
    assert.equal(fixture.calls.length, 3, "only holders and later successful role reached executor");
    const rejected = JSON.parse(await readFile(recordPath(fixture.records, requestIds[0]!), "utf8"));
    assert.equal(rejected.state, "not_accepted");
    const replay = await request(fixture.socketPath, "POST", "/v1/tasks", JSON.stringify(firstPrepared!.envelope));
    assert.equal(replay.status, 503, "same rejected identity must replay the original queue rejection");
    assert.match(replay.body, /backlog/);
    assert.equal(fixture.calls.length, 3);
  });
  it("stops observing a locally ended unknown request and preserves its diagnosis and immutable identity", async (t) => {
    const fixture = await setup(t, async () => { throw new CodexExecutorError("unsafe upstream text", false, {
      outcomeUncertain: true,
      details: { category: "network", reasonCode: "connection_failed", providerId: "openai", modelId: "gpt-5.6-sol",
        localExecutionEnded: true, remoteQueryable: false, headersReceived: true, networkCode: "ECONNRESET" },
    }); });
    const start = Date.now();
    let prepared: CodexPreparedOperation | undefined;
    const check = (error: unknown) => {
      assert.ok(error instanceof CodexBridgeError);
      assert.equal(error.stage, "uncertain");
      assert.equal(error.transient, false);
      assert.equal(error.failureDetails?.networkCode, "ECONNRESET");
      assert.match(error.creatorMessage, /停止自动等待/);
      return true;
    };
    await assert.rejects(() => fixture.client.runTaskDetailed("topic-ideas", payload, "ended-unknown", undefined,
      { timeoutMs: 10_000, beforeSubmit: async (operation) => { prepared = operation; } }), check);
    assert.ok(Date.now() - start < 5_000, "must not wait the whole task deadline after local execution ended");
    await assert.rejects(() => fixture.client.observePrepared(prepared!, { timeoutMs: 10_000 }), check);
    const record = JSON.parse(await readFile(recordPath(fixture.records, "ended-unknown"), "utf8"));
    assert.equal(record.state, "accepted");
    assert.equal(record.outcome, undefined);
    assert.equal(record.uncertainty.failureDetails.remoteQueryable, false);
    assert.equal(fixture.calls.length, 1);
  });
  it("A01/A07 preserves output, trace, and session and rematerializes a missing registry", async (t) => {
    const fixture = await setup(t);
    let prepared: CodexPreparedOperation | undefined;
    const result = await fixture.client.runTaskDetailed("topic-ideas", payload, "session-result", {
      key: "topic-producer",
    }, { beforeSubmit: async (operation) => { prepared = operation; } });
    assert.equal(result.session?.handle?.startsWith("vfs_"), true);
    assert.equal(result.trace?.contractDigest, contract.digest);
    const record = JSON.parse(await readFile(recordPath(fixture.records, "session-result"), "utf8")) as {
      sessionRecord: { handle: string };
    };
    const sessionPath = recordPath(fixture.sessions, record.sessionRecord.handle);
    await rm(sessionPath);
    const recovered = await fixture.client.observePrepared(prepared!, { timeoutMs: 2_000 });
    assert.deepEqual(recovered.output, { ideas: [] });
    await access(sessionPath);
    assert.equal(fixture.calls.length, 1);
  });

  it("A02 serializes identical acceptance and rejects a different binding", async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await setup(t, async () => { await gate; return success(); }, 16);
    const body = await fixture.body("same-id");
    const accepted = await Promise.all(Array.from({ length: 12 }, () => request(fixture.socketPath, "POST", "/v1/tasks", body)));
    assert.equal(accepted.every((response) => response.status === 202), true);
    await waitFor(() => fixture.calls.length === 1);
    const changed = JSON.parse(body) as Record<string, unknown>;
    changed.payload = { signals: [] };
    const conflict = await request(fixture.socketPath, "POST", "/v1/tasks", JSON.stringify(changed));
    assert.equal(conflict.status, 409);
    release();
    await fixture.complete(accepted[0]!);
    assert.equal(fixture.calls.length, 1);
  });

  it("A03 requires the complete immutable query binding", async (t) => {
    const fixture = await setup(t);
    const accepted = await request(fixture.socketPath, "POST", "/v1/tasks", await fixture.body("query-binding"));
    await fixture.complete(accepted);
    const missing = await request(fixture.socketPath, "GET", "/v1/tasks/query-binding");
    assert.equal(missing.status, 400);
    const wrongHeaders = bindingHeaders(JSON.parse(accepted.body).binding);
    wrongHeaders["x-video-factory-provider-id"] = "another-provider";
    const wrong = await request(fixture.socketPath, "GET", "/v1/tasks/query-binding", undefined, wrongHeaders);
    assert.equal(wrong.status, 409);
  });

  it("A04 projects orphan legacy acceptance as unknown without execution", async (t) => {
    const fixture = await setup(t);
    await mkdir(fixture.records, { recursive: true });
    await writeFile(recordPath(fixture.records, "legacy-orphan"), JSON.stringify({
      version: 1,
      requestId: "legacy-orphan",
      digest: "a".repeat(64),
      state: "accepted",
    }));
    const prepared = await fixture.client.prepareTask("topic-ideas", payload, "legacy-orphan");
    await assert.rejects(() => fixture.client.observePrepared(prepared, { timeoutMs: 50 }),
      (error: unknown) => error instanceof CodexBridgeError && error.stage === "uncertain");
    assert.equal(fixture.calls.length, 0);
  });

  it("A05 keeps accepted fact when observation transport is unavailable", async (t) => {
    const fixture = await setup(t);
    const proxySocket = path.join(fixture.directory, "observation-down.sock");
    let postCount = 0;
    const proxy = http.createServer(async (incoming, response) => {
      if (incoming.url === "/health") return forward(incoming, response, fixture.socketPath);
      if (incoming.method === "POST") {
        postCount += 1;
        return forward(incoming, response, fixture.socketPath);
      }
      incoming.socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(proxySocket, resolve));
    t.after(() => new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
    const client = new CodexBridgeClient({ socketPath: proxySocket, timeoutMs: 80, pollIntervalMs: 10, maxAttempts: 1 });
    await assert.rejects(() => client.runTaskDetailed("topic-ideas", payload, "observe-down"),
      (error: unknown) => error instanceof CodexBridgeError && error.stage === "uncertain");
    assert.equal(postCount, 1);
    assert.equal(fixture.calls.length, 1);
  });

  it("A06 preserves a verified terminal failure", async (t) => {
    const fixture = await setup(t, async () => { throw new Error("terminal fixture"); });
    await assert.rejects(() => fixture.client.runTaskDetailed("topic-ideas", payload, "terminal-failure"),
      (error: unknown) => error instanceof CodexBridgeError && error.stage === "completed_failure" && error.statusCode === 500);
    assert.equal(fixture.calls.length, 1);
  });

  it("A08 blocks rejected and conflict failures from provider fallback", () => {
    for (const stage of ["rejected", "conflict"] as const) {
      const error = new CodexBridgeError("fixture", false, stage, stage === "rejected" ? 400 : 409,
        undefined, { category: "network", reasonCode: "fixture", providerId: "openai", modelId: "fixture" });
      assert.equal(isModelProviderFailure(error), false);
    }
  });

  it("A09 preserves every valid topic preference section", () => {
    const strategy = formatTopicStrategy({
      positioning: "摄影视觉入门".repeat(60),
      targetAudience: "第一次买相机的新手".repeat(50),
      preferredDirections: "真实拍摄比较\n".repeat(80),
      excludedDirections: "拒绝参数堆砌\n".repeat(80),
      sourcePolicy: "primary_or_two_independent",
      customInstruction: "保留创作者语气".repeat(200),
    });
    for (const marker of ["内容定位", "核心受众", "优先题材", "明确避开", "来源工作流", "补充原则"]) assert.equal(strategy.includes(marker), true);
    assert.ok(strategy.length <= 6_000);
  });

  it("A10 reconciles a lost POST response with one physical execution", async (t) => {
    const fixture = await setup(t);
    const proxySocket = path.join(fixture.directory, "drop-post.sock");
    let posts = 0;
    let queries = 0;
    const proxy = http.createServer(async (incoming, response) => {
      if (incoming.url === "/health") return forward(incoming, response, fixture.socketPath);
      if (incoming.method === "POST") {
        posts += 1;
        await forward(incoming, undefined, fixture.socketPath);
        response.destroy();
        return;
      }
      queries += 1;
      return forward(incoming, response, fixture.socketPath);
    });
    await new Promise<void>((resolve) => proxy.listen(proxySocket, resolve));
    t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const client = new CodexBridgeClient({ socketPath: proxySocket, timeoutMs: 2_000, pollIntervalMs: 10, maxAttempts: 1 });
    const result = await client.runTaskDetailed("topic-ideas", payload, "lost-post-response");
    assert.deepEqual(result.output, { ideas: [] });
    assert.equal(posts, 1);
    assert.ok(queries > 0);
    assert.equal(fixture.calls.length, 1);
  });

  it("A11 rejects a completed envelope whose request identity was replaced", async (t) => {
    const fixture = await setup(t);
    const proxySocket = path.join(fixture.directory, "wrong-response.sock");
    const proxy = http.createServer(async (incoming, response) => {
      const forwarded = await forward(incoming, undefined, fixture.socketPath);
      const body = JSON.parse(forwarded.body) as Record<string, unknown>;
      if (body.state === "completed_success") body.requestId = "another-request";
      send(response, forwarded.status, body);
    });
    await new Promise<void>((resolve) => proxy.listen(proxySocket, resolve));
    t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const client = new CodexBridgeClient({ socketPath: proxySocket, timeoutMs: 2_000, pollIntervalMs: 10, maxAttempts: 1 });
    await assert.rejects(() => client.runTaskDetailed("topic-ideas", payload, "correct-request"),
      (error: unknown) => error instanceof CodexBridgeError && error.stage === "conflict");
  });

  it("A12 consumes background completion persistence rejection", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-completion-child-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixturePath = fileURLToPath(new URL("./fixtures/completion-persistence-failure-child.ts", import.meta.url));
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", fixturePath, directory], { timeout: 4_000 }, (error, _stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stderr });
      });
    });
    assert.equal(result.code, 0, result.stderr);
  });

  it("projects checkpoint-only planning intent before the real asset-rank broker boundary", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-asset-rank-contract-"));
    const socketPath = path.join(directory, "broker.sock");
    const calls: Array<Record<string, unknown>> = [];
    const assetContract = taskContractDescriptorFor("asset-rank");
    const executor = {
      identity: { profileId: "fixture", providerId: "openai", modelId: "fixture-model", taskKinds: ["asset-rank"] },
      async runTask(task: Record<string, unknown>) {
        calls.push(task);
        return {
          output: JSON.stringify({
            version: "video-factory/asset-ranking-v1",
            source: "model",
            providerId: "codex-asset-ranker-v1",
            modelId: "fixture-model",
            summary: "候选与画面意图一致",
            scenes: [{
              scenePosition: 1,
              summary: "动作清楚",
              candidates: [{
                provider: "pexels",
                assetId: "phone-1",
                originalRank: 1,
                rank: 1,
                semanticScore: 88,
                rationale: "同一部手机和操作动作均可见",
                locked: false,
              }],
            }],
          }),
          sessionId: threadId,
          trace: {
            taskKind: "asset-rank" as const,
            promptVersion: assetContract.promptVersion,
            contractDigest: assetContract.digest,
            prompt: "fixture",
            providerId: "openai",
            modelId: "fixture-model",
          },
        };
      },
    };
    const broker = new CodexBrokerServer({
      socketPath,
      executor: executor as never,
      idempotencyDirectory: path.join(directory, "records"),
      sessionDirectory: path.join(directory, "sessions"),
    });
    await broker.start();
    t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
    const ranker = new CodexAssetSemanticRanker({
      client: new CodexBridgeClient({ socketPath, timeoutMs: 2_000, pollIntervalMs: 10, maxAttempts: 1 }),
      providerId: "codex-asset-ranker-v1",
      modelId: "fixture-model",
      fetchThumbnail: async () => undefined,
    });
    const report = {
      version: "video-factory/asset-candidates-v1" as const,
      scenes: [{
        scenePosition: 1,
        intent: { subject: "同一部手机", visibleAction: "依次执行三个动作" },
        query: "phone battery anxiety",
        candidates: [{
          provider: "pexels",
          assetId: "phone-1",
          mediaType: "video" as const,
          width: 1080,
          height: 1920,
          duration: 8,
          previewUrl: "https://images.pexels.com/phone-1.jpg",
          sourceUrl: "https://www.pexels.com/video/phone-1",
          creator: "fixture",
          licenseNote: "fixture license",
          query: "phone battery anxiety",
          qualityScore: 80,
        }],
      }],
      planningIntent: {
        semanticIntentVersion: "video-factory/ranking-semantic-intent-v1",
        rankingIntent: { subject: "同一部手机", action: "比较三个动作" },
      },
    };

    const ranking = await ranker.rank(report);

    assert.equal(ranking.scenes[0]?.candidates[0]?.assetId, "phone-1");
    assert.equal(calls.length, 1);
    const acceptedPayload = calls[0]?.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(acceptedPayload).sort(), ["scenes", "thumbnails", "version"]);
    assert.equal(Object.hasOwn(acceptedPayload, "planningIntent"), false);
  });
});

async function setup(
  t: { after(action: () => Promise<unknown> | unknown): void },
  run?: () => Promise<ReturnType<typeof success>>,
  concurrency = 1,
  maxBacklog = 32,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-lifecycle-v3-"));
  const socketPath = path.join(directory, "worker.sock");
  const records = path.join(directory, "records");
  const sessions = path.join(directory, "sessions");
  const calls: unknown[] = [];
  const executor = {
    identity: { profileId: "fixture", providerId: "openai", modelId: "fixture-model", taskKinds: ["topic-ideas"] },
    async runTask(task: unknown) {
      calls.push(task);
      return run ? run() : success();
    },
  };
  const broker = new CodexBrokerServer({ socketPath, executor: executor as never, idempotencyDirectory: records, sessionDirectory: sessions, concurrency, maxBacklog });
  await broker.start();
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new CodexBridgeClient({ socketPath, timeoutMs: 2_000, pollIntervalMs: 10, maxAttempts: 1 });
  return {
    directory,
    socketPath,
    records,
    sessions,
    calls,
    client,
    async body(requestId: string) {
      const health = JSON.parse((await request(socketPath, "GET", "/health")).body) as Record<string, unknown>;
      return JSON.stringify({
        protocolVersion: "video-factory/codex-bridge-v2",
        requestId,
        kind: "topic-ideas",
        payload,
        expectedContractDigest: contract.digest,
        brokerBinding: {
          version: health.taskBindingVersion,
          storeId: health.storeId,
          providerId: health.providerId,
          modelId: health.modelId,
        },
      });
    },
    async complete(accepted: Response) {
      const envelope = JSON.parse(accepted.body) as { requestId: string; binding: Record<string, unknown> };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observation = await request(socketPath, "GET", `/v1/tasks/${encodeURIComponent(envelope.requestId)}`, undefined, bindingHeaders(envelope.binding));
        const state = JSON.parse(observation.body) as { state?: string };
        if (state.state === "completed_success" || state.state === "completed_failure") return observation;
        await delay(10);
      }
      throw new Error("Completion deadline exceeded.");
    },
  };
}

function success() {
  return {
    output: "{\"ideas\":[]}",
    sessionId: threadId,
    trace: { taskKind: "topic-ideas" as const, promptVersion: contract.promptVersion, contractDigest: contract.digest, prompt: "fixture", providerId: "openai", modelId: "fixture-model" },
  };
}

interface Response { status: number; body: string }

function request(socketPath: string, method: string, requestPath: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: requestPath, headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function bindingHeaders(binding: Record<string, unknown>): Record<string, string> {
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

async function forward(incoming: http.IncomingMessage, outgoing: http.ServerResponse | undefined, socketPath: string): Promise<Response> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
  const response = await request(socketPath, incoming.method ?? "GET", incoming.url ?? "/", body, Object.fromEntries(
    Object.entries(incoming.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []),
  ));
  if (outgoing) send(outgoing, response.status, JSON.parse(response.body));
  return response;
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(serialized)) });
  response.end(serialized);
}

function recordPath(directory: string, id: string): string {
  return path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor deadline exceeded");
    await delay(5);
  }
}
