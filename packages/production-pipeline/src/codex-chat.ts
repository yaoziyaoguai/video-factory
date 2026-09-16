import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  TASK_BINDING_VERSION,
  brokerModelCandidates,
  parseBrokerBinding,
  parseTaskBinding,
  sameTaskBinding,
  taskBinding,
  taskBindingHeaders,
  type CodexBrokerBinding,
  type CodexTaskBinding,
} from "./codex-task-binding.js";

export const CODEX_BRIDGE_PROTOCOL_VERSION = "video-factory/codex-bridge-v2" as const;
export const REQUIRED_CODEX_TASK_CONTRACT_DIGESTS = {
  "topic-ideas": "bdae923579b878af2e99612cca071a661d3fd39f7c382a42442c36645b0e0f73",
  "series-roadmap": "7a6b2dcac3856e429bcaf4eef69c98ea9917b43ef0750b3b1cb1987dc42c48df",
  "creative-treatment": "ce01a42e3b9bbf84b97cdae810d498cf6514b94615c18856794cf6d34a754c8c",
  "director-plan": "1fb8d802d23bac9e21a0999a5774aceed3b3331a01ff229d462573f9b36696a7",
  "script-draft": "9fdfdc99e648aa0a0be779bc371d2e658cc9a550add46638c3df8f7bffc34d20",
  "publish-copy": "321a9b07d9eeb6bd1bb1e075a16c7d3bc65948983be11b3c082834aa8a030dd4",
  "asset-rank": "8693ee66be5e7db08d20c1847786e015734cda4f63d1c369f2141336dd31723b",
  "reference-grammar": "f14b46d1b3e675d21973b6f6ae8daf594b010409007473cdfaa5adbecb1dea8e",
  "visual-review": "7fc682f73d5750ae7776ec9e42f52a043c17e4258d95f368e03937b964e1b73a",
  "role-audit": "b7959cc68e5edef85fb9aafba755e55a6040234e80c5e1892f81ae7a4df20e1d",
  "creative-discussion": "e9197cfbf9705f74f1454f74ee0794708922ddf528c25eb45545212d8cf033af",
} as const satisfies Partial<Record<CodexTaskKind, string>>;

