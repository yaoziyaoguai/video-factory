import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CandidateInboxStudio } from "../src/server/candidate-inbox-studio.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import { OpportunityStudio } from "../src/server/opportunity-studio.js";
import { JsonSeriesStore } from "../src/server/series-store.js";
import { SeriesStudio } from "../src/server/series-studio.js";
import { TrendGateway } from "../src/server/trend-gateway.js";
import { TrendOpportunityAgent, type TrendIdeaModel } from "../src/server/trend-opportunity-agent.js";

// 跨阶段回归：真实 TrendGateway 响应形态 -> 选题模型 -> 当前来源门槛。
// 合同：要么出现至少一个合格推荐，要么明确空推荐/待补来源；
// 来源不足的候选保留内容潜力分，禁止“生成一批再全部伪装成 0 分”。
const DAILYHOT_ITEMS: Record<string, Array<{ title: string; url: string; hot?: number }>> = {
  douyin: [
    { title: "郑钦文晋级网球决赛", url: "https://sports.example.cn/zheng", hot: 9_000_000 },
    { title: "华为新款平板通过3C认证", url: "https://tech.example.cn/huawei-3c", hot: 6_000_000 },
  ],
};
const NEWSNOW_ITEMS: Record<string, Array<{ title: string; url: string }>> = {
  weibo: [{ title: "网球决赛即将开打", url: "https://news.example.org/zheng" }],
};

function gatewayFetcher(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/s") {
      const items = NEWSNOW_ITEMS[url.searchParams.get("id") ?? ""] ?? [];
      return jsonResponse({ updatedTime: "2026-09-07T04:00:00.000Z", items });
    }
    const items = DAILYHOT_ITEMS[url.pathname.replace("/", "")] ?? [];
    return jsonResponse({ code: 200, updateTime: "2026-09-07T04:00:00.000Z", data: items });
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function editorModel(generate: TrendIdeaModel["generate"]): TrendIdeaModel {
  return { id: "api-topic-editor-v1", generate };
}

