import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Check, Film, Pencil, X } from "lucide-react";
import { agentApi } from "./api.js";
import { MATERIAL_PROVIDER_LABELS } from "./material-labels.js";
import { MarkdownText } from "./markdown.js";
import { RevisionBody } from "./ProductionCards.js";
import { AudioSummaryView, MediaSourceDetails } from "./AudioSummaryView.js";
import { loadStageReading, saveStageReading, type StageRevisionRef } from "./workspace-state.js";
import { REVIEW_ROLE_LABELS } from "./FramePresentation.js";
import type { FeedbackDrafts } from "./useFeedbackDrafts.js";
import type {
  ArtifactHead, ArtifactRevision, ContentSource, ContentSourceInput, MaterialBatch, MaterialBatchIndexItem,
  ReviewGroup, ReviewItem, Run, RunSegment, Work,
} from "../../shared/agent/generated/contracts.js";

// 组审阅面板：把 snapshot 的 works.reviewGroups 呈现为「组页签 + 逐事项卡 +
// 已确认成果」。只读展示 + 认可按钮；认可/制作事实一律来自服务端投影，
// 本组件不维护业务状态机，也不自动推进下一组工作。

export type ReviewAction = "approve" | "approve_and_continue" | "finalize_video";
export interface ReviewEntry { itemId: string; source: ContentSourceInput; }

const SEGMENT_STATE_LABEL = { pending: "等待中", running: "制作中", succeeded: "已生成", failed: "未完成", cancelled: "已停止" } as const;
const blobContentUrl = (blobId: string) => `/api/agent/v1/blobs/${encodeURIComponent(blobId)}/content`;

// 认可按钮的 subject 只按输入合同组装：消息原文去掉服务端派生的 author 字段。
export function contentSubjectInput(source: ContentSource): ContentSourceInput {
  return source.kind === "message_text"
    ? { kind: "message_text", messageId: source.messageId, text: source.text }
    : { kind: "artifact_revision", artifactId: source.artifactId, revisionId: source.revisionId, digest: source.digest };
}

export function sameSource(left: ContentSource | null, right: ContentSource | null): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  return left.kind === "message_text"
    ? left.messageId === (right as Extract<ContentSource, { kind: "message_text" }>).messageId
    : left.revisionId === (right as Extract<ContentSource, { kind: "artifact_revision" }>).revisionId;
}

// 事项当前稿是否已按这版认可（认可记录指向当前稿同一来源）。
const approvedCurrent = (item: ReviewItem) => item.draft != null && sameSource(item.approved, item.draft);

export function workReviewLabel(work: Work): string {
  const items = work.reviewGroups.flatMap(group => group.items);
  if (!items.length) return "审阅组";
  const pending = items.filter(item => item.draft != null && !sameSource(item.approved, item.draft)).length;
  if (pending) return `待认可 ${pending} 项`;
  const waiting = items.filter(item => item.draft == null && item.approved == null).length;
  if (waiting) return `等待产出 ${waiting} 项`;
  return "已认可";
}

