import { AlertTriangle, Check, ChevronDown, CircleDollarSign, FilePenLine, Pause, Save, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StudioArtifact, StudioNode, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioProvider, StudioRunStatus, StudioSpendAuthorizationInput, StudioSpendRejectionInput } from "../../shared/api.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { providerLabel } from "../presentation.js";
import { hasCreatorDocumentContent } from "../creator-document-policy.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";
import { NodeStructuredEditor } from "./NodeStructuredEditor.js";

interface NodeWorkspaceProps {
  node: StudioNode;
  nodes?: StudioNode[];
  providers?: StudioProvider[];
  runStatus: StudioRunStatus;
  artifacts: StudioArtifact[];
  busy: boolean;
  pauseBusy?: boolean;
  pauseRequested?: boolean;
  onRequestPause?: () => Promise<void>;
  onOverride: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onInputOverride?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onConfigure?: (nodeId: string, input: StudioNodeExecutionConfigurationInput) => Promise<void>;
  onAuthorize: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRejectSpend?: (nodeId: string, input: StudioSpendRejectionInput) => Promise<void>;
}

export function NodeWorkspace({ node, nodes = [node], providers = [], runStatus, artifacts, busy, pauseBusy = false, pauseRequested = false, onRequestPause, onOverride, onInputOverride = async () => undefined, onConfigure = async () => undefined, onAuthorize, onRejectSpend = async () => undefined }: NodeWorkspaceProps) {
  const shouldOpenForAttention = node.status === "awaiting_spend_approval" || node.status === "approval_invalidated";
  const [workspaceOpen, setWorkspaceOpen] = useState(shouldOpenForAttention);
  const [inputReviewOpen, setInputReviewOpen] = useState(shouldOpenForAttention);
  const [editing, setEditing] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [rejectingSpend, setRejectingSpend] = useState(false);
  const [spendRejectionReason, setSpendRejectionReason] = useState<StudioSpendRejectionInput["reason"]>("too_expensive");
  const [targetEstimatedCostCny, setTargetEstimatedCostCny] = useState("");
  const [spendRejectionNote, setSpendRejectionNote] = useState("");
  const [draft, setDraft] = useState(() => pretty(node.output ?? effectiveOutput(node) ?? {}));
  const [inputDraft, setInputDraft] = useState(() => pretty(effectiveInput(node) ?? {}));
  const [error, setError] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<unknown>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string>();
  const [terminalOverride, setTerminalOverride] = useState<StudioNodeOverrideInput>();
  const [terminalInputOverride, setTerminalInputOverride] = useState<StudioNodeInputOverrideInput>();
  const spendDialogRef = useDialogFocus<HTMLElement>(authorizing, () => setAuthorizing(false), busy);
  const spendRejectionDialogRef = useDialogFocus<HTMLElement>(rejectingSpend, () => setRejectingSpend(false), busy);
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
  const visualArtifacts = useMemo(
    () => selectMaterializedVisualArtifacts(node, artifacts, effectiveVersion?.artifactIds),
    [artifacts, effectiveVersion?.artifactIds, node],
  );
  const currentVisualArtifactIds = effectiveVersion?.artifactIds?.length ? effectiveVersion.artifactIds : node.artifactIds;
  const visualsAreCurrent = Boolean(visualArtifacts.length
    && runStatus !== "stale"
    && !node.outputState?.stale
    && visualArtifacts.every((artifact) => currentVisualArtifactIds.includes(artifact.id)));
  const spendInputs = useMemo(() => node.spendPlan?.inputVersionIds.map((versionId) => {
    const inputOwner = nodes.find((candidate) => candidate.inputState?.versions.some((version) => version.id === versionId));
    const outputOwner = nodes.find((candidate) => candidate.outputState?.versions.some((version) => version.id === versionId));
    const owner = inputOwner ?? outputOwner;
    const source = inputOwner?.inputState?.versions.find((candidate) => candidate.id === versionId)?.source
      ?? outputOwner?.outputState?.versions.find((candidate) => candidate.id === versionId)?.source;
    return { versionId, label: inputOwner ? `${owner?.label ?? "节点"}输入` : owner?.label ?? "上游交付", role: owner?.role ?? "生产角色", source };
  }) ?? [], [node.spendPlan?.inputVersionIds, nodes]);
  const hasStructuredOutput = node.output !== undefined || effectiveOutput(node) !== undefined;
  const outputReadOnly = READ_ONLY_OUTPUT_NODE_IDS.has(node.id);
  const nodeReadOnly = READ_ONLY_NODE_IDS.has(node.id);
  const canEdit = !outputReadOnly && (hasStructuredOutput || documentPreview !== undefined) && runStatus !== "running" && node.status !== "pending" && node.status !== "running" && node.status !== "awaiting_spend_approval";
  const canEditInput = !nodeReadOnly && effectiveInputVersion !== undefined && runStatus !== "running" && node.status !== "running" && node.status !== "pending";
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  const fallbackReason = useMemo(() => agentFallbackReason(execution), [execution]);
  const capability = useMemo(() => fallbackReason
    ? `审计失败，已规则回退 · ${fallbackReason}`
    : creatorCapabilityLabel(execution, node.spendPlan), [execution, fallbackReason, node.spendPlan]);
  const assetProviderIds = useMemo(() => configuredAssetProviderIds(nodes), [nodes]);
  const editableAssetProviders = useMemo(
    () => providers.filter((provider) => assetProviderIds.includes(provider.id)),
    [assetProviderIds, providers],
  );
  const deliveryValue = documentPreview ?? node.output ?? effectiveOutput(node);
  const hasDelivery = hasCreatorDocumentContent(node.id, deliveryValue);
  const hasEditableInput = node.id !== "brief" && hasCreatorDocumentContent(`${node.id}-input`, effectiveInput(node));
  const inputSources = useMemo(
    () => creatorInputSources(node, nodes, effectiveInputVersion),
    [effectiveInputVersion, node, nodes],
  );
  const hasReviewableInput = hasEditableInput || inputSources.length > 0;
  const canRequestPause = runStatus === "running" && node.status === "succeeded" && (hasDelivery || hasReviewableInput) && onRequestPause !== undefined;

  useEffect(() => {
    if (!editing) setDraft(pretty(documentPreview ?? node.output ?? effectiveOutput(node) ?? {}));
  }, [documentPreview, editing, node]);

  useEffect(() => {
    if (!editingInput) setInputDraft(pretty(effectiveInput(node) ?? {}));
  }, [editingInput, node]);

  useEffect(() => {
    if (shouldOpenForAttention) {
      setWorkspaceOpen(true);
      setInputReviewOpen(true);
    }
  }, [shouldOpenForAttention]);

  useEffect(() => {
    setRejectingSpend(false);
    setSpendRejectionReason("too_expensive");
    setTargetEstimatedCostCny("");
    setSpendRejectionNote("");
  }, [node.spendPlan?.id]);

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
    setError(undefined);
    setEditingDocument(usesDocument);
    setDraft(pretty(usesDocument ? documentPreview : node.output ?? effectiveOutput(node) ?? {}));
    setEditing(true);
  }

  function cancelEditing() {
    setError(undefined);
    setEditing(false);
  }

  function cancelInputEditing() {
    setError(undefined);
    setEditingInput(false);
  }

  async function saveOverride(confirmTerminalEdit = false, preparedOverride?: StudioNodeOverrideInput) {
    setError(undefined);
    try {
      const parsed = preparedOverride ?? (editingDocument && editableArtifact
        ? { document: { artifactId: editableArtifact.id, content: JSON.parse(draft) as unknown } }
        : { output: JSON.parse(draft) as unknown });
      const validationError = creatorDraftValidationError(
        node.id,
        "output" in parsed ? parsed.output : parsed.document?.content,
      );
      if (validationError) {
        setError(validationError);
        return;
      }
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
      const validationError = creatorInputDraftValidationError(parsed.input);
      if (validationError) {
        setError(validationError);
        return;
      }
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

  async function rejectSpend() {
    if (!node.spendPlan) return;
    setError(undefined);
    const target = targetEstimatedCostCny.trim() ? Number(targetEstimatedCostCny) : undefined;
    if (target !== undefined && (!Number.isFinite(target) || target < 0 || target > 100_000)) {
      setError("下一版目标预计费用必须在 0 到 100000 之间。");
      return;
    }
    try {
      await onRejectSpend(node.id, {
        spendPlanId: node.spendPlan.id,
        reason: spendRejectionReason,
        ...(target !== undefined ? { targetEstimatedCostCny: target } : {}),
        ...(spendRejectionNote.trim() ? { note: spendRejectionNote.trim() } : {}),
      });
      setRejectingSpend(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <details
      id={`node-workspace-${node.id}`}
      className={`node-workspace is-${node.status}`}
      name="creator-workspaces"
      aria-label={`${node.label} · ${node.role ?? "生产角色"}`}
      open={workspaceOpen}
      onToggle={(event) => {
        setWorkspaceOpen(event.currentTarget.open);
        revealExpandedWorkspace(event.currentTarget);
      }}
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
        {node.executionConfiguration ? <NodeExecutionConfigurationEditor
          node={node}
          providers={providers}
          runStatus={runStatus}
          busy={busy}
          onSave={(input) => onConfigure(node.id, input)}
        /> : null}
        {canRequestPause ? <div className="node-pause-edit">
          <span>{pauseRequested ? "已请求暂停；当前任务安全结束后会停在下一节点前。" : "想修改这一步？系统会先让当前任务安全结束，再停下来。"}</span>
          <button className="button button-ghost" type="button" disabled={pauseBusy || pauseRequested} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{pauseRequested ? "等待暂停" : "暂停后修改"}</button>
        </div> : null}

        {canEditInput && hasReviewableInput ? <details className="node-input-adjustment" open={inputReviewOpen} onToggle={(event) => setInputReviewOpen(event.currentTarget.open)}>
          <summary><FilePenLine aria-hidden="true" size={15} />查看和调整这个角色收到的内容</summary>
          <div className="node-input-review">
            {inputSources.length ? <section className="node-input-sources" aria-label={`${node.role ?? "生产角色"}收到的上游交付`}>
              <header><strong>来自上游角色</strong><small>修改会在原角色处保存为新版本，并让后续旧结果失效。</small></header>
              <div>
                {inputSources.map((source) => <article key={source.node.id}>
                  <span><strong>{source.node.role ?? "生产角色"} · {source.node.label}</strong><small>{source.versionLabel}{source.node.outputState?.stale ? " · 上游已变化" : ""}</small></span>
                  <button className="button button-ghost" type="button" aria-label={`${source.canEdit ? "查看与修改" : "查看"} ${source.node.role ?? "生产角色"} · ${source.node.label}`} onClick={() => revealSourceWorkspace(source.node.id)}>{source.canEdit ? "查看与修改" : "查看"}</button>
                </article>)}
              </div>
            </section> : null}
            {hasEditableInput ? <section className="node-output-preview">
              <header><div><strong>本节点专用设置</strong><small>{inputSourceLabel(effectiveInputVersion?.source)}{node.inputState?.stale ? " · 上游已变化，需复核" : ""}</small></div>{!editingInput ? <button className="button button-ghost" type="button" onClick={() => setEditingInput(true)}><FilePenLine aria-hidden="true" size={15} />编辑输入</button> : null}</header>
              {effectiveInputVersion?.source === "reconstructed" ? <p className="node-version-note">旧任务没有保存当时的原始输入；这里展示的是按当前上游内容推断出的可编辑版本。</p> : null}
              {editingInput ? <NodeStructuredEditor nodeId={`${node.id}-input`} value={safeParse(inputDraft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setInputDraft(pretty(value)); }} /> : <NodeDeliveryPreview nodeId={`${node.id}-input`} value={effectiveInput(node)} />}
              {editingInput ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelInputEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride()}><Save aria-hidden="true" size={15} />保存人工输入</button></footer> : null}
            </section> : null}
          </div>
        </details> : null}

        {node.spendPlan ? (
          <section className="spend-gate" aria-label={`${node.label}费用确认`}>
            <div><CircleDollarSign aria-hidden="true" size={20} /><span><strong>执行前费用确认</strong><small>预计 ¥{node.spendPlan.estimatedCostCny.toFixed(2)}，最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} · 最多 {node.spendPlan.maxAttempts} 次</small>{node.spendPlan.items?.map((item) => <small key={item.id}><span>{item.label} · {item.providerId} · {item.modelId}</span> · ¥{item.estimatedCostCny.toFixed(2)}</small>)}</span></div>
            {node.spendAuthorizationId ? <span className="spend-authorized"><ShieldCheck aria-hidden="true" size={15} />已授权</span> : (
              <div className="spend-gate-actions">{node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy} onClick={() => setRejectingSpend(true)}>这份报价不合适</button> : null}<button className="button button-primary" type="button" disabled={busy} onClick={() => setAuthorizing(true)}><ShieldCheck aria-hidden="true" size={16} />检查并确认</button></div>
            )}
          </section>
        ) : null}

        <section className="node-output-preview node-creator-delivery">
          <header><div><strong>{node.role ?? "生产角色"}的交付</strong><small>{deliveryEditHint(node.id, effectiveVersion?.source, hasDelivery, node.status, runStatus, pauseRequested)}</small></div>{canEdit && hasDelivery && !editing && (!editableArtifact || documentPreview !== undefined) ? <button className="button button-ghost" type="button" onClick={beginEditing}><FilePenLine aria-hidden="true" size={15} />编辑交付</button> : null}</header>
          {node.id === "assets" && visualArtifacts.length ? <div className={visualsAreCurrent ? "node-visual-preview" : "node-visual-preview is-stale"}>
            <header><strong>{visualsAreCurrent ? "实际素材画面" : "上次生成的素材画面"}</strong><small>{visualArtifacts.length} 个可预览素材{visualsAreCurrent ? "" : " · 上游变化后需重新生成"}</small></header>
            <div>
              {visualArtifacts.map((artifact, index) => <figure key={artifact.id}>
                {artifact.contentType?.startsWith("video/")
                  ? <video aria-label={`素材 ${index + 1} 画面预览`} src={artifact.contentUrl} controls playsInline preload="metadata" />
                  : <img alt={`素材 ${index + 1} 画面预览`} src={artifact.contentUrl} loading="lazy" />}
                <figcaption><span>素材 {index + 1}</span><small>{providerLabel(artifact.providerId) ?? artifact.providerId ?? "素材来源未记录"}</small></figcaption>
              </figure>)}
            </div>
          </div> : null}
          {editing ? <NodeStructuredEditor nodeId={node.id} value={safeParse(draft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setDraft(pretty(value)); }} /> : documentLoading ? <p className="node-document-state">正在读取结构化交付...</p> : documentError ? <p className="node-workspace-error" role="alert">结构化交付读取失败：{documentError}</p> : <NodeDeliveryPreview nodeId={node.id} value={documentPreview ?? node.output ?? effectiveOutput(node)} />}
          {audioArtifact?.contentUrl ? <div className={audioIsCurrent ? "node-audio-preview" : "node-audio-preview is-stale"}><div><strong>{audioIsCurrent ? "实际配音试听" : "上次生成的配音"}</strong>{!audioIsCurrent ? <small>当前文字已修改或上游已变化；继续生成后会更新声音。</small> : null}</div><audio aria-label={audioIsCurrent ? "实际配音试听" : "上次生成的配音试听"} src={audioArtifact.contentUrl} controls preload="metadata" /></div> : null}
          {editing ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride()}><Save aria-hidden="true" size={15} />保存为人工版本</button></footer> : null}
        </section>

        {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      </div>

      {authorizing && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendDialogRef} role="dialog" aria-modal="true" aria-label="确认本次费用" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>确认执行 {node.label}</h3>
          <p>这次授权只对下面已经审阅的输入版本、{node.spendPlan.modelId} 和本次最高授权额 ¥{node.spendPlan.maxCostCny.toFixed(2)} 有效。任何内容、模型、报价或重试次数变化都会让授权自动失效。</p>
          <div className="spend-input-versions" aria-label="本次付费所使用的上游版本">
            {spendInputs.map((input) => <div key={input.versionId}><span><strong>{input.role} · {input.label}</strong><small>{input.source === "human" ? "人工版本" : "自动版本"}</small></span><code>{shortId(input.versionId)}</code></div>)}
          </div>
          <div><button className="button button-ghost" type="button" onClick={() => setAuthorizing(false)}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void authorize()}>确认并执行</button></div>
        </section>
      </div> : null}
      {rejectingSpend && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendRejectionDialogRef} role="dialog" aria-modal="true" aria-label="保存费用反馈" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>把这份报价退回导演</h3>
          <p>这里只保存反馈，不会立即调用导演。你可以先修改方案或 Provider，再手动重新规划；新方案会重新报价并再次等待你确认。</p>
          <label className="field"><span>不接受这份报价的原因</span><select value={spendRejectionReason} onChange={(event) => setSpendRejectionReason(event.target.value as StudioSpendRejectionInput["reason"])}>
            <option value="too_expensive">总价太高，希望降低费用</option>
            <option value="provider_mix">Provider 或素材组合不合适</option>
            <option value="plan_not_approved">前面的画面方案不认可</option>
            <option value="other">其他原因</option>
          </select></label>
          <label className="field"><span>下一版目标预计费用（可选，0 表示优先全免费）</span><input aria-label="下一版目标预计费用（可选）" type="number" min={0} max={100000} step={0.01} value={targetEstimatedCostCny} onChange={(event) => setTargetEstimatedCostCny(event.target.value)} /></label>
          <label className="field"><span>具体调整意见（可选）</span><textarea aria-label="具体调整意见（可选）" rows={3} maxLength={1000} value={spendRejectionNote} onChange={(event) => setSpendRejectionNote(event.target.value)} /></label>
          <div><button className="button button-ghost" type="button" onClick={() => setRejectingSpend(false)}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void rejectSpend()}>保存反馈</button></div>
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

