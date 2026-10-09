import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, mock } from "node:test";
import {
  ProductionPipeline,
  PythonWorkerClient,
  FileRunStore,
  canonicalJsonV2,
  buildCharacterNarrationPlan,
  CodexBridgeError,
  RoleAgentLoopError,
  runRoleAgentLoop,
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
import { ProviderRegistry, WorkflowRunner } from "@video-factory/workflow-core";
import { ProductionStudio } from "../src/server/production-studio.js";
import { StudioService } from "../src/server/studio-service.js";
import { buildStudioApp } from "../src/server/app.js";
import { createPasswordHash } from "../src/server/auth.js";
import { studioApi } from "../src/client/api.js";
import type { StudioProvider } from "../src/shared/api.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

it("native AV formal pipeline preserves human gates and retries only local audio, with TTS APIs rejected", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-native-pipeline-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const python = new PythonWorkerClient({ command: ["python3", "-m", "video_factory.worker"],
    cwd: repositoryRoot, env: { PATH: process.env.PATH!, PYTHONPATH: path.join(repositoryRoot, "src") }, timeoutMs: 120_000 });
  const calls: string[] = [];
  const agents = jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] });
  const direct = async (input: VisualDirectorAgentInput) => {
    const old = await agents.directorAgent!.plan(input);
    return { ...old, shots: old.shots.map(shot => ({ ...shot, preferredProviderId: "wan-video-v1",
      deliveryType: "generated_video" as const, estimatedCostCny: 4.8 })) };
  };
  let failAudioOnce = true;
  const worker = { run: async (request: Record<string, unknown>): Promise<WorkerResponse> => {
    const capability = String(request.capability);
    calls.push(capability);
    assert.notEqual(capability, "voice.synthesize", "原生制作不能偷偷调用TTS");
    const dir = String(request.outputDir);
    await mkdir(dir, { recursive: true });
    const artifact = async (uri: string, kind: string, contentType: string) => {
      const bytes = await readFile(uri);
      return { uri, kind, contentType, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
        provenance: { providerId: String((request.parameters as Record<string, unknown>).providerId), producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt), licenseNote: "Controlled local fixture; zero provider calls." } };
    };
    if (capability === "asset.prepare") {
      const input = request.input as Record<string, unknown>;
      const executable = JSON.parse(await readFile(String(input.executablePlanPath), "utf8"));
      const assets = [];
      const artifacts = [];
      for (const cut of executable.cuts) {
        const uri = path.join(dir, `scene-${cut.scenePosition}.mp4`);
        await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=180x320:r=25:d=9", "-f", "lavfi", "-i",
          "sine=frequency=440:sample_rate=48000:duration=9", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", uri]);
        artifacts.push(await artifact(uri, "media_asset", "video/mp4"));
        assets.push({ scene_position: cut.scenePosition, local_path: uri, media_type: "video", provider: "wan", asset_id: `task-${cut.scenePosition}`,
          width: 180, height: 320, duration: 9, duration_frames: cut.frameCount, source_in_frame: cut.sourceInFrame,
          asset_key: cut.assetKey, license_note: "controlled fixture", source_url: "https://example.com/fixture" });
      }
      const uri = path.join(dir, "asset_plan.json");
      await writeFile(uri, JSON.stringify({ scene_assets: assets }));
      artifacts.push(await artifact(uri, "asset_plan", "application/json"));
      return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded",
        output: { assetPlanPath: uri }, artifacts, diagnostics: { providerOutcomeKnown: true, meteredAttemptCount: 0 } };
    }
    if (capability === "audio.prepare_native" && failAudioOnce) {
      failAudioOnce = false;
      const uri = path.join(dir, "native_audio_report.json");
      await writeFile(uri, JSON.stringify({ code: "audio_decode_failed", message: "受控本地解码错误" }));
      return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "rejected",
        output: { audioMode: "native_av", nativeAudioIssue: "audio_decode_failed" },
        error: { code: "NATIVE_AUDIO_UNAVAILABLE", message: "受控本地解码错误" }, artifacts: [await artifact(uri, "native_audio_report", "application/json")],
        diagnostics: { providerOutcomeKnown: true, meteredAttemptCount: 0 } };
    }
    return python.run(capability === "video.render" ? { ...request, parameters: { ...request.parameters as object, resolution: "180x320" } } : request);
  } };
  const pipeline = new ProductionPipeline({ workspaceRoot, worker, ...agents,
    directorAgent: { ...agents.directorAgent!, plan: direct, planDetailed: async input => input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
      : { output: await direct(input), trace: { taskKind: "director-plan", promptVersion: "v1", prompt: "fixture", providerId: "openai", modelId: "director-model-one" } } },
    // 能力目录的参考镜价不是费用授权依据；即便目录估价暂缺，运行时已核型号仍必须报价。
    assetProviders: [{ id: "wan-video-v1", label: "Wan", billing: "metered", modes: ["生成视频"], deliveryTypes: ["generated_video"], estimatedCnyPerClip: 0, generative: true }],
    providerRuntimeMetadata: [{ id: "wan-video-v1", label: "Wan", modelId: "wan3.0-video", transport: "http_api", billing: "metered", approvalPolicy: "manual", estimatedCostCny: 4.8, maxAttempts: 1,
      modelProfiles: [{ modelId: "wan3.0-video", estimatedCostCny: 4.8, minDurationSeconds: 2, maxDurationSeconds: 15, resolutions: ["720P"], supportsAudio: true }] }] });
  const { voiceDirection: _voice, ...base } = jointReworkBrief();
  const brief = { ...base, audioMode: "native_av" as const, nativeVideoProviderId: "wan-video-v1", models: { "wan-video-v1": "wan3.0-video" },
    providers: { ...base.providers, assets: "ai-shot-router-v1", voice: "python-native-audio-v1" },
    director: { profileId: "auto" as const, assetProviderIds: ["wan-video-v1"] }, economics: { recipeId: "custom" as const, allowMeteredProviders: true },
    workflowFeatures: { ...base.workflowFeatures!, boundaryGates: "user-confirmed-v1" as const } };
  let run = await confirmGatedRework(pipeline, brief);
  const approve = async () => {
    const gate = run.nodeRuns.find(node => node.status === "needs_human")!.intervention!;
    run = await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "tester", expectedRunRevision: run.revision, reviewEvidenceId: null });
  };
  assert.equal(run.nodeRuns.find(n => n.status === "needs_human")?.nodeId, "creative-planning");
  await approve();
  const spend = run.nodeRuns.find(n => n.nodeId === "assets")!.spendPlan!;
  assert.ok(spend, JSON.stringify({ nodes: run.nodeRuns.map(n => ({ id: n.nodeId, status: n.status, error: n.error, intervention: n.intervention, output: n.nodeId === "assets" ? n.output : undefined })), calls }));
  assert.deepEqual(calls, []);
  run = await pipeline.authorizeSpend(run.id, { spendPlanId: spend.id, nodeId: spend.nodeId, inputVersionIds: spend.inputVersionIds,
    providerId: spend.providerId, modelId: spend.modelId, maxCostCny: spend.maxCostCny, maxAttempts: spend.maxAttempts, approvedBy: "tester" });
  assert.equal(run.nodeRuns.find(n => n.status === "needs_human")?.nodeId, "assets");
  await approve();
  assert.equal(run.status, "needs_human");
  assert.equal((run.nodeRuns.find(n => n.nodeId === "voice")?.output as Record<string, unknown>).nativeAudioIssue, "audio_decode_failed");
  const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
  const app = buildStudioApp({ service, logger: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/api/runs/${run.id}/narration-plan` })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `/api/runs/${run.id}/narration-revisions`, payload: {
    expectedRunRevision: run.revision, scenePosition: 1, narration: "替换台词", note: "原生模式不能购买旁白",
  } })).statusCode, 409);
  const before = await pipeline.loadPersisted(run.id);
  const assetsHash = before.artifacts.filter(a => a.kind === "media_asset").map(a => a.sha256);
  const recovery = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json().nativeAudioRecovery;
  assert.deepEqual(recovery, { expectedRunRevision: run.revision, interventionId: run.nodeRuns.find(n => n.nodeId === "voice")!.intervention!.id });
  const dispatchRetry = pipeline.dispatchRetryFailedNode.bind(pipeline);
  let retryCompletion: Promise<unknown> | undefined;
  t.mock.method(pipeline, "dispatchRetryFailedNode", async (...args: Parameters<typeof dispatchRetry>) => {
    const operation = await dispatchRetry(...args);
    retryCompletion = operation.completion;
    return operation;
  });
  const retryUrl = `/api/runs/${run.id}/nodes/voice/retry`;
  assert.equal((await app.inject({ method: "POST", url: retryUrl })).statusCode, 409, "重试必须绑定当前失败停点");
  assert.equal((await app.inject({ method: "POST", url: retryUrl, payload: { ...recovery, expectedRunRevision: run.revision - 1 } })).statusCode, 409);
  const resumed = await app.inject({ method: "POST", url: retryUrl, payload: recovery });
  assert.equal(resumed.statusCode, 200, resumed.body);
  // HTTP 返回首个 checkpoint，不代表后台已释放租约；下一次直接管线调用须等正式 completion。
  assert.ok(retryCompletion);
  await retryCompletion;
  run = await pipeline.loadPersisted(run.id);
  assert.ok(run.revision > before.revision);
  assert.equal(run.nodeRuns.find(n => n.status === "needs_human")?.nodeId, "voice", JSON.stringify(run.nodeRuns.map(n => ({ id: n.nodeId, error: n.error }))));
  assert.equal((run.nodeRuns.find(n => n.nodeId === "voice")!.output as Record<string, unknown>).subtitleStatus, "unavailable");
  assert.equal(calls.filter(c => c === "asset.prepare").length, 1);
  assert.equal(calls.filter(c => c === "audio.prepare_native").length, 2);
  assert.equal((await app.inject({ method: "POST", url: retryUrl, payload: recovery })).statusCode, 409, "重复或旧标签提交不能重复处理");
  assert.deepEqual(run.artifacts.filter(a => a.kind === "media_asset").map(a => a.sha256), assetsHash);
  await approve();
  assert.equal(run.nodeRuns.find(n => n.status === "needs_human")?.nodeId, "render");
  const video = (run.nodeRuns.find(n => n.nodeId === "render")!.output as Record<string, unknown>).videoPath;
  await promisify(execFile)("ffmpeg", ["-v", "error", "-xerror", "-i", String(video), "-f", "null", "-"]);
  const detail = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
  assert.equal(detail.audioMode, "native_av");
  assert.equal(detail.nodes.find((n: { id: string }) => n.id === "voice").label, "原声试听");
  const summaries = (await app.inject({ method: "GET", url: "/api/runs" })).json();
  assert.equal(summaries.find((entry: { id: string }) => entry.id === run.id)?.audioMode, "native_av");
});

it("MC-A08/24 character script reopens after planning without generation; edits resume the real graph", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-character-reopen-"));
  const { script } = JSON.parse(await readFile(path.join(repositoryRoot, "tests/fixtures/character-drama-cases.json"), "utf8"));
  script.characters[3].voice_profile_id = null;
  const counters: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
  const agents = jointReworkAgents(counters);
  let writes = 0, audits = 0, media = 0, crashAfterGraph = false, crashAfterRun = false;
  const writer = { ...agents.screenwriterAgent!, draft: async () => structuredClone(script), draftDetailed: async (input: ScreenwriterAgentInput) => {
    if (input.creativeReviewExecution?.mode === "check") {
      audits++;
      return passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "编剧", "script-draft", "screenwriter-model-one");
    }
    writes++;
    return { output: structuredClone(script), trace: { taskKind: "script-draft" as const, promptVersion: "v1", prompt: "controlled", providerId: "openai", modelId: "screenwriter-model-one" } };
  } };
  const direct = async (input: VisualDirectorAgentInput) => {
    const old = await agents.directorAgent!.plan(input);
    return { ...old, version: "video-factory/director-plan-v2" as const, shots: old.shots.map((shot, i) => ({ ...shot,
      temporalBeats: ["[0s-3s] 建立人物动作", "[3s-6s] 回应台词"],
      characterIds: script.scenes[i].character_ids, speakingTurnIds: script.scenes[i].dialogue.map((turn: { id: string }) => turn.id) })) };
  };
  const worker = new class extends ReworkWorker { override async run(request: Record<string, unknown>) { media++; return super.run(request); } }();
  const pipeline = new ProductionPipeline({ workspaceRoot, worker, ...agents, screenwriterAgent: writer,
    reviewContinuationFailpoints: {
      afterEvidence: () => { if (crashAfterGraph) { crashAfterGraph = false; throw new Error("controlled graph/run gap"); } },
      afterDecisionCheckpoint: () => { if (crashAfterRun) { crashAfterRun = false; throw new Error("controlled run/response gap"); } },
    },
    directorAgent: { ...agents.directorAgent!, plan: direct, planDetailed: async input => input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
      : { output: await direct(input), trace: { taskKind: "director-plan", promptVersion: "v1", prompt: "controlled", providerId: "openai", modelId: "director-model-one" } } },
    assetProviders: REWORK_ASSET_PROVIDERS });
  let run = await pipeline.start({ ...jointReworkBrief(), presentationMode: "character_drama" });
  run = await confirmCreativeStages(pipeline, run);
  assert.notEqual(run.nodeRuns.find(n => n.nodeId === "creative-planning")!.status, "needs_human");
  const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
  const app = buildStudioApp({ service, logger: false });
  t.after(() => app.close());
  const original = await pipeline.loadPersisted(run.id);
  assert.equal((original.initialInput as ProductionBrief).providers.voice, "macos-say-v1");
  await assert.rejects(pipeline.previewNarrationPlan(run.id), /MiniMax/,
    "旧本地声音配置可以保存角色稿，但不能暗换供应商执行角色配音");
  assert.deepEqual(await pipeline.loadPersisted(run.id), original);
  const detail = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
  assert.ok(detail.characterScriptEditTarget, "下游必须有绑定当前角色稿的可执行返工入口，而非只读跳转");
  const request = { ...detail.characterScriptEditTarget, commandId: "reopen-characters", expectedRunRevision: run.revision,
    intent: "edit_character_script", acknowledgeImpact: true };
  const counts = { writes, audits, media, director: counters.directorInputs.length };
  const denied = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: { ...request, acknowledgeImpact: false } });
  assert.equal(denied.statusCode, 400);
  const runStore = new FileRunStore(path.join(workspaceRoot, "runs"));
  for (const nodeId of ["voice", "assets"]) {
    const uncertain = structuredClone(original);
    uncertain.nodeRuns.find(n => n.nodeId === nodeId)!.outcomeUncertain = true;
    await runStore.checkpoint(uncertain);
    const blocked = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`,
      payload: { ...request, commandId: `unknown-${nodeId}-reopen` } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual(await pipeline.loadPersisted(run.id), uncertain);
    assert.deepEqual({ writes, audits, media, director: counters.directorInputs.length }, counts,
      "返回上游不能绕过原付费请求或触发新调用");
  }
  await runStore.checkpoint(original);
  crashAfterGraph = true;
  const interrupted = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: request });
  assert.equal(interrupted.statusCode, 500);
  assert.equal((await pipeline.loadPersisted(run.id)).revision, original.revision);
  crashAfterRun = true;
  const lostResponse = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: request });
  assert.equal(lostResponse.statusCode, 500);
  const appliedRevision = (await pipeline.loadPersisted(run.id)).revision;
  const opened = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: request });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().revision, appliedRevision, "HTTP丢失恢复不增加第二个版本");
  const reopened = await pipeline.loadPersisted(run.id);
  assert.equal(reopened.status, "needs_human");
  assert.equal(reopened.nodeRuns.find(n => n.nodeId === "creative-planning")!.intervention?.kind, "creative_review");
  assert.deepEqual({ writes, audits, media, director: counters.directorInputs.length }, counts);
  assert.deepEqual(reopened.artifacts, original.artifacts, "返回编辑保留所有已完成文件，不生成新媒体");
  assert.ok(reopened.nodeRuns.find(n => n.nodeId === "assets")!.outputState?.stale);
  const replay = await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: request });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().revision, reopened.revision);
  assert.equal((await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: { ...request, targetSha256: "f".repeat(64) } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `/api/runs/${run.id}/review-continuations`, payload: { ...request, commandId: "stale-reopen" } })).statusCode, 409);
  const review = (await service.creativeReview(run.id))!;
  assert.equal(review.stage, "script");
  assert.deepEqual(review.draft, script);
  const changed = structuredClone(script);
  changed.characters[3].voice_profile_id = script.characters[0].voice_profile_id;
  const saved = await pipeline.dispatchCreativeReviewCommand(run.id, { action: "edit_draft", commandId: "fix-voice", actor: "creator", stage: "script",
    expectedRunRevision: review.runRevision, expectedReviewRevision: review.reviewRevision, baseDraftSha256: review.draftSha256,
    baseDraftVersionId: review.draftVersionId, document: changed });
  run = await saved.completion;
  assert.deepEqual({ writes, audits, media, director: counters.directorInputs.length }, counts, "保存也不生成或自动审计");
  assert.deepEqual((await service.creativeReview(run.id))!.draft, changed);
  for (let index = 0; index < 3; index++) {
    const current = await service.creativeReview(run.id);
    if (!current) break;
    run = await pipeline.confirmCreativeReview(run.id, { commandId: `rework-adopt-${index}`, actor: "creator", stage: current.stage,
      expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256,
      ...(current.checkResult ? { expectedCheckIdentity: current.checkResult.checkIdentity } : { acknowledgeUnaudited: true as const }) });
  }
  assert.equal(writes, 1, "不重新生成已有脚本");
  assert.equal(audits, 1, "修改后不自动审计脚本");
  assert.ok(counters.directorInputs.length > counts.director, "重新采用后才进入真实导演节点");
  const finalReview = (run.nodeRuns.find(n => n.nodeId === "creative-planning")!.output as any).creativeReviewHistory;
  assert.deepEqual(finalReview.stages.script.currentDocument, changed);
  const formalScript = (run.nodeRuns.find(n => n.nodeId === "creative-planning")!.output as { scriptPath: string }).scriptPath;
  assert.deepEqual(JSON.parse(await readFile(formalScript, "utf8")).characters, changed.characters,
    "实际声音消费者读取的正式文件也必须属于新稿，不能只更新UI快照");
  assert.ok(original.artifacts.every(a => run.artifacts.some(b => b.id === a.id)));
});