// 草稿按准确修订读取；失败有可见重试，不用永久 loading 代替错误。
// 读到的修订回报父级合入共享缓存，整组认可的阅读守卫据此判断当前稿是否已加载。
function useStageRevision(source: ContentSource | null, cache: Record<string, ArtifactRevision>, onLoaded?: ((revision: ArtifactRevision) => void) | undefined) {
  const artifactId = source?.kind === "artifact_revision" ? source.artifactId : null;
  const revisionId = source?.kind === "artifact_revision" ? source.revisionId : null;
  const key = artifactId && revisionId ? `${artifactId}:${revisionId}` : null;
  const [result, setResult] = useState<{ key: string; revision: ArtifactRevision | null; error: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  useEffect(() => {
    if (!artifactId || !revisionId || !key || cache[key]) return;
    let disposed = false;
    setResult(null);
    void agentApi.readRevision(artifactId, revisionId).then(revision => {
      if (disposed) return;
      setResult({ key, revision, error: false });
      loadedRef.current?.(revision);
    }).catch(() => {
      if (!disposed) setResult({ key, revision: null, error: true });
    });
    return () => { disposed = true; };
  }, [artifactId, revisionId, key, cache, attempt]);
  return { revision: key ? cache[key] ?? (result?.key === key ? result.revision : null) : null,
    error: result?.key === key && result.error, retry: () => setAttempt(value => value + 1) };
}

interface BatchState {
  batch: MaterialBatch | null;
  error: string | null;
}

// 单个素材批次的可复现显示：按 batchId 读取详情，索引项只用于摘要标题；
// 索引外批次（历史消息点开）直接按所读详情渲染，不重发搜索。组审阅与无事项视图共用。
type AdoptMaterial = (batch: MaterialBatch, candidate: MaterialBatch["results"][number], index: number) => void;

export function MaterialBatchCard({ batchId, summary, open, onToggle, onAdopt, adoptDisabled = false }: {
  batchId: string;
  summary: MaterialBatchIndexItem | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  onAdopt?: AdoptMaterial | undefined;
  adoptDisabled?: boolean | undefined;
}) {
  const [state, setState] = useState<BatchState>({ batch: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!open || (state.batch?.batchId === batchId && !state.error)) return;
    let disposed = false;
    setState({ batch: null, error: null });
    void agentApi.readMaterialBatch(batchId)
      .then(batch => { if (!disposed) setState({ batch, error: null }); })
      .catch(() => { if (!disposed) setState({ batch: null, error: "读取失败" }); });
    return () => { disposed = true; };
  }, [batchId, open, attempt]);
  const detail = state.batch?.batchId === batchId ? state.batch : null;
  const title = summary?.query.query || detail?.query.query || "（无关键词）";
  const kind = summary?.query.kind ?? detail?.query.kind;
  const resultCount = summary?.resultCount ?? detail?.results.length;
  const isOriginal = (summary?.messageId ?? detail?.messageId) != null;
  return <details className="agent-batch" open={open}
    onToggle={event => onToggle((event.target as HTMLDetailsElement).open)}>
    <summary>
      <span>{title}</span>
      <small>{{ image: "图片", video: "视频", audio: "音乐" }[kind ?? "video"]} · {resultCount ?? "…"} 项{isOriginal ? " · 原始批次" : ""}</small>
    </summary>
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
  conversationId, works, selectedWorkId, onSelectWork, artifacts, revisions, runs, materialBatches,
  onConfirmReview, onContinueReview, reviewBusyKeys, canContinueText, onOpenRun, onEnsureRun, referenceErrors, feedback, simulated, openBatchId,
  navigation, onAdoptMaterial, adoptDisabled, onRevisionLoaded,
}: {
  conversationId: string;
  works: Work[];
  selectedWorkId: string | null;
  navigation: { workId: string; groupId: string; itemId: string; artifactId: string; revisionId: string } | null;
  onSelectWork: (workId: string) => void;
  artifacts: ArtifactHead[];
  revisions: Record<string, ArtifactRevision>;
  runs: Run[];
  materialBatches: MaterialBatchIndexItem[];
  onAdoptMaterial?: AdoptMaterial | undefined;
  adoptDisabled?: boolean | undefined;
  // 认可入口：entries 至少一项；返回是否成功，供成功后的局部跳转使用。
  onConfirmReview: (work: Work, group: ReviewGroup, action: ReviewAction, entries: readonly ReviewEntry[], label: string) => Promise<boolean>;
  // 必选项全部认可后的普通继续：一条不带 reviewConfirmation 的普通消息，不补确认、不定稿。
  onContinueReview: (work: Work, group: ReviewGroup, label: string) => Promise<boolean>;
  // 同一事项任一认可在途时整组禁用，避免并发确认相互覆盖。
  reviewBusyKeys: readonly string[];
  canContinueText: boolean;
  onOpenRun: (runId: string) => void;
  // 被动补读所看修订的 run（E1）：合入同一会话缓存，不跳页。
  onEnsureRun: (runId: string) => void;
  referenceErrors: Record<string, string>;
  feedback: FeedbackDrafts;
  simulated: boolean;
  openBatchId: string | null;
  // 面板内按需读到的修订合入父级共享缓存；整组阅读守卫据此判断当前稿已加载。
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined;
}) {
  const work = works.find(item => item.id === selectedWorkId) ?? works[0] ?? null;
  // 阅读位置与稿旁意见按会话持久：刷新/切会话后回到同一组、同一修订（B03）。
  const [storedReading] = useState(() => loadStageReading(conversationId));
  const [shownGroups, setShownGroups] = useState<Record<string, string>>(storedReading.groupByWork);
  const [shownRevisions, setShownRevisions] = useState<Record<string, StageRevisionRef | null>>(storedReading.revisionByItem);
  useEffect(() => {
    if (!navigation) return;
    setShownGroups(current => ({ ...current, [navigation.workId]: navigation.groupId }));
    setShownRevisions(current => ({ ...current, [`${navigation.workId}:${navigation.groupId}:${navigation.itemId}`]: {
      artifactId: navigation.artifactId, revisionId: navigation.revisionId,
    } }));
  }, [navigation]);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(storedReading.batchId);
  // 意见框按事项开关；片段针对（B1）按事项独立记录，只在各自意见框打开期间生效。
  const [feedbackOpenKeys, setFeedbackOpenKeys] = useState<Record<string, boolean>>({});
  const [feedbackSegments, setFeedbackSegments] = useState<Record<string, { runId: string; segmentId: string } | null>>({});
  const workspace = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(850);
  useEffect(() => {
    if (!workspace.current) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setWorkspaceWidth(width);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  // 片段针对按 work:group:item 命名空间记录，切换事项/组/作品自然互不可见。
  // 阅读引用与意见开关写回本会话存储；无内容时清空，不残留旧视图。
  useEffect(() => {
    saveStageReading(conversationId, { groupByWork: shownGroups, revisionByItem: shownRevisions, batchId: expandedBatch });
  }, [conversationId, shownGroups, shownRevisions, expandedBatch]);

  // 消息引用的批次被点开时，展开该批次；卡片自行按 ID 读取详情。
  useEffect(() => {
    if (!openBatchId) return;
    setExpandedBatch(openBatchId);
  }, [openBatchId]);

  if (!work) return null;
  const groups = work.reviewGroups;
  const groupId = shownGroups[work.id] && groups.some(group => group.id === shownGroups[work.id])
    ? shownGroups[work.id]! : groups[0]?.id ?? null;
  const group = groups.find(item => item.id === groupId) ?? null;
  const itemKey = (itemId: string) => `${work.id}:${group?.id ?? ""}:${itemId}`;
  // busy 键是 work:group 两段；按准确值匹配，避免前缀误伤同前缀的其他组。
  const groupBusy = reviewBusyKeys.includes(`${work.id}:${group?.id ?? ""}`);
  const pendingEntries = (target: ReviewGroup) => target.items
    .filter(item => item.draft != null && !approvedCurrent(item))
    .map(item => ({ itemId: item.id, source: contentSubjectInput(item.draft!) }));
  // 整组认可的阅读守卫：待认可事项正在看旧版、当前稿未加载，或必选事项尚无稿时，
  // 整组动作禁用并给出具体提示；单项认可不受影响，可选预览不阻塞整组。
  const unreadPendingHints = (target: ReviewGroup) => target.items.flatMap(item => {
    if (item.draft == null) {
      return item.required && item.approved == null ? [`「${item.label}」还在等待产出`] : [];
    }
    if (approvedCurrent(item) || item.draft.kind !== "artifact_revision") return [];
    const ref = shownRevisions[itemKey(item.id)] ?? null;
    if (ref && (ref.artifactId !== item.draft.artifactId || ref.revisionId !== item.draft.revisionId)) {
      return [`「${item.label}」正在看旧版`];
    }
    return revisions[`${item.draft.artifactId}:${item.draft.revisionId}`] ? [] : [`「${item.label}」的最新稿还没打开`];
  });
  const requiredComplete = (target: ReviewGroup) => target.items.filter(item => item.required).every(approvedCurrent);

  const confirmGroup = (action: ReviewAction, label: string) => {
    if (!group) return;
    const entries = pendingEntries(group);
    if (entries.length && !unreadPendingHints(group).length) void onConfirmReview(work, group, action, entries, label);
  };

  return <section ref={workspace} className="agent-work" data-work-id={work.id} aria-label={`创作：${work.title}`}>
    {works.length > 1 ? <div className="agent-work-tabs" role="tablist" aria-label="当前对话中的创作">
      {works.map(item => <button type="button" key={item.id} role="tab" aria-selected={item.id === work.id} onClick={() => onSelectWork(item.id)}>
        <Film /><span><strong>{item.title}</strong><small>{workReviewLabel(item)}</small></span>
      </button>)}
    </div> : null}
    <header className="agent-work-heading">
      <div><h2>{work.title}</h2><span className="agent-work-phase">{workReviewLabel(work)}</span></div>
    </header>
    {groups.length ? <div className="agent-stage-tabs" role="tablist" aria-label="审阅组">
      {groups.map((target, index) => {
        const total = target.items.length;
        const approvedCount = target.items.filter(approvedCurrent).length;
        const complete = target.items.filter(item => item.required).every(approvedCurrent);
        return <button type="button" role="tab" key={target.id} aria-selected={target.id === groupId}
          onClick={() => setShownGroups(current => ({ ...current, [work.id]: target.id }))}>
          <span>{index + 1}</span>{target.title}{total ? <small className="agent-review-count">{approvedCount}/{total}</small> : null}{complete ? <Check /> : null}
        </button>;
      })}
    </div> : null}
    <Group orientation={workspaceWidth < 640 ? "vertical" : "horizontal"} className="agent-work-split" id="agent-work-split">
      <Panel id="agent-work-draft" defaultSize="55%" minSize={workspaceWidth < 640 ? "210px" : "280px"}>
      <section className="agent-work-draft" aria-label="草稿与修改">
        <div className="agent-work-pane-title"><h3>草稿与修改</h3><span>{group?.title ?? "还没有审阅组"}</span></div>
        <div className="agent-work-draft-scroll">
          {!group ? <div className="agent-stage-empty">还没有审阅组。正式开始一条视频后，Frame 会按角色、背景、分镜分组交付。</div>
            : group.items.length ? group.items.map(item => <ReviewItemCard key={item.id} work={work} group={group} item={item}
                artifacts={artifacts} revisions={revisions} runs={runs} simulated={simulated} feedback={feedback}
                feedbackSegment={feedbackSegments[itemKey(item.id)] ?? null}
                onPickSegment={segment => setFeedbackSegments(current => ({ ...current, [itemKey(item.id)]: segment }))}
                referenceErrors={referenceErrors} onEnsureRun={onEnsureRun} onOpenRun={onOpenRun}
                onConfirmReview={onConfirmReview} groupBusy={groupBusy}
                onRevisionLoaded={onRevisionLoaded}
                viewingRevision={shownRevisions[itemKey(item.id)] ?? null}
                onViewingRevision={ref => setShownRevisions(current => ({ ...current, [itemKey(item.id)]: ref }))}
                feedbackOpen={Boolean(feedbackOpenKeys[itemKey(item.id)])}
                onToggleFeedback={() => setFeedbackOpenKeys(current => ({ ...current, [itemKey(item.id)]: !current[itemKey(item.id)] }))} />)
              : <div className="agent-stage-empty">这一组还没有交付事项。</div>}
          {materialBatches.length || openBatchId ? <details className="agent-draft-materials" open={Boolean(expandedBatch)}>
            <summary>参考素材</summary>
          {materialBatches.length || (openBatchId && !materialBatches.some(batch => batch.batchId === openBatchId)) ? <>
            {materialBatches.map(batch => <MaterialBatchCard key={batch.batchId} batchId={batch.batchId} summary={batch}
              open={expandedBatch === batch.batchId} onAdopt={onAdoptMaterial} adoptDisabled={adoptDisabled}
              onToggle={open => setExpandedBatch(open ? batch.batchId : null)} />)}
            {/* 被点开的批次不在当前索引（历史批次）时仍按所读详情渲染，不重发搜索。 */}
            {openBatchId && !materialBatches.some(batch => batch.batchId === openBatchId)
              ? <MaterialBatchCard batchId={openBatchId} summary={null} open onAdopt={onAdoptMaterial} adoptDisabled={adoptDisabled}
                  onToggle={open => setExpandedBatch(open ? openBatchId : null)} />
              : null}
          </> : null}
          </details> : null}
        </div>
        {group ? <div className="agent-stage-actions">
          {(() => {
            const pending = pendingEntries(group);
            const unread = unreadPendingHints(group);
            const complete = requiredComplete(group);
            return <>
              {pending.length ? <>
                {unread.length ? <span className="agent-stage-muted">{unread.join("；")}。整组认可暂不可用，单项认可仍可用。</span> : null}
                <span className="agent-stage-action">
                  <button type="button" className="agent-stage-secondary" disabled={groupBusy || unread.length > 0}
                    onClick={() => confirmGroup("approve", `「${group.title}」这一组我都认可了。`)}>认可整组</button>
                </span>
                <span className="agent-stage-action">
                  <button type="button" className="agent-stage-primary" disabled={groupBusy || !canContinueText || unread.length > 0}
                    onClick={() => confirmGroup("approve_and_continue", `「${group.title}」这一组我都认可了，请继续下一步。`)}>认可并继续</button>
                  {!canContinueText ? <small>继续需要可用的文本模型</small> : null}
                </span>
              </> : null}
              {complete ? <span className="agent-stage-action">
                <button type="button" className="agent-stage-primary" disabled={groupBusy || !canContinueText}
                  onClick={() => void onContinueReview(work, group, `「${group.title}」这一组可以了，请继续。`)}>继续</button>
                {!canContinueText ? <small>继续需要可用的文本模型</small> : null}
              </span> : null}
              {!pending.length
                ? <span className="agent-stage-muted">{group.items.some(item => item.required && item.draft == null && item.approved == null)
                  ? "还有必选内容等待产出。" : "这一组已全部认可；想调整时在对话中提出。"}</span>
                : null}
            </>;
          })()}
          {/* 定稿/全部认可后组指引已履行，等新草稿出现再重新提示（F09）。 */}
          {group.nextIntent && !group.items.every(item => item.draft != null
            ? approvedCurrent(item) : item.approved != null || item.finalizedSource != null)
            ? <span className="agent-stage-muted">{group.nextIntent}</span> : null}
        </div> : null}
      </section>
      </Panel>
      <Separator className={`agent-resizer agent-work-divider${workspaceWidth < 640 ? " vertical" : ""}`} aria-label="调整草稿与成果大小" />
      <Panel id="agent-work-media" minSize={workspaceWidth < 640 ? "170px" : "240px"}>
      <section className="agent-work-media" aria-label="已确认成果">
        <div className="agent-work-pane-title"><h3>已确认成果</h3></div>
        <div className="agent-work-media-scroll">
          {(() => {
            const confirmed = groups.flatMap(target => target.items.filter(item => item.approved != null));
            return confirmed.length ? confirmed.map(item => <ConfirmedItem key={item.id} item={item}
                hasNewDraft={!sameSource(item.approved, item.draft)} revisions={revisions} simulated={simulated}
                runs={runs} onEnsureRun={onEnsureRun} referenceErrors={referenceErrors} />)
              : <div className="agent-stage-empty">你认可后的角色、方案和视频会留在这里。</div>;
          })()}
        </div>
      </section>
      </Panel>
    </Group>
  </section>;
}

function ReviewItemCard({ work, group, item, artifacts, revisions, runs, simulated, feedback,
  feedbackSegment, onPickSegment, referenceErrors, onEnsureRun, onOpenRun, onConfirmReview, groupBusy,
  viewingRevision, onViewingRevision, feedbackOpen, onToggleFeedback, onRevisionLoaded }: {
  work: Work; group: ReviewGroup; item: ReviewItem;
  artifacts: ArtifactHead[]; revisions: Record<string, ArtifactRevision>; runs: Run[]; simulated: boolean;
  feedback: FeedbackDrafts; feedbackSegment: { runId: string; segmentId: string } | null;
  onPickSegment: (segment: { runId: string; segmentId: string } | null) => void;
  referenceErrors: Record<string, string>;
  onEnsureRun: (runId: string) => void; onOpenRun: (runId: string) => void;
  onConfirmReview: (work: Work, group: ReviewGroup, action: ReviewAction, entries: readonly ReviewEntry[], label: string) => Promise<boolean>;
  groupBusy: boolean;
  viewingRevision: StageRevisionRef | null;
  onViewingRevision: (ref: StageRevisionRef | null) => void;
  feedbackOpen: boolean; onToggleFeedback: () => void;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined;
}) {
  const draft = item.draft;
  // 第一次阅读就保存准确引用；业务更新只用于提示，不决定用户正在看哪版。
  const draftRef = draft?.kind === "artifact_revision" ? { artifactId: draft.artifactId, revisionId: draft.revisionId } : null;
  useEffect(() => {
    if (draftRef && !viewingRevision) onViewingRevision(draftRef);
  }, [draftRef?.artifactId, draftRef?.revisionId, viewingRevision]);
  const displayedSource = draft?.kind === "artifact_revision" && viewingRevision
    ? { ...draft, artifactId: viewingRevision.artifactId, revisionId: viewingRevision.revisionId }
    : draft;
  const read = useStageRevision(displayedSource, revisions, onRevisionLoaded);
  const revision = read.revision;
  const viewingOld = draft?.kind === "artifact_revision" && viewingRevision !== null
    && (viewingRevision.artifactId !== draft.artifactId || viewingRevision.revisionId !== draft.revisionId);
  const draftApproved = approvedCurrent(item);
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
    if (!viewingRunId || viewingRunLoaded || referenceErrors[`run:${viewingRunId}`]) return;
    ensureRunRef.current(viewingRunId);
  }, [viewingRunId, viewingRunLoaded, referenceErrors]);
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
  const feedbackReadOnly = viewingOld && !segmentLive;
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
  const viewingArtifact = displayedSource?.kind === "artifact_revision"
    ? artifacts.find(candidate => candidate.id === displayedSource.artifactId) ?? null : null;
  const statusLabel = !draft ? (item.approved ? "已认可" : "等待产出")
    : item.role === "video" ? finalizedCurrent ? "已定稿"
      : draftApproved ? "已认可，可定稿"
      : item.approved ? "新稿待确认" : "待认可"
    : draftApproved ? "已认可"
    : item.approved ? "新稿待确认" : "待认可";
  const confirmEntry = draft ? [{ itemId: item.id, source: contentSubjectInput(draft) }] : null;

  return <article className="agent-review-item" data-approved={draftApproved || undefined} data-pending={!draftApproved && draft != null || undefined}>
    <header>
      <h4>{item.label}</h4>
      <span className="agent-review-role">{REVIEW_ROLE_LABELS[item.role]}</span>
      <span className="agent-stage-state">{statusLabel}</span>
      {draft?.kind === "artifact_revision" ? <button type="button" className="agent-stage-secondary agent-review-feedback-toggle" onClick={onToggleFeedback}>
        <Pencil />{feedbackOpen ? "收起意见" : "提意见"}</button> : null}
    </header>
    {feedbackOpen && feedbackTarget ? <div className="agent-work-feedback">
      {feedbackSegment ? <span className="agent-target-chip">
        针对：片段 {feedbackSegmentIndex >= 0 ? feedbackSegmentIndex + 1 : ""}{feedbackSegmentTitle ? `「${feedbackSegmentTitle}」` : ""}
        <button type="button" onClick={() => onPickSegment(null)} aria-label="取消针对该片段"><X /></button>
      </span> : null}
      <label>这条意见只记录，不会自动改稿<textarea readOnly={feedbackReadOnly} value={feedbackText}
        onChange={event => { if (feedbackSubmitTarget && !feedbackReadOnly) feedback.edit(feedbackSubmitTarget, event.target.value); }}
        placeholder="留给这一版的意见…" aria-label="意见" /></label>
      {feedbackReadOnly ? <p>这是旧稿的未发送意见，可以复制后继续讨论。</p> : null}
      <button type="button" onClick={() => { if (feedbackSubmitTarget && !feedbackReadOnly) void feedback.submit(feedbackSubmitTarget); }}
        disabled={feedbackReadOnly || !feedbackText.trim() || feedbackBusy || (feedbackSegment != null && !segmentLive)}>{feedbackBusy ? "正在保存…" : "记录意见"}</button>
    </div> : null}
    {!draft ? <div className="agent-stage-empty">等待 Frame 交付这份内容。</div> : <>
      {viewingOld ? <div className="agent-inline-note">正在看旧版本，不能在这里确认；请回到最新稿。</div> : null}
      <div className="agent-stage-meta">
        {draft.kind === "artifact_revision"
          ? <span>{viewingArtifact?.title ?? (isVideo ? "视频稿" : item.label)} · v{revision?.revisionNumber ?? "…"}</span>
          : <span>聊天原文 · {draft.author === "user" ? "用户消息" : "Frame 消息"}</span>}
      </div>
      {draft.kind === "artifact_revision"
        ? revision ? <div className="agent-stage-body"><RevisionBody content={revision.content} simulated={simulated} /></div>
          : read.error
            ? <div role="status">草稿读取失败。<button type="button" onClick={read.retry}>重试读取草稿</button></div>
            : <div className="agent-stage-loading">正在读取…</div>
        : <div className="agent-stage-body"><MarkdownText text={draft.text} /></div>}
    </>}
    {isVideo && videoRun?.audioSummary ? <AudioSummaryView summary={videoRun.audioSummary} title="这版视频的声音" /> : null}
    {isVideo && segments.length ? <div className="agent-segment-strip" aria-label="按播放顺序的片段">
      {segments.map((segment, index) => <SegmentCard key={segment.segmentId} segment={segment} index={index}
        selected={feedbackSegment != null && feedbackSegment.runId === viewingRunId
          && feedbackSegment.segmentId === segment.segmentId}
        onSelect={() => {
          if (feedbackSegment != null && feedbackSegment.segmentId === segment.segmentId
            && feedbackSegment.runId === viewingRunId) {
            onPickSegment(null);
            return;
          }
          onPickSegment({ runId: viewingRunId!, segmentId: segment.segmentId });
          onToggleFeedback();
        }} />)}
    </div> : null}
    {isVideo && viewingRunId && !videoRun ? <p className="agent-stage-muted">
      {referenceErrors[`run:${viewingRunId}`]
        ? <>这份制作的片段读取失败，视频本身不受影响。<button type="button" onClick={() => onEnsureRun(viewingRunId)}>重试</button></>
        : "正在读取这份制作的片段…"}
    </p> : null}
    {isVideo && viewingRunId ? <p className="agent-stage-runlink">
      <button type="button" onClick={() => onOpenRun(viewingRunId)}>查看制作记录</button>
    </p> : null}
    <div className="agent-review-actions">
      {!draft ? null
        : viewingOld ? <button type="button" className="agent-stage-secondary" onClick={() => onViewingRevision(draftRef)}>查看最新稿</button>
        : isVideo && finalizedCurrent ? <span className="agent-stage-muted">这一版已定稿并入库；修改请在对话中提出。</span>
        : isVideo && !finalizedCurrent ? <>
          <button type="button" className="agent-stage-primary"
            disabled={groupBusy} aria-label={`以这版「${item.label}」定稿并入库`}
            onClick={() => void onConfirmReview(work, group, "finalize_video", confirmEntry!, `以这版「${item.label}」定稿。`)}>{draftApproved ? "定稿并入库" : "以这版定稿"}</button>
          {revision?.baseRevisionId && draft.kind === "artifact_revision"
            ? <button type="button" className="agent-stage-secondary"
                onClick={() => onViewingRevision({ artifactId: draft.artifactId, revisionId: revision.baseRevisionId! })}>看上一版</button>
            : null}
        </>
        : draftApproved ? <span className="agent-stage-muted">这一份已认可；新稿出现后会再次等待确认。</span>
        : <>
          {confirmEntry ? <button type="button" className="agent-stage-secondary"
            disabled={groupBusy} aria-label={`认可「${item.label}」`}
            onClick={() => void onConfirmReview(work, group, "approve", confirmEntry, `认可「${item.label}」这一份。`)}>认可这一份</button> : null}
          {revision?.baseRevisionId && draft.kind === "artifact_revision"
            ? <button type="button" className="agent-stage-secondary"
                onClick={() => onViewingRevision({ artifactId: draft.artifactId, revisionId: revision.baseRevisionId! })}>看上一版</button>
            : null}
        </>}
      {feedbackSaved ? <span role="status" className="agent-feedback-saved">{feedbackSaved}</span> : null}
    </div>
  </article>;
}

