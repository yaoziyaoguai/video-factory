/** 本轮只接通精确型号；模型宣称有声与实际返回音轨、听感验证是不同事实。 */
export const NATIVE_VIDEO_MODELS: Readonly<Record<string, string>> = Object.freeze({
  "wan-video-v1": "wan3.0-video",
  "hailuo-video-v1": "MiniMax-H3",
  "seedance-video-v1": "doubao-seedance-2-5-260628",
});
export const NATIVE_AUDIO_PROVIDER = "python-native-audio-v1";
export type ProductionAudioMode = "tts" | "native_av";

export function assertNativeVideoModel(providerId: string, modelId: string | undefined): void {
  if (!Object.hasOwn(NATIVE_VIDEO_MODELS, providerId) || NATIVE_VIDEO_MODELS[providerId] !== modelId) {
    throw new Error("native_av requires an explicitly selected supported native video model.");
  }
}
