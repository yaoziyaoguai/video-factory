import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as pipeline from "../src/index.js";

const validBrief = {
  protocolVersion: "video-factory/brief-v1",
  title: "做决定前，先避开这 3 个坑",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 30,
  platform: "douyin",
  reviewMode: "manual",
  providers: {
    script: "python-template-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
  voiceDirection: {
    profileId: "macos:Sandy (中文（中国大陆）)",
    rate: 178,
    pauseScale: 1.25,
    masteringPreset: "intimate",
  },
} as const;

describe("ProductionBrief", () => {
  it("accepts a versioned brief and preserves explicit provider bindings", () => {
    const parseBrief = (pipeline as { parseBrief?: (value: unknown) => unknown }).parseBrief;
    assert.equal(typeof parseBrief, "function");

    const brief = parseBrief?.(validBrief) as pipeline.ProductionBrief;

    assert.equal(brief.protocolVersion, "video-factory/brief-v1");
    assert.equal(brief.providers.assets, "local-editorial-v1");
    assert.equal(brief.reviewMode, "manual");
    assert.deepEqual(brief.voiceDirection, validBrief.voiceDirection);
    assert.deepEqual(brief.economics, {
      recipeId: "economy-daily",
      allowMeteredProviders: false,
      maxPaidShots: 0,
      maxCostCny: 0,
    });
  });

  it("provides a conservative local voice direction for older briefs", () => {
    const { voiceDirection: _voiceDirection, ...legacyBrief } = validBrief;

    assert.deepEqual(pipeline.parseBrief(legacyBrief).voiceDirection, {
      profileId: "macos:Tingting",
      rate: 185,
      pauseScale: 1,
      masteringPreset: "natural",
    });
  });

  it("rejects a voice profile that does not belong to the bound provider", () => {
    assert.throws(
      () => pipeline.parseBrief({
        ...validBrief,
        providers: { ...validBrief.providers, voice: "macos-say-v1" },
        voiceDirection: { ...validBrief.voiceDirection, profileId: "kokoro:zf_001" },
      }),
      /voiceDirection\.profileId.*providers\.voice/,
    );
  });

  it("normalizes a known legacy voice mismatch only when reading a persisted brief", () => {
    const persisted = pipeline.parsePersistedBrief({
      ...validBrief,
      providers: { ...validBrief.providers, voice: "macos-say-v1" },
      voiceDirection: { ...validBrief.voiceDirection, profileId: "kokoro:zf_001" },
    });

    assert.deepEqual(persisted.voiceDirection, {
      ...validBrief.voiceDirection,
      profileId: "macos:Tingting",
    });
    assert.throws(
      () => pipeline.parsePersistedBrief({
        ...validBrief,
        providers: { ...validBrief.providers, voice: "unknown-voice-v1" },
        voiceDirection: { ...validBrief.voiceDirection, profileId: "kokoro:zf_001" },
      }),
      /voiceDirection\.profileId.*providers\.voice/,
    );
  });

  it("routes a MiniMax actor profile through the cloud TTS provider", () => {
    const brief = pipeline.parseBrief({
      ...validBrief,
      providers: { ...validBrief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...validBrief.voiceDirection, profileId: "minimax:female-chengshu" },
    });

    assert.equal(brief.providers.voice, "minimax-tts-v1");
    assert.equal(brief.voiceDirection.profileId, "minimax:female-chengshu");
  });

  it("accepts a bounded paid-generation budget", () => {
    const brief = pipeline.parseBrief({
      ...validBrief,
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 8,
      },
    });

    assert.deepEqual(brief.economics, {
      recipeId: "keyshot-ai",
      allowMeteredProviders: true,
      maxPaidShots: 1,
      maxCostCny: 8,
    });
  });

  it("preserves an editorial image-story direction and rejects skipped topics", () => {
    const brief = pipeline.parseBrief({
      ...validBrief,
      editorial: {
        verdict: "produce_image_story",
        reasons: ["公共事件应以来源和数据卡为主。"],
        guardrails: ["不得用生成画面虚构现场。"],
      },
    });

    assert.equal(brief.editorial?.verdict, "produce_image_story");
    assert.match(brief.editorial?.guardrails[0] ?? "", /不得/);
    assert.throws(() => pipeline.parseBrief({
      ...validBrief,
      editorial: { verdict: "skip", reasons: ["不值得生产"], guardrails: ["停止"] },
    }), /editorial\.verdict/);
  });

  it("accepts an AI director and a source pool without prescribing a material mix", () => {
    const brief = pipeline.parseBrief({
      ...validBrief,
      providers: {
        ...validBrief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1", "pexels-stock-v1", "seedance-video-v1"],
      },
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 8,
      },
    });

    assert.deepEqual(brief.director, {
      profileId: "auto",
      assetProviderIds: ["local-editorial-v1", "pexels-stock-v1", "seedance-video-v1"],
    });
    assert.equal(brief.providers.director, "api-visual-director-v1");
    assert.equal(brief.providers.assets, "ai-shot-router-v1");
  });

  it("rejects duplicate or empty AI director source pools", () => {
    assert.throws(
      () => pipeline.parseBrief({
        ...validBrief,
        providers: { ...validBrief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
        director: { profileId: "auto", assetProviderIds: [] },
      }),
      /director\.assetProviderIds/,
    );
    assert.throws(
      () => pipeline.parseBrief({
        ...validBrief,
        providers: { ...validBrief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1", "pexels-stock-v1"] },
      }),
      /must not contain duplicates/,
    );
  });

  it("rejects incompatible protocol versions and incomplete provider bindings", () => {
    const parseBrief = (pipeline as { parseBrief?: (value: unknown) => unknown }).parseBrief;
    assert.equal(typeof parseBrief, "function");

    assert.throws(
      () => parseBrief?.({ ...validBrief, protocolVersion: "video-factory/brief-v0" }),
      /Unsupported brief protocolVersion/,
    );
    assert.throws(
      () => parseBrief?.({ ...validBrief, providers: { ...validBrief.providers, voice: "" } }),
      /providers.voice/,
    );
    assert.throws(() => parseBrief?.({ ...validBrief, durationSeconds: 10 }), /between 20 and 180/);
    assert.throws(
      () => parseBrief?.({ ...validBrief, voiceDirection: { ...validBrief.voiceDirection, rate: 400 } }),
      /voiceDirection.rate/,
    );
    assert.throws(
      () => parseBrief?.({ ...validBrief, voiceDirection: { ...validBrief.voiceDirection, masteringPreset: "radio" } }),
      /masteringPreset/,
    );
    assert.throws(
      () => parseBrief?.({
        ...validBrief,
        economics: {
          recipeId: "keyshot-ai",
          allowMeteredProviders: true,
          maxPaidShots: 1,
          maxCostCny: 0,
        },
      }),
      /maxCostCny/,
    );
  });
});
