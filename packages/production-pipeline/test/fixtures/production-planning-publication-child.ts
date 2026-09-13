import { appendFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { CodexBridgeError, ProductionPipeline, type CreativeTreatment, type CreativeTreatmentAgent, type ProductionBrief, type ProductionPipelineOptions, type ScreenwriterAgent, type VisualAssetProviderCapability, type VisualDirectorAgent, type VisualDirectorAgentInput, type WorkerResponse } from "../../src/index.js";

// ---------------------------------------------------------------------------
// B4-R4 真实子进程崩溃夹具：由 production-planning-publication.test.ts 以独立进程运行。
// - 崩溃窗口用 process SIGKILL 硬杀，不用 throw 代替进程死亡；
// - 角色调用写入 side-effect 文件：计数独立于被杀进程，跨进程可核；
// - 恢复阶段以全新替身重入，打印一行 JSON 报告供父进程断言。
// ---------------------------------------------------------------------------

const TREATMENT_PROVIDER_ID = "codex-creative-treatment-v1";

interface ChildArgs {
  phase: "crash" | "recover";
  window: "afterGraph" | "afterArtifacts" | "afterCommit" | "afterSeed" | "afterAccepted";
  workspaceRoot: string;
  runId: string;
  sideEffectFile: string;
  seedFallbackTreatment?: boolean;
}

function parseArgs(argv: readonly string[]): ChildArgs {
  const read = (name: string): string => {
    const prefix = `--${name}=`;
    const value = argv.find((arg) => arg.startsWith(prefix));
    if (!value) throw new Error(`missing --${name}`);
    return value.slice(prefix.length);
  };
  const phase = read("phase");
  if (phase !== "crash" && phase !== "recover") throw new Error(`invalid phase ${phase}`);
  return {
    phase,
    window: read("window") as ChildArgs["window"],
    workspaceRoot: read("workspace"),
    runId: read("run-id"),
    sideEffectFile: read("side-effect"),
    seedFallbackTreatment: argv.includes("--seed-fallback-treatment"),
  };
}

async function recordSideEffect(file: string, entry: string): Promise<void> {
  await appendFile(file, `${entry}\n`, "utf8");
}

function legalTreatment(title: string): CreativeTreatment {
  return {
    version: "video-factory/creative-treatment-v1",
    viewerPromise: "看完能避开三个决策坑",
    hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
    progression: [
      { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
      { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
    ],
    payoff: "低风险决策清单",
    visualPrinciples: ["真实动作"],
    soundPrinciples: ["环境声先行"],
    evidenceRequirements: [],
    feasibilityQuestions: [],
  };
}

class PublicationWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    if (!output) throw new Error(`Unexpected capability: ${capability}`);
    const jsonContent = JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    const primaryContent = capability === "video.render" ? "video" : jsonContent;
    await writeFile(primaryPath, primaryContent);
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "audio");
    if (capability === "video.render") await writeFile(String(output.renderManifestPath), jsonContent);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [{
        kind: capability.replace(".", "_"),
        uri: primaryPath,
        sha256: createHash("sha256").update(primaryContent).digest("hex"),
        sizeBytes: Buffer.byteLength(primaryContent),
        contentType: capability === "video.render" ? "video/mp4" : "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Publication fixture.",
        },
      }],
    };
  }
}

