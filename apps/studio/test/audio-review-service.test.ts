import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AudioReviewService } from "../src/server/audio-review-service.js";
import { PythonReviewMediaPreprocessor } from "../src/server/review-media-preprocessor.js";
import { ModelRegistry } from "../../codex-broker/src/model-registry.js";
import { taskContractDescriptorFor } from "../../codex-broker/src/task-definitions.js";
import { CodexBridgeClient, CodexBridgeError, AUDIO_REVIEW_CHECKS, validateAudioReviewReport, VisualReviewWithAudioError, ProductionPipeline, PythonWorkerClient, type VisualReviewAgent, type AudioReviewResult } from "@video-factory/production-pipeline";
import { explicitEditorialDirector, localEditorialAssetProvider } from "../../../packages/production-pipeline/src/cli.js";
import type { ConnectedModel } from "../src/server/model-connections.js";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const audio = Buffer.from("ID3-test-soundtrack");
const media = { prepare: async () => ({ durationMs: 1000, frames: [{ timecodeMs: 0, sha256: sha(jpeg), jpegBase64: jpeg.toString("base64") }] }) };
const checks = Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"]));

async function recoveryHarness() {
  const directory = await mkdtemp("/tmp/vf-audio-recovery-");
  const counts = { model: 0, extract: 0, prepare: 0 };
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: (entry) => ({ identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["audio-review"] }, modelCandidates: [entry.id],
      runTask: async (task) => {
        counts.model++;
        if (task.kind !== "audio-review") throw new Error("wrong task");
        return { output: JSON.stringify({ audioSha256: task.payload.audioSha256, summary: "恢复证据", checks, findings: [] }),
          trace: { taskKind: task.kind, providerId: entry.id, modelId: entry.id, prompt: "test",
            contractDigest: taskContractDescriptorFor(task.kind).digest, promptVersion: taskContractDescriptorFor(task.kind).promptVersion } };
      },
    }),
  });
  await registry.start();
  await registry.handle("POST", "/v1/models", { label: "Audio", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-native", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
  const model = registry.list()[0]!, client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
  const connections = [{ model, client }];
  const newService = () => new AudioReviewService({ connections: () => connections,
    media: { prepare: async () => { counts.prepare++; return media.prepare(); } },
    extract: async (_video, output) => { counts.extract++; await writeFile(output, audio); },
  });
  const video = path.join(directory, "render.mp4");
  await writeFile(video, "fixture-video");
  const input = { runRoot: directory, videoPath: video, selectedAudioModelId: model.id };
  const resultPath = async () => path.join(directory, ".audio-review-requests", (await readdir(path.join(directory, ".audio-review-requests"))).find((name) => name.endsWith(".result.json"))!);
  return { directory, counts, registry, model, client, connections, newService, input, resultPath,
    close: async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("completed sound recovery validates full binding and avoids repeated preprocessing after restart", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    assert.equal((await h.newService().review(h.input)).status, "completed");
    assert.deepEqual(h.counts, { model: 1, extract: 1, prepare: 1 });
    const file = await h.resultPath(), saved = JSON.parse(await readFile(file, "utf8"));
    for (const field of ["requestId", "videoSha256", "audioSha256", "durationMs"]) {
      await writeFile(file, JSON.stringify({ ...saved, [field]: field === "durationMs" ? 2000 : "wrong" }));
      assert.equal((await h.newService().review(h.input)).status, "uncertain", `错绑${field}不能冒充已核清失败或正常报告`);
      assert.equal(h.counts.model, 1);
    }
  } finally { await h.close(); }
});

test("nested unknown and a changed selected model cannot create a second sound request", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    await rm(await h.resultPath());
    h.client.observePrepared = async () => { throw new Error("wrapped", { cause: new CodexBridgeError("pending", false, "uncertain") }); };
    assert.equal((await h.newService().review(h.input)).status, "uncertain");
    await h.registry.handle("POST", "/v1/models", { label: "Other", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-other", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
    const other = h.registry.list().find((model) => model.id !== h.model.id)!;
    h.connections.push({ model: other, client: new CodexBridgeClient({ socketPath: path.join(h.directory, other.socketName), timeoutMs: 5000 }) });
    h.model.enabled = false;
    assert.equal((await h.newService().review({ ...h.input, selectedAudioModelId: other.id })).status, "uncertain");
    assert.equal(h.counts.model, 1, "原请求未核清时，不因用户改配置就购买第二次审片");
  } finally { await h.close(); }
});

test("a committed prepared sound record restores after its derived input index is lost", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    const result = await h.resultPath();
    await rm(result);
    await rm(result.replace(/\.result\.json$/, ".input.json"));
    // 模拟prepared已提交、索引尚未完成时重启；持久信封仍是恢复依据。
    assert.equal((await h.newService().review(h.input)).status, "completed");
    assert.deepEqual(h.counts, { model: 1, extract: 1, prepare: 1 });
  } finally { await h.close(); }
});

