import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  CodexAssetSemanticRanker,
  CodexScreenwriterAgent,
  deterministicAssetRanking,
  ProductionPipeline,
  REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
  type CodexPreparedOperation,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskRequestOptions,
  type CodexTaskSession,
  type AssetCandidateReport,
  type AssetSemanticRanker,
  type CreativeTreatment,
  type ProductionBrief,
  type ProductionProviderRuntimeMetadata,
  type VisualAssetProviderCapability,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "@video-factory/production-pipeline";
import { CodexBrokerServer } from "../../codex-broker/src/broker-server.js";
import {
  CodexExecutorError,
  type BrokerTaskExecutor,
  type CodexExecutionResult,
  type CodexExecutionOptions,
  type ValidatedTask,
} from "../../codex-broker/src/codex-executor.js";
import { ProductionStudio } from "../src/server/production-studio.js";
import { StudioService } from "../src/server/studio-service.js";

const SCRIPT = {
  viewerPromise: "看完能理解三个动作",
  narrativeArc: "问题-动作-结论",
  canonFacts: [],
  scenes: [1, 2, 3].map((position) => ({
    position,
    purpose: `第${position}段`,
    narration: `第${position}段旁白内容`,
    duration: 8,
    visual_strategy: "local" as const,
    visual_prompt: `第${position}段真实动作`,
    search_terms: [`动作 ${position}`],
  })),
};

const CREATIVE_DIMENSION_EVIDENCE: Record<string, string> = {
  attention: "前两秒给出本片承诺里的具体动作。",
  progression: "三段之间有可辨认的推进。",
  payoff: "结尾兑现了观众承诺。",
  expression: "画面要求在当前素材能力内可落地。",
};

// 编剧属于创作交付：宿主只要求一个根对象，维度固定为四维创作维度。
// rubric v1 要求总分等于全部维度分的最低分；让每维都取同一个分数，最小值自然成立。
function screenwriterAssessments(score: number) {
  return [{
    targetPath: "",
    dimensions: Object.entries(CREATIVE_DIMENSION_EVIDENCE).map(([dimension, evidence]) => ({ dimension, score, evidence })),
  }];
}

const PASS_AUDIT = {
  version: "video-factory/role-audit-v2",
  rubricVersion: "video-factory/role-quality-rubric-v1",
  verdict: "pass",
  score: 92,
  assessments: screenwriterAssessments(92),
  summary: "当前合同可执行。",
  issues: [],
  repairInstructions: [],
  planningDisposition: null,
} as const;

const NEEDS_SOURCE_AUDIT = {
  version: "video-factory/role-audit-v2",
  rubricVersion: "video-factory/role-quality-rubric-v1",
  verdict: "repair",
  score: 58,
  assessments: screenwriterAssessments(58),
  summary: "核心承诺需要当前流水线没有的真实记录。",
  issues: [{
    severity: "blocking",
    criterion: "真实结果必须有可追溯来源",
    evidence: "输入没有提供真实记录，也没有声明可执行的采集能力。",
    repairInstruction: "补充可追溯的真实记录，或由用户确认改动既定承诺。",
  }],
  repairInstructions: ["补充可追溯的真实记录。"],
  planningDisposition: { action: "needs_source", issueIndexes: [0] },
} as const;

class RecoveryWorker {
  readonly calls: string[] = [];

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    this.calls.push(capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected capability: ${capability}`);
    const content = capability === "video.render" ? "video" : JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    await writeFile(primaryPath, content);
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "audio");
    if (capability === "video.render") await writeFile(String(output.renderManifestPath), "{}");
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [{
        kind: capability.replace(".", "_"),
        uri: primaryPath,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        contentType: capability === "video.render" ? "video/mp4" : "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }],
    };
  }
}

class TrackingClient extends CodexBridgeClient {
  readonly submissions: Array<{ kind: CodexTaskKind; requestId: string }> = [];
  readonly observations: string[] = [];
  readonly observedFailureKinds: Array<string | undefined> = [];

  override async observePrepared(
    operation: CodexPreparedOperation,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    this.observations.push(operation.requestId);
    try {
      return await super.observePrepared(operation, requestOptions);
    } catch (error) {
      this.observedFailureKinds.push(error instanceof CodexBridgeError ? error.failureKind : undefined);
      throw error;
    }
  }

  override async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string,
    session?: CodexTaskSession,
    requestOptions: CodexTaskRequestOptions = {},
  ): Promise<CodexTaskExecution> {
    this.submissions.push({ kind, requestId });
    return super.runTaskDetailed(kind, payload, requestId, session, requestOptions);
  }
}

// 只在外部素材/模型边界替身；排序、持久化、Broker、Studio 恢复与规划图均走正式实现。
class RankingRecoveryWorker extends RecoveryWorker {
  override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    if (request.capability !== "asset.search") return super.run(request);
    this.calls.push("asset.search");
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const candidateSearchPath = path.join(outputDir, "candidates.json");
    const candidateInventoryPath = path.join(outputDir, "inventory.json");
    const content = JSON.stringify({
      version: "video-factory/asset-candidates-v1",
      scene_candidates: [1, 2, 3].map(position => ({
        scene_position: position, intent: { query: `local-${position}` }, query: `local-${position}`,
        candidates: Array.from({ length: 6 }, (_, index) => ({
          provider: "pexels", provider_id: "pexels-stock-v1", asset_id: `${position}-${index}`,
          media_type: "video", width: 1080, height: 1920, duration: 8,
          preview_url: `https://images.pexels.com/${position}-${index}.jpg`,
          source_url: `https://www.pexels.com/video/${position}-${index}`,
          creator: "Fixture", license_note: "Integration fixture", query: `local-${position}`, score: 80,
        })),
      })),
    });
    await writeFile(candidateSearchPath, content);
    await writeFile(candidateInventoryPath, JSON.stringify({ items: [] }));
    return {
      protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded",
      output: { candidateSearchPath, candidateInventoryPath },
      artifacts: [{ kind: "asset_candidates", uri: candidateSearchPath,
        sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content),
        contentType: "application/json", provenance: { providerId: "asset-candidate-search-v1",
          producerNodeId: String(request.nodeRunId), attempt: Number(request.attempt), licenseNote: "Integration fixture" } }],
    };
  }
}

