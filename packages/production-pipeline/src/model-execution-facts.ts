import { createHash } from "node:crypto";
import { roleAgentCheckpointRequestPhases } from "./role-agent-checkpoint.js";

type RecordValue = Record<string, unknown>;
export type ModelRequestState = "prepared" | "not_accepted" | "accepted_unknown" | "completed" | "completed_failure" | "unknown";

/** 只读证据投影，不是现金账本；不包含prompt、附件、socket或凭据。 */
export interface ModelExecutionFact {
  executionKey: string;
  requestId: string;
  nodeId: string;
  operationId?: string;
  cycle?: number;
  purpose: string;
  providerId: string;
  modelId: string;
  state: ModelRequestState;
  accepted: boolean | null;
  modelAttemptCount: number | null;
  evidenceSources: string[];
  checkpointKeys: string[];
  startedAt?: string;
  finishedAt?: string;
  providerMs: number | null;
  queueMs: number | null;
  conflict?: true;
}

export interface ModelExecutionProjection {
  facts: ModelExecutionFact[];
  issues: string[];
  currentOperationIds: Record<string, string>;
}

export function projectRequestExecution(input: {
  nodeId: string; requestId: string; purpose: string; state: ModelRequestState;
  evidenceSource: string; operationId?: string; cycle?: number; checkpointKey?: string;
  trace?: unknown; binding?: unknown; startedAt?: string; finishedAt?: string;
}): ModelExecutionFact {
  const trace = record(input.trace), binding = record(input.binding);
  const providerId = string(trace.providerId) || string(binding.providerId) || "unknown";
  const modelId = string(trace.modelId) || string(binding.modelId) || "unknown";
  const hashMismatch = typeof trace.requestIdHash === "string" && trace.requestIdHash !== hash(input.requestId);
  const accepted = input.state === "completed" || input.state === "completed_failure" || input.state === "accepted_unknown"
    ? true : input.state === "not_accepted" ? false : null;
  return {
    executionKey: JSON.stringify([providerId === "unknown" ? `unattributed:${input.nodeId}:${input.checkpointKey ?? input.evidenceSource}` : providerId, input.requestId]),
    requestId: input.requestId, nodeId: input.nodeId, purpose: input.purpose, providerId, modelId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
    state: hashMismatch ? "unknown" : input.state, accepted: hashMismatch ? null : accepted,
    modelAttemptCount: hashMismatch ? null : accepted === false ? 0 : count(trace.modelAttemptCount),
    providerMs: count(trace.providerWaitMs), queueMs: count(trace.queueWaitMs),
    evidenceSources: [input.evidenceSource], checkpointKeys: input.checkpointKey ? [input.checkpointKey] : [],
    ...(validTime(input.startedAt) ? { startedAt: input.startedAt } : {}),
    ...(validTime(input.finishedAt) ? { finishedAt: input.finishedAt } : {}),
    ...(hashMismatch ? { conflict: true } : {}),
  };
}

export function projectCheckpointExecutions(nodeId: string, checkpoint: RecordValue, source: string): ModelExecutionFact[] {
  const attempted = new Set(strings(checkpoint.attemptedRequestIds));
  const pending = record(record(checkpoint.pendingOperation).operation);
  if (string(pending.requestId)) attempted.add(string(pending.requestId));
  const owners = record(checkpoint.requestOwners);
  // 被明确拒收的请求可能已从attempted列表移除，owner仍是其真实提交证据。
  Object.keys(owners).forEach((id) => attempted.add(id));
  const phases = roleAgentCheckpointRequestPhases(checkpoint, attempted);
  const completed = Array.isArray(checkpoint.completed) ? checkpoint.completed.map(record) : [];
  if (checkpoint.pendingCandidate) completed.push(record(checkpoint.pendingCandidate));
  const failure = record(checkpoint.failure), details = record(failure.details);
  const facts = [...attempted].map((requestId) => {
    const phase = phases.find((item) => item.requestId === requestId);
    const candidates = phase ? completed.filter((item) => item.iteration === phase.iteration)
      .map((item) => record(phase.phase === "produce" ? item.candidateTrace : item.auditTrace))
      .filter((item) => Object.keys(item).length) : [];
    const peers = phases.filter((item) => item.phase === phase?.phase && item.iteration === phase?.iteration);
    // 多次尝试同一阶段时，只有hash能指认是哪次返回；绝不能把最后一份trace复制给所有请求。
    const trace = candidates.find((item) => item.requestIdHash === hash(requestId))
      ?? (peers.length === 1 ? candidates.find((item) => item.requestIdHash === undefined) : undefined);
    const isPending = pending.requestId === requestId;
    const failed = details.requestIdHash === hash(requestId)
      || isPending && typeof details.requestIdHash !== "string";
    let state: ModelRequestState = trace ? "completed" : "unknown";
    if (!trace && failed && failure.stage === "not_accepted" && details.accepted !== true) state = "not_accepted";
    else if (!trace && failed && failure.stage === "completed_failure") state = "completed_failure";
    else if (!trace && isPending) {
      if (failure.stage === "uncertain" || ["accepted", "running", "accepted_unknown"].includes(string(pending.taskFact))) state = "accepted_unknown";
      else if (pending.taskFact === "not_submitted") state = "prepared";
    }
    return projectRequestExecution({ nodeId, requestId, purpose: phase?.phase ?? "unknown", state,
      evidenceSource: source, checkpointKey: string(checkpoint.storageKey) || string(checkpoint.key),
      ...(string(owners[requestId]) ? { operationId: string(owners[requestId]) } : {}),
      ...(count(checkpoint.cycle) !== null ? { cycle: count(checkpoint.cycle)! } : {}),
      trace: trace ?? (failed ? details : undefined), binding: isPending ? pending.brokerBinding : undefined,
    });
  });
  const batch = record(checkpoint.assetRankBatch);
  if (batch.version === "asset-rank-batches-v1" && batch.phase === "supplement" && batch.primaryCheckpoint) {
    facts.push(...projectCheckpointExecutions(nodeId, record(batch.primaryCheckpoint), `${source}#primary`));
  }
  return facts;
}