test("an explicit sound review cycle is new once, while ordinary recovery and pending cycles are not", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    const next = { ...h.input, reviewCycleId: "approved-review-cycle-2" };
    assert.equal((await h.newService().review(next)).status, "completed");
    assert.equal(h.counts.model, 2, "用户的新审查操作不得冒用旧报告");
    assert.equal((await h.newService().review(next)).status, "completed");
    assert.equal(h.counts.model, 2, "普通恢复不得生成第三条请求");
    const records = path.join(h.directory, ".audio-review-requests");
    const bindingName = (await readdir(records)).filter(name => name.endsWith(".input.json"));
    for (const name of bindingName) {
      const binding = JSON.parse(await readFile(path.join(records, name), "utf8"));
      if (binding.reviewCycleId === next.reviewCycleId) await rm(path.join(records, `${binding.requestId}.result.json`));
    }
    h.client.observePrepared = async () => { throw new CodexBridgeError("pending", false, "uncertain"); };
    assert.equal((await h.newService().review({ ...h.input, reviewCycleId: "approved-review-cycle-3" })).status, "uncertain");
    assert.equal(h.counts.model, 2, "上一轮未核清时，新cycle也不能绕过原请求");
  } finally { await h.close(); }
});

test("a proven unaccepted sound request permits only one durable resubmission", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    await rm(await h.resultPath());
    let resubmits = 0;
    h.client.observePrepared = async () => { throw new CodexBridgeError("absent", true, "not_accepted"); };
    h.client.submitPreparedIfUnaccepted = async () => { resubmits++; throw new CodexBridgeError("still absent", true, "not_accepted"); };
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await h.newService().review(h.input)).status, "failed");
    assert.equal(resubmits, 1);
    assert.equal(h.counts.model, 1);
  } finally { await h.close(); }
});

test("settled visual failure keeps independent audio visible while visual unknown never starts sound", async () => {
  const h = await recoveryHarness();
  try {
    const unknown = new CodexBridgeError("visual pending", false, "uncertain");
    const agent = { id: "visual", modelId: "visual", review: async () => { throw unknown; } };
    await assert.rejects(() => h.newService().wrap(agent).review(h.input), (error) => error === unknown);
    assert.equal(h.counts.model, 0);
    const settled = new CodexBridgeError("visual returned no report", false, "completed_failure");
    agent.review = async () => { throw settled; };
    for (let restart = 0; restart < 2; restart++) {
      await assert.rejects(() => h.newService().wrap(agent).review(h.input), (error) => {
        assert.ok(error instanceof VisualReviewWithAudioError);
        assert.equal(error.visualError, settled);
        assert.equal(error.audioReview.status, "completed");
        return true;
      });
    }
    assert.deepEqual(h.counts, { model: 1, extract: 1, prepare: 1 });
  } finally { await h.close(); }
});

test("concurrent sound recovery does not submit a second request", async () => {
  const h = await recoveryHarness();
  let allowSubmission!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => { allowSubmission = resolve; });
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  const original = h.client.runTaskDetailed.bind(h.client);
  h.client.runTaskDetailed = async (...args) => { entered(); await paused; return original(...args); };
  let first: Promise<unknown> | undefined;
  try {
    first = h.newService().review(h.input);
    await inFlight;
    const second = await h.newService().review(h.input);
    assert.equal(second.status, "uncertain");
    allowSubmission();
    assert.equal((await first as { status: string }).status, "completed");
    assert.equal(h.counts.model, 1);
  } finally { allowSubmission(); await first; await h.close(); }
});

