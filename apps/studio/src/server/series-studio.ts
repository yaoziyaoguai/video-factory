import { randomUUID } from "node:crypto";
import type { StudioCandidateInboxItem, StudioSeries, StudioSeriesInput } from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { SeriesPlanner } from "./series-planner.js";
import {
  SeriesStoreConflictError,
  SeriesStoreNotFoundError,
  type StudioSeriesRepository,
} from "./series-store.js";

export interface SeriesStudioOptions {
  series: StudioSeriesRepository;
  planner?: Pick<SeriesPlanner, "plan">;
  now?: () => Date;
  createId?: () => string;
}

export class SeriesStudio {
  private readonly planner: Pick<SeriesPlanner, "plan">;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: SeriesStudioOptions) {
    this.planner = options.planner ?? new SeriesPlanner(options.now ? { now: options.now } : {});
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `series-${randomUUID()}`);
  }

  list(): Promise<StudioSeries[]> {
    return this.options.series.list();
  }

  async create(input: StudioSeriesInput): Promise<StudioSeries> {
    const timestamp = this.now().toISOString();
    try {
      return await this.options.series.create({
        id: this.createId(),
        ...input,
        status: "active",
        nextEpisodeNumber: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async listCandidates(): Promise<StudioCandidateInboxItem[]> {
    return (await this.options.series.list())
      .filter((series) => series.status === "active")
      .flatMap((series) => this.planner.plan(series, 6));
  }

  async advanceEpisode(seriesId: string, expectedEpisodeNumber: number): Promise<StudioSeries> {
    try {
      return await this.options.series.advancePastEpisode(seriesId, expectedEpisodeNumber, this.now().toISOString());
    } catch (error) {
      if (error instanceof SeriesStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof SeriesStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }
}
