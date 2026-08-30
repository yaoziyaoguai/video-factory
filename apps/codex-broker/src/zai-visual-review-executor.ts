import {
  CodexExecutorError,
  DEFAULT_ZAI_VISUAL_REVIEW_MODEL_ID,
  buildTaskPrompt,
  codexExecutorProfileFor,
  type BrokerTaskExecutor,
  type CodexExecutionOptions,
  type CodexExecutionResult,
  type CodexExecutorIdentity,
  type ValidatedTask,
} from "./codex-executor.js";
import {
  outputSchemaFor,
  outputValidationErrorFor,
  taskPromptFor,
} from "./task-definitions.js";

const ZAI_CHAT_COMPLETIONS_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_TIMEOUT_MS = 285_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const ERROR_RESPONSE_READ_TIMEOUT_MS = 250;

export interface ZaiVisualReviewExecutorOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  effort?: string;
  timeoutMs?: number;
}

export class ZaiVisualReviewExecutor implements BrokerTaskExecutor {
  readonly identity: CodexExecutorIdentity;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly effort: string;
  private readonly timeoutMs: number;

  constructor(options: ZaiVisualReviewExecutorOptions = {}) {
    const environment = options.env ?? process.env;
    const modelId = environment.ZAI_VISUAL_REVIEW_MODEL_ID?.trim() || DEFAULT_ZAI_VISUAL_REVIEW_MODEL_ID;
    this.identity = codexExecutorProfileFor("zai", undefined, modelId).identity;
    this.apiKey = environment.ZAI_BIGMODEL_API_KEY?.trim() ?? "";
    if (!this.apiKey) throw new Error("ZAI_BIGMODEL_API_KEY environment variable is required for the zai profile.");
    this.fetchFn = options.fetchFn ?? fetch;
    this.effort = options.effort ?? "max";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async runTask(
    task: ValidatedTask,
    options: CodexExecutionOptions = {},
  ): Promise<CodexExecutionResult> {
    if (task.kind !== "visual-review") {
      throw new CodexExecutorError(
        `Task kind '${task.kind}' is not allowed for the ZAI visual-review executor.`,
        false,
      );
    }

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

    try {
      const response = await this.fetchFn(ZAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.identity.modelId,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...task.payload.frames.map((frame) => ({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${frame.jpeg.toString("base64")}` },
              })),
            ],
          }],
          thinking: { type: "enabled", clear_thinking: false },
          reasoning_effort: this.effort,
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
          false,
        );
      }
      const raw = await readBoundedResponse(response);
      const content = responseContent(raw);
      const output = stripCodeFence(content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new CodexExecutorError("ZAI Chat Completion output is not valid JSON.", false);
      }
      const validationError = outputValidationErrorFor(task.kind, parsed);
      if (validationError !== undefined) {
        throw new CodexExecutorError(`ZAI output does not match visual-review schema: ${validationError}`, false);
      }
      const findings = (parsed as { findings: Array<{ timecodeMs: number }> }).findings;
      if (findings.some((finding) => finding.timecodeMs > task.payload.durationMs)) {
        throw new CodexExecutorError(
          "ZAI output does not match visual-review schema: finding timecodeMs exceeds payload.durationMs.",
          false,
        );
      }
      return {
        output,
        trace: {
          taskKind: task.kind,
          promptVersion: taskPrompt.version,
          prompt,
          providerId: this.identity.providerId,
          modelId: this.identity.modelId,
          reasoningEffort: this.effort,
        },
      };
    } catch (error) {
      if (error instanceof CodexExecutorError) throw error;
      const cancelled = options.signal?.aborted === true;
      throw new CodexExecutorError(
        cancelled
          ? "ZAI visual-review task was cancelled because its client disconnected."
          : `ZAI visual-review request ${controller.signal.aborted ? "timed out" : "could not connect"}.`,
        true,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
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
  if (typeof candidate === "string" && /^\d{3,8}$/.test(candidate)) return candidate;
  return undefined;
}

function responseContent(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexExecutorError("ZAI Chat Completion returned a non-JSON response.", false);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new CodexExecutorError("ZAI Chat Completion response is missing choices.", false);
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw new CodexExecutorError("ZAI Chat Completion response is missing message content.", false);
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
