import path from "node:path";
import {
  CodexBridgeClient,
  fileRoleAgentLoopCheckpoint,
  roleAgentCheckpointKey,
  runRoleAgentLoop,
} from "@video-factory/production-pipeline";
import type { StudioSeriesEpisodePlanning } from "../shared/api.js";
import type { StudioSeriesEpisode } from "../shared/api.js";
import type { SeriesEpisodeDraft } from "./series-planner.js";
import type { SeriesRecord } from "./series-store.js";

const SERIES_SHOWRUNNER_CONTRACT_VERSION = "series-showrunner-v1|role-audit-v1|series-roadmap-validator-v1";
const SERIES_GREENLIGHT_CONTRACT_VERSION = "series-greenlight-v1|role-audit-v1|series-roadmap-validator-v1";

export interface SeriesPlanningResult {
  drafts: SeriesEpisodeDraft[];
  planning: StudioSeriesEpisodePlanning;
}

export interface SeriesPlanningAgent {
  generate(series: SeriesRecord, count: number): Promise<SeriesPlanningResult>;
  reviewEpisode(series: SeriesRecord, episode: StudioSeriesEpisode): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }>;
}

export class CodexSeriesPlanningAgent implements SeriesPlanningAgent {
  constructor(
    private readonly client: CodexBridgeClient,
    private readonly maxReviewIterations = 3,
    private readonly checkpointDirectory?: string,
  ) {}

  async generate(series: SeriesRecord, count: number): Promise<SeriesPlanningResult> {
    const existing = [...series.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
    const startEpisodeNumber = Math.max(series.nextEpisodeNumber, (existing.at(-1)?.episodeNumber ?? 0) + 1);
    const request = {
      series: {
        id: series.id,
        name: series.name,
        premise: series.premise,
        audience: series.audience,
        platform: series.platform,
        category: series.category,
        track: series.track,
        pillars: series.pillars,
        tone: series.tone,
        visualStyle: series.visualStyle,
        currentSeason: series.currentSeason,
        bible: series.bible,
        canon: series.canon,
        existingEpisodes: existing.map((episode) => ({
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          pillar: episode.pillar,
          viewerPromise: episode.viewerPromise,
          payoff: episode.payoff,
          status: episode.status,
          continuity: episode.continuity,
        })),
      },
      planningWindow: { startEpisodeNumber, count },
    };
    const checkpointKey = roleAgentCheckpointKey({ request, contractVersion: SERIES_SHOWRUNNER_CONTRACT_VERSION });
    const execution = await runRoleAgentLoop<{ episodes: SeriesEpisodeDraft[] }>({
      role: "系列总编",
      contractVersion: SERIES_SHOWRUNNER_CONTRACT_VERSION,
      criteria: [
        "路线图严格遵守 Series Bible 与当前 Canon，不把未来计划、未验证结论或人物变化冒充已发生事实",
        "每一集都有可独立兑现的观众承诺，同时对本季篇章形成清晰且不重复的递进",
        "相邻集的承接和留扣具体可用，但不以悬念替代本集 payoff，也不过度依赖尚未定版的前集内容",
        "标题、钩子、兑现和内容支柱一致，六集不是同一种清单、复盘或反例模板的机械轮换",
        "每集具备明确可见的短视频表达空间，能够在经济素材与必要的生成素材之间做逐镜选择",
        "集数连续、数量准确，且没有输入中不存在的事实、数字、经历、引用或来源",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId }) => this.client.runTaskDetailed("series-roadmap", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId),
      audit: ({ role, iteration, criteria, candidate, requestId }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: request,
        candidate,
      }, requestId),
      validate: (value) => parseSeriesRoadmapOutput(value, series.pillars, startEpisodeNumber, count),
      ...(this.checkpointDirectory ? {
        checkpoint: fileRoleAgentLoopCheckpoint(
          path.join(this.checkpointDirectory, `${checkpointKey}.json`),
          checkpointKey,
        ),
      } : {}),
    });
    const finalAudit = execution.agentLoop?.iterations.at(-1)?.audit;
    return {
      drafts: execution.output.episodes,
      planning: {
        source: "agent",
        role: "系列总编",
        auditRole: "独立红队审计 Agent",
        auditStatus: "passed",
        auditIterations: execution.agentLoop?.iterations.length ?? 1,
        ...(finalAudit ? { auditScore: finalAudit.score, auditSummary: finalAudit.summary } : {}),
        providerId: execution.trace?.providerId ?? "openai",
        modelId: execution.trace?.modelId ?? "codex-default",
        promptVersion: execution.trace?.promptVersion ?? "video-factory/series-showrunner-v1",
        ...(execution.trace?.reasoningEffort ? { reasoningEffort: execution.trace.reasoningEffort } : {}),
      },
    };
  }

  async reviewEpisode(
    series: SeriesRecord,
    episode: StudioSeriesEpisode,
  ): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }> {
    const request = {
      series: seriesPlanningContext(series),
      planningWindow: { startEpisodeNumber: episode.episodeNumber, count: 1, mode: "greenlight" },
      targetEpisode: {
        ...episodeDraft(episode),
        inheritedFromPrevious: [...(episode.continuity.inheritedFromPrevious ?? [])],
      },
    };
    const checkpointKey = roleAgentCheckpointKey({ request, contractVersion: SERIES_GREENLIGHT_CONTRACT_VERSION });
    const execution = await runRoleAgentLoop<{ episodes: SeriesEpisodeDraft[] }>({
      role: "系列开拍总编",
      contractVersion: SERIES_GREENLIGHT_CONTRACT_VERSION,
      criteria: [
        "本集严格遵守最新 Series Bible 与 Canon，不把预告、计划、悬念或尚待验证的内容冒充正史",
        "本集完整承接前集正式交接和连续性记忆，同时保持可独立兑现的观众承诺",
        "标题、钩子、兑现、支柱和本季篇章一致，且不重复已经完成的前集",
        "保留人工明确决定；只有与最新正史或硬约束冲突时才修订，并说明可执行的修复",
        "fromPrevious 是创作者拥有的本集承接要求，必须与输入逐字逐项一致；只能修改 Agent 拥有的其他规划字段",
        "画面表达可实现，事实、数字、人物状态、引用和来源没有凭空新增",
      ],
      maxIterations: this.maxReviewIterations,
      initialCandidate: { episodes: [episodeDraft(episode)] },
      produce: (revision, { requestId }) => this.client.runTaskDetailed("series-roadmap", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId),
      audit: ({ role, iteration, criteria, candidate, requestId }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: request,
        candidate,
      }, requestId),
      validate: (value) => parseSeriesRoadmapOutput(value, series.pillars, episode.episodeNumber, 1),
      ...(this.checkpointDirectory ? {
        checkpoint: fileRoleAgentLoopCheckpoint(
          path.join(this.checkpointDirectory, `${checkpointKey}.json`),
          checkpointKey,
        ),
      } : {}),
    });
    const finalIteration = execution.agentLoop?.iterations.at(-1);
    const trace = execution.trace ?? finalIteration?.auditTrace;
    const draft = execution.output.episodes[0]!;
    if (JSON.stringify(draft.fromPrevious) !== JSON.stringify(episode.continuity.fromPrevious)) {
      throw new Error("Series greenlight agent changed creator-owned fromPrevious requirements.");
    }
    return {
      draft,
      planning: {
        source: episode.planning.source === "human" ? "human" : "agent",
        role: "系列开拍总编",
        auditRole: "独立红队审计 Agent",
        auditStatus: "passed",
        auditIterations: execution.agentLoop?.iterations.length ?? 1,
        ...(finalIteration ? { auditScore: finalIteration.audit.score, auditSummary: finalIteration.audit.summary } : {}),
        providerId: trace?.providerId ?? "openai",
        modelId: trace?.modelId ?? "codex-default",
        promptVersion: trace?.promptVersion ?? "video-factory/series-greenlight-v1",
        ...(trace?.reasoningEffort ? { reasoningEffort: trace.reasoningEffort } : {}),
      },
    };
  }
}

