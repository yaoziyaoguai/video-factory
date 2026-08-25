import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ProviderRegistry,
  WorkflowRunner,
  type Artifact,
  type ArtifactDraft,
  type Capability,
  type HumanDecisionDraft,
  type NodeDefinition,
  type NodeExecutionResult,
  type Provider,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@video-factory/workflow-core";
import { validatePublishCopy, type PublishCopy, type PublishCopyWriter } from "./codex-publish-copy.js";
import { validateScriptDraft, type ScreenwriterAgent, type ScreenwriterAgentInput } from "./codex-screenwriter.js";
import { parseBrief, WORKER_PROTOCOL_VERSION, type ProductionBrief } from "./contracts.js";
import { FileRunStore } from "./run-store.js";
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
  clock?: () => string;
  idFactory?: (prefix: string) => string;
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
    "final-review",
    "publish-package",
  ];
}

const INTERRUPTED_RUN_ERROR = "应用重启中断了这次制作，请重新发起制作。已完成的产物仍保留在本次记录中。";

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
          await this.store.create(run);
          created = true;
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
    return { runId, completion };
  }

  async show(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.store.load<ProductionBrief>(runId);
  }

  async list(): Promise<WorkflowRun<ProductionBrief>[]> {
    return this.store.list<ProductionBrief>();
  }

  async recoverInterruptedRuns(): Promise<number> {
    const interrupted = (await this.store.list<ProductionBrief>())
      .filter((run) => run.status === "pending" || run.status === "running");
    for (const run of interrupted) {
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
    }
    return interrupted.length;
  }

  async decide(runId: string, decision: HumanDecisionDraft): Promise<WorkflowRun<ProductionBrief>> {
    return this.store.update<ProductionBrief>(runId, async (previous) => {
      const brief = parseBrief(previous.initialInput);
      const registry = this.createRegistry(brief);
      const runner = new WorkflowRunner({ providers: registry, clock: this.clock, idFactory: this.idFactory });
      return runner.resume(this.createWorkflow(brief, decision), previous, decision);
    });
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
    for (const config of providerConfigs(brief)) {
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
        const response = await context.resolveProvider<Record<string, unknown>, WorkerResponse>({
          capability,
          providerId,
        }).run(input as Record<string, unknown>, context);
        return workerResponseToNodeResult(response, context, parentNodeIds);
      },
    });

    const nodes: NodeDefinition[] = [
      {
        id: "brief",
        label: "Validate brief",
        role: "制片人",
        capability: "brief.validate",
        mode: "automatic",
        execute: () => ({
          status: "succeeded",
          output: brief,
          artifacts: [jsonArtifact("production_brief", brief, "video-factory/brief-v1", "brief", [])],
        }),
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
        ["script"],
        ["script"],
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
      {
        id: "final-review",
        label: "Human final review",
        role: "总导演",
        capability: "quality.review.human",
        mode: brief.reviewMode === "manual" ? "manual" : "automatic",
        dependsOn: ["technical-review"],
        getInput: (context) => context.outputs.get("technical-review"),
        execute: (input) => {
          if (brief.reviewMode === "automatic") {
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
      },
      {
        id: "publish-package",
        label: "发布文案与发布包",
        role: "发行编辑",
        capability: "publish.package",
        mode: "automatic",
        dependsOn: ["final-review"],
        execute: async (_input, context) => {
          await verifyStoredArtifacts(context.artifacts);
          const artifactIds = context.artifacts.map((artifact) => artifact.id);
          const scriptParentIds = context.artifacts
            .filter((artifact) => artifact.producer?.nodeId === "script")
            .map((artifact) => artifact.id);
          // 文案是增强能力：失败不让已过审的成片失败，也不暴露异常文本；pipeline 层不重试。
          const copyOutcome = await generatePublishCopy({
            writer: this.options.publishCopyWriter,
            brief,
            scriptPath: outputPath(context, "script", "scriptPath"),
          });
          const copyArtifacts: ArtifactDraft[] = [];
          if (copyOutcome.writerId !== undefined) {
            const copyPath = path.join(this.runsRoot, context.runId, "publish", "publish_copy.json");
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
            ));
          }
          const packagePath = path.join(this.runsRoot, context.runId, "publish", "publish_package.json");
          const payload = {
            version: "video-factory/publish-package-v1",
            runId: context.runId,
            platform: brief.platform,
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
            artifacts: context.artifacts,
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
              ),
              ...copyArtifacts,
            ],
          };
        },
      },
    ];

    return {
      id: "daily-production",
      name: "Daily short-video production",
      version: brief.director ? "1.1.0" : "1.0.0",
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

  async run(input: Record<string, unknown>, context: WorkflowContext): Promise<WorkerResponse> {
    const outputDir = path.join(this.runsRoot, context.runId, "nodes", this.config.nodeId, "attempt-1");
    const response = await this.worker.run({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      commandId: context.nextId("command"),
      runId: context.runId,
      nodeRunId: this.config.nodeId,
      attempt: 1,
      capability: this.config.capability,
      input,
      parameters: { ...this.config.parameters, providerId: this.config.id },
      outputDir,
    });
    await verifyWorkerArtifacts(response, outputDir);
    return response;
  }
}

class VisualDirectorProvider implements Provider<VisualDirectorAgentInput, unknown> {
  readonly capability: Capability = "storyboard.plan";

  constructor(private readonly agent: VisualDirectorAgent) {}