// 安全边界：kind 白名单是容器侧唯一能表达的任务意图；宿主机 broker 不接受 shell、command 或 cwd。
export const CODEX_TASK_KINDS = ["topic-ideas", "series-roadmap", "creative-treatment", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit", "creative-discussion"] as const;
export type CodexTaskKind = (typeof CODEX_TASK_KINDS)[number];

interface ModelCandidateAttemptBase {
  modelId: string;
  providerId: string;
}

export type ModelCandidateAttempt = ModelCandidateAttemptBase & (
  | {
    outcome: "succeeded";
    failureStage?: never;
    failureReason?: never;
  }
  | {
    outcome: "failed";
    failureStage: CodexBridgeFailureStage | "transport";
    failureReason: string;
  }
);

export interface CodexTaskTrace {
  taskKind: CodexTaskKind;
  promptVersion: string;
  contractDigest?: string;
  prompt: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  fallbackFromModelId?: string;
  fallbackReason?: string;
  attemptedModelIds?: string[];
  modelCandidateAttempts?: ModelCandidateAttempt[];
  queueWaitMs?: number;
  providerWaitMs?: number;
  firstOutputEventMs?: number;
  toolMs?: number;
  validationMs?: number;
  requestIdHash?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  retryCount?: number;
  modelAttemptCount?: number;
  structuredRepairCount?: number;
  requestPayloadBytes?: number;
  promptBytes?: number;
  imageCount?: number;
  imageBytes?: number;
  imageSetSha256?: string;
  imageMappingSha256?: string;
}

export interface CodexTaskSession {
  key: string;
  handle?: string;
}

export interface CodexTaskRequestOptions {
  timeoutMs?: number;
  beforeSubmit?: (operation: CodexPreparedOperation) => Promise<void>;
  /**
   * 本次任务要用的模型，必须是 broker 在 /health 里公告的已审核候选之一。
   * 它随信封的 brokerBinding.modelId 声明给 broker，而不是另开一个字段——模型本来
   * 就是任务绑定的一部分，绕开绑定另说一套会让 durable 重放看不出模型被换过。
   */
  model?: string;
}

export interface CodexPreparedOperation {
  version: "video-factory/codex-prepared-operation-v1";
  requestId: string;
  kind: CodexTaskKind;
  envelope: Record<string, unknown>;
  serializedEnvelope: string;
  binding: CodexTaskBinding;
  brokerBinding: CodexBrokerBinding;
  route: { socketPath: string };
  taskFact: "not_submitted" | "possibly_submitted" | "accepted" | "running" | "accepted_unknown";
  observationError?: { at: string; message: string };
}

// 任务事实阶段：not_accepted=确证未受理（可安全重试）；rejected=受理前被确定性拒绝
// （合同/校验，重发相同 payload 必然复现，必须停止并诊断）；conflict=请求身份与既有
// durable 记录冲突（禁止自动重试）；uncertain=已受理且结果未知；completed_failure=已受理
// 且确定性失败。rejected/conflict/uncertain 都不能触发新 requestId 或 backup。
export type CodexBridgeFailureStage = "not_accepted" | "completed_failure" | "uncertain" | "rejected" | "conflict";
export type CodexBridgeFailureKind = "model_provider_transient" | "model_provider_no_output" | "contract_rejected" | "binding_conflict";

export type ModelProviderFailureCategory =
  | "authentication"
  | "invalid_request"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "network"
  | "invalid_output"
  | "execution_failed";

export interface ModelProviderFailureDetails {
  category: ModelProviderFailureCategory;
  reasonCode: string;
  providerId: string;
  modelId: string;
  queueWaitMs?: number;
  providerWaitMs?: number;
  requestIdHash?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  fieldPath?: string;
  taskKind?: CodexTaskKind;
  accepted?: boolean;
  executionLayer?: "cli" | "provider_transport";
  processExitCode?: number;
  providerErrorCode?: "invalid_json_schema" | "invalid_request_error" | "unsupported_parameter";
  schemaKeyword?: "uniqueItems" | "required" | "additionalProperties";
  networkCode?: string;
  headersReceived?: boolean;
  localExecutionEnded?: boolean;
  remoteQueryable?: boolean;
  modelAttemptCount?: number;
  structuredRepairCount?: number;
}

export interface RoleAuditIssue {
  severity: "advisory" | "blocking";
  criterion: string;
  evidence: string;
  repairInstruction: string;
}

export type RoleAuditDimension =
  | "attention"
  | "progression"
  | "payoff"
  | "expression"
  | "evidence"
  | "coverage"
  | "consistency"
  | "actionability";

/** 审计对单个评估对象的维度分。维度集合由宿主按角色决定，模型不能自己挑。 */
export interface RoleAuditAssessment {
  /** 创作交付用根路径 ""；集合交付逐项用 "/ideas/0" 这样的路径。 */
  targetPath: string;
  dimensions: Array<{
    dimension: RoleAuditDimension;
    score: number;
    evidence: string;
  }>;
}

export interface RoleAudit {
  version: "video-factory/role-audit-v2";
  rubricVersion: string;
  verdict: "pass" | "repair";
  /** 归约值，等于全部 dimension.score 的最低分；没有依据的单一标量不再作为质量信号。 */
  score: number;
  assessments: RoleAuditAssessment[];
  summary: string;
  issues: RoleAuditIssue[];
  repairInstructions: string[];
  planningDisposition?: RoleAuditPlanningDisposition | null;
  hostReadinessReview?: {
    misclassifiedIssueIds: string[];
  } | null;
}

export interface RoleAuditPlanningDisposition {
  action: "revise_here" | "needs_source" | "needs_user";
  issueIndexes: number[];
}

export interface AgentLoopHostPlanningReadiness {
  status: "ready" | "revise_here" | "needs_source";
  issues: Array<{
    id: string;
    target: "script" | "director" | "source" | "user";
    beatIds: string[];
    scenePositions: number[];
    reason: string;
    requiredChange: string;
    evidenceArtifactIds: string[];
  }>;
}

export interface AgentLoopIterationTrace {
  iteration: number;
  candidate: unknown;
  candidateHash: string;
  candidateTrace?: CodexTaskTrace;
  auditTrace?: CodexTaskTrace;
  audit: RoleAudit;
  hostReadiness?: AgentLoopHostPlanningReadiness;
}

export interface AgentLoopPendingCandidateTrace {
  iteration: number;
  candidate: unknown;
  candidateHash: string;
  candidateTrace?: CodexTaskTrace;
}

export interface AgentLoopTrace {
  version: "video-factory/agent-loop-v1";
  role: string;
  contractVersion: string;
  criteria: string[];
  // awaiting_user：产出与那一轮自动审计都已完成，循环停在用户面前等裁决。
  // 它既不是"通过"（审计没判 pass），也不是"失败"（没有任何东西坏掉）。
  status: "passed" | "awaiting_user" | "failed";
  maxIterations: number;
  modelCallCount?: number;
  producerModelCallCount?: number;
  auditModelCallCount?: number;
  structuredRepairModelCallCount?: number;
  producerMs?: number;
  auditMs?: number;
  validationMs?: number;
  retryCount?: number;
  failure?: {
    stage: CodexBridgeFailureStage;
    statusCode?: number;
    failureKind?: CodexBridgeFailureKind;
    details?: ModelProviderFailureDetails;
  };
  iterations: AgentLoopIterationTrace[];
  pendingCandidate?: AgentLoopPendingCandidateTrace;
}

export interface CodexTaskExecution<TOutput = unknown> {
  output: TOutput;
  trace?: CodexTaskTrace;
  agentLoop?: AgentLoopTrace;
  session?: CodexTaskSession;
}

export type CodexPreparedObservation =
  | { state: "running" | "accepted_unknown" | "not_accepted" | "conflict" }
  | { state: "query_failure"; observationError: string }
  | { state: "completed_success"; execution: CodexTaskExecution }
  | { state: "completed_failure"; error: CodexBridgeError };

const TASK_PATH = "/v1/tasks";
// 只有"确证发生在任务受理之前"的连接错误才可安全重试；中途断连无法证明未受理，不重放。
const RETRYABLE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT"]);
// 单并发 broker 中，生产任务最多等待一个正在执行的后台任务，再获得完整执行时限。
const DEFAULT_TIMEOUT_MS = 660_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const submissionObservationErrors = new WeakSet<CodexBridgeError>();

export class CodexBridgeError extends Error {
  readonly creatorMessage: string;
  readonly failureDetails: ModelProviderFailureDetails | undefined;

  constructor(
    message: string,
    readonly transient: boolean,
    readonly stage: CodexBridgeFailureStage = transient ? "not_accepted" : "uncertain",
    readonly statusCode?: number,
    readonly failureKind?: CodexBridgeFailureKind,
    failureDetails?: ModelProviderFailureDetails,
  ) {
    super(message);
    this.name = "CodexBridgeError";
    this.failureDetails = failureDetails;
    this.creatorMessage = creatorMessageFor(message, this.stage, failureDetails, statusCode, failureKind);
  }
}

// transient=true 仅表示"可安全重试"：失败确证发生在任务被受理之前。
// 超时与一切执行期错误都是 terminal，避免重复消耗有限的模型额度。

export interface CodexBridgeClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  /** accept/poll 轮询间隔；生产默认 1s，测试可调小。 */
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class CodexBridgeClient {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CodexBridgeClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.sleep = options.sleep ?? defaultSleep;
  }

  // 至多执行一次：仅连接层 ENOENT/ECONNREFUSED 与 HTTP 503（队列拒绝，未受理）按指数退避有界重试；
  // 超时与执行期失败直接上抛，绝不重放已受理的任务。
  async runTask(
    kind: CodexTaskKind,
    payload: unknown,
    requestId?: string,
    requestOptions?: CodexTaskRequestOptions,
  ): Promise<unknown> {
    return (await this.runTaskDetailed(kind, payload, requestId, undefined, requestOptions)).output;
  }

  async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string = randomUUID(),
    session?: CodexTaskSession,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    if (!isCodexTaskKind(kind)) {
      throw new CodexBridgeError(`Unsupported codex task kind '${String(kind)}'.`, false);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      throw new CodexBridgeError("Codex bridge requestId is invalid.", false);
    }
    if (session !== undefined) validateTaskSession(session);
    const expectedContractDigest = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind as keyof typeof REQUIRED_CODEX_TASK_CONTRACT_DIGESTS];
    const requestTimeoutMs = requestOptions.timeoutMs === undefined
      ? this.timeoutMs
      : positiveRequestTimeout(requestOptions.timeoutMs);
    const deadlineAtMs = Date.now() + requestTimeoutMs;
    const baseEnvelope = taskEnvelope(kind, payload, requestId, session, expectedContractDigest);
    // 指定模型时也必须走 prepared 路径：模型是通过信封里的 brokerBinding 声明的，裸信封
    // 不声明模型，broker 会当作没有覆盖——用户以为换了模型，实际跑的还是默认模型。
    let prepared = requestOptions.beforeSubmit || requestOptions.model !== undefined
      ? await this.prepareOperation(
        kind,
        payload,
        requestId,
        session,
        expectedContractDigest,
        Math.max(1, deadlineAtMs - Date.now()),
        requestOptions.model,
      )
      : undefined;
    if (prepared && requestOptions.beforeSubmit) await requestOptions.beforeSubmit(structuredClone(prepared));
    let acceptedOperation: CodexPreparedOperation | undefined;
    let lastError: CodexBridgeError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) throw requestDeadlineError(requestTimeoutMs);
        const envelope = prepared?.envelope ?? baseEnvelope;
        const serializedEnvelope = prepared?.serializedEnvelope ?? JSON.stringify(envelope);
        const submission = await this.submit(
          serializedEnvelope,
          requestId,
          kind,
          session,
          remainingMs,
          expectedContractDigest,
          prepared?.binding,
        );
        if (submission.kind === "completed") return submission.execution;
        const accepted = prepared
          ? { ...prepared, binding: submission.binding, taskFact: "accepted" as const }
          : preparedFromAccepted(this.options.socketPath, envelope, serializedEnvelope, submission.binding);
        acceptedOperation = accepted;
        return await this.awaitOutcome(accepted, session?.key, expectedContractDigest, deadlineAtMs);
      } catch (error) {
        if (!(error instanceof CodexBridgeError)) throw error;
        if (!error.transient) {
          // POST 可能已送达却丢失回包：先根据原始快照取得可验绑定，只查询原任务。
          if (error.stage === "uncertain" && !acceptedOperation && submissionObservationErrors.has(error)) {
            try {
              prepared ??= await this.prepareObservationAfterLostResponse(
                kind,
                baseEnvelope,
                requestId,
                session,
                expectedContractDigest,
                Math.max(1, deadlineAtMs - Date.now()),
                // 丢包后重建的绑定必须带上同一个模型：不重建就等于换了一个绑定，
                // 查询原任务会被 broker 判成 conflict。
                requestOptions.model,
              );
              prepared.taskFact = "possibly_submitted";
              return await this.awaitOutcome(prepared, session?.key, expectedContractDigest, deadlineAtMs);
            } catch (observationError) {
              if (observationError instanceof CodexBridgeError) throw observationError;
            }
          }
          throw error;
        }
        if (attempt === this.maxAttempts) throw error;
        lastError = error;
        const retryDelayMs = this.retryDelayMs * 2 ** (attempt - 1);
        if (retryDelayMs >= deadlineAtMs - Date.now()) throw requestDeadlineError(requestTimeoutMs);
        await this.sleep(retryDelayMs);
      }
    }
    throw lastError ?? new CodexBridgeError("Codex bridge request failed.", false);
  }

  async prepareTask(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string = randomUUID(),
    session?: CodexTaskSession,
    timeoutMs: number = this.timeoutMs,
  ): Promise<CodexPreparedOperation> {
    if (!isCodexTaskKind(kind)) throw new CodexBridgeError(`Unsupported codex task kind '${String(kind)}'.`, false);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new CodexBridgeError("Codex bridge requestId is invalid.", false);
    if (session) validateTaskSession(session);
    const expectedContractDigest = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind as keyof typeof REQUIRED_CODEX_TASK_CONTRACT_DIGESTS];
    return this.prepareOperation(kind, payload, requestId, session, expectedContractDigest, timeoutMs);
  }

  async observePrepared(
    operation: CodexPreparedOperation,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    validatePreparedOperation(operation, this.options.socketPath);
    const timeoutMs = requestOptions.timeoutMs === undefined ? this.timeoutMs : positiveRequestTimeout(requestOptions.timeoutMs);
    const session = taskSessionFromEnvelope(operation.envelope);
    return this.awaitOutcome(
      structuredClone(operation),
      session?.key,
      operation.binding.contractDigest ?? undefined,
      Date.now() + timeoutMs,
    );
  }

  // 用户主动查询只读取一次 durable 状态。running 是可信任务事实，不应被一个短 UI
  // 查询期限包装成超时或断连；查询本身失败也与原任务事实分开返回。
  async observePreparedOnce(
    operation: CodexPreparedOperation,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexPreparedObservation> {
    validatePreparedOperation(operation, this.options.socketPath);
    const timeoutMs = requestOptions.timeoutMs === undefined ? this.timeoutMs : positiveRequestTimeout(requestOptions.timeoutMs);
    let observation: QueryObservation;
    try {
      observation = await this.query(operation, timeoutMs);
    } catch (error) {
      return {
        state: "query_failure",
        observationError: error instanceof Error ? error.message : "Codex bridge query failed.",
      };
    }
    if (observation.kind !== "completed") return observation.kind === "query_failure"
      ? { state: "query_failure", observationError: "Codex broker did not return a readable task state." }
      : { state: observation.kind };
    try {
      const envelope = parseJsonOrThrow(observation.raw, "Codex bridge query returned a non-JSON response body.");
      if (typeof envelope !== "object" || envelope === null) {
        return { state: "query_failure", observationError: "Codex bridge query response must be an object." };
      }
      const queryRecord = envelope as Record<string, unknown>;
      validateResponseIdentity(queryRecord, operation);
      if (queryRecord.state === "completed_success" && queryRecord.ok === true) {
        const session = taskSessionFromEnvelope(operation.envelope);
        return {
          state: "completed_success",
          execution: parseEnvelope(
            observation.raw,
            session?.key,
            operation.binding.contractDigest ?? undefined,
            operation,
          ),
        };
      }
      if (queryRecord.state === "completed_failure") {
        return {
          state: "completed_failure",
          error: completedFailureError((queryRecord.outcome ?? {}) as Record<string, unknown>),
        };
      }
      return { state: "query_failure", observationError: "Codex broker returned an unrecognized task state." };
    } catch (error) {
      if (error instanceof CodexBridgeError && error.stage === "conflict") return { state: "conflict" };
      return {
        state: "query_failure",
        observationError: error instanceof Error ? error.message : "Codex bridge query response is invalid.",
      };
    }
  }

  private async prepareOperation(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string,
    session: CodexTaskSession | undefined,
    expectedContractDigest: string | undefined,
    timeoutMs: number,
    model?: string,
  ): Promise<CodexPreparedOperation> {
    const brokerBinding = await this.readBrokerBinding(kind, payload, timeoutMs, model);
    const envelope = taskEnvelope(kind, payload, requestId, session, expectedContractDigest, brokerBinding);
    const serializedEnvelope = JSON.stringify(envelope);
    return {
      version: "video-factory/codex-prepared-operation-v1",
      requestId,
      kind,
      envelope,
      serializedEnvelope,
      binding: taskBinding({ request: envelope, broker: brokerBinding, kind, ...(expectedContractDigest ? { contractDigest: expectedContractDigest } : {}), ...(session ? { session } : {}) }),
      brokerBinding,
      route: { socketPath: this.options.socketPath },
      taskFact: "not_submitted",
    };
  }

  private async prepareObservationAfterLostResponse(
    kind: CodexTaskKind,
    envelope: Record<string, unknown>,
    requestId: string,
    session: CodexTaskSession | undefined,
    expectedContractDigest: string | undefined,
    timeoutMs: number,
    model?: string,
  ): Promise<CodexPreparedOperation> {
    const brokerBinding = await this.readBrokerBinding(kind, envelope.payload, timeoutMs, model);
    const serializedEnvelope = JSON.stringify(envelope);
    return {
      version: "video-factory/codex-prepared-operation-v1",
      requestId,
      kind,
      envelope,
      serializedEnvelope,
      binding: taskBinding({ request: envelope, broker: brokerBinding, kind, ...(expectedContractDigest ? { contractDigest: expectedContractDigest } : {}), ...(session ? { session } : {}) }),
      brokerBinding,
      route: { socketPath: this.options.socketPath },
      taskFact: "possibly_submitted",
    };
  }

  // 观察原任务直到完成或截止：查询失败不改变任务事实（accepted/unknown 保持 unknown），
  // 只有 Broker 权威确认 not_accepted 才抛出 transient 错误交还给有界重试。
  private async awaitOutcome(
    operation: CodexPreparedOperation,
    sessionKey: string | undefined,
    expectedContractDigest: string | undefined,
    deadlineAtMs: number,
  ): Promise<CodexTaskExecution> {
    for (;;) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        throw new CodexBridgeError(
          `Codex task '${operation.requestId}' is still running after the wait deadline; its outcome stays accepted/unknown and will not be resubmitted.`,
          false,
          "uncertain",
          undefined,
          "model_provider_no_output",
        );
      }
      let observation: QueryObservation;
      try {
        observation = await this.query(operation, Math.min(remainingMs, this.pollIntervalMs * 10));
      } catch (error) {
        // 查询自身的 transport/超时失败：原任务事实不变，继续在截止时间内轮询。
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (observation.kind === "running" || observation.kind === "accepted_unknown") {
        operation.taskFact = observation.kind;
        if (observation.kind === "accepted_unknown" && observation.localExecutionEnded) {
          throw new CodexBridgeError(
            "The local execution ended but the remote result remains unknown; automatic observation has stopped.",
            false, "uncertain", undefined, "model_provider_no_output", observation.failureDetails,
          );
        }
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (observation.kind === "not_accepted") {
        if (observation.error) throw observation.error;
        throw new CodexBridgeError(
          `Codex bridge proved task '${operation.requestId}' was not accepted.`,
          true,
          "not_accepted",
          404,
          "model_provider_transient",
        );
      }
      if (observation.kind === "conflict") {
        throw new CodexBridgeError(
          `Codex bridge query for task '${operation.requestId}' reports a binding conflict.`,
          false,
          "conflict",
          409,
          "binding_conflict",
        );
      }
      if (observation.kind === "query_failure") {
        // 查询自身的失败不是任务事实：在截止时间内继续轮询原任务。
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      const envelope = parseJsonOrThrow(observation.raw, "Codex bridge query returned a non-JSON response body.");
      if (typeof envelope !== "object" || envelope === null) {
        throw new CodexBridgeError("Codex bridge query response must be an object.", false);
      }
      const queryRecord = envelope as Record<string, unknown>;
      validateResponseIdentity(queryRecord, operation);
      if (queryRecord.state !== "completed_success" && queryRecord.state !== "completed_failure") {
        // 既不是 running 也不是合法完成信封：按查询故障处理，不改变任务事实。
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (queryRecord.ok === true) {
        return parseEnvelope(observation.raw, sessionKey, expectedContractDigest, operation);
      }
      const outcome = (queryRecord.outcome ?? {}) as Record<string, unknown>;
      throw completedFailureError(outcome);
    }
  }

  // POST /v1/tasks：durable acceptance 后返回 202（accepted）；若该 requestId 已有
  // durable completed record，则直接重放 200 outcome。
  private submit(
    body: string,
    requestId: string,
    kind: CodexTaskKind,
    session: CodexTaskSession | undefined,
    timeoutMs: number,
    expectedContractDigest?: string,
    expectedBinding?: CodexTaskBinding,
  ): Promise<{ kind: "accepted"; binding: CodexTaskBinding } | { kind: "completed"; execution: CodexTaskExecution }> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.options.socketPath,
        path: TASK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let oversized = false;
        response.on("data", (chunk: Buffer) => {
          if (oversized) return;
          received += chunk.length;
          if (received > this.maxResponseBytes) {
            oversized = true;
            request.destroy();
            const error = new CodexBridgeError(`Codex bridge response exceeds ${this.maxResponseBytes} bytes.`, false);
            submissionObservationErrors.add(error);
            reject(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => {
          const mapped = mapTransportError(error, this.options.socketPath, this.timeoutMs);
          if (mapped.stage === "uncertain") submissionObservationErrors.add(mapped);
          reject(mapped);
        });
        response.on("end", () => {
          if (oversized) return;
          const status = response.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (status === 202) {
            try {
              const binding = bindingFromResponse(raw, {
                requestId,
                kind,
                request: JSON.parse(body),
                session,
                expectedContractDigest,
                ...(expectedBinding ? { expectedBinding } : {}),
              });
              resolve({ kind: "accepted", binding });
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (status === 200) {
            try {
              const operation = operationFromResponse(
                this.options.socketPath,
                raw,
                body,
                requestId,
                kind,
                session,
                expectedContractDigest,
                expectedBinding,
              );
              const replayRecord = JSON.parse(raw) as Record<string, unknown>;
              if (replayRecord.ok !== true) {
                // 200 也可能是重放已终结的失败信封（state=completed_failure）。按成功信封解析
                // 会抛出 ok/output 缺失，把原始 reasonCode/fieldPath 诊断换成通用错误。
                if (operation) validateResponseIdentity(replayRecord, operation);
                if (replayRecord.state === "completed_failure") {
                  reject(completedFailureError((replayRecord.outcome ?? {}) as Record<string, unknown>));
                  return;
                }
                reject(new CodexBridgeError("Codex bridge response envelope is missing ok/output.", false));
                return;
              }
              resolve({
                kind: "completed",
                execution: parseEnvelope(
                  raw,
                  session?.key,
                  expectedContractDigest,
                  operation,
                  (JSON.parse(body) as Record<string, unknown>).payload,
                ),
              });
            } catch (error) {
              reject(error);
            }
            return;
          }
          const error = mapFailureResponse(status, raw);
          if (error.stage === "uncertain") submissionObservationErrors.add(error);
          reject(error);
        });
      });
      request.on("error", (error) => {
        const mapped = mapTransportError(error, this.options.socketPath, timeoutMs);
        if (mapped.stage === "uncertain") submissionObservationErrors.add(mapped);
        reject(mapped);
      });
      request.end(body);
    });
  }

  // GET /v1/tasks/:requestId：只读观察原 durable 任务。
  private query(operation: CodexPreparedOperation, timeoutMs: number): Promise<QueryObservation> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.options.socketPath,
        path: `${TASK_PATH}/${encodeURIComponent(operation.requestId)}`,
        method: "GET",
        headers: { accept: "application/json", ...taskBindingHeaders(operation.binding) },
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        const chunks: Buffer[] = [];
        let oversized = false;
        response.on("data", (chunk: Buffer) => {
          if (oversized) return;
          if (chunks.reduce((total, item) => total + item.length, 0) > this.maxResponseBytes) {
            oversized = true;
            request.destroy();
            reject(new CodexBridgeError(`Codex bridge response exceeds ${this.maxResponseBytes} bytes.`, false));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, this.timeoutMs)));
        response.on("end", () => {
          if (oversized) return;
          const status = response.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (status === 200) {
            try {
              const state = parseJsonOrThrow(raw, "Codex bridge query returned a non-JSON response body.");
              if (typeof state !== "object" || state === null) {
                reject(new CodexBridgeError("Codex bridge query response must be an object.", false));
                return;
              }
              const record = state as Record<string, unknown>;
              if (record.state === "running" || record.state === "accepted_unknown") {
                try {
                  validateResponseIdentity(record, operation);
                  resolve(record.state === "running" ? { kind: "running" } : {
                    kind: "accepted_unknown",
                    localExecutionEnded: typeof record.localExecutionEndedAt === "string" && Number.isFinite(Date.parse(record.localExecutionEndedAt)),
                    failureDetails: bridgeFailureDetails(raw),
                  });
                } catch (error) {
                  reject(error);
                }
                return;
              }
              if (record.state === "not_accepted") {
                try {
                  validateResponseIdentity(record, operation);
                  resolve({ kind: "not_accepted", ...(record.status === 503 ? { error: mapFailureResponse(503, raw) } : {}) });
                } catch (error) {
                  reject(error);
                }
                return;
              }
              resolve({ kind: "completed", status: 200, raw });
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (status === 404) {
            resolve({ kind: "query_failure" });
            return;
          }
          if (status === 409 && raw.includes("binding_conflict")) {
            resolve({ kind: "conflict" });
            return;
          }
          // 查询端点的任务完成信封固定使用 200；其余 HTTP 状态只是本次观察失败，
          // 不能把 5xx/错误路由响应当作原任务终态解析。
          resolve({ kind: "query_failure" });
        });
      });
      request.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, timeoutMs)));
      request.end();
    });
  }

  private readBrokerBinding(
    kind: CodexTaskKind,
    payload: unknown,
    timeoutMs: number,
    modelOverride?: string,
  ): Promise<CodexBrokerBinding> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.options.socketPath,
        path: "/health",
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received <= this.maxResponseBytes) chunks.push(chunk);
        });
        response.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, timeoutMs)));
        response.on("end", () => {
          if (received > this.maxResponseBytes) {
            reject(new CodexBridgeError(`Codex broker health response exceeds ${this.maxResponseBytes} bytes.`, false, "conflict"));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new CodexBridgeError("Codex broker identity could not be verified before submission.", false, "conflict", response.statusCode));
            return;
          }
          try {
            const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const binding = parseBrokerBinding(report, kind, payload);
            // "要的就是 broker 自己的模型"不是覆盖，必须先归一化再查候选表：broker 侧同样先归一化，
            // 两边不一致就会出现候选表为空的 broker 拒绝一次对自己默认模型的显式请求。
            if (modelOverride === undefined || modelOverride === binding.modelId) {
              resolve(binding);
              return;
            }
            const candidates = brokerModelCandidates(report);
            if (!candidates.includes(modelOverride)) {
              reject(new CodexBridgeError(
                `Codex broker does not offer model '${modelOverride}' as a reviewed candidate.`,
                false,
                "rejected",
                400,
                "contract_rejected",
              ));
              return;
            }
            resolve({ ...binding, modelId: modelOverride });
          } catch (error) {
            reject(new CodexBridgeError(error instanceof Error ? error.message : "Codex broker identity is invalid.", false, "conflict"));
          }
        });
      });
      request.on("error", (error) => reject(mapTransportError(error, this.options.socketPath, timeoutMs)));
      request.end();
    });
  }

  private consume(): void {
    // 已被 submit()/query() 的内联处理取代；保留占位以满足历史调用方引用检查。
  }
}

