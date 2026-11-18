import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Columns2, Ellipsis, Pencil, X } from "lucide-react";
import { LastReviewFeedback } from "./LastReviewFeedback.js";
import { ReviewApprovalHistory } from "./ReviewApprovalHistory.js";
import { ReviewContentSummary } from "./ReviewContentSummary.js";
import { agentApi } from "./api.js";
import { blobUrl, sameSource, useStageRevision } from "./review-content.js";
export { sameSource, useStageRevision } from "./review-content.js";
import { MATERIAL_PROVIDER_LABELS } from "./material-labels.js";
import { MarkdownText } from "./markdown.js";
import { RevisionBody } from "./ProductionCards.js";
import { AudioSummaryView, MediaSourceDetails } from "./AudioSummaryView.js";
import { loadStageReading, saveStageReading, type StageRevisionRef } from "./workspace-state.js";
import type { FeedbackDrafts } from "./useFeedbackDrafts.js";
import type {
  ArtifactHead, ArtifactRevision, ContentSource, ContentSourceInput, MaterialBatch, MaterialBatchIndexItem,
  ReviewGroup, ReviewItem, RevisionRef, Run, RunSegment, Work,
} from "../../shared/agent/generated/contracts.js";

// 审阅画布：固定当前作品、事项和准确来源，右侧持续列出未确认与已确认。
// 认可/制作事实一律来自服务端投影，
// 本组件不维护业务状态机，也不自动推进下一组工作。

export interface ReviewNavigation { workId: string; groupId: string; itemId: string; artifactId?: string; revisionId?: string; messageSource?: Extract<ContentSource, { kind: "message_text" }>; }

export type ReviewAction = "approve" | "approve_and_continue" | "finalize_video";
export interface ReviewEntry { itemId: string; source: ContentSourceInput; }
export type AdoptPreview = (work: Work, group: ReviewGroup, item: ReviewItem, source: RevisionRef) => Promise<boolean>;

const SEGMENT_STATE_LABEL = { pending: "等待中", running: "制作中", succeeded: "已生成", failed: "未完成", cancelled: "已停止" } as const;

// 认可按钮的 subject 只按输入合同组装：消息原文去掉服务端派生的 author 字段。
export function contentSubjectInput(source: ContentSource): ContentSourceInput {
  return source.kind === "message_text"
    ? { kind: "message_text", messageId: source.messageId, text: source.text }
    : { kind: "artifact_revision", artifactId: source.artifactId, revisionId: source.revisionId, digest: source.digest };
}

// 事项当前稿是否已按这版认可（认可记录指向当前稿同一来源）。
const approvedCurrent = (item: ReviewItem) => item.draft != null && sameSource(item.approved, item.draft);

function sourceMatchesReading(source: ContentSource, reading: StageRevisionRef | null | undefined): boolean {
  if (!reading) return false;
  return source.kind === "message_text"
    ? "messageId" in reading && reading.messageId === source.messageId
    : "artifactId" in reading && reading.artifactId === source.artifactId && reading.revisionId === source.revisionId;
}

export function workReviewLabel(work: Work): string {
  const items = work.reviewGroups.flatMap(group => group.items);
  if (!items.length) return "审阅组";
  const pending = items.filter(item => item.draft != null && !sameSource(item.approved, item.draft)).length;
  if (pending) return `待认可 ${pending} 项`;
  const waiting = items.filter(item => item.draft == null && item.approved == null).length;
  if (waiting) return `等待产出 ${waiting} 项`;
  return "已认可";
}

export function StandaloneScriptApproval({ artifact, revisions, onRevisionLoaded }: {
  artifact: ArtifactHead; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded: (revision: ArtifactRevision) => void;
}) {
  const approval = artifact.standaloneApproval;
  const { revision, error, retry } = useStageRevision(approval
    ? { artifactId: artifact.id, revisionId: approval.revisionId } : null, revisions, onRevisionLoaded);
  return <section aria-label="已确认成果">
    <div className="agent-work-pane-title"><h3>已确认成果</h3>{revision ? <span>v{revision.revisionNumber}</span> : null}</div>
    {!approval ? <p className="agent-stage-empty">认可后的脚本会留在这里。</p> : <article className="agent-confirmed-stage">
      {approval.revisionId !== artifact.revisionId ? <p className="agent-stage-muted">新草稿讨论中，这份成果保持不变。</p> : null}
      {revision ? <RevisionBody content={revision.content} simulated={false} />
        : error ? <p role="status">成果读取失败。<button type="button" onClick={retry}>重新读取成果</button></p>
        : <p className="agent-stage-loading">正在读取成果…</p>}
    </article>}
  </section>;
}

interface BatchState {
  batch: MaterialBatch | null;
  error: string | null;
}

// 单个素材批次的可复现显示：按 batchId 读取详情，索引项只用于摘要标题；
// 索引外批次（历史消息点开）直接按所读详情渲染，不重发搜索。组审阅与无事项视图共用。
type AdoptMaterial = (batch: MaterialBatch, candidate: MaterialBatch["results"][number], index: number) => void;

