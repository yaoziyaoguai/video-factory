import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StudioInputError,
  parseStudioCandidateSourcesInput,
  parseStudioCreatorSettingsPatch,
  parseStudioOpportunityInput,
  parseStudioOpportunityStatusInput,
  parseStudioNarrationRevisionInput,
  parseStudioPublishInput,
  parseStudioCreativeReviewCommandInput,
  parseStudioSeriesInput,
  parseStudioDecisionInput,
  parseStudioVoicePreviewInput,
} from "../src/shared/api.js";

describe("run intervention API contracts", () => {
  it("accepts a bounded voice timing change without accepting a managed file path", () => {
    assert.deepEqual(parseStudioDecisionInput({
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    }), {
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    });
    assert.throws(() => parseStudioDecisionInput({
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      executablePlanPath: "/etc/passwd",
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    }), /不支持|字段/);
    assert.throws(() => parseStudioDecisionInput({
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
    }), /必须填写镜头和新时长/);
    for (const action of ["approve", "reject"] as const) {
      assert.throws(() => parseStudioDecisionInput({
        action,
        expectedRunRevision: 4,
        interventionId: "voice-timing-1",
        reviewEvidenceId: null,
        voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
      }), /只有调整方案时/);
    }
  });

  it("requires a written reason on every rejected review item before an approval", () => {
    const base = {
      action: "approve" as const,
      expectedRunRevision: 4,
      interventionId: "final-review-1",
      reviewEvidenceId: "a".repeat(64),
    };
    const itemKey = "b".repeat(64);
    assert.deepEqual(parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey, decision: "reject", reason: " 已逐帧核对，这里是有意为之 " }],
    }), {
      ...base,
      reviewDispositions: [{ itemKey, decision: "reject", reason: "已逐帧核对，这里是有意为之" }],
    });
    // 采纳就是"照这条结论返修"，理由由结论本身给出，不再要求另写一段。
    assert.deepEqual(parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey, decision: "accept" }],
    }).reviewDispositions, [{ itemKey, decision: "accept" }]);
    assert.throws(() => parseStudioDecisionInput({ ...base, reviewDispositions: [] }), /不能是空列表/);
    assert.throws(() => parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey, decision: "reject" }],
    }), /必须写明理由/);
    assert.throws(() => parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey, decision: "reject", reason: "   " }],
    }), /必须写明理由/);
    assert.throws(() => parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey: "not-a-digest", decision: "reject", reason: "看过" }],
    }), /条目编号格式不正确/);
    assert.throws(() => parseStudioDecisionInput({
      ...base,
      reviewDispositions: [{ itemKey, decision: "reject", reason: "看过" }, { itemKey, decision: "reject", reason: "再看" }],
    }), /只能表态一次/);
    // 打回不需要逐条表态：那不是一份放行签字。
    assert.throws(() => parseStudioDecisionInput({
      ...base,
      action: "reject",
      reviewDispositions: [{ itemKey, decision: "reject", reason: "看过" }],
    }), /只有批准成片时/);
  });
});

describe("candidate source supplement API contracts", () => {
  it("accepts 1 to 10 trimmed urls and canonicalizes fragments and duplicates", () => {
    assert.deepEqual(parseStudioCandidateSourcesInput({
      evidenceUrls: [
        "  https://News.cn/news/a?b=1#frag  ",
        "https://news.cn/news/a?b=1",
        "http://people.com.cn:80/deep",
      ],
    }), {
      evidenceUrls: [
        "https://news.cn/news/a?b=1",
        "http://people.com.cn/deep",
      ],
    });
    assert.deepEqual(parseStudioCandidateSourcesInput({ evidenceUrls: ["https://news.cn/single"] }), {
      evidenceUrls: ["https://news.cn/single"],
    });
  });

  it("rejects empty or oversized batches and non-string entries", () => {
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: [] }), /1 到 10 条/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: Array.from({ length: 11 }, () => "https://news.cn/a") }), /1 到 10 条/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: [42] }), /文本/);
    assert.throws(() => parseStudioCandidateSourcesInput("nope"), /格式不正确/);
    assert.throws(() => parseStudioCandidateSourcesInput({}), /格式不正确|1 到 10 条/);
  });

  it("rejects non-http schemes, credentials, and malformed or oversized urls", () => {
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: ["ftp://example.com/file"] }), /http 或 https/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: ["file:///etc/passwd"] }), /http 或 https/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: ["https://user:pass@news.cn/a"] }), /用户名或密码/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: ["https://news.cn/a", "   "] }), /不能为空/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: ["not a url"] }), /格式不正确/);
    assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: [`https://news.cn/${"a".repeat(2048)}`] }), /2048/);
  });

  it("rejects non-public and reserved example hosts without requesting them", () => {
    for (const source of [
      "http://localhost/a",
      "http://127.0.0.1/a",
      "http://10.0.0.1/a",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/a",
      "http://internal/a",
      "https://source.example/report",
      "https://example.com/report",
    ]) {
      assert.throws(() => parseStudioCandidateSourcesInput({ evidenceUrls: [source] }), /可公开访问的网站/);
    }
  });
});

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

