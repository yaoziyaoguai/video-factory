import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { outputSchemaValidationErrorFor } from "../src/task-definitions.js";

it("preserves each visual semantic rejection through the real executor, durable broker and client without re-execution", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  const finding = {
    timecodeMs: 1000, startTimecodeMs: 0, endTimecodeMs: 2000, scenePosition: 1,
    targetNodeId: "assets", planningStageId: null, claimType: "static", evidenceStatus: "failed", evidenceFrameSha256: null,
    nextAction: "rework_asset", category: "continuity", severity: "warning",
    description: "PRIVATE_GENERATED_DESCRIPTION", suggestion: "PRIVATE_GENERATED_SUGGESTION",
  };
  const report = {
    version: "video-factory/visual-review-v1", summary: "PRIVATE_GENERATED_SUMMARY",
    scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 90 },
    confidence: 0.9, recommendation: "revise", findings: [finding],
  };
  const cases = [
    { code: "visual_approval_score", field: "output.recommendation", output: { ...report, recommendation: "approve", scores: { ...report.scores, pacing: 70 } } },
    { code: "visual_approval_confidence", field: "output.recommendation", output: { ...report, recommendation: "approve", confidence: 0.6 } },
    { code: "visual_approval_unresolved_evidence", field: "output.recommendation", output: { ...report, recommendation: "approve" } },
    { code: "visual_finding_time_range", field: "output.findings[0].timecodeMs", output: { ...report, findings: [{ ...finding, startTimecodeMs: 1500 }] } },
    { code: "visual_failed_rework", field: "output.findings[0]", output: { ...report, findings: [{ ...finding, severity: "info" }] } },
    { code: "visual_unobserved_inspection", field: "output.findings[0]", output: { ...report, findings: [{ ...finding, claimType: "static", evidenceStatus: "not_observed", nextAction: "inspect_existing_media" }] } },
    { code: "visual_nonfailing_rework", field: "output.findings[0]", output: { ...report, findings: [{ ...finding, claimType: "static", evidenceStatus: "satisfied" }] } },
  ];
  for (const scenario of cases) {
    assert.equal(outputSchemaValidationErrorFor("visual-review", scenario.output), undefined);
    const directory = await mkdtemp(path.join(tmpdir(), "vf-visual-diagnostic-"));
    const socketPath = path.join(directory, "worker.sock");
    let calls = 0;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: "test-only-zai-key" },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(scenario.output) } }] }), { status: 200 });
      },
    });
    const broker = new CodexBrokerServer({ socketPath, executor, idempotencyDirectory: path.join(directory, "durable") });
    await broker.start();
    try {
      const client = new CodexBridgeClient({ socketPath, maxAttempts: 1, pollIntervalMs: 5 });
      const payload = { durationMs: 3000, frames: [{ timecodeMs: 1000, sha256: createHash("sha256").update(jpeg).digest("hex"), jpegBase64: jpeg.toString("base64") }] };
      for (let replay = 0; replay < 2; replay += 1) {
        await assert.rejects(client.runTask("visual-review", payload, `semantic-${scenario.code}`), (error: unknown) => {
          assert.ok(error instanceof CodexBridgeError);
          assert.equal(error.statusCode, 422);
          assert.equal(error.failureDetails?.reasonCode, scenario.code);
          assert.equal(error.failureDetails?.fieldPath, scenario.field);
          assert.equal(error.failureDetails?.taskKind, "visual-review");
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE_GENERATED_/);
          return true;
        });
      }
      assert.equal(calls, 1, "completed semantic rejection must replay without buying another model execution");
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

const brief: ScreenwriterAgentInput["brief"] = {
  title: "基础设施故障需要候选模型接管",
  angle: "验证完整 broker 错误链路",
  audience: "短视频创作者",
  nicheSlug: "fallback-integration",
  platform: "douyin",
  durationSeconds: 24,
  productionCapabilities: {
    assetProviders: [],
    editing: { sourceRangeReuse: true, staticEditorialCard: false },
    audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
  },
};

it("starts a backup after an accepted ZAI request definitively ends with an upstream outage", async () => {
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

    const result = await candidates.draftDetailed({ brief, selectedModelId: "glm-5.3" });

    assert.equal(zaiCalls, 1);
    assert.equal(backupCalls, 1);
    assert.equal(result.trace?.modelId, "gpt-5.6-sol");
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("starts a backup after an accepted ZAI request definitively completes without output", async () => {
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

    const result = await candidates.draftDetailed({ brief, selectedModelId: "glm-5.3" });

    assert.equal(zaiCalls, 1);
    assert.equal(backupCalls, 1);
    assert.equal(result.trace?.modelId, "gpt-5.6-sol");
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
