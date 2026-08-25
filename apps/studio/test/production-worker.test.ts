import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveProductionPython } from "../src/server/production-worker.js";
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
  });

  it("normalizes complete Seedance and Wan configurations for the runtime worker", () => {
    const settings = readMeteredVideoProviderSettings({
      ARK_API_KEY: "seedance-key",
      SEEDANCE_MODEL_ID: "seedance-model",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      SEEDANCE_BASE_URL: "https://seedance.example/api/v3/",
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
        providerId: "wan-video-v1",
        estimatedCnyPerClip: 2.25,
        baseUrl: "https://wan.example/",
      },
    ]);
  });
});
