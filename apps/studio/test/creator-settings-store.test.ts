import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
      roleProviderDefaults: { script: "codex-screenwriter-v1", director: "api-visual-director-v1" },
      productionDefaults: { directorProfileId: "documentary-observer", durationSeconds: 30 },
    });

    const reloaded = await new JsonCreatorSettingsStore(file).get();
    assert.equal(reloaded.defaultRecipeId, "free-stock");
    assert.equal(reloaded.voiceDirection.rate, 205);
    assert.equal(reloaded.defaultAssetProviderId, "pexels-stock-v1");
    assert.deepEqual(reloaded.roleProviderDefaults, {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
    });
    assert.deepEqual(reloaded.productionDefaults, {
      directorProfileId: "documentary-observer",
      reviewMode: "manual",
      platform: "douyin",
      durationSeconds: 30,
    });
  });

  it("drops unknown or malformed role defaults when reading persisted settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-settings-sanitize-"));
    const file = path.join(root, "creator-settings.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      settings: {
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "economy-daily",
        roleProviderDefaults: {
          script: "  codex-screenwriter-v1  ",
          unknownRole: "codex-screenwriter-v1",
          director: "../unsafe-provider",
          voice: 42,
        },
        modelDefaults: {},
        productionDefaults: {
          directorProfileId: "auto",
          reviewMode: "manual",
          platform: "douyin",
          durationSeconds: 24,
        },
        topicStrategy: { customInstruction: "保持事实准确。" },
      },
    }), "utf8");

    const settings = await new JsonCreatorSettingsStore(file).get();

    assert.deepEqual(settings.roleProviderDefaults, { script: "codex-screenwriter-v1" });
  });
});
