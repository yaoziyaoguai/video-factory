import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  CodexBridgeError,
  CodexBridgeClient,
  FallbackScreenwriterAgent,
  type CodexTaskExecution,
  type ScreenwriterAgent,
  type ScreenwriterAgentInput,
} from "../../../packages/production-pipeline/src/index.js";
import { CodexBrokerServer } from "../src/broker-server.js";
import { ZaiCodePlanExecutor } from "../src/zai-code-plan-executor.js";

const brief: ScreenwriterAgentInput["brief"] = {
  title: "基础设施故障需要候选模型接管",
  angle: "验证完整 broker 错误链路",
  audience: "短视频创作者",
  nicheSlug: "fallback-integration",
  platform: "douyin",
  durationSeconds: 24,
};

it("falls back after a ZAI upstream outage crosses the broker boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-zai-fallback-"));
  const socketPath = path.join(directory, "worker.sock");
  let zaiCalls = 0;
  const zai = new ZaiCodePlanExecutor({
    env: { ZAI_BIGMODEL_API_KEY: "test-only-zai-key" },
    fetchFn: async () => {
      zaiCalls += 1;
      return new Response(JSON.stringify({ error: { code: "service_unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const broker = new CodexBrokerServer({ socketPath, executor: zai });
  await broker.start();
  try {
    const client = new CodexBridgeClient({ socketPath, maxAttempts: 1 });
    const glm: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "glm-5.3",
      draft: async (input) => (await client.runTask("script-draft", { brief: input.brief }, "zai-fallback-chain")),
      draftDetailed: async (input) => client.runTaskDetailed("script-draft", { brief: input.brief }, "zai-fallback-chain"),
    };
    let backupCalls = 0;
    const openai: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "gpt-5.6-sol",
      draft: async () => ({ scenes: [] }),
      draftDetailed: async (): Promise<CodexTaskExecution<unknown>> => {
        backupCalls += 1;
        return {
          output: { scenes: [] },
          trace: {
            taskKind: "script-draft",
            promptVersion: "integration-test-v1",
            prompt: "bounded integration test prompt",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
          },
        };
      },
    };
    const candidates = new FallbackScreenwriterAgent({
      candidates: [
        { agent: glm, providerId: "zai-bigmodel-api" },
        { agent: openai, providerId: "openai" },
      ],
    });

    const execution = await candidates.draftDetailed({ brief, selectedModelId: "glm-5.3" });

    assert.equal(zaiCalls, 1);
    assert.equal(backupCalls, 1);
    assert.equal(execution.trace?.modelId, "gpt-5.6-sol");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["glm-5.3", "gpt-5.6-sol"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [
      {
        modelId: "glm-5.3",
        providerId: "zai-bigmodel-api",
        outcome: "failed",
        failureStage: "completed_failure",
        failureReason: "暂时不可用",
      },
      { modelId: "gpt-5.6-sol", providerId: "openai", outcome: "succeeded" },
    ]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("falls back after ZAI completes without output across the broker boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-zai-no-output-fallback-"));
  const socketPath = path.join(directory, "worker.sock");
  let zaiCalls = 0;
  const zai = new ZaiCodePlanExecutor({
    env: { ZAI_BIGMODEL_API_KEY: "test-only-zai-key" },
    fetchFn: async () => {
      zaiCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const broker = new CodexBrokerServer({ socketPath, executor: zai });
  await broker.start();
  try {
    const client = new CodexBridgeClient({ socketPath, maxAttempts: 1 });
    const glm: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "glm-5.3",
      draft: async (input) => client.runTask("script-draft", { brief: input.brief }, "zai-no-output-chain"),
      draftDetailed: async (input) => client.runTaskDetailed("script-draft", { brief: input.brief }, "zai-no-output-chain"),
    };
    let backupCalls = 0;
    const openai: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "gpt-5.6-sol",
      draft: async () => ({ scenes: [] }),
      draftDetailed: async (): Promise<CodexTaskExecution<unknown>> => {
        backupCalls += 1;
        return {
          output: { scenes: [] },
          trace: {
            taskKind: "script-draft",
            promptVersion: "integration-test-v1",
            prompt: "bounded integration test prompt",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
          },
        };
      },
    };
    const candidates = new FallbackScreenwriterAgent({
      candidates: [
        { agent: glm, providerId: "zai-bigmodel-api" },
        { agent: openai, providerId: "openai" },
      ],
    });

    const execution = await candidates.draftDetailed({ brief, selectedModelId: "glm-5.3" });

    assert.equal(zaiCalls, 1);
    assert.equal(backupCalls, 1);
    assert.equal(execution.trace?.modelId, "gpt-5.6-sol");
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [
      {
        modelId: "glm-5.3",
        providerId: "zai-bigmodel-api",
        outcome: "failed",
        failureStage: "completed_failure",
        failureReason: "未返回结果",
      },
      { modelId: "gpt-5.6-sol", providerId: "openai", outcome: "succeeded" },
    ]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not fall back after a generic ZAI HTTP 500 crosses the broker boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-zai-generic-500-"));
  const socketPath = path.join(directory, "worker.sock");
  const zai = new ZaiCodePlanExecutor({
    env: { ZAI_BIGMODEL_API_KEY: "test-only-zai-key" },
    fetchFn: async () => new Response(JSON.stringify({ error: { code: "1300" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  });
  const broker = new CodexBrokerServer({ socketPath, executor: zai });
  await broker.start();
  try {
    const client = new CodexBridgeClient({ socketPath, maxAttempts: 1 });
    const glm: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "glm-5.3",
      draft: async (input) => client.runTask("script-draft", { brief: input.brief }, "zai-generic-500-chain"),
      draftDetailed: async (input) => client.runTaskDetailed("script-draft", { brief: input.brief }, "zai-generic-500-chain"),
    };
    let backupCalls = 0;
    const openai: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      modelId: "gpt-5.6-sol",
      draft: async () => ({ scenes: [] }),
      draftDetailed: async () => {
        backupCalls += 1;
        return { output: { scenes: [] } };
      },
    };
    const candidates = new FallbackScreenwriterAgent({
      candidates: [
        { agent: glm, providerId: "zai-bigmodel-api" },
        { agent: openai, providerId: "openai" },
      ],
    });

    await assert.rejects(
      () => candidates.draftDetailed({ brief, selectedModelId: "glm-5.3" }),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.failureKind, undefined);
        assert.equal(error.failureDetails?.category, "execution_failed");
        assert.equal(error.failureDetails?.reasonCode, "1300");
        return true;
      },
    );
    assert.equal(backupCalls, 0);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
