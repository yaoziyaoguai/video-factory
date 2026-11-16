import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, FileText, Film, Image, Layers, Music2, Play, Search, X } from "lucide-react";
import type { ArtifactHead, ArtifactRevision, ContentSource, ReviewGroup, ReviewItem, Work } from "../../shared/agent/generated/contracts.js";
import { sameSource, useStageRevision, type ReviewNavigation } from "./WorkStagePanel.js";

const PAGE_SIZE = 8;
const isPending = (item: ReviewItem) => item.draft !== null && !sameSource(item.draft, item.approved);
const blobUrl = (id: string) => `/api/agent/v1/blobs/${encodeURIComponent(id)}/content`;
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
  const strip = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const previousSelection = useRef(selected?.id ?? null);
  useEffect(() => {
    const next = selected?.id ?? null;
    if (previousSelection.current === next) return;
    previousSelection.current = next;
    // 入口卡片会离开 DOM，明确把键盘阅读位置带到内容；返回时落到搜索框。
    const target = next ? detail.current?.querySelector<HTMLElement>(".agent-work-heading h2") : search.current;
    target?.focus({ preventScroll: true });
  }, [selected?.id]);
  useEffect(() => {
    strip.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedWorkId]);
  const openItem = (work: Work, group: ReviewGroup, item: ReviewItem, source: ContentSource) => onOpenReview({
    workId: work.id, groupId: group.id, itemId: item.id,
    ...(source.kind === "artifact_revision" ? { artifactId: source.artifactId, revisionId: source.revisionId } : {}),
  });
  return <div className="agent-work-center">
    <header className="agent-center-toolbar">
      {selected ? <button type="button" className="agent-center-back" onClick={() => onSelectWork(null)}><ArrowLeft />全部作品 <small>{works.length}</small></button>
        : <h2>对话中的作品 <span>{works.length}</span></h2>}
      {selected ? <select aria-label="切换作品" value={selected.id} onChange={event => onSelectWork(event.target.value)}>{works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select>
        : <div className="agent-center-filters"><label className="agent-center-search"><Search /><input ref={search} aria-label="搜索作品和交付内容" placeholder="搜索作品…" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
          {query ? <button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); setLimit(PAGE_SIZE); }}><X /></button> : null}</label>
          <select aria-label="筛选作品" value={filter} onChange={event => { setFilter(event.target.value); setLimit(PAGE_SIZE); }}><option value="all">全部状态</option><option value="pending">有未确认</option><option value="approved">有已确认</option></select></div>}
    </header>
    <nav className="agent-work-index" aria-label="对话作品"><div ref={strip}>
      {(selected ? works : visible).map(work => {
        const state = counts(work);
        const media = work.reviewGroups.flatMap(group => group.items).flatMap(item => [item.draft, item.approved]).flatMap(source => source?.kind === "artifact_revision" ? [revisions[`${source.artifactId}:${source.revisionId}`]] : []).find(revision => revision?.content.format === "media" && revision.content.mimeType.startsWith("image/"));
        return <button key={work.id} type="button" aria-label={`审阅${work.title}`} title={work.title} aria-pressed={selectedWorkId === work.id} onClick={() => onSelectWork(work.id)}>
          <span className="agent-work-index-icon">{media?.content.format === "media" ? <img src={blobUrl(media.content.blobId)} loading="lazy" alt="" /> : <Film />}</span>
          <span><strong>{work.title}</strong><small>{state.pending ? <><i />{state.pending} 项未确认</> : state.approved ? <><Check />已确认 {state.approved} 项</> : "等待交付"}</small></span><ChevronRight />
        </button>;
      })}
    </div></nav>
    {visited.current ? <div ref={detail} className="agent-center-detail" hidden={!selected}>{children}</div> : null}
    {!selected ? <div className="agent-center-overview">
      {!matching.length ? <div className="agent-center-empty" role="status"><Search /><h3>没有符合条件的作品</h3><button type="button" onClick={() => { setQuery(""); setFilter("all"); setLimit(PAGE_SIZE); }}>显示全部作品</button></div> : null}
      <div className="agent-review-board">
        {(["pending", "approved"] as const).map(kind => <section className={`agent-review-lane ${kind}`} key={kind} aria-label={kind === "pending" ? "未确认" : "已确认"}>
          <header><span className="agent-lane-marker">{kind === "approved" ? <Check /> : null}</span><h3>{kind === "pending" ? "未确认" : "已确认"}</h3><span>{totals[kind]}</span></header>
          <div className="agent-lane-scroll">
            {visible.map(work => {
              const items = work.reviewGroups.flatMap(group => group.items.filter(item => kind === "pending" ? isPending(item) : item.approved !== null).map(item => ({ group, item })));
              if (!items.length) return null;
              return <section key={work.id} className="agent-work-deliveries" aria-label={`${work.title} · ${kind === "pending" ? "未确认" : "已确认"}`}>
                <div className="agent-delivery-work"><button type="button" onClick={() => onSelectWork(work.id)}>{work.title}<ArrowUpRight /></button><span>{items.length}</span></div>
                {items.slice(0, 3).map(({ group, item }) => <DeliverySummary key={`${group.id}:${item.id}`} active={active} item={item} group={group} source={(kind === "pending" ? item.draft : item.approved)!} approved={kind === "approved"} revisions={revisions} onRevisionLoaded={onRevisionLoaded} onOpen={source => openItem(work, group, item, source)} />)}
                {items.length > 3 ? <button type="button" className="agent-delivery-more" onClick={() => onSelectWork(work.id)}>查看全部 {items.length} 项<ChevronRight /></button> : null}
              </section>;
            })}
            {!totals[kind] && matching.length ? <div className="agent-lane-empty">{kind === "pending" ? <Check /> : <Layers />}<p>{kind === "pending" ? "当前没有待确认的内容" : "确认过的版本会留在这里"}</p></div> : null}
            {totals[kind] > 0 && !visible.some(work => counts(work)[kind] > 0) ? <div className="agent-lane-empty"><p>这批作品暂无{kind === "pending" ? "未确认" : "已确认"}内容，后续作品还有 {totals[kind]} 项。</p><button type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>显示后续作品</button></div> : null}
          </div>
        </section>)}
      </div>
      {matching.length > limit ? <button type="button" className="agent-center-more" onClick={() => setLimit(value => value + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, matching.length - limit)} 件作品 <span>{limit} / {matching.length}</span></button> : null}
      {matching.length > 0 && !totals.pending && !totals.approved ? <p className="agent-center-waiting">作品已建立，Frame 交付的内容会出现在这里。</p> : null}
      {independent.length || hasMoreArtifacts ? <details className="agent-independent-outputs"><summary>对话中的其他产物 · {independent.length}</summary><div>{independent.map(artifact => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact.id)}><FileText />{artifact.title}<ChevronRight /></button>)}{hasMoreArtifacts ? <button type="button" onClick={onMoreArtifacts}>更多产物</button> : null}</div></details> : null}
    </div> : null}
  </div>;
}

