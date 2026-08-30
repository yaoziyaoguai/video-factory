import { createHash, randomUUID } from "node:crypto";
import type {
  AgentLoopTrace,
  CodexTaskExecution,
  RoleAudit,
  RoleAuditIssue,
} from "./codex-chat.js";

export interface RoleAgentLoopOptions<TOutput> {
  role: string;
  criteria: string[];
  contractVersion: string;
  maxIterations: number;
  initialCandidate?: TOutput;
  produce(revision: { candidate: TOutput; audit: RoleAudit } | undefined, operation: { requestId: string }): Promise<CodexTaskExecution<unknown>>;
  audit(input: {
    role: string;
    iteration: number;
    criteria: string[];
    candidate: TOutput;
    previousAudit?: RoleAudit;
    requestId: string;
  }): Promise<CodexTaskExecution<unknown>>;
  validate(value: unknown): TOutput;
  checkpoint?: RoleAgentLoopCheckpoint;
}

export interface RoleAgentLoopCheckpoint {
  key: string;
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
}

export class RoleAgentLoopError extends Error {
  constructor(
    message: string,
    readonly agentLoop: AgentLoopTrace,
    readonly lastTrace?: CodexTaskExecution["trace"],
  ) {
    super(message);
    this.name = "RoleAgentLoopError";
  }
}

interface PersistedLoopIteration {
  iteration: number;
  candidate: unknown;
  candidateTrace?: CodexTaskExecution["trace"];
  audit: RoleAudit;
  auditTrace?: CodexTaskExecution["trace"];
}

interface PersistedLoopCandidate {
  iteration: number;
  candidate: unknown;
  candidateTrace?: CodexTaskExecution["trace"];
}

interface PersistedLoopState {
  version: "video-factory/agent-loop-checkpoint-v3";
  key: string;
  contractDigest: string;
  role: string;
  maxIterations: number;
  cycle: number;
  status: "running" | "passed" | "exhausted";
  completed: PersistedLoopIteration[];
  pendingCandidate?: PersistedLoopCandidate;
  operationGenerations: Record<string, number>;
  failedOperationRequestIds: Record<string, string>;
  attemptedRequestIds: string[];
}

