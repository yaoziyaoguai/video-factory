import { Activity, AlertTriangle, Check, Clock3, Download, Pause, Play, RotateCcw, Send, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StudioCostRunDetail, StudioDecisionInput, StudioNarrationRevisionInput, StudioSceneResourceRevisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProvider, StudioRunDetail, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput, StudioVisualReinspectionInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { initialFilmArrival, nextFilmArrival } from "../film-arrival.js";
import { StatusBadge } from "./StatusBadge.js";
import { agentLoopPendingNote, agentLoopPhaseLabel, creatorFacingTechnicalText, creatorRunStatusLabel, platformLabel, providerLabel, catalogModelLabel, runNodeLabel, RUN_NODE_LABELS, sourceAssetReviewBreakdown } from "../presentation.js";
import { NodeWorkspace, revealNodeWorkspace } from "./NodeWorkspace.js";
import { RunCostDetailPanel } from "./CostDashboard.js";
import { AudioReviewPanel } from "./AudioReviewPanel.js";

interface RunWorkbenchProps {
  creativeDiscussion?: ReactNode;
  run: StudioRunDetail;
  providers?: StudioProvider[];
  decisionPending: boolean;
  onDecision: (input: StudioDecisionInput) => Promise<void>;
  onRequestSceneRevision?: (input: StudioSceneRevisionInput) => Promise<void>;
  /** 重取某一镜的素材：在这一镜已通过语义筛选的候选里改选下一名，画面换一版。 */
  onRequestSceneResourceRevision?: (input: StudioSceneResourceRevisionInput) => Promise<void>;
  onRequestNarrationRevision?: (input: StudioNarrationRevisionInput) => Promise<void>;
  /** 取这一镜当前的旁白/字幕原文；改字要看得到原文，否则只能凭记忆重打一遍。 */
  onLoadSceneNarration?: (scenePosition: number) => Promise<string>;
  onReinspectVisualReview?: (input: StudioVisualReinspectionInput) => Promise<void>;
  onOpenPublish?: () => void;
  onRestart?: () => void;
  costDetail?: StudioCostRunDetail;
  nodeMutationPending?: boolean;
  pausePending?: boolean;
  onOverrideNode?: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onOverrideNodeInput?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onConfigureNode?: (nodeId: string, input: StudioNodeExecutionConfigurationInput) => Promise<void>;
  onAuthorizeSpend?: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRejectSpend?: (nodeId: string, input: StudioSpendRejectionInput) => Promise<void>;
  onRegenerateStale?: () => Promise<void>;
  onRequestPause?: () => Promise<void>;
  onResumePaused?: () => Promise<void>;
  onQueryOriginalTextTask?: () => Promise<void>;
  onRetrieveOriginalTextTask?: () => Promise<void>;
  onRetryFailedNode?: (nodeId: string) => Promise<void>;
  paidNodeSummary?: StudioPaidNodeSummary;
  onReconcilePaidNode?: (nodeId: string, input: StudioPaidReconciliationDraft) => Promise<void>;
  connectionHeartbeatAt?: string;
}

export function RunWorkbench({ run, creativeDiscussion, providers = [], decisionPending, onDecision, onRequestSceneRevision, onRequestSceneResourceRevision, onRequestNarrationRevision, onLoadSceneNarration, onReinspectVisualReview, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, pausePending = false, onOverrideNode, onOverrideNodeInput, onConfigureNode, onAuthorizeSpend, onRejectSpend, onRegenerateStale, onRequestPause, onResumePaused, onQueryOriginalTextTask, onRetrieveOriginalTextTask, onRetryFailedNode, paidNodeSummary, onReconcilePaidNode, connectionHeartbeatAt }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, { decision: "accept" | "reject" | "accept_risk"; reason: string }>>({});
  const [replanningVoice, setReplanningVoice] = useState(false);
  const [voiceDurationSeconds, setVoiceDurationSeconds] = useState("");
  const [hasPendingPlanningConfiguration, setHasPendingPlanningConfiguration] = useState(false);
  const [decisionSnapshot, setDecisionSnapshot] = useState<Pick<StudioDecisionInput, "expectedRunRevision" | "interventionId" | "reviewEvidenceId"> & { acceptIncomplete?: true }>();
  const previewRef = useRef<HTMLVideoElement>(null);
  const closeRejectDecision = () => {
    setRejecting(false);
    setDecisionSnapshot(undefined);
  };
  const closeApproveDecision = () => {
    setApproving(false);
    setDecisionSnapshot(undefined);
  };
  const rejectDialogRef = useDialogFocus<HTMLElement>(rejecting, closeRejectDecision, decisionPending);
  const approveDialogRef = useDialogFocus<HTMLElement>(approving, closeApproveDecision, decisionPending);
  const closeVoiceTimingDecision = () => {
    setReplanningVoice(false);
    setDecisionSnapshot(undefined);
  };
  const voiceTimingDialogRef = useDialogFocus<HTMLElement>(replanningVoice, closeVoiceTimingDecision, decisionPending);
  const readOnly = run.continuation?.supported === false;
  const video = run.artifacts.find((artifact) => artifact.id === run.videoArtifactId);
  // loadeddata 的资格属于具体媒体源；同一个播放器换片时不能借用旧片的 ready 状态。
  const videoIdentity = video?.contentUrl ? `${run.id}\0${video.id}\0${video.contentUrl}` : undefined;
  const [filmArrival, setFilmArrival] = useState(initialFilmArrival);
  const [readyVideoIdentity, setReadyVideoIdentity] = useState<string>();
  const [filmRevealIdentity, setFilmRevealIdentity] = useState<string>();
  const filmRevealTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const outcome = nextFilmArrival(filmArrival, run.id, video?.id, Boolean(videoIdentity && readyVideoIdentity === videoIdentity));
    if (outcome.state !== filmArrival) setFilmArrival(outcome.state);
    if (outcome.reveal && videoIdentity) {
      setFilmRevealIdentity(videoIdentity);
      if (filmRevealTimerRef.current !== undefined) window.clearTimeout(filmRevealTimerRef.current);
      filmRevealTimerRef.current = window.setTimeout(() => setFilmRevealIdentity((current) => current === videoIdentity ? undefined : current), 900);
    }
  }, [filmArrival, readyVideoIdentity, run.id, video?.id, videoIdentity]);
  useEffect(() => {
    if (filmRevealTimerRef.current !== undefined) window.clearTimeout(filmRevealTimerRef.current);
    setFilmRevealIdentity(undefined);
  }, [run.id, videoIdentity]);
  useEffect(() => () => {
    if (filmRevealTimerRef.current !== undefined) window.clearTimeout(filmRevealTimerRef.current);
  }, []);
  // 边界停点：这一步已做完、产物已存，只等用户决定是否进入下一步。按钮文案必须按
  // 它真正的后果说话——把中间节点的放行写成「批准进入发布包」会让用户以为点下去就发了。
  const boundaryGate = run.activeIntervention?.boundary === "node-complete";
  const boundaryOptions = boundaryGate ? run.activeIntervention?.options ?? [] : [];
  // 停点放行的是下一步，而下一步还没跑、没有任何产物，于是它从前落不进 creatorNodes：
  // 用户看得到「进入下一步」，却找不到地方配置那一步怎么跑——简报之后最典型，创作规划
  // 用哪个模型只能等它自己跑起来才有地方改。带可调执行的下一步在停点上一并露出。
  const nextGateNode = boundaryGate ? nextConfigurableNode(run) : undefined;
  const creatorNodes = run.nodes.filter((node) => node.id === nextGateNode?.id || nodeHasCreatorContent(node, run));
  const activeSpendNode = readOnly ? undefined : creatorNodes.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
  const currentArtifactNode = !video?.contentUrl && !creativeDiscussion && run.activeIntervention?.kind !== "creative_review"
    ? creatorNodes.find((node) => node.id === run.activeIntervention?.nodeId && node.id !== activeSpendNode?.id)
    : undefined;
  const remainingCreatorNodes = creatorNodes.filter((node) => node.id !== activeSpendNode?.id && node.id !== currentArtifactNode?.id);
  const showReviewSurface = Boolean(readOnly || video?.contentUrl || (run.activeIntervention && run.activeIntervention.kind !== "creative_review") || isStoppedStatus(run.status));
  const uncertainPaidNode = run.nodes.find((node) => node.outcomeUncertain === true);
  const visiblePaidNodeSummary = paidNodeSummary?.nodeId === uncertainPaidNode?.id ? paidNodeSummary : undefined;
  const uncertainPaidNodeProviderId = (uncertainPaidNode?.executionReceipt ?? uncertainPaidNode?.plannedExecution)?.providerId;
  const sourcePreflightDecision = run.activeIntervention?.nodeId === "asset-source-review";
  const visualReview = sourcePreflightDecision ? undefined : visualReviewDecision(run);
  const sourceReviewEvidenceId = sourceReviewDecisionEvidenceId(run);
  const sourceReviewDecision = run.activeIntervention?.kind === "source_review_decision";
  const sourceReviewRetry = run.activeIntervention?.kind === "source_review_retry";
  const sourceReviewIncompleteRisk = sourceReviewRetry
    && run.activeIntervention?.reviewStatus === "incomplete"
    && run.activeIntervention.providerOutcomeKnown === true;
  const voiceTiming = voiceTimingConflict(run);
  const visualReviewRequiresRevision = visualReview?.recommendation === "revise" || visualReview?.recommendation === "reject";
  const singleVisualReview = visualReview?.mode === "single";
  // 停下来的这一步的独立复核进度。SSE 载荷里没有它，由 preferRunSnapshot 从上一帧补回来，
  // 否则用户点开决策面板的瞬间看到的是一片空白，要等十秒心跳才出现建议。
  const waitingNodeId = run.activeIntervention?.nodeId;
  const waitingNodeProgress = waitingNodeId
    ? run.nodes.find((node) => node.id === waitingNodeId)?.agentLoopProgress
    : undefined;
  const flawedReviewBranches = (visualReview?.independentReviews ?? []).filter((branch) => branch.auditVerdict === "repair");
  // 逐条表态与成片证据只属于「消费成片审片证据」的停点（视觉审片/终审/发布包）；
  // 其它停点（素材预检、配音等）不携带无关的成片证据，与服务端分派保持同一合同。
  const renderedReviewStop = ["visual-review", "final-review", "publish-package"]
    .includes(run.activeIntervention?.nodeId ?? "");
  const reviewItems = renderedReviewStop ? visualReview?.reviewItems ?? [] : [];
  const undisposedReviewItems = reviewItems.filter((item) => item.itemKey && !reviewDecisions[item.itemKey]);
  const acceptedReviewItems = reviewItems.filter((item) => item.itemKey && reviewDecisions[item.itemKey]?.decision === "accept");
  const unexplainedReviewItems = reviewItems.filter((item) => (
    item.itemKey && reviewDecisions[item.itemKey]?.decision === "reject" && !reviewDecisions[item.itemKey]?.reason.trim()
  ));
  const setReviewDecision = (itemKey: string, decision: "accept" | "reject" | "accept_risk") => {
    setReviewDecisions((previous) => ({ ...previous, [itemKey]: { decision, reason: previous[itemKey]?.reason ?? "" } }));
  };
  const setReviewReason = (itemKey: string, reason: string) => {
    setReviewDecisions((previous) => ({ ...previous, [itemKey]: { decision: previous[itemKey]?.decision ?? "reject", reason } }));
  };
  const assetVersionId = run.nodes.find((node) => node.id === "assets")?.outputState?.effectiveVersionId;
  const isCostReplan = run.status === "stale" && hasDirectorCostFeedback(run);
  const sourceAssetFailure = run.failure && isSourceAssetReviewFailure(run.failure)
    ? sourceAssetReviewBreakdown(run.failure)
    : undefined;
  const localRecoveryActions = (run.status === "failed" || run.status === "rejected") && run.taskRecovery && !hasUncertainPaidOutcome(run)
    ? <>
      {run.taskRecovery.allowedActions.includes("retry_failed_step") && onRetryFailedNode && retryableNodeId(run) ? <button
        className={`button ${run.taskRecovery.taskState === "completed_failure" ? "button-primary" : "button-secondary"}`}
        type="button"
        disabled={nodeMutationPending || hasPendingPlanningConfiguration}
        onClick={() => void onRetryFailedNode(retryableNodeId(run)!)}
      ><RotateCcw aria-hidden="true" size={16} />{sourceAssetFailure && run.status === "rejected" ? "重新检查已有试片" : run.failure?.nodeId === "visual-review" ? "重试视觉审片" : "重试失败步骤"}</button> : null}
      {run.taskRecovery.allowedActions.includes("adjust_plan") && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
    </>
    : null;
  const recoveryLocalStateText = run.status === "failed" || run.status === "rejected"
    ? "本地流程已停止等待；原任务不会重复提交，也不会被自动取消。"
    : run.status === "running"
      ? "本地流程仍在运行；原任务状态以最近一次核对结果为准。"
      : run.status === "paused"
        ? "本地流程已暂停；原任务状态以最近一次核对结果为准。"
        : run.status === "needs_human"
          ? "本地流程正在等你决定；原任务状态以最近一次核对结果为准。"
          : `本地流程：${creatorRunStatusLabel(run)}；原任务状态以最近一次核对结果为准。`;
  const taskRecoveryPanel = run.taskRecovery ? <section className="task-recovery-panel" aria-label="原模型任务恢复" role="status">
    <strong>{run.taskRecovery.resultAvailable ? "原任务结果可以取回" : "已保留原模型任务"}</strong>
    {/* 两个维度分开说清：本地流程停在哪、远端原任务处于什么状态；查询优先于重做。 */}
    <p>{recoveryLocalStateText}</p>
    <p>{run.taskRecovery.summary}</p>
    {run.taskRecovery.lastVerifiedAt ? <p><time dateTime={run.taskRecovery.lastVerifiedAt}>上次确认：{formatRecoveryTime(run.taskRecovery.lastVerifiedAt)}</time></p> : null}
    {run.taskRecovery.observationError ? <p className="run-failure-summary">最近查询：{run.taskRecovery.observationError}</p> : null}
    {run.taskRecovery.terminalError ? <p className="run-failure-summary">原任务失败原因：{run.taskRecovery.terminalError}</p> : null}
    <div className="task-recovery-actions">
      {run.taskRecovery.allowedActions.includes("query_original_task") && onQueryOriginalTextTask ? <button
        className="button button-secondary"
        type="button"
        disabled={nodeMutationPending}
        onClick={() => void onQueryOriginalTextTask()}
      ><Activity aria-hidden="true" size={16} />{nodeMutationPending ? "正在查询原任务..." : "查询原任务"}</button> : null}
      {run.taskRecovery.allowedActions.includes("retrieve_and_continue") && onRetrieveOriginalTextTask ? <button
        className="button button-primary"
        type="button"
        disabled={nodeMutationPending}
        onClick={() => void onRetrieveOriginalTextTask()}
      ><Play aria-hidden="true" size={16} />{nodeMutationPending ? "正在取回..." : "取回结果并继续"}</button> : null}
    </div>
    {localRecoveryActions ? <div className="task-recovery-local">
      <p className="task-recovery-group-label">本地流程动作（已保留 {run.failure?.savedNodeCount ?? 0} 个步骤的结果）</p>
      <div className="task-recovery-actions">{localRecoveryActions}</div>
    </div> : null}
  </section> : null;

  const renderNodeWorkspace = (node: StudioRunDetail["nodes"][number]) => <NodeWorkspace
    key={node.id}
    node={node}
    nodes={run.nodes}
    providers={providers}
    runStatus={run.status}
    artifacts={run.artifacts.filter((artifact) => node.artifactIds.includes(artifact.id) || artifact.producerNodeId === node.id)}
    busy={nodeMutationPending}
    runId={run.id}
    runRevision={run.revision}
    acceptedPlanDigest={run.productionPlanDigest ?? ""}
    readOnly={readOnly}
    {...(node.id === "creative-planning" && run.planningStages ? { planningStages: run.planningStages } : {})}
    {...(node.id === "creative-planning" ? { onPendingPlanningConfigurationChange: setHasPendingPlanningConfiguration } : {})}
    pauseBusy={pausePending}
    pauseRequested={run.pauseRequested === true}
    {...(onRequestPause ? { onRequestPause } : {})}
    onOverride={onOverrideNode ?? (async () => undefined)}
    onInputOverride={onOverrideNodeInput ?? (async () => undefined)}
    onConfigure={onConfigureNode ?? (async () => undefined)}
    onAuthorize={onAuthorizeSpend ?? (async () => undefined)}
    onRejectSpend={onRejectSpend ?? (async () => undefined)}
  />;

  useEffect(() => {
    if (!run.activeIntervention) {
      setApproving(false);
      setRejecting(false);
      setRejectNote("");
      setApprovalNote("");
      setReviewDecisions({});
      setReplanningVoice(false);
      setVoiceDurationSeconds("");
      setDecisionSnapshot(undefined);
    }
  }, [run.activeIntervention]);

  const openDecision = (kind: "approve" | "reject") => {
    if (!run.activeIntervention) return;
    setDecisionSnapshot({
      expectedRunRevision: run.revision,
      interventionId: run.activeIntervention.id,
      // 成片审片证据只在消费它的停点随决定提交；其余停点不携带无关证据（与服务端分派一致）。
      reviewEvidenceId: sourceReviewDecision || sourceReviewRetry
        ? sourceReviewEvidenceId ?? run.activeIntervention.evidenceId ?? null
        : renderedReviewStop
          ? visualReview?.evidenceId ?? null
          : null,
      ...(kind === "approve" && sourceReviewIncompleteRisk ? { acceptIncomplete: true as const } : {}),
    });
    if (kind === "approve") setApproving(true);
    else setRejecting(true);
  };

  const openVoiceTimingDecision = () => {
    if (!run.activeIntervention || !voiceTiming) return;
    setDecisionSnapshot({
      expectedRunRevision: run.revision,
      interventionId: run.activeIntervention.id,
      reviewEvidenceId: null,
    });
    setVoiceDurationSeconds(String(voiceTiming.requiredSeconds));
    setReplanningVoice(true);
  };

  return (
    <main className={`page run-page${creativeDiscussion ? " has-creative-discussion" : ""}`}>
      <header className="run-header" data-tour="run-header">
        <div>
          <h1>{run.title}</h1>
          <div className="run-title-meta"><span>{platformLabel(run.platform)} · 目标 {run.durationSeconds} 秒</span><details className="run-brief-context"><summary>创作目标与受众</summary><p className="page-summary">{run.angle} · {run.audience}</p></details></div>
        </div>
        <StatusBadge status={run.status} {...(creatorRunStatusLabel(run) ? { label: creatorRunStatusLabel(run)! } : {})} />
      </header>

      <div className="run-workspace-toolbar">
      <nav className="run-section-nav" aria-label="作品工作区">
        <a href="#run-current">当前步骤与产物</a>
        {run.nodes.some((node) => node.id === "creative-planning" && node.outputState?.versions.some((version) => version.id === node.outputState?.effectiveVersionId && version.artifactIds.length > 0))
          ? <a href="#node-workspace-creative-planning" onClick={() => revealNodeWorkspace("creative-planning")}>查看规划交付</a> : null}
        {remainingCreatorNodes.length > 0 ? <a href="#run-artifacts">已保留的内容与设置</a> : null}
        {costDetail ? <a href="#run-costs">调用与费用</a> : null}
      </nav>

      {!readOnly && run.phases && run.progress ? <ProductionProgress run={run} /> : null}
      {!readOnly ? <details className="run-progress-disclosure">
        <summary>查看详细进度</summary>
        <section className="workflow-track" aria-label="生产工作流" data-tour="run-workflow">
          {run.nodes.map((node, index) => (
            <div className={`workflow-node node-${node.status}`} key={node.id}>
              <span className="node-index">{node.status === "succeeded" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
              <span>{node.role ? `${node.role} · ${stepNameFor(node, node.label)}` : stepNameFor(node, node.label)}</span>
            </div>
          ))}
        </section>
      </details> : null}
      </div>

      <div id="run-current" className="run-current-workspace">
      {creativeDiscussion}
      {!creativeDiscussion && run.activeIntervention?.kind === "creative_review" ? <p className="workspace-loading" role="status">正在读取当前方案与讨论。读取完成后才能确认此版本。</p> : null}
      {run.status === "needs_human" && run.activeIntervention ? <CurrentDecisionBar run={run} /> : null}
      {activeSpendNode ? <section className="current-production-action" aria-labelledby="current-production-action-title">
        <header>
          <div><p className="eyebrow">当前需要处理</p><h2 id="current-production-action-title">现在需要你：确认{stepNameFor(activeSpendNode, activeSpendNode.label)}</h2></div>
          <StatusBadge status={run.status} />
        </header>
        <p>先核对当前方案、可复用素材与服务端报价，再单独确认本次费用。授权只针对本次制作范围，后续仍保留逐步确认。</p>
        {renderNodeWorkspace(activeSpendNode)}
      </section> : run.status === "running" ? <section className="current-production-action is-running" aria-live="polite">
        <header><div><p className="eyebrow">自动制作中</p><h2>{runningNodeLabel(run)}</h2></div><StatusBadge status={run.status} /></header>
        <p>{creatorFacingTechnicalText(run.currentAction?.label) ?? runStateMessage(run)}</p>
        {run.progress ? <div className="run-live-metrics">
          <span><Activity aria-hidden="true" size={15} /><strong>{run.progress.completedNodes} / {run.progress.totalNodes}</strong> 个步骤完成</span>
          <span><Clock3 aria-hidden="true" size={15} />{run.progress.currentNodeElapsedSeconds !== undefined ? "当前步骤" : "累计处理"} <strong>{formatDuration(run.progress.currentNodeElapsedSeconds ?? run.progress.elapsedSeconds)}</strong></span>
          <span>{etaLabel(run.progress)}</span>
          <span>制作状态更新于 {formatClock(run.progress.lastUpdatedAt)}</span>
          {costDetail ? <span>已记录费用 <strong>¥{costDetail.totals.actualCostCny.toFixed(2)}</strong>{costDetail.totals.actualPendingCount ? ` · ${costDetail.totals.actualPendingCount} 笔待确认是否扣费` : ""}</span> : null}
          {connectionHeartbeatAt ? <span className="run-connection-live"><i aria-hidden="true" />制作服务连接刚刚确认</span> : null}
        </div> : null}
        {activeNodeModel(run, providers) ? <p className="run-active-provider">当前能力：{activeNodeModel(run, providers)}</p> : null}
        {onRequestPause ? <button className="button button-ghost run-pause-button" type="button" disabled={pausePending || run.pauseRequested === true} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{run.pauseRequested ? "当前步骤完成后暂停" : "暂停后检查或修改"}</button> : null}
      </section> : null}

      {taskRecoveryPanel}

      {showReviewSurface ? <div className={`review-layout${!video?.contentUrl && !currentArtifactNode ? " review-layout-no-media" : ""}`}>
        {video?.contentUrl ? <section className="video-stage" aria-labelledby="preview-title" data-tour="run-preview">
          <div className="section-heading stage-heading">
            <div><p className="eyebrow">最终画面</p><h2 id="preview-title">成片预览</h2></div>
            {video?.contentUrl ? (
              <a className="icon-button" href={video.contentUrl} download title="下载成片">
                <Download aria-hidden="true" size={18} />
              </a>
            ) : null}
          </div>
          <div className={`video-frame${videoIdentity && filmRevealIdentity === videoIdentity ? " film-reveal-active" : ""}`}>
            {video?.contentUrl ? (
              <video ref={previewRef} title="成片预览" src={`${video.contentUrl}#t=0.1`} controls playsInline preload="auto"
                onLoadStart={() => setReadyVideoIdentity(undefined)}
                onLoadedData={(event) => {
                  if (event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                    && event.currentTarget.getAttribute("src") === `${video.contentUrl}#t=0.1`) setReadyVideoIdentity(videoIdentity);
                }}
                onError={() => setReadyVideoIdentity(undefined)} />
            ) : (
              <div className="video-unavailable">视频将在渲染完成后出现在这里</div>
            )}
            {videoIdentity && filmRevealIdentity === videoIdentity ? <div className="film-reveal-curtain" aria-hidden="true" onAnimationEnd={() => setFilmRevealIdentity((current) => current === videoIdentity ? undefined : current)} /> : null}
          </div>
          <p className="preview-provenance">当前成片 · {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(video.createdAt))} 生成。先观看实际内容，再结合复核意见判断。</p>
          </section> : currentArtifactNode ? <section className="current-artifact-surface" aria-label="当前步骤产物">
          <header className="section-heading"><div><h2>{runNodeLabel(currentArtifactNode.id)}</h2><p>当前已保留的产物与设置。核对后再决定是否进入下一步。</p></div></header>
          {renderNodeWorkspace(currentArtifactNode)}
        </section> : null}

        <aside className="review-panel" aria-label="审片与产物" data-tour="run-review">
          {run.creativeSummary ? <details className="creative-summary run-creative-summary" role="region" aria-label="创作目标摘要">
            <summary><strong>系统整理的创作目标</strong><small>展开核对</small></summary>
            <p>根据本次简报推导；如有偏差，请在打回后修改标题、角度、受众或画面要求。</p>
            <dl>
              <div><dt>给谁看</dt><dd>{run.creativeSummary.audience}</dd></div>
              <div><dt>开头承诺</dt><dd>{run.creativeSummary.openingPromise}</dd></div>
              <div><dt>画面方向参考</dt><dd>{run.creativeSummary.requiredVisual}</dd></div>
              <div><dt>结尾收益</dt><dd>{run.creativeSummary.payoff}</dd></div>
            </dl>
          </details> : null}
          {visualReview ? <section className="independent-review-panel" aria-label={singleVisualReview ? "独立质量复核结果" : "双模型审片结果"}>
            <header><strong>{singleVisualReview
              ? `成片独立质量复核：${visualReview.independentReviews.length} 份已完成`
              : `成片双审：${visualReview.independentReviews.length}/2 已完成`}</strong><small>{singleVisualReview
              ? "该模型审查同一版成片"
              : visualReview.independentReviews.length === 2
                ? visualReview.evidenceId ? "两者查看同一份成片证据" : "独立审查同一版成片"
                : "审片结果不完整，不能按完整双审处理"}</small></header>
            <div className="merged-review-summary">
              <span>视觉结论 · {visualReviewRecommendationLabel(visualReview.recommendation)}</span>
              {(() => {
                const { excerpt, truncated } = reviewSummaryExcerpt(visualReview.summary);
                return <>
                  <p>{excerpt}{truncated ? <small>（原文节选）</small> : null}</p>
                  {truncated ? <details className="review-full-summary">
                    <summary>查看完整结论原文</summary>
                    <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
                  </details> : null}
                </>;
              })()}
            </div>
            {flawedReviewBranches.length > 0 ? <p className="review-audit-caveat" role="note">
              <strong>有 {flawedReviewBranches.length} 份审片报告未通过报告质量复核</strong>
              <span>{flawedReviewBranches.map((branch) => `${providerLabel(branch.providerId) ?? branch.providerId} · ${catalogModelLabel(providers, branch.modelId) ?? branch.modelId}`).join("、")}。需要重点核对的是报告的依据，不等于作品已被否决。请结合成片判断各条意见；发布仍需满足页面列出的必要条件。</span>
            </p> : null}
            <div className="independent-review-list">
              {visualReview.independentReviews.map((review) => {
                const branch = reviewSummaryExcerpt(review.summary);
                return <article key={`${review.providerId}:${review.modelId}`}>
                <header><strong>{providerLabel(review.providerId) ?? review.providerId}</strong><span>{visualReviewRecommendationLabel(review.recommendation)}</span></header>
                <small>{catalogModelLabel(providers, review.modelId) ?? review.modelId}{review.score !== undefined ? ` · ${review.score} 分` : ""}{` · ${review.findingCount} 项问题`}{review.auditVerdict === "repair" ? " · 独立审计未通过" : ""}</small>
                <p>{branch.excerpt}{branch.truncated ? <small>（原文节选）</small> : null}</p>
                {branch.truncated ? <details className="review-full-summary">
                  <summary>查看这份意见的完整原文</summary>
                  <p>{creatorFacingTechnicalText(review.summary)}</p>
                </details> : null}
              </article>;
              })}
              {!singleVisualReview && visualReview.independentReviews.length < 2 ? <p role="status">缺少 {2 - visualReview.independentReviews.length} 个可验证的独立审片结果，请重新审查当前成片。</p> : null}
            </div>
          </section> : null}
          {visualReview ? <AudioReviewPanel value={visualReview.audioReview} /> : null}
          {!visualReview && video?.contentUrl ? <section className="review-advisory" role="status" aria-label="机器审片状态">
            <strong>可播放首版</strong>
            <p>机器视觉审片尚未完成。你可以播放和下载当前视频；这不代表正式发布已通过。</p>
          </section> : null}
          {readOnly ? (
            <section className="run-state-panel" role="status">
              <p className="eyebrow">历史制作记录</p>
              <h2>这条旧版制作仅供查看</h2>
              <p>{run.continuation?.reason}</p>
              {visiblePaidNodeSummary ? <PaidOperationPanel
                summary={visiblePaidNodeSummary}
                providers={providers}
                busy={nodeMutationPending}
                settlementOnly
                {...(uncertainPaidNodeProviderId ? { providerIdHint: uncertainPaidNodeProviderId } : {})}
                {...(onReconcilePaidNode ? { onReconcile: onReconcilePaidNode } : {})}
              /> : null}
              {onRestart ? <button className="button button-primary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />基于这版重新制作</button> : null}
            </section>
          ) : run.activeIntervention?.kind === "source_review_retry" && run.activeIntervention ? (
            <section className="intervention-panel" aria-label="试片审查暂停">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>{sourceReviewIncompleteRisk ? "试片审查没有完成，等你决定" : "试片审查还没完成，制作已暂停"}</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason) ?? run.activeIntervention.reason}</p>
              <p>{sourceReviewIncompleteRisk
                ? "审查没有给出评分，但已生成画面、来源和费用事实已确认。你可以接受这个风险继续生成首版；这不会把审查改成通过，也不会重新购买已成功素材。"
                : "已生成的画面与已花费的费用都保留。重试只续未完成的审查分支，不会重新购买成功素材；付费结果或来源事实不明确时，只能补查或终止。"}</p>
              <div className="decision-actions">
                {sourceReviewIncompleteRisk ? <button
                  className="button button-primary"
                  type="button"
                  disabled={decisionPending || !sourceReviewEvidenceId && !run.activeIntervention.evidenceId}
                  onClick={() => openDecision("approve")}
                ><Check aria-hidden="true" size={17} />接受未完成审查，继续生成首版</button> : null}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={nodeMutationPending || !onRetryFailedNode}
                  onClick={() => { if (onRetryFailedNode) void onRetryFailedNode(run.activeIntervention!.nodeId); }}
                ><RotateCcw aria-hidden="true" size={17} />重试审查（复用已生成画面）</button>
                <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                  <XCircle aria-hidden="true" size={17} />终止制作
                </button>
              </div>
            </section>
          ) : run.activeIntervention?.kind === "source_review_decision" && run.activeIntervention ? (
            <section className="intervention-panel" aria-label="试片质量意见">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>试片提出质量意见，等你决定</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason) ?? run.activeIntervention.reason}</p>
              <p>这是一份完整的试片审查意见，不是系统替你否决作品。已生成画面和费用都会保留；继续时只复用这份已确认的试片，后续素材是否会产生费用仍以当前报价为准。</p>
              <div className="decision-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={decisionPending || !sourceReviewEvidenceId}
                  onClick={() => sourceReviewEvidenceId && void onDecision({
                    action: "request_changes",
                    expectedRunRevision: run.revision,
                    interventionId: run.activeIntervention!.id,
                    reviewEvidenceId: sourceReviewEvidenceId,
                  })}
                ><RotateCcw aria-hidden="true" size={17} />调整方案</button>
                <button className="button button-primary" type="button" disabled={decisionPending || !sourceReviewEvidenceId} onClick={() => openDecision("approve")}>
                  <Check aria-hidden="true" size={17} />接受所列质量风险，继续制作
                </button>
                <button className="button button-secondary" type="button" disabled={decisionPending || !sourceReviewEvidenceId} onClick={() => openDecision("reject")}>
                  <XCircle aria-hidden="true" size={17} />终止制作
                </button>
              </div>
            </section>
          ) : run.activeIntervention?.kind !== "creative_review" && run.activeIntervention?.kind !== "source_review_retry" && run.activeIntervention ? (
            <section className="intervention-panel">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                {/* 边界停点由界面按 nodeId 说步骤名（服务端只有英文节点标识），否则用户看不出停在哪一步。 */}
                <h2>{boundaryGate ? `${runNodeLabel(run.activeIntervention.nodeId)}做完了，等你放行` : "需要你的判断"}</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason)}</p>
              {waitingNodeProgress ? <div className={`agent-loop-progress is-stacked is-${waitingNodeProgress.phase}`} role="status">
                <strong>{agentLoopPhaseLabel(waitingNodeProgress)}</strong>
                {waitingNodeProgress.latestAudit ? <>
                  <span>独立复核 {waitingNodeProgress.latestAudit.score} 分：{waitingNodeProgress.latestAudit.summary}</span>
                  {waitingNodeProgress.latestAudit.issues?.length ? <ul className="agent-audit-issues">
                    {waitingNodeProgress.latestAudit.issues.map((issue, index) => <li key={`${issue.criterion}:${index}`}>
                      <strong>{issue.criterion}
                        {/* 审计自己的措辞是 blocking/advisory；对用户它始终只是建议，所以写"建议先改"而不是"阻断"。 */}
                        <span className="agent-audit-issue-severity">{issue.severity === "blocking" ? "建议先改" : "可选"}</span>
                      </strong>
                      <span>{issue.evidence}</span>
                      <span>建议：{issue.repairInstruction}</span>
                    </li>)}
                  </ul> : null}
                </> : <span>{agentLoopPendingNote(waitingNodeProgress)}</span>}
                <span>实际模型调用：创作 {waitingNodeProgress.producerModelCallCount ?? 0} 次，审计 {waitingNodeProgress.auditModelCallCount ?? 0} 次。查询、刷新和等待不计为新调用。</span>
              </div> : null}
              {visualReviewRequiresRevision && visualReview ? <div className="agent-review-decision">
                <strong>视觉审片建议修改后再审</strong>
                <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
                <div className="agent-review-facts">
                  {visualReview.lowestScores.map((score) => <span key={score.key}>{score.label} <strong>{score.value}</strong></span>)}
                  <span>模型判定存在问题：<strong>{visualReview.findingCount}</strong> 项</span>
                  {visualReview.pendingInspectionCount ? <span><strong>{visualReview.pendingInspectionCount}</strong> 项待补查</span> : null}
                  {visualReview.infoCount ? <span><strong>{visualReview.infoCount}</strong> 项提示</span> : null}
                  <span>模型自评把握程度 <strong>{Number.isFinite(visualReview.confidence) && visualReview.confidence >= 0 && visualReview.confidence <= 1 ? `${Math.round(visualReview.confidence * 100)}%` : "数值异常，待核对"}</strong></span>
                </div>
                {onRequestSceneRevision && assetVersionId && visualReview.reviewArtifactId
                  ? <div className="scene-revision-list">
                    {visualReview.findings.map((finding) => <SceneRevisionFinding
                      key={`${finding.timecodeMs}:${finding.findingIndex}`}
                      finding={finding}
                      busy={decisionPending}
                      onSeek={() => {
                        if (!previewRef.current) return;
                        previewRef.current.currentTime = finding.timecodeMs / 1_000;
                      }}
                      onSubmit={(input) => onRequestSceneRevision({
                        expectedRunRevision: run.revision,
                        expectedAssetVersionId: assetVersionId,
                        reviewArtifactId: visualReview.reviewArtifactId!,
                        findingIndex: finding.findingIndex,
                        ...input,
                      })}
                      {...(onRequestSceneResourceRevision ? {
                        onReselectAsset: (input) => onRequestSceneResourceRevision({
                          expectedRunRevision: run.revision,
                          reviewArtifactId: visualReview.reviewArtifactId!,
                          findingIndex: finding.findingIndex,
                          ...input,
                        }),
                      } : {})}
                      {...(onLoadSceneNarration ? { onLoadNarration: onLoadSceneNarration } : {})}
                      {...(onRequestNarrationRevision ? {
                        onSubmitNarration: (input) => onRequestNarrationRevision({
                          expectedRunRevision: run.revision,
                          ...input,
                        }),
                      } : {})}
                    />)}
                  </div>
                  : null}
                {visualReview.pendingInspectionCount > 0 && visualReview.evidenceId && onReinspectVisualReview ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={nodeMutationPending || decisionPending}
                    onClick={() => void onReinspectVisualReview({
                      expectedRunRevision: run.revision,
                      reviewEvidenceId: visualReview.evidenceId!,
                    })}
                  >
                    <RotateCcw aria-hidden="true" size={17} />补查现有成片（不重买素材）
                  </button>
                ) : null}
                <p className="agent-review-guidance">补查会重跑整轮审片、不会重新购买画面或配音，因此<strong>其它镜头（包括上一轮已通过的镜头）的结论也可能变化</strong>；判定与上一轮不同的条目会标出「判定变动」，并给出两轮原文。批准前你要对本轮每一条结论逐条表态：采纳的必须先返修，不采纳的要写明理由。</p>
              </div> : null}
              {nextGateNode ? <div className="boundary-next-step">
                <span>下一步「{stepNameFor(nextGateNode, nextGateNode.label)}」还没开始。放行后它会直接按现在保存的模型和设置开始跑；要改就在放行前改。</span>
                <button className="button button-ghost" type="button" onClick={() => revealNodeWorkspace(nextGateNode.id)}>去配置「{stepNameFor(nextGateNode, nextGateNode.label)}」</button>
              </div> : null}
              <div className="decision-actions">
                {boundaryGate ? <>
                  {/* 尊重 runner 实际接受的闸门：options 里没有的动作不发按钮，否则按钮会与
                      服务端校验漂移（点了必然报"does not allow action"）。 */}
                  {boundaryOptions.includes("approve") ? (
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={decisionPending}
                      onClick={() => openDecision("approve")}
                    >
                      <Check aria-hidden="true" size={17} />确认当前步骤，进入下一步
                    </button>
                  ) : null}
                  {boundaryOptions.includes("reject") ? (
                    <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                      <XCircle aria-hidden="true" size={17} />终止制作
                    </button>
                  ) : null}
                </> : voiceTiming ? <>
                  <button className="button button-primary" type="button" disabled={decisionPending} onClick={openVoiceTimingDecision}>
                    <RotateCcw aria-hidden="true" size={17} />调整方案
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                </> : visualReviewRequiresRevision ? <>
                  {/* 这一支原来写「修改后再审」，但它提交的是 reject——一个把这条视频当场终止的终态，
                      没有任何返修会因此发生。想返修的人会点它，然后拿到一条停止制作的视频。
                      现在按它的实际后果说话；要返修请用下面每条结论旁的返工入口。 */}
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("approve")}>
                    <Check aria-hidden="true" size={17} />仍要批准（说明理由）
                  </button>
                </> : <>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={decisionPending}
                    onClick={() => openDecision("approve")}
                  >
                    <Check aria-hidden="true" size={17} />批准进入发布包
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                </>}
              </div>
            </section>
          ) : (
            <section className={`run-state-panel${run.failure ? " has-failure" : ""}`}>
              {run.failure ? <>
                <p className="eyebrow">{sourceAssetFailure
                  ? (sourceReviewIncomplete(run.failure) ? "制作已暂停，画面与费用都已保留" : "制作已安全停止")
                  : `停在 ${run.failure.nodeLabel}`}</p>
                <h2>{sourceAssetFailure
                  ? (sourceReviewIncomplete(run.failure) ? "试片审查还没完成" : "画面预检未通过")
                  : `${run.failure.nodeLabel}没有完成`}</h2>
                {sourceAssetFailure ? <>
                  <div className="run-failure-breakdown">
                    <strong>结论</strong>
                    <ul>{sourceAssetFailure.conclusion.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                  </div>
                  {sourceAssetFailure.sceneFindings.length > 0 ? <div className="run-failure-breakdown">
                    <strong>逐镜问题</strong>
                    <ul>{sourceAssetFailure.sceneFindings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
                  </div> : null}
                  <div className="run-failure-impact">
                    <strong>已保留的内容</strong>
                    {sourceAssetFailure.preservedContent.map((fact) => <span key={fact}>{fact}</span>)}
                  </div>
                  <div className="run-failure-breakdown">
                    <strong>下一步</strong>
                    <ul className="run-recovery-list">
                      {sourceAssetFailure.nextSteps.map((action) => <li key={action}>{action}</li>)}
                    </ul>
                  </div>
                </> : <>
                  <p className="run-failure-summary">{run.failure.summary}</p>
                  {(["asset-source-review", "visual-review"].includes(run.failure.nodeId) || run.failure.category === "infrastructure" || /源素材视觉预检|媒体处理失败|ASSET_SEARCH_SOURCES_UNAVAILABLE|图库候选检索全部来源失败/.test(run.failure.technicalDetail ?? "")) && run.failure.technicalDetail
                    ? <details className="run-technical-details"><summary>查看技术详情</summary><p className="run-failure-summary"><strong>失败原因：</strong>{creatorFacingTechnicalText(run.failure.technicalDetail)}</p></details>
                    : null}
                  <div className="run-failure-impact">
                    <strong>{run.resultAvailability?.label ?? "前序结果已保留"}</strong>
                    <span>{run.failure.impact}</span>
                  </div>
                  <p className="run-saved-work">已保留前面 {run.failure.savedNodeCount} 个步骤的结果</p>
                  <ul className="run-recovery-list">
                    {run.failure.recoveryActions.map((action) => <li key={action}>{action}</li>)}
                  </ul>
                </>}
              </> : <>
                <h2>当前状态</h2>
                <p>{runStateMessage(run)}</p>
              </>}
              {visiblePaidNodeSummary ? <PaidOperationPanel
                summary={visiblePaidNodeSummary}
                providers={providers}
                busy={nodeMutationPending}
                {...(uncertainPaidNodeProviderId ? { providerIdHint: uncertainPaidNodeProviderId } : {})}
                {...(onReconcilePaidNode ? { onReconcile: onReconcilePaidNode } : {})}
              /> : null}
              {run.status === "succeeded" && onOpenPublish ? <button className="button button-primary" type="button" onClick={onOpenPublish}><Send aria-hidden="true" size={16} />准备各平台发布包</button> : null}
              {run.status === "succeeded" && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />基于这版重新制作</button> : null}
              {hasPendingPlanningConfiguration && (run.status === "failed" || run.status === "rejected") ? <p className="run-failure-summary">模型选择尚未保存。请先保存模型，或恢复为当前模型后再重试。</p> : null}
              {(run.status === "failed" || run.status === "rejected") && !run.taskRecovery && run.failure?.retryable !== false && !hasUncertainPaidOutcome(run) && onRetryFailedNode && retryableNodeId(run) ? <button className="button button-primary" type="button" disabled={nodeMutationPending || hasPendingPlanningConfiguration} onClick={() => void onRetryFailedNode(retryableNodeId(run)!)}><RotateCcw aria-hidden="true" size={16} />{sourceAssetFailure && run.status === "rejected" ? "重新检查已有试片" : run.failure?.nodeId === "visual-review" ? "重试视觉审片" : "重试失败步骤"}</button> : null}
              {(run.status === "failed" || run.status === "rejected") && !run.taskRecovery && !hasUncertainPaidOutcome(run) && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
              {run.status === "stale" && onRegenerateStale ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRegenerateStale()}><RotateCcw aria-hidden="true" size={16} />{isCostReplan ? "按降本意见重新规划并报价" : "按人工版本继续生成"}</button> : null}
              {run.status === "paused" && onResumePaused ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onResumePaused()}><Play aria-hidden="true" size={16} />继续自动制作</button> : null}
            </section>
          )}

        </aside>
      </div> : null}

      </div>
      {remainingCreatorNodes.length ? <section id="run-artifacts" className="role-workspaces" aria-labelledby="role-workspaces-title">
        <header className="section-heading"><div><p className="eyebrow">创作内容</p><h2 id="role-workspaces-title">逐项预览与修改</h2><p>这里只呈现会影响作品、并且适合人工调整的内容。路径、版本和运行参数不会占用你的注意力。</p></div><span>{remainingCreatorNodes.length} 项</span></header>
        <div className="node-workspace-list">
          {remainingCreatorNodes.map(renderNodeWorkspace)}
        </div>
      </section> : null}

      {costDetail ? <div id="run-costs"><RunCostDetailPanel detail={costDetail} providers={providers} /></div> : null}

      {replanningVoice && voiceTiming ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={voiceTimingDialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-timing-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">调整统一方案</p><h2 id="voice-timing-title">调整配音时长</h2></div>
              <button className="icon-button" type="button" onClick={closeVoiceTimingDecision} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <p>自然配音需要 {voiceTiming.requiredSeconds} 秒，当前镜头只有 {voiceTiming.plannedSeconds} 秒。接受新时长后，系统会重排统一时间轴并重新检查素材、画面和成片。</p>
            <label className="field field-wide">
              <span>{`镜头 ${voiceTiming.scenePosition} 时长（秒）`}</span>
              <input
                type="number"
                min={voiceTiming.requiredSeconds}
                max={180}
                step="0.001"
                value={voiceDurationSeconds}
                onChange={(event) => setVoiceDurationSeconds(event.target.value)}
                data-dialog-initial-focus
              />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeVoiceTimingDecision} disabled={decisionPending}>取消</button>
              <button
                className="button button-primary"
                type="button"
                disabled={decisionPending || !decisionSnapshot || !Number.isFinite(Number(voiceDurationSeconds)) || Number(voiceDurationSeconds) < voiceTiming.requiredSeconds}
                onClick={() => decisionSnapshot && void onDecision({
                  action: "request_changes",
                  ...decisionSnapshot,
                  voiceTiming: {
                    scenePosition: voiceTiming.scenePosition,
                    durationSeconds: Number(voiceDurationSeconds),
                  },
                })}
              ><RotateCcw aria-hidden="true" size={17} />接受新时长并继续制作</button>
            </footer>
          </section>
        </div>
      ) : null}
      {rejecting ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={rejectDialogRef} className="reject-dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">终止制作</p><h2 id="reject-title">终止这条视频的制作</h2></div>
              <button className="icon-button" type="button" onClick={closeRejectDecision} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <p className="agent-review-guidance">终止是终态：这条视频会停止制作，<strong>不会自动返修</strong>，也不会产出发布包。若只是某一镜不合适，请关掉这个窗口，用审片结论旁边的返工入口（换一版素材 / 改这一镜旁白 / 用已有镜头替换）处理。</p>
            <label className="field field-wide">
              <span>终止原因</span>
              <textarea value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="说明终止原因，便于以后查看" rows={4} data-dialog-initial-focus />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeRejectDecision}>取消</button>
              <button
                className="button button-danger"
                type="button"
                disabled={!rejectNote.trim() || decisionPending || !decisionSnapshot}
                  onClick={() => decisionSnapshot && void onDecision({ action: "reject", note: rejectNote.trim(), ...decisionSnapshot })}
              >
                <XCircle aria-hidden="true" size={17} />确认终止
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {approving ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={approveDialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="approve-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">{sourcePreflightDecision ? "素材预检" : sourceReviewIncompleteRisk ? "未完成审查" : sourceReviewDecision ? "试片质量意见" : boundaryGate ? "节点放行" : "最终决定"}</p><h2 id="approve-title">{sourcePreflightDecision
                ? "接受当前素材风险，继续制作"
                : sourceReviewIncompleteRisk
                ? "接受未完成审查，继续生成首版"
                : sourceReviewDecision
                ? "接受所列质量风险，继续制作"
                : boundaryGate
                ? `确认放行「${runNodeLabel(run.activeIntervention?.nodeId ?? "")}」`
                : reviewItems.length > 0 ? "逐条表态后批准成片" : "确认批准成片"}</h2></div>
              <button className="icon-button" type="button" onClick={closeApproveDecision} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            {/* 边界停点批准的是"这一步的产出可以往下走"，不生成发布包、不结束终审，也和机器质检无关。
                这里原来一律讲终审的话——用户点下去之前读到的最后一段话是错的。 */}
            <div className="decision-dialog-copy"><Check aria-hidden="true" size={22} /><p>{sourcePreflightDecision
              ? <><strong>你接受的是当前素材预检的质量风险，不是宣布审查通过。</strong><span>若复核未完成，仍如实保留“未完成、无评分”。继续配音与渲染时仍受原费用授权限制；这不是成片定版。</span></>
              : sourceReviewIncompleteRisk
              ? <><strong>你接受的是“审查没有结论”的事实，不是把它改成通过。</strong><span>已生成画面和费用事实会保留，继续只运行后续配音与渲染；不会重新购买已成功素材，最终仍显示为可播放首版而非正式发布通过。</span></>
              : sourceReviewDecision
              ? <><strong>你确认的是：已看过这份试片意见，愿意按当前方案继续。</strong><span>系统不会重新购买已生成试片；其它尚未生成的素材仍会先依据当前报价和授权处理。</span></>
              : boundaryGate
              ? <><strong>放行后这一步的结果就固定下来，制作按现在保存的设置继续往下走。</strong><span>想换模型、参数或输入，请先关掉这个窗口去配置；放行之后要改，就得让这一步连同下游重做。</span></>
              : <><strong>{reviewItems.length > 0
                ? `审片提出 ${reviewItems.length} 条结论，请逐条看过并表态。`
                : "批准后将生成发布包。"}</strong><span>这会结束人工终审；请确认已经完整观看画面、字幕并听过声音。</span></>}</p></div>
            {/* 逐条表态管的是审片结论。机器质检是判过或不过的闸门——它不通过时流程走不到终审，
                所以这里没有它的条目，操作员不必怀疑自己漏签了什么。边界停点上两件事都不涉及。 */}
            {boundaryGate || sourcePreflightDecision ? null : <p className="review-disposition-note">技术质检不适用逐条表态：它由机器判定通过或不过，没过就到不了这一步，不在这里逐条签。</p>}
            {reviewItems.length > 0 ? <div className="review-disposition-list">
              <p className="review-disposition-guide">采纳=现在返修；不采纳=认为意见不成立，需写理由；接受风险=认可问题，但保留本版和原始评分。</p>
              {reviewItems.map((item, index) => {
                const itemKey = item.itemKey!;
                const choice = reviewDecisions[itemKey];
                const previousReason = reviewItems
                  .slice(0, index)
                  .map((candidate) => candidate.itemKey ? reviewDecisions[candidate.itemKey]?.reason.trim() : undefined)
                  .filter((reason): reason is string => Boolean(reason))
                  .at(-1);
                return <article className={`review-disposition-item is-${choice?.decision ?? "undecided"}`} key={itemKey}>
                  <header>
                    <strong>{item.scenePosition ? `镜头 ${item.scenePosition}` : `第 ${index + 1} 条`} · {reviewItemTimecode(item)}</strong>
                    <span>{reviewEvidenceStatusLabel(item)}</span>
                  </header>
                  <p>{creatorFacingTechnicalText(item.description)}</p>
                  <small>{creatorFacingTechnicalText(item.suggestion)}</small>
                  <FindingVerdictChange finding={item} />
                  <div className="review-disposition-choices">
                    <button className="button button-ghost" type="button" aria-pressed={choice?.decision === "accept_risk"}
                      onClick={() => setReviewDecision(itemKey, "accept_risk")}>接受风险，保留本版</button>
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-pressed={choice?.decision === "reject"}
                      onClick={() => setReviewDecision(itemKey, "reject")}
                    >不采纳，维持现状</button>
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-pressed={choice?.decision === "accept"}
                      onClick={() => setReviewDecision(itemKey, "accept")}
                    >采纳，先返修</button>
                  </div>
                  {choice?.decision === "accept" ? <p className="review-disposition-hint" role="status">已采纳：这条结论需要先返修，本轮不能批准。</p> : null}
                  {choice?.decision === "reject" ? <label className="field field-wide">
                    <span>不采纳理由</span>
                    <textarea
                      value={choice.reason}
                      onChange={(event) => setReviewReason(itemKey, event.target.value)}
                      placeholder="写明你核对后的判断，例如：已逐帧看过，这里是有意为之"
                      rows={2}
                      maxLength={500}
                      {...(index === 0 ? { "data-dialog-initial-focus": true } : {})}
                    />
                    {previousReason ? <button className="button button-ghost" type="button" onClick={() => setReviewReason(itemKey, previousReason)}>与上一条相同</button> : null}
                  </label> : null}
                </article>;
              })}
            </div> : null}
            <label className="field field-wide decision-override-field">
              <span>批准备注（选填）</span>
              <textarea value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="想补充的整体判断" rows={2} />
            </label>
            {reviewItems.length > 0 && (undisposedReviewItems.length > 0 || acceptedReviewItems.length > 0) ? <p className="review-disposition-blocker" role="status">
              {undisposedReviewItems.length > 0 ? `还有 ${undisposedReviewItems.length} 条没有表态。` : ""}
              {acceptedReviewItems.length > 0 ? `其中 ${acceptedReviewItems.length} 条已采纳、还等着返修。` : ""}
            </p> : null}
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeApproveDecision} disabled={decisionPending}>{boundaryGate ? "先不放行" : "再看一遍"}</button>
              <button
                className="button button-primary"
                type="button"
                disabled={decisionPending || !decisionSnapshot
                  || undisposedReviewItems.length > 0
                  || acceptedReviewItems.length > 0
                  || unexplainedReviewItems.length > 0}
                onClick={() => decisionSnapshot && void onDecision({
                  action: "approve",
                  ...decisionSnapshot,
                  ...(approvalNote.trim() ? { note: approvalNote.trim() } : {}),
                  ...(reviewItems.length > 0 ? {
                    reviewDispositions: reviewItems.map((item) => {
                      const choice = reviewDecisions[item.itemKey!]!;
                      return choice.decision === "accept"
                        ? { itemKey: item.itemKey!, decision: "accept" as const }
                        : { itemKey: item.itemKey!, decision: choice.decision, ...(choice.reason.trim() ? { reason: choice.reason.trim() } : {}) };
                    }),
                  } : {}),
                })}
              ><Check aria-hidden="true" size={17} />{decisionPending
                ? "正在批准..."
                : sourceReviewDecision || sourcePreflightDecision || sourceReviewIncompleteRisk ? "确认承担并继续"
                  : boundaryGate ? "确认放行，进入下一步"
                  : reviewItems.length > 0 ? "逐条表态已完成，生成发布包" : "确认批准并生成发布包"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function formatRecoveryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function voiceTimingConflict(run: StudioRunDetail): {
  scenePosition: number;
  plannedSeconds: number;
  requiredSeconds: number;
} | undefined {
  if (run.activeIntervention?.nodeId !== "voice"
    || !run.activeIntervention.options.includes("request_changes")) return undefined;
  const node = run.nodes.find((candidate) => candidate.id === "voice");
  if (!node || typeof node.output !== "object" || node.output === null || Array.isArray(node.output)) return undefined;
  const conflict = (node.output as Record<string, unknown>).conflict;
  if (typeof conflict !== "object" || conflict === null || Array.isArray(conflict)) return undefined;
  const value = conflict as Record<string, unknown>;
  if (value.code !== "VOICE_DOES_NOT_FIT"
    || !Number.isInteger(value.scenePosition)
    || typeof value.plannedSeconds !== "number"
    || typeof value.requiredSeconds !== "number") return undefined;
  return {
    scenePosition: Number(value.scenePosition),
    plannedSeconds: value.plannedSeconds,
    requiredSeconds: value.requiredSeconds,
  };
}

function PaidOperationPanel({ summary, providers, providerIdHint, busy, settlementOnly = false, onReconcile }: {
  summary: StudioPaidNodeSummary;
  providers: StudioProvider[];
  providerIdHint?: string;
  busy: boolean;
  settlementOnly?: boolean;
  onReconcile?: (nodeId: string, input: StudioPaidReconciliationDraft) => Promise<void>;
}) {
  const [taskId, setTaskId] = useState("");
  const [manualOutcome, setManualOutcome] = useState<"confirmed_not_charged" | "confirmed_charged">();
  const [note, setNote] = useState("");
  const [actualCost, setActualCost] = useState("");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [selectedItemRequestId, setSelectedItemRequestId] = useState("");
  const outcome = !settlementOnly && (summary.recommendedOutcome === "resume_original" || summary.recommendedOutcome === "requote")
    ? summary.recommendedOutcome
    : undefined;
  const requiresManualReconciliation = settlementOnly || summary.requiresManualReconciliation;
  const missingTaskItems = summary.items.filter((item) => (
    (item.state === "submitted" || item.state === "unknown") && !item.taskId
  ));
  const canAttachTaskId = missingTaskItems.length === 1;
  const manuallyResolvableItems = summary.nodeId === "assets"
    ? summary.items.filter((item) => (
        item.manualReconciliationRequired === true
        || (item.state === "submitted" || item.state === "unknown") && !item.taskId
        || item.state === "provider_succeeded" && !item.taskId
      ))
    : [];
  const selectedManualItemRequestId = manuallyResolvableItems.some((item) => item.itemRequestId === selectedItemRequestId)
    ? selectedItemRequestId
    : manuallyResolvableItems[0]?.itemRequestId ?? "";
  const requiresItemSelection = summary.nodeId === "assets" && summary.items.length > 0;
  const parsedActualCost = actualCost.trim() ? Number(actualCost) : undefined;
  const actualCostValid = parsedActualCost === undefined || (Number.isFinite(parsedActualCost) && parsedActualCost >= 0);
  const isVoiceCall = summary.nodeId === "voice";
  const providerLookupBlocked = summary.items.some((item) => item.manualReconciliationRequired);
  const consoleEntries = providerConsoleEntries(providers, summary.items.length
    ? summary.items.map((item) => item.providerId)
    : providerIdHint ? [providerIdHint] : []);
  if (!settlementOnly && isVoiceCall && summary.requiresManualReconciliation && (
    summary.failureKind === "terminal_failure"
    || summary.recommendedOutcome === "confirmed_not_charged"
  )) {
    return <section className="paid-operation-panel requires-manual" aria-label="配音恢复">
      <header><strong>配音请求被明确拒绝</strong><small>未扣费 · 不计入已记录费用</small></header>
      <p>服务商事实：本次请求被服务商明确拒绝，未扣费。系统会按零费用结清并解锁配音设置，但不会自动再次调用。结清后请先修正音色、模型或服务配置，再明确点击“重试失败步骤”。</p>
      {onReconcile ? <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void onReconcile(summary.nodeId, {
          outcome: "confirmed_not_charged",
          note: "配音服务商明确拒绝本次请求；按零费用结清并返回调整配音设置。",
        })}
      ><Check aria-hidden="true" size={16} />按零费用结清并调整配音</button> : null}
    </section>;
  }
  if (!settlementOnly && isVoiceCall && summary.requiresManualReconciliation) {
    const connectionInterrupted = summary.failureKind === "unknown_outcome";
    return <section className="paid-operation-panel requires-manual" aria-label="配音恢复">
      <header><strong>{connectionInterrupted ? "配音连接中断" : "配音结果无法确认"}</strong><small>按预估费用保守记账</small></header>
      <p>{connectionInterrupted
        ? "请求提交后连接中断，系统无法确认服务商是否已经计费，因此没有自动重放。"
        : "系统没有拿到足够的配音调用与计费结果，因此没有自动重放。"} 上一笔是否扣费仍未确认。继续会先按预估金额登记上一笔，再创建新的配音任务；新任务可能再次产生费用。预估登记不等于服务商账单确认。不继续只是不登记和不重试，不能据此判断服务商未扣费。</p>
      {onReconcile ? <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void onReconcile(summary.nodeId, {
          outcome: "confirmed_charged",
          note: "自动配音提交后连接中断，结果无法确认；按原预估费用保守记账并创建新的配音任务。",
        })}
      ><RotateCcw aria-hidden="true" size={16} />登记预估费用并新建配音任务</button> : null}
    </section>;
  }
  const title = requiresManualReconciliation
    ? providerLookupBlocked ? "原任务已无法自动查询" : "这次请求是否扣费还不确定"
    : outcome === "requote"
      ? "未完成的画面需要重新报价"
      : "已找到可恢复的付费任务";
  return <section className={`paid-operation-panel${requiresManualReconciliation ? " requires-manual" : ""}`} aria-label="付费任务证据">
    <header><strong>{title}</strong><small>{isVoiceCall ? "一次配音调用" : `${summary.items.length} 个镜头`}</small></header>
    <div className="paid-operation-items">
      {summary.items.map((item) => <article key={`${item.operationId}:${item.itemRequestId}`}>
        <header><strong>镜头 {item.scenePosition}</strong><span>{paidOperationStateLabel(item.state)}</span></header>
        <p>{paidProviderIdentity(providers, item.providerId, item.modelId)}</p>
        {item.taskId ? <code>服务商任务编号：{item.taskId}</code> : <small>尚无服务商任务编号</small>}
        <small>{paidOperationCostLabel(item)}</small>
      </article>)}
    </div>
    {requiresManualReconciliation ? <div className="paid-operation-explanation">
      <p><strong>发生了什么：</strong>{providerLookupBlocked
        ? "系统保留了服务商任务编号，但服务商已明确拒绝继续查询，无法再自动确认结果。"
        : isVoiceCall ? "请求发出后连接中断，系统没有收到明确结果。" : "服务商可能已经收到请求，但系统没有拿到足够的任务证据。"}</p>
      <p><strong>为什么需要核对：</strong>直接重试可能产生重复任务和重复扣费，所以系统已经停住，不会自动重试或重新制作。</p>
      <p><strong>下一步：</strong>{settlementOnly
        ? "旧版制作只保存本次账单核对结果，不会恢复服务商任务、重新报价或继续下游制作。"
        : providerLookupBlocked
        ? "请用页面显示的任务编号到服务商控制台核对结果和账单，再按真实情况登记“未扣费”或“已扣费”。"
        : isVoiceCall ? "请在配音服务商控制台按本次调用记录与账单核对，再登记结果。" : "请到服务商控制台核对任务与账单；找到任务编号时可先录入并继续查询原任务。"}</p>
      <p><strong>核对入口：</strong>{consoleEntries.length
        ? consoleEntries.map((entry, index) => <span key={entry.providerId}>{index > 0 ? "；" : ""}<a href={entry.consoleUrl} target="_blank" rel="noreferrer">打开{entry.label}控制台</a></span>)
        : "这项能力没有配置可点击的服务商控制台入口，请联系管理员核对任务与账单。"}</p>
    </div> : outcome === "requote" ? <div className="paid-operation-explanation">
      <p><strong>发生了什么：</strong>画面准备没有完成，但现有证据表明没有未知的付费任务需要核账。</p>
      <p><strong>为什么重新报价：</strong>只会重新计算明确失败或尚未提交的镜头；已经完成的付费任务不会重复创建。</p>
      <p><strong>下一步：</strong>检查失败镜头的画面来源，再为未完成镜头生成新报价。</p>
    </div> : <div className="paid-operation-explanation">
      <p><strong>发生了什么：</strong>服务商已经受理任务，但结果没有完整回到本次制作。</p>
      <p><strong>为什么可以恢复：</strong>系统保留了原任务编号，会继续查询并下载原结果，不会创建新任务或新增报价。</p>
      <p><strong>下一步：</strong>继续获取原任务结果。</p>
    </div>}
    {requiresManualReconciliation && onReconcile ? <div className="paid-reconciliation-controls">
      {!settlementOnly && canAttachTaskId ? <div className="paid-task-id-control">
        <label className="field field-wide">
          <span>服务商任务编号</span>
          <input value={taskId} onChange={(event) => setTaskId(event.target.value)} maxLength={256} placeholder="从服务商控制台复制" />
        </label>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy || !taskId.trim()}
          onClick={() => void onReconcile(summary.nodeId, { outcome: "resume_original", taskId: taskId.trim() })}
        ><Activity aria-hidden="true" size={16} />录入编号并继续查询原任务</button>
        <small>此操作只查询原任务，不重新提交生成任务；原任务是否扣费仍以服务商账单为准。</small>
      </div> : null}
      <fieldset className="paid-manual-resolution" disabled={busy}>
        <legend>服务商账单核对结果</legend>
        <small>先在控制台确认服务商事实（未扣费、已扣费或仍需核对），再选择对应的系统动作：未扣费不会计入已记录费用；已扣费会按你填写的实际费用或原预估计入已记录费用；仍需核对时用上方任务编号继续查询原任务。</small>
        {requiresItemSelection ? <label className="field field-wide">
          <span>本次核对镜头</span>
          <select
            value={selectedManualItemRequestId}
            onChange={(event) => setSelectedItemRequestId(event.target.value)}
            disabled={manuallyResolvableItems.length === 0}
          >
            {manuallyResolvableItems.length === 0 ? <option value="">没有可人工结算的镜头</option> : null}
            {manuallyResolvableItems.map((item) => <option key={item.itemRequestId} value={item.itemRequestId}>
              镜头 {item.scenePosition} · {paidProviderIdentity(providers, item.providerId, item.modelId)}
            </option>)}
          </select>
        </label> : null}
        <div className="paid-manual-options">
          <label><input type="radio" name={`paid-outcome-${summary.nodeId}`} checked={manualOutcome === "confirmed_not_charged"} onChange={() => setManualOutcome("confirmed_not_charged")} />未扣费 · 不计入已记录费用</label>
          <label><input type="radio" name={`paid-outcome-${summary.nodeId}`} checked={manualOutcome === "confirmed_charged"} onChange={() => setManualOutcome("confirmed_charged")} />已扣费 · 计入已记录费用</label>
        </div>
        {manualOutcome === "confirmed_charged" ? <label className="field field-wide">
          <span>实际费用（可选）</span>
          <input type="number" min="0" step="0.01" value={actualCost} onChange={(event) => setActualCost(event.target.value)} placeholder="留空则按原预估计入已记录费用" />
        </label> : null}
        <label className="field field-wide">
          <span>核对记录</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} rows={3} placeholder="写明在服务商控制台核对到的任务和账单证据" />
        </label>
        <label className="paid-manual-confirmation"><input type="checkbox" checked={manualConfirmed} onChange={(event) => setManualConfirmed(event.target.checked)} />我确认已在服务商控制台核对任务与账单；系统会保存这次核对记录。</label>
        <button
          className={`button ${manualOutcome === "confirmed_charged" ? "button-danger" : "button-primary"}`}
          type="button"
          disabled={!manualOutcome || !note.trim() || !manualConfirmed || !actualCostValid
            || (requiresItemSelection && !selectedManualItemRequestId)}
          onClick={() => {
            if (!manualOutcome) return;
            void onReconcile(summary.nodeId, {
              outcome: manualOutcome,
              ...(requiresItemSelection ? { itemRequestId: selectedManualItemRequestId } : {}),
              note: note.trim(),
              ...(manualOutcome === "confirmed_charged" && parsedActualCost !== undefined
                ? { actualCostCny: parsedActualCost }
                : {}),
            });
          }}
        >{manualOutcome === "confirmed_charged" ? "确认已扣费：计入已记录费用" : "确认未扣费：不计入已记录费用"}</button>
      </fieldset>
    </div> : null}
    {!requiresManualReconciliation && outcome && onReconcile ? <button
      className="button button-primary"
      type="button"
      disabled={busy}
      onClick={() => void onReconcile(summary.nodeId, { outcome })}
    >{outcome === "requote" ? <><RotateCcw aria-hidden="true" size={16} />为未完成镜头重新报价</> : <><Activity aria-hidden="true" size={16} />继续获取原任务结果</>}</button> : null}
  </section>;
}

