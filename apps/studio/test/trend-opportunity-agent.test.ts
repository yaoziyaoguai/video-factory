import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskExecution, type CodexTaskKind } from "@video-factory/production-pipeline";
import {
  CodexTopicIdeaModel,
  TrendOpportunityAgent,
  type TrendIdeaModel,
} from "../src/server/trend-opportunity-agent.js";
import type { StudioTrendSignal } from "../src/shared/api.js";

const signals: StudioTrendSignal[] = [
  {
    id: "signal-ai",
    sourceId: "dailyhot",
    platform: "douyin",
    title: "普通人开始用 AI 管理下班后的时间",
    rank: 2,
    heat: 9_800_000,
    collectedAt: "2026-08-24T08:00:00.000Z",
    url: "https://example.com/ai",
  },
  {
    id: "signal-weather",
    sourceId: "newsnow",
    platform: "weibo",
    title: "台风路径发生变化",
    rank: 1,
    collectedAt: "2026-08-24T08:01:00.000Z",
    url: "https://example.com/weather",
  },
];

class CapturingCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(private readonly respond: () => unknown) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTask(kind: CodexTaskKind, payload: unknown): Promise<unknown> {
    this.calls.push({ kind, payload });
    return this.respond();
  }

  async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload });
    if (kind === "role-audit") {
      return { output: {
        version: "video-factory/role-audit-v1",
        verdict: "pass",
        score: 92,
        summary: "候选有来源、观众价值与可执行角度。",
        issues: [],
        repairInstructions: [],
      } };
    }
    return { output: this.respond() };
  }
}