export async function runRoleAgentLoop<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
): Promise<CodexTaskExecution<TOutput>> {
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > 3) {
    throw new Error("Agent loop maxIterations must be an integer between 1 and 3.");
  }
  if (options.criteria.length < 1 || options.criteria.some((criterion) => !criterion.trim())) {
    throw new Error("Agent loop criteria must contain non-empty rules.");
  }

  const state = await restoreCheckpoint(options);
  if (options.initialCandidate !== undefined
    && state.status === "running"
    && state.completed.length === 0
    && !state.pendingCandidate) {
    state.pendingCandidate = {
      iteration: 1,
      candidate: options.validate(options.initialCandidate),
    };
    await persistCheckpoint(options, state);
  }
  const iterations: AgentLoopTrace["iterations"] = state.completed.map((entry) => ({
    iteration: entry.iteration,
    candidate: structuredClone(entry.candidate),
    candidateHash: valueHash(entry.candidate),
    ...(entry.candidateTrace ? { candidateTrace: entry.candidateTrace } : {}),
    ...(entry.auditTrace ? { auditTrace: entry.auditTrace } : {}),
    audit: entry.audit,
  }));
  if (state.status === "passed") {
    return completedExecution(options, state, iterations);
  }

  const lastCompleted = state.completed.at(-1);
  let revision = lastCompleted
    ? { candidate: options.validate(lastCompleted.candidate), audit: lastCompleted.audit }
    : undefined;
  let previousCandidate = lastCompleted ? JSON.stringify(revision!.candidate) : "";
  const operationScope = options.checkpoint?.key ?? randomUUID();
  for (let iteration = state.completed.length + 1; iteration <= options.maxIterations; iteration += 1) {
    let candidateExecution: CodexTaskExecution<unknown>;
    let candidate: TOutput;
    if (state.pendingCandidate?.iteration === iteration) {
      candidate = options.validate(state.pendingCandidate.candidate);
      candidateExecution = {
        output: candidate,
        ...(state.pendingCandidate.candidateTrace ? { trace: state.pendingCandidate.candidateTrace } : {}),
      };
    } else {
      try {
        candidateExecution = await executeOperation(options, state, operationScope, iteration, "produce", (requestId) =>
          options.produce(revision, { requestId }));
        candidate = options.validate(candidateExecution.output);
      } catch (error) {
        throw await failedLoopError(error, options, state, iterations, state.completed.at(-1)?.candidateTrace);
      }
      state.pendingCandidate = {
        iteration,
        candidate,
        ...(candidateExecution.trace ? { candidateTrace: candidateExecution.trace } : {}),
      };
      await persistCheckpoint(options, state);
    }
    const candidateFingerprint = JSON.stringify(candidate);
    if (iteration > 1 && candidateFingerprint === previousCandidate) {
      state.status = "exhausted";
      throw await failedLoopError(
        new Error(`${options.role} Agent repeated an unchanged candidate after repair feedback.`),
        options,
        state,
        iterations,
        candidateExecution.trace,
      );
    }
    previousCandidate = candidateFingerprint;

    let auditExecution: CodexTaskExecution<unknown>;
    let audit: RoleAudit;
    try {
      auditExecution = await executeOperation(options, state, operationScope, iteration, "audit", (requestId) =>
        options.audit({
          role: options.role,
          iteration,
          criteria: options.criteria,
          candidate,
          ...(revision?.audit ? { previousAudit: revision.audit } : {}),
          requestId,
        }));
      audit = validateRoleAudit(auditExecution.output);
    } catch (error) {
      throw await failedLoopError(error, options, state, iterations, candidateExecution.trace);
    }
    state.completed.push({
      iteration,
      candidate,
      ...(candidateExecution.trace ? { candidateTrace: candidateExecution.trace } : {}),
      audit,
      ...(auditExecution.trace ? { auditTrace: auditExecution.trace } : {}),
    });
    delete state.pendingCandidate;
    iterations.push({
      iteration,
      candidate: structuredClone(candidate),
      candidateHash: valueHash(candidate),
      ...(candidateExecution.trace ? { candidateTrace: candidateExecution.trace } : {}),
      ...(auditExecution.trace ? { auditTrace: auditExecution.trace } : {}),
      audit,
    });
    if (audit.verdict === "pass") {
      state.status = "passed";
      await persistCheckpoint(options, state);
      return completedExecution(options, state, iterations);
    }
    await persistCheckpoint(options, state);
    revision = { candidate, audit };
  }

  const finalAudit = iterations.at(-1)?.audit;
  state.status = "exhausted";
  throw await failedLoopError(
    new Error(`${options.role} Agent did not pass its independent audit after ${options.maxIterations} iterations.${finalAudit ? ` ${finalAudit.summary}` : ""}`),
    options,
    state,
    iterations,
    state.completed.at(-1)?.candidateTrace,
  );
}

async function failedLoopError<TOutput>(
  error: unknown,
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  iterations: AgentLoopTrace["iterations"],
  lastTrace?: CodexTaskExecution["trace"],
): Promise<RoleAgentLoopError> {
  const message = error instanceof Error ? error.message : String(error);
  await persistCheckpoint(options, state);
  return new RoleAgentLoopError(
    message,
    {
      version: "video-factory/agent-loop-v1",
      role: options.role,
      contractVersion: options.contractVersion,
      criteria: [...options.criteria],
      status: "failed",
      maxIterations: options.maxIterations,
      modelCallCount: state.attemptedRequestIds.length,
      iterations,
      ...(state.pendingCandidate ? {
        pendingCandidate: {
          iteration: state.pendingCandidate.iteration,
          candidate: structuredClone(state.pendingCandidate.candidate),
          candidateHash: valueHash(state.pendingCandidate.candidate),
          ...(state.pendingCandidate.candidateTrace ? { candidateTrace: state.pendingCandidate.candidateTrace } : {}),
        },
      } : {}),
    },
    lastTrace,
  );
}

