import { CodexBridgeError, type CodexBridgeFailureStage, type ModelCandidateAttempt } from "./codex-chat.js";
import { RoleAgentHostStop, RoleAgentLoopError, RoleAuditOutputError } from "./role-agent-loop.js";

/**
 * 审查请求事实的共享分类（执行包 1.2 节）。纯函数：不发请求、不改稿、不批准、不记费用。
 * 消费者（素材预检、规划、成片审片、声音审片）用它对同一异常得到同一事实分类，
 * 不再各自用最外层异常类型或展示文案猜测受理状态。
 */
export type ReviewRequestState =
  /** 有权威证据证明请求发生在受理之前（宿主停发、确定性拒绝）。 */
  | "not_submitted"
  /** 服务端权威证明未受理。补提交须遵守有界、耐久限次合同。 */
  | "not_accepted"
  /** 请求已确定结束（完成或确定性终态），无论结果是否可用。 */
  | "settled"
  /** 结果未知：可能在途。只能查询/观察原请求，不重发。 */
  | "unknown";

export type ReviewResultState = "valid" | "unusable" | "absent" | "conflict";
export type ReviewBindingState = "verified" | "unresolved" | "conflict";

/** 分类依据的出处；消费者据此判断这条分类是否可复核。 */
export type ReviewDispositionEvidence =
  | "bridge_error_stage"
  | "host_audit_rejection"
  | "host_stop"
  | "candidate_attempts"
  | "none";

export interface ReviewDisposition {
  requestState: ReviewRequestState;
  resultState: ReviewResultState;
  bindingState: ReviewBindingState;
  reasonCode: string;
  /** 异常链上携带的原审查操作身份（如 auditOperationId）；没有则省略，不猜。 */
  operationId?: string;
  evidence: ReviewDispositionEvidence;
}

// 与 codexBridgeErrorFromCause 相同的遍历上限，防止异常 cause 成环。
const CAUSE_TRAVERSAL_LIMIT = 6;

function dispositionFromBridgeStage(stage: CodexBridgeFailureStage): ReviewDisposition {
  switch (stage) {
    case "completed_failure":
      // Provider 已给出确定性失败：请求结束，但没有可用报告，也不必再审同一请求。
      return { requestState: "settled", resultState: "unusable", bindingState: "verified", reasonCode: "bridge_completed_failure", evidence: "bridge_error_stage" };
    case "not_accepted":
      return { requestState: "not_accepted", resultState: "absent", bindingState: "verified", reasonCode: "bridge_not_accepted", evidence: "bridge_error_stage" };
    case "rejected":
      // 确定性参数/协议拒绝：权威未受理证明，须保留原因；不等同内容审查无结论。
      return { requestState: "not_accepted", resultState: "absent", bindingState: "verified", reasonCode: "bridge_rejected", evidence: "bridge_error_stage" };
    case "uncertain":
      // 在途/结果未知：只能恢复原请求。不得转成“已核清无结论”。
      return { requestState: "unknown", resultState: "absent", bindingState: "unresolved", reasonCode: "bridge_uncertain", evidence: "bridge_error_stage" };
    case "conflict":
      // 身份无法核实/互斥事实：显式冲突，不能借“无结论可接受”通道逃逸。
      return { requestState: "unknown", resultState: "conflict", bindingState: "conflict", reasonCode: "bridge_conflict", evidence: "bridge_error_stage" };
  }
}

const UNCLASSIFIED: ReviewDisposition = {
  requestState: "unknown",
  resultState: "absent",
  bindingState: "unresolved",
  reasonCode: "unclassified_technical_error",
  evidence: "none",
};

/**
 * 从异常及其 cause 链分类审查请求事实。普通异常、网络错误名称与
 * providerOutcomeKnown 布尔值本身不能证明请求已结束：无法分类时保持
 * unresolved，不擅自判 settled。
 */
