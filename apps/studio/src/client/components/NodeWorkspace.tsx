import { AlertTriangle, Check, ChevronDown, CircleDollarSign, FilePenLine, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StudioArtifact, StudioNode, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioRunStatus, StudioSpendAuthorizationInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { providerLabel } from "../presentation.js";
import { hasCreatorDocumentContent } from "../creator-document-policy.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";
import { NodeStructuredEditor } from "./NodeStructuredEditor.js";

interface NodeWorkspaceProps {
  node: StudioNode;
  nodes?: StudioNode[];
  runStatus: StudioRunStatus;
  artifacts: StudioArtifact[];
  busy: boolean;
  onOverride: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onInputOverride?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onAuthorize: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
}

export function NodeWorkspace({ node, nodes = [node], runStatus, artifacts, busy, onOverride, onInputOverride = async () => undefined, onAuthorize }: NodeWorkspaceProps) {
  const [editing, setEditing] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [draft, setDraft] = useState(() => pretty(node.output ?? effectiveOutput(node) ?? {}));
  const [inputDraft, setInputDraft] = useState(() => pretty(effectiveInput(node) ?? {}));
  const [error, setError] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<unknown>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string>();
  const [terminalOverride, setTerminalOverride] = useState<StudioNodeOverrideInput>();
  const [terminalInputOverride, setTerminalInputOverride] = useState<StudioNodeInputOverrideInput>();
  const spendDialogRef = useDialogFocus<HTMLElement>(authorizing, () => setAuthorizing(false), busy);
  const terminalDialogRef = useDialogFocus<HTMLElement>(terminalOverride !== undefined, () => setTerminalOverride(undefined), busy);
  const terminalInputDialogRef = useDialogFocus<HTMLElement>(terminalInputOverride !== undefined, () => setTerminalInputOverride(undefined), busy);
  const receipt = node.executionReceipt;
  const execution = receipt ?? node.plannedExecution;
  const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
  const effectiveInputVersion = node.inputState?.versions.find((version) => version.id === node.inputState?.effectiveVersionId);
  const editableArtifact = useMemo(
    () => selectEditableArtifact(node.id, artifacts, effectiveVersion?.artifactIds),
    [artifacts, effectiveVersion?.artifactIds, node.id],
  );
  const audioArtifact = useMemo(
    () => {
      if (node.id !== "voice") return undefined;
      const candidates = artifacts.filter((artifact) => artifact.contentUrl
        && artifact.contentType?.startsWith("audio/")
        && (artifact.producerNodeId === "voice" || artifact.kind === "voiceover"))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const effectiveIds = effectiveVersion?.artifactIds ?? [];
      return candidates.filter((artifact) => effectiveIds.includes(artifact.id)).at(-1) ?? candidates.at(-1);
    },
    [artifacts, effectiveVersion?.artifactIds, node.id],
  );
  const audioIsCurrent = Boolean(audioArtifact
    && runStatus !== "stale"
    && (effectiveVersion?.artifactIds?.length
      ? effectiveVersion.artifactIds.includes(audioArtifact.id)
      : effectiveVersion?.source !== "human"));
  const spendInputs = useMemo(() => node.spendPlan?.inputVersionIds.map((versionId) => {
    const inputOwner = nodes.find((candidate) => candidate.inputState?.versions.some((version) => version.id === versionId));
    const outputOwner = nodes.find((candidate) => candidate.outputState?.versions.some((version) => version.id === versionId));
    const owner = inputOwner ?? outputOwner;
    const source = inputOwner?.inputState?.versions.find((candidate) => candidate.id === versionId)?.source
      ?? outputOwner?.outputState?.versions.find((candidate) => candidate.id === versionId)?.source;
    return { versionId, label: inputOwner ? `${owner?.label ?? "节点"}输入` : owner?.label ?? "上游交付", role: owner?.role ?? "生产角色", source };
  }) ?? [], [node.spendPlan?.inputVersionIds, nodes]);
  const hasStructuredOutput = node.output !== undefined || effectiveOutput(node) !== undefined;
  const readOnlyReview = READ_ONLY_REVIEW_NODE_IDS.has(node.id);
  const canEdit = !readOnlyReview && (hasStructuredOutput || documentPreview !== undefined) && runStatus !== "running" && node.status !== "pending" && node.status !== "running" && node.status !== "awaiting_spend_approval";
  const canEditInput = !readOnlyReview && effectiveInputVersion !== undefined && runStatus !== "running" && node.status !== "running" && node.status !== "pending";
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  const fallbackReason = useMemo(() => agentFallbackReason(execution), [execution]);
  const capability = useMemo(() => fallbackReason
    ? `审计失败，已规则回退 · ${fallbackReason}`
    : creatorCapabilityLabel(execution, node.spendPlan), [execution, fallbackReason, node.spendPlan]);
  const assetProviderIds = useMemo(() => configuredAssetProviderIds(nodes), [nodes]);
  const deliveryValue = documentPreview ?? node.output ?? effectiveOutput(node);
  const hasDelivery = hasCreatorDocumentContent(node.id, deliveryValue);
  const hasEditableInput = node.id !== "brief" && hasCreatorDocumentContent(`${node.id}-input`, effectiveInput(node));

  useEffect(() => {
    if (!editing) setDraft(pretty(documentPreview ?? node.output ?? effectiveOutput(node) ?? {}));
  }, [documentPreview, editing, node]);

  useEffect(() => {
    if (!editingInput) setInputDraft(pretty(effectiveInput(node) ?? {}));
  }, [editingInput, node]);

  useEffect(() => {
    if (!editableArtifact?.contentUrl) {
      setDocumentPreview(undefined);
      setDocumentError(undefined);
      setDocumentLoading(false);
      return;
    }
    const controller = new AbortController();
    setDocumentLoading(true);
    setDocumentError(undefined);
    void fetch(editableArtifact.contentUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
      return response.json() as Promise<unknown>;
    }).then((content) => {
      setDocumentPreview(content);
      setDocumentLoading(false);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setDocumentError(caught instanceof Error ? caught.message : "读取失败");
      setDocumentLoading(false);
    });
    return () => controller.abort();
  }, [editableArtifact?.contentUrl]);

  function beginEditing() {
    const usesDocument = Boolean(editableArtifact && documentPreview !== undefined);
    setEditingDocument(usesDocument);
    setDraft(pretty(usesDocument ? documentPreview : node.output ?? effectiveOutput(node) ?? {}));
    setEditing(true);
  }

  async function saveOverride(confirmTerminalEdit = false, preparedOverride?: StudioNodeOverrideInput) {
    setError(undefined);
    try {
      const parsed = preparedOverride ?? (editingDocument && editableArtifact
        ? { document: { artifactId: editableArtifact.id, content: JSON.parse(draft) as unknown } }
        : { output: JSON.parse(draft) as unknown });
      if (terminal && !confirmTerminalEdit) {
        setTerminalOverride(parsed);
        return;
      }
      await onOverride(node.id, { ...parsed, ...(confirmTerminalEdit ? { confirmTerminalEdit: true } : {}) });
      setEditing(false);
      setTerminalOverride(undefined);
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "JSON 格式不正确，请检查括号和引号。" : caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function saveInputOverride(confirmTerminalEdit = false, preparedOverride?: StudioNodeInputOverrideInput) {
    setError(undefined);
    try {
      const parsed = preparedOverride ?? { input: JSON.parse(inputDraft) as unknown };
      if (terminal && !confirmTerminalEdit) {
        setTerminalInputOverride(parsed);
        return;
      }
      await onInputOverride(node.id, { ...parsed, ...(confirmTerminalEdit ? { confirmTerminalEdit: true } : {}) });
      setEditingInput(false);
      setTerminalInputOverride(undefined);
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "JSON 格式不正确，请检查括号和引号。" : caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function authorize() {
    if (!node.spendPlan) return;
    setError(undefined);
    try {
      await onAuthorize(node.id, {
        inputVersionIds: [...node.spendPlan.inputVersionIds],
        providerId: node.spendPlan.providerId,
        modelId: node.spendPlan.modelId,
        maxCostCny: node.spendPlan.maxCostCny,
        maxAttempts: node.spendPlan.maxAttempts,
      });
      setAuthorizing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <details
      className={`node-workspace is-${node.status}`}
      name="creator-workspaces"
      aria-label={`${node.label} · ${node.role ?? "生产角色"}`}
      open={node.status === "awaiting_spend_approval" || node.status === "approval_invalidated"}
      onToggle={(event) => revealExpandedWorkspace(event.currentTarget)}
    >
      <summary>
        <span className="node-workspace-state">{node.status === "succeeded" ? <Check aria-hidden="true" size={14} /> : <span />}</span>
        <span className="node-workspace-title"><strong>{node.label}</strong><small>{node.role ?? "生产角色"}</small></span>
        {capability ? <span className="node-workspace-provenance">{capability}</span> : <span />}
        {node.outputState?.stale ? <span className="node-stale-label"><AlertTriangle aria-hidden="true" size={14} />旧结果</span> : null}
        <ChevronDown className="node-workspace-chevron" aria-hidden="true" size={17} />
      </summary>
      <div className="node-workspace-body">
        {node.agentLoopProgress ? <div className={`agent-loop-progress is-${node.agentLoopProgress.phase}`} role="status">
          <strong>{agentLoopPhaseLabel(node.agentLoopProgress)}</strong>
          {node.agentLoopProgress.latestAudit ? <span>上一轮 {node.agentLoopProgress.latestAudit.score} 分：{node.agentLoopProgress.latestAudit.summary}</span> : <span>正在建立本轮候选，完成后由独立 Agent 审计。</span>}
        </div> : null}
        {fallbackReason ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} /><span><strong>审计失败，已规则回退</strong>：{fallbackReason}</span></p> : null}
        {node.outputState?.stale ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} />此节点结果已经过期，后续成片不会继续采用它。请检查人工版本后重新生成。</p> : null}

        {node.spendPlan ? (
          <section className="spend-gate" aria-label={`${node.label}费用确认`}>
            <div><CircleDollarSign aria-hidden="true" size={20} /><span><strong>执行前费用确认</strong><small>预计 ¥{node.spendPlan.estimatedCostCny.toFixed(2)}，最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} · 最多 {node.spendPlan.maxAttempts} 次</small></span></div>
            {node.spendAuthorizationId ? <span className="spend-authorized"><ShieldCheck aria-hidden="true" size={15} />已授权</span> : (
              <button className="button button-primary" type="button" disabled={busy} onClick={() => setAuthorizing(true)}><ShieldCheck aria-hidden="true" size={16} />检查并确认</button>
            )}
          </section>
        ) : null}

        <section className="node-output-preview node-creator-delivery">
          <header><div><strong>{node.role ?? "生产角色"}的交付</strong><small>{readOnlyReview ? "技术结果只读；需要调整时请修改上游内容后重跑" : effectiveVersion?.source === "human" ? "已采用你的修改" : hasDelivery ? "自动生成，可按需修改" : node.status === "pending" ? "等待上游完成" : "本节点没有需要人工阅读的内容"}</small></div>{canEdit && hasDelivery && !editing && (!editableArtifact || documentPreview !== undefined) ? <button className="button button-ghost" type="button" onClick={beginEditing}><FilePenLine aria-hidden="true" size={15} />编辑交付</button> : null}</header>
          {editing ? <NodeStructuredEditor nodeId={node.id} value={safeParse(draft)} assetProviderIds={assetProviderIds} onChange={(value) => setDraft(pretty(value))} /> : documentLoading ? <p className="node-document-state">正在读取结构化交付...</p> : documentError ? <p className="node-workspace-error" role="alert">结构化交付读取失败：{documentError}</p> : <NodeDeliveryPreview nodeId={node.id} value={documentPreview ?? node.output ?? effectiveOutput(node)} />}
          {audioArtifact?.contentUrl ? <div className={audioIsCurrent ? "node-audio-preview" : "node-audio-preview is-stale"}><div><strong>{audioIsCurrent ? "实际配音试听" : "上次生成的配音"}</strong>{!audioIsCurrent ? <small>当前文字已修改或上游已变化；继续生成后会更新声音。</small> : null}</div><audio aria-label={audioIsCurrent ? "实际配音试听" : "上次生成的配音试听"} src={audioArtifact.contentUrl} controls preload="metadata" /></div> : null}
          {editing ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => setEditing(false)}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride()}><Save aria-hidden="true" size={15} />保存为人工版本</button></footer> : null}
        </section>

        {canEditInput && hasEditableInput ? <details className="node-input-adjustment">
          <summary><FilePenLine aria-hidden="true" size={15} />调整这个角色收到的内容</summary>
          <section className="node-output-preview">
            <header><div><strong>上游输入</strong><small>{inputSourceLabel(effectiveInputVersion?.source)}{node.inputState?.stale ? " · 上游已变化，需复核" : ""}</small></div>{!editingInput ? <button className="button button-ghost" type="button" onClick={() => setEditingInput(true)}><FilePenLine aria-hidden="true" size={15} />编辑输入</button> : null}</header>
            {effectiveInputVersion?.source === "reconstructed" ? <p className="node-version-note">旧任务没有保存当时的原始输入；这里展示的是按当前上游内容推断出的可编辑版本。</p> : null}
            {editingInput ? <NodeStructuredEditor nodeId={`${node.id}-input`} value={safeParse(inputDraft)} assetProviderIds={assetProviderIds} onChange={(value) => setInputDraft(pretty(value))} /> : <NodeDeliveryPreview nodeId={`${node.id}-input`} value={effectiveInput(node)} />}
            {editingInput ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => setEditingInput(false)}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride()}><Save aria-hidden="true" size={15} />保存人工输入</button></footer> : null}
          </section>
        </details> : null}

        {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      </div>

      {authorizing && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendDialogRef} role="dialog" aria-modal="true" aria-label="确认本次费用" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>确认执行 {node.label}</h3>
          <p>这次授权只对下面已经审阅的输入版本、{node.spendPlan.modelId} 和最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} 有效。任何内容、模型、预算或重试次数变化都会让授权自动失效。</p>
          <div className="spend-input-versions" aria-label="本次付费所使用的上游版本">
            {spendInputs.map((input) => <div key={input.versionId}><span><strong>{input.role} · {input.label}</strong><small>{input.source === "human" ? "人工版本" : "自动版本"}</small></span><code>{shortId(input.versionId)}</code></div>)}
          </div>
          <div><button className="button button-ghost" type="button" onClick={() => setAuthorizing(false)}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void authorize()}>确认并执行</button></div>
        </section>
      </div> : null}
      {terminalOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-edit-${node.id}`}>创建已结束制作的人工修订版？</h3>
          <p>这不会在后台自动调用付费能力。保存后，后续结果会标为过期，只有你再次点击重新生成才会继续。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride(true, terminalOverride)}>确认创建修订版</button></div>
        </section>
      </div> : null}
      {terminalInputOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalInputDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-input-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-input-edit-${node.id}`}>创建已结束制作的人工输入版本？</h3>
          <p>保存后，本节点和全部后续结果会过期；系统不会自动调用任何付费能力。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalInputOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride(true, terminalInputOverride)}>确认创建输入版本</button></div>
        </section>
      </div> : null}
    </details>
  );
}

