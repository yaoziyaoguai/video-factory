import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JsonCreatorSettingsStore } from "../src/server/creator-settings-store.js";

describe("JsonCreatorSettingsStore", () => {
  it("returns economic defaults and persists creator choices", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-settings-"));
    const file = path.join(root, "creator-settings.json");
    const store = new JsonCreatorSettingsStore(file);

    const defaults = await store.get();
    assert.equal(defaults.defaultRecipeId, "economy-daily");
    assert.deepEqual(defaults.productionDefaults, {
      directorProfileId: "auto",
      reviewMode: "manual",
      platform: "douyin",
      durationSeconds: 24,
    });
    await store.update({
      voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.15, masteringPreset: "social" },
      defaultRecipeId: "free-stock",
      defaultAssetProviderId: "pexels-stock-v1",
      productionDefaults: { directorProfileId: "documentary-observer", durationSeconds: 30 },
    });

    const reloaded = await new JsonCreatorSettingsStore(file).get();
    assert.equal(reloaded.defaultRecipeId, "free-stock");
    assert.equal(reloaded.voiceDirection.rate, 205);
    assert.equal(reloaded.defaultAssetProviderId, "pexels-stock-v1");
    assert.deepEqual(reloaded.productionDefaults, {
      directorProfileId: "documentary-observer",
      reviewMode: "manual",
      platform: "douyin",
      durationSeconds: 30,
    });
  });
});
