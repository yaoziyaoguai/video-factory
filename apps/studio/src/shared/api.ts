import type { ProductionBlueprintPatch, ProductionTemplateInput } from "@video-factory/template-core";
import type { ProductionArticleSourceSnapshot } from "@video-factory/production-pipeline";

export type StudioRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "rejected"
  | "paused"
  | "stale"
  | "awaiting_spend_approval"
  | "approval_invalidated";

export interface StudioHealth {
  status: "ok" | "degraded";
  runtime: Record<string, boolean>;
}

export type StudioLocalCapabilityState = "ready" | "available" | "missing";

export interface StudioLocalCapability {
  id: string;
  label: string;
  category: "runtime" | "voice" | "trend";
  state: StudioLocalCapabilityState;
  evidence: string;
  detail?: string;
}

export interface StudioVoiceProfile {
  id: string;
  providerId: string;
  label: string;
  locale: "zh-CN" | "zh-TW" | "zh-HK";
  engine: "macos" | "kokoro" | "minimax";
  gender?: "female" | "male" | "neutral";
  curated?: boolean;
  description?: string;
}

export type StudioMasteringPreset = "natural" | "intimate" | "social";

export interface StudioVoicePreviewInput {
  profileId: string;
  text: string;
  rate: number;
  pauseScale: number;
  masteringPreset: StudioMasteringPreset;
}

export type StudioVoiceDirection = Omit<StudioVoicePreviewInput, "text">;

export type StudioProductionRecipeId = "economy-daily" | "free-stock" | "keyshot-ai" | "cinematic-ai" | "custom";

export type StudioDirectorProfileId =
  | "auto"
  | "documentary-observer"
  | "quiet-humanism"
  | "urban-poetic"
  | "chromatic-storytelling"
  | "geometric-control"
  | "suspense-staging";

export interface StudioProductionDefaults {
  directorProfileId: StudioDirectorProfileId;
  reviewMode: "manual" | "automatic";
  platform: "douyin" | "xiaohongshu" | "bilibili";
  durationSeconds: 20 | 24 | 30 | 45;
}

export type StudioProductionRoleBindingKey =
  | "script"
  | "director"
  | "assets"
  | "voice"
  | "render"
  | "technicalReview"
  | "visualReview";

export type StudioRoleProviderDefaults = Partial<Record<StudioProductionRoleBindingKey, string>>;

export interface StudioCreatorSettings {
  voiceDirection: StudioVoiceDirection;
  voiceDirectionCustomized?: boolean;
  defaultRecipeId: StudioProductionRecipeId;
  defaultAssetProviderId?: string;
  roleProviderDefaults?: StudioRoleProviderDefaults;
  modelDefaults?: Record<string, string>;
  productionDefaults: StudioProductionDefaults;
  topicStrategy: StudioTopicStrategy;
}

export interface StudioTopicStrategy {
  positioning?: string;
  targetAudience?: string;
  preferredDirections?: string;
  excludedDirections?: string;
  sourcePolicy?: "primary_or_two_independent" | "traceable_source";
  customInstruction: string;
}

export const DEFAULT_STUDIO_PRODUCTION_DEFAULTS: StudioProductionDefaults = {
  directorProfileId: "auto",
  reviewMode: "manual",
  platform: "douyin",
  durationSeconds: 24,
};

// 出厂配音默认值。它只代表"没人选过"，不代表操作员的选择：
// 服务端在没有 settings 文件时把它交给创作对话框，对话框据此判断要不要让位给已配置的云端配音。
export const DEFAULT_STUDIO_VOICE_DIRECTION: StudioVoiceDirection = {
  profileId: "macos:Tingting",
  rate: 185,
  pauseScale: 1,
  masteringPreset: "natural",
};

export const DEFAULT_STUDIO_TOPIC_STRATEGY: StudioTopicStrategy = {
  positioning: "把复杂热点转成普通人能看懂、能验证、看完有收获的短视频。",
  targetAudience: "希望快速理解新事物，但反感标题党和空泛说教的中文短视频用户。",
  preferredDirections: "真实生活影响\n可实证的方法或变化\n有清楚反差、过程或结论\n能发展成系列",
  excludedDirections: "只有热度、没有新角度\n无法找到可靠画面或事实来源\n消费灾难、伤亡或未经证实的争议\n只能靠大段说明卡讲清",
  // 默认档位必须与热点管道的能力匹配：canonical signal group 里同一事件在不同平台
  // 指向同一篇文章，独立域名恒为 1，"两个域名"档等于永远不放行任何候选。
  // 一档原文链接 + 高风险人工核验保留了"不把标题当事实"的意图，需要更强佐证可在资源页调回严格档。
  sourcePolicy: "traceable_source",
  customInstruction: "优先考虑 24–45 秒内能兑现观众承诺的题材。",
};

export interface StudioCreatorSettingsPatch {
  voiceDirection?: StudioVoiceDirection;
  defaultRecipeId?: StudioProductionRecipeId;
  defaultAssetProviderId?: string;
  roleProviderDefaults?: StudioRoleProviderDefaults;
  modelDefaults?: Record<string, string>;
  productionDefaults?: Partial<StudioProductionDefaults>;
  topicStrategy?: Partial<StudioTopicStrategy>;
}

export interface StudioModelProfile {
  id: string;
  label: string;
  providerId: string;
  providerFamily: string;
  available: boolean;
  recommended?: boolean;
  description: string;
  taskTypes: Array<"text-to-video" | "image-to-video" | "text-to-image" | "visual-review" | "digital-human" | "text">;
  resolutions?: string[];
  aspectRatios?: Array<"9:16" | "16:9" | "1:1" | "3:4" | "4:3">;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  supportsAudio?: boolean;
  estimatedCnyPerClip?: number;
}

export interface StudioProvider {
  id: string;
  providerFamily?: string;
  capability: string;
  label: string;
  available: boolean;
  kind: "local" | "external" | "test";
  status?: "ready" | "needs_config" | "planned";
  billing?: "free" | "subscription" | "metered";
  approvalPolicy?: "manual" | "automatic" | "none";
  description?: string;
  modes?: string[];
  latency?: "instant" | "seconds" | "minutes";
  estimatedCnyPerClip?: number;
  billingUnit?: "clip" | "run";
  docsUrl?: string;
  /** 服务商控制台入口，用于人工核对付费任务与账单；与 API 文档入口（docsUrl）分开声明。 */
  consoleUrl?: string;
  requirement?: string;
  defaultModelId?: string;
  modelProfiles?: StudioModelProfile[];
  deliveryTypes?: Array<"editorial_card" | "stock_video" | "stock_image" | "generated_image" | "generated_video">;
}

/**
 * 「从案例 / 脚本开始」的来源条目。
 *
 * 这一组类型刻意不含任何评分：案例是给人看的参考，不是被系统排序的候选。
 * 凡是模型总结、翻译或改写都不放进这些字段——它们只承载来源方自己公布的内容。
 */
/**
 * 可选的借鉴方式。它会被拼进给模型的说明里，所以客户端只是选项，
 * 服务端按同一张表校验：任意文本不能借此进入规划指令。
 */
export const STUDIO_CASE_BORROW_AXES = ["开场方式", "叙事推进", "解释方式", "证据编排", "结尾回收", "节奏控制"] as const;

export type StudioCaseBorrowAxis = typeof STUDIO_CASE_BORROW_AXES[number];

export type StudioCaseSourceId = "ted" | "bilibili";

export type StudioCaseContentState =
  /** 已取得真实正文（原站逐字稿 / 字幕），可在页内阅读。 */
  | "transcript"
  /** 来源只公开视频信息，没有可自动取得的正文。 */
  | "video_only"
  /** 尚未读取正文；来源可能提供，但未验证，不得当成已有正文。 */
  | "unread";

export interface StudioCaseMetric {
  label: string;
  value: number;
}

export interface StudioCaseSummary {
  id: string;
  sourceId: StudioCaseSourceId;
  sourceLabel: string;
  title: string;
  originalUrl: string;
  author?: string;
  publishedAt?: string;
  durationSeconds?: number;
  /** 只有真实观察到语言时才写入；读不到就留空，不用"未知语言"占位。 */
  language?: string;
  topics: string[];
  contentState: StudioCaseContentState;
  /** 给用户看的内容性质标签，例如「原站逐字稿（字幕）」。 */
  contentTypeLabel: string;
  /** 来源方自己的简介，不是模型摘要。 */
  summary?: string;
  metrics: StudioCaseMetric[];
  /** 公开指标的取得时间；指标缺失就不该被当成 0。 */
  metricsFetchedAt: string;
  usageNote: string;
}

export interface StudioCaseTranscript {
  state: "read" | "partial" | "unavailable";
  language?: string;
  fetchedAt?: string;
  paragraphs: Array<{ id: string; text: string }>;
  truncated: boolean;
  reason?: string;
  usageNote: string;
}

export interface StudioCaseDetail {
  item: StudioCaseSummary;
  transcript: StudioCaseTranscript;
}

export interface StudioCaseSourceStatus {
  sourceId: StudioCaseSourceId;
  label: string;
  state: "ready" | "loading" | "unavailable" | "needs_config" | "failed";
  itemCount: number;
  detail: string;
  fetchedAt?: string;
}

export interface StudioCaseFacets {
  sources: Record<string, number>;
  topics: Record<string, number>;
  languages: Record<string, number>;
  contentStates: Record<string, number>;
}

export interface StudioCaseCatalog {
  items: StudioCaseSummary[];
  facets: StudioCaseFacets;
  sources: StudioCaseSourceStatus[];
  generatedAt?: string;
  loading: boolean;
}

export interface StudioCaseSelection {
  caseId: string;
  sourceId: StudioCaseSourceId;
  sourceLabel: string;
  title: string;
  originalUrl: string;
  contentState: StudioCaseContentState;
  contentTypeLabel: string;
  language?: string;
  /** 用户选择的借鉴方式；只影响参考如何被使用，不改写用户主题。 */
  borrowIntent: string[];
  /** 用户补充的本次创作意图。 */
  intent: string;
  selectedAt: string;
}

export interface StudioTrendSource {
  id: string;
  label: string;
  kind: "native" | "import" | "commercial";
  status: "ready" | "needs_config" | "manual_only";
  description: string;
  cadence: string;
  requirement?: string;
  docsUrl?: string;
}

export type StudioTrendServiceState = "ready" | "degraded" | "stopped";

export interface StudioTrendService {
  id: "trendradar" | "newsnow" | "dailyhot" | "rsshub";
  label: string;
  kind: "collector" | "aggregator" | "feed";
  status: StudioTrendServiceState;
  baseUrl?: string;
  lastCheckedAt: string;
  itemCount?: number;
  detail?: string;
}

export interface StudioTrendSignal {
  id: string;
  sourceId: "newsnow" | "dailyhot" | "rsshub" | "trendradar";
  platform: string;
  title: string;
  rank: number;
  collectedAt: string;
  url?: string;
  heat?: number;
}

export interface StudioTrendSignalQuery {
  platforms?: string[];
  limit?: number;
}

export type StudioTopicCategory =
  | "society"
  | "finance-career"
  | "technology"
  | "lifestyle"
  | "health-sports"
  | "education"
  | "entertainment"
  | "local-culture"
  | "food"
  | "travel"
  | "gaming"
  | "automotive"
  | "fashion-beauty"
  | "parenting"
  | "agriculture-rural";

export type StudioCandidateOrigin = "trend" | "series";
export type StudioCandidateFreshness = "live" | "today" | "evergreen";
export type StudioCandidateRisk = "low" | "review" | "high";
export type StudioVerificationStatus = "ready" | "review_required" | "blocked" | "verified";
export type StudioEditorialVerdict = "produce_video" | "produce_image_story" | "skip";

export interface StudioTemplateRecommendation {
  id: string;
  name: string;
  format: string;
  rationale: string;
}

export interface StudioEditorialDecision {
  verdict: StudioEditorialVerdict;
  score: number;
  reasons: string[];
  guardrails: string[];
  recommendedTemplate?: StudioTemplateRecommendation;
  // 规则保底候选尚未经过选题总编模型评估：分数不是总编结论，客户端必须显示“待总编评估”而不是“总编评分 0”。
  pendingEditorReview?: boolean;
}

export interface StudioCandidateVerification {
  status: StudioVerificationStatus;
  independentSources: number;
  requiredSources: number;
  reasons: string[];
}

export type StudioVisualSource = "creator" | "stock" | "screen" | "local-card" | "generated";

export interface StudioVisualBeat {
  id: string;
  role: string;
  duration: string;
  description: string;
  searchQuery: string;
  source: StudioVisualSource;
}

