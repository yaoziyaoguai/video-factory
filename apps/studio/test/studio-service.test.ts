import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { HumanDecisionDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
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
  lastAuthorization?: SpendAuthorizationDraft;
  dispatchCount = 0;
  lastInput?: unknown;

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
    assert.equal(detail?.nodes.at(-1)?.status, "pending");
    assert.equal(detail?.activeIntervention?.id, "intervention-1");
    assert.equal(detail?.videoArtifactId, "artifact-video");
    assert.equal(detail?.artifacts[0]?.contentUrl, "/api/runs/run-1/artifacts/artifact-video/content");
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

  it("blocks metered providers when paid generation is disabled or underfunded", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "seedance-model",
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
        SEEDANCE_MODEL_ID: "seedance-model",
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
        SEEDANCE_MODEL_ID: "seedance-model",
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
