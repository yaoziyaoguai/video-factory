import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowRun } from "@video-factory/workflow-core";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STALE_LOCK_AGE_MS = 60_000;

export class FileRunStore {
  constructor(private readonly root: string) {}

  async create(run: WorkflowRun): Promise<void> {
    const runDirectory = this.runDirectory(run.id);
    await mkdir(runDirectory, { recursive: true });
    try {
      await writeFile(this.runPath(run.id), `${JSON.stringify(run, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new Error(`Run '${run.id}' already exists.`);
      }
      throw error;
    }
  }

  async load<TInitialInput = unknown>(runId: string): Promise<WorkflowRun<TInitialInput>> {
    const payload = await readFile(this.runPath(runId), "utf8");
    return JSON.parse(payload) as WorkflowRun<TInitialInput>;
  }

  async list<TInitialInput = unknown>(): Promise<WorkflowRun<TInitialInput>[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const runs: WorkflowRun<TInitialInput>[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        runs.push(await this.load<TInitialInput>(entry.name));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    return runs.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
  }

  async remove(runId: string): Promise<void> {
    await this.withLock(runId, async () => {
      await this.load(runId);
      await rm(this.runDirectory(runId), { recursive: true });
    });
  }

  async save(run: WorkflowRun, expectedRevision: number): Promise<void> {
    await this.withLock(run.id, async () => {
      const current = await this.load(run.id);
      if (current.revision !== expectedRevision || run.revision !== expectedRevision + 1) {
        throw new StaleRunRevisionError(run.id, expectedRevision, current.revision);
      }
      await this.writeAtomically(run);
    });
  }

  async checkpoint(run: WorkflowRun): Promise<void> {
    await this.withLock(run.id, async () => {
      const current = await this.load(run.id);
      if (current.revision !== run.revision) {
        throw new StaleRunRevisionError(run.id, run.revision, current.revision);
      }
      await this.writeAtomically(run);
    });
  }

  async update<TInitialInput = unknown>(
    runId: string,
    transition: (current: WorkflowRun<TInitialInput>) => Promise<WorkflowRun<TInitialInput>>,
  ): Promise<WorkflowRun<TInitialInput>> {
    return this.withLock(runId, async () => {
      const current = await this.load<TInitialInput>(runId);
      const updated = await transition(current);
      if (updated.id !== current.id || updated.revision !== current.revision + 1) {
        throw new StaleRunRevisionError(runId, current.revision, updated.revision);
      }
      await this.writeAtomically(updated);
      return updated;
    });
  }

  runDirectory(runId: string): string {
    validateRunId(runId);
    return path.join(this.root, runId);
  }

  runPath(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private async writeAtomically(run: WorkflowRun): Promise<void> {
    const destination = this.runPath(run.id);
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  }

  private async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.runDirectory(runId), "run.lock");
    const lock = await this.acquireLock(runId, lockPath);
    try {
      return await operation();
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }

  private async acquireLock(runId: string, lockPath: string): Promise<FileHandle> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(lockPath, "wx");
        try {
          await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
          return lock;
        } catch (error) {
          try {
            await lock.close();
          } finally {
            await rm(lockPath, { force: true });
          }
          throw error;
        }
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        if (attempt === 0 && await isStaleLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new RunLockedError(runId);
      }
    }
    throw new RunLockedError(runId);
  }
}

export class RunLockedError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' is locked by another writer.`);
    this.name = "RunLockedError";
  }
}

export class StaleRunRevisionError extends Error {
  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stale run revision for '${runId}': expected ${expectedRevision}, current revision is ${actualRevision}.`,
    );
    this.name = "StaleRunRevisionError";
  }
}

function validateRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`Unsafe run id '${runId}'.`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0) {
      return !isProcessAlive(payload.pid);
    }
  } catch {
    // A malformed lock is reclaimed only after a conservative age threshold.
  }

  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > STALE_LOCK_AGE_MS;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}