  get id(): string {
    return this.agent.id;
  }

  run(input: VisualDirectorAgentInput): Promise<unknown> {
    return this.agent.plan(input);
  }
}

class ScreenwriterProvider implements Provider<ScreenwriterAgentInput, unknown> {
  readonly capability: Capability = "script.draft";

  constructor(private readonly agent: ScreenwriterAgent) {}

  get id(): string {
    return this.agent.id;
  }

  run(input: ScreenwriterAgentInput): Promise<unknown> {
    return this.agent.draft(input);
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
    execute: async (input, context) => {
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
          strengths: [...(provider.strengths ?? provider.modes)],
          constraints: [...(provider.constraints ?? [])],
          estimatedCnyPerClip: provider.estimatedCnyPerClip ?? 0,
        };
      });
      const rawPlan = await context.resolveProvider<VisualDirectorAgentInput, unknown>({
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
        },
        scenes,
        assetProviders,
        economics: brief.economics,
      }, context);
      const selectedCatalog = direction.assetProviderIds.map((id) => catalog.get(id)!);
      const plan = validateVisualDirectorPlan(rawPlan, {
        scenePositions: scenes.map((scene) => scene.position),
        allowedProviderIds: direction.assetProviderIds,
        generativeProviderIds: selectedCatalog.filter((provider) => provider.generative).map((provider) => provider.id),
        estimatedCnyPerClip: Object.fromEntries(selectedCatalog.map((provider) => [provider.id, provider.estimatedCnyPerClip ?? 0])),
        economics: brief.economics,
      });
      const planPath = path.join(runsRoot, context.runId, "nodes", "visual-direction", "attempt-1", "director_plan.json");
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      await writeTextAtomically(planPath, content);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "script")
        .map((artifact) => artifact.id);
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
        )],
      };
    },
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
    getInput: () => ({ brief }),
    execute: async (_input, context) => {
      const rawDraft = await context.resolveProvider<ScreenwriterAgentInput, unknown>({
        capability: "script.draft",
        providerId,
      }).run({
        brief: {
          title: brief.title,
          angle: brief.angle,
          audience: brief.audience,
          nicheSlug: brief.nicheSlug,
          platform: brief.platform,
          durationSeconds: brief.durationSeconds,
        },
      }, context);
      const draft = validateScriptDraft(rawDraft, { durationSeconds: brief.durationSeconds });
      const scriptPath = path.join(runsRoot, context.runId, "nodes", "script", "attempt-1", "script.json");
      const content = `${JSON.stringify(draft, null, 2)}\n`;
      await writeTextAtomically(scriptPath, content);
      const parentArtifactIds = context.artifacts
        .filter((artifact) => artifact.producer?.nodeId === "brief")
        .map((artifact) => artifact.id);
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
        )],
      };
    },
  };
}

interface PublishCopyOutcome {
  copy: PublishCopy;
  source: string;
  fallbackReason?: string;
  writerId?: string;
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
    const rawCopy = await input.writer.write({
      platform: input.brief.platform,
      brief: {
        title: input.brief.title,
        angle: input.brief.angle,
        audience: input.brief.audience,
        nicheSlug: input.brief.nicheSlug,
      },
      narrations,
    });
    const copy = validatePublishCopy(rawCopy);
    return { copy, source: input.writer.id, writerId: input.writer.id };
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
  if (narrations.length < 3 || narrations.length > 10) {
    throw new Error("Publish copy requires 3 to 10 script narrations.");
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
    };
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

function providerConfigs(brief: ProductionBrief): ProviderConfig[] {
  return [
    ...(brief.providers.script === "codex-screenwriter-v1"
      ? []
      : [providerConfig(brief.providers.script, "script.draft", "script")]),
    providerConfig(brief.providers.assets, "asset.prepare", "assets", {
      maxPaidShots: brief.economics.maxPaidShots,
      maxCostCny: brief.economics.maxCostCny,
    }),
    providerConfig(brief.providers.voice, "voice.synthesize", "voice", {
      profileId: brief.voiceDirection.profileId,
      voice: brief.voiceDirection.profileId.slice(brief.voiceDirection.profileId.indexOf(":") + 1),
      rate: brief.voiceDirection.rate,
      pauseScale: brief.voiceDirection.pauseScale,
      masteringPreset: brief.voiceDirection.masteringPreset,
    }),
    providerConfig(brief.providers.render, "video.render", "render"),
    providerConfig(brief.providers.technicalReview, "quality.review", "technical-review"),
  ];
}

function providerConfig(
  id: string,
  capability: Capability,
  nodeId: string,
  parametersOverride: Record<string, unknown> = {},
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
      "seedance-video-v1": { provider: "seedance", mediaType: "video" },
      "wan-video-v1": { provider: "wan", mediaType: "video" },
    },
    "voice.synthesize": {
      "macos-say-v1": { provider: "macos-say", voice: "Tingting", rate: 190 },
      "kokoro-local-v1": { provider: "kokoro", voice: "zf_001", rate: 180 },
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
  return { id, capability, nodeId, parameters: { ...parameters, ...parametersOverride } };
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
): ArtifactDraft {
  return {
    kind,
    uri,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    contentType,
    schemaVersion,
    parentArtifactIds,
    producer: { nodeId, attempt: 1 },
    provenance: { providerId, providerVersion: "1", licenseNote },
  };
}

async function writeTextAtomically(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
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