class SupplementInterruptingClient extends TrackingClient {
  private rankingAudits = 0;

  override async runTaskDetailed(kind: CodexTaskKind, payload: unknown, requestId: string,
    session?: CodexTaskSession, options: CodexTaskRequestOptions = {}): Promise<CodexTaskExecution> {
    const isRankingAudit = kind === "role-audit" && (payload as { role?: string }).role === "候选画面复核";
    if (isRankingAudit) this.rankingAudits++;
    return super.runTaskDetailed(kind, payload, requestId, session,
      isRankingAudit && this.rankingAudits === 2 ? { ...options, timeoutMs: 1_000 } : options);
  }
}

class SupplementExecutor implements BrokerTaskExecutor {
  readonly identity = { profileId: "openai" as const, providerId: "openai", modelId: "integration-model",
    taskKinds: ["script-draft", "role-audit", "asset-rank"] };
  readonly submissions: string[] = [];
  private rankingAudits = 0;
  private outcome: "completed_success" | "completed_failure" = "completed_success";
  private release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  complete(outcome: "completed_success" | "completed_failure"): void {
    this.outcome = outcome;
    this.release();
  }

  async runTask(task: ValidatedTask, options?: CodexExecutionOptions): Promise<CodexExecutionResult> {
    this.submissions.push(task.kind);
    const isRankingAudit = task.kind === "role-audit" && task.payload.role === "候选画面复核";
    if (isRankingAudit && ++this.rankingAudits === 2) {
      await this.gate;
      if (this.outcome === "completed_failure") {
        throw new CodexExecutorError("Provider timeout", true, { failureKind: "model_provider_no_output" });
      }
    }
    const output = task.kind === "script-draft" ? SCRIPT
      : task.kind === "asset-rank" ? { ...deterministicAssetRanking(task.payload as AssetCandidateReport), source: "model" }
        : isRankingAudit ? { ...PASS_AUDIT, assessments: [{ targetPath: "", dimensions:
          ["evidence", "coverage", "consistency", "actionability"].map(dimension => ({ dimension, score: 92, evidence: "保留候选并诚实标记缺证据。" })) }] }
          : PASS_AUDIT;
    return { output: JSON.stringify(output), sessionId: options?.sessionId ?? randomUUID(), trace: { taskKind: task.kind,
      promptVersion: `integration/${task.kind}`, contractDigest: task.expectedContractDigest,
      prompt: "integration fixture", providerId: "openai", modelId: "integration-model" } };
  }
}

class ControlledExecutor implements BrokerTaskExecutor {
  readonly identity = {
    profileId: "openai" as const,
    providerId: "openai",
    modelId: "integration-model",
    taskKinds: ["script-draft", "role-audit"],
  };
  readonly submissions: Array<{ kind: string; requestId: string }> = [];
  private firstStarted = false;
  private signalFirstStarted!: () => void;
  private readonly firstStartedGate = new Promise<void>((resolve) => { this.signalFirstStarted = resolve; });
  private firstOutcome: "completed_success" | "completed_failure" | undefined;
  private releaseFirst!: () => void;
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  completeFirst(outcome: "completed_success" | "completed_failure"): void {
    this.firstOutcome = outcome;
    this.releaseFirst();
  }

  waitForFirstStarted(): Promise<void> {
    return this.firstStartedGate;
  }