export interface StudioVisualPlan {
  strategy: string;
  beats: StudioVisualBeat[];
}

export interface StudioTrendCandidate {
  id: string;
  title: string;
  platform: string;
  track: string;
  audience: string;
  painPoint: string;
  hook: string;
  rationale: string;
  visualProof?: string;
  providerId: string;
  // 规则保底的结构化诊断：模型轮失败时必须留痕，不得静默冒充模型成果。
  generationFallback?: {
    reason: string;
    category: "model_unavailable" | "accepted_unknown" | "contract_rejected" | "model_error";
  };
  generatedAt: string;
  evidence: StudioOpportunityEvidence[];
  articleSources?: ProductionArticleSourceSnapshot[];
  articleFacts?: StudioArticleFact[];
  articleUncertainties?: string[];
  score: StudioOpportunityScore;
  visualPlan?: StudioVisualPlan;
  category?: StudioTopicCategory;
  freshness?: StudioCandidateFreshness;
  risk?: StudioCandidateRisk;
  editorialDecision?: StudioEditorialDecision;
}

export interface StudioTrendRefreshReceipt {
  refreshId: string;
  status: "started" | "already_running";
  requestedAt: string;
}

export interface StudioTrendRefreshStatus {
  refreshId: string;
  state: "running" | "succeeded" | "failed";
  requestedAt: string;
  finishedAt?: string;
  candidateCount?: number;
  error?: string;
}

export interface StudioTopicGenerationReceipt {
  generationId: string;
  generatedAt: string;
  modelInvoked: boolean;
  source: "editor-model" | "rule-fallback";
  candidateCount: number;
  providerId?: string;
  modelId?: string;
  failureCategory?: "model_unavailable" | "accepted_unknown" | "contract_rejected" | "model_error";
  failureReason?: string;
  modelCandidateCount?: number;
  unknownSignalCount?: number;
  invalidSourceBindingCount?: number;
  duplicateAngleCount?: number;
  preferenceExcludedCount?: number;
  /**
   * 选题总编这轮独立复核的真实结论。awaiting_user 表示轮次跑完仍未判通过：
   * 候选照常返回、用户照常能开工，但审计的建议必须一起显示出来，不能只留一堆"看起来已经过审"的候选。
   */
  auditStatus?: "passed" | "awaiting_user";
  auditSummary?: string;
  auditRepairInstructions?: string[];
}

export interface StudioCandidateInboxItem extends StudioTrendCandidate {
  origin: StudioCandidateOrigin;
  category: StudioTopicCategory;
  freshness: StudioCandidateFreshness;
  risk: StudioCandidateRisk;
  verification: StudioCandidateVerification;
  editorialDecision: StudioEditorialDecision;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  seriesSequence?: {
    status: "ready" | "blocked";
    blockedByEpisodeNumber?: number;
  };
}

export interface StudioCandidateInboxQuery {
  origins?: StudioCandidateOrigin[];
  categories?: StudioTopicCategory[];
  platforms?: string[];
  verdicts?: StudioEditorialVerdict[];
  limit?: number;
}

export interface StudioCandidateInboxFacets {
  total: number;
  origins: Partial<Record<StudioCandidateOrigin, number>>;
  categories: Partial<Record<StudioTopicCategory, number>>;
  platforms: Record<string, number>;
  verdicts: Partial<Record<StudioEditorialVerdict, number>>;
}

export interface StudioCandidateInbox {
  items: StudioCandidateInboxItem[];
  facets: StudioCandidateInboxFacets;
  generatedAt: string;
  topicGeneration?: StudioTopicGenerationReceipt;
  /** 热点候选正在后台生成：此时 items 是缓存快照，可能为空但仍在推进。 */
  refreshing: boolean;
}

export type StudioSeriesStatus = "active" | "paused";
export type StudioSeriesEpisodeStatus = "planned" | "selected" | "in_production" | "ready" | "published" | "paused";

export interface StudioSeriesBible {
  rules: string[];
  recurringElements: string[];
  forbiddenChanges: string[];
}

export interface StudioSeriesCanonFact {
  id: string;
  statement: string;
  sourceEpisodeId: string;
  sourceRunId?: string;
  sourceRunRevision?: number;
  sourceOutputVersionIds?: string[];
  acceptedAt: string;
}

export interface StudioSeriesCanonLedger {
  revision: number;
  facts: StudioSeriesCanonFact[];
}

export interface StudioSeriesEpisodeContinuity {
  inheritedFromPrevious: string[];
  fromPrevious: string[];
  toNext: string[];
  canonChecks: string[];
  memorySummary?: string;
}

export interface StudioSeriesEpisodePlanning {
  source: "agent" | "rules" | "human";
  role: string;
  auditRole: string;
  // awaiting_user：自动复核跑完但没判通过，结论与建议留在记录里等用户裁决。
  auditStatus: "passed" | "awaiting_user" | "fallback" | "human_override" | "stale";
  auditIterations: number;
  auditScore?: number;
  auditSummary?: string;
  providerId: string;
  modelId: string;
  promptVersion: string;
  reasoningEffort?: string;
  fallbackReason?: string;
}

