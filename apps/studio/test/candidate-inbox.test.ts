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
    await assert.rejects(() => inbox.adopt(highRisk.id, { verificationConfirmed: true }), /至少需要 2 个独立来源/);
    await assert.rejects(() => inbox.adopt(review.id, {}), /确认核验/);
    const adopted = await inbox.adopt(review.id, { verificationConfirmed: true });
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

    const adopted = await inbox.adopt(visibleCandidate!.id);

    assert.equal(adopted.id, trendCandidate.id);
    await assert.rejects(() => inbox.adopt(visibleCandidate!.id), /已被采用|已经失效/);
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
    const adopted = await inbox.adopt(seriesCandidate.id);

    assert.equal(adopted.id, seriesCandidate.id);
    assert.equal(adopted.origin, "series");
    assert.equal(adopted.editorialDecision?.verdict, "produce_video");
    assert.equal(adopted.seriesId, "series-1");
    assert.equal((await series.list())[0]?.nextEpisodeNumber, 2);
    assert.equal((await inbox.list({})).items.some((item) => item.id === seriesCandidate.id), false);
  });
});