type StudioPaidReconciliationDraft = Omit<StudioPaidReconciliationInput, "expectedRunRevision" | "reconciliationId">;

function paidProviderName(providerId: string): string {
  return (providerLabel(providerId) ?? "画面服务").replace(/ (?:视频|图片)生成$/, "");
}

interface ProviderConsoleEntry {
  providerId: string;
  label: string;
  consoleUrl: string;
}

function providerConsoleEntries(providers: StudioProvider[], providerIds: Array<string | undefined>): ProviderConsoleEntry[] {
  const seen = new Set<string>();
  const entries: ProviderConsoleEntry[] = [];
  for (const providerId of providerIds) {
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    const provider = providers.find((candidate) => candidate.id === providerId);
    const consoleUrl = provider?.consoleUrl?.trim();
    // 控制台入口未在目录声明时不渲染空链接，改由文案引导联系管理员。
    if (!consoleUrl) continue;
    entries.push({ providerId, label: provider?.label ?? providerLabel(providerId) ?? "服务商", consoleUrl });
  }
  return entries;
}

function paidProviderIdentity(providers: StudioProvider[], providerId: string, modelId: string): string {
  const providerName = paidProviderName(providerId);
  if (!modelId || modelId === providerId) return providerName;
  const modelName = catalogModelLabel(providers, modelId) ?? "模型名称未记录";
  return modelName === providerName ? providerName : `${providerName} · ${modelName}`;
}