export interface StudioSeriesEpisode {
  id: string;
  seriesId: string;
  episodeNumber: number;
  seasonNumber: number;
  arc: string;
  pillar: string;
  title: string;
  viewerPromise: string;
  hook: string;
  payoff: string;
  previousEpisodeId?: string;
  canonBaseRevision: number;
  status: StudioSeriesEpisodeStatus;
  opportunityId?: string;
  runId?: string;
  runReservation?: {
    id: string;
    opportunityId: string;
    createdAt: string;
  };
  editLease?: {
    id: string;
    createdAt: string;
  };
  lastObservedRun?: {
    id: string;
    revision: number;
  };
  attemptRunIds?: string[];
  continuity: StudioSeriesEpisodeContinuity;
  planning: StudioSeriesEpisodePlanning;
  // 公共议题单集的人工补充原始来源：只追加、持久化，用于重算来源门禁。
  supplementSources?: {
    evidenceUrls: string[];
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface StudioSeriesProductionContext {
  seriesId: string;
  episodeId: string;
  seriesName: string;
  seriesRevision: number;
  episodeNumber: number;
  seasonNumber: number;
  canonBaseRevision: number;
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
    planning: StudioSeriesEpisodePlanning;
  };
  bible: StudioSeriesBible;
  canon: StudioSeriesCanonLedger;
  continuity: StudioSeriesEpisodeContinuity;
  productionReservationId?: string;
}

export interface StudioSeries {
  id: string;
  name: string;
  premise: string;
  audience: string;
  platform: string;
  category: StudioTopicCategory;
  track: string;
  pillars: string[];
  tone: string;
  visualStyle: string;
  status: StudioSeriesStatus;
  revision: number;
  currentSeason: {
    number: number;
    title: string;
    arc: string;
    planningPeriod?: string;
    releaseCadence?: "weekly" | "biweekly" | "monthly" | "flexible";
    targetEpisodeCount?: number;
  };
  bible: StudioSeriesBible;
  canon: StudioSeriesCanonLedger;
  episodes: StudioSeriesEpisode[];
  nextEpisodeNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSeriesInput {
  name: string;
  premise: string;
  audience: string;
  platform: StudioProductionDefaults["platform"];
  category: StudioTopicCategory;
  track: string;
  pillars: string[];
  tone: string;
  visualStyle: string;
  seasonTitle?: string;
  seasonArc?: string;
  planningPeriod?: string;
  releaseCadence?: "weekly" | "biweekly" | "monthly" | "flexible";
  targetEpisodeCount?: number;
  continuityRules?: string[];
}

export interface StudioSeriesEpisodePlanInput {
  expectedRevision: number;
  pillar: string;
  title: string;
  viewerPromise: string;
  hook: string;
  payoff: string;
  fromPrevious: string[];
  toNext: string[];
}

export type StudioOpportunityStatus = "draft" | "shortlisted" | "approved" | "rejected" | "tested";

export interface StudioOpportunityEvidence {
  source: string;
  platform: string;
  keyword: string;
  strength: number;
  evidenceUrl?: string;
  collectedAt?: string;
}

export interface StudioArticleFact {
  statement: string;
  sourceId: string;
  paragraphIds: string[];
  uncertainty?: string;
}

export interface StudioOpportunityScore {
  audienceReach: number;
  visualFeasibility: number;
  productionCostEfficiency: number;
  novelty: number;
  monetization: number;
  seriesPotential: number;
  complianceRisk: number;
  final: number;
  /**
   * 选题总编对"现实中是否真有一群人因为具体理由点开并看完"的判断。
   * 只在总编真的给过这条判断时存在：系列路线图候选与规则保底候选没有这个分，
   * 不能用别的维度顶替，否则"评估过"和"没评估过"在界面上看起来一样。
   */
  audienceDemand?: number;
}

export interface StudioOpportunityScoreProvenance {
  source: string;
  scoredAt: string;
}

export interface StudioOpportunity {
  id: string;
  title: string;
  platform: string;
  track: string;
  audience: string;
  painPoint: string;
  hook: string;
  status: StudioOpportunityStatus;
  score: StudioOpportunityScore;
  scoreProvenance: StudioOpportunityScoreProvenance;
  evidence: StudioOpportunityEvidence[];
  articleSources?: ProductionArticleSourceSnapshot[];
  articleFacts?: StudioArticleFact[];
  articleUncertainties?: string[];
  createdAt: string;
  updatedAt: string;
  origin?: "manual" | StudioCandidateOrigin;
  category?: StudioTopicCategory;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  verification?: StudioCandidateVerification;
  editorialDecision?: StudioEditorialDecision;
  visualProof?: string;
  visualPlan?: StudioVisualPlan;
}

export interface StudioOpportunityInput {
  title: string;
  platform: string;
  track: string;
  audience: string;
  painPoint: string;
  hook: string;
  evidence: StudioOpportunityEvidence[];
  /** 仅候选采用服务内部传入；通用人工录入不会获得可信正文快照。 */
  articleSources?: ProductionArticleSourceSnapshot[];
  articleFacts?: StudioArticleFact[];
  articleUncertainties?: string[];
  scores: Omit<StudioOpportunityScore, "final">;
  candidateId?: string;
  origin?: "manual" | StudioCandidateOrigin;
  category?: StudioTopicCategory;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  verification?: StudioCandidateVerification;
  editorialDecision?: StudioEditorialDecision;
  visualProof?: string;
  visualPlan?: StudioVisualPlan;
}

export interface StudioCandidateAdoptionInput {
  origin: StudioCandidateOrigin;
  verificationConfirmed?: boolean;
}

export interface StudioCandidateSourcesInput {
  evidenceUrls: string[];
  // 候选补充必须显式声明入口，防止相同 candidateId 跨 trend/series 串改；
  // 机会（opportunity）补充由机会自身身份限定，不需要该字段。
  origin?: "trend" | "series";
}

export interface StudioOpportunityStatusInput {
  status: StudioOpportunityStatus;
}

export interface StudioRunSummary {
  id: string;
  title: string;
  status: StudioRunStatus;
  platform: string;
  durationSeconds: number;
  startedAt: string;
  finishedAt?: string;
  currentNodeId: string;
  runPurpose?: "production" | "test";
  workflowNodeIds?: string[];
  finalReviewOutcome?: "approved" | "rejected";
  continuation?: {
    supported: boolean;
    reason?: string;
  };
  nextAction?: "review" | "confirm_spend" | "regenerate";
  videoContentUrl?: string;
  archivedAt?: string;
  creationOrigin?: "trend" | "series" | "manual" | "case";
  opportunityId?: string;
  seriesId?: string;
  episodeNumber?: number;
  productionReservationId?: string;
}

export type StudioRunPhaseId = "planning" | "assets" | "composition" | "review" | "delivery";
export type StudioRunPhaseStatus = "pending" | "running" | "completed" | "attention" | "failed";

export interface StudioRunPhase {
  id: StudioRunPhaseId;
  label: string;
  status: StudioRunPhaseStatus;
  nodeIds: string[];
  completedNodes: number;
  totalNodes: number;
}

export interface StudioRunEtaRange {
  lowSeconds: number;
  highSeconds: number;
  sampleSize: number;
}

export interface StudioRunProgress {
  completedNodes: number;
  totalNodes: number;
  percentage: number;
  elapsedSeconds: number;
  currentNodeElapsedSeconds?: number;
  lastUpdatedAt: string;
  eta?: StudioRunEtaRange;
  etaUnavailableReason?: "insufficient_history" | "waiting_for_human" | "future_human_gate" | "not_running";
}

export interface StudioRunCurrentAction {
  nodeId: string;
  role: string;
  label: string;
}

export type StudioRunFailureCategory =
  | "provider_capacity"
  | "provider_timeout"
  | "configuration"
  | "content_policy"
  | "infrastructure"
  | "node_failure";

export interface StudioRunFailure {
  nodeId: string;
  nodeLabel: string;
  category: StudioRunFailureCategory;
  summary: string;
  impact: string;
  retryable: boolean;
  recoveryActions: string[];
  savedNodeCount: number;
  technicalDetail?: string;
}

export interface StudioRunResultAvailability {
  kind: "none" | "draft_video" | "reviewed_video" | "publish_package";
  usable: boolean;
  label: string;
  detail: string;
}

export type StudioTaskRecoveryAction = "query_original_task" | "retrieve_and_continue" | "retry_failed_step" | "adjust_plan";

export interface StudioTaskRecovery {
  nodeId: string;
  phase: "produce" | "audit";
  taskState: "running" | "accepted_unknown" | "completed_success" | "completed_failure" | "not_accepted" | "conflict";
  summary: string;
  resultAvailable: boolean;
  allowedActions: StudioTaskRecoveryAction[];
  lastVerifiedAt?: string;
  lastAttemptAt?: string;
  observationError?: string;
  terminalError?: string;
}

export interface StudioRunArchiveInput {
  runIds: string[];
}

export interface StudioRunDetail extends StudioRunSummary {
  revision: number;
  angle: string;
  audience: string;
  nicheSlug: string;
  reviewMode: "manual" | "automatic";
  creativeSummary?: StudioCreativeSummary;
  nodes: StudioNode[];
  artifacts: StudioArtifact[];
  decisions: StudioDecision[];
  phases?: StudioRunPhase[];
  progress?: StudioRunProgress;
  currentAction?: StudioRunCurrentAction;
  failure?: StudioRunFailure;
  resultAvailability?: StudioRunResultAvailability;
  taskRecovery?: StudioTaskRecovery;
  activeIntervention?: StudioIntervention;
  videoArtifactId?: string;
  publishPackageArtifactId?: string;
  pauseRequested?: boolean;
  reworkImpact?: StudioReworkImpactSummary;
  /** joint-v1 创作规划的真实子阶段（只读投影）；legacy run 无此字段。 */
  planningStages?: StudioPlanningStage[];
  /** 当前生效 executable plan 的 sha256（制作范围授权的 acceptedPlanDigest 锚）。 */
  productionPlanDigest?: string;
}

export interface StudioPlanningStage {
  id: "treatment" | "script" | "director" | "candidates" | "rank" | "integrate" | "compile";
  status: "pending" | "running" | "completed" | "failed";
  effectiveModelId?: string;
  /** 模型阶段当前绑定的能力提供者 id（UI 模型选择据此解析）。 */
  providerId?: string;
  artifactIds: string[];
  issue?: string;
  allowedActions: Array<"edit_input" | "change_model" | "view_artifacts">;
}

export interface StudioReworkImpactSummary {
  version: "video-factory/rework-impact-v1";
  sourceRunId: string;
  affectedScenePositions: number[];
  nodes: Array<{
    nodeId: string;
    action: "inherited" | "partial" | "executed" | "not_run";
    reason: "verified_source_match" | "mixed_reuse_and_execution" | "affected_input" | "not_reached";
  }>;
  calls: {
    scriptModel: number | "unknown";
    mediaCreate: number;
    voice: number;
    render: number;
    visualReview: number;
  };
  media: {
    retainedSha256: string[];
    producedSha256: string[];
    mayCreateNewMedia: boolean;
  };
}

export interface StudioCreativeSummary {
  audience: string;
  openingPromise: string;
  requiredVisual: string;
  payoff: string;
}

export interface StudioNode {
  id: string;
  label: string;
  role?: string;
  actionLabel?: string;
  status: StudioRunStatus | "skipped";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  interrupted?: boolean;
  outcomeUncertain?: boolean;
  artifactIds: string[];
  qualityGateResults: Array<{
    gateId: string;
    status: "passed" | "failed" | "needs_human";
    reasons: string[];
  }>;
  output?: unknown;
  inputState?: StudioNodeInputState;
  outputState?: StudioNodeOutputState;
  executionReceipt?: StudioNodeExecutionReceipt;
  plannedExecution?: StudioNodeExecutionPlan;
  spendPlan?: StudioSpendPlan;
  spendAuthorizationId?: string;
  /** C1 结构化覆盖评估：报价等待节点上"范围未覆盖"的可区分原因与精确金额。 */
  spendAssessment?: StudioSpendAssessment;
  agentLoopProgress?: StudioAgentLoopProgress;
  executionConfiguration?: StudioNodeExecutionConfiguration;
}

export interface StudioSpendAssessment {
  action: "execute" | "request_approval";
  reason?: "amount" | "scope" | "attempts" | "quality" | "evidence";
  approvedAmountCents: number;
  settledCents: number;
  reservedCents: number;
  pendingUnknownCents: number;
  requestedMaximumCents: number;
  additionalCents: number;
  resultingMaximumCents: number;
  blockedAssets: Array<{ assetKey: string; reason: string }>;
}

export interface StudioNodeExecutionConfiguration {
  providerId: string;
  modelSelections: Record<string, string>;
  assetProviderIds?: string[];
  economics?: {
    allowMeteredProviders: boolean;
  };
}

export interface StudioAgentLoopProgress {
  /** 当前角色 checkpoint 自身的角色名；联合规划节点切换角色时据此避免轮次看似倒退。 */
  role?: string;
  iteration: number;
  maxIterations: number;
  completedIterations: number;
  producerModelCallCount?: number;
  auditModelCallCount?: number;
  structuredRepairModelCallCount?: number;
  /** "failed"：角色调用终态失败（含 Provider/基础设施故障），不是审计轮次耗尽。 */
  /** "awaiting_user"：自动重做轮次用尽仍未通过审计，候选与那轮审计已停在用户面前等裁决。 */
  phase: "producing" | "auditing" | "repairing" | "passed" | "exhausted" | "awaiting_user" | "failed" | "halted";
  latestAudit?: {
    verdict: "pass" | "repair";
    score: number;
    summary: string;
    /**
     * 审计给出的逐条可执行意见。停在用户面前时，"这一版 76 分"帮不上忙——他要的是
     * 照着能改的东西：哪一条不达标、凭什么这么判、建议怎么改。
     */
    issues?: StudioAgentLoopAuditIssue[];
  };
  /**
   * 角色调用停下来的中文原因。`phase === "failed"` 时 `latestAudit` 必然为空（失败发生在
   * 产出那一轮之前），所以界面只能靠这个字段说清"为什么停"。节点失败拖垮整条 run 时同样的
   * 原因会出现在 `run.failure` 上；节点活下来继续往下走时，这里是唯一能看到它的地方。
   */
  failureSummary?: string;
}

export interface StudioAgentLoopAuditIssue {
  severity: "advisory" | "blocking";
  criterion: string;
  evidence: string;
  repairInstruction: string;
}

export interface StudioNodeExecutionPlan {
  providerId: string;
  providerLabel: string;
  modelId: string;
  transport: "unix_socket" | "local_process" | "http_api" | "human";
  billing: StudioBillingType;
  configurationSource?: "system_default" | "global_default" | "template_default" | "run_override" | "node_override";
  parameters?: Record<string, string | number | boolean | string[]>;
  fallbackFromProviderId?: string;
  fallbackReason?: string;
  actualModelIds?: string[];
  estimatedCostCny?: number;
  snapshotSource: "created" | "reconstructed";
}

export interface StudioNodeInputVersion {
  id: string;
  source: "derived" | "human" | "reconstructed";
  value: unknown;
  upstreamVersionIds: string[];
  parentVersionId?: string;
  createdAt: string;
  createdBy: string;
  schemaVersion: string;
}

export interface StudioNodeInputState {
  effectiveVersionId: string;
  stale: boolean;
  versions: StudioNodeInputVersion[];
}

export interface StudioNodeOutputVersion {
  id: string;
  source: "generated" | "human";
  artifactIds: string[];
  inputVersionIds: string[];
  parentVersionId?: string;
  createdAt: string;
  createdBy: string;
  schemaVersion: string;
  output?: unknown;
}

export interface StudioNodeOutputState {
  generatedVersionId: string;
  effectiveVersionId: string;
  stale: boolean;
  versions: StudioNodeOutputVersion[];
}

export interface StudioNodeExecutionReceipt {
  providerId: string;
  providerLabel: string;
  modelId: string;
  transport: "unix_socket" | "local_process" | "http_api" | "human";
  billing: StudioBillingType;
  configurationSource?: "system_default" | "global_default" | "template_default" | "run_override" | "node_override";
  parameters?: Record<string, string | number | boolean | string[]>;
  fallbackFromProviderId?: string;
  fallbackReason?: string;
  status: "succeeded" | "failed" | "rejected" | "needs_human";
  estimatedCostCny?: number;
  authorizedCostCny?: number;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  meteredAttemptCount?: number;
  meteredFailedAttemptCount?: number;
  spendAuthorizationId?: string;
  requestId?: string;
  actualModelIds?: string[];
  startedAt: string;
  finishedAt: string;
}

export interface StudioSpendPlan {
  id: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  estimatedCostCny: number;
  maxCostCny: number;
  maxAttempts: number;
  items?: Array<{
    id: string;
    label: string;
    providerId: string;
    modelId: string;
    estimatedCostCny: number;
  }>;
  createdAt: string;
}

export interface StudioNodeOverrideInput {
  output?: unknown;
  document?: {
    artifactId: string;
    content: unknown;
  };
  authorizedRunFiles?: string[];
  confirmTerminalEdit?: boolean;
}

/** joint-v1 创作规划里允许携带 planningStageId 的可编辑阶段白名单。 */
export type StudioPlanningEditableStage = "treatment" | "script" | "director";

export const STUDIO_PLANNING_EDITABLE_STAGES: readonly StudioPlanningEditableStage[] = ["treatment", "script", "director"];

export interface StudioNodeInputOverrideInput {
  input: unknown;
  expectedRunRevision: number;
  expectedVersionId: string;
  /** 仅 nodeId=creative-planning 可携带；声明本次编辑针对的创作规划阶段。 */
  planningStageId?: StudioPlanningEditableStage;
  confirmTerminalEdit?: boolean;
}

export interface StudioNodeExecutionConfigurationInput {
  expectedRunRevision: number;
  providerId?: string;
  modelSelections?: Record<string, string | null>;
  assetProviderIds?: string[];
  /** 仅 nodeId=creative-planning 可携带；声明本次模型/执行配置调整针对的创作规划阶段。 */
  planningStageId?: StudioPlanningEditableStage;
  economics?: {
    allowMeteredProviders: boolean;
  };
  confirmTerminalEdit?: boolean;
}

/** 配置编辑器草稿类型：不含并发 token；wire DTO 在保存时补上编辑器打开/点击时观察到的基线。 */
export type StudioNodeExecutionConfigurationDraft = Omit<StudioNodeExecutionConfigurationInput, "expectedRunRevision">;

export interface StudioProductionQuoteInput {
  expectedRunRevision: number;
  acceptedPlanDigest: string;
  requestedMaximumCny?: number;
  allowedModels?: Array<{ providerId: string; modelId: string }>;
}

export interface StudioProductionQuote {
  quoteId: string;
  acceptedPlanDigest: string;
  estimatedCostCny: number;
  maximumCostCny: number;
  scopeSummary: {
    content: string;
    assets: Array<{
      assetKey: string;
      label: string;
      estimatedCostCny: number;
      allowedModels: Array<{ providerId: string; modelId: string }>;
      maxCreateAttempts: number;
    }>;
    /**
     * 需要付费的镜头之外的镜头，以及它们为什么不需要付费。只用于让操作员看清
     * 「制作内容」覆盖的整片与清单条数之间的差额，不参与任何授权额度计算。
     * 历史报价没有这个字段。
     */
    excludedAssets?: Array<{ id: string; label: string; note: string }>;
    uncertainty: string[];
  };
  fundingRequestId?: string;
  /** 追加命令 URL 合同需要的活动授权 id（funding.authorizationId == current active head）。 */
  fundingAuthorizationId?: string;
  additionalCents?: number;
  missingGoals?: string[];
  preservedWork?: string[];
  purpose?: string;
  feasible: boolean;
}

export interface StudioProductionAuthorizationInput {
  expectedRunRevision: number;
  quoteId: string;
  acceptedPlanDigest: string;
  idempotencyKey: string;
}

export interface StudioProductionAmendmentInput {
  expectedRunRevision: number;
  fundingRequestId: string;
  idempotencyKey: string;
}

export interface StudioSpendAuthorizationInput {
  spendPlanId: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  maxCostCny: number;
  maxAttempts: number;
}

export interface StudioSpendRejectionInput {
  spendPlanId: string;
  reason: "too_expensive" | "provider_mix" | "plan_not_approved" | "other";
  targetEstimatedCostCny?: number;
  note?: string;
}

export type StudioPaidOperationState =
  | "prepared"
  | "submitted"
  | "provider_succeeded"
  | "materialized"
  | "terminal_failed"
  | "unknown";

export interface StudioPaidOperationItem {
  operationId: string;
  itemRequestId: string;
  quoteItemId: string;
  scenePosition: number;
  executorProviderId: string;
  providerId: string;
  modelId: string;
  state: StudioPaidOperationState;
  estimatedCostCny: number;
  taskId?: string;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  error?: string;
  manualReconciliationRequired?: boolean;
}

export interface StudioPaidNodeSummary {
  nodeId: string;
  operationId?: string;
  recommendedOutcome?: StudioPaidReconciliationInput["outcome"];
  failureKind?: "unknown_outcome" | "terminal_failure" | "missing_evidence";
  requiresManualReconciliation: boolean;
  items: StudioPaidOperationItem[];
}

export interface StudioPaidReconciliationInput {
  expectedRunRevision: number;
  reconciliationId: string;
  outcome: "resume_original" | "requote" | "confirmed_not_charged" | "confirmed_charged";
  itemRequestId?: string;
  taskId?: string;
  note?: string;
  actualCostCny?: number;
}

export interface StudioArtifact {
  id: string;
  kind: string;
  createdAt: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
  schemaVersion?: string;
  producerNodeId?: string;
  providerId?: string;
  creator?: string;
  creatorUrl?: string;
  previewUrl?: string;
  scenePosition?: number;
  licenseNote?: string;
  contentUrl?: string;
}

export interface StudioIntervention {
  id: string;
  nodeId: string;
  kind?: "creative_review" | "source_review_retry" | "source_review_decision";
  /** 节点边界的"完成待放行"停点：这一步已做完，产物已存，只等你决定是否进入下一步。 */
  boundary?: "node-complete";
  reason: string;
  options: Array<"approve" | "request_changes" | "reject">;
  createdAt: string;
  continuation?: {
    stage: StudioPlanningEditableStage;
    reviewRevision: number;
    draftSha256: string;
  };
}

export interface StudioCreativeReviewSnapshot {
  runId: string;
  runRevision: number;
  stage: StudioPlanningEditableStage;
  reviewRevision: number;
  draftSha256: string;
  draftArtifactId: string;
  draftContentUrl?: string;
  phase: "waiting_user" | "checking";
  allowedActions: Array<"discuss" | "adopt_proposal" | "edit_draft" | "undo_draft" | "confirm" | "return_to_stage">;
  returnTargets: Array<{
    stage: StudioPlanningEditableStage;
    label: string;
    impact: string;
  }>;
  draft: unknown;
  previousDraft?: unknown;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; commandId: string }>;
  proposals: Array<{ proposalId: string; baseDraftSha256: string; document: unknown; changeSummary: string[] }>;
  effectiveUserInstructions: Array<{ commandId: string; message: string }>;
  blockingIssues: Array<{
    target: "script" | "director" | "source" | "user";
    scenePositions: number[];
    reason: string;
    requiredChange: string;
  }>;
  checkResult?: {
    verdict: "pass" | "repair";
    score: number;
    summary: string;
    issues: Array<{ severity: "advisory" | "blocking"; criterion: string; evidence: string; repairInstruction: string }>;
    // 这一条复核的身份。确认时原样回传，服务端拿它和当前记录比对——"确认"必须指向界面上
    // 展示的那一条意见，而不是"当前这一版草稿碰巧存在的某条意见"。
    checkIdentity: string;
  };
  /**
   * 停在这里是因为自动循环先停下了，而不是因为这一版做完了。理由要给人看：否则人以为一切
   * 正常，不知道该在哪一件事上拍板。它独立于 checkResult——那是确认时才跑的那一轮复核。
   */
  stopDetail?: string;
}

type StudioCreativeReviewCommandBase = {
  commandId: string;
  expectedRunRevision: number;
  expectedReviewRevision: number;
  stage: StudioPlanningEditableStage;
  baseDraftSha256: string;
};

export type StudioCreativeReviewCommandInput = StudioCreativeReviewCommandBase & (
  // 独立复核是"提议"而非"否决"：repair 时人仍可继续，但必须显式承担（与 return_to_stage 的 acknowledgeImpact 同模式）。
  | { action: "confirm"; acknowledgeRepair?: boolean; expectedCheckIdentity?: string }
  | { action: "discuss"; message: string; selection?: { kind: "document" | "beat" | "scene"; ids: string[]; scenePositions: number[] } }
  | { action: "adopt_proposal"; proposalId: string }
  | { action: "edit_draft"; document: Record<string, unknown> }
  | { action: "undo_draft" }
  | { action: "return_to_stage"; targetStage: StudioPlanningEditableStage; acknowledgeImpact: true }
);

export type StudioCreativeReviewConfirmInput = StudioCreativeReviewCommandInput & { action: "confirm" };

export interface StudioCreativeReviewCommandReceipt {
  commandId: string;
  status: "running" | "completed" | "failed" | "unknown";
  observationUrl: string;
}

export function parseStudioCreativeReviewCommandInput(value: unknown): StudioCreativeReviewCommandInput {
  const input = requiredObject(value, "创作操作");
  const commonFields = ["action", "commandId", "expectedRunRevision", "expectedReviewRevision", "stage", "baseDraftSha256"];
  const actionFields = input.action === "discuss"
    ? ["message", "selection"]
    : input.action === "adopt_proposal"
      ? ["proposalId"]
      : input.action === "edit_draft"
        ? ["document"]
        : input.action === "return_to_stage"
          ? ["targetStage", "acknowledgeImpact"]
          : input.action === "confirm"
            // 这两个字段曾经漏在白名单外，于是"看过意见，仍然确认"在 HTTP 入口就被拒，
            // 整条链在界面后面断掉、只在图级单测里看着是通的。
            ? ["acknowledgeRepair", "expectedCheckIdentity"]
        : [];
  const allowed = new Set([...commonFields, ...actionFields]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new StudioInputError(`创作操作不支持字段“${unknown}”。`);
  if (!["confirm", "discuss", "adopt_proposal", "edit_draft", "undo_draft", "return_to_stage"].includes(String(input.action))) {
    throw new StudioInputError("创作操作类型不正确。");
  }
  const commandId = requiredTrimmedString(input.commandId, "操作编号");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(commandId)) throw new StudioInputError("操作编号格式不正确。");
  const expectedRunRevision = nonNegativeInteger(input.expectedRunRevision, "制作版本");
  const expectedReviewRevision = nonNegativeInteger(input.expectedReviewRevision, "方案版本");
  if (!STUDIO_PLANNING_EDITABLE_STAGES.includes(input.stage as StudioPlanningEditableStage)) {
    throw new StudioInputError("创作确认阶段不正确。");
  }
  const baseDraftSha256 = requiredTrimmedString(input.baseDraftSha256, "方案摘要");
  if (!/^[a-f0-9]{64}$/.test(baseDraftSha256)) throw new StudioInputError("方案摘要格式不正确。");
  const common: StudioCreativeReviewCommandBase = {
    commandId,
    expectedRunRevision,
    expectedReviewRevision,
    stage: input.stage as StudioPlanningEditableStage,
    baseDraftSha256,
  };
  if (input.action === "discuss") {
    const message = requiredTrimmedString(input.message, "讨论内容");
    if (message.length > 4_000) throw new StudioInputError("讨论内容不能超过 4000 个字符。");
    return {
      action: "discuss",
      ...common,
      message,
      ...(input.selection === undefined ? {} : { selection: parseStudioCreativeSelection(input.selection) }),
    };
  }
  if (input.action === "adopt_proposal") {
    return { action: "adopt_proposal", ...common, proposalId: requiredTrimmedString(input.proposalId, "备选方案编号") };
  }
  if (input.action === "edit_draft") {
    if (typeof input.document !== "object" || input.document === null || Array.isArray(input.document)) {
      throw new StudioInputError("人工修订的稿件必须是完整的方案内容。");
    }
    return { action: "edit_draft", ...common, document: input.document as Record<string, unknown> };
  }
  if (input.action === "undo_draft") return { action: "undo_draft", ...common };
  if (input.action === "return_to_stage") {
    if (!STUDIO_PLANNING_EDITABLE_STAGES.includes(input.targetStage as StudioPlanningEditableStage)) {
      throw new StudioInputError("返回的创作阶段不正确。");
    }
    if (input.acknowledgeImpact !== true) throw new StudioInputError("请先确认返回上游会使后续方案失效。");
    return { action: "return_to_stage", ...common, targetStage: input.targetStage as StudioPlanningEditableStage, acknowledgeImpact: true };
  }
  if (input.acknowledgeRepair !== undefined && input.acknowledgeRepair !== true) {
    throw new StudioInputError("确认意见承担标记不正确。");
  }
  const expectedCheckIdentity = input.expectedCheckIdentity;
  if (expectedCheckIdentity !== undefined
    && (typeof expectedCheckIdentity !== "string" || !/^[a-f0-9]{64}$/.test(expectedCheckIdentity))) {
    throw new StudioInputError("复核意见编号格式不正确。");
  }
  // "仍然确认"必须说出它承担的是哪一条复核。说不出就不算"看过意见"：服务端只能拿当前
  // 记录去凑，人确认的就不是他看到的那条意见了。
  if (input.acknowledgeRepair === true && expectedCheckIdentity === undefined) {
    throw new StudioInputError("确认前请先查看当前的独立复核意见。");
  }
  return {
    action: "confirm",
    ...common,
    ...(input.acknowledgeRepair === true ? { acknowledgeRepair: true as const } : {}),
    ...(expectedCheckIdentity === undefined ? {} : { expectedCheckIdentity }),
  };
}

export function parseStudioCreativeReviewConfirmInput(value: unknown): StudioCreativeReviewConfirmInput {
  const parsed = parseStudioCreativeReviewCommandInput(value);
  if (parsed.action !== "confirm") throw new StudioInputError("当前调用需要确认当前方案操作。");
  return parsed;
}

function parseStudioCreativeSelection(value: unknown): { kind: "document" | "beat" | "scene"; ids: string[]; scenePositions: number[] } {
  const selection = requiredObject(value, "讨论范围");
  const unknown = Object.keys(selection).find((key) => !["kind", "ids", "scenePositions"].includes(key));
  if (unknown) throw new StudioInputError(`讨论范围不支持字段“${unknown}”。`);
  if (selection.kind !== "document" && selection.kind !== "beat" && selection.kind !== "scene") {
    throw new StudioInputError("讨论范围类型不正确。");
  }
  if (!Array.isArray(selection.ids) || selection.ids.length > 24
    || selection.ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
    throw new StudioInputError("讨论范围的段落编号不正确。");
  }
  if (!Array.isArray(selection.scenePositions) || selection.scenePositions.length > 24
    || selection.scenePositions.some((position) => !Number.isInteger(position) || Number(position) < 1)) {
    throw new StudioInputError("讨论范围的镜头编号不正确。");
  }
  return {
    kind: selection.kind,
    ids: selection.ids.map((id) => String(id).trim()),
    scenePositions: selection.scenePositions.map(Number),
  };
}

export interface StudioDecision {
  id: string;
  action: "approve" | "request_changes" | "reject";
  actor: string;
  note?: string;
  expectedRunRevision?: number;
  reviewEvidenceId?: string | null;
  createdAt: string;
}

export interface StartRunResponse {
  runId: string;
  status: "running";
}

export interface StudioTemplate extends ProductionTemplateInput {
  builtIn: boolean;
}

export interface StudioTemplateCatalog {
  storeRevision: number;
  templates: StudioTemplate[];
  productionTemplates?: StudioTemplate[];
  deletedBuiltIns?: StudioTemplate[];
}

export interface StudioTemplateSelection {
  templateId: string;
  templateVersion?: number;
  runOverrides?: Pick<ProductionBlueprintPatch, "durationSeconds" | "automationLevel">;
}

export interface StudioTemplateCloneInput {
  sourceId: string;
  newId: string;
  name: string;
  expectedRevision: number;
}

export interface StudioTemplateCreateInput {
  id: string;
  name: string;
  description?: string;
  catalogVisibility?: "production" | "qa";
  expectedRevision: number;
}

export interface StudioTemplateMutation {
  storeRevision: number;
  template: StudioTemplate;
}

export interface StudioTemplateDeletion {
  storeRevision: number;
  deletedBuiltIn?: StudioTemplate;
}

export interface StudioResourceManifestItem {
  id: string;
  runId: string;
  runTitle: string;
  category: "visual" | "voice" | "font" | "document" | "other";
  kind: string;
  providerId: string;
  sourceUrl?: string;
  contentUrl?: string;
  creator?: string;
  creatorUrl?: string;
  previewUrl?: string;
  licenseNote?: string;
  contentType?: string;
  sha256?: string;
  commercialUse: "self_owned" | "provider_terms" | "review_required";
  attributionRequirement: "not_required" | "provider_terms" | "unknown";
  reviewStatus: "recorded" | "needs_review";
  scenePosition?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  query?: string;
  semanticTags?: string[];
  selectedInFinal?: boolean;
  reviewDecision?: { action: "confirmed" | "rejected"; reviewedAt: string; reviewedBy: string; note?: string };
}

export interface StudioResourceReviewInput {
  runId: string;
  itemId: string;
  expectedRevision: number;
  action: "confirmed" | "rejected";
  note?: string;
}

export type StudioAssetMediaKind = "video" | "image" | "audio" | "document" | "font" | "other";
export type StudioAssetOrigin = "stock" | "ai_generated" | "local_generated" | "creator_upload" | "final_render" | "voice_synthesis" | "production_document" | "system";
export type StudioAssetReuseStatus = "ready" | "review_required" | "private" | "not_reusable";

export interface StudioIndexedAssetUsage {
  runId: string;
  runTitle: string;
  itemId: string;
  providerId: string;
  commercialUse: StudioResourceManifestItem["commercialUse"];
  attributionRequirement: StudioResourceManifestItem["attributionRequirement"];
  reviewStatus: StudioResourceManifestItem["reviewStatus"];
  sourceUrl?: string;
  creator?: string;
  creatorUrl?: string;
  previewUrl?: string;
  licenseNote?: string;
  scenePosition?: number;
  selectedInFinal?: boolean;
}

export interface StudioIndexedAsset {
  key: string;
  mediaKind: StudioAssetMediaKind;
  origin: StudioAssetOrigin;
  reuseStatus: StudioAssetReuseStatus;
  category: StudioResourceManifestItem["category"];
  kind: string;
  providerId: string;
  sourceUrl?: string;
  contentUrl?: string;
  creator?: string;
  creatorUrl?: string;
  previewUrl?: string;
  licenseNote?: string;
  contentType?: string;
  sha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  query?: string;
  tags: string[];
  commercialUse: StudioResourceManifestItem["commercialUse"];
  attributionRequirement: StudioResourceManifestItem["attributionRequirement"];
  reviewStatus: StudioResourceManifestItem["reviewStatus"];
  provenanceConflict?: boolean;
  useCount: number;
  usages: StudioIndexedAssetUsage[];
}

export interface StudioAssetIndex {
  version: "video-factory/asset-index-v1";
  totalAssets: number;
  duplicateUses: number;
  reusableCount: number;
  needsReviewCount: number;
  facets: {
    mediaKinds: Partial<Record<StudioAssetMediaKind, number>>;
    origins: Partial<Record<StudioAssetOrigin, number>>;
    providers: Record<string, number>;
    reuseStatuses: Partial<Record<StudioAssetReuseStatus, number>>;
  };
  assets: StudioIndexedAsset[];
}

export interface StudioResourceManifest {
  reviewRevision?: number;
  generatedAt: string;
  totalItems: number;
  needsReviewCount: number;
  legacyRunsWithoutManifest: number;
  reconstructedRunCount: number;
  unreadableManifestCount: number;
  truncatedRunCount: number;
  truncatedItemCount: number;
  categories: Record<StudioResourceManifestItem["category"], number>;
  needsReviewItems?: StudioResourceManifestItem[];
  items: StudioResourceManifestItem[];
  assetIndex: StudioAssetIndex;
}

export interface StudioTemplateExperimentScorecard {
  templateId: string;
  templateName: string;
  sampleSize: number;
  metrics: {
    hookClarity: number | null;
    narrativeCompleteness: number | null;
    visualMatch: number | null;
    soundQuality: number | null;
    costEfficiency: number | null;
    manualEditCount: number;
    finalApprovalRate: number | null;
  };
  note: string;
}

export type StudioBillingType = "free" | "subscription" | "metered" | "local_compute" | "human";

export interface StudioCostLine {
  id: string;
  runId: string;
  runTitle: string;
  nodeId: string;
  role?: string;
  capability: string;
  providerId: string;
  modelId: string;
  billing: StudioBillingType;
  status: "succeeded" | "failed" | "unknown";
  estimatedCostCny: number;
  authorizedCostCny?: number;
  spendAuthorizationId?: string;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  meteredAttemptCount?: number;
  meteredFailedAttemptCount?: number;
  subscriptionCallCount?: number;
  actualPending: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface StudioCostTotals {
  estimatedCostCny: number;
  authorizedCostCny: number;
  actualCostCny: number;
  actualPendingCount: number;
  meteredCalls: number;
  subscriptionCalls: number;
  freeCalls: number;
  failedMeteredCalls: number;
}

export interface StudioCostGroup {
  id: string;
  label: string;
  calls: number;
  estimatedCostCny: number;
  actualCostCny: number;
  actualPendingCount: number;
}

export interface StudioCostRunSummary {
  runId: string;
  title: string;
  totals: StudioCostTotals;
}

export interface StudioCostDashboard {
  currency: "CNY";
  totals: StudioCostTotals;
  byProvider: Array<StudioCostGroup & { providerId: string }>;
  byNode: Array<StudioCostGroup & { nodeId: string }>;
  runs: StudioCostRunSummary[];
}

export interface StudioCostRunDetail extends StudioCostRunSummary {
  lines: StudioCostLine[];
}

export interface StudioReworkFinding {
  findingId: string;
  timecodeMs: number;
  startTimecodeMs?: number;
  endTimecodeMs?: number;
  scenePosition?: number;
  /** 这条问题要靠哪类证据判定；缺失表示旧版报告，不代表 static。 */
  claimType?: "static" | "motion" | "non_visual";
  evidenceStatus?: "satisfied" | "failed" | "not_observed" | "not_applicable";
  evidenceFrameSha256?: string | null;
  nextAction?: "inspect_existing_media" | "replan_upstream" | "rework_asset" | "none";
  category: string;
  description: string;
  suggestion: string;
  /**
   * 审片意见指名真实节点的同时指名的那一段：这条方案问题出在 treatment、script 还是 director。
   * 重做代价依次收窄，所以它是意见的一部分，不能被抹成一句笼统的"方案有问题"。
   * 缺失表示旧合同产出的意见或本就不是方案问题（targetNodeIds 只含 assets）。
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

export interface StudioReworkContext {
  sourceRunId: string;
  sourceRunRevision: number;
  rejectionReason?: string;
  affectedScenePositions?: number[];
  nodeInstructions: {
    script: string;
    visualDirection: string;
    assets: string;
  };
  findings: StudioReworkFinding[];
  plan?: {
    version: "video-factory/rework-plan-v1";
    planDigest: string;
    source: { runId: string; runRevision: number; reviewEvidenceIds: string[] };
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
    nodeInstructions: { script: string; visualDirection: string; assets: string };
  };
  previousScript?: Record<string, unknown>;
  previousDirectorPlan?: Record<string, unknown>;
}

export interface StudioReworkDraft {
  input: StudioProductionInput;
  inheritedNodeIds: string[];
  requiredAffectedScenePositions: number[];
  /** needs_scope：拒绝说明无法定位到镜头，等待用户选择范围；不能以空范围开跑。 */
  scopeState: "resolved" | "needs_scope";
  scopePrompt?: string;
  inheritedReferenceVideo?: Pick<StudioReferenceVideo, "label" | "mimeType" | "sizeBytes">;
}

export interface StudioProductionInput {
  protocolVersion: "video-factory/brief-v1";
  title: string;
  angle: string;
  audience: string;
  nicheSlug: string;
  durationSeconds: number;
  durationRange?: { minSeconds: number; maxSeconds: number };
  platform: string;
  reviewMode: "manual" | "automatic";
  runPurpose?: "production" | "test";
  template?: StudioTemplateSelection;
  editorial?: {
    verdict: "produce_video" | "produce_image_story";
    reasons: string[];
    guardrails: string[];
  };
  visualProof?: string;
  visualIntent?: string;
  visualPlan?: StudioVisualPlan;
  seriesContext?: StudioSeriesProductionContext;
  creationContext?: {
    origin: "trend" | "series" | "manual" | "case";
    /** origin 为 case 时为空串：案例来源绑定的是服务端保存的参考，不是选题候选。 */
    opportunityId: string;
    caseSelectionId?: string;
  };
  rework?: StudioReworkContext;
  voiceDirection: StudioVoiceDirection;
  providers: {
    script: string;
    director?: string;
    assets: string;
    voice: string;
    render: string;
    technicalReview: string;
    visualReview?: string;
  };
  models?: Record<string, string>;
  workflowFeatures?: {
    assetSemanticRank: boolean;
    referenceGrammar: boolean;
    executablePlan?: boolean;
    /** 新制作显式写入 "joint-v1"（共同创作规划）；历史 run 不补标记。 */
    creativePlanning?: "joint-v1";
    /** 前期构思、脚本、导演方案逐阶段由用户确认后才继续。 */
    creativeReview?: "user-confirmed-v1";
    /** 每个节点边界都停下等用户放行；缺失即维持既有的自动推进。 */
    boundaryGates?: "user-confirmed-v1";
  };
  referenceVideo?: {
    uploadId: string;
    label: string;
  };
  director?: {
    profileId: "auto" | "documentary-observer" | "quiet-humanism" | "urban-poetic" | "chromatic-storytelling" | "geometric-control" | "suspense-staging";
    assetProviderIds: string[];
  };
  economics: {
    recipeId: StudioProductionRecipeId;
    allowMeteredProviders: boolean;
  };
  /** 本片预算意向（可选，仅规划参考）：不设置默认；不构成付费授权。 */
  budgetIntentionCny?: number;
}

export function defaultStudioDurationRange(durationSeconds: number): { minSeconds: number; maxSeconds: number } {
  return {
    minSeconds: Math.max(20, Math.floor(durationSeconds * 0.6)),
    maxSeconds: Math.min(180, Math.ceil(durationSeconds * 1.4)),
  };
}

export function assertStudioExecutableProductionInput(value: unknown): void {
  const input = requiredObject(value, "制作参数");
  const workflowFeatures = input.workflowFeatures;
  if (typeof workflowFeatures !== "object" || workflowFeatures === null || Array.isArray(workflowFeatures)
    || (workflowFeatures as Record<string, unknown>).executablePlan !== true) {
    throw new StudioInputError("新建制作必须启用可执行制作方案（workflowFeatures.executablePlan=true）。");
  }
  if ((workflowFeatures as Record<string, unknown>).creativePlanning !== "joint-v1"
    || (workflowFeatures as Record<string, unknown>).creativeReview !== "user-confirmed-v1") {
    throw new StudioInputError("新建制作必须启用逐阶段讨论与确认，不能自动跳过前期构思、脚本或导演方案的确认。");
  }
  if ((workflowFeatures as Record<string, unknown>).boundaryGates !== "user-confirmed-v1") {
    throw new StudioInputError("新建制作必须在每个节点边界停下等你确认（workflowFeatures.boundaryGates=\"user-confirmed-v1\"）。");
  }
  if (typeof input.durationRange !== "object" || input.durationRange === null || Array.isArray(input.durationRange)) {
    throw new StudioInputError("新建制作必须填写可编辑的成片时长范围。");
  }
  if (typeof input.director !== "object" || input.director === null || Array.isArray(input.director)) {
    throw new StudioInputError("新建制作必须选择导演角色和画面来源。");
  }
}

export interface StudioReferenceVideo {
  uploadId: string;
  label: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/webm";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/**
 * 操作员对某一条审片结论的表态。
 *
 * itemKey 由服务端按 finding 内容算好后随成片一起下发，界面只负责原样回传——
 * 界面自己算键、或改用数组下标，都会在报告条目顺序变化时把表态落到别的条目上。
 */
export interface StudioReviewDisposition {
  itemKey: string;
  decision: "accept" | "reject";
  reason?: string;
}

interface StudioDecisionInputBase {
  expectedRunRevision: number;
  interventionId: string;
  reviewEvidenceId: string | null;
  note?: string;
  reviewDispositions?: StudioReviewDisposition[];
}

export type StudioDecisionInput = StudioDecisionInputBase & (
  | {
    action: "request_changes";
    voiceTiming?: {
      scenePosition: number;
      durationSeconds: number;
    };
  }
  | {
    action: "approve" | "reject";
    voiceTiming?: never;
  }
);

export interface StudioSceneRevisionInput {
  expectedRunRevision: number;
  expectedAssetVersionId: string;
  reviewArtifactId: string;
  findingIndex: number;
  reuseFromScenePosition: number;
  note: string;
}

/**
 * 重新取用某一镜的素材。
 *
 * 与"复用更早的镜头"相反：这一镜的素材自身不合格，画面必须换掉，而不是借别的镜头的画面。
 * 检索在规划阶段就完成了，候选清单与语义排序是那次规划的证据快照；所以这条路径不改画面方案，
 * 只把这一镜候选里**下一名合格候选**提到首位，让素材节点重跑时改取它。合格门槛沿用素材节点
 * 自己那一套，改选换不出一个系统本来就不会用的候选；一镜没有第二个合格候选时明确失败。
 * 代价是画面要重渲、其后审片要重跑；其它镜头一个字段都没动，已付费的分镜按输入指纹原样带过，不计费。
 */
export interface StudioSceneResourceRevisionInput {
  expectedRunRevision: number;
  reviewArtifactId: string;
  findingIndex: number;
  note: string;
}

/**
 * 只改一镜的文字。
 *
 * 画面已经付过钱，而旁白与字幕是脚本里的一行字——改字不该让任何一帧画面重新生成。
 * 代价是脚本同时是配音的输入：这条路径会重跑配音，配音按字符计费。
 */
export interface StudioNarrationRevisionInput {
  expectedRunRevision: number;
  scenePosition: number;
  narration: string;
  note: string;
}

export interface StudioVisualReinspectionInput {
  expectedRunRevision: number;
  reviewEvidenceId: string;
}
export type StudioPublishPlatformId = "douyin" | "toutiao" | "kuaishou" | "bilibili" | "xiaohongshu";

export interface StudioPublishTarget {
  id: StudioPublishPlatformId;
  label: string;
  mode: "official_api" | "export_package";
  status: "ready" | "needs_config" | "manual_only" | "planned";
  requirement?: string;
  docsUrl?: string;
}

export interface StudioPublishCheck {
  id: string;
  label: string;
  status: "passed" | "requires_confirmation" | "blocked";
  detail: string;
}

export interface StudioPublishReadiness {
  runId: string;
  ready: boolean;
  title: string;
  targets: StudioPublishTarget[];
  checks: StudioPublishCheck[];
}

export interface StudioPublishConfirmations {
  finalContent: boolean;
  aigcDisclosure: boolean;
  rightsAndLikeness: boolean;
  factualAccuracy: boolean;
  commercialDisclosure: boolean;
}

export interface StudioPublishInput {
  requestId: string;
  platformIds: StudioPublishPlatformId[];
  confirmations: StudioPublishConfirmations;
}

export interface StudioPublishDelivery {
  platformId: StudioPublishPlatformId;
  status: "submitted" | "export_ready" | "needs_config" | "failed";
  externalId?: string;
  reviewStatus?: string;
  detail?: string;
}

export interface StudioPublishBatch {
  id: string;
  runId: string;
  status: "succeeded" | "partial" | "failed";
  createdAt: string;
  deliveries: StudioPublishDelivery[];
}

export interface StudioArtifactResource {
  path: string;
  contentType: string;
  sizeBytes: number;
}

export function parseStudioVoicePreviewInput(value: unknown): StudioVoicePreviewInput {
  const input = requiredObject(value, "试听参数");
  const profileId = requiredTrimmedString(input.profileId, "试听音色");
  if (!profileId.startsWith("macos:") && !profileId.startsWith("kokoro:") && !profileId.startsWith("minimax:")) {
    throw new StudioInputError("请选择当前服务支持的声音演员。");
  }
  const text = requiredTrimmedString(input.text, "试听文案");
  if (text.length > 180) {
    throw new StudioInputError("试听文案不能超过 180 个字符。");
  }
  const rate = boundedRange(input.rate, "语速", 120, 260);
  const pauseScale = boundedRange(input.pauseScale, "停顿强度", 0.5, 2);
  if (input.masteringPreset !== "natural" && input.masteringPreset !== "intimate" && input.masteringPreset !== "social") {
    throw new StudioInputError("声音质感选项无效。");
  }
  return {
    profileId,
    text,
    rate,
    pauseScale,
    masteringPreset: input.masteringPreset,
  };
}

export function parseStudioCreatorSettingsPatch(value: unknown): StudioCreatorSettingsPatch {
  const input = requiredObject(value, "创作默认配置");
  const patch: StudioCreatorSettingsPatch = {};
  if (input.voiceDirection !== undefined) {
    const direction = requiredObject(input.voiceDirection, "默认声音");
    const profileId = requiredTrimmedString(direction.profileId, "默认音色");
    if (!profileId.startsWith("macos:") && !profileId.startsWith("kokoro:") && !profileId.startsWith("minimax:")) {
      throw new StudioInputError("请选择当前服务支持的声音演员。");
    }
    if (direction.masteringPreset !== "natural" && direction.masteringPreset !== "intimate" && direction.masteringPreset !== "social") {
      throw new StudioInputError("声音质感选项无效。");
    }
    patch.voiceDirection = {
      profileId,
      rate: boundedRange(direction.rate, "语速", 120, 260),
      pauseScale: boundedRange(direction.pauseScale, "停顿强度", 0.5, 2),
      masteringPreset: direction.masteringPreset,
    };
  }
  if (input.defaultRecipeId !== undefined) {
    if (!new Set(["economy-daily", "free-stock", "keyshot-ai", "cinematic-ai", "custom"]).has(String(input.defaultRecipeId))) {
      throw new StudioInputError("默认制作配方无效。");
    }
    patch.defaultRecipeId = input.defaultRecipeId as StudioProductionRecipeId;
  }
  if (input.defaultAssetProviderId !== undefined) {
    const providerId = requiredTrimmedString(input.defaultAssetProviderId, "默认画面能力");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
      throw new StudioInputError("默认画面能力编号格式不正确。");
    }
    patch.defaultAssetProviderId = providerId;
  }
  if (input.roleProviderDefaults !== undefined) {
    const defaults = requiredObject(input.roleProviderDefaults, "生产角色默认能力");
    const allowed = new Set<StudioProductionRoleBindingKey>([
      "script",
      "director",
      "assets",
      "voice",
      "render",
      "technicalReview",
      "visualReview",
    ]);
    patch.roleProviderDefaults = Object.fromEntries(Object.entries(defaults).map(([role, providerId]) => {
      if (!allowed.has(role as StudioProductionRoleBindingKey)) {
        throw new StudioInputError(`未知的生产角色“${role}”。`);
      }
      const normalizedProviderId = requiredTrimmedString(providerId, `${role} 的默认能力`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedProviderId)) {
        throw new StudioInputError(`${role} 的默认能力编号格式不正确。`);
      }
      return [role, normalizedProviderId];
    })) as StudioRoleProviderDefaults;
  }
  if (input.modelDefaults !== undefined) {
    const defaults = requiredObject(input.modelDefaults, "默认模型");
    const entries = Object.entries(defaults);
    if (entries.length > 32) throw new StudioInputError("默认模型配置不能超过 32 项。");
    patch.modelDefaults = Object.fromEntries(entries.map(([providerId, modelId]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
        throw new StudioInputError("默认模型的 Provider 编号格式不正确。");
      }
      const normalizedModelId = requiredTrimmedString(modelId, `Provider ${providerId} 的默认模型`);
      if (normalizedModelId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalizedModelId)) {
        throw new StudioInputError(`Provider ${providerId} 的默认模型编号格式不正确。`);
      }
      return [providerId, normalizedModelId];
    }));
  }
  if (input.productionDefaults !== undefined) {
    const defaults = requiredObject(input.productionDefaults, "默认生产参数");
    const productionDefaults: Partial<StudioProductionDefaults> = {};
    if (defaults.directorProfileId !== undefined) {
      const directorProfileId = String(defaults.directorProfileId);
      if (!new Set<StudioDirectorProfileId>([
        "auto",
        "documentary-observer",
        "quiet-humanism",
        "urban-poetic",
        "chromatic-storytelling",
        "geometric-control",
        "suspense-staging",
      ]).has(directorProfileId as StudioDirectorProfileId)) {
        throw new StudioInputError("默认导演角色无效。");
      }
      productionDefaults.directorProfileId = directorProfileId as StudioDirectorProfileId;
    }
    if (defaults.reviewMode !== undefined) {
      if (defaults.reviewMode !== "manual") {
        throw new StudioInputError("正式制作必须保留人工终审。");
      }
      productionDefaults.reviewMode = "manual";
    }
    if (defaults.platform !== undefined) {
      if (defaults.platform !== "douyin" && defaults.platform !== "xiaohongshu" && defaults.platform !== "bilibili") {
        throw new StudioInputError("默认目标平台无效。");
      }
      productionDefaults.platform = defaults.platform;
    }
    if (defaults.durationSeconds !== undefined) {
      const durationSeconds = Number(defaults.durationSeconds);
      if (durationSeconds !== 20 && durationSeconds !== 24 && durationSeconds !== 30 && durationSeconds !== 45) {
        throw new StudioInputError("默认视频时长无效。");
      }
      productionDefaults.durationSeconds = durationSeconds;
    }
    patch.productionDefaults = productionDefaults;
  }
  if (input.topicStrategy !== undefined) {
    const strategy = requiredObject(input.topicStrategy, "选题策略");
    const customInstruction = optionalTopicStrategyText(strategy.customInstruction, "选题总编补充指令", 2_000) ?? "";
    const positioning = requiredTopicStrategyTextIfPresent(strategy.positioning, "内容定位", 500);
    const targetAudience = requiredTopicStrategyTextIfPresent(strategy.targetAudience, "核心受众", 500);
    const preferredDirections = requiredTopicStrategyTextIfPresent(strategy.preferredDirections, "优先题材", 1_000);
    const excludedDirections = requiredTopicStrategyTextIfPresent(strategy.excludedDirections, "避开题材", 1_000);
    const sourcePolicy = strategy.sourcePolicy;
    if (sourcePolicy !== undefined && sourcePolicy !== "primary_or_two_independent" && sourcePolicy !== "traceable_source") {
      throw new StudioInputError("候选来源标准无效。");
    }
    patch.topicStrategy = {
      customInstruction,
      ...(positioning ? { positioning } : {}),
      ...(targetAudience ? { targetAudience } : {}),
      ...(preferredDirections ? { preferredDirections } : {}),
      ...(excludedDirections ? { excludedDirections } : {}),
      ...(sourcePolicy ? { sourcePolicy } : {}),
    };
  }
  return patch;
}

