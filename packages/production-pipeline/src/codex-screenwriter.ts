import { isDeepStrictEqual } from "node:util";
import type { ProductionBlueprint } from "@video-factory/template-core";
import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ProductionReworkFinding, ProductionSeriesContext, ProductionVisualPlan } from "./contracts.js";
import type { DurationRange } from "./executable-timeline.js";
import type { CreativeTreatment } from "./creative-treatment.js";
import type { PlanningIssue } from "./creative-planning.js";
import { summarizeProductionCapabilities, type ProductionCapabilities } from "./production-capabilities.js";
import { assertGeneratedVisualDoesNotClaimEvidence } from "./visual-evidence-boundary.js";

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
    durationRange?: DurationRange;
    templateBlueprint?: ProductionBlueprint;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    visualProof?: string;
    visualPlan?: ProductionVisualPlan;
    seriesContext?: ProductionSeriesContext;
    creativeTreatment?: CreativeTreatment;
    planningIssues?: PlanningIssue[];
    productionCapabilities?: ProductionCapabilities;
    rework?: {
      sourceRunId: string;
      instruction: string;
      findings: ProductionReworkFinding[];
      affectedScenePositions?: number[];
      previousScript?: Record<string, unknown>;
    };
  };
  selectedModelId?: string;
  /** 正式 joint creative-planning 开启机器可读的非局部审计处置。 */
  planningMode?: boolean;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  wallClockDeadlineAtMs?: number;
}

export interface ScreenwriterAgent {
  id: string;
  modelId?: string;
  draft(input: ScreenwriterAgentInput): Promise<unknown>;
  draftDetailed?(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>>;
}

export interface CodexScreenwriterAgentOptions {
  client?: CodexBridgeClient;
  auditClient?: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReviewIterations?: number;
  modelId?: string;
  sessionMode?: "stateful" | "stateless";
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_SCREENWRITER_TIMEOUT_MS = 660_000;
const DEFAULT_SCREENWRITER_MAX_ATTEMPTS = 2;
export const SCREENWRITER_AGENT_CONTRACT_VERSION = "screenwriter-v17|role-audit-v5|script-validator-v5|visual-plan-v2|production-capabilities-v2|canon-facts-v2";

// id 固定为 codex-screenwriter-v1：brief.providers.script 持久化该 id，registry 按 id 匹配 provider。
export class CodexScreenwriterAgent implements ScreenwriterAgent {
  readonly id = "codex-screenwriter-v1";
  readonly modelId: string;
  private readonly client: CodexBridgeClient;
  private readonly auditClient: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared"> | undefined;
  private readonly maxReviewIterations: number;
  private readonly sessionMode: "stateful" | "stateless";

  constructor(options: CodexScreenwriterAgentOptions) {
    this.modelId = options.modelId?.trim() || "codex-default";
    this.auditClient = options.auditClient;
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
    this.sessionMode = options.sessionMode ?? "stateful";
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
    this.assertSelectedModel(input.selectedModelId);
    validateScreenwriterTarget(input);
    const rawDraft = await this.client.runTask(
      "script-draft",
      { brief: screenwriterBriefForModel(input.brief) },
      undefined,
      requestOptionsForDeadline(input.wallClockDeadlineAtMs),
    );
    return validateScreenwriterCandidate(rawDraft, input, { iteration: 1, repair: false });
  }

