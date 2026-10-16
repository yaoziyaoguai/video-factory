import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileRoleAgentLoopCheckpoint, isRoleAgentCheckpointStructureValid, mergeModelExecutionFacts, projectCheckpointExecutions, roleContractDigest, validatePreparedOperation, type CodexPreparedOperation, type RoleAgentLoopCheckpoint } from "@video-factory/production-pipeline";
import type { StudioPlanningOperation } from "../shared/api.js";
import { StudioConflictError } from "./studio-errors.js";
import { legacySeriesPlanningOwner } from "./legacy-series-planning.js";
import { parseTopicIdeasOutput, TOPIC_REVISION_LOOP_CONTRACT } from "./topic-editor-contract.js";

export interface PlanningOwner {
  kind: "series" | "topic";
  id: string;
  title: string;
  action: "generate" | "audit" | "revise";
  baseRevision?: number;
  episodeNumber?: number;
  pillars?: string[];
  startEpisodeNumber?: number;
  count?: number;
}

/** 业务归属和执行事实共存于原检查点；不另造run或现金账本。 */
export function planningCheckpoint(directory: string, key: string, owner: PlanningOwner): RoleAgentLoopCheckpoint {
  const checkpoint = fileRoleAgentLoopCheckpoint(path.join(directory, `${key}.json`), key);
  let originalOwner = owner;
  return { ...checkpoint,
    async load() {
      const saved = await checkpoint.load();
      if (saved !== undefined) {
        if (!isRecord(saved) || !isPlanningOwner(saved.planningOwner)
          || saved.planningOwner.kind !== owner.kind || saved.planningOwner.id !== owner.id || saved.planningOwner.action !== owner.action) {
          throw new StudioConflictError("历史模型操作缺少可核对的业务归属，已停止执行；请核对原请求，不会用当前版本认领或重新提交。");
        }
        originalOwner = saved.planningOwner;
      }
      return saved;
    },
    save: (value) => checkpoint.save({ ...(value as Record<string, unknown>), planningOwner: originalOwner }),
  };
}

export async function readPlanningCheckpoints(directory: string, onUnassigned?: (operation: StudioPlanningOperation) => void, recoverLegacySeries = path.basename(directory) === "series-showrunner") {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ key: string; owner: PlanningOwner; checkpoint: Record<string, unknown>; operation: StudioPlanningOperation }> = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const key = name.slice(0, -5);
    const text = await readFile(path.join(directory, name), "utf8");
    let checkpoint: unknown;
    try { checkpoint = JSON.parse(text); } catch { checkpoint = undefined; }
    const explicitOwner = isRecord(checkpoint) && isPlanningOwner(checkpoint.planningOwner) ? checkpoint.planningOwner : undefined;
    const owner = explicitOwner ?? (isRecord(checkpoint) && checkpoint.planningOwner === undefined && recoverLegacySeries
      ? legacySeriesPlanningOwner(checkpoint) : undefined);
    if (!isRecord(checkpoint) || !owner) {
      const issue = isRecord(checkpoint) ? "历史检查点缺少可核对的业务归属，或原请求证据不一致；不猜测对象或补造用量。" : "检查点无法解析，调用与费用证据不完整。";
      onUnassigned?.({ id: `${path.basename(directory)}:${key}`, owner: { kind: "unassigned", id: key, title: "制作前历史操作 · 归属待核" },
        action: "unknown", state: "unknown", evidenceIssue: issue,
        executionFacts: isRecord(checkpoint) ? mergeModelExecutionFacts(projectCheckpointExecutions(`${path.basename(directory)}.planning`, checkpoint, `planning:${key}`)) : [] });
      continue;
    }
    const facts = mergeModelExecutionFacts(projectCheckpointExecutions(`${owner.kind}.planning`, checkpoint, `planning:${key}`));
    records.push({ key, owner, checkpoint, operation: {
      id: key, owner: { kind: owner.kind, id: owner.id, title: owner.title }, action: owner.action,
      ...(owner.baseRevision !== undefined ? { baseRevision: owner.baseRevision } : {}),
      ...(owner.episodeNumber !== undefined ? { episodeNumber: owner.episodeNumber } : {}),
      ...(!explicitOwner ? { evidenceIssue: "已按原请求输入核对系列归属；未保存原始版本，候选仅供查看，不覆盖当前稿。" } : {}),
      executionFacts: facts, state: typeof checkpoint.status === "string" ? checkpoint.status : "unknown",
    } });
  }
  return records;
}