function optionalTopicStrategyText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const text = requiredTrimmedString(value, label);
  if (text.length > maxLength) throw new StudioInputError(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

function requiredTopicStrategyTextIfPresent(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const text = requiredTrimmedString(value, label);
  if (text.length > maxLength) throw new StudioInputError(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

export function parseStudioCandidateAdoptionInput(value: unknown): StudioCandidateAdoptionInput {
  const input = requiredObject(value, "候选采用参数");
  if (input.origin !== "trend" && input.origin !== "series") {
    throw new StudioInputError("候选来源必须是热点或系列。");
  }
  if (input.verificationConfirmed !== undefined && typeof input.verificationConfirmed !== "boolean") {
    throw new StudioInputError("核验确认必须是布尔值。");
  }
  return {
    origin: input.origin,
    ...(input.verificationConfirmed === true ? { verificationConfirmed: true } : {}),
  };
}

const MAX_SOURCE_URL_LENGTH = 2048;

// 人工补充来源只做本地字符串规范化，绝不请求、HEAD 或探测远端，避免 SSRF。
// 搜索结果页允许保存留档，但是否计入有效独立来源由来源门槛另行判断。
export function parseStudioCandidateSourcesInput(value: unknown): StudioCandidateSourcesInput {
  const input = requiredObject(value, "补充来源请求");
  if (!Array.isArray(input.evidenceUrls) || input.evidenceUrls.length < 1 || input.evidenceUrls.length > 10) {
    throw new StudioInputError("每次只能提交 1 到 10 条来源链接。");
  }
  if (input.evidenceUrls.some((item) => typeof item !== "string")) {
    throw new StudioInputError("来源链接必须是文本。");
  }
  // 同一请求内按规范化形式去重，保证幂等提交不会重复入库。
  const evidenceUrls = [...new Set(input.evidenceUrls.map((item) => {
    const normalized = canonicalizeSourceUrl(item);
    const hostname = new URL(normalized).hostname;
    if (!isRoutableSourceHostname(hostname) || isReservedExampleHostname(hostname)) {
      throw new StudioInputError("来源链接必须指向可公开访问的网站，不能使用本机、私网或示例地址。");
    }
    return normalized;
  }))];
  if (input.origin !== undefined && input.origin !== "trend" && input.origin !== "series") {
    throw new StudioInputError("候选来源补充只支持热点或系列入口。");
  }
  return { evidenceUrls, ...(input.origin ? { origin: input.origin } : {}) };
}

export function canonicalizeSourceUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new StudioInputError("来源链接不能为空。");
  if (trimmed.length > MAX_SOURCE_URL_LENGTH) {
    throw new StudioInputError("单条来源链接不能超过 2048 个字符。");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new StudioInputError("来源链接格式不正确。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StudioInputError("来源链接必须是 http 或 https 地址。");
  }
  if (url.username || url.password) {
    throw new StudioInputError("来源链接不能携带用户名或密码。");
  }
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.href;
}

// 这里只做纯字符串判断，不解析 DNS、也不访问远端；用于阻止显然不可公开核验的来源凑数。
export function isRoutableSourceHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname.includes(":")) return false;
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second, third] = ipv4 as [number, number, number, number];
    return !(first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113));
  }
  if (!hostname.includes(".")) return false;
  return !["localhost", "local", "internal", "lan", "home"].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isReservedExampleHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return ["example.com", "example.net", "example.org", "test", "invalid", "example"]
    .some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

