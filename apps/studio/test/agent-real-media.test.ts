import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { ArkMediaPort, RealMediaGateway } from "../src/server/agent/ark-media.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { mediaBinding, mediaConfigurationRevisionId, parseAgentMediaConfig, type AgentMediaConfig } from "../src/server/agent/media-config.js";
import { arkVideoCatalog, arkVideoModelView, initializeArkVideoSettings, readArkVideoCurrent, resolveArkBinding } from "../src/server/agent/ark-video-settings.js";
import { initializeTextModelSettings } from "../src/server/agent/text-model-settings.js";
import { initializeProviderConnections, readProviderConnections, saveProviderConnection } from "../src/server/agent/provider-connections.js";
import { DEFAULT_ARK_VIDEO_PROFILE } from "../src/server/agent/media-config.js";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { probeVideoFile } from "../src/server/agent/media-probe.js";
import type { ProductionCrashHook } from "../src/server/agent/production-service.js";
import { attemptsFor } from "../src/server/agent/production-store.js";
import { validatorFor } from "../src/server/agent/validate.js";
import type { ProductionIntent } from "../src/shared/agent/generated/contracts.js";
import { bindPreparedPlan, ensurePlanStageWork, seedPlanStageWork } from "./helpers/creative-work-fixture.js";
import { toolIntentOf } from "./helpers/tool-args.js";

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `real-${++sequence}`;
const staticClock = () => "2026-10-26T00:00:00.000Z";

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };

// C1-02/C1-03/C1-05：真实 Ark 通道行为对可控本地 HTTP 供应商桩验证——请求映射、单次创建、
// 超时 unknown、4xx 拒绝、不合规成品、下载重试、重启只查询、绑定漂移、终态账务停查、凭据授权门。
// 全程不触真实外网；下载的成品是本地 ffmpeg 生成的合规/不合规 mp4。

interface StubState {
  createMode: "ok" | "hang" | "reject400" | "echo400" | "echo503" | "echoTaskFailed" | "echoQuery503";
  taskStatus: "queued" | "running" | "succeeded" | "expired";
  videoUrlPath: string;
  posts: { auth: string | undefined; body: any }[];
  gets: number;
  getAuths: (string | undefined)[];
  downloads: number;
}

async function startStub(goodClip: Buffer, badClip: Buffer): Promise<{ server: http.Server; baseUrl: string; state: StubState }> {
  const state: StubState = { createMode: "ok", taskStatus: "running", videoUrlPath: "/dl/good.mp4", posts: [], gets: 0, getAuths: [], downloads: 0 };
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/v3/contents/generations/tasks") {
      // 悬挂模式下客户端会中断连接，请求体 end 可能不触发：计数在请求进入时登记。
      const entry = { auth: request.headers.authorization, body: null as unknown };
      state.posts.push(entry);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (state.createMode === "hang") return; // 模拟创建请求悬挂：永不响应
        if (state.createMode === "echo400" || state.createMode === "echo503") {
          response.writeHead(state.createMode === "echo400" ? 400 : 503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "InvalidParameter", message: `invalid Authorization: ${entry.auth}` } }));
          return;
        }
        if (state.createMode === "reject400") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "InvalidParameter", message: "duration not supported" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "task-001" }));
      });
      return;
    }
    if (request.method === "GET" && url === "/v3/contents/generations/tasks/task-001") {
      state.gets += 1;
      state.getAuths.push(request.headers.authorization);
      if (state.createMode === "echoQuery503" || state.createMode === "echoTaskFailed") {
        response.writeHead(state.createMode === "echoQuery503" ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "failed", error: { code: "InvalidTask", message: `invalid Authorization: ${request.headers.authorization}` } }));
        return;
      }
      const base = { id: "task-001", model: "doubao-seedance-2-5-260628" };
      const body = state.taskStatus === "succeeded"
        ? { ...base, status: "succeeded", content: { video_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${state.videoUrlPath}` }, usage: { completion_tokens: 108000 } }
        : { ...base, status: state.taskStatus };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.method === "GET" && url === "/dl/good.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(goodClip); return; }
    if (request.method === "GET" && url === "/dl/bad.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(badClip); return; }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NotFound", message: "no such file" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`, state };
}

function mediaConfigRaw(baseUrl: string, overrides: Record<string, unknown> = {}): unknown {
  return { providerId: "ark", connectionId: "ark-default", modelId: "doubao-seedance-2-5-260628", baseUrl,
    credentialFile: "/outside/repo/ark-key.txt",
    video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
    quote: { amountMinor: 756, kind: "estimate", version: "test", source: "本地桩定价", verifiedAt: "2026-10-26" },
    ...overrides };
}

