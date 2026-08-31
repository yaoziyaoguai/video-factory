import { createHash, randomUUID } from "node:crypto";
import type {
  AgentLoopTrace,
  CodexTaskSession,
  CodexTaskExecution,
  RoleAudit,
  RoleAuditIssue,
} from "./codex-chat.js";
import { CodexBridgeError } from "./codex-chat.js";

const MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN = 2;

export interface RoleAgentLoopOptions<TOutput> {
  role: string;
  criteria: string[];
  contractVersion: string;
  maxIterations: number;
  maxPhaseAttempts?: Partial<Record<"produce" | "audit", number>>;
  initialCandidate?: TOutput;
  produce(revision: RoleAgentRevision<TOutput> | undefined, operation: { requestId: string; session: CodexTaskSession }): Promise<CodexTaskExecution<unknown>>;
  audit(input: {
    role: string;
    iteration: number;
    criteria: string[];
    candidate: TOutput;
    previousAudit?: RoleAudit;
    requestId: string;
    session: CodexTaskSession;
  }): Promise<CodexTaskExecution<unknown>>;
  validate(value: unknown): TOutput;
  checkpoint?: RoleAgentLoopCheckpoint;
}

export type RoleAgentRevision<TOutput> =
  | {
    mode: "repair-delta";
    candidateHash: string;
    audit: RoleRepairFeedback;
  }
  | {
    mode: "repair-bootstrap";
    candidate: TOutput;
    candidateHash: string;
    audit: RoleRepairFeedback;
  }
  | {
    mode: "validation-repair";
    invalidCandidateHash: string;
    validationError: string;
  };

interface RoleRepairFeedback {
  summary: string;
  issues: RoleAuditIssue[];
  repairInstructions: string[];
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

interface PersistedValidationFailure {
  iteration: number;
  invalidCandidateHash: string;
  validationError: string;
}

interface PersistedLoopState {
  version: "video-factory/agent-loop-checkpoint-v6";
  key: string;
  contractDigest: string;
  role: string;
  maxIterations: number;
  cycle: number;
  status: "running" | "passed" | "exhausted";
  completed: PersistedLoopIteration[];
  pendingCandidate?: PersistedLoopCandidate;
  validationFailure?: PersistedValidationFailure;
  operationGenerations: Record<string, number>;
  failedOperationRequestIds: Record<string, string>;
  attemptedRequestIds: string[];
  sessions: Partial<Record<"produce" | "audit", CodexTaskSession>>;
  phaseAttempts: Record<"produce" | "audit", number>;
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
  for (const [phase, limit] of Object.entries(options.maxPhaseAttempts ?? {})) {
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 6) {
      throw new Error(`Agent loop ${phase} attempt limit must be an integer between 1 and 6.`);
    }
  }