// 人工补充来源在 evidence 里的统一形态：只追加、不覆盖原有信号；强度为 0，明确不冒充热度信号。
export function manualSupplementEvidence(evidenceUrl: string, collectedAt: string): StudioOpportunityEvidence {
  return {
    source: "manual-supplement",
    platform: "manual",
    keyword: "人工补充来源",
    strength: 0,
    evidenceUrl,
    collectedAt,
  };
}

export function parseStudioDecisionInput(value: unknown): StudioDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioInputError("审片决定格式不正确。");
  }
  const input = value as Record<string, unknown>;
  if (input.executablePlanPath !== undefined) {
    throw new StudioInputError("调整方案不支持提交系统托管文件路径。");
  }
  if (input.action !== "approve" && input.action !== "request_changes" && input.action !== "reject") {
    throw new StudioInputError("请选择批准、调整方案或打回。");
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    throw new StudioInputError("审片说明必须是文字。");
  }
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  const interventionId = requiredTrimmedString(input.interventionId, "人工确认编号");
  const reviewEvidenceId = input.reviewEvidenceId === null
    ? null
    : requiredTrimmedString(input.reviewEvidenceId, "审片证据编号");
  if (reviewEvidenceId !== null && !/^[a-f0-9]{64}$/.test(reviewEvidenceId)) {
    throw new StudioInputError("审片证据编号必须是 SHA-256 摘要。");
  }
  let voiceTiming: StudioDecisionInput["voiceTiming"];
  if (input.action === "request_changes") {
    if (input.voiceTiming !== undefined) {
      if (typeof input.voiceTiming !== "object" || input.voiceTiming === null || Array.isArray(input.voiceTiming)) {
        throw new StudioInputError("调整配音方案时必须填写镜头和新时长。");
      }
      const timing = input.voiceTiming as Record<string, unknown>;
      if (Object.keys(timing).some((field) => field !== "scenePosition" && field !== "durationSeconds")) {
        throw new StudioInputError("配音时长调整包含不支持的字段。");
      }
      if (!Number.isSafeInteger(timing.scenePosition) || Number(timing.scenePosition) < 1) {
        throw new StudioInputError("配音镜头编号必须是正整数。");
      }
      if (typeof timing.durationSeconds !== "number" || !Number.isFinite(timing.durationSeconds)
        || timing.durationSeconds <= 0 || timing.durationSeconds > 180) {
        throw new StudioInputError("配音镜头时长必须大于 0 秒且不超过 180 秒。");
      }
      voiceTiming = {
        scenePosition: Number(timing.scenePosition),
        durationSeconds: timing.durationSeconds,
      };
    }
  } else if (input.voiceTiming !== undefined) {
    throw new StudioInputError("只有调整方案时才能提交配音时长。");
  }
  const parsed = {
    expectedRunRevision: Number(input.expectedRunRevision),
    interventionId,
    reviewEvidenceId,
    ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}),
  };
  if (input.action === "request_changes") {
    if (input.reviewDispositions !== undefined) {
      throw new StudioInputError("只有批准成片时才需要逐条表态。");
    }
    return { ...parsed, action: "request_changes", ...(voiceTiming ? { voiceTiming } : {}) };
  }
  const reviewDispositions = parseReviewDispositions(input.reviewDispositions, input.action);
  return {
    ...parsed,
    action: input.action,
    ...(reviewDispositions ? { reviewDispositions } : {}),
  };
}

