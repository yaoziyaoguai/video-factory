import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseProductionBlueprint } from "@video-factory/template-core";
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
  type NodeInputOverrideDraft,
  type NodeOverrideDraft,
  type NodeDefinition,
  type NodeExecutionReceiptDraft,
  type ExecutionConfigurationSource,
  type ExecutionParameterValue,
  type NodeExecutionResult,
  type Provider,
  type SpendAuthorizationDraft,
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
  type AssetSemanticRanker,
} from "./asset-semantic-ranker.js";
import { REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION, fallbackShotGrammar, validateShotGrammar, type ReferenceGrammarAgent, type ReferenceGrammarExecution, type ShotGrammar } from "./reference-grammar.js";
import type { AgentLoopTrace, CodexTaskExecution, CodexTaskTrace } from "./codex-chat.js";
import { fileRoleAgentLoopCheckpoint, roleAgentCheckpointKey } from "./role-agent-checkpoint.js";
import { RoleAgentLoopError } from "./role-agent-loop.js";
import {
  assetReuseSourceScenePosition,
  estimateVideoGenerationCostCny,
  inspectPaidAssetLedger,
  paidAssetSourceFingerprint,
  type PaidAssetLedgerItemSummary,
  type VideoGenerationRuntimeProfile,
} from "./generative-asset-worker.js";
import { SCREENWRITER_AGENT_CONTRACT_VERSION, validateScriptDraft, type ScreenwriterAgent, type ScreenwriterAgentInput, type ScriptDraft } from "./codex-screenwriter.js";
import { VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION } from "./codex-visual-director.js";
import { VISUAL_REVIEW_AGENT_CONTRACT_VERSION, validateVisualReviewReport, type VisualReviewAgent, type VisualReviewAgentInput, type VisualReviewExecution, type VisualReviewReport } from "./codex-visual-review.js";
import { parseBrief, parsePersistedBrief, parseProductionSeriesContext, WORKER_PROTOCOL_VERSION, type ProductionBrief } from "./contracts.js";
import { FileRunStore, RunLockedError, StaleRunRevisionError } from "./run-store.js";
import type { WorkerResponse } from "./python-worker-client.js";
import {
  validateVisualDirectorPlan,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
} from "./visual-director.js";

interface WorkerClient {
  run(request: Record<string, unknown>): Promise<WorkerResponse>;
}

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
  clock?: () => string;
  idFactory?: (prefix: string) => string;
  executionLeaseHeartbeatMs?: number;
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

export interface ProductionPaidNodeReconciliationDraft {
  nodeId: string;
  expectedRunRevision: number;
  reconciliationId: string;
  outcome: "resume_original" | "requote" | "confirmed_not_charged" | "confirmed_charged";
  taskId?: string;
  actor?: string;
  note?: string;
  actualCostCny?: number;
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
  actualCostSource?: "configured_rate";
  error?: string;
}

export interface ProductionPaidNodeSummary {
  nodeId: string;
  operationId?: string;
  recommendedOutcome?: ProductionPaidNodeReconciliationDraft["outcome"];
  requiresManualReconciliation: boolean;
  items: ProductionPaidOperationItemSummary[];
}

interface PaidNodeReconciliationRecord {
  version: "video-factory/paid-reconciliation-v1";
  reconciliationId: string;
  nodeId: string;
  outcome: ProductionPaidNodeReconciliationDraft["outcome"];
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
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  supportsAudio?: boolean;
  estimatedCnyPerSecond?: number;
  estimatedCnyPerSecondByResolution?: Record<string, number>;
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
  return [
    "brief",
    "script",
    ...(brief.workflowFeatures?.referenceGrammar ? ["reference-grammar"] : []),
    ...(brief.director ? ["visual-direction"] : []),
    ...(brief.workflowFeatures?.assetSemanticRank ? ["asset-candidates", "asset-semantic-rank"] : []),
    "assets",
    "voice",
    "render",
    "technical-review",
    ...(brief.providers.visualReview ? ["visual-review"] : []),
    "final-review",
    "publish-package",
  ];
}