export function MaterialBatchCard({ batchId, summary, open, onToggle, onAdopt, adoptDisabled = false, works, active = true }: {
  batchId: string;
  summary: MaterialBatchIndexItem | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  onAdopt?: AdoptMaterial | undefined;
  adoptDisabled?: boolean | undefined;
  works?: Work[];
  active?: boolean;
}) {
  const [state, setState] = useState<BatchState>({ batch: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!active || !open || (state.batch?.batchId === batchId && !state.error)) return;
    let disposed = false;
    setState({ batch: null, error: null });
    void agentApi.readMaterialBatch(batchId)
      .then(batch => { if (!disposed) setState({ batch, error: null }); })
      .catch(() => { if (!disposed) setState({ batch: null, error: "读取失败" }); });
    return () => { disposed = true; };
  }, [batchId, open, attempt, active]);
  const detail = state.batch?.batchId === batchId ? state.batch : null;
  const title = summary?.query.query || detail?.query.query || "（无关键词）";
  const kind = summary?.query.kind ?? detail?.query.kind;
  const resultCount = summary?.resultCount ?? detail?.results.length;
  const isOriginal = (summary?.messageId ?? detail?.messageId) != null;
  const workId = detail?.workId;
  return <details className="agent-batch" open={open}
    onToggle={event => onToggle((event.target as HTMLDetailsElement).open)}>
    <summary>
      <span>{title}</span>
      <small>{{ image: "图片", video: "视频", audio: "音乐" }[kind ?? "video"]} · {resultCount ?? "…"} 项{isOriginal ? " · 原始批次" : ""}</small>
    </summary>
    {works && detail ? <p className="agent-stage-muted">{workId ? `所属作品：${works.find(work => work.id === workId)?.title ?? "关联作品"}` : "对话独立素材"}</p> : null}
    {state.error ? <div className="agent-batch-error">{state.error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : !detail ? <div className="agent-batch-loading">正在读取…</div>
      : detail.results.length === 0 ? <div className="agent-batch-empty">这次搜索没有结果，批次仍保留在这里。</div>
      : <ol className="agent-batch-results">{detail.results.map((candidate, index) => <li key={candidate.candidateId}>
        {candidate.kind !== "audio" && candidate.previewUrl ? <img src={candidate.previewUrl} alt="" loading="lazy" /> : null}
        <div>
          <strong>{candidate.title || (candidate.kind === "audio" ? "曲名未注明" : "未命名素材")}</strong>
          {candidate.kind === "audio" ? <>
            <small>{candidate.durationMs !== null ? `${(candidate.durationMs / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒` : "时长未知"} · {candidate.vocalKind === "instrumental" ? "纯音乐（来源标注）" : candidate.vocalKind === "song" ? "歌曲（来源标注）" : "声乐未知"}{candidate.lyricsLanguage ? ` · 歌词语言：${candidate.lyricsLanguage}` : ""}</small>
            {candidate.previewUrl ? <audio key={candidate.previewUrl} controls preload="none" src={candidate.previewUrl} aria-label={`试听 ${candidate.title || `第 ${index + 1} 首音乐`}`}
              onError={() => setPreviewErrors(current => ({ ...current, [candidate.candidateId]: true }))} />
              : <small>采用后试听，完整下载成功后可播放。</small>}
            {previewErrors[candidate.candidateId] ? <p className="agent-field-error" role="status">音频预览加载失败，请查看来源；采用仍需完整下载。</p> : null}
            <MediaSourceDetails source={candidate} />
            {!candidate.attributionText ? <small>署名内容未记录，请核对来源许可。</small> : null}
            <button type="button" className="agent-batch-adopt" aria-label={`采用「${candidate.title || `第 ${index + 1} 首音乐`}」`} disabled={!onAdopt || adoptDisabled}
              onClick={() => onAdopt?.(detail, candidate, index)}>采用这首音乐</button>
          </> : <>
            <small>{candidate.kind === "video" ? "视频" : "图片"}{candidate.durationMs ? ` · ${Math.round(candidate.durationMs / 1000)} 秒` : ""}{candidate.width && candidate.height
              ? ` · ${candidate.dimensionsKind === "download" ? "可采用尺寸" : candidate.dimensionsKind === "source" || ["pixabay", "unsplash"].includes(candidate.provider) ? "来源图" : "来源尺寸"} ${candidate.width}×${candidate.height}` : ""}</small>
            <span className="agent-batch-source">{MATERIAL_PROVIDER_LABELS[candidate.provider] ?? "来源未注明"} · {candidate.creatorName ?? "作者未注明"}
              <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">原素材</a>
              <a href={candidate.licenseUrl} target="_blank" rel="noreferrer">许可</a>
            </span>
          </>}
        </div>
      </li>)}</ol>}
  </details>;
}