for (const durationMode of ["legacy", "content-led-v1"] as const) it(`MC-A17/21/22 character HTTP tickets, durable first-fit and crash recovery reuse original audio (${durationMode})`, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-character-transaction-"));
  const { script } = JSON.parse(await readFile(path.join(repositoryRoot, "tests/fixtures/character-drama-cases.json"), "utf8"));
  const agents = jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] });
  const writer = { ...agents.screenwriterAgent!, draft: async () => structuredClone(script), draftDetailed: async (input: ScreenwriterAgentInput) =>
    input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "编剧", "script-draft", "screenwriter-model-one")
      : { output: structuredClone(script), trace: { taskKind: "script-draft" as const, promptVersion: "v1", prompt: "controlled", providerId: "openai", modelId: "screenwriter-model-one" } } };
  const direct = async (input: VisualDirectorAgentInput) => {
    const old = await agents.directorAgent!.plan(input);
    return { ...old, version: "video-factory/director-plan-v2" as const, shots: old.shots.map((shot, i) => ({ ...shot,
      temporalBeats: ["[0s-3s] 建立人物动作", "[3s-6s] 回应台词"],
      characterIds: script.scenes[i].character_ids, speakingTurnIds: script.scenes[i].dialogue.map((turn: { id: string }) => turn.id) })) };
  };
  const director = { ...agents.directorAgent!, plan: direct, planDetailed: async (input: VisualDirectorAgentInput) =>
    input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "director-plan", "director-model-one")
      : { output: await direct(input), trace: { taskKind: "director-plan" as const, promptVersion: "v1", prompt: "controlled", providerId: "openai", modelId: "director-model-one" } } };
  let synthesis = 0, layouts = 0;
  const worker = new class extends ReworkWorker {
    forecastUnavailable = false;
    async forecastPaidVoiceSpend(request: Record<string, unknown>) {
      if (this.forecastUnavailable) throw new Error("controlled character quote unavailable");
      const response = await formalPythonVoiceQuote({ protocolVersion: "video-factory/worker-v1", commandId: "character-quote",
        runId: String(request.runId), nodeRunId: "voice", attempt: 1, capability: "voice.quote",
        outputDir: path.join(String(request.nodeDirectory), ".quote-preview"), input: request.input, parameters: request.parameters });
      if (response.status !== "succeeded" || !response.output) throw new Error(JSON.stringify(response.error));
      return response.output as Record<string, unknown>;
    }
    override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
      if (request.capability === "voice.quote") return formalPythonVoiceQuote(request);
      if (request.capability !== "voice.synthesize") return super.run(request);
      if ((request.input as Record<string, unknown>).relayout) layouts++; else synthesis++;
      return controlledVoiceWorker(request, synthesis === 1);
    }
  }();
  const pipeline = new ProductionPipeline({ workspaceRoot, worker, ...agents, screenwriterAgent: writer, directorAgent: director,
    assetProviders: REWORK_ASSET_PROVIDERS,
    characterVoiceProfiles: script.characters.map((c: { name: string; voice_profile_id: string }) => ({ id: c.voice_profile_id, label: c.name + "音色", providerId: "minimax-tts-v1" })),
    providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
      transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: .5, maxAttempts: 1 }] });
  const brief = jointReworkBrief();
  if (durationMode === "content-led-v1") {
    brief.durationPolicy = durationMode;
    delete brief.durationRange;
  }
  let run = await pipeline.start({ ...brief, presentationMode: "character_drama",
    providers: { ...brief.providers, voice: "minimax-tts-v1" },
    voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
    economics: { ...brief.economics, allowMeteredProviders: true, maxCostCny: 5 },
    workflowFeatures: { ...brief.workflowFeatures, boundaryGates: "user-confirmed-v1" } });
  for (let step = 0; step < 15 && !run.nodeRuns.some(n => n.nodeId === "assets" && n.status === "needs_human"); step++) {
    const gate = run.nodeRuns.find(n => n.status === "needs_human")?.intervention;
    assert.ok(gate, JSON.stringify(run.nodeRuns.map(n => ({ node: n.nodeId, status: n.status, error: n.error }))));
    run = gate.kind === "creative_review" ? await confirmCreativeStages(pipeline, run)
      : await pipeline.decide(run.id, { interventionId: gate.id, action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null });
  }
  const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
  const app = buildStudioApp({ service, logger: false });
  t.after(() => app.close());
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => nativeFetch(typeof input === "string" ? new URL(input, origin) : input, init));
  const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
  assert.equal(detail.json().presentationMode, "character_drama");
  const missingVoiceScript = structuredClone(script);
  missingVoiceScript.characters[0].voice_profile_id = null;
  const missingVoicePreview = t.mock.method(pipeline, "previewNarrationPlan", async () => {
    return buildCharacterNarrationPlan({ script: missingVoiceScript, scriptSha256: "a".repeat(64),
      visualSha256: "b".repeat(64), sourceContextId: "missing-voice" }) as never;
  });
  const beforeInvalid = await pipeline.loadPersisted(run.id);
  const missingVoice = await app.inject({ method: "GET", url: `/api/runs/${run.id}/narration-plan` });
  missingVoicePreview.mock.restore();
  assert.equal(missingVoice.statusCode, 400, missingVoice.body);
  assert.match(missingVoice.body, /音色/);
  await assert.rejects(pipeline.requestNarrationRevision(run.id, { action: "revise_narration",
    expectedRunRevision: run.revision, scenePosition: 1, narration: "不能写回单旁白", actor: "creator", note: "角色保护" }), /角色剧情不能保存为单旁白/);
  assert.deepEqual(await pipeline.loadPersisted(run.id), beforeInvalid);
  assert.equal(synthesis, 0);
  const initial = await studioApi.narrationPlan(run.id);
  assert.equal(initial.plan.version, "video-factory/narration-plan-v3");
  const plan = initial.plan;
  if (plan.version !== "video-factory/narration-plan-v3") throw new Error("wrong plan");
  const candidate = { version: plan.version, groups: plan.groups.map(g => ({ turnId: g.turnId, window: { ...g.window }, placement: { ...g.placement } })), userSilences: [] };
  candidate.groups[0]!.window.endFrame = 15;
  const previewInput = { version: plan.version, expectedRunRevision: run.revision, sourceContextId: initial.sourceContextId!, editorSessionId: "character-tab", editSequence: 1, candidate };
  const invalid = await app.inject({ method: "POST", url: `/api/runs/${run.id}/narration-plan/preview`, payload: {
    ...previewInput, candidate: { ...candidate, groups: candidate.groups.map((g, i) => i ? g : { ...g, voiceProfileId: "different" }) } } });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const ticket = await studioApi.narrationPlanPreviewV2(run.id, { ...previewInput, editSequence: 2 });
  const save = { ...previewInput, editSequence: 2, requestId: "character-plan", ticketId: ticket.ticketId, candidateId: ticket.candidateId,
    planSha256: ticket.planSha256, acknowledgeQuoteUnavailable: true };
  const saved = await studioApi.confirmNarrationPlanV2(run.id, save);
  // 新v3合同仍由原身份认证保护；匿名读、核价、保存与排轨均不得进入消费者。
  const protectedApp = buildStudioApp({ service, logger: false, auth: {
    username: "local-character-test", passwordHash: createPasswordHash("local-character-test-only"),
    sessionSecret: "local-character-test-session-secret-at-least-32", secureCookie: false,
  } });
  t.after(() => protectedApp.close());
  const beforeUnauthorized = await pipeline.loadPersisted(run.id);
  for (const deniedRequest of [
    { method: "GET" as const, url: `/api/runs/${run.id}/narration-plan` },
    { method: "POST" as const, url: `/api/runs/${run.id}/narration-plan/preview`, payload: previewInput },
    { method: "PUT" as const, url: `/api/runs/${run.id}/narration-plan`, payload: save },
    { method: "POST" as const, url: `/api/runs/${run.id}/narration-revisions`, payload: {
      action: "relayout_narration", layout: { narrationPlanVersion: plan.version },
    } },
  ]) {
    const denied = await protectedApp.inject(deniedRequest);
    assert.equal(denied.statusCode, 401, denied.body);
  }
  assert.deepEqual(await pipeline.loadPersisted(run.id), beforeUnauthorized);
  assert.equal(synthesis, 0);
  const replay = await studioApi.confirmNarrationPlanV2(run.id, save);
  assert.equal(replay.receipt.replay, true);
  assert.equal(replay.run.revision, saved.run.revision);
  assert.equal(synthesis, 0, "核价和保存均不合成");
  // 同内容 A→B→A 也有独立有效版本；价格不可得的保存不是付费授权。
  run = await pipeline.loadPersisted(run.id);
  const versionA = structuredClone(run.nodeRuns.find(n => n.nodeId === "voice")!.inputState!.versions
    .find(v => v.id === saved.receipt.inputVersionId));
  const candidateB = structuredClone(candidate);
  candidateB.groups[0]!.window.endFrame = 16;
  worker.forecastUnavailable = true;
  const ticketB = await studioApi.narrationPlanPreviewV2(run.id, { ...previewInput, candidate: candidateB,
    expectedRunRevision: run.revision, editSequence: 3 });
  assert.equal(ticketB.quote.status, "unavailable");
  const saveB = { ...save, expectedRunRevision: run.revision, requestId: "character-plan-b", editSequence: 3,
    ticketId: ticketB.ticketId, candidateId: ticketB.candidateId, planSha256: ticketB.planSha256 };
  await assert.rejects(studioApi.confirmNarrationPlanV2(run.id, { ...saveB, acknowledgeQuoteUnavailable: false }), /核价不可用/);
  assert.deepEqual(await pipeline.loadPersisted(run.id), run);
  const savedB = await studioApi.confirmNarrationPlanV2(run.id, saveB);
  assert.equal(synthesis, 0);
  worker.forecastUnavailable = false;
  const ticketA2 = await studioApi.narrationPlanPreviewV2(run.id, { ...previewInput,
    expectedRunRevision: savedB.run.revision, editSequence: 4 });
  assert.equal(ticketA2.quote.status, "estimated");
  assert.equal(ticketA2.quote.items?.length, 8, "按八句实际正文和音色核价");
  assert.equal(ticketA2.planSha256, saved.receipt.planSha256);
  const savedA2 = await studioApi.confirmNarrationPlanV2(run.id, { ...save, requestId: "character-plan-a2",
    expectedRunRevision: savedB.run.revision, editSequence: 4, ticketId: ticketA2.ticketId,
    candidateId: ticketA2.candidateId, planSha256: ticketA2.planSha256 });
  assert.notEqual(savedA2.receipt.inputVersionId, saved.receipt.inputVersionId);
  run = await pipeline.loadPersisted(run.id);
  assert.deepEqual(run.nodeRuns.find(n => n.nodeId === "voice")!.inputState!.versions
    .find(v => v.id === saved.receipt.inputVersionId), versionA);
  const historicReplay = await studioApi.confirmNarrationPlanV2(run.id, save);
  assert.equal(historicReplay.receipt.current, false);
  assert.equal(historicReplay.run.revision, run.revision);
  await assert.rejects(studioApi.confirmNarrationPlanV2(run.id, { ...save, requestId: "late-character-a" }), /更新|过期|版本/);
  assert.deepEqual(await pipeline.loadPersisted(run.id), run);
  assert.equal(synthesis, 0, "全部候选核价、知情保存、历史重放都不批准配音");
  assert.equal((await studioApi.narrationPlan(run.id)).confirmed, true);
  run = await pipeline.loadPersisted(run.id);
  run = await pipeline.decide(run.id, { interventionId: run.nodeRuns.find(n => n.nodeId === "assets")!.intervention!.id,
    action: "approve", actor: "creator", expectedRunRevision: run.revision, reviewEvidenceId: null });
  const heldVoice = run.nodeRuns.find(n => n.nodeId === "voice")!;
  assert.equal(heldVoice.outcomeUncertain, true);
  const operationId = heldVoice.operationRequestId!;
  const voiceRoot = path.join(workspaceRoot, "runs", run.id, "nodes", "voice");
  const submits = path.join(voiceRoot, "controlled-submissions.jsonl");
  assert.equal(await jsonLineCount(submits), 3);
  const frozen = await pipeline.loadPersisted(run.id);
  for (let index = 0; index < 2; index++) {
    const summary = await app.inject({ method: "GET", url: `/api/runs/${run.id}/nodes/voice/paid-operation` });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().failureKind, "unknown_outcome");
  }
  for (const outcome of ["confirmed_charged", "confirmed_not_charged"] as const) {
    await assert.rejects(pipeline.reconcilePaidNode(run.id, { nodeId: "voice", expectedRunRevision: run.revision,
      reconciliationId: "unsafe-" + outcome, outcome, actor: "creator", note: "cannot replace an unknown request" }), /原请求/);
  }
  assert.deepEqual(await pipeline.loadPersisted(run.id), frozen);
  assert.equal(await jsonLineCount(submits), 3, "查询与禁止的重新购买都不得发送");
  const ledger = JSON.parse(await readFile(path.join(voiceRoot, ".voice-operations", createHash("sha256").update(operationId).digest("hex") + ".json"), "utf8"));
  const pending = ledger.items[2].metadataPath as string;
  await rename(pending + ".pending", pending);
  assert.equal((await pipeline.inspectPaidNode(run.id, "voice")).recommendedOutcome, "resume_original");
  run = await pipeline.reconcilePaidNode(run.id, { nodeId: "voice", expectedRunRevision: run.revision,
    reconciliationId: "original-character-response", outcome: "resume_original" });
  assert.equal(run.nodeRuns.find(n => n.nodeId === "voice")!.operationRequestId, operationId);
  assert.equal(await jsonLineCount(submits), 8, "只买未发送的后五句，前两句与迟到第三句复用");
  const voice = run.nodeRuns.find(n => n.nodeId === "voice")!;
  assert.equal(voice.status, "needs_human", JSON.stringify({ status: voice.status, error: voice.error, output: voice.output }));
  const output = voice.output as Record<string, any>;
  assert.equal(output.conflict.code, "NARRATION_TURN_DOES_NOT_FIT");
  const receipt = output.voiceSourceReceipt;
  assert.equal(receipt.groupAudioArtifacts.length, 8);
  const manifest = run.artifacts.find(a => a.id === receipt.manifestArtifactId)!;
  const manifestBytes = await readFile(manifest.uri!);
  assert.equal(JSON.parse(manifestBytes.toString()).version, "video-factory/voice-source-manifest-v2");
  assert.equal(manifest.schemaVersion, "video-factory/voice-source-manifest-v2");
  const request = { action: "relayout_narration" as const, intent: "apply" as const, requestId: "character-fit",
    expectedRunRevision: run.revision, interventionId: voice.intervention!.id, sourceContextId: initial.sourceContextId!, actor: "creator", note: "复用原声调整时间",
    source: { kind: "materialized_operation" as const, voiceInputVersionId: receipt.voiceInputVersionId,
      sourceVoiceOperationId: receipt.sourceOperationId, sourceManifestArtifactId: manifest.id,
      sourceManifestSha256: receipt.manifestSha256, sourceReceiptArtifactId: receipt.receiptArtifactId },
    layout: { narrationPlanVersion: plan.version, groups: plan.groups.map(g => ({ groupId: g.id, window: g.window, placement: g.placement })), userSilences: [] } };
  run = await pipeline.requestNarrationRevision(run.id, request);
  const resultVoice = run.nodeRuns.find(n => n.nodeId === "voice")!;
  assert.equal(run.status, "needs_human");
  assert.equal(resultVoice.status, "needs_human");
  assert.equal(synthesis, 2);
  assert.equal(layouts, 1);
  assert.deepEqual(await readFile(manifest.uri!), manifestBytes);
  const versions = resultVoice.outputState!.versions.length;
  assert.equal((await pipeline.requestNarrationRevision(run.id, request)).nodeRuns.find(n => n.nodeId === "voice")!.outputState!.versions.length, versions);
  await assert.rejects(pipeline.requestNarrationRevision(run.id, { ...request, note: "different" }), /不同内容/);
  await assert.rejects(pipeline.requestNarrationRevision(run.id, { ...request, requestId: "different-id" }), /更新|版本|停点|stale/i);
  const crashDir = path.join(workspaceRoot, "character-crashes");
  await mkdir(crashDir);
  const countPath = path.join(crashDir, "worker.jsonl"), eventPath = path.join(crashDir, "events.jsonl");
  for (const [i, crashPoint] of (["afterWorkerCompletion", "afterAdoptionCheckpoint"] as const).entries()) {
    run = await pipeline.loadPersisted(run.id);
    const v = run.nodeRuns.find(n => n.nodeId === "voice")!;
    const artifact = run.artifacts.find(a => v.outputState!.versions.find(o => o.id === v.outputState!.effectiveVersionId)!.artifactIds.includes(a.id) && a.kind === "voiceover_plan")!;
    const doc = JSON.parse(await readFile(artifact.uri!, "utf8"));
    const audio = run.artifacts.find(a => a.uri === doc.track_path)!;
    const crashRequest = { ...request, requestId: `character-crash-${i}`, expectedRunRevision: run.revision, interventionId: v.intervention!.id,
      source: { kind: "voice_version" as const, voiceVersionId: v.outputState!.effectiveVersionId, voicePlanArtifactId: artifact.id,
        voicePlanSha256: artifact.sha256!, expectedNarrationPlanSha256: createHash("sha256").update(canonicalJsonV2(doc.narrationPlan)).digest("hex"),
        expectedLayoutKey: doc.layoutKey, expectedAudioSha256: audio.sha256!, sourceVoiceOperationId: doc.voiceOperationId },
      layout: { ...request.layout, groups: request.layout.groups.map((g, index) => index ? g : { ...g, placement: { anchor: "start" as const, offsetFrames: i + 1 } }) } };
    const requestPath = path.join(crashDir, `request-${i}.json`);
    await writeFile(requestPath, JSON.stringify(crashRequest));
    const opts = { workspaceRoot, runId: run.id, requestId: crashRequest.requestId, action: "apply" as const, requestPath,
      countPath, eventPath, caseDirectory: crashDir };
    await runRelayoutCrashChild({ ...opts, label: `crash-${i}`, crashPoint, expectedExit: 86 + i });
    assert.equal(await jsonLineCount(countPath), i + 1);
    await new Promise(resolve => setTimeout(resolve, 2800));
    await runRelayoutCrashChild({ ...opts, label: `recover-${i}` });
    assert.equal(await jsonLineCount(countPath), i + 1, "恢复只采用原完成事实，不再启动worker");
    assert.equal((await pipeline.readNarrationRelayoutOperation(run.id, crashRequest.requestId)).state, "applied");
    const recovered = await pipeline.loadPersisted(run.id);
    const recoveredVoice = recovered.nodeRuns.find(n => n.nodeId === "voice")!;
    const current = recoveredVoice.outputState!.versions.find(v => v.id === recoveredVoice.outputState!.effectiveVersionId)!;
    assert.equal(recovered.artifacts.find(a => current.artifactIds.includes(a.id) && a.kind === "voiceover_plan")!.schemaVersion,
      "video-factory/voiceover-plan-v4", "恢复登记仍必须保留角色音轨版本");
  }
  assert.equal(synthesis, 2);
  assert.deepEqual(await readFile(manifest.uri!), manifestBytes);
});

