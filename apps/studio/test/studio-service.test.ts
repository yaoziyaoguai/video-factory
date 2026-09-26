import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Artifact, HumanDecisionDraft, NodeInputOverrideDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
import type {
  DispatchedProductionRun,
  ProductionBrief,
  ProductionPaidNodeReconciliationDraft,
  ProductionPaidNodeSummary,
  ProductionRunListener,
  ProductionSceneRevisionDraft,
  ProductionSpendRejectionDraft,
} from "@video-factory/production-pipeline";
import { CodexBridgeClient, effectiveProductionBrief, HumanDecisionConflictError, PaidOperationManualReconciliationError, productionWorkflowVersion, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS, StaleRunRevisionError, type CodexPreparedOperation } from "@video-factory/production-pipeline";
import {
  StudioConflictError,
  StudioService as ProductionStudioService,
  type StudioPipelinePort,
} from "../src/server/studio-service.js";
import { JsonOpportunityStore } from "../src/server/opportunity-store.js";
import { JsonRunArchiveStore } from "../src/server/run-archive-store.js";
import { loadAgentLoopProgress, ProductionStudio } from "../src/server/production-studio.js";
import type { StudioDecisionInput, StudioOpportunityInput, StudioProvider, StudioSeries, StudioSeriesEpisode } from "../src/shared/api.js";

class StudioService extends ProductionStudioService {
  constructor(options: ConstructorParameters<typeof ProductionStudioService>[0]) {
    super({
      codexAvailability: {
        available: true,
        reason: "",
        taskKinds: ["script-draft", "director-plan", "reference-grammar", "role-audit"],
      },
      ...options,
    });
  }
}