type QueryObservation =
  | { kind: "running" }
  | { kind: "accepted_unknown"; localExecutionEnded?: boolean; failureDetails?: ModelProviderFailureDetails | undefined }
  | { kind: "not_accepted"; error?: CodexBridgeError }
  | { kind: "conflict" }
  | { kind: "query_failure" }
  | { kind: "completed"; status: number; raw: string };

// 非 200 响应 → 结构化失败：400=受理前合同拒绝（rejected）；409 binding conflict=冲突；
// 409 未知会话=确证未受理；503=队列拒绝未受理；422=已受理且确定性失败；其余=uncertain。
function mapFailureResponse(status: number, raw: string): CodexBridgeError {
  const failureKind = bridgeFailureKind(raw) ?? bodyFailureKind(raw);
  if (status === 400) {
    return new CodexBridgeError(
      `Codex bridge returned HTTP ${status}.${errorDetail(raw)}`,
      false,
      "rejected",
      status,
      failureKind ?? "contract_rejected",
      bridgeFailureDetails(raw),
    );
  }
  if (status === 409 && bodyFailureKind(raw) === "binding_conflict") {
    return new CodexBridgeError(
      `Codex bridge returned HTTP ${status}.${errorDetail(raw)}`,
      false,
      "conflict",
      status,
      "binding_conflict",
      bridgeFailureDetails(raw),
    );
  }
  if (status === 409 && bodyTaskState(raw) === "not_accepted") {
    return new CodexBridgeError(
      `Codex bridge returned HTTP ${status}.${errorDetail(raw)}`,
      true,
      "not_accepted",
      status,
      failureKind,
      bridgeFailureDetails(raw),
    );
  }
  const retryable = status === 503;
  const notAccepted = retryable || isUnknownRoleSessionRejection(status, raw);
  return new CodexBridgeError(
    `Codex bridge returned HTTP ${status}.${errorDetail(raw)}`,
    retryable,
    notAccepted ? "not_accepted" : status === 422 ? "completed_failure" : "uncertain",
    status,
    failureKind,
    bridgeFailureDetails(raw),
  );
}

