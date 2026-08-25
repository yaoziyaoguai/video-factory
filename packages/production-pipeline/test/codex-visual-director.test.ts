import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskKind } from "../src/codex-chat.js";
import { CodexVisualDirectorAgent } from "../src/codex-visual-director.js";
import type { VisualDirectorAgentInput } from "../src/visual-director.js";

class CapturingCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(public respond: () => unknown) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTask(kind: CodexTaskKind, payload: unknown): Promise<unknown> {
    this.calls.push({ kind, payload });
    return this.respond();
  }
}

function directorInput(): VisualDirectorAgentInput {
  return {
    brief: {
      title: "下班后的城市为什么让人舍不得回家",
      angle: "都市夜晚的情绪空间",
      audience: "城市上班族",
      platform: "douyin",
      durationSeconds: 24,
      requestedProfileId: "urban-poetic",
    },
    scenes: [{ position: 1, narration: "夜晚开始了", duration: 5, visualPrompt: "雨夜城市" }],
    assetProviders: [{
      id: "local-editorial-v1",
      label: "本地",
      billing: "free",
      modes: ["本地"],
      strengths: ["标题卡、数据卡与清单步骤"],
      constraints: ["不包含真实人物动作或现场环境"],
      estimatedCnyPerClip: 0,
    }],
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
  };
}

function validPlan(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "urban-poetic",
    resolvedProfileId: "urban-poetic",
    profileRationale: "都市夜景与人物情绪适配。",
    visualBible: {
      narrativeApproach: "碎片化观察",
      pacing: "短促后停顿",
      composition: "偏置近景",
      camera: "缓慢横移",
      color: "霓虹综合色",
      continuity: "同一雨夜",
      sound: "环境声与低频音乐",
    },
    shots: [{
      scenePosition: 1,
      narrativeRole: "情绪钩子",
      authenticityPolicy: "expressive",
      preferredProviderId: "local-editorial-v1",
      alternativeProviderIds: [],
      query: "雨夜 城市 人物",
      generationPrompt: "雨夜城市人物近景",
      rationale: "适合情绪表达。",
      continuityNote: "保持雨夜。",
      confidence: 0.8,
      estimatedCostCny: 0,
    }],
  };
}

describe("CodexVisualDirectorAgent", () => {
  it("sends the director-plan payload and returns the validated plan", async () => {
    const codexClient = new CapturingCodexClient(() => validPlan());
    const agent = new CodexVisualDirectorAgent({ client: codexClient });
    const input = directorInput();

    const result = await agent.plan(input);

    assert.deepEqual(result, validPlan());
    assert.equal(agent.id, "api-visual-director-v1");
    assert.equal(codexClient.calls.length, 1);
    assert.equal(codexClient.calls[0]?.kind, "director-plan");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.equal("directive" in payload, false);
    assert.equal("task" in payload, false);
    assert.equal("outputContract" in payload, false);
    const profiles = payload.directorProfiles as Array<{ id: string }>;
    assert.equal(profiles.length, 6);
    assert.equal(profiles[0]?.id, "documentary-observer");
    assert.deepEqual(payload.brief, input.brief);
    assert.deepEqual(payload.scenes, input.scenes);
    assert.deepEqual(payload.assetProviders, input.assetProviders);
    assert.deepEqual(payload.economics, input.economics);
  });

  it("rejects malformed or incomplete plans without any fallback", async () => {
    const codexClient = new CapturingCodexClient(() => ({}));
    const agent = new CodexVisualDirectorAgent({ client: codexClient });

    await assert.rejects(() => agent.plan(directorInput()), /Director plan version must be/);

    codexClient.respond = () => null;
    await assert.rejects(() => agent.plan(directorInput()), /Director plan must be an object/);

    codexClient.respond = () => ({ version: "video-factory/director-plan-v1" });
    await assert.rejects(() => agent.plan(directorInput()), /requestedProfileId/);
    assert.equal(codexClient.calls.length, 3);
  });

  it("rejects plans that reference a provider outside the allowlist", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.preferredProviderId = "pexels-stock-v1";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /not in the enabled asset pool/);
  });

  it("rejects plans that do not cover every scene exactly once", async () => {
    const input = directorInput();
    input.scenes = [
      ...input.scenes,
      { position: 2, narration: "第二幕", duration: 5, visualPrompt: "便利店灯箱" },
    ];
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });

    await assert.rejects(() => agent.plan(input), /must cover every script scene exactly once/);
  });

  it("keeps the historical provider id for persisted briefs", () => {
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });
    assert.equal(agent.id, "api-visual-director-v1");
  });
});
