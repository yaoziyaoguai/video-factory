import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "../src/codex-executor.js";
import {
  BROKER_TASK_KINDS,
  outputSchemaFor,
  outputValidationErrorFor,
  taskPromptFor,
} from "../src/task-definitions.js";

describe("broker-owned task definitions", () => {
  it("pins protocol v2 and owns prompts for every allowed task kind", () => {
    assert.equal(CODEX_BRIDGE_PROTOCOL_VERSION, "video-factory/codex-bridge-v2");
    assert.deepEqual(BROKER_TASK_KINDS, [
      "topic-ideas",
      "director-plan",
      "script-draft",
      "publish-copy",
      "visual-review",
    ]);

    assert.match(taskPromptFor("topic-ideas").directive, /中文短视频选题总编/);
    assert.match(taskPromptFor("director-plan").directive, /导演不是素材配方/);
    assert.match(taskPromptFor("script-draft").directive, /短视频平台的创意编剧/);
    assert.match(taskPromptFor("publish-copy", "douyin").directive, /抖音/);
    assert.match(taskPromptFor("visual-review").directive, /视觉审片/);
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
    assert.equal(director.version, "video-factory/director-v4");
    assert.equal(review.version, "video-factory/visual-review-v3");
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
    assert.match(director.directive, /onScreenText.*soundCue/);
    assert.match(review.directive, /脚本.*导演意图/);
    assert.match(review.directive, /逐场核对/);
    assert.ok(script.examples.some((example) => /反例/.test(example)));
    assert.ok(director.examples.some((example) => /\[0s-2s\]/.test(example)));
  });

  it("owns a strict output schema for every allowed task kind", () => {
    const requiredByKind = new Map([
      ["topic-ideas", ["ideas"]],
      ["director-plan", ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]],
      ["script-draft", ["viewerPromise", "narrativeArc", "scenes"]],
      ["publish-copy", ["title", "description", "hashtags"]],
      ["visual-review", ["version", "summary", "scores", "findings", "confidence", "recommendation"]],
    ] as const);

    for (const kind of BROKER_TASK_KINDS) {
      const schema = outputSchemaFor(kind) as { additionalProperties?: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, requiredByKind.get(kind));
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

    assert.deepEqual(scriptSchema.required, ["viewerPromise", "narrativeArc", "scenes"]);
    assert.ok(scriptSchema.properties.scenes.items.required.includes("visible_action"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("success_criteria"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("failure_conditions"));
    assert.ok(directorSchema.properties.shots.items.required.includes("temporalBeats"));
    assert.ok(directorSchema.properties.shots.items.required.includes("negativeConstraints"));
    assert.ok(directorSchema.properties.shots.items.required.includes("successCriteria"));
    assert.ok(directorSchema.properties.shots.items.required.includes("deliveryType"));
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
});
