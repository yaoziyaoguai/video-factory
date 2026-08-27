import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseProductionBlueprint } from "@video-factory/template-core";
import {
  ProviderRegistry,
  WorkflowRunner,
  type Artifact,
  type ArtifactDraft,
  type Capability,
  type HumanDecisionDraft,
  type NodeInputOverrideDraft,
  type NodeOverrideDraft,
  type NodeDefinition,
  type NodeExecutionReceiptDraft,
  type NodeExecutionResult,
  type Provider,
  type SpendAuthorizationDraft,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@video-factory/workflow-core";
import { validatePublishCopy, type PublishCopy, type PublishCopyWriter } from "./codex-publish-copy.js";
import type { CodexTaskExecution, CodexTaskTrace } from "./codex-chat.js";
import { validateScriptDraft, type ScreenwriterAgent, type ScreenwriterAgentInput } from "./codex-screenwriter.js";
import { validateVisualReviewReport, type VisualReviewAgent, type VisualReviewAgentInput, type VisualReviewExecution, type VisualReviewReport } from "./codex-visual-review.js";
import { parseBrief, parsePersistedBrief, WORKER_PROTOCOL_VERSION, type ProductionBrief } from "./contracts.js";
import { FileRunStore, RunLockedError } from "./run-store.js";
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
  clock?: () => string;
  idFactory?: (prefix: string) => string;
  executionLeaseHeartbeatMs?: number;
}

export type ProductionRunListener = (run: WorkflowRun<ProductionBrief>) => Promise<void> | void;

export interface DispatchedProductionRun {
  runId: string;
  completion: Promise<WorkflowRun<ProductionBrief>>;
}

interface ProviderConfig {
  id: string;
  capability: Capability;
  nodeId: string;
  parameters: Record<string, unknown>;
  metadata?: ProductionProviderRuntimeMetadata;
}

const KNOWN_METERED_WORKER_PROVIDER_IDS = new Set([
  "seedream-image-v1",
  "seedance-video-v1",
  "hailuo-video-v1",
  "wan-video-v1",
  "minimax-tts-v1",
]);
const KNOWN_METERED_VISUAL_REVIEW_PROVIDER_IDS = new Set(["glm-visual-review-v1"]);

export interface ProductionProviderRuntimeMetadata {
  id: string;
  label: string;
  modelId: string;
  transport: "unix_socket" | "local_process" | "http_api";
  billing: "subscription" | "metered" | "free" | "local_compute";
  billingUnit?: "clip" | "run";
  estimatedCostCny?: number;
  maxAttempts?: number;
}