  const state = await restoreCheckpoint(options);
  if (state.status === "exhausted"
    && state.completed.length < options.maxIterations
    && (state.pendingCandidate !== undefined || state.validationFailure !== undefined)) {
    // v6 及更早版本可能把结构校验重试误记为语义轮次耗尽；保留会话与候选，原地恢复。
    state.status = "running";
    await persistCheckpoint(options, state);
  }
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
  let revision: { candidate: TOutput; audit: RoleAudit } | undefined = lastCompleted
    ? { candidate: options.validate(lastCompleted.candidate), audit: lastCompleted.audit }
    : undefined;
  let validationRevision = state.validationFailure;
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
      const operationKey = loopOperationKey(state, iteration, "produce");
      let structuredOutputAttempts = 0;
      while (true) {
        try {
          candidateExecution = await executeOperation(options, state, operationScope, iteration, "produce", (operation) =>
            options.produce(producerRevision(revision, validationRevision, operation.session), operation));
        } catch (error) {
          throw await failedLoopError(error, options, state, iterations, state.completed.at(-1)?.candidateTrace);
        }
        try {
          candidate = options.validate(candidateExecution.output);
          break;
        } catch (error) {
          structuredOutputAttempts += 1;
          acceptOperationSession(state, "produce", candidateExecution.session);
          retireAcceptedOperation(state, operationKey);
          validationRevision = {
            iteration,
            invalidCandidateHash: valueHash(candidateExecution.output),
            validationError: publicValidationError(error),
          };
          state.validationFailure = validationRevision;
          await persistCheckpoint(options, state);
          if (structuredOutputAttempts >= MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN) {
            throw await failedLoopError(
              new Error(
                `${options.role} Agent returned malformed output twice in semantic round ${iteration}; `
                + `the semantic audit round was not consumed and can resume from its checkpoint. ${validationRevision.validationError}`,
              ),
              options,
              state,
              iterations,
              candidateExecution.trace,
            );
          }
        }
      }
      acceptOperationSession(state, "produce", candidateExecution.session);
      delete state.validationFailure;
      validationRevision = undefined;
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
    const auditOperationKey = loopOperationKey(state, iteration, "audit");
    let structuredAuditAttempts = 0;
    while (true) {
      try {
        auditExecution = await executeOperation(options, state, operationScope, iteration, "audit", (operation) =>
          options.audit({
            role: options.role,
            iteration,
            criteria: options.criteria,
            candidate,
            ...(revision?.audit ? { previousAudit: revision.audit } : {}),
            ...operation,
          }));
      } catch (error) {
        throw await failedLoopError(error, options, state, iterations, candidateExecution.trace);
      }
      try {
        audit = validateRoleAudit(auditExecution.output);
        break;
      } catch (error) {
        structuredAuditAttempts += 1;
        acceptOperationSession(state, "audit", auditExecution.session);
        retireAcceptedOperation(state, auditOperationKey);
        await persistCheckpoint(options, state);
        if (structuredAuditAttempts >= MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN) {
          throw await failedLoopError(
            new Error(
              `Independent ${options.role} audit returned malformed output twice in semantic round ${iteration}; `
              + `the semantic audit round was not consumed and can resume from its checkpoint. ${publicValidationError(error)}`,
            ),
            options,
            state,
            iterations,
            candidateExecution.trace,
          );
        }
      }
    }
    acceptOperationSession(state, "audit", auditExecution.session);
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
      producerModelCallCount: state.phaseAttempts.produce,
      auditModelCallCount: state.phaseAttempts.audit,
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
    version: "video-factory/agent-loop-checkpoint-v6",
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
    sessions: {},
    phaseAttempts: { produce: 0, audit: 0 },
  });
  if (!options.checkpoint) return fresh();
  const loaded = await options.checkpoint.load();
  if (loaded === undefined) return fresh();
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) return fresh();
  const candidate = loaded as Partial<PersistedLoopState>;
  const loadedVersion = (loaded as { version?: unknown }).version;
  const legacyV3 = loadedVersion === "video-factory/agent-loop-checkpoint-v3";
  const legacyV4 = loadedVersion === "video-factory/agent-loop-checkpoint-v4";
  const legacyV5 = loadedVersion === "video-factory/agent-loop-checkpoint-v5";
  if (!legacyV3 && !legacyV4 && !legacyV5 && loadedVersion !== "video-factory/agent-loop-checkpoint-v6"
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
    || candidate.attemptedRequestIds.some((requestId) => typeof requestId !== "string")
    || (!legacyV3 && !isSessionState(candidate.sessions))
    || (!legacyV3 && !legacyV4 && !legacyV5 && !isPhaseAttempts(candidate.phaseAttempts))) {
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
  let validationFailure: PersistedValidationFailure | undefined;
  if (candidate.validationFailure !== undefined) {
    const failure = candidate.validationFailure as Partial<PersistedValidationFailure>;
    if (failure.iteration !== completed.length + 1
      || typeof failure.invalidCandidateHash !== "string"
      || typeof failure.validationError !== "string") {
      throw new Error("Agent loop checkpoint validation failure is invalid.");
    }
    validationFailure = failure as PersistedValidationFailure;
  }
  if (pendingCandidate && validationFailure) throw new Error("Agent loop checkpoint cannot contain a candidate and validation failure together.");
  if (candidate.status === "passed" && (pendingCandidate || completed.at(-1)?.audit.verdict !== "pass")) {
    throw new Error("Passed agent loop checkpoint has no passing final audit.");
  }
  return {
    version: "video-factory/agent-loop-checkpoint-v6",
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
    sessions: legacyV3 ? {} : structuredClone(candidate.sessions!),
    phaseAttempts: legacyV3 || legacyV4 || legacyV5
      ? inferredPhaseAttempts(completed, pendingCandidate)
      : structuredClone(candidate.phaseAttempts!),
    ...(pendingCandidate ? { pendingCandidate } : {}),
    ...(validationFailure ? { validationFailure } : {}),
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
      producerModelCallCount: state.phaseAttempts.produce,
      auditModelCallCount: state.phaseAttempts.audit,
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
    maxPhaseAttempts: options.maxPhaseAttempts,
  });
}

