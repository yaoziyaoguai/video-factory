import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ProductionPipeline, StaleRunRevisionError, type NodeInputOverrideDraft, type ProductionBrief, type ProductionPipelineOptions, type ScreenwriterAgent, type VisualAssetProviderCapability, type VisualDirectorAgent, type VisualDirectorAgentInput, type WorkflowRun, type WorkerResponse } from "@video-factory/production-pipeline";
import { buildStudioApp, type StudioServicePort } from "../src/server/app.js";
import { ProductionStudio } from "../src/server/production-studio.js";
import { StudioConflictError } from "../src/server/studio-service.js";
import { StudioInputError, type StudioProvider, type StudioRunDetail } from "../src/shared/api.js";

// ---------------------------------------------------------------------------
// B4-REMAINDER：creative-planning planningStageId 编辑 API 的行为测试。
// - 只有 nodeId=creative-planning 可以携带 planningStageId；只允许 treatment/script/director；
//   unknown 或其他 nodeId 携带一律 StudioInputError/HTTP 400；旧 nodeId API 请求体保持兼容。
// - stale/在执行/未知付费结果的安全合同不得因 planningStageId 路径退化。
// - joint run 的素材来源调整失效路由必须指向真实存在的 creative-planning 节点。
// ---------------------------------------------------------------------------

const TREATMENT_PROVIDER_ID = "codex-creative-treatment-v1";

