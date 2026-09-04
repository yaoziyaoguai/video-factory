import http from "node:http";
import { randomUUID } from "node:crypto";

export const CODEX_BRIDGE_PROTOCOL_VERSION = "video-factory/codex-bridge-v2" as const;

// 安全边界：kind 白名单是容器侧唯一能表达的任务意图；宿主机 broker 不接受 shell、command 或 cwd。
export const CODEX_TASK_KINDS = ["topic-ideas", "series-roadmap", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"] as const;
export type CodexTaskKind = (typeof CODEX_TASK_KINDS)[number];

interface ModelCandidateAttemptBase {
  modelId: string;
  providerId: string;
}

export type ModelCandidateAttempt = ModelCandidateAttemptBase & (
  | {
    outcome: "succeeded";
    failureStage?: never;
    failureReason?: never;
  }
  | {
    outcome: "failed";
    failureStage: CodexBridgeFailureStage | "transport";
    failureReason: string;
  }
);

export interface CodexTaskTrace {
  taskKind: CodexTaskKind;
  promptVersion: string;
  prompt: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  fallbackFromModelId?: string;
  fallbackReason?: string;
  attemptedModelIds?: string[];
  modelCandidateAttempts?: ModelCandidateAttempt[];
  providerWaitMs?: number;
  firstOutputEventMs?: number;
  toolMs?: number;
  validationMs?: number;
}

export interface CodexTaskSession {
  key: string;
  handle?: string;
}

export interface CodexTaskRequestOptions {
  timeoutMs?: number;
}

export type CodexBridgeFailureStage = "not_accepted" | "completed_failure" | "uncertain";
export type CodexBridgeFailureKind = "model_provider_transient";

export type ModelProviderFailureCategory =
  | "authentication"
  | "invalid_request"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "network"
  | "invalid_output"
  | "execution_failed";

export interface ModelProviderFailureDetails {
  category: ModelProviderFailureCategory;
  reasonCode: string;
  providerId: string;
  modelId: string;
  providerWaitMs?: number;
  requestIdHash?: string;
}

export interface RoleAuditIssue {
  severity: "advisory" | "blocking";
  criterion: string;
  evidence: string;
  repairInstruction: string;
}

export interface RoleAudit {
  version: "video-factory/role-audit-v1";
  verdict: "pass" | "repair";
  score: number;
  summary: string;
  issues: RoleAuditIssue[];
  repairInstructions: string[];
}

export interface AgentLoopIterationTrace {
  iteration: number;
  candidate: unknown;
  candidateHash: string;
  candidateTrace?: CodexTaskTrace;
  auditTrace?: CodexTaskTrace;
  audit: RoleAudit;
}

export interface AgentLoopPendingCandidateTrace {
  iteration: number;
  candidate: unknown;
  candidateHash: string;
  candidateTrace?: CodexTaskTrace;
}

export interface AgentLoopTrace {
  version: "video-factory/agent-loop-v1";
  role: string;
  contractVersion: string;
  criteria: string[];
  status: "passed" | "failed";
  maxIterations: number;
  modelCallCount?: number;
  producerModelCallCount?: number;
  auditModelCallCount?: number;
  producerMs?: number;
  auditMs?: number;
  validationMs?: number;
  retryCount?: number;
  iterations: AgentLoopIterationTrace[];
  pendingCandidate?: AgentLoopPendingCandidateTrace;
}

export interface CodexTaskExecution<TOutput = unknown> {
  output: TOutput;
  trace?: CodexTaskTrace;
  agentLoop?: AgentLoopTrace;
  session?: CodexTaskSession;
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
  readonly creatorMessage: string;
  readonly failureDetails: ModelProviderFailureDetails | undefined;

  constructor(
    message: string,
    readonly transient: boolean,
    readonly stage: CodexBridgeFailureStage = transient ? "not_accepted" : "uncertain",
    readonly statusCode?: number,
    readonly failureKind?: CodexBridgeFailureKind,
    failureDetails?: ModelProviderFailureDetails,
  ) {
    super(message);
    this.name = "CodexBridgeError";
    this.failureDetails = failureDetails;
    this.creatorMessage = creatorMessageFor(message, failureDetails, statusCode, failureKind);
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
  async runTask(
    kind: CodexTaskKind,
    payload: unknown,
    requestId?: string,
    requestOptions?: CodexTaskRequestOptions,
  ): Promise<unknown> {
    return (await this.runTaskDetailed(kind, payload, requestId, undefined, requestOptions)).output;
  }

  async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string = randomUUID(),
    session?: CodexTaskSession,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    if (!isCodexTaskKind(kind)) {
      throw new CodexBridgeError(`Unsupported codex task kind '${String(kind)}'.`, false);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      throw new CodexBridgeError("Codex bridge requestId is invalid.", false);
    }
    if (session !== undefined) validateTaskSession(session);
    const body = JSON.stringify({
      protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
      requestId,
      kind,
      payload,
      ...(session ? { sessionKey: session.key, ...(session.handle ? { sessionHandle: session.handle } : {}) } : {}),
    });
    const requestTimeoutMs = requestOptions.timeoutMs === undefined
      ? this.timeoutMs
      : positiveRequestTimeout(requestOptions.timeoutMs);
    const deadlineAtMs = Date.now() + requestTimeoutMs;
    let lastError: CodexBridgeError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) throw requestDeadlineError(requestTimeoutMs);
        return await this.send(body, session?.key, remainingMs);
      } catch (error) {
        if (!(error instanceof CodexBridgeError) || !error.transient || attempt === this.maxAttempts) throw error;
        lastError = error;
        const retryDelayMs = this.retryDelayMs * 2 ** (attempt - 1);
        if (retryDelayMs >= deadlineAtMs - Date.now()) throw requestDeadlineError(requestTimeoutMs);
        await this.sleep(retryDelayMs);
      }
    }
    throw lastError ?? new CodexBridgeError("Codex bridge request failed.", false);
  }

  private send(body: string, sessionKey: string | undefined, timeoutMs: number): Promise<CodexTaskExecution> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.options.socketPath,
        path: TASK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        this.consume(response, request, sessionKey, resolve, reject);
      });
      request.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, timeoutMs)));
      request.end(body);
    });
  }

  private consume(
    response: http.IncomingMessage,
    request: http.ClientRequest,
    sessionKey: string | undefined,
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
        const retryable = status === 503;
        const notAccepted = retryable || isUnknownRoleSessionRejection(status, raw);
        const failureKind = bridgeFailureKind(raw);
        const failureDetails = bridgeFailureDetails(raw);
        reject(new CodexBridgeError(
          `Codex bridge returned HTTP ${status}.${errorDetail(raw)}`,
          retryable,
          notAccepted ? "not_accepted" : status === 422 ? "completed_failure" : "uncertain",
          status,
          failureKind,
          failureDetails,
        ));
        return;
      }
      try {
        resolve(parseEnvelope(raw, sessionKey));
      } catch (error) {
        reject(error);
      }
    });
  }
}

