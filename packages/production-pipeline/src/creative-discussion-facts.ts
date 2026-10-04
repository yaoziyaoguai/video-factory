// C2（收尾包 2026-10-04）：discuss/revise 咨询失败的统一事实分类。
// planning 续接诊断与 durable 执行记录共用这一份判定，不再维护两套口径：
// - conflict 是身份冲突，不是“未受理”，归入 unknown/身份待核；
// - ModelCandidatesExhaustedError 必须读全部 failures，不能只看最后一个 cause；
// - 任何 unknown 证据都使整体保持 unknown，已受理失败不得被后一个未受理抹掉。
import { CodexBridgeError } from "./codex-chat.js";
import { ModelCandidatesExhaustedError } from "./fallback-role-agents.js";

export type CreativeConsultationFactState = "not_accepted" | "failed" | "unknown";

export type CreativeConsultationFactReason =
  | "all_candidates_not_accepted"
  | "settled_failure"
  | "request_uncertain"
  | "identity_conflict"
  | "indeterminate_error";

export interface CreativeConsultationCandidateFact {
  state: CreativeConsultationFactState;
  providerId?: string;
  modelId?: string;
}

export interface CreativeConsultationFacts {
  fact: CreativeConsultationFactState;
  reason: CreativeConsultationFactReason;
  /** 每个实际候选/物理请求的可核事实；无法映射的候选不伪造。 */
  candidates: CreativeConsultationCandidateFact[];
}

// 角色包装不能越过候选聚合，沿cause只认最近的真实事实对象；异常环/过深保持待核。
function consultationEvidence(error: unknown): CodexBridgeError | ModelCandidatesExhaustedError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (current instanceof CodexBridgeError || current instanceof ModelCandidatesExhaustedError) return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}

function classifySingle(error: unknown): { state: CreativeConsultationFactState; reason?: CreativeConsultationFactReason } {
  const bridge = consultationEvidence(error);
  if (!(bridge instanceof CodexBridgeError)) {
    // 没有 Bridge 证据的普通错误：受理情况不可判定，保持 unknown，不猜成已核失败。
    return { state: "unknown", reason: "indeterminate_error" };
  }
  if (bridge.stage === "not_accepted" || bridge.stage === "rejected") return { state: "not_accepted" };
  if (bridge.stage === "completed_failure") return { state: "failed" };
  if (bridge.stage === "conflict") return { state: "unknown", reason: "identity_conflict" };
  return { state: "unknown", reason: "request_uncertain" }; // uncertain
}

/**
 * 聚合规则（对应收尾包 C2 事实矩阵）：
 * 任一候选 unknown（uncertain/conflict/普通错误）→ 整体 unknown；
 * 否则任一候选 failed（已受理且已核清失败）→ 整体 failed；
 * 否则（全部 not_accepted/rejected 且无相反证据）→ not_accepted。
 */
export function classifyCreativeConsultationError(
  error: unknown,
  options: { settledNoResult?: boolean } = {},
): CreativeConsultationFacts {
  if (options.settledNoResult === true) {
    // 请求已执行并返回，但结果不满足登记合同：已核清的失败，不是未知。
    return { fact: "failed", reason: "settled_failure", candidates: [{ state: "failed" }] };
  }
  const evidence = consultationEvidence(error);
  if (evidence instanceof ModelCandidatesExhaustedError) {
    const candidates: CreativeConsultationCandidateFact[] = evidence.failures.map((failure) => ({
      state: classifySingle(failure.error).state,
      providerId: failure.providerId,
      modelId: failure.modelId,
    }));
    return { fact: aggregate(candidates.map((entry) => entry.state)), reason: reasonOf(candidates), candidates };
  }
  const single = classifySingle(error);
  return {
    fact: single.state,
    reason: single.reason ?? (single.state === "not_accepted" ? "all_candidates_not_accepted" : "settled_failure"),
    candidates: [{ state: single.state }],
  };
}

function aggregate(states: CreativeConsultationFactState[]): CreativeConsultationFactState {
  if (states.some((state) => state === "unknown")) return "unknown";
  if (states.some((state) => state === "failed")) return "failed";
  return "not_accepted";
}

function reasonOf(candidates: CreativeConsultationCandidateFact[]): CreativeConsultationFactReason {
  const states = candidates.map((entry) => entry.state);
  if (states.some((state) => state === "unknown")) {
    // 细分证据供诊断展示；无法细分时用通用 unknown。
    return "request_uncertain";
  }
  if (states.some((state) => state === "failed")) return "settled_failure";
  return "all_candidates_not_accepted";
}

/** 执行记录的 durable state 与事实分类的映射。 */
export function discussionExecutionStateFor(fact: CreativeConsultationFactState): "completed_failure" | "accepted_unknown" | "not_accepted" {
  if (fact === "failed") return "completed_failure";
  if (fact === "unknown") return "accepted_unknown";
  return "not_accepted";
}