export function WorkStagePanel({
  conversationId, works, selectedWorkId, revisions, runs, materialBatches,
  onConfirmReview, onContinueReview, reviewBusyKeys, reviewRequests = {}, canContinueText, onOpenRun, onEnsureRun, referenceErrors, feedback, simulated, openBatchId,
  navigation, onOpenReview, active = true, onAdoptMaterial, adoptDisabled, onRevisionLoaded, onAdoptPreview, queueHint,
}: {
  conversationId: string; works: Work[]; selectedWorkId: string | null;
  navigation: ReviewNavigation | null; onOpenReview: (target: ReviewNavigation) => void; active?: boolean;
  revisions: Record<string, ArtifactRevision>; runs: Run[]; materialBatches: MaterialBatchIndexItem[];
  onAdoptMaterial?: AdoptMaterial | undefined; adoptDisabled?: boolean | undefined; onAdoptPreview: AdoptPreview;
  onConfirmReview: (work: Work, group: ReviewGroup, action: ReviewAction, entries: readonly ReviewEntry[], label: string) => Promise<boolean>;
  onContinueReview: (work: Work, group: ReviewGroup, label: string) => Promise<boolean>;
  reviewBusyKeys: readonly string[]; reviewRequests?: Readonly<Record<string, "queued" | "running">>;
  canContinueText: boolean; queueHint?: string | undefined;
  onOpenRun: (runId: string) => void; onEnsureRun: (runId: string) => void;
  referenceErrors: Record<string, string>; feedback: FeedbackDrafts; simulated: boolean; openBatchId: string | null;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined;
}) {
  const work = works.find(item => item.id === selectedWorkId) ?? works[0] ?? null;
  const [storedReading] = useState(() => loadStageReading(conversationId));
  const [shownGroups, setShownGroups] = useState(storedReading.groupByWork);
  const [shownItems, setShownItems] = useState(storedReading.itemByGroup);
  const [shownRevisions, setShownRevisions] = useState(storedReading.revisionByItem);
  const playbackPositions = useRef(new Map<string, number>());
  const [expandedBatch, setExpandedBatch] = useState<string | null>(storedReading.batchId);
  const [feedbackSegments, setFeedbackSegments] = useState<Record<string, { runId: string; segmentId: string } | null>>({});
  const group = work?.reviewGroups.find(candidate => candidate.id === shownGroups[work.id])
    ?? work?.reviewGroups.find(candidate => candidate.items.some(item => item.draft && !approvedCurrent(item)))
    ?? work?.reviewGroups[0] ?? null;
  const groupKey = `${work?.id ?? ""}:${group?.id ?? ""}`;
  const selectedItem = group?.items.find(item => item.id === shownItems[groupKey])
    ?? group?.items.find(item => item.draft && !approvedCurrent(item)) ?? group?.items[0] ?? null;
  // 保存具体事项，而不是“未确认第一项”；认可和后台新稿不会换掉正在看的画面。
  useEffect(() => {
    if (!work || !group || !selectedItem) return;
    if (shownGroups[work.id] !== group.id) setShownGroups(current => ({ ...current, [work.id]: group.id }));
    if (shownItems[groupKey] !== selectedItem.id) setShownItems(current => ({ ...current, [groupKey]: selectedItem.id }));
  }, [work?.id, group?.id, selectedItem?.id, groupKey, shownGroups, shownItems]);
  useEffect(() => {
    if (!navigation) return;
    setShownGroups(current => ({ ...current, [navigation.workId]: navigation.groupId }));
    setShownItems(current => ({ ...current, [`${navigation.workId}:${navigation.groupId}`]: navigation.itemId }));
    setShownRevisions(current => ({ ...current, [`${navigation.workId}:${navigation.groupId}:${navigation.itemId}`]: navigation.artifactId && navigation.revisionId
      ? { artifactId: navigation.artifactId, revisionId: navigation.revisionId } : navigation.messageSource ?? null }));
  }, [navigation]);
  useEffect(() => {
    saveStageReading(conversationId, { groupByWork: shownGroups, itemByGroup: shownItems, revisionByItem: shownRevisions, batchId: expandedBatch });
  }, [conversationId, shownGroups, shownItems, shownRevisions, expandedBatch]);
  useEffect(() => { if (openBatchId) setExpandedBatch(openBatchId); }, [openBatchId]);
  useEffect(() => {
    if (!active || !navigation) return;
    const frame = requestAnimationFrame(() => document.getElementById(`review-item-${navigation.workId}-${navigation.groupId}-${navigation.itemId}`)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [active, navigation]);
  if (!work) return null;
  const itemKey = selectedItem ? `${groupKey}:${selectedItem.id}` : "";
  const groupBusy = reviewBusyKeys.includes(groupKey);
  const continuing = reviewRequests[groupKey];
  const allItems = work.reviewGroups.flatMap(group => group.items.map(item => ({ group, item })))
    .sort((a, b) => Number(b.item.role === "video") - Number(a.item.role === "video"));
  const pending = allItems.filter(({ item }) => item.draft && !approvedCurrent(item));
  const confirmed = allItems.filter(({ item }) => item.approved);
  const waiting = allItems.filter(({ item }) => !item.draft && !item.approved);
  const groupComplete = Boolean(group?.items.length && group.items.filter(item => item.required).every(item => approvedCurrent(item) || (!item.draft && item.approved)));
  const nextItem = group?.items.find(item => item.id !== selectedItem?.id && item.draft && !approvedCurrent(item)) ?? null;
  const groupEntries = group?.items.filter(item => item.draft && !approvedCurrent(item)).map(item => ({ itemId: item.id, source: contentSubjectInput(item.draft!) })) ?? [];
  const groupUnread = group?.items.flatMap(item => {
    if (!item.draft) return item.required && !item.approved ? [`「${item.label}」还在等待产出`] : [];
    if (approvedCurrent(item)) return [];
    const shown = shownRevisions[`${groupKey}:${item.id}`];
    if (shown && !sourceMatchesReading(item.draft, shown)) return [`「${item.label}」正在看旧版`];
    if (item.draft.kind !== "artifact_revision") return [];
    return revisions[`${item.draft.artifactId}:${item.draft.revisionId}`] ? [] : [`「${item.label}」的最新稿还没打开`];
  }) ?? [];
  const openItem = (targetGroup: ReviewGroup, item: ReviewItem, source: ContentSource | null) => onOpenReview({
    workId: work.id, groupId: targetGroup.id, itemId: item.id,
    ...(source?.kind === "artifact_revision" ? { artifactId: source.artifactId, revisionId: source.revisionId } : source ? { messageSource: source } : {}),
  });
  const groupPicker = work.reviewGroups.length > 1 ? <select className="agent-group-picker" aria-label="审阅组" title="切换审阅组" value={group?.id ?? ""} onChange={event => setShownGroups(current => ({ ...current, [work.id]: event.target.value }))}>
    {work.reviewGroups.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
  </select> : null;
  return <section className="agent-work" data-work-id={work.id} aria-label={`创作：${work.title}`}>
    <div className="agent-work-canvas">
      <section className="agent-work-draft" aria-label="草稿与修改">
        {group && selectedItem ? <ReviewItemCard key={`${work.id}:${group.id}:${selectedItem.id}`} groupPicker={groupPicker} active={active} work={work} group={group} item={selectedItem}
          revisions={revisions} runs={runs} simulated={simulated} feedback={feedback} playbackPositions={playbackPositions.current}
          feedbackSegment={feedbackSegments[itemKey]} onPickSegment={segment => setFeedbackSegments(current => ({ ...current, [itemKey]: segment }))}
          referenceErrors={referenceErrors} onEnsureRun={onEnsureRun} onOpenRun={onOpenRun}
          onConfirmReview={onConfirmReview} onAdoptPreview={onAdoptPreview} groupBusy={groupBusy}
          onRevisionLoaded={onRevisionLoaded} viewingRevision={shownRevisions[itemKey] ?? null}
          onViewingRevision={ref => setShownRevisions(current => ({ ...current, [itemKey]: ref }))}
          onContinueReview={onContinueReview} canContinueText={canContinueText} continuing={continuing}
          queueHint={queueHint} groupComplete={groupComplete} nextItem={nextItem}
          groupUnread={groupUnread} hasGroupEntries={Boolean(groupEntries.length)}
          onApproveGroup={() => groupEntries.length && !groupUnread.length ? onConfirmReview(work, group, "approve", groupEntries, `「${group.title}」这一组我都认可了。`) : Promise.resolve(false)}
          onOpenItem={item => openItem(group, item, item.draft ?? item.approved)} />
          : <div className="agent-stage-empty">{groupPicker}这里会显示 Frame 为这件作品交付的审阅内容。</div>}
      </section>
      <aside className="agent-review-index" aria-label="作品确认状态">
        <section className="agent-review-index-section pending" aria-label="未确认" data-empty={!pending.length && !waiting.length || undefined}>
          <header><span className="agent-lane-marker" /><h3>未确认</h3><span>{pending.length} 项</span></header>
          <div className="agent-review-index-scroll">
            {pending.map(({ group, item }) => <ReviewContentSummary key={`${group.id}:${item.id}`} item={item} group={group} source={item.draft!} approved={false} compact active={active}
              selected={selectedItem?.id === item.id && sourceMatchesReading(item.draft!, shownRevisions[`${work.id}:${group.id}:${item.id}`])} revisions={revisions} onRevisionLoaded={onRevisionLoaded}
              onOpen={source => openItem(group, item, source)} />)}
            {!pending.length ? <p className="agent-index-empty">暂无待确认内容</p> : null}
            {waiting.map(({ group, item }) => <button type="button" className="agent-index-waiting" key={`${group.id}:${item.id}`} onClick={() => openItem(group, item, null)}>{item.label}<small>等待产出</small></button>)}
          </div>
        </section>
        <section className="agent-review-index-section approved" aria-label="已确认成果" data-empty={!confirmed.length || undefined}>
          <header><span className="agent-lane-marker"><Check /></span><h3>已确认</h3><span>{confirmed.length} 项</span></header>
          <div className="agent-review-index-scroll">
            {confirmed.map(({ group, item }) => <ReviewContentSummary key={`${group.id}:${item.id}`} item={item} group={group} source={item.approved!} approved compact active={active}
              selected={selectedItem?.id === item.id && sourceMatchesReading(item.approved!, shownRevisions[`${work.id}:${group.id}:${item.id}`])}
              accessibleLabel={`审阅已确认${item.label}`} revisions={revisions} onRevisionLoaded={onRevisionLoaded} onOpen={source => openItem(group, item, source)} />)}
            {group && selectedItem?.approved ? <ReviewApprovalHistory workId={work.id} groupId={group.id} item={selectedItem} active={active} onOpen={source => openItem(group, selectedItem, source)} /> : null}
            {!confirmed.length ? <p className="agent-index-empty">认可后的内容会保留在这里</p> : null}
          </div>
        </section>
        {materialBatches.length || openBatchId ? <details className="agent-draft-materials" open={Boolean(expandedBatch)}><summary>会话参考素材</summary>
          <div>{materialBatches.map(batch => <MaterialBatchCard key={batch.batchId} batchId={batch.batchId} summary={batch} works={works} active={active}
            open={expandedBatch === batch.batchId} onAdopt={onAdoptMaterial} adoptDisabled={adoptDisabled} onToggle={open => setExpandedBatch(open ? batch.batchId : null)} />)}
          {openBatchId && !materialBatches.some(batch => batch.batchId === openBatchId) ? <MaterialBatchCard batchId={openBatchId} summary={null} works={works} active={active} open onAdopt={onAdoptMaterial} adoptDisabled={adoptDisabled} onToggle={open => setExpandedBatch(open ? openBatchId : null)} /> : null}</div>
        </details> : null}
      </aside>
    </div>
  </section>;
}

function ReviewItemCard({ work, group, item, groupPicker, revisions, runs, simulated, feedback, active, playbackPositions,
  feedbackSegment: selectedSegment, onPickSegment, referenceErrors, onEnsureRun, onOpenRun, onConfirmReview, onAdoptPreview, groupBusy,
  viewingRevision, onViewingRevision, onRevisionLoaded, onContinueReview, canContinueText, continuing, queueHint, groupComplete, nextItem, onOpenItem, groupUnread, hasGroupEntries, onApproveGroup }: {
  work: Work; group: ReviewGroup; item: ReviewItem;
  active: boolean;
  groupPicker: ReactNode;
  playbackPositions: Map<string, number>;
  revisions: Record<string, ArtifactRevision>; runs: Run[]; simulated: boolean;
  feedback: FeedbackDrafts; feedbackSegment: { runId: string; segmentId: string } | null | undefined;
  onPickSegment: (segment: { runId: string; segmentId: string } | null) => void;
  referenceErrors: Record<string, string>;
  onEnsureRun: (runId: string) => void; onOpenRun: (runId: string) => void;
  onConfirmReview: (work: Work, group: ReviewGroup, action: ReviewAction, entries: readonly ReviewEntry[], label: string) => Promise<boolean>;
  groupBusy: boolean;
  onContinueReview: (work: Work, group: ReviewGroup, label: string) => Promise<boolean>;
  canContinueText: boolean; continuing: "queued" | "running" | undefined; queueHint: string | undefined;
  groupComplete: boolean; nextItem: ReviewItem | null; onOpenItem: (item: ReviewItem) => void;
  groupUnread: string[]; hasGroupEntries: boolean; onApproveGroup: () => Promise<boolean>;
  onAdoptPreview: AdoptPreview;
  viewingRevision: StageRevisionRef | null;
  onViewingRevision: (ref: StageRevisionRef | null) => void;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined;
}) {
  const draft = item.draft ?? item.approved;
  // 第一次阅读就保存准确引用；业务更新只用于提示，不决定用户正在看哪版。
  const draftRef = draft?.kind === "artifact_revision" ? { artifactId: draft.artifactId, revisionId: draft.revisionId } : null;
  const savedFeedback = feedback.forTarget(draftRef ? { ...draftRef, workId: work.id } : null);
  const feedbackSegment = selectedSegment === undefined ? savedFeedback.target?.segment ?? null : selectedSegment;
  useEffect(() => {
    if (active && selectedSegment === undefined && savedFeedback.target?.segment) onPickSegment(savedFeedback.target.segment);
  }, [active, selectedSegment, savedFeedback.target?.segment]);
  useEffect(() => {
    if (active && draft && !viewingRevision) onViewingRevision(draft.kind === "message_text" ? draft : { artifactId: draft.artifactId, revisionId: draft.revisionId });
  }, [draft, viewingRevision, active]);
  const displayedSource: ContentSource | null = viewingRevision
    ? "artifactId" in viewingRevision ? { kind: "artifact_revision", ...viewingRevision, digest: "" } : viewingRevision
    : draft;
  const read = useStageRevision(displayedSource, revisions, onRevisionLoaded, active);
  const revision = read.revision;
  const [compareOpen, setCompareOpen] = useState(false);
  const compareSource = compareOpen && revision?.baseRevisionId ? { artifactId: revision.artifactId, revisionId: revision.baseRevisionId } : null;
  const previous = useStageRevision(compareSource, revisions, onRevisionLoaded, active);
  const playbackTime = useRef(0);
  const playbackKey = revision ? `${revision.artifactId}:${revision.revisionId}` : "";
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setCompareOpen(false); playbackTime.current = playbackPositions.get(playbackKey) ?? 0; }, [playbackKey, playbackPositions]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackTrigger = useRef<HTMLButtonElement>(null);
  const onToggleFeedback = () => { setFeedbackOpen(true); requestAnimationFrame(() => feedbackInput.current?.focus()); };
  const closeFeedback = () => { setFeedbackOpen(false); feedbackTrigger.current?.focus(); };
  const [previousSelected, setPreviousSelected] = useState(false);
  const currentStage = useRef<HTMLElement>(null);
  const switchAt = useRef<{ time: number; playing: boolean } | null>(null);
  useEffect(() => { setPreviousSelected(false); switchAt.current = null; }, [playbackKey]);
  const mediaKind = (r: ArtifactRevision | null | undefined) => r?.content.format === "media" ? r.content.mimeType.split("/")[0] : null;
  const kind = mediaKind(revision);
  const synced = compareOpen && (kind === "audio" || kind === "video") && kind === mediaKind(previous.revision);
  const hearingPrevious = synced && previousSelected;
  const shown = hearingPrevious ? previous.revision : revision;
  const switchCut = (older: boolean) => {
    const player = currentStage.current?.querySelector<HTMLMediaElement>("video, audio");
    if (player) { switchAt.current = { time: player.currentTime, playing: !player.paused }; player.pause(); }
    setPreviousSelected(older);
  };
  const [approvalSettling, setApprovalSettling] = useState(false);
  const approvalCompletedAt = useRef(-Infinity);
  const approvalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (approvalTimer.current) clearTimeout(approvalTimer.current); }, []);
  const viewingOld = Boolean(draft && viewingRevision && !sourceMatchesReading(draft, viewingRevision));
  const draftApproved = sameSource(item.approved, draft);
  // 定稿是独立于认可的动作：只有确认表里真实 finalize_video 记录指向的版本才算已定稿，
  // 已认可的视频在新版草稿出现后回到待认可，也不继承旧版定稿。
  const finalizedCurrent = item.role === "video" && sameSource(item.finalizedSource, draft);
  // 所看视频修订决定阅读身份（E1）：整片、片段条、片段针对与制作记录同属该修订的 run。
  const isVideo = item.role === "video";
  const viewingRunId = isVideo && displayedSource?.kind === "artifact_revision" ? revision?.runId ?? null : null;
  const viewingRunLoaded = viewingRunId == null || runs.some(run => run.id === viewingRunId);
  // 回调身份不进依赖：父级每次渲染都会换新箭头，进了依赖会让补读 effect 反复触发。
  const ensureRunRef = useRef(onEnsureRun);
  ensureRunRef.current = onEnsureRun;
  useEffect(() => {
    // 所看 run 不在已加载列表时按 ID 补读进父级会话缓存；失败一次后等用户手动重试，不自动循环。
    if (!active || !viewingRunId || viewingRunLoaded || referenceErrors[`run:${viewingRunId}`]) return;
    ensureRunRef.current(viewingRunId);
  }, [viewingRunId, viewingRunLoaded, referenceErrors, active]);
  const videoRun = viewingRunId ? runs.find(run => run.id === viewingRunId) ?? null : null;
  const segments = isVideo ? videoRun?.segments ?? [] : [];
  // 正在针对的片段按 runId+segmentId 找回标题与序号，不依赖当前停在哪个组。
  const feedbackSegmentRun = feedbackSegment ? runs.find(run => run.id === feedbackSegment.runId) ?? null : null;
  const feedbackSegmentIndex = feedbackSegmentRun && feedbackSegment
    ? feedbackSegmentRun.segments.findIndex(target => target.segmentId === feedbackSegment.segmentId) : -1;
  const feedbackSegmentTitle = feedbackSegmentIndex >= 0 ? feedbackSegmentRun!.segments[feedbackSegmentIndex]!.title : null;
  // 片段意见的主目标是该事项当前稿（E1）：旧画面上仍可记录意见；
  // 整稿意见在旧稿上维持只读，不放开旧稿认可。
  const feedbackTarget = displayedSource?.kind === "artifact_revision"
    ? { artifactId: displayedSource.artifactId, revisionId: displayedSource.revisionId, workId: work.id } : null;
  const segmentLive = feedbackSegment != null && draftRef != null;
  const feedbackSubmitTarget = feedbackSegment && draftRef
    ? { artifactId: draftRef.artifactId, revisionId: draftRef.revisionId, workId: work.id, segment: feedbackSegment }
    : feedbackTarget;
  const { text: feedbackText, saved: feedbackSaved, busy: feedbackBusy } = feedback.forTarget(feedbackSubmitTarget);
  const pickFeedbackSegment = (segment: { runId: string; segmentId: string } | null) => {
    const target = segment && draftRef ? { ...draftRef, workId: work.id, segment } : feedbackTarget;
    if (target) feedback.edit(target, feedbackText);
    onPickSegment(segment);
  };
  const feedbackReadOnly = hearingPrevious || (viewingOld && !segmentLive);
  // 事项草稿前进时，同一打开的片段意见把未发送文字带到新稿键（E1）：仅同事项同片段，
  // 不跨事项、不动整稿意见；已提交的意见不在草稿里，自然不迁移。
  const carriedFeedbackRef = useRef<{ artifactId: string; revisionId: string; segment: { runId: string; segmentId: string } } | null>(null);
  useEffect(() => {
    const revisionId = draftRef?.revisionId ?? null;
    const prior = carriedFeedbackRef.current;
    carriedFeedbackRef.current = draftRef && feedbackSegment ? { artifactId: draftRef.artifactId, revisionId: draftRef.revisionId, segment: feedbackSegment } : null;
    if (!draftRef || !revisionId || !feedbackSegment || !prior
      || (prior.artifactId === draftRef.artifactId && prior.revisionId === revisionId)
      || prior.segment.runId !== feedbackSegment.runId || prior.segment.segmentId !== feedbackSegment.segmentId) return;
    feedback.carryForward(
      { artifactId: prior.artifactId, revisionId: prior.revisionId, workId: work.id, segment: prior.segment },
      { artifactId: draftRef.artifactId, revisionId, workId: work.id, segment: feedbackSegment });
  }, [draftRef?.artifactId, draftRef?.revisionId, feedbackSegment, feedback, work]);
  const statusLabel = viewingOld ? feedbackSegment ? "历史片段" : "历史版本 · 只读" : !draft ? (item.approved ? "已认可" : "等待产出")
    : item.role === "video" ? finalizedCurrent ? "已定稿"
      : draftApproved ? "已认可，可定稿"
      : item.approved ? "新稿待确认" : "待认可"
    : draftApproved ? "已认可"
    : item.approved ? "新稿待确认" : "待认可";
  const confirmEntry = draft ? [{ itemId: item.id, source: contentSubjectInput(draft) }] : null;
  const currentRead = !viewingOld && !hearingPrevious && (draft?.kind === "message_text" || Boolean(revision));
  const confirmItem = async (action: ReviewAction, label: string) => {
    if (!currentRead || !confirmEntry || approvalSettling) return;
    setApprovalSettling(true);
    const success = await onConfirmReview(work, group, action, confirmEntry, label);
    if (!success) { setApprovalSettling(false); return; }
    // 同一连击不能跨越“认可 → 继续”两个不同动作，键盘长按也不能连发。
    approvalCompletedAt.current = performance.now();
    approvalTimer.current = setTimeout(() => setApprovalSettling(false), 500);
  };

  return <article className="agent-review-item" id={`review-item-${work.id}-${group.id}-${item.id}`} tabIndex={-1} data-compact-feedback={feedbackOpen || undefined} data-approved={draftApproved || undefined} data-pending={!draftApproved && draft != null || undefined}>
    <header>
      <h4>{item.label}</h4>
      {displayedSource?.kind === "artifact_revision" ? <span className="agent-review-version">v{shown?.revisionNumber ?? "…"}</span> : null}
      <span className="agent-stage-state">{hearingPrevious ? "上一版 · 只读" : statusLabel}</span>
      {groupPicker}
      {revision?.baseRevisionId ? <button type="button" className="agent-version-compare-toggle" aria-expanded={compareOpen} onClick={() => { if (hearingPrevious) switchCut(false); setCompareOpen(value => !value); }}><Columns2 />{compareOpen ? "收起对比" : "比较版本"}</button> : null}
      <details className="agent-review-more"><summary aria-label="更多审阅操作"><Ellipsis /></summary><div>
        {draft && item.role === "video" && !finalizedCurrent ? <button type="button" disabled={groupBusy || approvalSettling || viewingOld || !currentRead} aria-label={`以这版「${item.label}」定稿并入库`} onClick={() => void confirmItem("finalize_video", `以这版「${item.label}」定稿。`)}>定稿并入库</button> : null}
        {item.role === "clip" && !viewingOld && draft?.kind === "artifact_revision" && revision?.content.format === "media" && revision.content.mimeType.startsWith("video/") ? <button type="button" disabled={groupBusy || hearingPrevious} aria-label={`以这版「${item.label}」定稿并入库`} onClick={() => void onAdoptPreview(work, group, item, { artifactId: draft.artifactId, revisionId: draft.revisionId })}>以这版定稿并入库</button> : null}
        {revision?.baseRevisionId ? <button type="button" onClick={() => onViewingRevision({ artifactId: revision.artifactId, revisionId: revision.baseRevisionId! })}>看上一版</button> : null}
        {hasGroupEntries ? <button type="button" disabled={groupBusy || hearingPrevious || approvalSettling || Boolean(groupUnread.length)} onClick={async () => {
          setApprovalSettling(true);
          if (!await onApproveGroup()) { setApprovalSettling(false); return; }
          approvalCompletedAt.current = performance.now();
          approvalTimer.current = setTimeout(() => setApprovalSettling(false), 500);
        }}>认可整组</button> : null}
        {groupUnread.length ? <span className="agent-stage-muted">{groupUnread.join("；")}</span> : null}
        <span className="agent-stage-muted">认可、继续与定稿分别操作</span>
      </div></details>
    </header>
    <div className="agent-review-content agent-work-draft-scroll" data-synced={synced || undefined} data-history={viewingOld || undefined}>
    {!draft ? <div className="agent-stage-empty">等待 Frame 交付这份内容。</div> : <>
      {viewingOld ? <div className="agent-inline-note">{feedbackSegment ? "旧版画面不能认可；片段意见会记录到当前稿。" : "正在看旧版本，不能在这里确认；请回到最新稿。"}</div> : null}
      {displayedSource?.kind === "message_text" ? <div className="agent-stage-meta"><span>聊天原文 · {displayedSource.author === "user" ? "用户消息" : "Frame 消息"}</span></div> : null}
      {synced ? <div className="agent-cut-switch" role="group" aria-label="在同一时间码比较版本">
        <span>同一时间码</span>
        <button type="button" aria-pressed={hearingPrevious} onClick={() => { if (!hearingPrevious) switchCut(true); }}>上一版 v{previous.revision!.revisionNumber}</button>
        <button type="button" aria-pressed={!hearingPrevious} onClick={() => { if (hearingPrevious) switchCut(false); }}>当前版 v{revision!.revisionNumber}</button>
      </div> : null}
      <div className={compareOpen && !synced ? "agent-version-comparison" : undefined}>
      {compareOpen && !synced ? <section aria-label="上一版内容"><h5>上一版 · v{previous.revision?.revisionNumber ?? "…"}</h5>{previous.revision ? <div className="agent-stage-body"><RevisionBody content={previous.revision.content} simulated={simulated} /></div>
        : previous.error ? <p role="status">上一版读取失败。<button type="button" onClick={previous.retry}>重试对比</button></p> : <p>正在读取上一版…</p>}</section> : null}
      <section key="current-player" ref={currentStage} aria-label={compareOpen ? "当前查看版本" : undefined}
        onLoadedMetadataCapture={event => {
          const player = event.target;
          const position = switchAt.current;
          if (!position || !(player instanceof HTMLMediaElement)) return;
          player.currentTime = Math.min(position.time, player.duration);
          if (position.playing) void player.play().catch(() => { /* 浏览器要求手势时保留原生播放键。 */ });
          switchAt.current = null;
        }}>
      {compareOpen && !synced ? <h5>当前查看 · v{revision?.revisionNumber ?? "…"}</h5> : null}
      {displayedSource?.kind === "artifact_revision"
        ? shown ? <div className="agent-stage-body"><RevisionBody key={shown.revisionId} content={shown.content} simulated={simulated} initialTime={switchAt.current?.time ?? playbackPositions.get(playbackKey)} onTimeUpdate={time => { if (!hearingPrevious) { playbackTime.current = time; playbackPositions.set(playbackKey, time); } }} /></div>
          : read.error
            ? <div role="status">草稿读取失败。<button type="button" onClick={read.retry}>重试读取草稿</button></div>
            : <div className="agent-stage-loading">正在读取…</div>
        : <div className="agent-stage-body"><MarkdownText text={displayedSource?.kind === "message_text" ? displayedSource.text : ""} /></div>}
      </section></div>

    </>}
    {isVideo && (videoRun?.audioSummary || segments.length) ? <details className="agent-media-context"><summary>声音与片段 · {segments.length} 段</summary>
    {isVideo && videoRun?.audioSummary ? <AudioSummaryView summary={videoRun.audioSummary} title="这版视频的声音" /> : null}
    {isVideo && segments.length ? <div className="agent-segment-strip" aria-label="按播放顺序的片段">
      {segments.map((segment, index) => <SegmentCard key={segment.segmentId} segment={segment} index={index}
        selected={feedbackSegment != null && feedbackSegment.runId === viewingRunId
          && feedbackSegment.segmentId === segment.segmentId}
        onSelect={() => {
          if (feedbackSegment != null && feedbackSegment.segmentId === segment.segmentId
            && feedbackSegment.runId === viewingRunId) {
            pickFeedbackSegment(null);
            return;
          }
          pickFeedbackSegment({ runId: viewingRunId!, segmentId: segment.segmentId });
          if (!feedbackOpen) onToggleFeedback();
        }} />)}
    </div> : null}
    </details> : null}
    {isVideo && viewingRunId && !videoRun ? <p className="agent-stage-muted">
      {referenceErrors[`run:${viewingRunId}`]
        ? <>这份制作的片段读取失败，视频本身不受影响。<button type="button" onClick={() => onEnsureRun(viewingRunId)}>重试</button></>
        : "正在读取这份制作的片段…"}
    </p> : null}
    {isVideo && viewingRunId ? <p className="agent-stage-runlink">
      <button type="button" onClick={() => onOpenRun(viewingRunId)}>查看制作记录</button>
    </p> : null}
    </div>
    <footer className="agent-review-footer">
      {feedbackTarget ? <div className="agent-work-feedback" onKeyDown={event => { if (event.key === "Escape" && feedbackOpen) closeFeedback(); }}>
        <button type="button" className="agent-close-note" onClick={closeFeedback} aria-label="收起意见编辑"><X /></button>
        {feedbackSegment ? <span className="agent-target-chip">针对：片段 {feedbackSegmentIndex >= 0 ? feedbackSegmentIndex + 1 : ""}{feedbackSegmentTitle ? `「${feedbackSegmentTitle}」` : ""}<button type="button" onClick={() => pickFeedbackSegment(null)} aria-label="取消针对该片段"><X /></button></span> : null}
        <label>{viewingOld && feedbackSegment
          ? `正在查看 v${revision?.revisionNumber ?? "…"} 的片段，意见记录到「${work.title}」${item.label}的当前${draftRef && revisions[`${draftRef.artifactId}:${draftRef.revisionId}`] ? ` v${revisions[`${draftRef.artifactId}:${draftRef.revisionId}`]!.revisionNumber}` : "稿"}`
          : `给「${work.title}」${item.label}${revision ? ` v${revision.revisionNumber}` : ""}提意见`}
          <textarea ref={feedbackInput} readOnly={feedbackReadOnly} value={feedbackText} onChange={event => { if (feedbackSubmitTarget && !feedbackReadOnly) feedback.edit(feedbackSubmitTarget, event.target.value); }} placeholder="写下这版需要调整的地方…" aria-label="意见" />
        </label>
        {feedbackReadOnly ? <p>旧稿意见仅供查看，可以复制后继续讨论。</p> : feedbackText.trim() ? <p>意见尚未发送；认可和继续不会提交这份草稿。</p> : null}
        <div className="agent-feedback-tools">
          {isVideo && revision?.content.format === "media" && !viewingOld && !hearingPrevious && feedbackTarget ? <button type="button" className="agent-time-feedback" onClick={() => {
        const player = currentStage.current?.querySelector("video");
        const seconds = Math.floor(player?.currentTime ?? playbackTime.current);
        const stamp = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
        pickFeedbackSegment(null);
        const prior = feedback.forTarget(feedbackTarget).text;
        feedback.edit(feedbackTarget, `${prior}${prior.trim() ? "\n\n" : ""}[${stamp}] `);
        if (!feedbackOpen) onToggleFeedback(); else feedbackInput.current?.focus();
      }}><Pencil />对此时刻提意见</button> : null}
        {feedbackTarget ? <button type="button" className="agent-stage-secondary" title="意见只记录，不会自动改稿" onClick={() => { if (feedbackSubmitTarget && !feedbackReadOnly) void feedback.submit(feedbackSubmitTarget); }} disabled={feedbackReadOnly || !feedbackText.trim() || feedbackBusy || (feedbackSegment != null && !segmentLive)}>{feedbackBusy ? "正在保存…" : "记录意见"}</button> : null}</div>
      </div> : null}
      <div className="agent-review-actions">
        <LastReviewFeedback workId={work.id} groupId={group.id} itemId={item.id} refresh={feedbackSaved} />
        <div className="agent-review-action-status" role="status">
          {continuing ? continuing === "queued" ? "已加入队列，等待前面的请求完成。" : "正在继续这一组，完成后会在这里更新。"
            : viewingOld ? "正在看历史版本"
            : finalizedCurrent ? "已定稿并入库"
            : draftApproved && groupComplete ? queueHint ? `继续「${work.title}」将排队` : group.nextIntent ?? "继续处理本作品"
            : draftApproved && nextItem ? `本组还有「${nextItem.label}」待确认`
            : group.nextIntent ?? (draftApproved ? "" : "只认可这版，随后可继续制作。")}
          {feedbackSaved ? <span className="agent-feedback-saved">{feedbackSaved}</span> : null}
        </div>
        {feedbackTarget ? <button type="button" className="agent-note-trigger" ref={feedbackTrigger} aria-expanded={feedbackOpen} onClick={onToggleFeedback}><Pencil />提意见{feedbackText.trim() ? " · 草稿" : ""}</button> : null}
        {hearingPrevious ? <button type="button" className="agent-stage-primary" onClick={() => switchCut(false)}>回到 v{revision?.revisionNumber}</button>
          : viewingOld ? <button type="button" className="agent-stage-primary" onClick={() => onViewingRevision(draft?.kind === "message_text" ? draft : draftRef)}>查看最新稿</button>
          : !draft ? <button type="button" className="agent-stage-primary" disabled>等待产出</button>
          : !draftApproved ? <button type="button" className="agent-stage-primary" disabled={groupBusy || approvalSettling || !currentRead} aria-label={revision ? `认可 v${revision.revisionNumber} · ${item.label}` : `认可「${item.label}」`}
              onClick={event => { if (event.detail < 2) void confirmItem("approve", `认可「${item.label}」这一版。`); }} onKeyDown={event => { if (event.repeat) event.preventDefault(); }}>{groupBusy ? "正在认可…" : revision ? `认可 v${revision.revisionNumber}` : "认可这一版"}</button>
          : !groupComplete && nextItem ? <button type="button" className="agent-stage-primary" disabled={groupBusy || approvalSettling}
              onKeyDown={event => { if (event.repeat) event.preventDefault(); }}
              onClick={event => { if (event.detail < 2 && performance.now() - approvalCompletedAt.current >= 500) onOpenItem(nextItem); }}>审阅下一项</button>
          : !groupComplete ? <button type="button" className="agent-stage-primary" disabled>等待其余内容</button>
          : <button type="button" className="agent-stage-primary" disabled={groupBusy || approvalSettling || Boolean(continuing) || !canContinueText}
              onKeyDown={event => { if (event.repeat) event.preventDefault(); }}
              onClick={event => { if (event.detail < 2 && !approvalSettling && performance.now() - approvalCompletedAt.current >= 500) void onContinueReview(work, group, `「${group.title}」这一组已认可，请继续下一步。`); }}>{continuing === "queued" ? "已排队" : continuing === "running" ? "继续处理中" : "继续下一步"}</button>}
      </div>
      {!canContinueText && draftApproved ? <span className="agent-stage-muted">继续需要可用的文本模型</span> : null}
    </footer>
  </article>;
}

