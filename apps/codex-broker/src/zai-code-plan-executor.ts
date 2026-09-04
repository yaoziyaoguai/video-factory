import { createHash } from "node:crypto";
import {
  CodexExecutorError,
  DEFAULT_ZAI_TEXT_MODEL_ID,
  DEFAULT_ZAI_VISUAL_REVIEW_MODEL_ID,
  ZAI_TASK_KINDS,
  buildTaskPrompt,
  codexExecutorProfileFor,
  type BrokerTaskExecutor,
  type CodexExecutionOptions,
  type CodexExecutionResult,
  type CodexExecutorFailureDetails,
  type CodexExecutorIdentity,
  type ValidatedTask,
} from "./codex-executor.js";
import {
  BROKER_TASK_KINDS,
  outputSchemaFor,
  outputValidationErrorFor,
  taskPromptFor,
  type BrokerTaskKind,
} from "./task-definitions.js";

const ZAI_CHAT_COMPLETIONS_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const ZAI_CODING_PLAN_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
const DEFAULT_TIMEOUT_MS = 285_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const ERROR_RESPONSE_READ_TIMEOUT_MS = 250;
const IMAGE_TASK_KINDS = new Set<BrokerTaskKind>(["asset-rank", "reference-grammar", "visual-review"]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const TRANSIENT_ERROR_CODE_PATTERN = /^(?:temporarily[_-]unavailable|(?:service|model|capacity)[_-](?:temporarily[_-])?unavailable|(?:insufficient|exhausted|unavailable)[_-](?:model[_-])?capacity|(?:(?:model|capacity)[_-])?overload(?:ed)?)$/i;
const INVALID_REQUEST_ERROR_CODE_PATTERN = /^(?:invalid|bad)[_-](?:request|parameter|argument)$/i;

export interface ZaiCodePlanExecutorOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  effort?: string;
  timeoutMs?: number;
  now?: () => number;
}

export class ZaiCodePlanExecutor implements BrokerTaskExecutor {
  readonly identity: CodexExecutorIdentity;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly effort: string;
  private readonly timeoutMs: number;
  private readonly textModelId: string;
  private readonly visualModelId: string;
  private readonly now: () => number;