async function restoreCheckpoint<TOutput>(options: RoleAgentLoopOptions<TOutput>): Promise<PersistedLoopState> {
  const fresh = (cycle = 0): PersistedLoopState => ({
    version: "video-factory/agent-loop-checkpoint-v3",
    key: options.checkpoint?.key ?? "ephemeral",
    contractDigest: roleContractDigest(options),
    role: options.role,
    maxIterations: options.maxIterations,
    cycle,
    status: "running",
    completed: [],
    operationGenerations: {},
    failedOperationRequestIds: {},
    attemptedRequestIds: [],
  });
  if (!options.checkpoint) return fresh();
  const loaded = await options.checkpoint.load();
  if (loaded === undefined) return fresh();
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) return fresh();
  const candidate = loaded as Partial<PersistedLoopState>;
  if (candidate.version !== "video-factory/agent-loop-checkpoint-v3"
    || candidate.key !== options.checkpoint.key
    || candidate.contractDigest !== roleContractDigest(options)
    || candidate.role !== options.role
    || candidate.maxIterations !== options.maxIterations
    || (candidate.status !== "running" && candidate.status !== "passed" && candidate.status !== "exhausted")
    || !Number.isInteger(candidate.cycle) || Number(candidate.cycle) < 0
    || !Array.isArray(candidate.completed)
    || !isRequestState(candidate.operationGenerations, "number")
    || !isRequestState(candidate.failedOperationRequestIds, "string")
    || !Array.isArray(candidate.attemptedRequestIds)
    || candidate.attemptedRequestIds.some((requestId) => typeof requestId !== "string")) {
    return fresh();
  }
  const completed = candidate.completed.map((entry, index): PersistedLoopIteration => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Agent loop checkpoint iteration is invalid.");
    const value = entry as Partial<PersistedLoopIteration>;
    if (value.iteration !== index + 1) throw new Error("Agent loop checkpoint iterations are not contiguous.");
    const output = options.validate(value.candidate);
    return {
      iteration: value.iteration,
      candidate: output,
      ...(value.candidateTrace ? { candidateTrace: value.candidateTrace } : {}),
      audit: validateRoleAudit(value.audit),
      ...(value.auditTrace ? { auditTrace: value.auditTrace } : {}),
    };
  });
  let pendingCandidate: PersistedLoopCandidate | undefined;
  if (candidate.pendingCandidate !== undefined) {
    const pending = candidate.pendingCandidate;
    if (typeof pending !== "object" || pending === null || Array.isArray(pending)) {
      throw new Error("Agent loop checkpoint pending candidate is invalid.");
    }
    const value = pending as Partial<PersistedLoopCandidate>;
    if (value.iteration !== completed.length + 1) throw new Error("Agent loop checkpoint pending iteration is invalid.");
    pendingCandidate = {
      iteration: value.iteration,
      candidate: options.validate(value.candidate),
      ...(value.candidateTrace ? { candidateTrace: value.candidateTrace } : {}),
    };
  }
  if (candidate.status === "passed" && (pendingCandidate || completed.at(-1)?.audit.verdict !== "pass")) {
    throw new Error("Passed agent loop checkpoint has no passing final audit.");
  }
  return {
    version: candidate.version,
    key: candidate.key,
    contractDigest: candidate.contractDigest,
    role: candidate.role,
    maxIterations: candidate.maxIterations,
    cycle: Number(candidate.cycle),
    status: candidate.status,
    completed,
    operationGenerations: { ...candidate.operationGenerations } as Record<string, number>,
    failedOperationRequestIds: { ...candidate.failedOperationRequestIds } as Record<string, string>,
    attemptedRequestIds: [...candidate.attemptedRequestIds],
    ...(pendingCandidate ? { pendingCandidate } : {}),
  };
}

async function persistCheckpoint<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
): Promise<void> {
  if (options.checkpoint) await options.checkpoint.save(state);
}

