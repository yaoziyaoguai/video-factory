import { AlertTriangle, Check, ChevronDown, CircleDollarSign, FilePenLine, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StudioArtifact, StudioBillingType, StudioNode, StudioNodeExecutionReceipt, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioRunStatus, StudioSpendAuthorizationInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { providerLabel } from "../presentation.js";
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

type NodeWorkspaceTab = "input" | "role" | "prompt" | "output" | "evidence";

export function NodeWorkspace({ node, nodes = [node], runStatus, artifacts, busy, onOverride, onInputOverride = async () => undefined, onAuthorize }: NodeWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<NodeWorkspaceTab>("output");
  const [editing, setEditing] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  const [outputEditorMode, setOutputEditorMode] = useState<"form" | "json">("form");
  const [inputEditorMode, setInputEditorMode] = useState<"form" | "json">("form");
  const [authorizing, setAuthorizing] = useState(false);
  const [draft, setDraft] = useState(() => pretty(node.output ?? effectiveOutput(node) ?? {}));
  const [inputDraft, setInputDraft] = useState(() => pretty(effectiveInput(node) ?? {}));
  const [error, setError] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<unknown>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string>();
  const [modelTrace, setModelTrace] = useState<Record<string, unknown>>();
  const [modelTraceLoading, setModelTraceLoading] = useState(false);
  const [modelTraceError, setModelTraceError] = useState<string>();
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
  const modelTraceArtifact = useMemo(
    () => selectModelTraceArtifact(node.id, artifacts, effectiveVersion?.artifactIds),
    [artifacts, effectiveVersion?.artifactIds, node.id],
  );
  const spendInputs = useMemo(() => node.spendPlan?.inputVersionIds.map((versionId) => {
    const inputOwner = nodes.find((candidate) => candidate.inputState?.versions.some((version) => version.id === versionId));
    const outputOwner = nodes.find((candidate) => candidate.outputState?.versions.some((version) => version.id === versionId));
    const owner = inputOwner ?? outputOwner;
    const source = inputOwner?.inputState?.versions.find((candidate) => candidate.id === versionId)?.source
      ?? outputOwner?.outputState?.versions.find((candidate) => candidate.id === versionId)?.source;
    return { versionId, label: inputOwner ? `${owner?.label ?? "节点"}输入` : owner?.label ?? "上游交付", role: owner?.role ?? "生产角色", source };
  }) ?? [], [node.spendPlan?.inputVersionIds, nodes]);
  const hasStructuredOutput = node.output !== undefined || effectiveOutput(node) !== undefined;
  const canEdit = (hasStructuredOutput || documentPreview !== undefined) && runStatus !== "running" && node.status !== "pending" && node.status !== "running" && node.status !== "awaiting_spend_approval";
  const canEditInput = effectiveInputVersion !== undefined && runStatus !== "running" && node.status !== "running" && node.status !== "pending";
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  const provenance = useMemo(() => execution
    ? `${providerLabel(execution.providerId) ?? execution.providerLabel} · ${execution.modelId}`
    : node.spendPlan
      ? `${providerLabel(node.spendPlan.providerId) ?? node.spendPlan.providerId} · ${node.spendPlan.modelId}`
      : "尚未规划", [execution, node.spendPlan]);

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

  useEffect(() => {
    if (!modelTraceArtifact?.contentUrl) {
      setModelTrace(undefined);
      setModelTraceError(undefined);
      setModelTraceLoading(false);
      return;
    }
    const controller = new AbortController();
    setModelTraceLoading(true);
    setModelTraceError(undefined);
    void fetch(modelTraceArtifact.contentUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
      const content = await response.json() as unknown;
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        throw new Error("执行痕迹格式不正确");
      }
      return content as Record<string, unknown>;
    }).then((content) => {
      setModelTrace(content);
      setModelTraceLoading(false);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setModelTraceError(caught instanceof Error ? caught.message : "读取失败");
      setModelTraceLoading(false);
    });
    return () => controller.abort();
  }, [modelTraceArtifact?.contentUrl]);

  function beginEditing() {
    const usesDocument = Boolean(editableArtifact && documentPreview !== undefined);
    setEditingDocument(usesDocument);
    setDraft(pretty(usesDocument ? documentPreview : node.output ?? effectiveOutput(node) ?? {}));
    setOutputEditorMode("form");
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
      open={node.status === "awaiting_spend_approval" || node.status === "approval_invalidated"}
      onToggle={(event) => revealExpandedWorkspace(event.currentTarget)}
    >
      <summary>
        <span className="node-workspace-state">{node.status === "succeeded" ? <Check aria-hidden="true" size={14} /> : <span />}</span>
        <span className="node-workspace-title"><strong>{node.label}</strong><small>{node.role ?? "生产角色"}</small></span>
        <span className="node-workspace-provenance">{provenance}</span>
        {node.outputState?.stale ? <span className="node-stale-label"><AlertTriangle aria-hidden="true" size={14} />旧结果</span> : null}
        <ChevronDown className="node-workspace-chevron" aria-hidden="true" size={17} />
      </summary>
      <div className="node-workspace-body">
        {node.outputState?.stale ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} />此节点结果已经过期，后续成片不会继续采用它。请检查人工版本后重新生成。</p> : null}
        <div className="node-workspace-tabs" role="tablist" aria-label={`${node.label}工作区`}>
          {([
            ["input", "输入"],
            ["role", "角色与模型"],
            ["prompt", "实际 Prompt"],
            ["output", "输出"],
            ["evidence", "执行证据"],
          ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} onClick={() => setActiveTab(id)}>{label}</button>)}
        </div>

        {node.spendPlan ? (
          <section className="spend-gate" aria-label={`${node.label}费用确认`}>
            <div><CircleDollarSign aria-hidden="true" size={20} /><span><strong>执行前费用确认</strong><small>预计 ¥{node.spendPlan.estimatedCostCny.toFixed(2)}，最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} · 最多 {node.spendPlan.maxAttempts} 次</small></span></div>
            {node.spendAuthorizationId ? <span className="spend-authorized"><ShieldCheck aria-hidden="true" size={15} />已授权</span> : (
              <button className="button button-primary" type="button" disabled={busy} onClick={() => setAuthorizing(true)}><ShieldCheck aria-hidden="true" size={16} />检查并确认</button>
            )}
          </section>
        ) : null}

        {activeTab === "input" ? <section className="node-output-preview" role="tabpanel">
          <header><div><strong>本次实际输入</strong><small>{inputSourceLabel(effectiveInputVersion?.source)}{node.inputState?.stale ? " · 上游已变化，需复核" : ""}</small></div>{canEditInput && !editingInput ? <button className="button button-ghost" type="button" onClick={() => setEditingInput(true)}><FilePenLine aria-hidden="true" size={15} />编辑输入</button> : null}</header>
          {editingInput ? <><EditorMode value={inputEditorMode} onChange={setInputEditorMode} />{inputEditorMode === "form" ? <NodeStructuredEditor nodeId={`${node.id}-input`} value={safeParse(inputDraft)} onChange={(value) => setInputDraft(pretty(value))} /> : <textarea aria-label={`${node.label}输入内容 JSON`} value={inputDraft} onChange={(event) => setInputDraft(event.target.value)} rows={12} spellCheck={false} />}</> : <NodeDeliveryPreview nodeId={`${node.id}-input`} value={effectiveInput(node)} />}
          {editingInput ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => setEditingInput(false)}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride()}><Save aria-hidden="true" size={15} />保存为人工输入版本</button></footer> : null}
          {!editingInput ? <details className="node-technical-output"><summary>查看完整输入 JSON</summary><pre>{pretty(effectiveInput(node) ?? {})}</pre></details> : null}
          {effectiveInputVersion ? <p className="node-version-note">有效输入版本 {shortId(effectiveInputVersion.id)} · 上游 {effectiveInputVersion.upstreamVersionIds.length} 个版本{effectiveInputVersion.source === "reconstructed" ? " · 历史记录未保存原始输入，本值由当前上游产物推断" : ""}</p> : <p className="node-document-state">节点开始执行后会记录实际输入。</p>}
        </section> : null}

        {activeTab === "role" ? <section className="node-output-preview" role="tabpanel">
          <header><div><strong>{node.role ?? "生产角色"}</strong><small>本节点实际使用的能力与模型</small></div></header>
          <div className="node-evidence-row">
            <span><b>角色</b>{node.role ?? "生产角色"}</span>
            <span><b>Provider / API</b>{execution?.providerId ?? node.spendPlan?.providerId ?? "待选择"}</span>
            <span><b>模型</b>{execution?.modelId ?? node.spendPlan?.modelId ?? "待执行"}</span>
            {receipt?.actualModelIds?.length ? <span><b>实际调用模型</b>{receipt.actualModelIds.join("、")}</span> : null}
            <span><b>配置来源</b>{configurationSourceLabel(execution?.configurationSource, Boolean(receipt))}</span>
            <span><b>计费</b>{billingLabel(execution?.billing, execution?.estimatedCostCny)}</span>
          </div>
          {!receipt && node.plannedExecution ? <p className="node-version-note">{node.plannedExecution.snapshotSource === "reconstructed"
            ? "这是旧任务兼容重建的执行计划，可能与历史创建时配置不同；节点已有真实凭证时以凭证为准。"
            : "这是创建任务时保存的执行计划；节点完成后会由真实执行凭证覆盖。"}</p> : null}
          {execution?.parameters && Object.keys(execution.parameters).length ? <details className="node-technical-output"><summary>{receipt ? "查看本次实际参数" : "查看计划参数"}</summary><pre>{pretty(execution.parameters)}</pre></details> : null}
        </section> : null}

        {activeTab === "prompt" ? <section className="node-output-preview" role="tabpanel">
          <header><div><strong>模型实际收到的 Prompt</strong><small>只读执行痕迹，不随人工修改被覆盖</small></div></header>
          {modelTraceLoading ? <p className="node-document-state">正在读取模型执行痕迹...</p> : modelTraceError ? <p className="node-workspace-error" role="alert">执行痕迹读取失败：{modelTraceError}</p> : modelTrace ? <>
            <div className="node-evidence-row">
              <span><b>Prompt Pack</b>{traceText(modelTrace.promptVersion)}</span>
              <span><b>任务</b>{traceText(modelTrace.taskKind)}</span>
              <span><b>Provider / API</b>{traceText(modelTrace.providerId)}</span>
              <span><b>模型</b>{traceText(modelTrace.modelId)}</span>
            </div>
            <pre className="node-actual-prompt">{traceText(modelTrace.prompt)}</pre>
          </> : <p className="node-document-state">此历史节点尚未记录 Prompt；重新执行模型节点后会在这里留下不可变痕迹。</p>}
        </section> : null}

        {activeTab === "output" ? <section className="node-output-preview" role="tabpanel">
          <header><div><strong>角色交付</strong><small>{effectiveVersion?.source === "human" ? "人工修改版本" : editableArtifact ? "可编辑结构化交付" : "自动生成版本"}</small></div>{canEdit && !editing && (!editableArtifact || documentPreview !== undefined) ? <button className="button button-ghost" type="button" onClick={beginEditing}><FilePenLine aria-hidden="true" size={15} />编辑</button> : null}</header>
          {editing ? <><EditorMode value={outputEditorMode} onChange={setOutputEditorMode} />{outputEditorMode === "form" ? <NodeStructuredEditor nodeId={node.id} value={safeParse(draft)} onChange={(value) => setDraft(pretty(value))} /> : <textarea aria-label={`${node.label}交付内容 JSON`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={12} spellCheck={false} />}</> : documentLoading ? <p className="node-document-state">正在读取结构化交付...</p> : documentError ? <p className="node-workspace-error" role="alert">结构化交付读取失败：{documentError}</p> : <NodeDeliveryPreview nodeId={node.id} value={documentPreview ?? node.output ?? effectiveOutput(node)} />}
          {editing ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => setEditing(false)}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride()}><Save aria-hidden="true" size={15} />保存为人工版本</button></footer> : null}
          {!editing && !documentLoading && !documentError ? <details className="node-technical-output"><summary>查看完整交付 JSON</summary><pre>{pretty(documentPreview ?? node.output ?? effectiveOutput(node) ?? {})}</pre></details> : null}
          {editableArtifact ? <details className="node-technical-output"><summary>查看节点执行记录</summary><pre>{pretty(node.output ?? effectiveOutput(node) ?? {})}</pre></details> : null}
        </section> : null}

        {activeTab === "evidence" ? <section className="node-output-preview" role="tabpanel">
          <header><div><strong>不可变执行证据</strong><small>费用、请求和版本链只读</small></div></header>
          <div className="node-evidence-row">
            <span><b>输入版本</b>{shortId(node.inputState?.effectiveVersionId) ?? "尚无"}</span>
            <span><b>输出版本</b>{shortId(node.outputState?.effectiveVersionId) ?? "尚无"}</span>
            <span><b>请求编号</b>{receipt?.requestId ?? "未提供"}</span>
            <span><b>费用</b>{receipt?.actualCostCny !== undefined ? `${receipt.actualCostSource === "configured_rate" ? "按配置单价核算" : "账单实付"} ¥${receipt.actualCostCny.toFixed(2)}` : receipt?.authorizedCostCny !== undefined ? `已授权 ¥${receipt.authorizedCostCny.toFixed(2)}` : billingLabel(receipt?.billing, receipt?.estimatedCostCny)}</span>
          </div>
          <details className="node-technical-output"><summary>查看执行凭证 JSON</summary><pre>{pretty({ receipt, spendPlan: node.spendPlan, spendAuthorizationId: node.spendAuthorizationId, qualityGateResults: node.qualityGateResults })}</pre></details>
        </section> : null}

        {artifacts.length ? <div className="node-artifact-links">{artifacts.map((artifact) => artifact.contentUrl ? (
          <a href={artifact.contentUrl} key={artifact.id}>{artifact.kind}<small>{artifact.providerId ?? artifact.schemaVersion ?? "产物"}</small></a>
        ) : (
          <span className="node-artifact-unavailable" aria-disabled="true" title="该产物没有可读取的文件地址" key={artifact.id}>{artifact.kind}<small>暂不可打开 · 尚无文件地址</small></span>
        ))}</div> : null}
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

