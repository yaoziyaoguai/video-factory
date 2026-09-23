import { createHash } from "node:crypto";
import { REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } from "./codex-chat.js";
import type { DurationRange } from "./executable-timeline.js";

export const BRIEF_PROTOCOL_VERSION = "video-factory/brief-v1" as const;
export const WORKER_PROTOCOL_VERSION = "video-factory/worker-v1" as const;
const PRODUCTION_PLATFORMS = ["douyin", "xiaohongshu", "bilibili"] as const;

export interface ProductionProviderBindings {
  script: string;
  director?: string;
  assets: string;
  voice: string;
  render: string;
  technicalReview: string;
  visualReview?: string;
}

export type ProductionRecipeId = "economy-daily" | "free-stock" | "keyshot-ai" | "cinematic-ai" | "custom";

export interface ProductionEconomics {
  recipeId: ProductionRecipeId;
  allowMeteredProviders: boolean;
  /** @deprecated 历史 brief 兼容字段；逐笔报价与人工授权已取代全片限额。 */
  maxPaidShots?: number;
  /** @deprecated 历史 brief 兼容字段；逐笔报价与人工授权已取代全片限额。 */
  maxCostCny?: number;
}

export type ProductionSpendFeedbackReason = "too_expensive" | "provider_mix" | "plan_not_approved" | "other";

export interface ProductionSpendFeedback {
  spendPlanId: string;
  nodeId: string;
  reason: ProductionSpendFeedbackReason;
  previousEstimatedCostCny: number;
  targetEstimatedCostCny?: number;
  note?: string;
  rejectedBy: string;
  rejectedAt: string;
}

export const PRODUCTION_DIRECTOR_PROFILE_IDS = [
  "auto",
  "documentary-observer",
  "quiet-humanism",
  "urban-poetic",
  "chromatic-storytelling",
  "geometric-control",
  "suspense-staging",
] as const;

export type ProductionDirectorProfileId = (typeof PRODUCTION_DIRECTOR_PROFILE_IDS)[number];

export interface ProductionDirectorDirection {
  profileId: ProductionDirectorProfileId;
  assetProviderIds: string[];
}

export type ProductionMasteringPreset = "natural" | "intimate" | "social";

export interface ProductionVoiceDirection {
  profileId: string;
  rate: number;
  pauseScale: number;
  masteringPreset: ProductionMasteringPreset;
}

export type ProductionArticleReadStatus = "read" | "partial" | "title_only" | "blocked" | "failed";

/** 由 Studio 服务端保存并投影的热点正文快照；客户端不能自行声明已核实。 */
export interface ProductionArticleSourceSnapshot {
  sourceId: string;
  originalUrl: string;
  finalUrl: string;
  pageTitle: string;
  fetchedAt: string;
  publishedAt?: string;
  contentSha256?: string;
  extractorVersion: string;
  readStatus: ProductionArticleReadStatus;
  reason?: string;
  paragraphs: Array<{ id: string; text: string }>;
  truncated: boolean;
}

export interface VoiceDoesNotFitConflict {
  code: "VOICE_DOES_NOT_FIT";
  scenePosition: number;
  plannedSeconds: number;
  speechSeconds: number;
  requiredSeconds: number;
  executablePlanPath?: string;
  operationId?: string;
  audioArtifact: {
    kind: "voiceover_raw";
    uri: string;
    sha256: string;
    sizeBytes: number;
    contentType: string;
  };
}

export function parseVoiceDoesNotFitConflict(value: unknown): VoiceDoesNotFitConflict {
  const input = requireRecord(value, "voice timing conflict");
  if (input.code !== "VOICE_DOES_NOT_FIT") {
    throw new Error("voice timing conflict code must be 'VOICE_DOES_NOT_FIT'.");
  }
  const scenePosition = boundedNumber(input.scenePosition, "voice timing conflict scenePosition", 1, 10_000, true);
  const plannedSeconds = boundedNumber(input.plannedSeconds, "voice timing conflict plannedSeconds", 0.001, 180, false);
  const speechSeconds = boundedNumber(
    input.speechSeconds,
    "voice timing conflict speechSeconds",
    0.001,
    Number.MAX_SAFE_INTEGER,
    false,
  );
  const requiredSeconds = boundedNumber(
    input.requiredSeconds,
    "voice timing conflict requiredSeconds",
    0.001,
    Number.MAX_SAFE_INTEGER,
    false,
  );
  if (requiredSeconds <= plannedSeconds || requiredSeconds < speechSeconds) {
    throw new Error("voice timing conflict requiredSeconds must exceed the accepted cut and cover the speech.");
  }
  const artifact = requireRecord(input.audioArtifact, "voice timing conflict audioArtifact");
  if (artifact.kind !== "voiceover_raw") {
    throw new Error("voice timing conflict audioArtifact.kind must be 'voiceover_raw'.");
  }
  const sha256 = requireString(artifact.sha256, "voice timing conflict audioArtifact.sha256");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("voice timing conflict audioArtifact.sha256 must be a 64-character hexadecimal digest.");
  }
  const sizeBytes = boundedNumber(
    artifact.sizeBytes,
    "voice timing conflict audioArtifact.sizeBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const executablePlanPath = input.executablePlanPath === undefined
    ? undefined
    : requireString(input.executablePlanPath, "voice timing conflict executablePlanPath");
  const operationId = input.operationId === undefined
    ? undefined
    : requireString(input.operationId, "voice timing conflict operationId");
  return {
    code: "VOICE_DOES_NOT_FIT",
    scenePosition,
    plannedSeconds,
    speechSeconds,
    requiredSeconds,
    ...(executablePlanPath ? { executablePlanPath } : {}),
    ...(operationId ? { operationId } : {}),
    audioArtifact: {
      kind: "voiceover_raw",
      uri: requireString(artifact.uri, "voice timing conflict audioArtifact.uri"),
      sha256,
      sizeBytes,
      contentType: requireString(artifact.contentType, "voice timing conflict audioArtifact.contentType"),
    },
  };
}

export interface ProductionEditorialDirection {
  verdict: "produce_video" | "produce_image_story";
  reasons: string[];
  guardrails: string[];
}

export type ProductionVisualSource = "creator" | "stock" | "screen" | "local-card" | "generated";

export interface ProductionVisualBeat {
  id: string;
  role: string;
  duration: string;
  description: string;
  searchQuery: string;
  source: ProductionVisualSource;
}

export interface ProductionVisualPlan {
  strategy: string;
  beats: ProductionVisualBeat[];
}

export interface ProductionReworkFinding {
  findingId: string;
  timecodeMs: number;
  startTimecodeMs?: number;
  endTimecodeMs?: number;
  scenePosition?: number;
  /** 这条问题要靠哪类证据判定；见 VisualReviewFinding.claimType。缺失表示旧版报告，不代表 static。 */
  claimType?: "static" | "motion" | "non_visual";
  evidenceStatus?: "satisfied" | "failed" | "not_observed" | "not_applicable";
  evidenceFrameSha256?: string | null;
  nextAction?: "inspect_existing_media" | "replan_upstream" | "rework_asset" | "none";
  category: string;
  description: string;
  suggestion: string;
  /**
   * 审片意见指名真实节点时一并指名的那一段。重做代价依次收窄，所以它随意见一起持久化，
   * 不能在编译返工计划时丢掉——丢了就只剩一句笼统的"方案有问题"。
   */
  planningStageId?: "treatment" | "script" | "director";
  targetNodeIds: Array<"script" | "visual-direction" | "assets">;
  primaryOwnerNodeId?: "script" | "visual-direction" | "assets";
  affectedNodeIds?: Array<"script" | "visual-direction" | "assets">;
  action?: "inspect_existing_media" | "replan_upstream" | "replace_asset";
  sourceReviewStage?: "source_assets" | "rendered_video";
  sourceReviewNodeId?: string;
  sourceReviewVersionId?: string;
  reviewEvidenceId?: string;
  actualModels?: Array<{ providerId: string; modelId: string }>;
  current?: boolean;
}

export interface ProductionReworkPlan {
  version: "video-factory/rework-plan-v1";
  planDigest: string;
  source: {
    runId: string;
    runRevision: number;
    reviewEvidenceIds: string[];
  };
  requirements: Array<{
    findingId: string;
    primaryOwnerNodeId: "script" | "visual-direction" | "assets";
    affectedNodeIds: Array<"script" | "visual-direction" | "assets">;
    action: "inspect_existing_media" | "replan_upstream" | "replace_asset";
    scenePositions: number[];
  }>;
  sceneActions: Array<{
    scenePosition: number;
    action: "inspect" | "retain" | "reuse" | "generate" | "blocked";
    reasonFindingIds: string[];
  }>;
  nodeInstructions: {
    script: string;
    visualDirection: string;
    assets: string;
  };
}

