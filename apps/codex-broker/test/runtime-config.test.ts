import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brokerRuntimeConfigFromEnv } from "../src/runtime-config.js";

describe("brokerRuntimeConfigFromEnv", () => {
  it("selects fixed OpenAI and ZAI profiles without retaining the ZAI key", () => {
    const openai = brokerRuntimeConfigFromEnv({});
    assert.deepEqual(openai.profile.identity, {
      profileId: "openai",
      providerId: "openai",
      modelId: "codex-default",
      taskKinds: ["topic-ideas", "director-plan", "script-draft", "publish-copy", "visual-review"],
    });

    const fakeSecret = "test-only-secret-not-for-a-real-request";
    const zai = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_PROFILE: "zai",
      ZAI_API_KEY: fakeSecret,
      VIDEO_FACTORY_CODEX_MODEL_CATALOG_PATH: "/tmp/models.json",
      VIDEO_FACTORY_CODEX_EFFORT: "max",
    });
    assert.equal(zai.profile.identity.profileId, "zai");
    assert.equal(zai.profile.identity.modelId, "glm-5.3-flash");
    assert.equal(zai.socketPath, "/run/video-factory-zai-codex/worker.sock");
    assert.equal(zai.workspaceRoot, "/var/lib/video-factory-zai-codex/workspace");
    assert.equal(zai.profile.modelCatalogPath, "/tmp/models.json");
    assert.equal(zai.effort, "max");
    assert.doesNotMatch(JSON.stringify(zai), new RegExp(fakeSecret));
  });

  it("rejects unknown profiles and a ZAI profile without its environment key", async () => {
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "arbitrary" }),
      /VIDEO_FACTORY_CODEX_PROFILE must be openai or zai/,
    );
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "zai" }),
      /ZAI_API_KEY environment variable is required/,
    );
  });
});
