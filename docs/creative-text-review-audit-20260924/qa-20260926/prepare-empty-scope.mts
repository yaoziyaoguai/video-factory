// QA③去标识化历史样例。只调用公开 Pipeline / Studio 接口，不写 run.json。
// 源样例采用旧版无创作停点拓扑；媒体 worker 在任何物化前拒绝，不伪造成片。
// 子样例刻意带入旧版本曾允许的空返工范围，所有后续人工确认都在浏览器完成。
import assert from "node:assert/strict";
import { ProductionPipeline } from "/Users/jinkun.wang/work_space/veidofactory/packages/production-pipeline/dist/index.js";
import { ProductionStudio } from "/Users/jinkun.wang/work_space/veidofactory/apps/studio/src/server/production-studio.ts";

const workspaceRoot = "/tmp/vf-qa/studio-workspace";
const script = {
  viewerPromise: "七步核对后再分享", narrativeArc: "逐步核对", canonFacts: [],
  scenes: [1, 2, 3, 4, 5, 6, 7].map((position) => ({
    position, narration: `第${position}步，仔细核对。`, duration: position <= 4 ? 3 : 4,
    visual_strategy: "local", visual_prompt: `旧方案第${position}步核对卡片`, search_terms: [`核对 ${position}`],
  })),
};
const treatment = {
  version: "video-factory/creative-treatment-v2", viewerPromise: script.viewerPromise,
  hook: { narrationIntent: "分享前先核对", visualIntent: "步骤卡片" },
  progression: [1, 2, 3].map((i) => ({ beatId: `b${i}`, purpose: "逐步核对", viewerGain: "掌握方法" })),
  payoff: "分享前完成核对", visualPrinciples: ["信息卡"], soundPrinciples: ["清晰旁白"],
  evidenceRequirements: [], feasibilityQuestions: [],
};
const trace = (taskKind: string) => ({ taskKind, promptVersion: "qa-scope-v1", prompt: "去标识化受控样例", providerId: "controlled-fixture", modelId: "deepseek-flash" });
const workerCalls: string[] = [];
const pipeline = new ProductionPipeline({
  workspaceRoot,
  worker: { async run(request) {
    workerCalls.push(request.capability);
    throw new Error("受控历史样例：在媒体物化前停止，未请求任何素材、配音或渲染。");
  } },
  treatmentAgents: [{ providerId: "controlled-fixture", agent: {
    id: "codex-creative-treatment-v1", modelId: "deepseek-flash",
    treat: async () => treatment, treatDetailed: async () => ({ output: treatment, trace: trace("creative-treatment") }),
  } }],
  screenwriterAgent: {
    id: "codex-screenwriter-v1", modelId: "deepseek-flash",
    draft: async () => script, draftDetailed: async () => ({ output: script, trace: trace("script-draft") }),
  },
  directorAgent: {
    id: "api-visual-director-v1", modelId: "deepseek-flash",
    plan: async (input) => ({
      version: "video-factory/director-plan-v1", requestedProfileId: input.brief.requestedProfileId,
      resolvedProfileId: "documentary-observer", profileRationale: "受控历史样例",
      visualBible: { narrativeApproach: "逐步解释", pacing: "均匀", composition: "中景", camera: "固定", color: "自然", continuity: "统一", sound: "自然" },
      shots: input.scenes.map((scene) => ({
        scenePosition: scene.position, narrativeRole: "解释", authenticityPolicy: "illustrative",
        preferredProviderId: "local-editorial-v1", deliveryType: "editorial_card", alternativeProviderIds: [],
        temporalBeats: [`[0s-${scene.duration}s] 展示核对卡片`],
        query: `核对 ${scene.position}`, generationPrompt: `旧方案第${scene.position}步核对卡片`,
        rationale: "本地说明卡", continuityNote: "统一配色", confidence: 0.9, estimatedCostCny: 0,
      })),
    }),
  },
  assetProviders: [{ id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] }],
});
const source = await pipeline.start({
  protocolVersion: "video-factory/brief-v1", title: "QA③空范围历史样例（七镜，无媒体）",
  angle: "验证旧范围不被新稿绕过", audience: "本地测试", nicheSlug: "qa-scope", platform: "douyin",
  durationSeconds: 24, durationRange: { minSeconds: 20, maxSeconds: 34 }, runPurpose: "test", reviewMode: "manual",
  providers: { script: "codex-screenwriter-v1", director: "api-visual-director-v1", assets: "local-editorial-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
  workflowFeatures: { creativePlanning: "joint-v1", executablePlan: true, assetSemanticRank: false, referenceGrammar: false },
  director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
  economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
  voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
});
assert.equal(source.status, "failed");
assert.equal(source.nodeRuns.find(n => n.nodeId === "creative-planning")?.status, "succeeded");
assert.deepEqual(workerCalls, ["asset.prepare"]);
assert.equal(source.artifacts.some(a => a.contentType?.startsWith("video/") || a.contentType?.startsWith("audio/")), false);
const studio = new ProductionStudio({ workspaceRoot, pipeline,
  archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [],
});
const draft = await studio.reworkDraft(source.id);
assert.ok(draft?.input.rework?.previousScript);
assert.ok(draft.input.rework.previousDirectorPlan);
assert.equal(draft.input.rework.previousScript.scenes.length, 7);
const child = await pipeline.start({ ...draft.input, rework: { ...draft.input.rework, affectedScenePositions: [],
  nodeInstructions: { ...draft.input.rework.nodeInstructions, script: "提出更紧凑的候选方案，但用户尚未扩大任何返工范围。" },
} });
assert.equal(child.status, "needs_human");
assert.equal(child.nodeRuns.find(n => n.status === "needs_human")?.nodeId, "brief");
console.log(JSON.stringify({ sourceRunId: source.id, runId: child.id, status: child.status,
  sourceScenes: 7, approvedScenePositions: [], sourceWorkerCalls: workerCalls,
  sourceMediaRequests: 0, sourceMediaArtifacts: 0, preparation: "public APIs only; child confirmations still pending" }, null, 2));
