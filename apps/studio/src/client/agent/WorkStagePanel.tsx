import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Check, Film, Pencil, X } from "lucide-react";
import { agentApi } from "./api.js";
import { MATERIAL_PROVIDER_LABELS } from "./material-labels.js";
import { MarkdownText, MarkdownBody } from "./markdown.js";
import { MediaPreview, ProposalCard, runEnded } from "./ProductionCards.js";
import { AudioSummaryView, MediaSourceDetails } from "./AudioSummaryView.js";
import { loadStageReading, saveStageReading, type StageRevisionRef } from "./workspace-state.js";
import type { FeedbackDrafts } from "./useFeedbackDrafts.js";
import type {
  ArtifactHead, ArtifactRevision, ContentSource, ContentSourceInput, MaterialBatch, MaterialBatchIndexItem,
  Proposal, Run, RunSegment, Work, WorkStage,
} from "../../shared/agent/generated/contracts.js";

// 作品阶段面板：把 snapshot 的 works/materialBatches 呈现为已认可原型的
// “阶段页签 + 待确认草稿 + 已确认成果”。只读展示 + 阶段认可按钮；
// 认可/制作事实一律来自服务端投影，本组件不维护业务状态机。

export type StageAction = "approve_content" | "approve_content_continue" | "approve_plan" | "finalize_video";

const STAGE_LABELS = { content: "内容草稿", plan: "画面与声音", video: "视频初稿" } as const;
const STAGE_ORDER: WorkStage[] = ["content", "plan", "video"];
const STAGE_ACTIONS_BY_STAGE: Record<WorkStage, readonly StageAction[]> = {
  content: ["approve_content", "approve_content_continue"],
  plan: ["approve_plan"],
  video: ["finalize_video"],
};
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

export function workPhaseLabel(work: Work, runs: readonly Run[]): string {
  const { content, plan, video } = work.stages;
  if (work.stage === "plan" && plan.upstreamStale) return "方案待更新";
  if (!sameSource(content.draft, content.approved)) return "内容待确认";
  if (content.confirmationAction !== "approve_content_continue") return "内容已认可，暂停中";
  if (work.stage === "plan") {
    return sameSource(plan.draft, plan.approved) && plan.confirmationAction === "approve_plan" ? "方案已认可" : "方案待确认";
  }
  const run = runs.find(item => item.id === video.runId);
  if (runs.some(item => item.workId === work.id && !runEnded(item.state))) return "制作中";
  if (run?.state === "failed") return "制作未完成";
  if (run?.state === "cancelled") return "制作已停止";
  if (!video.draft) return "等待视频初稿";
  return sameSource(video.draft, video.approved) && video.confirmationAction === "finalize_video" ? "已定稿" : "初稿可看";
}

