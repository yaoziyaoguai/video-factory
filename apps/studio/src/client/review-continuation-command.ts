import type { StudioDecisionInput, StudioReviewContinuationInput, StudioRunDetail } from "../shared/api.js";
import { studioApi, StudioApiError } from "./api.js";

export type LocalReviewCommand = { kind: "prepare"; input: StudioReviewContinuationInput }
  | { kind: "decision"; input: StudioDecisionInput & { commandId: string } };
const storageKey = (runId: string) => `video-factory:local-review-command:${runId}`;

export function pendingLocalReviewCommand(runId: string): LocalReviewCommand | undefined {
  try { const raw = localStorage.getItem(storageKey(runId)); return raw ? JSON.parse(raw) : undefined; }
  catch { return undefined; }
}
function clearKnownCommand(runId: string) {
  // 清理失败不把已受理操作谎报成失败；残留回执下次仍只查询原编号。
  try { localStorage.removeItem(storageKey(runId)); } catch { /* 保留已知结果，不重发 */ }
}

export async function submitLocalReviewCommand(runId: string, command: LocalReviewCommand): Promise<StudioRunDetail> {
  const raw = localStorage.getItem(storageKey(runId));
  if (raw && raw !== JSON.stringify(command)) throw new Error("上一条决定还未核实，请先查看原操作状态；不能换编号或修改内容重发。");
  try { localStorage.setItem(storageKey(runId), JSON.stringify(command)); }
  catch { throw new Error("无法保存原操作编号，本次没有发送。请恢复浏览器本地存储权限后再操作。"); }
  try {
    const run = command.kind === "prepare" ? await studioApi.prepareReviewContinuation(runId, command.input)
      : await studioApi.decide(runId, command.input);
    if (run.status !== "running" && run.status !== "pending") clearKnownCommand(runId);
    return run;
  } catch (error) {
    // 丢失响应不是未受理；先查同一回执，绝不自动 POST 重试或换编号。
    try {
      const receipt = await studioApi.reviewContinuationReceipt(runId, command.input.commandId);
      if (receipt.state === "applied") { const run = await studioApi.run(runId); clearKnownCommand(runId); return run; }
      if (receipt.state === "failed") clearKnownCommand(runId);
    } catch (observationError) {
      // 明确4xx且回执不存在才是已拒绝的首次命令；保留表单，允许用户修正后再确认。
      if (error instanceof StudioApiError && error.status >= 400 && error.status < 500
        && observationError instanceof StudioApiError && observationError.status === 404) clearKnownCommand(runId);
    }
    throw error;
  }
}

export async function observePendingLocalReviewCommand(runId: string, explicitlyContinue = false): Promise<StudioRunDetail | undefined> {
  const command = pendingLocalReviewCommand(runId);
  if (!command) return undefined;
  const receipt = await studioApi.reviewContinuationReceipt(runId, command.input.commandId);
  if (receipt.state === "applied") { const run = await studioApi.run(runId); clearKnownCommand(runId); return run; }
  if (receipt.state === "failed") { clearKnownCommand(runId); throw new Error(receipt.error ?? "原本地操作未完成，请查看保留的输入后再处理。"); }
  // POST仅来自用户点“按原操作继续”；服务端同一租约判定写者/原目标，不盲抢锁。
  if (explicitlyContinue && receipt.state === "accepted") return submitLocalReviewCommand(runId, command);
  return undefined;
}
