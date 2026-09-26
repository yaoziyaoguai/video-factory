import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TopicCandidate } from "@video-factory/workflow-core";
import type { ProductionArticleSourceSnapshot } from "@video-factory/production-pipeline";
import type { StudioArticleFact, StudioCandidateOrigin, StudioCandidateVerification, StudioEditorialDecision, StudioTopicCategory, StudioVisualPlan } from "../shared/api.js";

export interface OpportunityRecord {
  title: string;
  adoptedCandidateGenerationId?: string;
  adoptedCandidateAuditStatus?: "passed" | "awaiting_user" | "not_audited";
  candidate: TopicCandidate;
  scoreProvenance?: {
    source: string;
    scoredAt: string;
  };
  createdAt: string;
  updatedAt: string;
  origin?: "manual" | StudioCandidateOrigin;
  category?: StudioTopicCategory;
  seriesId?: string;
  seriesName?: string;
  episodeNumber?: number;
  verification?: StudioCandidateVerification;
  editorialDecision?: StudioEditorialDecision;
  visualProof?: string;
  visualPlan?: StudioVisualPlan;
  articleSources?: ProductionArticleSourceSnapshot[];
  articleFacts?: StudioArticleFact[];
  articleUncertainties?: string[];
}

export interface StudioOpportunityRepository {
  list(): Promise<OpportunityRecord[]>;
  get(id: string): Promise<OpportunityRecord | undefined>;
  create(record: OpportunityRecord): Promise<OpportunityRecord>;
  updateStatus(id: string, status: TopicCandidate["status"], updatedAt: string): Promise<OpportunityRecord>;
  appendEvidence(id: string, evidence: OpportunityRecord["candidate"]["evidence"], updatedAt: string): Promise<OpportunityRecord>;
}

interface OpportunityFile {
  version: 1;
  opportunities: OpportunityRecord[];
}

const ALLOWED_TRANSITIONS: Record<TopicCandidate["status"], TopicCandidate["status"][]> = {
  draft: ["shortlisted", "approved", "rejected"],
  shortlisted: ["approved", "rejected"],
  approved: ["tested", "rejected"],
  rejected: ["draft"],
  tested: ["approved", "rejected"],
};

export class JsonOpportunityStore implements StudioOpportunityRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<OpportunityRecord[]> {
    const file = await this.read();
    return structuredClone(file.opportunities).sort((left, right) =>
      right.candidate.score.final - left.candidate.score.final || right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async get(id: string): Promise<OpportunityRecord | undefined> {
    const record = (await this.read()).opportunities.find((candidate) => candidate.candidate.id === id);
    return record ? structuredClone(record) : undefined;
  }

  async create(record: OpportunityRecord): Promise<OpportunityRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      if (file.opportunities.some((candidate) => candidate.candidate.id === record.candidate.id)) {
        throw new OpportunityStoreConflictError(`Opportunity '${record.candidate.id}' already exists.`);
      }
      file.opportunities.push(structuredClone(record));
      await this.write(file);
      return structuredClone(record);
    });
  }

  async updateStatus(
    id: string,
    status: TopicCandidate["status"],
    updatedAt: string,
  ): Promise<OpportunityRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.opportunities.findIndex((candidate) => candidate.candidate.id === id);
      const current = file.opportunities[index];
      if (!current) {
        throw new OpportunityStoreNotFoundError(`Opportunity '${id}' was not found.`);
      }
      if (current.candidate.status !== status && !ALLOWED_TRANSITIONS[current.candidate.status].includes(status)) {
        throw new OpportunityStoreConflictError(
          `Opportunity status cannot change from '${current.candidate.status}' to '${status}'.`,
        );
      }
      const updated: OpportunityRecord = {
        ...current,
        candidate: { ...current.candidate, status },
        updatedAt,
      };
      file.opportunities[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  // 人工补充来源是 add-only mutation：只追加 evidence、刷新 updatedAt，
  // 并发追加在写锁内取并集，status/score/scoreProvenance 等其他字段一概不动。
  async appendEvidence(
    id: string,
    evidence: OpportunityRecord["candidate"]["evidence"],
    updatedAt: string,
  ): Promise<OpportunityRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.opportunities.findIndex((candidate) => candidate.candidate.id === id);
      const current = file.opportunities[index];
      if (!current) {
        throw new OpportunityStoreNotFoundError(`Opportunity '${id}' was not found.`);
      }
      const existingKeys = new Set(current.candidate.evidence.map((item) => item.evidenceUrl ?? `${item.source}:${item.keyword}`));
      const additions = evidence.filter((item) => !existingKeys.has(item.evidenceUrl ?? `${item.source}:${item.keyword}`));
      const updated: OpportunityRecord = additions.length === 0
        ? { ...current, updatedAt }
        : {
            ...current,
            candidate: { ...current.candidate, evidence: [...current.candidate.evidence, ...structuredClone(additions)] },
            updatedAt,
          };
      file.opportunities[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<OpportunityFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as OpportunityFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.opportunities)) {
        throw new Error(`Unsupported opportunity store format at '${this.filePath}'.`);
      }
      return parsed;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { version: 1, opportunities: [] };
      }
      throw error;
    }
  }

  private async write(file: OpportunityFile): Promise<void> {
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

export class OpportunityStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityStoreConflictError";
  }
}

export class OpportunityStoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityStoreNotFoundError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
