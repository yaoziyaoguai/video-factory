import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CandidateInboxStudio } from "../src/server/candidate-inbox-studio.js";
import { OpportunityStudio } from "../src/server/opportunity-studio.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import { SeriesStudio } from "../src/server/series-studio.js";
import { JsonSeriesStore } from "../src/server/series-store.js";
import type { StudioSeries, StudioSeriesEpisode } from "../src/shared/api.js";

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
  evidence: [{
    source: "dailyhot",
    platform: "douyin",
    keyword: "AI 工作流",
    strength: 96,
    collectedAt: "2026-08-24T08:00:00.000Z",
  }],
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
    assert.match(created.episodes[0]?.planning.fallbackReason ?? "", /开拍 Agent/);
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
      /审计 Agent 当前不可用/,
    );
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
    });

    const listed = await inbox.list({ origins: ["trend"] });
    assert.equal(listed.items.find((item) => item.id === highRisk.id)?.verification.status, "blocked");
    assert.equal(listed.items.find((item) => item.id === highRisk.id)?.editorialDecision.verdict, "skip");
    assert.equal(listed.items.find((item) => item.id === review.id)?.verification.status, "review_required");
    assert.equal(listed.items.find((item) => item.id === review.id)?.editorialDecision.verdict, "produce_image_story");
    await assert.rejects(() => inbox.adopt(highRisk.id, { origin: "trend", verificationConfirmed: true }), /至少需要 2 个独立来源/);
    await assert.rejects(() => inbox.adopt(review.id, { origin: "trend" }), /确认核验/);
    const adopted = await inbox.adopt(review.id, { origin: "trend", verificationConfirmed: true });
    assert.equal(adopted.verification?.status, "verified");
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

  it("can adopt a candidate the user saw just before a background trend refresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-refreshed-inbox-"));
    const opportunities = new OpportunityStudio({
      opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")),
    });
    const series = new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) });
    let currentCandidates = [trendCandidate];
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: async () => currentCandidates },
      series,
      opportunities,
    });

    const [visibleCandidate] = (await inbox.list({ origins: ["trend"] })).items;
    currentCandidates = [{ ...trendCandidate, id: "trend-after-refresh", title: "刷新后的另一条候选" }];

    const adopted = await inbox.adopt(visibleCandidate!.id, { origin: "trend" });

    assert.equal(adopted.id, trendCandidate.id);
    await assert.rejects(() => inbox.adopt(visibleCandidate!.id, { origin: "trend" }), /已被采用|已经失效/);
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
        auditRole: "独立红队审计 Agent",
        auditStatus: "passed" as const,
        auditIterations: 1,
        providerId: "codex-series-planner-v1",
        modelId: "codex-default",
        promptVersion: "video-factory/series-greenlight-v1",
      },
    }),
  };
}
