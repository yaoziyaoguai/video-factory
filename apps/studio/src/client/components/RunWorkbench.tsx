import { Activity, AlertTriangle, Check, Clock3, Download, RotateCcw, Send, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { StudioCostRunDetail, StudioDecisionInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioRunDetail, StudioSpendAuthorizationInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { StatusBadge } from "./StatusBadge.js";
import { platformLabel } from "../presentation.js";
import { NodeWorkspace } from "./NodeWorkspace.js";
import { RunCostDetailPanel } from "./CostDashboard.js";

interface RunWorkbenchProps {
  run: StudioRunDetail;
  decisionPending: boolean;
  onDecision: (input: StudioDecisionInput) => Promise<void>;
  onOpenPublish?: () => void;
  onRestart?: () => void;
  costDetail?: StudioCostRunDetail;
  nodeMutationPending?: boolean;
  onOverrideNode?: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onOverrideNodeInput?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onAuthorizeSpend?: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRegenerateStale?: () => Promise<void>;
  onRetryFailedNode?: (nodeId: string) => Promise<void>;
  connectionHeartbeatAt?: string;
}

export function RunWorkbench({ run, decisionPending, onDecision, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, onOverrideNode, onOverrideNodeInput, onAuthorizeSpend, onRegenerateStale, onRetryFailedNode, connectionHeartbeatAt }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const rejectDialogRef = useDialogFocus<HTMLElement>(rejecting, () => setRejecting(false), decisionPending);
  const approveDialogRef = useDialogFocus<HTMLElement>(approving, () => setApproving(false), decisionPending);
  const video = run.artifacts.find((artifact) => artifact.id === run.videoArtifactId);
  const creatorNodes = run.nodes.filter((node) => nodeHasCreatorContent(node, run));
  const activeSpendNode = creatorNodes.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
  const remainingCreatorNodes = creatorNodes.filter((node) => node.id !== activeSpendNode?.id);
  const showReviewSurface = Boolean(video?.contentUrl || run.activeIntervention || isStoppedStatus(run.status));

  const renderNodeWorkspace = (node: StudioRunDetail["nodes"][number]) => <NodeWorkspace
    key={node.id}
    node={node}
    nodes={run.nodes}
    runStatus={run.status}
    artifacts={run.artifacts.filter((artifact) => node.artifactIds.includes(artifact.id))}
    busy={nodeMutationPending}
    onOverride={onOverrideNode ?? (async () => undefined)}
    onInputOverride={onOverrideNodeInput ?? (async () => undefined)}
    onAuthorize={onAuthorizeSpend ?? (async () => undefined)}
  />;

  useEffect(() => {
    if (!run.activeIntervention) {
      setApproving(false);
      setRejecting(false);
      setRejectNote("");
    }
  }, [run.activeIntervention]);

  return (
    <main className="page run-page">
      <header className="run-header" data-tour="run-header">
        <div>
          <p className="eyebrow">{platformLabel(run.platform)} · {run.durationSeconds} 秒 · 版本 {run.revision}</p>
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
        <p>{activeSpendNode.role ?? "当前角色"}完成后，系统会继续推进后续节点。请先检查它收到的内容、实际使用的模型和费用上限。</p>
        {renderNodeWorkspace(activeSpendNode)}
      </section> : !showReviewSurface ? <section className="current-production-action is-running" aria-live="polite">
        <header><div><p className="eyebrow">自动制作中</p><h2>{runningNodeLabel(run)}</h2></div><StatusBadge status={run.status} /></header>
        <p>{run.currentAction?.label ?? runStateMessage(run)}</p>
        {run.progress ? <div className="run-live-metrics">
          <span><Activity aria-hidden="true" size={15} /><strong>{run.progress.completedNodes} / {run.progress.totalNodes}</strong> 个节点完成</span>
          <span><Clock3 aria-hidden="true" size={15} />已运行 <strong>{formatDuration(run.progress.elapsedSeconds)}</strong></span>
          <span>{etaLabel(run.progress)}</span>
          <span>节点状态更新于 {formatClock(run.progress.lastUpdatedAt)}</span>
          {costDetail ? <span>成本 <strong>¥{costDetail.totals.actualCostCny.toFixed(2)}</strong>{costDetail.totals.actualPendingCount ? ` · ${costDetail.totals.actualPendingCount} 笔待回写` : ""}</span> : null}
          {connectionHeartbeatAt ? <span className="run-connection-live"><i aria-hidden="true" />云端连接刚刚确认</span> : null}
        </div> : null}
        {activeNodeModel(run) ? <p className="run-active-provider">当前能力：{activeNodeModel(run)}</p> : null}
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
              <video title="成片预览" src={`${video.contentUrl}#t=0.1`} controls playsInline preload="auto" />
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
              <div className="decision-actions">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={decisionPending}
                  onClick={() => setApproving(true)}
                >
                  <Check aria-hidden="true" size={17} />批准进入发布包
                </button>
                <button className="button button-danger-ghost" type="button" disabled={decisionPending} onClick={() => setRejecting(true)}>
                  <XCircle aria-hidden="true" size={17} />打回
                </button>
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
                <p className="run-saved-work">已保留 {run.failure.savedNodeCount} 个前序节点</p>
                <ul className="run-recovery-list">
                  {run.failure.recoveryActions.map((action) => <li key={action}>{action}</li>)}
                </ul>
                {run.failure.technicalDetail ? <details className="run-technical-diagnosis"><summary>技术诊断</summary><code>{run.failure.technicalDetail}</code></details> : null}
              </> : <>
                <h2>当前状态</h2>
                <p>{runStateMessage(run)}</p>
              </>}
              {run.status === "succeeded" && onOpenPublish ? <button className="button button-primary" type="button" onClick={onOpenPublish}><Send aria-hidden="true" size={16} />多平台发布</button> : null}
              {run.status === "failed" && run.failure?.retryable !== false && !hasUncertainPaidOutcome(run) && onRetryFailedNode && failedNodeId(run) ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRetryFailedNode(failedNodeId(run)!)}><RotateCcw aria-hidden="true" size={16} />重试失败步骤</button> : null}
              {(run.status === "failed" || run.status === "rejected") && !hasUncertainPaidOutcome(run) && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
              {run.status === "stale" && onRegenerateStale ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRegenerateStale()}><RotateCcw aria-hidden="true" size={16} />按人工版本继续生成</button> : null}
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
              <div><p className="eyebrow">最终决定</p><h2 id="approve-title">确认批准成片</h2></div>
              <button className="icon-button" type="button" onClick={() => setApproving(false)} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <div className="decision-dialog-copy"><Check aria-hidden="true" size={22} /><p><strong>批准后将生成发布包。</strong><span>这会结束人工终审；请确认已经完整观看画面、字幕并听过声音。</span></p></div>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={() => setApproving(false)} disabled={decisionPending}>再看一遍</button>
              <button className="button button-primary" type="button" disabled={decisionPending} onClick={() => void onDecision({ action: "approve" })}><Check aria-hidden="true" size={17} />{decisionPending ? "正在批准..." : "确认批准并生成发布包"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ProductionProgress({ run }: { run: StudioRunDetail }) {
  if (!run.progress || !run.phases) return null;
  return <section className="production-progress" aria-label="制作进度" data-tour="run-workflow">
    <header>
      <div><p className="eyebrow">制作进度</p><strong>{run.progress.completedNodes} / {run.progress.totalNodes} 个节点完成</strong></div>
      <span>{run.progress.percentage}%</span>
    </header>
    <div className="production-progress-bar" aria-hidden="true"><span style={{ width: `${run.progress.percentage}%` }} /></div>
    <div className="production-phases">
      {run.phases.map((phase, index) => <article className={`production-phase is-${phase.status}`} key={phase.id}>
        <span className="production-phase-index">{phase.status === "completed" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
        <div><strong>{phase.label}</strong><small>{phase.completedNodes}/{phase.totalNodes} 节点</small></div>
      </article>)}
    </div>
  </section>;
}

function isStoppedStatus(status: StudioRunDetail["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected" || status === "stale";
}

function failedNodeId(run: StudioRunDetail): string | undefined {
  return run.nodes.find((node) => node.status === "failed")?.id;
}

function hasUncertainPaidOutcome(run: StudioRunDetail): boolean {
  return run.nodes.some((node) => node.outcomeUncertain === true);
}

function runningNodeLabel(run: StudioRunDetail): string {
  const current = run.nodes.find((node) => node.id === run.currentNodeId)
    ?? run.nodes.find((node) => node.status === "running")
    ?? run.nodes.find((node) => node.status === "pending");
  if (current?.id === "script") {
    const providerId = (current.executionReceipt ?? current.plannedExecution)?.providerId;
    return providerId === "codex-screenwriter-v1"
      ? "编剧与独立审计 Agent 正在迭代脚本"
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
      return "付费服务可能已经受理请求，但结果尚未确认。系统已停止重试和重新制作，请先在 Provider 控制台核对任务与账单。";
    }
    return safeRunError(run.nodes.find((node) => node.status === "failed")?.error);
  }
  if (run.status === "awaiting_spend_approval") return "即将进入付费节点，请先检查前序交付、模型和费用上限。";
  if (run.status === "approval_invalidated") return "输入、模型或预算发生了变化，之前的费用确认已失效，请重新检查。";
  if (run.status === "stale") return "上游内容已被人工修改，后续旧结果不会继续使用，需要重新生成。";
  return "制作正在自动执行，详情页会实时更新；连接中断时会明确提示。";
}

function nodeHasCreatorContent(node: StudioRunDetail["nodes"][number], run: StudioRunDetail): boolean {
  if (["awaiting_spend_approval", "approval_invalidated", "needs_human", "stale", "failed", "rejected"].includes(node.status)) return true;
  if (hasContent(node.output)) return true;
  if (node.outputState?.versions.some((version) => hasContent(version.output) || version.artifactIds.length > 0)) return true;
  return node.artifactIds.some((artifactId) => run.artifacts.some((artifact) => artifact.id === artifactId && Boolean(artifact.contentUrl)));
}

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
    return "该节点执行失败。技术细节已保留在本地服务日志中，请检查对应能力后重试。";
  }
  return message;
}
