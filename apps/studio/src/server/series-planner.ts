import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type {
  StudioCandidateInboxItem,
  StudioSeriesEpisode,
  StudioSeriesEpisodePlanning,
} from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import type { SeriesRecord } from "./series-store.js";

export interface SeriesPlannerOptions {
  now?: () => Date;
}

export interface SeriesEpisodeDraft {
  episodeNumber: number;
  pillar: string;
  title: string;
  viewerPromise: string;
  hook: string;
  payoff: string;
  fromPrevious: string[];
  toNext: string[];
}

const EPISODE_LENSES = [
  "先做一次真实任务实验",
  "比较最省钱与最省时间的两种做法",
  "复盘最容易失败的一步",
  "把方法压缩成可收藏的三步清单",
  "用一个反例检验这套方法的边界",
  "回答上一集留下的关键问题",
];

export class SeriesPlanner {
  private readonly now: () => Date;

  constructor(options: SeriesPlannerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  planEpisodes(
    series: SeriesRecord,
    count = 6,
    suppliedDrafts?: SeriesEpisodeDraft[],
    planning: StudioSeriesEpisodePlanning = rulePlanning(),
  ): StudioSeriesEpisode[] {
    const safeCount = Math.max(1, Math.min(12, Math.floor(count)));
    const existing = [...series.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
    const firstNumber = Math.max(series.nextEpisodeNumber, (existing.at(-1)?.episodeNumber ?? 0) + 1);
    const createdAt = this.now().toISOString();
    const drafts = suppliedDrafts ?? this.ruleDrafts(series, safeCount, firstNumber);
    if (drafts.length !== safeCount || drafts.some((draft, index) => draft.episodeNumber !== firstNumber + index)) {
      throw new Error("Series episode drafts must exactly match the requested planning window.");
    }
    const episodes: StudioSeriesEpisode[] = [];
    for (const draft of drafts) {
      const episodeNumber = draft.episodeNumber;
      const previous = episodes.at(-1) ?? existing.at(-1);
      episodes.push({
        id: episodeId(series.id, episodeNumber),
        seriesId: series.id,
        episodeNumber,
        seasonNumber: series.currentSeason.number,
        arc: series.currentSeason.arc,
        pillar: draft.pillar,
        title: draft.title,
        viewerPromise: draft.viewerPromise,
        hook: draft.hook,
        payoff: draft.payoff,
        ...(previous ? { previousEpisodeId: previous.id } : {}),
        canonBaseRevision: series.canon.revision,
        status: "planned",
        continuity: {
          inheritedFromPrevious: previous
            ? [previous.continuity.memorySummary ?? previous.continuity.toNext[0]].filter((value): value is string => Boolean(value))
            : [],
          fromPrevious: [...draft.fromPrevious],
          toNext: [...draft.toNext],
          canonChecks: [...series.bible.rules],
        },
        planning: structuredClone(planning),
        createdAt,
        updatedAt: createdAt,
      });
    }
    return episodes;
  }

  private ruleDrafts(series: SeriesRecord, count: number, firstNumber: number): SeriesEpisodeDraft[] {
    return Array.from({ length: count }, (_, offset) => {
      const episodeNumber = firstNumber + offset;
      const pillar = series.pillars[(episodeNumber - 1) % series.pillars.length] ?? series.premise;
      const lens = EPISODE_LENSES[(episodeNumber - 1) % EPISODE_LENSES.length] ?? EPISODE_LENSES[0]!;
      const episode = String(episodeNumber).padStart(2, "0");
      return {
        episodeNumber,
        pillar,
        title: `${series.name} ${episode}｜${pillar}：${lens}`,
        viewerPromise: `围绕“${pillar}”给出一个可验证、可复用的具体结论。`,
        hook: `第 ${episodeNumber} 集直接验证“${lens}”：${series.audience}最终能得到什么可复核结果？`,
        payoff: `完成“${lens}”，并把结论交给下一集继续验证。`,
        fromPrevious: episodeNumber === 1 ? [] : ["承接上一集定版后写入的连续性记忆，不把路线图意图冒充正史。"],
        toNext: [`保留“${pillar}”尚未解决的一个边界问题，供下一集推进。`],
      };
    });
  }

  plan(series: SeriesRecord, count = 6): StudioCandidateInboxItem[] {
    const plannedCount = Math.max(1, Math.min(12, Math.floor(count)));
    const candidates = this.candidateEpisodes(series);
    const recoverableSelections = candidates.filter((episode) => episode.status === "selected");
    const plannedWindow = candidates.filter((episode) => episode.status === "planned").slice(0, plannedCount);
    return [...recoverableSelections, ...plannedWindow]
      .sort((left, right) => left.episodeNumber - right.episodeNumber)
      .map((episode) => this.toCandidate(series, episode));
  }

  private candidateEpisodes(series: SeriesRecord): StudioSeriesEpisode[] {
    return [...series.episodes]
      .filter((episode) => episode.status === "planned" || episode.status === "selected")
      .sort((left, right) => left.episodeNumber - right.episodeNumber);
  }

  private toCandidate(series: SeriesRecord, episode: StudioSeriesEpisode): StudioCandidateInboxItem {
    const candidate = scoreTopicCandidate(episode.id, {
      platform: series.platform,
      track: series.track,
      audience: series.audience,
      painPoint: episode.viewerPromise,
      hook: episode.hook,
      evidence: [{
        source: `系列路线图「${series.name}」第 ${episode.episodeNumber} 集`,
        platform: series.platform,
        keyword: `${series.name} / ${episode.pillar}`,
        strength: 82,
        evidenceUrl: seriesRoadmapUrl(episode.id),
        collectedAt: episode.updatedAt,
      }],
      audienceReach: 74,
      visualFeasibility: 88,
      productionCostEfficiency: 90,
      novelty: 72,
      monetization: 64,
      seriesPotential: 96,
      complianceRisk: 12,
    });
    const blocker = blockingEpisode(series, episode);
    return {
      id: candidate.id,
      origin: "series",
      category: series.category,
      freshness: "evergreen",
      risk: "low",
      verification: {
        status: "ready",
        independentSources: 1,
        requiredSources: 1,
        reasons: ["单集来自已保存的系列圣经与持久化路线图。"],
      },
      editorialDecision: {
        verdict: "produce_video",
        score: blocker ? 76 : 93,
        reasons: blocker
          ? [`第 ${blocker.episodeNumber} 集尚未完成，当前单集保留在路线图中。`]
          : ["单集承接本季篇章并有独立兑现，适合进入逐集生产。"],
        guardrails: [
          "必须遵守系列 canon 与连续性输入，不能为了单集钩子改写已建立事实。",
          "每集必须产生新的验证、行动或结论，不能只复述栏目模板。",
        ],
      },
      seriesId: series.id,
      seriesName: series.name,
      episodeNumber: episode.episodeNumber,
      seriesSequence: blocker
        ? { status: "blocked", blockedByEpisodeNumber: blocker.episodeNumber }
        : { status: "ready" },
      title: episode.title,
      platform: series.platform,
      track: series.track,
      audience: series.audience,
      painPoint: episode.viewerPromise,
      hook: episode.hook,
      rationale: `第 ${episode.episodeNumber} 集属于“${episode.arc}”篇章；内容支柱为“${episode.pillar}”，结尾将写回下一集连续性记忆。`,
      providerId: "series-roadmap-v2",
      generatedAt: episode.updatedAt,
      evidence: candidate.evidence,
      score: candidate.score,
      visualPlan: planVisualDirection({
        title: episode.title,
        hook: episode.hook,
        category: series.category,
        visualStyle: series.visualStyle,
      }),
    };
  }
}

function rulePlanning(): StudioSeriesEpisodePlanning {
  return {
    source: "rules",
    role: "系列总编",
    auditRole: "规则校验",
    auditStatus: "fallback",
    auditIterations: 0,
    providerId: "series-roadmap-v2",
    modelId: "deterministic",
    promptVersion: "video-factory/series-rules-v2",
  };
}

function episodeId(seriesId: string, episodeNumber: number): string {
  return `series-${seriesId}-episode-${String(episodeNumber).padStart(3, "0")}`;
}

function seriesRoadmapUrl(candidateId: string): string {
  const url = new URL("https://video.wangjinkun333.me/topics");
  url.searchParams.set("mode", "series");
  url.searchParams.set("candidate", candidateId);
  return url.toString();
}

function blockingEpisode(series: SeriesRecord, episode: StudioSeriesEpisode): StudioSeriesEpisode | undefined {
  return [...series.episodes]
    .filter((candidate) => candidate.episodeNumber < episode.episodeNumber)
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .find((candidate) => (candidate.status !== "ready" && candidate.status !== "published")
      || !series.canon.facts.some((fact) => fact.sourceEpisodeId === candidate.id));
}