function parseReviewDispositions(
  value: unknown,
  action: "approve" | "reject",
): StudioReviewDisposition[] | undefined {
  if (value === undefined) return undefined;
  if (action !== "approve") throw new StudioInputError("只有批准成片时才需要逐条表态。");
  if (!Array.isArray(value)) throw new StudioInputError("逐条表态格式不正确。");
  if (value.length === 0) throw new StudioInputError("逐条表态不能是空列表。");
  const dispositions = value.map((entry, index): StudioReviewDisposition => {
    const label = `第 ${index + 1} 条表态`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new StudioInputError(`${label}格式不正确。`);
    }
    const record = entry as Record<string, unknown>;
    if (record.decision !== "accept" && record.decision !== "reject") {
      throw new StudioInputError(`${label}必须选择采纳或不采纳。`);
    }
    const itemKey = requiredTrimmedString(record.itemKey, `${label}的条目编号`);
    if (!/^[a-f0-9]{64}$/.test(itemKey)) throw new StudioInputError(`${label}的条目编号格式不正确。`);
    if (record.reason !== undefined && typeof record.reason !== "string") {
      throw new StudioInputError(`${label}的理由必须是文字。`);
    }
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    // 采纳的含义就是"照这条结论返修"，返修指令本身就是那条结论，不需要再附理由；
    // 不采纳才是"我看了、我不同意"，那时候理由才是留痕的关键。
    if (record.decision === "accept") return { itemKey, decision: "accept" };
    if (!reason) throw new StudioInputError(`${label}不采纳时必须写明理由。`);
    if (reason.length > 500) throw new StudioInputError(`${label}的理由不能超过 500 个字符。`);
    return { itemKey, decision: "reject", reason };
  });
  if (new Set(dispositions.map((disposition) => disposition.itemKey)).size !== dispositions.length) {
    throw new StudioInputError("同一条审片结论只能表态一次。");
  }
  return dispositions;
}

