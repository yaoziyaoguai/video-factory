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
    /**
     * T08：连续分组旁白能力（可选字段）。新生产者始终显式写 true/false；
     * 旧持久化输入缺失时消费为“未声明支持”，不推断已启用。
     * true 只能来自真实 worker 支持链路（当前仅 MiniMax 系统音色）；
     * 该字段只表示“可选择能力”，是否采用由用户确认的 NarrationPlan 决定。
     */
    continuousNarrationGroups?: boolean;
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
      // 只有已接线的连续组 worker 链路才声明该能力；其它 provider 保持 false，不由 narration 推断。
      continuousNarrationGroups: voiceProviderId === "minimax-tts-v1",
      musicTrack: false,
      soundEffectsTrack: false,
    },
  };
}
