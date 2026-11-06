import type { SubmitPermit } from "../../shared/agent/ports.js";
import { AgentError } from "./errors.js";

const permits = new WeakSet<object>();
// 仅后台在 submit_started 事务成功后调用。对象身份不能通过 JSON 或 LLM 参数复制。
export function issueSubmitPermit(attemptId: string, executionEpoch: number): SubmitPermit {
  const permit = Object.freeze({ attemptId, executionEpoch }) as SubmitPermit;
  permits.add(permit);
  return permit;
}
export function consumeSubmitPermit(permit: SubmitPermit, attemptId: string): void {
  if (!permits.has(permit) || permit.attemptId !== attemptId) throw new AgentError("AUTHORIZATION_REQUIRED", "创建操作缺少一次性执行许可。");
  permits.delete(permit);
}