async function executeOperation<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  scope: string,
  iteration: number,
  phase: "produce" | "audit",
  execute: (operation: { requestId: string; session: CodexTaskSession }) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  const operationKey = loopOperationKey(state, iteration, phase);
  while (true) {
    const generation = state.operationGenerations[operationKey] ?? 0;
    const requestId = operationRequestId(scope, state.contractDigest, state.cycle, iteration, phase, generation);
    const session: CodexTaskSession = state.sessions[phase] ?? {
      key: `agent-${valueHash({ scope, contractDigest: state.contractDigest, cycle: state.cycle, phase })}`,
    };
    const attemptLimit = options.maxPhaseAttempts?.[phase];
    if (!state.attemptedRequestIds.includes(requestId)
      && attemptLimit !== undefined
      && state.phaseAttempts[phase] >= attemptLimit) {
      throw new Error(`${options.role} Agent exceeded the ${phase} model-call limit of ${attemptLimit}.`);
    }
    try {
      const result = await executeTrackedOperation(options, state, requestId, session, phase, execute);
      if (result.session) {
        if (result.session.key !== session.key) throw new Error("Agent loop received a mismatched task session key.");
        if (session.handle && result.session.handle !== session.handle) {
          throw new Error("Agent loop received a different task session handle while resuming.");
        }
      }
      delete state.failedOperationRequestIds[operationKey];
      return result;
    } catch (error) {
      if (error instanceof CodexBridgeError
        && error.stage === "not_accepted"
        && error.statusCode === 409) {
        delete state.sessions[phase];
        untrackUnacceptedOperation(state, requestId, phase);
        retireAcceptedOperation(state, operationKey);
        await persistCheckpoint(options, state);
        continue;
      }
      if (error instanceof CodexBridgeError && error.stage === "completed_failure") {
        retireAcceptedOperation(state, operationKey);
        // Broker 已明确完成且失败，不能复用 requestId；但这不是候选或审计的语义失败。
        // 立即把控制权交还给工作流，保留候选供下一次人工重试继续，避免静默再跑三次长任务。
        await persistCheckpoint(options, state);
        const phaseLabel = phase === "audit" ? "独立审计" : "内容生成";
        throw new Error(
          `${options.role} Agent 的${phaseLabel}基础设施失败，尚未消耗语义审计轮次；候选和会话检查点已保留，可直接重试。${publicValidationError(error)}`,
        );
      }
      state.failedOperationRequestIds[operationKey] = requestId;
      await persistCheckpoint(options, state);
      throw error;
    }
  }
}

function acceptOperationSession(
  state: PersistedLoopState,
  phase: "produce" | "audit",
  session: CodexTaskSession | undefined,
): void {
  if (session) state.sessions[phase] = session;
}

function retireAcceptedOperation(state: PersistedLoopState, operationKey: string): void {
  state.operationGenerations[operationKey] = (state.operationGenerations[operationKey] ?? 0) + 1;
  delete state.failedOperationRequestIds[operationKey];
}

function untrackUnacceptedOperation(
  state: PersistedLoopState,
  requestId: string,
  phase: "produce" | "audit",
): void {
  state.attemptedRequestIds = state.attemptedRequestIds.filter((candidate) => candidate !== requestId);
  state.phaseAttempts[phase] = Math.max(0, state.phaseAttempts[phase] - 1);
}

function loopOperationKey(
  state: PersistedLoopState,
  iteration: number,
  phase: "produce" | "audit",
): string {
  return `${state.cycle}:${iteration}:${phase}`;
}

async function executeTrackedOperation<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  requestId: string,
  session: CodexTaskSession,
  phase: "produce" | "audit",
  execute: (operation: { requestId: string; session: CodexTaskSession }) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  if (!state.attemptedRequestIds.includes(requestId)) {
    state.attemptedRequestIds.push(requestId);
    state.phaseAttempts[phase] += 1;
    await persistCheckpoint(options, state);
  }
  return execute({ requestId, session });
}

function producerRevision<TOutput>(
  revision: { candidate: TOutput; audit: RoleAudit } | undefined,
  validationFailure: PersistedValidationFailure | undefined,
  session: CodexTaskSession,
): RoleAgentRevision<TOutput> | undefined {
  if (validationFailure) {
    return {
      mode: "validation-repair",
      invalidCandidateHash: validationFailure.invalidCandidateHash,
      validationError: validationFailure.validationError,
    };
  }
  if (!revision) return undefined;
  const audit: RoleRepairFeedback = {
    summary: revision.audit.summary,
    issues: structuredClone(revision.audit.issues),
    repairInstructions: [...revision.audit.repairInstructions],
  };
  const candidateHash = valueHash(revision.candidate);
  return session.handle
    ? { mode: "repair-delta", candidateHash, audit }
    : { mode: "repair-bootstrap", candidate: revision.candidate, candidateHash, audit };
}

function publicValidationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300) || "Output failed business validation.";
}

function inferredPhaseAttempts(
  completed: PersistedLoopIteration[],
  pendingCandidate: PersistedLoopCandidate | undefined,
): Record<"produce" | "audit", number> {
  return {
    produce: Math.min(3, completed.length + (pendingCandidate ? 1 : 0)),
    audit: Math.min(3, completed.length),
  };
}

function isPhaseAttempts(value: unknown): value is PersistedLoopState["phaseAttempts"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Number.isInteger(record.produce) && Number(record.produce) >= 0
    && Number.isInteger(record.audit) && Number(record.audit) >= 0;
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

function isSessionState(value: unknown): value is PersistedLoopState["sessions"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "produce" && key !== "audit")) return false;
  return Object.values(record).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const session = entry as Record<string, unknown>;
    return typeof session.key === "string"
      && (session.handle === undefined
        || (typeof session.handle === "string" && /^vfs_[A-Za-z0-9_-]{32}$/.test(session.handle)));
  });
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