function paidOperationStateLabel(state: StudioPaidNodeSummary["items"][number]["state"]): string {
  return ({
    prepared: "尚未提交",
    submitted: "已提交",
    provider_succeeded: "服务商已完成",
    materialized: "文件已保存",
    terminal_failed: "明确失败",
    unknown: "状态未知",
  } as const)[state];
}

function paidOperationCostLabel(item: StudioPaidNodeSummary["items"][number]): string {
  if (item.actualCostCny !== undefined && item.actualCostSource === "provider_reported") return `服务商回传 ¥${item.actualCostCny.toFixed(2)}`;
  if (item.actualCostCny !== undefined && item.actualCostSource === "manual_reconciled") return `人工核对后登记 ¥${item.actualCostCny.toFixed(2)}`;
  if (item.actualCostCny !== undefined && item.actualCostSource === "configured_rate") return `按配置费率记录 ¥${item.actualCostCny.toFixed(2)} · 非服务商确认账单`;
  if (item.actualCostCny !== undefined) return `已登记费用 ¥${item.actualCostCny.toFixed(2)}`;
  if (item.state === "prepared" || item.state === "terminal_failed") return `未计费 · 预估 ¥${item.estimatedCostCny.toFixed(2)}`;
  if (item.state === "materialized") return "已完成 · 待确认是否扣费";
  return `待确认 · 预估 ¥${item.estimatedCostCny.toFixed(2)}`;
}