function bodyTaskState(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    return typeof parsed.state === "string" ? parsed.state : undefined;
  } catch {
    return undefined;
  }
}

function bodyFailureKind(raw: string): CodexBridgeFailureKind | undefined {
  try {
    const parsed = JSON.parse(raw) as { failureKind?: unknown };
    if (parsed.failureKind === "binding_conflict") return "binding_conflict";
    if (parsed.failureKind === "contract_rejected") return "contract_rejected";
    return undefined;
  } catch {
    return undefined;
  }
}

export function requestOptionsForDeadline(deadlineAtMs: number | undefined): CodexTaskRequestOptions | undefined {
  if (deadlineAtMs === undefined) return undefined;
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1) {
    throw new CodexBridgeError("Text agent wall-clock deadline is invalid.", false, "not_accepted");
  }
  if (deadlineAtMs <= Date.now()) throw requestDeadlineError(0);
  // 这是新阶段的准入截止时间，不截断已经交给 durable broker 的同一 requestId。
  // 已受理任务仍由客户端自身的单次超时有界等待，避免结果稍晚返回时被误判失败。
  return undefined;
}

function positiveRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CodexBridgeError("Codex bridge request timeout must be a positive integer.", false, "not_accepted");
  }
  return value;
}

function requestDeadlineError(timeoutMs: number): CodexBridgeError {
  return new CodexBridgeError(`Text agent wall-clock deadline exhausted after ${timeoutMs}ms.`, false, "not_accepted");
}

