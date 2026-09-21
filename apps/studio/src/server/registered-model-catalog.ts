import type { ModelConnection } from "@video-factory/production-pipeline";
import type { StudioProvider } from "../shared/api.js";

const TEXT_ROLES = new Set(["script.draft", "storyboard.plan", "creative.treatment", "role.audit", "topic.intelligence", "series.plan", "publish.copy"]);
const IMAGE_ROLES = new Set(["quality.review.visual", "reference.grammar", "asset.rank.semantic"]);

export function includeRegisteredModels(providers: StudioProvider[], connections: ModelConnection[], runtime: { python: boolean; ffmpeg: boolean; ffprobe: boolean }): StudioProvider[] {
  const catalog = providers.map((provider) => {
    const capability = TEXT_ROLES.has(provider.capability) ? "text" : IMAGE_ROLES.has(provider.capability) ? "image" : undefined;
    if (!capability || provider.kind === "local" || provider.kind === "test" || provider.id === "codex-visual-review-v1") return provider;
    const models = connections.filter((model) => model.enabled && model.capabilities.includes(capability));
    if (!models.length) return provider;
    const runtimeReady = ["quality.review.visual", "reference.grammar"].includes(provider.capability)
      ? runtime.python && runtime.ffmpeg && runtime.ffprobe
      : provider.capability === "storyboard.plan" ? runtime.python : true;
    return {
      ...provider,
      available: runtimeReady,
      requirement: runtimeReady ? "已配置模型接入，实际能力以执行结果为准。" : "需要 Python、ffmpeg 与 ffprobe 运行环境。",
      defaultModelId: provider.available ? provider.defaultModelId ?? models[0]!.id : models[0]!.id,
      modelProfiles: [...(provider.modelProfiles ?? []), ...models.map((model) => ({
        id: model.id, label: `${model.label} · ${model.modelId}`, providerId: provider.id, providerFamily: model.id,
        available: runtimeReady, recommended: !provider.available && model === models[0],
        description: "用户配置的模型接入；密钥已保存，实际能力与费用以供应商和执行回执为准。",
        taskTypes: [capability === "image" ? "visual-review" as const : "text" as const],
      }))],
    };
  });
  const audio = connections.filter((model) => model.enabled && model.capabilities.includes("audio") && model.capabilities.includes("image"));
  catalog.push({
    id: "sound-review-v1", label: "声音审片员", capability: "quality.review.audio", kind: "external",
    available: audio.length > 0 && runtime.python && runtime.ffmpeg && runtime.ffprobe, billing: "metered", latency: "seconds", modes: ["真实音轨", "声音表现", "音画配合"],
    description: "直接听取成片音轨并结合抽帧提出意见；缺少可用模型时明确未审听，不用转写冒充审听。",
    ...(audio[0] ? { defaultModelId: audio[0].id } : {}),
    modelProfiles: audio.map((model, index) => ({ id: model.id, label: `${model.label} · ${model.modelId}`, providerId: "sound-review-v1", providerFamily: model.id,
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe, recommended: index === 0, description: "音轨与图像联合审查。", taskTypes: ["audio-review" as const] })),
  });
  return catalog;
}