function revealExpandedWorkspace(workspace: HTMLDetailsElement): void {
  if (
    !workspace.open
    || typeof window === "undefined"
    || typeof window.matchMedia !== "function"
    || !window.matchMedia("(max-width: 700px)").matches
  ) return;
  window.requestAnimationFrame(() => workspace.scrollIntoView({ block: "start" }));
}

function EditorMode({ value, onChange }: { value: "form" | "json"; onChange: (value: "form" | "json") => void }) {
  return <div className="node-editor-mode" role="group" aria-label="编辑方式"><button type="button" aria-pressed={value === "form"} className={value === "form" ? "is-active" : undefined} onClick={() => onChange("form")}>表单</button><button type="button" aria-pressed={value === "json"} className={value === "json" ? "is-active" : undefined} onClick={() => onChange("json")}>JSON 专家</button></div>;
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

function selectEditableArtifact(nodeId: string, artifacts: StudioArtifact[], effectiveArtifactIds?: string[]): StudioArtifact | undefined {
  const kind = EDITABLE_ARTIFACT_KIND[nodeId];
  if (!kind) return undefined;
  const candidates = artifacts.filter((artifact) => artifact.kind === kind && artifact.contentType === "application/json" && artifact.contentUrl);
  return candidates.find((artifact) => effectiveArtifactIds?.includes(artifact.id)) ?? candidates[0];
}

function selectModelTraceArtifact(nodeId: string, artifacts: StudioArtifact[], effectiveArtifactIds?: string[]): StudioArtifact | undefined {
  const candidates = artifacts.filter((artifact) => artifact.kind === "model_trace"
    && artifact.producerNodeId === nodeId
    && artifact.contentType === "application/json"
    && artifact.contentUrl);
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

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function traceText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "未记录";
}

function inputSourceLabel(source: "derived" | "human" | "reconstructed" | undefined): string {
  if (source === "human") return "人工输入版本";
  if (source === "reconstructed") return "历史任务推断输入";
  return "由上游自动派生";
}

function shortId(value: string | undefined): string | undefined {
  return value && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function billingLabel(billing: StudioBillingType | undefined, estimated?: number): string {
  if (billing === "metered") return estimated === undefined ? "按量付费" : `预计 ¥${estimated.toFixed(2)}`;
  if (billing === "subscription") return "订阅额度";
  if (billing === "local_compute") return "本地计算";
  if (billing === "human") return "人工";
  return "免费 / 待统计";
}

function configurationSourceLabel(source: StudioNodeExecutionReceipt["configurationSource"], hasReceipt: boolean): string {
  if (source === "node_override") return "节点人工覆盖";
  if (source === "run_override") return "本次制作覆盖";
  if (source === "template_default") return "模板默认";
  if (source === "global_default") return "全局默认";
  if (source === "system_default") return "系统默认";
  return hasReceipt ? "历史凭证未记录" : "待执行";
}