const legacyBrief: ProductionBrief = {
  protocolVersion: "video-factory/brief-v1",
  title: "做决定前，先避开这 3 个坑",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 24,
  platform: "douyin",
  reviewMode: "manual",
  runPurpose: "test",
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

const brief: ProductionBrief = {
  ...legacyBrief,
  durationRange: { minSeconds: 20, maxSeconds: 34 },
  providers: {
    ...legacyBrief.providers,
    director: "api-visual-director-v1",
    assets: "ai-shot-router-v1",
  },
  workflowFeatures: {
    assetSemanticRank: false,
    referenceGrammar: false,
    executablePlan: true,
    creativePlanning: "joint-v1",
    creativeReview: "user-confirmed-v1",
    // 边界闸门是新建制作的必需项，所以"一份现代简报"必须带上它——少了它连 start 都进不去。
    boundaryGates: "user-confirmed-v1",
  },
  director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
};

function waitingRun(workspaceRoot: string): WorkflowRun<ProductionBrief> {
  const videoPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "render", "attempt-1", "final.mp4");
  return {
    id: "run-1",
    revision: 0,
    workflowId: "daily-production",
    workflowVersion: "1.0.0",
    status: "needs_human",
    initialInput: legacyBrief,
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

function executableWaitingRun(workspaceRoot: string): WorkflowRun<ProductionBrief> {
  return {
    ...waitingRun(workspaceRoot),
    workflowVersion: productionWorkflowVersion(brief),
    initialInput: brief,
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
  lastVoiceTimingRevision?: {
    expectedRunRevision: number;
    interventionId: string;
    scenePosition: number;
    durationSeconds: number;
    actor: string;
  };
  lastRetriedNodeId?: string;
  lastRetryOptions?: {
    recoverOriginalTextTask?: boolean;
    resumeCompletedTextTask?: boolean;
    resumeCompletedTextTaskRequestId?: string;
  };
  retryDispatchCount = 0;
  lastExecutionConfigurationNodeId?: string;
  lastReconciliation?: ProductionPaidNodeReconciliationDraft;
  lastReconciliationOptions?: { settleOnly?: boolean };
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

  async requestVoiceTimingRevision(_runId: string, draft: NonNullable<FakePipeline["lastVoiceTimingRevision"]>): Promise<WorkflowRun<ProductionBrief>> {
    this.lastVoiceTimingRevision = draft;
    this.run = { ...this.run, revision: this.run.revision + 1, status: "stale" };
    return this.run;
  }

  async applyNodeInputOverride(_runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
    this.lastInputOverride = override;
    return this.run;
  }

  async applyNodeExecutionConfiguration(
    _runId: string,
    nodeId: string,
    brief: ProductionBrief,
    _actor: string,
  ): Promise<WorkflowRun<ProductionBrief>> {
    this.lastExecutionConfigurationNodeId = nodeId;
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

  async retryFailedNode(
    _runId: string,
    nodeId: string,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<WorkflowRun<ProductionBrief>> {
    this.lastRetriedNodeId = nodeId;
    this.lastRetryOptions = options;
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
    options?: { settleOnly?: boolean },
  ): Promise<WorkflowRun<ProductionBrief>> {
    this.lastReconciliation = draft;
    this.lastReconciliationOptions = options;
    if (this.reconciliationError) throw this.reconciliationError;
    return this.run;
  }

  async dispatchRetryFailedNode(
    _runId: string,
    nodeId: string,
    listener?: ProductionRunListener,
    options?: { recoverOriginalTextTask?: boolean; resumeCompletedTextTask?: boolean; resumeCompletedTextTaskRequestId?: string },
  ): Promise<DispatchedProductionRun> {
    this.retryDispatchCount += 1;
    this.lastRetriedNodeId = nodeId;
    this.lastRetryOptions = options;
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

function fileIntegrity(content: string | Buffer): { sizeBytes: number; sha256: string } {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("StudioService", () => {
  it("marks only a structured rework-scope failure as needing a fresh scope decision", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-rework-coded-failure-"));
    const base = waitingRun(workspaceRoot);
    const failed = {
      ...base,
      status: "failed" as const,
      nodeRuns: [...base.nodeRuns, {
        nodeId: "assets", status: "failed" as const, startedAt: base.startedAt,
        finishedAt: base.startedAt, artifactIds: [], qualityGateResults: [],
        error: "返工镜头超出已批准范围", errorCode: "REWORK_SCOPE_CONFLICT",
      }],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(failed), commandAvailable: allCommandsAvailable, environment: {} });
    const draft = await service.reworkDraft(base.id);
    assert.equal(draft?.scopeState, "needs_scope");
    assert.match(draft?.scopePrompt ?? "", /原失败记录已保留/);

    const unrelated = { ...failed, nodeRuns: failed.nodeRuns.map((node) => node.nodeId === "assets" ? { ...node, errorCode: "PROVIDER_ERROR" } : node) };
    const unrelatedService = new StudioService({ workspaceRoot, pipeline: new FakePipeline(unrelated), commandAvailable: allCommandsAvailable, environment: {} });
    assert.equal((await unrelatedService.reworkDraft(base.id))?.scopeState, "resolved");
  });

  it("rejects an ordinary retry after creative planning has escalated a source limitation to a manual gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-planning-source-gate-"));
    const base = executableWaitingRun(workspaceRoot);
    const jointBrief: ProductionBrief = {
      ...brief,
      workflowFeatures: { ...brief.workflowFeatures, creativePlanning: "joint-v1", assetSemanticRank: true },
    };
    const run: WorkflowRun<ProductionBrief> = {
      ...base,
      initialInput: jointBrief,
      workflowVersion: productionWorkflowVersion(jointBrief),
      status: "failed",
      nodeRuns: [{
        nodeId: "creative-planning",
        status: "failed",
        startedAt: base.startedAt,
        finishedAt: base.finishedAt,
        artifactIds: [],
        qualityGateResults: [],
        error: "Joint creative planning stopped (needs_source): 连续两轮仍缺少可自动采用的真实图库素材，自动规划已停止。 不回退旧规划流程。",
      }],
    };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const detail = await service.getRun(run.id);
    assert.equal(detail?.failure?.nodeId, "creative-planning");
    assert.equal(detail?.failure?.retryable, false);

    await assert.rejects(
      () => service.retryFailedNode(run.id, "creative-planning"),
      /人工调整|重新规划/,
    );
    assert.equal(pipeline.retryDispatchCount, 0);
    assert.equal(pipeline.lastRetriedNodeId, undefined);
  });

  it("projects the pure rework impact summary without exposing an editing surface", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-impact-"));
    const base = executableWaitingRun(workspaceRoot);
    const run: WorkflowRun<ProductionBrief> = {
      ...base,
      initialInput: {
        ...legacyBrief,
        rework: {
          sourceRunId: "run-source",
          sourceRunRevision: 4,
          affectedScenePositions: [],
          nodeInstructions: { script: "沿用", visualDirection: "沿用", assets: "沿用" },
          findings: [],
        },
      },
      nodeRuns: [{
        nodeId: "script",
        status: "succeeded",
        startedAt: base.startedAt,
        finishedAt: base.startedAt,
        artifactIds: ["artifact-script-inherited"],
        qualityGateResults: [],
        outputState: {
          effectiveVersionId: "script-inherited-v1",
          versions: [{
            id: "script-inherited-v1",
            nodeId: "script",
            source: "generated",
            artifactIds: ["artifact-script-inherited"],
            inputVersionIds: [],
            createdAt: base.startedAt,
            createdBy: "codex-screenwriter-v1",
            schemaVersion: "video-factory/script-draft-v1",
          }],
        },
      }, ...base.nodeRuns],
      artifacts: [{
        id: "artifact-script-inherited",
        kind: "script",
        createdAt: base.startedAt,
        sha256: "b".repeat(64),
        sizeBytes: 2,
        contentType: "application/json",
        schemaVersion: "video-factory/script-draft-v1",
        producer: { nodeId: "script", attempt: 1 },
        provenance: {
          providerId: "codex-screenwriter-v1",
          notes: "Inherited unchanged from run-source artifact source-script.",
        },
      }, ...base.artifacts],
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const detail = await service.getRun(run.id);

    assert.equal(detail?.reworkImpact?.sourceRunId, "run-source");
    assert.deepEqual(detail?.reworkImpact?.affectedScenePositions, []);
    assert.equal(detail?.reworkImpact?.calls.scriptModel, 0);
    assert.equal(detail?.reworkImpact?.calls.mediaCreate, 0);
    assert.deepEqual(detail?.reworkImpact?.nodes[0], {
      nodeId: "script",
      action: "inherited",
      reason: "verified_source_match",
    });
  });

  it("builds a rejected-run draft that inherits production choices and prefills affected nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-draft-"));
    const scriptPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "attempt-1", "script.json");
    const storyboardPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "visual-direction", "attempt-1", "storyboard.json");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(storyboardPath), { recursive: true });
    const scriptContent = JSON.stringify({ viewerPromise: "原版承诺", scenes: [1, 2, 3, 4].map((position) => ({ position })) });
    const storyboardContent = JSON.stringify({ visualBible: { typography: "画面内不出现文字" }, shots: [1, 2, 3, 4].map((scenePosition) => ({ scenePosition })) });
    await writeFile(scriptPath, scriptContent, "utf8");
    await writeFile(storyboardPath, storyboardContent, "utf8");
    const base = waitingRun(workspaceRoot);
    const rejectedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      revision: 12,
      initialInput: {
        ...legacyBrief,
        runPurpose: "test",
        visualProof: "四个具体镜头共同兑现同一个可见证据。",
        visualPlan: {
          strategy: "沿用上一版四镜证据链，只重做审片指出的镜头。",
          beats: [{
            id: "proof-chain",
            role: "证据推进",
            duration: "0-24 秒",
            description: "同一主体在四个连续动作中完成证据链。",
            searchQuery: "continuous evidence action sequence",
            source: "stock",
          }],
        },
        providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1", visualReview: "deepseek-visual-review-v1" },
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
            { timecodeMs: 4_000, startTimecodeMs: 4_000, endTimecodeMs: 4_000, scenePosition: 2, targetNodeIds: ["script"], evidenceStatus: "failed", evidenceFrameSha256: "a".repeat(64), nextAction: "replan_upstream", severity: "warning", category: "factual_accuracy", description: "第二镜数字错误。", suggestion: "改成已核验数据。" },
            { timecodeMs: 8_000, startTimecodeMs: 8_000, endTimecodeMs: 8_000, scenePosition: 3, targetNodeId: "assets", claimType: "static", evidenceStatus: "failed", evidenceFrameSha256: "b".repeat(64), nextAction: "rework_asset", severity: "warning", category: "typography", description: "文字遮挡主体。", suggestion: "换用无字母片。" },
            { timecodeMs: 12_000, startTimecodeMs: 12_000, endTimecodeMs: 12_000, scenePosition: 4, targetNodeId: "visual-direction", claimType: "static", evidenceStatus: "failed", evidenceFrameSha256: "c".repeat(64), nextAction: "replan_upstream", severity: "warning", category: "composition", description: "主体被裁切到画面边缘。", suggestion: "换成主体完整居中的镜头。" },
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
          ...fileIntegrity(scriptContent),
          producer: { nodeId: "script", attempt: 1 },
          provenance: { providerId: "codex-screenwriter-v1" },
        },
        {
          id: "artifact-storyboard",
          kind: "storyboard",
          uri: storyboardPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          ...fileIntegrity(storyboardContent),
          producer: { nodeId: "visual-direction", attempt: 1 },
          provenance: { providerId: "api-visual-director-v1" },
        },
      ],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(rejectedRun), commandAvailable: allCommandsAvailable, environment: {} });
    rejectedRun.initialInput.budgetIntentionCny = 35;

    const draft = await service.reworkDraft("run-1");
    const sameDraft = await service.reworkDraft("run-1");

    assert.equal(draft?.input.rework?.sourceRunRevision, 12);
    assert.equal(draft?.input.director?.profileId, "documentary-observer");
    assert.equal(draft?.input.models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.equal(draft?.input.runPurpose, "test");
    assert.equal(draft?.input.budgetIntentionCny, 35);
    assert.equal(draft?.input.visualProof, "四个具体镜头共同兑现同一个可见证据。");
    assert.equal(draft?.input.visualPlan?.strategy, "沿用上一版四镜证据链，只重做审片指出的镜头。");
    assert.deepEqual(
      draft?.input.rework?.findings.map(({ findingId }) => findingId),
      sameDraft?.input.rework?.findings.map(({ findingId }) => findingId),
    );
    assert.equal(new Set(draft?.input.rework?.findings.map(({ findingId }) => findingId)).size, 3);
    assert.ok(draft?.input.rework?.findings.every(({ findingId }) => /^vf_[a-f0-9]{24}$/.test(findingId)));
    assert.deepEqual(draft?.input.rework?.findings[0]?.targetNodeIds, ["script", "visual-direction", "assets"]);
    assert.equal(draft?.input.rework?.findings[0]?.primaryOwnerNodeId, "script");
    assert.deepEqual(draft?.input.rework?.findings[0]?.affectedNodeIds, ["script", "visual-direction", "assets"]);
    assert.equal(draft?.input.rework?.findings[0]?.action, "replan_upstream");
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /第二镜数字错误/);
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /改成已核验数据/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.script ?? "", /主体被裁切到画面边缘|换成主体完整居中的镜头/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /第二镜数字错误/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /改成已核验数据/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /文字遮挡主体|换用无字母片/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /主体被裁切到画面边缘/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /换成主体完整居中的镜头/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /不得用说明卡/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /第二镜数字错误/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /改成已核验数据/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /文字遮挡主体/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /主体被裁切到画面边缘/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /换成主体完整居中的镜头/);
    assert.match(draft?.input.rework?.nodeInstructions.script ?? "", /本次重做原因/);
    assert.deepEqual(draft?.input.rework?.previousScript, { viewerPromise: "原版承诺", scenes: [1, 2, 3, 4].map((position) => ({ position })) });
    assert.deepEqual(draft?.inheritedNodeIds, ["brief", "script", "visual-direction", "visual-review"]);
    // 未形成素材任务不等于其余镜头没有内容影响：范围以旧脚本/分镜的四镜宇宙保守呈现。
    assert.deepEqual(draft?.requiredAffectedScenePositions, [1, 2, 3, 4]);
    assert.deepEqual(draft?.input.rework?.affectedScenePositions, [1, 2, 3, 4]);

    const tampered = structuredClone(draft!.input);
    tampered.providers.script = "codex-screenwriter-v1";
    tampered.rework!.findings[0]!.description = "用户尝试改写审片事实";
    await assert.rejects(() => service.startRun(tampered), /审片问题已经变化或被修改/);
  });

  it("uses the effective human brief in list, detail, and rework projections without losing frozen task contracts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-effective-brief-"));
    const base = waitingRun(workspaceRoot);
    const initialInput: ProductionBrief = {
      ...base.initialInput,
      taskContractDigests: { ...REQUIRED_CODEX_TASK_CONTRACT_DIGESTS },
    };
    const humanBrief = {
      title: "人工修订后的标题",
      angle: "人工确认的新角度",
      audience: "第一次尝试视频创作的人",
    };
    const run: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      initialInput,
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "brief",
        status: "succeeded",
        output: { ...initialInput, ...humanBrief },
        artifactIds: [],
        qualityGateResults: [],
        outputState: {
          nodeId: "brief",
          generatedVersionId: "brief-generated",
          effectiveVersionId: "brief-human",
          stale: false,
          versions: [{
            id: "brief-generated",
            nodeId: "brief",
            source: "generated",
            output: initialInput,
            artifactIds: [],
            inputVersionIds: [],
            createdAt: base.startedAt,
            createdBy: "creator",
            schemaVersion: "video-factory/brief-v1",
          }, {
            id: "brief-human",
            nodeId: "brief",
            source: "human",
            output: humanBrief,
            artifactIds: [],
            inputVersionIds: [],
            createdAt: base.startedAt,
            createdBy: "owner",
            schemaVersion: "video-factory/brief-v1",
          }],
        },
      }],
      artifacts: [],
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const [summary] = await service.listRuns();
    const detail = await service.getRun(run.id);
    const rework = await service.reworkDraft(run.id);

    assert.equal(summary?.title, humanBrief.title);
    assert.equal(detail?.angle, humanBrief.angle);
    assert.equal(detail?.audience, humanBrief.audience);
    assert.equal(rework?.input.title, humanBrief.title);
    assert.equal(rework?.input.angle, humanBrief.angle);
    assert.deepEqual(effectiveProductionBrief(run).taskContractDigests, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS);
    assert.equal(run.initialInput.title, brief.title);
  });

  it("turns a note-only human rejection into an executable and protected scene scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-note-only-rework-"));
    const scriptPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "attempt-1", "script.json");
    const storyboardPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "visual-direction", "attempt-1", "director_plan.json");
    const scriptContent = JSON.stringify({ scenes: [1, 2, 3, 4].map((position) => ({ position })) });
    const storyboardContent = JSON.stringify({ shots: [1, 2, 3, 4].map((scenePosition) => ({ scenePosition })) });
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(storyboardPath), { recursive: true });
    await writeFile(scriptPath, scriptContent, "utf8");
    await writeFile(storyboardPath, storyboardContent, "utf8");
    const base = waitingRun(workspaceRoot);
    const run: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      decisions: [{
        interventionId: "intervention-1",
        action: "reject",
        decidedBy: "owner",
        decidedAt: "2026-08-21T10:02:00.000Z",
        note: "第 2、4 镜构图没有兑现开场承诺。",
      }],
      nodeRuns: [{
        nodeId: "script",
        status: "succeeded",
        artifactIds: ["artifact-script"],
        qualityGateResults: [],
      }, {
        nodeId: "visual-direction",
        status: "succeeded",
        artifactIds: ["artifact-storyboard"],
        qualityGateResults: [],
      }],
      artifacts: [{
        id: "artifact-script",
        kind: "script",
        uri: scriptPath,
        createdAt: base.startedAt,
        contentType: "application/json",
        ...fileIntegrity(scriptContent),
        producer: { nodeId: "script", attempt: 1 },
        provenance: { providerId: "codex-screenwriter-v1" },
      }, {
        id: "artifact-storyboard",
        kind: "storyboard",
        uri: storyboardPath,
        createdAt: base.startedAt,
        contentType: "application/json",
        ...fileIntegrity(storyboardContent),
        producer: { nodeId: "visual-direction", attempt: 1 },
        provenance: { providerId: "api-visual-director-v1" },
      }],
    };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const localized = await service.reworkDraft("run-1");
    assert.deepEqual(localized?.input.rework?.findings, []);
    assert.deepEqual(localized?.requiredAffectedScenePositions, [1, 2, 3, 4]);
    assert.deepEqual(localized?.input.rework?.affectedScenePositions, [1, 2, 3, 4]);
    assert.match(localized?.input.rework?.nodeInstructions.visualDirection ?? "", /第 2、4 镜构图没有兑现/);
    await assert.rejects(
      () => service.startRun({
        ...localized!.input,
        providers: { ...localized!.input.providers, script: "codex-screenwriter-v1" },
        rework: { ...localized!.input.rework!, affectedScenePositions: [2] },
      }),
      /返工范围不能移除/,
    );

    run.decisions[0]!.note = "整体节奏和画面承诺都需要重新调整。";
    const wholeFilm = await service.reworkDraft("run-1");
    assert.deepEqual(wholeFilm?.requiredAffectedScenePositions, [1, 2, 3, 4]);
    assert.deepEqual(wholeFilm?.input.rework?.affectedScenePositions, [1, 2, 3, 4]);
  });

  it("rejects a same-size JSON artifact whose bytes changed before building a rework draft", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rework-integrity-"));
    const base = waitingRun(workspaceRoot);
    const scriptPath = path.join(workspaceRoot, "runs", base.id, "nodes", "script", "attempt-1", "script.json");
    const original = '{"scenes":[1]}';
    const tampered = '{"scenes":[2]}';
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, original, "utf8");
    const run: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "script",
        status: "succeeded",
        output: { scriptPath },
        artifactIds: ["artifact-script"],
        qualityGateResults: [],
      }],
      artifacts: [{
        id: "artifact-script",
        kind: "script",
        uri: scriptPath,
        createdAt: base.startedAt,
        contentType: "application/json",
        ...fileIntegrity(original),
        producer: { nodeId: "script", attempt: 1 },
        provenance: { providerId: "codex-screenwriter-v1" },
      }],
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(tampered));
    await writeFile(scriptPath, tampered, "utf8");

    await assert.rejects(() => service.reworkDraft(run.id), /内容已经变化/);
  });

  it("prefills an asset rework from the source-media visual gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-source-review-rework-"));
    const base = waitingRun(workspaceRoot);
    const failedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "failed",
      revision: 4,
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        startedAt: base.startedAt,
        finishedAt: base.finishedAt,
        artifactIds: [],
        qualityGateResults: [],
        error: "源素材视觉预检未通过。",
        output: {
          sourceVisualReview: {
            reviewScope: {
              reviewStage: "source_assets",
              evidenceId: "b".repeat(64),
              sourceNodeIds: ["assets"],
              sourceArtifactIds: ["pilot-media-3"],
              scenePositions: [3],
              timelineDurationMs: 10_000,
              actualModels: [{ providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" }],
            },
            findings: [{
              timecodeMs: 8_000,
              startTimecodeMs: 7_800,
              endTimecodeMs: 8_200,
              scenePosition: 3,
              targetNodeId: "assets",
              claimType: "static", evidenceStatus: "failed",
              evidenceFrameSha256: "c".repeat(64),
              nextAction: "rework_asset",
              category: "text_interference",
              severity: "major",
              description: "画面烧入了不可接受的文字。",
              suggestion: "第三镜换成无字素材并重新检查。",
            }, {
              timecodeMs: 600,
              scenePosition: 1,
              targetNodeId: "assets",
              claimType: "static", evidenceStatus: "not_observed",
              category: "other",
              severity: "warning",
              description: "稀疏抽帧不足以证明完整运动。",
              suggestion: "先补充已有素材的过程帧，不应直接重生成。",
            }],
          },
        },
      }],
      artifacts: [],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(failedRun), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");
    const finding = draft?.input.rework?.findings[0];

    assert.equal(finding?.scenePosition, 3);
    assert.equal(draft?.input.rework?.findings.length, 1);
    assert.deepEqual(draft?.requiredAffectedScenePositions, [3]);
    assert.deepEqual(draft?.input.rework?.affectedScenePositions, [3]);
    assert.equal((failedRun.nodeRuns[0]!.output as { sourceVisualReview: { findings: unknown[] } }).sourceVisualReview.findings.length, 2);
    assert.deepEqual(finding?.targetNodeIds, ["assets"]);
    assert.equal(finding?.startTimecodeMs, 7_800);
    assert.equal(finding?.endTimecodeMs, 8_200);
    assert.equal(finding?.evidenceStatus, "failed");
    assert.equal(finding?.evidenceFrameSha256, "c".repeat(64));
    assert.equal(finding?.nextAction, "rework_asset");
    assert.equal(finding?.sourceReviewStage, "source_assets");
    assert.equal(finding?.sourceReviewNodeId, "assets");
    assert.equal(finding?.sourceReviewVersionId, "legacy-output");
    assert.equal(finding?.reviewEvidenceId, "b".repeat(64));
    assert.deepEqual(finding?.actualModels, [{ providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" }]);
    assert.equal(finding?.current, true);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /第三镜换成无字素材并重新检查/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.assets ?? "", /补充已有素材的过程帧/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /画面烧入了不可接受的文字/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /本轮结构化问题未直接指向导演方案/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /当前没有结构化视觉问题/);
  });

  it("keeps a stale visual report as history without expanding the current rework scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stale-review-rework-"));
    const base = waitingRun(workspaceRoot);
    const reportOutput = { report: {
      version: "video-factory/visual-review-v1",
      summary: "旧成片的第一镜需要替换。",
      scores: { composition: 70, continuity: 80, pacing: 80, legibility: 80, safety: 90 },
      findings: [{
        timecodeMs: 1_000,
        startTimecodeMs: 900,
        endTimecodeMs: 1_100,
        scenePosition: 1,
        targetNodeId: "assets",
        claimType: "static", evidenceStatus: "failed",
        evidenceFrameSha256: null,
        nextAction: "rework_asset",
        category: "composition",
        severity: "warning",
        description: "旧版第一镜主体被裁切。",
        suggestion: "替换旧版第一镜。",
      }],
      confidence: 0.9,
      recommendation: "revise",
      reviewScope: {
        reviewStage: "rendered_video",
        evidenceId: "a".repeat(64),
        sourceNodeIds: ["render", "technical-review"],
        sourceArtifactIds: ["old-render-artifact"],
        scenePositions: [1],
        timelineDurationMs: 24_000,
        actualModels: [{ providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" }],
        current: true,
      },
    } };
    const rejectedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      initialInput: {
        ...base.initialInput,
        providers: { ...base.initialInput.providers, visualReview: "deepseek-visual-review-v1" },
      },
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "visual-review",
        status: "stale",
        artifactIds: [],
        qualityGateResults: [],
        output: reportOutput,
        outputState: {
          nodeId: "visual-review",
          generatedVersionId: "review-v1",
          effectiveVersionId: "review-v1",
          stale: true,
          versions: [{
            id: "review-v1",
            nodeId: "visual-review",
            source: "generated",
            artifactIds: [],
            output: reportOutput,
            inputVersionIds: ["old-render-v1"],
            createdAt: base.startedAt,
            createdBy: "deepseek-visual-review-v1",
            schemaVersion: "video-factory/visual-review-v1",
          }],
        },
      }],
      artifacts: [],
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(rejectedRun),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const draft = await service.reworkDraft("run-1");
    const detail = await service.getRun("run-1");

    assert.deepEqual(draft?.input.rework?.findings, []);
    assert.deepEqual(draft?.requiredAffectedScenePositions, []);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.assets ?? "", /旧版第一镜/);
    const projected = detail?.nodes.find((node) => node.id === "visual-review")?.output as typeof reportOutput | undefined;
    assert.equal(projected?.report.reviewScope.current, false);
    const projectedVersion = detail?.nodes.find((node) => node.id === "visual-review")?.outputState?.versions[0]?.output as typeof reportOutput | undefined;
    assert.equal(projectedVersion?.report.reviewScope.current, false);
  });

  it("prefills the concrete failed-node reason instead of a generic rework summary", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-failed-node-rework-"));
    const base = waitingRun(workspaceRoot);
    const failedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "failed",
      revision: 5,
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "asset-semantic-rank",
        role: "候选画面复核",
        status: "failed",
        startedAt: base.startedAt,
        finishedAt: base.finishedAt,
        artifactIds: [],
        qualityGateResults: [],
        error: "8 个镜头的候选集合为空，需要回到素材来源补充候选。",
      }],
      artifacts: [],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(failedRun), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");

    assert.match(draft?.input.rework?.rejectionReason ?? "", /8 个镜头的候选集合为空/);
    assert.match(draft?.input.rework?.nodeInstructions.visualDirection ?? "", /8 个镜头的候选集合为空/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /8 个镜头的候选集合为空/);
    assert.doesNotMatch(draft?.input.rework?.rejectionReason ?? "", /候选画面复核没有完成候选画面排序/);
  });

  it("persists the exact failed asset scene instead of expanding a partial generation failure to the whole film", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-asset-failure-scope-"));
    const jobsPath = path.join(workspaceRoot, "runs", "run-1", "nodes", "assets", "attempt-1", "generation_jobs.json");
    const jobsDocument = {
      version: "video-factory/generation-jobs-v1",
      jobs: [
        { scenePosition: 1, providerId: "seedream-image-v1", status: "succeeded" },
        { scenePosition: 2, providerId: "seedream-image-v1", status: "succeeded" },
        { scenePosition: 3, providerId: "seedream-image-v1", status: "failed", error: "provider rejected" },
      ],
    };
    await mkdir(path.dirname(jobsPath), { recursive: true });
    const jobsContent = `${JSON.stringify(jobsDocument)}\n`;
    await writeFile(jobsPath, jobsContent, "utf8");
    const base = waitingRun(workspaceRoot);
    const failedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "failed",
      revision: 8,
      decisions: [],
      interventions: [],
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        startedAt: base.startedAt,
        finishedAt: base.finishedAt,
        artifactIds: ["artifact-generation-jobs"],
        qualityGateResults: [],
        error: "Scene 3 generation failed: provider rejected",
      }],
      artifacts: [{
        id: "artifact-generation-jobs",
        kind: "generation_jobs",
        uri: jobsPath,
        createdAt: base.startedAt,
        contentType: "application/json",
        ...fileIntegrity(jobsContent),
        producer: { nodeId: "assets", attempt: 1 },
        provenance: { providerId: "ai-shot-router-v1" },
      }],
    };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(failedRun), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");

    assert.deepEqual(draft?.input.rework?.affectedScenePositions, [3]);
    assert.deepEqual(draft?.requiredAffectedScenePositions, [3]);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /镜头 3 属于本轮影响范围/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /只有确认需要新画面时才进入报价/);
    assert.doesNotMatch(draft?.input.rework?.nodeInstructions.assets ?? "", /只替换本次重做原因涉及的素材/);

    const tampered = structuredClone(draft!.input);
    tampered.providers.script = "codex-screenwriter-v1";
    tampered.rework!.affectedScenePositions = [2];
    await assert.rejects(() => service.startRun(tampered), /返工范围不能移除审片问题或未物化镜头/);
  });

  it("requires every unmaterialized scene after generation stops at the first failure", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-unmaterialized-asset-scope-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-1");
    const scriptPath = path.join(runRoot, "nodes", "script", "attempt-1", "script.json");
    const storyboardPath = path.join(runRoot, "nodes", "visual-direction", "attempt-1", "storyboard.json");
    const assetPlanPath = path.join(runRoot, "nodes", "assets", "attempt-1", "asset_plan.json");
    const jobsPath = path.join(runRoot, "nodes", "assets", "attempt-1", "generation_jobs.json");
    const positions = [1, 2, 3, 4];
    const scriptDocument = { scenes: positions.map((position) => ({ position })) };
    const storyboardDocument = { shots: positions.map((scenePosition) => ({
      scenePosition,
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
    })) };
    const assetPlanDocument = {
      scene_assets: positions.map((scene_position) => ({
        scene_position,
        provider: "seedream-image-v1",
        local_path: "",
      })),
    };
    const jobsDocument = {
      version: "video-factory/generation-jobs-v1",
      jobs: [{
        scenePosition: 1,
        providerId: "seedream-image-v1",
        status: "failed",
        error: "provider rejected",
      }],
    };
    await Promise.all([
      mkdir(path.dirname(scriptPath), { recursive: true }),
      mkdir(path.dirname(storyboardPath), { recursive: true }),
      mkdir(path.dirname(assetPlanPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(scriptPath, `${JSON.stringify(scriptDocument)}\n`, "utf8"),
      writeFile(storyboardPath, `${JSON.stringify(storyboardDocument)}\n`, "utf8"),
      writeFile(assetPlanPath, `${JSON.stringify(assetPlanDocument)}\n`, "utf8"),
      writeFile(jobsPath, `${JSON.stringify(jobsDocument)}\n`, "utf8"),
    ]);
    const base = waitingRun(workspaceRoot);
    const failedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "failed",
      revision: 9,
      decisions: [],
      interventions: [],
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
          nodeId: "assets",
          status: "failed",
          startedAt: base.startedAt,
          finishedAt: base.finishedAt,
          artifactIds: ["artifact-asset-plan", "artifact-generation-jobs"],
          qualityGateResults: [],
          error: "Scene 1 generation failed: provider rejected",
        },
      ],
      artifacts: [
        {
          id: "artifact-script",
          kind: "script",
          uri: scriptPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          ...fileIntegrity(`${JSON.stringify(scriptDocument)}\n`),
          producer: { nodeId: "script", attempt: 1 },
          provenance: { providerId: "codex-screenwriter-v1" },
        },
        {
          id: "artifact-storyboard",
          kind: "storyboard",
          uri: storyboardPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          ...fileIntegrity(`${JSON.stringify(storyboardDocument)}\n`),
          producer: { nodeId: "visual-direction", attempt: 1 },
          provenance: { providerId: "api-visual-director-v1" },
        },
        {
          id: "artifact-asset-plan",
          kind: "asset_plan",
          uri: assetPlanPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          ...fileIntegrity(`${JSON.stringify(assetPlanDocument)}\n`),
          producer: { nodeId: "assets", attempt: 1 },
          provenance: { providerId: "ai-shot-router-v1" },
        },
        {
          id: "artifact-generation-jobs",
          kind: "generation_jobs",
          uri: jobsPath,
          createdAt: base.startedAt,
          contentType: "application/json",
          ...fileIntegrity(`${JSON.stringify(jobsDocument)}\n`),
          producer: { nodeId: "assets", attempt: 1 },
          provenance: { providerId: "ai-shot-router-v1" },
        },
      ],
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(failedRun),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const draft = await service.reworkDraft("run-1");

    assert.deepEqual(draft?.requiredAffectedScenePositions, positions);
    assert.deepEqual(draft?.input.rework?.affectedScenePositions, positions);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /镜头 1、2、3、4 属于本轮影响范围/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /只有确认需要新画面时才进入报价/);

    const jobsOnlyRun: WorkflowRun<ProductionBrief> = {
      ...failedRun,
      nodeRuns: failedRun.nodeRuns.map((node) => node.nodeId === "assets"
        ? { ...node, artifactIds: ["artifact-generation-jobs"] }
        : node),
      artifacts: failedRun.artifacts.filter((artifact) => artifact.id !== "artifact-asset-plan"),
    };
    const jobsOnlyDraft = await new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(jobsOnlyRun),
      commandAvailable: allCommandsAvailable,
      environment: {},
    }).reworkDraft("run-1");
    assert.deepEqual(jobsOnlyDraft?.requiredAffectedScenePositions, positions);

    const beforeMediaRun: WorkflowRun<ProductionBrief> = {
      ...failedRun,
      nodeRuns: [
        ...failedRun.nodeRuns.filter((node) => node.nodeId !== "assets"),
        { nodeId: "asset-semantic-rank", status: "failed", artifactIds: [], qualityGateResults: [],
          error: "候选素材尚未准备完成。" },
      ],
      artifacts: failedRun.artifacts.filter((artifact) => artifact.producer?.nodeId !== "assets"),
    };
    const beforeMediaDraft = await new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(beforeMediaRun),
      commandAvailable: allCommandsAvailable,
      environment: {},
    }).reworkDraft("run-1");
    assert.deepEqual(beforeMediaDraft?.requiredAffectedScenePositions, positions,
      "没有媒体任务时，返工范围仍来自已确认的脚本与分镜，不能默认为空");

    const resumedPipeline = new FakePipeline(failedRun);
    resumedPipeline.inspectPaidNode = async (_runId: string, nodeId: string) => ({
      nodeId,
      operationId: "paid-operation-1",
      recommendedOutcome: "resume_original",
      requiresManualReconciliation: false,
      items: [1, 2, 4].map((scenePosition) => ({
        operationId: "paid-operation-1",
        itemRequestId: `paid-item-${scenePosition}`,
        quoteItemId: `scene-${scenePosition}`,
        scenePosition,
        executorProviderId: "ai-shot-router-v1",
        providerId: "seedream-image-v1",
        modelId: "seedream-4-5",
        state: "materialized" as const,
        estimatedCostCny: 1,
      })),
    });
    const resumedDraft = await new StudioService({
      workspaceRoot,
      pipeline: resumedPipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
    }).reworkDraft("run-1");
    assert.deepEqual(resumedDraft?.requiredAffectedScenePositions, [3]);
    assert.deepEqual(resumedDraft?.input.rework?.affectedScenePositions, [3]);

    const tampered = structuredClone(draft!.input);
    tampered.providers.script = "codex-screenwriter-v1";
    tampered.rework!.affectedScenePositions = [1];
    await assert.rejects(() => service.startRun(tampered), /返工范围不能移除审片问题或未物化镜头/);
  });

  for (const pilotReview of ["rejected", "unavailable"] as const) {
    it(`does not classify a materialized ${pilotReview} pilot as missing paid media`, async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), `video-factory-materialized-${pilotReview}-pilot-`));
      const runRoot = path.join(workspaceRoot, "runs", "run-1");
      const assetPlanPath = path.join(runRoot, "nodes", "assets", "attempt-1", "asset_plan.json");
      const jobsPath = path.join(runRoot, "nodes", "assets", "attempt-1", "generation_jobs.json");
      const pilotPath = path.join(runRoot, "nodes", "assets", "attempt-1", "scene-1.mp4");
      const assetPlanDocument = {
        scene_assets: [{ scene_position: 1, provider: "seedance-video-v1", local_path: pilotPath }],
      };
      const jobsDocument = {
        version: "video-factory/generation-jobs-v1",
        jobs: [{
          scenePosition: 1,
          providerId: "seedance-video-v1",
          status: "failed",
          pilotReview,
          error: pilotReview === "rejected" ? "试片未通过" : "审片服务暂时不可用",
        }],
      };
      await mkdir(path.dirname(assetPlanPath), { recursive: true });
      await Promise.all([
        writeFile(assetPlanPath, `${JSON.stringify(assetPlanDocument)}\n`, "utf8"),
        writeFile(jobsPath, `${JSON.stringify(jobsDocument)}\n`, "utf8"),
        writeFile(pilotPath, "materialized-pilot", "utf8"),
      ]);
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
          artifactIds: ["artifact-asset-plan", "artifact-generation-jobs"],
          qualityGateResults: [],
          error: pilotReview === "rejected" ? "试片未通过" : "审片服务暂时不可用",
        }],
        artifacts: [
          {
            id: "artifact-asset-plan",
            kind: "asset_plan",
            uri: assetPlanPath,
            createdAt: base.startedAt,
            contentType: "application/json",
            ...fileIntegrity(`${JSON.stringify(assetPlanDocument)}\n`),
            producer: { nodeId: "assets", attempt: 1 },
            provenance: { providerId: "ai-shot-router-v1" },
          },
          {
            id: "artifact-generation-jobs",
            kind: "generation_jobs",
            uri: jobsPath,
            createdAt: base.startedAt,
            contentType: "application/json",
            ...fileIntegrity(`${JSON.stringify(jobsDocument)}\n`),
            producer: { nodeId: "assets", attempt: 1 },
            provenance: { providerId: "ai-shot-router-v1" },
          },
        ],
      };
      const service = new StudioService({
        workspaceRoot,
        pipeline: new FakePipeline(failedRun),
        commandAvailable: allCommandsAvailable,
        environment: {},
      });

      const draft = await service.reworkDraft("run-1");

      assert.deepEqual(draft?.requiredAffectedScenePositions, []);
      assert.deepEqual(draft?.input.rework?.affectedScenePositions, []);
      assert.doesNotMatch(draft?.input.rework?.nodeInstructions.assets ?? "", /只重新生成镜头 1/);
    });
  }

  it("rejects a direct rework start while the source has an uncertain paid outcome", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-uncertain-rework-start-"));
    const source = waitingRun(workspaceRoot);
    source.status = "failed";
    source.nodeRuns[0] = {
      ...source.nodeRuns[0]!,
      status: "failed",
      outcomeUncertain: true,
    };
    const pipeline = new FakePipeline(source);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, script: "codex-screenwriter-v1" },
      rework: {
        sourceRunId: "run-1",
        sourceRunRevision: source.revision,
        nodeInstructions: {
          script: "按原审片意见调整脚本。",
          visualDirection: "按原审片意见调整导演方案。",
          assets: "按原审片意见重做素材。",
        },
        findings: [],
      },
    }), /付费结果尚未核对/);
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("creates a new-version draft from an approved production", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-approved-new-version-"));
    const completed = { ...waitingRun(workspaceRoot), status: "succeeded" as const, revision: 6 };
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(completed), commandAvailable: allCommandsAvailable, environment: {} });

    const draft = await service.reworkDraft("run-1");

    assert.equal(draft?.input.rework?.sourceRunRevision, 6);
    assert.equal(draft?.input.title, brief.title);
    assert.deepEqual(draft?.input.rework?.findings, []);
    assert.deepEqual(draft?.input.durationRange, { minSeconds: 20, maxSeconds: 34 });
    assert.equal(draft?.input.workflowFeatures?.executablePlan, true);
    assert.deepEqual(draft?.input.director, { profileId: "auto", assetProviderIds: ["local-editorial-v1"] });
  });

  it("rejects every incomplete executable-plan shape at the new production boundary", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-executable-start-boundary-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const production = new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive", "runs.json")),
      listProviders: async () => [],
    });
    const director = { profileId: "auto", assetProviderIds: ["local-editorial-v1"] } as const;
    const providers = { ...brief.providers, director: "api-visual-director-v1" };

    await assert.rejects(
      () => production.start({ ...brief, runPurpose: "production", durationRange: { minSeconds: 20, maxSeconds: 34 }, providers, director, workflowFeatures: undefined }),
      /可执行制作方案|executablePlan/,
    );
    await assert.rejects(
      () => production.start({ ...brief, runPurpose: "production", durationRange: { minSeconds: 20, maxSeconds: 34 }, providers, director, workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1" } }),
      /节点边界|boundaryGates/,
    );
    await assert.rejects(
      () => production.start({ ...brief, runPurpose: "production", durationRange: undefined, providers, director, workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1", boundaryGates: "user-confirmed-v1" } }),
      /时长范围|durationRange/,
    );
    await assert.rejects(
      () => production.start({ ...brief, runPurpose: "production", durationRange: { minSeconds: 20, maxSeconds: 34 }, director: undefined, workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1", boundaryGates: "user-confirmed-v1" } }),
      /导演|director/,
    );
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("keeps legacy runs readable but refuses to mutate their old timeline", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-legacy-continuation-boundary-"));
    const run = waitingRun(workspaceRoot);
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const detail = await service.getRun(run.id);
    assert.equal(detail?.id, run.id);
    assert.equal(detail?.continuation.supported, false);

    await assert.rejects(() => service.decide(run.id, {
      action: "approve",
      expectedRunRevision: run.revision,
      interventionId: "intervention-1",
      reviewEvidenceId: null,
    }, "studio-owner"), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastDecision, undefined);

    await assert.rejects(() => service.requestSceneRevision(run.id, {
      expectedRunRevision: run.revision,
      expectedAssetVersionId: "assets-v1",
      reviewArtifactId: "review-1",
      findingIndex: 0,
      reuseFromScenePosition: 1,
      note: "旧流程不能返修。",
    }, "studio-owner"), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastSceneRevision, undefined);

    await assert.rejects(() => service.reinspectVisualReview(run.id, {
      expectedRunRevision: run.revision,
      reviewEvidenceId: "review-1",
    }), /创建新版本|可执行制作方案/);

    await assert.rejects(
      () => service.applyNodeOverride(run.id, "render", { output: {} }, "studio-owner"),
      /创建新版本|可执行制作方案/,
    );
    assert.equal(pipeline.lastOverride, undefined);

    await assert.rejects(
      () => service.applyNodeInputOverride(run.id, "render", { input: {} }, "studio-owner"),
      /创建新版本|可执行制作方案/,
    );
    assert.equal(pipeline.lastInputOverride, undefined);

    await assert.rejects(
      () => service.applyNodeExecutionConfiguration(run.id, "render", {}, "studio-owner"),
      /创建新版本|可执行制作方案/,
    );
    assert.equal(pipeline.lastExecutionConfigurationNodeId, undefined);

    await assert.rejects(() => service.authorizeSpend(run.id, "assets", {
      spendPlanId: "legacy-plan",
      inputVersionIds: [],
      providerId: "legacy-provider",
      modelId: "legacy-model",
      maxCostCny: 0,
      maxAttempts: 1,
    }, "studio-owner"), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastAuthorization, undefined);

    await assert.rejects(() => service.rejectSpend(run.id, "assets", {
      spendPlanId: "legacy-plan",
      reason: "plan_not_approved",
    }, "studio-owner"), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastSpendRejection, undefined);

    pipeline.run = { ...run, status: "paused" };
    await assert.rejects(() => service.resumePaused(run.id), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.run.status, "paused");

    pipeline.run = { ...run, status: "stale" };
    await assert.rejects(() => service.resumeStale(run.id), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.run.status, "stale");

    pipeline.run = {
      ...run,
      status: "failed",
      nodeRuns: run.nodeRuns.map((node, index) => index === 0 ? { ...node, status: "failed" as const, error: "旧流程失败" } : node),
    };
    await assert.rejects(() => service.retryFailedNode(run.id, run.nodeRuns[0]!.nodeId), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastRetriedNodeId, undefined);

    pipeline.run = { ...run, status: "running" };
    await service.requestPause(run.id);
    assert.equal(pipeline.pauseRequestedValue, true);
  });

  it("rejects executable fields when the persisted workflow version is incompatible", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-incompatible-continuation-"));
    const run = { ...executableWaitingRun(workspaceRoot), workflowVersion: "1.0.0" };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    assert.equal((await service.getRun(run.id))?.continuation.supported, false);
    await assert.rejects(() => service.decide(run.id, {
      action: "approve",
      expectedRunRevision: run.revision,
      interventionId: "intervention-1",
      reviewEvidenceId: null,
    }, "studio-owner"), /创建新版本|可执行制作方案/);
    assert.equal(pipeline.lastDecision, undefined);
  });

  it("prefills a rejected visual resource and its scene in a new-version draft", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-rework-"));
    const manifestPath = path.join(workspaceRoot, "runs", "run-1", "resource_manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{ id: "scene:3:stock", category: "visual", kind: "stock_video", providerId: "pexels-stock-v1", creator: "第三镜素材", scenePosition: 3, commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }],
    }));
    const completed = { ...waitingRun(workspaceRoot), status: "succeeded" as const, revision: 6 };
    completed.artifacts = [...completed.artifacts, {
      id: "resource-manifest",
      kind: "resource_manifest",
      uri: manifestPath,
      createdAt: "2026-09-05T00:00:00.000Z",
      contentType: "application/json",
      producer: { nodeId: "publish-package", attempt: 1 },
      provenance: { providerId: "python-ffmpeg-v1" },
    }];
    const pipeline = new FakePipeline(completed);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    await service.reviewResource({ runId: "run-1", itemId: "scene:3:stock", expectedRevision: 0, action: "rejected", note: "来源页面未证明可商用" });

    const draft = await service.reworkDraft("run-1");

    assert.equal(pipeline.maintenanceLeaseCalls.some((runIds) => runIds.includes("run-1")), true);
    assert.equal(draft?.input.rework?.findings[0]?.scenePosition, 3);
    assert.equal(draft?.input.rework?.findings[0]?.category, "resource_rights");
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /来源页面未证明可商用/);
    assert.match(draft?.input.rework?.nodeInstructions.assets ?? "", /镜头 3/);
  });

  it("keeps a historical template snapshot readable but strips it from a new rework", async () => {
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
        { id: "codex-screenwriter-v1", capability: "script.draft", label: "AI 编剧", available: true, kind: "external" },
        { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external" },
        { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
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
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot, undefined);
  });

  it("requires an explicit unreviewed-first-cut decision when visual review is unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-dual-review-readiness-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const baseProviders = [
      { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" as const },
      { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external" as const },
      { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" as const },
      { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑画面", available: true, kind: "local" as const, deliveryTypes: ["editorial_card" as const] },
      { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" as const },
      { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" as const },
      { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" as const },
      { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 审片", available: true, kind: "external" as const, defaultModelId: "deepseek-flash" },
    ];
    const productionBrief: ProductionBrief = {
      ...brief,
      runPurpose: "production",
      providers: { ...brief.providers, visualReview: "deepseek-visual-review-v1" },
    };
    const studio = (extraProviders: StudioProvider[] = []) => new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive", "runs.json")),
      listProviders: async () => [...baseProviders, ...extraProviders],
    });

    const { visualReview: _visualReview, ...providersWithoutReview } = productionBrief.providers;
    await assert.rejects(() => studio().start({
      ...productionBrief,
      providers: providersWithoutReview,
    }), /视觉审片当前不可用/);

    await studio().start({
      ...productionBrief,
      providers: providersWithoutReview,
      visualReviewPolicy: "allow_unreviewed_first_cut",
    });
    assert.equal(pipeline.dispatchCount, 1);
    assert.equal((pipeline.lastInput as ProductionBrief).visualReviewPolicy, "allow_unreviewed_first_cut");
  });

  it("allows an executable generation source to adapt a template's suggested stock slot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-template-source-preflight-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const production = new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive", "runs.json")),
      listProviders: async () => [
        { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
        { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external" },
        { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
        { id: "seedance-video-v1", capability: "asset.prepare", label: "Seedance 视频生成", available: true, kind: "external", billing: "metered", estimatedCnyPerClip: 3.5, deliveryTypes: ["generated_video"] },
        { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
        { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" },
        { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" },
        { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 审片", available: true, kind: "external", billing: "subscription", defaultModelId: "deepseek-flash" },
        { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 审片", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
        { id: "codex-role-auditor-v1", capability: "role.audit", label: "独立质量复核", available: true, kind: "external", billing: "subscription" },
      ],
      resolveTemplateSnapshot: async () => ({
        templateId: "source-required",
        templateVersion: 1,
        resolvedAt: "2026-09-09T00:00:00.000Z",
        resolvedBlueprint: {
          platform: "douyin",
          durationSeconds: 24,
          automationLevel: "assisted",
          storyStructure: [{ id: "evidence", label: "证据", purpose: "展示真实来源", required: true }],
          shotSlots: [{ id: "evidence-shot", beatId: "evidence", purpose: "展示真实来源", durationSeconds: 24, allowedCapabilities: ["asset.search"], manualReplacement: true }],
          visualSystem: { composition: "来源画面", colorIntent: "自然", subtitleDensity: "low", pacing: "measured" },
          soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
          qualityRules: [{ id: "source", label: "真实来源", dimension: "factual", required: true, threshold: 95 }],
          capabilityRequirements: [{ capability: "asset.prepare", required: true }],
        },
        sourceLayers: [{ layer: "template", sourceId: "source-required@1", appliedFields: ["shotSlots"] }],
        fieldSources: {},
      }),
    });

    await production.start({
      ...brief,
      runPurpose: "production",
      providers: {
        script: "python-template-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
        visualReview: "deepseek-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
    });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("rejects a direct production request with no executable visual delivery type even without a template snapshot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-no-visual-source-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const production = new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive", "runs.json")),
      listProviders: async () => [
        { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
        { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external" },
        { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
        { id: "opaque-asset-v1", capability: "asset.prepare", label: "未声明交付类型的来源", available: true, kind: "external", deliveryTypes: [] },
        { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
        { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" },
        { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" },
        { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 审片", available: true, kind: "external", defaultModelId: "deepseek-flash" },
        { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 审片", available: true, kind: "external", defaultModelId: "gpt-5.6-sol" },
        { id: "codex-role-auditor-v1", capability: "role.audit", label: "独立质量复核", available: true, kind: "external" },
      ],
    });

    await assert.rejects(
      () => production.start({
        ...brief,
        runPurpose: "production",
        providers: { ...brief.providers, visualReview: "deepseek-visual-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["opaque-asset-v1"] },
      }),
      /当前素材池没有任何可用画面来源/,
    );
    assert.equal(pipeline.dispatchCount, 0, "the server boundary must stop before dispatch even when the client is bypassed");
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
      recoveryOwner: { runId: "run-1", nodeId: "script", workflowOperationRequestId: "operation-progress-v3" },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-1", "script", "operation-progress-v3"), {
      iteration: 2,
      maxIterations: 3,
      completedIterations: 1,
      producerModelCallCount: 2,
      auditModelCallCount: 1,
      structuredRepairModelCallCount: 0,
      phase: "auditing",
      latestAudit: { verdict: "repair", score: 68, summary: "开场钩子仍需具体。" },
    });
  });

  it("labels a supplementary ranking batch and retains primary model counts without exposing its snapshot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-supplement-progress-"));
    try {
      const directory = path.join(workspaceRoot, "runs/run-1/nodes/creative-planning/agent-loop-checkpoints");
      await mkdir(directory, { recursive: true });
      const primaryCheckpoint = { version: "video-factory/agent-loop-checkpoint-v9", maxIterations: 3,
        status: "passed", phaseAttempts: { produce: 1, audit: 1 }, completed: [{ iteration: 1 }] };
      await writeFile(path.join(directory, "rank.json"), JSON.stringify({
        version: "video-factory/agent-loop-checkpoint-v9", maxIterations: 3, role: "候选画面复核", status: "running",
        phaseAttempts: { produce: 1, audit: 1 }, completed: [], pendingCandidate: { iteration: 1 },
        recoveryOwner: { runId: "run-1", nodeId: "creative-planning", workflowOperationRequestId: "operation-1" },
        assetRankBatch: { version: "asset-rank-batches-v1", phase: "supplement", primaryCheckpoint, payload: { secretPrompt: "不公开快照" } },
      }));
      const progress = await loadAgentLoopProgress(workspaceRoot, "run-1", "creative-planning", "operation-1");
      assert.equal(progress?.producerModelCallCount, 2);
      assert.equal(progress?.auditModelCallCount, 2);
      assert.match(progress?.role ?? "", /补看候选，最多一批/);
      assert.doesNotMatch(JSON.stringify(progress), /不公开快照|secretPrompt/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("shows a handover to the user as its own phase instead of dropping the checkpoint", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-awaiting-user-progress-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "handover.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v9",
      maxIterations: 3,
      status: "awaiting_user",
      completed: [1, 2, 3].map((iteration) => ({
        iteration,
        audit: {
          verdict: "repair",
          score: 60 + iteration,
          summary: `第 ${iteration} 版仍未兑现开场承诺。`,
        },
      })),
      recoveryOwner: { runId: "run-1", nodeId: "script", workflowOperationRequestId: "operation-awaiting-user" },
    }), "utf8");

    // 三轮自动重做都没过审计不是作品失败：这一版和审计意见都停在用户面前，界面必须看得见它，
    // 否则用户只会看到一个"成功了"的节点，而那句"要改哪里"就此消失。
    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-1", "script", "operation-awaiting-user"), {
      iteration: 3,
      maxIterations: 3,
      completedIterations: 3,
      producerModelCallCount: 3,
      auditModelCallCount: 3,
      structuredRepairModelCallCount: 0,
      phase: "awaiting_user",
      latestAudit: { verdict: "repair", score: 63, summary: "第 3 版仍未兑现开场承诺。" },
    });
  });

  it("keeps the audit advice visible after a model fallback leaves two stopped checkpoints", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-fallback-progress-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "brief", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    const recoveryOwner = { runId: "run-1", nodeId: "brief", workflowOperationRequestId: "operation-brief" };
    const failedPath = path.join(directory, "preferred-model.json");
    await writeFile(failedPath, JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v9",
      maxIterations: 1,
      status: "failed",
      completed: [],
      recoveryOwner,
    }), "utf8");
    const fallbackPath = path.join(directory, "fallback-model.json");
    await writeFile(fallbackPath, JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v9",
      maxIterations: 1,
      status: "awaiting_user",
      completed: [{
        iteration: 1,
        audit: { verdict: "repair", score: 71, summary: "受众与平台对不上。" },
      }],
      recoveryOwner,
    }), "utf8");
    // 首选模型失败、兜底接上：两份都属于同一次节点执行，只有写入时间能分出哪份是当下。
    await utimes(failedPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await utimes(fallbackPath, new Date(1_700_000_060_000), new Date(1_700_000_060_000));

    // 首选模型额度耗尽是最常见的一种兜底。两份都"已停下"时若一律返回 undefined，
    // "要改哪里"会正好在用户拿主意的一刻消失，只剩一个停在边界上、没有任何理由的节点。
    const progress = await loadAgentLoopProgress(workspaceRoot, "run-1", "brief", "operation-brief");

    assert.equal(progress?.phase, "awaiting_user");
    assert.deepEqual(progress?.latestAudit, { verdict: "repair", score: 71, summary: "受众与平台对不上。" });
  });

  it("carries the recorded failure reason out of a stopped checkpoint", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-failed-reason-progress-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "brief", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "stopped.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v9",
      maxIterations: 1,
      status: "failed",
      completed: [],
      failure: {
        stage: "uncertain",
        failureKind: "model_provider_no_output",
        details: { category: "network", reasonCode: "connection_failed" },
        summary: "与模型服务的连接中断，结果未知：这次请求可能已经被模型受理。当前进度已保留，请先核对原有任务的结果，不要重新发起同样的请求。",
      },
      recoveryOwner: { runId: "run-1", nodeId: "brief", workflowOperationRequestId: "operation-brief-stopped" },
    }), "utf8");

    // 审计三次全挂之后节点照样往下走，界面上只剩「模型调用已停止，请查看失败原因」，
    // 而那句"失败原因"过去没有任何字段装得下——原因齐备地落在磁盘上，用户端一个字都没有。
    const progress = await loadAgentLoopProgress(workspaceRoot, "run-1", "brief", "operation-brief-stopped");

    assert.equal(progress?.phase, "failed");
    assert.equal(progress?.latestAudit, undefined);
    assert.match(progress?.failureSummary ?? "", /连接中断/);
  });

  it("does not expose an active agent-loop checkpoint after its node has failed", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-failed-agent-progress-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "progress.json"), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v6",
      maxIterations: 3,
      status: "running",
      completed: [],
    }), "utf8");
    const run = waitingRun(workspaceRoot);
    run.status = "failed";
    run.nodeRuns.push({
      nodeId: "script",
      status: "failed",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      artifactIds: [],
      qualityGateResults: [],
      error: "模型服务失败",
    });
    const service = new StudioService({ workspaceRoot, pipeline: new FakePipeline(run), commandAvailable: allCommandsAvailable, environment: {} });

    const detail = await service.getRun("run-1");

    assert.equal(detail?.nodes.find((node) => node.id === "script")?.agentLoopProgress, undefined);
  });

  it("projects a pending v8 text task without exposing its envelope and blocks ordinary retry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-recovery-"));
    const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", "script", "agent-loop-checkpoints");
    const checkpointKey = "d".repeat(64);
    const workflowOperationRequestId = "script-workflow-operation-current";
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${checkpointKey}.json`), JSON.stringify({
      version: "video-factory/agent-loop-checkpoint-v8",
      key: checkpointKey,
      contractDigest: "fixture-contract",
      role: "编剧",
      maxIterations: 3,
      cycle: 0,
      status: "failed",
      completed: [],
      recoveryOwner: { runId: "run-1", nodeId: "script", workflowOperationRequestId },
      pendingOperation: {
        phase: "produce",
        iteration: 1,
        operationKey: "0:1:produce",
        generation: 0,
        operation: {
          version: "video-factory/codex-prepared-operation-v1",
          requestId: "private-request-id",
          kind: "script-draft",
          envelope: { prompt: "private prompt" },
          serializedEnvelope: "{\"prompt\":\"private prompt\"}",
          binding: {
            version: "video-factory/task-binding-v1",
            storeId: `vfs_store_${"b".repeat(32)}`,
            providerId: "openai",
            modelId: "gpt-test",
            requestDigest: "a".repeat(64),
            kind: "script-draft",
            contractDigest: null,
            sessionDigest: "c".repeat(64),
          },
          brokerBinding: {
            version: "video-factory/task-binding-v1",
            storeId: `vfs_store_${"b".repeat(32)}`,
            providerId: "openai",
            modelId: "gpt-test",
          },
          route: { socketPath: "/private/runtime/worker.sock" },
          taskFact: "accepted_unknown",
        },
      },
    }), "utf8");
    const run = waitingRun(workspaceRoot);
    run.status = "failed";
    run.nodeRuns.push({
      nodeId: "script",
      status: "failed",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      operationRequestId: workflowOperationRequestId,
      artifactIds: [],
      qualityGateResults: [],
      error: "模型任务结果未知",
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const detail = await service.getRun("run-1");

    assert.deepEqual(detail?.taskRecovery, {
      nodeId: "script",
      phase: "produce",
      taskState: "accepted_unknown",
      summary: "暂时无法确认这次任务的结果。系统没有重新提交，请先查询原任务。",
      resultAvailable: false,
      allowedActions: ["query_original_task"],
    });
    assert.doesNotMatch(JSON.stringify(detail), /private-request-id|private prompt|worker\.sock/);
    await assert.rejects(() => service.retryFailedNode("run-1", "script"), /请先查询原任务/);
    assert.equal(pipeline.lastRetriedNodeId, undefined);
    const checkpointPath = path.join(directory, `${checkpointKey}.json`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.status = "running";
    checkpoint.pendingOperation.operation.taskFact = "not_submitted";
    await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf8");
    pipeline.run.status = "running";
    pipeline.run.nodeRuns.at(-1)!.status = "running";
    assert.equal((await service.getRun("run-1"))?.taskRecovery, undefined,
      "normal in-flight execution without an observation failure is not a recovery incident");
  });

  it("still finds the stuck task when an earlier node left a settled checkpoint behind", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-settled-checkpoint-"));
    const run = textRecoveryRun(workspaceRoot, "failed");
    // brief 节点那次审计中断过（stage=uncertain），之后它被人工放行、照样成功了。checkpoint 是只增不减的
    // 对账凭据，谁也不去收尾，于是它永远留在候选里，跟着 run 一起变老。
    run.nodeRuns.push({
      nodeId: "brief",
      status: "succeeded",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      operationRequestId: "brief-workflow-operation-old",
      artifactIds: [],
      qualityGateResults: [],
    });
    await writePendingTextCheckpoint(workspaceRoot, scriptDraftOperation("stuck-request-id"), {
      checkpointKey: "e".repeat(64),
    });
    await writePendingTextCheckpoint(workspaceRoot, roleAuditOperation("settled-request-id"), {
      nodeId: "brief",
      checkpointKey: "f".repeat(64),
      role: "内容简报",
      phase: "audit",
      workflowOperationRequestId: "brief-workflow-operation-old",
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const detail = await service.getRun("run-1");

    // 旧规则要求"全 run 恰好只有一个未决任务"，于是这份历史记录让恢复路径整体失明：
    // 用户既看不到"查询原任务"，重试又必然被判 409，run 到死都推不动。
    assert.equal(detail?.taskRecovery?.nodeId, "creative-planning",
      "已走过的节点留下的未决记录只是历史，不能盖过真正卡住的那个任务");
    assert.equal(detail?.nodes.find((node) => node.id === "brief")?.status, "succeeded");
    // 「连续失败时切换同类能力」在这条路径上不成立：结果未知时换模型等于可能重复扣费。
    // 建议必须与上面那排真正给出的按钮一致，否则用户会去找一个点不动的控件。
    assert.deepEqual(detail?.failure?.recoveryActions, ["先查询原任务，确认它是否已被受理、是否已经扣费"]);
    assert.deepEqual(detail?.taskRecovery?.allowedActions, ["query_original_task"]);
  });

  it("does not project a recovery panel for a checkpoint on an already-succeeded node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-settled-only-"));
    const run = executableWaitingRun(workspaceRoot);
    run.nodeRuns.push({
      nodeId: "brief",
      status: "succeeded",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      operationRequestId: "brief-workflow-operation-old",
      artifactIds: [],
      qualityGateResults: [],
    });
    await writePendingTextCheckpoint(workspaceRoot, roleAuditOperation("settled-request-id"), {
      nodeId: "brief",
      checkpointKey: "f".repeat(64),
      role: "内容简报",
      phase: "audit",
      workflowOperationRequestId: "brief-workflow-operation-old",
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(run),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const detail = await service.getRun("run-1");

    // run 已经走完、节点成功，产出也用上了；这时弹"有未决付费任务"只会让人以为还有事要处理，
    // 而恢复动作又全被 detail.status === "failed" 挡着，一个都点不动。
    assert.equal(detail?.taskRecovery, undefined);
  });

  it("queries and concurrently retrieves one completed original text task without resubmitting it", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-completed-"));
    const bridge = await startTextRecoveryBridge();
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "恢复原脚本" } },
        "studio-recovery-completed",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const staleOperation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "更晚写入但属于旧方案的脚本" } },
        "studio-recovery-stale-mtime",
      );
      await writePendingTextCheckpoint(workspaceRoot, staleOperation, {
        checkpointKey: "e".repeat(64),
        workflowOperationRequestId: "script-workflow-operation-old",
      });
      const checkpointBeforeQuery = JSON.parse(await readFile(path.join(
        workspaceRoot,
        "runs",
        "run-1",
        "nodes",
        "creative-planning",
        "agent-loop-checkpoints",
        `${"d".repeat(64)}.json`,
      ), "utf8")) as Record<string, unknown>;
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      const queried = await service.queryOriginalTextTask("run-1");
      assert.equal(bridge.posts, 0);
      assert.equal(bridge.queries, 1);
      assert.deepEqual(queried.taskRecovery?.allowedActions, ["query_original_task", "retrieve_and_continue"]);
      assert.equal(queried.taskRecovery?.taskState, "completed_success");
      assert.equal(bridge.operation?.requestId, operation.requestId, "newer mtime from an old plan must not replace the current binding");
      const checkpointAfterQuery = JSON.parse(await readFile(path.join(
        workspaceRoot,
        "runs",
        "run-1",
        "nodes",
        "creative-planning",
        "agent-loop-checkpoints",
        `${"d".repeat(64)}.json`,
      ), "utf8")) as Record<string, unknown>;
      assert.deepEqual(checkpointAfterQuery.operationGenerations, checkpointBeforeQuery.operationGenerations);
      assert.deepEqual(checkpointAfterQuery.phaseAttempts, checkpointBeforeQuery.phaseAttempts);
      const rebuiltService = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
      assert.equal((await rebuiltService.getRun("run-1"))?.taskRecovery?.taskState, "completed_success");

      const [first, second] = await Promise.all([
        service.retrieveOriginalTextTask("run-1"),
        service.retrieveOriginalTextTask("run-1"),
      ]);
      assert.equal(first.status, "running");
      assert.equal(second.status, "running");
      assert.equal(pipeline.retryDispatchCount, 1);
      assert.equal(pipeline.lastRetriedNodeId, "creative-planning");
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("queries an original result while paused without unpausing or allowing retrieval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-paused-"));
    const bridge = await startTextRecoveryBridge();
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "暂停中的恢复" } },
        "studio-recovery-paused",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "paused"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      const queried = await service.queryOriginalTextTask("run-1");
      assert.equal(queried.status, "paused");
      assert.deepEqual(queried.taskRecovery?.allowedActions, ["query_original_task"]);
      assert.match(queried.taskRecovery?.summary ?? "", /不会解除暂停/);
      await assert.rejects(() => service.retrieveOriginalTextTask("run-1"), /先显式继续自动制作/);
      assert.equal(pipeline.retryDispatchCount, 0);
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not attach a late original-task observation after the run revision changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-stale-observation-"));
    let pipeline!: FakePipeline;
    const bridge = await startTextRecoveryBridge(() => {
      pipeline.run = { ...pipeline.run, revision: pipeline.run.revision + 1 };
    });
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "旧版本恢复" } },
        "studio-recovery-stale",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      await assert.rejects(() => service.queryOriginalTextTask("run-1"), /制作方案已更新/);
      await assert.rejects(
        () => readFile(path.join(workspaceRoot, "runs", "run-1", "nodes", "creative-planning", "text-task-recovery.json"), "utf8"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT",
      );
      assert.equal(pipeline.retryDispatchCount, 0);
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows an ordinary retry only after the broker proves the original task was not accepted", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-not-accepted-"));
    const bridge = await startTextRecoveryBridge(undefined, "not_accepted");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "未受理恢复" } },
        "studio-recovery-not-accepted",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      const queried = await service.queryOriginalTextTask("run-1");
      assert.equal(queried.taskRecovery?.taskState, "not_accepted");
      assert.deepEqual(queried.taskRecovery?.allowedActions, ["query_original_task", "retry_failed_step"]);
      const retried = await service.retryFailedNode("run-1", "creative-planning");
      assert.equal(retried.status, "running");
      assert.equal(pipeline.retryDispatchCount, 1);
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not project a known failed not-submitted operation as accepted_unknown", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-known-not-submitted-"));
    try {
      const bridge = await startTextRecoveryBridge(undefined, "query_failure");
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "已知未提交的脚本请求" } },
        "studio-recovery-known-not-submitted",
      );
      await bridge.close();
      const notSubmittedOperation = { ...operation, taskFact: "not_submitted" as const };
      await writePendingTextCheckpoint(workspaceRoot, notSubmittedOperation, {
        failedOperationRequestIds: { "0:1:produce": notSubmittedOperation.requestId },
      });
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      const detail = await service.getRun("run-1");
      assert.equal(detail?.taskRecovery, undefined, "a terminal local non-submission is not an original task to observe");
      const retried = await service.retryFailedNode("run-1", "creative-planning");
      assert.equal(retried.status, "running");
      assert.equal(pipeline.retryDispatchCount, 1);
      assert.equal(pipeline.lastRetriedNodeId, "creative-planning");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("opens a real retry path after a verified transient completed failure without reusing the old request", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-terminal-failure-"));
    const bridge = await startTextRecoveryBridge(undefined, "completed_failure");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "终态失败恢复" } },
        "studio-recovery-terminal-failure",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

      const queried = await service.queryOriginalTextTask("run-1");
      assert.equal(queried.taskRecovery?.taskState, "completed_failure");
      assert.deepEqual(queried.taskRecovery?.allowedActions, ["query_original_task", "retry_failed_step", "adjust_plan"]);
      assert.match(queried.taskRecovery?.terminalError ?? "", /暂时不可用|稍后重试/);
      assert.equal(bridge.posts, 0, "querying a terminal result must remain GET-only");

      const retried = await service.retryFailedNode("run-1", "creative-planning");
      assert.equal(retried.status, "running");
      assert.deepEqual(pipeline.lastRetryOptions, {
        recoverOriginalTextTask: true,
        resumeCompletedTextTask: true,
        resumeCompletedTextTaskRequestId: operation.requestId,
      });
      assert.equal(pipeline.retryDispatchCount, 1);
      assert.equal(bridge.posts, 0, "Studio must delegate the explicit recovery to the leased pipeline instead of posting itself");
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps last verified task time separate from a later failed query and survives service rebuild", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-observation-time-"));
    const bridge = await startTextRecoveryBridge(undefined, "running");
    let now = new Date("2026-09-13T01:00:00.000Z");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "查询时间分离" } },
        "studio-recovery-observation-time",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const makeService = () => new StudioService({
        workspaceRoot,
        pipeline,
        commandAvailable: allCommandsAvailable,
        environment: {},
        now: () => now,
      });
      const service = makeService();

      const first = await service.queryOriginalTextTask("run-1");
      assert.equal(first.taskRecovery?.taskState, "running");
      assert.equal(first.taskRecovery?.lastVerifiedAt, "2026-09-13T01:00:00.000Z");
      now = new Date("2026-09-13T01:05:00.000Z");
      bridge.taskState = "query_failure";
      const second = await service.queryOriginalTextTask("run-1");
      assert.equal(second.taskRecovery?.taskState, "running");
      assert.equal(second.taskRecovery?.lastVerifiedAt, "2026-09-13T01:00:00.000Z");
      assert.equal(second.taskRecovery?.lastAttemptAt, "2026-09-13T01:05:00.000Z");
      assert.match(second.taskRecovery?.observationError ?? "", /上一次可信状态已保留/);

      const rebuilt = await makeService().getRun("run-1");
      assert.equal(rebuilt?.taskRecovery?.lastVerifiedAt, "2026-09-13T01:00:00.000Z");
      assert.equal(rebuilt?.taskRecovery?.lastAttemptAt, "2026-09-13T01:05:00.000Z");
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps an initial failed observation unknown instead of inventing a running fact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-first-query-failure-"));
    const bridge = await startTextRecoveryBridge(undefined, "query_failure");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "首次查询失败" } },
        "studio-recovery-first-query-failure",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({
        workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {},
        now: () => new Date("2026-09-13T01:10:00.000Z"),
      });

      const result = await service.queryOriginalTextTask("run-1");
      assert.equal(result.taskRecovery?.taskState, "accepted_unknown");
      assert.equal(result.taskRecovery?.lastVerifiedAt, undefined);
      assert.equal(result.taskRecovery?.lastAttemptAt, "2026-09-13T01:10:00.000Z");
      assert.match(result.taskRecovery?.observationError ?? "", /不会把原任务描述为仍在实时运行/);
      assert.deepEqual(result.taskRecovery?.allowedActions, ["query_original_task"]);
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves a verified completed result when a later query attempt fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-completed-query-failure-"));
    const bridge = await startTextRecoveryBridge(undefined, "completed_success");
    let now = new Date("2026-09-13T01:20:00.000Z");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "完成后查询失败" } },
        "studio-recovery-completed-query-failure",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const service = new StudioService({
        workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {}, now: () => now,
      });

      await service.queryOriginalTextTask("run-1");
      now = new Date("2026-09-13T01:25:00.000Z");
      bridge.taskState = "query_failure";
      const result = await service.queryOriginalTextTask("run-1");
      assert.equal(result.taskRecovery?.taskState, "completed_success");
      assert.equal(result.taskRecovery?.lastVerifiedAt, "2026-09-13T01:20:00.000Z");
      assert.equal(result.taskRecovery?.lastAttemptAt, "2026-09-13T01:25:00.000Z");
      assert.deepEqual(result.taskRecovery?.allowedActions, ["query_original_task", "retrieve_and_continue"]);
      assert.equal(bridge.posts, 0);
    } finally {
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not let a late running response overwrite a terminal observation from another Studio instance", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-text-task-late-running-"));
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let queryCount = 0;
    const bridge = await startTextRecoveryBridge(async () => {
      queryCount += 1;
      if (queryCount === 1) {
        markFirstStarted();
        await firstGate;
      }
    }, "running");
    try {
      const operation = await new CodexBridgeClient({ socketPath: bridge.socketPath }).prepareTask(
        "script-draft",
        { brief: { title: "迟到状态不能回退终态" } },
        "studio-recovery-late-running",
      );
      bridge.operation = operation;
      await writePendingTextCheckpoint(workspaceRoot, operation);
      const pipeline = new FakePipeline(textRecoveryRun(workspaceRoot, "failed"));
      const older = new StudioService({
        workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {},
        now: () => new Date("2026-09-13T02:00:00.000Z"),
      });
      const newer = new StudioService({
        workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {},
        now: () => new Date("2026-09-13T02:01:00.000Z"),
      });

      const lateRunning = older.queryOriginalTextTask("run-1");
      await firstStarted;
      bridge.taskState = "completed_failure";
      const terminal = await newer.queryOriginalTextTask("run-1");
      assert.equal(terminal.taskRecovery?.taskState, "completed_failure");
      releaseFirst();
      const merged = await lateRunning;

      assert.equal(merged.taskRecovery?.taskState, "completed_failure");
      assert.equal(merged.taskRecovery?.lastVerifiedAt, "2026-09-13T02:01:00.000Z");
      assert.deepEqual(merged.taskRecovery?.allowedActions, ["query_original_task", "retry_failed_step", "adjust_plan"]);
      assert.equal(bridge.posts, 0);
    } finally {
      releaseFirst();
      await bridge.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
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
      recoveryOwner: { runId: "run-v4", nodeId: "script", workflowOperationRequestId: "operation-progress-v4" },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-v4", "script", "operation-progress-v4"), {
      iteration: 1,
      maxIterations: 3,
      completedIterations: 0,
      producerModelCallCount: 1,
      auditModelCallCount: 0,
      structuredRepairModelCallCount: 0,
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
      recoveryOwner: { runId: "run-v6", nodeId: "visual-direction", workflowOperationRequestId: "operation-progress-v6" },
    }), "utf8");

    assert.deepEqual(await loadAgentLoopProgress(workspaceRoot, "run-v6", "visual-direction", "operation-progress-v6"), {
      iteration: 2,
      maxIterations: 3,
      completedIterations: 1,
      producerModelCallCount: 1,
      auditModelCallCount: 1,
      structuredRepairModelCallCount: 0,
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

  it("blocks archiving and permanently deleting runs with an uncertain paid result", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-uncertain-paid-archive-"));
    const run = waitingRun(workspaceRoot);
    run.status = "failed";
    run.nodeRuns[0] = { ...run.nodeRuns[0]!, status: "failed", outcomeUncertain: true };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(() => service.archiveRuns(["run-1"]), /付费结果尚未核对/);
    delete pipeline.run.nodeRuns[0]!.outcomeUncertain;
    await service.archiveRuns(["run-1"]);

    pipeline.run.nodeRuns[0]!.outcomeUncertain = true;
    await assert.rejects(() => service.deleteRun("run-1"), /付费结果尚未核对/);
    assert.equal(pipeline.removedRunId, undefined);

    delete pipeline.run.nodeRuns[0]!.outcomeUncertain;
    await service.deleteRun("run-1");
    assert.equal(pipeline.removedRunId, "run-1");
  });

  it("maps persisted runs to queue and detail DTOs", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const summaries = await service.listRuns();
    const detail = await service.getRun("run-1");

    assert.equal(summaries[0]?.title, brief.title);
    assert.equal(summaries[0]?.currentNodeId, "final-review");
    assert.equal(summaries[0]?.nextAction, "review");
    assert.equal(summaries[0]?.finalReviewOutcome, undefined);
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

  it("derives final-review outcomes only from the current final-review decision", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-final-review-outcome-"));
    const run = waitingRun(workspaceRoot);
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const assetIntervention = {
      id: "asset-source-review-1",
      nodeId: "asset-source-review",
      reason: "请核对素材来源",
      requiredAction: "approve" as const,
      options: ["approve", "reject"] as const,
      createdAt: "2026-08-21T10:00:30.000Z",
    };

    pipeline.run = {
      ...run,
      status: "rejected",
      nodeRuns: [{
        nodeId: "asset-source-review",
        status: "rejected",
        startedAt: assetIntervention.createdAt,
        finishedAt: "2026-08-21T10:00:40.000Z",
        artifactIds: [],
        qualityGateResults: [],
        intervention: assetIntervention,
      }],
      interventions: [assetIntervention],
      decisions: [{
        id: "asset-decision-1",
        interventionId: assetIntervention.id,
        action: "reject",
        actor: "owner",
        createdAt: "2026-08-21T10:00:40.000Z",
      }],
    };
    assert.equal((await service.listRuns())[0]?.finalReviewOutcome, undefined);

    const finalIntervention = run.interventions[0]!;
    pipeline.run = {
      ...run,
      status: "rejected",
      nodeRuns: run.nodeRuns.map((node) => node.nodeId === "final-review"
        ? { ...node, status: "rejected" as const }
        : node),
      decisions: [{
        id: "final-decision-1",
        interventionId: finalIntervention.id,
        action: "reject",
        actor: "owner",
        createdAt: "2026-08-21T10:01:05.000Z",
      }],
    };
    assert.equal((await service.listRuns())[0]?.finalReviewOutcome, "rejected");

    const currentIntervention = { ...finalIntervention, id: "final-intervention-2", createdAt: "2026-08-21T10:01:06.000Z" };
    pipeline.run = {
      ...pipeline.run,
      nodeRuns: pipeline.run.nodeRuns.map((node) => node.nodeId === "final-review"
        ? { ...node, intervention: currentIntervention }
        : node),
      interventions: [finalIntervention, currentIntervention],
    };
    assert.equal((await service.listRuns())[0]?.finalReviewOutcome, undefined);

    pipeline.run = {
      ...pipeline.run,
      status: "succeeded",
      nodeRuns: pipeline.run.nodeRuns.map((node) => node.nodeId === "final-review"
        ? { ...node, status: "succeeded" as const }
        : node),
      decisions: [{
        id: "final-decision-2",
        interventionId: currentIntervention.id,
        action: "approve",
        actor: "owner",
        createdAt: "2026-08-21T10:01:10.000Z",
      }],
    };
    assert.equal((await service.listRuns())[0]?.finalReviewOutcome, "approved");

    pipeline.run = {
      ...pipeline.run,
      status: "stale",
      nodeRuns: pipeline.run.nodeRuns.map((node) => node.nodeId === "final-review"
        ? { ...node, status: "stale" as const, intervention: undefined }
        : node),
      interventions: [],
    };
    assert.equal((await service.listRuns())[0]?.finalReviewOutcome, undefined);
  });

  it("routes a voice timing change through the safe planning command without accepting a plan path", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-voice-timing-decision-"));
    const run = executableWaitingRun(workspaceRoot);
    const intervention = {
      id: "voice-timing-1",
      nodeId: "voice",
      reason: "自然配音超出当前镜头；请调整统一方案。",
      requiredAction: "request_changes" as const,
      options: ["request_changes", "reject"] as const,
      createdAt: "2026-09-09T10:00:00.000Z",
    };
    const pipeline = new FakePipeline({
      ...run,
      revision: 4,
      nodeRuns: [{
        nodeId: "voice",
        status: "needs_human",
        startedAt: intervention.createdAt,
        finishedAt: intervention.createdAt,
        artifactIds: [],
        qualityGateResults: [],
        intervention,
        output: { conflict: {
          code: "VOICE_DOES_NOT_FIT",
          scenePosition: 1,
          plannedSeconds: 8,
          speechSeconds: 8.2,
          requiredSeconds: 8.2,
          audioArtifact: { kind: "voiceover_raw", uri: "/managed/raw.mp3", sha256: "a".repeat(64), sizeBytes: 12, contentType: "audio/mpeg" },
        } },
      }],
      interventions: [intervention],
    });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.decide("run-1", {
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    } as unknown as StudioDecisionInput, "trusted-owner");

    assert.deepEqual(pipeline.lastVoiceTimingRevision, {
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      scenePosition: 1,
      durationSeconds: 8.2,
      actor: "trusted-owner",
    });
    assert.equal(pipeline.lastDecision, undefined);
  });

  it("does not invent the source visual review node for an older visual-review workflow", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-historical-review-"));
    const historicalRun = waitingRun(workspaceRoot);
    historicalRun.workflowVersion = "1.4.0";
    historicalRun.initialInput = {
      ...historicalRun.initialInput,
      providers: {
        ...historicalRun.initialInput.providers,
        visualReview: "deepseek-visual-review-v1",
      },
    };
    const pipeline = new FakePipeline(historicalRun);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const detail = await service.getRun("run-1");
    const [summary] = await service.listRuns();

    assert.equal(detail?.nodes.some((node) => node.id === "asset-source-review"), false);
    assert.equal(summary?.workflowNodeIds?.includes("asset-source-review"), false);
    assert.deepEqual(summary?.workflowNodeIds, detail?.nodes.map((node) => node.id));
    assert.deepEqual(summary?.continuation, {
      supported: false,
      reason: "这条制作来自旧版工作流，只能查看现有结果。若要继续调整，请基于这版重新制作。",
    });
    assert.equal(summary?.nextAction, undefined);
    assert.deepEqual(detail?.continuation, {
      supported: false,
      reason: "这条制作来自旧版工作流，只能查看现有结果。若要继续调整，请基于这版重新制作。",
    });
    assert.equal((await service.reworkDraft("run-1"))?.input.rework?.sourceRunId, "run-1");
  });

  it("projects a completed legacy run from its persisted workflow instead of inventing unfinished nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-legacy-progress-"));
    const historicalRun = waitingRun(workspaceRoot);
    historicalRun.workflowVersion = "1.0.0";
    historicalRun.status = "succeeded";
    historicalRun.initialInput = {
      ...historicalRun.initialInput,
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    };
    historicalRun.executionPlan = [];
    historicalRun.nodeRuns = [
      "brief",
      "script",
      "assets",
      "voice",
      "render",
      "technical-review",
      "final-review",
      "publish-package",
    ].map((nodeId) => ({
      nodeId,
      status: "succeeded" as const,
      artifactIds: nodeId === "render" ? ["artifact-video"] : [],
      qualityGateResults: [],
    }));
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(historicalRun),
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    const detail = await service.getRun("run-1");
    const [summary] = await service.listRuns();

    assert.deepEqual(summary?.workflowNodeIds, historicalRun.nodeRuns.map((node) => node.nodeId));
    assert.equal(detail?.progress?.completedNodes, 8);
    assert.equal(detail?.progress?.totalNodes, 8);
    assert.equal(detail?.progress?.percentage, 100);
    assert.ok(detail?.phases?.every((phase) => phase.status === "completed"));
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
      recoveryOwner: { runId: "run-1", nodeId: "script", workflowOperationRequestId: "operation-live-script" },
    }), "utf8");
    const run = waitingRun(workspaceRoot);
    run.status = "running";
    delete run.finishedAt;
    run.nodeRuns = [{
      nodeId: "script",
      role: "编剧",
      status: "running",
      operationRequestId: "operation-live-script",
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
    run.initialInput = { ...run.initialInput, visualIntent: "用无字示意画面呈现前后变化，不声称实测。" };
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
    assert.deepEqual(detail?.creativeSummary, {
      audience: brief.audience,
      openingPromise: brief.angle,
      requiredVisual: "用无字示意画面呈现前后变化，不声称实测。",
      payoff: `围绕“${brief.title}”给出明确答案或可执行判断`,
    });

    // 历史文件与节点级旧 ID 仍存在，也不能替代当前有效版本的空交付。
    for (const artifact of run.artifacts) {
      if (!artifact.uri) continue;
      await mkdir(path.dirname(artifact.uri), { recursive: true });
      await writeFile(artifact.uri, "historical artifact remains on disk");
    }
    for (const node of run.nodeRuns.filter((node) => ["render", "publish-package"].includes(node.nodeId))) {
      const current = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
      assert.ok(current);
      current.artifactIds = [];
    }
    const emptyDelivery = await service.getRun("run-1");
    const [emptySummary] = await service.listRuns();
    assert.equal(emptyDelivery?.videoArtifactId, undefined);
    assert.equal(emptyDelivery?.publishPackageArtifactId, undefined);
    assert.equal(emptyDelivery?.resultAvailability?.kind, "none");
    assert.equal(emptySummary?.videoContentUrl, undefined);
    assert.equal(await readFile(newVideoPath, "utf8"), "historical artifact remains on disk");
    assert.equal(await readFile(newPackagePath, "utf8"), "historical artifact remains on disk");
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
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot, undefined);
    // 旧客户端仍传模板时也不能重启模板生产路径，用户明确要求保持原样。
    await service.startRun({ ...brief, template: { templateId: "unavailable-template" } });
    assert.equal((pipeline.lastInput as ProductionBrief).templateSnapshot, undefined);
    assert.equal((pipeline.lastInput as ProductionBrief).angle, brief.angle);
    assert.deepEqual(snapshots, ["needs_human"]);
    await assert.rejects(
      () => service.startRun({
        ...brief,
        providers: { ...brief.providers, assets: "pexels-stock-v1" },
      }),
      /需要连接 Pexels 图库服务/,
    );
  });

  it("does not trust article source snapshots supplied by the run client", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-forged-article-source-"));
    const opportunityStore = new JsonOpportunityStore(path.join(workspaceRoot, "opportunities.json"));
    await opportunityStore.create({
      title: opportunityInput.title,
      candidate: {
        id: "manual-source-1",
        platform: opportunityInput.platform,
        track: opportunityInput.track,
        audience: opportunityInput.audience,
        painPoint: opportunityInput.painPoint,
        hook: opportunityInput.hook,
        status: "shortlisted",
        evidence: opportunityInput.evidence,
        score: { ...opportunityInput.scores, final: 84 },
      },
      origin: "manual",
      category: "lifestyle",
      createdAt: "2026-09-14T08:00:00.000Z",
      updatedAt: "2026-09-14T08:00:00.000Z",
    });
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      opportunities: opportunityStore,
      commandAvailable: allCommandsAvailable,
      environment: {},
    });

    await service.startRun({
      ...brief,
      workflowFeatures: {
        ...brief.workflowFeatures,
        creativePlanning: "joint-v1",
        creativeReview: "user-confirmed-v1",
      },
      creationContext: { origin: "manual", opportunityId: "manual-source-1" },
      articleSources: [{
        sourceId: "forged-source",
        originalUrl: "https://attacker.example/story",
        finalUrl: "https://attacker.example/story",
        pageTitle: "伪造正文",
        fetchedAt: "2026-09-14T08:00:00.000Z",
        contentSha256: "a".repeat(64),
        extractorVersion: "forged-v1",
        readStatus: "read",
        truncated: false,
        paragraphs: [{ id: "p1", text: "客户端声称已经核实的内容。" }],
      }],
    });

    assert.equal((pipeline.lastInput as ProductionBrief).articleSources, undefined);
  });

  it("binds the adopted trend article snapshot into the production brief and ignores a client replacement", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-adopted-article-source-"));
    const trustedSources = [{
      sourceId: "source-report",
      originalUrl: "https://source-a.example/report",
      finalUrl: "https://source-a.example/report",
      pageTitle: "公开报告",
      fetchedAt: "2026-09-14T08:00:00.000Z",
      contentSha256: "a".repeat(64),
      extractorVersion: "readability-v1",
      readStatus: "read" as const,
      paragraphs: [{ id: "p1", text: "正文中披露了标题未包含的事实。" }],
      truncated: false,
    }];
    const trendCandidate = {
      id: "trend-with-article",
      title: "报告正文披露的新变化",
      platform: "douyin",
      track: "public-update",
      audience: "希望快速理解报告的普通观众",
      painPoint: "只看标题无法理解关键变化",
      hook: "标题没写出的关键变化是什么？",
      rationale: "用原文段落解释一项可核对变化。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-09-14T08:01:00.000Z",
      evidence: [
        { source: "来源甲", platform: "douyin", keyword: "报告", strength: 90, evidenceUrl: "https://source-a.example/report" },
        { source: "来源乙", platform: "douyin", keyword: "复核", strength: 82, evidenceUrl: "https://source-b.example/notice" },
      ],
      articleSources: trustedSources,
      articleFacts: [{ statement: "正文事实", sourceId: "source-report", paragraphIds: ["p1"] }],
      articleUncertainties: [],
      score: {
        audienceReach: 86,
        visualFeasibility: 82,
        productionCostEfficiency: 84,
        novelty: 76,
        monetization: 50,
        audienceDemand: 70,
        seriesPotential: 70,
        complianceRisk: 16,
        final: 79,
      },
      editorialDecision: {
        verdict: "produce_video" as const,
        score: 88,
        reasons: ["正文事实可核对。"],
        guardrails: ["只使用已引用段落。"],
      },
    };
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      trendAgent: { listCandidates: async () => [trendCandidate] },
    });

    // 收件箱读取不再等待生成：这里先走一次阻塞读取把候选落盘，模拟"生成已完成"的状态，
    // 否则读到的是冷缓存快照（空集合 + refreshing）。
    await service.listTrendCandidates();
    const candidate = (await service.listCandidateInbox({ origins: ["trend"] })).items[0]!;
    const opportunity = await service.adoptCandidate(candidate.id, { origin: "trend", ...(candidate.generationId ? { expectedGenerationId: candidate.generationId } : {}), verificationConfirmed: true });
    assert.deepEqual(opportunity.articleSources, trustedSources);

    await service.startRun({
      ...brief,
      workflowFeatures: { ...brief.workflowFeatures, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1" },
      creationContext: { origin: "trend", opportunityId: opportunity.id },
      articleSources: [{ ...trustedSources[0]!, sourceId: "client-replacement", paragraphs: [{ id: "p1", text: "客户端替换内容" }] }],
    });

    assert.deepEqual((pipeline.lastInput as ProductionBrief).articleSources, trustedSources);
  });

  it("reports the current source standard for a stale trend opportunity without blocking production", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-historical-trend-gate-"));
    const opportunityStore = new JsonOpportunityStore(path.join(workspaceRoot, "opportunities.json"));
    await opportunityStore.create({
      title: opportunityInput.title,
      candidate: {
        id: "historical-trend-1",
        platform: opportunityInput.platform,
        track: opportunityInput.track,
        audience: opportunityInput.audience,
        painPoint: opportunityInput.painPoint,
        hook: opportunityInput.hook,
        status: "shortlisted",
        evidence: [{ ...opportunityInput.evidence[0]!, evidenceUrl: "https://source-a.example/report" }],
        score: { ...opportunityInput.scores, final: 84 },
      },
      origin: "trend",
      category: "lifestyle",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["旧版单来源规则已通过。"] },
      editorialDecision: {
        verdict: "produce_video",
        score: 84,
        reasons: ["旧版规则建议生产。"],
        guardrails: ["核验来源。"],
      },
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    });
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      opportunities: opportunityStore,
      commandAvailable: allCommandsAvailable,
      environment: {},
    });
    // 这条断言验证的是"旧记录会被当前更严的标准重新算一遍"，与默认档是哪一档无关：
    // 显式钉住严格档，默认档调整时这条测试才不会被静默改写成空断言。
    await service.updateCreatorSettings({ topicStrategy: { sourcePolicy: "primary_or_two_independent" } });

    const [historical] = await service.listOpportunities("trend");
    assert.equal(historical?.verification?.status, "blocked");
    assert.equal(historical?.editorialDecision?.verdict, "produce_video");
    // 来源不足只是如实标注：服务端不再据此拦下开工，决定权在创作者。
    assert.deepEqual(
      await service.startRun({
        ...brief,
        creationContext: { origin: "trend", opportunityId: "historical-trend-1" },
      }, "historical-trend-start-1"),
      { runId: "run-1", status: "running" },
    );
    assert.equal(pipeline.dispatchCount, 1);
    // 放行不等于抹平：机会上仍然保留来源不足的结论，界面据此提示。
    assert.equal((await service.getOpportunity("historical-trend-1")).verification?.status, "blocked");

    const supplemented = await service.supplementOpportunitySources("historical-trend-1", {
      evidenceUrls: ["https://source-b.example/report"],
    });
    assert.equal(supplemented.verification?.status, "ready");
    assert.equal(supplemented.verification?.independentSources, 2);
    assert.equal(supplemented.evidence.at(-1)?.evidenceUrl, "https://source-b.example/report");
    assert.equal(supplemented.evidence.at(-1)?.strength, 0);
    assert.equal((await service.listOpportunities("trend"))[0]?.verification?.status, "ready");
  });

  it("keeps opportunity production independent from the paused template catalog", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-deleted-recommendation-"));
    const candidate = {
      id: "public-update-1",
      title: "警方回应公共安全事故调查进展",
      platform: "douyin",
      track: "public-update",
      audience: "关心事件进展与事实边界的本地居民",
      painPoint: "流传说法很多，难以区分已经确认的事实",
      hook: "两份原始通报中，到底确认了哪些事实？",
      rationale: "只解释已由原始来源确认的进展。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-09-07T08:00:00.000Z",
      evidence: [
        { source: "警方通报", platform: "douyin", keyword: "调查进展", strength: 92, evidenceUrl: "https://police.example/report" },
        { source: "政府公告", platform: "douyin", keyword: "处置公告", strength: 88, evidenceUrl: "https://government.example/notice" },
      ],
      score: {
        audienceReach: 86,
        visualFeasibility: 52,
        productionCostEfficiency: 82,
        novelty: 70,
        monetization: 30,
        audienceDemand: 70,
        seriesPotential: 55,
        complianceRisk: 68,
        final: 65,
      },
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline: new FakePipeline(waitingRun(workspaceRoot)),
      commandAvailable: allCommandsAvailable,
      environment: {},
      trendAgent: {
        listCandidates: async () => [candidate],
        generationReceipt: () => ({
          generationId: "generation-service-1",
          generatedAt: "2026-09-07T08:00:00.000Z",
          modelInvoked: true,
          source: "rule-fallback",
          candidateCount: 1,
          failureCategory: "accepted_unknown",
          failureReason: "原任务已经接收，但当前查询暂时失败。",
        }),
      },
    });

    // 同上：先完成一次生成，收件箱读取才拿得到候选与生成回执。
    await service.listTrendCandidates();
    const trendInbox = await service.listCandidateInbox({ origins: ["trend"] });
    const beforeDeletion = trendInbox.items[0];
    assert.equal(beforeDeletion?.editorialDecision.recommendedTemplate, undefined);
    assert.deepEqual(trendInbox.topicGeneration, {
      generationId: "generation-service-1",
      generatedAt: "2026-09-07T08:00:00.000Z",
      modelInvoked: true,
      source: "rule-fallback",
      candidateCount: 1,
      failureCategory: "accepted_unknown",
      failureReason: "原任务已经接收，但当前查询暂时失败。",
    });
    assert.equal((await service.listCandidateInbox({ origins: ["series"] })).topicGeneration, undefined);

    const catalog = await service.listTemplates();
    await service.deleteTemplate("photo-story", catalog.storeRevision);
    const afterDeletion = (await service.listCandidateInbox({ origins: ["trend"] })).items[0];

    assert.equal(afterDeletion?.editorialDecision.verdict, "produce_image_story");
    assert.equal(afterDeletion?.editorialDecision.recommendedTemplate, undefined);
    assert.equal((await service.templateExperiments()).some((item) => item.templateId === "photo-story"), false);
    await service.adoptCandidate(afterDeletion!.id, { origin: "trend", ...(afterDeletion!.generationId ? { expectedGenerationId: afterDeletion!.generationId } : {}), verificationConfirmed: true });
    assert.equal((await service.listOpportunities("trend")).length, 1);
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
    assert.equal(dispatched.seriesContext?.episode.planning.role, "系列总编");
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

  it("replays a completed series start without implicitly reviewing the adopted episode", async () => {
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
    assert.equal(reviews, 0);
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
    const scriptNode = pipeline.run.nodeRuns.find((node) => node.nodeId === "script")!;
    const finalReview = pipeline.run.nodeRuns.find((node) => node.nodeId === "final-review")!;
    pipeline.run.revision = 8;
    await writeFile(scriptPath, `${JSON.stringify({
      viewerPromise: "完成一次真实实验",
      narrativeArc: "从尝试推进到可复用方法",
      canonFacts: [],
      scenes: [{ narration: "本集没有形成需要后集继承的新事实。" }],
    })}\n`, "utf8");
    scriptNode.output = { scriptPath, canonFacts: [] };
    scriptNode.outputState!.versions[0]!.output = { scriptPath, canonFacts: [] };
    finalReview.output = { review: {}, canonFacts: [] };
    finalReview.outputState!.versions[0]!.output = { review: {}, canonFacts: [] };
    const emptyCanon = (await service.listSeries())[0]!;
    assert.equal(emptyCanon.episodes[0]?.status, "ready");
    assert.deepEqual(emptyCanon.canon.facts, []);
    assert.match(emptyCanon.episodes[0]?.continuity.memorySummary ?? "", /没有新增系列事实/);

    const approvedCanonFacts = ["已经完成一次低成本实验。", "记录步骤后可以复现实验结果。"];
    pipeline.run.revision = 9;
    await writeFile(scriptPath, `${JSON.stringify({
      viewerPromise: "完成一次真实实验",
      narrativeArc: "从尝试推进到可复用方法",
      canonFacts: approvedCanonFacts,
      scenes: [{ narration: "下一集继续验证长期效果。" }],
    })}\n`, "utf8");
    scriptNode.output = { scriptPath, canonFacts: approvedCanonFacts };
    scriptNode.outputState!.versions[0]!.output = { scriptPath, canonFacts: approvedCanonFacts };
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
    const manual = await service.createOpportunity(opportunityInput);
    await assert.rejects(
      () => service.supplementOpportunitySources(manual.id, { evidenceUrls: ["https://example.org/source"] }),
      /只有热点选题支持补充原始来源/,
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
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
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
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.reconcilePaidNode("run-1", "assets", {
      expectedRunRevision: 7,
      reconciliationId: "confirm-charge-assets-7",
      outcome: "confirmed_charged",
      itemRequestId: "paid-scene-2",
      note: "Provider 控制台确认已扣费。",
      actualCostCny: 2.4,
    }, "billing-reviewer");

    assert.deepEqual(pipeline.lastReconciliation, {
      nodeId: "assets",
      expectedRunRevision: 7,
      reconciliationId: "confirm-charge-assets-7",
      outcome: "confirmed_charged",
      itemRequestId: "paid-scene-2",
      actor: "billing-reviewer",
      note: "Provider 控制台确认已扣费。",
      actualCostCny: 2.4,
    });
  });

  it("allows legacy paid reconciliation only for settle-only outcomes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-legacy-paid-settlement-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    for (const outcome of ["resume_original", "requote"] as const) {
      await assert.rejects(() => service.reconcilePaidNode("run-1", "assets", {
        expectedRunRevision: 0,
        reconciliationId: `legacy-${outcome}`,
        outcome,
      }), /创建新版本|旧流程|只能.*结算/);
    }
    assert.equal(pipeline.lastReconciliation, undefined);

    await service.reconcilePaidNode("run-1", "assets", {
      expectedRunRevision: 0,
      reconciliationId: "legacy-confirmed-charged",
      outcome: "confirmed_charged",
      itemRequestId: "paid-scene-1",
      note: "Provider 控制台确认已扣费。",
      actualCostCny: 2.4,
    }, "billing-reviewer");
    assert.equal(pipeline.lastReconciliation?.outcome, "confirmed_charged");
    assert.deepEqual(pipeline.lastReconciliationOptions, { settleOnly: true });

    await service.reconcilePaidNode("run-1", "assets", {
      expectedRunRevision: 0,
      reconciliationId: "legacy-confirmed-not-charged",
      outcome: "confirmed_not_charged",
      itemRequestId: "paid-scene-1",
      note: "Provider 控制台确认未扣费。",
    }, "billing-reviewer");
    assert.equal(pipeline.lastReconciliation?.outcome, "confirmed_not_charged");
    assert.deepEqual(pipeline.lastReconciliationOptions, { settleOnly: true });
  });

  it("turns an unqueryable paid task into an explicit manual-reconciliation conflict", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-manual-reconciliation-"));
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
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
    const run = executableWaitingRun(workspaceRoot);
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

  it("allows a settled rejected asset pilot to be rechecked in the same run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-background-pilot-recheck-"));
    const run = executableWaitingRun(workspaceRoot);
    const assetNodeId = run.nodeRuns[0]!.nodeId;
    run.status = "rejected";
    run.nodeRuns[0] = {
      ...run.nodeRuns[0]!,
      nodeId: "assets",
      status: "rejected",
      error: "镜头 6 试片未通过，已停止后续付费生成。",
      output: {
        sourceVisualReview: {
          version: "video-factory/visual-review-v1",
          recommendation: "revise",
        },
      },
    };
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const response = await service.retryFailedNode(run.id, "assets");

    assert.equal(response.status, "running");
    assert.equal(pipeline.lastRetriedNodeId, "assets");
    assert.notEqual(assetNodeId, "assets");
  });

  it("retries an incomplete source review through the Studio service without treating it as a generic failed retry", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-source-review-retry-"));
    const run = executableWaitingRun(workspaceRoot);
    run.status = "needs_human";
    run.nodeRuns = [{
      nodeId: "assets",
      status: "needs_human",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      artifactIds: [],
      qualityGateResults: [],
      intervention: {
        id: "source-review-retry-1",
        nodeId: "assets",
        kind: "source_review_retry",
        reason: "镜头 1 已生成，但试片审查暂未完成。",
        requiredAction: "reject",
        options: ["reject"],
        createdAt: run.finishedAt!,
      },
    }];
    run.interventions = [run.nodeRuns[0]!.intervention!];
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const response = await service.retryFailedNode(run.id, "assets");

    assert.equal(response.status, "running");
    assert.equal(pipeline.lastRetriedNodeId, "assets");
    assert.equal(pipeline.retryDispatchCount, 1);
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
      /制作参数.*(?:不正确|不符合要求)/,
    );
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("rejects a source platform before dispatching a production run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-platform-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.startRun({ ...brief, platform: "guokr" }, "invalid-platform-request-1"),
      /目标平台只支持抖音、小红书或哔哩哔哩/,
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

  it("freezes a global model default at creation so a replay cannot inherit a later setting", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-model-idempotency-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = {
      ARK_API_KEY: "seedance-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment,
      deepseekCodexAvailability: { available: true, reason: "" },
    });
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-5-260628" } });
    const input = {
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
    };

    const first = await service.startRun(input, "model-default-request-1");
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.equal((pipeline.lastInput as ProductionBrief).modelSelectionSources?.["seedance-video-v1"], "global_default");
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-0-260128" } });
    const restarted = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment,
      deepseekCodexAvailability: { available: true, reason: "" },
    });

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

  it("freezes the qualified global model default when it inherits a missing production role", async () => {
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
        taskKinds: ["script-draft", "director-plan", "role-audit"],
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
      workflowFeatures: {
        assetSemanticRank: false,
        referenceGrammar: true,
        executablePlan: true,
        creativePlanning: "joint-v1",
        creativeReview: "user-confirmed-v1",
        boundaryGates: "user-confirmed-v1",
      },
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

  it("inherits a verified private reference video into a new rework run without exposing its path", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-reference-rework-"));
    const sourcePath = path.join(workspaceRoot, "runs", "run-1", "nodes", "reference-grammar", "attempt-1", "reference.mp4");
    const sourceBytes = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    const base = waitingRun(workspaceRoot);
    const referencedBrief: ProductionBrief = {
      ...base.initialInput,
      providers: { ...base.initialInput.providers, script: "codex-screenwriter-v1", director: "api-visual-director-v1" },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
      referenceVideo: {
        uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
        label: "参考节奏.mp4",
        mimeType: "video/mp4",
        sizeBytes: sourceBytes.length,
        sha256: sourceSha256,
        path: path.join(workspaceRoot, "uploads", "reference-videos", "released", "source.mp4"),
      },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    };
    const rejectedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      revision: 7,
      initialInput: referencedBrief,
      decisions: [{
        interventionId: "intervention-1",
        action: "reject",
        decidedBy: "owner",
        decidedAt: "2026-08-21T10:02:00.000Z",
        note: "按审片建议调整画面后重做。",
      }],
      nodeRuns: [{
        nodeId: "reference-grammar",
        status: "succeeded",
        artifactIds: ["artifact-reference-video"],
        qualityGateResults: [],
      }, ...base.nodeRuns],
      artifacts: [{
        id: "artifact-reference-video",
        kind: "reference_video",
        uri: sourcePath,
        createdAt: base.startedAt,
        contentType: "video/mp4",
        sizeBytes: sourceBytes.length,
        sha256: sourceSha256,
        producer: { nodeId: "reference-grammar", attempt: 1 },
        provenance: { providerId: "creator-upload" },
      }, ...base.artifacts],
    };
    const pipeline = new FakePipeline(rejectedRun);
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: { available: true, reason: "", taskKinds: ["script-draft", "director-plan", "reference-grammar", "role-audit"] },
    });

    const draft = await service.reworkDraft("run-1");

    assert.deepEqual(draft?.inheritedReferenceVideo, {
      label: "参考节奏.mp4",
      mimeType: "video/mp4",
      sizeBytes: sourceBytes.length,
    });
    assert.equal("path" in (draft?.inheritedReferenceVideo ?? {}), false);
    assert.equal(draft?.input.referenceVideo, undefined);
    assert.ok(draft?.inheritedNodeIds.includes("reference-grammar"));

    await service.startRun(draft!.input, "reference-rework-request-1");

    const dispatched = pipeline.lastInput as ProductionBrief;
    assert.equal(dispatched.referenceVideo?.label, "参考节奏.mp4");
    assert.equal(dispatched.referenceVideo?.sha256, sourceSha256);
    assert.notEqual(dispatched.referenceVideo?.path, sourcePath);
    assert.match(dispatched.referenceVideo?.path ?? "", /uploads\/reference-videos\/[a-f0-9-]{36}\/source\.mp4$/);
    assert.deepEqual(await readFile(dispatched.referenceVideo!.path), sourceBytes);
  });

  it("rejects stale, missing, tampered, or escaped inherited reference videos before dispatch", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-reference-rework-rejection-"));
    const sourcePath = path.join(workspaceRoot, "runs", "run-1", "nodes", "reference-grammar", "attempt-1", "reference.mp4");
    const escapedPath = path.join(workspaceRoot, "escaped-reference.mp4");
    const sourceBytes = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(escapedPath, sourceBytes);
    const base = waitingRun(workspaceRoot);
    const referencedBrief: ProductionBrief = {
      ...base.initialInput,
      providers: { ...base.initialInput.providers, script: "codex-screenwriter-v1", director: "api-visual-director-v1" },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
      referenceVideo: {
        uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
        label: "参考节奏.mp4",
        mimeType: "video/mp4",
        sizeBytes: sourceBytes.length,
        sha256: sourceSha256,
        path: path.join(workspaceRoot, "uploads", "reference-videos", "released", "source.mp4"),
      },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    };
    const referenceNode = {
      nodeId: "reference-grammar",
      status: "succeeded" as const,
      artifactIds: ["artifact-reference-video"],
      qualityGateResults: [],
    };
    const referenceArtifact: Artifact = {
      id: "artifact-reference-video",
      kind: "reference_video",
      uri: sourcePath,
      createdAt: base.startedAt,
      contentType: "video/mp4",
      sizeBytes: sourceBytes.length,
      sha256: sourceSha256,
      producer: { nodeId: "reference-grammar", attempt: 1 },
      provenance: { providerId: "creator-upload" },
    };
    const rejectedRun: WorkflowRun<ProductionBrief> = {
      ...base,
      status: "rejected",
      revision: 7,
      initialInput: referencedBrief,
      decisions: [{
        interventionId: "intervention-1",
        action: "reject",
        decidedBy: "owner",
        decidedAt: "2026-08-21T10:02:00.000Z",
        note: "按审片建议调整画面后重做。",
      }],
      nodeRuns: [referenceNode, ...base.nodeRuns],
      artifacts: [referenceArtifact, ...base.artifacts],
    };
    const pipeline = new FakePipeline(rejectedRun);
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: { available: true, reason: "", taskKinds: ["script-draft", "director-plan", "reference-grammar", "role-audit"] },
    });
    const draft = await service.reworkDraft("run-1");
    assert.ok(draft);

    await assert.rejects(
      () => service.startRun({
        ...draft.input,
        rework: { ...draft.input.rework!, sourceRunRevision: 6 },
      }, "reference-rework-stale"),
      /原制作在返工草稿打开后发生了变化/,
    );

    referenceNode.artifactIds = [];
    await assert.rejects(
      () => service.startRun(draft.input, "reference-rework-missing"),
      /参考视频没有完整留档/,
    );
    referenceNode.artifactIds = [referenceArtifact.id];

    referenceArtifact.sha256 = "f".repeat(64);
    await assert.rejects(
      () => service.startRun(draft.input, "reference-rework-metadata"),
      /留档与原始记录不一致/,
    );
    referenceArtifact.sha256 = sourceSha256;

    await writeFile(sourcePath, Buffer.from("tampered-reference"));
    await assert.rejects(
      () => service.startRun(draft.input, "reference-rework-bytes"),
      /参考视频内容已经变化/,
    );
    await writeFile(sourcePath, sourceBytes);

    referenceArtifact.uri = escapedPath;
    await assert.rejects(
      () => service.startRun(draft.input, "reference-rework-escape"),
      /不属于当前制作目录/,
    );
    referenceArtifact.uri = sourcePath;
    assert.equal(pipeline.dispatchCount, 0);
  });

  it("blocks disabled metered providers but ignores legacy video-wide ceilings", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      deepseekCodexAvailability: { available: true, reason: "" },
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
        SEEDREAM_MODEL_ID: "doubao-seedream-4-0-250828",
        SEEDREAM_ESTIMATED_CNY_PER_IMAGE: "0.25",
      },
    });
    const seedanceBrief = {
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
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
      deepseekCodexAvailability: { available: true, reason: "" },
      environment: {
        ARK_API_KEY: "seedance-key",
        SEEDANCE_MODEL_ID: "doubao-seedance-2-5-260628",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
      },
    });

    const result = await service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("accepts one metered DeepSeek review without treating it as a paid shot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: {},
      codexAvailability: { available: true, reason: "" },
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    await service.startRun({
      ...brief,
      providers: { ...brief.providers, visualReview: "deepseek-visual-review-v1" },
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
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    const result = await service.startRun({
      ...brief,
      providers: { ...brief.providers, visualReview: "deepseek-visual-review-v1" },
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

  it("ignores paused template model defaults, freezes the global default, and honors an explicit run override", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = {
      ARK_API_KEY: "test-ark-key",
      SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5",
    };
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment,
      deepseekCodexAvailability: { available: true, reason: "" },
    });
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
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 4 },
    };

    await service.startRun(paidBrief);
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-1-5-pro-251215");
    assert.equal((pipeline.lastInput as ProductionBrief).modelSelectionSources?.["seedance-video-v1"], "global_default");

    await service.startRun({
      ...paidBrief,
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
    });
    assert.equal((pipeline.lastInput as ProductionBrief).models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.equal((pipeline.lastInput as ProductionBrief).modelSelectionSources?.["seedance-video-v1"], "run_override");
  });

  it("removes a model override and replans direction when an inherited asset source no longer exists", async () => {
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
        assetProviderIds: ["local-editorial-v1", "retired-asset-source-v1"],
      },
      models: { "retired-asset-source-v1": "retired-model" },
      modelSelectionSources: { "retired-asset-source-v1": "node_override" },
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 4,
      },
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      workflowVersion: productionWorkflowVersion(initialInput),
      initialInput,
    });
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
      expectedRunRevision: 0,
    }, "vfqa");

    assert.deepEqual(pipeline.run.initialInput.director?.assetProviderIds, ["local-editorial-v1"]);
    assert.equal(pipeline.run.initialInput.models?.["retired-asset-source-v1"], undefined);
    assert.equal(pipeline.run.initialInput.modelSelectionSources?.["retired-asset-source-v1"], undefined);
    assert.equal(pipeline.lastExecutionConfigurationNodeId, "creative-planning");
  });

  it("resumes from assets when only the model of an unchanged asset source changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-node-model-only-"));
    const initialInput: ProductionBrief = {
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        visualReview: "deepseek-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
      modelSelectionSources: { "seedance-video-v1": "node_override" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      workflowVersion: productionWorkflowVersion(initialInput),
      initialInput,
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" },
      codexAvailability: { available: true, reason: "" },
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    await service.applyNodeExecutionConfiguration("run-1", "assets", {
      modelSelections: { "seedance-video-v1": "doubao-seedance-2-0-fast-260128" },
      expectedRunRevision: 0,
    }, "vfqa");

    assert.equal(pipeline.run.initialInput.models?.["seedance-video-v1"], "doubao-seedance-2-0-fast-260128");
    assert.equal(pipeline.lastExecutionConfigurationNodeId, "assets");
  });

  it("restores this run's frozen model selection when a node override is cleared", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-node-model-restore-"));
    const initialInput: ProductionBrief = {
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        visualReview: "deepseek-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
      modelSelectionSources: { "seedance-video-v1": "global_default" },
      frozenModelSelections: {
        "seedance-video-v1": { modelId: "doubao-seedance-2-5-260628", source: "global_default" },
      },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      workflowVersion: productionWorkflowVersion(initialInput),
      initialInput,
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" },
      codexAvailability: { available: true, reason: "" },
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    await service.applyNodeExecutionConfiguration("run-1", "assets", {
      modelSelections: { "seedance-video-v1": "doubao-seedance-2-0-fast-260128" },
      expectedRunRevision: 0,
    }, "vfqa");
    await service.applyNodeExecutionConfiguration("run-1", "assets", {
      modelSelections: { "seedance-video-v1": null },
      expectedRunRevision: 1,
    }, "vfqa");

    assert.equal(pipeline.run.initialInput.models?.["seedance-video-v1"], "doubao-seedance-2-5-260628");
    assert.equal(pipeline.run.initialInput.modelSelectionSources?.["seedance-video-v1"], "global_default");
  });

  it("replans direction when a video model switch changes the generation duration contract", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-node-model-duration-"));
    const initialInput: ProductionBrief = {
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        visualReview: "deepseek-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      models: { "seedance-video-v1": "doubao-seedance-2-5-260628" },
      modelSelectionSources: { "seedance-video-v1": "node_override" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      workflowVersion: productionWorkflowVersion(initialInput),
      initialInput,
    });
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment: { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" },
      codexAvailability: { available: true, reason: "" },
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    await service.applyNodeExecutionConfiguration("run-1", "assets", {
      modelSelections: { "seedance-video-v1": "doubao-seedance-1-5-pro-251215" },
      expectedRunRevision: 0,
    }, "vfqa");

    assert.equal(pipeline.run.initialInput.models?.["seedance-video-v1"], "doubao-seedance-1-5-pro-251215");
    assert.equal(pipeline.lastExecutionConfigurationNodeId, "creative-planning");
  });

  it("rejects an invalid explicit model instead of silently replacing it with the global default", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-invalid-model-"));
    const pipeline = new FakePipeline(waitingRun(workspaceRoot));
    const environment = { ARK_API_KEY: "test-ark-key", SEEDANCE_ESTIMATED_CNY_PER_CLIP: "3.5" };
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment,
      deepseekCodexAvailability: { available: true, reason: "" },
    });
    await service.updateCreatorSettings({ modelDefaults: { "seedance-video-v1": "doubao-seedance-2-5-260628" } });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
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
    const service = new StudioService({
      workspaceRoot,
      pipeline,
      commandAvailable: allCommandsAvailable,
      environment,
      deepseekCodexAvailability: { available: true, reason: "" },
    });

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1", visualReview: "deepseek-visual-review-v1" },
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
      deepseekCodexAvailability: { available: true, reason: "" },
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
        visualReview: "deepseek-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3.5 },
    });
    assert.deepEqual(result, { runId: "run-1", status: "running" });
    assert.equal(pipeline.dispatchCount, 1);
  });

  it("refuses a metered visual source when visual review is unavailable from the production brief", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-missing-visual-review-"));
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

    await assert.rejects(() => service.startRun({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
    }), /付费图片和视频必须启用视觉审片/);
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
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await service.decide("run-1", {
      action: "approve",
      expectedRunRevision: 0,
      interventionId: "intervention-1",
      reviewEvidenceId: null,
    }, "jinkun");

    assert.equal(pipeline.lastDecision?.interventionId, "intervention-1");
    assert.equal(pipeline.lastDecision?.action, "approve");

    pipeline.run = executableWaitingRun(workspaceRoot);
    await assert.rejects(
      () => service.decide("run-1", {
        action: "reject",
        expectedRunRevision: 0,
        interventionId: "intervention-1",
        reviewEvidenceId: null,
      }, "jinkun"),
      (error: unknown) => error instanceof StudioConflictError && /填写原因/.test(error.message),
    );
  });

  it("routes a scene-localized revision through the same run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-scene-revision-"));
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
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
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    pipeline.decide = async () => {
      throw new StaleRunRevisionError("run-1", 0, 1);
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.decide("run-1", {
        action: "approve",
        expectedRunRevision: 0,
        interventionId: "intervention-1",
        reviewEvidenceId: null,
      }, "director"),
      (error: unknown) => error instanceof StudioConflictError && /刷新/.test(error.message),
    );
  });

  it("surfaces human decision precondition conflicts with their original guidance", async () => {
    // EB-05：证据错配/缺表态等决定前置条件错误的文案面向操作员，必须以冲突形式保留原文，
    // 而不是被脱敏成 500 通用文案；provider/存储等真实故障不允许借用这个类型。
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    const guidance = "Human decision is not bound to the current review evidence.";
    pipeline.decide = async () => {
      throw new HumanDecisionConflictError(guidance);
    };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.decide("run-1", {
        action: "approve",
        expectedRunRevision: 0,
        interventionId: "intervention-1",
        reviewEvidenceId: null,
      }, "director"),
      (error: unknown) => error instanceof StudioConflictError && error.message === guidance,
    );

    const internalFailure = new Error("provider socket exploded");
    pipeline.decide = async () => {
      throw internalFailure;
    };
    await assert.rejects(
      () => service.decide("run-1", {
        action: "approve",
        expectedRunRevision: 0,
        interventionId: "intervention-1",
        reviewEvidenceId: null,
      }, "director"),
      (error: unknown) => error === internalFailure,
    );
  });

  it("rejects node edits while a run is active and validates output against the current node schema", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = executableWaitingRun(workspaceRoot);
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
    const run = executableWaitingRun(workspaceRoot);
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

  it("blocks every edit path until an uncertain paid result is reconciled", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-uncertain-edit-"));
    const run = executableWaitingRun(workspaceRoot);
    run.status = "failed";
    run.nodeRuns.unshift({
      nodeId: "script",
      status: "succeeded",
      output: { hook: "旧钩子" },
      inputState: {
        effectiveVersionId: "script-input-1",
        stale: false,
        versions: [{
          id: "script-input-1",
          source: "derived",
          value: { title: "旧题目" },
          upstreamVersionIds: [],
          createdAt: "2026-08-27T00:00:00.000Z",
          createdBy: "workflow:script",
          schemaVersion: "1",
        }],
      },
      artifactIds: [],
      qualityGateResults: [],
    });
    run.nodeRuns.push({
      nodeId: "assets",
      status: "failed",
      outcomeUncertain: true,
      operationRequestId: "paid-operation-1",
      artifactIds: [],
      qualityGateResults: [],
    });
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    await assert.rejects(
      () => service.applyNodeOverride("run-1", "script", {
        output: { hook: "新钩子" },
        confirmTerminalEdit: true,
      }, "trusted-owner"),
      /先完成任务与账单核对/,
    );
    await assert.rejects(
      () => service.applyNodeInputOverride("run-1", "script", {
        input: { title: "新题目" },
        confirmTerminalEdit: true,
      }, "trusted-owner"),
      /先完成任务与账单核对/,
    );
    await assert.rejects(
      () => service.applyNodeExecutionConfiguration("run-1", "script", {
        providerId: "codex-screenwriter-v1",
        modelSelections: {},
        confirmTerminalEdit: true,
      }, "trusted-owner"),
      /先完成任务与账单核对/,
    );
    assert.equal(pipeline.lastOverride, undefined);
    assert.equal(pipeline.lastInputOverride, undefined);
  });

  it("lets the brief node pick the model of its independent review and nothing else", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-brief-audit-model-"));
    const initialInput: ProductionBrief = {
      ...brief,
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    };
    const pipeline = new FakePipeline({
      ...waitingRun(workspaceRoot),
      workflowVersion: productionWorkflowVersion(initialInput),
      initialInput,
    });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    // 读：简报节点没有可切换的执行能力，能调的只有独立复核那一项能力键。
    const opened = await service.getRun("run-1");
    assert.deepEqual(opened?.nodes.find((node) => node.id === "brief")?.executionConfiguration, {
      providerId: "codex-role-auditor-v1",
      modelSelections: {},
    });
    // 复核模型必须来自目录里真实存在的模型档案，否则这轮改动只是在写一个永不生效的键。
    const reviewer = (await service.listProviders()).find((provider) => provider.id === "codex-role-auditor-v1");
    assert.equal(reviewer?.capability, "role.audit");
    const reviewModels = (reviewer?.modelProfiles ?? []).filter((model) => model.available).map((model) => model.id);
    assert.ok(reviewModels.length > 0, "the catalog must offer at least one independent-review model");

    await service.applyNodeExecutionConfiguration("run-1", "brief", {
      providerId: "codex-role-auditor-v1",
      modelSelections: { "codex-role-auditor-v1": reviewModels[0]! },
      expectedRunRevision: 0,
    }, "vfqa");

    assert.equal(pipeline.run.initialInput.models?.["codex-role-auditor-v1"], reviewModels[0]);
    assert.equal(pipeline.run.initialInput.modelSelectionSources?.["codex-role-auditor-v1"], "node_override");
    assert.equal(pipeline.lastExecutionConfigurationNodeId, "brief");

    // 写回空字符串等于界面上的"使用推荐"：删掉这条选择，而不是记下一个空模型名。
    await service.applyNodeExecutionConfiguration("run-1", "brief", {
      providerId: "codex-role-auditor-v1",
      modelSelections: { "codex-role-auditor-v1": "" },
      expectedRunRevision: 1,
    }, "vfqa");
    assert.equal(pipeline.run.initialInput.models?.["codex-role-auditor-v1"], undefined);
    assert.equal(pipeline.run.initialInput.modelSelectionSources?.["codex-role-auditor-v1"], undefined);

    // 拒：复核能力不可切换，也不能借简报节点改别的能力的模型。
    await assert.rejects(
      () => service.applyNodeExecutionConfiguration("run-1", "brief", {
        providerId: "codex-screenwriter-v1",
        modelSelections: {},
        expectedRunRevision: 2,
      }, "vfqa"),
      /独立复核能力不可切换/,
    );
    await assert.rejects(
      () => service.applyNodeExecutionConfiguration("run-1", "brief", {
        modelSelections: { "codex-screenwriter-v1": reviewModels[0]! },
        expectedRunRevision: 2,
      }, "vfqa"),
      /只能调整独立复核的模型/,
    );
  });

  it("offers no brief review model when the production has no boundary gates", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-brief-no-gate-"));
    const pipeline = new FakePipeline(executableWaitingRun(workspaceRoot));
    // 这条测的是"没有闸门"的历史形态：版本串要照旧，所以 flags 直接从简报里去掉而不是换一份。
    const { boundaryGates: _withoutGates, ...flagsWithoutGates } = brief.workflowFeatures ?? {};
    pipeline.run.initialInput = { ...brief, workflowFeatures: flagsWithoutGates };
    pipeline.run.workflowVersion = productionWorkflowVersion(pipeline.run.initialInput);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });

    const opened = await service.getRun("run-1");
    assert.equal(opened?.nodes.find((node) => node.id === "brief")?.executionConfiguration, undefined);
    await assert.rejects(
      () => service.applyNodeExecutionConfiguration("run-1", "brief", {
        providerId: "codex-role-auditor-v1",
        modelSelections: { "codex-role-auditor-v1": "deepseek-flash" },
        expectedRunRevision: 0,
      }, "vfqa"),
      /简报不跑独立复核/,
    );
  });

  it("rejects a stale spend confirmation and authorizes only the current server plan", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = executableWaitingRun(workspaceRoot);
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
        spendPlanId: "plan-stale",
        inputVersionIds: ["script-human-v2"],
        providerId: "hailuo-video-v1",
        modelId: "MiniMax-Hailuo-02",
        maxCostCny: 3,
        maxAttempts: 1,
      }, "trusted-owner"),
      /费用计划或上游版本已经变化/,
    );
    assert.equal(pipeline.lastAuthorization, undefined);

    await assert.rejects(
      () => service.authorizeSpend("run-1", "assets", {
        spendPlanId: "plan-current",
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
      spendPlanId: "plan-current",
      inputVersionIds: ["script-human-v2"],
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      maxCostCny: 3,
      maxAttempts: 1,
    }, "trusted-owner");
    assert.deepEqual(pipeline.lastAuthorization, {
      spendPlanId: "plan-current",
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
    const run = executableWaitingRun(workspaceRoot);
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

    await assert.rejects(
      () => service.rejectSpend("run-1", "assets", {
        spendPlanId: "plan-current",
        reason: "too_expensive",
        targetEstimatedCostCny: 4.8,
      }, "trusted-owner"),
      /降本目标必须低于当前报价/,
    );
    await assert.rejects(
      () => service.rejectSpend("run-1", "assets", {
        spendPlanId: "plan-current",
        reason: "too_expensive",
        targetEstimatedCostCny: 5,
      }, "trusted-owner"),
      /降本目标必须低于当前报价/,
    );
    assert.equal(pipeline.lastSpendRejection, undefined);

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
    const run = executableWaitingRun(workspaceRoot);
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
    const run = executableWaitingRun(workspaceRoot);
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
      creator_url: "https://www.pexels.com/@creator",
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
      providers: {
        ...run.initialInput.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      workflowFeatures: { assetSemanticRank: true, referenceGrammar: false, executablePlan: true },
    };
    run.workflowVersion = productionWorkflowVersion(run.initialInput);
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
      expectedRunRevision: 0,
      expectedVersionId: "assets-input-v1",
    }, "trusted-owner");
    assert.equal(pipeline.lastInputOverride, undefined);

    await service.applyNodeInputOverride("run-1", "assets", {
      input: { candidateInventoryPath: "[系统托管文件]", selectedAssetIds: ["two"] },
      expectedRunRevision: 0,
      expectedVersionId: "assets-input-v1",
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
    const forgedCredit = structuredClone(report);
    forgedCredit.scene_candidates[0]!.candidates[0]!.creator_url = "https://example.com/another-author";
    await assert.rejects(
      () => service.applyNodeOverride("run-1", "asset-candidates", {
        document: { artifactId: "artifact-candidates", content: forgedCredit },
      }, "trusted-owner"),
      /creator_url 不能修改/,
    );
  });

  it("rejects document edits that do not target the node's current JSON artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-"));
    const run = executableWaitingRun(workspaceRoot);
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
        creator_url: "https://example.com/original-creator",
        preview_url: "https://example.com/original-preview.jpg",
        license_note: "Original license",
        query: "original",
      }],
    };
    await mkdir(path.dirname(assetPlanPath), { recursive: true });
    await mkdir(path.dirname(replacementPath), { recursive: true });
    await writeFile(assetPlanPath, JSON.stringify(plan), "utf8");
    await writeFile(originalPath, "original-video", "utf8");
    await writeFile(replacementPath, "replacement-video", "utf8");

    const run = executableWaitingRun(workspaceRoot);
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
    assert.equal(savedPlan.scene_assets[0]?.creator_url, undefined);
    assert.equal(savedPlan.scene_assets[0]?.preview_url, undefined);
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
    const run = executableWaitingRun(workspaceRoot);
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
      creator_url: "https://www.pexels.com/@real-creator",
      preview_url: "https://images.pexels.com/preview-1.jpg",
      license_note: "Pexels terms",
    }] };
    await mkdir(path.dirname(assetPlanPath), { recursive: true });
    await writeFile(assetPlanPath, JSON.stringify(plan), "utf8");
    await writeFile(mediaPath, "video", "utf8");
    const run = executableWaitingRun(workspaceRoot);
    run.nodeRuns.unshift({ nodeId: "assets", status: "succeeded", output: { assetPlanPath }, artifactIds: ["plan", "media"], qualityGateResults: [] });
    run.artifacts.push(
      { id: "plan", kind: "asset_plan", uri: assetPlanPath, createdAt: "2026-08-21T10:00:00.000Z", contentType: "application/json", producer: { nodeId: "assets", attempt: 1 }, provenance: { providerId: "asset-worker" } },
      { id: "media", kind: "media_asset", uri: mediaPath, createdAt: "2026-08-21T10:00:00.000Z", contentType: "video/mp4", producer: { nodeId: "assets", attempt: 1 }, provenance: { providerId: "pexels-stock-v1", sourceUrl: "https://www.pexels.com/video/1", creator: "Real creator", creatorUrl: "https://www.pexels.com/@real-creator", previewUrl: "https://images.pexels.com/preview-1.jpg", licenseNote: "Pexels terms" } },
    );
    const pipeline = new FakePipeline(run);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    const forged = structuredClone(plan);
    forged.scene_assets[0]!.provider = "local";
    forged.scene_assets[0]!.provider_id = "local";
    forged.scene_assets[0]!.source_url = "local://owned";
    forged.scene_assets[0]!.creator = "attacker";
    forged.scene_assets[0]!.creator_url = "https://example.com/attacker";
    forged.scene_assets[0]!.preview_url = "https://example.com/forged-preview.jpg";
    forged.scene_assets[0]!.license_note = "self owned";

    await service.applyNodeOverride("run-1", "assets", {
      document: { artifactId: "plan", content: forged },
    }, "trusted-owner");

    const saved = JSON.parse(await readFile((pipeline.lastOverride?.output as { assetPlanPath: string }).assetPlanPath, "utf8")) as typeof plan;
    assert.equal(saved.scene_assets[0]?.provider_id, "pexels-stock-v1");
    assert.equal(saved.scene_assets[0]?.source_url, "https://www.pexels.com/video/1");
    assert.equal(saved.scene_assets[0]?.creator, "Real creator");
    assert.equal(saved.scene_assets[0]?.creator_url, "https://www.pexels.com/@real-creator");
    assert.equal(saved.scene_assets[0]?.preview_url, "https://images.pexels.com/preview-1.jpg");
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

  it("refuses a changed formal planning document before serving its bytes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-planning-read-"));
    const run = waitingRun(workspaceRoot);
    const documentPath = path.join(workspaceRoot, "runs", "run-1", "planning", "treatment.json");
    const content = JSON.stringify({ viewerPromise: "原来的观众承诺" });
    await mkdir(path.dirname(documentPath), { recursive: true });
    await writeFile(documentPath, content, "utf8");
    const pipeline = new FakePipeline({ ...run, artifacts: [{
      id: "planning-treatment", kind: "creative_treatment", uri: documentPath,
      createdAt: run.startedAt, contentType: "application/json", ...fileIntegrity(content),
      producer: { nodeId: "creative-planning", attempt: 1 }, provenance: { providerId: "treatment" },
    }] });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: allCommandsAvailable, environment: {} });
    assert.equal((await service.resolveArtifact("run-1", "planning-treatment"))?.sizeBytes, Buffer.byteLength(content));
    await writeFile(documentPath, JSON.stringify({ viewerPromise: "被替换的观众承诺" }), "utf8");
    await assert.rejects(() => service.resolveArtifact("run-1", "planning-treatment"), /与登记记录不一致/);
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
        SEEDREAM_MODEL_ID: "doubao-seedream-4-0-250828",
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
    assert.ok(seedream?.modes?.includes("参考图再生成"));
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
        audienceDemand: 70,
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

    const firstCandidates = await service.listTrendCandidates();
    assert.ok(firstCandidates[0]?.generationId);
    assert.deepEqual(firstCandidates.map(({ generationId: _generationId, ...value }) => value), [candidate]);
    assert.deepEqual(await service.listTrendCandidates(), firstCandidates);
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

function textRecoveryRun(workspaceRoot: string, status: "failed" | "paused"): WorkflowRun<ProductionBrief> {
  const run = executableWaitingRun(workspaceRoot);
  run.status = status;
  run.nodeRuns.push({
    nodeId: "creative-planning",
    status: "failed",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    operationRequestId: "script-workflow-operation-current",
    artifactIds: [],
    qualityGateResults: [],
    error: "模型任务结果未知",
  });
  return run;
}

async function writePendingTextCheckpoint(
  workspaceRoot: string,
  operation: CodexPreparedOperation,
  options: {
    checkpointKey?: string;
    nodeId?: string;
    role?: string;
    phase?: "produce" | "audit";
    workflowOperationRequestId?: string;
    failedOperationRequestIds?: Record<string, string>;
  } = {},
): Promise<void> {
  const nodeId = options.nodeId ?? "creative-planning";
  const phase = options.phase ?? "produce";
  const operationKey = `0:1:${phase}`;
  const directory = path.join(workspaceRoot, "runs", "run-1", "nodes", nodeId, "agent-loop-checkpoints");
  const checkpointKey = options.checkpointKey ?? "d".repeat(64);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${checkpointKey}.json`), JSON.stringify({
    version: "video-factory/agent-loop-checkpoint-v8",
    key: checkpointKey,
    contractDigest: "fixture-contract",
    role: options.role ?? "编剧",
    maxIterations: 3,
    cycle: 0,
    status: "failed",
    completed: [],
    operationGenerations: { [operationKey]: 0 },
    ...(options.failedOperationRequestIds
      ? {
        failedOperationRequestIds: options.failedOperationRequestIds,
        failure: { stage: "not_accepted", failureKind: "model_provider_transient" },
      }
      : {}),
    phaseAttempts: { produce: phase === "produce" ? 1 : 0, audit: phase === "audit" ? 1 : 0 },
    recoveryOwner: {
      runId: "run-1",
      nodeId,
      workflowOperationRequestId: options.workflowOperationRequestId ?? "script-workflow-operation-current",
    },
    pendingOperation: {
      phase,
      iteration: 1,
      operationKey,
      generation: 0,
      operation,
    },
  }), "utf8");
}

