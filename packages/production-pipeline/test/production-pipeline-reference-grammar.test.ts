import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  RoleAgentLoopError,
  type ReferenceGrammarAgentInput,
  type ProductionBrief,
  type ProductionPipelineOptions,
  type VisualAssetProviderCapability,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "../src/index.js";

class ReferenceWorker {
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
    const jsonContent = capability === "script.draft"
      ? JSON.stringify({ scenes: [{ position: 1, narration: "镜头一", duration: 6, visual_strategy: "stock", visual_prompt: "城市早晨", on_screen_text: "开始", sound_cue: "环境声" }] })
      : capability === "video.render"
        ? JSON.stringify({ capability, font_resource: { family: "Fixture Sans", license_note: "Fixture font; rights not verified.", license_verified: false } })
        : JSON.stringify({ capability });
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

describe("ProductionPipeline reference grammar", () => {
  it("keeps the server path private and passes editable abstract grammar into the director", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-reference-pipeline-"));
    const referenceRoot = path.join(workspaceRoot, "uploads", "reference-videos");
    const uploadId = "67d86948-5517-4b17-8da1-b0a695159d4d";
    const sourcePath = path.join(referenceRoot, uploadId, "source.mp4");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "reference-video");
    const referenceSha256 = createHash("sha256").update("reference-video").digest("hex");
    let grammarInput: ReferenceGrammarAgentInput | undefined;
    let directorInput: VisualDirectorAgentInput | undefined;
    let analysisFailure: "none" | "ordinary" | "audit" = "none";
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      referenceVideoRoot: referenceRoot,
      referenceGrammarAgent: {
        id: "codex-reference-grammar-v1",
        modelId: "codex-default",
        analyze: async (input) => {
          if (analysisFailure === "ordinary") throw new Error(`multimodal service unavailable at ${sourcePath}`);
          if (analysisFailure === "audit") throw exhaustedReferenceAudit();
          grammarInput = input;
          return {
            version: "video-factory/shot-grammar-v1",
            summary: "短促开场后稳定解释",
            durationMs: 6_000,
            pacing: "前快后稳",
            composition: "先近景再中景",
            camera: "轻推后固定",
            color: "自然低饱和",
            transitions: "动作切换",
            sound: "环境声先行",
            beats: [{ startMs: 0, endMs: 6_000, narrativeFunction: "建立问题", shotSize: "近景", composition: "主体居中", cameraMovement: "轻推", subjectMovement: "自然动作", lighting: "自然光", color: "低饱和", transitionIn: "直接切入", soundRole: "建立空间" }],
            reusableRules: ["用动作建立开场"],
            avoidCopying: ["不复制人物、对白和情节"],
            confidence: 0.82,
          };
        },
      },
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => {
          directorInput = input;
          return {
            version: "video-factory/director-plan-v1",
            requestedProfileId: input.brief.requestedProfileId,
            resolvedProfileId: "documentary-observer",
            profileRationale: "用抽象语法指导新内容。",
            visualBible: { narrativeApproach: "动作开场", pacing: "前快后稳", composition: "近景到中景", camera: "轻推", color: "自然", continuity: "同一时段", sound: "环境声" },
            shots: input.scenes.map((scene) => ({
              scenePosition: scene.position,
              narrativeRole: "解释",
              authenticityPolicy: "illustrative",
              preferredProviderId: "local-editorial-v1",
              deliveryType: "editorial_card",
              alternativeProviderIds: [],
              temporalBeats: ["[0s-3s] 建立", "[3s-6s] 解释"],
              query: scene.visualPrompt,
              generationPrompt: scene.visualPrompt,
              rationale: "免费画面足够。",
              continuityNote: "保持统一。",
              confidence: 0.8,
              estimatedCostCny: 0,
            })),
          };
        },
      },
      assetProviders: [{ id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] }],
    });

    const brief: ProductionBrief = {
      protocolVersion: "video-factory/brief-v1",
      title: "新的主题",
      angle: "新的内容角度",
      audience: "内容创作者",
      nicheSlug: "reference-grammar",
      durationSeconds: 24,
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "manual",
      providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
      referenceVideo: {
        uploadId,
        label: "参考节奏.mp4",
        mimeType: "video/mp4",
        sizeBytes: 15,
        path: sourcePath,
        sha256: referenceSha256,
      },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
      economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    };
    const run = await subject.start(brief);

    const referenceNode = run.nodeRuns.find((node) => node.nodeId === "reference-grammar");
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(run.workflowVersion, "1.4.0");
    assert.equal((referenceNode?.inputState?.versions[0]?.value as Record<string, unknown>).sourcePath, undefined);
    assert.equal((referenceNode?.inputState?.versions[0]?.value as Record<string, unknown>).sha256, referenceSha256);
    assert.match(grammarInput?.videoPath ?? "", /nodes\/reference-grammar\/attempt-1\/reference\.mp4$/);
    assert.equal((await stat(sourcePath)).isFile(), true);
    assert.equal(directorInput?.brief.referenceGrammar?.summary, "短促开场后稳定解释");
    assert.ok(run.artifacts.some((artifact) => artifact.kind === "shot_grammar"));
    assert.ok(run.artifacts.some((artifact) => artifact.kind === "reference_video"));
    const intervention = run.interventions.find((item) => item.nodeId === "final-review");
    assert.ok(intervention);
    const finalReviewOutput = run.nodeRuns.find((node) => node.nodeId === "final-review")?.output as Record<string, unknown> | undefined;
    const finished = await subject.decide(run.id, {
      interventionId: intervention.id,
      action: "approve",
      actor: "producer",
      expectedRunRevision: run.revision,
      reviewEvidenceId: typeof finalReviewOutput?.reviewEvidenceId === "string"
        ? finalReviewOutput.reviewEvidenceId
        : null,
    });
    const manifestArtifact = finished.artifacts.find((artifact) => artifact.kind === "resource_manifest");
    assert.ok(manifestArtifact?.uri);
    const referenceArtifact = finished.artifacts.find((artifact) => artifact.kind === "reference_video");
    assert.ok(referenceArtifact && manifestArtifact.parentArtifactIds?.includes(referenceArtifact.id));
    const manifest = JSON.parse(await readFile(manifestArtifact.uri, "utf8")) as { version: string; runId: string; items: Array<{ category: string; kind: string; reviewStatus: string }> };
    assert.equal(manifest.version, "video-factory/resource-manifest-v1");
    assert.equal(manifest.runId, finished.id);
    assert.ok(manifest.items.some((item) => item.category === "voice"));
    assert.equal(manifest.items.find((item) => item.kind === "reference_video")?.reviewStatus, "needs_review");
    assert.equal(manifest.items.find((item) => item.category === "font")?.reviewStatus, "needs_review");
    assert.ok(manifest.items.every((item) => item.reviewStatus === "recorded" || item.reviewStatus === "needs_review"));
    assert.ok(!finished.artifacts.some((artifact) => artifact.kind === "publish_package" && artifact.parentArtifactIds?.some((id) => finished.artifacts.find((item) => item.id === id)?.kind === "reference_video")));

    const edited = await subject.applyNodeInputOverride(finished.id, {
      nodeId: "reference-grammar",
      actor: "producer",
      input: { uploadId, label: "人工复核后的参考节奏.mp4", sha256: referenceSha256 },
      allowTerminalEdit: true,
    });
    const regenerated = await subject.resumeStale(edited.id);
    assert.equal(regenerated.status, "needs_human");
    assert.equal(grammarInput?.sourceLabel, "人工复核后的参考节奏.mp4");
    assert.match(grammarInput?.videoPath ?? "", /nodes\/reference-grammar\/attempt-2\/reference\.mp4$/);

    analysisFailure = "ordinary";
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "reference-video");
    const degraded = await subject.start({ ...brief, title: "参考分析降级任务" });
    const degradedNode = degraded.nodeRuns.find((node) => node.nodeId === "reference-grammar");
    assert.equal(degraded.status, "needs_human");
    assert.equal(degradedNode?.status, "succeeded");
    assert.equal(degradedNode?.executionReceipt?.providerId, "local-reference-grammar-fallback-v1");
    assert.equal(degradedNode?.executionReceipt?.fallbackFromProviderId, "codex-reference-grammar-v1");
    assert.match(degradedNode?.executionReceipt?.fallbackReason ?? "", /multimodal service unavailable/);
    assert.match(degradedNode?.executionReceipt?.fallbackReason ?? "", /\[系统托管文件\]/);
    assert.doesNotMatch(degradedNode?.executionReceipt?.fallbackReason ?? "", new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((degradedNode?.output as { grammar?: { confidence?: number } }).grammar?.confidence, 0.25);
    const grammarArtifact = degraded.artifacts.find((artifact) => artifact.kind === "shot_grammar");
    assert.ok(grammarArtifact?.uri);
    assert.equal((await readFile(grammarArtifact.uri, "utf8")).includes(sourcePath), false);

    analysisFailure = "audit";
    const blocked = await subject.start({ ...brief, title: "参考分析审计失败任务" });
    const blockedNode = blocked.nodeRuns.find((node) => node.nodeId === "reference-grammar");
    assert.equal(blocked.status, "failed");
    assert.equal(blockedNode?.status, "failed");
    assert.match(blockedNode?.error ?? "", /三轮参考分析审计仍未通过/);
    assert.equal(blocked.artifacts.some((artifact) => artifact.kind === "shot_grammar"), false);
  });
});

