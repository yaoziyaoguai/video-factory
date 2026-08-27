import type { ProductionTemplateInput } from "../src/index.js";

export function validTemplate(): ProductionTemplateInput {
  return {
    id: "knowledge-explainer",
    version: 1,
    status: "published",
    name: "知识解释",
    description: "把一个问题讲清楚。",
    category: "knowledge",
    platforms: ["douyin", "xiaohongshu"],
    durationSeconds: 36,
    automationLevel: "assisted",
    storyStructure: [
      { id: "hook", label: "先抓住注意力", purpose: "给出反常识问题", required: true },
      { id: "answer", label: "解释答案", purpose: "分层说明", required: true },
    ],
    shotSlots: [
      {
        id: "shot-hook",
        beatId: "hook",
        purpose: "呈现问题",
        durationSeconds: 4,
        allowedCapabilities: ["asset.search", "asset.generate.image"],
        manualReplacement: true,
      },
    ],
    visualSystem: {
      composition: "主体清晰，信息层次少而准",
      colorIntent: "自然中性色配一个强调色",
      subtitleDensity: "medium",
      pacing: "measured",
    },
    soundSystem: {
      voiceIntent: "可信、克制",
      pace: "medium",
      musicIntent: "弱存在感",
    },
    qualityRules: [
      { id: "facts", label: "事实边界", dimension: "factual", required: true, threshold: 80 },
    ],
    capabilityRequirements: [
      { capability: "script.draft", required: true },
      { capability: "video.render", required: true },
    ],
    costPolicy: { currency: "CNY", maxCost: 5, maxPaidShots: 1 },
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
  };
}
