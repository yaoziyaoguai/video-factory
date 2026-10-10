import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AudioReviewService } from "../src/server/audio-review-service.js";
import { StudioService } from "../src/server/studio-service.js";
import { PythonReviewMediaPreprocessor } from "../src/server/review-media-preprocessor.js";
import { ModelRegistry } from "../../codex-broker/src/model-registry.js";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "../../codex-broker/src/chat-completions-executor.js";
import { taskContractDescriptorFor } from "../../codex-broker/src/task-definitions.js";
import { CodexBridgeClient, CodexBridgeError, CodexVisualReviewAgent, AUDIO_REVIEW_CHECKS, validateAudioReviewReport, VisualReviewWithAudioError, ProductionPipeline, PythonWorkerClient, type VisualReviewAgent, type AudioReviewResult } from "@video-factory/production-pipeline";
import { explicitEditorialDirector, localEditorialAssetProvider } from "../../../packages/production-pipeline/src/cli.js";
import type { ConnectedModel } from "../src/server/model-connections.js";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const audio = Buffer.from("ID3-test-soundtrack");
const media = { prepare: async () => ({ durationMs: 1000, frames: [{ timecodeMs: 0, sha256: sha(jpeg), jpegBase64: jpeg.toString("base64") }] }) };
const checks = Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"]));

for (const interruptedBody of [false, true]) {
test(`real audio executor ${interruptedBody ? "interrupted body stays unknown" : "rejection stays settled"} through restart without resubmission`, async (t) => {
  const directory = await mkdtemp("/tmp/vf-audio-executor-rejection-");
  let calls = 0;
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: entry => new ChatCompletionsExecutor({ provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER, env: {},
      configuredModel: entry, fetchFn: async () => {
        calls++;
        if (interruptedBody) return new Response(new ReadableStream({
          start(controller) { controller.error(new Error("controlled connection lost after response headers")); },
        }), { headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          audioSha256: "f".repeat(64), summary: "完整返回但音轨身份错误", checks, findings: [],
        }) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
      },
    }),
  });
  t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });
  await registry.start();
  await registry.handle("POST", "/v1/models", { label: "Audio", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-native", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
  const model = registry.list()[0]!;
  const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 2000, pollIntervalMs: 10 });
  const newService = () => new AudioReviewService({ connections: () => [{ model, client }], media,
    extract: async (_video, output) => { await writeFile(output, audio); } });
  const videoPath = path.join(directory, "render.mp4");
  await writeFile(videoPath, "fixture-video");
  const input = { runRoot: directory, videoPath, selectedAudioModelId: model.id };
  const first = await newService().review(input);
  const expectedStatus = interruptedBody ? "uncertain" : "failed";
  const expectedRequestState = interruptedBody ? "unknown" : "settled";
  assert.equal(first.status, expectedStatus, "完整报告校验失败与真正的响应断连必须区分");
  const requests = path.join(directory, ".audio-review-requests");
  const requestId = (await readdir(requests)).find(name => name.endsWith(".input.json"))!.replace(/\.input\.json$/, "");
  const failure = JSON.parse(await readFile(path.join(requests, `${requestId}.failure.json`), "utf8"));
  assert.equal(failure.requestState, expectedRequestState);
  if (interruptedBody) {
    assert.ok(!(await readdir(requests)).includes(`${requestId}.result.json`), "真正未知的请求不能凭本地结束伪造终态");
  } else {
    const result = JSON.parse(await readFile(path.join(requests, `${requestId}.result.json`), "utf8"));
    assert.equal(result.kind, "request_failed");
    assert.equal(result.requestState, "settled");
    assert.equal(result.audioSha256, sha(audio));
  }
  await registry.close();
  await registry.start();
  assert.equal((await newService().review(input)).status, expectedStatus);
  const observed = await newService().observe({ runRoot: directory, requestId });
  assert.equal(observed.status, expectedStatus);
  assert.equal(observed.requestState, expectedRequestState);
  assert.equal(calls, 1, "重启与原请求查询不再次请求模型");
});
}

