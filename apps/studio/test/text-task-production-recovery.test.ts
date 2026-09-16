import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  CodexScreenwriterAgent,
  ProductionPipeline,
  REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
  type CodexPreparedOperation,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskRequestOptions,
  type CodexTaskSession,
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
        treatDetailed: async () => ({
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
          preferredProviderId: "local-editorial-v1",
          deliveryType: "editorial_card" as const,
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
    value.contractDigest = "e".repeat(64);
    const destination = path.join(directory, `${oldKey}.json`);
    await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
    await rm(source);
    return;
  }
  throw new Error("pending screenwriter checkpoint was not found");
}

describe("formal text-task recovery through Studio and joint-v1 pipeline", () => {
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
      const failure = scriptCheckpoint?.failure as { details?: { queueWaitMs?: number } } | undefined;
      assert.ok(Number.isInteger(failure?.details?.queueWaitMs) && failure!.details!.queueWaitMs! >= 0);
      assert.deepEqual({
        ...(scriptCheckpoint?.failure as Record<string, unknown>),
        details: {
          ...((scriptCheckpoint?.failure as { details?: Record<string, unknown> } | undefined)?.details ?? {}),
          queueWaitMs: "measured",
        },
      }, {
        stage: "completed_failure",
        statusCode: 422,
        failureKind: "model_provider_transient",
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