it("MC-A03/08 invalid character edits keep the current stop; six roles save and read back without audit", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-character-edit-"));
  const { script } = JSON.parse(await readFile(path.join(repositoryRoot, "tests/fixtures/character-drama-cases.json"), "utf8"));
  const agents = jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] });
  let audits = 0;
  const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(), ...agents,
    assetProviders: REWORK_ASSET_PROVIDERS,
    screenwriterAgent: { ...agents.screenwriterAgent!, draft: async () => script, draftDetailed: async input => {
      if (input.creativeReviewExecution?.mode === "check") {
        audits++;
        return passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "编剧", "script-draft", "screenwriter-model-one");
      }
      return { output: script, trace: { taskKind: "script-draft", promptVersion: "v1", prompt: "controlled", providerId: "openai", modelId: "screenwriter-model-one" } };
    } },
  });
  const studio = new ProductionStudio({ workspaceRoot, pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [] });
  let run = await pipeline.start({ ...jointReworkBrief(), presentationMode: "character_drama" });
  let current = (await studio.creativeReview(run.id))!;
  assert.equal(current.stage, "treatment");
  run = await pipeline.confirmCreativeReview(run.id, { commandId: "mc-treatment", actor: "creator", stage: current.stage,
    expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256,
    expectedCheckIdentity: current.checkResult!.checkIdentity });
  current = (await studio.creativeReview(run.id))!;
  assert.equal(current.stage, "script");
  const original = await pipeline.loadPersisted(run.id);
  const command = (document: unknown, commandId: string) => ({ action: "edit_draft" as const, commandId, actor: "creator", stage: "script" as const,
    expectedRunRevision: current.runRevision, expectedReviewRevision: current.reviewRevision, baseDraftSha256: current.draftSha256,
    baseDraftVersionId: current.draftVersionId, document });
  for (const fault of ["missing-speaker", "empty-appearance", "wrong-mode"] as const) {
    const invalid = structuredClone(script);
    if (fault === "missing-speaker") invalid.scenes[0].dialogue[0].speaker_id = "no-such-role";
    if (fault === "empty-appearance") invalid.characters[0].appearance = "";
    if (fault === "wrong-mode") delete invalid.version;
    await assert.rejects(async () => { const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, command(invalid, "invalid-" + fault)); await dispatched.completion; });
    assert.deepEqual(await pipeline.loadPersisted(run.id), original, "无效稿不得消耗版本或把主制作打为失败");
  }
  const six = structuredClone(script);
  six.characters.push(...[5, 6].map(n => ({ id: "role_" + n, name: "新增角色" + n, kind: "character",
    appearance: "蓝色外套", personality: "", voice_intent: "", voice_profile_id: null })));
  six.scenes[0].dialogue[0].speaker_id = "role_6";
  const saved = await pipeline.dispatchCreativeReviewCommand(run.id, command(six, "six-roles"));
  await saved.completion;
  const readback = (await studio.creativeReview(run.id))!;
  assert.deepEqual(readback.draft, six);
  assert.notEqual(readback.draftVersionId, current.draftVersionId);
  assert.equal(audits, 1, "手改不自动再次审计");
  assert.equal((await pipeline.loadPersisted(run.id))!.status, "needs_human");
  assert.deepEqual(current.draft, script, "旧稿只读保留");
});

