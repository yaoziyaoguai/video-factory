import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeError,
  FallbackScreenwriterAgent,
  FallbackVisualDirectorAgent,
  ModelCandidatesExhaustedError,
  RoleAgentLoopError,
  isModelProviderFailure,
  runRoleAgentLoop,
  type CodexTaskExecution,
  type ScreenwriterAgent,
  type ScreenwriterAgentInput,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
} from "../src/index.js";

const input: ScreenwriterAgentInput = {
  brief: {
    title: "候选模型回归测试",
    angle: "验证有序候选池",
    audience: "短视频创作者",
    nicheSlug: "qa",
    platform: "douyin",
    durationSeconds: 24,
  },
};

function agent(
  modelId: string,
  execute: (input: ScreenwriterAgentInput) => Promise<CodexTaskExecution<unknown>>,
): ScreenwriterAgent {
  return {
    id: "codex-screenwriter-v1",
    modelId,
    draft: async (candidateInput) => (await execute(candidateInput)).output,
    draftDetailed: execute,
  };
}

function successful(modelId: string): CodexTaskExecution<unknown> {
  return {
    output: { scenes: [] },
    trace: {
      taskKind: "script-draft",
      promptVersion: "fallback-test-v1",
      prompt: "bounded test prompt",
      providerId: modelId.startsWith("glm") ? "zai-bigmodel-api" : "openai",
      modelId,
    },
  };
}

function providerFailure(modelId: string): CodexBridgeError {
  return new CodexBridgeError(
    `Codex bridge returned HTTP 503 for ${modelId}.`,
    true,
    "not_accepted",
    503,
  );
}

function brokerProviderId(modelId: string): string {
  return modelId.startsWith("glm") ? "zai-bigmodel-api" : "openai";
}

