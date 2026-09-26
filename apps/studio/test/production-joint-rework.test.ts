import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  type CreativeTreatmentAgent,
  type ProductionBrief,
  type ProductionPipelineOptions,
  type ProductionProviderRuntimeMetadata,
  type ScreenwriterAgent,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "@video-factory/production-pipeline";
import { ProductionStudio } from "../src/server/production-studio.js";
import type { StudioProvider } from "../src/shared/api.js";

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
