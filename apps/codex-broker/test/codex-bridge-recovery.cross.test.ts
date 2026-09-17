// 跨进程恢复测试：真实 CodexBridgeClient × 真实 CodexBrokerServer × 真实 Unix socket ×
// 真实 durable record；只把外部模型替换为受控 executor。
// 验收：accepted 后响应丢失/查询失败都不改变任务事实，恢复只观察原 requestId，
// executor 严格调用一次；权威 not_accepted 才允许有界重试。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
  runRoleAgentLoop,
} from "../../../packages/production-pipeline/src/index.js";
import { TASK_BINDING_VERSION, taskBinding } from "../../../packages/production-pipeline/src/codex-task-binding.js";
import { FallbackCodexTaskClient } from "../../../packages/production-pipeline/src/fallback-task-client.js";
import { CodexExecutor, type CodexExecutionOptions, type CodexExecutionResult, type ValidatedTask } from "../src/codex-executor.js";
import { CodexBrokerServer } from "../src/broker-server.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";

class ScriptedExecutor extends CodexExecutor {
  readonly calls: string[] = [];
  private readonly resolvers: Array<() => void> = [];
  private readonly callWaiters: Array<{ count: number; settle: () => void }> = [];

  constructor() {
    super({ workspaceRoot: "/nonexistent-codex-broker" });
  }

  gate(): Promise<void> {
    return new Promise<void>((resolve) => this.resolvers.push(resolve));
  }

  release(index: number): void {
    this.resolvers[index]?.();
  }

  // 按真实开始事件同步：受理落盘与 executor 启动之间存在调度窗口，
  // 固定 sleep 会在这个窗口内读到 calls=0。这里等真实调用，并保留有界失败。
  waitForCallCount(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`executor was not called ${count} time(s) within ${timeoutMs}ms (actual ${this.calls.length}).`));
      }, timeoutMs);
      this.callWaiters.push({ count, settle: () => { clearTimeout(timer); resolve(); } });
    });
  }

  private settleCallWaiters(): void {
    for (let index = this.callWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.callWaiters[index]!;
      if (this.calls.length >= waiter.count) {
        this.callWaiters.splice(index, 1);
        waiter.settle();
      }
    }
  }

  async runTask(task: ValidatedTask, options?: CodexExecutionOptions): Promise<CodexExecutionResult> {
    this.calls.push(task.kind);
    this.settleCallWaiters();
    await this.gate();
    return {
      output: "{\"ideas\":[]}",
      sessionId: "11111111-2222-3333-4444-555555555555",
      trace: {
        taskKind: task.kind,
        promptVersion: taskContractDescriptorFor(task.kind as never).promptVersion,
        contractDigest: task.expectedContractDigest!,
        prompt: "test",
        providerId: "openai",
        modelId: "codex-default",
      },
    };
  }
}

interface BrokerHandle {
  socketPath: string;
  directory: string;
  server: CodexBrokerServer;
  close(): Promise<void>;
}

async function startDurableBroker(executor: ScriptedExecutor): Promise<BrokerHandle> {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-bridge-recovery-"));
  const socketPath = path.join(directory, "worker.sock");
  const server = new CodexBrokerServer({
    socketPath,
    executor,
    idempotencyDirectory: path.join(directory, "idempotency"),
    sessionDirectory: path.join(directory, "sessions"),
  });
  await server.start();
  return {
    socketPath,
    directory,
    server,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function topicBody(requestId: string): string {
  return JSON.stringify({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId,
    kind: "topic-ideas",
    payload: { signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: "恢复测试信号" }] },
    expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
  });
}

