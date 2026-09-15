import { Activity, AlertTriangle, Check, Clock3, Download, Pause, Play, RotateCcw, Send, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StudioCostRunDetail, StudioDecisionInput, StudioNarrationRevisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProvider, StudioRunDetail, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput, StudioVisualReinspectionInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { StatusBadge } from "./StatusBadge.js";
import { creatorFacingTechnicalText, platformLabel, providerLabel, catalogModelLabel, sourceAssetReviewBreakdown } from "../presentation.js";
import { NodeWorkspace } from "./NodeWorkspace.js";
import { RunCostDetailPanel } from "./CostDashboard.js";

interface RunWorkbenchProps {
  run: StudioRunDetail;
  providers?: StudioProvider[];
  decisionPending: boolean;
  onDecision: (input: StudioDecisionInput) => Promise<void>;
  onRequestSceneRevision?: (input: StudioSceneRevisionInput) => Promise<void>;
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

export function RunWorkbench({ run, providers = [], decisionPending, onDecision, onRequestSceneRevision, onRequestNarrationRevision, onLoadSceneNarration, onReinspectVisualReview, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, pausePending = false, onOverrideNode, onOverrideNodeInput, onConfigureNode, onAuthorizeSpend, onRejectSpend, onRegenerateStale, onRequestPause, onResumePaused, onQueryOriginalTextTask, onRetrieveOriginalTextTask, onRetryFailedNode, paidNodeSummary, onReconcilePaidNode, connectionHeartbeatAt }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, { decision: "accept" | "reject"; reason: string }>>({});
  const [replanningVoice, setReplanningVoice] = useState(false);
  const [voiceDurationSeconds, setVoiceDurationSeconds] = useState("");
  const [hasPendingPlanningConfiguration, setHasPendingPlanningConfiguration] = useState(false);
  const [decisionSnapshot, setDecisionSnapshot] = useState<Pick<StudioDecisionInput, "expectedRunRevision" | "interventionId" | "reviewEvidenceId">>();
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
  const creatorNodes = run.nodes.filter((node) => nodeHasCreatorContent(node, run));
  const activeSpendNode = readOnly ? undefined : creatorNodes.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
  const remainingCreatorNodes = creatorNodes.filter((node) => node.id !== activeSpendNode?.id);
  const showReviewSurface = Boolean(readOnly || video?.contentUrl || run.activeIntervention || isStoppedStatus(run.status));
  const uncertainPaidNode = run.nodes.find((node) => node.outcomeUncertain === true);
  const visiblePaidNodeSummary = paidNodeSummary?.nodeId === uncertainPaidNode?.id ? paidNodeSummary : undefined;
  const uncertainPaidNodeProviderId = (uncertainPaidNode?.executionReceipt ?? uncertainPaidNode?.plannedExecution)?.providerId;
  const visualReview = visualReviewDecision(run);
  const voiceTiming = voiceTimingConflict(run);
  const visualReviewRequiresRevision = visualReview?.recommendation === "revise" || visualReview?.recommendation === "reject";
  const reviewItems = visualReview?.reviewItems ?? [];
  const undisposedReviewItems = reviewItems.filter((item) => item.itemKey && !reviewDecisions[item.itemKey]);
  const acceptedReviewItems = reviewItems.filter((item) => item.itemKey && reviewDecisions[item.itemKey]?.decision === "accept");
  const unexplainedReviewItems = reviewItems.filter((item) => (
    item.itemKey && reviewDecisions[item.itemKey]?.decision === "reject" && !reviewDecisions[item.itemKey]?.reason.trim()
  ));
  const setReviewDecision = (itemKey: string, decision: "accept" | "reject") => {
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
  const taskRecoveryPanel = run.taskRecovery ? <section className="task-recovery-panel" aria-label="原模型任务恢复" role="status">
    <strong>{run.taskRecovery.resultAvailable ? "原任务结果可以取回" : "已保留原模型任务"}</strong>
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
      reviewEvidenceId: visualReview?.evidenceId ?? null,
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
    <main className="page run-page">
      <header className="run-header" data-tour="run-header">
        <div>
          <p className="eyebrow">{platformLabel(run.platform)} · 目标 {run.durationSeconds} 秒</p>
          <h1>{run.title}</h1>
          <p className="page-summary">{run.angle} · {run.audience}</p>
        </div>
        <StatusBadge status={run.status} {...(readOnly ? { label: "历史只读" } : {})} />
      </header>

      {!readOnly && (run.phases && run.progress ? <ProductionProgress run={run} /> : (
        <section className="workflow-track" aria-label="生产工作流" data-tour="run-workflow">
          {run.nodes.map((node, index) => (
            <div className={`workflow-node node-${node.status}`} key={node.id}>
              <span className="node-index">{node.status === "succeeded" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
              <span>{node.role ? `${node.role} · ${node.label}` : node.label}</span>
            </div>
          ))}
        </section>
      ))}

      {activeSpendNode ? <section className="current-production-action" aria-labelledby="current-production-action-title">
        <header>
          <div><p className="eyebrow">当前需要处理</p><h2 id="current-production-action-title">现在需要你：确认{activeSpendNode.label}</h2></div>
          <StatusBadge status={run.status} />
        </header>
        <p>{activeSpendNode.role ?? "当前角色"}完成后，系统会继续推进后续步骤。请先检查它收到的内容、实际使用的模型和本次报价。</p>
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

      {showReviewSurface ? <div className="review-layout">
        <section className="video-stage" aria-labelledby="preview-title" data-tour="run-preview">
          <div className="section-heading stage-heading">
            <div><p className="eyebrow">最终画面</p><h2 id="preview-title">成片预览</h2></div>
            {video?.contentUrl ? (
              <a className="icon-button" href={video.contentUrl} download title="下载成片">
                <Download aria-hidden="true" size={18} />
              </a>
            ) : null}
          </div>
          <div className="video-frame">
            {video?.contentUrl ? (
              <video ref={previewRef} title="成片预览" src={`${video.contentUrl}#t=0.1`} controls playsInline preload="auto" />
            ) : (
              <div className="video-unavailable">视频将在渲染完成后出现在这里</div>
            )}
          </div>
        </section>

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
          {visualReview ? <section className="independent-review-panel" aria-label="双模型审片结果">
            <header><strong>成片双审：{visualReview.independentReviews.length}/2 已完成</strong><small>{visualReview.independentReviews.length === 2
              ? visualReview.evidenceId ? "两者查看同一份成片证据" : "独立审查同一版成片"
              : "审片结果不完整，不能按完整双审处理"}</small></header>
            <div className="merged-review-summary">
              <span>综合结论 · {visualReviewRecommendationLabel(visualReview.recommendation)}</span>
              <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
            </div>
            <div className="independent-review-list">
              {visualReview.independentReviews.map((review) => <article key={`${review.providerId}:${review.modelId}`}>
                <header><strong>{providerLabel(review.providerId) ?? review.providerId}</strong><span>{visualReviewRecommendationLabel(review.recommendation)}</span></header>
                <small>{catalogModelLabel(providers, review.modelId) ?? review.modelId}{review.score !== undefined ? ` · ${review.score} 分` : ""}{` · ${review.findingCount} 项问题`}</small>
                <p>{creatorFacingTechnicalText(review.summary)}</p>
              </article>)}
              {visualReview.independentReviews.length < 2 ? <p role="status">缺少 {2 - visualReview.independentReviews.length} 个可验证的独立审片结果，请重新审查当前成片。</p> : null}
            </div>
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
          ) : run.activeIntervention?.kind !== "creative_review" && run.activeIntervention ? (
            <section className="intervention-panel">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>需要你的判断</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason)}</p>
              {visualReviewRequiresRevision && visualReview ? <div className="agent-review-decision">
                <strong>视觉审片建议修改后再审</strong>
                <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
                <div className="agent-review-facts">
                  {visualReview.lowestScores.map((score) => <span key={score.key}>{score.label} <strong>{score.value}</strong></span>)}
                  <span><strong>{visualReview.findingCount}</strong> 项已确认缺陷</span>
                  {visualReview.pendingInspectionCount ? <span><strong>{visualReview.pendingInspectionCount}</strong> 项待补查</span> : null}
                  {visualReview.infoCount ? <span><strong>{visualReview.infoCount}</strong> 项提示</span> : null}
                  <span>模型自评把握程度 <strong>{Math.round(visualReview.confidence * 100)}%</strong></span>
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
              <div className="decision-actions">
                {voiceTiming ? <>
                  <button className="button button-primary" type="button" disabled={decisionPending} onClick={openVoiceTimingDecision}>
                    <RotateCcw aria-hidden="true" size={17} />调整方案
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                </> : visualReviewRequiresRevision ? <>
                  <button className="button button-primary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <RotateCcw aria-hidden="true" size={17} />修改后再审
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
                    <XCircle aria-hidden="true" size={17} />打回
                  </button>
                </>}
              </div>
            </section>
          ) : (
            <section className={`run-state-panel${run.failure ? " has-failure" : ""}`}>
              {run.failure ? <>
                <p className="eyebrow">{sourceAssetFailure ? "制作已安全停止" : `停在 ${run.failure.nodeLabel}`}</p>
                <h2>{sourceAssetFailure ? "画面预检未通过" : `${run.failure.nodeLabel}没有完成`}</h2>
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
                  {(["asset-source-review", "visual-review"].includes(run.failure.nodeId) || /源素材视觉预检/.test(run.failure.technicalDetail ?? "")) && run.failure.technicalDetail
                    ? <p className="run-failure-summary"><strong>失败原因：</strong>{creatorFacingTechnicalText(run.failure.technicalDetail)}</p>
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
              {(run.status === "failed" || run.status === "rejected") && (run.failure?.retryable !== false || run.taskRecovery?.allowedActions.includes("retry_failed_step")) && !hasUncertainPaidOutcome(run) && (!run.taskRecovery || run.taskRecovery.allowedActions.includes("retry_failed_step")) && onRetryFailedNode && retryableNodeId(run) ? <button className="button button-primary" type="button" disabled={nodeMutationPending || hasPendingPlanningConfiguration} onClick={() => void onRetryFailedNode(retryableNodeId(run)!)}><RotateCcw aria-hidden="true" size={16} />{sourceAssetFailure && run.status === "rejected" ? "重新检查已有试片" : run.failure?.nodeId === "visual-review" ? "重试视觉审片" : "重试失败步骤"}</button> : null}
              {(run.status === "failed" || run.status === "rejected") && !hasUncertainPaidOutcome(run) && (!run.taskRecovery || run.taskRecovery.allowedActions.includes("adjust_plan")) && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
              {run.status === "stale" && onRegenerateStale ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRegenerateStale()}><RotateCcw aria-hidden="true" size={16} />{isCostReplan ? "按降本意见重新规划并报价" : "按人工版本继续生成"}</button> : null}
              {run.status === "paused" && onResumePaused ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onResumePaused()}><Play aria-hidden="true" size={16} />继续自动制作</button> : null}
            </section>
          )}

        </aside>
      </div> : null}

      {remainingCreatorNodes.length ? <section className="role-workspaces" aria-labelledby="role-workspaces-title">
        <header className="section-heading"><div><p className="eyebrow">创作内容</p><h2 id="role-workspaces-title">逐项预览与修改</h2><p>这里只呈现会影响作品、并且适合人工调整的内容。路径、版本和运行参数不会占用你的注意力。</p></div><span>{remainingCreatorNodes.length} 项</span></header>
        <div className="node-workspace-list">
          {remainingCreatorNodes.map(renderNodeWorkspace)}
        </div>
      </section> : null}

      {costDetail ? <RunCostDetailPanel detail={costDetail} providers={providers} /> : null}

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
              <div><p className="eyebrow">需要修改</p><h2 id="reject-title">打回这条视频</h2></div>
              <button className="icon-button" type="button" onClick={closeRejectDecision} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <label className="field field-wide">
              <span>打回原因</span>
              <textarea value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="说明具体画面、节奏或内容问题" rows={4} data-dialog-initial-focus />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeRejectDecision}>取消</button>
              <button
                className="button button-danger"
                type="button"
                disabled={!rejectNote.trim() || decisionPending || !decisionSnapshot}
                  onClick={() => decisionSnapshot && void onDecision({ action: "reject", note: rejectNote.trim(), ...decisionSnapshot })}
              >
                <RotateCcw aria-hidden="true" size={17} />确认打回
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {approving ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={approveDialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="approve-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">最终决定</p><h2 id="approve-title">{reviewItems.length > 0 ? "逐条表态后批准成片" : "确认批准成片"}</h2></div>
              <button className="icon-button" type="button" onClick={closeApproveDecision} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <div className="decision-dialog-copy"><Check aria-hidden="true" size={22} /><p><strong>{reviewItems.length > 0
              ? `审片提出 ${reviewItems.length} 条结论，请逐条看过并表态。`
              : "批准后将生成发布包。"}</strong><span>这会结束人工终审；请确认已经完整观看画面、字幕并听过声音。</span></p></div>
            {/* 逐条表态管的是审片结论。机器质检是判过或不过的闸门——它不通过时流程走不到终审，
                所以这里没有它的条目，操作员不必怀疑自己漏签了什么。 */}
            <p className="review-disposition-note">技术质检不适用逐条表态：它由机器判定通过或不过，没过就到不了这一步，不在这里逐条签。</p>
            {reviewItems.length > 0 ? <div className="review-disposition-list">
              <p className="review-disposition-guide">采纳=你要按这条结论返修，本轮就不能批准；不采纳=你看过并认为可以维持现状，需要写明理由留痕。</p>
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
              <button className="button button-ghost" type="button" onClick={closeApproveDecision} disabled={decisionPending}>再看一遍</button>
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
                        : { itemKey: item.itemKey!, decision: "reject" as const, reason: choice.reason.trim() };
                    }),
                  } : {}),
                })}
              ><Check aria-hidden="true" size={17} />{decisionPending ? "正在批准..." : reviewItems.length > 0 ? "逐条表态已完成，生成发布包" : "确认批准并生成发布包"}</button>
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
        : "系统没有拿到足够的配音调用与计费结果，因此没有自动重放。"} 点击下方按钮会依次执行两项操作：先把上一笔配音按原预估费用计入已记录费用，再创建一条新的配音任务继续制作；不点击就不会记录费用，也不会重试。</p>
      {onReconcile ? <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void onReconcile(summary.nodeId, {
          outcome: "confirmed_charged",
          note: "自动配音提交后连接中断，结果无法确认；按原预估费用保守记账并创建新的配音任务。",
        })}
      ><RotateCcw aria-hidden="true" size={16} />按预估记账并重新配音</button> : null}
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
        <small>系统动作：只继续查询原任务，不会创建新任务，也不会产生新费用。</small>
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
  const confidence = typeof report.confidence === "number" && Number.isFinite(report.confidence)
    ? Math.min(1, Math.max(0, report.confidence))
    : 0;
  const scores = isRecord(report.scores) ? Object.entries(report.scores)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([key, value]) => ({ key, label: VISUAL_SCORE_LABELS[key] ?? key, value }))
    .sort((left, right) => left.value - right.value)
    .slice(0, 2) : [];
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
  const independentReviews = Array.isArray(report.independentReviews)
    ? report.independentReviews.flatMap((value): VisualReviewBranch[] => {
        if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.modelId !== "string" || !isRecord(value.report)) return [];
        const branch = value.report;
        if (branch.recommendation !== "approve" && branch.recommendation !== "revise" && branch.recommendation !== "reject") return [];
        const branchScores = isRecord(branch.scores)
          ? Object.values(branch.scores).filter((score): score is number => typeof score === "number" && Number.isFinite(score))
          : [];
        return [{
          providerId: value.providerId,
          modelId: value.modelId,
          recommendation: branch.recommendation,
          summary: typeof branch.summary === "string" && branch.summary.trim() ? branch.summary.trim() : "该模型没有提供审片摘要。",
          ...(branchScores.length ? { score: Math.round(branchScores.reduce((sum, score) => sum + score, 0) / branchScores.length) } : {}),
          findingCount: Array.isArray(branch.findings) ? branch.findings.filter((finding) => (
            isRecord(finding) && finding.evidenceStatus === "failed" && finding.severity !== "info"
          )).length : 0,
        }];
      })
    : [];
  return {
    recommendation: report.recommendation,
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

function SceneRevisionFinding({ finding, busy, onSeek, onSubmit, onLoadNarration, onSubmitNarration }: {
  finding: VisualReviewFinding;
  busy: boolean;
  onSeek: () => void;
  onSubmit: (input: Pick<StudioSceneRevisionInput, "reuseFromScenePosition" | "note">) => Promise<void>;
  onLoadNarration?: (scenePosition: number) => Promise<string>;
  onSubmitNarration?: (input: Pick<StudioNarrationRevisionInput, "scenePosition" | "narration" | "note">) => Promise<void>;
}) {
  const [sourcePosition, setSourcePosition] = useState("");
  const [note, setNote] = useState("");
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
  return <section className="production-progress" aria-label="制作进度" data-tour="run-workflow">
    <header>
      <div><p className="eyebrow">制作进度</p><strong>{run.progress.completedNodes} / {run.progress.totalNodes} 个步骤完成</strong></div>
      <span>{run.progress.percentage}%</span>
    </header>
    <div className="production-progress-bar" aria-hidden="true"><span style={{ width: `${run.progress.percentage}%` }} /></div>
    <div className="production-phases">
      {run.phases.map((phase, index) => <article className={`production-phase is-${phase.status}`} key={phase.id}>
        <span className="production-phase-index">{phase.status === "completed" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
        <div><strong>{phase.label}</strong><small>{phase.completedNodes}/{phase.totalNodes} 步骤</small></div>
      </article>)}
    </div>
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
  return current ? `${current.role ?? "制作角色"}正在处理${current.label}` : "系统正在推进制作";
}

function activeNodeModel(run: StudioRunDetail, providers: StudioProvider[]): string | undefined {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.status === "running");
  const execution = current?.executionReceipt ?? current?.plannedExecution;
  if (!execution) return undefined;
  return `${execution.providerLabel} · ${catalogModelLabel(providers, execution.modelId) ?? "模型名称未记录"}`;
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
      return humanDecision.note ?? "成片已被人工打回，审片意见已保留。请回到今日机会重新发起制作。";
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

function safeRunError(message?: string): string {
  if (!message) return "制作失败，请检查对应能力和本地运行环境。";
  if (message.includes("应用重启")) return message;
  if (/\/(Users|home|private|tmp)\//.test(message) || /^[A-Za-z].*(failed|error|invalid|missing)/i.test(message)) {
    return "这一步执行失败。技术细节已保留在本地服务日志中，请检查对应能力后重试。";
  }
  return message;
}