// 运行时测试直接构造配置对象（本地 HTTP 桩）；HTTPS 约束由 parseAgentMediaConfig 单测覆盖。
function testConfig(baseUrl: string, overrides: Partial<AgentMediaConfig> = {}): AgentMediaConfig {
  return { providerId: "ark", connectionId: "ark-default", modelId: "doubao-seedance-2-5-260628", baseUrl,
    credentialFile: "/outside/repo/ark-key.txt",
    video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
    quote: { amountMinor: 756, kind: "estimate", version: "test", source: "本地桩定价", verifiedAt: "2026-10-26" },
    ...overrides };
}

// 测试桩环境固定本地能力事实；凭据语义由 initializeArkVideoSettings 落库的 api_key 决定。
const TEST_RENDER_FACTS = { available: true, probeAvailable: true, aacAvailable: true, reason: "测试桩" };

function bindingOf(config: AgentMediaConfig) { return mediaBinding(config, config.connectionId); }

async function buildRealRuntime(directory: string, config: AgentMediaConfig, options: { apiKey?: string; requestTimeoutMs?: number; crash?: ProductionCrashHook } = {}): Promise<AgentRuntime> {
  const workRoot = path.join(directory, "media-work");
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, ...(options.crash ? { crash: options.crash } : {}), factory: (db, blobs) => {
      initializeArkVideoSettings(db, { clock: staticClock, legacy: { config, ...(options.apiKey ? { apiKey: options.apiKey } : {}) } });
      const arkPort = new ArkMediaPort(db, blobs, staticClock, { resolve: binding => resolveArkBinding(db, binding), workRoot,
        ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        fetchImpl: (input, init) => {
          const url = new URL(String(input));
          return fetch(url.origin === new URL(DEFAULT_ARK_VIDEO_PROFILE.baseUrl).origin
            ? `${new URL(config.baseUrl).origin}${url.pathname.replace(/^\/api/, "")}${url.search}` : input, init);
        } });
      return {
        port: new RealMediaGateway(
          new LocalRenderPort(db, blobs, staticClock, { workRoot }),
          { resolveProviderPort: binding => (resolveArkBinding(db, binding) ? arkPort : null) }),
        catalog: () => arkVideoCatalog(readArkVideoCurrent(db), TEST_RENDER_FACTS),
        models: () => { const current = readArkVideoCurrent(db); return current ? [arkVideoModelView(current, TEST_RENDER_FACTS)] : []; },
      };
    } },
  });
}

function changeArkKey(runtime: AgentRuntime, name: string, apiKey: string) {
  const db = runtime.database;
  initializeTextModelSettings(db, staticClock);
  initializeProviderConnections(db, [], staticClock);
  const state = readProviderConnections(db);
  const connection = state.connections.find(item => item.protocol === "ark")!;
  return saveProviderConnection(db, staticClock, "local-owner", {
    commandId: cmd(), expectedRevision: state.revision,
    connection: { ...connection, baseUrl: DEFAULT_ARK_VIDEO_PROFILE.baseUrl, name, apiKey,
      models: connection.models.map(model => ({ ...model, name, isDefault: true, baseUrl: null })) },
  });
}

async function deliverPrompt(runtime: AgentRuntime, conversationId: string, text: string): Promise<{ artifactId: string; revisionId: string; digest: string }> {
  runtime.host.faux?.setResponses([
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text } }] })]),
    fauxAssistantMessage("已交付。"),
  ]);
  await runtime.service.sendMessage("local-owner", conversationId, { commandId: cmd(), text: "给我 prompt", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  for (let i = 0; i < 100 && runtime.service.snapshot("local-owner", conversationId).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const artifact = runtime.service.snapshot("local-owner", conversationId).artifacts.items[0]!;
  const revision = runtime.service.readRevision("local-owner", artifact.id, artifact.revisionId);
  return { artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest };
}

function videoIntent(prompt: { artifactId: string; revisionId: string; digest: string }, config: AgentMediaConfig, overrides: Partial<ProductionIntent["operations"][number]> = {}): ProductionIntent {
  return { workId: null, title: "山路镜头", inputRevisions: [{ artifactId: prompt.artifactId, revisionId: prompt.revisionId }],
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: bindingOf(config),
      inputs: [{ kind: "artifact_revision", artifactId: prompt.artifactId, revisionId: prompt.revisionId, digest: prompt.digest }], maxCreateAttempts: 1,
      parameters: { durationSeconds: config.video.durationSeconds, aspectRatio: config.video.aspectRatio, resolution: config.video.resolution, audioMode: config.video.audioMode },
      ...overrides } as unknown as ProductionIntent["operations"][number]],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, maxSpend: { currency: "CNY", amountMinor: config.quote.amountMinor } };
}

async function acceptedVideoRun(runtime: AgentRuntime, conversationId: string, intent: ProductionIntent): Promise<string> {
  // B04：视频提案落在已进入方案阶段的事项内；受理前把方案主稿关联到本提案。
  const work = ensurePlanStageWork(runtime.database, staticClock(), { ownerId: "local-owner", conversationId }, intent.title);
  intent.workId = work.workId;
  const { proposal } = await runtime.service.prepareProposal("local-owner", conversationId, { commandId: cmd(), spec: intent });
  bindPreparedPlan(runtime.database, staticClock(), { ownerId: "local-owner", conversationId }, proposal, work);
  const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
  return admitted.run.id;
}

