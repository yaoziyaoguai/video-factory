import { createHash, randomUUID } from "node:crypto";
import type {
  AgentLoopTrace,
  AgentLoopHostPlanningReadiness,
  CodexTaskSession,
  CodexTaskExecution,
  CodexPreparedOperation,
  CodexTaskRequestOptions,
  RoleAudit,
  RoleAuditAssessment,
  RoleAuditDimension,
  RoleAuditIssue,
  RoleAuditPlanningDisposition,
} from "./codex-chat.js";
import { CodexBridgeError } from "./codex-chat.js";

const MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN = 2;
export const ROLE_AUDIT_CRITERIA_MAX_ITEMS = 16;
// 评分标准文本在 broker 的 ROLE_AUDIT_DIRECTIVE 里，维度归属在宿主这里。两侧的版本串
// 必须一致：rubric 一改，旧版本给出的维度分就不再是本轮标准的结论，必须重评。
export const ROLE_QUALITY_RUBRIC_VERSION = "video-factory/role-quality-rubric-v1";

const CREATIVE_AUDIT_DIMENSIONS = ["attention", "progression", "payoff", "expression"] as const;
const PUBLISH_AUDIT_DIMENSIONS = ["attention", "payoff", "expression"] as const;
const REPORT_AUDIT_DIMENSIONS = ["evidence", "coverage", "consistency", "actionability"] as const;

interface RoleAuditAssessmentPlan {
  /** 逐项评估的集合字段；缺省表示评当前完整候选（根路径 ""）。 */
  collection?: "ideas" | "episodes";
  dimensions: readonly RoleAuditDimension[];
}

// 审计 C2：评估对象与维度集合由宿主按角色决定，模型不能挑容易通过的维度。
// 表里没有的角色一律拒绝——新工位必须自己声明评什么，不能默认放行一个标量分。
const ROLE_AUDIT_ASSESSMENT_PLANS: Record<string, RoleAuditAssessmentPlan> = {
  "编剧": { dimensions: CREATIVE_AUDIT_DIMENSIONS },
  "导演前期构思": { dimensions: CREATIVE_AUDIT_DIMENSIONS },
  "导演": { dimensions: CREATIVE_AUDIT_DIMENSIONS },
  "发行编辑": { dimensions: PUBLISH_AUDIT_DIMENSIONS },
  "视觉审片员": { dimensions: REPORT_AUDIT_DIMENSIONS },
  "候选画面复核": { dimensions: REPORT_AUDIT_DIMENSIONS },
  "参考片分析师": { dimensions: REPORT_AUDIT_DIMENSIONS },
  "选题总编": { collection: "ideas", dimensions: CREATIVE_AUDIT_DIMENSIONS },
  "系列总编": { collection: "episodes", dimensions: CREATIVE_AUDIT_DIMENSIONS },
  "系列开拍总编": { collection: "episodes", dimensions: CREATIVE_AUDIT_DIMENSIONS },
};

// C5：每个 phase 的已确证未受理（409）会话重建上界。第一次重建是受控恢复；连续被拒
// 说明模型服务异常，继续重建只会形成无界请求循环。计数持久化在 checkpoint 中，进程
// 恢复不重置。允许一次受控重建后，第二次到达上限即停止并保留原因。
const MAX_SESSION_REBUILDS = 2;

export interface RoleAgentLoopOptions<TOutput> {
  role: string;
  criteria: string[];
  contractVersion: string;
  maxIterations: number;
  /** 只有创作规划的 treatment/script/director 可把独立审计处置路由到规划控制流。 */
  planningRole?: boolean;
  /** 宿主只核对当前流水线能否取得核心制作前提；不替代独立模型审计。 */
  assessPlanningReadiness?: (candidate: TOutput) => HostPlanningReadiness;
  maxPhaseAttempts?: Partial<Record<"produce" | "audit", number>>;
  initialCandidate?: TOutput;
  /**
   * 只生成并持久化结构合法的候选，独立审计留到用户明确确认当前版本时执行。
   * 候选仍使用与完整 loop 相同的 prepared operation、checkpoint 与恢复身份。
   */
  deferAudit?: boolean;
  produce(revision: RoleAgentRevision<TOutput> | undefined, operation: RoleAgentOperation): Promise<CodexTaskExecution<unknown>>;
  audit(input: {
    role: string;
    iteration: number;
    criteria: string[];
    candidate: TOutput;
    previousAudit?: RoleAudit;
    validationFailure?: RoleAuditValidationFailure;
    hostReadiness?: HostPlanningReadiness;
    requestId: string;
    session: CodexTaskSession;
    requestOptions: CodexTaskRequestOptions;
    preparedOperation?: CodexPreparedOperation;
  }): Promise<CodexTaskExecution<unknown>>;
  validate(value: unknown, context: RoleAgentValidationContext): TOutput;
  checkpoint?: RoleAgentLoopCheckpoint;
  now?: () => number;
}

export type HostPlanningReadiness = AgentLoopHostPlanningReadiness;

export interface RoleAgentOperation {
  requestId: string;
  session: CodexTaskSession;
  requestOptions: CodexTaskRequestOptions;
  preparedOperation?: CodexPreparedOperation;
}

export interface RoleAgentValidationContext {
  iteration: number;
  repair: boolean;
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
    invalidCandidate: unknown;
    invalidCandidateHash: string;
    validationError: string;
  };

export interface RoleAuditValidationFailure {
  invalidCandidate: unknown;
  invalidCandidateHash: string;
  validationError: string;
}

interface RoleRepairFeedback {
  summary: string;
  issues: RoleAuditIssue[];
  repairInstructions: string[];
}

export interface RoleAgentLoopCheckpoint {
  key: string;
  /** 首次创建物理请求时的工作流操作归属；恢复查询不得改写。 */
  executionOwnerId?: string;
  restartExhausted?: boolean;
  /** @deprecated 仅供旧调用方兼容；正式恢复应传入被人工核验的原物理 requestId。 */
  resumeCompletedFailure?: boolean;
  /** 仅允许结清这个已被人工核验的 completed_failure；后续新失败不会继承许可。 */
  resumeCompletedFailureRequestId?: string;
  // 仅供兼容模型接管独立审计；候选与语义轮次可恢复，Provider 会话和请求标识不可跨模型复用。
  resumeFrom?: AgentLoopTrace;
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
}

export class RoleAgentLoopError extends Error {
  constructor(
    message: string,
    readonly agentLoop: AgentLoopTrace,
    readonly lastTrace?: CodexTaskExecution["trace"],
    readonly sourceError?: unknown,
  ) {
    super(message, sourceError instanceof Error ? { cause: sourceError } : undefined);
    this.name = "RoleAgentLoopError";
  }
}

export class RoleAgentPlanningHaltError extends RoleAgentLoopError {
  constructor(
    message: string,
    agentLoop: AgentLoopTrace,
    readonly disposition: RoleAuditPlanningDisposition | null,
    readonly candidate: unknown,
    readonly audit: RoleAudit,
    readonly hostReadiness?: HostPlanningReadiness,
    lastTrace?: CodexTaskExecution["trace"],
  ) {
    super(message, agentLoop, lastTrace);
    this.name = "RoleAgentPlanningHaltError";
  }
}

interface PersistedLoopIteration {
  iteration: number;
  candidate: unknown;
  candidateTrace?: CodexTaskExecution["trace"];
  audit: RoleAudit;
  hostReadiness?: HostPlanningReadiness;
  auditTrace?: CodexTaskExecution["trace"];
}

interface PersistedLoopCandidate {
  iteration: number;
  candidate: unknown;
  candidateTrace?: CodexTaskExecution["trace"];
}

interface PersistedValidationFailure {
  iteration: number;
  invalidCandidate?: unknown;
  invalidCandidateHash: string;
  validationError: string;
}

interface PersistedAuditValidationFailure extends RoleAuditValidationFailure {
  iteration: number;
}

interface PersistedLoopState {
  version: "video-factory/agent-loop-checkpoint-v9";
  key: string;
  contractDigest: string;
  role: string;
  maxIterations: number;
  cycle: number;
  status: "running" | "passed" | "awaiting_user" | "exhausted" | "failed";
  completed: PersistedLoopIteration[];
  pendingCandidate?: PersistedLoopCandidate;
  validationFailure?: PersistedValidationFailure;
  auditValidationFailure?: PersistedAuditValidationFailure;
  operationGenerations: Record<string, number>;
  failedOperationRequestIds: Record<string, string>;
  attemptedRequestIds: string[];
  sessions: Partial<Record<"produce" | "audit", CodexTaskSession>>;
  phaseAttempts: Record<"produce" | "audit", number>;
  unacceptedPhaseAttempts: Record<"produce" | "audit", number>;
  phaseDurationsMs: Record<"produce" | "audit", number>;
  validationMs: number;
  structuredRepairModelCallCount: number;
  retriedRequestIds: string[];
  requestOwners: Record<string, string>;
  failure?: NonNullable<AgentLoopTrace["failure"]>;
  /** C5：已确证未受理（409）触发的会话重建计数；持久化、有界，防止无界重建循环。 */
  sessionRebuilds: Record<"produce" | "audit", number>;
  pendingOperation?: {
    phase: "produce" | "audit";
    iteration: number;
    operationKey: string;
    generation: number;
    /** 此物理任务提交时适用的角色验收合同；恢复时不得用当前合同覆盖。 */
    contractDigest: string;
    operation: CodexPreparedOperation;
  };
}