for (const optionalUnknown of [false, true]) it(`publish HTTP validates legacy dispositions before stripping and retains final approval (optional unknown=${optionalUnknown})`, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-publish-dispositions-http-"));
  const worker = new ReworkWorker();
  let visualCalls = 0;
  const pipeline = new ProductionPipeline({ workspaceRoot, worker,
    ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
    assetProviders: REWORK_ASSET_PROVIDERS,
    ...(optionalUnknown ? {
      providerRuntimeMetadata: [{ id: "deepseek-visual-review-v1", label: "受控视觉", modelId: "deepseek-flash",
        transport: "unix_socket" as const, billing: "subscription" as const, approvalPolicy: "none" as const, maxAttempts: 1 }],
      visualReviewAgents: [{ id: "deepseek-visual-review-v1", modelId: "deepseek-flash", async review(input) {
        visualCalls += 1;
        if (input.reviewStage === "rendered_video") throw new RoleAgentLoopError("原审计待核", {
          version: "video-factory/agent-loop-v1", role: "视觉审片员", contractVersion: "controlled",
          criteria: [], status: "failed", maxIterations: 1, iterations: [], failure: { stage: "uncertain" },
        }, undefined, new CodexBridgeError("受控原请求待核", false, "uncertain"));
        return { version: "video-factory/visual-review-v1" as const, summary: "受控源素材", scores: {
          composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 }, findings: [], confidence: .9, recommendation: "approve" as const };
      } }],
    } : {}),
  });
  const input = jointReworkBrief();
  input.workflowFeatures = { ...input.workflowFeatures!, boundaryGates: "user-confirmed-v1" };
  if (optionalUnknown) input.providers.visualReview = "deepseek-visual-review-v1";
  let run = await confirmGatedRework(pipeline, input);
  for (let step = 0; step < 16 && run.status === "needs_human"; step++) {
    const node = run.nodeRuns.find(item => item.status === "needs_human")!;
    if (node.nodeId === "publish-package") break;
    const intervention = node.intervention!;
    const output = node.output as Record<string, unknown>;
    run = await pipeline.decide(run.id, {
      action: "approve", actor: "owner", interventionId: intervention.id, expectedRunRevision: run.revision,
      reviewEvidenceId: intervention.evidenceId ?? (typeof output?.reviewEvidenceId === "string" ? output.reviewEvidenceId : null),
      ...(intervention.continuationScope ? { commandId: `http-setup-${step}`, acceptIncomplete: true as const } : {}),
    });
  }
  const publish = run.nodeRuns.find(node => node.status === "needs_human")!;
  assert.equal(publish?.nodeId, "publish-package", JSON.stringify(run.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, error: node.error }))));
  const final = run.interventions.findLast(item => item.nodeId === "final-review")!;
  const finalDecision = run.decisions.find(item => item.interventionId === final.id)!;
  const app = buildStudioApp({ service: new StudioService({ repositoryRoot, workspaceRoot, pipeline }), logger: false });
  t.after(() => app.close());
  let completion: Promise<unknown> | undefined;
  const dispatch = pipeline.dispatchDecision.bind(pipeline);
  t.mock.method(pipeline, "dispatchDecision", async (...args: Parameters<typeof dispatch>) => {
    const operation = await dispatch(...args);
    completion = operation.completion;
    return operation;
  });
  const payload = { interventionId: publish.intervention!.id, expectedRunRevision: run.revision, action: "approve",
    reviewEvidenceId: null, contentVersionId: publish.outputState!.effectiveVersionId, acceptUnauditedContent: true };
  const previous = await pipeline.loadPersisted(run.id);
  const originalCalls = visualCalls;
  const key = "a".repeat(64);
  for (const reviewDispositions of [[], [{ itemKey: "", decision: "accept_risk" }],
    [{ itemKey: key, decision: "accept_risk" }, { itemKey: key, decision: "accept_risk" }],
    [{ itemKey: key, decision: "invalid" }], [{ itemKey: key, decision: "reject" }]]) {
    const invalid = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload: { ...payload, reviewDispositions } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.deepEqual(await pipeline.loadPersisted(run.id), previous);
    assert.equal(visualCalls, originalCalls);
  }
  // 旧文案请求合法多带表态即可，不要求重新覆盖成片全部项目。
  const body = { ...payload, reviewDispositions: [{ itemKey: key, decision: "accept_risk" }] };
  const response = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload: body });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(completion);
  await completion;
  const accepted = await pipeline.loadPersisted(run.id);
  assert.equal(accepted.status, "succeeded");
  assert.equal(accepted.decisions.at(-1)?.reviewDispositions, undefined);
  assert.equal(accepted.decisions.at(-1)?.reviewDispositionBasis, undefined);
  assert.deepEqual(accepted.decisions.find(item => item.id === finalDecision.id), finalDecision);
  const artifact = accepted.artifacts.find(item => item.kind === "publish_package" && publish.artifactIds.includes(item.id))!;
  const packaged = JSON.parse(await readFile(artifact.uri!, "utf8"));
  assert.equal(packaged.approval.decisionId, finalDecision.id);
  assert.equal(packaged.approval.interventionId, final.id);
  if (optionalUnknown) {
    assert.equal(packaged.internalDelivery.machineVisualReview, "incomplete");
    assert.equal(packaged.internalDelivery.evidence.visual.status, "incomplete_unknown");
    const visual = accepted.nodeRuns.find(item => item.nodeId === "visual-review")!;
    assert.equal(visual.outcomeUncertain, true, "文案采用不得洗掉原审计unknown");
  }
  const replay = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload: body });
  assert.equal(replay.statusCode, 409, "普通文案批准仍拒绝旧revision重复提交，不扩通用重放");
  assert.deepEqual(await pipeline.loadPersisted(run.id), accepted);
  assert.equal(visualCalls, originalCalls, "采用与重放不能重发原审计");
});

