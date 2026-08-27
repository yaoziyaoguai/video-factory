import http from "node:http";

export const CODEX_BRIDGE_PROTOCOL_VERSION = "video-factory/codex-bridge-v2" as const;

// 安全边界：kind 白名单是容器侧唯一能表达的任务意图；宿主机 broker 不接受 shell、command 或 cwd。
export const CODEX_TASK_KINDS = ["topic-ideas", "director-plan", "script-draft", "publish-copy", "visual-review"] as const;
export type CodexTaskKind = (typeof CODEX_TASK_KINDS)[number];

export interface CodexTaskTrace {
  taskKind: CodexTaskKind;
  promptVersion: string;
  prompt: string;
  providerId: string;
  modelId: string;
}

export interface CodexTaskExecution<TOutput = unknown> {
  output: TOutput;
  trace?: CodexTaskTrace;
}

const TASK_PATH = "/v1/tasks";
// 只有"确证发生在任务受理之前"的连接错误才可安全重试；中途断连无法证明未受理，不重放。
const RETRYABLE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT"]);
// 单并发 broker 中，生产任务最多等待一个正在执行的后台任务，再获得完整执行时限。
const DEFAULT_TIMEOUT_MS = 660_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class CodexBridgeError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "CodexBridgeError";
  }
}

// transient=true 仅表示"可安全重试"：失败确证发生在任务被受理之前。
// 超时与一切执行期错误都是 terminal，避免重复消耗有限的模型额度。

export interface CodexBridgeClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CodexBridgeClient {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CodexBridgeClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? defaultSleep;
  }

  // 至多执行一次：仅连接层 ENOENT/ECONNREFUSED 与 HTTP 503（队列拒绝，未受理）按指数退避有界重试；
  // 超时与执行期失败直接上抛，绝不重放已受理的任务。
  async runTask(kind: CodexTaskKind, payload: unknown): Promise<unknown> {
    return (await this.runTaskDetailed(kind, payload)).output;
  }

  async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    if (!isCodexTaskKind(kind)) {
      throw new CodexBridgeError(`Unsupported codex task kind '${String(kind)}'.`, false);
    }
    const body = JSON.stringify({ protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION, kind, payload });
    let lastError: CodexBridgeError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.send(body);
      } catch (error) {
        if (!(error instanceof CodexBridgeError) || !error.transient || attempt === this.maxAttempts) throw error;
        lastError = error;
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new CodexBridgeError("Codex bridge request failed.", false);
  }

  private send(body: string): Promise<CodexTaskExecution> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.options.socketPath,
        path: TASK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      }, (response) => {
        this.consume(response, request, resolve, reject);
      });
      request.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, this.timeoutMs)));
      request.end(body);
    });
  }

  private consume(
    response: http.IncomingMessage,
    request: http.ClientRequest,
    resolve: (value: CodexTaskExecution) => void,
    reject: (reason?: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    let received = 0;
    let oversized = false;
    response.on("data", (chunk: Buffer) => {
      if (oversized) return;
      received += chunk.length;
      if (received > this.maxResponseBytes) {
        oversized = true;
        request.destroy();
        reject(new CodexBridgeError(`Codex bridge response exceeds ${this.maxResponseBytes} bytes.`, false));
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, this.timeoutMs)));
    response.on("end", () => {
      if (oversized) return;
      const status = response.statusCode ?? 0;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (status !== 200) {
        reject(new CodexBridgeError(`Codex bridge returned HTTP ${status}.${errorDetail(raw)}`, isRejectedBeforeAcceptance(status)));
        return;
      }
      try {
        resolve(parseEnvelope(raw));
      } catch (error) {
        reject(error);
      }
    });
  }
}

function parseEnvelope(raw: string): CodexTaskExecution {
  const envelope = parseJsonOrThrow(raw, "Codex bridge returned a non-JSON response body.");
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new CodexBridgeError("Codex bridge response envelope must be an object.", false);
  }
  const record = envelope as Record<string, unknown>;
  if (record.ok !== true || typeof record.output !== "string") {
    throw new CodexBridgeError("Codex bridge response envelope is missing ok/output.", false);
  }
  const output = parseJsonOrThrow(stripCodeFence(record.output), "Codex bridge output is not valid JSON.");
  return {
    output,
    ...(record.trace === undefined ? {} : { trace: parseTrace(record.trace) }),
  };
}

function parseTrace(value: unknown): CodexTaskTrace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexBridgeError("Codex bridge trace must be an object.", false);
  }
  const trace = value as Record<string, unknown>;
  if (!isCodexTaskKind(String(trace.taskKind))
    || typeof trace.promptVersion !== "string" || !trace.promptVersion
    || typeof trace.prompt !== "string" || !trace.prompt
    || typeof trace.providerId !== "string" || !trace.providerId
    || typeof trace.modelId !== "string" || !trace.modelId) {
    throw new CodexBridgeError("Codex bridge trace is invalid.", false);
  }
  return {
    taskKind: trace.taskKind as CodexTaskKind,
    promptVersion: trace.promptVersion,
    prompt: trace.prompt,
    providerId: trace.providerId,
    modelId: trace.modelId,
  };
}

function parseJsonOrThrow(value: string, terminalMessage: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CodexBridgeError(terminalMessage, false);
  }
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function mapTransportError(error: unknown, socketPath: string, timeoutMs: number): CodexBridgeError {
  if (error instanceof CodexBridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof Error && (error.name === "AbortError" || code === "ABORT_ERR")) {
    // 超时时任务可能仍在 broker 侧执行，重放会造成重复付费工作。
    return new CodexBridgeError(`Codex bridge request timed out after ${timeoutMs}ms.`, false);
  }
  if (typeof code === "string" && RETRYABLE_CONNECT_CODES.has(code)) {
    return new CodexBridgeError(`Codex bridge socket '${socketPath}' failed with ${code}.`, true);
  }
  return new CodexBridgeError(
    `Codex bridge request failed: ${error instanceof Error ? error.message : String(error)}.`,
    false,
  );
}

function isRejectedBeforeAcceptance(status: number): boolean {
  return status === 503;
}

function isCodexTaskKind(value: string): value is CodexTaskKind {
  return (CODEX_TASK_KINDS as readonly string[]).includes(value);
}

function errorDetail(raw: string): string {
  const detail = raw.trim().slice(0, 160);
  return detail ? ` ${detail}` : "";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