// 片段卡（B1）：按播放顺序展示该段真实媒体与执行状态；timed 段只播放冻结区间，
// 不把整条源视频冒充已裁切片段。点卡片选中为意见针对，再点取消。
function SegmentCard({ segment, index, selected, onSelect }: {
  segment: RunSegment; index: number; selected: boolean; onSelect: () => void;
}) {
  const url = segment.media ? blobUrl(segment.media.blobId) : null;
  const endMs = segment.startMs != null && segment.durationMs != null ? segment.startMs + segment.durationMs : null;
  const visual = url && segment.media?.mimeType.startsWith("video/")
    ? <video controls preload="none" src={url} aria-label={`片段 ${index + 1} 预览`}
      onLoadedMetadata={event => { if (segment.startMs != null) event.currentTarget.currentTime = segment.startMs / 1000; }}
      onTimeUpdate={event => { if (endMs != null && event.currentTarget.currentTime * 1000 >= endMs) event.currentTarget.pause(); }} />
    : url && segment.media?.mimeType.startsWith("image/") ? <img src={url} alt={`片段 ${index + 1} 画面`} loading="lazy" />
    : <div className="agent-segment-placeholder">{segment.state === "succeeded" ? "画面暂不可读" : SEGMENT_STATE_LABEL[segment.state]}</div>;
  return <div className="agent-segment-card" data-state={segment.state} data-selected={selected}>
    <button type="button" className="agent-segment-pick" aria-pressed={selected} onClick={onSelect}>
      <span className="agent-segment-index">{index + 1}</span>
      <span className="agent-segment-title">{segment.title}</span>
      <small>{SEGMENT_STATE_LABEL[segment.state]}</small>
    </button>
    {visual}
    {segment.durationMs != null ? <small className="agent-segment-duration">{(segment.durationMs / 1000).toFixed(1)} 秒</small> : null}
  </div>;
}