function seriesPlanningContext(series: SeriesRecord) {
  return {
    id: series.id,
    name: series.name,
    premise: series.premise,
    audience: series.audience,
    platform: series.platform,
    category: series.category,
    track: series.track,
    pillars: series.pillars,
    tone: series.tone,
    visualStyle: series.visualStyle,
    currentSeason: series.currentSeason,
    bible: series.bible,
    canon: series.canon,
    existingEpisodes: [...series.episodes]
      .sort((left, right) => left.episodeNumber - right.episodeNumber)
      .map((candidate) => ({
        episodeNumber: candidate.episodeNumber,
        title: candidate.title,
        pillar: candidate.pillar,
        viewerPromise: candidate.viewerPromise,
        payoff: candidate.payoff,
        status: candidate.status,
        continuity: candidate.continuity,
      })),
  };
}

function episodeDraft(episode: StudioSeriesEpisode): SeriesEpisodeDraft {
  return {
    episodeNumber: episode.episodeNumber,
    pillar: episode.pillar,
    title: episode.title,
    viewerPromise: episode.viewerPromise,
    hook: episode.hook,
    payoff: episode.payoff,
    fromPrevious: [...episode.continuity.fromPrevious],
    toNext: [...episode.continuity.toNext],
  };
}

export function parseSeriesRoadmapOutput(
  value: unknown,
  allowedPillars: string[],
  startEpisodeNumber: number,
  count: number,
): { episodes: SeriesEpisodeDraft[] } {
  if (!isRecord(value) || !Array.isArray(value.episodes) || value.episodes.length !== count) {
    throw new Error(`Series roadmap output must contain exactly ${count} episodes.`);
  }
  const episodes = value.episodes.map((entry, index): SeriesEpisodeDraft => {
    if (!isRecord(entry)) throw new Error(`Series roadmap episode ${index + 1} must be an object.`);
    const episodeNumber = integer(entry.episodeNumber, `episode ${index + 1} number`);
    if (episodeNumber !== startEpisodeNumber + index) throw new Error("Series roadmap episode numbers must match the requested window.");
    const pillar = text(entry.pillar, `episode ${episodeNumber} pillar`);
    if (!allowedPillars.includes(pillar)) throw new Error(`Series roadmap episode ${episodeNumber} uses an unknown pillar.`);
    return {
      episodeNumber,
      pillar,
      title: text(entry.title, `episode ${episodeNumber} title`),
      viewerPromise: text(entry.viewerPromise, `episode ${episodeNumber} viewerPromise`),
      hook: text(entry.hook, `episode ${episodeNumber} hook`),
      payoff: text(entry.payoff, `episode ${episodeNumber} payoff`),
      fromPrevious: textArray(entry.fromPrevious, `episode ${episodeNumber} fromPrevious`),
      toNext: textArray(entry.toNext, `episode ${episodeNumber} toNext`),
    };
  });
  if (new Set(episodes.map((episode) => episode.title)).size !== episodes.length) {
    throw new Error("Series roadmap episode titles must be distinct.");
  }
  if (new Set(episodes.map((episode) => episode.viewerPromise)).size !== episodes.length) {
    throw new Error("Series roadmap viewer promises must be distinct.");
  }
  return { episodes };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error(`${label} is invalid.`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
