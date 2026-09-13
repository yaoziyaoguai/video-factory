import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskExecution, type CodexTaskKind } from "@video-factory/production-pipeline";
import {
  CodexTopicIdeaModel,
  TrendOpportunityAgent,
  type TrendIdeaModel,
} from "../src/server/trend-opportunity-agent.js";
import { decideEditorialFormat } from "../src/server/editorial-decision.js";
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


// CG-07：topic-ideas 校验器 v5 起强制要求每个 idea 携带具体视觉方案；纯 payload 捕获类
// fixture 用这个最小合规方案补齐。
const MINIMAL_FIXTURE_VISUAL_PLAN = {
  strategy: "用前后对照呈现验证过程。",
  beats: [{
    id: "contrast-beat",
    role: "结果兑现",
    duration: "0-6 秒",
    description: "同一对象调整前后的对照画面。",
    searchQuery: "before after close up",
    source: "creator" as const,
  }],
};

const modelSignals = signals.map((signal) => ({ ...signal, relatedSignals: [] }));

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
        visualProof: "用同一本时间账本呈现调整前后的差异。",
        visualPlan: {
          strategy: "用同一本时间账本贯穿前后对比。",
          beats: [{
            id: "ledger-contrast",
            role: "实物对照",
            duration: "0-6 秒",
            description: "同一只手在同一页纸上圈出被重复安排占用的时间。",
            searchQuery: "paper planner hand close up",
            source: "creator",
          }],
        },
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));
    const model = new CodexTopicIdeaModel(codexClient);

    const ideas = await model.generate(modelSignals);

    assert.equal(model.id, "api-topic-editor-v1");
    assert.equal(ideas[0]?.title, "下班后的 AI 时间账本");
    assert.equal(ideas[0]?.visualPlan?.beats[0]?.id, "ledger-contrast");
    assert.equal(codexClient.calls.length, 2);
    assert.equal(codexClient.calls[0]?.kind, "topic-ideas");
    assert.equal(codexClient.calls[1]?.kind, "role-audit");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.equal("directive" in payload, false);
    assert.deepEqual(Object.keys(payload), ["signals"]);
    assert.deepEqual(payload.signals, [
      {
        id: "signal-ai",
        sourceId: "dailyhot",
        platform: "douyin",
        rank: 2,
        title: "普通人开始用 AI 管理下班后的时间",
        heat: 9_800_000,
        url: "https://example.com/ai",
        collectedAt: "2026-08-24T08:00:00.000Z",
        relatedSignals: [],
      },
      {
        id: "signal-weather",
        sourceId: "newsnow",
        platform: "weibo",
        rank: 1,
        title: "台风路径发生变化",
        heat: null,
        url: "https://example.com/weather",
        collectedAt: "2026-08-24T08:01:00.000Z",
        relatedSignals: [],
      },
    ]);
    const auditPayload = codexClient.calls[1]!.payload as {
      context: {
        roleScope: { owns: string[] };
        currentRoleContract: Record<string, unknown>;
        downstreamBoundary: string;
      };
    };
    assert.equal(auditPayload.context.roleScope.owns.includes("ideas.audience"), true);
    assert.equal(auditPayload.context.roleScope.owns.includes("ideas.painPoint"), true);
    assert.equal(auditPayload.context.roleScope.owns.includes("ideas.visualPlan"), true);
    assert.equal(auditPayload.context.currentRoleContract.sourceGateAppliedDownstream, true);
    assert.equal(auditPayload.context.currentRoleContract.sourceBlockedIdeasRemainVisibleForSupplement, true);
    assert.equal(auditPayload.context.currentRoleContract.emptyIdeasCannotBeJustifiedSolelyByMissingSourceCount, true);
    assert.match(auditPayload.context.downstreamBoundary, /来源不足.*保留为可补源候选/);
  });

  it("serializes related reports under the canonical signal instead of flattening secondary ids", async () => {
    const related = {
      id: "signal-ai-independent",
      sourceId: "newsnow",
      platform: "toutiao",
      title: "媒体观察普通人用 AI 管理业余时间",
      rank: 7,
      collectedAt: "2026-08-24T08:02:00.000Z",
      url: "https://independent.example.org/ai-time",
    } satisfies StudioTrendSignal;
    const codexClient = new CapturingCodexClient(() => ({
      ideas: [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "先看它是否真的节省时间。",
        rationale: "适合做低成本生活实验。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));

    await new CodexTopicIdeaModel(codexClient).generate([{ ...signals[0]!, relatedSignals: [related] }]);

    const payload = codexClient.calls[0]!.payload as { signals: Array<{ id: string; relatedSignals: StudioTrendSignal[] }> };
    assert.equal(payload.signals.length, 1);
    assert.equal(payload.signals[0]?.id, "signal-ai");
    assert.deepEqual(payload.signals[0]?.relatedSignals, [{
      id: "signal-ai-independent",
      sourceId: "newsnow",
      platform: "toutiao",
      rank: 7,
      title: "媒体观察普通人用 AI 管理业余时间",
      heat: null,
      url: "https://independent.example.org/ai-time",
      collectedAt: "2026-08-24T08:02:00.000Z",
    }]);
  });

  it("turns the structured creator strategy into a bounded self-contained editorial instruction", async () => {
    const codexClient = new CapturingCodexClient(() => ({
      ideas: [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "真正偷走你下班时间的，可能不是加班。",
        rationale: "适合做低成本生活实验。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));
    const model = new CodexTopicIdeaModel(codexClient);

    await model.generate(modelSignals, {
      positioning: "替普通人解释技术变化。",
      targetAudience: "关注 AI 但不想看营销稿的职场人。",
      preferredDirections: "真实工作影响\n可复现实验",
      excludedDirections: "只有热度没有证据",
      sourcePolicy: "primary_or_two_independent",
      customInstruction: "必须能在 30 秒内兑现标题承诺。",
    });

    const payload = codexClient.calls[0]!.payload as { creatorStrategy?: string };
    assert.match(payload.strategy ?? "", /内容定位：替普通人解释技术变化/);
    assert.match(payload.strategy ?? "", /核心受众：关注 AI 但不想看营销稿的职场人/);
    assert.match(payload.strategy ?? "", /优先题材：\n真实工作影响\n可复现实验/);
    assert.match(payload.strategy ?? "", /来源开工门槛由下游执行/);
    assert.match(payload.strategy ?? "", /来源不足但内容与视觉潜力成立的角度仍须输出/);
    assert.doesNotMatch(payload.strategy ?? "", /才进入制作推荐/);
    assert.match(payload.strategy ?? "", /必须能在 30 秒内兑现标题承诺/);
    assert.equal((payload.strategy ?? "").length <= 6_000, true);
  });

  it("keeps the source gate downstream when an older strategy has no source policy", async () => {
    const codexClient = new CapturingCodexClient(() => ({
      ideas: [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "先看它是否真的节省时间。",
        rationale: "适合做低成本生活实验。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));
    const model = new CodexTopicIdeaModel(codexClient);

    await model.generate(modelSignals, { customInstruction: "" });

    const payload = codexClient.calls[0]!.payload as { creatorStrategy?: string };
    assert.match(payload.strategy ?? "", /来源开工门槛由下游执行/);
    assert.match(payload.strategy ?? "", /来源不足.*仍须输出/);
  });

  it("keeps the final custom rule after all bounded strategy fields", async () => {
    const codexClient = new CapturingCodexClient(() => ({
      ideas: [{
        signalId: "signal-ai",
        title: "下班后的 AI 时间账本",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "工具很多，却没有减少疲惫",
        hook: "真正偷走你下班时间的，可能不是加班。",
        rationale: "适合做低成本生活实验。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
      }],
    }));
    const model = new CodexTopicIdeaModel(codexClient);

    await model.generate(modelSignals, {
      positioning: "定".repeat(500),
      targetAudience: "众".repeat(500),
      preferredDirections: "优".repeat(1_000),
      excludedDirections: "避".repeat(1_000),
      sourcePolicy: "primary_or_two_independent",
      customInstruction: "最后这条原则不能丢失。".repeat(100),
    });

    const payload = codexClient.calls[0]!.payload as { creatorStrategy?: string };
    assert.match(payload.strategy ?? "", /最后这条原则不能丢失/);
    assert.equal((payload.strategy ?? "").length <= 6_000, true);
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
    assert.equal(candidates[0]?.visualPlan?.beats.some((beat) => beat.source === "local-card"), false);
  });

  it("keeps multiple genuinely different angles for the same canonical event and dedupes repeated angles", async () => {
    // C3-E01：同一热点发散出三个受众/收益都不同的方向——全部保留，不按 signalId 吞掉；
    // 第四个 idea 是重复角度（标题/受众/题材与第一条相同），去重后不出现第二份。
    const idea = (title: string, audience: string, hook: string) => ({
      signalId: "signal-ai",
      title,
      track: "ai-daily-life",
      audience,
      painPoint: "工具很多，却没有减少疲惫",
      hook,
      rationale: "热点有规模，且能转化为低成本生活实验。",
      novelty: 85,
      seriesPotential: 88,
      monetization: 72,
    });
    const model: TrendIdeaModel = {
      id: "api-topic-editor-v1",
      generate: async () => [
        idea("下班后的 AI 时间账本", "想提高生活掌控感的上班族", "真正偷走你下班时间的，可能不是加班。"),
        // 重复角度：标题/受众/题材与第一条完全一致。
        idea("下班后的 AI 时间账本", "想提高生活掌控感的上班族", "真正偷走你下班时间的，可能不是加班。"),
        idea("AI 帮长辈识破仿冒来电", "家里有老人的子女", "长辈接到的陌生来电，可能一秒就能被 AI 拆穿。"),
        idea("小团队的 AI 排班实验", "自己开店的小微店主", "三个人的店，用 AI 排班后谁的任务变轻了。"),
      ],
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model,
      now: () => new Date("2026-08-24T08:05:00.000Z"),
    });

    const candidates = await agent.listCandidates();
    const titles = candidates.map((candidate) => candidate.title);
    assert.equal(candidates.length, 3, "three distinct angles must all survive");
    assert.ok(titles.includes("下班后的 AI 时间账本"));
    assert.ok(titles.includes("AI 帮长辈识破仿冒来电"));
    assert.ok(titles.includes("小团队的 AI 排班实验"));
    // 三个方向的 candidateId 各不相同（同一事件下的不同 angleId）。
    assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, 3);
    // 受众各不相同：发散的是受众与收益，不只是换标题。
    assert.equal(new Set(candidates.map((candidate) => candidate.audience)).size, 3);
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
        visualProof: "实拍同一位上班族整理日程前后的操作和时间对比，动作变化比文字解释更直观。",
        visualPlan: {
          strategy: "同一张纸质时间账本贯穿全片，让前后差异可核对。",
          beats: [{
            id: "before-after-ledger",
            role: "前后对照",
            duration: "0-6 秒",
            description: "俯拍同一只手先划掉三项重复安排，再把省下的二十分钟圈成红色。",
            searchQuery: "paper schedule hand before after",
            source: "creator" as const,
          }],
        },
        visualFeasibility: 91,
        productionCostEfficiency: 94,
        novelty: 85,
        seriesPotential: 88,
        monetization: 72,
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
    assert.equal(candidate?.score.visualFeasibility, 91);
    assert.equal(candidate?.score.productionCostEfficiency, 94);
    assert.match(candidate?.rationale ?? "", /热点有规模，且能转化为低成本生活实验/);
    assert.doesNotMatch(candidate?.rationale ?? "", /可见画面/);
    assert.equal(candidate?.visualProof, "实拍同一位上班族整理日程前后的操作和时间对比，动作变化比文字解释更直观。");
    assert.equal(candidate?.visualPlan?.strategy, "同一张纸质时间账本贯穿全片，让前后差异可核对。");
    assert.equal(candidate?.visualPlan?.beats[0]?.id, "before-after-ledger");
    assert.match(candidate?.visualPlan?.beats[0]?.description ?? "", /划掉三项重复安排/);
    assert.equal(candidate?.evidence[0]?.evidenceUrl, "https://example.com/ai");
    assert.equal(candidate?.generatedAt, "2026-08-24T08:05:00.000Z");
  });

  it("preserves zero-to-one-hundred model scores without inventing defaults or percentage scaling", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "下班后的 AI 时间账本",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "工具很多，却没有减少疲惫",
          hook: "先看它是否真的节省时间。",
          rationale: "对照日程变化，判断工具是否真正减少重复安排。",
          visualProof: "同一页日程展示调整前后的可见差异。",
          novelty: 0,
          seriesPotential: 1,
          monetization: 2,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.score.novelty, 0);
    assert.equal(candidate?.score.seriesPotential, 1);
    assert.equal(candidate?.score.monetization, 2);
  });

  it("keeps a deliberately small editorial desk when the model only selects a few ideas", async () => {
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
          visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
          novelty: 85,
          seriesPotential: 88,
          monetization: 72,
        }],
      },
    });

    const candidates = await agent.listCandidates();

    assert.equal(requestedLimit, 160);
    assert.equal(candidates.length, 1);
    assert.equal(candidates.some((candidate) => candidate.providerId === "api-topic-editor-v1"), true);
    assert.equal(candidates.some((candidate) => candidate.providerId === "trend-heuristic-v1"), false);
  });

  it("does not drown a grounded model idea in higher-scoring rule filler", async () => {
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

    assert.equal(candidates.length, 1);
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

  it("sends one canonical signal id with nested cross-domain reports to the topic editor", async () => {
    const groupedSignals: StudioTrendSignal[] = [
      {
        id: "signal-help-primary",
        sourceId: "dailyhot",
        platform: "weibo",
        title: "官方确认帮扶老人遭索赔店主不担责",
        rank: 1,
        collectedAt: "2026-08-24T08:00:00.000Z",
        url: "https://primary.example.cn/help",
      },
      {
        id: "signal-help-secondary",
        sourceId: "newsnow",
        platform: "toutiao",
        title: "央媒评扶老人被索赔：法律不能和稀泥",
        rank: 2,
        collectedAt: "2026-08-24T08:01:00.000Z",
        url: "https://independent.example.org/report",
      },
    ];
    let receivedSignals: Array<StudioTrendSignal & { relatedSignals?: StudioTrendSignal[] }> = [];
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => groupedSignals },
      model: {
        id: "api-topic-editor-v1",
        generate: async (modelSignals) => {
          receivedSignals = modelSignals;
          return [{
            signalId: "signal-help-primary",
            title: "扶老人被索赔：普通人该如何保留善意证据？",
            track: "public-interest",
            audience: "关心公共议题的普通人",
            painPoint: "想帮助别人，又担心责任说不清",
            hook: "善意之后，怎样留下能说清责任的证据？",
            rationale: "同一事件已有不同媒体报道，适合转成普通人可执行的证据意识选题。",
            visualProof: "用可复现的求助场景和证据留存步骤展示行动前后的差别。",
            visualFeasibility: 82,
            productionCostEfficiency: 88,
            novelty: 80,
            seriesPotential: 76,
            monetization: 40,
          }];
        },
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(receivedSignals.length, 1);
    assert.equal(receivedSignals[0]?.id, "signal-help-primary");
    assert.deepEqual(receivedSignals[0]?.relatedSignals?.map((item) => item.id), ["signal-help-secondary"]);
    assert.deepEqual(candidate?.evidence.map((item) => item.evidenceUrl), [
      "https://primary.example.cn/help",
      "https://independent.example.org/report",
    ]);
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

    assert.equal(candidates.length, 12);
    assert.equal(counts.missing, undefined);
    assert.equal(Math.max(...Object.values(counts)) <= 20, true);
    assert.equal(Object.keys(counts).length, 6);
  });

  it("falls back deterministically when the semantic model fails", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model: { id: "api-topic-editor-v1", generate: async () => { throw new Error("model offline"); } },
      now: () => new Date("2026-09-12T10:00:00.000Z"),
    });

    const candidates = await agent.listCandidates({ generationNonce: "fallback-generation-1" });

    assert.equal(candidates[0]?.providerId, "trend-heuristic-v1");
    assert.match(candidates[0]?.rationale ?? "", /排名/);
    assert.deepEqual(agent.generationReceipt(), {
      generationId: "fallback-generation-1",
      generatedAt: "2026-09-12T10:00:00.000Z",
      modelInvoked: true,
      source: "rule-fallback",
      candidateCount: candidates.length,
      failureCategory: "model_error",
      failureReason: "model offline",
    });
  });

  it("does not let a vague rule fallback become producible when the semantic model fails", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [{
        id: "signal-vague",
        sourceId: "dailyhot",
        platform: "douyin",
        title: "今日热搜来了",
        rank: 1,
        heat: 9_900_000,
        collectedAt: "2026-08-24T08:00:00.000Z",
        url: "https://example.com/vague",
      }] },
      model: { id: "api-topic-editor-v1", generate: async () => { throw new Error("model offline"); } },
    });

    const [candidate] = await agent.listCandidates();
    const decision = decideEditorialFormat({
      ...candidate!,
      origin: "trend",
      category: candidate!.category!,
      freshness: "live",
      risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["来源可打开。"] },
    }, []);

    assert.equal(candidate?.providerId, "trend-heuristic-v1");
    assert.equal(decision.verdict, "skip");
    assert.match(decision.reasons.join(" "), /标题没有形成可判断的具体问题/);
  });

  it("treats a legally empty model shortlist as no recommendation without a second call or rule backfill", async () => {
    let modelCalls = 0;
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => {
          modelCalls += 1;
          return [];
        },
      },
      now: () => new Date("2026-09-12T10:01:00.000Z"),
    });

    const candidates = await agent.listCandidates({ generationNonce: "empty-generation-1" });

    // 模型成功返回空就是“本轮无值得推荐”：不二次调用，也不回填规则候选冒充推荐。
    assert.equal(modelCalls, 1);
    assert.deepEqual(candidates, []);
    assert.deepEqual(agent.generationReceipt(), {
      generationId: "empty-generation-1",
      generatedAt: "2026-09-12T10:01:00.000Z",
      modelInvoked: true,
      source: "editor-model",
      candidateCount: 0,
      providerId: "api-topic-editor-v1",
    });
  });

  it("keeps a single-source high-potential idea visible for downstream source supplementation", async () => {
    let receivedRelatedCount = -1;
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      strategy: async () => ({
        positioning: "解释技术如何影响普通人的生活",
        targetAudience: "普通上班族",
        preferredDirections: "可复现实验",
        excludedDirections: "",
        sourcePolicy: "primary_or_two_independent",
        customInstruction: "",
      }),
      model: {
        id: "api-topic-editor-v1",
        generate: async (receivedSignals) => {
          receivedRelatedCount = receivedSignals[0]?.relatedSignals.length ?? -1;
          return [{
            signalId: "signal-ai",
            title: "下班后的 AI 时间实验",
            track: "ai-daily-life",
            audience: "普通上班族",
            painPoint: "工具很多，却没有减少疲惫",
            hook: "它真的帮你省下了下班时间吗？",
            rationale: "内容与画面潜力成立，应保留角度供下游继续补充来源。",
            visualProof: "实拍整理日程前后的操作与耗时变化。",
            visualFeasibility: 90,
            productionCostEfficiency: 92,
            novelty: 82,
            seriesPotential: 86,
            monetization: 68,
          }];
        },
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(receivedRelatedCount, 0);
    assert.equal(candidate?.title, "下班后的 AI 时间实验");
    assert.equal(candidate?.evidence.length, 1);
    assert.equal(candidate?.evidence[0]?.evidenceUrl, "https://example.com/ai");
  });

  it("applies explicit creator preferences to rule-fallback selection", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model: { id: "api-topic-editor-v1", generate: async () => { throw new Error("model offline"); } },
      strategy: async () => ({
        positioning: "只解释能让普通人采取行动的变化",
        targetAudience: "不想看营销稿的职场人",
        preferredDirections: "AI 工作效率",
        excludedDirections: "台风",
        sourcePolicy: "primary_or_two_independent",
        customInstruction: "",
      }),
    });

    const candidates = await agent.listCandidates();

    assert.equal(candidates.length, 1);
    assert.equal(candidates.some((candidate) => candidate.title.includes("台风")), false);
    assert.equal(candidates.every((candidate) => candidate.audience === "不想看营销稿的职场人"), true);
    assert.equal(candidates.every((candidate) => candidate.painPoint.includes("只解释能让普通人采取行动的变化")), true);
  });

  it("ranks an explicitly preferred direction ahead of a higher generic score", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => signals },
      model: { id: "api-topic-editor-v1", generate: async () => { throw new Error("model offline"); } },
      strategy: async () => ({
        positioning: "解释热点对普通人的影响",
        targetAudience: "普通观众",
        preferredDirections: "台风",
        excludedDirections: "",
        sourcePolicy: "primary_or_two_independent",
        customInstruction: "",
      }),
    });

    const candidates = await agent.listCandidates();

    assert.match(candidates[0]?.title ?? "", /台风/);
    assert.ok((candidates[0]?.score.final ?? 0) < (candidates[1]?.score.final ?? 0));
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

  it("keeps evergreen method-structure quantities in non-news titles without a source number", async () => {
    // CG-05：常青教程的"3 步"是视频自身组织结构，不是事件事实——不要求热点标题提供。
    const model: TrendIdeaModel = {
      id: "api-topic-editor-v1",
      generate: async () => [{
        signalId: "signal-ai",
        title: "用3步整理被 AI 打乱的桌面文件",
        track: "ai-daily-life",
        audience: "被文件塞满桌面的上班族",
        painPoint: "桌面越用越乱，找不到要用的文件",
        hook: "桌面乱不是你的问题，是方法的问题。",
        rationale: "热点有讨论度，整理方法可以常青复用。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 80,
        seriesPotential: 70,
        monetization: 60,
      }],
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model,
      now: () => new Date("2026-08-24T08:05:00.000Z"),
    });
    const candidates = await agent.listCandidates();
    assert.equal(candidates.length, 1, "a legitimate 3-step evergreen structure must not be rejected");
    assert.match(candidates[0]?.title ?? "", /3步/);
  });

  it("blocks an unsupported factual premise even when it hides behind a question mark", async () => {
    // CG-05：高风险事件里"断言 + 问句"的组合——"救援已经结束"是新增事实，不能因
    // 同句带问号就整体豁免；必须回退到只引用原始信号的保守核验问句。
    const model: TrendIdeaModel = {
      id: "api-topic-editor-v1",
      generate: async () => [{
        signalId: "signal-quake",
        title: "救援已经结束，为何还要持续关注？",
        track: "breaking-news",
        audience: "关注救灾进展的公众",
        painPoint: "信息混乱，难以判断进展",
        hook: "救援已经结束，为何还要持续关注？",
        rationale: "热点关注度极高。",
        visualPlan: MINIMAL_FIXTURE_VISUAL_PLAN,
        novelty: 90,
        seriesPotential: 60,
        monetization: 40,
      }],
    };
    const quakeSignal: StudioTrendSignal = {
      id: "signal-quake",
      sourceId: "newsnow",
      platform: "weibo",
      title: "某地地震救援进展",
      rank: 1,
      collectedAt: "2026-08-24T08:00:00.000Z",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [quakeSignal] },
      model,
      now: () => new Date("2026-08-24T08:05:00.000Z"),
    });
    const candidates = await agent.listCandidates();
    assert.equal(candidates.length, 1, "the high-risk idea degrades to a grounded question instead of disappearing");
    const title = candidates[0]?.title ?? "";
    assert.doesNotMatch(title, /已经结束/, "the fabricated premise must not survive grounding");
    assert.doesNotMatch(candidates[0]?.rationale ?? "", /救援已经结束/);
  });

  it("rejects model ideas that add unsupported numbers, quotes, or interview claims", async () => {
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

    const candidates = await agent.listCandidates();

    // 含原信号没有的数字、引语或采访假设的 idea 被拒绝，不再用机械标题顶替后绕过复核。
    assert.deepEqual(candidates, []);
    assert.equal(candidates.some((candidate) => candidate.providerId === "trend-heuristic-v1"), false);
  });

  it("rejects unsupported factual numbers hidden inside the visual plan", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "下班后的 AI 时间账本",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "工具很多，却没有减少疲惫",
          hook: "先看它是否真的节省时间。",
          rationale: "用可见日程对照解释热点。",
          visualProof: "同一页日程展示调整前后的差异。",
          visualPlan: {
            strategy: "用日程页面形成前后对照。",
            beats: [{
              id: "unsupported-saving",
              role: "结果兑现",
              duration: "0-6 秒",
              description: "日程页显示使用 AI 后每天省下 20 分钟。",
              searchQuery: "paper schedule comparison",
              source: "creator",
            }],
          },
          novelty: 80,
          seriesPotential: 80,
          monetization: 60,
        }],
      },
    });

    assert.deepEqual(await agent.listCandidates(), []);
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

    const candidates = await agent.listCandidates();

    // 新增英文专名与 clickbait 属于事实越界，整个 idea 被拒绝而不是被机械改写。
    assert.deepEqual(candidates, []);
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
          visualProof: "把未经来源确认的伤亡数字做成动态图表。",
          visualPlan: {
            strategy: "用未经来源确认的伤亡数字制造冲击。",
            beats: [{
              id: "invented-casualty-chart",
              role: "冲击钩子",
              duration: "0-8 秒",
              description: "动态图表展示未经来源确认的伤亡数字。",
              searchQuery: "casualty chart",
              source: "generated",
            }],
          },
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
    assert.doesNotMatch(JSON.stringify(candidate?.visualPlan), /invented-casualty-chart|伤亡数字/);
  });

  it("keeps a grounded editorial question for a high-risk event instead of replacing it just for being sensitive", async () => {
    const typhoonSignal: StudioTrendSignal = {
      id: "signal-typhoon-school",
      sourceId: "dailyhot",
      platform: "douyin",
      title: "台风登陆广东多地停课",
      rank: 2,
      collectedAt: "2026-08-24T08:00:00.000Z",
      url: "https://example.com/typhoon-school",
    };
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [typhoonSignal] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: typhoonSignal.id,
          title: "台风登陆广东多地停课：家长现在该核验哪些学校通知？",
          track: "breaking-news",
          audience: "需要安排接送与居家的广东家长",
          painPoint: "通知来源很多，想先确认学校安排",
          hook: "哪些通知已经能从学校原始渠道核验？",
          rationale: "把公共事件转成家长可执行的来源核验问题。",
          visualProof: "展示学校原始通知、发布时间与适用地区。",
          novelty: 76,
          seriesPotential: 55,
          monetization: 15,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "台风登陆广东多地停课：家长现在该核验哪些学校通知？");
    assert.equal(candidate?.hook, "哪些通知已经能从学校原始渠道核验？");
    assert.doesNotMatch(candidate?.rationale ?? "", /未采用模型扩写/);
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

    // 独立复核通过的编辑标题不会被 grounder 因“敏感”降质，只保留事实边界内的原始字段。
    assert.equal(candidate?.title, "帮扶老人遭索赔：善意与规则如何平衡");
    assert.equal(candidate?.hook, "先核验已经确认的责任边界。");
    assert.equal(candidate?.audience, "关注公共议题的用户");
    assert.match(candidate?.rationale ?? "", /适合做法律常识解释/);
    assert.doesNotMatch(candidate?.rationale ?? "", /高风险|未采用模型扩写|已移除/);
  });

  it("keeps legitimate quotes around original signal phrases instead of rejecting the idea", async () => {
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "“普通人开始用 AI 管理下班后的时间”，到底改变了什么？",
          track: "ai-daily-life",
          audience: "普通上班族",
          painPoint: "工具很多，却没有减少疲惫",
          hook: "热搜里的“AI 管理”，和你有什么关系？",
          rationale: "适合做低成本生活实验。",
          novelty: 82,
          seriesPotential: 86,
          monetization: 70,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    assert.equal(candidate?.title, "“普通人开始用 AI 管理下班后的时间”，到底改变了什么？");
    assert.equal(candidate?.hook, "热搜里的“AI 管理”，和你有什么关系？");
  });

  it("keeps rationale and visual proof separate and sentence-complete instead of a truncated half-sentence", async () => {
    const ordinals = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
    const rationale = ordinals
      .map((ordinal) => `第${ordinal}句话解释这个角度如何帮助普通观众理解热点与自身生活的关系并保持证据边界。`)
      .join("");
    const visualProof = ordinals.slice(0, 5)
      .map((ordinal) => `第${ordinal}个画面展示可核验的操作或对比。`)
      .join("");
    const agent = new TrendOpportunityAgent({
      signals: { listSignals: async () => [signals[0]!] },
      model: {
        id: "api-topic-editor-v1",
        generate: async () => [{
          signalId: "signal-ai",
          title: "下班后的 AI 时间账本",
          track: "ai-daily-life",
          audience: "想提高生活掌控感的上班族",
          painPoint: "工具很多，却没有减少疲惫",
          hook: "真正偷走你下班时间的，可能不是加班。",
          rationale,
          visualProof,
          visualFeasibility: 91,
          productionCostEfficiency: 94,
          novelty: 85,
          seriesPotential: 88,
          monetization: 72,
        }],
      },
    });

    const [candidate] = await agent.listCandidates();

    // 两个长字段分字段保留；即使触发长度上限，也只落在完整句子边界，不出现半句话。
    assert.ok((candidate?.rationale ?? "").length >= 24);
    assert.match(candidate?.rationale ?? "", /。$/);
    assert.doesNotMatch(candidate?.rationale ?? "", /可见画面/);
    assert.equal(typeof candidate?.visualProof, "string");
    assert.ok((candidate?.visualProof ?? "").length > 0);
    assert.match(candidate?.visualProof ?? "", /。$/);
    assert.doesNotMatch(candidate?.visualProof ?? "", /…$/);
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

  it("preserves an all-zero model scorecard", async () => {
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

    assert.equal(candidate?.score.novelty, 0);
    assert.equal(candidate?.score.seriesPotential, 0);
    assert.equal(candidate?.score.monetization, 0);
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
