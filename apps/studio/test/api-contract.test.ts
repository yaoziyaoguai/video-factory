import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StudioInputError,
  parseStudioCreatorSettingsPatch,
  parseStudioOpportunityInput,
  parseStudioOpportunityStatusInput,
  parseStudioPublishInput,
  parseStudioSeriesInput,
  parseStudioVoicePreviewInput,
} from "../src/shared/api.js";

describe("publishing API contracts", () => {
  it("accepts explicit multi-platform legal confirmations and rejects ambiguous requests", () => {
    const confirmations = {
      finalContent: true,
      aigcDisclosure: true,
      rightsAndLikeness: true,
      factualAccuracy: true,
      commercialDisclosure: true,
    };
    assert.deepEqual(parseStudioPublishInput({
      requestId: "publish-1",
      platformIds: ["douyin", "kuaishou"],
      confirmations,
    }), {
      requestId: "publish-1",
      platformIds: ["douyin", "kuaishou"],
      confirmations,
    });
    assert.throws(() => parseStudioPublishInput({ requestId: "publish-1", platformIds: [], confirmations }), /至少选择/);
    assert.throws(() => parseStudioPublishInput({ requestId: "publish-1", platformIds: ["douyin", "douyin"], confirmations }), /重复/);
    assert.throws(() => parseStudioPublishInput({
      requestId: "publish-1",
      platformIds: ["douyin"],
      confirmations: { ...confirmations, aigcDisclosure: "yes" },
    }), /逐项选择/);
  });
});