interface ExecutedRoleOperation {
  execution: CodexTaskExecution<unknown>;
  contractDigest: string;
}

export async function runRoleAgentLoop<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
): Promise<CodexTaskExecution<TOutput>> {
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > 3) {
    throw new Error("Agent loop maxIterations must be an integer between 1 and 3.");
  }
  if (
    options.criteria.length < 1
    || options.criteria.length > ROLE_AUDIT_CRITERIA_MAX_ITEMS
    || options.criteria.some((criterion) => !criterion.trim())
  ) {
    throw new Error(`Agent loop criteria must contain 1 to ${ROLE_AUDIT_CRITERIA_MAX_ITEMS} non-empty rules.`);
  }
  for (const [phase, limit] of Object.entries(options.maxPhaseAttempts ?? {})) {
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 6) {
      throw new Error(`Agent loop ${phase} attempt limit must be an integer between 1 and 6.`);
    }
  }

  const state = await restoreCheckpoint(options);
  const notAcceptedRecoveryRequestId = state.status === "failed" && state.failure?.stage === "not_accepted"
    ? state.pendingOperation?.operation.requestId : undefined;
  const completedFailureRecoveryRequestId = options.checkpoint?.resumeCompletedFailureRequestId
    ?? (options.checkpoint?.resumeCompletedFailure ? state.pendingOperation?.operation.requestId : undefined);
  await resumePendingAudit(options, state);
  const persistedPlanningHalt = options.planningRole
    ? nonLocalPlanningDisposition(state.completed.at(-1)?.audit)
    : undefined;
  // needs_source 不再是停摆（见轮内注释），恢复时按同一语义收口：旧版本把它记成 failed 落过盘，
  // 这里既不能让它继续重跑（生产者/审计请求都已花掉，重跑只是重复花钱），也不能让它停在 failed 上
  // ——它不是失败，是"材料当前拿不到"这条建议。
  const persistedFinal = state.completed.at(-1);
  const persistedSourceGap = persistedFinal !== undefined
    && ((persistedFinal.hostReadiness?.status === "needs_source"
        && !allHostSourceIssuesMisclassified(persistedFinal.hostReadiness, persistedFinal.audit))
      || persistedPlanningHalt?.action === "needs_source");
  // 只有 needs_user 仍然停摆：它把决定交还给决策者本人，不是对作品下判。
  const persistedUserHalt = persistedPlanningHalt?.action === "needs_user" ? persistedPlanningHalt : undefined;
  if (state.status === "failed" && !persistedUserHalt && !persistedSourceGap) {
    state.status = "running";
    delete state.failure;
    await persistCheckpoint(options, state);
  }
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
      candidate: timedValidate(options, state, options.initialCandidate, validationContext(1)),
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
    ...(entry.hostReadiness ? { hostReadiness: structuredClone(entry.hostReadiness) } : {}),
  }));
  if (persistedSourceGap) {
    const terminalStatus = terminalStatusForSourceGap(persistedFinal!.audit);
    state.status = terminalStatus;
    await persistCheckpoint(options, state);
    return completedExecution(options, state, iterations, terminalStatus);
  }
  if (persistedUserHalt) {
    throw planningHaltError(options, state, iterations, persistedUserHalt);
  }
  if (state.status === "passed" || state.status === "awaiting_user") {
    // awaiting_user 表示上一轮已经审完并停在用户面前；恢复时原样交还，不重跑审计。
    return completedExecution(options, state, iterations, state.status);
  }

  const lastCompleted = state.completed.at(-1);
  let revision: { candidate: TOutput; audit: RoleAudit } | undefined = lastCompleted
    ? {
      candidate: timedValidate(options, state, lastCompleted.candidate, validationContext(lastCompleted.iteration)),
      audit: revisionAuditForHost(lastCompleted.audit, lastCompleted.hostReadiness),
    }
    : undefined;
  let validationRevision = state.validationFailure;
  let previousCandidate = lastCompleted ? JSON.stringify(revision!.candidate) : "";
  const operationScope = options.checkpoint?.key ?? randomUUID();
  for (let iteration = state.completed.length + 1; iteration <= options.maxIterations; iteration += 1) {
    let candidateExecution: CodexTaskExecution<unknown>;
    let candidate: TOutput;
    if (state.pendingCandidate?.iteration === iteration) {
      candidate = timedValidate(options, state, state.pendingCandidate.candidate, validationContext(iteration));
      candidateExecution = {
        output: candidate,
        ...(state.pendingCandidate.candidateTrace ? { trace: state.pendingCandidate.candidateTrace } : {}),
      };
    } else {
      const operationKey = loopOperationKey(state, iteration, "produce");
      let structuredOutputAttempts = 0;
      while (true) {
        if (structuredOutputAttempts > 0) state.structuredRepairModelCallCount += 1;
        try {
          candidateExecution = (await executeOperation(
            options,
            state,
            operationScope,
            iteration,
            "produce",
            completedFailureRecoveryRequestId,
            notAcceptedRecoveryRequestId,
            (operation) => options.produce(producerRevision(revision, validationRevision, operation.session), operation),
          )).execution;
        } catch (error) {
          throw await failedLoopError(error, options, state, iterations, state.completed.at(-1)?.candidateTrace, "produce");
        }
        try {
          candidate = timedValidate(options, state, candidateExecution.output, validationContext(iteration));
          break;
        } catch (error) {
          structuredOutputAttempts += 1;
          acceptOperationSession(state, "produce", candidateExecution.session);
          retireAcceptedOperation(state, operationKey);
          validationRevision = {
            iteration,
            invalidCandidate: structuredClone(candidateExecution.output),
            invalidCandidateHash: valueHash(candidateExecution.output),
            validationError: publicValidationError(error),
          };
          state.validationFailure = validationRevision;
          clearPendingOperation(state, operationKey);
          await persistCheckpoint(options, state);
          if (structuredOutputAttempts >= MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN) {
            throw await failedLoopError(
              new Error(
                `${options.role}连续两次返回了无法使用的结果；本轮质量审计尚未消耗，`
                + `可从已保存进度继续。${validationRevision.validationError}`,
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
      clearPendingOperation(state, operationKey);
      await persistCheckpoint(options, state);
    }
    const candidateFingerprint = JSON.stringify(candidate);
    if (iteration > 1 && candidateFingerprint === previousCandidate) {
      state.status = "exhausted";
      throw await failedLoopError(
        new Error(`${options.role}按修改建议重做后内容没有变化。`),
        options,
        state,
        iterations,
        candidateExecution.trace,
      );
    }
    previousCandidate = candidateFingerprint;

    if (options.deferAudit) {
      return pendingCandidateExecution(options, state, candidate, candidateExecution);
    }

    const hostReadiness = options.assessPlanningReadiness?.(candidate);

    let auditExecution: CodexTaskExecution<unknown>;
    let audit: RoleAudit;
    const auditOperationKey = loopOperationKey(state, iteration, "audit");
    let structuredAuditAttempts = 0;
    let auditValidationFailure = state.auditValidationFailure?.iteration === iteration
      ? state.auditValidationFailure
      : undefined;
    while (true) {
      if (structuredAuditAttempts > 0) state.structuredRepairModelCallCount += 1;
      let auditContractDigest: string;
      try {
        const executedAudit = await executeOperation(
          options,
          state,
          operationScope,
          iteration,
          "audit",
          completedFailureRecoveryRequestId,
          notAcceptedRecoveryRequestId,
          (operation) => options.audit({
            role: options.role,
            iteration,
            criteria: options.criteria,
            candidate,
            ...(revision?.audit ? { previousAudit: revision.audit } : {}),
            ...(auditValidationFailure ? {
              validationFailure: {
                invalidCandidate: structuredClone(auditValidationFailure.invalidCandidate),
                invalidCandidateHash: auditValidationFailure.invalidCandidateHash,
                validationError: auditValidationFailure.validationError,
              },
            } : {}),
            ...(hostReadiness ? { hostReadiness } : {}),
            ...operation,
          }),
        );
        auditExecution = executedAudit.execution;
        auditContractDigest = executedAudit.contractDigest;
      } catch (error) {
        throw await failedLoopError(error, options, state, iterations, candidateExecution.trace, "audit");
      }
      try {
        audit = timedValidateAudit(options, state, auditExecution.output, hostReadiness, candidate);
        if (auditContractDigest !== state.contractDigest) {
          // 原物理 audit 必须先结清，但旧合同的 verdict 不能认证当前 criteria。保留候选，
          // 清掉旧审计会话并迁移到当前 checkpoint，再提交一份当前标准的独立审计。
          acceptOperationSession(state, "audit", auditExecution.session);
          retireAcceptedOperation(state, auditOperationKey);
          clearPendingOperation(state, auditOperationKey);
          delete state.sessions.audit;
          delete state.auditValidationFailure;
          await persistCheckpoint(options, state);
          if (options.checkpoint && state.key !== options.checkpoint.key) {
            state.key = options.checkpoint.key;
            await persistCheckpoint(options, state);
          }
          auditValidationFailure = undefined;
          continue;
        }
        break;
      } catch (error) {
        structuredAuditAttempts += 1;
        acceptOperationSession(state, "audit", auditExecution.session);
        retireAcceptedOperation(state, auditOperationKey);
        auditValidationFailure = {
          iteration,
          invalidCandidate: structuredClone(auditExecution.output),
          invalidCandidateHash: valueHash(auditExecution.output),
          validationError: publicValidationError(error),
        };
        state.auditValidationFailure = auditValidationFailure;
        clearPendingOperation(state, auditOperationKey);
        await persistCheckpoint(options, state);
        if (structuredAuditAttempts >= MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_RUN) {
          throw await failedLoopError(
            new Error(
              `${options.role}的独立审计连续两次返回了无法使用的结果；本轮质量审计尚未消耗，`
              + `可从已保存进度继续。${publicValidationError(error)}`,
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
    delete state.auditValidationFailure;
    state.completed.push({
      iteration,
      candidate,
      ...(candidateExecution.trace ? { candidateTrace: candidateExecution.trace } : {}),
      audit,
      ...(hostReadiness ? { hostReadiness: structuredClone(hostReadiness) } : {}),
      ...(auditExecution.trace ? { auditTrace: auditExecution.trace } : {}),
    });
    delete state.pendingCandidate;
    clearPendingOperation(state, auditOperationKey);
    iterations.push({
      iteration,
      candidate: structuredClone(candidate),
      candidateHash: valueHash(candidate),
      ...(candidateExecution.trace ? { candidateTrace: candidateExecution.trace } : {}),
      ...(auditExecution.trace ? { auditTrace: auditExecution.trace } : {}),
      audit,
      ...(hostReadiness ? { hostReadiness: structuredClone(hostReadiness) } : {}),
    });
    // 来源缺口（宿主就绪检查或独立审计判定的 needs_source）不拦下制作：门槛只出建议，没有权力
    // 决定一条片子能不能开工，判不判得成是创作者的事。候选与那一轮审计原样留在 checkpoint，
    // 循环在这里收口——审计判 pass 就带着建议照常交付，否则沿用 awaiting_user（产出与审计都在，
    // 交创作者裁决）。缺口证据留在 iterations[].hostReadiness / audit.planningDisposition 里，
    // 由调用方转成创作者能看到的建议标签继续传递，不在这里丢掉。
    if (hostReadiness?.status === "needs_source" && !allHostSourceIssuesMisclassified(hostReadiness, audit)) {
      const terminalStatus = terminalStatusForSourceGap(audit);
      state.status = terminalStatus;
      await persistCheckpoint(options, state);
      return completedExecution(options, state, iterations, terminalStatus);
    }
    const nonLocalDisposition = options.planningRole ? nonLocalPlanningDisposition(audit) : undefined;
    if (nonLocalDisposition?.action === "needs_source") {
      const terminalStatus = terminalStatusForSourceGap(audit);
      state.status = terminalStatus;
      await persistCheckpoint(options, state);
      return completedExecution(options, state, iterations, terminalStatus);
    }
    if (nonLocalDisposition) {
      state.status = "failed";
      await persistCheckpoint(options, state);
      throw planningHaltError(options, state, iterations, nonLocalDisposition);
    }
    if (hostReadiness && hostReadiness.status !== "ready") {
      await persistCheckpoint(options, state);
      revision = { candidate, audit: revisionAuditForHost(audit, hostReadiness) };
      continue;
    }
    if (audit.verdict === "pass") {
      state.status = "passed";
      await persistCheckpoint(options, state);
      return completedExecution(options, state, iterations);
    }
    if (iteration === options.maxIterations) {
      // 自动重做轮次用尽仍未通过。审计只出建议，不改判成败：候选、审计与全部轮次都留在
      // checkpoint 里，原地停在用户面前由他裁决——直接采用，或带着建议去跟生产模型谈下一版。
      state.status = "awaiting_user";
      await persistCheckpoint(options, state);
      return completedExecution(options, state, iterations, "awaiting_user");
    }
    await persistCheckpoint(options, state);
    revision = { candidate, audit };
  }

  // 上界保证循环至少跑一轮，且每条路径都在轮内返回；落到这里说明 maxIterations 被改坏了。
  throw new Error("Agent loop finished without a terminal result.");
}

async function resumePendingAudit<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
): Promise<void> {
  const resume = options.checkpoint?.resumeFrom;
  if (!resume || state.completed.length > 0 || state.pendingCandidate || state.validationFailure) return;
  if (resume.status !== "failed"
    || !resume.pendingCandidate
    || resume.role !== options.role
    || resume.contractVersion !== options.contractVersion
    || resume.maxIterations !== options.maxIterations
    || JSON.stringify(resume.criteria) !== JSON.stringify(options.criteria)
    || resume.pendingCandidate.iteration !== resume.iterations.length + 1) {
    throw new Error("Agent loop audit fallback checkpoint is incompatible with this role.");
  }

  state.completed = resume.iterations.map((entry, index) => {
    if (entry.iteration !== index + 1) {
      throw new Error("Agent loop audit fallback iterations are not contiguous.");
    }
    const candidate = timedValidate(options, state, entry.candidate, validationContext(entry.iteration));
    return {
      iteration: entry.iteration,
      candidate,
      ...(entry.candidateTrace ? { candidateTrace: structuredClone(entry.candidateTrace) } : {}),
      audit: validateRoleAudit(entry.audit, {
        planningRole: options.planningRole === true,
        role: options.role,
        candidate,
      }),
      ...(entry.auditTrace ? { auditTrace: structuredClone(entry.auditTrace) } : {}),
    };
  });
  state.pendingCandidate = {
    iteration: resume.pendingCandidate.iteration,
    candidate: timedValidate(
      options,
      state,
      resume.pendingCandidate.candidate,
      validationContext(resume.pendingCandidate.iteration),
    ),
    ...(resume.pendingCandidate.candidateTrace
      ? { candidateTrace: structuredClone(resume.pendingCandidate.candidateTrace) }
      : {}),
  };
  state.phaseAttempts = {
    produce: resume.producerModelCallCount ?? state.completed.length + 1,
    audit: resume.auditModelCallCount ?? state.completed.length + 1,
  };
  state.phaseDurationsMs = {
    produce: resume.producerMs ?? 0,
    audit: resume.auditMs ?? 0,
  };
  state.validationMs += resume.validationMs ?? 0;
  const priorModelCalls = resume.modelCallCount
    ?? state.phaseAttempts.produce + state.phaseAttempts.audit;
  // 旧请求标识不应发送给新的 Provider；这里只保留计数占位，保证审计账本不会少记已经发生的调用。
  state.attemptedRequestIds = Array.from(
    { length: priorModelCalls },
    (_, index) => `resumed-model-call-${index + 1}`,
  );
  state.retriedRequestIds = Array.from(
    { length: resume.retryCount ?? 0 },
    (_, index) => `resumed-retry-${index + 1}`,
  );
  await persistCheckpoint(options, state);
}

async function failedLoopError<TOutput>(
  error: unknown,
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  iterations: AgentLoopTrace["iterations"],
  lastTrace?: CodexTaskExecution["trace"],
  failedPhase?: "produce" | "audit",
): Promise<RoleAgentLoopError> {
  const bridgeError = bridgeErrorFromCause(error);
  const confirmedUnaccepted = bridgeError !== undefined
    && (bridgeError.stage === "not_accepted" || bridgeError.stage === "rejected" || bridgeError.stage === "conflict")
    && bridgeError.failureDetails?.accepted !== true;
  const unacceptedPhase = confirmedUnaccepted
    ? failedPhase ?? state.pendingOperation?.phase ?? (bridgeError.failureDetails?.taskKind === "role-audit" ? "audit" : "produce")
    : undefined;
  if (unacceptedPhase) {
    state.unacceptedPhaseAttempts[unacceptedPhase] += 1;
    const wasStructuredRepair = unacceptedPhase === "produce"
      ? state.validationFailure !== undefined
      : state.auditValidationFailure !== undefined;
    if (wasStructuredRepair && state.structuredRepairModelCallCount > 0) {
      state.structuredRepairModelCallCount -= 1;
    }
  }
  const { producerModelCallCount, auditModelCallCount } = actualPhaseModelCallCounts(state);
  const baseMessage = error instanceof CodexBridgeError
    ? error.creatorMessage
    : error instanceof Error ? error.message : String(error);
  const message = bridgeError
    ? `${baseMessage}${safeBridgeDiagnostic(bridgeError)}`
    : baseMessage;
  if (bridgeError) {
    state.failure = {
      stage: bridgeError.stage,
      ...(bridgeError.statusCode !== undefined ? { statusCode: bridgeError.statusCode } : {}),
      ...(bridgeError.failureKind !== undefined ? { failureKind: bridgeError.failureKind } : {}),
      ...(bridgeError.failureDetails ? { details: structuredClone(bridgeError.failureDetails) } : {}),
    };
  } else {
    delete state.failure;
  }
  if (state.status !== "exhausted") state.status = "failed";
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
      modelCallCount: producerModelCallCount + auditModelCallCount,
      producerModelCallCount,
      auditModelCallCount,
      producerMs: state.phaseDurationsMs.produce,
      auditMs: state.phaseDurationsMs.audit,
      validationMs: state.validationMs,
      structuredRepairModelCallCount: totalStructuredRepairModelCallCount(state),
      retryCount: state.retriedRequestIds.length,
      ...(state.failure ? { failure: structuredClone(state.failure) } : {}),
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
    error,
  );
}

async function restoreCheckpoint<TOutput>(options: RoleAgentLoopOptions<TOutput>): Promise<PersistedLoopState> {
  const fresh = (cycle = 0): PersistedLoopState => ({
    version: "video-factory/agent-loop-checkpoint-v9",
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
    unacceptedPhaseAttempts: { produce: 0, audit: 0 },
    phaseDurationsMs: { produce: 0, audit: 0 },
    validationMs: 0,
    structuredRepairModelCallCount: 0,
    retriedRequestIds: [],
    requestOwners: {},
    sessionRebuilds: { produce: 0, audit: 0 },
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
  const legacyV6 = loadedVersion === "video-factory/agent-loop-checkpoint-v6";
  const legacyV7 = loadedVersion === "video-factory/agent-loop-checkpoint-v7";
  const legacyV8 = loadedVersion === "video-factory/agent-loop-checkpoint-v8";
  const recoverablePending = (legacyV8 || loadedVersion === "video-factory/agent-loop-checkpoint-v9")
    && isPersistedPendingOperation(candidate.pendingOperation);
  const structurallyInvalid = (!legacyV3 && !legacyV4 && !legacyV5 && !legacyV6 && !legacyV7 && !legacyV8
      && loadedVersion !== "video-factory/agent-loop-checkpoint-v9")
    || candidate.role !== options.role
    || candidate.maxIterations !== options.maxIterations
    || (candidate.status !== "running" && candidate.status !== "passed" && candidate.status !== "awaiting_user"
      && candidate.status !== "exhausted" && candidate.status !== "failed")
    || !Number.isInteger(candidate.cycle) || Number(candidate.cycle) < 0
    || !Array.isArray(candidate.completed)
    || !isRequestState(candidate.operationGenerations, "number")
    || !isRequestState(candidate.failedOperationRequestIds, "string")
    || !Array.isArray(candidate.attemptedRequestIds)
    || candidate.attemptedRequestIds.some((requestId) => typeof requestId !== "string")
    || (!legacyV3 && !isSessionState(candidate.sessions))
    || (!legacyV3 && !legacyV4 && !legacyV5 && !isPhaseAttempts(candidate.phaseAttempts))
    || ((legacyV8 || loadedVersion === "video-factory/agent-loop-checkpoint-v9")
      && candidate.pendingOperation !== undefined
      && !isPersistedPendingOperation(candidate.pendingOperation));
  if (structurallyInvalid) {
    if (recoverablePending) {
      throw new Error("Agent loop has an accepted pending operation that is incompatible with the current role; it must be reconciled before a new request can be created.");
    }
    return fresh();
  }
  const contractChanged = candidate.key !== options.checkpoint.key
    || candidate.contractDigest !== roleContractDigest(options);
  if (contractChanged && !recoverablePending) return fresh();
  // 候选可能靠外部证据校验（审片报告绑定的是产出当时那批证据帧），而证据快照不在 contractDigest 里。
  // 证据被重新生成后旧结论不再成立，只能重跑这一轮：既不能回放旧结论，也不能让校验错误冒充服务故障上报。
  let restoredCandidateRejected = false;
  const validateRestoredCandidate = (value: unknown, iteration: number): TOutput => {
    try {
      return options.validate(value, validationContext(iteration));
    } catch (error) {
      restoredCandidateRejected = true;
      throw error;
    }
  };
  let completed: PersistedLoopIteration[];
  let pendingCandidate: PersistedLoopCandidate | undefined;
  try {
    completed = candidate.completed!.map((entry, index): PersistedLoopIteration => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Agent loop checkpoint iteration is invalid.");
      const value = entry as Partial<PersistedLoopIteration>;
      if (value.iteration !== index + 1) throw new Error("Agent loop checkpoint iterations are not contiguous.");
      const output = validateRestoredCandidate(value.candidate, value.iteration);
      const hostReadiness = value.hostReadiness === undefined
        ? undefined
        : parseHostPlanningReadiness(value.hostReadiness);
      return {
        iteration: value.iteration,
        candidate: output,
        ...(value.candidateTrace ? { candidateTrace: value.candidateTrace } : {}),
        audit: validateRoleAudit(value.audit, {
          planningRole: options.planningRole === true,
          role: options.role,
          candidate: output,
          ...(hostReadiness ? { hostReadiness } : {}),
        }),
        ...(hostReadiness ? { hostReadiness } : {}),
        ...(value.auditTrace ? { auditTrace: value.auditTrace } : {}),
      };
    });
    if (candidate.pendingCandidate !== undefined) {
      const pending = candidate.pendingCandidate;
      if (typeof pending !== "object" || pending === null || Array.isArray(pending)) {
        throw new Error("Agent loop checkpoint pending candidate is invalid.");
      }
      const value = pending as Partial<PersistedLoopCandidate>;
      if (value.iteration !== completed.length + 1) throw new Error("Agent loop checkpoint pending iteration is invalid.");
      pendingCandidate = {
        iteration: value.iteration,
        candidate: validateRestoredCandidate(value.candidate, value.iteration),
        ...(value.candidateTrace ? { candidateTrace: value.candidateTrace } : {}),
      };
    }
  } catch (error) {
    // 已受理但未结清的物理任务必须保留现场，交由上层对账后再决定是否重跑。
    if (!restoredCandidateRejected || recoverablePending) throw error;
    // 重跑必须开启新 cycle：物理请求身份由 cycle 派生，沿用旧 cycle 会与已结清的历史任务撞身份，
    // 被代理按 binding_conflict 拒绝。
    return fresh(Number(candidate.cycle) + 1);
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
  let auditValidationFailure: PersistedAuditValidationFailure | undefined;
  if (candidate.auditValidationFailure !== undefined) {
    const failure = candidate.auditValidationFailure as Partial<PersistedAuditValidationFailure>;
    if (failure.iteration !== completed.length + 1
      || failure.invalidCandidate === undefined
      || typeof failure.invalidCandidateHash !== "string"
      || typeof failure.validationError !== "string") {
      throw new Error("Agent loop checkpoint audit validation failure is invalid.");
    }
    auditValidationFailure = failure as PersistedAuditValidationFailure;
  }
  if (pendingCandidate && validationFailure) throw new Error("Agent loop checkpoint cannot contain a candidate and validation failure together.");
  if (candidate.status === "passed" && (pendingCandidate || completed.at(-1)?.audit.verdict !== "pass")) {
    throw new Error("Passed agent loop checkpoint has no passing final audit.");
  }
  const restored: PersistedLoopState = {
    version: "video-factory/agent-loop-checkpoint-v9",
    key: candidate.key!,
    // 已受理的物理任务保留原 operation/binding；结清之后的新 audit/repair 使用当前合同身份。
    contractDigest: contractChanged ? roleContractDigest(options) : candidate.contractDigest!,
    role: candidate.role!,
    maxIterations: candidate.maxIterations!,
    cycle: Number(candidate.cycle),
    status: candidate.status!,
    completed,
    operationGenerations: { ...candidate.operationGenerations } as Record<string, number>,
    failedOperationRequestIds: { ...candidate.failedOperationRequestIds } as Record<string, string>,
    attemptedRequestIds: [...candidate.attemptedRequestIds!],
    sessions: legacyV3 ? {} : structuredClone(candidate.sessions!),
    phaseAttempts: legacyV3 || legacyV4 || legacyV5
      ? inferredPhaseAttempts(completed, pendingCandidate)
      : structuredClone(candidate.phaseAttempts!),
    unacceptedPhaseAttempts: isPhaseAttempts(candidate.unacceptedPhaseAttempts)
      ? structuredClone(candidate.unacceptedPhaseAttempts)
      : { produce: 0, audit: 0 },
    phaseDurationsMs: isPhaseDurations(candidate.phaseDurationsMs)
      ? structuredClone(candidate.phaseDurationsMs)
      : { produce: 0, audit: 0 },
    validationMs: isDuration(candidate.validationMs) ? candidate.validationMs : 0,
    structuredRepairModelCallCount: Number.isSafeInteger(candidate.structuredRepairModelCallCount)
      && Number(candidate.structuredRepairModelCallCount) >= 0
      ? Number(candidate.structuredRepairModelCallCount)
      : 0,
    retriedRequestIds: Array.isArray(candidate.retriedRequestIds)
      && candidate.retriedRequestIds.every((requestId) => typeof requestId === "string")
      ? [...candidate.retriedRequestIds]
      : [],
    requestOwners: isRecordValue(candidate.requestOwners)
      ? Object.fromEntries(Object.entries(candidate.requestOwners).filter(
        ([requestId, owner]) => typeof requestId === "string" && typeof owner === "string" && owner.length > 0,
      )) as Record<string, string>
      : {},
    // C5：旧 checkpoint 没有该字段时按 0 恢复——不重置正在进行的循环，只给新预算字段初值。
    sessionRebuilds: isPhaseAttempts(candidate.sessionRebuilds)
      ? structuredClone(candidate.sessionRebuilds)
      : { produce: 0, audit: 0 },
    ...(isAgentLoopFailure(candidate.failure) ? { failure: structuredClone(candidate.failure) } : {}),
    ...(!legacyV3 && !legacyV4 && !legacyV5 && !legacyV6 && !legacyV7
      && isPersistedPendingOperation(candidate.pendingOperation)
      ? {
        pendingOperation: {
          ...structuredClone(candidate.pendingOperation),
          contractDigest: candidate.pendingOperation.contractDigest ?? candidate.contractDigest!,
        },
      }
      : {}),
    ...(pendingCandidate ? { pendingCandidate } : {}),
    ...(validationFailure ? { validationFailure } : {}),
    ...(auditValidationFailure ? { auditValidationFailure } : {}),
  };
  if (restored.status === "exhausted" && options.checkpoint.restartExhausted) {
    const restarted = fresh(restored.cycle + 1);
    await persistCheckpoint(options, restarted);
    return restarted;
  }
  return restored;
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
  status: "passed" | "awaiting_user" = "passed",
): CodexTaskExecution<TOutput> {
  const final = state.completed.at(-1);
  if (!final || (status === "passed" && final.audit.verdict !== "pass")) {
    throw new Error("Agent loop checkpoint has no passing result.");
  }
  const finalTrace = final.candidateTrace ?? final.auditTrace;
  const { producerModelCallCount, auditModelCallCount } = actualPhaseModelCallCounts(state);
  return {
    output: timedValidate(options, state, final.candidate, validationContext(final.iteration)),
    ...(finalTrace ? { trace: finalTrace } : {}),
    agentLoop: {
      version: "video-factory/agent-loop-v1",
      role: options.role,
      contractVersion: options.contractVersion,
      criteria: [...options.criteria],
      status,
      maxIterations: options.maxIterations,
      modelCallCount: producerModelCallCount + auditModelCallCount,
      producerModelCallCount,
      auditModelCallCount,
      producerMs: state.phaseDurationsMs.produce,
      auditMs: state.phaseDurationsMs.audit,
      validationMs: state.validationMs,
      structuredRepairModelCallCount: totalStructuredRepairModelCallCount(state),
      retryCount: state.retriedRequestIds.length,
      iterations,
    },
  };
}

function pendingCandidateExecution<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  candidate: TOutput,
  execution: CodexTaskExecution<unknown>,
): CodexTaskExecution<TOutput> {
  return {
    output: timedValidate(options, state, candidate, validationContext(state.pendingCandidate?.iteration ?? 1)),
    ...(execution.trace ? { trace: execution.trace } : {}),
    ...(execution.session ? { session: execution.session } : {}),
  };
}

function roleContractDigest<TOutput>(options: RoleAgentLoopOptions<TOutput>): string {
  return valueHash({
    contractVersion: options.contractVersion,
    role: options.role,
    criteria: options.criteria,
    maxIterations: options.maxIterations,
    maxPhaseAttempts: options.maxPhaseAttempts,
    planningRole: options.planningRole === true,
    deferAudit: options.deferAudit === true,
  });
}

async function executeOperation<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  scope: string,
  iteration: number,
  phase: "produce" | "audit",
  completedFailureRecoveryRequestId: string | undefined,
  notAcceptedRecoveryRequestId: string | undefined,
  execute: (operation: RoleAgentOperation) => Promise<CodexTaskExecution<unknown>>,
): Promise<ExecutedRoleOperation> {
  const operationKey = loopOperationKey(state, iteration, phase);
  while (true) {
    const generation = state.operationGenerations[operationKey] ?? 0;
    const pendingOperation = state.pendingOperation?.operationKey === operationKey
      && state.pendingOperation.phase === phase
      && state.pendingOperation.iteration === iteration
      && state.pendingOperation.generation === generation
      ? state.pendingOperation
      : undefined;
    const pending = pendingOperation?.operation;
    const operationContractDigest = pendingOperation?.contractDigest ?? state.contractDigest;
    // 合同升级可改变当前 checkpoint/request identity，但观察未结清任务仍必须沿用原 requestId，
    // 否则一次纯查询会被误计为新的物理模型调用。
    const requestId = pending?.requestId
      ?? operationRequestId(scope, state.contractDigest, state.cycle, iteration, phase, generation);
    const session: CodexTaskSession = state.sessions[phase] ?? {
      key: `agent-${valueHash({ scope, contractDigest: state.contractDigest, cycle: state.cycle, phase })}`,
    };
    const attemptLimit = options.maxPhaseAttempts?.[phase];
    if (!state.attemptedRequestIds.includes(requestId)
      && attemptLimit !== undefined
      && state.phaseAttempts[phase] - state.unacceptedPhaseAttempts[phase] >= attemptLimit) {
      throw new Error(`${options.role}的${phase === "audit" ? "独立审计" : "内容生成"}调用已达到本轮上限 ${attemptLimit} 次。`);
    }
    try {
      const result = await executeTrackedOperation(options, state, requestId, session, iteration, phase, generation > 0, execute);
      if (result.session) {
        if (result.session.key !== session.key) throw new Error("Agent loop received a mismatched task session key.");
        if (session.handle && result.session.handle !== session.handle) {
          throw new Error("Agent loop received a different task session handle while resuming.");
        }
      }
      delete state.failedOperationRequestIds[operationKey];
      return { execution: result, contractDigest: operationContractDigest };
    } catch (error) {
      if (error instanceof CodexBridgeError
        && error.stage === "not_accepted"
        && error.statusCode === 409
        && error.message.includes("Codex role session is unknown or belongs to a different production role.")) {
        // C5：已确证未受理允许安全地换会话重试，但重建本身必须有持久化的上界——
        // "未受理不计模型执行次数"不能同时抵消控制循环的停止条件。
        const rebuilds = (state.sessionRebuilds[phase] ?? 0) + 1;
        if (rebuilds > MAX_SESSION_REBUILDS) {
          state.failedOperationRequestIds[operationKey] = requestId;
          untrackUnacceptedOperation(state, requestId, phase);
          await persistCheckpoint(options, state);
          throw new Error(
            `${options.role}的${phase === "audit" ? "独立审计" : "内容生成"}会话被连续拒绝 ${rebuilds - 1} 次，已停止自动重建；当前进度已保留，请检查模型服务状态后重试。`,
            { cause: error },
          );
        }
        state.sessionRebuilds[phase] = rebuilds;
        clearPendingOperation(state, operationKey);
        delete state.sessions[phase];
        untrackUnacceptedOperation(state, requestId, phase);
        retireAcceptedOperation(state, operationKey);
        await persistCheckpoint(options, state);
        continue;
      }
      if (error instanceof CodexBridgeError && error.stage === "completed_failure") {
        retireAcceptedOperation(state, operationKey);
        clearPendingOperation(state, operationKey);
        if (completedFailureRecoveryRequestId === requestId
          && (error.failureKind === "model_provider_transient" || error.failureKind === "model_provider_no_output")) {
          // 只有 Studio 已核验终态、用户又明确点了重试，才在同一 lease 内进入下一代请求。
          // 未知、冲突、合同拒绝和自动恢复仍然停住，不会借此切换 requestId 或 backup。
          await persistCheckpoint(options, state);
          continue;
        }
        // Broker 已明确完成且失败，不能复用 requestId；但这不是候选或审计的语义失败。
        // 立即把控制权交还给工作流，保留候选供下一次人工重试继续，避免静默再跑三次长任务。
        await persistCheckpoint(options, state);
        const phaseLabel = phase === "audit" ? "独立审计" : "内容生成";
        // 只有"不改任何东西直接再发一次"确实有效时才提示可直接重试；语义/合同类失败
        // 必须先修正，creatorMessage 已给出修正方向，此处不能再并列一句"可直接重试"。
        const category = error.failureDetails?.category;
        const retryAsIs = category !== "invalid_output" && category !== "invalid_request";
        throw new Error(
          `${options.role}的${phaseLabel}暂时失败，尚未消耗质量审计轮次；当前内容和进度已保留。${retryAsIs ? "可直接重试。" : ""}${error.creatorMessage}`,
          { cause: error },
        );
      }
      state.failedOperationRequestIds[operationKey] = requestId;
      if (error instanceof CodexBridgeError && error.stage === "not_accepted") {
        // 原身份已被 Broker 终结为未受理；本轮立即停止，下一次显式重试使用新身份。
        // 不重建会话，不消耗模型次数，也不重放封存的拒绝记录。
        clearPendingOperation(state, operationKey);
        retireAcceptedOperation(state, operationKey);
        if (notAcceptedRecoveryRequestId === requestId) {
          await persistCheckpoint(options, state);
          continue;
        }
      }
      if (error instanceof CodexBridgeError && (error.stage === "rejected" || error.stage === "conflict")) {
        clearPendingOperation(state, operationKey);
      }
      if (error instanceof CodexBridgeError && error.stage === "conflict") {
        // 该身份已被"内容不同"的历史任务占用（例如证据帧重新生成后同样的轮次编号换了载荷）。
        // 只清 pending 的话每次重试都会撞同一条冲突记录，运行将永久卡死；必须换新身份，
        // 由操作者显式重试后再提交，避免自动重发造成重复的物理调用。
        retireAcceptedOperation(state, operationKey);
      }
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

function clearPendingOperation(state: PersistedLoopState, operationKey: string): void {
  if (state.pendingOperation?.operationKey === operationKey) delete state.pendingOperation;
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
  iteration: number,
  phase: "produce" | "audit",
  isRetry: boolean,
  execute: (operation: RoleAgentOperation) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  if (!state.attemptedRequestIds.includes(requestId)) {
    state.attemptedRequestIds.push(requestId);
    state.phaseAttempts[phase] += 1;
    if (isRetry) state.retriedRequestIds.push(requestId);
    await persistCheckpoint(options, state);
  }
  const startedAt = nowMs(options);
  try {
    const operationKey = loopOperationKey(state, iteration, phase);
    const pending = state.pendingOperation?.operationKey === operationKey
      && state.pendingOperation.phase === phase
      && state.pendingOperation.iteration === iteration
      && state.pendingOperation.generation === (state.operationGenerations[operationKey] ?? 0)
      ? structuredClone(state.pendingOperation.operation)
      : undefined;
    return await execute({
      requestId,
      session,
      requestOptions: {
        beforeSubmit: async (preparedOperation) => {
          if (options.checkpoint?.executionOwnerId && !state.requestOwners[preparedOperation.requestId]) {
            state.requestOwners[preparedOperation.requestId] = options.checkpoint.executionOwnerId;
          }
          state.pendingOperation = {
            phase,
            iteration,
            operationKey,
            generation: state.operationGenerations[operationKey] ?? 0,
            contractDigest: state.contractDigest,
            operation: structuredClone(preparedOperation),
          };
          await persistCheckpoint(options, state);
        },
      },
      ...(pending ? { preparedOperation: pending } : {}),
    });
  } finally {
    state.phaseDurationsMs[phase] += elapsedMs(startedAt, nowMs(options));
    await persistCheckpoint(options, state);
  }
}

function producerRevision<TOutput>(
  revision: { candidate: TOutput; audit: RoleAudit } | undefined,
  validationFailure: PersistedValidationFailure | undefined,
  session: CodexTaskSession,
): RoleAgentRevision<TOutput> | undefined {
  if (validationFailure) {
    if (validationFailure.invalidCandidate === undefined) return undefined;
    return {
      mode: "validation-repair",
      invalidCandidate: structuredClone(validationFailure.invalidCandidate),
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

function isPhaseDurations(value: unknown): value is PersistedLoopState["phaseDurationsMs"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && isDuration(record.produce)
    && isDuration(record.audit);
}

function isDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function timedValidate<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  value: unknown,
  context: RoleAgentValidationContext,
): TOutput {
  const startedAt = nowMs(options);
  try {
    return options.validate(value, context);
  } finally {
    state.validationMs += elapsedMs(startedAt, nowMs(options));
  }
}

function validationContext(iteration: number): RoleAgentValidationContext {
  return { iteration, repair: iteration > 1 };
}

function timedValidateAudit<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  value: unknown,
  hostReadiness: HostPlanningReadiness | undefined,
  candidate: TOutput,
): RoleAudit {
  const startedAt = nowMs(options);
  try {
    return validateRoleAudit(value, {
      planningRole: options.planningRole === true,
      role: options.role,
      candidate,
      ...(hostReadiness ? { hostReadiness } : {}),
    });
  } finally {
    state.validationMs += elapsedMs(startedAt, nowMs(options));
  }
}

function nowMs<TOutput>(options: RoleAgentLoopOptions<TOutput>): number {
  return (options.now ?? Date.now)();
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
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

function isHostPlanningReadiness(value: unknown): value is HostPlanningReadiness {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if ((input.status !== "ready" && input.status !== "revise_here" && input.status !== "needs_source") || !Array.isArray(input.issues)) return false;
  return input.issues.every((issue) => {
    if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return false;
    const item = issue as Record<string, unknown>;
    return typeof item.id === "string"
      && (item.target === "script" || item.target === "director" || item.target === "source" || item.target === "user")
      && Array.isArray(item.beatIds) && item.beatIds.every((entry) => typeof entry === "string")
      && Array.isArray(item.scenePositions) && item.scenePositions.every((entry) => Number.isInteger(entry))
      && typeof item.reason === "string"
      && typeof item.requiredChange === "string"
      && Array.isArray(item.evidenceArtifactIds) && item.evidenceArtifactIds.every((entry) => typeof entry === "string");
  });
}

function parseHostPlanningReadiness(value: unknown): HostPlanningReadiness {
  if (!isHostPlanningReadiness(value)) {
    throw new Error("Agent loop checkpoint host readiness evidence is invalid.");
  }
  return structuredClone(value);
}

function isAgentLoopFailure(value: unknown): value is NonNullable<AgentLoopTrace["failure"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.stage === "not_accepted"
    || input.stage === "completed_failure"
    || input.stage === "uncertain"
    || input.stage === "rejected"
    || input.stage === "conflict";
}

function bridgeErrorFromCause(error: unknown): CodexBridgeError | undefined {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof CodexBridgeError) return current;
    if (!(current instanceof Error) || !(current.cause instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}

function isPersistedPendingOperation(value: unknown): value is NonNullable<PersistedLoopState["pendingOperation"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ((record.phase !== "produce" && record.phase !== "audit")
    || !Number.isInteger(record.iteration) || Number(record.iteration) < 1
    || typeof record.operationKey !== "string" || !record.operationKey
    || !Number.isInteger(record.generation) || Number(record.generation) < 0
    || (record.contractDigest !== undefined && (typeof record.contractDigest !== "string" || !record.contractDigest))
    || typeof record.operation !== "object" || record.operation === null || Array.isArray(record.operation)) return false;
  const operation = record.operation as Record<string, unknown>;
  return operation.version === "video-factory/codex-prepared-operation-v1"
    && typeof operation.requestId === "string"
    && typeof operation.kind === "string"
    && typeof operation.envelope === "object" && operation.envelope !== null
    && typeof operation.serializedEnvelope === "string"
    && typeof operation.binding === "object" && operation.binding !== null
    && typeof operation.brokerBinding === "object" && operation.brokerBinding !== null
    && typeof operation.route === "object" && operation.route !== null;
}

export function validateRoleAudit(
  value: unknown,
  options: {
    planningRole?: boolean;
    hostReadiness?: HostPlanningReadiness;
    /** 给出角色与候选时，宿主核对评估对象与维度集合；只给 value 时跳过（测试与纯输出校验）。 */
    role?: string;
    candidate?: unknown;
  } = {},
): RoleAudit {
  const audit = record(value, "Role audit");
  if (audit.version !== "video-factory/role-audit-v2") throw new Error("Role audit version is invalid.");
  if (audit.rubricVersion !== ROLE_QUALITY_RUBRIC_VERSION) {
    throw new Error(`Role audit rubricVersion must be ${ROLE_QUALITY_RUBRIC_VERSION}.`);
  }
  if (audit.verdict !== "pass" && audit.verdict !== "repair") throw new Error("Role audit verdict is invalid.");
  if (!Number.isInteger(audit.score) || Number(audit.score) < 0 || Number(audit.score) > 100) {
    throw new Error("Role audit score must be an integer between 0 and 100.");
  }
  const assessments = validateRoleAuditAssessments(audit.assessments, Number(audit.score), options);
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
  const planningDisposition = validatePlanningDisposition(audit.planningDisposition, issues, audit.verdict, options.planningRole === true);
  const hostReadinessReview = validateHostReadinessReview(
    audit.hostReadinessReview,
    audit.verdict,
    planningDisposition,
    options,
  );
  return {
    version: audit.version,
    rubricVersion: audit.rubricVersion,
    verdict: audit.verdict,
    score: Number(audit.score),
    assessments,
    summary: text(audit.summary, "Role audit summary"),
    issues,
    repairInstructions,
    ...(planningDisposition !== undefined ? { planningDisposition } : {}),
    hostReadinessReview,
  };
}

const ROLE_AUDIT_DIMENSION_NAMES: readonly RoleAuditDimension[] = [
  ...REPORT_AUDIT_DIMENSIONS,
  ...CREATIVE_AUDIT_DIMENSIONS,
];

// 审计 C3 的非补偿归约：总分等于全部维度分的最低分，八条选题里七条较好不能把一条很差的
// 平均掉。分数仍由宿主算，模型自己报的数必须与归约一致，否则拒收。
function validateRoleAuditAssessments(
  value: unknown,
  score: number,
  options: { role?: string; candidate?: unknown },
): RoleAuditAssessment[] {
  const entries = array(value, "Role audit assessments", 12);
  if (entries.length < 1) throw new Error("Role audit assessments must not be empty.");
  const assessments = entries.map((entry, index): RoleAuditAssessment => {
    const item = record(entry, `Role audit assessments[${index}]`);
    const dimensions = array(item.dimensions, `Role audit assessments[${index}].dimensions`, 4)
      .map((dimensionEntry, dimensionIndex): RoleAuditAssessment["dimensions"][number] => {
        const dimension = record(dimensionEntry, `Role audit assessments[${index}].dimensions[${dimensionIndex}]`);
        if (!ROLE_AUDIT_DIMENSION_NAMES.includes(dimension.dimension as RoleAuditDimension)) {
          throw new Error(`Role audit assessments[${index}].dimensions[${dimensionIndex}].dimension is invalid.`);
        }
        if (!Number.isInteger(dimension.score) || Number(dimension.score) < 0 || Number(dimension.score) > 100) {
          throw new Error(`Role audit assessments[${index}].dimensions[${dimensionIndex}].score must be an integer between 0 and 100.`);
        }
        return {
          dimension: dimension.dimension as RoleAuditDimension,
          score: Number(dimension.score),
          evidence: text(dimension.evidence, `Role audit assessments[${index}].dimensions[${dimensionIndex}].evidence`),
        };
      });
    if (dimensions.length < 3) {
      throw new Error(`Role audit assessments[${index}] must carry at least 3 dimensions.`);
    }
    const names = dimensions.map((dimension) => dimension.dimension);
    if (new Set(names).size !== names.length) {
      throw new Error(`Role audit assessments[${index}] repeats a dimension.`);
    }
    return { targetPath: targetPathText(item.targetPath), dimensions };
  });
  const paths = assessments.map((assessment) => assessment.targetPath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Role audit assessments repeat a targetPath.");
  }
  const lowest = Math.min(...assessments.flatMap((assessment) => assessment.dimensions.map((dimension) => dimension.score)));
  if (score !== lowest) {
    throw new Error(`Role audit score must equal the lowest dimension score (${lowest}).`);
  }
  if (options.role !== undefined) validateRoleAuditTargets(assessments, options.role, options.candidate);
  return assessments;
}

// 评估对象和维度集合是宿主的判断，不是模型的：只接收 (kind, value) 的输出校验无从知道
// 本轮候选有几个、是什么角色。模型漏评一个候选、只评容易过的维度、或用报告维度评创作
// 交付，都在这里被拒。
function validateRoleAuditTargets(assessments: RoleAuditAssessment[], role: string, candidate: unknown): void {
  const plan = ROLE_AUDIT_ASSESSMENT_PLANS[role];
  if (plan === undefined) {
    throw new Error(`Role audit has no host assessment plan for role ${role}.`);
  }
  let items: unknown[] | undefined;
  if (plan.collection !== undefined) {
    const collection = (candidate as Record<string, unknown> | undefined)?.[plan.collection];
    items = Array.isArray(collection) ? collection : undefined;
  }
  // 合法空结果评的是"是否应该为空"这个判断本身，用报告型维度，不要求空集合制造吸引点。
  const expected = items === undefined || items.length === 0
    ? [{ targetPath: "", dimensions: plan.collection === undefined ? plan.dimensions : REPORT_AUDIT_DIMENSIONS }]
    : items.map((_, index) => ({ targetPath: `/${plan.collection}/${index}`, dimensions: plan.dimensions }));
  const actual = new Map(assessments.map((assessment) => [assessment.targetPath, assessment]));
  for (const target of expected) {
    const assessment = actual.get(target.targetPath);
    if (assessment === undefined) {
      throw new Error(`Role audit for ${role} is missing the assessment for "${target.targetPath}".`);
    }
    actual.delete(target.targetPath);
    const names = assessment.dimensions.map((dimension) => dimension.dimension);
    const missing = target.dimensions.filter((dimension) => !names.includes(dimension));
    const extra = names.filter((dimension) => !target.dimensions.includes(dimension));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Role audit for ${role} must score "${target.targetPath}" on ${target.dimensions.join(", ")}; missing ${missing.join(", ") || "none"}, unexpected ${extra.join(", ") || "none"}.`,
      );
    }
  }
  if (actual.size > 0) {
    throw new Error(`Role audit for ${role} scores objects the candidate does not have: ${[...actual.keys()].join(", ")}.`);
  }
}

function validateHostReadinessReview(
  value: unknown,
  verdict: RoleAudit["verdict"],
  planningDisposition: RoleAuditPlanningDisposition | null | undefined,
  options: { planningRole?: boolean; hostReadiness?: HostPlanningReadiness },
): NonNullable<RoleAudit["hostReadinessReview"]> | null {
  // 旧 checkpoint 和绕过 Broker 的历史测试可能没有该字段；规范化为 null。
  // 新物理请求由 Broker JSON Schema 强制显式输出该字段。
  if (value === undefined || value === null) return null;
  if (!options.planningRole || !options.hostReadiness) {
    throw new Error("Role audit hostReadinessReview is only valid for a planning role with host readiness evidence.");
  }
  const review = record(value, "Role audit hostReadinessReview");
  if (Object.keys(review).some((key) => key !== "misclassifiedIssueIds")) {
    throw new Error("Role audit hostReadinessReview contains an unknown field.");
  }
  const ids = array(review.misclassifiedIssueIds, "Role audit hostReadinessReview.misclassifiedIssueIds", 24)
    .map((entry, index) => text(entry, `Role audit hostReadinessReview.misclassifiedIssueIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Role audit hostReadinessReview.misclassifiedIssueIds must be unique.");
  }
  const available = new Set(options.hostReadiness.issues.map((issue) => issue.id));
  const unknown = ids.find((id) => !available.has(id));
  if (unknown) throw new Error(`Role audit hostReadinessReview references unknown host issue '${unknown}'.`);
  if (ids.length > 0 && (options.hostReadiness.status !== "needs_source"
    || verdict !== "repair" || planningDisposition?.action !== "revise_here")) {
    throw new Error("Misclassified host issues require a needs_source host result and a repair/revise_here audit.");
  }
  return { misclassifiedIssueIds: ids };
}

function allHostSourceIssuesMisclassified(
  hostReadiness: HostPlanningReadiness,
  audit: RoleAudit,
): boolean {
  if (hostReadiness.status !== "needs_source"
    || audit.verdict !== "repair"
    || audit.planningDisposition?.action !== "revise_here") return false;
  const blockingIds = hostReadiness.issues
    .filter((issue) => issue.target === "source" || issue.target === "user")
    .map((issue) => issue.id);
  if (blockingIds.length === 0) return false;
  const corrected = new Set(audit.hostReadinessReview?.misclassifiedIssueIds ?? []);
  return blockingIds.every((id) => corrected.has(id));
}

function revisionAuditForHost(
  audit: RoleAudit,
  hostReadiness: HostPlanningReadiness | undefined,
): RoleAudit {
  if (!hostReadiness || hostReadiness.status === "ready") return audit;
  const correctedIssueIds = new Set(audit.hostReadinessReview?.misclassifiedIssueIds ?? []);
  const hostIssues: RoleAuditIssue[] = hostReadiness.issues
    .filter((issue) => !correctedIssueIds.has(issue.id))
    .map((issue) => ({
      severity: "blocking",
      criterion: "宿主可执行性检查",
      evidence: issue.reason,
      repairInstruction: issue.requiredChange,
    }));
  if (hostIssues.length === 0) return audit;
  const issues = [...audit.issues, ...hostIssues];
  const issueIndexes = issues
    .map((issue, index) => issue.severity === "blocking" ? index : -1)
    .filter((index) => index >= 0);
  return {
    ...audit,
    verdict: "repair",
    score: Math.min(audit.score, 79),
    summary: `${audit.summary} 宿主检查要求当前角色先修正 ${hostIssues.length} 项仍有效的可执行性问题。`,
    issues,
    repairInstructions: [...new Set([
      ...audit.repairInstructions,
      ...hostIssues.map((issue) => issue.repairInstruction),
    ])],
    planningDisposition: { action: "revise_here", issueIndexes },
  };
}

function validatePlanningDisposition(
  value: unknown,
  issues: RoleAuditIssue[],
  verdict: RoleAudit["verdict"],
  planningRole: boolean,
): RoleAuditPlanningDisposition | null | undefined {
  if (!planningRole) {
    if (value === null) return null;
    if (value === undefined) return undefined;
    // 非规划角色的审计 payload 从未说明自己是不是规划角色，所以"非规划角色输出 null"这条
    // 指令对模型不可执行，它会顺着 repair 语境填一个 revise_here。而 revise_here 的语义是
    // "当前角色就地修"，与 verdict: repair 完全重合，不含任何越权路由；为此作废一整轮审计，
    // 丢掉的是已经抓到真实事实错误的那份结论。归一化为 null。needs_source/needs_user 才是
    // 真的把工作路由出当前角色，仍然拒绝。
    if (isRecordValue(value) && value.action === "revise_here") return null;
    throw new Error("Non-planning role audits cannot route work outside their role.");
  }
  if (verdict === "pass") {
    if (value !== null) throw new Error("Passing planning role audits must set planningDisposition to null.");
    return null;
  }
  const disposition = record(value, "Role audit planningDisposition");
  if (disposition.action !== "revise_here" && disposition.action !== "needs_source" && disposition.action !== "needs_user") {
    throw new Error("Role audit planningDisposition.action is invalid.");
  }
  const issueIndexes = array(disposition.issueIndexes, "Role audit planningDisposition.issueIndexes", 12);
  if (issueIndexes.length < 1) throw new Error("Role audit planningDisposition.issueIndexes must not be empty.");
  const normalized = issueIndexes.map((entry, index) => {
    if (!Number.isInteger(entry) || Number(entry) < 0 || Number(entry) >= issues.length) {
      throw new Error(`Role audit planningDisposition.issueIndexes[${index}] does not identify an existing issue.`);
    }
    return Number(entry);
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Role audit planningDisposition.issueIndexes must be unique.");
  }
  if (normalized.some((index) => issues[index]?.severity !== "blocking")) {
    throw new Error("Role audit planningDisposition can only identify blocking issues.");
  }
  return { action: disposition.action, issueIndexes: normalized };
}

function nonLocalPlanningDisposition(audit: RoleAudit | undefined): RoleAuditPlanningDisposition | undefined {
  const disposition = audit?.planningDisposition;
  return disposition && disposition.action !== "revise_here" ? disposition : undefined;
}

// 来源缺口的收口状态：独立审计已经判 pass，说明这份产出本身没有问题，缺的只是"材料当前拿不到"，
// 那就照常交付，把缺口当建议带上；审计没判 pass 时沿用 awaiting_user —— 产出与那一轮审计都留在
// checkpoint 里，停在创作者面前由他裁决，不替他判失败。
function terminalStatusForSourceGap(audit: RoleAudit): "passed" | "awaiting_user" {
  return audit.verdict === "pass" ? "passed" : "awaiting_user";
}

function planningHaltError<TOutput>(
  options: RoleAgentLoopOptions<TOutput>,
  state: PersistedLoopState,
  iterations: AgentLoopTrace["iterations"],
  disposition: RoleAuditPlanningDisposition,
): RoleAgentPlanningHaltError {
  const final = state.completed.at(-1);
  if (!final) throw new Error("Planning halt has no persisted candidate and audit.");
  const { producerModelCallCount, auditModelCallCount } = actualPhaseModelCallCounts(state);
  const trace: AgentLoopTrace = {
    version: "video-factory/agent-loop-v1",
    role: options.role,
    contractVersion: options.contractVersion,
    criteria: [...options.criteria],
    status: "failed",
    maxIterations: options.maxIterations,
    modelCallCount: producerModelCallCount + auditModelCallCount,
    producerModelCallCount,
    auditModelCallCount,
    producerMs: state.phaseDurationsMs.produce,
    auditMs: state.phaseDurationsMs.audit,
    validationMs: state.validationMs,
    structuredRepairModelCallCount: totalStructuredRepairModelCallCount(state),
    retryCount: state.retriedRequestIds.length,
    iterations,
  };
  const selected = disposition.issueIndexes.map((index) => final.audit.issues[index]!).filter(Boolean);
  const reason = selected.map((issue) => issue.evidence).join("；") || final.audit.summary;
  return new RoleAgentPlanningHaltError(
    disposition.action === "needs_source"
      ? `${options.role}需要当前流水线尚未具备的来源：${reason}`
      : `${options.role}需要用户确认会改变既定承诺或路线的决定：${reason}`,
    trace,
    structuredClone(disposition),
    structuredClone(final.candidate),
    structuredClone(final.audit),
    undefined,
    final.auditTrace ?? final.candidateTrace,
  );
}

function actualPhaseModelCallCounts(state: PersistedLoopState): {
  producerModelCallCount: number;
  auditModelCallCount: number;
} {
  const completedProducerExtra = state.completed.reduce(
    (total, item) => total + Math.max(0, (item.candidateTrace?.modelAttemptCount ?? 1) - 1),
    0,
  );
  const completedAuditExtra = state.completed.reduce(
    (total, item) => total + Math.max(0, (item.auditTrace?.modelAttemptCount ?? 1) - 1),
    0,
  );
  const pendingProducerExtra = state.pendingCandidate?.candidateTrace
    ? Math.max(0, (state.pendingCandidate.candidateTrace.modelAttemptCount ?? 1) - 1)
    : 0;
  return {
    producerModelCallCount: Math.max(0, state.phaseAttempts.produce - state.unacceptedPhaseAttempts.produce)
      + completedProducerExtra + pendingProducerExtra,
    auditModelCallCount: Math.max(0, state.phaseAttempts.audit - state.unacceptedPhaseAttempts.audit)
      + completedAuditExtra,
  };
}

function totalStructuredRepairModelCallCount(state: PersistedLoopState): number {
  const traceRepairs = state.completed.reduce(
    (total, item) => total
      + (item.candidateTrace?.structuredRepairCount ?? 0)
      + (item.auditTrace?.structuredRepairCount ?? 0),
    state.pendingCandidate?.candidateTrace?.structuredRepairCount ?? 0,
  );
  return state.structuredRepairModelCallCount + traceRepairs;
}

function safeBridgeDiagnostic(error: CodexBridgeError): string {
  const details = error.failureDetails;
  const parts = [
    `stage=${error.stage}`,
    ...(error.statusCode !== undefined ? [`httpStatus=${error.statusCode}`] : []),
    ...(error.failureKind ? [`failureKind=${error.failureKind}`] : []),
    ...(details ? [
      `reasonCode=${details.reasonCode}`,
      ...(details.fieldPath ? [`fieldPath=${details.fieldPath}`] : []),
      ...(details.taskKind ? [`taskKind=${details.taskKind}`] : []),
      ...(details.requestIdHash ? [`requestIdHash=${details.requestIdHash}`] : []),
      ...(details.accepted !== undefined ? [`accepted=${String(details.accepted)}`] : []),
    ] : []),
  ];
  return `\n诊断：${parts.join("；")}`;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} must be an array with at most ${maximum} entries.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

// 根路径 "" 是合法目标：创作交付评的是当前完整候选本身，不是它的某个子对象。
function targetPathText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Role audit assessment targetPath must be a string.");
  return value.trim();
}