describe("trend topic pipeline regression", () => {
  it("keeps qualified recommendations and honest pending-source states across gateway, model, and source gate", async () => {
    const gateway = new TrendGateway({ fetcher: gatewayFetcher(), now: () => new Date("2026-09-07T04:05:00.000Z") });
    const model = editorModel(async (signals) => {
      const byTitle = (fragment: string) => signals.find((item) => item.title.includes(fragment))!;
      return [
        {
          signalId: byTitle("郑钦文").id,
          title: "郑钦文四强之后，这场比赛还值得看什么？",
          track: "sports-context",
          audience: "想看懂网球赛事的泛体育观众",
          painPoint: "赛后信息很多，却不知道哪些看点值得追",
          hook: "这一场胜利，到底改变了什么？",
          rationale: "赛事进展有多个独立来源，适合做赛后看点拆解。",
          visualProof: "公开报道页面的比分卡与回合截图并列展示，动作变化比文字直观。",
          visualFeasibility: 88,
          productionCostEfficiency: 86,
          novelty: 82,
          seriesPotential: 80,
          monetization: 62,
          audienceDemand: 70,
        },
        {
          signalId: byTitle("华为").id,
          title: "新设备过审了，该不该等下一批？",
          track: "consumer-tech",
          audience: "准备换设备的普通消费者",
          painPoint: "认证消息很多，却不知道对购买时机的影响",
          hook: "认证进度里，藏着哪些值得等的变化？",
          rationale: "认证进度是可核验的公开信息，适合做购买时机解读。",
          visualProof: "认证页面截图与参数表并列展示，对比比口播更直观。",
          visualFeasibility: 84,
          productionCostEfficiency: 88,
          novelty: 76,
          seriesPotential: 70,
          monetization: 66,
          audienceDemand: 70,
        },
      ];
    });
    const agent = new TrendOpportunityAgent({
      signals: gateway,
      model,
      now: () => new Date("2026-09-07T04:05:00.000Z"),
    });
    const root = await mkdtemp(path.join(tmpdir(), "vf-trend-pipeline-"));
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: () => agent.listCandidates() },
      series: new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) }),
      opportunities: new OpportunityStudio({ opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")) }),
    });

    const listed = await inbox.list({ origins: ["trend"] });

    // 阶段一：真实网关形态的信号被模型转译成候选，分类落在真实类别上。
    assert.equal(listed.items.length, 2);
    const tennis = listed.items.find((item) => item.title.includes("郑钦文"))!;
    const certified = listed.items.find((item) => item.title.includes("新设备过审"))!;
    assert.equal(tennis.category, "health-sports");
    assert.equal(certified.category, "technology");

    // 阶段二：达到当前来源政策的候选进入推荐，而不是全部被伪装成 0 分。
    const shortlisted = listed.items.filter((item) => item.editorialDecision.verdict !== "skip" && item.verification.status !== "blocked");
    assert.equal(shortlisted.length >= 1, true);
    assert.equal(tennis.verification.status, "ready");
    assert.equal(tennis.editorialDecision.verdict, "produce_video");
    assert.equal(tennis.verification.independentSources, 2);

    // 阶段三：来源不足的候选留在“待补来源”，内容潜力分不被抹零冒充质量判断。
    assert.equal(certified.verification.status, "blocked");
    assert.equal(certified.verification.independentSources, 1);
    assert.equal(certified.verification.requiredSources, 2);
    assert.ok(certified.score.final > 0, "blocked candidate must keep its content-potential score");
    assert.match(certified.verification.reasons[0] ?? "", /不同域名的有效原始来源链接/);
  });

  it("surfaces an explicit empty recommendation when the editor model legally returns no ideas", async () => {
    let modelCalls = 0;
    const gateway = new TrendGateway({ fetcher: gatewayFetcher(), now: () => new Date("2026-09-07T04:05:00.000Z") });
    const agent = new TrendOpportunityAgent({
      signals: gateway,
      model: editorModel(async () => {
        modelCalls += 1;
        return [];
      }),
      now: () => new Date("2026-09-07T04:05:00.000Z"),
    });
    const root = await mkdtemp(path.join(tmpdir(), "vf-trend-pipeline-empty-"));
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: () => agent.listCandidates() },
      series: new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) }),
      opportunities: new OpportunityStudio({ opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")) }),
    });

    const listed = await inbox.list({ origins: ["trend"] });

    assert.equal(modelCalls, 1);
    assert.deepEqual(listed.items, []);
    assert.equal(listed.facets.total, 0);
  });

  it("falls back to traceable rule candidates only when the model execution truly fails", async () => {
    const gateway = new TrendGateway({ fetcher: gatewayFetcher(), now: () => new Date("2026-09-07T04:05:00.000Z") });
    const agent = new TrendOpportunityAgent({
      signals: gateway,
      model: editorModel(async () => {
        throw new Error("model offline");
      }),
      now: () => new Date("2026-09-07T04:05:00.000Z"),
    });
    const root = await mkdtemp(path.join(tmpdir(), "vf-trend-pipeline-fallback-"));
    const inbox = new CandidateInboxStudio({
      trends: { listCandidates: () => agent.listCandidates() },
      series: new SeriesStudio({ series: new JsonSeriesStore(path.join(root, "series.json")) }),
      opportunities: new OpportunityStudio({ opportunities: new JsonOpportunityStore(path.join(root, "opportunities.json")) }),
    });

    const listed = await inbox.list({ origins: ["trend"] });

    assert.ok(listed.items.length > 0);
    assert.equal(listed.items.every((item) => item.providerId === "trend-heuristic-v1"), true);
    // 规则保底候选如实标注“未经选题总编”，不会被当成合格推荐。
    assert.equal(listed.items.every((item) => item.editorialDecision.verdict === "skip"), true);
  });
});
