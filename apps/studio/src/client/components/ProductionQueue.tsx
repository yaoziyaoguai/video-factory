import { ArrowRight, Clapperboard, Film, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { StatusBadge } from "./StatusBadge.js";
import { platformLabel, RUN_NODE_ORDER, runNodeLabel } from "../presentation.js";

interface ProductionQueueProps {
  runs: StudioRunSummary[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  onCreate: () => void;
}

export function ProductionQueue({ runs, loading, error, onRetry, onCreate }: ProductionQueueProps) {
  const [filter, setFilter] = useState<"all" | "active" | "review" | "done">("all");
  const [query, setQuery] = useState("");
  const visibleRuns = useMemo(() => runs.filter((run) => {
    const matchesFilter = filter === "all"
      || (filter === "active" && (run.status === "pending" || run.status === "running"))
      || (filter === "review" && run.status === "needs_human")
      || (filter === "done" && (run.status === "succeeded" || run.status === "failed" || run.status === "rejected"));
    return matchesFilter && run.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }), [filter, query, runs]);
  const activeCount = runs.filter((run) => run.status === "pending" || run.status === "running").length;
  const reviewCount = runs.filter((run) => run.status === "needs_human").length;
  const finishedCount = runs.filter((run) => run.status === "succeeded").length;
  const rejectedCount = runs.filter((run) => run.status === "rejected" || run.status === "failed").length;

  return (
    <main className="page queue-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">制作档案</p>
          <h1>制作记录</h1>
          <p className="page-summary">从内容简报到发布包，查看每条视频的制作状态和下一步动作。</p>
        </div>
        <button className="button button-primary" type="button" onClick={onCreate} data-tour="project-create">
          <Plus aria-hidden="true" size={17} />
          新建制作
        </button>
      </header>

      <section className="queue-section" aria-labelledby="today-heading" data-tour="project-queue">
        <div className="project-edition" data-tour="project-overview">
          <div><span>制作中</span><strong>{activeCount}</strong></div>
          <div><span>等你审片</span><strong>{reviewCount}</strong></div>
          <div><span>已完成</span><strong>{finishedCount}</strong></div>
          <div><span>未通过</span><strong>{rejectedCount}</strong></div>
        </div>
        <div className="project-archive-heading">
          <div><p className="eyebrow">历史记录</p><h2 id="today-heading">制作记录</h2></div>
          <span>显示 {visibleRuns.length} 条，共 {runs.length} 条</span>
        </div>
        <div className="project-controls" aria-label="制作记录工具" data-tour="project-controls">
          <div className="project-filters" role="group" aria-label="制作筛选">
            {([
              ["all", "全部"],
              ["active", "制作中"],
              ["review", "等你审片"],
              ["done", "已结束"],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} aria-label={`筛选：${label}`} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <label className="project-search"><Search aria-hidden="true" size={14} /><span className="sr-only">搜索制作记录</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题" /></label>
        </div>
        {loading ? (
          <div className="queue-placeholder">正在读取制作记录...</div>
        ) : error ? (
          <div className="queue-error" role="alert">
            <Film aria-hidden="true" size={25} />
            <h3>制作记录读取失败</h3>
            <p>{error}</p>
            {onRetry ? <button className="button button-secondary" type="button" onClick={onRetry}>重试</button> : null}
          </div>
        ) : runs.length === 0 ? (
          <div className="empty-state">
            <Film aria-hidden="true" size={25} />
            <h3>还没有制作记录</h3>
            <p>从第一条短视频开始，系统会在这里保留全过程记录。</p>
            <button className="button button-secondary" type="button" onClick={onCreate}>
              <Plus aria-hidden="true" size={17} />
              新建制作
            </button>
          </div>
        ) : visibleRuns.length === 0 ? (
          <div className="queue-placeholder">没有符合当前筛选条件的制作记录</div>
        ) : (
          <div className="production-archive" role="list" aria-label="视频制作记录">
            {visibleRuns.map((run, index) => (
              <article className="project-folio" role="listitem" key={run.id} {...(index === 0 ? { "data-tour": "project-item" } : {})}>
                <div className={`project-preview is-${run.status}`}>
                  {run.videoContentUrl ? (
                    <video aria-label={`${run.title} 成片预览`} muted playsInline preload="metadata" src={`${run.videoContentUrl}#t=0.1`} />
                  ) : (
                    <div className="project-preview-placeholder" aria-hidden="true">
                      <Clapperboard size={22} />
                      <strong>{String(index + 1).padStart(2, "0")}</strong>
                    </div>
                  )}
                  <span>{run.durationSeconds} 秒</span>
                </div>
                <div className="project-folio-copy">
                  <div className="project-folio-meta">
                    <span>{platformLabel(run.platform)} · 9:16</span>
                    <time dateTime={run.startedAt}>{formatTime(run.startedAt)}</time>
                  </div>
                  <h3>{run.title}</h3>
                  <div className="project-folio-state"><StatusBadge status={run.status} /><span>{runNodeLabel(run.currentNodeId)}</span></div>
                  <RunProgress currentNodeId={run.currentNodeId} status={run.status} />
                  <Link className="project-folio-action" to={`/projects/${run.id}`} aria-label={run.nextAction === "review" ? `进入审片：${run.title}` : `查看制作：${run.title}`}>
                    {run.nextAction === "review" ? "进入审片" : run.status === "succeeded" ? "查看成片" : "打开制作记录"}
                    <ArrowRight aria-hidden="true" size={16} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function RunProgress({ currentNodeId, status }: Pick<StudioRunSummary, "currentNodeId" | "status">) {
  const currentIndex = Math.max(RUN_NODE_ORDER.indexOf(currentNodeId), 0);
  return (
    <div className="project-progress" aria-label={`当前工序：${runNodeLabel(currentNodeId)}`}>
      {RUN_NODE_ORDER.map((nodeId, index) => {
        const state = status === "succeeded" || index < currentIndex
          ? "complete"
          : index === currentIndex
            ? status === "failed" || status === "rejected" ? "failed" : "current"
            : "pending";
        return <span key={nodeId} className={`is-${state}`} title={runNodeLabel(nodeId)} />;
      })}
    </div>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
