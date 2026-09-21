import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lock } from "proper-lockfile";
import { NodeVersionConflictError } from "@video-factory/workflow-core";
import type { ArtifactDraft, HumanDecisionDraft, NodeInputOverrideDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionTemplateSnapshot } from "@video-factory/template-core";
import {
  canRetryRejectedReviewNode,
  canonicalProductionAssetIntentDigest,
  canonicalQualityContractDigest,
  CodexBridgeClient,
  CodexBridgeError,
  BRIEF_AUDIT_PROVIDER_ID,
  CREATIVE_TREATMENT_PROVIDER_ID,
  effectiveProductionBrief,
  PaidOperationManualReconciliationError,
  parseBrief,
  parsePersistedBrief,
  productionWorkflowVersion,
  reworkSceneDependencyClosure,
  summarizeReworkImpact,
  RunLockedError,
  StaleRunRevisionError,
  type DispatchedProductionRun,
  type CreativePlanningStageInspection,
  type CodexPreparedOperation,
  type ProductionBrief,
  type ProductionCreativeReviewConfirmationDraft,
  type ProductionCreativeReviewCommandDraft,
  type ProductionPaidNodeReconciliationDraft,
  type ProductionNarrationRevisionDraft,
  type ProductionPaidNodeSummary,
  type ProductionRunListener,
  type ProductionSceneRevisionDraft,
  type ProductionSceneResourceRevisionDraft,
  type ProductionSpendRejectionDraft,
  type ProductionVoiceTimingRevisionDraft,
  type ProductionVisualReinspectionDraft,
  type ProductionAuthorizationScope,
  type VisualReviewFinding,
  visualReviewFindingKey,
} from "@video-factory/production-pipeline";
import {
  StudioInputError,
  STUDIO_PLANNING_EDITABLE_STAGES,
  assertStudioExecutableProductionInput,
  defaultStudioDurationRange,
  type StartRunResponse,
  type StudioArtifact,
  type StudioArtifactResource,
  type StudioAgentLoopAuditIssue,
  type StudioAgentLoopProgress,
  type StudioDecision,
  type StudioDecisionInput,
  type StudioCreativeReviewCommandInput,
  type StudioCreativeReviewCommandReceipt,
  type StudioCreativeReviewSnapshot,
  type StudioIntervention,
  type StudioNode,
  type StudioNodeInputOverrideInput,
  type StudioNodeExecutionConfigurationInput,
  type StudioPlanningEditableStage,
  type StudioProductionAmendmentInput,
  type StudioProductionAuthorizationInput,
  type StudioProductionQuote,
  type StudioProductionQuoteInput,
  type StudioNodeOverrideInput,
  type StudioPaidNodeSummary,
  type StudioPaidReconciliationInput,
  type StudioProvider,
  type StudioProductionInput,
  type StudioReworkDraft,
  type StudioReworkFinding,
  type StudioRunDetail,
  type StudioRunSummary,
  type StudioNarrationRevisionInput,
  type StudioSceneResourceRevisionInput,
  type StudioSceneRevisionInput,
  type StudioSpendRejectionInput,
} from "../shared/api.js";
import { modelSupportsCapability } from "../shared/model-compatibility.js";
import { visualSourceCompatibilityIssue } from "../shared/visual-source-compatibility.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import type { RejectedVisualResource } from "./resource-governance-studio.js";
import { validateNodeOverrideOutput } from "./node-output-validator.js";
import type { RunArchiveRepository } from "./run-archive-store.js";
import { buildRunObservability, nodeActionLabel } from "./run-observability.js";

const MANAGED_FILE_PLACEHOLDER = "[系统托管文件]";

