import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
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
      zaiCodexSettings: settings("zai", ["script-draft", "director-plan", "visual-review"], {
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

  it("runs the assembled OpenAI screenwriter through its GLM backup after a transient outage", async () => {
    const openai = new ControlledCodexClient("openai", "gpt-writer", (kind) => {
      if (kind === "script-draft") {
        throw new CodexBridgeError("OpenAI service temporarily unavailable.", true, "not_accepted", 503);
      }
      if (kind === "role-audit") return passingAudit;
      throw new Error(`Unexpected OpenAI task ${kind}`);
    });
    const zai = new ControlledCodexClient("zai-bigmodel-api", "glm-writer", (kind) => {
      if (kind === "script-draft") return validDraft();
      throw new Error(`Unexpected ZAI task ${kind}`);
    });
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["script-draft", "role-audit"], { "script-draft": "gpt-writer" }),
      zaiCodexSettings: settings("zai", ["script-draft"], { "script-draft": "glm-writer" }),
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
    assert.deepEqual(openai.calls, ["script-draft", "role-audit"]);
    assert.deepEqual(zai.calls, ["script-draft"]);
    assert.equal(execution.trace?.modelId, "glm-writer");
    assert.equal(execution.trace?.fallbackFromModelId, "gpt-writer");
    assert.deepEqual(execution.trace?.attemptedModelIds, ["gpt-writer", "glm-writer"]);
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
      zaiCodexSettings: settings("zai", ["visual-review"], { "visual-review": "glm-review" }),
      codexClient: openai,
      zaiCodexClient: zai,
      reviewMedia,
      environment: {},
    });

    const execution = await result.visualReviewAgents[0]?.reviewDetailed?.({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
    });

    assert.ok(execution);
    assert.deepEqual(zai.calls, ["visual-review"]);
    assert.deepEqual(openai.calls, ["visual-review", "role-audit"]);
    assert.equal(execution.executedModelId, "gpt-review");
    assert.equal(execution.fallbackFromProviderId, "zai-bigmodel-api");
    assert.deepEqual(execution.attemptedModelIds, ["glm-review", "gpt-review"]);
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

  it("uses ZAI for production roles only when an independent OpenAI auditor exists", () => {
    const result = buildRoleAgentAssembly({
      codexSettings: settings("openai", ["role-audit"], { "role-audit": "gpt-auditor" }),
      zaiCodexSettings: settings("zai", ["script-draft", "director-plan", "visual-review"], {
        "script-draft": "glm-writer",
        "director-plan": "glm-director",
        "visual-review": "glm-review",
      }),
      codexClient: client,
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