interface VisualReviewDecision {
  audioReview?: unknown;
  mode: "single" | "dual" | "incomplete";
  recommendation: "approve" | "revise" | "reject";
  confidence: number;
  summary: string;
  findingCount: number;
  pendingInspectionCount: number;
  infoCount: number;
  findings: VisualReviewFinding[];
  /** 报告里的全部结论，含只作提示与暂无法判定的条目；逐条表态覆盖的是这一整份。 */
  reviewItems: VisualReviewFinding[];
  reviewArtifactId?: string;
  evidenceId?: string;
  independentReviews: VisualReviewBranch[];
  lowestScores: Array<{ key: string; label: string; value: number }>;
}

interface VisualReviewBranch {
  providerId: string;
  modelId: string;
  recommendation: "approve" | "revise" | "reject";
  summary: string;
  score?: number;
  findingCount: number;
  /** 这一分支自己的独立审计投了什么票；repair 表示这份意见本身有瑕疵，不代表作品有问题。 */
  auditVerdict?: "pass" | "repair";
}

interface VisualReviewFinding {
  findingIndex: number;
  /** 服务端按结论内容算出的稳定条目编号；逐条表态时原样回传。 */
  itemKey?: string;
  timecodeMs: number;
  scenePosition?: number;
  targetNodeId?: "script" | "visual-direction" | "assets";
  category: string;
  description: string;
  suggestion: string;
  evidenceStatus?: "satisfied" | "failed" | "not_observed" | "not_applicable";
  severity?: "info" | "warning" | "critical";
  nextAction?: "inspect_existing_media" | "replan_upstream" | "rework_asset" | "none";
  /** 与上一轮补查相比：本条是本轮新提出的，还是同一位置但判定变了。 */
  reviewChange?: "new" | "changed";
  previousVerdict?: VisualReviewVerdictSnapshot;
}