class EditingWorker {
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

interface EditingSpies {
  treatmentCalls: string[];
  screenwriterCalls: string[];
  directorCalls: number;
  directorModels: string[];
}

function editingAgents(spies: EditingSpies): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent"> {
  return {
    treatmentAgents: [
      {
        providerId: "openai",
        agent: {
          id: TREATMENT_PROVIDER_ID,
          modelId: "treatment-model-a",
          treat: async (input: { brief: { title: string } }) => {
            spies.treatmentCalls.push(input.brief.title);
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
        },
      },
      {
        providerId: "zai-bigmodel-api",
        agent: {
          id: TREATMENT_PROVIDER_ID,
          modelId: "treatment-model-b",
          treat: async (input: { brief: { title: string } }) => {
            spies.treatmentCalls.push(`${input.brief.title}::model-b`);
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
        },
      },
    ],
    screenwriterAgent: {
      id: "codex-screenwriter-v1",
      modelId: "screenwriter-model-one",
      draft: async (input: { brief: { title: string }; selectedModelId?: string }) => {
        spies.screenwriterCalls.push(input.selectedModelId ?? "screenwriter-model-one");
        return {
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
        };
      },
    } as ScreenwriterAgent,
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "director-model-one",
      plan: async (input: VisualDirectorAgentInput) => {
        spies.directorCalls += 1;
        spies.directorModels.push(input.selectedModelId ?? "director-model-one");
        return {
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
        };
      },
    } as VisualDirectorAgent,
  };
}

const EDITING_ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
  { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
];

function editingBrief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "joint-v1 阶段编辑",
    angle: "planningStageId 白名单",
    audience: "内容创作者",
    nicheSlug: "planning-editing",
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

function textModelProfile(providerId: string, modelId: string, family: string, recommended = false): StudioProvider["modelProfiles"] {
  return [{
    id: modelId,
    label: modelId,
    providerId,
    providerFamily: family,
    available: true,
    ...(recommended ? { recommended: true } : {}),
    description: "fixture model",
    taskTypes: ["text"],
  }];
}

function editingProviders(): StudioProvider[] {
  return [
    { id: "codex-screenwriter-v1", capability: "script.draft", label: "AI 编剧", available: true, kind: "external", defaultModelId: "screenwriter-model-one", modelProfiles: textModelProfile("codex-screenwriter-v1", "screenwriter-model-one", "openai", true).concat(textModelProfile("codex-screenwriter-v1", "screenwriter-model-two", "openai")) },
    { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external", defaultModelId: "director-model-one", modelProfiles: textModelProfile("api-visual-director-v1", "director-model-one", "openai", true).concat(textModelProfile("api-visual-director-v1", "director-model-two", "openai")) },
    { id: TREATMENT_PROVIDER_ID, capability: "creative.treatment", label: "AI 前期构思", available: true, kind: "external", defaultModelId: "treatment-model-a", modelProfiles: textModelProfile(TREATMENT_PROVIDER_ID, "treatment-model-a", "openai", true).concat(textModelProfile(TREATMENT_PROVIDER_ID, "treatment-model-b", "zai-bigmodel")) },
    { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
    { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels", available: true, kind: "external" },
    { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑画面", available: true, kind: "local" },
    { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
    { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" },
    { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" },
  ];
}

function newEditingStudio(workspaceRoot: string, spies: EditingSpies): { studio: ProductionStudio; pipeline: ProductionPipeline } {
  const pipeline = new ProductionPipeline({
    workspaceRoot,
    worker: new EditingWorker(),
    ...editingAgents(spies),
    assetProviders: EDITING_ASSET_PROVIDERS,
  });
  const studio = new ProductionStudio({
    workspaceRoot,
    pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
    listProviders: async () => editingProviders(),
  });
  return { studio, pipeline };
}

async function startJointRun(harness: { studio: ProductionStudio; pipeline: ProductionPipeline }): Promise<string> {
  const run = await harness.pipeline.start(editingBrief());
  assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
  return run.id;
}

async function effectivePlanningInputValue(studio: ProductionStudio, runId: string): Promise<unknown> {
  const detail = await studio.get(runId);
  assert.ok(detail);
  const planning = detail.nodes.find((node) => node.id === "creative-planning");
  assert.ok(planning?.inputState, "the planning node must expose input versions for editing");
  return planning.inputState.versions.find((version) => version.id === planning.inputState?.effectiveVersionId)?.value;
}

// 合法编辑调用必须读取真实并发 token：run revision + 当前输入版本 id。
async function planningEditTokens(studio: ProductionStudio, runId: string): Promise<{ expectedRunRevision: number; expectedVersionId: string }> {
  const detail = await studio.get(runId);
  assert.ok(detail);
  const planning = detail.nodes.find((node) => node.id === "creative-planning");
  assert.ok(planning?.inputState, "the planning node must expose input versions for editing");
  return { expectedRunRevision: detail.revision, expectedVersionId: planning.inputState.effectiveVersionId };
}

async function mutateRunJson(runId: string, workspaceRoot: string, mutate: (payload: Record<string, unknown>) => void): Promise<void> {
  const runJsonPath = path.join(workspaceRoot, "runs", runId, "run.json");
  const payload = JSON.parse(await readFile(runJsonPath, "utf8")) as Record<string, unknown>;
  mutate(payload);
  await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
}

describe("planningStageId editing API (B4-REMAINDER)", () => {
  it("accepts planningStageId only on creative-planning and only for whitelisted stages", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-http-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    const planningInput = await effectivePlanningInputValue(harness.studio, runId);
    assert.ok(planningInput && typeof planningInput === "object", "the planning node input must be visible for editing");
    const tokens = await planningEditTokens(harness.studio, runId);

    // 合法：creative-planning + treatment，携带真实并发 token。
    await harness.studio.applyNodeInputOverride(runId, "creative-planning", {
      input: planningInput,
      ...tokens,
      planningStageId: "treatment",
    }, "producer");

    // 非法阶段（白名单外）→ StudioInputError（HTTP 400），先于并发 token 校验。
    await assert.rejects(
      () => harness.studio.applyNodeInputOverride(runId, "creative-planning", {
        input: planningInput,
        ...tokens,
        planningStageId: "compile",
      }, "producer"),
      /阶段|planningStageId/,
    );
    // 其他 nodeId 携带 planningStageId → StudioInputError（HTTP 400）。
    await assert.rejects(
      () => harness.studio.applyNodeInputOverride(runId, "assets", {
        input: { assetPlanPath: "unused" },
        ...tokens,
        planningStageId: "treatment",
      }, "producer"),
      /阶段|planningStageId/,
    );
    await assert.rejects(
      () => harness.studio.applyNodeExecutionConfiguration(runId, "assets", {
        expectedRunRevision: tokens.expectedRunRevision,
        planningStageId: "script",
        modelSelections: { "codex-screenwriter-v1": "screenwriter-model-two" },
      }, "producer"),
      /阶段|planningStageId/,
    );
  });

  it("maps planningStageId validation failures and conflicts to 400/409 at the HTTP layer", async () => {
    const overrides: string[] = [];
    const service: StudioServicePort = {
      health: async () => ({ status: "ok", runtime: { ffmpeg: true, ffprobe: true, say: true } }),
      applyNodeInputOverride: async (_runId, nodeId, input) => {
        if (nodeId === "assets") throw new StudioInputError("只有创作规划阶段可以携带阶段编号。");
        if (nodeId === "conflict") throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
        overrides.push(`${nodeId}:${(input as { planningStageId?: string }).planningStageId ?? "-"}`);
        return {} as StudioRunDetail;
      },
      applyNodeExecutionConfiguration: async (_runId, nodeId, input) => {
        overrides.push(`exec:${nodeId}:${(input as { planningStageId?: string }).planningStageId ?? "-"}`);
        return {} as StudioRunDetail;
      },
    } as unknown as StudioServicePort;
    const app = buildStudioApp({ service });
    const inject = async (method: string, url: string, body: unknown) => app.inject({ method, url, payload: body });

    let response = await inject("PUT", "/api/runs/run-1/nodes/assets/input-override", {
      input: {},
      expectedRunRevision: 0,
      expectedVersionId: "input-v1",
      planningStageId: "treatment",
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /阶段/);

    // 非法枚举在 parser 层单独 400（不与 node/stage 配对错误混在一次请求里）。
    response = await inject("PUT", "/api/runs/run-1/nodes/creative-planning/input-override", { input: { brief: {} }, planningStageId: "compile" });
    assert.equal(response.statusCode, 400, response.body);

    response = await inject("PUT", "/api/runs/run-1/nodes/creative-planning/input-override", {
      input: { brief: {} },
      expectedRunRevision: 0,
      expectedVersionId: "input-v1",
      planningStageId: "treatment",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(overrides, ["creative-planning:treatment"]);

    response = await inject("PUT", "/api/runs/run-1/nodes/conflict/input-override", {
      input: {},
      expectedRunRevision: 0,
      expectedVersionId: "input-v1",
      planningStageId: "treatment",
    });
    assert.equal(response.statusCode, 409, response.body);

    // 旧 nodeId 请求体（无 planningStageId）保持兼容，不被新校验拦截；合法 token 齐备。
    response = await inject("PUT", "/api/runs/run-1/nodes/assets/execution-configuration", { expectedRunRevision: 0, modelSelections: {} });
    assert.equal(response.statusCode, 200, response.body);
  });

  it("routes stage-scoped model changes to the matching provider binding", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-model-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);

    // script 阶段换模型：只允许编剧能力的模型键；每次成功修改推进 revision，
    // 后续独立修改必须重新读取并发 token，不能复用旧请求的 revision。
    let tokens = await planningEditTokens(harness.studio, runId);
    await harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
      ...tokens,
      planningStageId: "script",
      modelSelections: { "codex-screenwriter-v1": "screenwriter-model-two" },
    }, "producer");
    const detail = await harness.studio.get(runId);
    assert.ok(detail);
    const scriptStage = detail.planningStages?.find((stage) => stage.id === "script");
    assert.ok(scriptStage);
    assert.equal(scriptStage.status, "pending");
    assert.equal(scriptStage.effectiveModelId, "screenwriter-model-two");

    // script 阶段选择导演能力的模型键 → 400（能力不匹配，不是并发冲突）。
    tokens = await planningEditTokens(harness.studio, runId);
    await assert.rejects(
      () => harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
        ...tokens,
        planningStageId: "script",
        modelSelections: { "api-visual-director-v1": "director-model-two" },
      }, "producer"),
      /模型|能力/,
    );

    // treatment 阶段换模型：路由到前期构思能力。
    tokens = await planningEditTokens(harness.studio, runId);
    await harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
      ...tokens,
      planningStageId: "treatment",
      modelSelections: { [TREATMENT_PROVIDER_ID]: "treatment-model-b" },
    }, "producer");
    const treatmentDetail = await harness.studio.get(runId);
    const treatmentStage = treatmentDetail.planningStages?.find((stage) => stage.id === "treatment");
    assert.ok(treatmentStage);
    assert.equal(treatmentStage.effectiveModelId, "treatment-model-b");
  });

  it("uses a saved director model on the next formal run while preserving completed treatment and script", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-model-route-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    assert.deepEqual(spies.directorModels, ["director-model-one"]);
    assert.equal(spies.treatmentCalls.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);

    await harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
      ...await planningEditTokens(harness.studio, runId),
      planningStageId: "director",
      modelSelections: { "api-visual-director-v1": "director-model-two" },
    }, "producer");
    const stale = await harness.pipeline.loadPersisted(runId);
    assert.equal(stale.status, "stale");

    const resumed = await harness.pipeline.resumeStale(runId);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentCalls.length, 1, "changing only the director model must reuse the completed treatment");
    assert.equal(spies.screenwriterCalls.length, 1, "changing only the director model must reuse the completed script");
    assert.deepEqual(spies.directorModels, ["director-model-one", "director-model-two"], "the resumed formal director request must consume the saved model");
    const stages = (await harness.studio.get(runId))?.planningStages;
    assert.equal(stages?.find((stage) => stage.id === "treatment")?.status, "completed");
    assert.equal(stages?.find((stage) => stage.id === "script")?.status, "completed");
    assert.equal(
      stages?.find((stage) => stage.id === "director")?.effectiveModelId,
      "unknown",
      "the fixture has no returned execution trace, so the UI must not turn the configured model into claimed provenance",
    );
  });

  it("uses a saved script model on the next formal run while preserving only the completed treatment", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-script-model-route-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    assert.deepEqual(spies.screenwriterCalls, ["screenwriter-model-one"]);
    assert.equal(spies.treatmentCalls.length, 1);
    assert.equal(spies.directorCalls, 1);

    await harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
      ...await planningEditTokens(harness.studio, runId),
      planningStageId: "script",
      modelSelections: { "codex-screenwriter-v1": "screenwriter-model-two" },
    }, "producer");
    const stale = await harness.pipeline.loadPersisted(runId);
    assert.equal(stale.status, "stale");

    const resumed = await harness.pipeline.resumeStale(runId);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentCalls.length, 1, "changing only the script model must reuse the completed treatment");
    assert.deepEqual(
      spies.screenwriterCalls,
      ["screenwriter-model-one", "screenwriter-model-two"],
      "the resumed formal script request must consume the saved model",
    );
    assert.equal(spies.directorCalls, 2, "the director must rerun from the new accepted script");
  });

  it("keeps the safety contract for planning edits: no overwrite while running or with uncertain paid outcomes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-safety-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    const planningInput = await effectivePlanningInputValue(harness.studio, runId);

    await mutateRunJson(runId, workspaceRoot, (payload) => {
      (payload as { status: string }).status = "running";
    });
    await assert.rejects(
      () => harness.studio.applyNodeInputOverride(runId, "creative-planning", {
        input: planningInput,
        planningStageId: "director",
      }, "producer"),
      (error: unknown) => {
        assert.ok(error instanceof StudioConflictError, `expected a conflict, received: ${String(error)}`);
        return true;
      },
    );

    await mutateRunJson(runId, workspaceRoot, (payload) => {
      (payload as { status: string }).status = "needs_human";
      const nodeRuns = (payload as { nodeRuns: Array<{ nodeId: string; outcomeUncertain?: boolean }> }).nodeRuns;
      const voice = nodeRuns.find((node) => node.nodeId === "voice");
      assert.ok(voice, "the joint run must contain the voice node");
      voice.outcomeUncertain = true;
    });
    await assert.rejects(
      () => harness.studio.applyNodeInputOverride(runId, "creative-planning", {
        input: planningInput,
        planningStageId: "director",
      }, "producer"),
      /付费结果尚未核对/,
    );
    await assert.rejects(
      () => harness.studio.applyNodeExecutionConfiguration(runId, "creative-planning", {
        planningStageId: "director",
        modelSelections: { "api-visual-director-v1": "director-model-two" },
      }, "producer"),
      /付费结果尚未核对/,
    );
  });

  it("routes joint asset-source adjustments back to the creative-planning node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-assets-route-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    const tokens = await planningEditTokens(harness.studio, runId);

    // joint run 的素材来源调整：失效目标必须是真实存在的 creative-planning 节点。
    await harness.studio.applyNodeExecutionConfiguration(runId, "assets", {
      ...tokens,
      assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"],
    }, "producer");
    const detail = await harness.studio.get(runId);
    assert.ok(detail);
    const planning = detail.nodes.find((node) => node.id === "creative-planning");
    assert.ok(planning, "the joint planning node must remain visible after the asset adjustment");
    assert.equal(planning.status, "stale", "the asset-source adjustment must invalidate the joint planning node");
  });

  it("rejects a stale caller revision at the locked mutation point with zero state change", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-locked-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    const staleTokens = await planningEditTokens(harness.studio, runId);
    const detailBefore = await harness.studio.get(runId);
    assert.ok(detailBefore);
    const artifactsBefore = detailBefore.artifacts.map((artifact) => artifact.id);

    // 并发写入方选择素材来源配置变更：推进 run revision，但不改变 creative-planning 的
    // 输入版本——因此只有 caller revision 复核能拒绝过期请求，输入版本比对发现不了。
    await harness.studio.applyNodeExecutionConfiguration(runId, "assets", {
      expectedRunRevision: staleTokens.expectedRunRevision,
      assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"],
    }, "producer-a");

    const planningInput = await effectivePlanningInputValue(harness.studio, runId);
    await assert.rejects(
      () => harness.pipeline.applyNodeInputOverride(runId, {
        nodeId: "creative-planning",
        actor: "producer-b",
        input: planningInput,
        ...staleTokens,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StaleRunRevisionError, `expected StaleRunRevisionError, received: ${String(error)}`);
        return true;
      },
    );

    // 拒绝后零变更：revision 保持 producer-a 之后的值，planning 输入版本集合不变。
    const detail = await harness.studio.get(runId);
    assert.ok(detail);
    const planning = detail.nodes.find((node) => node.id === "creative-planning");
    assert.ok(planning?.inputState);
    assert.equal(detail.revision, staleTokens.expectedRunRevision + 1, "only producer-a's edit may advance the revision");
    assert.equal(planning.inputState.versions.length, 1, "the rejected edit must not add an input version");
    assert.equal(
      detail.artifacts.filter((artifact) => !artifactsBefore.includes(artifact.id) && artifact.kind !== "asset_plan").length,
      0,
      "the rejected edit must not add artifacts",
    );
  });

  it("revalidates caller tokens at the locked point after both requests passed the service precheck", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-editing-barrier-"));
    const spies: EditingSpies = { treatmentCalls: [], screenwriterCalls: [], directorCalls: 0, directorModels: [] };
    const harness = newEditingStudio(workspaceRoot, spies);
    const runId = await startJointRun(harness);
    const planningInput = await effectivePlanningInputValue(harness.studio, runId);
    const staleTokens = await planningEditTokens(harness.studio, runId);

    // 第二个客户端的 pipeline 在进入持锁修改点前等待：B 已通过自己的 service 预检查，
    // producer-a 的写入在 B 等待期间落定，B 携带旧 token 进入持锁点必须失败。
    let signalClientBAtPipeline!: () => void;
    const clientBAtPipeline = new Promise<void>((resolve) => { signalClientBAtPipeline = resolve; });
    let releaseClientB!: () => void;
    const releaseToClientB = new Promise<void>((resolve) => { releaseClientB = resolve; });
    const clientBPipeline = new class extends ProductionPipeline {
      override async applyNodeInputOverride(run: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>> {
        signalClientBAtPipeline();
        await releaseToClientB;
        return super.applyNodeInputOverride(run, override);
      }
    }({
      workspaceRoot,
      worker: new EditingWorker(),
      ...editingAgents(spies),
      assetProviders: EDITING_ASSET_PROVIDERS,
    });
    const clientBStudio = new ProductionStudio({
      workspaceRoot,
      pipeline: clientBPipeline,
      archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
      listProviders: async () => editingProviders(),
    });

    const clientBAttempt = clientBStudio.applyNodeInputOverride(runId, "creative-planning", {
      // B 保存不同的内容，避免 service 层把同值请求短路成 no-op 而跳过持锁点。
      input: { ...planningInput, brief: { ...(planningInput as { brief: Record<string, unknown> }).brief, angle: "producer-b 的切入角度" } },
      ...staleTokens,
      planningStageId: "treatment",
    }, "producer-b").then(
      () => "saved" as const,
      (error: unknown) => error,
    );
    // B 通过预检查、停在持锁点入口之后，producer-a 的完整写入才落定（内容不同，推进 revision）。
    await clientBAtPipeline;
    await harness.studio.applyNodeInputOverride(runId, "creative-planning", {
      input: { ...planningInput, brief: { ...(planningInput as { brief: Record<string, unknown> }).brief, angle: "producer-a 的切入角度" } },
      ...await planningEditTokens(harness.studio, runId),
      planningStageId: "treatment",
    }, "producer-a");
    releaseClientB();

    const clientBOutcome = await clientBAttempt;
    assert.ok(clientBOutcome instanceof Error, `client b must fail, received: ${String(clientBOutcome)}`);
    assert.match(String((clientBOutcome as Error).message ?? clientBOutcome), /已被其他操作更新|Stale run revision/);

    // 拒绝后零变更：只有 producer-a 的版本和 revision。
    const detail = await harness.studio.get(runId);
    assert.ok(detail);
    const planning = detail.nodes.find((node) => node.id === "creative-planning");
    assert.ok(planning?.inputState);
    assert.equal(detail.revision, staleTokens.expectedRunRevision + 1);
    assert.equal(planning.inputState.versions.length, 2);
    assert.equal(
      planning.inputState.versions.filter((version) => version.createdBy === "producer-a").length,
      1,
      "only producer-a's input version may be persisted",
    );
  });
});