describe("TrendOpportunityAgent", () => {
  it("sends a structured topic-ideas task through the codex bridge", async () => {
    const codexClient = new CapturingCodexClient(() => ({
      ideas: [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "真正偷走你下班时间的，可能不是加班。",
        rationale: "适合做低成本生活实验。",
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));
    const model = new CodexTopicIdeaModel(codexClient);

    const ideas = await model.generate(signals);

    assert.equal(model.id, "api-topic-editor-v1");
    assert.equal(ideas[0]?.title, "下班后的 AI 时间账本");
    assert.equal(codexClient.calls.length, 2);
    assert.equal(codexClient.calls[0]?.kind, "topic-ideas");
    assert.equal(codexClient.calls[1]?.kind, "role-audit");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.equal("directive" in payload, false);
    assert.deepEqual(Object.keys(payload), ["signals"]);
    assert.deepEqual(payload.signals, [
      { id: "signal-ai", platform: "douyin", rank: 2, title: "普通人开始用 AI 管理下班后的时间", heat: 9_800_000 },
      { id: "signal-weather", platform: "weibo", rank: 1, title: "台风路径发生变化", heat: null },
    ]);
  });

  it("builds traceable zero-cost candidates when no semantic model is ready", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      now: () => new Date("2026-08-24T08:05:00.000Z"),
    });

    const candidates = await agent.listCandidates();

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.providerId, "trend-heuristic-v1");
    assert.equal(candidates[0]?.evidence[0]?.source, "dailyhot");
    assert.equal(candidates[0]?.evidence[0]?.strength, 98);
    assert.equal(candidates[0]?.score.final > candidates[1]!.score.final, true);
    assert.equal(candidates[1]?.score.complianceRisk > candidates[0]!.score.complianceRisk, true);
    assert.equal(candidates[0]?.visualPlan?.beats.length, 3);
    assert.match(candidates[0]?.visualPlan?.beats[0]?.searchQuery ?? "", /普通人开始用 AI/);
  });

  it("uses a local idea model while preserving source evidence and bounded scores", async () => {
    const model: TrendIdeaModel = {
      id: "api-topic-editor-v1",
      generate: async () => [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "想提高生活掌控感的上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "真正偷走你下班时间的，可能不是加班。",
        rationale: "热点有规模，且能转化为低成本生活实验。",
        novelty: 0.85,
        seriesPotential: 0.88,
        monetization: 0.72,
      }],
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model,
      now: () => new Date("2026-08-24T08:05:00.000Z"),
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "下班后的 AI 时间账本");
    assert.equal(candidate?.hook, "真正偷走你下班时间的，可能不是加班。");
    assert.equal(candidate?.providerId, "api-topic-editor-v1");
    assert.equal(candidate?.score.novelty, 85);
    assert.equal(candidate?.score.seriesPotential, 88);
    assert.equal(candidate?.score.monetization, 72);
    assert.equal(candidate?.evidence[0]?.evidenceUrl, "https://example.com/ai");
    assert.equal(candidate?.generatedAt, "2026-08-24T08:05:00.000Z");
  });

  it("keeps broad rule candidates when the model only selects a few ideas", async () => {
    const broadSignals = Array.from({ length: 18 }, (_, index): StudioTrendSignal => ({
      id: `signal-${index}`,
      sourceId: index % 2 === 0 ? "dailyhot" : "newsnow",
      platform: ["douyin", "weibo", "zhihu", "bilibili", "toutiao", "baidu"][index % 6]!,
      title: index === 0 ? "普通人开始用 AI 管理下班后的时间" : `第 ${index} 条生活热点`,
      rank: index + 1,
      collectedAt: "2026-08-24T08:00:00.000Z",
    }));
    let requestedLimit = 0;
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async (input) => { requestedLimit = input.limit ?? 0; return broadSignals; } },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-0",
          title: "下班后的 AI 时间账本",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "工具很多，却没有减少疲惫",
          hook: "真正偷走你下班时间的，可能不是加班。",
          rationale: "适合做低成本生活实验。",
          novelty: 85,
          seriesPotential: 88,
          monetization: 72,
        }],
      },
    });

    const candidates = await agent.listCandidates();

    assert.equal(requestedLimit, 160);
    assert.equal(candidates.length, 18);
    assert.equal(candidates.some((candidate) => candidate.providerId === "api-topic-editor-v1"), true);
    assert.equal(candidates.some((candidate) => candidate.providerId === "trend-heuristic-v1"), true);
  });

  it("reserves a portfolio slot for a grounded model idea even when many rule scores are higher", async () => {
    const crowdedSignals = Array.from({ length: 60 }, (_, index): StudioTrendSignal => ({
      id: `crowded-${index}`,
      sourceId: "dailyhot",
      platform: "douyin",
      title: `热点信号 ${index}`,
      rank: index + 1,
      collectedAt: "2026-08-24T08:00:00.000Z",
    }));
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => crowdedSignals },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "crowded-0",
          title: "热点背后的普通人选择",
          track: "ordinary-life",
          audience: "普通用户",
          painPoint: "缺少具体判断",
          hook: "先看它和你的选择有什么关系。",
          rationale: "模型提供一个可核验角度。",
          novelty: 1,
          seriesPotential: 1,
          monetization: 1,
        }],
      },
    });

    const candidates = await agent.listCandidates();

    assert.equal(candidates.length, 60);
    assert.equal(candidates.some((candidate) => candidate.providerId === "api-topic-editor-v1"), true);
  });

  it("merges independent sources for the same trend into one candidate", async () => {
    const duplicateSignals: StudioTrendSignal[] = [
      signals[1]!,
      {
        ...signals[1]!,
        id: "signal-weather-2",
        sourceId: "dailyhot",
        platform: "douyin",
        rank: 3,
        url: "https://example.com/weather-2",
      },
    ];
    const agent = new TrendOpportunityAgent({ signals: { listSignals: async () => duplicateSignals } });

    const candidates = await agent.listCandidates();

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.evidence.map((item) => item.source).sort(), ["dailyhot", "newsnow"]);
  });

  it("conservatively merges differently worded reports of the same event", async () => {
    const relatedSignals: StudioTrendSignal[] = [
      {
        id: "signal-help-1",
        sourceId: "dailyhot",
        platform: "weibo",
        title: "官方确认帮扶老人遭索赔店主不担责",
        rank: 1,
        collectedAt: "2026-08-24T08:00:00.000Z",
        url: "https://example.com/help-1",
      },
      {
        id: "signal-help-2",
        sourceId: "newsnow",
        platform: "toutiao",
        title: "央媒评扶老人被索赔：法律不能和稀泥",
        rank: 2,
        collectedAt: "2026-08-24T08:01:00.000Z",
        url: "https://example.com/help-2",
      },
      {
        id: "signal-robot",
        sourceId: "newsnow",
        platform: "baidu",
        title: "中国机器人连刷人类世界纪录",
        rank: 3,
        collectedAt: "2026-08-24T08:01:00.000Z",
      },
    ];
    const agent = new TrendOpportunityAgent({ signals: { listSignals: async () => relatedSignals } });

    const candidates = await agent.listCandidates();

    assert.equal(candidates.length, 2);
    const helpCandidate = candidates.find((candidate) => candidate.evidence.some((item) => item.keyword.includes("帮扶老人")));
    assert.equal(helpCandidate?.evidence.length, 2);
    assert.deepEqual(helpCandidate?.evidence.map((item) => item.source).sort(), ["dailyhot", "newsnow"]);
  });

  it("builds a category-diverse portfolio before filling remaining slots by score", async () => {
    const categories = [
      ["生活方式观察", "douyin"],
      ["AI 模型新进展", "ithome"],
      ["男篮冠军复盘", "hupu"],
      ["大学教育新变化", "zhihu"],
      ["电影导演新作品", "bilibili"],
      ["股票基金市场变化", "36kr"],
    ] as const;
    const broadSignals = categories.flatMap(([title, platform], categoryIndex) =>
      Array.from({ length: 20 }, (_, index): StudioTrendSignal => ({
        id: `diverse-${categoryIndex}-${index}`,
        sourceId: index % 2 === 0 ? "dailyhot" : "newsnow",
        platform,
        title: `${title} ${index}`,
        rank: categoryIndex === 0 ? index + 1 : 40 + categoryIndex * 5 + index,
        collectedAt: "2026-08-24T08:00:00.000Z",
      })),
    );
    const agent = new TrendOpportunityAgent({ signals: { listSignals: async () => broadSignals } });

    const candidates = await agent.listCandidates();
    const counts = candidates.reduce<Record<string, number>>((result, candidate) => {
      const category = candidate.category ?? "missing";
      result[category] = (result[category] ?? 0) + 1;
      return result;
    }, {});

    assert.equal(candidates.length, 60);
    assert.equal(counts.missing, undefined);
    assert.equal(Math.max(...Object.values(counts)) <= 20, true);
    assert.equal(Object.keys(counts).length, 6);
  });

  it("falls back deterministically when the semantic model fails", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model: { id: "api-topic-editor-v1", generate: async () => { throw new Error("model offline"); } },
    });

    const candidates = await agent.listCandidates();

    assert.equal(candidates[0]?.providerId, "trend-heuristic-v1");
    assert.match(candidates[0]?.rationale ?? "", /排名/);
  });

  it("retries one smaller batch when the model returns malformed structured output", async () => {
    let calls = 0;
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => {
          calls += 1;
          if (calls === 1) throw new SyntaxError("invalid JSON");
          return [{
            signalId: "signal-ai",
            title: "下班后的 AI 时间账本",
            track: "ai-daily-life",
            audience: "普通上班族",
            painPoint: "工具很多但没有减少疲惫",
            hook: "先看它是否真的节省时间。",
            rationale: "适合做低成本生活实验。",
            novelty: 82,
            seriesPotential: 86,
            monetization: 68,
          }];
        },
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(calls, 2);
    assert.equal(candidate?.providerId, "api-topic-editor-v1");
  });

  it("removes unsupported numbers, quotes, and interview claims from model output", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "AI 时间管理让效率提升 90%",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "想提升下班后的时间利用率",
          hook: "专家透露：“每天只需 3 分钟，效率提升 90%。”",
          rationale: "90% 是合理估算，采访素材可直接使用。",
          novelty: 82,
          seriesPotential: 86,
          monetization: 70,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.doesNotMatch(candidate?.title ?? "", /90%/);
    assert.doesNotMatch(candidate?.hook ?? "", /专家|90%|3 分钟/);
    assert.match(candidate?.rationale ?? "", /已移除/);
    assert.equal(candidate?.providerId, "api-topic-editor-v1");
  });

  it("rejects unsupported acronyms and clickbait claims in model titles", async () => {
    const sportsSignal: StudioTrendSignal = {
      id: "signal-sports",
      sourceId: "dailyhot",
      platform: "douyin",
      title: "TYL获2026年度总冠军",
      rank: 1,
      collectedAt: "2026-08-24T08:00:00.000Z",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [sportsSignal] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: sportsSignal.id,
          title: "2026冠军内幕：AI训练赛数据的秘密",
          track: "sports-context",
          audience: "泛体育用户",
          painPoint: "想理解赛事结果",
          hook: "想知道冠军背后的原因。",
          rationale: "适合拆解赛事。",
          novelty: 82,
          seriesPotential: 86,
          monetization: 70,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "TYL获2026年度总冠军：这场结果有哪些可核验的看点？");
    assert.doesNotMatch(candidate?.title ?? "", /AI|内幕|秘密/);
    assert.match(candidate?.rationale ?? "", /已移除/);
  });

  it("never exposes model-added facts for high-risk public events", async () => {
    const conflictSignal: StudioTrendSignal = {
      id: "signal-conflict",
      sourceId: "dailyhot",
      platform: "douyin",
      title: "以军空袭叙引发美以冲突",
      rank: 2,
      collectedAt: "2026-08-24T08:00:00.000Z",
      url: "https://example.com/conflict",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [conflictSignal] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: conflictSignal.id,
          title: "以军空袭叙引发冲突，平民伤亡数据未公开",
          track: "breaking-news",
          audience: "关注国际局势的用户",
          painPoint: "想知道伤亡情况",
          hook: "平民伤亡数据仍未公开。",
          rationale: "适合追踪局势升级。",
          novelty: 80,
          seriesPotential: 60,
          monetization: 20,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "以军空袭叙引发美以冲突：目前有哪些信息能够被可靠来源确认？");
    assert.doesNotMatch(candidate?.title ?? "", /伤亡数据/);
    assert.doesNotMatch(candidate?.hook ?? "", /伤亡数据/);
    assert.match(candidate?.rationale ?? "", /未采用模型扩写/);
  });

  it("uses the shared risk taxonomy for violent crime signals", async () => {
    const violentSignal: StudioTrendSignal = {
      id: "signal-violent-crime",
      sourceId: "dailyhot",
      platform: "toutiao",
      title: "以色列黑手党头目遭枪杀现场曝光",
      rank: 2,
      collectedAt: "2026-08-24T08:00:00.000Z",
    };
    const agent = new TrendOpportunityAgent({ signals: { listSignals: async () => [violentSignal] } });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.score.complianceRisk, 72);
    assert.match(candidate?.hook ?? "", /只核验可靠来源/);
  });

  it("describes review-level public events without overstating them as high risk", async () => {
    const reviewSignal: StudioTrendSignal = {
      id: "signal-review-event",
      sourceId: "dailyhot",
      platform: "toutiao",
      title: "店主帮扶老人遭索赔",
      rank: 2,
      collectedAt: "2026-08-24T08:00:00.000Z",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [reviewSignal] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: reviewSignal.id,
          title: "帮扶老人遭索赔：善意与规则如何平衡",
          track: "public-interest",
          audience: "关注公共议题的用户",
          painPoint: "希望理解法律边界",
          hook: "先核验已经确认的责任边界。",
          rationale: "适合做法律常识解释。",
          novelty: 70,
          seriesPotential: 60,
          monetization: 20,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.match(candidate?.rationale ?? "", /需要核验/);
    assert.doesNotMatch(candidate?.rationale ?? "", /高风险/);
  });

  it("treats a public figure death as source-grounded high-risk news", async () => {
    const deathSignal: StudioTrendSignal = {
      id: "signal-public-figure-death",
      sourceId: "dailyhot",
      platform: "douyin",
      title: "全国政协副主席陈武逝世",
      rank: 3,
      collectedAt: "2026-08-24T08:00:00.000Z",
      url: "https://example.com/public-figure-death",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [deathSignal] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: deathSignal.id,
          title: "全国政协副主席陈武逝世，网络曾传其病危",
          track: "breaking-news",
          audience: "关注公共事件的用户",
          painPoint: "想知道病危传言是否真实",
          hook: "网络早已传出病危消息。",
          rationale: "适合追踪病危传言来源。",
          novelty: 70,
          seriesPotential: 30,
          monetization: 10,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "全国政协副主席陈武逝世：目前有哪些信息已得到可靠来源确认？");
    assert.doesNotMatch(candidate?.hook ?? "", /病危|传言/);
    assert.doesNotMatch(candidate?.rationale ?? "", /病危|传言/);
    assert.match(candidate?.rationale ?? "", /未采用模型扩写/);
  });

  it("uses bounded baseline scores when the model returns an all-zero scorecard", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "AI 与下班时间",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "工具很多但依然疲惫",
          hook: "从真实使用场景切入。",
          rationale: "适合做成系列。",
          novelty: 0,
          seriesPotential: 0,
          monetization: 0,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.score.novelty, 64);
    assert.equal(candidate?.score.seriesPotential, 72);
    assert.equal(candidate?.score.monetization, 52);
  });

  it("normalizes an invalid model track before exposing a candidate to the opportunity API", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "普通人的 AI 时间管理",
          track: "AI 与生活",
          audience: "普通上班族",
          painPoint: "工具很多但依然疲惫",
          hook: "先核验它是否真的节省时间。",
          rationale: "适合做成系列。",
          novelty: 80,
          seriesPotential: 85,
          monetization: 60,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.track, "ai-daily-life");
    assert.match(candidate?.track ?? "", /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});
