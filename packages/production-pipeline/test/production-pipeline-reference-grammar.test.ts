import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  type ReferenceGrammarAgentInput,
  type ProductionBrief,
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
    let failAnalysis = false;
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker: new ReferenceWorker(),
      referenceVideoRoot: referenceRoot,
      referenceGrammarAgent: {
        id: "codex-reference-grammar-v1",
        modelId: "codex-default",
        analyze: async (input) => {
          if (failAnalysis) throw new Error(`multimodal service unavailable at ${sourcePath}`);
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
    const finished = await subject.decide(run.id, { interventionId: intervention.id, action: "approve", actor: "producer" });
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

    failAnalysis = true;
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
  });
});