async function makeClip(file: string, size: string, rate: number, seconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=green:s=${size}:r=${rate}:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
}

async function withClips<T>(fn: (good: Buffer, bad: Buffer) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-real-"));
  await makeClip(path.join(directory, "good.mp4"), "1280x720", 24, 5);
  await makeClip(path.join(directory, "bad.mp4"), "640x360", 24, 5);
  try { return await fn(readFileSync(path.join(directory, "good.mp4")), readFileSync(path.join(directory, "bad.mp4"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

it("F1 视频创建及查询错误回显不进入持久事实或公开投影", async () => {
  const marker = "VIDEO-ERROR-SYNTHETIC-KEY";
  for (const [mode, expected] of [["echo400", "failed"], ["echo503", "unknown"], ["echoTaskFailed", "failed"], ["echoQuery503", "unknown"]] as const) {
    const stub = await startStub(Buffer.alloc(0), Buffer.alloc(0));
    stub.state.createMode = mode;
    const directory = await mkdtemp(path.join(tmpdir(), "vf-video-error-secret-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: marker });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "错误出口" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      await runtime.worker!.pollOnce();
      const attempt = attemptsFor(runtime.database, runId).at(-1)!;
      assert.equal(attempt.state, expected);
      assert.equal(attempt.billing_json, null);
      if (mode === "echoTaskFailed") {
        assert.match(runtime.service.getRun("local-owner", runId).issue?.message ?? "", /InvalidTask/);
      }
      assert.ok(!JSON.stringify(runtime.service.getRun("local-owner", runId)).includes(marker), "公开 Run 不回显 Key");
      assert.ok(!JSON.stringify(runtime.service.snapshot("local-owner", conversation.id)).includes(marker));
      for (const { name } of runtime.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        if (name === "ark_video_configuration_versions") continue;
        assert.ok(!JSON.stringify(runtime.database.prepare(`SELECT * FROM "${name}"`).all()).includes(marker), `${name} 不存 Key`);
      }
      assert.equal(stub.state.posts.length, 1);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  }
});

it("聊天文字经 Pi 准备提案，确认前不制作、不创建 Prompt 作品，确认后原文冻结执行", async () => {
  await withClips(async good => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-chat-input-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "从聊天制作" }).conversation;
      const text = "雨后山谷，镜头缓慢推进。\n保留远处的云雾。";
      runtime.host.faux?.setResponses([fauxAssistantMessage(text)]);
      await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "给我一条山谷 Prompt，先不制作", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
      for (let i = 0; i < 100 && runtime.service.snapshot("local-owner", conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
      // B04：聊天原文仍可冻结为 text 输入，但视频提案必须落在已进入方案阶段的创作事项内。
      const planWork = seedPlanStageWork(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, "山谷镜头");
      const spec: ProductionIntent = { workId: planWork.workId, title: "山谷镜头", inputRevisions: [],
        operations: [{ operationId: "shot", outputSlot: "video", kind: "video", model: bindingOf(config),
          inputs: [{ kind: "text", text }], parameters: config.video, maxCreateAttempts: 1 }],
        finalOutput: { operationId: "shot", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: config.quote.amountMinor } };
      runtime.host.faux?.setResponses([
        fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(spec))) })]),
        fauxAssistantMessage("提案已准备，请查看本次使用的文字和费用。"),
      ]);
      await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "按刚才的文字准备制作提案，先不要开始", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
      for (let i = 0; i < 100 && runtime.service.snapshot("local-owner", conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
      const snapshot = runtime.service.snapshot("local-owner", conversation.id);
      assert.equal(snapshot.activeRequestId, null);
      assert.equal(snapshot.artifacts.items.length, 0);
      const proposal = snapshot.proposals.items[0]!;
      assert.ok(proposal, "真实 Pi 工具循环应准备出提案");
      assert.equal(validatorFor("Proposal")(proposal).ok, true);
      assert.deepEqual(proposal.spec.inputRevisions, []);
      assert.deepEqual(proposal.spec.operations[0]!.inputs, [{ kind: "text", text }]);
      assert.equal(stub.state.posts.length, 0, "准备提案不产生供应商创建调用");
      assert.equal(snapshot.runs.items.length, 0);
      bindPreparedPlan(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, proposal, planWork);
      const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
      runtime.host.faux?.setResponses([fauxAssistantMessage("下一版改为晚霞；已受理的版本仍使用原文。")]);
      await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "下一版想改成晚霞，先聊聊", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
      for (let i = 0; i < 100 && runtime.service.snapshot("local-owner", conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
      stub.state.taskStatus = "succeeded";
      await runtime.worker!.pollOnce();
      await runtime.worker!.pollOnce();
      assert.deepEqual(stub.state.posts[0]!.body.content, [{ type: "text", text }]);
      assert.equal(stub.state.posts.length, 1);
      const result = runtime.service.getRun("local-owner", admitted.run.id);
      assert.equal(result.state, "succeeded");
      assert.equal(validatorFor("Run")(result).ok, true);
      assert.deepEqual(result.inputRevisions, []);
      assert.equal(runtime.service.snapshot("local-owner", conversation.id).artifacts.items.filter(item => item.kind === "video").length, 1, "只登记生成的视频");
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1-03：创建请求映射、单次创建、成功下载合规成品、终态不再 GET", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "真实通道" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "清晨沿山路行进的固定镜头，缓慢推近。");
      stub.state.taskStatus = "running";
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce(); // submit → POST + task id 持久化
      await runtime.worker!.pollOnce(); // query → running
      stub.state.taskStatus = "succeeded";
      await runtime.worker!.pollOnce(); // query → 下载 + 合规校验 + 发布
      const result = runtime.service.getRun("local-owner", runId);
      assert.equal(result.state, "succeeded");
      assert.equal(result.outputRevisions.length, 1);
      assert.equal(stub.state.posts.length, 1, "整个生命周期恰好一次创建请求");
      const post = stub.state.posts[0]!;
      assert.equal(post.auth, "Bearer test-key");
      assert.equal(post.body.model, config.modelId);
      assert.deepEqual(post.body.content, [{ type: "text", text: "清晨沿山路行进的固定镜头，缓慢推近。" }]);
      assert.equal(post.body.ratio, "16:9"); assert.equal(post.body.duration, 5);
      assert.equal(post.body.resolution, "720p"); assert.equal(post.body.generate_audio, false); assert.equal(post.body.watermark, false);
      const attempt = attemptsFor(runtime.database, runId).at(-1)!;
      assert.equal(attempt.provider_task_id, "task-001");
      const receipt = runtime.database.prepare("SELECT * FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id) as { provider_task_id: string; blob_id: string; digest: string };
      assert.equal(receipt.provider_task_id, "task-001"); assert.ok(receipt.blob_id);
      const facts = await probeVideoFile(path.join(directory, "media-work", attempt.id, "download.mp4"));
      assert.equal(facts.width, 1280); assert.equal(facts.height, 720);
      assert.equal(facts.hasAudio, false); assert.ok(Math.abs(facts.durationMs - 5000) <= 100);
      // C1-05：终态账务未核（含人工标记冲突）也不再触发供应商 GET。
      const getsAfterSuccess = stub.state.gets;
      runtime.database.prepare("UPDATE production_attempts SET billing_conflict=1 WHERE id=?").run(attempt.id);
      for (let i = 0; i < 3; i++) await runtime.worker!.pollOnce();
      assert.equal(stub.state.gets, getsAfterSuccess, "终态账务停查");
      assert.equal(stub.state.posts.length, 1, "不会再次创建");
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1-03：重启后只查询原任务——GET 继续而 POST 不增加，成品只下载发布一次", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const first = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    let second: AgentRuntime | null = null;
    try {
      const conversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "重启查询" }).conversation;
      const prompt = await deliverPrompt(first, conversation.id, "黄昏山路远景。");
      const runId = await acceptedVideoRun(first, conversation.id, videoIntent(prompt, config));
      await first.worker!.pollOnce();
      await first.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1);
      const getsBeforeRestart = stub.state.gets;
      await first.close();
      second = await buildRealRuntime(directory, config, { apiKey: "test-key" });
      await second.worker!.pollOnce();
      assert.ok(stub.state.gets > getsBeforeRestart, "重启后继续 GET 原任务");
      assert.equal(stub.state.posts.length, 1, "重启不重新创建");
      stub.state.taskStatus = "succeeded";
      await second.worker!.pollOnce();
      assert.equal(second.service.getRun("local-owner", runId).state, "succeeded");
      assert.equal(stub.state.downloads, 1, "成品只下载一次");
      const againDb = second.database;
      const again = await new ArkMediaPort(againDb, second.production!.blobs, staticClock,
        { resolve: binding => resolveArkBinding(againDb, binding), workRoot: path.join(directory, "media-work") })
        .query({ runId: runId, operationId: "shot-1", attemptId: attemptsFor(second.database, runId).at(-1)!.id, requestIdentity: attemptsFor(second.database, runId).at(-1)!.request_identity, providerTaskId: "task-001", accountBinding: bindingOf(config), kind: "provider" });
      assert.equal(again.state, "succeeded", "已有有效收据时直接复用，不再下载");
      assert.equal(stub.state.downloads, 1);
    } finally { if (first.database.open) await first.close(); await (second ? second.close() : Promise.resolve()); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1-03：创建请求超时→受理结果未知的稳定 unknown，不自动重新提交", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    stub.state.createMode = "hang";
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key", requestTimeoutMs: 300 });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "超时未知" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "夜色山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      const attempt = attemptsFor(runtime.database, runId).at(-1)!;
      assert.equal(attempt.state, "unknown");
      const observationCount = () => (runtime.database.prepare("SELECT COUNT(*) AS n FROM ledger_observations WHERE attempt_id=?").get(attempt.id) as { n: number }).n;
      await runtime.worker!.pollOnce();
      const baseline = observationCount();
      await runtime.worker!.pollOnce(); await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1, "超时后绝不重新 POST");
      assert.equal(stub.state.gets, 0, "没有任务身份不做 GET");
      assert.equal(observationCount(), baseline, "稳定 unknown 不产生新账本行");
      const runState = runtime.service.getRun("local-owner", runId);
      assert.equal(runState.state, "unknown");
      assert.match(runState.issue?.message ?? "", /任务身份|未核实/);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.state.createMode = "ok"; stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1-03：供应商 4xx 明确拒绝→failed 且不重试；不合规成品→failed 并保留任务身份", async () => {
  await withClips(async (good, bad) => {
    const stub = await startStub(good, bad);
    stub.state.createMode = "reject400";
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "拒绝" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      assert.equal(runtime.service.getRun("local-owner", runId).state, "failed");
      assert.match(runtime.service.getRun("local-owner", runId).issue?.message ?? "", /供应商明确拒绝.*HTTP 400/);
      for (let i = 0; i < 2; i++) await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1, "明确拒绝不重试");
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }

    // 不合规成品：供应商成功但画幅不符 → failed 终态、保留 task id、不再反复获取同一无效文件。
    const stub2 = await startStub(good, bad);
    stub2.state.videoUrlPath = "/dl/bad.mp4";
    stub2.state.taskStatus = "succeeded";
    const directory2 = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config2 = testConfig(stub2.baseUrl);
    const runtime2 = await buildRealRuntime(directory2, config2, { apiKey: "test-key" });
    try {
      const conversation = runtime2.service.createConversation("local-owner", { commandId: cmd(), title: "不合规" }).conversation;
      const prompt = await deliverPrompt(runtime2, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime2, conversation.id, videoIntent(prompt, config2));
      await runtime2.worker!.pollOnce();
      await runtime2.worker!.pollOnce();
      assert.equal(runtime2.service.getRun("local-owner", runId).state, "failed");
      assert.match(runtime2.service.getRun("local-owner", runId).issue?.message ?? "", /不满足冻结参数/);
      const attempt = attemptsFor(runtime2.database, runId).at(-1)!;
      const receipt = runtime2.database.prepare("SELECT provider_task_id, exit_kind FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id) as { provider_task_id: string; exit_kind: string };
      assert.equal(receipt.provider_task_id, "task-001"); assert.equal(receipt.exit_kind, "failed");
      const getsAfterFailure = stub2.state.gets;
      for (let i = 0; i < 2; i++) await runtime2.worker!.pollOnce();
      assert.equal(stub2.state.gets, getsAfterFailure, "终态账务停查（不重复获取无效文件）");
    } finally { await runtime2.close(); await rm(directory2, { recursive: true, force: true }); stub2.server.closeAllConnections(); stub2.server.close(); }
  });
});

it("C1-03：下载暂时失败保留任务身份继续下载；换配置重启仍用冻结绑定查询", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    stub.state.taskStatus = "succeeded";
    stub.state.videoUrlPath = "/dl/missing";
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    let rebuilt: AgentRuntime | null = null;
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "下载重试" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      await runtime.worker!.pollOnce(); // 下载 404 → running 保留身份
      const attempt = attemptsFor(runtime.database, runId).at(-1)!;
      assert.equal(attempt.state, "running", "下载失败不判死，任务身份保留待重下");
      assert.equal(stub.state.posts.length, 1);
      // C2：换连接配置重启——版本表保留冻结版本与原 Key，任务继续用原绑定查询，不用新配置重新创建。
      const configB = testConfig(stub.baseUrl, { connectionId: "ark-backup" });
      assert.notEqual(mediaConfigurationRevisionId(configB, configB.connectionId), mediaConfigurationRevisionId(config, config.connectionId));
      await runtime.close();
      rebuilt = await buildRealRuntime(directory, configB, { apiKey: "test-key" });
      const getsBefore = stub.state.gets;
      await rebuilt.worker!.pollOnce();
      assert.equal(stub.state.gets, getsBefore + 1, "换配置重启仍用冻结绑定的原版本查询");
      assert.equal(stub.state.posts.length, 1, "不重新创建");
      const driftAttempt = attemptsFor(rebuilt.database, runId).at(-1)!;
      assert.equal(driftAttempt.state, "running", "下载仍失败时任务身份继续保留");
      assert.equal(resolveArkBinding(rebuilt.database, bindingOf(configB)), null, "库外绑定版本不可解析");
    } finally { if (runtime.database.open) await runtime.close(); await (rebuilt ? rebuilt.close() : Promise.resolve()); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1 审计：完整下载的损坏文件明确失败，不反复下载，也不发布成品", async () => {
  const broken = Buffer.from("this is not a video");
  const stub = await startStub(broken, broken);
  stub.state.taskStatus = "succeeded";
  const directory = await mkdtemp(path.join(tmpdir(), "frame-corrupt-output-"));
  const config = testConfig(stub.baseUrl);
  const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "损坏成品" }).conversation;
    const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
    const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
    await runtime.worker!.pollOnce();
    await runtime.worker!.pollOnce();
    assert.equal(runtime.service.getRun("local-owner", runId).state, "failed");
    assert.equal(runtime.service.getRun("local-owner", runId).outputRevisions.length, 0);
    assert.match(runtime.service.getRun("local-owner", runId).issue?.message ?? "", /不可读/);
    const gets = stub.state.gets;
    await runtime.worker!.pollOnce();
    assert.equal(stub.state.gets, gets);
    assert.equal(stub.state.downloads, 1);
    assert.equal(stub.state.posts.length, 1);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
});