/** 上一轮对同一位置的原文，用来和本轮逐字对照。 */
interface VisualReviewVerdictSnapshot {
  statusLabel: string;
  description: string;
  suggestion: string;
}

const VISUAL_SCORE_LABELS: Record<string, string> = {
  composition: "构图",
  continuity: "连续性",
  pacing: "节奏",
  legibility: "可读性",
  safety: "安全性",
};

/**
 * 一条结论的"判定"：模型对同一处画面给出的结论性字段。
 * 描述文字换个说法但结论没变，不算判定变动——标出来的必须是结论真的变了。
 */
function visualReviewFindingVerdict(finding: {
  category: string;
  evidenceStatus?: string;
  severity?: string;
  nextAction?: string;
}): string {
  return [finding.category, finding.evidenceStatus ?? "", finding.severity ?? "", finding.nextAction ?? ""].join("|");
}

function reviewEvidenceStatusText(raw: Record<string, unknown>): string {
  if (raw.evidenceStatus === "not_observed") return "抽帧看不出来，需要人眼确认";
  if (raw.evidenceStatus === "not_applicable") return "不适用画面判定";
  if (raw.evidenceStatus === "satisfied") return "模型判定符合要求";
  if (raw.severity === "info") return "提示";
  return raw.severity === "critical" ? "确认缺陷（严重）" : "确认缺陷";
}

