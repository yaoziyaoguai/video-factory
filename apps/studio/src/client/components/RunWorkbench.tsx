import { Activity, AlertTriangle, Check, Clock3, Download, Pause, Play, RotateCcw, Send, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StudioCostRunDetail, StudioDecisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProvider, StudioRunDetail, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { StatusBadge } from "./StatusBadge.js";
import { platformLabel, providerLabel, providerModelLabel } from "../presentation.js";
import { NodeWorkspace } from "./NodeWorkspace.js";
import { RunCostDetailPanel } from "./CostDashboard.js";

interface RunWorkbenchProps {
  run: StudioRunDetail;
  providers?: StudioProvider[];
  decisionPending: boolean;
  onDecision: (input: StudioDecisionInput) => Promise<void>;
  onRequestSceneRevision?: (input: StudioSceneRevisionInput) => Promise<void>;
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
  onRetryFailedNode?: (nodeId: string) => Promise<void>;
  paidNodeSummary?: StudioPaidNodeSummary;
  onReconcilePaidNode?: (nodeId: string, input: StudioPaidReconciliationDraft) => Promise<void>;
  connectionHeartbeatAt?: string;
}

export function RunWorkbench({ run, providers = [], decisionPending, onDecision, onRequestSceneRevision, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, pausePending = false, onOverrideNode, onOverrideNodeInput, onConfigureNode, onAuthorizeSpend, onRejectSpend, onRegenerateStale, onRequestPause, onResumePaused, onRetryFailedNode, paidNodeSummary, onReconcilePaidNode, connectionHeartbeatAt }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [approvalOverrideNote, setApprovalOverrideNote] = useState("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const rejectDialogRef = useDialogFocus<HTMLElement>(rejecting, () => setRejecting(false), decisionPending);
  const approveDialogRef = useDialogFocus<HTMLElement>(approving, () => setApproving(false), decisionPending);
  const video = run.artifacts.find((artifact) => artifact.id === run.videoArtifactId);
  const creatorNodes = run.nodes.filter((node) => nodeHasCreatorContent(node, run));
  const activeSpendNode = creatorNodes.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
  const remainingCreatorNodes = creatorNodes.filter((node) => node.id !== activeSpendNode?.id);
  const showReviewSurface = Boolean(video?.contentUrl || run.activeIntervention || isStoppedStatus(run.status));
  const uncertainPaidNode = run.nodes.find((node) => node.outcomeUncertain === true);
  const visiblePaidNodeSummary = paidNodeSummary?.nodeId === uncertainPaidNode?.id ? paidNodeSummary : undefined;
  const visualReview = visualReviewDecision(run);
  const visualReviewRequiresRevision = visualReview?.recommendation === "revise" || visualReview?.recommendation === "reject";
  const assetVersionId = run.nodes.find((node) => node.id === "assets")?.outputState?.effectiveVersionId;
  const isCostReplan = run.status === "stale" && hasDirectorCostFeedback(run);

  const renderNodeWorkspace = (node: StudioRunDetail["nodes"][number]) => <NodeWorkspace
    key={node.id}
    node={node}
    nodes={run.nodes}
    providers={providers}
    runStatus={run.status}
    artifacts={run.artifacts.filter((artifact) => node.artifactIds.includes(artifact.id) || artifact.producerNodeId === node.id)}
    busy={nodeMutationPending}
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
      setApprovalOverrideNote("");
    }
  }, [run.activeIntervention]);

  return (
    <main className="page run-page">
      <header className="run-header" data-tour="run-header">
        <div>
          <p className="eyebrow">{platformLabel(run.platform)} · 目标 {run.durationSeconds} 秒 · 版本 {run.revision}</p>
          <h1>{run.title}</h1>
          <p className="page-summary">{run.angle} · {run.audience}</p>
        </div>
        <StatusBadge status={run.status} />
      </header>

      {run.phases && run.progress ? <ProductionProgress run={run} /> : (
        <section className="workflow-track" aria-label="生产工作流" data-tour="run-workflow">
          {run.nodes.map((node, index) => (
            <div className={`workflow-node node-${node.status}`} key={node.id}>
              <span className="node-index">{node.status === "succeeded" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
              <span>{node.role ? `${node.role} · ${node.label}` : node.label}</span>
            </div>
          ))}
        </section>
      )}

      {activeSpendNode ? <section className="current-production-action" aria-labelledby="current-production-action-title">
        <header>
          <div><p className="eyebrow">当前需要处理</p><h2 id="current-production-action-title">现在需要你：确认{activeSpendNode.label}</h2></div>
          <StatusBadge status={run.status} />
        </header>
        <p>{activeSpendNode.role ?? "当前角色"}完成后，系统会继续推进后续步骤。请先检查它收到的内容、实际使用的模型和本次报价。</p>
        {renderNodeWorkspace(activeSpendNode)}
      </section> : !showReviewSurface ? <section className="current-production-action is-running" aria-live="polite">
        <header><div><p className="eyebrow">自动制作中</p><h2>{runningNodeLabel(run)}</h2></div><StatusBadge status={run.status} /></header>
        <p>{run.currentAction?.label ?? runStateMessage(run)}</p>
        {run.progress ? <div className="run-live-metrics">
          <span><Activity aria-hidden="true" size={15} /><strong>{run.progress.completedNodes} / {run.progress.totalNodes}</strong> 个步骤完成</span>
          <span><Clock3 aria-hidden="true" size={15} />{run.progress.currentNodeElapsedSeconds !== undefined ? "当前步骤" : "累计处理"} <strong>{formatDuration(run.progress.currentNodeElapsedSeconds ?? run.progress.elapsedSeconds)}</strong></span>
          <span>{etaLabel(run.progress)}</span>
          <span>制作状态更新于 {formatClock(run.progress.lastUpdatedAt)}</span>
          {costDetail ? <span>成本 <strong>¥{costDetail.totals.actualCostCny.toFixed(2)}</strong>{costDetail.totals.actualPendingCount ? ` · ${costDetail.totals.actualPendingCount} 笔待回写` : ""}</span> : null}
          {connectionHeartbeatAt ? <span className="run-connection-live"><i aria-hidden="true" />制作服务连接刚刚确认</span> : null}
        </div> : null}
        {activeNodeModel(run) ? <p className="run-active-provider">当前能力：{activeNodeModel(run)}</p> : null}
        {onRequestPause ? <button className="button button-ghost run-pause-button" type="button" disabled={pausePending || run.pauseRequested === true} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{run.pauseRequested ? "当前步骤完成后暂停" : "暂停后检查或修改"}</button> : null}
      </section> : null}

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
          {run.activeIntervention ? (
            <section className="intervention-panel">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>需要你的判断</h2>
              </div>
              <p>{run.activeIntervention.reason}</p>
              {visualReviewRequiresRevision && visualReview ? <div className="agent-review-decision">
                <strong>视觉审片建议修改后再审</strong>
                <p>{visualReview.summary}</p>
                <div className="agent-review-facts">
                  {visualReview.lowestScores.map((score) => <span key={score.key}>{score.label} <strong>{score.value}</strong></span>)}
                  <span><strong>{visualReview.findingCount}</strong> 项问题</span>
                  <span>置信度 <strong>{Math.round(visualReview.confidence * 100)}%</strong></span>
                </div>
                {onRequestSceneRevision && assetVersionId && visualReview.reviewArtifactId
                  ? <div className="scene-revision-list">
                    {visualReview.findings.map((finding, index) => <SceneRevisionFinding
                      key={`${finding.timecodeMs}:${index}`}
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
                        findingIndex: index,
                        ...input,
                      })}
                    />)}
                  </div>
                  : null}
                <p className="agent-review-guidance">打回会保留本轮产物；随后可按建议调整方案并重新制作。批准则会覆盖视觉审片建议并生成发布包。</p>
              </div> : null}
              <div className="decision-actions">
                {visualReviewRequiresRevision ? <>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => setRejecting(true)}>
                    <RotateCcw aria-hidden="true" size={17} />按审片建议打回
                  </button>
                  <button className="button button-primary" type="button" disabled={decisionPending} onClick={() => setApproving(true)}>
                    <Check aria-hidden="true" size={17} />仍要批准
                  </button>
                </> : <>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={decisionPending}
                    onClick={() => setApproving(true)}
                  >
                    <Check aria-hidden="true" size={17} />批准进入发布包
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => setRejecting(true)}>
                    <XCircle aria-hidden="true" size={17} />打回
                  </button>
                </>}
              </div>
            </section>
          ) : (
            <section className={`run-state-panel${run.failure ? " has-failure" : ""}`}>
              {run.failure ? <>
                <p className="eyebrow">停在 {run.failure.nodeLabel}</p>
                <h2>{run.failure.nodeLabel}没有完成</h2>
                <p className="run-failure-summary">{run.failure.summary}</p>
                <div className="run-failure-impact">
                  <strong>{run.resultAvailability?.label ?? "前序结果已保留"}</strong>
                  <span>{run.failure.impact}</span>
                </div>
                <p className="run-saved-work">已保留前面 {run.failure.savedNodeCount} 个步骤的结果</p>
                <ul className="run-recovery-list">
                  {run.failure.recoveryActions.map((action) => <li key={action}>{action}</li>)}
                </ul>
                {run.failure.technicalDetail ? <details className="run-technical-diagnosis"><summary>技术诊断</summary><code>{run.failure.technicalDetail}</code></details> : null}
              </> : <>
                <h2>当前状态</h2>
                <p>{runStateMessage(run)}</p>
              </>}
              {visiblePaidNodeSummary ? <PaidOperationPanel
                summary={visiblePaidNodeSummary}
                providers={providers}
                busy={nodeMutationPending}
                {...(onReconcilePaidNode ? { onReconcile: onReconcilePaidNode } : {})}
              /> : null}
              {run.status === "succeeded" && onOpenPublish ? <button className="button button-primary" type="button" onClick={onOpenPublish}><Send aria-hidden="true" size={16} />多平台发布</button> : null}
              {run.status === "failed" && run.failure?.retryable !== false && !hasUncertainPaidOutcome(run) && onRetryFailedNode && failedNodeId(run) ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRetryFailedNode(failedNodeId(run)!)}><RotateCcw aria-hidden="true" size={16} />重试失败步骤</button> : null}
              {(run.status === "failed" || run.status === "rejected") && !hasUncertainPaidOutcome(run) && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
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

      {costDetail ? <RunCostDetailPanel detail={costDetail} /> : null}

      {rejecting ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={rejectDialogRef} className="reject-dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">需要修改</p><h2 id="reject-title">打回这条视频</h2></div>
              <button className="icon-button" type="button" onClick={() => setRejecting(false)} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <label className="field field-wide">
              <span>打回原因</span>
              <textarea value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="说明具体画面、节奏或内容问题" rows={4} data-dialog-initial-focus />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={() => setRejecting(false)}>取消</button>
              <button
                className="button button-danger"
                type="button"
                disabled={!rejectNote.trim() || decisionPending}
                  onClick={() => void onDecision({ action: "reject", note: rejectNote.trim() })}
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
              <div><p className="eyebrow">最终决定</p><h2 id="approve-title">{visualReviewRequiresRevision ? "确认覆盖审片建议" : "确认批准成片"}</h2></div>
              <button className="icon-button" type="button" onClick={() => setApproving(false)} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <div className="decision-dialog-copy"><Check aria-hidden="true" size={22} /><p><strong>{visualReviewRequiresRevision ? "视觉审片建议先修改；继续批准属于人工覆盖。" : "批准后将生成发布包。"}</strong><span>这会结束人工终审；请确认已经完整观看画面、字幕并听过声音。</span></p></div>
            {visualReviewRequiresRevision ? <label className="field field-wide decision-override-field">
              <span>覆盖原因</span>
              <textarea value={approvalOverrideNote} onChange={(event) => setApprovalOverrideNote(event.target.value)} placeholder="说明为何当前版本仍可发布" rows={3} data-dialog-initial-focus />
            </label> : null}
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={() => setApproving(false)} disabled={decisionPending}>再看一遍</button>
              <button
                className="button button-primary"
                type="button"
                disabled={decisionPending || (visualReviewRequiresRevision && !approvalOverrideNote.trim())}
                onClick={() => void onDecision({
                  action: "approve",
                  ...(visualReviewRequiresRevision ? { note: `覆盖视觉审片建议：${approvalOverrideNote.trim()}` } : {}),
                })}
              ><Check aria-hidden="true" size={17} />{decisionPending ? "正在批准..." : visualReviewRequiresRevision ? "确认覆盖建议并生成发布包" : "确认批准并生成发布包"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function PaidOperationPanel({ summary, providers, busy, onReconcile }: {
  summary: StudioPaidNodeSummary;
  providers: StudioProvider[];
  busy: boolean;
  onReconcile?: (nodeId: string, input: StudioPaidReconciliationDraft) => Promise<void>;
}) {
  const [taskId, setTaskId] = useState("");
  const [manualOutcome, setManualOutcome] = useState<"confirmed_not_charged" | "confirmed_charged">();
  const [note, setNote] = useState("");
  const [actualCost, setActualCost] = useState("");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const outcome = summary.recommendedOutcome === "resume_original" || summary.recommendedOutcome === "requote"
    ? summary.recommendedOutcome
    : undefined;
  const missingTaskItems = summary.items.filter((item) => (
    (item.state === "submitted" || item.state === "unknown") && !item.taskId
  ));
  const canAttachTaskId = missingTaskItems.length === 1;
  const parsedActualCost = actualCost.trim() ? Number(actualCost) : undefined;
  const actualCostValid = parsedActualCost === undefined || (Number.isFinite(parsedActualCost) && parsedActualCost >= 0);
  const isRunLevelVoiceCall = summary.nodeId === "voice" && summary.items.length === 0;
  if (isRunLevelVoiceCall && summary.requiresManualReconciliation && summary.failureKind === "terminal_failure") {
    return <section className="paid-operation-panel requires-manual" aria-label="配音恢复">
      <header><strong>配音请求被明确拒绝</strong><small>本次不记账</small></header>
      <p>服务商已经返回明确错误，不属于扣费结果未知。请先在下方修改音色、模型或服务配置，再以零费用结清本次失败并重新配音。</p>
      {onReconcile ? <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void onReconcile(summary.nodeId, {
          outcome: "confirmed_not_charged",
          note: "配音服务商明确拒绝本次请求；按零费用结清后，使用当前修正后的配置重新配音。",
        })}
      ><RotateCcw aria-hidden="true" size={16} />不记账并重新配音</button> : null}
    </section>;
  }
  if (isRunLevelVoiceCall && summary.requiresManualReconciliation && summary.failureKind === "unknown_outcome") {
    return <section className="paid-operation-panel requires-manual" aria-label="配音恢复">
      <header><strong>配音连接中断</strong><small>自动记账</small></header>
      <p>请求提交后连接中断，系统无法确认服务商是否已经计费，因此没有自动重放。为避免重复调用，本次会按原预估费用保守记账，再生成一条新的配音任务。</p>
      {onReconcile ? <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void onReconcile(summary.nodeId, {
          outcome: "confirmed_charged",
          note: "自动配音提交后连接中断，结果无法确认；按原预估费用保守记账并创建新的配音任务。",
        })}
      ><RotateCcw aria-hidden="true" size={16} />重新配音</button> : null}
    </section>;
  }
  const title = summary.requiresManualReconciliation
    ? "需要人工核对账单"
    : outcome === "requote"
      ? "需要重新报价"
      : "原付费任务可继续核对";
  return <section className={`paid-operation-panel${summary.requiresManualReconciliation ? " requires-manual" : ""}`} aria-label="付费任务证据">
    <header><strong>{title}</strong><small>{isRunLevelVoiceCall ? "一次配音调用" : `${summary.items.length} 个镜头`}</small></header>
    <div className="paid-operation-items">
      {summary.items.map((item) => <article key={`${item.operationId}:${item.itemRequestId}`}>
        <header><strong>镜头 {item.scenePosition}</strong><span>{paidOperationStateLabel(item.state)}</span></header>
        <p>{paidProviderIdentity(providers, item.providerId, item.modelId)}</p>
        {item.taskId ? <code>服务商任务编号：{item.taskId}</code> : <small>尚无服务商任务编号</small>}
        <small>{paidOperationCostLabel(item)}</small>
      </article>)}
    </div>
    {summary.requiresManualReconciliation
      ? <p>{isRunLevelVoiceCall
        ? "系统不会自动重试。请在配音服务商控制台按本次调用记录与账单核对，再登记核对结果。"
        : "系统不会自动重试。请到服务商控制台按任务编号核对任务与账单，再登记核对结果。"}</p>
      : outcome === "requote" ? <p>只会为明确失败或尚未执行的镜头生成新报价；已完成和待核对镜头不会再次创建任务。</p> : <p>继续查询并下载原服务商任务，不会创建新任务或新增报价。</p>}
    {summary.requiresManualReconciliation && onReconcile ? <div className="paid-reconciliation-controls">
      {canAttachTaskId ? <div className="paid-task-id-control">
        <label className="field field-wide">
          <span>服务商任务编号</span>
          <input value={taskId} onChange={(event) => setTaskId(event.target.value)} maxLength={256} placeholder="从服务商控制台复制" />
        </label>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy || !taskId.trim()}
          onClick={() => void onReconcile(summary.nodeId, { outcome: "resume_original", taskId: taskId.trim() })}
        ><Activity aria-hidden="true" size={16} />录入编号并核对原任务</button>
      </div> : null}
      <fieldset className="paid-manual-resolution" disabled={busy}>
        <legend>服务商账单核对结果</legend>
        <div className="paid-manual-options">
          <label><input type="radio" name={`paid-outcome-${summary.nodeId}`} checked={manualOutcome === "confirmed_not_charged"} onChange={() => setManualOutcome("confirmed_not_charged")} />未扣费</label>
          <label><input type="radio" name={`paid-outcome-${summary.nodeId}`} checked={manualOutcome === "confirmed_charged"} onChange={() => setManualOutcome("confirmed_charged")} />已扣费</label>
        </div>
        {manualOutcome === "confirmed_charged" ? <label className="field field-wide">
          <span>实际费用（可选）</span>
          <input type="number" min="0" step="0.01" value={actualCost} onChange={(event) => setActualCost(event.target.value)} placeholder="留空则登记原预估费用" />
        </label> : null}
        <label className="field field-wide">
          <span>核对记录</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} rows={3} placeholder="写明在服务商控制台核对到的任务和账单证据" />
        </label>
        <label className="paid-manual-confirmation"><input type="checkbox" checked={manualConfirmed} onChange={(event) => setManualConfirmed(event.target.checked)} />我确认已在服务商控制台核对任务与账单；系统会保存这次核对记录。</label>
        <button
          className={`button ${manualOutcome === "confirmed_charged" ? "button-danger" : "button-primary"}`}
          type="button"
          disabled={!manualOutcome || !note.trim() || !manualConfirmed || !actualCostValid}
          onClick={() => {
            if (!manualOutcome) return;
            void onReconcile(summary.nodeId, {
              outcome: manualOutcome,
              note: note.trim(),
              ...(manualOutcome === "confirmed_charged" && parsedActualCost !== undefined
                ? { actualCostCny: parsedActualCost }
                : {}),
            });
          }}
        >{manualOutcome === "confirmed_charged" ? "确认已扣费并登记" : "确认未扣费并继续处理"}</button>
      </fieldset>
    </div> : null}
    {!summary.requiresManualReconciliation && outcome && onReconcile ? <button
      className="button button-primary"
      type="button"
      disabled={busy}
      onClick={() => void onReconcile(summary.nodeId, { outcome })}
    >{outcome === "requote" ? <><RotateCcw aria-hidden="true" size={16} />为未完成镜头重新报价</> : <><Activity aria-hidden="true" size={16} />核对付费任务</>}</button> : null}
  </section>;
}