it("C1-05：凭据未启用即显示不可用，准备制作前拒绝，不冻结输入或产生待核费用", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config); // 不传 apiKey
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "锁定" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      assert.equal(runtime.service.bootstrap("local-owner").models.find(model => model.kind === "video")?.availability, "unavailable");
      await assert.rejects(() => acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config)),
        (error: { code?: string }) => error.code === "CAPABILITY_UNAVAILABLE");
      assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
      assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_input_locks").get() as { n: number }).n, 0);
      assert.equal(stub.state.posts.length, 0, "锁定态不发起任何创建请求");
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1-02：配置解析与目录构建——未核实参数组合拒绝、render 能力显式注册、报价入 Bootstrap 说明", async () => {
  assert.throws(() => parseAgentMediaConfig(mediaConfigRaw("http://insecure.example/api/v3")), /HTTPS/);
  for (const change of [{ durationSeconds: 10 }, { durationSeconds: 0 }, { resolution: "1080p" }, { aspectRatio: "9:16" }, { audioMode: "native" }]) {
    assert.throws(() => parseAgentMediaConfig(mediaConfigRaw("https://ark.example/api/v3", {
      video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none", ...change },
    })), /旧导入格式只接受/);
  }
  assert.throws(() => parseAgentMediaConfig(mediaConfigRaw("https://ark.example/api/v3", { quote: { amountMinor: 756, kind: "bounded", version: "t", source: "s", verifiedAt: "d" } })), /estimate/);
  const config = parseAgentMediaConfig(mediaConfigRaw("https://ark.example/api/v3"));
  const moved = parseAgentMediaConfig(mediaConfigRaw("https://ark.example/api/v3", { credentialFile: "/elsewhere/key.txt" }));
  assert.equal(mediaConfigurationRevisionId(moved, moved.connectionId), mediaConfigurationRevisionId(config, config.connectionId), "移动密钥文件不是换账号");
  const repriced = parseAgentMediaConfig(mediaConfigRaw("https://ark.example/api/v3", {
    quote: { ...config.quote, amountMinor: 800, version: "changed" },
  }));
  assert.notEqual(mediaConfigurationRevisionId(repriced, repriced.connectionId), mediaConfigurationRevisionId(config, config.connectionId), "报价变化必须换绑定修订");
  // 目录与模型投影走真实设置库：凭据 + 探测就绪才注册 video；render 条目独立于 ffprobe。
  const settingsDir = await mkdtemp(path.join(tmpdir(), "frame-real-catalog-"));
  try {
    const db = openAgentDatabase(settingsDir);
    initializeArkVideoSettings(db, { clock: staticClock, legacy: { config, apiKey: "test-key" } });
    const current = readArkVideoCurrent(db)!;
    const ffmpegMissing = { available: false, probeAvailable: true, aacAvailable: false, reason: "缺少 ffmpeg" };
    const probeMissing = { available: false, probeAvailable: false, aacAvailable: false, reason: "缺少 ffprobe" };
    assert.ok(arkVideoCatalog(current, TEST_RENDER_FACTS)["render:ordered_concat"], "本地能力核实时注册 render 条目");
    assert.ok(!arkVideoCatalog(current, ffmpegMissing)["render:ordered_concat"], "本地能力缺失时不注册 render 条目");
    assert.ok(arkVideoCatalog(current, ffmpegMissing)[`video:${config.modelId}`], "只有编码器不可用不阻断纯视频");
    assert.equal(arkVideoModelView(current, ffmpegMissing).availability, "configured", "编码器缺失只影响 render，不影响视频模型可用性");
    assert.ok(!arkVideoCatalog(current, probeMissing)[`video:${config.modelId}`], "缺少 ffprobe 不得收费后才发现不能验收");
    assert.equal(arkVideoModelView(current, probeMissing).availability, "unavailable");
    assert.match(arkVideoModelView(current, TEST_RENDER_FACTS).verificationNote, /7\.56/);
    assert.equal(arkVideoModelView(current, TEST_RENDER_FACTS).kind, "video");
    db.close();
  } finally { await rm(settingsDir, { recursive: true, force: true }); }
});

