import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CandidateInboxStudio, candidateVerification, reviewTrendOpportunityAgainstCurrentPolicy } from "../src/server/candidate-inbox-studio.js";
import { OpportunityStudio } from "../src/server/opportunity-studio.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import { SeriesStudio } from "../src/server/series-studio.js";
import { JsonSeriesStore } from "../src/server/series-store.js";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";
import type { StudioCandidateInboxItem, StudioOpportunity, StudioSeries, StudioSeriesEpisode, StudioTrendCandidate } from "../src/shared/api.js";

const trendCandidate = {
  id: "trend-1",
  title: "AI 模型开始进入普通人的工作流",
  platform: "douyin",
  track: "daily-observer",
  audience: "普通上班族",
  painPoint: "工具很多但不知道是否真省时间",
  hook: "别先看演示，先看它能不能替你完成一件真任务。",
  rationale: "来自可追溯热点信号。",
  providerId: "api-topic-editor-v1",
  generatedAt: "2026-08-24T08:05:00.000Z",
  evidence: [
    {
      source: "技术媒体 A",
      platform: "douyin",
      keyword: "AI 工作流",
      strength: 96,
      evidenceUrl: "https://example.com/ai-workflow",
      collectedAt: "2026-08-24T08:00:00.000Z",
    },
    {
      source: "技术媒体 B",
      platform: "douyin",
      keyword: "AI 工作流实测",
      strength: 88,
      evidenceUrl: "https://example.org/ai-workflow-test",
      collectedAt: "2026-08-24T08:01:00.000Z",
    },
  ],
  score: {
    audienceReach: 90,
    visualFeasibility: 88,
    productionCostEfficiency: 90,
    novelty: 84,
    monetization: 72,
    seriesPotential: 88,
    complianceRisk: 12,
    final: 86,
  },
};

