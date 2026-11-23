import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, FileText, Search, X } from "lucide-react";
import type { ArtifactHead, ArtifactRevision, ContentSource, ReviewGroup, ReviewItem, ReviewRole, Work } from "../../shared/agent/generated/contracts.js";
import { sameSource, useNearViewport, useStageRevision } from "./review-content.js";
import { ReviewContentSummary } from "./ReviewContentSummary.js";
import { RevisionCover } from "./RevisionCover.js";
import type { ReviewNavigation } from "./WorkStagePanel.js";

const PAGE_SIZE = 8;
const isPending = (item: ReviewItem) => item.draft !== null && !sameSource(item.draft, item.approved);
const counts = (work: Work) => {
  const items = work.reviewGroups.flatMap(group => group.items);
  return { pending: items.filter(isPending).length, approved: items.filter(item => item.approved).length };
};

// UIUX-02 代表封面确定性梯子：只看事项角色，与修订是否已加载无关，异步返回不改变封面选择；
// subtitle 的封面即字幕摘录文本，与文稿同级；other 兜底同文本档。同分依赖稳定排序按事项原顺序取胜。
const COVER_ROLE_RANK: Record<ReviewRole, number> = {
  video: 6, clip: 5, storyboard: 4, scene: 4, character: 4,
  voice: 2, music: 2, plan: 1, content: 1, subtitle: 1, other: 1,
};

// 行封面自己按视口读取修订：即使代表媒体折叠在「另 N 项」里，也能拿到海报与时长，不会永久停在「读取中…」。
function WorkRowCover({ source, revisions, onRevisionLoaded, active }: {
  source: ContentSource | null; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded: (revision: ArtifactRevision) => void; active: boolean;
}) {
  const [coverRef, visible] = useNearViewport<HTMLSpanElement>();
  const { revision, error } = useStageRevision(visible ? source : null, revisions, onRevisionLoaded, active);
  return <RevisionCover ref={coverRef} revision={revision} source={source} unavailable={error} />;
}