function exhaustedReferenceAudit(): RoleAgentLoopError {
  return new RoleAgentLoopError("三轮参考分析审计仍未通过", {
    version: "video-factory/agent-loop-v1",
    role: "参考视频分析师",
    contractVersion: "fixture-v1",
    criteria: ["只提炼可复用镜头语法"],
    status: "failed",
    maxIterations: 3,
    modelCallCount: 6,
    iterations: [],
  });
}

// ---------------------------------------------------------------------------
// joint-v1 共同创作规划：新制作只出现并执行一条规划链，旧四规划节点不再创建。
// ---------------------------------------------------------------------------

// 图库路线的 worker：script/asset/voice/render/quality 沿用 ReferenceWorker 输出，
// asset.search 输出真实 AssetCandidateReport JSON（每个 stock 场景一行候选）。
class JointLibraryWorker extends ReferenceWorker {
  searchCalls: Array<{ scriptPath: string; directorPlanPath: string }> = [];
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    if (capability !== "asset.search") return super.run(request);
    const parameters = request.parameters as Record<string, unknown>;
    this.searchCalls.push({
      scriptPath: String(parameters.scriptPath),
      directorPlanPath: String(parameters.directorPlanPath),
    });
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    // 与生产 Python worker（stock_assets.py）一致的 snake_case 线格式：本夹具模拟的是
    // 现有 asset.search 命令的真实输出，解析仍走 parseAssetCandidateReport。
    const report = {
      version: "video-factory/asset-candidates-v1",
      scene_candidates: [1, 2, 3].map((position) => ({
        scene_position: position,
        intent: { query: `stock-query-${position}` },
        query: `stock-query-${position}`,
        candidates: [{
          provider: "pexels-stock-v1",
          asset_id: `asset-${position}`,
          media_type: "video",
          width: 1920,
          height: 1080,
          duration: 6,
          preview_url: `https://images.pexels.com/preview-${position}.jpg`,
          source_url: `https://videos.pexels.com/video-${position}`,
          creator: "fixture-creator",
          license_note: "Fixture license.",
          query: `stock-query-${position}`,
          score: 80,
        }],
      })),
    };
    const content = JSON.stringify(report, null, 2);
    const candidateSearchPath = path.join(outputDir, "candidate_search.json");
    const candidateInventoryPath = path.join(outputDir, "candidate_inventory.json");
    await writeFile(candidateSearchPath, content);
    await writeFile(candidateInventoryPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output: { candidateSearchPath, candidateInventoryPath },
      artifacts: [{
        kind: "asset_candidates",
        uri: candidateSearchPath,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        contentType: "application/json",
        provenance: {
          providerId: String(parameters.providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }],
    };
  }
}

interface JointPlanningSpies {
  treatmentCalls: number;
  /** 构思角色实际收到参考语法（风格/结构参考）的调用记录。 */
  treatmentGrammarSeen: boolean[];
  screenwriterCalls: number;
  directorCalls: number;
  rankCalls: number;
  rankedReports: Array<{ version: string; sceneCount: number }>;
  treatmentError?: Error;
}

// joint-v1 的三个创作角色 producer 替身 + 真实 ranker 合同替身（rankDetailed(report, checkpoint)）。
// 输出按传入输入内容投影（scenes 映射 shots），不按调用序硬塞。
// 返回类型显式标注为选项子集：独立推断会把版本等字面量拓宽成 string，破坏角色合同类型。
function jointPlanningAgents(
  spies: JointPlanningSpies,
  failure: { treatment?: boolean } = {},
): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent" | "assetSemanticRanker"> {
  return {
    treatmentAgents: [{
      providerId: "openai",
      agent: {
        id: "codex-creative-treatment-v1",
        modelId: "codex-default",
        treat: async (input: { referenceGrammar?: unknown }) => {
          spies.treatmentCalls += 1;
          spies.treatmentGrammarSeen.push(input.referenceGrammar !== undefined);
          if (failure.treatment) throw new Error("构思审计失败：三轮未通过");
          return {
            version: "video-factory/creative-treatment-v1",
            viewerPromise: "看完能避开三个决策坑",
            hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
            progression: [
              { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
              { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
            ],
            payoff: "低风险决策清单",
            visualPrinciples: ["真实动作", "少字多画面"],
            soundPrinciples: ["环境声先行"],
            evidenceRequirements: [],
            feasibilityQuestions: [],
          };
        },
      },
    }],
    screenwriterAgent: {
      id: "codex-screenwriter-v1",
      draft: async () => {
        spies.screenwriterCalls += 1;
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
    },
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "codex-default",
      plan: async (input: VisualDirectorAgentInput) => {
        spies.directorCalls += 1;
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
            preferredProviderId: "pexels-stock-v1",
            deliveryType: "stock_video",
            alternativeProviderIds: [],
            temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
            query: `stock-query-${scene.position}`,
            generationPrompt: `第${scene.position}个真实生活动作`,
            rationale: "真实图库可以执行。",
            continuityNote: "保持自然色。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        };
      },
    },
    assetSemanticRanker: {
      id: "codex-asset-ranker-v1",
      modelId: "codex-default",
      rank: async () => {
        spies.rankCalls += 1;
        throw new Error("joint-v1 rank adapter must use rankDetailed");
      },
      rankDetailed: async (report: { version: string; scenes: unknown[] }) => {
        spies.rankCalls += 1;
        spies.rankedReports.push({ version: report.version, sceneCount: report.scenes.length });
        return {
          output: {
            version: "video-factory/asset-ranking-v1",
            source: "model",
            providerId: "codex-asset-ranker-v1",
            modelId: "codex-default",
            summary: "语义排序完成",
            scenes: (report.scenes as Array<{ scenePosition: number; candidates: Array<{ provider: string; assetId: string }> }>).map((scene) => ({
              scenePosition: scene.scenePosition,
              summary: "高分候选可用",
              candidates: scene.candidates.slice(0, 1).map((candidate, index) => ({
                provider: candidate.provider,
                assetId: candidate.assetId,
                originalRank: index + 1,
                rank: index + 1,
                semanticScore: 80,
                rationale: "语义分足够",
                locked: false,
              })),
            })),
          },
        };
      },
    },
  };
}

function jointBriefBase(overrides: {
  assetSemanticRank?: boolean;
  referenceGrammar?: boolean;
  referenceVideo?: ProductionBrief["referenceVideo"];
} = {}): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "joint-v1 共同创作规划",
    angle: "一条规划链完成构思与导演",
    audience: "内容创作者",
    nicheSlug: "joint-planning",
    durationSeconds: 24,
    durationRange: { minSeconds: 20, maxSeconds: 34 },
    platform: "douyin",
    runPurpose: "test",
    reviewMode: "manual",
    providers: {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
      assets: overrides.assetSemanticRank ? "ai-shot-router-v1" : "local-editorial-v1",
      voice: "macos-say-v1",
      render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1",
    },
    workflowFeatures: {
      assetSemanticRank: overrides.assetSemanticRank ?? false,
      referenceGrammar: overrides.referenceGrammar ?? false,
      executablePlan: true,
      creativePlanning: "joint-v1",
    },
    ...(overrides.referenceVideo ? { referenceVideo: overrides.referenceVideo } : {}),
    director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  };
}

