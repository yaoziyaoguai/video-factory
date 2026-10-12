import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validatePreparedOperation, type CodexPreparedOperation } from "@video-factory/production-pipeline";
import type { PlanningOwner } from "./planning-operations.js";

interface SeriesRequestEvidence {
  owner: PlanningOwner;
  input: Record<string, unknown>;
}

/** 只读取宿主保存的原请求；候选正文、标题相似度和当前系列版本都不是归属证据。 */
export function legacySeriesPlanningOwner(checkpoint: Record<string, unknown>): PlanningOwner | undefined {
  try {
    if (typeof checkpoint.version !== "string" || !/^video-factory\/agent-loop-checkpoint-v[3-9]$/.test(checkpoint.version)) return undefined;
    const evidence: SeriesRequestEvidence[] = [];
    const requestIds = Array.isArray(checkpoint.attemptedRequestIds)
      ? checkpoint.attemptedRequestIds.filter((id): id is string => typeof id === "string") : [];
    const hashes = new Set(requestIds.map((id) => createHash("sha256").update(id).digest("hex")));
    const addOperation = (value: unknown) => {
      if (!isRecord(value) || !isRecord(value.route) || typeof value.route.socketPath !== "string") throw new Error("Missing original operation");
      const operation = value as unknown as CodexPreparedOperation;
      validatePreparedOperation(operation, value.route.socketPath);
      if (!requestIds.includes(operation.requestId)) throw new Error("Unlinked original operation");
      evidence.push(seriesRequestEvidence(operation.kind, operation.envelope.payload));
    };
    if (checkpoint.pendingOperation !== undefined) {
      if (!isRecord(checkpoint.pendingOperation)) return undefined;
      const pending = checkpoint.pendingOperation;
      if (!isRecord(pending.operation)
        || pending.operation.kind !== (pending.phase === "produce" ? "series-roadmap" : pending.phase === "audit" ? "role-audit" : undefined)) return undefined;
      addOperation(pending.operation);
    }
    // 查询终态后保留原信封，避免删除 pendingOperation 时再次丢失历史业务归属。
    if (checkpoint.planningOriginalOperation !== undefined) addOperation(checkpoint.planningOriginalOperation);
    const addTrace = (value: unknown) => {
      if (!isRecord(value) || value.prompt === undefined) return;
      if (typeof value.prompt !== "string" || typeof value.brokerRequestIdHash !== "string"
        || !hashes.has(value.brokerRequestIdHash)) throw new Error("Unlinked original trace");
      const blocks = [...value.prompt.matchAll(/^<<<TASK_DATA\r?\n([\s\S]*?)\r?\nTASK_DATA>>>$/gm)];
      if (blocks.length !== 1) throw new Error("Missing or ambiguous original input");
      evidence.push(seriesRequestEvidence(value.taskKind, JSON.parse(blocks[0]![1]!)));
    };
    const addIteration = (value: unknown) => {
      if (!isRecord(value)) return;
      addTrace(value.candidateTrace);
      addTrace(value.auditTrace);
    };
    addIteration(checkpoint.pendingCandidate);
    if (Array.isArray(checkpoint.completed)) checkpoint.completed.forEach(addIteration);
    if (isRecord(checkpoint.requestExecutions)) {
      for (const value of Object.values(checkpoint.requestExecutions)) if (isRecord(value)) addTrace(value.trace);
    }
    const first = evidence[0];
    if (!first || evidence.some((item) => !isDeepStrictEqual(item.input, first.input))) return undefined;
    return first.owner;
  } catch {
    return undefined;
  }
}

function seriesRequestEvidence(kind: unknown, payload: unknown): SeriesRequestEvidence {
  const request = kind === "role-audit" && isRecord(payload) && isRecord(payload.context)
    ? payload.context.upstreamFacts : kind === "series-roadmap" ? payload : undefined;
  if (!isRecord(request) || !isRecord(request.series) || !isRecord(request.planningWindow)) throw new Error("Missing series input");
  const { series, planningWindow } = request;
  if (typeof series.id !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(series.id)
    || typeof series.name !== "string" || !series.name.trim()
    || !Array.isArray(series.pillars) || series.pillars.some((pillar) => typeof pillar !== "string")
    || !Number.isSafeInteger(planningWindow.startEpisodeNumber) || Number(planningWindow.startEpisodeNumber) < 1
    || !Number.isSafeInteger(planningWindow.count) || Number(planningWindow.count) < 1) throw new Error("Invalid series input");
  const mode = planningWindow.mode;
  if (mode !== undefined && mode !== "greenlight" && mode !== "revise") throw new Error("Unknown planning mode");
  if ((mode === undefined) !== (request.targetEpisode === undefined)) throw new Error("Inconsistent planning scope");
  const action = mode === "greenlight" ? "audit" : mode === "revise" ? "revise" : "generate";
  return {
    owner: { kind: "series", id: series.id, title: series.name, action,
      pillars: series.pillars as string[], startEpisodeNumber: Number(planningWindow.startEpisodeNumber), count: Number(planningWindow.count),
      ...(action !== "generate" ? { episodeNumber: Number(planningWindow.startEpisodeNumber) } : {}),
    },
    input: { series, planningWindow, ...(request.targetEpisode !== undefined ? { targetEpisode: request.targetEpisode } : {}) },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