/**
 * 上一轮审片对同一处画面的结论，按"镜位 + 时间点"索引。
 *
 * 用位置而不是内容摘要做锚：判定变了的条目，其内容摘要本来就会变，按摘要匹配等于
 * 永远匹配不上——那样"判定变动"只会标注新增条目，恰好漏掉真正需要对照的那些。
 */
function previousRenderedReviewIndex(
  node: StudioRunDetail["nodes"][number],
): Map<string, { verdict: string; snapshot: VisualReviewVerdictSnapshot }> {
  const versions = node.outputState?.versions ?? [];
  const effectiveIndex = versions.findIndex((version) => version.id === node.outputState?.effectiveVersionId);
  const previousReport = versions
    .slice(0, effectiveIndex < 0 ? 0 : effectiveIndex)
    .reverse()
    .map((version) => (isRecord(version.output) && isRecord(version.output.report) ? version.output.report : undefined))
    .find((report) => isRecord(report)
      && isRecord(report.reviewScope)
      && report.reviewScope.reviewStage === "rendered_video");
  const index = new Map<string, { verdict: string; snapshot: VisualReviewVerdictSnapshot }>();
  if (!previousReport || !Array.isArray(previousReport.findings)) return index;
  for (const value of previousReport.findings) {
    if (!isRecord(value)) continue;
    const scenePosition = Number(value.scenePosition);
    const timecodeMs = Number(value.timecodeMs);
    if (!Number.isInteger(scenePosition) || scenePosition < 1 || !Number.isInteger(timecodeMs) || timecodeMs < 0) continue;
    const anchor = `${scenePosition}:${timecodeMs}`;
    if (index.has(anchor)) continue;
    index.set(anchor, {
      verdict: visualReviewFindingVerdict({
        category: typeof value.category === "string" ? value.category : "other",
        ...(typeof value.evidenceStatus === "string" ? { evidenceStatus: value.evidenceStatus } : {}),
        ...(typeof value.severity === "string" ? { severity: value.severity } : {}),
        ...(typeof value.nextAction === "string" ? { nextAction: value.nextAction } : {}),
      }),
      snapshot: {
        statusLabel: reviewEvidenceStatusText(value),
        description: typeof value.description === "string" ? value.description : "上一轮没有留下问题说明。",
        suggestion: typeof value.suggestion === "string" ? value.suggestion : "上一轮没有留下修改建议。",
      },
    });
  }
  return index;
}