/** 一份形状合法的未决付费操作。requestId 就是将来拿去向 broker 对账的那个身份。 */
function preparedTextOperation(kind: CodexPreparedOperation["kind"], requestId: string): CodexPreparedOperation {
  const storeId = `vfs_store_${"b".repeat(32)}`;
  const brokerBinding = {
    version: "video-factory/task-binding-v1" as const,
    storeId,
    providerId: "openai",
    modelId: "gpt-test",
  };
  return {
    version: "video-factory/codex-prepared-operation-v1",
    requestId,
    kind,
    envelope: { protocolVersion: "video-factory/codex-bridge-v2", requestId, kind, payload: { brief: { title: "未决任务" } } },
    serializedEnvelope: "{\"brief\":{\"title\":\"未决任务\"}}",
    binding: {
      version: "video-factory/task-binding-v1",
      storeId,
      providerId: "openai",
      modelId: "gpt-test",
      requestDigest: "a".repeat(64),
      kind,
      contractDigest: null,
      sessionDigest: "c".repeat(64),
    },
    brokerBinding,
    route: { socketPath: "/private/runtime/worker.sock" },
    taskFact: "accepted_unknown",
  };
}

function scriptDraftOperation(requestId: string): CodexPreparedOperation {
  return preparedTextOperation("script-draft", requestId);
}

