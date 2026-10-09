import { isDeepStrictEqual } from "node:util";
import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution, type CodexTaskRequestOptions } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ProductionArticleSourceSnapshot, ProductionReworkFinding, ProductionSeriesContext, ProductionVisualPlan } from "./contracts.js";
import { assertDurationCommitment, durationIntentFor, PlanContractError, quantizeDurationsToFrames, validateContentLedDurationIntent, type DurationBounds, type DurationIntent } from "./executable-timeline.js";
import type { CreativeTreatment } from "./creative-treatment.js";
import type { PlanningIssue } from "./creative-planning.js";
import { summarizeProductionCapabilities, type ProductionCapabilities } from "./production-capabilities.js";
import { runCreativeDiscussionTask, type CreativeDiscussionAgentInput } from "./codex-creative-discussion.js";
import type { CreativeDiscussionResult } from "./creative-review.js";
import { CHARACTER_SCRIPT_VERSION, validateCharacterScript, type CharacterScript, type PresentationMode, type CharacterVoiceProfile } from "./character-script.js";

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

export interface NarrationScriptDraft {
  viewerPromise?: string;
  narrativeArc?: string;
  canonFacts?: string[];
  scenes: ScriptScene[];
}
export type ScriptDraft = NarrationScriptDraft | CharacterScript;

export interface ScreenwriterAgentInput {
  brief: DurationIntent & {
    presentationMode?: PresentationMode;
    characterVoiceProfiles?: CharacterVoiceProfile[];
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
    platform: string;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    visualProof?: string;
    visualIntent?: string;
    visualPlan?: ProductionVisualPlan;
    seriesContext?: ProductionSeriesContext;
    articleSources?: ProductionArticleSourceSnapshot[];
    creativeTreatment?: CreativeTreatment;
    planningIssues?: PlanningIssue[];
    productionCapabilities?: ProductionCapabilities;
    voiceTiming?: {
      rate: number;
      pauseScale: number;
    };
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
  /** R11 创作确认：初稿只生成；确认时只审传入的当前稿。 */
  /** OA-01：check 携带持久化的审计操作身份（进装配层 checkpoint key，恢复/新操作可区分）。 */
  creativeReviewExecution?: { mode: "draft" } | { mode: "check"; candidate: ScriptDraft; auditOperationId: string };
}

export interface ScreenwriterAgent {
  id: string;
  modelId?: string;
  draft(input: ScreenwriterAgentInput): Promise<unknown>;
  draftDetailed?(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>>;
  discussDetailed?(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>>;
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
export const SCREENWRITER_AGENT_CONTRACT_VERSION = "screenwriter-v22|role-audit-v9|script-validator-v5|visual-plan-v2|production-capabilities-v5|voice-timing-v1|creative-treatment-v2|canon-facts-v2|article-sources-v1|creator-paced-opening-v1|audit-capabilities-once-v1|character-script-v1|native-av-v1";

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
      { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...this.requestModel },
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
        ...(input.brief.presentationMode === "character_drama" ? ["角色动机与关系清楚，台词有来有往并推动情节；角色与台词 ID 在修改时稳定，出场与场外发言分开。内容意见不能要求把多人剧情降成单旁白。"] : []),
        "保持 creativeTreatment 的观众承诺、段落责任与 payoff；落实本次 planningIssues，事实边界一致。",
        "开场让具体对象、问题、动作或感受逐步成立，按片型与用户要求判断观看动机，不强迫统一秒数、冲突或提问。保留用户明确的静默与留白；逐段说明信息、行动或情绪如何推进，结尾兑现原承诺，不强加CTA或升华。重复导语不能冒充推进，有意审美停留不等于没有价值。",
        "脚本动作、旁白、屏幕文字、声音提示与时长协调；旁白可自然朗读，内部制作术语不进入观众表达。必要事实限定保留，冗长句先改写而不是加速或增加无职责镜头。",
        "素材/编辑要求符合 productionCapabilities；同母片源区间方案允许在覆盖可证的前提下交导演落实，独立生成不能冒充同一对象或真实实验。",
        "durationRange 优先，visualPlan、用户要求和系列约束一致；冲突不能通过静默跳过或捏造能力解决。",
        "canonFacts 必须是 0-8 条已建立事实；没有新增事实时为空数组，不能用计划或推测凑数；事实阈值与条件不因 hook 或总结被改成绝对断言。",
        "rework 的范围、findingId 与人工指令准确，未受影响内容保留，不宣称已经复验。",
        "修订复核上轮问题，不破坏已有兑现与能力约束；新的 blocking 有可引用依据而不是更换个人偏好。",
      ],
      maxIterations: input.creativeReviewExecution ? 1 : this.maxReviewIterations,
      ...(input.creativeReviewExecution?.mode === "draft" ? { deferAudit: true } : {}),
      ...(input.creativeReviewExecution?.mode === "check"
        ? { initialCandidate: input.creativeReviewExecution.candidate }
        : {}),
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("script-draft", {
        brief: screenwriterBriefForModel(input.brief),
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...this.requestModel, ...requestOptions }),
      // 审计刻意不带 requestModel：生产模型换成候选表里的另一个之后，独立复核仍应由 broker 的
      // 默认审计模型完成，否则"生产与复核用同一个模型"这件事会被换模型顺手破坏掉。
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

  async discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
    this.assertSelectedModel(input.selectedModelId);
    return runCreativeDiscussionTask(this.client, input);
  }

