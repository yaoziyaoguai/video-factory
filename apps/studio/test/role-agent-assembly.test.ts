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
        modelId: this.modelId,
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
  it("assembles both brokers using health-reported role models", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "gpt-writer",
        "director-plan": "gpt-director",
        "visual-review": "gpt-review",
      }),
      deepseekCodexSettings: settings("deepseek", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "deepseek-writer",
        "director-plan": "deepseek-director",
        "visual-review": "deepseek-review",
      }),
      codexClient: client,
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });

    // 顺序即默认：DeepSeek 在前，Codex 在后。
    assert.equal(result.screenwriterAgent?.modelId, "deepseek-writer");
    assert.equal(result.directorAgent?.modelId, "deepseek-director");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["deepseek-review", "gpt-review"]);
  });

  it("routes the selected reviewed model onto the wire and keeps the broker default when nothing is selected", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-5.6-sol", (kind) => (
      kind === "script-draft" ? validDraft() : passingAudit
    ));
    const result = buildRoleAgentAssembly({
      codexSettings: {
        ...settings("openai", ["script-draft", "role-audit"], { "script-draft": "gpt-5.6-sol" }),
        modelCandidates: ["gpt-5.6-sol", "gpt-6-astra"],
      },
      deepseekCodexSettings: unavailable,
      codexClient: openai,
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

    await result.screenwriterAgent?.draftDetailed?.({ brief, selectedModelId: "gpt-6-astra" });
    assert.equal(openai.requestOptions[0]?.model, "gpt-6-astra");

    // 没有选择时走 broker 的默认模型，"请求的模型就是我"由 broker 归一化成没有覆盖。
    openai.requestOptions.length = 0;
    await result.screenwriterAgent?.draftDetailed?.({ brief });
    assert.equal(openai.requestOptions[0]?.model, "gpt-5.6-sol");
  });

  it("assembles treatment producers for both brokers and fails closed without the task contract", () => {
    const both = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["creative-treatment", "role-audit"], { "creative-treatment": "gpt-director" }),
      deepseekCodexSettings: settings("deepseek", ["creative-treatment", "role-audit"], { "creative-treatment": "deepseek-director" }),
      codexClient: client,
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(
      both.treatmentAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["deepseek-director", "deepseek"], ["gpt-director", "openai"]],
    );

    const withoutTreatment = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], {}),
      deepseekCodexSettings: settings("deepseek", ["script-draft", "role-audit"], {}),
      codexClient: client,
      deepseekCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutTreatment.treatmentAgents, []);

    const withoutAuditor = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["creative-treatment"], {}),
      deepseekCodexSettings: unavailable,
      codexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutAuditor.treatmentAgents, []);
  });

  it("assembles a brief auditor per broker and validates it against the report dimensions", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-audit", () => passingReportAudit);
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["role-audit"], { "role-audit": "gpt-audit" }),
      deepseekCodexSettings: unavailable,
      codexClient: openai,
      reviewMedia,
      environment: {},
    });

    assert.deepEqual(
      result.briefAuditAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["gpt-audit", "openai"]],
    );

    // 评估维度由宿主按角色决定：内容简报走报告四维、评整份简报（根路径 ""）。这次审计必须真的
    // 过校验，否则校验失败会把整条建议丢掉，界面在用户要拿主意时只剩一个空面板。
    const execution = await result.briefAuditAgents[0]!.agent.auditBrief({
      // 审计只读投影里的字段，这里给到投影真正会用到的那些。
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
    assert.deepEqual(openai.calls, ["role-audit"]);
    assert.equal(execution.trace?.modelId, "gpt-audit");

    // 没有 role-audit 合同的 broker 不产出审计候选：复核必须独立，不能拿生产模型顶上。
    const withoutAuditor = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["creative-treatment"], {}),
      deepseekCodexSettings: unavailable,
      codexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutAuditor.briefAuditAgents, []);
  });

  it("expands every role pool to the announced models and lets the selected one go first", async () => {
    // 一个 broker 上公告了几个可用模型，这个角色池里就该有几个候选——首选只是排在最前，不是唯一。
    const announced = ["gpt-5.6-sol", "gpt-6-astra"];
    const openai = new ControlledCodexClient("openai", "unused", () => {
      throw new CodexBridgeError("OpenAI 暂时不可用。", true, "not_accepted", 503);
    });
    const deepseek = new ControlledCodexClient("deepseek", "unused", () => {
      throw new CodexBridgeError("DeepSeek 暂时不可用。", true, "not_accepted", 503);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: {
        ...settings("openai", ["director-plan", "creative-treatment", "role-audit", "script-draft"], {
          "director-plan": "gpt-director",
          "creative-treatment": "gpt-director",
          "role-audit": "gpt-audit",
          "script-draft": "gpt-writer",
        }),
        modelCandidates: announced,
      },
      // DeepSeek 公告了同一批 id：重复的候选会被丢弃（留着它跑的是同一个模型，不是一次兜底），
      // 而 `validateCandidates` 对重复 id 是**建图时**就抛，也就是整个服务起不来。
      deepseekCodexSettings: {
        ...settings("deepseek", ["director-plan", "creative-treatment", "role-audit", "script-draft"], {
          "director-plan": "deepseek-director",
          "creative-treatment": "deepseek-director",
          "role-audit": "deepseek-audit",
          "script-draft": "deepseek-writer",
        }),
        modelCandidates: announced,
      },
      codexClient: openai,
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    assert.deepEqual(
      result.treatmentAgents.map(({ agent }) => agent.modelId),
      ["deepseek-director", "gpt-5.6-sol", "gpt-6-astra", "gpt-director"],
    );
    assert.deepEqual(
      result.briefAuditAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["deepseek-audit", "deepseek"], ["gpt-5.6-sol", "deepseek"], ["gpt-6-astra", "deepseek"], ["gpt-audit", "openai"]],
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
        selectedModelId: "gpt-6-astra",
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ModelCandidatesExhaustedError,
          `期望所有候选都被尝试过，实际抛出 ${(error as Error)?.name}: ${(error as Error)?.message}`,
        );
        assert.deepEqual(
          error.attempts.map((attempt) => [attempt.modelId, attempt.providerId]),
          [
            ["gpt-6-astra", "deepseek"],
            ["deepseek-writer", "deepseek"],
            ["gpt-5.6-sol", "deepseek"],
            ["gpt-writer", "openai"],
          ],
        );
        return true;
      },
    );
  });

  it("sends the selected model first for treatment and brief audit, not just in the picker", async () => {
    // 界面上的候选顺序说明不了实际首发是谁：真正上线路的顺序由 Fallback*Agent 在调用时按
    // selectedModelId 重排。这里照着生产的接法把两种 agent 真的建出来（与 production-pipeline
    // 里 `new FallbackCreativeTreatmentAgent({ candidates: treatmentBindings })`、
    // `new FallbackBriefAuditAgent({ candidates: bindings })` 同一形状），让每个候选都瞬断，
    // 失败清单的顺序就是实际的尝试顺序。
    const openai = new ControlledCodexClient("openai", "unused", () => {
      throw new CodexBridgeError("OpenAI 暂时不可用。", true, "not_accepted", 503);
    });
    const deepseek = new ControlledCodexClient("deepseek", "unused", () => {
      throw new CodexBridgeError("DeepSeek 暂时不可用。", true, "not_accepted", 503);
    });
    const announced = ["gpt-5.6-sol", "gpt-6-astra"];
    const result = buildRoleAgentAssembly({
      codexSettings: {
        ...settings("openai", ["creative-treatment", "role-audit"], {
          "creative-treatment": "gpt-director",
          "role-audit": "gpt-audit",
        }),
        modelCandidates: announced,
      },
      deepseekCodexSettings: settings("deepseek", ["creative-treatment", "role-audit"], {
        "creative-treatment": "deepseek-director",
        "role-audit": "deepseek-audit",
      }),
      codexClient: openai,
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(
      result.treatmentAgents.map(({ agent }) => agent.modelId),
      ["deepseek-director", "gpt-director", "gpt-5.6-sol", "gpt-6-astra"],
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
          selectedModelId: "gpt-director",
        } as never),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.deepEqual(
          error.attempts.map((attempt) => [attempt.modelId, attempt.providerId]),
          [
            ["gpt-director", "openai"],
            ["deepseek-director", "deepseek"],
            ["gpt-5.6-sol", "openai"],
            ["gpt-6-astra", "openai"],
          ],
        );
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
          selectedModelId: "gpt-6-astra",
        } as never),
      (error: unknown) => {
        assert.ok(error instanceof ModelCandidatesExhaustedError);
        assert.deepEqual(
          error.attempts.map((attempt) => [attempt.modelId, attempt.providerId]),
          [
            ["gpt-6-astra", "openai"],
            ["deepseek-audit", "deepseek"],
            ["gpt-audit", "openai"],
            ["gpt-5.6-sol", "openai"],
          ],
        );
        return true;
      },
    );
  });

  it("runs the assembled DeepSeek screenwriter through its OpenAI backup after a transient outage", async () => {
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-writer", () => {
      throw new CodexBridgeError("DeepSeek service temporarily unavailable.", true, "not_accepted", 503);
    });
    const openai = new ControlledCodexClient("openai", "gpt-writer", (kind) => {
      if (kind === "script-draft") return validDraft();
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], { "script-draft": "gpt-writer", "role-audit": "gpt-writer" }),
      deepseekCodexSettings: settings("deepseek", ["script-draft", "role-audit"], { "script-draft": "deepseek-writer", "role-audit": "deepseek-writer" }),
      codexClient: openai,
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    const execution = await result.screenwriterAgent?.draftDetailed?.({
      brief: {
        title: "下班后的三个真实动作",
        angle: "验证生产装配中的模型接管",
        audience: "普通上班族",
        nicheSlug: "assembly-fallback",
        platform: "douyin",
        durationSeconds: 24,
      },
    });

    assert.ok(execution);
    assert.deepEqual(deepseek.calls, ["script-draft"]);
    assert.deepEqual(openai.calls, ["script-draft", "role-audit"]);
    assert.equal(execution.trace?.modelId, "gpt-writer");
    assert.equal(execution.trace?.fallbackFromModelId, "deepseek-writer");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["deepseek-writer", "gpt-writer"]);
  });

  it("keeps assembled OpenAI producer revisions isolated from prior model history", async () => {
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
    const openai = new ControlledCodexClient("openai", "gpt-writer", (kind) => {
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
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], {
        "script-draft": "gpt-writer",
        "role-audit": "gpt-writer",
      }),
      deepseekCodexSettings: unavailable,
      codexClient: openai,
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

    assert.deepEqual(openai.calls, ["script-draft", "role-audit", "script-draft", "role-audit"]);
    assert.deepEqual(openai.sessions, [undefined, undefined, undefined, undefined]);
  });

  it("runs the assembled DeepSeek visual reviewer through its OpenAI backup after a transient outage", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingReportAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-review", (kind) => {
      if (kind === "visual-review") {
        throw new CodexBridgeError("DeepSeek service temporarily unavailable.", true, "not_accepted", 503);
      }
      throw new Error(`Unexpected DeepSeek task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["visual-review", "role-audit"], { "visual-review": "gpt-review" }),
      deepseekCodexSettings: settings("deepseek", ["visual-review", "role-audit"], { "visual-review": "deepseek-review", "role-audit": "deepseek-review" }),
      codexClient: openai,
      deepseekCodexClient: deepseek,
      reviewMedia,
      environment: {},
    });

    // 试片是"要不要继续为同方案其余镜头付费"的闸门，所以它和成片终审一样要求两个分支
    // 落在两个不同的实际身份上。DeepSeek 掉线时备份确实顶上了，但两个分支于是都成了 gpt-review：
    // 闸门宁可不开，也不能拿同一个模型的两份回答当成两次独立复审。
    await assert.rejects(
      () => result.visualReviewAgents[0]!.reviewDetailed!({
        videoPath: "/run/final.mp4",
        runRoot: "/run",
        reviewStage: "source_assets",
      }),
      (error: unknown) => {
        assert.ok(error instanceof IndependentVisualReviewError);
        // 操作员要能看出这是试片而不是成片终审：一个还没花钱，一个已经花过了。
        assert.match(error.message, /试片双模型复审无法成立/);
        assert.deepEqual(error.failures.map((failure) => failure.kind), ["not_independent"]);
        return true;
      },
    );
    assert.deepEqual(deepseek.calls, ["visual-review"]);
    // 两个分支都跑完了：DeepSeek 那一路掉线后由 Codex 顶上，Codex 那一路本来就是 Codex。
    assert.deepEqual(openai.calls, ["visual-review", "role-audit", "visual-review", "role-audit"]);
  });

  it("runs both configured models for the final review while preprocessing evidence once", async () => {
    let prepareCalls = 0;
    const sharedReviewMedia = {
      prepare: async () => {
        prepareCalls += 1;
        return reviewMedia.prepare();
      },
    };
    const openai = new ControlledCodexClient("openai", "gpt-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingReportAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const deepseek = new ControlledCodexClient("deepseek", "deepseek-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingReportAudit;
      throw new Error(`Unexpected DeepSeek task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["visual-review", "role-audit"], { "visual-review": "gpt-review" }),
      deepseekCodexSettings: settings("deepseek", ["visual-review", "role-audit"], { "visual-review": "deepseek-review", "role-audit": "deepseek-review" }),
      codexClient: openai,
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
    assert.deepEqual(deepseek.calls, ["visual-review", "role-audit"]);
    assert.deepEqual(openai.calls, ["visual-review", "role-audit"]);
    assert.deepEqual(execution.independentReviews?.map(({ modelId }) => modelId), ["deepseek-review", "gpt-review"]);
  });

  it("assembles OpenAI-only roles when DeepSeek is unavailable", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "director-plan", "visual-review", "role-audit"], {}),
      deepseekCodexSettings: unavailable,
      codexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent?.modelId, "gpt-default");
    assert.equal(result.directorAgent?.modelId, "gpt-default");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["gpt-default"]);
  });

  it("uses DeepSeek production roles with DeepSeek independent audits when OpenAI is unavailable", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: unavailable,
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