export function WorkCenter({ works, selectedWorkId, onSelectWork, onOpenReview, revisions, onRevisionLoaded, artifacts, onOpenArtifact, hasMoreArtifacts = false, onMoreArtifacts, hasMoreWorks = false, onMoreWorks, active = true, children, toolbar }: {
  works: Work[]; selectedWorkId: string | null; onSelectWork: (id: string | null) => void;
  onOpenReview: (target: ReviewNavigation) => void; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded: (revision: ArtifactRevision) => void; artifacts: ArtifactHead[];
  onOpenArtifact: (id: string) => void; hasMoreArtifacts?: boolean; onMoreArtifacts?: () => void;
  /** 服务端还有更早的作品：快照只载最新一页，数量与搜索都不得当作全集。 */
  hasMoreWorks?: boolean; onMoreWorks?: () => void;
  children: ReactNode; active?: boolean; toolbar?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expandedLanes, setExpandedLanes] = useState<Record<string, boolean>>({});
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
    const target = next ? detail.current?.closest(".agent-work-center")?.querySelector<HTMLElement>(".agent-center-toolbar h2") : search.current;
    target?.focus({ preventScroll: true });
  }, [selected?.id]);
  const openItem = (work: Work, group: ReviewGroup, item: ReviewItem, source: ContentSource) => onOpenReview({
    workId: work.id, groupId: group.id, itemId: item.id,
    ...(source.kind === "artifact_revision" ? { artifactId: source.artifactId, revisionId: source.revisionId } : { messageSource: source }),
  });
  return <div className="agent-work-center" data-view={selected ? "review" : "overview"}>
    <header className="agent-center-toolbar">
      {selected ? <><button type="button" className="agent-center-back" aria-label={`全部作品 ${works.length} 件`} onClick={() => onSelectWork(null)}><ArrowLeft />全部作品 <small>{works.length} 件</small></button>
        <div className="agent-work-switch"><h2 tabIndex={-1} className="agent-current-work-title" title={selected.title}>{selected.title}</h2>
          <select aria-label="切换作品" title="切换作品" value={selected.id} onChange={event => onSelectWork(event.target.value)}>{works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select></div></>
        : <h2>本次对话的作品 <span>{matching.length} 件{hasMoreWorks ? ` / 已载 ${works.length} 件，还有更早` : matching.length !== works.length ? ` / 共 ${works.length} 件` : ""}</span></h2>}
      {selected ? null
        : <div className="agent-center-filters"><label className="agent-center-search"><Search /><input ref={search} aria-label="搜索作品和交付内容" placeholder="搜索作品或内容" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
          {query ? <button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); setLimit(PAGE_SIZE); }}><X /></button> : null}</label>
          <select aria-label="筛选作品" value={filter} onChange={event => { setFilter(event.target.value); setLimit(PAGE_SIZE); }}><option value="all">全部作品</option><option value="pending">有未确认</option><option value="approved">有已确认</option></select></div>}
      {toolbar}
    </header>
    {visited.current ? <div ref={detail} className="agent-center-detail" hidden={!selected}>{children}</div> : null}
    {!selected ? <div className="agent-center-overview">
      <div className="agent-board-headings">
        <h3>作品</h3>
        <h3><span className="agent-lane-marker" />未确认 <small>{totals.pending} 项</small></h3>
        <h3 className="approved"><span className="agent-lane-marker"><Check /></span>已确认 <small>{totals.approved} 项</small></h3>
      </div>
      <div className="agent-board-scroll">
        {!matching.length ? <div className="agent-center-empty" role="status"><Search /><h3>{hasMoreWorks ? "已载作品里没有符合条件的" : "没有符合条件的作品"}</h3>{hasMoreWorks ? <button type="button" onClick={() => onMoreWorks?.()}>在更早的作品中搜索</button> : null}<button type="button" onClick={() => { setQuery(""); setFilter("all"); setLimit(PAGE_SIZE); }}>显示全部作品</button></div> : null}
        {visible.map(work => {
          const cover = work.reviewGroups.flatMap(group => group.items)
            .filter(item => (item.draft ?? item.approved) !== null)
            .sort((a, b) => COVER_ROLE_RANK[b.role] - COVER_ROLE_RANK[a.role])[0] ?? null;
          const coverSource = cover?.draft ?? cover?.approved ?? null;
          const progress = counts(work);
          return <section key={work.id} className="agent-work-row" aria-label={work.title}>
          <h4><button type="button" aria-label={`审阅${work.title}`} onClick={() => onSelectWork(work.id)}>
            <WorkRowCover source={coverSource} revisions={revisions} onRevisionLoaded={onRevisionLoaded} active={active} />
            <span className="agent-row-title">{work.title}</span>
            <span className="agent-row-progress">{progress.pending > 0 ? `${progress.pending} 项待确认` : progress.approved > 0 ? "全部已确认" : "暂无交付内容"}</span></button></h4>
          <div className="agent-work-row-content">
            {(["pending", "approved"] as const).map(kind => {
              const items = work.reviewGroups.flatMap(group => group.items.filter(item => kind === "pending" ? isPending(item) : item.approved !== null).map(item => ({ group, item })))
                .sort((a, b) => Number(b.item.role === "video") - Number(a.item.role === "video"));
              return <section key={kind} className={`agent-work-deliveries ${kind}`} aria-label={`${work.title} · ${kind === "pending" ? "未确认" : "已确认"}`}>
                <div className="agent-delivery-grid">{(expandedLanes[`${work.id}:${kind}`] ? items : items.slice(0, 2)).map(({ group, item }) => <ReviewContentSummary key={`${group.id}:${item.id}`} active={active} item={item} group={group} source={(kind === "pending" ? item.draft : item.approved)!} approved={kind === "approved"} revisions={revisions} onRevisionLoaded={onRevisionLoaded} rowCover={coverSource} onOpen={source => openItem(work, group, item, source)} />)}</div>
                {!items.length ? <p className="agent-lane-empty">{kind === "pending" ? "暂无待确认内容" : "认可后的内容会留在这里"}</p> : null}
                {items.length > 2 ? <button type="button" className="agent-delivery-more" aria-expanded={!!expandedLanes[`${work.id}:${kind}`]} onClick={() => setExpandedLanes(old => ({ ...old, [`${work.id}:${kind}`]: !old[`${work.id}:${kind}`] }))}>{expandedLanes[`${work.id}:${kind}`] ? "收起" : `另 ${items.length - 2} 项`}<ChevronRight /></button> : null}
              </section>;
            })}
          </div>
        </section>; })}
        {matching.length > limit ? <button type="button" className="agent-center-more" onClick={() => setLimit(value => value + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, matching.length - limit)} 件作品 <span>{Math.min(limit, matching.length)} / {matching.length}</span></button> : null}
        {matching.length <= limit && hasMoreWorks ? <button type="button" className="agent-center-more" onClick={() => onMoreWorks?.()}>载入更早的作品</button> : null}
        {matching.length > 0 && !totals.pending && !totals.approved ? <p className="agent-center-waiting">作品已建立，Frame 交付的内容会出现在这里。</p> : null}
        {independent.length || hasMoreArtifacts ? <details className="agent-independent-outputs"><summary>对话中的其他产物 · {independent.length}</summary><div>{independent.map(artifact => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact.id)}><FileText />{artifact.title}<ChevronRight /></button>)}{hasMoreArtifacts ? <button type="button" onClick={onMoreArtifacts}>更多产物</button> : null}</div></details> : null}
      </div>
    </div> : null}
  </div>;
}
