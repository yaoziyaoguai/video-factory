import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  type ScriptDraft,
  type VisualDirectorAgent,
  type VisualReviewReport,
  type WorkerResponse,
} from "../src/index.js";

const scenes: ScriptDraft["scenes"] = [10, 10, 11.5].map((duration, index) => ({
  position: index + 1,
  narration: `第 ${index + 1} 段旁白`,
  duration,
  visual_strategy: "stock",
  visual_prompt: `第 ${index + 1} 段真实生活动作`,
  search_terms: [`生活动作 ${index + 1}`],
}));

const cleanVisualReport: VisualReviewReport = {
  version: "video-factory/visual-review-v1",
  summary: "当前范围内的画面证据可用。",
  scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 95 },
  findings: [],
  confidence: 0.95,
  recommendation: "approve",
};

class RecordingWorker {
  readonly requests: Array<{ capability: string; input: Record<string, unknown> }> = [];

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const input = request.input as Record<string, unknown>;
    const outputDir = String(request.outputDir);
    this.requests.push({ capability, input });
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": {
        voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"),
        trackPath: path.join(outputDir, "narration.m4a"),
      },
      "video.render": {
        videoPath: path.join(outputDir, "final.mp4"),
        renderManifestPath: path.join(outputDir, "render_manifest.json"),
      },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected fake capability: ${capability}`);
    const content = JSON.stringify({ capability });
    for (const [field, value] of Object.entries(output)) {
      if (typeof value !== "string") continue;
      if (field === "renderManifestPath") {
        const executablePlan = JSON.parse(await readFile(String(input.executablePlanPath), "utf8")) as {
          cuts: Array<{ scenePosition: number; frameCount: number }>;
        };
        await writeFile(value, JSON.stringify({
          slides: executablePlan.cuts.map((cut) => ({
            position: cut.scenePosition,
            duration: cut.frameCount / 30,
          })),
        }), "utf8");
      } else {
        await writeFile(value, content, "utf8");
      }
    }
    const primaryPath = String(Object.values(output)[0]);
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
          licenseNote: "Preflight integration fixture.",
        },
      }],
    };
  }
}

class VoiceConflictWorker extends RecordingWorker {
  private conflictReturned = false;
  constructor(private readonly grouped = false) { super(); }

  override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    if (request.capability !== "voice.synthesize" || this.conflictReturned) return super.run(request);
    this.conflictReturned = true;
    const capability = String(request.capability);
    const input = request.input as Record<string, unknown>;
    const outputDir = String(request.outputDir);
    this.requests.push({ capability, input });
    await mkdir(outputDir, { recursive: true });
    const rawPath = path.join(outputDir, "scene_01_raw.mp3");
    const content = "paid natural voice";
    await writeFile(rawPath, content, "utf8");
    const audioArtifact = {
      kind: "voiceover_raw",
      uri: rawPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content),
      contentType: "audio/mpeg",
      provenance: {
        providerId: "minimax-tts-v1",
        producerNodeId: "voice",
        attempt: Number(request.attempt),
        licenseNote: "Retained paid voice fixture.",
        scenePosition: 1,
      },
    };
    const groupConflict = this.grouped ? {
      code: "NARRATION_GROUP_DOES_NOT_FIT", groupId: "narration-1", sourceScenePositions: [1, 2, 3],
      window: { startFrame: 0, endFrame: 945 }, sourceAudioSamples: 1415610, requiredFrames: 963,
      cuts: [{ scenePosition: 1, startFrame: 0, frameCount: 300 }, { scenePosition: 2, startFrame: 300, frameCount: 300 },
        { scenePosition: 3, startFrame: 600, frameCount: 345 }], operationId: String(request.commandId), audioArtifact,
    } : undefined;
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "rejected",
      error: {
        code: groupConflict?.code ?? "VOICE_DOES_NOT_FIT",
        message: "Scene 1 requires 10.2s for natural voice but the accepted cut is 10s.",
      },
      output: {
        conflict: groupConflict ?? {
          code: "VOICE_DOES_NOT_FIT",
          scenePosition: 1,
          plannedSeconds: 10,
          speechSeconds: 10,
          requiredSeconds: 10.2,
          executablePlanPath: String(input.executablePlanPath),
          operationId: String(request.commandId),
          audioArtifact,
        },
      },
      artifacts: [audioArtifact],
      diagnostics: {
        actualCostCny: 0.5,
        actualCostSource: "configured_rate",
        meteredAttemptCount: 1,
        meteredFailedAttemptCount: 0,
        providerOutcomeKnown: true,
      },
    };
  }
}

function directorAgent(): VisualDirectorAgent {
  return {
    id: "api-visual-director-v1",
    plan: async (input) => ({
      version: "video-factory/director-plan-v1",
      requestedProfileId: input.brief.requestedProfileId,
      resolvedProfileId: "documentary-observer",
      profileRationale: "真实动作使用纪实图库。",
      visualBible: {
        viewerPromise: input.brief.viewerPromise,
        narrativeApproach: "三个动作逐步推进。",
        pacing: "自然",
        composition: "稳定中景",
        camera: "固定机位",
        color: "自然色",
        continuity: "同一时段",
        sound: "自然环境声",
      },
      shots: input.scenes.map((scene) => ({
        scenePosition: scene.position,
        narrativeRole: "推进",
        authenticityPolicy: "evidence",
        preferredProviderId: "pexels-stock-v1",
        deliveryType: "stock_video",
        alternativeProviderIds: [],
        temporalBeats: [
          { startSeconds: 0, endSeconds: scene.duration / 2, action: "建立动作" },
          { startSeconds: scene.duration / 2, endSeconds: scene.duration, action: "完成动作" },
        ],
        sourceInSeconds: 0,
        query: scene.visualPrompt,
        generationPrompt: scene.visualPrompt,
        rationale: "真实图库可执行。",
        continuityNote: "保持自然色。",
        confidence: 0.9,
        estimatedCostCny: 0,
      })),
    }),
  };
}

describe("ProductionPipeline production preflight", () => {
  for (const mode of ["regular", "group-conflict", "upstream-edit"]) it(`confirms continuous narration before TTS without releasing the current user gate (${mode})`, async () => {
    const groupedConflict = mode === "group-conflict";
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-narration-confirm-"));
    const worker = groupedConflict ? new VoiceConflictWorker(true) : new RecordingWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      screenwriterAgent: { id: "codex-screenwriter-v1", draft: async () => ({ viewerPromise: "三个动作连成故事", scenes }) },
      directorAgent: directorAgent(),
      assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["图库视频"], deliveryTypes: ["stock_video"] }],
      providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo", transport: "http_api",
        billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
    });
    let run = await pipeline.start({ protocolVersion: "video-factory/brief-v1", title: "三个动作连成故事",
      angle: "连续叙事", audience: "普通创作者", nicheSlug: "life-actions", durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 }, platform: "douyin", runPurpose: "test", reviewMode: "manual",
      workflowFeatures: { boundaryGates: "user-confirmed-v1", assetSemanticRank: false, referenceGrammar: false },
      providers: { script: "codex-screenwriter-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1",
        voice: "minimax-tts-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: { profileId: "minimax:female-chengshu", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    });
    for (let step = 0; step < 8 && !run.nodeRuns.some((node) => node.nodeId === "assets" && node.status === "needs_human"); step += 1) {
      const waiting = run.nodeRuns.find((node) => node.status === "needs_human")!;
      assert.ok(waiting?.intervention, JSON.stringify(run));
      run = await pipeline.decide(run.id, { interventionId: waiting.intervention.id, action: "approve", actor: "creator",
        expectedRunRevision: run.revision, reviewEvidenceId: null });
    }
    let originalGate = run.nodeRuns.find((node) => node.nodeId === "assets")!.intervention!;
    assert.ok(originalGate);
    const preview = await pipeline.previewNarrationPlan(run.id);
    assert.equal(preview.plan.groups.length, 1);
    let chosen = structuredClone(preview.plan);
    chosen.groups[0]!.placement.anchor = "end";
    let saved = await pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: chosen, actor: "creator" });
    assert.equal(saved.status, "needs_human");
    assert.deepEqual(saved.nodeRuns.find((node) => node.nodeId === "assets")!.intervention, originalGate);
    assert.equal(worker.requests.some((request) => request.capability === "voice.synthesize"), false);
    assert.equal((await pipeline.previewNarrationPlan(run.id)).confirmed, true);
    await assert.rejects(() => pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: chosen, actor: "creator" }), /revision/i);
    if (mode === "upstream-edit") {
      const preflight = saved.nodeRuns.find((node) => node.nodeId === "production-preflight")!;
      const output = preflight.output as { executablePlanPath: string };
      const changedVisual = JSON.parse(await readFile(output.executablePlanPath, "utf8"));
      changedVisual.cuts[0].frameCount += 3;
      for (const cut of changedVisual.cuts.slice(1)) cut.startFrame += 3;
      changedVisual.totalFrames += 3;
      const directory = path.join(workspaceRoot, "runs", run.id, "nodes", "production-preflight", "manual-narration-test");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "executable_plan.json");
      const content = JSON.stringify(changedVisual);
      await writeFile(file, content);
      const original = saved.artifacts.find((artifact) => artifact.uri === output.executablePlanPath)!;
      await pipeline.applyNodeOverride(run.id, { nodeId: "production-preflight", actor: "creator",
        expectedVersionId: preflight.outputState!.effectiveVersionId, output: { ...output, executablePlanPath: file },
        artifacts: [{ ...original, uri: file, sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content) }] });
      saved = await pipeline.resumeStale(run.id);
      originalGate = saved.nodeRuns.find((node) => node.nodeId === "assets")!.intervention!;
      await assert.rejects(() => pipeline.decide(run.id, { interventionId: originalGate.id, action: "approve", actor: "creator",
        expectedRunRevision: saved.revision, reviewEvidenceId: null }), /旁白方案.*变化.*重新/);
      assert.equal(worker.requests.some((request) => request.capability === "voice.synthesize"), false);
      const refreshed = await pipeline.previewNarrationPlan(run.id);
      assert.equal(refreshed.confirmed, false);
      chosen = refreshed.plan;
      chosen.groups[0]!.placement.anchor = "end";
      saved = await pipeline.confirmNarrationPlan(run.id, { expectedRunRevision: saved.revision, plan: chosen, actor: "creator" });
    }
    const voiced = await pipeline.decide(run.id, { interventionId: originalGate.id, action: "approve", actor: "creator",
      expectedRunRevision: saved.revision, reviewEvidenceId: null });
    assert.equal(voiced.nodeRuns.find((node) => node.nodeId === "voice")?.status, "needs_human", JSON.stringify(voiced));
    const voiceInput = worker.requests.find((request) => request.capability === "voice.synthesize")!.input;
    assert.deepEqual(JSON.parse(await readFile(String(voiceInput.narrationPlanPath), "utf8")), chosen);
    assert.equal(voiced.nodeRuns.some((node) => node.nodeId === "render"), false);
    if (groupedConflict) {
      const voiceNode = voiced.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal((voiceNode.output as { conflict: { code: string } }).conflict.code, "NARRATION_GROUP_DOES_NOT_FIT");
      assert.deepEqual(voiceNode.intervention?.options, ["request_changes", "reject"]);
      assert.equal(voiceNode.outcomeUncertain, undefined);
      await assert.rejects(() => pipeline.requestVoiceTimingRevision(run.id, { expectedRunRevision: voiced.revision,
        interventionId: voiceNode.intervention!.id, groupId: "narration-1", scenePosition: 4, durationSeconds: 20, actor: "creator" }), /镜头|scene/i);
      const revised = await pipeline.requestVoiceTimingRevision(run.id, { expectedRunRevision: voiced.revision,
        interventionId: voiceNode.intervention!.id, groupId: "narration-1", scenePosition: 2, durationSeconds: 10.6, actor: "creator" });
      assert.equal(revised.status, "needs_human", JSON.stringify(revised.nodeRuns.filter((node) => node.status === "failed")));
      const output = revised.nodeRuns.find((node) => node.nodeId === "production-preflight")!.output as { executablePlanPath: string };
      const newVisual = JSON.parse(await readFile(output.executablePlanPath, "utf8"));
      assert.deepEqual(newVisual.cuts.map((cut: { frameCount: number }) => cut.frameCount), [300, 318, 345]);
      const newNarration = revised.artifacts.filter((artifact) => artifact.kind === "narration_plan").at(-1)!;
      const newPlan = JSON.parse(await readFile(newNarration.uri!, "utf8"));
      assert.equal(newPlan.visualPlan.totalFrames, 963);
      assert.equal(newPlan.groups[0].placement.anchor, "end");
      assert.equal(newPlan.groups[0].text, chosen.groups[0]!.text);
      assert.equal(worker.requests.filter((request) => request.capability === "voice.synthesize").length, 1, "changed materials must stop at their user gate before voice resumes");
      let resumed = revised;
      for (let step = 0; step < 4 && worker.requests.filter((request) => request.capability === "voice.synthesize").length < 2; step += 1) {
        const waiting = resumed.nodeRuns.find((node) => node.status === "needs_human")!;
        resumed = await pipeline.decide(run.id, { interventionId: waiting.intervention!.id, action: "approve", actor: "creator",
          expectedRunRevision: resumed.revision, reviewEvidenceId: null });
      }
      const restoredVoiceInput = worker.requests.filter((request) => request.capability === "voice.synthesize").at(-1)!.input;
      assert.equal(restoredVoiceInput.narrationPlanPath, newNarration.uri, "restore must not silently switch back to scene-locked voice");
    } else if (mode === "regular") {
      let final = voiced;
      for (let step = 0; step < 5 && !final.nodeRuns.some((node) => node.nodeId === "final-review" && node.status === "needs_human"); step += 1) {
        const waiting = final.nodeRuns.find((node) => node.status === "needs_human")!;
        final = await pipeline.decide(run.id, { interventionId: waiting.intervention!.id, action: "approve", actor: "creator",
          expectedRunRevision: final.revision, reviewEvidenceId: null });
      }
      const changed = await pipeline.requestNarrationRevision(run.id, { expectedRunRevision: final.revision,
        scenePosition: 2, narration: "把城市的光留在这一刻。", actor: "creator", note: "只改这一句，保留连续声音和画面" });
      assert.equal(changed.status, "needs_human", JSON.stringify(changed.nodeRuns.filter((node) => node.status === "failed")));
      const updatedInput = worker.requests.filter((request) => request.capability === "voice.synthesize").at(-1)!.input;
      assert.ok(updatedInput.narrationPlanPath);
      const updatedPlan = JSON.parse(await readFile(String(updatedInput.narrationPlanPath), "utf8"));
      assert.match(updatedPlan.groups[0].text, /把城市的光留在这一刻/);
      assert.equal(updatedPlan.groups[0].placement.anchor, "end");
      assert.equal(worker.requests.filter((request) => request.capability === "asset.prepare").length, 1, "a narration edit must not repurchase visuals");
    }
  });

  it("does not let a new executable-plan production fall back to the legacy timeline", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-missing-preflight-inputs-"));
    const worker = new RecordingWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker });

    await assert.rejects(() => pipeline.start({
      protocolVersion: "video-factory/brief-v1",
      title: "缺少规划输入",
      angle: "必须安全停止",
      audience: "普通创作者",
      nicheSlug: "missing-plan-inputs",
      durationSeconds: 24,
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "manual",
      providers: {
        script: "python-template-v1",
        assets: "local-editorial-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true },
      economics: { recipeId: "free-stock", allowMeteredProviders: false },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    }), /executablePlan.*durationRange.*director/);
    assert.equal(worker.requests.length, 0);
  });

  it("surfaces a materialized natural-voice timing conflict through the planning intervention", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-voice-conflict-"));
    const worker = new VoiceConflictWorker();
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        draft: async () => ({
          viewerPromise: "看完能完成三个真实动作。",
          scenes,
        }),
      },
      directorAgent: directorAgent(),
      visualReviewAgent: {
        id: "test-visual-review-v1",
        modelId: "test-visual-model",
        review: async () => cleanVisualReport,
      },
      assetProviders: [{
        id: "pexels-stock-v1",
        label: "Pexels",
        billing: "free",
        modes: ["图库视频"],
        deliveryTypes: ["stock_video"],
      }],
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax TTS",
        modelId: "speech-test",
        transport: "http_api",
        billing: "metered",
        approvalPolicy: "automatic",
        estimatedCostCny: 0.5,
        maxAttempts: 1,
      }, {
        id: "test-visual-review-v1",
        label: "Test visual review",
        modelId: "test-visual-model",
        transport: "unix_socket",
        billing: "subscription",
        approvalPolicy: "none",
        maxAttempts: 1,
      }],
    });

    const run = await pipeline.start({
      protocolVersion: "video-factory/brief-v1",
      title: "三个真实动作",
      angle: "逐步演示",
      audience: "普通创作者",
      nicheSlug: "life-actions",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "manual",
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "minimax-tts-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
        visualReview: "test-visual-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: {
        profileId: "minimax:female-chengshu",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });

    assert.equal(run.status, "needs_human");
    const voice = run.nodeRuns.find((node) => node.nodeId === "voice");
    assert.equal(voice?.status, "needs_human");
    assert.equal(voice?.intervention?.requiredAction, "request_changes");
    assert.deepEqual(voice?.intervention?.options, ["request_changes", "reject"]);
    assert.equal(voice?.executionReceipt?.actualCostCny, 0.5);
    assert.equal(voice?.outcomeUncertain, undefined);
    const conflict = (voice?.output as { conflict?: Record<string, unknown> })?.conflict;
    assert.equal(conflict?.code, "VOICE_DOES_NOT_FIT");
    assert.equal(conflict?.scenePosition, 1);
    assert.equal(conflict?.requiredSeconds, 10.2);
    assert.equal((conflict?.audioArtifact as { uri?: string })?.uri?.endsWith("scene_01_raw.mp3"), true);
    assert.ok(run.artifacts.some((artifact) => (
      artifact.kind === "voiceover_raw"
      && artifact.id === voice?.artifactIds[0]
      && artifact.provenance.scenePosition === 1
    )));
    assert.equal(run.nodeRuns.some((node) => node.nodeId === "render"), false);

    const preflight = run.nodeRuns.find((node) => node.nodeId === "production-preflight");
    const preflightVersionId = preflight?.outputState?.effectiveVersionId;
    assert.ok(preflightVersionId);
    const previousPlanPath = String((preflight?.output as { executablePlanPath?: string }).executablePlanPath);
    const completed = await pipeline.requestVoiceTimingRevision(run.id, {
      expectedRunRevision: run.revision,
      interventionId: voice!.intervention!.id,
      scenePosition: 1,
      durationSeconds: 10.2,
      actor: "editor",
    });
    assert.equal(
      completed.status,
      "needs_human",
      completed.nodeRuns.find((node) => node.status === "failed")?.error,
    );
    assert.ok(completed.artifacts.some((artifact) => artifact.kind === "voiceover_raw"));
    assert.equal(completed.decisions.at(-1)?.action, "request_changes");
    const completedPreflight = completed.nodeRuns.find((node) => node.nodeId === "production-preflight");
    const revisedPlanPath = String((completedPreflight?.output as { executablePlanPath?: string }).executablePlanPath);
    assert.notEqual(revisedPlanPath, previousPlanPath);
    assert.match(revisedPlanPath, /production-preflight[/\\]revisions[/\\]revision-/);
    assert.deepEqual(
      worker.requests.filter(({ capability }) => capability === "voice.synthesize")
        .map(({ input }) => input.executablePlanPath),
      [previousPlanPath, revisedPlanPath],
    );

    const completedPreflightVersionId = completedPreflight?.outputState?.effectiveVersionId;
    assert.ok(completedPreflightVersionId);
    const revisedPlan = JSON.parse(await readFile(revisedPlanPath, "utf8")) as {
      totalFrames: number;
      cuts: Array<{ startFrame: number; frameCount: number }>;
    };
    const previousTechnicalArtifactIds = completed.nodeRuns.find((node) => node.nodeId === "technical-review")?.artifactIds;
    const reviewInvalidatingPlan = structuredClone(revisedPlan);
    reviewInvalidatingPlan.cuts[0]!.frameCount = 309;
    reviewInvalidatingPlan.cuts[1]!.startFrame = 309;
    reviewInvalidatingPlan.cuts[2]!.startFrame = 609;
    reviewInvalidatingPlan.totalFrames = 954;
    const manualDirectory = path.join(workspaceRoot, "runs", run.id, "nodes", "production-preflight", "manual-a4");
    await mkdir(manualDirectory, { recursive: true });
    const nextPlanPath = path.join(manualDirectory, "executable_plan_review_scope.json");
    const nextPlanContent = `${JSON.stringify(reviewInvalidatingPlan, null, 2)}\n`;
    await writeFile(nextPlanPath, nextPlanContent, "utf8");
    const reviewsInvalidated = await pipeline.applyNodeOverride(completed.id, {
      nodeId: "production-preflight",
      actor: "editor",
      expectedVersionId: completedPreflightVersionId,
      output: { executablePlanPath: nextPlanPath },
      artifacts: [{
        kind: "executable_plan",
        uri: nextPlanPath,
        sha256: createHash("sha256").update(nextPlanContent).digest("hex"),
        sizeBytes: Buffer.byteLength(nextPlanContent),
        contentType: "application/json",
        schemaVersion: "video-factory/executable-plan-v1",
        producer: { nodeId: "production-preflight", attempt: 3 },
      }],
    });

    assert.equal(reviewsInvalidated.status, "stale");
    for (const nodeId of [
      "assets",
      "asset-source-review",
      "voice",
      "render",
      "technical-review",
      "visual-review",
      "final-review",
    ]) {
      const node = reviewsInvalidated.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
      assert.equal(node?.status, "stale", `${nodeId} must not approve a changed timeline`);
      assert.equal(node?.outputState?.stale, true);
    }
    assert.deepEqual(
      reviewsInvalidated.nodeRuns.find((node) => node.nodeId === "technical-review")?.artifactIds,
      previousTechnicalArtifactIds,
    );
    assert.ok(reviewsInvalidated.artifacts.some((artifact) => artifact.kind === "voiceover_raw"));
  });

  it("compiles one executable plan before media work and passes its path to every worker consumer", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-preflight-"));
    const worker = new RecordingWorker();
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        draft: async () => ({
          viewerPromise: "看完能完成三个真实动作。",
          narrativeArc: "从准备到执行再到收束。",
          scenes,
        }),
      },
      directorAgent: directorAgent(),
      assetProviders: [{
        id: "pexels-stock-v1",
        label: "Pexels",
        billing: "free",
        modes: ["图库视频"],
        deliveryTypes: ["stock_video"],
      }],
    });

    const run = await pipeline.start({
      protocolVersion: "video-factory/brief-v1",
      title: "三个真实动作",
      angle: "逐步演示",
      audience: "普通创作者",
      nicheSlug: "life-actions",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "automatic",
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.workflowVersion, "1.1.1");
    const preflight = run.nodeRuns.find((node) => node.nodeId === "production-preflight");
    assert.equal(preflight?.status, "succeeded");
    const executablePlanPath = (preflight?.output as { executablePlanPath?: string })?.executablePlanPath;
    assert.ok(executablePlanPath);
    const planContent = await readFile(executablePlanPath, "utf8");
    const plan = JSON.parse(planContent) as {
      version: string;
      totalFrames: number;
      cuts: Array<{ frameCount: number }>;
    };
    assert.equal(plan.version, "video-factory/executable-plan-v1");
    assert.equal(plan.totalFrames, 945);
    assert.deepEqual(plan.cuts.map((cut) => cut.frameCount), [300, 300, 345]);
    const planArtifact = run.artifacts.find((artifact) => artifact.id === preflight?.artifactIds[0]);
    const scriptArtifact = run.artifacts.find((artifact) => artifact.producer?.nodeId === "script" && artifact.kind === "script");
    const directorArtifact = run.artifacts.find((artifact) => artifact.producer?.nodeId === "visual-direction" && artifact.kind === "storyboard");
    assert.equal(planArtifact?.schemaVersion, "video-factory/executable-plan-v1");
    assert.equal(planArtifact?.sha256, createHash("sha256").update(planContent).digest("hex"));
    assert.deepEqual(planArtifact?.parentArtifactIds, [scriptArtifact?.id, directorArtifact?.id]);
    assert.deepEqual(
      worker.requests.map(({ capability, input }) => [capability, input.executablePlanPath]),
      [
        ["asset.prepare", executablePlanPath],
        ["voice.synthesize", executablePlanPath],
        ["video.render", executablePlanPath],
        ["quality.review", executablePlanPath],
      ],
    );
  });

  it("recovers the exact next node without skipping or duplicating the accepted executable plan", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-preflight-recovery-"));
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new RecordingWorker(),
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        draft: async () => ({
          viewerPromise: "看完能完成三个真实动作。",
          scenes,
        }),
      },
      directorAgent: directorAgent(),
      assetProviders: [{
        id: "pexels-stock-v1",
        label: "Pexels",
        billing: "free",
        modes: ["图库视频"],
        deliveryTypes: ["stock_video"],
      }],
    });
    const completed = await pipeline.start({
      protocolVersion: "video-factory/brief-v1",
      title: "三个真实动作",
      angle: "逐步演示",
      audience: "普通创作者",
      nicheSlug: "life-actions",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "automatic",
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });
    const preflightIndex = completed.nodeRuns.findIndex((node) => node.nodeId === "production-preflight");
    assert.ok(preflightIndex > 0);

    for (const [runId, lastCompletedIndex] of [
      ["run-before-preflight", preflightIndex - 1],
      ["run-after-preflight", preflightIndex],
    ] as const) {
      const runRoot = path.join(workspaceRoot, "runs", runId);
      await mkdir(runRoot, { recursive: true });
      const nodeRuns = structuredClone(completed.nodeRuns.slice(0, lastCompletedIndex + 1));
      const artifactIds = new Set(nodeRuns.flatMap((node) => node.artifactIds));
      const artifacts = structuredClone(completed.artifacts.filter((artifact) => artifactIds.has(artifact.id)));
      await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify({
        ...completed,
        id: runId,
        revision: 0,
        status: "running",
        finishedAt: undefined,
        nodeRuns,
        artifacts,
      }, null, 2)}\n`, "utf8");
    }

    assert.equal(await pipeline.recoverInterruptedRuns(), 2);
    const beforePreflight = await pipeline.show("run-before-preflight");
    const afterPreflight = await pipeline.show("run-after-preflight");
    assert.equal(beforePreflight.nodeRuns.at(-1)?.nodeId, "production-preflight");
    assert.equal(afterPreflight.nodeRuns.at(-1)?.nodeId, "assets");
    assert.equal(afterPreflight.artifacts.filter((artifact) => artifact.kind === "executable_plan").length, 1);
  });

  it("stops before a paid media quote when a source artifact no longer matches its registered bytes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-preflight-tamper-"));
    const worker = new RecordingWorker();
    const baseDirector = directorAgent();
    const tamperingDirector: VisualDirectorAgent = {
      ...baseDirector,
      plan: async (input) => {
        const plan = await baseDirector.plan(input) as { shots: Array<Record<string, unknown>> };
        plan.shots = plan.shots.map((shot) => ({
          ...shot,
          authenticityPolicy: "illustrative",
          preferredProviderId: "seedream-image-v1",
          deliveryType: "generated_image",
          rationale: "生成示意图可执行。",
          estimatedCostCny: 0.25,
        }));
        const scriptRelativePath = (await readdir(workspaceRoot, { recursive: true }))
          .find((entry) => entry.endsWith(`${path.sep}script.json`) || entry === "script.json");
        assert.ok(scriptRelativePath);
        await writeFile(path.join(workspaceRoot, scriptRelativePath), "{\"tampered\":true}\n", "utf8");
        return plan;
      },
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        draft: async () => ({
          viewerPromise: "看完能理解三个抽象步骤。",
          scenes: scenes.map((scene) => ({
            ...scene,
            visual_strategy: "image" as const,
            visual_prompt: `第 ${scene.position} 段抽象步骤图`,
          })),
        }),
      },
      directorAgent: tamperingDirector,
      assetProviders: [{
        id: "seedream-image-v1",
        label: "Seedream",
        billing: "metered",
        modes: ["AI 图片"],
        deliveryTypes: ["generated_image"],
        generative: true,
        estimatedCnyPerClip: 0.25,
      }],
      providerRuntimeMetadata: [{
        id: "seedream-image-v1",
        label: "Seedream",
        modelId: "doubao-seedream-4-0-250828",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 0.25,
        maxAttempts: 1,
      }],
    });

    const run = await pipeline.start({
      protocolVersion: "video-factory/brief-v1",
      title: "三个真实动作",
      angle: "逐步演示",
      audience: "普通创作者",
      nicheSlug: "life-actions",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "automatic",
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedream-image-v1"] },
      economics: {
        recipeId: "custom",
        allowMeteredProviders: true,
        maxPaidShots: 3,
        maxCostCny: 10,
      },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });

    assert.equal(run.status, "failed");
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /sha256 does not match/);
    assert.equal(run.nodeRuns.at(-1)?.nodeId, "production-preflight");
    assert.equal(run.nodeRuns.some((node) => node.nodeId === "assets" && node.spendPlan), false);
    assert.equal(worker.requests.length, 0);
  });

  it("refuses a paid media quote when the accepted executable plan is corrupted after preflight", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-preflight-plan-tamper-"));
    const worker = new RecordingWorker();
    const baseDirector = directorAgent();
    const paidDirector: VisualDirectorAgent = {
      ...baseDirector,
      plan: async (input) => {
        const plan = await baseDirector.plan(input) as { shots: Array<Record<string, unknown>> };
        plan.shots = plan.shots.map((shot) => ({
          ...shot,
          authenticityPolicy: "illustrative",
          preferredProviderId: "seedream-image-v1",
          deliveryType: "generated_image",
          rationale: "生成示意图可执行。",
          estimatedCostCny: 0.25,
        }));
        return plan;
      },
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        draft: async () => ({
          viewerPromise: "看完能理解三个抽象步骤。",
          scenes: scenes.map((scene) => ({
            ...scene,
            visual_strategy: "image" as const,
            visual_prompt: `第 ${scene.position} 段抽象步骤图`,
          })),
        }),
      },
      directorAgent: paidDirector,
      assetProviders: [{
        id: "seedream-image-v1",
        label: "Seedream",
        billing: "metered",
        modes: ["AI 图片"],
        deliveryTypes: ["generated_image"],
        generative: true,
        estimatedCnyPerClip: 0.25,
      }],
      providerRuntimeMetadata: [{
        id: "seedream-image-v1",
        label: "Seedream",
        modelId: "doubao-seedream-4-0-250828",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 0.25,
        maxAttempts: 1,
      }],
    });
    let corrupted = false;
    const dispatched = await pipeline.dispatch({
      protocolVersion: "video-factory/brief-v1",
      title: "三个抽象步骤",
      angle: "逐步演示",
      audience: "普通创作者",
      nicheSlug: "abstract-actions",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      platform: "douyin",
      runPurpose: "test",
      reviewMode: "automatic",
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedream-image-v1"] },
      economics: {
        recipeId: "custom",
        allowMeteredProviders: true,
        maxPaidShots: 3,
        maxCostCny: 10,
      },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    }, async (checkpoint) => {
      const preflight = checkpoint.nodeRuns.find((node) => node.nodeId === "production-preflight");
      if (corrupted || preflight?.status !== "succeeded") return;
      const planPath = (preflight.output as { executablePlanPath?: string })?.executablePlanPath;
      assert.ok(planPath);
      corrupted = true;
      await writeFile(planPath, "{\"version\":\"corrupt\"}\n", "utf8");
    });

    const run = await dispatched.completion;

    assert.equal(corrupted, true);
    assert.equal(run.status, "failed");
    assert.equal(run.nodeRuns.at(-1)?.nodeId, "assets");
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /sha256 does not match/);
    assert.equal(run.nodeRuns.at(-1)?.spendPlan, undefined);
    assert.equal(worker.requests.length, 0);
  });
});
