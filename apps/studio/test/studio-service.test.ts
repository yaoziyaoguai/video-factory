import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { HumanDecisionDraft, NodeInputOverrideDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
import type {
  DispatchedProductionRun,
  ProductionBrief,
  ProductionRunListener,
} from "@video-factory/production-pipeline";
import { StaleRunRevisionError } from "@video-factory/production-pipeline";
import {
  StudioConflictError,
  StudioService,
  type StudioPipelinePort,
} from "../src/server/studio-service.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import type { StudioOpportunityInput } from "../src/shared/api.js";

const brief: ProductionBrief = {
  protocolVersion: "video-factory/brief-v1",
  title: "做决定前，先避开这 3 个坑",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 24,
  platform: "douyin",
  reviewMode: "manual",
  economics: {
    recipeId: "economy-daily",
    allowMeteredProviders: false,
    maxPaidShots: 0,
    maxCostCny: 0,
  },
  providers: {
    script: "python-template-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
};

function waitingRun(workspaceRoot: string): WorkflowRun<ProductionBrief> {
  const videoPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "render", "attempt-1", "final.mp4");
  return {
    id: "run-1",
    revision: 0,
    workflowId: "daily-production",
    workflowVersion: "1.0.0",
    status: "needs_human",
    initialInput: brief,
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z",
    executionPlan: [{
      nodeId: "publish-package",
      role: "发行编辑",
      capability: "publish.package",
      providerId: "codex-publish-copy-v1",
      providerLabel: "Codex 发行编辑",
      modelId: "gpt-5.4",
      transport: "unix_socket",
      billing: "subscription",
      configurationSource: "template_default",
      parameters: { promptPack: "video-factory/publish-copy-v2" },
      estimatedCostCny: 0,
    }],
    nodeRuns: [
      {
        nodeId: "render",
        status: "succeeded",
        startedAt: "2026-08-21T10:00:30.000Z",
        finishedAt: "2026-08-21T10:00:50.000Z",
        artifactIds: ["artifact-video"],
        qualityGateResults: [],
      },
      {
        nodeId: "final-review",
        status: "needs_human",
        startedAt: "2026-08-21T10:01:00.000Z",
        finishedAt: "2026-08-21T10:01:00.000Z",
        artifactIds: [],
        qualityGateResults: [],
        intervention: {
          id: "intervention-1",
          nodeId: "final-review",
          reason: "请完整观看成片。",
          requiredAction: "approve",
          options: ["approve", "reject"],
          createdAt: "2026-08-21T10:01:00.000Z",
        },
      },
    ],
    artifacts: [
      {
        id: "artifact-video",
        kind: "render",
        uri: videoPath,
        createdAt: "2026-08-21T10:00:50.000Z",
        contentType: "video/mp4",
        sizeBytes: 12,
        sha256: "a".repeat(64),
        producer: { nodeId: "render", attempt: 1 },
        provenance: { providerId: "python-ffmpeg-v1", licenseNote: "Generated locally." },
      },
    ],
    interventions: [
      {
        id: "intervention-1",
        nodeId: "final-review",
        reason: "请完整观看成片。",
        requiredAction: "approve",
        options: ["approve", "reject"],
        createdAt: "2026-08-21T10:01:00.000Z",
      },
    ],
    decisions: [],
  };
}

class FakePipeline implements StudioPipelinePort {
  run: WorkflowRun<ProductionBrief>;
  showError?: Error;
  listener?: ProductionRunListener;
  lastDecision?: HumanDecisionDraft;
  lastOverride?: NodeOverrideDraft;
  lastInputOverride?: NodeInputOverrideDraft;
  lastAuthorization?: SpendAuthorizationDraft;
  dispatchCount = 0;
  lastInput?: unknown;
  dispatchGate?: Promise<void>;

  constructor(run: WorkflowRun<ProductionBrief>) {
    this.run = run;
  }

  async list(): Promise<WorkflowRun<ProductionBrief>[]> {
    return [this.run];
  }

  async show(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    if (this.showError) throw this.showError;
    if (runId !== this.run.id) {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return this.run;
  }

  async loadPersisted(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    if (runId !== this.run.id) {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return this.run;
  }

  async dispatch(input: unknown, listener?: ProductionRunListener): Promise<DispatchedProductionRun> {
    this.dispatchCount += 1;
    this.lastInput = input;
    this.listener = listener;
    await this.dispatchGate;
    return { runId: this.run.id, completion: Promise.resolve(this.run) };
  }

  async decide(_runId: string, decision: HumanDecisionDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastDecision = decision;
    this.run = {
      ...this.run,
      revision: 1,
      status: decision.action === "approve" ? "succeeded" : "rejected",
    };
    return this.run;
  }

  async applyNodeOverride(_runId: string, override: NodeOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastOverride = override;
    return this.run;
  }

  async applyNodeInputOverride(_runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastInputOverride = override;
    return this.run;
  }

  async authorizeSpend(_runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastAuthorization = authorization;
    return this.run;
  }

  async resumeStale(_runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.run;
  }
}

const allCommandsAvailable = async (): Promise<boolean> => true;
const stoppedTrendGateway = {
  listServices: async () => [],
  listSignals: async () => [],
};

const opportunityInput: StudioOpportunityInput = {
  title: "下班后什么都不想做，是懒还是耗竭？",
  platform: "douyin",
  track: "ordinary-life",
  audience: "普通上班族",
  painPoint: "下班后没有精力",
  hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
  evidence: [{ source: "manual", platform: "douyin", keyword: "下班后", strength: 86 }],
  scores: {
    audienceReach: 88,
    visualFeasibility: 90,
    productionCostEfficiency: 84,
    novelty: 78,
    monetization: 62,
    seriesPotential: 91,
    complianceRisk: 18,
  },
};

describe("StudioService", () => {
  it("maps persisted runs to queue and detail DTOs", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const summaries = await service.listRuns();
    const detail = await service.getRun("run-1");

    assert.equal(summaries[0]?.title, brief.title);
    assert.equal(summaries[0]?.currentNodeId, "final-review");
    assert.equal(summaries[0]?.nextAction, "review");
    assert.equal(summaries[0]?.videoContentUrl, "/api/runs/run-1/artifacts/artifact-video/content");
    assert.equal(detail?.nodes.find((node) => node.id === "final-review")?.label, "人工终审");
    const publishNode = detail?.nodes.find((node) => node.id === "publish-package");
    assert.equal(publishNode?.label, "发布文案与发布包");
    assert.equal(publishNode?.role, "发行编辑");
    assert.equal(publishNode?.plannedExecution?.modelId, "gpt-5.4");
    assert.equal(publishNode?.plannedExecution?.configurationSource, "template_default");
    assert.deepEqual(publishNode?.plannedExecution?.parameters, { promptPack: "video-factory/publish-copy-v2" });
    assert.equal(detail?.nodes.at(-1)?.status, "pending");
    assert.equal(detail?.activeIntervention?.id, "intervention-1");
    assert.equal(detail?.videoArtifactId, "artifact-video");
    assert.equal(detail?.artifacts[0]?.contentUrl, "/api/runs/run-1/artifacts/artifact-video/content");
  });

  it("maps the effective render and publish-package versions instead of historical artifacts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    const newVideoPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "render", "attempt-2", "final.mp4");
    const oldPackagePath = path.join(workspaceRoot, "runs", "run-1", "publish", "attempt-1", "publish_package.json");
    const newPackagePath = path.join(workspaceRoot, "runs", "run-1", "publish", "attempt-2", "publish_package.json");
    run.artifacts.push(
      {
        id: "artifact-video-current",
        kind: "render",
        uri: newVideoPath,
        createdAt: "2026-08-21T10:02:00.000Z",
        contentType: "video/mp4",
        producer: { nodeId: "render", attempt: 2 },
        provenance: { providerId: "python-ffmpeg-v1" },
      },
      {
        id: "artifact-package-old",
        kind: "publish_package",
        uri: oldPackagePath,
        createdAt: "2026-08-21T10:03:00.000Z",
        contentType: "application/json",
        producer: { nodeId: "publish-package", attempt: 1 },
        provenance: { providerId: "codex-publish-copy-v1" },
      },
      {
        id: "artifact-package-current",
        kind: "publish_package",
        uri: newPackagePath,
        createdAt: "2026-08-21T10:04:00.000Z",
        contentType: "application/json",
        producer: { nodeId: "publish-package", attempt: 2 },
        provenance: { providerId: "codex-publish-copy-v1" },
      },
    );
    run.nodeRuns[0]!.artifactIds = ["artifact-video-current"];
    run.nodeRuns[0]!.outputState = {
      generatedVersionId: "render-v1",
      effectiveVersionId: "render-v2",
      stale: false,
      versions: [
        { id: "render-v1", nodeId: "render", source: "generated", artifactIds: ["artifact-video"], inputVersionIds: [], createdAt: "2026-08-21T10:00:50.000Z", createdBy: "python-ffmpeg-v1", schemaVersion: "1" },
        { id: "render-v2", nodeId: "render", source: "generated", artifactIds: ["artifact-video-current"], inputVersionIds: [], createdAt: "2026-08-21T10:02:00.000Z", createdBy: "python-ffmpeg-v1", schemaVersion: "1" },
      ],
    };
    run.nodeRuns.push({
      nodeId: "publish-package",
      status: "succeeded",
      artifactIds: ["artifact-package-current"],
      qualityGateResults: [],
      outputState: {
        generatedVersionId: "package-v1",
        effectiveVersionId: "package-v2",
        stale: false,
        versions: [
          { id: "package-v1", nodeId: "publish-package", source: "generated", artifactIds: ["artifact-package-old"], inputVersionIds: [], createdAt: "2026-08-21T10:03:00.000Z", createdBy: "codex-publish-copy-v1", schemaVersion: "1" },
          { id: "package-v2", nodeId: "publish-package", source: "generated", artifactIds: ["artifact-package-current"], inputVersionIds: [], createdAt: "2026-08-21T10:04:00.000Z", createdBy: "codex-publish-copy-v1", schemaVersion: "1" },
        ],
      },
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const [summary] = await service.listRuns();
    const detail = await service.getRun("run-1");

    assert.equal(summary?.videoContentUrl, "/api/runs/run-1/artifacts/artifact-video-current/content");
    assert.equal(detail?.videoArtifactId, "artifact-video-current");
    assert.equal(detail?.publishPackageArtifactId, "artifact-package-current");
  });

  it("dispatches valid available providers and publishes snapshots", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const snapshots: string[] = [];
    service.subscribe("run-1", (run) => snapshots.push(run.status));

    const result = await service.startRun(brief);
    await pipeline.listener?.(pipeline.run);

    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot?.templateId, "knowledge-explainer");
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot?.resolvedBlueprint.platform, "douyin");
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot?.resolvedBlueprint.durationSeconds, 24);
    assert.deepEqual(snapshots, ["needs_human"]);
    await assert.rejects(
      () => service.startRun({
        ...brief,
        providers: { ...brief.providers, assets: "pexels-stock-v1" },
      }),
      /PEXELS_API_KEY/,
    );
  });

  it("enforces manual review and a server-side hard budget before dispatch", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { VIDEO_FACTORY_MAX_RUN_COST_CNY: "8" },
    });

    await assert.rejects(() => service.startRun({ ...brief, reviewMode: "automatic" }), /人工终审/);
    await assert.rejects(() => service.startRun({
      ...brief,
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 9 },
    }), /服务端安全上限.*8/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("persists production idempotency across service restarts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const firstService = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const first = await firstService.startRun(brief, "production-request-1");
    const restartedService = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const repeated = await restartedService.startRun(brief, "production-request-1");

    assert.deepEqual(repeated, first);
    assert.equal(pipeline.dispatchCount, 1);
    await assert.rejects(
      () => restartedService.startRun({ ...brief, title: "不同参数" }, "production-request-1"),
      /另一组参数/,
    );
  });

  it("rejects an empty idempotent start as user input instead of failing while hashing it", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-empty-start-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.startRun(undefined, "empty-production-request-1"),
      /制作参数不符合要求/,
    );
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("rejects different parameters that reuse an in-flight idempotency key", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-in-flight-idempotency-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    let releaseDispatch!: () => void;
    pipeline.dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const first = service.startRun(brief, "in-flight-production-request-1");
    while (pipeline.dispatchCount === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(
      () => service.startRun({ ...brief, title: "另一条制作" }, "in-flight-production-request-1"),
      /另一组参数/,
    );
    releaseDispatch();

    assert.deepEqual(await first, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("replays the original start after global model defaults change", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-model-idempotency-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = {
      ARK_API_KEY: "seedance-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment });
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-5-260628" } });
    const input = {
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
    };

    const first = await service.startRun(input, "model-default-request-1");
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-0-260128" } });
    const restarted = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment });

    assert.deepEqual(await restarted.startRun(input, "model-default-request-1"), first);
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("replays a referenced start after the persisted node safely releases its temporary upload", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-reference-idempotency-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const availability = { available: true, reason: "", taskKinds: ["reference-grammar", "director-plan"] };
    const firstService = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: availability,
    });
    const uploaded = await firstService.uploadReferenceVideo({
      label: "参考节奏.mp4",
      mimeType: "video/mp4",
      bytes: Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]),
    });
    const input = {
      ...brief,
      providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
      referenceVideo: { uploadId: uploaded.uploadId, label: uploaded.label },
    };

    const first = await firstService.startRun(input, "referenced-production-request-1");
    pipeline.run = {
      ...pipeline.run,
      initialInput: pipeline.lastInput as ProductionBrief,
      nodeRuns: [{ nodeId: "reference-grammar", status: "succeeded", artifactIds: [], qualityGateResults: [] }, ...pipeline.run.nodeRuns],
    };
    pipeline.listener?.(pipeline.run);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const restarted = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: availability,
    });
    assert.deepEqual(await restarted.startRun(input, "referenced-production-request-1"), first);
    await assert.rejects(() => restarted.startRun(input, "referenced-production-request-2"), /参考视频不存在或已经失效/);
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("blocks metered providers when paid generation is disabled or underfunded", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
        SEEDREAM_MODEL_ID: "seedream-model",
        SEEDREAM_ESTIMATED_CNY_PER_IMAGE: "0.25",
      },
    });
    const seedanceBrief = {
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
    };

    await assert.rejects(() => service.startRun(seedanceBrief), /未允许使用付费能力/);
    await assert.rejects(
      () => service.startRun({
        ...seedanceBrief,
        economics: {
          recipeId: "keyshot-ai",
          allowMeteredProviders: true,
          maxPaidShots: 2,
          maxCostCny: 5,
        },
      }),
      /预计需要.*7.*预计成本上限.*5/,
    );

    await service.startRun({
      ...seedanceBrief,
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 4,
      },
    });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("accepts one metered GLM review without treating it as a paid shot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      zaiCodexAvailability: { available: true, reason: "" },
    });

    await service.startRun({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    });

    assert.equal(pipeline.dispatchCount, 1);
  });

  it("includes per-run model estimates in the server-side safety ceiling", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { VIDEO_FACTORY_MAX_RUN_COST_CNY: "0.05" },
      zaiCodexAvailability: { available: true, reason: "" },
    });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    }), /按次能力预计合计.*0\.1.*安全上限.*0\.05/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("resolves model defaults as global, then template, then explicit run override", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = {
      ARK_API_KEY: "test-ark-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment });
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-1-5-pro-251215" } });
    const catalog = await service.listTemplates();
    const cloned = await service.cloneTemplate({
      sourceId: "knowledge-explainer",
      newId: "knowledge-model-routing",
      name: "知识模型路由",
      expectedRevision: catalog.storeRevision,
    });
    const saved = await service.saveTemplateDraft({
      ...cloned.template,
      modelDefaults: { "seedance-video-v1": "doubao-seedance-2-0-fast-260128" },
    }, cloned.storeRevision);
    await service.publishTemplate(saved.template.id, saved.storeRevision);
    const paidBrief = {
      ...brief,
      template: { templateId: "knowledge-model-routing" },
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
    };

    await service.startRun(paidBrief);
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-2-0-fast-260128");
    assert.equal((pipeline.lastInput as ProductionBrief).modelSelectionSources?.["seedance-video-v1"], "template_default");

    await service.startRun({
      ...paidBrief,
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
    });
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.equal((pipeline.lastInput as ProductionBrief).modelSelectionSources?.["seedance-video-v1"], "run_override");
  });

  it("rejects an invalid explicit model instead of silently replacing it with the global default", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-invalid-model-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment });
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-5-260628" } });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
      models: { "seedance-video-v1": 123 },
    }), /制作参数不符合要求/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("allows an unchanged stale model default to be cleared after provider credentials disappear", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const configured = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" } });
    const stale = { "seedance-video-v1": "doubao-seedance-1-5-pro-251215" };
    await configured.updateCreatorSettings({ modelDefaults: stale });

    const restarted = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const preserved = await restarted.updateCreatorSettings({
      modelDefaults: stale,
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 30 },
    });
    assert.deepEqual(preserved.modelDefaults, stale);
    const cleared = await restarted.updateCreatorSettings({ modelDefaults: {} });
    assert.deepEqual(cleared.modelDefaults, {});
    await assert.rejects(() => restarted.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "unknown-model" } }), /不属于能力/);
  });

  it("lets the Codex director run inside economy-daily without metered gating", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: { available: true, reason: "" },
    });

    const result = await service.startRun({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    });

    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("rejects a partially metered director pool without a free fallback", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      codexAvailability: { available: true, reason: "" },
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      },
    });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3.5 },
    }), /至少保留一个免费素材来源/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("refuses test-only providers at the server production boundary", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    await assert.rejects(
      () => service.startRun({
        ...brief,
        providers: { ...brief.providers, voice: "ffmpeg-tone-test-v1" },
        voiceDirection: {
          profileId: "tone:test",
          rate: 185,
          pauseScale: 1,
          masteringPreset: "natural",
        },
      }),
      /测试能力.*不能用于正式制作/,
    );
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("resolves the active intervention and enforces a rejection reason", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.decide("run-1", { action: "approve" }, "jinkun");

    assert.equal(pipeline.lastDecision?.interventionId, "intervention-1");
    assert.equal(pipeline.lastDecision?.action, "approve");

    pipeline.run = waitingRun(workspaceRoot);
    await assert.rejects(
      () => service.decide("run-1", { action: "reject" }, "jinkun"),
      (error: unknown) => error instanceof StudioConflictError && /填写原因/.test(error.message),
    );
  });

  it("maps concurrent review updates to a refreshable conflict", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    pipeline.decide = async () => {
      throw new StaleRunRevisionError("run-1", 0, 1);
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.decide("run-1", { action: "approve" }, "director"),
      (error: unknown) => error instanceof StudioConflictError && /刷新/.test(error.message),
    );
  });

  it("rejects node edits while a run is active and validates output against the current node schema", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.status = "running";
    run.nodeRuns.unshift({
      nodeId: "script",
      status: "succeeded",
      output: { hook: "旧钩子", scenes: [{ narration: "旧旁白" }] },
      artifactIds: [],
      qualityGateResults: [],
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.applyNodeOverride("run-1", "script", { output: { hook: "新钩子", scenes: [{ narration: "新旁白" }] } }, "trusted-owner"),
      /仍在执行/,
    );
    pipeline.run = { ...pipeline.run, status: "needs_human" };
    await assert.rejects(
      () => service.applyNodeOverride("run-1", "script", { output: { hook: 42, scenes: [] } }, "trusted-owner"),
      /output\.hook.*文字/,
    );
    await service.applyNodeOverride(
      "run-1",
      "script",
      { output: { hook: "新钩子", scenes: [{ narration: "新旁白" }] } },
      "trusted-owner",
    );
    assert.equal(pipeline.lastOverride?.actor, "trusted-owner");
  });

  it("requires explicit confirmation before editing a terminal run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.status = "succeeded";
    run.nodeRuns.unshift({ nodeId: "script", status: "succeeded", output: { hook: "旧钩子" }, artifactIds: [], qualityGateResults: [] });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.applyNodeOverride("run-1", "script", { output: { hook: "修订钩子" } }, "trusted-owner"),
      /明确确认/,
    );
    await service.applyNodeOverride(
      "run-1",
      "script",
      { output: { hook: "修订钩子" }, confirmTerminalEdit: true },
      "trusted-owner",
    );
    assert.equal(pipeline.lastOverride?.actor, "trusted-owner");
  });

  it("rejects a stale spend confirmation and authorizes only the current server plan", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.status = "awaiting_spend_approval";
    run.nodeRuns.unshift({
      nodeId: "assets",
      status: "awaiting_spend_approval",
      artifactIds: [],
      qualityGateResults: [],
      spendPlan: {
        id: "plan-current",
        inputVersionIds: ["script-human-v2"],
        providerId: "hailuo-video-v1",
        modelId: "MiniMax-Hailuo-02",
        estimatedCostCny: 2.4,
        maxCostCny: 3,
        maxAttempts: 1,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.authorizeSpend("run-1", "assets", {
        inputVersionIds: ["script-generated-v1"],
        providerId: "hailuo-video-v1",
        modelId: "MiniMax-Hailuo-02",
        maxCostCny: 3,
        maxAttempts: 1,
      }, "trusted-owner"),
      /费用计划或上游版本已经变化/,
    );
    assert.equal(pipeline.lastAuthorization, undefined);

    await service.authorizeSpend("run-1", "assets", {
      inputVersionIds: ["script-human-v2"],
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      maxCostCny: 3,
      maxAttempts: 1,
    }, "trusted-owner");
    assert.deepEqual(pipeline.lastAuthorization, {
      nodeId: "assets",
      inputVersionIds: ["script-human-v2"],
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      maxCostCny: 3,
      maxAttempts: 1,
      approvedBy: "trusted-owner",
    });
  });

  it("stores an edited JSON artifact as an immutable human version and rewires the node output", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    const scriptPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "attempt-1", "script.json");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, `${JSON.stringify({ title: "旧脚本", scenes: [{ narration: "旧旁白" }] })}\n`, "utf8");
    run.nodeRuns.unshift({
      nodeId: "script",
      status: "succeeded",
      output: { scriptPath },
      artifactIds: ["artifact-script"],
      qualityGateResults: [],
      outputState: {
        nodeId: "script",
        generatedVersionId: "script-generated-v1",
        effectiveVersionId: "script-generated-v1",
        stale: false,
        versions: [{
          id: "script-generated-v1",
          nodeId: "script",
          source: "generated",
          artifactIds: ["artifact-script"],
          output: { scriptPath },
          inputVersionIds: [],
          createdAt: "2026-08-21T10:00:20.000Z",
          createdBy: "codex-screenwriter-v1",
          schemaVersion: "video-factory/script-v1",
        }],
      },
    });
    run.artifacts.push({
      id: "artifact-script",
      kind: "script",
      uri: scriptPath,
      createdAt: "2026-08-21T10:00:20.000Z",
      contentType: "application/json",
      schemaVersion: "video-factory/script-v1",
      producer: { nodeId: "script", attempt: 1 },
      provenance: { providerId: "codex-screenwriter-v1" },
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.applyNodeOverride("run-1", "script", {
      document: {
        artifactId: "artifact-script",
        content: { title: "人工脚本", scenes: [{ narration: "人工旁白" }] },
      },
    }, "trusted-owner");

    const override = pipeline.lastOverride!;
    const humanPath = (override.output as { scriptPath: string }).scriptPath;
    assert.notEqual(humanPath, scriptPath);
    assert.match(humanPath, /nodes\/script\/human-revisions\/.+\.json$/);
    assert.deepEqual(JSON.parse(await readFile(humanPath, "utf8")), {
      title: "人工脚本",
      scenes: [{ narration: "人工旁白" }],
    });
    assert.equal(JSON.parse(await readFile(scriptPath, "utf8")).title, "旧脚本");
    assert.equal(override.artifacts?.[0]?.uri, humanPath);
    assert.equal(override.artifacts?.[0]?.provenance?.providerId, "human-editor");
    assert.deepEqual(override.artifacts?.[0]?.parentArtifactIds, ["artifact-script"]);
    assert.equal(override.expectedVersionId, "script-generated-v1");
  });

  it("keeps the private candidate inventory in sync with a human candidate edit", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    const nodeRoot = path.join(workspaceRoot, "runs", "run-1", "nodes", "asset-candidates", "attempt-1");
    const candidateSearchPath = path.join(nodeRoot, "asset_candidates.json");
    const candidateInventoryPath = path.join(nodeRoot, "asset_candidate_inventory.private.json");
    const candidate = (assetId: string) => ({
      provider: "pexels",
      provider_id: "pexels-stock-v1",
      asset_id: assetId,
      media_type: "video",
      width: 1080,
      height: 1920,
      duration: 5,
      preview_url: `https://images.example/${assetId}.jpg`,
      source_url: `https://www.pexels.com/video/${assetId}`,
      creator: "Creator",
      license_note: "Pexels license",
      query: "早餐摊",
      score: 90,
    });
    const report = {
      version: "video-factory/asset-candidates-v1",
      scene_candidates: [{
        scene_position: 1,
        intent: { subject: "早餐摊" },
        query: "早餐摊",
        candidates: [candidate("one"), candidate("two")],
        search_errors: [],
      }],
    };
    const inventory = {
      version: "video-factory/asset-candidate-inventory-v1",
      scene_candidates: [{
        scene_position: 1,
        candidates: [
          { ...candidate("one"), download_url: "https://private.example/one?token=one" },
          { ...candidate("two"), download_url: "https://private.example/two?token=two" },
        ],
      }],
    };
    await mkdir(nodeRoot, { recursive: true });
    await Promise.all([
      writeFile(candidateSearchPath, `${JSON.stringify(report)}\n`, "utf8"),
      writeFile(candidateInventoryPath, `${JSON.stringify(inventory)}\n`, "utf8"),
    ]);
    run.initialInput = {
      ...run.initialInput,
      workflowFeatures: { assetSemanticRank: true },
    };
    run.nodeRuns.unshift({
      nodeId: "asset-candidates",
      status: "succeeded",
      error: `broker socket '${candidateInventoryPath}' failed`,
      output: { candidateSearchPath, candidateInventoryPath },
      artifactIds: ["artifact-candidates"],
      qualityGateResults: [{ gateId: "private-path", status: "passed", reasons: [`checked ${candidateInventoryPath}`] }],
      executionReceipt: {
        nodeId: "asset-candidates",
        capability: "asset.search",
        providerId: "asset-candidate-search-v1",
        providerLabel: "素材候选搜索",
        modelId: "search-v1",
        transport: "local_process",
        billing: "free",
        parameters: { inputPath: candidateInventoryPath, notes: [`loaded ${candidateInventoryPath}`] },
        fallbackReason: `private worker failed at ${candidateInventoryPath}`,
        status: "succeeded",
        startedAt: "2026-08-21T10:00:19.000Z",
        finishedAt: "2026-08-21T10:00:20.000Z",
      },
      outputState: {
        nodeId: "asset-candidates",
        generatedVersionId: "candidate-output-v1",
        effectiveVersionId: "candidate-output-v1",
        stale: false,
        versions: [{
          id: "candidate-output-v1",
          nodeId: "asset-candidates",
          source: "generated",
          artifactIds: ["artifact-candidates"],
          inputVersionIds: [],
          output: { candidateSearchPath, candidateInventoryPath },
          createdAt: "2026-08-21T10:00:20.000Z",
          createdBy: "asset-candidate-search-v1",
          schemaVersion: "video-factory/asset-candidates-v1",
        }],
      },
    }, {
      nodeId: "assets",
      status: "stale",
      artifactIds: [],
      qualityGateResults: [],
      inputState: {
        nodeId: "assets",
        effectiveVersionId: "assets-input-v1",
        stale: false,
        versions: [{
          id: "assets-input-v1",
          nodeId: "assets",
          source: "derived",
          value: { candidateInventoryPath, selectedAssetIds: ["one"] },
          upstreamVersionIds: ["candidate-output-v1"],
          createdAt: "2026-08-21T10:00:21.000Z",
          createdBy: "workflow:assets",
          schemaVersion: "1",
        }],
      },
    });
    run.artifacts.push({
      id: "artifact-candidates",
      kind: "asset_candidates",
      uri: candidateSearchPath,
      createdAt: "2026-08-21T10:00:20.000Z",
      contentType: "application/json",
      producer: { nodeId: "asset-candidates", attempt: 1 },
      provenance: { providerId: "asset-candidate-search-v1" },
    });
    run.executionPlan?.unshift({
      nodeId: "asset-candidates",
      capability: "asset.search",
      providerId: "asset-candidate-search-v1",
      providerLabel: "素材候选搜索",
      modelId: "search-v1",
      transport: "local_process",
      billing: "free",
      parameters: { inputPath: candidateInventoryPath, notes: [`planned ${candidateInventoryPath}`] },
      snapshotSource: "created",
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const edited = structuredClone(report);
    edited.scene_candidates[0]!.candidates = [candidate("two")];

    const detail = await service.getRun("run-1");
    const candidateNode = detail?.nodes.find((node) => node.id === "asset-candidates");
    const assetsNode = detail?.nodes.find((node) => node.id === "assets");
    assert.equal((candidateNode?.output as { candidateInventoryPath?: string }).candidateInventoryPath, "[系统托管文件]");
    assert.equal(
      (candidateNode?.outputState?.versions[0]?.output as { candidateInventoryPath?: string }).candidateInventoryPath,
      "[系统托管文件]",
    );
    assert.equal(
      (assetsNode?.inputState?.versions[0]?.value as { candidateInventoryPath?: string }).candidateInventoryPath,
      "[系统托管文件]",
    );
    assert.equal(JSON.stringify(detail).includes(candidateInventoryPath), false);
    assert.match(candidateNode?.error ?? "", /\[系统托管文件\]/);
    assert.match(candidateNode?.qualityGateResults[0]?.reasons[0] ?? "", /\[系统托管文件\]/);
    assert.equal(candidateNode?.executionReceipt?.parameters?.inputPath, "[系统托管文件]");
    assert.match(String(candidateNode?.executionReceipt?.parameters?.notes?.[0]), /\[系统托管文件\]/);
    assert.equal(candidateNode?.plannedExecution?.parameters?.inputPath, "[系统托管文件]");

    await service.applyNodeInputOverride("run-1", "assets", {
      input: { candidateInventoryPath: "[系统托管文件]", selectedAssetIds: ["two"] },
    }, "trusted-owner");
    assert.deepEqual(pipeline.lastInputOverride?.input, { candidateInventoryPath, selectedAssetIds: ["two"] });

    await service.applyNodeOverride("run-1", "asset-candidates", {
      document: { artifactId: "artifact-candidates", content: edited },
    }, "trusted-owner");

    const output = pipeline.lastOverride!.output as { candidateSearchPath: string; candidateInventoryPath: string };
    assert.match(output.candidateSearchPath, /human-revisions\/.+\.json$/);
    assert.match(output.candidateInventoryPath, /human-revisions\/.+\.inventory\.private\.json$/);
    assert.notEqual(output.candidateInventoryPath, candidateInventoryPath);
    const revisedInventory = JSON.parse(await readFile(output.candidateInventoryPath, "utf8"));
    assert.deepEqual(revisedInventory.scene_candidates[0].candidates.map((item: { asset_id: string }) => item.asset_id), ["two"]);
    assert.equal(JSON.stringify(revisedInventory).includes("token=one"), false);
    assert.equal(JSON.stringify(revisedInventory).includes("token=two"), true);
    assert.equal(pipeline.lastOverride!.artifacts?.length, 2);
    assert.equal(pipeline.lastOverride!.artifacts?.[1]?.kind, "candidate_inventory_private");
    assert.equal(pipeline.lastOverride!.artifacts?.[1]?.uri, output.candidateInventoryPath);

    const forged = structuredClone(report);
    forged.scene_candidates[0]!.candidates[0]!.preview_url = "http://127.0.0.1/private";
    await assert.rejects(
      () => service.applyNodeOverride("run-1", "asset-candidates", {
        document: { artifactId: "artifact-candidates", content: forged },
      }, "trusted-owner"),
      /preview_url 不能修改/,
    );
  });

  it("rejects document edits that do not target the node's current JSON artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.nodeRuns.unshift({
      nodeId: "script",
      status: "succeeded",
      output: { scriptPath: path.join(workspaceRoot, "runs", "run-1", "script.json") },
      artifactIds: [],
      qualityGateResults: [],
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.applyNodeOverride("run-1", "script", {
        document: { artifactId: "artifact-video", content: { title: "越权修改" } },
      }, "trusted-owner"),
      /当前可编辑产物/,
    );
    assert.equal(pipeline.lastOverride, undefined);
  });

  it("resolves only artifacts contained by the selected run directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    const videoPath = run.artifacts[0]!.uri!;
    await mkdir(path.dirname(videoPath), { recursive: true });
    await writeFile(videoPath, "video-bytes", "utf8");
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const resource = await service.resolveArtifact("run-1", "artifact-video");

    assert.equal(resource?.path, await realpath(videoPath));
    assert.equal(resource?.sizeBytes, 11);

    const referencePath = path.join(workspaceRoot, "runs", "run-1", "reference.mp4");
    await writeFile(referencePath, "private-reference", "utf8");
    pipeline.run = {
      ...run,
      artifacts: [...run.artifacts, {
        id: "artifact-reference",
        kind: "reference_video",
        uri: referencePath,
        createdAt: "2026-08-28T10:00:00.000Z",
        provenance: { providerId: "creator-upload" },
      }],
    };
    assert.equal(await service.resolveArtifact("run-1", "artifact-reference"), undefined);
    assert.equal((await service.getRun("run-1"))?.artifacts.find((artifact) => artifact.id === "artifact-reference")?.contentUrl, undefined);

    const privateInventoryPath = path.join(workspaceRoot, "runs", "run-1", "candidate_inventory.private.json");
    await writeFile(privateInventoryPath, '{"secret":"token"}\n', "utf8");
    pipeline.run = {
      ...pipeline.run,
      artifacts: [...pipeline.run.artifacts, {
        id: "artifact-private-inventory",
        kind: "candidate_inventory_private",
        uri: privateInventoryPath,
        createdAt: "2026-08-28T10:00:00.000Z",
        provenance: { providerId: "human-editor-private-state" },
      }],
    };
    assert.equal(await service.resolveArtifact("run-1", "artifact-private-inventory"), undefined);
    assert.equal((await service.getRun("run-1"))?.artifacts.find((artifact) => artifact.id === "artifact-private-inventory")?.contentUrl, undefined);

    const outsidePath = path.join(workspaceRoot, "outside.mp4");
    await writeFile(outsidePath, "outside", "utf8");
    pipeline.run = {
      ...run,
      artifacts: [{ ...run.artifacts[0]!, uri: outsidePath }],
    };
    await assert.rejects(() => service.resolveArtifact("run-1", "artifact-video"), /outside run directory/);
  });

  it("serves persisted artifacts even when a legacy brief cannot be rehydrated", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    const videoPath = run.artifacts[0]!.uri!;
    await mkdir(path.dirname(videoPath), { recursive: true });
    await writeFile(videoPath, "legacy-video", "utf8");
    const pipeline = new FakePipeline(run);
    pipeline.showError = new Error("legacy brief no longer satisfies the current contract");
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const resource = await service.resolveArtifact("run-1", "artifact-video");

    assert.equal(resource?.path, await realpath(videoPath));
    assert.equal(resource?.sizeBytes, 12);
  });

  it("reports provider availability without returning environment values", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: async (command) => command !== "say",
      codexAvailability: { available: true, reason: "" },
      environment: {
        PEXELS_API_KEY: "secret-value",
        ARK_API_KEY: "seedance-secret",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
        SEEDREAM_MODEL_ID: "seedream-model",
        SEEDREAM_ESTIMATED_CNY_PER_IMAGE: "0.25",
      },
    });

    const providers = await service.listProviders();
    const serialized = JSON.stringify(providers);

    assert.equal(providers.find((provider) => provider.id === "pexels-stock-v1")?.available, true);
    const codexTopic = providers.find((provider) => provider.id === "api-topic-editor-v1");
    assert.equal(codexTopic?.available, true);
    assert.equal(codexTopic?.billing, "subscription");
    assert.equal(codexTopic?.kind, "external");
    const codexDirector = providers.find((provider) => provider.id === "api-visual-director-v1");
    assert.equal(codexDirector?.available, true);
    assert.equal(codexDirector?.billing, "subscription");
    assert.equal(codexDirector?.kind, "external");
    const codexScreenwriter = providers.find((provider) => provider.id === "codex-screenwriter-v1");
    assert.equal(codexScreenwriter?.available, true);
    assert.equal(codexScreenwriter?.billing, "subscription");
    assert.equal(codexScreenwriter?.kind, "external");
    const codexPublishCopy = providers.find((provider) => provider.id === "codex-publish-copy-v1");
    assert.equal(codexPublishCopy?.available, true);
    assert.equal(codexPublishCopy?.billing, "subscription");
    assert.equal(codexPublishCopy?.kind, "external");
    assert.equal(providers.find((provider) => provider.id === "python-template-v1")?.available, true);
    assert.equal(providers.some((provider) => provider.id.includes("ollama") || provider.id.includes("qwen")), false);
    assert.equal(providers.find((provider) => provider.id === "macos-say-v1")?.available, false);
    const seedance = providers.find((provider) => provider.id === "seedance-video-v1");
    assert.equal(seedance?.available, true);
    assert.equal(seedance?.billing, "metered");
    assert.equal(seedance?.estimatedCnyPerClip, 3.5);
    assert.equal(seedance?.status, "ready");
    const seedream = providers.find((provider) => provider.id === "seedream-image-v1");
    assert.equal(seedream?.available, true);
    assert.equal(seedream?.billing, "metered");
    assert.equal(seedream?.estimatedCnyPerClip, 0.25);
    assert.equal(seedream?.status, "ready");
    assert.equal(providers.find((provider) => provider.id === "kling-video-v1")?.status, "planned");
    assert.doesNotMatch(serialized, /secret-value/);
    assert.doesNotMatch(serialized, /seedance-secret/);
    assert.doesNotMatch(serialized, /topic-secret|director-secret/);
  });

  it("never advertises retired self-hosted model providers", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      localCapabilities: {
        report: async () => [{ id: "kokoro-local", label: "Kokoro", category: "voice", state: "ready", evidence: "烟雾测试通过" }],
        listVoices: async () => [],
        preview: async () => undefined,
      },
    });

    const providerIds = (await service.listProviders()).map((provider) => provider.id);
    assert.equal(providerIds.some((id) => id.includes("ollama") || id.includes("qwen") || id.includes("kokoro")), false);
  });

  it("reports honest trend-source readiness without fabricating signals", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const unconfigured = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
      trendGateway: stoppedTrendGateway,
    });
    const configured = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {
        DOUYIN_CLIENT_TOKEN: "token-value",
        DOUYIN_HOTSEARCH_ENABLED: "1",
      },
      trendGateway: stoppedTrendGateway,
    });

    assert.deepEqual((await unconfigured.listTrendSources()).map((source) => [source.id, source.status]), [
      ["manual-research", "ready"],
      ["json-import", "ready"],
      ["trendradar-import", "needs_config"],
      ["newsnow-import", "needs_config"],
      ["dailyhot-import", "needs_config"],
      ["rsshub-import", "needs_config"],
      ["douyin-hotsearch", "needs_config"],
      ["newrank-import", "manual_only"],
      ["ocean-engine-import", "manual_only"],
    ]);
    const configuredDouyin = (await configured.listTrendSources()).find((source) => source.id === "douyin-hotsearch");
    assert.equal(configuredDouyin?.status, "needs_config");
    assert.match(configuredDouyin?.requirement ?? "", /适配器/);
  });

  it("caches model-backed trend candidates across repeated page reads", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    let calls = 0;
    const candidate = {
      id: "trend-1",
      title: "一个可追溯选题",
      platform: "douyin",
      track: "daily-life",
      audience: "普通创作者",
      painPoint: "信息很多但缺少判断",
      hook: "先看证据，再决定做不做。",
      rationale: "来自语义模型与真实热点。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-08-24T00:00:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "证据", strength: 90 }],
      score: {
        audienceReach: 80,
        visualFeasibility: 80,
        productionCostEfficiency: 80,
        novelty: 80,
        monetization: 80,
        seriesPotential: 80,
        complianceRisk: 10,
        final: 76,
      },
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
      trendAgent: { listCandidates: async () => { calls += 1; return [candidate]; } },
      now: () => new Date("2026-08-24T00:01:00.000Z"),
    });

    assert.deepEqual(await service.listTrendCandidates(), [candidate]);
    assert.deepEqual(await service.listTrendCandidates(), [candidate]);
    assert.equal(calls, 1);

    assert.deepEqual(await service.refreshTrendCandidates(), [candidate]);
    assert.equal(calls, 2);
  });

  it("scores, persists, loads, and updates real opportunity candidates", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
      opportunities: new JsonOpportunityStore(path.join(workspaceRoot, "opportunities.json")),
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      createId: () => "opportunity-1",
    });

    const created = await service.createOpportunity(opportunityInput);
    const listed = await service.listOpportunities();
    const loaded = await service.getOpportunity("opportunity-1");
    const approved = await service.updateOpportunityStatus("opportunity-1", "approved");

    assert.equal(created.id, "opportunity-1");
    assert.equal(created.title, opportunityInput.title);
    assert.equal(created.score.final > 0, true);
    assert.deepEqual(created.scoreProvenance, {
      source: "人工维度评分 · topic-intelligence-v1",
      scoredAt: "2026-08-22T10:00:00.000Z",
    });
    assert.equal(listed[0]?.id, "opportunity-1");
    assert.equal(loaded?.hook, opportunityInput.hook);
    assert.equal(approved.status, "approved");
  });
});
