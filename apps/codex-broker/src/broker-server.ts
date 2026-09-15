import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODEX_BRIDGE_PROTOCOL_VERSION,
  BROKER_TASK_KINDS,
  CodexExecutorError,
  modelIdForTask,
  parseTaskRequest,
  type BrokerTaskExecutor,
  type CodexExecutorIdentity,
  type CodexTaskTrace,
  type CodexExecutionOptions,
  type CodexExecutorFailureDetails,
  type ValidatedTask,
} from "./codex-executor.js";
import { taskContractDescriptorFor } from "./task-definitions.js";
import {
  TASK_BINDING_VERSION,
  durableTaskBinding,
  expectedBrokerBinding,
  isDurableTaskBinding,
  isStoreId,
  queryBinding,
  sameTaskBinding,
  type DurableTaskBinding,
} from "./task-binding.js";

const DEFAULT_SOCKET_MODE = 0o660;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_BACKLOG = 1;
// 5 MiB JPEG 解码预算经 base64 后约 6.7 MiB；额外空间容纳固定 JSON 元数据与审片上下文。
const DEFAULT_MAX_BODY_BYTES = 9 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const STALE_PROBE_TIMEOUT_MS = 500;
const STORE_ID_FILE = ".store-id";
const OWNER_LOCK_FILE = ".owner.lock";

export type TaskOutcome =
  | { ok: true; output: string; trace?: CodexTaskTrace; sessionId?: string; sessionHandle?: string }
  | {
    ok: false;
    status: 400 | 409 | 413 | 422 | 503 | 500;
    message: string;
    failureKind?: "model_provider_transient" | "model_provider_no_output";
    failureDetails?: CodexExecutorFailureDetails;
    outcomeUncertain?: true;
  };

interface QueuedTask {
  task: ValidatedTask;
  executionOptions: CodexExecutionOptions;
  controller: AbortController;
  active: boolean;
  submittedAtMs: number;
  settle: (outcome: TaskOutcome) => void;
}

interface TaskSubmission {
  outcome: Promise<TaskOutcome>;
  cancel(): void;
}

class BrokerTaskQueue {
  private readonly pending: QueuedTask[] = [];
  private readonly closedWaiters: Array<() => void> = [];
  private activeTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;
  private closed = false;

  constructor(
    private readonly executor: BrokerTaskExecutor,
    private readonly concurrency: number,
    private readonly maxBacklog: number,
  ) {}

  queued(): number { return this.pending.length; }
  active(): number { return this.activeTasks; }
  completed(): number { return this.completedTasks; }
  failed(): number { return this.failedTasks; }