  async runTask(task: ValidatedTask): Promise<CodexExecutionResult> {
    this.submissions.push({ kind: task.kind, requestId: `${task.kind}-${this.submissions.length + 1}` });
    if (!this.firstStarted) {
      this.firstStarted = true;
      this.signalFirstStarted();
      await this.firstGate;
      if (this.firstOutcome === "completed_failure") {
        throw new CodexExecutorError("Provider unavailable", true, {
          failureKind: "model_provider_transient",
          details: {
            category: "timeout",
            reasonCode: "provider_timeout",
            providerId: "openai",
            modelId: "integration-model",
          },
        });
      }
    }
    return {
      output: JSON.stringify(task.kind === "script-draft" ? SCRIPT : PASS_AUDIT),
      trace: {
        taskKind: task.kind,
        promptVersion: `integration/${task.kind}`,
        contractDigest: task.expectedContractDigest,
        prompt: "integration fixture",
        providerId: "openai",
        modelId: "integration-model",
      },
    };
  }
}

class PlanningHaltExecutor implements BrokerTaskExecutor {
  readonly identity = {
    profileId: "openai" as const,
    providerId: "openai",
    modelId: "integration-model",
    taskKinds: ["script-draft", "role-audit"],
  };
  readonly submissions: string[] = [];

  async runTask(task: ValidatedTask): Promise<CodexExecutionResult> {
    this.submissions.push(task.kind);
    return {
      output: JSON.stringify(task.kind === "script-draft" ? SCRIPT : NEEDS_SOURCE_AUDIT),
      trace: {
        taskKind: task.kind,
        promptVersion: `integration/${task.kind}`,
        contractDigest: task.expectedContractDigest,
        prompt: "integration fixture",
        providerId: "openai",
        modelId: "integration-model",
      },
    };
  }
}

function treatment(counter: { calls: number }): CreativeTreatment {
  counter.calls += 1;
  return {
    version: "video-factory/creative-treatment-v2",
    viewerPromise: "看完能理解三个动作",
    hook: { narrationIntent: "直接提出问题", visualIntent: "真实动作开场" },
    progression: [1, 2, 3].map((index) => ({ beatId: `beat-${index}`, purpose: "推进", viewerGain: "理解动作" })),
    payoff: "得到行动结论",
    visualPrinciples: ["真实"],
    soundPrinciples: ["自然"],
    evidenceRequirements: [],
    feasibilityQuestions: [],
  };
}

function auditedUpstream<T>(output: T, role: string): CodexTaskExecution<T> {
  return { output, trace: {
    taskKind: role === "导演前期构思" ? "creative-treatment" : "director-plan",
    promptVersion: "integration/upstream", prompt: "integration fixture", providerId: "openai", modelId: "integration-model",
  }, agentLoop: {
    version: "video-factory/agent-loop-v1", role, contractVersion: "integration/upstream-review",
    criteria: ["确认上游测试稿"], status: "passed", maxIterations: 1,
    producerModelCallCount: 0, auditModelCallCount: 1,
    iterations: [{ iteration: 1, candidate: output,
      candidateHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      auditTrace: { taskKind: "role-audit", promptVersion: "integration/role-audit",
        prompt: "integration fixture", providerId: "openai", modelId: "integration-model" },
      audit: { ...PASS_AUDIT, assessments: [{ targetPath: "", dimensions:
        (["attention", "progression", "payoff", "expression"] as const).map(dimension => ({ dimension, score: 92, evidence: "上游测试稿保持不变。" })) }],
      issues: [], repairInstructions: [] },
    }],
  } };
}

function brief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "正式恢复链路",
    angle: "验证迟到文本任务",
    audience: "创作者",
    nicheSlug: "recovery",
    platform: "douyin",
    durationSeconds: 24,
    durationRange: { minSeconds: 20, maxSeconds: 34 },
    reviewMode: "manual",
    runPurpose: "test",
    providers: {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
      assets: "local-editorial-v1",
      voice: "macos-say-v1",
      render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1",
    },
    workflowFeatures: { creativePlanning: "joint-v1", executablePlan: true, assetSemanticRank: false, referenceGrammar: false },
    director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
  } as ProductionBrief;
}