export function requestOptionsForDeadline(deadlineAtMs: number | undefined): CodexTaskRequestOptions | undefined {
  if (deadlineAtMs === undefined) return undefined;
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1) {
    throw new CodexBridgeError("Text agent wall-clock deadline is invalid.", false, "not_accepted");
  }
  const timeoutMs = deadlineAtMs - Date.now();
  if (timeoutMs <= 0) throw requestDeadlineError(0);
  return { timeoutMs };
}

function positiveRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CodexBridgeError("Codex bridge request timeout must be a positive integer.", false, "not_accepted");
  }
  return value;
}

function requestDeadlineError(timeoutMs: number): CodexBridgeError {
  return new CodexBridgeError(`Text agent wall-clock deadline exhausted after ${timeoutMs}ms.`, false, "not_accepted");
}

function parseEnvelope(raw: string, sessionKey?: string): CodexTaskExecution {
  const envelope = parseJsonOrThrow(raw, "Codex bridge returned a non-JSON response body.");
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new CodexBridgeError("Codex bridge response envelope must be an object.", false);
  }
  const record = envelope as Record<string, unknown>;
  if (record.ok !== true || typeof record.output !== "string") {
    throw new CodexBridgeError("Codex bridge response envelope is missing ok/output.", false);
  }
  if (record.sessionHandle !== undefined
    && (sessionKey === undefined
      || typeof record.sessionHandle !== "string"
      || !isOpaqueSessionHandle(record.sessionHandle))) {
    throw new CodexBridgeError("Codex bridge response session handle is invalid.", false);
  }
  const output = parseJsonOrThrow(stripCodeFence(record.output), "Codex bridge output is not valid JSON.");
  return {
    output,
    ...(record.trace === undefined ? {} : { trace: parseTrace(record.trace) }),
    ...(sessionKey && typeof record.sessionHandle === "string"
      ? { session: { key: sessionKey, handle: record.sessionHandle } }
      : {}),
  };
}