function parseEnvelope(
  raw: string,
  sessionKey?: string,
  expectedContractDigest?: string,
  operation?: CodexPreparedOperation,
  submittedPayload?: unknown,
): CodexTaskExecution {
  const envelope = parseJsonOrThrow(raw, "Codex bridge returned a non-JSON response body.");
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new CodexBridgeError("Codex bridge response envelope must be an object.", false);
  }
  const record = envelope as Record<string, unknown>;
  if (operation) validateResponseIdentity(record, operation);
  if (record.ok !== true || typeof record.output !== "string") {
    throw new CodexBridgeError("Codex bridge response envelope is missing ok/output.", false);
  }
  if (record.sessionHandle !== undefined
    && (sessionKey === undefined
      || typeof record.sessionHandle !== "string"
      || !isOpaqueSessionHandle(record.sessionHandle))) {
    throw new CodexBridgeError("Codex bridge response session handle is invalid.", false);
  }
  const output = parseJsonOrThrow(stripCodeFence(record.output), "Codex bridge output is not valid JSON.");
  const parsedTrace = record.trace === undefined ? undefined : parseTrace(record.trace);
  const requestPayload = operation?.envelope.payload ?? submittedPayload;
  const trace = parsedTrace && requestPayload !== undefined
    ? { ...parsedTrace, ...requestDiagnostics(requestPayload, parsedTrace.prompt) }
    : parsedTrace;
  if (operation && (!trace
    || trace.taskKind !== operation.kind
    || trace.providerId !== operation.binding.providerId
    || trace.modelId !== operation.binding.modelId
    || trace.contractDigest !== (operation.binding.contractDigest ?? undefined))) {
    throw new CodexBridgeError(
      "Codex bridge result trace does not match the immutable task binding.",
      false,
      "conflict",
      409,
      "binding_conflict",
    );
  }
  if (expectedContractDigest && trace?.contractDigest !== expectedContractDigest) {
    throw new CodexBridgeError("Codex bridge task contract does not match the requested contract.", false, "uncertain");
  }
  return {
    output,
    ...(trace ? { trace } : {}),
    ...(sessionKey && typeof record.sessionHandle === "string"
      ? { session: { key: sessionKey, handle: record.sessionHandle } }
      : {}),
  };
}

function requestDiagnostics(
  payload: unknown,
  prompt: string,
): Pick<CodexTaskTrace, "requestPayloadBytes" | "promptBytes" | "imageCount" | "imageBytes" | "imageSetSha256" | "imageMappingSha256"> {
  const base = {
    requestPayloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
  };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return base;
  const record = payload as Record<string, unknown>;
  const images = [record.frames, record.images, record.thumbnails]
    .find((value): value is unknown[] => Array.isArray(value));
  if (!images?.length) return base;
  const normalized = images.flatMap((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const image = value as Record<string, unknown>;
    const jpegBase64 = typeof image.jpegBase64 === "string" ? image.jpegBase64 : undefined;
    if (!jpegBase64) return [];
    const sha256 = typeof image.sha256 === "string" && /^[a-f0-9]{64}$/.test(image.sha256)
      ? image.sha256
      : createHash("sha256").update(Buffer.from(jpegBase64, "base64")).digest("hex");
    return [{
      bytes: Buffer.from(jpegBase64, "base64").byteLength,
      sha256,
      mapping: {
        index,
        ...(Number.isInteger(image.imageIndex) ? { imageIndex: image.imageIndex } : {}),
        ...(Number.isInteger(image.scenePosition) ? { scenePosition: image.scenePosition } : {}),
        ...(Number.isInteger(image.timecodeMs) ? { timecodeMs: image.timecodeMs } : {}),
        ...(Number.isInteger(image.sourceTimecodeMs) ? { sourceTimecodeMs: image.sourceTimecodeMs } : {}),
        ...(typeof image.phase === "string" ? { phase: image.phase } : {}),
      },
    }];
  });
  if (!normalized.length) return base;
  return {
    ...base,
    imageCount: normalized.length,
    imageBytes: normalized.reduce((total, image) => total + image.bytes, 0),
    imageSetSha256: createHash("sha256").update(JSON.stringify(normalized.map((image) => image.sha256))).digest("hex"),
    imageMappingSha256: createHash("sha256").update(JSON.stringify(normalized.map((image) => image.mapping))).digest("hex"),
  };
}

function taskEnvelope(
  kind: CodexTaskKind,
  payload: unknown,
  requestId: string,
  session: CodexTaskSession | undefined,
  expectedContractDigest: string | undefined,
  brokerBinding?: CodexBrokerBinding,
): Record<string, unknown> {
  return {
    protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION,
    requestId,
    kind,
    payload,
    ...(expectedContractDigest ? { expectedContractDigest } : {}),
    ...(session ? { sessionKey: session.key, ...(session.handle ? { sessionHandle: session.handle } : {}) } : {}),
    ...(brokerBinding ? { brokerBinding } : {}),
  };
}

function taskSessionFromEnvelope(envelope: Record<string, unknown>): CodexTaskSession | undefined {
  if (typeof envelope.sessionKey !== "string") return undefined;
  return {
    key: envelope.sessionKey,
    ...(typeof envelope.sessionHandle === "string" ? { handle: envelope.sessionHandle } : {}),
  };
}

