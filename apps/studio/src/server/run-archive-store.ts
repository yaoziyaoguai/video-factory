import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";

export interface RunArchiveRepository {
  list(): Promise<Record<string, string>>;
  archive(runIds: string[], archivedAt: string): Promise<void>;
  restore(runIds: string[]): Promise<void>;
}

interface RunArchiveFile {
  version: 1;
  archived: Record<string, string>;
}

export class JsonRunArchiveStore implements RunArchiveRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<Record<string, string>> {
    return { ...(await this.read()).archived };
  }

  async archive(runIds: string[], archivedAt: string): Promise<void> {
    await this.update((file) => {
      for (const runId of runIds) file.archived[runId] = archivedAt;
    });
  }

  async restore(runIds: string[]): Promise<void> {
    await this.update((file) => {
      for (const runId of runIds) delete file.archived[runId];
    });
  }

  private async update(mutator: (file: RunArchiveFile) => void): Promise<void> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      releaseFileLock = await lock(this.filePath, {
        realpath: false,
        stale: 5 * 60_000,
        update: 150_000,
        retries: { retries: 20, minTimeout: 5, maxTimeout: 50 },
      });
      const file = await this.read();
      mutator(file);
      await this.write(file);
    } finally {
      if (releaseFileLock) await releaseFileLock().catch(() => undefined);
      release();
    }
  }

  private async read(): Promise<RunArchiveFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<RunArchiveFile>;
      if (parsed.version !== 1 || !isStringRecord(parsed.archived)) {
        throw new Error(`Unsupported run archive format at '${this.filePath}'.`);
      }
      return { version: 1, archived: { ...parsed.archived } };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, archived: {} };
      throw error;
    }
  }

  private async write(file: RunArchiveFile): Promise<void> {
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === "string");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
