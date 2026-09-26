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
  planningAgent?: Pick<SeriesPlanningAgent, "reviewEpisode"> & Partial<Pick<SeriesPlanningAgent, "generate" | "reviseEpisode">>;
  now?: () => Date;
  createId?: () => string;
}

export class SeriesStudio {
  private readonly planner: Pick<SeriesPlanner, "plan" | "planEpisodes">;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly roadmapGeneration = new Map<string, Promise<StudioSeries>>();
  private readonly episodeAudits = new Map<string, Promise<StudioSeries>>();
  private readonly episodeRevisions = new Map<string, { instruction: string; operation: Promise<StudioSeries> }>();

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
      // 初稿审计由显式生成动作完成；采用不暗中发起模型调用。
      record.episodes = this.ruleEpisodes(record, Math.min(6, record.currentSeason.targetEpisodeCount ?? 12));
      return await this.options.series.create(record);
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async generateRoadmap(seriesId: string): Promise<StudioSeries> {
    const running = this.roadmapGeneration.get(seriesId);
    if (running) return running;
    const operation = this.generateInitialRoadmap(seriesId);
    this.roadmapGeneration.set(seriesId, operation);
    try {
      return await operation;
    } finally {
      this.roadmapGeneration.delete(seriesId);
    }
  }

  private async generateInitialRoadmap(seriesId: string): Promise<StudioSeries> {
    try {
      const current = await this.options.series.get(seriesId);
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.episodes.every((episode) => episode.planning.source === "agent")) return current;
      if (!this.options.planningAgent?.generate) return current;
      if (current.episodes.some((episode) => episode.status !== "planned" || episode.planning.source !== "rules")) {
        throw new SeriesStoreConflictError("路线图已被修改，不能用模型初稿覆盖创作者的决定。");
      }
      // 初建时先保存的规则窗口只承担恢复占位；模型初稿仍从第一集开始。
      const initialWindow = { ...current, episodes: [], nextEpisodeNumber: 1 };
      const generated = await this.options.planningAgent.generate(initialWindow, current.episodes.length);
      const episodes = this.planner.planEpisodes(initialWindow, current.episodes.length, generated.drafts, generated.planning);
      return await this.options.series.replaceInitialRoadmap(current.id, current.revision, episodes, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async listCandidates(): Promise<StudioCandidateInboxItem[]> {
    return (await this.list())
      .filter((series) => series.status === "active")
      .flatMap((series) => this.planner.plan(series, 6));
  }

  async advanceEpisode(seriesId: string, expectedEpisodeNumber: number, expectedGenerationId?: string): Promise<StudioSeries> {
    try {
      const current = await this.options.series.get(seriesId);
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episode = current.episodes.find((candidate) => candidate.episodeNumber === expectedEpisodeNumber);
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status === "selected" && episode.opportunityId === episode.id) {
        return await this.topUpRoadmap(current);
      }
      const adopted = await this.options.series.adoptEpisode(current.id, expectedEpisodeNumber, this.now().toISOString(), expectedGenerationId);
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

  async auditEpisodeCurrent(seriesId: string, episodeNumber: number, expectedRevision: number): Promise<StudioSeries> {
    const key = `${seriesId}:${episodeNumber}:${expectedRevision}`;
    const running = this.episodeAudits.get(key);
    if (running) return running;
    const operation = this.performEpisodeAudit(seriesId, episodeNumber, expectedRevision);
    this.episodeAudits.set(key, operation);
    try {
      return await operation;
    } finally {
      this.episodeAudits.delete(key);
    }
  }

  async reviseEpisodeCurrent(
    seriesId: string,
    episodeNumber: number,
    expectedRevision: number,
    instruction: string,
  ): Promise<StudioSeries> {
    const key = `${seriesId}:${episodeNumber}:${expectedRevision}`;
    const running = this.episodeRevisions.get(key);
    if (running) {
      if (running.instruction !== instruction) throw new StudioConflictError("当前单集已有不同的修改意见在执行，请等待结果后刷新。");
      return running.operation;
    }
    const operation = this.performEpisodeRevision(seriesId, episodeNumber, expectedRevision, instruction);
    this.episodeRevisions.set(key, { instruction, operation });
    try {
      return await operation;
    } finally {
      this.episodeRevisions.delete(key);
    }
  }

  private async performEpisodeRevision(
    seriesId: string,
    episodeNumber: number,
    expectedRevision: number,
    instruction: string,
  ): Promise<StudioSeries> {
    try {
      const current = await this.options.series.get(seriesId);
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.revision !== expectedRevision) throw new SeriesStoreConflictError("系列路线图版本已变化，请刷新后重新发送修改意见。");
      const episode = current.episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status !== "planned") throw new SeriesStoreConflictError("已采用的单集不能在路线图中改稿。");
      if (!this.options.planningAgent?.reviseEpisode) throw new StudioConflictError("当前没有可用的系列修订模型；旧稿保留不变。");
      const revised = await this.options.planningAgent.reviseEpisode(current, episode, instruction);
      return await this.options.series.reviseEpisodePlan(
        seriesId, episodeNumber, expectedRevision, current.canon.revision,
        revised.draft, revised.planning, this.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  private async performEpisodeAudit(seriesId: string, episodeNumber: number, expectedRevision: number): Promise<StudioSeries> {
    try {
      const current = await this.options.series.get(seriesId);
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.revision !== expectedRevision) throw new SeriesStoreConflictError("系列路线图版本已经变化，请刷新后再审计当前版本。");
      const episode = current.episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status !== "planned") throw new SeriesStoreConflictError("只有尚未采用的单集可以主动审计当前版本。");
      if (!this.options.planningAgent) throw new StudioConflictError("当前未配置系列审计能力，请配置后重试；原路线图保留不变。");
      // reviewEpisode 使用当前稿作 initialCandidate：只审计，不请求新稿，也不推进单集。
      const reviewed = await this.options.planningAgent.reviewEpisode(current, episode);
      return await this.options.series.rebaseEpisodePlan(
        current.id, episodeNumber, expectedRevision, current.canon.revision,
        {
          episodeNumber,
          pillar: episode.pillar,
          title: episode.title,
          viewerPromise: episode.viewerPromise,
          hook: episode.hook,
          payoff: episode.payoff,
          fromPrevious: [...episode.continuity.fromPrevious],
          toNext: [...episode.continuity.toNext],
        },
        reviewed.planning,
        this.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async appendEpisodeSources(
    seriesId: string,
    episodeNumber: number,
    evidenceUrls: string[],
  ): Promise<StudioSeries> {
    try {
      return await this.options.series.appendEpisodeSources(seriesId, episodeNumber, evidenceUrls, this.now().toISOString());
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
    const series = await this.options.series.get(seriesId);
    if (!series) throw new StudioNotFoundError("系列已经不存在，请返回系列路线图重新选择。");
    return this.productionContext(series, episodeNumber);
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
      auditRole: "按需独立质量复核",
      auditStatus: "fallback",
      auditIterations: 0,
      providerId: "series-roadmap-v2",
      modelId: "deterministic",
      promptVersion: "video-factory/series-rules-v2",
      fallbackReason: "当前仅有可编辑的规则路线图，尚无模型首审；可以主动审计，也可以明确采用当前稿。",
    });
  }
}

function currentQuarterLabel(now: Date): string {
  return `${now.getFullYear()} Q${Math.floor(now.getMonth() / 3) + 1}`;
}