  private assertSelectedModel(selectedModelId: string | undefined): void {
    if (selectedModelId && selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${selectedModelId}' is not available for screenwriting.`);
    }
  }

  // 每个 (broker, 模型) 一个候选 agent，所以 agent 的 modelId 就是本次任务要在该 broker 上跑的模型，
  // 必须随请求声明出去。不声明的话 broker 跑的是它自己的默认模型，而收据上的 modelId 只是一句自述：
  // 没有任何东西会拿它和 broker 回执里的实际模型对账。
  // 请求的模型等于 broker 默认模型时，客户端会归一化成"没有覆盖"，所以这里的声明对现状是零影响。
  private get requestModel(): CodexTaskRequestOptions {
    return this.modelId ? { model: this.modelId } : {};
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
  const series = brief.seriesContext;
  const durationRange = effectiveScriptDurationRange(brief);
  const totalFrames = brief.durationPolicy === "content-led-v1"
    ? quantizeDurationsToFrames(candidate.scenes.map(scene => scene.duration)).reduce((total, frames) => total + frames, 0)
    : undefined;
  const totalDurationSeconds = totalFrames === undefined ? candidate.scenes.reduce((total, scene) => total + scene.duration, 0) : totalFrames / 30;
  let durationWithinRange = (durationRange?.minSeconds === undefined || totalDurationSeconds >= durationRange.minSeconds)
    && (durationRange?.maxSeconds === undefined || totalDurationSeconds <= durationRange.maxSeconds);
  if (totalFrames !== undefined) {
    try { assertDurationCommitment(totalFrames, durationRange); durationWithinRange = true; }
    catch (error) {
      if (!(error instanceof PlanContractError) || error.code !== "duration_commitment_conflict") throw error;
      durationWithinRange = false;
    }
  }
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
      ...(brief.presentationMode ? { presentationMode: brief.presentationMode } : {}),
      ...(brief.characterVoiceProfiles ? { characterVoiceProfiles: brief.characterVoiceProfiles } : {}),
      angle: brief.angle,
      audience: brief.audience,
      nicheSlug: brief.nicheSlug,
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(brief.creativeTreatment ? { creativeTreatment: brief.creativeTreatment } : {}),
      ...(brief.planningIssues ? { planningIssues: brief.planningIssues } : {}),
      ...(brief.articleSources?.length ? { articleSources: brief.articleSources } : {}),
      ...(brief.voiceTiming ? { voiceTiming: brief.voiceTiming } : {}),
      ...(reworkForAudit ? { rework: reworkForAudit } : {}),
    },
    currentRoleContract: {
      platform: brief.platform,
      ...durationIntentFor(brief),
      sceneCount: { min: 1, max: 24 },
      acceptedSceneDurationTotal: durationRange ?? null,
      candidateFacts: {
        sceneCount: candidate.scenes.length,
        totalDurationSeconds,
        ...(totalFrames !== undefined ? { totalFrames } : {}),
        durationRange: durationRange ? { ...durationRange } : null,
        durationWithinRange,
        canonFacts: {
          requiredField: true,
          allowedCount: { min: 0, max: 8 },
          actualCount: candidate.canonFacts?.length ?? 0,
          rule: "只记录已建立事实；没有新增事实时必须是空数组，不能为凑数量编造。",
        },
      },
      requiredSceneFields: ["position", ...(brief.presentationMode === "character_drama" ? ["character_ids", "dialogue"] : ["narration"]), "duration", "visual_strategy", "visual_prompt", "search_terms"],
      assetExecutionBoundary: {
        sourceRangeReuse: brief.productionCapabilities?.editing.sourceRangeReuse === true,
        crossSceneReuse: "允许导演把同一母片中已知且完整覆盖的不同源区间分配给多个 scene；不能凭复用创造母片不存在的状态。",
        continuousActionRule: "连续动作优先在同一母片内完成；跨 scene 方案必须由导演用可执行的源区间关系落地。",
      },
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
      ...(brief.voiceTiming ? { voiceTiming: brief.voiceTiming } : {}),
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
  effectiveScriptDurationRange(input.brief, "Screenwriter brief");
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
    ...durationIntentFor(input.brief),
    presentationMode: input.brief.presentationMode ?? "narration",
    requireCanonFacts: Boolean(input.brief.seriesContext),
  };
  const candidate = input.planningMode && input.creativeReviewExecution
    ? validateScriptDraftStructure(value, validation)
    : validateScriptDraft(value, validation);
  // joint 人工定稿流程只在这里核结构；返工范围由图层在采用前核验，越界候选留为提案。
  // 若在角色循环里拒绝范围，会误触结构重试并把整条制作打成 failed，用户拿不到原稿停点。
  if (input.planningMode && input.creativeReviewExecution?.mode === "draft") return candidate;
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

/** 人工决定前只验结构；明确承诺仍保留在宿主输入中，由停点呈现并在采用/执行时校验。 */
export function validateScriptDraftStructure(value: unknown, options: DurationIntent & {
  requireCanonFacts?: boolean;
  presentationMode?: PresentationMode;
}): ScriptDraft {
  if (options.durationPolicy !== "content-led-v1") return validateScriptDraft(value, options);
  validateContentLedDurationIntent(options);
  const { durationRange: _commitment, ...structure } = options;
  return validateScriptDraft(value, structure);
}

export function validateScriptDraft(value: unknown, options: DurationIntent & {
  requireCanonFacts?: boolean;
  presentationMode?: PresentationMode;
}): ScriptDraft {
  const candidate = record(value, "Script draft");
  if (candidate.version !== undefined && candidate.version !== CHARACTER_SCRIPT_VERSION) throw new Error("Unsupported script version.");
  if (candidate.version === CHARACTER_SCRIPT_VERSION) {
    if (options.presentationMode === "narration") throw new Error("角色剧本与解说视频形式不匹配。");
    return validateCharacterScript(value, options);
  }
  if (candidate.characters !== undefined || (Array.isArray(candidate.scenes) && candidate.scenes.some((s) =>
    typeof s === "object" && s !== null && ("dialogue" in s || "character_ids" in s)))) {
    throw new Error("角色字段必须携带明确的 character-script-v1 版本。");
  }
  if (options.presentationMode === "character_drama") throw new Error("角色剧情需要 character-script-v1，不能退回单旁白。");
  const durationRange = effectiveScriptDurationRange(options);
  const input = record(value, "Script draft");
  if (!Array.isArray(input.scenes)) throw new Error("Script draft scenes must be an array.");
  if (input.scenes.length < 1 || input.scenes.length > 24) {
    throw new Error(`Script draft must contain between 1 and 24 scenes; got ${input.scenes.length}.`);
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
    return parsed;
  }).sort((left, right) => left.position - right.position);
  scenes.forEach((scene, index) => {
    if (scene.position !== index + 1) {
      throw new Error("Script draft scene positions must be contiguous integers starting at 1.");
    }
  });
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (options.durationPolicy === "content-led-v1") {
    const frames = quantizeDurationsToFrames(scenes.map(scene => scene.duration));
    assertDurationCommitment(frames.reduce((sum, count) => sum + count, 0), durationRange, scenes.map(scene => scene.position));
  } else if (durationRange && (total < durationRange.minSeconds! || total > durationRange.maxSeconds!)) {
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
  intent: DurationIntent,
  field = "Script draft target",
): DurationBounds | undefined {
  if (intent.durationPolicy === "content-led-v1") return validateContentLedDurationIntent(intent);
  if (intent.durationPolicy !== undefined) throw new Error(`${field} durationPolicy is invalid.`);
  const { durationSeconds, durationRange } = intent;
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