describe("scene narration revision API contracts", () => {
  it("accepts one scene's narration rewrite and rejects text that is not a single line", () => {
    assert.deepEqual(
      parseStudioNarrationRevisionInput({
        expectedRunRevision: 7,
        scenePosition: 2,
        narration: "  改过的第二幕  ",
        note: "  第二幕口播改得更直白。  ",
      }),
      {
        expectedRunRevision: 7,
        scenePosition: 2,
        narration: "改过的第二幕",
        note: "第二幕口播改得更直白。",
      },
    );

    assert.throws(
      () => parseStudioNarrationRevisionInput({
        expectedRunRevision: 7,
        scenePosition: 2,
        narration: "   ",
        note: "空文字不能提交。",
      }),
      (error: unknown) => error instanceof StudioInputError,
    );
    assert.throws(
      () => parseStudioNarrationRevisionInput({
        expectedRunRevision: 7,
        scenePosition: 2,
        narration: "字".repeat(601),
        note: "超长文字不能提交。",
      }),
      (error: unknown) => error instanceof StudioInputError && /600/.test(error.message),
    );
    assert.throws(
      () => parseStudioNarrationRevisionInput({
        expectedRunRevision: 7,
        scenePosition: 2,
        narration: "第一行\n第二行",
        note: "旁白是一行口播，不能塞换行。",
      }),
      (error: unknown) => error instanceof StudioInputError,
    );
    assert.throws(
      () => parseStudioNarrationRevisionInput({
        expectedRunRevision: 7,
        scenePosition: 0,
        narration: "改过的第二幕",
        note: "镜位从 1 起。",
      }),
      (error: unknown) => error instanceof StudioInputError,
    );
  });
});

describe("creative review confirm API contract", () => {
  const base = {
    action: "confirm",
    commandId: "confirm-1",
    expectedRunRevision: 3,
    expectedReviewRevision: 7,
    stage: "treatment",
    baseDraftSha256: "a".repeat(64),
  };

  it("keeps the acknowledgement together with the review it overrides", () => {
    assert.deepEqual(parseStudioCreativeReviewCommandInput({
      ...base,
      acknowledgeRepair: true,
      expectedCheckIdentity: "b".repeat(64),
    }), {
      ...base,
      acknowledgeRepair: true,
      expectedCheckIdentity: "b".repeat(64),
    });
  });

  it("refuses an acknowledgement that does not say which review it overrides", () => {
    // 这两个字段曾经漏在字段白名单外，"看过意见，仍然确认"因此在 HTTP 入口就被拒，
    // 界面上的按钮背后整条断路——而图级单测手工构造 resume，正好绕过了这一层。
    assert.throws(
      () => parseStudioCreativeReviewCommandInput({ ...base, acknowledgeRepair: true }),
      (error: unknown) => error instanceof StudioInputError
        && /确认前请先查看当前的独立复核意见/.test(error.message),
    );
  });

  it("refuses a malformed review identity instead of forwarding it", () => {
    assert.throws(
      () => parseStudioCreativeReviewCommandInput({
        ...base,
        acknowledgeRepair: true,
        expectedCheckIdentity: "not-a-digest",
      }),
      StudioInputError,
    );
  });

  it("accepts a hand-edited draft only as a complete document object", () => {
    // 人工修订走 edit_draft：稿件必须整体提交（服务端会按阶段合同整体校验），
    // 数组或残缺载荷在这里就被拒，不会进到图的校验层。
    const document = { viewerPromise: "看懂一个判断方法", payoff: "给出检查表" };
    assert.deepEqual(
      parseStudioCreativeReviewCommandInput({ ...base, action: "edit_draft", document }),
      { ...base, action: "edit_draft", document },
    );
    assert.throws(
      () => parseStudioCreativeReviewCommandInput({ ...base, action: "edit_draft", document: [document] }),
      (error: unknown) => error instanceof StudioInputError && /完整的方案内容/.test(error.message),
    );
    assert.throws(
      () => parseStudioCreativeReviewCommandInput({ ...base, action: "edit_draft" }),
      (error: unknown) => error instanceof StudioInputError && /完整的方案内容/.test(error.message),
    );
  });

  it("still accepts a plain confirmation that overrides nothing", () => {
    assert.deepEqual(parseStudioCreativeReviewCommandInput(base), base);
  });
});
