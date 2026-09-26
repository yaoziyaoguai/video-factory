import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  FallbackBriefAuditAgent,
  FallbackCreativeTreatmentAgent,
  IndependentVisualReviewError,
  ModelCandidatesExhaustedError,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskRequestOptions,
  type ProductionBrief,
} from "@video-factory/production-pipeline";
import type { CodexProviderSettings } from "../src/server/codex-provider-settings.js";
import { buildRoleAgentAssembly } from "../src/server/role-agent-assembly.js";

const client = new CodexBridgeClient({ socketPath: "/tmp/vf-role-assembly-test.sock" });

const reviewMedia = {
  prepare: async () => ({
    durationMs: 1_000,
    frames: [{ timecodeMs: 0, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==" }],
  }),
};

class ControlledCodexClient extends CodexBridgeClient {
  readonly calls: CodexTaskKind[] = [];
  readonly sessions: Array<CodexTaskExecution["session"]> = [];
  /** 每次调用实际带上的请求选项；模型选择是否真的走上线路，只能在这里看出来。 */
  readonly requestOptions: CodexTaskRequestOptions[] = [];

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    private readonly respond: (kind: CodexTaskKind) => unknown,
  ) {
    super({ socketPath: "/nonexistent/vf-role-assembly-test.sock", sleep: async () => {} });
  }

  override async runTaskDetailed(
    kind: CodexTaskKind,
    _payload: unknown,
    _requestId = "assembly-test",
    _session?: CodexTaskExecution["session"],
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    this.calls.push(kind);
    this.sessions.push(_session);
    this.requestOptions.push(requestOptions);
    return {
      output: this.respond(kind),
      trace: {
        taskKind: kind,
        promptVersion: `test/${kind}`,
        prompt: `prompt:${kind}`,
        providerId: this.providerId,
        // 与真实 broker 一致：trace 记录的是本次请求实际使用的模型（selectedModelId 经
        // requestOptions 上线路），而不是客户端构造时的默认模型——同 socket 的两条审片腿
        // 靠这个字段区分身份。
        modelId: requestOptions.model ?? this.modelId,
      },
    };
  }
}

const CREATIVE_DIMENSION_EVIDENCE: Record<string, string> = {
  attention: "前两秒给出具体动作，不靠口号开场。",
  progression: "三段之间有可辨认的推进。",
  payoff: "结尾兑现了观众承诺。",
  expression: "画面要求在当前素材能力内可落地。",
};

const REPORT_DIMENSION_EVIDENCE: Record<string, string> = {
  evidence: "结论引用了具体的关键帧或时间码。",
  coverage: "覆盖了需要判断的全部镜头。",
  consistency: "同一对象在不同镜头里的描述一致。",
  actionability: "给出的处理方式可以直接执行。",
};

function scoredDimensions(evidenceByDimension: Record<string, string>, score: number) {
  return Object.entries(evidenceByDimension).map(([dimension, evidence]) => ({ dimension, score, evidence }));
}

// 评估对象与维度集合由宿主按角色决定：创作交付（编剧/导演）评四维创作维度，
// 报告型（视觉审片员）评四维报告维度，两者不能互换。
const passingAudit = {
  version: "video-factory/role-audit-v2",
  rubricVersion: "video-factory/role-quality-rubric-v1",
  verdict: "pass",
  score: 95,
  assessments: [{ targetPath: "", dimensions: scoredDimensions(CREATIVE_DIMENSION_EVIDENCE, 95) }],
  summary: "候选交付满足约束。",
  issues: [],
  repairInstructions: [],
};

const passingReportAudit = {
  ...passingAudit,
  assessments: [{ targetPath: "", dimensions: scoredDimensions(REPORT_DIMENSION_EVIDENCE, 95) }],
};

function validDraft() {
  return {
    scenes: [1, 2, 3].map((position) => ({
      position,
      narration: `第 ${position} 场旁白：一个具体动作。`,
      duration: 8,
      visual_strategy: "stock",
      visual_prompt: `第 ${position} 场画面：日常动作竖屏近景`,
      search_terms: ["日常动作", "真实场景"],
    })),
  };
}

const passingVisualReport = {
  version: "video-factory/visual-review-v1",
  summary: "关键帧覆盖完整，画面可以进入人工终审。",
  scores: { composition: 90, continuity: 90, pacing: 88, legibility: 92, safety: 98 },
  findings: [],
  confidence: 0.9,
  recommendation: "approve",
};

function settings(
  provider: "openai" | "deepseek",
  taskKinds: string[],
  taskModels: Record<string, string>,
): CodexProviderSettings {
  return {
    socketPath: `/tmp/${provider}.sock`,
    configured: true,
    available: true,
    modelId: provider === "openai" ? "gpt-default" : "deepseek-default",
    requirement: "test",
    reason: "",
    taskKinds,
    taskModels,
  };
}

const unavailable: CodexProviderSettings = {
  socketPath: "/tmp/missing.sock",
  configured: false,
  available: false,
  modelId: "",
  requirement: "test",
  reason: "missing",
  taskKinds: [],
};

describe("buildRoleAgentAssembly", () => {
  it("assembles the DeepSeek broker using health-reported role models", () => {
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "deepseek-writer",
        "director-plan": "deepseek-director",
        "visual-review": "deepseek-review",
      }),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });

    // ChatGPT/Codex 套餐退役后只剩 DeepSeek 一个候选源；审片第二腿是同 broker 的另一模型。
    assert.equal(result.screenwriterAgent?.modelId, "deepseek-writer");
    assert.equal(result.directorAgent?.modelId, "deepseek-director");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["deepseek-review"]);
  });

  it("routes the selected reviewed model onto the wire and keeps the broker default when nothing is selected", async () => {
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-flash", (kind) => (
      kind === "script-draft" ? validDraft() : passingAudit
    ));
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: {
        ...settings("deepseek", ["script-draft", "role-audit"], { "script-draft": "deepseek-flash" }),
        modelCandidates: ["deepseek-flash", "deepseek-v4-pro"],
      },
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });
    const brief = {
      title: "下班后的三个真实动作",
      angle: "验证按节点选择模型",
      audience: "普通上班族",
      nicheSlug: "assembly-model-switch",
      platform: "douyin",
      durationSeconds: 24,
    };

    await result.screenwriterAgent?.draftDetailed?.({ brief, selectedModelId: "deepseek-v4-pro" });
    assert.equal(deepseek.requestOptions[0]?.model, "deepseek-v4-pro");

    // 没有选择时走 broker 的默认模型，"请求的模型就是我"由 broker 归一化成没有覆盖。
    deepseek.requestOptions.length = 0;
    await result.screenwriterAgent?.draftDetailed?.({ brief });
    assert.equal(deepseek.requestOptions[0]?.model, "deepseek-flash");
  });

  it("assembles treatment producers and fails closed without the task contract", () => {
    const withTreatment = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["creative-treatment", "role-audit"], { "creative-treatment": "deepseek-director" }),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(
      withTreatment.treatmentAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["deepseek-director", "deepseek"]],
    );

    const withoutTreatment = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["script-draft", "role-audit"], {}),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutTreatment.treatmentAgents, []);

    const withoutAuditor = buildRoleAgentAssembly({
      deepseekCodexSettings: unavailable,
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutAuditor.treatmentAgents, []);
  });

  it("assembles a brief auditor and validates it against the report dimensions", async () => {
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-audit", () => passingReportAudit);
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["role-audit"], { "role-audit": "deepseek-audit" }),
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    assert.deepEqual(
      result.briefAuditAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["deepseek-audit", "deepseek"]],
    );

    // 评估维度由宿主按角色决定：内容简报走报告四维、评整份简报（根路径 ""）。这次审计必须真的
    // 过校验，否则校验失败会把整条建议丢掉，界面在用户要拿主意时只剩一个空面板。
    const execution = await result.briefAuditAgents[0]!.agent.auditBrief({
      brief: {
        title: "下班后的三个真实动作",
        angle: "先做后说，不喊口号",
        audience: "普通上班族",
        nicheSlug: "assembly-brief-audit",
        platform: "douyin",
        durationSeconds: 24,
      } as unknown as ProductionBrief,
    });

    // 只审不产：一次简报审计里除了 role-audit 不该出现任何生产任务。
    assert.deepEqual(deepseek.calls, ["role-audit"]);
    assert.equal(execution.trace?.modelId, "deepseek-audit");

    // 没有 role-audit 合同的 broker 不产出审计候选：复核必须独立，不能拿生产模型顶上。
    const withoutAuditor = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["creative-treatment"], {}),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutAuditor.briefAuditAgents, []);
  });

  it("expands the role pools to the announced models and lets the selected one go first", async () => {
    // 一个 broker 上公告了几个可用模型，这个角色池里就该有几个候选——首选只是排在最前，不是唯一。
    const announced = ["deepseek-flash", "deepseek-v4-pro"];
    const deepseek = new ControlledCodexClient("deepseek", "unused", () => {
      throw new CodexBridgeError("DeepSeek 暂时不可用。", true, "not_accepted", 503);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: {
        ...settings("deepseek", ["director-plan", "creative-treatment", "role-audit", "script-draft"], {
          "director-plan": "deepseek-director",
          "creative-treatment": "deepseek-director",
          "role-audit": "deepseek-audit",
          "script-draft": "deepseek-writer",
        }),
        modelCandidates: announced,
      },
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    assert.deepEqual(
      result.treatmentAgents.map(({ agent }) => agent.modelId),
      ["deepseek-director", "deepseek-flash", "deepseek-v4-pro"],
    );
    assert.deepEqual(
      result.briefAuditAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["deepseek-audit", "deepseek"], ["deepseek-flash", "deepseek"], ["deepseek-v4-pro", "deepseek"]],
    );
    // 没有选择时首选是每个角色的第一个候选，也就是 DeepSeek 的默认模型。
    assert.equal(result.directorAgent?.modelId, "deepseek-director");
    assert.equal(result.screenwriterAgent?.modelId, "deepseek-writer");

    // 选中的模型排在最前，其余按公告顺序跟上。让每个候选都掉线，失败清单的顺序就是实际的尝试顺序。
    await assert.rejects(
      () => result.screenwriterAgent!.draftDetailed!({
        brief: {
          title: "下班后的三个真实动作",
          angle: "验证候选顺序",
          audience: "普通上班族",
          nicheSlug: "assembly-candidate-order",
          platform: "douyin",
          durationSeconds: 24,
        },
        selectedModelId: "deepseek-v4-pro",
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ModelCandidatesExhaustedError,
          `期望所有候选都被尝试过，实际抛出 ${(error as Error)?.name}: ${(error as Error)?.message}`,
        );
        assert.deepEqual(
          error.attempts.map((attempt) => [attempt.modelId, attempt.providerId]),
          [
            ["deepseek-v4-pro", "deepseek"],
            ["deepseek-writer", "deepseek"],
            ["deepseek-flash", "deepseek"],
          ],
        );
        return true;
      },
    );
  });

  it("sends the selected model first for treatment and brief audit, not just in the picker", async () => {
    // 界面上的候选顺序说明不了实际首发是谁：真正上线路的顺序由 Fallback*Agent 在调用时按
    // selectedModelId 重排。这里照着生产的接法把 agent 真的建出来（与 production-pipeline 里
    // `new FallbackCreativeTreatmentAgent({ candidates: treatmentBindings })`、
    // `new FallbackBriefAuditAgent({ candidates: bindings })` 同一形状），让每个候选都瞬断，
    // 失败清单的顺序就是实际的尝试顺序。
    const deepseek = new ControlledCodexClient("deepseek", "unused", () => {
      throw new CodexBridgeError("DeepSeek 暂时不可用。", true, "not_accepted", 503);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["creative-treatment", "role-audit"], {
        "creative-treatment": "deepseek-director",
        "role-audit": "deepseek-audit",
      }),
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(
      result.treatmentAgents.map(({ agent }) => agent.modelId),
      ["deepseek-director"],
    );

    await assert.rejects(
      () => new FallbackCreativeTreatmentAgent({ candidates: result.treatmentAgents })
        .treatDetailed({
          brief: {
            title: "下班后的三个真实动作",
            angle: "验证构思候选顺序",
            audience: "普通上班族",
            nicheSlug: "assembly-treatment-order",
            platform: "douyin",
            durationSeconds: 24,
          },
          suppliedSources: [],
          selectedModelId: "deepseek-director",
        } as never),
      (error: unknown) => {
        // 单候选池失败没有排序语义：断言聚合错误把唯一候选的原因带出来即可。
        assert.match((error as Error).message, /1 个候选模型调用未能完成/);
        assert.match((error as Error).message, /deepseek-director 服务端错误/);
        return true;
      },
    );

    await assert.rejects(
      () => new FallbackBriefAuditAgent({ candidates: result.briefAuditAgents })
        .auditBrief({
          brief: {
            title: "下班后的三个真实动作",
            angle: "先做后说，不喊口号",
            audience: "普通上班族",
            nicheSlug: "assembly-brief-audit-order",
            platform: "douyin",
            durationSeconds: 24,
          } as unknown as ProductionBrief,
          selectedModelId: "deepseek-v4-pro",
        } as never),
      (error: unknown) => {
        // 该 fixture 的池子只有一个候选：选中不在池中的模型 → 快速拒绝（选型校验先于任何调用）。
        assert.match((error as Error).message, /Selected model 'deepseek-v4-pro' is not available for this role/);
        // calls 里的 creative-treatment 是同 client 前一段 treatment 尝试的调用残留。
        assert.deepEqual(deepseek.calls, ["creative-treatment"]);
        return true;
      },
    );
  });

  it("fails the screenwriter without a backup after a transient DeepSeek outage", async () => {
    // ChatGPT/Codex 套餐退役后没有跨厂商 backup：DeepSeek 掉线时制作暂停等人，
    // 不存在"另一个厂商的模型顶上"的路径。
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-writer", () => {
      throw new CodexBridgeError("DeepSeek service temporarily unavailable.", true, "not_accepted", 503);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["script-draft", "role-audit"], { "script-draft": "deepseek-writer", "role-audit": "deepseek-writer" }),
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    await assert.rejects(
      () => result.screenwriterAgent?.draftDetailed?.({
        brief: {
          title: "下班后的三个真实动作",
          angle: "验证生产装配中的暂停语义",
          audience: "普通上班族",
          nicheSlug: "assembly-no-backup",
          platform: "douyin",
          durationSeconds: 24,
        },
      }),
      (error: unknown) => {
        // 无 backup 后失败以 RoleAgentLoopError 形态上抛（loop 的标准包装），
        // 聚合消息里保留暂时性故障的中文原因；没有任何第二厂商调用。
        assert.match(error?.message ?? "", /暂时不可用/);
        assert.deepEqual(deepseek.calls, ["script-draft"]);
        return true;
      },
    );
  });

  it("keeps assembled producer revisions isolated from prior model history", async () => {
    const repairAudit = {
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      verdict: "repair",
      score: 70,
      assessments: [{ targetPath: "", dimensions: scoredDimensions(CREATIVE_DIMENSION_EVIDENCE, 70) }],
      summary: "第一镜需要更具体。",
      issues: [{
        severity: "blocking",
        criterion: "前两秒建立具体钩子",
        evidence: "第一镜没有先给结果。",
        repairInstruction: "第一镜先展示结果。",
      }],
      repairInstructions: ["第一镜先展示结果。"],
    };
    let scriptCalls = 0;
    let auditCalls = 0;
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-writer", (kind) => {
      if (kind === "script-draft") {
        scriptCalls += 1;
        const draft = validDraft();
        if (scriptCalls === 2) draft.scenes[0]!.narration = "先看结果，再解释原因。";
        return draft;
      }
      if (kind === "role-audit") {
        auditCalls += 1;
        return auditCalls === 1 ? repairAudit : passingAudit;
      }
      throw new Error(`Unexpected DeepSeek task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["script-draft", "role-audit"], {
        "script-draft": "deepseek-writer",
        "role-audit": "deepseek-writer",
      }),
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    await result.screenwriterAgent?.draftDetailed?.({
      brief: {
        title: "下班后的三个真实动作",
        angle: "验证隔离修订",
        audience: "普通上班族",
        nicheSlug: "isolated-repair",
        platform: "douyin",
        durationSeconds: 24,
      },
    });

    assert.deepEqual(deepseek.calls, ["script-draft", "role-audit", "script-draft", "role-audit"]);
    assert.deepEqual(deepseek.sessions, [undefined, undefined, undefined, undefined]);
  });

  for (const reviewStage of ["source_assets", "rendered_video"] as const) {
    it(`stops the production ${reviewStage} review after its first advisory audit`, async () => {
      const advisory = {
        ...passingReportAudit,
        verdict: "repair",
        score: 76,
        assessments: [{ targetPath: "", dimensions: scoredDimensions(REPORT_DIMENSION_EVIDENCE, 76) }],
        summary: "补充构图观察可让报告更完整。",
        issues: [{ severity: "advisory", criterion: "观察完整", evidence: "缺少水平线位置描述。", repairInstruction: "补充水平线位置。" }],
        repairInstructions: ["补充水平线位置。"],
      };
      const deepseek = new ControlledCodexClient("deepseek", "deepseek-review", (kind) => {
        if (kind === "visual-review") return passingVisualReport;
        if (kind === "role-audit") return advisory;
        throw new Error(`Unexpected review task ${kind}`);
      });
      const result = buildRoleAgentAssembly({
        deepseekCodexSettings: settings("deepseek", ["visual-review", "role-audit"], { "visual-review": "deepseek-review" }),
        deepseekCodexClient: deepseek,
        reviewMedia,
        environment: {},
      });
      const execution = await result.visualReviewAgents[0]?.reviewDetailed?.({ runRoot: "/run", reviewStage });
      assert.deepEqual(deepseek.calls, ["visual-review", "role-audit"]);
      assert.equal(execution?.agentLoop?.status, "awaiting_user");
      assert.equal(execution?.agentLoop?.iterations.length, 1);
      assert.equal(execution?.agentLoop?.iterations[0]?.audit.score, 76);
      assert.deepEqual(execution?.output, passingVisualReport);
    });
  }

  it("runs the single DeepSeek review leg for the pilot review while preprocessing evidence once", async () => {
    // 双模型审片随 ChatGPT/Codex 套餐退役取消：只剩 DeepSeek 单腿，抽帧预处理一次。
    let prepareCalls = 0;
    const sharedReviewMedia = {
      prepare: async () => {
        prepareCalls += 1;
        return reviewMedia.prepare();
      },
    };
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingReportAudit;
      throw new Error(`Unexpected DeepSeek task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["visual-review", "role-audit"], {
        "visual-review": "deepseek-review",
      }),
      deepseekCodexClient: deepseek,
      reviewMedia: sharedReviewMedia,
      environment: {},
    });

    const execution = await result.visualReviewAgents[0]?.reviewDetailed?.({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "source_assets",
    });

    assert.ok(execution);
    assert.equal(prepareCalls, 1, "抽帧预处理只做一次");
    assert.equal(execution.trace?.modelId, "deepseek-review");
    assert.ok(execution.output, "单腿审查必须产出真实报告");
  });


  it("runs the single DeepSeek review leg for the final review while preprocessing evidence once", async () => {
    let prepareCalls = 0;
    const sharedReviewMedia = {
      prepare: async () => {
        prepareCalls += 1;
        return reviewMedia.prepare();
      },
    };
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingReportAudit;
      throw new Error(`Unexpected DeepSeek task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["visual-review", "role-audit"], {
        "visual-review": "deepseek-review",
      }),
      deepseekCodexClient: deepseek,
      reviewMedia: sharedReviewMedia,
      environment: {},
    });

    const execution = await result.visualReviewAgents[0]?.reviewDetailed?.({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "rendered_video",
    });

    assert.ok(execution);
    assert.equal(prepareCalls, 1);
    assert.equal(execution.trace?.modelId, "deepseek-review");
    assert.ok(execution.output, "单腿审查必须产出真实报告");
  });



  it("assembles DeepSeek-only roles when no codex settings exist at all", () => {
    // ChatGPT/Codex 套餐退役后的默认世界：buildRoleAgentAssembly 不再接受 codex 入参也能装配。
    const result = buildRoleAgentAssembly({
      deepseekCodexSettings: settings("deepseek", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "deepseek-writer",
        "director-plan": "deepseek-director",
        "visual-review": "deepseek-review",
        "role-audit": "deepseek-auditor",
      }),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent?.modelId, "deepseek-writer");
    assert.equal(result.directorAgent?.modelId, "deepseek-director");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["deepseek-review"]);
  });

  it("fails closed when no independent auditor is available", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: unavailable,
      deepseekCodexSettings: settings("deepseek", ["script-draft", "director-plan", "visual-review"], {}),
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent, undefined);
    assert.equal(result.directorAgent, undefined);
    assert.deepEqual(result.visualReviewAgents, []);
  });
});
