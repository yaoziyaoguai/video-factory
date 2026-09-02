export const BRIEF_PROTOCOL_VERSION = "video-factory/brief-v1" as const;
export const WORKER_PROTOCOL_VERSION = "video-factory/worker-v1" as const;

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
  maxPaidShots: number;
  maxCostCny: number;
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

export interface ProductionEditorialDirection {
  verdict: "produce_video" | "produce_image_story";
  reasons: string[];
  guardrails: string[];
}

export interface ProductionWorkflowFeatures {
  assetSemanticRank: boolean;
  referenceGrammar: boolean;
}

export type ProductionModelSelectionSource = "system_default" | "global_default" | "template_default" | "run_override" | "node_override";

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
  platform: string;
  reviewMode: "manual" | "automatic";
  templateSnapshot?: ProductionTemplateSnapshot;
  providers: ProductionProviderBindings;
  models?: Record<string, string>;
  modelSelectionSources?: Record<string, ProductionModelSelectionSource>;
  workflowFeatures?: ProductionWorkflowFeatures;
  referenceVideo?: ProductionReferenceVideo;
  director?: ProductionDirectorDirection;
  economics: ProductionEconomics;
  spendFeedback?: ProductionSpendFeedback[];
  voiceDirection: ProductionVoiceDirection;
  editorial?: ProductionEditorialDirection;
  seriesContext?: ProductionSeriesContext;
  creationContext?: {
    origin: "trend" | "series" | "manual";
    opportunityId: string;
  };
}

export function parseBrief(value: unknown): ProductionBrief {
  if (!isRecord(value)) {
    throw new Error("Brief must be a JSON object.");
  }
  if (value.protocolVersion !== BRIEF_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported brief protocolVersion: ${String(value.protocolVersion)}; expected ${BRIEF_PROTOCOL_VERSION}.`,
    );
  }

  const providers = requireRecord(value.providers, "providers");
  const models = parseModelSelections(value.models);
  const modelSelectionSources = parseModelSelectionSources(value.modelSelectionSources, models);
  const workflowFeatures = parseWorkflowFeatures(value.workflowFeatures);
  const referenceVideo = parseReferenceVideo(value.referenceVideo);
  const director = parseDirectorDirection(value.director, providers);
  const economics = parseEconomics(value.economics);
  const spendFeedback = parseSpendFeedback(value.spendFeedback);
  const voiceDirection = parseVoiceDirection(value.voiceDirection);
  const editorial = parseEditorialDirection(value.editorial);
  const seriesContext = parseProductionSeriesContext(value.seriesContext);
  const creationContext = parseCreationContext(value.creationContext);
  const templateSnapshot = value.templateSnapshot === undefined
    ? undefined
    : parseProductionTemplateSnapshot(value.templateSnapshot);
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
  if (value.reviewMode !== "manual" && value.reviewMode !== "automatic") {
    throw new Error("reviewMode must be 'manual' or 'automatic'.");
  }

  return {
    protocolVersion: BRIEF_PROTOCOL_VERSION,
    title: requireString(value.title, "title"),
    angle: requireString(value.angle, "angle"),
    audience: requireString(value.audience, "audience"),
    nicheSlug: requireString(value.nicheSlug, "nicheSlug"),
    durationSeconds: Number(durationSeconds),
    platform: requireString(value.platform, "platform"),
    reviewMode: value.reviewMode,
    ...(templateSnapshot ? { templateSnapshot } : {}),
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
    ...(workflowFeatures.assetSemanticRank || workflowFeatures.referenceGrammar ? { workflowFeatures } : {}),
    ...(referenceVideo ? { referenceVideo } : {}),
    ...(director ? { director } : {}),
    economics,
    ...(spendFeedback.length ? { spendFeedback } : {}),
    voiceDirection,
    ...(editorial ? { editorial } : {}),
    ...(seriesContext ? { seriesContext } : {}),
    ...(creationContext ? { creationContext } : {}),
  };
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
  if (input.origin !== "trend" && input.origin !== "series" && input.origin !== "manual") {
    throw new Error("creationContext.origin is invalid.");
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
  return { assetSemanticRank: input.assetSemanticRank, referenceGrammar: input.referenceGrammar };
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

export function parsePersistedBrief(value: unknown): ProductionBrief {
  const migrated = migratePersistedReferenceVideo(value);
  try {
    return parseBrief(migrated);
  } catch (strictError) {
    if (!isRecord(migrated) || !isRecord(migrated.providers) || !isRecord(migrated.voiceDirection)) throw strictError;
    const providerId = migrated.providers.voice;
    const profileId = migrated.voiceDirection.profileId;
    if (typeof providerId !== "string" || typeof profileId !== "string") throw strictError;
    if (voiceProviderForProfile(profileId) === providerId) throw strictError;
    const compatibleProfileId = persistedVoiceProfileForProvider(providerId);
    if (!compatibleProfileId) throw strictError;
    return parseBrief({
      ...migrated,
      voiceDirection: { ...migrated.voiceDirection, profileId: compatibleProfileId },
    });
  }
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
      maxPaidShots: 0,
      maxCostCny: 0,
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
  // 历史 brief 仍可能携带全视频限额；仅校验格式后归零，付费安全由逐次报价和人工授权负责。
  boundedNumber(input.maxPaidShots, "economics.maxPaidShots", 0, 20, true);
  boundedNumber(input.maxCostCny, "economics.maxCostCny", 0, 100_000, false);
  return { recipeId, allowMeteredProviders: input.allowMeteredProviders, maxPaidShots: 0, maxCostCny: 0 };
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
