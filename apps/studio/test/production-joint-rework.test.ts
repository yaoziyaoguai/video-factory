import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, mock } from "node:test";
import {
  ProductionPipeline,
  canonicalJsonV2,
  HumanDecisionConflictError,
  type CreativeTreatmentAgent,
  type ProductionBrief,
  type ProductionPipelineOptions,
  type ProductionProviderRuntimeMetadata,
  type ScreenwriterAgent,
  type ScreenwriterAgentInput,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "@video-factory/production-pipeline";
import { ProductionStudio } from "../src/server/production-studio.js";
import { StudioService } from "../src/server/studio-service.js";
import { buildStudioApp } from "../src/server/app.js";
import { studioApi } from "../src/client/api.js";
import type { StudioProvider } from "../src/shared/api.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const relayoutCrashChildPath = fileURLToPath(new URL(
  "./helpers/narration-relayout-crash-child.ts", import.meta.url));

async function runRelayoutCrashChild(options: {
  workspaceRoot: string;
  runId: string;
  requestId: string;
  action: "apply" | "query";
  requestPath?: string;
  countPath: string;
  eventPath: string;
  caseDirectory: string;
  label: string;
  crashPoint?: "afterReservation" | "afterWorkerCompletion" | "afterAdoptionCheckpoint";
  expectedExit?: number;
  expectedSignal?: NodeJS.Signals;
  expectedStderr?: RegExp;
  holdEnteredPath?: string;
  holdReleasePath?: string;
  killAfterPath?: string;
}): Promise<Record<string, unknown> | undefined> {
  await mkdir(options.caseDirectory, { recursive: true });
  const configPath = path.join(options.caseDirectory, `${options.label}.config.json`);
  const resultPath = path.join(options.caseDirectory, `${options.label}.result.json`);
  await writeFile(configPath, `${JSON.stringify({
    workspaceRoot: options.workspaceRoot,
    runId: options.runId,
    action: options.action,
    ...(options.requestPath ? { requestPath: options.requestPath } : {}),
    requestId: options.requestId,
    countPath: options.countPath,
    eventPath: options.eventPath,
    resultPath,
    repositoryRoot,
    python: process.env.VIDEO_FACTORY_PYTHON ?? "python",
    ...(options.holdEnteredPath && options.holdReleasePath ? {
      holdEnteredPath: options.holdEnteredPath,
      holdReleasePath: options.holdReleasePath,
    } : {}),
    ...(options.crashPoint ? { crashPoint: options.crashPoint,
      crashExitCode: options.expectedExit ?? 90 } : {}),
  }, null, 2)}\n`);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null;
    stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", relayoutCrashChildPath, configPath], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONPATH: path.join(repositoryRoot, "src"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (options.killAfterPath) {
      void (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            await readFile(options.killAfterPath!, "utf8");
            child.kill("SIGKILL");
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return reject(error);
          }
          await new Promise(resolvePoll => setTimeout(resolvePoll, 20));
        }
        child.kill("SIGKILL");
        reject(new Error(`Timed out waiting for ${options.killAfterPath}`));
      })();
    }
  });
  if (options.expectedSignal) {
    assert.equal(result.signal, options.expectedSignal,
      `${options.label} signal=${String(result.signal)} stdout=${result.stdout} stderr=${result.stderr}`);
    return undefined;
  }
  const expectedExit = options.expectedExit ?? 0;
  assert.equal(result.code, expectedExit,
    `${options.label} child exit=${String(result.code)} stdout=${result.stdout} stderr=${result.stderr}`);
  if (options.expectedStderr) assert.match(result.stderr, options.expectedStderr);
  if (expectedExit !== 0) return undefined;
  return JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
}