export function parseStudioSceneRevisionInput(value: unknown): StudioSceneRevisionInput {
  const input = requiredObject(value, "镜头返修请求");
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  if (!Number.isSafeInteger(input.findingIndex) || Number(input.findingIndex) < 0) {
    throw new StudioInputError("审片问题编号必须是非负整数。");
  }
  const note = requiredTrimmedString(input.note, "修改说明");
  if (note.length > 2_000) throw new StudioInputError("修改说明不能超过 2000 个字符。");
  return {
    expectedRunRevision: Number(input.expectedRunRevision),
    expectedAssetVersionId: requiredTrimmedString(input.expectedAssetVersionId, "画面版本"),
    reviewArtifactId: requiredTrimmedString(input.reviewArtifactId, "审片报告"),
    findingIndex: Number(input.findingIndex),
    reuseFromScenePosition: positiveInteger(input.reuseFromScenePosition, "替换来源镜头"),
    note,
  };
}

export function parseStudioSceneResourceRevisionInput(value: unknown): StudioSceneResourceRevisionInput {
  const input = requiredObject(value, "重取素材请求");
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  const note = requiredTrimmedString(input.note, "重取说明");
  if (note.length > 2_000) throw new StudioInputError("重取说明不能超过 2000 个字符。");
  return {
    expectedRunRevision: Number(input.expectedRunRevision),
    reviewArtifactId: requiredTrimmedString(input.reviewArtifactId, "审片报告"),
    findingIndex: nonNegativeInteger(input.findingIndex, "审片条目"),
    note,
  };
}

export function parseStudioNarrationRevisionInput(value: unknown): StudioNarrationRevisionInput {
  const input = requiredObject(value, "旁白字幕返修请求");
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  const narration = requiredTrimmedString(input.narration, "旁白字幕");
  // 上限按"一句话"来定：放宽会让操作员把整篇稿子塞进一镜，收紧了拦不住真正要改的长句。
  if (narration.length > 600) throw new StudioInputError("单镜旁白字幕不能超过 600 个字符。");
  // 旁白是一句口播、字幕是一行字：换行在成片里没有对应语义，配音会把它读成两段，
  // 与其让它在渲染时才显出怪样子，不如在这里就说清它只能是一行。
  if (/[\r\n\u2028\u2029]/.test(narration)) {
    throw new StudioInputError("单镜旁白字幕只能是一行，不能包含换行。");
  }
  const note = requiredTrimmedString(input.note, "修改说明");
  if (note.length > 2_000) throw new StudioInputError("修改说明不能超过 2000 个字符。");
  return {
    expectedRunRevision: Number(input.expectedRunRevision),
    scenePosition: positiveInteger(input.scenePosition, "镜头位置"),
    narration,
    note,
  };
}

export function parseStudioVisualReinspectionInput(value: unknown): StudioVisualReinspectionInput {
  const input = requiredObject(value, "成片补查请求");
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  const reviewEvidenceId = requiredTrimmedString(input.reviewEvidenceId, "审片证据编号");
  if (!/^[a-f0-9]{64}$/.test(reviewEvidenceId)) {
    throw new StudioInputError("审片证据编号必须是 SHA-256 摘要。");
  }
  return { expectedRunRevision: Number(input.expectedRunRevision), reviewEvidenceId };
}

const PUBLISH_PLATFORMS = new Set<StudioPublishPlatformId>([
  "douyin",
  "toutiao",
  "kuaishou",
  "bilibili",
  "xiaohongshu",
]);

export function parseStudioPublishInput(value: unknown): StudioPublishInput {
  const input = requiredObject(value, "发布请求");
  const requestId = requiredTrimmedString(input.requestId, "发布请求编号");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) {
    throw new StudioInputError("发布请求编号格式不正确。");
  }
  if (!Array.isArray(input.platformIds) || input.platformIds.length === 0) {
    throw new StudioInputError("请至少选择一个发布平台。");
  }
  const platformIds = input.platformIds.map((value) => {
    if (typeof value !== "string" || !PUBLISH_PLATFORMS.has(value as StudioPublishPlatformId)) {
      throw new StudioInputError("发布平台无效。");
    }
    return value as StudioPublishPlatformId;
  });
  if (new Set(platformIds).size !== platformIds.length) {
    throw new StudioInputError("发布平台不能重复选择。");
  }
  const confirmationsInput = requiredObject(input.confirmations, "发布合规确认");
  const confirmationKeys: Array<keyof StudioPublishConfirmations> = [
    "finalContent",
    "aigcDisclosure",
    "rightsAndLikeness",
    "factualAccuracy",
    "commercialDisclosure",
  ];
  const confirmations = Object.fromEntries(confirmationKeys.map((key) => {
    if (typeof confirmationsInput[key] !== "boolean") {
      throw new StudioInputError("发布合规确认必须逐项选择。");
    }
    return [key, confirmationsInput[key]];
  })) as unknown as StudioPublishConfirmations;
  return { requestId, platformIds, confirmations };
}

const OPPORTUNITY_STATUSES = new Set<StudioOpportunityStatus>([
  "draft",
  "shortlisted",
  "approved",
  "rejected",
  "tested",
]);

const SCORE_KEYS: Array<keyof StudioOpportunityInput["scores"]> = [
  "audienceReach",
  "visualFeasibility",
  "productionCostEfficiency",
  "novelty",
  "monetization",
  "seriesPotential",
  "complianceRisk",
];