function ConfirmedItem({ item, hasNewDraft, revisions, simulated, runs, onEnsureRun, referenceErrors }: {
  item: ReviewItem; hasNewDraft: boolean;
  revisions: Record<string, ArtifactRevision>; simulated: boolean;
  runs: Run[]; onEnsureRun: (runId: string) => void; referenceErrors: Record<string, string>;
}) {
  const source = item.approved!;
  const { revision, error, retry } = useStageRevision(source, revisions);
  const runId = item.role === "video" ? revision?.runId ?? null : null;
  const run = runs.find(candidate => candidate.id === runId);
  const ensureRun = useRef(onEnsureRun);
  ensureRun.current = onEnsureRun;
  useEffect(() => {
    if (runId && !run && !referenceErrors[`run:${runId}`]) ensureRun.current(runId);
  }, [runId, run, referenceErrors]);
  // 版本号只在有多版时出现；首版不挂常驻 v1。区域标题已是“已确认成果”，条目不再重复。
  return <article className="agent-confirmed-stage" aria-label={`已确认${item.label}`}>
    <header><h4>{item.label}</h4>{source.kind === "artifact_revision" && (revision?.revisionNumber ?? 0) > 1 ? <span>v{revision?.revisionNumber}</span> : null}</header>
    {hasNewDraft ? <p className="agent-stage-muted">新草稿讨论中，这份成果保持不变。</p> : null}
    {source.kind === "message_text" ? <MarkdownText text={source.text} />
      : revision ? <RevisionBody content={revision.content} simulated={simulated} />
      : error ? <p role="status">成果读取失败。<button type="button" onClick={retry}>重新读取成果</button></p>
      : <p className="agent-stage-loading">正在读取成果…</p>}
    {run?.audioSummary ? <AudioSummaryView summary={run.audioSummary} title="定稿声音" /> : null}
    {runId && !run ? <p className="agent-stage-muted">{referenceErrors[`run:${runId}`]
      ? <>这版视频的声音记录读取失败。<button type="button" onClick={() => onEnsureRun(runId)}>重试读取</button></>
      : "正在读取这版视频的声音记录…"}</p> : null}
  </article>;
}

// 片段卡（B1）：按播放顺序展示该段真实媒体与执行状态；timed 段只播放冻结区间，
// 不把整条源视频冒充已裁切片段。点卡片选中为意见针对，再点取消。
function SegmentCard({ segment, index, selected, onSelect }: {
  segment: RunSegment; index: number; selected: boolean; onSelect: () => void;
}) {
  const url = segment.media ? blobContentUrl(segment.media.blobId) : null;
  const endMs = segment.startMs != null && segment.durationMs != null ? segment.startMs + segment.durationMs : null;
  const visual = url && segment.media?.mimeType.startsWith("video/")
    ? <video controls preload="metadata" src={url} aria-label={`片段 ${index + 1} 预览`}
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
