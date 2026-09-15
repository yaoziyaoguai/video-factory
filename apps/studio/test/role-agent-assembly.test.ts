import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  IndependentVisualReviewError,
  type CodexTaskExecution,
  type CodexTaskKind,
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
  ): Promise<CodexTaskExecution> {
    this.calls.push(kind);
    this.sessions.push(_session);
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

const passingAudit = {
  version: "video-factory/role-audit-v1",
  verdict: "pass",
  score: 95,
  summary: "候选交付满足约束。",
  issues: [],
  repairInstructions: [],
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
  provider: "openai" | "zai",
  taskKinds: string[],
  taskModels: Record<string, string>,
): CodexProviderSettings {
  return {
    socketPath: `/tmp/${provider}.sock`,
    configured: true,
    available: true,
    modelId: provider === "openai" ? "gpt-default" : "glm-default",
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
      zaiCodexSettings: settings("zai", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "glm-writer",
        "director-plan": "glm-director",
        "visual-review": "glm-review",
      }),
      codexClient: client,
      zaiCodexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent?.modelId, "gpt-writer");
    assert.equal(result.directorAgent?.modelId, "gpt-director");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["glm-review", "gpt-review"]);
  });

  it("assembles treatment producers for both brokers and fails closed without the task contract", () => {
    const both = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["creative-treatment", "role-audit"], { "creative-treatment": "gpt-director" }),
      zaiCodexSettings: settings("zai", ["creative-treatment", "role-audit"], { "creative-treatment": "glm-director" }),
      codexClient: client,
      zaiCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(
      both.treatmentAgents.map(({ agent, providerId }) => [agent.modelId, providerId]),
      [["gpt-director", "openai"], ["glm-director", "zai-bigmodel-api"]],
    );

    const withoutTreatment = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], {}),
      zaiCodexSettings: settings("zai", ["script-draft", "role-audit"], {}),
      codexClient: client,
      zaiCodexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutTreatment.treatmentAgents, []);

    const withoutAuditor = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["creative-treatment"], {}),
      zaiCodexSettings: unavailable,
      codexClient: client,
      reviewMedia,
      environment: {},
    });
    assert.deepEqual(withoutAuditor.treatmentAgents, []);
  });

  it("runs the assembled OpenAI screenwriter through its GLM backup after a transient outage", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-writer", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", true, "not_accepted", 503);
    });
    const zai = new ControlledCodexClient("zai-bigmodel-api", "glm-writer", (kind) => {
      if (kind === "script-draft") return validDraft();
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected ZAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], { "script-draft": "gpt-writer" }),
      zaiCodexSettings: settings("zai", ["script-draft", "role-audit"], { "script-draft": "glm-writer", "role-audit": "glm-writer" }),
      codexClient: openai,
      zaiCodexClient: zai,
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
    assert.deepEqual(openai.calls, ["script-draft"]);
    assert.deepEqual(zai.calls, ["script-draft", "role-audit"]);
    assert.equal(execution.trace?.modelId, "glm-writer");
    assert.equal(execution.trace?.fallbackFromModelId, "gpt-writer");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-writer", "glm-writer"]);
  });

  it("keeps assembled OpenAI producer revisions isolated from prior model history", async () => {
    const repairAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "repair",
      score: 70,
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
      zaiCodexSettings: unavailable,
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

  it("runs the assembled GLM visual reviewer through its OpenAI backup after a transient outage", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const zai = new ControlledCodexClient("zai-bigmodel-api", "glm-review", (kind) => {
      if (kind === "visual-review") {
        throw new CodexBridgeError("GLM service temporarily unavailable.", true, "not_accepted", 503);
      }
      throw new Error(`Unexpected ZAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["visual-review", "role-audit"], { "visual-review": "gpt-review" }),
      zaiCodexSettings: settings("zai", ["visual-review", "role-audit"], { "visual-review": "glm-review", "role-audit": "glm-review" }),
      codexClient: openai,
      zaiCodexClient: zai,
      reviewMedia,
      environment: {},
    });

    // 试片是"要不要继续为同方案其余镜头付费"的闸门，所以它和成片终审一样要求两个分支
    // 落在两个不同的实际身份上。GLM 掉线时备份确实顶上了，但两个分支于是都成了 gpt-review：
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
    assert.deepEqual(zai.calls, ["visual-review"]);
    // 两个分支都跑完了：GLM 那一路掉线后由 Codex 顶上，Codex 那一路本来就是 Codex。
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
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const zai = new ControlledCodexClient("zai-bigmodel-api", "glm-review", (kind) => {
      if (kind === "visual-review") return passingVisualReport;
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected ZAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["visual-review", "role-audit"], { "visual-review": "gpt-review" }),
      zaiCodexSettings: settings("zai", ["visual-review", "role-audit"], { "visual-review": "glm-review", "role-audit": "glm-review" }),
      codexClient: openai,
      zaiCodexClient: zai,
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
    assert.deepEqual(zai.calls, ["visual-review", "role-audit"]);
    assert.deepEqual(openai.calls, ["visual-review", "role-audit"]);
    assert.deepEqual(execution.independentReviews?.map(({ modelId }) => modelId), ["glm-review", "gpt-review"]);
  });

  it("assembles OpenAI-only roles when ZAI is unavailable", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "director-plan", "visual-review", "role-audit"], {}),
      zaiCodexSettings: unavailable,
      codexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent?.modelId, "gpt-default");
    assert.equal(result.directorAgent?.modelId, "gpt-default");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["gpt-default"]);
  });

  it("uses ZAI production roles with ZAI independent audits when OpenAI is unavailable", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: unavailable,
      zaiCodexSettings: settings("zai", ["script-draft", "director-plan", "visual-review", "role-audit"], {
        "script-draft": "glm-writer",
        "director-plan": "glm-director",
        "visual-review": "glm-review",
        "role-audit": "glm-auditor",
      }),
      zaiCodexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent?.modelId, "glm-writer");
    assert.equal(result.directorAgent?.modelId, "glm-director");
    assert.deepEqual(result.visualReviewAgents.map((agent) => agent.modelId), ["glm-review"]);
  });

  it("fails closed when no independent auditor is available", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: unavailable,
      zaiCodexSettings: settings("zai", ["script-draft", "director-plan", "visual-review"], {}),
      zaiCodexClient: client,
      reviewMedia,
      environment: {},
    });

    assert.equal(result.screenwriterAgent, undefined);
    assert.equal(result.directorAgent, undefined);
    assert.deepEqual(result.visualReviewAgents, []);
  });
});