type StudioPaidReconciliationDraft = Omit<StudioPaidReconciliationInput, "expectedRunRevision" | "reconciliationId">;

function paidProviderName(providerId: string): string {
  return (providerLabel(providerId) ?? "画面服务").replace(/ (?:视频|图片)生成$/, "");
}

function paidProviderIdentity(providers: StudioProvider[], providerId: string, modelId: string): string {
  const providerName = paidProviderName(providerId);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (modelId === providerId) return providerName;
  const modelName = providerModelLabel(provider, modelId);
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
  if (item.actualCostCny !== undefined) return `已计费 ¥${item.actualCostCny.toFixed(2)}`;
  if (item.state === "prepared" || item.state === "terminal_failed") return `未计费 · 预估 ¥${item.estimatedCostCny.toFixed(2)}`;
  if (item.state === "materialized") return "已完成 · 费用待回写";
  return `待确认 · 预估 ¥${item.estimatedCostCny.toFixed(2)}`;
}

interface VisualReviewDecision {
  recommendation: "approve" | "revise" | "reject";
  confidence: number;
  summary: string;
  findingCount: number;
  findings: VisualReviewFinding[];
  reviewArtifactId?: string;
  lowestScores: Array<{ key: string; label: string; value: number }>;
}

interface VisualReviewFinding {
  timecodeMs: number;
  scenePosition?: number;
  category: string;
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
  const findings = Array.isArray(report.findings) ? report.findings.flatMap((value): VisualReviewFinding[] => {
    if (!isRecord(value) || !Number.isInteger(value.timecodeMs) || Number(value.timecodeMs) < 0) return [];
    const scenePosition = Number(value.scenePosition);
    return [{
      timecodeMs: Number(value.timecodeMs),
      ...(Number.isInteger(scenePosition) && scenePosition > 0 ? { scenePosition } : {}),
      category: typeof value.category === "string" ? value.category : "other",
      description: typeof value.description === "string" ? value.description : "未提供问题说明。",
      suggestion: typeof value.suggestion === "string" ? value.suggestion : "请人工检查此处画面。",
    }];
  }) : [];
  const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
  const reviewArtifactId = effectiveVersion?.artifactIds.find((artifactId) => (
    run.artifacts.some((artifact) => artifact.id === artifactId && artifact.kind === "review_report" && artifact.producerNodeId === "visual-review")
  ));
  return {
    recommendation: report.recommendation,
    confidence,
    summary: typeof report.summary === "string" && report.summary.trim() ? report.summary.trim() : "视觉审片发现需要人工确认的问题。",
    findingCount: findings.length,
    findings,
    ...(reviewArtifactId ? { reviewArtifactId } : {}),
    lowestScores: scores,
  };
}

