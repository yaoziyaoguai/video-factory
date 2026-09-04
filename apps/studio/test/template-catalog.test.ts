import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";
import { applyTemplateVoiceRecommendation, voicePresetForTemplate } from "../src/shared/template-voice-recommendation.js";

describe("template catalog", () => {
  it("ships six authored production grammars with distinct shot language and strict quality gates", () => {
    assert.equal(BUILTIN_TEMPLATES.length, 6);
    assert.deepEqual(BUILTIN_TEMPLATES.map((template) => template.id), [
      "trend-fact-brief",
      "knowledge-explainer",
      "photo-story",
      "product-demo",
      "human-mini-doc",
      "ranked-comparison",
    ]);
    assert.equal(new Set(BUILTIN_TEMPLATES.map((template) => template.category)).size, 6);
    assert.equal(BUILTIN_TEMPLATES.find((template) => template.id === "photo-story")?.name, "证据图解");
    for (const template of BUILTIN_TEMPLATES) {
      assert.equal(template.status, "published");
      assert.ok(template.storyStructure.length >= 3);
      assert.ok(template.shotSlots.length > template.storyStructure.length);
      assert.ok(template.shotSlots.length >= 6);
      assert.ok(template.shotSlots.every((slot) => slot.durationSeconds <= 5));
      assert.ok(template.shotSlots.every((slot) => slot.allowedCapabilities.includes("asset.generate.video")));
      assert.ok(template.qualityRules.length >= 3);
      assert.equal(template.qualityRules.some((rule) => rule.label === "模板核心质量"), false);
      assert.equal(template.shotSlots.some((slot) => /建立具体画面|展示动作或变化|补充关键细节|用结果或反应兑现/.test(slot.purpose)), false);
      assert.ok(template.capabilityRequirements.every((requirement) => !requirement.capability.includes("provider")));
      assert.equal("providerId" in template, false);
      assert.equal("costPolicy" in template, false);
    }
    assert.equal(new Set(BUILTIN_TEMPLATES.map((template) => template.shotSlots.map((slot) => slot.purpose).join("|"))).size, 6);
  });

  it("maps every template sound system to one calibrated voice preset without replacing the actor", () => {
    const expected = new Map([
      ["trend-fact-brief", "news"],
      ["knowledge-explainer", "explainer"],
      ["photo-story", "explainer"],
      ["product-demo", "news"],
      ["human-mini-doc", "documentary"],
      ["ranked-comparison", "news"],
    ]);
    const baseDirection = { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const };

    for (const template of BUILTIN_TEMPLATES) {
      assert.equal(voicePresetForTemplate(template).id, expected.get(template.id));
      assert.equal(applyTemplateVoiceRecommendation(template, baseDirection).profileId, "macos:Tingting");
    }
    assert.deepEqual(
      applyTemplateVoiceRecommendation(BUILTIN_TEMPLATES.find((template) => template.id === "ranked-comparison")!, baseDirection),
      { profileId: "macos:Tingting", rate: 205, pauseScale: 0.9, masteringPreset: "social" },
    );
  });

  it("keeps generated knowledge-explainer source images text-free", () => {
    const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === "knowledge-explainer")!;
    const exampleSetup = template.shotSlots.find((slot) => slot.id === "knowledge-example-setup")!;
    const legibilityRule = template.qualityRules.find((rule) => rule.id === "knowledge-legible")!;

    assert.match(exampleSetup.purpose, /无字母图/);
    assert.match(exampleSetup.purpose, /后期字幕|确定性图形/);
    assert.match(legibilityRule.label, /生成母图不得绘制文字/);
    assert.match(legibilityRule.label, /后期字幕|确定性图形/);
  });
});