async function jsonLineCount(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

// 只替换付费网络边界。声音生成、真实FFmpeg排轨、字幕回执/恢复与worker协议均为生产实现。
async function controlledVoiceWorker(request: Record<string, unknown>): Promise<WorkerResponse> {
  const script = `
import sys, json, hashlib, subprocess, io
from unittest.mock import patch
from video_factory.worker import handle_request
request = json.load(sys.stdin)
recover = request['input'].get('recover_subtitles') is True
def synthesize(http_request, audio, metadata_path=None, response_binding=None):
    if recover: raise AssertionError('subtitle recovery entered paid synthesis')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', str(audio)], check=True)
    metadata_path.write_text(json.dumps({'request': response_binding, 'audio_sha256': hashlib.sha256(audio.read_bytes()).hexdigest(), 'audio_size_bytes': audio.stat().st_size, 'subtitle_file': 'https://example.org/original-subtitles.json'}))
    return audio
def download(*args, **kwargs):
    if not recover: raise OSError('controlled initial subtitle transport failure')
    return io.BytesIO(json.dumps([{'text': '一段连贯的旁白。', 'time_begin': 0, 'time_end': 500}]).encode())
with patch('video_factory.group_voiceover._execute_minimax_audio_request', side_effect=synthesize), patch('video_factory.narration_subtitles.open_asset_request', side_effect=download), patch.dict('os.environ', {'MINIMAX_API_KEY': 'controlled-no-network'}):
    print(json.dumps(handle_request(request)))
`;
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", script], { env: { ...process.env,
      PYTHONPATH: fileURLToPath(new URL("../../../src", import.meta.url)) },
      stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
    let output = "", errors = "";
    child.stdout.on("data", value => { output += String(value); });
    child.stderr.on("data", value => { errors += String(value); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`Controlled worker exited ${code}: ${errors}`));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// §4.2.2 正式核价消费者：voice.quote 本身是纯本地计价（_group_items + 本地复用表），
// 不触网络；这里直接运行正式 Python worker 代码路径，不 stub 报价金额。
async function formalPythonVoiceQuote(request: Record<string, unknown>): Promise<WorkerResponse> {
  const script = `
import sys, json
from video_factory.worker import handle_request
request = json.load(sys.stdin)
print(json.dumps(handle_request(request)))
`;
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", script], { env: { ...process.env,
      PYTHONPATH: fileURLToPath(new URL("../../../src", import.meta.url)),
      MINIMAX_TTS_BASE_URL: "", MINIMAX_API_KEY: "controlled-no-network" },
      stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
    let output = "", errors = "";
    child.stdout.on("data", value => { output += String(value); });
    child.stderr.on("data", value => { errors += String(value); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`Formal quote worker exited ${code}: ${errors}`));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// ---------------------------------------------------------------------------
// B5：joint-v1 制作失败/打回后回到正确环节。
// - 返工草稿必须读到 creative-planning 产出的上一版脚本与导演方案（joint 拓扑的 producer
//   是 creative-planning，不是旧 script/visual-direction 节点）。
// - 返工意见必须进入正确的规划阶段：script findings → 编剧 brief，visual-direction
//   findings/指令 → 导演 brief（与旧 visual-direction 节点同一 rework 消费合同）。
// - joint run 的报价退回必须路由回 creative-planning 重新规划：导演带费用反馈重做，
//   未受影响的构思与脚本经闭包保留，不重复调用；不落到不存在的旧节点。
// ---------------------------------------------------------------------------

class ReworkWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected capability: ${capability}`);
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
          licenseNote: "Integration fixture.",
        },
      }, ...(capability === "video.render" ? [{
        kind: "render_manifest",
        uri: String(output.renderManifestPath),
        sha256: createHash("sha256").update(jsonContent).digest("hex"),
        sizeBytes: Buffer.byteLength(jsonContent),
        contentType: "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }] : [])],
    };
  }
}

interface ReworkSpies {
  treatmentCalls: number;
  screenwriterBodies: string[];
  directorInputs: VisualDirectorAgentInput[];
}

const CREATIVE_DIMENSION_EVIDENCE: Record<string, string> = {
  attention: "前两秒给出具体问题。",
  progression: "中段有可辨认的推进。",
  payoff: "结尾兑现了承诺里的结论。",
  expression: "画面要求在当前素材能力内可落地。",
};

// 创作交付类角色的评估对象是整份候选（根路径 ""），维度由宿主固定为四维创作维度；
// 总分等于全部维度分的最低分，所以每维取同一个分数。
const CREATIVE_ASSESSMENTS = [{
  targetPath: "",
  dimensions: Object.entries(CREATIVE_DIMENSION_EVIDENCE).map(([dimension, evidence]) => ({ dimension, score: 92, evidence })),
}];

function passingCreativeReviewExecution<T>(
  output: T,
  role: string,
  taskKind: "creative-treatment" | "script-draft" | "director-plan",
  modelId: string,
) {
  return {
    output,
    trace: { taskKind, promptVersion: "v1", prompt: "fixture review", providerId: "fixture-role", modelId },
    agentLoop: {
      version: "video-factory/agent-loop-v1" as const,
      role,
      contractVersion: "fixture-review-v1",
      criteria: ["fixture independent review"],
      status: "passed" as const,
      maxIterations: 1,
      producerModelCallCount: 0,
      auditModelCallCount: 1,
      iterations: [{
        iteration: 1,
        candidate: output,
        candidateHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
        auditTrace: { taskKind: "role-audit" as const, promptVersion: "v1", prompt: "fixture review", providerId: "fixture-audit", modelId: `${modelId}-audit` },
        audit: {
          version: "video-factory/role-audit-v2" as const,
          rubricVersion: "video-factory/role-quality-rubric-v1" as const,
          verdict: "pass" as const,
          score: 92,
          assessments: CREATIVE_ASSESSMENTS,
          summary: "当前版本可以确认。",
          issues: [],
          repairInstructions: [],
          planningDisposition: null,
          hostReadinessReview: null,
        },
      }],
    },
  };
}

function jointReworkAgents(spies: ReworkSpies, options: { narrations?: string[] } = {}): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent"> {
  const treatment: CreativeTreatmentAgent = {
    id: "codex-creative-treatment-v1",
    modelId: "treatment-model-a",
    treat: async () => {
      spies.treatmentCalls += 1;
      return {
        version: "video-factory/creative-treatment-v2",
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
    },
    treatDetailed: async (input) => {
      if (input.creativeReviewExecution?.mode === "check") {
        return passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "导演前期构思", "creative-treatment", "treatment-model-a");
      }
      return {
        output: await treatment.treat(input),
        trace: { taskKind: "creative-treatment" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "treatment-model-a" },
      };
    },
  };
  const draftScript = async (input: { brief: { rework?: { instruction?: string } } }) => {
    spies.screenwriterBodies.push(input.brief.rework?.instruction ?? "(无返工指令)");
    return {
      viewerPromise: "看完能避开三个决策坑",
      narrativeArc: "问题-方法-清单",
      canonFacts: ["步骤可执行"],
      scenes: [1, 2, 3].map((position) => ({
        position,
        narration: options.narrations?.[position - 1] ?? `第${position}段旁白内容`,
        duration: 8,
        visual_strategy: "generated",
        visual_prompt: `第${position}个真实生活动作`,
        search_terms: [`生活动作 ${position}`],
      })),
    };
  };
  const planDirector = async (input: VisualDirectorAgentInput) => {
    spies.directorInputs.push(input);
    return {
      version: "video-factory/director-plan-v1" as const,
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
        authenticityPolicy: "illustrative" as const,
        preferredProviderId: "local-editorial-v1",
        deliveryType: "editorial_card" as const,
        alternativeProviderIds: [],
        temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
        query: `editorial-${scene.position}`,
        generationPrompt: `第${scene.position}个真实生活动作`,
        rationale: "本地说明卡可以执行。",
        continuityNote: "保持自然色。",
        confidence: 0.8,
        estimatedCostCny: 0,
      })),
    };
  };
  return {
    treatmentAgents: [{ providerId: "openai", agent: treatment }],
    screenwriterAgent: {
      id: "codex-screenwriter-v1",
      modelId: "screenwriter-model-one",
      draft: draftScript,
      draftDetailed: async (input) => input.creativeReviewExecution?.mode === "check"
        ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "编剧", "script-draft", "screenwriter-model-one")
        : {
            output: await draftScript(input),
            trace: { taskKind: "script-draft" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "screenwriter-model-one" },
          },
    } as ScreenwriterAgent,
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "director-model-one",
      plan: planDirector,
      planDetailed: async (input) => input.creativeReviewExecution?.mode === "check"
        ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
        : {
            output: await planDirector(input),
            trace: { taskKind: "director-plan" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "director-model-one" },
          },
    } as VisualDirectorAgent,
  };
}

const REWORK_ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
];

function jointReworkBrief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "joint-v1 返工回到正确环节",
    angle: "返工意见进入正确阶段",
    audience: "内容创作者",
    nicheSlug: "joint-rework",
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
    workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1" },
    director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  } as unknown as ProductionBrief;
}

function newJointReworkStudio(
  workspaceRoot: string,
  spies: ReworkSpies,
  options: { assetProviders?: VisualAssetProviderCapability[]; runtimeMetadata?: ProductionProviderRuntimeMetadata[] } = {},
): { studio: ProductionStudio; pipeline: ProductionPipeline } {
  const pipeline = new ProductionPipeline({
    workspaceRoot,
    worker: new ReworkWorker(),
    ...jointReworkAgents(spies),
    assetProviders: options.assetProviders ?? REWORK_ASSET_PROVIDERS,
    ...(options.runtimeMetadata ? { providerRuntimeMetadata: options.runtimeMetadata } : {}),
  });
  const studio = new ProductionStudio({
    workspaceRoot,
    pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
    listProviders: async () => ([] as StudioProvider[]),
  });
  return { studio, pipeline };
}

async function confirmCreativeStages(
  pipeline: ProductionPipeline,
  initial: Awaited<ReturnType<ProductionPipeline["start"]>>,
): Promise<Awaited<ReturnType<ProductionPipeline["start"]>>> {
  let run = initial;
  for (let index = 0; index < 3; index += 1) {
    const intervention = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.intervention;
    if (run.status !== "needs_human" || intervention?.kind !== "creative_review" || !intervention.continuation) break;
    const gate = intervention.continuation;
    const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[gate.stage]?.checkResult;
    run = await pipeline.confirmCreativeReview(run.id, {
      commandId: `confirm-${gate.stage}-${index + 1}`,
      actor: "producer",
      expectedRunRevision: run.revision,
      expectedReviewRevision: gate.reviewRevision,
      stage: gate.stage,
      baseDraftSha256: gate.draftSha256,
      ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
      ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
    });
  }
  return run;
}

// 返工版本与新建一样带边界闸门（reworkDraft 会补上 boundaryGates），所以驱动返工 run 时要先替用户
// 放行 brief 那道「这一步已完成」。停在 creative-planning 自己的闸门上——那正是导演方案重新产出的
// 时刻，也是这几个用例要断言的状态；再往下推就会顺手把素材、配音这些不相干的节点也跑起来。
async function confirmGatedRework(
  pipeline: ProductionPipeline,
  input: ProductionBrief,
): Promise<Awaited<ReturnType<ProductionPipeline["start"]>>> {
  let run = await pipeline.start(input);
  for (let index = 0; index < 6; index += 1) {
    if (run.status !== "needs_human") break;
    const planning = run.nodeRuns.find((node) => node.status === "needs_human" && node.nodeId === "creative-planning")?.intervention;
    if (planning?.kind === "creative_review" && planning.continuation) {
      const gate = planning.continuation;
    const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[gate.stage]?.checkResult;
      run = await pipeline.confirmCreativeReview(run.id, {
        commandId: `rework-confirm-${gate.stage}-${index + 1}`,
        actor: "producer",
        expectedRunRevision: run.revision,
        expectedReviewRevision: gate.reviewRevision,
        stage: gate.stage,
        baseDraftSha256: gate.draftSha256,
        ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
        ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
      });
      continue;
    }
    // 必须按 status 过滤：放行过的节点仍挂着旧 intervention，拿它去 decide 会被判"不是当前干预"。
    const boundary = run.nodeRuns.find((node) => node.status === "needs_human"
      && node.nodeId !== "creative-planning"
      && node.intervention?.boundary === "node-complete")?.intervention;
    if (!boundary) break;
    run = await pipeline.decide(run.id, {
      interventionId: boundary.id,
      action: "approve",
      actor: "producer",
      expectedRunRevision: run.revision,
      reviewEvidenceId: null,
    });
  }
  return run;
}

async function rejectedJointRun(harness: { studio: ProductionStudio; pipeline: ProductionPipeline }): Promise<string> {
  const run = await confirmCreativeStages(harness.pipeline, await harness.pipeline.start(jointReworkBrief()));
  assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
  const intervention = run.interventions.find((candidate) => candidate.nodeId === "final-review");
  assert.ok(intervention, "the manual review run must end at a final-review intervention");
  const rejected = await harness.pipeline.decide(run.id, {
    interventionId: intervention.id,
    action: "reject",
    actor: "producer",
    note: "第二镜画面与旁白对不上，请重做。",
    expectedRunRevision: run.revision,
    reviewEvidenceId: null,
  });
  assert.equal(rejected.status, "rejected", JSON.stringify(rejected.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
  return run.id;
}

describe("joint-v1 rework routes back to the right stages (B5)", () => {
  it("replans an early failure without inventing an empty approved shot scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-early-planning-rework-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const broken = newJointReworkStudio(workspaceRoot, spies, { assetProviders: [] });
    const source = await broken.pipeline.start(jointReworkBrief());
    assert.equal(source.status, "failed");
    assert.equal(spies.treatmentCalls, 0, "configuration failed before any draft existed");
    const repaired = newJointReworkStudio(workspaceRoot, spies);
    const draft = await repaired.studio.reworkDraft(source.id);
    assert.ok(draft?.input.rework);
    assert.equal(draft.input.rework.previousScript, undefined);
    assert.equal(draft.input.rework.previousDirectorPlan, undefined);
    assert.equal(draft.input.rework.affectedScenePositions, undefined,
      "no prior shot universe is not the user's instruction to change zero shots");
    const continued = await confirmGatedRework(repaired.pipeline, draft.input as ProductionBrief);
    assert.equal(continued.status, "needs_human", JSON.stringify(continued.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(continued.nodeRuns.find(node => node.nodeId === "creative-planning")?.intervention?.boundary, "node-complete");
    assert.deepEqual(spies.directorInputs.at(-1)?.brief.rework?.affectedScenePositions, [1, 2, 3]);
    assert.equal(continued.nodeRuns.some(node => node.nodeId === "voice" && node.status === "succeeded"), false,
      "replanning still stops before production or spending");
    assert.equal((await repaired.pipeline.show(source.id)).status, "failed", "original failure remains preserved");
  });

  it("returns an actionable HTTP conflict for unsafe reinspection without changing the stop", async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-reinspection-http-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const { pipeline } = newJointReworkStudio(workspaceRoot, spies);
    const run = await pipeline.start(jointReworkBrief());
    const before = await pipeline.loadPersisted(run.id);
    const calls = JSON.stringify(spies);
    t.mock.method(pipeline, "dispatchVisualReinspection", async () => {
      throw new HumanDecisionConflictError("原请求结果还在核实，请先查询原请求，不会重新提交。");
    });
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${origin}/api/runs/${run.id}/reinspect-visual-review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRunRevision: run.revision, reviewEvidenceId: "a".repeat(64) }),
      });
      assert.equal(response.status, 409);
      assert.match(await response.text(), /原请求结果还在核实/);
      assert.deepEqual(await pipeline.loadPersisted(run.id), before);
      assert.equal(JSON.stringify(spies), calls, "HTTP拒绝不能提交新的模型请求");
    } finally { await app.close(); }
  });

  it("reinspects joint planning evidence through HTTP including current render provenance, without repurchasing", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-joint-reinspection-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const worker = new ReworkWorker();
    const calls: string[] = [];
    const pipeline = new ProductionPipeline({ workspaceRoot, ...jointReworkAgents(spies),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "deepseek-visual-review-v1", label: "受控审片", modelId: "fixture-review",
        transport: "unix_socket", billing: "subscription", approvalPolicy: "none", maxAttempts: 1 }],
      worker: { run: async request => {
        calls.push(request.capability);
        const response = await worker.run(request);
        if (request.capability === "video.render") {
          const manifestPath = path.join(String(request.outputDir), "render_manifest.json");
          const content = JSON.stringify({ duration_target: 24, slides: [1, 2, 3].map(position => ({ position, duration: 8 })) });
          await writeFile(manifestPath, content);
          const descriptor = response.artifacts.find(a => a.uri === manifestPath)!;
          descriptor.sha256 = createHash("sha256").update(content).digest("hex");
          descriptor.sizeBytes = Buffer.byteLength(content);
        }
        return response;
      } },
      visualReviewAgents: [{ id: "deepseek-visual-review-v1", modelId: "fixture-review", review: async () => {
        calls.push("visual-review");
        return { version: "video-factory/visual-review-v1", summary: "受控复核", scores: {
          composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 80,
        }, findings: [], confidence: 0.9, recommendation: "approve" };
      } }],
    });
    const input = jointReworkBrief();
    input.providers.visualReview = "deepseek-visual-review-v1";
    input.workflowFeatures = { ...input.workflowFeatures, boundaryGates: "user-confirmed-v1" };
    let run = await pipeline.start(input);
    for (let i = 0; i < 15; i += 1) {
      const stop = run.nodeRuns.find(node => node.status === "needs_human");
      if (!stop || stop.nodeId === "visual-review") break;
      if (stop.intervention?.kind === "creative_review") run = await confirmCreativeStages(pipeline, run);
      else run = await pipeline.decide(run.id, { interventionId: stop.intervention!.id, action: "approve",
        actor: "tester", expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    assert.equal(run.nodeRuns.find(node => node.status === "needs_human")?.nodeId, "visual-review",
      JSON.stringify(run.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const review = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
    const scope = (review.output as { report: { reviewScope: { evidenceId: string; sourceArtifactIds: string[] } } }).report.reviewScope;
    const planning = run.nodeRuns.find(node => node.nodeId === "creative-planning")!;
    const acceptedIds = planning.outputState!.versions.find(v => v.id === planning.outputState!.effectiveVersionId)!.artifactIds;
    const draft = run.artifacts.find(a => scope.sourceArtifactIds.includes(a.id) && a.kind === "creative_draft" && !acceptedIds.includes(a.id));
    assert.ok(draft?.uri, "首审确实保留了未在最终输出清单中的创作来源");
    const original = await readFile(draft.uri);
    const before = await pipeline.loadPersisted(run.id);
    const beforeCalls = [...calls];
    const beforeSpies = JSON.stringify(spies);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const submit = (evidenceId = scope.evidenceId, revision = run.revision) => fetch(`${origin}/api/runs/${run.id}/reinspect-visual-review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRunRevision: revision, reviewEvidenceId: evidenceId }),
      });
      assert.equal((await submit("f".repeat(64))).status, 409);
      assert.equal((await submit(scope.evidenceId, run.revision - 1)).status, 409);
      await writeFile(draft.uri, "changed source");
      const changedSource = await submit();
      assert.notEqual(changedSource.status, 200, "来源文件变化必须在新审查前拒绝");
      // HTTP 既有安全映射不暴露文件细节；直接管线补核确实被 SHA 拒绝。
      await assert.rejects(pipeline.dispatchVisualReinspection(run.id, {
        expectedRunRevision: run.revision, reviewEvidenceId: scope.evidenceId,
      }), /sha256/);
      await writeFile(draft.uri, original);
      assert.deepEqual(await pipeline.loadPersisted(run.id), before);
      assert.deepEqual(calls, beforeCalls);
      // 仅改隔离测试存储制造坏来源；报告自己的 parent 不能证明它属于当前成片。
      const runPath = path.join(workspaceRoot, "runs", run.id, "run.json");
      for (const fault of ["unrelated", "missing", "cycle"] as const) {
        const damaged = structuredClone(before);
        if (fault === "unrelated") {
          const extra = { ...draft, id: "unrelated-history" };
          damaged.artifacts.push(extra);
          const node = damaged.nodeRuns.find(n => n.nodeId === "visual-review")!;
          for (const output of [node.output, ...node.outputState!.versions.map(v => v.output)]) {
            (output as { report: { reviewScope: { sourceArtifactIds: string[] } } }).report.reviewScope.sourceArtifactIds.push(extra.id);
          }
          damaged.artifacts.filter(a => a.producer?.nodeId === "visual-review").forEach(a => a.parentArtifactIds?.push(extra.id));
        } else if (fault === "missing") damaged.artifacts = damaged.artifacts.filter(a => a.id !== draft.id);
        else damaged.artifacts.find(a => a.id === draft.id)!.parentArtifactIds = [draft.id];
        await writeFile(runPath, JSON.stringify(damaged));
        assert.equal((await submit()).status, 409, fault);
        assert.deepEqual(await pipeline.loadPersisted(run.id), damaged);
        assert.deepEqual(calls, beforeCalls);
      }
      await writeFile(runPath, JSON.stringify(before));
      const response = await submit();
      assert.equal(response.status, 200, await response.text());
      let after = await pipeline.loadPersisted(run.id);
      for (let i = 0; after.status === "running" && i < 100; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        after = await pipeline.loadPersisted(run.id);
      }
      assert.equal(after.status, "needs_human");
      assert.deepEqual(calls.slice(beforeCalls.length), ["visual-review"]);
      assert.equal(JSON.stringify(spies), beforeSpies);
      for (const nodeId of ["assets", "voice", "render", "technical-review"]) {
        assert.deepEqual(after.nodeRuns.find(n => n.nodeId === nodeId), before.nodeRuns.find(n => n.nodeId === nodeId));
      }
    } finally { await app.close(); }
  });
  it("passes the user's adopted treatment B through formal script and director inputs and audits without rewriting A", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-current-treatment-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const agents = jointReworkAgents(spies);
    const writerInputs: ScreenwriterAgentInput[] = [];
    const treatmentChecks: unknown[] = [];
    const treatmentAgent = agents.treatmentAgents![0]!.agent;
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(), assetProviders: REWORK_ASSET_PROVIDERS,
      ...agents,
      treatmentAgents: [{ providerId: "openai", agent: { ...treatmentAgent, treatDetailed: async input => {
        if (input.creativeReviewExecution?.mode === "check") treatmentChecks.push(input.creativeReviewExecution.candidate);
        return treatmentAgent.treatDetailed!(input);
      } } }],
      screenwriterAgent: { ...agents.screenwriterAgent!, draftDetailed: async input => {
        writerInputs.push(input);
        const execution = await agents.screenwriterAgent!.draftDetailed!(input);
        return { ...execution, output: { ...execution.output, viewerPromise: input.brief.creativeTreatment!.viewerPromise } };
      } },
    });
    const studio = new ProductionStudio({ workspaceRoot, pipeline,
      archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [] });
    let run = await pipeline.start(jointReworkBrief());
    const first = (await studio.creativeReview(run.id))!;
    assert.equal(first.stage, "treatment");
    const original = JSON.stringify(first.draft);
    const proposed = { ...(first.draft as Record<string, unknown>), viewerPromise: "B：不被催促的四秒钟", payoff: "B：回扣窗边的光，不加CTA", soundPrinciples: ["开头4秒静默，其后自然连贯"] };
    let command = await pipeline.dispatchCreativeReviewCommand(run.id, { action: "edit_draft", commandId: "adopt-B", actor: "creator", stage: "treatment",
      expectedRunRevision: first.runRevision, expectedReviewRevision: first.reviewRevision, baseDraftSha256: first.draftSha256, document: proposed });
    run = await command.completion;
    let current = (await studio.creativeReview(run.id))!;
    assert.deepEqual(current.draft, proposed);
    assert.equal(treatmentChecks.length, 1, "手工采用新稿不自动再审");
    command = await pipeline.dispatchCreativeReviewCommand(run.id, { action: "audit_current", commandId: "audit-B", actor: "creator", stage: "treatment",
      expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256 });
    run = await command.completion;
    assert.deepEqual(treatmentChecks[1], proposed, "主动再审必须审当前B而非原始A");
    assert.equal(spies.treatmentCalls, 1, "主动审计不能重新构思");
    for (const stage of ["treatment", "script"] as const) {
      current = (await studio.creativeReview(run.id))!;
      assert.equal(current.stage, stage);
      run = await pipeline.confirmCreativeReview(run.id, { commandId: `continue-${stage}-B`, actor: "creator", stage,
        expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256,
        expectedCheckIdentity: current.checkResult!.checkIdentity });
    }
    assert.equal((await studio.creativeReview(run.id))!.stage, "director");
    assert.equal(writerInputs.length, 2, "脚本只有初稿与首审各一次");
    for (const input of writerInputs) assert.deepEqual(input.brief.creativeTreatment, proposed);
    assert.ok(spies.directorInputs.length > 0);
    for (const input of spies.directorInputs) {
      assert.deepEqual(input.brief.creativeTreatment, proposed);
      assert.equal(input.brief.viewerPromise, proposed.viewerPromise);
    }
    current = (await studio.creativeReview(run.id))!;
    command = await pipeline.dispatchCreativeReviewCommand(run.id, { action: "audit_current", commandId: "audit-director-B", actor: "creator", stage: "director",
      expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256 });
    await command.completion;
    assert.equal(JSON.stringify(first.draft), original, "原稿A字节未被下游标准化或上下文构造改写");
    assert.equal(spies.treatmentCalls, 1);
    assert.equal(writerInputs.length, 2);
  });

  it("serves and confirms narration through the browser client and real HTTP facade without starting TTS or releasing the gate", async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-http-"));
    let voiceCalls = 0;
    class VoiceGuardWorker extends ReworkWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "voice.synthesize") voiceCalls++;
        return super.run(request);
      }
    }
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new VoiceGuardWorker(),
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const assetGate = run.nodeRuns.find(node => node.nodeId === "assets")!.intervention;
    assert.ok(assetGate);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const nativeFetch = globalThis.fetch;
      // 只把浏览器相对地址接到本地服务器；请求头、序列化与响应读取均走正式客户端。
      // app.inject 的对象 payload 会自动补 JSON 头，无法捕获浏览器实际发送文本的缺陷。
      t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        nativeFetch(typeof input === "string" ? new URL(input, origin) : input, init));
      const preview = await studioApi.narrationPlan(run.id);
      assert.equal(preview.confirmed, false);
      assert.ok(preview.plan.groups.length > 0);
      const confirmed = await studioApi.confirmNarrationPlan(run.id, {
        expectedRunRevision: preview.expectedRunRevision, plan: preview.plan,
      });
      assert.equal(confirmed.status, "needs_human");
      const saved = await pipeline.loadPersisted(run.id);
      assert.deepEqual(saved?.nodeRuns.find(node => node.nodeId === "assets")?.intervention, assetGate);
      assert.equal(voiceCalls, 0, "确认方案不能隐式合成付费声音");
      assert.equal((await studioApi.narrationPlan(run.id)).confirmed, true);
      await assert.rejects(studioApi.confirmNarrationPlan(run.id, {
        expectedRunRevision: preview.expectedRunRevision, plan: preview.plan,
      }), /制作记录已更新/);
      assert.equal(voiceCalls, 0);
    } finally {
      await app.close();
    }
  });

  it("recovers subtitles through the real client HTTP Studio pipeline and Python worker without rebuying voice", async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-subtitle-http-"));
    const voiceRequests: Array<Record<string, unknown>> = [];
    class SubtitleWorker extends ReworkWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability !== "voice.synthesize") return super.run(request);
        voiceRequests.push(request);
        return controlledVoiceWorker(request);
      }
    }
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new SubtitleWorker(),
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 20; step++) {
      const gateNode = run.nodeRuns.find(node => node.status === "needs_human");
      if (gateNode?.nodeId === "final-review") break;
      const gate = gateNode?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure, nodes: run.nodeRuns }));
      if (gateNode.nodeId === "assets") {
        const preview = await pipeline.previewNarrationPlan(run.id);
        run = await pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: preview.plan, actor: "creator" });
      }
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    assert.equal(run.nodeRuns.find(node => node.nodeId === "final-review")?.status, "needs_human");
    assert.equal(voiceRequests.length, 1);
    const voice = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const sourceOutput = voice.output as { voiceoverPlanPath: string; trackPath: string };
    const originalPlanBytes = await readFile(sourceOutput.voiceoverPlanPath);
    const plan = JSON.parse(originalPlanBytes.toString());
    const audioBytes = await readFile(sourceOutput.trackPath);
    assert.equal(plan.subtitles.status, "unavailable");
    const oldAssets = run.nodeRuns.find(node => node.nodeId === "assets")?.outputState?.effectiveVersionId;
    const input = { action: "recover_subtitles" as const, requestId: "pure-subtitle-recovery-http",
      expectedRunRevision: run.revision, expectedVoiceVersionId: voice.outputState!.effectiveVersionId,
      expectedNarrationPlanSha256: plan.subtitles.acceptedNarrationPlanSha256,
      expectedLayoutKey: plan.layoutKey, expectedAudioSha256: createHash("sha256").update(audioBytes).digest("hex"),
      note: "原配音保留，只恢复字幕", refetchReason: "受控字幕连接已恢复" };
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const nativeFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (url: string | URL | Request, init?: RequestInit) =>
        nativeFetch(typeof url === "string" ? new URL(url, origin) : url, init));
      await assert.rejects(studioApi.requestNarrationRevision(run.id, { ...input, expectedAudioSha256: "f".repeat(64) }), /当前配音.*不会重新购买/);
      assert.equal(voiceRequests.length, 1, "错绑在worker前拒绝，原停点保留");
      await studioApi.requestNarrationRevision(run.id, input);
      const saved = await pipeline.loadPersisted(run.id);
      const nextVoice = saved.nodeRuns.find(node => node.nodeId === "voice")!;
      const nextOutput = nextVoice.output as { voiceoverPlanPath: string; trackPath: string };
      const nextPlan = JSON.parse(await readFile(nextOutput.voiceoverPlanPath, "utf8"));
      assert.equal(nextPlan.subtitles.status, "verified");
      assert.deepEqual(await readFile(nextOutput.trackPath), audioBytes);
      assert.deepEqual(await readFile(sourceOutput.voiceoverPlanPath), originalPlanBytes);
      assert.equal(saved.nodeRuns.find(node => node.nodeId === "assets")?.outputState?.effectiveVersionId, oldAssets);
      assert.equal(voiceRequests.length, 2);
      assert.equal((voiceRequests[1]!.input as Record<string, unknown>).recover_subtitles, true);
      const version = nextVoice.outputState!.versions.find(item => item.id === nextVoice.outputState!.effectiveVersionId)!;
      const vtt = saved.artifacts.find(artifact => version.artifactIds.includes(artifact.id) && artifact.kind === "narration_vtt");
      assert.ok(vtt?.sha256);
      assert.match(await readFile(vtt.uri!, "utf8"), /一段连贯的旁白/);
      let stopped = saved;
      for (let observation = 0; stopped.status === "running" && observation < 100; observation++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        stopped = await pipeline.loadPersisted(run.id);
      }
      assert.equal(stopped.status, "needs_human", "字幕恢复后仍在下一个关键节点等用户确认");
      const replayed = await studioApi.requestNarrationRevision(run.id, input);
      assert.equal(replayed.revision, stopped.revision);
      assert.equal(voiceRequests.length, 2, "同一操作重放不调用worker或模型");
      await assert.rejects(studioApi.requestNarrationRevision(run.id, { ...input, note: "同编号改变内容" }));
      assert.equal(voiceRequests.length, 2);
    } finally { await app.close(); }
  });

  it("keeps a model-generated out-of-scope director plan at a recoverable stop without reaching assets", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-rework-model-scope-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const source = newJointReworkStudio(workspaceRoot, spies);
    const sourceRunId = await rejectedJointRun(source);
    const draft = await source.studio.reworkDraft(sourceRunId);
    assert.ok(draft?.input.rework);
    const input: ProductionBrief = {
      ...draft.input,
      rework: { ...draft.input.rework, findings: [], affectedScenePositions: [] },
    };
    const agents = jointReworkAgents(spies);
    const director = agents.directorAgent!;
    const changedDirector: VisualDirectorAgent = {
      ...director,
      plan: async (request) => {
        const plan = await director.plan(request) as Record<string, unknown>;
        if (request.brief.rework) {
          const bible = plan.visualBible as Record<string, unknown>;
          plan.visualBible = { ...bible, pacing: "全片改成急促节奏" };
        }
        return plan;
      },
      planDetailed: async (request) => request.creativeReviewExecution?.mode === "check"
        ? passingCreativeReviewExecution(request.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
        : {
          output: await changedDirector.plan(request),
          trace: { taskKind: "director-plan" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "director-model-one" },
        },
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot, worker: new ReworkWorker(),
      treatmentAgents: agents.treatmentAgents, screenwriterAgent: agents.screenwriterAgent,
      directorAgent: changedDirector, assetProviders: REWORK_ASSET_PROVIDERS,
    });
    const studio = new ProductionStudio({
      workspaceRoot, pipeline,
      archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
      listProviders: async () => ([] as StudioProvider[]),
    });
    let run = await pipeline.start(input);
    for (let index = 0; index < 6; index += 1) {
      const active = run.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
      if (run.status !== "needs_human" || !active) break;
      if (active.kind === "creative_review" && active.continuation) {
        if (active.continuation.stage === "director") break;
        const gate = active.continuation;
        run = await pipeline.confirmCreativeReview(run.id, {
          commandId: `scope-model-upstream-${index}`, actor: "creator", expectedRunRevision: run.revision,
          expectedReviewRevision: gate.reviewRevision, stage: gate.stage, baseDraftSha256: gate.draftSha256,
        });
      } else if (active.boundary === "node-complete") {
        run = await pipeline.decide(run.id, {
          interventionId: active.id, action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null,
        });
      } else break;
    }
    assert.equal(run.status, "needs_human");
    const current = await studio.creativeReview(run.id);
    assert.equal(current?.stage, "director");
    assert.ok(current?.scopeConflict);
    assert.equal(current.scopeConflict.sourceRunId, sourceRunId);
    assert.equal(current.proposals[0]?.proposalId, current.scopeConflict.proposalId);
    assert.notDeepEqual(current.draft, current.proposals[0]?.document);
    assert.equal(run.nodeRuns.some((node) => node.nodeId === "assets" && node.status !== "pending"), false,
      "no asset node may start while the scope conflict is awaiting a human decision");
  });

  it("keeps an out-of-scope global director edit unadopted at the human gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-rework-global-scope-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const { pipeline, studio } = newJointReworkStudio(workspaceRoot, spies);
    const sourceRunId = await rejectedJointRun({ pipeline, studio });
    const draft = await studio.reworkDraft(sourceRunId);
    assert.ok(draft?.input.rework);
    // 去标识化事故：零媒体且用户明确批准空范围；没有未解决 finding 可掩盖内容变化。
    const input: ProductionBrief = {
      ...draft.input,
      rework: { ...draft.input.rework, findings: [], affectedScenePositions: [] },
    };
    let run = await pipeline.start(input);
    for (let index = 0; index < 6; index += 1) {
      const active = run.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
      if (run.status !== "needs_human" || !active) break;
      if (active.kind === "creative_review" && active.continuation) {
        if (active.continuation.stage === "director") break;
        const gate = active.continuation;
        run = await pipeline.confirmCreativeReview(run.id, {
          commandId: `scope-upstream-${index}`, actor: "creator", expectedRunRevision: run.revision,
          expectedReviewRevision: gate.reviewRevision, stage: gate.stage, baseDraftSha256: gate.draftSha256,
        });
      } else if (active.boundary === "node-complete") {
        run = await pipeline.decide(run.id, {
          interventionId: active.id, action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null,
        });
      } else break;
    }
    const current = await studio.creativeReview(run.id);
    assert.equal(current?.stage, "director", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const document = structuredClone(current.draft as Record<string, unknown>);
    document.visualBible = { ...(document.visualBible as Record<string, unknown>), pacing: "全片改为急促节奏" };
    await assert.rejects(async () => {
      const operation = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action: "edit_draft", commandId: "scope-global-edit", actor: "creator", stage: "director",
        expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision,
        baseDraftSha256: current.draftSha256, document,
      });
      await operation.completion;
    }, /返工影响范围|重新确认返工范围/);
    const after = await studio.creativeReview(run.id);
    assert.equal(after?.draftSha256, current.draftSha256);
  });
  it("reads the previous script and director plan from the creative-planning artifacts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-b5-rework-docs-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const harness = newJointReworkStudio(workspaceRoot, spies);
    const runId = await rejectedJointRun(harness);

    const draft = await harness.studio.reworkDraft(runId);
    assert.ok(draft, "a rejected joint run must produce a rework draft");
    const rework = (draft.input as { rework?: Record<string, unknown> }).rework;
    assert.ok(rework, "the draft input must carry the rework context");
    // joint 拓扑的正式脚本/导演方案由 creative-planning 产出：返工草稿必须读到它们。
    assert.ok(Array.isArray((rework.previousScript as { scenes?: unknown[] } | undefined)?.scenes),
      `the draft must carry the previous script document, received: ${JSON.stringify(rework.previousScript)?.slice(0, 120)}`);
    assert.equal((rework.previousDirectorPlan as { version?: string } | undefined)?.version, "video-factory/director-plan-v1",
      "the draft must carry the previous director plan produced by creative-planning");
  });

  it("feeds rework instructions to the script and director planning stages", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-b5-rework-consume-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const harness = newJointReworkStudio(workspaceRoot, spies);
    const runId = await rejectedJointRun(harness);
    const draft = await harness.studio.reworkDraft(runId);
    assert.ok(draft);

    const reworkRun = await confirmGatedRework(harness.pipeline, draft.input as ProductionBrief);
    assert.equal(reworkRun.status, "needs_human", JSON.stringify(reworkRun.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const reworkScreenwriterBodies = spies.screenwriterBodies.slice(1);
    const reworkTreatmentCalls = spies.treatmentCalls - 1;

    // BG-06 合同：画面与旁白对不上的返工不点名编剧——script 指令为空，编剧阶段从源 run
    // 跨 run 继承（producer 调用 0）；导演阶段真实重做并携带返工上下文与上一版方案。
    assert.equal(reworkScreenwriterBodies.length, 0, "a picture-sync note must not re-run the screenwriter");
    assert.equal(draft.input.rework?.nodeInstructions.script, "", "media-only rework draft must not fabricate a script instruction");
    const directorInput = spies.directorInputs.at(-1)!;
    assert.ok(directorInput.brief.rework, "the joint director stage must receive the rework context");
    assert.match(directorInput.brief.rework.visualDirectionInstruction, /导演方案|底稿|重做/);
    assert.ok(directorInput.brief.rework.previousDirectorPlan, "the director stage must see the previous plan for bounded revision");
    const publicFindingKeys = new Set(["category", "description", "findingId", "scenePosition", "suggestion", "targetNodeIds", "timecodeMs"]);
    assert.ok(
      directorInput.brief.rework.findings.every((finding) => Object.keys(finding).every((key) => publicFindingKeys.has(key))),
      "every model-facing rework finding must match the Broker's strict public contract",
    );
    assert.equal(reworkTreatmentCalls, 0, "unaffected treatment must be inherited across runs for media/director-only rework");
  });

  it("routes a rejected joint asset quote back to creative-planning with director cost feedback only", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-b5-rework-spend-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const baseAgents = jointReworkAgents(spies);
    const meteredAssets: VisualAssetProviderCapability[] = [
      {
        id: "seedance-video-v1",
        label: "Seedance",
        billing: "metered",
        modes: ["文生视频"],
        deliveryTypes: ["generated_video"],
        estimatedCnyPerClip: 2.4,
        generative: true,
      },
      { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["图库"], deliveryTypes: ["stock_video"] },
    ];
    const runtimeMetadata: ProductionProviderRuntimeMetadata[] = [{
      id: "seedance-video-v1",
      label: "Seedance",
      modelId: "seedance-v1",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 2.4,
      maxAttempts: 1,
    }];
    // 导演替身按费用反馈切换路线：首轮全部生成，退回后只保留第一镜生成。
    const meteredDirector: VisualDirectorAgent = {
      id: "api-visual-director-v1",
      modelId: "director-model-one",
      plan: async (input: VisualDirectorAgentInput) => {
        spies.directorInputs.push(input);
        const cheaper = input.costFeedback?.some((feedback) => feedback.reason === "too_expensive") === true;
        return {
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: cheaper ? "按费用反馈保留一镜生成。" : "先全部生成。",
          visualBible: {
            narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
            camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
          },
          shots: input.scenes.map((scene, index) => {
            const paid = !cheaper || index === 0;
            return {
              scenePosition: scene.position,
              narrativeRole: "解释",
              authenticityPolicy: "illustrative",
              preferredProviderId: paid ? "seedance-video-v1" : "pexels-stock-v1",
              deliveryType: paid ? "generated_video" : "stock_video",
              alternativeProviderIds: [],
              temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
              query: `镜头内容 ${scene.position}`,
              generationPrompt: `第${scene.position}个真实生活动作`,
              rationale: paid ? "生成镜头可以交付。" : "图库可以满足并降低费用。",
              continuityNote: "保持自然色。",
              confidence: 0.8,
              estimatedCostCny: 0,
            };
          }),
        };
      },
      planDetailed: async (input) => input.creativeReviewExecution?.mode === "check"
        ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
        : {
            output: await meteredDirector.plan(input),
            trace: { taskKind: "director-plan" as const, promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "director-model-one" },
          },
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ReworkWorker(),
      treatmentAgents: baseAgents.treatmentAgents,
      screenwriterAgent: baseAgents.screenwriterAgent,
      directorAgent: meteredDirector,
      assetProviders: meteredAssets,
      providerRuntimeMetadata: runtimeMetadata,
    });
    const studio = new ProductionStudio({
      workspaceRoot,
      pipeline,
      archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
      listProviders: async () => ([] as StudioProvider[]),
    });

    const paused = await confirmCreativeStages(pipeline, await pipeline.start({
      ...jointReworkBrief(),
      providers: { ...jointReworkBrief().providers, assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1", "pexels-stock-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    } as ProductionBrief));
    const firstPlan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(firstPlan, JSON.stringify({ status: paused.status, nodes: paused.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error })) }));
    assert.equal(paused.status, "awaiting_spend_approval");

    // joint run 的报价退回：失效目标是 creative-planning（旧实现死在不存在的 visual-direction）。
    const rejected = await pipeline.rejectSpend(paused.id, {
      nodeId: "assets",
      spendPlanId: firstPlan.id,
      reason: "too_expensive",
      targetEstimatedCostCny: 2.4,
      note: "只保留第一镜生成，其余用图库。",
      rejectedBy: "owner",
    });
    assert.equal(rejected.status, "stale");

    const awaitingReplanReview = await pipeline.resumeStale(paused.id);
    assert.equal(awaitingReplanReview.status, "needs_human", "the changed director plan must be shown to the user before a new quote");
    assert.equal(
      awaitingReplanReview.nodeRuns.find((node) => node.nodeId === "creative-planning")?.intervention?.continuation?.stage,
      "director",
    );
    const replanned = await confirmCreativeStages(pipeline, awaitingReplanReview);
    assert.equal(replanned.status, "awaiting_spend_approval", JSON.stringify(replanned.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const nextPlan = replanned.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(nextPlan);
    assert.equal(nextPlan.estimatedCostCny, 2.4, "only the retained generated shot should be quoted");

    // 调用闭包：构思与脚本不因费用退回重复调用，导演带费用反馈重做一次。
    assert.equal(spies.treatmentCalls, 1, "rejecting an asset quote must not re-run the treatment stage");
    assert.equal(spies.screenwriterBodies.length, 1, "rejecting an asset quote must not re-run the script stage");
    assert.equal(spies.directorInputs.length, 2, "the director must replan exactly once with cost feedback");
    const replanInput = spies.directorInputs[1]!;
    assert.ok(replanInput.costFeedback?.some((feedback) => feedback.reason === "too_expensive" && feedback.note === "只保留第一镜生成，其余用图库。"),
      "the replan director input must carry the structured cost feedback");
    // 检视仍可读：报价退回后的阶段状态来自当前 digest。
    const detail = await studio.get(paused.id);
    assert.ok(detail);
  });

  it("prices the actual v2 candidate, saves only through a same-identity ticket and blocks stale sequences without TTS", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-v2-"));
    let voiceCalls = 0;
    class NarrationForecastWorker extends ReworkWorker {
      forecastEnabled = true;
      override async forecastPaidVoiceSpend(request: Record<string, unknown>) {
        if (!this.forecastEnabled) return undefined;
        const plan = (request.input as Record<string, unknown>).narrationPlan as { groups: Array<{ id: string }> };
        const price = 0.02 * plan.groups.length;
        return { estimatedCostCny: price, maxCostCny: price, unitPriceCny: "2.00", source: "configured_rate" as const,
          items: plan.groups.map((group) => ({ groupId: group.id, estimatedUnits: 34, maxCostCny: price, reused: false })) };
      }
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "voice.synthesize") voiceCalls++;
        return super.run(request);
      }
    }
    const worker = new NarrationForecastWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] },
        { narrations: ["第一段。", "第二段。", "第三段。"] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const assetsVersionBefore = run.nodeRuns.find(node => node.nodeId === "assets")?.outputState?.effectiveVersionId;
    const gateBefore = run.nodeRuns.find(node => node.nodeId === "assets")?.intervention;
    const actor = "creator";
    const session = "editor-session-s2";

    // 初始来源身份由 GET 预览下发（宿主派生）。
    const initial = await pipeline.previewNarrationPlan(run.id);
    assert.ok(initial.sourceContextId, "GET 预览必须下发 sourceContextId");
    assert.equal(initial.editorContext.mode, "pre_generation");
    assert.equal(initial.editorContext.savedPlanStatus, "none");
    assert.equal(initial.editorContext.defaultPlan.version, "video-factory/narration-plan-v1");
    assert.ok(initial.editorContext.baseGroups.length > 0);
    assert.ok(initial.editorContext.baseGroups.every(group => group.allowedBoundaries.every(boundary =>
      boundary > 0 && boundary < group.endCodePoint)));
    const sourceContextId = initial.sourceContextId!;

    // 连续候选（空编辑）：对派生出的默认计划核价，一组一条报价。
    const emptyCandidate = { version: "video-factory/narration-plan-v2" as const, groups: [], userSilences: [] };
    const base = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 0,
      candidate: emptyCandidate, actor });
    assert.equal(base.quote.status, "estimated");
    assert.equal(base.quote.items?.length, 1, "连续候选按派生计划的一组报价");
    const baseGroupId = base.plan.groups[0]!.sourceRange.baseGroupId;
    const endCodePoint = base.plan.groups[0]!.sourceRange.endCodePoint;
    const baseGroup = initial.editorContext.baseGroups.find(group => group.baseGroupId === baseGroupId)!;
    const splitAt = baseGroup.allowedBoundaries[0]!;
    assert.ok(splitAt > 0 && splitAt < endCodePoint, "夹具必须从宿主下发的真实句界切分");
    assert.ok(base.ticketId.startsWith("npt-"));
    assert.equal(base.planSha256.length, 64);

    // 两组候选（在镜头文字边界切分）：必须按候选计划报两组价，而不是旧的一组价。
    const splitCandidate = { version: "video-factory/narration-plan-v2" as const,
      groups: [
        { sourceRange: { baseGroupId, startCodePoint: 0, endCodePoint: splitAt },
          window: { startFrame: 0, endFrame: 240 }, placement: { anchor: "start" as const, offsetFrames: 0 } },
        { sourceRange: { baseGroupId, startCodePoint: splitAt, endCodePoint },
          window: { startFrame: 240, endFrame: 720 }, placement: { anchor: "start" as const, offsetFrames: 0 } },
      ], userSilences: [] };
    const twoGroups = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 1,
      candidate: splitCandidate, actor });
    assert.equal(twoGroups.quote.items?.length, 2, "两组候选必须报两组价");
    assert.equal(twoGroups.quote.estimatedCostCny, 0.04);
    assert.equal(twoGroups.plan.groups.length, 2);
    assert.equal(twoGroups.plan.groups[0]!.text, Array.from(baseGroup.text).slice(0, splitAt).join(""));
    assert.deepEqual(twoGroups.plan.groups[0]!.sourceScenePositions, [1]);
    assert.deepEqual(twoGroups.plan.groups[1]!.sourceScenePositions, [2, 3]);

    // A→B→A：旧代次的票据在会话已有更高代次后不得保存。
    run = await pipeline.loadPersisted(run.id);
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-stale-seq", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 0, candidateId: base.candidateId,
      ticketId: base.ticketId, planSha256: base.planSha256, actor }), /编辑已经过期/);
    assert.equal(voiceCalls, 0);

    // 票据签发后文件字节被追加空白：对象语义虽然不变，也必须在采用前拒绝。
    const ticketPlanPath = path.join(workspaceRoot, "runs", run.id, "nodes", "voice", "plans", `${twoGroups.planSha256}.json`);
    const canonicalPlanBytes = await readFile(ticketPlanPath);
    await writeFile(ticketPlanPath, Buffer.concat([canonicalPlanBytes, Buffer.from(" ")]));
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-byte-tamper", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: twoGroups.editSequence, candidateId: twoGroups.candidateId,
      ticketId: twoGroups.ticketId, planSha256: twoGroups.planSha256, actor }), /字节|摘要|票据/);
    await writeFile(ticketPlanPath, canonicalPlanBytes);

    // 正常保存：只写声音输入，不批准素材、不触发 TTS。
    const saveInput = {
      requestId: "req-save-two-groups", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: twoGroups.editSequence, candidateId: twoGroups.candidateId,
      ticketId: twoGroups.ticketId, planSha256: twoGroups.planSha256, actor };
    const saved = await pipeline.confirmNarrationPlanV2(run.id, saveInput);
    assert.equal(saved.receipt.accepted, true);
    assert.equal(saved.receipt.replay, false);
    assert.equal(saved.run.revision, run.revision + 1);
    assert.equal(voiceCalls, 0, "核价与保存都不能隐式合成付费声音");
    const persisted = await pipeline.loadPersisted(run.id);
    const voiceNode = persisted.nodeRuns.find(node => node.nodeId === "voice")!;
    const version = voiceNode.inputState!.versions.find(v => v.id === voiceNode.inputState!.effectiveVersionId)!;
    assert.equal(version.schemaVersion, "video-factory/narration-plan-v2");
    const adoption = (version.value as Record<string, unknown>).narrationPlanAdoption as Record<string, unknown>;
    assert.equal(adoption.requestId, saveInput.requestId);
    assert.equal(adoption.inputVersionId, saved.receipt.inputVersionId);
    assert.equal(adoption.artifactId, saved.receipt.artifactId);
    assert.equal(adoption.resultingRunRevision, saved.receipt.resultingRunRevision);
    assert.equal(persisted.nodeRuns.find(node => node.nodeId === "assets")?.outputState?.effectiveVersionId, assetsVersionBefore,
      "保存旁白方案不改素材停点");
    assert.deepEqual(persisted.nodeRuns.find(node => node.nodeId === "assets")?.intervention, gateBefore);
    const currentRead = await pipeline.previewNarrationPlan(run.id);
    assert.equal(currentRead.confirmed, true);
    assert.equal(currentRead.plan.version, "video-factory/narration-plan-v2");
    assert.equal(currentRead.editorContext.savedPlanStatus, "current");

    // 同 request 同摘要重放（响应丢失后原样重发）：返回原收据，不新增输入版本。
    const replayed = await pipeline.confirmNarrationPlanV2(run.id, saveInput);
    assert.equal(replayed.receipt.replay, true);
    assert.equal(replayed.receipt.artifactId, saved.receipt.artifactId);
    const persistedAfterReplay = await pipeline.loadPersisted(run.id);
    assert.equal(persistedAfterReplay.revision, saved.run.revision, "重放不新增版本");
    // 同 ID 不同内容一律拒绝。
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, { ...saveInput, acknowledgeQuoteUnavailable: true }),
      /已被不同内容使用/);

    // B→A 后旧两段票据保存同样被拒（会话已有更高代次）。
    run = await pipeline.loadPersisted(run.id);
    const backToEmpty = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 2,
      candidate: emptyCandidate, actor });
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-stale-ticket", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: twoGroups.editSequence, candidateId: twoGroups.candidateId,
      ticketId: twoGroups.ticketId, planSha256: twoGroups.planSha256, actor }), /编辑已经过期/);
    assert.ok(backToEmpty.ticketId);

    // 核价不可得：未知价不冒充 0，无知情确认不得保存；知情确认可以保存。
    worker.forecastEnabled = false;
    const runForUnknown = await pipeline.loadPersisted(run.id);
    const unknownQuote = await pipeline.previewNarrationPlanV2(runForUnknown.id, {
      expectedRunRevision: runForUnknown.revision, sourceContextId, editorSessionId: session, editSequence: 3,
      candidate: emptyCandidate, actor });
    assert.equal(unknownQuote.quote.status, "unavailable");
    await assert.rejects(pipeline.confirmNarrationPlanV2(runForUnknown.id, {
      requestId: "req-unknown-quote", expectedRunRevision: runForUnknown.revision, sourceContextId,
      editorSessionId: session, editSequence: 3, candidateId: unknownQuote.candidateId,
      ticketId: unknownQuote.ticketId, planSha256: unknownQuote.planSha256, actor }), /核价不可用/);
    const acknowledged = await pipeline.confirmNarrationPlanV2(runForUnknown.id, {
      requestId: "req-unknown-quote-ack", expectedRunRevision: runForUnknown.revision, sourceContextId,
      editorSessionId: session, editSequence: 3, candidateId: unknownQuote.candidateId,
      ticketId: unknownQuote.ticketId, planSha256: unknownQuote.planSha256,
      acknowledgeQuoteUnavailable: true, actor });
    assert.equal(acknowledged.receipt.accepted, true);
    assert.equal(voiceCalls, 0);

    // 正常上游版本操作即使输出字节不变，也必须令旧v2只作为过期参考，不能继续声称已确认。
    const beforeSourceChange = await pipeline.loadPersisted(run.id);
    const assetsBeforeSourceChange = beforeSourceChange.nodeRuns.find(node => node.nodeId === "assets")!;
    const previousAssetsVersionId = assetsBeforeSourceChange.outputState!.effectiveVersionId;
    const sameBytesNewUpstream = await pipeline.applyNodeOverride(run.id, {
      nodeId: "assets", actor, expectedRunRevision: beforeSourceChange.revision,
      output: structuredClone(assetsBeforeSourceChange.output),
    });
    assert.notEqual(sameBytesNewUpstream.nodeRuns.find(node => node.nodeId === "assets")!.outputState!.effectiveVersionId,
      previousAssetsVersionId, "正常版本操作应生成新的上游版本身份");
    const staleRead = await pipeline.previewNarrationPlan(run.id);
    assert.equal(staleRead.confirmed, false);
    assert.equal(staleRead.editorContext.savedPlanStatus, "stale");
    assert.equal(staleRead.plan.version, "video-factory/narration-plan-v1", "当前可编辑计划回到新来源默认事实");
    assert.equal(staleRead.editorContext.stalePlan?.version, "video-factory/narration-plan-v2",
      "旧v2只读保留为过期参考，不静默降级或继续采用");

    // 显式取消高级计划：保存当前源默认v1，不删除历史v2文件、不批准素材。
    const beforeCancel = await pipeline.loadPersisted(run.id);
    const gateBeforeCancel = beforeCancel.nodeRuns.find(node => node.nodeId === "assets")?.intervention;
    const beforeV2Artifacts = beforeCancel.artifacts.filter(artifact => artifact.kind === "narration_plan"
      && artifact.schemaVersion === "video-factory/narration-plan-v2").length;
    const cancelled = await pipeline.confirmNarrationPlan(run.id, {
      expectedRunRevision: beforeCancel.revision, plan: staleRead.editorContext.defaultPlan, actor });
    const afterCancel = await pipeline.previewNarrationPlan(run.id);
    assert.equal(afterCancel.plan.version, "video-factory/narration-plan-v1");
    assert.equal(afterCancel.confirmed, true);
    assert.equal(afterCancel.editorContext.savedPlanStatus, "current");
    assert.equal(cancelled.nodeRuns.find(node => node.nodeId === "assets")?.intervention?.id, gateBeforeCancel?.id,
      "取消高级计划仍停在当前素材确认，不代替用户推进");
    assert.equal(cancelled.artifacts.filter(artifact => artifact.kind === "narration_plan"
      && artifact.schemaVersion === "video-factory/narration-plan-v2").length, beforeV2Artifacts,
    "取消只切回默认计划，历史v2留档仍在");
  });

  it("guards in-flight edit generations, adoption facts and immutable input identities (§4.2.3)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-v2-generations-"));
    let voiceCalls = 0;
    let forecastCalls = 0;
    const forecastGates: Array<Promise<void>> = [];
    const releaseGates: Array<() => void> = [];
    class GatedForecastWorker extends ReworkWorker {
      gateNextForecast = false;
      forecastThrows = false;
      override async forecastPaidVoiceSpend(request: Record<string, unknown>) {
        forecastCalls += 1;
        if (this.gateNextForecast) {
          this.gateNextForecast = false;
          let release!: () => void;
          forecastGates.push(new Promise<void>((resolve) => { release = resolve; }));
          releaseGates.push(release);
          await forecastGates.at(-1);
        }
        if (this.forecastThrows) throw new Error("formal forecast backend unreachable");
        const plan = (request.input as Record<string, unknown>).narrationPlan as { groups: Array<{ id: string }> };
        const price = 0.02 * plan.groups.length;
        return { estimatedCostCny: price, maxCostCny: price, unitPriceCny: "2.00", source: "configured_rate" as const,
          items: plan.groups.map((group) => ({ groupId: group.id, estimatedUnits: 34, maxCostCny: price, reused: false })) };
      }
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "voice.synthesize") voiceCalls++;
        return super.run(request);
      }
    }
    const worker = new GatedForecastWorker();
    let failAfterReservation = false;
    let failAfterCheckpoint = false;
    let holdConfirmationLock = false;
    let confirmationLockEntered: (() => void) | undefined;
    let confirmationLockRelease: Promise<void> | undefined;
    let previewAboutToLock: (() => void) | undefined;
    const pipelineOptions: ProductionPipelineOptions = { workspaceRoot, worker,
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    };
    const pipeline = new ProductionPipeline({ ...pipelineOptions,
      narrationPlanFailpoints: {
        beforePreviewGenerationLock: () => { previewAboutToLock?.(); previewAboutToLock = undefined; },
        afterConfirmationGenerationLock: async () => {
          if (!holdConfirmationLock) return;
          holdConfirmationLock = false;
          confirmationLockEntered?.();
          await confirmationLockRelease;
        },
        afterAdoptionReservation: () => {
          if (!failAfterReservation) return;
          failAfterReservation = false;
          throw new Error("TEST_FAIL_AFTER_NARRATION_ADOPTION_RESERVATION");
        },
        afterAdoptionCheckpoint: () => {
          if (!failAfterCheckpoint) return;
          failAfterCheckpoint = false;
          throw new Error("TEST_FAIL_AFTER_NARRATION_ADOPTION_CHECKPOINT");
        },
      },
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const actor = "creator";
    const session = "editor-session-generations";
    const initial = await pipeline.previewNarrationPlan(run.id);
    const sourceContextId = initial.sourceContextId!;
    const emptyCandidate = { version: "video-factory/narration-plan-v2" as const, groups: [], userSilences: [] };
    const base = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 0,
      candidate: emptyCandidate, actor });
    const baseGroupId = base.plan.groups[0]!.sourceRange.baseGroupId;
    const endCodePoint = base.plan.groups[0]!.sourceRange.endCodePoint;
    const splitCandidate = { version: "video-factory/narration-plan-v2" as const,
      groups: [
        { sourceRange: { baseGroupId, startCodePoint: 0, endCodePoint: 8 },
          window: { startFrame: 0, endFrame: 240 }, placement: { anchor: "start" as const, offsetFrames: 0 } },
        { sourceRange: { baseGroupId, startCodePoint: 8, endCodePoint },
          window: { startFrame: 240, endFrame: 720 }, placement: { anchor: "start" as const, offsetFrames: 0 } },
      ], userSilences: [] };

    // (a) A 先发但核价被闸门挂起；B（更高代次）先完成签票后，A 的迟到完成不得再签发旧代次票据。
    worker.gateNextForecast = true;
    const latePreview = pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 1,
      candidate: emptyCandidate, actor });
    await new Promise((resolve) => setTimeout(resolve, 150)); // 让 A 完成在途预留（真实并发在途）。
    const newer = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 2,
      candidate: emptyCandidate, actor });
    assert.ok(newer.ticketId);
    releaseGates.shift()!();
    await assert.rejects(latePreview, /过期|不同候选/);

    // (b) 同 session 同 sequence 异候选：在途预留被占用时，另一候选不得挤入同一代次。
    worker.gateNextForecast = true;
    const gatedPreview = pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 3,
      candidate: emptyCandidate, actor });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 3,
      candidate: splitCandidate, actor }), /同一编辑代次|不同候选|候选/);
    releaseGates.shift()!();
    const gated = await gatedPreview;
    assert.ok(gated.ticketId);

    // (c) 同序同候选可复用（重新预览同一编辑身份）。
    const reused = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 3,
      candidate: emptyCandidate, actor });
    assert.ok(reused.ticketId);

    // (d) 新代次在途（已预留、未签票）时，旧代次票据的保存必须被拒——不能只看已完成票据。
    worker.gateNextForecast = true;
    const reservedPreview = pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 4,
      candidate: emptyCandidate, actor });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-save-while-reserved", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: gated.editSequence, candidateId: gated.candidateId,
      ticketId: gated.ticketId, planSha256: gated.planSha256, actor }), /编辑已经过期/);
    releaseGates.shift()!();
    const reserved = await reservedPreview;
    assert.ok(reserved.ticketId);

    // (e) 核价阶段抛错是可恢复的“不可得”，不是 500：转 unavailable，知情保存仍绑定原票据。
    worker.forecastThrows = true;
    const failing = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 5,
      candidate: emptyCandidate, actor });
    assert.equal(failing.quote.status, "unavailable");
    worker.forecastThrows = false;
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-throwing-forecast", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 5, candidateId: failing.candidateId,
      ticketId: failing.ticketId, planSha256: failing.planSha256, actor }), /核价不可用/);

    // 正式保存 A 形态（seq5 未知价知情保存）作为 A→B→A 的第一环。
    const savedA = await pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-aba-a", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 5, candidateId: failing.candidateId,
      ticketId: failing.ticketId, planSha256: failing.planSha256,
      acknowledgeQuoteUnavailable: true, actor });
    assert.equal(savedA.receipt.accepted, true);
    assert.equal(savedA.receipt.current, true, "新保存的输入版本即当前版本");
    run = await pipeline.loadPersisted(run.id);

    // (f) 同 run 跨 actor 重放：请求摘要必须绑定 actor，别人不能用自己的身份取走原收据。
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-aba-a", expectedRunRevision: savedA.receipt.expectedRunRevision, sourceContextId,
      editorSessionId: session, editSequence: 5, candidateId: failing.candidateId,
      ticketId: failing.ticketId, planSha256: failing.planSha256,
      acknowledgeQuoteUnavailable: true, actor: "another-actor" }), /已被不同内容使用/);

    // (h) A→B→A：同一内容重新保存生成新输入版本；旧版本身份不可被 plan SHA 覆盖。
    const versionARecord = structuredClone(run.nodeRuns.find(node => node.nodeId === "voice")!
      .inputState!.versions.find(version => version.id === savedA.receipt.inputVersionId));
    const bPreview = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 6,
      candidate: splitCandidate, actor });
    const savedB = await pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-aba-b", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 6, candidateId: bPreview.candidateId,
      ticketId: bPreview.ticketId, planSha256: bPreview.planSha256, actor });
    run = await pipeline.loadPersisted(run.id);
    const aAgainPreview = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 7,
      candidate: emptyCandidate, actor });
    assert.equal(aAgainPreview.planSha256, savedA.receipt.planSha256, "同内容候选得到同一计划字节");
    const savedA2 = await pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-aba-a2", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 7, candidateId: aAgainPreview.candidateId,
      ticketId: aAgainPreview.ticketId, planSha256: aAgainPreview.planSha256, actor });
    assert.notEqual(savedA2.receipt.inputVersionId, savedA.receipt.inputVersionId, "同内容重保存是新的输入版本");
    run = await pipeline.loadPersisted(run.id);
    const voiceInput = run.nodeRuns.find(node => node.nodeId === "voice")!.inputState!;
    const versionAAfter = voiceInput.versions.find(version => version.id === savedA.receipt.inputVersionId)!;
    assert.deepEqual(versionAAfter, versionARecord, "旧输入版本记录（含身份）在 A→B→A 后逐字节不变");
    assert.equal((versionARecord.value as Record<string, unknown>).voiceInputVersionId, savedA.receipt.inputVersionId,
      "输入来源身份随 input version 固化，而不是按 plan SHA 覆盖");
    assert.equal((voiceInput.versions.find(version => version.id === savedA2.receipt.inputVersionId)!
      .value as Record<string, unknown>).voiceInputVersionId, savedA2.receipt.inputVersionId);
    // A 的历史收据重放返回原收据且 isCurrent=false，不回滚当前版本。
    const replayA = await pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-aba-a", expectedRunRevision: savedA.receipt.expectedRunRevision, sourceContextId,
      editorSessionId: session, editSequence: 5, candidateId: failing.candidateId,
      ticketId: failing.ticketId, planSha256: failing.planSha256,
      acknowledgeQuoteUnavailable: true, actor });
    assert.equal(replayA.receipt.replay, true);
    assert.equal(replayA.receipt.current, false, "已采用 B/A′ 后，A 的历史收据不再当前");
    assert.equal(voiceInput.effectiveVersionId, savedA2.receipt.inputVersionId);

    // (g) confirm持最终代次锁时，后发preview必须等待；confirm提交后preview按旧revision失败，
    // 且不能留下seq8之后的旧来源票据/预留。用明确闸门而不是sleep碰运气。
    run = await pipeline.loadPersisted(run.id);
    const lockedPreview = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 8,
      candidate: emptyCandidate, actor });
    let markConfirmationLockEntered!: () => void;
    const confirmationEntered = new Promise<void>((resolve) => { markConfirmationLockEntered = resolve; });
    let releaseConfirmationLock!: () => void;
    confirmationLockRelease = new Promise<void>((resolve) => { releaseConfirmationLock = resolve; });
    confirmationLockEntered = markConfirmationLockEntered;
    holdConfirmationLock = true;
    const lockedSaveDraft = {
      requestId: "req-confirm-holds-generation-lock", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 8, candidateId: lockedPreview.candidateId,
      ticketId: lockedPreview.ticketId, planSha256: lockedPreview.planSha256, actor,
    };
    const lockedSave = pipeline.confirmNarrationPlanV2(run.id, lockedSaveDraft);
    await confirmationEntered;
    let markPreviewAboutToLock!: () => void;
    const previewReachedGenerationLock = new Promise<void>((resolve) => { markPreviewAboutToLock = resolve; });
    previewAboutToLock = markPreviewAboutToLock;
    let competingSettled = false;
    const competingPreview = pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 9,
      candidate: splitCandidate, actor });
    void competingPreview.finally(() => { competingSettled = true; }).catch(() => undefined);
    await previewReachedGenerationLock;
    await Promise.resolve();
    assert.equal(competingSettled, false, "preview到达代次锁后必须等待持锁confirm");
    releaseConfirmationLock();
    const lockedSaved = await lockedSave;
    assert.equal(lockedSaved.receipt.accepted, true);
    await assert.rejects(competingPreview, /revision|版本|刷新|过期/i);
    const ticketDirectory = path.join(workspaceRoot, "runs", run.id, "nodes", "voice", "plan-preview-tickets");
    const reservationsAfterRace = JSON.parse(await readFile(path.join(ticketDirectory, "reservations.json"), "utf8"));
    assert.ok(!reservationsAfterRace.some((entry: Record<string, unknown>) => entry.editSequence === 9),
      "旧revision的preview不得污染耐久代次预留");
    for (const name of await readdir(ticketDirectory)) {
      if (!name.endsWith(".json") || name === "reservations.json") continue;
      const ticket = JSON.parse(await readFile(path.join(ticketDirectory, name), "utf8"));
      assert.notEqual(ticket.editSequence, 9, "旧revision的preview不得留下可用票据");
    }

    // (i) operation预留后进程中断：新Pipeline实例用原requestId继续，复用固定artifact/input身份。
    run = await pipeline.loadPersisted(run.id);
    const reservedCrashPreview = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 9,
      candidate: emptyCandidate, actor });
    const reservedCrashDraft = {
      requestId: "req-crash-after-reservation", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 9, candidateId: reservedCrashPreview.candidateId,
      ticketId: reservedCrashPreview.ticketId, planSha256: reservedCrashPreview.planSha256, actor,
    };
    failAfterReservation = true;
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, reservedCrashDraft),
      /TEST_FAIL_AFTER_NARRATION_ADOPTION_RESERVATION/);
    const receiptDirectory = path.join(workspaceRoot, "runs", run.id, "nodes", "voice", "plan-confirm-receipts");
    const reservedOperation = JSON.parse(await readFile(path.join(receiptDirectory, `${reservedCrashDraft.requestId}.json`), "utf8"));
    assert.equal(reservedOperation.state, "reserved");
    const beforeReservationRecovery = await pipeline.loadPersisted(run.id);
    assert.ok(!beforeReservationRecovery.nodeRuns.find(node => node.nodeId === "voice")?.inputState?.versions.some(version =>
      (version.value as Record<string, unknown>)?.narrationPlanAdoption
      && ((version.value as Record<string, unknown>).narrationPlanAdoption as Record<string, unknown>).requestId === reservedCrashDraft.requestId));
    const restartedAfterReservation = new ProductionPipeline(pipelineOptions);
    const recoveredReservation = await restartedAfterReservation.confirmNarrationPlanV2(run.id, reservedCrashDraft);
    assert.equal(recoveredReservation.receipt.replay, false, "未采用的预留应继续完成，而不是假装历史成功");
    assert.equal(recoveredReservation.receipt.artifactId, reservedOperation.artifactId);
    assert.equal(recoveredReservation.receipt.inputVersionId, reservedOperation.inputVersionId);

    // (j) run checkpoint后、sidecar投影前中断：run采用是权威；原ID重启重放不新增版本。
    run = await restartedAfterReservation.loadPersisted(run.id);
    const checkpointCrashPreview = await restartedAfterReservation.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 10,
      candidate: splitCandidate, actor });
    const checkpointCrashDraft = {
      requestId: "req-crash-after-checkpoint", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 10, candidateId: checkpointCrashPreview.candidateId,
      ticketId: checkpointCrashPreview.ticketId, planSha256: checkpointCrashPreview.planSha256, actor,
    };
    failAfterCheckpoint = true;
    const versionsBeforeCheckpointCrash = run.nodeRuns.find(node => node.nodeId === "voice")!.inputState!.versions.length;
    await assert.rejects(pipeline.confirmNarrationPlanV2(run.id, checkpointCrashDraft),
      /TEST_FAIL_AFTER_NARRATION_ADOPTION_CHECKPOINT/);
    const adoptedDespiteLostResponse = await pipeline.loadPersisted(run.id);
    assert.equal(adoptedDespiteLostResponse.revision, run.revision + 1, "checkpoint已正式采用，不能由落后sidecar否认");
    assert.equal(adoptedDespiteLostResponse.nodeRuns.find(node => node.nodeId === "voice")!.inputState!.versions.length,
      versionsBeforeCheckpointCrash + 1);
    const checkpointOperationBeforeRecovery = JSON.parse(await readFile(
      path.join(receiptDirectory, `${checkpointCrashDraft.requestId}.json`), "utf8"));
    assert.equal(checkpointOperationBeforeRecovery.state, "reserved", "故障发生在sidecar投影之前");
    const restartedAfterCheckpoint = new ProductionPipeline(pipelineOptions);
    const replayedCheckpoint = await restartedAfterCheckpoint.confirmNarrationPlanV2(run.id, checkpointCrashDraft);
    assert.equal(replayedCheckpoint.receipt.replay, true);
    assert.equal(replayedCheckpoint.receipt.artifactId, checkpointOperationBeforeRecovery.artifactId);
    assert.equal(replayedCheckpoint.receipt.inputVersionId, checkpointOperationBeforeRecovery.inputVersionId);
    const afterCheckpointReplay = await restartedAfterCheckpoint.loadPersisted(run.id);
    assert.equal(afterCheckpointReplay.revision, adoptedDespiteLostResponse.revision, "重放不得新增run版本");
    assert.equal(afterCheckpointReplay.nodeRuns.find(node => node.nodeId === "voice")!.inputState!.versions.length,
      versionsBeforeCheckpointCrash + 1, "重放不得新增输入版本");
    const projectedCheckpointOperation = JSON.parse(await readFile(
      path.join(receiptDirectory, `${checkpointCrashDraft.requestId}.json`), "utf8"));
    assert.equal(projectedCheckpointOperation.state, "projected", "重放修复落后的sidecar投影");
    await rm(path.join(receiptDirectory, `${checkpointCrashDraft.requestId}.json`));
    const replayedWithoutSidecar = await new ProductionPipeline(pipelineOptions)
      .confirmNarrationPlanV2(run.id, checkpointCrashDraft);
    assert.equal(replayedWithoutSidecar.receipt.replay, true, "sidecar缺失时仍从正式run采用事实恢复原结果");
    assert.equal((await new ProductionPipeline(pipelineOptions).loadPersisted(run.id)).revision,
      adoptedDespiteLostResponse.revision, "修复sidecar不得新增正式版本");
    assert.equal(JSON.parse(await readFile(path.join(receiptDirectory, `${checkpointCrashDraft.requestId}.json`), "utf8")).state,
      "projected", "缺失sidecar由正式采用事实重建");
    assert.equal(voiceCalls, 0);
    assert.ok(forecastCalls >= 8, "预览核价真实发生");
  });

  it("registers real manifest and receipt artifacts when the first v2 fit conflicts (§4.2.4)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-first-fit-"));
    // 真实 Python worker：受控合成 1 秒音频（30 帧），窗口只有 15 帧 → 首次排轨冲突。
    class ControlledFirstFitWorker extends ReworkWorker {
      synthesisCalls = 0;
      relayoutCalls = 0;
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability !== "voice.synthesize") return super.run(request);
        if ((request.input as Record<string, unknown>).relayout === true) this.relayoutCalls += 1;
        else this.synthesisCalls += 1;
        return controlledVoiceWorker(request);
      }
    }
    const worker = new ControlledFirstFitWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      ...jointReworkAgents(
        { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] },
        { narrations: ["第一段。", "第二段。", "第三段。"] },
      ),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const actor = "creator";
    const session = "first-fit-session";
    const initial = await pipeline.previewNarrationPlan(run.id);
    const sourceContextId = initial.sourceContextId!;
    await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 0,
      candidate: { version: "video-factory/narration-plan-v2", groups: [], userSilences: [] }, actor });
    const firstBase = initial.editorContext.baseGroups[0]!;
    const splitAt = firstBase.allowedBoundaries[0]!;
    assert.ok(splitAt > 0 && splitAt < firstBase.endCodePoint, "夹具必须提供真实句界拆分 A/B");
    // 两组均真实物化；A 窗口只给 15 帧（受控音频 1 秒=30 帧）→ 首次排轨放不下，
    // 但 A/B 都必须由本次 receipt 精确投影为可试听来源。
    const preview = await pipeline.previewNarrationPlanV2(run.id, {
      expectedRunRevision: run.revision, sourceContextId, editorSessionId: session, editSequence: 1,
      candidate: { version: "video-factory/narration-plan-v2", groups: [
        { sourceRange: { baseGroupId: firstBase.baseGroupId, startCodePoint: 0, endCodePoint: splitAt },
          window: { startFrame: 0, endFrame: 15 }, placement: { anchor: "start", offsetFrames: 0 } },
        { sourceRange: { baseGroupId: firstBase.baseGroupId, startCodePoint: splitAt,
            endCodePoint: firstBase.endCodePoint },
          window: { startFrame: 240, endFrame: 480 }, placement: { anchor: "start", offsetFrames: 0 } },
      ], userSilences: [] }, actor });
    const saved = await pipeline.confirmNarrationPlanV2(run.id, {
      requestId: "req-first-fit-save", expectedRunRevision: run.revision, sourceContextId,
      editorSessionId: session, editSequence: 1, candidateId: preview.candidateId,
      ticketId: preview.ticketId, planSha256: preview.planSha256,
      acknowledgeQuoteUnavailable: true, actor });
    assert.equal(saved.receipt.accepted, true);
    // 确认素材进入配音：真实 Python worker 物化后首次 fit 冲突 → 可恢复停点。
    run = await pipeline.loadPersisted(run.id);
    run = await pipeline.decide(run.id, { interventionId: run.nodeRuns
      .find(node => node.nodeId === "assets")!.intervention!.id, action: "approve", actor: "creator",
      expectedRunRevision: run.revision, reviewEvidenceId: null });
    for (let observation = 0; observation < 200; observation++) {
      const persisted = await pipeline.loadPersisted(run.id);
      const voice = persisted.nodeRuns.find(node => node.nodeId === "voice");
      if (persisted.status === "needs_human" && voice?.status === "needs_human" && voice.intervention) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const stopped = await pipeline.loadPersisted(run.id);
    const voiceStopped = stopped.nodeRuns.find(node => node.nodeId === "voice")!;
    assert.equal(voiceStopped.status, "needs_human", "首次 fit 冲突转为可恢复停点，不是 failed");
    assert.match(voiceStopped.intervention?.reason ?? "", /调整时间|不重新购买/);
    assert.equal(worker.synthesisCalls, 1, "音频已真实物化（一次受控合成）后冲突");
    // 真实产物登记：manifest + 不可变 receipt（kind 固定）互相绑定真实 artifactId。
    const manifestArtifact = stopped.artifacts.find(artifact => artifact.kind === "voice_source_manifest");
    const receiptArtifact = stopped.artifacts.find(artifact => artifact.kind === "voice_source_receipt");
    assert.ok(manifestArtifact?.uri, "来源清单已登记为正式产物");
    assert.ok(receiptArtifact?.uri, "来源收据已登记为正式产物（不再只是 output 字段）");
    const receiptBytes = await readFile(receiptArtifact!.uri!);
    assert.equal(createHash("sha256").update(receiptBytes).digest("hex"), receiptArtifact!.sha256,
      "收据产物记录的是实际文件字节 SHA");
    const receiptDoc = JSON.parse(receiptBytes.toString("utf8"));
    assert.equal(receiptDoc.version, "video-factory/voice-source-receipt-v1");
    assert.equal(receiptDoc.reason, "first_fit_conflict");
    assert.equal(receiptDoc.manifestArtifactId, manifestArtifact!.id, "收据绑定真实 manifest artifactId");
    assert.equal(receiptDoc.narrationPlan.version, "video-factory/narration-plan-v2",
      "收据计划版本取自受核原计划（不是 manifest 版本）");
    const manifestDoc = JSON.parse(await readFile(manifestArtifact!.uri!, "utf8"));
    for (const [field, label] of [["script", "脚本"], ["visualPlan", "画面方案"]] as const) {
      const source = manifestDoc[field] as { artifactId?: string; outputVersionId?: string };
      const artifact = stopped.artifacts.find(candidate => candidate.id === source.artifactId);
      const producer = stopped.nodeRuns.find(node => node.nodeId === artifact?.producer?.nodeId);
      const effectiveVersion = producer?.outputState?.versions.find(version =>
        version.id === producer.outputState?.effectiveVersionId);
      assert.ok(artifact && effectiveVersion?.artifactIds.includes(artifact.id),
        `${label}产物必须属于其真实 producer 的当前有效输出版本`);
      assert.equal(source.outputVersionId, effectiveVersion.id,
        `${label}来源必须固化真实 output version，不能从 upstream 数组位置猜测`);
    }
    const persistedVoice = stopped.nodeRuns.find(node => node.nodeId === "voice")!;
    const voiceInput = persistedVoice.inputState!;
    const savedPlanPath = (voiceInput.versions.find(v => v.id === voiceInput.effectiveVersionId)!
      .value as Record<string, unknown>).narrationPlanPath as string;
    assert.equal(receiptDoc.narrationPlan.sha256,
      createHash("sha256").update(await readFile(savedPlanPath)).digest("hex"),
      "收据计划 SHA 是原计划文件字节 SHA（不是 canonicalSourceSha256 或空值）");
    const outputReceipt = (voiceStopped.output as Record<string, unknown>).voiceSourceReceipt as Record<string, unknown>;
    assert.equal(outputReceipt?.manifestArtifactId, manifestArtifact!.id);
    assert.equal(outputReceipt?.receiptArtifactId, receiptArtifact!.id, "停点输出同时引用两件真实产物");
    const groupAudioArtifacts = outputReceipt.groupAudioArtifacts as Array<{ groupId: string; artifactId: string }>;
    assert.deepEqual(groupAudioArtifacts.map(item => item.groupId),
      manifestDoc.groups.map((group: Record<string, unknown>) => group.groupId),
      "试听投影严格按本次 manifest 全组顺序，不扫描 run 历史 raw");
    assert.equal(groupAudioArtifacts.length, 2, "首次冲突的 A/B 两组都可试听，不只保留冲突组");
    for (const [index, item] of groupAudioArtifacts.entries()) {
      const artifact = stopped.artifacts.find(candidate => candidate.id === item.artifactId);
      const manifestGroup = manifestDoc.groups[index] as { raw: { sha256: string; byteSize: number } };
      assert.equal(artifact?.kind, "voiceover_raw");
      assert.equal(artifact?.sha256, manifestGroup.raw.sha256);
      assert.equal(artifact?.sizeBytes, manifestGroup.raw.byteSize);
      assert.ok(artifact?.uri && (await readFile(artifact.uri)).byteLength > 0,
        `第 ${index + 1} 组试听文件可读取`);
    }
    assert.deepEqual(receiptDoc.groupAudioArtifacts, groupAudioArtifacts,
      "正式 receipt 文件与停点输出使用同一组受核 artifact ID");
    const conflict = (voiceStopped.output as Record<string, unknown>).conflict as Record<string, unknown>;
    assert.equal(conflict?.version, "video-factory/narration-fit-conflict-v2");
    assert.equal(conflict?.code, "NARRATION_GROUP_DOES_NOT_FIT_V2");
    assert.ok(conflict?.sourceRange && conflict?.window && conflict?.placement);
    assert.ok(Array.isArray(conflict?.sourceScenePositions) && conflict.sourceScenePositions.length > 0);
    assert.ok(typeof conflict?.sourceSamples === "number" && conflict.sourceSamples > 0);
    assert.ok(typeof conflict?.requiredFrames === "number");
    assert.equal(conflict?.availableFrames, 15);
    assert.ok(typeof conflict?.shortfallFrames === "number" && conflict.shortfallFrames >= 15);
    assert.equal(conflict?.sourceOperationId, receiptDoc.sourceOperationId);
    assert.equal(conflict?.sourceContextId, sourceContextId);
    assert.equal(conflict?.manifestArtifactId, manifestArtifact!.id);
    assert.equal(conflict?.manifestSha256, receiptDoc.manifestSha256);
    assert.equal(conflict?.cuts, undefined, "v2 窄窗口不伪造完整 cuts");
    assert.equal(Object.values(conflict).some(value => value === undefined), false, "冲突合同不输出 undefined");

    const savedPlanDoc = JSON.parse(await readFile(savedPlanPath, "utf8"));
    const voiceNodeRoot = path.join(workspaceRoot, "runs", stopped.id, "nodes", "voice");
    const immutableSourcePaths = [manifestArtifact!.uri!,
      path.join(voiceNodeRoot, manifestDoc.ledger.snapshot.relativePath),
      ...manifestDoc.groups.map((group: { raw: { relativePath: string } }) =>
        path.join(voiceNodeRoot, group.raw.relativePath))];
    const immutableSourceBytes = new Map(await Promise.all(immutableSourcePaths.map(async (sourcePath) =>
      [sourcePath, await readFile(sourcePath)] as const)));
    const stillTightRequest = {
      action: "relayout_narration" as const, intent: "apply" as const,
      requestId: "relayout-first-fit-still-tight", expectedRunRevision: stopped.revision,
      interventionId: voiceStopped.intervention!.id,
      sourceContextId, actor, note: "保持原窄窗口以核对再次 fit 冲突合同",
      source: {
        kind: "materialized_operation" as const, voiceInputVersionId: voiceInput.effectiveVersionId,
        sourceVoiceOperationId: receiptDoc.sourceOperationId,
        sourceManifestArtifactId: manifestArtifact!.id,
        sourceManifestSha256: receiptDoc.manifestSha256,
        sourceReceiptArtifactId: receiptArtifact!.id,
      },
      layout: {
        narrationPlanVersion: "video-factory/narration-plan-v2" as const,
        groups: savedPlanDoc.groups.map((group: Record<string, any>) => ({
          groupId: String(group.id), window: group.window, placement: group.placement,
        })),
        userSilences: [],
      },
    };
    await assert.rejects(pipeline.dispatchNarrationRevision(stopped.id, stillTightRequest), /时间调整没有完成/);
    const retryConflictRecord = JSON.parse(await readFile(path.join(workspaceRoot, "runs", stopped.id,
      "nodes", "voice", "relayout-operations", `${stillTightRequest.requestId}.json`), "utf8"));
    assert.equal(retryConflictRecord.state, "failed");
    assert.deepEqual(retryConflictRecord.conflict, conflict,
      "首次与再次 v2 fit 冲突使用同一完整合同");

    const relayouted = await pipeline.requestNarrationRevision(stopped.id, {
      action: "relayout_narration", intent: "apply", requestId: "relayout-first-fit-sources",
      expectedRunRevision: stopped.revision, interventionId: voiceStopped.intervention!.id,
      sourceContextId, actor, note: "放宽第一段窗口后只用已生成声音重新排轨",
      source: {
        kind: "materialized_operation", voiceInputVersionId: voiceInput.effectiveVersionId,
        sourceVoiceOperationId: receiptDoc.sourceOperationId,
        sourceManifestArtifactId: manifestArtifact!.id,
        sourceManifestSha256: receiptDoc.manifestSha256,
        sourceReceiptArtifactId: receiptArtifact!.id,
      },
      layout: {
        narrationPlanVersion: "video-factory/narration-plan-v2",
        groups: manifestDoc.groups.map((group: Record<string, unknown>, index: number) => ({
          groupId: String(group.groupId),
          window: index === 0 ? { startFrame: 0, endFrame: 120 } : { startFrame: 240, endFrame: 480 },
          placement: { anchor: "start" as const, offsetFrames: 0 },
        })),
        userSilences: [],
      },
    });
    const relayoutedVoice = relayouted.nodeRuns.find(node => node.nodeId === "voice")!;
    assert.equal(relayouted.status, "needs_human");
    assert.equal(relayoutedVoice.status, "needs_human");
    assert.equal(worker.synthesisCalls, 1, "已有首次冲突收据时不得重建清单或重新合成");
    assert.equal(worker.relayoutCalls, 2, "一次再 fit 冲突与一次成功均只进入纯本地排轨");
    assert.ok(relayouted.artifacts.some(artifact => artifact.kind === "voiceover"
      && relayoutedVoice.artifactIds.includes(artifact.id)), "排轨成功后才产生真实可试听音轨");

    // 现行§4.3.5要求真正的v2连续调整：B→C改变窗口并增加显式留白，A′再回到B形态。
    // 三次都从当前正式声音版本出发，原manifest/raw/ledger只读，且各自预留独立input/output。
    const buildV2VoiceRequest = async (current: typeof relayouted, requestId: string,
      windows: Array<{ startFrame: number; endFrame: number }>,
      userSilences: Array<{ startFrame: number; endFrame: number }>) => {
      const currentVoice = current.nodeRuns.find(node => node.nodeId === "voice")!;
      const currentVersionId = currentVoice.outputState!.effectiveVersionId;
      const currentVersion = currentVoice.outputState!.versions.find(version => version.id === currentVersionId)!;
      const currentPlanArtifact = current.artifacts.find(artifact => currentVersion.artifactIds.includes(artifact.id)
        && artifact.kind === "voiceover_plan")!;
      const currentAudioArtifact = current.artifacts.find(artifact => currentVersion.artifactIds.includes(artifact.id)
        && artifact.kind === "voiceover")!;
      const currentPlanDocument = JSON.parse(await readFile(currentPlanArtifact.uri!, "utf8"));
      assert.equal(currentPlanDocument.narrationPlan.version, "video-factory/narration-plan-v2");
      assert.equal(currentPlanDocument.narrationPlan.groups.length, windows.length);
      return {
        action: "relayout_narration" as const, intent: "apply" as const, requestId,
        expectedRunRevision: current.revision, interventionId: currentVoice.intervention!.id,
        sourceContextId, actor, note: `v2连续时间调整 ${requestId}`,
        source: { kind: "voice_version" as const, voiceVersionId: currentVersionId,
          voicePlanArtifactId: currentPlanArtifact.id, voicePlanSha256: currentPlanArtifact.sha256!,
          expectedNarrationPlanSha256: createHash("sha256")
            .update(canonicalJsonV2(currentPlanDocument.narrationPlan), "utf8").digest("hex"),
          expectedLayoutKey: currentPlanDocument.layoutKey,
          expectedAudioSha256: currentAudioArtifact.sha256!,
          sourceVoiceOperationId: currentPlanDocument.voiceOperationId },
        layout: { narrationPlanVersion: "video-factory/narration-plan-v2" as const,
          groups: currentPlanDocument.narrationPlan.groups.map((group: Record<string, any>, index: number) => ({
            groupId: String(group.id), window: windows[index]!, placement: group.placement,
          })), userSilences },
      };
    };
    const versionB = relayoutedVoice.outputState!.effectiveVersionId;
    const inputB = relayoutedVoice.inputState!.effectiveVersionId;
    const requestC = await buildV2VoiceRequest(relayouted, "relayout-v2-c",
      [{ startFrame: 0, endFrame: 150 }, { startFrame: 240, endFrame: 480 }],
      [{ startFrame: 150, endFrame: 210 }]);
    const relayoutedC = await pipeline.requestNarrationRevision(relayouted.id, requestC);
    const voiceC = relayoutedC.nodeRuns.find(node => node.nodeId === "voice")!;
    const versionC = voiceC.outputState!.effectiveVersionId;
    const inputC = voiceC.inputState!.effectiveVersionId;
    const planC = JSON.parse(await readFile((voiceC.output as { voiceoverPlanPath: string }).voiceoverPlanPath, "utf8"));
    assert.deepEqual(planC.narrationPlan.groups.map((group: Record<string, any>) => group.window),
      requestC.layout.groups.map(group => group.window));
    assert.deepEqual(planC.narrationPlan.silences.filter((silence: Record<string, unknown>) => silence.source === "user")
      .map((silence: Record<string, unknown>) => ({ startFrame: silence.startFrame, endFrame: silence.endFrame })),
      requestC.layout.userSilences, "C保存新的显式留白");

    const requestA2 = await buildV2VoiceRequest(relayoutedC, "relayout-v2-a2",
      [{ startFrame: 0, endFrame: 120 }, { startFrame: 240, endFrame: 480 }], []);
    const relayoutedA2 = await pipeline.requestNarrationRevision(relayoutedC.id, requestA2);
    const voiceA2 = relayoutedA2.nodeRuns.find(node => node.nodeId === "voice")!;
    const versionA2 = voiceA2.outputState!.effectiveVersionId;
    const inputA2 = voiceA2.inputState!.effectiveVersionId;
    const planA2 = JSON.parse(await readFile((voiceA2.output as { voiceoverPlanPath: string }).voiceoverPlanPath, "utf8"));
    assert.deepEqual(planA2.narrationPlan.groups.map((group: Record<string, any>) => group.window),
      requestA2.layout.groups.map(group => group.window), "A′窗口回到B形态");
    assert.deepEqual(planA2.narrationPlan.silences.filter((silence: Record<string, unknown>) => silence.source === "user"), [],
      "A′撤销C的显式留白");
    assert.equal(planA2.voiceOperationId, receiptDoc.sourceOperationId, "连续排轨始终复用原TTS操作");
    assert.equal(worker.synthesisCalls, 1, "v2 B→C→A′不重新购买声音");
    assert.equal(worker.relayoutCalls, 4, "一次再次fit冲突加B/C/A′各一次正式本地排轨");
    assert.equal(new Set([versionB, versionC, versionA2]).size, 3, "B/C/A′输出版本独立");
    assert.equal(new Set([inputB, inputC, inputA2]).size, 3, "B/C/A′输入版本独立");
    const operationDocuments = await Promise.all(["relayout-first-fit-sources", "relayout-v2-c", "relayout-v2-a2"]
      .map(requestId => readFile(path.join(voiceNodeRoot, "relayout-operations", `${requestId}.json`), "utf8")
        .then(content => JSON.parse(content))));
    assert.equal(new Set(operationDocuments.map(operation => operation.layoutOperationId)).size, 3,
      "B/C/A′布局操作身份独立");
    assert.equal(new Set(operationDocuments.map(operation => operation.reservedInputVersionId)).size, 3,
      "B/C/A′预留输入身份独立");
    assert.equal(new Set(operationDocuments.map(operation => operation.reservedOutputVersionId)).size, 3,
      "B/C/A′预留输出身份独立");
    for (const [sourcePath, originalBytes] of immutableSourceBytes) {
      assert.deepEqual(await readFile(sourcePath), originalBytes,
        `连续排轨不得改写原来源 ${path.relative(voiceNodeRoot, sourcePath)}`);
    }
  });

  it("recovers a fully materialized v2 voice manifest through the host's original paid-operation action", async () => {
    for (const crashPoint of ["before_manifest", "after_manifest", "deterministic_failure"] as const) {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), `vf-voice-manifest-${crashPoint}-`));
      class InterruptedManifestWorker extends ReworkWorker {
        synthesisCalls = 0;
        rebuildCalls = 0;
        originalOperationId?: string;
        override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
          if (request.capability !== "voice.synthesize") return super.run(request);
          const input = request.input as Record<string, unknown>;
          if (input.rebuild_manifest === true) {
            this.rebuildCalls += 1;
            assert.equal(request.commandId, this.originalOperationId, "归档恢复沿原声音 operation id");
            assert.equal(typeof input.manifestPath === "string", crashPoint !== "before_manifest",
              "宿主只在写后中断时传入自己发现的既有 manifest");
            return controlledVoiceWorker(request);
          }
          this.synthesisCalls += 1;
          assert.equal(this.synthesisCalls, 1, "全组已物化后不得再次进入普通合成路径");
          this.originalOperationId = String(request.commandId);
          const response = await controlledVoiceWorker(request);
          const manifest = response.artifacts.find(artifact => artifact.kind === "voice_source_manifest");
          assert.ok(manifest?.uri, "受控首次请求必须已完成全组物化并生成来源清单");
          if (crashPoint === "before_manifest") await rm(manifest.uri!);
          // 模拟宿主未收到正常 worker 响应；原账本/raw/metadata 均已耐久，不能换 ID 重买。
          return {
            protocolVersion: "video-factory/worker-v1",
            commandId: String(request.commandId),
            status: "failed",
            error: { code: "WORKER_REQUEST_FAILED", message: `simulated ${crashPoint} response loss` },
            artifacts: [],
            ...(crashPoint === "deterministic_failure"
              ? { diagnostics: { providerOutcomeKnown: true, meteredAttemptCount: 1, meteredFailedAttemptCount: 0 } }
              : {}),
          };
        }
      }
      const worker = new InterruptedManifestWorker();
      const pipelineOptions: ProductionPipelineOptions = {
        workspaceRoot,
        worker,
        ...jointReworkAgents(
          { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] },
          { narrations: ["第一段。", "第二段。", "第三段。"] },
        ),
        assetProviders: REWORK_ASSET_PROVIDERS,
        providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
          transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
      };
      const pipeline = new ProductionPipeline(pipelineOptions);
      const brief = jointReworkBrief();
      let run = await pipeline.start({ ...brief,
        providers: { ...brief.providers, voice: "minimax-tts-v1" },
        economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
        voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
        workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
      });
      for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
        const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
        assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
        run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
          : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
            expectedRunRevision: run.revision, reviewEvidenceId: null });
      }
      const initial = await pipeline.previewNarrationPlan(run.id);
      const base = initial.editorContext.baseGroups[0]!;
      const splitAt = base.allowedBoundaries[0]!;
      assert.ok(splitAt > 0 && splitAt < base.endCodePoint);
      const preview = await pipeline.previewNarrationPlanV2(run.id, {
        expectedRunRevision: run.revision, sourceContextId: initial.sourceContextId!, editorSessionId: "recover-session",
        editSequence: 1, candidate: { version: "video-factory/narration-plan-v2", groups: [
          { sourceRange: { baseGroupId: base.baseGroupId, startCodePoint: 0, endCodePoint: splitAt },
            window: { startFrame: 0, endFrame: 15 }, placement: { anchor: "start", offsetFrames: 0 } },
          { sourceRange: { baseGroupId: base.baseGroupId, startCodePoint: splitAt, endCodePoint: base.endCodePoint },
            window: { startFrame: 240, endFrame: 480 }, placement: { anchor: "start", offsetFrames: 0 } },
        ], userSilences: [] }, actor: "creator",
      });
      await pipeline.confirmNarrationPlanV2(run.id, {
        requestId: `req-${crashPoint}`, expectedRunRevision: run.revision, sourceContextId: initial.sourceContextId!,
        editorSessionId: "recover-session", editSequence: 1, candidateId: preview.candidateId,
        ticketId: preview.ticketId, planSha256: preview.planSha256, acknowledgeQuoteUnavailable: true, actor: "creator",
      });
      run = await pipeline.loadPersisted(run.id);
      run = await pipeline.decide(run.id, { interventionId: run.nodeRuns.find(node => node.nodeId === "assets")!.intervention!.id,
        action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null });
      for (let observation = 0; observation < 200; observation++) {
        const persisted = await pipeline.loadPersisted(run.id);
        if (persisted.status === "failed" && persisted.nodeRuns.find(node => node.nodeId === "voice")?.status === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const failed = await pipeline.loadPersisted(run.id);
      const failedVoice = failed.nodeRuns.find(node => node.nodeId === "voice")!;
      assert.equal(Boolean(failedVoice.outcomeUncertain), crashPoint !== "deterministic_failure");
      const beforeInspect = worker.rebuildCalls;
      if (crashPoint !== "deterministic_failure") {
        const summary = await new ProductionPipeline(pipelineOptions).inspectPaidNode(failed.id, "voice");
        assert.equal(summary.recommendedOutcome, "resume_original");
        assert.equal(worker.rebuildCalls, beforeInspect, "GET 检视只读，不建立来源资格");
      }

      const restarted = new ProductionPipeline(pipelineOptions);
      const recovered = crashPoint === "deterministic_failure"
        ? await restarted.retryFailedNode(failed.id, "voice")
        : await restarted.reconcilePaidNode(failed.id, {
            nodeId: "voice", expectedRunRevision: failed.revision,
            reconciliationId: `recover-${crashPoint}`, outcome: "resume_original",
          });
      const voice = recovered.nodeRuns.find(node => node.nodeId === "voice")!;
      assert.equal(recovered.status, "needs_human", JSON.stringify({
        crashPoint, runStatus: recovered.status, voiceStatus: voice.status, error: voice.error,
      }));
      assert.equal(voice.status, "needs_human");
      assert.equal(worker.synthesisCalls, 1, "归档恢复不再进入普通合成路径");
      assert.equal(worker.rebuildCalls, 1, "宿主只发一次纯本地 rebuild_manifest");
      const receipt = (voice.output as Record<string, unknown>).voiceSourceReceipt as Record<string, unknown>;
      assert.equal(receipt.reason, "layout_incomplete");
      assert.equal((receipt.groupAudioArtifacts as unknown[]).length, 2, "恢复停点可试听本次 manifest 的全部组");
      assert.ok(recovered.artifacts.some(artifact => artifact.kind === "voice_source_manifest"));
      assert.ok(recovered.artifacts.some(artifact => artifact.kind === "voice_source_receipt"));
      assert.ok(!recovered.artifacts.some(artifact => artifact.kind === "voiceover" && voice.artifactIds.includes(artifact.id)),
        "只有来源恢复时不得伪造成功音轨");
      const reread = await new ProductionPipeline(pipelineOptions).loadPersisted(recovered.id);
      assert.equal(reread.nodeRuns.find(node => node.nodeId === "voice")?.status, "needs_human",
        "恢复停点跨宿主重启可读");
    }
  });

  it("relayouts a successful voice locally into a listening stop without repurchase", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-relayout-http-"));
    // 真实 Python worker 产出可排轨的 voiceover_plan 与可解码音频（只替换付费网络边界）。
    class ControlledRelayoutWorker extends ReworkWorker {
      synthesisCalls = 0;
      relayoutCalls = 0;
      renderCalls = 0;
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "video.render") this.renderCalls += 1;
        if (request.capability !== "voice.synthesize") return super.run(request);
        if ((request.input as Record<string, unknown>).relayout === true) this.relayoutCalls += 1;
        else this.synthesisCalls += 1;
        return controlledVoiceWorker(request);
      }
    }
    const worker = new ControlledRelayoutWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 20; step++) {
      const gateNode = run.nodeRuns.find(node => node.status === "needs_human");
      if (gateNode?.nodeId === "final-review") break;
      const gate = gateNode?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      if (gateNode.nodeId === "assets") {
        const preview = await pipeline.previewNarrationPlan(run.id);
        run = await pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: preview.plan, actor: "creator" });
      }
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    assert.equal(run.nodeRuns.find(node => node.nodeId === "final-review")?.status, "needs_human");
    // 后台 resume 可能仍在推进：以持久化状态为准构造请求身份。
    for (let observation = 0; observation < 100; observation++) {
      const persisted = await pipeline.loadPersisted(run.id);
      if (persisted.status === "needs_human" && !persisted.nodeRuns.some(node => node.status === "running")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    run = await pipeline.loadPersisted(run.id);
    // 成片返工只开放GET读取当前编辑事实；POST预览与PUT保存仍只允许配音前。
    const finalReviewService = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const finalReviewApp = buildStudioApp({ service: finalReviewService });
    const finalReviewReadResponse = await finalReviewApp.inject({
      method: "GET", url: `/api/runs/${run.id}/narration-plan`,
    });
    assert.equal(finalReviewReadResponse.statusCode, 200);
    const finalReviewRead = finalReviewReadResponse.json();
    assert.equal(finalReviewRead.editorContext.mode, "final_review");
    const finalReviewPreviewWrite = await finalReviewApp.inject({ method: "POST",
      url: `/api/runs/${run.id}/narration-plan/preview`, payload: {
        expectedRunRevision: run.revision, sourceContextId: finalReviewRead.sourceContextId,
        editorSessionId: "final-review-read-only", editSequence: 0,
        candidate: { version: "video-factory/narration-plan-v2", groups: [], userSilences: [] },
      } });
    assert.equal(finalReviewPreviewWrite.statusCode, 409, "成片返工GET可读不等于可重新签保存票据");
    const finalReviewPutWrite = await finalReviewApp.inject({ method: "PUT",
      url: `/api/runs/${run.id}/narration-plan`, payload: {
        expectedRunRevision: run.revision, plan: finalReviewRead.editorContext.defaultPlan,
      } });
    assert.equal(finalReviewPutWrite.statusCode, 409, "成片返工GET可读不放宽v1保存门禁");
    await finalReviewApp.close();
    const voiceNode = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const version = voiceNode.outputState!.versions.find(v => v.id === voiceNode.outputState!.effectiveVersionId)!;
    const voiceOutput = voiceNode.output as { voiceoverPlanPath: string; trackPath: string };
    const planArtifact = run.artifacts.find(a => version.artifactIds.includes(a.id) && a.uri === voiceOutput.voiceoverPlanPath)!;
    const audioArtifact = run.artifacts.find(a => version.artifactIds.includes(a.id) && a.uri === voiceOutput.trackPath)!;
    const planDoc = JSON.parse(await readFile(planArtifact.uri!, "utf8"));
    const originalPlanBytes = await readFile(planArtifact.uri!);
    const group = planDoc.narrationPlan.groups[0];
    // §4.2.6.1：interventionId 必须对应当前活动停点（本例为成片返工的 final-review 停点）。
    const reworkStop = run.nodeRuns.find(node => node.nodeId === "final-review"
      && node.status === "needs_human")!.intervention!;
    const request = {
      action: "relayout_narration" as const, intent: "apply" as const,
      requestId: "relayout-once", expectedRunRevision: run.revision,
      interventionId: reworkStop.id,
      sourceContextId: "sc-relayout-from-initial-confirmation", note: "把整段配音向后挪一秒",
      // 与 Python 端 _digest_of_plan 同字节：canonicalJsonV2（键排序、紧凑分隔符）。
      source: { kind: "voice_version" as const, voiceVersionId: version.id,
        voicePlanArtifactId: planArtifact.id, voicePlanSha256: planArtifact.sha256!,
        expectedNarrationPlanSha256: createHash("sha256")
          .update(canonicalJsonV2(planDoc.narrationPlan), "utf8").digest("hex"),
        expectedLayoutKey: planDoc.layoutKey, expectedAudioSha256: audioArtifact.sha256!,
        sourceVoiceOperationId: planDoc.voiceOperationId },
      layout: { narrationPlanVersion: "video-factory/narration-plan-v1" as const,
        groups: [{ groupId: group.id, window: group.window, placement: { anchor: "end" as const, offsetFrames: 30 } }],
        userSilences: [] },
      actor: "creator",
    };
    const dispatched = await pipeline.dispatchNarrationRevision(run.id, request);
    run = await dispatched.completion;
    assert.equal(run.status, "needs_human");
    const nextVoice = run.nodeRuns.find(node => node.nodeId === "voice")!;
    assert.equal(nextVoice.status, "needs_human");
    assert.deepEqual(nextVoice.intervention?.options, ["approve", "reject"], "成功回新的声音试听停点");
    assert.match(nextVoice.intervention?.reason ?? "", /未重新购买/);
    let invalidatedCount = 0;
    for (const descendant of ["render", "technical-review", "visual-review", "final-review"]) {
      const node = run.nodeRuns.find(candidate => candidate.nodeId === descendant);
      if (node) {
        assert.equal(node.status, "stale", `${descendant} 必须失效`);
        invalidatedCount += 1;
      }
    }
    assert.ok(invalidatedCount >= 1, "至少使 render 及其后代失效");
    const nextVersion = nextVoice.outputState!.versions.find(v => v.id === nextVoice.outputState!.effectiveVersionId)!;
    assert.equal((nextVersion.output as Record<string, unknown>).appliedRequestId, "relayout-once");
    const nextOutput = nextVoice.output as { voiceoverPlanPath: string };
    const newPlanDoc = JSON.parse(await readFile(nextOutput.voiceoverPlanPath, "utf8"));
    const nextInputVersionId = nextVoice.inputState!.effectiveVersionId;
    const nextInputVersion = nextVoice.inputState!.versions.find(version => version.id === nextInputVersionId)!;
    assert.ok(nextVersion.inputVersionIds.includes(nextInputVersionId),
      "新声音输出版本必须正式绑定本次目标旁白计划的输入版本");
    assert.equal(nextInputVersion.schemaVersion, newPlanDoc.narrationPlan.version,
      "声音输入 schemaVersion 取目标旁白计划版本，而不是沿用声音输出 schema");
    const relayoutOperation = JSON.parse(await readFile(path.join(workspaceRoot, "runs", run.id,
      "nodes", "voice", "relayout-operations", "relayout-once.json"), "utf8"));
    assert.equal(relayoutOperation.reservedInputVersionId, nextInputVersionId);
    assert.equal(relayoutOperation.reservedOutputVersionId, nextVersion.id,
      "采用必须使用受理时预留的真实输出版本 ID");
    assert.equal(relayoutOperation.attempt,
      Number(path.basename(relayoutOperation.attemptDirectory).replace("attempt-", "")),
      "worker attempt 必须等于耐久预留目录的实际编号");
    assert.equal(relayoutOperation.commandId, "relayout-relayout-once");
    assert.equal(relayoutOperation.layoutOperationId, "relayout-relayout-relayout-once");
    const adoption = (nextVersion.output as Record<string, unknown>).relayoutAdoption as Record<string, unknown>;
    assert.equal(adoption.requestId, "relayout-once");
    assert.equal(adoption.requestDigest, relayoutOperation.requestDigest);
    assert.equal(adoption.inputVersionId, nextInputVersionId);
    assert.equal(adoption.voiceVersionId, nextVersion.id);
    assert.equal(adoption.resultingRunRevision, run.revision);
    const relayoutKinds = new Set(nextVersion.artifactIds.map(artifactId =>
      run.artifacts.find(artifact => artifact.id === artifactId)?.kind));
    for (const kind of ["narration_plan", "voiceover_pcm", "voiceover_plan", "voiceover",
      "narration_relayout_completion"]) {
      assert.ok(relayoutKinds.has(kind), `新声音版本缺少 worker 耐久产物 ${kind}`);
    }
    assert.ok(!nextVersion.artifactIds.includes(nextVersion.id),
      "预留输出版本 ID 不能被 artifact 分配误消费");
    assert.equal(newPlanDoc.voiceOperationId, planDoc.voiceOperationId, "voiceOperationId 仍为原 TTS 操作");
    assert.notEqual(newPlanDoc.layoutKey, planDoc.layoutKey);
    assert.equal((nextVersion.output as Record<string, unknown>).externalSendCount, 0,
                 "本地排轨动作零外部发送");
    assert.equal(await readFile(planArtifact.uri!, "utf8").then(b => b === originalPlanBytes.toString()), true, "旧版本留档只读");
    // 同请求重放（响应丢失后原样重发）：返回已采用结果，不新增版本、不再次调用 worker。
    const replayed = await pipeline.dispatchNarrationRevision(run.id, request);
    assert.equal((await replayed.completion).revision, run.revision, "重放不新增版本");
    // 身份错误的时间调整必须在来源解析处拒绝（确定性负例，不与后台 resume 竞态）：
    // 不存在的声音版本不能触发任何本地处理，原有效声音与试听停点保持不变。
    // §4.2.6.1：负例也从当前有效停点（成功调整后的声音试听停点）发起。
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, { ...request,
      requestId: "relayout-stale-version", expectedRunRevision: run.revision,
      interventionId: nextVoice.intervention!.id,
      source: { ...request.source, voiceVersionId: "version-nonexistent-000000" },
      note: "过期身份必须拒绝" }), /已不是当前有效版本/);
    // 同 requestId 异内容必须显式拒绝（不能吞掉后落穿到来源解析）。
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, { ...request,
      requestId: "relayout-once", expectedRunRevision: run.revision,
      note: "同一编号换了内容" }), /已被不同内容使用/);
    const afterReject = await pipeline.loadPersisted(run.id);
    assert.equal(afterReject.nodeRuns.find(node => node.nodeId === "voice")?.outputState?.effectiveVersionId,
      (await pipeline.loadPersisted(run.id)).nodeRuns.find(node => node.nodeId === "voice")?.outputState?.effectiveVersionId,
      "拒绝路径不改变有效声音版本");

    const prefillAfterRelayout = await new StudioService({ workspaceRoot, pipeline,
      commandAvailable: async () => true, environment: {} }).reviewPrefill(run.id, "creator");
    assert.equal(prefillAfterRelayout.basis, null, "新声音采用后旧审片表态不得继续预填");
    const rendersBeforeApproval = worker.renderCalls;
    const synthesesBeforeApproval = worker.synthesisCalls;
    const relayoutsBeforeApproval = worker.relayoutCalls;
    run = await pipeline.decide(run.id, { interventionId: nextVoice.intervention!.id,
      action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null });
    for (let observation = 0; observation < 300; observation += 1) {
      const persisted = await pipeline.loadPersisted(run.id);
      const activeStop = persisted.nodeRuns.find(node => node.status === "needs_human");
      if (worker.renderCalls > rendersBeforeApproval && activeStop?.nodeId !== "voice"
          && !persisted.nodeRuns.some(node => node.status === "running")) {
        run = persisted;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(worker.synthesisCalls, synthesesBeforeApproval,
      "用户批准新声音后不得重新购买或重新合成声音");
    assert.equal(worker.relayoutCalls, relayoutsBeforeApproval,
      "用户批准只放行后代，不重复本地排轨");
    assert.equal(worker.renderCalls, rendersBeforeApproval + 1,
      "新声音试听明确批准后才重新渲染一次");
  });

  it("chains B→C→A′ relayouts with origin manifests, crash windows, durable discard and failure exits (§4.2.5–7)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-relayout-chain-"));
    class ChainedRelayoutWorker extends ReworkWorker {
      paidSynthesisCalls = 0;
      completedRelayouts = 0;
      relayoutAttempts = 0;
      renderCalls = 0;
      failNextRelayout = false;
      blockNextRelayout?: { entered: () => void; release: Promise<void> };
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "video.render") this.renderCalls += 1;
        if (request.capability !== "voice.synthesize") return super.run(request);
        if ((request.input as Record<string, unknown>).relayout === true) {
          this.relayoutAttempts += 1;
          if (this.blockNextRelayout) {
            const gate = this.blockNextRelayout;
            this.blockNextRelayout = undefined;
            gate.entered();
            await gate.release;
          }
          if (this.failNextRelayout) {
            this.failNextRelayout = false;
            return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId),
              status: "rejected", error: { code: "NARRATION_GROUP_DOES_NOT_FIT", message: "segment does not fit" },
              output: { conflict: { code: "NARRATION_GROUP_DOES_NOT_FIT", groupId: "narration-1",
                requiredFrames: 240, availableFrames: 100, sourceScenePositions: [1] } },
              artifacts: [], diagnostics: { externalSendCount: 0 } };
          }
          const response = await controlledVoiceWorker(request);
          this.completedRelayouts += 1;
          return response;
        }
        this.paidSynthesisCalls += 1;
        return controlledVoiceWorker(request);
      }
    }
    const worker = new ChainedRelayoutWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 20; step++) {
      const gateNode = run.nodeRuns.find(node => node.status === "needs_human");
      if (gateNode?.nodeId === "final-review") break;
      const gate = gateNode?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      if (gateNode.nodeId === "assets") {
        const preview = await pipeline.previewNarrationPlan(run.id);
        run = await pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: preview.plan, actor: "creator" });
      }
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    for (let observation = 0; observation < 100; observation++) {
      const persisted = await pipeline.loadPersisted(run.id);
      if (persisted.status === "needs_human" && !persisted.nodeRuns.some(node => node.status === "running")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    run = await pipeline.loadPersisted(run.id);
    const operationsDir = path.join(workspaceRoot, "runs", run.id, "nodes", "voice", "relayout-operations");
    const reworkStop = run.nodeRuns.find(node => node.nodeId === "final-review")!.intervention!;
    const initialVoice = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const initialVersionId = initialVoice.outputState!.effectiveVersionId;
    const initialPlanArtifact = run.artifacts.find(artifact => initialVoice.outputState!.versions
      .find(v => v.id === initialVersionId)!.artifactIds.includes(artifact.id)
      && artifact.kind === "voiceover_plan")!;
    const initialPlanDoc = JSON.parse(await readFile(initialPlanArtifact.uri!, "utf8"));
    const initialGroup = initialPlanDoc.narrationPlan.groups[0];
    const buildApply = async (state: {
      run: typeof run; versionId: string; interventionId: string; requestId: string;
      anchor: "start" | "end"; offset: number;
    }) => {
      const voiceNode = state.run.nodeRuns.find(node => node.nodeId === "voice")!;
      const version = voiceNode.outputState!.versions.find(v => v.id === state.versionId)!;
      const planArtifact = state.run.artifacts.find(artifact => version.artifactIds.includes(artifact.id)
        && artifact.kind === "voiceover_plan")!;
      const audioArtifact = state.run.artifacts.find(artifact => version.artifactIds.includes(artifact.id)
        && artifact.kind === "voiceover")!;
      const planDoc = JSON.parse(await readFile(planArtifact.uri!, "utf8"));
      const group = planDoc.narrationPlan.groups[0];
      return {
        action: "relayout_narration" as const, intent: "apply" as const,
        requestId: state.requestId, expectedRunRevision: state.run.revision,
        interventionId: state.interventionId,
        sourceContextId: "sc-relayout-chain", note: "调整时间",
        source: { kind: "voice_version" as const, voiceVersionId: state.versionId,
          voicePlanArtifactId: planArtifact.id, voicePlanSha256: planArtifact.sha256!,
          expectedNarrationPlanSha256: createHash("sha256")
            .update(canonicalJsonV2(planDoc.narrationPlan), "utf8").digest("hex"),
          expectedLayoutKey: planDoc.layoutKey, expectedAudioSha256: audioArtifact.sha256!,
          sourceVoiceOperationId: planDoc.voiceOperationId },
        layout: { narrationPlanVersion: "video-factory/narration-plan-v1" as const,
          groups: [{ groupId: group.id, window: group.window,
            placement: { anchor: state.anchor, offsetFrames: state.offset } }],
          userSilences: [] },
        actor: "creator",
      };
    };
    const listeningStopOf = (current: typeof run) => current.nodeRuns
      .find(node => node.nodeId === "voice")!.intervention!;

    // ── B：第一次调整（从成片返工停点）──
    const requestB = await buildApply({ run, versionId: initialVersionId, interventionId: reworkStop.id,
      requestId: "chain-b", anchor: "end", offset: 30 });
    run = await (await pipeline.dispatchNarrationRevision(run.id, requestB)).completion;
    let voiceNow = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const versionB = voiceNow.outputState!.effectiveVersionId;
    assert.notEqual(versionB, initialVersionId);
    const planB = JSON.parse(await readFile((voiceNow.output as { voiceoverPlanPath: string }).voiceoverPlanPath, "utf8"));
    assert.ok(planB.originManifest, "relayout 输出携带 origin manifest 显式引用（§4.2.5）");
    assert.equal(planB.layoutOperationId, "relayout-relayout-chain-b", "layoutOperationId 取本次排轨操作身份");
    assert.equal(worker.paidSynthesisCalls, 1, "B 零重购");
    assert.equal(worker.completedRelayouts, 1);

    // ── C：第二次调整（从 B 的试听停点，经 origin manifest 解析来源）──
    const requestC = await buildApply({ run, versionId: versionB, interventionId: listeningStopOf(run).id,
      requestId: "chain-c", anchor: "start", offset: 60 });
    run = await (await pipeline.dispatchNarrationRevision(run.id, requestC)).completion;
    voiceNow = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const versionC = voiceNow.outputState!.effectiveVersionId;
    assert.notEqual(versionC, versionB);
    const inputC = voiceNow.inputState!;
    assert.notEqual(inputC.effectiveVersionId, inputC.versions.at(-2)!.id, "C 登记新的声音输入版本");
    assert.equal((voiceNow.output as Record<string, unknown>).voiceInputVersionId, inputC.effectiveVersionId,
      "成功 output 绑定新输入版本（§4.2.5）");
    assert.equal(worker.paidSynthesisCalls, 1, "C 仍零重购");
    assert.equal(worker.completedRelayouts, 2);

    // ── A′：回到 A 形态 ──
    const requestA2 = await buildApply({ run, versionId: versionC, interventionId: listeningStopOf(run).id,
      requestId: "chain-a2", anchor: "start", offset: 0 });
    run = await (await pipeline.dispatchNarrationRevision(run.id, requestA2)).completion;
    voiceNow = run.nodeRuns.find(node => node.nodeId === "voice")!;
    const versionA2 = voiceNow.outputState!.effectiveVersionId;
    const planA2 = JSON.parse(await readFile((voiceNow.output as { voiceoverPlanPath: string }).voiceoverPlanPath, "utf8"));
    assert.deepEqual(planA2.narrationPlan.groups[0].placement, initialGroup.placement, "A′ 回到 A 形态");
    assert.equal(planA2.voiceOperationId, initialPlanDoc.voiceOperationId, "原 TTS 操作身份贯穿 B/C/A′");
    assert.equal(worker.paidSynthesisCalls, 1, "B/C/A′ 外部发送增量 0");

    // 同一 requestId 的历史重放必须覆盖完整请求身份；单独改任一语义
    // 字段都不得借已采用记录绕过摘要校验。
    const changedRequestB = [
      { ...requestB, sourceContextId: "sc-relayout-chain-tampered" },
      { ...requestB, interventionId: "intervention-tampered" },
      { ...requestB, actor: "another-creator" },
      { ...requestB, note: "不同的调整说明" },
      { ...requestB, layout: { ...requestB.layout, groups: requestB.layout.groups.map((group, index) =>
        index === 0 ? { ...group, placement: { ...group.placement, offsetFrames: group.placement.offsetFrames + 1 } }
          : group) } },
    ];
    for (const changed of changedRequestB) {
      await assert.rejects(
        pipeline.dispatchNarrationRevision(run.id, changed),
        /同一时间调整请求身份已被不同内容使用/,
      );
    }

    // 解析后 DTO 语义相同时，JSON 对象键顺序不参与身份。
    const reorderedRequestB = {
      actor: requestB.actor, note: requestB.note, sourceContextId: requestB.sourceContextId,
      interventionId: requestB.interventionId, expectedRunRevision: requestB.expectedRunRevision,
      requestId: requestB.requestId, intent: requestB.intent, action: requestB.action,
      layout: { userSilences: requestB.layout.userSilences.map((silence) => ({
        endFrame: silence.endFrame, startFrame: silence.startFrame,
      })), groups: requestB.layout.groups.map((group) => ({
        placement: { offsetFrames: group.placement.offsetFrames, anchor: group.placement.anchor },
        window: { endFrame: group.window.endFrame, startFrame: group.window.startFrame },
        groupId: group.groupId,
      })), narrationPlanVersion: requestB.layout.narrationPlanVersion },
      source: requestB.source.kind === "voice_version" ? {
        sourceVoiceOperationId: requestB.source.sourceVoiceOperationId,
        expectedAudioSha256: requestB.source.expectedAudioSha256,
        expectedLayoutKey: requestB.source.expectedLayoutKey,
        expectedNarrationPlanSha256: requestB.source.expectedNarrationPlanSha256,
        voicePlanSha256: requestB.source.voicePlanSha256,
        voicePlanArtifactId: requestB.source.voicePlanArtifactId,
        voiceVersionId: requestB.source.voiceVersionId,
        kind: requestB.source.kind,
      } : requestB.source,
    };
    const relayoutsBeforeReorderedReplay = worker.completedRelayouts;
    const versionBeforeReorderedReplay = run.nodeRuns.find(node => node.nodeId === "voice")!
      .outputState!.effectiveVersionId;
    const reorderedReplay = await (await pipeline.dispatchNarrationRevision(run.id, reorderedRequestB)).completion;
    assert.equal(worker.completedRelayouts, relayoutsBeforeReorderedReplay, "键序改变不重复启动 worker");
    assert.equal(reorderedReplay.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      versionBeforeReorderedReplay, "键序改变不制造新版本");

    // ── 旧请求重放：返回历史结果且 isCurrent=false，不回滚当前版本 ──
    const replayed = await pipeline.dispatchNarrationRevision(run.id, requestB);
    run = await replayed.completion;
    assert.equal(run.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId, versionA2,
      "重放 B 不回滚当前版本");
    const queryB = await pipeline.readNarrationRelayoutOperation(run.id, "chain-b");
    assert.equal(queryB.state, "applied");
    assert.equal(queryB.isCurrent, false, "B 的历史结果不再当前");
    const queryA2 = await pipeline.readNarrationRelayoutOperation(run.id, "chain-a2");
    assert.equal(queryA2.isCurrent, true);

    // ── W1–W3：每个故障点都结束真实父进程，再由新的 Pipeline/worker 进程读取同一 workspace。
    // 不改 run.json、不回滚快照、不手写成功 operation；worker 调用只认跨进程追加计数。
    const crashDirectory = path.join(workspaceRoot, "relayout-crash-harness");
    const crashCountPath = path.join(crashDirectory, "worker-count.jsonl");
    const crashEventPath = path.join(crashDirectory, "crash-events.jsonl");
    await mkdir(crashDirectory, { recursive: true });

    // ── W1：reservation 耐久、worker 未启→GET 只读→原 ID 显式继续，总 worker 0→1 ──
    const preWindow1 = await pipeline.loadPersisted(run.id);
    const requestW1 = await buildApply({ run: preWindow1, versionId: versionA2,
      interventionId: listeningStopOf(preWindow1).id, requestId: "chain-w1", anchor: "end", offset: 15 });
    const requestW1Path = path.join(crashDirectory, "w1-request.json");
    await writeFile(requestW1Path, `${JSON.stringify(requestW1)}\n`);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW1.requestId,
      action: "apply", requestPath: requestW1Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w1-crash", crashPoint: "afterReservation", expectedExit: 81 });
    assert.equal(await jsonLineCount(crashCountPath), 0, "W1 故障点位于真实 worker 调用之前");
    const reservedDoc = JSON.parse(await readFile(path.join(operationsDir, "chain-w1.json"), "utf8"));
    assert.equal(reservedDoc.state, "reserved", "崩溃后预留记录耐久存在");
    const queriedW1 = await runRelayoutCrashChild({ workspaceRoot, runId: run.id,
      requestId: requestW1.requestId, action: "query", countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "w1-query" });
    assert.equal((queriedW1!.operation as { state: string }).state, "reserved");
    assert.equal(await jsonLineCount(crashCountPath), 0, "GET 不启动 worker");
    await new Promise(resolve => setTimeout(resolve, 2_800));
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW1.requestId,
      action: "apply", requestPath: requestW1Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w1-resume" });
    assert.equal(await jsonLineCount(crashCountPath), 1, "W1 显式继续恰好执行一次本地 worker");
    const resumed1 = await pipeline.loadPersisted(run.id);
    const resumedDoc1 = JSON.parse(await readFile(path.join(operationsDir, "chain-w1.json"), "utf8"));
    for (const field of ["attempt", "attemptDirectory", "reservedInputVersionId", "reservedOutputVersionId",
      "workerExecutionToken"] as const) {
      assert.equal(resumedDoc1[field], reservedDoc[field], `W1 恢复沿用原预留 ${field}`);
    }

    // ── W2：worker 产物+完成收据+completed 投影耐久、run 未采用→只登记，总 worker 1→2→2 ──
    const preWindow2Run = await pipeline.loadPersisted(run.id);
    const requestW2 = await buildApply({ run: preWindow2Run, versionId: resumed1.nodeRuns
      .find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      interventionId: listeningStopOf(resumed1).id, requestId: "chain-w2", anchor: "end", offset: 45 });
    const requestW2Path = path.join(crashDirectory, "w2-request.json");
    await writeFile(requestW2Path, `${JSON.stringify(requestW2)}\n`);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW2.requestId,
      action: "apply", requestPath: requestW2Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w2-crash", crashPoint: "afterWorkerCompletion", expectedExit: 82 });
    assert.equal(await jsonLineCount(crashCountPath), 2, "W2 worker 只执行一次");
    const w2OperationPath = path.join(operationsDir, "chain-w2.json");
    const w2Doc = JSON.parse(await readFile(w2OperationPath, "utf8"));
    assert.equal(w2Doc.state, "completed");
    const queriedW2 = await runRelayoutCrashChild({ workspaceRoot, runId: run.id,
      requestId: requestW2.requestId, action: "query", countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "w2-query" });
    assert.equal((queriedW2!.operation as { state: string }).state, "completed");
    await new Promise(resolve => setTimeout(resolve, 2_800));
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW2.requestId,
      action: "apply", requestPath: requestW2Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w2-resume" });
    assert.equal(await jsonLineCount(crashCountPath), 2, "W2 恢复只核验登记，不重复 worker");
    const resumed2 = await pipeline.loadPersisted(run.id);
    const voiceAfterW2 = resumed2.nodeRuns.find(node => node.nodeId === "voice")!;
    assert.equal(voiceAfterW2.status, "needs_human", "恢复采用后回到声音试听停点");

    // ── W3：run 已采用、sidecar/HTTP 未完成→重放返原版；再采用 B 后重放 A 为历史 ──
    const w3Current = await pipeline.loadPersisted(run.id);
    const requestW3 = await buildApply({ run: w3Current,
      versionId: w3Current.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      interventionId: listeningStopOf(w3Current).id, requestId: "chain-w3", anchor: "start", offset: 15 });
    const requestW3Path = path.join(crashDirectory, "w3-request.json");
    await writeFile(requestW3Path, `${JSON.stringify(requestW3)}\n`);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW3.requestId,
      action: "apply", requestPath: requestW3Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w3-crash", crashPoint: "afterAdoptionCheckpoint", expectedExit: 83 });
    assert.equal(await jsonLineCount(crashCountPath), 3, "W3 worker 只执行一次");
    const queriedW3 = await runRelayoutCrashChild({ workspaceRoot, runId: run.id,
      requestId: requestW3.requestId, action: "query", countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "w3-query" });
    assert.equal((queriedW3!.operation as { state: string }).state, "applied",
      "GET 以正式 run 采用投影 applied");
    await new Promise(resolve => setTimeout(resolve, 2_800));
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW3.requestId,
      action: "apply", requestPath: requestW3Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w3-replay" });
    assert.equal(await jsonLineCount(crashCountPath), 3, "W3 原 ID 重放不重复 worker");
    const afterW3 = await pipeline.loadPersisted(run.id);
    const requestAfterW3 = await buildApply({ run: afterW3,
      versionId: afterW3.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      interventionId: listeningStopOf(afterW3).id, requestId: "chain-after-w3", anchor: "end", offset: 15 });
    const requestAfterW3Path = path.join(crashDirectory, "after-w3-request.json");
    await writeFile(requestAfterW3Path, `${JSON.stringify(requestAfterW3)}\n`);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestAfterW3.requestId,
      action: "apply", requestPath: requestAfterW3Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "after-w3-apply" });
    assert.equal(await jsonLineCount(crashCountPath), 4);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: requestW3.requestId,
      action: "apply", requestPath: requestW3Path, countPath: crashCountPath, eventPath: crashEventPath,
      caseDirectory: crashDirectory, label: "w3-historical-replay" });
    assert.equal(await jsonLineCount(crashCountPath), 4, "历史 W3 重放不回滚也不重复 worker");
    const historicalW3 = await runRelayoutCrashChild({ workspaceRoot, runId: run.id,
      requestId: requestW3.requestId, action: "query", countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "w3-historical-query" });
    assert.equal((historicalW3!.operation as { isCurrent: boolean }).isCurrent, false);
    const resumed3 = await pipeline.loadPersisted(run.id);
    const currentVersionW3 = resumed3.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId;

    // ── 失败保留原停点（§4.2.7 最小失败设计）──
    const preFailure = await pipeline.loadPersisted(run.id);
    const revisionBeforeFailure = preFailure.revision;
    const stopBeforeFailure = listeningStopOf(preFailure);
    worker.failNextRelayout = true;
    const requestFail = await buildApply({ run: preFailure, versionId: currentVersionW3,
      interventionId: stopBeforeFailure.id, requestId: "chain-fail", anchor: "end", offset: 30 });
    await assert.rejects(pipeline.dispatchNarrationRevision(preFailure.id, requestFail), /时间调整没有完成/);
    const afterFailure = await pipeline.loadPersisted(run.id);
    assert.equal(afterFailure.revision, revisionBeforeFailure, "失败不改 run 版本");
    assert.equal(afterFailure.nodeRuns.find(node => node.nodeId === "voice")!.intervention?.id,
      stopBeforeFailure.id, "失败保留原活动停点，不新增停点盖住旧入口");
    const failedQuery = await pipeline.readNarrationRelayoutOperation(run.id, "chain-fail");
    assert.equal(failedQuery.state, "failed");
    assert.match(failedQuery.failureReason ?? "", /仍需要/);
    const attemptsBeforeFailedReplay = worker.relayoutAttempts;
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, requestFail), /已明确失败.*不会自动重跑/,
      "确定性 fit 失败不得沿原 ID 自动重跑");
    assert.equal(worker.relayoutAttempts, attemptsBeforeFailedReplay);

    // ── discard 耐久记录：撤销未采用意图后原路可继续，同 discard 重放返回原结果 ──
    const preDiscard = await pipeline.loadPersisted(run.id);
    const requestDiscard = { action: "relayout_narration" as const, intent: "discard_unapplied" as const,
      requestId: "chain-discard", expectedRunRevision: preDiscard.revision,
      interventionId: listeningStopOf(preDiscard).id, targetRequestId: "chain-fail",
      note: "撤销失败的调整", sourceContextId: "sc-relayout-chain", actor: "creator" };
    await (await pipeline.dispatchNarrationRevision(run.id, requestDiscard)).completion;
    const discardedQuery = await pipeline.readNarrationRelayoutOperation(run.id, "chain-fail");
    assert.equal(discardedQuery.state, "discarded", "discard 留耐久记录而不是删除文件");
    const discardDoc = JSON.parse(await readFile(path.join(operationsDir, "chain-fail.json"), "utf8"));
    assert.ok(discardDoc.discardedAt, "记录撤销事实与时间");
    const discardRequestDoc = JSON.parse(await readFile(path.join(operationsDir, "chain-discard.json"), "utf8"));
    assert.equal(discardRequestDoc.state, "discarded", "discard 自身有独立耐久请求记录");
    assert.equal(discardRequestDoc.targetRequestId, "chain-fail");
    assert.equal(discardRequestDoc.result?.targetState, "discarded");
    const discardAgain = await (await pipeline.dispatchNarrationRevision(run.id,
      { ...requestDiscard, expectedRunRevision: (await pipeline.loadPersisted(run.id)).revision })).completion;
    assert.ok(discardAgain.revision >= 0, "同 discard 再来返回原结果通道");
    for (const changedDiscard of [
      { ...requestDiscard, targetRequestId: "chain-w1" },
      { ...requestDiscard, interventionId: "intervention-tampered" },
      { ...requestDiscard, note: "改过的撤销说明" },
    ]) {
      await assert.rejects(pipeline.dispatchNarrationRevision(run.id, changedDiscard),
        /同一时间调整请求身份已被不同内容使用/);
    }
    const relayoutsBeforeDiscardedReplay = worker.completedRelayouts;
    await (await pipeline.dispatchNarrationRevision(run.id, requestFail)).completion;
    assert.equal((await pipeline.readNarrationRelayoutOperation(run.id, "chain-fail")).state, "discarded",
      "已撤销 apply 是终态，原 ID 重放不得复活");
    assert.equal(worker.completedRelayouts, relayoutsBeforeDiscardedReplay, "已撤销 apply 不再启动 worker");
    // 撤销后必须能直接批准原有效声音继续，不能要求用户再跑一次成功排轨才能离开。
    let afterDiscardRun = await pipeline.loadPersisted(run.id);
    const paidBeforeOldApproval = worker.paidSynthesisCalls;
    const relayoutBeforeOldApproval = worker.relayoutAttempts;
    const renderBeforeOldApproval = worker.renderCalls;
    afterDiscardRun = await pipeline.decide(run.id, { interventionId: listeningStopOf(afterDiscardRun).id,
      action: "approve", actor: "creator", expectedRunRevision: afterDiscardRun.revision, reviewEvidenceId: null });
    for (let step = 0; step < 10; step += 1) {
      let stop: (typeof afterDiscardRun.nodeRuns)[number] | undefined;
      for (let observation = 0; observation < 300; observation += 1) {
        const persisted = await pipeline.loadPersisted(run.id);
        const candidate = persisted.nodeRuns.find(node => node.status === "needs_human");
        if (candidate?.nodeId !== "voice" && !persisted.nodeRuns.some(node => node.status === "running")) {
          afterDiscardRun = persisted;
          stop = candidate;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(stop, "批准原声音后应推进到下一个用户确认点");
      if (stop.nodeId === "final-review") break;
      afterDiscardRun = await pipeline.decide(run.id, { interventionId: stop.intervention!.id,
        action: "approve", actor: "creator", expectedRunRevision: afterDiscardRun.revision,
        reviewEvidenceId: stop.intervention?.evidenceId ?? null });
    }
    assert.equal(afterDiscardRun.nodeRuns.find(node => node.nodeId === "final-review")?.status, "needs_human",
      "撤销失败调整后直接批准原有效声音可继续到成片审片");
    assert.equal(worker.paidSynthesisCalls, paidBeforeOldApproval, "批准原声音不重新购买");
    assert.equal(worker.relayoutAttempts, relayoutBeforeOldApproval, "批准原声音不要求再次排轨");
    assert.equal(worker.renderCalls, renderBeforeOldApproval + 1, "批准原声音后只重新渲染一次");

    // 后续并发/活跃worker验证仍从新的成片返工动作进入，不把“直接批准旧版”偷换成成功排轨。
    const finalReviewAfterDiscard = afterDiscardRun.nodeRuns.find(node => node.nodeId === "final-review")!.intervention!;
    const requestAfterDiscard = await buildApply({ run: afterDiscardRun,
      versionId: afterDiscardRun.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      interventionId: finalReviewAfterDiscard.id, requestId: "chain-after-discard",
      anchor: "start", offset: 0 });
    run = await (await pipeline.dispatchNarrationRevision(run.id, requestAfterDiscard)).completion;
    assert.equal(run.nodeRuns.find(node => node.nodeId === "voice")!.status, "needs_human", "撤销后原路可继续");
    assert.equal(worker.paidSynthesisCalls, 1, "全链仅最初一次付费合成");

    // ── 活跃 worker / 并发：租约持有期间 GET 只读，同 ID apply、discard 与另一
    // 同 revision 请求均不得启动第二个 worker 或假称已撤销。
    const beforeActive = await pipeline.loadPersisted(run.id);
    const activeVersionId = beforeActive.nodeRuns.find(node => node.nodeId === "voice")!
      .outputState!.effectiveVersionId;
    const activeRequest = await buildApply({ run: beforeActive, versionId: activeVersionId,
      interventionId: listeningStopOf(beforeActive).id, requestId: "chain-active", anchor: "end", offset: 15 });
    let signalEntered!: () => void;
    let releaseWorker!: () => void;
    const workerEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const workerRelease = new Promise<void>((resolve) => { releaseWorker = resolve; });
    worker.blockNextRelayout = { entered: signalEntered, release: workerRelease };
    const attemptsBeforeActive = worker.relayoutAttempts;
    const activeDispatchPromise = pipeline.dispatchNarrationRevision(run.id, activeRequest);
    await workerEntered;
    assert.equal((await pipeline.readNarrationRelayoutOperation(run.id, "chain-active")).state, "reserved",
      "GET 只读查询活跃请求，不启动 worker");
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, activeRequest), /locked by another writer/,
      "同 ID 在途 apply 不并发");
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, {
      action: "relayout_narration", intent: "discard_unapplied", requestId: "chain-active-discard",
      expectedRunRevision: beforeActive.revision, interventionId: listeningStopOf(beforeActive).id,
      targetRequestId: "chain-active", note: "不能假取消活跃 worker", actor: "creator",
    }), /locked by another writer/, "活跃 worker 不能被假取消");
    await assert.rejects(pipeline.dispatchNarrationRevision(run.id, { ...activeRequest,
      requestId: "chain-active-competing" }), /locked by another writer/,
    "不同 ID 使用同 revision 时只能有一条被受理");
    assert.equal(worker.relayoutAttempts, attemptsBeforeActive + 1, "闸门内只有一个 worker");
    releaseWorker();
    const activeDispatch = await activeDispatchPromise;
    run = await activeDispatch.completion;
    assert.equal(worker.relayoutAttempts, attemptsBeforeActive + 1, "原 worker 完成后仍无重复执行");

    // ── 父进程死亡、detached Python worker 仍活跃：attempt 标记由 worker 自己持有。
    // 新父进程可 GET，但同 ID apply、discard 和另一 ID 都不能重复执行或假取消；
    // worker 完成后只凭其耐久完成收据沿原 ID 采用，宿主 worker 计数不增加。
    const beforeDetached = await pipeline.loadPersisted(run.id);
    const detachedRequest = await buildApply({ run: beforeDetached,
      versionId: beforeDetached.nodeRuns.find(node => node.nodeId === "voice")!.outputState!.effectiveVersionId,
      interventionId: listeningStopOf(beforeDetached).id, requestId: "chain-detached-active",
      anchor: "start", offset: 15 });
    const detachedRequestPath = path.join(crashDirectory, "detached-request.json");
    const detachedEnteredPath = path.join(crashDirectory, "detached-worker-entered.json");
    const detachedReleasePath = path.join(crashDirectory, "detached-worker-release");
    await writeFile(detachedRequestPath, `${JSON.stringify(detachedRequest)}\n`);
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: detachedRequest.requestId,
      action: "apply", requestPath: detachedRequestPath, countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-parent-killed",
      holdEnteredPath: detachedEnteredPath, holdReleasePath: detachedReleasePath,
      killAfterPath: detachedEnteredPath, expectedSignal: "SIGKILL" });
    assert.equal(await jsonLineCount(crashCountPath), 5, "父进程死亡前仅受理一个 detached worker");
    const detachedOperationPath = path.join(operationsDir, `${detachedRequest.requestId}.json`);
    const detachedOperation = JSON.parse(await readFile(detachedOperationPath, "utf8"));
    const detachedMarkerPath = path.join(detachedOperation.attemptDirectory,
      ".narration-relayout-worker-active.json");
    assert.equal(JSON.parse(await readFile(detachedMarkerPath, "utf8")).workerExecutionToken,
      detachedOperation.workerExecutionToken);
    const detachedQuery = await runRelayoutCrashChild({ workspaceRoot, runId: run.id,
      requestId: detachedRequest.requestId, action: "query", countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-query" });
    assert.equal((detachedQuery!.operation as { state: string }).state, "reserved");
    await new Promise(resolve => setTimeout(resolve, 2_800));
    try {
      await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: detachedRequest.requestId,
        action: "apply", requestPath: detachedRequestPath, countPath: crashCountPath,
        eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-duplicate-apply",
        expectedExit: 1, expectedStderr: /仍在本地处理中/ });
      const detachedDiscard = {
        action: "relayout_narration", intent: "discard_unapplied", requestId: "chain-detached-discard",
        expectedRunRevision: beforeDetached.revision, interventionId: listeningStopOf(beforeDetached).id,
        targetRequestId: detachedRequest.requestId, note: "活跃 worker 不得假取消", actor: "creator",
      };
      const detachedDiscardPath = path.join(crashDirectory, "detached-discard.json");
      await writeFile(detachedDiscardPath, `${JSON.stringify(detachedDiscard)}\n`);
      await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: detachedDiscard.requestId,
        action: "apply", requestPath: detachedDiscardPath, countPath: crashCountPath,
        eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-discard-rejected",
        expectedExit: 1, expectedStderr: /仍在本地处理中/ });
      const detachedCompeting = { ...detachedRequest, requestId: "chain-detached-competing" };
      const detachedCompetingPath = path.join(crashDirectory, "detached-competing.json");
      await writeFile(detachedCompetingPath, `${JSON.stringify(detachedCompeting)}\n`);
      await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: detachedCompeting.requestId,
        action: "apply", requestPath: detachedCompetingPath, countPath: crashCountPath,
        eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-competing-rejected",
        expectedExit: 1, expectedStderr: /已有一条尚未采用|仍在本地处理中/ });
      assert.equal(await jsonLineCount(crashCountPath), 5, "活跃 detached worker 期间没有第二次 worker 调用");
    } finally {
      await writeFile(detachedReleasePath, "release\n");
    }
    for (let observation = 0; observation < 500; observation += 1) {
      try {
        await readFile(detachedMarkerPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await assert.rejects(readFile(detachedMarkerPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await runRelayoutCrashChild({ workspaceRoot, runId: run.id, requestId: detachedRequest.requestId,
      action: "apply", requestPath: detachedRequestPath, countPath: crashCountPath,
      eventPath: crashEventPath, caseDirectory: crashDirectory, label: "detached-completion-recovery" });
    assert.equal(await jsonLineCount(crashCountPath), 5,
      "父进程丢失 stdout 后从 worker 完成收据采用，不重新启动 worker");
    run = await pipeline.loadPersisted(run.id);
    assert.equal(run.nodeRuns.find(node => node.nodeId === "voice")!.status, "needs_human");
  });

  it("serves v2 candidate preview and ticket-bound save through the real HTTP facade", async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-v2-http-"));
    class NarrationForecastWorker extends ReworkWorker {
      forecastUnavailable = false;
      override async forecastPaidVoiceSpend(request: Record<string, unknown>) {
        if (this.forecastUnavailable) throw new Error("controlled forecast unavailable");
        const plan = (request.input as Record<string, unknown>).narrationPlan as { groups: Array<{ id: string }> };
        const price = 0.02 * plan.groups.length;
        return { estimatedCostCny: price, maxCostCny: price, unitPriceCny: "2.00", source: "configured_rate" as const,
          items: plan.groups.map((group) => ({ groupId: group.id, estimatedUnits: 34, maxCostCny: price, reused: false })) };
      }
    }
    const worker = new NarrationForecastWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate);
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const nativeFetch = globalThis.fetch;
      // 只把浏览器相对地址接到本地服务器；请求头、序列化与响应读取均走正式客户端。
      t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        nativeFetch(typeof input === "string" ? new URL(input, origin) : input, init));
      const initial = await studioApi.narrationPlan(run.id);
      assert.ok(initial.sourceContextId, "GET 预览经 HTTP 下发 sourceContextId");
      assert.equal(initial.editorContext.mode, "pre_generation");
      assert.equal(initial.editorContext.savedPlanStatus, "none");
      assert.ok(initial.editorContext.baseGroups.length > 0);
      const sourceContextId = initial.sourceContextId!;
      const preview = await studioApi.narrationPlanPreviewV2(run.id, {
        expectedRunRevision: run.revision, sourceContextId,
        editorSessionId: "http-editor-session", editSequence: 0,
        candidate: { version: "video-factory/narration-plan-v2", groups: [], userSilences: [] },
      });
      assert.equal(preview.quote.status, "estimated");
      assert.ok(preview.ticketId.startsWith("npt-"));
      const saved = await studioApi.confirmNarrationPlanV2(run.id, {
        requestId: "http-save-v2", expectedRunRevision: run.revision, sourceContextId,
        editorSessionId: "http-editor-session", editSequence: 0, candidateId: preview.candidateId,
        ticketId: preview.ticketId, planSha256: preview.planSha256 });
      assert.equal(saved.receipt.accepted, true);
      assert.equal(saved.run.status, "needs_human", "保存只写声音输入，素材停点等待不变");
      worker.forecastUnavailable = true;
      const savedRead = await studioApi.narrationPlan(run.id);
      assert.equal(savedRead.editorContext.savedPlanStatus, "current");
      assert.equal(savedRead.plan.version, "video-factory/narration-plan-v2");
      assert.equal(savedRead.quote, undefined, "核价不可用只省略价格，不把计划与编辑事实变成500");
      const cancelled = await studioApi.confirmNarrationPlan(run.id, {
        expectedRunRevision: saved.run.revision, plan: savedRead.editorContext.defaultPlan,
      });
      assert.equal(cancelled.status, "needs_human");
      const cancelledRead = await studioApi.narrationPlan(run.id);
      assert.equal(cancelledRead.plan.version, "video-factory/narration-plan-v1");
      assert.equal(cancelledRead.editorContext.savedPlanStatus, "current");
      // 缺字段的候选请求必须被输入校验拒绝，而不是落进管线。
      await assert.rejects(studioApi.narrationPlanPreviewV2(run.id, {
        expectedRunRevision: cancelled.revision, sourceContextId, editorSessionId: "http-editor-session",
        editSequence: 1, candidate: {} as never }), /候选|方案|来源/);
    } finally {
      await app.close();
    }
  });

  it("formal save→GET round trip keeps byte-exact v2 artifacts and feeds the actual plan to the formal voice.quote (§4.2.2)", async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-v2-roundtrip-"));
    // 正式核价走真实 Python voice.quote；只计数付费合成，保存/读取/核价期间必须为 0。
    const forecastInputs: Array<Record<string, unknown>> = [];
    let voiceCalls = 0;
    class FormalQuoteWorker extends ReworkWorker {
      override async forecastPaidVoiceSpend(request: Record<string, unknown>) {
        forecastInputs.push(structuredClone(request));
        const response = await formalPythonVoiceQuote({
          protocolVersion: "video-factory/worker-v1", commandId: "voice-quote-only",
          runId: String(request.runId), nodeRunId: "voice", attempt: 1, capability: "voice.quote",
          outputDir: path.join(String(request.nodeDirectory), ".quote-preview"),
          input: request.input, parameters: request.parameters });
        if (response.status !== "succeeded" || !response.output) {
          throw new Error(`formal voice.quote failed: ${JSON.stringify(response.error)}`);
        }
        return response.output as unknown as Record<string, unknown>;
      }
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "voice.synthesize") voiceCalls++;
        return super.run(request);
      }
    }
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new FormalQuoteWorker(),
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] },
        // 同镜两段：第 1 镜正文内部含句末标点，存在合法句界（"同镜第一句。" 后）。
        { narrations: ["同镜第一句。同镜第二句。"] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    const brief = jointReworkBrief();
    let run = await pipeline.start({ ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
      workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" },
    });
    for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
      const gate = run.nodeRuns.find(node => node.status === "needs_human")?.intervention;
      assert.ok(gate, JSON.stringify({ status: run.status, failure: run.failure }));
      run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
        : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator",
          expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const nativeFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        nativeFetch(typeof input === "string" ? new URL(input, origin) : input, init));
      const initial = await studioApi.narrationPlan(run.id);
      const sourceContextId = initial.sourceContextId!;
      assert.ok(sourceContextId, "GET 预览经 HTTP 下发 sourceContextId");

      // 同镜两段候选：先做空候选预览取基础有词区身份，再在第 1 镜正文内部句界（码点 6）切分。
      const empty = await studioApi.narrationPlanPreviewV2(run.id, {
        expectedRunRevision: run.revision, sourceContextId,
        editorSessionId: "roundtrip-session", editSequence: 0,
        candidate: { version: "video-factory/narration-plan-v2", groups: [], userSilences: [] },
      });
      const baseGroupId = empty.plan.groups[0]!.sourceRange.baseGroupId;
      const preview = await studioApi.narrationPlanPreviewV2(run.id, {
        expectedRunRevision: run.revision, sourceContextId,
        editorSessionId: "roundtrip-session", editSequence: 1,
        candidate: { version: "video-factory/narration-plan-v2", groups: [
          { sourceRange: { baseGroupId, startCodePoint: 0, endCodePoint: 6 },
            window: { startFrame: 0, endFrame: 240 }, placement: { anchor: "start", offsetFrames: 0 } },
          { sourceRange: { baseGroupId, startCodePoint: 6, endCodePoint: 28 },
            window: { startFrame: 240, endFrame: 720 }, placement: { anchor: "start", offsetFrames: 0 } },
        ], userSilences: [] },
      });
      assert.equal(preview.plan.groups.length, 2);
      assert.deepEqual(preview.plan.groups.map((group) => group.sourceScenePositions), [[1], [1, 2, 3]],
        "同镜两段：第一段与第二段都覆盖镜头 1 的文字");
      assert.equal(preview.quote.status, "estimated", "正式 Python voice.quote 可得报价");
      assert.equal(preview.quote.unitPriceCny, "2.00", "正式报价使用真实单价表（speech-2.8-turbo）");
      assert.equal(preview.quote.items?.length, 2, "同镜两段候选按正式逐组计价报两组");

      const saved = await studioApi.confirmNarrationPlanV2(run.id, {
        requestId: "roundtrip-save", expectedRunRevision: run.revision, sourceContextId,
        editorSessionId: "roundtrip-session", editSequence: 1, candidateId: preview.candidateId,
        ticketId: preview.ticketId, planSha256: preview.planSha256 });
      assert.equal(saved.receipt.accepted, true);
      assert.equal(voiceCalls, 0, "保存不触发 TTS");

      // 字节口径：落盘文件字节 SHA 必须等于票据/收据/产物记录的 planSha256（无 pretty、无换行）。
      const persisted = await pipeline.loadPersisted(run.id);
      const voiceNode = persisted.nodeRuns.find(node => node.nodeId === "voice")!;
      const input = voiceNode.inputState!.versions.find(v => v.id === voiceNode.inputState!.effectiveVersionId)!.value as Record<string, unknown>;
      const planPath = String(input.narrationPlanPath);
      const planBytes = await readFile(planPath);
      const fileSha = createHash("sha256").update(planBytes).digest("hex");
      assert.equal(fileSha, saved.receipt.planSha256, "落盘 v2 计划必须是待保存规范 JSON 字节（canonical，无 pretty）");
      const artifact = persisted.artifacts.find(candidate => candidate.kind === "narration_plan" && candidate.uri === planPath)!;
      assert.equal(artifact.sha256, fileSha, "artifact.sha256 必须是实际文件字节 SHA");
      assert.equal(artifact.sizeBytes, planBytes.byteLength, "artifact.sizeBytes 必须是实际文件字节数");

      // 保存后立即 GET：按版本显式分派，返回真实保存的两段 v2 计划（不是 v1 默认计划）。
      forecastInputs.length = 0;
      const after = await studioApi.narrationPlan(run.id);
      assert.equal(after.confirmed, true);
      assert.equal(after.plan.version, "video-factory/narration-plan-v2");
      assert.equal(after.plan.groups.length, 2);
      assert.deepEqual(after.plan.groups.map((group) => group.sourceScenePositions), [[1], [1, 2, 3]]);
      assert.equal(after.plan.groups[0].text, "同镜第一句。");
      // GET 的核价对象必须是实际返回的计划（不是先对默认计划核价）。
      assert.equal(forecastInputs.length, 1, "GET 恰好核价一次");
      const quotedPlan = (forecastInputs[0]!.input as Record<string, unknown>).narrationPlan as { version: string; groups: unknown[] };
      assert.equal(quotedPlan.version, "video-factory/narration-plan-v2");
      assert.deepEqual(quotedPlan, JSON.parse(JSON.stringify(after.plan)), "核价输入必须逐字段等于 GET 返回的实际计划");
      assert.equal(after.quote?.items?.length, 2, "GET 对实际两段计划报两组价");
      assert.deepEqual(after.quote?.items?.map((item) => item.groupId), after.plan.groups.map((group) => group.id));
      // 正式逐组计价：两段文本长度不同，逐组 units 必须不同（排除按组数 stub 的均一报价）。
      assert.notEqual(after.quote?.items?.[0]?.estimatedUnits, after.quote?.items?.[1]?.estimatedUnits,
        "正式报价按每段真实文本计费，不是组数×固定单价");
      assert.ok(after.quote && Math.abs(after.quote.items.reduce((sum, item) => sum + item.maxCostCny, 0) - after.quote.maxCostCny) < 1e-9);
      assert.equal(voiceCalls, 0, "保存/GET/核价期间零付费合成");

      // 损坏留档的安全错误：篡改字节后 GET 必须以产物完整性错误拒绝，不得静默回退默认计划。
      await writeFile(planPath, Buffer.concat([planBytes, Buffer.from(" ")]));
      await assert.rejects(studioApi.narrationPlan(run.id), /旁白|方案|Artifact|完整/);
      await writeFile(planPath, planBytes);
      assert.equal(voiceCalls, 0);

      // 明确取消高级分段：经既有 v1 PUT 保存默认连续计划为新的输入版本（用户动作，不静默迁移）。
      const canceled = await studioApi.confirmNarrationPlan(run.id, {
        expectedRunRevision: saved.run.revision, plan: JSON.parse(JSON.stringify(initial.plan)) });
      assert.ok(canceled.revision > saved.run.revision, "取消是生成新输入版本的用户动作");
      const afterCancel = await studioApi.narrationPlan(run.id);
      assert.equal(afterCancel.plan.version, "video-factory/narration-plan-v1", "取消后 GET 分派回 v1 校验路径");
      assert.equal(afterCancel.confirmed, true);
      // 历史 v2 计划文件与产物留档不删除（过期参考保留）。
      await assert.equal((await readFile(planPath)).byteLength, planBytes.byteLength, "旧 v2 计划文件保留为过期参考");
      assert.equal(voiceCalls, 0);
    } finally {
      await app.close();
    }
  });
});

