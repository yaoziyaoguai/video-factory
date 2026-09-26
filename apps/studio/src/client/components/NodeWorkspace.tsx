import { AlertTriangle, Check, ChevronDown, CircleDollarSign, Clock3, FilePenLine, Pause, Save, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioArtifact, StudioNode, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioProductionQuote, StudioProvider, StudioRunStatus, StudioSpendAuthorizationInput, StudioSpendRejectionInput } from "../../shared/api.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { studioApi } from "../api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { agentLoopPendingNote, agentLoopPhaseLabel, catalogModelLabel, creatorFacingTechnicalText, providerLabel, providerModelLabel, reasoningEffortLabel } from "../presentation.js";
import { hasCreatorDocumentContent } from "../creator-document-policy.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";
import { NodeDocumentCommands } from "./NodeDocumentCommands.js";
import { NodeContentReview, nodeContentReview } from "./NodeContentReview.js";
import { NodeDocumentHistory } from "./NodeDocumentHistory.js";
import { unsplashPublicUrl } from "./UnsplashAttribution.js";
import { hasStockAttribution, StockAttribution } from "./StockAttribution.js";
import { NodeStructuredEditor } from "./NodeStructuredEditor.js";
import { PlanningStagesPanel } from "./PlanningStagesPanel.js";
import { PlanningDeliveryPanel } from "./PlanningDeliveryPanel.js";
import type { StudioPlanningEditableStage, StudioPlanningStage } from "../../shared/api.js";

// 编辑器内的输入草稿类型：不含并发 token。wire DTO（含 expectedRunRevision/expectedVersionId）
// 只在保存时由保存逻辑用打开编辑器时捕获的基线构造。
type StudioNodeInputDraft = { input: unknown };

interface NodeWorkspaceProps {
  node: StudioNode;
  nodes?: StudioNode[];
  providers?: StudioProvider[];
  runStatus: StudioRunStatus;
  /** C2：制作范围授权需要 run 身份与当前方案 digest。 */
  runId: string;
  runRevision: number;
  acceptedPlanDigest: string;
  artifacts: StudioArtifact[];
  busy: boolean;
  readOnly?: boolean;
  pauseBusy?: boolean;
  pauseRequested?: boolean;
  /** joint-v1 创作规划节点的真实阶段投影；其他节点不传。 */
  planningStages?: StudioPlanningStage[];
  onPendingPlanningConfigurationChange?: (pending: boolean) => void;
  onRequestPause?: () => Promise<void>;
  onOverride: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onInputOverride?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  /** 发布文案的 AI 修订与主动再审；未接线的宿主不传，交付区不显示这两个控件。 */
  onReviseDocument?: (nodeId: string, input: { instruction: string; expectedRunRevision: number; expectedVersionId: string; confirmTerminalEdit?: boolean }) => Promise<void>;
  onAuditDocument?: (nodeId: string, input: { expectedRunRevision: number; expectedVersionId: string }) => Promise<void>;
  onConfigure?: (nodeId: string, input: StudioNodeExecutionConfigurationInput) => Promise<void>;
  onAuthorize: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRejectSpend?: (nodeId: string, input: StudioSpendRejectionInput) => Promise<void>;
}