function SceneRevisionFinding({ finding, busy, onSeek, onSubmit }: {
  finding: VisualReviewFinding;
  busy: boolean;
  onSeek: () => void;
  onSubmit: (input: Pick<StudioSceneRevisionInput, "reuseFromScenePosition" | "note">) => Promise<void>;
}) {
  const [sourcePosition, setSourcePosition] = useState("");
  const [note, setNote] = useState("");
  const sourceOptions = finding.scenePosition
    ? Array.from({ length: Math.max(0, finding.scenePosition - 1) }, (_, index) => index + 1)
    : [];
  const seconds = Math.floor(finding.timecodeMs / 1_000);
  const timecode = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <article className="scene-revision-finding">
    <button className="scene-finding-seek" type="button" onClick={onSeek}>
      {finding.scenePosition ? `镜头 ${finding.scenePosition}` : "未定位镜头"} · {timecode}
    </button>
    <p>{finding.description}</p>
    <small>{finding.suggestion}</small>
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

function failedNodeId(run: StudioRunDetail): string | undefined {
  return run.nodes.find((node) => node.status === "failed")?.id;
}

function hasUncertainPaidOutcome(run: StudioRunDetail): boolean {
  return run.nodes.some((node) => node.outcomeUncertain === true);
}

function runningNodeLabel(run: StudioRunDetail): string {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.id === run.currentNodeId)
    ?? run.nodes.find((node) => node.status === "running")
    ?? run.nodes.find((node) => node.status === "pending");
  if (current?.id === "script") {
    const providerId = (current.executionReceipt ?? current.plannedExecution)?.providerId;
    return providerId === "codex-screenwriter-v1"
      ? "编剧与独立质量审计正在修改脚本"
      : "编剧正在生成结构化脚本";
  }
  return current ? `${current.role ?? "制作角色"}正在处理${current.label}` : "系统正在推进制作";
}