describe("SND19 series normal entry through the real service chain", () => {
  // 正常系列链的固定输入：与 NewRunDialog/SeriesDialog 实际提交形态一致（含 local-editorial-v1
  // 素材池与正式 creator defaults 处理），不 mock startRun/production.start。
  function snd19SeriesInput(suffix: string) {
    return {
      name: `SND19 安静片刻 ${suffix}`,
      premise: `系列承诺：每天留一段安静的观察（${suffix}）`,
      audience: "忙碌的内容创作者",
      platform: "douyin",
      category: "lifestyle",
      track: `snd19-${suffix}`,
      pillars: ["窗边观察", "留白节奏"],
      tone: "安静、具体",
      visualStyle: "本地示意卡",
      seasonTitle: "第一季",
      seasonArc: `系列承诺：每天留一段安静的观察（${suffix}）`,
      releaseCadence: "weekly",
      targetEpisodeCount: 6,
    };
  }

  function snd19RunInput(opportunity: { id: string; title: string; hook: string; audience: string; track: string }, seriesContext: unknown, assetSemanticRank = false) {
    return {
      protocolVersion: "video-factory/brief-v1",
      title: opportunity.title,
      angle: opportunity.hook,
      audience: opportunity.audience,
      nicheSlug: opportunity.track,
      durationSeconds: 20,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      reviewMode: "manual",
      runPurpose: "production",
      visualReviewPolicy: "allow_unreviewed_first_cut",
      creationContext: { origin: "series", opportunityId: opportunity.id },
      seriesContext,
      voiceDirection: { profileId: "minimax:Chinese (Mandarin)_News_Anchor", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "minimax-tts-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      workflowFeatures: { assetSemanticRank, referenceGrammar: false, executablePlan: true,
        creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1", boundaryGates: "user-confirmed-v1" },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
      economics: { recipeId: "economy-daily", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 5 },
    };
  }

  // TodayPage 的 selectedSeriesContext 投影：客户端系列快照按真实 UI 形态构造。
  function snd19ClientSeriesContext(series: {
    id: string; name: string; revision: number; premise: string; audience: string; platform: string; track: string;
    bible: unknown; canon: unknown; episodes: Array<Record<string, unknown>>;
  }, episodeNumber: number) {
    const episode = series.episodes.find((item) => item.episodeNumber === episodeNumber)!;
    return {
      seriesId: series.id,
      episodeId: episode.id,
      seriesName: series.name,
      seriesRevision: series.revision,
      episodeNumber: episode.episodeNumber,
      seasonNumber: episode.seasonNumber,
      canonBaseRevision: episode.canonBaseRevision,
      premise: series.premise,
      audience: series.audience,
      platform: series.platform,
      track: series.track,
      arc: episode.arc,
      episode: {
        updatedAt: episode.updatedAt,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        planning: episode.planning,
      },
      bible: series.bible,
      canon: series.canon,
      continuity: episode.continuity,
    };
  }

  async function snd19CreateBoundRun(app: ReturnType<typeof buildStudioApp>, suffix: string, idempotencyKey: string, assetSemanticRank = false) {
    const created = await app.inject({ method: "POST", url: "/api/series", payload: snd19SeriesInput(suffix) });
    assert.equal(created.statusCode, 201, created.body);
    const series = created.json();
    const roadmap = await app.inject({ method: "POST", url: `/api/series/${series.id}/roadmap/generate` });
    assert.equal(roadmap.statusCode, 200, roadmap.body);
    const inbox = await app.inject({ method: "GET", url: "/api/candidate-inbox?origins=series&limit=100" });
    assert.equal(inbox.statusCode, 200, inbox.body);
    const candidate = inbox.json().items.find((item: { seriesId?: string; episodeNumber?: number }) =>
      item.seriesId === series.id && item.episodeNumber === 1);
    assert.ok(candidate, `系列 ${series.id} 的第 1 集候选必须出现在收件箱`);
    const adopted = await app.inject({ method: "POST", url: `/api/candidate-inbox/${candidate.id}/adopt`,
      payload: { origin: "series", ...(candidate.generationId ? { expectedGenerationId: candidate.generationId } : {}) } });
    assert.equal(adopted.statusCode, 201, adopted.body);
    const opportunity = adopted.json();
    const listed = (await app.inject({ method: "GET", url: "/api/series" })).json()
      .find((item: { id: string }) => item.id === series.id);
    const payload = snd19RunInput(opportunity, snd19ClientSeriesContext(listed, 1), assetSemanticRank);
    const response = await app.inject({ method: "POST", url: "/api/runs",
      headers: { "idempotency-key": idempotencyKey }, payload });
    return { response, seriesId: series.id, opportunityId: opportunity.id, payload };
  }

  async function assertSeriesCreation(assetSemanticRank: boolean) {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-snd19-series-"));
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(),
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS,
      // 仅替换模型边界；排序消费真实候选，不联网、不伪造视觉审查证据。
      assetSemanticRanker: {
        id: "controlled-asset-ranker-v1", modelId: "controlled-snd19",
        rank: async (report) => ({
          version: "video-factory/asset-ranking-v1", source: "fallback",
          providerId: "controlled-asset-ranker-v1", modelId: "controlled-snd19",
          summary: "受控QA：保留候选顺序，不代表真实模型质量。",
          fallbackReason: "受控本地排序模型边界",
          scenes: report.scenes.map((scene) => ({
            scenePosition: scene.scenePosition, summary: "受控QA候选",
            candidates: scene.candidates.map((candidate, index) => ({
              provider: candidate.provider, assetId: candidate.assetId,
              originalRank: index + 1, rank: index + 1, semanticScore: 50,
              rationale: "受控QA保留原顺序", locked: false,
            })),
          })),
        }),
      },
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
        transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    let seriesCounter = 0;
    let opportunityCounter = 0;
    const service = new StudioService({
      repositoryRoot,
      workspaceRoot,
      pipeline,
      // 虚拟键只让能力目录报告 MiniMax 可用；真实合成边界由受控 worker 替代，不外发。
      environment: { MINIMAX_API_KEY: "controlled-no-network" },
      commandAvailable: async () => true,
      codexAvailability: { available: true, reason: "受控测试：固定本地角色，不连接 Codex broker。",
        taskKinds: ["script-draft", "creative-treatment", "director-plan", "role-audit"],
        modelId: "controlled-snd19", modelCandidates: [] },
      createId: () => `snd19-opp-${++opportunityCounter}`,
      createSeriesId: () => `snd19-series-${++seriesCounter}`,
    });
    const app = buildStudioApp({ service, logger: false });
    const errors: string[] = [];
    const errorCapture = mock.method(app.log, "error", (error: unknown) => {
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
    });
    try {
      const first = await snd19CreateBoundRun(app, "a", "snd19-series-run-a-1", assetSemanticRank);
      assert.equal(first.response.statusCode, 202, `${first.response.body}\n${errors.join("\n")}`);
      const started = first.response.json();
      assert.ok(started.runId, "202 必须返回真实 runId");
      const detail = (await app.inject({ method: "GET", url: `/api/runs/${started.runId}` })).json();
      assert.equal(detail.creationOrigin, "series");
      assert.equal(detail.seriesId, first.seriesId);
      assert.equal(detail.episodeNumber, 1);
      assert.equal(detail.opportunityId, first.opportunityId);
      assert.ok(detail.productionReservationId, "run 必须绑定系列生产预留编号");
      const seriesAfter = (await app.inject({ method: "GET", url: "/api/series" })).json()
        .find((item: { id: string }) => item.id === first.seriesId);
      const episode = seriesAfter.episodes.find((item: { episodeNumber: number }) => item.episodeNumber === 1);
      assert.equal(episode.status, "in_production");
      assert.equal(episode.runId, started.runId);
      assert.equal(episode.runReservation, undefined, "确认绑定后预留必须清除");
      assert.deepEqual(episode.attemptRunIds, [started.runId]);

      // 同幂等键重放同一请求体：复用原 run，不新增。
      const replay = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "snd19-series-run-a-1" }, payload: first.payload });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(replay.json().runId, started.runId, "同幂等键必须返回原 run");
      const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
      const seriesRuns = runs.filter((run: { seriesId?: string }) => run.seriesId === first.seriesId);
      assert.equal(seriesRuns.length, 1, "同一系列单集只能有一条有效 run");

      // 第二组合法实体：证明没有针对特定 ID 的特判。
      const second = await snd19CreateBoundRun(app, "b", "snd19-series-run-b-1", assetSemanticRank);
      assert.equal(second.response.statusCode, 202, second.response.body);
      const secondRun = second.response.json();
      const secondDetail = (await app.inject({ method: "GET", url: `/api/runs/${secondRun.runId}` })).json();
      assert.equal(secondDetail.seriesId, second.seriesId);
      assert.equal(secondDetail.episodeNumber, 1);
      assert.equal(secondDetail.opportunityId, second.opportunityId);
      assert.notEqual(secondRun.runId, started.runId);
    } finally {
      errorCapture.mock.restore();
      await app.close();
    }
  }
  it("SND19 series normal POST creates one bound run", () => assertSeriesCreation(false));
  it("SND19 series normal POST with assetSemanticRank enabled creates one bound run", () => assertSeriesCreation(true));
});