function visualReviewDecision(run: StudioRunDetail): VisualReviewDecision | undefined {
  const node = run.nodes.find((item) => item.id === "visual-review");
  if (!node) return undefined;
  const effectiveOutput = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId)?.output ?? node.output;
  if (!isRecord(effectiveOutput)) return undefined;
  const report = isRecord(effectiveOutput.report) ? effectiveOutput.report : effectiveOutput;
  if (report.recommendation !== "approve" && report.recommendation !== "revise" && report.recommendation !== "reject") return undefined;
  const reviewRecommendation = report.recommendation as VisualReviewDecision["recommendation"];
  const confidence = typeof report.confidence === "number" && Number.isFinite(report.confidence)
    ? Math.min(1, Math.max(0, report.confidence))
    : 0;
  const reportScoreValues = isRecord(report.scores) ? Object.entries(report.scores)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    : [];
  const scores = reportScoreValues
    .map(([key, value]) => ({ key, label: VISUAL_SCORE_LABELS[key] ?? key, value }))
    .sort((left, right) => left.value - right.value)
    .slice(0, 2);
  const previousReviewIndex = previousRenderedReviewIndex(node);
  const findings = Array.isArray(report.findings) ? report.findings.flatMap((value, findingIndex): VisualReviewFinding[] => {
    if (!isRecord(value) || !Number.isInteger(value.timecodeMs) || Number(value.timecodeMs) < 0) return [];
    const scenePosition = Number(value.scenePosition);
    return [{
      findingIndex,
      timecodeMs: Number(value.timecodeMs),
      ...(Number.isInteger(scenePosition) && scenePosition > 0 ? { scenePosition } : {}),
      category: typeof value.category === "string" ? value.category : "other",
      description: typeof value.description === "string" ? value.description : "未提供问题说明。",
      suggestion: typeof value.suggestion === "string" ? value.suggestion : "请人工检查此处画面。",
      ...(value.targetNodeId === "script" || value.targetNodeId === "visual-direction" || value.targetNodeId === "assets"
        ? { targetNodeId: value.targetNodeId } : {}),
      ...(value.evidenceStatus === "satisfied" || value.evidenceStatus === "failed" || value.evidenceStatus === "not_observed" || value.evidenceStatus === "not_applicable"
        ? { evidenceStatus: value.evidenceStatus } : {}),
      ...(value.severity === "info" || value.severity === "warning" || value.severity === "critical" ? { severity: value.severity } : {}),
      ...(value.nextAction === "inspect_existing_media" || value.nextAction === "replan_upstream" || value.nextAction === "rework_asset" || value.nextAction === "none"
        ? { nextAction: value.nextAction } : {}),
      ...(typeof value.itemKey === "string" && /^[a-f0-9]{64}$/.test(value.itemKey) ? { itemKey: value.itemKey } : {}),
    }];
  }) : [];
  // 第二遍：标出与上一轮相比判定变了的条目，并把上一轮原文带上供逐字对照。
  const reviewedFindings = findings.map((finding): VisualReviewFinding => {
    if (!finding.scenePosition) return finding;
    const previous = previousReviewIndex.get(`${finding.scenePosition}:${finding.timecodeMs}`);
    if (!previous) return previousReviewIndex.size > 0 ? { ...finding, reviewChange: "new" } : finding;
    if (previous.verdict === visualReviewFindingVerdict(finding)) return finding;
    return { ...finding, reviewChange: "changed", previousVerdict: previous.snapshot };
  });
  const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
  const reviewArtifactId = effectiveVersion?.artifactIds.find((artifactId) => (
    run.artifacts.some((artifact) => artifact.id === artifactId && artifact.kind === "review_report" && artifact.producerNodeId === "visual-review")
  ));
  const reviewScope = isRecord(report.reviewScope) ? report.reviewScope : undefined;
  const actualModels = Array.isArray(reviewScope?.actualModels)
    ? reviewScope.actualModels.filter(isRecord)
    : [];
  // 各分支独立审计的投票，按 providerId+modelId 认领。审计查的是"这份审片报告本身站不站得住"，
  // 与作品好坏是两件事：auditVerdict 为 repair 时这份意见的结论需要用户重点核对，但它不是判决。
  const branchAuditVerdicts = new Map<string, "pass" | "repair">();
  if (actualModels.length > 0) {
    for (const model of actualModels) {
      if (!isRecord(model) || typeof model.providerId !== "string" || typeof model.modelId !== "string") continue;
      if (model.auditVerdict !== "pass" && model.auditVerdict !== "repair") continue;
      branchAuditVerdicts.set(`${model.providerId}\u0000${model.modelId}`, model.auditVerdict);
    }
  }
  const reportedReviews = Array.isArray(report.independentReviews)
    ? report.independentReviews.flatMap((value): VisualReviewBranch[] => {
        if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.modelId !== "string" || !isRecord(value.report)) return [];
        const branch = value.report;
        if (branch.recommendation !== "approve" && branch.recommendation !== "revise" && branch.recommendation !== "reject") return [];
        const recommendation = branch.recommendation as VisualReviewBranch["recommendation"];
        const branchScores = isRecord(branch.scores)
          ? Object.values(branch.scores).filter((score): score is number => typeof score === "number" && Number.isFinite(score))
          : [];
        const auditVerdict = branchAuditVerdicts.get(`${value.providerId} ${value.modelId}`);
        return [{
          providerId: value.providerId,
          modelId: value.modelId,
          recommendation,
          summary: typeof branch.summary === "string" && branch.summary.trim() ? branch.summary.trim() : "该模型没有提供审片摘要。",
          ...(branchScores.length ? { score: Math.round(branchScores.reduce((sum, score) => sum + score, 0) / branchScores.length) } : {}),
          findingCount: Array.isArray(branch.findings) ? branch.findings.filter((finding) => (
            isRecord(finding) && finding.evidenceStatus === "failed" && finding.severity !== "info"
          )).length : 0,
          ...(auditVerdict ? { auditVerdict } : {}),
        }];
      })
    : [];
  const singleModel = actualModels.length === 1
    && typeof actualModels[0]?.providerId === "string"
    && typeof actualModels[0]?.modelId === "string"
    ? { providerId: actualModels[0].providerId, modelId: actualModels[0].modelId }
    : undefined;
  const singleAuditVerdict = singleModel
    ? branchAuditVerdicts.get(`${singleModel.providerId}\u0000${singleModel.modelId}`)
    : undefined;
  const mode = report.independentReviews === undefined && singleModel
    ? "single"
    : actualModels.length === 2 && reportedReviews.length === 2
      ? "dual"
      : "incomplete";
  const independentReviews = mode === "single" && singleModel
    ? [{
        ...singleModel,
        recommendation: reviewRecommendation,
        summary: typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : "该模型没有提供审片摘要。",
        ...(reportScoreValues.length ? { score: Math.round(reportScoreValues.reduce((sum, [, score]) => sum + score, 0) / reportScoreValues.length) } : {}),
        findingCount: reviewedFindings.filter((finding) => finding.evidenceStatus === "failed" && finding.severity !== "info").length,
        ...(singleAuditVerdict
          ? { auditVerdict: singleAuditVerdict }
          : {}),
      }]
    : reportedReviews;
  return {
    mode,
    audioReview: report.audioReview,
    recommendation: reviewRecommendation,
    confidence,
    summary: typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : "视觉审片发现需要人工确认的问题。",
    findingCount: reviewedFindings.filter((finding) => finding.evidenceStatus === "failed" && finding.severity !== "info").length,
    pendingInspectionCount: reviewedFindings.filter((finding) => finding.evidenceStatus === "not_observed").length,
    infoCount: reviewedFindings.filter((finding) => finding.severity === "info" && finding.evidenceStatus !== "not_observed").length,
    findings: reviewedFindings.filter((finding) => finding.evidenceStatus === "failed" && finding.severity !== "info"),
    reviewItems: reviewedFindings.filter((finding) => finding.itemKey !== undefined),
    ...(reviewArtifactId ? { reviewArtifactId } : {}),
    ...(typeof reviewScope?.evidenceId === "string" ? { evidenceId: reviewScope.evidenceId } : {}),
    independentReviews,
    lowestScores: scores,
  };
}

function sourceReviewDecisionEvidenceId(run: StudioRunDetail): string | null {
  if (run.activeIntervention?.kind !== "source_review_decision"
    && run.activeIntervention?.kind !== "source_review_retry") return null;
  if (run.activeIntervention.evidenceId && /^[a-f0-9]{64}$/.test(run.activeIntervention.evidenceId)) {
    return run.activeIntervention.evidenceId;
  }
  const node = run.nodes.find((candidate) => candidate.id === run.activeIntervention?.nodeId);
  const output = node?.outputState?.versions.find((version) => version.id === node?.outputState?.effectiveVersionId)?.output ?? node?.output;
  if (!isRecord(output) || !isRecord(output.sourceReview)) return null;
  const evidenceId = output.sourceReview.evidenceId;
  return typeof evidenceId === "string" && /^[a-f0-9]{64}$/.test(evidenceId) ? evidenceId : null;
}

function visualReviewRecommendationLabel(value: VisualReviewDecision["recommendation"]): string {
  if (value === "approve") return "通过";
  if (value === "revise") return "修改后再审";
  return "不通过";
}

/** 判定变动的条目：本轮结论与上一轮原文并排给出，避免只报"变了"却让人无处对照。 */
function FindingVerdictChange({ finding }: { finding: VisualReviewFinding }) {
  if (!finding.reviewChange) return null;
  const label = finding.reviewChange === "changed" ? "判定变动" : "本轮新提出";
  return <div className={`finding-verdict-change is-${finding.reviewChange}`}>
    <strong>{label}</strong>
    {finding.previousVerdict ? <dl>
      <div><dt>上一轮</dt><dd>{finding.previousVerdict.statusLabel}：{creatorFacingTechnicalText(finding.previousVerdict.description)}</dd></div>
      <div><dt>本轮</dt><dd>{reviewEvidenceStatusLabel(finding)}：{creatorFacingTechnicalText(finding.description)}</dd></div>
    </dl> : <p>上一轮没有在这个位置提出结论。</p>}
  </div>;
}