export interface StudioPipelinePort {
  list(): Promise<WorkflowRun<ProductionBrief>[]>;
  remove(runId: string): Promise<void>;
  loadPersisted(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  show(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  dispatch(input: unknown, listener?: ProductionRunListener): Promise<DispatchedProductionRun>;
  decide(runId: string, decision: {
    interventionId: string;
    action: "approve" | "request_changes" | "reject";
    actor: string;
    note?: string;
  }): Promise<WorkflowRun<ProductionBrief>>;
  confirmCreativeReview?(
    runId: string,
    draft: ProductionCreativeReviewConfirmationDraft,
  ): Promise<WorkflowRun<ProductionBrief>>;
  dispatchCreativeReviewCommand?(
    runId: string,
    draft: ProductionCreativeReviewCommandDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  requestVoiceTimingRevision(
    runId: string,
    draft: ProductionVoiceTimingRevisionDraft,
  ): Promise<WorkflowRun<ProductionBrief>>;
  dispatchDecision?(
    runId: string,
    decision: HumanDecisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  dispatchSceneRevision?(
    runId: string,
    revision: ProductionSceneRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  dispatchNarrationRevision?(
    runId: string,
    draft: ProductionNarrationRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  dispatchSceneResourceRevision?(
    runId: string,
    draft: ProductionSceneResourceRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  dispatchVisualReinspection?(
    runId: string,
    draft: ProductionVisualReinspectionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  applyNodeOverride(runId: string, override: NodeOverrideDraft): Promise<WorkflowRun<ProductionBrief>>;
  applyNodeInputOverride(runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>>;
  applyNodeExecutionConfiguration(
    runId: string,
    nodeId: string,
    brief: ProductionBrief,
    actor: string,
    expectedRunRevision?: number,
  ): Promise<WorkflowRun<ProductionBrief>>;
  authorizeSpend(runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>>;
  rejectSpend(runId: string, rejection: ProductionSpendRejectionDraft): Promise<WorkflowRun<ProductionBrief>>;
  dispatchSpendAuthorization?(
    runId: string,
    authorization: SpendAuthorizationDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  dispatchSpendRejection?(
    runId: string,
    rejection: ProductionSpendRejectionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun>;
  requestPause(runId: string): Promise<void>;
  clearPauseRequest?(runId: string): Promise<void>;
  pauseRequested(runId: string): Promise<boolean>;
  resumePaused(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  dispatchResumePaused?(runId: string, listener?: ProductionRunListener): Promise<DispatchedProductionRun>;
  resumeStale(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  dispatchResumeStale?(runId: string, listener?: ProductionRunListener): Promise<DispatchedProductionRun>;
  retryFailedNode(
    runId: string,
    nodeId: string,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<WorkflowRun<ProductionBrief>>;
  inspectPaidNode(runId: string, nodeId: string): Promise<ProductionPaidNodeSummary>;
  /** joint-v1 规划阶段只读检视：pipeline 拥有 checkpoint/commit 的领域读取，Studio 只映射 DTO。 */
  inspectCreativePlanningStages?(runId: string): Promise<CreativePlanningStageInspection[] | undefined>;
  /** C1/C2：制作范围授权的宿主接受与读取。 */
  acceptProductionAuthorization?(runId: string, scope: unknown): Promise<WorkflowRun<ProductionBrief>>;
  readProductionAuthorization?(runId: string): Promise<ProductionAuthorizationScope | undefined>;
  /** C2/CG-01：授权已提交但续链未完成时的幂等续链恢复。 */
  resumeCoveredSpendApproval?(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  reconcilePaidNode(
    runId: string,
    draft: ProductionPaidNodeReconciliationDraft,
    options?: { settleOnly?: boolean },
  ): Promise<WorkflowRun<ProductionBrief>>;
  dispatchRetryFailedNode?(
    runId: string,
    nodeId: string,
    listener?: ProductionRunListener,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<DispatchedProductionRun>;
  withRunMaintenanceLease<T>(runIds: string[], action: () => Promise<T>): Promise<T>;
}

export interface ProductionStudioOptions {
  workspaceRoot: string;
  pipeline: StudioPipelinePort;
  listProviders: () => Promise<StudioProvider[]>;
  archiveStore: RunArchiveRepository;
  now?: () => Date;
  loadRejectedVisualResources?: (runId: string) => Promise<RejectedVisualResource[]>;
}

export class ProductionStartDispatchedError extends Error {
  constructor(readonly runId: string, readonly persistenceError: unknown) {
    super("制作任务已经启动，但请求记录暂时无法保存；系统将保留该任务并等待自动恢复，不能重复启动。");
    this.name = "ProductionStartDispatchedError";
  }
}

const WORKFLOW_NODES: Array<{ id: string; label: string; role: string }> = [
  { id: "brief", label: "内容简报", role: "制片人" },
  { id: "script", label: "脚本", role: "编剧" },
  { id: "reference-grammar", label: "参考视频风格分析", role: "参考视频分析" },
  { id: "visual-direction", label: "导演方案", role: "导演" },
  { id: "asset-candidates", label: "候选素材", role: "素材研究员" },
  { id: "asset-semantic-rank", label: "候选画面排序", role: "选片" },
  { id: "assets", label: "画面", role: "素材导演" },
  { id: "asset-source-review", label: "生成画面预检", role: "视觉审片员" },
  { id: "voice", label: "配音", role: "声音导演" },
  { id: "render", label: "渲染", role: "剪辑师" },
  { id: "technical-review", label: "机器质检", role: "技术质检" },
  { id: "visual-review", label: "视觉审片", role: "视觉审片员" },
  { id: "final-review", label: "人工终审", role: "总导演" },
  { id: "publish-package", label: "发布文案与发布包", role: "发行编辑" },
];

const EDITABLE_DOCUMENTS: Record<string, { pathField: string; kind: string; embeddedField?: string }> = {
  script: { pathField: "scriptPath", kind: "script" },
  "reference-grammar": { pathField: "referenceGrammarPath", kind: "shot_grammar", embeddedField: "grammar" },
  "visual-direction": { pathField: "directorPlanPath", kind: "storyboard" },
  "asset-candidates": { pathField: "candidateSearchPath", kind: "asset_candidates" },
  "asset-semantic-rank": { pathField: "candidateRankingPath", kind: "asset_ranking", embeddedField: "ranking" },
  assets: { pathField: "assetPlanPath", kind: "asset_plan" },
  voice: { pathField: "voiceoverPlanPath", kind: "voiceover_plan" },
  render: { pathField: "renderManifestPath", kind: "render_manifest" },
  "technical-review": { pathField: "reviewPath", kind: "review_report" },
  "visual-review": { pathField: "visualReviewPath", kind: "review_report", embeddedField: "report" },
  "publish-package": { pathField: "publishPackagePath", kind: "publish_package" },
};

export class ProductionStudio {
  private readonly listeners = new Map<string, Set<(run: StudioRunDetail) => void>>();
  private readonly completions = new Set<Promise<void>>();
  private readonly startsInFlight = new Map<string, { digest: string; operation: Promise<StartRunResponse> }>();
  private readonly textTaskRetrievals = new Map<string, Promise<StudioRunDetail>>();
  private historicalNodeDurations: Record<string, number[]> = {};

  constructor(private readonly options: ProductionStudioOptions) {}

  async list(): Promise<StudioRunSummary[]> {
    const [runs, archived] = await Promise.all([
      this.options.pipeline.list(),
      this.options.archiveStore.list(),
    ]);
    this.historicalNodeDurations = collectNodeDurationHistory(runs);
    return runs.map((run) => withArchiveState(toRunSummary(run), archived[run.id]));
  }

  async get(runId: string): Promise<StudioRunDetail | undefined> {
    try {
      const [run, archived, historyRuns, pauseRequested] = await Promise.all([
        this.options.pipeline.show(runId),
        this.options.archiveStore.list(),
        this.options.pipeline.list(),
        this.options.pipeline.pauseRequested(runId),
      ]);
      this.historicalNodeDurations = collectNodeDurationHistory(historyRuns);
      const productionPlanDigest = await currentExecutablePlanDigest(run, this.options.workspaceRoot);
      const detail = {
        ...withArchiveState(this.toDetail(run), archived[run.id]),
        ...(pauseRequested ? { pauseRequested: true } : {}),
        ...(productionPlanDigest ? { productionPlanDigest } : {}),
      };
      return await withTaskRecovery(
        await withPlanningStages(
          await withAgentLoopProgress(detail, this.options.workspaceRoot, run.nodeRuns),
          this.options.pipeline,
        ),
        this.options.workspaceRoot,
        run.nodeRuns,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async reworkDraft(runId: string): Promise<StudioReworkDraft | undefined> {
    let run: WorkflowRun<ProductionBrief>;
    try {
      run = await this.options.pipeline.show(runId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!canCreateReworkFrom(run)) {
      throw new StudioConflictError("只有失败、已打回或已完成的制作才能生成新版本草稿。");
    }
    if (run.nodeRuns.some((node) => node.outcomeUncertain)) {
      throw new StudioConflictError("这条制作还有付费结果尚未核对，完成账单核对后才能重新制作。");
    }
    const detail = this.toDetail(run);
    const rejectedResources = this.options.loadRejectedVisualResources
      ? await this.options.loadRejectedVisualResources(run.id)
      : [];
    const failedNodeError = [...run.nodeRuns].reverse().find((node) => node.status === "failed" && node.error)?.error;
    const failedNodeReason = failedNodeError ? redactManagedPathText(failedNodeError) : undefined;
    const manualRejectionReason = latestManualRejectionReason(run);
    const rejectionReason = manualRejectionReason
      ?? (rejectedResources.length
        ? `${rejectedResources.length} 项入片素材未通过授权审核，必须替换后重新核验。`
        : failedNodeReason ?? detail.failure?.summary);
    const findings = [...reworkFindings(detail), ...resourceReworkFindings(run.id, rejectedResources)];
    const planningNodeIds = this.reworkPlanningNodeIds(run);
    const previousScript = await this.readReworkDocument(run, planningNodeIds.script, "script");
    const previousDirectorPlan = await this.readReworkDocument(run, planningNodeIds.director, "storyboard");
    const unmaterializedAssetScenePositions = await this.unmaterializedAssetScenePositions(
      run,
      previousScript,
      previousDirectorPlan,
    );
    const requiredAffectedScenePositions = recommendedReworkScenePositions({
      findings,
      unmaterializedAssetScenePositions,
      previousScript,
      previousDirectorPlan,
      ...(manualRejectionReason ? { manualRejectionReason } : {}),
    });
    const affectedScenePositions = recommendedReworkScenePositions({
      findings,
      unmaterializedAssetScenePositions,
      previousScript,
      previousDirectorPlan,
      ...(manualRejectionReason ? { manualRejectionReason } : {}),
    });
    const draftScope = {
      findings,
      unmaterializedAssetScenePositions,
      previousScript,
      previousDirectorPlan,
      ...(manualRejectionReason ? { manualRejectionReason } : {}),
      recommended: affectedScenePositions,
    };
    // B5-R1：无法定位的拒绝说明进入 needs_scope——草稿打开等待用户选择范围，
    // 不默认全片，也不以空范围静默开跑。
    const needsScope = reworkScopeUnresolved(draftScope);
    // 历史运行可能把热点来源误存成目标平台；返工页仍需打开，让创作者明确重选。
    const brief = effectiveProductionBrief(run);
    const inheritedReferenceVideo = brief.workflowFeatures?.referenceGrammar && brief.referenceVideo
      ? await this.verifiedReferenceVideoForRun(run, brief)
      : undefined;
    const reworkScriptProviderId = brief.providers.script === "codex-screenwriter-v1"
      ? brief.providers.script
      : (await this.options.listProviders()).some((provider) => (
          provider.id === "codex-screenwriter-v1"
          && provider.capability === "script.draft"
          && provider.available
        ))
        ? "codex-screenwriter-v1"
        : brief.providers.script;
    const reworkDirector = brief.director ?? {
      profileId: "auto",
      assetProviderIds: [brief.providers.assets === "ai-shot-router-v1" ? "local-editorial-v1" : brief.providers.assets],
    };
    const rework = {
      sourceRunId: run.id,
      sourceRunRevision: run.revision,
      ...(rejectionReason ? { rejectionReason } : {}),
      nodeInstructions: buildReworkNodeInstructions(findings, rejectionReason, affectedScenePositions),
      findings,
      affectedScenePositions,
      ...(previousScript ? { previousScript } : {}),
      ...(previousDirectorPlan ? { previousDirectorPlan } : {}),
    };
    const input: StudioProductionInput = {
      protocolVersion: "video-factory/brief-v1",
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      nicheSlug: brief.nicheSlug,
      durationSeconds: brief.durationSeconds,
      durationRange: structuredClone(brief.durationRange ?? defaultStudioDurationRange(brief.durationSeconds)),
      ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
      platform: brief.platform,
      reviewMode: "manual",
      runPurpose: brief.runPurpose ?? "production",
      providers: {
        ...structuredClone(brief.providers),
        script: reworkScriptProviderId,
        director: brief.providers.director ?? "api-visual-director-v1",
        assets: brief.director ? brief.providers.assets : "ai-shot-router-v1",
      },
      ...(brief.models ? { models: structuredClone(brief.models) } : {}),
      workflowFeatures: {
        assetSemanticRank: brief.workflowFeatures?.assetSemanticRank ?? false,
        referenceGrammar: brief.workflowFeatures?.referenceGrammar ?? false,
        executablePlan: true,
        // 新分配的返工版本统一使用 joint-v1；来源历史 run 保持原样。
        creativePlanning: "joint-v1" as const,
        creativeReview: "user-confirmed-v1" as const,
        // 返工版本与新建走同一套边界闸门：返工也必须逐节点由用户放行。
        boundaryGates: "user-confirmed-v1" as const,
      },
      director: structuredClone(reworkDirector),
      economics: structuredClone(brief.economics),
      voiceDirection: structuredClone(brief.voiceDirection),
      ...(brief.editorial ? { editorial: structuredClone(brief.editorial) } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.visualPlan ? { visualPlan: structuredClone(brief.visualPlan) } : {}),
      ...(brief.seriesContext ? { seriesContext: structuredClone(brief.seriesContext) } : {}),
      ...(brief.creationContext ? { creationContext: structuredClone(brief.creationContext) } : {}),
      rework,
    };
    return {
      input,
      inheritedNodeIds: [
        "brief",
        ...(previousScript ? ["script"] : []),
        ...(previousDirectorPlan ? ["visual-direction"] : []),
        ...(inheritedReferenceVideo ? ["reference-grammar"] : []),
        ...(findings.length ? ["visual-review"] : []),
      ],
      requiredAffectedScenePositions,
      scopeState: needsScope ? "needs_scope" as const : "resolved" as const,
      ...(needsScope ? { scopePrompt: "这条返工还无法确定影响范围。请选择要重做的镜头，或确认整片重做。" } : {}),
      ...(inheritedReferenceVideo ? {
        inheritedReferenceVideo: {
          label: inheritedReferenceVideo.label,
          mimeType: inheritedReferenceVideo.mimeType,
          sizeBytes: inheritedReferenceVideo.bytes.length,
        },
      } : {}),
    };
  }

  async loadInheritedReferenceVideo(input: unknown): Promise<{
    label: string;
    mimeType: "video/mp4" | "video/quicktime" | "video/webm";
    bytes: Buffer;
  } | undefined> {
    if (!isRecord(input)
      || input.referenceVideo !== undefined
      || !isRecord(input.workflowFeatures)
      || input.workflowFeatures.referenceGrammar !== true
      || !isRecord(input.rework)) return undefined;
    const sourceRunId = typeof input.rework.sourceRunId === "string" ? input.rework.sourceRunId : "";
    const sourceRunRevision = Number(input.rework.sourceRunRevision);
    if (!sourceRunId || !Number.isInteger(sourceRunRevision) || sourceRunRevision < 0) {
      throw new StudioInputError("返工来源不完整，请回到原制作重新发起。");
    }
    let source: WorkflowRun<ProductionBrief>;
    try {
      source = await this.options.pipeline.show(sourceRunId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioInputError("返工来源已经不存在，请回到原制作重新发起。");
      throw error;
    }
    if (source.revision !== sourceRunRevision) {
      throw new StudioConflictError("原制作在返工草稿打开后发生了变化，请重新读取审片建议。");
    }
    const sourceBrief = effectiveProductionBrief(source);
    if (!sourceBrief.workflowFeatures?.referenceGrammar || !sourceBrief.referenceVideo) {
      throw new StudioConflictError("上一版没有可继承的参考视频，请关闭参考视频分析或重新上传。");
    }
    return this.verifiedReferenceVideoForRun(source, sourceBrief);
  }

  private async verifiedReferenceVideoForRun(
    run: WorkflowRun<ProductionBrief>,
    brief: ProductionBrief,
  ): Promise<{
    label: string;
    mimeType: "video/mp4" | "video/quicktime" | "video/webm";
    bytes: Buffer;
  }> {
    const reference = brief.referenceVideo;
    if (!reference) throw new StudioConflictError("上一版没有可继承的参考视频，请重新上传。");
    const artifact = effectiveNodeArtifact(run, "reference-grammar", (candidate) => candidate.kind === "reference_video");
    if (!artifact?.uri || !artifact.sha256 || artifact.sizeBytes === undefined) {
      throw new StudioConflictError("上一版参考视频没有完整留档，请重新上传后再制作。");
    }
    if (artifact.sha256 !== reference.sha256
      || artifact.sizeBytes !== reference.sizeBytes
      || artifact.contentType !== reference.mimeType) {
      throw new StudioConflictError("上一版参考视频留档与原始记录不一致，请重新上传后再制作。");
    }
    const runRoot = path.join(this.options.workspaceRoot, "runs", run.id);
    await assertContainedFile(runRoot, artifact.uri);
    const bytes = await readFile(artifact.uri);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== reference.sizeBytes || actualSha256 !== reference.sha256) {
      throw new StudioConflictError("上一版参考视频内容已经变化，请重新上传后再制作。");
    }
    return { label: reference.label, mimeType: reference.mimeType, bytes };
  }

  // joint-v1 的正式脚本/导演方案由 creative-planning 节点产出；返工读取上一版文档时按拓扑
  // 选择正确的 producer 节点，legacy run 维持原节点。
  private reworkPlanningNodeIds(run: WorkflowRun<ProductionBrief>): { script: string; director: string } {
    return effectiveProductionBrief(run).workflowFeatures?.creativePlanning === "joint-v1"
      ? { script: "creative-planning", director: "creative-planning" }
      : { script: "script", director: "visual-direction" };
  }

  private async readReworkDocument(
    run: WorkflowRun<ProductionBrief>,
    nodeId: string,
    kind: string,
  ): Promise<Record<string, unknown> | undefined> {
    const artifact = effectiveNodeArtifact(run, nodeId, (candidate) => candidate.kind === kind && candidate.contentType === "application/json");
    if (!artifact?.uri) return undefined;
    if (!artifact.sha256 || artifact.sizeBytes === undefined) {
      throw new StudioConflictError(`上一版${nodeId}交付缺少完整性记录，无法安全带入返工草稿。`);
    }
    const runRoot = path.join(this.options.workspaceRoot, "runs", run.id);
    await assertContainedFile(runRoot, artifact.uri);
    const bytes = await readFile(artifact.uri);
    if (bytes.length > 150_000) throw new StudioConflictError(`上一版${nodeId}交付过大，无法安全带入返工草稿。`);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.sizeBytes || actualSha256 !== artifact.sha256) {
      throw new StudioConflictError(`上一版${nodeId}交付内容已经变化，无法安全带入返工草稿。`);
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new StudioConflictError(`上一版${nodeId}交付无法读取，请先检查该节点产物。`);
    }
    if (!isRecord(document)) throw new StudioConflictError(`上一版${nodeId}交付格式不正确。`);
    return document;
  }

  private async unmaterializedAssetScenePositions(
    run: WorkflowRun<ProductionBrief>,
    previousScript: unknown,
    previousDirectorPlan: unknown,
  ): Promise<number[]> {
    const document = await this.readReworkDocument(run, "assets", "generation_jobs");
    if (!document) return [];
    const paidSummary = await this.options.pipeline.inspectPaidNode(run.id, "assets");
    const materializedLedgerPositions = new Set(paidSummary.items.flatMap((item) => (
      item.state === "materialized" ? [item.scenePosition] : []
    )));
    if (document.version !== "video-factory/generation-jobs-v1" || !Array.isArray(document.jobs)) {
      throw new StudioConflictError("上一版画面任务记录格式不正确，请先检查素材节点产物。");
    }
    const incompleteJobPositions = document.jobs.flatMap((job): number[] => {
      if (!isRecord(job)) {
        throw new StudioConflictError("上一版画面任务记录格式不正确，请先检查素材节点产物。");
      }
      const position = Number(job.scenePosition);
      if (!Number.isInteger(position) || position < 1 || position > 10_000) {
        throw new StudioConflictError("上一版画面任务记录缺少有效镜头号，请先检查素材节点产物。");
      }
      return job.status === "succeeded" ? [] : [position];
    });
    const succeededJobPositions = new Set(document.jobs.flatMap((job): number[] => (
      isRecord(job) && job.status === "succeeded" ? [Number(job.scenePosition)] : []
    )));
    const assetPlan = await this.readReworkDocument(run, "assets", "asset_plan");
    if (!assetPlan) {
      const sceneUniverse = verifiedReworkScenePositions(previousScript, previousDirectorPlan);
      const expectedGenerationPositions = verifiedGenerationScenePositions(previousDirectorPlan)
        ?? sceneUniverse
        ?? [];
      return [...new Set([
        ...incompleteJobPositions.filter((position) => !materializedLedgerPositions.has(position)),
        ...expectedGenerationPositions.filter((position) => (
          !succeededJobPositions.has(position) && !materializedLedgerPositions.has(position)
        )),
      ])].sort((left, right) => left - right);
    }
    if (!Array.isArray(assetPlan.scene_assets)) {
      throw new StudioConflictError("上一版画面计划格式不正确，请先检查素材节点产物。");
    }
    const planPositions: number[] = [];
    const unmaterializedPlanPositions: number[] = [];
    const materializedPlanPositions = new Set<number>();
    for (const asset of assetPlan.scene_assets) {
      if (!isRecord(asset)) {
        throw new StudioConflictError("上一版画面计划格式不正确，请先检查素材节点产物。");
      }
      const position = Number(asset.scene_position);
      if (!Number.isInteger(position) || position < 1 || position > 10_000) {
        throw new StudioConflictError("上一版画面计划缺少有效镜头号，请先检查素材节点产物。");
      }
      planPositions.push(position);
      if (typeof asset.local_path !== "string" || !asset.local_path.trim()) {
        unmaterializedPlanPositions.push(position);
      } else {
        materializedPlanPositions.add(position);
      }
    }
    const uniquePlanPositions = [...new Set(planPositions)].sort((left, right) => left - right);
    if (uniquePlanPositions.length !== planPositions.length) {
      throw new StudioConflictError("上一版画面计划包含重复镜头，请先检查素材节点产物。");
    }
    const sceneUniverse = verifiedReworkScenePositions(previousScript, previousDirectorPlan);
    if (sceneUniverse && !isDeepStrictEqual(uniquePlanPositions, sceneUniverse)) {
      throw new StudioConflictError("上一版画面计划与脚本或导演方案不一致，请先检查素材节点产物。");
    }
    const planPositionSet = new Set(uniquePlanPositions);
    if (document.jobs.some((job) => isRecord(job) && !planPositionSet.has(Number(job.scenePosition)))) {
      throw new StudioConflictError("上一版画面任务包含画面计划之外的镜头，请先检查素材节点产物。");
    }
    return [...new Set([
      ...incompleteJobPositions.filter((position) => (
        !materializedPlanPositions.has(position) && !materializedLedgerPositions.has(position)
      )),
      ...unmaterializedPlanPositions.filter((position) => !materializedLedgerPositions.has(position)),
    ])]
      .sort((left, right) => left - right);
  }

  async archive(runIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(runIds)];
    try {
      await this.options.pipeline.withRunMaintenanceLease(uniqueIds, async () => {
        const runs = await Promise.all(uniqueIds.map((runId) => this.loadRequiredRun(runId)));
        const active = runs.find((run) => !isTerminalRun(run.status));
        if (active) {
          throw new StudioConflictError(`“${active.initialInput.title}”仍在运行或等待确认，结束流程后才能归档。`);
        }
        const uncertain = runs.find((run) => run.nodeRuns.some((node) => node.outcomeUncertain));
        if (uncertain) {
          throw new StudioConflictError(`“${uncertain.initialInput.title}”还有付费结果尚未核对，完成任务与账单核对后才能归档。`);
        }
        await this.options.archiveStore.archive(uniqueIds, (this.options.now ?? (() => new Date()))().toISOString());
      });
    } catch (error) {
      if (error instanceof RunLockedError) {
        throw new StudioConflictError("所选制作仍在执行或正在变更，请等待当前操作结束后再归档。");
      }
      throw error;
    }
  }

  async restore(runIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(runIds)];
    try {
      await this.options.pipeline.withRunMaintenanceLease(uniqueIds, async () => {
        await Promise.all(uniqueIds.map((runId) => this.loadRequiredRun(runId)));
        await this.options.archiveStore.restore(uniqueIds);
      });
    } catch (error) {
      if (error instanceof RunLockedError) {
        throw new StudioConflictError("所选制作正在执行或变更，请等待当前操作结束后再恢复。");
      }
      throw error;
    }
  }

  async remove(runId: string): Promise<void> {
    try {
      await this.options.pipeline.withRunMaintenanceLease([runId], async () => {
        const current = await this.loadRequiredRun(runId);
        if (!isTerminalRun(current.status)) {
          throw new StudioConflictError("这条制作仍在运行或等待确认，结束流程后才能删除。");
        }
        if (current.nodeRuns.some((node) => node.outcomeUncertain)) {
          throw new StudioConflictError("这条制作还有付费结果尚未核对，完成任务与账单核对后才能永久删除。");
        }
        const archived = await this.options.archiveStore.list();
        if (!archived[runId]) {
          throw new StudioConflictError("请先归档这条制作，再从归档记录中永久删除。");
        }
        await this.options.pipeline.remove(runId);
        await this.options.archiveStore.restore([runId]);
      });
    } catch (error) {
      if (error instanceof RunLockedError) {
        throw new StudioConflictError("这条制作仍在执行或正在变更，请等待当前操作结束后再删除。");
      }
      throw error;
    }
    this.listeners.delete(runId);
    await this.removeStartRecordsForRun(runId);
  }

  private async removeStartRecordsForRun(runId: string): Promise<void> {
    const directory = path.join(this.options.workspaceRoot, "idempotency", "production-start");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const recordPath = path.join(directory, entry);
      try {
        const record = await readStartRecord(recordPath);
        if (record.state === "completed" && record.response?.runId === runId) {
          await rm(recordPath, { force: true });
        }
      } catch {
        // 旧记录损坏不应阻止用户删除已经结束的制作。
      }
    }));
  }

  async replayStart(input: unknown, idempotencyKey?: string): Promise<StartRunResponse | undefined> {
    if (!idempotencyKey) return undefined;
    assertIdempotencyKey(idempotencyKey);
    const digest = startRequestDigest(input);
    const inFlight = this.startsInFlight.get(idempotencyKey);
    if (inFlight) {
      if (inFlight.digest !== digest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      return inFlight.operation;
    }
    const recordPath = startRecordPath(this.options.workspaceRoot, idempotencyKey);
    try {
      await stat(recordPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const previous = await readStartRecord(recordPath);
    if (previous.digest !== digest) {
      throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
    }
    if (previous.state === "completed" && previous.response) {
      try {
        await this.options.pipeline.show(previous.response.runId);
        return previous.response;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        await rm(recordPath, { force: true });
        return undefined;
      }
    }
    throw new StudioConflictError("相同制作请求仍在处理中，请稍后查看制作记录，不会重复扣费。");
  }

  async start(input: unknown, idempotencyKey?: string, idempotencyInput: unknown = input): Promise<StartRunResponse> {
    assertStudioExecutableProductionInput(input);
    const replay = await this.replayStart(idempotencyInput, idempotencyKey);
    if (replay) return replay;
    const brief = parseBriefWithInputError(input);
    if (brief.reviewMode !== "manual") {
      throw new StudioInputError("正式制作必须经过人工终审，不能自动跳过发布前确认。");
    }
    if (brief.rework && brief.providers.script !== "codex-screenwriter-v1") {
      throw new StudioInputError("按审片意见返工需要使用支持自由文本修改的 AI 编剧，请在编剧一栏选择 AI 编剧后再开工。");
    }
    await this.assertReworkSource(brief);
    // 模板暂停参与新制作；不改写历史 run，也不继承模板的模型默认值。
    delete brief.templateSnapshot;
    await this.assertProvidersAvailable(brief);
    if (!idempotencyKey) return this.dispatchBrief(brief);
    assertIdempotencyKey(idempotencyKey);
    const existing = this.startsInFlight.get(idempotencyKey);
    const requestDigest = startRequestDigest(idempotencyInput);
    if (existing) {
      if (existing.digest !== requestDigest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      return existing.operation;
    }
    const operation = this.startIdempotently(brief, idempotencyKey, requestDigest).finally(() => {
      if (this.startsInFlight.get(idempotencyKey)?.operation === operation) this.startsInFlight.delete(idempotencyKey);
    });
    this.startsInFlight.set(idempotencyKey, { digest: requestDigest, operation });
    return operation;
  }

  private async assertReworkSource(brief: ProductionBrief): Promise<void> {
    if (!brief.rework) return undefined;
    let source: WorkflowRun<ProductionBrief>;
    try {
      source = await this.options.pipeline.show(brief.rework.sourceRunId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioInputError("返工来源已经不存在，请回到原制作重新发起。");
      throw error;
    }
    if (source.revision !== brief.rework.sourceRunRevision) {
      throw new StudioConflictError("原制作在返工草稿打开后发生了变化，请重新读取审片建议。");
    }
    if (!canCreateReworkFrom(source)) {
      throw new StudioConflictError("只有失败、已打回或已完成的制作才能作为新版本来源。");
    }
    if (source.nodeRuns.some((node) => node.outcomeUncertain)) {
      throw new StudioConflictError("这条制作还有付费结果尚未核对，完成账单核对后才能重新制作。");
    }
    const rejectedResources = this.options.loadRejectedVisualResources
      ? await this.options.loadRejectedVisualResources(source.id)
      : [];
    const canonicalFindings = [
      ...reworkFindings(this.toDetail(source)),
      ...resourceReworkFindings(source.id, rejectedResources),
    ];
    const manualRejectionReason = latestManualRejectionReason(source);
    if (!isDeepStrictEqual(brief.rework.findings, canonicalFindings)) {
      throw new StudioConflictError("审片问题已经变化或被修改，请重新读取原制作的返工草稿。");
    }
    const sourcePlanningNodeIds = this.reworkPlanningNodeIds(source);
    const [canonicalPreviousScript, canonicalPreviousDirectorPlan] = await Promise.all([
      this.readReworkDocument(source, sourcePlanningNodeIds.script, "script"),
      this.readReworkDocument(source, sourcePlanningNodeIds.director, "storyboard"),
    ]);
    if (!isDeepStrictEqual(brief.rework.previousScript, canonicalPreviousScript)
      || !isDeepStrictEqual(brief.rework.previousDirectorPlan, canonicalPreviousDirectorPlan)) {
      throw new StudioConflictError("上一版脚本或导演方案已经变化，请重新读取原制作的返工草稿。");
    }
    const canonicalAffectedScenePositions = await this.unmaterializedAssetScenePositions(
      source,
      canonicalPreviousScript,
      canonicalPreviousDirectorPlan,
    );
    const submittedAffectedScenePositions = brief.rework.affectedScenePositions;
    if (submittedAffectedScenePositions === undefined) {
      if (canonicalAffectedScenePositions.length > 0) {
        throw new StudioConflictError("未物化镜头范围已经变化或被修改，请回到原制作重新读取返工草稿。");
      }
      // B5-R1 needs_scope：拒绝说明无法定位时，空范围不允许静默开跑——
      // 用户必须选择镜头范围或显式确认整片重做。
      if (manualRejectionReason && canonicalFindings.length === 0
        && reworkScopeUnresolved({
          findings: canonicalFindings,
          unmaterializedAssetScenePositions: canonicalAffectedScenePositions,
          previousScript: canonicalPreviousScript,
          previousDirectorPlan: canonicalPreviousDirectorPlan,
          manualRejectionReason,
          recommended: [],
        })) {
        throw new StudioConflictError("这条返工还无法确定影响范围。请选择要重做的镜头，或明确确认整片重做后再开始。");
      }
    } else {
      // BG-04：needs_scope 守卫同样覆盖显式空数组路径——拒绝说明无法定位时，
      // 用户必须先选择镜头范围或确认整片重做，空范围不允许静默开跑。
      if (submittedAffectedScenePositions.length === 0 && manualRejectionReason && canonicalFindings.length === 0) {
        const canonicalRecommended = recommendedReworkScenePositions({
          findings: canonicalFindings,
          unmaterializedAssetScenePositions: canonicalAffectedScenePositions,
          previousScript: canonicalPreviousScript,
          previousDirectorPlan: canonicalPreviousDirectorPlan,
          ...(manualRejectionReason ? { manualRejectionReason } : {}),
        });
        if (reworkScopeUnresolved({
          findings: canonicalFindings,
          unmaterializedAssetScenePositions: canonicalAffectedScenePositions,
          previousScript: canonicalPreviousScript,
          previousDirectorPlan: canonicalPreviousDirectorPlan,
          manualRejectionReason,
          recommended: canonicalRecommended,
        })) {
          throw new StudioConflictError("这条返工还无法确定影响范围。请选择要重做的镜头，或明确确认整片重做后再开始。");
        }
      }
      const canonicalRequiredPositions = recommendedReworkScenePositions({
        findings: canonicalFindings,
        unmaterializedAssetScenePositions: canonicalAffectedScenePositions,
        previousScript: canonicalPreviousScript,
        previousDirectorPlan: canonicalPreviousDirectorPlan,
        ...(manualRejectionReason ? { manualRejectionReason } : {}),
      });
      const submitted = new Set(submittedAffectedScenePositions);
      if (canonicalRequiredPositions.some((position) => !submitted.has(position))) {
        throw new StudioConflictError("返工范围不能移除审片问题或未物化镜头，请重新读取审片建议后调整。");
      }
      const sceneUniverse = verifiedReworkScenePositions(canonicalPreviousScript, canonicalPreviousDirectorPlan);
      const allowedWithoutUniverse = new Set(canonicalRequiredPositions);
      if (sceneUniverse
        ? submittedAffectedScenePositions.some((position) => !sceneUniverse.includes(position))
        : submittedAffectedScenePositions.some((position) => !allowedWithoutUniverse.has(position))) {
        throw new StudioConflictError("返工范围包含上一版中不存在的镜头，请重新读取原制作。");
      }
    }

  }

  private async dispatchBrief(brief: ProductionBrief): Promise<StartRunResponse> {
    if (Object.keys(this.historicalNodeDurations).length === 0) {
      this.historicalNodeDurations = collectNodeDurationHistory(await this.options.pipeline.list());
    }
    const dispatched = await this.options.pipeline.dispatch(brief, (run) => this.publish(this.toDetail(run)));
    this.trackCompletion(dispatched);
    return { runId: dispatched.runId, status: "running" };
  }

  private trackCompletion(dispatched: DispatchedProductionRun): void {
    const tracked: Promise<void> = dispatched.completion
      .then(() => undefined)
      .catch(async () => {
        const persisted = await this.get(dispatched.runId);
        if (persisted) this.publish(persisted);
      })
      .finally(() => this.completions.delete(tracked));
    this.completions.add(tracked);
  }

  private async dispatchedDetail(dispatched: DispatchedProductionRun): Promise<StudioRunDetail> {
    this.trackCompletion(dispatched);
    const running = await this.loadRequiredRun(dispatched.runId);
    const detail = await withAgentLoopProgress(
      this.toDetail(running),
      this.options.workspaceRoot,
      running.nodeRuns,
    );
    this.publish(detail);
    return detail;
  }

  // C2：报价准备——只计算并保存不可变 quote，不调用任何媒体 Provider。
  async prepareProductionQuote(runId: string, input: StudioProductionQuoteInput, _actor = "studio-owner"): Promise<StudioProductionQuote> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status !== "awaiting_spend_approval" && current.status !== "approval_invalidated") {
      throw new StudioInputError("当前制作没有等待确认的报价，请先完成制作方案再确认费用。");
    }
    if (current.revision !== input.expectedRunRevision) {
      throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
    }
    const waiting = current.nodeRuns.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
    const plan = waiting?.spendPlan;
    if (!plan) throw new StudioInputError("当前制作没有等待确认的报价。");
    const authoritativePlanDigest = await currentExecutablePlanDigest(current, this.options.workspaceRoot);
    if (!authoritativePlanDigest || authoritativePlanDigest !== input.acceptedPlanDigest) {
      throw new StudioConflictError("制作方案已经变化，请刷新后重新获取报价。");
    }
    if (input.requestedMaximumCny !== undefined && (!Number.isFinite(input.requestedMaximumCny) || input.requestedMaximumCny <= 0 || input.requestedMaximumCny > 1_000_000)) {
      throw new StudioInputError("本次最高授权额必须是 0.01 到 10000 元之间的有效金额。");
    }
    // 金额以整数分为权威：非整数分（如 6.006 元 → 600.6 分）拒绝，不能静默四舍五入成
    // 601 分——展示金额与签发金额必须完全一致（RC2-03）。容差只吸收二进制浮点表示误差
    // （6.01 × 100 = 600.999…），不放过真实的小数分。
    if (input.requestedMaximumCny !== undefined) {
      const centsValue = input.requestedMaximumCny * 100;
      if (Math.abs(centsValue - Math.round(centsValue)) > 1e-6) {
        throw new StudioInputError("本次最高授权额必须精确到分（0.01 元），不能带更小的零头。");
      }
    }
    if (input.requestedMaximumCny !== undefined && input.requestedMaximumCny < plan.estimatedCostCny) {
      throw new StudioInputError(`当前方案预计花费 ¥${plan.estimatedCostCny.toFixed(2)}，高于你填写的最高授权额；请提高额度或调整方案。`);
    }
    const requestedAllowedModels = input.allowedModels ?? (plan.items ?? []).map((item) => ({
      providerId: item.providerId,
      modelId: item.modelId,
    }));
    const allowedModels = [...new Map(requestedAllowedModels.map((model) => (
      [`${model.providerId}\0${model.modelId}`, model] as const
    ))).values()];
    const availableModels = new Set((plan.items ?? []).map((item) => `${item.providerId}\0${item.modelId}`));
    if (allowedModels.some((model) => !availableModels.has(`${model.providerId}\0${model.modelId}`))) {
      throw new StudioInputError("所选模型不在当前方案的可执行范围内，请重新选择方案列出的模型。");
    }
    for (const item of plan.items ?? []) {
      if (!allowedModels.some((model) => model.providerId === item.providerId && model.modelId === item.modelId)) {
        throw new StudioInputError(`当前方案的“${item.label}”没有保留可执行模型，请调整方案。`);
      }
    }
    const maximumCostCny = input.requestedMaximumCny ?? plan.maxCostCny;
    const brief = effectiveProductionBrief(current);
    const qualityContractDigest = productionQualityContractDigest(brief);
    const permittedAssets = (plan.items ?? []).map((item) => ({
      assetKey: item.id,
      intentDigest: canonicalProductionAssetIntentDigest(authoritativePlanDigest, item.id),
      models: allowedModels.filter((model) => model.providerId === item.providerId && model.modelId === item.modelId),
      maxCreateAttempts: plan.maxAttempts,
    }));
    const active = typeof this.options.pipeline.readProductionAuthorization === "function"
      ? await this.options.pipeline.readProductionAuthorization(runId)
      : undefined;
    const maximumCents = Math.round(maximumCostCny * 100);
    const additionalCents = active ? Math.max(0, maximumCents - active.approvedAmountCents) : 0;
    const fundingRequestId = active ? `funding-${randomUUID()}` : undefined;
    const quote: StudioProductionQuote = {
      quoteId: `quote-${randomUUID()}`,
      acceptedPlanDigest: authoritativePlanDigest,
      estimatedCostCny: plan.estimatedCostCny,
      maximumCostCny,
      scopeSummary: {
        content: `${brief.title}｜${brief.angle}｜面向${brief.audience}`,
        assets: (plan.items ?? []).map((item) => ({
          assetKey: item.id,
          label: item.label,
          estimatedCostCny: item.estimatedCostCny,
          allowedModels: permittedAssets.find((asset) => asset.assetKey === item.id)?.models ?? [],
          maxCreateAttempts: plan.maxAttempts,
        })),
        // 免收费镜头本身不授权、不计费，只是让操作员把"免费"与"漏算"分开。
        ...(plan.excludedItems?.length
          ? { excludedAssets: plan.excludedItems.map((item) => ({ id: item.id, label: item.label, note: item.note })) }
          : {}),
        uncertainty: plan.items?.length ? ["实际结果仍需素材预检、技术质检和独立视觉审片。"] : [],
      },
      ...(fundingRequestId ? {
        fundingRequestId,
        // 追加命令的 URL 合同需要活动授权 id（funding.authorizationId == current active head）。
        fundingAuthorizationId: active!.id,
        additionalCents,
        missingGoals: (plan.items ?? []).map((item) => item.label),
        preservedWork: current.artifacts.map((artifact) => artifact.kind),
        purpose: "完成当前方案尚未覆盖的图片或视频制作与有限修复",
      } : {}),
      feasible: true,
    };
    // 不可变落盘：同一 run 的报价记录按 quoteId 保存，供授权命令核对。
    const quotesDir = path.join(this.options.workspaceRoot, "runs", runId, "production-quotes");
    await mkdir(quotesDir, { recursive: true });
    await writeFile(
      path.join(quotesDir, `${quote.quoteId}.json`),
      `${JSON.stringify({
        ...quote,
        runId,
        expectedRunRevision: input.expectedRunRevision,
        qualityContractDigest,
        permittedAssets,
        maxAttempts: plan.maxAttempts,
        createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    if (fundingRequestId) {
      const fundingDirectory = path.join(this.options.workspaceRoot, "runs", runId, "production-funding-requests");
      await mkdir(fundingDirectory, { recursive: true });
      await writePrivateTextAtomically(
        path.join(fundingDirectory, `${fundingRequestId}.json`),
        `${JSON.stringify({
          version: "video-factory/production-funding-request-v1",
          id: fundingRequestId,
          runId,
          authorizationId: active!.id,
          expectedRunRevision: input.expectedRunRevision,
          acceptedPlanDigest: authoritativePlanDigest,
          qualityContractDigest,
          additionalCents,
          permittedAssets,
          missingGoals: quote.missingGoals,
          preservedWork: quote.preservedWork,
          purpose: quote.purpose,
          feasible: true,
        }, null, 2)}\n`,
      );
    }
    return quote;
  }

  // C2：授权业务命令——只接受服务端已保存的 quote；幂等重放同 key 同结果。
  async authorizeProductionScope(runId: string, input: StudioProductionAuthorizationInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    assertIdempotencyKey(input.idempotencyKey);
    const requestDigest = startRequestDigest({ runId, actor, target: input.quoteId, input });
    const authRecordPath = commandReceiptPath(this.options.workspaceRoot, runId, "production-authorization", input.idempotencyKey);
    // 幂等重放：同 key 同 digest 恢复历史命令结果——恢复必须复用 prepared receipt 保存的
    // 原始 scope（不重新生成 approvedAt/金额），并区分"授权已提交"与"续链已完成"。
    try {
      const previous = JSON.parse(await readFile(authRecordPath, "utf8")) as {
        digest: string;
        status?: string;
        authorizationId?: string;
        scope?: unknown;
      };
      if (previous.digest !== requestDigest) {
        throw new StudioConflictError("这个授权请求编号已被另一组参数使用，请重新打开确认面板。");
      }
      const active = await this.options.pipeline.readProductionAuthorization?.(runId);
      if (active?.id === previous.authorizationId) {
        // 授权已提交：若续链尚未完成（进程在 run CAS 与续链之间中断），重新执行幂等的
        // governed continuation；然后补齐 accepted receipt。
        const continued = await this.options.pipeline.resumeCoveredSpendApproval?.(runId);
        if (previous.status !== "accepted") {
          const persisted = continued ?? await this.options.pipeline.show(runId);
          await writePrivateTextAtomically(authRecordPath, `${JSON.stringify({
            version: "video-factory/production-command-v1",
            status: "accepted",
            digest: requestDigest,
            runId,
            actor,
            authorizationId: previous.authorizationId,
            resultingRunRevision: persisted.revision,
          }, null, 2)}\n`);
        } else {
          await this.options.pipeline.resumeCoveredSpendApproval?.(runId);
        }
        const replayed = await this.get(runId);
        if (!replayed) throw new StudioNotFoundError("没有找到这条制作记录。");
        return replayed;
      }
      if (previous.status === "accepted") {
        // 历史已接受的命令（可能已被后续授权替代）：返回当前 run，不恢复旧授权、不再次提交。
        const replayed = await this.get(runId);
        if (!replayed) throw new StudioNotFoundError("没有找到这条制作记录。");
        return replayed;
      }
      // prepared 且授权未提交：以保存的原始 scope 重放同一次接受（字节一致才能通过
      // 宿主的"同内容幂等接受"检查；revision 过期则被拒，不会签发过期授权）。
      if (previous.status === "prepared" && previous.scope && typeof this.options.pipeline.acceptProductionAuthorization === "function") {
        const updated = await this.options.pipeline.acceptProductionAuthorization(runId, previous.scope);
        await writePrivateTextAtomically(authRecordPath, `${JSON.stringify({
          version: "video-factory/production-command-v1",
          status: "accepted",
          digest: requestDigest,
          runId,
          actor,
          authorizationId: previous.authorizationId,
          resultingRunRevision: updated.revision,
        }, null, 2)}\n`);
        const detail = this.toDetail(updated);
        this.publish(detail);
        return detail;
      }
    } catch (error) {
      if (error instanceof StudioConflictError) throw error;
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.revision !== input.expectedRunRevision) {
      throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
    }
    // 核对服务端保存的不可变 quote：不存在 / digest 不一致 / revision 过期都拒绝。
    let quote: StudioProductionQuote & {
      id?: string;
      runId: string;
      expectedRunRevision: number;
      qualityContractDigest: string;
      permittedAssets: ProductionAuthorizationScope["permittedAssets"];
    };
    try {
      quote = JSON.parse(await readFile(path.join(this.options.workspaceRoot, "runs", runId, "production-quotes", `${input.quoteId}.json`), "utf8"));
    } catch {
      throw new StudioInputError("这份报价不存在或已过期，请重新确认方案后获取新报价。");
    }
    if (quote.quoteId !== input.quoteId || quote.runId !== runId || quote.acceptedPlanDigest !== input.acceptedPlanDigest) {
      throw new StudioInputError("报价与当前确认的方案不一致，请重新获取报价。");
    }
    if (quote.expectedRunRevision !== input.expectedRunRevision) {
      throw new StudioConflictError("这份报价基于更早的制作版本，请刷新后重新确认。");
    }
    // 由可信服务构造 scope（客户端不能自报 approvedBy/金额/质量合同），走 C1 接受 + 自动继续。
    const active = typeof this.options.pipeline.readProductionAuthorization === "function"
      ? await this.options.pipeline.readProductionAuthorization(runId)
      : undefined;
    const authorizationId = `auth-${createHash("sha256").update(requestDigest).digest("hex").slice(0, 32)}`;
    const scope = {
      version: "video-factory/production-authorization-v1" as const,
      id: authorizationId,
      runId,
      approvalRevision: current.revision,
      acceptedPlanDigest: input.acceptedPlanDigest,
      qualityContractDigest: quote.qualityContractDigest,
      approvedAmountCents: Math.max(active?.approvedAmountCents ?? 0, Math.round(quote.maximumCostCny * 100)),
      approvedBy: actor,
      approvedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      permittedAssets: quote.permittedAssets,
      ...(active ? { supersedesAuthorizationId: active.id } : {}),
    };
    if (typeof this.options.pipeline.acceptProductionAuthorization !== "function") {
      throw new StudioInputError("当前环境没有启用制作范围授权。");
    }
    await mkdir(path.dirname(authRecordPath), { recursive: true });
    await writePrivateTextAtomically(authRecordPath, `${JSON.stringify({
      version: "video-factory/production-command-v1",
      status: "prepared",
      digest: requestDigest,
      runId,
      actor,
      authorizationId,
      scope,
    }, null, 2)}\n`);
    const currentActive = await this.options.pipeline.readProductionAuthorization?.(runId);
    const updated = currentActive?.id === authorizationId
      ? await this.options.pipeline.show(runId)
      : await this.options.pipeline.acceptProductionAuthorization(runId, scope);
    await writePrivateTextAtomically(authRecordPath, `${JSON.stringify({
      version: "video-factory/production-command-v1",
      status: "accepted",
      digest: requestDigest,
      runId,
      actor,
      authorizationId,
      resultingRunRevision: updated.revision,
    }, null, 2)}\n`);
    const detail = this.toDetail(updated);
    this.publish(detail);
    return detail;
  }

  // C2：追加——delta 加在当前授权之上，supersede 当前 head，旧花费/占用不清零。
  async amendProductionScope(runId: string, authorizationId: string, input: StudioProductionAmendmentInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    assertIdempotencyKey(input.idempotencyKey);
    // 幂等：同 key 同 digest 的重放恢复历史命令结果——复用 prepared receipt 保存的原始
    // amendment scope（不重新生成 approvedAt/金额），区分"授权已提交"与"续链已完成"。
    const amendDigest = startRequestDigest({ runId, actor, target: authorizationId, input });
    const amendRecordPath = commandReceiptPath(this.options.workspaceRoot, runId, "production-amendment", input.idempotencyKey);
    try {
      const previous = JSON.parse(await readFile(amendRecordPath, "utf8")) as {
        digest: string;
        status?: string;
        authorizationId?: string;
        scope?: unknown;
      };
      if (previous.digest !== amendDigest) {
        throw new StudioConflictError("这个追加请求编号已被另一组参数使用，请重新发起追加。");
      }
      const active = await this.options.pipeline.readProductionAuthorization?.(runId);
      if (active?.id === previous.authorizationId) {
        // 追加授权已提交：续链可能尚未完成（run CAS 后中断）——幂等恢复 governed
        // continuation，然后补齐 accepted receipt。delta 不会重复：续链不签发新授权。
        const continued = await this.options.pipeline.resumeCoveredSpendApproval?.(runId);
        if (previous.status !== "accepted") {
          const persisted = continued ?? await this.options.pipeline.show(runId);
          await writePrivateTextAtomically(amendRecordPath, `${JSON.stringify({
            version: "video-factory/production-command-v1",
            status: "accepted",
            digest: amendDigest,
            runId,
            actor,
            authorizationId: previous.authorizationId,
            resultingRunRevision: persisted.revision,
          }, null, 2)}\n`);
        } else {
          await this.options.pipeline.resumeCoveredSpendApproval?.(runId);
        }
        const replayed = await this.get(runId);
        if (!replayed) throw new StudioNotFoundError("没有找到这条制作记录。");
        return replayed;
      }
      if (previous.status === "accepted") {
        // 历史已接受的追加（可能已被后续授权替代）：返回当前 run，不恢复旧授权、不再追加。
        const replayed = await this.get(runId);
        if (!replayed) throw new StudioNotFoundError("没有找到这条制作记录。");
        return replayed;
      }
      // prepared 且追加授权未提交：以保存的原始 amendment scope 重放同一次接受；
      // revision 过期（世界已前进）时被宿主拒绝，不会用过期授权重复 delta。
      if (previous.status === "prepared" && previous.scope && typeof this.options.pipeline.acceptProductionAuthorization === "function") {
        const updated = await this.options.pipeline.acceptProductionAuthorization(runId, previous.scope);
        await writePrivateTextAtomically(amendRecordPath, `${JSON.stringify({
          version: "video-factory/production-command-v1",
          status: "accepted",
          digest: amendDigest,
          runId,
          actor,
          authorizationId: previous.authorizationId,
          resultingRunRevision: updated.revision,
        }, null, 2)}\n`);
        const detail = this.toDetail(updated);
        this.publish(detail);
        return detail;
      }
    } catch (error) {
      if (error instanceof StudioConflictError) throw error;
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.revision !== input.expectedRunRevision) {
      throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
    }
    if (typeof this.options.pipeline.readProductionAuthorization !== "function"
      || typeof this.options.pipeline.acceptProductionAuthorization !== "function") {
      throw new StudioInputError("当前环境没有启用制作范围授权。");
    }
    const active = await this.options.pipeline.readProductionAuthorization(runId);
    if (!active) throw new StudioInputError("这条制作还没有已接受的授权，无法追加。");
    if (active.id !== authorizationId) {
      throw new StudioConflictError("这份追加请求对应的授权已经变化，请刷新后重试。");
    }
    const fundingPath = path.join(this.options.workspaceRoot, "runs", runId, "production-funding-requests", `${input.fundingRequestId}.json`);
    let funding: {
      version: string;
      id: string;
      runId: string;
      authorizationId: string;
      expectedRunRevision: number;
      acceptedPlanDigest: string;
      qualityContractDigest: string;
      additionalCents: number;
      permittedAssets: ProductionAuthorizationScope["permittedAssets"];
      feasible: boolean;
    };
    try {
      funding = JSON.parse(await readFile(fundingPath, "utf8"));
    } catch {
      throw new StudioInputError("追加请求不存在或已过期，请重新读取当前缺口。");
    }
    if (funding.version !== "video-factory/production-funding-request-v1"
      || funding.id !== input.fundingRequestId
      || funding.runId !== runId
      || funding.authorizationId !== authorizationId
      || funding.expectedRunRevision !== input.expectedRunRevision
      || !funding.feasible
      || !Number.isSafeInteger(funding.additionalCents)
      || funding.additionalCents < 0) {
      throw new StudioConflictError("追加请求已不适用于当前制作，请刷新后重新确认。");
    }
    const nextAuthorizationId = `auth-${createHash("sha256").update(amendDigest).digest("hex").slice(0, 32)}`;
    const amendment = {
      version: "video-factory/production-authorization-v1" as const,
      id: nextAuthorizationId,
      runId,
      approvalRevision: current.revision,
      acceptedPlanDigest: funding.acceptedPlanDigest,
      qualityContractDigest: funding.qualityContractDigest,
      approvedAmountCents: active.approvedAmountCents + funding.additionalCents,
      approvedBy: actor,
      approvedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      permittedAssets: funding.permittedAssets,
      supersedesAuthorizationId: active.id,
    };
    await mkdir(path.dirname(amendRecordPath), { recursive: true });
    await writePrivateTextAtomically(amendRecordPath, `${JSON.stringify({
      version: "video-factory/production-command-v1",
      status: "prepared",
      digest: amendDigest,
      runId,
      actor,
      authorizationId: nextAuthorizationId,
      scope: amendment,
    }, null, 2)}\n`);
    const currentHead = await this.options.pipeline.readProductionAuthorization(runId);
    const updated = currentHead?.id === nextAuthorizationId
      ? await this.options.pipeline.show(runId)
      : await this.options.pipeline.acceptProductionAuthorization(runId, amendment);
    await writePrivateTextAtomically(amendRecordPath, `${JSON.stringify({
      version: "video-factory/production-command-v1",
      status: "accepted",
      digest: amendDigest,
      runId,
      actor,
      authorizationId: nextAuthorizationId,
      resultingRunRevision: updated.revision,
    }, null, 2)}\n`);
    const detail = this.toDetail(updated);
    this.publish(detail);
    return detail;
  }

  private toDetail(run: WorkflowRun<ProductionBrief>): StudioRunDetail {
    return toRunDetail(run, {
      now: (this.options.now ?? (() => new Date()))().toISOString(),
      historicalNodeDurations: this.historicalNodeDurations,
    });
  }

  private async startIdempotently(brief: ProductionBrief, idempotencyKey: string, digest: string): Promise<StartRunResponse> {
    const directory = path.join(this.options.workspaceRoot, "idempotency", "production-start");
    const recordPath = startRecordPath(this.options.workspaceRoot, idempotencyKey);
    await mkdir(directory, { recursive: true });
    try {
      const handle = await open(recordPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, state: "pending", digest })}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const previous = await readStartRecord(recordPath);
      if (previous.digest !== digest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      if (previous.state === "completed" && previous.response) return previous.response;
      throw new StudioConflictError("相同制作请求仍在处理中，请稍后查看制作记录，不会重复扣费。");
    }

    let response: StartRunResponse;
    try {
      response = await this.dispatchBrief(brief);
    } catch (error) {
      await rm(recordPath, { force: true });
      throw error;
    }
    try {
      await writeStartRecord(recordPath, { version: 1, state: "completed", digest, response });
    } catch (error) {
      throw new ProductionStartDispatchedError(response.runId, error);
    }
    return response;
  }

  async decide(runId: string, input: StudioDecisionInput, actor: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status !== "needs_human") throw new StudioConflictError("这条制作当前不在人工终审阶段。");
    const intervention = current.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
    if (!intervention) throw new StudioConflictError("这条制作没有待处理的人工决定。");
    if (input.interventionId !== intervention.id || input.expectedRunRevision !== current.revision) {
      throw new StudioConflictError("你查看的成片或审片意见已经更新，请重新查看后再确认。");
    }
    if (!intervention.options?.includes(input.action)) {
      throw new StudioConflictError("当前确认点不支持这个操作，请刷新后重试。");
    }
    if (input.action === "request_changes") {
      if (intervention.nodeId === "voice" && input.voiceTiming) {
        const updated = await this.options.pipeline.requestVoiceTimingRevision(runId, {
          expectedRunRevision: input.expectedRunRevision,
          interventionId: input.interventionId,
          scenePosition: input.voiceTiming.scenePosition,
          durationSeconds: input.voiceTiming.durationSeconds,
          actor,
        });
        const detail = this.toDetail(updated);
        this.publish(detail);
        return detail;
      }
      if (intervention.kind !== "source_review_decision" || input.voiceTiming) {
        throw new StudioConflictError("当前确认点没有可调整的方案。");
      }
    }
    if (input.action === "reject" && !input.note?.trim()) throw new StudioConflictError("打回时必须填写原因。");
    const decision: HumanDecisionDraft = {
      interventionId: input.interventionId,
      action: input.action,
      actor,
      expectedRunRevision: input.expectedRunRevision,
      reviewEvidenceId: input.reviewEvidenceId,
      ...(input.note ? { note: input.note } : {}),
      ...(input.reviewDispositions ? { reviewDispositions: input.reviewDispositions } : {}),
    };
    let updated: WorkflowRun<ProductionBrief>;
    try {
      if (this.options.pipeline.dispatchDecision) {
        const dispatched = await this.options.pipeline.dispatchDecision(
          runId,
          decision,
          (run) => this.publish(this.toDetail(run)),
        );
        return await this.dispatchedDetail(dispatched);
      }
      updated = await this.options.pipeline.decide(runId, decision);
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新页面后重试。");
      }
      throw error;
    }
    const detail = this.toDetail(updated);
    this.publish(detail);
    return detail;
  }

  async creativeReview(runId: string): Promise<StudioCreativeReviewSnapshot | undefined> {
    const current = await this.loadRequiredRun(runId);
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
    const intervention = node?.status === "needs_human" ? node.intervention : undefined;
    const continuation = intervention?.kind === "creative_review" ? intervention.continuation : undefined;
    if (!node || !continuation) return undefined;
    const output = isRecord(node.output) ? node.output : undefined;
    const draftArtifactId = typeof output?.draftArtifactId === "string" ? output.draftArtifactId : "";
    const artifact = current.artifacts.find((candidate) => candidate.id === draftArtifactId);
    if (!artifact || artifact.kind !== "creative_draft") return undefined;
    const review = isRecord(output?.creativeReview) ? output.creativeReview : undefined;
    const stages = review && isRecord(review.stages) ? review.stages : undefined;
    const rawStageState = stages?.[continuation.stage];
    const stageState: Record<string, unknown> | undefined = isRecord(rawStageState) ? rawStageState : undefined;
    const messages = Array.isArray(stageState?.messages) ? stageState.messages.filter(isRecord).map((message) => ({
      id: String(message.id ?? ""),
      role: message.role === "assistant" ? "assistant" as const : "user" as const,
      text: String(message.text ?? ""),
      commandId: String(message.commandId ?? ""),
    })) : [];
    const proposals = Array.isArray(stageState?.proposals) ? stageState.proposals.filter(isRecord).map((proposal) => ({
      proposalId: String(proposal.proposalId ?? ""),
      baseDraftSha256: String(proposal.baseDraftSha256 ?? ""),
      document: structuredClone(proposal.document),
      changeSummary: Array.isArray(proposal.changeSummary) ? proposal.changeSummary.map(String) : [],
    })) : [];
    const blockingIssues: StudioCreativeReviewSnapshot["blockingIssues"] = Array.isArray(output?.blockingIssues)
      ? output.blockingIssues.filter(isRecord).flatMap((issue) => {
        const target = issue.target;
        if (target !== "script" && target !== "director" && target !== "source" && target !== "user") return [];
        if (typeof issue.reason !== "string" || typeof issue.requiredChange !== "string") return [];
        return [{
          target,
          scenePositions: Array.isArray(issue.scenePositions)
            ? issue.scenePositions.filter((position): position is number => Number.isSafeInteger(position) && position > 0)
            : [],
          reason: issue.reason,
          requiredChange: issue.requiredChange,
        }];
      })
      : [];
    // 自动循环自停的理由：它与本轮审计裁决无关（裁决是确认时才跑的那一轮），所以单独带出来，
    // 不能混进 checkResult，否则界面会把"循环停下"当成一条还没看过的复核意见。
    const rawPlanningStop = isRecord(output?.planningStop) ? output.planningStop : undefined;
    const stopDetail = rawPlanningStop && typeof rawPlanningStop.detail === "string"
      ? rawPlanningStop.detail
      : undefined;
    const rawCheckResult = isRecord(stageState?.checkResult) ? stageState.checkResult : undefined;
    const checkResult: StudioCreativeReviewSnapshot["checkResult"] = rawCheckResult
      && (rawCheckResult.verdict === "pass" || rawCheckResult.verdict === "repair")
      && typeof rawCheckResult.score === "number"
      && typeof rawCheckResult.summary === "string"
      && typeof rawCheckResult.checkIdentity === "string"
      ? {
        verdict: rawCheckResult.verdict,
        score: rawCheckResult.score,
        summary: rawCheckResult.summary,
        checkIdentity: rawCheckResult.checkIdentity,
        issues: Array.isArray(rawCheckResult.issues) ? rawCheckResult.issues.filter(isRecord).flatMap((issue) => (
          (issue.severity === "advisory" || issue.severity === "blocking")
            && typeof issue.criterion === "string"
            && typeof issue.evidence === "string"
            && typeof issue.repairInstruction === "string"
            ? [{
              severity: issue.severity,
              criterion: issue.criterion,
              evidence: issue.evidence,
              repairInstruction: issue.repairInstruction,
            }]
            : []
        )) : [],
      }
      : undefined;
    const stageOrder: StudioPlanningEditableStage[] = ["treatment", "script", "director"];
    const currentStageIndex = stageOrder.indexOf(continuation.stage);
    const returnTargets = stageOrder.slice(0, Math.max(0, currentStageIndex))
      .filter((stage) => isRecord(stages?.[stage]) && isRecord((stages?.[stage] as Record<string, unknown>).currentDraft))
      .map((stage) => ({
        stage,
        label: stage === "treatment" ? "返回前期构思" : "返回脚本",
        impact: stage === "treatment"
          ? "脚本、导演方案和后续确认会失效；历史稿件与已经可用的素材会保留，重新确认后再生成后续方案。"
          : "导演方案和后续确认会失效；前期构思、历史稿件与已经可用的素材会保留。",
      }));
    return {
      runId,
      runRevision: current.revision,
      stage: continuation.stage,
      reviewRevision: continuation.reviewRevision,
      draftSha256: continuation.draftSha256,
      draftArtifactId,
      ...(artifact.id ? { draftContentUrl: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}` } : {}),
      phase: current.creativeReviewOperations?.some((operation) => operation.stage === continuation.stage && operation.status === "running")
        ? "checking"
        : "waiting_user",
      allowedActions: ["discuss", "adopt_proposal", "edit_draft", "undo_draft", "confirm", "return_to_stage"],
      returnTargets,
      draft: structuredClone(stageState?.currentDocument),
      ...(stageState?.previousDocument !== null && stageState?.previousDocument !== undefined
        ? { previousDraft: structuredClone(stageState.previousDocument) }
        : {}),
      messages,
      proposals,
      blockingIssues,
      effectiveUserInstructions: Array.isArray(stageState?.effectiveUserInstructions)
        ? stageState.effectiveUserInstructions.filter(isRecord)
          .filter((instruction) => instruction.active === true)
          .map((instruction) => ({ commandId: String(instruction.commandId ?? ""), message: String(instruction.message ?? "") }))
        : [],
      ...(checkResult ? { checkResult } : {}),
      ...(stopDetail ? { stopDetail } : {}),
    };
  }

  async commandCreativeReview(
    runId: string,
    input: StudioCreativeReviewCommandInput,
    actor: string,
  ): Promise<StudioCreativeReviewCommandReceipt> {
    if (!this.options.pipeline.dispatchCreativeReviewCommand) {
      throw new StudioConflictError("当前制作引擎不支持创作讨论操作。");
    }
    try {
      const dispatched = await this.options.pipeline.dispatchCreativeReviewCommand(
        runId,
        creativeReviewCommandDraft(input, actor),
        (run) => this.publish(this.toDetail(run)),
      );
      void dispatched.completion.then(
        (run) => this.publish(this.toDetail(run)),
        () => undefined,
      );
      return await this.creativeReviewCommand(runId, input.commandId) ?? {
        commandId: input.commandId,
        status: "running",
        observationUrl: `/api/runs/${encodeURIComponent(runId)}/creative-review/commands/${encodeURIComponent(input.commandId)}`,
      };
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /stale|another stage|locked by another writer|already used with different content/i.test(error.message))) {
        throw new StudioConflictError("当前方案已经更新，请查看最新版后重试。");
      }
      throw error;
    }
  }

  async creativeReviewCommand(
    runId: string,
    commandId: string,
  ): Promise<StudioCreativeReviewCommandReceipt | undefined> {
    const current = await this.loadRequiredRun(runId);
    const durableOperation = current.creativeReviewOperations?.find((operation) => operation.commandId === commandId);
    if (durableOperation) {
      return {
        commandId,
        status: durableOperation.status,
        observationUrl: `/api/runs/${encodeURIComponent(runId)}/creative-review/commands/${encodeURIComponent(commandId)}`,
      };
    }
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
    const output = isRecord(node?.output) ? node.output : undefined;
    const completed = isRecord(output?.creativeReviewOperation) ? output.creativeReviewOperation : undefined;
    const running = isRecord(output?.continuationOperation) ? output.continuationOperation : undefined;
    const operation = completed?.commandId === commandId ? completed : running?.commandId === commandId ? running : undefined;
    if (!operation) {
      const review = isRecord(output?.creativeReview) ? output.creativeReview : undefined;
      const stages = review && isRecord(review.stages) ? review.stages : undefined;
      const found = stages && Object.values(stages).some((stage) => (
        isRecord(stage)
        && Array.isArray(stage.messages)
        && stage.messages.some((message) => isRecord(message) && message.commandId === commandId)
      ));
      if (!found) return undefined;
    }
    const status = operation?.status === "running"
      ? "running"
      : node?.status === "failed"
        ? "failed"
        : "completed";
    return {
      commandId,
      status,
      observationUrl: `/api/runs/${encodeURIComponent(runId)}/creative-review/commands/${encodeURIComponent(commandId)}`,
    };
  }

  async requestSceneRevision(
    runId: string,
    input: StudioSceneRevisionInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status !== "needs_human") {
      throw new StudioConflictError("这条制作当前不在人工终审阶段。");
    }
    if (!this.options.pipeline.dispatchSceneRevision) {
      throw new StudioConflictError("当前制作引擎不支持镜头返修。");
    }
    try {
      const dispatched = await this.options.pipeline.dispatchSceneRevision(
        runId,
        { ...input, actor },
        (run) => this.publish(this.toDetail(run)),
      );
      return await this.dispatchedDetail(dispatched);
    } catch (error) {
      if (
        error instanceof StaleRunRevisionError
        || error instanceof NodeVersionConflictError
        || (error instanceof Error && /locked by another writer/.test(error.message))
      ) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新页面后重试。");
      }
      throw error;
    }
  }

  async requestNarrationRevision(
    runId: string,
    input: StudioNarrationRevisionInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status !== "needs_human") {
      throw new StudioConflictError("这条制作当前不在人工终审阶段。");
    }
    if (!this.options.pipeline.dispatchNarrationRevision) {
      throw new StudioConflictError("当前制作引擎不支持改单镜旁白字幕。");
    }
    try {
      const dispatched = await this.options.pipeline.dispatchNarrationRevision(
        runId,
        { ...input, actor },
        (run) => this.publish(this.toDetail(run)),
      );
      return await this.dispatchedDetail(dispatched);
    } catch (error) {
      if (
        error instanceof StaleRunRevisionError
        || error instanceof NodeVersionConflictError
        || (error instanceof Error && /locked by another writer/.test(error.message))
      ) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新页面后重试。");
      }
      throw error;
    }
  }

  async requestSceneResourceRevision(
    runId: string,
    input: StudioSceneResourceRevisionInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status !== "needs_human") {
      throw new StudioConflictError("这条制作当前不在人工终审阶段。");
    }
    if (!this.options.pipeline.dispatchSceneResourceRevision) {
      throw new StudioConflictError("当前制作引擎不支持重取单镜素材。");
    }
    try {
      const dispatched = await this.options.pipeline.dispatchSceneResourceRevision(
        runId,
        { ...input, actor },
        (run) => this.publish(this.toDetail(run)),
      );
      return await this.dispatchedDetail(dispatched);
    } catch (error) {
      if (
        error instanceof StaleRunRevisionError
        || error instanceof NodeVersionConflictError
        || (error instanceof Error && /locked by another writer/.test(error.message))
      ) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新页面后重试。");
      }
      // 这一镜的候选里已经没有第二个合格素材：这条路径宁可不换，也不塞一个会被素材节点
      // 挡掉的候选。换不动时要说清楚还能做什么，而不是把引擎的英文报错丢给创作者。
      if (error instanceof Error && /no second qualified candidate/.test(error.message)) {
        throw new StudioConflictError(
          "这一镜已经没有第二个合格素材可以换了。这条路径只在已通过语义筛选的候选之间换，不会为了过关塞一个次品；"
          + "请改用「用已有镜头替换」借一个更早镜头的画面，或回到方案里调整这一镜的拍摄要求。",
        );
      }
      if (error instanceof Error && /asks for the scene asset itself to be reworked/.test(error.message)) {
        throw new StudioConflictError("这条审片结论要改的不是画面素材，请用结论旁边对应的返工入口。");
      }
      throw error;
    }
  }

  async reinspectVisualReview(
    runId: string,
    input: ProductionVisualReinspectionDraft,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.revision !== input.expectedRunRevision) {
      throw new StudioConflictError("你查看的审片意见已经更新，请刷新后再补查。");
    }
    if (!this.options.pipeline.dispatchVisualReinspection) {
      throw new StudioConflictError("当前制作引擎不支持补查已有成片。");
    }
    try {
      const dispatched = await this.options.pipeline.dispatchVisualReinspection(
        runId,
        input,
        (run) => this.publish(this.toDetail(run)),
      );
      return await this.dispatchedDetail(dispatched);
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("你查看的审片意见已经更新，请刷新后再补查。");
      }
      throw error;
    }
  }

  async requestPause(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (!["running", "awaiting_spend_approval", "approval_invalidated"].includes(current.status)) {
      throw new StudioConflictError("这条制作当前不能暂停新的图片或视频任务。");
    }
    await this.options.pipeline.requestPause(runId);
    const detail = { ...this.toDetail(current), pauseRequested: true };
    this.publish(detail);
    return detail;
  }

  async resumePaused(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    const pauseRequested = await this.options.pipeline.pauseRequested(runId);
    if (current.status !== "paused" && !pauseRequested) throw new StudioConflictError("这条制作当前没有暂停。");
    if (current.status !== "paused") {
      await this.options.pipeline.clearPauseRequest?.(runId);
      const detail = this.toDetail(current);
      this.publish(detail);
      return detail;
    }
    assertExecutableRunContinuation(current);
    if (this.options.pipeline.dispatchResumePaused) {
      const dispatched = await this.options.pipeline.dispatchResumePaused(
        runId,
        (run) => this.publish(this.toDetail(run)),
      );
      return await this.dispatchedDetail(dispatched);
    }
    const updated = await this.options.pipeline.resumePaused(runId);
    const detail = this.toDetail(updated);
    this.publish(detail);
    return detail;
  }

  async applyNodeOverride(
    runId: string,
    nodeId: string,
    input: StudioNodeOverrideInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status === "running") {
      throw new StudioConflictError("制作仍在执行，暂时不能修改节点。请等待它停在确认点后再编辑。");
    }
    if (isTerminalRun(current.status) && input.confirmTerminalEdit !== true) {
      throw new StudioConflictError("这条制作已经结束。请明确确认创建人工修订版后再保存。");
    }
    if (current.nodeRuns.some((candidate) => candidate.outcomeUncertain)) {
      throw new StudioConflictError("这条制作还有付费结果尚未核对，暂时不能修改内容。请先完成任务与账单核对。");
    }
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new StudioInputError(`没有找到制作步骤“${nodeId}”。`);
    const editsOutput = input.output !== undefined;
    const editsDocument = input.document !== undefined;
    if (editsOutput === editsDocument) throw new StudioInputError("请选择一种节点交付进行修改。");
    const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
    const reference = effectiveVersion?.output ?? node.output;
    let overrideOutput = input.output === undefined
      ? undefined
      : restoreManagedFileReferences(input.output, reference);
    let overrideArtifacts: ArtifactDraft[] | undefined;
    let humanDocumentPaths: string[] = [];
    if (input.document) {
      const prepared = await this.prepareDocumentOverride({
        runId,
        nodeId,
        actor,
        reference,
        nodeArtifactIds: node.artifactIds,
        runArtifacts: current.artifacts,
        document: input.document,
        authorizedRunFiles: input.authorizedRunFiles ?? [],
      });
      if (prepared.unchanged) return this.toDetail(current);
      overrideOutput = prepared.output;
      overrideArtifacts = prepared.artifacts;
      humanDocumentPaths = prepared.cleanupPaths;
    }
    validateNodeOverrideOutput({
      output: overrideOutput,
      reference,
      nodeId,
      runRoot: path.join(this.options.workspaceRoot, "runs", runId),
      allowPathChanges: editsDocument,
    });
    if (!editsDocument && node.outputState?.stale !== true && isDeepStrictEqual(overrideOutput, reference)) {
      return this.toDetail(current);
    }
    let persisted = false;
    try {
      const updated = await this.options.pipeline.applyNodeOverride(runId, {
        nodeId,
        actor,
        output: overrideOutput,
        ...(overrideArtifacts ? { artifacts: overrideArtifacts } : {}),
        ...(effectiveVersion ? { expectedVersionId: effectiveVersion.id } : {}),
        allowTerminalEdit: isTerminalRun(current.status) && input.confirmTerminalEdit === true,
        schemaVersion: effectiveVersion?.schemaVersion ?? "1",
      });
      persisted = true;
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (!persisted) {
        await Promise.all(humanDocumentPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      }
      if (error instanceof StaleRunRevisionError || error instanceof NodeVersionConflictError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async applyNodeInputOverride(
    runId: string,
    nodeId: string,
    input: StudioNodeInputOverrideInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    assertPlanningStageScope(nodeId, input.planningStageId, "输入");
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status === "running") {
      throw new StudioConflictError("制作仍在执行，暂时不能修改节点输入。请等待它停在确认点后再编辑。");
    }
    if (isTerminalRun(current.status) && input.confirmTerminalEdit !== true) {
      throw new StudioConflictError("这条制作已经结束。请明确确认创建人工修订版后再保存输入。");
    }
    if (current.nodeRuns.some((candidate) => candidate.outcomeUncertain)) {
      throw new StudioConflictError("这条制作还有付费结果尚未核对，暂时不能修改输入。请先完成任务与账单核对。");
    }
    if (!current.nodeRuns.some((candidate) => candidate.nodeId === nodeId)) {
      throw new StudioInputError(`没有找到制作步骤“${nodeId}”。`);
    }
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === nodeId)!;
    const effectiveInputVersion = node.inputState?.versions.find(
      (version) => version.id === node.inputState?.effectiveVersionId,
    );
    if (input.expectedRunRevision !== current.revision
      || input.expectedVersionId !== effectiveInputVersion?.id) {
      throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
    }
    const restoredInput = restoreManagedFileReferences(input.input, effectiveInputVersion?.value);
    if (node.inputState?.stale !== true && isDeepStrictEqual(restoredInput, effectiveInputVersion?.value)) {
      return this.toDetail(current);
    }
    try {
      const updated = await this.options.pipeline.applyNodeInputOverride(runId, {
        nodeId,
        actor,
        input: restoredInput,
        expectedVersionId: input.expectedVersionId,
        // caller tokens 原样进入持锁修改点：pipeline 在 lease 内复核，预检查后的并发
        // 写入在这里失败，而不是被节点版本未变的假象放过。
        expectedRunRevision: input.expectedRunRevision,
        allowTerminalEdit: isTerminalRun(current.status) && input.confirmTerminalEdit === true,
      });
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || error instanceof NodeVersionConflictError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async applyNodeExecutionConfiguration(
    runId: string,
    nodeId: string,
    input: StudioNodeExecutionConfigurationInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    assertPlanningStageScope(nodeId, input.planningStageId, "执行配置");
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    if (current.status === "running") {
      throw new StudioConflictError("制作仍在执行，请先暂停，再修改这个节点的模型或预算。");
    }
    if (isTerminalRun(current.status) && input.confirmTerminalEdit !== true) {
      throw new StudioConflictError("这条制作已经结束。请明确确认重新生成后再修改执行配置。");
    }
    if (current.nodeRuns.some((candidate) => candidate.outcomeUncertain)) {
      throw new StudioConflictError("这条制作还有付费结果尚未核对，暂时不能修改模型或画面来源。请先完成任务与账单核对。");
    }
    if (input.expectedRunRevision !== current.revision) {
      throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
    }
    const currentBrief = effectiveProductionBrief(current);
    assertPlanningStageModelScope(nodeId, input, currentBrief);
    const updatedBrief = applyNodeExecutionConfiguration(currentBrief, nodeId, input);
    const providers = await this.assertProvidersAvailable(updatedBrief);
    const jointPlanning = currentBrief.workflowFeatures?.creativePlanning === "joint-v1";
    const replanNodeId = jointPlanning ? "creative-planning" : "visual-direction";
    const invalidationNodeId = nodeId === "assets"
      && (
        input.assetProviderIds !== undefined
          && !sameProviderIdSet(currentBrief.director?.assetProviderIds, updatedBrief.director?.assetProviderIds)
        || videoModelContractChanged(currentBrief, updatedBrief, providers)
      )
      ? replanNodeId
      : nodeId;
    try {
      // caller revision（不是重新加载的服务端 revision）贯穿到 pipeline 持锁修改点。
      const updated = await this.options.pipeline.applyNodeExecutionConfiguration(runId, invalidationNodeId, updatedBrief, actor, input.expectedRunRevision);
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  private async prepareDocumentOverride(options: {
    runId: string;
    nodeId: string;
    actor: string;
    reference: unknown;
    nodeArtifactIds: string[];
    runArtifacts: WorkflowRun<ProductionBrief>["artifacts"];
    document: NonNullable<StudioNodeOverrideInput["document"]>;
    authorizedRunFiles: string[];
  }): Promise<
    | { unchanged: true }
    | { unchanged: false; output: Record<string, unknown>; artifacts: ArtifactDraft[]; cleanupPaths: string[] }
  > {
    const contract = EDITABLE_DOCUMENTS[options.nodeId];
    if (!contract) throw new StudioInputError(`制作步骤“${options.nodeId}”没有可编辑的详细内容。`);
    if (!isRecord(options.reference)) throw new StudioInputError(`制作步骤“${options.nodeId}”尚无可编辑的详细内容。`);
    const artifact = options.runArtifacts.find((candidate) => candidate.id === options.document.artifactId);
    if (!artifact || !options.nodeArtifactIds.includes(artifact.id) || artifact.producer?.nodeId !== options.nodeId) {
      throw new StudioInputError("请选择这个节点当前可编辑产物。");
    }
    if (artifact.kind !== contract.kind || artifact.contentType !== "application/json" || !artifact.uri) {
      throw new StudioInputError("所选产物不是这个节点可编辑的 JSON 交付。");
    }
    const referencedPath = options.reference[contract.pathField];
    if (typeof referencedPath !== "string" || path.resolve(referencedPath) !== path.resolve(artifact.uri)) {
      throw new StudioInputError("所选产物已经不是当前有效版本，请刷新后重试。");
    }
    const runRoot = path.join(this.options.workspaceRoot, "runs", options.runId);
    await assertContainedFile(runRoot, artifact.uri);
    let referenceDocument: unknown;
    try {
      referenceDocument = JSON.parse(await readFile(artifact.uri, "utf8"));
    } catch {
      throw new StudioInputError("当前结构化产物无法读取，请先重新生成该节点。");
    }
    const requestedDocument = options.nodeId === "publish-package"
      ? editablePublishPackageDocument(referenceDocument, options.document.content)
      : options.document.content;
    validateNodeOverrideOutput({
      output: requestedDocument,
      reference: referenceDocument,
      nodeId: `${options.nodeId} 结构化交付`,
      runRoot,
      allowPathChanges: options.authorizedRunFiles.length > 0,
    });
    if (options.authorizedRunFiles.length === 0 && isDeepStrictEqual(requestedDocument, referenceDocument)) {
      return { unchanged: true };
    }
    const mediaRevision = await prepareAuthorizedRunFileArtifacts({
      nodeId: options.nodeId,
      actor: options.actor,
      runRoot,
      referenceDocument,
      nextDocument: requestedDocument,
      authorizedRunFiles: options.authorizedRunFiles,
      runArtifacts: options.runArtifacts,
      parentArtifactId: artifact.id,
      attempt: artifact.producer?.attempt ?? 1,
    });

    const revisionId = randomUUID();
    const content = `${JSON.stringify(mediaRevision.document, null, 2)}\n`;
    const destination = path.join(runRoot, "nodes", options.nodeId, "human-revisions", `${revisionId}.json`);
    const output = structuredClone(options.reference);
    output[contract.pathField] = destination;
    const privateRevision = options.nodeId === "asset-candidates"
      ? await prepareCandidateInventoryRevision(runRoot, options.reference, mediaRevision.document, revisionId)
      : undefined;
    if (privateRevision) output.candidateInventoryPath = privateRevision.destination;
    if (contract.embeddedField) output[contract.embeddedField] = structuredClone(mediaRevision.document);
    if (options.nodeId === "script" && isRecord(mediaRevision.document)
      && ("canonFacts" in options.reference || "canonFacts" in mediaRevision.document)) {
      output.canonFacts = boundedStringArray(mediaRevision.document.canonFacts, 8);
    }
    if (options.nodeId === "technical-review" && isRecord(mediaRevision.document)) {
      output.passed = mediaRevision.document.status === "passed";
    }
    const cleanupPaths = [destination, ...(privateRevision ? [privateRevision.destination] : [])];
    try {
      await writePrivateTextAtomically(destination, content);
      if (privateRevision) await writePrivateTextAtomically(privateRevision.destination, privateRevision.content);
    } catch (error) {
      await Promise.all(cleanupPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      throw error;
    }
    return {
      unchanged: false,
      output,
      cleanupPaths,
      artifacts: [{
        kind: artifact.kind,
        uri: destination,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        contentType: "application/json",
        ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
        parentArtifactIds: [artifact.id],
        producer: { nodeId: options.nodeId, attempt: artifact.producer?.attempt ?? 1 },
        provenance: {
          providerId: "human-editor",
          providerVersion: "1",
          creator: options.actor,
          licenseNote: "Human-edited derivative retained as an immutable revision.",
        },
      }, ...mediaRevision.artifacts, ...(privateRevision ? [{
        kind: "candidate_inventory_private",
        uri: privateRevision.destination,
        sha256: createHash("sha256").update(privateRevision.content).digest("hex"),
        sizeBytes: Buffer.byteLength(privateRevision.content),
        contentType: "application/json",
        schemaVersion: "video-factory/asset-candidate-inventory-v1",
        parentArtifactIds: [artifact.id],
        producer: { nodeId: options.nodeId, attempt: artifact.producer?.attempt ?? 1 },
        provenance: {
          providerId: "human-editor-private-state",
          providerVersion: "1",
          creator: options.actor,
          licenseNote: "Private runtime inventory synchronized to the reviewed public candidate revision.",
        },
      } satisfies ArtifactDraft] : [])],
    };
  }

  async authorizeSpend(
    runId: string,
    nodeId: string,
    input: Omit<SpendAuthorizationDraft, "nodeId" | "approvedBy">,
    approvedBy: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    const plan = current.nodeRuns.find((node) => node.nodeId === nodeId)?.spendPlan;
    if (!plan) throw new StudioConflictError("这个节点当前没有待确认的费用计划，请刷新页面后重试。");
    if (
      input.spendPlanId !== plan.id
      || input.providerId !== plan.providerId
      || input.modelId !== plan.modelId
      || input.maxCostCny !== plan.maxCostCny
      || input.maxAttempts !== plan.maxAttempts
      || input.inputVersionIds.length !== plan.inputVersionIds.length
      || input.inputVersionIds.some((versionId, index) => versionId !== plan.inputVersionIds[index])
    ) {
      throw new StudioConflictError("费用计划或上游版本已经变化，请重新检查后确认。");
    }
    try {
      const authorization: SpendAuthorizationDraft = {
        spendPlanId: plan.id,
        nodeId,
        inputVersionIds: [...plan.inputVersionIds],
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: plan.maxCostCny,
        maxAttempts: plan.maxAttempts,
        approvedBy,
      };
      if (this.options.pipeline.dispatchSpendAuthorization) {
        const dispatched = await this.options.pipeline.dispatchSpendAuthorization(
          runId,
          authorization,
          (run) => this.publish(this.toDetail(run)),
        );
        return await this.dispatchedDetail(dispatched);
      }
      const updated = await this.options.pipeline.authorizeSpend(runId, {
        ...authorization,
      });
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("费用授权已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async rejectSpend(
    runId: string,
    nodeId: string,
    input: StudioSpendRejectionInput,
    rejectedBy: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    assertExecutableRunContinuation(current);
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    const plan = node?.spendPlan;
    if (!plan || plan.id !== input.spendPlanId
      || (node.status !== "awaiting_spend_approval" && node.status !== "approval_invalidated")) {
      throw new StudioConflictError("费用报价或上游版本已经变化，请重新检查后再反馈。");
    }
    if (
      input.reason === "too_expensive"
      && input.targetEstimatedCostCny !== undefined
      && input.targetEstimatedCostCny >= plan.estimatedCostCny
    ) {
      throw new StudioInputError("降本目标必须低于当前报价。");
    }
    const rejection: ProductionSpendRejectionDraft = {
      nodeId,
      spendPlanId: plan.id,
      reason: input.reason,
      ...(input.targetEstimatedCostCny !== undefined ? { targetEstimatedCostCny: input.targetEstimatedCostCny } : {}),
      ...(input.note ? { note: input.note } : {}),
      rejectedBy,
    };
    try {
      if (this.options.pipeline.dispatchSpendRejection) {
        const dispatched = await this.options.pipeline.dispatchSpendRejection(
          runId,
          rejection,
          (run) => this.publish(this.toDetail(run)),
        );
        return await this.dispatchedDetail(dispatched);
      }
      const updated = await this.options.pipeline.rejectSpend(runId, rejection);
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("费用报价已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async resumeStale(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status !== "stale") throw new StudioConflictError("这条制作当前没有需要重新生成的旧结果。");
    assertExecutableRunContinuation(current);
    try {
      if (this.options.pipeline.dispatchResumeStale) {
        const dispatched = await this.options.pipeline.dispatchResumeStale(
          runId,
          (run) => this.publish(this.toDetail(run)),
        );
        return await this.dispatchedDetail(dispatched);
      }
      const updated = await this.options.pipeline.resumeStale(runId);
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async retryFailedNode(runId: string, nodeId: string): Promise<StudioRunDetail> {
    return this.retryFailedNodeInternal(runId, nodeId, false);
  }

  async queryOriginalTextTask(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    const detail = this.toDetail(current);
    const pending = await loadPendingTextTask(this.options.workspaceRoot, runId, detail.nodes, current.nodeRuns);
    if (!pending) return detail;
    const receiptPath = textTaskRecoveryReceiptPath(this.options.workspaceRoot, runId, pending.nodeId);
    const previousReceipt = await readTextTaskRecoveryReceipt(receiptPath);
    const currentReceipt = previousReceipt
      && textTaskRecoveryReceiptMatches(previousReceipt, current.revision, pending)
      ? previousReceipt
      : undefined;
    const client = new CodexBridgeClient({
      socketPath: pending.operation.route.socketPath,
      timeoutMs: 3_000,
      maxAttempts: 1,
    });
    const attemptedAt = (this.options.now?.() ?? new Date()).toISOString();
    const observation = await client.observePreparedOnce(pending.operation, { timeoutMs: 3_000 });
    const receipt = observation.state === "query_failure"
      ? textTaskRecoveryReceipt(
        current.revision,
        pending,
        currentReceipt?.taskState ?? "accepted_unknown",
        {
          attemptedAt,
          ...(currentReceipt?.lastVerifiedAt ? { lastVerifiedAt: currentReceipt.lastVerifiedAt } : {}),
          observationError: currentReceipt?.lastVerifiedAt
            ? "本次查询没有取得新状态；原任务的上一次可信状态已保留，请稍后再查。"
            : "本次查询没有取得状态；系统不会把原任务描述为仍在实时运行，也没有重新提交。",
          ...(currentReceipt?.terminalError ? { terminalError: currentReceipt.terminalError } : {}),
          ...(currentReceipt?.failureKind ? { failureKind: currentReceipt.failureKind } : {}),
        },
      )
      : textTaskRecoveryReceipt(
        current.revision,
        pending,
        observation.state,
        {
          attemptedAt,
          lastVerifiedAt: attemptedAt,
          ...(observation.state === "completed_failure"
            ? {
              terminalError: observation.error.creatorMessage,
              ...(observation.error.failureKind ? { failureKind: observation.error.failureKind } : {}),
            }
            : {}),
        },
      );
    const latest = await this.loadRequiredRun(runId);
    const latestPending = await loadPendingTextTask(
      this.options.workspaceRoot,
      runId,
      this.toDetail(latest).nodes,
      latest.nodeRuns,
    );
    if (!latestPending && isDeepStrictEqual(effectiveProductionBrief(latest), effectiveProductionBrief(current))) {
      return this.toDetail(latest);
    }
    if (latest.revision !== current.revision || latestPending?.identityDigest !== pending.identityDigest) {
      throw new StudioConflictError("制作方案已更新，旧模型任务的结果不会附到新版本；请刷新后查看。");
    }
    await withTextTaskRecoveryReceiptLock(receiptPath, async () => {
      // 网络观察已经结束；锁内只做最新 run/task 身份复核和很短的 read/merge/commit。
      const committing = await this.loadRequiredRun(runId);
      const committingPending = await loadPendingTextTask(
        this.options.workspaceRoot,
        runId,
        this.toDetail(committing).nodes,
        committing.nodeRuns,
      );
      if (!committingPending
        && isDeepStrictEqual(effectiveProductionBrief(committing), effectiveProductionBrief(current))) {
        return;
      }
      if (committing.revision !== current.revision || committingPending?.identityDigest !== pending.identityDigest) {
        throw new StudioConflictError("制作方案已更新，旧模型任务的结果不会附到新版本；请刷新后查看。");
      }
      const persistedReceipt = await readTextTaskRecoveryReceipt(receiptPath);
      const mergedReceipt = mergeTextTaskRecoveryReceipt(
        persistedReceipt && textTaskRecoveryReceiptMatches(persistedReceipt, current.revision, pending)
          ? persistedReceipt
          : undefined,
        receipt,
      );
      await writePrivateTextAtomically(receiptPath, `${JSON.stringify(mergedReceipt, null, 2)}\n`);
    });
    return (await this.get(runId))!;
  }

  async retrieveOriginalTextTask(runId: string): Promise<StudioRunDetail> {
    const active = this.textTaskRetrievals.get(runId);
    if (active) return active;
    const operation = this.retrieveOriginalTextTaskOnce(runId).finally(() => {
      if (this.textTaskRetrievals.get(runId) === operation) this.textTaskRetrievals.delete(runId);
    });
    this.textTaskRetrievals.set(runId, operation);
    return operation;
  }

  private async retrieveOriginalTextTaskOnce(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status === "paused") {
      throw new StudioConflictError("原任务结果已保留；请先显式继续自动制作，暂停状态不会被查询结果解除。");
    }
    if (current.status === "running") {
      throw new StudioConflictError("原任务结果将由当前制作进程接续；现在只允许查询，不能并发推进同一步骤。");
    }
    const detail = this.toDetail(current);
    const pending = await loadPendingTextTask(this.options.workspaceRoot, runId, detail.nodes, current.nodeRuns);
    if (!pending) throw new StudioConflictError("这条制作没有可取回的原模型任务，请刷新后查看最新状态。");
    const receipt = await readTextTaskRecoveryReceipt(
      textTaskRecoveryReceiptPath(this.options.workspaceRoot, runId, pending.nodeId),
    );
    if (!receipt
      || !textTaskRecoveryReceiptMatches(receipt, current.revision, pending)
      || receipt.taskState !== "completed_success") {
      throw new StudioConflictError("原任务结果尚未核验完成，请先查询原任务。");
    }
    return this.retryFailedNodeInternal(runId, pending.nodeId, true);
  }

  private async retryFailedNodeInternal(runId: string, nodeId: string, recoveredTextTask: boolean): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    const pendingTextTask = await loadPendingTextTask(
      this.options.workspaceRoot,
      runId,
      this.toDetail(current).nodes,
      current.nodeRuns,
      nodeId,
    );
    let resumeCompletedTextTask = false;
    if (pendingTextTask && !recoveredTextTask) {
      const receipt = await readTextTaskRecoveryReceipt(
        textTaskRecoveryReceiptPath(this.options.workspaceRoot, runId, pendingTextTask.nodeId),
      );
      const currentReceipt = receipt && textTaskRecoveryReceiptMatches(receipt, current.revision, pendingTextTask)
        ? receipt
        : undefined;
      resumeCompletedTextTask = currentReceipt?.taskState === "completed_failure"
        && retryableCompletedTextFailure(currentReceipt);
      if (!currentReceipt
        || (currentReceipt.taskState !== "not_accepted" && !resumeCompletedTextTask)) {
        throw new StudioConflictError("原模型任务可能已经受理，不能普通重试；请先查询原任务。");
      }
    }
    const retryingFailure = current.status === "failed"
      && current.nodeRuns.find((node) => node.nodeId === nodeId)?.status === "failed";
    const retryingIncompleteSourceReview = current.status === "needs_human"
      && current.nodeRuns.find((node) => node.nodeId === nodeId)?.intervention?.kind === "source_review_retry";
    if (!retryingFailure && !retryingIncompleteSourceReview && !canRetryRejectedReviewNode(current, nodeId)) {
      throw new StudioConflictError("这个节点当前不能重试，请刷新页面检查最新状态。");
    }
    assertExecutableRunContinuation(current);
    try {
      if (this.options.pipeline.dispatchRetryFailedNode) {
        const dispatched = await this.options.pipeline.dispatchRetryFailedNode(
          runId,
          nodeId,
          (run) => this.publish(this.toDetail(run)),
          recoveredTextTask || resumeCompletedTextTask
            ? {
              recoverOriginalTextTask: true,
              ...(resumeCompletedTextTask
                ? {
                  resumeCompletedTextTask: true,
                  resumeCompletedTextTaskRequestId: pendingTextTask!.operation.requestId,
                }
                : {}),
            }
            : undefined,
        );
        return await this.dispatchedDetail(dispatched);
      }
      const updated = await this.options.pipeline.retryFailedNode(
        runId,
        nodeId,
        recoveredTextTask || resumeCompletedTextTask
          ? {
            recoverOriginalTextTask: true,
            ...(resumeCompletedTextTask
              ? {
                resumeCompletedTextTask: true,
                resumeCompletedTextTaskRequestId: pendingTextTask!.operation.requestId,
              }
              : {}),
          }
          : undefined,
      );
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async inspectPaidNode(runId: string, nodeId: string): Promise<StudioPaidNodeSummary> {
    await this.loadRequiredRun(runId);
    return this.options.pipeline.inspectPaidNode(runId, nodeId);
  }

  async reconcilePaidNode(
    runId: string,
    nodeId: string,
    input: StudioPaidReconciliationInput,
    actor = "studio-owner",
  ): Promise<StudioRunDetail> {
    try {
      const current = await this.loadRequiredRun(runId);
      const continuationSupported = supportsRunContinuation(current);
      const manualResolution = input.outcome === "confirmed_not_charged" || input.outcome === "confirmed_charged";
      if (!continuationSupported && !manualResolution) {
        throw new StudioConflictError("这条历史制作只能核对并结算已有账单；若要继续制作，请从当前记录创建新版本。");
      }
      const updated = await this.options.pipeline.reconcilePaidNode(runId, {
        nodeId,
        expectedRunRevision: input.expectedRunRevision,
        reconciliationId: input.reconciliationId,
        outcome: input.outcome,
        ...(input.itemRequestId ? { itemRequestId: input.itemRequestId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(manualResolution ? { actor } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.actualCostCny !== undefined ? { actualCostCny: input.actualCostCny } : {}),
      }, continuationSupported ? undefined : { settleOnly: true });
      const detail = this.toDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof PaidOperationManualReconciliationError) {
        throw new StudioConflictError("这笔付费任务无法自动查询，请在服务商控制台人工核对任务和账单。");
      }
      if (error instanceof StaleRunRevisionError || error instanceof RunLockedError) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<(run: StudioRunDetail) => void>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined> {
    let run: WorkflowRun<ProductionBrief>;
    try {
      run = await this.options.pipeline.loadPersisted(runId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioNotFoundError("没有找到这条制作记录。");
      throw error;
    }
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact?.uri || isPrivateArtifactKind(artifact.kind)) return undefined;
    const [runRoot, artifactPath] = await Promise.all([
      realpath(path.join(this.options.workspaceRoot, "runs", runId)),
      realpath(artifact.uri),
    ]);
    const relative = path.relative(runRoot, artifactPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Artifact '${artifactId}' is outside run directory '${runId}'.`);
    }
    const artifactStat = await stat(artifactPath);
    if (!artifactStat.isFile()) return undefined;
    return { path: artifactPath, contentType: artifact.contentType ?? "application/octet-stream", sizeBytes: artifactStat.size };
  }

  private async loadRequiredRun(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    try {
      return await this.options.pipeline.show(runId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioNotFoundError("没有找到这条制作记录。");
      throw error;
    }
  }

  private async assertProvidersAvailable(brief: ProductionBrief): Promise<StudioProvider[]> {
    const providers = await this.options.listProviders();
    if (brief.runPurpose !== "test") {
      const selectedReviewProvider = brief.providers.visualReview;
      const deepseekReviewReady = providers.some((provider) => provider.id === "deepseek-visual-review-v1"
        && provider.capability === "quality.review.visual"
        && provider.available
        && provider.kind !== "test");
      const roleAuditReady = providers.some((provider) => provider.capability === "role.audit"
        && provider.available
        && provider.kind !== "test");
      // ChatGPT/Codex 套餐退役（N5）：审片只要求 DeepSeek 单腿可用 + 独立审计就绪。
      // codex-visual-review-v1 已退役，不再作为正式生产的必要条件。
      if (selectedReviewProvider !== "deepseek-visual-review-v1"
        || !deepseekReviewReady
        || !roleAuditReady) {
        throw new StudioInputError("正式制作需要视觉审片模型可用，且独立质量复核已配置。");
      }
    }
    const selectedVisualSources = new Set([
      ...(brief.director?.assetProviderIds ?? []),
      ...(brief.providers.assets === "ai-shot-router-v1" ? [] : [brief.providers.assets]),
    ]);
    const usesMeteredVisualSource = providers.some((provider) => (
      selectedVisualSources.has(provider.id)
      && provider.capability === "asset.prepare"
      && provider.billing === "metered"
    ));
    if (usesMeteredVisualSource && !brief.providers.visualReview) {
      throw new StudioInputError("付费图片和视频必须启用视觉审片，不能跳过生成素材的文字与画面一致性检查。");
    }
    const selectedProviderIds = new Set([
      brief.providers.script,
      ...(brief.providers.director ? [brief.providers.director] : []),
      brief.providers.assets,
      brief.providers.voice,
      brief.providers.render,
      brief.providers.technicalReview,
      ...(brief.providers.visualReview ? [brief.providers.visualReview] : []),
      ...(brief.director?.assetProviderIds ?? []),
      ...(brief.workflowFeatures?.referenceGrammar ? ["codex-reference-grammar-v1"] : []),
      // joint-v1 规划包含前期构思阶段：构思能力键在模型选择校验范围内。
      ...(brief.workflowFeatures?.creativePlanning === "joint-v1" ? [CREATIVE_TREATMENT_PROVIDER_ID] : []),
      // 带边界闸门的制作会在简报后先跑一轮独立复核：复核能力键同样在模型选择校验范围内。
      // 没有这道闸门就没有那一轮调用，因此不给一个用不上的键开口子。
      ...(brief.workflowFeatures?.boundaryGates === "user-confirmed-v1" ? [BRIEF_AUDIT_PROVIDER_ID] : []),
      "codex-publish-copy-v1",
      ...(brief.director ? ["codex-asset-ranker-v1"] : []),
      ...(brief.providers.visualReview ? ["sound-review-v1"] : []),
    ]);
    if (brief.workflowFeatures?.referenceGrammar) {
      const referenceProvider = providers.find((provider) => provider.id === "codex-reference-grammar-v1");
      if (!referenceProvider?.available || referenceProvider.capability !== "reference.grammar") {
        throw new StudioInputError("参考视频分析当前不可用，请到创作设置检查 AI 分析服务后重试。");
      }
    }
    for (const [providerId, modelId] of Object.entries(brief.models ?? {})) {
      if (!selectedProviderIds.has(providerId)) {
        throw new StudioInputError(`模型“${modelId}”绑定到了本次未启用的能力“${providerId}”。`);
      }
      const provider = providers.find((candidate) => candidate.id === providerId);
      const model = provider?.modelProfiles?.find((candidate) => candidate.id === modelId);
      if (!provider || !model) throw new StudioInputError(`“${provider?.label ?? providerId}”不支持模型“${modelId}”。`);
      if (!model.available) throw new StudioInputError(`模型“${model.label}”当前不可用。`);
      if (!modelSupportsCapability(model, provider.capability)) {
        throw new StudioInputError(`模型“${model.label}”不适合“${provider.label}”当前所在节点。`);
      }
    }
    const bindings: Array<[string, string]> = [
      ["script.draft", brief.providers.script],
      ...(brief.director && brief.providers.director ? [["storyboard.plan", brief.providers.director] as [string, string]] : []),
      ["asset.prepare", brief.providers.assets],
      ["voice.synthesize", brief.providers.voice],
      ["video.render", brief.providers.render],
      ["quality.review", brief.providers.technicalReview],
      ...(brief.providers.visualReview ? [["quality.review.visual", brief.providers.visualReview] as [string, string]] : []),
    ];
    for (const [capability, id] of bindings) {
      const selected = providers.find((candidate) => candidate.capability === capability && candidate.id === id);
      if (!selected) throw new StudioInputError(`没有找到制作能力“${id}”。`);
      if (selected.kind === "test") {
        throw new StudioInputError(`“${selected.label}”是测试能力，不能用于正式制作。`);
      }
      if (!selected.available) {
        throw new StudioInputError(`“${selected.label}”当前不可用：${selected.requirement ?? "缺少运行条件"}。`);
      }
      if (selected.billing !== "metered") continue;
      if (!brief.economics.allowMeteredProviders) {
        throw new StudioInputError(`当前配方未允许使用付费能力“${selected.label}”。`);
      }
      const selectedEstimate = modelEstimate(selected, brief.models?.[selected.id]);
      if (selectedEstimate === undefined) {
        throw new StudioInputError(`“${selected.label}”尚未配置估价，不能生成执行前报价。`);
      }
    }
    if (brief.director) {
      for (const id of brief.director.assetProviderIds) {
        const selected = providers.find((provider) => provider.capability === "asset.prepare" && provider.id === id);
        if (!selected) throw new StudioInputError(`导演素材池中没有找到“${id}”。`);
        if (!selected.available) throw new StudioInputError(`导演素材池中的“${selected.label}”当前不可用。`);
        if (selected.kind === "test" || selected.id === "ai-shot-router-v1") {
          throw new StudioInputError(`“${selected.label}”不能作为导演的镜头素材来源。`);
        }
        if (selected.billing === "metered") {
          if (!brief.economics.allowMeteredProviders) {
            throw new StudioInputError(`当前画面来源策略未允许使用“${selected.label}”。`);
          }
          const selectedEstimate = modelEstimate(selected, brief.models?.[selected.id]);
          if (!selectedEstimate) {
            throw new StudioInputError(`“${selected.label}”尚未配置单镜估价，不能生成执行前报价。`);
          }
        }
      }
    }
    if (brief.runPurpose !== "test") {
      const selectedSources = providers.filter((provider) => (
        selectedVisualSources.has(provider.id)
        && provider.capability === "asset.prepare"
        && provider.available
      ));
      const sourceIssue = visualSourceCompatibilityIssue(
        undefined,
        selectedSources,
      );
      if (sourceIssue) throw new StudioInputError(sourceIssue.message);
    }
    return providers;
  }

  private publish(run: StudioRunDetail): void {
    for (const listener of this.listeners.get(run.id) ?? []) listener(structuredClone(run));
  }
}

async function withAgentLoopProgress(
  detail: StudioRunDetail,
  workspaceRoot: string,
  nodeRuns: WorkflowRun<ProductionBrief>["nodeRuns"],
): Promise<StudioRunDetail> {
  const nodes = await Promise.all(detail.nodes.map(async (node) => {
    const workflowOperationRequestId = nodeRuns.find((run) => run.nodeId === node.id)?.operationRequestId;
    const progress = await loadAgentLoopProgress(
      workspaceRoot,
      detail.id,
      node.id,
      workflowOperationRequestId,
    );
    const activeProgress = progress && ["producing", "auditing", "repairing"].includes(progress.phase);
    return progress && (!activeProgress || node.status === "running") ? { ...node, agentLoopProgress: progress } : node;
  }));
  const active = nodes.find((node) => node.id === detail.currentAction?.nodeId)
    ?? nodes.find((node) => node.status === "running");
  const actionLabel = active?.agentLoopProgress
    ? agentLoopActionLabel(active.agentLoopProgress.role ?? active.role ?? "制作角色", active.agentLoopProgress)
    : undefined;
  return {
    ...detail,
    nodes,
    ...(detail.currentAction && actionLabel ? { currentAction: { ...detail.currentAction, label: actionLabel } } : {}),
  };
}

// joint-v1 规划阶段的详情增强：沿用"先纯投影、再异步增强"的既有模式。
// pipeline 未实现检视、run 非 joint-v1（返回 undefined）或读取失败时原样返回——
// 规划阶段是增强信息，绝不能因为它让详情接口失败或伪造数据。
async function withPlanningStages(
  detail: StudioRunDetail,
  pipeline: StudioPipelinePort,
): Promise<StudioRunDetail> {
  if (typeof pipeline.inspectCreativePlanningStages !== "function") return detail;
  let stages: CreativePlanningStageInspection[] | undefined;
  try {
    stages = await pipeline.inspectCreativePlanningStages(detail.id);
  } catch {
    return detail;
  }
  if (!stages) return detail;
  return {
    ...detail,
    planningStages: stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
      ...(stage.effectiveModelId !== undefined ? { effectiveModelId: stage.effectiveModelId } : {}),
      ...(stage.providerId !== undefined ? { providerId: stage.providerId } : {}),
      artifactIds: [...stage.artifactIds],
      ...(stage.issue !== undefined && stage.issue !== "" ? { issue: redactManagedPathText(stage.issue) } : {}),
      allowedActions: [...stage.allowedActions],
    })),
  };
}

interface PendingTextTask {
  nodeId: string;
  phase: "produce" | "audit";
  role: string;
  checkpointKey: string;
  workflowOperationRequestId: string;
  identityDigest: string;
  operation: CodexPreparedOperation;
  locallyRunning: boolean;
  /** 该节点此刻的状态。决定这个未决任务是不是"用户正卡住的那一个"，见 selectPendingTextTask。 */
  nodeStatus: string;
  modifiedAt: number;
}

interface TextTaskRecoveryReceipt {
  version: "video-factory/text-task-recovery-v3";
  runRevision: number;
  taskIdentityDigest: string;
  taskState: "running" | "accepted_unknown" | "completed_success" | "completed_failure" | "not_accepted" | "conflict";
  lastAttemptAt: string;
  lastVerifiedAt?: string;
  observationError?: string;
  terminalError?: string;
  failureKind?: "model_provider_transient" | "model_provider_no_output" | "contract_rejected" | "binding_conflict";
}

async function withTaskRecovery(
  detail: StudioRunDetail,
  workspaceRoot: string,
  nodeRuns: WorkflowRun<ProductionBrief>["nodeRuns"],
): Promise<StudioRunDetail> {
  const pending = await loadPendingTextTask(workspaceRoot, detail.id, detail.nodes, nodeRuns);
  if (!pending) return detail;
  // 节点已经成功（或跳过）时，挂在它上面的未决任务只是历史账：那条路当时被人工放行，产出已经用上了，
  // 而 checkpoint 是只增不减的对账凭据，不会被回收。在一条已经走完的 run 上弹出「有未决付费任务」，
  // 只会让人以为还有事要处理；何况下面所有恢复动作都被 detail.status === "failed" 挡着，一个都点不动。
  // 历史留在账本里，不进界面。
  if (pending.nodeStatus === "succeeded" || pending.nodeStatus === "skipped") return detail;
  const receipt = await readTextTaskRecoveryReceipt(
    textTaskRecoveryReceiptPath(workspaceRoot, detail.id, pending.nodeId),
  );
  const currentReceipt = receipt
    && textTaskRecoveryReceiptMatches(receipt, detail.revision, pending)
    ? receipt
    : undefined;
  if (!currentReceipt && detail.status === "running" && pending.locallyRunning) return detail;
  const taskState = currentReceipt?.taskState ?? "accepted_unknown";
  const resultAvailable = taskState === "completed_success";
  const allowedActions: NonNullable<StudioRunDetail["taskRecovery"]>["allowedActions"] = ["query_original_task"];
  if (detail.status === "failed" && resultAvailable) allowedActions.push("retrieve_and_continue");
  if (detail.status === "failed" && taskState === "not_accepted") allowedActions.push("retry_failed_step");
  if (detail.status === "failed" && taskState === "completed_failure") {
    if (currentReceipt && retryableCompletedTextFailure(currentReceipt)) allowedActions.push("retry_failed_step");
    allowedActions.push("adjust_plan");
  }
  // failure 的"下一步"和 taskRecovery 的按钮讲的是同一件事，必须一致：这里既然已经确认原任务悬着，
  // 就不能再让 failure 去建议"重试这一步"——那条路会被重试守卫按 409 挡回来。文案指向一个点不动的
  // 按钮，比没有文案更糟：用户会以为是自己操作不对。
  //
  // 只改文案，不动 retryable：retryable 是 studio-service 选择用哪一句守卫文案的依据
  // （studio-service.ts:776 在 retryable === false 时先抛），在这里把它翻成 false 会让用户看到
  // "需要人工调整方案"，而真正该说的是"先去查询原任务"。重试按钮本身已经被上面的 allowedActions
  // 挡掉了，不需要靠 retryable 再挡一次。
  const failure = detail.status === "failed" && detail.failure
    ? { ...detail.failure, recoveryActions: textTaskRecoveryActions(allowedActions) }
    : detail.failure;
  return {
    ...detail,
    ...(failure ? { failure } : {}),
    taskRecovery: {
      nodeId: pending.nodeId,
      phase: pending.phase,
      taskState,
      resultAvailable,
      allowedActions,
      summary: taskRecoverySummary(taskState, detail.status === "paused"),
      ...(currentReceipt?.lastVerifiedAt ? { lastVerifiedAt: currentReceipt.lastVerifiedAt } : {}),
      ...(currentReceipt?.lastAttemptAt ? { lastAttemptAt: currentReceipt.lastAttemptAt } : {}),
      ...(currentReceipt?.observationError
        ? { observationError: redactManagedPathText(currentReceipt.observationError) }
        : {}),
      ...(currentReceipt?.terminalError
        ? { terminalError: redactManagedPathText(currentReceipt.terminalError) }
        : {}),
    },
  };
}

async function loadPendingTextTask(
  workspaceRoot: string,
  runId: string,
  nodes: Array<{ id: string }>,
  nodeRuns: WorkflowRun<ProductionBrief>["nodeRuns"],
  requestedNodeId?: string,
): Promise<PendingTextTask | undefined> {
  const operationRequestIds = new Map(nodeRuns.flatMap((node) => (
    node.operationRequestId ? [[node.nodeId, node.operationRequestId] as const] : []
  )));
  const nodeStatuses = new Map(nodeRuns.map((node) => [node.nodeId, node.status] as const));
  const candidates: PendingTextTask[] = [];
  for (const node of nodes) {
    if (requestedNodeId && node.id !== requestedNodeId) continue;
    const workflowOperationRequestId = operationRequestIds.get(node.id);
    if (!workflowOperationRequestId) continue;
    const directory = path.join(workspaceRoot, "runs", runId, "nodes", node.id, "agent-loop-checkpoints");
    let files: string[];
    try {
      files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    for (const name of files) {
      const filePath = path.join(directory, name);
      try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        if (!isRecord(value)
          || (value.version !== "video-factory/agent-loop-checkpoint-v8"
            && value.version !== "video-factory/agent-loop-checkpoint-v9")) continue;
        const checkpointKey = name.slice(0, -".json".length);
        const recoveryOwner = value.recoveryOwner;
        if (value.key !== checkpointKey
          || typeof value.role !== "string"
          || !isRecord(recoveryOwner)
          || recoveryOwner.runId !== runId
          || recoveryOwner.nodeId !== node.id
          || recoveryOwner.workflowOperationRequestId !== workflowOperationRequestId) continue;
        const pending = value.pendingOperation;
        if (!isRecord(pending)
          || (pending.phase !== "produce" && pending.phase !== "audit")
          || !Number.isInteger(pending.iteration)
          || Number(pending.iteration) < 1
          || !Number.isInteger(pending.generation)
          || Number(pending.generation) < 0
          || pending.operationKey !== `${String(value.cycle)}:${String(pending.iteration)}:${pending.phase}`
          || !isRecord(pending.operation)) continue;
        const operation = pending.operation as unknown as CodexPreparedOperation;
        if (operation.version !== "video-factory/codex-prepared-operation-v1"
          || (pending.phase === "audit") !== (operation.kind === "role-audit")
          || !isRecord(operation.binding)
          || typeof operation.binding.requestDigest !== "string"
          || operation.binding.kind !== operation.kind
          || !isRecord(operation.route)
          || typeof operation.route.socketPath !== "string") continue;
        const failedOperationRequestIds = value.failedOperationRequestIds;
        const checkpointFailure = isRecord(value.failure) ? value.failure : undefined;
        const definitivelyNotAccepted = checkpointFailure?.stage === "not_accepted"
          || checkpointFailure?.stage === "rejected"
          || checkpointFailure?.stage === "conflict";
        if (value.status === "failed"
          && pending.operation.taskFact === "not_submitted"
          && isRecord(failedOperationRequestIds)
          && failedOperationRequestIds[pending.operationKey] === operation.requestId
          && definitivelyNotAccepted) continue;
        const role = value.role;
        if (pending.phase === "produce" && !producerRoleMatchesTask(role, operation.kind)) continue;
        const identityDigest = createHash("sha256").update(JSON.stringify({
          runId,
          nodeId: node.id,
          role,
          checkpointKey,
          workflowOperationRequestId,
          phase: pending.phase,
          operationKey: pending.operationKey,
          generation: pending.generation,
          requestId: operation.requestId,
          binding: operation.binding,
          brokerBinding: operation.brokerBinding,
        })).digest("hex");
        candidates.push({
          nodeId: node.id,
          phase: pending.phase,
          role,
          checkpointKey,
          workflowOperationRequestId,
          identityDigest,
          operation,
          locallyRunning: value.status === "running" && !checkpointFailure,
          nodeStatus: nodeStatuses.get(node.id) ?? "pending",
          modifiedAt: await stat(filePath).then((fileStat) => fileStat.mtimeMs, () => 0),
        });
      } catch {
        // 单个损坏 checkpoint 不得让整条 run 详情失效；其本身也不能成为恢复授权。
      }
    }
  }
  return selectPendingTextTask(candidates);
}

// 一条 run 里可以有多个未决的付费任务——最典型的是某个节点的审计中断过一次（stage=uncertain），
// 之后它照样被人工放行并成功走过去了，而那个 checkpoint 谁也不去收尾（checkpoint 是只增不减的
// 对账凭据，不能删）。旧规则要求"全 run 恰好只有一个"才认，于是历史里留下任意一个中断记录，
// 恢复面板就整体消失：用户既看不到"查询原任务"，重试又必然被守卫拦下，整条 run 无路可走。
//
// 真正的判据不是"有几个"，而是"用户此刻卡在哪一个上"。按节点的当前状态排序：failed 的节点就是
// 卡住的那一个；已经 succeeded 的节点上的未决任务只是历史，排在最后。同类里取 checkpoint 最新
// 写入的那份。注意这个顺序只决定"先给谁看"，不放松任何验证——被选中后仍要过 receipt 与身份摘要。
function selectPendingTextTask(candidates: PendingTextTask[]): PendingTextTask | undefined {
  const rank = (candidate: PendingTextTask): number => {
    if (candidate.nodeStatus === "failed") return 0;
    if (candidate.nodeStatus === "succeeded" || candidate.nodeStatus === "skipped") return 2;
    return 1;
  };
  return [...candidates].sort((left, right) => rank(left) - rank(right) || right.modifiedAt - left.modifiedAt)[0];
}

/**
 * 与 taskRecovery 真正给出的按钮一一对应。原任务的处置只有三种：还没查过就先查；查出来已受理
 * 且成功就取回结果接着做；查出来确证没被受理才能重发。文案不得出现这之外的出路。
 */
function textTaskRecoveryActions(allowedActions: string[]): string[] {
  const actions = ["先查询原任务，确认它是否已被受理、是否已经扣费"];
  if (allowedActions.includes("retrieve_and_continue")) actions.push("取回原任务结果并继续制作");
  if (allowedActions.includes("retry_failed_step")) actions.push("确认结果无法复用后再重试这一步");
  return actions;
}

function producerRoleMatchesTask(role: string, kind: CodexPreparedOperation["kind"]): boolean {
  const expectedRole: Partial<Record<CodexPreparedOperation["kind"], string>> = {
    "creative-treatment": "导演前期构思",
    "script-draft": "编剧",
    "director-plan": "导演",
    "publish-copy": "发行编辑",
    "asset-rank": "候选画面复核",
    "reference-grammar": "参考片分析师",
    "visual-review": "视觉审片员",
  };
  return expectedRole[kind] === role;
}

function textTaskRecoveryReceipt(
  runRevision: number,
  pending: PendingTextTask,
  taskState: TextTaskRecoveryReceipt["taskState"],
  options: {
    attemptedAt: string;
    lastVerifiedAt?: string;
    observationError?: string;
    terminalError?: string;
    failureKind?: TextTaskRecoveryReceipt["failureKind"];
  },
): TextTaskRecoveryReceipt {
  return {
    version: "video-factory/text-task-recovery-v3",
    runRevision,
    taskIdentityDigest: pending.identityDigest,
    taskState,
    lastAttemptAt: options.attemptedAt,
    ...(options.lastVerifiedAt ? { lastVerifiedAt: options.lastVerifiedAt } : {}),
    ...(options.observationError ? { observationError: options.observationError } : {}),
    ...(options.terminalError ? { terminalError: options.terminalError } : {}),
    ...(options.failureKind ? { failureKind: options.failureKind } : {}),
  };
}

function textTaskRecoveryReceiptMatches(
  receipt: TextTaskRecoveryReceipt,
  runRevision: number,
  pending: PendingTextTask,
): boolean {
  return receipt.runRevision === runRevision
    && receipt.taskIdentityDigest === pending.identityDigest;
}

function textTaskRecoveryReceiptPath(workspaceRoot: string, runId: string, nodeId: string): string {
  return path.join(workspaceRoot, "runs", runId, "nodes", nodeId, "text-task-recovery.json");
}

async function readTextTaskRecoveryReceipt(receiptPath: string): Promise<TextTaskRecoveryReceipt | undefined> {
  try {
    const raw = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    if (raw.version !== "video-factory/text-task-recovery-v2" && raw.version !== "video-factory/text-task-recovery-v3") return undefined;
    const value = raw as Partial<TextTaskRecoveryReceipt> & { observedAt?: unknown };
    const lastAttemptAt = raw.version === "video-factory/text-task-recovery-v3" ? value.lastAttemptAt : value.observedAt;
    const lastVerifiedAt = raw.version === "video-factory/text-task-recovery-v3"
      ? value.lastVerifiedAt
      : value.observationError ? undefined : value.observedAt;
    if (
      !Number.isInteger(value.runRevision) || Number(value.runRevision) < 0
      || typeof value.taskIdentityDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.taskIdentityDigest)
      || !["running", "accepted_unknown", "completed_success", "completed_failure", "not_accepted", "conflict"].includes(String(value.taskState))
      || typeof lastAttemptAt !== "string"
      || (lastVerifiedAt !== undefined && typeof lastVerifiedAt !== "string")) return undefined;
    return {
      ...value,
      version: "video-factory/text-task-recovery-v3",
      lastAttemptAt,
      ...(typeof lastVerifiedAt === "string" ? { lastVerifiedAt } : {}),
    } as TextTaskRecoveryReceipt;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return undefined;
  }
}

function retryableCompletedTextFailure(receipt: TextTaskRecoveryReceipt): boolean {
  return receipt.failureKind === "model_provider_transient"
    || receipt.failureKind === "model_provider_no_output";
}

function terminalTextTaskState(state: TextTaskRecoveryReceipt["taskState"]): boolean {
  return state === "completed_success" || state === "completed_failure" || state === "not_accepted" || state === "conflict";
}

function mergeTextTaskRecoveryReceipt(
  current: TextTaskRecoveryReceipt | undefined,
  next: TextTaskRecoveryReceipt,
): TextTaskRecoveryReceipt {
  if (!current
    || current.runRevision !== next.runRevision
    || current.taskIdentityDigest !== next.taskIdentityDigest) return next;
  if (terminalTextTaskState(current.taskState) && !terminalTextTaskState(next.taskState)) {
    return {
      ...current,
      lastAttemptAt: current.lastAttemptAt > next.lastAttemptAt ? current.lastAttemptAt : next.lastAttemptAt,
      ...(next.observationError ? { observationError: next.observationError } : {}),
    };
  }
  if (terminalTextTaskState(current.taskState) && terminalTextTaskState(next.taskState)
    && current.taskState !== next.taskState) return current;
  return next;
}

function taskRecoverySummary(taskState: TextTaskRecoveryReceipt["taskState"], paused: boolean): string {
  const pauseSuffix = paused ? "结果不会解除暂停；请在确认后显式继续。" : "";
  if (taskState === "running") return `原模型任务仍在处理中；查询不会重新提交或消耗新的创作轮次。${pauseSuffix}`;
  if (taskState === "completed_success") return `已找到之前任务的结果，无需重新生成。${pauseSuffix}`;
  if (taskState === "completed_failure") return "原任务已经结束但未完成；已有成果已保留，请查看原因后决定下一步。";
  if (taskState === "not_accepted") return "模型服务已确认原任务没有执行，可以安全地有限重试。";
  if (taskState === "conflict") return "原任务身份与当前记录不匹配，已停止自动执行；已有成果不受影响。";
  return `暂时无法确认这次任务的结果。系统没有重新提交，请先查询原任务。${pauseSuffix}`;
}

export async function loadAgentLoopProgress(
  workspaceRoot: string,
  runId: string,
  nodeId: string,
  workflowOperationRequestId?: string,
): Promise<StudioAgentLoopProgress | undefined> {
  const directory = path.join(workspaceRoot, "runs", runId, "nodes", nodeId, "agent-loop-checkpoints");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const candidates = await Promise.all(files.map(async (name) => {
      const filePath = path.join(directory, name);
      const [fileStat, value] = await Promise.all([
        stat(filePath),
        readFile(filePath, "utf8").then((content) => JSON.parse(content) as unknown),
      ]);
      return { filePath, modifiedAt: fileStat.mtimeMs, value, progress: parseAgentLoopProgress(value) };
    }));
    if (!workflowOperationRequestId) {
      return undefined;
    }
    const owned = candidates.filter((candidate) => {
      if (!isRecord(candidate.value)) return false;
      const owner = candidate.value.recoveryOwner;
      return isRecord(owner)
        && owner.runId === runId
        && owner.nodeId === nodeId
        && owner.workflowOperationRequestId === workflowOperationRequestId;
    });
    const pending = owned.filter((candidate) => isRecord(candidate.value) && isRecord(candidate.value.pendingOperation));
    if (pending.length === 1) return pending[0]?.progress;
    if (pending.length > 1) return undefined;
    const active = owned.filter((candidate) => candidate.progress
      && ["producing", "auditing", "repairing"].includes(candidate.progress.phase));
    if (active.length === 1) return active[0]?.progress;
    if (active.length > 1) return undefined;
    // 同一节点可以有多个已停下的 checkpoint 命中同一个操作归属：角色循环的首选模型失败、兜底
    // 接上之后，失败终态与最终状态各留一份。这时"最新写入的那份"才是这个节点此刻的样子；
    // 之前这里一律返回 undefined，于是带着兜底链跑起来（首选模型额度耗尽是最常见的一种）审计
    // 建议必然消失，而那正是用户要拿主意的一刻。
    const stopped = owned
      .filter((candidate) => candidate.progress
        && ["passed", "failed", "exhausted", "awaiting_user", "halted"].includes(candidate.progress.phase))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    return stopped[0]?.progress;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return undefined;
  }
}

function parseAgentLoopProgress(value: unknown): StudioAgentLoopProgress | undefined {
  if (!isRecord(value)
    || (value.version !== "video-factory/agent-loop-checkpoint-v3"
      && value.version !== "video-factory/agent-loop-checkpoint-v4"
      && value.version !== "video-factory/agent-loop-checkpoint-v5"
      && value.version !== "video-factory/agent-loop-checkpoint-v6"
      && value.version !== "video-factory/agent-loop-checkpoint-v7"
      && value.version !== "video-factory/agent-loop-checkpoint-v8"
      && value.version !== "video-factory/agent-loop-checkpoint-v9")) return undefined;
  const maxIterations = Number(value.maxIterations);
  const role = typeof value.role === "string" && value.role.trim() ? value.role.trim() : undefined;
  const completed = Array.isArray(value.completed) ? value.completed : [];
  const phaseAttempts = isRecord(value.phaseAttempts) ? value.phaseAttempts : {};
  const unacceptedPhaseAttempts = isRecord(value.unacceptedPhaseAttempts) ? value.unacceptedPhaseAttempts : {};
  const rawProducerAttempts = Number.isSafeInteger(phaseAttempts.produce) && Number(phaseAttempts.produce) >= 0
    ? Number(phaseAttempts.produce)
    : completed.length + (isRecord(value.pendingCandidate) ? 1 : 0);
  const rawAuditAttempts = Number.isSafeInteger(phaseAttempts.audit) && Number(phaseAttempts.audit) >= 0
    ? Number(phaseAttempts.audit)
    : completed.length;
  const producerModelCallCount = Math.max(0, rawProducerAttempts - (
    Number.isSafeInteger(unacceptedPhaseAttempts.produce) ? Number(unacceptedPhaseAttempts.produce) : 0
  ));
  const auditModelCallCount = Math.max(0, rawAuditAttempts - (
    Number.isSafeInteger(unacceptedPhaseAttempts.audit) ? Number(unacceptedPhaseAttempts.audit) : 0
  ));
  const structuredRepairModelCallCount = Number.isSafeInteger(value.structuredRepairModelCallCount)
    && Number(value.structuredRepairModelCallCount) >= 0
    ? Number(value.structuredRepairModelCallCount)
    : 0;
  const status = value.status;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 3) return undefined;
  if (status !== "running" && status !== "passed" && status !== "exhausted"
    && status !== "awaiting_user" && status !== "failed") return undefined;
  const pending = isRecord(value.pendingCandidate) ? Number(value.pendingCandidate.iteration) : undefined;
  const iteration = Number.isInteger(pending)
    ? Math.min(maxIterations, Math.max(1, Number(pending)))
    : Math.min(maxIterations, Math.max(1, completed.length + (status === "running" ? 1 : 0)));
  const latest = completed.at(-1);
  const audit = isRecord(latest) && isRecord(latest.audit) ? latest.audit : undefined;
  const hostReadiness = isRecord(latest) && isRecord(latest.hostReadiness) ? latest.hostReadiness : undefined;
  const planningDisposition = hostReadiness?.status === "needs_source"
    ? "needs_source"
    : audit && isRecord(audit.planningDisposition)
    && (audit.planningDisposition.action === "needs_source" || audit.planningDisposition.action === "needs_user")
      ? audit.planningDisposition.action
      : undefined;
  const verdict = audit?.verdict === "pass" || audit?.verdict === "repair" ? audit.verdict : undefined;
  const score = Number(audit?.score);
  const summary = typeof audit?.summary === "string" ? redactManagedPathText(audit.summary) : undefined;
  // 裁决为 repair 时，真正能照着改的是这三段（哪条不达标/凭什么/建议怎么改）。缺任何一段
  // 就整条丢掉：只给出半截意见会让用户以为"这条没什么可改的"，比不显示更误导。
  const issues = auditIssueTexts(audit?.issues);
  // 角色循环失败时，中文原因由 role-agent-loop 写进 checkpoint 的 failure.summary。不投影它，
  // 上面那句「模型调用已停止，请查看失败原因」里的"失败原因"在任何界面上都不存在——节点活下来
  // 接着往下走时没有第二条通道，原因会静默地留在磁盘上。存储里可能是任意历史形状，逐字段判型。
  const failureSummary = isRecord(value.failure) && typeof value.failure.summary === "string"
    ? redactManagedPathText(value.failure.summary)
    : undefined;
  const latestAudit: StudioAgentLoopProgress["latestAudit"] = verdict && Number.isInteger(score) && score >= 0 && score <= 100 && summary
    ? { verdict, score, summary, ...(issues.length ? { issues } : {}) }
    : undefined;
  // v7 的 status "failed" 是角色调用终态失败（Provider/基础设施故障等）——与"轮次耗尽未能
  // 通过审计"分开呈现，不误报为 audit exhausted。
  const phase: StudioAgentLoopProgress["phase"] = status === "passed"
    ? "passed"
    : status === "awaiting_user"
      ? "awaiting_user"
      : status === "exhausted"
        ? "exhausted"
        : status === "failed"
          ? planningDisposition ? "halted" : "failed"
          : pending !== undefined
            ? "auditing"
            : completed.length > 0
              ? "repairing"
              : "producing";
  return {
    ...(role ? { role } : {}),
    iteration,
    maxIterations,
    completedIterations: completed.length,
    producerModelCallCount,
    auditModelCallCount,
    structuredRepairModelCallCount,
    phase,
    ...(latestAudit ? { latestAudit } : {}),
    ...(failureSummary ? { failureSummary } : {}),
  };
}

function agentLoopActionLabel(role: string, progress: StudioAgentLoopProgress): string {
  const prefix = `${role}第 ${progress.iteration}/${progress.maxIterations} 轮`;
  if (progress.phase === "auditing") return `${prefix}：独立审计正在检查`;
  if (progress.phase === "repairing") return `${prefix}：按上一轮审计修订`;
  if (progress.phase === "passed") return `${prefix}：独立审计已通过`;
  if (progress.phase === "exhausted") return `${prefix}：三轮审计未通过`;
  if (progress.phase === "awaiting_user") return `${prefix}：审计建议已附上，交给你裁决`;
  if (progress.phase === "halted") return `${prefix}：已识别外部前提，等待调整方案`;
  if (progress.phase === "failed") return `${prefix}：模型调用已停止，请查看失败原因与恢复选项`;
  return `${prefix}：正在生成候选交付`;
}

function withArchiveState<T extends StudioRunSummary>(run: T, archivedAt?: string): T {
  if (!archivedAt) return run;
  return { ...run, archivedAt };
}

async function prepareCandidateInventoryRevision(
  runRoot: string,
  reference: Record<string, unknown>,
  publicDocument: unknown,
  revisionId: string,
): Promise<{ destination: string; content: string }> {
  const inventoryPath = reference.candidateInventoryPath;
  if (typeof inventoryPath !== "string") {
    throw new StudioInputError("候选素材缺少私有下载清单，请重新生成候选素材后再编辑。");
  }
  await assertContainedFile(runRoot, inventoryPath);
  let inventoryDocument: unknown;
  try {
    inventoryDocument = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    throw new StudioInputError("候选素材的私有下载清单无法读取，请重新生成候选素材。");
  }
  const publicReport = candidateReport(publicDocument, "候选素材清单");
  const privateInventory = candidateReport(inventoryDocument, "候选素材私有清单");
  if (privateInventory.version !== "video-factory/asset-candidate-inventory-v1") {
    throw new StudioInputError("候选素材私有清单版本不受支持，请重新生成候选素材。");
  }
  const privateScenes = sceneCandidateMap(privateInventory.scene_candidates, "候选素材私有清单");
  const publicScenes = sceneCandidateMap(publicReport.scene_candidates, "候选素材清单");
  if (publicScenes.size !== privateScenes.size || [...privateScenes.keys()].some((position) => !publicScenes.has(position))) {
    throw new StudioInputError("人工修订必须保留原有的全部场景；可以删除或重排每个场景内的候选素材。");
  }

  const sceneCandidates = publicReport.scene_candidates.map((publicScene, sceneIndex) => {
    const scenePosition = candidateScenePosition(publicScene, `候选素材清单第 ${sceneIndex + 1} 个场景`);
    const privateScene = privateScenes.get(scenePosition)!;
    const privateCandidates = candidateArray(privateScene.candidates, `场景 ${scenePosition} 的私有候选素材`);
    const indexed = new Map<string, Record<string, unknown>>();
    for (const [candidateIndex, candidate] of privateCandidates.entries()) {
      const key = candidateIdentity(candidate, `场景 ${scenePosition} 的私有候选素材 ${candidateIndex + 1}`);
      if (indexed.has(key)) throw new StudioInputError(`场景 ${scenePosition} 的私有候选素材存在重复身份。`);
      indexed.set(key, candidate);
    }
    const selected = candidateArray(publicScene.candidates, `场景 ${scenePosition} 的候选素材`).map((candidate, candidateIndex) => {
      const key = candidateIdentity(candidate, `场景 ${scenePosition} 的候选素材 ${candidateIndex + 1}`);
      const match = indexed.get(key);
      if (!match) throw new StudioInputError(`场景 ${scenePosition} 包含不属于原候选池的素材，不能写入私有下载清单。`);
      assertCandidateSourceFieldsUnchanged(candidate, match, `场景 ${scenePosition} 的候选素材 ${candidateIndex + 1}`);
      indexed.delete(key);
      return structuredClone(match);
    });
    return { scene_position: scenePosition, candidates: selected };
  });
  const revisedInventory = { ...privateInventory, scene_candidates: sceneCandidates };
  return {
    destination: path.join(runRoot, "nodes", "asset-candidates", "human-revisions", `${revisionId}.inventory.private.json`),
    content: `${JSON.stringify(revisedInventory, null, 2)}\n`,
  };
}

function candidateReport(value: unknown, label: string): Record<string, unknown> & { version: string; scene_candidates: Record<string, unknown>[] } {
  if (!isRecord(value) || typeof value.version !== "string" || !Array.isArray(value.scene_candidates)) {
    throw new StudioInputError(`${label}格式不正确。`);
  }
  return { ...value, version: value.version, scene_candidates: candidateArray(value.scene_candidates, label) };
}

function sceneCandidateMap(scenes: Record<string, unknown>[], label: string): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const [index, scene] of scenes.entries()) {
    const position = candidateScenePosition(scene, `${label}第 ${index + 1} 个场景`);
    if (result.has(position)) throw new StudioInputError(`${label}包含重复场景 ${position}。`);
    result.set(position, scene);
  }
  return result;
}

function candidateScenePosition(scene: Record<string, unknown>, label: string): number {
  if (!Number.isInteger(scene.scene_position) || Number(scene.scene_position) < 1) {
    throw new StudioInputError(`${label}缺少有效场景编号。`);
  }
  return Number(scene.scene_position);
}

function candidateArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((candidate) => !isRecord(candidate))) {
    throw new StudioInputError(`${label}格式不正确。`);
  }
  return value as Record<string, unknown>[];
}

function candidateIdentity(candidate: Record<string, unknown>, label: string): string {
  const provider = typeof candidate.provider_id === "string" && candidate.provider_id.trim()
    ? candidate.provider_id.trim()
    : typeof candidate.provider === "string" ? candidate.provider.trim() : "";
  const assetId = typeof candidate.asset_id === "string" ? candidate.asset_id.trim() : "";
  if (!provider || !assetId) throw new StudioInputError(`${label}缺少素材来源或素材编号。`);
  return `${provider}\u0000${assetId}`;
}

const IMMUTABLE_CANDIDATE_FIELDS = [
  "provider",
  "provider_id",
  "asset_id",
  "media_type",
  "width",
  "height",
  "duration",
  "preview_url",
  "source_url",
  "creator",
  "creator_url",
  "license_note",
] as const;

function assertCandidateSourceFieldsUnchanged(
  candidate: Record<string, unknown>,
  original: Record<string, unknown>,
  label: string,
): void {
  for (const field of IMMUTABLE_CANDIDATE_FIELDS) {
    if (!Object.is(candidate[field], original[field])) {
      throw new StudioInputError(`${label}的来源字段 ${field} 不能修改；可以删除、重排素材，或调整查询和评分。`);
    }
  }
}

function modelEstimate(provider: StudioProvider, modelId: string | undefined): number | undefined {
  if (!modelId) return provider.estimatedCnyPerClip;
  return provider.modelProfiles?.find((model) => model.id === modelId)?.estimatedCnyPerClip;
}

interface StartRecord {
  version: 1;
  state: "pending" | "completed";
  digest: string;
  response?: StartRunResponse;
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(idempotencyKey)) {
    throw new StudioInputError("制作请求编号格式不正确。");
  }
}

function startRecordPath(workspaceRoot: string, idempotencyKey: string): string {
  return path.join(workspaceRoot, "idempotency", "production-start", `${idempotencyKey}.json`);
}

function startRequestDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input) ?? "undefined").digest("hex");
}

function commandReceiptPath(
  workspaceRoot: string,
  runId: string,
  kind: "production-authorization" | "production-amendment",
  idempotencyKey: string,
): string {
  const name = createHash("sha256").update(idempotencyKey).digest("hex");
  return path.join(workspaceRoot, "runs", runId, ".commands", kind, `${name}.json`);
}

function productionQualityContractDigest(brief: ProductionBrief): string {
  return canonicalQualityContractDigest({
    angle: brief.angle,
    audience: brief.audience,
    durationRange: brief.durationRange ?? { minSeconds: 0, maxSeconds: 0 },
    directorProfileId: brief.director?.profileId ?? "",
    ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
    ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
    ...(brief.visualPlan
      ? { visualPlanDigest: createHash("sha256").update(JSON.stringify(brief.visualPlan)).digest("hex") }
      : {}),
    ...(brief.editorial ? { editorial: brief.editorial } : {}),
  });
}

async function readStartRecord(recordPath: string): Promise<StartRecord> {
  try {
    const value = JSON.parse(await readFile(recordPath, "utf8")) as StartRecord;
    if (value.version !== 1 || (value.state !== "pending" && value.state !== "completed") || !value.digest) throw new Error();
    return value;
  } catch {
    throw new StudioConflictError("制作幂等记录无法读取；为避免重复扣费，请先检查制作记录。");
  }
}

async function writeStartRecord(recordPath: string, record: StartRecord): Promise<void> {
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, "utf8");
  await rename(temporaryPath, recordPath);
}

function toRunSummary(run: WorkflowRun<ProductionBrief>): StudioRunSummary {
  const brief = effectiveProductionBrief(run);
  const currentNodeId = activeRunNodeId(run);
  const finalReviewOutcome = currentFinalReviewOutcome(run);
  const continuationSupported = supportsRunContinuation(run);
  const videoArtifact = effectiveNodeArtifact(run, "render", (artifact) =>
    artifact.kind === "render" && artifact.contentType === "video/mp4")
    ?? legacyNodeArtifact(run, "render", (artifact) =>
      artifact.contentType === "video/mp4");
  return {
    id: run.id,
    title: brief.title,
    status: run.status,
    platform: brief.platform,
    durationSeconds: brief.durationSeconds,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    currentNodeId,
    runPurpose: brief.runPurpose === "test" ? "test" : "production",
    workflowNodeIds: visibleWorkflowNodes(run).map((node) => node.id),
    ...(finalReviewOutcome ? { finalReviewOutcome } : {}),
    ...(!continuationSupported ? { continuation: legacyRunContinuation() } : {}),
    ...(continuationSupported && run.status === "needs_human"
      ? { nextAction: "review" as const }
      : continuationSupported && (run.status === "awaiting_spend_approval" || run.status === "approval_invalidated")
        ? { nextAction: "confirm_spend" as const }
        : continuationSupported && run.status === "stale"
          ? { nextAction: "regenerate" as const }
          : {}),
    ...(videoArtifact?.uri ? { videoContentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(videoArtifact.id)}/content` } : {}),
    ...(brief.creationContext ? {
      creationOrigin: brief.creationContext.origin,
      // 案例来源没有机会编号，投影时省略而不是给一个空串：空串看起来像一个真实编号。
      ...(brief.creationContext.opportunityId ? { opportunityId: brief.creationContext.opportunityId } : {}),
    } : {}),
    ...(brief.seriesContext ? {
      seriesId: brief.seriesContext.seriesId,
      episodeNumber: brief.seriesContext.episodeNumber,
      ...(brief.seriesContext.productionReservationId
        ? { productionReservationId: brief.seriesContext.productionReservationId }
        : {}),
    } : {}),
  };
}

function currentFinalReviewOutcome(run: WorkflowRun<ProductionBrief>): StudioRunSummary["finalReviewOutcome"] {
  const finalReview = run.nodeRuns.find((node) => node.nodeId === "final-review");
  if (!finalReview || finalReview.outputState?.stale === true) return undefined;
  const interventionId = finalReview.intervention?.id
    ?? [...run.interventions].reverse().find((intervention) => intervention.nodeId === "final-review")?.id;
  if (!interventionId) return undefined;
  const decision = [...run.decisions].reverse().find((candidate) =>
    candidate.interventionId === interventionId
    && (candidate.action === "approve" || candidate.action === "reject"));
  if (decision?.action === "approve" && finalReview.status === "succeeded") return "approved";
  if (decision?.action === "reject" && finalReview.status === "rejected") return "rejected";
  return undefined;
}

function activeRunNodeId(run: WorkflowRun<ProductionBrief>): string {
  return run.nodeRuns.find((node) => node.status === "running")?.nodeId
    ?? run.nodeRuns.find((node) => ["needs_human", "awaiting_spend_approval", "approval_invalidated", "stale"].includes(node.status))?.nodeId
    ?? run.nodeRuns.find((node) => node.status === "failed" || node.status === "rejected")?.nodeId
    ?? run.nodeRuns.find((node) => node.status === "pending")?.nodeId
    ?? run.nodeRuns.at(-1)?.nodeId
    ?? "brief";
}

function visibleWorkflowNodes(run: WorkflowRun<ProductionBrief>): Array<{ id: string; label: string; role: string }> {
  if (!supportsRunContinuation(run)) {
    const persistedNodeIds = new Set([
      ...run.nodeRuns.map((node) => node.nodeId),
      ...(run.executionPlan ?? []).map((node) => node.nodeId),
    ]);
    const knownNodes = WORKFLOW_NODES.filter((node) => persistedNodeIds.delete(node.id));
    const unknownNodes = [...persistedNodeIds].map((id) => ({
      id,
      label: id,
      role: run.nodeRuns.find((node) => node.nodeId === id)?.role
        ?? run.executionPlan?.find((node) => node.nodeId === id)?.role
        ?? "制作角色",
    }));
    return [...knownNodes, ...unknownNodes];
  }
  const brief = effectiveProductionBrief(run);
  // joint-v1 拓扑：四段旧规划节点收敛为一个 creative-planning 节点（brief 之后、参考语法之后），
  // 编辑与检视都指向它。
  const legacyPlanningNodeIds = new Set(["script", "visual-direction", "asset-candidates", "asset-semantic-rank"]);
  const jointPlanning = brief.workflowFeatures?.creativePlanning === "joint-v1";
  const workflowNodes = jointPlanning
    ? [
        ...WORKFLOW_NODES.filter((item) => item.id === "brief" || item.id === "reference-grammar"),
        { id: "creative-planning", label: "创作规划", role: "创作规划制片" },
        ...WORKFLOW_NODES.filter((item) => item.id !== "brief" && item.id !== "reference-grammar" && !legacyPlanningNodeIds.has(item.id)),
      ]
    : brief.director
      ? WORKFLOW_NODES
      : WORKFLOW_NODES.filter((item) => item.id !== "visual-direction");
  const semanticNodes = brief.workflowFeatures?.assetSemanticRank
    ? workflowNodes
    : workflowNodes.filter((item) => item.id !== "asset-candidates" && item.id !== "asset-semantic-rank");
  const referenceNodes = brief.workflowFeatures?.referenceGrammar
    ? semanticNodes
    : semanticNodes.filter((item) => item.id !== "reference-grammar");
  const sourceReviewWasPlanned = run.nodeRuns.some((node) => node.nodeId === "asset-source-review")
    || (run.executionPlan ?? []).some((plan) => plan.nodeId === "asset-source-review");
  const sourceReviewNodes = sourceReviewWasPlanned
    ? referenceNodes
    : referenceNodes.filter((item) => item.id !== "asset-source-review");
  return brief.providers.visualReview
    ? sourceReviewNodes
    : sourceReviewNodes.filter((item) => item.id !== "visual-review");
}

function toRunDetail(
  run: WorkflowRun<ProductionBrief>,
  options: { now: string; historicalNodeDurations: Record<string, number[]> },
): StudioRunDetail {
  const brief = effectiveProductionBrief(run);
  const artifacts = run.artifacts.map((artifact): StudioArtifact => ({
    id: artifact.id,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
    ...(artifact.producer ? { producerNodeId: artifact.producer.nodeId } : {}),
    ...(artifact.provenance.providerId ? { providerId: artifact.provenance.providerId } : {}),
    ...(artifact.provenance.creator ? { creator: artifact.provenance.creator } : {}),
    ...(artifact.provenance.creatorUrl ? { creatorUrl: artifact.provenance.creatorUrl } : {}),
    ...(artifact.provenance.previewUrl ? { previewUrl: artifact.provenance.previewUrl } : {}),
    ...(artifact.provenance.scenePosition ? { scenePosition: artifact.provenance.scenePosition } : {}),
    ...(artifact.provenance.licenseNote ? { licenseNote: artifact.provenance.licenseNote } : {}),
    ...(artifact.uri && !isPrivateArtifactKind(artifact.kind) ? { contentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}/content` } : {}),
  }));
  const reworkImpact = summarizeReworkImpact(run);
  const nodeRuns = new Map(run.nodeRuns.map((node) => [node.nodeId, node]));
  const executionPlans = new Map((run.executionPlan ?? []).map((plan) => [plan.nodeId, plan]));
  const visibleNodes = visibleWorkflowNodes(run);
  const nodes = visibleNodes.map(({ id, label, role }): StudioNode => {
    const node = nodeRuns.get(id);
    const plannedExecution = executionPlans.get(id);
    const safeExecutionReceipt = node?.executionReceipt
      ? redactManagedFileReferences(node.executionReceipt) as NonNullable<StudioNode["executionReceipt"]>
      : undefined;
    const safePlannedExecution = plannedExecution
      ? redactManagedFileReferences(plannedExecution) as NonNullable<StudioNode["plannedExecution"]>
      : undefined;
    const effectiveExecution = safeExecutionReceipt ?? safePlannedExecution;
    const currentOutput = node?.status !== "stale" && node?.outputState?.stale !== true;
    // 先按原始输出补出条目编号再脱敏：条目编号是按 finding 内容算的，若在脱敏后的副本上算，
    // 描述里恰好带托管路径的那些条目会算出另一个键，操作员的表态就永远对不上、批准被永久卡住。
    const safeOutput = node?.output !== undefined
      ? redactManagedFileReferences(withReviewScopeCurrent(id, node.output, currentOutput))
      : undefined;
    return {
      id,
      label,
      role: node?.role ?? role,
      actionLabel: nodeActionLabel(id, effectiveExecution?.providerId),
      status: node?.status ?? "pending",
      ...(node?.startedAt ? { startedAt: node.startedAt } : {}),
      ...(node?.finishedAt ? { finishedAt: node.finishedAt } : {}),
      ...(node?.error ? { error: redactManagedPathText(node.error) } : {}),
      ...(node?.interrupted ? { interrupted: true } : {}),
      ...(node?.outcomeUncertain ? { outcomeUncertain: true } : {}),
      artifactIds: [...(node?.artifactIds ?? [])],
      qualityGateResults: (node?.qualityGateResults ?? []).map((result) => ({
        gateId: result.gateId,
        status: result.status,
        reasons: result.reasons.map(redactManagedPathText),
      })),
      ...(safeOutput !== undefined ? { output: safeOutput } : {}),
      ...(node?.inputState ? {
        inputState: {
          effectiveVersionId: node.inputState.effectiveVersionId,
          stale: node.inputState.stale,
          versions: node.inputState.versions.map((version) => ({
            id: version.id,
            source: version.source,
            value: redactManagedFileReferences(version.value),
            upstreamVersionIds: [...version.upstreamVersionIds],
            ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
            createdAt: version.createdAt,
            createdBy: version.createdBy,
            schemaVersion: version.schemaVersion,
          })),
        },
      } : {}),
      ...(node?.outputState ? {
        outputState: {
          generatedVersionId: node.outputState.generatedVersionId,
          effectiveVersionId: node.outputState.effectiveVersionId,
          stale: node.outputState.stale,
          versions: node.outputState.versions.map((version) => ({
            id: version.id,
            source: version.source,
            artifactIds: [...version.artifactIds],
            inputVersionIds: [...version.inputVersionIds],
            ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
            createdAt: version.createdAt,
            createdBy: version.createdBy,
            schemaVersion: version.schemaVersion,
            ...(version.output !== undefined ? {
              output: redactManagedFileReferences(withReviewScopeCurrent(
                id,
                version.output,
                currentOutput && version.id === node.outputState?.effectiveVersionId,
              )),
            } : {}),
          })),
        },
      } : {}),
      ...(safeExecutionReceipt ? { executionReceipt: safeExecutionReceipt } : {}),
      ...(safePlannedExecution ? {
        plannedExecution: {
          ...safePlannedExecution,
        },
      } : {}),
      ...(node?.spendPlan ? { spendPlan: { ...node.spendPlan, inputVersionIds: [...node.spendPlan.inputVersionIds] } } : {}),
      ...(node?.spendAuthorizationId ? { spendAuthorizationId: node.spendAuthorizationId } : {}),
      // C1 结构化评估原样透出（含原因/金额/缺失目标），供 C2 展示；执行侧字段不进入 UI。
      ...(node?.spendAssessment ? { spendAssessment: structuredClone(node.spendAssessment) as unknown as NonNullable<StudioRunDetail["nodes"][number]["spendAssessment"]> } : {}),
      ...nodeExecutionConfiguration(brief, id),
    };
  });
  const active = run.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
  const activeIntervention: StudioIntervention | undefined = active ? {
    id: active.id,
    nodeId: active.nodeId,
    ...(active.kind ? { kind: active.kind } : {}),
    ...(active.boundary === "node-complete" ? { boundary: "node-complete" as const } : {}),
    reason: active.reason,
    options: [...(active.options ?? [active.requiredAction])],
    createdAt: active.createdAt,
    ...(active.continuation ? { continuation: { ...active.continuation } } : {}),
  } : undefined;
  const decisions = run.decisions.map((decision): StudioDecision => ({
    id: decision.id,
    action: decision.action,
    actor: decision.actor,
    ...(decision.note ? { note: decision.note } : {}),
    createdAt: decision.createdAt,
  }));
  const videoArtifactId = effectiveNodeArtifact(run, "render", (artifact) =>
    artifact.kind === "render" && artifact.contentType === "video/mp4")?.id
    ?? legacyNodeArtifact(run, "render", (artifact) => artifact.contentType === "video/mp4")?.id;
  const publishPackageArtifactId = effectiveNodeArtifact(run, "publish-package", (artifact) =>
    artifact.kind === "publish_package")?.id
    ?? legacyNodeArtifact(run, "publish-package", (artifact) => artifact.kind === "publish_package")?.id;
  const observability = buildRunObservability({
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    now: options.now,
    nodes,
    historicalNodeDurations: options.historicalNodeDurations,
    manualReview: brief.reviewMode === "manual",
    videoAvailable: Boolean(videoArtifactId),
    publishPackageAvailable: Boolean(publishPackageArtifactId),
  });
  const continuationSupported = supportsRunContinuation(run);
  return {
    ...toRunSummary(run),
    revision: run.revision,
    angle: brief.angle,
    audience: brief.audience,
    nicheSlug: brief.nicheSlug,
    reviewMode: brief.reviewMode,
    creativeSummary: creativeSummary(brief),
    nodes,
    artifacts,
    decisions,
    ...observability,
    ...(activeIntervention ? { activeIntervention } : {}),
    ...(videoArtifactId ? { videoArtifactId } : {}),
    ...(publishPackageArtifactId ? { publishPackageArtifactId } : {}),
    ...(reworkImpact ? { reworkImpact } : {}),
    continuation: continuationSupported
      ? { supported: true }
      : legacyRunContinuation(),
  };
}

function creativeSummary(brief: ProductionBrief): NonNullable<StudioRunDetail["creativeSummary"]> {
  return {
    audience: brief.audience,
    openingPromise: brief.seriesContext?.episode.hook ?? brief.angle,
    requiredVisual: brief.visualProof ?? brief.visualIntent ?? brief.visualPlan?.strategy ?? `需要呈现的核心画面：“${brief.angle}”`,
    payoff: brief.seriesContext?.episode.payoff ?? `围绕“${brief.title}”给出明确答案或可执行判断`,
  };
}

function legacyRunContinuation(): NonNullable<StudioRunSummary["continuation"]> {
  return {
    supported: false,
    reason: "这条制作来自旧版工作流，只能查看现有结果。若要继续调整，请基于这版重新制作。",
  };
}

function supportsRunContinuation(run: WorkflowRun<ProductionBrief>): boolean {
  const brief = effectiveProductionBrief(run);
  return run.workflowId === "daily-production"
    && run.workflowVersion === productionWorkflowVersion(run.initialInput)
    && brief.workflowFeatures?.executablePlan === true
    && Boolean(brief.durationRange)
    && Boolean(brief.director);
}

function canCreateReworkFrom(run: WorkflowRun<ProductionBrief>): boolean {
  return run.status === "failed"
    || run.status === "rejected"
    || run.status === "succeeded"
    || !supportsRunContinuation(run) && run.status !== "running";
}

function nodeExecutionConfiguration(
  brief: ProductionBrief,
  nodeId: string,
): Pick<StudioNode, "executionConfiguration"> | Record<string, never> {
  // 简报节点没有可切换的执行能力：它写的字是自己写的。能调的是这一轮独立复核用哪个模型，
  // 所以这里填的是复核能力键而不是 brief.providers 里的任何一项（那张表里没有对应成员）。
  // 没有边界闸门就没有那一轮复核，此时不给出一个调不动的编辑器。
  if (nodeId === "brief") {
    if (brief.workflowFeatures?.boundaryGates !== "user-confirmed-v1") return {};
    const auditModelId = brief.models?.[BRIEF_AUDIT_PROVIDER_ID];
    return {
      executionConfiguration: {
        providerId: BRIEF_AUDIT_PROVIDER_ID,
        modelSelections: auditModelId ? { [BRIEF_AUDIT_PROVIDER_ID]: auditModelId } : {},
      },
    };
  }
  const providerField = NODE_PROVIDER_FIELDS[nodeId];
  if (!providerField || nodeId === "render" || nodeId === "technical-review") return {};
  const providerId = brief.providers[providerField];
  if (!providerId) return {};
  const relevantProviderIds = nodeId === "assets"
    ? [providerId, ...(brief.director?.assetProviderIds ?? [])]
    : nodeId === "visual-review" ? [providerId, "sound-review-v1"] : [providerId];
  const modelSelections = Object.fromEntries(relevantProviderIds.flatMap((id) => {
    const modelId = brief.models?.[id];
    return modelId ? [[id, modelId]] : [];
  }));
  return {
    executionConfiguration: {
      providerId,
      modelSelections,
      ...(nodeId === "assets" && brief.director ? { assetProviderIds: [...brief.director.assetProviderIds] } : {}),
      ...(nodeId === "assets" ? { economics: { ...brief.economics } } : {}),
    },
  };
}

function collectNodeDurationHistory(runs: WorkflowRun<ProductionBrief>[]): Record<string, number[]> {
  const durations: Record<string, number[]> = {};
  const chronological = [...runs].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  for (const run of chronological) {
    for (const node of run.nodeRuns) {
      if (!node.finishedAt || !node.startedAt || node.status !== "succeeded") continue;
      const seconds = Math.round((Date.parse(node.finishedAt) - Date.parse(node.startedAt)) / 1_000);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      const values = durations[node.nodeId] ?? [];
      values.push(seconds);
      durations[node.nodeId] = values.slice(-20);
    }
  }
  return durations;
}

function reworkFindings(run: StudioRunDetail): StudioReworkFinding[] {
  const reports = ["visual-review", "asset-source-review", "assets"].flatMap((nodeId) => {
    const node = run.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.status === "stale" || node.outputState?.stale === true) return [];
    const versionId = node?.outputState?.effectiveVersionId ?? "legacy-output";
    const effectiveOutput = node?.outputState?.versions.find(
      (version) => version.id === node.outputState?.effectiveVersionId,
    )?.output ?? node?.output;
    if (!isRecord(effectiveOutput)) return [];
    const report = nodeId === "assets"
      ? effectiveOutput.sourceVisualReview
      : isRecord(effectiveOutput.report) ? effectiveOutput.report : effectiveOutput;
    return isRecord(report) && Array.isArray(report.findings)
      ? [{ nodeId, versionId, report, findings: report.findings }]
      : [];
  });
  return reports.flatMap(({ nodeId, versionId, report, findings }) => findings.flatMap((value, findingIndex): StudioReworkFinding[] => {
    if (!isRecord(value) || !Number.isInteger(value.timecodeMs) || Number(value.timecodeMs) < 0) return [];
    // 只有当前证据合同完整的 finding 才能指导新执行。历史 finding 继续随旧报告只读展示，
    // 不能靠推断缺失字段获得返工权限。
    const evidenceStatus = isVisualReviewEvidenceStatus(value.evidenceStatus) ? value.evidenceStatus : undefined;
    const claimType = isVisualReviewClaimType(value.claimType) ? value.claimType : undefined;
    const nextAction = isVisualReviewNextAction(value.nextAction) ? value.nextAction : undefined;
    const startTimecodeMs = Number(value.startTimecodeMs);
    const endTimecodeMs = Number(value.endTimecodeMs);
    const hasCurrentEvidenceContract = evidenceStatus !== undefined
      && nextAction !== undefined
      && Number.isInteger(startTimecodeMs) && startTimecodeMs >= 0
      && Number.isInteger(endTimecodeMs) && endTimecodeMs >= startTimecodeMs
      && (value.evidenceFrameSha256 === null
        || typeof value.evidenceFrameSha256 === "string" && /^[a-f0-9]{64}$/.test(value.evidenceFrameSha256));
    if (!hasCurrentEvidenceContract) return [];
    if (evidenceStatus !== "failed" && evidenceStatus !== "not_observed") return [];
    if (evidenceStatus === "not_observed" && (value.severity !== "info" || nextAction !== "inspect_existing_media")) return [];
    if (evidenceStatus === "failed" && value.severity === "info") return [];
    const description = typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : "审片在此处发现需要修改的视觉问题。";
    const suggestion = typeof value.suggestion === "string" && value.suggestion.trim()
      ? value.suggestion.trim()
      : "重新设计该镜头并验证修改结果。";
    const category = typeof value.category === "string" && value.category.trim() ? value.category.trim() : "other";
    const scenePosition = Number(value.scenePosition);
    const planningStageId = isPlanningStageId(value.planningStageId) ? value.planningStageId : undefined;
    const explicitTargets = Array.isArray(value.targetNodeIds)
      ? [...new Set(value.targetNodeIds.filter(isReworkTargetNodeId))]
      : reworkRoutingTargetsForReview(value.targetNodeId, planningStageId);
    const inferredScriptOwner = /叙事|旁白|文案|narrative|script|voice/i.test(`${category} ${description} ${suggestion}`);
    const primaryOwnerNodeId: StudioReworkFinding["targetNodeIds"][number] = explicitTargets[0]
      ?? (inferredScriptOwner ? "script" : "visual-direction");
    const affectedNodeIds = affectedReworkNodes({
      primaryOwnerNodeId,
      explicitTargets,
      ...(nextAction ? { nextAction } : {}),
      category,
      description,
      suggestion,
    });
    const action: NonNullable<StudioReworkFinding["action"]> = nextAction === "inspect_existing_media"
      ? "inspect_existing_media"
      : nextAction === "replan_upstream" || primaryOwnerNodeId !== "assets"
        ? "replan_upstream"
        : "replace_asset";
    const targetNodeIds: StudioReworkFinding["targetNodeIds"] = affectedNodeIds;
    const scope = isRecord(report.reviewScope) ? report.reviewScope : undefined;
    const sourceReviewStage = scope?.reviewStage === "rendered_video" || scope?.reviewStage === "source_assets"
      ? scope.reviewStage
      : nodeId === "visual-review" ? "rendered_video" : "source_assets";
    const evidenceFrameSha256 = value.evidenceFrameSha256 === null
      ? null
      : typeof value.evidenceFrameSha256 === "string" && /^[a-f0-9]{64}$/.test(value.evidenceFrameSha256)
        ? value.evidenceFrameSha256
        : undefined;
    const actualModels = Array.isArray(scope?.actualModels)
      ? scope.actualModels.flatMap((model): Array<{ providerId: string; modelId: string }> => (
          isRecord(model)
          && typeof model.providerId === "string" && model.providerId.trim()
          && typeof model.modelId === "string" && model.modelId.trim()
            ? [{ providerId: model.providerId.trim(), modelId: model.modelId.trim() }]
            : []
        ))
      : [];
    const normalizedFinding: Omit<StudioReworkFinding, "findingId"> = {
      timecodeMs: Number(value.timecodeMs),
      ...(Number.isInteger(startTimecodeMs) && startTimecodeMs >= 0 ? { startTimecodeMs } : {}),
      ...(Number.isInteger(endTimecodeMs) && endTimecodeMs >= 0 ? { endTimecodeMs } : {}),
      ...(Number.isInteger(scenePosition) && scenePosition > 0 ? { scenePosition } : {}),
      ...(claimType ? { claimType } : {}),
      ...(evidenceStatus ? { evidenceStatus } : {}),
      ...(evidenceFrameSha256 !== undefined ? { evidenceFrameSha256 } : {}),
      ...(nextAction ? { nextAction } : {}),
      category,
      description,
      suggestion,
      targetNodeIds,
      primaryOwnerNodeId,
      affectedNodeIds,
      action,
      ...(planningStageId ? { planningStageId } : {}),
      sourceReviewStage,
      sourceReviewNodeId: nodeId,
      sourceReviewVersionId: versionId,
      ...(typeof scope?.evidenceId === "string" && /^[a-f0-9]{64}$/.test(scope.evidenceId)
        ? { reviewEvidenceId: scope.evidenceId }
        : {}),
      ...(actualModels.length ? { actualModels } : {}),
      current: true,
    };
    const findingId = `vf_${createHash("sha256").update(JSON.stringify({
      sourceRunId: run.id,
      sourceReviewNodeId: nodeId,
      sourceReviewVersionId: versionId,
      findingIndex,
      finding: normalizedFinding,
    })).digest("hex").slice(0, 24)}`;
    return [{ findingId, ...normalizedFinding }];
  }));
}

function affectedReworkNodes(options: {
  primaryOwnerNodeId: StudioReworkFinding["targetNodeIds"][number];
  explicitTargets: StudioReworkFinding["targetNodeIds"];
  nextAction?: NonNullable<StudioReworkFinding["nextAction"]>;
  category: string;
  description: string;
  suggestion: string;
}): StudioReworkFinding["targetNodeIds"] {
  if (options.nextAction === "inspect_existing_media") return ["assets"];
  const affected = new Set<StudioReworkFinding["targetNodeIds"][number]>(options.explicitTargets);
  affected.add(options.primaryOwnerNodeId);
  if (options.primaryOwnerNodeId === "script") {
    affected.add("visual-direction");
    affected.add("assets");
  } else if (options.primaryOwnerNodeId === "visual-direction") {
    affected.add("assets");
  }
  const visualPlanningIssue = /composition|continuity|pacing|构图|连续|节奏|调度|机位|光线|灯光/i.test(
    `${options.category} ${options.description} ${options.suggestion}`,
  );
  if (options.nextAction === "replan_upstream" || options.primaryOwnerNodeId === "assets" && visualPlanningIssue) {
    affected.add("visual-direction");
    affected.add("assets");
  }
  return (["script", "visual-direction", "assets"] as const).filter((nodeId) => affected.has(nodeId));
}

function isReworkTargetNodeId(value: unknown): value is StudioReworkFinding["targetNodeIds"][number] {
  return value === "script" || value === "visual-direction" || value === "assets";
}

function isPlanningStageId(value: unknown): value is NonNullable<StudioReworkFinding["planningStageId"]> {
  return value === "treatment" || value === "script" || value === "director";
}

/**
 * 审片意见指名的节点 → 返工上下文实际组织指令用的三个切片。
 *
 * 意见指名的是真实节点（creative-planning / assets）与真实段落（treatment / script / director），
 * 而 nodeInstructions 仍按 script / visual-direction / assets 三段分发。映射是收窄且单向的：
 * 段落决定重做哪一段，切片只决定把指令交给谁——treatment 与 script 都落进 script 切片，
 * 所以这里没有引入任何新的重做范围，只是把意见说的话原样转达。
 *
 * 旧合同产出的报告只给两段式取值，语义与之一一对应：script → script，visual-direction → director。
 * 认不出的取值返回空，交给下面的启发式兜底——与这个函数原本对未知取值的行为一致。
 */
function reworkRoutingTargetsForReview(
  targetNodeId: unknown,
  planningStageId: unknown,
): StudioReworkFinding["targetNodeIds"] {
  if (targetNodeId === "assets") return ["assets"];
  if (targetNodeId === "script") return ["script"];
  if (targetNodeId === "visual-direction") return ["visual-direction"];
  if (targetNodeId === "creative-planning") {
    if (!isPlanningStageId(planningStageId)) return [];
    return planningStageId === "director" ? ["visual-direction"] : ["script"];
  }
  return [];
}

function isVisualReviewEvidenceStatus(value: unknown): value is NonNullable<StudioReworkFinding["evidenceStatus"]> {
  return value === "satisfied" || value === "failed" || value === "not_observed" || value === "not_applicable";
}

function isVisualReviewClaimType(value: unknown): value is NonNullable<StudioReworkFinding["claimType"]> {
  return value === "static" || value === "motion" || value === "non_visual";
}

function isVisualReviewNextAction(value: unknown): value is NonNullable<StudioReworkFinding["nextAction"]> {
  return value === "inspect_existing_media" || value === "replan_upstream" || value === "rework_asset" || value === "none";
}

function resourceReworkFindings(runId: string, resources: RejectedVisualResource[]): StudioReworkFinding[] {
  return resources.map((resource): StudioReworkFinding => {
    const normalizedFinding = {
      timecodeMs: resource.scenePosition ? Math.max(0, (resource.scenePosition - 1) * 4_000) : 0,
      ...(resource.scenePosition ? { scenePosition: resource.scenePosition } : {}),
      category: "resource_rights",
      description: `素材“${resource.label}”未通过授权审核。`,
      suggestion: `${resource.note}；替换为授权明确的素材并重新核验。`,
      targetNodeIds: ["assets"] as StudioReworkFinding["targetNodeIds"],
      primaryOwnerNodeId: "assets" as const,
      affectedNodeIds: ["assets"] as StudioReworkFinding["targetNodeIds"],
      action: "replace_asset" as const,
      sourceReviewStage: "source_assets" as const,
      sourceReviewNodeId: "resource-governance",
      sourceReviewVersionId: "current",
      current: true,
    };
    const findingId = `vf_${createHash("sha256").update(JSON.stringify({
      sourceRunId: runId,
      resourceItemId: resource.itemId,
      providerId: resource.providerId,
      finding: normalizedFinding,
    })).digest("hex").slice(0, 24)}`;
    return { findingId, ...normalizedFinding };
  });
}

function verifiedReworkScenePositions(previousScript: unknown, previousDirectorPlan: unknown): number[] | undefined {
  const fromDocument = (document: unknown, listKey: string, positionKey: string): number[] | undefined => {
    if (!isRecord(document) || !Array.isArray(document[listKey])) return undefined;
    const positions = document[listKey].map((entry) => isRecord(entry) ? Number(entry[positionKey]) : Number.NaN);
    const sorted = [...positions].sort((left, right) => left - right);
    return sorted.length > 0 && sorted.every((position, index) => Number.isInteger(position) && position === index + 1)
      ? sorted
      : undefined;
  };
  const scriptPositions = fromDocument(previousScript, "scenes", "position");
  const directorPositions = fromDocument(previousDirectorPlan, "shots", "scenePosition");
  if (scriptPositions && directorPositions) {
    return isDeepStrictEqual(scriptPositions, directorPositions) ? scriptPositions : undefined;
  }
  return scriptPositions ?? directorPositions;
}

function verifiedGenerationScenePositions(previousDirectorPlan: unknown): number[] | undefined {
  if (!isRecord(previousDirectorPlan) || !Array.isArray(previousDirectorPlan.shots)) return undefined;
  const deliveryTypes = new Set([
    "editorial_card",
    "stock_video",
    "stock_image",
    "generated_image",
    "generated_video",
  ]);
  const positions: number[] = [];
  for (const shot of previousDirectorPlan.shots) {
    if (!isRecord(shot) || typeof shot.deliveryType !== "string" || !deliveryTypes.has(shot.deliveryType)) {
      return undefined;
    }
    const position = Number(shot.scenePosition);
    if (!Number.isInteger(position) || position < 1) return undefined;
    if (shot.deliveryType === "generated_image" || shot.deliveryType === "generated_video") {
      positions.push(position);
    }
  }
  return positions;
}

function recommendedReworkScenePositions(options: {
  findings: StudioReworkFinding[];
  unmaterializedAssetScenePositions: number[];
  previousScript: unknown;
  previousDirectorPlan: unknown;
  manualRejectionReason?: string;
}): number[] {
  const universe = verifiedReworkScenePositions(options.previousScript, options.previousDirectorPlan);
  const affected = new Set(options.unmaterializedAssetScenePositions);
  for (const finding of options.findings) {
    if (finding.action === "inspect_existing_media") continue;
    const targetsVisualWork = finding.targetNodeIds.some((nodeId) => nodeId === "visual-direction" || nodeId === "assets");
    const targetsLocatedScriptWork = finding.targetNodeIds.includes("script") && finding.scenePosition !== undefined;
    if (!targetsVisualWork && !targetsLocatedScriptWork) continue;
    if (finding.scenePosition === undefined || universe && !universe.includes(finding.scenePosition)) {
      // 无法定位的问题必须由用户明确选择范围；不能把不确定性解释为全片返工许可。
      continue;
    } else {
      affected.add(finding.scenePosition);
    }
  }
  if (options.manualRejectionReason) {
    // 用户显式说出"整体/全部"是对全片范围的明确选择——这不是"找不到范围就默认全片"。
    if (holisticReworkIntent(options.manualRejectionReason)) {
      for (const position of universe ?? []) affected.add(position);
    }
    const mentionedPositions = reworkScenePositionsFromText(options.manualRejectionReason)
      .filter((position) => !universe || universe.includes(position));
    if (mentionedPositions.length > 0) {
      for (const position of mentionedPositions) affected.add(position);
    }
  }
  return reworkSceneDependencyClosure(
    [...affected],
    isRecord(options.previousDirectorPlan) ? options.previousDirectorPlan.shots : undefined,
  ).filter((position) => !universe || universe.includes(position));
}

// 用户拒绝说明中的全片意图表述：与"无法定位"严格区分——前者是明确的范围选择。
function verifiedReworkUniverseOrEmpty(previousScript: unknown, previousDirectorPlan: unknown): number[] {
  return verifiedReworkScenePositions(previousScript, previousDirectorPlan) ?? [];
}

function holisticReworkIntent(note: string): boolean {
  // 否定式（"不要全部""不必整体"）不算全片意图。
  const negated = /(不要|不必|无需|不能|别)\s*(把|将)?\s*(整体|全部|整个|所有)/.test(note);
  return !negated && /整体|全部|整个|所有(镜头|画面|内容)|每(个|一)(镜头|镜)/.test(note);
}

// note-only：有拒绝说明、但既非全片意图、也没有可解析镜头、且 findings 未定位到任何镜头
// ——范围待定。草稿仍打开让用户选择，但不能以空范围静默开跑。
function reworkScopeUnresolved(options: {
  findings: StudioReworkFinding[];
  unmaterializedAssetScenePositions: number[];
  previousScript: unknown;
  previousDirectorPlan: unknown;
  manualRejectionReason?: string;
  recommended: number[];
}): boolean {
  if (!options.manualRejectionReason) return false;
  if (holisticReworkIntent(options.manualRejectionReason)) return false;
  if (reworkScenePositionsFromText(options.manualRejectionReason).length > 0) return false;
  if (options.recommended.length > 0) return false;
  const universe = verifiedReworkScenePositions(options.previousScript, options.previousDirectorPlan) ?? [];
  return universe.length > 0;
}

function latestManualRejectionReason(run: WorkflowRun<ProductionBrief>): string | undefined {
  const note = [...run.decisions].reverse().find((decision) => decision.action === "reject")?.note;
  return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

function reworkScenePositionsFromText(value: string): number[] {
  const positions = new Set<number>();
  const numberList = String.raw`(\d+(?:\s*[\u3001,，/和及与]\s*\d+)*)`;
  const patterns = [
    new RegExp(String.raw`第\s*${numberList}\s*(?:镜头|镜)`, "g"),
    new RegExp(String.raw`(?:镜头|镜)\s*${numberList}`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      for (const raw of (match[1] ?? "").split(/\s*[\u3001,，/和及与]\s*/)) {
        const position = Number(raw);
        if (Number.isInteger(position) && position > 0) positions.add(position);
      }
    }
  }
  return [...positions].sort((left, right) => left - right);
}

/**
 * 创作规划三段的说法。审片意见与人工回退（return_to_stage）共用同一套 ID，
 * 这里只负责把它翻成生产者看得懂的中文：说要重做哪一段，不说"方案有问题"。
 */
const REWORK_PLANNING_STAGE_LABELS = {
  treatment: "方案 · 承诺与方向段",
  script: "方案 · 事实与论证段",
  director: "方案 · 分镜与可执行性段",
} as const;

function buildReworkNodeInstructions(
  findings: StudioReworkFinding[],
  rejectionReason?: string,
  affectedScenePositions: number[] = [],
): { script: string; visualDirection: string; assets: string } {
  const rejection = rejectionReason ? `本次重做原因：${rejectionReason.trim()}\n` : "";
  const contentSafetyFailure = /内容安全|敏感|sensitive information/i.test(rejectionReason ?? "");
  const linesFor = (nodeId: StudioReworkFinding["targetNodeIds"][number]) => findings
    .filter((finding) => finding.targetNodeIds.includes(nodeId))
    .map((finding) => {
      const location = finding.scenePosition
        ? finding.category === "resource_rights"
          ? `镜头 ${finding.scenePosition}`
          : `镜头 ${finding.scenePosition} · ${formatReworkTimecode(finding.timecodeMs)}`
        : formatReworkTimecode(finding.timecodeMs);
      // 审片意见指名了要重做哪一段，就把它带到指令里：模型只知道"方案有问题"时会从最上游
      // 重做，把没被点名的段落一起推翻，代价是整轮素材白买。
      const stage = finding.planningStageId ? `${REWORK_PLANNING_STAGE_LABELS[finding.planningStageId]} · ` : "";
      const action = nodeId === "assets"
        ? finding.action === "inspect_existing_media"
          ? "先补查已有素材，不进入新购买"
          : finding.action === "replan_upstream"
            ? "等待上游方案确认后再判断沿用或新生成"
            : "替换素材并重新审查"
        : finding.action === "inspect_existing_media"
          ? "核对已有证据后再决定是否修改"
          : "按建议修改方案";
      return `- ${stage}${location}：${finding.description}；下一步：${action}；建议：${finding.suggestion}`;
    });
  const scriptLines = linesFor("script");
  const visualLines = linesFor("visual-direction");
  const assetLines = linesFor("assets");
  const failedAssetInstruction = affectedScenePositions.length
    ? `- 镜头 ${affectedScenePositions.join("、")} 属于本轮影响范围；先执行补查或方案修改，只有确认需要新画面时才进入报价。其余镜头沿用已有素材。`
    : "- 先核对本次原因涉及的已有素材；只有确认需要新画面时才进入报价，其余镜头继续沿用。";
  if (contentSafetyFailure && findings.length === 0) {
    return {
      script: `${rejection}以上一版脚本为底稿，保留旁白、事实和叙事结构；只把 visual_prompt 与 search_terms 中可能产生歧义的说法改成中性、具体、可见的物体和动作描述，不改写无关内容。`.trim(),
      visualDirection: `${rejection}以上一版导演方案为底稿，保留全片视觉规则、构图和连续性；定位被拒绝镜头，只重写送给图片或视频模型的主体、环境、动作、生成提示和验收条件。使用中性、具体的物体描述，不得写入 Provider 名称、AIGC 标识、披露、费用、授权或工作流术语。`.trim(),
      assets: `${rejection}严格执行修订后的逐镜路由；提交前检查最终生成提示只包含画面内容。复用镜头继续使用同一母片，不重新生成或计费；再次被拒绝时立即停住，不得用说明卡或无关素材替代。`.trim(),
    };
  }
  return {
    // BG-06：仅修 media/director 的返工（无脚本定位问题、非全片意图）不给编剧生成默认
    // 指令——空指令让跨 run seed 得以继承编剧阶段，不重跑无关 producer。
    script: scriptLines.length === 0 && !holisticReworkIntent(rejectionReason ?? "")
      ? ""
      : `${rejection}以上一版脚本为底稿，保留未被要求修改的叙事与事实，只修改下列内容：\n${scriptLines.join("\n") || "- 当前没有定位到脚本文字问题；只根据本次重做原因做必要修改，不重写无关段落。"}`.trim(),
    visualDirection: `${rejection}以上一版导演方案为底稿，保留未被要求修改的全片视觉规则与镜头，只重做下列问题：\n${visualLines.join("\n") || (findings.length > 0 ? "- 本轮结构化问题未直接指向导演方案；仍按本次重做原因复核并改写受影响镜头。" : "- 当前没有结构化视觉问题；依据本次重做原因定位并改写受影响镜头。")}`.trim(),
    assets: `${rejection}严格执行修订后的逐镜路由；保留未受影响母片，不得用说明卡、无关图库素材或内部术语掩盖失败：\n${assetLines.join("\n") || failedAssetInstruction}`.trim(),
  };
}

function formatReworkTimecode(timecodeMs: number): string {
  const seconds = Math.floor(timecodeMs / 1_000);
  const milliseconds = timecodeMs % 1_000;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function effectiveNodeArtifact(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
  matches: (artifact: WorkflowRun<ProductionBrief>["artifacts"][number]) => boolean,
): WorkflowRun<ProductionBrief>["artifacts"][number] | undefined {
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
  if (node?.status === "stale" || node?.outputState?.stale === true) return undefined;
  const effectiveVersion = node?.outputState?.versions.find(
    (version) => version.id === node.outputState?.effectiveVersionId,
  );
  const artifactIds = effectiveVersion?.artifactIds ?? node?.artifactIds ?? [];
  for (const artifactId of [...artifactIds].reverse()) {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact && matches(artifact)) return artifact;
  }
  return undefined;
}

function legacyNodeArtifact(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
  matches: (artifact: WorkflowRun<ProductionBrief>["artifacts"][number]) => boolean,
): WorkflowRun<ProductionBrief>["artifacts"][number] | undefined {
  if (run.status === "stale" || run.nodeRuns.some((node) => node.nodeId === nodeId)) return undefined;
  return [...run.artifacts].reverse().find((artifact) => artifact.producer?.nodeId === nodeId && matches(artifact));
}

function parseBriefWithInputError(value: unknown): ProductionBrief {
  try {
    return parseBrief(value);
  } catch (error) {
    throw new StudioInputError(productionInputMessage(error));
  }
}

function assertExecutableRunContinuation(run: WorkflowRun<ProductionBrief>): void {
  if (!supportsRunContinuation(run)) {
    throw new StudioConflictError("这条历史制作没有可执行制作方案，不能继续旧流程；请从当前记录创建新版本后再制作。");
  }
}

function productionInputMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("budgetIntentionCny")) return "预算意向请输入 0 到 100000 元的有效金额，或留空；这不是付款授权。";
  if (message.includes("voiceDirection.profileId") && message.includes("providers.voice")) {
    return "所选音色与配音能力不一致，请重新选择音色。";
  }
  if (message.includes("durationSeconds")) return "成片时长必须是 20 到 180 秒之间的整数。";
  if (message.includes("platform must be one of")) return "目标平台只支持抖音、小红书或哔哩哔哩，请重新选择。";
  if (message.includes("reviewMode")) return "人工终审设置无效。";
  if (message.includes("protocolVersion")) return "制作参数版本不受支持，请刷新页面后重试。";
  if (/\b(title|angle|audience|nicheSlug|platform)\b/.test(message)) return "请完整填写标题、内容角度、目标受众、系列标识和平台。";
  if (message.includes("providers")) return "制作能力配置不完整，请重新选择制作配方。";
  if (message.includes("economics")) return "付费能力设置不符合要求。";
  if (message.includes("voiceDirection")) return "配音设置不符合要求，请重新选择音色。";
  return "制作参数不符合要求，请检查后重试。";
}

const NODE_PROVIDER_FIELDS: Partial<Record<string, keyof ProductionBrief["providers"]>> = {
  script: "script",
  "visual-direction": "director",
  // joint-v1 规划节点的执行能力挂在编剧能力上；阶段级模型键由 planningStageId 路由。
  "creative-planning": "script",
  assets: "assets",
  "asset-source-review": "visualReview",
  voice: "voice",
  render: "render",
  "technical-review": "technicalReview",
  "visual-review": "visualReview",
};

// planningStageId 只属于 creative-planning，且只允许白名单阶段：直连服务调用与 HTTP parser
// 同一校验（服务层不信任调用方已过 parser）。
function assertPlanningStageScope(
  nodeId: string,
  planningStageId: StudioPlanningEditableStage | undefined,
  actionLabel: string,
): void {
  if (planningStageId === undefined) return;
  if (!(STUDIO_PLANNING_EDITABLE_STAGES as readonly string[]).includes(String(planningStageId))) {
    throw new StudioInputError("创作规划的 planningStageId 只能是 treatment、script 或 director。");
  }
  if (nodeId !== "creative-planning") {
    throw new StudioInputError(`只有创作规划节点可以携带阶段编号；“${nodeId}”的${actionLabel}修改不接受 planningStageId。`);
  }
}

// 阶段级模型键白名单：script 阶段只能改编剧能力模型，director 阶段只能改导演能力模型，
// treatment 阶段只能改前期构思能力模型；阶段未声明时沿用节点整体（编剧）合同。
function assertPlanningStageModelScope(
  nodeId: string,
  input: StudioNodeExecutionConfigurationInput,
  brief: ProductionBrief,
): void {
  if (nodeId !== "creative-planning") return;
  const allowedKeys = new Set<string>();
  allowedKeys.add(brief.providers.script);
  if (brief.providers.director) allowedKeys.add(brief.providers.director);
  allowedKeys.add(CREATIVE_TREATMENT_PROVIDER_ID);
  if (input.planningStageId === undefined) {
    // 未声明阶段的整体修改沿用节点合同（编剧/导演/构思三个键都在节点能力范围内）。
  } else if (input.planningStageId === "script") {
    allowedKeys.clear();
    allowedKeys.add(brief.providers.script);
  } else if (input.planningStageId === "director") {
    allowedKeys.clear();
    if (brief.providers.director) allowedKeys.add(brief.providers.director);
  } else {
    allowedKeys.clear();
    allowedKeys.add(CREATIVE_TREATMENT_PROVIDER_ID);
  }
  if (input.providerId !== undefined && input.planningStageId !== undefined && input.planningStageId !== "script") {
    throw new StudioInputError("只有创作规划的编剧阶段可以切换执行能力；构思和导演阶段只调整模型。");
  }
  for (const providerId of Object.keys(input.modelSelections ?? {})) {
    if (!allowedKeys.has(providerId)) {
      throw new StudioInputError(
        `这次修改针对创作规划的“${
          input.planningStageId === "treatment" ? "前期构思" : input.planningStageId === "director" ? "导演" : "编剧"
        }”阶段，不能调整其他能力的模型。`,
      );
    }
  }
}

function sameProviderIdSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const leftIds = new Set(left ?? []);
  const rightIds = new Set(right ?? []);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function videoModelContractChanged(
  previous: ProductionBrief,
  next: ProductionBrief,
  providers: readonly StudioProvider[],
): boolean {
  const providerIds = next.director?.assetProviderIds ?? [];
  return providerIds.some((providerId) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider?.deliveryTypes?.includes("generated_video")) return false;
    const previousModelId = previous.models?.[providerId] ?? provider.defaultModelId;
    const nextModelId = next.models?.[providerId] ?? provider.defaultModelId;
    if (previousModelId === nextModelId) return false;
    return videoModelContract(provider, previousModelId) !== videoModelContract(provider, nextModelId);
  });
}

function videoModelContract(provider: StudioProvider, modelId: string | undefined): string {
  const profile = provider.modelProfiles?.find((candidate) => candidate.id === modelId);
  if (!profile) return "unknown";
  return JSON.stringify({
    taskTypes: [...profile.taskTypes].sort(),
    aspectRatios: [...(profile.aspectRatios ?? [])].sort(),
    minDurationSeconds: profile.minDurationSeconds ?? null,
    maxDurationSeconds: profile.maxDurationSeconds ?? null,
  });
}

function applyNodeExecutionConfiguration(
  brief: ProductionBrief,
  nodeId: string,
  input: StudioNodeExecutionConfigurationInput,
): ProductionBrief {
  if (nodeId === "brief") return applyBriefAuditConfiguration(brief, input);
  const providerField = NODE_PROVIDER_FIELDS[nodeId];
  if (!providerField) throw new StudioInputError(`“${nodeId}”没有可切换的模型或执行能力。`);
  if (nodeId !== "assets" && (input.assetProviderIds || input.economics)) {
    throw new StudioInputError("素材来源和付费能力设置只能在素材导演节点修改。");
  }
  if (nodeId === "assets" && input.providerId && input.providerId !== "ai-shot-router-v1") {
    throw new StudioInputError("素材导演保持使用 AI 逐镜路由；请在下方选择火山、MiniMax、百炼等具体生成来源和模型。");
  }

  const previousProviderId = brief.providers[providerField];
  const providers = { ...brief.providers };
  if (input.providerId) providers[providerField] = input.providerId;
  const director = input.assetProviderIds
    ? brief.director
      ? { ...brief.director, assetProviderIds: [...input.assetProviderIds] }
      : undefined
    : brief.director;
  if (input.assetProviderIds && !director) throw new StudioInputError("当前制作没有启用导演素材池，不能修改逐镜来源。");

  const models = { ...(brief.models ?? {}) };
  const modelSelectionSources = { ...(brief.modelSelectionSources ?? {}) };
  for (const [providerId, modelId] of Object.entries(input.modelSelections ?? {})) {
    if (modelId === null) {
      const frozen = brief.frozenModelSelections?.[providerId];
      if (frozen) {
        models[providerId] = frozen.modelId;
        modelSelectionSources[providerId] = frozen.source;
      } else {
        delete models[providerId];
        delete modelSelectionSources[providerId];
      }
    } else {
      models[providerId] = modelId;
      modelSelectionSources[providerId] = "node_override";
    }
  }
  const selectedProviderIds = new Set([
    ...Object.values(providers).filter((value): value is string => typeof value === "string"),
    ...(director?.assetProviderIds ?? []),
  ]);
  const previouslySelectedProviderIds = new Set([
    ...(previousProviderId ? [previousProviderId] : []),
    ...(brief.director?.assetProviderIds ?? []),
  ]);
  for (const providerId of previouslySelectedProviderIds) {
    if (selectedProviderIds.has(providerId)) continue;
    delete models[providerId];
    delete modelSelectionSources[providerId];
  }

  const economics = input.economics
    ? { recipeId: "custom" as const, ...input.economics }
    : brief.economics;
  return parseBrief({
    ...brief,
    providers,
    ...(Object.keys(models).length ? { models, modelSelectionSources } : { models: undefined, modelSelectionSources: undefined }),
    ...(director ? { director } : {}),
    economics,
  });
}

// 简报节点唯一能调的是这一轮独立复核用哪个模型——简报的字是人写的，没有可切换的执行能力。
// 刻意不走上面那段通用收尾：它按"这份简报启用了哪些能力"清掉不再启用的模型键，而复核能力键
// 不在 brief.providers 里，走通用逻辑等于每次保存都把刚选下的复核模型删掉。
function applyBriefAuditConfiguration(
  brief: ProductionBrief,
  input: StudioNodeExecutionConfigurationInput,
): ProductionBrief {
  if (input.assetProviderIds || input.economics) {
    throw new StudioInputError("素材来源和付费能力设置只能在素材导演节点修改。");
  }
  if (brief.workflowFeatures?.boundaryGates !== "user-confirmed-v1") {
    throw new StudioInputError("这条制作没有在每个节点边界停下，简报不跑独立复核，没有可调整的模型。");
  }
  // 复核能力是固定的：换 provider 等于换一项服务，不是这个编辑器能决定的事。
  if (input.providerId !== undefined && input.providerId !== BRIEF_AUDIT_PROVIDER_ID) {
    throw new StudioInputError("简报节点的独立复核能力不可切换；这里只能选它用哪个模型。");
  }
  const models = { ...(brief.models ?? {}) };
  const modelSelectionSources = { ...(brief.modelSelectionSources ?? {}) };
  for (const [providerId, modelId] of Object.entries(input.modelSelections ?? {})) {
    if (providerId !== BRIEF_AUDIT_PROVIDER_ID) {
      throw new StudioInputError("简报节点只能调整独立复核的模型。");
    }
    // 空字符串是界面上的"使用推荐"：与 null 同义，删掉这条选择，而不是记下一个空模型名。
    if (!modelId?.trim()) {
      const frozen = brief.frozenModelSelections?.[providerId];
      if (frozen) {
        models[providerId] = frozen.modelId;
        modelSelectionSources[providerId] = frozen.source;
      } else {
        delete models[providerId];
        delete modelSelectionSources[providerId];
      }
    } else {
      models[providerId] = modelId;
      modelSelectionSources[providerId] = "node_override";
    }
  }
  return parseBrief({
    ...brief,
    ...(Object.keys(models).length ? { models, modelSelectionSources } : { models: undefined, modelSelectionSources: undefined }),
  });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isTerminalRun(status: WorkflowRun<ProductionBrief>["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}

function isPrivateArtifactKind(kind: string): boolean {
  return kind === "reference_video" || kind === "candidate_inventory_private" || kind === "generation_jobs";
}

function redactManagedFileReferences(value: unknown): unknown {
  if (typeof value === "string") {
    return redactManagedPathText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactManagedFileReferences(item));
  if (!isRecord(value)) return structuredClone(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactManagedFileReferences(item)]),
  );
}

function withReviewScopeCurrent(nodeId: string, value: unknown, current: boolean): unknown {
  if (!["assets", "asset-source-review", "visual-review"].includes(nodeId) || !isRecord(value)) return value;
  const reportKey = nodeId === "assets" ? "sourceVisualReview" : "report";
  const report = value[reportKey];
  if (!isRecord(report)) return value;
  return {
    ...value,
    [reportKey]: {
      ...report,
      ...(isRecord(report.reviewScope) ? { reviewScope: { ...report.reviewScope, current } } : {}),
      // 逐条表态要能指回具体某一条结论。条目编号由服务端按内容算，界面原样回传；
      // 用下标或让界面自己算，报告条目顺序一变表态就会落到别的条目上。
      ...(Array.isArray(report.findings)
        ? {
            findings: report.findings.map((finding) => (
              isRecord(finding) ? { ...finding, itemKey: visualReviewFindingKey(finding as unknown as VisualReviewFinding) } : finding
            )),
          }
        : {}),
    },
  };
}

// 当前生效 executable plan 的内容 digest（制作范围授权的方案锚）。从报价等待节点或
// assets 节点的有效输入读取；不落盘、不重算规划。
async function currentExecutablePlanDigest(
  run: WorkflowRun<ProductionBrief>,
  workspaceRoot: string,
): Promise<string | undefined> {
  const candidates = ["assets", "creative-planning", "production-preflight"];
  for (const nodeId of candidates) {
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    const state = node?.inputState;
    if (!state || state.stale) continue;
    const effective = state.versions.find((version) => version.id === state.effectiveVersionId)?.value;
    if (!isRecord(effective) || typeof effective.executablePlanPath !== "string") continue;
    try {
      const runRoot = path.join(workspaceRoot, "runs", run.id);
      await assertContainedFile(runRoot, effective.executablePlanPath);
      return createHash("sha256").update(await readFile(effective.executablePlanPath)).digest("hex");
    } catch {
      continue;
    }
  }
  return undefined;
}

function redactManagedPathText(value: string): string {
  if (isAbsoluteFilePath(value)) return MANAGED_FILE_PLACEHOLDER;
  return value
    .replace(
      /(^|[\s"'`(=])\/(?:Users|home|var|tmp|private|opt|srv|etc|run|root|mnt|Volumes)(?:\/[^\s"'`<>),;\]}]+)+/g,
      `$1${MANAGED_FILE_PLACEHOLDER}`,
    )
    .replace(/(^|[\s"'`(=])[A-Za-z]:\\[^\s"'`<>),;\]}]+/g, `$1${MANAGED_FILE_PLACEHOLDER}`);
}

/**
 * 审计意见的逐条文本。上限 12 条与审计侧一致；三段（哪条不达标/凭什么/建议怎么改）
 * 缺任何一段就整条丢掉——半截意见会让用户以为"这条没什么可改的"，比不显示更误导。
 * 存储里可能是任意历史形状，所以逐字段判型。
 */
function auditIssueTexts(value: unknown): StudioAgentLoopAuditIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: StudioAgentLoopAuditIssue[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const severity = entry.severity === "blocking" ? "blocking" : entry.severity === "advisory" ? "advisory" : undefined;
    const criterion = typeof entry.criterion === "string" ? redactManagedPathText(entry.criterion) : "";
    const evidence = typeof entry.evidence === "string" ? redactManagedPathText(entry.evidence) : "";
    const repairInstruction = typeof entry.repairInstruction === "string" ? redactManagedPathText(entry.repairInstruction) : "";
    if (!severity || !criterion || !evidence || !repairInstruction) continue;
    issues.push({ severity, criterion, evidence, repairInstruction });
    if (issues.length === 12) break;
  }
  return issues;
}

function restoreManagedFileReferences(value: unknown, reference: unknown): unknown {
  if (value === MANAGED_FILE_PLACEHOLDER) {
    return typeof reference === "string" && isAbsoluteFilePath(reference)
      ? reference
      : value;
  }
  if (Array.isArray(value)) {
    const referenceItems = Array.isArray(reference) ? reference : [];
    return value.map((item, index) => restoreManagedFileReferences(item, referenceItems[index]));
  }
  if (!isRecord(value)) return structuredClone(value);
  const referenceRecord = isRecord(reference) ? reference : {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, restoreManagedFileReferences(item, referenceRecord[key])]),
  );
}

function isAbsoluteFilePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

async function assertContainedFile(runRoot: string, candidate: string): Promise<void> {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(runRoot), realpath(candidate)]);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioInputError("所选产物不属于当前制作目录。");
  }
  if (!(await stat(resolvedCandidate)).isFile()) throw new StudioInputError("所选产物不是可编辑文件。");
}

function editablePublishPackageDocument(reference: unknown, requested: unknown): unknown {
  if (!isRecord(reference) || !isRecord(requested) || !isRecord(reference.copy) || !isRecord(requested.copy)) {
    throw new StudioInputError("发布文案必须包含完整的标题、描述和话题标签。");
  }
  const protectedReference = structuredClone(reference);
  const protectedRequested = structuredClone(requested);
  delete protectedReference.title;
  delete protectedRequested.title;
  for (const key of ["title", "description", "hashtags"]) {
    delete (protectedReference.copy as Record<string, unknown>)[key];
    delete (protectedRequested.copy as Record<string, unknown>)[key];
  }
  if (!isDeepStrictEqual(protectedRequested, protectedReference)) {
    throw new StudioInputError("发布包的授权、产物、审批和 AI 标识由系统托管，只能修改标题、描述与话题标签。");
  }
  const title = requiredEditableText(requested.title, "发布标题", 80);
  const copyTitle = requiredEditableText(requested.copy.title, "文案标题", 80);
  const description = requiredEditableText(requested.copy.description, "发布描述", 2_000);
  if (title !== copyTitle) throw new StudioInputError("发布标题与文案标题必须保持一致。");
  if (!Array.isArray(requested.copy.hashtags) || requested.copy.hashtags.length > 12) {
    throw new StudioInputError("话题标签必须是最多 12 项的文字列表。");
  }
  const hashtags = requested.copy.hashtags.map((value, index) => requiredEditableText(value, `话题标签 ${index + 1}`, 40));
  const result = structuredClone(reference);
  result.title = title;
  (result.copy as Record<string, unknown>).title = copyTitle;
  (result.copy as Record<string, unknown>).description = description;
  (result.copy as Record<string, unknown>).hashtags = hashtags;
  return result;
}

function requiredEditableText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new StudioInputError(`${label}必须是 1 到 ${maximum} 个字符。`);
  }
  return value.trim();
}

function rewriteArtifactBackedMediaProvenance(
  value: unknown,
  artifacts: WorkflowRun<ProductionBrief>["artifacts"],
): unknown {
  if (!isRecord(value) || !Array.isArray(value.scene_assets)) return structuredClone(value);
  const document = structuredClone(value) as Record<string, unknown>;
  document.scene_assets = value.scene_assets.map((item: unknown) => {
    if (!isRecord(item) || typeof item.local_path !== "string") return structuredClone(item);
    const localPath = item.local_path;
    const artifact = artifacts.find((candidate) => candidate.uri
      && path.resolve(candidate.uri) === path.resolve(localPath)
      && (candidate.kind === "media_asset" || candidate.kind === "human_media_revision"));
    const rewritten = { ...item };
    if (!artifact) {
      rewritten.provider = "unverified";
      rewritten.provider_id = "unverified-media";
      rewritten.license_note = "未找到不可变素材来源记录：发布前必须人工核验。";
      rewritten.rights_status = "review_required";
      delete rewritten.source_url;
      delete rewritten.creator;
      delete rewritten.creator_url;
      delete rewritten.preview_url;
      return rewritten;
    }
    const providerId = artifact.provenance.providerId ?? "unknown";
    rewritten.provider = providerId;
    rewritten.provider_id = providerId;
    rewritten.rights_status = artifact.kind === "human_media_revision" ? "review_required" : "artifact_recorded";
    if (artifact.provenance.creator) rewritten.creator = artifact.provenance.creator;
    else delete rewritten.creator;
    if (artifact.provenance.creatorUrl) rewritten.creator_url = artifact.provenance.creatorUrl;
    else delete rewritten.creator_url;
    if (artifact.provenance.previewUrl) rewritten.preview_url = artifact.provenance.previewUrl;
    else delete rewritten.preview_url;
    if (artifact.provenance.licenseNote) rewritten.license_note = artifact.provenance.licenseNote;
    else delete rewritten.license_note;
    if (artifact.provenance.sourceUrl) rewritten.source_url = artifact.provenance.sourceUrl;
    else delete rewritten.source_url;
    return rewritten;
  });
  return document;
}

async function prepareAuthorizedRunFileArtifacts(options: {
  nodeId: string;
  actor: string;
  runRoot: string;
  referenceDocument: unknown;
  nextDocument: unknown;
  authorizedRunFiles: string[];
  runArtifacts: WorkflowRun<ProductionBrief>["artifacts"];
  parentArtifactId: string;
  attempt: number;
}): Promise<{ document: unknown; artifacts: ArtifactDraft[] }> {
  const artifactBackedDocument = rewriteArtifactBackedMediaProvenance(options.nextDocument, options.runArtifacts);
  if (options.authorizedRunFiles.length === 0) {
    return { document: artifactBackedDocument, artifacts: [] };
  }
  if (options.nodeId !== "assets") {
    throw new StudioInputError("只有逐镜素材节点可以登记人工替换媒体。");
  }
  const authorized = new Set(options.authorizedRunFiles.map((candidate) => path.resolve(candidate)));
  const previous = collectManagedFileReferences(options.referenceDocument);
  const next = collectManagedFileReferences(artifactBackedDocument);
  const changed = new Set<string>();
  for (const [field, nextPath] of next) {
    if (previous.get(field) !== nextPath) changed.add(path.resolve(nextPath));
  }
  if (changed.size === 0) throw new StudioInputError("人工替换文件清单没有对应到任何已修改的素材路径。");
  for (const candidate of changed) {
    if (!authorized.has(candidate)) throw new StudioInputError("每个改指的素材文件都必须登记为人工替换文件。");
  }
  for (const candidate of authorized) {
    if (!changed.has(candidate)) throw new StudioInputError("人工替换文件必须被当前素材计划引用。");
    await assertContainedFile(options.runRoot, candidate);
  }
  const document = rewriteHumanMediaProvenance(artifactBackedDocument, changed, options.actor);
  const artifacts = await Promise.all([...authorized].map(async (candidate) => {
    const content = await readFile(candidate);
    return {
      kind: "human_media_revision",
      uri: candidate,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
      contentType: mediaContentType(candidate),
      schemaVersion: "video-factory/human-media-revision-v1",
      parentArtifactIds: [options.parentArtifactId],
      producer: { nodeId: options.nodeId, attempt: options.attempt },
      provenance: {
        providerId: "human-editor",
        providerVersion: "1",
        creator: options.actor,
        licenseNote: "Human-selected replacement; usage rights require manual verification before publishing.",
        notes: "rights-status:review_required",
      },
    } satisfies ArtifactDraft;
  }));
  return { document, artifacts };
}

function rewriteHumanMediaProvenance(value: unknown, changedPaths: Set<string>, actor: string): unknown {
  if (!isRecord(value) || !Array.isArray(value.scene_assets)) {
    throw new StudioInputError("人工替换素材必须出现在素材计划的 scene_assets 中。");
  }
  const matched = new Set<string>();
  const sceneAssets = value.scene_assets;
  const document = structuredClone(value) as Record<string, unknown>;
  document.scene_assets = sceneAssets.map((item: unknown) => {
    if (!isRecord(item) || typeof item.local_path !== "string") return item;
    const resolved = path.resolve(item.local_path);
    if (!changedPaths.has(resolved)) return item;
    matched.add(resolved);
    const rewritten = { ...item };
    rewritten.provider = "human";
    rewritten.provider_id = "human-editor";
    rewritten.creator = actor;
    rewritten.license_note = "人工替换素材：发布前必须人工确认版权、肖像与商用范围。";
    rewritten.rights_status = "review_required";
    delete rewritten.source_url;
    return rewritten;
  });
  if (matched.size !== changedPaths.size) {
    throw new StudioInputError("人工替换文件必须逐镜登记，不能借用原素材的来源与授权信息。");
  }
  return document;
}

function collectManagedFileReferences(value: unknown, field = "output", result = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectManagedFileReferences(item, `${field}[${index}]`, result));
    return result;
  }
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const childField = `${field}.${key}`;
    if (isManagedFileReferenceKey(key) && typeof child === "string" && child) result.set(childField, child);
    else collectManagedFileReferences(child, childField, result);
  }
  return result;
}

function isManagedFileReferenceKey(key: string): boolean {
  return key === "uri"
    || key.endsWith("Path")
    || key.endsWith("Root")
    || key.endsWith("_path")
    || key.endsWith("_root")
    || key.endsWith("_file");
}

function mediaContentType(candidate: string): string {
  switch (path.extname(candidate).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    default: return "application/octet-stream";
  }
}

function boundedStringArray(value: unknown, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new StudioInputError(`正史事实最多允许 ${maxItems} 条。`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 240) {
      throw new StudioInputError(`第 ${index + 1} 条正史事实必须是 240 字以内的非空文本。`);
    }
    return entry.trim();
  });
}

async function writePrivateTextAtomically(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function withTextTaskRecoveryReceiptLock<T>(
  receiptPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const release = await lock(receiptPath, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 100, minTimeout: 5, maxTimeout: 50 },
  });
  try {
    return await operation();
  } finally {
    await release().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 界面 DTO 里 acknowledgeRepair 是普通布尔（表单字段天然可缺省），管道合同只认显式的 true
// ——那是"我承担了这条复核意见"的留痕开关，不该被一个 falsy 值悄悄带进去。
function creativeReviewCommandDraft(
  input: StudioCreativeReviewCommandInput,
  actor: string,
): ProductionCreativeReviewCommandDraft {
  if (input.action !== "confirm") return { ...input, actor };
  return {
    commandId: input.commandId,
    actor,
    expectedRunRevision: input.expectedRunRevision,
    expectedReviewRevision: input.expectedReviewRevision,
    stage: input.stage,
    baseDraftSha256: input.baseDraftSha256,
    action: "confirm",
    ...(input.acknowledgeRepair === true ? { acknowledgeRepair: true as const } : {}),
    ...(input.expectedCheckIdentity === undefined ? {} : { expectedCheckIdentity: input.expectedCheckIdentity }),
  };
}