export interface ProductionReworkContext {
  sourceRunId: string;
  sourceRunRevision: number;
  rejectionReason?: string;
  affectedScenePositions?: number[];
  nodeInstructions: {
    /** 空串表示编剧未被点名（media/director-only 返工），跨 run seed 据此继承编剧阶段。 */
    script: string;
    visualDirection: string;
    assets: string;
  };
  findings: ProductionReworkFinding[];
  plan?: ProductionReworkPlan;
  previousScript?: Record<string, unknown>;
  previousDirectorPlan?: Record<string, unknown>;
}

export interface ProductionWorkflowFeatures {
  assetSemanticRank: boolean;
  referenceGrammar: boolean;
  executablePlan?: boolean;
  /** joint-v1 共同创作规划标记：仅由新制作入口显式写入，parser 不为缺失字段补标。 */
  creativePlanning?: "joint-v1";
  /** 新制作强制启用的三阶段用户确认合同。 */
  creativeReview?: "user-confirmed-v1";
  /** 每个节点边界都停下等用户放行的合同：仅由新制作入口显式写入，缺失即维持原自动推进。 */
  boundaryGates?: "user-confirmed-v1";
}

export type ProductionModelSelectionSource = "system_default" | "global_default" | "template_default" | "run_override" | "node_override";

/**
 * 新建制作时冻结的模型选择。节点工作区临时覆盖模型后，清除覆盖必须回到这份
 * run 自己的起点，而不是读取后来被人改过的全局默认。
 */
export interface ProductionFrozenModelSelection {
  modelId: string;
  source: Exclude<ProductionModelSelectionSource, "node_override">;
}

export interface ProductionReferenceVideo {
  uploadId: string;
  label: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/webm";
  sizeBytes: number;
  sha256: string;
  path: string;
}

export interface ProductionSeriesContext {
  seriesId: string;
  episodeId: string;
  seriesName: string;
  seriesRevision: number;
  episodeNumber: number;
  seasonNumber: number;
  canonBaseRevision: number;
  productionReservationId?: string;
  premise: string;
  audience: string;
  platform: string;
  track: string;
  arc: string;
  episode: {
    updatedAt: string;
    pillar: string;
    title: string;
    viewerPromise: string;
    hook: string;
    payoff: string;
    planning: {
      source: "agent" | "rules" | "human";
      role: string;
      auditRole: string;
      auditStatus: "passed" | "fallback" | "human_override";
      auditIterations: number;
      auditScore?: number;
      auditSummary?: string;
      providerId: string;
      modelId: string;
      promptVersion: string;
      reasoningEffort?: string;
      fallbackReason?: string;
    };
  };
  bible: {
    rules: string[];
    recurringElements: string[];
    forbiddenChanges: string[];
  };
  canon: {
    revision: number;
    facts: Array<{
      id: string;
      statement: string;
      sourceEpisodeId: string;
      sourceRunId?: string;
      sourceRunRevision?: number;
      sourceOutputVersionIds?: string[];
      acceptedAt: string;
    }>;
  };
  continuity: {
    inheritedFromPrevious: string[];
    fromPrevious: string[];
    toNext: string[];
    canonChecks: string[];
    memorySummary?: string;
  };
}

export interface ProductionBrief {
  protocolVersion: typeof BRIEF_PROTOCOL_VERSION;
  title: string;
  angle: string;
  audience: string;
  nicheSlug: string;
  durationSeconds: number;
  durationRange?: DurationRange;
  platform: string;
  reviewMode: "manual" | "automatic";
  runPurpose?: "production" | "test";
  /** 视觉审片不可用时，只有用户明确选择先产出首版才允许正式制作继续。 */
  visualReviewPolicy?: "required" | "allow_unreviewed_first_cut";
  templateSnapshot?: ProductionTemplateSnapshot;
  providers: ProductionProviderBindings;
  models?: Record<string, string>;
  modelSelectionSources?: Record<string, ProductionModelSelectionSource>;
  frozenModelSelections?: Record<string, ProductionFrozenModelSelection>;
  workflowFeatures?: ProductionWorkflowFeatures;
  referenceVideo?: ProductionReferenceVideo;
  director?: ProductionDirectorDirection;
  economics: ProductionEconomics;
  budgetIntentionCny?: number;
  spendFeedback?: ProductionSpendFeedback[];
  voiceDirection: ProductionVoiceDirection;
  editorial?: ProductionEditorialDirection;
  visualProof?: string;
  visualIntent?: string;
  visualPlan?: ProductionVisualPlan;
  /** visualPlan 的来源证据：false=创建端确认是未采用的系统建议；缺省=来源未知，不得擅自降级。 */
  visualPlanAdopted?: boolean;
  seriesContext?: ProductionSeriesContext;
  creationContext?: {
    origin: "trend" | "series" | "manual" | "case";
    opportunityId: string;
    /** origin 为 case 时指向服务端保存的案例参考；其它来源不带这个字段。 */
    caseSelectionId?: string;
  };
  articleSources?: ProductionArticleSourceSnapshot[];
  rework?: ProductionReworkContext;
  taskContractDigests?: Partial<Record<"visual-review" | "role-audit" | "creative-treatment", string>>;
}

const PRODUCTION_BRIEF_INPUT_KEYS = new Set([
  "protocolVersion", "title", "angle", "audience", "nicheSlug", "durationSeconds", "durationRange",
  "platform", "reviewMode", "runPurpose", "visualReviewPolicy", "providers", "models", "modelSelectionSources", "frozenModelSelections", "workflowFeatures",
  "referenceVideo", "director", "economics", "spendFeedback", "voiceDirection", "editorial", "visualProof",
  "visualIntent", "visualPlan", "visualPlanAdopted", "seriesContext", "creationContext", "rework", "taskContractDigests",
  "articleSources", "budgetIntentionCny",
  // 模板字段只为旧调用方提供明确的弃用剥离；它们不会进入有效 brief。
  "template", "templateSnapshot",
]);