// 草稿和右侧视频都按准确修订读取；失败有可见重试，不用永久 loading 代替错误。
function useStageRevision(source: ContentSource | null, cache: Record<string, ArtifactRevision>) {
  const artifactId = source?.kind === "artifact_revision" ? source.artifactId : null;
  const revisionId = source?.kind === "artifact_revision" ? source.revisionId : null;
  const key = artifactId && revisionId ? `${artifactId}:${revisionId}` : null;
  const [result, setResult] = useState<{ key: string; revision: ArtifactRevision | null; error: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!artifactId || !revisionId || !key || cache[key]) return;
    let disposed = false;
    setResult(null);
    void agentApi.readRevision(artifactId, revisionId).then(revision => {
      if (!disposed) setResult({ key, revision, error: false });
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
// 索引外批次（历史消息点开）直接按所读详情渲染，不重发搜索。阶段工作台与无事项视图共用。
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
  conversationId, works, selectedWorkId, onSelectWork, artifacts, revisions, proposals, runs, materialBatches,
  onConfirmStage, stageBusyKeys, canContinueText, onAccept, accepting, onOpenArtifact, onOpenRun, onEnsureRun, referenceErrors, feedback, simulated, openBatchId,
  navigation, onPrepareProduction, preparing, failedPrepareWorkIds, onAdoptMaterial, adoptDisabled,
}: {
  conversationId: string;
  works: Work[];
  selectedWorkId: string | null;
  navigation: { workId: string; stage: WorkStage; artifactId: string; revisionId: string } | null;
  onPrepareProduction: (work: Work) => void;
  preparing: boolean;
  // 有明确失败记录的准备请求（消息 target 指向该事项且已失败）：再次准备按“重新准备费用”表述。
  failedPrepareWorkIds: readonly string[];
  onSelectWork: (workId: string) => void;
  artifacts: ArtifactHead[];
  revisions: Record<string, ArtifactRevision>;
  proposals: Proposal[];
  runs: Run[];
  materialBatches: MaterialBatchIndexItem[];
  onAdoptMaterial?: AdoptMaterial | undefined;
  adoptDisabled?: boolean | undefined;
  onConfirmStage: (work: Work, action: StageAction, subject: ContentSourceInput, label: string, next?: "prepare_production") => Promise<boolean>;  stageBusyKeys: readonly string[];
  canContinueText: boolean;
  onAccept: ((proposal: Proposal) => void) | undefined;
  accepting: string[];
  onOpenArtifact: (artifactId: string, revisionId: string) => void;
  onOpenRun: (runId: string) => void;
  // 被动补读所看修订的 run（E1）：合入同一会话缓存，不跳页。
  onEnsureRun: (runId: string) => void;
  referenceErrors: Record<string, string>;
  feedback: FeedbackDrafts;
  simulated: boolean;
  openBatchId: string | null;
}) {
  const work = works.find(item => item.id === selectedWorkId) ?? works[0] ?? null;
  // 阅读位置与稿旁意见按会话持久：刷新/切会话后回到同一阶段、同一修订、同一草稿（B03）。
  const [storedReading] = useState(() => loadStageReading(conversationId));
  const [shownStages, setShownStages] = useState<Record<string, WorkStage>>(storedReading.stageByWork);
  const shownStage = work ? shownStages[work.id] ?? work.stage : "content";
  const stageKey = `${work?.id}:${shownStage}`;
  const [shownRevisions, setShownRevisions] = useState<Record<string, StageRevisionRef | null>>(storedReading.revisionByStage);
  useEffect(() => {
    if (!navigation) return;
    setShownStages(current => ({ ...current, [navigation.workId]: navigation.stage }));
    setShownRevisions(current => ({ ...current, [`${navigation.workId}:${navigation.stage}`]: {
      artifactId: navigation.artifactId, revisionId: navigation.revisionId,
    } }));
  }, [navigation]);
  const viewingRef = shownRevisions[stageKey] ?? null;
  const setViewingRevision = (ref: StageRevisionRef | null) => setShownRevisions(current => ({ ...current, [stageKey]: ref }));
  const [expandedBatch, setExpandedBatch] = useState<string | null>(storedReading.batchId);
  const [feedbackKey, setFeedbackKey] = useState<string | null>(null);
  // 片段针对（B1）：只在意见框打开期间生效；清空或换段不影响整稿意见。
  const [feedbackSegment, setFeedbackSegment] = useState<{ runId: string; segmentId: string } | null>(null);
  const workspace = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(850);
  useEffect(() => {
    if (!workspace.current) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]!.contentRect.width > 0) setWorkspaceWidth(entries[0]!.contentRect.width);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  // 新产出不抢正在阅读的阶段；A/B 各自保留查看位置和未发送意见。
  useEffect(() => {
    if (work) setShownStages(current => current[work.id] ? current : { ...current, [work.id]: work.stage });
  }, [work?.id]);
  // 切换事项时清掉片段针对，避免把 A 事项的片段引用带进 B 事项的意见。
  useEffect(() => { setFeedbackSegment(null); }, [work?.id]);
  // 阅读引用与意见草稿写回本会话存储；无内容时清空，不残留旧视图。
  useEffect(() => {
    saveStageReading(conversationId, { stageByWork: shownStages, revisionByStage: shownRevisions, batchId: expandedBatch });
  }, [conversationId, shownStages, shownRevisions, expandedBatch]);


  // 消息引用的批次被点开时，展开该批次；卡片自行按 ID 读取详情。
  useEffect(() => {
    if (!openBatchId) return;
    setExpandedBatch(openBatchId);
  }, [openBatchId]);

  // 第一次阅读就保存准确引用；业务更新只用于提示，不决定用户正在看哪版。
  const draftRevisionRef = work?.stages[shownStage].draft?.kind === "artifact_revision"
    ? { artifactId: work.stages[shownStage].draft!.artifactId, revisionId: work.stages[shownStage].draft!.revisionId }
    : null;
  useEffect(() => {
    if (draftRevisionRef && !viewingRef) setViewingRevision(draftRevisionRef);
  }, [stageKey, draftRevisionRef?.artifactId, draftRevisionRef?.revisionId, viewingRef]);

  const draft = work?.stages[shownStage].draft ?? null;
  const displayedSource = draft?.kind === "artifact_revision" && viewingRef
    ? { ...draft, artifactId: viewingRef.artifactId, revisionId: viewingRef.revisionId }
    : draft;
  const draftRead = useStageRevision(displayedSource, revisions);
  const draftRevision = draftRead.revision;
  // 指向片段的意见要对照当前方案草稿的段落（B2）：主稿读取放顶层，读取中不阻塞选择。
  const planDraftSource = work?.stages.plan.draft?.kind === "artifact_revision" ? work.stages.plan.draft : null;
  const planDraftRead = useStageRevision(planDraftSource, revisions);
  // 所看视频修订决定阅读身份（E1）：整片、片段条、片段针对与制作记录同属该修订的 run。
  // 尚无任何成片修订的初次制作仍看当前在途 run；修订读取中/失败/历史修订无 runId 时不拿最新 run 猜配。
  const viewingRunId = work && shownStage === "video"
    ? draftRevision?.runId ?? (draft == null && work.stages.video.runId ? work.stages.video.runId : null)
    : null;
  const viewingRunLoaded = viewingRunId == null || runs.some(run => run.id === viewingRunId);
  // 回调身份不进依赖：父级每次渲染都会换新箭头，进了依赖会让补读 effect 反复触发。
  const ensureRunRef = useRef(onEnsureRun);
  ensureRunRef.current = onEnsureRun;
  useEffect(() => {
    // 所看 run 不在已加载列表时按 ID 补读进父级会话缓存；失败一次后等用户手动重试，不自动循环。
    if (!viewingRunId || viewingRunLoaded || referenceErrors[`run:${viewingRunId}`]) return;
    ensureRunRef.current(viewingRunId);
  }, [viewingRunId, viewingRunLoaded, referenceErrors]);
  // 方案草稿前进时，同一打开的片段意见把未发送文字带到新方案键（E1）：仅同事项同片段，
  // 不跨事项、不动整稿意见；已提交的意见不在草稿里，自然不迁移。
  const carriedFeedbackRef = useRef<{ revisionId: string; segment: { runId: string; segmentId: string } } | null>(null);
  useEffect(() => {
    const revisionId = planDraftSource?.revisionId ?? null;
    const prior = carriedFeedbackRef.current;
    carriedFeedbackRef.current = revisionId && feedbackSegment ? { revisionId, segment: feedbackSegment } : null;
    if (!work || !planDraftSource || !revisionId || !feedbackSegment || !prior
      || prior.revisionId === revisionId
      || prior.segment.runId !== feedbackSegment.runId || prior.segment.segmentId !== feedbackSegment.segmentId) return;
    feedback.carryForward(
      { artifactId: planDraftSource.artifactId, revisionId: prior.revisionId, workId: work.id, segment: prior.segment },
      { artifactId: planDraftSource.artifactId, revisionId, workId: work.id, segment: feedbackSegment });
  }, [planDraftSource?.artifactId, planDraftSource?.revisionId, feedbackSegment, feedback, work]);
  if (!work) return null;
  const inFlight = runs.some(run => run.workId === work.id && !runEnded(run.state));
  const stageView = work.stages[shownStage];
  const draftCurrent = sameSource(stageView.approved, draft);
  const displayedApproved = sameSource(stageView.approved, displayedSource);
  // 认可在途键带 next 变体：同一动作的“认可并准备制作”与“仅认可”互不占用对方的命令缓存。
  const busyKey = (action: StageAction, next?: "prepare_production") => `${work.id}:${action}:${next ?? "plain"}`;
  const busy = (action: StageAction, next?: "prepare_production") => stageBusyKeys.includes(busyKey(action, next));
  const currentFeedbackKey = `${stageKey}:${displayedSource?.kind === "artifact_revision" ? displayedSource.revisionId : ""}`;
  const feedbackOpen = feedbackKey === currentFeedbackKey;
  const feedbackTarget = displayedSource?.kind === "artifact_revision"
    ? { artifactId: displayedSource.artifactId, revisionId: displayedSource.revisionId, workId: work.id } : null;
  // 标题跟所看修订的 artifact（E1）；历史视频修订没有可查标题时用中性名，不冒充最新稿。
  const viewingArtifact = displayedSource?.kind === "artifact_revision"
    ? artifacts.find(item => item.id === displayedSource.artifactId) ?? null : null;
  const viewingOld = draft?.kind === "artifact_revision" && viewingRef !== null
    && (viewingRef.artifactId !== draft.artifactId || viewingRef.revisionId !== draft.revisionId);
  const boundProposal = proposals.find(item => item.id === work.stages.plan.proposalId && item.state === "ready") ?? null;
  // 成对方案草稿（B3）：方案主稿的采用来源正是当前内容稿。认可内容并继续不再依赖文本模型，
  // 服务端也只补记认可；按钮直接带用户去看对应方案。
  const pairedPlan = work.stages.plan.draft != null && !work.stages.plan.upstreamStale;
  const videoRun = viewingRunId ? runs.find(run => run.id === viewingRunId) ?? null : null;
  const segments = shownStage === "video" ? videoRun?.segments ?? [] : [];
  // 正在针对的片段按 runId+segmentId 找回标题与序号，不依赖当前停在哪个阶段。
  const feedbackSegmentRun = feedbackSegment ? runs.find(run => run.id === feedbackSegment.runId) ?? null : null;
  const feedbackSegmentIndex = feedbackSegmentRun && feedbackSegment
    ? feedbackSegmentRun.segments.findIndex(item => item.segmentId === feedbackSegment.segmentId) : -1;
  const feedbackSegmentTitle = feedbackSegmentIndex >= 0 ? feedbackSegmentRun!.segments[feedbackSegmentIndex]!.title : null;
  // 目标段已在新方案中删除/重分（B2）：按稳定 section id 对照当前方案草稿；读取中不拦截，
  // 由服务端入口核对兜底。意见文字保留，重选片段后可继续用。
  const planSections = planDraftRead.revision?.content.format === "markdown" ? planDraftRead.revision.content.sections ?? [] : null;
  const segmentStillCurrent = !feedbackSegment || planSections == null
    || planSections.some(section => section.id === feedbackSegment.segmentId);
  const confirmedStage = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(shownStage) + 1).reverse().find(stage => work.stages[stage].approved);
  const approved = confirmedStage ? work.stages[confirmedStage].approved : null;
  // 指向片段的意见（B2.5）：主稿换成当前方案草稿，segment 保留用户正在看的那次运行；
  // 没有方案草稿时退回整稿目标，不虚构方案来源。段失效时目标不变，保留意见文字并拦下提交。
  const feedbackSubmitTarget = feedbackSegment && planDraftSource
    ? { artifactId: planDraftSource.artifactId, revisionId: planDraftSource.revisionId, workId: work.id,
        segment: { runId: feedbackSegment.runId, segmentId: feedbackSegment.segmentId } }
    : feedbackTarget;
  const { text: feedbackText, saved: feedbackSaved, busy: feedbackBusy } = feedback.forTarget(feedbackSubmitTarget);
  // 片段意见的主目标是当前方案草稿，不是所看旧视频修订（E1）：旧画面上仍可记录意见；
  // 整稿意见在旧稿上维持只读，不放开旧稿认可。
  const segmentFeedbackLive = feedbackSegment != null && planDraftSource != null;
  const feedbackReadOnly = viewingOld && !segmentFeedbackLive;
  const updateFeedbackDraft = (text: string) => { if (feedbackSubmitTarget && !feedbackReadOnly) feedback.edit(feedbackSubmitTarget, text); };
  const sendFeedback = () => { if (feedbackSubmitTarget && !feedbackReadOnly) return feedback.submit(feedbackSubmitTarget); };

  const confirmButton = (action: StageAction, label: string, primary = true, disabled = false, note?: string, next?: "prepare_production", requestText?: string, after?: () => void) => {
    if (!draft) return null;
    const subject = contentSubjectInput(draft);
    // 同阶段任一认可在途时整组禁用，避免并发确认相互覆盖。
    const stageBusy = STAGE_ACTIONS_BY_STAGE[shownStage].some(item => stageBusyKeys.some(key => key.startsWith(`${work.id}:${item}:`)));
    return <span className="agent-stage-action" key={`${action}:${next ?? "plain"}`}>
      <button type="button" className={primary ? "agent-stage-primary" : "agent-stage-secondary"}
        disabled={disabled || stageBusy}
        onClick={() => void onConfirmStage(work, action, subject, requestText ?? label, next).then(ok => { if (ok && after) after(); })}>{label}{busy(action, next) ? "…" : ""}</button>
      {note ? <small>{note}</small> : null}
    </span>;
  };

  return <section ref={workspace} className="agent-work" data-work-id={work.id} aria-label={`创作：${work.title}`}>
    {works.length > 1 ? <div className="agent-work-tabs" role="tablist" aria-label="当前对话中的创作">
      {works.map(item => <button type="button" key={item.id} role="tab" aria-selected={item.id === work.id} onClick={() => onSelectWork(item.id)}>
        <Film /><span><strong>{item.title}</strong><small>{workPhaseLabel(item, runs)}</small></span>
      </button>)}
    </div> : null}
    <header className="agent-work-heading">
      <div><h2>{work.title}</h2><span className="agent-work-phase">{workPhaseLabel(work, runs)}</span></div>
      {draft?.kind === "artifact_revision" ? <div className="agent-work-heading-tools">
        {feedbackSaved ? <span role="status" className="agent-feedback-saved">{feedbackSaved}</span> : null}
        <button type="button" className="agent-stage-secondary" disabled={viewingOld && !feedbackText} onClick={() => {
          setFeedbackKey(feedbackOpen ? null : currentFeedbackKey);

        }}><Pencil />{feedbackOpen ? "收起意见" : "提意见"}</button>
      </div> : null}
    </header>
    {feedbackOpen && draft?.kind === "artifact_revision" ? <div className="agent-work-feedback">
      {feedbackSegment ? <span className="agent-target-chip">
        针对：片段 {feedbackSegmentIndex >= 0 ? feedbackSegmentIndex + 1 : ""}{feedbackSegmentTitle ? `「${feedbackSegmentTitle}」` : ""}
        <button type="button" onClick={() => setFeedbackSegment(null)} aria-label="取消针对该片段"><X /></button>
      </span> : null}
      <label>这条意见只记录，不会自动改稿<textarea readOnly={feedbackReadOnly} value={feedbackText} onChange={event => updateFeedbackDraft(event.target.value)} placeholder="留给这一版的意见…" aria-label="意见" /></label>
      {feedbackReadOnly ? <p>这是旧稿的未发送意见，可以复制后继续讨论。</p> : null}
      {feedbackSegment && !segmentStillCurrent ? <p>这一段已不在当前方案里；请重新选择片段，意见文字已保留。</p> : null}
      <button type="button" onClick={() => void sendFeedback()}
        disabled={feedbackReadOnly || !feedbackText.trim() || feedbackBusy || (feedbackSegment != null && !segmentStillCurrent)}>{feedbackBusy ? "正在保存…" : "记录意见"}</button>
    </div> : null}
    <div className="agent-stage-tabs" role="tablist" aria-label="查看创作阶段">
      {STAGE_ORDER.map((stage, index) => {
        const view = work.stages[stage];
        const disabled = stage !== "content" && !view.draft && !view.approved && !view.proposalId && !view.runId;
        const confirmed = Boolean(view.draft && sameSource(view.approved, view.draft)
          && (view.confirmationAction === "approve_content" || view.confirmationAction === "approve_content_continue" || view.confirmationAction === "approve_plan" || view.confirmationAction === "finalize_video"));
        return <button type="button" role="tab" key={stage} aria-selected={shownStage === stage} disabled={disabled}
          onClick={() => setShownStages(current => ({ ...current, [work.id]: stage }))}>
          <span>{index + 1}</span>{STAGE_LABELS[stage]}{confirmed ? <Check /> : null}
        </button>;
      })}
    </div>
    <Group orientation={workspaceWidth < 640 ? "vertical" : "horizontal"} className="agent-work-split" id="agent-work-split">
      <Panel id="agent-work-draft" defaultSize="55%" minSize={workspaceWidth < 640 ? "210px" : "280px"}>
      <section className="agent-work-draft" aria-label="草稿与修改">
        <div className="agent-work-pane-title"><h3>草稿与修改</h3><span>{STAGE_LABELS[shownStage]}</span></div>
        <div className="agent-work-draft-scroll" key={`${stageKey}:${viewingRef?.revisionId}`}>
          {!draft ? <div className="agent-stage-empty">
            {shownStage === "content" ? "还没有内容主稿。正式开始一条视频后，Frame 会先交内容草稿。" : shownStage === "plan" ? "内容认可并继续后，画面与声音方案会在这里。" : "还没有视频初稿。"}
          </div> : <>
            <div className="agent-stage-meta">
              {draft.kind === "artifact_revision"
                ? <span>{viewingArtifact?.title ?? (shownStage === "video" ? "视频稿" : "内容主稿")} · v{draftRevision?.revisionNumber ?? "…"}</span>
                : <span>聊天原文 · {draft.author === "user" ? "用户消息" : "Frame 消息"}</span>}
              {shownStage === "content" && displayedApproved
                ? <span className="agent-stage-state">{stageView.confirmationAction === "approve_content_continue" ? "已认可并继续" : "已认可，暂停中"}</span>
                : shownStage === "plan" && displayedApproved
                  ? <span className="agent-stage-state">{stageView.confirmationAction === "approve_plan" ? "已认可" : "待确认"}</span>
                  : shownStage === "video"
                    ? <span className="agent-stage-state">{displayedApproved ? "已定稿" : "待审阅"}</span>
                    : <span className="agent-stage-state">有新稿待确认</span>}
            </div>
            {viewingOld ? <div className="agent-inline-note">正在看旧版本，不能在这里确认；请回到最新稿。</div> : null}
            {shownStage === "plan" && stageView.upstreamStale ? <div className="agent-inline-note">内容主稿已更新，这份方案待更新；确认新内容并继续后再准备。</div> : null}
            {shownStage === "content" && pairedPlan && !displayedApproved ? <div className="agent-inline-note">画面与声音方案已按这版内容改好；认可后直接查看对应方案。</div> : null}
            {shownStage === "video" && stageView.upstreamStale ? <div className="agent-inline-note">基于当前方案修改，画面尚未按新方案重新制作；针对片段的意见会记在当前方案草稿上。</div> : null}
            {displayedApproved ? <p className="agent-stage-muted">{shownStage === "video"
              ? "这一版已定稿，保留在右侧成果区。想调整时，可以在对话中讨论下一版。"
              : "这份内容已确认，保留在右侧成果区。你可以继续下一步，或在对话中提出修改。"}</p>
              : draft.kind === "artifact_revision" && draftRevision
              ? <div className="agent-stage-body">{draftRevision.content.format === "markdown"
                ? <MarkdownBody content={draftRevision.content} />
                : <MediaPreview content={draftRevision.content} simulated={simulated} />}</div>
              : draft.kind === "artifact_revision"
                ? draftRead.error
                  ? <div role="status">草稿读取失败。<button type="button" onClick={draftRead.retry}>重试读取草稿</button></div>
                  : <div className="agent-stage-loading">正在读取…</div>
                : <div className="agent-stage-body"><MarkdownText text={draft.text} /></div>}
          </>}
          {shownStage === "video" && videoRun?.audioSummary ? <AudioSummaryView summary={videoRun.audioSummary} title="这版视频的声音" /> : null}
          {shownStage === "video" && segments.length > 0 ? <div className="agent-segment-strip" aria-label="按播放顺序的片段">
            {segments.map((segment, index) => <SegmentCard key={segment.segmentId} segment={segment} index={index}
              selected={feedbackSegment != null && feedbackSegment.runId === viewingRunId
                && feedbackSegment.segmentId === segment.segmentId}
              onSelect={() => {
                if (feedbackSegment != null && feedbackSegment.segmentId === segment.segmentId
                  && feedbackSegment.runId === viewingRunId) {
                  setFeedbackSegment(null);
                  return;
                }
                setFeedbackSegment({ runId: viewingRunId!, segmentId: segment.segmentId });
                setFeedbackKey(currentFeedbackKey);
              }} />)}
          </div> : null}
          {shownStage === "video" && viewingRunId && !videoRun ? <p className="agent-stage-muted">
            {referenceErrors[`run:${viewingRunId}`]
              ? <>这份制作的片段读取失败，视频本身不受影响。<button type="button" onClick={() => onEnsureRun(viewingRunId)}>重试</button></>
              : "正在读取这份制作的片段…"}
          </p> : null}
          {shownStage === "video" && draftRevision && !viewingRunId ? <p className="agent-stage-muted">这份成片没有关联的制作片段记录。</p> : null}
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
          {shownStage === "video" && viewingRunId ? <p className="agent-stage-runlink">
            <button type="button" onClick={() => onOpenRun(viewingRunId)}>查看制作记录</button>
          </p> : null}
          {shownStage === "plan" && !viewingOld && boundProposal ? <div className="agent-stage-proposal">
            <ProposalCard works={works} runs={runs} proposal={boundProposal} onAccept={onAccept} busy={accepting.includes(boundProposal.id)}
              artifacts={artifacts} revisions={revisions} onOpen={onOpenArtifact} onOpenRun={onOpenRun} />
          </div> : null}
        </div>
        <div className="agent-stage-actions">
          {!draft ? null
            : inFlight ? <span className="agent-stage-muted">制作使用已确认版本，修改意见留给下一版。</span>
            : viewingOld ? <button type="button" className="agent-stage-secondary" onClick={() => setViewingRevision(draftRevisionRef)}>查看最新稿</button>
            : draft.kind === "artifact_revision" && draftRevision?.baseRevisionId && !viewingOld
              ? <button type="button" className="agent-stage-secondary" onClick={() => setViewingRevision({ artifactId: draft.artifactId, revisionId: draftRevision.baseRevisionId! })}>看上一版</button>
              : null}
          {!draft || inFlight || viewingOld ? null : shownStage === "content"
            ? draftCurrent && stageView.confirmationAction === "approve_content_continue"
              ? <span className="agent-stage-muted">已认可并继续画面阶段；改稿后会重新等待确认。</span>
              : <>
                {draftCurrent && stageView.confirmationAction === "approve_content" ? null
                  : confirmButton("approve_content", "认可，暂不继续", false)}
                {pairedPlan
                  // 成对方案已就位：服务端只补记认可，不依赖文本模型，成功后直接带用户看方案。
                  ? confirmButton("approve_content_continue", "认可内容，查看对应方案", true, false, undefined, undefined, undefined,
                    () => setShownStages(current => ({ ...current, [work.id]: "plan" })))
                  : confirmButton("approve_content_continue", "认可并继续画面", true, !canContinueText,
                    canContinueText ? undefined : "继续画面需要可用的文本模型")}
              </>
            : shownStage === "plan"
              ? draftCurrent && stageView.confirmationAction === "approve_plan"
                ? boundProposal && !stageView.upstreamStale && Date.parse(boundProposal.expiresAt) > Date.now()
                  ? <span className="agent-stage-muted">费用已列在制作提案中，确认一次即可开始。</span>
                  // 已认可但无有效提案：可再次准备费用。work.stage 曾到过 video 不挡下一版；
                  // 在途制作已在整块入口拦下，这里只看当前认可与在途事实。
                  : !stageView.upstreamStale
                    ? <button type="button" className="agent-stage-primary" disabled={!canContinueText || preparing}
                        onClick={() => onPrepareProduction(work)}>{preparing ? "正在准备…" : failedPrepareWorkIds.includes(work.id) ? "重新准备费用" : "准备制作"}</button> : null
                : (() => {
                  // 两个按钮共享同一份方案修订：一次点击 = 一次方案认可，主按钮同时排一次报价请求。
                  const planBlocked = stageView.upstreamStale
                    || !sameSource(work.stages.content.draft, work.stages.content.approved)
                    || work.stages.content.confirmationAction !== "approve_content_continue";
                  return <>
                    {confirmButton("approve_plan", "认可并继续制作", true, planBlocked || !canContinueText,
                      planBlocked ? "先确认内容并继续后再认可方案" : canContinueText ? undefined : "准备制作需要可用的文本模型",
                      "prepare_production",
                      `这份「${work.title}」的画面与声音方案我认可了。请按这份方案准备制作：列出本次费用让我确认；方案内容不变，不需要重新交稿或认可；现在先不提交生成。`)}
                    {confirmButton("approve_plan", "认可方案，暂不制作", false, planBlocked,
                      planBlocked ? "先确认内容并继续后再认可方案" : undefined)}
                  </>;
                })()
              : draftCurrent && stageView.confirmationAction === "finalize_video"
                ? <span className="agent-stage-muted">这一版已定稿；修改请准备下一版。</span>
                : confirmButton("finalize_video", "以这版定稿")}
        </div>
      </section>
      </Panel>
      <Separator className={`agent-resizer agent-work-divider${workspaceWidth < 640 ? " vertical" : ""}`} aria-label="调整草稿与成果大小" />
      <Panel id="agent-work-media" minSize={workspaceWidth < 640 ? "170px" : "240px"}>
      <section className="agent-work-media" aria-label="已确认成果">
        <div className="agent-work-pane-title"><h3>已确认成果</h3></div>
        <div className="agent-work-media-scroll" key={`${work.id}:${confirmedStage}:${approved?.kind === "artifact_revision" ? approved.revisionId : approved?.messageId}`}>
          {confirmedStage && approved ? <ConfirmedStage stage={confirmedStage} source={approved}
            hasNewDraft={!sameSource(approved, work.stages[confirmedStage].draft)} revisions={revisions} simulated={simulated}
            runs={runs} readingRunId={viewingRunId} onEnsureRun={onEnsureRun} referenceErrors={referenceErrors} />
            : <div className="agent-stage-empty">你确认后的脚本、方案和视频会留在这里。</div>}

        </div>
      </section>
      </Panel>
    </Group>
  </section>;
}

