import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProductionTemplateSnapshot, resolveTemplateSnapshot } from "../src/index.js";
import { validTemplate } from "./template-test-data.js";

describe("resolveTemplateSnapshot", () => {
  it("applies layers in documented precedence and records explainable sources", () => {
    const template = validTemplate();
    const snapshot = resolveTemplateSnapshot({
      template,
      resolvedAt: "2026-08-27T10:00:00.000Z",
      systemDefaults: { platform: "douyin", durationSeconds: 30, automationLevel: "assisted" },
      platformProfile: { durationSeconds: 45 },
      seriesBible: { automationLevel: "automatic" },
      runOverrides: { durationSeconds: 38 },
    });

    assert.equal(snapshot.resolvedBlueprint.platform, "douyin");
    assert.equal(snapshot.resolvedBlueprint.durationSeconds, 38);
    assert.equal(snapshot.resolvedBlueprint.automationLevel, "automatic");
    assert.deepEqual(snapshot.sourceLayers.map((layer) => layer.layer), [
      "system",
      "platform",
      "template",
      "series",
      "run",
    ]);
    assert.equal(snapshot.fieldSources.durationSeconds, "run");
    assert.equal(snapshot.fieldSources.automationLevel, "series");
  });

  it("creates a self-contained immutable snapshot without mutating the source", () => {
    const template = validTemplate();
    const snapshot = resolveTemplateSnapshot({
      template,
      resolvedAt: "2026-08-27T10:00:00.000Z",
      systemDefaults: { platform: "douyin", durationSeconds: 30, automationLevel: "assisted" },
    });

    template.storyStructure[0]!.label = "后来修改";
    assert.equal(snapshot.resolvedBlueprint.storyStructure[0]?.label, "先抓住注意力");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.resolvedBlueprint), true);
  });

  it("preserves template model defaults in the immutable run snapshot", () => {
    const snapshot = resolveTemplateSnapshot({
      template: { ...validTemplate(), modelDefaults: { "seedance-video-v1": "doubao-seedance-2-0-fast-260128" } },
      resolvedAt: "2026-08-28T00:00:00.000Z",
      systemDefaults: { platform: "douyin" },
    });
    assert.deepEqual(snapshot.modelDefaults, { "seedance-video-v1": "doubao-seedance-2-0-fast-260128" });
    assert.ok(Object.isFrozen(snapshot.modelDefaults));
  });

  it("rejects invalid resolved timestamps and invalid merged overrides", () => {
    assert.throws(() => resolveTemplateSnapshot({
      template: validTemplate(),
      resolvedAt: "not-a-date",
      systemDefaults: { platform: "douyin" },
    }), /resolvedAt/);

    assert.throws(() => resolveTemplateSnapshot({
      template: validTemplate(),
      resolvedAt: "2026-08-27T10:00:00.000Z",
      systemDefaults: { platform: "douyin" },
      runOverrides: { durationSeconds: -1 },
    }), /durationSeconds/);

    assert.throws(() => resolveTemplateSnapshot({
      template: validTemplate(),
      resolvedAt: "2026-08-27T10:00:00.000Z",
      systemDefaults: { platform: "douyin" },
      runOverrides: { costPolicy: { currency: "CNY", maxCost: -1, maxPaidShots: 0 } },
    }), /costPolicy.maxCost/);
  });

  it("round-trips a resolved snapshot through the runtime parser", () => {
    const snapshot = resolveTemplateSnapshot({
      template: validTemplate(),
      resolvedAt: "2026-08-27T10:00:00.000Z",
      systemDefaults: { platform: "douyin", durationSeconds: 30, automationLevel: "assisted" },
    });
    assert.deepEqual(parseProductionTemplateSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
    assert.throws(() => parseProductionTemplateSnapshot({ ...snapshot, templateVersion: 0 }), /positive integer/);
  });
});
