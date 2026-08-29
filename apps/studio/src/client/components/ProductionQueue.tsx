import { ArrowRight, Clapperboard, Film, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  onDelete?: (run: StudioRunSummary) => Promise<void>;
}

export function ProductionQueue({ runs, loading, error, onRetry, onCreate, onDelete }: ProductionQueueProps) {
  const [filter, setFilter] = useState<"all" | "active" | "review" | "done">("all");
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<StudioRunSummary>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  const visibleRuns = useMemo(() => runs.filter((run) => {
    const needsAction = run.status === "needs_human"
      || run.status === "awaiting_spend_approval"
      || run.status === "approval_invalidated"
      || run.status === "stale";
    const matchesFilter = filter === "all"
      || (filter === "active" && (run.status === "pending" || run.status === "running"))
      || (filter === "review" && needsAction)
      || (filter === "done" && (run.status === "succeeded" || run.status === "failed" || run.status === "rejected"));
    return matchesFilter && run.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }), [filter, query, runs]);
  const displayedRuns = visibleRuns.slice(0, visibleCount);
  const activeCount = runs.filter((run) => run.status === "pending" || run.status === "running").length;
  const reviewCount = runs.filter((run) => run.status === "needs_human"
    || run.status === "awaiting_spend_approval"
    || run.status === "approval_invalidated"
    || run.status === "stale").length;
  const finishedCount = runs.filter((run) => run.status === "succeeded").length;
  const rejectedCount = runs.filter((run) => run.status === "rejected" || run.status === "failed").length;

  useEffect(() => setVisibleCount(12), [filter, query]);

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
          <div><span>待你处理</span><strong>{reviewCount}</strong></div>
          <div><span>已完成</span><strong>{finishedCount}</strong></div>
          <div><span>未通过</span><strong>{rejectedCount}</strong></div>
        </div>
        <div className="project-archive-heading">
          <div><p className="eyebrow">历史记录</p><h2 id="today-heading">制作记录</h2></div>
          <span>显示 {Math.min(visibleRuns.length, visibleCount)} 条，共 {runs.length} 条</span>
        </div>
        <div className="project-controls" aria-label="制作记录工具" data-tour="project-controls">
          <div className="project-filters" role="group" aria-label="制作筛选">
            {([
              ["all", "全部"],
              ["active", "制作中"],
              ["review", "待你处理"],
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
            {displayedRuns.map((run, index) => (
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
                  <div className="project-folio-actions">
                    <Link className="project-folio-action" to={`/projects/${run.id}`} aria-label={runAction(run) ? `${actionLabel(runAction(run)!)}：${run.title}` : `查看制作：${run.title}`}>
                      {runAction(run) ? actionLabel(runAction(run)!) : run.status === "succeeded" ? "查看成片" : "打开制作记录"}
                      <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                    {onDelete && isTerminal(run) ? (
                      <button className="icon-button project-delete" type="button" title="删除制作记录" aria-label={`删除制作记录：${run.title}`} onClick={() => { setDeleteError(undefined); setDeleteTarget(run); }}>
                        <Trash2 aria-hidden="true" size={16} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {displayedRuns.length < visibleRuns.length ? <button className="project-load-more" type="button" onClick={() => setVisibleCount((count) => count + 12)}>再显示 {Math.min(12, visibleRuns.length - displayedRuns.length)} 条</button> : null}
      </section>
      {deleteTarget ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="reject-dialog delete-run-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-run-title">
            <header className="dialog-header">
              <div><p className="eyebrow">删除制作记录</p><h2 id="delete-run-title">确定删除“{deleteTarget.title}”吗？</h2></div>
              <button className="icon-button" type="button" aria-label="关闭" disabled={deleting} onClick={() => setDeleteTarget(undefined)}><X aria-hidden="true" size={18} /></button>
            </header>
            <p className="delete-run-warning">脚本、素材记录、成片和费用明细会一起删除，无法恢复。</p>
            {deleteError ? <p className="form-error" role="alert">{deleteError}</p> : null}
            <footer className="dialog-actions">
              <button className="button button-secondary" type="button" disabled={deleting} onClick={() => setDeleteTarget(undefined)}>保留记录</button>
              <button className="button button-danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "正在删除..." : "确认删除"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || !onDelete) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(undefined);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(false);
    }
  }
}

function isTerminal(run: StudioRunSummary): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "rejected";
}

function actionLabel(action: NonNullable<StudioRunSummary["nextAction"]>): string {
  if (action === "confirm_spend") return "确认费用";
  if (action === "regenerate") return "确认后续生成";
  return "进入审片";
}

function runAction(run: StudioRunSummary): StudioRunSummary["nextAction"] {
  return run.status === "succeeded" || run.status === "failed" || run.status === "rejected"
    ? undefined
    : run.nextAction;
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
