import { createHash } from "node:crypto";
import { CodexBridgeError } from "./codex-chat.js";
import type { ModelCandidateAttempt } from "./codex-chat.js";
import { RoleAgentLoopError } from "./role-agent-loop.js";

const TERMINAL_MODEL_FAILURE_PATTERN = /invalid\s+json|output\s+(?:contract|schema)|response\s+(?:envelope|schema)|trace\s+is\s+invalid|malformed|business\s+validation|content\s+(?:safety|policy|filter|moderation)|policy\s+(?:violation|rejected)|(?:authentication|authorization|credential|api\s*key)\s+(?:failed|invalid|missing)|unauthori[sz]ed|forbidden|(?:contract|schema|structure|quality|audit)\b[^.]{0,80}\b(?:failed|invalid|rejected|violation|not\s+pass)|(?:业务|内容安全|合同|结构|质量|审计)[^.。]{0,40}(?:失败|无效|拒绝|违规|未通过)/i;
const TRANSIENT_MODEL_FAILURE_PATTERN = /(?:request|operation|model|service|role)?\s*(?:timed\s*out|timeout)|temporarily\s+unavailable|(?:service|server|model|backend|role)\s+(?:is\s+)?unavailable|rate[ _-]?limit(?:ed|ing)?|too\s+many\s+requests|overload(?:ed|ing)?|(?:insufficient|exhausted|unavailable)\s+(?:model\s+)?capacity|capacity\s+(?:is\s+)?(?:unavailable|exhausted)|could\s+not\s+connect|connection\s+(?:failed|reset|refused)|socket\s+[^.]*failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ENOENT/i;

export function isModelProviderFailure(error: unknown): boolean {
  if (error instanceof RoleAgentLoopError && error.agentLoop.pendingCandidate) return false;
  return hasFallbackEligibleProviderFailure(error);
}

export function isTransientRoleAuditProviderFailure(error: unknown): error is RoleAgentLoopError {
  return error instanceof RoleAgentLoopError
    && error.agentLoop.pendingCandidate !== undefined
    && hasFallbackEligibleProviderFailure(error.sourceError);
}

// 只有“确证可以安全切换 Provider”的瞬时故障才返回 true。判定依据是 error chain 中第一个
// CodexBridgeError；它的 stage 决定请求是否可能仍被 durable broker 执行：
// - stage=uncertain：请求可能已被受理并仍在执行。无论 category=timeout/network、HTTP=408/503/504
//   还是消息含 timeout，都不能作为切换依据，必须原样上抛（保留 failureStage=uncertain），
//   由确定性 requestId/broker 幂等恢复，禁止在本层生成 backup requestId 造成双跑。
// - stage=not_accepted：失败确证发生在受理之前；连接失败、限流、容量、服务不可用可切候选。
// - stage=completed_failure：原请求已经确定结束；只有 Broker 给出可验证的
//   基础设施分类或“模型无输出”时才能换候选。模糊的 500、结构/业务/质量失败
//   仍保留原证据并停止，不用第二个模型掩盖。
function hasFallbackEligibleProviderFailure(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (!(candidate instanceof CodexBridgeError)) continue;
    if (candidate.stage === "uncertain" || candidate.stage === "rejected" || candidate.stage === "conflict") return false;
    if (TERMINAL_MODEL_FAILURE_PATTERN.test(candidate.message)) return false;
    if (candidate.failureDetails?.category === "authentication"
      || candidate.failureDetails?.category === "invalid_request"
      || candidate.failureDetails?.category === "invalid_output") return false;
    if (candidate.failureDetails?.category === "rate_limited"
      || candidate.failureDetails?.category === "service_unavailable"
      || candidate.failureDetails?.category === "timeout"
      || candidate.failureDetails?.category === "network") return true;
    if (candidate.failureKind === "model_provider_transient" || candidate.failureKind === "model_provider_no_output") return true;
    if (candidate.stage === "completed_failure") return false;
    if (candidate.statusCode !== undefined) {
      if (candidate.statusCode === 408 || candidate.statusCode === 429) return true;
      if (candidate.statusCode === 502 || candidate.statusCode === 503 || candidate.statusCode === 504) return true;
    }
    return TRANSIENT_MODEL_FAILURE_PATTERN.test(candidate.message);
  }
  return false;
}

export function publicModelFailure(error: unknown): string {
  const bridgeError = errorChain(error).find((candidate): candidate is CodexBridgeError => candidate instanceof CodexBridgeError);
  const message = bridgeError?.message ?? (error instanceof Error ? error.message : "");
  if (/timed out/i.test(message)) return "调用超时";
  if (/rate limit|HTTP 429/i.test(message)) return "请求过多";
  if (/temporarily unavailable|role is unavailable/i.test(message)) return "暂时不可用";
  if (bridgeError?.failureKind === "model_provider_no_output") return "未返回结果";
  if (/socket .* failed|ECONN|ENOENT|could not connect/i.test(message)) return "连接失败";
  // 422 既可能是服务端故障，也可能是"模型回来了但输出不合合同"。笼统写成"服务端错误"
  // 会把后者藏起来——用户看到的只是"总编又没给建议"，而真正的原因（输出被合同拦下）永远不出现。
  const failure = bridgeError?.failureDetails;
  if (failure?.category === "invalid_output") {
    return failure.reasonCode === "response_too_large"
      ? "输出超过上限"
      : `输出未通过合同（${failure.reasonCode}）`;
  }
  if (failure?.category === "invalid_request") return "请求未通过合同";
  if (bridgeError?.statusCode !== undefined) return `服务端错误（HTTP ${bridgeError.statusCode}）`;
  if (error instanceof RoleAgentLoopError && error.agentLoop.iterations.length > 0) return "质量审计未通过";
  return "调用失败";
}

export function failedModelCandidateAttempt(
  error: unknown,
  modelId: string,
  providerId: string,
): ModelCandidateAttempt {
  const bridgeError = errorChain(error).find((candidate): candidate is CodexBridgeError => candidate instanceof CodexBridgeError);
  return {
    modelId,
    providerId,
    outcome: "failed",
    failureStage: bridgeError?.stage ?? "transport",
    failureReason: publicModelFailure(error),
  };
}

export function fallbackRequestId(requestId: string, candidateId: string, position: number): string {
  return `backup-${createHash("sha256").update(`${requestId}:${candidateId}:${position}`).digest("hex")}`;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    chain.push(current);
    if (current instanceof RoleAgentLoopError) current = current.sourceError;
    else if (current instanceof Error) current = current.cause;
    else current = undefined;
  }
  return chain;
}
