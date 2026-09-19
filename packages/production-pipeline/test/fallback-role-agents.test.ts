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
import { RoleAgentPlanningHaltError } from "../src/role-agent-loop.js";

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
      providerId: modelId.startsWith("deepseek") ? "deepseek" : "openai",
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
  return modelId.startsWith("deepseek") ? "deepseek" : "openai";
}

describe("FallbackScreenwriterAgent", () => {
  it("puts the user-selected model first and does not call lower-ranked candidates after success", async () => {
    const calls: string[] = [];
    const fallback = new FallbackScreenwriterAgent({
      candidates: ["gpt-quality", "deepseek-flash", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: agent(modelId, async () => {
          calls.push(modelId);
          return successful(modelId);
        }),
      })),
    });

    const execution = await fallback.draftDetailed({ ...input, selectedModelId: "deepseek-flash" });

    assert.deepEqual(calls, ["deepseek-flash"]);
    assert.equal(execution.trace?.modelId, "deepseek-flash");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["deepseek-flash"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [{
      modelId: "deepseek-flash",
      providerId: "deepseek",
      outcome: "succeeded",
    }]);
  });

  it("tries every compatible candidate in order and records the final model", async () => {
    const calls: string[] = [];
    const checkpoints: unknown[] = [];
    const candidates = ["gpt-quality", "deepseek-flash", "gpt-fast"].map((modelId, index) => ({
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

    assert.deepEqual(calls, ["gpt-quality", "deepseek-flash", "gpt-fast"]);
    assert.deepEqual(checkpoints, [
      checkpointsByModel.get("gpt-quality"),
      checkpointsByModel.get("deepseek-flash"),
      checkpointsByModel.get("gpt-fast"),
    ]);
    assert.equal(execution.trace?.modelId, "gpt-fast");
    assert.equal(execution.trace?.fallbackFromModelId, "gpt-quality");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-quality", "deepseek-flash", "gpt-fast"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts?.map((attempt) => [
      attempt.modelId,
      attempt.providerId,
      attempt.outcome,
      attempt.failureStage,
      attempt.failureReason,
    ]), [
      ["gpt-quality", "openai", "failed", "not_accepted", "服务端错误（HTTP 503）"],
      ["deepseek-flash", "deepseek", "failed", "not_accepted", "服务端错误（HTTP 503）"],
      ["gpt-fast", "openai", "succeeded", undefined, undefined],
    ]);
  });

  it("shares one stage admission deadline across every text model candidate", async () => {
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
          providerId: "deepseek",
          agent: agent("deepseek-backup", async (candidateInput) => {
            deadlines.push(candidateInput.wallClockDeadlineAtMs);
            return successful("deepseek-backup");
          }),
        },
      ],
    });

    await fallback.draftDetailed(input);

    assert.deepEqual(deadlines, [1_600, 1_600]);
  });

  it("keeps the default shared admission deadline open after the legacy 660s window", async () => {
    // 用注入时钟模拟首轮生产、审计和返修已经超过旧窗口，不做真实等待。
    let now = 1_000_000;
    const calls: string[] = [];
    const deadlines: Array<number | undefined> = [];
    const fallback = new FallbackScreenwriterAgent({
      now: () => now,
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async (candidateInput) => {
            calls.push("gpt-primary");
            deadlines.push(candidateInput.wallClockDeadlineAtMs);
            now += 700_000;
            throw providerFailure("gpt-primary");
          }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-backup", async (candidateInput) => {
            calls.push("deepseek-backup");
            deadlines.push(candidateInput.wallClockDeadlineAtMs);
            return successful("deepseek-backup");
          }),
        },
      ],
    });

    const execution = await fallback.draftDetailed(input);

    assert.deepEqual(calls, ["gpt-primary", "deepseek-backup"]);
    assert.deepEqual(deadlines, [1_000_000 + 2_700_000, 1_000_000 + 2_700_000]);
    assert.ok(deadlines[0]! > now);
    assert.equal(execution.trace?.modelId, "deepseek-backup");
  });

  it("does not switch from OpenAI to DeepSeek after the original request completed with a provider failure", async () => {
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
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => {
            calls.push("deepseek-flash");
            return successful("deepseek-flash");
          }),
        },
      ],
    });

    await assert.rejects(() => fallback.draftDetailed(input), /temporarily unavailable/);
    assert.deepEqual(calls, ["gpt-5.6-sol"]);
  });

  it("does not start the backup candidate after an uncertain timeout on the primary", async () => {
    let backupCalls = 0;
    const uncertainTimeout = new CodexBridgeError(
      "request timed out after 660000ms; the task may still be executing",
      false,
      "uncertain",
    );
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async () => {
            throw uncertainTimeout;
          }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => {
            backupCalls += 1;
            return successful("deepseek-flash");
          }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.equal(error, uncertainTimeout);
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.stage, "uncertain");
        return true;
      },
    );

    assert.equal(backupCalls, 0);
  });

  it("does not start the backup candidate after an uncertain structured timeout on the primary", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async () => {
            throw new CodexBridgeError(
              "Codex bridge returned HTTP 504.",
              false,
              "uncertain",
              504,
              undefined,
              { category: "timeout", reasonCode: "request_timeout", providerId: "openai", modelId: "gpt-primary" },
            );
          }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => {
            backupCalls += 1;
            return successful("deepseek-flash");
          }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.stage, "uncertain");
        return true;
      },
    );

    assert.equal(backupCalls, 0);
  });

  it("skips another model on the same provider account after a known account limit, then may use a different provider", async () => {
    const calls: string[] = [];
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "deepseek",
          agent: agent("deepseek-primary", async () => {
            calls.push("deepseek-primary");
            throw new CodexBridgeError("broker reported HTTP 429", false, "completed_failure", 422, undefined, {
              category: "rate_limited",
              reasonCode: "http_429",
              providerId: "deepseek",
              modelId: "deepseek-primary",
              scope: "provider_account",
            });
          }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-backup", async () => {
            calls.push("deepseek-backup");
            return successful("deepseek-backup");
          }),
        },
        {
          providerId: "other-provider",
          agent: agent("other-model", async () => {
            calls.push("other-model");
            return successful("other-model");
          }),
        },
      ],
    });

    const execution = await fallback.draftDetailed(input);

    assert.deepEqual(calls, ["deepseek-primary", "other-model"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts?.map((attempt) => attempt.modelId), ["deepseek-primary", "other-model"]);
  });

  it("does not use any fallback after the current credentials are rejected", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "deepseek",
          agent: agent("deepseek-primary", async () => {
            throw new CodexBridgeError("broker account failure", false, "completed_failure", 422, undefined, {
              category: "authentication",
              reasonCode: "http_401",
              providerId: "deepseek",
              modelId: "deepseek-primary",
              scope: "provider_account",
            });
          }),
        },
        {
          providerId: "other-provider",
          agent: agent("other-model", async () => {
            backupCalls += 1;
            return successful("other-model");
          }),
        },
      ],
    });

    await assert.rejects(() => fallback.draftDetailed(input));
    assert.equal(backupCalls, 0);
  });

  for (const [label, notAcceptedFailure] of [
    ["timeout", new CodexBridgeError("request timed out before the task was accepted", false, "not_accepted")],
    ["service unavailable", new CodexBridgeError(
      "Codex bridge returned HTTP 503.",
      true,
      "not_accepted",
      503,
    )],
  ] as const) {
    it(`still switches to the backup after a not_accepted ${label}`, async () => {
      const calls: string[] = [];
      const fallback = new FallbackScreenwriterAgent({
        candidates: [
          {
            providerId: "openai",
            agent: agent("gpt-primary", async () => {
              calls.push("gpt-primary");
              throw notAcceptedFailure;
            }),
          },
          {
            providerId: "deepseek",
            agent: agent("deepseek-flash", async () => {
              calls.push("deepseek-flash");
              return successful("deepseek-flash");
            }),
          },
        ],
      });

      const execution = await fallback.draftDetailed(input);

      assert.deepEqual(calls, ["gpt-primary", "deepseek-flash"]);
      assert.equal(execution.trace?.modelId, "deepseek-flash");
      assert.equal(execution.trace?.fallbackFromModelId, "gpt-primary");
      assert.deepEqual(execution.trace?.modelCandidateAttempts?.map((attempt) => [
        attempt.modelId,
        attempt.outcome,
        attempt.failureStage,
      ]), [
        ["gpt-primary", "failed", "not_accepted"],
        ["deepseek-flash", "succeeded", undefined],
      ]);
    });
  }

  it("does not switch to the backup after a completed invalid-output failure", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async () => {
            throw new CodexBridgeError(
              "model output does not satisfy the requested structure",
              false,
              "completed_failure",
              422,
              undefined,
              { category: "invalid_output", reasonCode: "output_contract", providerId: "openai", modelId: "gpt-primary" },
            );
          }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => {
            backupCalls += 1;
            return successful("deepseek-flash");
          }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.stage, "completed_failure");
        return true;
      },
    );

    assert.equal(backupCalls, 0);
  });

  it("stops immediately on output or business validation failure", async () => {
    let backupCalls = 0;
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        { providerId: "openai", agent: agent("gpt-quality", async () => { throw new Error("Script draft scenes must be an array."); }) },
        { providerId: "deepseek", agent: agent("deepseek-flash", async () => {
          backupCalls += 1;
          return successful("deepseek-flash");
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
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => { throw terminalBackupError; }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.equal(error.cause, terminalBackupError);
        assert.deepEqual(error.failures.map((failure) => failure.modelId), ["gpt-quality", "deepseek-flash"]);
        assert.deepEqual(error.attempts, [
          {
            modelId: "gpt-quality",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "deepseek-flash",
            providerId: "deepseek",
            outcome: "failed",
            failureStage: "transport",
            failureReason: "调用失败",
          },
        ]);
        return true;
      },
    );
  });

  it("hands a planning halt to the planner instead of folding it into candidate failures", async () => {
    // 规划停摆不是模型故障：候选已经产出、独立审计也已经给出结论，需要的是人来补来源或做决定。
    // 它若被折成"候选模型均未能完成"，整份构思连同停摆原因一起消失，调用方再也看不到该处理的事。
    const halt = new RoleAgentPlanningHaltError(
      "导演前期构思需要当前流水线尚未具备的来源：核心兑现依赖当前流水线无法取得的外部材料。",
      {
        version: "video-factory/agent-loop-v1",
        role: "导演前期构思",
        contractVersion: "creative-treatment-test-v1",
        criteria: ["核心制作前提必须有可信获取责任"],
        status: "failed",
        maxIterations: 1,
        iterations: [],
      },
      null,
      { hook: "候选构思" },
      {
        version: "video-factory/role-audit-v2",
        rubricVersion: "video-factory/role-quality-rubric-v1",
        verdict: "repair",
        score: 88,
        assessments: [],
        summary: "构思本身达标，阻断点在来源。",
        issues: [{
          severity: "blocking",
          criterion: "核心制作前提必须有可信获取责任",
          evidence: "核心兑现依赖当前流水线无法取得的外部材料。",
          repairInstruction: "补齐材料，或由用户确认降级方案。",
        }],
        repairInstructions: ["补齐材料"],
        planningDisposition: null,
      },
      {
        status: "needs_source",
        issues: [{
          id: "host-1",
          target: "source",
          beatIds: ["b1"],
          scenePositions: [0],
          reason: "核心兑现依赖当前流水线无法取得的外部材料。",
          requiredChange: "补齐材料，或由用户确认降级方案。",
          evidenceArtifactIds: [],
        }],
      },
    );
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-quality", async () => { throw providerFailure("gpt-quality"); }),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => { throw halt; }),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(!(error instanceof ModelCandidatesExhaustedError));
        assert.equal(error, halt);
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
      candidates: ["gpt-quality", "deepseek-flash", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: agent(modelId, async () => { throw providerFailure(modelId); }),
      })),
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.deepEqual(error.failures.map((failure) => failure.modelId), ["gpt-quality", "deepseek-flash", "gpt-fast"]);
        assert.deepEqual(error.attempts, [
          {
            modelId: "gpt-quality",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "deepseek-flash",
            providerId: "deepseek",
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
        { providerId: "deepseek", agent: agent("deepseek-backup", async (candidateInput) => {
          const checkpoint = candidateInput.agentLoopCheckpoint;
          assert.ok(checkpoint);
          if (await checkpoint.load()) return successful("deepseek-backup");
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
    assert.equal(execution.trace?.modelId, "deepseek-backup");
  });

  for (const [label, auditFailure] of [
    ["HTTP 503", new CodexBridgeError(
      "Codex bridge returned HTTP 503 while auditing.",
      true,
      "not_accepted",
      503,
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
            providerId: "deepseek",
            agent: agent("deepseek-flash", async (candidateInput) => runRoleAgentLoop({
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
                    version: "video-factory/role-audit-v2",
                    rubricVersion: "video-factory/role-quality-rubric-v1",
                    assessments: [{
                      targetPath: "",
                      dimensions: [
                        { dimension: "attention", score: 96, evidence: "开场给出具体对象。" },
                        { dimension: "progression", score: 96, evidence: "中段逐步给出结果。" },
                        { dimension: "payoff", score: 96, evidence: "结尾回答原承诺。" },
                        { dimension: "expression", score: 96, evidence: "旁白自然可读。" },
                      ],
                    }],
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
                    providerId: "deepseek",
                    modelId: "deepseek-flash",
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
      assert.equal(execution.agentLoop?.iterations[0]?.auditTrace?.modelId, "deepseek-flash");
      assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-primary", "deepseek-flash"]);
      assert.equal((checkpointState.get("deepseek-flash") as { status?: string }).status, "passed");
    });
  }

  it("does not switch audit providers when the audit request outcome is uncertain", async () => {
    let primaryProducerCalls = 0;
    let primaryAuditCalls = 0;
    let backupProducerCalls = 0;
    let backupAuditCalls = 0;
    const uncertainAuditTimeout = new CodexBridgeError(
      "role audit request timed out after 300000ms",
      false,
      "uncertain",
    );
    const fallback = new FallbackScreenwriterAgent({
      candidates: [
        {
          providerId: "openai",
          agent: agent("gpt-primary", async () => runRoleAgentLoop({
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
              throw uncertainAuditTimeout;
            },
            validate: (value) => value as { scenes: unknown[] },
          })),
        },
        {
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => runRoleAgentLoop({
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
              throw new Error("backup audit must not run");
            },
            validate: (value) => value as { scenes: unknown[] },
          })),
        },
      ],
    });

    await assert.rejects(
      () => fallback.draftDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof RoleAgentLoopError);
        assert.ok(error.sourceError instanceof CodexBridgeError);
        assert.equal(error.sourceError, uncertainAuditTimeout);
        assert.equal(error.sourceError.stage, "uncertain");
        return true;
      },
    );

    assert.equal(primaryProducerCalls, 1);
    assert.equal(primaryAuditCalls, 1);
    assert.equal(backupProducerCalls, 0);
    assert.equal(backupAuditCalls, 0);
  });

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
          providerId: "deepseek",
          agent: agent("deepseek-flash", async () => {
            backupCalls += 1;
            return successful("deepseek-flash");
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
    ["uncertain timeout", new CodexBridgeError("request timed out after 300000ms", false, "uncertain"), false],
    ["uncertain service unavailable HTTP 503", new CodexBridgeError("Codex bridge returned HTTP 503.", false, "uncertain", 503), false],
    ["uncertain gateway timeout HTTP 504", new CodexBridgeError("Codex bridge returned HTTP 504.", false, "uncertain", 504), false],
    ["uncertain request timeout HTTP 408", new CodexBridgeError("Codex bridge returned HTTP 408.", false, "uncertain", 408), false],
    ["uncertain with structured timeout category", new CodexBridgeError(
      "model request timed out",
      false,
      "uncertain",
      504,
      undefined,
      { category: "timeout", reasonCode: "request_timeout", providerId: "openai", modelId: "gpt-5.6-sol" },
    ), false],
    ["uncertain with structured network category", new CodexBridgeError(
      "connection was reset while the task was already accepted",
      false,
      "uncertain",
      undefined,
      undefined,
      { category: "network", reasonCode: "connection_reset", providerId: "openai", modelId: "gpt-5.6-sol" },
    ), false],
    ["uncertain structured transient kind", new CodexBridgeError(
      "task status is unknown after a transport failure",
      false,
      "uncertain",
      503,
      "model_provider_transient",
    ), false],
    ["not_accepted timeout message", new CodexBridgeError("request timed out before the task was accepted", false, "not_accepted"), true],
    ["not_accepted structured timeout category", new CodexBridgeError(
      "model request timed out",
      false,
      "not_accepted",
      undefined,
      undefined,
      { category: "timeout", reasonCode: "request_timeout", providerId: "openai", modelId: "gpt-5.6-sol" },
    ), true],
    ["unknown 500", new CodexBridgeError("HTTP 500", false, "completed_failure", 500), false],
    ["explicit 500 overload", new CodexBridgeError("HTTP 500: model capacity overloaded", false, "completed_failure", 500), false],
    ["transient 422", new CodexBridgeError("role is temporarily unavailable", false, "completed_failure", 422), false],
    ["structured transient 422", new CodexBridgeError("model execution failed", false, "completed_failure", 422, "model_provider_transient"), true],
    ["model completed without output", new CodexBridgeError(
      "The model could not complete this step.",
      false,
      "completed_failure",
      422,
      "model_provider_no_output",
    ), true],
    ["structured authentication overrides no-output", new CodexBridgeError(
      "The model could not complete this step.",
      false,
      "completed_failure",
      422,
      "model_provider_no_output",
      { category: "authentication", reasonCode: "auth", providerId: "openai", modelId: "gpt-5.6-sol" },
    ), false],
    ["semantic 422", new CodexBridgeError("payload failed business validation", false, "completed_failure", 422), false],
    ["socket cause", new Error("outer", { cause: new CodexBridgeError("socket failed with ECONNREFUSED", true) }), true],
    ["uncertain socket cause", new Error("outer", { cause: new CodexBridgeError("socket failed with ECONNRESET while the task was accepted", false, "uncertain") }), false],
    ["invalid JSON", new CodexBridgeError("response contained invalid JSON", false, "completed_failure", 503), false],
    ["structured invalid JSON", new CodexBridgeError(
      "model output could not be parsed",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_output", reasonCode: "invalid_json", providerId: "deepseek", modelId: "deepseek-flash" },
    ), false],
    ["structured output contract", new CodexBridgeError(
      "model output does not satisfy the requested structure",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_output", reasonCode: "output_contract", providerId: "deepseek", modelId: "deepseek-flash" },
    ), false],
    ["invalid request mentioning JSON", new CodexBridgeError(
      "request uses an invalid JSON schema",
      false,
      "completed_failure",
      400,
      undefined,
      { category: "invalid_request", reasonCode: "invalid_json_schema", providerId: "openai", modelId: "gpt-5.6-sol" },
    ), false],
    ["bare HTTP 404 stays terminal", new CodexBridgeError(
      "DeepSeek Chat Completion returned HTTP 404.",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_request", reasonCode: "http_404", providerId: "deepseek", modelId: "deepseek-v3" },
    ), false],
    ["numeric provider code 404 stays terminal", new CodexBridgeError(
      "DeepSeek Chat Completion returned HTTP 404 (code 404).",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_request", reasonCode: "404", providerId: "deepseek", modelId: "deepseek-v3" },
    ), false],
    ["explicit retired model code can switch", new CodexBridgeError(
      "DeepSeek Chat Completion returned HTTP 404 (code model_not_found).",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_request", reasonCode: "model_not_found", providerId: "deepseek", modelId: "deepseek-v3" },
    ), true],
    // 合同违规同样是 invalid_request，但 reasonCode 不是 404：这里必须停下。合同 bug 换一个模型
    // 只会被掩盖成"第二个模型也不行"。
    ["contract mismatch stays terminal", new CodexBridgeError(
      "The requested task contract is not available on this broker.",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_request", reasonCode: "contract_mismatch", providerId: "codex-broker", modelId: "gpt-5.6-sol" },
    ), false],
    ["unsupported parameter stays terminal", new CodexBridgeError(
      "request uses an unsupported parameter",
      false,
      "completed_failure",
      422,
      undefined,
      { category: "invalid_request", reasonCode: "unsupported_parameter", providerId: "deepseek", modelId: "deepseek-flash" },
    ), false],
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
        if (modelId === "deepseek-flash") throw providerFailure(modelId);
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
      candidates: ["gpt-quality", "deepseek-flash", "gpt-fast"].map((modelId) => ({
        providerId: brokerProviderId(modelId),
        agent: directorAgent(modelId),
      })),
    });

    const execution = await fallback.planDetailed({
      selectedModelId: "deepseek-flash",
    } as VisualDirectorAgentInput);

    assert.deepEqual(calls, ["deepseek-flash", "gpt-quality"]);
    assert.equal(execution.trace?.modelId, "gpt-quality");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["deepseek-flash", "gpt-quality"]);
  });
});