it("replays scoped approval through the formal HTTP consumer before stale-page guards and allows local rework", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-decision-http-"));
  const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(),
    ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
    assetProviders: REWORK_ASSET_PROVIDERS,
    providerRuntimeMetadata: [{ id: "deepseek-visual-review-v1", label: "受控视觉", modelId: "deepseek-flash",
      transport: "unix_socket", billing: "subscription", approvalPolicy: "none", maxAttempts: 1 }],
    visualReviewAgents: [{ id: "deepseek-visual-review-v1", modelId: "deepseek-flash", review: async input => {
      if (input.reviewStage === "rendered_video") throw new RoleAgentLoopError("受控原请求待核", {
        version: "video-factory/agent-loop-v1", role: "视觉审片员", contractVersion: "controlled",
        criteria: [], status: "failed", maxIterations: 1, iterations: [], failure: { stage: "uncertain" },
      }, undefined, new CodexBridgeError("受控原请求待核", false, "uncertain"));
      return { version: "video-factory/visual-review-v1", summary: "受控源素材", scores: {
        composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 80 }, findings: [], confidence: .9, recommendation: "approve" };
    } }] });
  const input = jointReworkBrief();
  input.providers.visualReview = "deepseek-visual-review-v1";
  let run = await confirmCreativeStages(pipeline, await pipeline.start(input));
  run = await confirmCreativeStages(pipeline, run);
  const service = new StudioService({ repositoryRoot, workspaceRoot, pipeline });
  const app = buildStudioApp({ service, logger: false });
  const visual = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
  assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, error: node.error }))));
  const payload = { commandId: "http-same-approval", interventionId: visual.intervention!.id, expectedRunRevision: run.revision,
    action: "approve", acceptIncomplete: true, reviewEvidenceId: visual.intervention!.evidenceId };
  const preserved = await pipeline.loadPersisted(run.id);
  try {
    for (const [nodeId, field, mode] of [
      ["voice", "trackPath", "missing"], ["render", "videoPath", "missing"],
      ["render", "renderManifestPath", "bytes"], ["voice", "trackPath", "outside"],
    ] as const) {
      const uri = (run.nodeRuns.find(node => node.nodeId === nodeId)!.output as Record<string, string>)[field]!;
      const backup = `${uri}.controlled-backup`;
      const original = await readFile(uri);
      await rename(uri, backup);
      const outside = path.join(workspaceRoot, "controlled-outside-audio");
      try {
        if (mode === "bytes") await writeFile(uri, Buffer.alloc(original.length, 120));
        if (mode === "outside") { await writeFile(outside, original); await symlink(outside, uri); }
        const rejected = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`,
          payload: { ...payload, commandId: `invalid-${nodeId}-${field}-${mode}` } });
        assert.equal(rejected.statusCode, 409, rejected.body);
        assert.deepEqual(await pipeline.loadPersisted(run.id), preserved, "媒体拒绝不能先签字或消耗确认点");
      } finally { await rm(uri, { force: true }); await rename(backup, uri); }
    }
    const first = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload });
    assert.equal(first.statusCode, 200, first.body.slice(0, 200));
    // 停点checkpoint早于后台租约释放；只读等原写者结束，不重发决定抢锁。
    const leasePath = path.join(workspaceRoot, "runs", run.id, ".execution-lease.json.lock");
    let writerFinished = false;
    for (let i = 0; i < 100; i++) {
      try { await access(leasePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        writerFinished = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(writerFinished, true, "原HTTP决定的后台写者必须已结束");
    const adopted = await pipeline.loadPersisted(run.id);
    assert.equal(adopted.nodeRuns.find(node => node.nodeId === "final-review")?.status, "needs_human");
    const replay = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload });
    assert.equal(replay.statusCode, 200, replay.body.slice(0, 200));
    assert.deepEqual(await pipeline.loadPersisted(run.id), adopted);
    const changed = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`, payload: { ...payload, note: "异body" } });
    assert.equal(changed.statusCode, 409, changed.body);
    const render = adopted.nodeRuns.find(node => node.nodeId === "render")!;
    const version = render.inputState!.versions.find(item => item.id === render.inputState!.effectiveVersionId)!;
    const edited = await app.inject({ method: "PUT", url: `/api/runs/${run.id}/nodes/render/input-override`, payload: {
      expectedRunRevision: adopted.revision, expectedVersionId: version.id, allowTerminalEdit: true,
      input: { ...version.value as Record<string, unknown>, creatorNote: "显式修改，保持原声音素材" } } });
    assert.equal(edited.statusCode, 200, edited.body);
    const revised = await pipeline.loadPersisted(run.id);
    assert.equal(revised.status, "stale");
    assert.equal(revised.nodeRuns.find(node => node.nodeId === "final-review")?.status, "stale");
    assert.equal(revised.nodeRuns.find(node => node.nodeId === "voice")?.outputState?.effectiveVersionId,
      adopted.nodeRuns.find(node => node.nodeId === "voice")?.outputState?.effectiveVersionId);
    const staleApprove = await app.inject({ method: "POST", url: `/api/runs/${run.id}/decisions`,
      payload: { ...payload, commandId: "new-command-old-version" } });
    assert.equal(staleApprove.statusCode, 409);
    assert.deepEqual(await pipeline.loadPersisted(run.id), revised);
  } finally { await app.close(); }
});
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
async function controlledVoiceWorker(request: Record<string, unknown>, holdThird = false): Promise<WorkerResponse> {
  const script = `
import sys, json, hashlib, subprocess, io
from pathlib import Path
from unittest.mock import patch
from video_factory.worker import handle_request
request = json.load(sys.stdin)
recover = request['input'].get('recover_subtitles') is True
def synthesize(http_request, audio, metadata_path=None, response_binding=None):
    if recover: raise AssertionError('subtitle recovery entered paid synthesis')
    counts = Path(request['outputDir']).parent / 'controlled-submissions.jsonl'
    with counts.open('a') as log: log.write(json.dumps(response_binding) + '\\n')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', str(audio)], check=True)
    metadata_path.write_text(json.dumps({'request': response_binding, 'audio_sha256': hashlib.sha256(audio.read_bytes()).hexdigest(), 'audio_size_bytes': audio.stat().st_size, 'subtitle_file': 'https://example.org/original-subtitles.json'}))
    if ${holdThird ? "True" : "False"} and len(counts.read_text().splitlines()) == 3:
        metadata_path.rename(str(metadata_path) + '.pending')
        raise TimeoutError('accepted without response')
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
      }] : []), ...(capability === "voice.synthesize" ? [{
        kind: "narration_track", uri: String(output.trackPath),
        sha256: createHash("sha256").update("audio").digest("hex"), sizeBytes: 5,
        contentType: "audio/mp4", provenance: { providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId), attempt: Number(request.attempt) },
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
    const stage = (gateNode.output as { creativeReview?: { stages?: Record<string, { currentDraft?: { versionId: string }; checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[gate.stage];
    const shown = stage?.checkResult;
    run = await pipeline.confirmCreativeReview(run.id, {
      commandId: `confirm-${gate.stage}-${index + 1}`,
      actor: "producer",
      expectedRunRevision: run.revision,
      expectedReviewRevision: gate.reviewRevision,
      stage: gate.stage,
      baseDraftSha256: gate.draftSha256,
      ...(stage?.currentDraft ? { baseDraftVersionId: stage.currentDraft.versionId } : {}),
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

  for (const durationMode of ["legacy", "content-led-v1"] as const) it(`registers real manifest and receipt artifacts when the first v2 fit conflicts (§4.2.4, ${durationMode})`, async () => {
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
    if (durationMode === "content-led-v1") {
      brief.durationPolicy = durationMode;
      delete brief.durationRange;
    }
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
    const studio = new ProductionStudio({ workspaceRoot, pipeline, listProviders: async () => [],
      archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} } });
    if (durationMode === "content-led-v1") {
      assert.equal((await studio.get(stopped.id))!.continuation?.supported, true);
      await assert.rejects(studio.reworkDraft(stopped.id), /失败、已打回或已完成/,
        "新版无range不能被误认旧版，只能先在当前停点处理或明确终止");
      assert.deepEqual(await pipeline.loadPersisted(stopped.id), stopped);
    }
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
    if (durationMode === "content-led-v1") {
      const terminated = await pipeline.decide(relayoutedA2.id, { interventionId: voiceA2.intervention!.id,
        action: "reject", actor, note: "准备重新安排剧本与镜头时长", expectedRunRevision: relayoutedA2.revision,
        reviewEvidenceId: null });
      assert.equal(terminated.status, "rejected");
      const rework = await studio.reworkDraft(terminated.id);
      assert.equal(rework!.input.durationPolicy, "content-led-v1");
      assert.equal(rework!.input.durationRange, undefined);
      assert.equal(rework!.input.rework!.sourceRunId, terminated.id);
      assert.equal(rework!.input.rework!.sourceRunRevision, terminated.revision);
      assert.ok(rework!.input.rework!.previousScript && rework!.input.rework!.previousDirectorPlan);
      assert.equal(worker.synthesisCalls, 1, "终止与打开关联草稿都不能购买声音");
      assert.equal(worker.relayoutCalls, 4);
      for (const [sourcePath, originalBytes] of immutableSourceBytes) {
        assert.deepEqual(await readFile(sourcePath), originalBytes, "终止与返工草稿保留原音轨和费用账本");
      }
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

describe("F01 series unaudited revision can enter normal production (2026-10-02)", () => {
  // 事故链复现：正式 Store 建栏目 → 正式 revise-current（未审状态）→ 收件箱显式采用 →
  // 正常 POST /api/runs（Idempotency-Key + 受控真实 Pipeline）。修复前：服务端可信
  // seriesContext 携带 not_audited 被 parseBrief 拒绝，返回笼统 400「制作参数不符合要求」。
  function f01SeriesInput(suffix: string) {
    return {
      name: `F01 未审修订系列 ${suffix}`,
      premise: `每集围绕一个可核对的小问题（${suffix}）`,
      audience: "普通观众",
      platform: "douyin",
      category: "education",
      track: `f01-${suffix}`,
      pillars: ["可核对"],
      tone: "具体",
      visualStyle: "本地示意卡",
      targetEpisodeCount: 2,
    };
  }

  function f01RunInput(opportunity: { id: string; title: string; hook: string; audience: string; track: string }) {
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
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      providers: {
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "local-editorial-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true,
        creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1", boundaryGates: "user-confirmed-v1" },
      director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
      economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    };
  }

  async function f01BuildApp(workspaceRoot: string) {
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(),
      ...jointReworkAgents({ treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] }),
      assetProviders: REWORK_ASSET_PROVIDERS });
    let seriesCounter = 0;
    const service = new StudioService({
      repositoryRoot,
      workspaceRoot,
      pipeline,
      commandAvailable: async () => true,
      environment: {},
      codexAvailability: { available: true, reason: "受控测试：固定本地角色，不连接 Codex broker。",
        taskKinds: ["script-draft", "creative-treatment", "director-plan", "role-audit"],
        modelId: "controlled-f01", modelCandidates: [] },
      createSeriesId: () => `f01-series-${++seriesCounter}`,
      seriesPlanningAgent: {
        reviewEpisode: async () => { throw new Error("adopting an unaudited revision must not audit"); },
        reviseEpisode: async (_series, episode) => ({
          draft: {
            episodeNumber: episode.episodeNumber, pillar: episode.pillar, title: episode.title,
            viewerPromise: episode.viewerPromise, hook: "先给一个可核对的问题", payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious], toNext: [...episode.continuity.toNext],
          },
          planning: { ...episode.planning, source: "agent" as const, auditStatus: "not_audited" as const, auditIterations: 0 },
        }),
      },
    });
    const app = buildStudioApp({ service, logger: false });
    return { app, pipeline };
  }

  // 正式路径到「未审采用后的正常创建」；返回 POST 响应与系列事实，供主链与负例复用。
  async function f01ReviseAndAdopt(app: ReturnType<typeof buildStudioApp>, suffix: string) {
    const created = await app.inject({ method: "POST", url: "/api/series", payload: f01SeriesInput(suffix) });
    assert.equal(created.statusCode, 201, created.body);
    const series = created.json();
    const revised = await app.inject({ method: "POST", url: `/api/series/${series.id}/episodes/1/revise-current`,
      payload: { expectedRevision: series.revision, instruction: "把开场写成一个具体问题" } });
    assert.equal(revised.statusCode, 200, revised.body);
    const revisedSeries = revised.json();
    const episode = revisedSeries.episodes.find((item: { episodeNumber: number }) => item.episodeNumber === 1);
    assert.equal(episode.planning.auditStatus, "not_audited", "修订后的单集必须保持真实未审事实");
    assert.ok(episode.contentVersionId, "修订必须建立新的内容版本");
    const inbox = await app.inject({ method: "GET", url: "/api/candidate-inbox?origins=series&limit=100" });
    assert.equal(inbox.statusCode, 200, inbox.body);
    const candidate = inbox.json().items.find((item: { seriesId?: string; episodeNumber?: number }) =>
      item.seriesId === series.id && item.episodeNumber === 1);
    assert.ok(candidate, `系列 ${series.id} 的第 1 集候选必须出现在收件箱`);
    const adopted = await app.inject({ method: "POST", url: `/api/candidate-inbox/${candidate.id}/adopt`,
      payload: { origin: "series", ...(candidate.generationId ? { expectedGenerationId: candidate.generationId } : {}) } });
    assert.equal(adopted.statusCode, 201, adopted.body);
    return { series: revisedSeries, opportunity: adopted.json() };
  }

  it("creates the run from a series episode adopted while genuinely unaudited", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f01-series-create-"));
    const { app, pipeline } = await f01BuildApp(workspaceRoot);
    const errors: string[] = [];
    const errorCapture = mock.method(app.log, "error", (error: unknown) => {
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
    });
    try {
      const { series, opportunity } = await f01ReviseAndAdopt(app, "main");
      const listed = (await app.inject({ method: "GET", url: "/api/series" })).json()
        .find((item: { id: string }) => item.id === series.id);
      const adopted = listed.episodes.find((item: { episodeNumber: number }) => item.episodeNumber === 1);
      assert.equal(adopted.status, "selected");
      assert.equal(adopted.adoption.auditStatus, "not_audited", "采用记录必须保留未审事实");
      const response = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-series-run-main-1" }, payload: f01RunInput(opportunity) });
      assert.equal(response.statusCode, 202, `${response.body}\n${errors.join("\n")}`);
      const started = response.json();
      assert.ok(started.runId, "202 必须返回真实 runId");
      const detail = (await app.inject({ method: "GET", url: `/api/runs/${started.runId}` })).json();
      assert.equal(detail.creationOrigin, "series");
      assert.equal(detail.seriesId, series.id);
      assert.equal(detail.episodeNumber, 1);
      assert.ok(detail.productionReservationId, "run 必须绑定系列生产预留");
      // 未审事实不因开拍被改写：run 的正式 brief 仍携带 not_audited。
      const persisted = await pipeline.loadPersisted(started.runId);
      assert.equal(persisted.initialInput.seriesContext.episode.planning.auditStatus, "not_audited");
      assert.equal(persisted.initialInput.seriesContext.episode.contentVersionId, adopted.contentVersionId,
        "创建必须携带采用绑定的内容版本");
      // 创建后停在第一个人工节点（brief 边界闸门或创作规划），不是 failed。
      let settled = detail;
      for (let poll = 0; poll < 100 && settled.status === "running"; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        settled = (await app.inject({ method: "GET", url: `/api/runs/${started.runId}` })).json();
      }
      assert.equal(settled.status, "needs_human",
        `run 必须停在首个人工停点，而不是 ${settled.status}（${settled.nodes?.map((node: { nodeId: string; status: string; error?: string }) => `${node.nodeId}:${node.status}`).join(",")}）`);
      assert.ok(settled.nodes.some((node: { status: string }) => node.status === "needs_human"));
      const seriesAfter = (await app.inject({ method: "GET", url: "/api/series" })).json()
        .find((item: { id: string }) => item.id === series.id);
      const episodeAfter = seriesAfter.episodes.find((item: { episodeNumber: number }) => item.episodeNumber === 1);
      assert.equal(episodeAfter.status, "in_production");
      assert.equal(episodeAfter.runId, started.runId);
      assert.equal(episodeAfter.planning.auditStatus, "not_audited", "开拍不等于补审");

      // 同幂等键同 body 重放返回原 run；不产生第二条。
      const replay = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-series-run-main-1" }, payload: f01RunInput(opportunity) });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(replay.json().runId, started.runId);
      const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
      assert.equal(runs.filter((run: { seriesId?: string }) => run.seriesId === series.id).length, 1);
    } finally {
      errorCapture.mock.restore();
      await app.close();
    }
  });

  it("keeps the identity and reservation negatives for unaudited series creation (D02)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f01-series-negative-"));
    const { app } = await f01BuildApp(workspaceRoot);
    try {
      // 未采用：没有机会记录，创建被拒且不产生 run。
      const notAdopted = (await app.inject({ method: "GET", url: "/api/series" })).json().at(0)
        ?? (await app.inject({ method: "POST", url: "/api/series", payload: f01SeriesInput("neg-noadopt") })).json();
      const bare = f01RunInput({ id: "missing-opportunity", title: notAdopted.episodes[0].title,
        hook: notAdopted.episodes[0].hook, audience: notAdopted.audience, track: notAdopted.track });
      bare.creationContext = { origin: "series", opportunityId: "missing-opportunity" };
      const missing = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-neg-missing-1" }, payload: bare });
      assert.equal(missing.statusCode, 400);
      assert.match(missing.json().error, /没有找到与这次制作对应的机会/);

      const { opportunity } = await f01ReviseAndAdopt(app, "neg");
      const payload = f01RunInput(opportunity);
      // 同幂等键异 body：409，不新增 run。
      const first = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-neg-clash-1" }, payload });
      assert.equal(first.statusCode, 202, first.body);
      const clash = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-neg-clash-1" }, payload: { ...payload, durationSeconds: 24 } });
      assert.equal(clash.statusCode, 409);
      assert.match(clash.json().error, /已被另一组参数使用/);
      const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
      assert.equal(runs.filter((run: { opportunityId?: string }) => run.opportunityId === opportunity.id).length, 1,
        "幂等冲突不能产生第二条 run");

      // 已占用单集：再次用同一机会创建被拒（预留/绑定事实由 Store 裁决）。
      const occupied = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-neg-occupied-1" }, payload });
      assert.equal(occupied.statusCode, 409, occupied.body);
      assert.match(occupied.json().error, /已经被其他制作占用|尚未采用/);
    } finally {
      await app.close();
    }
  });

  it("rejects a creation whose adoption no longer matches the current content version (D02 stale adoption)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f01-series-stale-"));
    const { app } = await f01BuildApp(workspaceRoot);
    try {
      const { series } = await f01ReviseAndAdopt(app, "stale");
      // 构造遗留漂移形态：持久化 Store 中采用记录指向旧内容版本（正式路由无法产生，
      // 直接以既有 JSON 文件接缝写入，模拟历史写者留下的不一致）。
      const storePath = path.join(workspaceRoot, "series", "series.json");
      const stored = JSON.parse(await readFile(storePath, "utf8"));
      const storedSeries = stored.series.find((item: { id: string }) => item.id === series.id);
      const storedEpisode = storedSeries.episodes.find((item: { episodeNumber: number }) => item.episodeNumber === 1);
      storedEpisode.adoption = { ...storedEpisode.adoption, targetVersionId: "version-stale-legacy" };
      await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`);
      // 用已采用机会的创建必须被采用版本一致性检查拒绝。
      const adoptedOpportunity = (await app.inject({ method: "GET", url: "/api/opportunities?origin=series" })).json()
        .find((item: { seriesId?: string }) => item.seriesId === series.id);
      assert.ok(adoptedOpportunity, "采用后必须能查到机会");
      const response = await app.inject({ method: "POST", url: "/api/runs",
        headers: { "idempotency-key": "f01-stale-1" }, payload: f01RunInput(adoptedOpportunity) });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /当前稿已经更新|不再对应当前版本/);
      const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
      assert.equal(runs.filter((run: { seriesId?: string }) => run.seriesId === series.id).length, 0,
        "拒绝不能留下预留泄漏或半成品 run");
    } finally {
      await app.close();
    }
  });
});