export function parseStudioOpportunityInput(value: unknown): StudioOpportunityInput {
  const input = requiredObject(value, "机会");
  const evidenceValue = input.evidence;
  if (!Array.isArray(evidenceValue) || evidenceValue.length === 0) {
    throw new StudioInputError("机会至少需要一条来源信号。");
  }
  const evidence = evidenceValue.map((entry, index): StudioOpportunityEvidence => {
    const signal = requiredObject(entry, `第 ${index + 1} 条来源信号`);
    const strength = boundedNumber(signal.strength, `第 ${index + 1} 条信号强度`);
    const evidenceUrl = optionalString(signal.evidenceUrl);
    if (evidenceUrl) {
      let protocol: string;
      try {
        protocol = new URL(evidenceUrl).protocol;
      } catch {
        throw new StudioInputError(`第 ${index + 1} 条来源链接格式不正确。`);
      }
      if (protocol !== "http:" && protocol !== "https:") {
        throw new StudioInputError(`第 ${index + 1} 条来源链接必须使用 HTTP 或 HTTPS。`);
      }
    }
    const collectedAt = optionalString(signal.collectedAt);
    if (collectedAt && !Number.isFinite(Date.parse(collectedAt))) {
      throw new StudioInputError(`第 ${index + 1} 条信号的采集时间格式不正确。`);
    }
    return {
      source: requiredTrimmedString(signal.source, `第 ${index + 1} 条信号来源`),
      platform: requiredTrimmedString(signal.platform, `第 ${index + 1} 条信号平台`),
      keyword: requiredTrimmedString(signal.keyword, `第 ${index + 1} 条信号关键词`),
      strength,
      ...(evidenceUrl ? { evidenceUrl } : {}),
      ...(collectedAt ? { collectedAt } : {}),
    };
  });

  const scoresValue = requiredObject(input.scores, "机会评分");
  const scores = Object.fromEntries(
    SCORE_KEYS.map((key) => [key, boundedNumber(scoresValue[key], `评分项 ${key}`)]),
  ) as StudioOpportunityInput["scores"];
  const track = requiredTrimmedString(input.track, "系列标识");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track)) {
    throw new StudioInputError("系列标识只能使用小写字母、数字和连字符。");
  }

  const candidateId = optionalString(input.candidateId);
  if (candidateId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId)) {
    throw new StudioInputError("候选编号格式不正确。");
  }
  const origin = optionalString(input.origin);
  if (origin && origin !== "manual" && origin !== "trend" && origin !== "series") {
    throw new StudioInputError("选题来源无效。");
  }
  const category = optionalString(input.category);
  if (category && !TOPIC_CATEGORIES.has(category as StudioTopicCategory)) {
    throw new StudioInputError("选题分类无效。");
  }
  const episodeNumber = input.episodeNumber === undefined
    ? undefined
    : positiveInteger(input.episodeNumber, "系列集数");
  const editorialDecision = input.editorialDecision === undefined
    ? undefined
    : parseEditorialDecision(input.editorialDecision);
  const visualProof = optionalString(input.visualProof);
  const visualPlan = input.visualPlan === undefined
    ? undefined
    : parseStudioVisualPlan(input.visualPlan);

  return {
    title: requiredTrimmedString(input.title, "标题"),
    platform: requiredTrimmedString(input.platform, "平台"),
    track,
    audience: requiredTrimmedString(input.audience, "目标受众"),
    painPoint: requiredTrimmedString(input.painPoint, "用户痛点"),
    hook: requiredTrimmedString(input.hook, "开场钩子"),
    evidence,
    scores,
    ...(candidateId ? { candidateId } : {}),
    ...(origin ? { origin: origin as "manual" | StudioCandidateOrigin } : {}),
    ...(category ? { category: category as StudioTopicCategory } : {}),
    ...(optionalString(input.seriesId) ? { seriesId: optionalString(input.seriesId)! } : {}),
    ...(optionalString(input.seriesName) ? { seriesName: optionalString(input.seriesName)! } : {}),
    ...(episodeNumber ? { episodeNumber } : {}),
    ...(editorialDecision ? { editorialDecision } : {}),
    ...(visualProof ? { visualProof } : {}),
    ...(visualPlan ? { visualPlan } : {}),
  };
}

const VISUAL_SOURCES = new Set<StudioVisualSource>(["creator", "stock", "screen", "local-card", "generated"]);

export function parseStudioVisualPlan(value: unknown): StudioVisualPlan {
  const input = requiredObject(value, "具体画面方案");
  if (!Array.isArray(input.beats) || input.beats.length < 1 || input.beats.length > 12) {
    throw new StudioInputError("具体画面方案必须包含 1 到 12 个镜头节拍。");
  }
  const beats = input.beats.map((entry, index): StudioVisualBeat => {
    const beat = requiredObject(entry, `第 ${index + 1} 个镜头节拍`);
    const source = requiredTrimmedString(beat.source, `第 ${index + 1} 个镜头来源`);
    if (!VISUAL_SOURCES.has(source as StudioVisualSource)) {
      throw new StudioInputError(`第 ${index + 1} 个镜头来源无效。`);
    }
    return {
      id: requiredTrimmedString(beat.id, `第 ${index + 1} 个镜头编号`),
      role: requiredTrimmedString(beat.role, `第 ${index + 1} 个镜头作用`),
      duration: requiredTrimmedString(beat.duration, `第 ${index + 1} 个镜头时段`),
      description: requiredTrimmedString(beat.description, `第 ${index + 1} 个镜头画面`),
      searchQuery: requiredTrimmedString(beat.searchQuery, `第 ${index + 1} 个镜头素材线索`),
      source: source as StudioVisualSource,
    };
  });
  if (new Set(beats.map((beat) => beat.id)).size !== beats.length) {
    throw new StudioInputError("具体画面方案的镜头编号不能重复。");
  }
  return { strategy: requiredTrimmedString(input.strategy, "具体画面策略"), beats };
}

function parseEditorialDecision(value: unknown): StudioEditorialDecision {
  const input = requiredObject(value, "编辑决策");
  const verdict = requiredTrimmedString(input.verdict, "编辑结论");
  if (verdict !== "produce_video" && verdict !== "produce_image_story" && verdict !== "skip") {
    throw new StudioInputError("编辑结论无效。");
  }
  const recommendedTemplate = input.recommendedTemplate === undefined
    ? undefined
    : parseTemplateRecommendation(input.recommendedTemplate);
  if (verdict === "skip" && recommendedTemplate) {
    throw new StudioInputError("跳过的选题不能推荐制作模板。");
  }
  return {
    verdict,
    score: boundedNumber(input.score, "生产价值分"),
    reasons: requiredStringArray(input.reasons, "编辑理由"),
    guardrails: requiredStringArray(input.guardrails, "制作边界"),
    ...(recommendedTemplate ? { recommendedTemplate } : {}),
  };
}

function parseTemplateRecommendation(value: unknown): StudioTemplateRecommendation {
  const input = requiredObject(value, "推荐模板");
  return {
    id: requiredTrimmedString(input.id, "推荐模板编号"),
    name: requiredTrimmedString(input.name, "推荐模板名称"),
    format: requiredTrimmedString(input.format, "推荐视频形态"),
    rationale: requiredTrimmedString(input.rationale, "模板推荐理由"),
  };
}

const TOPIC_CATEGORIES = new Set<StudioTopicCategory>([
  "society",
  "finance-career",
  "technology",
  "lifestyle",
  "health-sports",
  "education",
  "entertainment",
  "local-culture",
  "food",
  "travel",
  "gaming",
  "automotive",
  "fashion-beauty",
  "parenting",
  "agriculture-rural",
]);

export function parseStudioSeriesInput(value: unknown): StudioSeriesInput {
  const input = requiredObject(value, "系列");
  const category = requiredTrimmedString(input.category, "内容分类");
  if (!TOPIC_CATEGORIES.has(category as StudioTopicCategory)) {
    throw new StudioInputError("内容分类无效。");
  }
  const track = requiredTrimmedString(input.track, "系列标识");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track)) {
    throw new StudioInputError("系列标识只能使用小写字母、数字和连字符。");
  }
  if (!Array.isArray(input.pillars)) throw new StudioInputError("内容支柱格式不正确。");
  const pillars = input.pillars.map((pillar, index) => requiredTrimmedString(pillar, `第 ${index + 1} 个内容支柱`));
  if (pillars.length < 2) throw new StudioInputError("系列至少需要两个内容支柱。");
  if (pillars.length > 8) throw new StudioInputError("系列最多支持八个内容支柱。");
  const continuityRules = input.continuityRules === undefined
    ? undefined
    : optionalBoundedStringArray(input.continuityRules, "连续性规则", 8);
  const releaseCadence = input.releaseCadence === undefined
    ? undefined
    : requiredTrimmedString(input.releaseCadence, "更新频率");
  if (releaseCadence !== undefined && !["weekly", "biweekly", "monthly", "flexible"].includes(releaseCadence)) {
    throw new StudioInputError("更新频率无效。");
  }
  const targetEpisodeCount = input.targetEpisodeCount === undefined
    ? undefined
    : positiveInteger(input.targetEpisodeCount, "目标集数");
  if (targetEpisodeCount !== undefined && targetEpisodeCount > 100) {
    throw new StudioInputError("目标集数最多支持 100 集。");
  }
  const platform = requiredTrimmedString(input.platform, "首发平台");
  if (platform !== "douyin" && platform !== "xiaohongshu" && platform !== "bilibili") {
    throw new StudioInputError("首发平台只支持抖音、小红书或哔哩哔哩。");
  }
  return {
    name: requiredTrimmedString(input.name, "系列名称"),
    premise: requiredTrimmedString(input.premise, "系列承诺"),
    audience: requiredTrimmedString(input.audience, "目标受众"),
    platform,
    category: category as StudioTopicCategory,
    track,
    pillars,
    tone: requiredTrimmedString(input.tone, "表达语气"),
    visualStyle: requiredTrimmedString(input.visualStyle, "视觉方向"),
    ...(input.seasonTitle === undefined ? {} : { seasonTitle: requiredTrimmedString(input.seasonTitle, "本季名称") }),
    ...(input.seasonArc === undefined ? {} : { seasonArc: requiredTrimmedString(input.seasonArc, "本季篇章") }),
    ...(input.planningPeriod === undefined ? {} : { planningPeriod: requiredTrimmedString(input.planningPeriod, "计划周期") }),
    ...(releaseCadence ? { releaseCadence: releaseCadence as NonNullable<StudioSeriesInput["releaseCadence"]> } : {}),
    ...(targetEpisodeCount ? { targetEpisodeCount } : {}),
    ...(continuityRules ? { continuityRules } : {}),
  };
}

export function parseStudioSeriesEpisodePlanInput(value: unknown): StudioSeriesEpisodePlanInput {
  const input = requiredObject(value, "单集路线图");
  return {
    expectedRevision: positiveInteger(input.expectedRevision, "系列版本"),
    pillar: requiredTrimmedString(input.pillar, "内容支柱"),
    title: requiredTrimmedString(input.title, "单集标题"),
    viewerPromise: requiredTrimmedString(input.viewerPromise, "观众收获"),
    hook: requiredTrimmedString(input.hook, "开场钩子"),
    payoff: requiredTrimmedString(input.payoff, "本集兑现"),
    fromPrevious: optionalBoundedStringArray(input.fromPrevious, "承接上一集", 8),
    toNext: optionalBoundedStringArray(input.toNext, "留给下一集", 8),
  };
}

function optionalBoundedStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value)) throw new StudioInputError(`${label}格式不正确。`);
  if (value.length > maximum) throw new StudioInputError(`${label}最多支持 ${maximum} 项。`);
  return value.map((entry, index) => requiredTrimmedString(entry, `${label}第 ${index + 1} 项`));
}

export function parseStudioOpportunityStatusInput(value: unknown): StudioOpportunityStatusInput {
  const input = requiredObject(value, "机会状态更新");
  if (typeof input.status !== "string" || !OPPORTUNITY_STATUSES.has(input.status as StudioOpportunityStatus)) {
    throw new StudioInputError("机会状态无效。");
  }
  return { status: input.status as StudioOpportunityStatus };
}

export class StudioInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioInputError";
  }
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioInputError(`${label}格式不正确。`);
  }
  return value as Record<string, unknown>;
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StudioInputError(`${label}不能为空。`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new StudioInputError("可选内容必须是文字。");
  }
  return value.trim() || undefined;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new StudioInputError(`${label}不能为空。`);
  return value.map((item, index) => requiredTrimmedString(item, `${label}第 ${index + 1} 项`));
}

function boundedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new StudioInputError(`${label}必须是 0 到 100 之间的数字。`);
  }
  return value;
}

function boundedRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new StudioInputError(`${label}必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StudioInputError(`${label}必须是正整数。`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StudioInputError(`${label}必须是非负整数。`);
  }
  return value;
}