export function parseBrief(value: unknown): ProductionBrief {
  if (!isRecord(value)) {
    throw new Error("Brief must be a JSON object.");
  }
  if (value.protocolVersion !== BRIEF_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported brief protocolVersion: ${String(value.protocolVersion)}; expected ${BRIEF_PROTOCOL_VERSION}.`,
    );
  }
  const unknownField = Object.keys(value).find((key) => !PRODUCTION_BRIEF_INPUT_KEYS.has(key));
  if (unknownField) throw new Error(`Brief field '${unknownField}' is not allowed.`);

  const providers = requireRecord(value.providers, "providers");
  const models = parseModelSelections(value.models);
  const modelSelectionSources = parseModelSelectionSources(value.modelSelectionSources, models);
  const frozenModelSelections = parseFrozenModelSelections(value.frozenModelSelections);
  const workflowFeatures = parseWorkflowFeatures(value.workflowFeatures);
  const referenceVideo = parseReferenceVideo(value.referenceVideo);
  const director = parseDirectorDirection(value.director, providers);
  const economics = parseEconomics(value.economics);
  const budgetIntentionCny = value.budgetIntentionCny === undefined ? undefined
    : boundedNumber(value.budgetIntentionCny, "budgetIntentionCny", 0, 100_000, false);
  const spendFeedback = parseSpendFeedback(value.spendFeedback);
  const voiceDirection = parseVoiceDirection(value.voiceDirection);
  const editorial = parseEditorialDirection(value.editorial);
  const visualProof = value.visualProof === undefined ? undefined : requireString(value.visualProof, "visualProof");
  const visualIntent = value.visualIntent === undefined ? undefined : optionalBoundedText(value.visualIntent, "visualIntent", 1000);
  const visualPlan = parseProductionVisualPlan(value.visualPlan);
  // 来源证据只接受缺省或严格布尔：字符串/数字等非法值必须显式拒绝，不能归一化成
  // “未采用建议”而降低用户要求身份（R4-08）。
  const visualPlanAdopted = value.visualPlanAdopted === undefined ? undefined
    : typeof value.visualPlanAdopted === "boolean" ? value.visualPlanAdopted
      : (() => { throw new Error("visualPlanAdopted must be a boolean when provided."); })();
  const seriesContext = parseProductionSeriesContext(value.seriesContext);
  const creationContext = parseCreationContext(value.creationContext);
  const articleSources = parseProductionArticleSources(value.articleSources);
  const rework = parseReworkContext(value.rework);
  const taskContractDigests = parseTaskContractDigests(value.taskContractDigests);
  // joint-v1 拓扑必然编译可执行方案：缺 durationRange 或导演配置在合同层 fail closed，
  // 不得静默降级回旧规划流程。该检查先于 executablePlan 的通用检查：joint-v1 总是同时
  // 携带 executablePlan，先报更具体的拓扑标记。
  if (workflowFeatures.creativePlanning && (!value.durationRange || !director)) {
    throw new Error("workflowFeatures.creativePlanning requires both durationRange and director planning inputs.");
  }
  if (workflowFeatures.executablePlan && (!value.durationRange || !director)) {
    throw new Error("workflowFeatures.executablePlan requires both durationRange and director planning inputs.");
  }
  if (workflowFeatures.assetSemanticRank && !director) {
    throw new Error("workflowFeatures.assetSemanticRank requires an AI director configuration.");
  }
  if (workflowFeatures.assetSemanticRank && requireString(providers.assets, "providers.assets") !== "ai-shot-router-v1") {
    throw new Error("workflowFeatures.assetSemanticRank requires providers.assets 'ai-shot-router-v1'.");
  }
  if (workflowFeatures.referenceGrammar && (!director || !referenceVideo)) {
    throw new Error("workflowFeatures.referenceGrammar requires a reference video and AI director configuration.");
  }
  const voiceProvider = requireString(providers.voice, "providers.voice");
  const expectedVoiceProvider = voiceProviderForProfile(voiceDirection.profileId);
  if (voiceProvider !== expectedVoiceProvider) {
    throw new Error(
      `voiceDirection.profileId '${voiceDirection.profileId}' must use providers.voice '${expectedVoiceProvider}'.`,
    );
  }
  const durationSeconds = value.durationSeconds;
  if (!Number.isInteger(durationSeconds) || Number(durationSeconds) < 20 || Number(durationSeconds) > 180) {
    throw new Error("durationSeconds must be an integer between 20 and 180.");
  }
  const durationRange = parseDurationRange(value.durationRange, Number(durationSeconds));
  if (value.reviewMode !== "manual" && value.reviewMode !== "automatic") {
    throw new Error("reviewMode must be 'manual' or 'automatic'.");
  }
  if (value.runPurpose !== undefined && value.runPurpose !== "production" && value.runPurpose !== "test") {
    throw new Error("runPurpose must be 'production' or 'test'.");
  }
  const visualReviewPolicy = value.visualReviewPolicy === undefined
    ? undefined
    : value.visualReviewPolicy === "required" || value.visualReviewPolicy === "allow_unreviewed_first_cut"
      ? value.visualReviewPolicy
      : (() => { throw new Error("visualReviewPolicy is invalid."); })();

  return {
    protocolVersion: BRIEF_PROTOCOL_VERSION,
    title: requireString(value.title, "title"),
    angle: requireString(value.angle, "angle"),
    audience: requireString(value.audience, "audience"),
    nicheSlug: requireString(value.nicheSlug, "nicheSlug"),
    durationSeconds: Number(durationSeconds),
    ...(durationRange ? { durationRange } : {}),
    platform: requireProductionPlatform(value.platform),
    reviewMode: value.reviewMode,
    runPurpose: value.runPurpose ?? "production",
    ...(visualReviewPolicy ? { visualReviewPolicy } : {}),
    providers: {
      script: requireString(providers.script, "providers.script"),
      ...(director ? { director: requireString(providers.director, "providers.director") } : {}),
      assets: requireString(providers.assets, "providers.assets"),
      voice: voiceProvider,
      render: requireString(providers.render, "providers.render"),
      technicalReview: requireString(providers.technicalReview, "providers.technicalReview"),
      ...(providers.visualReview === undefined ? {} : { visualReview: requireString(providers.visualReview, "providers.visualReview") }),
    },
    ...(Object.keys(models).length ? { models } : {}),
    ...(Object.keys(modelSelectionSources).length ? { modelSelectionSources } : {}),
    ...(Object.keys(frozenModelSelections).length ? { frozenModelSelections } : {}),
    ...(workflowFeatures.assetSemanticRank || workflowFeatures.referenceGrammar || workflowFeatures.executablePlan
      || workflowFeatures.creativePlanning
      // 边界闸门可以独立于共同创作规划存在（旧规划链也能逐节点放行），所以它必须自己
      // 把 workflowFeatures 带进落盘结果——漏掉这一步，标记会在解析时静默消失，重读
      // 出来的 run 版本退回 1.0.0 且不再有闸门。
      || workflowFeatures.boundaryGates
      ? { workflowFeatures }
      : {}),
    ...(referenceVideo ? { referenceVideo } : {}),
    ...(director ? { director } : {}),
    economics,
    ...(budgetIntentionCny !== undefined ? { budgetIntentionCny } : {}),
    ...(spendFeedback.length ? { spendFeedback } : {}),
    voiceDirection,
    ...(editorial ? { editorial } : {}),
    ...(visualProof ? { visualProof } : {}),
    ...(visualIntent ? { visualIntent } : {}),
    ...(visualPlan ? { visualPlan } : {}),
    ...(visualPlanAdopted !== undefined ? { visualPlanAdopted } : {}),
    ...(seriesContext ? { seriesContext } : {}),
    ...(creationContext ? { creationContext } : {}),
    ...(articleSources.length ? { articleSources } : {}),
    ...(rework ? { rework } : {}),
    ...(taskContractDigests ? { taskContractDigests } : {}),
  };
}

export function parseProductionArticleSources(value: unknown): ProductionArticleSourceSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("articleSources must contain at most 16 entries.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const source = requireRecord(entry, `articleSources[${index}]`);
    const allowed = new Set([
      "sourceId", "originalUrl", "finalUrl", "pageTitle", "fetchedAt", "publishedAt", "contentSha256",
      "extractorVersion", "readStatus", "reason", "paragraphs", "truncated",
    ]);
    const unknown = Object.keys(source).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`articleSources[${index}] field '${unknown}' is not allowed.`);
    const sourceId = requireString(source.sourceId, `articleSources[${index}].sourceId`).trim();
    if (!sourceId || sourceId.length > 128 || seen.has(sourceId)) {
      throw new Error(`articleSources[${index}].sourceId must be unique and at most 128 characters.`);
    }
    seen.add(sourceId);
    const readStatus = source.readStatus;
    if (!(["read", "partial", "title_only", "blocked", "failed"] as const).includes(readStatus as ProductionArticleReadStatus)) {
      throw new Error(`articleSources[${index}].readStatus is invalid.`);
    }
    const originalUrl = requireHttpUrl(source.originalUrl, `articleSources[${index}].originalUrl`);
    const finalUrl = requireHttpUrl(source.finalUrl, `articleSources[${index}].finalUrl`);
    const fetchedAt = requireIsoTimestamp(source.fetchedAt, `articleSources[${index}].fetchedAt`);
    const publishedAt = source.publishedAt === undefined
      ? undefined
      : requireIsoTimestamp(source.publishedAt, `articleSources[${index}].publishedAt`);
    const contentSha256 = source.contentSha256 === undefined
      ? undefined
      : requireArticleSha256(source.contentSha256, `articleSources[${index}].contentSha256`);
    const paragraphsValue = source.paragraphs;
    if (!Array.isArray(paragraphsValue) || paragraphsValue.length > 128) {
      throw new Error(`articleSources[${index}].paragraphs must contain at most 128 entries.`);
    }
    const paragraphIds = new Set<string>();
    let characterCount = 0;
    const paragraphs = paragraphsValue.map((paragraph, paragraphIndex) => {
      const item = requireRecord(paragraph, `articleSources[${index}].paragraphs[${paragraphIndex}]`);
      if (Object.keys(item).some((key) => key !== "id" && key !== "text")) {
        throw new Error(`articleSources[${index}].paragraphs[${paragraphIndex}] contains an unsupported field.`);
      }
      const id = requireString(item.id, `articleSources[${index}].paragraphs[${paragraphIndex}].id`).trim();
      const text = requireString(item.text, `articleSources[${index}].paragraphs[${paragraphIndex}].text`).trim();
      if (!id || id.length > 64 || paragraphIds.has(id) || !text || text.length > 8_000) {
        throw new Error(`articleSources[${index}].paragraphs[${paragraphIndex}] is invalid.`);
      }
      paragraphIds.add(id);
      characterCount += text.length;
      return { id, text };
    });
    if (characterCount > 8_000) throw new Error(`articleSources[${index}] exceeds the 8000 character excerpt limit.`);
    const hasBody = readStatus === "read" || readStatus === "partial";
    if (hasBody !== Boolean(contentSha256) || (hasBody && paragraphs.length === 0) || (!hasBody && paragraphs.length > 0)) {
      throw new Error(`articleSources[${index}] body evidence does not match readStatus.`);
    }
    if (typeof source.truncated !== "boolean" || (readStatus === "partial") !== source.truncated) {
      throw new Error(`articleSources[${index}].truncated does not match readStatus.`);
    }
    return {
      sourceId,
      originalUrl,
      finalUrl,
      pageTitle: requireString(source.pageTitle, `articleSources[${index}].pageTitle`).trim(),
      fetchedAt,
      ...(publishedAt ? { publishedAt } : {}),
      ...(contentSha256 ? { contentSha256 } : {}),
      extractorVersion: requireString(source.extractorVersion, `articleSources[${index}].extractorVersion`).trim(),
      readStatus: readStatus as ProductionArticleReadStatus,
      ...(source.reason === undefined ? {} : { reason: requireString(source.reason, `articleSources[${index}].reason`).trim() }),
      paragraphs,
      truncated: source.truncated,
    };
  });
}

function requireHttpUrl(value: unknown, label: string): string {
  const raw = requireString(value, label);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use HTTP or HTTPS.`);
  return url.toString();
}

function requireArticleSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be a sha256 digest.`);
  return text;
}

function parseDurationRange(value: unknown, durationSeconds: number): DurationRange | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "durationRange");
  const minSeconds = boundedNumber(input.minSeconds, "durationRange.minSeconds", 20, 180, true);
  const maxSeconds = boundedNumber(input.maxSeconds, "durationRange.maxSeconds", 20, 180, true);
  if (minSeconds > maxSeconds) {
    throw new Error("durationRange.minSeconds must not exceed durationRange.maxSeconds.");
  }
  if (durationSeconds < minSeconds || durationSeconds > maxSeconds) {
    throw new Error("durationSeconds must fall within durationRange.");
  }
  return { minSeconds, maxSeconds };
}

function parseTaskContractDigests(value: unknown): ProductionBrief["taskContractDigests"] {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "taskContractDigests");
  // 白名单必须与 REQUIRED_CODEX_TASK_CONTRACT_DIGESTS 的受保护任务集合一致：
  // production-pipeline 会把全部受保护 digest 写入 brief，缺一个 kind 就会在 brief 节点 fail closed。
  const allowed = new Set(Object.keys(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS));
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("taskContractDigests contains an unsupported task kind.");
  }
  const result: NonNullable<ProductionBrief["taskContractDigests"]> = {};
  for (const kind of allowed) {
    const digest = input[kind];
    if (digest === undefined) continue;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`taskContractDigests.${kind} must be a SHA-256 digest.`);
    }
    result[kind as keyof typeof result] = digest;
  }
  return result;
}

const PRODUCTION_VISUAL_SOURCES = new Set<ProductionVisualSource>(["creator", "stock", "screen", "local-card", "generated"]);

export function parseProductionVisualPlan(value: unknown): ProductionVisualPlan | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "visualPlan");
  if (!Array.isArray(input.beats) || input.beats.length < 1 || input.beats.length > 12) {
    throw new Error("visualPlan.beats must contain between 1 and 12 entries.");
  }
  const beats = input.beats.map((entry, index): ProductionVisualBeat => {
    const beat = requireRecord(entry, `visualPlan.beats[${index}]`);
    const source = requireString(beat.source, `visualPlan.beats[${index}].source`);
    if (!PRODUCTION_VISUAL_SOURCES.has(source as ProductionVisualSource)) {
      throw new Error(`visualPlan.beats[${index}].source is invalid.`);
    }
    return {
      id: requireString(beat.id, `visualPlan.beats[${index}].id`),
      role: requireString(beat.role, `visualPlan.beats[${index}].role`),
      duration: requireString(beat.duration, `visualPlan.beats[${index}].duration`),
      description: requireString(beat.description, `visualPlan.beats[${index}].description`),
      searchQuery: requireString(beat.searchQuery, `visualPlan.beats[${index}].searchQuery`),
      source: source as ProductionVisualSource,
    };
  });
  if (new Set(beats.map((beat) => beat.id)).size !== beats.length) {
    throw new Error("visualPlan.beats ids must be unique.");
  }
  return { strategy: requireString(input.strategy, "visualPlan.strategy"), beats };
}

function parseReworkContext(value: unknown): ProductionReworkContext | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "rework");
  const sourceRunId = requireString(input.sourceRunId, "rework.sourceRunId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceRunId)) throw new Error("rework.sourceRunId is invalid.");
  const sourceRunRevision = boundedNumber(input.sourceRunRevision, "rework.sourceRunRevision", 0, 1_000_000, true);
  const instructions = requireRecord(input.nodeInstructions, "rework.nodeInstructions");
  // BG-06：media/director-only 返工允许 script 指令为空串——空指令表示编剧阶段不点名，
  // 跨 run seed 据此继承编剧；visualDirection/assets 仍必填非空。
  const scriptInstruction = boundedOptionalReworkText(instructions.script, "rework.nodeInstructions.script");
  const nodeInstructions = {
    script: scriptInstruction,
    visualDirection: boundedReworkText(instructions.visualDirection, "rework.nodeInstructions.visualDirection"),
    assets: boundedReworkText(instructions.assets, "rework.nodeInstructions.assets"),
  };
  const findings = parseProductionReworkFindings(input.findings);
  const affectedScenePositions = parseReworkAffectedScenePositions(input.affectedScenePositions);
  const rejectionReason = input.rejectionReason === undefined
    ? undefined
    : boundedReworkText(input.rejectionReason, "rework.rejectionReason");
  const context: Omit<ProductionReworkContext, "plan"> = {
    sourceRunId,
    sourceRunRevision,
    ...(rejectionReason ? { rejectionReason } : {}),
    ...(affectedScenePositions !== undefined ? { affectedScenePositions } : {}),
    nodeInstructions,
    findings,
    ...(input.previousScript === undefined ? {} : { previousScript: boundedReworkDocument(input.previousScript, "rework.previousScript") }),
    ...(input.previousDirectorPlan === undefined ? {} : { previousDirectorPlan: boundedReworkDocument(input.previousDirectorPlan, "rework.previousDirectorPlan") }),
  };
  return { ...context, plan: compileProductionReworkPlan(context) };
}

export function compileProductionReworkPlan(
  context: Omit<ProductionReworkContext, "plan">,
): ProductionReworkPlan {
  const affectedScenePositions = [...new Set(context.affectedScenePositions ?? [])].sort((left, right) => left - right);
  const requirements = context.findings.map((finding) => {
    const primaryOwnerNodeId = finding.primaryOwnerNodeId ?? finding.targetNodeIds[0] ?? "assets";
    const affectedNodeIds = finding.affectedNodeIds ?? finding.targetNodeIds;
    const action = finding.action ?? reworkActionForFinding(finding, primaryOwnerNodeId);
    return {
      findingId: finding.findingId,
      primaryOwnerNodeId,
      affectedNodeIds: [...affectedNodeIds],
      action,
      scenePositions: finding.scenePosition === undefined
        ? [...affectedScenePositions]
        : [finding.scenePosition],
    };
  });
  const previousShots = reworkShotsByPosition(context.previousDirectorPlan);
  const universe = reworkPlanSceneUniverse(context.previousScript, context.previousDirectorPlan, affectedScenePositions);
  const affected = new Set(affectedScenePositions);
  const sceneActions = universe.map((scenePosition) => {
    const reasons = requirements.filter((requirement) => requirement.scenePositions.includes(scenePosition));
    const shot = previousShots.get(scenePosition);
    const reuse = shot && (Number.isInteger(shot.reuseFromScenePosition)
      || typeof shot.query === "string" && /^REUSE_ONLY\s+scene\s+/i.test(shot.query));
    let action: ProductionReworkPlan["sceneActions"][number]["action"];
    const inspectionOnly = reasons.length > 0 && reasons.every((reason) => reason.action === "inspect_existing_media");
    if (inspectionOnly) action = "inspect";
    else if (!affected.has(scenePosition)) action = reuse ? "reuse" : "retain";
    else if (reasons.some((reason) => reason.action === "replan_upstream")) action = "blocked";
    else if (reasons.some((reason) => reason.action === "replace_asset")) action = reuse ? "reuse" : "generate";
    else if (reasons.some((reason) => reason.action === "inspect_existing_media")) action = "inspect";
    else action = reuse ? "reuse" : reworkShotRequiresGeneration(shot) ? "generate" : "inspect";
    return {
      scenePosition,
      action,
      reasonFindingIds: reasons.map((reason) => reason.findingId),
    };
  });
  const payload = {
    version: "video-factory/rework-plan-v1" as const,
    source: {
      runId: context.sourceRunId,
      runRevision: context.sourceRunRevision,
      reviewEvidenceIds: [...new Set(context.findings.flatMap((finding) => (
        finding.reviewEvidenceId ? [finding.reviewEvidenceId] : []
      )))].sort(),
    },
    requirements,
    sceneActions,
    nodeInstructions: { ...context.nodeInstructions },
  };
  return {
    ...payload,
    planDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

function reworkActionForFinding(
  finding: ProductionReworkFinding,
  primaryOwnerNodeId: "script" | "visual-direction" | "assets",
): ProductionReworkPlan["requirements"][number]["action"] {
  if (finding.nextAction === "inspect_existing_media") return "inspect_existing_media";
  if (finding.nextAction === "replan_upstream") return "replan_upstream";
  if (finding.nextAction === "rework_asset") return "replace_asset";
  return primaryOwnerNodeId === "assets" ? "replace_asset" : "replan_upstream";
}

function reworkPlanSceneUniverse(
  previousScript: Record<string, unknown> | undefined,
  previousDirectorPlan: Record<string, unknown> | undefined,
  affectedScenePositions: number[],
): number[] {
  const positions = new Set<number>(affectedScenePositions);
  for (const [position] of reworkPositionedRecords(previousScript?.scenes, "position")) positions.add(position);
  for (const [position] of reworkPositionedRecords(previousDirectorPlan?.shots, "scenePosition")) positions.add(position);
  return [...positions].sort((left, right) => left - right);
}

function reworkShotsByPosition(value: Record<string, unknown> | undefined): Map<number, Record<string, unknown>> {
  return reworkPositionedRecords(value?.shots, "scenePosition");
}

function reworkPositionedRecords(value: unknown, positionKey: string): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const position = Number(entry[positionKey]);
    if (Number.isInteger(position) && position > 0) result.set(position, entry);
  }
  return result;
}

function reworkShotRequiresGeneration(shot: Record<string, unknown> | undefined): boolean {
  return shot?.deliveryType === "generated_image" || shot?.deliveryType === "generated_video";
}

function parseReworkAffectedScenePositions(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("rework.affectedScenePositions must contain at most 100 entries.");
  }
  return [...new Set(value.map((position, index) => boundedNumber(
    position,
    `rework.affectedScenePositions[${index}]`,
    1,
    10_000,
    true,
  )))].sort((left, right) => left - right);
}

export function parseProductionReworkFindings(
  value: unknown,
  field = "rework.findings",
): ProductionReworkFinding[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must contain at most 100 entries.`);
  }
  const allowedTargets = new Set(["script", "visual-direction", "assets"]);
  const findingIds = new Set<string>();
  return value.map((entry, index): ProductionReworkFinding => {
    const itemField = `${field}[${index}]`;
    const finding = requireRecord(entry, itemField);
    const findingId = requireString(finding.findingId, `${itemField}.findingId`);
    if (!/^vf_[a-f0-9]{24}$/.test(findingId)) throw new Error(`${itemField}.findingId is invalid.`);
    if (findingIds.has(findingId)) throw new Error(`${itemField}.findingId must be unique within the rework.`);
    findingIds.add(findingId);
    const timecodeMs = boundedNumber(finding.timecodeMs, `${itemField}.timecodeMs`, 0, 10_800_000, true);
    const scenePosition = finding.scenePosition === undefined
      ? undefined
      : boundedNumber(finding.scenePosition, `${itemField}.scenePosition`, 1, 10_000, true);
    const startTimecodeMs = finding.startTimecodeMs === undefined
      ? undefined
      : boundedNumber(finding.startTimecodeMs, `${itemField}.startTimecodeMs`, 0, 10_800_000, true);
    const endTimecodeMs = finding.endTimecodeMs === undefined
      ? undefined
      : boundedNumber(finding.endTimecodeMs, `${itemField}.endTimecodeMs`, 0, 10_800_000, true);
    if (startTimecodeMs !== undefined && endTimecodeMs !== undefined
      && (startTimecodeMs > timecodeMs || timecodeMs > endTimecodeMs)) {
      throw new Error(`${itemField} time range is invalid.`);
    }
    if (!Array.isArray(finding.targetNodeIds) || finding.targetNodeIds.length === 0 || finding.targetNodeIds.length > 3) {
      throw new Error(`${itemField}.targetNodeIds is invalid.`);
    }
    const targetNodeIds = [...new Set(finding.targetNodeIds.map((target, targetIndex) => {
      if (typeof target !== "string" || !allowedTargets.has(target)) {
        throw new Error(`${itemField}.targetNodeIds[${targetIndex}] is invalid.`);
      }
      return target as ProductionReworkFinding["targetNodeIds"][number];
    }))];
    const claimType = optionalEnum(finding.claimType,
      ["static", "motion", "non_visual"] as const, `${itemField}.claimType`);
    const evidenceStatus = optionalEnum(finding.evidenceStatus,
      ["satisfied", "failed", "not_observed", "not_applicable"] as const, `${itemField}.evidenceStatus`);
    const nextAction = optionalEnum(finding.nextAction,
      ["inspect_existing_media", "replan_upstream", "rework_asset", "none"] as const, `${itemField}.nextAction`);
    const sourceReviewStage = optionalEnum(finding.sourceReviewStage,
      ["source_assets", "rendered_video"] as const, `${itemField}.sourceReviewStage`);
    const evidenceFrameSha256 = optionalSha256OrNull(finding.evidenceFrameSha256, `${itemField}.evidenceFrameSha256`);
    const reviewEvidenceId = optionalSha256(finding.reviewEvidenceId, `${itemField}.reviewEvidenceId`);
    const actualModels = finding.actualModels === undefined
      ? undefined
      : parseReworkActualModels(finding.actualModels, `${itemField}.actualModels`);
    const planningStageId = optionalEnum(finding.planningStageId,
      ["treatment", "script", "director"] as const, `${itemField}.planningStageId`);
    const primaryOwnerNodeId = optionalEnum(
      finding.primaryOwnerNodeId,
      ["script", "visual-direction", "assets"] as const,
      `${itemField}.primaryOwnerNodeId`,
    );
    const affectedNodeIds = finding.affectedNodeIds === undefined
      ? undefined
      : parseReworkNodeIds(finding.affectedNodeIds, `${itemField}.affectedNodeIds`);
    const action = optionalEnum(
      finding.action,
      ["inspect_existing_media", "replan_upstream", "replace_asset"] as const,
      `${itemField}.action`,
    );
    if (finding.current !== undefined && typeof finding.current !== "boolean") {
      throw new Error(`${itemField}.current must be a boolean.`);
    }
    return {
      findingId,
      timecodeMs,
      ...(startTimecodeMs === undefined ? {} : { startTimecodeMs }),
      ...(endTimecodeMs === undefined ? {} : { endTimecodeMs }),
      ...(scenePosition === undefined ? {} : { scenePosition }),
      ...(claimType ? { claimType } : {}),
      ...(evidenceStatus ? { evidenceStatus } : {}),
      ...(evidenceFrameSha256 !== undefined ? { evidenceFrameSha256 } : {}),
      ...(nextAction ? { nextAction } : {}),
      category: boundedReworkText(finding.category, `${itemField}.category`, 120),
      description: boundedReworkText(finding.description, `${itemField}.description`),
      suggestion: boundedReworkText(finding.suggestion, `${itemField}.suggestion`),
      ...(planningStageId ? { planningStageId } : {}),
      targetNodeIds,
      ...(primaryOwnerNodeId ? { primaryOwnerNodeId } : {}),
      ...(affectedNodeIds ? { affectedNodeIds } : {}),
      ...(action ? { action } : {}),
      ...(sourceReviewStage ? { sourceReviewStage } : {}),
      ...(finding.sourceReviewNodeId === undefined ? {} : {
        sourceReviewNodeId: boundedReworkText(finding.sourceReviewNodeId, `${itemField}.sourceReviewNodeId`, 120),
      }),
      ...(finding.sourceReviewVersionId === undefined ? {} : {
        sourceReviewVersionId: boundedReworkText(finding.sourceReviewVersionId, `${itemField}.sourceReviewVersionId`, 240),
      }),
      ...(reviewEvidenceId ? { reviewEvidenceId } : {}),
      ...(actualModels ? { actualModels } : {}),
      ...(finding.current === undefined ? {} : { current: finding.current }),
    };
  });
}

