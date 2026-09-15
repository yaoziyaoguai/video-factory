import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import {
  CREATIVE_TREATMENT_TASK_KIND,
  lockCreativeTreatmentViewerPromise,
  parseCreativeTreatment,
  type CreativeTreatment,
} from "./creative-treatment.js";
import type { DurationRange } from "./executable-timeline.js";
import type { ProductionSeriesContext, ProductionVisualPlan } from "./contracts.js";
import type { ShotGrammar } from "./reference-grammar.js";
import { summarizeProductionCapabilities, type ProductionCapabilities } from "./production-capabilities.js";
import { assessTreatmentReadiness, type TreatmentReadiness } from "./treatment-readiness.js";
import { runCreativeDiscussionTask, type CreativeDiscussionAgentInput } from "./codex-creative-discussion.js";
import type { CreativeDiscussionResult } from "./creative-review.js";

export interface CreativeTreatmentSource {
  sourceId: string;
  label: string;
  note?: string;
}

/**
 * 前期构思只消费会改变本集创作的系列事实。运行预约、模型审计和更新时间等运营元数据
 * 不进入角色输入或阶段身份，避免无关变更让已完成构思失效。
 */
export interface CreativeTreatmentSeriesContext {
  seriesName: string;
  seasonNumber: number;
  episodeNumber: number;
  premise: string;
  track: string;
  arc: string;
  episode: {
    pillar: string;
    title: string;
    viewerPromise: string;
    hook: string;
    payoff: string;
  };
  bible: ProductionSeriesContext["bible"];
  canon: ProductionSeriesContext["canon"];
  continuity: ProductionSeriesContext["continuity"];
}

export function creativeTreatmentSeriesContext(
  context: ProductionSeriesContext | undefined,
): CreativeTreatmentSeriesContext | undefined {
  if (!context) return undefined;
  return {
    seriesName: context.seriesName,
    seasonNumber: context.seasonNumber,
    episodeNumber: context.episodeNumber,
    premise: context.premise,
    track: context.track,
    arc: context.arc,
    episode: {
      pillar: context.episode.pillar,
      title: context.episode.title,
      viewerPromise: context.episode.viewerPromise,
      hook: context.episode.hook,
      payoff: context.episode.payoff,
    },
    bible: {
      rules: [...context.bible.rules],
      recurringElements: [...context.bible.recurringElements],
      forbiddenChanges: [...context.bible.forbiddenChanges],
    },
    canon: {
      revision: context.canon.revision,
      facts: context.canon.facts.map((fact) => ({
        ...fact,
        ...(fact.sourceOutputVersionIds ? { sourceOutputVersionIds: [...fact.sourceOutputVersionIds] } : {}),
      })),
    },
    continuity: {
      inheritedFromPrevious: [...context.continuity.inheritedFromPrevious],
      fromPrevious: [...context.continuity.fromPrevious],
      toNext: [...context.continuity.toNext],
      canonChecks: [...context.continuity.canonChecks],
      ...(context.continuity.memorySummary ? { memorySummary: context.continuity.memorySummary } : {}),
    },
  };
}

export interface CreativeTreatmentAgentInput {
  brief: {
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
    platform: string;
    durationSeconds: number;
    budgetIntentionCny?: number;
    durationRange?: DurationRange;
    /** 用户或系列已接受的观众承诺；宿主锁定它并覆盖模型输出，没有时接受构思生成值。 */
    lockedViewerPromise?: string;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    visualProof?: string;
    visualIntent?: string;
    /** 仅限构思角色负责的本轮返工要求；不得携带完整跨角色返工包。 */
    reworkInstruction?: string;
    visualPlan?: ProductionVisualPlan;
    productionCapabilities?: ProductionCapabilities;
    /** 已确认且与本集创作有关的系列事实；不包含预约和模型运行元数据。 */
    seriesContext?: CreativeTreatmentSeriesContext;
  };
  suppliedSources: CreativeTreatmentSource[];
  /** 已接受参考视频的镜头语法：风格/结构参考。它不是事实证据，不得当成本片已验证素材。 */
  referenceGrammar?: ShotGrammar;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  /** 每个候选模型各自的 durable checkpoint：fallback 切换后中间角色状态仍可恢复。 */
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  /** 与编剧/导演同一合同：只改变候选顺序，不创建新的模型路由器。 */
  selectedModelId?: string;
  /** 正式 joint creative-planning 开启机器可读的非局部审计处置。 */
  planningMode?: boolean;
  wallClockDeadlineAtMs?: number;
  /** R11 创作确认：初稿只生成；确认时只审传入的当前稿。 */
  creativeReviewExecution?: { mode: "draft" } | { mode: "check"; candidate: CreativeTreatment };
}

