import { memo, useEffect, useState } from "react";
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

export function TaskProgress({ submission, activeRequestId, messages, progress, contextStatus, runs, works = [], disconnected = false, compact = false, showIdle = false, onStop, onOpenRun, onOpenWork, onOpenChat }: {
  activeRequestId: string | null; messages: Message[]; progress: RequestProgress | null; runs: Run[]; works?: Work[];
  contextStatus?: ContextStatus | null; submission?: string | null;
  disconnected?: boolean; compact?: boolean; showIdle?: boolean; onStop: () => Promise<boolean>; onOpenRun: (runId: string) => void;
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
    // HTTP 受理前，只展示客户端正在做的事。真实队列或 Pi 有进展后由下面的状态接管。
    if (submission) return <section className={`agent-task-progress${compact ? " compact" : ""}`} aria-label="提交状态">
      <ActivityIndicator label={submission} /><span role="status">{submission}</span>
    </section>;
    if (disconnected) return <span className="agent-quiet-state" role="status"><WifiOff />进展暂未同步</span>;
    const latest = messages.filter(message => message.role === "user" && message.requestId).at(-1);
    return latest && (latest.state === "failed" || latest.state === "stopped")
      ? <section className={`agent-task-progress${compact ? " compact" : ""}`} aria-label="本轮结果"><span role="status">{latest.state === "failed" ? "本轮未完成，消息已保留。" : "本轮已停止，已完成的内容保留。"}</span>{onOpenChat ? <button type="button" onClick={onOpenChat}>查看对话</button> : null}</section>
      : showIdle ? <span className="agent-quiet-state" role="status"><span />当前空闲</span> : null;
  }
  const current = progress?.requestId === activeRequestId ? progress : active?.execution?.progress ?? null;
  const workId = current?.workId ?? active?.reviewContext?.workId;
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

const completedResults = {
  finished: { label: "已完成", Icon: Check },
  timeout: { label: "已提前结束（超过时间上限）", Icon: TriangleAlert },
  tool_limit: { label: "已提前结束（达到工具调用上限）", Icon: TriangleAlert },
  unknown: { label: "本轮已结束", Icon: Clock3 },
};

// UIUX-05 执行记录只读取各步骤归属作品的标题：works 数组换引用但用到的标题不变时跳过重渲染。
export function areExecutionRecordPropsEqual(prev: { message: Message; works?: Work[] }, next: { message: Message; works?: Work[] }): boolean {
  if (prev.message !== next.message) return false;
  const ids = new Set(next.message.execution?.progress.steps?.flatMap(step => step.workId ? [step.workId] : []) ?? []);
  if (next.message.reviewContext?.workId) ids.add(next.message.reviewContext.workId);
  const title = (works: Work[] | undefined, id: string) => works?.find(work => work.id === id)?.title;
  for (const id of ids) if (title(prev.works, id) !== title(next.works, id)) return false;
  return true;
}

export const ExecutionRecord = memo(function ExecutionRecord({ message, works = [] }: { message: Message; works?: Work[] }) {
  const execution = message.execution;
  if (message.role !== "user" || !execution || message.state === "running" || message.state === "queued") return null;
  const { label, Icon } = message.state === "completed" ? completedResults[execution.completionReason ?? "unknown"]
    : message.state === "stopped" ? { label: "已停止", Icon: Square } : { label: "未完成", Icon: TriangleAlert };
  const steps = execution.progress.steps ?? [];
  const duration = execution.endedAt ? elapsed(execution.startedAt, Date.parse(execution.endedAt)) : null;
  // UIUX-09 正常完成的纯对话回合没有可展开内容：渲染轻量静态落款，不用 <summary> 假装可展开。
  // completionReason 缺失的历史回合原因未知，仍走完整折叠，避免把旧的异常完成误标为正常完成。
  if (steps.length === 0 && message.state === "completed" && execution.completionReason === "finished") {
    const seconds = execution.endedAt ? Math.floor((Date.parse(execution.endedAt) - Date.parse(execution.startedAt)) / 1000) : 0;
    return <p className="agent-execution-static"><Icon />已完成{seconds >= 5 && duration ? <time>{duration}</time> : null}</p>;
  }
  // 摘要优先取最后一个可归属作品的已完成步骤：收尾的只读核对步骤常无 workId，
  // 机械取末位会让长对话扫过去全是“核对作品版本”而非真正交付动作。
  const headline = [...steps].reverse().find(step => step.state === "completed" && step.workId) ?? steps.at(-1);
  const owner = works.find(work => work.id === (headline?.workId ?? message.reviewContext?.workId));
  const summary = headline ? [owner?.title, headline.label, `${steps.length} 项操作`].filter(Boolean).join(" · ") : "执行记录";
  return <details className="agent-execution-record">
    <summary aria-label={`查看本轮执行记录：${label}`} aria-description={summary} title={summary}>
      <Icon />
      <span className="agent-execution-summary">{summary}</span><span>{label}</span>{duration ? <time>{duration}</time> : null}<ChevronDown />
    </summary>
    {steps.length ? <ol className="agent-task-steps" aria-label="本轮实际执行步骤">{steps.map(step => <li key={step.id} data-state={step.state}>
      {step.state === "completed" ? <Check /> : step.state === "failed" ? <TriangleAlert /> : <Square />}
      <span>{step.label}<small>{step.state === "completed" ? "已完成" : step.state === "failed" ? "未完成" : "结束前未取得完成回执"}</small>
        {step.workId ? <span className="agent-execution-work">{works.find(work => work.id === step.workId)?.title ?? "关联作品未载入"}</span> : null}
      </span>
    </li>)}</ol> : <p>这轮没有执行工具操作。</p>}
    {steps.length === 8 ? <p>保留最近 8 项实际操作。</p> : null}
  </details>;
}, areExecutionRecordPropsEqual);
