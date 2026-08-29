import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDirectorAssetProviders,
  buildProductionProviderRuntimeMetadata,
  resolveProductionPython,
} from "../src/server/production-worker.js";
import { readMeteredImageProviderSettings } from "../src/server/image-provider-settings.js";
import { readMeteredVideoProviderSettings } from "../src/server/video-provider-settings.js";
import { buildStudioChildEnvironment } from "../src/server/studio-child-environment.js";

describe("production Python runtime", () => {
  it("prefers an explicit runtime, then the verified project environment", () => {
    assert.equal(resolveProductionPython("/repo", { VIDEO_FACTORY_PYTHON: "/custom/python" }, () => true), "/custom/python");
    assert.equal(
      resolveProductionPython("/repo", {}, (target) => target === "/repo/.local/python/.venv/bin/python"),
      "/repo/.local/python/.venv/bin/python",
    );
    assert.equal(resolveProductionPython("/repo", {}, () => false), "python3");
  });

  it("never forwards BigModel broker credentials to Studio child processes", () => {
    assert.deepEqual(buildStudioChildEnvironment({
      SAFE_VALUE: "kept",
      ZAI_BIGMODEL_API_KEY: "new-secret",
      ZAI_API_KEY: "legacy-secret",
    }, {
      PYTHONPATH: "/repo/python",
      ZAI_BIGMODEL_API_KEY: "override-secret",
    }), {
      SAFE_VALUE: "kept",
      PYTHONPATH: "/repo/python",
    });
  });
});

describe("production provider runtime metadata", () => {
  it("marks GLM review and MiniMax voice as per-run metered calls", () => {
    const metadata = buildProductionProviderRuntimeMetadata({
      MINIMAX_API_KEY: "test-only-key",
      MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP: "0.5",
      ZAI_VISUAL_REVIEW_ESTIMATED_CNY: "0.1",
      ZAI_VISUAL_REVIEW_MODEL_ID: "glm-5.3-flash-preview",
    });

    const glm = metadata.find((item) => item.id === "glm-visual-review-v1");
    assert.equal(glm?.billingUnit, "run");
    assert.equal(glm?.modelId, "glm-5.3-flash-preview");
    assert.equal(metadata.find((item) => item.id === "minimax-tts-v1")?.billingUnit, "run");
  });
});

describe("metered video provider settings", () => {
  it("keeps paid adapters disabled until every required field and cost estimate exists", () => {
    assert.deepEqual(readMeteredVideoProviderSettings({}), []);
    assert.deepEqual(readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
    }), []);
    assert.deepEqual(readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
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
      SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
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

  it("uses Seedance 2.5 as a configurable Ark default instead of requiring a hard-coded model env", () => {
    const [setting] = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "4",
    });

    assert.equal(setting?.providerId, "seedance-video-v1");
    assert.equal(setting?.model, "doubao-seedance-2-5-260628");
    assert.equal(setting?.models.some((model) => model.id === "doubao-seedance-2-5-260628" && model.recommended), true);
    assert.deepEqual(setting?.models.find((model) => model.id === "doubao-seedance-2-5-260628")?.taskTypes, ["text-to-video"]);
  });

  it("supports model-specific Seedance estimates and recommends the configured default", () => {
    const [setting] = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "doubao-seedance-1-5-pro-251215",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "4",
      SEEDANCE_MODEL_ESTIMATES_JSON: JSON.stringify({
        "doubao-seedance-2-5-260628": 5.5,
        "doubao-seedance-1-5-pro-251215": 2.25,
      }),
    });

    assert.equal(setting?.estimatedCnyPerClip, 2.25);
    assert.equal(setting?.models.find((model) => model.id === "doubao-seedance-2-5-260628")?.estimatedCnyPerClip, 5.5);
    assert.equal(Boolean(setting?.models.find((model) => model.id === "doubao-seedance-2-5-260628")?.recommended), false);
    assert.equal(setting?.models.find((model) => model.id === "doubao-seedance-1-5-pro-251215")?.recommended, true);
    assert.throws(() => readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "4",
      SEEDANCE_MODEL_ESTIMATES_JSON: "not-json",
    }), /must be valid JSON/);
  });

  it("starts safely with the account-verified Seedance 2.0 Mini profile", () => {
    const [setting] = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "doubao-seedance-2-0-mini-260615",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "2",
    });

    const profile = setting?.models.find((model) => model.id === "doubao-seedance-2-0-mini-260615");
    assert.equal(setting?.model, "doubao-seedance-2-0-mini-260615");
    assert.deepEqual(profile?.taskTypes, ["text-to-video"]);
    assert.deepEqual(profile?.resolutions, ["480p", "720p"]);
    assert.equal(profile?.supportsAudio, false);
    assert.equal(profile?.recommended, true);
  });

  it("requires a reviewed runtime profile before an unknown Seedance model can spend money", () => {
    assert.throws(() => readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "future-seedance-model",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "4",
    }), /no reviewed runtime profile/);

    const [setting] = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "future-seedance-model",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "4",
      SEEDANCE_MODEL_PROFILES_JSON: JSON.stringify([{
        id: "future-seedance-model",
        label: "Seedance Future",
        estimatedCnyPerClip: 2.8,
        taskTypes: ["text-to-video"],
        resolutions: ["720p"],
        minDurationSeconds: 4,
        maxDurationSeconds: 10,
        supportsAudio: false,
      }]),
    });

    assert.equal(setting?.model, "future-seedance-model");
    assert.equal(setting?.estimatedCnyPerClip, 2.8);
    assert.equal(setting?.models.find((model) => model.id === "future-seedance-model")?.recommended, true);
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
      deliveryTypes: ["generated_image"],
      strengths: ["解释性插画、抽象概念、无法检索到的关键静态画面与统一系列视觉"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: 0.25,
      generative: true,
    });
  });
});