export interface CreativeTreatmentAgent {
  id: string;
  modelId?: string;
  treat(input: CreativeTreatmentAgentInput): Promise<CreativeTreatment>;
  treatDetailed?(input: CreativeTreatmentAgentInput): Promise<CodexTaskExecution<CreativeTreatment>>;
  discussDetailed?(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>>;
}

export interface CodexCreativeTreatmentAgentOptions {
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
const DEFAULT_TREATMENT_TIMEOUT_MS = 660_000;
const DEFAULT_TREATMENT_MAX_ATTEMPTS = 2;
export const CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION = "creative-treatment-v8|role-audit-v8|treatment-validator-v2|production-capabilities-v3|visual-plan-v2|planning-disposition-v1|host-readiness-v2|rework-instruction-v1|series-context-v1";

// id 固定为 codex-creative-treatment-v1：构思产物登记来源时按该 id 标注。
export class CodexCreativeTreatmentAgent implements CreativeTreatmentAgent {
  readonly id = "codex-creative-treatment-v1";
  readonly modelId: string;
  private readonly client: CodexBridgeClient;
  private readonly auditClient: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared"> | undefined;
  private readonly maxReviewIterations: number;
  private readonly sessionMode: "stateful" | "stateless";

  constructor(options: CodexCreativeTreatmentAgentOptions) {
    this.modelId = options.modelId?.trim() || "codex-default";
    this.auditClient = options.auditClient;
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
    this.sessionMode = options.sessionMode ?? "stateful";
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.socketPath) {
        throw new Error("CodexCreativeTreatmentAgent requires a CodexBridgeClient or a socketPath.");
      }
      this.client = new CodexBridgeClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_TREATMENT_TIMEOUT_MS,
        maxAttempts: options.maxAttempts ?? DEFAULT_TREATMENT_MAX_ATTEMPTS,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      });
    }
  }

  // 模型输出为 unknown：先经 parseCreativeTreatment 硬校验，malformed/不合法直接抛错，没有任何 fallback。
  async treat(input: CreativeTreatmentAgentInput): Promise<CreativeTreatment> {
    const sourceIds = validateTreatmentInput(input);
    const rawTreatment = await this.client.runTask(
      CREATIVE_TREATMENT_TASK_KIND,
      treatmentPayload(input),
      undefined,
      requestOptionsForDeadline(input.wallClockDeadlineAtMs),
    );
    return validateTreatmentCandidate(rawTreatment, sourceIds, input);
  }

  async treatDetailed(input: CreativeTreatmentAgentInput): Promise<CodexTaskExecution<CreativeTreatment>> {
    const sourceIds = validateTreatmentInput(input);
    const auditClient = this.auditClient ?? this.client;
    return runRoleAgentLoop({
      role: "导演前期构思",
      planningRole: input.planningMode === true,
      contractVersion: CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION,
      criteria: [
        "观众承诺具体，与用户/系列锁定目标实质一致；hook、progression、payoff 能形成完整体验。",
        "每段有新增信息、情绪或必要承接，beatId 稳定；不把段落机械等同镜头。",
        "时长遵守本次明确范围，视觉/声音原则与已声明能力相容；普通素材不要求提前下载，但核心制作前提必须有可信获取责任。",
        "事实来源、机制示意与情绪表达分开；critical、acquisition 与 retrievalProviderId 可信，suppliedSourceIds 只引用已有 id，来源缺口不伪装已证实。",
        "保质量后优化复用与成本；不以说明卡、无关图库或缩水承诺假装可行。",
        "修订解决既有问题且保留已合格职责；超出本角色可解范围的问题明确指向上游，不盲目循环。",
      ],
      maxIterations: input.creativeReviewExecution ? 1 : this.maxReviewIterations,
      ...(input.creativeReviewExecution?.mode === "draft" ? { deferAudit: true } : {}),
      ...(input.creativeReviewExecution?.mode === "check"
        ? { initialCandidate: input.creativeReviewExecution.candidate }
        : {}),
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed(CREATIVE_TREATMENT_TASK_KIND, {
        ...treatmentPayload(input),
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      assessPlanningReadiness: (candidate) => assessTreatmentReadiness(
        candidate,
        input.suppliedSources,
        input.brief.productionCapabilities ?? summarizeProductionCapabilities([]),
      ),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, hostReadiness, requestId, requestOptions, preparedOperation }) => preparedOperation
        ? auditClient.observePrepared(preparedOperation, requestOptions)
        : auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: treatmentAuditContext(input, hostReadiness),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, undefined, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      validate: (value) => validateTreatmentCandidate(value, sourceIds, input),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
  }

  async discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
    if (input.selectedModelId && input.selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${input.selectedModelId}' is not available for treatment discussion.`);
    }
    return runCreativeDiscussionTask(this.client, input);
  }
}

function treatmentPayload(input: CreativeTreatmentAgentInput): Record<string, unknown> {
  const { brief } = input;
  return {
    brief: {
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      nicheSlug: brief.nicheSlug,
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.lockedViewerPromise ? { lockedViewerPromise: brief.lockedViewerPromise } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.reworkInstruction ? { reworkInstruction: brief.reworkInstruction } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
    },
    suppliedSources: input.suppliedSources.map((source) => ({
      sourceId: source.sourceId,
      label: source.label,
      ...(source.note ? { note: source.note } : {}),
    })),
    // 参考语法是风格/结构参考，单独传递并声明性质：不得冒充本片已验证的事实素材。
    ...(input.referenceGrammar ? { referenceGrammar: { ...input.referenceGrammar, evidenceStatus: "style_structure_reference" } } : {}),
  };
}

