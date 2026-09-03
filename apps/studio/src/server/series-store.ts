import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import type {
  StudioRunStatus,
  StudioSeries,
  StudioSeriesEpisode,
  StudioSeriesEpisodePlanning,
  StudioSeriesEpisodePlanInput,
} from "../shared/api.js";
import type { SeriesEpisodeDraft } from "./series-planner.js";

export type SeriesRecord = StudioSeries;

export interface SeriesRunSnapshot {
  id: string;
  status: StudioRunStatus;
  revision: number;
  seriesId?: string;
  episodeNumber?: number;
  opportunityId?: string;
  productionReservationId?: string;
  outcomeUncertain?: boolean;
  canonProposal?: {
    memorySummary: string;
    statements: string[];
    sourceOutputVersionIds: string[];
  };
}

export interface StudioSeriesRepository {
  list(): Promise<SeriesRecord[]>;
  get(id: string): Promise<SeriesRecord | undefined>;
  create(record: SeriesRecord): Promise<SeriesRecord>;
  appendPlannedEpisodes(id: string, expectedRevision: number, episodes: StudioSeriesEpisode[], updatedAt: string): Promise<SeriesRecord>;
  updateEpisodePlan(id: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput, updatedAt: string): Promise<SeriesRecord>;
  rebaseEpisodePlan(
    id: string,
    episodeNumber: number,
    expectedRevision: number,
    expectedCanonRevision: number,
    draft: SeriesEpisodeDraft,
    planning: StudioSeriesEpisodePlanning,
    updatedAt: string,
  ): Promise<SeriesRecord>;
  adoptEpisode(id: string, episodeNumber: number, updatedAt: string): Promise<SeriesRecord>;
  reserveRun(id: string, episodeId: string, opportunityId: string, reservationId: string, updatedAt: string): Promise<SeriesRecord>;
  confirmRunReservation(id: string, episodeId: string, reservationId: string, runId: string, updatedAt: string): Promise<SeriesRecord>;
  releaseRunReservation(id: string, episodeId: string, reservationId: string, updatedAt: string): Promise<SeriesRecord>;
  linkRun(id: string, episodeId: string, runId: string, updatedAt: string): Promise<SeriesRecord>;
  resumeRun(id: string, episodeNumber: number, runId: string, updatedAt: string): Promise<SeriesRecord>;
  linkLegacyRun(id: string, episodeNumber: number, run: SeriesRunSnapshot, updatedAt: string): Promise<SeriesRecord>;
  acquireRunEditLease(runId: string, leaseId: string, createdAt: string): Promise<void>;
  releaseRunEditLease(runId: string, leaseId: string): Promise<void>;
  assertRunEditable(runId: string): Promise<void>;
  assertRunDeletable(runId: string): Promise<void>;
  reconcileRuns(runs: SeriesRunSnapshot[], updatedAt: string): Promise<void>;
  markRunPublished(runId: string, publishedAt: string): Promise<void>;
}

interface SeriesFile {
  version: 2;
  series: SeriesRecord[];
}

const STALE_SERIES_LOCK_AGE_MS = 5 * 60 * 1_000;
const STALE_RUN_RESERVATION_AGE_MS = 15 * 60 * 1_000;
const STALE_RUN_EDIT_LEASE_AGE_MS = 15 * 60 * 1_000;

export class JsonSeriesStore implements StudioSeriesRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<SeriesRecord[]> {
    return structuredClone((await this.read()).series)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<SeriesRecord | undefined> {
    const record = (await this.read()).series.find((item) => item.id === id);
    return record ? structuredClone(record) : undefined;
  }

