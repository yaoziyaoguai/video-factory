import { createHash } from "node:crypto";
import { CodexBridgeError } from "./codex-chat.js";
import type { ModelCandidateAttempt } from "./codex-chat.js";
import { RoleAgentLoopError } from "./role-agent-loop.js";

const TERMINAL_MODEL_FAILURE_PATTERN = /invalid\s+json|output\s+(?:contract|schema)|response\s+(?:envelope|schema)|trace\s+is\s+invalid|malformed|business\s+validation|content\s+(?:safety|policy|filter|moderation)|policy\s+(?:violation|rejected)|(?:authentication|authorization|credential|api\s*key)\s+(?:failed|invalid|missing)|unauthori[sz]ed|forbidden|(?:contract|schema|structure|quality|audit)\b[^.]{0,80}\b(?:failed|invalid|rejected|violation|not\s+pass)|(?:业务|内容安全|合同|结构|质量|审计)[^.。]{0,40}(?:失败|无效|拒绝|违规|未通过)/i;
const TRANSIENT_MODEL_FAILURE_PATTERN = /(?:request|operation|model|service|role)?\s*(?:timed\s*out|timeout)|temporarily\s+unavailable|(?:service|server|model|backend|role)\s+(?:is\s+)?unavailable|rate[ _-]?limit(?:ed|ing)?|too\s+many\s+requests|overload(?:ed|ing)?|(?:insufficient|exhausted|unavailable)\s+(?:model\s+)?capacity|capacity\s+(?:is\s+)?(?:unavailable|exhausted)|could\s+not\s+connect|connection\s+(?:failed|reset|refused)|socket\s+[^.]*failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ENOENT/i;

export function isModelProviderFailure(error: unknown): boolean {
  if (error instanceof RoleAgentLoopError && error.agentLoop.pendingCandidate) return false;
  return hasTransientModelProviderFailure(error);
}

export function isTransientRoleAuditProviderFailure(error: unknown): error is RoleAgentLoopError {
  return error instanceof RoleAgentLoopError
    && error.agentLoop.pendingCandidate !== undefined
    && hasTransientModelProviderFailure(error.sourceError);
}

function hasTransientModelProviderFailure(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (!(candidate instanceof CodexBridgeError)) continue;
    if (TERMINAL_MODEL_FAILURE_PATTERN.test(candidate.message)) return false;
    if (candidate.failureKind === "model_provider_transient") return true;
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
  if (/socket .* failed|ECONN|ENOENT|could not connect/i.test(message)) return "连接失败";
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