it("C1-02：付费前目录校验——参数/尝试次数/绑定不一致在准备阶段拒绝，不产生运行", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-run-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "受理校验" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const planWork = seedPlanStageWork(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, "山路镜头");
      const rejects: ProductionIntent[] = [
        videoIntent(prompt, config, { parameters: { durationSeconds: 6, aspectRatio: "16:9", resolution: "720p", audioMode: "none" } } as never),
        videoIntent(prompt, config, { maxCreateAttempts: 2 } as never),
        videoIntent(prompt, config, { model: { ...bindingOf(config), connectionId: "other-connection" } } as never),
        videoIntent(prompt, config, { inputs: [] } as never),
      ].map(intent => ({ ...intent, workId: planWork.workId }));
      for (const intent of rejects) {
        await assert.rejects(() => runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: intent }),
          (error: { code?: string }) => error.code === "CAPABILITY_UNAVAILABLE" || error.code === "INVALID_INPUT");
      }
      assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0, "付费前拒绝不产生运行");
      assert.equal(stub.state.posts.length, 0);
      // 正常提案：估价与披露文案进入提案。
      const validIntent = videoIntent(prompt, config); validIntent.workId = planWork.workId;
      const { proposal } = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: validIntent });
      bindPreparedPlan(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, proposal, planWork);
      assert.match(proposal.priceDisclosure, /估算 7\.56/);
      // C2：Web 保存换 Key 后 current 已切到新版本，旧冻结提案被标 stale，受理拒绝（PROPOSAL_STALE）。
      const rebuilt = await buildRealRuntime(directory, config, { apiKey: "test-key" });
      try {
        const saved = changeArkKey(rebuilt, "备份连接", "test-key-b");
        assert.deepEqual(saved.changedConversations, [conversation.id], "引用旧绑定的 ready 提案所在会话收到变更通知");
        let stale: { code?: string } | undefined;
        try { await rebuilt.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest }); }
        catch (error) { stale = error as { code?: string }; }
        assert.equal(stale?.code, "PROPOSAL_STALE");
        assert.equal((rebuilt.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
      } finally { await rebuilt.close(); }
    } finally { if (runtime.database.open) await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});