function activeNodeModel(run: StudioRunDetail): string | undefined {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.status === "running");
  const execution = current?.executionReceipt ?? current?.plannedExecution;
  return execution ? `${execution.providerLabel} · ${execution.modelId}` : undefined;
}

function etaLabel(progress: NonNullable<StudioRunDetail["progress"]>): string {
  if (progress.eta) return `预计还需 ${formatDuration(progress.eta.lowSeconds)}–${formatDuration(progress.eta.highSeconds)}`;
  if (progress.etaUnavailableReason === "waiting_for_human") return "等待你的确认，不计算 ETA";
  if (progress.etaUnavailableReason === "future_human_gate") return "后续有人工或费用确认，暂不估算整条耗时";
  if (progress.etaUnavailableReason === "insufficient_history") return "历史样本不足，暂不提供虚假 ETA";
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
    return run.nodes.find((node) => node.status === "rejected")?.error
      ?? "成片未通过机器质检，请查看质检报告后重新发起制作。";
  }
  if (run.status === "failed") {
    if (hasUncertainPaidOutcome(run)) {
      return "付费服务可能已经受理请求，但结果尚未确认。系统已停止重试和重新制作，请先到服务商控制台核对任务与账单。";
    }
    return safeRunError(run.nodes.find((node) => node.status === "failed")?.error);
  }
  if (run.status === "awaiting_spend_approval") return "即将生成付费图片或视频，请先检查前面的内容、模型和本次报价。";
  if (run.status === "approval_invalidated") return "输入、模型、报价或重试次数发生了变化，之前的费用确认已失效，请重新检查。";
  if (run.status === "stale" && hasDirectorCostFeedback(run)) {
    return "你已把上一份画面报价退回导演，降本意见已经保存。继续后会先调整方案，再给你一份新报价。";
  }
  if (run.status === "stale") return "上游内容已被人工修改，后续旧结果不会继续使用，需要重新生成。";
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