describe("FallbackScreenwriterAgent", () => {
  it("puts the user-selected model first and does not call lower-ranked candidates after success", async () => {
    const calls: string[] = [];
    const fallback = new FallbackScreenwriterAgent({
      candidates: ["gpt-quality", "glm-5.3", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: agent(modelId, async () => {
          calls.push(modelId);
          return successful(modelId);
        }),
      })),
    });

    const execution = await fallback.draftDetailed({ ...input, selectedModelId: "glm-5.3" });

    assert.deepEqual(calls, ["glm-5.3"]);
    assert.equal(execution.trace?.modelId, "glm-5.3");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["glm-5.3"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [{
      modelId: "glm-5.3",
      providerId: "zai-bigmodel-api",
      outcome: "succeeded",
    }]);
  });

  it("tries every compatible candidate in order and records the final model", async () => {
    const calls: string[] = [];
    const checkpoints: unknown[] = [];
    const candidates = ["gpt-quality", "glm-5.3", "gpt-fast"].map((modelId, index) => ({
      agent: agent(modelId, async (candidateInput) => {
        calls.push(modelId);
        checkpoints.push(candidateInput.agentLoopCheckpoint);
        if (index < 2) throw providerFailure(modelId);
        return successful(modelId);
      }),
      providerId: brokerProviderId(modelId),
    }));
    const fallback = new FallbackScreenwriterAgent({ candidates });
    const checkpointsByModel = new Map<string, unknown>();
    const checkpointFactory = (modelId: string) => {
      const checkpoint = { key: `checkpoint-${modelId}`, load: async () => undefined, save: async () => undefined };
      checkpointsByModel.set(modelId, checkpoint);
      return checkpoint;
    };

    const execution = await fallback.draftDetailed({ ...input, agentLoopCheckpointForModel: checkpointFactory });

    assert.deepEqual(calls, ["gpt-quality", "glm-5.3", "gpt-fast"]);
    assert.deepEqual(checkpoints, [
      checkpointsByModel.get("gpt-quality"),
      checkpointsByModel.get("glm-5.3"),
      checkpointsByModel.get("gpt-fast"),
    ]);
    assert.equal(execution.trace?.modelId, "gpt-fast");
    assert.equal(execution.trace?.fallbackFromModelId, "gpt-quality");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-quality", "glm-5.3", "gpt-fast"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts?.map((attempt) => [
      attempt.modelId,
      attempt.providerId,
      attempt.outcome,
      attempt.failureStage,
      attempt.failureReason,
    ]), [
      ["gpt-quality", "openai", "failed", "not_accepted", "服务端错误（HTTP 503）"],
      ["glm-5.3", "zai-bigmodel-api", "failed", "not_accepted", "服务端错误（HTTP 503）"],
      ["gpt-fast", "openai", "succeeded", undefined, undefined],
    ]);
  });

  it("shares one wall-clock deadline across every text model candidate", async () => {
    let now = 1_000;
    const deadlines: Array<number | undefined> = [];
    const fallback = new FallbackScreenwriterAgent({
      totalTimeoutMs: 600,
      now: () => now,
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async (candidateInput) => {
            deadlines.push(candidateInput.wallClockDeadlineAtMs);
            now = 1_400;
            throw providerFailure("gpt-primary");
          }),
        },
        {
          providerId: "zai-bigmodel-api",
          agent: agent("glm-backup", async (candidateInput) => {
            deadlines.push(candidateInput.wallClockDeadlineAtMs);
            return successful("glm-backup");
          }),
        },
      ],
    });

    await fallback.draftDetailed(input);

    assert.deepEqual(deadlines, [1_600, 1_600]);
  });

  it("switches from OpenAI to GLM after an accepted transient provider outage", async () => {
    const calls: string[] = [];
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-5.6-sol", async () => {
            calls.push("gpt-5.6-sol");
            throw new CodexBridgeError(
              "Codex bridge returned HTTP 422. {\"error\":\"Codex task failed transiently: the model service is temporarily unavailable.\"}",
              false,
              "completed_failure",
              422,
            );
          }),
        },
        {
          providerId: "zai-bigmodel-api",
          agent: agent("glm-5.3", async () => {
            calls.push("glm-5.3");
            return successful("glm-5.3");
          }),
        },
      ],
    });

    const execution = await fallback.draftDetailed(input);

    assert.deepEqual(calls, ["gpt-5.6-sol", "glm-5.3"]);
    assert.equal(execution.trace?.modelId, "glm-5.3");
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [
      {
        modelId: "gpt-5.6-sol",
        providerId: "openai",
        outcome: "failed",
        failureStage: "completed_failure",
        failureReason: "暂时不可用",
      },
      {
        modelId: "glm-5.3",
        providerId: "zai-bigmodel-api",
        outcome: "succeeded",
      },
    ]);
  });

  it("stops immediately on output or business validation failure", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        { providerId: "openai", agent: agent("gpt-quality", async () => { throw new Error("Script draft scenes must be an array."); }) },
        { providerId: "zai-bigmodel-api", agent: agent("glm-5.3", async () => {
          backupCalls += 1;
          return successful("glm-5.3");
        }) },
      ],
    });

    await assert.rejects(() => fallback.draftDetailed(input), /scenes must be an array/);
    assert.equal(backupCalls, 0);
  });

  it("preserves every attempt when a transient primary reaches a terminal backup", async () => {
    const terminalBackupError = new Error("Script draft scenes must be an array.");
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-quality", async () => { throw providerFailure("gpt-quality"); }),
        },
        {
          providerId: "zai-bigmodel-api",
          agent: agent("glm-5.3", async () => { throw terminalBackupError; }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.equal(error.cause, terminalBackupError);
        assert.deepEqual(error.failures.map((failure) => failure.modelId), ["gpt-quality", "glm-5.3"]);
        assert.deepEqual(error.attempts, [
          {
            modelId: "gpt-quality",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "glm-5.3",
            providerId: "zai-bigmodel-api",
            outcome: "failed",
            failureStage: "transport",
            failureReason: "调用失败",
          },
        ]);
        return true;
      },
    );
  });

  it("rejects an unavailable selected model even when only one candidate exists", async () => {
    const fallback = new FallbackScreenwriterAgent({
      candidates: [{ providerId: "openai", agent: agent("gpt-quality", async () => successful("gpt-quality")) }],
    });

    await assert.rejects(
      () => fallback.draftDetailed({ ...input, selectedModelId: "offline-model" }),
      /is not available for this role/,
    );
  });

  it("reports every attempted model when all compatible candidates are exhausted", async () => {
    const fallback = new FallbackScreenwriterAgent({
      candidates: ["gpt-quality", "glm-5.3", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: agent(modelId, async () => { throw providerFailure(modelId); }),
      })),
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.deepEqual(error.failures.map((failure) => failure.modelId), ["gpt-quality", "glm-5.3", "gpt-fast"]);
        assert.deepEqual(error.attempts, [
          {
            modelId: "gpt-quality",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "glm-5.3",
            providerId: "zai-bigmodel-api",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "gpt-fast",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
        ]);
        return true;
      },
    );
  });

  it("reuses each backup model's own checkpoint after interruption without repeating its model call", async () => {
    const checkpointState = new Map<string, unknown>();
    let backupModelCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        { providerId: "openai", agent: agent("gpt-primary", async () => { throw providerFailure("gpt-primary"); }) },
        { providerId: "zai-bigmodel-api", agent: agent("glm-backup", async (candidateInput) => {
          const checkpoint = candidateInput.agentLoopCheckpoint;
          assert.ok(checkpoint);
          if (await checkpoint.load()) return successful("glm-backup");
          backupModelCalls += 1;
          await checkpoint.save({ acceptedCandidate: true });
          throw new CodexBridgeError("request timed out after acceptance", false, "uncertain");
        }) },
      ],
    });
    const checkpointFactory = (modelId: string) => ({
      key: `checkpoint-${modelId}`,
      load: async () => checkpointState.get(modelId),
      save: async (value: unknown) => { checkpointState.set(modelId, value); },
    });

    await assert.rejects(
      () => fallback.draftDetailed({ ...input, agentLoopCheckpointForModel: checkpointFactory }),
      ModelCandidatesExhaustedError,
    );
    const execution = await fallback.draftDetailed({ ...input, agentLoopCheckpointForModel: checkpointFactory });

    assert.equal(backupModelCalls, 1);
    assert.equal(execution.trace?.modelId, "glm-backup");
  });

  for (const [label, auditFailure] of [
    ["HTTP 503", new CodexBridgeError(
      "Codex bridge returned HTTP 503 while auditing.",
      true,
      "not_accepted",
      503,
    )],
    ["timeout", new CodexBridgeError(
      "role audit request timed out after 300000ms",
      false,
      "uncertain",
    )],
  ] as const) {
    it(`keeps the produced candidate and switches only the audit after ${label}`, async () => {
      let primaryProducerCalls = 0;
      let primaryAuditCalls = 0;
      let backupProducerCalls = 0;
      let backupAuditCalls = 0;
      const checkpointState = new Map<string, unknown>();
      const checkpointFactory = (modelId: string) => ({
        key: `checkpoint-${modelId}`,
        load: async () => checkpointState.get(modelId),
        save: async (value: unknown) => { checkpointState.set(modelId, structuredClone(value)); },
      });
      const fallback = new FallbackScreenwriterAgent({
        candidates: [
          {
            providerId: "openai",
            agent: agent("gpt-primary", async (candidateInput) => runRoleAgentLoop({
              role: "编剧",
              contractVersion: "screenwriter-test-v1",
              criteria: ["结构完整"],
              maxIterations: 1,
              produce: async () => {
                primaryProducerCalls += 1;
                return successful("gpt-primary");
              },
              audit: async () => {
                primaryAuditCalls += 1;
                throw auditFailure;
              },
              validate: (value) => value as { scenes: unknown[] },
              ...(candidateInput.agentLoopCheckpoint ? { checkpoint: candidateInput.agentLoopCheckpoint } : {}),
            })),
          },
          {
            providerId: "zai-bigmodel-api",
            agent: agent("glm-5.3", async (candidateInput) => runRoleAgentLoop({
              role: "编剧",
              contractVersion: "screenwriter-test-v1",
              criteria: ["结构完整"],
              maxIterations: 1,
              produce: async () => {
                backupProducerCalls += 1;
                throw new Error("backup producer must not run");
              },
              audit: async () => {
                backupAuditCalls += 1;
                return {
                  output: {
                    version: "video-factory/role-audit-v1",
                    verdict: "pass",
                    score: 96,
                    summary: "替补审计通过",
                    issues: [],
                    repairInstructions: [],
                  },
                  trace: {
                    taskKind: "role-audit",
                    promptVersion: "fallback-test-v1",
                    prompt: "bounded audit prompt",
                    providerId: "zai-bigmodel-api",
                    modelId: "glm-5.3",
                  },
                };
              },
              validate: (value) => value as { scenes: unknown[] },
              ...(candidateInput.agentLoopCheckpoint ? { checkpoint: candidateInput.agentLoopCheckpoint } : {}),
            })),
          },
        ],
      });

      const execution = await fallback.draftDetailed({ ...input, agentLoopCheckpointForModel: checkpointFactory });

      assert.deepEqual(execution.output, { scenes: [] });
      assert.equal(primaryProducerCalls, 1);
      assert.equal(primaryAuditCalls, 1);
      assert.equal(backupProducerCalls, 0);
      assert.equal(backupAuditCalls, 1);
      assert.equal(execution.agentLoop?.iterations[0]?.candidateTrace?.modelId, "gpt-primary");
      assert.equal(execution.agentLoop?.iterations[0]?.auditTrace?.modelId, "glm-5.3");
      assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-primary", "glm-5.3"]);
      assert.equal((checkpointState.get("glm-5.3") as { status?: string }).status, "passed");
    });
  }

  it("does not switch audit providers for a malformed audit result", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async () => {
            throw new RoleAgentLoopError("Independent audit returned malformed output.", {
              version: "video-factory/agent-loop-v1",
              role: "编剧",
              contractVersion: "screenwriter-test-v1",
              criteria: ["结构完整"],
              status: "failed",
              maxIterations: 1,
              iterations: [],
              pendingCandidate: {
                iteration: 1,
                candidate: { scenes: [] },
                candidateHash: "a".repeat(64),
              },
            }, undefined, new Error("response schema validation failed"));
          }),
        },
        {
          providerId: "zai-bigmodel-api",
          agent: agent("glm-5.3", async () => {
            backupCalls += 1;
            return successful("glm-5.3");
          }),
        },
      ],
    });

    await assert.rejects(() => fallback.draftDetailed(input), /malformed output/i);
    assert.equal(backupCalls, 0);
  });

  it("rejects a candidate without an explicit broker provider identity", () => {
    assert.throws(
      () => new FallbackScreenwriterAgent({
        candidates: [{ providerId: "", agent: agent("gpt-quality", async () => successful("gpt-quality")) }],
      }),
      /broker provider id/i,
    );
  });
});

