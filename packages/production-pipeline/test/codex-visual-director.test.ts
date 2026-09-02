import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskExecution, type CodexTaskKind } from "../src/codex-chat.js";
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
    scenes: [{
      position: 1,
      narration: "夜晚开始了",
      duration: 5,
      visualPrompt: "雨夜城市",
      visualStrategy: "local",
      visibleAction: "标题逐行出现",
      onScreenText: "下班后的城市",
      soundCue: "雨声渐入",
      successCriteria: ["标题可读"],
      failureConditions: ["出现虚构人物"],
      searchTerms: [],
    }],
    assetProviders: [{
      id: "local-editorial-v1",
      label: "本地",
      billing: "free",
      modes: ["本地"],
      deliveryTypes: ["editorial_card"],
      strengths: ["标题卡、数据卡与清单步骤"],
      constraints: ["不包含真实人物动作或现场环境"],
      estimatedCnyPerClip: 0,
    }],
    economics: { allowMeteredProviders: false },
  };
}

function validPlan(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "urban-poetic",
    resolvedProfileId: "urban-poetic",
    profileRationale: "都市夜景与人物情绪适配。",
    visualBible: {
      viewerPromise: "看见夜晚如何改变人的行动节奏。",
      narrativeApproach: "碎片化观察",
      motif: "反光路面与暖色窗光",
      pacing: "短促后停顿",
      composition: "偏置近景",
      camera: "缓慢横移",
      color: "霓虹综合色",
      continuity: "同一雨夜",
      transitionGrammar: "用动作方向和光源匹配切换",
      sound: "环境声与低频音乐",
      antiPatterns: ["静态卡片超过三秒", "无人物动机的霓虹空镜"],
    },
    shots: [{
      scenePosition: 1,
      narrativeRole: "情绪钩子",
      authenticityPolicy: "expressive",
      preferredProviderId: "local-editorial-v1",
      deliveryType: "editorial_card",
      alternativeProviderIds: [],
      subject: "下班后停在便利店门口的上班族",
      environment: "雨夜街角与便利店暖光",
      visibleAction: "人物收起雨伞并抬头看向店内",
      temporalBeats: ["[0s-2s] 雨伞占据前景，人物进入", "[2s-5s] 收伞并抬头，暖光落在脸侧"],
      shotSize: "中近景",
      camera: "轻微手持跟进后稳定",
      lighting: "冷色雨夜环境光与暖色店内光对照",
      negativeConstraints: ["不出现文字水印", "不改变人物服装"],
      referenceRequirements: [],
      successCriteria: ["能看见完整收伞动作", "冷暖光关系清晰"],
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
  it("requires an independent role audit before returning a detailed plan", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    const client = new class extends CodexBridgeClient {
      constructor() { super({ socketPath: "/nonexistent/vf-codex.sock" }); }
      async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
        calls.push({ kind, payload });
        return {
          output: kind === "director-plan" ? validPlan() : {
            version: "video-factory/role-audit-v1",
            verdict: "pass",
            score: 94,
            summary: "逐镜方案可执行。",
            issues: [],
            repairInstructions: [],
          },
          trace: {
            taskKind: kind,
            promptVersion: `test/${kind}`,
            prompt: `prompt:${kind}`,
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          },
        };
      }
    }();
    const agent = new CodexVisualDirectorAgent({ client, maxReviewIterations: 2 });

    const execution = await agent.planDetailed(directorInput());

    assert.equal(execution.agentLoop?.status, "passed");
    assert.deepEqual(calls.map(({ kind }) => kind), ["director-plan", "role-audit"]);
    const auditPayload = calls[1]!.payload as {
      context: {
        upstreamFacts: { scenes: Array<Record<string, unknown>> };
        currentRoleContract: Record<string, unknown>;
      };
    };
    const contract = auditPayload.context.currentRoleContract;
    assert.equal("directorProfiles" in contract, false);
    assert.deepEqual(contract.availableDirectorProfileIds, [
      "documentary-observer",
      "quiet-humanism",
      "urban-poetic",
      "chromatic-storytelling",
      "geometric-control",
      "suspense-staging",
    ]);
    assert.equal((contract.selectedDirectorProfile as { id: string }).id, "urban-poetic");
    assert.deepEqual(Object.keys(auditPayload.context.upstreamFacts.scenes[0]!).sort(), [
      "duration",
      "failureConditions",
      "narration",
      "onScreenText",
      "position",
      "soundCue",
      "successCriteria",
      "visibleAction",
      "visualPrompt",
      "visualStrategy",
    ]);
  });

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

  it("rejects element animation assigned to a static editorial card", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.subject = "静态状态卡";
    shot.visibleAction = "灰色圆点同步变为绿色对勾";
    shot.temporalBeats = ["[0s-2s] 三项显示灰色圆点", "[2s-5s] 三个圆点同步变为绿色对勾"];
    shot.generationPrompt = "三行灰色圆点同步变为绿色对勾";
    shot.rationale = "本地卡片适合清单表达。";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /unsupported element animation/);
  });

  it("rejects a shot whose rationale admits the selected provider cannot execute it", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.visibleAction = "所有元素从首帧完整存在，整张卡片轻微推近";
    shot.temporalBeats = ["[0s-2s] 全部元素完整存在", "[2s-5s] 整张卡片轻微推近"];
    shot.generationPrompt = "静态卡片只做整张画面轻微推近";
    shot.rationale = "当前 Provider 缺少元素动画能力，需补充可执行 Provider 后生产。";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /selected provider cannot execute/);
  });

  it("rejects plans that do not cover every scene exactly once", async () => {
    const input = directorInput();
    input.scenes = [
      ...input.scenes,
      {
        position: 2,
        narration: "第二幕",
        duration: 5,
        visualPrompt: "便利店灯箱",
        visualStrategy: "stock",
        visibleAction: "人物走进便利店",
        successCriteria: ["动作完整"],
        failureConditions: ["只有静态文字"],
        searchTerms: ["便利店", "夜晚"],
      },
    ];
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });

    await assert.rejects(() => agent.plan(input), /must cover every script scene exactly once/);
  });

  it("rejects evidence shots routed to a generated delivery provider", async () => {
    const input = directorInput();
    input.assetProviders.push({
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "free",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 0,
    });
    const generatedPlan = validPlan();
    const generatedShot = (generatedPlan.shots as Array<Record<string, unknown>>)[0]!;
    generatedShot.authenticityPolicy = "evidence";
    generatedShot.preferredProviderId = "seedream-image-v1";
    generatedShot.deliveryType = "generated_image";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => generatedPlan) });

    await assert.rejects(() => agent.plan(input), /evidence shot.*generative provider/);
  });

  it("keeps the historical provider id for persisted briefs", () => {
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });
    assert.equal(agent.id, "api-visual-director-v1");
  });
});