function withPersistedBrief(
  run: WorkflowRun<ProductionBrief>,
  brief: ProductionBrief,
): WorkflowRun<ProductionBrief> {
  return { ...run, initialInput: brief };
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
    const brief = parseBrief(input);
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
    return { runId, completion: completionWithLeaseRelease };
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
    if (run.status !== "running") {
      throw new Error(`Run '${runId}' is not running.`);
    }
    await writeFile(this.pauseRequestPath(runId), `${JSON.stringify({ requestedAt: this.clock() })}\n`, "utf8");
    const latest = await this.store.load<ProductionBrief>(runId);
    if (latest.status !== "running") {
      await rm(this.pauseRequestPath(runId), { force: true });
      throw new Error(`Run '${runId}' is no longer running.`);
    }
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
    const leaseStaleAfterMs = options.leaseStaleAfterMs ?? DEFAULT_EXECUTION_LEASE_STALE_MS;
    const interrupted = (await this.store.list<ProductionBrief>())
      .filter((run) => run.status === "pending" || run.status === "running");
    let recovered = 0;
    for (const run of interrupted) {
      if (await this.hasFreshExecutionLease(run.id, leaseStaleAfterMs)) continue;
      let recoveryLease: ExecutionLeaseHandle | undefined;
      try {
        recoveryLease = await this.acquireExecutionLease(run.id);
        await this.assertExecutionLease(recoveryLease);
        await this.store.update<ProductionBrief>(run.id, async (current) => {
          const finishedAt = this.clock();
          const runningNodeIndex = current.nodeRuns.findIndex((node) => node.status === "running");
          const nodeRuns = current.nodeRuns.map((node) => ({ ...node }));
          if (runningNodeIndex >= 0) {
            const interruptedNode = nodeRuns[runningNodeIndex]!;
            nodeRuns[runningNodeIndex] = {
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
    const heartbeatMs = Math.max(1_000, Math.min(requestedHeartbeatMs, DEFAULT_EXECUTION_LEASE_STALE_MS / 2));
    const lockPath = this.executionLeaseLockPath(runId);
    const lockRemoval = { acquired: false, force: false };
    try {
      const release = await lockFile(handle.path, {
        realpath: false,
        lockfilePath: lockPath,
        stale: DEFAULT_EXECUTION_LEASE_STALE_MS,
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
    await writeFile(temporary, executionLeasePayload(handle.token), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, handle.path);
      return handle;
    } catch (error) {
      const release = handle.release;
      if (release) await release(true).catch(() => undefined);
      throw error;
    } finally {
      await rm(temporary, { force: true });
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
      const brief = parsePersistedBrief(previous.initialInput);
      const registry = this.createRegistry(brief);
      const runner = new WorkflowRunner({
        providers: registry,
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.resume(this.createWorkflow(brief, decision), withPersistedBrief(previous, brief), decision);
    }, listener);
  }

  async applyNodeOverride(runId: string, override: NodeOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      await verifyNodeOverrideBoundary(this.store.runDirectory(runId), override);
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyNodeOverride(this.createWorkflow(brief), withPersistedBrief(previous, brief), override);
    });
  }

  async applyNodeInputOverride(runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      await verifyNodeInputOverrideBoundary(this.store.runDirectory(runId), override);
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
      });
      return runner.applyNodeInputOverride(this.createWorkflow(brief), withPersistedBrief(previous, brief), override);
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
      const storedReport = validateVisualReviewReport(
        JSON.parse(await readFile(reviewArtifact.uri!, "utf8")),
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
      const revised = runner.applyNodeRevision(definition, withPersistedBrief(previous, brief), {
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

  async applyNodeExecutionConfiguration(
    runId: string,
    nodeId: string,
    nextBriefInput: ProductionBrief,
    actor: string,
  ): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous) => {
      const nextBrief = parseBrief(nextBriefInput);
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
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.authorizeSpend(this.createWorkflow(brief), withPersistedBrief(previous, brief), authorization);
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
        withPersistedBrief(previous, brief),
        { nodeId: "visual-direction", actor: rejection.rejectedBy.trim(), initialInput: nextBrief },
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
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.resumeStale(this.createWorkflow(brief), withPersistedBrief(previous, brief));
    }, listener);
  }

  async retryFailedNode(runId: string, nodeId: string): Promise<WorkflowRun<ProductionBrief>> {
    const dispatched = await this.dispatchRetryFailedNode(runId, nodeId);
    return dispatched.completion;
  }

  async reconcilePaidNode(
    runId: string,
    draft: ProductionPaidNodeReconciliationDraft,
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
      let voiceOperation = operationId && draft.nodeId === "voice"
        ? await readPaidVoiceOperation(nodeDirectory, operationId)
        : undefined;
      let resumeOriginalOperation = false;
      if (draft.outcome === "resume_original" || draft.outcome === "requote") {
        if (!operationId) {
          throw new PaidOperationManualReconciliationError(draft.nodeId, items);
        }
        if (draft.nodeId === "assets") {
          if (items.length === 0) throw new PaidOperationManualReconciliationError(draft.nodeId, items);
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
            item.state === "provider_succeeded" && (!item.taskId || !item.resultUrl)
          ));
          if (missingQueryableTask) {
            throw new PaidOperationManualReconciliationError(draft.nodeId, items);
          }
          resumeOriginalOperation = items.some((item) => (
            item.state === "submitted"
            || item.state === "provider_succeeded"
            || item.state === "unknown"
          )) || items.every((item) => item.state === "materialized");
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
        ? draft.actualCostCny ?? originalPaidEstimate(previous, previousNode)
        : undefined;
      if (draft.outcome === "confirmed_charged" && confirmedActualCostCny === undefined) {
        throw new Error("Paid reconciliation actual cost is required because the original estimate is unavailable.");
      }
      const reconciliationRecord: PaidNodeReconciliationRecord = existingRecord ?? {
        version: "video-factory/paid-reconciliation-v1",
        reconciliationId: draft.reconciliationId.trim(),
        nodeId: draft.nodeId,
        outcome: draft.outcome,
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
      if (draft.outcome === "confirmed_charged") {
        const result = applyConfirmedChargedResolution(
          previous,
          draft.nodeId,
          operationId,
          confirmedActualCostCny!,
          draft.actualCostCny !== undefined,
          this.clock(),
        );
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
      if (draft.outcome === "confirmed_not_charged" && operationId && items.length > 0) {
        await this.assertExecutionLease(lease);
        await markPaidAssetItemsNotCharged(nodeDirectory, operationId);
        items = (await inspectPaidAssetLedger(nodeDirectory)).filter((item) => item.operationId === operationId);
      }
      if (draft.outcome === "confirmed_not_charged" && voiceOperation) {
        await this.assertExecutionLease(lease);
        voiceOperation = await markPaidVoiceItemsNotCharged(nodeDirectory, voiceOperation);
        resumeOriginalOperation = true;
      }
      const retrySource = structuredClone(previous);
      const settlement = draft.nodeId === "assets"
        ? paidAssetSettlement(items)
        : draft.nodeId === "voice" && voiceOperation
          ? paidVoiceSettlement(voiceOperation)
          : { actualCostCny: 0, meteredAttemptCount: 0 };
      settlePaidOperationReceipt(
        retrySource,
        draft.nodeId,
        operationId,
        settlement.actualCostCny,
        settlement.meteredAttemptCount,
        this.clock(),
      );
      const retryNode = retrySource.nodeRuns.find((node) => node.nodeId === draft.nodeId)!;
      delete retryNode.outcomeUncertain;
      if (resumeOriginalOperation) {
        retryNode.interrupted = true;
      } else {
        delete retryNode.interrupted;
        delete retryNode.operationRequestId;
      }

      const brief = parsePersistedBrief(retrySource.initialInput);
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
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      const result = await runner.retryFailedNode(
        this.createWorkflow(brief),
        withPersistedBrief(retrySource, brief),
        draft.nodeId,
      );
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

  async inspectPaidNode(runId: string, nodeId: string): Promise<ProductionPaidNodeSummary> {
    const run = await this.store.load<ProductionBrief>(runId);
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error(`Unknown workflow node '${nodeId}'.`);
    const operationId = node.operationRequestId;
    if (!operationId) {
      return { nodeId, requiresManualReconciliation: true, items: [] };
    }
    const nodeDirectory = path.join(this.runsRoot, runId, "nodes", nodeId);
    if (nodeId === "voice") {
      const voiceOperation = await readPaidVoiceOperation(nodeDirectory, operationId);
      const resumable = voiceOperation ? canResumePaidVoiceOperation(voiceOperation) : false;
      return {
        nodeId,
        operationId,
        ...(resumable ? { recommendedOutcome: "resume_original" as const } : {}),
        requiresManualReconciliation: !resumable,
        items: [],
      };
    }
    if (nodeId !== "assets") return { nodeId, operationId, requiresManualReconciliation: true, items: [] };
    const ledgerItems = (await inspectPaidAssetLedger(
      nodeDirectory,
    )).filter((item) => item.operationId === operationId);
    const requiresManualReconciliation = ledgerItems.length === 0 || ledgerItems.some((item) => (
      (item.state === "submitted" || item.state === "unknown") && !item.taskId
    ) || (
      item.state === "provider_succeeded" && (!item.taskId || !item.resultUrl)
    ));
    const resumeOriginalOperation = ledgerItems.some((item) => (
      item.state === "submitted"
      || item.state === "provider_succeeded"
      || item.state === "unknown"
    )) || ledgerItems.every((item) => item.state === "materialized");
    return {
      nodeId,
      operationId,
      ...(!requiresManualReconciliation
        ? { recommendedOutcome: resumeOriginalOperation ? "resume_original" as const : "requote" as const }
        : {}),
      requiresManualReconciliation,
      items: ledgerItems.map((item) => ({
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
      })),
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
  ): Promise<DispatchedProductionRun> {
    return this.dispatchPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
        shouldPause: () => this.consumePauseRequest(runId),
      });
      return runner.retryFailedNode(this.createWorkflow(brief), withPersistedBrief(previous, brief), nodeId);
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
      return runner.resumePaused(this.createWorkflow(brief), withPersistedBrief(previous, brief));
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
    ) => Promise<WorkflowRun<ProductionBrief>>,
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
      async (run) => {
        if (!persisted) {
          await this.assertExecutionLease(lease);
          await this.store.save(run, previous.revision);
          persisted = true;
          await notifyListener(listener, run);
          resolveCheckpoint();
        }
        if (run.status !== "paused") await rm(this.pauseRequestPath(runId), { force: true });
        await this.releaseExecutionLease(lease);
        return run;
      },
      async (error: unknown) => {
        await rm(this.pauseRequestPath(runId), { force: true });
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
      registry.register(new ScreenwriterProvider(screenwriterAgent));
    }
    if (brief.director) {
      const directorAgent = this.options.directorAgent;
      if (!directorAgent || directorAgent.id !== brief.providers.director) {
        throw new Error(`Director provider '${brief.providers.director}' is not configured.`);
      }
      registry.register(new VisualDirectorProvider(directorAgent));
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
    options: { allowUnavailableProviders?: boolean } = {},
  ): WorkflowDefinition {
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
        execute: (input) => {
          const validatedBrief = validateBriefInputOverride(input, brief);
          return ({
          status: "succeeded",
          output: validatedBrief,
          artifacts: [jsonArtifact("production_brief", validatedBrief, "video-factory/brief-v1", "brief", [])],
          });
        },
        validateInputOverride: (input) => validateBriefInputOverride(input, brief),
        validateOverride: (output) => validateBriefInputOverride(output, brief),
      },
      ...(brief.providers.script === "codex-screenwriter-v1"
        ? [screenwriterNode(brief, this.options.screenwriterAgent, this.runsRoot, options.allowUnavailableProviders === true)]
        : [workerNode("script", "Draft script", "script.draft", brief.providers.script, ["brief"], ["brief"], () => ({ brief }), "编剧")]),
      ...(brief.workflowFeatures?.referenceGrammar ? [referenceGrammarNode(brief, this.options, this.runsRoot)] : []),
      ...(brief.director ? [directorNode(brief, this.options, this.runsRoot)] : []),
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
      workerNode(
        "assets",
        "Prepare assets",
        "asset.prepare",
        brief.providers.assets,
        [brief.workflowFeatures?.assetSemanticRank ? "asset-semantic-rank" : brief.director ? "visual-direction" : "script"],
        brief.workflowFeatures?.assetSemanticRank ? ["script", "visual-direction", "asset-candidates", "asset-semantic-rank"] : brief.director ? ["script", "visual-direction"] : ["script"],
        (context) => ({
          scriptPath: outputPath(context, "script", "scriptPath"),
          ...(brief.director ? { directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath") } : {}),
          ...(brief.workflowFeatures?.assetSemanticRank ? { candidateRankingPath: outputPath(context, "asset-semantic-rank", "candidateRankingPath") } : {}),
          ...(brief.workflowFeatures?.assetSemanticRank ? { candidateInventoryPath: outputPath(context, "asset-candidates", "candidateInventoryPath") } : {}),
        }),
        "素材导演",
      ),
      workerNode(
        "voice",
        "Synthesize voice",
        "voice.synthesize",
        brief.providers.voice,
        ["script", "assets"],
        ["script", "assets"],
        (context) => ({
          scriptPath: outputPath(context, "script", "scriptPath"),
          voice: brief.voiceDirection.profileId.slice(brief.voiceDirection.profileId.indexOf(":") + 1),
          rate: brief.voiceDirection.rate,
          pause_scale: brief.voiceDirection.pauseScale,
          mastering_preset: brief.voiceDirection.masteringPreset,
        }),
        "声音导演",
        validateVoiceNodeInput,
      ),
      workerNode(
        "render",
        "Render video",
        "video.render",
        brief.providers.render,
        ["assets", "voice"],
        ["script", "assets", "voice"],
        (context) => ({
          scriptPath: outputPath(context, "script", "scriptPath"),
          assetPlanPath: outputPath(context, "assets", "assetPlanPath"),
          voiceoverPlanPath: outputPath(context, "voice", "voiceoverPlanPath"),
        }),
        "剪辑师",
      ),
      workerNode(
        "technical-review",
        "Technical review",
        "quality.review",
        brief.providers.technicalReview,
        ["render"],
        ["script", "assets", "render"],
        (context) => ({
          videoPath: outputPath(context, "render", "videoPath"),
          assetPlanPath: outputPath(context, "assets", "assetPlanPath"),
          scriptPath: outputPath(context, "script", "scriptPath"),
        }),
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
          canonFacts: outputStringArray(context.outputs.get("script"), "canonFacts"),
        }),
        execute: (input) => {
          const reviewedInput = validateFinalReviewInput(input, Boolean(brief.seriesContext));
          if (brief.reviewMode === "automatic") {
            const recommendation = visualReviewRecommendation(reviewedInput.review);
            if (recommendation === "reject" || recommendation === "revise") {
              return {
                status: "needs_human",
                output: reviewedInput,
                intervention: {
                  reason: recommendation === "reject"
                    ? "视觉审片判定存在阻断问题，请人工确认后再继续。"
                    : "视觉审片建议修改，请人工确认是否继续。",
                  requiredAction: "approve",
                  options: ["approve", "request_changes", "reject"],
                },
              };
            }
            return { status: "succeeded", output: reviewedInput };
          }
          return {
            status: "needs_human",
            output: reviewedInput,
            intervention: {
              reason: "请完整观看成片，检查画面、字幕、旁白、事实和素材授权。",
              requiredAction: "approve",
              options: ["approve", "request_changes", "reject"],
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
        getInput: (context) => ({
          scriptPath: outputPath(context, "script", "scriptPath"),
          brief: {
            title: brief.title,
            angle: brief.angle,
            audience: brief.audience,
            nicheSlug: brief.nicheSlug,
            platform: brief.platform,
          },
        }),
        validateInputOverride: (input) => validatePublishPackageInput(input),
        execute: async (input, context) => {
          const packageInput = validatePublishPackageInput(input);
          const publishBrief: ProductionBrief = { ...brief, ...packageInput.brief };
          const currentArtifacts = await currentArtifactsForPackaging(context, brief);
          await verifyStoredArtifacts(currentArtifacts);
          const artifactIds = currentArtifacts.map((artifact) => artifact.id);
          const scriptParentIds = currentArtifacts
            .filter((artifact) => artifact.producer?.nodeId === "script")
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
                parameters: { promptPack: "video-factory/publish-copy-v1" },
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
            approval: approvalDecision
              ? {
                  status: "approved",
                  actor: approvalDecision.actor,
                  note: approvalDecision.note ?? "",
                  action: approvalDecision.action,
                }
              : { status: "approved", actor: "automatic-review", note: "", action: "approve" },
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
              needsReviewCount: resourceManifest.items.filter((item) => item.reviewStatus === "needs_review").length,
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
      version: brief.workflowFeatures?.referenceGrammar ? "1.4.0" : brief.workflowFeatures?.assetSemanticRank ? "1.3.0" : brief.providers.visualReview ? "1.2.0" : brief.director ? "1.1.0" : "1.0.0",
      nodes,
    };
  }
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

  async quoteSpend(input: Record<string, unknown>, context: WorkflowContext): Promise<SpendQuote> {
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
      const items = directorPlan.shots.flatMap((entry, index) => {
        const shot = requireOutputRecord(entry, `director plan shot ${index + 1}`);
        const directorEstimatedCostCny = Number(shot.estimatedCostCny);
        if (!Number.isFinite(directorEstimatedCostCny) || directorEstimatedCostCny < 0) {
          throw new Error(`Director plan shot ${index + 1} has an invalid server cost.`);
        }
        const scenePosition = Number(shot.scenePosition);
        if (!Number.isInteger(scenePosition) || scenePosition < 1) {
          throw new Error(`Director plan shot ${index + 1} has an invalid scene position.`);
        }
        const reuseFromScenePosition = typeof shot.reuseFromScenePosition === "number"
          ? shot.reuseFromScenePosition
          : undefined;
        if (assetReuseSourceScenePosition({
          ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
          query: typeof shot.query === "string" ? shot.query : "",
        }) !== undefined || directorEstimatedCostCny === 0) return [];
        const providerId = requiredOutputString(shot, "preferredProviderId");
        const modelId = modelSelections[providerId];
        if (!modelId) throw new Error(`Paid asset provider '${providerId}' has no resolved model for quoting.`);
        const sceneDuration = sceneDurations.get(scenePosition);
        if (sceneDuration === undefined) {
          throw new Error(`Director plan shot ${scenePosition} has no matching script scene for quoting.`);
        }
        return [{
          id: `scene-${scenePosition}`,
          label: `镜头 ${scenePosition}`,
          providerId,
          modelId,
          estimatedCostCny: this.assetEstimatedCostCny(
            providerId,
            modelId,
            sceneDuration,
            directorEstimatedCostCny,
          ),
        }];
      });
      const reconciledItems = await this.incrementalAssetQuoteItems(
        items,
        [scriptPath, directorPlanPath],
        context,
      );
      if (reconciledItems.reconciliationRequired) {
        return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false };
      }
      if (reconciledItems.items.length === 0) {
        return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false };
      }
      const estimatedCostCny = roundCurrency(reconciledItems.items.reduce((sum, item) => sum + item.estimatedCostCny, 0));
      return {
        estimatedCostCny,
        maxCostCny: roundCurrency(estimatedCostCny * this.maxAttempts),
        items: reconciledItems.items,
      };
    }

    const scriptPath = requiredOutputString(input, "scriptPath");
    const sceneDurations = await readScriptSceneDurations(scriptPath);
    const script = requireOutputRecord(JSON.parse(await readFile(scriptPath, "utf8")), "script");
    if (!Array.isArray(script.scenes)) throw new Error("Script scenes must be an array before quoting assets.");
    const items = script.scenes.flatMap((entry, index) => {
      const scene = requireOutputRecord(entry, `script scene ${index + 1}`);
      if (scene.visual_strategy === "local") return [];
      const scenePosition = Number(scene.position);
      if (!Number.isInteger(scenePosition) || scenePosition < 1) throw new Error(`Script scene ${index + 1} has an invalid position.`);
      const sceneDuration = sceneDurations.get(scenePosition);
      if (sceneDuration === undefined) throw new Error(`Script scene ${index + 1} has no valid duration.`);
      return [{
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
      }];
    });
    const reconciledItems = await this.incrementalAssetQuoteItems(items, [scriptPath], context);
    if (reconciledItems.reconciliationRequired || reconciledItems.items.length === 0) {
      return { estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false };
    }
    const estimatedCostCny = roundCurrency(reconciledItems.items.reduce((sum, item) => sum + item.estimatedCostCny, 0));
    return {
      estimatedCostCny,
      maxCostCny: roundCurrency(estimatedCostCny * this.maxAttempts),
      items: reconciledItems.items,
    };
  }

  private async incrementalAssetQuoteItems(
    items: NonNullable<SpendQuote["items"]>,
    sourcePaths: string[],
    context: WorkflowContext,
  ): Promise<{ items: NonNullable<SpendQuote["items"]>; reconciliationRequired: boolean }> {
    const sourceFingerprint = await paidAssetSourceFingerprint(sourcePaths);
    const ledgerItems = await inspectPaidAssetLedger(
      path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId),
      sourceFingerprint,
    );
    const matches = (item: NonNullable<SpendQuote["items"]>[number]) => ledgerItems.filter((candidate) => (
      candidate.quoteItemId === item.id
      && candidate.providerId === item.providerId
      && candidate.modelId === item.modelId
    ));
    const reusableIds = new Set(items.filter((item) => matches(item).some((candidate) => (
      candidate.state === "materialized"
      || candidate.state === "provider_succeeded" && Boolean(candidate.taskId) && Boolean(candidate.resultUrl)
    ))).map((item) => item.id));
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
    const estimatedCnyPerClip = profile?.estimatedCostCny ?? metadata?.estimatedCostCny ?? fallbackEstimatedCostCny;
    return estimateVideoGenerationCostCny(
      sceneDurationSeconds,
      estimatedCnyPerClip,
      videoPricingProfile(profile),
    );
  }

  async run(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkerResponse> {
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
    minDurationSeconds: profile.minDurationSeconds,
    maxDurationSeconds: profile.maxDurationSeconds,
    supportsAudio: profile.supportsAudio,
    ...(profile.estimatedCnyPerSecond !== undefined
      ? { estimatedCnyPerSecond: profile.estimatedCnyPerSecond }
      : {}),
    ...(profile.estimatedCnyPerSecondByResolution
      ? { estimatedCnyPerSecondByResolution: { ...profile.estimatedCnyPerSecondByResolution } }
      : {}),
  };
}

class VisualDirectorProvider implements Provider<VisualDirectorAgentInput, CodexTaskExecution<unknown>> {
  readonly capability: Capability = "storyboard.plan";
  readonly label = "Codex 视觉导演";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;
  readonly configurationSource = "system_default" as const;
  readonly parameters = { promptPack: "video-factory/director-v10" };

  constructor(private readonly agent: VisualDirectorAgent) {}

  get id(): string {
    return this.agent.id;
  }

  get modelId(): string {
    return this.agent.modelId ?? "codex-default";
  }

  async run(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<unknown>> {
    return this.agent.planDetailed
      ? this.agent.planDetailed(input)
      : { output: await this.agent.plan(input) };
  }
}

class ScreenwriterProvider implements Provider<ScreenwriterAgentInput, CodexTaskExecution<unknown>> {
  readonly capability: Capability = "script.draft";
  readonly label = "Codex 编剧";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;
  readonly configurationSource = "system_default" as const;
  readonly parameters = { promptPack: "video-factory/screenwriter-v4" };

  constructor(private readonly agent: ScreenwriterAgent) {}

  get id(): string {
    return this.agent.id;
  }

  get modelId(): string {
    return this.agent.modelId ?? "codex-default";
  }

  async run(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>> {
    return this.agent.draftDetailed
      ? this.agent.draftDetailed(input)
      : { output: await this.agent.draft(input) };
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
  get parameters(): Record<string, ExecutionParameterValue> { return { sampleMode: "runtime_verified", promptPack: "video-factory/visual-review-v5", agentLoopMaxIterations: 3, independentAudit: true }; }
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
      parameters: { sampleMode: "keyframes", promptPack: "video-factory/reference-grammar-v1" },
      estimatedCostCny: 0,
    },
    mode: "automatic",
    dependsOn: ["script"],
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
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "script")
        .map((artifact) => artifact.id);
      const extension = reference.mimeType === "video/webm" ? ".webm" : reference.mimeType === "video/quicktime" ? ".mov" : ".mp4";
      const copiedVideoPath = path.join(attempt.directory, `reference${extension}`);
      await copyFile(sourceRealPath, copiedVideoPath);
      await verifyArtifactBytes(copiedVideoPath, reference.sha256, reference.sizeBytes);
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
              parameters: { sampleMode: "keyframes", promptPack: "video-factory/reference-grammar-v1" },
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
          parameters: { sampleMode: "keyframes", promptPack: (execution?.trace ?? failedTrace)?.promptVersion ?? "video-factory/reference-grammar-v1" },
          estimatedCostCny: 0,
          requestId: context.nextId("reference-grammar"),
        },
        artifacts: [
          await binaryFileArtifact(
            "reference_video",
            copiedVideoPath,
            reference.mimeType,
            "video-factory/reference-video-v1",
            "reference-grammar",
            parentArtifactIds,
            "creator-upload",
            "Creator-supplied reference video; retained only as private run input.",
            attempt.attempt,
          ),
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

function directorNode(
  brief: ProductionBrief,
  options: ProductionPipelineOptions,
  runsRoot: string,
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
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "visual-direction"));
      const scriptPath = requiredOutputString(input, "scriptPath");
      const script = JSON.parse(await readFile(scriptPath, "utf8")) as { scenes?: unknown };
      const referenceGrammar: ShotGrammar | undefined = brief.workflowFeatures?.referenceGrammar
        ? await readShotGrammarFile(requiredOutputString(input, "referenceGrammarPath"))
        : undefined;
      const scenes = parseDirectorScenes(script.scenes);
      const catalog = new Map((options.assetProviders ?? []).map((provider) => [provider.id, provider]));
      const assetProviders = direction.assetProviderIds.map((id) => {
        const provider = catalog.get(id);
        if (!provider) throw new Error(`Asset provider '${id}' is not available to the AI director.`);
        return {
          id: provider.id,
          label: provider.label,
          billing: provider.billing,
          modes: [...provider.modes],
          deliveryTypes: [...provider.deliveryTypes],
          strengths: [...(provider.strengths ?? provider.modes)],
          constraints: [...(provider.constraints ?? [])],
          estimatedCnyPerClip: provider.estimatedCnyPerClip ?? 0,
        };
      });
      const provider = context.resolveProvider<VisualDirectorAgentInput, CodexTaskExecution<unknown>>({
        capability: "storyboard.plan",
        providerId,
      });
      const costFeedback = brief.spendFeedback?.slice(-10).reverse().map((feedback) => ({
        reason: feedback.reason,
        previousEstimatedCostCny: feedback.previousEstimatedCostCny,
        ...(feedback.targetEstimatedCostCny !== undefined
          ? { targetEstimatedCostCny: feedback.targetEstimatedCostCny }
          : {}),
        ...(feedback.note ? { note: feedback.note } : {}),
      }));
      const directorEconomics = { allowMeteredProviders: brief.economics.allowMeteredProviders };
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && ["script", "reference-grammar"].includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      let execution: CodexTaskExecution<unknown>;
      try {
        execution = await provider.run({
          brief: {
            title: brief.title,
            angle: brief.angle,
            audience: brief.audience,
            platform: brief.platform,
            durationSeconds: brief.durationSeconds,
            requestedProfileId: direction.profileId,
            ...(brief.templateSnapshot ? { templateBlueprint: brief.templateSnapshot.resolvedBlueprint } : {}),
            ...(brief.editorial ? { editorial: brief.editorial } : {}),
            ...(referenceGrammar ? { referenceGrammar } : {}),
            ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
          },
          scenes,
          assetProviders,
          economics: directorEconomics,
          ...(costFeedback?.length ? { costFeedback } : {}),
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-direction",
            { brief, scenes, assetProviders, economics: directorEconomics, ...(costFeedback?.length ? { costFeedback } : {}), ...(referenceGrammar ? { referenceGrammar } : {}) },
            VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
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
        throw error;
      }
      const selectedCatalog = direction.assetProviderIds.map((id) => catalog.get(id)!);
      const plan = validateVisualDirectorPlan(execution.output, {
        scenePositions: scenes.map((scene) => scene.position),
        sceneDurations: Object.fromEntries(scenes.map((scene) => [scene.position, scene.duration])),
        allowedProviderIds: direction.assetProviderIds,
        generativeProviderIds: selectedCatalog.filter((provider) => provider.generative).map((provider) => provider.id),
        providerDeliveryTypes: Object.fromEntries(
          selectedCatalog.map((provider) => [provider.id, [...provider.deliveryTypes]]),
        ),
        estimatedCnyPerClip: Object.fromEntries(selectedCatalog.map((provider) => [provider.id, provider.estimatedCnyPerClip ?? 0])),
        economics: directorEconomics,
      });
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
        ...(execution.trace ? { receipt: modelTraceReceipt(execution.trace, "Codex 视觉导演", "subscription", execution.agentLoop) } : {}),
        artifacts: [fileArtifact(
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
        ), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
      };
    },
    validateOverride: (output) => validatePathOutput(output, "directorPlanPath", "visual-direction"),
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
  runsRoot: string,
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
    getInput: (context) => ({ brief: screenwriterBrief(parseBrief(context.outputs.get("brief"))) }),
    validateInputOverride: (input) => validateScreenwriterInput(input),
    execute: async (input, context) => {
      const request = validateScreenwriterInput(input);
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "script"));
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
          ),
        }, context);
      } catch (error) {
        if (error instanceof RoleAgentLoopError) {
          const rejectedDraft = lastAgentLoopCandidate(error, (value) => validateScriptDraft(value, {
            durationSeconds: request.brief.durationSeconds,
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
            providerLabel: "Codex 编剧",
            ...(preserved ? { output: preserved.output, additionalArtifacts: [preserved.artifact] } : {}),
          });
        }
        throw error;
      }
      const requestedBrief = request.brief;
      const draft = validateScriptDraft(execution.output, {
        durationSeconds: requestedBrief.durationSeconds,
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
        ...(execution.trace ? { receipt: modelTraceReceipt(execution.trace, "Codex 编剧", "subscription", execution.agentLoop) } : {}),
        artifacts: [fileArtifact(
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
        ), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
      };
    },
    validateOverride: (output) => validateScriptNodeOutput(output),
  };
}

function scriptDocument(brief: ScreenwriterAgentInput["brief"], draft: ScriptDraft): Record<string, unknown> {
  return {
    title: brief.title,
    ...(draft.viewerPromise ? { viewerPromise: draft.viewerPromise } : {}),
    ...(draft.narrativeArc ? { narrativeArc: draft.narrativeArc } : {}),
    ...(draft.canonFacts ? { canonFacts: draft.canonFacts } : {}),
    hook: draft.scenes[0]!.narration,
    duration_target: brief.durationSeconds,
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

function screenwriterBrief(brief: ProductionBrief): ScreenwriterAgentInput["brief"] {
  return {
    title: brief.title,
    angle: brief.angle,
    audience: brief.audience,
    nicheSlug: brief.nicheSlug,
    platform: brief.platform,
    durationSeconds: brief.durationSeconds,
    ...(brief.templateSnapshot ? { templateBlueprint: brief.templateSnapshot.resolvedBlueprint } : {}),
    ...(brief.editorial ? { editorial: brief.editorial } : {}),
    ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
  };
}

function validateScreenwriterInput(value: unknown): ScreenwriterAgentInput {
  const input = requireOutputRecord(value, "script input");
  const rawBrief = requireOutputRecord(input.brief, "script input brief");
  if (rawBrief.protocolVersion === "video-factory/brief-v1") {
    return { brief: screenwriterBrief(parseBrief(rawBrief)) };
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
  if (rawBrief.templateBlueprint !== undefined) {
    brief.templateBlueprint = parseProductionBlueprint(rawBrief.templateBlueprint);
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
  if (rawBrief.seriesContext !== undefined) {
    const seriesContext = parseProductionSeriesContext(rawBrief.seriesContext);
    if (seriesContext) brief.seriesContext = seriesContext;
  }
  return { brief };
}

function validateVisualReviewInput(
  value: unknown,
  directorEnabled: boolean,
): VisualReviewAgentInput & { renderManifestPath: string } {
  const input = requireOutputRecord(value, "visual-review input");
  const request: VisualReviewAgentInput & { renderManifestPath: string } = {
    videoPath: requiredOutputString(input, "videoPath"),
    runRoot: requiredOutputString(input, "runRoot"),
    scriptPath: requiredOutputString(input, "scriptPath"),
    renderManifestPath: requiredOutputString(input, "renderManifestPath"),
  };
  if (directorEnabled) request.directorPlanPath = requiredOutputString(input, "directorPlanPath");
  return request;
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
    getInput: (context) => ({
      videoPath: outputPath(context, "render", "videoPath"),
      runRoot: path.join(runsRoot, context.runId),
      scriptPath: outputPath(context, "script", "scriptPath"),
      ...(brief.director ? { directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath") } : {}),
      renderManifestPath: outputPath(context, "render", "renderManifestPath"),
    }),
    validateInputOverride: (input) => validateVisualReviewInput(input, Boolean(brief.director)),
    execute: async (input, context) => {
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "visual-review"));
      const request = validateVisualReviewInput(input, Boolean(brief.director));
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && ["render", "technical-review"].includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      const provider = context.resolveProvider<VisualReviewAgentInput, VisualReviewExecution>({
        capability: "quality.review.visual",
        providerId,
      });
      let execution: VisualReviewExecution;
      try {
        execution = await provider.run({
          ...request,
          agentLoopCheckpoint: nodeAgentLoopCheckpoint(
            runsRoot,
            context.runId,
            "visual-review",
            request,
            VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
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
        throw error;
      }
      const report = await localizeVisualReviewReport(
        execution.output,
        request.renderManifestPath,
        execution.inspectedDurationMs,
      );
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
          providerId: execution.trace?.providerId ?? provider.id,
          providerLabel: provider.label ?? provider.id,
          modelId: execution.trace?.modelId ?? provider.modelId ?? provider.id,
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
        ), ...(traceArtifact ? [traceArtifact] : []), ...(loopArtifact ? [loopArtifact] : [])],
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
    role: "语义选片师",
    capability: "asset.rank.semantic",
    providerId: ranker?.id ?? "deterministic-quality-v1",
    plannedExecution: ranker ? {
      providerId: ranker.id,
      providerLabel: "Codex 语义选片",
      modelId: ranker.modelId,
      transport: "unix_socket",
      billing: "subscription",
      configurationSource: "system_default",
      parameters: { rankingMode: "visual_semantic", promptPack: "video-factory/asset-rank-v1" },
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
      if (ranker) {
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
                parameters: { rankingMode: "visual_semantic", promptPack: "video-factory/asset-rank-v1" },
              },
              providerLabel: "Codex 语义选片",
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
        ? modelTraceReceipt(trace, "Codex 语义选片", "subscription", agentLoop)
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

function roundCurrency(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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
    },
  }));
  if (response.status === "failed") {
    return { status: "failed", error, artifacts };
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
  const canonFacts = outputStringArray(scriptDocument, "canonFacts");
  if (canonFacts.length === 0) {
    throw new Error("系列脚本在进入素材、配音和渲染前必须确认 1 到 8 条可供后集依赖的定版事实。");
  }
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
  if (actualCostSource !== undefined && actualCostSource !== "provider_reported" && actualCostSource !== "configured_rate") {
    throw new Error("Worker diagnostics actualCostSource must identify provider-reported or configured-rate accounting.");
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

function modelTraceReceipt(
  trace: CodexTaskTrace,
  providerLabel: string,
  billing: "subscription" | "metered",
  loop?: AgentLoopTrace,
): NodeExecutionReceiptDraft {
  return {
    providerId: trace.providerId,
    providerLabel,
    modelId: trace.modelId,
    transport: "unix_socket",
    billing,
    configurationSource: "system_default",
    parameters: {
      promptPack: trace.promptVersion,
      ...(trace.reasoningEffort ? { reasoningEffort: trace.reasoningEffort } : {}),
      ...(loop ? {
        agentLoop: loop.status,
        agentLoopIterations: loop.iterations.length,
        auditReasoningEffort: loop.iterations.at(-1)?.auditTrace?.reasoningEffort ?? "xhigh",
        modelCallCount: Math.max(1, loop.modelCallCount ?? loop.iterations.length * 2 + (loop.pendingCandidate ? 1 : 0)),
        producerModelCallCount: loop.producerModelCallCount ?? loop.iterations.length + (loop.pendingCandidate ? 1 : 0),
        auditModelCallCount: loop.auditModelCallCount ?? loop.iterations.length,
      } : {}),
    },
  };
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
  const canonFacts = outputStringArray(value, "canonFacts");
  if (requireCanonFacts && canonFacts.length === 0) {
    throw new Error("系列成片在终审前必须从最终脚本确认 1 到 8 条可供后集依赖的定版事实。");
  }
  return {
    ...value,
    canonFacts,
  };
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

function outputStringArray(output: unknown, field: string): string[] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return [];
  const value = (output as Record<string, unknown>)[field];
  if (value === undefined) return [];
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
      return { ...finding, scenePosition: scene.scenePosition };
    }),
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
    provenance: { providerId, providerVersion: "1", licenseNote },
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
    ? modelTraceReceipt(options.error.lastTrace, options.providerLabel, options.provider.billing === "metered" ? "metered" : "subscription", options.error.agentLoop)
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
          modelCallCount: Math.max(1, options.error.agentLoop.modelCallCount ?? 1),
        },
      };
  if (options.provider.billing === "metered") {
    const meteredAttemptCount = Math.max(
      1,
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

async function persistModelTrace(options: {
  trace: CodexTaskTrace | undefined;
  attemptDirectory: string;
  nodeId: string;
  attempt: number;
  parentArtifactIds: string[];
}): Promise<ArtifactDraft | undefined> {
  if (!options.trace) return undefined;
  const tracePath = path.join(options.attemptDirectory, "model_trace.json");
  const payload = {
    version: "video-factory/model-trace-v1",
    taskKind: options.trace.taskKind,
    promptVersion: options.trace.promptVersion,
    providerId: options.trace.providerId,
    modelId: options.trace.modelId,
    ...(options.trace.reasoningEffort ? { reasoningEffort: options.trace.reasoningEffort } : {}),
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
}): Promise<ArtifactDraft | undefined> {
  if (!options.loop) return undefined;
  const tracePath = path.join(options.attemptDirectory, "agent_loop_trace.json");
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
): ReturnType<typeof fileRoleAgentLoopCheckpoint> {
  // 同一制作内沿用 running checkpoint；人工重试 exhausted 节点时开启新 cycle，避免回放旧失败终态。
  const key = roleAgentCheckpointKey({ runId, nodeId, input, contractVersion });
  return fileRoleAgentLoopCheckpoint(
    path.join(runsRoot, runId, "nodes", nodeId, "agent-loop-checkpoints", `${key}.json`),
    key,
    { restartExhausted: true },
  );
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
    { nodeId: "script", paths: [outputPath(context, "script", "scriptPath")] },
    ...(brief.workflowFeatures?.referenceGrammar ? [{ nodeId: "reference-grammar", paths: [outputPath(context, "reference-grammar", "referenceGrammarPath")] }] : []),
    ...(brief.director ? [{ nodeId: "visual-direction", paths: [outputPath(context, "visual-direction", "directorPlanPath")] }] : []),
    ...(brief.workflowFeatures?.assetSemanticRank ? [
      { nodeId: "asset-candidates", paths: [outputPath(context, "asset-candidates", "candidateSearchPath")] },
      { nodeId: "asset-semantic-rank", paths: [outputPath(context, "asset-semantic-rank", "candidateRankingPath")] },
    ] : []),
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
  providerReportedCost: boolean,
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
    actualCostSource: providerReportedCost ? "provider_reported" : "configured_rate",
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
  node.error = "人工已确认计费，但该任务没有可恢复的素材；请调整方案后重新报价。";
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
  reconciledAt: string,
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
    actualCostSource: "configured_rate",
    meteredAttemptCount,
    meteredFailedAttemptCount: 0,
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
} {
  const billedItems = items.filter((item) => !item.carriedForwardFromItemRequestId && (
    item.state === "materialized"
    || item.state === "provider_succeeded" && Boolean(item.taskId) && Boolean(item.resultUrl)
    || item.state === "submitted" && Boolean(item.taskId) && item.actualCostCny !== undefined
  ));
  return {
    actualCostCny: roundCurrency(billedItems.reduce(
      (sum, item) => sum + (item.actualCostCny ?? item.estimatedCostCny),
      0,
    )),
    meteredAttemptCount: billedItems.length,
  };
}

function paidVoiceSettlement(operation: PaidVoiceOperationLedger): {
  actualCostCny: number;
  meteredAttemptCount: number;
} {
  const hasMaterializedAudio = operation.items.some((item) => item.state === "materialized");
  return {
    actualCostCny: hasMaterializedAudio
      ? roundCurrency(operation.actualCostCny ?? operation.estimatedCostCny)
      : 0,
    meteredAttemptCount: hasMaterializedAudio ? 1 : 0,
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

async function markPaidAssetItemsNotCharged(nodeDirectory: string, operationId: string): Promise<void> {
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
    if (candidate.state === "submitted"
      || candidate.state === "unknown"
      || candidate.state === "provider_succeeded" && (!candidate.taskId || !candidate.resultUrl)) {
      candidate.state = "terminal_failed";
      candidate.error = "Manual reconciliation confirmed that this provider task was not charged.";
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
