import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, FileText, Search, X } from "lucide-react";
import type { ArtifactHead, ArtifactRevision, ContentSource, ReviewGroup, ReviewItem, Work } from "../../shared/agent/generated/contracts.js";
import { sameSource } from "./review-content.js";
import { ReviewContentSummary } from "./ReviewContentSummary.js";
import type { ReviewNavigation } from "./WorkStagePanel.js";

const PAGE_SIZE = 8;
const isPending = (item: ReviewItem) => item.draft !== null && !sameSource(item.draft, item.approved);
const counts = (work: Work) => {
  const items = work.reviewGroups.flatMap(group => group.items);
  return { pending: items.filter(isPending).length, approved: items.filter(item => item.approved).length };
};

export function WorkCenter({ works, selectedWorkId, onSelectWork, onOpenReview, revisions, onRevisionLoaded, artifacts, onOpenArtifact, hasMoreArtifacts = false, onMoreArtifacts, active = true, children }: {
  works: Work[]; selectedWorkId: string | null; onSelectWork: (id: string | null) => void;
  onOpenReview: (target: ReviewNavigation) => void; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded: (revision: ArtifactRevision) => void; artifacts: ArtifactHead[];
  onOpenArtifact: (id: string) => void; hasMoreArtifacts?: boolean; onMoreArtifacts?: () => void; children: ReactNode;
  active?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const needle = query.trim().toLocaleLowerCase();
  const matching = works.filter(work => (filter === "all" || (filter === "pending" ? counts(work).pending > 0 : counts(work).approved > 0))
    && (!needle || [work.title, ...work.reviewGroups.flatMap(group => [group.title, ...group.items.map(item => item.label)])].some(text => text.toLocaleLowerCase().includes(needle))));
  const visible = matching.slice(0, limit);
  const totals = matching.reduce((sum, work) => { const value = counts(work); return { pending: sum.pending + value.pending, approved: sum.approved + value.approved }; }, { pending: 0, approved: 0 });
  const bound = new Set(works.flatMap(work => work.reviewGroups.flatMap(group => group.items.flatMap(item => [item.draft, item.approved].flatMap(source => source?.kind === "artifact_revision" ? [source.artifactId] : [])))));
  const independent = artifacts.filter(artifact => !bound.has(artifact.id));
  const selected = works.find(work => work.id === selectedWorkId);
  const visited = useRef(false);
  if (selected) visited.current = true;
  const detail = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const previousSelection = useRef(selected?.id ?? null);
  useEffect(() => {
    const next = selected?.id ?? null;
    if (previousSelection.current === next) return;
    previousSelection.current = next;
    // 入口离开 DOM 后交接阅读位置；返回总览仍保留筛选与详情草稿。
    const target = next ? detail.current?.querySelector<HTMLElement>(".agent-work-heading h2") : search.current;
    target?.focus({ preventScroll: true });
  }, [selected?.id]);
  const openItem = (work: Work, group: ReviewGroup, item: ReviewItem, source: ContentSource) => onOpenReview({
    workId: work.id, groupId: group.id, itemId: item.id,
    ...(source.kind === "artifact_revision" ? { artifactId: source.artifactId, revisionId: source.revisionId } : { messageSource: source }),
  });
  return <div className="agent-work-center" data-view={selected ? "review" : "overview"}>
    <header className="agent-center-toolbar">
      {selected ? <button type="button" className="agent-center-back" onClick={() => onSelectWork(null)}><ArrowLeft />全部作品 <small>{works.length} 件</small></button>
        : <h2>本次对话的作品 <span>{matching.length} 件{matching.length !== works.length ? ` / 共 ${works.length} 件` : ""}</span></h2>}
      {selected ? <label className="agent-work-switch"><span className="agent-sr-only">切换作品</span><select aria-label="切换作品" value={selected.id} onChange={event => onSelectWork(event.target.value)}>{works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select></label>
        : <div className="agent-center-filters"><label className="agent-center-search"><Search /><input ref={search} aria-label="搜索作品和交付内容" placeholder="搜索作品或内容" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
          {query ? <button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); setLimit(PAGE_SIZE); }}><X /></button> : null}</label>
          <select aria-label="筛选作品" value={filter} onChange={event => { setFilter(event.target.value); setLimit(PAGE_SIZE); }}><option value="all">全部作品</option><option value="pending">有未确认</option><option value="approved">有已确认</option></select></div>}
    </header>
    {visited.current ? <div ref={detail} className="agent-center-detail" hidden={!selected}>{children}</div> : null}
    {!selected ? <div className="agent-center-overview">
      <div className="agent-board-headings">
        <h3><span className="agent-lane-marker" />未确认 <small>{totals.pending} 项</small></h3>
        <h3 className="approved"><span className="agent-lane-marker"><Check /></span>已确认 <small>{totals.approved} 项</small></h3>
      </div>
      <div className="agent-board-scroll">
        {!matching.length ? <div className="agent-center-empty" role="status"><Search /><h3>没有符合条件的作品</h3><button type="button" onClick={() => { setQuery(""); setFilter("all"); setLimit(PAGE_SIZE); }}>显示全部作品</button></div> : null}
        {visible.map(work => <section key={work.id} className="agent-work-row" aria-label={work.title}>
          <h4><button type="button" aria-label={`审阅${work.title}`} onClick={() => onSelectWork(work.id)}>{work.title}<ChevronRight /></button></h4>
          <div className="agent-work-row-content">
            {(["pending", "approved"] as const).map(kind => {
              const items = work.reviewGroups.flatMap(group => group.items.filter(item => kind === "pending" ? isPending(item) : item.approved !== null).map(item => ({ group, item })));
              return <section key={kind} className={`agent-work-deliveries ${kind}`} aria-label={`${work.title} · ${kind === "pending" ? "未确认" : "已确认"}`}>
                <div className="agent-delivery-grid">{items.slice(0, 3).map(({ group, item }) => <ReviewContentSummary key={`${group.id}:${item.id}`} active={active} item={item} group={group} source={(kind === "pending" ? item.draft : item.approved)!} approved={kind === "approved"} compact={kind === "approved"} revisions={revisions} onRevisionLoaded={onRevisionLoaded} onOpen={source => openItem(work, group, item, source)} />)}</div>
                {!items.length ? <p className="agent-lane-empty">{kind === "pending" ? "暂无待确认内容" : "认可后的内容会留在这里"}</p> : null}
                {items.length > 3 ? <button type="button" className="agent-delivery-more" onClick={() => onSelectWork(work.id)}>查看全部 {items.length} 项<ChevronRight /></button> : null}
              </section>;
            })}
          </div>
        </section>)}
        {matching.length > limit ? <button type="button" className="agent-center-more" onClick={() => setLimit(value => value + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, matching.length - limit)} 件作品 <span>{Math.min(limit, matching.length)} / {matching.length}</span></button> : null}
        {matching.length > 0 && !totals.pending && !totals.approved ? <p className="agent-center-waiting">作品已建立，Frame 交付的内容会出现在这里。</p> : null}
        {independent.length || hasMoreArtifacts ? <details className="agent-independent-outputs"><summary>对话中的其他产物 · {independent.length}</summary><div>{independent.map(artifact => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact.id)}><FileText />{artifact.title}<ChevronRight /></button>)}{hasMoreArtifacts ? <button type="button" onClick={onMoreArtifacts}>更多产物</button> : null}</div></details> : null}
      </div>
    </div> : null}
  </div>;
}
