import { AlertTriangle, Check, Download, RotateCcw, Send, X, XCircle } from "lucide-react";
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
}

export function RunWorkbench({ run, decisionPending, onDecision, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, onOverrideNode, onOverrideNodeInput, onAuthorizeSpend, onRegenerateStale }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const rejectDialogRef = useDialogFocus<HTMLElement>(rejecting, () => setRejecting(false), decisionPending);
  const approveDialogRef = useDialogFocus<HTMLElement>(approving, () => setApproving(false), decisionPending);
  const video = run.artifacts.find((artifact) => artifact.id === run.videoArtifactId);
  const creatorNodes = run.nodes.filter((node) => isCreatorFacingNode(node.id) && nodeHasCreatorContent(node, run));

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

      <section className="workflow-track" aria-label="生产工作流" data-tour="run-workflow">
        {run.nodes.map((node, index) => (
          <div className={`workflow-node node-${node.status}`} key={node.id}>
            <span className="node-index">{node.status === "succeeded" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
            <span>{node.role ? `${node.role} · ${node.label}` : node.label}</span>
          </div>
        ))}
      </section>

      <div className="review-layout">
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
            <section className="run-state-panel">
              <h2>当前状态</h2>
              <p>{runStateMessage(run)}</p>
              {run.status === "succeeded" && onOpenPublish ? <button className="button button-primary" type="button" onClick={onOpenPublish}><Send aria-hidden="true" size={16} />多平台发布</button> : null}
              {(run.status === "failed" || run.status === "rejected") && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
              {run.status === "stale" && onRegenerateStale ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRegenerateStale()}><RotateCcw aria-hidden="true" size={16} />按人工版本继续生成</button> : null}
            </section>
          )}

        </aside>
      </div>

      {creatorNodes.length ? <section className="role-workspaces" aria-labelledby="role-workspaces-title">
        <header className="section-heading"><div><p className="eyebrow">创作内容</p><h2 id="role-workspaces-title">逐项预览与修改</h2><p>这里只呈现会影响作品、并且适合人工调整的内容。路径、版本和运行参数不会占用你的注意力。</p></div><span>{creatorNodes.length} 项</span></header>
        <div className="node-workspace-list">
          {creatorNodes.map((node) => <NodeWorkspace
            key={node.id}
            node={node}
            nodes={run.nodes}
            runStatus={run.status}
            artifacts={run.artifacts.filter((artifact) => node.artifactIds.includes(artifact.id))}
            busy={nodeMutationPending}
            onOverride={onOverrideNode ?? (async () => undefined)}
            onInputOverride={onOverrideNodeInput ?? (async () => undefined)}
            onAuthorize={onAuthorizeSpend ?? (async () => undefined)}
          />)}
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
    return safeRunError(run.nodes.find((node) => node.status === "failed")?.error);
  }
  if (run.status === "awaiting_spend_approval") return "即将进入付费节点，请先检查前序交付、模型和费用上限。";
  if (run.status === "approval_invalidated") return "输入、模型或预算发生了变化，之前的费用确认已失效，请重新检查。";
  if (run.status === "stale") return "上游内容已被人工修改，后续旧结果不会继续使用，需要重新生成。";
  return "制作正在自动执行，详情页会实时更新；连接中断时会明确提示。";
}

const CREATOR_NODE_IDS = new Set([
  "brief",
  "script",
  "reference-grammar",
  "visual-direction",
  "assets",
  "voice",
  "visual-review",
  "publish-package",
]);

function isCreatorFacingNode(nodeId: string): boolean {
  return CREATOR_NODE_IDS.has(nodeId);
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
