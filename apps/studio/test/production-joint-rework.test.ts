import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
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

function jointReworkAgents(spies: ReworkSpies): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent"> {
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
        narration: `第${position}段旁白内容`,
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
});
