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
      assert.ok(template.shotSlots.length >= template.storyStructure.length);
      assert.ok(template.shotSlots.length >= 4);
      assert.ok(template.shotSlots.every((slot) => slot.durationSeconds <= 5));
      assert.ok(template.shotSlots.every((slot) => slot.allowedCapabilities.includes("asset.search")));
      assert.ok(template.qualityRules.length >= 3);
      assert.equal(template.qualityRules.some((rule) => rule.label === "模板核心质量"), false);
      assert.equal(template.shotSlots.some((slot) => /建立具体画面|展示动作或变化|补充关键细节|用结果或反应兑现/.test(slot.purpose)), false);
      assert.ok(template.capabilityRequirements.every((requirement) => !requirement.capability.includes("provider")));
      assert.equal("providerId" in template, false);
      assert.equal("costPolicy" in template, false);
    }
    assert.equal(new Set(BUILTIN_TEMPLATES.map((template) => template.shotSlots.map((slot) => slot.purpose).join("|"))).size, 6);
  });

  it("does not treat generated media as equivalent evidence in real-world proof templates", () => {
    for (const template of BUILTIN_TEMPLATES.filter((candidate) => candidate.id !== "knowledge-explainer")) {
      assert.ok(template.shotSlots.every((slot) => !slot.allowedCapabilities.some((capability) => capability.startsWith("asset.generate."))));
    }
    const knowledge = BUILTIN_TEMPLATES.find((candidate) => candidate.id === "knowledge-explainer")!;
    assert.deepEqual(knowledge.shotSlots.find((slot) => slot.id === "knowledge-evidence")?.allowedCapabilities, ["asset.search"]);
    assert.ok(knowledge.shotSlots.find((slot) => slot.id === "knowledge-mechanism")?.allowedCapabilities.includes("asset.generate.video"));
  });

  it("maps every template sound system to one calibrated actor and delivery preset", () => {
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
      assert.equal(
        applyTemplateVoiceRecommendation(template, baseDirection).profileId,
        voicePresetForTemplate(template).preferredProfileIds[0],
      );
    }
    assert.deepEqual(
      applyTemplateVoiceRecommendation(BUILTIN_TEMPLATES.find((template) => template.id === "ranked-comparison")!, baseDirection),
      { profileId: "minimax:Chinese (Mandarin)_News_Anchor", rate: 205, pauseScale: 0.9, masteringPreset: "social" },
    );
  });

  it("keeps generated knowledge-explainer source images text-free", () => {
    const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === "knowledge-explainer")!;
    const exampleSetup = template.shotSlots.find((slot) => slot.id === "knowledge-mechanism")!;
    const legibilityRule = template.qualityRules.find((rule) => rule.id === "knowledge-legible")!;

    assert.match(exampleSetup.purpose, /无字/);
    assert.match(exampleSetup.purpose, /生成画面只作示意/);
    assert.match(legibilityRule.label, /生成母图不得绘制文字/);
    assert.match(legibilityRule.label, /后期字幕|确定性图形/);
  });

  it("publishes a less mechanical knowledge-explainer revision without pretending generated scenes prove causality", () => {
    const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === "knowledge-explainer")!;

    assert.equal(template.version, 4);
    assert.equal(template.shotSlots.length, 5);
    assert.equal(template.shotSlots.some((slot) => /只改变一个变量|真实案例/.test(slot.purpose)), false);
    assert.match(template.description, /理解|应用/);
    assert.equal(template.qualityRules.some((rule) => /例子必须真正验证|证明因果/.test(rule.label)), false);
    assert.match(template.qualityRules.map((rule) => rule.label).join("\n"), /示意.*事实证据|事实证据.*示意/);
  });
});
