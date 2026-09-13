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
}

export function summarizeProductionCapabilities(
  providers: ReadonlyArray<
    Omit<ProductionCapabilityAssetProvider, "supportsReferenceImage"> & {
      supportsReferenceImage?: boolean;
    }
  >,
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
  };
}
