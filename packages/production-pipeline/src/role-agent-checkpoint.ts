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
  let pendingRecoveryOwner: unknown;
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
        const pending = await ownedPendingCheckpoints(path.dirname(filePath), pendingOwner, key, filePath, options.recoveryOwner);
        if (pending.length > 1) {
          throw new Error("Multiple accepted model tasks are pending for the same workflow operation; automatic recovery stopped to avoid choosing the wrong physical request.");
        }
        if (pending[0]) {
          activeFilePath = pending[0].filePath;
          pendingRecoveryOwner = pending[0].value.recoveryOwner;
          return pending[0].value;
        }
      }
      try {
        activeFilePath = filePath;
        const value: unknown = JSON.parse(await readFile(activeFilePath, "utf8"));
        pendingRecoveryOwner = isRecord(value) ? value.recoveryOwner : undefined;
        return value;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async save(value: unknown): Promise<void> {
      const pending = isRecord(value) && isRecord(value.pendingOperation);
      // 文件身份归 adapter 管，循环 key 可属于 primary/supplement，不能拿它选择存储路径。
      const destination = pending ? activeFilePath : filePath;
      await mkdir(path.dirname(destination), { recursive: true });
      const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const owner = pending ? pendingRecoveryOwner ?? options.recoveryOwner : options.recoveryOwner;
        const persistedValue = isRecord(value)
          ? { ...value, storageKey: key, ...(owner ? { recoveryOwner: owner } : {}) }
          : value;
        await writeFile(temporaryPath, `${JSON.stringify(persistedValue, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        // 先在原位置结清 pending，再迁移文件；任何一步中断都只有一份权威恢复状态。
        // 两次 rename 之间的已结清文件由 load 按当前 key 和 owner 找回。
        await rename(temporaryPath, activeFilePath);
        if (activeFilePath !== destination) await rename(activeFilePath, destination);
        activeFilePath = destination;
        pendingRecoveryOwner = owner;
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}

async function ownedPendingCheckpoints(
  directory: string,
  owner: { runId: string; nodeId: string; workflowOperationRequestId: string },
  key: string,
  destination: string,
  currentOwner = owner,
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
      if (!isRecord(recoveryOwner)) continue;
      const matchesOwner = (expected: typeof owner) => recoveryOwner.runId === expected.runId
        && recoveryOwner.nodeId === expected.nodeId
        && recoveryOwner.workflowOperationRequestId === expected.workflowOperationRequestId;
      const unfinishedMigration = candidatePath !== destination
        && (value.storageKey ?? value.key) === key && matchesOwner(currentOwner);
      if (!(isRecord(value.pendingOperation) && matchesOwner(owner)) && !unfinishedMigration) continue;
      matches.push({ filePath: candidatePath, value });
    } catch {
      // 损坏文件既不能取得恢复所有权，也不能阻断其它可验证的唯一 pending。
    }
  }
  return matches;
}

export function roleAgentCheckpointRequestPhases(
  checkpoint: Record<string, unknown>,
  attemptedRequestIds: ReadonlySet<string>,
): Array<{ requestId: string; phase: "produce" | "audit"; iteration: number }> {
  const persisted: Array<{ requestId: string; phase: "produce" | "audit"; iteration: number }> = [];
  if (isRecord(checkpoint.requestPhases)) for (const [requestId, fact] of Object.entries(checkpoint.requestPhases)) {
    if (attemptedRequestIds.has(requestId) && isRecord(fact)
      && (fact.phase === "produce" || fact.phase === "audit")
      && Number.isSafeInteger(fact.iteration) && Number(fact.iteration) > 0) {
      persisted.push({ requestId, phase: fact.phase, iteration: Number(fact.iteration) });
    }
  }
  if (typeof checkpoint.key !== "string"
    || typeof checkpoint.contractDigest !== "string"
    || !Number.isSafeInteger(checkpoint.cycle)
    || !isRecord(checkpoint.operationGenerations)) return persisted;
  const cycle = Number(checkpoint.cycle);
  const operationKeys = new Set(Object.entries(checkpoint.operationGenerations)
    .filter(([, generation]) => Number.isSafeInteger(generation) && Number(generation) >= 0)
    .map(([operationKey]) => operationKey));
  const configuredMaxIterations = Number.isSafeInteger(checkpoint.maxIterations)
    && Number(checkpoint.maxIterations) >= 1
    && Number(checkpoint.maxIterations) <= 3
    ? Number(checkpoint.maxIterations)
    : 0;
  const persistedMaxIteration = Math.max(0, ...[...operationKeys].map((operationKey) => {
    const match = /^(\d+):(\d+):(produce|audit)$/.exec(operationKey);
    return match ? Number(match[2]) : 0;
  }));
  // generation=0 是正常首次调用，不会写进 operationGenerations；必须主动枚举，
  // 再由 attemptedRequestIds 证明它是否真的提交过。
  const maxIterations = Math.max(configuredMaxIterations, persistedMaxIteration);
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    operationKeys.add(`${cycle}:${iteration}:produce`);
    operationKeys.add(`${cycle}:${iteration}:audit`);
  }
  const requests: Array<{ requestId: string; phase: "produce" | "audit"; iteration: number }> = [];
  for (const operationKey of operationKeys) {
    const match = /^(\d+):(\d+):(produce|audit)$/.exec(operationKey);
    if (!match || Number(match[1]) !== cycle) continue;
    const iteration = Number(match[2]);
    const phase = match[3] as "produce" | "audit";
    const persistedGeneration = checkpoint.operationGenerations[operationKey];
    const maxGeneration = Number.isSafeInteger(persistedGeneration) && Number(persistedGeneration) >= 0
      ? Number(persistedGeneration)
      : 0;
    for (let generation = 0; generation <= maxGeneration; generation += 1) {
      const requestId = `agent-${createHash("sha256").update(JSON.stringify({
        scope: checkpoint.key,
        contractDigest: checkpoint.contractDigest,
        cycle,
        iteration,
        phase,
        generation,
      })).digest("hex")}`;
      if (attemptedRequestIds.has(requestId)) requests.push({ requestId, phase, iteration });
    }
  }
  return [...new Map([...requests, ...persisted].map(fact => [fact.requestId, fact])).values()];
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
