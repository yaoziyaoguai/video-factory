import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProductionTemplate } from "../src/index.js";
import { validTemplate } from "./template-test-data.js";

describe("parseProductionTemplate", () => {
  it("validates references, capability requirements, and bounded costs", () => {
    assert.throws(
      () => parseProductionTemplate({
        ...validTemplate(),
        shotSlots: [{
          id: "shot-1",
          beatId: "missing",
          purpose: "开场",
          durationSeconds: 3,
          allowedCapabilities: ["asset.search"],
          manualReplacement: true,
        }],
      }),
      /unknown beatId/,
    );

    assert.throws(
      () => parseProductionTemplate({
        ...validTemplate(),
        capabilityRequirements: [{ capability: "", required: true }],
      }),
      /capabilityRequirements/,
    );

    assert.throws(
      () => parseProductionTemplate({
        ...validTemplate(),
        costPolicy: { currency: "CNY", maxCost: -1, maxPaidShots: 0 },
      }),
      /costPolicy.maxCost/,
    );
  });

  it("returns deeply frozen published versions while drafts stay editable", () => {
    const published = parseProductionTemplate(validTemplate());
    assert.equal(Object.isFrozen(published), true);
    assert.equal(Object.isFrozen(published.storyStructure), true);
    assert.equal(Object.isFrozen(published.storyStructure[0]), true);
    assert.throws(() => {
      (published.storyStructure[0] as { label: string }).label = "被覆盖";
    }, TypeError);

    const draft = parseProductionTemplate({ ...validTemplate(), status: "draft" });
    assert.equal(Object.isFrozen(draft), false);
  });
});