function pipeline(
  workspaceRoot: string,
  client: CodexBridgeClient,
  treatmentCounter: { calls: number },
  checkpointRecoveryRequestIds?: Array<string | undefined>,
  worker: RecoveryWorker = new RecoveryWorker(),
  capabilityOverrides: {
    assetProviders?: VisualAssetProviderCapability[];
    providerRuntimeMetadata?: ProductionProviderRuntimeMetadata[];
    assetSemanticRanker?: AssetSemanticRanker;
  } = {},
): ProductionPipeline {
  const screenwriter = new CodexScreenwriterAgent({
    client,
    auditClient: client,
    modelId: "integration-model",
    sessionMode: "stateless",
    timeoutMs: 100,
  });
  return new ProductionPipeline({
    workspaceRoot,
    worker,
    screenwriterAgent: checkpointRecoveryRequestIds ? {
      id: screenwriter.id,
      modelId: screenwriter.modelId,
      draft: (input) => screenwriter.draft(input),
      draftDetailed: (input) => {
        checkpointRecoveryRequestIds.push(input.agentLoopCheckpoint?.resumeCompletedFailureRequestId);
        return screenwriter.draftDetailed(input);
      },
    } : screenwriter,
    treatmentAgents: [{
      providerId: "openai",
      agent: {
        id: "codex-creative-treatment-v1",
        modelId: "integration-model",
        treat: async () => treatment(treatmentCounter),
        treatDetailed: async (input) => input.creativeReviewExecution?.mode === "check"
          ? auditedUpstream(input.creativeReviewExecution.candidate, "导演前期构思")
          : ({
          output: treatment(treatmentCounter),
          trace: {
            taskKind: "creative-treatment" as const,
            promptVersion: "integration/creative-treatment",
            contractDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["creative-treatment"],
            prompt: "integration fixture",
            providerId: "openai",
            modelId: "integration-model",
          },
        }),
      },
    }],
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "integration-model",
      async planDetailed(input) {
        return input.creativeReviewExecution?.mode === "check"
          ? auditedUpstream(input.creativeReviewExecution.candidate, "视觉导演")
          : { output: await this.plan(input) };
      },
      plan: async (input: VisualDirectorAgentInput) => ({
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "本地确定性测试",
        visualBible: { narrativeApproach: "观察", pacing: "自然", composition: "中景", camera: "固定", color: "自然", continuity: "连续", sound: "环境" },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative" as const,
          preferredProviderId: capabilityOverrides.assetSemanticRanker ? "pexels-stock-v1" : "local-editorial-v1",
          deliveryType: capabilityOverrides.assetSemanticRanker ? "stock_video" as const : "editorial_card" as const,
          alternativeProviderIds: [],
          query: `local-${scene.position}`,
          generationPrompt: `第${scene.position}段真实动作`,
          rationale: "本地说明画面",
          continuityNote: "连续",
          confidence: 0.9,
          estimatedCostCny: 0,
          temporalBeats: [{ startSeconds: 0, endSeconds: scene.duration, action: "展示动作" }],
        })),
      }),
    },
    assetProviders: capabilityOverrides.assetProviders
      ?? [{ id: "local-editorial-v1", label: "本地画面", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] }],
    ...(capabilityOverrides.assetSemanticRanker ? { assetSemanticRanker: capabilityOverrides.assetSemanticRanker } : {}),
    ...(capabilityOverrides.providerRuntimeMetadata
      ? { providerRuntimeMetadata: capabilityOverrides.providerRuntimeMetadata }
      : {}),
  });
}

async function brokerFixture(workspaceRoot: string) {
  const socketPath = path.join(workspaceRoot, "recovery-broker.sock");
  const executor = new ControlledExecutor();
  const server = new CodexBrokerServer({
    socketPath,
    executor,
    idempotencyDirectory: path.join(workspaceRoot, "broker-durable"),
    sessionDirectory: path.join(workspaceRoot, "broker-sessions"),
  });
  await server.start();
  return {
    socketPath,
    executor,
    close: () => server.close(),
  };
}

async function brokerWithExecutor(workspaceRoot: string, executor: BrokerTaskExecutor) {
  const socketPath = path.join(workspaceRoot, "b.sock");
  const server = new CodexBrokerServer({
    socketPath,
    executor,
    idempotencyDirectory: path.join(workspaceRoot, "planning-halt-durable"),
    sessionDirectory: path.join(workspaceRoot, "planning-halt-sessions"),
  });
  await server.start();
  return { socketPath, close: () => server.close() };
}

async function waitForStopped(runPipeline: ProductionPipeline, runId: string) {
  // 同上：等待预算按墙钟计，否则整门禁并发时固定的 100 次轮询撑不住流水线落定所需的时间。
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    const run = await runPipeline.show(runId);
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("production recovery did not reach a stopped state");
}

async function movePendingToOldContractFile(workspaceRoot: string, runId: string): Promise<void> {
  const directory = path.join(workspaceRoot, "runs", runId, "nodes", "creative-planning", "agent-loop-checkpoints");
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const source = path.join(directory, name);
    const value = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    if (!value.pendingOperation || value.role !== "编剧") continue;
    const oldKey = "f".repeat(64);
    value.key = oldKey;
    // 旧合同文件必须具有一致的物理身份，不能留下原文件的 storageKey 来伪造迁移状态。
    value.storageKey = oldKey;
    value.contractDigest = "e".repeat(64);
    const destination = path.join(directory, `${oldKey}.json`);
    await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
    await rm(source);
    return;
  }
  throw new Error("pending screenwriter checkpoint was not found");
}