function ConfirmedStage({ stage, source, hasNewDraft, revisions, simulated, runs, readingRunId, onEnsureRun, referenceErrors }: {
  stage: WorkStage; source: ContentSource; hasNewDraft: boolean;
  revisions: Record<string, ArtifactRevision>; simulated: boolean;
  runs: Run[]; readingRunId: string | null; onEnsureRun: (runId: string) => void; referenceErrors: Record<string, string>;
}) {
  const { revision, error, retry } = useStageRevision(source, revisions);
  const runId = stage === "video" ? revision?.runId ?? null : null;
  const run = runs.find(item => item.id === runId);
  const ensureRun = useRef(onEnsureRun);
  ensureRun.current = onEnsureRun;
  useEffect(() => {
    if (runId && runId !== readingRunId && !run && !referenceErrors[`run:${runId}`]) ensureRun.current(runId);
  }, [runId, readingRunId, run, referenceErrors]);
  const label = { content: "内容稿", plan: "画面与声音方案", video: "视频初稿" }[stage];
  // 版本号只在有多版时出现；首版不挂常驻 v1。区域标题已是“已确认成果”，条目不再重复。
  return <article className="agent-confirmed-stage" aria-label={`已确认${label}`}>
    <header><h4>{label}</h4>{source.kind === "artifact_revision" && (revision?.revisionNumber ?? 0) > 1 ? <span>v{revision?.revisionNumber}</span> : null}</header>
    {hasNewDraft ? <p className="agent-stage-muted">新草稿讨论中，这份成果保持不变。</p> : null}
    {source.kind === "message_text" ? <MarkdownText text={source.text} />
      : revision ? revision.content.format === "markdown" ? <MarkdownBody content={revision.content} /> : <MediaPreview content={revision.content} simulated={simulated} />
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
