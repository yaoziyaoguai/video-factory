import { useEffect, useRef, useState } from "react";
import type { ContentSource, ReviewApprovalHistoryPage, ReviewItem } from "../../shared/agent/generated/contracts.js";
import { agentApi } from "./api.js";

export function ReviewApprovalHistory({ workId, groupId, item, active, onOpen }: {
  workId: string; groupId: string; item: ReviewItem; active: boolean;
  onOpen: (source: ContentSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ReviewApprovalHistoryPage | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setPage(null); setError(false); setLoading(false);
    if (!active || !open) return;
    setLoading(true);
    void agentApi.reviewApprovalHistory(workId, groupId, item.id).then(result => {
      if (epoch.current === current) setPage(result);
    }).catch(() => { if (epoch.current === current) setError(true); })
      .finally(() => { if (epoch.current === current) setLoading(false); });
    return () => { epoch.current++; };
  }, [workId, groupId, item.id, item.confirmationId, active, open, attempt]);
  const loadMore = async () => {
    if (loading || !page?.nextCursor) return;
    const current = epoch.current;
    setLoading(true); setError(false);
    try {
      const next = await agentApi.reviewApprovalHistory(workId, groupId, item.id, page.nextCursor);
      if (epoch.current === current) setPage(previous => previous ? { items: [...previous.items, ...next.items], nextCursor: next.nextCursor } : next);
    } catch { if (epoch.current === current) setError(true); }
    finally { if (epoch.current === current) setLoading(false); }
  };
  const previous = page?.items.filter(entry => entry.confirmationId !== item.confirmationId) ?? [];
  return <details className="agent-approval-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>此前认可记录</summary>
    {open ? <div>{previous.map(entry => <button key={entry.confirmationId} type="button" onClick={() => onOpen(entry.source)}>
      {entry.action === "finalize_video" ? "此前定稿" : "此前认可"} {entry.source.kind === "message_text" ? "聊天原文" : entry.revisionNumber ? `v${entry.revisionNumber}` : "版本"}
      <time dateTime={entry.approvedAt}>{new Date(entry.approvedAt).toLocaleDateString("zh-CN")}</time>
    </button>)}
      {loading ? <p role="status">正在读取认可记录…</p> : null}
      {error ? <p role="status">认可记录读取失败。<button type="button" onClick={() => page ? void loadMore() : setAttempt(value => value + 1)}>重试读取记录</button></p> : null}
      {page && !previous.length && !page.nextCursor && !loading ? <p>没有更早的认可记录</p> : null}
      {page?.nextCursor && !error ? <button type="button" disabled={loading} onClick={() => void loadMore()}>更早的认可</button> : null}
    </div> : null}
  </details>;
}
