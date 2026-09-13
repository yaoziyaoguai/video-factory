import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import {
  CREATIVE_TREATMENT_TASK_KIND,
  lockCreativeTreatmentViewerPromise,
  parseCreativeTreatment,
  type CreativeTreatment,
} from "./creative-treatment.js";
import type { DurationRange } from "./executable-timeline.js";
import type { ProductionVisualPlan } from "./contracts.js";
import type { ShotGrammar } from "./reference-grammar.js";
import { summarizeProductionCapabilities, type ProductionCapabilities } from "./production-capabilities.js";

export interface CreativeTreatmentSource {
  sourceId: string;
  label: string;
  note?: string;
}

export interface CreativeTreatmentAgentInput {
  brief: {
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
    platform: string;
    durationSeconds: number;
    durationRange?: DurationRange;
    /** 用户或系列已接受的观众承诺；宿主锁定它并覆盖模型输出，没有时接受构思生成值。 */
    lockedViewerPromise?: string;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    visualProof?: string;
    visualPlan?: ProductionVisualPlan;
    productionCapabilities?: ProductionCapabilities;
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
}

export interface CreativeTreatmentAgent {
  id: string;
  modelId?: string;
  treat(input: CreativeTreatmentAgentInput): Promise<CreativeTreatment>;
  treatDetailed?(input: CreativeTreatmentAgentInput): Promise<CodexTaskExecution<CreativeTreatment>>;
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
export const CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION = "creative-treatment-v4|role-audit-v5|treatment-validator-v1|production-capabilities-v2|visual-plan-v2|planning-disposition-v1";

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
        "时长遵守本次明确范围，视觉/声音原则与已声明能力相容；未知素材风险诚实记录，不要求此阶段已经获得素材。",
        "事实来源、机制示意与情绪表达分开；suppliedSourceIds 只引用已有 id，来源缺口不伪装已证实。",
        "保质量后优化复用与成本；不以说明卡、无关图库或缩水承诺假装可行。",
        "修订解决既有问题且保留已合格职责；超出本角色可解范围的问题明确指向上游，不盲目循环。",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed(CREATIVE_TREATMENT_TASK_KIND, {
        ...treatmentPayload(input),
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, requestOptions, preparedOperation }) => preparedOperation
        ? auditClient.observePrepared(preparedOperation, requestOptions)
        : auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: treatmentAuditContext(input),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, undefined, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      validate: (value) => validateTreatmentCandidate(value, sourceIds, input),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
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
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.lockedViewerPromise ? { lockedViewerPromise: brief.lockedViewerPromise } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
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

function treatmentAuditContext(input: CreativeTreatmentAgentInput): Record<string, unknown> {
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
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.lockedViewerPromise ? { lockedViewerPromise: brief.lockedViewerPromise } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
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
      sourceReferenceRule: "suppliedSourceIds 只能引用 suppliedSources 中列出的 sourceId；无来源时保留空数组缺口",
      treatmentBoundary: "构思输出段落责任，不输出逐镜分镜，不写费用，不声称素材已经获得",
      productionCapabilities: brief.productionCapabilities ?? summarizeProductionCapabilities([]),
    },
    downstreamBoundary: "只审查构思是否建立可兑现的创作方向；不得要求尚未检索的图库候选、尚未生成的画面或下游费用确认作为当前节点的通过证据。",
  };
}