  async draftDetailed(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<ScriptDraft>> {
    this.assertSelectedModel(input.selectedModelId);
    validateScreenwriterTarget(input);
    const auditClient = this.auditClient ?? this.client;
    return runRoleAgentLoop({
      role: "编剧",
      planningRole: input.planningMode === true,
      contractVersion: SCREENWRITER_AGENT_CONTRACT_VERSION,
      criteria: [
        "保持 creativeTreatment 的观众承诺、段落责任与 payoff；落实本次 planningIssues，事实边界一致。",
        "前两秒有具体吸引点，前六秒有与本片承诺相符的部分兑现；后段有推进，结尾不另起承诺。",
        "脚本动作、旁白、屏幕文字、声音提示与时长协调，可见成功条件具体；不靠加速或凑镜头塞内容。",
        "素材/编辑要求符合 productionCapabilities；同母片源区间方案允许在覆盖可证的前提下交导演落实，独立生成不能冒充同一对象或真实实验。",
        "durationRange 优先，模板必需职责、visualPlan 和系列约束一致；冲突不能通过静默跳过或捏造能力解决。",
        "canonFacts 必须是 0-8 条已建立事实；没有新增事实时为空数组，不能用计划或推测凑数；事实阈值与条件不因 hook 或总结被改成绝对断言。",
        "rework 的范围、findingId 与人工指令准确，未受影响内容保留，不宣称已经复验。",
        "修订复核上轮问题，不破坏已有兑现与能力约束；新的 blocking 有可引用依据而不是更换个人偏好。",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("script-draft", {
        brief: screenwriterBriefForModel(input.brief),
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, requestOptions, preparedOperation }) => preparedOperation
        ? auditClient.observePrepared(preparedOperation, requestOptions)
        : auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: screenwriterAuditContext(input.brief, candidate),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      // 每轮输入已经自包含完整候选、合同和上一轮结论；继承审计会话只会重复累积旧候选。
      }, requestId, undefined, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      validate: (value, context) => validateScreenwriterCandidate(value, input, context),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
  }

  private assertSelectedModel(selectedModelId: string | undefined): void {
    if (selectedModelId && selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${selectedModelId}' is not available for screenwriting.`);
    }
  }
}

function screenwriterBriefForModel(
  brief: ScreenwriterAgentInput["brief"],
): ScreenwriterAgentInput["brief"] & { productionCapabilities: ProductionCapabilities } {
  return {
    ...brief,
    productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
  };
}

function screenwriterAuditContext(
  brief: ScreenwriterAgentInput["brief"],
  candidate: ScriptDraft,
): Record<string, unknown> {
  const template = brief.templateBlueprint;
  const series = brief.seriesContext;
  const durationRange = effectiveScriptDurationRange(brief.durationSeconds, brief.durationRange);
  const totalDurationSeconds = candidate.scenes.reduce((total, scene) => total + scene.duration, 0);
  const reworkForAudit = brief.rework ? {
    sourceRunId: brief.rework.sourceRunId,
    instruction: brief.rework.instruction,
    findings: brief.rework.findings,
    ...(brief.rework.affectedScenePositions !== undefined
      ? { affectedScenePositions: brief.rework.affectedScenePositions }
      : {}),
  } : undefined;
  return {
    roleScope: {
      owns: ["viewerPromise", "narrativeArc", "canonFacts", "scenes"],
      doesNotOwn: ["素材实际命中", "画面生成结果", "配音成品", "渲染与终审结果"],
    },
    upstreamFacts: {
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      nicheSlug: brief.nicheSlug,
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(brief.creativeTreatment ? { creativeTreatment: brief.creativeTreatment } : {}),
      ...(brief.planningIssues ? { planningIssues: brief.planningIssues } : {}),
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
      ...(reworkForAudit ? { rework: reworkForAudit } : {}),
    },
    currentRoleContract: {
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      sceneCount: { min: 3, max: 24 },
      acceptedSceneDurationTotal: durationRange,
      candidateFacts: {
        sceneCount: candidate.scenes.length,
        totalDurationSeconds,
        durationRange: { ...durationRange },
        durationWithinRange: totalDurationSeconds >= durationRange.minSeconds
          && totalDurationSeconds <= durationRange.maxSeconds,
        canonFacts: {
          requiredField: true,
          allowedCount: { min: 0, max: 8 },
          actualCount: candidate.canonFacts?.length ?? 0,
          rule: "只记录已建立事实；没有新增事实时必须是空数组，不能为凑数量编造。",
        },
      },
      requiredSceneFields: ["position", "narration", "duration", "visual_strategy", "visual_prompt", "search_terms"],
      assetExecutionBoundary: {
        sourceRangeReuse: brief.productionCapabilities?.editing.sourceRangeReuse === true,
        crossSceneReuse: "允许导演把同一母片中已知且完整覆盖的不同源区间分配给多个 scene；不能凭复用创造母片不存在的状态。",
        continuousActionRule: "连续动作优先在同一母片内完成；跨 scene 方案必须由导演用可执行的源区间关系落地。",
      },
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
      ...(template ? {
        template: {
          automationLevel: template.automationLevel,
          storyStructure: template.storyStructure.map(({ id, purpose, required }) => ({ id, purpose, required })),
          shotSlots: template.shotSlots.map(({ id, beatId, purpose, durationSeconds, allowedCapabilities }) => ({
            id,
            beatId,
            purpose,
            durationSeconds,
            allowedCapabilities,
          })),
          qualityRules: template.qualityRules.map(({ label, dimension, required, threshold }) => ({ label, dimension, required, threshold })),
        },
      } : {}),
    },
    downstreamBoundary: "只审查脚本是否给下游提供可执行意图；不得要求尚未执行的素材、配音、渲染或审片结果作为当前节点通过证据。",
    ...(series ? {
      seriesContinuity: {
        seriesName: series.seriesName,
        episodeNumber: series.episodeNumber,
        premise: series.premise,
        arc: series.arc,
        episode: {
          pillar: series.episode.pillar,
          viewerPromise: series.episode.viewerPromise,
          hook: series.episode.hook,
          payoff: series.episode.payoff,
        },
        bible: series.bible,
        acceptedCanonFacts: series.canon.facts.map(({ statement }) => statement),
        continuity: series.continuity,
      },
    } : {}),
    ...(brief.rework ? {
      verificationBoundary: "findingId 仅追踪修改要求；只有后续视觉审片的新报告批准后才算 verified，当前编剧审计不得宣称已复验。",
    } : {}),
  };
}

function validateScreenwriterTarget(input: ScreenwriterAgentInput): void {
  effectiveScriptDurationRange(input.brief.durationSeconds, input.brief.durationRange, "Screenwriter brief");
  const affected = input.brief.rework?.affectedScenePositions;
  if (affected !== undefined && (affected.length > 100
    || affected.some((position) => !Number.isInteger(position) || position < 1)
    || new Set(affected).size !== affected.length)) {
    throw new Error("Screenwriter rework affectedScenePositions must contain unique positive integers.");
  }
}

function validateScreenwriterCandidate(
  value: unknown,
  input: ScreenwriterAgentInput,
  context: { iteration: number; repair: boolean },
): ScriptDraft {
  const validation = {
    durationSeconds: input.brief.durationSeconds,
    ...(input.brief.durationRange ? { durationRange: input.brief.durationRange } : {}),
    requireCanonFacts: Boolean(input.brief.seriesContext),
  };
  const candidate = validateScriptDraft(value, validation);
  const rework = input.brief.rework;
  if (!rework?.previousScript || rework.affectedScenePositions === undefined) {
    return candidate;
  }

  const wholeScriptRevisionAuthorized = rework.findings.some((finding) => (
    finding.scenePosition === undefined
    && finding.targetNodeIds.includes("script")
    && finding.action !== "inspect_existing_media"
  ));
  if (wholeScriptRevisionAuthorized) return candidate;

  const previous = validateScriptDraft(rework.previousScript, validation);
  if (rework.affectedScenePositions.length === 0) {
    if (!isDeepStrictEqual(candidate, previous)) {
      throw new Error("Screenwriter rework with empty affectedScenePositions must reuse the verified previous script before model execution.");
    }
    return candidate;
  }
  const previousPositions = new Set(previous.scenes.map((scene) => scene.position));
  const candidateByPosition = new Map(candidate.scenes.map((scene) => [scene.position, scene]));
  if (candidate.scenes.length !== previous.scenes.length
    || rework.affectedScenePositions.some((position) => !previousPositions.has(position))) {
    throw new Error("Scoped script rework must preserve the previous scene positions.");
  }
  const affected = new Set(rework.affectedScenePositions);
  // 未受影响镜头可能直接复用上一版付费母片；由宿主确定性保留，不能依赖模型自觉不改写。
  return validateScriptDraft({
    ...previous,
    scenes: previous.scenes.map((scene) => affected.has(scene.position)
      ? candidateByPosition.get(scene.position) ?? scene
      : scene),
  }, validation);
}

export function validateScriptDraft(value: unknown, options: {
  durationSeconds: number;
  durationRange?: DurationRange;
  requireCanonFacts?: boolean;
}): ScriptDraft {
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
    const parsed = {
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
    if (parsed.visual_strategy === "generated") {
      assertGeneratedVisualDoesNotClaimEvidence([
        parsed.purpose,
        parsed.narration,
        parsed.visual_prompt,
        parsed.visible_action,
        parsed.on_screen_text,
        ...(parsed.success_criteria ?? []),
        ...(parsed.failure_conditions ?? []),
      ], `scenes[${index}]`);
    }
    return parsed;
  }).sort((left, right) => left.position - right.position);
  scenes.forEach((scene, index) => {
    if (scene.position !== index + 1) {
      throw new Error("Script draft scene positions must be contiguous integers starting at 1.");
    }
  });
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const durationRange = effectiveScriptDurationRange(options.durationSeconds, options.durationRange, "Script draft target");
  if (total < durationRange.minSeconds || total > durationRange.maxSeconds) {
    const rangeDescription = options.durationRange
      ? `the ${durationRange.minSeconds}-${durationRange.maxSeconds}s duration range`
      : `0.6-1.4x of the ${options.durationSeconds}s target`;
    throw new Error(`Script draft total duration ${total}s is outside ${rangeDescription}.`);
  }
  const canonFacts = optionalStringArray(input.canonFacts, "canonFacts", 0);
  if (options.requireCanonFacts && !canonFacts) {
    throw new Error("Series script drafts must contain a canonFacts array with at most 8 entries.");
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

function effectiveScriptDurationRange(
  durationSeconds: number,
  durationRange?: DurationRange,
  field = "Script draft target",
): DurationRange {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > 180) {
    throw new Error(`${field} durationSeconds must be an integer between 20 and 180.`);
  }
  if (!durationRange) {
    return { minSeconds: durationSeconds * 0.6, maxSeconds: durationSeconds * 1.4 };
  }
  if (!Number.isInteger(durationRange.minSeconds) || !Number.isInteger(durationRange.maxSeconds)
    || durationRange.minSeconds < 20 || durationRange.maxSeconds > 180
    || durationRange.minSeconds > durationRange.maxSeconds) {
    throw new Error(`${field} durationRange must use ordered integer bounds between 20 and 180.`);
  }
  if (durationSeconds < durationRange.minSeconds || durationSeconds > durationRange.maxSeconds) {
    throw new Error(`${field} durationSeconds must fall within durationRange.`);
  }
  return { ...durationRange };
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

function optionalStringArray(value: unknown, field: string, minimum = 1): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < minimum || value.length > 8) {
    throw new Error(`${field} must be an array of ${minimum} to 8 strings.`);
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
