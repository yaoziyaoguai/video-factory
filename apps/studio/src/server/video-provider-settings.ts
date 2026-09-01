export type MeteredVideoProviderSettings = MiniMaxProviderSettings | SeedanceProviderSettings | WanProviderSettings;

export const DEFAULT_SEEDANCE_MODEL_ID = "doubao-seedance-2-5-260628";
export const DEFAULT_MINIMAX_VIDEO_MODEL_ID = "MiniMax-Hailuo-2.3";
export const DEFAULT_WAN_VIDEO_MODEL_ID = "wan3.0-video";

export interface VideoModelRuntimeProfile {
  id: string;
  label: string;
  estimatedCnyPerClip: number;
  taskTypes: Array<"text-to-video" | "image-to-video">;
  resolutions: string[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  supportsAudio: boolean;
  protocol?: "v1" | "v2";
  estimatedCnyPerSecond?: number;
  estimatedCnyPerSecondByResolution?: Record<string, number>;
  recommended?: boolean;
}

interface CommonProviderSettings {
  apiKey: string;
  model: string;
  models: VideoModelRuntimeProfile[];
  estimatedCnyPerClip: number;
  baseUrl?: string;
}

export interface SeedanceProviderSettings extends CommonProviderSettings {
  providerId: "seedance-video-v1";
}

export interface MiniMaxProviderSettings extends CommonProviderSettings {
  providerId: "hailuo-video-v1";
}

export interface WanProviderSettings extends CommonProviderSettings {
  providerId: "wan-video-v1";
  workspaceId: string;
}

export function readMeteredVideoProviderSettings(
  environment: NodeJS.ProcessEnv,
): MeteredVideoProviderSettings[] {
  const settings: MeteredVideoProviderSettings[] = [];
  const seedanceEstimate = positiveNumber(environment.SEEDANCE_ESTIMATED_CNY_PER_CLIP);
  if (environment.ARK_API_KEY && seedanceEstimate !== undefined) {
    const model = environment.SEEDANCE_MODEL_ID?.trim() || DEFAULT_SEEDANCE_MODEL_ID;
    const modelEstimates = readModelEstimates(environment.SEEDANCE_MODEL_ESTIMATES_JSON);
    const models = reviewedSeedanceProfiles(
      model,
      seedanceEstimate,
      modelEstimates,
      readSeedanceModelProfiles(environment.SEEDANCE_MODEL_PROFILES_JSON),
    );
    const configuredProfile = models.find((profile) => profile.id === model);
    if (!configuredProfile) {
      throw new Error(`SEEDANCE_MODEL_ID '${model}' has no reviewed runtime profile. Add it to SEEDANCE_MODEL_PROFILES_JSON before enabling paid generation.`);
    }
    settings.push({
      providerId: "seedance-video-v1",
      apiKey: environment.ARK_API_KEY,
      model,
      models,
      estimatedCnyPerClip: configuredProfile.estimatedCnyPerClip,
      ...(environment.SEEDANCE_BASE_URL ? { baseUrl: environment.SEEDANCE_BASE_URL } : {}),
    });
  }

  const miniMaxEstimate = positiveNumber(environment.MINIMAX_ESTIMATED_CNY_PER_CLIP);
  if (environment.MINIMAX_API_KEY && environment.MINIMAX_VIDEO_MODEL_ID && miniMaxEstimate !== undefined) {
    const model = environment.MINIMAX_VIDEO_MODEL_ID;
    const models = reviewedMiniMaxProfiles(model, miniMaxEstimate);
    const configuredProfile = models.find((profile) => profile.id === model);
    if (!configuredProfile) {
      throw new Error(`MINIMAX_VIDEO_MODEL_ID '${model}' has no reviewed runtime profile.`);
    }
    settings.push({
      providerId: "hailuo-video-v1",
      apiKey: environment.MINIMAX_API_KEY,
      model,
      models,
      estimatedCnyPerClip: configuredProfile.estimatedCnyPerClip,
      ...(environment.MINIMAX_BASE_URL ? { baseUrl: environment.MINIMAX_BASE_URL } : {}),
    });
  }

  const wanEstimate = positiveNumber(environment.WAN_ESTIMATED_CNY_PER_CLIP);
  if (
    environment.DASHSCOPE_API_KEY
    && environment.DASHSCOPE_WORKSPACE_ID
    && environment.WAN_MODEL_ID
    && wanEstimate !== undefined
  ) {
    const model = environment.WAN_MODEL_ID;
    const models = reviewedWanProfiles(
      model,
      wanEstimate,
      readModelEstimates(environment.WAN_MODEL_ESTIMATES_JSON, "WAN_MODEL_ESTIMATES_JSON"),
    );
    const configuredProfile = models.find((profile) => profile.id === model);
    if (!configuredProfile) {
      throw new Error(`WAN_MODEL_ID '${model}' has no reviewed runtime profile.`);
    }
    settings.push({
      providerId: "wan-video-v1",
      apiKey: environment.DASHSCOPE_API_KEY,
      model,
      models,
      workspaceId: environment.DASHSCOPE_WORKSPACE_ID,
      estimatedCnyPerClip: configuredProfile.estimatedCnyPerClip,
      ...(environment.WAN_BASE_URL ? { baseUrl: environment.WAN_BASE_URL } : {}),
    });
  }
  return settings;
}

export function reviewedVideoModelCatalog(environment: NodeJS.ProcessEnv): Record<MeteredVideoProviderSettings["providerId"], VideoModelRuntimeProfile[]> {
  const seedanceModel = environment.SEEDANCE_MODEL_ID?.trim() || DEFAULT_SEEDANCE_MODEL_ID;
  const miniMaxModel = environment.MINIMAX_VIDEO_MODEL_ID?.trim() || DEFAULT_MINIMAX_VIDEO_MODEL_ID;
  const wanModel = environment.WAN_MODEL_ID?.trim() || DEFAULT_WAN_VIDEO_MODEL_ID;
  return {
    "seedance-video-v1": reviewedSeedanceProfiles(
      seedanceModel,
      positiveNumber(environment.SEEDANCE_ESTIMATED_CNY_PER_CLIP) ?? 5,
      readModelEstimates(environment.SEEDANCE_MODEL_ESTIMATES_JSON),
      readSeedanceModelProfiles(environment.SEEDANCE_MODEL_PROFILES_JSON),
    ),
    "hailuo-video-v1": reviewedMiniMaxProfiles(
      miniMaxModel,
      positiveNumber(environment.MINIMAX_ESTIMATED_CNY_PER_CLIP) ?? 2.1,
    ),
    "wan-video-v1": reviewedWanProfiles(
      wanModel,
      positiveNumber(environment.WAN_ESTIMATED_CNY_PER_CLIP) ?? 5,
      readModelEstimates(environment.WAN_MODEL_ESTIMATES_JSON, "WAN_MODEL_ESTIMATES_JSON"),
    ),
  };
}

function reviewedMiniMaxProfiles(configuredModel: string, hailuoEstimate: number): VideoModelRuntimeProfile[] {
  const profiles: VideoModelRuntimeProfile[] = [
    {
      ...genericProfile("MiniMax-Hailuo-2.3", "MiniMax Hailuo 2.3", hailuoEstimate, 6, 6, ["768P", "1080P"]),
      protocol: "v1",
    },
    {
      id: "MiniMax-H3",
      label: "MiniMax H3",
      estimatedCnyPerClip: 2,
      estimatedCnyPerSecond: 0.5,
      estimatedCnyPerSecondByResolution: { "768P": 0.5, "2K": 0.8 },
      taskTypes: ["text-to-video"],
      resolutions: ["768P", "2K"],
      minDurationSeconds: 4,
      maxDurationSeconds: 15,
      supportsAudio: true,
      protocol: "v2",
    },
    {
      id: "MiniMax-H3-Max",
      label: "MiniMax H3 Max",
      estimatedCnyPerClip: 1.65,
      estimatedCnyPerSecond: 0.33,
      estimatedCnyPerSecondByResolution: { "480P": 0.33, "768P": 0.5 },
      taskTypes: ["text-to-video"],
      resolutions: ["480P", "768P"],
      minDurationSeconds: 5,
      maxDurationSeconds: 15,
      supportsAudio: true,
      protocol: "v2",
    },
  ];
  return profiles.map((profile) => profile.id === configuredModel ? { ...profile, recommended: true } : profile);
}

function reviewedWanProfiles(
  configuredModel: string,
  estimatedCnyPerClip: number,
  modelEstimates: Record<string, number>,
): VideoModelRuntimeProfile[] {
  const estimate = (modelId: string) => modelEstimates[modelId] ?? estimatedCnyPerClip;
  const profiles: VideoModelRuntimeProfile[] = [
    {
      id: "wan3.0-video",
      label: "Wan 3.0",
      estimatedCnyPerClip: estimate("wan3.0-video"),
      taskTypes: ["text-to-video"],
      resolutions: ["480P", "720P", "1080P"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      supportsAudio: true,
    },
    {
      id: "wan3.0-video-prime",
      label: "Wan 3.0 Prime",
      estimatedCnyPerClip: estimate("wan3.0-video-prime"),
      taskTypes: ["text-to-video"],
      resolutions: ["480P", "720P", "1080P"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      supportsAudio: true,
    },
    {
      id: "wan2.7-t2v",
      label: "Wan 2.7 文生视频",
      estimatedCnyPerClip: estimate("wan2.7-t2v"),
      taskTypes: ["text-to-video"],
      resolutions: ["720P", "1080P"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      supportsAudio: true,
    },
  ];
  return profiles.map((profile) => profile.id === configuredModel ? { ...profile, recommended: true } : profile);
}

function reviewedSeedanceProfiles(
  configuredModel: string,
  estimatedCnyPerClip: number,
  modelEstimates: Record<string, number>,
  customProfiles: VideoModelRuntimeProfile[],
): VideoModelRuntimeProfile[] {
  const estimate = (modelId: string) => modelEstimates[modelId] ?? estimatedCnyPerClip;
  const builtIns: VideoModelRuntimeProfile[] = [
    {
      id: DEFAULT_SEEDANCE_MODEL_ID,
      label: "Seedance 2.5",
      estimatedCnyPerClip: estimate(DEFAULT_SEEDANCE_MODEL_ID),
      taskTypes: ["text-to-video"],
      resolutions: ["480p", "720p", "1080p"],
      minDurationSeconds: 4,
      maxDurationSeconds: 15,
      supportsAudio: true,
    },
    genericProfile("doubao-seedance-2-0-260128", "Seedance 2.0", estimate("doubao-seedance-2-0-260128"), 4, 15, ["480p", "720p", "1080p"]),
    genericProfile("doubao-seedance-2-0-fast-260128", "Seedance 2.0 Fast", estimate("doubao-seedance-2-0-fast-260128"), 4, 15, ["480p", "720p", "1080p"]),
    genericProfile("doubao-seedance-2-0-mini-260615", "Seedance 2.0 Mini", estimate("doubao-seedance-2-0-mini-260615"), 4, 15, ["480p", "720p"]),
    genericProfile("doubao-seedance-1-5-pro-251215", "Seedance 1.5 Pro", estimate("doubao-seedance-1-5-pro-251215"), 4, 12, ["480p", "720p", "1080p"]),
  ];
  const profiles = new Map(builtIns.map((profile) => [profile.id, profile]));
  for (const profile of customProfiles) {
    profiles.set(profile.id, {
      ...profile,
      estimatedCnyPerClip: modelEstimates[profile.id] ?? profile.estimatedCnyPerClip,
    });
  }
  return [...profiles.values()].map(({ recommended: _recommended, ...profile }) => (
    profile.id === configuredModel ? { ...profile, recommended: true } : profile
  ));
}

function genericProfile(
  id: string,
  label: string,
  estimatedCnyPerClip: number,
  minDurationSeconds: number,
  maxDurationSeconds: number,
  resolutions: string[],
  recommended = false,
): VideoModelRuntimeProfile {
  return {
    id,
    label,
    estimatedCnyPerClip,
    taskTypes: ["text-to-video"],
    resolutions,
    minDurationSeconds,
    maxDurationSeconds,
    supportsAudio: false,
    ...(recommended ? { recommended: true } : {}),
  };
}

function readModelEstimates(
  value: string | undefined,
  variableName = "SEEDANCE_MODEL_ESTIMATES_JSON",
): Record<string, number> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${variableName} must be valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be a JSON object.`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([modelId, estimate]) => {
    if (!modelId.trim() || typeof estimate !== "number" || !Number.isFinite(estimate) || estimate <= 0) {
      throw new Error(`${variableName} has an invalid estimate for '${modelId}'.`);
    }
    return [modelId, estimate];
  }));
}

function readSeedanceModelProfiles(value: string | undefined): VideoModelRuntimeProfile[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SEEDANCE_MODEL_PROFILES_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new Error("SEEDANCE_MODEL_PROFILES_JSON must be an array with at most 20 profiles.");
  }
  const seen = new Set<string>();
  return parsed.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`SEEDANCE_MODEL_PROFILES_JSON profile ${index + 1} must be an object.`);
    }
    const profile = value as Record<string, unknown>;
    const id = requiredProfileText(profile.id, `profile ${index + 1} id`);
    if (seen.has(id)) throw new Error(`SEEDANCE_MODEL_PROFILES_JSON contains duplicate model '${id}'.`);
    seen.add(id);
    const taskTypes = stringArray(profile.taskTypes, `profile '${id}' taskTypes`);
    if (taskTypes.some((task) => task !== "text-to-video" && task !== "image-to-video")) {
      throw new Error(`SEEDANCE_MODEL_PROFILES_JSON profile '${id}' has an unsupported task type.`);
    }
    const resolutions = stringArray(profile.resolutions, `profile '${id}' resolutions`);
    const minDurationSeconds = positiveProfileNumber(profile.minDurationSeconds, `profile '${id}' minDurationSeconds`);
    const maxDurationSeconds = positiveProfileNumber(profile.maxDurationSeconds, `profile '${id}' maxDurationSeconds`);
    if (minDurationSeconds > maxDurationSeconds) {
      throw new Error(`SEEDANCE_MODEL_PROFILES_JSON profile '${id}' has an invalid duration range.`);
    }
    if (typeof profile.supportsAudio !== "boolean") {
      throw new Error(`SEEDANCE_MODEL_PROFILES_JSON profile '${id}' supportsAudio must be boolean.`);
    }
    return {
      id,
      label: requiredProfileText(profile.label, `profile '${id}' label`),
      estimatedCnyPerClip: positiveProfileNumber(profile.estimatedCnyPerClip, `profile '${id}' estimatedCnyPerClip`),
      taskTypes: taskTypes as VideoModelRuntimeProfile["taskTypes"],
      resolutions,
      minDurationSeconds,
      maxDurationSeconds,
      supportsAudio: profile.supportsAudio,
    };
  });
}

function requiredProfileText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new Error(`SEEDANCE_MODEL_PROFILES_JSON ${label} is invalid.`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`SEEDANCE_MODEL_PROFILES_JSON ${label} must be a non-empty array.`);
  }
  return value.map((item) => requiredProfileText(item, label));
}

function positiveProfileNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`SEEDANCE_MODEL_PROFILES_JSON ${label} must be a positive number.`);
  }
  return value;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
