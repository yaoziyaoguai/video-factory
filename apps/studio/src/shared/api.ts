export type StudioRunStatus = "pending" | "running" | "succeeded" | "failed" | "needs_human" | "rejected";

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
  engine: "macos" | "kokoro";
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

export interface StudioCreatorSettings {
  voiceDirection: StudioVoiceDirection;
  defaultRecipeId: StudioProductionRecipeId;
  defaultAssetProviderId?: string;
}

export interface StudioCreatorSettingsPatch {
  voiceDirection?: StudioVoiceDirection;
  defaultRecipeId?: StudioProductionRecipeId;
  defaultAssetProviderId?: string;
}

export interface StudioProvider {
  id: string;
  capability: string;
  label: string;
  available: boolean;
  kind: "local" | "external" | "test";
  status?: "ready" | "needs_config" | "planned";
  billing?: "free" | "subscription" | "metered";
  description?: string;
  modes?: string[];
  latency?: "instant" | "seconds" | "minutes";
  estimatedCnyPerClip?: number;
  docsUrl?: string;
  requirement?: string;
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
  providerId: string;
  generatedAt: string;
  evidence: StudioOpportunityEvidence[];
  score: StudioOpportunityScore;
  visualPlan?: StudioVisualPlan;
  category?: StudioTopicCategory;
  freshness?: StudioCandidateFreshness;
  risk?: StudioCandidateRisk;
}

export interface StudioCandidateInboxItem extends StudioTrendCandidate {
  origin: StudioCandidateOrigin;
  category: StudioTopicCategory;
  freshness: StudioCandidateFreshness;
  risk: StudioCandidateRisk;
  verification: StudioCandidateVerification;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
}

export interface StudioCandidateInboxQuery {
  origins?: StudioCandidateOrigin[];
  categories?: StudioTopicCategory[];
  platforms?: string[];
  limit?: number;
}

export interface StudioCandidateInboxFacets {
  total: number;
  origins: Partial<Record<StudioCandidateOrigin, number>>;
  categories: Partial<Record<StudioTopicCategory, number>>;
  platforms: Record<string, number>;
}

export interface StudioCandidateInbox {
  items: StudioCandidateInboxItem[];
  facets: StudioCandidateInboxFacets;
  generatedAt: string;
}

export type StudioSeriesStatus = "active" | "paused";

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
  nextEpisodeNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSeriesInput {
  name: string;
  premise: string;
  audience: string;
  platform: string;
  category: StudioTopicCategory;
  track: string;
  pillars: string[];
  tone: string;
  visualStyle: string;
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

export interface StudioOpportunityScore {
  audienceReach: number;
  visualFeasibility: number;
  productionCostEfficiency: number;
  novelty: number;
  monetization: number;
  seriesPotential: number;
  complianceRisk: number;
  final: number;
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
  createdAt: string;
  updatedAt: string;
  origin?: "manual" | StudioCandidateOrigin;
  category?: StudioTopicCategory;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  verification?: StudioCandidateVerification;
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
  scores: Omit<StudioOpportunityScore, "final">;
  candidateId?: string;
  origin?: "manual" | StudioCandidateOrigin;
  category?: StudioTopicCategory;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  verification?: StudioCandidateVerification;
  visualPlan?: StudioVisualPlan;
}

export interface StudioCandidateAdoptionInput {
  verificationConfirmed?: boolean;
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
  nextAction?: "review";
  videoContentUrl?: string;
}

export interface StudioRunDetail extends StudioRunSummary {
  revision: number;
  angle: string;
  audience: string;
  nicheSlug: string;
  reviewMode: "manual" | "automatic";
  nodes: StudioNode[];
  artifacts: StudioArtifact[];
  decisions: StudioDecision[];
  activeIntervention?: StudioIntervention;
  videoArtifactId?: string;
  publishPackageArtifactId?: string;
}

export interface StudioNode {
  id: string;
  label: string;
  role?: string;
  status: StudioRunStatus | "pending" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  artifactIds: string[];
  qualityGateResults: Array<{
    gateId: string;
    status: "passed" | "failed" | "needs_human";
    reasons: string[];
  }>;
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
  licenseNote?: string;
  contentUrl?: string;
}

export interface StudioIntervention {
  id: string;
  nodeId: string;
  reason: string;
  options: Array<"approve" | "reject">;
  createdAt: string;
}

export interface StudioDecision {
  id: string;
  action: "approve" | "reject";
  actor: string;
  note?: string;
  createdAt: string;
}

export interface StartRunResponse {
  runId: string;
  status: "running";
}

export interface StudioProductionInput {
  protocolVersion: "video-factory/brief-v1";
  title: string;
  angle: string;
  audience: string;
  nicheSlug: string;
  durationSeconds: number;
  platform: string;
  reviewMode: "manual" | "automatic";
  voiceDirection: StudioVoiceDirection;
  providers: {
    script: string;
    director?: string;
    assets: string;
    voice: string;
    render: string;
    technicalReview: string;
  };
  director?: {
    profileId: "auto" | "documentary-observer" | "quiet-humanism" | "urban-poetic" | "chromatic-storytelling" | "geometric-control" | "suspense-staging";
    assetProviderIds: string[];
  };
  economics: {
    recipeId: StudioProductionRecipeId;
    allowMeteredProviders: boolean;
    maxPaidShots: number;
    maxCostCny: number;
  };
}

export interface StudioDecisionInput {
  action: "approve" | "reject";
  actor: string;
  note?: string;
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
  if (!profileId.startsWith("macos:") && !profileId.startsWith("kokoro:")) {
    throw new StudioInputError("请选择当前设备支持的本地音色。");
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
    if (!profileId.startsWith("macos:") && !profileId.startsWith("kokoro:")) {
      throw new StudioInputError("请选择当前设备支持的本地音色。");
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
  return patch;
}

export function parseStudioCandidateAdoptionInput(value: unknown): StudioCandidateAdoptionInput {
  if (value === undefined || value === null) return {};
  const input = requiredObject(value, "候选采用参数");
  if (input.verificationConfirmed !== undefined && typeof input.verificationConfirmed !== "boolean") {
    throw new StudioInputError("核验确认必须是布尔值。");
  }
  return input.verificationConfirmed === true ? { verificationConfirmed: true } : {};
}

export function parseStudioDecisionInput(value: unknown): StudioDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioInputError("审片决定格式不正确。");
  }
  const input = value as Record<string, unknown>;
  if (input.action !== "approve" && input.action !== "reject") {
    throw new StudioInputError("请选择批准或打回。");
  }
  if (typeof input.actor !== "string" || !input.actor.trim()) {
    throw new StudioInputError("审片人不能为空。");
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    throw new StudioInputError("审片说明必须是文字。");
  }
  return {
    action: input.action,
    actor: input.actor.trim(),
    ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}),
  };
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
  return {
    name: requiredTrimmedString(input.name, "系列名称"),
    premise: requiredTrimmedString(input.premise, "系列承诺"),
    audience: requiredTrimmedString(input.audience, "目标受众"),
    platform: requiredTrimmedString(input.platform, "首发平台"),
    category: category as StudioTopicCategory,
    track,
    pillars,
    tone: requiredTrimmedString(input.tone, "表达语气"),
    visualStyle: requiredTrimmedString(input.visualStyle, "视觉方向"),
  };
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
