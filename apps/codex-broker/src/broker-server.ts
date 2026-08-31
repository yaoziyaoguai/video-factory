import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODEX_BRIDGE_PROTOCOL_VERSION,
  BROKER_TASK_KINDS,
  CodexExecutorError,
  parseTaskRequest,
  type BrokerTaskExecutor,
  type CodexTaskTrace,
  type CodexExecutionOptions,
  type ValidatedTask,
} from "./codex-executor.js";

const DEFAULT_SOCKET_MODE = 0o660;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_BACKLOG = 20;
// 5 MiB JPEG 解码预算经 base64 后约 6.7 MiB；额外空间容纳固定 JSON 元数据与审片上下文。
const DEFAULT_MAX_BODY_BYTES = 9 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const STALE_PROBE_TIMEOUT_MS = 500;

export type TaskOutcome =
  | { ok: true; output: string; trace?: CodexTaskTrace; sessionId?: string; sessionHandle?: string }
  | { ok: false; status: 400 | 409 | 413 | 422 | 503 | 500; message: string };

interface QueuedTask {
  task: ValidatedTask;
  executionOptions: CodexExecutionOptions;
  controller: AbortController;
  active: boolean;
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
      entry = { task, executionOptions, settle, controller: new AbortController(), active: false };
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
      try {
        const result = await this.executor.runTask(next.task, {
          ...next.executionOptions,
          signal: next.controller.signal,
        });
        this.completedTasks += 1;
        next.settle({
          ok: true,
          output: result.output,
          ...(result.trace ? { trace: result.trace } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
      } catch (error) {
        this.failedTasks += 1;
        next.settle(failureOutcome(error));
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
  private readonly idempotentTasks = new Map<string, { digest: string; outcome: Promise<TaskOutcome> }>();
  private readonly sessionTails = new Map<string, Promise<void>>();

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
    // 只关闭空闲 keep-alive；活跃请求仍需把已完成/拒绝结果完整写回客户端。
    this.server.closeIdleConnections();
    await serverClosed;
  }

  private acceptingRequests = true;

  healthReport(): Record<string, unknown> {
    return {
      protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
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
      if (url === "/health" || url === "/v1/tasks") {
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
      const message = error instanceof CodexExecutorError ? error.message : "Invalid codex task request.";
      this.sendJson(response, 400, { error: message });
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
      if (this.options.idempotencyDirectory) {
        outcome = await this.submitIdempotent(requestId, digest, task, session, sessionId);
      } else {
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
      }
    } catch {
      this.sendJson(response, 500, { error: "Codex broker could not commit the accepted task result; retry the same requestId." });
      return;
    }
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
      { error: outcome.message },
      outcome.status === 503 ? DEFAULT_RETRY_AFTER_SECONDS : undefined,
    );
  }

  private submitIdempotent(
    requestId: string,
    digest: string,
    task: ValidatedTask,
    session: TaskSessionRequest | undefined,
    sessionId: string | undefined,
  ): Promise<TaskOutcome> {
    const active = this.idempotentTasks.get(requestId);
    if (active) {
      return active.digest === digest
        ? active.outcome
        : Promise.resolve({ ok: false, status: 409, message: "Codex requestId is already bound to different task data." });
    }
    const outcome = this.withSessionLock(session, () => this.runIdempotent(requestId, digest, task, session, sessionId)).finally(() => {
      const current = this.idempotentTasks.get(requestId);
      if (current?.outcome === outcome) this.idempotentTasks.delete(requestId);
    });
    this.idempotentTasks.set(requestId, { digest, outcome });
    return outcome;
  }

  private async runIdempotent(
    requestId: string,
    digest: string,
    task: ValidatedTask,
    session: TaskSessionRequest | undefined,
    sessionId: string | undefined,
  ): Promise<TaskOutcome> {
    if (!this.options.idempotencyDirectory) {
      return this.finalizeSession(
        task.kind,
        session,
        sessionId,
        await this.queue.submit(task, {
          ...(sessionId ? { sessionId } : {}),
          persistSession: session !== undefined,
        }).outcome,
      );
    }
    await mkdir(this.options.idempotencyDirectory, { recursive: true });
    const recordPath = path.join(
      this.options.idempotencyDirectory,
      `${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
    const previous = await readIdempotencyRecord(recordPath);
    if (previous) {
      if (previous.requestId !== requestId || previous.digest !== digest) {
        return { ok: false, status: 409, message: "Codex requestId is already bound to different task data." };
      }
      if (previous.state === "completed") {
        await this.materializeSessionRecord("sessionRecord" in previous ? previous.sessionRecord : undefined);
        return previous.outcome;
      }
      return {
        ok: false,
        status: 409,
        message: "A previously accepted Codex task has an uncertain outcome. It will not be replayed automatically; inspect the broker task record first.",
      };
    }
    await writeIdempotencyRecord(recordPath, { version: 1, requestId, digest, state: "accepted" });
    let outcome = await this.queue.submit(task, {
      ...(sessionId ? { sessionId } : {}),
      persistSession: session !== undefined,
    }).outcome;
    if (!outcome.ok && outcome.status === 503) {
      await rm(recordPath, { force: true });
      return outcome;
    }
    const completion = this.prepareSessionCompletion(task.kind, session, sessionId, outcome);
    await writeIdempotencyRecord(recordPath, {
      version: 2,
      requestId,
      digest,
      state: "completed",
      outcome: completion.outcome,
      ...(completion.sessionRecord ? { sessionRecord: completion.sessionRecord } : {}),
    });
    await this.materializeSessionRecord(completion.sessionRecord);
    return completion.outcome;
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
      return { outcome: { ok: false, status: 422, message: "Codex role session was not created; the task result was not accepted." } };
    }
    if (expectedSessionId && outcome.sessionId !== expectedSessionId) {
      return { outcome: { ok: false, status: 422, message: "Codex resumed a different role session; the task result was rejected." } };
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

type IdempotencyRecord =
  | { version: 1; requestId: string; digest: string; state: "accepted" }
  | { version: 1; requestId: string; digest: string; state: "completed"; outcome: TaskOutcome }
  | { version: 2; requestId: string; digest: string; state: "completed"; outcome: TaskOutcome; sessionRecord?: SessionRecord };

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
    if ((value.version !== 1 && value.version !== 2) || typeof value.requestId !== "string" || typeof value.digest !== "string") {
      throw new Error("Codex idempotency record is invalid.");
    }
    if (value.state === "accepted" && value.version === 1) return value as Extract<IdempotencyRecord, { state: "accepted" }>;
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

function failureOutcome(error: unknown): TaskOutcome {
  if (error instanceof CodexExecutorError) {
    // 任务已受理后的失败（含执行超时）一律 422：客户端不重放，任务至多执行一次。
    return {
      ok: false,
      status: 422,
      message: `Codex task failed${error.transient ? " transiently" : ""}: ${publicExecutorMessage(error.message)}`,
    };
  }
  return { ok: false, status: 500, message: "Codex broker failed to run the task." };
}

function publicExecutorMessage(message: string): string {
  if (/timed out after \d+ms\./.test(message)) return "the model timed out.";
  if (message === "Codex output is not valid JSON.") return "the model returned invalid JSON.";
  if (message === "Codex produced an empty output.") return "the model returned an empty result.";
  if (message.startsWith("Codex output does not match ")) return "the model result did not satisfy its output contract.";
  if (message.startsWith("Codex output exceeds ")) return "the model result exceeded the configured size limit.";
  if (message === "Codex finished without writing an output file.") return "the model did not return a result.";
  if (message.startsWith("Codex prompt exceeds ")) return "the task context exceeded the configured size limit.";
  if (message.startsWith("Codex task kind ")) return "the requested role is unavailable on this model profile.";
  return "the model execution failed; inspect the host-only broker log for diagnostics.";
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