export async function readPlanningOperations(workspaceRoot: string): Promise<StudioPlanningOperation[]> {
  const unassigned: StudioPlanningOperation[] = [];
  const groups = await Promise.all(["series-showrunner", "topic-editor"].map((name) =>
    readPlanningCheckpoints(path.join(workspaceRoot, "checkpoints", name), (operation) => unassigned.push(operation))));
  return [...groups.flat().map((record) => record.operation), ...unassigned];
}

/** 维护只核本地停点和原身份完整性；费用证据缺口或缺历史版本不等于活动写者。 */
export async function readPlanningMaintenanceIntegrity(workspaceRoot: string): Promise<{
  complete: boolean;
  issues: Array<{ runId: string; problem: string }>;
}> {
  const issues: Array<{ runId: string; problem: string }> = [];
  for (const name of ["series-showrunner", "topic-editor"] as const) {
    const directory = path.join(workspaceRoot, "checkpoints", name);
    let records: Awaited<ReturnType<typeof readPlanningCheckpoints>>;
    try {
      records = await readPlanningCheckpoints(directory, (operation) => {
        issues.push({ runId: `planning:${operation.id}`, problem: "planning_owner_unverifiable" });
      });
    } catch {
      issues.push({ runId: `planning:${name}`, problem: "planning_state_unreadable" });
      continue;
    }
    for (const { key, owner, checkpoint } of records) {
      const runId = `planning:${name}:${key}`;
      const problem = planningMaintenanceProblem(checkpoint, key, owner, name === "series-showrunner" ? "series" : "topic");
      if (problem) issues.push({ runId, problem });
    }
  }
  return { complete: issues.length === 0, issues };
}

function planningMaintenanceProblem(checkpoint: Record<string, unknown>, key: string, owner: PlanningOwner, expectedKind: PlanningOwner["kind"]): string | undefined {
  if (owner.kind !== expectedKind || !owner.id.trim()
    || checkpoint.key !== key || typeof checkpoint.version !== "string"
    || !/^video-factory\/agent-loop-checkpoint-v[3-9]$/.test(checkpoint.version)
    || !Array.isArray(checkpoint.completed)
    || !Array.isArray(checkpoint.attemptedRequestIds)
    || checkpoint.attemptedRequestIds.some((id) => typeof id !== "string" || !id)
    || !["running", "passed", "awaiting_user", "exhausted", "failed"].includes(String(checkpoint.status))) {
    return "planning_checkpoint_invalid";
  }
  if (checkpoint.status === "running" && !isSettledTopicRevision(checkpoint)) return "planning_execution_not_settled";
  const requestIds = new Set(checkpoint.attemptedRequestIds as string[]);
  const boundRequests = new Set<string>();
  const addOperation = (value: unknown): boolean => {
    if (!isRecord(value) || !isRecord(value.route) || typeof value.route.socketPath !== "string" || !value.route.socketPath
      || typeof value.requestId !== "string" || !requestIds.has(value.requestId)) return false;
    try {
      validatePreparedOperation(value as unknown as CodexPreparedOperation, value.route.socketPath);
      boundRequests.add(value.requestId);
      return true;
    } catch { return false; }
  };
  if (checkpoint.pendingOperation !== undefined) {
    const pending = checkpoint.pendingOperation;
    if (!isRecord(pending) || !["produce", "audit"].includes(String(pending.phase))
      || !Number.isInteger(pending.iteration) || Number(pending.iteration) < 1
      || !Number.isInteger(pending.generation) || Number(pending.generation) < 0
      || typeof pending.operationKey !== "string" || !pending.operationKey
      || !addOperation(pending.operation)) return "planning_unknown_operation_unbound";
  }
  if (checkpoint.planningOriginalOperation !== undefined && !addOperation(checkpoint.planningOriginalOperation)) {
    return "planning_unknown_operation_unbound";
  }
  if (isRecord(checkpoint.failure) && checkpoint.failure.stage === "uncertain" && boundRequests.size === 0) {
    return "planning_unknown_operation_unbound";
  }
  if (checkpoint.requestExecutions !== undefined) {
    if (!isRecord(checkpoint.requestExecutions)) return "planning_checkpoint_invalid";
    for (const [requestId, execution] of Object.entries(checkpoint.requestExecutions)) {
      if (!requestIds.has(requestId) || !isRecord(execution)
        || !["completed", "completed_failure", "not_accepted", "unknown"].includes(String(execution.state))) {
        return "planning_checkpoint_invalid";
      }
      if (execution.state === "unknown" && !boundRequests.has(requestId)) return "planning_unknown_operation_unbound";
    }
  }
  return undefined;
}