function parseReworkNodeIds(
  value: unknown,
  field: string,
): Array<"script" | "visual-direction" | "assets"> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new Error(`${field} is invalid.`);
  }
  return [...new Set(value.map((entry, index) => {
    if (entry !== "script" && entry !== "visual-direction" && entry !== "assets") {
      throw new Error(`${field}[${index}] is invalid.`);
    }
    return entry;
  }))];
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field} is invalid.`);
  return value as T;
}

function optionalSha256(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function optionalSha256OrNull(value: unknown, field: string): string | null | undefined {
  return value === null ? null : optionalSha256(value, field);
}

function parseReworkActualModels(value: unknown, field: string): Array<{ providerId: string; modelId: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw new Error(`${field} is invalid.`);
  return value.map((entry, index) => {
    const model = requireRecord(entry, `${field}[${index}]`);
    return {
      providerId: boundedReworkText(model.providerId, `${field}[${index}].providerId`, 120),
      modelId: boundedReworkText(model.modelId, `${field}[${index}].modelId`, 240),
    };
  });
}

// BG-06：允许空串（编剧未点名）但拒绝非字符串或超长的 rework 文本。
function boundedOptionalReworkText(value: unknown, field: string, maxLength = 6_000): string {
  if (typeof value === "string" && value.trim() === "") return "";
  return boundedReworkText(value, field, maxLength);
}

function boundedReworkText(value: unknown, field: string, maxLength = 6_000): string {
  const text = requireString(value, field);
  if (text.length > maxLength) throw new Error(`${field} must not exceed ${maxLength} characters.`);
  return text;
}

function boundedReworkDocument(value: unknown, field: string): Record<string, unknown> {
  const document = requireRecord(value, field);
  if (JSON.stringify(document).length > 150_000) throw new Error(`${field} is too large.`);
  return structuredClone(document);
}

function parseSpendFeedback(value: unknown): ProductionSpendFeedback[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("spendFeedback must contain at most 20 entries.");
  const reasons = new Set<ProductionSpendFeedbackReason>(["too_expensive", "provider_mix", "plan_not_approved", "other"]);
  return value.map((entry, index) => {
    const input = requireRecord(entry, `spendFeedback[${index}]`);
    if (!reasons.has(input.reason as ProductionSpendFeedbackReason)) {
      throw new Error(`spendFeedback[${index}].reason is invalid.`);
    }
    const previousEstimatedCostCny = boundedNumber(
      input.previousEstimatedCostCny,
      `spendFeedback[${index}].previousEstimatedCostCny`,
      0,
      100_000,
      false,
    );
    const targetEstimatedCostCny = input.targetEstimatedCostCny === undefined
      ? undefined
      : boundedNumber(input.targetEstimatedCostCny, `spendFeedback[${index}].targetEstimatedCostCny`, 0, 100_000, false);
    const note = input.note === undefined ? undefined : requireString(input.note, `spendFeedback[${index}].note`);
    if (note && note.length > 1_000) throw new Error(`spendFeedback[${index}].note is too long.`);
    return {
      spendPlanId: requireString(input.spendPlanId, `spendFeedback[${index}].spendPlanId`),
      nodeId: requireString(input.nodeId, `spendFeedback[${index}].nodeId`),
      reason: input.reason as ProductionSpendFeedbackReason,
      previousEstimatedCostCny,
      ...(targetEstimatedCostCny !== undefined ? { targetEstimatedCostCny } : {}),
      ...(note ? { note } : {}),
      rejectedBy: requireString(input.rejectedBy, `spendFeedback[${index}].rejectedBy`),
      rejectedAt: requireIsoTimestamp(input.rejectedAt, `spendFeedback[${index}].rejectedAt`),
    };
  });
}

function parseCreationContext(value: unknown): ProductionBrief["creationContext"] {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "creationContext");
  if (input.origin !== "trend" && input.origin !== "series" && input.origin !== "manual" && input.origin !== "case") {
    throw new Error("creationContext.origin is invalid.");
  }
  // 案例来源没有机会编号：它绑定的是一条外部参考，不是选题候选，
  // 因此不进热点候选池，也不参与任何选题评分。
  if (input.origin === "case") {
    return {
      origin: "case",
      opportunityId: typeof input.opportunityId === "string" ? input.opportunityId.trim() : "",
      caseSelectionId: requireString(input.caseSelectionId, "creationContext.caseSelectionId"),
    };
  }
  return {
    origin: input.origin,
    opportunityId: requireString(input.opportunityId, "creationContext.opportunityId"),
  };
}

export function parseProductionSeriesContext(value: unknown): ProductionSeriesContext | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "seriesContext");
  const bible = requireRecord(input.bible, "seriesContext.bible");
  const canon = requireRecord(input.canon, "seriesContext.canon");
  const continuity = requireRecord(input.continuity, "seriesContext.continuity");
  const episode = requireRecord(input.episode, "seriesContext.episode");
  const planning = requireRecord(episode.planning, "seriesContext.episode.planning");
  const seriesRevision = boundedNumber(input.seriesRevision, "seriesContext.seriesRevision", 1, 100_000, true);
  const episodeNumber = boundedNumber(input.episodeNumber, "seriesContext.episodeNumber", 1, 10_000, true);
  const seasonNumber = boundedNumber(input.seasonNumber, "seriesContext.seasonNumber", 1, 1_000, true);
  const canonBaseRevision = boundedNumber(input.canonBaseRevision, "seriesContext.canonBaseRevision", 0, 100_000, true);
  const canonRevision = boundedNumber(canon.revision, "seriesContext.canon.revision", 0, 100_000, true);
  if (canonBaseRevision !== canonRevision) {
    throw new Error("seriesContext.canonBaseRevision must match the current canon revision before production starts.");
  }
  const memorySummary = continuity.memorySummary === undefined
    ? undefined
    : requireString(continuity.memorySummary, "seriesContext.continuity.memorySummary");
  return {
    seriesId: requireString(input.seriesId, "seriesContext.seriesId"),
    episodeId: requireString(input.episodeId, "seriesContext.episodeId"),
    seriesName: requireString(input.seriesName, "seriesContext.seriesName"),
    seriesRevision,
    episodeNumber,
    seasonNumber,
    canonBaseRevision,
    ...(input.productionReservationId === undefined
      ? {}
      : { productionReservationId: requireString(input.productionReservationId, "seriesContext.productionReservationId") }),
    premise: requireString(input.premise, "seriesContext.premise"),
    audience: requireString(input.audience, "seriesContext.audience"),
    platform: requireString(input.platform, "seriesContext.platform"),
    track: requireString(input.track, "seriesContext.track"),
    arc: requireString(input.arc, "seriesContext.arc"),
    episode: {
      updatedAt: requireIsoTimestamp(episode.updatedAt, "seriesContext.episode.updatedAt"),
      pillar: requireString(episode.pillar, "seriesContext.episode.pillar"),
      title: requireString(episode.title, "seriesContext.episode.title"),
      viewerPromise: requireString(episode.viewerPromise, "seriesContext.episode.viewerPromise"),
      hook: requireString(episode.hook, "seriesContext.episode.hook"),
      payoff: requireString(episode.payoff, "seriesContext.episode.payoff"),
      planning: parseSeriesEpisodePlanning(planning),
    },
    bible: {
      rules: boundedStringList(bible.rules, "seriesContext.bible.rules", 20),
      recurringElements: boundedStringList(bible.recurringElements, "seriesContext.bible.recurringElements", 20),
      forbiddenChanges: boundedStringList(bible.forbiddenChanges, "seriesContext.bible.forbiddenChanges", 20),
    },
    canon: {
      revision: canonRevision,
      facts: parseCanonFacts(canon.facts),
    },
    continuity: {
      inheritedFromPrevious: boundedStringList(
        continuity.inheritedFromPrevious,
        "seriesContext.continuity.inheritedFromPrevious",
        20,
      ),
      fromPrevious: boundedStringList(continuity.fromPrevious, "seriesContext.continuity.fromPrevious", 20),
      toNext: boundedStringList(continuity.toNext, "seriesContext.continuity.toNext", 20),
      canonChecks: boundedStringList(continuity.canonChecks, "seriesContext.continuity.canonChecks", 20),
      ...(memorySummary ? { memorySummary } : {}),
    },
  };
}

function parseCanonFacts(value: unknown): ProductionSeriesContext["canon"]["facts"] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error("seriesContext.canon.facts must be an array with at most 200 entries.");
  }
  return value.map((entry, index) => {
    const fact = requireRecord(entry, `seriesContext.canon.facts[${index}]`);
    const acceptedAt = requireString(fact.acceptedAt, `seriesContext.canon.facts[${index}].acceptedAt`);
    if (!Number.isFinite(Date.parse(acceptedAt))) {
      throw new Error(`seriesContext.canon.facts[${index}].acceptedAt must be an ISO timestamp.`);
    }
    const sourceOutputVersionIds = fact.sourceOutputVersionIds === undefined
      ? undefined
      : boundedStringList(fact.sourceOutputVersionIds, `seriesContext.canon.facts[${index}].sourceOutputVersionIds`, 20);
    return {
      id: requireString(fact.id, `seriesContext.canon.facts[${index}].id`),
      statement: requireString(fact.statement, `seriesContext.canon.facts[${index}].statement`),
      sourceEpisodeId: requireString(fact.sourceEpisodeId, `seriesContext.canon.facts[${index}].sourceEpisodeId`),
      ...(fact.sourceRunId === undefined ? {} : { sourceRunId: requireString(fact.sourceRunId, `seriesContext.canon.facts[${index}].sourceRunId`) }),
      ...(fact.sourceRunRevision === undefined ? {} : { sourceRunRevision: boundedNumber(fact.sourceRunRevision, `seriesContext.canon.facts[${index}].sourceRunRevision`, 0, 1_000_000, true) }),
      ...(sourceOutputVersionIds ? { sourceOutputVersionIds } : {}),
      acceptedAt,
    };
  });
}

function parseSeriesEpisodePlanning(value: Record<string, unknown>): ProductionSeriesContext["episode"]["planning"] {
  if (value.source !== "agent" && value.source !== "rules" && value.source !== "human") {
    throw new Error("seriesContext.episode.planning.source is invalid.");
  }
  if (value.auditStatus !== "passed" && value.auditStatus !== "fallback" && value.auditStatus !== "human_override") {
    throw new Error("seriesContext.episode.planning.auditStatus is invalid.");
  }
  return {
    source: value.source,
    role: requireString(value.role, "seriesContext.episode.planning.role"),
    auditRole: requireString(value.auditRole, "seriesContext.episode.planning.auditRole"),
    auditStatus: value.auditStatus,
    auditIterations: boundedNumber(value.auditIterations, "seriesContext.episode.planning.auditIterations", 0, 3, true),
    ...(value.auditScore === undefined ? {} : { auditScore: boundedNumber(value.auditScore, "seriesContext.episode.planning.auditScore", 0, 100, true) }),
    ...(value.auditSummary === undefined ? {} : { auditSummary: requireString(value.auditSummary, "seriesContext.episode.planning.auditSummary") }),
    providerId: requireString(value.providerId, "seriesContext.episode.planning.providerId"),
    modelId: requireString(value.modelId, "seriesContext.episode.planning.modelId"),
    promptVersion: requireString(value.promptVersion, "seriesContext.episode.planning.promptVersion"),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: requireString(value.reasoningEffort, "seriesContext.episode.planning.reasoningEffort") }),
    ...(value.fallbackReason === undefined ? {} : { fallbackReason: requireString(value.fallbackReason, "seriesContext.episode.planning.fallbackReason") }),
  };
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp.`);
  return timestamp;
}

