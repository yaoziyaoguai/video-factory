import type { StudioTemplate, StudioVoiceDirection } from "./api.js";

export const VOICE_PRESETS = [
  { id: "explainer", label: "知识讲解", description: "清楚、有推进感，不像播报", preferredProfileIds: ["macos:Tingting", "minimax:Chinese (Mandarin)_Reliable_Executive"], rate: 190, pauseScale: 1, masteringPreset: "social" },
  { id: "documentary", label: "人物纪实", description: "留出情绪和画面呼吸", preferredProfileIds: ["macos:Meijia", "macos:Sinji"], rate: 170, pauseScale: 1.2, masteringPreset: "intimate" },
  { id: "news", label: "热点快讯", description: "信息密度高，咬字优先", preferredProfileIds: ["minimax:Chinese (Mandarin)_News_Anchor", "macos:Tingting"], rate: 205, pauseScale: 0.9, masteringPreset: "social" },
  { id: "lifestyle", label: "生活清单", description: "自然亲近，节奏不过满", preferredProfileIds: ["macos:Meijia", "macos:Sinji"], rate: 185, pauseScale: 1, masteringPreset: "natural" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  preferredProfileIds: readonly string[];
  rate: number;
  pauseScale: number;
  masteringPreset: StudioVoiceDirection["masteringPreset"];
}>;

export type VoicePreset = (typeof VOICE_PRESETS)[number];

export function voicePresetForTemplate(
  template: Pick<StudioTemplate, "id" | "soundSystem">,
): VoicePreset {
  const presetId = template.soundSystem.pace === "slow"
    ? "documentary"
    : template.soundSystem.pace === "fast" || template.id === "trend-fact-brief"
      ? "news"
      : /生活|亲近/.test(template.soundSystem.voiceIntent)
        ? "lifestyle"
        : "explainer";
  return VOICE_PRESETS.find((preset) => preset.id === presetId)!;
}

export function applyTemplateVoiceRecommendation(
  template: Pick<StudioTemplate, "id" | "soundSystem">,
  current: StudioVoiceDirection,
): StudioVoiceDirection {
  const preset = voicePresetForTemplate(template);
  return {
    profileId: current.profileId,
    rate: preset.rate,
    pauseScale: preset.pauseScale,
    masteringPreset: preset.masteringPreset,
  };
}