function childAgents(args: ChildArgs): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent"> {
  const treatmentAgents: Array<{ providerId: string; agent: CreativeTreatmentAgent }> = [
    {
      providerId: "openai",
      agent: {
        id: TREATMENT_PROVIDER_ID,
        modelId: "treatment-model-a",
        treat: async () => legalTreatment("joint-v1 发布崩溃恢复"),
        treatDetailed: async (input: { brief: { title: string } }) => {
          await recordSideEffect(args.sideEffectFile, "treatment:treatment-model-a");
          if (args.seedFallbackTreatment) {
            // 首候选瞬时故障：真实 fallback 到候选 B（not_accepted 分类，允许切换）。
            throw new CodexBridgeError("treatment model a connection failed", true, "not_accepted");
          }
          return {
            output: legalTreatment(input.brief.title),
            trace: { taskKind: "creative-treatment" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "treatment-model-a" },
          };
        },
      },
    },
    {
      providerId: "zai-bigmodel-api",
      agent: {
        id: TREATMENT_PROVIDER_ID,
        modelId: "treatment-model-b",
        treat: async () => legalTreatment("joint-v1 发布崩溃恢复"),
        treatDetailed: async (input: { brief: { title: string } }) => {
          await recordSideEffect(args.sideEffectFile, "treatment:treatment-model-b");
          return {
            output: legalTreatment(input.brief.title),
            trace: { taskKind: "creative-treatment" as const, promptVersion: "v1", prompt: "fixture", providerId: "zai-bigmodel-api", modelId: "treatment-model-b" },
          };
        },
      },
    },
  ];
  const screenwriterAgent: ScreenwriterAgent = {
    id: "codex-screenwriter-v1",
    modelId: "screenwriter-model-one",
    draft: async () => {
      throw new Error("publication fixtures must run through draftDetailed");
    },
    draftDetailed: async (input: { brief: { title: string } }) => {
      await recordSideEffect(args.sideEffectFile, "screenwriter");
      return {
        output: {
          viewerPromise: "看完能避开三个决策坑",
          narrativeArc: "问题-方法-清单",
          canonFacts: ["步骤可执行"],
          scenes: [1, 2, 3].map((position) => ({
            position,
            narration: `第${position}段旁白内容`,
            duration: 8,
            visual_strategy: "stock",
            visual_prompt: `第${position}个真实生活动作`,
            search_terms: [`生活动作 ${position}`],
          })),
        },
        trace: { taskKind: "script-draft" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "screenwriter-model-one" },
      };
    },
  } as ScreenwriterAgent;
  const directorAgent: VisualDirectorAgent = {
    id: "api-visual-director-v1",
    modelId: "director-model-one",
    plan: async () => {
      throw new Error("publication fixtures must run through planDetailed");
    },
    planDetailed: async (input: VisualDirectorAgentInput) => {
      await recordSideEffect(args.sideEffectFile, "director");
      return {
        output: {
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "用真实动作解释。",
          visualBible: {
            narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
            camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "local-editorial-v1",
            deliveryType: "editorial_card",
            alternativeProviderIds: [],
            temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
            query: `editorial-${scene.position}`,
            generationPrompt: `第${scene.position}个真实生活动作`,
            rationale: "本地说明卡可以执行。",
            continuityNote: "保持自然色。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        },
        trace: { taskKind: "director-plan" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "director-model-one" },
      };
    },
  } as VisualDirectorAgent;
  return { treatmentAgents, screenwriterAgent, directorAgent };
}

const ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
];

function childBrief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "joint-v1 发布崩溃恢复",
    angle: "真实进程窗口",
    audience: "内容创作者",
    nicheSlug: "publication-recovery",
    durationSeconds: 24,
    durationRange: { minSeconds: 20, maxSeconds: 34 },
    platform: "douyin",
    runPurpose: "test",
    reviewMode: "manual",
    providers: {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
      assets: "local-editorial-v1",
      voice: "macos-say-v1",
      render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1",
    },
    workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1" },
    director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  } as unknown as ProductionBrief;
}

function scriptStageTemplateSnapshot() {
  return {
    templateId: "publication-seed-template",
    templateVersion: 1,
    resolvedAt: "2026-09-13T00:00:00.000Z",
    resolvedBlueprint: {
      platform: "douyin",
      durationSeconds: 24,
      automationLevel: "assisted",
      storyStructure: [{ id: "explain", label: "解释", purpose: "逐步解释", required: true }],
      shotSlots: [{ id: "shot-explain", beatId: "explain", purpose: "展示动作", durationSeconds: 24, allowedCapabilities: ["asset.prepare"], manualReplacement: true }],
      visualSystem: { composition: "一个镜头一个概念", colorIntent: "自然底色", subtitleDensity: "medium", pacing: "measured" },
      soundSystem: { voiceIntent: "自然", pace: "medium", musicIntent: "轻盈" },
      qualityRules: [{ id: "facts", label: "事实准确", dimension: "factual", required: true, threshold: 80 }],
      capabilityRequirements: [{ capability: "script.draft", required: true }],
    },
    sourceLayers: [{ layer: "template", sourceId: "publication-seed-template@1", appliedFields: ["storyStructure"] }],
    fieldSources: { storyStructure: "template" },
  } as const;
}

