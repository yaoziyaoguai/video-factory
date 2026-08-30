import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskExecution, type CodexTaskKind } from "@video-factory/production-pipeline";
import { CodexSeriesPlanningAgent, parseSeriesRoadmapOutput } from "../src/server/series-planning-agent.js";
import type { SeriesRecord } from "../src/server/series-store.js";

const series: SeriesRecord = {
  id: "series-1",
  name: "AI 下班实验室",
  premise: "每集验证一个普通人下班后真能用上的 AI 方法。",
  audience: "想节省时间的普通上班族",
  platform: "douyin",
  category: "technology",
  track: "ai-after-work",
  pillars: ["真实任务实验", "成本与时间复盘"],
  tone: "克制、具体、有结论",
  visualStyle: "真实桌面操作与生活空镜",
  status: "active",
  revision: 1,
  currentSeason: { number: 1, title: "第一季", arc: "从工具尝鲜走到稳定工作流" },
  bible: { rules: ["必须验证真实任务"], recurringElements: ["桌面操作"], forbiddenChanges: ["不得虚构结果"] },
  canon: { revision: 0, facts: [] },
  episodes: [],
  nextEpisodeNumber: 1,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
};

class RepairingClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
  private productionCount = 0;
  private auditCount = 0;

  constructor() {
    super({ socketPath: "/nonexistent/series-agent.sock" });
  }

  async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload });
    if (kind === "role-audit") {
      this.auditCount += 1;
      return { output: this.auditCount === 1 ? {
        version: "video-factory/role-audit-v1",
        verdict: "repair",
        score: 72,
        summary: "两集承诺重复。",
        issues: [{ severity: "blocking", criterion: "单集独立价值", evidence: "两集 viewerPromise 相同", repairInstruction: "让第二集兑现成本判断" }],
        repairInstructions: ["让第二集兑现成本判断"],
      } : {
        version: "video-factory/role-audit-v1",
        verdict: "pass",
        score: 91,
        summary: "路线图有独立价值并形成递进。",
        issues: [],
        repairInstructions: [],
      } };
    }
    this.productionCount += 1;
    const repaired = this.productionCount > 1;
    return {
      output: { episodes: [
        draft(1, "真实任务实验", "先验证一项真实任务", "看见真实任务能否完成"),
        draft(2, "成本与时间复盘", repaired ? "再核算实际成本" : "再看一项普通任务", repaired ? "得到明确成本判断" : "看见另一项任务能否完成"),
      ] },
      trace: {
        taskKind: "series-roadmap",
        promptVersion: "video-factory/series-showrunner-v1",
        prompt: "series",
        providerId: "openai",
        modelId: "gpt-5.4",
        reasoningEffort: "max",
      },
    };
  }
}

