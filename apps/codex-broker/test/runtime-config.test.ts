import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexExecutor } from "../src/codex-executor.js";
import { createBrokerExecutor } from "../src/executor-factory.js";
import { brokerRuntimeConfigFromEnv } from "../src/runtime-config.js";
import { ChatCompletionsExecutor } from "../src/chat-completions-executor.js";
import { BROKER_TASK_KINDS } from "../src/task-definitions.js";

describe("brokerRuntimeConfigFromEnv", () => {
  it("selects fixed OpenAI and DeepSeek profiles without retaining the DeepSeek key", () => {
    const openai = brokerRuntimeConfigFromEnv({});
    assert.deepEqual(openai.profile.identity, {
      profileId: "openai",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      taskKinds: BROKER_TASK_KINDS,
    });
    assert.equal(openai.profile.model, "gpt-5.6-sol");
    assert.equal(openai.auditModel, "gpt-5.6-sol");
    assert.equal(openai.effort, "xhigh");
    assert.equal(openai.auditEffort, "xhigh");
    // 强推理候选需要 1200s（20 分钟）默认 deadline，防止回落到曾经掐断 xhigh/max 的 300s/600s。
    assert.equal(openai.timeoutMs, 1_200_000);
    assert.equal(openai.maxBacklog, 1);

    const fakeSecret = "test-only-secret-not-for-a-real-request";
    const deepseek = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_PROFILE: "deepseek",
      DEEPSEEK_API_KEY: fakeSecret,
      VIDEO_FACTORY_CODEX_EFFORT: "max",
    });
    assert.equal(deepseek.profile.identity.profileId, "deepseek");
    assert.equal(deepseek.profile.identity.modelId, "deepseek-flash");
    assert.equal(deepseek.socketPath, "/run/video-factory-deepseek/worker.sock");
    assert.equal(deepseek.workspaceRoot, "/var/lib/video-factory-deepseek/workspace");
    assert.equal(deepseek.effort, "max");
    // 用户指定的审计强度就是 xhigh，没有别的供应商那种"档位闸门"要迁就。
    assert.equal(deepseek.auditEffort, "xhigh");
    assert.equal(deepseek.timeoutMs, 1_200_000);
    assert.doesNotMatch(JSON.stringify(deepseek), new RegExp(fakeSecret));

    const customDeepseek = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_PROFILE: "deepseek",
      DEEPSEEK_API_KEY: fakeSecret,
      DEEPSEEK_MODEL_ID: "deepseek-v4-pro",
    });
    assert.equal(customDeepseek.profile.identity.modelId, "deepseek-v4-pro");
    assert.equal(customDeepseek.effort, "xhigh");
  });

  it("allows the host to configure production and deep-review models independently", () => {
    const config = brokerRuntimeConfigFromEnv({
      VIDEO_FACTORY_CODEX_MODEL: "gpt-5.6-luna",
      VIDEO_FACTORY_CODEX_AUDIT_MODEL: "gpt-5.6-sol",
    });

    assert.equal(config.profile.model, "gpt-5.6-luna");
    assert.equal(config.auditModel, "gpt-5.6-sol");
  });

  it("reads the reviewed model candidate table and defaults to forbidding overrides", () => {
    // 安全默认：没配候选表就等于没有可覆盖的模型，而不是"随便什么模型都能用"。
    assert.deepEqual(brokerRuntimeConfigFromEnv({}).modelCandidates, []);
    assert.deepEqual(
      brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_MODEL_CANDIDATES: "gpt-5.6-sol, gpt-6-astra" }).modelCandidates,
      ["gpt-5.6-sol", "gpt-6-astra"],
    );
  });

  it("rejects a candidate table containing a model id that could be read as a CLI flag", () => {
    assert.throws(
      () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_MODEL_CANDIDATES: "gpt-5.6-sol,--config" }),
      /contains an invalid model id: '--config'/,
    );
  });

  it("rejects unknown profiles and a chat-completions profile without its environment key", async () => {
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "arbitrary" }),
      /VIDEO_FACTORY_CODEX_PROFILE must be openai or deepseek/,
    );
    await assert.rejects(
      async () => brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_PROFILE: "deepseek" }),
      /DEEPSEEK_API_KEY environment variable is required/,
    );
  });

  it("rejects an effort tier the whole engine rejects, on every profile", () => {
    const deepseekEnvironment = {
      VIDEO_FACTORY_CODEX_PROFILE: "deepseek",
      DEEPSEEK_API_KEY: "test-only-secret",
    };
    // 在启动时拦下，而不是等一次已经开始的请求被上游判为非法档位。
    assert.throws(
      () => brokerRuntimeConfigFromEnv({ ...deepseekEnvironment, VIDEO_FACTORY_CODEX_AUDIT_EFFORT: "extreme" }),
      /VIDEO_FACTORY_CODEX_AUDIT_EFFORT must be one of low\|medium\|high\|xhigh\|max/,
    );
    for (const effort of ["low", "high", "max", "xhigh"]) {
      assert.equal(
        brokerRuntimeConfigFromEnv({ ...deepseekEnvironment, VIDEO_FACTORY_CODEX_AUDIT_EFFORT: effort }).auditEffort,
        effort,
      );
    }
    // openai 那侧不受影响：xhigh 仍是它的默认复核强度。
    assert.equal(brokerRuntimeConfigFromEnv({ VIDEO_FACTORY_CODEX_AUDIT_EFFORT: "xhigh" }).auditEffort, "xhigh");
  });

  it("routes the chat-completions profile to the shared Chat Completion executor", () => {
    const fetchFn: typeof fetch = async () => new Response();
    const deepseekEnvironment = {
      VIDEO_FACTORY_CODEX_PROFILE: "deepseek",
      DEEPSEEK_API_KEY: "test-only-secret",
    };
    const deepseekConfig = brokerRuntimeConfigFromEnv(deepseekEnvironment);
    const deepseek = createBrokerExecutor(deepseekConfig, deepseekEnvironment, { fetchFn });
    assert.ok(deepseek instanceof ChatCompletionsExecutor);
    assert.equal(deepseekConfig.profile.identity.providerId, "deepseek");
    assert.equal(deepseekConfig.profile.identity.modelId, "deepseek-flash");
    assert.equal(deepseekConfig.socketPath, "/run/video-factory-deepseek/worker.sock");
    // 用户指定的思考强度：默认就是 xhigh。
    assert.equal(deepseekConfig.effort, "xhigh");
    assert.equal(deepseekConfig.auditEffort, "xhigh");
    assert.deepEqual(deepseek.identity.taskKinds, BROKER_TASK_KINDS);

    const openai = createBrokerExecutor(brokerRuntimeConfigFromEnv({}), {});
    assert.ok(openai instanceof CodexExecutor);
    assert.ok(openai.identity.taskKinds.includes("script-draft"));
  });
});