test("real audio service unknown survives pipeline restart and settles into an explicit internal delivery", { timeout: 120_000 }, async () => {
  const h = await recoveryHarness();
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const originalRun = h.client.runTaskDetailed.bind(h.client);
  const originalObserve = h.client.observePrepared.bind(h.client);
  h.client.runTaskDetailed = async (...args) => {
    await originalRun(...args);
    throw new Error("controlled lost completed response", { cause: new CodexBridgeError("pending", false, "uncertain", undefined, undefined, {
      category: "network", reasonCode: "controlled_lost_response", providerId: h.model.id, modelId: h.model.id,
      requestIdHash: sha(Buffer.from(args[2]!)), accepted: true, modelAttemptCount: 1,
    }) });
  };
  const audioService = () => new AudioReviewService({ connections: () => h.connections,
    media: new PythonReviewMediaPreprocessor({ repositoryRoot, pythonPath: path.join(repositoryRoot, "src"), pythonCommand: "python" }) });
  const visual: VisualReviewAgent = {
    id: "deepseek-visual-review-v1", modelId: "controlled-visual",
    review: async (input) => {
      if (input.reviewStage !== "source_assets") throw new CodexBridgeError("controlled terminal visual response", false, "completed_failure");
      return { version: "video-factory/visual-review-v1", summary: "受控视觉响应；不是真实质量结论。",
        scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 80 }, findings: [], confidence: 0.9, recommendation: "approve" };
    },
  };
  const worker = new PythonWorkerClient({ command: ["python", "-m", "video_factory.worker"], cwd: repositoryRoot,
    env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") }, timeoutMs: 90_000 });
  const options = { workspaceRoot: h.directory, worker, directorAgent: explicitEditorialDirector, assetProviders: [localEditorialAssetProvider],
    providerRuntimeMetadata: [{ id: visual.id, label: "Controlled visual", modelId: visual.modelId, transport: "unix_socket" as const,
      billing: "subscription" as const, approvalPolicy: "none" as const, maxAttempts: 1 }] };
  const pipeline = () => new ProductionPipeline({ ...options, visualReviewAgents: [audioService().wrap(visual)] });
  try {
    const brief = JSON.parse(await readFile(path.join(repositoryRoot, "examples/briefs/life-avoidance-local.json"), "utf8"));
    // 正式Python/FFmpeg/离线配音生成产物；runPurpose=test只用于本卡恢复合同，不冒充T07三入口验收。
    brief.providers.visualReview = visual.id;
    brief.durationSeconds = 40;
    // CI非macOS使用仓库显式测试音轨provider；不替换worker或渲染器，也不声称验证真实听感。
    if (process.platform !== "darwin") {
      brief.providers.voice = "ffmpeg-tone-test-v1";
      brief.voiceDirection = { profileId: "tone:test-tone", rate: 190, pauseScale: 1, masteringPreset: "natural" };
    }
    brief.models = { [visual.id]: visual.modelId, "sound-review-v1": h.model.id };
    let run = await pipeline().start(brief);
    const diagnostics = () => JSON.stringify(run.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, error: node.error })));
    assert.equal(run.status, "failed", diagnostics());
    assert.equal(run.nodeRuns.find(node => node.nodeId === "visual-review")?.status, "failed", diagnostics());
    assert.equal(h.counts.model, 1);
    const video = run.artifacts.find(artifact => artifact.contentType === "video/mp4");
    assert.ok(video?.uri);
    const bytes = await readFile(video.uri), videoHash = sha(bytes);
    const restored = await pipeline().loadPersisted(run.id);
    assert.equal(restored?.status, "failed");
    const facts = await pipeline().readModelExecutionFacts(run.id);
    const soundFact = facts.facts.find(fact => fact.purpose === "audio");
    assert.equal(soundFact?.accepted, true);
    assert.equal(soundFact?.modelAttemptCount, 1, "未知请求的已发生尝试不能归零");
    assert.equal(restored?.nodeRuns.find(node => node.nodeId === "final-review"), undefined, "未知声音请求不能进入终审");
    for (const nested of [false, true]) {
      h.client.observePrepared = async () => {
        const error = new CodexBridgeError("pending", false, "uncertain");
        throw nested ? new Error("wrapped", { cause: error }) : error;
      };
      run = await pipeline().retryFailedNode(run.id, "visual-review");
      assert.equal(run.status, "failed", diagnostics());
      assert.equal(h.counts.model, 1);
      assert.equal(run.nodeRuns.find(node => node.nodeId === "visual-review")?.intervention, undefined);
      assert.equal(run.artifacts.some(artifact => artifact.kind === "publish_package"), false);
      await assert.rejects(() => pipeline().decide(run.id, { interventionId: "not-a-risk-gate", actor: "qa", action: "approve",
        expectedRunRevision: run.revision, reviewEvidenceId: null }), /intervention|waiting|decision/i);
    }
    h.client.observePrepared = originalObserve;
    run = await pipeline().retryFailedNode(run.id, "visual-review");
    assert.equal(run.status, "needs_human", diagnostics());
    const review = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
    const sound = (review.output as { audioReview?: AudioReviewResult }).audioReview;
    assert.equal(sound?.status, "completed");
    if (sound?.status === "completed") assert.deepEqual(sound.observationCoverage, { observed: 0, total: 6 });
    assert.equal(h.counts.model, 1, "恢复仅查询已完成的原请求");
    assert.equal(sha(await readFile(video.uri)), videoHash, "恢复审查不得重新生成或改写成片");
    run = await pipeline().decide(run.id, { interventionId: review.intervention!.id, action: "approve", actor: "qa",
      expectedRunRevision: run.revision, reviewEvidenceId: null });
    const final = run.nodeRuns.find(node => node.nodeId === "final-review")!;
    assert.equal(final.status, "needs_human", diagnostics());
    const delivery = final.output as { deliveryEvidenceId: string };
    run = await pipeline().decide(run.id, { interventionId: final.intervention!.id, action: "approve", actor: "qa",
      expectedRunRevision: run.revision, reviewEvidenceId: delivery.deliveryEvidenceId,
      note: "受控恢复验证：接受视觉无结论，声音未观察到有效证据。", acceptIncomplete: true });
    assert.equal(run.status, "succeeded", diagnostics());
    const bundle = run.artifacts.find(artifact => artifact.kind === "publish_package");
    assert.ok(bundle?.uri);
    const packaged = JSON.parse(await readFile(bundle.uri, "utf8"));
    assert.match(JSON.stringify(packaged), /incomplete/);
    assert.equal(h.counts.model, 1);
  } finally { await h.close(); }
});

