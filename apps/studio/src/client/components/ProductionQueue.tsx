import { Archive, ArchiveRestore, ArrowRight, Check, Clapperboard, Film, Plus, Search, Trash2, X } from "lucide-react";
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
  onArchive?: (runs: StudioRunSummary[]) => Promise<void>;
  onRestore?: (runs: StudioRunSummary[]) => Promise<void>;
  onDelete?: (run: StudioRunSummary) => Promise<void>;
}

type QueueFilter = "all" | "active" | "review" | "done";
type QueueView = "current" | "archive";

export function ProductionQueue({ runs, loading, error, onRetry, onCreate, onArchive, onRestore, onDelete }: ProductionQueueProps) {
  const [view, setView] = useState<QueueView>("current");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<StudioRunSummary>();
  const [operationError, setOperationError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  const sortedRuns = useMemo(() => [...runs].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)), [runs]);
  const currentRuns = useMemo(() => sortedRuns.filter((run) => !run.archivedAt), [sortedRuns]);
  const archivedRuns = useMemo(() => sortedRuns.filter((run) => Boolean(run.archivedAt)), [sortedRuns]);
  const visibleRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const base = view === "archive" ? archivedRuns : currentRuns;
    const searched = base.filter((run) => run.title.toLocaleLowerCase().includes(normalizedQuery));
    if (view === "archive") return searched;
    const filtered = searched.filter((run) => matchesFilter(run, filter));
    if (filter !== "all" || normalizedQuery) return filtered;
    const active = filtered.filter((run) => !isTerminal(run));
    const recentCompleted = filtered.filter(isTerminal).slice(0, 6);
    return [...active, ...recentCompleted];
  }, [archivedRuns, currentRuns, filter, query, view]);
  const displayedRuns = visibleRuns.slice(0, visibleCount);
  const selectableRuns = visibleRuns.filter((run) => view === "archive" || isTerminal(run));
  const selectedRuns = selectableRuns.filter((run) => selectedIds.has(run.id));
  const activeCount = currentRuns.filter((run) => run.status === "pending" || run.status === "running").length;
  const reviewCount = currentRuns.filter(needsAction).length;
  const finishedCount = currentRuns.filter((run) => run.status === "succeeded").length;

  useEffect(() => setVisibleCount(12), [filter, query, view]);
  useEffect(() => {
    setSelectedIds(new Set());
    setOperationError(undefined);
  }, [filter, query, view]);

  return (
    <main className="page queue-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">制作档案</p>
          <h1>制作记录</h1>
          <p className="page-summary">当前工作只保留正在推进和最近完成的内容，旧项目随时可以从归档中找回。</p>
        </div>
        <button className="button button-primary project-create-button" type="button" onClick={onCreate} data-tour="project-create">
          <Plus aria-hidden="true" size={17} />
          新建制作
        </button>
      </header>

      <section className="queue-section" aria-labelledby="today-heading" data-tour="project-queue">
        <div className="project-edition" data-tour="project-overview">
          <div><span>制作中</span><strong>{activeCount}</strong></div>
          <div><span>待你处理</span><strong>{reviewCount}</strong></div>
          <div><span>近期完成</span><strong>{finishedCount}</strong></div>
          <div><span>已归档</span><strong>{archivedRuns.length}</strong></div>
        </div>
        <div className="project-archive-heading">
          <div>
            <p className="eyebrow">{view === "current" ? "正在发生" : "历史资料"}</p>
            <h2 id="today-heading">{view === "current" ? "当前制作" : "已归档"}</h2>
          </div>
          <div className="queue-view-switch" role="group" aria-label="制作记录视图">
            <button type="button" aria-pressed={view === "current"} onClick={() => setView("current")}>当前</button>
            <button type="button" aria-pressed={view === "archive"} onClick={() => setView("archive")}>归档 <span>{archivedRuns.length}</span></button>
          </div>
        </div>
        <div className="project-controls" aria-label="制作记录工具" data-tour="project-controls">
          {view === "current" ? (
            <div className="project-filters" role="group" aria-label="制作筛选">
              {([
                ["all", "重点"],
                ["active", "制作中"],
                ["review", "待你处理"],
                ["done", "已结束"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={filter === value} aria-label={`筛选：${label}`} onClick={() => setFilter(value)}>{label}</button>
              ))}
            </div>
          ) : <p className="archive-caption">归档只整理列表，不会移动成片或素材。</p>}
          <label className="project-search"><Search aria-hidden="true" size={14} /><span className="sr-only">搜索制作记录</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "archive" ? "搜索归档" : "搜索标题"} /></label>
        </div>
        {selectedRuns.length > 0 ? (
          <div className="queue-selection" role="status">
            <span><Check aria-hidden="true" size={15} />已选 {selectedRuns.length} 条</span>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void organize(selectedRuns)}>
              {view === "archive" ? <ArchiveRestore aria-hidden="true" size={16} /> : <Archive aria-hidden="true" size={16} />}
              {busy ? "正在整理..." : view === "archive" ? "恢复到当前" : "批量归档"}
            </button>
            <button className="icon-button" type="button" aria-label="取消选择" disabled={busy} onClick={() => setSelectedIds(new Set())}><X aria-hidden="true" size={16} /></button>
          </div>
        ) : null}
        {operationError ? <p className="form-error queue-operation-error" role="alert">{operationError}</p> : null}
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
            <button className="button button-secondary" type="button" onClick={onCreate}><Plus aria-hidden="true" size={17} />新建制作</button>
          </div>
        ) : visibleRuns.length === 0 ? (
          <div className="queue-placeholder">{view === "archive" ? "归档还是空的" : "没有符合当前筛选条件的制作记录"}</div>
        ) : (
          <div className="production-archive" role="list" aria-label={view === "archive" ? "已归档视频制作记录" : "当前视频制作记录"}>
            {displayedRuns.map((run, index) => (
              <article className="project-folio" role="listitem" key={run.id} {...(index === 0 ? { "data-tour": "project-item" } : {})}>
                {(view === "archive" || isTerminal(run)) ? (
                  <label className="queue-select-run">
                    <input type="checkbox" checked={selectedIds.has(run.id)} onChange={() => toggleSelected(run.id)} />
                    <span className="sr-only">选择制作记录：{run.title}</span>
                  </label>
                ) : null}
                <div className={`project-preview is-${run.status}`}>
                  {run.videoContentUrl ? (
                    <video aria-label={`${run.title} 成片预览`} muted playsInline preload="metadata" src={`${run.videoContentUrl}#t=0.1`} />
                  ) : (
                    <div className="project-preview-placeholder" aria-hidden="true"><Clapperboard size={22} /><strong>{String(index + 1).padStart(2, "0")}</strong></div>
                  )}
                  <span>目标 {run.durationSeconds} 秒</span>
                </div>
                <div className="project-folio-copy">
                  <div className="project-folio-meta">
                    <span>{platformLabel(run.platform)} · 9:16</span>
                    <time dateTime={run.archivedAt ?? run.startedAt}>{run.archivedAt ? `归档于 ${formatTime(run.archivedAt)}` : formatTime(run.startedAt)}</time>
                  </div>
                  <h3>{run.title}</h3>
                  <div className="project-folio-state"><StatusBadge status={run.status} /><span>{runNodeLabel(run.currentNodeId)}</span></div>
                  <RunProgress currentNodeId={run.currentNodeId} status={run.status} />
                  <div className="project-folio-actions">
                    <Link className="project-folio-action" to={`/projects/${run.id}`} aria-label={runAction(run) ? `${actionLabel(runAction(run)!)}：${run.title}` : `查看制作：${run.title}`}>
                      {runAction(run) ? actionLabel(runAction(run)!) : run.status === "succeeded" ? "查看成片" : "打开制作记录"}
                      <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                    {view === "current" && onArchive && isTerminal(run) ? (
                      <button className="icon-button" type="button" title="归档" aria-label={`归档制作记录：${run.title}`} disabled={busy} onClick={() => void organize([run])}><Archive aria-hidden="true" size={16} /></button>
                    ) : null}
                    {view === "archive" && onRestore ? (
                      <button className="icon-button" type="button" title="恢复到当前" aria-label={`恢复制作记录：${run.title}`} disabled={busy} onClick={() => void organize([run])}><ArchiveRestore aria-hidden="true" size={16} /></button>
                    ) : null}
                    {view === "archive" && onDelete ? (
                      <button className="icon-button project-delete" type="button" title="永久删除" aria-label={`永久删除制作记录：${run.title}`} onClick={() => { setOperationError(undefined); setDeleteTarget(run); }}><Trash2 aria-hidden="true" size={16} /></button>
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
              <div><p className="eyebrow">永久删除</p><h2 id="delete-run-title">确定删除“{deleteTarget.title}”吗？</h2></div>
              <button className="icon-button" type="button" aria-label="关闭" disabled={busy} onClick={() => setDeleteTarget(undefined)}><X aria-hidden="true" size={18} /></button>
            </header>
            <p className="delete-run-warning">这会删除该项目的脚本、制作文件、成片和费用明细，无法恢复。仅想整理列表时请保留在归档中。</p>
            {operationError ? <p className="form-error" role="alert">{operationError}</p> : null}
            <footer className="dialog-actions">
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>保留归档</button>
              <button className="button button-danger" type="button" disabled={busy} onClick={() => void confirmDelete()}>{busy ? "正在删除..." : "永久删除"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );

  function toggleSelected(runId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  async function organize(targets: StudioRunSummary[]): Promise<void> {
    const operation = view === "archive" ? onRestore : onArchive;
    if (!operation || targets.length === 0) return;
    setBusy(true);
    setOperationError(undefined);
    try {
      await operation(targets);
      setSelectedIds(new Set());
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || !onDelete) return;
    setBusy(true);
    setOperationError(undefined);
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(undefined);
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
}

function needsAction(run: StudioRunSummary): boolean {
  return run.status === "needs_human"
    || run.status === "awaiting_spend_approval"
    || run.status === "approval_invalidated"
    || run.status === "stale";
}

function matchesFilter(run: StudioRunSummary, filter: QueueFilter): boolean {
  return filter === "all"
    || (filter === "active" && (run.status === "pending" || run.status === "running"))
    || (filter === "review" && needsAction(run))
    || (filter === "done" && isTerminal(run));
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
  return isTerminal(run) ? undefined : run.nextAction;
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