function preparedFromAccepted(
  socketPath: string,
  envelope: Record<string, unknown>,
  serializedEnvelope: string,
  binding: CodexTaskBinding,
): CodexPreparedOperation {
  return {
    version: "video-factory/codex-prepared-operation-v1",
    requestId: String(envelope.requestId),
    kind: String(envelope.kind) as CodexTaskKind,
    envelope: structuredClone(envelope),
    serializedEnvelope,
    binding,
    brokerBinding: {
      version: binding.version,
      storeId: binding.storeId,
      providerId: binding.providerId,
      modelId: binding.modelId,
    },
    route: { socketPath },
    taskFact: "accepted",
  };
}

function bindingFromResponse(
  raw: string,
  expected: {
    requestId: string;
    kind: CodexTaskKind;
    request: unknown;
    session: CodexTaskSession | undefined;
    expectedContractDigest: string | undefined;
    expectedBinding?: CodexTaskBinding;
  },
): CodexTaskBinding {
  const value = parseJsonOrThrow(raw, "Codex bridge task response is not valid JSON.");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexBridgeError("Codex bridge task response must be an object.", false, "conflict");
  }
  const record = value as Record<string, unknown>;
  if (record.requestId !== expected.requestId) {
    throw new CodexBridgeError("Codex bridge returned a response for a different requestId.", false, "conflict", 409, "binding_conflict");
  }
  let binding: CodexTaskBinding;
  try {
    binding = parseTaskBinding(record.binding);
  } catch (error) {
    throw new CodexBridgeError(error instanceof Error ? error.message : "Codex bridge task binding is invalid.", false, "conflict", 409, "binding_conflict");
  }
  const expectedFromResponse = taskBinding({
    request: expected.request,
    broker: {
      version: TASK_BINDING_VERSION,
      storeId: binding.storeId,
      providerId: binding.providerId,
      modelId: binding.modelId,
    },
    kind: expected.kind,
    ...(expected.expectedContractDigest ? { contractDigest: expected.expectedContractDigest } : {}),
    ...(expected.session ? { session: expected.session } : {}),
  });
  if (!sameTaskBinding(binding, expected.expectedBinding ?? expectedFromResponse)) {
    throw new CodexBridgeError("Codex bridge returned a response for a different immutable task binding.", false, "conflict", 409, "binding_conflict");
  }
  return binding;
}

function operationFromResponse(
  socketPath: string,
  raw: string,
  body: string,
  requestId: string,
  kind: CodexTaskKind,
  session: CodexTaskSession | undefined,
  expectedContractDigest: string | undefined,
  expectedBinding: CodexTaskBinding | undefined,
): CodexPreparedOperation | undefined {
  const value = parseJsonOrThrow(raw, "Codex bridge returned a non-JSON response body.");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // 非 durable 的嵌入式测试边界仍可使用旧长响应；正式 Broker 的 completed 信封必须带绑定。
  if (record.binding === undefined && record.requestId === undefined && !expectedBinding) return undefined;
  const request = JSON.parse(body) as Record<string, unknown>;
  const binding = bindingFromResponse(raw, {
    requestId,
    kind,
    request,
    session,
    expectedContractDigest,
    ...(expectedBinding ? { expectedBinding } : {}),
  });
  return preparedFromAccepted(socketPath, request, body, binding);
}

function validateResponseIdentity(record: Record<string, unknown>, operation: CodexPreparedOperation): void {
  if (record.requestId !== operation.requestId) {
    throw new CodexBridgeError("Codex bridge returned a response for a different requestId.", false, "conflict", 409, "binding_conflict");
  }
  let binding: CodexTaskBinding;
  try {
    binding = parseTaskBinding(record.binding);
  } catch (error) {
    throw new CodexBridgeError(error instanceof Error ? error.message : "Codex bridge task binding is invalid.", false, "conflict", 409, "binding_conflict");
  }
  if (!sameTaskBinding(binding, operation.binding)) {
    throw new CodexBridgeError("Codex bridge response does not belong to the prepared task.", false, "conflict", 409, "binding_conflict");
  }
}

function validatePreparedOperation(operation: CodexPreparedOperation, socketPath: string): void {
  if (operation.version !== "video-factory/codex-prepared-operation-v1"
    || operation.route.socketPath !== socketPath
    || operation.envelope.requestId !== operation.requestId
    || operation.envelope.kind !== operation.kind
    || JSON.stringify(operation.envelope) !== operation.serializedEnvelope) {
    throw new CodexBridgeError("Saved Codex operation is invalid or belongs to another route.", false, "conflict", 409, "binding_conflict");
  }
  const recomputed = taskBinding({
    request: operation.envelope,
    broker: operation.brokerBinding,
    kind: operation.kind,
    ...(operation.binding.contractDigest ? { contractDigest: operation.binding.contractDigest } : {}),
    ...(taskSessionFromEnvelope(operation.envelope) ? { session: taskSessionFromEnvelope(operation.envelope)! } : {}),
  });
  if (!sameTaskBinding(recomputed, operation.binding)) {
    throw new CodexBridgeError("Saved Codex operation binding does not match its immutable envelope.", false, "conflict", 409, "binding_conflict");
  }
}

function completedFailureError(outcome: Record<string, unknown>): CodexBridgeError {
  const raw = JSON.stringify({
    error: outcome.message ?? "Codex task failed.",
    ...(typeof outcome.failureKind === "string" ? { failureKind: outcome.failureKind } : {}),
    ...(outcome.failureDetails ? { failureDetails: outcome.failureDetails } : {}),
    ...(outcome.outcomeUncertain === true ? { outcomeUncertain: true } : {}),
  });
  const status = Number(outcome.status ?? 500);
  const failureKind = bridgeFailureKind(raw) ?? bodyFailureKind(raw);
  return new CodexBridgeError(
    `Codex task completed with failure status ${status}.${errorDetail(raw)}`,
    false,
    "completed_failure",
    status,
    failureKind,
    bridgeFailureDetails(raw),
  );
}

function validateTaskSession(session: CodexTaskSession): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.key)) {
    throw new CodexBridgeError("Codex task session key is invalid.", false);
  }
  if (session.handle !== undefined && !isOpaqueSessionHandle(session.handle)) {
    throw new CodexBridgeError("Codex task session handle is invalid.", false);
  }
}

function isOpaqueSessionHandle(value: string): boolean {
  return /^vfs_[A-Za-z0-9_-]{32}$/.test(value);
}