it("C1 审计：创建收据已有 task ID、结果事务回滚后只查原任务，不重新创建", async () => {
  await withClips(async good => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-receipt-recovery-"));
    const config = testConfig(stub.baseUrl);
    const first = await buildRealRuntime(directory, config, { apiKey: "test-key", crash: point => {
      if (point === "before-result-commit") throw new Error("result transaction interrupted");
    } });
    let second: AgentRuntime | undefined;
    try {
      const conversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "收据恢复" }).conversation;
      const prompt = await deliverPrompt(first, conversation.id, "山路。");
      const runId = await acceptedVideoRun(first, conversation.id, videoIntent(prompt, config));
      await assert.rejects(() => first.worker!.pollOnce(), /result transaction interrupted/);
      const attempt = attemptsFor(first.database, runId)[0]!;
      assert.equal(attempt.provider_task_id, null);
      assert.equal((first.database.prepare("SELECT provider_task_id FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id) as { provider_task_id: string }).provider_task_id, "task-001");
      await first.close();
      stub.state.taskStatus = "succeeded";
      second = await buildRealRuntime(directory, config, { apiKey: "test-key" });
      await second.worker!.pollOnce();
      assert.equal(second.service.getRun("local-owner", runId).state, "succeeded");
      assert.equal(second.service.getRun("local-owner", runId).outputRevisions.length, 1);
      await second.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1);
      assert.equal(stub.state.gets, 1);
      assert.equal(stub.state.downloads, 1);
    } finally {
      if (first.database.open) await first.close();
      await second?.close();
      await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close();
    }
  });
});

