import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateVisualDirectorPlan,
  type VisualDirectorPlan,
  type VisualDirectorPlanValidation,
} from "../src/index.js";

const economics = { allowMeteredProviders: true };

function plan(shots: VisualDirectorPlan["shots"]): VisualDirectorPlan {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "真实人物与可验证场景更适合这个题目。",
    visualBible: {
      narrativeApproach: "先看具体动作，再解释原因。",
      pacing: "前快后稳",
      composition: "人物近景和环境中景交替",
      camera: "手持但克制",
      color: "自然中性色",
      continuity: "保持同一城市和时间段",
      sound: "环境声先于音乐",
    },
    shots,
  };
}

function shot(scenePosition: number, preferredProviderId: string): VisualDirectorPlan["shots"][number] {
  return {
    scenePosition,
    narrativeRole: scenePosition === 1 ? "冲突钩子" : "证据推进",
    authenticityPolicy: scenePosition === 1 ? "illustrative" : "evidence",
    preferredProviderId,
    deliveryType: preferredProviderId === "seedance-video-v1"
      ? "generated_video"
      : preferredProviderId === "pexels-stock-v1" ? "stock_video" : "editorial_card",
    alternativeProviderIds: [],
    query: `第 ${scenePosition} 镜头检索词`,
    generationPrompt: `第 ${scenePosition} 镜头生成提示`,
    rationale: "与本镜头的叙事职责最匹配。",
    continuityNote: "延续同一色温与人物方向。",
    confidence: 0.82,
    estimatedCostCny: 999,
  };
}

describe("validateVisualDirectorPlan", () => {
  it("accepts a different AI-selected provider for every shot and replaces model cost with server estimates", () => {
    const result = validateVisualDirectorPlan(
      plan([shot(1, "seedance-video-v1"), shot(2, "pexels-stock-v1"), shot(3, "local-editorial-v1")]),
      {
        scenePositions: [1, 2, 3],
        allowedProviderIds: ["local-editorial-v1", "pexels-stock-v1", "seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: {
          "local-editorial-v1": ["editorial_card"],
          "pexels-stock-v1": ["stock_video", "stock_image"],
          "seedance-video-v1": ["generated_video"],
        },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        economics,
      },
    );

    assert.deepEqual(result.shots.map((item) => item.preferredProviderId), [
      "seedance-video-v1",
      "pexels-stock-v1",
      "local-editorial-v1",
    ]);
    assert.deepEqual(result.shots.map((item) => item.estimatedCostCny), [5.5, 0, 0]);
  });

  it("rejects missing, duplicate, unknown and evidence-generation routes", () => {
    const options: VisualDirectorPlanValidation = {
      scenePositions: [1, 2],
      allowedProviderIds: ["local-editorial-v1", "seedance-video-v1"],
      generativeProviderIds: ["seedance-video-v1"],
      providerDeliveryTypes: {
        "local-editorial-v1": ["editorial_card"],
        "seedance-video-v1": ["generated_video"],
      },
      estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
      economics,
    };

    assert.throws(() => validateVisualDirectorPlan(plan([shot(1, "local-editorial-v1")]), options), /cover every script scene/);
    assert.throws(() => validateVisualDirectorPlan(plan([shot(1, "local-editorial-v1"), shot(1, "local-editorial-v1")]), options), /duplicate scene/);
    assert.throws(() => validateVisualDirectorPlan(plan([shot(1, "unknown-v1"), shot(2, "local-editorial-v1")]), options), /not in the enabled asset pool/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      shot(1, "local-editorial-v1"),
      { ...shot(2, "seedance-video-v1"), authenticityPolicy: "evidence" },
    ]), options), /evidence shot.*generative provider/);
  });

  it("does not apply a video-wide limit in the director execution gate", () => {
    const expensivePlan = plan([
      shot(1, "seedance-video-v1"),
      { ...shot(2, "seedance-video-v1"), authenticityPolicy: "illustrative" },
    ]);
    const result = validateVisualDirectorPlan(expensivePlan, {
      scenePositions: [1, 2],
      allowedProviderIds: ["local-editorial-v1", "seedance-video-v1"],
      generativeProviderIds: ["seedance-video-v1"],
      providerDeliveryTypes: {
        "local-editorial-v1": ["editorial_card"],
        "seedance-video-v1": ["generated_video"],
      },
      estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
      economics,
    });
    assert.equal(result.shots.length, 2);
    assert.equal(result.shots.reduce((sum, item) => sum + item.estimatedCostCny, 0), 11);
  });

  it("allows any number of metered shots when metered providers are explicitly enabled", () => {
    const result = validateVisualDirectorPlan(plan([
      shot(1, "seedance-video-v1"),
      { ...shot(2, "seedance-video-v1"), authenticityPolicy: "illustrative" },
    ]), {
      scenePositions: [1, 2],
      allowedProviderIds: ["seedance-video-v1"],
      generativeProviderIds: ["seedance-video-v1"],
      providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
      estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
      economics,
    });

    assert.equal(result.shots.length, 2);
    assert.equal(result.shots.reduce((sum, item) => sum + item.estimatedCostCny, 0), 11);
  });

  it("rejects a provider that cannot deliver the declared asset type", () => {
    const invalid = shot(1, "local-editorial-v1");
    invalid.deliveryType = "generated_video";
    assert.throws(() => validateVisualDirectorPlan(plan([invalid]), {
      scenePositions: [1],
      allowedProviderIds: ["local-editorial-v1"],
      generativeProviderIds: [],
      providerDeliveryTypes: { "local-editorial-v1": ["editorial_card"] },
      estimatedCnyPerClip: {},
      economics,
    }), /cannot deliver 'generated_video'/);
  });

  it("rejects temporal beats that exceed or overlap the script scene", () => {
    const options: VisualDirectorPlanValidation = {
      scenePositions: [1],
      sceneDurations: { 1: 5 },
      allowedProviderIds: ["local-editorial-v1"],
      generativeProviderIds: [],
      providerDeliveryTypes: { "local-editorial-v1": ["editorial_card"] },
      estimatedCnyPerClip: {},
      economics,
    };
    const overflow = { ...shot(1, "local-editorial-v1"), temporalBeats: ["[0s-2s] 保持全画面", "[2s-6s] 整体轻推近"] };
    const overlap = { ...shot(1, "local-editorial-v1"), temporalBeats: ["[0s-3s] 保持全画面", "[2s-5s] 整体轻推近"] };
    const malformed = { ...shot(1, "local-editorial-v1"), temporalBeats: ["开始时保持全画面", "[2s-5s] 整体轻推近"] };

    assert.throws(() => validateVisualDirectorPlan(plan([overflow]), options), /exceeds the 5s scene duration/);
    assert.throws(() => validateVisualDirectorPlan(plan([overlap]), options), /overlaps or is out of order/);
    assert.throws(() => validateVisualDirectorPlan(plan([malformed]), options), /must use the format/);
  });
});
