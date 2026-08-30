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

  it("preserves the formally approved previous-episode handoff in series context", () => {
    const parsed = pipeline.parseBrief({
      ...validBrief,
      seriesContext: {
        seriesId: "series-1",
        episodeId: "episode-2",
        seriesName: "下班实验室",
        seriesRevision: 4,
        episodeNumber: 2,
        seasonNumber: 1,
        canonBaseRevision: 1,
        premise: "每集验证一个真实方法。",
        audience: "普通上班族",
        platform: "douyin",
        track: "after-work",
        arc: "从尝试走向稳定流程",
        episode: {
          updatedAt: "2026-08-30T00:00:00.000Z",
          pillar: "真实验证",
          title: "第二集",
          viewerPromise: "复核上一集的方法",
          hook: "先看失败结果",
          payoff: "给出适用边界",
          planning: {
            source: "agent",
            role: "系列总编",
            auditRole: "独立红队审计 Agent",
            auditStatus: "passed",
            auditIterations: 2,
            providerId: "openai",
            modelId: "codex",
            promptVersion: "series-v1",
          },
        },
        bible: { rules: ["必须真实验证"], recurringElements: [], forbiddenChanges: [] },
        canon: {
          revision: 1,
          facts: [{
            id: "fact-1",
            statement: "第一集已验证方法 A。",
            sourceEpisodeId: "episode-1",
            acceptedAt: "2026-08-29T00:00:00.000Z",
          }],
        },
        continuity: {
          inheritedFromPrevious: ["第一集正式交接：方法 A 只适合单人任务。"],
          fromPrevious: ["复核方法 A"],
          toNext: ["下一集验证多人任务"],
          canonChecks: ["不得把多人结果写成已验证"],
        },
      },
    });

    assert.deepEqual(parsed.seriesContext?.continuity.inheritedFromPrevious, [
      "第一集正式交接：方法 A 只适合单人任务。",
    ]);
  });

  it("preserves bounded per-provider model selections without treating a model as a provider", () => {
    const parsed = pipeline.parseBrief({
      ...validBrief,
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
    });

    assert.deepEqual(parsed.models, { "seedance-video-v1": "doubao-seedance-2-5-260628" });
    assert.deepEqual(parsed.modelSelectionSources, { "seedance-video-v1": "run_override" });
    assert.deepEqual(pipeline.parseBrief({
      ...validBrief,
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
      modelSelectionSources: {},
    }).modelSelectionSources, { "seedance-video-v1": "run_override" });
    assert.throws(() => pipeline.parseBrief({ ...validBrief, models: { "seedance-video-v1": "bad model id" } }), /models\.seedance-video-v1 is invalid/);
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

  it("allows metered per-run roles without reserving paid-shot generation", () => {
    const brief = pipeline.parseBrief({
      ...validBrief,
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    });

    assert.deepEqual(brief.economics, {
      recipeId: "economy-daily",
      allowMeteredProviders: true,
      maxPaidShots: 0,
      maxCostCny: 0,
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

  it("enables semantic candidate ranking only behind the director and shot-router contract", () => {
    assert.throws(
      () => pipeline.parseBrief({ ...validBrief, workflowFeatures: { assetSemanticRank: true, referenceGrammar: false } }),
      /requires an AI director configuration/,
    );
    assert.throws(
      () => pipeline.parseBrief({
        ...validBrief,
        providers: { ...validBrief.providers, director: "api-visual-director-v1" },
        director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
        workflowFeatures: { assetSemanticRank: true, referenceGrammar: false },
      }),
      /requires providers\.assets 'ai-shot-router-v1'/,
    );
  });

  it("binds reference-video workflows to a SHA-256 content identity", () => {
    const input = {
      ...validBrief,
      providers: { ...validBrief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
      referenceVideo: {
        uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
        label: "参考节奏.mp4",
        mimeType: "video/mp4",
        sizeBytes: 12,
        path: "/tmp/reference.mp4",
        sha256: "a".repeat(64),
      },
    };

    assert.equal(pipeline.parseBrief(input).referenceVideo?.sha256, "a".repeat(64));
    const { sha256: _sha256, ...unboundReference } = input.referenceVideo;
    assert.throws(() => pipeline.parseBrief({ ...input, referenceVideo: unboundReference }), /referenceVideo\.sha256/);
    assert.throws(() => pipeline.parseBrief({ ...input, referenceVideo: { ...input.referenceVideo, sha256: "not-a-hash" } }), /referenceVideo\.sha256/);
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
