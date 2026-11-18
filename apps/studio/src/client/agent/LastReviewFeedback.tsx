import { useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { agentApi, type Message } from "./api.js";

export function LastReviewFeedback({ workId, groupId, itemId, refresh }: { workId: string; groupId: string; itemId: string; refresh: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Message | null | "loading" | "error">("loading");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setResult("loading");
    void agentApi.latestReviewFeedback(workId, groupId, itemId).then(({ message }) => {
      if (active) setResult(message);
    }).catch(() => { if (active) setResult("error"); });
    const dismiss = (event: PointerEvent) => {
      if (details.current && !details.current.contains(event.target as Node)) details.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => { active = false; document.removeEventListener("pointerdown", dismiss); };
  }, [open, workId, groupId, itemId, attempt, refresh]);
  return <details ref={details} className="agent-last-note" onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
    }}>
    <summary><MessageSquareText />上一条修改意见</summary>
    {open ? <div role="status">{result === "loading" ? "正在读取意见…" : result === "error" ? <>意见读取失败。<button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></> : result
      ? <><time dateTime={result.createdAt}>{new Date(result.createdAt).toLocaleString("zh-CN")}</time><p>{result.text}</p></> : "这项内容还没有已记录的修改意见。"}</div> : null}
  </details>;
}