function DeliverySummary({ item, group, source, approved, revisions, onRevisionLoaded, onOpen, active }: {
  item: ReviewItem; group: ReviewGroup; source: ContentSource; approved: boolean; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded: (revision: ArtifactRevision) => void; onOpen: (source: ContentSource) => void;
  active: boolean;
}) {
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [mediaError, setMediaError] = useState(false);
  // 总览仅读取靠近视口的准确修订；长对话不会一次打开所有正文和视频。
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "160px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);
  const { revision, error, retry } = useStageRevision(visible ? source : null, revisions, onRevisionLoaded, active);
  useEffect(() => setMediaError(false), [revision?.revisionId]);
  const content = revision?.content;
  const text = source.kind === "message_text" ? source.text : content?.format === "markdown" ? [content.text, ...content.sections?.slice(0, 2).map(section => `${section.title}\n${section.text}`) ?? []].join("\n") : null;
  const media = content?.format === "media" ? content : null;
  return <article ref={element} className="agent-delivery-card" data-state={approved ? "approved" : "pending"}>
    <button type="button" className="agent-delivery-open" onClick={() => onOpen(source)} aria-label={`${approved ? "查看已确认" : "审阅"}${item.label}${revision ? ` v${revision.revisionNumber}` : ""}`}>
      <div className="agent-delivery-title"><strong>{item.label}</strong>{revision ? <span>v{revision.revisionNumber}</span> : null}</div>
      <span className="agent-delivery-group">{group.title}</span>
      {media && !mediaError ? <div className="agent-delivery-preview">{media.mimeType.startsWith("image/") ? <img alt="" src={blobUrl(media.blobId)} loading="lazy" onError={() => setMediaError(true)} />
        : media.mimeType.startsWith("video/") ? <><video src={`${blobUrl(media.blobId)}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1} onError={() => setMediaError(true)} /><span className="agent-delivery-play"><Play /></span></> : <div className="agent-delivery-audio"><Music2 /><span>音频</span></div>}
        {media.durationMs !== null ? <span className="agent-delivery-duration">{Math.floor(media.durationMs / 60000)}:{Math.floor(media.durationMs / 1000 % 60).toString().padStart(2, "0")}</span> : null}</div>
        : text ? <p className="agent-delivery-excerpt">{text.slice(0, 260).replace(/^#{1,6}\s/gm, "")}</p>
        : <div className="agent-delivery-placeholder">{mediaError ? <><Image />预览暂不可用</> : error ? <><FileText />内容读取失败</> : content ? <><Layers />{content.format === "project" ? "制作工程" : "文件"}</> : <><FileText />{visible ? "正在读取…" : "打开查看内容"}</>}</div>}
      <div className="agent-delivery-footer"><span>{approved ? <><Check />{!sameSource(item.approved, item.draft) ? "已有新草稿" : "已确认"}</> : "审阅这版"}</span><ArrowUpRight /></div>
    </button>
    {error ? <button type="button" className="agent-delivery-retry" onClick={retry}>重新读取</button> : null}
  </article>;
}
