import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";

describe("template catalog", () => {
  it("ships six distinct production grammars without locking providers", () => {
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
    for (const template of BUILTIN_TEMPLATES) {
      assert.equal(template.status, "published");
      assert.ok(template.storyStructure.length >= 3);
      assert.ok(template.shotSlots.length > template.storyStructure.length);
      assert.ok(template.shotSlots.length >= 6);
      assert.ok(template.shotSlots.every((slot) => slot.durationSeconds <= 5));
      assert.ok(template.shotSlots.every((slot) => slot.allowedCapabilities.includes("asset.generate.video")));
      assert.ok(template.capabilityRequirements.every((requirement) => !requirement.capability.includes("provider")));
      assert.equal("providerId" in template, false);
    }
  });
});