function parseModelSelectionSources(
  value: unknown,
  models: Record<string, string>,
): Record<string, ProductionModelSelectionSource> {
  const defaults = Object.fromEntries(Object.keys(models).map((providerId) => [providerId, "run_override" as const]));
  if (value === undefined) return defaults;
  const input = requireRecord(value, "modelSelectionSources");
  const allowed = new Set<ProductionModelSelectionSource>([
    "system_default",
    "global_default",
    "template_default",
    "run_override",
    "node_override",
  ]);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("modelSelectionSources must not contain more than 32 entries.");
  const explicit = Object.fromEntries(entries.map(([providerId, source]) => {
    if (!(providerId in models)) throw new Error(`modelSelectionSources.${providerId} has no matching model selection.`);
    if (!allowed.has(source as ProductionModelSelectionSource)) {
      throw new Error(`modelSelectionSources.${providerId} is invalid.`);
    }
    return [providerId, source as ProductionModelSelectionSource];
  }));
  return { ...defaults, ...explicit };
}

function parseWorkflowFeatures(value: unknown): ProductionWorkflowFeatures {
  if (value === undefined) return { assetSemanticRank: false, referenceGrammar: false };
  const input = requireRecord(value, "workflowFeatures");
  if (typeof input.assetSemanticRank !== "boolean" || typeof input.referenceGrammar !== "boolean") {
    throw new Error("workflowFeatures must contain boolean assetSemanticRank and referenceGrammar values.");
  }
  if (input.executablePlan !== undefined && typeof input.executablePlan !== "boolean") {
    throw new Error("workflowFeatures.executablePlan must be a boolean when provided.");
  }
  if (input.creativePlanning !== undefined && input.creativePlanning !== "joint-v1") {
    throw new Error("workflowFeatures.creativePlanning must be the literal 'joint-v1' when provided.");
  }
  if (input.creativeReview !== undefined && input.creativeReview !== "user-confirmed-v1") {
    throw new Error("workflowFeatures.creativeReview must be the literal 'user-confirmed-v1' when provided.");
  }
  if (input.creativeReview === "user-confirmed-v1" && input.creativePlanning !== "joint-v1") {
    throw new Error("workflowFeatures.creativeReview requires creativePlanning 'joint-v1'.");
  }
  if (input.boundaryGates !== undefined && input.boundaryGates !== "user-confirmed-v1") {
    throw new Error("workflowFeatures.boundaryGates must be the literal 'user-confirmed-v1' when provided.");
  }
  return {
    assetSemanticRank: input.assetSemanticRank,
    referenceGrammar: input.referenceGrammar,
    ...(input.executablePlan === true ? { executablePlan: true } : {}),
    ...(input.creativePlanning === "joint-v1" ? { creativePlanning: "joint-v1" } : {}),
    ...(input.creativeReview === "user-confirmed-v1" ? { creativeReview: "user-confirmed-v1" } : {}),
    ...(input.boundaryGates === "user-confirmed-v1" ? { boundaryGates: "user-confirmed-v1" } : {}),
  };
}