function buildPipeline(args: ChildArgs): ProductionPipeline {
  // 恢复阶段绝不挂 failpoint：否则恢复进程会在重放时再次杀死自己。
  const crashNow = () => {
    // 同步写窗口标记：SIGKILL 之前异步 append 可能还没落盘。
    appendFileSync(args.sideEffectFile, `KILL:${args.window}\n`, "utf8");
    // 硬杀进程：与 throw 不同，没有任何清理或恢复逻辑可以拦截。
    process.kill(process.pid, "SIGKILL");
  };
  const failpoints: ProductionPipelineOptions["planningFailpoints"] | undefined = args.phase === "crash"
    ? {
      ...(args.window === "afterGraph" ? { afterGraph: crashNow } : {}),
      ...(args.window === "afterArtifacts" ? { afterArtifacts: crashNow } : {}),
      ...(args.window === "afterCommit" ? { afterCommit: crashNow } : {}),
      ...(args.window === "afterSeed" ? { afterSeed: crashNow } : {}),
    }
    : undefined;
  let nextId = 1;
  return new ProductionPipeline({
    workspaceRoot: args.workspaceRoot,
    worker: new PublicationWorker(),
    ...childAgents(args),
    assetProviders: ASSET_PROVIDERS,
    // 固定 run id：父进程与恢复子进程按同一路径重入同一 run；其余 id 按进程+单调计数保证
    // 跨进程唯一（恢复进程重新从 1 计数，不得与崩溃进程已持久化的 id 碰撞）。
    idFactory: (prefix: string) => (prefix === "run" ? args.runId : `${prefix}-${args.runId}-p${process.pid}-${nextId++}`),
    // 恢复阶段等待真实租约过期（不是手工删锁）；缩短窗口只为测试时长。
    ...(args.phase === "recover" ? { executionLeaseStaleMs: 1_500 } : {}),
    ...(failpoints ? { planningFailpoints: failpoints } : {}),
  });
}

interface ChildReport {
  status: string;
  nodeStatuses: Array<{ nodeId: string; status: string }>;
  artifactKinds: Record<string, number>;
  artifactIdsByKind: Record<string, string[]>;
  outputVersionOwnerships: Array<{ versionId: string; artifactIds: string[]; effective: boolean }>;
  commitCount: number;
  treatmentProvenance: { providerId?: string } | undefined;
  planningStageModels: Array<{ stageId: string; effectiveModelId?: string }>;
}