it("C1 审计：已完整落盘而未写输出收据时，优先采纳本地文件，不依赖供应商继续可查", async () => {
  await withClips(async good => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-downloaded-recovery-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "本地成品" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      const attempt = attemptsFor(runtime.database, runId)[0]!;
      const outputDir = path.join(directory, "media-work", attempt.id);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(path.join(outputDir, "download.mp4"), good);
      stub.state.taskStatus = "expired";
      await runtime.worker!.pollOnce();
      assert.equal(runtime.service.getRun("local-owner", runId).state, "succeeded");
      assert.equal(stub.state.gets, 0);
      assert.equal(stub.state.downloads, 0);
      assert.equal(stub.state.posts.length, 1);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C1 审计：video 输出接入真实 ordered_concat，重复片段保留顺序且仅创建一次视频", async () => {
  await withClips(async good => {
    const stub = await startStub(good, good);
    stub.state.taskStatus = "succeeded";
    const directory = await mkdtemp(path.join(tmpdir(), "frame-video-render-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "test-key" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "生成到拼接" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const intent = videoIntent(prompt, config);
      intent.operations.push({ operationId: "cut", outputSlot: "final", kind: "render", model: null, maxCreateAttempts: 1,
        inputs: [{ kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" }, { kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" }],
        parameters: { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 } });
      intent.finalOutput = { operationId: "cut", outputSlot: "final" };
      const runId = await acceptedVideoRun(runtime, conversation.id, intent);
      for (let i = 0; i < 5; i++) await runtime.worker!.pollOnce();
      const result = runtime.service.getRun("local-owner", runId);
      assert.equal(result.state, "succeeded");
      assert.equal(result.outputRevisions.length, 2, "生成片段与最终拼接各发布一份");
      const render = attemptsFor(runtime.database, runId).find(attempt => attempt.operation_id === "cut")!;
      const facts = await probeVideoFile(path.join(directory, "media-work", render.id, "output.mp4"));
      assert.equal(facts.width, 1280); assert.equal(facts.height, 720); assert.equal(facts.frameRate, 24);
      assert.ok(Math.abs(facts.durationMs - 10000) <= 125);
      assert.equal(stub.state.posts.length, 1);
      assert.equal(stub.state.downloads, 1);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C2-07：受理后换键——冻结任务首次创建与后续查询都用原键；新提案用新键", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-c207-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "key-A" });
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "换键执行" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1);
      assert.equal(stub.state.posts[0]!.auth, "Bearer key-A", "第一次创建用受理时冻结的键");

      changeArkKey(runtime, "B 连接", "key-B");

      stub.state.taskStatus = "succeeded";
      await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1, "换键不重新创建");
      assert.ok(stub.state.getAuths.length > 0 && stub.state.getAuths.every(auth => auth === "Bearer key-A"), "查询仍用原键");
      assert.equal(runtime.service.getRun("local-owner", runId).state, "succeeded");

      // 新提案走已切换的目录条目，创建用新键；两个运行互不串账号。
      stub.state.taskStatus = "running";
      const prompt2 = await deliverPrompt(runtime, conversation.id, "第二段山路。");
      const newBinding = JSON.parse(readArkVideoCurrent(runtime.database)!.version.binding_json);
      await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt2, config, { model: newBinding } as never));
      await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 2);
      assert.equal(stub.state.posts[1]!.auth, "Bearer key-B", "新提案用新键");
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C2-08：换键重启后查询/下载仍用原键且不创建；终态财务不阻塞保存", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-c208-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "key-A" });
    let rebuilt: AgentRuntime | null = null;
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "换键重启" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1);

      changeArkKey(runtime, "B 连接", "key-B");
      await runtime.close();
      rebuilt = await buildRealRuntime(directory, config, { apiKey: "key-A" }); // 已有设置行：legacy 参数 no-op，current 保持 B
      stub.state.taskStatus = "succeeded";
      await rebuilt.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1, "重启不重新创建");
      assert.ok(stub.state.getAuths.length > 0 && stub.state.getAuths.every(auth => auth === "Bearer key-A"), "查询与下载仍用冻结版本的原键");
      assert.equal(rebuilt.service.getRun("local-owner", runId).state, "succeeded");

      changeArkKey(rebuilt, "C 连接", "key-C");
      assert.equal(readArkVideoCurrent(rebuilt.database)!.version.api_key, "key-C", "终态财务不阻塞统一连接保存");
    } finally { if (runtime.database.open) await runtime.close(); await (rebuilt ? rebuilt.close() : Promise.resolve()); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});