// 等 durable record 真正到达终态：读已落盘的权威状态，而不是猜一个毫秒数。
// requestId 省略时匹配本目录内的任意记录（每个用例使用独立的临时 idempotency 目录）。
async function waitForDurableState(
  directory: string,
  requestId: string | undefined,
  state: string,
  timeoutMs = 5_000,
): Promise<void> {
  const idempotencyDirectory = path.join(directory, "idempotency");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      for (const name of await readdir(idempotencyDirectory)) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(path.join(idempotencyDirectory, name), "utf8")) as
          { requestId?: unknown; state?: unknown };
        if ((requestId === undefined || record.requestId === requestId) && record.state === state) return;
      }
    } catch {
      // record 尚未落盘：继续有界观察。
    }
    if (Date.now() >= deadline) {
      throw new Error(`durable record '${requestId ?? "*"}' did not reach '${state}' within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CodexBridgeClient × CodexBrokerServer durable recovery", () => {
  it("polls the accepted task to completion without resubmitting it", async () => {
    const executor = new ScriptedExecutor();
    const broker = await startDurableBroker(executor);
    try {
      const client = new CodexBridgeClient({
        socketPath: broker.socketPath,
        pollIntervalMs: 10,
        timeoutMs: 10_000,
        sleep: async () => {},
      });

      const pending = client.runTaskDetailed("topic-ideas", {
        signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: "恢复测试信号" }],
      }, "recovery-poll-1");
      await executor.waitForCallCount(1);
      assert.equal(executor.calls.length, 1, "executor must run exactly once while the client waits");
      executor.release(0);
      const execution = await pending;

      assert.deepEqual(execution.output, { ideas: [] });
      assert.equal(executor.calls.length, 1);
    } finally {
      await broker.close();
    }
  });

  it("recovers the durable outcome on resubmission after the first submission is lost", async () => {
    const executor = new ScriptedExecutor();
    const broker = await startDurableBroker(executor);
    try {
      const payload = { signals: [{ id: "signal-1", platform: "douyin", rank: 1, title: "丢失恢复信号" }] };
      const client = new CodexBridgeClient({
        socketPath: broker.socketPath,
        pollIntervalMs: 10,
        timeoutMs: 10_000,
        sleep: async () => {},
      });

      // 第一次调用在任务被 durable 受理后因等待截止而失败（accepted/unknown）。
      const firstOutcome = client.runTaskDetailed("topic-ideas", payload, "recovery-lost-1", undefined, { timeoutMs: 40 });
      await assert.rejects(() => firstOutcome, (error: unknown) => error instanceof CodexBridgeError);
      // release 必须发生在真实启动之后，否则 resolvers[0] 尚不存在，executor 会永远挂在 gate 上。
      await executor.waitForCallCount(1);
      executor.release(0);
      await waitForDurableState(broker.directory, "recovery-lost-1", "completed");
      assert.equal(executor.calls.length, 1);

      // 恢复 = 同 requestId 重新提交：durable completed 直接重放，不产生第二次执行。
      const recovered = await client.runTaskDetailed("topic-ideas", payload, "recovery-lost-1");
      assert.deepEqual(recovered.output, { ideas: [] });
      assert.equal(executor.calls.length, 1);
    } finally {
      await broker.close();
    }
  });

  it("keeps the task facts accepted while the query connection itself keeps failing", async () => {
    // 假桥接：POST durable accepted（202），GET 前两次 500，之后返回 completed outcome。
    const directory = await mkdtemp(path.join(tmpdir(), "vf-bridge-query-fault-"));
    const socketPath = path.join(directory, "worker.sock");
    let getFailures = 0;
    let postCount = 0;
    const brokerBinding = {
      version: TASK_BINDING_VERSION,
      storeId: `vfs_store_${"a".repeat(32)}`,
      providerId: "openai",
      modelId: "m",
    } as const;
    let completed = "";
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: "video-factory/codex-bridge-v2",
          taskBindingVersion: TASK_BINDING_VERSION,
          ...brokerBinding,
          taskKinds: ["topic-ideas"],
          taskContracts: { "topic-ideas": REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"] },
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/tasks") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          postCount += 1;
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const binding = taskBinding({
            request: envelope,
            broker: brokerBinding,
            kind: "topic-ideas",
            contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"],
          });
          completed = JSON.stringify({
            state: "completed_success",
            requestId: "query-fault-1",
            binding,
            ok: true,
            output: "{\"ideas\":[]}",
            trace: { taskKind: "topic-ideas", promptVersion: "v1", contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"], prompt: "p", providerId: "openai", modelId: "m" },
          });
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ accepted: true, requestId: "query-fault-1", state: "running", binding }));
        });
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/tasks/")) {
        getFailures += 1;
        if (getFailures <= 2) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "query transport failure" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(completed);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodexBridgeClient({
        socketPath,
        pollIntervalMs: 10,
        timeoutMs: 10_000,
        sleep: async () => {},
      });

      const execution = await client.runTaskDetailed("topic-ideas", { signals: [] }, "query-fault-1");

      assert.deepEqual(execution.output, { ideas: [] });
      assert.equal(postCount, 1, "查询失败不得触发第二次提交");
      assert.ok(getFailures >= 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats a bare 404 as an observation failure, not authoritative not_accepted", async () => {
    const executor = new ScriptedExecutor();
    const broker = await startDurableBroker(executor);
    try {
      const client = new CodexBridgeClient({
        socketPath: broker.socketPath,
        pollIntervalMs: 10,
        timeoutMs: 10_000,
        sleep: async () => {},
      });

      const prepared = await client.prepareTask("topic-ideas", { signals: [] }, "never-accepted-id");
      await assert.rejects(
        () => client.observePrepared(prepared, { timeoutMs: 40 }),
        (error: unknown) => error instanceof CodexBridgeError && error.stage === "uncertain",
      );
      assert.equal(executor.calls.length, 0);
    } finally {
      await broker.close();
    }
  });

  it("G04 preserves the accepted fact across the query fault matrix", async () => {
    for (const fault of ["reset", "timeout", "partial-json", "invalid-json", "http-500", "bare-404"] as const) {
      const fixture = await startAcceptedFaultFixture(fault);
      try {
        const client = new CodexBridgeClient({
          socketPath: fixture.socketPath,
          timeoutMs: 80,
          pollIntervalMs: 10,
          maxAttempts: 1,
        });
        await assert.rejects(
          () => client.runTaskDetailed("topic-ideas", { signals: [] }, `fault-${fault}`),
          (error: unknown) => error instanceof CodexBridgeError && error.stage === "uncertain",
          `${fault} must leave the original accepted task unknown`,
        );
        assert.equal(fixture.posts, 1, `${fault} must not submit a replacement task`);
        assert.ok(fixture.queries > 0, `${fault} must only retry observation`);
      } finally {
        await fixture.close();
      }
    }
  });

  it("G04 treats ENOENT and ECONNREFUSED during observation as unknown without a POST", async () => {
    for (const fault of ["ENOENT", "ECONNREFUSED"] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), `vf-observe-${fault.toLowerCase()}-`));
      const socketPath = path.join(directory, "worker.sock");
      const server = http.createServer((request, response) => {
        if (request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(healthEnvelope()));
        }
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const client = new CodexBridgeClient({ socketPath, timeoutMs: 50, pollIntervalMs: 10, maxAttempts: 1 });
        const operation = await client.prepareTask("topic-ideas", { signals: [] }, `observe-${fault.toLowerCase()}`);
        operation.taskFact = "accepted";
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (fault === "ENOENT") await unlink(socketPath).catch((error) => {
          if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
        });
        await assert.rejects(
          () => client.observePrepared(operation, { timeoutMs: 50 }),
          (error: unknown) => error instanceof CodexBridgeError && error.stage === "uncertain",
        );
      } finally {
        server.closeAllConnections();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("G04 rejects replaced completion identities instead of consuming them", async () => {
    for (const fault of ["wrong-request", "wrong-store"] as const) {
      const fixture = await startAcceptedFaultFixture(fault);
      try {
        const client = new CodexBridgeClient({ socketPath: fixture.socketPath, timeoutMs: 200, pollIntervalMs: 10, maxAttempts: 1 });
        await assert.rejects(
          () => client.runTaskDetailed("topic-ideas", { signals: [] }, `fault-${fault}`),
          (error: unknown) => error instanceof CodexBridgeError && error.stage === "conflict",
        );
        assert.equal(fixture.posts, 1);
        assert.equal(fixture.queries, 1);
      } finally {
        await fixture.close();
      }
    }
  });

  it("G03 saves the immutable operation before POST and stops when that checkpoint save fails", async () => {
    const executor = new ScriptedExecutor();
    const broker = await startDurableBroker(executor);
    let stored: unknown;
    try {
      const client = new CodexBridgeClient({ socketPath: broker.socketPath, timeoutMs: 200, pollIntervalMs: 10 });
      await assert.rejects(() => runRoleAgentLoop<{ ideas: unknown[] }>({
        role: "选题总编",
        contractVersion: "checkpoint-before-post-v1",
        criteria: ["输出合法"],
        maxIterations: 1,
        checkpoint: {
          key: "checkpoint-before-post",
          load: async () => stored,
          save: async (value) => {
            if ((value as { pendingOperation?: unknown }).pendingOperation) throw new Error("checkpoint persistence fixture");
            stored = structuredClone(value);
          },
        },
        produce: (_revision, operation) => client.runTaskDetailed(
          "topic-ideas",
          { signals: [] },
          operation.requestId,
          operation.session,
          operation.requestOptions,
        ),
        audit: async () => ({ output: passingAudit() }),
        validate: topicCandidate,
      }), /checkpoint persistence fixture/);
      assert.equal(executor.calls.length, 0, "checkpoint failure must happen before the broker can execute a POST");
    } finally {
      await broker.close();
    }
  });

  it("G03 restores a pending operation through its original provider without rotating counters", async () => {
    const executor = new ScriptedExecutor();
    const broker = await startDurableBroker(executor);
    let stored: unknown;
    try {
      const originalClient = new CodexBridgeClient({ socketPath: broker.socketPath, timeoutMs: 40, pollIntervalMs: 10 });
      const unusedBackup = new CodexBridgeClient({ socketPath: path.join(broker.directory, "unused-backup.sock") });
      const firstFallback = fallbackClient(originalClient, unusedBackup, false);
      const execute = (client: FallbackCodexTaskClient) => runRoleAgentLoop<{ ideas: unknown[] }>({
        role: "选题总编",
        contractVersion: "checkpoint-original-provider-v1",
        criteria: ["输出合法"],
        maxIterations: 1,
        checkpoint: {
          key: "checkpoint-original-provider",
          load: async () => stored,
          save: async (value) => { stored = structuredClone(value); },
        },
        produce: (_revision, operation) => operation.preparedOperation
          ? client.observePrepared(operation.preparedOperation, operation.requestOptions)
          : client.runTaskDetailed("topic-ideas", { signals: [] }, operation.requestId, operation.session, operation.requestOptions),
        audit: async () => ({ output: passingAudit() }),
        validate: topicCandidate,
      });

      await assert.rejects(() => execute(firstFallback),
        (error: unknown) => error instanceof Error && /仍在处理|still running/.test(error.message));
      const interrupted = structuredClone(stored) as {
        pendingOperation: { phase: string; iteration: number; operationKey: string; generation: number; operation: Record<string, unknown> };
        operationGenerations: Record<string, number>;
        phaseAttempts: Record<string, number>;
        sessionRebuilds: Record<string, number>;
      };
      assert.equal(interrupted.pendingOperation.phase, "produce");
      assert.equal(interrupted.pendingOperation.iteration, 1);
      assert.equal(interrupted.pendingOperation.generation, 0);
      for (const field of ["requestId", "kind", "envelope", "serializedEnvelope", "binding", "brokerBinding", "route"]) {
        assert.ok(field in interrupted.pendingOperation.operation, `pending operation must persist ${field}`);
      }
      await executor.waitForCallCount(1);
      assert.equal(executor.calls.length, 1);

      executor.release(0);
      await waitForDurableState(broker.directory, undefined, "completed");
      const restartedClient = new CodexBridgeClient({ socketPath: broker.socketPath, timeoutMs: 2_000, pollIntervalMs: 10 });
      const reversedFallback = fallbackClient(restartedClient, unusedBackup, true);
      const result = await execute(reversedFallback);
      const completed = stored as {
        operationGenerations: Record<string, number>;
        phaseAttempts: Record<string, number>;
        sessionRebuilds: Record<string, number>;
        pendingOperation?: unknown;
      };

      assert.deepEqual(result.output, { ideas: [] });
      assert.equal(executor.calls.length, 1, "recovery must query the original task instead of producing again");
      assert.equal(completed.phaseAttempts.produce, interrupted.phaseAttempts.produce);
      assert.equal(completed.sessionRebuilds.produce, interrupted.sessionRebuilds.produce);
      assert.equal(completed.operationGenerations[interrupted.pendingOperation.operationKey],
        interrupted.operationGenerations[interrupted.pendingOperation.operationKey]);
      assert.equal(completed.pendingOperation, undefined);
      assert.equal(result.agentLoop?.iterations.length, 1);
    } finally {
      await broker.close();
    }
  });
});

type ObservationFault = "reset" | "timeout" | "partial-json" | "invalid-json" | "http-500" | "bare-404" | "wrong-request" | "wrong-store";

async function startAcceptedFaultFixture(fault: ObservationFault): Promise<{
  socketPath: string;
  readonly posts: number;
  readonly queries: number;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), `vf-query-matrix-${fault}-`));
  const socketPath = path.join(directory, "worker.sock");
  let posts = 0;
  let queries = 0;
  let binding: ReturnType<typeof taskBinding> | undefined;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(healthEnvelope()));
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        posts += 1;
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        binding = taskBinding({
          request: envelope,
          broker: brokerBindingFixture(),
          kind: "topic-ideas",
          contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"],
        });
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true, requestId: `fault-${fault}`, state: "running", binding }));
      });
      return;
    }
    queries += 1;
    if (fault === "reset") {
      request.socket.destroy();
      return;
    }
    if (fault === "timeout") return;
    if (fault === "partial-json") {
      response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      response.write("{\"state\":");
      response.socket?.destroy();
      return;
    }
    if (fault === "invalid-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
      return;
    }
    if (fault === "http-500") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "query layer failed" }));
      return;
    }
    if (fault === "bare-404") {
      response.writeHead(404);
      response.end();
      return;
    }
    const responseBinding = fault === "wrong-store"
      ? { ...binding!, storeId: `vfs_store_${"b".repeat(32)}` }
      : binding!;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      state: "completed_success",
      requestId: fault === "wrong-request" ? "unrelated-request" : `fault-${fault}`,
      binding: responseBinding,
      ok: true,
      output: "{\"ideas\":[]}",
      trace: {
        taskKind: "topic-ideas",
        promptVersion: "fixture",
        contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"],
        prompt: "fixture",
        providerId: "openai",
        modelId: "m",
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    get posts() { return posts; },
    get queries() { return queries; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function healthEnvelope() {
  return {
    protocolVersion: "video-factory/codex-bridge-v2" as const,
    taskBindingVersion: TASK_BINDING_VERSION,
    ...brokerBindingFixture(),
    taskKinds: ["topic-ideas"],
    taskContracts: { "topic-ideas": REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"] },
  };
}

function brokerBindingFixture() {
  return {
    version: TASK_BINDING_VERSION,
    storeId: `vfs_store_${"a".repeat(32)}`,
    providerId: "openai",
    modelId: "m",
  };
}

function fallbackClient(
  original: CodexBridgeClient,
  backup: CodexBridgeClient,
  reverse: boolean,
): FallbackCodexTaskClient {
  const primary = { client: original, providerId: "openai", modelId: "codex-default", taskKinds: ["topic-ideas"] };
  const secondary = { client: backup, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["topic-ideas"] };
  return new FallbackCodexTaskClient({ candidates: reverse ? [secondary, primary] : [primary, secondary] });
}

function topicCandidate(value: unknown): { ideas: unknown[] } {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { ideas?: unknown }).ideas)) {
    throw new Error("topic candidate invalid");
  }
  return { ideas: (value as { ideas: unknown[] }).ideas };
}

function passingAudit() {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    assessments: [{
      targetPath: "",
      dimensions: [
        { dimension: "evidence", score: 90, evidence: "结论都指向已提供材料。" },
        { dimension: "coverage", score: 90, evidence: "覆盖本轮要求的范围。" },
        { dimension: "consistency", score: 90, evidence: "评分与 findings 一致。" },
        { dimension: "actionability", score: 90, evidence: "下一步具体可执行。" },
      ],
    }],
    verdict: "pass",
    score: 90,
    summary: "通过",
    issues: [],
    repairInstructions: [],
  } as const;
}