export function NodeWorkspace({ node, nodes = [node], providers = [], runStatus, runId, runRevision, acceptedPlanDigest, artifacts, busy, readOnly = false, pauseBusy = false, pauseRequested = false, planningStages, onPendingPlanningConfigurationChange, onRequestPause, onOverride, onInputOverride = async () => undefined, onReviseDocument, onAuditDocument, onConfigure = async () => undefined, onAuthorize, onRejectSpend = async () => undefined }: NodeWorkspaceProps) {
  const shouldOpenForAttention = node.status === "awaiting_spend_approval" || node.status === "approval_invalidated" || node.status === "failed";
  const [workspaceOpen, setWorkspaceOpen] = useState(shouldOpenForAttention);
  const [inputReviewOpen, setInputReviewOpen] = useState(shouldOpenForAttention);
  const [editing, setEditing] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [rejectingSpend, setRejectingSpend] = useState(false);
  const [spendRejectionReason, setSpendRejectionReason] = useState<StudioSpendRejectionInput["reason"]>("too_expensive");
  const [targetEstimatedCostCny, setTargetEstimatedCostCny] = useState("");
  const [scopeMaximumCny, setScopeMaximumCny] = useState("");
  const [scopeAuthorizing, setScopeAuthorizing] = useState(false);
  // C2：已向服务端取得、正在向用户展示的报价；授权只接受这份报价。
  const [pendingQuote, setPendingQuote] = useState<{ quote: StudioProductionQuote; preparedAtRevision: number }>();
  const [spendRejectionNote, setSpendRejectionNote] = useState("");
  const [draft, setDraft] = useState(() => pretty(effectiveOutput(node) ?? node.output ?? {}));
  const [inputDraft, setInputDraft] = useState(() => pretty(effectiveInput(node) ?? {}));
  const [editingPlanningStageId, setEditingPlanningStageId] = useState<StudioPlanningEditableStage>();
  // 输入草稿基线绑定打开编辑器时观察到的 run revision 与输入版本：保存时使用基线，
  // 后台 props 刷新不得把旧草稿的提交基准无声升级到新版本。
  const [inputEditBaseline, setInputEditBaseline] = useState<{ runRevision: number; versionId: string }>();
  const [error, setError] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<unknown>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string>();
  const [terminalOverride, setTerminalOverride] = useState<StudioNodeOverrideInput>();
  const [terminalInputOverride, setTerminalInputOverride] = useState<StudioNodeInputDraft>();
  const spendDialogRef = useDialogFocus<HTMLElement>(authorizing, () => {
    setError(undefined);
    setAuthorizing(false);
  }, busy);
  const spendRejectionDialogRef = useDialogFocus<HTMLElement>(rejectingSpend, () => {
    setError(undefined);
    setRejectingSpend(false);
  }, busy);
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
    return { versionId, label: inputOwner ? `${owner?.label ?? "制作步骤"}输入` : owner?.label ?? "前序交付", role: owner?.role ?? "制作角色", source };
  }) ?? [], [node.spendPlan?.inputVersionIds, nodes]);
  const hasStructuredOutput = node.output !== undefined || effectiveOutput(node) !== undefined;
  const outputReadOnly = READ_ONLY_OUTPUT_NODE_IDS.has(node.id);
  const nodeReadOnly = READ_ONLY_NODE_IDS.has(node.id);
  const paidRecoveryLocked = nodes.some((candidate) => candidate.outcomeUncertain === true);
  const canEdit = !readOnly && !paidRecoveryLocked && !outputReadOnly && node.id !== "creative-planning" && (hasStructuredOutput || documentPreview !== undefined) && runStatus !== "running" && node.status !== "pending" && node.status !== "running" && node.status !== "awaiting_spend_approval";
  const canEditInput = !readOnly && !paidRecoveryLocked && !nodeReadOnly && effectiveInputVersion !== undefined && runStatus !== "running" && node.status !== "running" && node.status !== "pending";
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  // 创作规划节点自己的"本次制作选择"只有编剧这一项能力，而阶段模型是逐个阶段挂在简报上的：
  // 同时给出两个说法不同的控件，其中一个还会因为节点没有可切换能力而显示成"已失效"。
  // 规划节点只留阶段面板这一个入口，且只在阶段面板真的在时才撤掉节点级编辑器。
  const showPlanningStages = node.id === "creative-planning" && Boolean(planningStages?.length);
  const fallbackReason = useMemo(() => agentFallbackReason(execution), [execution]);
  const executionTiming = useMemo(() => executionTimingDetails(receipt), [receipt]);
  const modelBackupUsed = (execution?.actualModelIds?.length ?? 0) > 1;
  const fallbackHeading = modelBackupUsed
    ? receipt?.status === "succeeded"
      ? "首选模型暂时不可用，替补模型已完成"
      : receipt?.status === "rejected" && ["asset-source-review", "visual-review"].includes(node.id)
        ? "替补模型已完成审片，画面需要修改"
        : "已尝试替补模型，但本步骤仍未完成"
    : "智能复核未完成，已使用基础方案";
  const capability = useMemo(() => fallbackReason
    ? `${fallbackHeading} · ${fallbackReason}`
    : creatorCapabilityLabel(execution, node.spendPlan, providers), [execution, fallbackHeading, fallbackReason, node.spendPlan, providers]);
  const assetProviderIds = useMemo(() => configuredAssetProviderIds(nodes), [nodes]);
  const editableAssetProviders = useMemo(
    () => providers.filter((provider) => assetProviderIds.includes(provider.id)),
    [assetProviderIds, providers],
  );
  const deliveryValue = documentPreview ?? effectiveOutput(node) ?? node.output;
  const contentReview = node.id === "reference-grammar" || node.id === "publish-package"
    ? nodeContentReview(effectiveOutput(node) ?? node.output)
    : undefined;
  const planningVersionArtifactIds = node.id === "creative-planning" ? effectiveVersion?.artifactIds ?? [] : [];
  const verifiedPlanningArtifactIds = new Set(planningStages?.flatMap((stage) => stage.artifactIds) ?? []);
  const planningArtifactIds = planningVersionArtifactIds.filter((id) => verifiedPlanningArtifactIds.has(id));
  const hasDelivery = node.id === "creative-planning"
    ? planningVersionArtifactIds.length > 0
    : hasCreatorDocumentContent(node.id, deliveryValue);
  const hasEditableInput = node.id !== "brief" && hasCreatorDocumentContent(`${node.id}-input`, effectiveInput(node));
  const inputSources = useMemo(
    () => creatorInputSources(node, nodes, effectiveInputVersion),
    [effectiveInputVersion, node, nodes],
  );
  const hasReviewableInput = hasEditableInput || inputSources.length > 0;
  const canRequestPause = !readOnly && runStatus === "running" && node.status === "succeeded" && (hasDelivery || hasReviewableInput) && onRequestPause !== undefined;

  useEffect(() => {
    if (!editing) setDraft(pretty(documentPreview ?? effectiveOutput(node) ?? node.output ?? {}));
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
    void studioApi.resourceJson(editableArtifact.contentUrl, controller.signal).then((content) => {
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
    setDraft(pretty(usesDocument ? documentPreview : effectiveOutput(node) ?? node.output ?? {}));
    setEditing(true);
  }

  function cancelEditing() {
    setError(undefined);
    setEditing(false);
  }

  function cancelInputEditing() {
    setError(undefined);
    setEditingInput(false);
    setEditingPlanningStageId(undefined);
    setInputEditBaseline(undefined);
  }

  // 打开输入编辑器的唯一入口：草稿内容与并发基线（run revision + 输入版本）都在这一刻固定。
  function beginInputEditing(stageId?: StudioPlanningEditableStage) {
    setError(undefined);
    setEditingPlanningStageId(stageId);
    setInputDraft(pretty(effectiveInput(node) ?? {}));
    setInputEditBaseline({ runRevision, versionId: effectiveInputVersion?.id ?? "" });
    setEditingInput(true);
    setWorkspaceOpen(true);
    setInputReviewOpen(true);
  }

  function beginPlanningStageInputEdit(stageId: StudioPlanningStage["id"]) {
    beginInputEditing(stageId as StudioPlanningEditableStage);
  }

  // 输入编辑器渲染在本工作区靠下的位置：不滚过去的话，「编辑某一阶段的输入」点完看起来
  // 毫无反应，用户会以为按钮坏了，直到自己往下拖动页面才发现编辑器早就打开了（真实
  // dogfood 反馈）。打开即把编辑器滚进视野。
  const inputEditorSectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!editingInput) return;
    const section = inputEditorSectionRef.current;
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [editingInput, editingPlanningStageId]);

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

  async function saveInputOverride(confirmTerminalEdit = false, preparedOverride?: StudioNodeInputDraft) {
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
      // 提交基线使用打开编辑器时捕获的版本：props 在编辑期间更新不会替换基线；
      // 基线缺失（理论不可达）时拒绝提交，不无声改用当前 props。
      const baseline = inputEditBaseline;
      if (!baseline) {
        setError("编辑会话已失效，请重新打开编辑后再保存。");
        return;
      }
      await onInputOverride(node.id, {
        ...parsed,
        expectedRunRevision: baseline.runRevision,
        expectedVersionId: baseline.versionId,
        ...(editingPlanningStageId ? { planningStageId: editingPlanningStageId } : {}),
        ...(confirmTerminalEdit ? { confirmTerminalEdit: true } : {}),
      });
      setEditingInput(false);
      setEditingPlanningStageId(undefined);
      setInputEditBaseline(undefined);
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
        spendPlanId: node.spendPlan.id,
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

  // C2：制作范围授权的两阶段流——第一次点击只向服务端索取不可变报价并展示；
  // 用户看到明确金额后第二次点击才接受同一份报价。prepare 不授权，accept 不重算价。
  async function prepareProductionScopeQuote() {
    if (!node.spendPlan) return;
    setError(undefined);
    const maximum = scopeMaximumCny.trim() ? Number(scopeMaximumCny) : undefined;
    if (maximum !== undefined && (!Number.isFinite(maximum) || maximum <= 0)) {
      setError("本次最高授权额必须是大于 0 的有效金额。");
      return;
    }
    if (maximum !== undefined && maximum < node.spendPlan.estimatedCostCny) {
      setError(`当前方案预计花费 ¥${node.spendPlan.estimatedCostCny.toFixed(2)}，高于你填写的最高授权额；请提高额度或调整方案。`);
      return;
    }
    setScopeAuthorizing(true);
    try {
      const quote = await studioApi.prepareProductionQuote(runId, {
        expectedRunRevision: runRevision,
        acceptedPlanDigest: acceptedPlanDigest,
        ...(maximum !== undefined ? { requestedMaximumCny: maximum } : {}),
      });
      setPendingQuote({ quote, preparedAtRevision: runRevision });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  async function acceptPendingScopeQuote() {
    if (!pendingQuote) return;
    setError(undefined);
    setScopeAuthorizing(true);
    try {
      await studioApi.authorizeProductionScope(runId, {
        expectedRunRevision: pendingQuote.preparedAtRevision,
        quoteId: pendingQuote.quote.quoteId,
        acceptedPlanDigest: pendingQuote.quote.acceptedPlanDigest,
        idempotencyKey: `scope-${runId}-${pendingQuote.quote.quoteId}`,
      });
      setPendingQuote(undefined);
      setAuthorizing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  // C2：funding 三动作之"同意追加并继续"——追加额只能来自服务端保存的 funding request
  // （prepare 在已有活动授权时生成），客户端不能自报差额。
  async function acceptFundingAmendment() {
    const assessment = node.spendAssessment;
    if (!assessment || assessment.action !== "request_approval") return;
    setError(undefined);
    setScopeAuthorizing(true);
    try {
      const quote = await studioApi.prepareProductionQuote(runId, {
        expectedRunRevision: runRevision,
        acceptedPlanDigest: acceptedPlanDigest,
        requestedMaximumCny: assessment.resultingMaximumCents / 100,
      });
      if (!quote.fundingRequestId || !quote.fundingAuthorizationId) {
        throw new Error("服务端没有生成追加请求，请刷新后重新获取。");
      }
      await studioApi.amendProductionScope(runId, quote.fundingAuthorizationId, {
        expectedRunRevision: runRevision,
        fundingRequestId: quote.fundingRequestId,
        idempotencyKey: `amend-${runId}-${quote.fundingRequestId}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  async function rejectSpend() {
    if (!node.spendPlan) return;
    setError(undefined);
    const target = targetEstimatedCostCny.trim() ? Number(targetEstimatedCostCny) : undefined;
    if (target !== undefined && (!Number.isFinite(target) || target < 0 || target > 100_000)) {
      setError("下一版降本目标必须在 0 到 100000 元之间。");
      return;
    }
    if (target !== undefined && target >= node.spendPlan.estimatedCostCny) {
      setError(`下一版降本目标必须低于当前报价 ¥${node.spendPlan.estimatedCostCny.toFixed(2)}。`);
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
      aria-label={`${node.label} · ${node.role ?? "制作角色"}`}
      open={workspaceOpen}
      onToggle={(event) => {
        setWorkspaceOpen(event.currentTarget.open);
        revealExpandedWorkspace(event.currentTarget);
      }}
    >
      <summary>
        <span className="node-workspace-state">{node.status === "succeeded" ? <Check aria-hidden="true" size={14} /> : <span />}</span>
        <span className="node-workspace-title"><strong>{node.label}</strong><small>{node.role ?? "制作角色"}</small></span>
        {capability && !showPlanningStages ? <span className="node-workspace-provenance">{capability}</span> : <span />}
        {node.outputState?.stale ? <span className="node-stale-label"><AlertTriangle aria-hidden="true" size={14} />旧结果</span> : null}
        <ChevronDown className="node-workspace-chevron" aria-hidden="true" size={17} />
      </summary>
      <div className="node-workspace-body">
        {readOnly ? <p className="node-workspace-warning"><AlertTriangle aria-hidden="true" size={16} />旧版工作流结果只读；要继续修改，请基于这版重新制作。</p> : null}
        {showPlanningStages && capability ? <details className="node-capability-details"><summary>本次使用的创作服务</summary><p>{capability}</p></details> : null}
        {node.agentLoopProgress ? <div className={`agent-loop-progress is-${node.agentLoopProgress.phase}`} role="status">
          <strong>{agentLoopPhaseLabel(node.agentLoopProgress)}</strong>
          {node.agentLoopProgress.latestAudit ? <span>上一轮 {node.agentLoopProgress.latestAudit.score} 分：{node.agentLoopProgress.latestAudit.summary}</span> : <span>{agentLoopPendingNote(node.agentLoopProgress)}</span>}
          <span>实际模型调用：创作 {node.agentLoopProgress.producerModelCallCount ?? 0} 次，审计 {node.agentLoopProgress.auditModelCallCount ?? 0} 次{(node.agentLoopProgress.structuredRepairModelCallCount ?? 0) > 0 ? `（其中结构修复 ${node.agentLoopProgress.structuredRepairModelCallCount} 次）` : ""}。查询、刷新和等待不计为新调用。</span>
        </div> : null}
        {fallbackReason ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} /><span><strong>{fallbackHeading}</strong>：{fallbackReason}</span></p> : null}
        {node.outputState?.stale ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} />这一步的结果已经过期，后续成片不会继续采用它。请检查人工版本后重新生成；仍然适用的部分会自动保留，不会全部重做。</p> : null}
        {node.executionConfiguration && !showPlanningStages ? <NodeExecutionConfigurationEditor
          node={node}
          providers={providers}
          runStatus={runStatus}
          runRevision={runRevision}
          busy={busy}
          readOnly={readOnly}
          paidRecoveryLocked={paidRecoveryLocked}
          onSave={(input) => onConfigure(node.id, input)}
        /> : null}
        {executionTiming ? <details className="node-execution-timing">
          <summary><Clock3 aria-hidden="true" size={15} /><span><strong>这一步为什么用了这些时间</strong><small>{executionTiming.summary}</small></span><ChevronDown aria-hidden="true" size={15} /></summary>
          <div>
            <p>内容先生成，再由独立模型做质量复核；复核未通过时会按意见修订。只有首选模型暂时不可用时，才会切换到替补模型。</p>
            <div className="node-evidence-row">
              {executionTiming.items.map((item) => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}
            </div>
          </div>
        </details> : null}
        {canRequestPause ? <div className="node-pause-edit">
          <span>{pauseRequested ? "已请求暂停；当前任务安全结束后会停在下一步开始前。" : "想修改这一步？系统会先让当前任务安全结束，再停下来。"}</span>
          <button className="button button-ghost" type="button" disabled={pauseBusy || pauseRequested} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{pauseRequested ? "等待暂停" : "暂停后修改"}</button>
        </div> : null}

        {showPlanningStages && planningStages ? (
          <PlanningStagesPanel
            stages={planningStages}
            providers={providers}
            busy={busy}
            readOnly={readOnly || runStatus === "running"}
            {...(onPendingPlanningConfigurationChange ? { onPendingChange: onPendingPlanningConfigurationChange } : {})}
            // 节点还没有输入版本时（例如停在简报、规划尚未启动）没有可编辑的输入，
            // 给了按钮也只是点了没反应——那就先不给。
            {...(canEditInput ? { onEditStageInput: beginPlanningStageInputEdit } : {})}
            onConfigureStage={async (input) => {
              setError(undefined);
              try {
                await onConfigure(node.id, {
                  ...input,
                  expectedRunRevision: runRevision,
                  ...(terminal ? { confirmTerminalEdit: true } : {}),
                });
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught));
                throw caught;
              }
            }}
          />

        ) : null}

        {canEditInput && hasReviewableInput ? <details className="node-input-adjustment" open={inputReviewOpen} onToggle={(event) => setInputReviewOpen(event.currentTarget.open)}>
          <summary><FilePenLine aria-hidden="true" size={15} />查看和调整这个角色收到的内容</summary>
          <div className="node-input-review">
            {inputSources.length ? <section className="node-input-sources" aria-label={`${node.role ?? "制作角色"}收到的前序内容`}>
              <header><strong>来自前序步骤</strong><small>修改会在原步骤保存为新版本，并让后续旧结果失效。</small></header>
              <div>
                {inputSources.map((source) => <article key={source.node.id}>
                  <span><strong>{source.node.role ?? "制作角色"} · {source.node.label}</strong><small>{source.versionLabel}{source.node.outputState?.stale ? " · 前序内容已变化" : ""}</small></span>
                  <button className="button button-ghost" type="button" aria-label={`${source.canEdit ? "查看与修改" : "查看"} ${source.node.role ?? "制作角色"} · ${source.node.label}`} onClick={() => revealNodeWorkspace(source.node.id)}>{source.canEdit ? "查看与修改" : "查看"}</button>
                </article>)}
              </div>
            </section> : null}
            {hasEditableInput ? <section ref={inputEditorSectionRef} className="node-output-preview">
              <header><div><strong>{editingPlanningStageId ? `正在修改创作规划「${editingPlanningStageId === "treatment" ? "前期构思" : editingPlanningStageId === "script" ? "脚本" : "导演方案"}」阶段的输入` : "本步骤专用设置"}</strong><small>{inputSourceLabel(effectiveInputVersion?.source)}{node.inputState?.stale ? " · 前序内容已变化，需复核" : ""}{editingPlanningStageId ? " · 保存后从该阶段开始重新规划" : ""}</small></div>{!editingInput ? <button className="button button-ghost" type="button" onClick={() => beginInputEditing()}><FilePenLine aria-hidden="true" size={15} />编辑输入</button> : null}</header>
              {effectiveInputVersion?.source === "reconstructed" ? <p className="node-version-note">旧任务没有保存当时的原始输入；这里展示的是按当前上游内容推断出的可编辑版本。</p> : null}
              {editingInput ? <NodeStructuredEditor nodeId={`${node.id}-input`} value={safeParse(inputDraft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setInputDraft(pretty(value)); }} /> : <NodeDeliveryPreview nodeId={`${node.id}-input`} value={effectiveInput(node)} />}
              {editingInput ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelInputEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride()}><Save aria-hidden="true" size={15} />保存人工输入</button></footer> : null}
            </section> : null}
          </div>
        </details> : null}

        {node.spendPlan ? (
          <section className="spend-gate" aria-label={`${node.label}费用确认`}>
            <div><CircleDollarSign aria-hidden="true" size={20} /><span><strong>执行前费用确认</strong><small>预计 ¥{node.spendPlan.estimatedCostCny.toFixed(2)}，最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} · 最多 {node.spendPlan.maxAttempts} 次</small>{node.spendPlan.items?.map((item) => <small key={item.id}><span>{item.label} · {providerLabel(item.providerId) ?? "画面服务"} · {providerModelLabel(providers.find((provider) => provider.id === item.providerId), item.modelId)}</span> · ¥{item.estimatedCostCny.toFixed(2)}</small>)}</span></div>
            {node.spendAuthorizationId ? <span className="spend-authorized"><ShieldCheck aria-hidden="true" size={15} />已授权</span> : readOnly ? <small>历史报价仅供查看</small> : node.spendAssessment?.action === "request_approval" ? (
              <div className="spend-gate-actions spend-funding" aria-label="费用缺口">
                <p><strong>{spendAssessmentHeadline(node.spendAssessment)}</strong></p>
                <dl className="spend-quote-summary">
                  <div><dt>已批准</dt><dd>¥{(node.spendAssessment.approvedAmountCents / 100).toFixed(2)}</dd></div>
                  <div><dt>已发生/在途</dt><dd>¥{((node.spendAssessment.settledCents + node.spendAssessment.reservedCents + node.spendAssessment.pendingUnknownCents) / 100).toFixed(2)}</dd></div>
                  <div><dt>本次方案最高需要</dt><dd>¥{(node.spendAssessment.requestedMaximumCents / 100).toFixed(2)}</dd></div>
                  {node.spendAssessment.reason === "amount" ? <div><dt>需要追加</dt><dd>¥{(node.spendAssessment.additionalCents / 100).toFixed(2)}（追加后累计 ¥{(node.spendAssessment.resultingMaximumCents / 100).toFixed(2)}）</dd></div> : null}
                </dl>
                <small>既有成果已保留；追加只覆盖当前方案所需，授权额仍是上限。也可以调整方案，或先不继续。</small>
                <div className="spend-gate-buttons">
                  {node.spendAssessment.reason === "amount" ? <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing} onClick={() => void acceptFundingAmendment()}>
                    <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在确认…" : `同意追加 ¥${(node.spendAssessment.additionalCents / 100).toFixed(2)} 并继续`}
                  </button> : null}
                  {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>调整方案</button> : null}
                  {onRequestPause ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing || pauseRequested} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{pauseRequested ? "已请求暂停" : "暂不继续"}</button> : null}
                </div>
              </div>
            ) : pendingQuote ? (
              <div className="spend-gate-actions">
                <dl className="spend-quote-summary" aria-label="服务端费用报价">
                  <div><dt>预计费用</dt><dd>¥{pendingQuote.quote.estimatedCostCny.toFixed(2)}</dd></div>
                  <div><dt>最高授权</dt><dd>¥{pendingQuote.quote.maximumCostCny.toFixed(2)}</dd></div>
                  <div><dt>制作内容</dt><dd>{pendingQuote.quote.scopeSummary.content}</dd></div>
                  {pendingQuote.quote.scopeSummary.assets.map((asset) => (
                    <div key={asset.assetKey}>
                      <dt>{asset.label}</dt>
                      <dd>¥{asset.estimatedCostCny.toFixed(2)} · 最多 {asset.maxCreateAttempts} 次 · {asset.allowedModels.map((model) => providerModelLabel(providers.find((provider) => provider.id === model.providerId), model.modelId) ?? model.modelId).join("、")}</dd>
                    </div>
                  ))}
                  {pendingQuote.quote.scopeSummary.excludedAssets?.map((asset) => (
                    <div key={asset.id}>
                      <dt>{asset.label}</dt>
                      <dd>¥0.00 · {asset.note}</dd>
                    </div>
                  ))}
                  {pendingQuote.quote.scopeSummary.excludedAssets?.length ? <div><dt>本片镜数</dt><dd>付费 {pendingQuote.quote.scopeSummary.assets.length} 个 · 免收费 {pendingQuote.quote.scopeSummary.excludedAssets.length} 个 · 合计 {pendingQuote.quote.scopeSummary.assets.length + pendingQuote.quote.scopeSummary.excludedAssets.length} 个</dd></div> : null}
                  {pendingQuote.quote.scopeSummary.uncertainty.map((note) => <div key={note}><dt>不确定项</dt><dd>{note}</dd></div>)}
                </dl>
                <small>授权后执行本次范围，范围内的有限修复共用此额度；后续方案仍需按流程确认。授权额是上限，不是必须花满的目标。</small>
                <div className="spend-gate-buttons">
                  {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>这份报价不合适</button> : null}
                  <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => setPendingQuote(undefined)}>重新填写额度</button>
                  <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing} onClick={() => void acceptPendingScopeQuote()}>
                    <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在确认…" : `确认并授权（最高 ¥${pendingQuote.quote.maximumCostCny.toFixed(2)}）`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="spend-gate-actions">
                <label className="field spend-scope-maximum">
                  <span>本次最高授权额（元，可不填）</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder={`默认 ¥${node.spendPlan.maxCostCny.toFixed(2)}`}
                    value={scopeMaximumCny}
                    onChange={(event) => { setScopeMaximumCny(event.target.value); setPendingQuote(undefined); }}
                  />
                  <small>先获取报价，确认金额后再授权；授权额是上限，不是目标。</small>
                </label>
                {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>这份报价不合适</button> : null}
                <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing || !acceptedPlanDigest} onClick={() => void prepareProductionScopeQuote()}>
                  <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在获取报价…" : "获取费用报价"}
                </button>
              </div>
            )}
          </section>
        ) : null}

        <section className="node-output-preview node-creator-delivery">
          <header><div><strong>{node.id === "creative-planning" ? "规划交付目录" : `${node.role ?? "制作角色"}的交付`}</strong><small>{node.id === "creative-planning" ? "当前正式版本 · 逐项阅读，不在这里修改历史产物" : deliveryEditHint(node.id, effectiveVersion?.source, hasDelivery, node.status, runStatus, pauseRequested)}</small></div>{canEdit && hasDelivery && !editing && (!editableArtifact || documentPreview !== undefined) ? <button className="button button-ghost" type="button" onClick={beginEditing}><FilePenLine aria-hidden="true" size={15} />编辑交付</button> : null}</header>
          {node.id === "assets" && visualArtifacts.length ? <div className={visualsAreCurrent ? "node-visual-preview" : "node-visual-preview is-stale"}>
            <header><strong>{visualsAreCurrent ? "实际素材画面" : "上次生成的素材画面"}</strong><small>{visualArtifacts.length} 个可预览素材{visualsAreCurrent ? "" : " · 将重新检查适用性，只重做不再适用的部分"}</small></header>
            <div>
              {visualArtifacts.map((artifact, index) => <figure key={artifact.id}>
                {artifact.contentType?.startsWith("video/")
                  ? <video aria-label={`${artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`} 画面预览`} src={artifact.contentUrl} controls playsInline preload="metadata" />
                  : <img alt={`${artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`} 画面预览`} src={artifact.providerId === "unsplash-stock-v1" ? unsplashPublicUrl(artifact.previewUrl, "images.unsplash.com") : artifact.contentUrl} loading="lazy" />}
                <figcaption><span>{artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`}</span><small>{hasStockAttribution(artifact.providerId) ? <StockAttribution provider={artifact.providerId} creator={artifact.creator} creatorUrl={artifact.creatorUrl} licenseNote={artifact.licenseNote} /> : providerLabel(artifact.providerId) ?? "素材来源未记录"}</small></figcaption>
              </figure>)}
            </div>
          </div> : null}
          {node.id === "creative-planning" ? <PlanningDeliveryPanel
            key={`${runId}:${effectiveVersion?.id ?? "pending"}`}
            runId={runId}
            versionId={effectiveVersion?.id ?? "pending"}
            artifactIds={planningArtifactIds}
            artifacts={artifacts}
            publicationExpected={node.status === "succeeded"}
          /> : editing ? <NodeStructuredEditor nodeId={node.id} value={safeParse(draft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setDraft(pretty(value)); }} /> : documentLoading ? <p className="node-document-state">正在读取详细内容...</p> : documentError ? <p className="node-workspace-error" role="alert">详细内容读取失败：{documentError}</p> : <NodeDeliveryPreview nodeId={node.id} value={documentPreview ?? effectiveOutput(node) ?? node.output} />}
          {contentReview && !editing ? <NodeContentReview value={contentReview} /> : null}
          {contentReview && !editing && (node.id === "publish-package" || node.id === "reference-grammar") && onReviseDocument && onAuditDocument
            ? <NodeDocumentCommands
              nodeId={node.id}
              runRevision={runRevision}
              effectiveVersionId={effectiveVersion?.id ?? ""}
              contentReview={contentReview}
              busy={busy || readOnly}
              onRevise={onReviseDocument}
              onAudit={onAuditDocument}
            />
            : null}
          {(node.id === "reference-grammar" || node.id === "publish-package") && !editing
            ? <NodeDocumentHistory nodeId={node.id} outputState={node.outputState} artifacts={artifacts} />
            : null}
          {audioArtifact?.contentUrl ? <div className={audioIsCurrent ? "node-audio-preview" : "node-audio-preview is-stale"}><div><strong>{audioIsCurrent ? "实际配音试听" : "上次生成的配音"}</strong>{!audioIsCurrent ? <small>当前文字已修改或上游已变化；继续生成后会更新声音。</small> : null}</div><audio aria-label={audioIsCurrent ? "实际配音试听" : "上次生成的配音试听"} src={audioArtifact.contentUrl} controls preload="metadata" /></div> : null}
          {editing ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride()}><Save aria-hidden="true" size={15} />保存为人工版本</button></footer> : null}
        </section>

        {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      </div>

      {authorizing && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendDialogRef} role="dialog" aria-modal="true" aria-label="确认本次费用" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>确认执行 {node.label}</h3>
          {node.id === "assets" ? <p>每种生成路线先检查一镜，再决定后续制作。试片通过适用性检查后可用于成片；修复次数和费用以本次授权范围为准，超出范围须重新确认。全部素材还会在配音和剪辑前复查。</p> : null}
          <p>这次授权只对下面已经审阅的输入版本、{node.spendPlan.items?.length
            ? `报价中列出的 ${node.spendPlan.items.length} 个画面任务`
            : providerModelLabel(providers.find((provider) => provider.id === node.spendPlan?.providerId), node.spendPlan.modelId)}和本次最高授权额 ¥{node.spendPlan.maxCostCny.toFixed(2)} 有效。任何内容、模型、报价或重试次数变化都会让授权自动失效。</p>
          {node.spendPlan.items?.length ? <div className="spend-input-versions" aria-label="本次授权的画面任务">
            {node.spendPlan.items.map((item) => <div key={item.id}><span><strong>{item.label} · {providerLabel(item.providerId) ?? "画面服务"}</strong><small>{providerModelLabel(providers.find((provider) => provider.id === item.providerId), item.modelId)} · ¥{item.estimatedCostCny.toFixed(2)}</small></span></div>)}
          </div> : null}
          <div className="spend-input-versions" aria-label="本次付费所使用的上游版本">
            {spendInputs.map((input) => <div key={input.versionId}><span><strong>{input.role} · {input.label}</strong><small>{input.source === "human" ? "人工版本" : "自动版本"}</small></span></div>)}
          </div>
          <div><button className="button button-ghost" type="button" onClick={() => { setError(undefined); setAuthorizing(false); }}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void authorize()}>授权本次最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} 并执行</button></div>
        </section>
      </div> : null}
      {rejectingSpend && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendRejectionDialogRef} role="dialog" aria-modal="true" aria-label="保存费用反馈" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>把这份报价退回导演</h3>
          <p>这里只保存反馈，不会立即调用导演。你可以先修改方案或画面来源，再手动重新规划；新方案会重新报价并再次等待你确认。</p>
          <label className="field"><span>不接受这份报价的原因</span><select value={spendRejectionReason} onChange={(event) => setSpendRejectionReason(event.target.value as StudioSpendRejectionInput["reason"])}>
            <option value="too_expensive">总价太高，希望降低费用</option>
            <option value="provider_mix">画面来源或素材组合不合适</option>
            <option value="plan_not_approved">前面的画面方案不认可</option>
            <option value="other">其他原因</option>
          </select></label>
          <label className="field"><span>下一版优先尝试降到多少元（可选；达不到仍会给你新报价）</span><input aria-label="下一版降本目标（可选）" type="number" min={0} max={100000} step={0.01} value={targetEstimatedCostCny} onChange={(event) => { setError(undefined); setTargetEstimatedCostCny(event.target.value); }} /></label>
          <label className="field"><span>具体调整意见（可选）</span><textarea aria-label="具体调整意见（可选）" rows={3} maxLength={1000} value={spendRejectionNote} onChange={(event) => { setError(undefined); setSpendRejectionNote(event.target.value); }} /></label>
          <div><button className="button button-ghost" type="button" onClick={() => { setError(undefined); setRejectingSpend(false); }}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void rejectSpend()}>保存反馈</button></div>
        </section>
      </div> : null}
      {terminalOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-edit-${node.id}`}>创建已结束制作的人工修订版？</h3>
          <p>这不会在后台自动调用付费服务。保存后，后续结果会标为过期，只有你再次点击重新生成才会继续。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride(true, terminalOverride)}>确认创建修订版</button></div>
        </section>
      </div> : null}
      {terminalInputOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalInputDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-input-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-input-edit-${node.id}`}>创建已结束制作的人工输入版本？</h3>
          <p>保存后，本步骤和全部后续结果会过期；系统不会自动调用任何付费服务。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalInputOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride(true, terminalInputOverride)}>确认创建输入版本</button></div>
        </section>
      </div> : null}
    </details>
  );
}

