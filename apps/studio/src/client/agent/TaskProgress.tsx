import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock3, Square, TriangleAlert, WifiOff } from "lucide-react";
import type { ContextStatus, Message, RequestProgress, Run, Work } from "../../shared/agent/generated/contracts.js";

function elapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

// 无 value 的原生 progress 表达不确定进度；圆点仅负责视觉，不伪造完成比例。
export function ActivityIndicator({ label }: { label: string }) {
  return <span className="agent-activity-ring">
    <progress className="agent-sr-only" aria-label={label} />
    <svg viewBox="0 0 24 24" aria-hidden="true">{Array.from({ length: 8 }, (_, index) =>
      <circle key={index} cx="12" cy="3" r="1.65" fill="currentColor" opacity={(index + 1) / 8} transform={`rotate(${index * 45} 12 12)`} />)}</svg>
  </span>;
}

export function TaskProgress({ activeRequestId, messages, progress, contextStatus, runs, works = [], disconnected = false, compact = false, onStop, onOpenRun, onOpenWork, onOpenChat }: {
  activeRequestId: string | null; messages: Message[]; progress: RequestProgress | null; runs: Run[]; works?: Work[];
  contextStatus?: ContextStatus | null;
  disconnected?: boolean; compact?: boolean; onStop: () => Promise<boolean>; onOpenRun: (runId: string) => void;
  onOpenWork: (workId: string) => void;
  onOpenChat?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [stopping, setStopping] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const active = messages.find(message => message.role === "user" && message.requestId === activeRequestId);
  const queued = messages.filter(message => message.role === "user" && message.state === "queued" && message.requestId !== activeRequestId);
  const busy = Boolean(activeRequestId || queued.length || runs.length);
  useEffect(() => { setStopping(false); }, [activeRequestId]);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!busy || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, visible]);
  if (!busy) {
    const latest = messages.filter(message => message.role === "user" && message.requestId).at(-1);
    return latest && (latest.state === "failed" || latest.state === "stopped")
      ? <section className={`agent-task-progress${compact ? " compact" : ""}`} aria-label="本轮结果"><span role="status">{latest.state === "failed" ? "本轮未完成，消息已保留。" : "本轮已停止，已完成的内容保留。"}</span>{onOpenChat ? <button type="button" onClick={onOpenChat}>查看对话</button> : null}</section>
      : null;
  }
  const current = progress?.requestId === activeRequestId ? progress : null;
  const workId = current ? current.workId : active?.reviewContext?.workId;
  const work = works.find(item => item.id === workId);
  const scope = work ? `「${work.title}」` : "";
  const compacting = contextStatus?.requestId === activeRequestId && contextStatus?.phase === "compacting";
  const label = disconnected ? "进展暂未同步" : stopping ? "正在停止本轮"
    : compacting ? "正在整理会话历史"
    : current ? current.phase === "tool_completed" ? `${scope}${current.label}已完成，正在处理下一步`
      : current.phase === "tool_failed" ? `${scope}${current.label}未完成，正在处理结果`
      : `正在${scope ? `为${scope}` : ""}${current.label}`
    : activeRequestId ? "正在处理请求" : runs.length ? "后台制作中" : "等待开始";
  return <section className={`agent-task-progress${compact ? " compact" : ""}`} aria-label="当前进展" data-motion-paused={!visible || disconnected || undefined}>
    <details className="agent-task-disclosure" key={activeRequestId ?? "production"}>
      <summary className="agent-task-current" aria-label={label} title={label}>
      {disconnected ? <WifiOff /> : !activeRequestId ? <Clock3 /> : current?.phase === "tool_failed" ? <TriangleAlert /> : <ActivityIndicator label="Agent 正在执行" />}
      <span className="agent-task-heading"><strong role="status">{label}</strong></span><ChevronDown className="agent-task-chevron" />
      </summary>
      <div className="agent-task-detail">
        {current ? <p className="agent-task-updated">最近进展：{elapsed(current.updatedAt, now)} 前</p> : null}
    {current?.steps?.length ? <ol className="agent-task-steps" aria-label="最近执行步骤">{current.steps.map(step => {
      const owner = works.find(item => item.id === step.workId);
      return <li key={step.id} data-state={step.state}>
        {step.state === "completed" ? <Check /> : step.state === "failed" ? <TriangleAlert /> : <Clock3 />}
        <span>{step.label}<small>{step.state === "completed" ? "已完成" : step.state === "failed" ? "未完成" : disconnected ? "待同步" : "执行中"}</small></span>
        {owner ? <button type="button" onClick={() => onOpenWork(owner.id)} title={`查看${owner.title}`}>{owner.title}<ChevronRight /></button> : null}
      </li>;
    })}</ol> : null}
    {!current?.steps?.length && activeRequestId ? <p className="agent-task-wait">{compacting ? "历史正在整理，作品与确认记录保留。" : "模型响应后，工具操作会列在这里。"}</p> : null}
    {queued.length ? <details className="agent-task-queue"><summary>{queued.length} 条请求排队</summary><ol>
      {queued.map(message => <li key={message.id}><span>{message.text}</span><small>已等待 {elapsed(message.createdAt, now)}</small></li>)}
    </ol></details> : null}
    {runs.map(run => {
      const completed = run.operations.filter(operation => operation.state === "succeeded").length;
      const operation = run.operations.find(item => item.state === "running");
      const phase = run.state === "unknown" ? "执行结果待核实" : run.state === "cancel_requested" ? "正在确认停止结果"
        : run.state === "queued" ? "等待制作" : operation ? { video: "正在生成视频", image: "正在生成图片", speech: "正在生成配音", render: "正在渲染成片" }[operation.kind] : "制作中";
      return <div className="agent-task-run" key={run.id}>
        <button type="button" onClick={() => onOpenRun(run.id)}>{run.title}<ChevronRight /></button><span>{phase}</span>
        {run.operations.length ? <><progress value={completed} max={run.operations.length} aria-label={`${run.title}已完成步骤`} /><small>{completed}/{run.operations.length} 步骤</small></> : null}
        <small>提交后 {elapsed(run.createdAt, now)}</small>
      </div>;
    })}
      </div>
    </details>
    <div className="agent-task-footer"><div className="agent-task-time">{active ? <span>已用时 <time>{elapsed(active.createdAt, now)}</time></span> : null}
      {current ? <span>最近进展 <time>{elapsed(current.updatedAt, now)}</time> 前</span> : null}
      {queued.length ? <span>{queued.length} 条排队</span> : null}
    </div>
    {activeRequestId ? <button type="button" className="agent-stop" disabled={stopping} onClick={async () => {
      setStopping(true);
      if (!await onStop()) setStopping(false);
    }}><Square />{stopping ? "正在停止…" : "停止本轮"}</button> : null}</div>
  </section>;
}
