import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CODEX_BRIDGE_PROTOCOL_VERSION,
  CodexBridgeClient,
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
      respondWithJson(response, 200, { ok: true, output: JSON.stringify({ shots: 3 }) });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      const result = await client.runTask("director-plan", { scenes: [{ position: 1 }] });

      assert.deepEqual(result, { shots: 3 });
      assert.equal(bridge.requests.length, 1);
      assert.equal(bridge.requests[0]?.method, "POST");
      assert.equal(bridge.requests[0]?.url, "/v1/tasks");
      assert.deepEqual(
        Object.keys(bridge.requests[0]!.body).sort(),
        ["kind", "payload", "protocolVersion"],
      );
      assert.equal(bridge.requests[0]?.body.protocolVersion, CODEX_BRIDGE_PROTOCOL_VERSION);
      assert.equal(bridge.requests[0]?.body.kind, "director-plan");
      assert.deepEqual(bridge.requests[0]?.body.payload, { scenes: [{ position: 1 }] });
    } finally {
      await bridge.close();
    }
  });

  it("accepts fenced json output from the model", async () => {
    const bridge = await startBridge((_request, response) => {
      respondWithJson(response, 200, { ok: true, output: "```json\n{\"profile\":\"urban-poetic\"}\n```" });
    });
    try {
      const client = new CodexBridgeClient({ socketPath: bridge.socketPath, sleep: async () => {} });

      const result = await client.runTask("topic-ideas", { signals: [] });

      assert.deepEqual(result, { profile: "urban-poetic" });
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
      assert.equal(bridge.requests.length, 1);
      assert.deepEqual(delays, []);
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
      respondWithJson(response, 200, { ok: true, output: JSON.stringify({ recovered: true }) });
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
      assert.equal(bridge.requests.length, 1);
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
});