// C1/C2：结构化评估的创作者文案——只说发生了什么、保留了什么、下一步；金额之外的
// 原因（scope/attempts/quality）加钱解决不了，不提供"只加钱继续"的入口。
function spendAssessmentHeadline(assessment: NonNullable<StudioNode["spendAssessment"]>): string {
  if (assessment.reason === "amount") {
    return "当前授权余额不够完成这份方案。";
  }
  if (assessment.reason === "attempts") {
    return "部分镜头的重试次数已达到你批准的上限，无法继续自动修复。";
  }
  if (assessment.reason === "quality") {
    return "方案效果在授权后发生了变化，需要你重新确认后才能继续。";
  }
  if (assessment.reason === "scope") {
    return "这份方案有内容不在已批准的范围里，需要你重新确认。";
  }
  return "当前费用凭证不足以继续这份方案。";
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

export function revealNodeWorkspace(nodeId: string): void {
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

const READ_ONLY_NODE_IDS = new Set(["asset-source-review", "render", "technical-review", "final-review"]);
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
  if (runStatus === "running" && hasDelivery) return "后续步骤正在执行；可先暂停，再修改这份交付";
  if (runStatus === "paused" && hasDelivery) return "制作已暂停，可以修改；保存后下游旧结果会自动失效";
  if (source === "human") return "已采用你的修改";
  if (hasDelivery) return "自动生成，可按需修改";
  return status === "pending" ? "等待前一步完成" : "本步骤没有需要人工阅读的内容";
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

function NodeExecutionConfigurationEditor({ node, providers, runStatus, runRevision, busy, readOnly, paidRecoveryLocked, onSave }: {
  node: StudioNode;
  providers: StudioProvider[];
  runStatus: StudioRunStatus;
  /** 保存时以打开编辑器那一刻观察到的 revision 为并发基线，不随 props 后台刷新升级。 */
  runRevision: number;
  busy: boolean;
  readOnly: boolean;
  paidRecoveryLocked: boolean;
  onSave: (input: StudioNodeExecutionConfigurationInput) => Promise<void>;
}) {
  const configuration = node.executionConfiguration!;
  const [editing, setEditing] = useState(false);
  const [editBaselineRevision, setEditBaselineRevision] = useState<number>();
  const [providerId, setProviderId] = useState(configuration.providerId);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({ ...configuration.modelSelections });
  const [assetProviderIds, setAssetProviderIds] = useState<string[]>([...(configuration.assetProviderIds ?? [])]);
  const [error, setError] = useState<string>();
  const terminal = runStatus === "succeeded" || runStatus === "failed" || runStatus === "rejected";
  const failedRecovery = runStatus === "failed" && node.status === "failed";
  const canEdit = !readOnly && !paidRecoveryLocked && providers.length > 0 && (!terminal || failedRecovery) && runStatus !== "running" && node.status !== "running";
  const capability = configurableNodeCapability(node.id);
  const roleProviders = capability
    ? providers.filter((provider) => provider.available && provider.kind !== "test" && provider.capability === capability)
    : [];
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const inheritedProviderUnavailable = node.id !== "assets"
    && !roleProviders.some((provider) => provider.id === providerId);
  const hasAlternativeRoleProvider = roleProviders.some((provider) => provider.id !== providerId);
  const assetSources = providers.filter((provider) => provider.available
    && provider.kind !== "test"
    && provider.capability === "asset.prepare"
    && provider.id !== "ai-shot-router-v1");
  const inheritedUnavailableAssetSources = assetProviderIds
    .filter((id) => !assetSources.some((provider) => provider.id === id))
    .map((id) => ({
      id,
      label: providers.find((provider) => provider.id === id)?.label ?? providerLabel(id) ?? "已停用的画面来源",
    }));
  const selectedAssetSources = assetSources.filter((provider) => assetProviderIds.includes(provider.id));
  const meteredSources = selectedAssetSources.filter((provider) => provider.billing === "metered");
  const selectedProviderModels = selectedProvider
    ? selectableModelsForCapability(selectedProvider.modelProfiles, selectedProvider.capability)
    : [];
  // 首选之外的其余可用模型就是这个角色的兜底链，顺序即 broker 公告顺序（用户不排序，只读展示）。
  // 只有已经把候选摊到模型级的角色才列：其余角色"换首选模型"并不会真的换到另一个模型上运行，
  // 列出兜底链等于承诺一件不会发生的事。
  const preferredModelId = (modelSelections[providerId] ?? "").trim() || selectedProvider?.defaultModelId;
  const fallbackModels = MODEL_FALLBACK_NODE_IDS.includes(node.id)
    ? selectedProviderModels.filter((model) => model.id !== preferredModelId)
    : [];

  useEffect(() => {
    if (editing) return;
    setProviderId(configuration.providerId);
    setModelSelections({ ...configuration.modelSelections });
    setAssetProviderIds([...(configuration.assetProviderIds ?? [])]);
  }, [configuration, editing]);

  function updateAssetSource(assetProviderId: string, enabled: boolean) {
    const next = enabled
      ? [...new Set([...assetProviderIds, assetProviderId])]
      : assetProviderIds.filter((id) => id !== assetProviderId);
    setAssetProviderIds(next);
  }

  async function save() {
    setError(undefined);
    if (node.id === "assets" && assetProviderIds.length === 0) {
      setError("至少保留一个画面来源。");
      return;
    }
    // 基线缺失（理论不可达：保存入口只在编辑器打开时可达）时拒绝提交，不无声改用当前 props。
    if (editBaselineRevision === undefined) {
      setError("编辑会话已失效，请重新打开编辑后再保存。");
      return;
    }
    try {
      const providerModels = node.id === "assets"
        ? Object.fromEntries(assetProviderIds.map((id) => [id, modelSelections[id] ?? null]))
        : { [providerId]: modelSelections[providerId] ?? null,
            ...(node.id === "visual-review" && (modelSelections["sound-review-v1"] !== undefined || providers.some((provider) => provider.id === "sound-review-v1" && provider.available))
              ? { "sound-review-v1": modelSelections["sound-review-v1"] || null } : {}) };
      await onSave({
        expectedRunRevision: editBaselineRevision,
        ...(node.id === "assets" ? {} : { providerId }),
        modelSelections: providerModels,
        ...(node.id === "assets" ? {
          assetProviderIds,
          economics: {
            allowMeteredProviders: meteredSources.length > 0,
          },
        } : {}),
        ...(failedRecovery ? { confirmTerminalEdit: true } : {}),
      });
      setEditing(false);
      setEditBaselineRevision(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return <section className="node-execution-config" aria-label={`${node.role ?? node.label}本次制作选择`}>
    <header>
      <span><Settings2 aria-hidden="true" size={16} /></span>
      <div><strong>本次制作选择</strong><small>{editing
        ? node.id === "assets"
          ? "更换画面来源，或切换到时长、任务能力不同的视频模型，会让导演重新规划；同一来源下，只有能力兼容的模型切换才从画面素材继续。保存后旧费用确认会自动失效。"
          : "保存后继续制作才会生效，旧费用确认会自动失效"
        : executionConfigurationSummary(node, providers)}</small></div>
      {canEdit && !editing ? <button className="button button-ghost" type="button" onClick={() => { setEditBaselineRevision(runRevision); setEditing(true); }}>调整</button> : null}
    </header>
    {editing ? <div className="node-execution-config-editor">
      {node.id === "visual-review" ? <label className="field"><span>声音审片模型</span><select aria-label="声音审片模型"
        value={modelSelections["sound-review-v1"] ?? ""} onChange={(event) => setModelSelections((current) => ({ ...current, "sound-review-v1": event.target.value }))}>
        <option value="">继承本条制作的声音选择</option>
        {providers.find((provider) => provider.id === "sound-review-v1")?.modelProfiles?.filter((model) => model.available).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select><small>直接听取成片音轨；没有可用接入时如实标为未审听，不影响你查看视觉意见。</small></label> : null}
      {node.id !== "assets" ? <>
        <label className="field"><span>制作方式</span><select value={providerId} disabled={node.id === "voice" || !hasAlternativeRoleProvider} onChange={(event) => setProviderId(event.target.value)}>
          {inheritedProviderUnavailable ? <option value={providerId} disabled>{selectedProvider?.label ?? providerLabel(providerId) ?? "未识别的制作服务"}（已失效）</option> : null}
          {roleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
        </select></label>
        {selectedProviderModels.length ? <>
          <label className="field"><span>首选模型</span><select value={modelSelections[providerId] ?? ""} onChange={(event) => setModelSelections((current) => ({ ...current, [providerId]: event.target.value }))}>
            <option value="">使用推荐：{providerModelLabel(selectedProvider, selectedProvider?.defaultModelId)}</option>
            {selectedProviderModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
          </select>{["brief", "script", "visual-direction", "visual-review"].includes(node.id) && selectedProviderModels.length > 1
            ? <small>当前选择会优先使用；只有这个模型暂时无法使用时，才会依次尝试其他可用模型。</small>
            : null}</label>
          {fallbackModels.length ? <div className="node-model-fallback" aria-label="兜底模型顺序">
            <span>兜底顺序</span>
            <ol>{fallbackModels.map((model) => <li key={model.id}>{providerModelLabel(selectedProvider, model.id)}</li>)}</ol>
          </div> : null}
        </> : null}
      </> : <>
        <div className="node-asset-source-options">
          {inheritedUnavailableAssetSources.map((provider) => <article key={provider.id} className="is-selected">
            <label><input type="checkbox" checked onChange={(event) => updateAssetSource(provider.id, event.target.checked)} /><span><strong>{provider.label}</strong><small>已失效 · 取消选择后保存</small></span></label>
          </article>)}
          {assetSources.map((provider) => {
            const selected = assetProviderIds.includes(provider.id);
            const compatibleModels = selectableModelsForCapability(provider.modelProfiles, provider.capability);
            return <article key={provider.id} className={selected ? "is-selected" : ""}>
              <label><input type="checkbox" checked={selected} onChange={(event) => updateAssetSource(provider.id, event.target.checked)} /><span><strong>{provider.label}</strong><small>{provider.billing === "metered" ? "按镜头计费" : "免费来源"}</small></span></label>
              {selected && compatibleModels.length ? <select aria-label={`${provider.label}模型`} value={modelSelections[provider.id] ?? ""} onChange={(event) => setModelSelections((current) => ({ ...current, [provider.id]: event.target.value }))}>
                <option value="">使用推荐：{providerModelLabel(provider, provider.defaultModelId)}</option>
                {compatibleModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
              </select> : null}
            </article>;
          })}
        </div>
        {meteredSources.length > 0 ? <div className="node-budget-fields">
          <p>按实际导演方案报价；每次生成付费图片或视频前逐笔人工确认。若报价不合适，可退回导演降低费用。</p>
        </div> : null}
      </>}
      {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      <footer><button className="button button-ghost" type="button" disabled={busy} onClick={() => { setError(undefined); setEditing(false); setEditBaselineRevision(undefined); }}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}><Save aria-hidden="true" size={15} />保存选择</button></footer>
    </div> : null}
  </section>;
}

function configurableNodeCapability(nodeId: string): string | undefined {
  return {
    // 简报没有可切换的执行能力，能调的是它那一轮独立复核用哪个模型。
    brief: "role.audit",
    script: "script.draft",
    "visual-direction": "storyboard.plan",
    "asset-source-review": "quality.review.visual",
    voice: "voice.synthesize",
    "visual-review": "quality.review.visual",
  }[nodeId];
}

/**
 * 候选已经摊到模型级的角色——也就是"换首选模型"真的会换一个模型运行、其余模型会依次接手的那几个。
 * 审片刻意不在里面：它的兜底是跨 broker 的整体接管（另一个 provider 的审片员），不是这个 provider
 * 目录里的下一个模型，列在这里会指向一个它其实不会用的模型。
 */
const MODEL_FALLBACK_NODE_IDS = ["brief", "script", "visual-direction"];

function executionConfigurationSummary(node: StudioNode, providers: StudioProvider[]): string {
  const configuration = node.executionConfiguration!;
  if (node.id === "assets") {
    const sources = (configuration.assetProviderIds ?? []).map((id) => providers.find((provider) => provider.id === id)?.label ?? providerLabel(id) ?? "未识别的画面来源");
    const budget = configuration.economics?.allowMeteredProviders
      ? " · 按实际方案报价 · 执行前逐笔确认"
      : " · 当前不调用付费生成";
    return `${sources.join("、") || "未选择来源"}${budget}`;
  }
  const provider = providers.find((candidate) => candidate.id === configuration.providerId);
  const modelId = configuration.modelSelections[configuration.providerId] ?? provider?.defaultModelId;
  return `${providerLabel(provider?.id) ?? provider?.label ?? "未识别的制作服务"} · ${providerModelLabel(provider, modelId)}`;
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
    if (!bible) return "全片视觉规则不能为空。";
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
      ["preferredProviderId", "首选画面来源"],
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

function creatorCapabilityLabel(
  execution: StudioNode["executionReceipt"] | StudioNode["plannedExecution"] | undefined,
  spendPlan: StudioNode["spendPlan"],
  providers: StudioProvider[],
): string | undefined {
  const providerId = execution?.providerId ?? spendPlan?.providerId;
  const modelId = execution?.modelId ?? spendPlan?.modelId;
  if (!providerId || !modelId || providerId.startsWith("inline:") || modelId === "inline") return undefined;
  const reasoningEffort = execution?.parameters?.reasoningEffort;
  const loopIterations = execution?.parameters?.agentLoopIterations;
  const auditEffort = execution?.parameters?.auditReasoningEffort;
  const knownProviderName = providerLabel(providerId);
  const providerName = providers.find((provider) => provider.id === providerId)?.label
    ?? (knownProviderName && !knownProviderName.startsWith("服务名称未收录（") ? knownProviderName : "AI 创作服务");
  const modelName = catalogModelLabel(providers, modelId);
  return [
    `本次使用 ${providerName}${!modelName || modelId === providerId || modelName === providerName ? "" : ` · ${modelName}`}`,
    typeof reasoningEffort === "string" ? reasoningEffortLabel(reasoningEffort) : undefined,
    typeof loopIterations === "number" ? `AI 创作与独立质量复核 · ${loopIterations}/3 轮` : undefined,
    typeof auditEffort === "string" ? `质量复核：${reasoningEffortLabel(auditEffort)}` : undefined,
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
  return creatorFacingTechnicalText(reason.trim()) ?? reason.trim();
}

function executionTimingDetails(
  receipt: StudioNode["executionReceipt"] | undefined,
): { summary: string; items: Array<{ label: string; value: string }> } | undefined {
  if (!receipt) return undefined;
  const parameters = receipt.parameters ?? {};
  const totalMs = elapsedReceiptMs(receipt.startedAt, receipt.finishedAt);
  const queueWaitMs = timingParameter(parameters.queueWaitMs);
  const providerWaitMs = timingParameter(parameters.providerWaitMs);
  const modelCallCount = nonNegativeIntegerParameter(parameters.modelCallCount);
  const audioModelCallCount = nonNegativeIntegerParameter(parameters.audioModelCallCount);
  const brokerTaskCount = nonNegativeIntegerParameter(parameters.brokerTaskCount);
  const modelExecutionCount = nonNegativeIntegerParameter(parameters.modelExecutionCount);
  const brokerStructuredRepairCount = nonNegativeIntegerParameter(parameters.brokerStructuredRepairCount);
  const producerModelCallCount = nonNegativeIntegerParameter(parameters.producerModelCallCount);
  const auditModelCallCount = nonNegativeIntegerParameter(parameters.auditModelCallCount);
  const discussionModelCallCount = nonNegativeIntegerParameter(parameters.discussionModelCallCount);
  const retryCount = nonNegativeIntegerParameter(parameters.retryCount);
  const structuredRepairModelCallCount = nonNegativeIntegerParameter(parameters.structuredRepairModelCallCount);
  const unknownModelExecutionCount = nonNegativeIntegerParameter(parameters.unknownModelExecutionCount);
  const previousModelCallCount = nonNegativeIntegerParameter(parameters.previousModelCallCount);
  const previousDiscussionModelCallCount = nonNegativeIntegerParameter(parameters.previousDiscussionModelCallCount);
  const previousStructuredRepairModelCallCount = nonNegativeIntegerParameter(parameters.previousStructuredRepairModelCallCount);
  const previousUnknownModelExecutionCount = nonNegativeIntegerParameter(parameters.previousUnknownModelExecutionCount);
  const unattributedRepairs = nonNegativeIntegerParameter(parameters.unattributedStructuredRepairModelCallCount);
  const unattributedProducerMs = timingParameter(parameters.unattributedProducerMs);
  const unattributedAuditMs = timingParameter(parameters.unattributedAuditMs);
  const unattributedValidationMs = timingParameter(parameters.unattributedValidationMs);
  const producerMs = timingParameter(parameters.producerMs);
  const auditMs = timingParameter(parameters.auditMs);
  const discussionMs = timingParameter(parameters.discussionMs);
  const validationMs = timingParameter(parameters.loopValidationMs);
  const requestPayloadBytes = nonNegativeIntegerParameter(parameters.requestPayloadBytes);
  const promptBytes = nonNegativeIntegerParameter(parameters.promptBytes);
  const evidenceImageCount = nonNegativeIntegerParameter(parameters.evidenceImageCount);
  const evidenceImageBytes = nonNegativeIntegerParameter(parameters.evidenceImageBytes);
  const fallbackCandidateCount = Math.max(0, (receipt.actualModelIds?.length ?? 1) - 1);
  const unclassifiedMs = totalMs !== undefined
    && queueWaitMs !== undefined
    && providerWaitMs !== undefined
    && queueWaitMs + providerWaitMs <= totalMs
    ? totalMs - queueWaitMs - providerWaitMs
    : undefined;
  if (queueWaitMs === undefined
    && providerWaitMs === undefined
    && unclassifiedMs === undefined
    && modelCallCount === undefined
    && brokerTaskCount === undefined
    && modelExecutionCount === undefined
    && retryCount === undefined
    && structuredRepairModelCallCount === undefined
    && unknownModelExecutionCount === undefined
    && previousModelCallCount === undefined
    && unattributedRepairs === undefined
    && unattributedProducerMs === undefined
    && unattributedAuditMs === undefined
    && unattributedValidationMs === undefined
    && fallbackCandidateCount === 0) return undefined;

  const items = [
    totalMs === undefined ? undefined : { label: "步骤总耗时", value: formatDuration(totalMs) },
    queueWaitMs === undefined ? undefined : { label: "排队等待", value: formatDuration(queueWaitMs) },
    providerWaitMs === undefined ? undefined : { label: "服务执行", value: formatDuration(providerWaitMs) },
    unclassifiedMs === undefined
      ? undefined
      : { label: "未细分等待 / 处理", value: formatDuration(unclassifiedMs) },
    producerMs === undefined ? undefined : { label: "内容生成累计", value: formatDuration(producerMs) },
    auditMs === undefined ? undefined : { label: "确认时独立复核累计", value: formatDuration(auditMs) },
    discussionMs === undefined ? undefined : { label: "创作讨论累计", value: formatDuration(discussionMs) },
    validationMs === undefined ? undefined : { label: "输出格式与使用要求检查", value: formatDuration(validationMs) },
    unattributedProducerMs === undefined ? undefined : { label: "生成耗时（跨操作，未分摊）", value: formatDuration(unattributedProducerMs) },
    unattributedAuditMs === undefined ? undefined : { label: "复核耗时（跨操作，未分摊）", value: formatDuration(unattributedAuditMs) },
    unattributedValidationMs === undefined ? undefined : { label: "校验耗时（跨操作，未分摊）", value: formatDuration(unattributedValidationMs) },
    fallbackCandidateCount > 0 ? { label: "候选切换", value: `${fallbackCandidateCount} 次` } : undefined,
    modelCallCount === undefined ? undefined : { label: "本次已证实模型执行", value: `${modelCallCount} 次` },
    parameters.audioReviewStatus === undefined ? undefined : { label: "其中声音审片", value: audioModelCallCount === undefined ? "调用次数待核实" : `${audioModelCallCount} 次` },
    brokerTaskCount === undefined ? undefined : { label: "模型服务调度任务", value: `${brokerTaskCount} 次` },
    modelExecutionCount === undefined ? undefined : { label: "任务内模型执行", value: `${modelExecutionCount} 次` },
    brokerStructuredRepairCount === undefined || brokerStructuredRepairCount === 0
      ? undefined
      : { label: "任务内结构修正", value: `${brokerStructuredRepairCount} 次` },
    producerModelCallCount === undefined ? undefined : { label: "内容生成调用", value: `${producerModelCallCount} 次` },
    auditModelCallCount === undefined ? undefined : { label: "确认时独立复核", value: `${auditModelCallCount} 次` },
    discussionModelCallCount === undefined ? undefined : { label: "创作讨论", value: `${discussionModelCallCount} 次` },
    structuredRepairModelCallCount === undefined ? undefined : { label: "其中结构修复", value: `${structuredRepairModelCallCount} 次` },
    unattributedRepairs === undefined ? undefined : { label: "结构修复（归属待核对）", value: `${unattributedRepairs} 次` },
    unknownModelExecutionCount === undefined || unknownModelExecutionCount === 0 ? undefined : { label: "执行情况待确认", value: `${unknownModelExecutionCount} 次` },
    previousModelCallCount === undefined ? undefined : { label: "此前执行累计", value: `${previousModelCallCount} 次` },
    previousDiscussionModelCallCount === undefined
      ? undefined
      : { label: "此前创作讨论", value: `${previousDiscussionModelCallCount} 次` },
    previousStructuredRepairModelCallCount === undefined || previousStructuredRepairModelCallCount === 0
      ? undefined
      : { label: "此前结构修复", value: `${previousStructuredRepairModelCallCount} 次` },
    previousUnknownModelExecutionCount === undefined || previousUnknownModelExecutionCount === 0
      ? undefined
      : { label: "此前待确认执行", value: `${previousUnknownModelExecutionCount} 次` },
    retryCount === undefined ? undefined : { label: "任务恢复重试", value: `${retryCount} 次` },
    requestPayloadBytes === undefined ? undefined : { label: "发送数据", value: formatBytes(requestPayloadBytes) },
    promptBytes === undefined ? undefined : { label: "模型指令", value: formatBytes(promptBytes) },
    evidenceImageCount === undefined ? undefined : {
      label: "视觉证据",
      value: `${evidenceImageCount} 张${evidenceImageBytes === undefined ? "" : ` · ${formatBytes(evidenceImageBytes)}`}`,
    },
  ].filter((item): item is { label: string; value: string } => item !== undefined);
  const summary = [
    totalMs === undefined ? undefined : `共 ${formatDuration(totalMs)}`,
    fallbackCandidateCount > 0 ? `${fallbackCandidateCount} 次候选切换` : undefined,
    modelCallCount === undefined ? undefined : `本次 ${modelCallCount} 次已证实模型执行`,
    previousModelCallCount === undefined ? undefined : `此前累计 ${previousModelCallCount} 次`,
    structuredRepairModelCallCount ? `${structuredRepairModelCallCount} 次结构修复` : undefined,
    unknownModelExecutionCount ? `${unknownModelExecutionCount} 次执行待确认` : undefined,
    retryCount && retryCount > 0 ? `${retryCount} 次任务恢复重试` : undefined,
  ].filter(Boolean).join(" · ");
  return { summary: summary || "可查看各阶段耗时", items };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timingParameter(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function nonNegativeIntegerParameter(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function elapsedReceiptMs(startedAt: string, finishedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : undefined;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return "不到 1 秒";
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}