function roleAuditOperation(requestId: string): CodexPreparedOperation {
  return preparedTextOperation("role-audit", requestId);
}

async function startTextRecoveryBridge(
  onQuery?: () => void | Promise<void>,
  initialTaskState: "running" | "completed_success" | "completed_failure" | "not_accepted" | "query_failure" = "completed_success",
): Promise<{
  socketPath: string;
  operation?: CodexPreparedOperation;
  taskState: "running" | "completed_success" | "completed_failure" | "not_accepted" | "query_failure";
  readonly posts: number;
  readonly queries: number;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-text-recovery-bridge-"));
  const socketPath = path.join(directory, "worker.sock");
  let operation: CodexPreparedOperation | undefined;
  let taskState = initialTaskState;
  let posts = 0;
  let queries = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "video-factory/codex-bridge-v2",
        taskBindingVersion: "video-factory/task-binding-v1",
        storeId: `vfs_store_${"c".repeat(32)}`,
        providerId: "openai",
        modelId: "gpt-5.4",
        taskKinds: ["script-draft"],
        taskContracts: { "script-draft": REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"] },
      }));
      return;
    }
    if (request.method === "POST") {
      posts += 1;
      response.writeHead(500);
      response.end();
      return;
    }
    queries += 1;
    const responseState = taskState;
    await onQuery?.();
    if (responseState === "query_failure") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      state: responseState,
      requestId: operation?.requestId,
      binding: operation?.binding,
      ...(responseState === "completed_success" ? {
        ok: true,
        output: "{}",
        trace: {
        taskKind: "script-draft",
        promptVersion: "fixture",
        contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["script-draft"],
        prompt: "fixture",
        providerId: "openai",
        modelId: "gpt-5.4",
        },
      } : responseState === "completed_failure" ? {
        outcome: {
          stage: "execute",
          message: "Provider unavailable",
          failureKind: "model_provider_transient",
        },
      } : responseState === "not_accepted" ? { accepted: false } : {}),
    }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    get operation() { return operation; },
    set operation(value) { operation = value; },
    get taskState() { return taskState; },
    set taskState(value) { taskState = value; },
    get posts() { return posts; },
    get queries() { return queries; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
