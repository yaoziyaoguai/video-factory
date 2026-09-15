import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexPreparedOperation, CodexTaskKind } from "./codex-chat.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export function roleAgentCheckpointKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function pendingRoleAgentOperation(
  checkpoint: RoleAgentLoopCheckpoint | undefined,
  expectedKinds: readonly CodexTaskKind[],
): Promise<CodexPreparedOperation | undefined> {
  if (!checkpoint) return undefined;
  const saved = await checkpoint.load();
  if (!isRecord(saved) || !isRecord(saved.pendingOperation)) return undefined;
  const operation = saved.pendingOperation.operation;
  if (!isRecord(operation)
    || operation.version !== "video-factory/codex-prepared-operation-v1"
    || typeof operation.requestId !== "string"
    || typeof operation.kind !== "string"
    || !expectedKinds.includes(operation.kind as CodexTaskKind)
    || !isRecord(operation.envelope)
    || operation.envelope.requestId !== operation.requestId
    || operation.envelope.kind !== operation.kind) return undefined;
  return structuredClone(operation) as unknown as CodexPreparedOperation;
}

export function fileRoleAgentLoopCheckpoint(
  filePath: string,
  key: string,
  options: {
    restartExhausted?: boolean;
    resumeCompletedFailure?: boolean;
    resumeCompletedFailureRequestId?: string;
    recoverOwnedPending?: boolean;
    recoverPendingOwner?: {
      runId: string;
      nodeId: string;
      workflowOperationRequestId: string;
    };
    recoveryOwner?: {
      runId: string;
      nodeId: string;
      workflowOperationRequestId: string;
    };
  } = {},
): RoleAgentLoopCheckpoint {
  let activeFilePath = filePath;
  return {
    key,
    ...(options.recoveryOwner ? { executionOwnerId: options.recoveryOwner.workflowOperationRequestId } : {}),
    ...(options.restartExhausted !== undefined ? { restartExhausted: options.restartExhausted } : {}),
    ...(options.resumeCompletedFailure !== undefined ? { resumeCompletedFailure: options.resumeCompletedFailure } : {}),
    ...(options.resumeCompletedFailureRequestId !== undefined
      ? { resumeCompletedFailureRequestId: options.resumeCompletedFailureRequestId }
      : {}),
    async load(): Promise<unknown | undefined> {
      const pendingOwner = options.recoverPendingOwner
        ?? (options.recoverOwnedPending ? options.recoveryOwner : undefined);
      if (pendingOwner) {
        const pending = await ownedPendingCheckpoints(path.dirname(filePath), pendingOwner);
        if (pending.length > 1) {
          throw new Error("Multiple accepted model tasks are pending for the same workflow operation; automatic recovery stopped to avoid choosing the wrong physical request.");
        }
        if (pending[0]) {
          activeFilePath = pending[0].filePath;
          return pending[0].value;
        }
      }
      try {
        activeFilePath = filePath;
        return JSON.parse(await readFile(activeFilePath, "utf8")) as unknown;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async save(value: unknown): Promise<void> {
      const destination = isRecord(value) && value.key === key ? filePath : activeFilePath;
      await mkdir(path.dirname(destination), { recursive: true });
      const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const persistedValue = options.recoveryOwner && isRecord(value)
          ? { ...value, recoveryOwner: options.recoveryOwner }
          : value;
        await writeFile(temporaryPath, `${JSON.stringify(persistedValue, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporaryPath, destination);
        activeFilePath = destination;
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}

async function ownedPendingCheckpoints(
  directory: string,
  owner: { runId: string; nodeId: string; workflowOperationRequestId: string },
): Promise<Array<{ filePath: string; value: Record<string, unknown> }>> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const matches: Array<{ filePath: string; value: Record<string, unknown> }> = [];
  for (const name of names) {
    const candidatePath = path.join(directory, name);
    try {
      const value = JSON.parse(await readFile(candidatePath, "utf8")) as unknown;
      if (!isRecord(value)
        || (value.version !== "video-factory/agent-loop-checkpoint-v8"
          && value.version !== "video-factory/agent-loop-checkpoint-v9")) continue;
      const recoveryOwner = value.recoveryOwner;
      if (!isRecord(recoveryOwner)
        || recoveryOwner.runId !== owner.runId
        || recoveryOwner.nodeId !== owner.nodeId
        || recoveryOwner.workflowOperationRequestId !== owner.workflowOperationRequestId
        || !isRecord(value.pendingOperation)) continue;
      matches.push({ filePath: candidatePath, value });
    } catch {
      // 损坏文件既不能取得恢复所有权，也不能阻断其它可验证的唯一 pending。
    }
  }
  return matches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === code;
}