function validateTaskSession(session: CodexTaskSession): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.key)) {
    throw new CodexBridgeError("Codex task session key is invalid.", false);
  }
  if (session.handle !== undefined && !isOpaqueSessionHandle(session.handle)) {
    throw new CodexBridgeError("Codex task session handle is invalid.", false);
  }
}

function isOpaqueSessionHandle(value: string): boolean {
  return /^vfs_[A-Za-z0-9_-]{32}$/.test(value);
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
  const modelCandidateAttempts = parseModelCandidateAttempts(trace.modelCandidateAttempts);
  const providerWaitMs = optionalDurationMs(trace.providerWaitMs, "providerWaitMs");
  const firstOutputEventMs = optionalDurationMs(trace.firstOutputEventMs, "firstOutputEventMs");
  const toolMs = optionalDurationMs(trace.toolMs, "toolMs");
  const validationMs = optionalDurationMs(trace.validationMs, "validationMs");
  return {
    taskKind: trace.taskKind as CodexTaskKind,
    promptVersion: trace.promptVersion,
    prompt: trace.prompt,
    providerId: trace.providerId,
    modelId: trace.modelId,
    ...(typeof trace.reasoningEffort === "string" && trace.reasoningEffort
      ? { reasoningEffort: trace.reasoningEffort }
      : {}),
    ...(typeof trace.fallbackFromModelId === "string" && trace.fallbackFromModelId
      ? { fallbackFromModelId: trace.fallbackFromModelId }
      : {}),
    ...(typeof trace.fallbackReason === "string" && trace.fallbackReason
      ? { fallbackReason: trace.fallbackReason }
      : {}),
    ...(Array.isArray(trace.attemptedModelIds)
      && trace.attemptedModelIds.length > 0
      && trace.attemptedModelIds.every((modelId) => typeof modelId === "string" && modelId)
      ? { attemptedModelIds: [...new Set(trace.attemptedModelIds)] as string[] }
      : {}),
    ...(modelCandidateAttempts ? { modelCandidateAttempts } : {}),
    ...(providerWaitMs !== undefined ? { providerWaitMs } : {}),
    ...(firstOutputEventMs !== undefined ? { firstOutputEventMs } : {}),
    ...(toolMs !== undefined ? { toolMs } : {}),
    ...(validationMs !== undefined ? { validationMs } : {}),
  };
}

function optionalDurationMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexBridgeError(`Codex bridge trace ${field} is invalid.`, false);
  }
  return Number(value);
}

function parseModelCandidateAttempts(value: unknown): ModelCandidateAttempt[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodexBridgeError("Codex bridge model candidate attempts are invalid.", false);
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is invalid.", false);
    }
    const attempt = item as Record<string, unknown>;
    if (typeof attempt.modelId !== "string" || !attempt.modelId
      || (attempt.outcome !== "failed" && attempt.outcome !== "succeeded")
      || (attempt.failureStage !== undefined
        && attempt.failureStage !== "not_accepted"
        && attempt.failureStage !== "completed_failure"
        && attempt.failureStage !== "uncertain"
        && attempt.failureStage !== "transport")
      || (attempt.failureReason !== undefined
        && (typeof attempt.failureReason !== "string" || !attempt.failureReason))) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is invalid.", false);
    }
    if (typeof attempt.providerId !== "string" || !attempt.providerId) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is missing its broker provider identity.", false);
    }
    if (attempt.outcome === "succeeded"
      && (attempt.failureStage !== undefined || attempt.failureReason !== undefined)) {
      throw new CodexBridgeError("Codex bridge successful model candidate attempt cannot contain a failure.", false);
    }
    if (attempt.outcome === "failed"
      && (attempt.failureStage === undefined || attempt.failureReason === undefined)) {
      throw new CodexBridgeError("Codex bridge failed model candidate attempt must describe its failure.", false);
    }
    return {
      modelId: attempt.modelId,
      providerId: attempt.providerId,
      outcome: attempt.outcome,
      ...(attempt.failureStage ? { failureStage: attempt.failureStage } : {}),
      ...(typeof attempt.failureReason === "string" ? { failureReason: attempt.failureReason } : {}),
    } as ModelCandidateAttempt;
  });
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