  constructor(options: ZaiCodePlanExecutorOptions = {}) {
    const environment = options.env ?? process.env;
    this.textModelId = environment.ZAI_TEXT_MODEL_ID?.trim() || DEFAULT_ZAI_TEXT_MODEL_ID;
    this.visualModelId = environment.ZAI_VISUAL_REVIEW_MODEL_ID?.trim() || DEFAULT_ZAI_VISUAL_REVIEW_MODEL_ID;
    this.identity = {
      ...codexExecutorProfileFor("zai", undefined, this.textModelId).identity,
      modelId: this.textModelId,
      taskKinds: [...ZAI_TASK_KINDS],
      taskModels: Object.fromEntries(ZAI_TASK_KINDS.map((kind) => [
        kind,
        IMAGE_TASK_KINDS.has(kind) ? this.visualModelId : this.textModelId,
      ])),
    };
    this.apiKey = environment.ZAI_BIGMODEL_API_KEY?.trim() ?? "";
    if (!this.apiKey) throw new Error("ZAI_BIGMODEL_API_KEY environment variable is required for the zai profile.");
    this.fetchFn = options.fetchFn ?? fetch;
    this.effort = options.effort ?? "max";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async runTask(
    task: ValidatedTask,
    options: CodexExecutionOptions = {},
  ): Promise<CodexExecutionResult> {
    const taskPrompt = taskPromptFor(task.kind);
    const prompt = [
      buildTaskPrompt(task, taskPrompt),
      "",
      "返回对象还必须通过以下 JSON Schema：",
      JSON.stringify(outputSchemaFor(task.kind)),
    ].join("\n");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const images = taskImages(task);
    const modelId = images.length > 0 ? this.visualModelId : this.textModelId;
    const reasoningEffort = zaiReasoningEffort(modelId, this.effort);
    const requestStartedAt = this.now();

    try {
      const response = await this.fetchFn(images.length > 0 ? ZAI_CHAT_COMPLETIONS_URL : ZAI_CODING_PLAN_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{
            role: "user",
            content: images.length > 0 ? [
              { type: "text", text: prompt },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` },
              })),
            ] : prompt,
          }],
          thinking: { type: "enabled", clear_thinking: false },
          reasoning_effort: reasoningEffort,
          temperature: 1,
          top_p: 0.95,
          max_tokens: 8_192,
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        throw new CodexExecutorError(
          `ZAI Chat Completion returned HTTP ${response.status}${code ? ` (code ${code})` : ""}.`,
          isTransientProviderFailure(response.status, code),
          {
            details: {
              category: failureCategoryFor(response.status, code),
              reasonCode: code ?? `http_${response.status}`,
              ...requestIdHashFor(response),
              providerId: this.identity.providerId,
              modelId,
              providerWaitMs: elapsedMs(requestStartedAt, this.now()),
            },
          },
        );
      }
      const raw = await readBoundedResponse(response);
      const providerWaitMs = elapsedMs(requestStartedAt, this.now());
      const validationStartedAt = this.now();
      const content = responseContent(raw, (reasonCode) => invalidOutputDetails(
        this.identity.providerId,
        modelId,
        providerWaitMs,
        reasonCode,
      ));
      const output = stripCodeFence(content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new CodexExecutorError("ZAI Chat Completion output is not valid JSON.", false, {
          details: invalidOutputDetails(this.identity.providerId, modelId, providerWaitMs, "invalid_json"),
        });
      }
      const validationError = outputValidationErrorFor(task.kind, parsed);
      if (validationError !== undefined) {
        throw new CodexExecutorError(`ZAI output does not match ${task.kind} schema: ${validationError}`, false, {
          details: invalidOutputDetails(this.identity.providerId, modelId, providerWaitMs, "output_contract"),
        });
      }
      const visualFindings = task.kind === "visual-review"
        ? (parsed as { findings: Array<{ timecodeMs: number }> }).findings
        : [];
      if (task.kind === "visual-review"
        && visualFindings.some((finding) => finding.timecodeMs > task.payload.durationMs)) {
        throw new CodexExecutorError(
          "ZAI output does not match visual-review schema: finding timecodeMs exceeds payload.durationMs.",
          false,
          {
            details: invalidOutputDetails(this.identity.providerId, modelId, providerWaitMs, "timecode_out_of_bounds"),
          },
        );
      }
      return {
        output,
        trace: {
          taskKind: task.kind,
          promptVersion: taskPrompt.version,
          prompt,
          providerId: this.identity.providerId,
          modelId,
          reasoningEffort,
          providerWaitMs,
          firstOutputEventMs: providerWaitMs,
          toolMs: 0,
          validationMs: elapsedMs(validationStartedAt, this.now()),
        },
      };
    } catch (error) {
      if (error instanceof CodexExecutorError) throw error;
      const cancelled = options.signal?.aborted === true;
      throw new CodexExecutorError(
        cancelled
          ? "ZAI Code Plan task was cancelled because its client disconnected."
          : `ZAI Code Plan request ${controller.signal.aborted ? "timed out" : "could not connect"}.`,
        true,
        {
          details: {
            category: controller.signal.aborted ? "timeout" : "network",
            reasonCode: controller.signal.aborted ? "request_timeout" : "connection_failed",
            providerId: this.identity.providerId,
            modelId,
            providerWaitMs: elapsedMs(requestStartedAt, this.now()),
          },
        },
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

function failureCategoryFor(status: number, code: string | undefined): "authentication" | "invalid_request" | "rate_limited" | "service_unavailable" | "execution_failed" {
  if (status === 401 || status === 403) return "authentication";
  if (isExplicitInvalidRequestCode(code)) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504 || isExplicitTransientCode(code)) return "service_unavailable";
  if (status === 400 || status === 404 || status === 409 || status === 422) return "invalid_request";
  return "execution_failed";
}

function isTransientProviderFailure(status: number, code: string | undefined): boolean {
  if (isExplicitInvalidRequestCode(code)) return false;
  return TRANSIENT_HTTP_STATUSES.has(status) || isExplicitTransientCode(code);
}

function isExplicitTransientCode(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT_ERROR_CODE_PATTERN.test(code);
}

function isExplicitInvalidRequestCode(code: string | undefined): boolean {
  return code !== undefined && INVALID_REQUEST_ERROR_CODE_PATTERN.test(code);
}

function zaiReasoningEffort(modelId: string, effort: string): string {
  return modelId.startsWith("glm-5.3-flash") && effort === "xhigh" ? "max" : effort;
}

function requestIdHashFor(response: Response): { requestIdHash?: string } {
  const requestId = ["x-request-id", "x-zhipu-request-id", "x-requestid", "request-id", "x-trace-id"]
    .map((name) => response.headers.get(name)?.trim())
    .find((value): value is string => Boolean(value));
  return requestId
    ? { requestIdHash: createHash("sha256").update(requestId).digest("hex") }
    : {};
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function invalidOutputDetails(
  providerId: string,
  modelId: string,
  providerWaitMs: number,
  reasonCode: "invalid_json" | "output_contract" | "timecode_out_of_bounds",
): CodexExecutorFailureDetails {
  return {
    category: "invalid_output",
    reasonCode,
    providerId,
    modelId,
    providerWaitMs,
  };
}


function taskImages(task: ValidatedTask): Buffer[] {
  if (task.kind === "visual-review" || task.kind === "reference-grammar") {
    return task.payload.frames.map((frame) => frame.jpeg);
  }
  if (task.kind === "asset-rank") return task.payload.thumbnails.map((thumbnail) => thumbnail.jpeg);
  if (task.kind === "role-audit") return task.payload.images.map((image) => image.jpeg);
  return [];
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let timeout: number | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, ERROR_RESPONSE_READ_TIMEOUT_MS);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === undefined) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      if (result.done) break;
      received += result.value.byteLength;
      if (received > MAX_ERROR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
  return responseErrorCode(Buffer.concat(chunks).toString("utf8"));
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CodexExecutorError(`ZAI Chat Completion response exceeds ${MAX_RESPONSE_BYTES} bytes.`, false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CodexExecutorError(`ZAI Chat Completion response exceeds ${MAX_RESPONSE_BYTES} bytes.`, false);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseErrorCode(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const nested = isRecord(parsed.error) ? parsed.error.code : undefined;
  const candidate = nested ?? parsed.code;
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
    return String(candidate);
  }
  if (typeof candidate === "string"
    && (/^\d{3,8}$/.test(candidate) || isExplicitTransientCode(candidate) || isExplicitInvalidRequestCode(candidate))) return candidate;
  return undefined;
}

function responseContent(
  raw: string,
  failureDetails: (reasonCode: "invalid_json" | "output_contract") => CodexExecutorFailureDetails,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexExecutorError("ZAI Chat Completion returned a non-JSON response.", false, {
      details: failureDetails("invalid_json"),
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new CodexExecutorError("ZAI Chat Completion response is missing choices.", false, {
      details: failureDetails("output_contract"),
    });
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw new CodexExecutorError("ZAI Chat Completion response is missing message content.", false, {
      details: failureDetails("output_contract"),
    });
  }
  return choice.message.content;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
