import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StudioSeries } from "../shared/api.js";

export type SeriesRecord = StudioSeries;

export interface StudioSeriesRepository {
  list(): Promise<SeriesRecord[]>;
  get(id: string): Promise<SeriesRecord | undefined>;
  create(record: SeriesRecord): Promise<SeriesRecord>;
  advanceEpisode(id: string, expectedEpisodeNumber: number, updatedAt: string): Promise<SeriesRecord>;
  advancePastEpisode(id: string, adoptedEpisodeNumber: number, updatedAt: string): Promise<SeriesRecord>;
}

interface SeriesFile {
  version: 1;
  series: SeriesRecord[];
}

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

  async advanceEpisode(id: string, expectedEpisodeNumber: number, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      if (current.nextEpisodeNumber !== expectedEpisodeNumber) {
        throw new SeriesStoreConflictError(`这个系列已经推进到第 ${current.nextEpisodeNumber} 集，请刷新后再试。`);
      }
      const updated = { ...current, nextEpisodeNumber: current.nextEpisodeNumber + 1, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  async advancePastEpisode(id: string, adoptedEpisodeNumber: number, updatedAt: string): Promise<SeriesRecord> {
    return this.withWriteLock(async () => {
      const file = await this.read();
      const index = file.series.findIndex((item) => item.id === id);
      const current = file.series[index];
      if (!current) throw new SeriesStoreNotFoundError("没有找到这个系列。");
      const nextEpisodeNumber = Math.max(current.nextEpisodeNumber, adoptedEpisodeNumber + 1);
      if (nextEpisodeNumber === current.nextEpisodeNumber) return structuredClone(current);
      const updated = { ...current, nextEpisodeNumber, updatedAt };
      file.series[index] = updated;
      await this.write(file);
      return structuredClone(updated);
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<SeriesFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as SeriesFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.series)) {
        throw new Error(`Unsupported series store format at '${this.filePath}'.`);
      }
      return parsed;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, series: [] };
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