describe("formal text-task recovery through Studio and joint-v1 pipeline", () => {
  for (const terminalState of ["completed_success", "completed_failure"] as const) {
    it(`recovers a late supplementary ranking audit ${terminalState} through Studio without rerunning upstream`, async (t) => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-supplement-studio-"));
      const executor = new SupplementExecutor();
      const broker = await brokerWithExecutor(workspaceRoot, executor);
      const counter = { calls: 0 };
      const worker = new RankingRecoveryWorker();
      const createPipeline = (client: CodexBridgeClient) => pipeline(workspaceRoot, client, counter, undefined, worker, {
        assetSemanticRanker: new CodexAssetSemanticRanker({ client, modelId: "integration-model",
          fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]) }),
        assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] }],
      });
      try {
        const initialClient = new SupplementInterruptingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
        const initialPipeline = createPipeline(initialClient);
        const input = brief();
        input.providers.assets = "ai-shot-router-v1";
        input.workflowFeatures!.assetSemanticRank = true;
        input.workflowFeatures!.creativeReview = "user-confirmed-v1";
        input.director!.assetProviderIds = ["pexels-stock-v1"];
        let failed = await initialPipeline.start(input);
        for (let stage = 0; stage < 3 && failed.status === "needs_human"; stage++) {
          const node = failed.nodeRuns.find(n => n.nodeId === "creative-planning");
          const gate = node?.intervention?.continuation;
          assert.ok(gate);
          const review = (node.output as { creativeReview: { stages: Record<string, {
            checkResult?: { verdict: string; checkIdentity?: string };
          }> } }).creativeReview.stages[gate.stage]?.checkResult;
          failed = await initialPipeline.confirmCreativeReview(failed.id, {
            commandId: `confirm-${stage}`, actor: "creator", stage: gate.stage,
            expectedRunRevision: failed.revision, expectedReviewRevision: gate.reviewRevision,
            baseDraftSha256: gate.draftSha256,
            ...(review?.checkIdentity ? { expectedCheckIdentity: review.checkIdentity } : { acknowledgeUnaudited: true }),
            ...(review?.verdict === "repair" ? { acknowledgeRepair: true } : {}),
          });
        }
        assert.equal(failed.status, "failed");
        assert.equal(initialClient.submissions.length, 6, JSON.stringify(failed.nodeRuns.map(n => ({ nodeId: n.nodeId, error: n.error }))));
        const originalRequestId = initialClient.submissions.at(-1)!.requestId;
        const upstreamCalls = counter.calls;
        assert.deepEqual(worker.calls, ["asset.search"]);

        const resumedClient = new TrackingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
        const resumedPipeline = createPipeline(resumedClient);
        const studio = new ProductionStudio({ workspaceRoot, pipeline: resumedPipeline,
          archiveStore: { list: async () => ({}) } as never, listProviders: async () => [] });
        assert.deepEqual((await studio.get(failed.id))?.taskRecovery?.allowedActions, ["query_original_task"]);
        await assert.rejects(studio.retryFailedNode(failed.id, "creative-planning"), /请先查询原任务/);
        assert.equal((await studio.queryOriginalTextTask(failed.id)).taskRecovery?.taskState, "running");
        assert.equal(executor.submissions.length, 6, "querying cannot submit another model request");

        // 只推进时钟，不改写 checkpoint；恢复必须消费原结果并保留耗尽的补看预算。
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 600_001 });
        executor.complete(terminalState);
        let queried = await studio.queryOriginalTextTask(failed.id);
        for (let attempt = 0; attempt < 100 && queried.taskRecovery?.taskState !== terminalState; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          queried = await studio.queryOriginalTextTask(failed.id);
        }
        assert.equal(queried.taskRecovery?.taskState, terminalState);
        if (terminalState === "completed_success") await studio.retrieveOriginalTextTask(failed.id);
        else await studio.retryFailedNode(failed.id, "creative-planning");
        const recovered = await waitForStopped(resumedPipeline, failed.id);
        assert.equal(recovered.status, "needs_human", JSON.stringify(recovered.nodeRuns.map(n => ({ nodeId: n.nodeId, status: n.status, error: n.error }))));
        assert.equal(counter.calls, upstreamCalls, "accepted treatment is retained");
        assert.deepEqual(worker.calls, ["asset.search"], "candidate search and media acquisition must not restart");
        assert.deepEqual(resumedClient.submissions, [], "expired ranking budget must not submit replacement or follow-up tasks");
        assert.deepEqual(resumedClient.observations, [originalRequestId]);
        assert.equal(executor.submissions.length, 6);
      } finally {
        executor.complete(terminalState);
        await broker.close();
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }

  it("settles a first-produce terminal failure through the real socket and releases the run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f05-"));
    const broker = await brokerFixture(workspaceRoot);
    const client = new TrackingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
    const treatmentCounter = { calls: 0 };
    const worker = new RecoveryWorker();
    try {
      broker.executor.completeFirst("completed_failure");
      const currentPipeline = pipeline(workspaceRoot, client, treatmentCounter, undefined, worker);
      const dispatched = await currentPipeline.dispatch(brief());
      const failed = await dispatched.completion;
      assert.equal(dispatched.runId, failed.id);

      assert.equal(failed.status, "failed");
      assert.equal(treatmentCounter.calls, 1);
      assert.deepEqual(broker.executor.submissions.map((entry) => entry.kind), ["script-draft"]);
      assert.deepEqual(worker.calls, []);
      const planningNode = failed.nodeRuns.find((node) => node.nodeId === "creative-planning");
      assert.equal(planningNode?.status, "failed");
      assert.match(planningNode?.error ?? "", /模型调用超时/);
      assert.match(planningNode?.error ?? "", /failureKind=model_provider_transient/);
      assert.equal(planningNode?.executionReceipt?.parameters?.modelCallCount, 1, "the accepted first produce is a proven physical model execution even without a candidate trace");
      assert.equal(planningNode?.executionReceipt?.parameters?.producerModelCallCount, 1);
      assert.equal(planningNode?.executionReceipt?.parameters?.auditModelCallCount, 0);
      assert.equal(planningNode?.executionReceipt?.parameters?.unknownModelExecutionCount, 0);
      await assert.rejects(
        () => readFile(path.join(workspaceRoot, "runs", failed.id, "run.lock"), "utf8"),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );

      const checkpointDirectory = path.join(workspaceRoot, "runs", failed.id, "nodes", "creative-planning", "agent-loop-checkpoints");
      const checkpoints = await Promise.all((await readdir(checkpointDirectory)).filter((name) => name.endsWith(".json")).map(async (name) => (
        JSON.parse(await readFile(path.join(checkpointDirectory, name), "utf8")) as Record<string, unknown>
      )));
      const scriptCheckpoint = checkpoints.find((checkpoint) => checkpoint.role === "编剧");
      assert.equal(scriptCheckpoint?.status, "failed");
      const failure = scriptCheckpoint?.failure as { details?: { queueWaitMs?: number }; summary?: string } | undefined;
      assert.ok(Number.isInteger(failure?.details?.queueWaitMs) && failure!.details!.queueWaitMs! >= 0);
      // 面向创作者的中文说明也随机器诊断一起落盘。节点失败拖垮整条 run 时原因会走 node.error，
      // 可节点活下来接着往下走时 checkpoint 是唯一通道；这里钉住它确实穿过了真实 socket 与节点，
      // 具体措辞由 role-agent-loop 的单测负责。
      assert.match(failure?.summary ?? "", /模型调用超时/);
      assert.deepEqual({
        ...(scriptCheckpoint?.failure as Record<string, unknown>),
        summary: "creator-facing",
        details: {
          ...((scriptCheckpoint?.failure as { details?: Record<string, unknown> } | undefined)?.details ?? {}),
          queueWaitMs: "measured",
        },
      }, {
        stage: "completed_failure",
        statusCode: 422,
        failureKind: "model_provider_transient",
        summary: "creator-facing",
        details: {
          category: "timeout",
          reasonCode: "provider_timeout",
          providerId: "openai",
          modelId: "integration-model",
          queueWaitMs: "measured",
        },
      });

      const studio = new StudioService({ workspaceRoot, pipeline: currentPipeline, commandAvailable: async () => true, environment: {} });
      const detail = await studio.getRun(failed.id);
      assert.equal(detail?.status, "failed");
      assert.equal(detail?.failure?.retryable, true);
      assert.match(detail?.failure?.technicalDetail ?? "", /failureKind=model_provider_transient/);
      assert.equal(detail?.planningStages?.find((stage) => stage.id === "treatment")?.status, "completed");
      assert.equal(detail?.planningStages?.find((stage) => stage.id === "script")?.status, "failed");
      assert.match(detail?.planningStages?.find((stage) => stage.id === "script")?.issue ?? "", /模型调用超时/);
    } finally {
      await broker.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves a redacted Broker field diagnostic through the real node and Studio reload", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-formal-contract-diagnostic-"));
    const executor = new PlanningHaltExecutor();
    const broker = await brokerWithExecutor(workspaceRoot, executor);
    const client = new TrackingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
    const treatmentCounter = { calls: 0 };
    const secretMarker = "sk-test-secret";
    const privatePathMarker = "/Users/private/project";
    const invalidRatio = `7:9-${secretMarker}-${privatePathMarker}`;
    try {
      const firstPipeline = pipeline(
        workspaceRoot,
        client,
        treatmentCounter,
        undefined,
        new RecoveryWorker(),
        {
          providerRuntimeMetadata: [{
            id: "local-editorial-v1",
            label: "本地画面",
            modelId: "invalid-capability-fixture",
            transport: "local_process",
            billing: "free",
            modelProfiles: [{
              modelId: "invalid-capability-fixture",
              estimatedCostCny: 0,
              minDurationSeconds: 1,
              maxDurationSeconds: 30,
              aspectRatios: ["9:16", invalidRatio] as never,
            }],
          }],
        },
      );
      const failed = await firstPipeline.start(brief());
      assert.equal(failed.status, "failed");
      assert.equal(treatmentCounter.calls, 1);
      assert.deepEqual(executor.submissions, [], "Broker must reject the request before invoking the executor");

      const rebuiltPipeline = pipeline(
        workspaceRoot,
        client,
        treatmentCounter,
        undefined,
        new RecoveryWorker(),
        {
          providerRuntimeMetadata: [{
            id: "local-editorial-v1",
            label: "本地画面",
            modelId: "invalid-capability-fixture",
            transport: "local_process",
            billing: "free",
            modelProfiles: [{
              modelId: "invalid-capability-fixture",
              estimatedCostCny: 0,
              minDurationSeconds: 1,
              maxDurationSeconds: 30,
              aspectRatios: ["9:16", invalidRatio] as never,
            }],
          }],
        },
      );
      const studio = new StudioService({ workspaceRoot, pipeline: rebuiltPipeline, commandAvailable: async () => true, environment: {} });
      const detail = await studio.getRun(failed.id);
      const planningNode = detail?.nodes.find((node) => node.id === "creative-planning");
      const diagnostic = `${planningNode?.error ?? ""}\n${detail?.failure?.technicalDetail ?? ""}`;
      assert.match(diagnostic, /httpStatus=400/);
      assert.match(diagnostic, /reasonCode=input_contract/);
      assert.match(diagnostic, /fieldPath=payload\.brief\.productionCapabilities\.assetProviders\[0\]\.aspectRatios/);
      assert.match(diagnostic, /taskKind=script-draft/);
      assert.match(diagnostic, /accepted=false/);
      assert.doesNotMatch(JSON.stringify(detail), new RegExp(secretMarker));
      assert.doesNotMatch(JSON.stringify(detail), new RegExp(privatePathMarker.replaceAll("/", "\\/")));
      assert.equal(planningNode?.agentLoopProgress?.producerModelCallCount, 0);
      assert.equal(planningNode?.agentLoopProgress?.auditModelCallCount, 0);
      assert.deepEqual(executor.submissions, []);
    } finally {
      await broker.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("carries a planning source gap as an advice and still reaches the human review", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-formal-planning-halt-"));
    const executor = new PlanningHaltExecutor();
    const broker = await brokerWithExecutor(workspaceRoot, executor);
    const client = new TrackingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
    const treatmentCounter = { calls: 0 };
    const worker = new RecoveryWorker();
    try {
      const firstPipeline = pipeline(workspaceRoot, client, treatmentCounter, undefined, worker);
      const run = await firstPipeline.start(brief());
      // 来源缺口只作建议：审计判 pass、缺口由它路由出去，规划照常交付（脚本带一条建议），
      // 制作继续跑到人工终审等人裁决。门槛不替创作者决定这条片子能不能开工——建议怎么显示、
      // 确认关怎么呈现，由 creative-planning 的 issues 通道与确认关负责（见 role-agent-loop
      // 与 creative-planning 的用例）。这里钉住的是"它不再拦下制作"这件事。
      assert.equal(run.status, "needs_human");
      assert.equal(treatmentCounter.calls, 1);
      assert.deepEqual(executor.submissions, ["script-draft", "role-audit"]);
      assert.equal(run.artifacts.some((artifact) => artifact.kind === "script"), true);
      assert.equal(run.nodeRuns.find((node) => node.nodeId === "final-review")?.status, "needs_human");
      assert.deepEqual(worker.calls, ["asset.prepare", "voice.synthesize", "video.render", "quality.review"]);
      const planningReceipt = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.executionReceipt;
      assert.equal(planningReceipt?.parameters?.modelCallCount, 2);
      assert.equal(planningReceipt?.parameters?.producerModelCallCount, 1);
      assert.equal(planningReceipt?.parameters?.auditModelCallCount, 1);

      const rebuiltPipeline = pipeline(workspaceRoot, client, treatmentCounter, undefined, worker);
      const studio = new StudioService({
        workspaceRoot,
        pipeline: rebuiltPipeline,
        commandAvailable: async () => true,
        environment: {},
      });
      const detail = await studio.getRun(run.id);
      // 缺口没有被记成规划失败，也没有变成 run 的失败：规划节点成功收口在"等创作者裁决"。
      assert.equal(detail?.failure, undefined);
      assert.equal(detail?.nodes.find((node) => node.id === "creative-planning")?.status, "succeeded");
      assert.equal(detail?.nodes.find((node) => node.id === "creative-planning")?.agentLoopProgress?.phase, "awaiting_user");
      // 重开也不会把已经花掉的生产者与审计请求再花一遍。
      assert.deepEqual(executor.submissions, ["script-draft", "role-audit"]);
    } finally {
      await broker.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  for (const terminalState of ["completed_success", "completed_failure"] as const) {
    it(`consumes one late ${terminalState} result and advances the real workflow once`, async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), `vf-formal-${terminalState}-`));
      const broker = await brokerFixture(workspaceRoot);
      const treatmentCounter = { calls: 0 };
      try {
        const interrupting = new TrackingClient({
          socketPath: broker.socketPath,
          timeoutMs: 50,
          maxAttempts: 1,
          pollIntervalMs: 10,
        });
        const firstPipeline = pipeline(workspaceRoot, interrupting, treatmentCounter);
        const initialDispatch = await firstPipeline.dispatch(brief());
        await broker.executor.waitForFirstStarted();
        const failed = await initialDispatch.completion;
        assert.equal(failed.status, "failed");
        assert.equal(treatmentCounter.calls, 1);
        const originalRequestId = interrupting.submissions[0]?.requestId;
        assert.ok(originalRequestId, JSON.stringify(failed.nodeRuns.map((node) => ({ nodeId: node.nodeId, status: node.status, error: node.error }))));
        await assert.rejects(
          firstPipeline.applyNodeExecutionConfiguration(failed.id, "creative-planning", brief(), "owner", failed.revision),
          /原模型任务.*查询/,
        );
        assert.equal((await firstPipeline.loadPersisted(failed.id)).revision, failed.revision);
        assert.equal(interrupting.submissions.length, 1, "configuration edits must not escape the original unknown request");
        await movePendingToOldContractFile(workspaceRoot, failed.id);

        broker.executor.completeFirst(terminalState);
        const resumingClient = new TrackingClient({ socketPath: broker.socketPath, timeoutMs: 3_000, maxAttempts: 1, pollIntervalMs: 10 });
        const checkpointRecoveryRequestIds: Array<string | undefined> = [];
        const resumedPipeline = pipeline(workspaceRoot, resumingClient, treatmentCounter, checkpointRecoveryRequestIds);
        let recoveryDispatchOptions: {
          recoverOriginalTextTask?: boolean;
          resumeCompletedTextTask?: boolean;
          resumeCompletedTextTaskRequestId?: string;
        } | undefined;
        const originalDispatchRetry = resumedPipeline.dispatchRetryFailedNode.bind(resumedPipeline);
        resumedPipeline.dispatchRetryFailedNode = async (runId, nodeId, listener, options) => {
          recoveryDispatchOptions = options;
          return originalDispatchRetry(runId, nodeId, listener, options);
        };
        const studio = new ProductionStudio({
          workspaceRoot,
          pipeline: resumedPipeline,
          archiveStore: { list: async () => ({}) } as never,
          listProviders: async () => [],
        });
        const peerPipeline = pipeline(workspaceRoot, resumingClient, treatmentCounter, checkpointRecoveryRequestIds);
        const peerStudio = new ProductionStudio({
          workspaceRoot,
          pipeline: peerPipeline,
          archiveStore: { list: async () => ({}) } as never,
          listProviders: async () => [],
        });
        let queried = await studio.queryOriginalTextTask(failed.id);
        // accepted_unknown 也是"还没落定"：broker 此刻只是还没观察到终态，
        // 只等 running 会在负载高时提前退出，把还没落定的任务当成结论。
        const terminalTaskStates = ["completed_success", "completed_failure", "not_accepted", "conflict"];
        // 按墙钟计预算：整门禁并发时每次查询都要等多出来的磁盘与 CPU 争用，
        // 固定次数在负载下会缩水成几秒，从而把"还没落定"误判成结论。
        for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
          if (terminalTaskStates.includes(queried.taskRecovery?.taskState ?? "")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          queried = await studio.queryOriginalTextTask(failed.id);
        }
        assert.equal(queried.taskRecovery?.taskState, terminalState);
        assert.equal(broker.executor.submissions.length, 1, "querying must not submit another task");

        const recovery = terminalState === "completed_success"
          ? (target: ProductionStudio) => target.retrieveOriginalTextTask(failed.id)
          : (target: ProductionStudio) => target.retryFailedNode(failed.id, "creative-planning");
        const concurrent = await Promise.allSettled([recovery(studio), recovery(peerStudio)]);
        assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "independent Studio instances must not both advance one recovery");
        const dispatched = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof recovery>>> => result.status === "fulfilled")!.value;
        assert.equal(dispatched.status, "running");
        const settled = await waitForStopped(resumedPipeline, failed.id);

        assert.notEqual(settled.status, "failed", JSON.stringify({
          nodes: settled.nodeRuns.map((node) => ({ nodeId: node.nodeId, status: node.status, error: node.error })),
          observedFailureKinds: resumingClient.observedFailureKinds,
          recoveryDispatchOptions,
          checkpointRecoveryRequestIds,
        }));
        assert.equal(treatmentCounter.calls, 1, "accepted upstream treatment must not run again");
        assert.deepEqual(resumingClient.observations, [originalRequestId], JSON.stringify({
          submissions: broker.executor.submissions,
          checkpointRecoveryRequestIds,
          recoveryDispatchOptions,
        }));
        const scriptSubmissions = broker.executor.submissions.filter((entry) => entry.kind === "script-draft");
        assert.equal(scriptSubmissions.length, terminalState === "completed_success" ? 1 : 2);
        if (resumingClient.submissions.find((entry) => entry.kind === "script-draft")) {
          assert.notEqual(resumingClient.submissions.find((entry) => entry.kind === "script-draft")!.requestId, originalRequestId);
        }
        assert.equal(broker.executor.submissions.filter((entry) => entry.kind === "role-audit").length, 1);
        if (terminalState === "completed_failure") {
          assert.equal(recoveryDispatchOptions?.resumeCompletedTextTaskRequestId, originalRequestId);
          assert.ok(checkpointRecoveryRequestIds.includes(originalRequestId), JSON.stringify({
            checkpointRecoveryRequestIds,
            originalRequestId,
            recoveryDispatchOptions,
          }));
        }
      } finally {
        await broker.close();
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});