function parseTrace(value: unknown): CodexTaskTrace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexBridgeError("Codex bridge trace must be an object.", false);
  }
  const trace = value as Record<string, unknown>;
  if (!isCodexTaskKind(String(trace.taskKind))
    || typeof trace.promptVersion !== "string" || !trace.promptVersion
    || typeof trace.prompt !== "string" || !trace.prompt
    || typeof trace.providerId !== "string" || !trace.providerId
    || typeof trace.modelId !== "string" || !trace.modelId) {
    throw new CodexBridgeError("Codex bridge trace is invalid.", false);
  }
  const modelCandidateAttempts = parseModelCandidateAttempts(trace.modelCandidateAttempts);
  const queueWaitMs = optionalDurationMs(trace.queueWaitMs, "queueWaitMs");
  const providerWaitMs = optionalDurationMs(trace.providerWaitMs, "providerWaitMs");
  const firstOutputEventMs = optionalDurationMs(trace.firstOutputEventMs, "firstOutputEventMs");
  const toolMs = optionalDurationMs(trace.toolMs, "toolMs");
  const validationMs = optionalDurationMs(trace.validationMs, "validationMs");
  const promptTokens = optionalTokenCount(trace.promptTokens, "promptTokens");
  const completionTokens = optionalTokenCount(trace.completionTokens, "completionTokens");
  const totalTokens = optionalTokenCount(trace.totalTokens, "totalTokens");
  const reasoningTokens = optionalTokenCount(trace.reasoningTokens, "reasoningTokens");
  const retryCount = optionalTokenCount(trace.retryCount, "retryCount");
  const modelAttemptCount = optionalTokenCount(trace.modelAttemptCount, "modelAttemptCount");
  const structuredRepairCount = optionalTokenCount(trace.structuredRepairCount, "structuredRepairCount");
  if (trace.requestIdHash !== undefined
    && (typeof trace.requestIdHash !== "string" || !/^[a-f0-9]{64}$/.test(trace.requestIdHash))) {
    throw new CodexBridgeError("Codex bridge trace requestIdHash is invalid.", false);
  }
  if (trace.contractDigest !== undefined
    && (typeof trace.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(trace.contractDigest))) {
    throw new CodexBridgeError("Codex bridge trace contractDigest is invalid.", false);
  }
  if (trace.finishReason !== undefined && !isBoundedIdentifier(trace.finishReason, 64)) {
    throw new CodexBridgeError("Codex bridge trace finishReason is invalid.", false);
  }
  return {
    taskKind: trace.taskKind as CodexTaskKind,
    promptVersion: trace.promptVersion,
    ...(typeof trace.contractDigest === "string" ? { contractDigest: trace.contractDigest } : {}),
    prompt: trace.prompt,
    providerId: trace.providerId,
    modelId: trace.modelId,
    ...(typeof trace.reasoningEffort === "string" && trace.reasoningEffort
      ? { reasoningEffort: trace.reasoningEffort }
      : {}),
    ...(typeof trace.fallbackFromModelId === "string" && trace.fallbackFromModelId
      ? { fallbackFromModelId: trace.fallbackFromModelId }
      : {}),
    ...(typeof trace.fallbackReason === "string" && trace.fallbackReason
      ? { fallbackReason: trace.fallbackReason }
      : {}),
    ...(Array.isArray(trace.attemptedModelIds)
      && trace.attemptedModelIds.length > 0
      && trace.attemptedModelIds.every((modelId) => typeof modelId === "string" && modelId)
      ? { attemptedModelIds: [...new Set(trace.attemptedModelIds)] as string[] }
      : {}),
    ...(modelCandidateAttempts ? { modelCandidateAttempts } : {}),
    ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
    ...(providerWaitMs !== undefined ? { providerWaitMs } : {}),
    ...(firstOutputEventMs !== undefined ? { firstOutputEventMs } : {}),
    ...(toolMs !== undefined ? { toolMs } : {}),
    ...(validationMs !== undefined ? { validationMs } : {}),
    ...(typeof trace.requestIdHash === "string" ? { requestIdHash: trace.requestIdHash } : {}),
    ...(typeof trace.finishReason === "string" ? { finishReason: trace.finishReason } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(modelAttemptCount !== undefined ? { modelAttemptCount } : {}),
    ...(structuredRepairCount !== undefined ? { structuredRepairCount } : {}),
  };
}

function optionalDurationMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexBridgeError(`Codex bridge trace ${field} is invalid.`, false);
  }
  return Number(value);
}

function optionalTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexBridgeError(`Codex bridge trace ${field} is invalid.`, false);
  }
  return Number(value);
}

function parseModelCandidateAttempts(value: unknown): ModelCandidateAttempt[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodexBridgeError("Codex bridge model candidate attempts are invalid.", false);
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is invalid.", false);
    }
    const attempt = item as Record<string, unknown>;
    if (typeof attempt.modelId !== "string" || !attempt.modelId
      || (attempt.outcome !== "failed" && attempt.outcome !== "succeeded")
      || (attempt.failureStage !== undefined
        && attempt.failureStage !== "not_accepted"
        && attempt.failureStage !== "completed_failure"
        && attempt.failureStage !== "uncertain"
        && attempt.failureStage !== "rejected"
        && attempt.failureStage !== "conflict"
        && attempt.failureStage !== "transport")
      || (attempt.failureReason !== undefined
        && (typeof attempt.failureReason !== "string" || !attempt.failureReason))) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is invalid.", false);
    }
    if (typeof attempt.providerId !== "string" || !attempt.providerId) {
      throw new CodexBridgeError("Codex bridge model candidate attempt is missing its broker provider identity.", false);
    }
    if (attempt.outcome === "succeeded"
      && (attempt.failureStage !== undefined || attempt.failureReason !== undefined)) {
      throw new CodexBridgeError("Codex bridge successful model candidate attempt cannot contain a failure.", false);
    }
    if (attempt.outcome === "failed"
      && (attempt.failureStage === undefined || attempt.failureReason === undefined)) {
      throw new CodexBridgeError("Codex bridge failed model candidate attempt must describe its failure.", false);
    }
    return {
      modelId: attempt.modelId,
      providerId: attempt.providerId,
      outcome: attempt.outcome,
      ...(attempt.failureStage ? { failureStage: attempt.failureStage } : {}),
      ...(typeof attempt.failureReason === "string" ? { failureReason: attempt.failureReason } : {}),
    } as ModelCandidateAttempt;
  });
}

function parseJsonOrThrow(value: string, terminalMessage: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CodexBridgeError(terminalMessage, false);
  }
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function mapTransportError(error: unknown, socketPath: string, timeoutMs: number): CodexBridgeError {
  if (error instanceof CodexBridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof Error && (error.name === "AbortError" || code === "ABORT_ERR")) {
    // 超时时任务可能仍在 broker 侧执行，重放会造成重复付费工作。
    return new CodexBridgeError(`Codex bridge request timed out after ${timeoutMs}ms.`, false);
  }
  if (typeof code === "string" && RETRYABLE_CONNECT_CODES.has(code)) {
    return new CodexBridgeError(`Codex bridge socket '${socketPath}' failed with ${code}.`, true);
  }
  return new CodexBridgeError(
    `Codex bridge request failed: ${error instanceof Error ? error.message : String(error)}.`,
    false,
  );
}

function isUnknownRoleSessionRejection(status: number, raw: string): boolean {
  return status === 409 && raw.includes("Codex role session is unknown or belongs to a different production role.");
}

function isCodexTaskKind(value: string): value is CodexTaskKind {
  return (CODEX_TASK_KINDS as readonly string[]).includes(value);
}

function errorDetail(raw: string): string {
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch { /* 非 JSON 错误仍保留有界诊断。 */ }
  const detail = message.trim().slice(0, 160);
  return detail ? ` ${detail}` : "";
}

function bridgeFailureKind(raw: string): CodexBridgeFailureKind | undefined {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return body.failureKind === "model_provider_transient" || body.failureKind === "model_provider_no_output"
      ? body.failureKind
      : undefined;
  } catch {
    return undefined;
  }
}

const MODEL_PROVIDER_FAILURE_CATEGORIES = new Set<ModelProviderFailureCategory>([
  "authentication",
  "invalid_request",
  "rate_limited",
  "service_unavailable",
  "timeout",
  "network",
  "invalid_output",
  "execution_failed",
]);