async function recoveryHarness() {
  const directory = await mkdtemp("/tmp/vf-audio-recovery-");
  const counts = { model: 0, extract: 0, prepare: 0 };
  const payloads: Record<string, unknown>[] = [];
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: (entry) => ({ identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["audio-review"] }, modelCandidates: [entry.id],
      runTask: async (task) => {
        counts.model++;
        if (task.kind !== "audio-review") throw new Error("wrong task");
        payloads.push(task.payload);
        return { output: JSON.stringify({ audioSha256: task.payload.audioSha256, summary: "恢复证据", checks, findings: [] }),
          trace: { taskKind: task.kind, providerId: entry.id, modelId: entry.id, prompt: "test",
            requestIdHash: sha(Buffer.from("provider-issued-request-id")),
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
  return { directory, counts, payloads, registry, model, client, connections, newService, input, resultPath,
    close: async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("sound review receives render scene bounds separately from interior sample timestamps", async () => {
  const h = await recoveryHarness();
  try {
    const manifestPath = path.join(h.directory, "render_manifest.json");
    await writeFile(manifestPath, JSON.stringify({ output_file: h.input.videoPath,
      slides: [{ position: 1, duration: 6 }, { position: 2, duration: 6 }] }));
    const input = { ...h.input, renderManifestPath: manifestPath, preparedMedia: {
      durationMs: 12000, frames: [{ timecodeMs: 6900, scenePosition: 2, phase: "opening" as const,
        sha256: sha(jpeg), jpegBase64: jpeg.toString("base64") }],
    } };
    assert.equal((await h.newService().review(input)).status, "completed");
    const context = h.payloads[0]!.reviewContext as Record<string, unknown>;
    const timeline = context.renderTimeline as { source: string; scenes: unknown[] } | undefined;
    assert.ok(timeline, "仅提供6.9秒的抽帧会丢掉真正6秒的剪辑边界");
    assert.equal(timeline.source, "render_manifest");
    assert.deepEqual(timeline.scenes, [{ scenePosition: 1, startMs: 0, endMs: 6000 }, { scenePosition: 2, startMs: 6000, endMs: 12000 }]);
    assert.match(String(context.evidenceBoundary), /抽帧时间不是切镜/);
    assert.equal((await h.newService().review(input)).status, "completed");
    assert.equal(h.counts.model, 1, "新增上下文不改变同一请求的恢复语义");
  } finally { await h.close(); }
});

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

test("sound review does not invent cuts when render timing or media binding is unavailable", async () => {
  const h = await recoveryHarness();
  try {
    const manifestPath = path.join(h.directory, "render_manifest.json");
    for (const manifest of [undefined,
      { output_file: h.input.videoPath, slides: [{ position: 1, duration: 8 }] },
      { output_file: path.join(h.directory, "missing.mp4"), slides: [{ position: 1, duration: 1 }] }]) {
      if (manifest) await writeFile(manifestPath, JSON.stringify(manifest));
      const result = await h.newService().review({ ...h.input, ...(manifest ? { renderManifestPath: manifestPath } : {}) });
      assert.equal(result.status, "completed", "没有可信切镜证据不阻止审听已有音轨");
      const context = h.payloads.at(-1)!.reviewContext as Record<string, unknown>;
      const timeline = context.renderTimeline as { source: string; scenes?: unknown[] };
      assert.equal(timeline.source, "unavailable");
      assert.equal(timeline.scenes, undefined);
    }
  } finally { await h.close(); }
});

test("provider receipt identity stays separate from broker identity on sound recovery", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    const file = await h.resultPath(), saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.trace.requestIdHash, sha(Buffer.from("provider-issued-request-id")));
    assert.equal(saved.trace.brokerRequestIdHash, sha(Buffer.from(saved.requestId)));
    assert.equal((await h.newService().review(h.input)).status, "completed");
    // 已有生产记录没有新字段；仍由保存的请求、模型、成片和音轨身份绑定，不将供应方编号当宿主编号。
    const legacy = structuredClone(saved);
    delete legacy.trace.brokerRequestIdHash;
    await writeFile(file, JSON.stringify(legacy));
    assert.equal((await h.newService().review(h.input)).status, "completed");
    await writeFile(file, JSON.stringify({ ...saved, trace: { ...saved.trace, brokerRequestIdHash: "0".repeat(64) } }));
    assert.equal((await h.newService().review(h.input)).status, "uncertain");
    assert.deepEqual(h.counts, { model: 1, extract: 1, prepare: 1 });
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

test("observe-only sound recovery never submits even when the original request was not accepted", async () => {
  const h = await recoveryHarness();
  try {
    assert.equal((await h.newService().review(h.input)).status, "completed");
    const resultPath = await h.resultPath();
    const requestId = path.basename(resultPath, ".result.json");
    await rm(resultPath);
    let observed = 0, resubmitted = 0;
    h.client.observePrepared = async (operation) => {
      observed++;
      assert.equal(operation.requestId, requestId);
      throw new CodexBridgeError("absent", true, "not_accepted");
    };
    h.client.submitPreparedIfUnaccepted = async () => { resubmitted++; throw new Error("must not submit"); };
    const observedResult = await h.newService().observe({ runRoot: h.directory, requestId });
    assert.equal(observedResult.status, "failed");
    assert.equal(observedResult.requestState, "not_accepted", "纯查询不得把权威未受理说成已结束消费");
    assert.equal(observed, 1);
    assert.equal(resubmitted, 0);
    assert.deepEqual(h.counts, { model: 1, extract: 1, prepare: 1 });
    assert.equal((await readdir(path.dirname(resultPath))).some(name => name.endsWith(".recovery.json")), false);
    await assert.rejects(() => h.newService().observe({ runRoot: h.directory, requestId: "../outside" }));
    assert.equal(observed, 1, "不允许客户端用路径读取其它请求");
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

for (const visualOutcome of ["no_conclusion", "completed"] as const) {
test(`real audio service unknown preserves ${visualOutcome} visual evidence through restart and internal delivery`, { timeout: 120_000 }, async () => {
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
      if (input.reviewStage !== "source_assets" && visualOutcome === "no_conclusion") throw new CodexBridgeError("controlled terminal visual response", false, "completed_failure");
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
    // F04（2026-10-02 执行包，替代旧 failed 断言）：声音请求 unknown 时成片保留，
    // 转为 rendered_video_optional_review 续看停点——原请求事实待核、零重发。
    assert.equal(run.status, "needs_human", diagnostics());
    const review = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
    assert.equal(review.status, "needs_human", diagnostics());
    assert.equal(review.intervention?.continuationScope, "rendered_video_optional_review");
    if (visualOutcome === "completed") {
      assert.equal((review.output as { report?: { summary?: string } }).report?.summary, "受控视觉响应；不是真实质量结论。", "声音待核不擦掉已经取得的视觉意见");
    }
    const soundUnknown = (review.output as { audioReview?: AudioReviewResult }).audioReview;
    assert.equal(soundUnknown?.status, "uncertain", "声音 unknown 事实如实保留在停点");
    assert.equal(h.counts.model, 1);
    const video = run.artifacts.find(artifact => artifact.contentType === "video/mp4");
    assert.ok(video?.uri);
    const bytes = await readFile(video.uri), videoHash = sha(bytes);
    const restored = await pipeline().loadPersisted(run.id);
    assert.equal(restored?.status, "needs_human", "重启后停点保持");
    assert.equal((restored?.nodeRuns.find(node => node.nodeId === "visual-review")?.output as { audioReview?: AudioReviewResult }).audioReview?.status, "uncertain");
    const facts = await pipeline().readModelExecutionFacts(run.id);
    const soundFact = facts.facts.find(fact => fact.purpose === "audio");
    assert.equal(soundFact?.accepted, true);
    assert.equal(soundFact?.modelAttemptCount, 1, "未知请求的已发生尝试不能归零");
    // 续看停点上不能新开付费重审：原请求仍待核实。
    await assert.rejects(() => pipeline().dispatchVisualReinspection(run.id, {
      expectedRunRevision: run.revision, reviewEvidenceId: "a".repeat(64),
    }), /原请求结果仍待核实/);
    assert.equal(h.counts.model, 1);
    // 观察仍 unknown 时（含嵌套包装），错误身份不影响停点事实；不产生新调用。
    for (const nested of [false, true]) {
      h.client.observePrepared = async () => {
        const error = new CodexBridgeError("pending", false, "uncertain");
        throw nested ? new Error("wrapped", { cause: error }) : error;
      };
      await assert.rejects(() => pipeline().dispatchVisualReinspection(run.id, {
        expectedRunRevision: run.revision, reviewEvidenceId: "a".repeat(64),
      }), /原请求结果仍待核实/);
      assert.equal(h.counts.model, 1);
      assert.equal(run.artifacts.some(artifact => artifact.kind === "publish_package"), false);
    }
    h.client.observePrepared = originalObserve;
    // 风险采用必须带 commandId；随后独立停在人工终审，签字后内部包可读。
    await assert.rejects(() => pipeline().decide(run.id, { interventionId: review.intervention!.id, action: "approve", actor: "qa",
      expectedRunRevision: run.revision, reviewEvidenceId: review.intervention!.evidenceId, acceptIncomplete: true }), /操作编号/);
    run = await pipeline().decide(run.id, { interventionId: review.intervention!.id, action: "approve", actor: "qa",
      commandId: "adopt-unknown-audio", expectedRunRevision: run.revision,
      reviewEvidenceId: review.intervention!.evidenceId, acceptIncomplete: true });
    const final = run.nodeRuns.find(node => node.nodeId === "final-review")!;
    assert.equal(final.status, "needs_human", diagnostics());
    const delivery = final.output as { deliveryEvidenceId: string; deliveryEvidence: { audio?: { status?: string }; completionBasis?: string; version?: string } };
    assert.equal(delivery.deliveryEvidence.version, "video-factory/internal-delivery-evidence-v2");
    assert.equal(delivery.deliveryEvidence.completionBasis, "human_approved_existing_artifacts");
    assert.equal(delivery.deliveryEvidence.audio?.status, "uncertain", "交付证据如实保留声音待核");
    run = await pipeline().decide(run.id, { interventionId: final.intervention!.id, action: "approve", actor: "qa",
      commandId: "final-signoff-audio-unknown", expectedRunRevision: run.revision, reviewEvidenceId: delivery.deliveryEvidenceId,
      note: "受控恢复验证：接受视觉无结论，声音请求仍待核实。", acceptIncomplete: true });
    assert.equal(run.status, "succeeded", diagnostics());
    const bundle = run.artifacts.find(artifact => artifact.kind === "publish_package");
    assert.ok(bundle?.uri);
    const packaged = JSON.parse(await readFile(bundle.uri, "utf8"));
    assert.match(JSON.stringify(packaged), /human_approved_existing_artifacts/);
    assert.match(JSON.stringify(packaged), /audio_review_request_unknown/);
    assert.equal(h.counts.model, 1, "全链零重发：原请求只被查询，从未再次提交");
    assert.equal(sha(await readFile(video.uri)), videoHash, "审片/交付不得重新生成或改写成片");
    const studio = new StudioService({ workspaceRoot: h.directory, repositoryRoot, pipeline: pipeline(),
      environment: {}, commandAvailable: () => false, audioReviewObserver: audioService() });
    const completedDetail = await studio.getRun(run.id);
    assert.ok(completedDetail?.optionalReviewTasks?.some(task => task.purpose === "audio_review"), "已完成作品也保留全部原可选审片查询入口");
    const pendingSound = completedDetail!.optionalReviewTasks!.find(task => task.purpose === "audio_review")!;
    const signed = await pipeline().loadPersisted(run.id);
    const afterQuery = await studio.queryOriginalTextTask(run.id, { nodeId: "visual-review", purpose: "audio_review", operationId: pendingSound.operationId });
    const observed = await pipeline().loadPersisted(run.id);
    const queryResult = observed.artifacts.filter(artifact => artifact.schemaVersion === "video-factory/optional-review-observation-v1").map(artifact => artifact.data);
    assert.equal(afterQuery.optionalReviewTasks?.find(task => task.requestId === pendingSound.requestId)?.requestState, "settled", `查询原请求能核实终态，不重进runner：${JSON.stringify(queryResult)}`);
    assert.deepEqual(observed.decisions, signed.decisions, "迟到审听不能改签字");
    assert.deepEqual(observed.nodeRuns.map(node => node.outputState), signed.nodeRuns.map(node => node.outputState), "迟到报告只留历史，不换当前作品或交付证据");
    assert.equal(h.counts.model, 1);
  } finally { await h.close(); }
});
}

test("two accepted unknown review requests survive restart and remain individually queryable after manual delivery", { timeout: 120_000 }, async () => {
  const directory = await realpath(await mkdtemp("/tmp/vf-dual-review-pending-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const executions: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const visualReport = { version: "video-factory/visual-review-v1" as const, summary: "受控源素材意见。",
    scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 80 }, findings: [],
    confidence: 0.9, recommendation: "approve" as const };
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1_000,
    createExecutor: entry => ({ identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id,
      taskKinds: ["visual-review", "audio-review"] }, modelCandidates: [entry.id],
      runTask: async task => {
        executions.push(task.kind);
        await held;
        assert.ok(task.kind === "audio-review" || task.kind === "visual-review");
        const output = task.kind === "audio-review"
          ? { audioSha256: task.payload.audioSha256, summary: "受控声音意见。", checks, findings: [] } : visualReport;
        return { output: JSON.stringify(output), trace: { taskKind: task.kind, providerId: entry.id, modelId: entry.id, prompt: "test",
          contractDigest: taskContractDescriptorFor(task.kind).digest, promptVersion: taskContractDescriptorFor(task.kind).promptVersion } };
      },
    }),
  });
  try {
    await registry.start();
    await registry.handle("POST", "/v1/models", { label: "Controlled sound", protocol: "openai-chat-completions",
      baseUrl: "https://example.com/v1", modelId: "sound-native", apiKey: "test", maxOutputTokens: 32_000, capabilities: ["image", "audio"] });
    const soundModel = registry.list()[0]!;
    await registry.handle("POST", "/v1/models", { label: "Controlled visual", protocol: "openai-chat-completions",
      baseUrl: "https://example.com/v1", modelId: "visual-native", apiKey: "test", maxOutputTokens: 32_000, capabilities: ["image", "audio"] });
    const model = registry.list().find(item => item.id !== soundModel.id)!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 1_000, maxAttempts: 1 });
    const soundClient = new CodexBridgeClient({ socketPath: path.join(directory, soundModel.socketName), timeoutMs: 1_000, maxAttempts: 1 });
    const media = new PythonReviewMediaPreprocessor({ repositoryRoot, pythonPath: path.join(repositoryRoot, "src"), pythonCommand: "python" });
    const audioService = () => new AudioReviewService({ connections: () => [{ model: soundModel, client: soundClient }], media });
    const reviewer = new CodexVisualReviewAgent({ client, media, providerId: "deepseek-visual-review-v1", modelId: model.id });
    // 受控复合供应边界模拟已有两条受理记录；不改变正式 wrap 在视觉未知时不启动声音的顺序。
    // 两条请求都由正式服务/角色/持久 Broker 创建，绝不手写 run.json 或 prepared 信封。
    const composite: VisualReviewAgent = { id: reviewer.id, modelId: model.id,
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async input => {
        if (input.reviewStage === "source_assets") return { output: visualReport };
        const sound = await audioService().review(input);
        assert.equal(sound.status, "uncertain");
        try { return await reviewer.reviewDetailed(input); }
        catch (error) { throw new VisualReviewWithAudioError(error, sound); }
      },
    };
    const pipeline = () => new ProductionPipeline({ workspaceRoot: directory,
      worker: new PythonWorkerClient({ command: ["python", "-m", "video_factory.worker"], cwd: repositoryRoot,
        env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") }, timeoutMs: 90_000 }),
      directorAgent: explicitEditorialDirector, assetProviders: [localEditorialAssetProvider], visualReviewAgents: [composite],
      providerRuntimeMetadata: [{ id: reviewer.id, label: "Controlled visual", modelId: model.id, transport: "unix_socket",
        billing: "subscription", approvalPolicy: "none", maxAttempts: 1 }] });
    const brief = JSON.parse(await readFile(path.join(repositoryRoot, "examples/briefs/life-avoidance-local.json"), "utf8"));
    brief.durationSeconds = 40;
    brief.providers.visualReview = reviewer.id;
    brief.models = { [reviewer.id]: model.id, "sound-review-v1": soundModel.id };
    if (process.platform !== "darwin") {
      brief.providers.voice = "ffmpeg-tone-test-v1";
      brief.voiceDirection = { profileId: "tone:test-tone", rate: 190, pauseScale: 1, masteringPreset: "natural" };
    }
    let run = await pipeline().start(brief);
    assert.equal(run.status, "needs_human");
    assert.deepEqual(executions, ["audio-review", "visual-review"], "两个已受理的独立原请求各执行一次");
    run = await pipeline().loadPersisted(run.id);
    const review = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
    assert.equal(review.outcomeUncertain, true);
    assert.equal(review.intervention?.providerOutcomeKnown, false);
    assert.equal((review.output as { audioReview: AudioReviewResult }).audioReview.status, "uncertain");
    assert.equal((review.output as { report?: unknown }).report, undefined, "双未知不虚构任何视觉报告");
    const originalTasks = await pipeline().originalOptionalReviewTasks(run.id);
    assert.equal(originalTasks.length, 2);
    assert.deepEqual(originalTasks.map(task => task.purpose).sort(), ["audio_review", "visual_review"]);
    assert.equal(new Set(originalTasks.map(task => task.requestId)).size, 2);
    assert.equal(new Set(originalTasks.map(task => task.targetVersionId)).size, 1);
    for (const task of originalTasks) {
      assert.equal(task.requestState, "unknown");
      assert.ok(task.prepared, "宿主资格必须来自真实持久信封");
      const originalClient = task.purpose === "audio_review" ? soundClient : client;
      assert.equal((await originalClient.observePreparedOnce(task.prepared)).state, "running", "持久 Broker 证实原请求已受理、仍无最终结果");
    }
    const studio = () => new StudioService({ workspaceRoot: directory, repositoryRoot, pipeline: pipeline(),
      environment: {}, commandAvailable: () => false, audioReviewObserver: audioService() });
    for (const task of originalTasks) {
      const detail = await studio().queryOriginalTextTask(run.id, { nodeId: task.nodeId, purpose: task.purpose, operationId: task.operationId });
      assert.equal(detail.optionalReviewTasks?.filter(item => item.requestState === "unknown").length, 2);
      assert.equal(detail.optionalReviewUncertaintySafe, true);
    }
    run = await pipeline().loadPersisted(run.id);
    const currentReview = run.nodeRuns.find(node => node.nodeId === "visual-review")!;
    run = await pipeline().decide(run.id, { interventionId: currentReview.intervention!.id, action: "approve", actor: "qa",
      commandId: "adopt-both-original-reviews-unknown", expectedRunRevision: run.revision,
      reviewEvidenceId: currentReview.intervention!.evidenceId, acceptIncomplete: true });
    const final = run.nodeRuns.find(node => node.nodeId === "final-review")!;
    assert.equal(final.status, "needs_human", "采用审片后必须独立人工终审");
    const output = final.output as { deliveryEvidenceId: string; deliveryEvidence: { audio: { status: string }; visual: { status: string } } };
    assert.equal(output.deliveryEvidence.audio.status, "uncertain");
    run = await pipeline().decide(run.id, { interventionId: final.intervention!.id, action: "approve", actor: "qa",
      commandId: "signoff-both-original-reviews-unknown", expectedRunRevision: run.revision,
      reviewEvidenceId: output.deliveryEvidenceId, acceptIncomplete: true, note: "受控验证：双审片待核不等于审片通过。" });
    assert.equal(run.status, "succeeded");
    const video = run.artifacts.find(artifact => artifact.contentType === "video/mp4")!;
    const bundle = run.artifacts.find(artifact => artifact.kind === "publish_package")!;
    const videoHash = sha(await readFile(video.uri!));
    const bundleHash = sha(await readFile(bundle.uri!));
    const signed = await pipeline().loadPersisted(run.id);
    for (const task of originalTasks) {
      const detail = await studio().queryOriginalTextTask(run.id, { nodeId: task.nodeId, purpose: task.purpose, operationId: task.operationId });
      assert.equal(detail.status, "succeeded");
      assert.equal(detail.optionalReviewTasks?.filter(item => item.requestState === "unknown").length, 2);
    }
    const observed = await pipeline().loadPersisted(run.id);
    assert.deepEqual(observed.decisions, signed.decisions);
    assert.deepEqual(observed.nodeRuns.map(node => node.outputState), signed.nodeRuns.map(node => node.outputState));
    assert.equal(sha(await readFile(bundle.uri!)), bundleHash);
    assert.equal(sha(await readFile(video.uri!)), videoHash);
    assert.deepEqual(executions, ["audio-review", "visual-review"]);
    assert.equal(observed.artifacts.filter(artifact => artifact.schemaVersion === "video-factory/optional-review-observation-v1").length, 2);
    console.info(JSON.stringify({ event: "dual-original-review-unknown-proof", runId: run.id,
      originalRequests: originalTasks.map(({ prepared: _prepared, ...identity }) => identity),
      decisionCount: run.decisions.length, videoHash, bundleHash, executions, status: observed.status }));
  } finally {
    release();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
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