for (const failureMode of ["current", "invalid_returned", "legacy_trace_only", "legacy_prepared", "unknown"] as const) {
it(`keeps a preserved script editable after downstream generation failure (${failureMode})`, async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-planning-generation-recovery-"));
  const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
  const agents = jointReworkAgents(spies);
  const original = agents.directorAgent!.planDetailed!;
  let directorAttempts = 0;
  agents.directorAgent!.planDetailed = async (...args) => {
    if (args[0].creativeReviewExecution?.mode !== "check" && ++directorAttempts === 1) {
      if (failureMode === "invalid_returned") {
        await runRoleAgentLoop({ role: "导演", contractVersion: "controlled", criteria: ["来源必须可用"], maxIterations: 1,
          produce: async () => ({ output: { invalid: true } }),
          audit: async () => { throw new Error("无效生成不得调用审计"); },
          validate: () => { throw new Error("unavailable source in returned plan"); } });
        throw new Error("应拒绝已返回的无效导演方案");
      }
      throw new RoleAgentLoopError("受控导演结构不符合合同", {
        version: "video-factory/agent-loop-v1", role: "视觉导演", contractVersion: "controlled",
        criteria: [], status: "failed", maxIterations: 1, iterations: [], failure: { stage: failureMode === "unknown" ? "uncertain" : "completed_failure" },
      }, undefined, failureMode.startsWith("legacy_") ? undefined : new CodexBridgeError("受控导演结构不符合合同", false,
        failureMode === "unknown" ? "uncertain" : "completed_failure", 422,
        undefined, { category: "invalid_output", reasonCode: "task_schema", providerId: "controlled", modelId: "controlled" }));
    }
    return original(...args);
  };
  const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(), ...agents,
    assetProviders: REWORK_ASSET_PROVIDERS });
  const studio = new ProductionStudio({ workspaceRoot, pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [] });
  let run = await pipeline.start(jointReworkBrief());
  for (const stage of ["treatment", "script"] as const) {
    const shown = (await studio.creativeReview(run.id))!;
    assert.equal(shown.stage, stage);
    run = await pipeline.confirmCreativeReview(run.id, { commandId: `adopt-${stage}`, actor: "creator", stage,
      expectedRunRevision: run.revision, expectedReviewRevision: shown.reviewRevision,
      baseDraftSha256: shown.draftSha256, expectedCheckIdentity: shown.checkResult!.checkIdentity });
  }
  assert.equal(directorAttempts, 1);
  if (failureMode === "current" || failureMode === "invalid_returned") {
    assert.equal(run.status, "needs_human", "已核清的生成失败应保留可操作停点，无须先把制作判死");
    const saved = run.nodeRuns.find(node => node.nodeId === "creative-planning")!.output as {
      creativeReview: { stages: { script: { confirmationHistory: unknown[] }; director: { currentDocument: unknown } } }; planningStop: { detail: string } };
    assert.equal(saved.creativeReview.stages.script.confirmationHistory.length, 1, "原采用记录保留");
    assert.equal(saved.creativeReview.stages.director.currentDocument, null, "失败不能虚构导演稿");
    assert.match(saved.planningStop.detail, /导演方案生成没有完成/);
  }
  // 兼容云端已发生的 failed→显式恢复形态；新执行可以直接保留人工停点。
  if (run.status === "failed") {
    const output = run.nodeRuns.find(node => node.nodeId === "creative-planning")!.output as {
      creativeReview: { reviewRevision: number; stages: { script: { currentDraft: { artifactId: string; versionId: string; sha256: string } } } };
    };
    const draft = output.creativeReview.stages.script.currentDraft;
    const preparation = {
      commandId: "prepare-failed-director", expectedRunRevision: run.revision, nodeId: "creative-planning", stage: "script",
      targetArtifactId: draft.artifactId, targetVersionId: draft.versionId, targetSha256: draft.sha256,
    } as const;
    if (failureMode === "unknown") {
      await assert.rejects(() => pipeline.prepareReviewContinuation(run.id, preparation), /原结果尚未核清/);
      assert.equal(directorAttempts, 1, "unknown 不能被恢复动作换成新生成");
      assert.deepEqual(await pipeline.loadPersisted(run.id), run, "拒绝恢复不能破坏原稿或请求身份");
      return;
    }
    if (failureMode === "legacy_prepared") {
      // 历史持久化夹具：旧prepare只恢复run的人工停点，未动图。不能调用新版prepare，
      // 否则它会先修好图，遗漏用户已在旧版点击恢复后直接保存的实际故障入口。
      const legacy = structuredClone(run);
      legacy.status = "needs_human";
      legacy.revision += 1;
      const node = legacy.nodeRuns.find(item => item.nodeId === "creative-planning")!;
      assert.ok(node.error, "旧恢复保留原失败与当前trace，不能凭空构造失败豁免");
      node.status = "needs_human";
      node.intervention = {
        id: "legacy-prepared-gate", nodeId: "creative-planning", kind: "creative_review",
        reason: "历史版本已恢复保留稿", requiredAction: "approve", options: ["approve", "request_changes"],
        createdAt: "2026-10-06T00:00:00.000Z",
        continuation: { stage: "script", reviewRevision: output.creativeReview.reviewRevision, draftSha256: draft.sha256 },
      };
      legacy.interventions = [...legacy.interventions.filter(item => item.nodeId !== "creative-planning"), node.intervention];
      await new FileRunStore(path.join(workspaceRoot, "runs")).save(legacy, run.revision);
      run = await pipeline.loadPersisted(run.id);
    } else {
      run = await pipeline.prepareReviewContinuation(run.id, preparation);
      assert.deepEqual(await pipeline.prepareReviewContinuation(run.id, preparation), run, "准备同体重放不再次移动图游标");
    }
  }
  assert.equal(run.status, "needs_human");
  const snapshot = (await studio.creativeReview(run.id))!;
  assert.equal(snapshot.stage, "script");
  const document = structuredClone(snapshot.draft) as { scenes: Array<{ narration: string }> };
  document.scenes[0]!.narration = "用户保存的新开头";
  const editing = await pipeline.dispatchCreativeReviewCommand(run.id, {
    action: "edit_draft", commandId: "edit-after-director-failure", actor: "creator", stage: "script",
    expectedRunRevision: run.revision, expectedReviewRevision: snapshot.reviewRevision,
    baseDraftSha256: snapshot.draftSha256, document,
  });
  run = await editing.completion;
  assert.equal(directorAttempts, 1, "保存上游脚本不能暗中重发下游导演生成");
  const edited = (await studio.creativeReview(run.id))!;
  assert.equal(edited.stage, "script");
  assert.deepEqual(edited.draft, document, "本次修改必须应用到真实图停点，不能被吞掉");
  assert.equal(edited.checkResult, undefined, "手动修改后不得自动补审");
  assert.equal(spies.treatmentCalls, 1);
  assert.equal(spies.screenwriterBodies.length, 1);
  const adoption = { commandId: "continue-after-edit", actor: "creator", stage: "script" as const,
    expectedRunRevision: run.revision, expectedReviewRevision: edited.reviewRevision,
    baseDraftSha256: edited.draftSha256, acknowledgeUnaudited: true as const };
  run = await pipeline.confirmCreativeReview(run.id, adoption);
  assert.equal(directorAttempts, 2, "只有用户明确采用才重新生成下游");
  assert.equal((await studio.creativeReview(run.id))!.stage, "director", "恢复后能到达真实导演稿确认，不跳过它");
  assert.equal(spies.directorInputs.at(-1)!.scenes[0]!.narration, "用户保存的新开头", "导演必须使用修改后的脚本");
  assert.deepEqual(await pipeline.confirmCreativeReview(run.id, adoption), run, "同一采用重放不再次生成");
  assert.equal(directorAttempts, 2);
});
}