describe("ProductionPipeline joint-v1 creative planning", () => {
  it("runs a single joint creative-planning stage instead of the four legacy planning nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-v1-"));
    const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      ...jointPlanningAgents(spies),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });

    const run = await subject.start(jointBriefBase());
    const nodeIds = run.nodeRuns.map((node) => node.nodeId);

    // 互斥拓扑：joint-v1 不创建外层 script/visual-direction/asset-candidates/asset-semantic-rank/
    // production-preflight，只有一条 creative-planning 规划链。
    assert.ok(!nodeIds.includes("script"), `joint-v1 must not run the legacy script node: ${nodeIds.join(",")}`);
    assert.ok(!nodeIds.includes("visual-direction"), `joint-v1 must not run the legacy visual-direction node: ${nodeIds.join(",")}`);
    assert.ok(!nodeIds.includes("production-preflight"), `joint-v1 must not run a duplicate preflight node: ${nodeIds.join(",")}`);
    assert.ok(nodeIds.includes("creative-planning"), `joint-v1 must run the creative-planning node: ${nodeIds.join(",")}`);
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    // joint-v1 有自己的工作流版本：恢复与审计据此区分新旧拓扑。
    assert.equal(run.workflowVersion, "1.6.1");

    // 无图库固定路线：构思→稿件→导演→编译，搜索与排序调用 0 次。
    assert.equal(spies.treatmentCalls, 1);
    assert.equal(spies.screenwriterCalls, 1);
    assert.equal(spies.directorCalls, 1);
    assert.equal(spies.rankCalls, 0);

    const planning = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
    const planningOutput = planning?.output as {
      scriptPath?: string; directorPlanPath?: string; executablePlanPath?: string;
      candidateSearchPath?: string; candidateRankingPath?: string;
    } | undefined;
    // 下游只消费 creative-planning 正式 paths；无图库候选路径不得伪造，必需路径缺失必须拒绝。
    assert.ok(planningOutput?.scriptPath, "joint-v1 planning must expose a scriptPath");
    assert.ok(planningOutput?.directorPlanPath, "joint-v1 planning must expose a directorPlanPath");
    assert.ok(planningOutput?.executablePlanPath, "joint-v1 planning must expose an executablePlanPath");
    assert.equal(planningOutput?.candidateSearchPath, undefined);
    assert.equal(planningOutput?.candidateRankingPath, undefined);
    for (const planningPath of [planningOutput?.scriptPath, planningOutput?.directorPlanPath, planningOutput?.executablePlanPath]) {
      assert.equal((await stat(planningPath!)).isFile(), true);
    }
    // NodeRun 不直接暴露 input：与旧拓扑断言一致，读取 inputState 的首个（系统生成）版本值。
    const assetsInput = run.nodeRuns.find((node) => node.nodeId === "assets")?.inputState?.versions[0]?.value as {
      scriptPath?: string; directorPlanPath?: string; executablePlanPath?: string;
      candidateRankingPath?: string; candidateInventoryPath?: string;
    } | undefined;
    assert.equal(assetsInput?.scriptPath, planningOutput?.scriptPath);
    assert.equal(assetsInput?.directorPlanPath, planningOutput?.directorPlanPath);
    assert.equal(assetsInput?.executablePlanPath, planningOutput?.executablePlanPath);
    assert.equal(assetsInput?.candidateRankingPath, undefined);
    assert.equal(assetsInput?.candidateInventoryPath, undefined);
    const voiceInput = run.nodeRuns.find((node) => node.nodeId === "voice")?.inputState?.versions[0]?.value as { scriptPath?: string; executablePlanPath?: string } | undefined;
    assert.equal(voiceInput?.scriptPath, planningOutput?.scriptPath);
    assert.equal(voiceInput?.executablePlanPath, planningOutput?.executablePlanPath);
  });

  it("binds reference grammar to the brief instead of the script in joint-v1 runs", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-ref-"));
    const referenceRoot = path.join(workspaceRoot, "uploads", "reference-videos");
    const uploadId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const sourcePath = path.join(referenceRoot, uploadId, "source.mp4");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "reference-video");
    const referenceSha256 = createHash("sha256").update("reference-video").digest("hex");
    const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    let grammarAnalyzeCalls = 0;
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      referenceVideoRoot: referenceRoot,
      ...jointPlanningAgents(spies),
      referenceGrammarAgent: {
        id: "codex-reference-grammar-v1",
        modelId: "codex-default",
        analyze: async () => {
          grammarAnalyzeCalls += 1;
          return {
            version: "video-factory/shot-grammar-v1",
            summary: "短促开场后稳定解释",
            durationMs: 6_000,
            pacing: "前快后稳",
            composition: "先近景再中景",
            camera: "轻推后固定",
            color: "自然低饱和",
            transitions: "动作切换",
            sound: "环境声先行",
            beats: [],
            reusableRules: ["用动作建立开场"],
            avoidCopying: ["不复制人物、对白和情节"],
            confidence: 0.82,
          };
        },
      },
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });

    const run = await subject.start(jointBriefBase({ referenceGrammar: true, referenceVideo: {
      uploadId, label: "参考节奏.mp4", mimeType: "video/mp4", sizeBytes: 15, path: sourcePath, sha256: referenceSha256,
    } }));
    const nodeIds = run.nodeRuns.map((node) => node.nodeId);

    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    // joint-v1 拓扑：brief → reference-grammar → creative-planning；不存在 script 节点。
    assert.ok(!nodeIds.includes("script"), `joint-v1 reference runs must not depend on a script node: ${nodeIds.join(",")}`);
    assert.ok(nodeIds.indexOf("reference-grammar") < nodeIds.indexOf("creative-planning"));
    assert.equal(grammarAnalyzeCalls, 1);
    assert.equal(spies.treatmentCalls, 1);
    // 构思角色收到已接受的参考语法（风格/结构参考），不是只有稿件/导演收到。
    assert.deepEqual(spies.treatmentGrammarSeen, [true], "the treatment role must receive the accepted reference grammar");

    // 参考语法产物绑定 brief 与受控参考视频，不再挂到 script 产物下。
    const shotGrammar = run.artifacts.find((artifact) => artifact.kind === "shot_grammar");
    const referenceArtifact = run.artifacts.find((artifact) => artifact.kind === "reference_video");
    assert.ok(shotGrammar && referenceArtifact);
    assert.ok(
      shotGrammar.parentArtifactIds?.includes(referenceArtifact.id),
      `shot grammar must bind the controlled reference video artifact: ${JSON.stringify(shotGrammar.parentArtifactIds)}`,
    );
    const planning = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
    assert.equal(planning?.status, "succeeded");
  });

  it("adapts worker candidate search and the real semantic ranker into the planning graph", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-rank-"));
    const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const worker = new JointLibraryWorker();
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker,
      ...jointPlanningAgents(spies),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });

    const run = await subject.start(jointBriefBase({ assetSemanticRank: true }));
    const nodeIds = run.nodeRuns.map((node) => node.nodeId);

    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    // 图库路线在图内完成候选/排序/整合，不再创建外层候选与排序节点。
    assert.ok(!nodeIds.includes("asset-candidates"), `joint-v1 must not run the legacy asset-candidates node: ${nodeIds.join(",")}`);
    assert.ok(!nodeIds.includes("asset-semantic-rank"), `joint-v1 must not run the legacy asset-semantic-rank node: ${nodeIds.join(",")}`);
    assert.ok(nodeIds.includes("creative-planning"));

    // 真实 rank adapter 合同：rankDetailed(report, checkpoint) 收到完整 AssetCandidateReport。
    assert.equal(spies.rankCalls, 1);
    assert.deepEqual(spies.rankedReports, [{ version: "video-factory/asset-candidates-v1", sceneCount: 3 }]);
    assert.equal(worker.searchCalls.length, 1);

    const planningOutput = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.output as {
      scriptPath?: string; directorPlanPath?: string; executablePlanPath?: string;
      candidateSearchPath?: string; candidateRankingPath?: string; candidateInventoryPath?: string;
    } | undefined;
    // 图库路线的候选与排序正式 paths 存在，且下游 assets 消费同一来源。
    assert.ok(planningOutput?.candidateSearchPath, "joint-v1 library planning must expose candidateSearchPath");
    assert.ok(planningOutput?.candidateRankingPath, "joint-v1 library planning must expose candidateRankingPath");
    // 私有库存与公开报告是不同文件、不同内容：下游物化消费库存本身，不得用公开报告顶替。
    assert.ok(planningOutput?.candidateInventoryPath, "joint-v1 library planning must expose the private candidateInventoryPath");
    assert.notEqual(
      planningOutput.candidateInventoryPath,
      planningOutput.candidateSearchPath,
      "the private inventory must not alias the public candidate report",
    );
    const assetsInput = run.nodeRuns.find((node) => node.nodeId === "assets")?.inputState?.versions[0]?.value as {
      candidateRankingPath?: string; candidateInventoryPath?: string;
    } | undefined;
    assert.equal(assetsInput?.candidateRankingPath, planningOutput?.candidateRankingPath);
    assert.equal(assetsInput?.candidateInventoryPath, planningOutput?.candidateInventoryPath, "materialization must consume the private inventory, not the report");
    const inventoryRaw = await readFile(planningOutput.candidateInventoryPath, "utf8");
    const inventory = JSON.parse(inventoryRaw) as Record<string, unknown>;
    const report = JSON.parse(await readFile(planningOutput!.candidateSearchPath!, "utf8")) as { scenes: Array<{ scenePosition: number }> };
    assert.deepEqual(report.scenes.map((scene) => scene.scenePosition), [1, 2, 3]);
    assert.notEqual(
      JSON.stringify(inventory),
      JSON.stringify(report),
      "the private inventory must carry worker-private materialization data, not the public report content",
    );
    assert.ok(Array.isArray(inventory.items), "the private inventory must keep the worker-private materialization shape");
  });

  it("recovers both joint-v1 crash windows idempotently", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-crash-"));
    const brief = jointBriefBase();
    const runId = "run-joint-crash-window";
    // 计数器保证产物 id 唯一：commit/产物身份断言依赖 id 可精确寻址。
    let nextId = 1;
    const idFactory = (prefix: string) => (prefix === "run" ? runId : `${prefix}-joint-crash-${nextId++}`);
    // 显式注解保留窄字面量类型（deliveryTypes 否则被拓宽为 string[]）。
    const jointAssetProviders: VisualAssetProviderCapability[] = [
      { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
      { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
    ];

    // 窗口 (a)：图已完成、正式 artifact 尚未登记时崩溃（同 thread 的 SQLite checkpoint 已终态）。
    const crashedSpies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const crashed = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      idFactory,
      ...jointPlanningAgents(crashedSpies),
      planningFailpoints: { afterGraph: () => { throw new Error("simulated crash after graph completion"); } },
      assetProviders: jointAssetProviders,
    });
    const crashedRun = await crashed.start(brief);
    assert.equal(crashedRun.status, "failed");
    assert.equal(crashedRun.nodeRuns.find((node) => node.nodeId === "creative-planning")?.status, "failed");
    assert.equal(crashedSpies.treatmentCalls, 1, "the graph itself must have completed once before the crash");
    // 崩溃点在登记之前：全局产物不含任何 creative-planning 正式产物。
    assert.equal(crashedRun.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning").length, 0);

    // 恢复：同 runId 同 brief → 同 inputDigest → 同 thread。全新角色替身必须保持 0 次调用：
    // 恢复只登记正式产物，不重跑任何创作角色。
    const resumedSpies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const resumer = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      idFactory,
      ...jointPlanningAgents(resumedSpies),
      assetProviders: jointAssetProviders,
    });
    const resumedRun = await resumer.retryFailedNode(runId, "creative-planning");
    assert.equal(resumedRun.status, "needs_human", JSON.stringify(resumedRun.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(resumedSpies.treatmentCalls, 0, "crash window (a) recovery must not re-run the treatment role");
    assert.equal(resumedSpies.screenwriterCalls, 0, "crash window (a) recovery must not re-run the screenwriter role");
    assert.equal(resumedSpies.directorCalls, 0, "crash window (a) recovery must not re-run the director role");
    await assertSingleJointPlanningCommit({ workspaceRoot, runId, run: resumedRun, libraryRoute: false });

    // 窗口 (b)：正式产物已登记、commit 结束标记尚未写时崩溃。
    const runIdB = "run-joint-crash-window-b";
    let nextIdB = 1;
    const idFactoryB = (prefix: string) => (prefix === "run" ? runIdB : `${prefix}-joint-crash-b-${nextIdB++}`);
    const crashedB = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      idFactory: idFactoryB,
      ...jointPlanningAgents({ treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] }),
      planningFailpoints: { afterArtifacts: () => { throw new Error("simulated crash after artifact write"); } },
      assetProviders: jointAssetProviders,
    });
    const crashedRunB = await crashedB.start(brief);
    assert.equal(crashedRunB.status, "failed");
    // 崩溃点在全部正式产物登记之后、commit 写入之前：全部正式产物（含 treatment）已在全局产物中。
    const crashedPlanningArtifacts = crashedRunB.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning");
    assert.deepEqual(
      crashedPlanningArtifacts.map((artifact) => artifact.kind).sort(),
      ["creative_treatment", "executable_plan", "script", "storyboard"],
      "the window (b) crash must happen after every formal planning artifact is registered",
    );
    const resumedSpiesB: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const resumerB = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      idFactory: idFactoryB,
      ...jointPlanningAgents(resumedSpiesB),
      assetProviders: jointAssetProviders,
    });
    const resumedRunB = await resumerB.retryFailedNode(runIdB, "creative-planning");
    assert.equal(resumedRunB.status, "needs_human", JSON.stringify(resumedRunB.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(resumedSpiesB.treatmentCalls, 0, "crash window (b) recovery must not re-run the treatment role");
    assert.equal(resumedSpiesB.screenwriterCalls, 0, "crash window (b) recovery must not re-run the screenwriter role");
    assert.equal(resumedSpiesB.directorCalls, 0, "crash window (b) recovery must not re-run the director role");
    const committedWindowB = await assertSingleJointPlanningCommit({ workspaceRoot, runId: runIdB, run: resumedRunB, libraryRoute: false });
    // 恢复复用崩溃前登记的同一批产物：artifact 身份不变，不重复登记。
    assert.deepEqual(
      committedWindowB.artifacts.map((entry) => entry.artifactId).sort(),
      crashedPlanningArtifacts.map((artifact) => artifact.id).sort(),
      "window (b) recovery must reuse the exact artifacts registered before the crash",
    );
    // 恢复输出使用被复用产物的真实路径（崩溃前的 attempt 目录），不在恢复 attempt 下重建第二套正式文件。
    const resumedExecutablePlanPath = committedWindowB.artifacts.find((entry) => entry.kind === "executable_plan")?.path;
    assert.ok(resumedExecutablePlanPath);
    assert.match(resumedExecutablePlanPath, /attempt-1[/\\]executable_plan\.json$/);
    await assert.rejects(
      stat(path.join(workspaceRoot, "runs", runIdB, "nodes", "creative-planning", "attempt-2", "executable_plan.json")),
      /ENOENT/,
      "recovery must not write a second formal executable plan under its own attempt directory",
    );
  });

  it("fails joint-v1 planning explicitly without falling back to the legacy flow", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-fail-"));
    const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      ...jointPlanningAgents(spies, { treatment: true }),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });

    const run = await subject.start(jointBriefBase());
    const nodeIds = run.nodeRuns.map((node) => node.nodeId);

    // 新图失败必须明确失败：不静默切回旧规划流程（不创建 script/visual-direction 等旧节点）。
    assert.equal(run.status, "failed");
    const planningNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning");
    assert.equal(planningNode?.status, "failed");
    assert.match(planningNode?.error ?? "", /构思审计失败/);
    assert.ok(!nodeIds.includes("script"), `failed joint-v1 must not fall back to the legacy script node: ${nodeIds.join(",")}`);
    assert.ok(!nodeIds.includes("visual-direction"), `failed joint-v1 must not fall back to the legacy visual-direction node: ${nodeIds.join(",")}`);
    assert.equal(spies.treatmentCalls, 1);
    assert.equal(spies.screenwriterCalls, 0, "planning must stop at the failing treatment role");
    assert.equal(run.workflowVersion, "1.6.1");
  });

  it("recovers the joint-v1 library crash window without repeating search or ranking", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-lib-crash-"));
    const brief = jointBriefBase({ assetSemanticRank: true });
    const runId = "run-joint-lib-crash";
    let nextId = 1;
    const idFactory = (prefix: string) => (prefix === "run" ? runId : `${prefix}-joint-lib-crash-${nextId++}`);
    // 显式注解保留窄字面量类型（deliveryTypes 否则被拓宽为 string[]）。
    const jointAssetProviders: VisualAssetProviderCapability[] = [
      { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
      { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
    ];

    // 图库路线的窗口 (a)：图内搜索/排序已完成、五类正式 artifact 尚未登记时崩溃。
    const crashWorker = new JointLibraryWorker();
    const crashedSpies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const crashed = new ProductionPipeline({
      workspaceRoot,
      worker: crashWorker,
      idFactory,
      ...jointPlanningAgents(crashedSpies),
      planningFailpoints: { afterGraph: () => { throw new Error("simulated crash after graph completion"); } },
      assetProviders: jointAssetProviders,
    });
    const crashedRun = await crashed.start(brief);
    assert.equal(crashedRun.status, "failed");
    assert.equal(crashWorker.searchCalls.length, 1, "the graph must have run its candidate search once before the crash");
    assert.equal(crashedSpies.rankCalls, 1);
    assert.equal(crashedRun.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning").length, 0);

    // 恢复：搜索、排序与三个创作角色全部 0 次新增，五类正式产物各登记恰一次并落 commit。
    const resumeWorker = new JointLibraryWorker();
    const resumedSpies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const resumer = new ProductionPipeline({
      workspaceRoot,
      worker: resumeWorker,
      idFactory,
      ...jointPlanningAgents(resumedSpies),
      assetProviders: jointAssetProviders,
    });
    const resumedRun = await resumer.retryFailedNode(runId, "creative-planning");
    assert.equal(resumedRun.status, "needs_human", JSON.stringify(resumedRun.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(resumeWorker.searchCalls.length, 0, "library crash recovery must not repeat the candidate search");
    assert.equal(resumedSpies.rankCalls, 0, "library crash recovery must not repeat the semantic ranking");
    assert.equal(resumedSpies.treatmentCalls, 0);
    assert.equal(resumedSpies.screenwriterCalls, 0);
    assert.equal(resumedSpies.directorCalls, 0);
    await assertSingleJointPlanningCommit({ workspaceRoot, runId, run: resumedRun, libraryRoute: true });
  });

  it("fails closed when a joint-v1 planning commit is tampered with, incomplete, or conflicting", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-commit-guard-"));
    const brief = jointBriefBase();
    // 显式注解保留窄字面量类型（deliveryTypes 否则被拓宽为 string[]）。
    const jointAssetProviders: VisualAssetProviderCapability[] = [
      { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
      { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
    ];
    // 每个变体独立成 run：篡改 commit 或产物文件后原样触发重执行（同 digest → 同 key），
    // 恢复必须拒绝复用被篡改的 commit，而不是静默登记或重建。
    type CommitMutation = (options: {
      commit: JointPlanningCommitFixture;
      run: JointRunLike;
      commitPath: string;
      runJsonPath: string;
    }) => Promise<void>;
    const writeCommitBack = async (commitPath: string, commit: JointPlanningCommitFixture) => {
      await writeFile(commitPath, `${JSON.stringify(commit, null, 2)}\n`);
    };
    const mutations: Array<{ name: string; mutate: CommitMutation }> = [
      {
        name: "tampered commit sha256",
        mutate: async ({ commit, commitPath }) => {
          commit.artifacts[0]!.sha256 = "0".repeat(64);
          await writeCommitBack(commitPath, commit);
        },
      },
      {
        name: "mismatched input digest",
        mutate: async ({ commit, commitPath }) => {
          commit.inputDigest = "f".repeat(64);
          await writeCommitBack(commitPath, commit);
        },
      },
      {
        name: "foreign artifact owner",
        mutate: async ({ commit, run, commitPath }) => {
          const foreign = run.artifacts.find((artifact) => artifact.producer?.nodeId === "brief");
          assert.ok(foreign, "the run must hold a brief-owned artifact for the foreign-owner variant");
          commit.artifacts[0]!.artifactId = foreign.id;
          await writeCommitBack(commitPath, commit);
        },
      },
      {
        name: "unknown artifact id",
        mutate: async ({ commit, commitPath }) => {
          commit.artifacts[0]!.artifactId = "artifact-does-not-exist";
          await writeCommitBack(commitPath, commit);
        },
      },
      {
        name: "duplicated kind entry",
        mutate: async ({ commit, commitPath }) => {
          commit.artifacts[1]!.kind = commit.artifacts[0]!.kind;
          await writeCommitBack(commitPath, commit);
        },
      },
      {
        name: "missing committed file",
        mutate: async ({ commit }) => {
          await rm(commit.artifacts[0]!.path);
        },
      },
      {
        name: "tampered artifact file",
        mutate: async ({ commit }) => {
          await writeFile(commit.artifacts[0]!.path, "{}\n");
        },
      },
      {
        // 同一 artifactId 在持久化 run 中出现两份身份记录：恢复不得静默取第一个，
        // 必须按"commit 与 run artifact 一一对应"明确失败。
        name: "duplicated artifact identity",
        mutate: async ({ commit, runJsonPath }) => {
          const entry = commit.artifacts[0]!;
          const runPayload = JSON.parse(await readFile(runJsonPath, "utf8")) as {
            artifacts: Array<{ id: string }>;
          };
          const artifact = runPayload.artifacts.find((candidate) => candidate.id === entry.artifactId);
          assert.ok(artifact, "the duplicate-identity variant must target a committed artifact");
          runPayload.artifacts.push({ ...artifact });
          await writeFile(runJsonPath, `${JSON.stringify(runPayload, null, 2)}\n`);
        },
      },
      {
        // 词法前缀在 runRoot 之下、resolve 后越界的路径：uri 与 sha256 同步保持一致，
        // 唯一的差异就是穿越本身——恢复必须按 resolve 后的位置拒绝，不得读 run 目录外文件。
        name: "escaped artifact path",
        mutate: async ({ commit, commitPath, runJsonPath }) => {
          const entry = commit.artifacts[0]!;
          const runRoot = path.dirname(runJsonPath);
          const escapedPath = `${runRoot}${path.sep}..${path.sep}joint-escaped-${path.basename(runRoot)}.json`;
          const escapedContent = `${JSON.stringify({ escaped: true }, null, 2)}\n`;
          await writeFile(escapedPath, escapedContent);
          entry.path = escapedPath;
          entry.sha256 = createHash("sha256").update(escapedContent).digest("hex");
          await writeCommitBack(commitPath, commit);
          const runPayload = JSON.parse(await readFile(runJsonPath, "utf8")) as {
            artifacts: Array<{ id: string; uri?: string }>;
          };
          const artifact = runPayload.artifacts.find((candidate) => candidate.id === entry.artifactId);
          assert.ok(artifact, "the escaped-path variant must target a committed artifact");
          artifact.uri = escapedPath;
          await writeFile(runJsonPath, `${JSON.stringify(runPayload, null, 2)}\n`);
        },
      },
    ];

    for (const [index, variant] of mutations.entries()) {
      const runId = `run-joint-commit-guard-${index}`;
      let nextId = 1;
      const idFactory = (prefix: string) => (prefix === "run" ? runId : `${prefix}-commit-guard-${nextId++}`);
      const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
      const subject = new ProductionPipeline({
        workspaceRoot,
        worker: new ReferenceWorker(),
        idFactory,
        ...jointPlanningAgents(spies),
        assetProviders: jointAssetProviders,
      });
      const run = await subject.start(brief);
      assert.equal(run.status, "needs_human", `[${variant.name}] ${JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error })))}`);
      const planningInputState = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.inputState;
      const originalInput = planningInputState?.versions
        .find((version) => version.id === planningInputState.effectiveVersionId)?.value;
      assert.ok(originalInput, `[${variant.name}] the planning input version must exist`);
      const commitsDir = path.join(workspaceRoot, "runs", runId, "planning", "commits");
      const commitFiles = (await readdir(commitsDir)).filter((name) => name.endsWith(".json"));
      assert.equal(commitFiles.length, 1, `[${variant.name}] a successful run must leave exactly one planning commit`);
      const commitPath = path.join(commitsDir, commitFiles[0]!);
      const commit = JSON.parse(await readFile(commitPath, "utf8")) as JointPlanningCommitFixture;
      await variant.mutate({ commit, run, commitPath, runJsonPath: path.join(workspaceRoot, "runs", runId, "run.json") });

      // 原样回传派生输入（digest 不变 → 同一 commit key），恢复必须拒绝被篡改的 commit。
      const current = await subject.loadPersisted(runId);
      const planningState = current.nodeRuns.find((node) => node.nodeId === "creative-planning")?.inputState;
      await subject.applyNodeInputOverride(runId, {
        nodeId: "creative-planning",
        actor: "producer",
        expectedRunRevision: current.revision,
        expectedVersionId: planningState?.effectiveVersionId ?? "",
        input: originalInput,
        allowTerminalEdit: true,
      });
      const rerun = await subject.resumeStale(runId);
      const planning = rerun.nodeRuns.find((node) => node.nodeId === "creative-planning");
      // BG-02 语义：commit 中引用的产物若已丢失（部分持久化）或完全未登记，恢复分支
      // 可以按重放内容续齐/重写同一 commit（与 registeredCount===0 的 orphan 修复一致）；
      // 但内容/sha/种类损坏必须仍 fail closed。"unknown artifact id" 属前者——
      // 重写后的 commit 必须通过严格校验且角色不重跑。
      if (variant.name === "unknown artifact id") {
        assert.equal(rerun.status, "needs_human", `[${variant.name}] a repairable commit-reference loss must recover without role replay`);
        assert.equal(spies.treatmentCalls, 1, `[${variant.name}] recovery must not replay creative roles`);
        const repairedCommit = JSON.parse(await readFile(commitPath, "utf8")) as JointPlanningCommitFixture;
        const repairedIds = repairedCommit.artifacts.map((entry) => entry.artifactId).sort();
        const registeredIds = rerun.artifacts
          .filter((artifact) => artifact.producer?.nodeId === "creative-planning")
          .map((artifact) => artifact.id);
        for (const id of repairedIds) {
          assert.ok(registeredIds.includes(id), `[${variant.name}] repaired commit must only reference registered planning artifacts (${id})`);
        }
        continue;
      }
      assert.equal(rerun.status, "failed", `[${variant.name}] a damaged planning commit must fail the run closed`);
      assert.equal(planning?.status, "failed", `[${variant.name}] the planning node must fail closed`);
      assert.match(planning?.error ?? "", /planning commit/i, `[${variant.name}] the failure must point at the planning commit`);
      assert.equal(spies.treatmentCalls, 1, `[${variant.name}] fail-closed validation must precede any role replay`);
    }
  });

  it("does not reuse a joint-v1 planning commit after the input digest changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-joint-digest-"));
    const brief = jointBriefBase();
    const runId = "run-joint-digest-change";
    let nextId = 1;
    const idFactory = (prefix: string) => (prefix === "run" ? runId : `${prefix}-joint-digest-${nextId++}`);
    const spies: JointPlanningSpies = { treatmentCalls: 0, treatmentGrammarSeen: [], screenwriterCalls: 0, directorCalls: 0, rankCalls: 0, rankedReports: [] };
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      idFactory,
      ...jointPlanningAgents(spies),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });
    const run = await subject.start(brief);
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const firstCommit = await assertSingleJointPlanningCommit({ workspaceRoot, runId, run, libraryRoute: false });

    // 改 brief 输出（title 参与 inputDigest）→ 新 digest → 新 commit key：不得复用旧 commit 或旧产物路径。
    const briefOutput = run.nodeRuns.find((node) => node.nodeId === "brief")?.output as ProductionBrief;
    assert.ok(briefOutput);
    await subject.applyNodeOverride(runId, {
      nodeId: "brief",
      actor: "producer",
      output: { ...briefOutput, title: "改题后的共同创作规划" },
      allowTerminalEdit: true,
    });
    const rerun = await subject.resumeStale(runId);
    assert.equal(rerun.status, "needs_human", JSON.stringify(rerun.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentCalls, 2, "a changed digest must re-run the planning roles exactly once more");
    assert.equal(spies.screenwriterCalls, 2);
    assert.equal(spies.directorCalls, 2);

    const commitsDir = path.join(workspaceRoot, "runs", runId, "planning", "commits");
    const commitFiles = (await readdir(commitsDir)).filter((name) => name.endsWith(".json"));
    assert.equal(commitFiles.length, 2, "the changed digest must produce a second commit instead of reusing the first");
    const commits = await Promise.all(commitFiles.map(async (name) =>
      JSON.parse(await readFile(path.join(commitsDir, name), "utf8")) as JointPlanningCommitFixture));
    const secondCommit = commits.find((commit) => commit.planningCommitKey !== firstCommit.planningCommitKey);
    assert.ok(secondCommit);
    assert.notEqual(secondCommit.inputDigest, firstCommit.inputDigest, "the two commits must bind different input digests");
    // 新 commit 指向新的正式产物路径（恢复 attempt），旧 commit 保留原路径。
    const firstPlanPath = firstCommit.artifacts.find((entry) => entry.kind === "executable_plan")!.path;
    const secondPlanPath = secondCommit.artifacts.find((entry) => entry.kind === "executable_plan")!.path;
    assert.match(firstPlanPath, /attempt-1[/\\]executable_plan\.json$/);
    assert.match(secondPlanPath, /attempt-2[/\\]executable_plan\.json$/);
    // 新的 output version 精确拥有第二组 commit 产物，不携带旧 attempt 的产物。
    const planningState = rerun.nodeRuns.find((node) => node.nodeId === "creative-planning")?.outputState;
    const effectiveVersion = planningState?.versions?.find((version) => version.id === planningState?.effectiveVersionId);
    assert.ok(effectiveVersion, "the regenerated planning output version must exist");
    assert.deepEqual(
      [...effectiveVersion.artifactIds ?? []].sort(),
      secondCommit.artifacts.map((entry) => entry.artifactId).sort(),
      "the regenerated output version must own exactly the new committed artifacts",
    );
  });
});

