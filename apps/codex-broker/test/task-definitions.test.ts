import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "../src/codex-executor.js";
import {
  BROKER_TASK_KINDS,
  outputSchemaFor,
  outputValidationErrorFor,
  taskPromptFor,
} from "../src/task-definitions.js";

function validDirectorPlan() {
  const shot = {
    scenePosition: 1,
    narrativeRole: "hook",
    authenticityPolicy: "illustrative",
    preferredProviderId: "pexels-stock-v1",
    deliveryType: "stock_video",
    alternativeProviderIds: ["pixabay-stock-v1"],
    subject: "手机用户",
    environment: "室内",
    visibleAction: "拇指向上滑动",
    temporalBeats: ["[0s-1s] 观看", "[1s-2s] 上滑"],
    shotSize: "近景",
    camera: "固定机位",
    lighting: "自然侧光",
    negativeConstraints: ["无品牌"],
    referenceRequirements: [],
    successCriteria: ["完整看见一次上滑"],
    query: "hand swipe smartphone",
    generationPrompt: "手机用户在自然侧光的室内完成一次清楚的向上滑动，固定近景",
    rationale: "常见单一动作适合图库检索",
    continuityNote: "承接上一镜",
    confidence: 0.8,
    estimatedCostCny: 0,
  };
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "生活观察题材",
    visualBible: {
      viewerPromise: "给出清楚判断",
      narrativeApproach: "问题到结论",
      motif: "手机动作",
      pacing: "短促",
      composition: "竖屏近景",
      camera: "固定为主",
      color: "自然色",
      continuity: "同一手部方向",
      transitionGrammar: "动作切",
      sound: "真实环境声",
      antiPatterns: ["空泛氛围镜头"],
    },
    shots: [shot, { ...shot, scenePosition: 2, query: "video editing timeline" }],
  };
}

function assertStrictObjectRequirements(schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    const properties = typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)
      ? record.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(record.required) ? record.required : [];
    assert.deepEqual(
      [...required].sort(),
      Object.keys(properties).sort(),
      `${path} must require every declared property for strict structured outputs`,
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrictObjectRequirements(child, `${path}.${key}`);
    }
  }
  if (record.type === "array") assertStrictObjectRequirements(record.items, `${path}[]`);
}

