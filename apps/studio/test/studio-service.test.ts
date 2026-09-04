import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { HumanDecisionDraft, NodeInputOverrideDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
import type {
  DispatchedProductionRun,
  ProductionBrief,
  ProductionPaidNodeReconciliationDraft,
  ProductionPaidNodeSummary,
  ProductionRunListener,
  ProductionSceneRevisionDraft,
  ProductionSpendRejectionDraft,
} from "@video-factory/production-pipeline";
import { PaidOperationManualReconciliationError, StaleRunRevisionError } from "@video-factory/production-pipeline";
import {
  StudioConflictError,
  StudioService,
  type StudioPipelinePort,
} from "../src/server/studio-service.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import { JsonRunArchiveStore } from "../src/server/run-archive-store.js";
import { loadAgentLoopProgress, ProductionStudio } from "../src/server/production-studio.js";
import type { StudioOpportunityInput, StudioSeries, StudioSeriesEpisode } from "../src/shared/api.js";

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
  lastSpendRejection?: ProductionSpendRejectionDraft;
  lastSceneRevision?: ProductionSceneRevisionDraft;
  lastRetriedNodeId?: string;
  lastReconciliation?: ProductionPaidNodeReconciliationDraft;
  reconciliationError?: Error;
  pauseRequestedValue = false;
  dispatchCount = 0;
  lastInput?: unknown;
  dispatchGate?: Promise<void>;
  retryCompletion?: Promise<WorkflowRun<ProductionBrief>>;
  removedRunId?: string;
  maintenanceLeaseCalls: string[][] = [];

  constructor(run: WorkflowRun<ProductionBrief>) {
    this.run = run;
  }

  async list(): Promise<WorkflowRun<ProductionBrief>[]> {
    return [this.run];
  }

  async remove(runId: string): Promise<void> {
    this.removedRunId = runId;
  }

  async withRunMaintenanceLease<T>(runIds: string[], action: () => Promise<T>): Promise<T> {
    this.maintenanceLeaseCalls.push([...runIds]);
    return action();
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

  async applyNodeExecutionConfiguration(
    _runId: string,
    _nodeId: string,
    brief: ProductionBrief,
    _actor: string,
  ): Promise<WorkflowRun<ProductionBrief>> {
    this.run = { ...this.run, initialInput: brief, revision: this.run.revision + 1, status: "stale" };
    return this.run;
  }

  async authorizeSpend(_runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastAuthorization = authorization;
    return this.run;
  }

  async rejectSpend(_runId: string, rejection: ProductionSpendRejectionDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastSpendRejection = rejection;
    return this.run;
  }

  async dispatchSceneRevision(
    _runId: string,
    revision: ProductionSceneRevisionDraft,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    this.lastSceneRevision = revision;
    this.listener = listener;
    return { runId: this.run.id, completion: Promise.resolve(this.run) };
  }

  async requestPause(_runId: string): Promise<void> {
    this.pauseRequestedValue = true;
  }

  async pauseRequested(_runId: string): Promise<boolean> {
    return this.pauseRequestedValue;
  }

  async resumePaused(_runId: string): Promise<WorkflowRun<ProductionBrief>> {
    this.pauseRequestedValue = false;
    this.run = { ...this.run, status: "running" };
    return this.run;
  }

  async resumeStale(_runId: string): Promise<WorkflowRun<ProductionBrief>> {
    return this.run;
  }

  async retryFailedNode(_runId: string, nodeId: string): Promise<WorkflowRun<ProductionBrief>> {
    this.lastRetriedNodeId = nodeId;
    return this.run;
  }

  async inspectPaidNode(_runId: string, nodeId: string): Promise<ProductionPaidNodeSummary> {
    return {
      nodeId,
      operationId: "paid-operation-1",
      recommendedOutcome: "resume_original",
      requiresManualReconciliation: false,
      items: [],
    };
  }

  async reconcilePaidNode(
    _runId: string,
    draft: ProductionPaidNodeReconciliationDraft,
  ): Promise<WorkflowRun<ProductionBrief>> {
    this.lastReconciliation = draft;
    if (this.reconciliationError) throw this.reconciliationError;
    return this.run;
  }

  async dispatchRetryFailedNode(
    _runId: string,
    nodeId: string,
    listener?: ProductionRunListener,
  ): Promise<DispatchedProductionRun> {
    this.lastRetriedNodeId = nodeId;
    this.run = {
      ...this.run,
      revision: this.run.revision + 1,
      status: "running",
      nodeRuns: this.run.nodeRuns.map((node) => {
        if (node.nodeId !== nodeId) return node;
        const { error: _error, finishedAt: _finishedAt, ...active } = node;
        return { ...active, status: "running" };
      }),
    };
    await listener?.(this.run);
    return { runId: this.run.id, completion: this.retryCompletion ?? Promise.resolve(this.run) };
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
  it("builds a rejected-run draft that inherits production choices and prefills affected nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-draft-"));
    const scriptPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "attempt-1", "script.json");
    const storyboardPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "visual-direction", "attempt-1", "storyboard.json");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(storyboardPath), { recursive: true });
    await writeFile(scriptPath, JSON.stringify({ viewerPromise: "原版承诺", scenes: [{ position: 1 }] }), "utf8");
    await writeFile(storyboardPath, JSON.stringify({ visualBible: { typography: "画面内不出现文字" } }), "utf8");
    const base = waitingRun(workspaceRoot);
    const rejectedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      revision: 12,
      initialInput: {
        ...brief,
        providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1", visualReview: "glm-visual-review-v1" },
        models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
        director: { profileId: "documentary-observer", assetProviderIds: ["pexels-stock-v1", "seedance-video-v1"] },
      },
      decisions: [{
        interventionId: "intervention-1",
        action: "reject",
        decidedBy: "owner",
        decidedAt: "2026-08-21T10:02:00.000Z",
        note: "第三镜画面文字干扰严重。",
      }],
      nodeRuns: [
        {
          nodeId: "script",
          status: "succeeded",
          startedAt: base.startedAt,
          finishedAt: base.startedAt,
          artifactIds: ["artifact-script"],
          qualityGateResults: [],
        },
        {
          nodeId: "visual-direction",
          status: "succeeded",
          startedAt: base.startedAt,
          finishedAt: base.startedAt,
          artifactIds: ["artifact-storyboard"],
          qualityGateResults: [],
        },
        {
          nodeId: "visual-review",
          status: "succeeded",
          startedAt: base.startedAt,
          finishedAt: base.startedAt,
          artifactIds: [],
          qualityGateResults: [],
          output: { report: { findings: [
            { timecodeMs: 4_000, scenePosition: 2, category: "pacing", description: "旁白信息过密，画面来不及承接。", suggestion: "精简第二镜旁白并留出动作停顿。" },
            { timecodeMs: 8_000, scenePosition: 3, category: "typography", description: "文字遮挡主体。", suggestion: "换用无字母片。" },
            { timecodeMs: 12_000, scenePosition: 4, category: "composition", description: "主体被裁切到画面边缘。", suggestion: "换成主体完整居中的镜头。" },
          ] } },
        },
      ],
      artifacts: [
        {
          id: "artifact-script",
          kind: "script",
          uri: scriptPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          sizeBytes: 64,
          sha256: "b".repeat(64),
          producer: { nodeId: "script", attempt: 1 },
          provenance: { providerId: "codex-screenwriter-v1" },
        },
        {
          id: "artifact-storyboard",
          kind: "storyboard",
          uri: storyboardPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          sizeBytes: 64,
          sha256: "c".repeat(64),
          producer: { nodeId: "visual-direction", attempt: 1 },
          provenance: { providerId: "api-visual-director-v1" },
        },
      ],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(rejectedRun), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");
    const sameDraft = await service.reworkDraft("run-1");

    assert.equal(draft?.input.rework?.sourceRunRevision, 12);
    assert.equal(draft?.input.director?.profileId, "documentary-observer");
    assert.equal(draft?.input.models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.deepEqual(
      draft?.input.rework?.findings.map(({ findingId }) => findingId),
      sameDraft?.input.rework?.findings.map(({ findingId }) => findingId),
    );
    assert.equal(new Set(draft?.input.rework?.findings.map(({ findingId }) => findingId)).size, 3);
    assert.ok(draft?.input.rework?.findings.every(({ findingId }) => /^vf_[a-f0-9]{24}$/.test(findingId)));
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /旁白信息过密，画面来不及承接/);
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /精简第二镜旁白并留出动作停顿/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.script ?? "", /主体被裁切到画面边缘|换成主体完整居中的镜头/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /文字遮挡主体/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /主体被裁切到画面边缘/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /换成主体完整居中的镜头/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /不得用说明卡/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /旁白信息过密，画面来不及承接/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /精简第二镜旁白并留出动作停顿/);
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /本次重做原因/);
    assert.deepEqual(draft?.input.rework?.previousScript, { viewerPromise: "原版承诺", scenes: [{ position: 1 }] });
    assert.deepEqual(draft?.inheritedNodeIds, ["brief", "script", "visual-direction", "visual-review"]);

    const tampered = structuredClone(draft!.input);
    tampered.providers.script = "codex-screenwriter-v1";
    tampered.rework!.findings[0]!.description = "用户尝试改写审片事实";
    await assert.rejects(() => service.startRun(tampered), /审片问题已经变化或被修改/);
  });

  it("reuses the rejected run's immutable template snapshot when the rework keeps that version", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-template-snapshot-"));
    const historicalSnapshot: NonNullable<ProductionBrief["templateSnapshot"]> = {
      templateId: "knowledge-explainer",
      templateVersion: 1,
      resolvedAt: "2026-08-21T09:59:00.000Z",
      resolvedBlueprint: {
        platform: "douyin",
        durationSeconds: 24,
        automationLevel: "assisted",
        storyStructure: [{ id: "historical-hook", label: "旧版开场", purpose: "保留当时的叙事承诺", required: true }],
        shotSlots: [{ id: "historical-shot", beatId: "historical-hook", purpose: "旧版镜头", durationSeconds: 24, allowedCapabilities: ["asset.search"], manualReplacement: true }],
        visualSystem: { composition: "旧版构图规则", colorIntent: "旧版暖色", subtitleDensity: "medium", pacing: "measured" },
        soundSystem: { voiceIntent: "旧版声音", pace: "medium", musicIntent: "克制" },
        qualityRules: [{ id: "historical-quality", label: "旧版质量线", dimension: "artistic", required: true, threshold: 80 }],
        capabilityRequirements: [{ capability: "script.draft", required: true }],
      },
      sourceLayers: [{ layer: "template", sourceId: "knowledge-explainer@1", appliedFields: ["storyStructure", "visualSystem"] }],
      fieldSources: { storyStructure: "template", visualSystem: "template" },
    };
    const sourceBrief: ProductionBrief = {
      ...brief,
      providers: { ...brief.providers, script: "codex-screenwriter-v1" },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      templateSnapshot: historicalSnapshot,
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      revision: 7,
      status: "rejected",
      initialInput: sourceBrief,
    });
    let currentTemplateResolveCalls = 0;
    const production = new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive", "runs.json")),
      listProviders: async () => [
        { id: "codex-screenwriter-v1", capability: "script.draft", label: "Codex 编剧", available: true, kind: "external" },
        { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑画面", available: true, kind: "local" },
        { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
        { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" },
        { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" },
      ],
      resolveTemplateSnapshot: async () => {
        currentTemplateResolveCalls += 1;
        return { ...historicalSnapshot, templateVersion: 2, resolvedAt: "2026-09-04T00:00:00.000Z" };
      },
    });

    await production.start({
      ...sourceBrief,
      template: { templateId: "knowledge-explainer", templateVersion: 1 },
      rework: {
        sourceRunId: "run-1",
        sourceRunRevision: 7,
        nodeInstructions: {
          script: "按审片意见精简第三镜旁白。",
          visualDirection: "保留旧版视觉规则，只修第三镜。",
          assets: "第三镜使用无字画面，禁止说明卡。",
        },
        findings: [],
      },
    });

    assert.equal(currentTemplateResolveCalls, 0);
    assert.deepEqual((pipeline.lastInput as ProductionBrief).templateSnapshot, historicalSnapshot);
  });

  it("prefills actionable generation changes after a content-safety failure", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-content-safety-"));
    const base = waitingRun(workspaceRoot);
    const failedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "failed",
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        startedAt: base.startedAt,
        finishedAt: base.finishedAt,
        artifactIds: [],
        qualityGateResults: [],
        error: "The input text may contain sensitive information.",
      }],
      artifacts: [],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(failedRun), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");

    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /visual_prompt 与 search_terms/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /中性、具体的物体描述/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /再次被拒绝时立即停住/);
  });

  it("reads a safe live agent-loop summary from the latest node checkpoint", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-agent-progress-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "progress.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v3",
      maxIterations: 3,
      status: "running",
      completed: [{
        iteration: 1,
        audit: { verdict: "repair", score: 68, summary: "开场钩子仍需具体。" },
      }],
      pendingCandidate: { iteration: 2, candidate: { secretPrompt: "不应出现在进度接口" } },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-1", "script"), {
      iteration: 2,
      maxIterations: 3,
      completedIterations: 1,
      phase: "auditing",
      latestAudit: { verdict: "repair", score: 68, summary: "开场钩子仍需具体。" },
    });
  });

  it("reads v4 progress without exposing persistent role-session handles", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-agent-progress-v4-"));
    const directory = path.join(workspaceRoot, "runs", "run-v4", "nodes", "script", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "progress.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v4",
      maxIterations: 3,
      status: "running",
      completed: [],
      pendingCandidate: { iteration: 1, candidate: { secretPrompt: "不应出现在进度接口" } },
      sessions: { produce: { key: "private-session-key", handle: `vfs_${"p".repeat(32)}` } },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-v4", "script"), {
      iteration: 1,
      maxIterations: 3,
      completedIterations: 0,
      phase: "auditing",
    });
  });

  it("reads v6 progress while a repaired candidate is being regenerated", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-agent-progress-v6-"));
    const directory = path.join(workspaceRoot, "runs", "run-v6", "nodes", "visual-direction", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "progress.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v6",
      maxIterations: 3,
      status: "running",
      completed: [{
        iteration: 1,
        audit: { verdict: "repair", score: 62, summary: "镜头状态变化需要补齐。" },
      }],
      validationFailure: {
        iteration: 2,
        invalidCandidateHash: "private-hash",
        validationError: "private validation detail",
      },
      sessions: { produce: { key: "private-session-key", handle: `vfs_${"p".repeat(32)}` } },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-v6", "visual-direction"), {
      iteration: 2,
      maxIterations: 3,
      completedIterations: 1,
      phase: "repairing",
      latestAudit: { verdict: "repair", score: 62, summary: "镜头状态变化需要补齐。" },
    });
  });

  it("archives only terminal runs and can restore them without touching production files", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      now: () => new Date("2026-08-30T08:00:00.000Z"),
    });

    await assert.rejects(() => service.archiveRuns(["run-1"]), /仍在运行或等待确认/);
    pipeline.run = { ...pipeline.run, status: "succeeded" };
    await service.archiveRuns(["run-1"]);
    assert.equal((await service.listRuns())[0]?.archivedAt, "2026-08-30T08:00:00.000Z");
    assert.equal(pipeline.removedRunId, undefined);

    await service.restoreRuns(["run-1"]);
    assert.equal((await service.listRuns())[0]?.archivedAt, undefined);
    assert.equal((await service.getRun("run-1"))?.archivedAt, undefined);
  });

  it("serializes archive updates across independent service instances", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-run-archive-lock-"));
    const archivePath = path.join(workspaceRoot, "archive", "runs.json");
    const first = new JsonRunArchiveStore(archivePath);
    const second = new JsonRunArchiveStore(archivePath);

    await Promise.all([
      first.archive(["run-a"], "2026-08-30T08:00:00.000Z"),
      second.archive(["run-b"], "2026-08-30T08:01:00.000Z"),
    ]);

    assert.deepEqual(await new JsonRunArchiveStore(archivePath).list(), {
      "run-a": "2026-08-30T08:00:00.000Z",
      "run-b": "2026-08-30T08:01:00.000Z",
    });
  });

  it("deletes only archived terminal production records", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(() => service.deleteRun("run-1"), /仍在运行或等待确认/);
    assert.equal(pipeline.removedRunId, undefined);

    pipeline.run = { ...pipeline.run, status: "succeeded" };
    await assert.rejects(() => service.deleteRun("run-1"), /请先归档/);
    await service.archiveRuns(["run-1"]);
    await service.deleteRun("run-1");
    assert.equal(pipeline.removedRunId, "run-1");
    assert.deepEqual(pipeline.maintenanceLeaseCalls, [["run-1"], ["run-1"], ["run-1"], ["run-1"]]);
  });

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

    pipeline.run = {
      ...pipeline.run,
      status: "running",
      nodeRuns: [...pipeline.run.nodeRuns, {
        nodeId: "publish-package",
        status: "running",
        startedAt: "2026-08-21T10:02:00.000Z",
        artifactIds: [],
        qualityGateResults: [],
      }],
    };
    assert.equal((await service.listRuns())[0]?.currentNodeId, "publish-package");
    assert.equal(detail?.artifacts[0]?.contentUrl, "/api/runs/run-1/artifacts/artifact-video/content");
  });

  it("describes a template script honestly instead of claiming an Agent audit loop", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.status = "running";
    delete run.finishedAt;
    run.nodeRuns = [{
      nodeId: "script",
      role: "编剧",
      status: "running",
      startedAt: "2026-08-21T10:00:10.000Z",
      artifactIds: [],
      qualityGateResults: [],
    }];
    run.executionPlan = [{
      nodeId: "script",
      role: "编剧",
      capability: "script.draft",
      providerId: "python-template-v1",
      providerLabel: "模板编剧",
      modelId: "python-template-v1",
      transport: "local_process",
      billing: "free",
      configurationSource: "template_default",
      parameters: {},
      estimatedCostCny: 0,
    }];
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
      now: () => new Date("2026-08-21T10:00:20.000Z"),
    });

    const detail = await service.getRun("run-1");

    assert.equal(detail?.nodes.find((node) => node.id === "script")?.actionLabel, "编剧正在生成结构化脚本");
    assert.equal(detail?.currentAction?.label, "编剧正在生成结构化脚本");
  });

  it("shows creator-facing agent-loop progress without internal Agent terminology", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-live-agent-label-"));
    const checkpointDirectory = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "agent-loop-checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, "progress.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v4",
      maxIterations: 3,
      status: "running",
      completed: [{ iteration: 1, audit: { verdict: "repair", score: 70, summary: "开场需要更具体。" } }],
      pendingCandidate: { iteration: 2, candidate: { title: "第二轮脚本" } },
    }), "utf8");
    const run = waitingRun(workspaceRoot);
    run.status = "running";
    delete run.finishedAt;
    run.nodeRuns = [{
      nodeId: "script",
      role: "编剧",
      status: "running",
      startedAt: "2026-08-21T10:00:10.000Z",
      artifactIds: [],
      qualityGateResults: [],
    }];
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
      now: () => new Date("2026-08-21T10:00:20.000Z"),
    });

    const detail = await service.getRun("run-1");

    assert.equal(detail?.currentAction?.label, "编剧第 2/3 轮：独立审计正在检查");
    assert.equal(detail?.currentAction?.label.includes("Agent"), false);
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

  it("does not expose a stale render or publish package as the current result", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = waitingRun(workspaceRoot);
    run.status = "stale";
    run.nodeRuns[0]!.status = "stale";
    run.nodeRuns[0]!.outputState = {
      generatedVersionId: "render-v1",
      effectiveVersionId: "render-v1",
      stale: true,
      versions: [{
        id: "render-v1",
        nodeId: "render",
        source: "generated",
        artifactIds: ["artifact-video"],
        inputVersionIds: [],
        createdAt: "2026-08-21T10:00:50.000Z",
        createdBy: "python-ffmpeg-v1",
        schemaVersion: "1",
      }],
    };
    run.nodeRuns.push({
      nodeId: "publish-package",
      status: "stale",
      startedAt: "2026-08-21T10:01:10.000Z",
      artifactIds: ["artifact-package-old"],
      qualityGateResults: [],
      outputState: {
        generatedVersionId: "package-v1",
        effectiveVersionId: "package-v1",
        stale: true,
        versions: [{
          id: "package-v1",
          nodeId: "publish-package",
          source: "generated",
          artifactIds: ["artifact-package-old"],
          inputVersionIds: [],
          createdAt: "2026-08-21T10:01:10.000Z",
          createdBy: "codex-publish-copy-v1",
          schemaVersion: "1",
        }],
      },
    });
    run.artifacts.push({
      id: "artifact-package-old",
      kind: "publish_package",
      uri: path.join(workspaceRoot, "runs", "run-1", "publish", "publish_package.json"),
      createdAt: "2026-08-21T10:01:10.000Z",
      contentType: "application/json",
      producer: { nodeId: "publish-package", attempt: 1 },
      provenance: { providerId: "codex-publish-copy-v1" },
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const [summary] = await service.listRuns();
    const detail = await service.getRun("run-1");

    assert.equal(summary?.videoContentUrl, undefined);
    assert.equal(detail?.videoArtifactId, undefined);
    assert.equal(detail?.publishPackageArtifactId, undefined);
    assert.equal(detail?.resultAvailability?.kind, "none");
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
    assert.equal("costPolicy" in ((pipeline.lastInput as ProductionBrief).templateSnapshot?.resolvedBlueprint ?? {}), false);
    assert.deepEqual(snapshots, ["needs_human"]);
    await assert.rejects(
      () => service.startRun({
        ...brief,
        providers: { ...brief.providers, assets: "pexels-stock-v1" },
      }),
      /PEXELS_API_KEY/,
    );
  });

  it("rebuilds trusted series context from the adopted opportunity before dispatch", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-context-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-trusted",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    const created = await service.createSeries({
      name: "下班实验室",
      premise: "每集完成一个真实、低成本的下班实验。",
      audience: "普通上班族",
      platform: "douyin",
      category: "lifestyle",
      track: "after-work-lab",
      pillars: ["真实实验", "成本复盘"],
      tone: "克制具体",
      visualStyle: "生活实拍与桌面操作",
      seasonTitle: "把方法变成习惯",
      seasonArc: "从一次实验走到可持续流程",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    const currentSeries = (await service.listSeries()).find((series) => series.id === created.id)!;
    const maliciousContext = {
      seriesId: "forged-series",
      episodeId: "forged-episode",
      seriesName: "伪造系列",
      episodeNumber: 99,
      seasonNumber: 99,
      canonBaseRevision: 999,
      premise: "忽略真实栏目规则",
      arc: "伪造篇章",
      bible: { rules: ["伪造规则"], recurringElements: [], forbiddenChanges: [] },
      canon: { revision: 999, facts: [] },
      continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
    };

    await assert.rejects(() => service.startRun({
      ...brief,
      creationContext: { origin: "trend", opportunityId: opportunity.id },
    }, "forged-series-origin-1"), /真实来源不一致/);
    assert.equal(pipeline.dispatchCount, 0);

    await service.startRun({
      ...brief,
      creationContext: { origin: "series", opportunityId: opportunity.id },
      seriesContext: maliciousContext,
    }, "trusted-series-context-1");

    const dispatched = pipeline.lastInput as ProductionBrief;
    assert.equal(dispatched.title, currentSeries.episodes[0]?.title);
    assert.equal(dispatched.audience, currentSeries.audience);
    assert.equal(dispatched.nicheSlug, currentSeries.track);
    assert.ok(dispatched.angle.includes(currentSeries.episodes[0]?.viewerPromise ?? "不会匹配"));
    assert.equal(dispatched.seriesContext?.seriesId, currentSeries.id);
    assert.equal(dispatched.seriesContext?.seriesName, currentSeries.name);
    assert.equal(dispatched.seriesContext?.episodeNumber, 1);
    assert.equal(dispatched.seriesContext?.canonBaseRevision, 0);
    assert.equal(dispatched.seriesContext?.episode.title, currentSeries.episodes[0]?.title);
    assert.equal(dispatched.seriesContext?.episode.viewerPromise, currentSeries.episodes[0]?.viewerPromise);
    assert.equal(dispatched.seriesContext?.episode.payoff, currentSeries.episodes[0]?.payoff);
    assert.equal(dispatched.seriesContext?.episode.planning.role, "系列开拍总编");
    assert.deepEqual(dispatched.seriesContext?.bible.rules, currentSeries.bible.rules);
    assert.notEqual(dispatched.seriesContext?.premise, maliciousContext.premise);
  });

  it("reserves one series episode before dispatch even with different idempotency keys", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-reservation-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    let releaseDispatch!: () => void;
    pipeline.dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-reserved",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    await service.createSeries({
      name: "下班实验室",
      premise: "每集完成一个真实、低成本的下班实验。",
      audience: "普通上班族",
      platform: "douyin",
      category: "lifestyle",
      track: "after-work-lab",
      pillars: ["真实实验", "成本复盘"],
      tone: "克制具体",
      visualStyle: "生活实拍与桌面操作",
      seasonTitle: "把方法变成习惯",
      seasonArc: "从一次实验走到可持续流程",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    const input = { ...brief, creationContext: { origin: "series" as const, opportunityId: opportunity.id } };

    const first = service.startRun(input, "series-reservation-a");
    while (pipeline.dispatchCount === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(
      () => service.startRun(input, "series-reservation-b"),
      /其他制作占用|已经进入制作/,
    );
    assert.equal(pipeline.dispatchCount, 1);
    releaseDispatch();
    assert.deepEqual(await first, { runId: "run-1", status: "running" });
    assert.match((pipeline.lastInput as ProductionBrief).seriesContext?.productionReservationId ?? "", /^series-run-/);
  });

  it("replays a completed series start before running greenlight planning again", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-replay-before-greenlight-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    let reviews = 0;
    const firstAgent = passingGreenlightAgent();
    const firstService = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-replay",
      seriesPlanningAgent: {
        ...firstAgent,
        reviewEpisode: async (...args: Parameters<typeof firstAgent.reviewEpisode>) => {
          reviews += 1;
          return firstAgent.reviewEpisode(...args);
        },
      },
    });
    await firstService.createSeries({
      name: "下班实验室", premise: "每集完成一个真实实验。", audience: "普通上班族", platform: "douyin",
      category: "lifestyle", track: "after-work-lab", pillars: ["真实实验"], tone: "克制具体",
      visualStyle: "生活实拍", seasonTitle: "第一季", seasonArc: "建立稳定流程",
    });
    const candidate = (await firstService.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await firstService.adoptCandidate(candidate.id, { origin: "series" });
    const input = { ...brief, creationContext: { origin: "series" as const, opportunityId: opportunity.id } };
    const first = await firstService.startRun(input, "series-replay-key");

    const restarted = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      seriesPlanningAgent: {
        generate: async () => { throw new Error("replay must not plan"); },
        reviewEpisode: async () => { throw new Error("replay must not greenlight"); },
      },
    });
    assert.deepEqual(await restarted.startRun(input, "series-replay-key"), first);
    assert.equal(reviews, 1);
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("recovers one legacy series run by its unique adopted opportunity", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-legacy-run-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-legacy-run",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    await service.createSeries({
      name: "长期实验", premise: "每集沉淀一个长期结论。", audience: "普通上班族", platform: "douyin",
      category: "lifestyle", track: "long-running-lab", pillars: ["长期验证"], tone: "克制",
      visualStyle: "纪实", seasonTitle: "第一季", seasonArc: "逐步建立结论",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    pipeline.run = {
      ...pipeline.run,
      status: "running",
      initialInput: {
        ...brief,
        creationContext: { opportunityId: opportunity.id } as ProductionBrief["creationContext"],
      },
    };

    const series = (await service.listSeries())[0]!;
    assert.equal(series.episodes[0]?.runId, "run-1");
    assert.equal(series.episodes[0]?.status, "in_production");
  });

  it("keeps a creator-linked legacy success across repeated service reconciliation", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-manual-legacy-link-"));
    const seriesRoot = path.join(workspaceRoot, "series");
    await mkdir(seriesRoot, { recursive: true });
    await writeFile(path.join(seriesRoot, "series.json"), `${JSON.stringify({
      version: 1,
      series: [{
        id: "series-manual-legacy",
        name: "长期档案",
        premise: "逐集沉淀长期结论。",
        audience: "普通上班族",
        platform: "douyin",
        category: "lifestyle",
        track: "long-running-archive",
        pillars: ["长期验证"],
        tone: "克制",
        visualStyle: "纪实",
        status: "active",
        nextEpisodeNumber: 2,
        createdAt: "2026-08-24T08:00:00.000Z",
        updatedAt: "2026-08-24T08:00:00.000Z",
      }],
    })}\n`, "utf8");
    const completed = waitingRun(workspaceRoot);
    completed.status = "succeeded";
    const pipeline = new FakePipeline(completed);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const migrated = (await service.listSeries())[0]!;
    assert.equal(migrated.episodes[0]?.status, "paused");
    await service.linkLegacySeriesRun(migrated.id, 1, completed.id);
    const firstRead = (await service.listSeries())[0]!;
    const secondRead = (await service.listSeries())[0]!;

    assert.equal(firstRead.episodes[0]?.status, "ready");
    assert.equal(secondRead.episodes[0]?.runId, completed.id);
    assert.deepEqual(secondRead.canon.facts, []);
  });

  it("builds series canon from the effective immutable script artifact and invalidates stale output", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-effective-canon-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-canon",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    await service.createSeries({
      name: "下班实验室",
      premise: "每集完成一个真实、低成本的下班实验。",
      audience: "普通上班族",
      platform: "douyin",
      category: "lifestyle",
      track: "after-work-lab",
      pillars: ["真实实验", "成本复盘"],
      tone: "克制具体",
      visualStyle: "生活实拍与桌面操作",
      seasonTitle: "把方法变成习惯",
      seasonArc: "从一次实验走到可持续流程",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    await service.startRun({
      ...brief,
      creationContext: { origin: "series", opportunityId: opportunity.id },
    }, "series-canon-run");

    const scriptPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "attempt-1", "script.json");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, `${JSON.stringify({
      viewerPromise: "完成一次真实实验",
      narrativeArc: "从尝试推进到可复用方法",
      canonFacts: ["已经完成一次低成本实验。", "记录步骤后可以复现实验结果。"],
      scenes: [{ narration: "下一集继续验证长期效果。" }],
    })}\n`, "utf8");
    pipeline.run = {
      ...pipeline.run,
      revision: 7,
      status: "succeeded",
      initialInput: pipeline.lastInput as ProductionBrief,
      nodeRuns: [{
        nodeId: "brief",
        status: "succeeded",
        artifactIds: [],
        qualityGateResults: [],
      }, {
        nodeId: "script",
        status: "succeeded",
        artifactIds: ["artifact-script"],
        qualityGateResults: [],
        output: { scriptPath, canonFacts: ["已经完成一次低成本实验。", "记录步骤后可以复现实验结果。"] },
        outputState: {
          nodeId: "script",
          generatedVersionId: "script-v1",
          effectiveVersionId: "script-v1",
          stale: false,
          versions: [{
            id: "script-v1",
            nodeId: "script",
            source: "generated",
            artifactIds: ["artifact-script"],
            inputVersionIds: [],
            output: { scriptPath, canonFacts: ["已经完成一次低成本实验。", "记录步骤后可以复现实验结果。"] },
            createdAt: "2026-08-30T09:00:00.000Z",
            createdBy: "codex-screenwriter-v1",
            schemaVersion: "video-factory/script-draft-v1",
          }],
        },
      }, {
        nodeId: "assets",
        status: "succeeded",
        artifactIds: [],
        qualityGateResults: [],
      }, {
        nodeId: "voice",
        status: "succeeded",
        artifactIds: [],
        qualityGateResults: [],
      }, pipeline.run.nodeRuns.find((node) => node.nodeId === "render")!, {
        nodeId: "technical-review",
        status: "succeeded",
        artifactIds: [],
        qualityGateResults: [],
      }, ...pipeline.run.nodeRuns.filter((node) => node.nodeId === "final-review").map((node) => node.nodeId === "final-review"
        ? {
            ...node,
            status: "succeeded" as const,
            intervention: undefined,
            output: {
              review: {},
              canonFacts: ["未经脚本确认的事实。"],
            },
            outputState: {
              nodeId: "final-review",
              generatedVersionId: "final-review-v1",
              effectiveVersionId: "final-review-v1",
              stale: false,
              versions: [{
                id: "final-review-v1",
                nodeId: "final-review",
                source: "generated" as const,
                artifactIds: [],
                inputVersionIds: ["script-v1"],
                output: {
                  review: {},
                  canonFacts: ["未经脚本确认的事实。"],
                },
                createdAt: "2026-08-30T09:00:00.000Z",
                createdBy: "final-review",
                schemaVersion: "1",
              }],
            },
          }
        : node)],
      artifacts: [{
        id: "artifact-script",
        kind: "script",
        uri: scriptPath,
        createdAt: "2026-08-30T09:00:00.000Z",
        contentType: "application/json",
        producer: { nodeId: "script", attempt: 1 },
        provenance: { providerId: "codex-screenwriter-v1" },
      }, ...pipeline.run.artifacts],
    };

    const blocked = (await service.listSeries())[0]!;
    assert.equal(blocked.episodes[0]?.status, "in_production");
    assert.equal(blocked.canon.facts.length, 0);
    const finalReview = pipeline.run.nodeRuns.find((node) => node.nodeId === "final-review")!;
    const approvedCanonFacts = ["已经完成一次低成本实验。", "记录步骤后可以复现实验结果。"];
    finalReview.output = { review: {}, canonFacts: approvedCanonFacts };
    finalReview.outputState!.versions[0]!.output = { review: {}, canonFacts: approvedCanonFacts };
    await service.archiveRuns(["run-1"]);
    await assert.rejects(
      () => service.deleteRun("run-1"),
      /已确认内容的来源/,
    );

    const ready = (await service.listSeries())[0]!;
    assert.equal(ready.episodes[0]?.status, "ready");
    assert.deepEqual(ready.canon.facts.map((fact) => fact.statement), [
      "已经完成一次低成本实验。",
      "记录步骤后可以复现实验结果。",
    ]);
    assert.equal(ready.canon.facts.some((fact) => fact.statement.includes("下一集")), false);
    assert.deepEqual(ready.canon.facts[0]?.sourceOutputVersionIds, ["script-v1", "final-review-v1"]);

    pipeline.run.nodeRuns.find((node) => node.nodeId === "script")!.outputState!.stale = true;
    const invalidated = (await service.listSeries())[0]!;
    assert.equal(invalidated.episodes[0]?.status, "in_production");
    assert.equal(invalidated.canon.facts.length, 0);
  });

  it("rejects series context on a non-series production", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-non-series-context-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(() => service.startRun({
      ...brief,
      creationContext: { origin: "manual", opportunityId: "opportunity-manual" },
      seriesContext: { forged: true },
    }), /只有系列制作可以携带系列上下文/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("rejects public attempts to forge trend or series opportunities", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-forged-opportunity-"));
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    assert.throws(
      () => service.createOpportunity({ ...opportunityInput, origin: "series", seriesId: "fake-series", episodeNumber: 1 }),
      /不能由通用表单伪造来源/,
    );
    assert.throws(
      () => service.createOpportunity({ ...opportunityInput, origin: "trend" }),
      /不能由通用表单伪造来源/,
    );
  });

  it("enforces manual review while ignoring the retired service-wide cost ceiling", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { VIDEO_FACTORY_MAX_RUN_COST_CNY: "8" },
    });

    await assert.rejects(() => service.startRun({ ...brief, reviewMode: "automatic" }), /人工终审/);
    const result = await service.startRun({
      ...brief,
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 9 },
    });
    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
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

  it("retains a series reservation when dispatch succeeds but the completion record cannot be written", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-dispatched-idempotency-failure-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    let releaseDispatch!: () => void;
    pipeline.dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-write-failure",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    await service.createSeries({
      name: "下班实验室", premise: "每集完成一个真实实验。", audience: "普通上班族", platform: "douyin",
      category: "lifestyle", track: "after-work-lab", pillars: ["真实实验"], tone: "克制具体",
      visualStyle: "生活实拍", seasonTitle: "第一季", seasonArc: "建立稳定流程",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    const input = { ...brief, creationContext: { origin: "series" as const, opportunityId: opportunity.id } };
    const start = service.startRun(input, "series-write-failure-key");
    while (pipeline.dispatchCount === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const idempotencyDirectory = path.join(workspaceRoot, "idempotency", "production-start");
    await chmod(idempotencyDirectory, 0o500);
    releaseDispatch();
    try {
      await assert.rejects(() => start, /已经启动.*不能重复启动/);
    } finally {
      await chmod(idempotencyDirectory, 0o700);
    }
    pipeline.run = { ...pipeline.run, initialInput: pipeline.lastInput as ProductionBrief };

    await assert.rejects(() => service.startRun(input, "series-write-failure-new-key"), /已经进入制作|其他制作占用/);
    assert.equal(pipeline.dispatchCount, 1);
    assert.equal((await service.listSeries())[0]?.episodes[0]?.runId, "run-1");
  });

  it("blocks a second paid-provider call while the failed outcome is uncertain", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-uncertain-paid-retry-"));
    const run = waitingRun(workspaceRoot);
    run.status = "failed";
    run.nodeRuns[0] = {
      ...run.nodeRuns[0]!,
      status: "failed",
      outcomeUncertain: true,
      error: "provider response was lost",
    };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.retryFailedNode("run-1", "render"),
      /服务商控制台核对任务和账单/,
    );
    assert.equal(pipeline.lastRetriedNodeId, undefined);
  });

  it("forwards the paid reconciliation id, revision, and outcome without changing them", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-reconciliation-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.reconcilePaidNode("run-1", "assets", {
      expectedRunRevision: 7,
      reconciliationId: "reconcile-assets-7",
      outcome: "requote",
    });

    assert.deepEqual(pipeline.lastReconciliation, {
      nodeId: "assets",
      expectedRunRevision: 7,
      reconciliationId: "reconcile-assets-7",
      outcome: "requote",
    });
  });

  it("adds the trusted actor to a manual paid reconciliation", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-manual-paid-resolution-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.reconcilePaidNode("run-1", "assets", {
      expectedRunRevision: 7,
      reconciliationId: "confirm-charge-assets-7",
      outcome: "confirmed_charged",
      note: "Provider 控制台确认已扣费。",
      actualCostCny: 2.4,
    }, "billing-reviewer");

    assert.deepEqual(pipeline.lastReconciliation, {
      nodeId: "assets",
      expectedRunRevision: 7,
      reconciliationId: "confirm-charge-assets-7",
      outcome: "confirmed_charged",
      actor: "billing-reviewer",
      note: "Provider 控制台确认已扣费。",
      actualCostCny: 2.4,
    });
  });

  it("turns an unqueryable paid task into an explicit manual-reconciliation conflict", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-manual-reconciliation-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    pipeline.reconciliationError = new PaidOperationManualReconciliationError("assets", []);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.reconcilePaidNode("run-1", "assets", {
        expectedRunRevision: 7,
        reconciliationId: "reconcile-assets-manual",
        outcome: "resume_original",
      }),
      (error: unknown) => error instanceof StudioConflictError && /人工核对任务和账单/.test(error.message),
    );
  });

  it("returns a running snapshot after retry dispatch without waiting for the long model task", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-background-retry-"));
    const run = waitingRun(workspaceRoot);
    const failedNodeId = run.nodeRuns[0]!.nodeId;
    run.status = "failed";
    run.nodeRuns[0] = { ...run.nodeRuns[0]!, status: "failed", error: "temporary model failure" };
    const pipeline = new FakePipeline(run);
    let completeRetry!: (run: WorkflowRun<ProductionBrief>) => void;
    pipeline.retryCompletion = new Promise((resolve) => { completeRetry = resolve; });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const response = await service.retryFailedNode(run.id, failedNodeId);

    assert.equal(response.status, "running");
    assert.equal(response.nodes.find((node) => node.id === failedNodeId)?.status, "running");
    assert.equal(pipeline.lastRetriedNodeId, failedNodeId);
    completeRetry(pipeline.run);
  });

  it("reconciles an ordinary failed series attempt before starting its replacement", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-restart-reconcile-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      createSeriesId: () => "series-restart",
      seriesPlanningAgent: passingGreenlightAgent(),
    });
    await service.createSeries({
      name: "长期实验", premise: "每集完成一个真实实验。", audience: "普通上班族", platform: "douyin",
      category: "lifestyle", track: "long-lab-restart", pillars: ["真实实验"], tone: "克制",
      visualStyle: "纪实", seasonTitle: "第一季", seasonArc: "逐步建立结论",
    });
    const candidate = (await service.listCandidateInbox({ origins: ["series"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "series" });
    const input = { ...brief, creationContext: { origin: "series" as const, opportunityId: opportunity.id } };
    await service.startRun(input, "series-restart-first");
    pipeline.run = {
      ...pipeline.run,
      revision: 1,
      status: "failed",
      initialInput: pipeline.lastInput as ProductionBrief,
      nodeRuns: pipeline.run.nodeRuns.map((node, index) => index === 0
        ? { ...node, status: "failed" as const, error: "明确失败" }
        : node),
    };

    await service.startRun(input, "series-restart-second");

    assert.equal(pipeline.dispatchCount, 2);
    const reconciled = (await service.listSeries())[0]?.episodes[0];
    assert.equal(reconciled?.runId, undefined);
    assert.ok(reconciled?.attemptRunIds?.includes("run-1"));
  });

  it("keeps legacy records visible in the manual entry without leaking them into trend or series", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-legacy-origin-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    await service.createOpportunity(opportunityInput);

    assert.equal((await service.listOpportunities("manual")).length, 1);
    assert.equal((await service.listOpportunities("trend")).length, 0);
    assert.equal((await service.listOpportunities("series")).length, 0);
    assert.equal((await service.listRuns("manual")).length, 1);
    assert.equal((await service.listRuns("trend")).length, 0);
    assert.equal((await service.listRuns("series")).length, 0);
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

  it("persists voice customization provenance and migrates legacy non-default voices", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-voice-provenance-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    assert.equal((await service.getCreatorSettings()).voiceDirectionCustomized, false);
    await service.updateCreatorSettings({
      voiceDirection: { profileId: "macos:Tingting", rate: 190, pauseScale: 1, masteringPreset: "social" },
    });
    const restarted = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    assert.equal((await restarted.getCreatorSettings()).voiceDirectionCustomized, true);

    const legacyRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-legacy-voice-"));
    const settingsDirectory = path.join(legacyRoot, "settings");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(path.join(settingsDirectory, "creator-settings.json"), JSON.stringify({
      version: 1,
      settings: {
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 0.9, masteringPreset: "social" },
        defaultRecipeId: "economy-daily",
        roleProviderDefaults: {},
        modelDefaults: {},
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
        topicStrategy: { customInstruction: "" },
      },
    }), "utf8");
    const migrated = new StudioService({
      workspaceRoot: legacyRoot,
      pipeline: new FakePipeline(waitingRun(legacyRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    assert.equal((await migrated.getCreatorSettings()).voiceDirectionCustomized, true);

    const legacyDefaultRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-legacy-default-voice-"));
    const defaultSettingsDirectory = path.join(legacyDefaultRoot, "settings");
    await mkdir(defaultSettingsDirectory, { recursive: true });
    await writeFile(path.join(defaultSettingsDirectory, "creator-settings.json"), JSON.stringify({
      version: 1,
      settings: {
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "economy-daily",
        roleProviderDefaults: {},
        modelDefaults: {},
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
        topicStrategy: { customInstruction: "" },
      },
    }), "utf8");
    const migratedDefault = new StudioService({
      workspaceRoot: legacyDefaultRoot,
      pipeline: new FakePipeline(waitingRun(legacyDefaultRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    assert.equal((await migratedDefault.getCreatorSettings()).voiceDirectionCustomized, false);
  });

  it("inherits a missing production role and its model from creator defaults", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-role-default-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: {
        available: true,
        reason: "",
        modelId: "gpt-5.6-sol",
        taskKinds: ["script-draft", "role-audit"],
      },
    });
    await service.updateCreatorSettings({
      roleProviderDefaults: { script: "codex-screenwriter-v1" },
      modelDefaults: { "codex-screenwriter-v1": "gpt-5.6-sol" },
    });
    const providers = { ...brief.providers } as Record<string, string>;
    delete providers.script;

    await service.startRun({ ...brief, providers });

    const dispatched = pipeline.lastInput as ProductionBrief;
    assert.equal(dispatched.providers.script, "codex-screenwriter-v1");
    assert.equal(dispatched.models?.["codex-screenwriter-v1"], "gpt-5.6-sol");
    assert.equal(dispatched.modelSelectionSources?.["codex-screenwriter-v1"], "global_default");
  });

  it("replays a referenced start after the persisted node safely releases its temporary upload", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-reference-idempotency-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const availability = { available: true, reason: "", taskKinds: ["reference-grammar", "director-plan", "role-audit"] };
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

  it("blocks disabled metered providers but ignores legacy video-wide ceilings", async () => {
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
    await service.startRun({
      ...seedanceBrief,
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 2,
        maxCostCny: 5,
      },
    });
    assert.equal(pipeline.dispatchCount, 1);
    assert.deepEqual((pipeline.lastInput as ProductionBrief).economics, {
      recipeId: "keyshot-ai",
      allowMeteredProviders: true,
    });
  });

  it("allows a metered provider when zero means the video has no user-configured ceiling", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-unlimited-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      },
    });

    const result = await service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    assert.deepEqual(result, { runId: "run-1", status: "running" });
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
      codexAvailability: { available: true, reason: "" },
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

  it("does not let a legacy global ceiling override the selected video's metered run estimate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { VIDEO_FACTORY_MAX_RUN_COST_CNY: "0.05" },
      codexAvailability: { available: true, reason: "" },
      zaiCodexAvailability: { available: true, reason: "" },
    });

    const result = await service.startRun({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    });
    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
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

  it("removes a model override when its asset provider is removed from the node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-node-model-cleanup-"));
    const initialInput: ProductionBrief = {
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1", "seedance-video-v1"],
      },
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
      modelSelectionSources: { "seedance-video-v1": "node_override" },
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 4,
      },
    };
    const pipeline = new FakePipeline({ ...waitingRun(workspaceRoot), initialInput });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {
        ARK_API_KEY: "test-ark-key",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      },
      codexAvailability: { available: true, reason: "" },
    });

    await service.applyNodeExecutionConfiguration("run-1", "assets", {
      assetProviderIds: ["local-editorial-v1"],
      economics: {
        allowMeteredProviders: false,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    }, "vfqa");

    assert.deepEqual(pipeline.run.initialInput.director?.assetProviderIds, ["local-editorial-v1"]);
    assert.equal(pipeline.run.initialInput.models?.["seedance-video-v1"], undefined);
    assert.equal(pipeline.run.initialInput.modelSelectionSources?.["seedance-video-v1"], undefined);
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

  it("rejects a reviewed provider model when its task type does not fit the selected node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-incompatible-model-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = {
      ARK_API_KEY: "test-ark-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      SEEDANCE_MODEL_PROFILES_JSON: JSON.stringify([{
        id: "seedance-image-only",
        label: "Seedance 图生视频专用",
        estimatedCnyPerClip: 3.5,
        taskTypes: ["image-to-video"],
        resolutions: ["720p"],
        minDurationSeconds: 4,
        maxDurationSeconds: 10,
        supportsAudio: false,
      }]),
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
      models: { "seedance-video-v1": "seedance-image-only" },
    }), /不适合/);
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

  it("allows a fully metered director pool before the actual selected shots are quoted", async () => {
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

    const result = await service.startRun({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3.5 },
    });
    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
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

  it("routes a scene-localized revision through the same run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-scene-revision-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const result = await service.requestSceneRevision("run-1", {
      expectedRunRevision: 0,
      expectedAssetVersionId: "assets-v1",
      reviewArtifactId: "review-1",
      findingIndex: 0,
      reuseFromScenePosition: 1,
      note: "第二镜复用第一镜母片。",
    }, "jinkun");

    assert.equal(result.id, "run-1");
    assert.deepEqual(pipeline.lastSceneRevision, {
      expectedRunRevision: 0,
      expectedAssetVersionId: "assets-v1",
      reviewArtifactId: "review-1",
      findingIndex: 0,
      reuseFromScenePosition: 1,
      actor: "jinkun",
      note: "第二镜复用第一镜母片。",
    });
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
      { output: { hook: "旧钩子", scenes: [{ narration: "旧旁白" }] } },
      "trusted-owner",
    );
    assert.equal(pipeline.lastOverride, undefined);
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

  it("returns an exact active asset quote to the director with structured cost feedback", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-spend-feedback-"));
    const run = waitingRun(workspaceRoot);
    run.status = "awaiting_spend_approval";
    run.nodeRuns.unshift({
      nodeId: "assets",
      status: "awaiting_spend_approval",
      artifactIds: [],
      qualityGateResults: [],
      spendPlan: {
        id: "plan-current",
        inputVersionIds: ["director-v1"],
        providerId: "ai-shot-router-v1",
        modelId: "seedance-v1",
        estimatedCostCny: 4.8,
        maxCostCny: 4.8,
        maxAttempts: 1,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.rejectSpend("run-1", "assets", {
      spendPlanId: "plan-current",
      reason: "too_expensive",
      targetEstimatedCostCny: 2.4,
      note: "第二镜优先改用真实图库。",
    }, "trusted-owner");

    assert.deepEqual(pipeline.lastSpendRejection, {
      nodeId: "assets",
      spendPlanId: "plan-current",
      reason: "too_expensive",
      targetEstimatedCostCny: 2.4,
      note: "第二镜优先改用真实图库。",
      rejectedBy: "trusted-owner",
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
        content: { title: "旧脚本", scenes: [{ narration: "旧旁白" }] },
      },
    }, "trusted-owner");
    assert.equal(pipeline.lastOverride, undefined);

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
      input: { candidateInventoryPath: "[系统托管文件]", selectedAssetIds: ["one"] },
    }, "trusted-owner");
    assert.equal(pipeline.lastInputOverride, undefined);

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

  it("authorizes audited run-local media when an asset document replaces a file", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-1");
    const assetPlanPath = path.join(runRoot, "nodes", "assets", "attempt-1", "asset-plan.json");
    const originalPath = path.join(runRoot, "nodes", "assets", "attempt-1", "original.mp4");
    const replacementPath = path.join(runRoot, "curated", "replacement.mp4");
    const plan = {
      scene_assets: [{
        scene_position: 1,
        provider: "pexels",
        asset_id: "original",
        media_type: "video",
        width: 720,
        height: 1280,
        duration: 3,
        local_path: originalPath,
        source_url: "https://example.com/original",
        creator: "Original creator",
        license_note: "Original license",
        query: "original",
      }],
    };
    await mkdir(path.dirname(assetPlanPath), { recursive: true });
    await mkdir(path.dirname(replacementPath), { recursive: true });
    await writeFile(assetPlanPath, JSON.stringify(plan), "utf8");
    await writeFile(originalPath, "original-video", "utf8");
    await writeFile(replacementPath, "replacement-video", "utf8");

    const run = waitingRun(workspaceRoot);
    run.nodeRuns.unshift({
      nodeId: "assets",
      status: "succeeded",
      output: { assetPlanPath },
      artifactIds: ["artifact-asset-plan"],
      qualityGateResults: [],
    });
    run.artifacts.push({
      id: "artifact-asset-plan",
      kind: "asset_plan",
      uri: assetPlanPath,
      createdAt: "2026-08-21T10:00:00.000Z",
      contentType: "application/json",
      producer: { nodeId: "assets", attempt: 1 },
      provenance: { providerId: "asset-worker", providerVersion: "1" },
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const edited = structuredClone(plan);
    edited.scene_assets[0]!.local_path = replacementPath;
    edited.scene_assets[0]!.asset_id = "human-replacement";

    await service.applyNodeOverride("run-1", "assets", {
      document: { artifactId: "artifact-asset-plan", content: edited },
      authorizedRunFiles: [replacementPath],
    }, "trusted-owner");

    const replacementArtifact = pipeline.lastOverride?.artifacts?.find((artifact) => artifact.uri === replacementPath);
    assert.equal(replacementArtifact?.kind, "human_media_revision");
    assert.equal(replacementArtifact?.contentType, "video/mp4");
    assert.equal(replacementArtifact?.provenance?.providerId, "human-editor");
    assert.match(replacementArtifact?.provenance?.licenseNote ?? "", /manual verification/);
    assert.equal(replacementArtifact?.sizeBytes, Buffer.byteLength("replacement-video"));
    const savedPlan = JSON.parse(await readFile((pipeline.lastOverride?.output as { assetPlanPath: string }).assetPlanPath, "utf8")) as typeof plan & {
      scene_assets: Array<typeof plan.scene_assets[number] & { provider_id?: string; rights_status?: string }>;
    };
    assert.equal(savedPlan.scene_assets[0]?.local_path, replacementPath);
    assert.equal(savedPlan.scene_assets[0]?.provider, "human");
    assert.equal(savedPlan.scene_assets[0]?.provider_id, "human-editor");
    assert.equal(savedPlan.scene_assets[0]?.creator, "trusted-owner");
    assert.equal(savedPlan.scene_assets[0]?.source_url, undefined);
    assert.equal(savedPlan.scene_assets[0]?.rights_status, "review_required");
    assert.match(savedPlan.scene_assets[0]?.license_note ?? "", /发布前/);

    const outsidePath = path.join(workspaceRoot, "outside.mp4");
    await writeFile(outsidePath, "outside-video", "utf8");
    const forged = structuredClone(plan);
    forged.scene_assets[0]!.local_path = outsidePath;
    await assert.rejects(
      () => service.applyNodeOverride("run-1", "assets", {
        document: { artifactId: "artifact-asset-plan", content: forged },
        authorizedRunFiles: [outsidePath],
      }, "trusted-owner"),
      /当前制作目录/,
    );
  });

  it("keeps publish compliance fields immutable while allowing copy edits", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const packagePath = path.join(workspaceRoot, "runs", "run-1", "publish", "publish-package.json");
    const publishPackage = {
      version: "video-factory/publish-package-v1",
      title: "旧标题",
      copy: { source: "model", title: "旧标题", description: "旧描述", hashtags: ["旧话题"] },
      approval: { status: "approved", actor: "director" },
      aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
      resourceManifest: { needsReviewCount: 2 },
      artifacts: [{ kind: "human_media_revision", provenance: { licenseNote: "待核验" } }],
    };
    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, JSON.stringify(publishPackage), "utf8");
    const run = waitingRun(workspaceRoot);
    run.nodeRuns.push({
      nodeId: "publish-package",
      status: "succeeded",
      output: { publishPackagePath: packagePath },
      artifactIds: ["artifact-package"],
      qualityGateResults: [],
    });
    run.artifacts.push({
      id: "artifact-package",
      kind: "publish_package",
      uri: packagePath,
      createdAt: "2026-08-21T10:00:00.000Z",
      contentType: "application/json",
      producer: { nodeId: "publish-package", attempt: 1 },
      provenance: { providerId: "video-factory-ts-v1", providerVersion: "1" },
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const forged = structuredClone(publishPackage);
    forged.resourceManifest.needsReviewCount = 0;
    forged.artifacts[0]!.kind = "media_asset";

    await assert.rejects(
      () => service.applyNodeOverride("run-1", "publish-package", {
        document: { artifactId: "artifact-package", content: forged },
      }, "trusted-owner"),
      /由系统托管/,
    );

    const edited = structuredClone(publishPackage);
    edited.title = "新标题";
    edited.copy.title = "新标题";
    edited.copy.description = "新描述";
    edited.copy.hashtags = ["新话题"];
    await service.applyNodeOverride("run-1", "publish-package", {
      document: { artifactId: "artifact-package", content: edited },
    }, "trusted-owner");
    const saved = JSON.parse(await readFile((pipeline.lastOverride?.output as { publishPackagePath: string }).publishPackagePath, "utf8")) as typeof publishPackage;
    assert.equal(saved.title, "新标题");
    assert.equal(saved.resourceManifest.needsReviewCount, 2);
    assert.equal(saved.artifacts[0]?.kind, "human_media_revision");
  });

  it("derives unchanged asset provenance from the immutable media artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-1");
    const assetPlanPath = path.join(runRoot, "nodes", "assets", "asset-plan.json");
    const mediaPath = path.join(runRoot, "nodes", "assets", "clip.mp4");
    const plan = { scene_assets: [{
      scene_position: 1,
      local_path: mediaPath,
      provider: "pexels",
      provider_id: "pexels-stock-v1",
      source_url: "https://www.pexels.com/video/1",
      creator: "Real creator",
      license_note: "Pexels terms",
    }] };
    await mkdir(path.dirname(assetPlanPath), { recursive: true });
    await writeFile(assetPlanPath, JSON.stringify(plan), "utf8");
    await writeFile(mediaPath, "video", "utf8");
    const run = waitingRun(workspaceRoot);
    run.nodeRuns.unshift({ nodeId: "assets", status: "succeeded", output: { assetPlanPath }, artifactIds: ["plan", "media"], qualityGateResults: [] });
    run.artifacts.push(
      { id: "plan", kind: "asset_plan", uri: assetPlanPath, createdAt: "2026-08-21T10:00:00.000Z", contentType: "application/json", producer: { nodeId: "assets", attempt: 1 }, provenance: { providerId: "asset-worker" } },
      { id: "media", kind: "media_asset", uri: mediaPath, createdAt: "2026-08-21T10:00:00.000Z", contentType: "video/mp4", producer: { nodeId: "assets", attempt: 1 }, provenance: { providerId: "pexels-stock-v1", sourceUrl: "https://www.pexels.com/video/1", creator: "Real creator", licenseNote: "Pexels terms" } },
    );
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const forged = structuredClone(plan);
    forged.scene_assets[0]!.provider = "local";
    forged.scene_assets[0]!.provider_id = "local";
    forged.scene_assets[0]!.source_url = "local://owned";
    forged.scene_assets[0]!.creator = "attacker";
    forged.scene_assets[0]!.license_note = "self owned";

    await service.applyNodeOverride("run-1", "assets", {
      document: { artifactId: "plan", content: forged },
    }, "trusted-owner");

    const saved = JSON.parse(await readFile((pipeline.lastOverride?.output as { assetPlanPath: string }).assetPlanPath, "utf8")) as typeof plan;
    assert.equal(saved.scene_assets[0]?.provider_id, "pexels-stock-v1");
    assert.equal(saved.scene_assets[0]?.source_url, "https://www.pexels.com/video/1");
    assert.equal(saved.scene_assets[0]?.creator, "Real creator");
    assert.equal(saved.scene_assets[0]?.license_note, "Pexels terms");
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

    const refresh = await service.refreshTrendCandidates();
    assert.equal(refresh.status, "started");
    assert.equal(refresh.requestedAt, "2026-08-24T00:01:00.000Z");
    assert.match(refresh.refreshId, /^[0-9a-f-]{36}$/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    let refreshState = (await service.trendCandidateRefreshStatus(refresh.refreshId)).state;
    for (let attempt = 0; attempt < 20 && refreshState === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      refreshState = (await service.trendCandidateRefreshStatus(refresh.refreshId)).state;
    }
    assert.equal(refreshState, "succeeded");
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
      source: "录入时估分 · topic-intelligence-v1",
      scoredAt: "2026-08-22T10:00:00.000Z",
    });
    assert.equal(listed[0]?.id, "opportunity-1");
    assert.equal(loaded?.hook, opportunityInput.hook);
    assert.equal(approved.status, "approved");
  });
});

function passingGreenlightAgent() {
  return {
    generate: async () => { throw new Error("Use the editable rule fallback for the initial roadmap."); },
    reviewEpisode: async (_series: StudioSeries, episode: StudioSeriesEpisode) => ({
      draft: {
        episodeNumber: episode.episodeNumber,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        fromPrevious: [...episode.continuity.fromPrevious],
        toNext: [...episode.continuity.toNext],
      },
      planning: {
        source: episode.planning.source === "human" ? "human" as const : "agent" as const,
        role: "系列开拍总编",
        auditRole: "独立质量审计 Agent",
        auditStatus: "passed" as const,
        auditIterations: 1,
        providerId: "codex-series-planner-v1",
        modelId: "codex-default",
        promptVersion: "video-factory/series-greenlight-v1",
      },
    }),
  };
}
