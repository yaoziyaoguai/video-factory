import { CodexBridgeClient, type CodexTaskExecution } from "./codex-chat.js";
import type { ProductionBlueprint } from "@video-factory/template-core";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ProductionSeriesContext } from "./contracts.js";

export type ScriptVisualStrategy = "stock" | "image" | "generated" | "local";

// 字段保持 snake_case：script.json 的消费者是 Python worker（voiceover/renderer/assets）。
export interface ScriptScene {
  position: number;
  purpose?: string;
  narration: string;
  duration: number;
  visual_strategy: ScriptVisualStrategy;
  visual_prompt: string;
  visible_action?: string;
  on_screen_text?: string;
  sound_cue?: string;
  success_criteria?: string[];
  failure_conditions?: string[];
  search_terms: string[];
}

export interface ScriptDraft {
  viewerPromise?: string;
  narrativeArc?: string;
  canonFacts?: string[];
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
    templateBlueprint?: ProductionBlueprint;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    seriesContext?: ProductionSeriesContext;
  };
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
}

export interface ScreenwriterAgent {
  id: string;
  draft(input: ScreenwriterAgentInput): Promise<unknown>;
  draftDetailed?(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>>;
}

export interface CodexScreenwriterAgentOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReviewIterations?: number;
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_SCREENWRITER_TIMEOUT_MS = 660_000;
const DEFAULT_SCREENWRITER_MAX_ATTEMPTS = 2;
export const SCREENWRITER_AGENT_CONTRACT_VERSION = "screenwriter-v4|role-audit-v1|script-validator-v1";

// id 固定为 codex-screenwriter-v1：brief.providers.script 持久化该 id，registry 按 id 匹配 provider。
export class CodexScreenwriterAgent implements ScreenwriterAgent {
  readonly id = "codex-screenwriter-v1";
  private readonly client: CodexBridgeClient;
  private readonly maxReviewIterations: number;

  constructor(options: CodexScreenwriterAgentOptions) {
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
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
    validateScreenwriterTarget(input);
    const rawDraft = await this.client.runTask("script-draft", { brief: input.brief });
    return validateScriptDraft(rawDraft, {
      durationSeconds: input.brief.durationSeconds,
      requireCanonFacts: Boolean(input.brief.seriesContext),
    });
  }

  async draftDetailed(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<ScriptDraft>> {
    validateScreenwriterTarget(input);
    return runRoleAgentLoop({
      role: "编剧",
      contractVersion: SCREENWRITER_AGENT_CONTRACT_VERSION,
      criteria: [
        "前两秒建立具体钩子，前六秒兑现一部分观众承诺",
        "每镜头只有一个可见动作，成功与失败条件可由下游验收",
        "旁白时长、镜头时长、屏幕文字和声音提示彼此一致",
        "事实、素材可得性、平台与模板约束均未被虚构或绕过",
        "系列单集遵守系列圣经、已内部定版 canon 与前后集连续性，并在本集形成独立兑现",
        "系列单集的 canonFacts 只记录本集已经明确建立且可供后集引用的事实，不得包含预告、计划、悬念、问题或尚待验证的结论",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId }) => this.client.runTaskDetailed("script-draft", {
        brief: input.brief,
        ...(revision ? { revision } : {}),
      }, requestId),
      audit: ({ role, iteration, criteria, candidate, requestId }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: { brief: input.brief },
        candidate,
      }, requestId),
      validate: (value) => validateScriptDraft(value, {
        durationSeconds: input.brief.durationSeconds,
        requireCanonFacts: Boolean(input.brief.seriesContext),
      }),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
  }
}

function validateScreenwriterTarget(input: ScreenwriterAgentInput): void {
    if (!Number.isInteger(input.brief.durationSeconds)
      || input.brief.durationSeconds < 20
      || input.brief.durationSeconds > 180) {
      throw new Error("Screenwriter brief.durationSeconds must be an integer between 20 and 180.");
    }
}

export function validateScriptDraft(value: unknown, options: { durationSeconds: number; requireCanonFacts?: boolean }): ScriptDraft {
  if (!Number.isInteger(options.durationSeconds)
    || options.durationSeconds < 20
    || options.durationSeconds > 180) {
    throw new Error("Script draft target durationSeconds must be an integer between 20 and 180.");
  }
  const input = record(value, "Script draft");
  if (!Array.isArray(input.scenes)) throw new Error("Script draft scenes must be an array.");
  if (input.scenes.length < 3 || input.scenes.length > 24) {
    throw new Error(`Script draft must contain between 3 and 24 scenes; got ${input.scenes.length}.`);
  }
  const scenes = input.scenes.map((entry, index) => {
    const scene = record(entry, `scenes[${index}]`);
    const visualStrategy = scene.visual_strategy;
    if (!isScriptVisualStrategy(visualStrategy)) {
      throw new Error(`scenes[${index}].visual_strategy must be one of stock, image, generated, local.`);
    }
    return {
      position: integer(scene.position, `scenes[${index}].position`),
      ...(optionalText(scene.purpose, `scenes[${index}].purpose`) !== undefined
        ? { purpose: optionalText(scene.purpose, `scenes[${index}].purpose`)! }
        : {}),
      narration: text(scene.narration, `scenes[${index}].narration`),
      duration: positiveNumber(scene.duration, `scenes[${index}].duration`),
      visual_strategy: visualStrategy,
      visual_prompt: text(scene.visual_prompt, `scenes[${index}].visual_prompt`),
      ...(optionalText(scene.visible_action, `scenes[${index}].visible_action`) !== undefined
        ? { visible_action: optionalText(scene.visible_action, `scenes[${index}].visible_action`)! }
        : {}),
      ...(optionalString(scene.on_screen_text, `scenes[${index}].on_screen_text`) !== undefined
        ? { on_screen_text: optionalString(scene.on_screen_text, `scenes[${index}].on_screen_text`)! }
        : {}),
      ...(optionalText(scene.sound_cue, `scenes[${index}].sound_cue`) !== undefined
        ? { sound_cue: optionalText(scene.sound_cue, `scenes[${index}].sound_cue`)! }
        : {}),
      ...(optionalStringArray(scene.success_criteria, `scenes[${index}].success_criteria`) !== undefined
        ? { success_criteria: optionalStringArray(scene.success_criteria, `scenes[${index}].success_criteria`)! }
        : {}),
      ...(optionalStringArray(scene.failure_conditions, `scenes[${index}].failure_conditions`) !== undefined
        ? { failure_conditions: optionalStringArray(scene.failure_conditions, `scenes[${index}].failure_conditions`)! }
        : {}),
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
  const canonFacts = optionalStringArray(input.canonFacts, "canonFacts");
  if (options.requireCanonFacts && (!canonFacts || canonFacts.length < 1 || canonFacts.length > 8)) {
    throw new Error("Series script drafts must contain between 1 and 8 canonFacts.");
  }
  return {
    ...(optionalText(input.viewerPromise, "viewerPromise") !== undefined
      ? { viewerPromise: optionalText(input.viewerPromise, "viewerPromise")! }
      : {}),
    ...(optionalText(input.narrativeArc, "narrativeArc") !== undefined
      ? { narrativeArc: optionalText(input.narrativeArc, "narrativeArc")! }
      : {}),
    ...(canonFacts ? { canonFacts } : {}),
    scenes,
  };
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

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value.trim();
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error(`${field} must be an array of 1 to 8 strings.`);
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
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
  return value === "stock" || value === "image" || value === "generated" || value === "local";
}