describe("creator settings API contracts", () => {
  it("accepts creator defaults without allowing unknown recipe values", () => {
    assert.deepEqual(parseStudioCreatorSettingsPatch({
      voiceDirection: { profileId: "macos:Tingting", rate: 190, pauseScale: 1.1, masteringPreset: "social" },
      defaultRecipeId: "free-stock",
      defaultAssetProviderId: "pexels-stock-v1",
      roleProviderDefaults: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        visualReview: "codex-visual-review-v1",
      },
      productionDefaults: {
        directorProfileId: "documentary-observer",
        reviewMode: "manual",
        platform: "douyin",
        durationSeconds: 30,
      },
    }), {
      voiceDirection: { profileId: "macos:Tingting", rate: 190, pauseScale: 1.1, masteringPreset: "social" },
      defaultRecipeId: "free-stock",
      defaultAssetProviderId: "pexels-stock-v1",
      roleProviderDefaults: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        visualReview: "codex-visual-review-v1",
      },
      productionDefaults: {
        directorProfileId: "documentary-observer",
        reviewMode: "manual",
        platform: "douyin",
        durationSeconds: 30,
      },
    });
    assert.throws(() => parseStudioCreatorSettingsPatch({ defaultRecipeId: "unlimited-paid" }), /默认制作配方无效/);
    assert.throws(() => parseStudioCreatorSettingsPatch({ productionDefaults: { directorProfileId: "famous-person" } }), /默认导演角色无效/);
    assert.throws(() => parseStudioCreatorSettingsPatch({ productionDefaults: { durationSeconds: 120 } }), /默认视频时长/);
    assert.throws(() => parseStudioCreatorSettingsPatch({ productionDefaults: { reviewMode: "automatic" } }), /人工终审/);
    assert.throws(() => parseStudioCreatorSettingsPatch({ roleProviderDefaults: { unknown: "provider-v1" } }), /生产角色/);
    assert.throws(() => parseStudioCreatorSettingsPatch({ roleProviderDefaults: { script: "bad provider" } }), /能力编号/);
  });

  it("accepts a configured cloud voice as the creator default", () => {
    assert.deepEqual(parseStudioCreatorSettingsPatch({
      voiceDirection: {
        profileId: "minimax:Chinese (Mandarin)_News_Anchor",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    }), {
      voiceDirection: {
        profileId: "minimax:Chinese (Mandarin)_News_Anchor",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });
    assert.throws(() => parseStudioCreatorSettingsPatch({
      voiceDirection: {
        profileId: "remote:unknown",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    }), /支持的声音演员/);
  });
});

const validOpportunity = {
  title: "下班后什么都不想做，是懒还是耗竭？",
  platform: "douyin",
  track: "ordinary-life",
  audience: "普通上班族",
  painPoint: "下班后没有精力",
  hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
  evidence: [{
    source: "manual-research",
    platform: "douyin",
    keyword: "下班后什么都不想做",
    strength: 86,
    evidenceUrl: "https://example.com/evidence",
    collectedAt: "2026-08-22T10:00:00.000Z",
  }],
  scores: {
    audienceReach: 88,
    visualFeasibility: 90,
    productionCostEfficiency: 84,
    novelty: 78,
    monetization: 62,
    seriesPotential: 91,
    complianceRisk: 18,
  },
};

describe("opportunity API contracts", () => {
  it("normalizes a valid opportunity input", () => {
    const parsed = parseStudioOpportunityInput({ ...validOpportunity, title: `  ${validOpportunity.title}  ` });

    assert.equal(parsed.title, validOpportunity.title);
    assert.equal(parsed.track, "ordinary-life");
    assert.equal(parsed.evidence[0]?.strength, 86);
  });

  it("rejects invalid evidence and scores", () => {
    assert.throws(
      () => parseStudioOpportunityInput({
        ...validOpportunity,
        evidence: [{ ...validOpportunity.evidence[0], strength: 101 }],
      }),
      (error: unknown) => error instanceof StudioInputError && /信号强度/.test(error.message),
    );
    assert.throws(
      () => parseStudioOpportunityInput({
        ...validOpportunity,
        scores: { ...validOpportunity.scores, novelty: Number.NaN },
      }),
      (error: unknown) => error instanceof StudioInputError && /novelty/.test(error.message),
    );
  });

  it("accepts only editorial opportunity statuses", () => {
    assert.deepEqual(parseStudioOpportunityStatusInput({ status: "approved" }), { status: "approved" });
    assert.throws(
      () => parseStudioOpportunityStatusInput({ status: "deleted" }),
      (error: unknown) => error instanceof StudioInputError && /状态/.test(error.message),
    );
  });
});

describe("series API contracts", () => {
  it("normalizes a durable series definition", () => {
    const parsed = parseStudioSeriesInput({
      name: "  AI 下班实验室  ",
      premise: "每集验证一个普通人真能用上的 AI 方法。",
      audience: "普通上班族",
      platform: "douyin",
      category: "technology",
      track: "ai-after-work",
      pillars: [" 真实任务实验 ", "成本与时间复盘"],
      tone: "克制、具体",
      visualStyle: "真实桌面操作与生活空镜",
      planningPeriod: "2026 Q3",
      releaseCadence: "weekly",
      targetEpisodeCount: 12,
    });

    assert.equal(parsed.name, "AI 下班实验室");
    assert.deepEqual(parsed.pillars, ["真实任务实验", "成本与时间复盘"]);
    assert.equal(parsed.planningPeriod, "2026 Q3");
    assert.equal(parsed.releaseCadence, "weekly");
    assert.equal(parsed.targetEpisodeCount, 12);
  });

  it("requires at least two content pillars and a stable track slug", () => {
    const base = {
      name: "AI 下班实验室",
      premise: "验证真实方法",
      audience: "普通上班族",
      platform: "douyin",
      category: "technology",
      track: "ai-after-work",
      pillars: ["真实实验", "复盘"],
      tone: "克制",
      visualStyle: "真实操作",
    };
    assert.throws(() => parseStudioSeriesInput({ ...base, pillars: ["只有一个"] }), /至少需要两个内容支柱/);
    assert.throws(() => parseStudioSeriesInput({ ...base, track: "AI 下班" }), /系列标识/);
    assert.throws(() => parseStudioSeriesInput({ ...base, releaseCadence: "daily" }), /更新频率/);
    assert.throws(() => parseStudioSeriesInput({ ...base, targetEpisodeCount: 101 }), /最多支持 100 集/);
    assert.throws(() => parseStudioSeriesInput({ ...base, platform: "shipinhao" }), /首发平台只支持抖音、小红书或哔哩哔哩/);
  });
});

describe("voice preview API contracts", () => {
  it("normalizes a bounded local voice preview request", () => {
    assert.deepEqual(parseStudioVoicePreviewInput({
      profileId: "macos:Tingting",
      text: "  今天，我们把声音调到刚刚好。  ",
      rate: 182,
      pauseScale: 1.2,
      masteringPreset: "intimate",
    }), {
      profileId: "macos:Tingting",
      text: "今天，我们把声音调到刚刚好。",
      rate: 182,
      pauseScale: 1.2,
      masteringPreset: "intimate",
    });
  });

  it("rejects unsupported profiles and unsafe preview ranges", () => {
    assert.throws(
      () => parseStudioVoicePreviewInput({
        profileId: "remote:unknown",
        text: "试听",
        rate: 400,
        pauseScale: 1,
        masteringPreset: "social",
      }),
      (error: unknown) => error instanceof StudioInputError && /支持的声音演员/.test(error.message),
    );
    assert.throws(
      () => parseStudioVoicePreviewInput({
        profileId: "macos:Tingting",
        text: "x".repeat(181),
        rate: 180,
        pauseScale: 1,
        masteringPreset: "natural",
      }),
      (error: unknown) => error instanceof StudioInputError && /180/.test(error.message),
    );
  });
});
