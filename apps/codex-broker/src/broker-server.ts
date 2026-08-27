import http from "node:http";
import { chmod, stat, unlink } from "node:fs/promises";
import {
  CODEX_BRIDGE_PROTOCOL_VERSION,
  CodexExecutorError,
  parseTaskRequest,
  type CodexExecutor,
  type CodexTaskTrace,
  type ValidatedTask,
} from "./codex-executor.js";

const DEFAULT_SOCKET_MODE = 0o660;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_BACKLOG = 20;
// 6 MiB JPEG 解码预算经 base64 后是 8 MiB；额外空间仅容纳固定 JSON 元数据。
const DEFAULT_MAX_BODY_BYTES = 9 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const STALE_PROBE_TIMEOUT_MS = 500;

export type TaskOutcome =
  | { ok: true; output: string; trace?: CodexTaskTrace }
  | { ok: false; status: 400 | 413 | 422 | 503 | 500; message: string };

interface QueuedTask {
  task: ValidatedTask;
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
    private readonly executor: CodexExecutor,
    private readonly concurrency: number,
    private readonly maxBacklog: number,
  ) {}

  queued(): number { return this.pending.length; }
  active(): number { return this.activeTasks; }
  completed(): number { return this.completedTasks; }
  failed(): number { return this.failedTasks; }

  submit(task: ValidatedTask): TaskSubmission {
    if (this.closed) return settledSubmission(shutdownOutcome());
    if (this.pending.length >= this.maxBacklog) return settledSubmission(busyOutcome());
    let entry!: QueuedTask;
    const outcome = new Promise<TaskOutcome>((settle) => {
      entry = { task, settle, controller: new AbortController(), active: false };
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
        const result = await this.executor.runTask(next.task, { signal: next.controller.signal });
        this.completedTasks += 1;
        next.settle({
          ok: true,
          output: result.output,
          ...(result.trace ? { trace: result.trace } : {}),
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
  executor: CodexExecutor;
  concurrency?: number;
  maxBacklog?: number;
  maxBodyBytes?: number;
  shutdownTimeoutMs?: number;
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
    // 收敛后清掉残留 keep-alive 连接，让 server.close 回调得以触发。
    this.server.closeAllConnections();
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
    try {
      task = parseTaskRequest(parsed, this.options.executor.identity);
    } catch (error) {
      const message = error instanceof CodexExecutorError ? error.message : "Invalid codex task request.";
      this.sendJson(response, 400, { error: message });
      return;
    }
    const submission = this.queue.submit(task);
    const cancelIfDisconnected = (): void => {
      if (!response.writableEnded) submission.cancel();
    };
    response.once("close", cancelIfDisconnected);
    const outcome = await submission.outcome;
    response.off("close", cancelIfDisconnected);
    if (outcome.ok) {
      this.sendJson(response, 200, {
        ok: true,
        output: outcome.output,
        ...(outcome.trace ? { trace: outcome.trace } : {}),
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

function failureOutcome(error: unknown): TaskOutcome {
  if (error instanceof CodexExecutorError) {
    // 任务已受理后的失败（含执行超时）一律 422：客户端不重放，任务至多执行一次。
    return {
      ok: false,
      status: 422,
      message: `Codex task failed${error.transient ? " transiently" : ""}: ${error.message}`,
    };
  }
  return { ok: false, status: 500, message: "Codex broker failed to run the task." };
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
