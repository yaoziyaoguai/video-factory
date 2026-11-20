import type { AgentDatabase } from "./db.js";

export interface HistoryTrimResult {
  eventsDeleted: number;
  receiptsDeleted: number;
}

export interface HistoryTrimOptions {
  /** 保留窗口（毫秒）；默认 7 天。 */
  retentionMs?: number;
  /** 每会话除时间窗外额外保底的事件条数；默认 2,000。 */
  perConversationEvents?: number;
  now?: () => Date;
}

// 审计第三阶段：events 与 command_receipts 只增不减会让 agent.db 无界增长。
// 并集保留：事件满足“在保留窗口内”或“属于该会话最新 perConversationEvents 条”之一即保留；
// 回执仅按时间窗保留。SSE 客户端遇到裁剪产生的 seq 空洞走既有 CURSOR_EXPIRED 全量重同步，
// 不依赖被删行存在。created_at 为固定宽度 UTC ISO 字符串，字典序即时间序。
export function trimAgentHistory(db: AgentDatabase, options: HistoryTrimOptions = {}): HistoryTrimResult {
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const perConversationEvents = options.perConversationEvents ?? 2_000;
  const cutoff = new Date((options.now ?? (() => new Date()))().getTime() - retentionMs).toISOString();
  const eventsDeleted = db.prepare(`DELETE FROM events WHERE created_at < ? AND seq IN (
    SELECT seq FROM (
      SELECT seq, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY seq DESC) AS recency FROM events
    ) WHERE recency > ?
  )`).run(cutoff, perConversationEvents).changes;
  const receiptsDeleted = db.prepare("DELETE FROM command_receipts WHERE created_at < ?").run(cutoff).changes;
  return { eventsDeleted, receiptsDeleted };
}

/** 后台定时裁剪：启动后先延迟执行一次，再按 intervalMs 周期执行。返回停止句柄。 */
export function scheduleHistoryTrim(
  db: AgentDatabase,
  log: { info: (message: string) => void; warn: (message: string) => void },
  options: HistoryTrimOptions & { intervalMs?: number; firstRunDelayMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const firstRunDelayMs = options.firstRunDelayMs ?? 30_000;
  const run = () => {
    try {
      const result = trimAgentHistory(db, options);
      if (result.eventsDeleted + result.receiptsDeleted > 0) {
        log.info(`历史裁剪完成：删除事件 ${result.eventsDeleted} 条、回执 ${result.receiptsDeleted} 条。`);
      }
    } catch (error) {
      log.warn(`历史裁剪失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const firstRun = setTimeout(run, firstRunDelayMs);
  firstRun.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => { clearTimeout(firstRun); clearInterval(timer); };
}