export function classifyReviewDisposition(error: unknown): ReviewDisposition {
  let bridge: CodexBridgeError | undefined;
  let hostRejected = error instanceof RoleAgentLoopError && error.sourceError instanceof RoleAuditOutputError;
  let hostStopped = false;
  let operationId: string | undefined;
  let current: unknown = error;
  const visited = new Set<Error>();
  for (let depth = 0; depth <= CAUSE_TRAVERSAL_LIMIT; depth += 1) {
    if (current instanceof Error && visited.has(current)) return { ...UNCLASSIFIED, reasonCode: "cyclic_error_evidence" };
    if (current instanceof Error) visited.add(current);
    if (current instanceof RoleAuditOutputError) {
      // 审计响应已完整取回、宿主校验拒收：请求已结束但没有可用结论。
      hostRejected = true;
    } else if (current instanceof CodexBridgeError) {
      // 外层已结束/宿主拒收不能盖过内层在途与身份冲突事实。
      if (!bridge || current.stage === "conflict" || current.stage === "uncertain" && bridge.stage !== "conflict") bridge = current;
    } else if (current instanceof RoleAgentHostStop) {
      hostStopped = true;
    }
    const candidate = (current as { auditOperationId?: unknown } | null | undefined)?.auditOperationId;
    if (typeof candidate === "string" && candidate.trim() && !operationId) operationId = candidate;
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  if (current instanceof Error) return { ...UNCLASSIFIED, reasonCode: "truncated_error_evidence" };
  if (bridge && (bridge.stage === "uncertain" || bridge.stage === "conflict")) {
    return { ...dispositionFromBridgeStage(bridge.stage), ...(operationId ? { operationId } : {}) };
  }
  if (hostRejected) {
    return {
      requestState: "settled",
      resultState: "unusable",
      bindingState: "verified",
      reasonCode: "host_audit_rejected",
      evidence: "host_audit_rejection",
      ...(operationId ? { operationId } : {}),
    };
  }
  if (bridge) {
    return {
      ...dispositionFromBridgeStage(bridge.stage),
      ...(operationId ? { operationId } : {}),
    };
  }
  if (hostStopped) {
    return { requestState: "not_submitted", resultState: "absent", bindingState: "unresolved", reasonCode: "host_stop_before_submit", evidence: "host_stop" };
  }
  return { ...UNCLASSIFIED, ...(operationId ? { operationId } : {}) };
}

/** 候选聚合必须保守：任一 unknown 都不能被其他候选的已结束状态兜底。 */
export function aggregateReviewDispositions(items: readonly ReviewDisposition[]): ReviewDisposition {
  if (items.length === 0) return { ...UNCLASSIFIED, reasonCode: "aggregate_without_evidence" };
  if (items.some((item) => item.requestState === "unknown")) {
    const conflict = items.some((item) => item.bindingState === "conflict");
    return {
      requestState: "unknown",
      resultState: conflict ? "conflict" : "absent",
      bindingState: conflict ? "conflict" : "unresolved",
      reasonCode: conflict ? "aggregate_contains_conflict" : "aggregate_contains_unknown",
      evidence: "candidate_attempts",
    };
  }
  const notAccepted = items.some((item) => item.requestState === "not_accepted");
  const allVerified = items.every((item) => item.bindingState === "verified");
  return {
    requestState: notAccepted ? "not_accepted" : "settled",
    resultState: "unusable",
    bindingState: allVerified ? "verified" : "unresolved",
    reasonCode: notAccepted ? "aggregate_not_accepted" : "aggregate_settled_without_valid_result",
    evidence: "candidate_attempts",
  };
}

/** 按候选尝试的阶段性事实聚合（fallback 候选列表的共享口径）。 */
export function classifyCandidateAttempts(attempts: readonly ModelCandidateAttempt[]): ReviewDisposition {
  return aggregateReviewDispositions(attempts.map((attempt) => attempt.outcome === "failed"
    ? dispositionFromCandidateStage(attempt.failureStage)
    : { requestState: "settled", resultState: "valid", bindingState: "verified", reasonCode: "candidate_succeeded", evidence: "candidate_attempts" }));
}

function dispositionFromCandidateStage(stage: CodexBridgeFailureStage | "transport"): ReviewDisposition {
  if (stage === "transport") {
    // 传输层失败不证明请求未受理，也不证明已结束：与 uncertain 同样只能恢复原请求。
    return { requestState: "unknown", resultState: "absent", bindingState: "unresolved", reasonCode: "candidate_transport_failure", evidence: "candidate_attempts" };
  }
  return dispositionFromBridgeStage(stage);
}

/** 消费者统一的准入问法：只有已结束且无可用结论的事实才允许进入人工停点。 */
export function dispositionAllowsHumanStop(disposition: ReviewDisposition): boolean {
  if (disposition.bindingState !== "verified" || disposition.resultState === "conflict") return false;
  if (disposition.requestState === "settled") return true;
  // 只有服务端权威"未受理"（409 not_accepted）才进入补提交的人工停点；
  // 确定性协议拒绝（rejected）是配置问题：保持失败并保留原因，用户修正配置后重试。
  return disposition.requestState === "not_accepted" && disposition.reasonCode === "bridge_not_accepted";
}