  async create(record: SeriesRecord): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      if (file.series.some((item) => item.id === record.id || item.track === record.track)) {
        throw new SeriesStoreConflictError("系列名称或系列标识已经存在。");
      }
      file.series.push(structuredClone(record));
      await this.write(file);
      return structuredClone(record);
    });
  }

  async appendPlannedEpisodes(
    id: string,
    expectedRevision: number,
    episodes: StudioSeriesEpisode[],
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.revision !== expectedRevision) {
        throw new SeriesStoreConflictError("系列路线图已经更新，请刷新后重试。");
      }
      const ids = new Set(current.episodes.map((episode) => episode.id));
      const numbers = new Set(current.episodes.map((episode) => episode.episodeNumber));
      if (episodes.some((episode) => episode.seriesId !== id || ids.has(episode.id) || numbers.has(episode.episodeNumber))) {
        throw new SeriesStoreConflictError("新增单集与现有路线图重复。");
      }
      const updated = {
        ...current,
        episodes: [...current.episodes, ...structuredClone(episodes)].sort((left, right) => left.episodeNumber - right.episodeNumber),
        revision: current.revision + 1,
        updatedAt,
      };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async adoptEpisode(id: string, episodeNumber: number, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status === "selected" && episode.opportunityId === episode.id) {
        return structuredClone(current);
      }
      if (episode.status !== "planned") {
        throw new SeriesStoreConflictError(`第 ${episodeNumber} 集已经进入后续阶段，请刷新后再试。`);
      }
      if (episode.canonBaseRevision !== current.canon.revision) {
        throw new SeriesStoreConflictError(`第 ${episodeNumber} 集尚未通过基于最新已确认内容的开拍复核。`);
      }
      if (episode.planning.auditStatus !== "passed") {
        throw new SeriesStoreConflictError(`第 ${episodeNumber} 集尚未通过独立开拍审计。`);
      }
      const upstreamEdit = current.episodes.find((candidate) => candidate.episodeNumber < episode.episodeNumber
        && activeEditLease(candidate, updatedAt));
      if (upstreamEdit) {
        throw new SeriesStoreConflictError(`第 ${upstreamEdit.episodeNumber} 集正在修改，完成并更新已确认内容前不能采用第 ${episodeNumber} 集。`);
      }
      const blocker = blockingPriorEpisode(current, episode);
      if (blocker) {
        throw new SeriesStoreConflictError(`请先完成第 ${blocker.episodeNumber} 集，再推进第 ${episodeNumber} 集。`);
      }
      const episodes = current.episodes.map((candidate, candidateIndex) => candidateIndex === episodeIndex
        ? { ...candidate, status: "selected" as const, opportunityId: candidate.id, updatedAt }
        : candidate);
      const nextEpisodeNumber = episodes.find((candidate) => candidate.status === "planned")?.episodeNumber
        ?? episodeNumber + 1;
      const updated = { ...current, episodes, nextEpisodeNumber, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async updateEpisodePlan(
    id: string,
    episodeNumber: number,
    input: StudioSeriesEpisodePlanInput,
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.revision !== input.expectedRevision) {
        throw new SeriesStoreConflictError("系列路线图已经更新，请刷新后重新编辑。");
      }
      if (!current.pillars.includes(input.pillar)) {
        throw new SeriesStoreConflictError("内容支柱必须来自这个系列已经确认的栏目定义。");
      }
      const episodeIndex = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status !== "planned") {
        throw new SeriesStoreConflictError("只有尚未采用的单集路线图可以修改；已进入制作的内容请在对应制作节点中编辑。");
      }

      const nextEpisode = current.episodes.find((candidate) => candidate.previousEpisodeId === episode.id);
      const episodes = current.episodes.map((candidate, candidateIndex) => {
        if (candidateIndex === episodeIndex) {
          return {
            ...candidate,
            pillar: input.pillar,
            title: input.title,
            viewerPromise: input.viewerPromise,
            hook: input.hook,
            payoff: input.payoff,
            continuity: {
              ...candidate.continuity,
              fromPrevious: structuredClone(input.fromPrevious),
              toNext: structuredClone(input.toNext),
            },
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
            updatedAt,
          };
        }
        if (nextEpisode?.id === candidate.id && candidate.status === "planned") {
          return {
            ...candidate,
            continuity: { ...candidate.continuity, inheritedFromPrevious: structuredClone(input.toNext) },
            planning: {
              ...candidate.planning,
              auditStatus: "stale" as const,
              auditSummary: `第 ${episodeNumber} 集的交接已修改，采用本集前需要重新审计。`,
            },
            updatedAt,
          };
        }
        return candidate;
      });
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async rebaseEpisodePlan(
    id: string,
    episodeNumber: number,
    expectedRevision: number,
    expectedCanonRevision: number,
    draft: SeriesEpisodeDraft,
    planning: StudioSeriesEpisodePlanning,
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.revision !== expectedRevision || current.canon.revision !== expectedCanonRevision) {
        throw new SeriesStoreConflictError("系列正史或路线图已经更新，请重新执行开拍审计。");
      }
      const episodeIndex = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if ((episode.status !== "planned" && episode.status !== "selected") || episode.runId || episode.runReservation) {
        throw new SeriesStoreConflictError("只有尚未开拍的单集可以执行开拍审计。");
      }
      if (draft.episodeNumber !== episodeNumber || !current.pillars.includes(draft.pillar)) {
        throw new SeriesStoreConflictError("开拍审计返回了不属于当前路线图的单集。");
      }
      if (JSON.stringify(draft.fromPrevious) !== JSON.stringify(episode.continuity.fromPrevious)) {
        throw new SeriesStoreConflictError("开拍审计不能改写创作者填写的本集承接要求；请由创作者确认后重新审计。");
      }
      if (episode.planning.source === "human" && JSON.stringify({
        pillar: draft.pillar,
        title: draft.title,
        viewerPromise: draft.viewerPromise,
        hook: draft.hook,
        payoff: draft.payoff,
        toNext: draft.toNext,
      }) !== JSON.stringify({
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        toNext: episode.continuity.toNext,
      })) {
        throw new SeriesStoreConflictError("开拍审计不能改写创作者确认的标题、钩子或本集兑现；如需调整，请返回路线图手工修改后再审计。");
      }
      const upstreamEdit = current.episodes.find((candidate) => candidate.episodeNumber < episode.episodeNumber
        && activeEditLease(candidate, updatedAt));
      if (upstreamEdit) {
        throw new SeriesStoreConflictError(`第 ${upstreamEdit.episodeNumber} 集正在修改，不能完成第 ${episodeNumber} 集的开拍审计。`);
      }
      const episodes = current.episodes.map((candidate, candidateIndex) => candidateIndex === episodeIndex
        ? {
            ...candidate,
            pillar: draft.pillar,
            title: draft.title,
            viewerPromise: draft.viewerPromise,
            hook: draft.hook,
            payoff: draft.payoff,
            canonBaseRevision: current.canon.revision,
            continuity: {
              ...candidate.continuity,
              fromPrevious: [...candidate.continuity.fromPrevious],
              toNext: [...draft.toNext],
            },
            planning: structuredClone(planning),
            updatedAt,
          }
        : candidate);
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async reserveRun(
    id: string,
    episodeId: string,
    opportunityId: string,
    reservationId: string,
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.id === episodeId);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.runReservation?.id === reservationId && episode.runReservation.opportunityId === opportunityId) {
        return structuredClone(current);
      }
      const blocker = blockingPriorEpisode(current, episode);
      if (blocker) {
        throw new SeriesStoreConflictError(`第 ${blocker.episodeNumber} 集尚未形成有效的已确认内容，不能开始第 ${episode.episodeNumber} 集。`);
      }
      const upstreamEdit = current.episodes.find((candidate) => candidate.episodeNumber < episode.episodeNumber
        && activeEditLease(candidate, updatedAt));
      if (upstreamEdit) {
        throw new SeriesStoreConflictError(`第 ${upstreamEdit.episodeNumber} 集正在修改，完成并更新已确认内容前不能开始第 ${episode.episodeNumber} 集。`);
      }
      if (episode.status !== "selected" || episode.opportunityId !== opportunityId || episode.runId || episode.runReservation) {
        throw new SeriesStoreConflictError(`第 ${episode.episodeNumber} 集已经被其他制作占用，请刷新制作记录。`);
      }
      const episodes = current.episodes.map((candidate, candidateIndex) => candidateIndex === episodeIndex
        ? { ...candidate, runReservation: { id: reservationId, opportunityId, createdAt: updatedAt }, updatedAt }
        : candidate);
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async confirmRunReservation(
    id: string,
    episodeId: string,
    reservationId: string,
    runId: string,
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.id === episodeId);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.status === "in_production" && episode.runId === runId) return structuredClone(current);
      if (episode.status !== "selected" || episode.runReservation?.id !== reservationId) {
        throw new SeriesStoreConflictError(`第 ${episode.episodeNumber} 集的生产占用已经变化，请检查制作记录。`);
      }
      const episodes = current.episodes.map((candidate, candidateIndex) => {
        if (candidateIndex !== episodeIndex) return candidate;
        const { runReservation: _reservation, ...withoutReservation } = candidate;
        return {
            ...withoutReservation,
            status: "in_production" as const,
            runId,
            attemptRunIds: [...new Set([...(candidate.attemptRunIds ?? []), runId])],
            lastObservedRun: { id: runId, revision: 0 },
            updatedAt,
          };
      });
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async releaseRunReservation(id: string, episodeId: string, reservationId: string, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episode = current.episodes.find((candidate) => candidate.id === episodeId);
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.runReservation?.id !== reservationId) return structuredClone(current);
      const episodes = current.episodes.map((candidate) => {
        if (candidate.id !== episodeId) return candidate;
        const { runReservation: _reservation, ...withoutReservation } = candidate;
        return { ...withoutReservation, updatedAt };
      });
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async linkRun(id: string, episodeId: string, runId: string, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.id === episodeId);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.runId === runId) return structuredClone(current);
      const blocker = blockingPriorEpisode(current, episode);
      if (blocker) {
        throw new SeriesStoreConflictError(`第 ${blocker.episodeNumber} 集尚未形成有效的已确认内容，不能开始第 ${episode.episodeNumber} 集。`);
      }
      const upstreamEdit = current.episodes.find((candidate) => candidate.episodeNumber < episode.episodeNumber
        && activeEditLease(candidate, updatedAt));
      if (upstreamEdit) {
        throw new SeriesStoreConflictError(`第 ${upstreamEdit.episodeNumber} 集正在修改，完成并更新已确认内容前不能开始第 ${episode.episodeNumber} 集。`);
      }
      if (episode.status !== "selected" || episode.runId) {
        throw new SeriesStoreConflictError(`第 ${episode.episodeNumber} 集已经绑定其他制作记录。`);
      }
      const episodes = current.episodes.map((candidate, candidateIndex) => {
        if (candidateIndex !== episodeIndex) return candidate;
        const { runReservation: _reservation, ...withoutReservation } = candidate;
        return {
            ...withoutReservation,
            status: "in_production" as const,
            runId,
            attemptRunIds: [...new Set([...(candidate.attemptRunIds ?? []), runId])],
            lastObservedRun: { id: runId, revision: 0 },
            updatedAt,
          };
      });
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async resumeRun(id: string, episodeNumber: number, runId: string, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const seriesIndex = file.series.findIndex((item) => item.id === id);
      const current = file.series[seriesIndex];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (episode.runId && episode.runId !== runId) {
        throw new SeriesStoreConflictError(`第 ${episodeNumber} 集已经绑定另一条制作记录。`);
      }
      if (!episode.runId && !(episode.attemptRunIds ?? []).includes(runId)) {
        throw new SeriesStoreConflictError("这条失败记录不属于该单集，不能作为系列任务重试。");
      }
      const blocker = blockingPriorEpisode(current, episode);
      if (blocker) {
        throw new SeriesStoreConflictError(`第 ${blocker.episodeNumber} 集尚未完成，不能恢复第 ${episodeNumber} 集。`);
      }
      if (episode.status !== "selected" && episode.status !== "in_production") {
        throw new SeriesStoreConflictError("当前单集状态不允许恢复失败步骤。");
      }
      const episodes = [...current.episodes];
      episodes[episodeIndex] = {
        ...episode,
        status: "in_production",
        runId,
        attemptRunIds: [...new Set([...(episode.attemptRunIds ?? []), runId])],
        updatedAt,
      };
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[seriesIndex] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async linkLegacyRun(
    id: string,
    episodeNumber: number,
    run: SeriesRunSnapshot,
    updatedAt: string,
  ): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const seriesIndex = file.series.findIndex((item) => item.id === id);
      const current = file.series[seriesIndex];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const episodeIndex = current.episodes.findIndex((episode) => episode.episodeNumber === episodeNumber);
      const episode = current.episodes[episodeIndex];
      if (!episode) throw new SeriesStoreNotFoundError("没有找到这条单集计划。");
      if (!isMigrationPendingEpisode(episode)) {
        throw new SeriesStoreConflictError("只有待恢复的历史单集可以人工关联制作记录。");
      }
      if (run.status !== "succeeded") {
        throw new SeriesStoreConflictError("只能关联已经完成的历史成片；未完成或失败记录不会解锁后续单集。");
      }
      if (file.series.some((item) => item.episodes.some((candidate) => candidate.runId === run.id))) {
        throw new SeriesStoreConflictError("这条制作记录已经关联到其他系列单集。");
      }
      const episodes = [...current.episodes];
      episodes[episodeIndex] = {
        ...episode,
        status: "ready",
        runId: run.id,
        attemptRunIds: [...new Set([...(episode.attemptRunIds ?? []), run.id])],
        lastObservedRun: { id: run.id, revision: run.revision },
        continuity: {
          ...episode.continuity,
          memorySummary: episode.continuity.memorySummary
            ?? "历史成片已由创作者人工确认。旧任务没有结构化内容记忆，下一集请人工补充承接要求。",
        },
        updatedAt,
      };
      const updated = { ...current, episodes, revision: current.revision + 1, updatedAt };
      file.series[seriesIndex] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async assertRunDeletable(runId: string): Promise<void> {
    const series = (await this.read()).series.find((candidate) => candidate.episodes.some((episode) => episode.runId === runId));
    const episode = series?.episodes.find((candidate) => candidate.runId === runId);
    if (episode?.status === "ready" || episode?.status === "published") {
      throw new SeriesStoreConflictError("这条制作已经成为系列已确认内容的来源，不能永久删除；请归档保留，或先建立正式修订。");
    }
  }

  async acquireRunEditLease(runId: string, leaseId: string, createdAt: string): Promise<void> {
    await this.withWriteLock(async () => {
      const file = await this.read();
      const seriesIndex = file.series.findIndex((candidate) => candidate.episodes.some((episode) => episode.runId === runId));
      const series = file.series[seriesIndex];
      const episodeIndex = series?.episodes.findIndex((candidate) => candidate.runId === runId) ?? -1;
      const episode = series?.episodes[episodeIndex];
      if (!series || !episode) return;
      if (episode.status === "published") {
        throw new SeriesStoreConflictError("这一集已经发布，不能直接改写系列正史；请创建更正集或正式修订版本。");
      }
      const downstream = blockingDownstreamEpisode(series, episode);
      if (downstream) {
        throw new SeriesStoreConflictError(`第 ${downstream.episodeNumber} 集已经采用或进入制作，不能再直接改写它依赖的第 ${episode.episodeNumber} 集。`);
      }
      if (activeEditLease(episode, createdAt) && episode.editLease?.id !== leaseId) {
        throw new SeriesStoreConflictError(`第 ${episode.episodeNumber} 集正在被另一个编辑操作修改，请稍后重试。`);
      }
      if (episode.editLease?.id === leaseId) return;
      const episodes = series.episodes.map((candidate, index) => index === episodeIndex
        ? { ...candidate, editLease: { id: leaseId, createdAt } }
        : candidate);
      file.series[seriesIndex] = { ...series, episodes };
      await this.write(file);
    });
  }

  async releaseRunEditLease(runId: string, leaseId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const file = await this.read();
      const seriesIndex = file.series.findIndex((candidate) => candidate.episodes.some((episode) => episode.runId === runId));
      const series = file.series[seriesIndex];
      const episodeIndex = series?.episodes.findIndex((candidate) => candidate.runId === runId) ?? -1;
      const episode = series?.episodes[episodeIndex];
      if (!series || !episode || episode.editLease?.id !== leaseId) return;
      const episodes = series.episodes.map((candidate, index) => {
        if (index !== episodeIndex) return candidate;
        const { editLease: _lease, ...withoutLease } = candidate;
        return withoutLease;
      });
      file.series[seriesIndex] = { ...series, episodes };
      await this.write(file);
    });
  }

  async assertRunEditable(runId: string): Promise<void> {
    const series = (await this.read()).series.find((candidate) => candidate.episodes.some((episode) => episode.runId === runId));
    const episode = series?.episodes.find((candidate) => candidate.runId === runId);
    if (!series || !episode) return;
    if (episode.status === "published") {
      throw new SeriesStoreConflictError("这一集已经发布，不能直接改写系列正史；请创建更正集或正式修订版本。");
    }
    const downstream = blockingDownstreamEpisode(series, episode);
    if (downstream) {
      throw new SeriesStoreConflictError(`第 ${downstream.episodeNumber} 集已经采用或进入制作，不能再直接改写它依赖的第 ${episode.episodeNumber} 集。`);
    }
  }

  async reconcileRuns(runs: SeriesRunSnapshot[], updatedAt: string): Promise<void> {
    const snapshots = new Map(runs.map((run) => [run.id, run]));
    await this.withWriteLock(async () => {
      const file = await this.read();
      let changed = false;
      file.series = file.series.map((series) => {
        let episodes = structuredClone(series.episodes);

        // 进程在 dispatch 后、绑定前退出时，使用可信 run 元数据恢复唯一绑定。
        episodes = episodes.map((episode) => {
          if ((episode.status !== "selected" && !isMigrationPendingEpisode(episode)) || episode.runId) return episode;
          const matches = runs.filter((run) => run.seriesId === series.id
            && run.episodeNumber === episode.episodeNumber
            && run.opportunityId === episode.opportunityId
            && !(episode.attemptRunIds ?? []).includes(run.id)
            && (episode.runReservation
              ? run.productionReservationId === episode.runReservation.id
              : run.productionReservationId === undefined && run.status !== "failed" && run.status !== "rejected"));
          if (matches.length === 0 && expiredRunReservation(episode, updatedAt)) {
            const { runReservation: _reservation, ...withoutReservation } = episode;
            return { ...withoutReservation, updatedAt };
          }
          if (matches.length !== 1) return episode;
          const run = matches[0]!;
          const { runReservation: _reservation, ...withoutReservation } = episode;
          return {
            ...withoutReservation,
            status: "in_production" as const,
            runId: run.id,
            attemptRunIds: [...new Set([...(episode.attemptRunIds ?? []), run.id])],
            lastObservedRun: { id: run.id, revision: run.revision },
            updatedAt,
          };
        });

        episodes = episodes.map((episode) => {
          if (!episode.runId) return episode;
          const run = snapshots.get(episode.runId);
          if (run && isOlderRunSnapshot(episode, run)) return episode;
          if (run?.status === "failed" && run.outcomeUncertain) {
            return {
              ...episode,
              status: "paused" as const,
              continuity: {
                ...episode.continuity,
                memorySummary: "付费任务曾被受理但结果尚未核对；系统已锁住本集，禁止另起一次付费制作。",
              },
              lastObservedRun: { id: run.id, revision: run.revision },
              updatedAt,
            };
          }
          if (!run || run.status === "failed" || run.status === "rejected") {
            if (episode.status === "published") return episode;
            const { runId: _runId, runReservation: _reservation, ...withoutRun } = episode;
            const { memorySummary: _memorySummary, ...continuity } = episode.continuity;
            return {
              ...withoutRun,
              status: "selected" as const,
              continuity,
              ...(run ? { lastObservedRun: { id: run.id, revision: run.revision } } : {}),
              updatedAt,
            };
          }
          if (run.status === "succeeded" && run.canonProposal) {
            const nextStatus = episode.status === "published" ? "published" as const : "ready" as const;
            if (episode.status === nextStatus && episode.continuity.memorySummary === run.canonProposal.memorySummary) {
              return isSameObservedRun(episode, run)
                ? episode
                : { ...episode, lastObservedRun: { id: run.id, revision: run.revision }, updatedAt };
            }
            return {
              ...episode,
              status: nextStatus,
              continuity: { ...episode.continuity, memorySummary: run.canonProposal.memorySummary },
              lastObservedRun: { id: run.id, revision: run.revision },
              updatedAt,
            };
          }
          if (run.status === "succeeded" && isMigrationEpisode(episode)) {
            return {
              ...episode,
              status: episode.status === "published" ? "published" as const : "ready" as const,
              continuity: {
                ...episode.continuity,
                memorySummary: episode.continuity.memorySummary
                  ?? "历史成片已恢复。旧任务没有结构化内容记忆，下一集请人工补充承接要求。",
              },
              lastObservedRun: { id: run.id, revision: run.revision },
              updatedAt,
            };
          }
          if (episode.status === "ready") {
            const { memorySummary: _memorySummary, ...continuity } = episode.continuity;
            return {
              ...episode,
              status: "in_production" as const,
              continuity,
              lastObservedRun: { id: run.id, revision: run.revision },
              updatedAt,
            };
          }
          return { ...episode, lastObservedRun: { id: run.id, revision: run.revision } };
        });

        const activeFacts = episodes
          .filter((episode) => (episode.status === "ready" || episode.status === "published") && episode.runId)
          .sort((left, right) => left.episodeNumber - right.episodeNumber)
          .flatMap((episode) => {
            const run = snapshots.get(episode.runId!);
            if (!run || isOlderRunSnapshot(episode, run)) {
              return series.canon.facts.filter((fact) => fact.sourceEpisodeId === episode.id);
            }
            if (run?.status !== "succeeded" || !run.canonProposal) return [];
            return run.canonProposal.statements.map((statement, statementIndex) => ({
              id: `canon-${episode.id}-${run.id}-${run.revision}-${statementIndex + 1}`,
              statement,
              sourceEpisodeId: episode.id,
              sourceRunId: run.id,
              sourceRunRevision: run.revision,
              sourceOutputVersionIds: [...run.canonProposal!.sourceOutputVersionIds],
              acceptedAt: updatedAt,
            }));
          });
        const canonChanged = canonFactsIdentity(series.canon.facts) !== canonFactsIdentity(activeFacts);
        const canon = canonChanged
          ? { revision: series.canon.revision + 1, facts: activeFacts }
          : series.canon;
        const activeSummaries = new Map(episodes
          .filter((episode) => episode.continuity.memorySummary)
          .map((episode) => [episode.id, episode.continuity.memorySummary!]));
        episodes = episodes.map((episode) => {
          const previousEpisode = episode.previousEpisodeId
            ? episodes.find((candidate) => candidate.id === episode.previousEpisodeId)
            : undefined;
          const previousSummary = previousEpisode ? activeSummaries.get(previousEpisode.id) : undefined;
          const inheritedFromPrevious = previousSummary
            ? [previousSummary]
            : [...new Set(previousEpisode?.continuity.toNext ?? [])];
          const inheritedChanged = JSON.stringify(episode.continuity.inheritedFromPrevious) !== JSON.stringify(inheritedFromPrevious);
          const canStillBeGreenlit = episode.status === "planned"
            || (episode.status === "selected" && !episode.runId && !episode.runReservation);
          const planning = canStillBeGreenlit
            && (episode.canonBaseRevision !== canon.revision || inheritedChanged)
            ? {
                ...episode.planning,
                auditStatus: "stale" as const,
                auditSummary: episode.canonBaseRevision !== canon.revision
                  ? "系列正史已更新，采用前需要重新审计。"
                  : "上一集的正式交接已更新，采用前需要重新审计。",
              }
            : episode.planning;
          return {
            ...episode,
            planning,
            continuity: { ...episode.continuity, inheritedFromPrevious },
          };
        });

        if (!canonChanged && seriesEpisodesIdentity(series.episodes) === seriesEpisodesIdentity(episodes)) return series;
        changed = true;
        return { ...series, episodes, canon, revision: series.revision + 1, updatedAt };
      });
      if (changed) await this.write(file);
    });
  }

  async markRunPublished(runId: string, publishedAt: string): Promise<void> {
    await this.withWriteLock(async () => {
      const file = await this.read();
      let changed = false;
      file.series = file.series.map((series) => {
        const episodeIndex = series.episodes.findIndex((episode) => episode.runId === runId);
        const episode = series.episodes[episodeIndex];
        if (!episode || episode.status === "published") return series;
        if (episode.status !== "ready") {
          throw new SeriesStoreConflictError("只有已经内部定版的系列单集才能标记为外部发布。");
        }
        changed = true;
        const episodes = series.episodes.map((candidate, index) => {
          if (index === episodeIndex) {
            return { ...candidate, status: "published" as const, publishedAt, updatedAt: publishedAt };
          }
          return candidate;
        });
        return {
          ...series,
          episodes,
          revision: series.revision + 1,
          updatedAt: publishedAt,
        };
      });
      if (changed) await this.write(file);
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      releaseFileLock = await lock(this.filePath, {
        realpath: false,
        stale: STALE_SERIES_LOCK_AGE_MS,
        update: Math.floor(STALE_SERIES_LOCK_AGE_MS / 2),
        retries: 0,
      });
      return await operation();
    } catch (error) {
      if (isLockConflict(error)) {
        throw new SeriesStoreConflictError("系列数据正在被另一个服务更新，请稍后重试。");
      }
      throw error;
    } finally {
      if (releaseFileLock) await releaseFileLock().catch(() => undefined);
      release();
    }
  }

  private async read(): Promise<SeriesFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { version?: unknown; series?: unknown };
      if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.series)) {
        throw new Error(`Unsupported series store format at '${this.filePath}'.`);
      }
      return {
        version: 2,
        series: parsed.series.map((record) => normalizeSeriesRecord(record)),
      };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 2, series: [] };
      throw error;
    }
  }

  private async write(file: SeriesFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function normalizeSeriesRecord(value: unknown): SeriesRecord {
  const record = value as Partial<SeriesRecord>;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString();
  const premise = typeof record.premise === "string" ? record.premise : "延续系列承诺";
  const visualStyle = typeof record.visualStyle === "string" ? record.visualStyle : "保持一致的视觉语言";
  const existingEpisodes = Array.isArray(record.episodes)
    ? record.episodes.map(normalizeEpisode)
    : [];
  const existingNumbers = new Set(existingEpisodes.map((episode) => episode.episodeNumber));
  const episodes = [
    ...historicalAdoptedEpisodes(record, createdAt, premise)
      .filter((episode) => !existingNumbers.has(episode.episodeNumber)),
    ...existingEpisodes,
  ]
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .map((episode, index, ordered) => {
      const predecessor = ordered[index - 1];
      return episode.episodeNumber > 1
        && episode.previousEpisodeId === undefined
        && predecessor?.episodeNumber === episode.episodeNumber - 1
        ? { ...episode, previousEpisodeId: predecessor.id }
        : episode;
    });
  return {
    ...(record as SeriesRecord),
    revision: Number.isSafeInteger(record.revision) && Number(record.revision) > 0 ? Number(record.revision) : 1,
    currentSeason: record.currentSeason ?? { number: 1, title: "第一季", arc: premise },
    bible: record.bible ?? {
      rules: [premise, `保持“${visualStyle}”的视觉连续性。`],
      recurringElements: [],
      forbiddenChanges: ["不得在没有说明的情况下改写已经建立的事实、人物关系或结论。"],
    },
    canon: record.canon && typeof record.canon === "object" && "revision" in record.canon
      ? record.canon
      : { revision: 0, facts: [] },
    episodes,
    nextEpisodeNumber: Number.isSafeInteger(record.nextEpisodeNumber) && Number(record.nextEpisodeNumber) > 0
      ? Number(record.nextEpisodeNumber)
      : 1,
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}

function normalizeEpisode(episode: StudioSeriesEpisode): StudioSeriesEpisode {
  const { lastObservedRun, ...withoutObservedRun } = episode;
  const migrationPending = episode.status === "selected"
    && !episode.runId
    && episode.planning?.providerId === "series-store-migration-v2";
  return {
    ...withoutObservedRun,
    ...(migrationPending ? { status: "paused" as const } : {}),
    canonBaseRevision: episode.canonBaseRevision ?? 0,
    ...(isObservedRun(lastObservedRun) ? { lastObservedRun } : {}),
    continuity: {
      inheritedFromPrevious: episode.continuity?.inheritedFromPrevious ?? [],
      fromPrevious: episode.continuity?.fromPrevious ?? [],
      toNext: episode.continuity?.toNext ?? [],
      canonChecks: episode.continuity?.canonChecks ?? [],
      ...(episode.continuity?.memorySummary ? { memorySummary: episode.continuity.memorySummary } : {}),
    },
    planning: episode.planning ?? {
      source: "rules",
      role: "系列总编",
      auditRole: "历史记录迁移",
      auditStatus: "fallback",
      auditIterations: 0,
      providerId: "series-roadmap-v1",
      modelId: "deterministic",
      promptVersion: "video-factory/series-migration-v2",
      fallbackReason: "该单集创建于 Agent 策划记录启用之前。",
    },
  };
}

function historicalAdoptedEpisodes(
  record: Partial<SeriesRecord>,
  createdAt: string,
  premise: string,
): StudioSeriesEpisode[] {
  const adoptedCount = Math.max(0, (Number.isSafeInteger(record.nextEpisodeNumber) ? Number(record.nextEpisodeNumber) : 1) - 1);
  const seriesId = typeof record.id === "string" ? record.id : "legacy-series";
  const seasonNumber = record.currentSeason?.number ?? 1;
  const arc = record.currentSeason?.arc ?? premise;
  const pillars = Array.isArray(record.pillars) && record.pillars.length > 0 ? record.pillars : [premise];
  return Array.from({ length: adoptedCount }, (_, index) => {
    const episodeNumber = index + 1;
    const id = `series-${seriesId}-episode-${String(episodeNumber).padStart(3, "0")}`;
    return {
      id,
      seriesId,
      episodeNumber,
      seasonNumber,
      arc,
      pillar: pillars[index % pillars.length]!,
      title: `${record.name ?? "历史系列"} ${String(episodeNumber).padStart(2, "0")}｜历史已采用单集`,
      viewerPromise: premise,
      hook: "保留迁移前已经采用的系列单集。",
      payoff: "等待关联历史制作记录并恢复正式的已确认内容。",
      ...(episodeNumber > 1 ? {
        previousEpisodeId: `series-${seriesId}-episode-${String(episodeNumber - 1).padStart(3, "0")}`,
      } : {}),
      canonBaseRevision: 0,
      status: "paused",
      opportunityId: id,
      continuity: {
        inheritedFromPrevious: [],
        fromPrevious: [],
        toNext: [],
        canonChecks: ["迁移记录不能冒充已经重新核验的系列正史。"],
      },
      planning: {
        source: "human",
        role: "历史主创",
        auditRole: "历史记录迁移",
        auditStatus: "human_override",
        auditIterations: 0,
        providerId: "series-store-migration-v2",
        modelId: "manual",
        promptVersion: "video-factory/series-migration-v2",
        fallbackReason: "该单集在独立开拍审计启用前已经由创作者采用。",
      },
      createdAt,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
    };
  });
}

function canonFactsIdentity(facts: StudioSeries["canon"]["facts"]): string {
  return JSON.stringify(facts.map(({ acceptedAt: _acceptedAt, ...fact }) => fact));
}

function seriesEpisodesIdentity(episodes: StudioSeriesEpisode[]): string {
  return JSON.stringify(episodes);
}

function blockingPriorEpisode(series: SeriesRecord, episode: StudioSeriesEpisode): StudioSeriesEpisode | undefined {
  return [...series.episodes]
    .filter((candidate) => candidate.episodeNumber < episode.episodeNumber)
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .find((candidate) => (candidate.status !== "ready" && candidate.status !== "published")
      || (!isMigrationEpisode(candidate)
        && !series.canon.facts.some((fact) => fact.sourceEpisodeId === candidate.id)));
}

function blockingDownstreamEpisode(series: SeriesRecord, episode: StudioSeriesEpisode): StudioSeriesEpisode | undefined {
  return [...series.episodes]
    .filter((candidate) => candidate.episodeNumber > episode.episodeNumber)
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .find((candidate) => candidate.status !== "planned" || Boolean(candidate.runReservation));
}

function activeEditLease(episode: StudioSeriesEpisode, now: string): boolean {
  if (!episode.editLease) return false;
  const createdAt = Date.parse(episode.editLease.createdAt);
  const checkedAt = Date.parse(now);
  return !Number.isFinite(createdAt)
    || !Number.isFinite(checkedAt)
    || checkedAt - createdAt < STALE_RUN_EDIT_LEASE_AGE_MS;
}

function expiredRunReservation(episode: StudioSeriesEpisode, now: string): boolean {
  if (!episode.runReservation) return false;
  const createdAt = Date.parse(episode.runReservation.createdAt);
  const checkedAt = Date.parse(now);
  return Number.isFinite(createdAt)
    && Number.isFinite(checkedAt)
    && checkedAt - createdAt >= STALE_RUN_RESERVATION_AGE_MS;
}

function isOlderRunSnapshot(episode: StudioSeriesEpisode, run: SeriesRunSnapshot): boolean {
  return episode.lastObservedRun?.id === run.id && run.revision < episode.lastObservedRun.revision;
}

function isSameObservedRun(episode: StudioSeriesEpisode, run: SeriesRunSnapshot): boolean {
  return episode.lastObservedRun?.id === run.id && episode.lastObservedRun.revision === run.revision;
}

function isMigrationPendingEpisode(episode: StudioSeriesEpisode): boolean {
  return episode.status === "paused"
    && !episode.runId
    && episode.planning.providerId === "series-store-migration-v2";
}

function isMigrationEpisode(episode: StudioSeriesEpisode): boolean {
  return episode.planning.providerId === "series-store-migration-v2";
}

function isObservedRun(value: unknown): value is NonNullable<StudioSeriesEpisode["lastObservedRun"]> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { id?: unknown }).id === "string"
    && Number.isSafeInteger((value as { revision?: unknown }).revision)
    && Number((value as { revision: number }).revision) >= 0;
}

function isLockConflict(error: unknown): boolean {
  return hasCode(error, "ELOCKED") || hasCode(error, "ECOMPROMISED");
}

export class SeriesStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesStoreConflictError";
  }
}

export class SeriesStoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesStoreNotFoundError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
