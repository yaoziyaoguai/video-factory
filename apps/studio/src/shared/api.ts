import type { ProductionBlueprintPatch, ProductionTemplateInput } from "@video-factory/template-core";

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

export const DEFAULT_STUDIO_TOPIC_STRATEGY: StudioTopicStrategy = {
  positioning: "把复杂热点转成普通人能看懂、能验证、看完有收获的短视频。",
  targetAudience: "希望快速理解新事物，但反感标题党和空泛说教的中文短视频用户。",
  preferredDirections: "真实生活影响\n可实证的方法或变化\n有清楚反差、过程或结论\n能发展成系列",
  excludedDirections: "只有热度、没有新角度\n无法找到可靠画面或事实来源\n消费灾难、伤亡或未经证实的争议\n只能靠大段说明卡讲清",
  sourcePolicy: "primary_or_two_independent",
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
  requirement?: string;
  defaultModelId?: string;
  modelProfiles?: StudioModelProfile[];
  deliveryTypes?: Array<"editorial_card" | "stock_video" | "stock_image" | "generated_image" | "generated_video">;
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
  providerId: string;
  generatedAt: string;
  evidence: StudioOpportunityEvidence[];
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
  auditStatus: "passed" | "fallback" | "human_override" | "stale";
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
  editorialDecision?: StudioEditorialDecision;
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
  editorialDecision?: StudioEditorialDecision;
  visualPlan?: StudioVisualPlan;
}

export interface StudioCandidateAdoptionInput {
  origin: StudioCandidateOrigin;
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
  nextAction?: "review" | "confirm_spend" | "regenerate";
  videoContentUrl?: string;
  archivedAt?: string;
  creationOrigin?: "trend" | "series" | "manual";
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

export interface StudioRunArchiveInput {
  runIds: string[];
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
  phases?: StudioRunPhase[];
  progress?: StudioRunProgress;
  currentAction?: StudioRunCurrentAction;
  failure?: StudioRunFailure;
  resultAvailability?: StudioRunResultAvailability;
  activeIntervention?: StudioIntervention;
  videoArtifactId?: string;
  publishPackageArtifactId?: string;
  pauseRequested?: boolean;
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
  agentLoopProgress?: StudioAgentLoopProgress;
  executionConfiguration?: StudioNodeExecutionConfiguration;
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
  iteration: number;
  maxIterations: number;
  completedIterations: number;
  phase: "producing" | "auditing" | "repairing" | "passed" | "exhausted";
  latestAudit?: {
    verdict: "pass" | "repair";
    score: number;
    summary: string;
  };
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
  actualCostSource?: "provider_reported" | "configured_rate";
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

export interface StudioNodeInputOverrideInput {
  input: unknown;
  confirmTerminalEdit?: boolean;
}

export interface StudioNodeExecutionConfigurationInput {
  providerId?: string;
  modelSelections?: Record<string, string | null>;
  assetProviderIds?: string[];
  economics?: {
    allowMeteredProviders: boolean;
  };
  confirmTerminalEdit?: boolean;
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
  actualCostSource?: "configured_rate";
  error?: string;
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
  licenseNote?: string;
  contentUrl?: string;
}

export interface StudioIntervention {
  id: string;
  nodeId: string;
  reason: string;
  options: Array<"approve" | "request_changes" | "reject">;
  createdAt: string;
}

export interface StudioDecision {
  id: string;
  action: "approve" | "request_changes" | "reject";
  actor: string;
  note?: string;
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
  generatedAt: string;
  totalItems: number;
  needsReviewCount: number;
  legacyRunsWithoutManifest: number;
  reconstructedRunCount: number;
  unreadableManifestCount: number;
  truncatedRunCount: number;
  truncatedItemCount: number;
  categories: Record<StudioResourceManifestItem["category"], number>;
  items: StudioResourceManifestItem[];
  assetIndex: StudioAssetIndex;
}

export interface StudioTemplateExperimentScorecard {
  templateId: "trend-fact-brief" | "knowledge-explainer" | "photo-story";
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
  actualCostSource?: "provider_reported" | "configured_rate";
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
  scenePosition?: number;
  category: string;
  description: string;
  suggestion: string;
  targetNodeIds: Array<"script" | "visual-direction" | "assets">;
}

export interface StudioReworkContext {
  sourceRunId: string;
  sourceRunRevision: number;
  rejectionReason?: string;
  nodeInstructions: {
    script: string;
    visualDirection: string;
    assets: string;
  };
  findings: StudioReworkFinding[];
  previousScript?: Record<string, unknown>;
  previousDirectorPlan?: Record<string, unknown>;
}

export interface StudioReworkDraft {
  input: StudioProductionInput;
  inheritedNodeIds: string[];
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
  template?: StudioTemplateSelection;
  editorial?: {
    verdict: "produce_video" | "produce_image_story";
    reasons: string[];
    guardrails: string[];
  };
  seriesContext?: StudioSeriesProductionContext;
  creationContext?: {
    origin: "trend" | "series" | "manual";
    opportunityId: string;
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
}

export interface StudioReferenceVideo {
  uploadId: string;
  label: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/webm";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface StudioDecisionInput {
  action: "approve" | "reject";
  note?: string;
}

export interface StudioSceneRevisionInput {
  expectedRunRevision: number;
  expectedAssetVersionId: string;
  reviewArtifactId: string;
  findingIndex: number;
  reuseFromScenePosition: number;
  note: string;
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

export function parseStudioDecisionInput(value: unknown): StudioDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioInputError("审片决定格式不正确。");
  }
  const input = value as Record<string, unknown>;
  if (input.action !== "approve" && input.action !== "reject") {
    throw new StudioInputError("请选择批准或打回。");
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    throw new StudioInputError("审片说明必须是文字。");
  }
  return { action: input.action, ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}) };
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
  };
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
