import { randomUUID } from "node:crypto";
import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type {
  StudioOpportunity,
  StudioOpportunityInput,
  StudioOpportunityStatus,
} from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import {
  OpportunityStoreConflictError,
  OpportunityStoreNotFoundError,
  type OpportunityRecord,
  type StudioOpportunityRepository,
} from "./opportunity-store.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";

export interface OpportunityStudioOptions {
  opportunities: StudioOpportunityRepository;
  now?: () => Date;
  createId?: () => string;
}

export class OpportunityStudio {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: OpportunityStudioOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `opportunity-${randomUUID()}`);
  }

  async list(): Promise<StudioOpportunity[]> {
    return (await this.options.opportunities.list()).map(toOpportunity);
  }

  async get(opportunityId: string): Promise<StudioOpportunity | undefined> {
    const record = await this.options.opportunities.get(opportunityId);
    return record ? toOpportunity(record) : undefined;
  }

  async create(input: StudioOpportunityInput): Promise<StudioOpportunity> {
    const timestamp = this.now().toISOString();
    const candidate = scoreTopicCandidate(input.candidateId ?? this.createId(), {
      platform: input.platform,
      track: input.track,
      audience: input.audience,
      painPoint: input.painPoint,
      hook: input.hook,
      evidence: input.evidence,
      ...input.scores,
    });
    try {
      const visualPlan = input.visualPlan ?? planVisualDirection({
        title: input.title,
        hook: input.hook,
        ...(input.category ? { category: input.category } : {}),
      });
      return toOpportunity(await this.options.opportunities.create({
        title: input.title,
        candidate,
        scoreProvenance: {
          source: input.origin === "series"
            ? "系列策划 · series-planner-v1"
            : input.origin === "trend"
              ? "热点候选 · topic-intelligence-v1"
              : "录入时估分 · topic-intelligence-v1",
          scoredAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.seriesId ? { seriesId: input.seriesId } : {}),
        ...(input.seriesName ? { seriesName: input.seriesName } : {}),
        ...(input.episodeNumber ? { episodeNumber: input.episodeNumber } : {}),
        ...(input.verification ? { verification: structuredClone(input.verification) } : {}),
        ...(input.editorialDecision ? { editorialDecision: structuredClone(input.editorialDecision) } : {}),
        visualPlan,
      }));
    } catch (error) {
      if (error instanceof OpportunityStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }

  async updateStatus(opportunityId: string, status: StudioOpportunityStatus): Promise<StudioOpportunity> {
    try {
      return toOpportunity(await this.options.opportunities.updateStatus(opportunityId, status, this.now().toISOString()));
    } catch (error) {
      if (error instanceof OpportunityStoreNotFoundError) throw new StudioNotFoundError(error.message);
      if (error instanceof OpportunityStoreConflictError) throw new StudioConflictError(error.message);
      throw error;
    }
  }
}

function toOpportunity(record: OpportunityRecord): StudioOpportunity {
  const visualPlan = record.visualPlan ?? planVisualDirection({
    title: record.title,
    hook: record.candidate.hook,
    ...(record.category ? { category: record.category } : {}),
  });
  return {
    id: record.candidate.id,
    title: record.title,
    platform: record.candidate.platform,
    track: record.candidate.track,
    audience: record.candidate.audience,
    painPoint: record.candidate.painPoint,
    hook: record.candidate.hook,
    status: record.candidate.status,
    score: { ...record.candidate.score },
    scoreProvenance: record.scoreProvenance
      ? { ...record.scoreProvenance }
      : { source: "历史记录 · topic-intelligence-v1", scoredAt: record.createdAt },
    evidence: record.candidate.evidence.map((signal) => ({ ...signal })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.category ? { category: record.category } : {}),
    ...(record.seriesId ? { seriesId: record.seriesId } : {}),
    ...(record.seriesName ? { seriesName: record.seriesName } : {}),
    ...(record.episodeNumber ? { episodeNumber: record.episodeNumber } : {}),
    ...(record.verification ? { verification: structuredClone(record.verification) } : {}),
    ...(record.editorialDecision ? { editorialDecision: structuredClone(record.editorialDecision) } : {}),
    visualPlan: structuredClone(visualPlan),
  };
}