function validateTreatmentCandidate(
  value: unknown,
  suppliedSourceIds: string[],
  input: CreativeTreatmentAgentInput,
): CreativeTreatment {
  const treatment = parseCreativeTreatment(value, suppliedSourceIds);
  return input.brief.lockedViewerPromise
    ? lockCreativeTreatmentViewerPromise(treatment, input.brief.lockedViewerPromise)
    : treatment;
}

function validateTreatmentInput(input: CreativeTreatmentAgentInput): string[] {
  const { brief } = input;
  for (const field of ["title", "angle", "audience", "nicheSlug", "platform"] as const) {
    if (!brief[field].trim()) throw new Error(`Creative treatment brief.${field} must be a non-empty string.`);
  }
  if (!Number.isInteger(brief.durationSeconds) || brief.durationSeconds < 20 || brief.durationSeconds > 180) {
    throw new Error("Creative treatment brief.durationSeconds must be an integer between 20 and 180.");
  }
  if (brief.durationRange
    && (!Number.isInteger(brief.durationRange.minSeconds) || !Number.isInteger(brief.durationRange.maxSeconds)
      || brief.durationRange.minSeconds < 20 || brief.durationRange.maxSeconds > 180
      || brief.durationRange.minSeconds > brief.durationRange.maxSeconds)) {
    throw new Error("Creative treatment brief.durationRange must use ordered integer bounds between 20 and 180.");
  }
  if (brief.lockedViewerPromise !== undefined && !brief.lockedViewerPromise.trim()) {
    throw new Error("Creative treatment brief.lockedViewerPromise must be a non-empty string when provided.");
  }
  if (brief.reworkInstruction !== undefined) {
    if (!brief.reworkInstruction.trim()) {
      throw new Error("Creative treatment brief.reworkInstruction must be a non-empty string when provided.");
    }
    if (brief.reworkInstruction.length > 6_000) {
      throw new Error("Creative treatment brief.reworkInstruction must contain at most 6000 characters.");
    }
  }
  if (!Array.isArray(input.suppliedSources) || input.suppliedSources.length > 24) {
    throw new Error("Creative treatment suppliedSources must contain at most 24 entries.");
  }
  const seen = new Set<string>();
  for (const source of input.suppliedSources) {
    const sourceId = source.sourceId?.trim();
    if (!sourceId) throw new Error("Creative treatment suppliedSources sourceId must be a non-empty string.");
    if (seen.has(sourceId)) {
      throw new Error(`Creative treatment suppliedSources sourceId '${sourceId}' must be unique.`);
    }
    seen.add(sourceId);
    if (!source.label?.trim()) {
      throw new Error(`Creative treatment suppliedSources '${sourceId}' label must be a non-empty string.`);
    }
  }
  return [...seen];
}

function treatmentAuditContext(
  input: CreativeTreatmentAgentInput,
  hostReadiness?: TreatmentReadiness,
): Record<string, unknown> {
  const { brief } = input;
  return {
    roleScope: {
      owns: ["hook", "progression", "payoff", "visualPrinciples", "soundPrinciples", "evidenceRequirements", "feasibilityQuestions"],
      doesNotOwn: ["素材实际下载与生成结果", "逐镜分镜", "配音与渲染成品", "费用与授权"],
      ...(brief.lockedViewerPromise
        ? { viewerPromise: "由用户或系列锁定，宿主覆盖模型字段；只审实质一致性，不要求逐字重复" }
        : { viewerPromise: "无上游承诺时由本任务生成" }),
    },
    upstreamFacts: {
      ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.lockedViewerPromise ? { lockedViewerPromise: brief.lockedViewerPromise } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.reworkInstruction ? { reworkInstruction: brief.reworkInstruction } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
      ...(hostReadiness ? { hostReadiness } : {}),
      ...(input.referenceGrammar
        ? { referenceGrammar: { ...input.referenceGrammar, evidenceStatus: "style_structure_reference" } }
        : {}),
      suppliedSources: input.suppliedSources.map((source) => ({
        sourceId: source.sourceId,
        label: source.label,
        ...(source.note ? { note: source.note } : {}),
      })),
    },
    currentRoleContract: {
      progressionBounds: { min: 1, max: 12 },
      principleBounds: { min: 1, max: 8 },
      evidenceRequirementValues: ["factual_support", "illustration_only"],
      acquisitionValues: ["supplied", "pipeline_retrievable", "external_required", "not_needed"],
      sourceReferenceRule: "suppliedSourceIds 只能引用 suppliedSources 中列出的 sourceId；无来源时保留空数组缺口",
      treatmentBoundary: "构思输出段落责任，不输出逐镜分镜，不写费用，不声称素材已经获得",
      budgetBoundary: "预算意向不是硬上限或付款授权，不得因为尚未批准费用而阻止讨论与规划；质量和事实边界不因降本而降低",
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
    },
    downstreamBoundary: "只审查构思是否建立可兑现的创作方向；不得要求尚未检索的图库候选、尚未生成的画面或下游费用确认作为当前节点的通过证据。",
  };
}
