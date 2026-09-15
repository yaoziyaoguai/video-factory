import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateVisualDirectorPlan,
  type ShotTemporalBeat,
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

function beats(...items: Array<[number, number, string]>): ShotTemporalBeat[] {
  return items.map(([startSeconds, endSeconds, action]) => ({ startSeconds, endSeconds, action }));
}

function legacyPlan(shots: unknown[]): unknown {
  return { ...plan([]), shots };
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
  it("copies the accepted viewer promise when the director omits it and rejects an attempted rewrite", () => {
    const options: VisualDirectorPlanValidation = {
      scenePositions: [1],
      viewerPromise: "观众看完能完成一个明确动作。",
      allowedProviderIds: ["pexels-stock-v1"],
      generativeProviderIds: [],
      providerDeliveryTypes: { "pexels-stock-v1": ["stock_video"] },
      estimatedCnyPerClip: {},
      economics,
    };
    const accepted = validateVisualDirectorPlan(plan([shot(1, "pexels-stock-v1")]), options);

    assert.equal(accepted.visualBible.viewerPromise, options.viewerPromise);
    assert.throws(() => validateVisualDirectorPlan({
      ...plan([shot(1, "pexels-stock-v1")]),
      visualBible: {
        ...plan([]).visualBible,
        viewerPromise: "导演自行改写的另一份承诺。",
      },
    }, options), /cannot change the accepted viewer promise/);
  });

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

  it("prices a REUSE_ONLY shot at zero while retaining server prices for generated shots", () => {
    const result = validateVisualDirectorPlan(
      plan([
        shot(1, "seedance-video-v1"),
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 locked master crop",
          estimatedCostCny: 999,
        },
      ]),
      {
        scenePositions: [1, 2],
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        economics,
      },
    );

    assert.deepEqual(result.shots.map((item) => item.estimatedCostCny), [5.5, 0]);
  });

  it("keeps reference-image generation distinct from zero-cost reuse", () => {
    const generatedImage = (scenePosition: number) => ({
      ...shot(scenePosition, "seedream-image-v1"),
      authenticityPolicy: "illustrative" as const,
      deliveryType: "generated_image" as const,
    });
    const result = validateVisualDirectorPlan(plan([
      generatedImage(1),
      { ...generatedImage(2), referenceFromScenePosition: 1 },
    ]), {
      scenePositions: [1, 2],
      allowedProviderIds: ["seedream-image-v1"],
      generativeProviderIds: ["seedream-image-v1"],
      providerDeliveryTypes: { "seedream-image-v1": ["generated_image"] },
      referenceImageProviderIds: ["seedream-image-v1"],
      estimatedCnyPerClip: { "seedream-image-v1": 0.25 },
      economics,
    });

    assert.equal(result.shots[1]?.referenceFromScenePosition, 1);
    assert.equal(result.shots[1]?.reuseFromScenePosition, undefined);
    assert.deepEqual(result.shots.map((item) => item.estimatedCostCny), [0.25, 0.25]);
  });

  it("rejects invalid reference-image routes", () => {
    const generatedImage = (scenePosition: number) => ({
      ...shot(scenePosition, "seedream-image-v1"),
      authenticityPolicy: "illustrative" as const,
      deliveryType: "generated_image" as const,
    });
    const options: VisualDirectorPlanValidation = {
      scenePositions: [1, 2],
      allowedProviderIds: ["seedream-image-v1"],
      generativeProviderIds: ["seedream-image-v1"],
      providerDeliveryTypes: { "seedream-image-v1": ["generated_image"] },
      referenceImageProviderIds: ["seedream-image-v1"],
      estimatedCnyPerClip: { "seedream-image-v1": 0.25 },
      economics,
    };

    assert.throws(() => validateVisualDirectorPlan(plan([
      { ...generatedImage(1), referenceFromScenePosition: 2 },
      generatedImage(2),
    ]), options), /must reference an earlier scene/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      generatedImage(1),
      { ...generatedImage(2), referenceFromScenePosition: 1, reuseFromScenePosition: 1 },
    ]), options), /cannot reference and reuse/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      generatedImage(1),
      { ...generatedImage(2), referenceFromScenePosition: 1 },
    ]), { ...options, referenceImageProviderIds: [] }), /does not support reference-image generation/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      generatedImage(1),
      {
        ...generatedImage(2),
        deliveryType: "stock_image",
        referenceFromScenePosition: 1,
      },
    ]), {
      ...options,
      providerDeliveryTypes: { "seedream-image-v1": ["generated_image", "stock_image"] },
    }), /only use a reference image with generated_image/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      { ...shot(1, "seedance-video-v1"), authenticityPolicy: "illustrative" },
      { ...generatedImage(2), referenceFromScenePosition: 1 },
    ]), {
      ...options,
      allowedProviderIds: ["seedance-video-v1", "seedream-image-v1"],
      generativeProviderIds: ["seedance-video-v1", "seedream-image-v1"],
      providerDeliveryTypes: {
        "seedance-video-v1": ["generated_video"],
        "seedream-image-v1": ["generated_image"],
      },
    }), /must reference an earlier generated_image scene/);
    assert.throws(() => validateVisualDirectorPlan(plan([
      generatedImage(1),
      { ...generatedImage(2), reuseFromScenePosition: 1 },
      { ...generatedImage(3), referenceFromScenePosition: 2 },
    ]), {
      ...options,
      scenePositions: [1, 2, 3],
    }), /must reference an earlier generated_image scene that is not itself reused/);
  });

  it("allows a generated-video root request to grow for a covered later source range", () => {
    const result = validateVisualDirectorPlan(
      plan([
        { ...shot(1, "seedance-video-v1"), temporalBeats: beats([0, 2, "建立母片"], [2, 4, "完成母片"]) },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 final segment",
          sourceInSeconds: 4,
          temporalBeats: beats([0, 3, "复用前段"], [3, 6, "复用后段"]),
        },
      ]),
      {
        scenePositions: [1, 2],
        sceneDurations: { 1: 4, 2: 6 },
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        economics,
      },
    );

    assert.equal(result.shots[1]?.sourceInSeconds, 4);
    assert.equal(result.shots[1]?.reuseFromScenePosition, 1);
  });

  it("resolves indirect reuse to the generated root and applies the selected model duration limit", () => {
    const result = validateVisualDirectorPlan(
      plan([
        {
          ...shot(1, "seedance-video-v1"),
          temporalBeats: beats([0, 2, "建立母片"], [2, 4, "完成母片"]),
        },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 locked master crop",
          sourceInSeconds: 4,
          temporalBeats: beats([0, 2, "复用根母片前段"], [2, 4, "保持同一画面"]),
        },
        {
          ...shot(3, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 2 locked master crop",
          sourceInSeconds: 8,
          temporalBeats: beats([0, 2, "继续复用"], [2, 4, "保持同一画面"]),
        },
      ]),
      {
        scenePositions: [1, 2, 3],
        sceneDurations: { 1: 4, 2: 4, 3: 4 },
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        selectedVideoModelDurationBounds: {
          "seedance-video-v1": { minDurationSeconds: 4, maxDurationSeconds: 12 },
        },
        economics,
      },
    );

    assert.equal(result.shots[1]?.reuseFromScenePosition, 1);
    assert.equal(result.shots[2]?.reuseFromScenePosition, 1);
  });

  it("rejects direct and indirect reuse whose source end exceeds the selected model limit", () => {
    assert.throws(() => validateVisualDirectorPlan(
      plan([
        {
          ...shot(1, "seedance-video-v1"),
          temporalBeats: beats([0, 2, "建立母片"], [2, 4, "完成母片"]),
        },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 locked master crop",
          sourceInSeconds: 4,
          temporalBeats: beats([0, 2, "复用根母片前段"], [2, 4, "保持同一画面"]),
        },
        {
          ...shot(3, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 2 locked master crop",
          sourceInSeconds: 8,
          temporalBeats: beats([0, 2, "复用根母片中段"], [2, 4, "保持同一画面"]),
        },
      ]),
      {
        scenePositions: [1, 2, 3],
        sceneDurations: { 1: 4, 2: 4, 3: 4 },
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        selectedVideoModelDurationBounds: {
          "seedance-video-v1": { minDurationSeconds: 4, maxDurationSeconds: 10 },
        },
        economics,
      },
    ), /scene 3 reuses generated video from root scene 1.*requires source through 12s.*only produces 10s/);
  });

  it("rounds the required generated-video source range up to a covering integer request", () => {
    const result = validateVisualDirectorPlan(
      plan([
        {
          ...shot(1, "seedance-video-v1"),
          temporalBeats: beats([0, 2, "建立母片"], [2, 4.4, "完成母片"]),
        },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 locked master crop",
          temporalBeats: beats([0, 2, "复用根母片前段"], [2, 4.2, "保持同一画面"]),
        },
      ]),
      {
        scenePositions: [1, 2],
        sceneDurations: { 1: 4.4, 2: 4.2 },
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        selectedVideoModelDurationBounds: {
          "seedance-video-v1": { minDurationSeconds: 4, maxDurationSeconds: 15 },
        },
        economics,
      },
    );

    assert.equal(result.shots[1]?.reuseFromScenePosition, 1);
  });

  it("allows reuse of the extra footage produced by a model minimum duration", () => {
    const result = validateVisualDirectorPlan(
      plan([
        {
          ...shot(1, "seedance-video-v1"),
          temporalBeats: beats([0, 2, "建立母片"], [2, 4, "完成母片"]),
        },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1 locked master crop",
          temporalBeats: beats([0, 2, "复用根母片前段"], [2, 5, "保持同一画面"]),
        },
      ]),
      {
        scenePositions: [1, 2],
        sceneDurations: { 1: 4, 2: 5 },
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        selectedVideoModelDurationBounds: {
          "seedance-video-v1": { minDurationSeconds: 6, maxDurationSeconds: 6 },
        },
        economics,
      },
    );

    assert.equal(result.shots[1]?.reuseFromScenePosition, 1);
  });

  it("rejects a cyclic REUSE_ONLY chain explicitly", () => {
    assert.throws(() => validateVisualDirectorPlan(
      plan([
        {
          ...shot(1, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 2",
        },
        {
          ...shot(2, "seedance-video-v1"),
          authenticityPolicy: "illustrative",
          query: "REUSE_ONLY scene 1",
        },
      ]),
      {
        scenePositions: [1, 2],
        allowedProviderIds: ["seedance-video-v1"],
        generativeProviderIds: ["seedance-video-v1"],
        providerDeliveryTypes: { "seedance-video-v1": ["generated_video"] },
        estimatedCnyPerClip: { "seedance-video-v1": 5.5 },
        economics,
      },
    ), /reuse cycle involving scene/);
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

    assert.throws(() => validateVisualDirectorPlan(legacyPlan([overflow]), options), /exceeds the 5s scene duration/);
    assert.throws(() => validateVisualDirectorPlan(legacyPlan([overlap]), options), /overlaps or is out of order/);
    assert.throws(() => validateVisualDirectorPlan(legacyPlan([malformed]), options), /must use a structured beat or legacy/);
  });

  it("accepts one full-duration temporal beat for a static delivery", () => {
    const staticDeliveries = [
      ["stock_image", "pexels-stock-v1", false],
      ["generated_image", "seedream-image-v1", true],
      ["editorial_card", "local-editorial-v1", false],
    ] as const;
    for (const [deliveryType, providerId, generative] of staticDeliveries) {
      const still = {
        ...shot(1, providerId),
        deliveryType,
        temporalBeats: beats([0, 5, "静态画面持续展示同一组可核对信息。"]),
      };
      const result = validateVisualDirectorPlan(plan([still]), {
        scenePositions: [1],
        sceneDurations: { 1: 5 },
        allowedProviderIds: [providerId],
        generativeProviderIds: generative ? [providerId] : [],
        providerDeliveryTypes: { [providerId]: [deliveryType] },
        estimatedCnyPerClip: generative ? { [providerId]: 1 } : {},
        economics: generative ? { ...economics, allowMeteredProviders: true } : economics,
      });
      assert.deepEqual(result.shots[0]?.temporalBeats, [{
        startSeconds: 0,
        endSeconds: 5,
        action: "静态画面持续展示同一组可核对信息。",
      }]);
    }
  });

  it("accepts one full-duration timed state for motion deliveries", () => {
    for (const [deliveryType, providerId, generative] of [
      ["stock_video", "pexels-stock-v1", false],
      ["generated_video", "seedance-video-v1", true],
    ] as const) {
      const moving = {
        ...shot(1, providerId),
        deliveryType,
        temporalBeats: beats([0, 5, "一个没有动作变化的笼统描述。"]),
      };
      assert.doesNotThrow(() => validateVisualDirectorPlan(plan([moving]), {
        scenePositions: [1],
        sceneDurations: { 1: 5 },
        allowedProviderIds: [providerId],
        generativeProviderIds: generative ? [providerId] : [],
        providerDeliveryTypes: { [providerId]: [deliveryType] },
        estimatedCnyPerClip: generative ? { [providerId]: 1 } : {},
        economics: generative ? { ...economics, allowMeteredProviders: true } : economics,
      }));
    }
  });

  it("accepts structured contiguous beats and emits an explicit source start", () => {
    const result = validateVisualDirectorPlan(plan([{
      ...shot(1, "pexels-stock-v1"),
      temporalBeats: [
        { startSeconds: 0, endSeconds: 2, action: "建立环境" },
        { startSeconds: 2, endSeconds: 5, action: "完整展示动作" },
      ],
    }]), {
      scenePositions: [1],
      sceneDurations: { 1: 5 },
      allowedProviderIds: ["pexels-stock-v1"],
      generativeProviderIds: [],
      providerDeliveryTypes: { "pexels-stock-v1": ["stock_video"] },
      estimatedCnyPerClip: {},
      economics,
    });

    assert.deepEqual(result.shots[0]?.temporalBeats, [
      { startSeconds: 0, endSeconds: 2, action: "建立环境" },
      { startSeconds: 2, endSeconds: 5, action: "完整展示动作" },
    ]);
    assert.equal(result.shots[0]?.sourceInSeconds, 0);
  });

  it("rejects discontinuous structured beats and invalid source starts", () => {
    const options: VisualDirectorPlanValidation = {
      scenePositions: [1],
      sceneDurations: { 1: 5 },
      allowedProviderIds: ["pexels-stock-v1"],
      generativeProviderIds: [],
      providerDeliveryTypes: { "pexels-stock-v1": ["stock_video"] },
      estimatedCnyPerClip: {},
      economics,
    };
    assert.throws(() => validateVisualDirectorPlan(plan([{
      ...shot(1, "pexels-stock-v1"),
      temporalBeats: [
        { startSeconds: 0, endSeconds: 2, action: "建立环境" },
        { startSeconds: 2.5, endSeconds: 5, action: "动作结果" },
      ],
    }]), options), /must be continuous/);
    assert.throws(() => validateVisualDirectorPlan(plan([{
      ...shot(1, "pexels-stock-v1"),
      sourceInSeconds: -1,
      temporalBeats: [
        { startSeconds: 0, endSeconds: 2, action: "建立环境" },
        { startSeconds: 2, endSeconds: 5, action: "动作结果" },
      ],
    }]), options), /sourceInSeconds/);
    assert.throws(() => validateVisualDirectorPlan(plan([{
      ...shot(1, "local-editorial-v1"),
      sourceInSeconds: 1,
      temporalBeats: [{ startSeconds: 0, endSeconds: 5, action: "静态信息持续展示" }],
    }]), {
      ...options,
      allowedProviderIds: ["local-editorial-v1"],
      providerDeliveryTypes: { "local-editorial-v1": ["editorial_card"] },
    }), /sourceInSeconds.*static/);
  });
});