describe("broker-owned task definitions", () => {
  it("pins protocol v2 and owns prompts for every allowed task kind", () => {
    assert.equal(CODEX_BRIDGE_PROTOCOL_VERSION, "video-factory/codex-bridge-v2");
    assert.deepEqual(BROKER_TASK_KINDS, [
      "topic-ideas",
      "series-roadmap",
      "director-plan",
      "script-draft",
      "publish-copy",
      "asset-rank",
      "reference-grammar",
      "visual-review",
      "role-audit",
    ]);

    assert.match(taskPromptFor("topic-ideas").directive, /中文短视频选题总编/);
    assert.match(taskPromptFor("series-roadmap").directive, /系列总编兼 showrunner/);
    assert.match(taskPromptFor("director-plan").directive, /导演不是素材配方/);
    assert.match(taskPromptFor("script-draft").directive, /短视频平台的创意编剧/);
    assert.match(taskPromptFor("publish-copy", "douyin").directive, /抖音/);
    assert.match(taskPromptFor("asset-rank").directive, /语义选片师/);
    assert.match(taskPromptFor("reference-grammar").directive, /参考视频分析师/);
    assert.match(taskPromptFor("visual-review").directive, /视觉审片/);
    assert.match(taskPromptFor("role-audit").directive, /独立于生产角色的红队审计 Agent/);
    assert.match(taskPromptFor("role-audit").directive, /不得发明输入中不存在的验收要求/);
    assert.match(taskPromptFor("role-audit").directive, /不得把下游节点尚未产出的证据/);
    assert.match(taskPromptFor("role-audit").directive, /上一轮审计/);
    assert.match(
      taskPromptFor("visual-review").outputRules.join("\n"),
      /version 必须固定为 video-factory\/visual-review-v1/,
    );
    assert.match(taskPromptFor("visual-review").outputRules.join("\n"), /severity 只能是 info、warning、critical/);

    const neutral = taskPromptFor("publish-copy", "somewhere-else").directive;
    assert.match(neutral, /中性/);
    assert.doesNotMatch(neutral, /抖音/);
  });

  it("pins prompt-pack versions and production-quality role contracts", () => {
    const topic = taskPromptFor("topic-ideas");
    const script = taskPromptFor("script-draft");
    const director = taskPromptFor("director-plan");
    const review = taskPromptFor("visual-review");

    assert.equal(topic.version, "video-factory/topic-editor-v2");
    assert.equal(script.version, "video-factory/screenwriter-v4");
    assert.equal(director.version, "video-factory/director-v6");
    assert.equal(review.version, "video-factory/visual-review-v4");
    assert.match(topic.directive, /值得做视频/);
    assert.match(script.directive, /观众承诺/);
    assert.match(script.directive, /5 到 24/);
    assert.match(script.directive, /每秒约 2 到 6 个汉字/);
    assert.match(script.directive, /成功条件/);
    assert.match(director.directive, /逐秒动作/);
    assert.match(director.directive, /负面约束/);
    assert.match(director.directive, /Provider Compiler/);
    assert.match(director.directive, /deliveryType/);
    assert.match(director.directive, /未列出自有素材库存/);
    assert.match(director.directive, /只交付一张静态卡片/);
    assert.match(director.directive, /图库是检索而不是生成/);
    assert.match(director.directive, /3 到 8 个具体英文概念/);
    assert.match(director.directive, /onScreenText.*soundCue/);
    assert.match(review.directive, /脚本.*导演意图/);
    assert.match(review.directive, /逐场核对/);
    assert.match(review.directive, /scene_triplets.*opening.*middle.*closing/);
    assert.match(review.directive, /hook_and_scene_midpoints.*scene_change_keyframes/);
    assert.match(review.directive, /稀疏证据/);
    assert.match(review.directive, /不得仅因此自动给出 revise/);
    assert.ok(script.examples.some((example) => /反例/.test(example)));
    assert.ok(director.examples.some((example) => /\[0s-2s\]/.test(example)));
  });

  it("owns a strict output schema for every allowed task kind", () => {
    const requiredByKind = new Map([
      ["topic-ideas", ["ideas"]],
      ["series-roadmap", ["episodes"]],
      ["director-plan", ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]],
      ["script-draft", ["viewerPromise", "narrativeArc", "canonFacts", "scenes"]],
      ["publish-copy", ["title", "description", "hashtags"]],
      ["asset-rank", ["version", "source", "providerId", "modelId", "summary", "scenes"]],
      ["reference-grammar", ["version", "summary", "durationMs", "pacing", "composition", "camera", "color", "transitions", "sound", "beats", "reusableRules", "avoidCopying", "confidence"]],
      ["visual-review", ["version", "summary", "scores", "findings", "confidence", "recommendation"]],
      ["role-audit", ["version", "verdict", "score", "summary", "issues", "repairInstructions"]],
    ] as const);

    for (const kind of BROKER_TASK_KINDS) {
      const schema = outputSchemaFor(kind) as { additionalProperties?: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, requiredByKind.get(kind));
    }
  });

  it("keeps every response schema compatible with strict OpenAI structured outputs", () => {
    for (const kind of BROKER_TASK_KINDS) {
      assertStrictObjectRequirements(outputSchemaFor(kind), kind);
    }
  });

  it("requires inspectable shot intent instead of accepting generic scene prose", () => {
    const scriptSchema = outputSchemaFor("script-draft") as {
      required: string[];
      properties: { scenes: { items: { required: string[] } } };
    };
    const directorSchema = outputSchemaFor("director-plan") as {
      properties: { shots: { items: { required: string[] } } };
    };

    assert.deepEqual(scriptSchema.required, ["viewerPromise", "narrativeArc", "canonFacts", "scenes"]);
    assert.ok(scriptSchema.properties.scenes.items.required.includes("visible_action"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("success_criteria"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("failure_conditions"));
    assert.ok(directorSchema.properties.shots.items.required.includes("temporalBeats"));
    assert.ok(directorSchema.properties.shots.items.required.includes("negativeConstraints"));
    assert.ok(directorSchema.properties.shots.items.required.includes("successCriteria"));
    assert.ok(directorSchema.properties.shots.items.required.includes("deliveryType"));
  });

  it("rejects blank director execution prompts before they reach the production pipeline", () => {
    const invalidDirector = validDirectorPlan();
    invalidDirector.shots[0]!.generationPrompt = "";

    assert.match(
      outputValidationErrorFor("director-plan", invalidDirector) ?? "",
      /generationPrompt.*shorter than 1 character/,
    );
  });

  it("validates nested visual-review output fields at runtime", () => {
    const valid = {
      version: "video-factory/visual-review-v1",
      summary: "画面清晰。",
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [],
      confidence: 0.9,
      recommendation: "approve",
    };
    assert.equal(outputValidationErrorFor("visual-review", valid), undefined);

    const invalidCases = [
      { ...valid, scores: { ...valid.scores, extra: 1 } },
      { ...valid, scores: { ...valid.scores, pacing: 90.5 } },
      { ...valid, confidence: 1.1 },
      { ...valid, recommendation: "maybe" },
      {
        ...valid,
        findings: [{
          timecodeMs: 0,
          category: "unknown",
          severity: "warning",
          description: "问题",
          suggestion: "建议",
        }],
      },
    ];
    for (const output of invalidCases) {
      assert.equal(typeof outputValidationErrorFor("visual-review", output), "string");
    }
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      scores: { ...valid.scores, pacing: 59 },
    }) ?? "", /cannot approve/);
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      findings: [{
        timecodeMs: 100,
        category: "continuity",
        severity: "warning",
        description: "镜头重复",
        suggestion: "更换素材",
      }],
    }) ?? "", /cannot approve/);
  });

  it("rejects broken scene ordering and duplicate director routes", () => {
    const scriptSchema = outputSchemaFor("script-draft") as {
      properties: { scenes: { items: Record<string, unknown> } };
    };
    const scene = {
      position: 1,
      purpose: "提出问题",
      narration: "为什么越长不一定越好？",
      duration: 2,
      visual_strategy: "stock",
      visual_prompt: "手指滑过视频时间线",
      visible_action: "手指从左向右拖动片段",
      on_screen_text: "越长越好吗",
      sound_cue: "短促点击声",
      success_criteria: ["片段长度发生变化"],
      failure_conditions: ["看不到拖动动作"],
      search_terms: ["视频剪辑"],
    };
    assert.ok(scriptSchema.properties.scenes.items);
    assert.match(outputValidationErrorFor("script-draft", {
      viewerPromise: "给出一个可执行判断",
      narrativeArc: "问题、例子、结论",
      canonFacts: [],
      scenes: Array.from({ length: 5 }, (_, index) => ({
        ...scene,
        position: index === 3 ? 5 : index + 1,
      })),
    }) ?? "", /without gaps/);

    const validDirector = validDirectorPlan();
    validDirector.shots[1]!.scenePosition = 1;
    assert.match(outputValidationErrorFor("director-plan", validDirector) ?? "", /duplicates scene 1/);
  });

  it("requires integer 0-100 topic scores", () => {
    const valid = {
      ideas: [{
        signalId: "signal-1",
        track: "life-observation",
        title: "选题",
        audience: "城市上班族",
        painPoint: "下班后仍然疲惫",
        hook: "钩子",
        rationale: "理由",
        novelty: 80,
        seriesPotential: 70,
        monetization: 60,
      }],
    };
    assert.equal(outputValidationErrorFor("topic-ideas", valid), undefined);
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], novelty: 80.5 }],
    }), "string");
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], monetization: 101 }],
    }), "string");
  });

  it("requires a contiguous, strictly structured series roadmap", () => {
    const episode = {
      episodeNumber: 3,
      pillar: "真实实验",
      title: "验证一个真实任务",
      viewerPromise: "得到一个可执行结论",
      hook: "先看真实结果。",
      payoff: "完成实验并给出结论。",
      fromPrevious: ["承接已定版结论"],
      toNext: ["留下成本问题"],
    };
    assert.equal(outputValidationErrorFor("series-roadmap", { episodes: [episode, { ...episode, episodeNumber: 4, title: "核算成本" }] }), undefined);
    assert.match(outputValidationErrorFor("series-roadmap", { episodes: [episode, { ...episode, episodeNumber: 5, title: "核算成本" }] }) ?? "", /contiguous/);
    assert.equal(typeof outputValidationErrorFor("series-roadmap", { episodes: [{ ...episode, canon: "planned fact" }] }), "string");
  });
});