function parseReferenceVideo(value: unknown): ProductionReferenceVideo | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "referenceVideo");
  const mimeType = requireString(input.mimeType, "referenceVideo.mimeType");
  if (mimeType !== "video/mp4" && mimeType !== "video/quicktime" && mimeType !== "video/webm") {
    throw new Error("referenceVideo.mimeType is invalid.");
  }
  const sizeBytes = boundedNumber(input.sizeBytes, "referenceVideo.sizeBytes", 12, 30 * 1024 * 1024, true);
  const sha256 = requireString(input.sha256, "referenceVideo.sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("referenceVideo.sha256 is invalid.");
  const filePath = requireString(input.path, "referenceVideo.path");
  if (!filePath.startsWith("/")) throw new Error("referenceVideo.path must be absolute.");
  return {
    uploadId: requireString(input.uploadId, "referenceVideo.uploadId"),
    label: requireString(input.label, "referenceVideo.label"),
    mimeType,
    sizeBytes,
    sha256,
    path: filePath,
  };
}

function parseModelSelections(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const input = requireRecord(value, "models");
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("models must not contain more than 32 selections.");
  return Object.fromEntries(entries.map(([providerId, modelId]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
      throw new Error(`models provider id '${providerId}' is invalid.`);
    }
    const normalized = requireString(modelId, `models.${providerId}`);
    if (normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
      throw new Error(`models.${providerId} is invalid.`);
    }
    return [providerId, normalized];
  }));
}

function parseFrozenModelSelections(value: unknown): Record<string, ProductionFrozenModelSelection> {
  if (value === undefined) return {};
  const input = requireRecord(value, "frozenModelSelections");
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("frozenModelSelections must not contain more than 32 selections.");
  return Object.fromEntries(entries.map(([providerId, rawSelection]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
      throw new Error(`frozenModelSelections provider id '${providerId}' is invalid.`);
    }
    const selection = requireRecord(rawSelection, `frozenModelSelections.${providerId}`);
    const unknown = Object.keys(selection).find((key) => key !== "modelId" && key !== "source");
    if (unknown) throw new Error(`frozenModelSelections.${providerId} field '${unknown}' is not allowed.`);
    const modelId = requireString(selection.modelId, `frozenModelSelections.${providerId}.modelId`);
    if (modelId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(modelId)) {
      throw new Error(`frozenModelSelections.${providerId}.modelId is invalid.`);
    }
    if (selection.source !== "system_default"
      && selection.source !== "global_default"
      && selection.source !== "template_default"
      && selection.source !== "run_override") {
      throw new Error(`frozenModelSelections.${providerId}.source is invalid.`);
    }
    return [providerId, { modelId, source: selection.source }];
  }));
}

