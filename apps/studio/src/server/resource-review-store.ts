import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { StudioConflictError } from "./studio-errors.js";

export interface ResourceReviewDecision {
  action: "confirmed" | "rejected";
  reviewedAt: string;
  reviewedBy: string;
  fingerprint: string;
  note?: string;
}

interface ReviewFile { version: 1; revision: number; decisions: Record<string, ResourceReviewDecision> }

export class ResourceReviewStore {
  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<ReviewFile> { return this.read(); }

  async record(key: string, decision: ResourceReviewDecision, expectedRevision: number): Promise<ReviewFile> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const release = await lock(this.filePath, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
    try {
      const file = await this.read();
      if (file.revision !== expectedRevision) throw new StudioConflictError("授权审核已被其他操作更新，请刷新后重试。");
      const next = { version: 1 as const, revision: file.revision + 1, decisions: { ...file.decisions, [key]: decision } };
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return next;
    } finally {
      await release().catch(() => undefined);
    }
  }

  private async read(): Promise<ReviewFile> {
    try {
      return parseReviewFile(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, decisions: {} };
      throw error;
    }
  }
}

function parseReviewFile(value: unknown): ReviewFile {
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !isRecord(value.decisions)) {
    throw new Error("授权审核账本格式无效。");
  }
  const decisions = Object.fromEntries(Object.entries(value.decisions).map(([key, decision]) => {
    if (!key || key.length > 512 || !isRecord(decision)
      || (decision.action !== "confirmed" && decision.action !== "rejected")
      || !boundedText(decision.reviewedAt, 64)
      || Number.isNaN(Date.parse(decision.reviewedAt))
      || !boundedText(decision.reviewedBy, 256)
      || !boundedText(decision.fingerprint, 8_192)
      || (decision.note !== undefined && !boundedText(decision.note, 2_000))
      || (decision.action === "rejected" && !boundedText(decision.note, 2_000))) {
      throw new Error("授权审核账本格式无效。");
    }
    return [key, {
      action: decision.action,
      reviewedAt: decision.reviewedAt,
      reviewedBy: decision.reviewedBy,
      fingerprint: decision.fingerprint,
      ...(typeof decision.note === "string" ? { note: decision.note } : {}),
    } satisfies ResourceReviewDecision];
  }));
  return { version: 1, revision: Number(value.revision), decisions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
