import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type { StudioCandidateInboxItem } from "../shared/api.js";
import type { SeriesRecord } from "./series-store.js";
import { planVisualDirection } from "../shared/visual-plan.js";

export interface SeriesPlannerOptions {
  now?: () => Date;
}

const EPISODE_LENSES = [
  "先做一次真实任务实验",
  "比较最省钱与最省时间的两种做法",
  "复盘最容易失败的一步",
  "把方法压缩成可收藏的三步清单",
  "用一个反例检验这套方法的边界",
  "回答评论区最值得继续追问的问题",
];

export class SeriesPlanner {
  private readonly now: () => Date;

  constructor(options: SeriesPlannerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  plan(series: SeriesRecord, count = 6): StudioCandidateInboxItem[] {
    const safeCount = Math.max(1, Math.min(12, Math.floor(count)));
    return Array.from({ length: safeCount }, (_, index) => this.build(series, series.nextEpisodeNumber + index));
  }

  private build(series: SeriesRecord, episodeNumber: number): StudioCandidateInboxItem {
    const offset = episodeNumber - series.nextEpisodeNumber;
    const pillar = series.pillars[offset % series.pillars.length] ?? series.pillars[0] ?? series.premise;
    const lens = EPISODE_LENSES[offset % EPISODE_LENSES.length] ?? EPISODE_LENSES[0]!;
    const episode = String(episodeNumber).padStart(2, "0");
    const title = `${series.name} ${episode}｜${pillar}：${lens}`;
    const candidate = scoreTopicCandidate(`series-${series.id}-episode-${String(episodeNumber).padStart(3, "0")}`, {
      platform: series.platform,
      track: series.track,
      audience: series.audience,
      painPoint: `围绕“${pillar}”需要一个可验证、可复用的具体结论`,
      hook: `这一集不讲空泛方法，我们直接验证：${lens}。`,
      evidence: [{
        source: "series-plan",
        platform: series.platform,
        keyword: `${series.name} / ${pillar}`,
        strength: 82,
        collectedAt: series.updatedAt,
      }],
      audienceReach: 74,
      visualFeasibility: 88,
      productionCostEfficiency: 90,
      novelty: 72,
      monetization: 64,
      seriesPotential: 94,
      complianceRisk: 12,
    });
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
        reasons: ["系列候选来自创作者已保存的栏目定义。"],
      },
      seriesId: series.id,
      seriesName: series.name,
      episodeNumber,
      title,
      platform: series.platform,
      track: series.track,
      audience: series.audience,
      painPoint: candidate.painPoint,
      hook: candidate.hook,
      rationale: `${series.name} 的第 ${episodeNumber} 集候选；内容支柱为“${pillar}”，视觉方向为“${series.visualStyle}”。`,
      providerId: "series-planner-v1",
      generatedAt: this.now().toISOString(),
      evidence: candidate.evidence,
      score: candidate.score,
      visualPlan: planVisualDirection({
        title,
        hook: candidate.hook,
        category: series.category,
        visualStyle: series.visualStyle,
      }),
    };
  }
}