describe("model provider failure policy", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["408", new CodexBridgeError("HTTP 408", false, "not_accepted", 408), true],
    ["429", new CodexBridgeError("HTTP 429", false, "not_accepted", 429), true],
    ["502", new CodexBridgeError("HTTP 502", false, "not_accepted", 502), true],
    ["503", new CodexBridgeError("HTTP 503", false, "not_accepted", 503), true],
    ["504", new CodexBridgeError("HTTP 504", false, "not_accepted", 504), true],
    ["unknown 500", new CodexBridgeError("HTTP 500", false, "completed_failure", 500), false],
    ["explicit 500 overload", new CodexBridgeError("HTTP 500: model capacity overloaded", false, "completed_failure", 500), true],
    ["transient 422", new CodexBridgeError("role is temporarily unavailable", false, "completed_failure", 422), true],
    ["structured transient 422", new CodexBridgeError("model execution failed", false, "completed_failure", 422, "model_provider_transient"), true],
    ["semantic 422", new CodexBridgeError("payload failed business validation", false, "completed_failure", 422), false],
    ["socket cause", new Error("outer", { cause: new CodexBridgeError("socket failed with ECONNREFUSED", true) }), true],
    ["timeout", new CodexBridgeError("request timed out after 300000ms", false, "uncertain"), true],
    ["invalid JSON", new CodexBridgeError("response contained invalid JSON", false, "completed_failure", 503), false],
    ["output contract", new CodexBridgeError("output contract failed", false, "completed_failure", 503), false],
    ["content safety", new CodexBridgeError("content safety policy rejected the prompt", false, "completed_failure", 503), false],
    ["schema failure", new CodexBridgeError("response schema validation failed", false, "completed_failure", 503), false],
    ["quality failure", new CodexBridgeError("quality audit failed", false, "completed_failure", 503), false],
  ];

  for (const [label, error, expected] of cases) {
    it(`${expected ? "allows" : "blocks"} fallback for ${label}`, () => {
      assert.equal(isModelProviderFailure(error), expected);
    });
  }
});

describe("FallbackVisualDirectorAgent", () => {
  it("uses the same ordered candidate strategy for visual direction", async () => {
    const calls: string[] = [];
    const directorAgent = (modelId: string): VisualDirectorAgent => ({
      id: "api-visual-director-v1",
      modelId,
      plan: async () => ({}),
      planDetailed: async () => {
        calls.push(modelId);
        if (modelId === "glm-5.3") throw providerFailure(modelId);
        return {
          output: {},
          trace: {
            taskKind: "director-plan",
            promptVersion: "fallback-test-v1",
            prompt: "bounded test prompt",
            providerId: "openai",
            modelId,
          },
        };
      },
    });
    const fallback = new FallbackVisualDirectorAgent({
      candidates: ["gpt-quality", "glm-5.3", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: directorAgent(modelId),
      })),
    });

    const execution = await fallback.planDetailed({
      selectedModelId: "glm-5.3",
    } as VisualDirectorAgentInput);

    assert.deepEqual(calls, ["glm-5.3", "gpt-quality"]);
    assert.equal(execution.trace?.modelId, "gpt-quality");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["glm-5.3", "gpt-quality"]);
  });
});
