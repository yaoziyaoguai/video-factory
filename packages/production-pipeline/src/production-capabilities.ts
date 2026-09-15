import type { VideoAspectRatio } from "./video-generation.js";

export interface ProductionCapabilityAssetProvider {
  id: string;
  deliveryTypes: string[];
  supportsReferenceImage: boolean;
  strengths: string[];
  constraints: string[];
  selectedModelId?: string;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  aspectRatios?: VideoAspectRatio[];
}

export interface ProductionCapabilities {
  assetProviders: ProductionCapabilityAssetProvider[];
  editing: {
    sourceRangeReuse: boolean;
    staticEditorialCard: boolean;
  };
  audio: {
    narration: boolean;
    pauseControl: "punctuation" | "text_hint" | "unsupported";
    musicTrack: boolean;
    soundEffectsTrack: boolean;
  };
}

export function summarizeProductionCapabilities(
  providers: ReadonlyArray<
    Omit<ProductionCapabilityAssetProvider, "supportsReferenceImage"> & {
      supportsReferenceImage?: boolean;
    }
  >,
  voiceProviderId?: string,
): ProductionCapabilities {
  return {
    assetProviders: providers.map((provider) => ({
      id: provider.id,
      deliveryTypes: [...provider.deliveryTypes],
      supportsReferenceImage: provider.supportsReferenceImage ?? false,
      strengths: [...provider.strengths],
      constraints: [...provider.constraints],
      ...(provider.selectedModelId ? { selectedModelId: provider.selectedModelId } : {}),
      ...(provider.minDurationSeconds !== undefined ? { minDurationSeconds: provider.minDurationSeconds } : {}),
      ...(provider.maxDurationSeconds !== undefined ? { maxDurationSeconds: provider.maxDurationSeconds } : {}),
      ...(provider.aspectRatios ? { aspectRatios: [...provider.aspectRatios] } : {}),
    })),
    editing: {
      sourceRangeReuse: true,
      staticEditorialCard: providers.some((provider) => provider.deliveryTypes.includes("editorial_card")),
    },
    audio: {
      narration: Boolean(voiceProviderId),
      pauseControl: voiceProviderId === "macos-say-v1"
        ? "punctuation"
        : voiceProviderId === "minimax-tts-v1" ? "text_hint" : "unsupported",
      musicTrack: false,
      soundEffectsTrack: false,
    },
  };
}