describe("CodexSeriesPlanningAgent", () => {
  it("repairs a roadmap through an independent audit before returning it", async () => {
    const client = new RepairingClient();
    const result = await new CodexSeriesPlanningAgent(client, 3).generate(series, 2);

    assert.deepEqual(client.calls.map((call) => call.kind), ["series-roadmap", "role-audit", "series-roadmap", "role-audit"]);
    assert.equal(result.drafts[1]?.viewerPromise, "得到明确成本判断");
    assert.equal(result.planning.auditStatus, "passed");
    assert.equal(result.planning.auditIterations, 2);
    assert.equal(result.planning.auditScore, 91);
    assert.equal(result.planning.auditSummary, "路线图有独立价值并形成递进。");
    assert.equal(result.planning.modelId, "gpt-5.4");
    assert.equal(result.planning.reasoningEffort, "max");
    const repairPayload = client.calls[2]?.payload as { revision?: unknown };
    assert.ok(repairPayload.revision);
  });

  it("rejects duplicate promises and pillars outside the series bible", () => {
    assert.throws(() => parseSeriesRoadmapOutput({ episodes: [
      draft(1, "未定义支柱", "第一集", "同一个承诺"),
      draft(2, "真实任务实验", "第二集", "同一个承诺"),
    ] }, series.pillars, 1, 2), /unknown pillar/);
    assert.throws(() => parseSeriesRoadmapOutput({ episodes: [
      draft(1, "真实任务实验", "第一集", "同一个承诺"),
      draft(2, "成本与时间复盘", "第二集", "同一个承诺"),
    ] }, series.pillars, 1, 2), /viewer promises must be distinct/);
  });

  it("audits a human episode against the latest canon before changing it", async () => {
    const calls: CodexTaskKind[] = [];
    class PassingClient extends CodexBridgeClient {
      constructor() { super({ socketPath: "/nonexistent/series-greenlight.sock" }); }
      async runTaskDetailed(kind: CodexTaskKind): Promise<CodexTaskExecution> {
        calls.push(kind);
        return {
          output: {
            version: "video-factory/role-audit-v1",
            verdict: "pass",
            score: 94,
            summary: "人工单集与最新正史一致。",
            issues: [],
            repairInstructions: [],
          },
          trace: {
            taskKind: kind,
            promptVersion: "video-factory/role-audit-v1",
            prompt: "audit",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            reasoningEffort: "max",
          },
        };
      }
    }
    const current = {
      ...series,
      revision: 4,
      canon: { revision: 1, facts: [{ id: "fact-1", statement: "第一集已经验证方法 A。", sourceEpisodeId: "episode-1", acceptedAt: "2026-08-24T09:00:00.000Z" }] },
      episodes: [{
        id: "episode-2",
        seriesId: series.id,
        episodeNumber: 2,
        seasonNumber: 1,
        arc: series.currentSeason.arc,
        pillar: "成本与时间复盘",
        title: "人工标题",
        viewerPromise: "给出真实成本",
        hook: "先看账单",
        payoff: "得到成本结论",
        canonBaseRevision: 0,
        status: "planned" as const,
        continuity: { inheritedFromPrevious: ["第一集正式交接：方法 A 已验证。"], fromPrevious: ["承接方法 A"], toNext: ["继续验证边界"], canonChecks: ["不得虚构结果"] },
        planning: {
          source: "human" as const,
          role: "主创手工改写",
          auditRole: "后续制作节点独立审计",
          auditStatus: "human_override" as const,
          auditIterations: 0,
          providerId: "human",
          modelId: "manual",
          promptVersion: "video-factory/series-episode-edit-v1",
        },
        createdAt: "2026-08-24T08:00:00.000Z",
        updatedAt: "2026-08-24T08:30:00.000Z",
      }],
    } satisfies SeriesRecord;

    const result = await new CodexSeriesPlanningAgent(new PassingClient(), 3).reviewEpisode(current, current.episodes[0]);

    assert.deepEqual(calls, ["role-audit"]);
    assert.equal(result.draft.title, "人工标题");
    assert.equal(result.planning.source, "human");
    assert.equal(result.planning.auditIterations, 1);
    assert.equal(result.planning.modelId, "gpt-5.6-sol");
  });

  it("rejects a greenlight agent that rewrites creator-owned continuity requirements", async () => {
    let audits = 0;
    class OverreachingClient extends CodexBridgeClient {
      constructor() { super({ socketPath: "/nonexistent/series-overreach.sock" }); }
      async runTaskDetailed(kind: CodexTaskKind): Promise<CodexTaskExecution> {
        if (kind === "role-audit") {
          audits += 1;
          return { output: {
            version: "video-factory/role-audit-v1",
            verdict: audits === 1 ? "repair" : "pass",
            score: audits === 1 ? 70 : 95,
            summary: audits === 1 ? "需要修订。" : "可以开拍。",
            issues: audits === 1 ? [{
              severity: "blocking",
              criterion: "连续性",
              evidence: "测试越权修订",
              repairInstruction: "修订计划",
            }] : [],
            repairInstructions: audits === 1 ? ["修订计划"] : [],
          } };
        }
        return { output: { episodes: [{
          episodeNumber: 1,
          pillar: "真实任务实验",
          title: "第一集",
          viewerPromise: "验证真实任务",
          hook: "先看结果",
          payoff: "给出结论",
          fromPrevious: ["Agent 擅自覆盖的要求"],
          toNext: ["继续验证"],
        }] } };
      }
    }
    const episode = {
      id: "episode-1",
      seriesId: series.id,
      episodeNumber: 1,
      seasonNumber: 1,
      arc: series.currentSeason.arc,
      pillar: "真实任务实验",
      title: "第一集",
      viewerPromise: "验证真实任务",
      hook: "先看结果",
      payoff: "给出结论",
      canonBaseRevision: 0,
      status: "planned" as const,
      continuity: {
        inheritedFromPrevious: [],
        fromPrevious: ["创作者明确保留的要求"],
        toNext: ["继续验证"],
        canonChecks: [],
      },
      planning: {
        source: "human" as const,
        role: "主创手工改写",
        auditRole: "待审计",
        auditStatus: "human_override" as const,
        auditIterations: 0,
        providerId: "human",
        modelId: "manual",
        promptVersion: "video-factory/series-episode-edit-v1",
      },
      createdAt: series.createdAt,
      updatedAt: series.updatedAt,
    };

    await assert.rejects(
      () => new CodexSeriesPlanningAgent(new OverreachingClient(), 3).reviewEpisode({ ...series, episodes: [episode] }, episode),
      /changed creator-owned fromPrevious/,
    );
  });
});

function draft(episodeNumber: number, pillar: string, title: string, viewerPromise: string) {
  return {
    episodeNumber,
    pillar,
    title,
    viewerPromise,
    hook: `${title}，先看结果。`,
    payoff: `${title}并形成一个结论。`,
    fromPrevious: episodeNumber === 1 ? [] : ["承接上一集定版后的记忆"],
    toNext: ["留下一个待验证的边界"],
  };
}