function completedExecution<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  iterations: AgentLoopTrace["iterations"],
): CodexTaskExecution<TOutput> {
  const final = state.completed.at(-1);
  if (!final || final.audit.verdict !== "pass") throw new Error("Agent loop checkpoint has no passing result.");
  const finalTrace = final.candidateTrace ?? final.auditTrace;
  return {
    output: options.validate(final.candidate),
    ...(finalTrace ? { trace: finalTrace } : {}),
    agentLoop: {
      version: "video-factory/agent-loop-v1",
      role: options.role,
      contractVersion: options.contractVersion,
      criteria: [...options.criteria],
      status: "passed",
      maxIterations: options.maxIterations,
      modelCallCount: state.attemptedRequestIds.length,
      iterations,
    },
  };
}

function roleContractDigest<TOutput>(options: RoleAgentLoopOptions<TOutput>): string {
  return valueHash({
    contractVersion: options.contractVersion,
    role: options.role,
    criteria: options.criteria,
    maxIterations: options.maxIterations,
  });
}

async function executeOperation<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  scope: string,
  iteration: number,
  phase: "produce" | "audit",
  execute: (requestId: string) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  const operationKey = `${state.cycle}:${iteration}:${phase}`;
  const generation = state.operationGenerations[operationKey] ?? 0;
  const requestId = operationRequestId(scope, state.contractDigest, state.cycle, iteration, phase, generation);
  try {
    const result = await executeTrackedOperation(options, state, requestId, execute);
    delete state.failedOperationRequestIds[operationKey];
    return result;
  } catch (error) {
    state.failedOperationRequestIds[operationKey] = requestId;
    await persistCheckpoint(options, state);
    throw error;
  }
}

async function executeTrackedOperation<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  requestId: string,
  execute: (requestId: string) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  if (!state.attemptedRequestIds.includes(requestId)) {
    state.attemptedRequestIds.push(requestId);
    await persistCheckpoint(options, state);
  }
  return execute(requestId);
}

function operationRequestId(
  scope: string,
  contractDigest: string,
  cycle: number,
  iteration: number,
  phase: "produce" | "audit",
  generation: number,
): string {
  return `agent-${valueHash({ scope, contractDigest, cycle, iteration, phase, generation })}`;
}

function valueHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRequestState(value: unknown, type: "number" | "string"): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === type && (type !== "number" || (Number.isInteger(entry) && Number(entry) >= 0)));
}

export function validateRoleAudit(value: unknown): RoleAudit {
  const audit = record(value, "Role audit");
  if (audit.version !== "video-factory/role-audit-v1") throw new Error("Role audit version is invalid.");
  if (audit.verdict !== "pass" && audit.verdict !== "repair") throw new Error("Role audit verdict is invalid.");
  if (!Number.isInteger(audit.score) || Number(audit.score) < 0 || Number(audit.score) > 100) {
    throw new Error("Role audit score must be an integer between 0 and 100.");
  }
  const issues = array(audit.issues, "Role audit issues", 12).map((entry, index): RoleAuditIssue => {
    const issue = record(entry, `Role audit issues[${index}]`);
    if (issue.severity !== "advisory" && issue.severity !== "blocking") {
      throw new Error(`Role audit issues[${index}].severity is invalid.`);
    }
    return {
      severity: issue.severity,
      criterion: text(issue.criterion, `Role audit issues[${index}].criterion`),
      evidence: text(issue.evidence, `Role audit issues[${index}].evidence`),
      repairInstruction: text(issue.repairInstruction, `Role audit issues[${index}].repairInstruction`),
    };
  });
  const repairInstructions = array(audit.repairInstructions, "Role audit repairInstructions", 12)
    .map((entry, index) => text(entry, `Role audit repairInstructions[${index}]`));
  if (audit.verdict === "pass" && (Number(audit.score) < 80 || issues.some((issue) => issue.severity === "blocking") || repairInstructions.length > 0)) {
    throw new Error("Passing role audits require score >= 80 and cannot retain blocking issues or repair instructions.");
  }
  if (audit.verdict === "repair" && repairInstructions.length < 1) {
    throw new Error("Repair role audits must include repair instructions.");
  }
  return {
    version: audit.version,
    verdict: audit.verdict,
    score: Number(audit.score),
    summary: text(audit.summary, "Role audit summary"),
    issues,
    repairInstructions,
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} must be an array with at most ${maximum} entries.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}
