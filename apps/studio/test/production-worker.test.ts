import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDirectorAssetProviders, resolveProductionPython } from "../src/server/production-worker.js";
import { readMeteredImageProviderSettings } from "../src/server/image-provider-settings.js";
import { readMeteredVideoProviderSettings } from "../src/server/video-provider-settings.js";

describe("production Python runtime", () => {
  it("prefers an explicit runtime, then the verified project environment", () => {
    assert.equal(resolveProductionPython("/repo", { VIDEO_FACTORY_PYTHON: "/custom/python" }, () => true), "/custom/python");
    assert.equal(
      resolveProductionPython("/repo", {}, (target) => target === "/repo/.local/python/.venv/bin/python"),
      "/repo/.local/python/.venv/bin/python",
    );
    assert.equal(resolveProductionPython("/repo", {}, () => false), "python3");
  });
});

describe("metered video provider settings", () => {
  it("keeps paid adapters disabled until every required field and cost estimate exists", () => {
    assert.deepEqual(readMeteredVideoProviderSettings({}), []);
    assert.deepEqual(readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "seedance-model",
    }), []);
    assert.deepEqual(readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "seedance-model",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "0",
    }), []);
    assert.deepEqual(readMeteredVideoProviderSettings({
      MINIMAX_API_KEY: "minimax-key",
      MINIMAX_VIDEO_MODEL_ID: "MiniMax-Hailuo-2.3",
    }), []);
  });

  it("normalizes complete Seedance, MiniMax and Wan configurations for the runtime worker", () => {
    const settings = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "seedance-model",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      SEEDANCE_BASE_URL: "https://seedance.example/api/v3/",
      MINIMAX_API_KEY: "minimax-key",
      MINIMAX_VIDEO_MODEL_ID: "MiniMax-Hailuo-2.3",
      MINIMAX_ESTIMATED_CNY_PER_CLIP: "2.1",
      MINIMAX_BASE_URL: "https://minimax.example/v1/",
      DASHSCOPE_API_KEY: "wan-key",
      DASHSCOPE_WORKSPACE_ID: "workspace-1",
      WAN_MODEL_ID: "wan-model",
      WAN_ESTIMATED_CNY_PER_CLIP: "2.25",
      WAN_BASE_URL: "https://wan.example/",
    });

    assert.deepEqual(settings.map((setting) => ({
      providerId: setting.providerId,
      estimatedCnyPerClip: setting.estimatedCnyPerClip,
      baseUrl: setting.baseUrl,
    })), [
      {
        providerId: "seedance-video-v1",
        estimatedCnyPerClip: 3.5,
        baseUrl: "https://seedance.example/api/v3/",
      },
      {
        providerId: "hailuo-video-v1",
        estimatedCnyPerClip: 2.1,
        baseUrl: "https://minimax.example/v1/",
      },
      {
        providerId: "wan-video-v1",
        estimatedCnyPerClip: 2.25,
        baseUrl: "https://wan.example/",
      },
    ]);
  });
});

describe("metered image provider settings", () => {
  it("uses conservative Seedream defaults only after an Ark key is present", () => {
    assert.deepEqual(readMeteredImageProviderSettings({}), []);
    assert.deepEqual(readMeteredImageProviderSettings({
      ARK_API_KEY: "ark-key",
    }), [{
      providerId: "seedream-image-v1",
      apiKey: "ark-key",
      model: "doubao-seedream-4-0-250828",
      estimatedCnyPerImage: 0.25,
    }]);
    assert.deepEqual(readMeteredImageProviderSettings({
      ARK_API_KEY: "ark-key",
      SEEDREAM_MODEL_ID: "seedream-model",
      SEEDREAM_ESTIMATED_CNY_PER_IMAGE: "0.25",
      SEEDREAM_BASE_URL: "https://ark.example/api/v3/",
    }), [{
      providerId: "seedream-image-v1",
      apiKey: "ark-key",
      model: "seedream-model",
      estimatedCnyPerImage: 0.25,
      baseUrl: "https://ark.example/api/v3/",
    }]);
  });

  it("offers Seedream to the AI director as a metered image source", () => {
    const providers = buildDirectorAssetProviders({ environment: {
      ARK_API_KEY: "ark-key",
      SEEDREAM_MODEL_ID: "seedream-model",
      SEEDREAM_ESTIMATED_CNY_PER_IMAGE: "0.25",
    } });

    assert.deepEqual(providers.find((provider) => provider.id === "seedream-image-v1"), {
      id: "seedream-image-v1",
      label: "Seedream 关键画面",
      billing: "metered",
      modes: ["AI 图片", "9:16"],
      strengths: ["解释性插画、抽象概念、无法检索到的关键静态画面与统一系列视觉"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: 0.25,
      generative: true,
    });
  });
});
