import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CODEX_BRIDGE_PROTOCOL_VERSION,
  CodexBridgeClient,
  REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
  CodexBridgeError,
  type CodexTaskKind,
} from "../src/codex-chat.js";

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface BridgeServer {
  socketPath: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startBridge(
  respond: (request: CapturedRequest, response: http.ServerResponse) => void,
): Promise<BridgeServer> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-codex-"));
  const socketPath = path.join(directory, "codex.sock");
  const requests: CapturedRequest[] = [];
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const captured: CapturedRequest = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
      };
      requests.push(captured);
      respond(captured, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function respondWithJson(response: http.ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(serialized)),
  });
  response.end(serialized);
}

describe("CodexBridgeClient", () => {
  it("posts a structured task body to the unix socket", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        ok: true,
        output: JSON.stringify({ shots: 3 }),
        trace: {
          taskKind: "director-plan",
          promptVersion: "video-factory/director-v28",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["director-plan"],
          prompt: "p",
          providerId: "openai",
          modelId: "m",
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      const result = await client.runTask("director-plan", { scenes: [{ position: 1 }] });

      assert.deepEqual(result, { shots: 3 });
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 1);
      assert.equal(bridge.requests[0]?.method, "POST");
      assert.equal(bridge.requests[0]?.url, "/v1/tasks");
      assert.deepEqual(
        Object.keys(bridge.requests[0]!.body).sort(),
        ["expectedContractDigest", "kind", "payload", "protocolVersion", "requestId"],
      );
      assert.equal(bridge.requests[0]?.body.protocolVersion, CODEX_BRIDGE_PROTOCOL_VERSION);
      assert.equal(bridge.requests[0]?.body.kind, "director-plan");
      assert.equal(
        bridge.requests[0]?.body.expectedContractDigest,
        REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["director-plan"],
      );
      assert.equal(typeof bridge.requests[0]?.body.requestId, "string");
      assert.deepEqual(bridge.requests[0]?.body.payload, { scenes: [{ position: 1 }] });
    } finally {
      await bridge.close();
    }
  });

  it("accepts fenced json output from the model", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        ok: true,
        output: "```json\n{\"profile\":\"urban-poetic\"}\n```",
        trace: { taskKind: "topic-ideas", promptVersion: "v1", contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"], prompt: "p", providerId: "openai", modelId: "m" },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      const result = await client.runTask("topic-ideas", { signals: [] });

      assert.deepEqual(result, { profile: "urban-poetic" });
    } finally {
      await bridge.close();
    }
  });

  it("returns the immutable prompt, prompt pack, provider, and model through the detailed API", async () => {
    const trace = {
      taskKind: "script-draft",
      promptVersion: "video-factory/screenwriter-v2",
      contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
      prompt: "Prompt Pack: video-factory/screenwriter-v2\nactual prompt",
      providerId: "openai",
      modelId: "gpt-5.4",
      providerWaitMs: 12_340,
      firstOutputEventMs: 410,
      toolMs: 0,
      validationMs: 7,
      requestIdHash: "b".repeat(64),
      finishReason: "stop",
      promptTokens: 1_200,
      completionTokens: 3_400,
      totalTokens: 4_600,
      reasoningTokens: 2_700,
      attemptedModelIds: ["glm-5.3", "gpt-5.4"],
      modelCandidateAttempts: [{
        modelId: "glm-5.3",
        providerId: "zai-bigmodel-api",
        outcome: "failed",
        failureStage: "not_accepted",
        failureReason: "连接失败",
      }, {
        modelId: "gpt-5.4",
        providerId: "openai",
        outcome: "succeeded",
      }],
    } as const;
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, { ok: true, output: "{\"scenes\":[]}", trace });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      const result = await client.runTaskDetailed("script-draft", { brief: {} });

      assert.deepEqual(result, { output: { scenes: [] }, trace });
    } finally {
      await bridge.close();
    }
  });

  it("rejects malformed model candidate traces instead of silently dropping them", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        ok: true,
        output: "{\"scenes\":[]}",
        trace: {
          taskKind: "script-draft",
          promptVersion: "video-factory/screenwriter-v2",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
          prompt: "actual prompt",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelCandidateAttempts: [{ modelId: "gpt-5.4", providerId: "openai", outcome: "succeeded", failureReason: "impossible" }],
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      await assert.rejects(
        () => client.runTaskDetailed("script-draft", { brief: {} }),
        /successful model candidate attempt cannot contain a failure/,
      );
      assert.deepEqual(bridge.requests.map((request) => request.method), ["POST"]);
    } finally {
      await bridge.close();
    }
  });

  it("requires failed model attempts to preserve both stage and public reason", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        ok: true,
        output: "{\"scenes\":[]}",
        trace: {
          taskKind: "script-draft",
          promptVersion: "video-factory/screenwriter-v2",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
          prompt: "actual prompt",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelCandidateAttempts: [{ modelId: "glm-5.3", providerId: "zai-bigmodel-api", outcome: "failed" }],
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      await assert.rejects(
        () => client.runTaskDetailed("script-draft", { brief: {} }),
        /failed model candidate attempt must describe its failure/,
      );
    } finally {
      await bridge.close();
    }
  });

  it("requires every model attempt to preserve its broker provider identity", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        ok: true,
        output: "{\"scenes\":[]}",
        trace: {
          taskKind: "script-draft",
          promptVersion: "video-factory/screenwriter-v2",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
          prompt: "actual prompt",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelCandidateAttempts: [{ modelId: "gpt-5.4", outcome: "succeeded" }],
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      await assert.rejects(
        () => client.runTaskDetailed("script-draft", { brief: {} }),
        /broker provider identity/,
      );
    } finally {
      await bridge.close();
    }
  });

  it("sends an opaque role session and returns the broker-owned continuation handle", async () => {
    const handle = `vfs_${"s".repeat(32)}`;
    const bridge = await startBridge((request, response) => {
      assert.equal(request.body.sessionKey, "run-1:script:produce");
      assert.equal(request.body.sessionHandle, handle);
      respondWithJson(response, 200, {
        ok: true,
        output: "{\"scenes\":[]}",
        sessionHandle: handle,
        trace: {
          taskKind: "script-draft",
          promptVersion: "video-factory/screenwriter-v2",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
          prompt: "session fixture",
          providerId: "openai",
          modelId: "gpt-5.4",
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });
      const result = await client.runTaskDetailed(
        "script-draft",
        { brief: {} },
        "request-1",
        { key: "run-1:script:produce", handle },
      );

      assert.deepEqual(result.session, { key: "run-1:script:produce", handle });
    } finally {
      await bridge.close();
    }
  });

  it("rejects real Codex UUIDs at the opaque session boundary", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, { ok: true, output: "{}" });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });
      await assert.rejects(() => client.runTaskDetailed(
        "script-draft",
        { brief: {} },
        "uuid-boundary",
        { key: "run-1:script:produce", handle: "019c0000-0000-7000-8000-000000000001" },
      ), /session handle is invalid/);
      assert.equal(bridge.requests.length, 0);
    } finally {
      await bridge.close();
    }
  });

  it("aborts on timeout and never replays the task", async () => {
    const bridge = await startBridge((_request, _response) => {
      // 挂起不响应，模拟 broker 无应答。
    });
    const delays: number[] = [];
    try {
      const client = new CodexBridgeClient({
        socketPath: bridge.socketPath,
        timeoutMs: 60,
        maxAttempts: 3,
        retryDelayMs: 5,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      });

      await assert.rejects(() => client.runTask("director-plan", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.match(error.message, /timed out/);
        return true;
      });
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 1);
      assert.deepEqual(delays, []);
    } finally {
      await bridge.close();
    }
  });

  it("treats a severed accepted response body as uncertain and never retries it", async () => {
    const bridge = await startBridge((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "512",
      });
      response.write('{"ok":true,"output":"');
      setImmediate(() => response.socket?.destroy());
    });
    try {
      const client = new CodexBridgeClient({
        socketPath: bridge.socketPath,
        maxAttempts: 3,
        sleep: async () => {},
      });

      await assert.rejects(
        () => client.runTask("script-draft", {}, "response-stream-interrupted"),
        (error: unknown) => {
          assert.ok(error instanceof CodexBridgeError);
          assert.equal(error.transient, false);
          assert.equal(error.stage, "uncertain");
          return true;
        },
      );
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("retries connect-phase failures that provably precede task acceptance", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-codex-"));
    const delays: number[] = [];
    try {
      const client = new CodexBridgeClient({
        socketPath: path.join(directory, "missing.sock"),
        maxAttempts: 2,
        retryDelayMs: 5,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      });

      await assert.rejects(() => client.runTask("director-plan", {}), /ENOENT/);
      assert.deepEqual(delays, [5]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a transient 503, sleeps once, and succeeds on the next attempt", async () => {
    let calls = 0;
    const bridge = await startBridge((_request, response) => {
      calls += 1;
      if (calls === 1) {
        respondWithJson(response, 503, { error: "codex backlog is full" });
        return;
      }
      respondWithJson(response, 200, {
        ok: true,
        output: JSON.stringify({ recovered: true }),
        trace: { taskKind: "topic-ideas", promptVersion: "v1", contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"], prompt: "p", providerId: "openai", modelId: "m" },
      });
    });
    const delays: number[] = [];
    try {
      const client = new CodexBridgeClient({
        socketPath: bridge.socketPath,
        retryDelayMs: 25,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      });

      const result = await client.runTask("topic-ideas", {});

      assert.deepEqual(result, { recovered: true });
      assert.equal(bridge.requests.length, 2);
      assert.deepEqual(delays, [25]);
    } finally {
      await bridge.close();
    }
  });

  it("does not retry executor failures that were already accepted", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 422, { error: "Codex task failed transiently: timed out." });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, maxAttempts: 3, sleep: async () => {} });

      await assert.rejects(() => client.runTask("director-plan", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.match(error.message, /HTTP 422/);
        return true;
      });
      assert.equal(bridge.requests.length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("preserves an accepted transient provider classification without replaying the request", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 422, {
        error: "The selected model is temporarily unavailable.",
        failureKind: "model_provider_transient",
        failureDetails: {
          category: "rate_limited",
          reasonCode: "1308",
          requestIdHash: "a".repeat(64),
          providerId: "zai-bigmodel-api",
          modelId: "glm-5.3",
          queueWaitMs: 19,
          providerWaitMs: 37,
          finishReason: "length",
          promptTokens: 2_000,
          completionTokens: 65_536,
          totalTokens: 67_536,
          reasoningTokens: 61_000,
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, maxAttempts: 3, sleep: async () => {} });

      await assert.rejects(() => client.runTask("script-draft", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.equal(error.stage, "completed_failure");
        assert.equal(error.statusCode, 422);
        assert.match(error.message, /temporarily unavailable/i);
        assert.equal(error.creatorMessage, "模型请求过多，请稍后重试或选择其他模型。");
        assert.deepEqual(error.failureDetails, {
          category: "rate_limited",
          reasonCode: "1308",
          requestIdHash: "a".repeat(64),
          providerId: "zai-bigmodel-api",
          modelId: "glm-5.3",
          queueWaitMs: 19,
          providerWaitMs: 37,
          finishReason: "length",
          promptTokens: 2_000,
          completionTokens: 65_536,
          totalTokens: 67_536,
          reasoningTokens: 61_000,
        });
        assert.doesNotMatch(error.creatorMessage, /Agent|Codex bridge|host-only broker|socket/i);
        return true;
      });
      assert.equal(bridge.requests.length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("preserves a completed no-output classification without replaying the request", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 422, {
        error: "the model did not return a result.",
        failureKind: "model_provider_no_output",
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, maxAttempts: 3, sleep: async () => {} });

      await assert.rejects(() => client.runTask("script-draft", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.equal(error.stage, "completed_failure");
        assert.equal(error.failureKind, "model_provider_no_output");
        return true;
      });
      assert.equal(bridge.requests.length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("does not retry terminal 4xx responses", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 400, { error: "unsupported task kind" });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, maxAttempts: 3, sleep: async () => {} });

      await assert.rejects(() => client.runTask("director-plan", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.match(error.message, /HTTP 400/);
        return true;
      });
      assert.equal(bridge.requests.length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("marks an unknown role session as safely unaccepted without retrying it in the client", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 409, {
        error: "Codex role session is unknown or belongs to a different production role.",
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, maxAttempts: 3, sleep: async () => {} });

      await assert.rejects(
        () => client.runTaskDetailed(
          "script-draft",
          { brief: {} },
          "lost-role-session",
          { key: "run-1:script:produce", handle: `vfs_${"s".repeat(32)}` },
        ),
        (error: unknown) => {
          assert.ok(error instanceof CodexBridgeError);
          assert.equal(error.transient, false);
          assert.equal(error.stage, "not_accepted");
          assert.equal(error.statusCode, 409);
          return true;
        },
      );
      assert.equal(bridge.requests.length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("rejects responses that exceed the byte cap without retrying", async () => {
    const bridge = await startBridge((_request, response) => {
      response.on("error", () => undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true,"output":"${"a".repeat(4096)}"}`);
    });
    try {
      const client = new CodexBridgeClient({
        socketPath: bridge.socketPath,
        maxResponseBytes: 256,
        sleep: async () => {},
      });

      await assert.rejects(() => client.runTask("topic-ideas", {}), (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.transient, false);
        assert.match(error.message, /exceeds/);
        return true;
      });
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 1);
    } finally {
      await bridge.close();
    }
  });

  it("rejects unknown task kinds at runtime before touching the socket", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, { ok: true, output: "{}" });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath });

      await assert.rejects(
        () => client.runTask("shell" as CodexTaskKind, { command: "rm -rf /", cwd: "/" }),
        (error: unknown) => {
          assert.ok(error instanceof CodexBridgeError);
          assert.equal(error.transient, false);
          assert.match(error.message, /Unsupported codex task kind/);
          return true;
        },
      );
      assert.equal(bridge.requests.length, 0);
    } finally {
      await bridge.close();
    }
  });

  it("observes a healthy running task once without waiting for a terminal result", async () => {
    let operation: Awaited<ReturnType<CodexBridgeClient["prepareTask"]>> | undefined;
    const bridge = await startBridge((request, response) => {
      if (request.url === "/health") {
        respondWithJson(response, 200, {
          protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
          taskBindingVersion: "video-factory/task-binding-v1",
          storeId: `vfs_store_${"a".repeat(32)}`,
          providerId: "openai",
          modelId: "gpt-5.4",
          taskModels: { "topic-ideas": "gpt-5.4" },
        });
        return;
      }
      respondWithJson(response, 200, {
        state: "running",
        requestId: operation?.requestId,
        binding: operation?.binding,
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, timeoutMs: 1_000 });
      operation = await client.prepareTask("topic-ideas", { signals: [] }, "observe-running-once");

      const observation = await client.observePreparedOnce(operation, { timeoutMs: 100 });

      assert.deepEqual(observation, { state: "running" });
      assert.deepEqual(bridge.requests.map((request) => request.url), ["/health", "/v1/tasks/observe-running-once"]);
    } finally {
      await bridge.close();
    }
  });

  it("binds mixed-model tasks from the validated request payload before submission", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, {
        protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
        taskBindingVersion: "video-factory/task-binding-v1",
        storeId: `vfs_store_${"b".repeat(32)}`,
        providerId: "zai-bigmodel-api",
        modelId: "text-custom",
        taskModels: { "role-audit": "text-custom", "asset-rank": "visual-custom" },
        taskModelRoutes: {
          "role-audit": { withoutImages: "text-custom", withImages: "visual-custom" },
          "asset-rank": { withoutImages: "text-custom", withImages: "visual-custom" },
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath });
      const bindings = await Promise.all([
        client.prepareTask("role-audit", { images: [] }, "role-text"),
        client.prepareTask("role-audit", { images: [{}] }, "role-visual"),
        client.prepareTask("asset-rank", { thumbnails: [] }, "rank-text"),
        client.prepareTask("asset-rank", { thumbnails: [{}] }, "rank-visual"),
      ]);

      assert.deepEqual(bindings.map((operation) => operation.binding.modelId), [
        "text-custom", "visual-custom", "text-custom", "visual-custom",
      ]);
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 0);
    } finally {
      await bridge.close();
    }
  });

  it("rejects completed results whose trace does not match the immutable task binding", async () => {
    let operation: Awaited<ReturnType<CodexBridgeClient["prepareTask"]>> | undefined;
    let traceOverride: Record<string, unknown> = {};
    const bridge = await startBridge((request, response) => {
      if (request.url === "/health") {
        respondWithJson(response, 200, {
          protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
          taskBindingVersion: "video-factory/task-binding-v1",
          storeId: `vfs_store_${"c".repeat(32)}`,
          providerId: "zai-bigmodel-api",
          modelId: "text-custom",
          taskModels: { "role-audit": "text-custom" },
        });
        return;
      }
      respondWithJson(response, 200, {
        state: "completed_success",
        ok: true,
        requestId: operation?.requestId,
        binding: operation?.binding,
        output: "{}",
        trace: {
          taskKind: operation?.kind,
          promptVersion: "test",
          contractDigest: operation?.binding.contractDigest,
          prompt: "test",
          providerId: operation?.binding.providerId,
          modelId: operation?.binding.modelId,
          ...traceOverride,
        },
      });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath });
      const cases = [
        { providerId: "openai" },
        { modelId: "other-model" },
        { taskKind: "asset-rank" },
        { contractDigest: "0".repeat(64) },
      ];
      for (const [index, mismatch] of cases.entries()) {
        traceOverride = mismatch;
        operation = await client.prepareTask("role-audit", { images: [] }, `trace-mismatch-${index}`);
        assert.deepEqual(await client.observePreparedOnce(operation), { state: "conflict" });
      }
      assert.equal(bridge.requests.filter((request) => request.method === "POST").length, 0);
    } finally {
      await bridge.close();
    }
  });
});
