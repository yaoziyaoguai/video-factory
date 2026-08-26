import { CodexBridgeClient } from "./codex-chat.js";

export type ScriptVisualStrategy = "stock" | "image" | "local";

// 字段保持 snake_case：script.json 的消费者是 Python worker（voiceover/renderer/assets）。
export interface ScriptScene {
  position: number;
  narration: string;
  duration: number;
  visual_strategy: ScriptVisualStrategy;
  visual_prompt: string;
  search_terms: string[];
}

export interface ScriptDraft {
  scenes: ScriptScene[];
}

export interface ScreenwriterAgentInput {
  brief: {
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
    platform: string;
    durationSeconds: number;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
  };
}

export interface ScreenwriterAgent {
  id: string;
  draft(input: ScreenwriterAgentInput): Promise<unknown>;
}

export interface CodexScreenwriterAgentOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

// 330s > broker 285s 任务 deadline：broker 先终止 codex，客户端拿到带上下文的终态错误且不重放。
const DEFAULT_SCREENWRITER_TIMEOUT_MS = 330_000;
const DEFAULT_SCREENWRITER_MAX_ATTEMPTS = 2;

// id 固定为 codex-screenwriter-v1：brief.providers.script 持久化该 id，registry 按 id 匹配 provider。
export class CodexScreenwriterAgent implements ScreenwriterAgent {
  readonly id = "codex-screenwriter-v1";
  private readonly client: CodexBridgeClient;

  constructor(options: CodexScreenwriterAgentOptions) {
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.socketPath) {
        throw new Error("CodexScreenwriterAgent requires a CodexBridgeClient or a socketPath.");
      }
      this.client = new CodexBridgeClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_SCREENWRITER_TIMEOUT_MS,
        maxAttempts: options.maxAttempts ?? DEFAULT_SCREENWRITER_MAX_ATTEMPTS,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      });
    }
  }

  // 模型输出为 unknown：先经 validateScriptDraft 硬校验，malformed/不合法直接抛错，没有任何 fallback。
  async draft(input: ScreenwriterAgentInput): Promise<ScriptDraft> {
    if (!Number.isInteger(input.brief.durationSeconds)
      || input.brief.durationSeconds < 20
      || input.brief.durationSeconds > 180) {
      throw new Error("Screenwriter brief.durationSeconds must be an integer between 20 and 180.");
    }
    const rawDraft = await this.client.runTask("script-draft", { brief: input.brief });
    return validateScriptDraft(rawDraft, { durationSeconds: input.brief.durationSeconds });
  }
}

export function validateScriptDraft(value: unknown, options: { durationSeconds: number }): ScriptDraft {
  if (!Number.isInteger(options.durationSeconds)
    || options.durationSeconds < 20
    || options.durationSeconds > 180) {
    throw new Error("Script draft target durationSeconds must be an integer between 20 and 180.");
  }
  const input = record(value, "Script draft");
  if (!Array.isArray(input.scenes)) throw new Error("Script draft scenes must be an array.");
  if (input.scenes.length < 3 || input.scenes.length > 10) {
    throw new Error(`Script draft must contain between 3 and 10 scenes; got ${input.scenes.length}.`);
  }
  const scenes = input.scenes.map((entry, index) => {
    const scene = record(entry, `scenes[${index}]`);
    const visualStrategy = scene.visual_strategy;
    if (!isScriptVisualStrategy(visualStrategy)) {
      throw new Error(`scenes[${index}].visual_strategy must be one of stock, image, local.`);
    }
    return {
      position: integer(scene.position, `scenes[${index}].position`),
      narration: text(scene.narration, `scenes[${index}].narration`),
      duration: positiveNumber(scene.duration, `scenes[${index}].duration`),
      visual_strategy: visualStrategy,
      visual_prompt: text(scene.visual_prompt, `scenes[${index}].visual_prompt`),
      search_terms: searchTermArray(scene.search_terms, `scenes[${index}].search_terms`),
    };
  }).sort((left, right) => left.position - right.position);
  scenes.forEach((scene, index) => {
    if (scene.position !== index + 1) {
      throw new Error("Script draft scene positions must be contiguous integers starting at 1.");
    }
  });
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const minimum = options.durationSeconds * 0.6;
  const maximum = options.durationSeconds * 1.4;
  if (total < minimum || total > maximum) {
    throw new Error(
      `Script draft total duration ${total}s is outside 0.6-1.4x of the ${options.durationSeconds}s target.`,
    );
  }
  return { scenes };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer.`);
  return Number(value);
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite positive number.`);
  }
  return value;
}

function searchTermArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error(`${field} must be an array of 1 to 8 strings.`);
  }
  const terms = value.map((entry, index) => text(entry, `${field}[${index}]`));
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term)) {
      throw new Error(`${field} must not contain duplicate terms after trimming.`);
    }
    seen.add(term);
  }
  return terms;
}

function isScriptVisualStrategy(value: unknown): value is ScriptVisualStrategy {
  return value === "stock" || value === "image" || value === "local";
}
