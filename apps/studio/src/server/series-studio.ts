import { randomUUID } from "node:crypto";
import type {
  StudioCandidateInboxItem,
  StudioSeries,
  StudioSeriesInput,
  StudioSeriesEpisodePlanInput,
  StudioSeriesProductionContext,
} from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { SeriesPlanner } from "./series-planner.js";
import type { SeriesPlanningAgent } from "./series-planning-agent.js";
import {
  SeriesStoreConflictError,
  SeriesStoreNotFoundError,
  type SeriesRunSnapshot,
  type StudioSeriesRepository,
} from "./series-store.js";

export interface SeriesStudioOptions {
  series: StudioSeriesRepository;
  planner?: Pick<SeriesPlanner, "plan" | "planEpisodes">;
  planningAgent?: Pick<SeriesPlanningAgent, "reviewEpisode">;
  now?: () => Date;
  createId?: () => string;
}

export class SeriesStudio {
  private readonly planner: Pick<SeriesPlanner, "plan" | "planEpisodes">;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: SeriesStudioOptions) {
    this.planner = options.planner ?? new SeriesPlanner(options.now ? { now: options.now } : {});
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `series-${randomUUID()}`);
  }

  async list(): Promise<StudioSeries[]> {
    const records = await this.options.series.list();
    return Promise.all(records.map((series) => this.ensureRoadmap(series)));
  }

  async create(input: StudioSeriesInput): Promise<StudioSeries> {
    const timestamp = this.now().toISOString();
    const { seasonTitle, seasonArc, planningPeriod, releaseCadence, targetEpisodeCount, continuityRules, ...definition } = input;
    try {
      const record: StudioSeries = {
        id: this.createId(),
        ...definition,
        status: "active",
        revision: 1,
        currentSeason: {
          number: 1,
          title: seasonTitle?.trim() || "第一季",
          arc: seasonArc?.trim() || input.premise,
          planningPeriod: planningPeriod?.trim() || currentQuarterLabel(this.now()),
          releaseCadence: releaseCadence ?? "weekly",
          targetEpisodeCount: targetEpisodeCount ?? 12,
        },
        bible: {
          rules: [
            input.premise,
            `面向“${input.audience}”持续交付，不因单集热点改变栏目承诺。`,
            ...(continuityRules ?? []),
          ],
          recurringElements: [input.tone, input.visualStyle],
          forbiddenChanges: ["不得在没有说明的情况下改写已经建立的事实、人物关系或结论。"],
        },
        canon: { revision: 0, facts: [] },
        episodes: [],
        nextEpisodeNumber: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // 先持久化可编辑路线图，避免外部 Agent 的排队或断线阻塞系列创建。
      // 真正开拍前仍由 greenlightEpisode 执行最多三轮独立 Agent 审计。
      record.episodes = this.ruleEpisodes(record, Math.min(6, record.currentSeason.targetEpisodeCount ?? 12));
      return await this.options.series.create(record);
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async listCandidates(): Promise<StudioCandidateInboxItem[]> {
    return (await this.list())
      .filter((series) => series.status === "active")
      .flatMap((series) => this.planner.plan(series, 6));
  }

  async advanceEpisode(seriesId: string, expectedEpisodeNumber: number): Promise<StudioSeries> {
    try {
      let current = await this.options.series.get(seriesId);
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episode = current.episodes.find((candidate) => candidate.episodeNumber === expectedEpisodeNumber);
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      current = await this.greenlightEpisode(current, episode.episodeNumber);
      const greenlitEpisode = current.episodes.find((candidate) => candidate.episodeNumber === expectedEpisodeNumber);
      if (greenlitEpisode?.status === "selected" && greenlitEpisode.opportunityId === greenlitEpisode.id) {
        return await this.topUpRoadmap(current);
      }
      const adopted = await this.options.series.adoptEpisode(current.id, expectedEpisodeNumber, this.now().toISOString());
      return await this.topUpRoadmap(adopted);
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async updateEpisodePlan(
    seriesId: string,
    episodeNumber: number,
    input: StudioSeriesEpisodePlanInput,
  ): Promise<StudioSeries> {
    try {
      return await this.options.series.updateEpisodePlan(seriesId, episodeNumber, input, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async linkRun(context: StudioSeriesProductionContext, runId: string): Promise<StudioSeries> {
    try {
      return await this.options.series.linkRun(context.seriesId, context.episodeId, runId, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async linkLegacyRun(seriesId: string, episodeNumber: number, run: SeriesRunSnapshot): Promise<StudioSeries> {
    try {
      return await this.options.series.linkLegacyRun(seriesId, episodeNumber, run, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async resumeRun(seriesId: string, episodeNumber: number, runId: string): Promise<StudioSeries> {
    try {
      return await this.options.series.resumeRun(seriesId, episodeNumber, runId, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async reserveRun(
    context: StudioSeriesProductionContext,
    opportunityId: string,
    reservationId: string,
  ): Promise<StudioSeries> {
    try {
      await this.assertProductionContext(context, opportunityId);
      return await this.options.series.reserveRun(
        context.seriesId,
        context.episodeId,
        opportunityId,
        reservationId,
        this.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async confirmRunReservation(
    context: StudioSeriesProductionContext,
    reservationId: string,
    runId: string,
  ): Promise<StudioSeries> {
    try {
      return await this.options.series.confirmRunReservation(
        context.seriesId,
        context.episodeId,
        reservationId,
        runId,
        this.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async releaseRunReservation(context: StudioSeriesProductionContext, reservationId: string): Promise<void> {
    try {
      await this.options.series.releaseRunReservation(
        context.seriesId,
        context.episodeId,
        reservationId,
        this.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async assertProductionContext(context: StudioSeriesProductionContext, opportunityId?: string): Promise<void> {
    const series = await this.options.series.get(context.seriesId);
    const episode = series?.episodes.find((candidate) => candidate.id === context.episodeId);
    if (!series || !episode || episode.episodeNumber !== context.episodeNumber) {
      throw new StudioNotFoundError("系列或单集计划已经不存在，请返回系列路线图重新选择。");
    }
    if (episode.status !== "selected" || episode.opportunityId !== episode.id) {
      throw new StudioConflictError("这条单集尚未采用，或已经进入制作，请刷新系列路线图。");
    }
    if (opportunityId && episode.opportunityId !== opportunityId) {
      throw new StudioConflictError("制作机会与系列单集不匹配，请返回系列路线图重新采用。");
    }
    if (episode.canonBaseRevision !== series.canon.revision || context.canonBaseRevision !== series.canon.revision) {
      throw new StudioConflictError("系列 canon 已经更新，请刷新单集上下文并重新审计后再制作。");
    }
    if (context.seriesName !== series.name
      || context.seriesRevision !== series.revision
      || context.seasonNumber !== episode.seasonNumber
      || context.episode.updatedAt !== episode.updatedAt) {
      throw new StudioConflictError("单集携带的系列身份已经过期，请刷新后重试。");
    }
  }

  async reconcileRuns(runs: SeriesRunSnapshot[]): Promise<void> {
    await this.options.series.reconcileRuns(runs, this.now().toISOString());
  }

  async assertRunDeletable(runId: string): Promise<void> {
    try {
      await this.options.series.assertRunDeletable(runId);
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async assertRunEditable(runId: string): Promise<void> {
    try {
      await this.options.series.assertRunEditable(runId);
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async acquireRunEditLease(runId: string, leaseId: string): Promise<void> {
    try {
      await this.options.series.acquireRunEditLease(runId, leaseId, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async releaseRunEditLease(runId: string, leaseId: string): Promise<void> {
    try {
      await this.options.series.releaseRunEditLease(runId, leaseId);
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  markRunPublished(runId: string): Promise<void> {
    return this.options.series.markRunPublished(runId, this.now().toISOString());
  }

  productionContext(series: StudioSeries, episodeNumber: number): StudioSeriesProductionContext {
    const episode = series.episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
    if (!episode) throw new StudioNotFoundError("没有找到这条单集计划。");
    return {
      seriesId: series.id,
      episodeId: episode.id,
      seriesName: series.name,
      seriesRevision: series.revision,
      episodeNumber: episode.episodeNumber,
      seasonNumber: episode.seasonNumber,
      canonBaseRevision: episode.canonBaseRevision,
      premise: series.premise,
      audience: series.audience,
      platform: series.platform,
      track: series.track,
      arc: episode.arc,
      episode: {
        updatedAt: episode.updatedAt,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        planning: structuredClone(episode.planning),
      },
      bible: structuredClone(series.bible),
      canon: structuredClone(series.canon),
      continuity: structuredClone(episode.continuity),
    };
  }

  async productionContextFor(seriesId: string, episodeNumber: number): Promise<StudioSeriesProductionContext> {
    let series = await this.options.series.get(seriesId);
    if (!series) throw new StudioNotFoundError("系列已经不存在，请返回系列路线图重新选择。");
    try {
      series = await this.greenlightEpisode(series, episodeNumber);
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
    return this.productionContext(series, episodeNumber);
  }

  private async greenlightEpisode(series: StudioSeries, episodeNumber: number): Promise<StudioSeries> {
    const episode = series.episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
    if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
    const needsGreenlight = episode.canonBaseRevision !== series.canon.revision
      || episode.planning.auditStatus !== "passed";
    if (!needsGreenlight) return series;
    if (!this.options.planningAgent) {
      throw new SeriesStoreConflictError(episode.canonBaseRevision !== series.canon.revision
        ? "系列正史已更新，但开拍审计 Agent 当前不可用，不能沿用旧路线图。"
        : "这集尚未通过独立开拍审计，审计 Agent 当前不可用，不能进入制作。");
    }
    const reviewed = await this.options.planningAgent.reviewEpisode(series, episode);
    return this.options.series.rebaseEpisodePlan(
      series.id,
      episode.episodeNumber,
      series.revision,
      series.canon.revision,
      reviewed.draft,
      reviewed.planning,
      this.now().toISOString(),
    );
  }

  private async ensureRoadmap(series: StudioSeries): Promise<StudioSeries> {
    return series.status === "active" ? this.topUpRoadmap(series) : series;
  }

  private async topUpRoadmap(series: StudioSeries): Promise<StudioSeries> {
    if (series.status !== "active") return series;
    const plannedCount = series.episodes.filter((episode) => episode.status === "planned").length;
    const remainingSeasonSlots = Math.max(0, (series.currentSeason.targetEpisodeCount ?? 12) - series.episodes.length);
    const missing = Math.min(Math.max(0, 6 - plannedCount), remainingSeasonSlots);
    if (missing === 0) return series;
    const timestamp = this.now().toISOString();
    try {
      return await this.options.series.appendPlannedEpisodes(
        series.id,
        series.revision,
        this.ruleEpisodes(series, missing),
        timestamp,
      );
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) {
        return (await this.options.series.get(series.id)) ?? series;
      }
      throw error;
    }
  }

  private ruleEpisodes(series: StudioSeries, count: number) {
    return this.planner.planEpisodes(series, count, undefined, {
      source: "rules",
      role: "系列总编",
      auditRole: "开拍前独立红队审计 Agent",
      auditStatus: "fallback",
      auditIterations: 0,
      providerId: "series-roadmap-v2",
      modelId: "deterministic",
      promptVersion: "video-factory/series-rules-v2",
      fallbackReason: "已先保存可编辑路线图；采用单集前会由系列开拍 Agent 基于最新正史完成独立审计。",
    });
  }
}

function currentQuarterLabel(now: Date): string {
  return `${now.getFullYear()} Q${Math.floor(now.getMonth() / 3) + 1}`;
}
