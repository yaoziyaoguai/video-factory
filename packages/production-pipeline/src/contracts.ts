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
  director?: ProductionDirectorDirection;
  economics: ProductionEconomics;
  voiceDirection: ProductionVoiceDirection;
  editorial?: ProductionEditorialDirection;
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
  const director = parseDirectorDirection(value.director, providers);
  const economics = parseEconomics(value.economics);
  const voiceDirection = parseVoiceDirection(value.voiceDirection);
  const editorial = parseEditorialDirection(value.editorial);
  const templateSnapshot = value.templateSnapshot === undefined
    ? undefined
    : parseProductionTemplateSnapshot(value.templateSnapshot);
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
    ...(director ? { director } : {}),
    economics,
    voiceDirection,
    ...(editorial ? { editorial } : {}),
  };
}

export function parsePersistedBrief(value: unknown): ProductionBrief {
  try {
    return parseBrief(value);
  } catch (strictError) {
    if (!isRecord(value) || !isRecord(value.providers) || !isRecord(value.voiceDirection)) throw strictError;
    const providerId = value.providers.voice;
    const profileId = value.voiceDirection.profileId;
    if (typeof providerId !== "string" || typeof profileId !== "string") throw strictError;
    if (voiceProviderForProfile(profileId) === providerId) throw strictError;
    const compatibleProfileId = persistedVoiceProfileForProvider(providerId);
    if (!compatibleProfileId) throw strictError;
    return parseBrief({
      ...value,
      voiceDirection: { ...value.voiceDirection, profileId: compatibleProfileId },
    });
  }
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
  const maxPaidShots = boundedNumber(input.maxPaidShots, "economics.maxPaidShots", 0, 20, true);
  const maxCostCny = boundedNumber(input.maxCostCny, "economics.maxCostCny", 0, 100_000, false);
  if (!input.allowMeteredProviders && (maxPaidShots !== 0 || maxCostCny !== 0)) {
    throw new Error("economics.maxPaidShots and economics.maxCostCny must be 0 when metered providers are disabled.");
  }
  if (input.allowMeteredProviders && ((maxPaidShots === 0) !== (maxCostCny === 0))) {
    throw new Error("economics.maxPaidShots and economics.maxCostCny must either both bound metered generation or both be 0.");
  }
  return { recipeId, allowMeteredProviders: input.allowMeteredProviders, maxPaidShots, maxCostCny };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { parseProductionTemplateSnapshot, type ProductionTemplateSnapshot } from "@video-factory/template-core";