function productionNodeIds(brief: ProductionBrief): string[] {
  return [
    "brief",
    "script",
    ...(brief.director ? ["visual-direction"] : []),
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
  path: string;
  token: string;
  timer?: ReturnType<typeof setInterval>;
  active: boolean;
  pending: Promise<void>;
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
      checkpoint: async (run) => {
        const productionRun = run as WorkflowRun<ProductionBrief>;
        if (!created) {
          executionLease = await this.acquireExecutionLease(runId);
          try {
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
        await this.releaseExecutionLease(executionLease);
        return run;
      },
      async (error: unknown) => {
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
      .hydrateLegacyVersionStates(this.createWorkflow(brief), withPersistedBrief(run, brief), { allowVersionMismatch: true });
  }

  async loadPersisted(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.store.load<ProductionBrief>(runId);
  }

  async list(): Promise<WorkflowRun<ProductionBrief>[]> {
    return this.store.list<ProductionBrief>();
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
        recoveryLease = await this.acquireExecutionLease(run.id, true);
        await this.store.update<ProductionBrief>(run.id, async (current) => {
          const finishedAt = this.clock();
          const runningNodeIndex = current.nodeRuns.findIndex((node) => node.status === "running");
          const nodeRuns = current.nodeRuns.map((node) => ({ ...node }));
          if (runningNodeIndex >= 0) {
            nodeRuns[runningNodeIndex] = {
              ...nodeRuns[runningNodeIndex]!,
              status: "failed",
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

  private async acquireExecutionLease(runId: string, exclusive = false): Promise<ExecutionLeaseHandle> {
    const leasePath = this.executionLeasePath(runId);
    await mkdir(path.dirname(leasePath), { recursive: true });
    const handle: ExecutionLeaseHandle = {
      path: leasePath,
      token: randomUUID(),
      active: true,
      pending: Promise.resolve(),
    };
    if (exclusive) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await writeFile(handle.path, executionLeasePayload(handle.token), { encoding: "utf8", flag: "wx", mode: 0o600 });
          break;
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          if (attempt > 0 || await this.hasFreshExecutionLease(runId, DEFAULT_EXECUTION_LEASE_STALE_MS)) {
            throw new RunLockedError(runId);
          }
          await rm(handle.path, { force: true });
        }
      }
    } else {
      await this.writeExecutionLease(handle);
    }
    const heartbeatMs = this.options.executionLeaseHeartbeatMs ?? DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS;
    handle.timer = setInterval(() => {
      if (!handle.active) return;
      handle.pending = handle.pending.then(() => this.writeExecutionLease(handle)).catch(() => undefined);
    }, heartbeatMs);
    handle.timer.unref();
    return handle;
  }

  private async writeExecutionLease(handle: ExecutionLeaseHandle): Promise<void> {
    if (!handle.active) return;
    const temporary = `${handle.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, executionLeasePayload(handle.token), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      if (handle.active) await rename(temporary, handle.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async releaseExecutionLease(handle: ExecutionLeaseHandle | undefined): Promise<void> {
    if (!handle) return;
    handle.active = false;
    if (handle.timer) clearInterval(handle.timer);
    await handle.pending;
    try {
      const current = JSON.parse(await readFile(handle.path, "utf8")) as { token?: unknown };
      if (current.token === handle.token) await rm(handle.path, { force: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
  }

  private async hasFreshExecutionLease(runId: string, staleAfterMs: number): Promise<boolean> {
    try {
      const lease = JSON.parse(await readFile(this.executionLeasePath(runId), "utf8")) as { heartbeatAt?: unknown };
      if (typeof lease.heartbeatAt !== "string") return false;
      const heartbeatAt = Date.parse(lease.heartbeatAt);
      const now = Date.now();
      return Number.isFinite(heartbeatAt) && Number.isFinite(now) && now - heartbeatAt <= staleAfterMs;
    } catch {
      return false;
    }
  }

  private executionLeasePath(runId: string): string {
    return path.join(this.runsRoot, runId, ".execution-lease.json");
  }

  async decide(runId: string, decision: HumanDecisionDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const registry = this.createRegistry(brief);
      const runner = new WorkflowRunner({
        providers: registry,
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
      });
      return runner.resume(this.createWorkflow(brief, decision), withPersistedBrief(previous, brief), decision);
    });
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

  async authorizeSpend(runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
      });
      return runner.authorizeSpend(this.createWorkflow(brief), withPersistedBrief(previous, brief), authorization);
    });
  }

  async resumeStale(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.runPersistedTransition(runId, async (previous, checkpoint) => {
      const brief = parsePersistedBrief(previous.initialInput);
      const runner = new WorkflowRunner({
        providers: this.createRegistry(brief),
        clock: this.clock,
        idFactory: this.idFactory,
        checkpoint: (run) => checkpoint(run as WorkflowRun<ProductionBrief>),
      });
      return runner.resumeStale(this.createWorkflow(brief), withPersistedBrief(previous, brief));
    });
  }

  private async runPersistedTransition(
    runId: string,
    transition: (
      previous: WorkflowRun<ProductionBrief>,
      checkpoint: (run: WorkflowRun<ProductionBrief>) => Promise<void>,
    ) => Promise<WorkflowRun<ProductionBrief>>,
  ): Promise<WorkflowRun<ProductionBrief>> {
    const lease = await this.acquireExecutionLease(runId, true);
    try {
      const previous = await this.store.load<ProductionBrief>(runId);
      let persisted = false;
      const checkpoint = async (run: WorkflowRun<ProductionBrief>) => {
        if (!persisted) {
          await this.store.save(run, previous.revision);
          persisted = true;
          return;
        }
        await this.store.checkpoint(run);
      };
      const result = await transition(previous, checkpoint);
      if (!persisted) await this.store.save(result, previous.revision);
      return result;
    } finally {
      await this.releaseExecutionLease(lease);
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
        const response = await provider.run(input as Record<string, unknown>, context);
        return {
          ...workerResponseToNodeResult(response, context, parentNodeIds),
          receipt: providerExecutionReceipt(provider, response),
        };
      },
      validateInputOverride: (input) => requireOutputRecord(input, `${id} input`),
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
        ? [screenwriterNode(brief, this.options.screenwriterAgent, this.runsRoot)]
        : [workerNode("script", "Draft script", "script.draft", brief.providers.script, ["brief"], ["brief"], () => ({ brief }), "编剧")]),
      ...(brief.director ? [directorNode(brief, this.options, this.runsRoot)] : []),
      workerNode(
        "assets",
        "Prepare assets",
        "asset.prepare",
        brief.providers.assets,
        [brief.director ? "visual-direction" : "script"],
        brief.director ? ["script", "visual-direction"] : ["script"],
        (context) => ({
          scriptPath: outputPath(context, "script", "scriptPath"),
          ...(brief.director ? { directorPlanPath: outputPath(context, "visual-direction", "directorPlanPath") } : {}),
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
        (context) => ({ scriptPath: outputPath(context, "script", "scriptPath") }),
        "声音导演",
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
        getInput: (context) => context.outputs.get(brief.providers.visualReview ? "visual-review" : "technical-review"),
        execute: (input) => {
          if (brief.reviewMode === "automatic") {
            const recommendation = visualReviewRecommendation(input);
            if (recommendation === "reject" || recommendation === "revise") {
              return {
                status: "needs_human",
                output: input,
                intervention: {
                  reason: recommendation === "reject"
                    ? "视觉审片判定存在阻断问题，请人工确认后再继续。"
                    : "视觉审片建议修改，请人工确认是否继续。",
                  requiredAction: "approve",
                  options: ["approve", "reject"],
                },
              };
            }
            return { status: "succeeded", output: input };
          }
          return {
            status: "needs_human",
            output: input,
            intervention: {
              reason: "请完整观看成片，检查画面、字幕、旁白、事实和素材授权。",
              requiredAction: "approve",
              options: ["approve", "reject"],
            },
          };
        },
        validateInputOverride: (input) => requireOutputRecord(input, "final-review input"),
        validateOverride: (output) => requireOutputRecord(output, "final-review"),
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
          const currentArtifacts = currentArtifactsForPackaging(context, brief);
          await verifyStoredArtifacts(currentArtifacts);
          const artifactIds = currentArtifacts.map((artifact) => artifact.id);
          const scriptParentIds = currentArtifacts
            .filter((artifact) => artifact.producer?.nodeId === "script")
            .map((artifact) => artifact.id);
          const publishAttempt = await reserveAttemptDirectory(path.join(this.runsRoot, context.runId, "publish"));
          // 文案是增强能力：失败不让已过审的成片失败，也不暴露异常文本；pipeline 层不重试。
          const copyOutcome = await generatePublishCopy({
            writer: this.options.publishCopyWriter,
            brief: publishBrief,
            scriptPath: packageInput.scriptPath,
          });
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
            artifacts: currentArtifacts,
          };
          const packageContent = `${JSON.stringify(payload, null, 2)}\n`;
          await writeTextAtomically(packagePath, packageContent);
          return {
            status: "succeeded",
            output: { publishPackagePath: packagePath },
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
              ...copyArtifacts,
            ],
          };
        },
        validateOverride: (output) => validatePathOutput(output, "publishPackagePath", "publish-package"),
      },
    ];

    return {
      id: "daily-production",
      name: "Daily short-video production",
      version: brief.providers.visualReview ? "1.2.0" : brief.director ? "1.1.0" : "1.0.0",
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
  get estimatedCostCny(): number { return this.config.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number {
    if (this.config.metadata?.billing !== "metered") return 0;
    return this.config.metadata.billingUnit === "run"
      ? this.config.metadata.estimatedCostCny ?? 0
      : typeof this.config.parameters.maxCostCny === "number" ? this.config.parameters.maxCostCny : 0;
  }
  get maxAttempts(): number {
    return this.config.metadata?.billing === "metered" && typeof this.config.metadata.maxAttempts === "number"
      ? this.config.metadata.maxAttempts
      : 1;
  }

  async run(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkerResponse> {
    const attempt = await reserveAttemptDirectory(path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId));
    const outputDir = attempt.directory;
    const parameters: Record<string, unknown> = { ...this.config.parameters, providerId: this.config.id };
    if (this.billing === "metered") {
      const authorization = context.spendAuthorization;
      if (!authorization || authorization.providerId !== this.id || authorization.modelId !== this.modelId) {
        throw new Error(`Metered provider '${this.id}' has no matching active authorization.`);
      }
      parameters.maxCostCny = authorization.maxCostCny;
      parameters.maxAttempts = authorization.maxAttempts;
    }
    const response = await this.worker.run({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      commandId: context.nextId("command"),
      runId: context.runId,
      nodeRunId: this.config.nodeId,
      attempt: attempt.attempt,
      capability: this.config.capability,
      input,
      parameters,
      outputDir,
    });
    await verifyWorkerArtifacts(response, outputDir);
    return response;
  }
}

class VisualDirectorProvider implements Provider<VisualDirectorAgentInput, CodexTaskExecution<unknown>> {
  readonly capability: Capability = "storyboard.plan";
  readonly label = "Codex 视觉导演";
  readonly modelId = "codex";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;

  constructor(private readonly agent: VisualDirectorAgent) {}

  get id(): string {
    return this.agent.id;
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
  readonly modelId = "codex";
  readonly transport = "unix_socket" as const;
  readonly billing = "subscription" as const;

  constructor(private readonly agent: ScreenwriterAgent) {}

  get id(): string {
    return this.agent.id;
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
  get estimatedCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxAttempts(): number { return this.metadata?.maxAttempts ?? 1; }
  async run(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
    return this.agent.reviewDetailed
      ? this.agent.reviewDetailed(input)
      : { output: await this.agent.review(input) };
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
  get estimatedCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxCostCny(): number { return this.metadata?.estimatedCostCny ?? 0; }
  get maxAttempts(): number { return this.metadata?.maxAttempts ?? 1; }

  run(): Promise<VisualReviewExecution> {
    throw new Error(`Visual review provider '${this.id}' is temporarily unavailable; configure it and regenerate this node.`);
  }
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
    dependsOn: ["script"],
    getInput: (context) => ({ scriptPath: outputPath(context, "script", "scriptPath") }),
    validateInputOverride: (input) => ({ scriptPath: requiredOutputString(input, "scriptPath") }),
    execute: async (input, context) => {
      const attempt = await reserveAttemptDirectory(path.join(runsRoot, context.runId, "nodes", "visual-direction"));
      const scriptPath = requiredOutputString(input, "scriptPath");
      const script = JSON.parse(await readFile(scriptPath, "utf8")) as { scenes?: unknown };
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
      const execution = await context.resolveProvider<VisualDirectorAgentInput, CodexTaskExecution<unknown>>({
        capability: "storyboard.plan",
        providerId,
      }).run({
        brief: {
          title: brief.title,
          angle: brief.angle,
          audience: brief.audience,
          platform: brief.platform,
          durationSeconds: brief.durationSeconds,
          requestedProfileId: direction.profileId,
          ...(brief.templateSnapshot ? { templateBlueprint: brief.templateSnapshot.resolvedBlueprint } : {}),
          ...(brief.editorial ? { editorial: brief.editorial } : {}),
        },
        scenes,
        assetProviders,
        economics: brief.economics,
      }, context);
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
        economics: brief.economics,
      });
      const planPath = path.join(attempt.directory, "director_plan.json");
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      await writeTextAtomically(planPath, content);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "script")
        .map((artifact) => artifact.id);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "visual-direction",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: { directorPlanPath: planPath },
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
        ), ...(traceArtifact ? [traceArtifact] : [])],
      };
    },
    validateOverride: (output) => validatePathOutput(output, "directorPlanPath", "visual-direction"),
  };
}

// codex 编剧节点：输出与 worker 模板同契约的 script.json，下游节点无任何特判。
// 节点层对 agent 返回的 unknown 独立做 validateScriptDraft 硬校验，注入的 agent 无法绕过；
// 校验或 agent 失败即节点失败，绝不回退到本地模板。
function screenwriterNode(
  brief: ProductionBrief,
  agent: ScreenwriterAgent | undefined,
  runsRoot: string,
): NodeDefinition {
  const providerId = brief.providers.script;
  if (providerId !== "codex-screenwriter-v1" || !agent) {
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
      const execution = await context.resolveProvider<ScreenwriterAgentInput, CodexTaskExecution<unknown>>({
        capability: "script.draft",
        providerId,
      }).run(request, context);
      const requestedBrief = request.brief;
      const draft = validateScriptDraft(execution.output, { durationSeconds: requestedBrief.durationSeconds });
      const scriptPath = path.join(attempt.directory, "script.json");
      const script = {
        title: requestedBrief.title,
        ...(draft.viewerPromise ? { viewerPromise: draft.viewerPromise } : {}),
        ...(draft.narrativeArc ? { narrativeArc: draft.narrativeArc } : {}),
        hook: draft.scenes[0]!.narration,
        duration_target: requestedBrief.durationSeconds,
        disclosure_required: true,
        niche_slug: requestedBrief.nicheSlug,
        structure: "AI 编剧短视频结构",
        quality_checks: requestedBrief.editorial?.guardrails.length
          ? requestedBrief.editorial.guardrails
          : ["核验事实与数据", "人工审片后再发布"],
        platform_notes: {
          platform: requestedBrief.platform,
          audience: requestedBrief.audience,
          angle: requestedBrief.angle,
        },
        hashtags: [],
        scenes: draft.scenes,
      };
      const content = `${JSON.stringify(script, null, 2)}\n`;
      await writeTextAtomically(scriptPath, content);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "brief")
        .map((artifact) => artifact.id);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "script",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: { scriptPath },
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
        ), ...(traceArtifact ? [traceArtifact] : [])],
      };
    },
    validateOverride: (output) => validatePathOutput(output, "scriptPath", "script"),
  };
}

interface PublishCopyOutcome {
  copy: PublishCopy;
  source: string;
  fallbackReason?: string;
  writerId?: string;
  trace?: CodexTaskTrace;
}

// 发布文案的门面：成功返回模型结果，任何失败都降级为 brief-title 回退，不向上抛异常。
async function generatePublishCopy(input: {
  writer: PublishCopyWriter | undefined;
  brief: ProductionBrief;
  scriptPath: string;
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
    };
  } catch {
    return fallbackCopyOutcome(input.brief);
  }
}

function fallbackCopyOutcome(brief: ProductionBrief): PublishCopyOutcome {
  return {
    copy: { title: brief.title, description: "", hashtags: [] },
    source: "brief-title",
    fallbackReason: "codex-publish-copy-unavailable",
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
  return { brief };
}

function validateVisualReviewInput(value: unknown, directorEnabled: boolean): VisualReviewAgentInput {
  const input = requireOutputRecord(value, "visual-review input");
  const request: VisualReviewAgentInput = {
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
      const execution = await context.resolveProvider<VisualReviewAgentInput, VisualReviewExecution>({
        capability: "quality.review.visual",
        providerId,
      }).run(request, context);
      const report = execution.output;
      const reportPath = path.join(attempt.directory, "visual_review.json");
      const content = `${JSON.stringify(report, null, 2)}\n`;
      await writeTextAtomically(reportPath, content);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer && ["render", "technical-review"].includes(artifact.producer.nodeId))
        .map((artifact) => artifact.id);
      const traceArtifact = await persistModelTrace({
        trace: execution.trace,
        attemptDirectory: attempt.directory,
        nodeId: "visual-review",
        attempt: attempt.attempt,
        parentArtifactIds,
      });
      return {
        status: "succeeded",
        output: {
          visualReviewPath: reportPath,
          report,
          durationMs: execution.inspectedDurationMs ?? brief.durationSeconds * 1_000,
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
        ), ...(traceArtifact ? [traceArtifact] : [])],
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

function providerConfigs(brief: ProductionBrief, options: ProductionPipelineOptions): ProviderConfig[] {
  const runtimeMetadata = new Map((options.providerRuntimeMetadata ?? []).map((item) => [item.id, item]));
  const assetMetadata = resolveAssetRuntimeMetadata(brief, runtimeMetadata, options.assetProviders ?? []);
  return [
    ...(brief.providers.script === "codex-screenwriter-v1"
      ? []
      : [providerConfig(brief.providers.script, "script.draft", "script", {}, runtimeMetadata.get(brief.providers.script))]),
    providerConfig(brief.providers.assets, "asset.prepare", "assets", {
      maxPaidShots: brief.economics.maxPaidShots,
      maxCostCny: brief.economics.maxCostCny,
    }, assetMetadata),
    providerConfig(brief.providers.voice, "voice.synthesize", "voice", {
      profileId: brief.voiceDirection.profileId,
      voice: brief.voiceDirection.profileId.slice(brief.voiceDirection.profileId.indexOf(":") + 1),
      rate: brief.voiceDirection.rate,
      pauseScale: brief.voiceDirection.pauseScale,
      masteringPreset: brief.voiceDirection.masteringPreset,
      maxCostCny: brief.economics.maxCostCny,
    }, runtimeMetadata.get(brief.providers.voice)),
    providerConfig(brief.providers.render, "video.render", "render", {}, runtimeMetadata.get(brief.providers.render)),
    providerConfig(brief.providers.technicalReview, "quality.review", "technical-review", {}, runtimeMetadata.get(brief.providers.technicalReview)),
  ];
}

function resolveAssetRuntimeMetadata(
  brief: ProductionBrief,
  metadata: Map<string, ProductionProviderRuntimeMetadata>,
  catalog: VisualAssetProviderCapability[],
): ProductionProviderRuntimeMetadata | undefined {
  const selected = metadata.get(brief.providers.assets);
  if (brief.providers.assets !== "ai-shot-router-v1" || !brief.director) return selected;
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const meteredIds = brief.director.assetProviderIds.filter((id) =>
    catalogById.get(id)?.billing === "metered" || KNOWN_METERED_WORKER_PROVIDER_IDS.has(id));
  const metered = meteredIds.map((id) => {
    const item = metadata.get(id);
    validateProviderRuntimeMetadata(id, item, true, brief.economics.maxCostCny);
    return item!;
  });
  if (!metered.length) return selected;
  const highestUnitCost = Math.max(...metered.map((item) => item.estimatedCostCny ?? 0));
  return {
    id: "ai-shot-router-v1",
    label: "AI 逐镜路由（含付费镜头）",
    modelId: metered.map((item) => item.modelId).sort().join("+") || "dynamic-router",
    transport: "local_process",
    billing: "metered",
    estimatedCostCny: roundCurrency(highestUnitCost * brief.economics.maxPaidShots),
    maxAttempts: 1,
  };
}

function providerConfig(
  id: string,
  capability: Capability,
  nodeId: string,
  parametersOverride: Record<string, unknown> = {},
  metadata?: ProductionProviderRuntimeMetadata,
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
    parametersOverride.maxCostCny,
  );
  return { id, capability, nodeId, parameters: { ...parameters, ...parametersOverride }, ...(metadata ? { metadata } : {}) };
}

function validateProviderRuntimeMetadata(
  providerId: string,
  metadata: ProductionProviderRuntimeMetadata | undefined,
  mustBeMetered: boolean,
  maxCostCny: unknown,
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
  if (metadata.billingUnit === "run") return;
  if (typeof maxCostCny !== "number" || !Number.isFinite(maxCostCny) || maxCostCny <= 0) {
    throw new Error(`Metered provider '${providerId}' requires a finite positive generation limit.`);
  }
  if (metadata.estimatedCostCny > maxCostCny) {
    throw new Error(`Metered provider '${providerId}' estimated cost exceeds the production limit.`);
  }
}

function validateVisualReviewRuntimeMetadata(
  providerId: string,
  metadata: ProductionProviderRuntimeMetadata | undefined,
): void {
  if (!KNOWN_METERED_VISUAL_REVIEW_PROVIDER_IDS.has(providerId)) return;
  validateProviderRuntimeMetadata(providerId, metadata, true, metadata?.estimatedCostCny);
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

function providerExecutionReceipt(
  provider: Pick<Provider<any, any>, "id" | "label" | "modelId" | "transport" | "billing" | "estimatedCostCny">,
  response: WorkerResponse,
): NodeExecutionReceiptDraft {
  const actualCost = response.diagnostics?.actualCostCny;
  if (actualCost !== undefined && (typeof actualCost !== "number" || !Number.isFinite(actualCost) || actualCost < 0)) {
    throw new Error("Worker diagnostics actualCostCny must be a finite non-negative number.");
  }
  return {
    providerId: provider.id,
    providerLabel: provider.label ?? provider.id,
    modelId: provider.modelId ?? "unspecified",
    transport: provider.transport ?? "local_process",
    billing: provider.billing ?? "local_compute",
    ...(provider.estimatedCostCny !== undefined ? { estimatedCostCny: provider.estimatedCostCny } : {}),
    ...(actualCost !== undefined ? { actualCostCny: actualCost } : {}),
    requestId: response.commandId,
  };
}

function validateWorkerNodeOverride(nodeId: string, output: unknown): Record<string, unknown> {
  const requiredFields: Record<string, string[]> = {
    script: ["scriptPath"],
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
  return normalized;
}

function validateBriefInputOverride(value: unknown, workflowBrief: ProductionBrief): ProductionBrief {
  const parsed = parseBrief(value);
  const immutableConfigurationMatches = JSON.stringify({
    providers: parsed.providers,
    director: parsed.director,
    economics: parsed.economics,
    voiceDirection: parsed.voiceDirection,
    reviewMode: parsed.reviewMode,
  }) === JSON.stringify({
    providers: workflowBrief.providers,
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

function visualReviewRecommendation(input: unknown): VisualReviewReport["recommendation"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const report = (input as Record<string, unknown>).report;
  if (typeof report !== "object" || report === null || Array.isArray(report)) return undefined;
  const recommendation = (report as Record<string, unknown>).recommendation;
  return recommendation === "approve" || recommendation === "revise" || recommendation === "reject"
    ? recommendation
    : undefined;
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

function currentArtifactsForPackaging(context: WorkflowContext, brief: ProductionBrief): Artifact[] {
  const nodeOutputs = [
    { nodeId: "script", paths: [outputPath(context, "script", "scriptPath")] },
    ...(brief.director ? [{ nodeId: "visual-direction", paths: [outputPath(context, "visual-direction", "directorPlanPath")] }] : []),
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
    for (const artifact of matches) {
      if (!selected.some((candidate) => candidate.id === artifact.id)) selected.push(artifact);
    }
  }
  return selected;
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