export function parsePersistedBrief(value: unknown): ProductionBrief {
  const migrated = migratePersistedBriefShape(
    migratePersistedReworkFindingIds(migratePersistedReferenceVideo(value)),
  );
  const persistedPlatform = isRecord(migrated) && typeof migrated.platform === "string"
    ? migrated.platform.trim()
    : undefined;
  const legacyPlatform = persistedPlatform && !PRODUCTION_PLATFORMS.some((platform) => platform === persistedPlatform)
    ? persistedPlatform
    : undefined;
  // 旧版曾把内容来源平台写进发布平台。来源值无法可靠反推发布目标，统一迁移到产品默认的抖音，
  // 让历史制作可以继续返工、核账和完成发布，而不是保留一个所有写操作都会拒绝的值。
  const strictInput = legacyPlatform && isRecord(migrated) ? { ...migrated, platform: "douyin" } : migrated;
  try {
    return parseBrief(strictInput);
  } catch (strictError) {
    if (!isRecord(strictInput) || !isRecord(strictInput.providers) || !isRecord(strictInput.voiceDirection)) throw strictError;
    const providerId = strictInput.providers.voice;
    const profileId = strictInput.voiceDirection.profileId;
    if (typeof providerId !== "string" || typeof profileId !== "string") throw strictError;
    if (voiceProviderForProfile(profileId) === providerId) throw strictError;
    const compatibleProfileId = persistedVoiceProfileForProvider(providerId);
    if (!compatibleProfileId) throw strictError;
    return parseBrief({
      ...strictInput,
      voiceDirection: { ...strictInput.voiceDirection, profileId: compatibleProfileId },
    });
  }
}

function migratePersistedBriefShape(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let migrated = value;
  if (isRecord(value.director) && isRecord(value.providers) && value.providers.director === undefined) {
    migrated = {
      ...migrated,
      providers: { ...value.providers, director: "api-visual-director-v1" },
    };
  }
  const creationContext = migrated.creationContext;
  if (isRecord(creationContext)
    && creationContext.origin === undefined
    && typeof creationContext.opportunityId === "string"
    && creationContext.opportunityId.trim()) {
    // 早期制作只保存机会编号，无法仅凭 brief 可靠判断来自选题还是系列；保留编号并标为手动来源，
    // 上层仍可通过唯一机会关系恢复系列归属，同时不会把未知来源伪装成已确认的系列制作。
    migrated = {
      ...migrated,
      creationContext: { ...creationContext, origin: "manual" },
    };
  }
  return migrated;
}

function requireProductionPlatform(value: unknown): string {
  const platform = requireString(value, "platform");
  if (!PRODUCTION_PLATFORMS.some((candidate) => candidate === platform)) {
    throw new Error(`platform must be one of: ${PRODUCTION_PLATFORMS.join(", ")}.`);
  }
  return platform;
}

function migratePersistedReworkFindingIds(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.rework) || !Array.isArray(value.rework.findings)) return value;
  const sourceRunId = value.rework.sourceRunId;
  const sourceRunRevision = value.rework.sourceRunRevision;
  if (typeof sourceRunId !== "string" || !Number.isSafeInteger(sourceRunRevision)) return value;
  return {
    ...value,
    rework: {
      ...value.rework,
      findings: value.rework.findings.map((finding, findingIndex) => {
        if (!isRecord(finding) || finding.findingId !== undefined) return finding;
        const findingId = `vf_${createHash("sha256").update(JSON.stringify({
          sourceRunId,
          sourceReviewVersionId: `legacy-revision-${sourceRunRevision}`,
          findingIndex,
          finding,
        })).digest("hex").slice(0, 24)}`;
        return { findingId, ...finding };
      }),
    },
  };
}

function migratePersistedReferenceVideo(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.referenceVideo) || value.referenceVideo.sha256 !== undefined) return value;
  return {
    ...value,
    // 历史运行可继续查看；全零哨兵会在重新执行参考分析时拒绝复用，要求用户重新上传。
    referenceVideo: { ...value.referenceVideo, sha256: "0".repeat(64) },
  };
}

function parseEditorialDirection(value: unknown): ProductionEditorialDirection | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "editorial");
  if (input.verdict !== "produce_video" && input.verdict !== "produce_image_story") {
    throw new Error("editorial.verdict must be 'produce_video' or 'produce_image_story'.");
  }
  return {
    verdict: input.verdict,
    reasons: requireStringArray(input.reasons, "editorial.reasons"),
    guardrails: requireStringArray(input.guardrails, "editorial.guardrails"),
  };
}

function parseDirectorDirection(
  value: unknown,
  providers: Record<string, unknown>,
): ProductionDirectorDirection | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, "director");
  requireString(providers.director, "providers.director");
  const profileId = requireString(input.profileId, "director.profileId");
  if (!(PRODUCTION_DIRECTOR_PROFILE_IDS as readonly string[]).includes(profileId)) {
    throw new Error("director.profileId is invalid.");
  }
  if (!Array.isArray(input.assetProviderIds) || input.assetProviderIds.length === 0) {
    throw new Error("director.assetProviderIds must be a non-empty array.");
  }
  const assetProviderIds = input.assetProviderIds.map((item, index) => {
    return requireString(item, `director.assetProviderIds[${index}]`);
  });
  if (new Set(assetProviderIds).size !== assetProviderIds.length) {
    throw new Error("director.assetProviderIds must not contain duplicates.");
  }
  return { profileId: profileId as ProductionDirectorProfileId, assetProviderIds };
}

function voiceProviderForProfile(profileId: string): string {
  if (profileId.startsWith("kokoro:")) return "kokoro-local-v1";
  if (profileId.startsWith("minimax:")) return "minimax-tts-v1";
  if (profileId.startsWith("tone:")) return "ffmpeg-tone-test-v1";
  return "macos-say-v1";
}

function persistedVoiceProfileForProvider(providerId: string): string | undefined {
  if (providerId === "macos-say-v1") return "macos:Tingting";
  if (providerId === "kokoro-local-v1") return "kokoro:zf_001";
  if (providerId === "minimax-tts-v1") return "minimax:female-chengshu";
  if (providerId === "ffmpeg-tone-test-v1") return "tone:default";
  return undefined;
}

function parseVoiceDirection(value: unknown): ProductionVoiceDirection {
  if (value === undefined) {
    return {
      profileId: "macos:Tingting",
      rate: 185,
      pauseScale: 1,
      masteringPreset: "natural",
    };
  }
  const input = requireRecord(value, "voiceDirection");
  const profileId = requireString(input.profileId, "voiceDirection.profileId");
  if (!/^(macos|kokoro|minimax|tone):.+/.test(profileId)) {
    throw new Error("voiceDirection.profileId must identify a supported voice profile.");
  }
  const rate = boundedNumber(input.rate, "voiceDirection.rate", 120, 260, true);
  const pauseScale = boundedNumber(input.pauseScale, "voiceDirection.pauseScale", 0.5, 2, false);
  if (input.masteringPreset !== "natural" && input.masteringPreset !== "intimate" && input.masteringPreset !== "social") {
    throw new Error("voiceDirection.masteringPreset is invalid.");
  }
  return { profileId, rate, pauseScale, masteringPreset: input.masteringPreset };
}

function parseEconomics(value: unknown): ProductionEconomics {
  if (value === undefined) {
    return {
      recipeId: "economy-daily",
      allowMeteredProviders: false,
    };
  }
  const input = requireRecord(value, "economics");
  const recipeId = requireString(input.recipeId, "economics.recipeId") as ProductionRecipeId;
  if (!new Set<ProductionRecipeId>(["economy-daily", "free-stock", "keyshot-ai", "cinematic-ai", "custom"]).has(recipeId)) {
    throw new Error("economics.recipeId is invalid.");
  }
  if (typeof input.allowMeteredProviders !== "boolean") {
    throw new Error("economics.allowMeteredProviders must be a boolean.");
  }
  // 历史 brief 仍可能携带全视频限额；仅校验格式后丢弃，付费安全由逐次报价和人工授权负责。
  if (input.maxPaidShots !== undefined) boundedNumber(input.maxPaidShots, "economics.maxPaidShots", 0, 20, true);
  if (input.maxCostCny !== undefined) boundedNumber(input.maxCostCny, "economics.maxCostCny", 0, 100_000, false);
  return { recipeId, allowMeteredProviders: input.allowMeteredProviders };
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${field} must be ${integer ? "an integer" : "a finite number"} between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedText(value: unknown, field: string, maximum: number): string {
  const normalized = requireString(value, field);
  if (normalized.length > maximum) throw new Error(`${field} must contain at most ${maximum} characters.`);
  return normalized;
}

function optionalBoundedText(value: unknown, field: string, maximum: number): string | undefined {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${field} must contain at most ${maximum} characters.`);
  return normalized;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty string array.`);
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function boundedStringList(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${field} must be a string array with at most ${maximum} entries.`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { parseProductionTemplateSnapshot, type ProductionTemplateSnapshot } from "@video-factory/template-core";