it("C2-08：无身份 unknown 的运行换键重启后不产生第二次创建", async () => {
  await withClips(async (good) => {
    const stub = await startStub(good, good);
    stub.state.createMode = "hang";
    const directory = await mkdtemp(path.join(tmpdir(), "frame-real-c208b-"));
    const config = testConfig(stub.baseUrl);
    const runtime = await buildRealRuntime(directory, config, { apiKey: "key-A", requestTimeoutMs: 300 });
    let rebuilt: AgentRuntime | null = null;
    try {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "超时后换键" }).conversation;
      const prompt = await deliverPrompt(runtime, conversation.id, "山路。");
      const runId = await acceptedVideoRun(runtime, conversation.id, videoIntent(prompt, config));
      await runtime.worker!.pollOnce();
      const attempt = attemptsFor(runtime.database, runId).at(-1)!;
      assert.equal(attempt.state, "unknown", "创建超时无任务身份");

      changeArkKey(runtime, "B 连接", "key-B");
      await runtime.close();
      stub.state.createMode = "ok";
      rebuilt = await buildRealRuntime(directory, config, { apiKey: "key-A" });
      await rebuilt.worker!.pollOnce();
      await rebuilt.worker!.pollOnce();
      assert.equal(stub.state.posts.length, 1, "无身份 unknown 不自动重新提交（首次创建请求已挂起计数）");
      assert.equal(attemptsFor(rebuilt.database, runId).at(-1)!.state, "unknown");
    } finally { if (runtime.database.open) await runtime.close(); await (rebuilt ? rebuilt.close() : Promise.resolve()); await rm(directory, { recursive: true, force: true }); stub.server.closeAllConnections(); stub.server.close(); }
  });
});