function reviewItemTimecode(finding: VisualReviewFinding): string {
  const seconds = Math.floor(finding.timecodeMs / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 逐条表态时每条结论的处境：模型确认有问题、抽帧看不出来、只是提示，还是判不了。 */
function reviewEvidenceStatusLabel(finding: VisualReviewFinding): string {
  if (finding.evidenceStatus === "not_observed") return "抽帧看不出来，需要人眼确认";
  if (finding.evidenceStatus === "not_applicable") return "不适用画面判定";
  if (finding.evidenceStatus === "satisfied") return "模型判定符合要求";
  if (finding.severity === "info") return "提示";
  return finding.severity === "critical" ? "确认缺陷（严重）" : "确认缺陷";
}

/**
 * 改这一镜的字幕与旁白。
 *
 * 旁白和字幕是脚本里同一行字（成片字幕与配音都从它来），所以改字要改在脚本上。画面不重新生成，
 * 但配音必须按新文字重合成——云端配音按字数计费，操作员按下之前就得知道这笔钱可能要花。
 */
function SceneNarrationRevision({ scenePosition, busy, onLoad, onSubmit }: {
  scenePosition: number;
  busy: boolean;
  onLoad: (scenePosition: number) => Promise<string>;
  onSubmit: (input: Pick<StudioNarrationRevisionInput, "scenePosition" | "narration" | "note">) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<string>();
  const [narration, setNarration] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const openEditor = async () => {
    setOpen(true);
    if (original !== undefined || loading) return;
    setLoading(true);
    setLoadError(undefined);
    try {
      const loaded = await onLoad(scenePosition);
      setOriginal(loaded);
      setNarration(loaded);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };
  if (!open) return <button className="scene-narration-open" type="button" disabled={busy} onClick={() => void openEditor()}>
    改这一镜的字幕/旁白
  </button>;
  // 文字没变就没必要重做：配音会按字数重新计费，白花这笔钱不该只靠操作员自己发现。
  const unchanged = original !== undefined && narration.trim() === original.trim();
  return <div className="scene-revision-controls scene-narration-revision">
    <p className="scene-narration-cost">只改字，画面不重新生成、也不重新购买。配音与字幕同源，会按新文字重合成（用云端配音时按字数计费），随后重新渲染并复审。</p>
    {loadError ? <p className="scene-narration-error">取不到原文：{loadError}</p> : null}
    <label className="field field-wide">
      <span>镜头 {scenePosition} 的旁白/字幕</span>
      <textarea
        aria-label={`镜头 ${scenePosition} 的旁白字幕`}
        value={narration}
        onChange={(event) => setNarration(event.target.value)}
        rows={3}
        maxLength={600}
        disabled={loading}
        placeholder={loading ? "正在读取原文……" : undefined}
      />
    </label>
    <label className="field field-wide">
      <span>这一镜的修改说明</span>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2_000} />
    </label>
    {unchanged ? <small>文字和现在一样，改完不会产生任何变化。</small> : null}
    <div className="scene-narration-actions">
      <button
        className="button button-secondary"
        type="button"
        disabled={busy || loading || unchanged || !narration.trim() || !note.trim()}
        onClick={() => void onSubmit({ scenePosition, narration: narration.trim(), note: note.trim() })}
      >按新文字重做配音与字幕</button>
      <button className="button button-ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>收起</button>
    </div>
  </div>;
}

function SceneRevisionFinding({ finding, busy, onSeek, onSubmit, onReselectAsset, onLoadNarration, onSubmitNarration }: {
  finding: VisualReviewFinding;
  busy: boolean;
  onSeek: () => void;
  onSubmit: (input: Pick<StudioSceneRevisionInput, "reuseFromScenePosition" | "note">) => Promise<void>;
  onReselectAsset?: (input: Pick<StudioSceneResourceRevisionInput, "note">) => Promise<void>;
  onLoadNarration?: (scenePosition: number) => Promise<string>;
  onSubmitNarration?: (input: Pick<StudioNarrationRevisionInput, "scenePosition" | "narration" | "note">) => Promise<void>;
}) {
  const [sourcePosition, setSourcePosition] = useState("");
  const [note, setNote] = useState("");
  const [reselectNote, setReselectNote] = useState("");
  const canReplaceAsset = finding.targetNodeId === "assets" && finding.nextAction === "rework_asset";
  const sourceOptions = canReplaceAsset && finding.scenePosition
    ? Array.from({ length: Math.max(0, finding.scenePosition - 1) }, (_, index) => index + 1)
    : [];
  const seconds = Math.floor(finding.timecodeMs / 1_000);
  const timecode = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <article className="scene-revision-finding">
    <button className="scene-finding-seek" type="button" onClick={onSeek}>
      {finding.scenePosition ? `镜头 ${finding.scenePosition}` : "未定位镜头"} · {timecode}
    </button>
    <p>{creatorFacingTechnicalText(finding.description)}</p>
    <small>{creatorFacingTechnicalText(finding.suggestion)}</small>
    <FindingVerdictChange finding={finding} />
    {finding.nextAction === "replan_upstream" ? <small>这项问题需要先调整{finding.targetNodeId === "script" ? "脚本" : "导演方案"}，不能用任意旧素材替代。</small> : null}
    {/* 「换素材」和「用已有镜头替换」是两件事：前者换的是这一镜画面的来源，
        后者是干脆不拍这一镜、借一个更早镜头的画面。原来只有后者，
        于是"这一镜素材本身不合格"根本没有对应的动作可点。 */}
    {canReplaceAsset && finding.scenePosition && onReselectAsset ? <div className="scene-revision-controls">
      <p className="field-wide">换一版这一镜的画面：在这一镜<strong>已通过语义筛选</strong>的候选里改选下一名。其它镜头的方案一个字段都不动，已经付过钱的分镜不会重买；换不到第二个合格候选时会明确拦住，而不是随便塞一个。</p>
      <label className="field field-wide">
        <span>重取说明</span>
        <textarea value={reselectNote} onChange={(event) => setReselectNote(event.target.value)} rows={2} maxLength={2_000} placeholder="说明这一镜画面为什么必须换" />
      </label>
      <button
        className="button button-secondary"
        type="button"
        disabled={busy || !reselectNote.trim()}
        onClick={() => void onReselectAsset({ note: reselectNote.trim() })}
      >换一版这一镜素材</button>
    </div> : null}
    {sourceOptions.length > 0 ? <div className="scene-revision-controls">
      <label className="field">
        <span>用已有镜头替换</span>
        <select value={sourcePosition} onChange={(event) => setSourcePosition(event.target.value)}>
          <option value="">选择已有镜头</option>
          {sourceOptions.map((position) => <option key={position} value={position}>镜头 {position}</option>)}
        </select>
      </label>
      <label className="field field-wide">
        <span>修改说明</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2_000} />
      </label>
      <button
        className="button button-secondary"
        type="button"
        disabled={busy || !sourcePosition || !note.trim()}
        onClick={() => void onSubmit({ reuseFromScenePosition: Number(sourcePosition), note: note.trim() })}
      >替换后重新审片</button>
    </div> : null}
    {/* 这一镜的字是操作员能直接改的东西，所以只要有镜位就给入口——包括结论指向素材的那些。
        「画面没兑现这句话」这类缺陷本来就有两个修法：改画面，或者改承诺。哪边才是问题由操作员
        判断，宿主替它选边就是把一条真实缺陷推回给一条只换画面的路。改错了字不会变成悄悄放行：
        复审会按新文字重判这一镜。 */}
    {finding.scenePosition && onLoadNarration && onSubmitNarration
      ? <SceneNarrationRevision
        scenePosition={finding.scenePosition}
        busy={busy}
        onLoad={onLoadNarration}
        onSubmit={onSubmitNarration}
      />
      : null}
  </article>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ProductionProgress({ run }: { run: StudioRunDetail }) {
  if (!run.progress || !run.phases) return null;
  return <nav className="production-progress" aria-label="制作章节" data-tour="run-workflow">
    <div className="production-phases">
      {run.phases.map((phase) => <span className={`production-phase is-${phase.status}`} key={phase.id} aria-current={phase.status === "running" ? "step" : undefined}>
        <span className="production-phase-index">{phase.status === "completed" ? <Check aria-hidden="true" size={13} /> : null}</span>
        <strong>{phase.label}</strong>
      </span>)}
    </div>
  </nav>;
}

// 复核摘要默认只给节选：真实结论可能很长，长文必须通过明确的展开入口查看，
// 且节选要标注"原文节选"，不把截断文本伪装成完整结论（UX-04）。
function reviewSummaryExcerpt(text: string): { excerpt: string; truncated: boolean } {
  const clean = creatorFacingTechnicalText(text) ?? "";
  if (clean.length <= 160) return { excerpt: clean, truncated: false };
  return { excerpt: `${clean.slice(0, 160)}…`, truncated: true };
}

function CurrentDecisionBar({ run }: { run: StudioRunDetail }) {  const intervention = run.activeIntervention;
  if (!intervention) return null;
  const nodeName = runNodeLabel(intervention.nodeId);
  const incomplete = intervention.kind === "source_review_retry" && intervention.reviewStatus === "incomplete";
  const hardStop = intervention.kind === "source_review_retry" && intervention.reviewStatus === "unknown_or_unsafe";
  const state = incomplete ? "需要处理" : hardStop ? "需要处理" : "等你确认";
  const consequence = incomplete
    ? "接受后只继续后续制作，保留“审查未完成、无评分”事实；不会扩大已有的费用授权。"
    : hardStop
      ? "付费、来源或媒体事实不明确，只能补查或终止。"
      : intervention.boundary === "node-complete"
        ? "放行后进入下一节点，不会重跑当前节点。付费画面按既有流程报价；自动按量配音和模型依已选服务规则计费。"
        : "你的决定会被记录，已生成的版本和费用事实会保留。";
  return <section className={`current-decision-bar${hardStop ? " is-hard-stop" : incomplete ? " is-incomplete" : ""}`} aria-label="当前决定" role="status">
    <div className="current-decision-heading">
      <div><p className="eyebrow">当前决定</p><h2>{nodeName} · {state}</h2></div>
      <span className="current-decision-status">{state}</span>
    </div>
    <p>{consequence}</p>
    <dl>
      <div><dt>是否重跑</dt><dd>{intervention.boundary === "node-complete" ? "不重跑当前节点" : incomplete ? "可只重试审查" : "按页面提供的补查/终止动作"}</dd></div>
      <div><dt>费用影响</dt><dd>{hardStop ? "不自动新增费用" : incomplete ? "继续不扩大已有费用授权" : "画面按报价授权；自动配音与模型依已选服务规则计费"}</dd></div>
      <div><dt>当前版本</dt><dd>已生成内容保留</dd></div>
    </dl>
  </section>;
}

function isStoppedStatus(status: StudioRunDetail["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected" || status === "paused" || status === "stale";
}

function hasDirectorCostFeedback(run: StudioRunDetail): boolean {
  const director = run.nodes.find((node) => node.id === "visual-direction");
  const effectiveInput = director?.inputState?.versions.find(
    (version) => version.id === director.inputState?.effectiveVersionId,
  )?.value;
  if (typeof effectiveInput !== "object" || effectiveInput === null || Array.isArray(effectiveInput)) return false;
  const costFeedback = (effectiveInput as Record<string, unknown>).costFeedback;
  return Array.isArray(costFeedback) ? costFeedback.length > 0 : typeof costFeedback === "object" && costFeedback !== null;
}

function retryableNodeId(run: StudioRunDetail): string | undefined {
  return run.nodes.find((node) => node.status === "failed")?.id
    ?? (run.failure && isSourceAssetReviewFailure(run.failure)
      ? run.nodes.find((node) => node.status === "rejected" && ["assets", "asset-source-review"].includes(node.id))?.id
      : undefined);
}

function hasUncertainPaidOutcome(run: StudioRunDetail): boolean {
  return run.nodes.some((node) => node.outcomeUncertain === true);
}

function isSourceAssetReviewFailure(failure: NonNullable<StudioRunDetail["failure"]>): boolean {
  return failure.nodeId === "asset-source-review"
    || (["assets", "asset-source-review"].includes(failure.nodeId)
      && /源素材视觉预检|试片未通过|试片审查暂未完成/.test(failure.technicalDetail ?? ""));
}

// 「审查没跑完」（复核服务不可用、模型没给出可用结论）和「审查未通过」（复核给出了否定
// 结论）是两回事：前者没有任何裁决，主动权在用户手里——等服务恢复或直接重试都行，措辞
// 必须说"暂停"而不是"未通过"，否则复核基础设施的一次故障就被渲染成作品被否。
function sourceReviewIncomplete(failure: NonNullable<StudioRunDetail["failure"]>): boolean {
  return isSourceAssetReviewFailure(failure)
    && /试片审查暂未完成|复审尚未完成/.test(failure.technicalDetail ?? "");
}

function runningNodeLabel(run: StudioRunDetail): string {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.id === run.currentNodeId)
    ?? run.nodes.find((node) => node.status === "running")
    ?? run.nodes.find((node) => node.status === "pending");
  if (current?.id === "script") {
    const providerId = (current.executionReceipt ?? current.plannedExecution)?.providerId;
    return providerId === "codex-screenwriter-v1"
      ? "编剧与独立质量复核正在修改脚本"
      : "编剧正在生成结构化脚本";
  }
  return current ? `${current.role ?? "制作角色"}正在处理${stepNameFor(current, current.label)}` : "系统正在推进制作";
}

/**
 * 顶栏这一行回答的是"现在是谁在工作"，所以两半都必须站在界面自己的词汇里——名字走
 * capacityNameFor，模型走 recordedModelName，两处各自处理回执里的内部标识。
 */
function activeNodeModel(run: StudioRunDetail, providers: StudioProvider[]): string | undefined {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.status === "running");
  if (!current) return undefined;
  const execution = current.executionReceipt ?? current.plannedExecution;
  if (!execution) return undefined;
  const name = stepNameFor(current, execution.providerLabel);
  const model = recordedModelName(execution.modelId, providers);
  return model ? `${name} · ${model}` : name;
}

/**
 * 界面里的步骤名。候选名来自回执（`providerLabel`）或节点自身（`label`），两者都可能是流水线
 * 内部的英文标识——`brief` 是 "Validate brief"，导演方案是 "Direct visual plan"，终审是
 * "Human final review"。带中文的候选名才是界面词汇（「AI 视觉导演」这类 provider 名），保留它
 * 能说清"是哪一台在跑"；英文的一律换成界面按 nodeId 维护的中文步骤名，否则拼进中文句子里
 * 就是半截中英混排。NodeWorkspace 一直是这么渲染的，只有本组件漏了。
 */
function stepNameFor(
  node: StudioRunDetail["nodes"][number],
  candidateLabel: string | undefined,
): string {
  const label = candidateLabel?.trim();
  if (label && /[一-鿿]/.test(label)) return label;
  return RUN_NODE_LABELS[node.id] ?? node.role?.trim() ?? runNodeLabel(node.id);
}

function recordedModelName(modelId: string | undefined, providers: StudioProvider[]): string | undefined {
  const id = modelId?.trim();
  // 本地编排节点（brief、创作规划）自己不调模型，模型在它下面的阶段里。回执记的 "inline" 是个
  // 字面量、不是模型，所以整段模型名都不显示：把"这一步不直接调模型"说成"我们没记下来"，
  // 用户会以为记录丢了。
  if (!id || id === "inline") return undefined;
  return catalogModelLabel(providers, id) ?? "模型名称未记录";
}

function etaLabel(progress: NonNullable<StudioRunDetail["progress"]>): string {
  if (progress.eta) return `预计还需 ${formatDuration(progress.eta.lowSeconds)}–${formatDuration(progress.eta.highSeconds)}`;
  if (progress.etaUnavailableReason === "waiting_for_human") return "等待你的确认，不计算 ETA";
  if (progress.etaUnavailableReason === "future_human_gate") return "后续有人工或费用确认，暂不估算整条耗时";
  if (progress.etaUnavailableReason === "insufficient_history") return `暂无法估算剩余时间；已处理 ${formatDuration(progress.elapsedSeconds)}`;
  return "当前流程已停止计时";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚" : new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function runStateMessage(run: StudioRunDetail): string {
  if (run.status === "succeeded") {
    return "制作已完成，发布包可以下载使用。";
  }
  if (run.status === "rejected") {
    const humanDecision = run.decisions.at(-1);
    if (humanDecision) {
      return humanDecision.note ?? "成片已被人工打回，审片意见已保留。请查看这条制作可用的后续操作。";
    }
    const rejectedReason = run.nodes.find((node) => node.status === "rejected")?.error;
    return creatorFacingTechnicalText(rejectedReason)
      ?? "成片未通过机器质检，请查看质检报告后重新发起制作。";
  }
  if (run.status === "failed") {
    if (hasUncertainPaidOutcome(run)) {
      return "付费服务可能已经受理请求，但结果尚未确认。系统已停止重试和重新制作，请先到服务商控制台核对任务与账单。";
    }
    return safeRunError(run.nodes.find((node) => node.status === "failed")?.error);
  }
  if (run.status === "awaiting_spend_approval") return "即将生成付费图片或视频，请先检查前面的内容、模型和本次报价。";
  if (run.status === "needs_human") return "正在等待你的意见或确认；你可以继续讨论，确认后才会进入下一步。";
  if (run.status === "approval_invalidated") return "输入、模型、报价或重试次数发生了变化，之前的费用确认已失效，请重新检查。";
  if (run.status === "stale" && hasDirectorCostFeedback(run)) {
    return "你已把上一份画面报价退回导演，降本意见已经保存。继续后会先调整方案，再给你一份新报价。";
  }
  if (run.status === "stale") return "上游内容已被人工修改；系统会重新检查每一步是否仍然适用，只重做失效的部分，保留仍然有效的成果。";
  if (run.status === "paused") return "制作已经安全暂停。现在可以修改已完成角色的输入或交付；不修改也可以直接继续。";
  if (run.pauseRequested) return "已请求暂停；当前步骤会先安全完成，系统将在下一步开始前停下。";
  return "制作正在自动执行，详情页会实时更新；连接中断时会明确提示。";
}

// 边界停点之后、还没开始跑的第一个带可调执行的节点。机械步骤（渲染、技术质检、终审）
// 在服务端就不下发 executionConfiguration，自然落选——露出一个没有可调项的面板只是空壳。
function nextConfigurableNode(run: StudioRunDetail): StudioRunDetail["nodes"][number] | undefined {
  const waitingIndex = run.nodes.findIndex((node) => node.id === run.activeIntervention?.nodeId);
  if (waitingIndex < 0) return undefined;
  return run.nodes
    .slice(waitingIndex + 1)
    .find((node) => node.status === "pending" && node.executionConfiguration !== undefined);
}

function nodeHasCreatorContent(node: StudioRunDetail["nodes"][number], run: StudioRunDetail): boolean {
  if (NON_CREATIVE_WORKSPACE_NODE_IDS.has(node.id)) return false;
  if (["awaiting_spend_approval", "approval_invalidated", "needs_human", "stale", "failed", "rejected"].includes(node.status)) return true;
  if (hasContent(node.output)) return true;
  if (node.outputState?.versions.some((version) => hasContent(version.output) || version.artifactIds.length > 0)) return true;
  return node.artifactIds.some((artifactId) => run.artifacts.some((artifact) => artifact.id === artifactId && Boolean(artifact.contentUrl)));
}

const NON_CREATIVE_WORKSPACE_NODE_IDS = new Set(["render", "technical-review", "final-review"]);

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasContent);
  return true;
}

// 只滤掉"英文开头 + failed/error"这一类是不够的：桥接失败消息常常以中文叙述开头，
// 中间夹着 stage=/reasonCode=/诊断： 这类机器诊断，旧判据会把它原样放行到界面上。
const TECHNICAL_DIAGNOSTIC_PATTERN = /诊断：|\b(?:stage|httpStatus|failureKind|reasonCode|fieldPath|taskKind|requestIdHash|accepted)=/;

function safeRunError(message?: string): string {
  if (!message) return "制作失败，请检查对应能力和本地运行环境。";
  if (message.includes("应用重启")) return message;
  if (/\/(Users|home|private|tmp)\//.test(message)
    || /^[A-Za-z].*(failed|error|invalid|missing)/i.test(message)
    || TECHNICAL_DIAGNOSTIC_PATTERN.test(message)) {
    return "这一步执行失败。技术细节已保留在本地服务日志中；请先查看当前步骤的状态和可用恢复操作。";
  }
  return message;
}