function bridgeFailureDetails(raw: string): ModelProviderFailureDetails | undefined {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const value = body.failureDetails;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const details = value as Record<string, unknown>;
    if (!MODEL_PROVIDER_FAILURE_CATEGORIES.has(details.category as ModelProviderFailureCategory)
      || !isBoundedIdentifier(details.reasonCode, 128)
      || !isBoundedIdentifier(details.providerId, 128)
      || !isBoundedIdentifier(details.modelId, 128)
      || (details.queueWaitMs !== undefined && optionalDurationMs(details.queueWaitMs, "queueWaitMs") === undefined)
      || (details.providerWaitMs !== undefined && optionalDurationMs(details.providerWaitMs, "providerWaitMs") === undefined)
      || (details.requestIdHash !== undefined
        && (typeof details.requestIdHash !== "string" || !/^[a-f0-9]{64}$/.test(details.requestIdHash)))
      || (details.finishReason !== undefined && !isBoundedIdentifier(details.finishReason, 64))
      || !isOptionalTokenCount(details.promptTokens)
      || !isOptionalTokenCount(details.completionTokens)
      || !isOptionalTokenCount(details.totalTokens)
      || !isOptionalTokenCount(details.reasoningTokens)
      || !isOptionalTokenCount(details.modelAttemptCount)
      || !isOptionalTokenCount(details.structuredRepairCount)
      || (details.fieldPath !== undefined && !isSafeFieldPath(details.fieldPath))
      || (details.taskKind !== undefined && !isCodexTaskKind(String(details.taskKind)))
      || (details.accepted !== undefined && typeof details.accepted !== "boolean")) {
      return undefined;
    }
    return {
      category: details.category as ModelProviderFailureCategory,
      reasonCode: details.reasonCode as string,
      providerId: details.providerId as string,
      modelId: details.modelId as string,
      ...(details.queueWaitMs !== undefined ? { queueWaitMs: Number(details.queueWaitMs) } : {}),
      ...(details.providerWaitMs !== undefined ? { providerWaitMs: Number(details.providerWaitMs) } : {}),
      ...(typeof details.requestIdHash === "string" ? { requestIdHash: details.requestIdHash } : {}),
      ...(typeof details.finishReason === "string" ? { finishReason: details.finishReason } : {}),
      ...(typeof details.promptTokens === "number" ? { promptTokens: details.promptTokens } : {}),
      ...(typeof details.completionTokens === "number" ? { completionTokens: details.completionTokens } : {}),
      ...(typeof details.totalTokens === "number" ? { totalTokens: details.totalTokens } : {}),
      ...(typeof details.reasoningTokens === "number" ? { reasoningTokens: details.reasoningTokens } : {}),
      ...(typeof details.fieldPath === "string" ? { fieldPath: details.fieldPath } : {}),
      ...(typeof details.taskKind === "string" ? { taskKind: details.taskKind as CodexTaskKind } : {}),
      ...(typeof details.accepted === "boolean" ? { accepted: details.accepted } : {}),
      ...(details.executionLayer === "cli" || details.executionLayer === "provider_transport" ? { executionLayer: details.executionLayer } : {}),
      ...(Number.isInteger(details.processExitCode) && Number(details.processExitCode) >= 0 && Number(details.processExitCode) <= 255 ? { processExitCode: Number(details.processExitCode) } : {}),
      ...(["invalid_json_schema", "invalid_request_error", "unsupported_parameter"].includes(String(details.providerErrorCode)) ? { providerErrorCode: details.providerErrorCode as ModelProviderFailureDetails["providerErrorCode"] & string } : {}),
      ...(["uniqueItems", "required", "additionalProperties"].includes(String(details.schemaKeyword)) ? { schemaKeyword: details.schemaKeyword as ModelProviderFailureDetails["schemaKeyword"] & string } : {}),
      ...(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(details.networkCode)) ? { networkCode: String(details.networkCode) } : {}),
      ...(typeof details.headersReceived === "boolean" ? { headersReceived: details.headersReceived } : {}),
      ...(typeof details.localExecutionEnded === "boolean" ? { localExecutionEnded: details.localExecutionEnded } : {}),
      ...(typeof details.remoteQueryable === "boolean" ? { remoteQueryable: details.remoteQueryable } : {}),
      ...(typeof details.modelAttemptCount === "number" ? { modelAttemptCount: details.modelAttemptCount } : {}),
      ...(typeof details.structuredRepairCount === "number" ? { structuredRepairCount: details.structuredRepairCount } : {}),
    };
  } catch {
    return undefined;
  }
}

function isSafeFieldPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 240
    && /^(?:request|payload|output)(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d+\])+$/.test(value);
}

function isOptionalTokenCount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n\t]/.test(value);
}

// C5：创作者文案必须消费受理阶段。uncertain（结果未知：超时/中途断连等）意味着请求
// 可能已被受理，绝不能建议"重试或换模型"——那会诱导重复 create；只有确证未受理
// （not_accepted）才允许给出重试/换模型的建议。
function creatorMessageFor(
  message: string,
  stage: CodexBridgeFailureStage,
  details: ModelProviderFailureDetails | undefined,
  statusCode: number | undefined,
  failureKind: CodexBridgeFailureKind | undefined,
): string {
  if (stage === "not_accepted" && statusCode === 503 && message.includes("backlog is full")) {
    return "模型服务的等待队列已满，本次任务尚未执行。当前稿已保留，请等已有任务完成后再重试。";
  }
  if (stage === "uncertain") {
    if (details?.localExecutionEnded || /local execution ended/i.test(message)) {
      return "本地调用已结束，但远端结果未知，已停止自动等待。当前稿与原请求已保留，请核对原任务；不能通过换模型或重复提交来重试。";
    }
    if (/still running after the wait deadline/i.test(message)) {
      return "原模型任务仍在处理中，当前进度已保留；可以稍后再次查询，不会重新提交。";
    }
    const reason = details?.category === "timeout" || statusCode === 408 || /timed?\s*out|timeout/i.test(message)
      ? "模型调用超时"
      : "与模型服务的连接中断";
    return `${reason}，结果未知：这次请求可能已经被模型受理。当前进度已保留，请先核对原有任务的结果，不要重新发起同样的请求。`;
  }
  if (stage === "rejected") {
    const field = details?.fieldPath ? `字段 ${details.fieldPath} 不符合输入合同；` : "请求与任务合同不一致；";
    return `模型服务拒绝了本次请求（${field}错误代码 ${details?.reasonCode ?? "contract_rejected"}），任务没有开始执行；不会产生模型调用或费用。`;
  }
  if (stage === "conflict") {
    return "请求身份与已有任务记录冲突，已停止自动执行；原有任务不受影响。请查看诊断信息。";
  }
  switch (details?.category) {
    case "invalid_output": {
      const reasons: Record<string, string> = {
        duplicate_scene_position: "分镜编号重复",
        reference_reuse_conflict: "同一镜头不能同时设为母片复用和参考图生成",
        reference_must_be_earlier: "参考图必须来自前面的镜头",
        reference_requires_image: "参考图生成目前只支持图片镜头",
        // 视觉审片：评分/confidence/证据状态与 recommendation 必须自洽，且每条问题的
        // 证据状态决定它能要求的下一步；这七条是审片输出最常见的拦截原因。
        visual_approval_score: "审片结论为通过，但五项评分中有低于 75 的项",
        visual_approval_confidence: "审片结论为通过，但置信度低于 0.7",
        visual_approval_unresolved_evidence: "审片结论为通过，但仍有 failed 或 not_observed 的问题未解决",
        visual_finding_time_range: "问题的起止时间范围没有包含它自己的时间点",
        visual_failed_rework: "判定为 failed 的问题没有给出可执行的返修方向（需为上游重规划或素材返工）",
        visual_unobserved_inspection: "判定为 not_observed 的问题没有要求先补查已有素材",
        visual_nonfailing_rework: "未判定失败的问题却要求返修",
      };
      return `模型输出未通过制作规则：${reasons[details.reasonCode] ?? "输出结构或语义不符合合同"}${details.fieldPath ? `（${details.fieldPath}）` : ""}。已保留当前进度，请先修正方案或对应规则，不要反复重试。`;
    }
    case "invalid_request":
      return `模型请求合同需要修正${details.providerErrorCode ? `（${details.providerErrorCode}${details.schemaKeyword ? `：${details.schemaKeyword}` : ""}）` : ""}；当前稿已保留，请检查制作分工中的模型配置和诊断，不要反复重试。`;
    case "rate_limited":
      return "模型请求过多，请稍后重试或选择其他模型。";
    case "timeout":
      return "模型调用超时，请重试或选择其他模型。";
    case "service_unavailable":
    case "network":
      return "模型暂时不可用，请重试或选择其他模型。";
    case "authentication":
      return "模型服务配置需要检查。";
    default:
      if (statusCode === 429) return "模型请求过多，请稍后重试或选择其他模型。";
      if (statusCode === 408 || /timed?\s*out|timeout/i.test(message)) {
        return "模型调用超时，请重试或选择其他模型。";
      }
      if (statusCode === 503 || failureKind === "model_provider_transient") {
        return "模型暂时不可用，请重试或选择其他模型。";
      }
      return "模型没有完成此步骤，请重试或选择其他模型。";
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
