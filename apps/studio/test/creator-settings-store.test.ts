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
      topicStrategy: {
        positioning: "替普通人解释技术变化。",
        targetAudience: "关注 AI 但不想看营销稿的职场人。",
        preferredDirections: "真实工作影响\n可复现实验",
        excludedDirections: "只有热度没有证据",
        sourcePolicy: "primary_or_two_independent",
        customInstruction: "必须能在 30 秒内兑现标题承诺。",
      },
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
    assert.deepEqual(reloaded.topicStrategy, {
      positioning: "替普通人解释技术变化。",
      targetAudience: "关注 AI 但不想看营销稿的职场人。",
      preferredDirections: "真实工作影响\n可复现实验",
      excludedDirections: "只有热度没有证据",
      sourcePolicy: "primary_or_two_independent",
      customInstruction: "必须能在 30 秒内兑现标题承诺。",
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

  it("merges a partial topic strategy without resetting saved creator choices", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-settings-topic-patch-"));
    const file = path.join(root, "creator-settings.json");
    const store = new JsonCreatorSettingsStore(file);

    await store.update({
      topicStrategy: {
        positioning: "专门解释 AI 对普通工作的真实影响。",
        targetAudience: "希望获得可执行建议的职场人。",
        preferredDirections: "可复现实验",
        excludedDirections: "未经证实的争议",
        sourcePolicy: "traceable_source",
        customInstruction: "先验证再下结论。",
      },
    });
    await store.update({ topicStrategy: { customInstruction: "保持事实准确。" } });

    assert.deepEqual((await store.get()).topicStrategy, {
      positioning: "专门解释 AI 对普通工作的真实影响。",
      targetAudience: "希望获得可执行建议的职场人。",
      preferredDirections: "可复现实验",
      excludedDirections: "未经证实的争议",
      sourcePolicy: "traceable_source",
      customInstruction: "保持事实准确。",
    });
  });
});
