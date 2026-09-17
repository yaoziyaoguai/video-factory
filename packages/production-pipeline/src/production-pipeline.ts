import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { check as checkFileLock, lock as lockFile } from "proper-lockfile";
import {
  NodeVersionConflictError,
  ProviderRegistry,
  WorkflowRunner,
  type Artifact,
  type ArtifactDraft,
  type ApprovalPolicy,
  type Capability,
  type HumanDecisionDraft,
  type HumanReviewDisposition,
  type NodeInputOverrideDraft,
  type NodeRun,
  type NodeOverrideDraft,
  type NodeDefinition,
  type NodeExecutionReceiptDraft,
  type NodeExecutionReceipt,
  type ExecutionConfigurationSource,
  type ExecutionParameterValue,
  type NodeExecutionResult,
  type Provider,
  type SpendAuthorizationDraft,
  type SpendExcludedItem,
  type SpendQuote,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@video-factory/workflow-core";
import { PUBLISH_COPY_AGENT_CONTRACT_VERSION, validatePublishCopy, type PublishCopy, type PublishCopyWriter } from "./codex-publish-copy.js";
import {
  ASSET_RANK_AGENT_CONTRACT_VERSION,
  deterministicAssetRanking,
  parseAssetCandidateReport,
  validateAssetSemanticRanking,
  type AssetCandidateReport,
  type AssetSemanticRanker,
  type AssetSemanticRanking,
} from "./asset-semantic-ranker.js";
import { REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION, fallbackShotGrammar, validateShotGrammar, type ReferenceGrammarAgent, type ReferenceGrammarExecution, type ShotGrammar } from "./reference-grammar.js";
import { CodexBridgeError, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS, type AgentLoopTrace, type CodexTaskExecution, type CodexTaskKind, type CodexTaskTrace, type ModelCandidateAttempt, type RoleAudit } from "./codex-chat.js";
import { fileRoleAgentLoopCheckpoint, roleAgentCheckpointKey } from "./role-agent-checkpoint.js";
import { RoleAgentLoopError } from "./role-agent-loop.js";
import {
  assetReuseSourceScenePosition,
  estimateVideoGenerationCostCny,
  inspectReworkCarriedAssetScenePositions,
  inspectPaidAssetLedger,
  paidAssetLedgerLeaves,
  paidAssetSourceFingerprint,
  requiredGeneratedAssetDurationSecondsByRoot,
  reworkAffectedScenePositions,
  type PaidAssetLedgerItemSummary,
  type PaidAssetSpendForecast,
  type PaidAssetSpendForecastRequest,
  type VideoGenerationRuntimeProfile,
} from "./generative-asset-worker.js";
import { SCREENWRITER_AGENT_CONTRACT_VERSION, validateScriptDraft, type ScreenwriterAgent, type ScreenwriterAgentInput, type ScriptDraft } from "./codex-screenwriter.js";
import { FallbackBriefAuditAgent, FallbackCreativeTreatmentAgent, ModelCandidatesExhaustedError } from "./fallback-role-agents.js";
import type { BriefAuditAgent } from "./codex-brief-audit.js";
import { BRIEF_AUDIT_AGENT_CONTRACT_VERSION, BRIEF_AUDIT_PROVIDER_ID, briefAuditProjection } from "./codex-brief-audit.js";
import {
  compileExecutableProductionPlan,
  parseExecutableProductionPlan,
  type ExecutablePlanScene,
  type ExecutablePlanShot,
  type ExecutableProductionPlan,
} from "./executable-production-plan.js";
import { VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION } from "./codex-visual-director.js";
import { assertCurrentVisualReviewContract, IndependentVisualReviewError, VISUAL_REVIEW_AGENT_CONTRACT_VERSION, VisualReviewFallbackError, validateAggregatedVisualReviewReport, validateVisualReviewReport, visualReviewBlocksContinuation, type IndependentVisualReviewExecution, type VisualReviewAgent, type VisualReviewAgentInput, type VisualReviewExecution, type VisualReviewFinding, type VisualReviewReport, type VisualReviewScope } from "./codex-visual-review.js";
import { parseBrief, parsePersistedBrief, parseProductionReworkFindings, parseProductionSeriesContext, parseProductionVisualPlan, parseVoiceDoesNotFitConflict, WORKER_PROTOCOL_VERSION, type ProductionBrief, type ProductionReworkFinding } from "./contracts.js";
import { FileRunStore, RunLockedError, StaleRunRevisionError } from "./run-store.js";
import type { WorkerResponse } from "./python-worker-client.js";
import {
  validateVisualDirectorPlan,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type VisualDirectorPlan,
} from "./visual-director.js";
import type { CreativeTreatmentAgent, CreativeTreatmentAgentInput } from "./codex-creative-treatment.js";
import { CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION, creativeTreatmentSeriesContext } from "./codex-creative-treatment.js";
import { CREATIVE_TREATMENT_PROVIDER_ID } from "./creative-treatment.js";
import { contentSha256, parseCreativeReviewResume, type CreativeDiscussionResult, type CreativeReviewConfirmResume, type CreativeReviewResume, type CreativeReviewState, type CreativeStage } from "./creative-review.js";
import { PRODUCTION_AUTHORIZATION_VERSION, assessProductionSpendPlan, canonicalProductionAssetIntentDigest, canonicalQualityContractDigest, foldProductionSpendLedger, parseProductionAuthorizationScope, resolveProductionSpendDecision, scopeCoversSpendPlan, type ProductionAuthorizationScope, type ProductionSpendPlanAssessment } from "./production-authorization.js";
import {
  AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM,
  createCreativePlanningGraph,
  executablePlanCompilePort,
  initialPlanningGraphState,
  planningArtifactId,
  planningSourceAdvisories,
  rankingSemanticIntent,
  runCreativePlanning,
  type CreativePlanningGraph,
  type CreativePlanningContext,
  type CreativePlanningInput,
  type CreativePlanningPorts,
  type PlanningGraphState,
  type PlanningStageId,
} from "./creative-planning.js";
import { CreativePlanningStore, planningCheckpointSqlitePath } from "./creative-planning-store.js";
import { summarizeProductionCapabilities, type ProductionCapabilities } from "./production-capabilities.js";

interface WorkerClient {
  run(request: Record<string, unknown>): Promise<WorkerResponse>;
  /**
   * 可选的花费报价预测：素材执行器据此声明"哪些素材键本次不会新增花费"。
   * 不具备该能力的 worker（远端/旧实现）由宿主退回按脚本指纹的保守报价。
   */
  forecastPaidAssetSpend?(request: PaidAssetSpendForecastRequest): Promise<PaidAssetSpendForecast | undefined>;
}

const SCREENWRITER_PRODUCER_REQUEST_SCHEMA_VERSION = "video-factory/screenwriter-producer-request-v1";
const DIRECTOR_PRODUCER_REQUEST_SCHEMA_VERSION = "video-factory/director-producer-request-v1";

interface ProducerRequestIdentity {
  digest: string;
  schemaVersion: string;
}

type SourceRunSnapshot = <T>(sourceRunId: string, snapshot: () => Promise<T>) => Promise<T>;

export interface ProductionPipelineOptions {
  workspaceRoot: string;
  worker: WorkerClient;
  screenwriterAgent?: ScreenwriterAgent;
  directorAgent?: VisualDirectorAgent;
  publishCopyWriter?: PublishCopyWriter;
  assetProviders?: VisualAssetProviderCapability[];
  providerRuntimeMetadata?: ProductionProviderRuntimeMetadata[];
  visualReviewAgent?: VisualReviewAgent;
  visualReviewAgents?: VisualReviewAgent[];
  assetSemanticRanker?: AssetSemanticRanker;
  referenceGrammarAgent?: ReferenceGrammarAgent;
  referenceVideoRoot?: string;
  /** joint-v1 创作规划的角色绑定：真实构思 agent 与其宿主 provider（如 openai/zai-bigmodel-api）。 */
  treatmentAgents?: Array<{ providerId: string; agent: CreativeTreatmentAgent }>;
  /** 简报的独立复核绑定：与构思同一候选合同，只审不产，裁决只作建议。 */
  briefAuditAgents?: Array<{ providerId: string; agent: BriefAuditAgent }>;
  /** 崩溃窗口注入点：图完成/正式产物登记后抛错，用于恢复语义测试；生产不得配置。 */
  /** 仅测试注入的规划崩溃窗口：真实子进程测试用硬 kill，不用 throw 代替进程死亡。 */
  planningFailpoints?: {
    afterGraph?: () => void;
    afterArtifacts?: () => void;
    /** commit 结束标记写入后、run CAS 保存前：外部 commit 只是 prepared 证据。 */
    afterCommit?: () => void;
    /** 闭包播种 checkpoint 成功后、执行记录落盘前：模型 provenance 必须随 checkpoint 存活。 */
    afterSeed?: () => void;
  };
  clock?: () => string;
  idFactory?: (prefix: string) => string;
  executionLeaseHeartbeatMs?: number;
  /** 执行租约过期窗口（默认 30s）：真实进程崩溃测试据此等待真实过期，不手工删锁。 */
  executionLeaseStaleMs?: number;
}

export type ProductionRunListener = (run: WorkflowRun<ProductionBrief>) => Promise<void> | void;

export interface DispatchedProductionRun {
  runId: string;
  completion: Promise<WorkflowRun<ProductionBrief>>;
}

export interface ProductionSpendRejectionDraft {
  nodeId: string;
  spendPlanId: string;
  reason: "too_expensive" | "provider_mix" | "plan_not_approved" | "other";
  targetEstimatedCostCny?: number;
  note?: string;
  rejectedBy: string;
}

export interface ProductionSceneRevisionDraft {
  expectedRunRevision: number;
  expectedAssetVersionId: string;
  reviewArtifactId: string;
  findingIndex: number;
  reuseFromScenePosition: number;
  actor: string;
  note: string;
}

/**
 * 重新取用某一镜的素材。
 *
 * 与"复用更早镜头"相反：这一镜的素材本身被判不合格，画面必须换掉，而不是借别的镜头的画面。
 * 检索发生在规划阶段，候选清单与语义排序是那次规划的证据快照，所以这条路径不改画面方案，
 * 只把这一镜候选清单里**下一名合格候选**提到首位，让素材节点重跑时改取它。
 * 因此其它镜头的输入逐字未动：已付费的分镜按输入指纹原样带过，不产生新的 Provider 调用。
 * 合格门槛与素材节点完全一致（锁定候选，或语义分达到阈值），改选不会放宽它；
 * 这一镜若没有第二个合格候选，这条路径明确失败而不是硬塞一个次品。
 */
export interface ProductionSceneResourceRevisionDraft {
  expectedRunRevision: number;
  reviewArtifactId: string;
  findingIndex: number;
  actor: string;
  note: string;
}

/**
 * 只改一镜的旁白与字幕文字。
 *
 * 画面已经付过钱，而字幕/旁白是脚本里的一行字：改字不该让任何一帧画面重新生成。
 * 所以这条路径只让下游的配音、渲染与复审重跑，画面与画面预检按原样保留。
 * 代价是脚本是配音与字幕共同的来源——改了字配音必须重合成，这条路径不是零成本。
 */
export interface ProductionNarrationRevisionDraft {
  expectedRunRevision: number;
  /** 要改的那一镜在成片里的镜位（1 起）。 */
  scenePosition: number;
  /** 这一镜新的旁白/字幕文字。 */
  narration: string;
  actor: string;
  note: string;
}

export interface ProductionVoiceTimingRevisionDraft {
  expectedRunRevision: number;
  interventionId: string;
  scenePosition: number;
  durationSeconds: number;
  actor: string;
}

export interface ProductionVisualReinspectionDraft {
  expectedRunRevision: number;
  reviewEvidenceId: string;
}

export interface ProductionPaidNodeReconciliationDraft {
  nodeId: string;
  expectedRunRevision: number;
  reconciliationId: string;
  outcome: "resume_original" | "requote" | "confirmed_not_charged" | "confirmed_charged";
  itemRequestId?: string;
  taskId?: string;
  actor?: string;
  note?: string;
  actualCostCny?: number;
}

export interface ProductionCreativeReviewConfirmationDraft {
  commandId: string;
  actor: string;
  expectedRunRevision: number;
  expectedReviewRevision: number;
  stage: CreativeStage;
  baseDraftSha256: string;
  // 这两个字段必须跟着确认一起走。确认入口虽然只有一份实现，但类型上少一个字段，
  // 走这几个窄入口的调用方就会把人的显式承担静默丢掉——那正是"仍然确认"曾经失效的样子。
  acknowledgeRepair?: true;
  expectedCheckIdentity?: string;
}

export type ProductionCreativeReviewCommandDraft = {
  commandId: string;
  actor: string;
  expectedRunRevision: number;
  expectedReviewRevision: number;
  stage: CreativeStage;
  baseDraftSha256: string;
} & (
  | { action: "confirm"; acknowledgeRepair?: true; expectedCheckIdentity?: string }
  | { action: "discuss"; message: string; selection?: { kind: "document" | "beat" | "scene"; ids: string[]; scenePositions: number[] } }
  | { action: "adopt_proposal"; proposalId: string }
  | { action: "undo_draft" }
  | { action: "return_to_stage"; targetStage: CreativeStage; acknowledgeImpact: true }
);

interface PersistedTransitionReplay {
  replay: WorkflowRun<ProductionBrief>;
}

function isPersistedTransitionReplay(
  value: WorkflowRun<ProductionBrief> | PersistedTransitionReplay,
): value is PersistedTransitionReplay {
  return "replay" in value;
}

export interface ProductionPaidOperationItemSummary {
  operationId: string;
  itemRequestId: string;
  quoteItemId: string;
  scenePosition: number;
  executorProviderId: string;
  providerId: string;
  modelId: string;
  state: PaidAssetLedgerItemSummary["state"];
  estimatedCostCny: number;
  taskId?: string;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  error?: string;
  manualReconciliationRequired?: boolean;
}

export interface ProductionPaidNodeSummary {
  nodeId: string;
  operationId?: string;
  recommendedOutcome?: ProductionPaidNodeReconciliationDraft["outcome"];
  failureKind?: "unknown_outcome" | "terminal_failure" | "missing_evidence";
  requiresManualReconciliation: boolean;
  items: ProductionPaidOperationItemSummary[];
}

export interface ProductionReworkImpactSummary {
  version: "video-factory/rework-impact-v1";
  sourceRunId: string;
  affectedScenePositions: number[];
  nodes: Array<{
    nodeId: string;
    action: "inherited" | "partial" | "executed" | "not_run";
    reason: "verified_source_match" | "mixed_reuse_and_execution" | "affected_input" | "not_reached";
  }>;
  calls: {
    /** legacy 为逐 receipt 统计；joint 阶段无逐 producer 统计时如实报 "unknown"。 */
    scriptModel: number | "unknown";
    mediaCreate: number;
    voice: number;
    render: number;
    visualReview: number;
  };
  media: {
    retainedSha256: string[];
    producedSha256: string[];
    mayCreateNewMedia: boolean;
  };
}

export function summarizeReworkImpact(
  run: WorkflowRun<ProductionBrief>,
): ProductionReworkImpactSummary | undefined {
  const rework = effectiveProductionBrief(run).rework;
  if (!rework) return undefined;
  const effectiveNodeArtifacts = (nodeId: string): Artifact[] => {
    const current = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    const version = current?.outputState?.versions.find(
      (candidate) => candidate.id === current.outputState?.effectiveVersionId,
    );
    return (version?.artifactIds ?? []).flatMap((id) => {
      const artifact = run.artifacts.find((candidate) => candidate.id === id);
      return artifact?.producer?.nodeId === nodeId ? [artifact] : [];
    });
  };
  const inheritanceState = (nodeId: string): "none" | "partial" | "inherited" => {
    const artifacts = effectiveNodeArtifacts(nodeId).filter((artifact) => (
      nodeId !== "assets" || artifact.kind === "media_asset"
    ));
    const inheritedCount = artifacts.filter((artifact) => (
      artifact.provenance.notes?.startsWith("Inherited ") === true
    )).length;
    if (inheritedCount === 0) return "none";
    return inheritedCount === artifacts.length ? "inherited" : "partial";
  };
  const node = (nodeId: string) => run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
  const nodeSummary = (nodeId: string): ProductionReworkImpactSummary["nodes"][number] => {
    const current = node(nodeId);
    if (!current) return { nodeId, action: "not_run", reason: "not_reached" };
    const effectiveVersion = current.outputState?.versions.find(
      (candidate) => candidate.id === current.outputState?.effectiveVersionId,
    );
    const hasGeneratedArtifact = effectiveVersion?.source === "generated"
      && effectiveNodeArtifacts(nodeId).length > 0;
    if (current.status === "pending"
      || current.status === "skipped"
      || (!current.executionReceipt && !hasGeneratedArtifact)) {
      return { nodeId, action: "not_run", reason: "not_reached" };
    }
    const state = inheritanceState(nodeId);
    if (state === "partial") return { nodeId, action: "partial", reason: "mixed_reuse_and_execution" };
    return state === "inherited"
      ? { nodeId, action: "inherited", reason: "verified_source_match" }
      : { nodeId, action: "executed", reason: "affected_input" };
  };
  const mediaArtifacts = effectiveNodeArtifacts("assets").filter((artifact) => (
    artifact.kind === "media_asset" && artifact.sha256
  ));
  const retainedSha256 = mediaArtifacts.flatMap((artifact) => (
    artifact.provenance.notes?.startsWith("Inherited verified materialized media")
      ? [artifact.sha256!]
      : []
  ));
  const producedSha256 = mediaArtifacts.flatMap((artifact) => (
    artifact.provenance.notes?.startsWith("Inherited verified materialized media")
      ? []
      : [artifact.sha256!]
  ));
  const assetsNode = node("assets");
  const receipts = collectReworkImpactReceipts(run);
  const nodeReceipts = (nodeId: string) => receipts.filter((receipt) => receipt.nodeId === nodeId);
  const mediaCreate = nodeReceipts("assets").reduce(
    (total, receipt) => total + (receipt.meteredAttemptCount ?? 0),
    0,
  );
  // N7：joint-v1 的编剧角色在 creative-planning 节点内执行；节点级 receipt 没有逐 producer
  // 统计时如实报 "unknown"，不得把真实执行显示成 0/not_run。
  const jointPlanning = usesJointCreativePlanning(effectiveProductionBrief(run));
  const planningReceipts = nodeReceipts("creative-planning");
  const legacyScriptReceipts = nodeReceipts("script");
  const scriptModel: number | "unknown" = inheritanceState("script") === "inherited"
    ? 0
    : legacyScriptReceipts.length > 0
      ? legacyScriptReceipts.reduce((total, receipt) => {
          const count = receipt.parameters?.producerModelCallCount
            ?? receipt.parameters?.modelCallCount;
          return total + (typeof count === "number" && Number.isFinite(count) ? count : 1);
        }, 0)
      : jointPlanning
        ? (planningReceipts.length > 0
          ? "unknown"
          : run.nodeRuns.some((candidate) => candidate.nodeId === "creative-planning"
            && (candidate.status === "succeeded" || candidate.status === "failed"))
            ? "unknown"
            : 0)
        : 0;
  const affectedScenePositions = reworkAffectedScenePositions({
    findings: rework.findings,
    ...(rework.previousScript ? { previousScenes: rework.previousScript.scenes } : {}),
    ...(rework.previousDirectorPlan ? { previousShots: rework.previousDirectorPlan.shots } : {}),
    ...(rework.previousScript
      ? { currentScenes: rework.previousScript.scenes }
      : rework.previousDirectorPlan
        ? { currentScenes: shotsAsScenePositions(rework.previousDirectorPlan.shots) }
        : { currentScenes: [] }),
    ...(rework.previousDirectorPlan ? { currentShots: rework.previousDirectorPlan.shots } : {}),
    ...(rework.affectedScenePositions !== undefined
      ? { affectedScenePositions: rework.affectedScenePositions }
      : {}),
  });
  return {
    version: "video-factory/rework-impact-v1",
    sourceRunId: rework.sourceRunId,
    affectedScenePositions,
    nodes: [
      ...(jointPlanning ? ["creative-planning"] : ["script", "visual-direction"]),
      "assets", "voice", "render", "technical-review", "visual-review",
    ].map(nodeSummary),
    calls: {
      scriptModel,
      mediaCreate,
      voice: nodeReceipts("voice").length,
      render: nodeReceipts("render").length,
      visualReview: nodeReceipts("visual-review").length,
    },
    media: {
      retainedSha256: [...new Set(retainedSha256)].sort(),
      producedSha256: [...new Set(producedSha256)].sort(),
      mayCreateNewMedia: mediaCreate > 0 || (assetsNode?.spendPlan?.estimatedCostCny ?? 0) > 0,
    },
  };
}

function collectReworkImpactReceipts(run: WorkflowRun<ProductionBrief>): NodeExecutionReceipt[] {
  const receipts = [...(run.executionReceipts ?? [])];
  for (const node of run.nodeRuns) {
    if (!node.executionReceipt) continue;
    const duplicate = receipts.some((receipt) => (
      receipt.nodeId === node.executionReceipt?.nodeId
      && (receipt.requestId
        ? receipt.requestId === node.executionReceipt?.requestId
        : receipt.startedAt === node.executionReceipt?.startedAt
          && receipt.finishedAt === node.executionReceipt?.finishedAt
          && receipt.providerId === node.executionReceipt?.providerId
          && receipt.modelId === node.executionReceipt?.modelId)
    ));
    if (!duplicate) receipts.push(node.executionReceipt);
  }
  return receipts;
}

interface PaidNodeReconciliationRecord {
  version: "video-factory/paid-reconciliation-v1";
  reconciliationId: string;
  nodeId: string;
  outcome: ProductionPaidNodeReconciliationDraft["outcome"];
  itemRequestId?: string;
  taskId?: string;
  actor?: string;
  note?: string;
  actualCostCny?: number;
  reportedActualCostCny?: number;
  expectedRunRevision: number;
  status: "in_progress" | "completed";
  createdAt: string;
  resultingRunRevision?: number;
}

interface PaidVoiceOperationItem {
  itemRequestId: string;
  state: PaidAssetLedgerItemSummary["state"];
  stateHistory: string[];
}

interface PaidVoiceOperationLedger {
  version: "video-factory/paid-operation-v2";
  operationId: string;
  completed: boolean;
  providerId: string;
  modelId: string;
  estimatedCostCny: number;
  actualCostCny?: number;
  actualCostSource?: "configured_rate";
  items: PaidVoiceOperationItem[];
}

export class PaidOperationManualReconciliationError extends Error {
  constructor(
    readonly nodeId: string,
    readonly items: readonly PaidAssetLedgerItemSummary[],
  ) {
    super(`Paid node '${nodeId}' still has an outcome that requires manual reconciliation.`);
    this.name = "PaidOperationManualReconciliationError";
  }
}

interface ProviderConfig {
  id: string;
  capability: Capability;
  nodeId: string;
  parameters: Record<string, unknown>;
  configurationSource: ExecutionConfigurationSource;
  metadata?: ProductionProviderRuntimeMetadata;
  assetRuntimeMetadata?: ReadonlyMap<string, ProductionProviderRuntimeMetadata>;
}

const KNOWN_METERED_WORKER_PROVIDER_IDS = new Set([
  "seedream-image-v1",
  "seedance-video-v1",
  "hailuo-video-v1",
  "wan-video-v1",
  "minimax-tts-v1",
]);
const KNOWN_SUBSCRIPTION_VISUAL_REVIEW_PROVIDER_IDS = new Set(["glm-visual-review-v1"]);

export interface ProductionProviderModelRuntimeMetadata {
  modelId: string;
  estimatedCostCny: number;
  taskTypes?: VideoGenerationRuntimeProfile["taskTypes"];
  resolutions?: string[];
  aspectRatios?: VideoGenerationRuntimeProfile["aspectRatios"];
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  supportsAudio?: boolean;
  allowedDurationsSeconds?: number[];
  estimatedCnyPerSecond?: number;
  estimatedCnyPerSecondByResolution?: Record<string, number>;
  estimatedCnyByResolutionAndDuration?: Record<string, Record<string, number>>;
}

export interface ProductionProviderRuntimeMetadata {
  id: string;
  label: string;
  modelId: string;
  transport: "unix_socket" | "local_process" | "http_api";
  billing: "subscription" | "metered" | "free" | "local_compute";
  approvalPolicy?: ApprovalPolicy;
  billingUnit?: "clip" | "run";
  estimatedCostCny?: number;
  maxAttempts?: number;
  modelProfiles?: ProductionProviderModelRuntimeMetadata[];
}

function productionNodeIds(brief: ProductionBrief): string[] {
  if (usesJointCreativePlanning(brief)) {
    // joint-v1 顶层只有一条规划链：brief → 可选 reference-grammar → creative-planning。
    // 旧 script/visual-direction/asset-candidates/asset-semantic-rank/production-preflight
    // 规划节点不再创建（图库候选与排序进入 creative-planning 图内）。
    return [
      "brief",
      ...(brief.workflowFeatures?.referenceGrammar ? ["reference-grammar"] : []),
      "creative-planning",
      "assets",
      ...(brief.providers.visualReview ? ["asset-source-review"] : []),
      "voice",
      "render",
      "technical-review",
      ...(brief.providers.visualReview ? ["visual-review"] : []),
      "final-review",
      "publish-package",
    ];
  }
  return [
    "brief",
    "script",
    ...(brief.workflowFeatures?.referenceGrammar ? ["reference-grammar"] : []),
    ...(brief.director ? ["visual-direction"] : []),
    ...(brief.workflowFeatures?.assetSemanticRank ? ["asset-candidates", "asset-semantic-rank"] : []),
    ...(usesExecutablePlan(brief) ? ["production-preflight"] : []),
    "assets",
    ...(brief.providers.visualReview ? ["asset-source-review"] : []),
    "voice",
    "render",
    "technical-review",
    ...(brief.providers.visualReview ? ["visual-review"] : []),
    "final-review",
    "publish-package",
  ];
}

export function productionWorkflowVersion(
  brief: Pick<ProductionBrief, "providers" | "workflowFeatures" | "director" | "durationRange">,
): string {
  // 每个节点边界由用户放行的合同是独立拓扑形态（节点数组里多一层闸门包装）：恢复与审计
  // 必须能与不带该标记的历史 run 区分开。缺失标记时版本串保持逐字节不变——它同时是
  // supportsRunContinuation 的比较基准，改一下会让所有在飞的 run 立刻变只读。
  if (brief.workflowFeatures?.boundaryGates === "user-confirmed-v1") return "1.8.0";
  // joint-v1 共同创作规划是独立拓扑：恢复与审计必须能把它与旧规划链区分开。
  if (brief.workflowFeatures?.creativeReview === "user-confirmed-v1") return "1.7.0";
  if (usesJointCreativePlanning(brief)) return "1.6.1";
  const minorVersion = brief.providers.visualReview
    ? brief.workflowFeatures?.referenceGrammar
      ? 10
      : brief.workflowFeatures?.assetSemanticRank
        ? 9
        : 8
    : brief.workflowFeatures?.referenceGrammar
      ? 4
      : brief.workflowFeatures?.assetSemanticRank
        ? 3
        : brief.director
          ? 1
          : 0;
  const patchVersion = usesExecutablePlan(brief) ? 1 : 0;
  return `1.${minorVersion}.${patchVersion}`;
}

function usesExecutablePlan(
  brief: Pick<ProductionBrief, "workflowFeatures" | "director" | "durationRange">,
): boolean {
  return brief.workflowFeatures?.executablePlan === true || Boolean(brief.durationRange && brief.director);
}

// joint-v1 标记：brief 合同在解析期已保证 durationRange + director，未标记的历史 brief
// 一律走旧拓扑（不新增第二条兼容生产路径）。
function usesJointCreativePlanning(
  brief: Pick<ProductionBrief, "workflowFeatures">,
): boolean {
  return brief.workflowFeatures?.creativePlanning === "joint-v1";
}

function withPersistedBrief(
  run: WorkflowRun<ProductionBrief>,
  brief: ProductionBrief,
): WorkflowRun<ProductionBrief> {
  return { ...run, initialInput: brief };
}

function withExecutableBrief(
  run: WorkflowRun<ProductionBrief>,
  brief: ProductionBrief,
): WorkflowRun<ProductionBrief> {
  parseBrief(brief);
  return withPersistedBrief(run, brief);
}

export function canRetryRejectedReviewNode(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
): boolean {
  if (run.status !== "rejected") return false;
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status !== "rejected" || node.outcomeUncertain === true) return false;
  if (typeof node.output !== "object" || node.output === null || Array.isArray(node.output)) return false;
  const output = node.output as Record<string, unknown>;
  const report = nodeId === "assets" ? output.sourceVisualReview : output.report;
  if (!["assets", "asset-source-review"].includes(nodeId)
    || typeof report !== "object" || report === null || Array.isArray(report)) {
    return false;
  }
  const recommendation = (report as Record<string, unknown>).recommendation;
  return recommendation === "revise" || recommendation === "reject";
}

const INTERRUPTED_RUN_ERROR = "应用重启中断了这次制作，请重新发起制作。已完成的产物仍保留在本次记录中。";
const DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS = 5_000;
const DEFAULT_EXECUTION_LEASE_STALE_MS = 30_000;

interface ExecutionLeaseHandle {
  runId: string;
  path: string;
  token: string;
  release?: (removeLock: boolean) => Promise<void>;
  active: boolean;
  failure?: Error;
}

export class ProductionPipeline {
  private readonly runsRoot: string;
  private readonly store: FileRunStore;
  private readonly clock: () => string;
  private readonly idFactory: (prefix: string) => string;

  constructor(private readonly options: ProductionPipelineOptions) {
    this.runsRoot = path.join(options.workspaceRoot, "runs");
    this.store = new FileRunStore(this.runsRoot);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  async start(input: unknown): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatch(input);
    return dispatched.completion;
  }

  async dispatch(input: unknown, listener?: ProductionRunListener): Promise<DispatchedProductionRun> {
    const parsedBrief = parseBrief(input);
    const brief: ProductionBrief = {
      ...parsedBrief,
      taskContractDigests: { ...REQUIRED_CODEX_TASK_CONTRACT_DIGESTS },
    };
    assertProductionVisualReviewReady(brief, this.options);
    const registry = this.createRegistry(brief);
    const runId = this.idFactory("run");
    let created = false;
    let executionLease: ExecutionLeaseHandle | undefined;
    let resolveCreated!: () => void;
    let rejectCreated!: (error: unknown) => void;
    const firstCheckpoint = new Promise<void>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });
    const runner = new WorkflowRunner({
      providers: registry,
      clock: this.clock,
      idFactory: (prefix) => prefix === "run" ? runId : this.idFactory(prefix),
      shouldPause: () => this.consumePauseRequest(runId),
      checkpoint: async (run) => {
        const productionRun = run as WorkflowRun<ProductionBrief>;
        if (!created) {
          executionLease = await this.acquireExecutionLease(runId);
          try {
            await this.assertExecutionLease(executionLease);
            await this.store.create(run);
            created = true;
          } catch (error) {
            await this.releaseExecutionLease(executionLease);
            throw error;
          }
          await notifyListener(listener, productionRun);
          resolveCreated();
          return;
        }
        await this.assertExecutionLease(executionLease);
        await this.store.checkpoint(run);
        await notifyListener(listener, productionRun);
      },
    });
    const completion = runner.run(this.createWorkflow(brief), brief);
    void completion.catch((error: unknown) => {
      if (!created) {
        rejectCreated(error);
      }
    });
    await firstCheckpoint;
    const completionWithLeaseRelease = completion.then(
      async (run) => {
        if (run.status !== "paused") await rm(this.pauseRequestPath(runId), { force: true });
        await this.releaseExecutionLease(executionLease);
        return run;
      },
      async (error: unknown) => {
        await rm(this.pauseRequestPath(runId), { force: true });
        await this.releaseExecutionLease(executionLease);
        throw error;
      },
    );
    // C1：若停在报价等待且制作范围授权完全覆盖当前报价，由宿主派生子凭证自动继续；
    // 未覆盖（无授权/方案变化/超范围/余额不足）保持人工等待，不改变既有逐请求授权语义。
    const dispatched: DispatchedProductionRun = { runId, completion: completionWithLeaseRelease };
    return this.continueCoveredSpendApproval(runId, dispatched, listener);
  }

  async show(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    const run = await this.store.load<ProductionBrief>(runId);
    const brief = parsePersistedBrief(run.initialInput);
    return new WorkflowRunner({ clock: this.clock, idFactory: this.idFactory })
      .hydrateLegacyVersionStates(
        this.createWorkflow(brief, undefined, { allowUnavailableProviders: true }),
        withPersistedBrief(run, brief),
        { allowVersionMismatch: true },
      );
  }

  async loadPersisted(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.store.load<ProductionBrief>(runId);
  }

  async list(): Promise<WorkflowRun<ProductionBrief>[]> {
    return this.store.list<ProductionBrief>();
  }

  async remove(runId: string): Promise<void> {
    await this.store.remove(runId);
  }

  async requestPause(runId: string): Promise<void> {
    const run = await this.store.load<ProductionBrief>(runId);
    if (!["running", "awaiting_spend_approval", "approval_invalidated"].includes(run.status)) {
      throw new Error(`Run '${runId}' cannot be paused from status '${run.status}'.`);
    }
    await writeFile(this.pauseRequestPath(runId), `${JSON.stringify({ requestedAt: this.clock() })}\n`, "utf8");
    const latest = await this.store.load<ProductionBrief>(runId);
    if (!["running", "awaiting_spend_approval", "approval_invalidated"].includes(latest.status)) {
      throw new Error(`Run '${runId}' can no longer be paused.`);
    }
  }

  async clearPauseRequest(runId: string): Promise<void> {
    await this.store.load<ProductionBrief>(runId);
    await rm(this.pauseRequestPath(runId), { force: true });
  }

  async pauseRequested(runId: string): Promise<boolean> {
    try {
      await stat(this.pauseRequestPath(runId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async withRunMaintenanceLease<T>(runIds: string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(runIds)].sort();
    const leases: ExecutionLeaseHandle[] = [];
    try {
      for (const runId of ids) {
        leases.push(await this.acquireExecutionLease(runId));
      }
      for (const lease of leases) await this.assertExecutionLease(lease);
      return await action();
    } finally {
      for (const lease of leases.reverse()) {
        await this.releaseExecutionLease(lease);
      }
    }
  }

  async recoverInterruptedRuns(options: { leaseStaleAfterMs?: number } = {}): Promise<number> {
    const leaseStaleAfterMs = options.leaseStaleAfterMs ?? this.options.executionLeaseStaleMs ?? DEFAULT_EXECUTION_LEASE_STALE_MS;
    const interrupted = (await this.store.list<ProductionBrief>())
      .filter((run) => run.status === "pending" || run.status === "running");
    let recovered = 0;
    for (const run of interrupted) {
      if (await this.hasFreshExecutionLease(run.id, leaseStaleAfterMs)) continue;
      const creativeRecoveryRequest = run.nodeRuns.some((node) => (
        node.nodeId === "creative-planning" && (node.status === "running" || node.status === "pending")
      ))
        ? [...(run.creativeReviewOperations ?? [])].reverse().find((operation) => (
            (operation.status === "running" || operation.status === "unknown")
            && isObjectRecord(operation.request)
          ))?.request
        : undefined;
      let recoveryLease: ExecutionLeaseHandle | undefined;
      try {
        recoveryLease = await this.acquireExecutionLease(run.id);
        await this.assertExecutionLease(recoveryLease);
        await this.store.update<ProductionBrief>(run.id, async (current) => {
          const finishedAt = this.clock();
          const runningNodeIndex = current.nodeRuns.findIndex((node) => node.status === "running");
          const pendingNodeIndex = runningNodeIndex < 0
            ? current.nodeRuns.findIndex((node) => node.status === "pending")
            : -1;
          const activeNodeIndex = runningNodeIndex >= 0 ? runningNodeIndex : pendingNodeIndex;
          const nodeRuns = current.nodeRuns.map((node) => ({ ...node }));
          if (activeNodeIndex >= 0) {
            const interruptedNode = nodeRuns[activeNodeIndex]!;
            nodeRuns[activeNodeIndex] = {
              ...interruptedNode,
              status: "failed",
              interrupted: true,
              ...(interruptedNode.spendAuthorizationId ? { outcomeUncertain: true } : {}),
              finishedAt,
              error: INTERRUPTED_RUN_ERROR,
            };
          } else {
            const completedNodeIds = new Set(nodeRuns.map((node) => node.nodeId));
            const interruptedNodeId = productionNodeIds(current.initialInput).find((nodeId) => !completedNodeIds.has(nodeId))
              ?? "publish-package";
            nodeRuns.push({
              nodeId: interruptedNodeId,
              status: "failed",
              startedAt: finishedAt,
              finishedAt,
              artifactIds: [],
              qualityGateResults: [],
              error: INTERRUPTED_RUN_ERROR,
            });
          }
          return {
            ...current,
            revision: current.revision + 1,
            status: "failed",
            finishedAt,
            nodeRuns,
          };
        });
      } catch (error) {
        if (error instanceof RunLockedError) continue;
        throw error;
      } finally {
        await this.releaseExecutionLease(recoveryLease);
      }
      recovered += 1;
      if (creativeRecoveryRequest) {
        try {
          const dispatched = await this.dispatchCreativeReviewCommand(
            run.id,
            creativeRecoveryRequest as unknown as ProductionCreativeReviewCommandDraft,
          );
          void dispatched.completion.catch(() => undefined);
        } catch {
          // 已把原 run 如实标为 interrupted/failed；恢复证据损坏或当前配置不再可用时保持
          // 可诊断失败，不构造新 commandId，也不阻断其它历史 run 的启动恢复。
        }
      }
    }
    return recovered;
  }

  private async acquireExecutionLease(runId: string): Promise<ExecutionLeaseHandle> {
    const leasePath = this.executionLeasePath(runId);
    await mkdir(path.dirname(leasePath), { recursive: true });
    const handle: ExecutionLeaseHandle = {
      runId,
      path: leasePath,
      token: randomUUID(),
      active: true,
    };
    const requestedHeartbeatMs = this.options.executionLeaseHeartbeatMs ?? DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS;
    // stale 窗口可按 options 缩短（进程崩溃测试用真实过期恢复，不手工删锁）；生产保持默认。
    const staleMs = this.options.executionLeaseStaleMs ?? DEFAULT_EXECUTION_LEASE_STALE_MS;
    const heartbeatMs = Math.max(1_000, Math.min(requestedHeartbeatMs, staleMs / 2));
    const lockPath = this.executionLeaseLockPath(runId);
    const lockRemoval = { acquired: false, force: false };
    try {
      const release = await lockFile(handle.path, {
        realpath: false,
        lockfilePath: lockPath,
        stale: staleMs,
        update: heartbeatMs,
        retries: 0,
        fs: executionLeaseFileSystem(handle, lockPath, lockRemoval),
        onCompromised: (error) => {
          handle.failure = executionLeaseLostError(runId, error);
          handle.active = false;
        },
      });
      lockRemoval.acquired = true;
      handle.release = async (removeLock) => {
        lockRemoval.force = removeLock;
        await release();
      };
    } catch (error) {
      if (hasCode(error, "ELOCKED")) throw new RunLockedError(runId);
      throw error;
    }
    const temporary = `${handle.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, executionLeasePayload(handle.token), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, handle.path);
      await rm(temporary, { force: true });
      return handle;
    } catch (error) {
      const release = handle.release;
      if (release) await release(true).catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async assertExecutionLease(handle: ExecutionLeaseHandle | undefined): Promise<void> {
    if (!handle) throw new Error("Execution lease was not acquired.");
    if (handle.failure) throw handle.failure;
    try {
      const current = JSON.parse(await readFile(handle.path, "utf8")) as { token?: unknown };
      if (!handle.active || current.token !== handle.token) {
        handle.failure = executionLeaseLostError(handle.runId);
        handle.active = false;
        throw handle.failure;
      }
    } catch (error) {
      if (handle.failure) throw handle.failure;
      handle.failure = executionLeaseLostError(handle.runId, error);
      handle.active = false;
      throw handle.failure;
    }
  }

  private async releaseExecutionLease(handle: ExecutionLeaseHandle | undefined): Promise<void> {
    if (!handle) return;
    handle.active = false;
    let ownsMetadata = false;
    try {
      const current = JSON.parse(await readFile(handle.path, "utf8")) as { token?: unknown };
      ownsMetadata = current.token === handle.token;
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    const release = handle.release;
    if (!ownsMetadata) {
      if (release) await release(false).catch((error) => {
        if (!hasCode(error, "ERELEASED")) throw error;
      });
      return;
    }
    await rm(handle.path, { force: true });
    if (release) {
      await release(true).catch((error) => {
        if (!hasCode(error, "ERELEASED")) throw error;
      });
    }
  }

  private async hasFreshExecutionLease(runId: string, staleAfterMs: number): Promise<boolean> {
    try {
      return await checkFileLock(this.executionLeasePath(runId), {
        realpath: false,
        lockfilePath: this.executionLeaseLockPath(runId),
        stale: staleAfterMs,
      });
    } catch {
      return false;
    }
  }

  private executionLeasePath(runId: string): string {
    return path.join(this.runsRoot, runId, ".execution-lease.json");
  }

  private executionLeaseLockPath(runId: string): string {
    return `${this.executionLeasePath(runId)}.lock`;
  }

  async decide(runId: string, decision: HumanDecisionDraft): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchDecision(runId, decision);
    return dispatched.completion;
  }

  async dispatchDecision(
    runId: string,
    decision: HumanDecisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      if (!Number.isSafeInteger(decision.expectedRunRevision) || decision.expectedRunRevision !== previous.revision) {
        throw new StaleRunRevisionError(runId, decision.expectedRunRevision ?? -1, previous.revision);
      }
      const brief = parsePersistedBrief(previous.initialInput);
      const activeInterventionNode = previous.nodeRuns.find(
        (node) => node.intervention?.id === decision.interventionId,
      );
      if (!activeInterventionNode || activeInterventionNode.status !== "needs_human") {
        throw new Error(`Intervention '${decision.interventionId}' is not active for run '${runId}'.`);
      }
      if (activeInterventionNode.intervention?.kind === "creative_review") {
        throw new Error(
          "Creative review cannot use the generic decision endpoint; use the stage confirmation command.",
        );
      }
      const currentReviewEvidenceId = finalReviewEvidenceId(activeInterventionNode);
      if (decision.reviewEvidenceId !== currentReviewEvidenceId) {
        throw new Error("Human decision is not bound to the current review evidence.");
      }
      if (decision.action === "approve" && activeInterventionNode?.nodeId === "final-review") {
        assertPersistedFinalApprovalReady(previous, brief, activeInterventionNode);
        assertFinalReviewDispositions(currentVisualReviewDelivery(previous), decision.reviewDispositions);
      }
      const registry = this.createRegistry(brief);
      const runner = new WorkflowRunner({
        providers: registry,
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.resume(this.createWorkflow(brief, decision), withExecutableBrief(previous, brief), decision);
    }, listener);
  }

  async confirmCreativeReview(
    runId: string,
    draft: ProductionCreativeReviewConfirmationDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchCreativeReviewCommand(runId, { ...draft, action: "confirm" });
    return dispatched.completion;
  }

  async dispatchCreativeReviewConfirmation(
    runId: string,
    draft: ProductionCreativeReviewConfirmationDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchCreativeReviewCommand(runId, { ...draft, action: "confirm" }, listener);
  }

  async dispatchCreativeReviewCommand(
    runId: string,
    draft: ProductionCreativeReviewCommandDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const normalizedActor = draft.actor.trim();
      const normalizedCommandId = draft.commandId.trim();
      const requestDigest = contentSha256({ ...draft, commandId: normalizedCommandId, actor: normalizedActor });
      const existingOperation = previous.creativeReviewOperations?.find(
        (operation) => operation.commandId === normalizedCommandId,
      );
      if (existingOperation) {
        if (existingOperation.requestDigest !== requestDigest) {
          throw new Error(`Creative review command '${normalizedCommandId}' was already used with different content.`);
        }
        if ((existingOperation.status !== "running" && existingOperation.status !== "unknown")
          || existingOperation.resume === undefined) {
          return { replay: previous };
        }
        const resume = parseCreativeReviewResume(existingOperation.resume);
        if (resume.commandId !== existingOperation.commandId
          || resume.stage !== existingOperation.stage
          || resume.action !== existingOperation.action) {
          throw new Error(`Creative review command '${normalizedCommandId}' has inconsistent recovery evidence.`);
        }
        const brief = parsePersistedBrief(previous.initialInput);
        const node = previous.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
        if (!node) throw new Error("Creative review recovery cannot find the creative-planning node.");
      const recoveryIntervention: NonNullable<NodeRun["intervention"]> = {
          id: node.intervention?.id ?? `creative-review-recovery-${normalizedCommandId}`,
          nodeId: "creative-planning",
          kind: "creative_review" as const,
          reason: "正在恢复同一条创作讨论或确认命令。",
          requiredAction: "approve" as const,
        options: ["approve", "request_changes"],
          createdAt: existingOperation.acceptedAt,
          continuation: {
            stage: resume.stage,
            reviewRevision: resume.expectedReviewRevision,
            draftSha256: resume.baseDraftSha256,
          },
        };
        const recoveryBase: WorkflowRun<ProductionBrief> = {
          ...previous,
          status: "needs_human",
          nodeRuns: previous.nodeRuns.map((candidate) => candidate.nodeId === "creative-planning"
            ? {
                ...candidate,
                status: "needs_human",
                intervention: recoveryIntervention,
                ...(candidate.output === undefined ? {} : { output: candidate.output }),
              }
            : candidate),
          interventions: [
            ...previous.interventions.filter((intervention) => intervention.nodeId !== "creative-planning"),
            recoveryIntervention,
          ],
        };
        delete recoveryBase.finishedAt;
        const runner = new WorkflowRunner({
          providers: this.createRegistry(brief),
          clock: this.clock,
          idFactory: this.idFactory,
          checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
          shouldPause: () => this.consumePauseRequest(runId),
        });
        const result = await runner.continueWaitingNode(
          this.createWorkflow(brief, undefined, { creativeReviewResume: resume }),
          withExecutableBrief(recoveryBase, brief),
          "creative-planning",
          {
            commandId: normalizedCommandId,
            action: resume.action,
            requestDigest,
            status: "running",
            acceptedAt: existingOperation.acceptedAt,
          },
        );
        result.creativeReviewOperations = (result.creativeReviewOperations ?? []).map((operation) => (
          operation.commandId === normalizedCommandId
            ? {
                ...operation,
                status: result.status === "failed" ? "failed" as const : "completed" as const,
                finishedAt: this.clock(),
              }
            : operation
        ));
        await checkpoint(result);
        return result;
      }
      if (!Number.isSafeInteger(draft.expectedRunRevision) || draft.expectedRunRevision !== previous.revision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (!normalizedCommandId || !normalizedActor) {
        throw new Error("Creative review confirmation requires commandId and actor.");
      }
      const node = previous.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
      const continuation = node?.intervention?.continuation;
      if (previous.status !== "needs_human"
        || node?.status !== "needs_human"
        || node.intervention?.kind !== "creative_review"
        || !continuation) {
        throw new Error(`Run '${runId}' is not waiting for a creative review confirmation.`);
      }
      if (continuation.stage !== draft.stage
        || continuation.reviewRevision !== draft.expectedReviewRevision
        || continuation.draftSha256 !== draft.baseDraftSha256) {
        throw new Error("Creative review confirmation is stale or belongs to another stage draft.");
      }
      if (draft.action === "confirm" && draft.acknowledgeRepair === true && draft.expectedCheckIdentity === undefined) {
        // "仍然确认"复用他看过的那一条复核，所以命令必须自己说出是哪一条。这里曾经替他造一个
        // identity：造出来的那个必然对不上记录里的那个，绑定就退化成一个永远失败的空检查，
        // 报错还把人指向"没有独立复核"这种错误方向。
        throw new Error("确认已经看过的复核意见时必须指明那一条复核的编号。");
      }
      if (draft.action === "confirm" && draft.acknowledgeRepair === true
        && recordedCreativeCheckIdentity(node, continuation.stage) !== draft.expectedCheckIdentity) {
        // 就在命令边界上证明他手上的编号就是记录里那一条。放进去让图来拒的话，形态会变成
        // "这个节点失败了"——整条制作直接 failed，而他只是拿着一个过期的页面按了按钮。
        // 图里那道同样的比对仍然保留：它守的是从 checkpoint 直接恢复的那条路。
        throw new Error("你确认的那一条独立复核意见已经不是当前这一条了，请重新查看当前的复核意见再确认。");
      }
      const brief = parsePersistedBrief(previous.initialInput);
      if (brief.workflowFeatures?.creativeReview !== "user-confirmed-v1") {
        throw new Error("This run does not use the user-confirmed creative review workflow.");
      }
      const common = {
        stage: draft.stage,
        commandId: normalizedCommandId,
        actor: normalizedActor,
        baseDraftSha256: draft.baseDraftSha256,
        expectedReviewRevision: draft.expectedReviewRevision,
      };
      const resume: CreativeReviewResume = draft.action === "confirm"
        ? {
          action: "confirm",
          ...common,
          // 人的显式承担必须跟着命令落到 resume 上：少了它，"仍然确认"就退化成再跑一轮复核，
          // 而新裁决照样是 repair 时人永远推不动这条制作。
          ...(draft.acknowledgeRepair === true ? { acknowledgeRepair: true as const } : {}),
          // 走"确认即复核"这条路时，reviewGateNode 会用刚跑出来的那一条复核覆盖这里的值，
          // 所以缺省值只是个占位；复用已展示复核时必须由调用方带上，上面的守卫保证它存在。
          checkIdentity: draft.expectedCheckIdentity ?? contentSha256({
            runId,
            stage: draft.stage,
            draftSha256: draft.baseDraftSha256,
            reviewRevision: draft.expectedReviewRevision,
            contract: "creative-review-confirm-v1",
          }),
          confirmedAt: this.clock(),
        }
        : draft.action === "discuss"
          ? {
            action: "discuss",
            ...common,
            message: draft.message,
            ...(draft.selection ? { selection: draft.selection } : {}),
          }
          : draft.action === "adopt_proposal"
            ? { action: "adopt_proposal", ...common, proposalId: draft.proposalId }
            : draft.action === "undo_draft"
              ? { action: "undo_draft", ...common }
              : { action: "return_to_stage", ...common, targetStage: draft.targetStage, acknowledgeImpact: true };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      const acceptedAt = this.clock();
      const acceptedRun: WorkflowRun<ProductionBrief> = {
        ...previous,
        creativeReviewOperations: [
          ...(previous.creativeReviewOperations ?? []),
          {
            commandId: normalizedCommandId,
            requestDigest,
            action: draft.action,
            stage: draft.stage,
            status: "running",
            acceptedAt,
            request: structuredClone({ ...draft, commandId: normalizedCommandId, actor: normalizedActor }),
            resume: structuredClone(resume),
          },
        ],
      };
      const result = await runner.continueWaitingNode(
        this.createWorkflow(brief, undefined, { creativeReviewResume: resume }),
        withExecutableBrief(acceptedRun, brief),
        "creative-planning",
        {
          commandId: normalizedCommandId,
          action: draft.action,
          requestDigest,
          status: "running",
          acceptedAt,
        },
      );
      result.creativeReviewOperations = (result.creativeReviewOperations ?? []).map((operation) => (
        operation.commandId === normalizedCommandId
          ? {
            ...operation,
            status: result.status === "failed" ? "failed" as const : "completed" as const,
            finishedAt: this.clock(),
          }
          : operation
      ));
      await checkpoint(result);
      return result;
    }, listener);
  }

  async applyNodeOverride(runId: string, override: NodeOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      await verifyNodeOverrideBoundary(this.store.runDirectory(runId), override);
      const brief = parsePersistedBrief(previous.initialInput);
      const effectiveOverride = override.nodeId === "visual-direction"
        ? await this.prepareVisualDirectionOverride(previous, override)
        : override;
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyNodeOverride(this.createWorkflow(brief), withExecutableBrief(previous, brief), effectiveOverride);
    });
  }

  async requestVoiceTimingRevision(
    runId: string,
    draft: ProductionVoiceTimingRevisionDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    await this.runPersistedTransition(runId, async (previous) => {
      if (previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (previous.status !== "needs_human" || !draft.actor.trim()) {
        throw new Error(`Run '${runId}' is not waiting for a voice timing change.`);
      }
      const voiceNode = previous.nodeRuns.find((node) => node.nodeId === "voice" && node.status === "needs_human");
      if (!voiceNode) throw new Error("Voice timing revision requires the active voice node.");
      const intervention = voiceNode?.intervention;
      if (intervention?.id !== draft.interventionId || !intervention.options?.includes("request_changes")) {
        throw new Error("Voice timing revision requires the active planning intervention.");
      }
      const voiceOutput = requireOutputRecord(voiceNode.output, "voice output");
      const conflict = parseVoiceDoesNotFitConflict(voiceOutput.conflict);
      if (draft.scenePosition !== conflict.scenePosition) {
        throw new Error("Voice timing revision scene is no longer current.");
      }
      if (!Number.isFinite(draft.durationSeconds) || draft.durationSeconds < conflict.requiredSeconds
        || draft.durationSeconds > 180) {
        throw new Error("Voice timing revision must cover the complete natural speech and remain within 180 seconds.");
      }

      const brief = parsePersistedBrief(previous.initialInput);
      if (!brief.durationRange || !brief.director) {
        throw new Error("Voice timing revision requires an executable production plan.");
      }
      const planOwnerNodeId = usesJointCreativePlanning(brief) ? "creative-planning" : "production-preflight";
      const preflightNode = previous.nodeRuns.find((node) => node.nodeId === planOwnerNodeId);
      const preflightVersion = preflightNode?.outputState?.versions.find(
        (version) => version.id === preflightNode.outputState?.effectiveVersionId,
      );
      if (!preflightVersion) throw new Error("Current executable production plan version is unavailable.");
      const preflightOutput = requireOutputRecord(preflightVersion.output ?? preflightNode?.output, `${planOwnerNodeId} output`);
      const currentPlanPath = requiredOutputString(preflightOutput, "executablePlanPath");
      const currentPlanArtifact = previous.artifacts.find((artifact) => (
        preflightVersion.artifactIds.includes(artifact.id)
        && artifact.kind === "executable_plan"
        && artifact.uri === currentPlanPath
        && artifact.producer?.nodeId === planOwnerNodeId
      ));
      if (!currentPlanArtifact?.uri) throw new Error("Current executable production plan artifact is unavailable.");
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), currentPlanArtifact);
      const currentPlan = parseExecutableProductionPlan(JSON.parse(await readFile(currentPlanArtifact.uri, "utf8")));
      const requestedFrameCount = Math.ceil(draft.durationSeconds * currentPlan.fps - 1e-6);
      const requiredFrameCount = Math.ceil(conflict.requiredSeconds * currentPlan.fps - 1e-6);
      if (requestedFrameCount < requiredFrameCount) {
        throw new Error("Voice timing revision loses part of the natural speech after frame quantization.");
      }
      let nextStartFrame = 0;
      const cuts = currentPlan.cuts.map((cut) => {
        const frameCount = cut.scenePosition === draft.scenePosition ? requestedFrameCount : cut.frameCount;
        const revisedCut = { ...cut, startFrame: nextStartFrame, frameCount };
        nextStartFrame += frameCount;
        return revisedCut;
      });
      if (!cuts.some((cut) => cut.scenePosition === draft.scenePosition)) {
        throw new Error("Voice timing revision scene is missing from the executable production plan.");
      }
      const revisedPlan = parseExecutableProductionPlan({
        ...currentPlan,
        totalFrames: nextStartFrame,
        cuts,
      });
      const revisionDirectory = path.join(
        this.runsRoot,
        runId,
        "nodes",
        planOwnerNodeId,
        "revisions",
        `revision-${previous.revision + 1}`,
      );
      await mkdir(revisionDirectory, { recursive: true });
      const revisedPlanPath = path.join(revisionDirectory, "executable_plan.json");
      const revisedPlanContent = `${JSON.stringify(revisedPlan, null, 2)}\n`;
      await writeTextAtomically(revisedPlanPath, revisedPlanContent);
      const definition = this.createWorkflow(brief);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyNodeRevision(definition, withExecutableBrief(previous, brief), {
        nodeId: planOwnerNodeId,
        actor: draft.actor.trim(),
        output: { ...preflightOutput, executablePlanPath: revisedPlanPath },
        artifacts: [fileArtifact(
          "executable_plan",
          revisedPlanPath,
          revisedPlanContent,
          "application/json",
          currentPlanArtifact.schemaVersion ?? "video-factory/executable-plan-v1",
          planOwnerNodeId,
          [currentPlanArtifact.id, ...voiceNode.artifactIds],
          "human-voice-timing-revision-v1",
          "Creator accepted a longer cut for the complete natural-speed narration.",
        )],
        // F6 残留收口：新版本保留当前方案的规划支撑引用集（joint 为整组 planning 证据，
        // legacy 为同版本其余产物），使修订后的 current version 仍满足引用闭包——
        // 声音修订进入同一正式发布合同，而不是留下只装一个新 plan 文件的断链版本。
        retainedArtifactIds: preflightVersion.artifactIds.filter((artifactId) => artifactId !== currentPlanArtifact.id),
        invalidateDescendantNodeIds: [
          "asset-source-review",
          "assets",
          "voice",
          "render",
          "technical-review",
          "visual-review",
          "final-review",
          "publish-package",
        ].filter((nodeId) => productionNodeIds(brief).includes(nodeId)),
        expectedVersionId: preflightVersion.id,
        schemaVersion: preflightVersion.schemaVersion,
        decision: {
          interventionId: intervention.id,
          action: "request_changes",
          actor: draft.actor.trim(),
          note: `镜头 ${draft.scenePosition} 时长调整为 ${requestedFrameCount / currentPlan.fps} 秒。`,
        },
      });
    });
    return this.resumeStale(runId);
  }

  private async prepareVisualDirectionOverride(
    previous: WorkflowRun<ProductionBrief>,
    override: NodeOverrideDraft,
  ): Promise<NodeOverrideDraft> {
    const currentBrief = effectiveProductionBrief(previous);
    const direction = currentBrief.director;
    if (!direction) throw new Error("Visual direction is not enabled for this run.");

    const submittedOutput = validatePathOutput(override.output, "directorPlanPath", "visual-direction");
    const submittedPath = requiredOutputString(submittedOutput, "directorPlanPath");
    const scriptPath = requiredOutputString(
      previous.nodeRuns.find((node) => node.nodeId === "script")?.output,
      "scriptPath",
    );
    const script = JSON.parse(await readFile(scriptPath, "utf8")) as { viewerPromise?: unknown; narrativeArc?: unknown; scenes?: unknown };
    const scenes = parseDirectorScenes(script.scenes);
    const plan = validateVisualDirectorPlan(
      JSON.parse(await readFile(submittedPath, "utf8")) as unknown,
      visualDirectorPlanValidation(
        currentBrief,
        scenes,
        this.options.assetProviders ?? [],
        this.options.providerRuntimeMetadata ?? [],
        optionalOutputString(script.viewerPromise),
      ),
    );

    const attempt = await reserveAttemptDirectory(path.join(
      this.store.runDirectory(previous.id),
      "nodes",
      "visual-direction",
      "manual-overrides",
    ));
    const planPath = path.join(attempt.directory, "director_plan.json");
    const content = `${JSON.stringify(plan, null, 2)}\n`;
    await writeTextAtomically(planPath, content);
    const parentArtifactIds = previous.artifacts
      .filter((artifact) => artifact.producer?.nodeId === "script" && artifact.uri !== undefined
        && path.resolve(artifact.uri) === path.resolve(scriptPath))
      .map((artifact) => artifact.id);
    const validatedArtifact = fileArtifact(
      "storyboard",
      planPath,
      content,
      "application/json",
      "video-factory/director-plan-v1",
      "visual-direction",
      parentArtifactIds,
      "human-validated-director-plan-v1",
      "Human-edited director plan validated and repriced by the server.",
      attempt.attempt,
    );
    const effectiveOverride = {
      ...override,
      output: { ...submittedOutput, directorPlanPath: planPath },
      artifacts: [...(override.artifacts ?? []), validatedArtifact],
    };
    await verifyNodeOverrideBoundary(this.store.runDirectory(previous.id), effectiveOverride);
    return effectiveOverride;
  }

  async applyNodeInputOverride(runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      const brief = parsePersistedBrief(previous.initialInput);
      // B4 对外编辑合同（joint-v1）：caller tokens 必填，省略即拒绝，不提供无 token 豁免
      // 路径；legacy 拓扑保持既有行为（token 提供时仍然参与复核）。
      if (usesJointCreativePlanning(brief)) {
        if (!Number.isSafeInteger(override.expectedRunRevision) || Number(override.expectedRunRevision) < 0) {
          throw new Error(`Joint planning input override for '${runId}' requires a non-negative expectedRunRevision.`);
        }
        if (typeof override.expectedVersionId !== "string" || !override.expectedVersionId.trim()) {
          throw new Error(`Joint planning input override for '${runId}' requires the expected input version id.`);
        }
      }
      // 持锁复核 caller revision：服务预检查读取的 revision 与此刻真实 head 之间可能已有
      // 后台写入（异步 dispatch 的 checkpoint 会推进 revision），stale token 在这里失败，
      // 而不是靠节点输入版本未变放过一次基于过期观察的覆盖。
      if (override.expectedRunRevision !== undefined && previous.revision !== override.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, override.expectedRunRevision, previous.revision);
      }
      await verifyNodeInputOverrideBoundary(this.store.runDirectory(runId), override);
      await assertNoUnresolvedPlanningTask(this.store.runDirectory(runId), previous);
      // joint-v1 的 planning input 中包含当前有效 brief。人工调整声音节奏、用户要求或
      // 系列事实时，不能只把新值留在节点 override、而让 initialInput 继续成为另一份旧配置。
      // 这里先用同一个正式 merge/parse 边界得到唯一有效 brief，再同时交给工作流定义和
      // 持久化 run；阶段 identity 会据此只复用真正未受影响的上游。
      const effectiveBrief = override.nodeId === "creative-planning"
        && isObjectRecord(override.input)
        && isObjectRecord(override.input.brief)
        ? mergeCurrentBrief(override.input.brief, brief)
        : brief;
      const effectivePrevious = effectiveBrief === brief
        ? previous
        : { ...previous, initialInput: effectiveBrief };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(effectiveBrief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyNodeInputOverride(
        this.createWorkflow(effectiveBrief),
        withExecutableBrief(effectivePrevious, effectiveBrief),
        override,
      );
    });
  }

  async requestSceneRevision(
    runId: string,
    draft: ProductionSceneRevisionDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchSceneRevision(runId, draft);
    return dispatched.completion;
  }

  async dispatchSceneRevision(
    runId: string,
    draft: ProductionSceneRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    await this.runPersistedTransition(runId, async (previous) => {
      if (previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (previous.status !== "needs_human") {
        throw new Error(`Run '${runId}' is not waiting for human review.`);
      }
      if (!draft.actor.trim() || !draft.note.trim()) {
        throw new Error("Scene revision actor and note are required.");
      }
      if (!Number.isInteger(draft.findingIndex) || draft.findingIndex < 0) {
        throw new Error("Scene revision finding index is invalid.");
      }
      if (!Number.isInteger(draft.reuseFromScenePosition) || draft.reuseFromScenePosition < 1) {
        throw new Error("Scene revision reuse source is invalid.");
      }

      const brief = parsePersistedBrief(previous.initialInput);
      const definition = this.createWorkflow(brief);
      const finalIntervention = previous.nodeRuns.find((node) => node.nodeId === "final-review")?.intervention;
      if (!finalIntervention) throw new Error("Scene revision requires an active final-review intervention.");
      const visualReviewNodeRun = previous.nodeRuns.find((node) => node.nodeId === "visual-review");
      const visualReviewVersion = visualReviewNodeRun?.outputState?.versions.find(
        (version) => version.id === visualReviewNodeRun.outputState?.effectiveVersionId,
      );
      const reviewArtifact = previous.artifacts.find((artifact) => artifact.id === draft.reviewArtifactId);
      if (
        !visualReviewVersion?.artifactIds.includes(draft.reviewArtifactId)
        || reviewArtifact?.kind !== "review_report"
        || reviewArtifact.producer?.nodeId !== "visual-review"
      ) {
        throw new Error("Scene revision requires a current visual-review report artifact.");
      }
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), reviewArtifact);
      const reviewOutput = requireOutputRecord(
        visualReviewVersion.output ?? visualReviewNodeRun?.output,
        "visual review output",
      );
      const reviewDurationMs = Number(reviewOutput.durationMs);
      if (!Number.isInteger(reviewDurationMs) || reviewDurationMs <= 0) {
        throw new Error("Current visual-review duration is invalid.");
      }
      const storedReportValue = JSON.parse(await readFile(reviewArtifact.uri!, "utf8"));
      assertCurrentVisualReviewContract(storedReportValue);
      const storedReport = validateAggregatedVisualReviewReport(
        storedReportValue,
        reviewDurationMs,
      );
      if (draft.findingIndex >= storedReport.findings.length) {
        throw new Error("Scene revision finding is no longer current.");
      }

      const renderNodeRun = previous.nodeRuns.find((node) => node.nodeId === "render");
      const renderVersion = renderNodeRun?.outputState?.versions.find(
        (version) => version.id === renderNodeRun.outputState?.effectiveVersionId,
      );
      const renderOutput = requireOutputRecord(renderVersion?.output ?? renderNodeRun?.output, "render output");
      const renderManifestPath = requiredOutputString(renderOutput, "renderManifestPath");
      const renderManifestArtifact = previous.artifacts.find((artifact) => (
        renderVersion?.artifactIds.includes(artifact.id)
        && artifact.kind === "render_manifest"
        && artifact.uri === renderManifestPath
        && artifact.producer?.nodeId === "render"
      ));
      if (!renderManifestArtifact) {
        throw new Error("Scene revision requires the current render manifest artifact.");
      }
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), renderManifestArtifact);
      const localizedReport = await localizeVisualReviewReport(
        storedReport,
        renderManifestPath,
        reviewDurationMs,
      );
      const scenePosition = localizedReport.findings[draft.findingIndex]!.scenePosition!;
      if (scenePosition === draft.reuseFromScenePosition) {
        throw new Error("A scene cannot reuse itself as a revision source.");
      }
      if (draft.reuseFromScenePosition > scenePosition) {
        throw new Error(`Reuse source scene ${draft.reuseFromScenePosition} must be earlier than reviewed scene ${scenePosition}.`);
      }

      const assetsNodeRun = previous.nodeRuns.find((node) => node.nodeId === "assets");
      const assetVersion = assetsNodeRun?.outputState?.versions.find(
        (version) => version.id === assetsNodeRun.outputState?.effectiveVersionId,
      );
      if (!assetVersion || assetVersion.id !== draft.expectedAssetVersionId) {
        throw new NodeVersionConflictError("assets", draft.expectedAssetVersionId, assetVersion?.id ?? "missing");
      }
      const assetPlanArtifact = previous.artifacts.find((artifact) => (
        artifact.kind === "asset_plan"
        && Boolean(artifact.uri)
        && assetVersion.artifactIds.includes(artifact.id)
        && artifact.producer?.nodeId === "assets"
      ));
      if (!assetPlanArtifact?.uri) throw new Error("Current asset plan artifact is unavailable.");
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), assetPlanArtifact);
      const currentAssetOutput = requireOutputRecord(assetVersion.output ?? assetsNodeRun?.output, "assets output");
      const currentPlan = requireOutputRecord(
        JSON.parse(await readFile(assetPlanArtifact.uri, "utf8")),
        "asset plan",
      );
      const revisedPlan = reviseAssetPlanByReuse(currentPlan, scenePosition, draft.reuseFromScenePosition);
      const retainedArtifactIds = await mediaArtifactIdsReferencedByPlan(
        this.store.runDirectory(runId),
        previous.artifacts,
        assetVersion.artifactIds,
        revisedPlan,
      );
      const revisionDirectory = path.join(
        this.runsRoot,
        runId,
        "nodes",
        "assets",
        "revisions",
        `revision-${previous.revision + 1}`,
      );
      await mkdir(revisionDirectory, { recursive: true });
      const revisedPlanPath = path.join(revisionDirectory, "asset_plan.json");
      const revisedPlanContent = `${JSON.stringify(revisedPlan, null, 2)}\n`;
      await writeTextAtomically(revisedPlanPath, revisedPlanContent);
      const revisionRequest = {
        version: "video-factory/scene-revision-v1",
        reviewArtifactId: draft.reviewArtifactId,
        findingIndex: draft.findingIndex,
        scenePosition,
        reuseFromScenePosition: draft.reuseFromScenePosition,
        actor: draft.actor.trim(),
        note: draft.note.trim(),
      };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      const revised = runner.applyNodeRevision(definition, withExecutableBrief(previous, brief), {
        nodeId: "assets",
        actor: draft.actor.trim(),
        output: {
          ...currentAssetOutput,
          assetPlanPath: revisedPlanPath,
          currentMediaArtifactIds: retainedArtifactIds,
        },
        artifacts: [
          fileArtifact(
            "asset_plan",
            revisedPlanPath,
            revisedPlanContent,
            "application/json",
            assetPlanArtifact.schemaVersion ?? "video-factory/asset-plan-v1",
            "assets",
            [assetPlanArtifact.id, draft.reviewArtifactId],
            "human-scene-revision-v1",
            "Creator-requested reuse of an existing run asset; no new Provider call was made.",
          ),
          jsonArtifact(
            "scene_revision_request",
            revisionRequest,
            "video-factory/scene-revision-v1",
            "assets",
            [assetPlanArtifact.id, draft.reviewArtifactId],
          ),
        ],
        retainedArtifactIds,
        invalidateDescendantNodeIds: [
          "asset-source-review",
          // BG-07：assets 失效后 voice 是其后代——旁白时间线基于旧 asset plan 计算，
          // 不得沿用；后续 render/review 已在列表中。
          "voice",
          "render",
          "technical-review",
          "visual-review",
          "final-review",
          "publish-package",
        ],
        expectedVersionId: draft.expectedAssetVersionId,
        schemaVersion: assetVersion.schemaVersion,
        decision: {
          interventionId: finalIntervention.id,
          action: "request_changes",
          actor: draft.actor.trim(),
          note: draft.note.trim(),
        },
      });
      return revised;
    });
    return this.dispatchResumeStale(runId, listener);
  }

  async requestSceneResourceRevision(
    runId: string,
    draft: ProductionSceneResourceRevisionDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchSceneResourceRevision(runId, draft);
    return dispatched.completion;
  }

  async dispatchSceneResourceRevision(
    runId: string,
    draft: ProductionSceneResourceRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    await this.runPersistedTransition(runId, async (previous) => {
      if (previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (previous.status !== "needs_human") {
        throw new Error(`Run '${runId}' is not waiting for human review.`);
      }
      if (!draft.actor.trim() || !draft.note.trim()) {
        throw new Error("Scene resource revision actor and note are required.");
      }
      if (!Number.isInteger(draft.findingIndex) || draft.findingIndex < 0) {
        throw new Error("Scene resource revision finding index is invalid.");
      }

      const brief = parsePersistedBrief(previous.initialInput);
      const definition = this.createWorkflow(brief);
      const finalIntervention = previous.nodeRuns.find((node) => node.nodeId === "final-review")?.intervention;
      if (!finalIntervention) throw new Error("Scene resource revision requires an active final-review intervention.");
      const visualReviewNodeRun = previous.nodeRuns.find((node) => node.nodeId === "visual-review");
      const visualReviewVersion = visualReviewNodeRun?.outputState?.versions.find(
        (version) => version.id === visualReviewNodeRun.outputState?.effectiveVersionId,
      );
      const reviewArtifact = previous.artifacts.find((artifact) => artifact.id === draft.reviewArtifactId);
      if (
        !visualReviewVersion?.artifactIds.includes(draft.reviewArtifactId)
        || reviewArtifact?.kind !== "review_report"
        || reviewArtifact.producer?.nodeId !== "visual-review"
      ) {
        throw new Error("Scene resource revision requires a current visual-review report artifact.");
      }
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), reviewArtifact);
      const reviewOutput = requireOutputRecord(
        visualReviewVersion.output ?? visualReviewNodeRun?.output,
        "visual review output",
      );
      const reviewDurationMs = Number(reviewOutput.durationMs);
      if (!Number.isInteger(reviewDurationMs) || reviewDurationMs <= 0) {
        throw new Error("Current visual-review duration is invalid.");
      }
      const storedReportValue = JSON.parse(await readFile(reviewArtifact.uri!, "utf8"));
      assertCurrentVisualReviewContract(storedReportValue);
      const storedReport = validateAggregatedVisualReviewReport(storedReportValue, reviewDurationMs);
      if (draft.findingIndex >= storedReport.findings.length) {
        throw new Error("Scene resource revision finding is no longer current.");
      }

      const renderNodeRun = previous.nodeRuns.find((node) => node.nodeId === "render");
      const renderVersion = renderNodeRun?.outputState?.versions.find(
        (version) => version.id === renderNodeRun.outputState?.effectiveVersionId,
      );
      const renderOutput = requireOutputRecord(renderVersion?.output ?? renderNodeRun?.output, "render output");
      const renderManifestPath = requiredOutputString(renderOutput, "renderManifestPath");
      const renderManifestArtifact = previous.artifacts.find((artifact) => (
        renderVersion?.artifactIds.includes(artifact.id)
        && artifact.kind === "render_manifest"
        && artifact.uri === renderManifestPath
        && artifact.producer?.nodeId === "render"
      ));
      if (!renderManifestArtifact) {
        throw new Error("Scene resource revision requires the current render manifest artifact.");
      }
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), renderManifestArtifact);
      const localizedReport = await localizeVisualReviewReport(storedReport, renderManifestPath, reviewDurationMs);
      const finding = localizedReport.findings[draft.findingIndex]!;
      // 这条路径只处理"画面本身不合格"。审片把不合格指向别的节点（配音、时长）时，
      // 换素材既不是它要的动作，也解释不了它的结论。
      if (finding.targetNodeId !== "assets" || finding.nextAction !== "rework_asset") {
        throw new Error("Scene resource revision requires a finding that asks for the scene asset itself to be reworked.");
      }
      const scenePosition = finding.scenePosition;
      if (typeof scenePosition !== "number" || !Number.isInteger(scenePosition) || scenePosition < 1) {
        throw new Error("Scene resource revision finding is not localized to a scene.");
      }

      const joint = usesJointCreativePlanning(brief);
      const planningNodeId = joint ? "creative-planning" : "visual-direction";
      const planningNodeRun = previous.nodeRuns.find((node) => node.nodeId === planningNodeId);
      const planningVersion = planningNodeRun?.outputState?.versions.find(
        (version) => version.id === planningNodeRun.outputState?.effectiveVersionId,
      );
      if (!planningVersion) {
        throw new Error(`Scene resource revision requires the current '${planningNodeId}' output version.`);
      }
      const planningOutput = requireOutputRecord(
        planningVersion.output ?? planningNodeRun?.output,
        `${planningNodeId} output`,
      );
      const rankingPath = requiredOutputString(planningOutput, "candidateRankingPath");
      const rankingArtifact = previous.artifacts.find((artifact) => (
        planningVersion.artifactIds.includes(artifact.id)
        && artifact.uri === rankingPath
        && artifact.producer?.nodeId === planningNodeId
      ));
      if (!rankingArtifact) {
        throw new Error("Scene resource revision requires the current candidate ranking artifact.");
      }
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), rankingArtifact);
      const ranking = requireOutputRecord(
        JSON.parse(await readFile(rankingArtifact.uri!, "utf8")),
        "candidate ranking",
      );
      const advance = advanceSceneCandidateRanking(ranking, scenePosition);
      const revisionDirectory = path.join(
        this.runsRoot,
        runId,
        "nodes",
        planningNodeId,
        "revisions",
        `revision-${previous.revision + 1}`,
      );
      await mkdir(revisionDirectory, { recursive: true });
      const revisedRankingPath = path.join(revisionDirectory, "candidate_ranking.json");
      const revisedRankingContent = `${JSON.stringify(advance.ranking, null, 2)}\n`;
      await writeTextAtomically(revisedRankingPath, revisedRankingContent);
      const revisionRequest = {
        version: "video-factory/scene-resource-revision-v1",
        reviewArtifactId: draft.reviewArtifactId,
        findingIndex: draft.findingIndex,
        scenePosition,
        replacedProvider: advance.replaced.provider,
        replacedAssetId: advance.replaced.assetId,
        replacementProvider: advance.replacement.provider,
        replacementAssetId: advance.replacement.assetId,
        actor: draft.actor.trim(),
        note: draft.note.trim(),
      };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      // 失效从素材节点起：画面要换，素材必须重取，其下游全部作废。
      // 但改动只落在排序上——其它镜头的检索意图与候选一个字段都没动，
      // 已付费分镜的输入指纹因此不变，重跑时按原样带过，不产生新的 Provider 调用。
      const invasiveNodeIds = [
        "assets",
        "asset-source-review",
        "voice",
        "render",
        "technical-review",
        "visual-review",
        "final-review",
        "publish-package",
      ].filter((nodeId) => productionNodeIds(brief).includes(nodeId));
      const revised = runner.applyNodeRevision(definition, withExecutableBrief(previous, brief), {
        nodeId: planningNodeId,
        actor: draft.actor.trim(),
        output: {
          ...planningOutput,
          candidateRankingPath: revisedRankingPath,
        },
        artifacts: [
          fileArtifact(
            // 沿用被改那一份的 kind：素材节点按本拓扑的既有约定认排序，这里不该另发明一种。
            rankingArtifact.kind,
            revisedRankingPath,
            revisedRankingContent,
            "application/json",
            rankingArtifact.schemaVersion ?? "video-factory/asset-ranking-v1",
            planningNodeId,
            [rankingArtifact.id, draft.reviewArtifactId],
            "human-scene-resource-revision-v1",
            "Creator-requested reselection among this scene's already-reviewed candidates; no new Provider call was made.",
            rankingArtifact.producer?.attempt ?? 1,
          ),
          jsonArtifact(
            "scene_resource_revision_request",
            revisionRequest,
            "video-factory/scene-resource-revision-v1",
            planningNodeId,
            [rankingArtifact.id, draft.reviewArtifactId],
          ),
        ],
        // 原排序留在版本里：候选搜索与排序是那次规划的证据快照，人工改选是另立一件，
        // 与被改的那一版并列可查，而不是把原稿覆盖掉。
        retainedArtifactIds: planningVersion.artifactIds,
        invalidateDescendantNodeIds: invasiveNodeIds,
        expectedVersionId: planningVersion.id,
        schemaVersion: planningVersion.schemaVersion,
        decision: {
          interventionId: finalIntervention.id,
          action: "request_changes",
          actor: draft.actor.trim(),
          note: draft.note.trim(),
        },
      });
      return revised;
    });
    return this.dispatchResumeStale(runId, listener);
  }

  async requestNarrationRevision(
    runId: string,
    draft: ProductionNarrationRevisionDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchNarrationRevision(runId, draft);
    return dispatched.completion;
  }

  async dispatchNarrationRevision(
    runId: string,
    draft: ProductionNarrationRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    await this.runPersistedTransition(runId, async (previous) => {
      if (previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (previous.status !== "needs_human") {
        throw new Error(`Run '${runId}' is not waiting for human review.`);
      }
      if (!draft.actor.trim() || !draft.note.trim()) {
        throw new Error("Narration revision actor and note are required.");
      }
      if (!Number.isInteger(draft.scenePosition) || draft.scenePosition < 1) {
        throw new Error("Narration revision scene position is invalid.");
      }
      const narration = draft.narration.trim();
      if (!narration) {
        throw new Error("Narration revision text must not be empty.");
      }
      if (narration.length > 600 || /[\u0000-\u001f\u007f]/.test(narration)) {
        throw new Error("Narration revision text is not a valid single line of narration.");
      }

      const brief = parsePersistedBrief(previous.initialInput);
      const definition = this.createWorkflow(brief);
      const finalIntervention = previous.nodeRuns.find((node) => node.nodeId === "final-review")?.intervention;
      if (!finalIntervention) throw new Error("Narration revision requires an active final-review intervention.");

      // 脚本是配音与字幕共同的来源。改字要落在脚本上，否则下游仍会读到旧文字；
      // 但画面（assets）与画面预检不受这一行字影响，因此从失效清单里排除。
      const joint = usesJointCreativePlanning(brief);
      const planningNodeId = joint ? "creative-planning" : "script";
      const planningNodeRun = previous.nodeRuns.find((node) => node.nodeId === planningNodeId);
      const planningVersion = planningNodeRun?.outputState?.versions.find(
        (version) => version.id === planningNodeRun.outputState?.effectiveVersionId,
      );
      if (!planningVersion) throw new Error(`Narration revision requires the current '${planningNodeId}' output version.`);
      const planningOutput = requireOutputRecord(
        planningVersion.output ?? planningNodeRun?.output,
        `${planningNodeId} output`,
      );
      const scriptPath = requiredOutputString(planningOutput, "scriptPath");
      // 认产物看的是"它是不是这个节点写在 scriptPath 上的那一份"，而不是它的 kind：
      // AI 编剧产出的 kind 是 script，模板与 Python worker 拓扑下是 script_draft，两种都要能改。
      const scriptArtifact = previous.artifacts.find((artifact) => (
        planningVersion.artifactIds.includes(artifact.id)
        && artifact.uri === scriptPath
        && artifact.producer?.nodeId === planningNodeId
      ));
      if (!scriptArtifact) throw new Error("Narration revision requires the current script artifact.");
      await verifyStoredArtifactWithinRoot(this.store.runDirectory(runId), scriptArtifact);
      const script = requireOutputRecord(
        JSON.parse(await readFile(scriptPath, "utf8")),
        "script",
      );
      if (!Array.isArray(script.scenes)) throw new Error("Narration revision requires a script with scenes.");
      const sceneIndex = script.scenes.findIndex((scene) => (
        typeof scene === "object" && scene !== null && !Array.isArray(scene)
        && Number((scene as Record<string, unknown>).position) === draft.scenePosition
      ));
      if (sceneIndex < 0) {
        throw new Error(`Narration revision scene ${draft.scenePosition} is no longer in the current script.`);
      }
      const revisedScript = {
        ...script,
        // 第 1 镜的旁白同时是脚本的 hook 字段；只改旁白不改它，脚本会自相矛盾。
        ...(sceneIndex === 0 ? { hook: narration } : {}),
        scenes: script.scenes.map((scene, index) => (
          index === sceneIndex ? { ...requireOutputRecord(scene, `script scene ${index + 1}`), narration } : scene
        )),
      };
      const revisionDirectory = path.join(
        this.runsRoot,
        runId,
        "nodes",
        planningNodeId,
        "revisions",
        `revision-${previous.revision + 1}`,
      );
      await mkdir(revisionDirectory, { recursive: true });
      const revisedScriptPath = path.join(revisionDirectory, "script.json");
      const revisedScriptContent = `${JSON.stringify(revisedScript, null, 2)}\n`;
      await writeTextAtomically(revisedScriptPath, revisedScriptContent);
      const revisionRequest = {
        version: "video-factory/narration-revision-v1",
        scenePosition: draft.scenePosition,
        actor: draft.actor.trim(),
        note: draft.note.trim(),
      };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      // 失效范围是"读这一行字的下游"，收窄到配音以后：画面没变，重新买画面是纯浪费。
      // 计划里允许改文字的前提是别的一切照旧，所以镜位之外的字段一个都没动。
      const invasiveNodeIds = [
        "voice",
        "render",
        "technical-review",
        "visual-review",
        "final-review",
        "publish-package",
      // 按图里有没有这个节点来过滤，而不是按"跑没跑过"：还没轮到的下游（如 publish-package）
      // 同样是这一行字的下游，漏掉它会让失效集不闭合。
      ].filter((nodeId) => productionNodeIds(brief).includes(nodeId));
      const revised = runner.applyNodeRevision(definition, withExecutableBrief(previous, brief), {
        nodeId: planningNodeId,
        actor: draft.actor.trim(),
        output: {
          ...planningOutput,
          scriptPath: revisedScriptPath,
        },
        artifacts: [
          fileArtifact(
            // 沿用被改那一份的 kind：下游按本拓扑的既有约定认脚本，这里不该另发明一种。
            scriptArtifact.kind,
            revisedScriptPath,
            revisedScriptContent,
            "application/json",
            scriptArtifact.schemaVersion ?? "video-factory/script-draft-v1",
            planningNodeId,
            // 父级是被改的那一版原稿：如实记录"这行字从哪一版改来"，不冒充任何 Provider 产物。
            [scriptArtifact.id],
            "human-narration-revision-v1",
            "Creator-edited narration and caption text; no Provider call was made for the visuals.",
            scriptArtifact.producer?.attempt ?? 1,
          ),
          jsonArtifact(
            "narration_revision_request",
            revisionRequest,
            "video-factory/narration-revision-v1",
            planningNodeId,
            [scriptArtifact.id],
          ),
        ],
        // 被替换掉的原稿是否留在版本里，两种拓扑的答案不同：
        // legacy 的脚本节点只有脚本本身，直接换掉即可；
        // joint 的可执行方案按 artifact id 引用脚本，而方案的引用集受"必须同属规划节点当前
        // 接受版本"的约束（verifyExecutablePlanReferenceClosure）。方案是那次规划 commit 的
        // 证据快照——commit 文件里记的引用 id 与磁盘字节都要求方案继续指向原稿，方案本身也
        // 不该被人工改字动到。所以 joint 下原稿必须留在版本里：丢掉它，方案就引用了一份不在
        // 版本内的脚本，assets/voice 一消费方案就 fail closed（这正是生产里复现的失败）。
        // 人工改出来的新稿件另立一件，下游按 output.scriptPath 读新文字；方案的时长与镜位
        // 一个字段都没动，所以既不重编译、也不产生任何 Provider 调用与费用。
        retainedArtifactIds: planningVersion.artifactIds.filter((artifactId) => (
          joint || artifactId !== scriptArtifact.id
        )),
        invalidateDescendantNodeIds: invasiveNodeIds,
        expectedVersionId: planningVersion.id,
        schemaVersion: planningVersion.schemaVersion,
        decision: {
          interventionId: finalIntervention.id,
          action: "request_changes",
          actor: draft.actor.trim(),
          note: draft.note.trim(),
        },
      });
      return revised;
    });
    return this.dispatchResumeStale(runId, listener);
  }

  async applyNodeExecutionConfiguration(
    runId: string,
    nodeId: string,
    nextBriefInput: ProductionBrief,
    actor: string,
    expectedRunRevision?: number,
  ): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      const jointEdit = usesJointCreativePlanning(parsePersistedBrief(previous.initialInput));
      // B4 对外编辑合同（joint-v1）：caller revision 必填；legacy 保持既有可选行为。
      if (jointEdit && (!Number.isSafeInteger(expectedRunRevision) || Number(expectedRunRevision) < 0)) {
        throw new Error(`Joint planning execution configuration override for '${runId}' requires a non-negative expectedRunRevision.`);
      }
      // 与输入覆盖同一持锁复核合同：配置编辑不得用预检查后新加载的服务端 revision 代替
      // caller revision；两者不一致说明预检查后有并发写入，必须在写入前失败。
      if (expectedRunRevision !== undefined && previous.revision !== expectedRunRevision) {
        throw new StaleRunRevisionError(runId, expectedRunRevision, previous.revision);
      }
      const nextBrief = parseBrief(nextBriefInput);
      await assertNoUnresolvedPlanningTask(this.store.runDirectory(runId), previous);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(nextBrief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyExecutionConfigurationOverride(
        this.createWorkflow(nextBrief),
        previous,
        { nodeId, actor, initialInput: nextBrief },
      );
    });
  }

  async authorizeSpend(runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchSpendAuthorization(runId, authorization);
    return dispatched.completion;
  }

  async dispatchSpendAuthorization(
    runId: string,
    authorization: SpendAuthorizationDraft,
    listener?: ProductionRunListener,
    // C1：持锁 CAS 边界内的额外校验（如 scope head 未被 supersede 的复核）。
    // 在 runner 接受子凭证之前执行；抛错即整个派发事务失败、零副作用。
    guard?: (previous: WorkflowRun<ProductionBrief>) => Promise<void>,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      if (guard) await guard(previous);
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.authorizeSpend(this.createWorkflow(brief), withExecutableBrief(previous, brief), authorization);
    }, listener);
  }

  async rejectSpend(runId: string, rejection: ProductionSpendRejectionDraft): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchSpendRejection(runId, rejection);
    return dispatched.completion;
  }

  async dispatchSpendRejection(
    runId: string,
    rejection: ProductionSpendRejectionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      if (previous.status !== "awaiting_spend_approval" && previous.status !== "approval_invalidated") {
        throw new Error(`Run '${runId}' is not waiting for spend approval.`);
      }
      if (rejection.nodeId !== "assets" || !brief.director) {
        throw new Error("Only an AI-directed asset quote can be returned to the director for replanning.");
      }
      if (!rejection.rejectedBy.trim()) throw new Error("Spend rejection actor is required.");
      if (!["too_expensive", "provider_mix", "plan_not_approved", "other"].includes(rejection.reason)) {
        throw new Error("Spend rejection reason is invalid.");
      }
      if (rejection.note !== undefined && (!rejection.note.trim() || rejection.note.trim().length > 1_000)) {
        throw new Error("Spend rejection note must contain between 1 and 1000 characters.");
      }
      if (rejection.targetEstimatedCostCny !== undefined
        && (!Number.isFinite(rejection.targetEstimatedCostCny) || rejection.targetEstimatedCostCny < 0 || rejection.targetEstimatedCostCny > 100_000)) {
        throw new Error("Spend rejection target estimate must be a finite non-negative amount.");
      }
      const waitingNode = previous.nodeRuns.find((node) => node.nodeId === rejection.nodeId);
      const plan = waitingNode?.spendPlan;
      if (!plan || plan.id !== rejection.spendPlanId
        || (waitingNode.status !== "awaiting_spend_approval" && waitingNode.status !== "approval_invalidated")) {
        throw new Error("Spend rejection does not match the active quote.");
      }
      if (rejection.reason === "too_expensive"
        && rejection.targetEstimatedCostCny !== undefined
        && rejection.targetEstimatedCostCny >= plan.estimatedCostCny) {
        throw new Error("Spend rejection target estimate must be lower than the active quote.");
      }
      const nextBrief = parseBrief({
        ...brief,
        spendFeedback: [
          ...(brief.spendFeedback ?? []),
          {
            spendPlanId: plan.id,
            nodeId: rejection.nodeId,
            reason: rejection.reason,
            previousEstimatedCostCny: plan.estimatedCostCny,
            ...(rejection.targetEstimatedCostCny !== undefined
              ? { targetEstimatedCostCny: rejection.targetEstimatedCostCny }
              : {}),
            ...(rejection.note ? { note: rejection.note.trim() } : {}),
            rejectedBy: rejection.rejectedBy.trim(),
            rejectedAt: this.clock(),
          },
        ].slice(-20),
      });
      const runner = new WorkflowRunner({
        providers: this.createRegistry(nextBrief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      const stale = runner.applyExecutionConfigurationOverride(
        this.createWorkflow(nextBrief),
        withExecutableBrief(previous, brief),
        {
          // joint-v1 拓扑没有独立 visual-direction 节点：报价退回的失效目标是 creative-planning。
          nodeId: usesJointCreativePlanning(nextBrief) ? "creative-planning" : "visual-direction",
          actor: rejection.rejectedBy.trim(),
          initialInput: nextBrief,
        },
      );
      return stale;
    }, listener);
  }

  async resumeStale(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchResumeStale(runId);
    return dispatched.completion;
  }

  async dispatchResumeStale(
    runId: string,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    const dispatched = await this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.resumeStale(this.createWorkflow(brief), withExecutableBrief(previous, brief));
    }, listener);
    return this.continueCoveredSpendApproval(runId, dispatched, listener);
  }

  async retryFailedNode(
    runId: string,
    nodeId: string,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchRetryFailedNode(runId, nodeId, undefined, options);
    return dispatched.completion;
  }

  async reconcilePaidNode(
    runId: string,
    draft: ProductionPaidNodeReconciliationDraft,
    options?: { settleOnly?: boolean },
  ): Promise<WorkflowRun<ProductionBrief>> {
    if (!draft.nodeId.trim()) throw new Error("Paid reconciliation node id is required.");
    if (!draft.reconciliationId.trim() || draft.reconciliationId.trim().length > 128) {
      throw new Error("Paid reconciliation id must contain between 1 and 128 characters.");
    }
    if (!["resume_original", "requote", "confirmed_not_charged", "confirmed_charged"].includes(draft.outcome)) {
      throw new Error("Paid reconciliation outcome is invalid.");
    }
    const taskId = draft.taskId?.trim();
    if (draft.taskId !== undefined && (!taskId || taskId.length > 256)) {
      throw new Error("Paid reconciliation task id must contain between 1 and 256 characters.");
    }
    if (taskId && draft.outcome !== "resume_original") {
      throw new Error("A provider task id can only resume the original paid operation.");
    }
    const manualResolution = draft.outcome === "confirmed_not_charged" || draft.outcome === "confirmed_charged";
    if (options?.settleOnly === true && !manualResolution) {
      throw new Error("Settle-only paid reconciliation requires a confirmed manual outcome.");
    }
    const itemRequestId = draft.itemRequestId?.trim();
    if (draft.itemRequestId !== undefined && (!itemRequestId || itemRequestId.length > 256)) {
      throw new Error("Paid reconciliation item request id must contain between 1 and 256 characters.");
    }
    if (itemRequestId && (draft.nodeId !== "assets" || !manualResolution)) {
      throw new Error("A paid item can only be selected when manually reconciling an asset operation.");
    }
    const actor = draft.actor?.trim();
    const note = draft.note?.trim();
    if (manualResolution && (!actor || actor.length > 160)) {
      throw new Error("Paid manual reconciliation actor must contain between 1 and 160 characters.");
    }
    if (manualResolution && (!note || note.length > 2_000)) {
      throw new Error("Paid manual reconciliation note must contain between 1 and 2000 characters.");
    }
    if (!manualResolution && (draft.actor !== undefined || draft.note !== undefined || draft.actualCostCny !== undefined)) {
      throw new Error("Manual reconciliation evidence is only valid for a confirmed manual outcome.");
    }
    if (draft.actualCostCny !== undefined && (
      draft.outcome !== "confirmed_charged"
      || !Number.isFinite(draft.actualCostCny)
      || draft.actualCostCny < 0
    )) {
      throw new Error("Paid reconciliation actual cost must be a finite non-negative amount for a confirmed charge.");
    }
    if (!Number.isInteger(draft.expectedRunRevision) || draft.expectedRunRevision < 0) {
      throw new Error("Paid reconciliation expected run revision must be a non-negative integer.");
    }
    const lease = await this.acquireExecutionLease(runId);
    try {
      await this.assertExecutionLease(lease);
      const previous = await this.store.load<ProductionBrief>(runId);
      const recordPath = this.paidReconciliationPath(runId, draft.reconciliationId.trim());
      const existingRecord = await readPaidNodeReconciliationRecord(recordPath);
      if (existingRecord && (
        existingRecord.reconciliationId !== draft.reconciliationId.trim()
        || existingRecord.nodeId !== draft.nodeId
        || existingRecord.outcome !== draft.outcome
        || existingRecord.itemRequestId !== itemRequestId
        || existingRecord.taskId !== taskId
        || existingRecord.expectedRunRevision !== draft.expectedRunRevision
        || existingRecord.actor !== actor
        || existingRecord.note !== note
        || existingRecord.reportedActualCostCny !== draft.actualCostCny
      )) {
        throw new Error(`Paid reconciliation '${draft.reconciliationId}' conflicts with its persisted request.`);
      }
      if (existingRecord?.status === "completed") return previous;
      if (existingRecord?.status === "in_progress" && previous.revision !== existingRecord.expectedRunRevision) {
        const currentNode = previous.nodeRuns.find((node) => node.nodeId === draft.nodeId);
        if (!currentNode?.outcomeUncertain) {
          await this.assertExecutionLease(lease);
          await writePaidNodeReconciliationRecord(recordPath, {
            ...existingRecord,
            status: "completed",
            resultingRunRevision: previous.revision,
          });
          return previous;
        }
      }
      if (!existingRecord && previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      const previousNode = previous.nodeRuns.find((node) => node.nodeId === draft.nodeId);
      if (!previousNode || previousNode.status !== "failed" || !previousNode.outcomeUncertain) {
        throw new Error(`Node '${draft.nodeId}' has no uncertain paid-provider outcome to reconcile.`);
      }
      if (draft.nodeId !== "assets" && draft.nodeId !== "voice" && !manualResolution) {
        throw new PaidOperationManualReconciliationError(draft.nodeId, []);
      }
      const operationId = previousNode.operationRequestId;
      const nodeDirectory = path.join(this.runsRoot, runId, "nodes", draft.nodeId);
      let items = operationId
        && draft.nodeId === "assets"
        ? (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId)
        : [];
      if (
        draft.outcome === "requote"
        && operationId
        && draft.nodeId === "assets"
        && isTrustedPreSubmissionAssetRejection(previousNode, items)
        && items.length > 0
      ) {
        await this.assertExecutionLease(lease);
        await markPaidAssetPreSubmissionRejections(nodeDirectory, operationId);
        items = (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId);
      }
      let voiceOperation = operationId && draft.nodeId === "voice"
        ? await readPaidVoiceOperation(nodeDirectory, operationId)
        : undefined;
      let manualAssetItem: PaidAssetLedgerItemSummary | undefined;
      let manualAssetItemAlreadyResolved = false;
      if (manualResolution && draft.nodeId === "assets" && items.length > 0) {
        if (!itemRequestId) {
          throw new Error("人工核对素材账单时必须选择一个具体镜头，不能整批标记。");
        }
        const matchingItems = items.filter((item) => item.itemRequestId === itemRequestId);
        if (matchingItems.length !== 1) {
          throw new Error(`Paid reconciliation item '${itemRequestId}' does not uniquely identify an item in the active operation.`);
        }
        const matchingItem = matchingItems[0]!;
        manualAssetItem = matchingItem;
        const expectedResolutionError = draft.outcome === "confirmed_charged"
          ? confirmedChargedAssetItemError(draft.reconciliationId.trim())
          : confirmedNotChargedAssetItemError(draft.reconciliationId.trim());
        manualAssetItemAlreadyResolved = Boolean(existingRecord
          && matchingItem.state === "terminal_failed"
          && (existingRecord.actualCostCny === undefined
            ? matchingItem.actualCostCny === undefined
            : matchingItem.actualCostCny === roundCurrency(existingRecord.actualCostCny))
          && matchingItem.error === expectedResolutionError);
        if (!manualAssetItemAlreadyResolved && !paidAssetItemNeedsManualReconciliation(matchingItem)) {
          throw new Error(
            `Paid item '${itemRequestId}' has a recoverable result or is not awaiting manual charge reconciliation.`,
          );
        }
      } else if (itemRequestId) {
        throw new Error(`Paid reconciliation item '${itemRequestId}' is not present in the active operation.`);
      }
      let resumeOriginalOperation = false;
      if (draft.outcome === "resume_original" || draft.outcome === "requote") {
        if (!operationId) {
          throw new PaidOperationManualReconciliationError(draft.nodeId, items);
        }
        if (draft.nodeId === "assets") {
          const trustedPreSubmissionRejection = isTrustedPreSubmissionAssetRejection(previousNode, items);
          if (items.length === 0 && !trustedPreSubmissionRejection) {
            throw new PaidOperationManualReconciliationError(draft.nodeId, items);
          }
          const missingTaskItems = items.filter((item) => (
            (item.state === "submitted" || item.state === "unknown") && !item.taskId
          ));
          const matchingTaskItems = taskId ? items.filter((item) => item.taskId === taskId) : [];
          if (taskId && !(
            (missingTaskItems.length === 1 && matchingTaskItems.length === 0)
            || (missingTaskItems.length === 0 && matchingTaskItems.length === 1)
          )) {
            throw new Error("A provider task id can only be attached when exactly one unresolved paid item is missing it.");
          }
          const missingQueryableTask = items.some((item) => (
            (item.state === "submitted" || item.state === "unknown")
            && !item.taskId
            && (!taskId || item.itemRequestId !== missingTaskItems[0]?.itemRequestId)
          ) || (
            item.state === "provider_succeeded" && !item.taskId
          ));
          if (missingQueryableTask) {
            throw new PaidOperationManualReconciliationError(draft.nodeId, items);
          }
          resumeOriginalOperation = items.some((item) => (
            item.state === "submitted"
            || item.state === "provider_succeeded"
            || item.state === "unknown"
          )) || items.every((item) => item.state === "materialized");
          if (trustedPreSubmissionRejection && items.length === 0) resumeOriginalOperation = false;
        } else if (draft.nodeId === "voice") {
          if (!voiceOperation || !canResumePaidVoiceOperation(voiceOperation)) {
            throw new PaidOperationManualReconciliationError(draft.nodeId, []);
          }
          if (taskId) throw new Error("Voice reconciliation does not accept a Provider task id.");
          resumeOriginalOperation = true;
        } else {
          throw new PaidOperationManualReconciliationError(draft.nodeId, []);
        }
        const resolvedOutcome = resumeOriginalOperation ? "resume_original" : "requote";
        if (draft.outcome !== resolvedOutcome) {
          throw new Error(
            `Paid reconciliation '${draft.reconciliationId}' requested '${draft.outcome}' but the ledger requires '${resolvedOutcome}'.`,
          );
        }
      }
      const confirmedActualCostCny = draft.outcome === "confirmed_charged"
        ? draft.actualCostCny
          ?? manualAssetItem?.estimatedCostCny
          ?? originalPaidEstimate(previous, previousNode)
        : undefined;
      if (draft.outcome === "confirmed_charged" && confirmedActualCostCny === undefined) {
        throw new Error("Paid reconciliation actual cost is required because the original estimate is unavailable.");
      }
      const settlementActualCostSource = draft.outcome === "confirmed_charged" && draft.actualCostCny !== undefined
        ? "manual_reconciled"
        : previousNode.executionReceipt?.actualCostSource === "provider_reported"
          || previousNode.executionReceipt?.actualCostSource === "manual_reconciled"
          ? previousNode.executionReceipt.actualCostSource
          : "configured_rate";
      const reconciliationRecord: PaidNodeReconciliationRecord = existingRecord ?? {
        version: "video-factory/paid-reconciliation-v1",
        reconciliationId: draft.reconciliationId.trim(),
        nodeId: draft.nodeId,
        outcome: draft.outcome,
        ...(itemRequestId ? { itemRequestId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(actor ? { actor } : {}),
        ...(note ? { note } : {}),
        ...(confirmedActualCostCny !== undefined ? { actualCostCny: confirmedActualCostCny } : {}),
        ...(draft.actualCostCny !== undefined ? { reportedActualCostCny: draft.actualCostCny } : {}),
        expectedRunRevision: previous.revision,
        status: "in_progress",
        createdAt: this.clock(),
      };
      if (!existingRecord) {
        await this.assertExecutionLease(lease);
        await writePaidNodeReconciliationRecord(recordPath, reconciliationRecord);
      }
      if (draft.outcome === "confirmed_charged" && manualAssetItem && operationId) {
        if (!manualAssetItemAlreadyResolved) {
          await this.assertExecutionLease(lease);
          await markPaidAssetItemCharged(
            nodeDirectory,
            operationId,
            manualAssetItem.itemRequestId,
            reconciliationRecord.reconciliationId,
            confirmedActualCostCny!,
            draft.actualCostCny !== undefined ? "manual_reconciled" : "configured_rate",
          );
        }
        items = (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId);
      } else if (draft.outcome === "confirmed_charged") {
        const result = applyConfirmedChargedResolution(
          previous,
          draft.nodeId,
          operationId,
          confirmedActualCostCny!,
          settlementActualCostSource,
          this.clock(),
        );
        if (options?.settleOnly === true) {
          const settledNode = result.nodeRuns.find((node) => node.nodeId === draft.nodeId)!;
          delete settledNode.spendPlan;
          settledNode.error = "这笔历史付费任务已完成账单结算；旧版制作不会恢复执行，请创建新版本继续制作。";
        }
        await this.assertExecutionLease(lease);
        await this.store.save(result, previous.revision);
        await this.assertExecutionLease(lease);
        await writePaidNodeReconciliationRecord(recordPath, {
          ...reconciliationRecord,
          status: "completed",
          resultingRunRevision: result.revision,
        });
        return result;
      }
      if (taskId && operationId) {
        if (draft.nodeId !== "assets") throw new Error("A provider task id can only reconcile a paid asset operation.");
        await this.assertExecutionLease(lease);
        items = await attachPaidAssetTaskId(nodeDirectory, operationId, taskId, items);
      }
      if (draft.outcome === "confirmed_not_charged" && operationId && manualAssetItem) {
        if (!manualAssetItemAlreadyResolved) {
          await this.assertExecutionLease(lease);
          await markPaidAssetItemNotCharged(
            nodeDirectory,
            operationId,
            manualAssetItem.itemRequestId,
            reconciliationRecord.reconciliationId,
          );
        }
        items = (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId);
      }
      if (draft.outcome === "confirmed_not_charged" && voiceOperation) {
        await this.assertExecutionLease(lease);
        voiceOperation = await markPaidVoiceItemsNotCharged(nodeDirectory, voiceOperation);
      }
      if (manualAssetItem && items.some((item) => (
        item.itemRequestId !== manualAssetItem.itemRequestId
        && (
          (item.state === "submitted" || item.state === "unknown") && Boolean(item.taskId)
          || item.state === "provider_succeeded" && Boolean(item.taskId) && !item.resultUrl
        )
      ))) {
        resumeOriginalOperation = true;
      }
      const retrySource = structuredClone(previous);
      const settlement = draft.nodeId === "assets"
        ? paidAssetSettlement(items)
        : draft.nodeId === "voice" && voiceOperation
          ? paidVoiceSettlement(voiceOperation)
          : { actualCostCny: 0, meteredAttemptCount: 0, meteredFailedAttemptCount: 0 };
      settlePaidOperationReceipt(
        retrySource,
        draft.nodeId,
        operationId,
        settlement.actualCostCny,
        settlement.meteredAttemptCount,
        settlement.meteredFailedAttemptCount,
        this.clock(),
        settlementActualCostSource,
      );
      const retryNode = retrySource.nodeRuns.find((node) => node.nodeId === draft.nodeId)!;
      if (draft.nodeId === "voice" && draft.outcome === "confirmed_not_charged") {
        const authorizationId = retryNode.spendAuthorizationId;
        if (authorizationId) {
          const consumed = (retrySource.consumedSpendAuthorizationIds ??= []);
          if (!consumed.includes(authorizationId)) consumed.push(authorizationId);
        }
        retryNode.status = "failed";
        retryNode.error = options?.settleOnly === true
          ? "这笔历史付费任务已完成账单结算；旧版制作不会恢复执行，请创建新版本继续制作。"
          : "配音请求已按服务商明确拒绝结清；请先调整配音设置，再点击“重试失败步骤”创建新任务。";
        retryNode.finishedAt = this.clock();
        delete retryNode.spendAuthorizationId;
        if (options?.settleOnly === true) delete retryNode.spendPlan;
        delete retryNode.outcomeUncertain;
        delete retryNode.interrupted;
        delete retryNode.operationRequestId;
        retrySource.revision += 1;
        retrySource.status = "failed";
        retrySource.finishedAt = this.clock();
        await this.assertExecutionLease(lease);
        await this.store.save(retrySource, previous.revision);
        await this.assertExecutionLease(lease);
        await writePaidNodeReconciliationRecord(recordPath, {
          ...reconciliationRecord,
          status: "completed",
          resultingRunRevision: retrySource.revision,
        });
        return retrySource;
      }
      const remainingManualAssetItems = manualAssetItem
        ? items.filter((item) => paidAssetItemNeedsManualReconciliation(item))
        : [];
      if (remainingManualAssetItems.length > 0) {
        const authorizationId = retryNode.spendAuthorizationId;
        if (authorizationId) {
          const consumed = (retrySource.consumedSpendAuthorizationIds ??= []);
          if (!consumed.includes(authorizationId)) consumed.push(authorizationId);
        }
        delete retryNode.spendAuthorizationId;
        retryNode.status = "failed";
        retryNode.operationRequestId = operationId!;
        retryNode.outcomeUncertain = true;
        retryNode.interrupted = true;
        retrySource.revision += 1;
        retrySource.status = "failed";
        retrySource.finishedAt = this.clock();
        await this.assertExecutionLease(lease);
        await this.store.save(retrySource, previous.revision);
        await this.assertExecutionLease(lease);
        await writePaidNodeReconciliationRecord(recordPath, {
          ...reconciliationRecord,
          status: "completed",
          resultingRunRevision: retrySource.revision,
        });
        return retrySource;
      }
      if (options?.settleOnly === true) {
        const authorizationId = retryNode.spendAuthorizationId;
        if (authorizationId) {
          const consumed = (retrySource.consumedSpendAuthorizationIds ??= []);
          if (!consumed.includes(authorizationId)) consumed.push(authorizationId);
        }
        delete retryNode.spendAuthorizationId;
        delete retryNode.spendPlan;
        delete retryNode.outcomeUncertain;
        delete retryNode.interrupted;
        delete retryNode.operationRequestId;
        retryNode.status = "failed";
        retryNode.error = "这笔历史付费任务已完成账单结算；旧版制作不会恢复执行，请创建新版本继续制作。";
        retryNode.finishedAt = this.clock();
        retrySource.revision += 1;
        retrySource.status = "failed";
        retrySource.finishedAt = this.clock();
        await this.assertExecutionLease(lease);
        await this.store.save(retrySource, previous.revision);
        await this.assertExecutionLease(lease);
        await writePaidNodeReconciliationRecord(recordPath, {
          ...reconciliationRecord,
          status: "completed",
          resultingRunRevision: retrySource.revision,
        });
        return retrySource;
      }
      if (resumeOriginalOperation) {
        retryNode.interrupted = true;
      } else {
        delete retryNode.outcomeUncertain;
        delete retryNode.interrupted;
        delete retryNode.operationRequestId;
      }

      const brief = parsePersistedBrief(retrySource.initialInput);
      let persisted = false;
      let persistedRevision = previous.revision;
      const checkpoint = async (run: WorkflowRun<ProductionBrief>) => {
        await this.assertExecutionLease(lease);
        if (run.revision === persistedRevision + 1) {
          await this.store.save(run, persistedRevision);
          persisted = true;
          persistedRevision = run.revision;
          return;
        }
        if (run.revision !== persistedRevision) {
          throw new StaleRunRevisionError(run.id, run.revision, persistedRevision);
        }
        await this.store.checkpoint(run);
      };
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      let result = await runner.retryFailedNode(
        this.createWorkflow(brief),
        withExecutableBrief(retrySource, brief),
        draft.nodeId,
        resumeOriginalOperation ? { resumeUncertainOperation: true } : undefined,
      );
      if (draft.nodeId === "assets" && operationId && resumeOriginalOperation) {
        items = (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId);
        const hasManualTerminalItem = items.some((item) => (
          item.state === "terminal_failed"
          && item.error?.startsWith("Manual reconciliation '")
        ));
        const unresolvedItems = items.filter((item) => (
          item.state === "submitted"
          || item.state === "unknown"
          || item.state === "provider_succeeded" && (!item.taskId || !item.resultUrl)
        ));
        const recoveryNode = result.nodeRuns.find((node) => node.nodeId === draft.nodeId);
        if (unresolvedItems.length > 0 && recoveryNode?.status === "failed") {
          const lockedNode = recoveryNode;
          const updatedSettlement = paidAssetSettlement(items);
          settlePaidOperationReceipt(
            result,
            draft.nodeId,
            operationId,
            updatedSettlement.actualCostCny,
            updatedSettlement.meteredAttemptCount,
            updatedSettlement.meteredFailedAttemptCount,
            this.clock(),
            settlementActualCostSource,
          );
          lockedNode.status = "failed";
          lockedNode.operationRequestId = operationId;
          lockedNode.outcomeUncertain = true;
          lockedNode.interrupted = true;
          result.status = "failed";
          result.finishedAt ??= this.clock();
          await this.assertExecutionLease(lease);
          await this.store.checkpoint(result);
        } else if (hasManualTerminalItem && unresolvedItems.length === 0 && recoveryNode?.status === "failed") {
          const completedRecoveryNode = recoveryNode;
          const readyForRequote = items.length > 0 && items.every((item) => (
            item.state === "materialized"
            || item.state === "provider_succeeded" && Boolean(item.taskId) && Boolean(item.resultUrl)
            || item.state === "terminal_failed"
          ));
          if (!completedRecoveryNode || completedRecoveryNode.status !== "failed" || !readyForRequote) {
            throw new Error("Paid asset recovery did not reach a safe state for a new quote.");
          }
          const requoteSource = structuredClone(result);
          const updatedSettlement = paidAssetSettlement(items);
          settlePaidOperationReceipt(
            requoteSource,
            draft.nodeId,
            operationId,
            updatedSettlement.actualCostCny,
            updatedSettlement.meteredAttemptCount,
            updatedSettlement.meteredFailedAttemptCount,
            this.clock(),
            settlementActualCostSource,
          );
          const requoteNode = requoteSource.nodeRuns.find((node) => node.nodeId === draft.nodeId)!;
          delete requoteNode.outcomeUncertain;
          delete requoteNode.interrupted;
          delete requoteNode.operationRequestId;
          result = await runner.retryFailedNode(
            this.createWorkflow(brief),
            withExecutableBrief(requoteSource, brief),
            draft.nodeId,
          );
        }
      }
      if (!persisted) {
        await this.assertExecutionLease(lease);
        await this.store.save(result, previous.revision);
      }
      await this.assertExecutionLease(lease);
      await writePaidNodeReconciliationRecord(recordPath, {
        ...reconciliationRecord,
        status: "completed",
        resultingRunRevision: result.revision,
      });
      return result;
    } finally {
      await this.releaseExecutionLease(lease);
    }
  }

  // C1：接受制作范围授权（用户确认方案/追加额度的业务许可）。校验全部在宿主内完成——
  // approvalRevision 必须等于当前 run revision（lease 内单写者核验），supersedes 必须指向
  // 本 run 已接受的授权，不接受重复 id。记录原子落盘，不注册为节点产物（宿主级许可）。
  async acceptProductionAuthorization(runId: string, scopeInput: unknown): Promise<WorkflowRun<ProductionBrief>> {
    const updated = await this.runPersistedTransition(runId, async (previous) => {
      const scope = parseProductionAuthorizationScope(scopeInput);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.id)) {
        throw new Error("Production authorization id must be a filename-safe identifier (letters, digits, underscore, hyphen; max 128).");
      }
      if (scope.supersedesAuthorizationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(scope.supersedesAuthorizationId)) {
        throw new Error("Production authorization supersedes id must be a filename-safe identifier.");
      }
      if (scope.runId !== previous.id) {
        throw new Error(`Production authorization '${scope.id}' belongs to run '${scope.runId}', not '${previous.id}'.`);
      }
      if (scope.approvalRevision !== previous.revision) {
        throw new StaleRunRevisionError(runId, scope.approvalRevision, previous.revision);
      }
      const directory = path.join(this.runsRoot, runId, "production-authorization");
      const destination = path.join(directory, `${scope.id}.json`);
      const scopeContent = `${JSON.stringify(scope, null, 2)}\n`;
      const committedRecords = productionAuthorizationRecords(previous.artifacts);
      const committedScopeIds = new Set(committedRecords.map((record) => record.id));
      try {
        const existing = await readFile(destination, "utf8");
        if (existing !== scopeContent || committedScopeIds.has(scope.id)) {
          throw new Error(`Production authorization '${scope.id}' has already been accepted with different state.`);
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      // 链完整性无条件校验（与读取共用同一严格校验器，含内容摘要/身份/前驱/环检查）：
      // 目录里已有授权时，新授权必须 supersede 当前 head（唯一幸存者）；未提供前驱只允许
      // 在尚无任何授权时（首份）。损坏链返回 integrity_error 并 fail closed。
      const chain = await inspectProductionAuthorizationChain(directory, previous.id, committedRecords);
      if (chain.state === "integrity_error") {
        throw new Error(
          `Production authorization chain of run '${previous.id}' failed integrity validation (${chain.reason}); refusing to accept '${scope.id}'.`,
        );
      }
      const currentHeadId = chain.state === "committed" ? chain.head.id : undefined;
      if (scope.supersedesAuthorizationId) {
        if (currentHeadId !== scope.supersedesAuthorizationId) {
          throw new Error(
            `Production authorization '${scope.id}' must supersede the current active authorization '${currentHeadId ?? "none"}', not '${scope.supersedesAuthorizationId}'.`,
          );
        }
      } else if (currentHeadId !== undefined) {
        throw new Error(
          `Production authorization '${scope.id}' must supersede the current active authorization '${currentHeadId}'; the run already holds an active authorization.`,
        );
      }
      await writeTextAtomically(destination, scopeContent);
      // 接受授权是 run 状态变化：revision + 1，使后续追加/编辑的 approvalRevision 重新对齐。
      return {
        ...previous,
        revision: previous.revision + 1,
        artifacts: [
          ...previous.artifacts,
          {
            id: `production-authorization:${scope.id}`,
            kind: "production_authorization",
            uri: destination,
            createdAt: this.clock(),
            provenance: {
              providerId: "video-factory-production-authorization",
              producerRequestDigest: createHash("sha256").update(scopeContent).digest("hex"),
            },
            sha256: createHash("sha256").update(scopeContent).digest("hex"),
            sizeBytes: Buffer.byteLength(scopeContent),
            contentType: "application/json",
            schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
          },
        ],
      };
    });
    // transition 之外续链（lease 已释放）：若 run 正停在报价等待且该授权完全覆盖当前报价，
    // 立即派生子凭证继续制作；未覆盖则保持人工等待。继续链失败按原语义冒泡（授权已落盘，不回滚）。
    if (updated.status === "awaiting_spend_approval" || updated.status === "approval_invalidated") {
      return this.continueCoveredSpendApproval(runId, { runId, completion: Promise.resolve(updated) }).completion;
    }
    return updated;
  }

  // 当前有效的制作范围授权：已被追加替代的授权不再生效，取最新接受的一份。
  // 与接受路径共用同一严格链校验器（内容摘要/身份/前驱/环全覆盖）；损坏链抛完整性
  // 错误，绝不按"尚无授权"处理。
  async readProductionAuthorization(runId: string): Promise<ProductionAuthorizationScope | undefined> {
    const directory = path.join(this.runsRoot, runId, "production-authorization");
    const run = await this.store.load<ProductionBrief>(runId);
    const chain = await inspectProductionAuthorizationChain(
      directory,
      runId,
      productionAuthorizationRecords(run.artifacts),
    );
    if (chain.state === "integrity_error") {
      throw new Error(`Production authorization state of run '${runId}' failed integrity validation (${chain.reason}).`);
    }
    if (chain.state === "absent") return undefined;
    return chain.head;
  }

  // C1：报价等待的制作范围自动继续（可信宿主派生子凭证，复用既有 authorizeSpend，不新建
  // 第二套授权路径）。覆盖评估锚定当前 executable plan 内容 digest（方案变了必须重新确认）
  // 与质量合同投影；逐项核验 assetKey/模型/金额/次数，余额按 paid ledger 保守汇总。
  // 派生的子凭证与当前报价计划在 matcher 逐字段一致（maxCostCny/maxAttempts 不再收窄——
  // 收窄过的凭证必然被原 exact matcher 拒绝）；scope 逐素材次数预算经 itemCreateBudgets
  // 随子凭证下发，由 worker 在每个 create 边界强制执行。任何一项不覆盖都保持人工等待，
  // 并把结构化 assessment 落到等待节点供 C2 展示。
  private continueCoveredSpendApproval(
    runId: string,
    dispatched: DispatchedProductionRun,
    listener?: ProductionRunListener,
  ): DispatchedProductionRun {
    // 惰性链：不阻塞 dispatch 返回（调用方依赖“首检查点后立即返回”的合同）；
    // completion 落定后才检查是否可凭 scope 自动继续。
    const chained: Promise<WorkflowRun<ProductionBrief>> = (async () => {
      let current = dispatched;
      for (let hop = 0; hop < 8; hop += 1) {
        const run = await current.completion;
        if (run.status !== "awaiting_spend_approval" && run.status !== "approval_invalidated") return run;
        // 损坏授权链在此抛完整性错误（fail closed），绝不当作"尚无授权"继续。
        const scope = await this.readProductionAuthorization(runId);
        if (!scope) return run;
        const waiting = run.nodeRuns.find((node) => (
          (node.status === "awaiting_spend_approval" || node.status === "approval_invalidated") && node.spendPlan
        ));
        const plan = waiting?.spendPlan;
        if (!plan) return run;
        // 唯一 ledger 快照：覆盖判定与派生预算共用同一次读取——第二次读取失败被
        // 当作零占用会让"次数/余额已消耗"凭空消失（审计 N6 残留）。
        const ledgerSnapshot = await inspectPaidAssetLedger(
          path.join(this.runsRoot, runId, "nodes", plan.nodeId),
        ).catch(() => null);
        const result = await assessProductionScopePendingQuote({
          scope,
          run,
          runsRoot: this.runsRoot,
          spendPlan: plan,
          paidItems: ledgerSnapshot,
        });
        if (!result.covered) {
          if (result.assessment) {
            // 评估已持久化：返回更新后的 run（内存里的 run 快照不含新写入的 assessment）。
            const updated = await this.recordNodeSpendAssessment(runId, plan.nodeId, run.revision, result.assessment);
            if (updated) return updated;
          }
          return run;
        }
        const foldedLedger = foldProductionSpendLedger(ledgerSnapshot ?? [], {
          terminalOperationIds: terminalPaidOperationIds(run, plan.nodeId),
        });
        // 逐素材剩余 create 预算（scope 用户批准的每素材上限 - ledger 已用次数）。
        // 全覆盖评估保证每个新 create 项至少剩 1 次；预算随子凭证下发，由 worker 在
        // create 边界执行——收窄发生在预留层，不改动必须与报价计划逐字段一致的凭证。
        const itemCreateBudgets: Record<string, number> = {};
        for (const quoteItem of plan.items ?? []) {
          const permitted = scope.permittedAssets.find((asset) => asset.assetKey === quoteItem.id);
          if (!permitted) continue;
          const remaining = permitted.maxCreateAttempts - (foldedLedger.attemptsByAsset[quoteItem.id] ?? 0);
          if (remaining >= 1) itemCreateBudgets[quoteItem.id] = remaining;
        }
        // 金额上界已并入整份计划评估（planMaximumCents）：assessment 覆盖"条目合计与
        // 计划最高占用取大"的完整口径，这里不再重复检查。
        const expectedScopeId = scope.id;
        current = await this.dispatchSpendAuthorization(runId, {
          spendPlanId: plan.id,
          nodeId: plan.nodeId,
          inputVersionIds: plan.inputVersionIds,
          providerId: plan.providerId,
          modelId: plan.modelId,
          // 与当前报价计划逐字段一致（原 exact matcher 原样通过）；
          // 范围约束在 itemCreateBudgets（预留层）与 scope 余额核对（此处）执行。
          maxCostCny: plan.maxCostCny,
          maxAttempts: plan.maxAttempts,
          // 子凭证的批准者记录其派生来源；人类批准者仍是接受 scope 时的 approvedBy。
          approvedBy: `${scope.approvedBy}（制作范围授权 ${scope.id}）`,
          derivedFromScopeId: scope.id,
          itemCreateBudgets,
        }, listener, async () => {
          // supersession 防护（C1-R1）：派发事务持锁边界内重读授权链，确认 head 仍是覆盖
          // 判定所用的 scope；已被替代的 scope 不得为尚未开始的新请求签发子授权。
          const latest = await this.readProductionAuthorization(runId);
          if (latest?.id !== expectedScopeId) {
            throw new Error(
              `Production authorization '${expectedScopeId}' is no longer the active authorization of run '${runId}'; refusing to derive a child spend credential.`,
            );
          }
        });
      }
      return current.completion;
    })();
    return { runId, completion: chained };
  }

  // C1-R5：把"范围未覆盖"的结构化评估落到等待节点（CAS 持久化），供 C2 投影展示；
  // 节点已离开等待状态或 revision 已前进而并发变化时不覆盖任何新状态。
  // 返回写入后的最新 run；无法写入（并发变化）时返回 undefined。
  private async recordNodeSpendAssessment(
    runId: string,
    nodeId: string,
    expectedRevision: number,
    assessment: ProductionSpendPlanAssessment,
  ): Promise<WorkflowRun<ProductionBrief> | undefined> {
    // 预检查：不可写状态直接放弃，不进入 CAS（save 合同要求 revision + 1，不接受无变更返回）。
    const current = await this.store.load<ProductionBrief>(runId);
    const currentTarget = current.nodeRuns.find((node) => node.nodeId === nodeId);
    if (current.revision !== expectedRevision || !currentTarget
      || (currentTarget.status !== "awaiting_spend_approval" && currentTarget.status !== "approval_invalidated")) {
      return undefined;
    }
    try {
      return await this.runPersistedTransition(runId, async (previous) => {
        // 持锁边界内二次核对：预检查后发生并发变化时放弃（save 以异常失败，由外层捕获）。
        const target = previous.nodeRuns.find((node) => node.nodeId === nodeId);
        if (previous.revision !== expectedRevision || !target
          || (target.status !== "awaiting_spend_approval" && target.status !== "approval_invalidated")) {
          throw new StaleRunRevisionError(runId, expectedRevision, previous.revision);
        }
        return {
          ...previous,
          revision: previous.revision + 1,
          nodeRuns: previous.nodeRuns.map((node) => (
            node.nodeId === nodeId
              ? { ...node, spendAssessment: assessment as unknown as Record<string, unknown> }
              : node
          )),
        };
      });
    } catch {
      // 评估落盘是尽力而为的投影：并发状态变化时放弃写入，不阻断等待语义本身。
      return undefined;
    }
  }

  // C2/CG-01：授权命令的续链恢复——授权已提交但 governed continuation 未完成（进程在
  // run CAS 之后、续链完成之前中断）时，重新触发同一条 continuation。幂等：run 不在
  // 报价等待状态时原样返回；仍在等待且未覆盖时记录评估并保持等待，不签发任何新凭证。
  async resumeCoveredSpendApproval(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    const run = await this.store.load<ProductionBrief>(runId);
    return this.continueCoveredSpendApproval(runId, { runId, completion: Promise.resolve(run) }).completion;
  }

  async inspectPaidNode(runId: string, nodeId: string): Promise<ProductionPaidNodeSummary> {    const run = await this.store.load<ProductionBrief>(runId);
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error(`Unknown workflow node '${nodeId}'.`);
    const operationId = node.operationRequestId;
    if (!operationId) {
      return { nodeId, failureKind: "missing_evidence", requiresManualReconciliation: true, items: [] };
    }
    const nodeDirectory = path.join(this.runsRoot, runId, "nodes", nodeId);
    if (nodeId === "voice") {
      const voiceOperation = await readPaidVoiceOperation(nodeDirectory, operationId);
      const resumable = voiceOperation ? canResumePaidVoiceOperation(voiceOperation) : false;
      const terminalFailure = Boolean(voiceOperation?.items.some((item) => item.state === "terminal_failed"))
        && voiceOperation!.items.every((item) => (
          item.state === "prepared" || item.state === "materialized" || item.state === "terminal_failed"
        ));
      return {
        nodeId,
        operationId,
        ...(resumable
          ? { recommendedOutcome: "resume_original" as const }
          : terminalFailure
            ? { recommendedOutcome: "confirmed_not_charged" as const, failureKind: "terminal_failure" as const }
            : { failureKind: voiceOperation ? "unknown_outcome" as const : "missing_evidence" as const }),
        requiresManualReconciliation: !resumable,
        items: [],
      };
    }
    if (nodeId !== "assets") return { nodeId, operationId, failureKind: "missing_evidence", requiresManualReconciliation: true, items: [] };
    const ledgerItems = (await inspectPaidAssetLedger(
      nodeDirectory,
    )).filter((item) => item.operationId === operationId);
    const effectiveItems = isTrustedPreSubmissionAssetRejection(node, ledgerItems)
      ? ledgerItems.map((item) => {
          if (item.state !== "unknown" || item.taskId) return item;
          const { actualCostCny: _actualCostCny, actualCostSource: _actualCostSource, ...rest } = item;
          return { ...rest, state: "terminal_failed" as const };
        })
      : ledgerItems;
    const trustedPreSubmissionRejection = isTrustedPreSubmissionAssetRejection(node, ledgerItems);
    const requiresManualReconciliation = trustedPreSubmissionRejection
      ? false
      : paidAssetOperationNeedsManualReconciliation(effectiveItems);
    const resumeOriginalOperation = effectiveItems.length > 0 && canResumePaidAssetOperation(effectiveItems);
    return {
      nodeId,
      operationId,
      ...(!requiresManualReconciliation
        ? { recommendedOutcome: resumeOriginalOperation ? "resume_original" as const : "requote" as const }
        : {}),
      requiresManualReconciliation,
      items: effectiveItems.map((item) => ({
        operationId: item.operationId,
        itemRequestId: item.itemRequestId,
        quoteItemId: item.quoteItemId,
        scenePosition: item.scenePosition,
        executorProviderId: item.executorProviderId,
        providerId: item.providerId,
        modelId: item.modelId,
        state: item.state,
        estimatedCostCny: item.estimatedCostCny,
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.actualCostCny !== undefined ? { actualCostCny: item.actualCostCny } : {}),
        ...(item.actualCostSource ? { actualCostSource: item.actualCostSource } : {}),
        ...(item.error ? { error: item.error } : {}),
        ...(item.manualReconciliationRequired ? { manualReconciliationRequired: true } : {}),
      })),
    };
  }

  // joint-v1 规划阶段的只读检视（Studio 详情消费）：阶段列表来自当前路线的真实拓扑，
  // 状态只由 checkpoint 快照、role-agent checkpoint 与经严格校验的 planning commit 推导。
  // 读取绝不 invoke 图、绝不触发角色/Provider；checkpoint 缺失如实全 pending，
  // 身份错配或存储损坏返回 undefined（fail closed，不回退旧 NodeRun 也不伪造状态）。
  async inspectCreativePlanningStages(runId: string): Promise<CreativePlanningStageInspection[] | undefined> {
    const run = await this.store.load<ProductionBrief>(runId);
    const brief = effectiveProductionBrief(run);
    if (brief.workflowFeatures?.creativePlanning !== "joint-v1") return undefined;
    const libraryRoute = brief.workflowFeatures?.assetSemanticRank === true;
    const stageIds = libraryRoute ? PLANNING_STAGE_ORDER_LIBRARY : PLANNING_STAGE_ORDER_FIXED;
    const bindingModelOf = (stage: PlanningStageId) => this.planningBindingModelId(stage, brief);
    const planningNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
    const inputState = planningNode?.inputState;
    if (!planningNode || !inputState || inputState.stale) {
      // 规划尚未启动（上游失败或未轮到），或当前有效输入已被上游改动标记过时：
      // 新 thread 尚未确定，不得拿旧输入身份的 checkpoint 冒充当前进度；模型阶段仍显示当前绑定。
      return planningStagesAllPending(stageIds, bindingModelOf, (stage) => this.planningBindingProviderId(stage, brief));
    }
    const effectiveInput = inputState.versions.find(
      (version) => version.id === inputState.effectiveVersionId,
    )?.value;
    if (!isObjectRecord(effectiveInput) || !isObjectRecord(effectiveInput.brief)) return undefined;
    const referenceGrammarEnabled = brief.workflowFeatures?.referenceGrammar === true;
    let inputDigest: string;
    try {
      const referenceGrammar = referenceGrammarEnabled && typeof effectiveInput.referenceGrammarPath === "string"
        ? await readShotGrammarFile(effectiveInput.referenceGrammarPath)
        : undefined;
      // 正式校验当前输入 brief：坏输入（字段级非法）不得进入身份计算，fail closed。
      inputDigest = jointPlanningInputDigest(mergeCurrentBrief(effectiveInput.brief, brief), referenceGrammar);
    } catch {
      // 参考语法文件缺失/损坏，或当前输入 brief 不满足正式合同：无法确定输入身份，fail closed。
      return undefined;
    }
    // checkpoint 存储尚不存在说明该工作区从未启动过 joint 规划：如实全 pending，
    // 且读取路径不得创建存储文件。
    let sqliteExists = true;
    try {
      await stat(planningCheckpointSqlitePath(path.dirname(this.runsRoot)));
    } catch {
      sqliteExists = false;
    }
    if (!sqliteExists) return planningStagesAllPending(stageIds, bindingModelOf, (stage) => this.planningBindingProviderId(stage, brief));
    let values: Partial<PlanningGraphState>;
    let cursor: readonly string[] = [];
    try {
      const store = CreativePlanningStore.open(path.dirname(this.runsRoot));
      try {
        const snapshot = await createInspectionPlanningGraph(store, libraryRoute)
          .getState(store.threadConfig(runId, inputDigest));
        values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
        cursor = snapshot?.next ?? [];
      } finally {
        store.close();
      }
    } catch {
      // 存储损坏或不可读（含身份校验失败）：不伪造任何阶段状态。
      return undefined;
    }
    if (values.inputDigest == null) {
      // thread 无 checkpoint（规划未开始，或输入已进入新 thread）：如实全 pending。
      return planningStagesAllPending(stageIds, bindingModelOf, (stage) => this.planningBindingProviderId(stage, brief));
    }
    // 快照身份必须与当前请求完全对齐：错 thread/错 run/错 digest 一律 fail closed，
    // 与 runCreativePlanning 的恢复防线同一纪律。
    if (values.runId !== runId || values.inputDigest !== inputDigest) return undefined;

    const completedStages = new Set(stageIds.filter((stage) => planningStageArtifactPresent(stage, values)));
    const cursorStage = cursor.map((node) => node.endsWith("_review") ? node.slice(0, -7) : node)
      .find((node) => (stageIds as readonly string[]).includes(node)) as PlanningStageId | undefined;
    const runningStage = planningNode.status === "running" ? cursorStage : undefined;
    const structuredIssueByStage = new Map<PlanningStageId, string>();
    for (const issue of Array.isArray(values.issues) ? values.issues : []) {
      if (!isObjectRecord(issue)) continue;
      const stage = typeof issue.target === "string" ? planningIssueTargetStage(issue.target) : undefined;
      if (!stage) continue;
      const reason = typeof issue.reason === "string" ? issue.reason : "";
      const requiredChange = typeof issue.requiredChange === "string" ? issue.requiredChange : "";
      const text = `${reason}${requiredChange ? `（${requiredChange}）` : ""}`.trim();
      if (text && !structuredIssueByStage.has(stage)) structuredIssueByStage.set(stage, text);
    }
    // 失败阶段归属：结构化 issue 的目标阶段优先（duplicate_issue/回退耗尽停止时，承担
    // 未决问题的导演已有产物，不能因产物存在就标 completed、把 integrate 标 failed）；
    // 无结构化 issue 时回退到“第一个无产物阶段”；图已完成而正式发布失败（所有阶段都有
    // 产物却没有 commit 接受）时，失败归属于正式方案阶段——不能把发布失败显示成全部完成。
    // role trace 严格绑定当前 inputDigest：只读执行历史里本 digest 的记录，不读其他
    // thread（旧执行）的 v7 checkpoint 或旧 trace——编辑换 digest 后旧 trace 不再冒充。
    const roleModelTraces = await readJointPlanningModelTraces(
      path.join(this.runsRoot, runId, "nodes", "creative-planning", "planning-history.json"),
      inputDigest,
    );
    const publicationVerified = completedStages.size === stageIds.length && planningNode.status === "succeeded";
    const planningCommitted = publicationVerified
      ? await this.planningCommitArtifactIds(runId, inputDigest, values, libraryRoute, run)
      : {};
    // F9 残留：节点已 succeeded、图产物齐全，但正式 commit/registry 核验失败（映射为空）
    // ——发布没有成立，必须在正式方案阶段暴露可行动失败，而不是全绿。
    const commitVerificationFailed = publicationVerified
      && Object.values(planningCommitted).every((ids) => !(ids && ids.length > 0));
    const reviewStage = values.creativeReview?.activeStage;
    const stoppedReviewStage = reviewStage && values.creativeReview?.stages[reviewStage].currentDraft
      && values.creativeReview.stages[reviewStage].phase !== "confirmed" ? reviewStage : undefined;
    const failedStage: PlanningStageId | undefined = planningNode.status === "failed"
      ? stoppedReviewStage ?? cursorStage ?? stageIds.find((stage) => structuredIssueByStage.has(stage))
        ?? stageIds.find((stage) => !completedStages.has(stage))
        ?? (completedStages.size === stageIds.length ? "compile" : undefined)
      : commitVerificationFailed
        ? "compile"
        : undefined;
    return stageIds.map((stage) => {
      // 状态优先级：当前失败 > checkpoint cursor 正在执行 > 已有产物（旧完成）> 待开始。
      // 阶段重跑时旧产物不得把当前活动覆盖成 completed；发布失败不得显示全部 completed。
      const status: CreativePlanningStageInspection["status"] = stage === failedStage
        ? "failed"
        : stage === runningStage
          ? "running"
          : completedStages.has(stage)
            ? "completed"
            : "pending";
      const artifactIds = planningCommitted[stage] ?? [];
      // 来源诚实合同：pending/running 显示当前绑定（用户据此判断这次会用什么）；已完成
      // 模型阶段必须来自真实执行 trace——来源未知时显式 unknown，不用首选绑定冒充
      // （如 fallback 后的实际模型、跨崩溃窗口丢失的 provenance）；确定性阶段无模型字段。
      const modelStage = stage === "treatment" || stage === "script" || stage === "director" || stage === "rank";
      const effectiveModelId = status === "completed"
        ? roleModelTraces[stage] ?? (modelStage ? "unknown" : undefined)
        : roleModelTraces[stage] ?? this.planningBindingModelId(stage, brief);
      const providerId = this.planningBindingProviderId(stage, brief);
      const issue = status === "failed"
        ? structuredIssueByStage.get(stage)
          ?? (commitVerificationFailed && stage === "compile"
            ? "正式方案还没有通过核验，请重试生成或重新规划。"
            : planningFailureForCreators(planningNode.error ?? ""))
        : structuredIssueByStage.get(stage);
      const allowedActions: CreativePlanningStageAction[] = [
        ...(stage === "treatment" || stage === "script" || stage === "director"
          ? (["edit_input", "change_model"] as const)
          : []),
        ...(artifactIds.length > 0 ? (["view_artifacts"] as const) : []),
      ];
      return {
        id: stage,
        status,
        ...(effectiveModelId !== undefined ? { effectiveModelId } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
        artifactIds: [...artifactIds],
        ...(issue !== undefined && issue !== "" ? { issue } : {}),
        allowedActions,
      };
    });
  }

  // 尚未执行的角色阶段回退到当前有效绑定的首选模型；已执行的以执行历史的真实 trace
  // 为准（含 fallback 后的实际模型）。确定性阶段（candidates/integrate/compile）没有模型。
  private planningBindingModelId(stage: PlanningStageId, brief: ProductionBrief): string | undefined {
    switch (stage) {
      case "treatment": return effectiveTreatmentModelId(brief, this.options.treatmentAgents ?? []);
      case "script": return brief.models?.[brief.providers.script] ?? this.options.screenwriterAgent?.modelId;
      case "director": return brief.providers.director !== undefined
        ? brief.models?.[brief.providers.director] ?? this.options.directorAgent?.modelId
        : this.options.directorAgent?.modelId;
      case "rank": return this.options.assetSemanticRanker?.modelId;
      default: return undefined;
    }
  }

  // 模型阶段当前绑定的能力提供者：UI 的模型选择据此解析，不按能力目录顺序猜测。
  private planningBindingProviderId(stage: PlanningStageId, brief: ProductionBrief): string | undefined {
    switch (stage) {
      case "treatment": return this.options.treatmentAgents?.length ? CREATIVE_TREATMENT_PROVIDER_ID : undefined;
      case "script": return brief.providers.script;
      case "director": return brief.providers.director;
      case "rank": return this.options.assetSemanticRanker?.id;
      default: return undefined;
    }
  }

  // 整份规划正式落定后，把阶段映射到 planning commit 严格绑定过的 run 正式产物 id。
  // 任何一步验证不通过都返回空映射：进行中的规划只能呈现 checkpoint 真实持有的阶段身份，
  // 不得给出不存在的 StudioArtifact id。
  private async planningCommitArtifactIds(
    runId: string,
    inputDigest: string,
    values: Partial<PlanningGraphState>,
    libraryRoute: boolean,
    run: WorkflowRun<ProductionBrief>,
  ): Promise<Partial<Record<PlanningStageId, string[]>>> {
    const script = values.scriptArtifact;
    const treatment = values.treatmentArtifact;
    const finalPlan = values.integratedPlan ?? values.directorPlan;
    const candidates = values.candidatesArtifact;
    const ranking = values.ranking;
    const executablePlan = values.executablePlan;
    if (!treatment || !script || !finalPlan || !executablePlan) return {};
    if (libraryRoute && (!candidates || !ranking)) return {};
    // 与执行侧同一公式重算 commit key：同输入身份必然命中执行时写入的同一 commit 文件。
    const planningCommitKey = createHash("sha256").update(JSON.stringify({
      version: PLANNING_COMMIT_VERSION,
      runId,
      inputDigest,
      planning: {
        treatment: treatment.artifactId,
        script: script.artifactId,
        directorPlan: finalPlan.artifactId,
        ...(libraryRoute && candidates ? { candidates: candidates.artifactId } : {}),
        ...(libraryRoute && ranking ? { ranking: ranking.artifactId } : {}),
        executablePlan: executablePlan.artifactId,
      },
    })).digest("hex");
    let commit: JointPlanningCommit;
    try {
      const existing = await readJointPlanningCommit(
        path.join(this.runsRoot, runId, "planning", "commits", `${planningCommitKey}.json`),
      );
      if (existing === undefined) return {};
      commit = await verifyJointPlanningCommit({
        commit: existing,
        planningCommitKey,
        inputDigest,
        runId,
        runRoot: path.join(this.runsRoot, runId),
        artifacts: run.artifacts,
        expectedKinds: jointPlanningExpectedKinds(libraryRoute),
      });
    } catch {
      return {};
    }
    const idsOfKind = (kind: string) => commit.artifacts
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.artifactId);
    // BG-01 尾巴：声音时长修订等人工修订会替换 planning 节点当前 effective version 的
    // 成员（如新 executable_plan）。stage 投影必须反映"当前接受版本"，不能永远指向
    // 原始 graph commit 的产物。
    const planningNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
    const currentVersionIds = new Set(
      planningNode?.outputState?.versions.find(
        (version) => version.id === planningNode.outputState?.effectiveVersionId,
      )?.artifactIds ?? [],
    );
    const currentVersionExecutablePlan = currentVersionIds.size > 0
      ? run.artifacts
        .filter((artifact) => (
          currentVersionIds.has(artifact.id)
          && artifact.kind === "executable_plan"
          && artifact.producer?.nodeId === "creative-planning"
        ))
        .map((artifact) => artifact.id)
      : [];
    return {
      treatment: idsOfKind("creative_treatment"),
      script: idsOfKind("script"),
      director: idsOfKind("storyboard"),
      ...(libraryRoute ? {
        candidates: idsOfKind("asset_candidates"),
        rank: idsOfKind("asset_ranking"),
        integrate: idsOfKind("storyboard"),
      } : {}),
      compile: currentVersionExecutablePlan.length > 0 ? currentVersionExecutablePlan : idsOfKind("executable_plan"),
    };
  }

  private paidReconciliationPath(runId: string, reconciliationId: string): string {
    const name = createHash("sha256").update(reconciliationId).digest("hex");
    return path.join(this.store.runDirectory(runId), ".paid-reconciliations", `${name}.json`);
  }

  async dispatchRetryFailedNode(
    runId: string,
    nodeId: string,
    listener?: ProductionRunListener,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<DispatchedProductionRun> {
    const dispatched = await this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const retryRejectedReview = canRetryRejectedReviewNode(previous, nodeId);
      const brief = parsePersistedBrief(previous.initialInput);
      const recoveryWorkflowOperationRequestId = options?.recoverOriginalTextTask
        ? previous.nodeRuns.find((node) => node.nodeId === nodeId)?.operationRequestId
        : undefined;
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.retryFailedNode(
        this.createWorkflow(brief, undefined, {
          ...(options?.resumeCompletedTextTask ? { resumeCompletedTextTaskNodeId: nodeId } : {}),
          ...(options?.resumeCompletedTextTaskRequestId
            ? { resumeCompletedTextTaskRequestId: options.resumeCompletedTextTaskRequestId }
            : {}),
          ...(recoveryWorkflowOperationRequestId
            ? { recoverTextTask: { nodeId, workflowOperationRequestId: recoveryWorkflowOperationRequestId } }
            : {}),
        }),
        withExecutableBrief(previous, brief),
        nodeId,
        retryRejectedReview ? { allowRejectedNode: true } : undefined,
      );
    }, listener);
    return this.continueCoveredSpendApproval(runId, dispatched, listener);
  }

  async dispatchVisualReinspection(
    runId: string,
    draft: ProductionVisualReinspectionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      if (previous.revision !== draft.expectedRunRevision) {
        throw new StaleRunRevisionError(runId, draft.expectedRunRevision, previous.revision);
      }
      if (previous.status !== "needs_human" && previous.status !== "rejected") {
        throw new Error(`Run '${runId}' is not waiting for visual reinspection.`);
      }
      const brief = parsePersistedBrief(previous.initialInput);
      if (!brief.providers.visualReview) throw new Error("Visual reinspection is not enabled for this run.");
      const delivery = requireOutputRecord(currentVisualReviewDelivery(previous), "visual-review delivery");
      const report = requireOutputRecord(delivery.report, "visual-review report");
      const scope = finalVisualReviewScope(delivery);
      if (scope.evidenceId !== draft.reviewEvidenceId) {
        throw new Error("Visual reinspection request is not bound to the current review evidence.");
      }
      const needsInspection = Array.isArray(report.findings) && report.findings.some((finding) => (
        isObjectRecord(finding)
        && finding.evidenceStatus === "not_observed"
        && finding.nextAction === "inspect_existing_media"
      ));
      if (!needsInspection) {
        throw new Error("Current visual review has no existing-media inspection request.");
      }
      // 显式补查必须开启新的审片缓存轮次；同一轮因进程中断而重试时仍沿用该轮，
      // 这样既不会把旧审片结论冒充补查结果，也不会重复已完成的模型分支。
      await writeTextAtomically(
        visualReinspectionCyclePath(this.runsRoot, runId),
        `${randomUUID()}\n`,
      );
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.rerunFromNode(
        this.createWorkflow(brief),
        withExecutableBrief(previous, brief),
        "visual-review",
      );
    }, listener);
  }

  async resumePaused(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchResumePaused(runId);
    return dispatched.completion;
  }

  async dispatchResumePaused(
    runId: string,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    await rm(this.pauseRequestPath(runId), { force: true });
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.resumePaused(this.createWorkflow(brief), withExecutableBrief(previous, brief));
    }, listener);
  }

  private async runPersistedTransition(
    runId: string,
    transition: (
      previous: WorkflowRun<ProductionBrief>,
      checkpoint: (run: WorkflowRun<ProductionBrief>) => Promise<void>,
    ) => Promise<WorkflowRun<ProductionBrief>>,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const lease = await this.acquireExecutionLease(runId);
    try {
      await this.assertExecutionLease(lease);
      const previous = await this.store.load<ProductionBrief>(runId);
      let persisted = false;
      const checkpoint = async (run: WorkflowRun<ProductionBrief>) => {
        await this.assertExecutionLease(lease);
        if (!persisted) {
          await this.store.save(run, previous.revision);
          persisted = true;
          return;
        }
        await this.store.checkpoint(run);
      };
      const result = await transition(previous, checkpoint);
      if (!persisted) {
        await this.assertExecutionLease(lease);
        await this.store.save(result, previous.revision);
      }
      return result;
    } finally {
      await this.releaseExecutionLease(lease);
    }
  }

  private async dispatchPersistedTransition(
    runId: string,
    transition: (
      previous: WorkflowRun<ProductionBrief>,
      checkpoint: (run: WorkflowRun<ProductionBrief>) => Promise<void>,
    ) => Promise<WorkflowRun<ProductionBrief> | PersistedTransitionReplay>,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    const lease = await this.acquireExecutionLease(runId);
    let previous: WorkflowRun<ProductionBrief>;
    try {
      await this.assertExecutionLease(lease);
      previous = await this.store.load<ProductionBrief>(runId);
    } catch (error) {
      await this.releaseExecutionLease(lease);
      throw error;
    }

    let persisted = false;
    let resolveCheckpoint!: () => void;
    let rejectCheckpoint!: (error: unknown) => void;
    const firstCheckpoint = new Promise<void>((resolve, reject) => {
      resolveCheckpoint = resolve;
      rejectCheckpoint = reject;
    });
    const checkpoint = async (run: WorkflowRun<ProductionBrief>) => {
      await this.assertExecutionLease(lease);
      if (!persisted) {
        await this.store.save(run, previous.revision);
        persisted = true;
      } else {
        await this.store.checkpoint(run);
      }
      await notifyListener(listener, run);
      resolveCheckpoint();
    };
    const completion = transition(previous, checkpoint).then(
      async (result) => {
        if (isPersistedTransitionReplay(result)) {
          resolveCheckpoint();
          await this.releaseExecutionLease(lease);
          return result.replay;
        }
        const run = result;
        if (!persisted) {
          await this.assertExecutionLease(lease);
          await this.store.save(run, previous.revision);
          persisted = true;
          await notifyListener(listener, run);
          resolveCheckpoint();
        }
        await this.releaseExecutionLease(lease);
        return run;
      },
      async (error: unknown) => {
        await this.releaseExecutionLease(lease);
        rejectCheckpoint(error);
        throw error;
      },
    );
    void completion.catch(() => undefined);
    await firstCheckpoint;
    return { runId, completion };
  }

  private pauseRequestPath(runId: string): string {
    return path.join(this.runsRoot, runId, ".pause-request.json");
  }

  private async consumePauseRequest(runId: string): Promise<boolean> {
    const requestPath = this.pauseRequestPath(runId);
    try {
      await stat(requestPath);
      await rm(requestPath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private createRegistry(brief: ProductionBrief): ProviderRegistry {
    const registry = new ProviderRegistry();
    if (brief.providers.script === "codex-screenwriter-v1") {
      const screenwriterAgent = this.options.screenwriterAgent;
      if (!screenwriterAgent || screenwriterAgent.id !== brief.providers.script) {
        throw new Error(`Script provider '${brief.providers.script}' is not configured.`);
      }
      registry.register(new ScreenwriterProvider(
        screenwriterAgent,
        brief.models?.[brief.providers.script],
        modelSourceFor(brief, brief.providers.script),
      ));
    }
    if (brief.director) {
      const directorAgent = this.options.directorAgent;
      if (!directorAgent || directorAgent.id !== brief.providers.director) {
        throw new Error(`Director provider '${brief.providers.director}' is not configured.`);
      }
      registry.register(new VisualDirectorProvider(
        directorAgent,
        brief.models?.[brief.providers.director],
        modelSourceFor(brief, brief.providers.director),
      ));
    }
    if (brief.providers.visualReview) {
      const visualReviewAgent = [
        ...(this.options.visualReviewAgents ?? []),
        ...(this.options.visualReviewAgent ? [this.options.visualReviewAgent] : []),
      ].find((agent) => agent.id === brief.providers.visualReview);
      const metadata = this.options.providerRuntimeMetadata?.find((item) => item.id === brief.providers.visualReview);
      validateVisualReviewRuntimeMetadata(brief.providers.visualReview, metadata);
      registry.register(visualReviewAgent?.id === brief.providers.visualReview
        ? new VisualReviewProvider(visualReviewAgent, metadata)
        : new UnavailableVisualReviewProvider(brief.providers.visualReview, metadata));
    }
    for (const config of providerConfigs(brief, this.options)) {
      registry.register(new WorkerProvider(config, this.options.worker, this.runsRoot));
    }
    return registry;
  }

  private createWorkflow(
    brief: ProductionBrief,
    approvalDecision?: HumanDecisionDraft,
    options: {
      allowUnavailableProviders?: boolean;
      resumeCompletedTextTaskNodeId?: string;
      resumeCompletedTextTaskRequestId?: string;
      recoverTextTask?: { nodeId: string; workflowOperationRequestId: string };
      creativeReviewResume?: CreativeReviewResume;
    } = {},
  ): WorkflowDefinition {
    const resumeCompletedTextTaskNodeId = options.resumeCompletedTextTaskNodeId;
    const resumeCompletedTextTaskRequestId = options.resumeCompletedTextTaskRequestId;
    const withSourceRunSnapshot: SourceRunSnapshot = (sourceRunId, snapshot) => (
      this.withRunMaintenanceLease([sourceRunId], snapshot)
    );
    const assetReworkScenePositions = brief.rework
      ? reworkAffectedScenePositions({
        findings: brief.rework.findings,
        ...(brief.rework.previousScript ? { previousScenes: brief.rework.previousScript.scenes } : {}),
        ...(brief.rework.previousDirectorPlan ? { previousShots: brief.rework.previousDirectorPlan.shots } : {}),
        // 工作流定义阶段脚本尚未生成：有 previousScript 时用它作 current 的保守下界（script 差异为 0），
        // 否则退回 previousDirectorPlan 的镜头位置作为有效镜头集合。
        ...(brief.rework.previousScript
          ? { currentScenes: brief.rework.previousScript.scenes }
          : brief.rework.previousDirectorPlan
            ? { currentScenes: shotsAsScenePositions(brief.rework.previousDirectorPlan.shots) }
            : { currentScenes: [] }),
        ...(brief.rework.previousDirectorPlan ? { currentShots: brief.rework.previousDirectorPlan.shots } : {}),
        ...(brief.rework.affectedScenePositions !== undefined
          ? { affectedScenePositions: brief.rework.affectedScenePositions }
          : {}),
      })
      : [];
    const workerNode = (
      id: string,
      label: string,
      capability: Capability,
      providerId: string,
      dependsOn: string[],
      parentNodeIds: string[],
      getInput: (context: WorkflowContext) => Record<string, unknown>,
      role?: string,
      validateInputOverride?: (input: unknown) => Record<string, unknown>,
    ): NodeDefinition => ({
      id,
      label,
      ...(role ? { role } : {}),
      capability,
      providerId,
      mode: "automatic",
      dependsOn,
      getInput,
      execute: async (input, context) => {
        const provider = context.resolveProvider<Record<string, unknown>, WorkerResponse>({
          capability,
          providerId,
        });
        const workerResponse = await provider.run(input as Record<string, unknown>, context);
        const response = capability === "script.draft" && brief.seriesContext
          ? await validateSeriesWorkerScriptResponse(workerResponse)
          : workerResponse;
        const receipt = providerExecutionReceipt(provider, response);
        if (capability === "voice.synthesize") {
          receipt.parameters = effectiveVoiceReceiptParameters(input as Record<string, unknown>, receipt.parameters);
        }
        return {
          ...workerResponseToNodeResult(response, context, parentNodeIds),
          receipt,
        };
      },
      validateInputOverride: validateInputOverride ?? ((input) => requireOutputRecord(input, `${id} input`)),
      validateOverride: (output) => validateWorkerNodeOverride(id, output),
    });

    const nodes: NodeDefinition[] = [
      {
        id: "brief",
        label: "Validate brief",
        role: "制片人",
        capability: "brief.validate",
        mode: "automatic",
        getInput: (context) => context.initialInput as ProductionBrief,
        execute: async (input, context) => {
          const validatedBrief = validateBriefInputOverride(input, brief);
          // 独立复核是建议性证据，不是状态：它挂在节点 checkpoint 上（界面据 node.agentLoopProgress
          // 显示建议），无论裁决是 pass 还是 repair，本节点照常 succeeded，暂停由边界闸门负责。
          if (boundaryGatesEnabled(brief)) await recordBriefAudit(this.options.briefAuditAgents, validatedBrief, context, this.runsRoot);
          return ({
          status: "succeeded",
          output: validatedBrief,
          artifacts: [jsonArtifact("production_brief", validatedBrief, "video-factory/brief-v1", "brief", [])],
          });
        },
        validateInputOverride: (input) => validateBriefInputOverride(input, brief),
        validateOverride: (output) => validateBriefInputOverride(output, brief),
      },
      ...(usesJointCreativePlanning(brief)
        // joint-v1 不创建外层 script/visual-direction/asset-candidates/asset-semantic-rank/
        // production-preflight：四段规划收敛为一个 creative-planning 节点。
        ? []
        : brief.providers.script === "codex-screenwriter-v1"
          ? [screenwriterNode(
              brief,
              this.options.screenwriterAgent,
              this.options,
              this.runsRoot,
              withSourceRunSnapshot,
              options.allowUnavailableProviders === true,
            )]
          : [workerNode(
              "script",
              "Draft script",
              "script.draft",
              brief.providers.script,
              ["brief"],
              ["brief"],
              (context) => ({ brief: currentEffectiveBriefFromContext(context, brief) }),
              "编剧",
            )]),
      ...(brief.workflowFeatures?.referenceGrammar ? [referenceGrammarNode(brief, this.options, this.runsRoot)] : []),
      ...(usesJointCreativePlanning(brief)
        ? [creativePlanningNode(
          brief,
          this.options,
          this.runsRoot,
          options.allowUnavailableProviders === true,
          resumeCompletedTextTaskNodeId,
          resumeCompletedTextTaskRequestId,
          options.recoverTextTask,
          options.creativeReviewResume,
        )]
        : [
            ...(brief.director ? [directorNode(brief, this.options, this.runsRoot, withSourceRunSnapshot)] : []),
            ...(brief.workflowFeatures?.assetSemanticRank ? [
              workerNode(
                "asset-candidates",
                "Discover asset candidates",
                "asset.search",
                "asset-candidate-search-v1",
                ["visual-direction"],
                ["script", "visual-direction"],
                (context) => ({
                  scriptPath: outputPath(context, "script", "scriptPath"),
                  directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath"),
                }),
                "素材研究员",
              ),
              assetSemanticRankNode(brief, this.options, this.runsRoot),
            ] : []),
            ...(brief.durationRange && brief.director
              ? [productionPreflightNode(brief, this.runsRoot)]
              : []),
          ]),
      workerNode(
        "assets",
        "Prepare assets",
        "asset.prepare",
        brief.providers.assets,
        [usesJointCreativePlanning(brief)
          ? "creative-planning"
          : brief.durationRange && brief.director
            ? "production-preflight"
            : brief.workflowFeatures?.assetSemanticRank
              ? "asset-semantic-rank"
              : brief.director
                ? "visual-direction"
                : "script"],
        usesJointCreativePlanning(brief)
          ? ["creative-planning"]
          : brief.durationRange && brief.director
            ? ["production-preflight"]
            : brief.workflowFeatures?.assetSemanticRank
              ? ["script", "visual-direction", "asset-candidates", "asset-semantic-rank"]
              : brief.director
                ? ["script", "visual-direction"]
                : ["script"],
        (context) => {
          // 唯一规划产物投影：joint/legacy 的路径选择收敛到 currentPlanningOutputPaths；
          // joint 的候选路径经 planningCandidatePaths 严格校验，legacy 保持可选字段兼容。
          const joint = usesJointCreativePlanning(brief);
          const planning = currentPlanningOutputPaths(context, brief);
          const candidates = !brief.workflowFeatures?.assetSemanticRank
            ? undefined
            : joint
              ? planningCandidatePaths(planning)
              : {
                ...(planning.candidateRankingPath ? { candidateRankingPath: planning.candidateRankingPath } : {}),
                ...(planning.candidateInventoryPath ? { candidateInventoryPath: planning.candidateInventoryPath } : {}),
              };
          return {
            scriptPath: planning.scriptPath,
            ...(planning.directorPlanPath !== undefined ? { directorPlanPath: planning.directorPlanPath } : {}),
            ...(planning.executablePlanPath !== undefined ? { executablePlanPath: planning.executablePlanPath } : {}),
            ...(candidates ?? {}),
            ...(brief.rework ? {
              rework: {
                sourceRunId: brief.rework.sourceRunId,
                sourceRunRevision: brief.rework.sourceRunRevision,
                nodeInstructions: brief.rework.nodeInstructions,
                // 素材节点只接收 visual-direction/assets 的 findings（与 reworkAffectedScenePositions
                // 内部对 visual findings 的同一过滤语义）；script-only finding 不透传给素材，
                // 其场景实际变化仍经 current/previous script 逐镜差异进入统一 affected 闭包。
                findings: brief.rework.findings.filter((finding) => finding.action !== "inspect_existing_media"
                  && finding.targetNodeIds.some((target) => target === "visual-direction" || target === "assets")),
                ...(assetReworkScenePositions.length || brief.rework.affectedScenePositions !== undefined
                  ? { affectedScenePositions: assetReworkScenePositions }
                  : {}),
                ...(brief.rework.previousScript ? { previousScript: brief.rework.previousScript } : {}),
                ...(brief.rework.previousDirectorPlan ? { previousDirectorPlan: brief.rework.previousDirectorPlan } : {}),
              },
            } : {}),
          };
        },
        "素材导演",
      ),
      ...(brief.providers.visualReview ? [sourceAssetVisualReviewNode(brief, this.runsRoot)] : []),
      workerNode(
        "voice",
        "Synthesize voice",
        "voice.synthesize",
        brief.providers.voice,
        [usesJointCreativePlanning(brief) ? "creative-planning" : "script", brief.providers.visualReview ? "asset-source-review" : "assets"],
        usesJointCreativePlanning(brief)
          ? ["creative-planning", "assets"]
          : brief.durationRange && brief.director ? ["production-preflight", "assets"] : ["script", "assets"],
        (context) => {
          const planning = currentPlanningOutputPaths(context, brief);
          return {
            scriptPath: planning.scriptPath,
            ...(planning.executablePlanPath !== undefined ? { executablePlanPath: planning.executablePlanPath } : {}),
            voice: brief.voiceDirection.profileId.slice(brief.voiceDirection.profileId.indexOf(":") + 1),
            rate: brief.voiceDirection.rate,
            pause_scale: brief.voiceDirection.pauseScale,
            mastering_preset: brief.voiceDirection.masteringPreset,
          };
        },
        "声音导演",
        validateVoiceNodeInput,
      ),
      workerNode(
        "render",
        "Render video",
        "video.render",
        brief.providers.render,
        ["assets", "voice"],
        usesJointCreativePlanning(brief)
          ? ["creative-planning", "assets", "voice"]
          : brief.durationRange && brief.director ? ["production-preflight", "assets", "voice"] : ["script", "assets", "voice"],
        (context) => {
          const planning = currentPlanningOutputPaths(context, brief);
          return {
            scriptPath: planning.scriptPath,
            ...(planning.executablePlanPath !== undefined ? { executablePlanPath: planning.executablePlanPath } : {}),
            assetPlanPath: outputPath(context, "assets", "assetPlanPath"),
            voiceoverPlanPath: outputPath(context, "voice", "voiceoverPlanPath"),
          };
        },
        "剪辑师",
      ),
      workerNode(
        "technical-review",
        "Technical review",
        "quality.review",
        brief.providers.technicalReview,
        ["render"],
        usesJointCreativePlanning(brief)
          ? ["creative-planning", "assets", "render"]
          : brief.durationRange && brief.director ? ["production-preflight", "assets", "render"] : ["script", "assets", "render"],
        (context) => {
          const planning = currentPlanningOutputPaths(context, brief);
          return {
            videoPath: outputPath(context, "render", "videoPath"),
            assetPlanPath: outputPath(context, "assets", "assetPlanPath"),
            scriptPath: planning.scriptPath,
            ...(planning.executablePlanPath !== undefined ? { executablePlanPath: planning.executablePlanPath } : {}),
          };
        },
        "技术质检",
      ),
      ...(brief.providers.visualReview ? [visualReviewNode(brief, this.runsRoot)] : []),
      {
        id: "final-review",
        label: "Human final review",
        role: "总导演",
        capability: "quality.review.human",
        mode: brief.reviewMode === "manual" ? "manual" : "automatic",
        dependsOn: [brief.providers.visualReview ? "visual-review" : "technical-review"],
        getInput: (context) => ({
          review: context.outputs.get(brief.providers.visualReview ? "visual-review" : "technical-review"),
          canonFacts: outputStringArray(
            context.outputs.get(usesJointCreativePlanning(brief) ? "creative-planning" : "script"),
            "canonFacts",
          ),
        }),
        execute: (input, context) => {
          const reviewedInput = validateFinalReviewInput(input, Boolean(brief.seriesContext));
          const reviewArtifactIds = currentFinalReviewArtifactIds(context, brief, reviewedInput.review);
          const boundInput = {
            ...reviewedInput,
            reviewArtifactIds,
            ...(brief.providers.visualReview ? {
              reviewEvidenceId: finalVisualReviewScope(reviewedInput.review).evidenceId,
            } : {}),
          };
          if (brief.reviewMode === "automatic") {
            const recommendation = visualReviewRecommendation(reviewedInput.review);
            if (recommendation === "reject" || recommendation === "revise") {
              return {
                status: "needs_human",
                output: boundInput,
                intervention: {
                  reason: recommendation === "reject"
                    ? "视觉审片判定存在阻断问题，请人工确认后再继续。"
                    : "视觉审片建议修改，请人工确认是否继续。",
                  requiredAction: "approve",
                  options: ["approve", "request_changes", "reject"],
                  artifactIds: reviewArtifactIds,
                },
              };
            }
            return { status: "succeeded", output: boundInput };
          }
          return {
            status: "needs_human",
            output: boundInput,
            intervention: {
              reason: "请完整观看成片，检查画面、字幕、旁白、事实和素材授权。",
              requiredAction: "approve",
              options: ["approve", "request_changes", "reject"],
              artifactIds: reviewArtifactIds,
            },
          };
        },
        validateInputOverride: (input) => validateFinalReviewInput(input, Boolean(brief.seriesContext)),
        validateOverride: (output) => validateFinalReviewInput(output, Boolean(brief.seriesContext)),
      },
      {
        id: "publish-package",
        label: "发布文案与发布包",
        role: "发行编辑",
        capability: "publish.package",
        mode: "automatic",
        dependsOn: ["final-review"],
        getInput: (context) => {
          const currentBrief = currentEffectiveBriefFromContext(context, brief);
          return {
            scriptPath: outputPath(
              context,
              usesJointCreativePlanning(brief) ? "creative-planning" : "script",
              "scriptPath",
            ),
            brief: {
              title: currentBrief.title,
              angle: currentBrief.angle,
              audience: currentBrief.audience,
              nicheSlug: currentBrief.nicheSlug,
              platform: currentBrief.platform,
            },
          };
        },
        validateInputOverride: (input) => validatePublishPackageInput(input),
        execute: async (input, context) => {
          const packageInput = validatePublishPackageInput(input);
          const currentBrief = currentEffectiveBriefFromContext(context, brief);
          const publishBrief: ProductionBrief = { ...currentBrief, ...packageInput.brief };
          assertPublishEvidenceReady(context, publishBrief);
          const currentArtifacts = await currentArtifactsForPackaging(context, currentBrief);
          await verifyStoredArtifacts(currentArtifacts);
          const artifactIds = currentArtifacts.map((artifact) => artifact.id);
          const scriptParentIds = currentArtifacts
            .filter((artifact) => artifact.producer?.nodeId === (usesJointCreativePlanning(brief) ? "creative-planning" : "script"))
            .map((artifact) => artifact.id);
          const publishAttempt = await reserveAttemptDirectory(path.join(this.runsRoot, context.runId, "publish"));
          let copyOutcome: PublishCopyOutcome;
          try {
            copyOutcome = await generatePublishCopy({
              writer: this.options.publishCopyWriter,
              brief: publishBrief,
              scriptPath: packageInput.scriptPath,
              checkpoint: nodeAgentLoopCheckpoint(
                this.runsRoot,
                context.runId,
                "publish-package",
                { brief: publishBrief, scriptPath: packageInput.scriptPath },
                PUBLISH_COPY_AGENT_CONTRACT_VERSION,
                undefined,
                context.operationRequestId,
              ),
            });
          } catch (error) {
            if (!(error instanceof RoleAgentLoopError) || !this.options.publishCopyWriter) throw error;
            return failedAgentLoopNodeResult({
              error,
              attemptDirectory: publishAttempt.directory,
              nodeId: "publish-package",
              attempt: publishAttempt.attempt,
              parentArtifactIds: scriptParentIds,
              provider: {
                id: this.options.publishCopyWriter.id,
                modelId: this.options.publishCopyWriter.id,
                transport: "unix_socket",
                billing: "subscription",
                configurationSource: "system_default",
                parameters: { promptPack: "video-factory/publish-editor-v4" },
              },
              providerLabel: "Codex 发行编辑",
            });
          }
          const copyArtifacts: ArtifactDraft[] = [];
          if (copyOutcome.writerId !== undefined) {
            const copyPath = path.join(publishAttempt.directory, "publish_copy.json");
            const copyContent = `${JSON.stringify(copyOutcome.copy, null, 2)}\n`;
            await writeTextAtomically(copyPath, copyContent);
            copyArtifacts.push(fileArtifact(
              "publish_copy",
              copyPath,
              copyContent,
              "application/json",
              "video-factory/publish-copy-v1",
              "publish-package",
              scriptParentIds,
              copyOutcome.writerId,
              "AI-generated platform copy; review before upload.",
              publishAttempt.attempt,
            ));
          }
          const copyTraceArtifact = await persistModelTrace({
            trace: copyOutcome.trace,
            attemptDirectory: publishAttempt.directory,
            nodeId: "publish-package",
            attempt: publishAttempt.attempt,
            parentArtifactIds: scriptParentIds,
          });
          if (copyTraceArtifact) copyArtifacts.push(copyTraceArtifact);
          const copyLoopArtifact = await persistAgentLoopTrace({
            loop: copyOutcome.agentLoop,
            attemptDirectory: publishAttempt.directory,
            nodeId: "publish-package",
            attempt: publishAttempt.attempt,
            parentArtifactIds: scriptParentIds,
          });
          if (copyLoopArtifact) copyArtifacts.push(copyLoopArtifact);
          const resourceManifestPath = path.join(publishAttempt.directory, "resource_manifest.json");
          const privateReferenceArtifacts = context.artifacts.filter((artifact) => artifact.kind === "reference_video");
          const manifestArtifacts = [...currentArtifacts, ...privateReferenceArtifacts];
          const resourceManifest = await buildResourceManifest(context.runId, manifestArtifacts);
          const resourceManifestContent = `${JSON.stringify(resourceManifest, null, 2)}\n`;
          await writeTextAtomically(resourceManifestPath, resourceManifestContent);
          const resourceManifestArtifact = fileArtifact(
            "resource_manifest",
            resourceManifestPath,
            resourceManifestContent,
            "application/json",
            "video-factory/resource-manifest-v1",
            "publish-package",
            manifestArtifacts.map((artifact) => artifact.id),
            "video-factory-ts-v1",
            "Traceable resource inventory; unknown rights remain explicitly marked for review.",
            publishAttempt.attempt,
          );
          const packagePath = path.join(publishAttempt.directory, "publish_package.json");
          const persistedApproval = currentPublishApproval(context) ?? approvalDecision;
          const payload = {
            version: "video-factory/publish-package-v1",
            runId: context.runId,
            platform: publishBrief.platform,
            title: copyOutcome.copy.title,
            copy: {
              source: copyOutcome.source,
              title: copyOutcome.copy.title,
              description: copyOutcome.copy.description,
              hashtags: copyOutcome.copy.hashtags,
              ...(copyOutcome.fallbackReason !== undefined ? { fallbackReason: copyOutcome.fallbackReason } : {}),
            },
            approval: persistedApproval
              ? {
                  status: "approved",
                  actor: persistedApproval.actor,
                  note: persistedApproval.note ?? "",
                  action: persistedApproval.action,
                  interventionId: persistedApproval.interventionId,
                  ...("id" in persistedApproval && typeof persistedApproval.id === "string"
                    ? { decisionId: persistedApproval.id }
                    : {}),
                  ...(persistedApproval.reviewEvidenceId ? { reviewEvidenceId: persistedApproval.reviewEvidenceId } : {}),
                  reviewArtifactIds: finalReviewArtifactIdsFromOutput(context.outputs.get("final-review")),
                }
              : {
                  status: "approved",
                  actor: "automatic-review",
                  note: "",
                  action: "approve",
                  reviewArtifactIds: finalReviewArtifactIdsFromOutput(context.outputs.get("final-review")),
                },
            aigc: {
              disclosureRequired: true,
              explicitLabelChecked: true,
              explicitLabelText: "AI 辅助创作",
              implicitMetadataWritten: true,
              platformDeclarationRequired: true,
              humanReviewRequiredBeforeUpload: true,
            },
            resourceManifest: {
              version: resourceManifest.version,
              itemCount: resourceManifest.items.length,
              needsReviewCount: resourceManifest.items.filter((item) => (
                requiresRightsReviewCategory(item.category) && item.reviewStatus === "needs_review"
              )).length,
            },
            artifacts: currentArtifacts.map(publishArtifactDescriptor),
          };
          const packageContent = `${JSON.stringify(payload, null, 2)}\n`;
          await writeTextAtomically(packagePath, packageContent);
          return {
            status: "succeeded",
            output: { publishPackagePath: packagePath, resourceManifestPath },
            receipt: copyOutcome.trace
              ? {
                  ...modelTraceReceipt(copyOutcome.trace, "Codex 发行编辑", "subscription", copyOutcome.agentLoop),
                  ...(copyOutcome.fallbackReason ? { fallbackReason: copyOutcome.fallbackReason } : {}),
                }
              : {
                  providerId: "video-factory-publish-package-v1",
                  providerLabel: "本地发布包",
                  modelId: "deterministic-copy-fallback-v1",
                  transport: "local_process",
                  billing: "free",
                  configurationSource: "system_default",
                  parameters: { copySource: copyOutcome.source },
                },
            artifacts: [
              fileArtifact(
                "publish_package",
                packagePath,
                packageContent,
                "application/json",
                "video-factory/publish-package-v1",
                "publish-package",
                artifactIds,
                "video-factory-ts-v1",
                "Generated publish package; platform upload remains a manual action.",
                publishAttempt.attempt,
              ),
              resourceManifestArtifact,
              ...copyArtifacts,
            ],
          };
        },
        validateOverride: (output) => {
          const value = validatePathOutput(output, "publishPackagePath", "publish-package");
          return value.resourceManifestPath === undefined
            ? value
            : { ...value, resourceManifestPath: requiredOutputString(value, "resourceManifestPath") };
        },
      },
    ];

    return {
      id: "daily-production",
      name: "Daily short-video production",
      version: productionWorkflowVersion(brief),
      nodes: boundaryGatesEnabled(brief) ? nodes.map(withBoundaryGate) : nodes,
    };
  }
}

// 边界闸门：节点照常执行，执行成功后不直接放行，而是把控制权交回用户，等他按下"进入下一步"。
// 停点只由一个不带 kind 的 needs_human 表达——带 kind 会落到 creative_review 那类专门路径，
// 而这里要的是通用路径：批准即把本节点标 succeeded、产物与回执原样保留、不重跑本节点。
// 自己就返回 needs_human 的节点（final-review 等）原样放过，不二次包裹。
export function withBoundaryGate(node: NodeDefinition): NodeDefinition {
  const execute = node.execute;
  if (!execute) return node;
  return {
    ...node,
    execute: async (input, context) => {
      // qualityGates 只在"执行成功"之后评估（workflow-runner 的 evaluateQualityGates），而边界包装
      // 会把成功整个换成人工停点——两者叠加会让一个不可绕过的约束在没人看见的地方消失，而停点上
      // 还摆着一个"批准"按钮。今天没有任何节点声明 qualityGates，所以这条路走不到；真到了那一天，
      // 需要先决定这些约束与人工停点的先后，而不是在这里静默降级。
      if (node.qualityGates?.length) {
        throw new Error(`节点 '${node.id}' 声明了 qualityGates，边界闸门无法在保留这些约束的前提下停下：请先决定约束与人工停点的先后，再启用边界闸门。`);
      }
      const result = await execute(input, context);
      // 成功臂的 status 是可选的，undefined 与 "succeeded" 同义，两者都要拦下来。
      if (result.status !== undefined && result.status !== "succeeded") return result;
      return {
        ...result,
        status: "needs_human",
        intervention: {
          boundary: "node-complete",
          // 刻意不拼 node.label：它是内部的英文标识（"Validate brief"），拼进来就成了
          // 「Validate brief已完成」这种半截中英混排。步骤名由界面按 nodeId 用它自己的中文表渲染。
          reason: "这一步已完成，等你确认后进入下一步。",
          requiredAction: "approve",
          options: ["approve", "reject"],
        },
      };
    },
  };
}

function boundaryGatesEnabled(brief: Pick<ProductionBrief, "workflowFeatures">): boolean {
  return brief.workflowFeatures?.boundaryGates === "user-confirmed-v1";
}

function currentPublishApproval(context: WorkflowContext): WorkflowContext["decisions"][number] | undefined {
  const finalReview = isObjectRecord(context.outputs.get("final-review"))
    ? context.outputs.get("final-review") as Record<string, unknown>
    : undefined;
  const evidenceId = typeof finalReview?.reviewEvidenceId === "string" ? finalReview.reviewEvidenceId : undefined;
  return [...context.decisions].reverse().find((decision) => (
    decision.action === "approve"
    && (evidenceId === undefined || decision.reviewEvidenceId === evidenceId)
  ));
}

function finalReviewEvidenceId(node: WorkflowRun<ProductionBrief>["nodeRuns"][number]): string | null {
  if (node.nodeId !== "final-review" || !isObjectRecord(node.output)) return null;
  const value = node.output.reviewEvidenceId;
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/**
 * 规划节点回执里记着的那一条独立复核的编号。规划状态整份落在节点输出里，所以"他看到的是哪一条"
 * 在命令边界上就能查到，不必等到图里才知道。
 */
function recordedCreativeCheckIdentity(
  node: WorkflowRun<ProductionBrief>["nodeRuns"][number],
  stage: string,
): string | undefined {
  if (!isObjectRecord(node.output) || !isObjectRecord(node.output.creativeReview)) return undefined;
  const stages = node.output.creativeReview.stages;
  if (!isObjectRecord(stages) || !isObjectRecord(stages[stage])) return undefined;
  const checkResult = stages[stage].checkResult;
  if (!isObjectRecord(checkResult) || typeof checkResult.checkIdentity !== "string") return undefined;
  return checkResult.checkIdentity;
}

function currentVisualReviewDelivery(run: WorkflowRun<ProductionBrief>): unknown {
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === "visual-review");
  return node?.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId)?.output ?? node?.output;
}

class WorkerProvider implements Provider<Record<string, unknown>, WorkerResponse> {
  readonly id: string;
  readonly capability: Capability;

  constructor(
    private readonly config: ProviderConfig,
    private readonly worker: WorkerClient,
    private readonly runsRoot: string,
  ) {
    this.id = config.id;
    this.capability = config.capability;
  }

  get label(): string { return this.config.metadata?.label ?? this.id; }
  get modelId(): string { return this.config.metadata?.modelId ?? this.id; }
  get transport(): ProductionProviderRuntimeMetadata["transport"] { return this.config.metadata?.transport ?? "local_process"; }
  get billing(): ProductionProviderRuntimeMetadata["billing"] { return this.config.metadata?.billing ?? "local_compute"; }
  get approvalPolicy(): ApprovalPolicy { return this.config.metadata?.approvalPolicy ?? (this.billing === "metered" ? "manual" : "none"); }
  get configurationSource(): ExecutionConfigurationSource { return this.config.configurationSource; }
  get parameters(): Record<string, ExecutionParameterValue> { return receiptParameters(this.config.parameters); }
  get estimatedCostCny(): number { return this.config.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number {
    if (this.config.metadata?.billing !== "metered") return 0;
    const configuredLimit = this.config.parameters.maxCostCny;
    if (typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit > 0) {
      return configuredLimit;
    }
    return roundCurrency((this.config.metadata.estimatedCostCny ?? 0) * this.maxAttempts);
  }
  get maxAttempts(): number {
    return this.config.metadata?.billing === "metered" && typeof this.config.metadata.maxAttempts === "number"
      ? this.config.metadata.maxAttempts
      : 1;
  }

  /**
   * 花费报价前先问执行器：这次还会不会真的向 provider 买新素材。
   * 报价只按脚本指纹判断复用，任何脚本字节变化（例如"换一版这一镜素材"）都会让全部付费镜头
   * 重新计入报价，于是四个一分钱都不用花的镜头被算成 ¥17 并撞上次数上限，闸门要求改方案——
   * 而执行期其实全部按请求身份携带复用。这里把执行期的判据前移到报价，闸门才与事实一致。
   */
  private async forecastReusableAssetQuoteItemIds(
    input: Record<string, unknown>,
    context: WorkflowContext,
  ): Promise<ReadonlySet<string>> {
    const forecast = this.worker.forecastPaidAssetSpend;
    if (!forecast) return new Set();
    const result = await forecast.call(this.worker, {
      input,
      parameters: { ...this.config.parameters, providerId: this.id },
      nodeDirectory: path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId),
    }).catch(() => undefined);
    return new Set(result?.reusableQuoteItemIds ?? []);
  }

  async quoteSpend(input: Record<string, unknown>, context: WorkflowContext): Promise<SpendQuote> {
    await verifyExecutablePlanInput(input, context, this.runsRoot);
    if (this.capability !== "asset.prepare") {
      return { estimatedCostCny: this.estimatedCostCny, maxCostCny: this.maxCostCny };
    }
    const modelSelections = stringRecord(this.config.parameters.modelSelections, "modelSelections");
    if (this.id === "ai-shot-router-v1") {
      const scriptPath = requiredOutputString(input, "scriptPath");
      const directorPlanPath = requiredOutputString(input, "directorPlanPath");
      const sceneDurations = await readScriptSceneDurations(scriptPath);
      const directorPlan = requireOutputRecord(JSON.parse(await readFile(directorPlanPath, "utf8")), "director plan");
      if (!Array.isArray(directorPlan.shots)) throw new Error("Director plan shots must be an array before quoting assets.");
      const quoteShots = directorPlan.shots.map((entry, index) => {
        const shot = requireOutputRecord(entry, `director plan shot ${index + 1}`);
        const scenePosition = Number(shot.scenePosition);
        if (!Number.isInteger(scenePosition) || scenePosition < 1) {
          throw new Error(`Director plan shot ${index + 1} has an invalid scene position.`);
        }
        const sourceInSeconds = shot.sourceInSeconds === undefined ? 0 : Number(shot.sourceInSeconds);
        const reuseFromScenePosition = typeof shot.reuseFromScenePosition === "number"
          ? shot.reuseFromScenePosition
          : undefined;
        return {
          shot,
          scenePosition,
          sourceInSeconds,
          ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
          query: typeof shot.query === "string" ? shot.query : "",
        };
      });
      const requiredDurationByRoot = requiredGeneratedAssetDurationSecondsByRoot(
        [...sceneDurations].map(([position, duration]) => ({ position, duration })),
        quoteShots,
      );
      const carriedScenePositions = new Set(await inspectReworkCarriedAssetScenePositions({
        runsRoot: this.runsRoot,
        input,
        currentScript: requireOutputRecord(JSON.parse(await readFile(scriptPath, "utf8")), "script"),
        currentDirectorPlan: directorPlan,
        modelSelections,
      }));
      const excludedNotes = new Map<number, string>();
      const pricedItems: Array<{ scenePosition: number; item: NonNullable<SpendQuote["items"]>[number] }> = [];
      const items = quoteShots.flatMap(({ shot, scenePosition, reuseFromScenePosition }) => {
        const directorEstimatedCostCny = Number(shot.estimatedCostCny);
        if (!Number.isFinite(directorEstimatedCostCny) || directorEstimatedCostCny < 0) {
          throw new Error(`Director plan shot ${scenePosition} has an invalid server cost.`);
        }
        // 报价只列付费条目，因此"不花钱的镜头"必须在确认页上单独交代：否则操作员无法
        // 区分"这镜头免费"和"这镜头被漏算"，只能靠事后追问。
        const reuseSourceScenePosition = assetReuseSourceScenePosition({
          ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
          query: typeof shot.query === "string" ? shot.query : "",
        });
        const excludedNote = carriedScenePositions.has(scenePosition)
          ? "沿用返修前已生成的画面，不重复购买"
          : reuseSourceScenePosition !== undefined
            ? `复用镜头 ${reuseSourceScenePosition} 的画面，不重复购买`
            : directorEstimatedCostCny === 0
              ? "免费素材，不需要购买"
              : undefined;
        if (excludedNote !== undefined) {
          excludedNotes.set(scenePosition, excludedNote);
          return [];
        }
        const providerId = requiredOutputString(shot, "preferredProviderId");
        const modelId = modelSelections[providerId];
        if (!modelId) throw new Error(`Paid asset provider '${providerId}' has no resolved model for quoting.`);
        const sceneDuration = sceneDurations.get(scenePosition);
        if (sceneDuration === undefined) {
          throw new Error(`Director plan shot ${scenePosition} has no matching script scene for quoting.`);
        }
        const requiredDuration = requiredDurationByRoot.get(scenePosition) ?? sceneDuration;
        const item = {
          id: `scene-${scenePosition}`,
          label: `镜头 ${scenePosition}`,
          providerId,
          modelId,
          estimatedCostCny: this.assetEstimatedCostCny(
            providerId,
            modelId,
            requiredDuration,
            directorEstimatedCostCny,
          ),
        };
        pricedItems.push({ scenePosition, item });
        return [item];
      });
      const reconciledItems = await this.incrementalAssetQuoteItems(
        items,
        [scriptPath, directorPlanPath],
        context,
        await this.forecastReusableAssetQuoteItemIds(input, context),
      );
      if (reconciledItems.reconciliationRequired) {
        return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false };
      }
      for (const { scenePosition, item } of pricedItems) {
        if (!reconciledItems.items.some((candidate) => candidate.id === item.id)) {
          excludedNotes.set(scenePosition, "本 run 已有可用画面，不重复购买");
        }
      }
      if (reconciledItems.items.length === 0) {
        return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false, ...excludedItemsField(excludedNotes) };
      }
      const estimatedCostCny = roundCurrency(reconciledItems.items.reduce((sum, item) => sum + item.estimatedCostCny, 0));
      return {
        estimatedCostCny,
        maxCostCny: roundCurrency(estimatedCostCny * this.maxAttempts),
        items: reconciledItems.items,
        ...excludedItemsField(excludedNotes),
      };
    }

    const scriptPath = requiredOutputString(input, "scriptPath");
    const sceneDurations = await readScriptSceneDurations(scriptPath);
    const script = requireOutputRecord(JSON.parse(await readFile(scriptPath, "utf8")), "script");
    if (!Array.isArray(script.scenes)) throw new Error("Script scenes must be an array before quoting assets.");
    const excludedNotes = new Map<number, string>();
    const pricedItems: Array<{ scenePosition: number; item: NonNullable<SpendQuote["items"]>[number] }> = [];
    const items = script.scenes.flatMap((entry, index) => {
      const scene = requireOutputRecord(entry, `script scene ${index + 1}`);
      const scenePosition = Number(scene.position);
      if (scene.visual_strategy === "local") {
        if (!Number.isInteger(scenePosition) || scenePosition < 1) throw new Error(`Script scene ${index + 1} has an invalid position.`);
        excludedNotes.set(scenePosition, "免费素材，不需要购买");
        return [];
      }
      if (!Number.isInteger(scenePosition) || scenePosition < 1) throw new Error(`Script scene ${index + 1} has an invalid position.`);
      const sceneDuration = sceneDurations.get(scenePosition);
      if (sceneDuration === undefined) throw new Error(`Script scene ${index + 1} has no valid duration.`);
      const item = {
        id: `scene-${scenePosition}`,
        label: `镜头 ${scenePosition}`,
        providerId: this.id,
        modelId: this.modelId,
        estimatedCostCny: this.assetEstimatedCostCny(
          this.id,
          this.modelId,
          sceneDuration,
          this.estimatedCostCny,
        ),
      };
      pricedItems.push({ scenePosition, item });
      return [item];
    });
    const reconciledItems = await this.incrementalAssetQuoteItems(items, [scriptPath], context);
    if (reconciledItems.reconciliationRequired) {
      return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false };
    }
    for (const { scenePosition, item } of pricedItems) {
      if (!reconciledItems.items.some((candidate) => candidate.id === item.id)) {
        excludedNotes.set(scenePosition, "本 run 已有可用画面，不重复购买");
      }
    }
    if (reconciledItems.items.length === 0) {
      return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false, ...excludedItemsField(excludedNotes) };
    }
    const estimatedCostCny = roundCurrency(reconciledItems.items.reduce((sum, item) => sum + item.estimatedCostCny, 0));
    return {
      estimatedCostCny,
      maxCostCny: roundCurrency(estimatedCostCny * this.maxAttempts),
      items: reconciledItems.items,
      ...excludedItemsField(excludedNotes),
    };
  }

  private async incrementalAssetQuoteItems(
    items: NonNullable<SpendQuote["items"]>,
    sourcePaths: string[],
    context: WorkflowContext,
    /**
     * 执行器按逐素材请求身份证明"本次不会新增花费"的素材键。它覆盖 sourceFingerprint 口径
     * 覆盖不到的情形：脚本因某一镜改动而换字节时，其余镜头的付费请求逐字未变、本就不该重买。
     */
    provenReusableItemIds: ReadonlySet<string> = new Set(),
  ): Promise<{ items: NonNullable<SpendQuote["items"]>; reconciliationRequired: boolean }> {
    const sourceFingerprint = await paidAssetSourceFingerprint(sourcePaths);
    const ledgerItems = paidAssetLedgerLeaves(await inspectPaidAssetLedger(
      path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId),
    )).filter((item) => item.sourceFingerprint === sourceFingerprint);
    const reusableMaterializedItemIds = new Set((await Promise.all(ledgerItems.map(async (candidate) => (
      candidate.state === "materialized" && await materializedAssetFileMatchesLedger(candidate)
        ? candidate.itemRequestId
        : undefined
    )))).filter((itemRequestId): itemRequestId is string => itemRequestId !== undefined));
    const matches = (item: NonNullable<SpendQuote["items"]>[number]) => ledgerItems.filter((candidate) => (
      candidate.quoteItemId === item.id
      && candidate.providerId === item.providerId
      && candidate.modelId === item.modelId
    ));
    const reusableIds = new Set(items.filter((item) => (
      provenReusableItemIds.has(item.id)
      || matches(item).some((candidate) => (
        candidate.state === "materialized" && reusableMaterializedItemIds.has(candidate.itemRequestId)
        || candidate.state === "provider_succeeded" && Boolean(candidate.taskId) && Boolean(candidate.resultUrl)
      ))
    )).map((item) => item.id));
    const reconciliationRequired = items.some((item) => !reusableIds.has(item.id) && matches(item).some((candidate) => (
      candidate.state === "submitted"
      || candidate.state === "unknown"
      || candidate.state === "provider_succeeded"
    )));
    return {
      items: items.filter((item) => !reusableIds.has(item.id)),
      reconciliationRequired,
    };
  }

  private assetEstimatedCostCny(
    providerId: string,
    modelId: string,
    sceneDurationSeconds: number,
    fallbackEstimatedCostCny: number,
  ): number {
    const metadata = providerId === this.id
      ? this.config.metadata
      : this.config.assetRuntimeMetadata?.get(providerId);
    const profile = metadata?.modelProfiles?.find((candidate) => candidate.modelId === modelId);
    if (profile?.aspectRatios && !profile.aspectRatios.includes("9:16")) {
      throw new Error(`Video model '${modelId}' does not support the required 9:16 aspect ratio.`);
    }
    const estimatedCnyPerClip = profile?.estimatedCostCny ?? metadata?.estimatedCostCny ?? fallbackEstimatedCostCny;
    return estimateVideoGenerationCostCny(
      sceneDurationSeconds,
      estimatedCnyPerClip,
      videoPricingProfile(profile),
    );
  }

  async run(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkerResponse> {
    await verifyExecutablePlanInput(input, context, this.runsRoot);
    const attempt = await reserveAttemptDirectory(path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId));
    const outputDir = attempt.directory;
    const parameters: Record<string, unknown> = { ...this.config.parameters, providerId: this.config.id };
    if (this.billing === "metered") {
      const authorization = context.spendAuthorization;
      const noSpendExecution = context.spendAuthorizationExemptProviderId === this.id;
      if (!authorization && noSpendExecution) {
        const quote = await this.quoteSpend(input, context);
        if (quote.requiresAuthorization !== false) {
          throw new Error(`Metered provider '${this.id}' no-spend execution no longer matches its current quote.`);
        }
        parameters.maxCostCny = 0;
        parameters.maxAttempts = 0;
        parameters.estimatedCostCny = 0;
      } else if (!authorization && this.approvalPolicy === "automatic") {
        parameters.maxCostCny = this.maxCostCny;
        parameters.maxAttempts = this.maxAttempts;
        parameters.estimatedCostCny = this.estimatedCostCny;
      } else if (!authorization || authorization.providerId !== this.id || authorization.modelId !== this.modelId) {
        throw new Error(`Metered provider '${this.id}' has no matching active authorization.`);
      } else {
        parameters.maxCostCny = authorization.maxCostCny;
        parameters.maxAttempts = authorization.maxAttempts;
        parameters.estimatedCostCny = this.estimatedCostCny;
        // C1：scope 派生的逐素材 create 预算随子凭证下发；worker 在每个 create 边界执行，
        // 超预算的 create 在越过付费边界前 fail closed（停在可操作状态，不静默降级）。
        if (authorization.itemCreateBudgets) {
          parameters.itemCreateBudgets = { ...authorization.itemCreateBudgets };
        }
      }
    }
    const response = await this.worker.run({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      commandId: context.operationRequestId ?? context.nextId("command"),
      runId: context.runId,
      nodeRunId: this.config.nodeId,
      attempt: attempt.attempt,
      capability: this.config.capability,
      input,
      parameters,
      outputDir,
    });
    await verifyWorkerArtifacts(response, outputDir);
    if (this.config.capability === "asset.search") {
      await verifyWorkerPrivateOutputPath(response.output?.candidateInventoryPath, outputDir);
    }
    return response;
  }
}

async function materializedAssetFileMatchesLedger(item: PaidAssetLedgerItemSummary): Promise<boolean> {
  const sizeBytes = item.sizeBytes;
  if (!item.localPath
    || !item.sha256
    || !/^[a-f0-9]{64}$/i.test(item.sha256)
    || typeof sizeBytes !== "number"
    || !Number.isInteger(sizeBytes)
    || sizeBytes <= 0) {
    return false;
  }
  try {
    await verifyArtifactBytes(item.localPath, item.sha256, sizeBytes);
    return true;
  } catch {
    return false;
  }
}

async function readScriptSceneDurations(scriptPath: string): Promise<Map<number, number>> {
  const script = requireOutputRecord(JSON.parse(await readFile(scriptPath, "utf8")), "script");
  if (!Array.isArray(script.scenes)) throw new Error("Script scenes must be an array before quoting assets.");
  const durations = new Map<number, number>();
  for (const [index, entry] of script.scenes.entries()) {
    const scene = requireOutputRecord(entry, `script scene ${index + 1}`);
    const position = Number(scene.position);
    const duration = Number(scene.duration);
    if (!Number.isInteger(position) || position < 1 || durations.has(position)) {
      throw new Error(`Script scene ${index + 1} has an invalid or duplicate position.`);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Script scene ${index + 1} has an invalid duration.`);
    }
    durations.set(position, duration);
  }
  return durations;
}

function videoPricingProfile(
  profile: ProductionProviderModelRuntimeMetadata | undefined,
): VideoGenerationRuntimeProfile | undefined {
  if (!profile
    || !profile.taskTypes
    || !profile.resolutions
    || profile.minDurationSeconds === undefined
    || profile.maxDurationSeconds === undefined
    || profile.supportsAudio === undefined) {
    return undefined;
  }
  return {
    taskTypes: [...profile.taskTypes],
    resolutions: [...profile.resolutions],
    ...(profile.aspectRatios ? { aspectRatios: [...profile.aspectRatios] } : {}),
    minDurationSeconds: profile.minDurationSeconds,
    maxDurationSeconds: profile.maxDurationSeconds,
    supportsAudio: profile.supportsAudio,
    ...(profile.allowedDurationsSeconds
      ? { allowedDurationsSeconds: [...profile.allowedDurationsSeconds] }
      : {}),
    ...(profile.estimatedCnyPerSecond !== undefined
      ? { estimatedCnyPerSecond: profile.estimatedCnyPerSecond }
      : {}),
    ...(profile.estimatedCnyPerSecondByResolution
      ? { estimatedCnyPerSecondByResolution: { ...profile.estimatedCnyPerSecondByResolution } }
      : {}),
    ...(profile.estimatedCnyByResolutionAndDuration
      ? { estimatedCnyByResolutionAndDuration: structuredClone(profile.estimatedCnyByResolutionAndDuration) }
      : {}),
  };
}

// 回执里的 promptPack 是"这份输出由哪版合同产生"的证据。它必须与 codex-broker 中
// visual-review 任务定义的 version 一致（apps/codex-broker/src/task-definitions.ts）；
// 两个 workspace 之间没有依赖，只能靠这处常量对齐，改 broker 合同时必须同步这里。
const VISUAL_REVIEW_PROMPT_PACK = "video-factory/visual-review-v20";

class VisualDirectorProvider implements Provider<VisualDirectorAgentInput, CodexTaskExecution<unknown>> {
  readonly capability: Capability = "storyboard.plan";
  readonly label = "Codex 视觉导演";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;
  readonly parameters = { promptPack: "video-factory/director-v29" };

  constructor(
    private readonly agent: VisualDirectorAgent,
    private readonly selectedModelId: string | undefined,
    readonly configurationSource: ExecutionConfigurationSource,
  ) {}

  get id(): string {
    return this.agent.id;
  }

  get modelId(): string {
    return this.selectedModelId ?? this.agent.modelId ?? "codex-default";
  }

  async run(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<unknown>> {
    const { selectedModelId: _staleSelectedModelId, ...currentInput } = input;
    const configuredInput = {
      ...currentInput,
      ...(this.selectedModelId ? { selectedModelId: this.selectedModelId } : {}),
    };
    return this.agent.planDetailed
      ? this.agent.planDetailed(configuredInput)
      : { output: await this.agent.plan(configuredInput) };
  }
}

class ScreenwriterProvider implements Provider<ScreenwriterAgentInput, CodexTaskExecution<unknown>> {
  readonly capability: Capability = "script.draft";
  readonly label = "AI 编剧";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;
  readonly parameters = { promptPack: "video-factory/screenwriter-v18" };

  constructor(
    private readonly agent: ScreenwriterAgent,
    private readonly selectedModelId: string | undefined,
    readonly configurationSource: ExecutionConfigurationSource,
  ) {}

  get id(): string {
    return this.agent.id;
  }

  get modelId(): string {
    return this.selectedModelId ?? this.agent.modelId ?? "codex-default";
  }

  async run(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>> {
    const { selectedModelId: _staleSelectedModelId, ...currentInput } = input;
    const configuredInput = {
      ...currentInput,
      ...(this.selectedModelId ? { selectedModelId: this.selectedModelId } : {}),
    };
    return this.agent.draftDetailed
      ? this.agent.draftDetailed(configuredInput)
      : { output: await this.agent.draft(configuredInput) };
  }
}

class VisualReviewProvider implements Provider<VisualReviewAgentInput, VisualReviewExecution> {
  readonly capability: Capability = "quality.review.visual";

  constructor(
    private readonly agent: VisualReviewAgent,
    private readonly metadata?: ProductionProviderRuntimeMetadata,
  ) {}

  get id(): string { return this.agent.id; }
  get label(): string { return this.metadata?.label ?? "Codex 视觉审片"; }
  get modelId(): string { return this.agent.modelId; }
  get transport(): ProductionProviderRuntimeMetadata["transport"] { return this.metadata?.transport ?? "unix_socket"; }
  get billing(): ProductionProviderRuntimeMetadata["billing"] { return this.metadata?.billing ?? "subscription"; }
  get approvalPolicy(): ApprovalPolicy { return this.metadata?.approvalPolicy ?? "none"; }
  get configurationSource(): ExecutionConfigurationSource { return "system_default"; }
  get parameters(): Record<string, ExecutionParameterValue> { return { sampleMode: "runtime_verified", promptPack: VISUAL_REVIEW_PROMPT_PACK, agentLoopMaxIterations: 3, independentAudit: true }; }
  get estimatedCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number { return roundCurrency((this.metadata?.estimatedCostCny ?? 0) * this.maxAttempts); }
  get maxAttempts(): number { return Math.max(3, this.metadata?.maxAttempts ?? 3); }
  async run(input: VisualReviewAgentInput, context: WorkflowContext): Promise<VisualReviewExecution> {
    const request = context.operationRequestId
      ? { ...input, requestId: context.operationRequestId }
      : input;
    return this.agent.reviewDetailed
      ? this.agent.reviewDetailed(request)
      : { output: await this.agent.review(request) };
  }
}

class UnavailableVisualReviewProvider implements Provider<VisualReviewAgentInput, VisualReviewExecution> {
  readonly capability: Capability = "quality.review.visual";

  constructor(
    readonly id: string,
    private readonly metadata?: ProductionProviderRuntimeMetadata,
  ) {}

  get label(): string { return this.metadata?.label ?? "视觉审片（暂不可用）"; }
  get modelId(): string { return this.metadata?.modelId ?? "configured-model"; }
  get transport(): ProductionProviderRuntimeMetadata["transport"] { return this.metadata?.transport ?? "unix_socket"; }
  get billing(): ProductionProviderRuntimeMetadata["billing"] { return this.metadata?.billing ?? "subscription"; }
  get approvalPolicy(): ApprovalPolicy { return this.metadata?.approvalPolicy ?? "none"; }
  get configurationSource(): ExecutionConfigurationSource { return "system_default"; }
  get estimatedCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxAttempts(): number { return this.metadata?.maxAttempts ?? 1; }

  run(): Promise<VisualReviewExecution> {
    throw new Error(`Visual review provider '${this.id}' is temporarily unavailable; configure it and regenerate this node.`);
  }
}

function productionPreflightNode(brief: ProductionBrief, runsRoot: string): NodeDefinition {
  const dependsOn = brief.workflowFeatures?.assetSemanticRank
    ? ["asset-semantic-rank"]
    : ["visual-direction"];
  return {
    id: "production-preflight",
    label: "Compile executable production plan",
    role: "制片编译",
    capability: "production.plan.compile",
    mode: "automatic",
    dependsOn,
    getInput: (context) => ({
      scriptPath: outputPath(context, "script", "scriptPath"),
      directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath"),
      ...(brief.workflowFeatures?.assetSemanticRank ? {
        candidateSearchPath: outputPath(context, "asset-candidates", "candidateSearchPath"),
        candidateRankingPath: outputPath(context, "asset-semantic-rank", "candidateRankingPath"),
      } : {}),
    }),
    validateInputOverride: (input) => {
      const value = requireOutputRecord(input, "production-preflight input");
      return {
        scriptPath: requiredOutputString(value, "scriptPath"),
        directorPlanPath: requiredOutputString(value, "directorPlanPath"),
        ...(brief.workflowFeatures?.assetSemanticRank ? {
          candidateSearchPath: requiredOutputString(value, "candidateSearchPath"),
          candidateRankingPath: requiredOutputString(value, "candidateRankingPath"),
        } : {}),
      };
    },
    execute: async (input, context) => {
      const currentBrief = currentEffectiveBriefFromContext(context, brief);
      if (!currentBrief.durationRange || !currentBrief.director) {
        throw new Error("Production preflight requires a duration range and director plan.");
      }
      const request = requireOutputRecord(input, "production-preflight input");
      const runRoot = path.join(runsRoot, context.runId);
      const scriptArtifact = await currentSourceArtifact({
        context,
        runRoot,
        nodeId: "script",
        kind: "script",
        uri: requiredOutputString(request, "scriptPath"),
        schemaVersion: ["video-factory/script-draft-v1", "video-factory/script-v1"],
      });
      const directorArtifact = await currentSourceArtifact({
        context,
        runRoot,
        nodeId: "visual-direction",
        kind: "storyboard",
        uri: requiredOutputString(request, "directorPlanPath"),
        schemaVersion: "video-factory/director-plan-v1",
      });
      if (!directorArtifact.parentArtifactIds?.includes(scriptArtifact.id)) {
        throw new Error("Current director artifact is not derived from the current script artifact.");
      }

      const candidateArtifacts: Artifact[] = [];
      if (currentBrief.workflowFeatures?.assetSemanticRank) {
        const candidateArtifact = await currentSourceArtifact({
          context,
          runRoot,
          nodeId: "asset-candidates",
          kind: "asset_candidates",
          uri: requiredOutputString(request, "candidateSearchPath"),
          schemaVersion: "video-factory/asset_candidates-v1",
        });
        if (!candidateArtifact.parentArtifactIds?.includes(scriptArtifact.id)
          || !candidateArtifact.parentArtifactIds?.includes(directorArtifact.id)) {
          throw new Error("Current candidate artifact is not derived from the current script and director artifacts.");
        }
        const rankingArtifact = await currentSourceArtifact({
          context,
          runRoot,
          nodeId: "asset-semantic-rank",
          kind: "asset_ranking",
          uri: requiredOutputString(request, "candidateRankingPath"),
          schemaVersion: "video-factory/asset-ranking-v1",
        });
        if (!rankingArtifact.parentArtifactIds?.includes(candidateArtifact.id)) {
          throw new Error("Current ranking artifact is not derived from the current candidate artifact.");
        }
        candidateArtifacts.push(candidateArtifact, rankingArtifact);
      }

      const [script, directorPlan] = await Promise.all([
        readJsonObject(scriptArtifact.uri!, "current script artifact"),
        readJsonObject(directorArtifact.uri!, "current director artifact"),
      ]);
      const plan = compileExecutableProductionPlan({
        scriptArtifactId: scriptArtifact.id,
        directorArtifactId: directorArtifact.id,
        candidateArtifactIds: candidateArtifacts.map((artifact) => artifact.id),
        durationRange: currentBrief.durationRange,
        scenes: executablePlanScenes(script.scenes),
        shots: executablePlanShots(directorPlan.shots),
      });
      const attempt = await reserveAttemptDirectory(path.join(runRoot, "nodes", "production-preflight"));
      const planPath = path.join(attempt.directory, "executable_plan.json");
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      await writeTextAtomically(planPath, content);
      const parentArtifactIds = [scriptArtifact.id, directorArtifact.id, ...candidateArtifacts.map((artifact) => artifact.id)];
      return {
        status: "succeeded",
        output: { executablePlanPath: planPath },
        artifacts: [fileArtifact(
          "executable_plan",
          planPath,
          content,
          "application/json",
          "video-factory/executable-plan-v1",
          "production-preflight",
          parentArtifactIds,
          "video-factory-ts-v1",
          "Deterministically compiled production timing and source references.",
          attempt.attempt,
        )],
      };
    },
    validateOverride: (output) => validatePathOutput(output, "executablePlanPath", "production-preflight"),
  };
}

async function currentSourceArtifact(options: {
  context: WorkflowContext;
  runRoot: string;
  nodeId: string;
  kind: string;
  uri: string;
  schemaVersion: string | readonly string[];
}): Promise<Artifact> {
  const artifact = [...options.context.artifacts].reverse().find((candidate) => (
    candidate.producer?.nodeId === options.nodeId
    && candidate.kind === options.kind
    && candidate.uri === options.uri
  ));
  if (!artifact) {
    throw new Error(`Current ${options.nodeId} output is missing its source artifact.`);
  }
  const allowedSchemas = typeof options.schemaVersion === "string"
    ? [options.schemaVersion]
    : options.schemaVersion;
  if (!artifact.schemaVersion || !allowedSchemas.includes(artifact.schemaVersion)) {
    throw new Error(`Artifact '${artifact.id}' uses unsupported schema '${String(artifact.schemaVersion)}'.`);
  }
  await verifyStoredArtifactWithinRoot(options.runRoot, artifact);
  return artifact;
}

async function readJsonObject(uri: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(uri, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return requireOutputRecord(value, label);
}

async function executablePlanDurationMs(uri: string): Promise<number> {
  const plan = await readJsonObject(uri, "executable production plan");
  if (plan.version !== "video-factory/executable-plan-v1" || plan.fps !== 30
    || !Number.isInteger(plan.totalFrames) || Number(plan.totalFrames) <= 0) {
    throw new Error("Executable production plan has invalid duration metadata.");
  }
  return Number(plan.totalFrames) / 30 * 1_000;
}

function executablePlanScenes(value: unknown): ExecutablePlanScene[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Current script artifact has no scenes.");
  return value.map((entry, index) => {
    const scene = requireOutputRecord(entry, `script scene ${index + 1}`);
    const position = Number(scene.position);
    const duration = Number(scene.duration);
    if (!Number.isInteger(position) || position < 1 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Script scene ${index + 1} has invalid timing.`);
    }
    const beatId = optionalOutputString(scene.beatId);
    return { position, duration, ...(beatId ? { beatId } : {}) };
  });
}

function executablePlanShots(value: unknown): ExecutablePlanShot[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Current director artifact has no shots.");
  return value.map((entry, index) => {
    const shot = requireOutputRecord(entry, `director shot ${index + 1}`);
    const scenePosition = Number(shot.scenePosition);
    if (!Number.isInteger(scenePosition) || scenePosition < 1 || !Array.isArray(shot.temporalBeats)) {
      throw new Error(`Director shot ${index + 1} has invalid timing.`);
    }
    const temporalBeats = shot.temporalBeats.map((beat, beatIndex) => {
      const record = requireOutputRecord(beat, `director shot ${index + 1} temporal beat ${beatIndex + 1}`);
      const startSeconds = Number(record.startSeconds);
      const endSeconds = Number(record.endSeconds);
      const action = optionalOutputString(record.action);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || !action) {
        throw new Error(`Director shot ${index + 1} temporal beat ${beatIndex + 1} is invalid.`);
      }
      return { startSeconds, endSeconds, action };
    });
    const reuseFromScenePosition = shot.reuseFromScenePosition === undefined
      ? undefined
      : Number(shot.reuseFromScenePosition);
    const sourceInSeconds = shot.sourceInSeconds === undefined ? 0 : Number(shot.sourceInSeconds);
    return {
      scenePosition,
      temporalBeats,
      ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
      sourceInSeconds,
    };
  });
}

function referenceGrammarNode(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  runsRoot: string,
): NodeDefinition {
  const reference = brief.referenceVideo;
  const agent = options.referenceGrammarAgent;
  if (!reference || !agent || !options.referenceVideoRoot) {
    throw new Error("Reference grammar requires a configured reference-video store and Codex analysis agent.");
  }
  const jointPlanning = usesJointCreativePlanning(brief);
  return {
    id: "reference-grammar",
    label: "Analyze reference grammar",
    role: "参考视频分析师",
    capability: "reference.grammar",
    providerId: agent.id,
    plannedExecution: {
      providerId: agent.id,
      providerLabel: "Codex 参考视频分析",
      modelId: agent.modelId,
      transport: "unix_socket",
      billing: "subscription",
      configurationSource: "system_default",
      parameters: { sampleMode: "keyframes", promptPack: "video-factory/reference-grammar-v4" },
      estimatedCostCny: 0,
    },
    mode: "automatic",
    // joint-v1 没有 script 节点：参考语法直接依赖 brief，产出在 creative-planning 之前。
    dependsOn: jointPlanning ? ["brief"] : ["script"],
    getInput: () => ({ uploadId: reference.uploadId, label: reference.label, sha256: reference.sha256 }),
    validateInputOverride: (input) => {
      const value = requireOutputRecord(input, "reference-grammar input");
      if (requiredOutputString(value, "uploadId") !== reference.uploadId) {
        throw new Error("Reference video identity cannot be changed inside an existing run.");
      }
      if (requiredOutputString(value, "sha256") !== reference.sha256) {
        throw new Error("Reference video content identity cannot be changed inside an existing run.");
      }
      return { uploadId: reference.uploadId, label: requiredOutputString(value, "label"), sha256: reference.sha256 };
    },
    execute: async (input, context) => {
      const request = requireOutputRecord(input, "reference-grammar input");
      const retainedReference = [...context.artifacts].reverse().find((artifact) => artifact.kind === "reference_video" && artifact.uri);
      const sourcePath = retainedReference?.uri ?? reference.path;
      const sourceBoundary = retainedReference
        ? path.join(runsRoot, context.runId)
        : options.referenceVideoRoot!;
      const [sourceRoot, sourceRealPath] = await Promise.all([realpath(sourceBoundary), realpath(sourcePath)]);
      const relative = path.relative(sourceRoot, sourceRealPath);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Reference video is outside the controlled upload directory.");
      }
      if (reference.sha256 === "0".repeat(64)) {
        throw new Error("This historical reference video has no content identity; upload it again before regenerating this node.");
      }
      const sourceStats = await stat(sourceRealPath);
      if (!sourceStats.isFile() || sourceStats.size !== reference.sizeBytes) throw new Error("Reference video size no longer matches its upload record.");
      await verifyArtifactBytes(sourceRealPath, reference.sha256, reference.sizeBytes);
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "reference-grammar"));
      const extension = reference.mimeType === "video/webm" ? ".webm" : reference.mimeType === "video/quicktime" ? ".mov" : ".mp4";
      const copiedVideoPath = path.join(attempt.directory, `reference${extension}`);
      await copyFile(sourceRealPath, copiedVideoPath);
      await verifyArtifactBytes(copiedVideoPath, reference.sha256, reference.sizeBytes);
      // joint-v1：受控参考视频在本节点内先行登记，shot_grammar 直接绑定该产物，而不是
      // 指向 joint 拓扑中不存在的 script 产物（旧拓扑仍挂 script 产物，行为不变）。
      let parentArtifactIds: string[];
      if (jointPlanning) {
        const registeredReference = context.addArtifact(await binaryFileArtifact(
          "reference_video",
          copiedVideoPath,
          reference.mimeType,
          "video-factory/reference-video-v1",
          "reference-grammar",
          [],
          "creator-upload",
          "Creator-supplied reference video; retained only as private run input.",
          attempt.attempt,
        ));
        parentArtifactIds = [registeredReference.id];
      } else {
        parentArtifactIds = context.artifacts
          .filter((artifact) => artifact.producer?.nodeId === "script")
          .map((artifact) => artifact.id);
      }
      let execution: ReferenceGrammarExecution | undefined;
      let failedAgentLoop: AgentLoopTrace | undefined;
      let failedTrace: CodexTaskTrace | undefined;
      let fallbackReason: string | undefined;
      let grammar: ShotGrammar;
      try {
        execution = agent.analyzeDetailed
          ? await agent.analyzeDetailed({
              videoPath: copiedVideoPath,
              runRoot: attempt.directory,
              sourceLabel: requiredOutputString(request, "label"),
              agentLoopCheckpoint: nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "reference-grammar",
                { sha256: reference.sha256, label: requiredOutputString(request, "label") },
                REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION,
                undefined,
                context.operationRequestId,
              ),
            })
          : { output: await agent.analyze({ videoPath: copiedVideoPath, runRoot: attempt.directory, sourceLabel: requiredOutputString(request, "label") }) };
        const durationMs = execution.inspectedDurationMs ?? execution.output.durationMs;
        grammar = validateShotGrammar(execution.output, durationMs);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          return failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "reference-grammar",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider: {
              id: agent.id,
              modelId: agent.modelId,
              transport: "unix_socket",
              billing: "subscription",
              configurationSource: "system_default",
              parameters: { sampleMode: "keyframes", promptPack: "video-factory/reference-grammar-v4" },
            },
            providerLabel: "Codex 参考视频分析",
          });
        }
        fallbackReason = publicFallbackReason(error);
        grammar = fallbackShotGrammar(Math.round(brief.durationSeconds * 1_000), fallbackReason);
      }
      const grammarPath = path.join(attempt.directory, "shot_grammar.json");
      const grammarContent = `${JSON.stringify(grammar, null, 2)}\n`;
      await writeTextAtomically(grammarPath, grammarContent);
      const traceArtifact = await persistModelTrace({
        trace: execution?.trace ?? failedTrace,
        attemptDirectory: attempt.directory,
        nodeId: "reference-grammar",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: execution?.agentLoop ?? failedAgentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "reference-grammar",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: { referenceGrammarPath: grammarPath, grammar },
        receipt: {
          ...(execution?.trace ?? failedTrace
            ? {
                ...modelTraceReceipt(
                  (execution?.trace ?? failedTrace)!,
                  "Codex 参考视频分析",
                  "subscription",
                  execution?.agentLoop ?? failedAgentLoop,
                ),
                ...(fallbackReason ? { fallbackReason } : {}),
              }
            : fallbackReason
              ? {
                  providerId: "local-reference-grammar-fallback-v1",
                  providerLabel: "保守参考语法",
                  modelId: "rules-v1",
                  transport: "local_process" as const,
                  billing: "free" as const,
                  configurationSource: "system_default" as const,
                  fallbackFromProviderId: agent.id,
                  fallbackReason,
                }
            : {
                providerId: agent.id,
                providerLabel: "Codex 参考视频分析",
                modelId: agent.modelId,
                transport: "unix_socket" as const,
                billing: "subscription" as const,
                configurationSource: "system_default" as const,
              }),
          parameters: { sampleMode: "keyframes", promptPack: (execution?.trace ?? failedTrace)?.promptVersion ?? "video-factory/reference-grammar-v4" },
          estimatedCostCny: 0,
          requestId: context.nextId("reference-grammar"),
        },
        artifacts: [
          // joint-v1 的 reference_video 已在上方通过 context.addArtifact 预登记（shot_grammar
          // 需要引用其 id）；这里不得重复返回，否则同一文件会注册成两个产物。
          ...(jointPlanning ? [] : [await binaryFileArtifact(
            "reference_video",
            copiedVideoPath,
            reference.mimeType,
            "video-factory/reference-video-v1",
            "reference-grammar",
            parentArtifactIds,
            "creator-upload",
            "Creator-supplied reference video; retained only as private run input.",
            attempt.attempt,
          )]),
          fileArtifact(
            "shot_grammar",
            grammarPath,
            grammarContent,
            "application/json",
            "video-factory/shot-grammar-v1",
            "reference-grammar",
            parentArtifactIds,
            fallbackReason ? "local-reference-grammar-fallback-v1" : agent.id,
            fallbackReason
              ? "Conservative production grammar used because reference analysis failed; review before reuse."
              : "Abstract production grammar extracted from a creator-supplied reference; review before reuse.",
            attempt.attempt,
          ),
          ...(traceArtifact ? [traceArtifact] : []),
          ...(loopArtifact ? [loopArtifact] : []),
        ],
      };
    },
    validateOverride: (output) => {
      const value = requireOutputRecord(output, "reference-grammar");
      return { ...value, referenceGrammarPath: requiredOutputString(value, "referenceGrammarPath") };
    },
  };
}

// joint-v1 下游统一读取入口：所有正式规划产物路径都来自 creative-planning 节点输出，
// 下游节点不得再按旧拓扑读取 script/visual-direction/production-preflight 等节点。
// directorPlan/executablePlan/candidate 字段按拓扑可省略（legacy 无导演/无预检/无图库时缺省），
// joint 的图库路线在 planningCandidatePaths 中对候选路径严格 fail closed。
interface JointPlanningOutputPaths {
  scriptPath: string;
  directorPlanPath?: string;
  executablePlanPath?: string;
  candidateSearchPath?: string;
  candidateRankingPath?: string;
  /** worker 私有库存路径：与公开报告内容/路径不同，真实离线物化消费它。 */
  candidateInventoryPath?: string;
}

function planningOutputs(context: WorkflowContext): JointPlanningOutputPaths {
  const planning = {
    scriptPath: outputPath(context, "creative-planning", "scriptPath"),
    directorPlanPath: outputPath(context, "creative-planning", "directorPlanPath"),
    executablePlanPath: outputPath(context, "creative-planning", "executablePlanPath"),
  };
  const output = context.outputs.get("creative-planning");
  const planningOutput = output !== undefined ? requireOutputRecord(output, "creative-planning") : undefined;
  const candidateSearchPath = optionalOutputString(planningOutput?.candidateSearchPath);
  const candidateRankingPath = optionalOutputString(planningOutput?.candidateRankingPath);
  // 私有库存路径独立于公开报告：与旧拓扑同名字段，物化消费库存本身。
  const candidateInventoryPath = optionalOutputString(planningOutput?.candidateInventoryPath);
  return {
    ...planning,
    ...(candidateSearchPath && candidateRankingPath ? { candidateSearchPath, candidateRankingPath } : {}),
    ...(candidateSearchPath && candidateRankingPath && candidateInventoryPath ? { candidateInventoryPath } : {}),
  };
}

// 规划产物路径的唯一兼容投影：joint 读 creative-planning 节点输出，legacy 读旧规划节点；
// 下游 worker 节点只消费本投影，不再各自判断拓扑。图库路线的私有库存路径两种拓扑同名字段。
function currentPlanningOutputPaths(context: WorkflowContext, brief: ProductionBrief): JointPlanningOutputPaths {
  if (usesJointCreativePlanning(brief)) return planningOutputs(context);
  const directorPlanPath = brief.director ? outputPath(context, "visual-direction", "directorPlanPath") : undefined;
  const executablePlanPath = brief.durationRange && brief.director
    ? outputPath(context, "production-preflight", "executablePlanPath")
    : undefined;
  const candidateRankingPath = brief.workflowFeatures?.assetSemanticRank
    ? outputPath(context, "asset-semantic-rank", "candidateRankingPath")
    : undefined;
  const candidateInventoryPath = brief.workflowFeatures?.assetSemanticRank
    ? outputPath(context, "asset-candidates", "candidateInventoryPath")
    : undefined;
  return {
    scriptPath: outputPath(context, "script", "scriptPath"),
    ...(directorPlanPath !== undefined ? { directorPlanPath } : {}),
    ...(executablePlanPath !== undefined ? { executablePlanPath } : {}),
    ...(candidateRankingPath !== undefined ? { candidateRankingPath } : {}),
    ...(candidateInventoryPath !== undefined ? { candidateInventoryPath } : {}),
  };
}

// 图库路线的候选/排序路径：正式产物缺失必须在此 fail closed，而不是让下游拿到空值。
function planningCandidatePaths(planning: JointPlanningOutputPaths): {
  candidateRankingPath: string;
  candidateInventoryPath: string;
} {
  if (!planning.candidateSearchPath || !planning.candidateRankingPath) {
    throw new Error("Joint creative planning did not produce candidate paths for the library planning route.");
  }
  if (!planning.candidateInventoryPath) {
    throw new Error("Joint creative planning did not preserve the private candidate inventory path; the public candidate report must not be used as the materialization inventory.");
  }
  return {
    candidateRankingPath: planning.candidateRankingPath,
    candidateInventoryPath: planning.candidateInventoryPath,
  };
}

// joint-v1 打包入口：creative-planning 的全部正式产物按 producer 绑定收集。
function jointPlanningPackagingEntry(context: WorkflowContext): Array<{ nodeId: string; paths: string[] }> {
  const planning = planningOutputs(context);
  const paths = [planning.scriptPath, planning.directorPlanPath, planning.executablePlanPath]
    .filter((entry): entry is string => entry !== undefined);
  paths.push(...(planning.candidateSearchPath ? [planning.candidateSearchPath] : []));
  paths.push(...(planning.candidateRankingPath ? [planning.candidateRankingPath] : []));
  return [{
    nodeId: "creative-planning",
    paths,
  }];
}

// joint-v1 规划输入身份：brief 的 durable 领域字段（剔除运行期 taskContractDigests）加上
// 已接受的参考语法内容。身份变化进入新 thread，不得命中旧图结果。
function jointPlanningInputDigest(brief: ProductionBrief, referenceGrammar: ShotGrammar | undefined): string {
  return createHash("sha256").update(stablePlanningDigestJson({
    brief,
    ...(referenceGrammar ? { referenceGrammar } : {}),
  })).digest("hex");
}

// ---------------------------------------------------------------------------
// joint-v1 规划编辑闭包：阶段输入身份、执行历史与跨 thread 保留。
// 编辑产生新 input digest（新 thread）；宿主按“阶段实际输入是否变化”把未受影响的上游
// 阶段产物播种进新 thread（updateState + asOf 游标），实现 treatment/script/director 的
// 依赖闭包失效——不重复调用未受影响的角色，也不删除旧 thread 的 checkpoint。
// ---------------------------------------------------------------------------

// 构思阶段的实际输入投影：与 treatment port 构造的 brief 字段一一对应，加上模型选择身份。
// 选择身份用原始值（不做候选匹配回退）：不可用的选择不得在身份层被归一成默认候选，
// 否则闭包会跳过本应 fail closed 的重新执行（runCandidates 对不可用选择直接拒绝）。
function treatmentStageInputIdentity(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  bindings: ReadonlyArray<{ providerId: string; agent: CreativeTreatmentAgent }>,
  referenceGrammar: ShotGrammar | undefined,
): unknown {
  const lockedViewerPromise = acceptedViewerPromise(brief);
  const seriesContext = creativeTreatmentSeriesContext(brief.seriesContext);
  const reworkInstruction = brief.rework?.nodeInstructions.script.trim();
  return {
    brief: {
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      nicheSlug: brief.nicheSlug,
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(reworkInstruction ? { reworkInstruction } : {}),
      ...(lockedViewerPromise ? { lockedViewerPromise } : {}),
      ...(seriesContext ? { seriesContext } : {}),
      productionCapabilities: productionCapabilitiesFor(brief, options),
    },
    suppliedSources: treatmentSuppliedSources(brief),
    // 参考语法是构思的实际输入（风格/结构参考）：内容变化必须重做构思阶段。
    ...(referenceGrammar ? { referenceGrammar } : {}),
    providerId: bindings.find((binding) => binding.agent.modelId === brief.models?.[CREATIVE_TREATMENT_PROVIDER_ID])?.providerId
      ?? bindings[0]?.providerId,
    selectedModelId: brief.models?.[CREATIVE_TREATMENT_PROVIDER_ID] ?? bindings[0]?.agent.modelId,
    contractVersion: CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION,
  };
}

// 构思角色只把已经读到正文的来源视为事实输入。执行、阶段身份和 checkpoint 共用
// 同一投影，避免来源更新后继续复用旧稿，也避免 title_only/blocked 被当成正文证据。
function treatmentSuppliedSources(
  brief: Pick<ProductionBrief, "articleSources">,
): CreativeTreatmentAgentInput["suppliedSources"] {
  return (brief.articleSources ?? [])
    .filter((source) => source.readStatus === "read" || source.readStatus === "partial")
    .map((source) => ({
      sourceId: source.sourceId,
      label: source.pageTitle || source.finalUrl,
      note: [
        `来源：${source.finalUrl}`,
        `读取状态：${source.readStatus}${source.truncated ? "（摘录已截断）" : ""}`,
        ...source.paragraphs.map((paragraph) => `${paragraph.id}：${paragraph.text}`),
      ].join("\n"),
    }));
}

// 已接受的观众承诺：系列上下文承载宿主锁定的本集承诺。没有系列上下文时不构造承诺，
// 构思角色自行生成（与 lockedViewerPromise 合同一致）。
function acceptedViewerPromise(brief: ProductionBrief): string | undefined {
  const promise = brief.seriesContext?.episode.viewerPromise;
  return typeof promise === "string" && promise.trim() ? promise : undefined;
}

// 编剧阶段的实际输入投影：编剧 brief（含模板/实证/系列/实质相关的返工上下文）与生效模型
// 身份。与 screenwriterBrief 共用同一 rework 投影——media-only 返工不改变编剧真实输入，
// 身份保持与源 run 一致，跨 run 播种才能在 producer 调用之前继承编剧阶段。
function scriptStageInputIdentity(brief: ProductionBrief, options: ProductionPipelineOptions): unknown {
  return {
    brief: screenwriterBrief(brief, options),
    providerId: brief.providers.script,
    selectedModelId: brief.models?.[brief.providers.script] ?? options.screenwriterAgent?.modelId,
    contractVersion: SCREENWRITER_AGENT_CONTRACT_VERSION,
  };
}

// 导演实际收到的素材路由输入：provider 目录条目 + 运行时模型画像的完整投影。端口构造与
// 阶段身份共用同一 helper——目录条目（标签/计费/交付类型/约束/价格）任何变化都改变导演的
// 真实输入，身份不得只看 provider id 与模型选择而漏掉这些字段。目录缺失该 provider 时
// 明确失败（与旧 visual-direction 节点同一行为）。
function directorAssetProviderInputs(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
): NonNullable<VisualDirectorAgentInput["assetProviders"]> {
  const catalog = new Map((options.assetProviders ?? []).map((provider) => [provider.id, provider]));
  return (brief.director?.assetProviderIds ?? []).map((id) => {
    const provider = catalog.get(id);
    if (!provider) throw new Error(`Asset provider '${id}' is not available to the AI director.`);
    const selectedVideoModel = selectedVideoModelRuntime(
      brief,
      provider.id,
      options.providerRuntimeMetadata ?? [],
    );
    return {
      id: provider.id,
      label: provider.label,
      billing: provider.billing,
      modes: [...provider.modes],
      deliveryTypes: [...provider.deliveryTypes],
      supportsReferenceImage: provider.supportsReferenceImage ?? false,
      strengths: [...(provider.strengths ?? provider.modes)],
      constraints: [...(provider.constraints ?? [])],
      estimatedCnyPerClip: provider.estimatedCnyPerClip ?? 0,
      ...(selectedVideoModel ? {
        selectedModelId: selectedVideoModel.modelId,
        minDurationSeconds: selectedVideoModel.minDurationSeconds,
        maxDurationSeconds: selectedVideoModel.maxDurationSeconds,
        ...(selectedVideoModel.aspectRatios ? { aspectRatios: [...selectedVideoModel.aspectRatios] } : {}),
      } : {}),
    };
  });
}

function productionCapabilitiesFor(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
): ProductionCapabilities {
  return summarizeProductionCapabilities(
    brief.director ? directorAssetProviderInputs(brief, options) : [],
    brief.providers.voice,
  );
}

// 导演阶段的实际输入投影：导演 brief 的 brief 侧字段、参考语法、素材路由完整投影、
// 费用反馈、返工上下文与生效模型。稿件侧输入（viewerPromise/scenes）由被携带的 script 产物
// 身份承担。rework 投影与 director 端口构造的 rework 段一致——返工意见变化必须重做导演阶段。
function directorStageInputIdentity(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  referenceGrammar: ShotGrammar | undefined,
): unknown {
  const reworkFindings = brief.rework?.findings
    .filter((finding) => finding.targetNodeIds.includes("visual-direction") && finding.action !== "inspect_existing_media")
    .map(modelFacingReworkFinding) ?? [];
  return {
    brief: {
      title: brief.title,
      angle: brief.angle,
      audience: brief.audience,
      platform: brief.platform,
      durationSeconds: brief.durationSeconds,
      ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
      ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
      ...(brief.director ? { requestedProfileId: brief.director.profileId } : {}),
      ...(brief.editorial ? { editorial: brief.editorial } : {}),
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
      ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
      ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
      ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
      ...(brief.articleSources?.length ? { articleSources: brief.articleSources } : {}),
      voiceTiming: voiceTimingFor(brief),
      productionCapabilities: productionCapabilitiesFor(brief, options),
    },
    referenceGrammar: referenceGrammar ?? null,
    assetProviders: directorAssetProviderInputs(brief, options),
    economics: { allowMeteredProviders: brief.economics.allowMeteredProviders },
    spendFeedback: brief.spendFeedback?.slice(-10) ?? [],
    ...(brief.rework ? {
      rework: {
        sourceRunId: brief.rework.sourceRunId,
        visualDirectionInstruction: brief.rework.nodeInstructions.visualDirection,
        assetInstruction: brief.rework.nodeInstructions.assets,
        findings: reworkFindings,
        ...(brief.rework.affectedScenePositions !== undefined
          ? { affectedScenePositions: [...brief.rework.affectedScenePositions] }
          : {}),
        // 上一版方案/脚本的完整内容参与影响范围推导，身份按内容 digest 记录。
        ...(brief.rework.previousScript ? { previousScriptDigest: stablePlanningDigestJson(brief.rework.previousScript) } : {}),
        ...(brief.rework.previousDirectorPlan ? { previousDirectorPlanDigest: stablePlanningDigestJson(brief.rework.previousDirectorPlan) } : {}),
      },
    } : {}),
    selectedModelId: brief.providers.director !== undefined
      ? brief.models?.[brief.providers.director] ?? options.directorAgent?.modelId
      : options.directorAgent?.modelId,
    providerId: brief.providers.director,
    contractVersion: VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
  };
}

// 排序证据失效时同步移除阶段产物引用：与 creative-planning 的 withoutArtifactStages 同语义。
function withoutPlanningStageArtifacts(
  artifactIds: Partial<Record<PlanningStageId, string[]>>,
  stages: readonly PlanningStageId[],
): Partial<Record<PlanningStageId, string[]>> {
  const removed = new Set<string>(stages);
  return Object.fromEntries(
    Object.entries(artifactIds).filter(([stage]) => !removed.has(stage)),
  ) as Partial<Record<PlanningStageId, string[]>>;
}

function jointPlanningStageInputs(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  referenceGrammar: ShotGrammar | undefined,
): { treatment: string; script: string; director: string; rank: string } {
  const digestOf = (value: unknown) => createHash("sha256").update(stablePlanningDigestJson(value)).digest("hex");
  return {
    treatment: digestOf(treatmentStageInputIdentity(brief, options, options.treatmentAgents ?? [], referenceGrammar)),
    script: digestOf(scriptStageInputIdentity(brief, options)),
    director: digestOf(directorStageInputIdentity(brief, options, referenceGrammar)),
    // ranker 身份进入阶段兼容身份：只换 provider/model/合同版本必须失效排序证据并真实重排，
    // 不得重放 completed graph 的旧排序；无图库路线同样记录（无 ranker 的身份），保持形状稳定。
    rank: digestOf({
      rankerId: options.assetSemanticRanker?.id ?? null,
      modelId: options.assetSemanticRanker?.modelId ?? null,
      contractVersion: ASSET_RANK_AGENT_CONTRACT_VERSION,
      // 排序语义意图的构造规则版本：语义投影字段变化也让旧排序证据失效。
      semanticIntentVersion: RANKING_SEMANTIC_INTENT_VERSION,
    }),
  };
}

// 排序语义投影的构造规则版本：rankingSemanticIntent 的字段集合变化时递增，使旧排序证据失效。
const RANKING_SEMANTIC_INTENT_VERSION = "video-factory/ranking-semantic-intent-v1";

// 与 creative-planning.ts 的 stablePlanningJson 同语义：对象键排序、数组保序、过滤 undefined。
function stablePlanningDigestJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stablePlanningDigestJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stablePlanningDigestJson(record[key])}`).join(",")}}`;
}

const JOINT_PLANNING_HISTORY_VERSION = "video-factory/planning-history-v1";

// 每次“到达完成态”的 joint 规划执行记录：阶段输入身份 + 各阶段的真实执行模型/provider trace。
// 新 digest 执行时据此把未受影响的上游产物播种进新 thread；检视据此读取当前 digest 的
// role trace——不读取其他 digest（旧执行）的 trace。provider 与 model 分开保存：正式
// provenance 不得把模型字符串写进 provider 命名空间。candidateInventoryPath 是搜索端口的
// worker 私有产物路径（非正式 artifact）：图库路线物化消费它，恢复时按 digest 找回。
interface JointPlanningExecutionRecord {
  version: string;
  inputDigest: string;
  libraryRoute: boolean;
  stageInputs: { treatment: string; script: string; director: string; rank: string };
  modelTraces: Partial<Record<PlanningStageId, string>>;
  providerTraces?: Partial<Record<PlanningStageId, string>>;
  candidateInventoryPath?: string;
  /** 私有库存文件内容指纹：与路径一同恢复并校验。 */
  candidateInventorySha256?: string;
  recordedAt: string;
  /** 单调执行序号：每次执行（含同 digest 重放）取 max+1——墙上时钟相等/回拨不影响
      "最近执行前驱"判定。 */
  executionSeq: number;
}

async function readJointPlanningHistory(historyPath: string): Promise<JointPlanningExecutionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Joint planning history must be a JSON array.");
  return parsed.filter((entry): entry is JointPlanningExecutionRecord => (
    typeof entry === "object" && entry !== null && (entry as { version?: string }).version === JOINT_PLANNING_HISTORY_VERSION
    && Number.isSafeInteger((entry as { executionSeq?: unknown }).executionSeq)
  ));
}

// 按 inputDigest 幂等登记：同 digest 重放合并已记录的 traces（崩溃恢复不抹掉原 trace），
// 并以最新执行的阶段身份/库存路径为准（身份更新后旧身份不再参与守卫比较）。
async function upsertJointPlanningExecutionRecord(
  historyPath: string,
  record: Omit<JointPlanningExecutionRecord, "executionSeq"> & Partial<Pick<JointPlanningExecutionRecord, "executionSeq">>,
): Promise<void> {
  const history = await readJointPlanningHistory(historyPath);
  // 同 digest 的每次执行（含重放）都推进单调序号：前驱按实际执行顺序选取，不依赖墙上时钟。
  const nextSeq = history.reduce((max, entry) => Math.max(max, entry.executionSeq), 0) + 1;
  const sequenced: JointPlanningExecutionRecord = { ...record, executionSeq: record.executionSeq ?? nextSeq };
  const merged = history.map((entry) => {
    if (entry.inputDigest !== sequenced.inputDigest) return entry;
    return {
      ...entry,
      modelTraces: { ...entry.modelTraces, ...sequenced.modelTraces },
      providerTraces: { ...entry.providerTraces, ...sequenced.providerTraces },
      stageInputs: sequenced.stageInputs,
      ...(sequenced.candidateInventoryPath !== undefined
        ? { candidateInventoryPath: sequenced.candidateInventoryPath }
        : entry.candidateInventoryPath !== undefined
          ? { candidateInventoryPath: entry.candidateInventoryPath }
          : {}),
      recordedAt: sequenced.recordedAt,
      executionSeq: nextSeq,
    };
  });
  if (!merged.some((entry) => entry.inputDigest === sequenced.inputDigest)) merged.push(sequenced);
  await writeTextAtomically(historyPath, `${JSON.stringify(merged, null, 2)}\n`);
}

// 闭包前驱取“最近一次执行”的记录（recordedAt 最大；同刻取数组中更靠后者），排除当前 digest。
// 不用数组末位：A→B→A 重放会原地更新 A 的记录，数组顺序仍是 [A,B]，而实际最新执行是 A。
function latestJointPlanningRecord(
  history: readonly JointPlanningExecutionRecord[],
  excludeDigest: string,
): JointPlanningExecutionRecord | undefined {
  let best: JointPlanningExecutionRecord | undefined;
  for (const entry of history) {
    if (entry.inputDigest === excludeDigest) continue;
    if (!best || entry.executionSeq > best.executionSeq) best = entry;
  }
  return best;
}


// 读取当前 head 授权 id（未被 supersede 的唯一幸存者；多幸存者/损坏 → undefined）。
// C1-R1：committed 授权链的唯一严格校验器。接受（写入新授权）与读取（派生子凭证）共用同一
// 实现；损坏/外 run/分叉/零幸存者/缺失前驱/环/游离记录/文件身份不符/内容摘要不符一律返回
// integrity_error——损坏状态绝不能被解释成"尚无授权"而接受新的首份授权。
type ProductionAuthorizationChainState =
  | { state: "absent" }
  | { state: "committed"; head: ProductionAuthorizationScope }
  | { state: "integrity_error"; reason: string };

interface ProductionAuthorizationArtifactRecord {
  /** 不含 "production-authorization:" 前缀的授权 id（与文件名和 scope.id 一致）。 */
  id: string;
  uri: string;
  sha256: string;
}

async function inspectProductionAuthorizationChain(
  directory: string,
  runId: string,
  artifacts: ReadonlyArray<ProductionAuthorizationArtifactRecord>,
): Promise<ProductionAuthorizationChainState> {
  if (artifacts.length === 0) return { state: "absent" };
  const scopes: ProductionAuthorizationScope[] = [];
  for (const record of artifacts) {
    const expectedPath = path.join(directory, `${record.id}.json`);
    if (record.uri !== expectedPath) {
      return { state: "integrity_error", reason: `committed authorization '${record.id}' has an unexpected path '${record.uri}'` };
    }
    let content: string;
    try {
      content = await readFile(expectedPath, "utf8");
    } catch (error) {
      return { state: "integrity_error", reason: `committed authorization '${record.id}' is unreadable: ${(error as Error).message}` };
    }
    if (record.sha256 !== createHash("sha256").update(content).digest("hex")) {
      return { state: "integrity_error", reason: `committed authorization '${record.id}' fails its content digest` };
    }
    let scope: ProductionAuthorizationScope;
    try {
      scope = parseProductionAuthorizationScope(JSON.parse(content));
    } catch (error) {
      return { state: "integrity_error", reason: `committed authorization '${record.id}' is invalid: ${(error as Error).message}` };
    }
    if (scope.runId !== runId) {
      return { state: "integrity_error", reason: `committed authorization '${record.id}' belongs to run '${scope.runId}'` };
    }
    if (scope.id !== record.id) {
      return { state: "integrity_error", reason: `authorization file '${record.id}' holds scope id '${scope.id}'` };
    }
    scopes.push(scope);
  }
  const superseded = new Set(scopes.flatMap((scope) => (
    scope.supersedesAuthorizationId ? [scope.supersedesAuthorizationId] : []
  )));
  const survivors = scopes.filter((scope) => !superseded.has(scope.id));
  if (survivors.length === 0) {
    return { state: "integrity_error", reason: "every committed authorization is superseded; the chain has no head" };
  }
  if (survivors.length > 1) {
    return { state: "integrity_error", reason: `${survivors.length} non-superseded authorizations form a forked chain` };
  }
  // 从唯一 head 沿 supersedes 引用回溯：全部 committed 记录必须可达、无环、无缺失前驱。
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const head = survivors[0]!;
  const reachable = new Set<string>([head.id]);
  let cursor: ProductionAuthorizationScope | undefined = head;
  while (cursor?.supersedesAuthorizationId) {
    const predecessorId = cursor.supersedesAuthorizationId;
    if (reachable.has(predecessorId)) {
      return { state: "integrity_error", reason: `authorization chain contains a cycle at '${predecessorId}'` };
    }
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      return { state: "integrity_error", reason: `authorization '${cursor.id}' supersedes '${predecessorId}' which is not committed` };
    }
    reachable.add(predecessorId);
    cursor = predecessor;
  }
  if (reachable.size !== scopes.length) {
    const orphan = scopes.find((scope) => !reachable.has(scope.id))!;
    return { state: "integrity_error", reason: `authorization '${orphan.id}' is not part of the chain headed by '${head.id}'` };
  }
  return { state: "committed", head };
}

function productionAuthorizationRecords(artifacts: ReadonlyArray<{ id: string; kind: string; uri?: string; sha256?: string }>): ProductionAuthorizationArtifactRecord[] {
  return artifacts
    .filter((artifact) => artifact.kind === "production_authorization")
    .map((artifact) => ({
      id: artifact.id.replace(/^production-authorization:/, ""),
      uri: artifact.uri ?? "",
      sha256: artifact.sha256 ?? "",
    }));
}

// 把未受影响的上游阶段产物播种进新 thread。播种条件是逐级依赖的：script 只有在 treatment
// 本身被携带时才可能被携带；director 依赖 script 的携带。图库路线的候选/排序证据在前驱存在
// 时一并携带——图自身的 fingerprint 路由会在导演重跑后校验证据新鲜度：候选获取身份变化强制
// 重搜、排序实际输入变化强制重排、两者一致才直接复检；携带过期的证据不会被错误复用。
// ranker 身份变化时只携带候选、不携带排序证据（游标停在 director 之后，图路由真实重排）。
// 返回被携带阶段的模型/provider trace：新 digest 的记录继承产物 provenance，不声称新的执行。
async function seedJointPlanningThread(options: {
  graph: CreativePlanningGraph;
  store: CreativePlanningStore;
  runId: string;
  inputDigest: string;
  planningInput: CreativePlanningInput;
  libraryRoute: boolean;
  prior: JointPlanningExecutionRecord | undefined;
  /** 跨 run 播种时前驱 checkpoint 所属的源 run（默认当前 run）。 */
  priorRunId?: string;
  stageInputs: { treatment: string; script: string; director: string; rank: string };
  historyPath?: string;
}): Promise<{
  modelTraces: Partial<Record<PlanningStageId, string>>;
  providerTraces: Partial<Record<PlanningStageId, string>>;
  candidateInventoryPath?: string;
} | undefined> {
  const prior = options.prior;
  if (!prior || prior.inputDigest === options.inputDigest) return undefined;
  let priorValues: Partial<PlanningGraphState>;
  try {
    const snapshot = await options.graph.getState(
      options.store.threadConfig(options.priorRunId ?? options.runId, prior.inputDigest),
    );
    priorValues = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
  } catch {
    return undefined;
  }
  if (priorValues.inputDigest !== prior.inputDigest || priorValues.runId !== (options.priorRunId ?? options.runId)) return undefined;
  const base = initialPlanningGraphState(options.planningInput);
  const values: Record<string, unknown> = { ...base };
  const carriedTraces: Partial<Record<PlanningStageId, string>> = {};
  const carriedProviderTraces: Partial<Record<PlanningStageId, string>> = {};
  const carriedStageInputIdentities: Partial<Record<PlanningStageId, string>> = {};
  let asNode: string | undefined;
  let scriptCarried = false;
  let directorCarried = false;
  const carriedProviderSource = prior.providerTraces ?? {};
  if (priorValues.treatmentArtifact && prior.stageInputs.treatment === options.stageInputs.treatment) {
    values.treatmentArtifact = priorValues.treatmentArtifact;
    values.artifactIds = { ...(values.artifactIds as Record<string, unknown>), treatment: [priorValues.treatmentArtifact.artifactId] };
    if (prior.modelTraces.treatment) carriedTraces.treatment = prior.modelTraces.treatment;
    if (carriedProviderSource.treatment) carriedProviderTraces.treatment = carriedProviderSource.treatment;
    carriedStageInputIdentities.treatment = prior.stageInputs.treatment;
    asNode = "treatment";
    if (priorValues.scriptArtifact && prior.stageInputs.script === options.stageInputs.script) {
      values.scriptArtifact = priorValues.scriptArtifact;
      values.artifactIds = { ...(values.artifactIds as Record<string, unknown>), script: [priorValues.scriptArtifact.artifactId] };
      if (prior.modelTraces.script) carriedTraces.script = prior.modelTraces.script;
      if (carriedProviderSource.script) carriedProviderTraces.script = carriedProviderSource.script;
      carriedStageInputIdentities.script = prior.stageInputs.script;
      asNode = "script";
      scriptCarried = true;
      if (priorValues.directorPlan && prior.stageInputs.director === options.stageInputs.director) {
        values.directorPlan = priorValues.directorPlan;
        values.artifactIds = { ...(values.artifactIds as Record<string, unknown>), director: [priorValues.directorPlan.artifactId] };
        if (prior.modelTraces.director) carriedTraces.director = prior.modelTraces.director;
        if (carriedProviderSource.director) carriedProviderTraces.director = carriedProviderSource.director;
        carriedStageInputIdentities.director = prior.stageInputs.director;
        asNode = "director";
        directorCarried = true;
      }
    }
  }
  if (!asNode) return undefined;
  const sameRun = (options.priorRunId ?? options.runId) === options.runId;
  const priorReview = priorValues.creativeReview;
  const carriedStages: CreativeStage[] = ["treatment", ...(scriptCarried ? ["script" as const] : []), ...(directorCarried ? ["director" as const] : [])];
  const unconfirmedStage = sameRun && options.planningInput.creativeReview && priorReview
    ? carriedStages.find((stage) => !confirmedCreativeReviewStage(priorReview, stage,
      stage === "treatment" ? priorValues.treatmentArtifact : stage === "script" ? priorValues.scriptArtifact : priorValues.directorPlan))
    : undefined;
  if (unconfirmedStage && priorReview) {
    const state = priorReview.stages[unconfirmedStage];
    const artifact = unconfirmedStage === "treatment" ? priorValues.treatmentArtifact
      : unconfirmedStage === "script" ? priorValues.scriptArtifact : priorValues.directorPlan;
    // 同 run 的工作稿不需要冒充已确认才能保存；但必须仍与未改变的阶段输入和产物精确绑定。
    if (!artifact || !state.currentDraft || state.currentDocument === null
      || state.currentDraft.artifactId !== artifact.artifactId
      || state.currentDraft.sha256 !== contentSha256(artifact.output)
      || state.currentDraft.sha256 !== contentSha256(state.currentDocument)
      || state.phase === "confirmed") return undefined;
    const keepIndex = carriedStages.indexOf(unconfirmedStage);
    for (const stage of carriedStages.slice(keepIndex + 1)) {
      delete values[stage === "script" ? "scriptArtifact" : "directorPlan"];
      delete (values.artifactIds as Record<string, unknown>)[stage];
      delete carriedTraces[stage];
      delete carriedProviderTraces[stage];
      delete carriedStageInputIdentities[stage];
    }
    scriptCarried = unconfirmedStage !== "treatment" && scriptCarried;
    directorCarried = unconfirmedStage === "director" && directorCarried;
    values.creativeReview = carriedCreativeReviewState(priorReview, unconfirmedStage);
    asNode = `${unconfirmedStage}_review`;
  } else if (options.planningInput.creativeReview) {
    const priorReview = priorValues.creativeReview;
    // 跨 run 只能继承已经由用户确认、且仍精确绑定当前携带产物的上游阶段。单有产物文件
    // 不等于用户已经确认；确认链无法证明时宁可不播种，从首个不确定阶段重新生成和确认。
    if (!confirmedCreativeReviewStage(priorReview, "treatment", priorValues.treatmentArtifact)) {
      return undefined;
    }
    let lastConfirmedStage: CreativeStage = "treatment";
    if (scriptCarried) {
      if (!confirmedCreativeReviewStage(priorReview, "script", priorValues.scriptArtifact)) {
        delete values.scriptArtifact;
        values.artifactIds = { treatment: [priorValues.treatmentArtifact!.artifactId] };
        delete carriedTraces.script;
        delete carriedProviderTraces.script;
        delete carriedStageInputIdentities.script;
        scriptCarried = false;
        directorCarried = false;
        asNode = "treatment_review";
      } else {
        lastConfirmedStage = "script";
      }
    }
    if (!scriptCarried) {
      delete values.directorPlan;
      delete carriedTraces.director;
      delete carriedProviderTraces.director;
      delete carriedStageInputIdentities.director;
    } else if (directorCarried && !options.libraryRoute) {
      if (confirmedCreativeReviewStage(priorReview, "director", priorValues.directorPlan)) {
        lastConfirmedStage = "director";
        asNode = "director_review";
      } else {
        delete values.directorPlan;
        const artifactIds = values.artifactIds as Record<string, unknown>;
        delete artifactIds.director;
        delete carriedTraces.director;
        delete carriedProviderTraces.director;
        delete carriedStageInputIdentities.director;
        directorCarried = false;
        asNode = "script_review";
      }
    } else if (asNode === "script") {
      asNode = "script_review";
    } else if (asNode === "treatment") {
      asNode = "treatment_review";
    }
    values.creativeReview = carriedCreativeReviewState(priorReview!, lastConfirmedStage);
  }
  // ranker 身份必须显式匹配才携带排序证据：前驱记录缺失 rank 身份（旧格式/身份未知）与
  // 身份不一致同等对待——只携带候选，游标停在 director 之后由图路由真实重排。这与同
  // digest 恢复守卫对"身份未知"的定义一致：不默认兼容。
  const rankIdentityUnchanged = prior.stageInputs.rank !== undefined
    && prior.stageInputs.rank === options.stageInputs.rank;
  // 私有库存路径与候选证据同源：候选被携带时它的库存路径一并继承，新 digest 的
  // 节点输出仍指向真实库存文件，而不是丢失后拿公开报告顶替。
  let carriedCandidateInventoryPath: string | undefined;
  if (options.libraryRoute && prior.libraryRoute && scriptCarried
    && priorValues.candidatesArtifact) {
    // 候选证据与候选获取 fingerprint 一并播种：director 未携带时游标停在 script（下一步
    // 重跑导演），路由会用新方案核验证据；携带排序证据时游标推进到 rank 之后。
    values.candidatesArtifact = priorValues.candidatesArtifact;
    values.candidateSearchFingerprint = priorValues.candidateSearchFingerprint;
    // 私有库存绑定与候选证据同一 checkpoint 持久化：播种后恢复仍指向真实库存文件。
    if (priorValues.candidateInventoryBinding) {
      values.candidateInventoryBinding = priorValues.candidateInventoryBinding;
      // BG-09：内容指纹与路径一同播种，恢复校验才有依据。
      if (priorValues.candidateInventorySha256) {
        values.candidateInventorySha256 = priorValues.candidateInventorySha256;
      }
    }
    values.artifactIds = {
      ...(values.artifactIds as Record<string, unknown>),
      candidates: [priorValues.candidatesArtifact.artifactId],
    };
    if (priorValues.candidateInventoryBinding) carriedCandidateInventoryPath = priorValues.candidateInventoryBinding;
    else if (prior.candidateInventoryPath) carriedCandidateInventoryPath = prior.candidateInventoryPath;
    if (rankIdentityUnchanged && priorValues.ranking) {
      values.ranking = priorValues.ranking;
      values.rankingInputFingerprint = priorValues.rankingInputFingerprint;
      values.artifactIds = {
        ...(values.artifactIds as Record<string, unknown>),
        rank: [priorValues.ranking.artifactId],
      };
      // BG-03：排序证据携带时其 rank compatibility identity 必须同 checkpoint 保存——
      // 无 history 恢复分支据此核对 ranker 身份，不得绕过失效。
      carriedStageInputIdentities.rank = prior.stageInputs.rank;
      if (prior.modelTraces.rank) carriedTraces.rank = prior.modelTraces.rank;
      if (carriedProviderSource.rank) carriedProviderTraces.rank = carriedProviderSource.rank;
      if (asNode === "director") asNode = "rank";
    }
  }
  values.carriedModelTraces = carriedTraces;
  values.carriedProviderTraces = carriedProviderTraces;
  values.carriedStageInputIdentities = carriedStageInputIdentities;
  await options.graph.updateState(options.store.threadConfig(options.runId, options.inputDigest), values, asNode);
  return {
    modelTraces: carriedTraces,
    providerTraces: carriedProviderTraces,
    ...(carriedCandidateInventoryPath !== undefined ? { candidateInventoryPath: carriedCandidateInventoryPath } : {}),
  };
}

function confirmedCreativeReviewStage(
  review: CreativeReviewState | undefined,
  stage: CreativeStage,
  artifact: { artifactId: string; output: unknown } | null | undefined,
): boolean {
  if (!review || !artifact) return false;
  const state = review.stages[stage];
  const draft = state.currentDraft;
  const confirmation = state.confirmation;
  const check = state.checkResult;
  const artifactSha256 = contentSha256(artifact.output);
  return state.phase === "confirmed"
    && draft !== null
    && draft.artifactId === artifact.artifactId
    && draft.sha256 === artifactSha256
    && confirmation !== null
    && confirmation.draftSha256 === draft.sha256
    && confirmation.stageInputDigest === draft.stageInputDigest
    && check !== null
    && check.verdict === "pass"
    && check.draftSha256 === draft.sha256
    && check.checkIdentity === confirmation.checkIdentity;
}

function carriedCreativeReviewState(
  prior: CreativeReviewState,
  lastConfirmedStage: CreativeStage,
): CreativeReviewState {
  const review = structuredClone(prior);
  const order: CreativeStage[] = ["treatment", "script", "director"];
  const lastIndex = order.indexOf(lastConfirmedStage);
  for (let index = lastIndex + 1; index < order.length; index += 1) {
    const stage = order[index]!;
    const state = review.stages[stage];
    // 旧 run 的下游稿只作为历史留存，不能在新 run 中继续冒充当前稿或已确认状态。
    if (state.currentDraft) state.previousDraft = state.currentDraft;
    if (state.currentDocument !== null) state.previousDocument = state.currentDocument;
    state.currentDraft = null;
    state.currentDocument = null;
    state.confirmation = null;
    state.checkResult = null;
    state.proposals = [];
    state.phase = "drafting";
  }
  review.activeStage = lastConfirmedStage;
  return review;
}

// 构思生效模型：用户选择（brief.models 的构思能力键）优先，且必须命中真实候选；
// 未选择时按候选顺序取首个——与执行侧 runCandidates 的排序合同一致。
function effectiveTreatmentModelId(
  brief: ProductionBrief,
  bindings: ReadonlyArray<{ providerId: string; agent: CreativeTreatmentAgent }>,
): string | undefined {
  const selected = brief.models?.[CREATIVE_TREATMENT_PROVIDER_ID];
  if (selected) {
    const match = bindings.find((binding) => binding.agent.modelId === selected);
    if (match) return match.agent.modelId;
  }
  return bindings[0]?.agent.modelId;
}

// joint-v1 规划输出的正式合同：必需路径缺失即拒绝；图库路线必须给出候选检索、排序路径与
// 私有库存路径（物化消费库存，不得拿公开报告顶替），无图库路线不伪造候选路径。
function validateJointPlanningOutput(output: unknown, libraryRoute: boolean): Record<string, unknown> {
  const value = requireOutputRecord(output, "creative-planning");
  const normalized: Record<string, unknown> = {
    ...value,
    scriptPath: requiredOutputString(value, "scriptPath"),
    directorPlanPath: requiredOutputString(value, "directorPlanPath"),
    executablePlanPath: requiredOutputString(value, "executablePlanPath"),
  };
  if (libraryRoute) {
    normalized.candidateSearchPath = requiredOutputString(value, "candidateSearchPath");
    normalized.candidateRankingPath = requiredOutputString(value, "candidateRankingPath");
    normalized.candidateInventoryPath = requiredOutputString(value, "candidateInventoryPath");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// joint-v1 planning commit 协议：崩溃窗口的幂等恢复标记。
// commit 是"图完成 + 正式产物登记"的结束标记：key 绑定 runId、当前 inputDigest 与完成态
// 图内产物身份（内容派生 id），不含 attempt/路径/时间——同输入重放必然命中同 key。
// 已有 commit 时严格校验（身份、producer、路径受控、sha256），任何不一致 fail closed。
// ---------------------------------------------------------------------------

const PLANNING_COMMIT_VERSION = "video-factory/planning-commit-v1";

interface JointPlanningCommitEntry {
  kind: string;
  artifactId: string;
  path: string;
  sha256: string;
}

interface JointPlanningCommit {
  version: string;
  runId: string;
  planningCommitKey: string;
  inputDigest: string;
  artifacts: JointPlanningCommitEntry[];
}

function jointPlanningExpectedKinds(libraryRoute: boolean): string[] {
  return libraryRoute
    ? ["creative_treatment", "script", "storyboard", "asset_candidates", "asset_ranking", "executable_plan"]
    : ["creative_treatment", "script", "storyboard", "executable_plan"];
}

// 读同 key 的既有 commit：文件不存在返回 undefined（未写结束标记），其他读错误冒泡。
async function readJointPlanningCommit(commitPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(commitPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// 严格校验既有 commit 与 run 内产物一一对应；缺失、篡改、重复或身份冲突全部 fail closed。
function planningCommitValidationError(reason: string): Error {
  return new Error(`Joint planning commit validation failed: ${reason}`);
}

async function verifyJointPlanningCommit(options: {
  commit: unknown;
  planningCommitKey: string;
  inputDigest: string;
  runId: string;
  runRoot: string;
  artifacts: readonly Artifact[];
  expectedKinds: readonly string[];
}): Promise<JointPlanningCommit> {
  if (typeof options.commit !== "object" || options.commit === null || Array.isArray(options.commit)) {
    throw planningCommitValidationError("commit must be a JSON object");
  }
  const record = options.commit as Record<string, unknown>;
  if (record.version !== PLANNING_COMMIT_VERSION) {
    throw planningCommitValidationError(`unsupported planning commit version '${String(record.version)}'`);
  }
  if (record.runId !== options.runId) {
    throw planningCommitValidationError(`planning commit belongs to run '${String(record.runId)}', not '${options.runId}'`);
  }
  if (record.planningCommitKey !== options.planningCommitKey) {
    throw planningCommitValidationError("planning commit key does not match its file name");
  }
  if (record.inputDigest !== options.inputDigest) {
    throw planningCommitValidationError("planning commit input digest does not match the current planning input");
  }
  if (!Array.isArray(record.artifacts)) {
    throw planningCommitValidationError("planning commit artifacts must be an array");
  }
  const entries = record.artifacts as Array<Record<string, unknown>>;
  const committedKinds = entries.map((entry) => String(entry.kind)).sort();
  const expectedKinds = [...options.expectedKinds].sort();
  if (
    committedKinds.length !== expectedKinds.length
    || committedKinds.some((kind, index) => kind !== expectedKinds[index])
  ) {
    throw planningCommitValidationError(`planning commit artifact kinds ${JSON.stringify(committedKinds)} do not match ${JSON.stringify(expectedKinds)}`);
  }
  const seenArtifactIds = new Set<string>();
  for (const entry of entries) {
    const kind = String(entry.kind);
    if (typeof entry.artifactId !== "string") {
      throw planningCommitValidationError("commit entry artifactId must be a string");
    }
    if (typeof entry.path !== "string") {
      throw planningCommitValidationError("commit entry path must be a string");
    }
    if (typeof entry.sha256 !== "string") {
      throw planningCommitValidationError("commit entry sha256 must be a string");
    }
    if (seenArtifactIds.has(entry.artifactId)) {
      throw planningCommitValidationError(`planning commit references artifact '${entry.artifactId}' more than once`);
    }
    seenArtifactIds.add(entry.artifactId);
    // commit 与 run artifact 必须一一对应：持久化 run 中同 id 出现多份身份记录时
    // 不得静默取第一个（.find 的歧义），必须明确失败。
    const matches = options.artifacts.filter((candidate) => candidate.id === entry.artifactId);
    if (matches.length !== 1) {
      throw planningCommitValidationError(
        matches.length === 0
          ? `unknown planning artifact '${entry.artifactId}'`
          : `planning artifact '${entry.artifactId}' is registered ${matches.length} times in the run`,
      );
    }
    const artifact = matches[0]!;
    if (artifact.producer?.nodeId !== "creative-planning") {
      throw planningCommitValidationError(`planning artifact '${entry.artifactId}' belongs to node '${artifact.producer?.nodeId ?? "unknown"}'`);
    }
    if (artifact.provenance?.producerRequestDigest !== options.planningCommitKey) {
      throw planningCommitValidationError(`planning artifact '${entry.artifactId}' is not bound to this planning commit key`);
    }
    if (artifact.kind !== kind) {
      throw planningCommitValidationError(`planning artifact '${entry.artifactId}' kind '${artifact.kind}' does not match committed kind '${kind}'`);
    }
    if (artifact.uri !== entry.path) {
      throw planningCommitValidationError(`committed path for '${kind}' does not match the registered artifact`);
    }
    // 路径穿越防御：词法前缀可被 "<runRoot>/../outside" 绕过，必须按 resolve 后的
    // 相对位置判断；relative 为空（entry 即 runRoot 本身）同样不允许。
    const resolvedRunRoot = path.resolve(options.runRoot);
    const resolvedEntryPath = path.resolve(options.runRoot, entry.path);
    const relativeToRunRoot = path.relative(resolvedRunRoot, resolvedEntryPath);
    if (!relativeToRunRoot || relativeToRunRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRunRoot)) {
      throw planningCommitValidationError(`committed path for '${kind}' escapes the run directory`);
    }
    let content: Buffer;
    try {
      content = await readFile(path.resolve(options.runRoot, entry.path));
    } catch {
      throw planningCommitValidationError(`committed file for '${kind}' is missing`);
    }
    const diskSha256 = createHash("sha256").update(content).digest("hex");
    if (diskSha256 !== entry.sha256) {
      throw planningCommitValidationError(`committed file for '${kind}' does not match its sha256`);
    }
    // 三方一致：commit 条目、run artifact 身份记录与磁盘内容必须同指纹。“内容连同 commit
    // sha256 一起篡改”不得通过——run artifact 记录是独立第三方。
    if (artifact.sha256 !== entry.sha256) {
      throw planningCommitValidationError(
        `committed sha256 for '${kind}' does not match the registered artifact record`,
      );
    }
  }
  const executableEntry = entries.find((entry) => entry.kind === "executable_plan")!;
  const executablePlan = parseExecutableProductionPlan(JSON.parse(
    await readFile(path.resolve(options.runRoot, String(executableEntry.path)), "utf8"),
  ));
  const committedId = (kind: string) => String(entries.find((entry) => entry.kind === kind)!.artifactId);
  const expectedCandidateIds = entries
    .filter((entry) => entry.kind === "asset_candidates" || entry.kind === "asset_ranking")
    .map((entry) => String(entry.artifactId));
  if (executablePlan.treatmentArtifactId !== committedId("creative_treatment")
    || executablePlan.scriptArtifactId !== committedId("script")
    || executablePlan.directorArtifactId !== committedId("storyboard")
    || !isDeepStrictEqual(executablePlan.candidateArtifactIds, expectedCandidateIds)) {
    throw planningCommitValidationError("executable plan references do not resolve to this run's committed planning artifacts");
  }
  return {
    version: PLANNING_COMMIT_VERSION,
    runId: options.runId,
    planningCommitKey: options.planningCommitKey,
    inputDigest: options.inputDigest,
    artifacts: entries.map((entry) => ({
      kind: String(entry.kind),
      artifactId: String(entry.artifactId),
      path: String(entry.path),
      sha256: String(entry.sha256),
    })),
  };
}

//（原 verifyJointPlanningLeftovers 已由 leftovers 分支内的逐 kind 校验/续齐逻辑取代。）

async function verifyOrphanedJointPlanningCommit(options: {
    commit: unknown;
    planningCommitKey: string;
    inputDigest: string;
    runId: string;
    runRoot: string;
    expectedKinds: string[];
    expectedContents: Array<{ kind: string; content: string }>;
  }): Promise<void> {
    if (!isObjectRecord(options.commit)
      || options.commit.version !== PLANNING_COMMIT_VERSION
      || options.commit.runId !== options.runId
      || options.commit.planningCommitKey !== options.planningCommitKey
      || options.commit.inputDigest !== options.inputDigest
      || !Array.isArray(options.commit.artifacts)) {
      throw planningCommitValidationError("orphaned planning commit envelope is invalid");
    }
    const entries = options.commit.artifacts as Array<Record<string, unknown>>;
    const kinds = entries.map((entry) => String(entry.kind)).sort();
    const expectedKinds = [...options.expectedKinds].sort();
    if (!isDeepStrictEqual(kinds, expectedKinds)) {
      throw planningCommitValidationError("orphaned planning commit artifact kinds are incomplete");
    }
    for (const expected of options.expectedContents) {
      const entry = entries.find((candidate) => candidate.kind === expected.kind);
      if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
        throw planningCommitValidationError(`orphaned planning commit is missing '${expected.kind}'`);
      }
      const resolvedRoot = path.resolve(options.runRoot);
      const resolvedPath = path.resolve(options.runRoot, entry.path);
      const relative = path.relative(resolvedRoot, resolvedPath);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw planningCommitValidationError(`orphaned planning path for '${expected.kind}' escapes the run directory`);
      }
      const content = await readFile(resolvedPath, "utf8");
      if (content !== expected.content
        || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
        throw planningCommitValidationError(`orphaned planning file for '${expected.kind}' does not match the replayed graph outcome`);
    }
  }
}

async function writeJointPlanningCommit(commitPath: string, commit: JointPlanningCommit): Promise<void> {
  // 临时文件 + rename 原子写：读端要么看不到 commit，要么看到完整 commit。
  await mkdir(path.dirname(commitPath), { recursive: true });
  await writeTextAtomically(commitPath, `${JSON.stringify(commit, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// joint-v1 planning stage 只读投影（Studio 详情消费）。数据只来自三处真实证据：
// 当前有效规划输入 digest 对应的 SQLite checkpoint thread、planning 节点的 role-agent
// v7 checkpoint（真实执行模型）与经严格校验的正式 planning commit（正式产物 id）。
// 读取不得 invoke 图、不得触发任何角色/Provider 调用；身份错配或存储损坏 fail closed
// （返回 undefined），checkpoint 尚不存在则如实全 pending——两种情况都不伪造阶段状态。
// ---------------------------------------------------------------------------

export type CreativePlanningStageAction = "edit_input" | "change_model" | "view_artifacts";

export interface CreativePlanningStageInspection {
  id: PlanningStageId;
  status: "pending" | "running" | "completed" | "failed";
  effectiveModelId?: string;
  /** 模型阶段当前绑定的能力提供者 id：UI 据此解析模型选择，不按能力目录顺序猜测。 */
  providerId?: string;
  artifactIds: string[];
  issue?: string;
  allowedActions: CreativePlanningStageAction[];
}

const PLANNING_STAGE_ORDER_LIBRARY: readonly PlanningStageId[] = ["treatment", "script", "director", "candidates", "rank", "integrate", "compile"];
const PLANNING_STAGE_ORDER_FIXED: readonly PlanningStageId[] = ["treatment", "script", "director", "compile"];

function planningStageArtifactPresent(stage: PlanningStageId, values: Partial<PlanningGraphState>): boolean {
  switch (stage) {
    case "treatment": return values.treatmentArtifact != null;
    case "script": return values.scriptArtifact != null;
    case "director": return values.directorPlan != null;
    case "candidates": return values.candidatesArtifact != null;
    case "rank": return values.ranking != null;
    case "integrate": return values.integratedPlan != null;
    case "compile": return values.executablePlan != null;
  }
}

// 结构化 issue 的责任目标 → 承担该问题的规划阶段（与图内责任路由同构：source 类问题指向
// 候选获取、user 类问题回到构思输入）。快照可能来自损坏数据：无法识别的目标返回 undefined。
function planningIssueTargetStage(target: string): PlanningStageId | undefined {
  switch (target) {
    case "script": return "script";
    case "director": return "director";
    case "source": return "candidates";
    case "user": return "treatment";
    default: return undefined;
  }
}

function planningStagesAllPending(
  stageIds: readonly PlanningStageId[],
  bindingModelOf: (stage: PlanningStageId) => string | undefined,
  bindingProviderOf: (stage: PlanningStageId) => string | undefined,
): CreativePlanningStageInspection[] {
  return stageIds.map((stage) => {
    const effectiveModelId = bindingModelOf(stage);
    const providerId = bindingProviderOf(stage);
    return {
      id: stage,
      status: "pending",
      ...(effectiveModelId !== undefined ? { effectiveModelId } : {}),
      ...(providerId !== undefined ? { providerId } : {}),
      artifactIds: [],
      allowedActions: stage === "treatment" || stage === "script" || stage === "director"
        ? ["edit_input", "change_model"]
        : [],
    };
  });
}

// 规划节点失败文本的创作者视图：内部停止原因（halt reason、“不回退旧规划流程”等实现细节）
// 不进入阶段问题文案；结构化 detail 本身已是面向用户的中文说明。
export // C1：dispatch 层的 scope 覆盖评估（结构化，不压成 bool）。方案锚定：报价所依据的
// executable plan 文件内容 digest 必须等于 scope.acceptedPlanDigest——方案变化必须重新
// 确认，不接受“沿用旧授权跑新方案”；质量合同同边界核对。逐项：quoteItem.id 即素材键
// （scene-N），模型必须在 permittedAssets.models 内，金额/次数经结构化 assessment 用
// ledger 保守汇总核验。
type ProductionScopeQuoteAssessment =
  | { covered: true; assessment: ProductionSpendPlanAssessment; planDigest: string }
  | {
    covered: false;
    kind: "missing_plan" | "unreadable_plan" | "plan_digest" | "quality_contract" | "empty_quote" | "ledger_evidence" | "quote_items";
    assessment?: ProductionSpendPlanAssessment;
  };

function terminalPaidOperationIds(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
): ReadonlySet<string> {
  return new Set((run.executionReceipts ?? []).flatMap((receipt) => (
    receipt.nodeId === nodeId
      && (receipt.status === "failed" || receipt.status === "rejected")
      && receipt.requestId
      ? [receipt.requestId]
      : []
  )));
}

async function assessProductionScopePendingQuote(options: {
  scope: ProductionAuthorizationScope;
  run: WorkflowRun<ProductionBrief>;
  runsRoot: string;
  spendPlan: NonNullable<WorkflowRun<ProductionBrief>["nodeRuns"][number]["spendPlan"]>;
  paidItems: readonly {
    itemRequestId: string;
    quoteItemId: string;
    state: string;
    estimatedCostCny: number;
    actualCostCny?: number;
    taskId?: string;
    carriedForwardFromItemRequestId?: string;
  }[] | null;
}): Promise<ProductionScopeQuoteAssessment> {
  // 账本证据不可得 → 覆盖判定 fail closed：不能把未知余额当作零占用自动授权。
  if (options.paidItems === null) return { covered: false, kind: "ledger_evidence" };
  const waiting = options.run.nodeRuns.find((node) => node.nodeId === options.spendPlan.nodeId);
  if (!waiting?.inputState) return { covered: false, kind: "missing_plan" };
  const effectiveInput = waiting.inputState.versions.find(
    (version) => version.id === waiting.inputState?.effectiveVersionId,
  )?.value;
  const planPath = isObjectRecord(effectiveInput) && typeof effectiveInput.executablePlanPath === "string"
    ? effectiveInput.executablePlanPath
    : undefined;
  if (!planPath) return { covered: false, kind: "missing_plan" };
  let planDigest: string;
  try {
    planDigest = createHash("sha256").update(await readFile(planPath)).digest("hex");
  } catch {
    return { covered: false, kind: "unreadable_plan" };
  }
  if (planDigest !== options.scope.acceptedPlanDigest) return { covered: false, kind: "plan_digest" };
  // 质量合同消费侧核对：executable plan bytes 不含质量承诺字段，方案文件未变而质量合同
  // 变化时，旧 scope 不得自动继续——canonical 投影与接受侧同一函数。
  const effectiveBrief = effectiveProductionBrief(options.run);
  if (canonicalQualityContractDigest(qualityContractProjection(effectiveBrief)) !== options.scope.qualityContractDigest) {
    return { covered: false, kind: "quality_contract" };
  }
  const spendState = foldProductionSpendLedger(
    options.paidItems as Parameters<typeof foldProductionSpendLedger>[0],
    { terminalOperationIds: terminalPaidOperationIds(options.run, options.spendPlan.nodeId) },
  );
  const attemptsByAsset = spendState.attemptsByAsset;
  const quoteItems = options.spendPlan.items ?? [];
  if (quoteItems.length === 0) return { covered: false, kind: "empty_quote" };
  // fold 版覆盖评估（整份计划口径）：金额需求 = 条目合计与计划最高占用取大，顺序无关；
  // 非金额阻断优先于金额缺口报告。
  const assessment = assessProductionSpendPlan({
    scope: options.scope,
    state: spendState,
    planMaximumCents: Math.round(options.spendPlan.maxCostCny * 100),
    plan: {
      items: quoteItems.map((quoteItem) => ({
        assetKey: quoteItem.id,
        intentDigest: canonicalProductionAssetIntentDigest(planDigest, quoteItem.id),
        providerId: quoteItem.providerId,
        modelId: quoteItem.modelId,
        quoteCents: Math.round(quoteItem.estimatedCostCny * 100),
        attempt: (attemptsByAsset[quoteItem.id] ?? 0) + 1,
      })),
    },
  });
  return assessment.action === "execute"
    ? { covered: true, assessment, planDigest }
    : { covered: false, kind: "quote_items", assessment };
}

// 质量合同的 brief 投影：与 canonicalQualityContractDigest 的输入对齐（visualPlan 按内容
// digest 参与，不序列化整个对象）。
function qualityContractProjection(brief: ProductionBrief) {
  return {
    angle: brief.angle,
    audience: brief.audience,
    durationRange: brief.durationRange ?? { minSeconds: 0, maxSeconds: 0 },
    directorProfileId: brief.director?.profileId ?? "",
    ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
    ...(brief.visualPlan
      ? { visualPlanDigest: createHash("sha256").update(JSON.stringify(brief.visualPlan)).digest("hex") }
      : {}),
    ...(brief.editorial ? { editorial: brief.editorial } : {}),
  };
}

export function planningFailureForCreators(error: string): string {
  const redacted = redactAbsolutePaths(error);
  const halt = /Joint creative planning stopped \((needs_user|needs_source|duplicate_issue|cross_role_revisions_exhausted)\):\s*(.*?)(?:\s*不回退旧规划流程。)?$/.exec(redacted);
  if (halt) {
    const detail = halt[2]!.trim();
    const headline = halt[1] === "needs_user"
      ? "有需要你决定的问题，规划暂停："
      : halt[1] === "needs_source"
        ? "需要的素材来源目前不可得，规划暂停："
        : halt[1] === "duplicate_issue"
          ? "同一问题修改后再次出现，已停止自动重试："
          : "多次调整仍未通过质量复核，已停止自动重试：";
    return `${headline}${detail}`;
  }
  // 上面只认登记过的失败形态，未登记的整句原样通过。这里**刻意不做"看着像英文就替换"的兜底**：
  // 未登记的英文诊断是这条腿唯一的下线信息（例如 "simulated publication failure …"），整句换成
  // 通用说明等于把它藏起来，创作者就只剩一句"这一步没有完成"。已经上过屏的那几句按句登记在
  // KNOWN_ENGLISH_FAILURE_NARRATIVES 里逐条替换；再发现新的泄漏就再加一条，而不是放宽匹配。
  if (KNOWN_ENGLISH_FAILURE_NARRATIVES.some((pattern) => pattern.test(redacted))) return UNTRANSLATED_PLANNING_FAILURE;
  return redacted
    .replace(/\s*不回退旧规划流程。/g, "")
    .replace(/Joint creative planning/g, "创作规划");
}

const UNTRANSLATED_PLANNING_FAILURE = "这一步没有完成。可以重试；连续失败时检查这一步使用的服务与模型配置。";

// 曾经原样上屏的英文失败叙述。每一条都对应一个真实发生过的泄漏。
const KNOWN_ENGLISH_FAILURE_NARRATIVES = [
  // 复核这一腿根本没跑出裁决时的抛错原文。两种措辞都要认：旧措辞说的是"没有通过的裁决"、
  // 新措辞说的是"没有独立裁决"。它们都不是质量判断——复核压根没产出结论是执行故障，映射到
  // "这一步没有完成"才不会被人读成作品被否。旧措辞仍在表内，是因为历史 run 的失败文案
  // 会被缓存后再展示。
  /check completed without (?:a passing|an independent) audit/i,
  // 确认后独立复核没有产出通过裁决时的旧抛错原文。
  /confirmation did not produce a passing independent check/i,
];

// 当前 inputDigest 的 role trace：只读执行历史中本 digest 的记录；历史缺失或损坏时返回
// 空映射（阶段显示回退到当前绑定模型），不读取其他 digest 的旧执行 trace，也不阻断检视。
async function readJointPlanningModelTraces(
  historyPath: string,
  inputDigest: string,
): Promise<Partial<Record<PlanningStageId, string>>> {
  try {
    const history = await readJointPlanningHistory(historyPath);
    const record = history.find((entry) => entry.inputDigest === inputDigest);
    if (!record) return {};
    return { ...record.modelTraces };
  } catch {
    return {};
  }
}

// 检视图与执行图同 checkpointer、同拓扑：getState 只读快照、不会执行节点，端口全部换成
// 抛错替身——即使将来有人误在检视路径上触发执行，也只会失败，绝不会调用角色或 Provider。
function createInspectionPlanningGraph(
  store: CreativePlanningStore,
  libraryRoute: boolean,
): CreativePlanningGraph {
  const refusingPort = (stage: string) => async (): Promise<never> => {
    throw new Error(`Creative planning inspection must not execute the '${stage}' stage.`);
  };
  const ports: CreativePlanningPorts = {
    treatment: refusingPort("treatment"),
    screenwriter: refusingPort("script"),
    director: refusingPort("director"),
    ...(libraryRoute ? {
      searchCandidates: refusingPort("candidates"),
      rank: refusingPort("rank"),
      integrateDirector: refusingPort("integrate"),
    } : {}),
    compile: refusingPort("compile"),
  };
  return createCreativePlanningGraph({ ports, checkpointer: store.saver });
}

function planningReviewCheckpointIdentity(context: CreativePlanningContext): Record<string, unknown> {
  const execution = context.creativeReviewExecution;
  if (!execution) return { mode: "legacy" };
  const candidate = execution.mode === "check"
    ? execution.stage === "treatment"
      ? context.treatment?.output
      : execution.stage === "script"
        ? context.script?.output
        : context.integratedPlan?.output ?? context.directorPlan?.output
    : undefined;
  return {
    mode: execution.mode,
    ...(execution.mode === "check" ? { stage: execution.stage, candidateSha256: contentSha256(candidate) } : {}),
  };
}

function planningReviewCheckResult(
  context: CreativePlanningContext,
  execution: CodexTaskExecution<unknown>,
): { reviewCheck?: { audit: RoleAudit; checkIdentity: string } } {
  if (context.creativeReviewExecution?.mode !== "check") return {};
  const audit = execution.agentLoop?.iterations.at(-1)?.audit;
  const agentLoop = execution.agentLoop;
  if (!audit || !agentLoop) {
    throw new Error(`Creative review '${context.creativeReviewExecution.stage}' check completed without an independent audit.`);
  }
  return {
    reviewCheck: {
      audit: structuredClone(audit),
      checkIdentity: contentSha256({
        runId: context.runId,
        inputDigest: context.inputDigest,
        stage: context.creativeReviewExecution.stage,
        candidateSha256: contentSha256(execution.output),
        auditModelId: agentLoop.iterations.at(-1)?.auditTrace?.modelId ?? "unknown",
        contractVersion: agentLoop.contractVersion,
      }),
    },
  };
}

// joint-v1 创作规划节点：旧四段规划链（构思/稿件/导演/编译，含图库候选与排序）收敛为一个
// 顶层节点，内部完全复用 B3 固定拓扑图与 SQLite checkpoint。角色调用沿用旧节点的真实
// agent、provider 注册表与合同校验；任一角色失败让本节点失败，绝不回退旧规划链。
function creativePlanningNode(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  runsRoot: string,
  allowUnavailableProvider = false,
  resumeCompletedTextTaskNodeId?: string,
  resumeCompletedTextTaskRequestId?: string,
  recoverTextTask?: { nodeId: string; workflowOperationRequestId: string },
  creativeReviewResume?: CreativeReviewResume,
): NodeDefinition {
  const treatmentBindings = options.treatmentAgents ?? [];
  const libraryRoute = brief.workflowFeatures?.assetSemanticRank === true;
  const referenceGrammarEnabled = brief.workflowFeatures?.referenceGrammar === true;
  const directorProviderId = brief.providers.director;
  if (!directorProviderId) {
    throw new Error("Joint creative planning requires the AI director provider binding.");
  }
  if (!allowUnavailableProvider) {
    if (treatmentBindings.length === 0) {
      throw new Error("Joint creative planning requires configured creative treatment agents.");
    }
    if (libraryRoute && !options.assetSemanticRanker) {
      throw new Error("Joint creative planning with the library route requires the asset semantic ranker.");
    }
  }
  return {
    id: "creative-planning",
    label: "Joint creative planning",
    role: "创作规划制片",
    capability: "creative.planning",
    providerId: brief.providers.script,
    mode: "automatic",
    dependsOn: [referenceGrammarEnabled ? "reference-grammar" : "brief"],
    getInput: (context) => ({
      brief: currentEffectiveBriefFromContext(context, brief),
      ...(referenceGrammarEnabled ? { referenceGrammarPath: outputPath(context, "reference-grammar", "referenceGrammarPath") } : {}),
    }),
    validateInputOverride: (input) => {
      const value = requireOutputRecord(input, "creative-planning input");
      if (typeof value.brief !== "object" || value.brief === null || Array.isArray(value.brief)) {
        throw new Error("creative-planning input brief must be an object.");
      }
      // 编辑期即正式校验 brief：坏输入在覆盖时被拒绝（字段级错误），不等到执行才失败。
      mergeCurrentBrief(value.brief, brief);
      return {
        brief: value.brief,
        ...(referenceGrammarEnabled ? { referenceGrammarPath: requiredOutputString(value, "referenceGrammarPath") } : {}),
      };
    },
    execute: async (input, context) => {
      const request = requireOutputRecord(input, "creative-planning input");
      // 规划只消费当前请求的 brief（含人工输入覆盖）；不从 context 重新读取旧 brief——
      // 否则编辑不会真正进入下一次规划。
      const currentBrief = mergeCurrentBrief(request.brief, brief);
      const durationRange = currentBrief.durationRange;
      const currentDirection = currentBrief.director;
      if (!durationRange || !currentDirection) {
        throw new Error("Joint creative planning requires durationRange and a director direction.");
      }
      // 当前有效 brief 的导演绑定：端口解析与正式产物 provenance 共用（缺失即 fail closed）。
      const currentDirectorProviderId = currentBrief.providers.director;
      if (!currentDirectorProviderId) {
        throw new Error("Joint creative planning requires the AI director provider binding.");
      }
      if (treatmentBindings.length === 0) throw new Error("Joint creative planning requires a creative treatment agent binding.");
      // 构思模型路由复用既有候选合同：selectedModelId 只改变候选顺序，Provider 故障按既有分类切换。
      const treatmentAgent = new FallbackCreativeTreatmentAgent({ candidates: treatmentBindings });
      const referenceGrammar = referenceGrammarEnabled
        ? await readShotGrammarFile(requiredOutputString(request, "referenceGrammarPath"))
        : undefined;
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "creative-planning"));
      const inputDigest = jointPlanningInputDigest(currentBrief, referenceGrammar);
      const stageInputs = jointPlanningStageInputs(currentBrief, options, referenceGrammar);
      const historyPath = path.join(runsRoot, context.runId, "nodes", "creative-planning", "planning-history.json");
      // 当前 digest 的模型/provider trace 以既有记录为底（同 digest 重放不重跑端口，不得丢原
      // trace），播种携带的阶段继承其产物 provenance；本执行新增的 trace 逐端口合并写回。
      const existingHistory = await readJointPlanningHistory(historyPath);
      const recordedForDigest = existingHistory.find((entry) => entry.inputDigest === inputDigest);
      const modelTraces: Partial<Record<PlanningStageId, string>> = {
        ...(recordedForDigest?.modelTraces ?? {}),
      };
      // 实际执行 provider 与实际执行 model 分开收集：正式 provenance 按各自命名空间填写，
      // 缺失时显式 unknown，不用首选配置冒充。
      const providerTraces: Partial<Record<PlanningStageId, string>> = {
        ...(recordedForDigest?.providerTraces ?? {}),
      };
      // 图库路线的 worker 私有库存路径：搜索完成后写回执行记录，恢复按 digest 找回。
      let candidateInventoryPath: string | undefined = recordedForDigest?.candidateInventoryPath;
      let candidateInventorySha256: string | undefined = recordedForDigest?.candidateInventorySha256;
      const recordExecutionTraces = async () => upsertJointPlanningExecutionRecord(historyPath, {
        version: JOINT_PLANNING_HISTORY_VERSION,
        inputDigest,
        libraryRoute,
        stageInputs,
        modelTraces,
        providerTraces,
        ...(candidateInventoryPath !== undefined ? { candidateInventoryPath } : {}),
        ...(candidateInventorySha256 !== undefined ? { candidateInventorySha256 } : {}),
        recordedAt: new Date().toISOString(),
      });
      const store = CreativePlanningStore.open(path.dirname(runsRoot));
      let scriptArtifact: PlanningGraphState["scriptArtifact"];
      let treatmentArtifact: PlanningGraphState["treatmentArtifact"];
      let finalPlanArtifact: PlanningGraphState["integratedPlan"];
      let candidatesArtifact: PlanningGraphState["candidatesArtifact"];
      let rankingArtifact: PlanningGraphState["ranking"];
      let executablePlanArtifact: PlanningGraphState["executablePlan"];
      // 图库路线的额外端口单独注解：spread 表达式内部得不到上下文类型推导。
      const libraryPorts: Pick<CreativePlanningPorts, "searchCandidates" | "rank" | "integrateDirector"> = {
          searchCandidates: async (planningContext) => {
              const script = planningContext.script;
              const directorPlan = planningContext.directorPlan;
              if (!script || !directorPlan) {
                throw new Error("Creative planning candidate search requires the script and director plan artifacts.");
              }
              const searchAttempt = await reserveAttemptDirectory(path.join(attempt.directory, "candidate-search"));
              // worker asset.search 合同按文件路径消费稿件与导演方案：把图内已接受的产物落盘成输入。
              const searchScriptPath = path.join(searchAttempt.directory, "script.json");
              const searchDirectorPlanPath = path.join(searchAttempt.directory, "director_plan.json");
              await writeTextAtomically(
                searchScriptPath,
                `${JSON.stringify(scriptDocument(screenwriterBrief(currentBrief), script.output), null, 2)}\n`,
              );
              await writeTextAtomically(searchDirectorPlanPath, `${JSON.stringify(directorPlan.output, null, 2)}\n`);
              const response = await options.worker.run({
                protocolVersion: WORKER_PROTOCOL_VERSION,
                commandId: context.nextId("command"),
                runId: context.runId,
                nodeRunId: "creative-planning",
                attempt: searchAttempt.attempt,
                capability: "asset.search",
                input: { scriptPath: searchScriptPath, directorPlanPath: searchDirectorPlanPath },
                parameters: { providerId: "asset-candidate-search-v1", provider: "ai-router", mediaType: "video", limit: 6 },
                outputDir: searchAttempt.directory,
              });
              if (response.status !== "succeeded") {
                throw new Error(`Joint creative planning candidate search failed: ${response.error?.message ?? "worker command failed"}.`);
              }
              await verifyWorkerArtifacts(response, searchAttempt.directory);
              await verifyWorkerPrivateOutputPath(response.output?.candidateInventoryPath, searchAttempt.directory);
              // 私有库存是独立于公开报告的 worker 产物：绑定进入图状态（随候选 checkpoint
              // 持久化）与执行记录，下游物化消费库存本身，而不是拿公开报告冒充库存。
              const inventoryPath = requiredOutputString(response.output, "candidateInventoryPath");
              // BG-09：绑定同时记录内容指纹——恢复/消费前校验文件未被替换。
              const inventoryBytes = await readFile(inventoryPath);
              const inventorySha256 = createHash("sha256").update(inventoryBytes).digest("hex");
              candidateInventoryPath = inventoryPath;
              candidateInventorySha256 = inventorySha256;
              await recordExecutionTraces();
              const report = parseAssetCandidateReport(JSON.parse(await readFile(
                requiredOutputString(response.output, "candidateSearchPath"),
                "utf8",
              )));
              return { artifactId: planningArtifactId("asset-candidates", report), output: report, candidateInventoryPath: inventoryPath, candidateInventorySha256: inventorySha256 };
            },
            rank: async (planningContext) => {
              const ranker = options.assetSemanticRanker;
              if (!ranker) throw new Error("Joint creative planning library route requires the asset semantic ranker.");
              const candidates = planningContext.candidates;
              if (!candidates) throw new Error("Creative planning rank requires the candidates artifact.");
              const rankDirectorPlan = planningContext.directorPlan;
              if (!rankDirectorPlan) throw new Error("Creative planning rank requires the director plan artifact.");
              // 排序请求携带当前画面语义（与图内证据覆盖同一投影），不是只有内容摘要式
              // artifact id：主体/动作/真实性要求变化必然改变请求与 checkpoint 身份。
              const currentRankingRequest = {
                ...candidates.output,
                planningIntent: {
                  scriptArtifactId: planningContext.script?.artifactId,
                  directorArtifactId: rankDirectorPlan.artifactId,
                  issues: planningContext.issues,
                  semanticIntentVersion: RANKING_SEMANTIC_INTENT_VERSION,
                  rankingIntent: rankingSemanticIntent(rankDirectorPlan.output),
                },
              };
              const execution = ranker.rankDetailed
                ? await ranker.rankDetailed(
                    currentRankingRequest,
                    nodeAgentLoopCheckpoint(
                      runsRoot,
                      context.runId,
                      "creative-planning",
                      {
                        stage: "rank",
                        report: currentRankingRequest,
                        // 与外层 stage identity 同一 ranker 身份投影：checkpoint 身份由
                        // 同一真实执行输入派生，provider/model/合同变化必然换 checkpoint。
                        ranker: {
                          id: ranker.id,
                          modelId: ranker.modelId ?? null,
                          contractVersion: ASSET_RANK_AGENT_CONTRACT_VERSION,
                        },
                      },
                      ASSET_RANK_AGENT_CONTRACT_VERSION,
                      undefined,
                      context.operationRequestId,
                      resumeCompletedTextTaskNodeId,
                      resumeCompletedTextTaskRequestId,
                      recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
                    ),
                  )
                : { output: await ranker.rank(currentRankingRequest) };
              const ranking = validateAssetSemanticRanking({
                ...execution.output,
                source: "model",
                providerId: execution.trace?.providerId ?? ranker.id,
                modelId: execution.trace?.modelId ?? ranker.modelId,
              }, candidates.output);
              if (execution.trace?.modelId) {
                modelTraces.rank = execution.trace.modelId;
                providerTraces.rank = execution.trace.providerId;
                await recordExecutionTraces();
              }
              return { artifactId: planningArtifactId("asset-ranking", ranking), output: ranking };
            },
            integrateDirector: async (planningContext) => {
              const draft = planningContext.directorPlan;
              const ranking = planningContext.ranking;
              if (!draft || !ranking) {
                throw new Error("Creative planning integrate requires the draft plan and ranking artifacts.");
              }
              // 整合出口合同只允许改 rationale（候选/排序证据身份不得变化），因此这里是确定性
              // 整合：为采用候选的 stock 镜头写入语义排序采用说明，不调用模型。
              const adopted = new Map(ranking.output.scenes.flatMap((scene) => scene.candidates
                .filter((candidate) => candidate.locked || candidate.semanticScore >= AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM)
                .slice(0, 1)
                .map((candidate) => [scene.scenePosition, candidate] as const)));
              const integrated: VisualDirectorPlan = {
                ...draft.output,
                shots: draft.output.shots.map((shot) => {
                  const candidate = adopted.get(shot.scenePosition);
                  if (!candidate || (shot.deliveryType !== "stock_video" && shot.deliveryType !== "stock_image")) return shot;
                  return { ...shot, rationale: `${shot.rationale} 语义排序采用 ${candidate.provider}/${candidate.assetId}。` };
                }),
              };
              return { artifactId: planningArtifactId("director-plan-integrated", integrated), output: integrated };
            },
      };
      try {
        // 端口适配：图内角色调用沿用旧节点的真实 agent、provider 注册表与合同校验。
        const ports: CreativePlanningPorts = {
          treatment: async (planningContext) => {
            const lockedViewerPromise = acceptedViewerPromise(currentBrief);
            const seriesContext = creativeTreatmentSeriesContext(currentBrief.seriesContext);
            const reworkInstruction = currentBrief.rework?.nodeInstructions.script.trim();
            const treatmentBrief: CreativeTreatmentAgentInput["brief"] = {
              title: currentBrief.title,
              angle: currentBrief.angle,
              audience: currentBrief.audience,
              nicheSlug: currentBrief.nicheSlug,
              platform: currentBrief.platform,
              durationSeconds: currentBrief.durationSeconds,
              ...(currentBrief.budgetIntentionCny !== undefined ? { budgetIntentionCny: currentBrief.budgetIntentionCny } : {}),
              durationRange,
              ...(currentBrief.editorial ? { editorial: currentBrief.editorial } : {}),
              ...(currentBrief.visualProof ? { visualProof: currentBrief.visualProof } : {}),
              ...(currentBrief.visualIntent ? { visualIntent: currentBrief.visualIntent } : {}),
              ...(reworkInstruction ? { reworkInstruction } : {}),
              ...(currentBrief.visualPlan ? { visualPlan: currentBrief.visualPlan } : {}),
              // 用户/系列已接受的承诺进入构思的真实输入：宿主锁定它，模型输出被覆盖对齐。
              ...(lockedViewerPromise ? { lockedViewerPromise } : {}),
              ...(seriesContext ? { seriesContext } : {}),
              productionCapabilities: productionCapabilitiesFor(currentBrief, options),
            };
            const treatmentInput: CreativeTreatmentAgentInput = {
              brief: treatmentBrief,
              suppliedSources: treatmentSuppliedSources(currentBrief),
              planningMode: true,
              ...(planningContext.creativeReviewExecution?.mode === "draft"
                ? { creativeReviewExecution: { mode: "draft" as const } }
                : planningContext.creativeReviewExecution?.mode === "check" && planningContext.treatment
                  ? { creativeReviewExecution: { mode: "check" as const, candidate: planningContext.treatment.output } }
                  : {}),
              // 参考语法是风格/结构参考（不冒充事实证据），与剧本/导演共用同一已接受语法。
              ...(referenceGrammar ? { referenceGrammar } : {}),
              // 与 script/director/rank 同一边界：构思角色经 role-agent-loop 落 v7 checkpoint，
              // 只读投影据此报告真实执行模型（含 fallback 后的实际模型）。每个候选模型一份
              // durable checkpoint——fallback 到 B 后中断，B 的中间角色状态同样可恢复。
              agentLoopCheckpoint: nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                {
                  stage: "treatment",
                  brief: treatmentBrief,
                  suppliedSources: treatmentSuppliedSources(currentBrief),
                  ...(referenceGrammar ? { referenceGrammar } : {}),
                  ...(planningContext.creativeReviewExecution
                    ? { creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) }
                    : {}),
                },
                CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION,
                undefined,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
              agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                {
                  stage: "treatment",
                  brief: treatmentBrief,
                  suppliedSources: treatmentSuppliedSources(currentBrief),
                  ...(referenceGrammar ? { referenceGrammar } : {}),
                  ...(planningContext.creativeReviewExecution
                    ? { creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) }
                    : {}),
                },
                CREATIVE_TREATMENT_AGENT_CONTRACT_VERSION,
                modelId,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
              ...(currentBrief.models?.[CREATIVE_TREATMENT_PROVIDER_ID]
                ? { selectedModelId: currentBrief.models[CREATIVE_TREATMENT_PROVIDER_ID] }
                : {}),
            };
            const treatmentExecution = await treatmentAgent.treatDetailed(treatmentInput);
            if (treatmentExecution.trace?.modelId) {
              modelTraces.treatment = treatmentExecution.trace.modelId;
              providerTraces.treatment = treatmentExecution.trace.providerId;
              await recordExecutionTraces();
            }
            // 来源缺口不再是停摆：角色产出把它当建议带上去，进 state.issues 给下游角色与创作者看。
            const treatmentAdvisories = planningSourceAdvisories(treatmentExecution, "treatment");
            return {
              artifactId: planningArtifactId("creative-treatment", treatmentExecution.output),
              output: treatmentExecution.output,
              ...(treatmentAdvisories.length ? { advisories: treatmentAdvisories } : {}),
              ...planningReviewCheckResult(planningContext, treatmentExecution),
            };
          },
          screenwriter: async (planningContext) => {
            const provider = context.resolveProvider<ScreenwriterAgentInput, CodexTaskExecution<unknown>>({
              capability: "script.draft",
              providerId: currentBrief.providers.script,
            });
            const requestBrief: ScreenwriterAgentInput["brief"] = {
              ...screenwriterBrief(currentBrief, options),
              ...(planningContext.treatment ? { creativeTreatment: planningContext.treatment.output } : {}),
              ...(planningContext.issues.length ? { planningIssues: planningContext.issues } : {}),
              ...(currentBrief.articleSources?.length ? { articleSources: currentBrief.articleSources } : {}),
              productionCapabilities: productionCapabilitiesFor(currentBrief, options),
            };
            const selectedScriptModelId = currentBrief.models?.[currentBrief.providers.script];
            const scriptCheckpointInput = {
              stage: "script",
              brief: requestBrief,
              treatmentArtifactId: planningContext.treatment?.artifactId,
            };
            const execution = await provider.run({
              brief: requestBrief,
              planningMode: true,
              ...(planningContext.creativeReviewExecution?.mode === "draft"
                ? { creativeReviewExecution: { mode: "draft" as const } }
                : planningContext.creativeReviewExecution?.mode === "check" && planningContext.script
                  ? { creativeReviewExecution: { mode: "check" as const, candidate: planningContext.script.output } }
                  : {}),
              ...(selectedScriptModelId ? { selectedModelId: selectedScriptModelId } : {}),
              agentLoopCheckpoint: nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                { ...scriptCheckpointInput, creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) },
                SCREENWRITER_AGENT_CONTRACT_VERSION,
                undefined,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
              agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                { ...scriptCheckpointInput, creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) },
                SCREENWRITER_AGENT_CONTRACT_VERSION,
                modelId,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
            }, context);
            if (execution.trace?.modelId) {
              modelTraces.script = execution.trace.modelId;
              providerTraces.script = execution.trace.providerId;
              await recordExecutionTraces();
            }
            const draft = validateScriptDraft(execution.output, {
              durationSeconds: requestBrief.durationSeconds,
              ...(requestBrief.durationRange ? { durationRange: requestBrief.durationRange } : {}),
              requireCanonFacts: Boolean(requestBrief.seriesContext),
            });
            const scriptAdvisories = planningSourceAdvisories(execution, "script");
            return {
              artifactId: planningArtifactId("script-draft", draft),
              output: draft,
              ...(scriptAdvisories.length ? { advisories: scriptAdvisories } : {}),
              ...planningReviewCheckResult(planningContext, execution),
            };
          },
          director: async (planningContext) => {
            const script = planningContext.script;
            if (!script) throw new Error("Creative planning director requires the script artifact.");
            const document = scriptDocument(screenwriterBrief(currentBrief), script.output);
            const viewerPromise = optionalOutputString(document.viewerPromise);
            const narrativeArc = optionalOutputString(document.narrativeArc);
            const scenes = parseDirectorScenes(document.scenes);
            // 素材路由输入与阶段身份共用同一投影 helper；目录缺失 provider 时明确失败。
            const assetProviders = directorAssetProviderInputs(currentBrief, options);
            const provider = context.resolveProvider<VisualDirectorAgentInput, CodexTaskExecution<unknown>>({
              capability: "storyboard.plan",
              providerId: currentDirectorProviderId,
            });
            const costFeedback = currentBrief.spendFeedback?.slice(-10).reverse().map((feedback) => ({
              reason: feedback.reason,
              previousEstimatedCostCny: feedback.previousEstimatedCostCny,
              ...(feedback.targetEstimatedCostCny !== undefined
                ? { targetEstimatedCostCny: feedback.targetEstimatedCostCny }
                : {}),
              ...(feedback.note ? { note: feedback.note } : {}),
            }));
            const directorEconomics = { allowMeteredProviders: currentBrief.economics.allowMeteredProviders };
            const scopedPlanningScenePositions = [...new Set(planningContext.issues.flatMap((issue) => (
              issue.scenePositions.length > 0
                ? issue.scenePositions
                : issue.availabilityBlocker?.impactScope.scenePositions ?? []
            )))].sort((left, right) => left - right);
            const planningAffectedScenePositions = scopedPlanningScenePositions.length > 0
              ? scopedPlanningScenePositions
              : scenes.map((scene) => scene.position);
            // joint-v1 的导演阶段与旧 visual-direction 节点同一 rework 消费合同：返工意见、
            // 影响范围与上一版方案进入导演 brief；A5 的“输入未变不重跑”由阶段输入身份
            // （directorStageInputIdentity 含 rework 投影）与闭包播种承担。
            const affectedScenePositions = currentBrief.rework
              ? reworkAffectedScenePositions({
                findings: currentBrief.rework.findings,
                ...(currentBrief.rework.previousScript ? { previousScenes: currentBrief.rework.previousScript.scenes } : {}),
                ...(currentBrief.rework.previousDirectorPlan ? { previousShots: currentBrief.rework.previousDirectorPlan.shots } : {}),
                currentScenes: script.output.scenes,
                ...(currentBrief.rework.affectedScenePositions !== undefined
                  ? { affectedScenePositions: currentBrief.rework.affectedScenePositions }
                  : {}),
              })
              : [];
            const producerBrief: VisualDirectorAgentInput["brief"] = {
              title: currentBrief.title,
              angle: currentBrief.angle,
              audience: currentBrief.audience,
              platform: currentBrief.platform,
              durationSeconds: currentBrief.durationSeconds,
              ...(currentBrief.budgetIntentionCny !== undefined ? { budgetIntentionCny: currentBrief.budgetIntentionCny } : {}),
              durationRange,
              ...(viewerPromise ? { viewerPromise } : {}),
              ...(narrativeArc ? { narrativeArc } : {}),
              requestedProfileId: currentDirection.profileId,
              ...(currentBrief.editorial ? { editorial: currentBrief.editorial } : {}),
              ...(currentBrief.visualProof ? { visualProof: currentBrief.visualProof } : {}),
              ...(currentBrief.visualIntent ? { visualIntent: currentBrief.visualIntent } : {}),
              ...(currentBrief.visualPlan ? { visualPlan: currentBrief.visualPlan } : {}),
              voiceTiming: voiceTimingFor(currentBrief),
              ...(referenceGrammar ? { referenceGrammar } : {}),
              ...(currentBrief.seriesContext ? { seriesContext: currentBrief.seriesContext } : {}),
              ...(currentBrief.articleSources?.length ? { articleSources: currentBrief.articleSources } : {}),
              ...(currentBrief.rework ? {
                rework: {
                  sourceRunId: currentBrief.rework.sourceRunId,
                  visualDirectionInstruction: currentBrief.rework.nodeInstructions.visualDirection,
                  assetInstruction: currentBrief.rework.nodeInstructions.assets,
                  findings: currentBrief.rework.findings
                    .filter((finding) => finding.targetNodeIds.includes("visual-direction") && finding.action !== "inspect_existing_media")
                    .map(modelFacingReworkFinding),
                  ...(affectedScenePositions.length || currentBrief.rework.affectedScenePositions !== undefined
                    ? { affectedScenePositions }
                    : {}),
                  ...(currentBrief.rework.previousDirectorPlan ? { previousDirectorPlan: currentBrief.rework.previousDirectorPlan } : {}),
                },
              } : {}),
              ...(planningContext.treatment ? { creativeTreatment: planningContext.treatment.output } : {}),
              ...(planningContext.issues.length ? { planningIssues: planningContext.issues } : {}),
              ...(planningContext.directorPlan && planningContext.issues.length ? {
                planningRevision: {
                  previousPlan: planningContext.directorPlan.output,
                  previousPlanDigest: createHash("sha256").update(JSON.stringify(planningContext.directorPlan.output)).digest("hex"),
                  affectedScenePositions: planningAffectedScenePositions,
                  availabilityHistory: planningContext.availabilityHistory.slice(-12),
                },
              } : {}),
              productionCapabilities: summarizeProductionCapabilities(assetProviders, currentBrief.providers.voice),
            };
            const selectedDirectorModelId = currentBrief.models?.[currentBrief.providers.director ?? ""]
              ?? provider.modelId
              ?? "codex-default";
            const directorCheckpointInput = {
              stage: "director",
              brief: producerBrief,
              scenes,
              assetProviders,
              economics: directorEconomics,
              ...(referenceGrammar ? { referenceGrammar } : {}),
              ...(costFeedback?.length ? { costFeedback } : {}),
              ...(planningContext.issues.length ? { issues: planningContext.issues } : {}),
            };
            const execution = await provider.run({
              brief: producerBrief,
              scenes,
              assetProviders,
              economics: directorEconomics,
              planningMode: true,
              ...(planningContext.creativeReviewExecution?.mode === "draft"
                ? { creativeReviewExecution: { mode: "draft" as const } }
                : planningContext.creativeReviewExecution?.mode === "check" && planningContext.directorPlan
                  ? { creativeReviewExecution: { mode: "check" as const, candidate: planningContext.integratedPlan?.output ?? planningContext.directorPlan.output } }
                  : {}),
              selectedModelId: selectedDirectorModelId,
              ...(costFeedback?.length ? { costFeedback } : {}),
              agentLoopCheckpoint: nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                { ...directorCheckpointInput, creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) },
                VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
                undefined,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
              agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
                runsRoot,
                context.runId,
                "creative-planning",
                { ...directorCheckpointInput, creativeReviewExecution: planningReviewCheckpointIdentity(planningContext) },
                VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
                modelId,
                context.operationRequestId,
                resumeCompletedTextTaskNodeId,
                resumeCompletedTextTaskRequestId,
                recoverTextTask?.nodeId === "creative-planning" ? recoverTextTask.workflowOperationRequestId : undefined,
              ),
            }, context);
            if (execution.trace?.modelId) {
              modelTraces.director = execution.trace.modelId;
              providerTraces.director = execution.trace.providerId;
              await recordExecutionTraces();
            }
            const plan = validateVisualDirectorPlan(execution.output, visualDirectorPlanValidation(
              currentBrief,
              scenes,
              options.assetProviders ?? [],
              options.providerRuntimeMetadata ?? [],
              viewerPromise,
            ));
            const directorAdvisories = planningSourceAdvisories(execution, "director");
            return {
              artifactId: planningArtifactId("director-plan", plan),
              output: plan,
              ...(directorAdvisories.length ? { advisories: directorAdvisories } : {}),
              ...planningReviewCheckResult(planningContext, execution),
            };
          },
          discuss: async (discussion) => {
            const selectedModelId = discussion.stage === "treatment"
              ? currentBrief.models?.[CREATIVE_TREATMENT_PROVIDER_ID]
              : discussion.stage === "script"
                ? currentBrief.models?.[currentBrief.providers.script]
                : currentBrief.models?.[currentDirectorProviderId];
            const agent = discussion.stage === "treatment"
              ? treatmentAgent
              : discussion.stage === "script"
                ? options.screenwriterAgent
                : options.directorAgent;
            if (!agent?.discussDetailed) {
              throw new Error(`Creative discussion is not configured for the '${discussion.stage}' role.`);
            }
            const requestId = `creative-discussion-${contentSha256({ runId: context.runId, commandId: discussion.commandId }).slice(0, 32)}`;
            let execution: CodexTaskExecution<CreativeDiscussionResult>;
            try {
              execution = await agent.discussDetailed({
                stage: discussion.stage,
                currentDocument: discussion.currentDocument,
                context: {
                  effectiveUserInstructions: discussion.effectiveUserInstructions,
                  ...(currentBrief.budgetIntentionCny !== undefined ? { budgetIntentionCny: currentBrief.budgetIntentionCny, budgetMeaning: "用户费用偏好，不是硬上限或付款授权" } : {}),
                  upstreamConfirmed: discussion.upstreamDocuments,
                  productionCapabilities: productionCapabilitiesFor(currentBrief, options),
                  voiceTiming: voiceTimingFor(currentBrief),
                  ...(currentBrief.seriesContext ? { seriesContext: currentBrief.seriesContext } : {}),
                  ...(currentBrief.visualIntent ? { visualIntent: currentBrief.visualIntent } : {}),
                  ...(currentBrief.visualProof ? { visualProof: currentBrief.visualProof } : {}),
                  ...(currentBrief.articleSources?.length ? { articleSources: currentBrief.articleSources } : {}),
                },
                message: discussion.message,
                ...(discussion.selection ? { selection: discussion.selection } : {}),
                recentMessages: discussion.recentMessages,
                ...(selectedModelId ? { selectedModelId } : {}),
                requestId,
              });
              await recordCreativeDiscussionExecution(runsRoot, context.runId, {
                workflowOperationRequestId: context.operationRequestId,
                commandId: discussion.commandId,
                requestId,
                stage: discussion.stage,
                state: "completed",
                ...(execution.trace ? { trace: execution.trace } : {}),
              });
            } catch (error) {
              await recordCreativeDiscussionExecution(runsRoot, context.runId, {
                workflowOperationRequestId: context.operationRequestId,
                commandId: discussion.commandId,
                requestId,
                stage: discussion.stage,
                state: error instanceof CodexBridgeError && error.stage === "uncertain"
                  ? "accepted_unknown"
                  : error instanceof CodexBridgeError && (error.stage === "not_accepted" || error.stage === "rejected")
                    ? "not_accepted"
                    : "completed_failure",
              });
              throw error;
            }
            if (execution.trace?.modelId) {
              modelTraces[discussion.stage] = execution.trace.modelId;
              providerTraces[discussion.stage] = execution.trace.providerId;
              await recordExecutionTraces();
            }
            return execution.output;
          },
          ...(libraryRoute ? libraryPorts : {}),
          compile: executablePlanCompilePort,
        };
        const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
        const threadConfig = store.threadConfig(context.runId, inputDigest);
        // 编辑闭包：新 digest 的 thread 在启动前按阶段输入身份播种未受影响的上游产物，
        // 携带阶段同时继承其模型 provenance。已有 checkpoint（恢复/重放）不播种——直接走
        // runCreativePlanning 的恢复分支。前驱取最近一次执行的记录（recordedAt 最大），
        // 不是数组末位：A→B→A 重放后 A 是最新执行，下一次编辑必须以 A 为前驱。
        const existingSnapshot = await graph.getState(threadConfig);
        const existingValues = (existingSnapshot?.values ?? {}) as Partial<PlanningGraphState>;
        if (existingValues.inputDigest != null) {
          const carriedStageInputs = existingValues.carriedStageInputIdentities ?? {};
          for (const stage of ["treatment", "script", "director"] as const) {
            const carriedIdentity = carriedStageInputs[stage];
            if (carriedIdentity !== undefined && carriedIdentity !== stageInputs[stage]) {
              throw new Error(`Creative planning cannot resume this thread: carried ${stage} evidence is incompatible with the current stage contract.`);
            }
          }
          Object.assign(modelTraces, existingValues.carriedModelTraces ?? {});
          Object.assign(providerTraces, existingValues.carriedProviderTraces ?? {});
          // 线索 B 守卫：同 digest 重放前比对执行记录的阶段输入身份与当前计算值——素材目录
          // 或运行环境在 digest 不变的情况下变化（重启换目录条目等），旧 thread 的产物基于
          // 不同真实输入构建，不得静默重放；fail closed，由用户修改输入开新 thread。
          const recorded = existingHistory.find((entry) => entry.inputDigest === inputDigest);
          if (recorded && (
            recorded.stageInputs.treatment !== stageInputs.treatment
            || recorded.stageInputs.script !== stageInputs.script
            || recorded.stageInputs.director !== stageInputs.director
          )) {
            throw new Error(
              "Creative planning cannot resume this thread: the real inputs of a planning stage "
              + "(asset catalog, runtime models, or role bindings) changed while the planning input stayed the same. "
              + "Edit the planning input to open a new planning thread.",
            );
          }
          // ranker 身份（provider/model/合同版本/语义投影规则）变化：只失效排序证据及其下游，
          // 候选与未变阶段保留。游标重置回 director 之后，图路由因 ranking=null 走真实重排
          // （不重搜）——不得重放 completed graph 的旧排序。旧记录无 rank 身份时按"身份未知"
          // 处理，同样强制一次真实重排。
          if (libraryRoute && recorded && recorded.stageInputs.rank !== stageInputs.rank) {
            await graph.updateState(threadConfig, {
              ranking: null,
              rankingInputFingerprint: null,
              integratedPlan: null,
              executablePlan: null,
              artifactIds: withoutPlanningStageArtifacts(existingValues.artifactIds ?? {}, ["rank", "integrate", "compile"]),
            }, "director");
            delete modelTraces.rank;
            delete providerTraces.rank;
            // 记录当前身份：重排完成前再次中断时，恢复仍按新身份继续，不重复失效。
            recorded.stageInputs = { ...recorded.stageInputs, rank: stageInputs.rank };
            await upsertJointPlanningExecutionRecord(historyPath, {
              version: JOINT_PLANNING_HISTORY_VERSION,
              inputDigest,
              libraryRoute,
              stageInputs,
              modelTraces,
              providerTraces,
              ...(candidateInventoryPath !== undefined ? { candidateInventoryPath } : {}),
              ...(candidateInventorySha256 !== undefined ? { candidateInventorySha256 } : {}),
              recordedAt: new Date().toISOString(),
            });
          }
          // BG-03：无 history 恢复分支（recorded 为空，如跨进程/跨 run 播种后 history 未写）
          // 用 checkpoint 内的 carried rank identity 核对——缺失或不一致都强制真实重排，
          // 不得让换掉的 ranker 重放播种进来的旧排序。
          if (libraryRoute && !recorded) {
            const carriedRankIdentity = carriedStageInputs.rank;
            if (carriedRankIdentity !== stageInputs.rank && existingValues.ranking != null) {
              await graph.updateState(threadConfig, {
                ranking: null,
                rankingInputFingerprint: null,
                integratedPlan: null,
                executablePlan: null,
                artifactIds: withoutPlanningStageArtifacts(existingValues.artifactIds ?? {}, ["rank", "integrate", "compile"]),
              }, "director");
              delete modelTraces.rank;
              delete providerTraces.rank;
            }
          }
        }
        if (((existingSnapshot?.values ?? {}) as Partial<PlanningGraphState>).inputDigest == null) {
          // F3：media/director-only 返工的新 run 不重跑未受影响的规划角色——当前 run 的
          // history 为空时，从返工源 run 的执行记录与 checkpoint 播种；阶段身份不匹配的
          // 阶段照旧不携带（导演/编剧实质变化仍会重跑）。
          const reworkSourceRunId = currentBrief.rework?.sourceRunId;
          let prior = latestJointPlanningRecord(existingHistory, inputDigest);
          let priorRunId: string | undefined;
          // 只对 media/director-only 返工跨 run 播种：编剧被点名重做时（有脚本指令或
          // script 责任 findings），编剧/导演阶段本来就要重跑，不启用源 run 继承。
          if (!prior && reworkSourceRunId
            && screenwriterReworkContext(currentBrief) === undefined
            && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reworkSourceRunId)) {
            const sourceHistory = await readJointPlanningHistory(path.join(
              runsRoot,
              reworkSourceRunId,
              "nodes",
              "creative-planning",
              "planning-history.json",
            ));
            const candidate = latestJointPlanningRecord(sourceHistory, inputDigest);
            if (candidate) {
              prior = candidate;
              priorRunId = reworkSourceRunId;
            }
          }
          const carried = await seedJointPlanningThread({
            graph,
            store,
            runId: context.runId,
            inputDigest,
            planningInput: {
              runId: context.runId,
              inputDigest,
              durationRange,
              ...(currentBrief.workflowFeatures?.creativeReview
                ? { creativeReview: currentBrief.workflowFeatures.creativeReview }
                : {}),
            },
            libraryRoute,
            prior,
            ...(priorRunId ? { priorRunId } : {}),
            stageInputs,
            historyPath,
          });
          if (carried) {
            Object.assign(modelTraces, carried.modelTraces);
            Object.assign(providerTraces, carried.providerTraces);
            if (carried.candidateInventoryPath) candidateInventoryPath = carried.candidateInventoryPath;
            // 播种 checkpoint 已落盘、执行记录尚未写：崩溃窗口在此收口（种子 provenance
            // 必须随 checkpoint 存活，不依赖 history 文件）。
            options.planningFailpoints?.afterSeed?.();
          }
        }
        // 执行前先落执行记录：后续阶段失败/中断的部分完成执行也能作为下一次编辑的闭包前驱，
        // 已执行阶段的 trace 不因中途失败丢失（端口完成时还会逐阶段合并写回）。
        await recordExecutionTraces();
        const outcome = await runCreativePlanning(graph, {
          input: {
            runId: context.runId,
            inputDigest,
            durationRange,
            ...(currentBrief.workflowFeatures?.creativeReview
              ? { creativeReview: currentBrief.workflowFeatures.creativeReview }
              : {}),
          },
          threadId: store.threadId(context.runId, inputDigest),
          ...(creativeReviewResume ? { resume: creativeReviewResume } : {}),
        });
        if (outcome.status === "waiting_user") {
          const finalState = ((await graph.getState(threadConfig))?.values ?? {}) as Partial<PlanningGraphState>;
          const stage = outcome.gate.stage;
          const draft = stage === "treatment"
            ? finalState.treatmentArtifact
            : stage === "script"
              ? finalState.scriptArtifact
              : finalState.integratedPlan ?? finalState.directorPlan;
          if (!draft || draft.artifactId !== outcome.gate.draft.artifactId) {
            throw new Error(`Creative review '${stage}' draft is missing from the planning checkpoint.`);
          }
          const content = `${JSON.stringify(draft.output, null, 2)}\n`;
          const draftPath = path.join(attempt.directory, `${stage}-draft-r${outcome.gate.draft.revision}.json`);
          await writeTextAtomically(draftPath, content);
          const registered = context.addArtifact(fileArtifact(
            "creative_draft",
            draftPath,
            content,
            "application/json",
            `video-factory/${stage}-draft-v1`,
            "creative-planning",
            context.artifacts.filter((artifact) => artifact.producer?.nodeId === "brief").map((artifact) => artifact.id),
            providerTraces[stage] ?? currentBrief.providers.script,
            "Unconfirmed creative draft for user discussion; not executable and not a spend approval.",
            attempt.attempt,
            `${inputDigest}:${stage}:${outcome.gate.draft.sha256}`,
          ));
          await recordExecutionTraces();
          const summary = await summarizeJointPlanningExecution(runsRoot, context.runId, context.operationRequestId);
          const blockingIssues = outcome.state.issues.map((issue) => ({
            target: issue.target,
            scenePositions: [...issue.scenePositions],
            reason: issue.reason,
            requiredChange: issue.requiredChange,
          }));
          return {
            status: "needs_human",
            output: {
              creativeReview: outcome.state.creativeReview,
              blockingIssues,
              draftArtifactId: registered.id,
              stage,
              // 自动循环自停的理由随停点一起交给界面：人做决定时要知道是哪一件事把循环卡住了。
              ...(outcome.state.planningStop
                ? { planningStop: structuredClone(outcome.state.planningStop) }
                : {}),
              ...(creativeReviewResume ? {
                creativeReviewOperation: {
                  commandId: creativeReviewResume.commandId,
                  action: creativeReviewResume.action,
                  status: "completed",
                },
              } : {}),
            },
            preRegisteredArtifactIds: [registered.id],
            intervention: {
              kind: "creative_review",
              reason: stage === "treatment"
                ? "前期构思已生成，等你确认。你可以直接继续，也可以先聊聊想改的地方。"
                : stage === "script"
                  ? "脚本草稿已生成，等你确认。"
                  : blockingIssues.length > 0
                    ? "当前导演方案需要你决定：素材条件无法满足已确认的画面路线，系统已保留方案且不会自动改写。"
                    : "导演方案已生成，等你确认。",
              // 自动循环是自己推不动了才停下的，这一点必须说出来：否则人以为一切正常，
              // 不知道该在哪一件事上做决定。停下等人的决定权在人手里，不是已经判了这个作品。
              ...(outcome.state.planningStop
                ? { stopDetail: `自动检查已停止：${outcome.state.planningStop.detail}` }
                : {}),
              requiredAction: "approve",
              options: ["approve", "request_changes"],
              artifactIds: [registered.id],
              continuation: {
                stage,
                reviewRevision: outcome.gate.reviewRevision,
                draftSha256: outcome.gate.draft.sha256,
              },
            },
            receipt: {
              providerId: treatmentAgent.id,
              providerLabel: "joint-v1 创作规划",
              modelId: modelTraces[stage] ?? "unknown",
              transport: "unix_socket",
              billing: "subscription",
              configurationSource: "system_default",
              parameters: { planningRoute: libraryRoute ? "library" : "fixed", waitingStage: stage, ...(summary ?? {}) },
              estimatedCostCny: 0,
              requestId: context.nextId("creative-planning-waiting"),
            },
          };
        }
        if (outcome.status === "halted") {
          throw new Error(`Joint creative planning stopped (${outcome.halt.reason}): ${outcome.halt.detail} 不回退旧规划流程。`);
        }
        // 完成态只携带 executable plan：稿件/导演方案/候选/排序从终态 checkpoint 读取，
        // 保证崩溃恢复（同 thread 重放）也能重建全部正式产物。
        const finalState = ((await graph.getState(threadConfig))?.values ?? {}) as Partial<PlanningGraphState>;
        // 私有库存绑定的权威来源是 checkpoint 状态（随候选持久化）：播种/崩溃恢复后
        // 不依赖尚未写入的 history；本地闭包变量只覆盖本次执行内的新搜索。
        if (finalState.candidateInventoryBinding) {
          candidateInventoryPath = finalState.candidateInventoryBinding;
          candidateInventorySha256 = finalState.candidateInventorySha256 ?? undefined;
          // BG-09：恢复时校验库存文件内容指纹——文件缺失或被替换即 fail closed，
          // 不得让下游物化消费被替换的库存。
          if (candidateInventorySha256) {
            const disk = await readFile(candidateInventoryPath).catch(() => undefined);
            const diskSha = disk ? createHash("sha256").update(disk).digest("hex") : undefined;
            if (diskSha !== candidateInventorySha256) {
              throw new Error("Joint creative planning library route: the persisted candidate inventory file is missing or was replaced; refusing to consume it.");
            }
          }
        }
        scriptArtifact = finalState.scriptArtifact ?? null;
        treatmentArtifact = finalState.treatmentArtifact ?? null;
        finalPlanArtifact = finalState.integratedPlan ?? finalState.directorPlan ?? null;
        candidatesArtifact = finalState.candidatesArtifact ?? null;
        rankingArtifact = finalState.ranking ?? null;
        executablePlanArtifact = finalState.executablePlan ?? outcome.executablePlan;
        await recordExecutionTraces();
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          const trace = error.lastTrace;
          const failed = await failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "creative-planning",
            attempt: attempt.attempt,
            parentArtifactIds: context.artifacts.map((artifact) => artifact.id),
            provider: {
              id: trace?.providerId ?? currentBrief.providers.script,
              modelId: trace?.modelId ?? "unknown",
              transport: "unix_socket",
              billing: "subscription",
              configurationSource: "system_default",
              parameters: { planningRoute: libraryRoute ? "library" : "fixed" },
              estimatedCostCny: 0,
            },
            providerLabel: "joint-v1 创作规划",
          });
          const summary = await summarizeJointPlanningExecution(runsRoot, context.runId, context.operationRequestId);
          if (summary && failed.receipt) {
            failed.receipt.parameters = { ...(failed.receipt.parameters ?? {}), ...summary };
          }
          return failed;
        }
        const summary = await summarizeJointPlanningExecution(runsRoot, context.runId, context.operationRequestId);
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          receipt: {
            providerId: currentBrief.providers.script,
            providerLabel: "joint-v1 创作规划",
            modelId: modelTraces.treatment ?? modelTraces.script ?? modelTraces.director ?? "unknown",
            transport: "unix_socket",
            billing: "subscription",
            configurationSource: "system_default",
            parameters: {
              planningRoute: libraryRoute ? "library" : "fixed",
              ...(summary ?? {}),
            },
            estimatedCostCny: 0,
            requestId: context.nextId("creative-planning-failure"),
          },
        };
      } finally {
        store.close();
      }
      // 必需正式产物缺失即 fail closed（try/finally 之后统一判定，不静默补齐）。
      if (!treatmentArtifact || !scriptArtifact || !finalPlanArtifact || !executablePlanArtifact) {
        throw new Error("Joint creative planning ended without its formal treatment, script, director plan, or executable plan artifacts.");
      }
      if (libraryRoute && (!candidatesArtifact || !rankingArtifact)) {
        throw new Error("Joint creative planning library route ended without its candidate artifacts.");
      }
      options.planningFailpoints?.afterGraph?.();
      const briefArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "brief")
        .map((artifact) => artifact.id);
      const grammarArtifactIds = referenceGrammarEnabled
        ? context.artifacts
          .filter((artifact) => artifact.producer?.nodeId === "reference-grammar")
          .map((artifact) => artifact.id)
        : [];
      // 规划节点 receipt 的实际模型：只用真实执行 trace；来源缺失时显式 unknown，
      // 不用首选配置或角色默认模型冒充实际执行来源。
      const planningExecutionSummary = await summarizeJointPlanningExecution(
        runsRoot,
        context.runId,
        context.operationRequestId,
      );
      const planningReceipt = {
        providerId: treatmentAgent.id,
        providerLabel: "joint-v1 创作规划",
        modelId: modelTraces.treatment ?? "unknown",
        transport: "unix_socket" as const,
        billing: "subscription" as const,
        configurationSource: "system_default" as const,
        parameters: {
          planningRoute: libraryRoute ? "library" : "fixed",
          ...(planningExecutionSummary ?? {}),
        },
        estimatedCostCny: 0,
        requestId: context.nextId("creative-planning"),
      };
      // 图库路线的私有库存路径必须可得（登记/复用/残留三条分支都从执行记录或本次执行恢复），
      // 缺失即 fail closed——不允许下游拿公开报告冒充库存。
      const committedCandidateInventoryPath = () => {
        if (!libraryRoute) return undefined;
        if (!candidateInventoryPath) {
          throw new Error("Joint creative planning library route lost its private candidate inventory path.");
        }
        return candidateInventoryPath;
      };
      // 正式内容只从重放后的图内产物序列化：登记与窗口 (b) 残留校验共用同一内容源，
      // 保证"崩溃前登记的产物"与"恢复重放的图产物"逐字节可比。
      const scriptContent = `${JSON.stringify(scriptDocument(screenwriterBrief(currentBrief), scriptArtifact.output), null, 2)}\n`;
      const treatmentContent = `${JSON.stringify(treatmentArtifact.output, null, 2)}\n`;
      const directorPlanContent = `${JSON.stringify(finalPlanArtifact.output, null, 2)}\n`;
      const candidateContent = libraryRoute && candidatesArtifact
        ? `${JSON.stringify(candidatesArtifact.output, null, 2)}\n`
        : undefined;
      const rankingContent = libraryRoute && rankingArtifact
        ? `${JSON.stringify(rankingArtifact.output, null, 2)}\n`
        : undefined;
      const expectedKinds = jointPlanningExpectedKinds(libraryRoute);
      const expectedFormalContents: Array<{ kind: string; content: string }> = [
        { kind: "creative_treatment", content: treatmentContent },
        { kind: "script", content: scriptContent },
        { kind: "storyboard", content: directorPlanContent },
        ...(candidateContent !== undefined ? [{ kind: "asset_candidates", content: candidateContent }] : []),
        ...(rankingContent !== undefined ? [{ kind: "asset_ranking", content: rankingContent }] : []),
      ];
      // commit key 绑定 runId、当前 inputDigest 与完成态图内产物身份（内容派生 id）：
      // 不含 attempt/路径/时间，同输入重放必然命中同 key。
      const planningCommitKey = createHash("sha256").update(JSON.stringify({
        version: PLANNING_COMMIT_VERSION,
        runId: context.runId,
        inputDigest,
        planning: {
          treatment: treatmentArtifact.artifactId,
          script: scriptArtifact.artifactId,
          directorPlan: finalPlanArtifact.artifactId,
          ...(candidateContent !== undefined && candidatesArtifact ? { candidates: candidatesArtifact.artifactId } : {}),
          ...(rankingContent !== undefined && rankingArtifact ? { ranking: rankingArtifact.artifactId } : {}),
          executablePlan: executablePlanArtifact.artifactId,
        },
      })).digest("hex");
      const planningCommitPath = path.join(runsRoot, context.runId, "planning", "commits", `${planningCommitKey}.json`);
      const committedSha256 = (kind: string) => createHash("sha256")
        .update(expectedFormalContents.find((entry) => entry.kind === kind)!.content)
        .digest("hex");

      // 已有 commit（此前已完整落定）：严格校验后原样复用，不重复登记、不重写正式文件。
      const existingCommit = await readJointPlanningCommit(planningCommitPath);
      if (existingCommit !== undefined) {
        const commitArtifactIds = isObjectRecord(existingCommit) && Array.isArray(existingCommit.artifacts)
          ? existingCommit.artifacts.flatMap((entry) => (
              isObjectRecord(entry) && typeof entry.artifactId === "string" ? [entry.artifactId] : []
            ))
          : [];
        const registeredCount = commitArtifactIds.filter((id) => context.artifacts.some((artifact) => artifact.id === id)).length;
        if (registeredCount === 0) {
          // 进程可能在 commit rename 后、run CAS 前死亡。此时 commit 只是完整的 prepared
          // 证据，不是已接受结果；核对文件后重新登记，并在本次 run CAS 中发布新的正式身份。
          await verifyOrphanedJointPlanningCommit({
            commit: existingCommit,
            planningCommitKey,
            inputDigest,
            runId: context.runId,
            runRoot: path.join(runsRoot, context.runId),
            expectedKinds,
            expectedContents: expectedFormalContents,
          });
        } else if (registeredCount !== commitArtifactIds.length) {
          // BG-02：部分登记 + 已写 commit + run CAS 前崩溃（或恢复续齐后再次崩溃）——
          // commit 里引用的产物只有一部分持久化。不在此处拒绝：落入下方 leftovers
          // 续齐分支，按重放内容补登记缺失 kind 后整组重写同一 commit。
        } else {
          const commit = await verifyJointPlanningCommit({
            commit: existingCommit,
            planningCommitKey,
            inputDigest,
            runId: context.runId,
            runRoot: path.join(runsRoot, context.runId),
            artifacts: context.artifacts,
            expectedKinds,
          });
          const committedPath = (kind: string) => {
            const entry = commit.artifacts.find((candidate) => candidate.kind === kind);
            if (!entry) throw new Error(`Joint planning commit is missing its '${kind}' entry.`);
            return entry.path;
          };
          return {
            status: "succeeded",
            output: {
              scriptPath: committedPath("script"),
              directorPlanPath: committedPath("storyboard"),
              executablePlanPath: committedPath("executable_plan"),
              canonFacts: scriptArtifact.output.canonFacts ?? [],
              ...(libraryRoute ? {
                candidateSearchPath: committedPath("asset_candidates"),
                candidateRankingPath: committedPath("asset_ranking"),
                candidateInventoryPath: committedCandidateInventoryPath(),
              } : {}),
            },
            preRegisteredArtifactIds: commit.artifacts.map((entry) => entry.artifactId),
            receipt: planningReceipt,
          };
        }
      }

      // 无 commit 但存在本 key 绑定的正式产物（窗口 (b) 及 F1 部分登记）：
      // 部分集合（文件写入失败随失败 checkpoint 持久化的半组 registry）与完整集合都可恢复：
      // 已登记产物逐 kind 按重放内容字节校验；缺失 kind 在本次受控保存内补登记；
      // 最终仍以整组 commit 一次接受——不放松完整性，也不让部分状态永久卡死。
      const leftoverArtifacts = context.artifacts.filter((artifact) =>
        artifact.producer?.nodeId === "creative-planning"
        && artifact.provenance?.producerRequestDigest === planningCommitKey);
      if (leftoverArtifacts.length > 0) {
        const leftoverByKind = new Map(leftoverArtifacts.map((artifact) => [artifact.kind, artifact]));
        const unexpectedLeftovers = leftoverArtifacts.filter((artifact) => !expectedKinds.includes(artifact.kind));
        if (unexpectedLeftovers.length > 0) {
          throw planningCommitValidationError(
            `pre-registered planning artifacts contain unexpected kinds ${JSON.stringify(unexpectedLeftovers.map((artifact) => artifact.kind))}`,
          );
        }
        const duplicatedLeftoverKinds = expectedKinds.filter((kind) => leftoverArtifacts.filter((artifact) => artifact.kind === kind).length > 1);
        if (duplicatedLeftoverKinds.length > 0) {
          throw planningCommitValidationError(`pre-registered planning artifacts duplicate kinds ${JSON.stringify(duplicatedLeftoverKinds)}`);
        }
        // 非正式方案 kind：重放内容与已登记字节必须一致，缺失即补登记（同一 attempt 目录
        // 重新写入受控文件）；executable_plan 依赖全部 id，最后统一重绑计算。
        const recoveredIds = new Map<string, string>();
        const recoveredEntries: Array<{ kind: string; artifactId: string; path: string; sha256: string }> = [];
        // 父关系按证据链：稿件←treatment(+brief/语法)；导演方案←稿件；候选←稿件+方案；排序←候选。
        const parentOf = (kind: string): string[] => {
          if (kind === "script") {
            return [recoveredIds.get("creative_treatment")!, ...briefArtifactIds, ...grammarArtifactIds];
          }
          if (kind === "storyboard") return [recoveredIds.get("script")!, ...grammarArtifactIds];
          if (kind === "asset_candidates") return [recoveredIds.get("script")!, recoveredIds.get("storyboard")!];
          if (kind === "asset_ranking") return [recoveredIds.get("asset_candidates")!];
          return [...briefArtifactIds, ...grammarArtifactIds];
        };
        const freshlyRegistered = new Set<string>();
        for (const kind of expectedKinds) {
          if (kind === "executable_plan") continue;
          const leftover = leftoverByKind.get(kind);
          const content = expectedFormalContents.find((entry) => entry.kind === kind)!.content;
          if (leftover) {
            const disk = await readFile(path.resolve(leftover.uri ?? ""), "utf8").catch(() => undefined);
            if (disk === undefined || createHash("sha256").update(disk).digest("hex") !== leftover.sha256
              || disk !== content) {
              throw planningCommitValidationError(`pre-registered '${kind}' does not match the replayed planning content`);
            }
            recoveredIds.set(kind, leftover.id);
            recoveredEntries.push({ kind, artifactId: leftover.id, path: leftover.uri!, sha256: leftover.sha256 });
            continue;
          }
          const kindPath = path.join(attempt.directory, `${kind}.json`);
          await writeTextAtomically(kindPath, content);
          const registered = context.addArtifact(fileArtifact(
            kind,
            kindPath,
            content,
            "application/json",
            kind === "creative_treatment" ? "video-factory/creative-treatment-v1"
              : kind === "script" ? "video-factory/script-draft-v1"
                : kind === "storyboard" ? "video-factory/director-plan-v1"
                  : kind === "asset_candidates" ? "video-factory/asset-candidates-v1"
                    : "video-factory/asset-ranking-v1",
            "creative-planning",
            parentOf(kind),
            // BG-02 附带修复：续齐登记的 provenance 按 kind 写真实来源，不再一律 unknown。
            kind === "creative_treatment" ? (providerTraces.treatment ?? "unknown")
              : kind === "script" ? currentBrief.providers.script
                : kind === "storyboard" ? currentDirectorProviderId
                  : kind === "asset_ranking" && rankingArtifact ? rankingArtifact.output.providerId
                    : "asset-candidate-search-v1",
            "Recovered joint planning artifact; provenance inherited from the replayed graph evidence.",
            attempt.attempt,
            planningCommitKey,
          ));
          freshlyRegistered.add(kind);
          recoveredIds.set(kind, registered.id);
          recoveredEntries.push({ kind, artifactId: registered.id, path: kindPath, sha256: createHash("sha256").update(content).digest("hex") });
        }
        // 已登记残留产物的父关系必须符合证据链：缺失说明它来自不同证据链，fail closed。
        for (const entry of recoveredEntries) {
          if (entry.kind === "executable_plan" || freshlyRegistered.has(entry.kind)) continue;
          const artifact = context.artifacts.find((candidate) => candidate.id === entry.artifactId)!;
          const expectedParents = parentOf(entry.kind);
          const missingParents = expectedParents.filter((parentId) => !(artifact.parentArtifactIds ?? []).includes(parentId));
          if (missingParents.length > 0) {
            throw planningCommitValidationError(
              `pre-registered '${entry.kind}' is missing expected parent links ${JSON.stringify(missingParents)}`,
            );
          }
        }
        const recoveredPlanContent = `${JSON.stringify(parseExecutableProductionPlan({
          ...executablePlanArtifact.output,
          treatmentArtifactId: recoveredIds.get("creative_treatment")!,
          scriptArtifactId: recoveredIds.get("script")!,
          directorArtifactId: recoveredIds.get("storyboard")!,
          candidateArtifactIds: libraryRoute
            ? [recoveredIds.get("asset_candidates")!, recoveredIds.get("asset_ranking")!]
            : [],
        }), null, 2)}\n`;
        const planLeftover = leftoverByKind.get("executable_plan");
        let planEntry: { kind: string; artifactId: string; path: string; sha256: string };
        if (planLeftover) {
          const disk = await readFile(path.resolve(runsRoot, context.runId, planLeftover.uri ?? ""), "utf8").catch(() => undefined);
          if (disk === undefined || disk !== recoveredPlanContent
            || createHash("sha256").update(disk).digest("hex") !== planLeftover.sha256) {
            throw planningCommitValidationError("pre-registered 'executable_plan' does not match the replayed planning content");
          }
          planEntry = { kind: "executable_plan", artifactId: planLeftover.id, path: planLeftover.uri!, sha256: planLeftover.sha256 };
        } else {
          const executablePlanContent = recoveredPlanContent;
          const executablePlanPath = path.join(attempt.directory, "executable_plan.json");
          await writeTextAtomically(executablePlanPath, executablePlanContent);
          const registered = context.addArtifact(fileArtifact(
            "executable_plan",
            executablePlanPath,
            executablePlanContent,
            "application/json",
            "video-factory/executable-plan-v1",
            "creative-planning",
            expectedKinds.filter((kind) => kind !== "executable_plan").map((kind) => recoveredIds.get(kind)!),
            "video-factory-ts-v1",
            "Deterministically compiled production timing and source references.",
            attempt.attempt,
            planningCommitKey,
          ));
          planEntry = { kind: "executable_plan", artifactId: registered.id, path: executablePlanPath, sha256: createHash("sha256").update(executablePlanContent).digest("hex") };
        }
        const committedEntries = [...recoveredEntries, planEntry];
        const reusedPath = (kind: string) => {
          const entry = committedEntries.find((candidate) => candidate.kind === kind);
          if (!entry) throw new Error(`Joint planning recovery is missing its '${kind}' entry.`);
          return entry.path;
        };
        await writeJointPlanningCommit(planningCommitPath, {
          version: PLANNING_COMMIT_VERSION,
          runId: context.runId,
          planningCommitKey,
          inputDigest,
          artifacts: committedEntries,
        });
        return {
          status: "succeeded",
          output: {
            scriptPath: reusedPath("script"),
            directorPlanPath: reusedPath("storyboard"),
            executablePlanPath: reusedPath("executable_plan"),
            canonFacts: scriptArtifact.output.canonFacts ?? [],
            ...(libraryRoute ? {
              candidateSearchPath: reusedPath("asset_candidates"),
              candidateRankingPath: reusedPath("asset_ranking"),
              candidateInventoryPath: committedCandidateInventoryPath(),
            } : {}),
          },
          preRegisteredArtifactIds: committedEntries.map((entry) => entry.artifactId),
          receipt: planningReceipt,
        };
      }

      // 全新登记：正式产物登记顺序即证据链：稿件 ← brief(+语法)；导演方案 ← 稿件(+语法)；
      // 候选 ← 稿件+方案；排序 ← 候选；可执行方案 ← 前述全部。provenance 绑定 commit key，
      // 供窗口 (b) 恢复发现与 commit 身份校验使用。
      // F1 残留收口：除可执行方案（内容依赖登记 id）外的全部文件先落盘——任何写入失败都
      // 发生在"零登记"状态；登记段本身不再夹带可失败的文件 I/O，部分 registry 只可能由
      // 进程死亡产生，而 leftovers 恢复分支对部分集合可续齐（见下）。
      const treatmentPath = path.join(attempt.directory, "creative_treatment.json");
      const scriptPath = path.join(attempt.directory, "script.json");
      const directorPlanPath = path.join(attempt.directory, "director_plan.json");
      const candidateSearchPath = path.join(attempt.directory, "candidate_search.json");
      const candidateRankingPath = path.join(attempt.directory, "candidate_ranking.json");
      await writeTextAtomically(treatmentPath, treatmentContent);
      await writeTextAtomically(scriptPath, scriptContent);
      await writeTextAtomically(directorPlanPath, directorPlanContent);
      const willRegisterCandidates = candidateContent !== undefined && rankingContent !== undefined && candidatesArtifact && rankingArtifact;
      if (willRegisterCandidates) {
        await writeTextAtomically(candidateSearchPath, candidateContent!);
        await writeTextAtomically(candidateRankingPath, rankingContent!);
      }
      const registeredTreatment = context.addArtifact(fileArtifact(
        "creative_treatment",
        treatmentPath,
        treatmentContent,
        "application/json",
        "video-factory/creative-treatment-v1",
        "creative-planning",
        [...briefArtifactIds, ...grammarArtifactIds],
        // provider 与 model 分离：正式 provenance 记录实际执行 provider（含 fallback 后的
        // 真实来源）；缺失时显式 unknown，不把模型字符串或首选配置写进 provider 命名空间。
        providerTraces.treatment ?? "unknown",
        "Accepted creative treatment for this production plan.",
        attempt.attempt,
        planningCommitKey,
      ));
      const registeredScript = context.addArtifact(fileArtifact(
        "script",
        scriptPath,
        scriptContent,
        "application/json",
        "video-factory/script-draft-v1",
        "creative-planning",
        [registeredTreatment.id, ...briefArtifactIds, ...grammarArtifactIds],
        currentBrief.providers.script,
        "AI-generated script; facts and claims require human review before publication.",
        attempt.attempt,
        planningCommitKey,
      ));
      const registeredDirectorPlan = context.addArtifact(fileArtifact(
        "storyboard",
        directorPlanPath,
        directorPlanContent,
        "application/json",
        "video-factory/director-plan-v1",
        "creative-planning",
        [registeredScript.id, ...grammarArtifactIds],
        currentDirectorProviderId,
        "AI-generated director plan; source choices and factual framing require review.",
        attempt.attempt,
        planningCommitKey,
      ));
      const planningEvidenceParentIds = [registeredTreatment.id, registeredScript.id, registeredDirectorPlan.id];
      const committedCandidateIds: string[] = [];
      let candidatePaths: { candidateSearchPath: string; candidateRankingPath: string } | undefined;
      if (willRegisterCandidates) {
        const registeredCandidates = context.addArtifact(fileArtifact(
          "asset_candidates",
          candidateSearchPath,
          candidateContent!,
          "application/json",
          "video-factory/asset-candidates-v1",
          "creative-planning",
          [registeredScript.id, registeredDirectorPlan.id],
          "asset-candidate-search-v1",
          "Preview-only candidate metadata; no source media was downloaded by this node.",
          attempt.attempt,
          planningCommitKey,
        ));
        const registeredRanking = context.addArtifact(fileArtifact(
          "asset_ranking",
          candidateRankingPath,
          rankingContent!,
          "application/json",
          "video-factory/asset-ranking-v1",
          "creative-planning",
          [registeredCandidates.id],
          rankingArtifact!.output.providerId,
          "Candidate ranking only; no source media was downloaded or altered.",
          attempt.attempt,
          planningCommitKey,
        ));
        planningEvidenceParentIds.push(registeredCandidates.id, registeredRanking.id);
        committedCandidateIds.push(registeredCandidates.id, registeredRanking.id);
        candidatePaths = { candidateSearchPath, candidateRankingPath };
      }
      const reboundExecutablePlan = parseExecutableProductionPlan({
        ...executablePlanArtifact.output,
        treatmentArtifactId: registeredTreatment.id,
        scriptArtifactId: registeredScript.id,
        directorArtifactId: registeredDirectorPlan.id,
        candidateArtifactIds: committedCandidateIds,
      });
      const executablePlanContent = `${JSON.stringify(reboundExecutablePlan, null, 2)}\n`;
      const executablePlanPath = path.join(attempt.directory, "executable_plan.json");
      await writeTextAtomically(executablePlanPath, executablePlanContent);
      const registeredExecutablePlan = context.addArtifact(fileArtifact(
        "executable_plan",
        executablePlanPath,
        executablePlanContent,
        "application/json",
        "video-factory/executable-plan-v1",
        "creative-planning",
        planningEvidenceParentIds,
        "video-factory-ts-v1",
        "Deterministically compiled production timing and source references.",
        attempt.attempt,
        planningCommitKey,
      ));
      options.planningFailpoints?.afterArtifacts?.();
      // 全部正式产物已登记、commit 结束标记尚未写——afterArtifacts 崩溃窗口在此之后收口。
      await writeJointPlanningCommit(planningCommitPath, {
        version: PLANNING_COMMIT_VERSION,
        runId: context.runId,
        planningCommitKey,
        inputDigest,
        artifacts: [
          { kind: "creative_treatment", artifactId: registeredTreatment.id, path: treatmentPath, sha256: createHash("sha256").update(treatmentContent).digest("hex") },
          { kind: "script", artifactId: registeredScript.id, path: scriptPath, sha256: committedSha256("script") },
          { kind: "storyboard", artifactId: registeredDirectorPlan.id, path: directorPlanPath, sha256: committedSha256("storyboard") },
          ...(candidatePaths ? [
            { kind: "asset_candidates", artifactId: context.artifacts.find((artifact) => artifact.id
              && artifact.kind === "asset_candidates"
              && artifact.provenance?.producerRequestDigest === planningCommitKey
              && artifact.uri === candidatePaths.candidateSearchPath)!.id, path: candidatePaths.candidateSearchPath, sha256: committedSha256("asset_candidates") },
            { kind: "asset_ranking", artifactId: context.artifacts.find((artifact) =>
              artifact.kind === "asset_ranking"
              && artifact.provenance?.producerRequestDigest === planningCommitKey
              && artifact.uri === candidatePaths.candidateRankingPath)!.id, path: candidatePaths.candidateRankingPath, sha256: committedSha256("asset_ranking") },
          ] : []),
          { kind: "executable_plan", artifactId: registeredExecutablePlan.id, path: executablePlanPath, sha256: createHash("sha256").update(executablePlanContent).digest("hex") },
        ],
      });
      // commit 已写、run CAS 尚未保存：外部 commit 只是 prepared 证据，不是已接受结果。
      options.planningFailpoints?.afterCommit?.();
      return {
        status: "succeeded",
          output: {
            scriptPath,
            directorPlanPath,
            executablePlanPath,
            canonFacts: scriptArtifact.output.canonFacts ?? [],
            ...(creativeReviewResume ? {
              creativeReviewOperation: {
                commandId: creativeReviewResume.commandId,
                action: creativeReviewResume.action,
                status: "completed",
              },
            } : {}),
          ...(candidatePaths ? { ...candidatePaths, candidateInventoryPath: committedCandidateInventoryPath() } : {}),
        },
        preRegisteredArtifactIds: [
          registeredTreatment.id,
          registeredScript.id,
          registeredDirectorPlan.id,
          ...(candidatePaths ? [
            context.artifacts.find((artifact) =>
              artifact.kind === "asset_candidates"
              && artifact.provenance?.producerRequestDigest === planningCommitKey
              && artifact.uri === candidatePaths.candidateSearchPath)!.id,
            context.artifacts.find((artifact) =>
              artifact.kind === "asset_ranking"
              && artifact.provenance?.producerRequestDigest === planningCommitKey
              && artifact.uri === candidatePaths.candidateRankingPath)!.id,
          ] : []),
          registeredExecutablePlan.id,
        ],
        receipt: planningReceipt,
      };
    },
    validateOverride: (output) => validateJointPlanningOutput(output, libraryRoute),
  };
}

function directorNode(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  runsRoot: string,
  withSourceRunSnapshot: SourceRunSnapshot,
): NodeDefinition {
  const direction = brief.director;
  const providerId = brief.providers.director;
  if (!direction || !providerId) throw new Error("AI director configuration is incomplete.");
  return {
    id: "visual-direction",
    label: "Direct visual plan",
    role: "导演",
    capability: "storyboard.plan",
    providerId,
    mode: "automatic",
    dependsOn: [brief.workflowFeatures?.referenceGrammar ? "reference-grammar" : "script"],
    getInput: (context) => ({
      scriptPath: outputPath(context, "script", "scriptPath"),
      ...(brief.workflowFeatures?.referenceGrammar ? { referenceGrammarPath: outputPath(context, "reference-grammar", "referenceGrammarPath") } : {}),
    }),
    validateInputOverride: (input) => ({
      scriptPath: requiredOutputString(input, "scriptPath"),
      ...(brief.workflowFeatures?.referenceGrammar ? { referenceGrammarPath: requiredOutputString(input, "referenceGrammarPath") } : {}),
    }),
    execute: async (input, context) => {
      const currentBrief = currentEffectiveBriefFromContext(context, brief);
      const currentDirection = currentBrief.director;
      if (!currentDirection) throw new Error("AI director configuration is incomplete.");
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "visual-direction"));
      const scriptPath = requiredOutputString(input, "scriptPath");
      const script = JSON.parse(await readFile(scriptPath, "utf8")) as { viewerPromise?: unknown; narrativeArc?: unknown; scenes?: unknown };
      const viewerPromise = optionalOutputString(script.viewerPromise);
      const narrativeArc = optionalOutputString(script.narrativeArc);
      const referenceGrammar: ShotGrammar | undefined = brief.workflowFeatures?.referenceGrammar
        ? await readShotGrammarFile(requiredOutputString(input, "referenceGrammarPath"))
        : undefined;
      const scenes = parseDirectorScenes(script.scenes);
      const catalog = new Map((options.assetProviders ?? []).map((provider) => [provider.id, provider]));
      const assetProviders = currentDirection.assetProviderIds.map((id) => {
        const provider = catalog.get(id);
        if (!provider) throw new Error(`Asset provider '${id}' is not available to the AI director.`);
        const selectedVideoModel = selectedVideoModelRuntime(
          currentBrief,
          provider.id,
          options.providerRuntimeMetadata ?? [],
        );
        return {
          id: provider.id,
          label: provider.label,
          billing: provider.billing,
          modes: [...provider.modes],
          deliveryTypes: [...provider.deliveryTypes],
          supportsReferenceImage: provider.supportsReferenceImage ?? false,
          strengths: [...(provider.strengths ?? provider.modes)],
          constraints: [...(provider.constraints ?? [])],
          estimatedCnyPerClip: provider.estimatedCnyPerClip ?? 0,
          ...(selectedVideoModel ? {
            selectedModelId: selectedVideoModel.modelId,
            minDurationSeconds: selectedVideoModel.minDurationSeconds,
            maxDurationSeconds: selectedVideoModel.maxDurationSeconds,
            ...(selectedVideoModel.aspectRatios ? { aspectRatios: [...selectedVideoModel.aspectRatios] } : {}),
          } : {}),
        };
      });
      const provider = context.resolveProvider<VisualDirectorAgentInput, CodexTaskExecution<unknown>>({
        capability: "storyboard.plan",
        providerId,
      });
      const costFeedback = currentBrief.spendFeedback?.slice(-10).reverse().map((feedback) => ({
        reason: feedback.reason,
        previousEstimatedCostCny: feedback.previousEstimatedCostCny,
        ...(feedback.targetEstimatedCostCny !== undefined
          ? { targetEstimatedCostCny: feedback.targetEstimatedCostCny }
          : {}),
        ...(feedback.note ? { note: feedback.note } : {}),
      }));
      const directorEconomics = { allowMeteredProviders: currentBrief.economics.allowMeteredProviders };
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && ["script", "reference-grammar"].includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      let execution: CodexTaskExecution<unknown>;
      const affectedScenePositions = currentBrief.rework
        ? reworkAffectedScenePositions({
          findings: currentBrief.rework.findings,
          ...(currentBrief.rework.previousScript ? { previousScenes: currentBrief.rework.previousScript.scenes } : {}),
          ...(currentBrief.rework.previousDirectorPlan ? { previousShots: currentBrief.rework.previousDirectorPlan.shots } : {}),
          currentScenes: script.scenes,
          ...(currentBrief.rework.affectedScenePositions !== undefined
            ? { affectedScenePositions: currentBrief.rework.affectedScenePositions }
            : {}),
        })
        : [];
      const producerBrief: VisualDirectorAgentInput["brief"] = {
        title: currentBrief.title,
        angle: currentBrief.angle,
        audience: currentBrief.audience,
        platform: currentBrief.platform,
        durationSeconds: currentBrief.durationSeconds,
        ...(currentBrief.durationRange ? { durationRange: currentBrief.durationRange } : {}),
        ...(viewerPromise ? { viewerPromise } : {}),
        ...(narrativeArc ? { narrativeArc } : {}),
        requestedProfileId: currentDirection.profileId,
        ...(currentBrief.editorial ? { editorial: currentBrief.editorial } : {}),
        ...(currentBrief.visualProof ? { visualProof: currentBrief.visualProof } : {}),
        ...(currentBrief.visualIntent ? { visualIntent: currentBrief.visualIntent } : {}),
        ...(currentBrief.visualPlan ? { visualPlan: currentBrief.visualPlan } : {}),
        voiceTiming: voiceTimingFor(currentBrief),
        productionCapabilities: summarizeProductionCapabilities(assetProviders, currentBrief.providers.voice),
        ...(referenceGrammar ? { referenceGrammar } : {}),
        ...(currentBrief.seriesContext ? { seriesContext: currentBrief.seriesContext } : {}),
        ...(currentBrief.rework ? {
          rework: {
            sourceRunId: currentBrief.rework.sourceRunId,
            visualDirectionInstruction: currentBrief.rework.nodeInstructions.visualDirection,
            assetInstruction: currentBrief.rework.nodeInstructions.assets,
            findings: currentBrief.rework.findings
              .filter((finding) => finding.targetNodeIds.includes("visual-direction") && finding.action !== "inspect_existing_media")
              .map(modelFacingReworkFinding),
            ...(affectedScenePositions.length || currentBrief.rework.affectedScenePositions !== undefined
              ? { affectedScenePositions }
              : {}),
            ...(currentBrief.rework.previousDirectorPlan ? { previousDirectorPlan: currentBrief.rework.previousDirectorPlan } : {}),
          },
        } : {}),
      };
      const producerInput: VisualDirectorAgentInput = {
        brief: producerBrief,
        scenes,
        assetProviders,
        economics: directorEconomics,
        selectedModelId: provider.modelId ?? "codex-default",
        ...(costFeedback?.length ? { costFeedback } : {}),
      };
      const producerIdentity = producerRequestIdentity(DIRECTOR_PRODUCER_REQUEST_SCHEMA_VERSION, {
        contractVersion: VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
        promptPack: "video-factory/director-v29",
        request: {
          ...producerInput,
          brief: producerBriefWithoutRework(producerInput.brief),
          scenes: producerInput.scenes.map(directorSceneProducerIdentity),
        },
      });
      const inherited = await inheritUnchangedReworkDirector({
        brief: currentBrief,
        context,
        runsRoot,
        attemptDirectory: attempt.directory,
        attempt: attempt.attempt,
        agent: options.directorAgent,
        scriptPath,
        producerIdentity,
        withSourceRunSnapshot,
        planValidation: visualDirectorPlanValidation(
          currentBrief,
          scenes,
          options.assetProviders ?? [],
          options.providerRuntimeMetadata ?? [],
          viewerPromise,
        ),
      });
      if (inherited) return inherited;
      try {
        execution = await provider.run({
          ...producerInput,
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-direction",
            { brief: currentBrief, scenes, assetProviders, economics: directorEconomics, ...(costFeedback?.length ? { costFeedback } : {}), ...(referenceGrammar ? { referenceGrammar } : {}) },
            VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
            undefined,
            context.operationRequestId,
          ),
          agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-direction",
            { brief: currentBrief, scenes, assetProviders, economics: directorEconomics, ...(costFeedback?.length ? { costFeedback } : {}), ...(referenceGrammar ? { referenceGrammar } : {}) },
            VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
            modelId,
            context.operationRequestId,
          ),
        }, context);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          return failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "visual-direction",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: "Codex 视觉导演",
          });
        }
        if (error instanceof ModelCandidatesExhaustedError) {
          return failedModelCandidatesNodeResult({
            error,
            taskKind: "director-plan",
            attemptDirectory: attempt.directory,
            nodeId: "visual-direction",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: "Codex 视觉导演",
          });
        }
        throw error;
      }
      const plan = validateVisualDirectorPlan(
        execution.output,
        visualDirectorPlanValidation(
          currentBrief,
          scenes,
          options.assetProviders ?? [],
          options.providerRuntimeMetadata ?? [],
          viewerPromise,
        ),
      );
      const planPath = path.join(attempt.directory, "director_plan.json");
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      await writeTextAtomically(planPath, content);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "visual-direction",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: execution.agentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "visual-direction",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: { directorPlanPath: planPath },
        receipt: producerRequestReceipt(
          provider,
          execution,
          "Codex 视觉导演",
          producerIdentity,
        ),
        artifacts: [withProducerRequestIdentity(fileArtifact(
          "storyboard",
          planPath,
          content,
          "application/json",
          "video-factory/director-plan-v1",
          "visual-direction",
          parentArtifactIds,
          providerId,
          "AI-generated director plan; source choices and factual framing require review.",
          attempt.attempt,
        ), producerIdentity), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
      };
    },
    validateOverride: (output) => validatePathOutput(output, "directorPlanPath", "visual-direction"),
  };
}

async function inheritUnchangedReworkDirector(options: {
  brief: ProductionBrief;
  context: WorkflowContext;
  runsRoot: string;
  attemptDirectory: string;
  attempt: number;
  agent: VisualDirectorAgent | undefined;
  scriptPath: string;
  producerIdentity: ProducerRequestIdentity;
  withSourceRunSnapshot: SourceRunSnapshot;
  planValidation: Parameters<typeof validateVisualDirectorPlan>[1];
}): Promise<NodeExecutionResult<Record<string, unknown>> | undefined> {
  const rework = options.brief.rework;
  if (!rework
    || !rework.previousDirectorPlan
    || options.brief.workflowFeatures?.referenceGrammar
    || rework.findings.some((finding) => (
      finding.targetNodeIds.includes("visual-direction")
      && finding.action !== "inspect_existing_media"
  ))) {
    return undefined;
  }
  try {
    return await options.withSourceRunSnapshot(rework.sourceRunId, async () => {
  let sourceRun: WorkflowRun<ProductionBrief>;
  try {
    sourceRun = JSON.parse(await readFile(
      path.join(options.runsRoot, rework.sourceRunId, "run.json"),
      "utf8",
    )) as WorkflowRun<ProductionBrief>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (sourceRun.revision !== rework.sourceRunRevision) return undefined;
  const sourceNode = sourceRun.nodeRuns.find((node) => node.nodeId === "visual-direction");
  const sourceExecution = effectiveNodeExecutionInput(sourceNode);
  if (!sourceExecution) return undefined;
  let sourceBrief: ProductionBrief;
  try {
    sourceBrief = effectiveProductionBrief(sourceRun);
  } catch {
    return undefined;
  }
  if (!isDeepStrictEqual(directorReuseIdentity(options.brief), directorReuseIdentity(sourceBrief))) return undefined;

  const currentModelId = options.brief.models?.[options.brief.providers.director!]
    ?? options.agent?.modelId
    ?? "codex-default";
  if (sourceNode?.status !== "succeeded"
    || sourceNode.outputState?.stale === true
    || sourceNode.executionReceipt?.modelId !== currentModelId
    || sourceNode.executionReceipt?.parameters?.promptPack !== "video-factory/director-v29"
    || sourceNode.executionReceipt?.parameters?.producerRequestSchemaVersion !== options.producerIdentity.schemaVersion
    || sourceNode.executionReceipt?.parameters?.producerRequestDigest !== options.producerIdentity.digest) {
    return undefined;
  }
  let sourceDirectorPlanPath: string;
  try {
    sourceDirectorPlanPath = requiredOutputString(
      requireOutputRecord(sourceExecution.output, "source visual-direction output"),
      "directorPlanPath",
    );
  } catch {
    return undefined;
  }
  const sourceArtifacts = sourceExecution.artifactIds
    .map((id) => sourceRun.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => (
      artifact?.kind === "storyboard"
      && artifact.producer?.nodeId === "visual-direction"
      && artifact.uri !== undefined
      && path.resolve(artifact.uri) === path.resolve(sourceDirectorPlanPath)
    ));
  if (sourceArtifacts.length !== 1) return undefined;
  const sourceArtifact = sourceArtifacts[0]!;
  let sourceScriptPath: string;
  try {
    sourceScriptPath = requiredOutputString(
      requireOutputRecord(sourceExecution.input, "source visual-direction input"),
      "scriptPath",
    );
  } catch {
    return undefined;
  }
  const sourceScriptArtifacts = sourceRun.artifacts.filter((artifact) => (
    artifact.producer?.nodeId === "script"
    && sourceArtifact?.parentArtifactIds?.includes(artifact.id)
    && artifact.uri !== undefined
    && path.resolve(artifact.uri) === path.resolve(sourceScriptPath)
  ));
  const currentScriptArtifacts = options.context.artifacts.filter((artifact) => (
    artifact.producer?.nodeId === "script"
    && artifact.uri !== undefined
    && path.resolve(artifact.uri) === path.resolve(options.scriptPath)
  ));
  if (sourceScriptArtifacts.length !== 1 || currentScriptArtifacts.length !== 1) return undefined;
  const sourceScriptArtifact = sourceScriptArtifacts[0]!;
  const currentScriptArtifact = currentScriptArtifacts[0]!;
  if (!sourceArtifact?.uri
    || sourceArtifact.schemaVersion !== "video-factory/director-plan-v1"
    || sourceArtifact.contentType !== "application/json"
    || !sourceArtifact.sha256
    || sourceArtifact.sizeBytes === undefined
    || sourceArtifact.provenance.producerRequestSchemaVersion !== options.producerIdentity.schemaVersion
    || sourceArtifact.provenance.producerRequestDigest !== options.producerIdentity.digest
    || !sourceScriptArtifact?.uri
    || !sourceScriptArtifact.sha256
    || sourceScriptArtifact.sizeBytes === undefined
    || path.resolve(sourceScriptArtifact.uri) !== path.resolve(sourceScriptPath)
    || !currentScriptArtifact?.uri
    || !currentScriptArtifact.sha256
    || currentScriptArtifact.sizeBytes === undefined) {
    return undefined;
  }
  try {
    await verifyStoredArtifactWithinRoot(path.join(options.runsRoot, rework.sourceRunId), sourceArtifact);
    await verifyStoredArtifactWithinRoot(path.join(options.runsRoot, rework.sourceRunId), sourceScriptArtifact);
    await verifyStoredArtifactWithinRoot(path.join(options.runsRoot, options.context.runId), currentScriptArtifact);
    const sourceScript = requireOutputRecord(JSON.parse(await readFile(sourceScriptArtifact.uri, "utf8")), "source director script");
    const currentScript = requireOutputRecord(JSON.parse(await readFile(currentScriptArtifact.uri, "utf8")), "current director script");
    if (!isDeepStrictEqual(directorScriptReuseIdentity(sourceScript), directorScriptReuseIdentity(currentScript))) return undefined;
    const document = requireOutputRecord(JSON.parse(await readFile(sourceArtifact.uri, "utf8")), "source director plan");
    if (!isDeepStrictEqual(document, rework.previousDirectorPlan)) return undefined;
    validateVisualDirectorPlan(document, options.planValidation);
  } catch {
    return undefined;
  }
  const directorPlanPath = path.join(options.attemptDirectory, "director_plan.json");
  try {
    await copyFile(sourceArtifact.uri, directorPlanPath);
    await verifyArtifactBytes(directorPlanPath, sourceArtifact.sha256, sourceArtifact.sizeBytes);
  } catch {
    await rm(directorPlanPath, { force: true });
    return undefined;
  }
  return {
    status: "succeeded",
    output: { directorPlanPath },
    artifacts: [{
      kind: sourceArtifact.kind,
      uri: directorPlanPath,
      sha256: sourceArtifact.sha256,
      sizeBytes: sourceArtifact.sizeBytes,
      contentType: sourceArtifact.contentType,
      schemaVersion: sourceArtifact.schemaVersion,
      parentArtifactIds: [currentScriptArtifact.id],
      provenance: {
        ...sourceArtifact.provenance,
        notes: `Inherited unchanged from ${rework.sourceRunId} artifact ${sourceArtifact.id}.`,
      },
      producer: { nodeId: "visual-direction", attempt: options.attempt },
    }],
  };
    });
  } catch (error) {
    if (error instanceof RunLockedError) return undefined;
    throw error;
  }
}

function effectiveNodeExecutionInput(
  node: NodeRun | undefined,
): { input: unknown; output: unknown; artifactIds: string[] } | undefined {
  if (!node?.inputState || node.inputState.stale || !node.outputState || node.outputState.stale) return undefined;
  const inputVersion = node.inputState.versions.find(
    (version) => version.id === node.inputState?.effectiveVersionId,
  );
  const outputVersion = node.outputState.versions.find(
    (version) => version.id === node.outputState?.effectiveVersionId,
  );
  if (!inputVersion || !outputVersion?.inputVersionIds.includes(inputVersion.id)) return undefined;
  return { input: inputVersion.value, output: outputVersion.output, artifactIds: outputVersion.artifactIds };
}

function producerRequestIdentity(schemaVersion: string, value: unknown): ProducerRequestIdentity {
  return {
    schemaVersion,
    digest: createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex"),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function withProducerRequestIdentity(
  artifact: ArtifactDraft,
  identity: ProducerRequestIdentity,
): ArtifactDraft {
  return {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      producerRequestDigest: identity.digest,
      producerRequestSchemaVersion: identity.schemaVersion,
    },
  };
}

function receiptWithProducerRequestIdentity(
  receipt: NodeExecutionReceiptDraft,
  identity: ProducerRequestIdentity,
): NodeExecutionReceiptDraft {
  return {
    ...receipt,
    parameters: {
      ...(receipt.parameters ?? {}),
      producerRequestDigest: identity.digest,
      producerRequestSchemaVersion: identity.schemaVersion,
    },
  };
}

function producerRequestReceipt(
  provider: Pick<Provider, "id" | "label" | "modelId" | "transport" | "billing" | "configurationSource" | "parameters">,
  execution: Pick<CodexTaskExecution<unknown>, "trace" | "agentLoop">,
  providerLabel: string,
  identity: ProducerRequestIdentity,
): NodeExecutionReceiptDraft {
  const receipt = execution.trace
    ? modelTraceReceipt(
      execution.trace,
      providerLabel,
      "subscription",
      execution.agentLoop,
      provider.configurationSource,
    )
    : {
      providerId: provider.id,
      providerLabel: provider.label ?? providerLabel,
      modelId: provider.modelId ?? "unspecified",
      transport: provider.transport ?? "local_process",
      billing: provider.billing ?? "subscription",
      ...(provider.configurationSource ? { configurationSource: provider.configurationSource } : {}),
      ...(provider.parameters ? { parameters: { ...provider.parameters } } : {}),
    };
  return receiptWithProducerRequestIdentity(receipt, identity);
}

function producerBriefWithoutRework(
  brief: VisualDirectorAgentInput["brief"],
): Omit<VisualDirectorAgentInput["brief"], "rework"> {
  const { rework: _rework, ...producerBrief } = brief;
  return producerBrief;
}

function directorSceneProducerIdentity(
  scene: VisualDirectorAgentInput["scenes"][number],
): Record<string, unknown> {
  return {
    position: scene.position,
    ...(scene.purpose ? { purpose: scene.purpose } : {}),
    duration: scene.duration,
    visualPrompt: scene.visualPrompt,
    visualStrategy: scene.visualStrategy,
    visibleAction: scene.visibleAction,
    ...(scene.onScreenText ? { onScreenText: scene.onScreenText } : {}),
    successCriteria: scene.successCriteria,
    failureConditions: scene.failureConditions,
    searchTerms: scene.searchTerms,
  };
}

function directorScriptReuseIdentity(script: Record<string, unknown>): Record<string, unknown> {
  const scenes = parseDirectorScenes(script.scenes).map((scene) => ({
    position: scene.position,
    ...(scene.purpose ? { purpose: scene.purpose } : {}),
    duration: scene.duration,
    visualPrompt: scene.visualPrompt,
    visualStrategy: scene.visualStrategy,
    visibleAction: scene.visibleAction,
    ...(scene.onScreenText ? { onScreenText: scene.onScreenText } : {}),
    successCriteria: scene.successCriteria,
    failureConditions: scene.failureConditions,
    searchTerms: scene.searchTerms,
  }));
  return {
    viewerPromise: optionalOutputString(script.viewerPromise),
    narrativeArc: optionalOutputString(script.narrativeArc),
    scenes,
  };
}

function directorReuseIdentity(brief: ProductionBrief): Record<string, unknown> {
  const providerIds = brief.director?.assetProviderIds ?? [];
  return {
    title: brief.title,
    angle: brief.angle,
    audience: brief.audience,
    platform: brief.platform,
    durationSeconds: brief.durationSeconds,
    durationRange: brief.durationRange,
    editorial: brief.editorial,
    visualProof: brief.visualProof,
    visualIntent: brief.visualIntent,
    visualPlan: brief.visualPlan,
    seriesContext: brief.seriesContext,
    direction: brief.director,
    allowMeteredProviders: brief.economics.allowMeteredProviders,
    directorProviderId: brief.providers.director,
    modelSelections: Object.fromEntries(
      [brief.providers.director, ...providerIds]
        .filter((providerId): providerId is string => Boolean(providerId))
        .map((providerId) => [providerId, brief.models?.[providerId]]),
    ),
  };
}

async function readShotGrammarFile(grammarPath: string): Promise<ShotGrammar> {
  const value = JSON.parse(await readFile(grammarPath, "utf8")) as unknown;
  const record = requireOutputRecord(value, "shot grammar");
  const durationMs = record.durationMs;
  if (!Number.isInteger(durationMs) || Number(durationMs) <= 0) throw new Error("Shot grammar durationMs is invalid.");
  return validateShotGrammar(value, Number(durationMs));
}

// codex 编剧节点：输出与 worker 模板同契约的 script.json，下游节点无任何特判。
// 节点层对 agent 返回的 unknown 独立做 validateScriptDraft 硬校验，注入的 agent 无法绕过；
// 校验或 agent 失败即节点失败，绝不回退到本地模板。
function screenwriterNode(
  brief: ProductionBrief,
  agent: ScreenwriterAgent | undefined,
  options: ProductionPipelineOptions,
  runsRoot: string,
  withSourceRunSnapshot: SourceRunSnapshot,
  allowUnavailableProvider = false,
): NodeDefinition {
  const providerId = brief.providers.script;
  if (providerId !== "codex-screenwriter-v1" || (!agent && !allowUnavailableProvider)) {
    throw new Error(`Script provider '${providerId}' is not configured.`);
  }
  return {
    id: "script",
    label: "Draft script",
    role: "编剧",
    capability: "script.draft",
    providerId,
    mode: "automatic",
    dependsOn: ["brief"],
    getInput: (context) => {
      const currentBrief = currentEffectiveBriefFromContext(context, brief);
      return {
        brief: screenwriterBrief(currentBrief, options),
        ...(currentBrief.models?.[providerId] ? { selectedModelId: currentBrief.models[providerId] } : {}),
      };
    },
    validateInputOverride: (input) => validateScreenwriterInput(input),
    execute: async (input, context) => {
      const request = validateScreenwriterInput(input);
      const producerBrief = { ...request.brief };
      delete producerBrief.rework;
      const producerIdentity = producerRequestIdentity(SCREENWRITER_PRODUCER_REQUEST_SCHEMA_VERSION, {
        contractVersion: SCREENWRITER_AGENT_CONTRACT_VERSION,
        promptPack: "video-factory/screenwriter-v18",
        request: {
          brief: producerBrief,
          selectedModelId: request.selectedModelId ?? agent?.modelId ?? "codex-default",
        },
      });
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "script"));
      const inherited = await inheritUnchangedReworkScript({
        productionRework: currentEffectiveBriefFromContext(context, brief).rework,
        request,
        context,
        runsRoot,
        attemptDirectory: attempt.directory,
        attempt: attempt.attempt,
        agent,
        producerIdentity,
        withSourceRunSnapshot,
      });
      if (inherited) return inherited;
      const provider = context.resolveProvider<ScreenwriterAgentInput, CodexTaskExecution<unknown>>({
        capability: "script.draft",
        providerId,
      });
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "brief")
        .map((artifact) => artifact.id);
      let execution: CodexTaskExecution<unknown>;
      try {
        execution = await provider.run({
          ...request,
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "script",
            request,
            SCREENWRITER_AGENT_CONTRACT_VERSION,
            undefined,
            context.operationRequestId,
          ),
          agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "script",
            request,
            SCREENWRITER_AGENT_CONTRACT_VERSION,
            modelId,
            context.operationRequestId,
          ),
        }, context);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          const rejectedDraft = lastAgentLoopCandidate(error, (value) => validateScriptDraft(value, {
            durationSeconds: request.brief.durationSeconds,
            ...(request.brief.durationRange ? { durationRange: request.brief.durationRange } : {}),
            requireCanonFacts: Boolean(request.brief.seriesContext),
          }));
          const preserved = rejectedDraft
            ? await persistRejectedScriptDraft({
                draft: rejectedDraft,
                brief: request.brief,
                attemptDirectory: attempt.directory,
                attempt: attempt.attempt,
                parentArtifactIds,
                providerId,
              })
            : undefined;
          return failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "script",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: "AI 编剧",
            ...(preserved ? { output: preserved.output, additionalArtifacts: [preserved.artifact] } : {}),
          });
        }
        if (error instanceof ModelCandidatesExhaustedError) {
          return failedModelCandidatesNodeResult({
            error,
            taskKind: "script-draft",
            attemptDirectory: attempt.directory,
            nodeId: "script",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: "AI 编剧",
          });
        }
        throw error;
      }
      const requestedBrief = request.brief;
      const draft = validateScriptDraft(execution.output, {
        durationSeconds: requestedBrief.durationSeconds,
        ...(requestedBrief.durationRange ? { durationRange: requestedBrief.durationRange } : {}),
        requireCanonFacts: Boolean(requestedBrief.seriesContext),
      });
      const scriptPath = path.join(attempt.directory, "script.json");
      const script = scriptDocument(requestedBrief, draft);
      const content = `${JSON.stringify(script, null, 2)}\n`;
      await writeTextAtomically(scriptPath, content);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "script",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: execution.agentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "script",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: { scriptPath, canonFacts: draft.canonFacts ?? [] },
        receipt: producerRequestReceipt(provider, execution, "AI 编剧", producerIdentity),
        artifacts: [withProducerRequestIdentity(fileArtifact(
          "script",
          scriptPath,
          content,
          "application/json",
          "video-factory/script-draft-v1",
          "script",
          parentArtifactIds,
          providerId,
          "AI-generated script; facts and claims require human review before publication.",
          attempt.attempt,
        ), producerIdentity), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
      };
    },
    validateOverride: (output) => validateScriptNodeOutput(output),
  };
}

async function inheritUnchangedReworkScript(options: {
  productionRework: ProductionBrief["rework"];
  request: ScreenwriterAgentInput;
  context: WorkflowContext;
  runsRoot: string;
  attemptDirectory: string;
  attempt: number;
  agent: ScreenwriterAgent | undefined;
  producerIdentity: ProducerRequestIdentity;
  withSourceRunSnapshot: SourceRunSnapshot;
}): Promise<NodeExecutionResult<Record<string, unknown>> | undefined> {
  const rework = options.productionRework;
  if (!rework
    || rework.affectedScenePositions === undefined
    || rework.affectedScenePositions.length !== 0
    || !rework.previousScript
    || rework.findings.some((finding) => (
      finding.targetNodeIds.includes("script") && finding.action !== "inspect_existing_media"
  ))) {
    return undefined;
  }

  try {
    return await options.withSourceRunSnapshot(rework.sourceRunId, async () => {
  let sourceRun: WorkflowRun<ProductionBrief>;
  try {
    sourceRun = JSON.parse(await readFile(
      path.join(options.runsRoot, rework.sourceRunId, "run.json"),
      "utf8",
    )) as WorkflowRun<ProductionBrief>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (sourceRun.revision !== rework.sourceRunRevision) return undefined;
  const sourceNode = sourceRun.nodeRuns.find((node) => node.nodeId === "script");
  const sourceExecution = effectiveNodeExecutionInput(sourceNode);
  if (!sourceExecution) return undefined;
  let sourceRequest: ScreenwriterAgentInput;
  try {
    sourceRequest = validateScreenwriterInput(sourceExecution.input);
  } catch {
    return undefined;
  }
  const { rework: _currentRework, ...currentModelInput } = options.request.brief;
  const { rework: _sourceRework, ...sourceModelInput } = sourceRequest.brief;
  if (!isDeepStrictEqual(currentModelInput, sourceModelInput)) return undefined;
  const currentModelId = options.request.selectedModelId ?? options.agent?.modelId ?? "codex-default";
  if (sourceNode?.status !== "succeeded"
    || sourceNode.outputState?.stale === true
    || sourceNode.executionReceipt?.modelId !== currentModelId
    || sourceNode.executionReceipt?.parameters?.promptPack !== "video-factory/screenwriter-v18"
    || sourceNode.executionReceipt?.parameters?.producerRequestSchemaVersion !== options.producerIdentity.schemaVersion
    || sourceNode.executionReceipt?.parameters?.producerRequestDigest !== options.producerIdentity.digest) {
    return undefined;
  }
  let sourceScriptPath: string;
  try {
    sourceScriptPath = requiredOutputString(
      requireOutputRecord(sourceExecution.output, "source script output"),
      "scriptPath",
    );
  } catch {
    return undefined;
  }
  const sourceArtifacts = sourceExecution.artifactIds
    .map((id) => sourceRun.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => (
      artifact?.kind === "script"
      && artifact.producer?.nodeId === "script"
      && artifact.uri !== undefined
      && path.resolve(artifact.uri) === path.resolve(sourceScriptPath)
    ));
  if (sourceArtifacts.length !== 1) return undefined;
  const sourceArtifact = sourceArtifacts[0]!;
  if (!sourceArtifact?.uri
    || sourceArtifact.schemaVersion !== "video-factory/script-draft-v1"
    || sourceArtifact.contentType !== "application/json"
    || !sourceArtifact.sha256
    || sourceArtifact.sizeBytes === undefined
    || sourceArtifact.provenance.producerRequestSchemaVersion !== options.producerIdentity.schemaVersion
    || sourceArtifact.provenance.producerRequestDigest !== options.producerIdentity.digest) {
    return undefined;
  }
  try {
    await verifyStoredArtifactWithinRoot(path.join(options.runsRoot, rework.sourceRunId), sourceArtifact);
  } catch {
    return undefined;
  }
  let document: Record<string, unknown>;
  let draft: ScriptDraft;
  try {
    document = requireOutputRecord(JSON.parse(await readFile(sourceArtifact.uri, "utf8")), "source script");
    if (!isDeepStrictEqual(document, rework.previousScript)) return undefined;
    draft = validateScriptDraft(document, {
      durationSeconds: options.request.brief.durationSeconds,
      ...(options.request.brief.durationRange ? { durationRange: options.request.brief.durationRange } : {}),
      requireCanonFacts: Boolean(options.request.brief.seriesContext),
    });
  } catch {
    return undefined;
  }

  const scriptPath = path.join(options.attemptDirectory, "script.json");
  try {
    await copyFile(sourceArtifact.uri, scriptPath);
    await verifyArtifactBytes(scriptPath, sourceArtifact.sha256, sourceArtifact.sizeBytes);
  } catch {
    await rm(scriptPath, { force: true });
    return undefined;
  }
  return {
    status: "succeeded",
    output: { scriptPath, canonFacts: draft.canonFacts ?? [] },
    artifacts: [{
      kind: sourceArtifact.kind,
      uri: scriptPath,
      sha256: sourceArtifact.sha256,
      sizeBytes: sourceArtifact.sizeBytes,
      contentType: sourceArtifact.contentType,
      schemaVersion: sourceArtifact.schemaVersion,
      parentArtifactIds: options.context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "brief")
        .map((artifact) => artifact.id),
      provenance: {
        ...sourceArtifact.provenance,
        notes: `Inherited unchanged from ${rework.sourceRunId} artifact ${sourceArtifact.id}.`,
      },
      producer: { nodeId: "script", attempt: options.attempt },
    }],
  };
    });
  } catch (error) {
    if (error instanceof RunLockedError) return undefined;
    throw error;
  }
}

function scriptDocument(brief: ScreenwriterAgentInput["brief"], draft: ScriptDraft): Record<string, unknown> {
  return {
    title: brief.title,
    ...(draft.viewerPromise ? { viewerPromise: draft.viewerPromise } : {}),
    ...(draft.narrativeArc ? { narrativeArc: draft.narrativeArc } : {}),
    ...(draft.canonFacts ? { canonFacts: draft.canonFacts } : {}),
    hook: draft.scenes[0]!.narration,
    duration_target: brief.durationSeconds,
    ...(brief.durationRange ? { duration_range: { ...brief.durationRange } } : {}),
    disclosure_required: true,
    niche_slug: brief.nicheSlug,
    structure: "AI 编剧短视频结构",
    quality_checks: brief.editorial?.guardrails.length
      ? brief.editorial.guardrails
      : ["核验事实与数据", "人工审片后再发布"],
    platform_notes: {
      platform: brief.platform,
      audience: brief.audience,
      angle: brief.angle,
    },
    hashtags: [],
    scenes: draft.scenes,
  };
}

function lastAgentLoopCandidate<T>(error: RoleAgentLoopError, validate: (value: unknown) => T): T | undefined {
  const raw = error.agentLoop.iterations.at(-1)?.candidate ?? error.agentLoop.pendingCandidate?.candidate;
  if (raw === undefined) return undefined;
  try {
    return validate(raw);
  } catch {
    return undefined;
  }
}

async function persistRejectedScriptDraft(options: {
  draft: ScriptDraft;
  brief: ScreenwriterAgentInput["brief"];
  attemptDirectory: string;
  attempt: number;
  parentArtifactIds: string[];
  providerId: string;
}): Promise<{ output: Record<string, unknown>; artifact: ArtifactDraft }> {
  const scriptPath = path.join(options.attemptDirectory, "rejected-script.json");
  const content = `${JSON.stringify(scriptDocument(options.brief, options.draft), null, 2)}\n`;
  await writeTextAtomically(scriptPath, content);
  return {
    output: { scriptPath, canonFacts: options.draft.canonFacts ?? [] },
    artifact: fileArtifact(
      "script",
      scriptPath,
      content,
      "application/json",
      "video-factory/script-draft-v1",
      "script",
      options.parentArtifactIds,
      options.providerId,
      "Unapproved AI draft preserved for human review and editing.",
      options.attempt,
    ),
  };
}

interface PublishCopyOutcome {
  copy: PublishCopy;
  source: string;
  fallbackReason?: string;
  writerId?: string;
  trace?: CodexTaskTrace;
  agentLoop?: AgentLoopTrace;
}

// 未配置模型或普通服务故障可使用保守标题；已配置 Agent 的审计失败必须阻断，不能伪装成成功。
async function generatePublishCopy(input: {
  writer: PublishCopyWriter | undefined;
  brief: ProductionBrief;
  scriptPath: string;
  checkpoint: ReturnType<typeof fileRoleAgentLoopCheckpoint>;
}): Promise<PublishCopyOutcome> {
  if (!input.writer) return fallbackCopyOutcome(input.brief);
  try {
    const narrations = await readNarrations(input.scriptPath);
    const request = {
      platform: input.brief.platform,
      brief: {
        title: input.brief.title,
        angle: input.brief.angle,
        audience: input.brief.audience,
        nicheSlug: input.brief.nicheSlug,
      },
      narrations,
      agentLoopCheckpoint: input.checkpoint,
    };
    const execution = input.writer.writeDetailed
      ? await input.writer.writeDetailed(request)
      : { output: await input.writer.write(request) };
    const copy = validatePublishCopy(execution.output);
    return {
      copy,
      source: input.writer.id,
      writerId: input.writer.id,
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    };
  } catch (error) {
    if (error instanceof RoleAgentLoopError) throw error;
    return fallbackCopyOutcome(input.brief);
  }
}

function fallbackCopyOutcome(
  brief: ProductionBrief,
  attempted: Pick<PublishCopyOutcome, "trace" | "agentLoop"> = {},
): PublishCopyOutcome {
  return {
    copy: { title: brief.title, description: "", hashtags: [] },
    source: "brief-title",
    fallbackReason: "codex-publish-copy-unavailable",
    ...attempted,
  };
}

async function readNarrations(scriptPath: string): Promise<string[]> {
  const script = JSON.parse(await readFile(scriptPath, "utf8")) as { scenes?: unknown };
  if (!Array.isArray(script.scenes)) throw new Error("Publish copy requires a script with scenes.");
  const narrations = script.scenes.map((scene, index) => {
    if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
      throw new Error(`Script scene ${index + 1} must be an object.`);
    }
    const narration = (scene as Record<string, unknown>).narration;
    if (typeof narration !== "string" || !narration.trim()) {
      throw new Error(`Script scene ${index + 1} narration must be a non-empty string.`);
    }
    return narration.trim();
  });
  if (narrations.length < 3 || narrations.length > 24) {
    throw new Error("Publish copy requires 3 to 24 script narrations.");
  }
  return narrations;
}

function parseDirectorScenes(value: unknown): VisualDirectorAgentInput["scenes"] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("AI director requires a script with scenes.");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Script scene ${index + 1} must be an object.`);
    }
    const scene = entry as Record<string, unknown>;
    const position = Number(scene.position);
    const duration = Number(scene.duration);
    if (!Number.isInteger(position) || position < 1) throw new Error(`Script scene ${index + 1} position is invalid.`);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Script scene ${index + 1} duration is invalid.`);
    return {
      position,
      ...(optionalOutputString(scene.purpose) ? { purpose: optionalOutputString(scene.purpose)! } : {}),
      duration,
      narration: requiredOutputString(scene, "narration"),
      visualPrompt: requiredOutputString(scene, "visual_prompt"),
      visualStrategy: visualStrategy(scene.visual_strategy),
      visibleAction: optionalOutputString(scene.visible_action) ?? requiredOutputString(scene, "visual_prompt"),
      ...(optionalOutputString(scene.on_screen_text) !== undefined
        ? { onScreenText: optionalOutputString(scene.on_screen_text)! }
        : {}),
      ...(optionalOutputString(scene.sound_cue) !== undefined
        ? { soundCue: optionalOutputString(scene.sound_cue)! }
        : {}),
      successCriteria: optionalOutputStringList(scene.success_criteria),
      failureConditions: optionalOutputStringList(scene.failure_conditions),
      searchTerms: optionalOutputStringList(scene.search_terms),
    };
  });
}

function visualDirectorPlanValidation(
  brief: ProductionBrief,
  scenes: VisualDirectorAgentInput["scenes"],
  catalog: VisualAssetProviderCapability[],
  runtimeMetadata: ProductionProviderRuntimeMetadata[] = [],
  viewerPromise?: string,
): Parameters<typeof validateVisualDirectorPlan>[1] {
  const direction = brief.director;
  if (!direction) throw new Error("AI director configuration is incomplete.");
  const providersById = new Map(catalog.map((provider) => [provider.id, provider]));
  const selectedProviders = direction.assetProviderIds.map((id) => {
    const provider = providersById.get(id);
    if (!provider) throw new Error(`Asset provider '${id}' is not available to the AI director.`);
    return provider;
  });
  return {
    scenePositions: scenes.map((scene) => scene.position),
    ...(viewerPromise ? { viewerPromise } : {}),
    sceneDurations: Object.fromEntries(scenes.map((scene) => [scene.position, scene.duration])),
    sceneVisualStrategies: Object.fromEntries(scenes.map((scene) => [scene.position, scene.visualStrategy])),
    allowedProviderIds: direction.assetProviderIds,
    generativeProviderIds: selectedProviders.filter((provider) => provider.generative).map((provider) => provider.id),
    providerDeliveryTypes: Object.fromEntries(
      selectedProviders.map((provider) => [provider.id, [...provider.deliveryTypes]]),
    ),
    referenceImageProviderIds: selectedProviders
      .filter((provider) => provider.supportsReferenceImage)
      .map((provider) => provider.id),
    estimatedCnyPerClip: Object.fromEntries(
      selectedProviders.map((provider) => [provider.id, provider.estimatedCnyPerClip ?? 0]),
    ),
    selectedVideoModelDurationBounds: Object.fromEntries(
      selectedProviders.flatMap((provider): Array<[string, { minDurationSeconds: number; maxDurationSeconds: number }]> => {
        const selected = selectedVideoModelRuntime(brief, provider.id, runtimeMetadata);
        return selected ? [[provider.id, {
          minDurationSeconds: selected.minDurationSeconds,
          maxDurationSeconds: selected.maxDurationSeconds,
        }]] : [];
      }),
    ),
    selectedVideoModelAspectRatios: Object.fromEntries(
      selectedProviders.flatMap((provider): Array<[string, NonNullable<VideoGenerationRuntimeProfile["aspectRatios"]>]> => {
        const selected = selectedVideoModelRuntime(brief, provider.id, runtimeMetadata);
        return selected?.aspectRatios ? [[provider.id, [...selected.aspectRatios]]] : [];
      }),
    ),
    requiredAspectRatio: "9:16",
    economics: { allowMeteredProviders: brief.economics.allowMeteredProviders },
  };
}

function selectedVideoModelRuntime(
  brief: ProductionBrief,
  providerId: string,
  runtimeMetadata: ProductionProviderRuntimeMetadata[],
): { modelId: string; minDurationSeconds: number; maxDurationSeconds: number; aspectRatios?: VideoGenerationRuntimeProfile["aspectRatios"] } | undefined {
  const provider = runtimeMetadata.find((candidate) => candidate.id === providerId);
  if (!provider?.modelProfiles?.length) return undefined;
  const modelId = brief.models?.[providerId] ?? provider.modelId;
  const profile = provider.modelProfiles.find((candidate) => candidate.modelId === modelId);
  return profile?.minDurationSeconds === undefined || profile.maxDurationSeconds === undefined
    ? undefined
    : {
        modelId,
        minDurationSeconds: profile.minDurationSeconds,
        maxDurationSeconds: profile.maxDurationSeconds,
        ...(profile.aspectRatios ? { aspectRatios: [...profile.aspectRatios] } : {}),
      };
}

function visualStrategy(value: unknown): VisualDirectorAgentInput["scenes"][number]["visualStrategy"] {
  return value === "stock" || value === "image" || value === "generated" || value === "local" ? value : "stock";
}

function optionalOutputString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalOutputStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
}

// 编剧面对的返工上下文只在实质相关时进入其真实输入与阶段身份：仅修 media/director 的
// 返工（无编剧指令、无 script 责任 findings）不得让编剧阶段在身份层“天然不同”而被重跑。
function screenwriterReworkContext(brief: ProductionBrief): ProductionBrief["rework"] | undefined {
  const rework = brief.rework;
  if (!rework) return undefined;
  const instruction = rework.nodeInstructions.script?.trim();
  const scriptFindings = rework.findings.filter((finding) => (
    finding.targetNodeIds.includes("script") && finding.action !== "inspect_existing_media"
  ));
  if (!instruction && scriptFindings.length === 0) return undefined;
  return rework;
}

function screenwriterBrief(
  brief: ProductionBrief,
  options?: ProductionPipelineOptions,
): ScreenwriterAgentInput["brief"] {
  const rework = screenwriterReworkContext(brief);
  return {
    title: brief.title,
    angle: brief.angle,
    audience: brief.audience,
    nicheSlug: brief.nicheSlug,
    platform: brief.platform,
    durationSeconds: brief.durationSeconds,
    productionCapabilities: options
      ? productionCapabilitiesFor(brief, options)
      : summarizeProductionCapabilities([], brief.providers.voice),
    voiceTiming: voiceTimingFor(brief),
    ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
    ...(brief.editorial ? { editorial: brief.editorial } : {}),
    ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
    ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
    ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
    ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
    ...(brief.articleSources?.length ? { articleSources: brief.articleSources } : {}),
    ...(rework ? {
      rework: {
        sourceRunId: rework.sourceRunId,
        instruction: rework.nodeInstructions.script,
        findings: rework.findings
          .filter((finding) => finding.targetNodeIds.includes("script") && finding.action !== "inspect_existing_media")
          .map(modelFacingReworkFinding),
        ...(rework.affectedScenePositions !== undefined
          ? { affectedScenePositions: [...rework.affectedScenePositions] }
          : {}),
        ...(rework.previousScript ? { previousScript: rework.previousScript } : {}),
      },
    } : {}),
  };
}

function voiceTimingFor(brief: ProductionBrief): { rate: number; pauseScale: number } {
  return {
    rate: brief.voiceDirection.rate,
    pauseScale: brief.voiceDirection.pauseScale,
  };
}

function modelFacingReworkFinding(finding: ProductionReworkFinding): ProductionReworkFinding {
  // 模型只接收 Broker 公共合同允许、且提出修改所需的事实；责任归属、动作、帧哈希、
  // 审片版本和调用身份留在宿主证据链中，不能把内部扩展字段送进严格输入合同。
  return {
    findingId: finding.findingId,
    timecodeMs: finding.timecodeMs,
    ...(finding.scenePosition !== undefined ? { scenePosition: finding.scenePosition } : {}),
    category: finding.category,
    description: finding.description,
    suggestion: finding.suggestion,
    targetNodeIds: [...finding.targetNodeIds],
  };
}

function validateScreenwriterInput(value: unknown): ScreenwriterAgentInput {
  const input = requireOutputRecord(value, "script input");
  const rawBrief = requireOutputRecord(input.brief, "script input brief");
  if (rawBrief.protocolVersion === "video-factory/brief-v1") {
    const parsed = parseBrief(rawBrief);
    return {
      brief: screenwriterBrief(parsed),
      ...(parsed.models?.[parsed.providers.script] ? { selectedModelId: parsed.models[parsed.providers.script] } : {}),
    };
  }
  const durationSeconds = Number(rawBrief.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > 180) {
    throw new Error("script input brief.durationSeconds must be an integer between 20 and 180.");
  }
  const brief: ScreenwriterAgentInput["brief"] = {
    title: requiredOutputString(rawBrief, "title"),
    angle: requiredOutputString(rawBrief, "angle"),
    audience: requiredOutputString(rawBrief, "audience"),
    nicheSlug: requiredOutputString(rawBrief, "nicheSlug"),
    platform: requiredOutputString(rawBrief, "platform"),
    durationSeconds,
  };
  if (rawBrief.durationRange !== undefined) {
    brief.durationRange = parseScriptDurationRange(rawBrief.durationRange, durationSeconds);
  }
  if (rawBrief.editorial !== undefined) {
    const editorial = requireOutputRecord(rawBrief.editorial, "script input editorial");
    if (editorial.verdict !== "produce_video" && editorial.verdict !== "produce_image_story") {
      throw new Error("script input editorial.verdict is invalid.");
    }
    brief.editorial = {
      verdict: editorial.verdict,
      reasons: stringList(editorial.reasons, "script input editorial.reasons"),
      guardrails: stringList(editorial.guardrails, "script input editorial.guardrails"),
    };
  }
  if (rawBrief.visualProof !== undefined) {
    brief.visualProof = requiredOutputString(rawBrief, "visualProof");
  }
  if (rawBrief.visualIntent !== undefined) {
    const visualIntent = requiredOutputString(rawBrief, "visualIntent");
    if (visualIntent.length > 1000) throw new Error("script input brief.visualIntent must contain at most 1000 characters.");
    brief.visualIntent = visualIntent;
  }
  if (rawBrief.visualPlan !== undefined) {
    const visualPlan = parseProductionVisualPlan(rawBrief.visualPlan);
    if (visualPlan) brief.visualPlan = visualPlan;
  }
  if (rawBrief.seriesContext !== undefined) {
    const seriesContext = parseProductionSeriesContext(rawBrief.seriesContext);
    if (seriesContext) brief.seriesContext = seriesContext;
  }
  if (rawBrief.rework !== undefined) {
    const rework = requireOutputRecord(rawBrief.rework, "script input rework");
    const findings = parseProductionReworkFindings(rework.findings, "script input rework.findings");
    if (findings.some((finding) => !finding.targetNodeIds.includes("script"))) {
      throw new Error("script input rework.findings must only contain findings assigned to script.");
    }
    brief.rework = {
      sourceRunId: requiredOutputString(rework, "sourceRunId"),
      instruction: requiredOutputString(rework, "instruction"),
      findings,
      ...(rework.affectedScenePositions === undefined
        ? {}
        : { affectedScenePositions: parseScreenwriterAffectedScenePositions(rework.affectedScenePositions) }),
      ...(rework.previousScript === undefined
        ? {}
        : { previousScript: requireOutputRecord(rework.previousScript, "script input rework.previousScript") }),
    };
  }
  const selectedModelId = input.selectedModelId === undefined
    ? undefined
    : requiredOutputString(input, "selectedModelId");
  return { brief, ...(selectedModelId ? { selectedModelId } : {}) };
}

function parseScreenwriterAffectedScenePositions(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("script input rework.affectedScenePositions must contain at most 100 entries.");
  }
  const positions = value.map((position, index) => {
    if (!Number.isInteger(position) || Number(position) < 1 || Number(position) > 10_000) {
      throw new Error(`script input rework.affectedScenePositions[${index}] must be a positive integer.`);
    }
    return Number(position);
  });
  return [...new Set(positions)].sort((left, right) => left - right);
}

function validateVisualReviewInput(
  value: unknown,
  directorEnabled: boolean,
  executablePlanRequired = false,
): VisualReviewAgentInput & { renderManifestPath: string } {
  const input = requireOutputRecord(value, "visual-review input");
  const request: VisualReviewAgentInput & { renderManifestPath: string } = {
    videoPath: requiredOutputString(input, "videoPath"),
    reviewStage: "rendered_video",
    runRoot: requiredOutputString(input, "runRoot"),
    scriptPath: requiredOutputString(input, "scriptPath"),
    renderManifestPath: requiredOutputString(input, "renderManifestPath"),
  };
  if (directorEnabled) request.directorPlanPath = requiredOutputString(input, "directorPlanPath");
  if (executablePlanRequired) request.executablePlanPath = requiredOutputString(input, "executablePlanPath");
  if (input.selectedModelId !== undefined) {
    request.selectedModelId = requiredOutputString(input, "selectedModelId");
  }
  return request;
}

function sourceAssetVisualReviewNode(brief: ProductionBrief, runsRoot: string): NodeDefinition {
  const providerId = brief.providers.visualReview;
  if (!providerId) throw new Error("Source asset visual review provider is missing.");
  return {
    id: "asset-source-review",
    label: "Source asset visual review",
    role: "生成画面预检",
    capability: "quality.review.visual",
    providerId,
    mode: "automatic",
    dependsOn: ["assets"],
    getInput: (context) => {
      const planning = usesJointCreativePlanning(brief) ? planningOutputs(context) : undefined;
      return {
      assetPlanPath: outputPath(context, "assets", "assetPlanPath"),
      reviewStage: "source_assets",
      runRoot: path.join(runsRoot, context.runId),
      scriptPath: planning ? planning.scriptPath : outputPath(context, "script", "scriptPath"),
      ...(planning
        ? { directorPlanPath: planning.directorPlanPath, executablePlanPath: planning.executablePlanPath }
        : {
            ...(brief.director ? { directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath") } : {}),
            ...(brief.durationRange && brief.director
              ? { executablePlanPath: outputPath(context, "production-preflight", "executablePlanPath") }
              : {}),
          }),
      ...(brief.models?.[providerId] ? { selectedModelId: brief.models[providerId] } : {}),
      };
    },
    validateInputOverride: (input) => validateSourceAssetVisualReviewInput(
      input,
      Boolean(brief.director),
      Boolean(brief.durationRange && brief.director),
    ),
    execute: async (input, context) => {
      const request = validateSourceAssetVisualReviewInput(
        input,
        Boolean(brief.director),
        Boolean(brief.durationRange && brief.director),
      );
      const provider = context.resolveProvider<VisualReviewAgentInput, VisualReviewExecution>({
        capability: "quality.review.visual",
        providerId,
      });
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && (usesJointCreativePlanning(brief)
          ? ["creative-planning", "assets"]
          : ["script", "visual-direction", "production-preflight", "assets"]).includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "asset-source-review"));
      let execution: VisualReviewExecution;
      try {
        execution = await provider.run({
          ...request,
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "asset-source-review",
            request,
            VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
            undefined,
            context.operationRequestId,
          ),
          agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "asset-source-review",
            request,
            VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
            modelId,
            context.operationRequestId,
          ),
        }, context);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          const failed = await failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "asset-source-review",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: provider.label ?? "生成画面预检",
          });
          return { ...failed, error: `源素材视觉预检没有完成：${failed.error}` };
        }
        if (error instanceof VisualReviewFallbackError) {
          const failed = await failedModelCandidatesNodeResult({
            error,
            taskKind: "visual-review",
            attemptDirectory: attempt.directory,
            nodeId: "asset-source-review",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: provider.label ?? "生成画面预检",
          });
          return { ...failed, error: `源素材视觉预检没有完成：${failed.error}` };
        }
        return {
          status: "failed",
          providerOutcomeKnown: true,
          error: "源素材视觉预检服务暂时不可用。已保留生成结果，请重试生成画面预检或更换视觉审片模型。",
        };
      }

      const sourceScenePositions = [...new Set([
        ...(execution.sampling?.coveredScenePositions ?? []),
        ...execution.output.findings.flatMap((finding) => finding.scenePosition ? [finding.scenePosition] : []),
      ])].sort((left, right) => left - right);
      const planDurationMs = request.executablePlanPath
        ? await executablePlanDurationMs(request.executablePlanPath)
        : brief.durationSeconds * 1_000;
      const report: VisualReviewReport = {
        ...execution.output,
        reviewScope: {
          reviewStage: "source_assets",
          evidenceId: execution.evidenceSnapshotId ?? visualReviewEvidenceId(context, parentArtifactIds),
          sourceNodeIds: [
            "script",
            ...(brief.director ? ["visual-direction"] : []),
            ...(brief.durationRange && brief.director ? ["production-preflight"] : []),
            "assets",
          ],
          sourceArtifactIds: [...parentArtifactIds].sort(),
          scenePositions: sourceScenePositions,
          timelineDurationMs: execution.inspectedDurationMs ?? planDurationMs,
          actualModels: [{
            providerId: execution.executedProviderId ?? execution.trace?.providerId ?? provider.id,
            modelId: execution.executedModelId ?? execution.trace?.modelId ?? provider.modelId ?? provider.id,
          }],
          reviewContractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
        },
      };
      const reportPath = path.join(attempt.directory, "source_visual_review.json");
      const reportContent = `${JSON.stringify(report, null, 2)}\n`;
      await writeTextAtomically(reportPath, reportContent);
      const reportArtifact = fileArtifact(
        "review_report",
        reportPath,
        reportContent,
        "application/json",
        "video-factory/source-asset-visual-review-v1",
        "asset-source-review",
        parentArtifactIds,
        execution.executedProviderId ?? execution.trace?.providerId ?? provider.id,
        "Free source-asset visual gate completed before voice synthesis and rendering.",
        attempt.attempt,
      );
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "asset-source-review",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: execution.agentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "asset-source-review",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const output = { sourceVisualReviewPath: reportPath, report };
      const artifacts = [reportArtifact, traceArtifact, loopArtifact]
        .filter((artifact): artifact is ArtifactDraft => Boolean(artifact));
      const result = {
        output,
        ...(execution.trace ? { receipt: modelTraceReceipt(execution.trace, provider.label ?? "生成画面预检", "subscription", execution.agentLoop, provider.configurationSource) } : {}),
        artifacts,
      };
      // 与试片闸门同一判据：源素材预检的咨询性发现（not_observed）不阻断配音与渲染，
      // 只有实质缺陷或评分/置信度未达门槛才交回用户。预检是意见不是判决——它能拦下自己，
      // 但不能替用户宣布这个作品不行。
      return visualReviewBlocksContinuation(report)
        ? {
          ...result,
          status: "needs_human",
          intervention: {
            reason: sourceAssetReviewFailureMessage(report),
            requiredAction: "approve",
            options: ["approve", "request_changes", "reject"],
            artifactIds: parentArtifactIds,
          },
        }
        : { ...result, status: "succeeded" };
    },
    validateOverride: (output) => validatePathOutput(output, "sourceVisualReviewPath", "asset-source-review"),
  };
}

function parseScriptDurationRange(value: unknown, durationSeconds: number): NonNullable<ScreenwriterAgentInput["brief"]["durationRange"]> {
  const input = requireOutputRecord(value, "script input brief.durationRange");
  const minSeconds = Number(input.minSeconds);
  const maxSeconds = Number(input.maxSeconds);
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds)
    || minSeconds < 20 || maxSeconds > 180 || minSeconds > maxSeconds) {
    throw new Error("script input brief.durationRange must use ordered integer bounds between 20 and 180.");
  }
  if (durationSeconds < minSeconds || durationSeconds > maxSeconds) {
    throw new Error("script input brief.durationSeconds must fall within durationRange.");
  }
  return { minSeconds, maxSeconds };
}

function validateSourceAssetVisualReviewInput(
  value: unknown,
  directorEnabled: boolean,
  executablePlanRequired = false,
): VisualReviewAgentInput {
  const input = requireOutputRecord(value, "source asset visual review input");
  const request: VisualReviewAgentInput = {
    assetPlanPath: requiredOutputString(input, "assetPlanPath"),
    reviewStage: "source_assets",
    runRoot: requiredOutputString(input, "runRoot"),
    scriptPath: requiredOutputString(input, "scriptPath"),
  };
  if (directorEnabled) request.directorPlanPath = requiredOutputString(input, "directorPlanPath");
  if (executablePlanRequired) request.executablePlanPath = requiredOutputString(input, "executablePlanPath");
  if (input.selectedModelId !== undefined) request.selectedModelId = requiredOutputString(input, "selectedModelId");
  return request;
}

function sourceAssetReviewFailureMessage(report: VisualReviewReport): string {
  const findings = report.findings.map((finding) => (
    `${finding.scenePosition ? `镜头 ${finding.scenePosition}` : "未定位镜头"}：${finding.description}`
  ));
  return [
    "源素材视觉预检未通过，系统已在配音和渲染前停下，不会自动再次调用付费画面模型。",
    report.summary,
    ...findings,
    "请调整导演方案或画面 Provider，重新报价并确认后再生成；",
    "如果你认为预检判断有误，也可以直接通过，让配音与渲染继续——已生成的素材不会因此重买。",
  ].filter(Boolean).join(" ");
}

function validatePublishPackageInput(value: unknown): {
  scriptPath: string;
  brief: Pick<ProductionBrief, "title" | "angle" | "audience" | "nicheSlug" | "platform">;
} {
  const input = requireOutputRecord(value, "publish-package input");
  const brief = requireOutputRecord(input.brief, "publish-package input brief");
  return {
    scriptPath: requiredOutputString(input, "scriptPath"),
    brief: {
      title: requiredOutputString(brief, "title"),
      angle: requiredOutputString(brief, "angle"),
      audience: requiredOutputString(brief, "audience"),
      nicheSlug: requiredOutputString(brief, "nicheSlug"),
      platform: requiredOutputString(brief, "platform"),
    },
  };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${field}[${index}] must be a non-empty string.`);
    return entry.trim();
  });
}

function requiredOutputString(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} container must be an object.`);
  }
  const item = (value as Record<string, unknown>)[field];
  if (typeof item !== "string" || !item.trim()) throw new Error(`${field} must be a non-empty string.`);
  return item.trim();
}

function visualReviewNode(
  brief: ProductionBrief,
  runsRoot: string,
): NodeDefinition {
  const providerId = brief.providers.visualReview;
  if (!providerId) throw new Error("Visual review provider is missing.");
  return {
    id: "visual-review",
    label: "Visual review",
    role: "视觉审片员",
    capability: "quality.review.visual",
    providerId,
    mode: "automatic",
    dependsOn: ["render", "technical-review"],
    getInput: (context) => {
      const planning = usesJointCreativePlanning(brief) ? planningOutputs(context) : undefined;
      return {
      videoPath: outputPath(context, "render", "videoPath"),
      reviewStage: "rendered_video",
      runRoot: path.join(runsRoot, context.runId),
      scriptPath: planning ? planning.scriptPath : outputPath(context, "script", "scriptPath"),
      ...(planning
        ? { directorPlanPath: planning.directorPlanPath, executablePlanPath: planning.executablePlanPath }
        : {
            ...(brief.director ? { directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath") } : {}),
            ...(brief.durationRange && brief.director
              ? { executablePlanPath: outputPath(context, "production-preflight", "executablePlanPath") }
              : {}),
          }),
      renderManifestPath: outputPath(context, "render", "renderManifestPath"),
      ...(brief.models?.[providerId] ? { selectedModelId: brief.models[providerId] } : {}),
      };
    },
    validateInputOverride: (input) => validateVisualReviewInput(
      input,
      Boolean(brief.director),
      Boolean(brief.durationRange && brief.director),
    ),
    execute: async (input, context) => {
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "visual-review"));
      const request = validateVisualReviewInput(
        input,
        Boolean(brief.director),
        Boolean(brief.durationRange && brief.director),
      );
      const checkpointCycle = await currentVisualReinspectionCycle(runsRoot, context.runId);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && (usesJointCreativePlanning(brief)
          ? ["creative-planning", "render", "technical-review"]
          : ["production-preflight", "render", "technical-review"]).includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      const provider = context.resolveProvider<VisualReviewAgentInput, VisualReviewExecution>({
        capability: "quality.review.visual",
        providerId,
      });
      let execution: VisualReviewExecution;
      try {
        execution = await provider.run({
          ...request,
          ...(brief.models?.[providerId] ? { selectedModelId: brief.models[providerId] } : {}),
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-review",
            request,
            `${VISUAL_REVIEW_AGENT_CONTRACT_VERSION}|cycle:${checkpointCycle}`,
            undefined,
            context.operationRequestId,
          ),
          agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-review",
            request,
            `${VISUAL_REVIEW_AGENT_CONTRACT_VERSION}|cycle:${checkpointCycle}`,
            modelId,
            context.operationRequestId,
          ),
          independentReviewCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-review",
            request,
            `independent-final-visual-review-result-v2|${VISUAL_REVIEW_AGENT_CONTRACT_VERSION}|cycle:${checkpointCycle}`,
            modelId,
            context.operationRequestId,
          ),
        }, context);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          return failedAgentLoopNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "visual-review",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: provider.label ?? "视觉审片",
          });
        }
        if (error instanceof VisualReviewFallbackError) {
          return failedModelCandidatesNodeResult({
            error,
            taskKind: "visual-review",
            attemptDirectory: attempt.directory,
            nodeId: "visual-review",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: provider.label ?? "视觉审片",
          });
        }
        if (error instanceof IndependentVisualReviewError) {
          return failedIndependentVisualReviewNodeResult({
            error,
            attemptDirectory: attempt.directory,
            nodeId: "visual-review",
            attempt: attempt.attempt,
            parentArtifactIds,
            provider,
            providerLabel: provider.label ?? "视觉审片",
          });
        }
        throw error;
      }
      const localizedReport = await localizeVisualReviewReport(
        execution.output,
        request.renderManifestPath,
        execution.inspectedDurationMs,
      );
      const independentReviews = execution.independentReviews
        ? await Promise.all(execution.independentReviews.map(async (review) => ({
            providerId: review.providerId,
            modelId: review.modelId,
            report: await localizeVisualReviewReport(
              review.output,
              request.renderManifestPath,
              execution.inspectedDurationMs,
            ),
          })))
        : undefined;
      const actualModels = independentReviews?.map(({ providerId: actualProviderId, modelId }) => ({
        providerId: actualProviderId,
        modelId,
      })) ?? [{
        providerId: execution.executedProviderId ?? execution.trace?.providerId ?? provider.id,
        modelId: execution.executedModelId ?? execution.trace?.modelId ?? provider.modelId ?? provider.id,
      }];
      const actualModelProofs = execution.independentReviews?.map((review) => (
        visualReviewModelProof(review, execution.evidenceSnapshotId)
      )) ?? actualModels;
      const scenePositions = [...new Set([
        ...(execution.sampling?.coveredScenePositions ?? []),
        ...localizedReport.findings.flatMap((finding) => finding.scenePosition ? [finding.scenePosition] : []),
      ])].sort((left, right) => left - right);
      const planDurationMs = request.executablePlanPath
        ? await executablePlanDurationMs(request.executablePlanPath)
        : brief.durationSeconds * 1_000;
      const report: VisualReviewReport = {
        ...localizedReport,
        reviewScope: {
          reviewStage: "rendered_video",
          evidenceId: execution.evidenceSnapshotId ?? visualReviewEvidenceId(context, parentArtifactIds),
          sourceNodeIds: [
            ...(brief.durationRange && brief.director ? ["production-preflight"] : []),
            "render",
            "technical-review",
          ],
          sourceArtifactIds: [...parentArtifactIds].sort(),
          scenePositions,
          timelineDurationMs: execution.inspectedDurationMs ?? planDurationMs,
          actualModels: actualModelProofs,
          reviewContractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
        },
        ...(independentReviews ? { independentReviews } : {}),
      };
      const reportPath = path.join(attempt.directory, "visual_review.json");
      const content = `${JSON.stringify(report, null, 2)}\n`;
      await writeTextAtomically(reportPath, content);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "visual-review",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: execution.agentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "visual-review",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const independentTraceArtifacts = (await Promise.all((execution.independentReviews ?? []).flatMap((review, index) => [
        persistModelTrace({
          trace: review.trace,
          attemptDirectory: attempt.directory,
          nodeId: "visual-review",
          attempt: attempt.attempt,
          parentArtifactIds,
          fileSuffix: `-${index + 1}`,
        }),
        persistAgentLoopTrace({
          loop: review.agentLoop,
          attemptDirectory: attempt.directory,
          nodeId: "visual-review",
          attempt: attempt.attempt,
          parentArtifactIds,
          fileSuffix: `-${index + 1}`,
        }),
      ]))).filter((artifact): artifact is ArtifactDraft => Boolean(artifact));
      const meteredAttemptCount = provider.billing === "metered"
        ? Math.max(1, execution.agentLoop?.producerModelCallCount ?? execution.agentLoop?.iterations.length ?? 1)
        : undefined;
      return {
        status: "succeeded",
        output: {
          visualReviewPath: reportPath,
          report,
          durationMs: execution.inspectedDurationMs ?? brief.durationSeconds * 1_000,
        },
        receipt: {
          providerId: execution.executedProviderId ?? execution.trace?.providerId ?? provider.id,
          providerLabel: execution.executedProviderLabel ?? provider.label ?? provider.id,
          modelId: execution.executedModelId ?? execution.trace?.modelId ?? provider.modelId ?? provider.id,
          transport: provider.transport ?? "unix_socket",
          billing: provider.billing ?? "subscription",
          configurationSource: provider.configurationSource ?? "system_default",
          parameters: {
            ...(provider.parameters ?? {}),
            ...(execution.trace ? { promptPack: execution.trace.promptVersion } : {}),
            sampleMode: execution.sampling?.mode ?? "unknown",
            ...(execution.agentLoop ? {
              agentLoop: execution.agentLoop.status,
              agentLoopIterations: execution.agentLoop.iterations.length,
              auditReasoningEffort: execution.agentLoop.iterations.at(-1)?.auditTrace?.reasoningEffort ?? "xhigh",
              modelCallCount: execution.agentLoop.modelCallCount ?? execution.agentLoop.iterations.length * 2,
              producerModelCallCount: execution.agentLoop.producerModelCallCount ?? execution.agentLoop.iterations.length,
              auditModelCallCount: execution.agentLoop.auditModelCallCount ?? execution.agentLoop.iterations.length,
            } : {}),
            ...(execution.sampling?.sceneCount !== undefined ? {
              samplingCoverage: `${execution.sampling.coveredScenePositions?.length ?? 0}/${execution.sampling.sceneCount}`,
              missingScenePositions: (execution.sampling.missingScenePositions ?? []).map(String),
            } : {}),
          },
          ...(provider.estimatedCostCny !== undefined ? {
            estimatedCostCny: roundCurrency(provider.estimatedCostCny * (meteredAttemptCount ?? 1)),
          } : {}),
          ...(execution.requestId ? { requestId: execution.requestId } : {}),
          ...(meteredAttemptCount !== undefined ? { meteredAttemptCount } : {}),
          ...(execution.fallbackFromProviderId ? { fallbackFromProviderId: execution.fallbackFromProviderId } : {}),
          ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
          ...(execution.attemptedModelIds?.length ? { actualModelIds: execution.attemptedModelIds } : {}),
        },
        artifacts: [fileArtifact(
          "review_report",
          reportPath,
          content,
          "application/json",
          "video-factory/visual-review-v1",
          "visual-review",
          parentArtifactIds,
          providerId,
          "Sampled-frame AI visual review; human final review remains mandatory.",
          attempt.attempt,
        ), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : []), ...independentTraceArtifacts],
      };
    },
    validateOverride: (output) => {
      const value = requireOutputRecord(output, "visual-review");
      const durationMs = value.durationMs === undefined
        ? brief.durationSeconds * 1_000
        : Number(value.durationMs);
      if (!Number.isInteger(durationMs) || durationMs <= 0) {
        throw new Error("visual-review durationMs must be a positive integer.");
      }
      return {
        ...value,
        visualReviewPath: requiredOutputString(value, "visualReviewPath"),
        durationMs,
        report: validateVisualReviewReport(value.report, durationMs),
      };
    },
  };
}

function assetSemanticRankNode(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  runsRoot: string,
): NodeDefinition {
  const ranker = options.assetSemanticRanker;
  return {
    id: "asset-semantic-rank",
    label: "Rank asset candidates",
    role: "候选画面复核",
    capability: "asset.rank.semantic",
    providerId: ranker?.id ?? "deterministic-quality-v1",
    plannedExecution: ranker ? {
      providerId: ranker.id,
      providerLabel: "Codex 候选画面排序",
      modelId: ranker.modelId,
      transport: "unix_socket",
      billing: "subscription",
      configurationSource: "system_default",
      parameters: { rankingMode: "visual_semantic", promptPack: "video-factory/asset-rank-v6" },
      estimatedCostCny: 0,
    } : {
      providerId: "deterministic-quality-v1",
      providerLabel: "确定性质量排序",
      modelId: "deterministic-quality-v1",
      transport: "local_process",
      billing: "free",
      configurationSource: "system_default",
      parameters: { rankingMode: "deterministic" },
      estimatedCostCny: 0,
    },
    mode: "automatic",
    dependsOn: ["asset-candidates"],
    getInput: (context) => ({ candidateSearchPath: outputPath(context, "asset-candidates", "candidateSearchPath") }),
    validateInputOverride: (input) => ({ candidateSearchPath: requiredOutputString(input, "candidateSearchPath") }),
    execute: async (input, context) => {
      const candidateSearchPath = requiredOutputString(input, "candidateSearchPath");
      const report = parseAssetCandidateReport(JSON.parse(await readFile(candidateSearchPath, "utf8")));
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "asset-semantic-rank"));
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "asset-candidates")
        .map((artifact) => artifact.id);
      let ranking;
      let trace: CodexTaskTrace | undefined;
      let agentLoop: AgentLoopTrace | undefined;
      let fallbackReason: string | undefined;
      const hasCandidates = report.scenes.some((scene) => scene.candidates.length > 0);
      if (!hasCandidates) {
        ranking = deterministicAssetRanking(report, "本次没有图库候选需要排序，已跳过 AI 排序。");
      } else if (ranker) {
        try {
          const execution = ranker.rankDetailed
            ? await ranker.rankDetailed(
                report,
                nodeAgentLoopCheckpoint(
                  runsRoot,
                  context.runId,
                  "asset-semantic-rank",
                  report,
                  ASSET_RANK_AGENT_CONTRACT_VERSION,
                  undefined,
                  context.operationRequestId,
                ),
              )
            : { output: await ranker.rank(report) };
          const actualProviderId = execution.trace?.providerId ?? ranker.id;
          const actualModelId = execution.trace?.modelId ?? ranker.modelId;
          ranking = validateAssetSemanticRanking({
            ...execution.output,
            source: "model",
            providerId: actualProviderId,
            modelId: actualModelId,
          }, report);
          trace = execution.trace;
          agentLoop = execution.agentLoop;
        } catch (error) {
          if (error instanceof RoleAgentLoopError) {
            return failedAgentLoopNodeResult({
              error,
              attemptDirectory: attempt.directory,
              nodeId: "asset-semantic-rank",
              attempt: attempt.attempt,
              parentArtifactIds,
              provider: {
                id: ranker.id,
                modelId: ranker.modelId,
                transport: "unix_socket",
                billing: "subscription",
                configurationSource: "system_default",
                parameters: { rankingMode: "visual_semantic", promptPack: "video-factory/asset-rank-v6" },
              },
              providerLabel: "Codex 候选画面排序",
            });
          }
          fallbackReason = publicFallbackReason(error);
          ranking = deterministicAssetRanking(
            report,
            `语义排序失败，已安全回退：${fallbackReason}`,
          );
        }
      } else {
        ranking = deterministicAssetRanking(report);
      }
      const rankingPath = path.join(attempt.directory, "asset_ranking.json");
      const content = `${JSON.stringify(ranking, null, 2)}\n`;
      await writeTextAtomically(rankingPath, content);
      const traceArtifact = await persistModelTrace({
        trace,
        attemptDirectory: attempt.directory,
        nodeId: "asset-semantic-rank",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const loopArtifact = await persistAgentLoopTrace({
        loop: agentLoop,
        attemptDirectory: attempt.directory,
        nodeId: "asset-semantic-rank",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      const semanticReceipt = trace
        ? modelTraceReceipt(trace, "Codex 候选画面排序", "subscription", agentLoop)
        : undefined;
      return {
        status: "succeeded",
        output: { candidateRankingPath: rankingPath, ranking },
        receipt: {
          ...(semanticReceipt
            ? {
                ...semanticReceipt,
                ...(fallbackReason ? { fallbackReason } : {}),
              }
            : {
                providerId: ranking.providerId,
                providerLabel: "确定性质量排序",
                modelId: ranking.modelId,
                transport: "local_process" as const,
                billing: "free" as const,
                configurationSource: "system_default" as const,
                ...(ranker && fallbackReason ? { fallbackFromProviderId: ranker.id, fallbackReason } : {}),
              }),
          parameters: {
            ...(semanticReceipt?.parameters ?? {}),
            rankingMode: ranking.source === "model" ? "visual_semantic" : "deterministic",
          },
          estimatedCostCny: 0,
          requestId: context.nextId("asset-ranking"),
        },
        artifacts: [fileArtifact(
          "asset_ranking",
          rankingPath,
          content,
          "application/json",
          "video-factory/asset-ranking-v1",
          "asset-semantic-rank",
          parentArtifactIds,
          ranking.providerId,
          "Candidate ranking only; no source media was downloaded or altered.",
          attempt.attempt,
        ), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
      };
    },
    validateOverride: (output, context) => {
      const value = requireOutputRecord(output, "asset-semantic-rank");
      const reportPath = outputPath(context, "asset-candidates", "candidateSearchPath");
      const report = parseAssetCandidateReport(JSON.parse(nodeFs.readFileSync(reportPath, "utf8")));
      return {
        ...value,
        candidateRankingPath: requiredOutputString(value, "candidateRankingPath"),
        ranking: validateAssetSemanticRanking(value.ranking, report, { allowLocks: true }),
      };
    },
  };
}

function providerConfigs(brief: ProductionBrief, options: ProductionPipelineOptions): ProviderConfig[] {
  const runtimeMetadata = new Map((options.providerRuntimeMetadata ?? []).map((item) => [item.id, item]));
  const assetMetadata = resolveAssetRuntimeMetadata(brief, runtimeMetadata, options.assetProviders ?? []);
  return [
    ...(brief.providers.script === "codex-screenwriter-v1"
      ? []
      : [providerConfig(brief.providers.script, "script.draft", "script", {}, runtimeMetadata.get(brief.providers.script), modelSourceFor(brief, brief.providers.script))]),
    ...(brief.workflowFeatures?.assetSemanticRank
      ? [providerConfig("asset-candidate-search-v1", "asset.search", "asset-candidates")]
      : []),
    providerConfig(brief.providers.assets, "asset.prepare", "assets", {
      maxCostCny: 0,
      modelSelections: resolvedAssetModels(brief, runtimeMetadata),
      ...(brief.providers.visualReview ? {
        reviewProviderId: brief.providers.visualReview,
        ...(brief.models?.[brief.providers.visualReview] ? { reviewModelId: brief.models[brief.providers.visualReview] } : {}),
      } : {}),
      freeProviderIds: (brief.director?.assetProviderIds ?? []).filter((providerId) =>
        options.assetProviders?.some((provider) => provider.id === providerId && provider.billing === "free")),
    }, assetMetadata, assetConfigurationSource(brief), runtimeMetadata),
    providerConfig(brief.providers.voice, "voice.synthesize", "voice", {
      profileId: brief.voiceDirection.profileId,
      voice: brief.voiceDirection.profileId.slice(brief.voiceDirection.profileId.indexOf(":") + 1),
      rate: brief.voiceDirection.rate,
      pauseScale: brief.voiceDirection.pauseScale,
      masteringPreset: brief.voiceDirection.masteringPreset,
      maxCostCny: 0,
    }, runtimeMetadata.get(brief.providers.voice), modelSourceFor(brief, brief.providers.voice)),
    providerConfig(brief.providers.render, "video.render", "render", {}, runtimeMetadata.get(brief.providers.render), modelSourceFor(brief, brief.providers.render)),
    providerConfig(brief.providers.technicalReview, "quality.review", "technical-review", {}, runtimeMetadata.get(brief.providers.technicalReview), modelSourceFor(brief, brief.providers.technicalReview)),
  ];
}

function resolvedAssetModels(
  brief: ProductionBrief,
  metadata: Map<string, ProductionProviderRuntimeMetadata>,
): Record<string, string> {
  const providerIds = brief.director?.assetProviderIds ?? [brief.providers.assets];
  return Object.fromEntries(providerIds.flatMap((providerId) => {
    const runtime = metadata.get(providerId);
    if (!runtime) return [];
    return [[providerId, resolveRuntimeModel(runtime, brief.models?.[providerId]).modelId]];
  }));
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const input = requireOutputRecord(value, field);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}.${key} must be a non-empty string.`);
    return [key, item.trim()];
  }));
}

function shotsAsScenePositions(shots: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(shots)) return [];
  return shots.flatMap((shot): Array<Record<string, unknown>> => {
    if (typeof shot !== "object" || shot === null || Array.isArray(shot)) return [];
    const position = Number((shot as Record<string, unknown>).scenePosition);
    return Number.isInteger(position) && position > 0 ? [{ position }] : [];
  });
}

function modelSourceFor(brief: ProductionBrief, providerId: string): ExecutionConfigurationSource {
  return brief.modelSelectionSources?.[providerId] ?? "system_default";
}

function assetConfigurationSource(brief: ProductionBrief): ExecutionConfigurationSource {
  const priority: ExecutionConfigurationSource[] = ["node_override", "run_override", "template_default", "global_default", "system_default"];
  const sources = [
    modelSourceFor(brief, brief.providers.assets),
    ...(brief.director?.assetProviderIds.map((providerId) => modelSourceFor(brief, providerId)) ?? []),
  ];
  return priority.find((source) => sources.includes(source)) ?? "system_default";
}

function resolveAssetRuntimeMetadata(
  brief: ProductionBrief,
  metadata: Map<string, ProductionProviderRuntimeMetadata>,
  catalog: VisualAssetProviderCapability[],
): ProductionProviderRuntimeMetadata | undefined {
  const selected = metadata.get(brief.providers.assets);
  if (brief.providers.assets !== "ai-shot-router-v1" || !brief.director) {
    return selected ? resolveRuntimeModel(selected, brief.models?.[brief.providers.assets]) : selected;
  }
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const meteredIds = brief.director.assetProviderIds.filter((id) =>
    catalogById.get(id)?.billing === "metered" || KNOWN_METERED_WORKER_PROVIDER_IDS.has(id));
  const metered = meteredIds.map((id) => {
    const item = metadata.get(id);
    validateProviderRuntimeMetadata(id, item, true);
    return resolveRuntimeModel(item!, brief.models?.[id]);
  });
  if (!metered.length) return selected;
  const highestUnitCost = Math.max(...metered.map((item) => item.estimatedCostCny ?? 0));
  return {
    id: "ai-shot-router-v1",
    label: "AI 逐镜路由（含付费镜头）",
    modelId: metered.map((item) => item.modelId).sort().join("+") || "dynamic-router",
    transport: "local_process",
    billing: "metered",
    estimatedCostCny: roundCurrency(highestUnitCost),
    maxAttempts: 1,
  };
}

function resolveRuntimeModel(
  metadata: ProductionProviderRuntimeMetadata,
  selectedModelId: string | undefined,
): ProductionProviderRuntimeMetadata {
  if (!selectedModelId || selectedModelId === metadata.modelId) return metadata;
  const profile = metadata.modelProfiles?.find((candidate) => candidate.modelId === selectedModelId);
  if (!profile) throw new Error(`Provider '${metadata.id}' does not expose model '${selectedModelId}'.`);
  return {
    ...metadata,
    modelId: profile.modelId,
    estimatedCostCny: profile.estimatedCostCny,
  };
}

function providerConfig(
  id: string,
  capability: Capability,
  nodeId: string,
  parametersOverride: Record<string, unknown> = {},
  metadata?: ProductionProviderRuntimeMetadata,
  configurationSource: ExecutionConfigurationSource = "system_default",
  assetRuntimeMetadata?: ReadonlyMap<string, ProductionProviderRuntimeMetadata>,
): ProviderConfig {
  const known: Record<string, Record<string, Record<string, unknown>>> = {
    "script.draft": {
      "python-template-v1": {},
    },
    "asset.prepare": {
      "ai-shot-router-v1": { provider: "ai-router", mediaType: "video" },
      "local-editorial-v1": { provider: "local", mediaType: "image" },
      "pexels-stock-v1": { provider: "pexels", mediaType: "video" },
      "pixabay-stock-v1": { provider: "pixabay", mediaType: "video" },
      "seedream-image-v1": { provider: "seedream", mediaType: "image" },
      "seedance-video-v1": { provider: "seedance", mediaType: "video" },
      "hailuo-video-v1": { provider: "minimax", mediaType: "video" },
      "wan-video-v1": { provider: "wan", mediaType: "video" },
    },
    "asset.search": {
      "asset-candidate-search-v1": { provider: "ai-router", mediaType: "video", limit: 6 },
    },
    "voice.synthesize": {
      "macos-say-v1": { provider: "macos-say", voice: "Tingting", rate: 190 },
      "kokoro-local-v1": { provider: "kokoro", voice: "zf_001", rate: 180 },
      "minimax-tts-v1": { provider: "minimax", voice: "female-chengshu", rate: 190 },
      "ffmpeg-tone-test-v1": { provider: "tone" },
    },
    "video.render": {
      "python-ffmpeg-v1": { resolution: "1080x1920" },
    },
    "quality.review": {
      "python-technical-review-v1": { expectedWidth: 1080, expectedHeight: 1920, production: true },
    },
  };
  const parameters = known[capability]?.[id];
  if (!parameters) {
    throw new Error(`Provider '${id}' cannot serve capability '${capability}'.`);
  }
  validateProviderRuntimeMetadata(
    id,
    metadata,
    KNOWN_METERED_WORKER_PROVIDER_IDS.has(id),
  );
  return {
    id,
    capability,
    nodeId,
    parameters: { ...parameters, ...parametersOverride },
    configurationSource,
    ...(metadata ? { metadata } : {}),
    ...(assetRuntimeMetadata ? { assetRuntimeMetadata } : {}),
  };
}

function receiptParameters(parameters: Record<string, unknown>): Record<string, ExecutionParameterValue> {
  const allowed = new Set([
    "provider",
    "profileId",
    "mediaType",
    "resolution",
    "voice",
    "rate",
    "pauseScale",
    "masteringPreset",
    "expectedWidth",
    "expectedHeight",
    "production",
    "maxAttempts",
    "limit",
    "freeProviderIds",
  ]);
  const output: Record<string, ExecutionParameterValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string" || typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string" && item.length <= 256)) {
      output[key] = [...value] as string[];
    }
  }
  return output;
}

function validateVoiceNodeInput(input: unknown): Record<string, unknown> {
  const value = requireOutputRecord(input, "voice input");
  const voice = requiredOutputString(value, "voice");
  if (voice.length > 160 || /[\u0000-\u001f\u007f]/.test(voice)) {
    throw new Error("voice input voice is invalid.");
  }
  const rate = Number(value.rate);
  if (!Number.isInteger(rate) || rate < 120 || rate > 260) {
    throw new Error("voice input rate must be an integer between 120 and 260.");
  }
  const pauseScale = Number(value.pause_scale);
  if (!Number.isFinite(pauseScale) || pauseScale < 0.5 || pauseScale > 2) {
    throw new Error("voice input pause_scale must be between 0.5 and 2.");
  }
  if (value.mastering_preset !== "natural" && value.mastering_preset !== "intimate" && value.mastering_preset !== "social") {
    throw new Error("voice input mastering_preset is invalid.");
  }
  return {
    scriptPath: requiredOutputString(value, "scriptPath"),
    ...(value.executablePlanPath !== undefined
      ? { executablePlanPath: requiredOutputString(value, "executablePlanPath") }
      : {}),
    voice,
    rate,
    pause_scale: pauseScale,
    mastering_preset: value.mastering_preset,
  };
}

function effectiveVoiceReceiptParameters(
  input: Record<string, unknown>,
  current: Record<string, ExecutionParameterValue> | undefined,
): Record<string, ExecutionParameterValue> {
  const provider = typeof current?.provider === "string" ? current.provider : "voice";
  const voice = requiredOutputString(input, "voice");
  const prefix = provider === "macos-say" ? "macos" : provider;
  return {
    ...(current ?? {}),
    profileId: `${prefix}:${voice}`,
    voice,
    rate: Number(input.rate),
    pauseScale: Number(input.pause_scale),
    masteringPreset: String(input.mastering_preset),
  };
}

function validateProviderRuntimeMetadata(
  providerId: string,
  metadata: ProductionProviderRuntimeMetadata | undefined,
  mustBeMetered: boolean,
): void {
  if (!metadata) {
    if (mustBeMetered) throw new Error(`Metered provider '${providerId}' requires runtime metadata.`);
    return;
  }
  if (metadata.id !== providerId || !metadata.label.trim() || !metadata.modelId.trim()) {
    throw new Error(`Provider '${providerId}' runtime metadata is invalid.`);
  }
  if (mustBeMetered && metadata.billing !== "metered") {
    throw new Error(`Known metered provider '${providerId}' cannot be configured as '${metadata.billing}'.`);
  }
  if (metadata.billing !== "metered") return;
  if (metadata.billingUnit !== undefined && metadata.billingUnit !== "clip" && metadata.billingUnit !== "run") {
    throw new Error(`Metered provider '${providerId}' has an invalid billing unit.`);
  }
  if (
    typeof metadata.estimatedCostCny !== "number"
    || !Number.isFinite(metadata.estimatedCostCny)
    || metadata.estimatedCostCny <= 0
    || !Number.isInteger(metadata.maxAttempts)
    || Number(metadata.maxAttempts) < 1
  ) {
    throw new Error(`Metered provider '${providerId}' requires finite positive cost and attempt limits.`);
  }
}

function validateVisualReviewRuntimeMetadata(
  providerId: string,
  metadata: ProductionProviderRuntimeMetadata | undefined,
): void {
  if (!KNOWN_SUBSCRIPTION_VISUAL_REVIEW_PROVIDER_IDS.has(providerId)) return;
  if (!metadata || metadata.billing !== "subscription" || metadata.approvalPolicy !== "none") {
    throw new Error(`Visual review provider '${providerId}' must use subscription billing without spend approval.`);
  }
}

function assertProductionVisualReviewReady(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
): void {
  if (brief.runPurpose === "test") return;
  const providerId = brief.providers.visualReview;
  if (!providerId) {
    throw new Error("Formal production requires GLM and Codex visual review before work can start.");
  }
  const agent = [
    ...(options.visualReviewAgents ?? []),
    ...(options.visualReviewAgent ? [options.visualReviewAgent] : []),
  ].find((candidate) => candidate.id === providerId);
  const reviewers = agent?.finalReviewConfiguration?.reviewers ?? [];
  if (agent?.finalReviewConfiguration?.mode !== "dual"
    || reviewers.length !== 2
    || new Set(reviewers.map((reviewer) => reviewer.providerId)).size !== 2
    || new Set(reviewers.map((reviewer) => reviewer.modelId)).size !== 2
    || reviewers.some((reviewer) => reviewer.independentRoleAudit !== true)) {
    throw new Error("Formal production requires two distinct GLM and Codex visual-review providers, models, and independent role audits.");
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// 免收费镜头分两批收集（路由阶段排除的、复用已有画面后由增量报价剔除的），收集顺序不
// 等于镜头顺序；这里按镜头号排好并收成可展开的字段，避免确认页上的清单乱序。
// 免收费镜头分两批收集（路由阶段排除的、复用已有画面后由增量报价剔除的），收集顺序因此
// 不等于镜头顺序。这里按镜号归并再排序，确认页上的清单顺序才与镜头顺序一致——排序键是
// 镜号本身，不是 id 的拼写，换任何 id 生成方式都不影响。
function excludedItemsField(notes: ReadonlyMap<number, string>): { excludedItems?: SpendExcludedItem[] } {
  if (notes.size === 0) return {};
  return {
    excludedItems: [...notes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([scenePosition, note]) => ({ id: `scene-${scenePosition}`, label: `镜头 ${scenePosition}`, note })),
  };
}

function workerResponseToNodeResult(
  response: WorkerResponse,
  context: WorkflowContext,
  parentNodeIds: string[],
): NodeExecutionResult<Record<string, unknown>> {
  const error = response.error?.message ?? "Worker execution failed without an error message.";
  const parentArtifactIds = context.artifacts
    .filter((artifact) => artifact.producer && parentNodeIds.includes(artifact.producer.nodeId))
    .map((artifact) => artifact.id);
  const artifacts = response.artifacts.map((artifact) => ({
    kind: artifact.kind,
    uri: artifact.uri,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    contentType: artifact.contentType,
    schemaVersion: `video-factory/${artifact.kind}-v1`,
    parentArtifactIds,
    producer: {
      nodeId: artifact.provenance.producerNodeId,
      attempt: artifact.provenance.attempt,
    },
    provenance: {
      providerId: artifact.provenance.providerId,
      providerVersion: "1",
      licenseNote: artifact.provenance.licenseNote,
      ...(artifact.provenance.sourceUrl ? { sourceUrl: artifact.provenance.sourceUrl } : {}),
      ...(artifact.provenance.creator ? { creator: artifact.provenance.creator } : {}),
      ...(artifact.provenance.scenePosition ? { scenePosition: artifact.provenance.scenePosition } : {}),
      ...(artifact.provenance.notes ? { notes: artifact.provenance.notes } : {}),
    },
  }));
  const providerOutcomeKnown = response.diagnostics?.providerOutcomeKnown;
  if (providerOutcomeKnown !== undefined && typeof providerOutcomeKnown !== "boolean") {
    throw new Error("Worker diagnostics providerOutcomeKnown must be a boolean.");
  }
  if (response.status === "failed") {
    return {
      status: "failed",
      error,
      artifacts,
      ...(providerOutcomeKnown !== undefined ? { providerOutcomeKnown } : {}),
    };
  }
  if (response.status === "rejected" && response.error?.code === "VOICE_DOES_NOT_FIT") {
    const output = requireOutputRecord(response.output, "voice timing conflict output");
    const conflict = parseVoiceDoesNotFitConflict(output.conflict);
    const rawArtifact = response.artifacts.find((artifact) => (
      artifact.kind === conflict.audioArtifact.kind
      && artifact.uri === conflict.audioArtifact.uri
      && artifact.sha256 === conflict.audioArtifact.sha256
      && artifact.sizeBytes === conflict.audioArtifact.sizeBytes
    ));
    if (!rawArtifact) {
      throw new Error("Voice timing conflict does not include its materialized raw audio artifact.");
    }
    return {
      status: "needs_human",
      error,
      output: { conflict },
      artifacts,
      ...(providerOutcomeKnown !== undefined ? { providerOutcomeKnown } : {}),
      intervention: {
        reason: `镜头 ${conflict.scenePosition} 的自然配音需要 ${conflict.requiredSeconds} 秒，`
          + `已接受 cut 只有 ${conflict.plannedSeconds} 秒。请在现有规划/人工修改入口提交新的统一 plan，`
          + "并核对素材覆盖；如需新媒体，仍须按现有报价与授权流程处理。",
        requiredAction: "request_changes",
        options: ["request_changes", "reject"],
      },
    };
  }
  if (response.status === "rejected") {
    return {
      status: "rejected",
      ...(response.error ? { error: response.error.message } : {}),
      ...(response.output ? { output: response.output } : {}),
      artifacts,
    };
  }
  return {
    status: "succeeded",
    output: response.output ?? {},
    artifacts,
  };
}

async function validateSeriesWorkerScriptResponse(response: WorkerResponse): Promise<WorkerResponse> {
  if (response.status !== "succeeded") return response;
  const output = requireOutputRecord(response.output, "series script worker output");
  const scriptPath = requiredOutputString(output, "scriptPath");
  const scriptArtifact = response.artifacts.find((artifact) => artifact.kind === "script"
    && path.resolve(artifact.uri) === path.resolve(scriptPath));
  if (!scriptArtifact) {
    throw new Error("系列编剧必须把最终脚本作为经过完整性校验的 script 产物返回。");
  }
  let scriptDocument: unknown;
  try {
    scriptDocument = JSON.parse(await readFile(scriptArtifact.uri, "utf8"));
  } catch {
    throw new Error("系列编剧返回的最终脚本不是可读取的 JSON。");
  }
  const canonFacts = outputStringArray(scriptDocument, "canonFacts", true);
  return { ...response, output: { ...output, canonFacts } };
}

function providerExecutionReceipt(
  provider: Pick<Provider<any, any>, "id" | "label" | "modelId" | "transport" | "billing" | "configurationSource" | "parameters" | "estimatedCostCny">,
  response: WorkerResponse,
): NodeExecutionReceiptDraft {
  const actualCost = response.diagnostics?.actualCostCny;
  if (actualCost !== undefined && (typeof actualCost !== "number" || !Number.isFinite(actualCost) || actualCost < 0)) {
    throw new Error("Worker diagnostics actualCostCny must be a finite non-negative number.");
  }
  const actualCostSource = response.diagnostics?.actualCostSource;
  if (actualCostSource !== undefined && actualCostSource !== "provider_reported" && actualCostSource !== "configured_rate" && actualCostSource !== "manual_reconciled") {
    throw new Error("Worker diagnostics actualCostSource must identify provider-reported, configured-rate, or manually reconciled accounting.");
  }
  if (actualCostSource !== undefined && actualCost === undefined) {
    throw new Error("Worker diagnostics actualCostSource requires actualCostCny.");
  }
  const meteredAttemptCount = optionalNonNegativeInteger(response.diagnostics?.meteredAttemptCount, "meteredAttemptCount");
  const meteredFailedAttemptCount = optionalNonNegativeInteger(response.diagnostics?.meteredFailedAttemptCount, "meteredFailedAttemptCount");
  if ((meteredFailedAttemptCount ?? 0) > (meteredAttemptCount ?? 0)) {
    throw new Error("Worker diagnostics failed metered attempts cannot exceed total metered attempts.");
  }
  const actualModelIds = response.diagnostics?.actualModelIds;
  if (actualModelIds !== undefined && (
    !Array.isArray(actualModelIds)
    || actualModelIds.length === 0
    || actualModelIds.length > 20
    || actualModelIds.some((modelId) => typeof modelId !== "string" || !modelId.trim() || modelId.length > 160)
  )) {
    throw new Error("Worker diagnostics actualModelIds must contain 1 to 20 valid model identifiers.");
  }
  return {
    providerId: provider.id,
    providerLabel: provider.label ?? provider.id,
    modelId: provider.modelId ?? "unspecified",
    transport: provider.transport ?? "local_process",
    billing: provider.billing ?? "local_compute",
    ...(provider.configurationSource ? { configurationSource: provider.configurationSource } : {}),
    ...(provider.parameters ? { parameters: structuredClone(provider.parameters) } : {}),
    ...(provider.estimatedCostCny !== undefined ? { estimatedCostCny: provider.estimatedCostCny } : {}),
    ...(actualCost !== undefined ? { actualCostCny: actualCost } : {}),
    ...(actualCostSource !== undefined ? { actualCostSource } : {}),
    ...(meteredAttemptCount !== undefined ? { meteredAttemptCount } : {}),
    ...(meteredFailedAttemptCount !== undefined ? { meteredFailedAttemptCount } : {}),
    ...(actualModelIds !== undefined ? { actualModelIds: [...actualModelIds] as string[] } : {}),
    requestId: response.commandId,
  };
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Worker diagnostics ${field} must be a non-negative integer.`);
  }
  return Number(value);
}

async function assertNoUnresolvedPlanningTask(runDirectory: string, run: WorkflowRun<ProductionBrief>): Promise<void> {
  const node = run.nodeRuns.find((entry) => entry.nodeId === "creative-planning");
  if (!node?.operationRequestId) return;
  const directory = path.join(runDirectory, "nodes", node.nodeId, "agent-loop-checkpoints");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const value: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    if (!isObjectRecord(value) || !isObjectRecord(value.recoveryOwner)
      || value.recoveryOwner.runId !== run.id || value.recoveryOwner.nodeId !== node.nodeId
      || value.recoveryOwner.workflowOperationRequestId !== node.operationRequestId
      || !isObjectRecord(value.pendingOperation) || !isObjectRecord(value.pendingOperation.operation)) continue;
    const failure = isObjectRecord(value.failure) ? value.failure : undefined;
    if (failure && ["completed_failure", "not_accepted", "rejected", "conflict"].includes(String(failure.stage))) continue;
    // beforeSubmit 保存的快照可能仍是 not_submitted，后续 uncertain 才是最新事实。
    if (failure?.stage === "uncertain" || value.pendingOperation.operation.taskFact !== "not_submitted") {
      throw new Error("原模型任务的结果尚未明确，请先查询原任务；不能通过修改配置或方案重新提交。");
    }
  }
}

export async function summarizeJointPlanningExecution(
  runsRoot: string,
  runId: string,
  workflowOperationRequestId: string | undefined,
): Promise<Record<string, number> | undefined> {
  if (!workflowOperationRequestId) return undefined;
  const directory = path.join(runsRoot, runId, "nodes", "creative-planning", "agent-loop-checkpoints");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  const checkpoints: Record<string, unknown>[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    } catch {
      continue;
    }
    if (!isObjectRecord(value)
      || (value.version !== "video-factory/agent-loop-checkpoint-v8"
        && value.version !== "video-factory/agent-loop-checkpoint-v9")
      || !isObjectRecord(value.recoveryOwner)
      || value.recoveryOwner.runId !== runId
      || value.recoveryOwner.nodeId !== "creative-planning") continue;
    checkpoints.push(value);
  }
  const discussionReceipts = await readCreativeDiscussionExecutions(runsRoot, runId);
  // 同一 checkpoint 会跨操作恢复；先按物理 requestId 的首次归属全局去重，再分本次/历史。
  // 没有 requestOwners 的旧记录不能证明属于本次，宁可列入历史也不虚增当前调用。
  const current = summarizePlanningCheckpoints(
    checkpoints,
    discussionReceipts.filter((value) => value.workflowOperationRequestId === workflowOperationRequestId),
    workflowOperationRequestId,
    false,
  );
  const previous = summarizePlanningCheckpoints(
    checkpoints,
    discussionReceipts.filter((value) => value.workflowOperationRequestId !== workflowOperationRequestId),
    workflowOperationRequestId,
    true,
  );
  if (!current && !previous) return undefined;
  return {
    ...(current ?? Object.fromEntries(Object.keys(previous!).map((key) => [key, 0]))),
    ...(previous ? {
      previousModelCallCount: previous.modelCallCount,
      previousProducerModelCallCount: previous.producerModelCallCount,
      previousAuditModelCallCount: previous.auditModelCallCount,
      previousDiscussionModelCallCount: previous.discussionModelCallCount,
      previousStructuredRepairModelCallCount: previous.structuredRepairModelCallCount,
      previousRetryCount: previous.retryCount,
      previousUnknownModelExecutionCount: previous.unknownModelExecutionCount,
      previousProducerMs: previous.producerMs,
      previousAuditMs: previous.auditMs,
      previousDiscussionMs: previous.discussionMs,
      previousLoopValidationMs: previous.loopValidationMs,
    } : {}),
  };
}

function summarizePlanningCheckpoints(
  checkpoints: readonly Record<string, unknown>[],
  discussionReceipts: readonly CreativeDiscussionExecutionRecord[] = [],
  currentOperationRequestId?: string,
  previous = false,
): Record<string, number> | undefined {
  if (checkpoints.length === 0 && discussionReceipts.length === 0) return undefined;
  const producerRequestIds = new Set<string>();
  const auditRequestIds = new Set<string>();
  const unknownRequestIds = new Set<string>();
  const retryRequestIds = new Set<string>();
  const discussionRequestIds = new Set<string>();
  let legacyProducerModelCallCount = 0;
  let legacyAuditModelCallCount = 0;
  let internalProducerModelCallCount = 0;
  let internalAuditModelCallCount = 0;
  let structuredRepairModelCallCount = 0;
  let producerMs = 0;
  let auditMs = 0;
  let validationMs = 0;
  let discussionMs = 0;
  const seenCheckpointEvidence = new Set<string>();
  for (const value of checkpoints) {
    // 同一落盘证据可能存在重复副本，不能重复累计耗时和修复次数。
    const evidenceIdentity = JSON.stringify(value);
    if (seenCheckpointEvidence.has(evidenceIdentity)) continue;
    seenCheckpointEvidence.add(evidenceIdentity);
    const phaseAttempts = isObjectRecord(value.phaseAttempts) ? value.phaseAttempts : {};
    const unaccepted = isObjectRecord(value.unacceptedPhaseAttempts) ? value.unacceptedPhaseAttempts : {};
    const durations = isObjectRecord(value.phaseDurationsMs) ? value.phaseDurationsMs : {};
    const attemptedRequestIds = new Set(Array.isArray(value.attemptedRequestIds)
      ? value.attemptedRequestIds.filter((entry): entry is string => typeof entry === "string")
      : []);
    const allMapped = planningCheckpointRequestPhases(value, attemptedRequestIds);
    const requestOwners = isObjectRecord(value.requestOwners) ? value.requestOwners : {};
    const belongs = (requestId: string): boolean => {
      const owner = typeof requestOwners[requestId] === "string" ? requestOwners[requestId] : undefined;
      return previous ? owner !== currentOperationRequestId : owner === currentOperationRequestId;
    };
    const mapped = currentOperationRequestId
      ? allMapped.filter((request) => belongs(request.requestId))
      : allMapped;
    const completed = Array.isArray(value.completed) ? value.completed : [];
    for (const item of completed) {
      if (!isObjectRecord(item) || !Number.isSafeInteger(item.iteration)) continue;
      const iteration = Number(item.iteration);
      const producerRequest = allMapped.filter((request) => request.phase === "produce" && request.iteration === iteration).at(-1);
      const auditRequest = allMapped.filter((request) => request.phase === "audit" && request.iteration === iteration).at(-1);
      if (producerRequest && (currentOperationRequestId === undefined || belongs(producerRequest.requestId)) && isObjectRecord(item.candidateTrace)) {
        internalProducerModelCallCount += Math.max(0, safeCount(item.candidateTrace.modelAttemptCount) - 1);
      }
      if (auditRequest && (currentOperationRequestId === undefined || belongs(auditRequest.requestId)) && isObjectRecord(item.auditTrace)) {
        internalAuditModelCallCount += Math.max(0, safeCount(item.auditTrace.modelAttemptCount) - 1);
      }
    }
    if (isObjectRecord(value.pendingCandidate) && Number.isSafeInteger(value.pendingCandidate.iteration)
      && isObjectRecord(value.pendingCandidate.candidateTrace)) {
      const iteration = Number(value.pendingCandidate.iteration);
      const request = allMapped.filter((entry) => entry.phase === "produce" && entry.iteration === iteration).at(-1);
      if (request && (currentOperationRequestId === undefined || belongs(request.requestId))) {
        internalProducerModelCallCount += Math.max(0, safeCount(value.pendingCandidate.candidateTrace.modelAttemptCount) - 1);
      }
    }
    const pending = isObjectRecord(value.pendingOperation) && isObjectRecord(value.pendingOperation.operation)
      ? value.pendingOperation.operation
      : undefined;
    for (const request of mapped) {
      if (pending?.requestId === request.requestId && pending.taskFact === "accepted_unknown") {
        unknownRequestIds.add(request.requestId);
      } else if (request.phase === "produce") {
        producerRequestIds.add(request.requestId);
      } else {
        auditRequestIds.add(request.requestId);
      }
    }
    const mappedProduce = mapped.filter((request) => request.phase === "produce").length;
    const mappedAudit = mapped.filter((request) => request.phase === "audit").length;
    const legacyBucket = currentOperationRequestId === undefined || previous;
    if (legacyBucket && Object.keys(requestOwners).length === 0) {
      legacyProducerModelCallCount += Math.max(0,
        safeCount(phaseAttempts.produce) - safeCount(unaccepted.produce) - allMapped.filter((request) => request.phase === "produce").length,
      );
      legacyAuditModelCallCount += Math.max(0,
        safeCount(phaseAttempts.audit) - safeCount(unaccepted.audit) - allMapped.filter((request) => request.phase === "audit").length,
      );
    }
    const allOwnersMatchBucket = allMapped.length > 0 && allMapped.every((request) => belongs(request.requestId));
    if (currentOperationRequestId === undefined || allOwnersMatchBucket) {
      structuredRepairModelCallCount += safeCount(value.structuredRepairModelCallCount);
    }
    if (Array.isArray(value.retriedRequestIds)) {
      value.retriedRequestIds.forEach((entry) => {
        if (typeof entry === "string"
          && (currentOperationRequestId === undefined || belongs(entry))) retryRequestIds.add(entry);
      });
    }
    if (currentOperationRequestId === undefined || allOwnersMatchBucket) {
      producerMs += safeCount(durations.produce);
      auditMs += safeCount(durations.audit);
      validationMs += safeCount(value.validationMs);
    }
  }
  const discussionReceiptsByRequest = new Map<string, CreativeDiscussionExecutionRecord>();
  for (const receipt of discussionReceipts) {
    const existing = discussionReceiptsByRequest.get(receipt.requestId);
    if (!existing) {
      discussionReceiptsByRequest.set(receipt.requestId, receipt);
      continue;
    }
    const statePriority = (state: CreativeDiscussionExecutionRecord["state"]) => (
      state === "completed" || state === "completed_failure" ? 2 : state === "accepted_unknown" ? 1 : 0
    );
    discussionReceiptsByRequest.set(receipt.requestId, {
      ...(statePriority(receipt.state) > statePriority(existing.state) ? receipt : existing),
      queueWaitMs: Math.max(safeCount(existing.queueWaitMs), safeCount(receipt.queueWaitMs)),
      providerWaitMs: Math.max(safeCount(existing.providerWaitMs), safeCount(receipt.providerWaitMs)),
      validationMs: Math.max(safeCount(existing.validationMs), safeCount(receipt.validationMs)),
    });
  }
  for (const receipt of discussionReceiptsByRequest.values()) {
    if (receipt.state === "accepted_unknown") {
      unknownRequestIds.add(receipt.requestId);
      continue;
    }
    if (receipt.state === "not_accepted") continue;
    discussionRequestIds.add(receipt.requestId);
    discussionMs += safeCount(receipt.providerWaitMs);
    validationMs += safeCount(receipt.validationMs);
  }
  const producerModelCallCount = producerRequestIds.size + legacyProducerModelCallCount + internalProducerModelCallCount;
  const auditModelCallCount = auditRequestIds.size + legacyAuditModelCallCount + internalAuditModelCallCount;
  const discussionModelCallCount = discussionRequestIds.size;
  return {
    modelCallCount: producerModelCallCount + auditModelCallCount + discussionModelCallCount,
    producerModelCallCount,
    auditModelCallCount,
    discussionModelCallCount,
    structuredRepairModelCallCount,
    retryCount: retryRequestIds.size,
    unknownModelExecutionCount: unknownRequestIds.size,
    producerMs,
    auditMs,
    discussionMs,
    loopValidationMs: validationMs,
  };
}

interface CreativeDiscussionExecutionRecord {
  version: "video-factory/creative-discussion-execution-v1";
  workflowOperationRequestId: string;
  commandId: string;
  requestId: string;
  stage: CreativeStage;
  state: "completed" | "completed_failure" | "accepted_unknown" | "not_accepted";
  queueWaitMs?: number;
  providerWaitMs?: number;
  validationMs?: number;
}

async function recordCreativeDiscussionExecution(
  runsRoot: string,
  runId: string,
  input: Omit<CreativeDiscussionExecutionRecord, "version" | "workflowOperationRequestId"> & {
    workflowOperationRequestId: string | undefined;
    trace?: CodexTaskTrace;
  },
): Promise<void> {
  if (!input.workflowOperationRequestId) return;
  const directory = path.join(runsRoot, runId, "nodes", "creative-planning", "discussion-executions");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${createHash("sha256").update(input.requestId).digest("hex")}.json`);
  const value: CreativeDiscussionExecutionRecord = {
    version: "video-factory/creative-discussion-execution-v1",
    workflowOperationRequestId: input.workflowOperationRequestId,
    commandId: input.commandId,
    requestId: input.requestId,
    stage: input.stage,
    state: input.state,
    ...(input.trace?.queueWaitMs !== undefined ? { queueWaitMs: input.trace.queueWaitMs } : {}),
    ...(input.trace?.providerWaitMs !== undefined ? { providerWaitMs: input.trace.providerWaitMs } : {}),
    ...(input.trace?.validationMs !== undefined ? { validationMs: input.trace.validationMs } : {}),
  };
  await writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readCreativeDiscussionExecutions(
  runsRoot: string,
  runId: string,
): Promise<CreativeDiscussionExecutionRecord[]> {
  const directory = path.join(runsRoot, runId, "nodes", "creative-planning", "discussion-executions");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const records: CreativeDiscussionExecutionRecord[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Partial<CreativeDiscussionExecutionRecord>;
      if (value.version !== "video-factory/creative-discussion-execution-v1"
        || typeof value.workflowOperationRequestId !== "string"
        || typeof value.commandId !== "string"
        || typeof value.requestId !== "string"
        || !["treatment", "script", "director"].includes(String(value.stage))
        || !["completed", "completed_failure", "accepted_unknown", "not_accepted"].includes(String(value.state))) continue;
      records.push(value as CreativeDiscussionExecutionRecord);
    } catch {
      // 损坏的可观测性记录不能改变生产状态；忽略它，避免编造调用数。
    }
  }
  return records;
}

function planningCheckpointRequestPhases(
  checkpoint: Record<string, unknown>,
  attemptedRequestIds: ReadonlySet<string>,
): Array<{ requestId: string; phase: "produce" | "audit"; iteration: number }> {
  if (typeof checkpoint.key !== "string"
    || typeof checkpoint.contractDigest !== "string"
    || !Number.isSafeInteger(checkpoint.cycle)
    || !isObjectRecord(checkpoint.operationGenerations)) return [];
  const cycle = Number(checkpoint.cycle);
  const operationKeys = new Set(Object.entries(checkpoint.operationGenerations)
    .filter(([, generation]) => Number.isSafeInteger(generation) && Number(generation) >= 0)
    .map(([operationKey]) => operationKey));
  const configuredMaxIterations = Number.isSafeInteger(checkpoint.maxIterations)
    && Number(checkpoint.maxIterations) >= 1
    && Number(checkpoint.maxIterations) <= 3
    ? Number(checkpoint.maxIterations)
    : 0;
  const persistedMaxIteration = Math.max(0, ...[...operationKeys].map((operationKey) => {
    const match = /^(\d+):(\d+):(produce|audit)$/.exec(operationKey);
    return match ? Number(match[2]) : 0;
  }));
  // generation=0 是正常首次调用，不会写进 operationGenerations；必须主动枚举，
  // 再由 attemptedRequestIds 证明它是否真的提交过。
  const maxIterations = Math.max(configuredMaxIterations, persistedMaxIteration);
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    operationKeys.add(`${cycle}:${iteration}:produce`);
    operationKeys.add(`${cycle}:${iteration}:audit`);
  }
  const requests: Array<{ requestId: string; phase: "produce" | "audit"; iteration: number }> = [];
  for (const operationKey of operationKeys) {
    const match = /^(\d+):(\d+):(produce|audit)$/.exec(operationKey);
    if (!match || Number(match[1]) !== cycle) continue;
    const iteration = Number(match[2]);
    const phase = match[3] as "produce" | "audit";
    const persistedGeneration = checkpoint.operationGenerations[operationKey];
    const maxGeneration = Number.isSafeInteger(persistedGeneration) && Number(persistedGeneration) >= 0
      ? Number(persistedGeneration)
      : 0;
    for (let generation = 0; generation <= maxGeneration; generation += 1) {
      const requestId = `agent-${createHash("sha256").update(JSON.stringify({
        scope: checkpoint.key,
        contractDigest: checkpoint.contractDigest,
        cycle,
        iteration,
        phase,
        generation,
      })).digest("hex")}`;
      if (attemptedRequestIds.has(requestId)) requests.push({ requestId, phase, iteration });
    }
  }
  return requests;
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function modelTraceReceipt(
  trace: CodexTaskTrace,
  providerLabel: string,
  billing: "subscription" | "metered",
  loop?: AgentLoopTrace,
  configurationSource: ExecutionConfigurationSource = "system_default",
): NodeExecutionReceiptDraft {
  const queueWaitMs = loopTraceDurationMs(loop, "queueWaitMs") ?? trace.queueWaitMs;
  const providerWaitMs = loopTraceDurationMs(loop, "providerWaitMs") ?? trace.providerWaitMs;
  return {
    providerId: trace.providerId,
    providerLabel,
    modelId: trace.modelId,
    transport: "unix_socket",
    billing,
    configurationSource,
    parameters: {
      promptPack: trace.promptVersion,
      ...(trace.reasoningEffort ? { reasoningEffort: trace.reasoningEffort } : {}),
      ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
      ...(providerWaitMs !== undefined ? { providerWaitMs } : {}),
      ...(trace.firstOutputEventMs !== undefined ? { firstOutputEventMs: trace.firstOutputEventMs } : {}),
      ...(trace.toolMs !== undefined ? { toolMs: trace.toolMs } : {}),
      ...(trace.validationMs !== undefined ? { providerValidationMs: trace.validationMs } : {}),
      brokerTaskCount: 1,
      ...(trace.modelAttemptCount !== undefined ? { modelExecutionCount: trace.modelAttemptCount } : {}),
      ...(trace.structuredRepairCount !== undefined ? { brokerStructuredRepairCount: trace.structuredRepairCount } : {}),
      ...(trace.requestPayloadBytes !== undefined ? { requestPayloadBytes: trace.requestPayloadBytes } : {}),
      ...(trace.promptBytes !== undefined ? { promptBytes: trace.promptBytes } : {}),
      ...(trace.imageCount !== undefined ? { evidenceImageCount: trace.imageCount } : {}),
      ...(trace.imageBytes !== undefined ? { evidenceImageBytes: trace.imageBytes } : {}),
      ...(trace.imageSetSha256 !== undefined ? { evidenceImageSetSha256: trace.imageSetSha256 } : {}),
      ...(trace.imageMappingSha256 !== undefined ? { evidenceImageMappingSha256: trace.imageMappingSha256 } : {}),
      ...(loop ? {
        agentLoop: loop.status,
        agentLoopIterations: loop.iterations.length,
        auditReasoningEffort: loop.iterations.at(-1)?.auditTrace?.reasoningEffort ?? "xhigh",
        modelCallCount: Math.max(1, loop.modelCallCount ?? loop.iterations.length * 2 + (loop.pendingCandidate ? 1 : 0)),
        producerModelCallCount: loop.producerModelCallCount ?? loop.iterations.length + (loop.pendingCandidate ? 1 : 0),
        auditModelCallCount: loop.auditModelCallCount ?? loop.iterations.length,
        ...(loop.producerMs !== undefined ? { producerMs: loop.producerMs } : {}),
        ...(loop.auditMs !== undefined ? { auditMs: loop.auditMs } : {}),
        ...(loop.validationMs !== undefined ? { loopValidationMs: loop.validationMs } : {}),
        ...(loop.retryCount !== undefined ? { retryCount: loop.retryCount } : {}),
      } : {}),
    },
    ...(trace.fallbackFromModelId ? { fallbackReason: trace.fallbackReason ?? `首选模型 ${trace.fallbackFromModelId} 调用失败，已切换候选模型。` } : {}),
    ...(trace.attemptedModelIds?.length ? { actualModelIds: trace.attemptedModelIds } : {}),
  };
}

function loopTraceDurationMs(
  loop: AgentLoopTrace | undefined,
  field: "queueWaitMs" | "providerWaitMs",
): number | undefined {
  if (!loop) return undefined;
  const traces = loop.iterations.flatMap((iteration) => [iteration.candidateTrace, iteration.auditTrace]);
  if (loop.pendingCandidate?.candidateTrace) traces.push(loop.pendingCandidate.candidateTrace);
  const durations = traces
    .map((item) => item?.[field])
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) >= 0);
  return durations.length > 0 ? durations.reduce((total, value) => total + value, 0) : undefined;
}

function validateWorkerNodeOverride(nodeId: string, output: unknown): Record<string, unknown> {
  const requiredFields: Record<string, string[]> = {
    script: ["scriptPath"],
    "asset-candidates": ["candidateSearchPath", "candidateInventoryPath"],
    assets: ["assetPlanPath"],
    voice: ["voiceoverPlanPath", "trackPath"],
    render: ["videoPath", "renderManifestPath"],
    "technical-review": ["reviewPath"],
  };
  const value = requireOutputRecord(output, nodeId);
  const normalized = { ...value };
  for (const field of requiredFields[nodeId] ?? []) {
    normalized[field] = requiredOutputString(value, field);
  }
  if (nodeId === "technical-review" && typeof value.passed !== "boolean") {
    throw new Error("technical-review override passed must be a boolean.");
  }
  if (nodeId === "script") normalized.canonFacts = outputStringArray(value, "canonFacts");
  return normalized;
}

function validateBriefInputOverride(value: unknown, workflowBrief: ProductionBrief): ProductionBrief {
  const parsed = parseBrief(value);
  const immutableConfigurationMatches = JSON.stringify({
    providers: parsed.providers,
    models: parsed.models,
    modelSelectionSources: parsed.modelSelectionSources,
    workflowFeatures: parsed.workflowFeatures,
    referenceVideo: parsed.referenceVideo,
    director: parsed.director,
    economics: parsed.economics,
    voiceDirection: parsed.voiceDirection,
    reviewMode: parsed.reviewMode,
  }) === JSON.stringify({
    providers: workflowBrief.providers,
    models: workflowBrief.models,
    modelSelectionSources: workflowBrief.modelSelectionSources,
    workflowFeatures: workflowBrief.workflowFeatures,
    referenceVideo: workflowBrief.referenceVideo,
    director: workflowBrief.director,
    economics: workflowBrief.economics,
    voiceDirection: workflowBrief.voiceDirection,
    reviewMode: workflowBrief.reviewMode,
  });
  if (!immutableConfigurationMatches) {
    throw new Error("Brief provider, budget, voice, director, or review configuration requires starting a new run.");
  }
  return parsed;
}

export function effectiveProductionBrief(run: WorkflowRun<ProductionBrief>): ProductionBrief {
  const workflowBrief = parsePersistedBrief(run.initialInput);
  const briefNode = run.nodeRuns.find((node) => node.nodeId === "brief");
  const current = briefNode?.outputState?.versions.find(
    (version) => version.id === briefNode.outputState?.effectiveVersionId,
  )?.output ?? briefNode?.output;
  return current === undefined ? workflowBrief : mergeCurrentBrief(current, workflowBrief);
}

function currentEffectiveBriefFromContext(
  context: WorkflowContext,
  workflowBrief: ProductionBrief,
): ProductionBrief {
  return mergeCurrentBrief(context.outputs.get("brief"), workflowBrief);
}

function mergeCurrentBrief(value: unknown, workflowBrief: ProductionBrief): ProductionBrief {
  if (!isObjectRecord(value)) throw new Error("Brief output must be an object.");
  return parsePersistedBrief({
    ...workflowBrief,
    ...value,
    providers: workflowBrief.providers,
    models: workflowBrief.models,
    modelSelectionSources: workflowBrief.modelSelectionSources,
    workflowFeatures: workflowBrief.workflowFeatures,
    referenceVideo: workflowBrief.referenceVideo,
    director: workflowBrief.director,
    economics: workflowBrief.economics,
    voiceDirection: workflowBrief.voiceDirection,
    reviewMode: workflowBrief.reviewMode,
    spendFeedback: workflowBrief.spendFeedback,
    taskContractDigests: workflowBrief.taskContractDigests,
  });
}

function validatePathOutput(output: unknown, field: string, nodeId: string): Record<string, unknown> {
  const value = requireOutputRecord(output, nodeId);
  return { ...value, [field]: requiredOutputString(value, field) };
}

function validateScriptNodeOutput(output: unknown): Record<string, unknown> {
  const value = validatePathOutput(output, "scriptPath", "script");
  return { ...value, canonFacts: outputStringArray(value, "canonFacts") };
}

function validateFinalReviewInput(input: unknown, requireCanonFacts = false): Record<string, unknown> {
  const value = requireOutputRecord(input, "final-review");
  if (!("review" in value)) throw new Error("final-review input must contain the reviewed delivery.");
  const canonFacts = outputStringArray(value, "canonFacts", requireCanonFacts);
  const reviewArtifactIds = value.reviewArtifactIds === undefined
    ? undefined
    : finalReviewArtifactIdsFromOutput(value);
  if (value.reviewEvidenceId !== undefined
    && (typeof value.reviewEvidenceId !== "string" || !/^[a-f0-9]{64}$/.test(value.reviewEvidenceId))) {
    throw new Error("final-review reviewEvidenceId must be a SHA-256 digest.");
  }
  return {
    ...value,
    canonFacts,
    ...(reviewArtifactIds ? { reviewArtifactIds } : {}),
  };
}

function currentFinalReviewArtifactIds(
  context: WorkflowContext,
  brief: ProductionBrief,
  reviewedDelivery: unknown,
): string[] {
  const expected = [
    { nodeId: "technical-review", output: context.outputs.get("technical-review"), field: "reviewPath" },
    ...(brief.providers.visualReview
      ? [{ nodeId: "visual-review", output: reviewedDelivery, field: "visualReviewPath" }]
      : []),
  ];
  return expected.map(({ nodeId, output, field }) => {
    const outputPathValue = requiredOutputString(requireOutputRecord(output, `${nodeId} output`), field);
    const matching = context.artifacts.filter((artifact) => (
      artifact.producer?.nodeId === nodeId
      && artifact.uri !== undefined
      && path.resolve(artifact.uri) === path.resolve(outputPathValue)
    ));
    if (matching.length !== 1) {
      throw new Error(`Final review cannot bind one current '${nodeId}' evidence artifact.`);
    }
    return matching[0]!.id;
  });
}

function finalReviewArtifactIdsFromOutput(output: unknown): string[] {
  const value = requireOutputRecord(output, "final-review output");
  if (!Array.isArray(value.reviewArtifactIds)
    || value.reviewArtifactIds.length < 1
    || value.reviewArtifactIds.length > 4
    || value.reviewArtifactIds.some((artifactId) => typeof artifactId !== "string" || !artifactId.trim())) {
    throw new Error("final-review output must bind the current review artifacts.");
  }
  const artifactIds = value.reviewArtifactIds.map(String);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("final-review output contains duplicate review artifact ids.");
  }
  return artifactIds;
}

function finalVisualReviewScope(reviewedDelivery: unknown): VisualReviewScope {
  const delivery = requireOutputRecord(reviewedDelivery, "visual-review delivery");
  const report = requireOutputRecord(delivery.report, "visual-review report");
  const scope = requireOutputRecord(report.reviewScope, "visual-review scope");
  if (scope.reviewStage !== "rendered_video"
    || typeof scope.evidenceId !== "string"
    || !/^[a-f0-9]{64}$/.test(scope.evidenceId)
    || !Array.isArray(scope.actualModels)) {
    throw new Error("Final visual review is missing a valid rendered-video evidence scope.");
  }
  return scope as unknown as VisualReviewScope;
}

function visualReviewModelProof(
  review: IndependentVisualReviewExecution,
  evidenceId: string | undefined,
): VisualReviewScope["actualModels"][number] {
  const iterations = review.agentLoop?.iterations ?? [];
  const producerDigests = [...new Set(iterations.flatMap((iteration) => (
    iteration.candidateTrace?.contractDigest ? [iteration.candidateTrace.contractDigest] : []
  )))];
  const auditDigests = [...new Set(iterations.flatMap((iteration) => (
    iteration.auditTrace?.contractDigest ? [iteration.auditTrace.contractDigest] : []
  )))];
  // "跑完了"指的是这一分支按合同产出了完整的取证链，不是它的审计投了赞成票。
  // 审计没通过只说明这份意见本身有瑕疵——那要如实标出来给用户看（auditVerdict），
  // 但不能替他决定作品能不能发。
  const loopCompleted = review.agentLoop?.status === "passed" || review.agentLoop?.status === "awaiting_user";
  const producerCompleted = loopCompleted
    && iterations.length > 0
    && iterations.every((iteration) => Boolean(iteration.candidateTrace?.contractDigest));
  const auditCompleted = loopCompleted
    && iterations.length > 0
    && iterations.every((iteration) => Boolean(iteration.auditTrace?.contractDigest));
  const auditVerdict = review.agentLoop?.iterations.at(-1)?.audit.verdict;
  return {
    providerId: review.providerId,
    modelId: review.modelId,
    ...(evidenceId ? { evidenceId } : {}),
    ...(producerDigests.length === 1 ? { producerContractDigest: producerDigests[0] } : {}),
    ...(auditDigests.length === 1 ? { auditContractDigest: auditDigests[0] } : {}),
    producerCompleted,
    auditCompleted,
    ...(auditVerdict ? { auditVerdict } : {}),
  };
}

function assertDualVisualReviewReady(reviewedDelivery: unknown, brief: ProductionBrief): void {
  const delivery = requireOutputRecord(reviewedDelivery, "visual-review delivery");
  const report = requireOutputRecord(delivery.report, "visual-review report");
  const scope = finalVisualReviewScope(delivery);
  if (scope.actualModels.length !== 2
    || new Set(scope.actualModels.map((model) => model.providerId)).size !== 2
    || new Set(scope.actualModels.map((model) => model.modelId)).size !== 2) {
    throw new Error("Final publication requires two distinct actual visual-review providers and models.");
  }
  for (const model of scope.actualModels) {
    if (model.evidenceId !== scope.evidenceId
      || model.producerCompleted !== true
      || model.auditCompleted !== true
      || typeof model.producerContractDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(model.producerContractDigest)
      || typeof model.auditContractDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(model.auditContractDigest)) {
      throw new Error("Final publication requires complete producer and audit proof for both visual-review models on the same evidence.");
    }
  }
  if (new Set(scope.actualModels.map((model) => model.producerContractDigest)).size !== 1
    || new Set(scope.actualModels.map((model) => model.auditContractDigest)).size !== 1) {
    throw new Error("Final visual-review branches did not use the same producer and audit contracts.");
  }
  // 证据必须由**当前**这套审片合同产出：结论是按某套判据裁出来的，判据换了，旧结论就不再等价。
  //
  // 比对的基准是当前要求的合同，不是 run 建立时冻结在 brief 里的那一份。冻结值做闸门会把升级前
  // 建立的 run 永久锁死，而且锁得没有出路：流水线自己会用当前合同重跑审片节点（补查），重跑出来
  // 的证据摘要必然是当前合同的，与冻结值再也不可能相等——于是这个 run 既不能发布，也没有任何
  // 操作能改变这一点，而拒绝文案还说不出该做什么。冻结值仍留在 brief 里作为来源记录，只在下面
  // 的文案里用于说明"这个制作建于更早的合同"。
  const requiredProducerContract = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["visual-review"];
  const requiredAuditContract = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["role-audit"];
  const staleContractModels = scope.actualModels.filter((model) => (
    model.producerContractDigest !== requiredProducerContract
    || model.auditContractDigest !== requiredAuditContract
  ));
  if (staleContractModels.length > 0) {
    const origin = brief.taskContractDigests?.["visual-review"] === requiredProducerContract
      ? ""
      : "（这个制作建立时用的是更早的审片合同）";
    throw new Error(
      `这份双模型审片证据是更早的审片合同产出的${origin}：`
      + staleContractModels
        .map((model) => `${model.providerId}/${model.modelId} 用 ${String(model.producerContractDigest).slice(0, 12)}…`)
        .join("、")
      + `，当前要求 ${requiredProducerContract.slice(0, 12)}…。不能用它发布成片。`
      + "请先补查现有成片，让两个模型按当前合同重新审一遍，再走终审；补查只重跑审片，不会重买画面或配音。",
    );
  }
  if (!Array.isArray(report.independentReviews) || report.independentReviews.length !== 2) {
    throw new Error("Final publication requires both independent visual-review reports.");
  }
  const scopedIdentities = new Set(scope.actualModels.map((model) => `${model.providerId}\u0000${model.modelId}`));
  const reportedIdentities = new Set(report.independentReviews.map((entry, index) => {
    const review = requireOutputRecord(entry, `independent visual review ${index + 1}`);
    if (typeof review.providerId !== "string" || typeof review.modelId !== "string") {
      throw new Error("Independent visual-review identity is invalid.");
    }
    return `${review.providerId}\u0000${review.modelId}`;
  }));
  if (reportedIdentities.size !== 2 || [...reportedIdentities].some((identity) => !scopedIdentities.has(identity))) {
    throw new Error("Independent visual-review reports do not match the actual model proof.");
  }
}

function assertTechnicalReviewReady(output: unknown): void {
  const technical = requireOutputRecord(output, "technical-review output");
  if (technical.passed !== true || typeof technical.reviewPath !== "string" || !technical.reviewPath) {
    throw new Error("Final publication requires a completed passing technical review.");
  }
}

function assertPublishEvidenceReady(context: WorkflowContext, brief: ProductionBrief): void {
  assertTechnicalReviewReady(context.outputs.get("technical-review"));
  const finalReview = requireOutputRecord(context.outputs.get("final-review"), "final-review output");
  const currentArtifactIds = currentFinalReviewArtifactIds(context, brief, context.outputs.get("visual-review"));
  if (JSON.stringify(finalReviewArtifactIdsFromOutput(finalReview)) !== JSON.stringify(currentArtifactIds)) {
    throw new Error("Final approval is not bound to the current review artifact versions.");
  }
  if (brief.runPurpose !== "test" || brief.providers.visualReview) {
    assertDualVisualReviewReady(context.outputs.get("visual-review"), brief);
    const scope = finalVisualReviewScope(context.outputs.get("visual-review"));
    if (finalReview.reviewEvidenceId !== scope.evidenceId) {
      throw new Error("Final approval is not bound to the current visual evidence digest.");
    }
    // 逐条表态是这次批准的签字，发布时要能指着它对上"被批准的那份证据"。缺了它，
    // 批准就退化成一句无法复核的"我看过了"。
    //
    // 但签字只在"这轮终审确实要求人工批准"时才该存在：manual 模式每轮都要人批；
    // automatic 模式只有在审片判定阻断时才会升级给人（见 final-review 的 execute），
    // 判定通过时流程自动走完，此时没有也不该有签字——那是设计好的免人工路径，不是丢证据。
    const approval = [...context.decisions].reverse().find((candidate) => (
      candidate.action === "approve" && candidate.reviewEvidenceId === scope.evidenceId
    ));
    if (!approval && brief.reviewMode === "manual") {
      throw new Error("Final publication requires a recorded operator decision for the current evidence.");
    }
    if (approval) assertFinalReviewDispositions(context.outputs.get("visual-review"), approval.reviewDispositions);
  }
}

function assertPersistedFinalApprovalReady(
  run: WorkflowRun<ProductionBrief>,
  brief: ProductionBrief,
  finalReviewNode: WorkflowRun["nodeRuns"][number],
): void {
  const uncertain = run.nodeRuns.find((node) => node.outcomeUncertain === true);
  if (uncertain) {
    throw new Error(`Final approval is blocked while paid node '${uncertain.nodeId}' has an unknown outcome.`);
  }
  const technicalNode = run.nodeRuns.find((node) => node.nodeId === "technical-review");
  if (technicalNode?.status !== "succeeded") {
    throw new Error("Final approval requires a completed technical-review node.");
  }
  assertTechnicalReviewReady(technicalNode.output);
  const output = validateFinalReviewInput(finalReviewNode.output, Boolean(brief.seriesContext));
  const artifactIds = finalReviewArtifactIdsFromOutput(output);
  if (JSON.stringify(finalReviewNode.intervention?.artifactIds ?? []) !== JSON.stringify(artifactIds)) {
    throw new Error("Final approval intervention is not bound to the current review artifacts.");
  }
  for (const artifactId of artifactIds) {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    const producer = artifact?.producer?.nodeId;
    const producerNode = run.nodeRuns.find((node) => node.nodeId === producer);
    const currentVersion = producerNode?.outputState?.versions.find(
      (version) => version.id === producerNode.outputState?.effectiveVersionId,
    );
    if (!artifact || !currentVersion?.artifactIds.includes(artifactId)) {
      throw new Error("Final approval references a review artifact that is no longer current.");
    }
  }
  if (brief.runPurpose !== "test" || brief.providers.visualReview) {
    const visualNode = run.nodeRuns.find((node) => node.nodeId === "visual-review");
    if (visualNode?.status !== "succeeded") {
      throw new Error("Final approval requires a completed visual-review node.");
    }
    assertDualVisualReviewReady(visualNode.output, brief);
    const scope = finalVisualReviewScope(visualNode.output);
    if (output.reviewEvidenceId !== scope.evidenceId) {
      throw new Error("Final approval is not bound to the current visual evidence digest.");
    }
  }
}

function requireOutputRecord(output: unknown, nodeId: string): Record<string, unknown> {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error(`${nodeId} override must be an object.`);
  }
  return output as Record<string, unknown>;
}

function outputPath(context: WorkflowContext, nodeId: string, field: string): string {
  const output = context.outputs.get(nodeId);
  if (typeof output !== "object" || output === null || !(field in output)) {
    throw new Error(`Node '${nodeId}' did not produce '${field}'.`);
  }
  const value = (output as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Node '${nodeId}' produced an invalid '${field}'.`);
  }
  return value;
}

function outputStringArray(output: unknown, field: string, requireField = false): string[] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    if (requireField) throw new Error(`${field} must be present as an array with at most 8 strings.`);
    return [];
  }
  const value = (output as Record<string, unknown>)[field];
  if (value === undefined) {
    if (requireField) throw new Error(`${field} must be present as an array with at most 8 strings.`);
    return [];
  }
  if (!Array.isArray(value) || value.length > 8) throw new Error(`${field} must contain at most 8 strings.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 240) {
      throw new Error(`${field}[${index}] must be a non-empty string no longer than 240 characters.`);
    }
    return entry.trim();
  });
}

function visualReviewRecommendation(input: unknown): VisualReviewReport["recommendation"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const report = (input as Record<string, unknown>).report;
  if (typeof report !== "object" || report === null || Array.isArray(report)) return undefined;
  const recommendation = (report as Record<string, unknown>).recommendation;
  return recommendation === "approve" || recommendation === "revise" || recommendation === "reject"
    ? recommendation
    : undefined;
}

/**
 * 操作员逐条表态的持久键。只用主张内容算摘要，不含版本号、证据 id 与数组下标——
 * 前两者一重跑审片就变，后者换个顺序就串位。代价是模型换一种措辞描述同一处问题时
 * 会被当成新的一条，需要重新表态；这个代价是可见的（界面上会显示还未表态），
 * 比"表态悄悄绑到另一条问题上"安全。
 */
export function visualReviewFindingKey(finding: VisualReviewFinding): string {
  return createHash("sha256").update(JSON.stringify({
    timecodeMs: finding.timecodeMs,
    startTimecodeMs: finding.startTimecodeMs,
    endTimecodeMs: finding.endTimecodeMs,
    scenePosition: finding.scenePosition,
    targetNodeId: finding.targetNodeId,
    // 要重做哪一段是这条主张的一部分：同一条问题指向 treatment 还是 director，
    // 代价差一整轮素材重做。不把它算进键，改段就会被当成同一条沿用旧表态。
    planningStageId: finding.planningStageId,
    claimType: finding.claimType,
    evidenceStatus: finding.evidenceStatus,
    evidenceFrameSha256: finding.evidenceFrameSha256,
    nextAction: finding.nextAction,
    category: finding.category,
    severity: finding.severity,
    description: finding.description,
    suggestion: finding.suggestion,
  })).digest("hex");
}

function currentVisualReviewFindings(delivery: unknown): VisualReviewFinding[] {
  if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery)) return [];
  const report = (delivery as Record<string, unknown>).report;
  if (typeof report !== "object" || report === null || Array.isArray(report)) return [];
  const findings = (report as Record<string, unknown>).findings;
  return Array.isArray(findings) ? findings as VisualReviewFinding[] : [];
}

/**
 * 审片只给建议，最终裁决在操作员，所以"批准"这句话必须落到每一条建议上：
 * 每一条都要有表态，且没有任何一条是被采纳的——采纳意味着还要返修，此时批准自相矛盾。
 * 没有审片结论（未接入视觉审片、或审片没提出问题）时不做要求。
 */
function assertFinalReviewDispositions(delivery: unknown, dispositions: HumanReviewDisposition[] | undefined): void {
  const findings = currentVisualReviewFindings(delivery);
  if (findings.length === 0) return;
  const byKey = new Map((dispositions ?? []).map((disposition) => [disposition.itemKey, disposition]));
  const undecided = findings.filter((finding) => !byKey.has(visualReviewFindingKey(finding)));
  if (undecided.length > 0) {
    throw new Error(
      `批准前需要对全部 ${findings.length} 条审片结论逐条表态，当前还有 ${undecided.length} 条未表态。`,
    );
  }
  const accepted = findings.filter((finding) => byKey.get(visualReviewFindingKey(finding))?.decision === "accept");
  if (accepted.length > 0) {
    throw new Error(
      `有 ${accepted.length} 条你已采纳的审片结论尚未返修，不能批准发布；请先按它们返修，或改为不采纳并写明理由。`,
    );
  }
}

function visualReviewEvidenceId(context: WorkflowContext, artifactIds: string[]): string {
  const selected = context.artifacts
    .filter((artifact) => artifactIds.includes(artifact.id))
    .map((artifact) => ({
      id: artifact.id,
      nodeId: artifact.producer?.nodeId,
      sha256: artifact.sha256,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}

async function localizeVisualReviewReport(
  report: VisualReviewReport,
  renderManifestPath: string,
  actualDurationMs?: number,
): Promise<VisualReviewReport> {
  const manifest = requireOutputRecord(
    JSON.parse(await readFile(renderManifestPath, "utf8")),
    "render manifest",
  );
  if (!Array.isArray(manifest.slides) || manifest.slides.length === 0) {
    throw new Error("Render manifest slides are required to localize visual review findings.");
  }
  const slides = manifest.slides.map((value, index) => {
    const slide = requireOutputRecord(value, `render manifest slide ${index + 1}`);
    const scenePosition = Number(slide.scene_position ?? slide.position);
    const durationMs = Number(slide.duration) * 1_000;
    if (!Number.isInteger(scenePosition) || scenePosition < 1 || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error(`Render manifest slide ${index + 1} cannot localize visual review findings.`);
    }
    return { scenePosition, durationMs };
  });
  const manifestDurationMs = slides.reduce((sum, slide) => sum + slide.durationMs, 0);
  if (actualDurationMs !== undefined && (!Number.isFinite(actualDurationMs) || actualDurationMs <= 0)) {
    throw new Error("Inspected video duration must be positive to localize visual review findings.");
  }
  const timelineScale = actualDurationMs === undefined ? 1 : actualDurationMs / manifestDurationMs;
  let startMs = 0;
  const scenes = slides.map((slide, index) => {
    const endMs = index === slides.length - 1 && actualDurationMs !== undefined
      ? actualDurationMs
      : startMs + slide.durationMs * timelineScale;
    const timing = { scenePosition: slide.scenePosition, startMs, endMs };
    startMs = endMs;
    return timing;
  });
  return {
    ...report,
    findings: report.findings.map((finding) => {
      const scene = scenes.find((timing, index) => (
        finding.timecodeMs >= timing.startMs
        && (finding.timecodeMs < timing.endMs || (index === scenes.length - 1 && finding.timecodeMs <= timing.endMs))
      ));
      if (!scene) throw new Error(`Visual review finding at ${finding.timecodeMs}ms is outside the render manifest timeline.`);
      if (finding.scenePosition !== scene.scenePosition) {
        throw new Error(
          `Visual review finding at ${finding.timecodeMs}ms claims scene ${finding.scenePosition}, but the render manifest maps it to scene ${scene.scenePosition}.`,
        );
      }
      return finding;
    }),
  };
}

/**
 * 素材节点认的语义合格线，与 Python 侧 `stock_assets.MIN_MODEL_SEMANTIC_SCORE` 同值。
 * 两边必须一致：这里判断"还有没有合格候选可换"，那边决定"换过去的候选会不会被筛掉"。
 */
const MIN_STOCK_CANDIDATE_SEMANTIC_SCORE = 40;

interface RankedStockCandidate {
  entry: Record<string, unknown>;
  index: number;
  provider: string;
  assetId: string;
  rank: number;
  locked: boolean;
  semanticScore: number;
}

/**
 * 把某一镜的下一名合格候选提到首位，返回改过的排序与这次换用的两端身份。
 *
 * 素材节点按排序依次取第一个能下载的候选，所以"换素材"就是改排序，不必动检索。
 * 合格门槛与素材节点逐条对齐：排序来自模型时按语义分，否则只有锁定候选算数——
 * 这条路径只在这个集合内部换，换不出一个系统本来就不会用的候选。
 */
export function advanceSceneCandidateRanking(
  ranking: Record<string, unknown>,
  scenePosition: number,
): {
  ranking: Record<string, unknown>;
  replaced: { provider: string; assetId: string };
  replacement: { provider: string; assetId: string };
} {
  const scenes = Array.isArray(ranking.scenes) ? ranking.scenes : undefined;
  if (!scenes) throw new Error("Candidate ranking scenes must be an array.");
  const scoresVerified = ranking.source === "model";
  const sceneIndex = scenes.findIndex((value) => (
    typeof value === "object" && value !== null && !Array.isArray(value)
    && Number((value as Record<string, unknown>).scenePosition) === scenePosition
  ));
  if (sceneIndex < 0) throw new Error(`Candidate ranking has no entry for scene ${scenePosition}.`);
  const scene = requireOutputRecord(scenes[sceneIndex], `candidate ranking scene ${scenePosition}`);
  const candidates = Array.isArray(scene.candidates) ? scene.candidates : undefined;
  if (!candidates) throw new Error(`Candidate ranking scene ${scenePosition} has no candidates.`);
  const ordered: RankedStockCandidate[] = [];
  candidates.forEach((value, index) => {
    const entry = requireOutputRecord(value, `candidate ranking entry ${index}`);
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const assetId = typeof entry.assetId === "string" ? entry.assetId.trim() : "";
    if (!provider || !assetId) return;
    const rank = Number(entry.rank);
    const locked = entry.locked === true;
    const semanticScore = scoresVerified ? Number(entry.semanticScore ?? 0) : 0;
    if (!locked && semanticScore < MIN_STOCK_CANDIDATE_SEMANTIC_SCORE) return;
    ordered.push({
      entry,
      index,
      provider,
      assetId,
      rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
      locked,
      semanticScore,
    });
  });
  ordered.sort((left, right) => (Number(right.locked) - Number(left.locked)) || (left.rank - right.rank));
  if (ordered.length < 2) {
    throw new Error(
      `Scene ${scenePosition} has no second qualified candidate to switch to; `
      + "rewrite this scene's narration or adjust the plan instead of taking an unreviewed asset.",
    );
  }
  const replaced = ordered[0]!;
  const replacement = ordered[1]!;
  // 把换上的候选与其余候选按新次序重排名次，而不是只对调两个数值：
  // 名次重复时对调等于没换，而名次是素材节点唯一的取舍依据。
  const resequenced = [replacement, replaced, ...ordered.slice(2)];
  const baseRank = replaced.rank;
  const ranks = new Map(resequenced.map((item, offset) => [item.index, baseRank + offset]));
  const revisedCandidates = candidates.map((value, index) => {
    const rank = ranks.get(index);
    if (rank === undefined) return value;
    return { ...requireOutputRecord(value, `candidate ranking entry ${index}`), rank };
  });
  return {
    ranking: {
      ...ranking,
      scenes: scenes.map((value, index) => (
        index === sceneIndex ? { ...scene, candidates: revisedCandidates } : value
      )),
    },
    replaced: { provider: replaced.provider, assetId: replaced.assetId },
    replacement: { provider: replacement.provider, assetId: replacement.assetId },
  };
}

function reviseAssetPlanByReuse(
  plan: Record<string, unknown>,
  scenePosition: number,
  reuseFromScenePosition: number,
): Record<string, unknown> {
  if (!Array.isArray(plan.scene_assets) || plan.scene_assets.length === 0) {
    throw new Error("Asset plan scenes are required for a scene revision.");
  }
  const scenePositions = new Set<number>();
  const scenes = plan.scene_assets.map((value, index) => {
    const scene = requireOutputRecord(value, `asset plan scene ${index + 1}`);
    const position = Number(scene.scene_position);
    if (!Number.isInteger(position) || position < 1) {
      throw new Error(`Asset plan scene ${index + 1} position is invalid.`);
    }
    if (scenePositions.has(position)) {
      throw new Error(`Asset plan has duplicate scene position ${position}.`);
    }
    scenePositions.add(position);
    return structuredClone(scene);
  });
  const scenesByPosition = new Map(scenes.map((scene) => [Number(scene.scene_position), scene] as const));
  for (const start of scenes) {
    const chain = new Set<number>();
    let current: Record<string, unknown> | undefined = start;
    while (current?.reuse_from_scene_position !== undefined) {
      const position = Number(current.scene_position);
      if (chain.has(position)) {
        throw new Error(`Asset plan has a reuse cycle at scene ${position}.`);
      }
      chain.add(position);
      const reusePosition = Number(current.reuse_from_scene_position);
      if (!Number.isInteger(reusePosition) || reusePosition < 1) {
        throw new Error(`Asset plan scene ${position} has an invalid reuse source.`);
      }
      current = scenesByPosition.get(reusePosition);
      if (!current) {
        throw new Error(`Asset plan scene ${position} has missing reuse source scene ${reusePosition}.`);
      }
    }
  }
  for (const scene of scenes) {
    if (scene.reuse_from_scene_position === undefined) continue;
    const position = Number(scene.scene_position);
    const reusePosition = Number(scene.reuse_from_scene_position);
    if (reusePosition >= position) {
      throw new Error(`Asset plan scene ${position} must reuse an earlier scene.`);
    }
  }
  const target = scenes.find((scene) => Number(scene.scene_position) === scenePosition);
  const source = scenes.find((scene) => Number(scene.scene_position) === reuseFromScenePosition);
  if (!target) throw new Error(`Asset plan does not contain reviewed scene ${scenePosition}.`);
  if (!source) throw new Error(`Asset plan does not contain reuse source scene ${reuseFromScenePosition}.`);
  if (typeof source.local_path !== "string" || !source.local_path.trim()) {
    throw new Error(`Reuse source scene ${reuseFromScenePosition} has no materialized media.`);
  }
  if (
    source.media_type === "editorial_card"
    || source.provider === "local"
    || String(source.provider ?? "").includes("editorial")
    || String(source.source_url ?? "").startsWith("local://video-factory/card")
  ) {
    throw new Error(`Reuse source scene ${reuseFromScenePosition} editorial card cannot be reused as footage.`);
  }
  const reuseAsset = (
    current: Record<string, unknown>,
    reused: Record<string, unknown>,
    reusePosition: number,
  ): Record<string, unknown> => ({
    ...reused,
    scene_position: current.scene_position,
    ...(current.duration !== undefined ? { duration: current.duration } : {}),
    ...(current.duration_frames !== undefined ? { duration_frames: current.duration_frames } : {}),
    ...(current.source_in_frame !== undefined ? { source_in_frame: current.source_in_frame } : {}),
    ...(current.asset_key !== undefined ? { asset_key: current.asset_key } : {}),
    ...(current.crop !== undefined ? { crop: structuredClone(current.crop) } : {}),
    ...(current.query !== undefined ? { query: current.query } : {}),
    reuse_from_scene_position: reusePosition,
  });
  const revisedScenes = scenes.map((scene) => Number(scene.scene_position) === scenePosition
    ? reuseAsset(scene, source, reuseFromScenePosition)
    : scene);
  const revisedByPosition = new Map(
    revisedScenes.map((scene) => [Number(scene.scene_position), scene] as const),
  );
  const pending = [scenePosition];
  const propagated = new Set<number>();
  while (pending.length > 0) {
    const changedPosition = pending.shift()!;
    if (propagated.has(changedPosition)) continue;
    propagated.add(changedPosition);
    const changed = revisedByPosition.get(changedPosition)!;
    for (const [index, candidate] of revisedScenes.entries()) {
      if (Number(candidate.reuse_from_scene_position) !== changedPosition) continue;
      const candidatePosition = Number(candidate.scene_position);
      const next = reuseAsset(candidate, changed, changedPosition);
      revisedScenes[index] = next;
      revisedByPosition.set(candidatePosition, next);
      pending.push(candidatePosition);
    }
  }
  const revisedRoutes = Array.isArray(plan.director_routing)
    ? plan.director_routing.map((value, index) => {
        const route = requireOutputRecord(value, `director route ${index + 1}`);
        const position = Number(route.scene_position);
        if (!propagated.has(position)) return structuredClone(route);
        const revisedScene = revisedByPosition.get(position)!;
        return {
          ...route,
          actual_provider_id: revisedScene.provider,
          actual_provider: revisedScene.provider,
          fallback_used: false,
          generation_pending: false,
          reuse_from_scene_position: revisedScene.reuse_from_scene_position,
        };
      })
    : undefined;
  return {
    ...structuredClone(plan),
    scene_assets: revisedScenes,
    ...(revisedRoutes ? { director_routing: revisedRoutes } : {}),
  };
}

async function mediaArtifactIdsReferencedByPlan(
  runRoot: string,
  artifacts: readonly Artifact[],
  currentArtifactIds: readonly string[],
  plan: Record<string, unknown>,
): Promise<string[]> {
  if (!Array.isArray(plan.scene_assets)) {
    throw new Error("Asset plan scenes are required to select current media artifacts.");
  }
  const selected = new Set<string>();
  for (const [index, value] of plan.scene_assets.entries()) {
    const scene = requireOutputRecord(value, `asset plan scene ${index + 1}`);
    const localPath = requiredOutputString(scene, "local_path");
    const artifact = artifacts.find((candidate) => (
      currentArtifactIds.includes(candidate.id)
      && candidate.kind === "media_asset"
      && candidate.uri === localPath
      && candidate.producer?.nodeId === "assets"
    ));
    if (!artifact) {
      throw new Error(`Asset plan scene ${Number(scene.scene_position)} does not reference a current media artifact.`);
    }
    await verifyStoredArtifactWithinRoot(runRoot, artifact);
    selected.add(artifact.id);
  }
  return [...selected];
}

async function verifyStoredArtifactWithinRoot(runRoot: string, artifact: Artifact): Promise<void> {
  if (!artifact.uri || !artifact.sha256 || artifact.sizeBytes === undefined) {
    throw new Error(`Artifact '${artifact.id}' is missing file integrity metadata.`);
  }
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(runRoot), realpath(artifact.uri)]);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Artifact '${artifact.id}' is outside run '${path.basename(runRoot)}'.`);
  }
  await verifyArtifactBytes(resolvedPath, artifact.sha256, artifact.sizeBytes);
}

async function verifyNodeOverrideBoundary(runRoot: string, override: NodeOverrideDraft): Promise<void> {
  const resolvedRoot = await realpath(runRoot);
  const paths = collectOutputPaths(override.output);
  for (const artifact of override.artifacts ?? []) {
    if (artifact.producer && artifact.producer.nodeId !== override.nodeId) {
      throw new Error(`Override artifact producer must be node '${override.nodeId}'.`);
    }
    if (!artifact.uri) continue;
    paths.push(artifact.uri);
    if (!artifact.sha256 || artifact.sizeBytes === undefined) {
      throw new Error("Override file artifacts require sha256 and sizeBytes.");
    }
    await verifyArtifactBytes(artifact.uri, artifact.sha256, artifact.sizeBytes);
  }
  for (const candidate of new Set(paths)) {
    const resolvedPath = await realpath(candidate);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Override path '${candidate}' is outside run '${path.basename(runRoot)}'.`);
    }
  }
}

async function verifyNodeInputOverrideBoundary(runRoot: string, override: NodeInputOverrideDraft): Promise<void> {
  const resolvedRoot = await realpath(runRoot);
  for (const candidate of new Set(collectOutputPaths(override.input, "input"))) {
    const resolvedPath = await realpath(candidate);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Input override path '${candidate}' is outside run '${path.basename(runRoot)}'.`);
    }
  }
}

function collectOutputPaths(value: unknown, field = "output"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectOutputPaths(item, `${field}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childField = `${field}.${key}`;
    if (isFileReferenceKey(key) && typeof child === "string" && child) paths.push(child);
    else paths.push(...collectOutputPaths(child, childField));
  }
  return paths;
}

function isFileReferenceKey(key: string): boolean {
  return key === "uri"
    || key.endsWith("Path")
    || key.endsWith("_path")
    || key.endsWith("_file");
}

function jsonArtifact(
  kind: string,
  data: unknown,
  schemaVersion: string,
  nodeId: string,
  parentArtifactIds: string[],
): ArtifactDraft {
  const serialized = JSON.stringify(data);
  return {
    kind,
    data,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    sizeBytes: Buffer.byteLength(serialized),
    contentType: "application/json",
    schemaVersion,
    parentArtifactIds,
    producer: { nodeId, attempt: 1 },
    provenance: { providerId: "video-factory-ts-v1", providerVersion: "1" },
  };
}

function fileArtifact(
  kind: string,
  uri: string,
  content: string,
  contentType: string,
  schemaVersion: string,
  nodeId: string,
  parentArtifactIds: string[],
  providerId: string,
  licenseNote: string,
  attempt = 1,
  // 创作规划 commit 协议：把正式产物与 planningCommitKey 绑定，供崩溃恢复发现与校验。
  producerRequestDigest?: string,
): ArtifactDraft {
  return {
    kind,
    uri,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    contentType,
    schemaVersion,
    parentArtifactIds,
    producer: { nodeId, attempt },
    provenance: {
      providerId,
      providerVersion: "1",
      licenseNote,
      ...(producerRequestDigest !== undefined ? { producerRequestDigest } : {}),
    },
  };
}

async function binaryFileArtifact(
  kind: string,
  uri: string,
  contentType: string,
  schemaVersion: string,
  nodeId: string,
  parentArtifactIds: string[],
  providerId: string,
  licenseNote: string,
  attempt = 1,
): Promise<ArtifactDraft> {
  const content = await readFile(uri);
  return {
    kind,
    uri,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.byteLength,
    contentType,
    schemaVersion,
    parentArtifactIds,
    producer: { nodeId, attempt },
    provenance: { providerId, providerVersion: "1", licenseNote },
  };
}

async function failedAgentLoopNodeResult(options: {
  error: RoleAgentLoopError;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
  provider: Pick<Provider, "id" | "modelId" | "transport" | "billing" | "configurationSource" | "parameters" | "estimatedCostCny">;
  providerLabel: string;
  output?: Record<string, unknown>;
  additionalArtifacts?: ArtifactDraft[];
}): Promise<NodeExecutionResult<Record<string, unknown>>> {
  const traceArtifact = await persistModelTrace({
    trace: options.error.lastTrace,
    attemptDirectory: options.attemptDirectory,
    nodeId: options.nodeId,
    attempt: options.attempt,
    parentArtifactIds: options.parentArtifactIds,
  });
  const loopArtifact = await persistAgentLoopTrace({
    loop: options.error.agentLoop,
    attemptDirectory: options.attemptDirectory,
    nodeId: options.nodeId,
    attempt: options.attempt,
    parentArtifactIds: options.parentArtifactIds,
  });
  const receipt = options.error.lastTrace
    ? modelTraceReceipt(
        options.error.lastTrace,
        options.providerLabel,
        options.provider.billing === "metered" ? "metered" : "subscription",
        options.error.agentLoop,
        options.provider.configurationSource ?? "system_default",
      )
    : {
        providerId: options.provider.id,
        providerLabel: options.providerLabel,
        modelId: options.provider.modelId ?? options.provider.id,
        transport: options.provider.transport ?? "unix_socket" as const,
        billing: options.provider.billing ?? "subscription" as const,
        configurationSource: options.provider.configurationSource ?? "system_default" as const,
        parameters: {
          ...(options.provider.parameters ?? {}),
          agentLoop: "failed",
          agentLoopIterations: options.error.agentLoop.iterations.length,
          modelCallCount: options.error.agentLoop.modelCallCount ?? 0,
        },
      };
  if (options.provider.billing === "metered") {
    const meteredAttemptCount = Math.max(
      0,
      options.error.agentLoop.producerModelCallCount
        ?? options.error.agentLoop.iterations.length + (options.error.agentLoop.pendingCandidate ? 1 : 0),
    );
    receipt.meteredAttemptCount = meteredAttemptCount;
    if (options.provider.estimatedCostCny !== undefined) {
      receipt.estimatedCostCny = roundCurrency(options.provider.estimatedCostCny * meteredAttemptCount);
    }
  }
  return {
    status: "failed",
    error: options.error.message,
    ...(options.output ? { output: options.output } : {}),
    receipt,
    artifacts: [
      ...(options.additionalArtifacts ?? []),
      traceArtifact,
      loopArtifact,
    ].filter((artifact): artifact is ArtifactDraft => Boolean(artifact)),
  };
}

async function failedModelCandidatesNodeResult(options: {
  error: Error & { attempts: ModelCandidateAttempt[] };
  taskKind: CodexTaskKind;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
  provider: Pick<Provider, "transport" | "billing" | "configurationSource" | "parameters">;
  providerLabel: string;
}): Promise<NodeExecutionResult<Record<string, unknown>>> {
  const attempts = options.error.attempts;
  const finalAttempt = attempts.at(-1);
  if (!finalAttempt || attempts.some((attempt) => attempt.outcome !== "failed")) {
    throw new Error("Model candidate exhaustion must contain at least one failed attempt.");
  }
  const traceArtifact = await persistModelCandidateFailureTrace({
    taskKind: options.taskKind,
    attempts,
    attemptDirectory: options.attemptDirectory,
    nodeId: options.nodeId,
    attempt: options.attempt,
    parentArtifactIds: options.parentArtifactIds,
  });
  return {
    status: "failed",
    error: options.error.message,
    receipt: {
      providerId: finalAttempt.providerId,
      providerLabel: options.providerLabel,
      modelId: finalAttempt.modelId,
      transport: options.provider.transport ?? "unix_socket",
      billing: options.provider.billing ?? "subscription",
      configurationSource: options.provider.configurationSource ?? "system_default",
      parameters: { ...(options.provider.parameters ?? {}) },
      actualModelIds: attempts.map(({ modelId }) => modelId),
      fallbackReason: options.error.message,
      ...(attempts.length > 1 ? { fallbackFromProviderId: attempts[0]!.providerId } : {}),
    },
    artifacts: [traceArtifact],
  };
}

async function failedIndependentVisualReviewNodeResult(options: {
  error: IndependentVisualReviewError;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
  provider: Pick<Provider, "id" | "modelId" | "transport" | "billing" | "configurationSource" | "parameters">;
  providerLabel: string;
}): Promise<NodeExecutionResult<Record<string, unknown>>> {
  const branches = [
    ...options.error.completedReviews.map(({ providerId, modelId }) => ({ providerId, modelId, status: "succeeded" as const })),
    ...options.error.failures.map(({ providerId, modelId, error }) => ({
      providerId,
      modelId,
      status: "failed" as const,
      reason: publicFallbackReason(error),
    })),
  ];
  const statusPath = path.join(options.attemptDirectory, "independent_review_branches.json");
  const statusPayload = {
    version: "video-factory/independent-review-branches-v1",
    status: "partial",
    branches,
  };
  const statusContent = `${JSON.stringify(statusPayload, null, 2)}\n`;
  await writeTextAtomically(statusPath, statusContent);
  const statusArtifact = fileArtifact(
    "review_branch_status",
    statusPath,
    statusContent,
    "application/json",
    "video-factory/independent-review-branches-v1",
    options.nodeId,
    options.parentArtifactIds,
    options.provider.id,
    "Final visual-review branch status; completed branch checkpoints are reused on retry.",
    options.attempt,
  );
  const completedTraceArtifacts = (await Promise.all(options.error.completedReviews.flatMap((review, index) => [
    persistModelTrace({
      trace: review.trace,
      attemptDirectory: options.attemptDirectory,
      nodeId: options.nodeId,
      attempt: options.attempt,
      parentArtifactIds: options.parentArtifactIds,
      fileSuffix: `-completed-${index + 1}`,
    }),
    persistAgentLoopTrace({
      loop: review.agentLoop,
      attemptDirectory: options.attemptDirectory,
      nodeId: options.nodeId,
      attempt: options.attempt,
      parentArtifactIds: options.parentArtifactIds,
      fileSuffix: `-completed-${index + 1}`,
    }),
  ]))).filter((artifact): artifact is ArtifactDraft => Boolean(artifact));
  const attemptedModelIds = [...new Set(branches.map(({ modelId }) => modelId))];
  const failedBranch = options.error.failures.at(-1);
  return {
    status: "failed",
    error: `${options.error.message} 已完成分支保留，重试只继续未完成分支。`,
    output: {
      independentReviewStatus: statusPayload,
    },
    receipt: {
      providerId: failedBranch?.providerId ?? options.provider.id,
      providerLabel: options.providerLabel,
      modelId: failedBranch?.modelId ?? options.provider.modelId ?? options.provider.id,
      transport: options.provider.transport ?? "unix_socket",
      billing: options.provider.billing ?? "subscription",
      configurationSource: options.provider.configurationSource ?? "system_default",
      parameters: {
        ...(options.provider.parameters ?? {}),
        independentReviewStatus: "partial",
        completedReviewBranches: options.error.completedReviews.length,
        failedReviewBranches: options.error.failures.length,
      },
      actualModelIds: attemptedModelIds,
      fallbackReason: options.error.message,
    },
    artifacts: [statusArtifact, ...completedTraceArtifacts],
  };
}

async function persistModelCandidateFailureTrace(options: {
  taskKind: CodexTaskKind;
  attempts: ModelCandidateAttempt[];
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
}): Promise<ArtifactDraft> {
  const finalAttempt = options.attempts.at(-1);
  if (!finalAttempt) throw new Error("Model candidate failure trace requires at least one attempt.");
  const tracePath = path.join(options.attemptDirectory, "model_candidate_failures.json");
  const payload = {
    version: "video-factory/model-candidate-failures-v1",
    taskKind: options.taskKind,
    status: "failed",
    attemptedModelIds: options.attempts.map(({ modelId }) => modelId),
    modelCandidateAttempts: options.attempts,
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeTextAtomically(tracePath, content);
  const artifact = fileArtifact(
    "model_trace",
    tracePath,
    content,
    "application/json",
    "video-factory/model-candidate-failures-v1",
    options.nodeId,
    options.parentArtifactIds,
    finalAttempt.providerId,
    "Ordered public model-candidate failure trace; raw errors and unavailable prompts are not stored.",
    options.attempt,
  );
  artifact.provenance = { ...artifact.provenance, model: finalAttempt.modelId };
  return artifact;
}

async function persistModelTrace(options: {
  trace: CodexTaskTrace | undefined;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
  fileSuffix?: string;
}): Promise<ArtifactDraft | undefined> {
  if (!options.trace) return undefined;
  const tracePath = path.join(options.attemptDirectory, `model_trace${options.fileSuffix ?? ""}.json`);
  const payload = {
    version: "video-factory/model-trace-v1",
    taskKind: options.trace.taskKind,
    promptVersion: options.trace.promptVersion,
    ...(options.trace.contractDigest ? { contractDigest: options.trace.contractDigest } : {}),
    providerId: options.trace.providerId,
    modelId: options.trace.modelId,
    ...(options.trace.reasoningEffort ? { reasoningEffort: options.trace.reasoningEffort } : {}),
    ...(options.trace.fallbackFromModelId ? { fallbackFromModelId: options.trace.fallbackFromModelId } : {}),
    ...(options.trace.fallbackReason ? { fallbackReason: options.trace.fallbackReason } : {}),
    ...(options.trace.attemptedModelIds?.length ? { attemptedModelIds: options.trace.attemptedModelIds } : {}),
    ...(options.trace.modelCandidateAttempts?.length
      ? { modelCandidateAttempts: options.trace.modelCandidateAttempts }
      : {}),
    ...(options.trace.queueWaitMs !== undefined ? { queueWaitMs: options.trace.queueWaitMs } : {}),
    ...(options.trace.providerWaitMs !== undefined ? { providerWaitMs: options.trace.providerWaitMs } : {}),
    ...(options.trace.firstOutputEventMs !== undefined ? { firstOutputEventMs: options.trace.firstOutputEventMs } : {}),
    ...(options.trace.toolMs !== undefined ? { toolMs: options.trace.toolMs } : {}),
    ...(options.trace.validationMs !== undefined ? { validationMs: options.trace.validationMs } : {}),
    prompt: options.trace.prompt,
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeTextAtomically(tracePath, content);
  const artifact = fileArtifact(
    "model_trace",
    tracePath,
    content,
    "application/json",
    "video-factory/model-trace-v1",
    options.nodeId,
    options.parentArtifactIds,
    options.trace.providerId,
    "Immutable execution trace containing the exact prompt, prompt pack, provider, and model; no credentials are stored.",
    options.attempt,
  );
  artifact.provenance = {
    ...artifact.provenance,
    promptVersion: options.trace.promptVersion,
    model: options.trace.modelId,
  };
  return artifact;
}

async function persistAgentLoopTrace(options: {
  loop: AgentLoopTrace | undefined;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
  fileSuffix?: string;
}): Promise<ArtifactDraft | undefined> {
  if (!options.loop) return undefined;
  const tracePath = path.join(options.attemptDirectory, `agent_loop_trace${options.fileSuffix ?? ""}.json`);
  const payload = {
    ...options.loop,
    iterations: options.loop.iterations.map((iteration) => ({
      iteration: iteration.iteration,
      candidate: iteration.candidate,
      candidateHash: iteration.candidateHash,
      ...(iteration.candidateTrace ? { producer: iteration.candidateTrace } : {}),
      audit: iteration.audit,
      ...(iteration.auditTrace ? { auditor: iteration.auditTrace } : {}),
    })),
    ...(options.loop.pendingCandidate ? {
      pendingCandidate: {
        iteration: options.loop.pendingCandidate.iteration,
        candidate: options.loop.pendingCandidate.candidate,
        candidateHash: options.loop.pendingCandidate.candidateHash,
        ...(options.loop.pendingCandidate.candidateTrace ? { producer: options.loop.pendingCandidate.candidateTrace } : {}),
      },
    } : {}),
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeTextAtomically(tracePath, content);
  return fileArtifact(
    "agent_loop_trace",
    tracePath,
    content,
    "application/json",
    "video-factory/agent-loop-v1",
    options.nodeId,
    options.parentArtifactIds,
    options.loop.iterations.at(-1)?.auditTrace?.providerId ?? "openai",
    "Independent role audit and bounded repair history; credentials and hidden reasoning are not stored.",
    options.attempt,
  );
}

function publicFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactAbsolutePaths(message).slice(0, 500);
}

function redactAbsolutePaths(value: string): string {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return "[系统托管文件]";
  return value
    .replace(
      /(^|[\s"'`(=])\/(?:Users|home|var|tmp|private|opt|srv|etc|run|root|mnt|Volumes|workspace)(?:\/[^\s"'`<>),;\]}]+)+/g,
      "$1[系统托管文件]",
    )
    .replace(/(^|[\s"'`(=])[A-Za-z]:\\[^\s"'`<>),;\]}]+/g, "$1[系统托管文件]");
}

function nodeAgentLoopCheckpoint(
  runsRoot: string,
  runId: string,
  nodeId: string,
  input: unknown,
  contractVersion: string,
  modelId?: string,
  workflowOperationRequestId?: string,
  resumeCompletedTextTaskNodeId?: string,
  resumeCompletedTextTaskRequestId?: string,
  recoverWorkflowOperationRequestId?: string,
): ReturnType<typeof fileRoleAgentLoopCheckpoint> {
  // 同一制作内沿用 running checkpoint；人工重试 exhausted 节点时开启新 cycle，避免回放旧失败终态。
  const key = roleAgentCheckpointKey({ runId, nodeId, input, contractVersion, ...(modelId ? { modelId } : {}) });
  return fileRoleAgentLoopCheckpoint(
    path.join(runsRoot, runId, "nodes", nodeId, "agent-loop-checkpoints", `${key}.json`),
    key,
    {
      restartExhausted: true,
      ...(resumeCompletedTextTaskNodeId === nodeId && resumeCompletedTextTaskRequestId
        ? { resumeCompletedFailureRequestId: resumeCompletedTextTaskRequestId }
        : {}),
      recoverOwnedPending: true,
      ...(recoverWorkflowOperationRequestId
        ? { recoverPendingOwner: { runId, nodeId, workflowOperationRequestId: recoverWorkflowOperationRequestId } }
        : {}),
      ...(workflowOperationRequestId
        ? { recoveryOwner: { runId, nodeId, workflowOperationRequestId } }
        : {}),
    },
  );
}

/**
 * 简报节点的独立复核。裁决只落在节点 checkpoint 上（界面按 node.agentLoopProgress 读它），
 * 不进节点产物：brief 的产物必须逐字节仍是一份合法简报，多挂一个字段就会被 validateOverride 剥掉，
 * 而且审计没有权力改变这个节点的结果——pass 与 repair 都一样是 succeeded，暂停由边界闸门负责。
 *
 * 审计自己失败不改变本节点：建议缺席比整个制作停摆轻得多。原因不会消失，它以 failed/halted
 * 阶段留在同一份 checkpoint 里，界面照这句话说「模型调用已停止，请查看失败原因」。
 */
async function recordBriefAudit(
  bindings: Array<{ providerId: string; agent: BriefAuditAgent }> | undefined,
  validatedBrief: ProductionBrief,
  context: WorkflowContext,
  runsRoot: string,
): Promise<void> {
  // provider 不可用时图仍要能建出来（续跑会用到它），没有绑定就跳过复核，不在这里抛。
  if (!bindings?.length) return;
  const agent = new FallbackBriefAuditAgent({ candidates: bindings });
  const checkpointInput = { stage: "brief", brief: briefAuditProjection(validatedBrief) };
  try {
    await agent.auditBrief({
      brief: validatedBrief,
      agentLoopCheckpoint: nodeAgentLoopCheckpoint(
        runsRoot,
        context.runId,
        "brief",
        checkpointInput,
        BRIEF_AUDIT_AGENT_CONTRACT_VERSION,
        undefined,
        context.operationRequestId,
      ),
      // 每个候选模型一份 checkpoint：A 失败兜底到 B 之后，B 的进度同样可恢复。
      agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
        runsRoot,
        context.runId,
        "brief",
        checkpointInput,
        BRIEF_AUDIT_AGENT_CONTRACT_VERSION,
        modelId,
        context.operationRequestId,
      ),
      // 操作者在简报节点上选定的首选模型，键就是上面那个能力键；没选就让候选按 broker 顺序排。
      ...(validatedBrief.models?.[BRIEF_AUDIT_PROVIDER_ID]
        ? { selectedModelId: validatedBrief.models[BRIEF_AUDIT_PROVIDER_ID] }
        : {}),
    });
  } catch {
    // 故意的静默：这里没有第二条汇报通道（节点产物不能带附加字段），而失败原因已经由
    // role-agent-loop 写进 checkpoint 的 failed 阶段，界面读的就是那份记录。
  }
}

function visualReinspectionCyclePath(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId, "nodes", "visual-review", ".reinspection-cycle");
}

async function currentVisualReinspectionCycle(runsRoot: string, runId: string): Promise<string> {
  try {
    const value = (await readFile(visualReinspectionCyclePath(runsRoot, runId), "utf8")).trim();
    return /^[0-9a-f-]{36}$/.test(value) ? value : "initial";
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "initial";
    throw error;
  }
}

async function writeTextAtomically(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
}

async function reserveAttemptDirectory(root: string): Promise<{ directory: string; attempt: number }> {
  await mkdir(root, { recursive: true });
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const directory = path.join(root, `attempt-${attempt}`);
    try {
      await mkdir(directory);
      return { directory, attempt };
    } catch (error) {
      if (hasCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error(`No execution attempt directory is available under '${root}'.`);
}

async function currentArtifactsForPackaging(context: WorkflowContext, brief: ProductionBrief): Promise<Artifact[]> {
  const nodeOutputs = [
    ...(usesJointCreativePlanning(brief)
      ? jointPlanningPackagingEntry(context)
      : [
          { nodeId: "script", paths: [outputPath(context, "script", "scriptPath")] },
          ...(brief.director ? [{ nodeId: "visual-direction", paths: [outputPath(context, "visual-direction", "directorPlanPath")] }] : []),
          ...(brief.workflowFeatures?.assetSemanticRank ? [
            { nodeId: "asset-candidates", paths: [outputPath(context, "asset-candidates", "candidateSearchPath")] },
            { nodeId: "asset-semantic-rank", paths: [outputPath(context, "asset-semantic-rank", "candidateRankingPath")] },
          ] : []),
        ]),
    ...(brief.workflowFeatures?.referenceGrammar ? [{ nodeId: "reference-grammar", paths: [outputPath(context, "reference-grammar", "referenceGrammarPath")] }] : []),
    { nodeId: "assets", paths: [outputPath(context, "assets", "assetPlanPath")] },
    { nodeId: "voice", paths: [outputPath(context, "voice", "voiceoverPlanPath"), outputPath(context, "voice", "trackPath")] },
    { nodeId: "render", paths: [outputPath(context, "render", "videoPath"), outputPath(context, "render", "renderManifestPath")] },
    { nodeId: "technical-review", paths: [outputPath(context, "technical-review", "reviewPath")] },
    ...(brief.providers.visualReview ? [{ nodeId: "visual-review", paths: [outputPath(context, "visual-review", "visualReviewPath")] }] : []),
  ];
  const selected: Artifact[] = [];
  const briefArtifact = [...context.artifacts].reverse().find((artifact) => artifact.producer?.nodeId === "brief");
  if (briefArtifact) selected.push(briefArtifact);
  for (const nodeOutput of nodeOutputs) {
    const matches = nodeOutput.paths.flatMap((outputUri) => {
      const artifact = [...context.artifacts].reverse().find((candidate) =>
        candidate.producer?.nodeId === nodeOutput.nodeId
        && candidate.uri !== undefined
        && path.resolve(candidate.uri) === path.resolve(outputUri));
      return artifact ? [artifact] : [];
    });
    if (matches.length === 0) throw new Error(`Current node '${nodeOutput.nodeId}' has no matching artifact descriptor.`);
    const assetOutput = nodeOutput.nodeId === "assets"
      ? requireOutputRecord(context.outputs.get("assets"), "current assets output")
      : undefined;
    if (assetOutput && Array.isArray(assetOutput.currentMediaArtifactIds)) {
      const planArtifact = matches[0]!;
      const mediaArtifactIds = assetOutput.currentMediaArtifactIds.map((value, index) => {
        if (typeof value !== "string" || !value) {
          throw new Error(`Current assets output media artifact id ${index + 1} is invalid.`);
        }
        return value;
      });
      if (mediaArtifactIds.length !== new Set(mediaArtifactIds).size) {
        throw new Error("Current assets output contains duplicate media artifact ids.");
      }
      const plan = requireOutputRecord(
        JSON.parse(await readFile(planArtifact.uri!, "utf8")),
        "current asset plan",
      );
      if (!Array.isArray(plan.scene_assets) || plan.scene_assets.length === 0) {
        throw new Error("Current asset plan has no scene assets for packaging.");
      }
      if (!selected.some((candidate) => candidate.id === planArtifact.id)) selected.push(planArtifact);
      const referencedPaths = new Set<string>();
      for (const [index, value] of plan.scene_assets.entries()) {
        const scene = requireOutputRecord(value, `current asset plan scene ${index + 1}`);
        referencedPaths.add(path.resolve(requiredOutputString(scene, "local_path")));
      }
      const mediaArtifacts = mediaArtifactIds.map((artifactId) => {
        const artifact = context.artifacts.find((candidate) => (
          candidate.id === artifactId
          && candidate.producer?.nodeId === "assets"
          && (candidate.kind === "media_asset" || candidate.kind === "human_media_revision")
          && candidate.uri !== undefined
        ));
        if (!artifact) throw new Error(`Current assets output references invalid media artifact '${artifactId}'.`);
        return artifact;
      });
      const mediaPaths = new Set(mediaArtifacts.map((artifact) => path.resolve(artifact.uri!)));
      if (
        mediaPaths.size !== referencedPaths.size
        || [...mediaPaths].some((mediaPath) => !referencedPaths.has(mediaPath))
      ) {
        throw new Error("Current asset plan and media artifact ids do not describe the same files.");
      }
      for (const artifact of mediaArtifacts) {
        if (!selected.some((candidate) => candidate.id === artifact.id)) selected.push(artifact);
      }
      continue;
    }
    const currentAttempts = new Set(matches.flatMap((artifact) => artifact.producer ? [artifact.producer.attempt] : []));
    const currentNodeArtifacts = context.artifacts.filter((artifact) =>
      artifact.producer?.nodeId === nodeOutput.nodeId
      && currentAttempts.has(artifact.producer.attempt)
      && (matches.some((match) => match.id === artifact.id)
        || artifact.kind === "media_asset"
        || artifact.kind === "human_media_revision"));
    for (const artifact of currentNodeArtifacts) {
      if (!selected.some((candidate) => candidate.id === artifact.id)) selected.push(artifact);
    }
  }
  return selected;
}

function publishArtifactDescriptor(artifact: Artifact): Record<string, unknown> {
  const sourceUrl = publishableSourceUrl(artifact.provenance.sourceUrl);
  return {
    id: artifact.id,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    provenance: {
      ...(artifact.provenance.providerId ? { providerId: artifact.provenance.providerId } : {}),
      ...(artifact.provenance.providerVersion ? { providerVersion: artifact.provenance.providerVersion } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(artifact.provenance.creator ? { creator: artifact.provenance.creator } : {}),
      ...(artifact.provenance.licenseNote ? { licenseNote: artifact.provenance.licenseNote } : {}),
      ...(artifact.provenance.promptVersion ? { promptVersion: artifact.provenance.promptVersion } : {}),
      ...(artifact.provenance.model ? { model: artifact.provenance.model } : {}),
    },
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
    ...(artifact.parentArtifactIds ? { parentArtifactIds: [...artifact.parentArtifactIds] } : {}),
    ...(artifact.producer ? { producer: { ...artifact.producer } } : {}),
  };
}

interface ProductionResourceManifestItem {
  id: string;
  category: "visual" | "voice" | "font" | "document" | "other";
  kind: string;
  providerId: string;
  sourceUrl?: string;
  creator?: string;
  licenseNote?: string;
  contentType?: string;
  sha256?: string;
  scenePosition?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  query?: string;
  semanticTags?: string[];
  selectedInFinal?: boolean;
  commercialUse: "self_owned" | "provider_terms" | "review_required";
  attributionRequirement: "not_required" | "provider_terms" | "unknown";
  reviewStatus: "recorded" | "needs_review";
}

interface ProductionResourceManifest {
  version: "video-factory/resource-manifest-v1";
  runId: string;
  items: ProductionResourceManifestItem[];
}

async function buildResourceManifest(runId: string, artifacts: Artifact[]): Promise<ProductionResourceManifest> {
  const assetPlan = artifacts.find((artifact) => artifact.kind === "asset_plan" && artifact.uri)?.uri;
  const sceneItems = assetPlan ? await assetPlanResourceItems(assetPlan, artifacts) : [];
  const sceneHashes = new Set(sceneItems.flatMap((item) => item.sha256 ? [item.sha256] : []));
  const items = artifacts
    .filter((artifact) => artifact.kind !== "media_asset" || !artifact.sha256 || !sceneHashes.has(artifact.sha256))
    .map((artifact): ProductionResourceManifestItem => resourceItemFromArtifact(artifact));
  items.push(...sceneItems);
  const renderManifest = artifacts.find((artifact) => artifact.kind === "render_manifest" && artifact.uri)?.uri;
  if (renderManifest) {
    const font = await renderFontResourceItem(renderManifest);
    if (font) items.push(font);
  }
  return { version: "video-factory/resource-manifest-v1", runId, items: uniqueResourceItems(items) };
}

function resourceItemFromArtifact(artifact: Artifact): ProductionResourceManifestItem {
  const providerId = artifact.provenance.providerId ?? "unknown";
  const licenseNote = artifact.provenance.licenseNote;
  const privateReference = artifact.kind === "reference_video" || providerId === "creator-upload";
  const selfOwned = !privateReference && (providerId.startsWith("video-factory") || providerId === "local-editorial-v1");
  const sourceUrl = publishableSourceUrl(artifact.provenance.sourceUrl);
  return {
    id: `artifact:${artifact.id}`,
    category: resourceCategory(artifact.kind, artifact.contentType, artifact.producer?.nodeId),
    kind: artifact.kind,
    providerId,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(artifact.provenance.creator ? { creator: artifact.provenance.creator } : {}),
    ...(licenseNote ? { licenseNote } : {}),
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    commercialUse: selfOwned ? "self_owned" : privateReference ? "review_required" : licenseNote ? "provider_terms" : "review_required",
    attributionRequirement: selfOwned ? "not_required" : privateReference ? "unknown" : licenseNote ? "provider_terms" : "unknown",
    reviewStatus: privateReference ? "needs_review" : licenseNote ? "recorded" : "needs_review",
  };
}

async function assetPlanResourceItems(assetPlanPath: string, artifacts: Artifact[]): Promise<ProductionResourceManifestItem[]> {
  const plan = requireOutputRecord(JSON.parse(await readFile(assetPlanPath, "utf8")), "asset plan resource manifest");
  if (!Array.isArray(plan.scene_assets)) return [];
  return plan.scene_assets.flatMap((value, index) => {
    if (!isObjectRecord(value)) return [];
    const localPath = optionalText(value.local_path);
    const mediaArtifact = localPath
      ? artifacts.find((artifact) => artifact.uri && path.resolve(artifact.uri) === path.resolve(localPath))
      : undefined;
    const humanRevision = mediaArtifact?.kind === "human_media_revision";
    // 版权与来源是服务端证据，不信任可编辑 asset plan 中的 provider/license 字段。
    const providerId = normalizedSceneProviderId(mediaArtifact?.provenance.providerId ?? "unverified-media");
    const sourceUrl = mediaArtifact?.provenance.sourceUrl;
    const publicSourceUrl = publishableSourceUrl(sourceUrl);
    const creator = mediaArtifact?.provenance.creator;
    const licenseNote = mediaArtifact?.provenance.licenseNote;
    const scenePosition = optionalPositiveInteger(value.scene_position) ?? optionalPositiveInteger(value.position) ?? index + 1;
    const width = optionalPositiveInteger(value.width);
    const height = optionalPositiveInteger(value.height);
    const durationSeconds = optionalPositiveNumber(value.duration);
    const query = optionalText(value.query);
    const semanticTags = query ? query.split(/[\s,，、/]+/u).filter(Boolean).slice(0, 24) : [];
    const mediaType = optionalText(value.media_type) ?? optionalText(value.asset_type);
    const selfOwned = Boolean(mediaArtifact) && !humanRevision
      && (providerId.startsWith("video-factory") || providerId === "local-editorial-v1");
    const evidenceRecorded = Boolean(mediaArtifact && licenseNote);
    return [{
      id: `scene:${scenePosition}:${providerId}`,
      category: "visual" as const,
      kind: mediaType ? `scene_${mediaType}` : "scene_asset",
      providerId,
      ...(publicSourceUrl ? { sourceUrl: publicSourceUrl } : {}),
      ...(creator ? { creator } : {}),
      ...(licenseNote ? { licenseNote } : {}),
      ...(mediaArtifact?.contentType ? { contentType: mediaArtifact.contentType } : {}),
      ...(mediaArtifact?.sha256 ? { sha256: mediaArtifact.sha256 } : {}),
      scenePosition,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(query ? { query } : {}),
      ...(semanticTags.length ? { semanticTags } : {}),
      selectedInFinal: true,
      commercialUse: selfOwned ? "self_owned" as const : humanRevision ? "review_required" as const : evidenceRecorded ? "provider_terms" as const : "review_required" as const,
      attributionRequirement: selfOwned ? "not_required" as const : humanRevision ? "unknown" as const : evidenceRecorded ? "provider_terms" as const : "unknown" as const,
      reviewStatus: humanRevision ? "needs_review" as const : evidenceRecorded ? "recorded" as const : "needs_review" as const,
    }];
  });
}

function publishableSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedSceneProviderId(value: string): string {
  return ({
    local: "local-editorial-v1",
    pexels: "pexels-stock-v1",
    pixabay: "pixabay-stock-v1",
    mock: "mock-stock-v1",
  } as Record<string, string>)[value] ?? value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function renderFontResourceItem(renderManifestPath: string): Promise<ProductionResourceManifestItem | undefined> {
  const manifest = requireOutputRecord(JSON.parse(await readFile(renderManifestPath, "utf8")), "render manifest resource inventory");
  const font = isObjectRecord(manifest.font_resource) ? manifest.font_resource : undefined;
  const family = optionalText(font?.family);
  if (!family) return undefined;
  const licenseNote = optionalText(font?.license_note);
  const licenseVerified = font?.license_verified === true;
  return {
    id: `font:${family}`,
    category: "font",
    kind: "font",
    providerId: "system-font",
    creator: family,
    ...(licenseNote ? { licenseNote } : {}),
    commercialUse: licenseVerified ? "provider_terms" : "review_required",
    attributionRequirement: licenseVerified ? "provider_terms" : "unknown",
    reviewStatus: licenseVerified ? "recorded" : "needs_review",
  };
}

function resourceCategory(kind: string, contentType?: string, producerNodeId?: string): ProductionResourceManifestItem["category"] {
  if (producerNodeId === "voice" || kind === "voiceover" || contentType?.startsWith("audio/")) return "voice";
  if (kind === "media_asset" || kind === "render" || contentType?.startsWith("video/") || contentType?.startsWith("image/")) return "visual";
  if (contentType === "application/json" || kind.endsWith("_plan") || kind.endsWith("_report")) return "document";
  return "other";
}

function requiresRightsReviewCategory(category: ProductionResourceManifestItem["category"]): boolean {
  return category === "visual" || category === "voice" || category === "font";
}

function uniqueResourceItems(items: ProductionResourceManifestItem[]): ProductionResourceManifestItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifyWorkerArtifacts(response: WorkerResponse, outputDir: string): Promise<void> {
  for (const artifact of response.artifacts) {
    const [root, artifactPath] = await Promise.all([realpath(outputDir), realpath(artifact.uri)]);
    const relative = path.relative(root, artifactPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Worker artifact '${artifact.uri}' is outside attempt directory '${root}'.`);
    }
    await verifyArtifactBytes(artifactPath, artifact.sha256, artifact.sizeBytes);
  }
}

async function verifyWorkerPrivateOutputPath(value: unknown, outputDir: string): Promise<void> {
  if (typeof value !== "string" || !value) throw new Error("Asset search did not produce a private candidate inventory.");
  const resolvedRoot = await realpath(outputDir);
  const resolvedPath = await realpath(value);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Worker private output path '${value}' is outside attempt directory '${resolvedRoot}'.`);
  }
}

async function verifyStoredArtifacts(artifacts: readonly Artifact[]): Promise<void> {
  for (const artifact of artifacts) {
    if (!artifact.uri) {
      continue;
    }
    if (!artifact.sha256 || artifact.sizeBytes === undefined) {
      throw new Error(`Artifact '${artifact.id}' is missing integrity metadata.`);
    }
    await verifyArtifactBytes(artifact.uri, artifact.sha256, artifact.sizeBytes);
  }
}

async function verifyExecutablePlanInput(
  input: Record<string, unknown>,
  context: WorkflowContext,
  runsRoot: string,
): Promise<void> {
  const planPath = optionalOutputString(input.executablePlanPath);
  if (!planPath) return;
  const artifact = [...context.artifacts].reverse().find((candidate) => (
    candidate.kind === "executable_plan"
    // joint-v1 的可执行方案由 creative-planning 编译登记，不再经过 production-preflight。
    && (candidate.producer?.nodeId === "production-preflight" || candidate.producer?.nodeId === "creative-planning")
    && candidate.uri === planPath
  ));
  if (!artifact || artifact.schemaVersion !== "video-factory/executable-plan-v1") {
    throw new Error("Executable production plan input is not bound to the current planning artifact.");
  }
  await verifyStoredArtifactWithinRoot(path.join(runsRoot, context.runId), artifact);
  const plan = parseExecutableProductionPlan(JSON.parse(await readFile(planPath, "utf8")));
  await verifyExecutablePlanReferenceClosure(plan, artifact, context, path.join(runsRoot, context.runId));
}

// 报价/执行前的正式引用闭包：可执行方案必须是规划节点当前 output 指向的正式方案，
// 其内部 treatment/script/director/candidate 引用必须唯一解析到本 run 产物。缺失、跨 run、
// 旧版（不属于当前接受 output / 与引用集不同一次规划 commit）、重复登记或篡改一律
// fail closed。严格性按显式拓扑判定：creative-planning 产物为 joint（引用集必须共享同一
// commit digest，且 plan 自带 digest 时必须一致——缺 digest 不再隐式跳过）；production-
// preflight 为 legacy（唯一解析 + kind + 完整性）。joint 还核验证据链父关系。
// 读取规划节点当前 effective output version 的 artifactIds（BG-01 membership 绑定）。
// run.json 缺失/不可解析/节点不存在时返回 undefined：调用方跳过 membership 检查，
// 但引用唯一性/parent/SHA 校验仍然全部执行——不能因读取失败放松闭包。
async function currentPlanningVersionArtifactIds(
  runJsonPath: string,
  nodeId: string,
): Promise<string[] | undefined> {
  try {
    const run = JSON.parse(await readFile(runJsonPath, "utf8")) as Record<string, unknown>;
    if (!Array.isArray(run.nodeRuns)) return undefined;
    const node = (run.nodeRuns as Array<Record<string, unknown>>).find(
      (value) => typeof value === "object" && value !== null && value.nodeId === nodeId,
    );
    if (typeof node !== "object" || node === null || typeof node.outputState !== "object" || node.outputState === null) return undefined;
    const state = node.outputState as { effectiveVersionId?: unknown; versions?: unknown };
    if (typeof state.effectiveVersionId !== "string" || !Array.isArray(state.versions)) return undefined;
    const version = (state.versions as Array<Record<string, unknown>>).find(
      (candidate) => typeof candidate === "object" && candidate !== null && candidate.id === state.effectiveVersionId,
    );
    if (typeof version !== "object" || version === null || !Array.isArray(version.artifactIds)) return undefined;
    return version.artifactIds.filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

async function verifyExecutablePlanReferenceClosure(
  plan: ExecutableProductionPlan,
  planArtifact: Artifact,
  context: WorkflowContext,
  runRoot: string,
): Promise<void> {
  // 当前接受绑定：被消费的 plan 必须正是规划节点当前 output 指向的文件；
  // 旧版本/被替换的方案不得继续驱动报价与执行。
  const ownerOutput = planArtifact.producer?.nodeId
    ? context.outputs.get(planArtifact.producer.nodeId)
    : undefined;
  const currentPlanPath = ownerOutput !== undefined
    ? optionalOutputString(requireOutputRecord(ownerOutput, "planning output").executablePlanPath)
    : undefined;
  if (!currentPlanPath || currentPlanPath !== planArtifact.uri) {
    throw new Error("Executable plan input is not the current accepted planning output; the run has a newer plan.");
  }
  const references: Array<{ id: string; kind: string; parentOf?: string }> = [];
  if (plan.treatmentArtifactId !== undefined) references.push({ id: plan.treatmentArtifactId, kind: "creative_treatment", parentOf: "script" });
  references.push(
    { id: plan.scriptArtifactId, kind: "script" },
    { id: plan.directorArtifactId, kind: "storyboard" },
  );
  const candidateKinds = ["asset_candidates", "asset_ranking"];
  if (plan.candidateArtifactIds.length > 0) {
    if (plan.candidateArtifactIds.length !== candidateKinds.length) {
      throw new Error("Executable plan candidate references must bind exactly one candidates artifact and one ranking artifact.");
    }
    plan.candidateArtifactIds.forEach((id, index) => references.push({
      id,
      kind: candidateKinds[index]!,
      ...(candidateKinds[index] === "asset_ranking" ? { parentOf: "asset_candidates" } : {}),
    }));
  }
  const producerNodeId = planArtifact.producer?.nodeId;
  const joint = producerNodeId === "creative-planning";
  const planDigest = planArtifact.provenance?.producerRequestDigest;
  if (joint && plan.treatmentArtifactId === undefined) {
    // joint 路线的 treatment 是必需引用：可省略仅限 legacy（production-preflight）历史拓扑。
    throw new Error("Executable plans produced by the joint planning stage must reference their creative treatment artifact.");
  }
  const referencedArtifacts = new Map<string, Artifact>();
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.id)) {
      throw new Error(`Executable plan references artifact '${reference.id}' more than once.`);
    }
    seen.add(reference.id);
    const matches = context.artifacts.filter((candidate) => candidate.id === reference.id);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Executable plan reference '${reference.id}' (${reference.kind}) does not resolve in this run.`
          : `Executable plan reference '${reference.id}' resolves to ${matches.length} registered artifacts.`,
      );
    }
    const referenced = matches[0]!;
    referencedArtifacts.set(reference.kind, referenced);
    if (referenced.kind !== reference.kind) {
      throw new Error(`Executable plan reference '${reference.id}' is kind '${referenced.kind}', expected '${reference.kind}'.`);
    }
    if (joint && referenced.producer?.nodeId !== producerNodeId) {
      throw new Error(`Executable plan reference '${reference.id}' was produced by '${referenced.producer?.nodeId ?? "unknown"}', not the planning producer.`);
    }
    await verifyStoredArtifactWithinRoot(runRoot, referenced);
  }
  if (joint) {
    // BG-01：闭包绑定当前 effective output version membership——plan 与全部引用必须同属
    // 规划节点当前接受版本的 artifactIds，不能只从全局历史 registry 解析。
    // （legacy 的支撑产物分布在不同节点版本中，membership 仅约束 joint。）
    if (ownerOutput !== undefined) {
      const currentVersionArtifactIds = await currentPlanningVersionArtifactIds(
        path.join(path.dirname(runRoot), context.runId, "run.json"),
        producerNodeId ?? "",
      );
      if (currentVersionArtifactIds !== undefined) {
        const membership = new Set(currentVersionArtifactIds);
        if (!membership.has(planArtifact.id)) {
          throw new Error("Executable plan artifact is not a member of the current accepted planning output version.");
        }
        for (const reference of references) {
          if (!membership.has(reference.id)) {
            throw new Error(`Executable plan reference '${reference.id}' (${reference.kind}) is not a member of the current accepted planning output version.`);
          }
        }
      }
    }
    // 引用集必须同属一次规划 commit：digest 不一致或缺失都说明证据集不构成一个当前
    // 接受集合——不以“plan 缺 digest”为由隐式降级。
    const digests = new Set(references.map((reference) => referencedArtifacts.get(reference.kind)!.provenance?.producerRequestDigest));
    if (digests.size !== 1 || digests.has(undefined)) {
      throw new Error("Executable plan references do not share one planning commit; the evidence set is not a current accepted set.");
    }
    if (planDigest !== undefined && planDigest !== [...digests][0]) {
      throw new Error("Executable plan belongs to a different planning commit than its references; the reference closure is stale.");
    }
    // 证据链父关系：稿件←构思；导演方案←稿件；排序←候选。
    const parentExpectations: Array<[string, string]> = [
      ["script", "creative_treatment"],
      ["storyboard", "script"],
      ["asset_ranking", "asset_candidates"],
    ];
    for (const [childKind, parentKind] of parentExpectations) {
      const child = referencedArtifacts.get(childKind);
      const parent = referencedArtifacts.get(parentKind);
      if (!child || !parent) continue;
      if (!(child.parentArtifactIds ?? []).includes(parent.id)) {
        throw new Error(`Executable plan reference closure is broken: '${childKind}' does not link its '${parentKind}' evidence parent.`);
      }
    }
  }
}

async function verifyArtifactBytes(uri: string, expectedSha256: string, expectedSizeBytes: number): Promise<void> {
  const content = await readFile(uri);
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Artifact '${uri}' sha256 does not match its descriptor.`);
  }
  if (content.byteLength !== expectedSizeBytes) {
    throw new Error(`Artifact '${uri}' size does not match its descriptor.`);
  }
}

async function readPaidNodeReconciliationRecord(pathname: string): Promise<PaidNodeReconciliationRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const manualResolution = isObjectRecord(value)
    && (value.outcome === "confirmed_not_charged" || value.outcome === "confirmed_charged");
  if (!isObjectRecord(value)
    || value.version !== "video-factory/paid-reconciliation-v1"
    || typeof value.reconciliationId !== "string"
    || typeof value.nodeId !== "string"
    || !["resume_original", "requote", "confirmed_not_charged", "confirmed_charged"].includes(String(value.outcome))
    || (value.itemRequestId !== undefined && (
      typeof value.itemRequestId !== "string"
      || !value.itemRequestId
      || value.itemRequestId.length > 256
    ))
    || (value.taskId !== undefined && (typeof value.taskId !== "string" || !value.taskId || value.taskId.length > 256))
    || (value.actor !== undefined && (typeof value.actor !== "string" || !value.actor || value.actor.length > 160))
    || (value.note !== undefined && (typeof value.note !== "string" || !value.note || value.note.length > 2_000))
    || (value.actualCostCny !== undefined && (
      typeof value.actualCostCny !== "number"
      || !Number.isFinite(value.actualCostCny)
      || value.actualCostCny < 0
    ))
    || (value.reportedActualCostCny !== undefined && (
      typeof value.reportedActualCostCny !== "number"
      || !Number.isFinite(value.reportedActualCostCny)
      || value.reportedActualCostCny < 0
    ))
    || (manualResolution && (typeof value.actor !== "string" || typeof value.note !== "string"))
    || (!manualResolution && (value.actor !== undefined || value.note !== undefined || value.actualCostCny !== undefined))
    || (value.outcome === "confirmed_charged" && typeof value.actualCostCny !== "number")
    || (value.outcome !== "confirmed_charged" && value.reportedActualCostCny !== undefined)
    || (value.itemRequestId !== undefined && (
      value.nodeId !== "assets"
      || (value.outcome !== "confirmed_charged" && value.outcome !== "confirmed_not_charged")
    ))
    || (value.outcome !== "resume_original" && value.taskId !== undefined)
    || !Number.isInteger(value.expectedRunRevision)
    || (value.status !== "in_progress" && value.status !== "completed")
    || typeof value.createdAt !== "string"
    || (value.resultingRunRevision !== undefined && !Number.isInteger(value.resultingRunRevision))) {
    throw new Error("Paid reconciliation record is incompatible or corrupted.");
  }
  return value as unknown as PaidNodeReconciliationRecord;
}

function originalPaidEstimate(
  run: WorkflowRun<ProductionBrief>,
  node: WorkflowRun<ProductionBrief>["nodeRuns"][number],
): number | undefined {
  const authorization = run.spendAuthorizations?.find((candidate) => candidate.id === node.spendAuthorizationId);
  const candidates = [
    node.spendPlan?.estimatedCostCny,
    node.executionReceipt?.estimatedCostCny,
    run.executionPlan?.find((candidate) => candidate.nodeId === node.nodeId)?.estimatedCostCny,
    authorization?.maxCostCny,
  ];
  return candidates.find((candidate): candidate is number => (
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
  ));
}

function applyConfirmedChargedResolution(
  previous: WorkflowRun<ProductionBrief>,
  nodeId: string,
  operationId: string | undefined,
  actualCostCny: number,
  actualCostSource: "provider_reported" | "configured_rate" | "manual_reconciled",
  reconciledAt: string,
): WorkflowRun<ProductionBrief> {
  const run = structuredClone(previous);
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId)!;
  const executionPlan = run.executionPlan?.find((candidate) => candidate.nodeId === nodeId);
  const nodeStartedAt = typeof node.startedAt === "string" && node.startedAt ? node.startedAt : undefined;
  const receiptStartedAt = nodeStartedAt ?? reconciledAt;
  const authorizationId = node.spendAuthorizationId;
  const authorization = run.spendAuthorizations?.find((candidate) => candidate.id === authorizationId);
  const providerId = node.executionReceipt?.providerId ?? executionPlan?.providerId ?? node.spendPlan?.providerId;
  const modelId = node.executionReceipt?.modelId ?? executionPlan?.modelId ?? node.spendPlan?.modelId;
  if (!providerId || !modelId) {
    throw new Error(`Node '${nodeId}' is missing the paid provider identity required for charge reconciliation.`);
  }
  const receipt: NonNullable<typeof node.executionReceipt> = {
    ...(node.executionReceipt ?? executionPlan ?? {
      providerId,
      providerLabel: providerId,
      modelId,
      transport: "http_api" as const,
      billing: "metered" as const,
    }),
    nodeId,
    ...(node.role ? { role: node.role } : {}),
    capability: node.executionReceipt?.capability ?? executionPlan?.capability ?? "asset.prepare",
    providerId,
    modelId,
    billing: "metered",
    status: "failed",
    estimatedCostCny: originalPaidEstimate(run, node) ?? actualCostCny,
    actualCostCny,
    actualCostSource,
    meteredAttemptCount: Math.max(1, node.executionReceipt?.meteredAttemptCount ?? 0),
    meteredFailedAttemptCount: Math.max(1, node.executionReceipt?.meteredFailedAttemptCount ?? 0),
    ...(operationId ? { requestId: operationId } : {}),
    ...(authorizationId ? { spendAuthorizationId: authorizationId } : {}),
    ...(authorization ? { authorizedCostCny: authorization.maxCostCny } : {}),
    startedAt: receiptStartedAt,
    finishedAt: reconciledAt,
  };
  node.status = "failed";
  node.executionReceipt = receipt;
  node.finishedAt = reconciledAt;
  // 恢复指令按 nodeId 表达：voice 已登记上一笔配音费用后没有可恢复的配音产物，
  // 正确动作是重新创建配音任务；assets 保留“没有可恢复的素材、重新报价”语义。
  node.error = nodeId === "voice"
    ? "人工已确认计费，原配音费用已登记；请重新创建配音任务。"
    : "人工已确认计费，但该任务没有可恢复的素材；请调整方案后重新报价。";
  delete node.outcomeUncertain;
  delete node.interrupted;
  delete node.operationRequestId;
  delete node.spendAuthorizationId;
  if (authorizationId) {
    const consumed = (run.consumedSpendAuthorizationIds ??= []);
    if (!consumed.includes(authorizationId)) consumed.push(authorizationId);
  }
  const receipts = (run.executionReceipts ??= []);
  const existingIndex = receipts.findIndex((candidate) => (
    candidate.nodeId === nodeId
    && (
      (operationId !== undefined && candidate.requestId === operationId)
      || (nodeStartedAt !== undefined && candidate.startedAt === nodeStartedAt)
    )
  ));
  if (existingIndex >= 0) receipts[existingIndex] = structuredClone(receipt);
  else receipts.push(structuredClone(receipt));
  run.revision += 1;
  run.status = "failed";
  run.finishedAt = reconciledAt;
  return run;
}

function settlePaidOperationReceipt(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
  operationId: string | undefined,
  actualCostCny: number,
  meteredAttemptCount: number,
  meteredFailedAttemptCount: number,
  reconciledAt: string,
  actualCostSource: "provider_reported" | "configured_rate" | "manual_reconciled" = "configured_rate",
): void {
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId)!;
  const receipts = (run.executionReceipts ??= []);
  const existingIndex = operationId
    ? receipts.findIndex((candidate) => candidate.nodeId === nodeId && candidate.requestId === operationId)
    : -1;
  const historical = existingIndex >= 0 ? receipts[existingIndex] : undefined;
  const executionPlan = run.executionPlan?.find((candidate) => candidate.nodeId === nodeId);
  const receiptBase = node.executionReceipt ?? historical;
  const base = receiptBase ?? executionPlan;
  const providerId = base?.providerId ?? node.spendPlan?.providerId;
  const modelId = base?.modelId ?? node.spendPlan?.modelId;
  if (!providerId || !modelId) {
    throw new Error(`Node '${nodeId}' is missing the paid provider identity required for reconciliation.`);
  }
  const authorizationId = node.spendAuthorizationId ?? receiptBase?.spendAuthorizationId;
  const authorization = run.spendAuthorizations?.find((candidate) => candidate.id === authorizationId);
  const receipt: NonNullable<typeof node.executionReceipt> = {
    ...(base ?? {
      providerId,
      providerLabel: providerId,
      modelId,
      transport: "http_api" as const,
      billing: "metered" as const,
    }),
    nodeId,
    ...(node.role ? { role: node.role } : {}),
    capability: base?.capability ?? (nodeId === "voice" ? "voice.synthesize" : "asset.prepare"),
    providerId,
    modelId,
    billing: "metered",
    status: "failed",
    estimatedCostCny: originalPaidEstimate(run, node) ?? actualCostCny,
    actualCostCny: roundCurrency(actualCostCny),
    actualCostSource,
    meteredAttemptCount,
    meteredFailedAttemptCount,
    ...(operationId ? { requestId: operationId } : {}),
    ...(authorizationId ? { spendAuthorizationId: authorizationId } : {}),
    ...(authorization ? { authorizedCostCny: authorization.maxCostCny } : {}),
    startedAt: receiptBase?.startedAt ?? node.startedAt,
    finishedAt: reconciledAt,
  };
  node.executionReceipt = structuredClone(receipt);
  if (existingIndex >= 0) receipts[existingIndex] = structuredClone(receipt);
  else receipts.push(structuredClone(receipt));
}

function paidAssetSettlement(items: PaidAssetLedgerItemSummary[]): {
  actualCostCny: number;
  meteredAttemptCount: number;
  meteredFailedAttemptCount: number;
} {
  const billedItems = items.filter((item) => !item.carriedForwardFromItemRequestId && (
    item.state === "materialized"
    || item.state === "provider_succeeded" && Boolean(item.taskId) && Boolean(item.resultUrl)
    || item.state === "submitted" && Boolean(item.taskId) && item.actualCostCny !== undefined
    || item.state === "terminal_failed"
      && item.actualCostCny !== undefined
      && (Boolean(item.taskId) || isManuallyConfirmedChargedAssetItem(item))
  ));
  return {
    actualCostCny: roundCurrency(billedItems.reduce(
      (sum, item) => sum + (item.actualCostCny ?? item.estimatedCostCny),
      0,
    )),
    meteredAttemptCount: billedItems.length,
    meteredFailedAttemptCount: billedItems.filter((item) => item.state === "terminal_failed").length,
  };
}

function paidAssetOperationNeedsManualReconciliation(items: readonly PaidAssetLedgerItemSummary[]): boolean {
  return items.length === 0 || items.some((item) => item.manualReconciliationRequired === true || (
    (item.state === "submitted" || item.state === "unknown") && !item.taskId
  ) || (
    item.state === "provider_succeeded" && !item.taskId
  ));
}

function isManuallyConfirmedChargedAssetItem(item: PaidAssetLedgerItemSummary): boolean {
  return item.error?.includes("confirmed that this provider task was charged without a recoverable result.") === true;
}

function paidAssetItemNeedsManualReconciliation(item: PaidAssetLedgerItemSummary): boolean {
  return item.manualReconciliationRequired === true
    || (item.state === "submitted" || item.state === "unknown") && !item.taskId
    || item.state === "provider_succeeded" && !item.taskId;
}

function canResumePaidAssetOperation(items: readonly PaidAssetLedgerItemSummary[]): boolean {
  if (paidAssetOperationNeedsManualReconciliation(items)) return false;
  return items.some((item) => (
    item.state === "submitted"
    || item.state === "provider_succeeded"
    || item.state === "unknown"
  )) || items.every((item) => item.state === "materialized");
}

function paidVoiceSettlement(operation: PaidVoiceOperationLedger): {
  actualCostCny: number;
  meteredAttemptCount: number;
  meteredFailedAttemptCount: number;
} {
  const hasMaterializedAudio = operation.items.some((item) => item.state === "materialized");
  return {
    actualCostCny: hasMaterializedAudio
      ? roundCurrency(operation.actualCostCny ?? operation.estimatedCostCny)
      : 0,
    meteredAttemptCount: hasMaterializedAudio ? 1 : 0,
    meteredFailedAttemptCount: 0,
  };
}

function canResumePaidVoiceOperation(operation: PaidVoiceOperationLedger): boolean {
  return operation.items.length > 0 && operation.items.every((item) => (
    item.state === "prepared" || item.state === "materialized"
  ));
}

async function readPaidVoiceOperation(
  nodeDirectory: string,
  operationId: string,
): Promise<PaidVoiceOperationLedger | undefined> {
  const pathname = paidVoiceOperationPath(nodeDirectory, operationId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isObjectRecord(value)
    || value.version !== "video-factory/paid-operation-v2"
    || value.operationId !== operationId
    || typeof value.providerId !== "string"
    || typeof value.modelId !== "string"
    || typeof value.completed !== "boolean"
    || typeof value.estimatedCostCny !== "number"
    || !Number.isFinite(value.estimatedCostCny)
    || value.estimatedCostCny < 0
    || !Array.isArray(value.items)) {
    throw new Error("Paid voice operation ledger is incompatible or corrupted.");
  }
  const states = new Set(["prepared", "submitted", "provider_succeeded", "materialized", "terminal_failed", "unknown"]);
  for (const item of value.items) {
    if (!isObjectRecord(item)
      || typeof item.itemRequestId !== "string"
      || !states.has(String(item.state))
      || !Array.isArray(item.stateHistory)
      || item.stateHistory.some((state) => typeof state !== "string")) {
      throw new Error("Paid voice operation ledger is incompatible or corrupted.");
    }
  }
  if (value.actualCostCny !== undefined && (
    typeof value.actualCostCny !== "number"
    || !Number.isFinite(value.actualCostCny)
    || value.actualCostCny < 0
  )) {
    throw new Error("Paid voice operation ledger has an invalid actual cost.");
  }
  return value as unknown as PaidVoiceOperationLedger;
}

async function markPaidVoiceItemsNotCharged(
  nodeDirectory: string,
  operation: PaidVoiceOperationLedger,
): Promise<PaidVoiceOperationLedger> {
  const ledger = structuredClone(operation);
  for (const item of ledger.items) {
    if (item.state === "materialized") continue;
    item.state = "prepared";
    if (item.stateHistory.at(-1) !== "prepared") item.stateHistory.push("prepared");
    delete (item as PaidVoiceOperationItem & { error?: string }).error;
  }
  ledger.completed = ledger.items.every((item) => item.state === "materialized");
  if (!ledger.items.some((item) => item.state === "materialized")) {
    ledger.actualCostCny = 0;
    ledger.actualCostSource = "configured_rate";
  } else if (ledger.actualCostCny === undefined) {
    ledger.actualCostCny = ledger.estimatedCostCny;
    ledger.actualCostSource = "configured_rate";
  }
  await writeJsonRecordAtomically(paidVoiceOperationPath(nodeDirectory, ledger.operationId), ledger);
  return ledger;
}

function paidVoiceOperationPath(nodeDirectory: string, operationId: string): string {
  return path.join(
    nodeDirectory,
    ".voice-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
}

async function attachPaidAssetTaskId(
  nodeDirectory: string,
  operationId: string,
  taskId: string,
  items: PaidAssetLedgerItemSummary[],
): Promise<PaidAssetLedgerItemSummary[]> {
  if (items.length === 0) {
    throw new PaidOperationManualReconciliationError("assets", []);
  }
  const missing = items.filter((item) => (
    (item.state === "submitted" || item.state === "unknown") && !item.taskId
  ));
  if (missing.length === 0 && items.filter((item) => item.taskId === taskId).length === 1) {
    return items;
  }
  if (missing.length !== 1) {
    throw new Error("A provider task id can only be attached when exactly one unresolved paid item is missing it.");
  }
  const pathname = path.join(
    nodeDirectory,
    ".generation-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  const ledger = JSON.parse(await readFile(pathname, "utf8")) as {
    version?: unknown;
    operationId?: unknown;
    items?: unknown;
  };
  if (ledger.version !== "video-factory/paid-operation-v2"
    || ledger.operationId !== operationId
    || !Array.isArray(ledger.items)) {
    throw new Error("Paid operation ledger is incompatible or corrupted.");
  }
  const item = ledger.items.find((candidate): candidate is Record<string, unknown> => (
    isObjectRecord(candidate) && candidate.itemRequestId === missing[0]!.itemRequestId
  ));
  if (!item || (item.state !== "submitted" && item.state !== "unknown") || item.taskId !== undefined) {
    throw new Error("Paid operation ledger changed while attaching its provider task id.");
  }
  item.taskId = taskId;
  await writeJsonRecordAtomically(pathname, ledger);
  return (await inspectPaidAssetLedger(nodeDirectory)).filter((candidate) => candidate.operationId === operationId);
}

function confirmedNotChargedAssetItemError(reconciliationId: string): string {
  return `Manual reconciliation '${reconciliationId}' confirmed that this provider task was not charged.`;
}

async function markPaidAssetItemNotCharged(
  nodeDirectory: string,
  operationId: string,
  itemRequestId: string,
  reconciliationId: string,
): Promise<void> {
  const pathname = path.join(
    nodeDirectory,
    ".generation-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  const ledger = JSON.parse(await readFile(pathname, "utf8")) as {
    version?: unknown;
    operationId?: unknown;
    completed?: unknown;
    items?: unknown;
  };
  if (ledger.version !== "video-factory/paid-operation-v2"
    || ledger.operationId !== operationId
    || !Array.isArray(ledger.items)) {
    throw new Error("Paid operation ledger is incompatible or corrupted.");
  }
  const matches = ledger.items.filter((candidate): candidate is Record<string, unknown> => (
    isObjectRecord(candidate) && candidate.itemRequestId === itemRequestId
  ));
  if (matches.length !== 1) {
    throw new Error(`Paid reconciliation item '${itemRequestId}' does not uniquely identify an item in the active operation.`);
  }
  const item = matches[0]!;
  const resolutionError = confirmedNotChargedAssetItemError(reconciliationId);
  if (item.state === "terminal_failed"
    && item.actualCostCny === undefined
    && item.error === resolutionError) {
    return;
  }
  if (!paidAssetItemNeedsManualReconciliation(item as unknown as PaidAssetLedgerItemSummary)) {
    throw new Error(`Paid item '${itemRequestId}' changed while confirming its not-charged outcome.`);
  }
  item.state = "terminal_failed";
  item.error = resolutionError;
  delete item.manualReconciliationRequired;
  delete item.actualCostCny;
  delete item.actualCostSource;
  ledger.completed = false;
  await writeJsonRecordAtomically(pathname, ledger);
}

function confirmedChargedAssetItemError(reconciliationId: string): string {
  return `Manual reconciliation '${reconciliationId}' confirmed that this provider task was charged without a recoverable result.`;
}

async function markPaidAssetItemCharged(
  nodeDirectory: string,
  operationId: string,
  itemRequestId: string,
  reconciliationId: string,
  actualCostCny: number,
  actualCostSource: "provider_reported" | "configured_rate" | "manual_reconciled",
): Promise<void> {
  const pathname = path.join(
    nodeDirectory,
    ".generation-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  const ledger = JSON.parse(await readFile(pathname, "utf8")) as {
    version?: unknown;
    operationId?: unknown;
    completed?: unknown;
    items?: unknown;
  };
  if (ledger.version !== "video-factory/paid-operation-v2"
    || ledger.operationId !== operationId
    || !Array.isArray(ledger.items)) {
    throw new Error("Paid operation ledger is incompatible or corrupted.");
  }
  const matches = ledger.items.filter((candidate): candidate is Record<string, unknown> => (
    isObjectRecord(candidate) && candidate.itemRequestId === itemRequestId
  ));
  if (matches.length !== 1) {
    throw new Error(`Paid reconciliation item '${itemRequestId}' does not uniquely identify an item in the active operation.`);
  }
  const item = matches[0]!;
  const resolutionError = confirmedChargedAssetItemError(reconciliationId);
  if (item.state === "terminal_failed"
    && item.actualCostCny === actualCostCny
    && item.actualCostSource === actualCostSource
    && item.error === resolutionError) {
    return;
  }
  if (!paidAssetItemNeedsManualReconciliation(item as unknown as PaidAssetLedgerItemSummary)) {
    throw new Error(`Paid item '${itemRequestId}' changed while confirming its charged outcome.`);
  }
  item.state = "terminal_failed";
  item.actualCostCny = roundCurrency(actualCostCny);
  item.actualCostSource = actualCostSource;
  item.error = resolutionError;
  delete item.manualReconciliationRequired;
  delete item.resultUrl;
  delete item.localPath;
  delete item.sha256;
  delete item.sizeBytes;
  ledger.completed = false;
  await writeJsonRecordAtomically(pathname, ledger);
}

function isTrustedPreSubmissionAssetRejection(
  node: Pick<WorkflowRun<ProductionBrief>["nodeRuns"][number],
    "error" | "executionReceipt" | "operationRequestId" | "spendAuthorizationId" | "spendPlan">,
  items: readonly PaidAssetLedgerItemSummary[],
): boolean {
  const receipt = node.executionReceipt;
  const currentReceiptEvidence = receipt?.billing === "metered"
    && receipt.meteredAttemptCount === 0
    && (receipt.meteredFailedAttemptCount ?? 0) === 0
    && (receipt.actualCostCny ?? 0) === 0
    && items.some((item) => item.state === "unknown" && !item.taskId)
    && items.every((item) => item.state === "prepared"
      || item.state === "terminal_failed"
      || item.state === "unknown" && !item.taskId);
  if (currentReceiptEvidence) return true;

  // 早期 R11 版本在本地预算预检失败时尚未创建 operation ledger，也没有把 worker
  // 的零调用诊断投影到 receipt。只有精确匹配该预检错误、授权身份和金额，且 ledger
  // 确实为空时才允许重新报价；其它缺 ledger 的失败继续要求人工核账。
  if (items.length !== 0
    || receipt?.billing !== "metered"
    || receipt.status !== "failed"
    || !node.operationRequestId
    || !node.spendPlan
    || !node.spendAuthorizationId
    || receipt.spendAuthorizationId !== node.spendAuthorizationId
    || receipt.meteredAttemptCount !== undefined
    || receipt.meteredFailedAttemptCount !== undefined
    || receipt.actualCostCny !== undefined) return false;
  const match = /^Estimated cost ¥(\d+(?:\.\d{1,2})?) exceeds the authorized maximum ¥(\d+(?:\.\d{1,2})?)\.$/.exec(node.error ?? "");
  if (!match) return false;
  const estimatedCostCny = Number(match[1]);
  const authorizedMaximumCny = Number(match[2]);
  return Number.isFinite(estimatedCostCny)
    && Number.isFinite(authorizedMaximumCny)
    && estimatedCostCny > authorizedMaximumCny
    && roundCurrency(node.spendPlan.maxCostCny) === roundCurrency(authorizedMaximumCny)
    && receipt.authorizedCostCny !== undefined
    && roundCurrency(receipt.authorizedCostCny) === roundCurrency(authorizedMaximumCny);
}

async function markPaidAssetPreSubmissionRejections(nodeDirectory: string, operationId: string): Promise<void> {
  const pathname = path.join(
    nodeDirectory,
    ".generation-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  const ledger = JSON.parse(await readFile(pathname, "utf8")) as {
    version?: unknown;
    operationId?: unknown;
    completed?: unknown;
    items?: unknown;
  };
  if (ledger.version !== "video-factory/paid-operation-v2"
    || ledger.operationId !== operationId
    || !Array.isArray(ledger.items)) {
    throw new Error("Paid operation ledger is incompatible or corrupted.");
  }
  for (const candidate of ledger.items) {
    if (!isObjectRecord(candidate)) throw new Error("Paid operation ledger is incompatible or corrupted.");
    if (candidate.state === "unknown" && !candidate.taskId) {
      candidate.state = "terminal_failed";
      delete candidate.actualCostCny;
      delete candidate.actualCostSource;
    }
  }
  ledger.completed = false;
  await writeJsonRecordAtomically(pathname, ledger);
}

async function writeJsonRecordAtomically(pathname: string, value: unknown): Promise<void> {
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, pathname);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writePaidNodeReconciliationRecord(
  pathname: string,
  record: PaidNodeReconciliationRecord,
): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, pathname);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function notifyListener(listener: ProductionRunListener | undefined, run: WorkflowRun<ProductionBrief>): Promise<void> {
  if (!listener) {
    return;
  }
  try {
    await listener(structuredClone(run));
  } catch {
    // Persistence is authoritative; an observer must not fail media production.
  }
}

function executionLeasePayload(token: string): string {
  return `${JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  })}\n`;
}

function executionLeaseFileSystem(
  handle: Pick<ExecutionLeaseHandle, "path" | "token">,
  lockPath: string,
  removal: { acquired: boolean; force: boolean },
): typeof nodeFs {
  return {
    ...nodeFs,
    rmdir: ((target: nodeFs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const targetsLeaseLock = path.resolve(String(target)) === path.resolve(lockPath);
      if (!removal.acquired || removal.force || !targetsLeaseLock) {
        nodeFs.rmdir(target, callback);
        return;
      }
      try {
        const current = JSON.parse(nodeFs.readFileSync(handle.path, "utf8")) as { token?: unknown };
        if (current.token === handle.token) {
          nodeFs.rmdir(target, callback);
          return;
        }
      } catch {
        // 所有权无法证明时只注销本进程的 heartbeat，绝不删除可能已属于新进程的锁。
      }
      queueMicrotask(() => callback(null));
    }) as typeof nodeFs.rmdir,
  };
}

function executionLeaseLostError(runId: string, cause?: unknown): Error {
  const error = new Error(`Run '${runId}' lost its execution lease.`);
  error.name = "ExecutionLeaseLostError";
  if (cause !== undefined) error.cause = cause;
  return error;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