function isUnknownRoleSessionRejection(status: number, raw: string): boolean {
  return status === 409 && raw.includes("Codex role session is unknown or belongs to a different production role.");
}

function isCodexTaskKind(value: string): value is CodexTaskKind {
  return (CODEX_TASK_KINDS as readonly string[]).includes(value);
}

function errorDetail(raw: string): string {
  const detail = raw.trim().slice(0, 160);
  return detail ? ` ${detail}` : "";
}

function bridgeFailureKind(raw: string): CodexBridgeFailureKind | undefined {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return body.failureKind === "model_provider_transient" ? body.failureKind : undefined;
  } catch {
    return undefined;
  }
}

const MODEL_PROVIDER_FAILURE_CATEGORIES = new Set<ModelProviderFailureCategory>([
  "authentication",
  "invalid_request",
  "rate_limited",
  "service_unavailable",
  "timeout",
  "network",
  "invalid_output",
  "execution_failed",
]);

function bridgeFailureDetails(raw: string): ModelProviderFailureDetails | undefined {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const value = body.failureDetails;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const details = value as Record<string, unknown>;
    if (!MODEL_PROVIDER_FAILURE_CATEGORIES.has(details.category as ModelProviderFailureCategory)
      || !isBoundedIdentifier(details.reasonCode, 128)
      || !isBoundedIdentifier(details.providerId, 128)
      || !isBoundedIdentifier(details.modelId, 128)
      || (details.providerWaitMs !== undefined && optionalDurationMs(details.providerWaitMs, "providerWaitMs") === undefined)
      || (details.requestIdHash !== undefined
        && (typeof details.requestIdHash !== "string" || !/^[a-f0-9]{64}$/.test(details.requestIdHash)))) {
      return undefined;
    }
    return {
      category: details.category as ModelProviderFailureCategory,
      reasonCode: details.reasonCode as string,
      providerId: details.providerId as string,
      modelId: details.modelId as string,
      ...(details.providerWaitMs !== undefined ? { providerWaitMs: Number(details.providerWaitMs) } : {}),
      ...(typeof details.requestIdHash === "string" ? { requestIdHash: details.requestIdHash } : {}),
    };
  } catch {
    return undefined;
  }
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n\t]/.test(value);
}

function creatorMessageFor(
  message: string,
  details: ModelProviderFailureDetails | undefined,
  statusCode: number | undefined,
  failureKind: CodexBridgeFailureKind | undefined,
): string {
  switch (details?.category) {
    case "rate_limited":
      return "模型请求过多，请稍后重试或选择其他模型。";
    case "timeout":
      return "模型调用超时，请重试或选择其他模型。";
    case "service_unavailable":
    case "network":
      return "模型暂时不可用，请重试或选择其他模型。";
    case "authentication":
      return "模型服务配置需要检查。";
    default:
      if (statusCode === 429) return "模型请求过多，请稍后重试或选择其他模型。";
      if (statusCode === 408 || /timed?\s*out|timeout/i.test(message)) {
        return "模型调用超时，请重试或选择其他模型。";
      }
      if (statusCode === 503 || failureKind === "model_provider_transient") {
        return "模型暂时不可用，请重试或选择其他模型。";
      }
      return "模型没有完成此步骤，请重试或选择其他模型。";
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
