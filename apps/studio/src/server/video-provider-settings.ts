export type MeteredVideoProviderSettings = SeedanceProviderSettings | WanProviderSettings;

interface CommonProviderSettings {
  apiKey: string;
  model: string;
  estimatedCnyPerClip: number;
  baseUrl?: string;
}

export interface SeedanceProviderSettings extends CommonProviderSettings {
  providerId: "seedance-video-v1";
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
  if (environment.ARK_API_KEY && environment.SEEDANCE_MODEL_ID && seedanceEstimate !== undefined) {
    settings.push({
      providerId: "seedance-video-v1",
      apiKey: environment.ARK_API_KEY,
      model: environment.SEEDANCE_MODEL_ID,
      estimatedCnyPerClip: seedanceEstimate,
      ...(environment.SEEDANCE_BASE_URL ? { baseUrl: environment.SEEDANCE_BASE_URL } : {}),
    });
  }

  const wanEstimate = positiveNumber(environment.WAN_ESTIMATED_CNY_PER_CLIP);
  if (
    environment.DASHSCOPE_API_KEY
    && environment.DASHSCOPE_WORKSPACE_ID
    && environment.WAN_MODEL_ID
    && wanEstimate !== undefined
  ) {
    settings.push({
      providerId: "wan-video-v1",
      apiKey: environment.DASHSCOPE_API_KEY,
      model: environment.WAN_MODEL_ID,
      workspaceId: environment.DASHSCOPE_WORKSPACE_ID,
      estimatedCnyPerClip: wanEstimate,
      ...(environment.WAN_BASE_URL ? { baseUrl: environment.WAN_BASE_URL } : {}),
    });
  }
  return settings;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