async function runRecovery(args: ChildArgs): Promise<ChildReport> {
  const pipeline = buildPipeline(args);
  // 真实 lease 过期恢复：轮询等被杀进程的租约真正过期（stale 窗口见 options），
  // 恢复入口先把 running run 标记为 failed+interrupted，再走既有重试合同。
  // afterAccepted：run 已被接受（needs_human）时无需任何恢复，直接复用。
  for (;;) {
    await pipeline.recoverInterruptedRuns();
    const current = await pipeline.loadPersisted(args.runId);
    if (current.status !== "running" && current.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let run = await pipeline.loadPersisted(args.runId);
  if (run.status !== "needs_human") {
    run = await pipeline.retryFailedNode(args.runId, "creative-planning");
  }
  const planning = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
  const artifactKinds: Record<string, number> = {};
  const artifactIdsByKind: Record<string, string[]> = {};
  for (const artifact of run.artifacts) {
    if (artifact.producer?.nodeId !== "creative-planning") continue;
    artifactKinds[artifact.kind] = (artifactKinds[artifact.kind] ?? 0) + 1;
    (artifactIdsByKind[artifact.kind] ??= []).push(artifact.id);
  }
  const outputVersionOwnerships = (planning?.outputState?.versions ?? []).map((version) => ({
    versionId: version.id,
    artifactIds: [...version.artifactIds],
    effective: version.id === planning?.outputState?.effectiveVersionId,
  }));
  const commits = await import("node:fs/promises").then(async (fs) => {
    try {
      return (await fs.readdir(path.join(args.workspaceRoot, "runs", args.runId, "planning", "commits"))).filter((name) => name.endsWith(".json"));
    } catch {
      return [] as string[];
    }
  });
  // 正式 provenance 取"当前 accepted output version 拥有的那份"，不是任意一份历史产物。
  const currentVersionIds = new Set(
    (planning?.outputState?.versions ?? []).find((version) => version.id === planning?.outputState?.effectiveVersionId)?.artifactIds ?? [],
  );
  const treatmentArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "creative_treatment"
    && artifact.producer?.nodeId === "creative-planning"
    && currentVersionIds.has(artifact.id),
  );
  const stages = await pipeline.inspectCreativePlanningStages(args.runId);
  return {
    status: run.status,
    nodeStatuses: run.nodeRuns.map((node) => ({ nodeId: node.nodeId, status: node.status })),
    artifactKinds,
    artifactIdsByKind,
    outputVersionOwnerships,
    commitCount: commits.length,
    treatmentProvenance: { ...(treatmentArtifact?.provenance?.providerId ? { providerId: treatmentArtifact.provenance.providerId } : {}) },
    planningStageModels: (stages ?? []).map((stage) => ({
      stageId: stage.id,
      ...(stage.effectiveModelId !== undefined ? { effectiveModelId: stage.effectiveModelId } : {}),
    })),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.phase === "crash") {
    const pipeline = buildPipeline(args);
    const run = await pipeline.start(childBrief());
    if (args.window === "afterAccepted") {
      // accepted-后 kill：start 返回即 run CAS 已保存（正式身份已被 run 接受）。
      // 此刻硬杀——恢复必须复用已接受结果，不重跑任何角色、不重复登记。
      if (run.status !== "needs_human") throw new Error(`accepted-window run failed: ${run.status}`);
      appendFileSync(args.sideEffectFile, "KILL:afterAccepted\n", "utf8");
      process.kill(process.pid, "SIGKILL");
    }
    if (args.window !== "afterSeed") return;
    // afterSeed 窗口：先完成一次带 fallback 的完整规划，再编辑进入新 digest 触发播种，
    // 播种 checkpoint 落盘后、执行记录写盘前被杀。
    if (run.status !== "needs_human") throw new Error(`seed baseline run failed: ${run.status}`);
    const current = await pipeline.loadPersisted(args.runId);
    const planning = current.nodeRuns.find((node) => node.nodeId === "creative-planning");
    const version = planning?.inputState?.versions.find((candidate) => candidate.id === planning?.inputState?.effectiveVersionId);
    if (!version || !planning?.inputState) throw new Error("planning input version missing for the seed crash window");
    await pipeline.applyNodeInputOverride(args.runId, {
      nodeId: "creative-planning",
      actor: "producer",
      expectedRunRevision: current.revision,
      expectedVersionId: planning.inputState.effectiveVersionId,
      // 模板快照进入编剧/导演合同但不影响构思阶段：构思（含 fallback 后的候选 B
      // provenance）会被播种进新 thread，其模型来源必须随 checkpoint 存活。
      input: { brief: {
        ...((version.value as { brief: Record<string, unknown> }).brief),
        templateSnapshot: scriptStageTemplateSnapshot(),
      } },
    });
    await pipeline.resumeStale(args.runId);
    return;
  }
  const report = await runRecovery(args);
  process.stdout.write(`${JSON.stringify({ ok: true, report })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) })}\n`);
  process.exit(1);
});