  submit(task: ValidatedTask, executionOptions: CodexExecutionOptions = {}): TaskSubmission {
    if (this.closed) return settledSubmission(shutdownOutcome());
    if (this.pending.length >= this.maxBacklog) return settledSubmission(busyOutcome());
    let entry!: QueuedTask;
    const outcome = new Promise<TaskOutcome>((settle) => {
      entry = {
        task,
        executionOptions,
        settle,
        controller: new AbortController(),
        active: false,
        submittedAtMs: Date.now(),
      };
      const insertionIndex = this.pending.findIndex((queued) => taskPriority(task) < taskPriority(queued.task));
      if (insertionIndex < 0) this.pending.push(entry);
      else this.pending.splice(insertionIndex, 0, entry);
      void this.pump();
    });
    return {
      outcome,
      cancel: () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
          entry.settle(abandonedOutcome());
          return;
        }
        if (entry.active) entry.controller.abort();
      },
    };
  }

  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.splice(0)) {
      entry.settle(shutdownOutcome());
    }
    if (this.activeTasks === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.closedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async pump(): Promise<void> {
    while (this.activeTasks < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift()!;
      next.active = true;
      this.activeTasks += 1;
      const queueWaitMs = Math.max(0, Date.now() - next.submittedAtMs);
      try {
        const result = await this.executor.runTask(next.task, {
          ...next.executionOptions,
          signal: next.controller.signal,
        });
        const expectedModelId = modelIdForTask(this.executor.identity, next.task);
        if (next.task.expectedContractDigest && result.trace?.contractDigest !== next.task.expectedContractDigest) {
          throw new CodexExecutorError("Executor returned a result for a different task contract.", false, {
            details: {
              category: "invalid_output",
              reasonCode: "contract_mismatch",
              providerId: this.executor.identity.providerId,
              modelId: expectedModelId,
            },
          });
        }
        if (!result.trace
          || result.trace.taskKind !== next.task.kind
          || result.trace.providerId !== this.executor.identity.providerId
          || result.trace.modelId !== expectedModelId) {
          throw new CodexExecutorError("Executor returned a result for a different task binding.", false, {
            details: {
              category: "invalid_output",
              reasonCode: "binding_mismatch",
              providerId: this.executor.identity.providerId,
              modelId: expectedModelId,
            },
          });
        }
        this.completedTasks += 1;
        next.settle({
          ok: true,
          output: result.output,
          ...(result.trace ? { trace: { ...result.trace, queueWaitMs } } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
      } catch (error) {
        this.failedTasks += 1;
        next.settle(failureOutcome(error, queueWaitMs));
      } finally {
        next.active = false;
        this.activeTasks -= 1;
      }
    }
    if (this.closed && this.pending.length === 0 && this.activeTasks === 0) {
      for (const waiter of this.closedWaiters.splice(0)) waiter();
    }
  }
}

export interface CodexBrokerServerOptions {
  socketPath: string;
  executor: BrokerTaskExecutor;
  concurrency?: number;
  maxBacklog?: number;
  maxBodyBytes?: number;
  shutdownTimeoutMs?: number;
  idempotencyDirectory?: string;
  sessionDirectory?: string;
  now?: () => Date;
}

export class CodexBrokerServer {
  private readonly server: http.Server;
  private readonly queue: BrokerTaskQueue;
  private readonly startedAt: string;
  private readonly concurrency: number;
  private readonly maxBodyBytes: number;
  private readonly shutdownTimeoutMs: number;
  private listening = false;
  private closePromise: Promise<void> | undefined;
  private readonly idempotentTasks = new Map<string, {
    binding: DurableTaskBinding;
    acceptance: Promise<void>;
    outcome?: Promise<TaskOutcome>;
  }>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly backgroundFailures = new Map<string, string>();
  private ownerLock: OwnerLock | undefined;
  private storeId: string | undefined;

  constructor(private readonly options: CodexBrokerServerOptions) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.queue = new BrokerTaskQueue(
      options.executor,
      this.concurrency,
      options.maxBacklog ?? DEFAULT_MAX_BACKLOG,
    );
    this.startedAt = (options.now ?? (() => new Date()))().toISOString();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    try {
      if (this.options.idempotencyDirectory) {
        this.ownerLock = await acquireOwnerLock(this.options.idempotencyDirectory);
        this.storeId = await ensureStoreId(this.options.idempotencyDirectory);
      }
      await removeStaleSocket(this.options.socketPath);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.server.once("error", onError);
        this.server.listen(this.options.socketPath, () => {
          this.server.off("error", onError);
          this.listening = true;
          resolve();
        });
      });
      // socket 权限即认证：组内进程可连接，其他人不可。
      await chmod(this.options.socketPath, DEFAULT_SOCKET_MODE);
    } catch (error) {
      await releaseOwnerLock(this.ownerLock);
      this.ownerLock = undefined;
      throw error;
    }
  }

  // 幂等：重复调用复用同一次关闭流程；未 start 直接 close 不抛错。
  async close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = this.doClose();
    }
    await this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.acceptingRequests = false;
    // 先停止接受新连接；close 回调要等连接全部结束，故先挂起、最后再收尾。
    const serverClosed = new Promise<void>((resolve) => {
      if (!this.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    // queued 立即 503；active 任务有界等待，其响应在此期间正常写出，不粗暴断连。
    await this.queue.close(this.shutdownTimeoutMs);
    const backgroundSettled = await waitForBackgroundTasks(this.backgroundTasks, this.shutdownTimeoutMs);
    // 只关闭空闲 keep-alive；活跃请求仍需把已完成/拒绝结果完整写回客户端。
    this.server.closeIdleConnections();
    await serverClosed;
    const ownerLock = this.ownerLock;
    if (backgroundSettled) {
      await releaseOwnerLock(ownerLock);
    } else {
      // deadline 只结束关闭等待，不代表 Provider 已停止。旧执行仍可能落盘时继续持有 owner，
      // 待全部后台生命周期真正结束再释放，避免新进程与旧进程同时写同一 durable store。
      void Promise.allSettled([...this.backgroundTasks]).then(() => releaseOwnerLock(ownerLock));
    }
    this.ownerLock = undefined;
  }

  private acceptingRequests = true;

  healthReport(): Record<string, unknown> {
    return {
      protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
      taskBindingVersion: TASK_BINDING_VERSION,
      ...(this.storeId ? { storeId: this.storeId } : {}),
      taskContracts: Object.fromEntries(
        BROKER_TASK_KINDS
          .filter((kind) => this.options.executor.identity.taskKinds.includes(kind))
          .map((kind) => [kind, taskContractDescriptorFor(kind).digest]),
      ),
      ...this.options.executor.identity,
      active: this.queue.active(),
      queued: this.queue.queued(),
      capacity: this.concurrency,
      completed: this.queue.completed(),
      failed: this.queue.failed(),
      startedAt: this.startedAt,
    };
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = request.url ?? "";
    try {
      if (!this.acceptingRequests) {
        this.sendJson(response, 503, { error: "Codex broker is shutting down." }, DEFAULT_RETRY_AFTER_SECONDS);
        return;
      }
      if (url === "/health" && request.method === "GET") {
        this.sendJson(response, 200, this.healthReport());
        return;
      }
      if (url === "/v1/tasks" && request.method === "POST") {
        await this.handleTask(request, response);
        return;
      }
      if (url.startsWith("/v1/tasks/") && request.method === "GET") {
        await this.handleTaskQuery(request, response, url.slice("/v1/tasks/".length));
        return;
      }
      if (url === "/health" || url === "/v1/tasks" || url.startsWith("/v1/tasks/")) {
        this.sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      this.sendJson(response, 404, { error: "Not found." });
    } catch {
      this.sendJson(response, 500, { error: "Internal broker error." });
    }
  }

  private async handleTask(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    if (body === undefined) {
      this.sendJson(response, 413, { error: `Request body exceeds ${this.maxBodyBytes} bytes.` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(response, 400, { error: "Request body is not valid JSON." });
      return;
    }
    let task: ValidatedTask;
    let session: TaskSessionRequest | undefined;
    try {
      task = parseTaskRequest(parsed, this.options.executor.identity);
      session = taskSessionRequest(parsed);
    } catch (error) {
      const failureDetails = error instanceof CodexExecutorError
        ? rejectedRequestFailureDetails(error, parsed, this.options.executor.identity)
        : undefined;
      this.sendJson(response, 400, {
        error: failureDetails?.fieldPath
          ? `Request field '${failureDetails.fieldPath}' does not satisfy the broker input contract.`
          : "Request does not satisfy the broker input contract.",
        ...(failureDetails ? { failureDetails } : {}),
        failureKind: "contract_rejected",
      });
      return;
    }
    const requestId = taskRequestId(parsed);
    if (!requestId) {
      this.sendJson(response, 400, { error: "Codex task requestId is required." });
      return;
    }
    const digestSubject = {
      identity: this.options.executor.identity,
      task,
    };
    const digest = createHash("sha256").update(JSON.stringify({
      ...digestSubject,
      session,
    })).digest("hex");

    // durable 模式（生产配置）：accept/poll。POST 只在 durable acceptance 落定后返回
    // 202/冲突；查询端点只读取同一 durable record，不提交 executor、不切 backup。
    if (this.options.idempotencyDirectory) {
      if (!this.storeId) throw new Error("Codex broker durable store identity is unavailable.");
      let requestedBinding;
      try {
        requestedBinding = expectedBrokerBinding(parsed);
      } catch (error) {
        this.sendJson(response, 400, { error: error instanceof Error ? error.message : "Codex broker binding is invalid.", failureKind: "contract_rejected" });
        return;
      }
      const modelId = modelIdForTask(this.options.executor.identity, task);
      const actualBrokerBinding = {
        version: TASK_BINDING_VERSION,
        storeId: this.storeId,
        providerId: this.options.executor.identity.providerId,
        modelId,
      } as const;
      if (requestedBinding && JSON.stringify(requestedBinding) !== JSON.stringify(actualBrokerBinding)) {
        this.sendJson(response, 409, {
          error: "Codex request expected a different broker identity.",
          failureKind: "binding_conflict",
        });
        return;
      }
      const binding = durableTaskBinding({
        request: parsed,
        ...actualBrokerBinding,
        kind: task.kind,
        ...(task.expectedContractDigest ? { contractDigest: task.expectedContractDigest } : {}),
        ...(session ? { session } : {}),
      });
      const durable = await this.lookupDurable(requestId, binding, digest);
      if (durable.kind === "conflict") {
        this.sendBindingConflict(response);
        return;
      }
      if (durable.kind === "completed") {
        if (durable.record.state !== "completed") throw new Error("unreachable durable replay state");
        const materialized = await this.materializeSessionRecord("sessionRecord" in durable.record
          ? durable.record.sessionRecord
          : undefined);
        void materialized;
        this.sendCompletedEnvelope(response, requestId, durable.binding, durable.record.outcome);
        return;
      }
      if (durable.kind === "running") {
        this.sendTaskFact(response, 202, requestId, "running", durable.binding);
        return;
      }
      if (durable.kind === "accepted_unknown") {
        this.sendTaskFact(response, 202, requestId, "accepted_unknown", durable.binding);
        return;
      }
      if (durable.kind === "not_accepted") {
        this.sendTaskFact(response, durable.outcome && !durable.outcome.ok ? durable.outcome.status : 409,
          requestId, "not_accepted", durable.binding, undefined, undefined, durable.outcome);
        return;
      }
      let sessionId: string | undefined;
      try {
        sessionId = await this.resolveSessionId(task.kind, session);
      } catch (error) {
        const message = error instanceof CodexExecutorError ? error.message : "Invalid codex task session.";
        this.sendJson(response, 409, { error: message });
        return;
      }
      try {
        const accepted = await this.acceptDurableTask(requestId, digest, binding, task, session, sessionId);
        if (accepted === "conflict") {
          this.sendBindingConflict(response);
          return;
        }
      } catch (error) {
        this.sendJson(response, 500, { error: "Codex broker could not commit the accepted task result; retry the same requestId." });
        return;
      }
      const active = this.idempotentTasks.get(requestId);
      this.sendTaskFact(response, 202, requestId, active ? "running" : "accepted_unknown", binding);
      return;
    }

    // 非 durable 模式（测试/降级配置）：保留长轮询语义，断连取消队列任务。
    let sessionId: string | undefined;
    try {
      sessionId = await this.resolveSessionId(task.kind, session);
    } catch (error) {
      const message = error instanceof CodexExecutorError ? error.message : "Invalid codex task session.";
      this.sendJson(response, 409, { error: message });
      return;
    }
    let outcome: TaskOutcome;
    try {
      outcome = await this.withSessionLock(session, async () => {
        const submission = this.queue.submit(task, {
          ...(sessionId ? { sessionId } : {}),
          persistSession: session !== undefined,
        });
        const cancelIfDisconnected = (): void => {
          if (!response.writableEnded) submission.cancel();
        };
        response.once("close", cancelIfDisconnected);
        const executed = await submission.outcome;
        response.off("close", cancelIfDisconnected);
        return this.finalizeSession(task.kind, session, sessionId, executed);
      });
    } catch {
      this.sendJson(response, 500, { error: "Codex broker could not commit the accepted task result; retry the same requestId." });
      return;
    }
    this.sendOutcome(response, outcome);
  }

  // 只读查询：仅消费 durable record，不提交 executor、不改变任务事实。
  private async handleTaskQuery(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    rawRequestId: string,
  ): Promise<void> {
    const requestId = decodeURIComponent(rawRequestId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      this.sendJson(response, 400, { error: "Codex task requestId is invalid." });
      return;
    }
    if (!this.options.idempotencyDirectory) {
      this.sendJson(response, 409, { error: "Codex broker durable task records are not enabled.", failureKind: "binding_conflict" });
      return;
    }
    let expected: DurableTaskBinding | undefined;
    try {
      expected = queryBinding(request.headers);
    } catch (error) {
      this.sendJson(response, 400, { error: error instanceof Error ? error.message : "Codex task query binding is invalid.", failureKind: "contract_rejected" });
      return;
    }
    if (!expected) {
      this.sendJson(response, 400, { error: "Codex task query requires the original immutable binding.", failureKind: "contract_rejected" });
      return;
    }
    if (expected.storeId !== this.storeId) {
      this.sendBindingConflict(response);
      return;
    }
    const active = this.idempotentTasks.get(requestId);
    if (active) {
      await active.acceptance.catch(() => undefined);
    }
    const record = await readIdempotencyRecord(this.durableRecordPath(requestId));
    if (!record || record.requestId !== requestId) {
      this.sendJson(response, 404, { error: `No verifiable durable record for Codex requestId '${requestId}'.`, failureKind: "query_unverifiable" });
      return;
    }
    if (record.version !== 3 || !sameTaskBinding(record.binding, expected)) {
      if (record.version !== 3) {
        this.sendJson(response, 200, { requestId, state: "accepted_unknown", legacyRecord: true });
      } else {
        this.sendBindingConflict(response);
      }
      return;
    }
    if (record.state === "not_accepted") {
      this.sendTaskFact(response, 200, requestId, "not_accepted", record.binding, undefined, undefined, record.outcome);
      return;
    }
    if (record.state === "accepted") {
      const state = !record.uncertainty && this.idempotentTasks.has(requestId) ? "running" : "accepted_unknown";
      this.sendTaskFact(response, 200, requestId, state, record.binding, this.backgroundFailures.get(requestId), record.uncertainty);
      return;
    }
    // completed 用 200 信封返回原始 outcome：查询永远不把任务事实伪装成查询层 HTTP 错误。
    try {
      await this.materializeSessionRecord(record.sessionRecord);
      this.backgroundFailures.delete(requestId);
    } catch {
      this.backgroundFailures.set(requestId, "session_registry_persistence_failed");
    }
    this.sendCompletedEnvelope(response, requestId, record.binding, record.outcome, this.backgroundFailures.get(requestId));
  }

  private durableRecordPath(requestId: string): string {
    return path.join(
      this.options.idempotencyDirectory!,
      `${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
  }

  private async lookupDurable(
    requestId: string,
    binding: DurableTaskBinding,
    legacyDigest: string,
  ): Promise<{ kind: "conflict" } | { kind: "running" | "accepted_unknown" | "not_accepted"; binding: DurableTaskBinding; outcome?: TaskOutcome } | { kind: "completed"; record: CompletedIdempotencyRecord; binding: DurableTaskBinding } | { kind: "absent" }> {
    if (!this.options.idempotencyDirectory) return { kind: "absent" };
    const record = await readIdempotencyRecord(this.durableRecordPath(requestId));
    if (!record) return { kind: "absent" };
    if (record.requestId !== requestId) return { kind: "conflict" };
    if (record.version !== 3) {
      if (record.digest !== legacyDigest || record.state !== "completed") return { kind: "conflict" };
      const trace = record.outcome.ok ? record.outcome.trace : undefined;
      if (!trace || trace.providerId !== binding.providerId || trace.modelId !== binding.modelId) return { kind: "conflict" };
      return { kind: "completed", record: { ...record, version: 3, binding }, binding };
    }
    if (!sameTaskBinding(record.binding, binding)) return { kind: "conflict" };
    if (record.state === "completed") return { kind: "completed", record, binding: record.binding };
    if (record.state === "not_accepted") return { kind: "not_accepted", binding: record.binding, outcome: record.outcome };
    return {
      kind: this.idempotentTasks.has(requestId) ? "running" : "accepted_unknown",
      binding: record.binding,
    };
  }

  // durable 受理（两段式，BR-01）：先等待 accepted record 落盘成功，才允许返回 202；
  // 之后执行在后台继续，完成/不确定/503 各按原语义落盘。
  private async acceptDurableTask(
    requestId: string,
    digest: string,
    binding: DurableTaskBinding,
    task: ValidatedTask,
    session: TaskSessionRequest | undefined,
    sessionId: string | undefined,
  ): Promise<"accepted" | "conflict"> {
    const active = this.idempotentTasks.get(requestId);
    if (active) {
      if (!sameTaskBinding(active.binding, binding)) return "conflict";
      await active.acceptance;
      return "accepted";
    }
    let entry!: {
      binding: DurableTaskBinding;
      acceptance: Promise<void>;
      outcome?: Promise<TaskOutcome>;
    };
    const acceptance = (async () => {
      await mkdir(this.options.idempotencyDirectory!, { recursive: true });
      const recordPath = this.durableRecordPath(requestId);
      const previous = await readIdempotencyRecord(recordPath);
      if (previous) {
        if (previous.version !== 3 || !sameTaskBinding(previous.binding, binding)) throw new BindingConflictError();
        return;
      }
      await writeIdempotencyRecord(recordPath, { version: 3, requestId, digest, binding, state: "accepted" });
      const outcome = this.withSessionLock(session, () =>
        this.executeDurableTask(recordPath, requestId, digest, binding, task, session, sessionId));
      entry.outcome = outcome;
      this.trackBackgroundTask(requestId, outcome);
    })();
    entry = { binding, acceptance };
    this.idempotentTasks.set(requestId, entry);
    try {
      await acceptance;
    } catch (error) {
      const current = this.idempotentTasks.get(requestId);
      if (current === entry) this.idempotentTasks.delete(requestId);
      if (error instanceof BindingConflictError) return "conflict";
      throw error;
    }
    return "accepted";
  }

  // 后台执行：只被 acceptDurableTask 在 accepted record 落盘之后调度。
  private async executeDurableTask(
    recordPath: string,
    requestId: string,
    digest: string,
    binding: DurableTaskBinding,
    task: ValidatedTask,
    session: TaskSessionRequest | undefined,
    sessionId: string | undefined,
  ): Promise<TaskOutcome> {
    const outcome = await this.queue.submit(task, {
      ...(sessionId ? { sessionId } : {}),
      persistSession: session !== undefined,
    }).outcome;
    if (!outcome.ok && outcome.status === 503) {
      // 队列拒绝＝从未进入 Provider；保留带绑定的终结证据，封住原物理 ID。
      await writeIdempotencyRecord(recordPath, { version: 3, requestId, digest, binding, state: "not_accepted", outcome });
      return outcome;
    }
    if (!outcome.ok && outcome.outcomeUncertain) {
      // 本地执行结束不等于远端失败；保存诊断供原身份查询，绝不写 completed 或解锁重投。
      await writeIdempotencyRecord(recordPath, {
        version: 3, requestId, digest, binding, state: "accepted",
        uncertainty: {
          localExecutionEndedAt: new Date().toISOString(),
          ...(outcome.failureDetails ? { failureDetails: outcome.failureDetails } : {}),
        },
      });
      return outcome;
    }
    const completion = this.prepareSessionCompletion(task.kind, session, sessionId, outcome);
    await writeIdempotencyRecord(recordPath, {
      version: 3,
      requestId,
      digest,
      binding,
      state: "completed",
      outcome: completion.outcome,
      ...(completion.sessionRecord ? { sessionRecord: completion.sessionRecord } : {}),
    });
    try {
      await this.materializeSessionRecord(completion.sessionRecord);
    } catch {
      // session registry 是可再生索引；权威 completed record 已落盘，不得因索引失败抹掉结果。
      this.backgroundFailures.set(requestId, "session_registry_persistence_failed");
    }
    return completion.outcome;
  }

  private trackBackgroundTask(requestId: string, outcome: Promise<TaskOutcome>): void {
    const tracked = outcome.then(
      () => undefined,
      () => {
        // 后台落盘失败只能改变“观察是否可用”，不能伪造任务终态，也不能让进程因 unhandled rejection 退出。
        this.backgroundFailures.set(requestId, "completion_persistence_failed");
      },
    );
    this.backgroundTasks.add(tracked);
    void tracked.then(() => {
      this.backgroundTasks.delete(tracked);
      const current = this.idempotentTasks.get(requestId);
      if (current?.outcome === outcome) this.idempotentTasks.delete(requestId);
    });
  }

  private sendBindingConflict(response: http.ServerResponse): void {
    this.sendJson(response, 409, {
      error: "Codex requestId is already bound to different task data.",
      failureKind: "binding_conflict",
    });
  }

  private sendTaskFact(
    response: http.ServerResponse,
    status: number,
    requestId: string,
    state: "running" | "accepted_unknown" | "not_accepted",
    binding: DurableTaskBinding,
    observationError?: string,
    uncertainty?: { localExecutionEndedAt: string; failureDetails?: CodexExecutorFailureDetails },
    rejectedOutcome?: TaskOutcome,
  ): void {
    this.sendJson(response, status, {
      accepted: state !== "not_accepted",
      requestId,
      state,
      binding,
      ...(observationError ? { observationError } : {}),
      ...(uncertainty ? { localExecutionEndedAt: uncertainty.localExecutionEndedAt, failureDetails: uncertainty.failureDetails } : {}),
      ...(rejectedOutcome && !rejectedOutcome.ok ? {
        status: rejectedOutcome.status, error: rejectedOutcome.message,
        failureKind: rejectedOutcome.failureKind, failureDetails: rejectedOutcome.failureDetails,
      } : {}),
    });
  }

  private sendCompletedEnvelope(
    response: http.ServerResponse,
    requestId: string,
    binding: DurableTaskBinding,
    outcome: TaskOutcome,
    observationError?: string,
  ): void {
    this.sendJson(response, 200, {
      state: outcome.ok ? "completed_success" : "completed_failure",
      requestId,
      binding,
      ok: outcome.ok,
      ...(outcome.ok ? {
        output: outcome.output,
        ...(outcome.trace ? { trace: outcome.trace } : {}),
        ...(outcome.sessionHandle ? { sessionHandle: outcome.sessionHandle } : {}),
      } : {
        outcome: {
          ok: false,
          status: outcome.status,
          message: outcome.message,
          ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
          ...(outcome.failureDetails ? { failureDetails: outcome.failureDetails } : {}),
          ...(outcome.outcomeUncertain ? { outcomeUncertain: true } : {}),
        },
      }),
      ...(observationError ? { observationError } : {}),
    });
  }

  private sendOutcome(response: http.ServerResponse, outcome: TaskOutcome): void {
    if (outcome.ok) {
      this.sendJson(response, 200, {
        ok: true,
        output: outcome.output,
        ...(outcome.trace ? { trace: outcome.trace } : {}),
        ...(outcome.sessionHandle ? { sessionHandle: outcome.sessionHandle } : {}),
      });
      return;
    }
    this.sendJson(
      response,
      outcome.status,
      {
        error: outcome.message,
        ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
        ...(outcome.failureDetails ? { failureDetails: outcome.failureDetails } : {}),
        ...(outcome.outcomeUncertain ? { outcomeUncertain: true } : {}),
      },
      outcome.status === 503 ? DEFAULT_RETRY_AFTER_SECONDS : undefined,
    );
  }

  private async resolveSessionId(kind: ValidatedTask["kind"], session: TaskSessionRequest | undefined): Promise<string | undefined> {
    if (!session) return undefined;
    if (!this.options.sessionDirectory) {
      throw new CodexExecutorError("Codex role sessions are not enabled on this broker.", false);
    }
    if (!session.handle) return undefined;
    const record = await readSessionRecord(sessionRecordPath(this.options.sessionDirectory, session.handle));
    if (!record
      || record.handle !== session.handle
      || record.key !== session.key
      || record.taskKind !== kind) {
      throw new CodexExecutorError("Codex role session is unknown or belongs to a different production role.", false);
    }
    return record.threadId;
  }

  private async finalizeSession(
    kind: ValidatedTask["kind"],
    session: TaskSessionRequest | undefined,
    expectedSessionId: string | undefined,
    outcome: TaskOutcome,
  ): Promise<TaskOutcome> {
    const completion = this.prepareSessionCompletion(kind, session, expectedSessionId, outcome);
    await this.materializeSessionRecord(completion.sessionRecord);
    return completion.outcome;
  }

  private prepareSessionCompletion(
    kind: ValidatedTask["kind"],
    session: TaskSessionRequest | undefined,
    expectedSessionId: string | undefined,
    outcome: TaskOutcome,
  ): { outcome: TaskOutcome; sessionRecord?: SessionRecord } {
    if (!outcome.ok || !session) return { outcome };
    if (!this.options.sessionDirectory) {
      return { outcome: { ok: false, status: 500, message: "Codex role session registry is unavailable." } };
    }
    if (!outcome.sessionId || !isCodexThreadId(outcome.sessionId)) {
      return {
        outcome: {
          ok: false,
          status: 422,
          message: "Codex role session was not created; the task result was not accepted.",
          ...(outcome.trace ? {
            failureDetails: failureDetailsFromTrace(outcome.trace, "session_not_created"),
          } : {}),
        },
      };
    }
    if (expectedSessionId && outcome.sessionId !== expectedSessionId) {
      return {
        outcome: {
          ok: false,
          status: 422,
          message: "Codex resumed a different role session; the task result was rejected.",
          ...(outcome.trace ? {
            failureDetails: failureDetailsFromTrace(outcome.trace, "session_mismatch"),
          } : {}),
        },
      };
    }
    const handle = session.handle ?? `vfs_${randomBytes(24).toString("base64url")}`;
    const sessionRecord: SessionRecord = {
      version: 1,
      handle,
      key: session.key,
      taskKind: kind,
      threadId: outcome.sessionId,
    };
    const { sessionId: _sessionId, ...publicOutcome } = outcome;
    return { outcome: { ...publicOutcome, sessionHandle: handle }, sessionRecord };
  }

  private async materializeSessionRecord(record: SessionRecord | undefined): Promise<void> {
    if (!record) return;
    if (!this.options.sessionDirectory) throw new Error("Codex role session registry is unavailable.");
    await mkdir(this.options.sessionDirectory, { recursive: true });
    await writeSessionRecord(sessionRecordPath(this.options.sessionDirectory, record.handle), record);
  }

  private async withSessionLock<T>(session: TaskSessionRequest | undefined, action: () => Promise<T>): Promise<T> {
    if (!session) return action();
    const lockKey = session.handle ?? `key:${session.key}`;
    const previous = this.sessionTails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionTails.set(lockKey, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.sessionTails.get(lockKey) === tail) this.sessionTails.delete(lockKey);
    }
  }

  // 超限时丢弃式排干剩余字节，保证客户端总能收到 413 而不是连接重置。
  private readBody(request: http.IncomingMessage): Promise<string | undefined> {
    const declared = contentLength(request.headers["content-length"]);
    if (declared !== undefined && declared > this.maxBodyBytes) {
      request.resume();
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let overflow = false;
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.maxBodyBytes) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(overflow ? undefined : Buffer.concat(chunks).toString("utf8")));
      request.on("error", () => resolve(""));
    });
  }

  private sendJson(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    retryAfterSeconds?: number,
  ): void {
    if (response.headersSent || response.destroyed) return;
    const serialized = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(serialized)),
      ...(retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {}),
    });
    response.end(serialized);
  }
}

function rejectedRequestFailureDetails(
  error: CodexExecutorError,
  request: unknown,
  identity: CodexExecutorIdentity,
): CodexExecutorFailureDetails {
  const record = typeof request === "object" && request !== null && !Array.isArray(request)
    ? request as Record<string, unknown>
    : {};
  const taskKind = typeof record.kind === "string" && (BROKER_TASK_KINDS as readonly string[]).includes(record.kind)
    ? record.kind as CodexExecutorFailureDetails["taskKind"]
    : undefined;
  const requestId = typeof record.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.requestId)
    ? record.requestId
    : undefined;
  const fieldPath = /\b((?:request|payload)(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d+\])+)/.exec(error.message)?.[1];
  return {
    category: error.details?.category ?? "invalid_request",
    reasonCode: error.details?.reasonCode ?? "input_contract",
    providerId: error.details?.providerId ?? identity.providerId,
    modelId: error.details?.modelId
      ?? (taskKind ? identity.taskModels?.[taskKind] : undefined)
      ?? identity.modelId
      ?? "unknown",
    ...(requestId ? { requestIdHash: createHash("sha256").update(requestId).digest("hex") } : {}),
    ...(taskKind ? { taskKind } : {}),
    ...(fieldPath ? { fieldPath } : {}),
    accepted: false,
  };
}

type IdempotencyRecord =
  | { version: 1; requestId: string; digest: string; state: "accepted" }
  | { version: 1; requestId: string; digest: string; state: "completed"; outcome: TaskOutcome }
  | { version: 2; requestId: string; digest: string; state: "completed"; outcome: TaskOutcome; sessionRecord?: SessionRecord }
  | { version: 3; requestId: string; digest: string; binding: DurableTaskBinding; state: "accepted"; uncertainty?: { localExecutionEndedAt: string; failureDetails?: CodexExecutorFailureDetails } }
  | { version: 3; requestId: string; digest: string; binding: DurableTaskBinding; state: "not_accepted"; outcome: TaskOutcome }
  | { version: 3; requestId: string; digest: string; binding: DurableTaskBinding; state: "completed"; outcome: TaskOutcome; sessionRecord?: SessionRecord };

type CompletedIdempotencyRecord = Extract<IdempotencyRecord, { state: "completed" }>;

class BindingConflictError extends Error {}

interface TaskSessionRequest {
  key: string;
  handle?: string;
}

interface SessionRecord {
  version: 1;
  handle: string;
  key: string;
  taskKind: ValidatedTask["kind"];
  threadId: string;
}

function taskRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)
    ? requestId
    : undefined;
}

function taskSessionRequest(value: unknown): TaskSessionRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as { sessionKey?: unknown; sessionHandle?: unknown };
  if (record.sessionKey === undefined && record.sessionHandle === undefined) return undefined;
  if (typeof record.sessionKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.sessionKey)) {
    throw new CodexExecutorError("Codex task sessionKey is invalid.", false);
  }
  if (record.sessionHandle !== undefined
    && (typeof record.sessionHandle !== "string" || !isOpaqueSessionHandle(record.sessionHandle))) {
    throw new CodexExecutorError("Codex task sessionHandle is invalid.", false);
  }
  return {
    key: record.sessionKey,
    ...(typeof record.sessionHandle === "string" ? { handle: record.sessionHandle } : {}),
  };
}

async function readIdempotencyRecord(recordPath: string): Promise<IdempotencyRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    if ((value.version !== 1 && value.version !== 2 && value.version !== 3)
      || typeof value.requestId !== "string" || typeof value.digest !== "string") {
      throw new Error("Codex idempotency record is invalid.");
    }
    if (value.state === "accepted" && value.version === 1) return value as Extract<IdempotencyRecord, { state: "accepted" }>;
    if (value.version === 3 && isDurableTaskBinding(value.binding)) {
      if (value.state === "accepted") return value as Extract<IdempotencyRecord, { version: 3; state: "accepted" }>;
      if (value.state === "not_accepted" && value.outcome && typeof value.outcome === "object") {
        return value as Extract<IdempotencyRecord, { version: 3; state: "not_accepted" }>;
      }
      if (value.state === "completed" && value.outcome && typeof value.outcome === "object"
        && (value.sessionRecord === undefined || isSessionRecord(value.sessionRecord))) {
        return value as Extract<IdempotencyRecord, { version: 3; state: "completed" }>;
      }
    }
    if (value.state === "completed" && value.outcome && typeof value.outcome === "object"
      && (value.sessionRecord === undefined || isSessionRecord(value.sessionRecord))) {
      return value as Extract<IdempotencyRecord, { state: "completed" }>;
    }
    throw new Error("Codex idempotency record is invalid.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeIdempotencyRecord(recordPath: string, record: IdempotencyRecord): Promise<void> {
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function sessionRecordPath(directory: string, handle: string): string {
  return path.join(directory, `${createHash("sha256").update(handle).digest("hex")}.json`);
}

async function readSessionRecord(recordPath: string): Promise<SessionRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(recordPath, "utf8")) as Partial<SessionRecord>;
    if (value.version !== 1
      || typeof value.handle !== "string" || !isOpaqueSessionHandle(value.handle)
      || typeof value.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.key)
      || typeof value.taskKind !== "string" || !(BROKER_TASK_KINDS as readonly string[]).includes(value.taskKind)
      || typeof value.threadId !== "string" || !isCodexThreadId(value.threadId)) {
      throw new Error("Codex role session record is invalid.");
    }
    return value as SessionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isOpaqueSessionHandle(value: string): boolean {
  return /^vfs_[A-Za-z0-9_-]{32}$/.test(value);
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<SessionRecord>;
  return record.version === 1
    && typeof record.handle === "string" && isOpaqueSessionHandle(record.handle)
    && typeof record.key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.key)
    && typeof record.taskKind === "string" && (BROKER_TASK_KINDS as readonly string[]).includes(record.taskKind)
    && typeof record.threadId === "string" && isCodexThreadId(record.threadId);
}

async function writeSessionRecord(recordPath: string, record: SessionRecord): Promise<void> {
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function failureOutcome(error: unknown, queueWaitMs: number): TaskOutcome {
  if (error instanceof CodexExecutorError) {
    const failureKind = error.failureKind ?? (error.transient ? "model_provider_transient" as const : undefined);
    // 任务已受理后的失败（含执行超时）一律 422：客户端不重放，任务至多执行一次。
    return {
      ok: false,
      status: error.outcomeUncertain ? 500 : 422,
      message: publicExecutorMessage(error.message, error.transient),
      ...(failureKind ? { failureKind } : {}),
      ...(error.details ? { failureDetails: { ...error.details, queueWaitMs } } : {}),
      ...(error.outcomeUncertain ? { outcomeUncertain: true } : {}),
    };
  }
  return { ok: false, status: 500, message: "The model service could not complete this step." };
}

function failureDetailsFromTrace(
  trace: CodexTaskTrace,
  reasonCode: "session_not_created" | "session_mismatch",
): CodexExecutorFailureDetails {
  return {
    category: "invalid_output",
    reasonCode,
    providerId: trace.providerId,
    modelId: trace.modelId,
    ...(trace.providerWaitMs !== undefined ? { providerWaitMs: trace.providerWaitMs } : {}),
  };
}

function publicExecutorMessage(message: string, transient = false): string {
  if (/timed out after \d+ms\./.test(message)) return "the model timed out.";
  if (transient) return "the model service is temporarily unavailable.";
  if (message === "Codex output is not valid JSON.") return "the model returned invalid JSON.";
  if (message === "Codex produced an empty output.") return "the model returned an empty result.";
  if (message.startsWith("Codex output does not match ")) return "the model result did not satisfy its output contract.";
  if (message.startsWith("Codex output exceeds ")) return "the model result exceeded the configured size limit.";
  if (message === "Codex finished without writing an output file.") return "the model did not return a result.";
  if (message.startsWith("Codex prompt exceeds ")) return "the task context exceeded the configured size limit.";
  if (message.startsWith("Codex task kind ")) return "the requested role is unavailable on this model profile.";
  return "The model could not complete this step.";
}

function busyOutcome(): TaskOutcome {
  return { ok: false, status: 503, message: "Codex broker backlog is full." };
}

function shutdownOutcome(): TaskOutcome {
  return { ok: false, status: 503, message: "Codex broker is shutting down." };
}

function abandonedOutcome(): TaskOutcome {
  return { ok: false, status: 503, message: "Codex task was cancelled before execution." };
}

function settledSubmission(outcome: TaskOutcome): TaskSubmission {
  return { outcome: Promise.resolve(outcome), cancel: () => undefined };
}

function taskPriority(task: ValidatedTask): number {
  return task.kind === "topic-ideas" ? 1 : 0;
}

function contentLength(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// 只清理"确认为 socket 且无人监听"的残留文件；普通文件与活跃 broker 一律拒绝触碰。
async function removeStaleSocket(socketPath: string): Promise<void> {
  let isSocket = false;
  try {
    isSocket = (await stat(socketPath)).isSocket();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  if (!isSocket) {
    throw new Error(`Refusing to touch '${socketPath}': it is not a Unix socket.`);
  }
  if (await isSocketReachable(socketPath)) {
    throw new Error(`Another codex broker is already listening on '${socketPath}'.`);
  }
  await unlink(socketPath);
}

function isSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request(
      { socketPath, path: "/health", method: "GET", timeout: STALE_PROBE_TIMEOUT_MS },
      (response) => {
        response.resume();
        response.on("end", () => settle(true));
        response.on("error", () => settle(true));
      },
    );
    request.on("timeout", () => {
      // 有监听但响应慢：保守视为活跃，避免误杀。
      request.destroy();
      settle(true);
    });
    request.on("error", () => settle(false));
    request.end();
  });
}

interface OwnerLock {
  path: string;
  token: string;
}

async function acquireOwnerLock(directory: string): Promise<OwnerLock> {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, OWNER_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      await writeFile(lockPath, `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { path: lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwnerLock(lockPath);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error(`Codex durable store '${directory}' already has an active or unverifiable owner.`);
      }
      // 只有锁记录可解析且 PID 已确认退出时，才回收崩溃遗留锁。
      await unlink(lockPath);
    }
  }
  throw new Error(`Codex durable store '${directory}' owner lock could not be acquired.`);
}

async function readOwnerLock(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
      || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/i.test(value.token)) return undefined;
    return { pid: Number(value.pid), token: value.token };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function releaseOwnerLock(lock: OwnerLock | undefined): Promise<void> {
  if (!lock) return;
  const owner = await readOwnerLock(lock.path);
  if (owner?.token === lock.token) await unlink(lock.path).catch(() => undefined);
}

async function ensureStoreId(directory: string): Promise<string> {
  const storePath = path.join(directory, STORE_ID_FILE);
  try {
    const existing = (await readFile(storePath, "utf8")).trim();
    if (!isStoreId(existing)) throw new Error(`Codex durable store '${directory}' has an invalid store id.`);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const storeId = `vfs_store_${randomBytes(16).toString("hex")}`;
  await writeFile(storePath, `${storeId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return storeId;
}

async function waitForBackgroundTasks(tasks: Set<Promise<void>>, timeoutMs: number): Promise<boolean> {
  if (tasks.size === 0) return true;
  return Promise.race([
    Promise.allSettled([...tasks]).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