function revealSourceWorkspace(nodeId: string): void {
  if (typeof document === "undefined") return;
  const workspace = document.getElementById(`node-workspace-${nodeId}`);
  if (!(workspace instanceof HTMLDetailsElement)) return;
  if (!workspace.open) workspace.querySelector<HTMLElement>(":scope > summary")?.click();
  if (typeof workspace.scrollIntoView === "function") workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  window.requestAnimationFrame(() => workspace.querySelector<HTMLElement>("summary")?.focus());
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

const READ_ONLY_NODE_IDS = new Set(["render", "technical-review", "final-review"]);
const READ_ONLY_OUTPUT_NODE_IDS = new Set([...READ_ONLY_NODE_IDS, "assets", "voice"]);

const INPUT_SOURCE_BY_FIELD: Record<string, string> = {
  brief: "brief",
  script: "script",
  scriptPath: "script",
  referenceGrammarPath: "reference-grammar",
  directorPlan: "visual-direction",
  directorPlanPath: "visual-direction",
  candidateSearchPath: "asset-candidates",
  candidateInventoryPath: "asset-candidates",
  candidateRankingPath: "asset-semantic-rank",
  assetPlan: "assets",
  assetPlanPath: "assets",
  voiceoverPlan: "voice",
  voiceoverPlanPath: "voice",
  renderManifestPath: "render",
  videoPath: "render",
  reviewPath: "technical-review",
};

interface CreatorInputSource {
  node: StudioNode;
  versionLabel: string;
  canEdit: boolean;
}

function creatorInputSources(
  currentNode: StudioNode,
  nodes: StudioNode[],
  inputVersion: NonNullable<StudioNode["inputState"]>["versions"][number] | undefined,
): CreatorInputSource[] {
  if (!inputVersion) return [];
  const sourceNodeIds = new Set<string>();

  for (const versionId of inputVersion.upstreamVersionIds) {
    const owner = nodes.find((candidate) => candidate.outputState?.versions.some((version) => version.id === versionId));
    if (owner && owner.id !== currentNode.id) sourceNodeIds.add(owner.id);
  }

  for (const field of Object.keys(asRecord(inputVersion.value) ?? {})) {
    const sourceNodeId = INPUT_SOURCE_BY_FIELD[field];
    if (sourceNodeId && sourceNodeId !== currentNode.id) sourceNodeIds.add(sourceNodeId);
  }

  return [...sourceNodeIds].map((nodeId) => nodes.find((candidate) => candidate.id === nodeId)).filter((source): source is StudioNode => source !== undefined).map((source) => {
    const version = source.outputState?.versions.find((candidate) => candidate.id === source.outputState?.effectiveVersionId);
    return {
      node: source,
      versionLabel: version?.source === "human" ? "人工版本" : "自动版本",
      canEdit: !READ_ONLY_OUTPUT_NODE_IDS.has(source.id) && source.status !== "pending" && source.status !== "running",
    };
  });
}

function deliveryEditHint(
  nodeId: string,
  source: "generated" | "human" | undefined,
  hasDelivery: boolean,
  status: StudioNode["status"],
  runStatus: StudioRunStatus,
  pauseRequested: boolean,
): string {
  if (pauseRequested) return "已请求暂停；当前任务安全结束后即可修改";
  if (nodeId === "assets") return runStatus === "running"
    ? "画面只读；如需更换，请先暂停，再修改导演方案中的逐镜来源或提示。"
    : "已经生成的画面只能预览；要更换画面，请修改上方导演方案中的逐镜来源或提示，再继续生成。";
  if (nodeId === "voice") return runStatus === "running"
    ? "声音只读；如需重配，请先暂停，再修改配音指令。"
    : "已经生成的声音只能试听；修改下方配音指令后会重新合成。";
  if (READ_ONLY_NODE_IDS.has(nodeId)) return "技术结果只读；需要调整时请修改上游内容后重跑";
  if (runStatus === "running" && hasDelivery) return "后续节点正在执行；可先暂停，再修改这份交付";
  if (runStatus === "paused" && hasDelivery) return "制作已暂停，可以修改；保存后下游旧结果会自动失效";
  if (source === "human") return "已采用你的修改";
  if (hasDelivery) return "自动生成，可按需修改";
  return status === "pending" ? "等待上游完成" : "本节点没有需要人工阅读的内容";
}

function selectEditableArtifact(nodeId: string, artifacts: StudioArtifact[], effectiveArtifactIds?: string[]): StudioArtifact | undefined {
  const kind = EDITABLE_ARTIFACT_KIND[nodeId];
  if (!kind) return undefined;
  const candidates = artifacts.filter((artifact) => artifact.kind === kind && artifact.contentType === "application/json" && artifact.contentUrl);
  return candidates.find((artifact) => effectiveArtifactIds?.includes(artifact.id)) ?? candidates[0];
}

function selectMaterializedVisualArtifacts(
  node: StudioNode,
  artifacts: StudioArtifact[],
  effectiveArtifactIds?: string[],
): StudioArtifact[] {
  if (node.id !== "assets") return [];
  const candidates = artifacts.filter((artifact) => artifact.contentUrl
    && (artifact.contentType?.startsWith("image/") || artifact.contentType?.startsWith("video/")))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const currentIds = effectiveArtifactIds?.length ? effectiveArtifactIds : node.artifactIds;
  const current = candidates.filter((artifact) => currentIds.includes(artifact.id));
  return current.length ? current : candidates;
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

function NodeExecutionConfigurationEditor({ node, providers, runStatus, busy, onSave }: {
  node: StudioNode;
  providers: StudioProvider[];
  runStatus: StudioRunStatus;
  busy: boolean;
  onSave: (input: StudioNodeExecutionConfigurationInput) => Promise<void>;
}) {
  const configuration = node.executionConfiguration!;
  const [editing, setEditing] = useState(false);
  const [providerId, setProviderId] = useState(configuration.providerId);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({ ...configuration.modelSelections });
  const [assetProviderIds, setAssetProviderIds] = useState<string[]>([...(configuration.assetProviderIds ?? [])]);
  const [error, setError] = useState<string>();
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  const canEdit = providers.length > 0 && !terminal && runStatus !== "running" && node.status !== "running";
  const capability = configurableNodeCapability(node.id);
  const roleProviders = capability
    ? providers.filter((provider) => provider.available && provider.kind !== "test" && provider.capability === capability)
    : [];
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const assetSources = providers.filter((provider) => provider.available
    && provider.kind !== "test"
    && provider.capability === "asset.prepare"
    && provider.id !== "ai-shot-router-v1");
  const selectedAssetSources = assetSources.filter((provider) => assetProviderIds.includes(provider.id));
  const meteredSources = selectedAssetSources.filter((provider) => provider.billing === "metered");
  const selectedProviderModels = selectedProvider
    ? selectableModelsForCapability(selectedProvider.modelProfiles, selectedProvider.capability)
    : [];

  useEffect(() => {
    if (editing) return;
    setProviderId(configuration.providerId);
    setModelSelections({ ...configuration.modelSelections });
    setAssetProviderIds([...(configuration.assetProviderIds ?? [])]);
  }, [configuration, editing]);

  function updateAssetSource(provider: StudioProvider, enabled: boolean) {
    const next = enabled
      ? [...new Set([...assetProviderIds, provider.id])]
      : assetProviderIds.filter((id) => id !== provider.id);
    setAssetProviderIds(next);
  }

  async function save() {
    setError(undefined);
    if (node.id === "assets" && assetProviderIds.length === 0) {
      setError("至少保留一个画面来源。");
      return;
    }
    try {
      const providerModels = node.id === "assets"
        ? Object.fromEntries(assetProviderIds.map((id) => [id, modelSelections[id] ?? null]))
        : { [providerId]: modelSelections[providerId] ?? null };
      await onSave({
        ...(node.id === "assets" ? {} : { providerId }),
        modelSelections: providerModels,
        ...(node.id === "assets" ? {
          assetProviderIds,
          economics: {
            allowMeteredProviders: meteredSources.length > 0,
            maxPaidShots: 0,
            maxCostCny: 0,
          },
        } : {}),
      });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return <section className="node-execution-config" aria-label={`${node.role ?? node.label}本次执行配置`}>
    <header>
      <span><Settings2 aria-hidden="true" size={16} /></span>
      <div><strong>本次执行配置</strong><small>{editing ? "保存后继续制作才会生效，旧费用确认会自动失效" : executionConfigurationSummary(node, providers)}</small></div>
      {canEdit && !editing ? <button className="button button-ghost" type="button" onClick={() => setEditing(true)}>调整</button> : null}
    </header>
    {editing ? <div className="node-execution-config-editor">
      {node.id !== "assets" ? <>
        <label className="field"><span>执行能力</span><select value={providerId} disabled={node.id === "voice" || roleProviders.length < 2} onChange={(event) => setProviderId(event.target.value)}>
          {roleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
        </select></label>
        {selectedProviderModels.length ? <label className="field"><span>本次模型</span><select value={modelSelections[providerId] ?? ""} onChange={(event) => setModelSelections((current) => ({ ...current, [providerId]: event.target.value }))}>
          <option value="">推荐默认：{selectedProvider?.defaultModelId ?? "运行时选择"}</option>
          {selectedProviderModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
        </select></label> : null}
      </> : <>
        <div className="node-asset-source-options">
          {assetSources.map((provider) => {
            const selected = assetProviderIds.includes(provider.id);
            const compatibleModels = selectableModelsForCapability(provider.modelProfiles, provider.capability);
            return <article key={provider.id} className={selected ? "is-selected" : ""}>
              <label><input type="checkbox" checked={selected} onChange={(event) => updateAssetSource(provider, event.target.checked)} /><span><strong>{provider.label}</strong><small>{provider.billing === "metered" ? "按镜头计费" : "免费来源"}</small></span></label>
              {selected && compatibleModels.length ? <select aria-label={`${provider.label}模型`} value={modelSelections[provider.id] ?? ""} onChange={(event) => setModelSelections((current) => ({ ...current, [provider.id]: event.target.value }))}>
                <option value="">推荐默认：{provider.defaultModelId ?? "自动选择"}</option>
                {compatibleModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
              </select> : null}
            </article>;
          })}
        </div>
        {meteredSources.length > 0 ? <div className="node-budget-fields">
          <p>按实际导演方案报价；所有计费节点执行前逐笔人工确认。若报价不合适，可退回导演降低费用。</p>
        </div> : null}
      </>}
      {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => { setError(undefined); setEditing(false); }}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}><Save aria-hidden="true" size={15} />保存配置</button></footer>
    </div> : null}
  </section>;
}

function configurableNodeCapability(nodeId: string): string | undefined {
  return {
    script: "script.draft",
    "visual-direction": "storyboard.plan",
    voice: "voice.synthesize",
    "visual-review": "quality.review.visual",
  }[nodeId];
}

function executionConfigurationSummary(node: StudioNode, providers: StudioProvider[]): string {
  const configuration = node.executionConfiguration!;
  if (node.id === "assets") {
    const sources = (configuration.assetProviderIds ?? []).map((id) => providers.find((provider) => provider.id === id)?.label ?? id);
    const budget = configuration.economics?.allowMeteredProviders
      ? " · 按实际方案报价 · 执行前逐笔确认"
      : " · 当前不调用付费生成";
    return `${sources.join("、") || "未选择来源"}${budget}`;
  }
  const provider = providers.find((candidate) => candidate.id === configuration.providerId);
  const modelId = configuration.modelSelections[configuration.providerId] ?? provider?.defaultModelId ?? "运行时自动选择";
  return `${provider?.label ?? configuration.providerId} · ${modelId}`;
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

function creatorDraftValidationError(nodeId: string, value: unknown, requireModernPresence = true): string | undefined {
  const draft = asRecord(value);
  if (!draft) return "交付内容格式不正确，请检查后再保存。";
  if (nodeId === "brief") {
    return firstRequiredTextError(draft, [
      ["title", "标题"],
      ["angle", "切入角度"],
      ["audience", "目标观众"],
    ], requireModernPresence);
  }
  if (nodeId === "script") {
    const topLevelError = firstRequiredTextError(draft, [
      ["viewerPromise", "观众承诺"],
      ["narrativeArc", "叙事弧线"],
    ]);
    if (topLevelError) return topLevelError;
    return firstCollectionItemError(draft.scenes, "分镜", [
      ["narration", "旁白"],
      ["visual_prompt", "画面提示"],
      ["visible_action", "可见动作"],
    ]);
  }
  if (nodeId === "visual-direction") {
    const topLevelError = firstRequiredTextError(draft, [
      ["profileRationale", "风格选择理由"],
    ]);
    if (topLevelError) return topLevelError;
    const bible = asRecord(draft.visualBible);
    if (!bible) return "视觉圣经不能为空。";
    const bibleError = firstRequiredTextError(bible, [
      ["narrativeApproach", "叙事方式"],
      ["pacing", "节奏"],
      ["composition", "构图"],
      ["camera", "镜头运动"],
      ["color", "色彩"],
      ["continuity", "连续性"],
      ["sound", "声音"],
    ]);
    if (bibleError) return bibleError;
    return firstCollectionItemError(draft.shots, "镜头计划", [
      ["narrativeRole", "镜头任务"],
      ["preferredProviderId", "首选画面能力"],
      ["query", "素材检索词"],
      ["generationPrompt", "生成提示"],
      ["rationale", "选择理由"],
      ["continuityNote", "连续性"],
    ]);
  }
  return undefined;
}

function creatorInputDraftValidationError(value: unknown): string | undefined {
  const input = asRecord(value);
  if (!input) return "输入内容格式不正确，请检查后再保存。";
  const containers: Array<[key: string, nodeId: string]> = [
    ["brief", "brief"],
    ["script", "script"],
    ["visualDirection", "visual-direction"],
    ["directorPlan", "visual-direction"],
  ];
  for (const [key, nodeId] of containers) {
    if (!(key in input)) continue;
    const error = creatorDraftValidationError(nodeId, input[key], false);
    if (error) return `${key === "brief" ? "内容简报" : key === "script" ? "脚本" : "导演方案"}：${error}`;
  }
  return undefined;
}

function firstRequiredTextError(
  value: Record<string, unknown>,
  fields: Array<[key: string, label: string]>,
  requirePresence = false,
): string | undefined {
  const missing = fields.find(([key]) => (
    (requirePresence || key in value)
    && (typeof value[key] !== "string" || !(value[key] as string).trim())
  ));
  return missing ? `${missing[1]}不能为空。` : undefined;
}

function firstCollectionItemError(
  value: unknown,
  collectionLabel: string,
  fields: Array<[key: string, label: string]>,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return `${collectionLabel}不能为空。`;
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `${collectionLabel}第 ${index + 1} 项格式不正确。`;
    const error = firstRequiredTextError(record, fields);
    if (error) return `${collectionLabel}第 ${index + 1} 项：${error}`;
  }
  return undefined;
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