/** 只产稿合同的 running 是循环内状态；不能据此放行普通产稿到审计之间的窗口。 */
export function isSettledTopicRevision(checkpoint: Record<string, unknown>): boolean {
  const owner = checkpoint.planningOwner;
  const pending = checkpoint.pendingCandidate;
  const ids = checkpoint.attemptedRequestIds;
  const phases = checkpoint.requestPhases;
  const executions = checkpoint.requestExecutions;
  if (checkpoint.version !== "video-factory/agent-loop-checkpoint-v9" || checkpoint.status !== "running"
    || !isRoleAgentCheckpointStructureValid(checkpoint, TOPIC_REVISION_LOOP_CONTRACT)
    || checkpoint.contractDigest !== roleContractDigest(TOPIC_REVISION_LOOP_CONTRACT)
    || !isPlanningOwner(owner) || owner.kind !== "topic" || owner.action !== "revise" || !owner.id.trim()
    || typeof checkpoint.key !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.key)
    || !Array.isArray(checkpoint.completed) || checkpoint.completed.length
    || [checkpoint.pendingOperation, checkpoint.planningOriginalOperation, checkpoint.failure,
      checkpoint.validationFailure, checkpoint.auditValidationFailure].some((value) => value !== undefined)
    || !isRecord(pending) || pending.iteration !== 1 || !isRecord(pending.candidateTrace)
    || !Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)
    || new Set(ids).size !== ids.length || !isRecord(phases) || !isRecord(executions)
    || Object.keys(phases).some((id) => !ids.includes(id))
    || Object.keys(executions).some((id) => !ids.includes(id))) return false;
  try {
    if (!parseTopicIdeasOutput(pending.candidate).ideas.length) return false;
  } catch { return false; }
  const trace = pending.candidateTrace;
  if (trace.taskKind !== "topic-ideas" || typeof trace.providerId !== "string" || !trace.providerId
    || typeof trace.modelId !== "string" || !trace.modelId) return false;
  let candidateBound = false;
  for (const id of ids as string[]) {
    const phase = phases[id], execution = executions[id];
    const digest = createHash("sha256").update(id).digest("hex");
    if (!isRecord(phase) || phase.phase !== "produce" || phase.iteration !== 1
      || !isRecord(execution) || !["completed", "completed_failure", "not_accepted"].includes(String(execution.state))
      || !isRecord(execution.trace)) return false;
    // prepare 前已确证未受理的连接失败没有 broker 回执；已有摘要仍必须匹配原请求。
    if (execution.trace.brokerRequestIdHash !== digest
      && !(execution.state === "not_accepted" && execution.trace.brokerRequestIdHash === undefined)) return false;
    if (trace.brokerRequestIdHash === digest) {
      if (execution.state !== "completed" || !isDeepStrictEqual(trace, execution.trace)) return false;
      candidateBound = true;
    }
  }
  const facts = projectCheckpointExecutions("topic.planning", checkpoint, "maintenance");
  return candidateBound && facts.length === ids.length
    && facts.every((fact) => !fact.conflict && ["completed", "completed_failure", "not_accepted"].includes(fact.state));
}

function isPlanningOwner(value: unknown): value is PlanningOwner {
  return isRecord(value) && ["series", "topic"].includes(String(value.kind))
    && typeof value.id === "string" && typeof value.title === "string"
    && ["generate", "audit", "revise"].includes(String(value.action));
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