test("audio task travels through durable socket; same evidence resumes without new execution", async () => {
  const directory = await mkdtemp("/tmp/vf-audio-");
  let calls = 0;
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["audio-review"] },
      modelCandidates: [entry.id], runTask: async (task) => {
        calls++;
        assert.equal(task.kind, "audio-review");
        if (task.kind !== "audio-review") throw new Error("wrong task");
        assert.deepEqual(task.payload.audio, audio);
        return { output: JSON.stringify({ audioSha256: task.payload.audioSha256, summary: "测试仅确认声音证据送达，不伪造听感。", checks, findings: [] }), trace: {
          providerId: entry.id, modelId: entry.id, taskKind: task.kind, prompt: "test",
          contractDigest: taskContractDescriptorFor(task.kind).digest, promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
        } };
      },
    }),
  });
  try {
    await registry.start();
    await registry.handle("POST", "/v1/models", { label: "Audio", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-native", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
    const model = registry.list()[0]!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
    let wireFailure: unknown;
    const originalRun = client.runTaskDetailed.bind(client);
    client.runTaskDetailed = async (...args) => {
      const expectedPayload = {
        durationMs: 1000, audioSha256: sha(audio), audioBase64: audio.toString("base64"), frames: (await media.prepare()).frames,
        reviewContext: { videoSha256: sha(Buffer.from("fixture-video")), evidenceBoundary: "实际成片混合音轨；画面仅为带时间码的抽帧，不支持确认逐帧口型同步。" },
      };
      assert.equal(args[2], `sound-${sha(Buffer.from(JSON.stringify({ model: model.id, payload: expectedPayload })))}`, "new diagnostics must preserve the legacy evidence identity and resume existing paid requests");
      try { return await originalRun(...args); } catch (error) { wireFailure = error; throw error; }
    };
    const connections: ConnectedModel[] = [{ model, client }];
    const service = new AudioReviewService({ connections: () => connections, media, extract: async (_video, output) => { await writeFile(output, audio); } });
    const video = path.join(directory, "render.mp4");
    await writeFile(video, "fixture-video");
    const input = { runRoot: directory, videoPath: video, selectedAudioModelId: model.id };
    const first = await service.review(input);
    assert.equal(first.status, "completed", `${JSON.stringify(first)} ${String(wireFailure)}`);
    if (first.status === "completed") {
      assert.equal(first.audioSha256, sha(audio));
      assert.equal(first.videoSha256, sha(Buffer.from("fixture-video")));
      // 六项全 not_observed：如实显示有效观察为 0，不冒充声音通过。
      assert.deepEqual(first.observationCoverage, { observed: 0, total: 6 });
    }
    assert.equal((await service.review(input)).status, "completed");
    assert.equal(calls, 1);
    // T06：本地耐久完成结果存在时直接读取（结果文件写入，恢复不再依赖 broker）。
    const requestsDirectory = path.join(directory, ".audio-review-requests");
    const persistedResults = (await readdir(requestsDirectory)).filter((name) => name.endsWith(".result.json"));
    assert.equal(persistedResults.length, 1);
    await rm(path.join(requestsDirectory, persistedResults[0]!));
    // 无本地结果时：已受理请求的恢复只能观察原请求；连接中断时保持 unknown，不换请求。
    const originalObserve = client.observePrepared.bind(client);
    client.observePrepared = async () => { throw new CodexBridgeError("waiting", false, "uncertain"); };
    assert.equal((await service.review(input)).status, "uncertain");
    assert.equal(calls, 1);
    client.observePrepared = originalObserve;
    assert.equal((await service.review(input)).status, "completed");
    assert.equal(calls, 1);
    assert.equal((await service.review({ runRoot: directory, videoPath: video })).status, "not_configured", "old runs must not silently acquire a new model");
    const wrongRoot = await mkdtemp("/tmp/vf-audio-boundary-");
    try { assert.equal((await service.review({ ...input, runRoot: wrongRoot })).status, "failed"); }
    finally { await rm(wrongRoot, { recursive: true, force: true }); }
    assert.equal(calls, 1);
    model.enabled = false;
    assert.equal((await service.review(input)).status, "completed", "disabling must not hide an accepted result");
    await writeFile(video, "changed-video");
    assert.equal((await service.review(input)).status, "not_reviewed", "disabled connection cannot submit new evidence");
    assert.equal(calls, 1);
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("audio findings bind the actual track, valid time range, and check result", () => {
  const report = { audioSha256: sha(audio), summary: "测试", checks, findings: [] };
  assert.equal(validateAudioReviewReport(report, sha(audio), 1000).summary, "测试");
  assert.throws(() => validateAudioReviewReport(report, "a".repeat(64), 1000), /音轨/);
  assert.throws(() => validateAudioReviewReport(report, sha(audio), Number.NaN), /时长/);
  assert.throws(() => validateAudioReviewReport({ ...report, checks: { ...checks, pauses: "issue" } }, sha(audio), 1000), /时间定位/);
  assert.throws(() => validateAudioReviewReport({ ...report, findings: [{ startMs: 900, endMs: 1100, category: "pauses", observation: "不自然", suggestion: "调整" }] }, sha(audio), 1000), /时间范围/);
});

test("real ffmpeg extraction sends the whole rendered soundtrack and does not call a model for silent video", async () => {
  const directory = await mkdtemp("/tmp/vf-audio-ffmpeg-");
  const execFile = promisify(execFileCallback);
  let calls = 0;
  const client = new CodexBridgeClient({ socketPath: "/unused/test" });
  client.runTaskDetailed = async (_kind, input) => {
    calls++;
    const payload = input as { audioBase64: string; audioSha256: string; reviewContext: { audioEvidence: { lowLevelIntervals: Array<{ startMs: number; endMs: number }> } } };
    const bytes = Buffer.from(payload.audioBase64, "base64");
    assert.ok(bytes.length > 8000, "actual encoded soundtrack, not transcript");
    assert.equal(sha(bytes), payload.audioSha256);
    const intervals = payload.reviewContext.audioEvidence.lowLevelIntervals;
    if (calls === 1) assert.deepEqual(intervals, [], "a continuous tone is not reported as a silent gap");
    else {
      assert.equal(intervals.length, 1);
      assert.ok(intervals[0]!.startMs >= 180 && intervals[0]!.startMs <= 260);
      assert.ok(intervals[0]!.endMs >= 780 && intervals[0]!.endMs <= 850);
    }
    return { output: { audioSha256: payload.audioSha256, summary: "提取测试", checks, findings: [] }, trace: { taskKind: "audio-review", providerId: "m-333333333333", modelId: "m-333333333333", promptVersion: "test", prompt: "test" } };
  };
  const service = new AudioReviewService({ media, connections: () => [{ client, model: { id: "m-333333333333", label: "测试", modelId: "audio", enabled: true, credentialConfigured: true, socketName: "m-333333333333.sock", protocol: "openai-chat-completions", baseUrl: "https://example.com", capabilities: ["audio", "image"], maxOutputTokens: 32000 } }] });
  try {
    const video = path.join(directory, "video.mp4");
    await execFile("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", video]);
    assert.equal((await service.review({ runRoot: directory, videoPath: video, selectedAudioModelId: "m-333333333333" })).status, "completed");
    const gap = path.join(directory, "gap.mp4");
    await execFile("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", video, "-af", "volume=0:enable='between(t,0.2,0.8)'", "-c:v", "copy", "-c:a", "aac", gap]);
    assert.equal((await service.review({ runRoot: directory, videoPath: gap, selectedAudioModelId: "m-333333333333" })).status, "completed");
    const silent = path.join(directory, "silent.mp4");
    await execFile("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", video, "-an", "-c:v", "copy", silent]);
    assert.equal((await service.review({ runRoot: directory, videoPath: silent, selectedAudioModelId: "m-333333333333" })).status, "failed");
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a completed audio response that fails host validation becomes a durable settled state, never a re-audit", async () => {
  const directory = await mkdtemp("/tmp/vf-audio-settled-");
  let calls = 0;
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["audio-review"] },
      modelCandidates: [entry.id], runTask: async (task) => {
        calls++;
        if (task.kind !== "audio-review") throw new Error("wrong task");
        // 报告绑定到别的音轨：宿主校验必须拒收（settled/unusable），但请求已完整返回。
        return { output: JSON.stringify({ audioSha256: "f".repeat(64), summary: "不属于本次音轨的报告", checks, findings: [] }), trace: {
          providerId: entry.id, modelId: entry.id, taskKind: task.kind, prompt: "test",
          contractDigest: taskContractDescriptorFor(task.kind).digest, promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
        } };
      },
    }),
  });
  try {
    await registry.start();
    await registry.handle("POST", "/v1/models", { label: "Audio", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-native", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
    const model = registry.list()[0]!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
    const service = new AudioReviewService({ connections: () => [{ client, model }], media, extract: async (_video, output) => { await writeFile(output, audio); } });
    const video = path.join(directory, "render.mp4");
    await writeFile(video, "fixture-video");
    const input = { runRoot: directory, videoPath: video, selectedAudioModelId: model.id };
    const first = await service.review(input);
    assert.equal(first.status, "failed");
    assert.match(first.reason, /settled/);
    assert.equal(calls, 1);
    // 恢复（重启后同一输入）直读耐久 settled 记录：不重发、不再审。
    const second = await service.review(input);
    assert.equal(second.status, "failed");
    assert.match(second.reason, /不会自动重审/);
    assert.equal(calls, 1);
    // 结果文件保留原始返回与诊断，供人工核查。
    const requestsDirectory = path.join(directory, ".audio-review-requests");
    const persisted = (await readdir(requestsDirectory)).filter((name) => name.endsWith(".result.json"));
    assert.equal(persisted.length, 1);
    const record = JSON.parse(await readFile(path.join(requestsDirectory, persisted[0]!), "utf8"));
    assert.equal(record.kind, "settled_unusable");
    assert.match(record.validationError, /音轨/);
    assert.ok(record.output, "原始返回保留用于人工核查");
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});
