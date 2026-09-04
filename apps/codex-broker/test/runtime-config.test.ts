import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexExecutor } from "../src/codex-executor.js";
import { createBrokerExecutor } from "../src/executor-factory.js";
import { brokerRuntimeConfigFromEnv } from "../src/runtime-config.js";
import { ZaiCodePlanExecutor } from "../src/zai-code-plan-executor.js";

describe("brokerRuntimeConfigFromEnv", () => {
  it("selects fixed OpenAI and ZAI profiles without retaining the ZAI key", () => {
    const openai = brokerRuntimeConfigFromEnv({});
    assert.deepEqual(openai.profile.identity, {
      profileId: "openai",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      taskKinds: ["topic-ideas", "series-roadmap", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"],
    });
    assert.equal(openai.profile.model, "gpt-5.6-sol");
    assert.equal(openai.auditModel, "gpt-5.6-sol");
    assert.equal(openai.effort, "xhigh");
    assert.equal(openai.auditEffort, "xhigh");

    const fakeSecret = "test-only-secret-not-for-a-real-request";
    const zai = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_PROFILE: "zai",
      ZAI_BIGMODEL_API_KEY: fakeSecret,
      VIDEO_FACTORY_CODEX_EFFORT: "max",
    });
    assert.equal(zai.profile.identity.profileId, "zai");
    assert.equal(zai.profile.identity.modelId, "glm-5.3");
    assert.equal(zai.socketPath, "/run/video-factory-zai-codex/worker.sock");
    assert.equal(zai.workspaceRoot, "/var/lib/video-factory-zai-codex/workspace");
    assert.equal(zai.effort, "max");
    assert.doesNotMatch(JSON.stringify(zai), new RegExp(fakeSecret));

    const customZai = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_PROFILE: "zai",
      ZAI_BIGMODEL_API_KEY: fakeSecret,
      ZAI_TEXT_MODEL_ID: "glm-5.3-preview",
    });
    assert.equal(customZai.profile.identity.modelId, "glm-5.3-preview");
  });

  it("allows the host to configure production and deep-review models independently", () => {
    const config = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_MODEL: "gpt-5.6-luna",
      VIDEO_FACTORY_CODEX_AUDIT_MODEL: "gpt-5.6-sol",
    });

    assert.equal(config.profile.model, "gpt-5.6-luna");
    assert.equal(config.auditModel, "gpt-5.6-sol");
  });

  it("rejects unknown profiles and a ZAI profile without its environment key", async () => {
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "arbitrary" }),
      /VIDEO_FACTORY_CODEX_PROFILE must be openai or zai/,
    );
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "zai" }),
      /ZAI_BIGMODEL_API_KEY environment variable is required/,
    );
  });

  it("routes only the ZAI profile to the official Chat Completion executor", () => {
    const fetchFn: typeof fetch = async () => new Response();
    const zaiEnvironment = {
      VIDEO_FACTORY_CODEX_PROFILE: "zai",
      ZAI_BIGMODEL_API_KEY: "test-only-secret",
    };
    const zai = createBrokerExecutor(
      brokerRuntimeConfigFromEnv(zaiEnvironment),
      zaiEnvironment,
      { fetchFn },
    );
    assert.ok(zai instanceof ZaiCodePlanExecutor);
    assert.deepEqual(zai.identity.taskKinds, ["director-plan", "script-draft", "visual-review"]);

    const openai = createBrokerExecutor(brokerRuntimeConfigFromEnv({}), {});
    assert.ok(openai instanceof CodexExecutor);
    assert.ok(openai.identity.taskKinds.includes("script-draft"));
  });
});
