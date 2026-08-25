import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OllamaVisualDirectorAgent } from "../src/index.js";

describe("OllamaVisualDirectorAgent", () => {
  it("requests a structured per-shot plan from the selected director role", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const expected = {
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
    const agent = new OllamaVisualDirectorAgent({
      model: "qwen3:8b",
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ message: { content: JSON.stringify(expected) } }), { status: 200 });
      },
    });

    const result = await agent.plan({
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
    });

    assert.deepEqual(result, expected);
    assert.equal(requestBody?.model, "qwen3:8b");
    assert.equal(requestBody?.format instanceof Object, true);
    const messages = requestBody?.messages as Array<{ content: string }>;
    assert.match(messages[0]!.content, /导演不是素材配方/);
    assert.match(messages[0]!.content, /不能满足.*真实人物.*动作.*地点.*环境/);
    assert.match(messages[0]!.content, /通用图库.*具体事件.*证据/);
    assert.match(messages[0]!.content, /不得作为事实证据/);
    assert.match(messages[0]!.content, /不设.*配额/);
    assert.match(messages[1]!.content, /urban-poetic/);
    assert.match(messages[1]!.content, /不包含真实人物动作或现场环境/);
    const userContext = JSON.parse(messages[1]!.content) as {
      directorProfiles: Array<{ id: string; narrative: string; composition: string; bestFor: string[] }>;
    };
    const selectedProfile = userContext.directorProfiles.find((profile) => profile.id === "urban-poetic");
    assert.match(selectedProfile?.narrative ?? "", /人物感受/);
    assert.match(selectedProfile?.composition ?? "", /偏置构图/);
    assert.ok(selectedProfile?.bestFor.includes("都市情绪"));
  });
});