// ---------------------------------------------------------------------------
// joint-v1 planning commit 夹具：验证恢复后的 commit 文件与 run 内正式产物一一对应。
// 只断言行为合同（唯一性、身份、producer、路径受控、sha256、output version 归属），
// 不绑定实现内部字段之外的新约定。
// ---------------------------------------------------------------------------
interface JointPlanningCommitEntry {
  kind: string;
  artifactId: string;
  path: string;
  sha256: string;
}

interface JointPlanningCommitFixture {
  version: string;
  runId: string;
  planningCommitKey: string;
  inputDigest: string;
  artifacts: JointPlanningCommitEntry[];
}

// 宽松结构类型：接受 WorkflowRun<ProductionBrief> 而不引入对其完整类型的依赖。
interface JointRunLike {
  artifacts: ReadonlyArray<{ id: string; kind: string; uri?: string; producer?: { nodeId?: string } }>;
  nodeRuns: ReadonlyArray<{
    nodeId: string;
    status: string;
    error?: string;
    outputState?: {
      effectiveVersionId?: string;
      versions?: ReadonlyArray<{ id: string; artifactIds?: readonly string[] }>;
    };
  }>;
}

async function assertSingleJointPlanningCommit(options: {
  workspaceRoot: string;
  runId: string;
  run: JointRunLike;
  libraryRoute: boolean;
}): Promise<JointPlanningCommitFixture> {
  const commitsDir = path.join(options.workspaceRoot, "runs", options.runId, "planning", "commits");
  const directoryEntries = await readdir(commitsDir);
  const commitFiles = directoryEntries.filter((name) => name.endsWith(".json"));
  assert.equal(commitFiles.length, 1, `expected exactly one joint planning commit: ${commitFiles.join(",")}`);
  assert.deepEqual(
    directoryEntries.filter((name) => !name.endsWith(".json")),
    [],
    "atomic commit writes must not leave temporary files behind",
  );
  const commit = JSON.parse(await readFile(path.join(commitsDir, commitFiles[0]!), "utf8")) as JointPlanningCommitFixture;
  assert.equal(commit.version, "video-factory/planning-commit-v1");
  assert.equal(commit.runId, options.runId);
  assert.equal(commit.planningCommitKey, commitFiles[0]!.replace(/\.json$/, ""));
  assert.ok(typeof commit.inputDigest === "string" && commit.inputDigest.length > 0);
  const expectedKinds = options.libraryRoute
    ? ["asset_candidates", "asset_ranking", "creative_treatment", "executable_plan", "script", "storyboard"]
    : ["creative_treatment", "executable_plan", "script", "storyboard"];
  assert.deepEqual([...commit.artifacts].map((entry) => entry.kind).sort(), expectedKinds);
  const runDirectory = path.join(options.workspaceRoot, "runs", options.runId);
  for (const entry of commit.artifacts) {
    const matches = options.run.artifacts.filter((artifact) => artifact.id === entry.artifactId);
    assert.equal(matches.length, 1, `commit entry ${entry.kind} must reference exactly one run artifact`);
    const artifact = matches[0]!;
    assert.equal(artifact.kind, entry.kind);
    assert.equal(artifact.producer?.nodeId, "creative-planning");
    assert.equal(artifact.uri, entry.path);
    assert.ok(entry.path.startsWith(`${runDirectory}${path.sep}`), "committed paths must stay inside the run directory");
    const content = await readFile(entry.path);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      entry.sha256,
      `committed ${entry.kind} content must match its sha256`,
    );
  }
  for (const kind of expectedKinds) {
    assert.equal(
      options.run.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning" && artifact.kind === kind).length,
      1,
      `the run must hold exactly one formal ${kind} artifact`,
    );
  }
  const planning = options.run.nodeRuns.find((node) => node.nodeId === "creative-planning");
  assert.ok(planning, "the run must contain the creative-planning node");
  assert.equal(planning.status, "succeeded");
  const version = planning.outputState?.versions
    ?.find((candidate) => candidate.id === planning.outputState?.effectiveVersionId);
  assert.ok(version, "the planning output version must exist");
  assert.deepEqual(
    [...version.artifactIds ?? []].sort(),
    commit.artifacts.map((entry) => entry.artifactId).sort(),
    "the current planning output version must own exactly the committed artifacts",
  );
  return commit;
}