describe("CandidateInboxStudio", () => {
  it("preserves the topic editor's concrete visual evidence and shot plan when adopting and reloading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-candidate-visual-plan-"));
    const filePath = path.join(root, "opportunities.json");
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(filePath),
    });
    const candidate: StudioTrendCandidate = {
      ...trendCandidate,
      id: "trend-specific-visual-plan",
      visualProof: "并列两家平台的真实标题，观众能直接看见同一事件被写成不同确定性。",
      visualPlan: {
        strategy: "用标题原文与确定性标尺逐项对齐，禁止拼成虚构传播链。",
        beats: [{
          id: "headline-certainty-scale",
          role: "证据并列",
          duration: "0-8 秒",
          description: "左右并列两条真实标题，高亮“网传”和“正在核查”，指针停在不同确定性刻度。",
          searchQuery: "source headline screenshot certainty scale",
          source: "screen",
        }],
      },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [candidate] },
      series: new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) }),
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const adopted = await inbox.adopt(candidate.id, { origin: "trend" });
    const reloaded = await new OpportunityStudio({
      opportunities: new JsonOpportunityStore(filePath),
    }).get(candidate.id);

    assert.equal(adopted.visualProof, candidate.visualProof);
    assert.equal(adopted.visualPlan?.strategy, candidate.visualPlan?.strategy);
    assert.equal(reloaded?.visualProof, candidate.visualProof);
    assert.equal(reloaded?.visualPlan?.beats[0]?.id, "headline-certainty-scale");
    assert.match(reloaded?.visualPlan?.beats[0]?.description ?? "", /网传.*正在核查/);
  });

  it("persists a new series before any external planning Agent call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-durable-create-"));
    let reviewCalls = 0;
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-durable",
      planningAgent: {
        reviewEpisode: async () => {
          reviewCalls += 1;
          throw new Error("create must not wait for external planning");
        },
      },
    });

    const created = await series.create({
      name: "长期创作实验室",
      premise: "逐集沉淀一套长期可复用的方法。",
      audience: "持续追更的创作者",
      platform: "bilibili",
      category: "education",
      track: "long-running-creator-lab",
      pillars: ["方法验证", "阶段复盘"],
      tone: "克制具体",
      visualStyle: "纪实观察",
    });

    assert.equal(reviewCalls, 0);
    assert.equal(created.episodes.length, 6);
    assert.equal(created.episodes.every((episode) => episode.planning.auditStatus === "fallback"), true);
    assert.match(created.episodes[0]?.planning.fallbackReason ?? "", /独立复核/);
    assert.equal((await series.list())[0]?.id, created.id);
  });

  it("loads a series-only inbox without waiting for the trend model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-inbox-"));
    let trendCalls = 0;
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-fast",
    });
    await series.create({
      name: "下班观察室",
      premise: "每集回答一个真实的下班难题。",
      audience: "普通上班族",
      platform: "douyin",
      category: "lifestyle",
      track: "after-work-observer",
      pillars: ["真实问题", "行动复盘"],
      tone: "具体",
      visualStyle: "生活实拍",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => { trendCalls += 1; return [trendCandidate]; } },
      series,
      opportunities,
    });

    const result = await inbox.list({ origins: ["series"] });

    assert.equal(result.items.length, 6);
    assert.equal(result.items.every((item) => item.origin === "series"), true);
    assert.equal(trendCalls, 0);
  });

  it("uses the latest editorial gate and omits a template when a series candidate is blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-blocked-editorial-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const blockedCandidate: StudioCandidateInboxItem = {
      ...trendCandidate,
      id: "series-blocked-by-evidence",
      origin: "series",
      category: "technology",
      freshness: "evergreen",
      risk: "low",
      verification: {
        status: "blocked",
        independentSources: 0,
        requiredSources: 1,
        reasons: ["系列证据尚未达到开拍标准。"],
      },
      editorialDecision: {
        verdict: "produce_video",
        score: 90,
        reasons: ["旧路线图曾建议开拍。"],
        guardrails: ["开拍前重新检查证据。"],
      },
      seriesId: "series-blocked",
      seriesName: "待核验系列",
      episodeNumber: 1,
      seriesSequence: { status: "ready" },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series: {
        listCandidates: async () => [blockedCandidate],
        productionContextFor: async () => { throw new Error("blocked candidates cannot be reviewed"); },
        advanceEpisode: async () => { throw new Error("blocked candidates cannot advance"); },
      },
      opportunities,
    });

    const [listed] = (await inbox.list({ origins: ["series"] })).items;

    // 新语义：内容潜力 verdict 与开工门禁分离——生产建议保留，门禁作为前置 guardrail。
    assert.equal(listed?.editorialDecision.verdict, "produce_video");
    assert.equal(listed?.editorialDecision.recommendedTemplate, undefined);
    assert.match(listed?.editorialDecision.guardrails[0] ?? "", /开工门槛/);
    assert.match(listed?.editorialDecision.guardrails[0] ?? "", /系列证据尚未达到开拍标准/);
    assert.equal(listed?.verification.status, "blocked");
  });

  it("replaces a stale series video verdict with the current evidence-led format", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-current-editorial-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const candidate: StudioCandidateInboxItem = {
      ...trendCandidate,
      id: "series-public-update",
      origin: "series",
      title: "警方通报一项社会事件",
      category: "society",
      freshness: "evergreen",
      risk: "review",
      verification: {
        status: "review_required",
        independentSources: 1,
        requiredSources: 1,
        reasons: ["采用前需要人工查看原始来源。"],
      },
      score: { ...trendCandidate.score, complianceRisk: 60 },
      editorialDecision: {
        verdict: "produce_video",
        score: 99,
        reasons: ["旧路线图固定建议视频。"],
        guardrails: ["沿用旧结论。"],
      },
      seriesId: "series-public",
      seriesName: "公共事件观察",
      episodeNumber: 1,
      seriesSequence: { status: "ready" },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series: {
        listCandidates: async () => [candidate],
        productionContextFor: async () => { throw new Error("listing must not review"); },
        advanceEpisode: async () => { throw new Error("listing must not advance"); },
      },
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const [listed] = (await inbox.list({ origins: ["series"] })).items;

    assert.equal(listed?.editorialDecision.verdict, "produce_image_story");
    assert.equal(listed?.editorialDecision.recommendedTemplate?.id, "photo-story");
    assert.notEqual(listed?.editorialDecision.reasons[0], "旧路线图固定建议视频。");
  });

  it("does not let a high-risk series roadmap inherit the old low-risk video shortcut", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-high-risk-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-high-risk",
    });
    await series.create({
      name: "公共事件观察",
      premise: "逐集核验公共事件中的可靠事实。",
      audience: "希望辨别可靠信息的中文短视频用户",
      platform: "douyin",
      category: "society",
      track: "public-event-review",
      pillars: ["台风伤亡消息持续更新"],
      tone: "克制",
      visualStyle: "证据图解",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const [candidate] = (await inbox.list({ origins: ["series"] })).items;

    // 高风险系列候选：不因高风险继承低风险视频捷径，同时门禁与生产建议分离呈现。
    assert.equal(candidate?.risk, "high");
    assert.equal(candidate?.verification.status, "blocked");
    assert.equal(candidate?.editorialDecision.verdict, "produce_image_story");
    assert.match(candidate?.editorialDecision.guardrails[0] ?? "", /开工门槛/);
  });

  it("does not recommend templates for skipped or sequence-blocked series candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-unavailable-template-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const skippedCandidate: StudioCandidateInboxItem = {
      ...trendCandidate,
      id: "series-skipped",
      origin: "series",
      category: "technology",
      freshness: "evergreen",
      risk: "low",
      verification: {
        status: "ready",
        independentSources: 1,
        requiredSources: 1,
        reasons: ["系列路线图已保存。"],
      },
      editorialDecision: {
        verdict: "skip",
        score: 40,
        reasons: ["当前单集不值得开拍。"],
        guardrails: ["重写单集承诺后再评估。"],
        recommendedTemplate: {
          id: "human-mini-doc",
          name: "人物微纪录",
          format: "旧的模板推荐",
          rationale: "这是不应继续展示的历史数据。",
        },
      },
      seriesId: "series-unavailable",
      seriesName: "暂缓系列",
      episodeNumber: 1,
      seriesSequence: { status: "ready" },
    };
    const sequenceBlockedCandidate: StudioCandidateInboxItem = {
      ...skippedCandidate,
      id: "series-sequence-blocked",
      episodeNumber: 2,
      editorialDecision: {
        verdict: "produce_video",
        score: 76,
        reasons: ["上一集尚未完成。"],
        guardrails: ["必须按集数顺序推进。"],
      },
      seriesSequence: { status: "blocked", blockedByEpisodeNumber: 1 },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series: {
        listCandidates: async () => [skippedCandidate, sequenceBlockedCandidate],
        productionContextFor: async () => { throw new Error("unavailable candidates cannot be reviewed"); },
        advanceEpisode: async () => { throw new Error("unavailable candidates cannot advance"); },
      },
      opportunities,
    });

    const listed = (await inbox.list({ origins: ["series"] })).items;

    assert.equal(listed.find((item) => item.id === skippedCandidate.id)?.editorialDecision.verdict, "skip");
    assert.equal(listed.find((item) => item.id === skippedCandidate.id)?.editorialDecision.recommendedTemplate, undefined);
    assert.equal(listed.find((item) => item.id === sequenceBlockedCandidate.id)?.editorialDecision.recommendedTemplate, undefined);
  });

  it("keeps a rule roadmap editable but blocks adoption while the independent audit Agent is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-unaudited-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-unaudited",
    });
    await series.create({
      name: "长期观察室",
      premise: "逐集验证一个长期命题。",
      audience: "希望持续追更的观众",
      platform: "douyin",
      category: "knowledge",
      track: "long-running-observer",
      pillars: ["阶段验证", "长期复盘"],
      tone: "克制",
      visualStyle: "纪实",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series,
      opportunities,
    });
    const [candidate] = (await inbox.list({ origins: ["series"] })).items;

    await assert.rejects(
      () => inbox.adopt(candidate!.id, { origin: "series" }),
      /开拍前独立复核/,
    );
  });

  it("adopts the title, hook, and viewer promise produced by the opening greenlight review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reviewed-adoption-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const reviewedTitle = "AI 下班实验室 01｜实测三步把会议纪要变成待办";
    const reviewedViewerPromise = "让每天开会的上班族看见一套可复用的三步整理方法。";
    const reviewedHook = "实测三步：十分钟会议纪要到底能不能直接变成待办？";
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-reviewed",
      planningAgent: {
        reviewEpisode: async (_series, episode) => ({
          draft: {
            episodeNumber: episode.episodeNumber,
            pillar: episode.pillar,
            title: reviewedTitle,
            viewerPromise: reviewedViewerPromise,
            hook: reviewedHook,
            payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious],
            toNext: [...episode.continuity.toNext],
          },
          planning: {
            source: "agent" as const,
            role: "系列开拍总编",
            auditRole: "独立质量审计 Agent",
            auditStatus: "passed" as const,
            auditIterations: 1,
            providerId: "codex-series-planner-v1",
            modelId: "codex-default",
            promptVersion: "video-factory/series-greenlight-v1",
          },
        }),
      },
    });
    await series.create({
      name: "AI 下班实验室",
      premise: "每集验证一个能节省时间的真实 AI 方法。",
      audience: "想节省时间的普通上班族",
      platform: "douyin",
      category: "technology",
      track: "ai-after-work",
      pillars: ["真实任务实验"],
      tone: "具体",
      visualStyle: "桌面实测",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });
    const [beforeReview] = (await inbox.list({ origins: ["series"] })).items;

    const adopted = await inbox.adopt(beforeReview!.id, { origin: "series" });

    assert.equal(adopted.title, reviewedTitle);
    assert.equal(adopted.hook, reviewedHook);
    assert.equal(adopted.painPoint, reviewedViewerPromise);
  });

  it("rechecks a reviewed series candidate before selecting or persisting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reviewed-gate-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      createId: () => "series-reviewed-gate",
      planningAgent: {
        reviewEpisode: async (_series, episode) => ({
          draft: {
            episodeNumber: episode.episodeNumber,
            pillar: episode.pillar,
            title: "台风伤亡消息持续更新",
            viewerPromise: episode.viewerPromise,
            hook: "台风伤亡消息不断更新，哪些说法真的有来源？",
            payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious],
            toNext: [...episode.continuity.toNext],
          },
          planning: {
            source: "agent" as const,
            role: "系列开拍总编",
            auditRole: "独立质量审计 Agent",
            auditStatus: "passed" as const,
            auditIterations: 1,
            providerId: "codex-series-planner-v1",
            modelId: "codex-default",
            promptVersion: "video-factory/series-greenlight-v1",
          },
        }),
      },
    });
    await series.create({
      name: "每日事实实验室",
      premise: "每集验证一个公共信息判断方法。",
      audience: "希望辨别可靠信息的中文短视频用户",
      platform: "douyin",
      category: "society",
      track: "fact-review",
      pillars: ["来源核验"],
      tone: "克制",
      visualStyle: "证据图解",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series,
      opportunities,
    });
    const [beforeReview] = (await inbox.list({ origins: ["series"] })).items;

    await assert.rejects(
      () => inbox.adopt(beforeReview!.id, { origin: "series", verificationConfirmed: true }),
      /高风险公共题材不能只依据系列路线图开拍/,
    );

    assert.deepEqual(await opportunities.list(), []);
    assert.equal((await series.list())[0]?.episodes[0]?.status, "planned");
  });

  it("blocks a high-risk trend backed by one source and requires confirmation for review candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-verified-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const highRisk = {
      ...trendCandidate,
      id: "trend-high-risk",
      title: "台风登陆消息持续更新",
      evidence: [trendCandidate.evidence[0]!],
      score: { ...trendCandidate.score, complianceRisk: 72 },
    };
    const review = {
      ...trendCandidate,
      id: "trend-review",
      title: "警方通报一项社会事件",
      score: { ...trendCandidate.score, complianceRisk: 60 },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [highRisk, review] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const listed = await inbox.list({ origins: ["trend"] });
    assert.equal(listed.items.find((item) => item.id === highRisk.id)?.verification.status, "blocked");
    assert.equal(listed.items.find((item) => item.id === highRisk.id)?.editorialDecision.verdict, "produce_image_story");
    assert.match(listed.items.find((item) => item.id === highRisk.id)?.editorialDecision.guardrails[0] ?? "", /开工门槛/);
    assert.equal(listed.items.find((item) => item.id === review.id)?.verification.status, "review_required");
    assert.equal(listed.items.find((item) => item.id === review.id)?.editorialDecision.verdict, "produce_image_story");
    assert.deepEqual(
      listed.items.find((item) => item.id === review.id)?.editorialDecision.recommendedTemplate,
      {
        id: "photo-story",
        name: "证据图解",
        format: "来源画面与数据证据驱动的图解视频",
        rationale: "公共议题缺少可安全生成的连续现场，采用来源画面、数据和少量获授权实景更可信。",
      },
    );
    await assert.rejects(() => inbox.adopt(highRisk.id, { origin: "trend", verificationConfirmed: true }), /至少 2 个不同域名的有效原始来源链接/);
    await assert.rejects(() => inbox.adopt(review.id, { origin: "trend" }), /确认核验/);
    const adopted = await inbox.adopt(review.id, { origin: "trend", verificationConfirmed: true });
    assert.equal(adopted.verification?.status, "verified");
    assert.equal(adopted.editorialDecision?.recommendedTemplate?.id, "photo-story");
  });

  it("does not treat two aggregators carrying the same publisher link as independent evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-independent-evidence-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const duplicated = {
      ...trendCandidate,
      id: "trend-duplicated-aggregators",
      title: "警方通报高风险公共事件伤亡情况",
      evidence: [
        {
          source: "dailyhot",
          platform: "toutiao",
          keyword: "同一条头条新闻",
          strength: 98,
          evidenceUrl: "https://www.toutiao.com/article/123",
        },
        {
          source: "newsnow",
          platform: "toutiao",
          keyword: "同一条头条新闻",
          strength: 98,
          evidenceUrl: "https://m.toutiao.com/article/123",
        },
      ],
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [duplicated] },
      series,
      opportunities,
    });

    const [listed] = (await inbox.list({ origins: ["trend"] })).items;

    assert.equal(listed?.verification.status, "blocked");
    assert.equal(listed?.verification.independentSources, 1);
  });

  it("enforces the configured source policy for ordinary low-risk candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-source-policy-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const oneLinkedSource = {
      ...trendCandidate,
      evidence: [{ ...trendCandidate.evidence[0]!, evidenceUrl: "https://example.com/ai-workflow" }],
    };
    const strictInbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [oneLinkedSource] },
      series,
      opportunities,
      topicStrategy: async () => ({ customInstruction: "", sourcePolicy: "primary_or_two_independent" }),
    });
    const relaxedInbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [oneLinkedSource] },
      series,
      opportunities,
      topicStrategy: async () => ({ customInstruction: "", sourcePolicy: "traceable_source" }),
    });

    const [strict] = (await strictInbox.list({ origins: ["trend"] })).items;
    const [relaxed] = (await relaxedInbox.list({ origins: ["trend"] })).items;

    assert.equal(strict?.verification.status, "blocked");
    assert.equal(strict?.editorialDecision.verdict, "produce_video");
    assert.match(strict?.editorialDecision.guardrails[0] ?? "", /开工门槛/);
    assert.match(strict?.verification.reasons[0] ?? "", /至少 2 个不同域名的有效原始来源链接/);
    assert.equal(relaxed?.verification.status, "ready");
  });

  it("fails closed when the source policy is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-default-source-policy-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [{
        ...trendCandidate,
        evidence: [{ ...trendCandidate.evidence[0]!, evidenceUrl: "https://example.com/ai-workflow" }],
      }] },
      series,
      opportunities,
    });

    const [candidate] = (await inbox.list({ origins: ["trend"] })).items;

    assert.equal(candidate?.verification.status, "blocked");
    assert.equal(candidate?.verification.requiredSources, 2);
  });

  it("recomputes cached trend decisions and orders candidates by the current editorial gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-editorial-order-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const editorialWinner = {
      ...trendCandidate,
      id: "trend-editorial-winner",
      title: "总编高分候选",
      score: { ...trendCandidate.score, audienceReach: 96, visualFeasibility: 94, novelty: 92, final: 41 },
      editorialDecision: { verdict: "skip" as const, score: 0, reasons: ["过时缓存曾误判为不拍。"], guardrails: ["等待旧规则。"] },
    };
    const editorialRunnerUp = {
      ...trendCandidate,
      id: "trend-editorial-runner-up",
      title: "总编次高分候选",
      score: { ...trendCandidate.score, audienceReach: 68, visualFeasibility: 80, novelty: 60, final: 96 },
      editorialDecision: { verdict: "produce_video" as const, score: 99, reasons: ["过时缓存曾给出高分。"], guardrails: ["沿用旧规则。"] },
    };
    const rejectedRawWinner = {
      ...trendCandidate,
      id: "trend-rejected-raw-winner",
      title: "原始分高但未入选",
      score: { ...trendCandidate.score, audienceReach: 40, visualFeasibility: 40, novelty: 35, final: 100 },
      editorialDecision: { verdict: "produce_video" as const, score: 100, reasons: ["过时缓存曾建议开拍。"], guardrails: ["沿用旧规则。"] },
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [rejectedRawWinner, editorialRunnerUp, editorialWinner] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const listed = await inbox.list({ origins: ["trend"] });

    assert.deepEqual(listed.items.map((item) => item.id), [
      editorialWinner.id,
      editorialRunnerUp.id,
      rejectedRawWinner.id,
    ]);
    assert.equal(listed.items[0]?.editorialDecision.verdict, "produce_video");
    assert.equal(listed.items[1]?.editorialDecision.verdict, "produce_video");
    assert.equal(listed.items[2]?.editorialDecision.verdict, "skip");
    assert.notEqual(listed.items[0]?.editorialDecision.reasons[0], "过时缓存曾误判为不拍。");
    assert.notEqual(listed.items[2]?.editorialDecision.reasons[0], "过时缓存曾建议开拍。");
  });

  it("recomputes a cached trend category with the current taxonomy and evidence keywords", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-stale-category-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const staleCategory = {
      ...trendCandidate,
      id: "trend-stale-category",
      title: "新设备过审了，该不该等下一批？",
      track: "daily-observer",
      category: "lifestyle" as const,
      evidence: [{
        source: "dailyhot",
        platform: "douyin",
        keyword: "华为新款平板通过3C认证",
        strength: 96,
        evidenceUrl: "https://tech.example.cn/huawei-3c",
        collectedAt: "2026-08-24T08:00:00.000Z",
      }],
    };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [staleCategory] },
      series,
      opportunities,
    });

    const [listed] = (await inbox.list({ origins: ["trend"] })).items;

    // 缓存里的 category 是旧 taxonomy 的派生值；读取时用编辑标题+证据关键词+track 重算。
    assert.equal(listed?.category, "technology");
  });

  it("recomputes a blocked trend candidate after cross-domain source supplements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-supplement-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    let current: StudioTrendCandidate = {
      ...trendCandidate,
      id: "trend-supplement",
      evidence: [trendCandidate.evidence[0]!],
    };
    const inbox = new CandidateInboxStudio({
      trends: {
        listCandidates: async () => [current],
        appendCandidateSources: async (candidateId, evidenceUrls) => {
          assert.equal(candidateId, "trend-supplement");
          const additions = evidenceUrls
            .filter((url) => !current.evidence.some((item) => item.evidenceUrl === url))
            .map((url) => ({
              source: "manual-supplement",
              platform: "manual",
              keyword: "人工补充来源",
              strength: 60,
              evidenceUrl: url,
              collectedAt: "2026-09-07T05:00:00.000Z",
            }));
          current = { ...current, evidence: [...current.evidence, ...additions] };
          return current;
        },
      },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const [blocked] = (await inbox.list({ origins: ["trend"] })).items;
    assert.equal(blocked?.verification.status, "blocked");
    assert.equal(blocked?.verification.independentSources, 1);
    // 补充前 BLOCKED 不可采用；但创作方向不因门禁消失，仍带补齐后建议采用的模板。
    await assert.rejects(() => inbox.adopt("trend-supplement", { origin: "trend" }), /至少 2 个不同域名/);
    assert.equal(blocked?.editorialDecision.recommendedTemplate?.id, "product-demo");
    assert.match(blocked?.editorialDecision.guardrails[0] ?? "", /开工门槛/);

    const supplemented = await inbox.supplementTrendCandidateSources("trend-supplement", {
      evidenceUrls: ["https://news.example.org/report"],
    });

    // 复用现有 candidateVerification + decideEditorialFormat 链重算，不另存派生决策。
    assert.equal(supplemented.verification.status, "ready");
    assert.equal(supplemented.verification.independentSources, 2);
    assert.equal(supplemented.evidence.length, 2);
    assert.doesNotMatch(supplemented.editorialDecision.guardrails[0] ?? "", /开工门槛/);

    const [listed] = (await inbox.list({ origins: ["trend"] })).items;
    assert.equal(listed?.verification.status, "ready");
    assert.equal(listed?.verification.independentSources, 2);
  });

  it("serializes source supplementation before adoption so the opportunity keeps the latest evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-supplement-adopt-race-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    let current: StudioTrendCandidate = {
      ...trendCandidate,
      id: "trend-supplement-adopt-race",
      evidence: [{ ...trendCandidate.evidence[0]!, evidenceUrl: "https://news.cn/original" }],
    };
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const inbox = new CandidateInboxStudio({
      trends: {
        listCandidates: async () => [current],
        appendCandidateSources: async (_candidateId, evidenceUrls) => {
          markAppendStarted();
          await appendGate;
          current = {
            ...current,
            evidence: [...current.evidence, ...evidenceUrls.map((evidenceUrl) => ({
              source: "manual-supplement",
              platform: "manual",
              keyword: "人工补充来源",
              strength: 0,
              evidenceUrl,
              collectedAt: "2026-09-07T05:00:00.000Z",
            }))],
          };
          return current;
        },
      },
      series,
      opportunities,
      topicStrategy: async () => ({ customInstruction: "", sourcePolicy: "traceable_source" }),
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const supplementing = inbox.supplementTrendCandidateSources(current.id, {
      evidenceUrls: ["https://people.com.cn/supplement"],
    });
    await appendStarted;
    const adopting = inbox.adopt(current.id, { origin: "trend" });
    releaseAppend();

    await supplementing;
    const adopted = await adopting;
    assert.deepEqual(adopted.evidence.map((item) => item.evidenceUrl), [
      "https://news.cn/original",
      "https://people.com.cn/supplement",
    ]);
    await assert.rejects(
      () => inbox.supplementTrendCandidateSources(current.id, { evidenceUrls: ["https://央视网.cn/late"] }),
      /已被采用或已经失效/,
    );
  });

  it("keeps same-domain and search-page supplements from counting as independent sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-supplement-search-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    let current: StudioTrendCandidate = {
      ...trendCandidate,
      id: "trend-supplement-search",
      evidence: [trendCandidate.evidence[0]!],
    };
    const inbox = new CandidateInboxStudio({
      trends: {
        listCandidates: async () => [current],
        appendCandidateSources: async (_candidateId, evidenceUrls) => {
          current = {
            ...current,
            evidence: [...current.evidence, ...evidenceUrls.map((url) => ({
              source: "manual-supplement",
              platform: "manual",
              keyword: "人工补充来源",
              strength: 60,
              evidenceUrl: url,
              collectedAt: "2026-09-07T05:00:00.000Z",
            }))],
          };
          return current;
        },
      },
      series,
      opportunities,
    });

    // 同域名第二条：保存成功但仍只有一个有效独立来源。
    const sameDomain = await inbox.supplementTrendCandidateSources("trend-supplement-search", {
      evidenceUrls: ["https://example.com/another-path"],
    });
    assert.equal(sameDomain.verification.status, "blocked");
    assert.equal(sameDomain.verification.independentSources, 1);

    // 搜索结果页：可以保存留档，但绝不计入有效独立来源。
    const searchPage = await inbox.supplementTrendCandidateSources("trend-supplement-search", {
      evidenceUrls: ["https://www.baidu.com/s?wd=hot-topic"],
    });
    assert.equal(searchPage.verification.status, "blocked");
    assert.equal(searchPage.verification.independentSources, 1);
    assert.equal(searchPage.evidence.length, 3);
    assert.equal(searchPage.evidence.some((item) => item.evidenceUrl === "https://www.baidu.com/s?wd=hot-topic"), true);
    await assert.rejects(() => inbox.adopt("trend-supplement-search", { origin: "trend" }), /至少 2 个不同域名/);
  });

  it("rejects source supplements when the trend chain cannot append", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-supplement-unavailable-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [trendCandidate] },
      series,
      opportunities,
    });

    await assert.rejects(
      () => inbox.supplementTrendCandidateSources("trend-1", { evidenceUrls: ["https://news.example.org/a"] }),
      /没有启用热点候选来源补充/,
    );
  });

  it("does not treat search-result pages as original sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-search-result-evidence-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [{
        ...trendCandidate,
        evidence: [
          { ...trendCandidate.evidence[0]!, source: "微博搜索", evidenceUrl: "https://s.weibo.com/weibo?q=%23AI%23" },
          { ...trendCandidate.evidence[0]!, source: "百度搜索", evidenceUrl: "https://www.baidu.com/s?wd=AI" },
          { ...trendCandidate.evidence[0]!, source: "快手搜索", evidenceUrl: "https://www.kuaishou.com/search/video?searchKey=AI" },
        ],
      }] },
      series,
      opportunities,
      topicStrategy: async () => ({ customInstruction: "", sourcePolicy: "traceable_source" }),
    });

    const [candidate] = (await inbox.list({ origins: ["trend"] })).items;

    assert.equal(candidate?.verification.status, "blocked");
    assert.match(candidate?.verification.reasons[0] ?? "", /格式有效的原始来源链接/);
  });

  it("does not count local or private hosts as independently verifiable sources", () => {
    const verification = candidateVerification("low", [
      { source: "local", platform: "manual", keyword: "本机", strength: 0, evidenceUrl: "http://localhost/a" },
      { source: "loopback", platform: "manual", keyword: "回环", strength: 0, evidenceUrl: "http://127.0.0.1/b" },
      { source: "metadata", platform: "manual", keyword: "元数据", strength: 0, evidenceUrl: "http://169.254.169.254/latest/meta-data" },
    ]);

    assert.equal(verification.status, "blocked");
    assert.equal(verification.independentSources, 0);
  });

  it("keeps the configured two-source requirement visible after the candidate satisfies it", () => {
    const evidence = [
      { source: "source-a", platform: "manual", keyword: "证据 A", strength: 80, evidenceUrl: "https://news.cn/report-a" },
      { source: "source-b", platform: "manual", keyword: "证据 B", strength: 82, evidenceUrl: "https://people.com.cn/report-b" },
    ];

    const ready = candidateVerification("low", evidence, "primary_or_two_independent");
    const reviewRequired = candidateVerification("review", evidence, "primary_or_two_independent");

    assert.equal(ready.status, "ready");
    assert.equal(ready.requiredSources, 2);
    assert.equal(reviewRequired.status, "review_required");
    assert.equal(reviewRequired.requiredSources, 2);
  });

  it("does not let a newly added source make an old trend look fresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-manual-source-freshness-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [{
        ...trendCandidate,
        id: "old-trend-with-new-source",
        evidence: [
          { ...trendCandidate.evidence[0]!, evidenceUrl: "https://news.cn/old", collectedAt: "2026-08-01T08:00:00.000Z" },
          {
            source: "manual-supplement",
            platform: "manual",
            keyword: "人工补充来源",
            strength: 0,
            evidenceUrl: "https://people.com.cn/old-report",
            collectedAt: "2026-09-07T08:00:00.000Z",
          },
        ],
      }] },
      series,
      opportunities,
      now: () => new Date("2026-09-07T09:00:00.000Z"),
    });

    const [candidate] = (await inbox.list({ origins: ["trend"] })).items;
    assert.equal(candidate?.freshness, "evergreen");

    const historical: StudioOpportunity = {
      id: "historical-old-trend",
      title: "生成式 AI 与普通职场的关系",
      platform: "douyin",
      track: "technology-observer",
      audience: "需要判断技术影响的普通上班族",
      painPoint: "信息很多，但不知道哪些变化真的与自己有关",
      hook: "三个可核验信号，哪个最可能先影响你的工作？",
      status: "shortlisted",
      score: { ...trendCandidate.score, visualFeasibility: 88, final: 84 },
      scoreProvenance: { source: "historical", scoredAt: "2026-08-01T08:00:00.000Z" },
      evidence: [
        { ...trendCandidate.evidence[0]!, evidenceUrl: "https://news.cn/old", collectedAt: "2026-08-01T08:00:00.000Z" },
        {
          source: "manual-supplement",
          platform: "manual",
          keyword: "人工补充来源",
          strength: 0,
          evidenceUrl: "https://people.com.cn/old-report",
          collectedAt: "2026-09-07T08:00:00.000Z",
        },
      ],
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-09-07T08:00:00.000Z",
      origin: "trend",
      category: "technology",
    };
    const reviewed = reviewTrendOpportunityAgainstCurrentPolicy(
      historical,
      "primary_or_two_independent",
      BUILTIN_TEMPLATES,
      new Date("2026-09-07T09:00:00.000Z"),
    );
    assert.equal(reviewed.editorialDecision?.recommendedTemplate?.id, "knowledge-explainer");
  });

  it("can adopt a candidate the user saw just before a background trend refresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-refreshed-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    let currentCandidates = [trendCandidate];
    let publishedTemplates = BUILTIN_TEMPLATES;
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => currentCandidates },
      series,
      opportunities,
      publishedTemplates: async () => publishedTemplates,
    });

    const [visibleCandidate] = (await inbox.list({ origins: ["trend"] })).items;
    assert.equal(visibleCandidate?.editorialDecision.recommendedTemplate?.id, "product-demo");
    currentCandidates = [{ ...trendCandidate, id: "trend-after-refresh", title: "刷新后的另一条候选" }];
    publishedTemplates = BUILTIN_TEMPLATES.filter((template) => template.id !== "product-demo");

    // 推荐模板在目录里被下线后，采用必须失败关闭，不能默默无模板开工。
    await assert.rejects(
      () => inbox.adopt(visibleCandidate!.id, { origin: "trend" }),
      /推荐的生产模板当前不可用/,
    );
    assert.deepEqual(await opportunities.list(), []);

    // 目录恢复后，同一条被记住的候选仍可按原记忆采用（不因后台刷新丢失）。
    publishedTemplates = BUILTIN_TEMPLATES;
    const adopted = await inbox.adopt(visibleCandidate!.id, { origin: "trend" });

    assert.equal(adopted.id, trendCandidate.id);
    assert.equal(adopted.editorialDecision?.recommendedTemplate?.id, "product-demo");
    await assert.rejects(() => inbox.adopt(visibleCandidate!.id, { origin: "trend" }), /已被采用|已经失效/);
  });

  it("rejects a remembered trend when the current source policy becomes stricter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-refreshed-policy-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const oneSourceCandidate = {
      ...trendCandidate,
      id: "trend-visible-under-relaxed-policy",
      evidence: [{ ...trendCandidate.evidence[0]!, evidenceUrl: "https://example.com/ai-workflow" }],
    };
    let currentCandidates = [oneSourceCandidate];
    let sourcePolicy: "traceable_source" | "primary_or_two_independent" = "traceable_source";
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => currentCandidates },
      series,
      opportunities,
      topicStrategy: async () => ({ customInstruction: "", sourcePolicy }),
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });
    const [visibleCandidate] = (await inbox.list({ origins: ["trend"] })).items;
    assert.equal(visibleCandidate?.verification.status, "ready");

    currentCandidates = [];
    sourcePolicy = "primary_or_two_independent";

    await assert.rejects(
      () => inbox.adopt(visibleCandidate!.id, { origin: "trend" }),
      /至少 2 个不同域名的有效原始来源链接/,
    );
    assert.deepEqual(await opportunities.list(), []);
  });

  it("uses the explicit origin instead of guessing from a candidate id prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-candidate-origin-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const prefixedTrend = { ...trendCandidate, id: "series-breaking-news" };
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [prefixedTrend] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const adopted = await inbox.adopt(prefixedTrend.id, { origin: "trend" });

    assert.equal(adopted.origin, "trend");
    assert.equal(adopted.id, prefixedTrend.id);
  });

  it("fails closed when a remembered trend id belongs to a series opportunity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-candidate-origin-collision-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [trendCandidate] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });
    await inbox.list({ origins: ["trend"] });
    const { final: _final, ...scores } = trendCandidate.score;
    await opportunities.create({
      candidateId: trendCandidate.id,
      origin: "series",
      category: "technology",
      title: trendCandidate.title,
      platform: trendCandidate.platform,
      track: trendCandidate.track,
      audience: trendCandidate.audience,
      painPoint: trendCandidate.painPoint,
      hook: trendCandidate.hook,
      evidence: trendCandidate.evidence,
      scores,
      seriesId: "series-collision",
      seriesName: "碰撞系列",
      episodeNumber: 1,
    });

    await assert.rejects(
      () => inbox.adopt(trendCandidate.id, { origin: "trend" }),
      /另一个创作入口/,
    );
  });

  it("combines classified trend and series candidates, filters facets, and adopts exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-topic-inbox-"));
    const now = () => new Date("2026-08-24T09:00:00.000Z");
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
      now,
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      now,
      createId: () => "series-1",
      planningAgent: passingGreenlightAgent(),
    });
    await series.create({
      name: "AI 下班实验室",
      premise: "每集验证一个普通人下班后真能用上的 AI 方法。",
      audience: "想节省时间的普通上班族",
      platform: "douyin",
      category: "technology",
      track: "ai-after-work",
      pillars: ["真实任务实验", "成本与时间复盘"],
      tone: "克制、具体、有结论",
      visualStyle: "真实桌面操作与生活空镜",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [trendCandidate] },
      series,
      opportunities,
      now,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const all = await inbox.list({});
    const filtered = await inbox.list({ origins: ["trend"], categories: ["technology"], platforms: ["douyin"] });

    assert.equal(all.items.length, 7);
    assert.equal(all.facets.origins.trend, 1);
    assert.equal(all.facets.origins.series, 6);
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0]?.category, "technology");
    assert.equal(filtered.items[0]?.freshness, "live");
    assert.equal(filtered.items[0]?.editorialDecision.verdict, "produce_video");

    const seriesCandidate = all.items.find((item) => item.origin === "series")!;
    const adopted = await inbox.adopt(seriesCandidate.id, { origin: "series" });

    assert.equal(adopted.id, seriesCandidate.id);
    assert.equal(adopted.origin, "series");
    assert.equal(adopted.editorialDecision?.verdict, "produce_video");
    assert.equal(adopted.seriesId, "series-1");
    assert.equal((await series.list())[0]?.nextEpisodeNumber, 2);
    const remaining = await inbox.list({ origins: ["series"] });
    assert.equal(remaining.items.some((item) => item.id === seriesCandidate.id), false);
    assert.equal(remaining.items.length, 6);
    assert.deepEqual(
      remaining.items.map((item) => item.episodeNumber).sort((left, right) => (left ?? 0) - (right ?? 0)),
      [2, 3, 4, 5, 6, 7],
    );
    assert.equal(remaining.items.find((item) => item.episodeNumber === 7)?.seriesSequence?.status, "blocked");
  });

  it("recovers a blocked public series episode through persisted source supplements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-supplement-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({
      series: new JsonSeriesStore(path.join(root, "series.json")),
      planningAgent: {
        reviewEpisode: async (_series: StudioSeries, episode: StudioSeriesEpisode) => ({
          draft: {
            episodeNumber: episode.episodeNumber,
            pillar: episode.pillar,
            title: episode.episodeNumber === 1 ? "台风伤亡消息持续更新" : episode.title,
            viewerPromise: episode.viewerPromise,
            hook: episode.hook,
            payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious],
            toNext: [...episode.continuity.toNext],
          },
          planning: {
            source: "agent" as const,
            role: "系列开拍总编",
            auditRole: "独立质量审计 Agent",
            auditStatus: "passed" as const,
            auditIterations: 1,
            providerId: "codex-series-planner-v1",
            modelId: "codex-default",
            promptVersion: "video-factory/series-greenlight-v1",
          },
        }),
      },
    });
    await series.create({
      name: "台风事实台账",
      premise: "每集核对一条公共事件的原始来源。",
      audience: "需要辨别信息的中文观众",
      platform: "douyin",
      category: "society",
      track: "fact-review",
      pillars: ["来源核验"],
      tone: "克制",
      visualStyle: "证据图解",
    });
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => [] },
      series,
      opportunities,
      publishedTemplates: async () => BUILTIN_TEMPLATES,
    });

    const [blocked] = (await inbox.list({ origins: ["series"], limit: 1 })).items;
    assert.equal(blocked?.verification.status, "blocked");
    assert.equal(blocked?.verification.independentSources, 0);

    // 路线图 URL 与同域名链接都不是新的独立来源：保存成功但门槛仍不通过。
    const roadmapUrl = `https://video.wangjinkun333.me/topics?mode=series&candidate=${encodeURIComponent(blocked!.id)}`;
    const stillBlocked = await inbox.supplementCandidateSources(blocked!.id, {
      evidenceUrls: [roadmapUrl, "https://news.example.cn/first"],
      origin: "series",
    });
    assert.equal(stillBlocked.verification.status, "blocked");
    assert.equal(stillBlocked.verification.independentSources, 1);

    // 幂等：重复保存同一 URL 不产生重复证据，也不改写顺序。
    const deduped = await inbox.supplementCandidateSources(blocked!.id, {
      evidenceUrls: ["https://news.example.cn/first"],
      origin: "series",
    });
    assert.equal(deduped.evidence.filter((item) => item.evidenceUrl === "https://news.example.cn/first").length, 1);

    // 第二个独立域名把单集恢复到“人工核验后可采用”。
    const recovered = await inbox.supplementCandidateSources(blocked!.id, {
      evidenceUrls: ["https://police.example.cn/notice"],
      origin: "series",
    });
    assert.equal(recovered.verification.status, "review_required");
    assert.equal(recovered.verification.independentSources, 2);
    assert.notEqual(recovered.editorialDecision.recommendedTemplate, undefined);

    // 补充来源持久化在单集计划上：重新打开存储仍可读到（路线图 URL 留档保存，只在门禁计算时排除）。
    const persisted = (await new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) }).list())[0];
    assert.deepEqual(
      persisted?.episodes[0]?.supplementSources?.evidenceUrls,
      [roadmapUrl, "https://news.example.cn/first", "https://police.example.cn/notice"],
    );

    // 跨入口：以热点入口补充系列候选必须失败关闭，不串写另一个持久层。
    await assert.rejects(
      () => inbox.supplementCandidateSources(blocked!.id, { evidenceUrls: ["https://other.example.org/x"], origin: "trend" }),
      /没有启用热点候选来源补充/,
    );

    // 恢复后的采用仍需人工核验，并携带补充证据。
    await assert.rejects(() => inbox.adopt(blocked!.id, { origin: "series" }), /确认核验/);
    const adopted = await inbox.adopt(blocked!.id, { origin: "series", verificationConfirmed: true });
    assert.equal(adopted.origin, "series");
    assert.equal(adopted.evidence.some((item) => item.evidenceUrl === "https://police.example.cn/notice"), true);
  });
});

function passingGreenlightAgent() {
  return {
    generate: async () => { throw new Error("Use the editable rule fallback for the initial roadmap."); },
    reviewEpisode: async (_series: StudioSeries, episode: StudioSeriesEpisode) => ({
      draft: {
        episodeNumber: episode.episodeNumber,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        fromPrevious: [...episode.continuity.fromPrevious],
        toNext: [...episode.continuity.toNext],
      },
      planning: {
        source: episode.planning.source === "human" ? "human" as const : "agent" as const,
        role: "系列开拍总编",
        auditRole: "独立质量审计 Agent",
        auditStatus: "passed" as const,
        auditIterations: 1,
        providerId: "codex-series-planner-v1",
        modelId: "codex-default",
        promptVersion: "video-factory/series-greenlight-v1",
      },
    }),
  };
}