describe("F03 explicit preparation restores a historically failed creative stop (D06)", () => {
  it("recovers the preserved workbench through the formal route with idempotent receipts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f03-prepare-"));
    const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
    const worker = new ReworkWorker();
    const baseOptions = {
      workspaceRoot, worker,
      ...jointReworkAgents(spies),
      assetProviders: REWORK_ASSET_PROVIDERS,
    };
    const pipeline = new ProductionPipeline(baseOptions);
    const service = new StudioService({ workspaceRoot, pipeline, commandAvailable: async () => true, environment: {} });
    const app = buildStudioApp({ service, logger: false });
    try {
      const input = jointReworkBrief();
      input.workflowFeatures = { ...input.workflowFeatures, boundaryGates: "user-confirmed-v1" };
      let run = await pipeline.start(input);
      // 放行 brief 边界闸门，再确认构思与脚本；停在导演创作确认关——那里有保留的当前稿。
      for (let index = 0; index < 8; index += 1) {
        if (run.status !== "needs_human") break;
        const planning = run.nodeRuns.find((node) => node.status === "needs_human" && node.nodeId === "creative-planning")?.intervention;
        if (planning?.kind === "creative_review" && planning.continuation?.stage === "director") break;
        if (planning?.kind === "creative_review" && planning.continuation) {
          const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
          const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[planning.continuation.stage]?.checkResult;
          run = await pipeline.confirmCreativeReview(run.id, {
            commandId: `d06-confirm-${planning.continuation.stage}-${index + 1}`,
            actor: "tester",
            expectedRunRevision: run.revision,
            expectedReviewRevision: planning.continuation.reviewRevision,
            stage: planning.continuation.stage,
            baseDraftSha256: planning.continuation.draftSha256,
            ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
            ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
          });
          continue;
        }
        const boundary = run.nodeRuns.find((node) => node.status === "needs_human"
          && node.nodeId !== "creative-planning"
          && node.intervention?.boundary === "node-complete")?.intervention;
        if (!boundary) break;
        run = await pipeline.decide(run.id, {
          interventionId: boundary.id, action: "approve", actor: "tester",
          expectedRunRevision: run.revision, reviewEvidenceId: null,
        });
      }
      const gate = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.intervention;
      assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
      assert.equal(gate?.kind, "creative_review", "必须停在导演创作确认关");
      assert.equal(gate.continuation?.stage, "director");
      // 当前合同：目录漂移拒绝这次采用，但不把保留的导演稿和工作台判死。
      const incompatible = new ProductionPipeline({
        ...baseOptions,
        assetProviders: REWORK_ASSET_PROVIDERS.map((provider) => ({ ...provider, deliveryTypes: ["stock_image"] })),
      });
      const directorShown = (run.nodeRuns.find((node) => node.nodeId === "creative-planning")!.output as {
        creativeReview?: { stages?: Record<string, { checkResult?: { checkIdentity?: string } }> };
      })?.creativeReview?.stages?.director?.checkResult;
      await assert.rejects(() => incompatible.confirmCreativeReview(run.id, {
        commandId: "confirm-drift", actor: "tester", stage: gate.continuation!.stage,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.continuation!.reviewRevision,
        baseDraftSha256: gate.continuation!.draftSha256,
        ...(directorShown?.checkIdentity ? { expectedCheckIdentity: directorShown.checkIdentity } : {}),
      }), HumanDecisionConflictError);
      assert.deepEqual(await pipeline.loadPersisted(run.id), run, "字段拒绝不能消耗确认点或改写原稿");
      // 兼容旧失败形态：用正式runner在审计消费边界抛错并真实checkpoint，
      // 不直接改run.json/status。它保留旧版工作台，供新准备动作恢复。
      const store = new FileRunStore(path.join(workspaceRoot, "runs"));
      const historicalRunner = new WorkflowRunner({ providers: new ProviderRegistry(), checkpoint: async snapshot => {
        const current = await store.load(snapshot.id);
        if (snapshot.revision === current.revision) await store.checkpoint(snapshot);
        else await store.save(snapshot, current.revision);
      } });
      const failedRun = await historicalRunner.continueWaitingNode({ id: run.workflowId, version: run.workflowVersion,
        name: "历史审计异常兼容fixture", nodes: [{ id: "creative-planning", label: "创作规划", capability: "storyboard.plan", mode: "automatic",
          execute: () => { throw new Error("Historical optional audit consumer failed after preserving its draft."); } }] }, run, "creative-planning", { action: "audit_current" });
      assert.equal(failedRun.status, "failed", failedRun.nodeRuns.map((n) => n.error).join(";"));

      // 显式准备：恢复保留的创作工作台，不签字、不补审、无新模型调用。
      const beforeCalls = JSON.stringify(spies);
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const preservedDraft = (failedRun.nodeRuns.find((node) => node.nodeId === "creative-planning")!.output as {
        creativeReview: { stages: { director: { currentDraft: { artifactId: string; versionId: string; sha256: string } } } };
      }).creativeReview.stages.director.currentDraft;
      const prepareInput = {
        commandId: "prepare-d06", expectedRunRevision: failedRun.revision,
        nodeId: "creative-planning", stage: "director",
        targetArtifactId: preservedDraft.artifactId,
        targetVersionId: preservedDraft.versionId,
        targetSha256: preservedDraft.sha256,
      };
      const failedDetail = (await fetch(`${origin}/api/runs/${failedRun.id}`));
      assert.equal(failedDetail.status, 200);
      const failedProjection = await failedDetail.json();
      assert.deepEqual(failedProjection.reviewContinuationTargets?.[0], { nodeId: "creative-planning", stage: "director",
        reviewPurpose: "direction", targetArtifactId: preservedDraft.artifactId,
        targetVersionId: preservedDraft.versionId, targetSha256: preservedDraft.sha256 },
      "失败页从正式详情获得当前恢复目标，不猜历史最后文件或自行制造采用资格");
      const stale = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...prepareInput, commandId: "prepare-d06-stale", expectedRunRevision: failedRun.revision + 1 }),
      });
      assert.equal(stale.status, 409, "过期页面不能恢复或消耗当前确认点");
      assert.equal((await pipeline.loadPersisted(failedRun.id)).revision, failedRun.revision);
      const wrongVersion = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...prepareInput, commandId: "prepare-d06-wrong-version", targetVersionId: "version-not-current" }),
      });
      assert.equal(wrongVersion.status, 409, "恢复必须绑定用户实际查看的不可变稿版本");
      assert.equal((await pipeline.loadPersisted(failedRun.id)).revision, failedRun.revision);
      const prepared = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepareInput),
      });
      const preparedText = await prepared.text();
      assert.equal(prepared.status, 200, preparedText);
      const detail = JSON.parse(preparedText);
      assert.equal(detail.status, "needs_human", "准备后 run 回到人工停点");
      assert.equal(JSON.stringify(spies), beforeCalls, "准备动作零模型调用");
      const savedPreparation = await pipeline.loadPersisted(failedRun.id);
      const diagnostic = savedPreparation.artifacts.find(artifact =>
        artifact.schemaVersion === "video-factory/optional-review-continuation-v1");
      assert.ok(diagnostic?.uri, "恢复停点必须有不可变宿主诊断，不只是一条可变提示");
      const proof = JSON.parse(await readFile(diagnostic.uri, "utf8"));
      assert.equal(proof.scope, "creative_stage");
      assert.equal(proof.target.versionId, preservedDraft.versionId);
      assert.equal(proof.target.sha256, preservedDraft.sha256);
      assert.equal(proof.adoptionEligibility, "eligible");
      assert.equal(savedPreparation.decisions.length, failedRun.decisions.length, "准备不是采用签字");
      const workbench = await fetch(`${origin}/api/runs/${failedRun.id}/creative-review`);
      assert.equal(workbench.status, 200);
      const snapshot = await workbench.json();
      assert.ok(snapshot.stage, "创作工作台恢复");
      assert.equal(snapshot.phase, "waiting_user");
      assert.ok(snapshot.draft, "保留的当前稿可读");

      // 同 commandId 同 body：幂等返回同一停点，不新建确认点。
      const readOnlyReceiptRevision = (await pipeline.loadPersisted(failedRun.id)).revision;
      await service.getRun(failedRun.id);
      assert.equal((await pipeline.loadPersisted(failedRun.id)).revision, readOnlyReceiptRevision, "读取详情不隐式准备或推进");
      const replay = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepareInput),
      });
      const replayText = await replay.text();
      assert.equal(replay.status, 200, replayText);
      assert.equal(JSON.parse(replayText).revision, detail.revision, "幂等重放不推进 revision");
      assert.equal((await pipeline.loadPersisted(failedRun.id)).artifacts.filter(artifact =>
        artifact.schemaVersion === "video-factory/optional-review-continuation-v1").length, 1);

      // 同 commandId 异 body：409。
      const clash = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...prepareInput, expectedRunRevision: failedRun.revision + 1 }),
      });
      assert.equal(clash.status, 409);

      // 只读回执：applied + isCurrent。
      const preparedDetail = await service.getRun(failedRun.id);
      assert.equal(preparedDetail?.activeIntervention?.nodeId, "creative-planning");
      const receipt = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations/prepare-d06`);
      assert.equal(receipt.status, 200);
      const receiptBody = await receipt.json();
      assert.equal(receiptBody.state, "applied");
      assert.equal(receiptBody.isCurrent, true);
      assert.deepEqual(receiptBody.target, { artifactId: preservedDraft.artifactId, versionId: preservedDraft.versionId, sha256: preservedDraft.sha256 });
      assert.equal(receiptBody.resultEvidenceId, diagnostic.sha256);
      assert.equal(receiptBody.resultRunRevision, savedPreparation.revision);
      assert.equal(receiptBody.resultInterventionId, savedPreparation.nodeRuns.find(node => node.nodeId === "creative-planning")!.intervention!.id);
      const alreadyWaiting = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...prepareInput, commandId: "prepare-existing-stop", expectedRunRevision: savedPreparation.revision }),
      });
      assert.equal(alreadyWaiting.status, 200, await alreadyWaiting.text());
      const existingReceipt = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations/prepare-existing-stop`);
      assert.equal(existingReceipt.status, 200, "已在相同停点的准备仍登记原操作回执，HTTP未知可查");
      assert.equal((await pipeline.loadPersisted(failedRun.id)).revision, savedPreparation.revision, "不重复开停点或推进制作版本");
      const missing = await fetch(`${origin}/api/runs/${failedRun.id}/review-continuations/unknown-cmd`);
      assert.equal(missing.status, 404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DG-UX-04（新前端 Dogfood 修复执行包 R2）：讨论失败只属于命令，不属于制作。
// 走正式 Studio 命令/回执链：POST discuss → 主 run 回原人工停点、稿/版本不变，
// GET 回执 failed；重放同命令返回原结果不再执行；服务重建后结论一致。
// ---------------------------------------------------------------------------

it("keeps a failed discussion command at the human stop through the studio command chain", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-discuss-studio-"));
  const spies: ReworkSpies = { treatmentCalls: 0, screenwriterBodies: [], directorInputs: [] };
  const agents = jointReworkAgents(spies);
  let discussCalls = 0;
  const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ReworkWorker(),
    assetProviders: REWORK_ASSET_PROVIDERS,
    ...agents,
    screenwriterAgent: { ...agents.screenwriterAgent!, discussDetailed: async () => {
      discussCalls += 1;
      throw new CodexBridgeError("受控讨论失败（completed_failure）", false, "completed_failure");
    } } as ScreenwriterAgent,
  });
  const studio = new ProductionStudio({ workspaceRoot, pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [] });
  let run = await pipeline.start(jointReworkBrief());
  // 推进到 script 停点（确认 treatment）。
  {
    const intervention = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.intervention;
    assert.ok(intervention?.continuation && intervention.kind === "creative_review");
    const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { checkIdentity?: string } }> } })
      ?.creativeReview?.stages?.[intervention.continuation.stage]?.checkResult;
    run = await pipeline.confirmCreativeReview(run.id, {
      commandId: "adopt-treatment-before-discuss", actor: "creator", stage: intervention.continuation.stage,
      expectedRunRevision: run.revision, expectedReviewRevision: intervention.continuation.reviewRevision,
      baseDraftSha256: intervention.continuation.draftSha256,
      ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
    });
  }
  const before = (await studio.creativeReview(run.id))!;
  assert.equal(before.stage, "script");
  assert.ok(before.draftVersionId, "脚本停点必须携带版本身份");

  const discussionCommand = {
    action: "discuss" as const, commandId: "discuss-studio-1", stage: "script" as const,
    expectedRunRevision: before.runRevision, expectedReviewRevision: before.reviewRevision,
    baseDraftSha256: before.draftSha256, message: "解释这个安排",
  };
  const firstReceipt = await studio.commandCreativeReview(run.id, discussionCommand, "creator");
  assert.ok(firstReceipt);
  let finalReceipt = firstReceipt;
  for (let index = 0; index < 500 && finalReceipt.status === "running"; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    finalReceipt = (await studio.creativeReviewCommand(run.id, "discuss-studio-1"))!;
  }
  assert.equal(finalReceipt.status, "failed", "已核清讨论失败的回执是 failed");

  const after = (await studio.creativeReview(run.id))!;
  const detailAfter = await studio.get(run.id);
  assert.equal(detailAfter!.status, "needs_human", `主制作不能因讨论失败变 failed：${detailAfter!.nodes.map(node => node.error).join(";")}`);
  assert.equal(after.stage, "script");
  assert.equal(after.draftSha256, before.draftSha256);
  assert.equal(after.draftVersionId, before.draftVersionId);
  assert.equal(after.reviewRevision, before.reviewRevision, "失败讨论不推进复核轮次");
  assert.equal(after.messages.length, before.messages.length, "失败不伪造助手回复");
  assert.equal(after.allowedActions.includes("discuss"), true, "讨论入口保留");
  assert.equal(after.allowedActions.includes("edit_draft"), true, "人工编辑入口保留");
  assert.equal(after.allowedActions.includes("confirm"), true, "采用入口保留");

  // 同命令重放：返回原结果，不再执行第二次。
  const replayReceipt = await studio.commandCreativeReview(run.id, discussionCommand, "creator");
  assert.equal(replayReceipt.status, "failed");
  assert.equal(discussCalls, 1, "重放不得再次调用讨论执行");

  // 服务重建（同工作树重开 Studio）后结论一致。
  const reloaded = new ProductionStudio({ workspaceRoot, pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} }, listProviders: async () => [] });
  const reloadedReceipt = await reloaded.creativeReviewCommand(run.id, "discuss-studio-1");
  assert.equal(reloadedReceipt!.status, "failed");
  const reloadedSnapshot = await reloaded.creativeReview(run.id);
  assert.equal(reloadedSnapshot!.draftSha256, before.draftSha256);
  assert.equal(reloadedSnapshot!.draftVersionId, before.draftVersionId);
});
