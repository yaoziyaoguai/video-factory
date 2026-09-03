import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";

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
});
