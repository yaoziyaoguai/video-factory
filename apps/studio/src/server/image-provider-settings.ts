export interface SeedreamProviderSettings {
  providerId: "seedream-image-v1";
  apiKey: string;
  model: string;
  estimatedCnyPerImage: number;
  baseUrl?: string;
}

const DEFAULT_SEEDREAM_MODEL = "doubao-seedream-4-0-250828";
const DEFAULT_SEEDREAM_ESTIMATED_CNY_PER_IMAGE = 0.25;

export function readMeteredImageProviderSettings(
  environment: NodeJS.ProcessEnv,
): SeedreamProviderSettings[] {
  if (!environment.ARK_API_KEY) return [];
  const configuredEstimate = environment.SEEDREAM_ESTIMATED_CNY_PER_IMAGE;
  const estimate = configuredEstimate === undefined
    ? DEFAULT_SEEDREAM_ESTIMATED_CNY_PER_IMAGE
    : positiveNumber(configuredEstimate);
  if (estimate === undefined) return [];
  return [{
    providerId: "seedream-image-v1",
    apiKey: environment.ARK_API_KEY,
    model: environment.SEEDREAM_MODEL_ID?.trim() || DEFAULT_SEEDREAM_MODEL,
    estimatedCnyPerImage: estimate,
    ...(environment.SEEDREAM_BASE_URL ? { baseUrl: environment.SEEDREAM_BASE_URL } : {}),
  }];
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