export function mergeModelExecutionFacts(facts: readonly ModelExecutionFact[]): ModelExecutionFact[] {
  const merged = new Map<string, ModelExecutionFact>();
  for (const fact of facts) {
    const previous = merged.get(fact.executionKey);
    if (!previous) { merged.set(fact.executionKey, structuredClone(fact)); continue; }
    const conflict = previous.conflict || fact.conflict || previous.nodeId !== fact.nodeId
      || previous.modelId !== "unknown" && fact.modelId !== "unknown" && previous.modelId !== fact.modelId
      || previous.accepted !== null && fact.accepted !== null && previous.accepted !== fact.accepted
      || isTerminal(previous.state) && isTerminal(fact.state) && previous.state !== fact.state;
    const priority = (value: ModelExecutionFact) => isTerminal(value.state) ? 3 : value.state === "accepted_unknown" ? 2 : 1;
    const preferred = priority(fact) > priority(previous) ? fact : previous;
    merged.set(fact.executionKey, {
      ...preferred,
      accepted: preferred.accepted ?? previous.accepted ?? fact.accepted,
      modelAttemptCount: maxKnown(previous.modelAttemptCount, fact.modelAttemptCount),
      providerMs: maxKnown(previous.providerMs, fact.providerMs), queueMs: maxKnown(previous.queueMs, fact.queueMs),
      evidenceSources: [...new Set([...previous.evidenceSources, ...fact.evidenceSources])],
      checkpointKeys: [...new Set([...previous.checkpointKeys, ...fact.checkpointKeys])],
      ...(conflict ? { conflict: true } : {}),
    });
  }
  return [...merged.values()];
}

export function summarizeModelExecutionFacts(
  input: readonly ModelExecutionFact[], issues: readonly string[] = [], currentOperationIds: Record<string, string> = {},
) {
  const facts = mergeModelExecutionFacts(input);
  const verified = facts.filter((fact) => fact.accepted === true && fact.providerId !== "unknown" && !fact.conflict);
  const countExact = issues.length === 0 && facts.every((fact) => !fact.conflict
    && (fact.accepted === false || fact.accepted === true && fact.providerId !== "unknown" && fact.modelAttemptCount !== null));
  // owner能证明属于旧操作，但同一operation可能跨多次恢复，不能推断本次新增。
  const allPrevious = facts.every((fact) => fact.operationId && currentOperationIds[fact.nodeId]
    && fact.operationId !== currentOperationIds[fact.nodeId]);
  const intervals = verified.flatMap((fact): Array<[number, number]> => fact.startedAt && fact.finishedAt
    && Date.parse(fact.finishedAt) >= Date.parse(fact.startedAt) ? [[Date.parse(fact.startedAt), Date.parse(fact.finishedAt)]] : []);
  return {
    verifiedBrokerRequests: verified.length,
    verifiedModelAttempts: verified.reduce((sum, fact) => sum + (fact.modelAttemptCount ?? 0), 0),
    newBrokerRequestsThisAttempt: allPrevious && countExact ? 0 : null,
    newModelAttemptsThisAttempt: allPrevious && countExact ? 0 : null,
    countExact, countConflicts: facts.filter((fact) => fact.conflict).length,
    cumulativeProviderMs: verified.every((fact) => fact.providerMs !== null)
      ? verified.reduce((sum, fact) => sum + fact.providerMs!, 0) : null,
    cumulativeQueueMs: verified.every((fact) => fact.queueMs !== null)
      ? verified.reduce((sum, fact) => sum + fact.queueMs!, 0) : null,
    cumulativeRequestMs: intervals.length === verified.length ? intervals.reduce((sum, [start, end]) => sum + end - start, 0) : null,
    requestWallUnionMs: intervals.length === verified.length ? unionDuration(intervals) : null,
  };
}

function unionDuration(intervals: Array<[number, number]>): number {
  let total = 0, end = -Infinity;
  for (const [start, nextEnd] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isTerminal = (value: ModelRequestState) => value === "completed" || value === "completed_failure";
const maxKnown = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const validTime = (value: string | undefined): value is string => !!value && Number.isFinite(Date.parse(value));