function agentLoopPhaseLabel(progress: NonNullable<StudioNode["agentLoopProgress"]>): string {
  const phase = progress.phase === "auditing"
    ? "独立审计中"
    : progress.phase === "repairing"
      ? "按审计意见修订中"
      : progress.phase === "passed"
        ? "独立审计已通过"
        : progress.phase === "exhausted"
          ? "三轮审计未通过"
          : "生产 Agent 生成中";
  return `第 ${progress.iteration} / ${progress.maxIterations} 轮 · ${phase}`;
}

function revealExpandedWorkspace(workspace: HTMLDetailsElement): void {
  if (
    !workspace.open
    || typeof window === "undefined"
    || typeof window.matchMedia !== "function"
    || !window.matchMedia("(max-width: 700px)").matches
  ) return;
  window.requestAnimationFrame(() => workspace.scrollIntoView({ block: "start" }));
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

const EDITABLE_ARTIFACT_KIND: Record<string, string> = {
  script: "script",
  "reference-grammar": "shot_grammar",
  "visual-direction": "storyboard",
  "asset-candidates": "asset_candidates",
  "asset-semantic-rank": "asset_ranking",
  assets: "asset_plan",
  voice: "voiceover_plan",
  render: "render_manifest",
  "technical-review": "review_report",
  "visual-review": "review_report",
  "publish-package": "publish_package",
};

const READ_ONLY_REVIEW_NODE_IDS = new Set(["render", "technical-review", "final-review"]);

function selectEditableArtifact(nodeId: string, artifacts: StudioArtifact[], effectiveArtifactIds?: string[]): StudioArtifact | undefined {
  const kind = EDITABLE_ARTIFACT_KIND[nodeId];
  if (!kind) return undefined;
  const candidates = artifacts.filter((artifact) => artifact.kind === kind && artifact.contentType === "application/json" && artifact.contentUrl);
  return candidates.find((artifact) => effectiveArtifactIds?.includes(artifact.id)) ?? candidates[0];
}

function effectiveOutput(node: StudioNode): unknown {
  const state = node.outputState;
  return state?.versions.find((version) => version.id === state.effectiveVersionId)?.output;
}

function effectiveInput(node: StudioNode): unknown {
  const state = node.inputState;
  return state?.versions.find((version) => version.id === state.effectiveVersionId)?.value;
}

function configuredAssetProviderIds(nodes: StudioNode[]): string[] {
  const briefNode = nodes.find((candidate) => candidate.id === "brief");
  const brief = asRecord(briefNode ? effectiveOutput(briefNode) ?? briefNode.output : undefined);
  const director = asRecord(brief?.director);
  return Array.isArray(director?.assetProviderIds)
    ? director.assetProviderIds.filter((value): value is string => typeof value === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasMeaningfulValue);
  return true;
}

function inputSourceLabel(source: "derived" | "human" | "reconstructed" | undefined): string {
  if (source === "human") return "人工输入版本";
  if (source === "reconstructed") return "历史任务推断输入";
  return "由上游自动派生";
}

function shortId(value: string | undefined): string | undefined {
  return value && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function creatorCapabilityLabel(
  execution: StudioNode["executionReceipt"] | StudioNode["plannedExecution"] | undefined,
  spendPlan: StudioNode["spendPlan"],
): string | undefined {
  const providerId = execution?.providerId ?? spendPlan?.providerId;
  const modelId = execution?.modelId ?? spendPlan?.modelId;
  if (!providerId || !modelId || providerId.startsWith("inline:") || modelId === "inline") return undefined;
  const reasoningEffort = execution?.parameters?.reasoningEffort;
  const loopIterations = execution?.parameters?.agentLoopIterations;
  const auditEffort = execution?.parameters?.auditReasoningEffort;
  return [
    `本次使用 ${providerLabel(providerId) ?? execution?.providerLabel ?? providerId} · ${modelId}`,
    typeof reasoningEffort === "string" ? `推理 ${reasoningEffort}` : undefined,
    typeof loopIterations === "number" ? `生产 Agent → 独立审计 Agent · ${loopIterations}/3 轮` : undefined,
    typeof auditEffort === "string" ? `审计推理 ${auditEffort}` : undefined,
  ].filter(Boolean).join(" · ");
}

function agentFallbackReason(
  execution: StudioNode["executionReceipt"] | StudioNode["plannedExecution"] | undefined,
): string | undefined {
  const parameterReason = execution?.parameters?.fallbackReason;
  const receiptReason = execution?.fallbackReason;
  const reason = typeof parameterReason === "string" ? parameterReason : receiptReason;
  if (typeof reason !== "string" || !reason.trim()) return undefined;
  if (execution?.parameters?.agentLoop !== "failed" && receiptReason === undefined) return undefined;
  return reason.trim();
}
