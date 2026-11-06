import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { buildFrameApp } from "../src/server/agent/app.js";
import { savePexelsServiceSettings } from "../src/server/agent/free-service-settings.js";
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { ArkMediaPort, RealMediaGateway } from "../src/server/agent/ark-media.js";
import { OpenAISpeechPort } from "../src/server/agent/openai-speech.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import {
  mediaBinding, narratedRenderCatalogEntry, renderCatalogEntry, timedNarratedRenderCatalogEntry,
  openaiSpeechBinding, openaiSpeechProfile,
  type AgentMediaConfig,
} from "../src/server/agent/media-config.js";
import {
  additionalMediaCatalog, insertAdditionalMediaVersion, readAdditionalMediaCurrent, resolveOpenAISpeechBinding,
} from "../src/server/agent/additional-media-settings.js";
import { FakeRealtimeHub } from "./helpers/agent-openai-media.js";
import {
  arkVideoCatalog, initializeArkVideoSettings, readArkVideoCurrent, resolveArkBinding,
} from "../src/server/agent/ark-video-settings.js";
import { probeAudioFile, probeVideoFile } from "../src/server/agent/media-probe.js";
import { blobSources, recordBlobSources } from "../src/server/agent/material-store.js";
import { attemptsFor } from "../src/server/agent/production-store.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { bindPreparedPlan, deliverStageDrafts, ensurePlanStageWork, type PlanStageWork } from "./helpers/creative-work-fixture.js";
import { createWork, recordStageConfirmation } from "../src/server/agent/creative-work.js";
import { toolIntentOf } from "./helpers/tool-args.js";
import type { AgentDatabase } from "../src/server/agent/db.js";
import type { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import type { MediaExecutionPort } from "../src/shared/agent/ports.js";
import type { MaterialSearchResult, MaterialImportResult, MediaContent, MediaProvenance, ModelBinding, ProductionIntent, Proposal, RenderParameters, Run } from "../src/shared/agent/generated/contracts.js";

// T6 narrated_concat 验收（§10 T6-01..T6-11）：判别分支、preserve_all 时长策略、槽位角色、
// 来源按画面顺序聚合。全程不触真实外网：视频是本地 HTTP 桩（Ark），配音是进程内 Realtime 替身，
// 媒体字节由本地 ffmpeg 生成/转码；不以 Faux 声明真实供应商通过。

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `t6-${++sequence}`;
const staticClock = () => "2026-10-28T00:00:00.000Z";
const TEST_RENDER_FACTS = { available: true, probeAvailable: true, aacAvailable: true, reason: "测试桩" };
type NarratedParameters = Extract<RenderParameters, { assembly: "narrated_concat" }>;

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };

// —— 媒体夹具（本地 ffmpeg 生成真实字节） ——

async function makeClip(file: string, color: "red" | "blue" | "green", rate: number, seconds: number, withAudio = false): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=${rate}:d=${seconds}`];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=220:duration=" + seconds);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  await run("ffmpeg", args);
}

async function makeMp3(file: string, seconds: number, sampleRateHz = 32000): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ar", String(sampleRateHz), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", file]);
}

async function frameColor(file: string, atSeconds: number): Promise<[number, number, number]> {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1024, encoding: "buffer" });
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}
const isRed = (rgb: [number, number, number]) => rgb[0]! > 150 && rgb[2]! < 100;
const isBlue = (rgb: [number, number, number]) => rgb[2]! > 150 && rgb[0]! < 100;

// 波形证据：指定窗口的最大音量（dB）。有声窗口应显著高于补静音窗口。
async function maxVolumeDb(file: string, fromSeconds: number, seconds: number): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(fromSeconds), "-t", String(seconds), "-i", file,
    "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 });
  const match = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, "volumedetect 应输出 max_volume");
  return Number(match[1]);
}

async function outputAudioFacts(file: string): Promise<{ codec: string | undefined; channels: number | undefined; sampleRate: string | undefined }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", file]);
  const stream = (JSON.parse(stdout) as { streams?: { codec_name?: string; channels?: number; sample_rate?: string }[] }).streams?.[0] ?? {};
  return { codec: stream.codec_name, channels: stream.channels, sampleRate: stream.sample_rate };
}

// —— 修订/intent 助手 ——

interface Ref { artifactId: string; revisionId: string; digest: string }

// 媒体修订按 worker.publish 的行形状直接落库：render 输入走 artifact_revision(media) 引用。
function mediaRevision(runtime: AgentRuntime, conversationId: string, buffer: Buffer, mimeType: "video/mp4" | "audio/mpeg" | "image/png", durationMs: number): Ref {
  const blobs = runtime.production!.blobs;
  const blob = blobs.persist("local-owner", conversationId, buffer, mimeType, durationMs);
  const content = { format: "media", blobId: blob.id, mimeType, durationMs };
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = staticClock();
  const kind = mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("image/") ? "image" : "video";
  const db = runtime.database;
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,1,?,?,?)")
    .run(artifactId, conversationId, "local-owner", kind === "audio" ? "配音片段" : kind === "image" ? "图片片段" : "拼接片段",
      kind, revisionId,
      (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversationId) as { n: number }).n, now, now);
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,created_at) VALUES(?,?,1,NULL,?,?,?)")
    .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);
  db.prepare("UPDATE artifacts SET head_revision_id=? WHERE id=?").run(revisionId, artifactId);
  return { artifactId, revisionId, digest: digestOf(content) };
}

function renderOp(inputs: ProductionIntent["operations"][number]["inputs"], parameters: RenderParameters) {
  return { operationId: "render", outputSlot: "final", kind: "render" as const, model: null, inputs, maxCreateAttempts: 1 as const, parameters };
}

// narrated 图默认：视频槽位按传入顺序 0..n-1，旁白槽位是最后一个输入。
function narratedIntent(videos: Ref[], narration: Ref, overrides: { videoInputSlots?: number[] } = {}): ProductionIntent {
  if (!videos.length) throw new Error("narrated 至少一个视频画面");
  const inputs = [...videos, narration].map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest })) as ProductionIntent["operations"][number]["inputs"];
  const parameters: NarratedParameters = { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24,
    videoInputSlots: (overrides.videoInputSlots ?? videos.map((_, index) => index)) as [number, ...number[]], narrationInputSlot: videos.length, durationPolicy: "preserve_all" };
  return { workId: null, title: "山脊晨光有声版",
    inputRevisions: [...videos, narration].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [renderOp(inputs, parameters)],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

function orderedIntent(clips: Ref[]): ProductionIntent {
  const inputs = clips.map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest })) as ProductionIntent["operations"][number]["inputs"];
  return { workId: null, title: "无声拼接",
    inputRevisions: clips.map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [renderOp(inputs, { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 })],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

// 视频 render/成片必须有已正式开始的创作（B04/T04）：这里用产品内核把事项推进到方案阶段，
// 成功准备时把方案主稿按真实交付事务关联到该提案。规则本身不放宽。
const scopeOf = (conversationId: string) => ({ ownerId: "local-owner", conversationId });

function stageWork(runtime: AgentRuntime, conversationId: string, title = "有声短片"): PlanStageWork {
  return ensurePlanStageWork(runtime.database, staticClock(), scopeOf(conversationId), title);
}

function withWork(runtime: AgentRuntime, conversationId: string, intent: ProductionIntent): PlanStageWork {
  const work = stageWork(runtime, conversationId);
  intent.workId = work.workId;
  return work;
}

async function prepareIntent(runtime: AgentRuntime, conversationId: string, intent: ProductionIntent) {
  const work = withWork(runtime, conversationId, intent);
  const prepared = await runtime.service.prepareProposal("local-owner", conversationId, { commandId: cmd(), spec: intent });
  bindPreparedPlan(runtime.database, staticClock(), scopeOf(conversationId), prepared.proposal, work);
  return prepared;
}

async function acceptIntent(runtime: AgentRuntime, conversationId: string, intent: ProductionIntent): Promise<string> {
  const { proposal } = await prepareIntent(runtime, conversationId, intent);
  const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
  return admitted.run.id;
}

const terminal = (state: Run["state"]) => state === "succeeded" || state === "failed" || state === "cancelled";
async function drive(runtime: AgentRuntime, runId: string, cap = 24): Promise<Run> {
  for (let i = 0; i < cap; i++) {
    await runtime.worker!.pollOnce();
    if (terminal(runtime.service.getRun("local-owner", runId).state)) break;
  }
  return runtime.service.getRun("local-owner", runId);
}

async function outputRevisionOf(runtime: AgentRuntime, result: Run) {
  const output = result.outputRevisions.at(-1)!;
  const revision = runtime.service.readRevision("local-owner", output.artifactId, output.revisionId);
  assert.equal(revision.content.format, "media");
  return revision.content as Extract<MediaContent, { format: "media" }>;
}

async function outputFileOf(runtime: AgentRuntime, runId: string, workRoot: string, operationId = "render"): Promise<string> {
  const attempt = attemptsFor(runtime.database, runId).find(row => row.operation_id === operationId)!;
  assert.ok(attempt, `应存在 ${operationId} 尝试`);
  const file = path.join(workRoot, attempt.id, "output.mp4");
  assert.ok(existsSync(file), "成片应落在确定性位置");
  return file;
}

const workRootOf = (directory: string) => path.join(directory, "media-work");

// —— 本地运行时：只有本地拼接目录（ordered + narrated 两个条目） ——

const LOCAL_CATALOG = () => ({ "render:ordered_concat": renderCatalogEntry(true), "render:narrated_concat": narratedRenderCatalogEntry(), "render:timed_narrated_concat": timedNarratedRenderCatalogEntry() });

function buildLocalRuntime(directory: string, createPort?: (blobs: ProductionBlobs, db: AgentDatabase) => MediaExecutionPort): Promise<AgentRuntime> {
  const workRoot = path.join(directory, "media-work");
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs) => ({
      port: createPort ? createPort(blobs, db) : new LocalRenderPort(db, blobs, staticClock, { workRoot }),
      catalog: LOCAL_CATALOG, models: () => [],
    }) },
  });
}

// —— 组合供应商桩：Ark 视频走本地 HTTP；配音走进程内 Realtime 替身（FakeRealtimeHub） ——

interface GraphStubState {
  arkPosts: { auth: string | undefined; body: any }[];
  arkGets: number;
  downloads: number;
}

async function startGraphStub(video: Buffer): Promise<{ server: http.Server; base: string; state: GraphStubState }> {
  const state: GraphStubState = { arkPosts: [], arkGets: 0, downloads: 0 };
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const readBody = (then: (body: any) => void) => {
      const entry = { auth: request.headers.authorization, body: null as unknown };
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); then(entry.body); });
      return entry;
    };
    if (request.method === "POST" && url === "/v3/contents/generations/tasks") {
      const entry = readBody(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "task-t6" })); });
      state.arkPosts.push(entry);
      return;
    }
    if (request.method === "GET" && url === "/v3/contents/generations/tasks/task-t6") {
      state.arkGets += 1;
      const base = { id: "task-t6", model: "doubao-seedance-2-5-260628" };
      const body = state.arkGets >= 2
        ? { ...base, status: "succeeded", content: { video_url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/dl/good.mp4` }, usage: { completion_tokens: 108000 } }
        : { ...base, status: "running" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.method === "GET" && url === "/dl/good.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(video); return; }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NotFound", message: "no such path" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, state };
}

const closeStub = (stub: { server: http.Server }) => { stub.server.closeAllConnections(); stub.server.close(); };

const arkConfigOf = (base: string): AgentMediaConfig => ({
  providerId: "ark", connectionId: "ark-default", modelId: "doubao-seedance-2-5-260628", baseUrl: `${base}/v3`, credentialFile: "/outside/repo/ark-key.txt",
  video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
  quote: { amountMinor: 756, kind: "estimate", version: "test", source: "本地桩定价", verifiedAt: "2026-10-28" },
});

let initSequence = 0;
function initSpeechChannel(db: AgentDatabase, base: string, apiKey: string): void {
  // 统一连接保存是唯一配置入口；测试直接按 projectAdditionalMedia 的落库形状建版本与当前行。
  // 已有当前行（重启同一数据目录）时保留原配置，不重复初始化。
  if (db.prepare("SELECT 1 FROM additional_media_settings WHERE channel_id='openai-speech'").get()) return;
  const profile = openaiSpeechProfile("gpt-realtime-2.1-mini", `${base}/v1`);
  const binding = openaiSpeechBinding(profile, newAgentId(`conn-${++initSequence}`));
  insertAdditionalMediaVersion(db, staticClock(), "openai-speech", binding, profile, apiKey);
  db.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('openai-speech',0,?,?,?)")
    .run(`OpenAI 配音（${profile.modelId}）`, binding.configurationRevisionId, staticClock());
}

function buildGraphRuntime(directory: string, base: string, hub: FakeRealtimeHub, materials?: AgentRuntimeOptions["materials"],
  speech?: { sessionTimeoutMs?: number }): Promise<AgentRuntime> {
  const workRoot = path.join(directory, "media-work");
  const config = arkConfigOf(base);
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    ...(materials ? { materials } : {}),
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs) => {
      initializeArkVideoSettings(db, { clock: staticClock, legacy: { config, apiKey: "t6-ark-key" } });
      initSpeechChannel(db, base, "t6-speech-key");
      const speechPort = new OpenAISpeechPort(db, blobs, staticClock, {
        resolve: binding => resolveOpenAISpeechBinding(db, binding), workRoot, transportFactory: hub.factory,
        ...(speech?.sessionTimeoutMs !== undefined ? { sessionTimeoutMs: speech.sessionTimeoutMs } : {}),
      });
      const arkPort = new ArkMediaPort(db, blobs, staticClock, { resolve: binding => resolveArkBinding(db, binding), workRoot });
      return {
        port: new RealMediaGateway(
          new LocalRenderPort(db, blobs, staticClock, { workRoot }),
          { resolveProviderPort: binding => (resolveArkBinding(db, binding) ? arkPort : resolveOpenAISpeechBinding(db, binding) ? speechPort : null), clock: staticClock },
        ),
        catalog: () => ({ ...arkVideoCatalog(readArkVideoCurrent(db), TEST_RENDER_FACTS), ...additionalMediaCatalog(db, true) }),
        models: () => [],
      };
    } },
  });
}

async function waitForRequest(runtime: AgentRuntime, conversationId: string): Promise<void> {
  for (let i = 0; i < 200 && runtime.service.snapshot("local-owner", conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// 一次 faux 请求交付整批 Markdown 产物（T6-01 的两份文本 / T6-10 的整批交付）。
async function deliverTexts(runtime: AgentRuntime, conversationId: string, items: { title: string; text: string }[]): Promise<Ref[]> {
  runtime.host.faux?.setResponses([
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: items.map(item => ({ mode: "create", title: item.title, kind: "prompt", content: { format: "markdown", text: item.text } })) })]),
    fauxAssistantMessage("已交付。"),
  ]);
  await runtime.service.sendMessage("local-owner", conversationId, { commandId: cmd(), text: "给我文本", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  await waitForRequest(runtime, conversationId);
  const artifacts = runtime.service.snapshot("local-owner", conversationId).artifacts.items;
  return items.map(item => {
    const artifact = artifacts.find(entry => entry.title === item.title)!;
    assert.ok(artifact, `交付产物 ${item.title} 应出现在快照中`);
    const revision = runtime.service.readRevision("local-owner", artifact.id, artifact.revisionId);
    return { artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest };
  }) as [Ref, ...Ref[]];
}

function graphIntent(prompt: Ref, narration: Ref, config: AgentMediaConfig, speechBinding: ModelBinding): ProductionIntent {
  return { workId: null, title: "山脊晨光有声短片",
    inputRevisions: [prompt, narration].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [
      { operationId: "shot-1", outputSlot: "video-1", kind: "video", model: mediaBinding(config, config.connectionId),
        inputs: [{ kind: "artifact_revision", artifactId: prompt.artifactId, revisionId: prompt.revisionId, digest: prompt.digest }], maxCreateAttempts: 1,
        parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" } },
      { operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBinding,
        inputs: [{ kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }], maxCreateAttempts: 1,
        parameters: { voiceId: "marin", format: "mp3" } },
      renderOp([
        { kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" },
        { kind: "operation_output", producerOperationId: "speech-1", outputSlot: "speech-1" },
      ], { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24, videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" }),
    ],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 796 } };
}

const speechBindingOf = (db: AgentDatabase): ModelBinding => JSON.parse(readAdditionalMediaCurrent(db, "openai-speech")!.version.binding_json);

// 旁白/画面时长与音量证据共用的一组夹具。
interface LocalAssets { directory: string; clipA: Buffer; clipB: Buffer; narrationLong: Buffer; narrationShort: Buffer; longMs: number; shortMs: number }

async function prepareLocalAssets(): Promise<LocalAssets> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-"));
  await makeClip(path.join(directory, "a.mp4"), "red", 12, 1.2);
  await makeClip(path.join(directory, "b.mp4"), "blue", 30, 0.8);
  await makeMp3(path.join(directory, "long.mp3"), 3.2);
  await makeMp3(path.join(directory, "short.mp3"), 1.0);
  return {
    directory,
    clipA: readFileSync(path.join(directory, "a.mp4")),
    clipB: readFileSync(path.join(directory, "b.mp4")),
    narrationLong: readFileSync(path.join(directory, "long.mp3")),
    narrationShort: readFileSync(path.join(directory, "short.mp3")),
    longMs: (await probeAudioFile(path.join(directory, "long.mp3"))).durationMs,
    shortMs: (await probeAudioFile(path.join(directory, "short.mp3"))).durationMs,
  };
}

// —— T6-01/T6-02：一个 graph video+speech+render 一次确认；7.91 估算、各一次尝试、不称已结算 ——

it("T6-01/02：video+speech+render 一图一次确认完成，7.91 估算一次尝试，不称已结算", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-graph-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  const hub = new FakeRealtimeHub({ audioSeconds: 3 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "一图一次确认" }).conversation;
    const refs = await deliverTexts(runtime, conversation.id, [
      { title: "山路镜头", text: "清晨沿山路行进的固定镜头，缓慢推近。" },
      { title: "旁白文本", text: "清晨的山脊铺满阳光。" },
    ]);
    const prompt = refs[0]!, narrationText = refs[1]!;
    const spec = graphIntent(prompt, narrationText, arkConfigOf(stub.base), speechBindingOf(runtime.database));
    const { proposal } = await prepareIntent(runtime, conversation.id, spec);
    assert.match(proposal.priceDisclosure, /估算 7\.91/);
    assert.match(proposal.priceDisclosure, /使用旁白替换原声；保留完整内容，必要时停留尾帧\/补静音/);
    // K4 5 秒问题修正：待生成内容的通道上界只作守卫（T6-09），未核实时长不得虚报为“预计成片”。
    assert.doesNotMatch(proposal.priceDisclosure, /按当前输入预计成片约/);
    assert.match(proposal.priceDisclosure, /配音按 ≤1000 码点输入与 ≤120 秒音频上限保守估算/);
    assert.deepEqual(proposal.spec.operations.map(op => op.quotePerAttempt.amountMinor), [756, 35, 0]);
    assert.ok(proposal.spec.operations.every(op => op.maxCreateAttempts === 1));
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const result = await drive(runtime, admitted.run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(result.outputRevisions.length, 3, "三个操作各发布一个产出");
    assert.equal(attemptsFor(runtime.database, admitted.run.id).length, 3, "每个操作恰好一次尝试");
    assert.equal(stub.state.arkPosts.length, 1, "视频通道恰好一次创建请求");
    assert.equal(hub.sessions.length, 1, "配音通道恰好一次 Realtime 会话");
    assert.equal(hub.sessions[0]!.sent.filter(event => event.type === "response.create").length, 1, "配音恰好一次创建，不重试");
    const sessionUpdate = hub.sessions[0]!.sent.find(event => event.type === "session.update") as { session: Record<string, unknown> } | undefined;
    assert.ok(sessionUpdate, "应发送 session.update");
    assert.equal((sessionUpdate!.session as { model?: string }).model, "gpt-realtime-2.1-mini");
    const audio = sessionUpdate!.session as unknown as { audio?: { output?: { voice?: string; format?: { type?: string; rate?: number } } } };
    assert.equal(audio.audio?.output?.voice, "marin");
    assert.equal(audio.audio?.output?.format?.type, "audio/pcm");
    assert.equal(audio.audio?.output?.format?.rate, 24000);
    const sessionHead = sessionUpdate!.session as unknown as { max_output_tokens?: number; reasoning?: { effort?: string } };
    assert.equal(sessionHead.max_output_tokens, 4096);
    assert.equal(sessionHead.reasoning?.effort, "low");
    assert.equal(result.finance.priceKind, "estimate");
    assert.notEqual(result.finance.state, "settled", "估价不能被称为已结算");
    const content = await outputRevisionOf(runtime, result);
    assert.equal(content.mimeType, "video/mp4");
    const file = await outputFileOf(runtime, admitted.run.id, workRootOf(directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.width, 1280); assert.equal(facts.height, 720);
    assert.equal(Math.round(facts.frameRate ?? 0), 24);
    assert.equal(facts.hasAudio, true, "成片必须含旁白音轨");
    assert.ok(Math.abs(facts.durationMs - 5000) <= 350, `成片时长 ${facts.durationMs}ms 应≈max(5s 画面,3s 旁白)`);
    const audioFacts = await outputAudioFacts(file);
    assert.equal(audioFacts.codec, "aac"); assert.equal(audioFacts.channels, 1); assert.equal(audioFacts.sampleRate, "32000");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); closeStub(stub); }
});

// —— T6-03：旁白长→尾帧停留；旁白短→补静音；时长与波形证明未截断 ——

it("T6-03：旁白比画面长时停留尾帧，比画面短时补静音，时长与波形证明未截断", async () => {
  const assets = await prepareLocalAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "时长策略" }).conversation;
    const clipA = mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200);
    const clipB = mediaRevision(runtime, conversation.id, assets.clipB, "video/mp4", 800);
    // 旁白 3.2s > 画面 2.0s：输出=旁白时长，画面停在 B 的尾帧直到旁白结束。
    const longRun = await drive(runtime, await acceptIntent(runtime, conversation.id,
      narratedIntent([clipA, clipB], mediaRevision(runtime, conversation.id, assets.narrationLong, "audio/mpeg", assets.longMs))));
    assert.equal(longRun.state, "succeeded");
    const longFile = await outputFileOf(runtime, longRun.id, workRootOf(assets.directory));
    const longFacts = await probeVideoFile(longFile);
    assert.ok(Math.abs(longFacts.durationMs - assets.longMs) <= 200, `长旁白输出 ${longFacts.durationMs}ms 应≈${assets.longMs}ms`);
    assert.ok(isRed(await frameColor(longFile, 0.2)));
    assert.ok(isBlue(await frameColor(longFile, 1.6)));
    assert.ok(isBlue(await frameColor(longFile, Math.max(2.0, assets.longMs / 1000 - 0.2))), "画面结束后应停留最后一个画面帧");
    assert.ok(await maxVolumeDb(longFile, 2.5, Math.max(0.3, assets.longMs / 1000 - 2.7)) > -35, "旁白应播到结尾，不被截断");
    // 旁白 1.0s < 画面 2.0s：输出=画面时长，旁白结束后补静音。
    const shortRun = await drive(runtime, await acceptIntent(runtime, conversation.id,
      narratedIntent([clipA, clipB], mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs))));
    assert.equal(shortRun.state, "succeeded");
    const shortFile = await outputFileOf(runtime, shortRun.id, workRootOf(assets.directory));
    const shortFacts = await probeVideoFile(shortFile);
    assert.ok(Math.abs(shortFacts.durationMs - 2000) <= 250, `短旁白输出 ${shortFacts.durationMs}ms 应≈2000ms`);
    assert.ok(isRed(await frameColor(shortFile, 0.2)));
    assert.ok(isBlue(await frameColor(shortFile, 1.6)));
    assert.ok(await maxVolumeDb(shortFile, 0.05, 0.4) > -35, "开头应能听到旁白");
    assert.ok(await maxVolumeDb(shortFile, 1.4, 0.45) < -60, "旁白结束后应补静音到画面结束");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-04：有声输入的两种声音方案（ordered 省略 audioMode=整条去原声；narrated=旁白替换原声） ——

it("T6-04：含原声的视频 ordered 省略 audioMode 输出无声，narrated 输出旁白而非原声", async () => {
  const assets = await prepareLocalAssets();
  const withAudio = path.join(assets.directory, "with-audio.mp4");
  await makeClip(withAudio, "green", 24, 2, true);
  assert.equal((await probeVideoFile(withAudio)).hasAudio, true, "夹具本身应含声音轨");
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "原声替换" }).conversation;
    const loud = mediaRevision(runtime, conversation.id, readFileSync(withAudio), "video/mp4", 2000);
    const narration = mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs);
    // 0.1.23 起 ordered 声音方案由 audioMode 冻结：省略仍输出无声，有声输入整条去原声。
    const quietWork = stageWork(runtime, conversation.id, "去原声视频");
    const quietIntent = orderedIntent([loud]); quietIntent.workId = quietWork.workId;
    const quietRun = await drive(runtime, await acceptIntent(runtime, conversation.id, quietIntent));
    assert.equal(quietRun.state, "succeeded");
    const quietFile = await outputFileOf(runtime, quietRun.id, workRootOf(assets.directory));
    assert.equal((await probeVideoFile(quietFile)).hasAudio, false, "省略 audioMode 应输出无声成片");
    const result = await drive(runtime, await acceptIntent(runtime, conversation.id, narratedIntent([loud], narration)));
    assert.equal(result.state, "succeeded");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, true);
    assert.ok(Math.abs(facts.durationMs - 2000) <= 250);
    assert.ok(await bandVolumeDb(file, 0.05, 0.4, "bandpass=f=440:w=150") > -35, "开头是 440Hz 旁白");
    assert.ok(await bandVolumeDb(file, 0.05, 0.4, "bandpass=f=220:w=150") < -50, "220Hz 原声不与旁白叠加");
    assert.ok(await maxVolumeDb(file, 1.4, 0.45) < -60, "原声 220Hz 全程都响；此处静音证明原声被替换而非混入");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-05：旧 ordered_concat 回归 ——

it("T6-05：旧 ordered_concat 无声分支与 narrated 共存且行为不变", async () => {
  const assets = await prepareLocalAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "旧分支回归" }).conversation;
    const result = await drive(runtime, await acceptIntent(runtime, conversation.id, orderedIntent([
      mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200),
      mediaRevision(runtime, conversation.id, assets.clipB, "video/mp4", 800),
    ])));
    assert.equal(result.state, "succeeded");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, false, "旧分支输出仍无声");
    assert.ok(Math.abs(facts.durationMs - 2000) <= 250);
    assert.ok(isRed(await frameColor(file, 0.2)));
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-06：角色错误/未用 slot/同 slot 两用在 prepare 拒绝 ——

it("T6-06：旁白/画面角色错用与槽位覆盖错误都在 prepare 拒绝，不产生运行", async () => {
  const assets = await prepareLocalAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "槽位校验" }).conversation;
    const clipA = mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200);
    const clipB = mediaRevision(runtime, conversation.id, assets.clipB, "video/mp4", 800);
    const narration = mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs);
    const cases: { spec: ProductionIntent; pattern: RegExp }[] = [
      { spec: narratedIntent([clipA], clipB), pattern: /旁白槽只接受音频修订/ },
      { spec: narratedIntent([narration], narration), pattern: /视频画面槽只接受视频修订/ },
      // 未用 slot：3 个输入但 videoInputSlots 只引用 [0]，B 无人引用。
      { spec: withSlots(narratedIntent([clipA, clipB], narration), [0], 2), pattern: /槽位引用与输入数量不一致/ },
      // 同 slot 两用：schema 的 uniqueItems 在合同边界直接拒绝（走访循环守卫兜底）。
      { spec: narratedIntent([clipA, clipA], narration, { videoInputSlots: [0, 0] }), pattern: /duplicate items/ },
      // 旁白槽同时出现在 videoInputSlots：重复槽位同样被覆盖守卫拒绝。
      { spec: withSlots(narratedIntent([clipA], narration), [0, 1], 1), pattern: /槽位引用与输入数量不一致/ },
    ];
    for (const { spec, pattern } of cases) {
      await assert.rejects(runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec }),
        (error: { code?: string; message?: string }) => error.code === "INVALID_INPUT" && pattern.test(error.message ?? ""));
    }
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n, 0);
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

function withSlots(intent: ProductionIntent, videoInputSlots: number[], narrationInputSlot: number): ProductionIntent {
  const op = intent.operations[0]!;
  assert.equal(op.kind, "render");
  if (op.kind === "render" && op.parameters.assembly === "narrated_concat") {
    op.parameters = { ...op.parameters, videoInputSlots: videoInputSlots as [number, ...number[]], narrationInputSlot };
  }
  return intent;
}

// —— T6-07a：停止正在执行的有声拼接子进程 ——

it("T6-11：无任务身份的配音 unknown 在用户停止后收敛为已停止，不伪造取消或费用", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-cancel-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  // hang：会话建立、response.create 已发出后失去全部事件 → 会话超时 unknown（生成请求可能已被受理，不可伪造失败）。
  const hub = new FakeRealtimeHub({ mode: "hang", audioSeconds: 1 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 250 });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "停止未知配音" }).conversation;
    const [narration] = await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "清晨的山脊铺满阳光。" }]);
    assert.ok(narration, "旁白文本应已交付");
    const intent: ProductionIntent = { workId: null, title: "单条配音",
      inputRevisions: [{ artifactId: narration.artifactId, revisionId: narration.revisionId }],
      operations: [{ operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBindingOf(runtime.database),
        inputs: [{ kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }],
        maxCreateAttempts: 1, parameters: { voiceId: "marin", format: "mp3" } }],
      finalOutput: { operationId: "speech-1", outputSlot: "speech-1" }, maxSpend: { currency: "CNY", amountMinor: 35 } };
    const runId = await acceptIntent(runtime, conversation.id, intent);
    await runtime.worker!.pollOnce(); // submit 内联跑完 250ms 会话 → unknown
    const unknown = runtime.service.getRun("local-owner", runId);
    assert.equal(unknown.state, "unknown");
    assert.equal(attemptsFor(runtime.database, runId)[0]!.provider_task_id, null, "单次 Realtime 会话没有任务身份");
    assert.equal(unknown.finance.pendingUnknownMinor, 35);

    runtime.service.cancelRun("local-owner", runId, { commandId: cmd(), expectedRevision: unknown.revision });
    await runtime.worker!.pollOnce(); // 取消查询只读本地证据 → 稳定 unknown → run 收敛，不再停留“取消中”
    const cancelled = runtime.service.getRun("local-owner", runId);
    assert.equal(cancelled.state, "cancelled", "用户停止后 run 必须离开 cancel_requested");
    assert.equal(cancelled.issue?.code, "CANCEL_UNSUPPORTED", "如实保留“尚未确认供应商侧取消”");
    const attempt = attemptsFor(runtime.database, runId)[0]!;
    assert.equal(attempt.state, "unknown", "不伪造供应商已取消");
    assert.equal(cancelled.finance.pendingUnknownMinor, 35, "费用保持待对账，不虚构零费用");
    // R2：无查询渠道的终态通知如实说“实际费用未取得”，不把无从核对待对账说成进行中的核对。
    const notice = runtime.service.snapshot("local-owner", conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.text.includes("已停止"));
    assert.ok(notice, "终态通知已发出");
    assert.match(notice!.text, /实际费用未取得。/, "无查询渠道时不声称费用仍在核对");
    await runtime.worker!.pollOnce();
    assert.equal(runtime.service.getRun("local-owner", runId).state, "cancelled", "终态稳定");
    // 同一已有夹具补在途停止：先等 response.create，再停；execute 自身仍 active 不能阻断收敛。
    const activeRunId = await acceptIntent(runtime, conversation.id, singleSpeechIntent(narration, speechBindingOf(runtime.database)));
    const pending = runtime.worker!.pollOnce();
    for (let i = 0; i < 50 && !hub.sessions[1]?.sent.some(event => event.type === "response.create"); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(hub.sessions[1]?.sent.some(event => event.type === "response.create"));
    const active = runtime.service.getRun("local-owner", activeRunId);
    runtime.service.cancelRun("local-owner", activeRunId, { commandId: cmd(), expectedRevision: active.revision });
    await runtime.worker!.pollOnce();
    await pending;
    const stopped = runtime.service.getRun("local-owner", activeRunId);
    assert.equal(stopped.state, "cancelled", "已退出的本地等待允许本次 execute 收敛");
    assert.equal(stopped.finance.pendingUnknownMinor, 35);
    assert.equal(hub.sessions.length, 2, "两个正式开始各仅一个会话");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); closeStub(stub); }
});

it("T6-12：服务 close 通知在途配音等待及时退出，事实落盘且不新增用户取消；重启只核对不二次 create", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-close-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  // hang + 6 秒会话截止：close 必须在截止前结束本地等待，而不是把等待拖满。
  const hub = new FakeRealtimeHub({ mode: "hang", audioSeconds: 1 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 6000 });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "关闭未决配音" }).conversation;
    const [narration] = await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "清晨的山脊铺满阳光。" }]);
    assert.ok(narration, "旁白文本应已交付");
    const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
    const intent: ProductionIntent = { workId: null, title: "单条配音",
      inputRevisions: [{ artifactId: narration.artifactId, revisionId: narration.revisionId }],
      operations: [{ operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBindingOf(runtime.database),
        inputs: [{ kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }],
        maxCreateAttempts: 1, parameters: { voiceId: "marin", format: "mp3" } }],
      finalOutput: { operationId: "speech-1", outputSlot: "speech-1" }, maxSpend: { currency: "CNY", amountMinor: 35 } };
    const runId = await acceptIntent(runtime, conversation.id, intent);
    const poll = runtime.worker!.pollOnce(); // 不等待：submit 在途
    await sleep(250); // 会话已建立、response.create 已发出
    const closeStart = Date.now();
    await runtime.worker!.close(); // 先通知在途等待退出，再等事实落盘
    await poll;
    assert.ok(Date.now() - closeStart < 4_000, "close 应及时结束在途等待，不等会话截止");
    const run = runtime.service.getRun("local-owner", runId);
    assert.notEqual(run.state, "cancel_requested", "服务关闭不新增用户取消动作");
    assert.equal(run.state, "unknown");
    const attempt = attemptsFor(runtime.database, runId)[0]!;
    assert.equal(attempt.state, "unknown", "已发出的生成结果未确认，如实保存事实");
    assert.equal(attempt.provider_task_id, null);
    await runtime.close();
    // 重启同一数据目录：先经真实路由读取本地证据（无收据 → 端口稳定 unknown 是新事实），
    // 之后周期处理不再产生新观测；不第二次 create，费用不清零。
    const reopened = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 6000 });
    try {
      await reopened.worker!.pollOnce(); // 恢复读取：真实端口查询本地收据，无果 → 记录端口稳定 unknown
      const observations = reopened.database.prepare("SELECT COUNT(*) AS n FROM ledger_observations WHERE attempt_id=?").get(attempt.id) as { n: number };
      assert.ok(observations.n >= 2, "恢复查询应产生可核对的新观测事实，而不是空转跳过");
      await reopened.worker!.pollOnce();
      const after = reopened.database.prepare("SELECT COUNT(*) AS n FROM ledger_observations WHERE attempt_id=?").get(attempt.id) as { n: number };
      assert.equal(after.n, observations.n, "同一稳定 unknown 不再产生新观测");
      assert.equal(attemptsFor(reopened.database, runId).length, 1, "重启不第二次 create");
      assert.equal(reopened.service.getRun("local-owner", runId).finance.pendingUnknownMinor, 35, "费用不清零");
    } finally { await reopened.close(); }
  } finally { closeStub(stub); await rm(directory, { recursive: true, force: true }); }
});

// —— T6-13/T6-14（M0 R1）：已落盘的完整配音必须由 worker 经真实路由消费 ——
// 无 taskId 只说明没有远端查询渠道，不等于没有本地结果：端口的恢复查询会读取完成收据/文件。

interface SpeechRef { artifactId: string; revisionId: string; digest: string }

function singleSpeechIntent(narration: SpeechRef, binding: ModelBinding): ProductionIntent {
  return { workId: null, title: "单条配音",
    inputRevisions: [{ artifactId: narration.artifactId, revisionId: narration.revisionId }],
    operations: [{ operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: binding,
      inputs: [{ kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }],
      maxCreateAttempts: 1, parameters: { voiceId: "marin", format: "mp3" } }],
    finalOutput: { operationId: "speech-1", outputSlot: "speech-1" }, maxSpend: { currency: "CNY", amountMinor: 35 } };
}

async function driveSpeechToUnknown(runtime: AgentRuntime, conversationId: string): Promise<{ runId: string; attemptId: string }> {
  const [narration] = await deliverTexts(runtime, conversationId, [{ title: "旁白文本", text: "清晨的山脊铺满阳光。" }]);
  assert.ok(narration, "旁白文本应已交付");
  const runId = await acceptIntent(runtime, conversationId, singleSpeechIntent(narration, speechBindingOf(runtime.database)));
  await runtime.worker!.pollOnce(); // submit 内联跑完 250ms 会话 → unknown（观测已应用、无任务身份）
  const unknown = runtime.service.getRun("local-owner", runId);
  assert.equal(unknown.state, "unknown");
  const attempt = attemptsFor(runtime.database, runId)[0]!;
  assert.equal(attempt.provider_task_id, null, "单次 Realtime 会话没有任务身份");
  return { runId, attemptId: attempt.id };
}

it("T6-13：unknown 观测之后落盘的完整配音由 worker 消费，不因无任务身份跳过（R1）", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-r1-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  const hub = new FakeRealtimeHub({ mode: "hang", audioSeconds: 1 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 250 });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "恢复完整配音" }).conversation;
    const { runId, attemptId } = await driveSpeechToUnknown(runtime, conversation.id);
    // 完成文件在 unknown 观测之后出现在确定性位置（崩溃窗口/迟到落盘的外部事实）。
    const attemptDir = path.join(directory, "media-work", attemptId);
    mkdirSync(attemptDir, { recursive: true });
    await makeMp3(path.join(attemptDir, "speech.mp3"), 1, 24000); // 端口按冻结规格 24kHz 单声道重验成品
    const beforeStop = runtime.service.getRun("local-owner", runId);
    runtime.service.cancelRun("local-owner", runId, { commandId: cmd(), expectedRevision: beforeStop.revision });
    await runtime.worker!.pollOnce();
    const after = runtime.service.getRun("local-owner", runId);
    assert.equal(after.state, "succeeded", "F01：停止前已有完整文件，先消费事实再收敛");
    assert.equal(after.issue, null);
    assert.equal(after.finance.state, "pending_reconciliation", "完成不代表取得实际账单");
    assert.equal(attemptsFor(runtime.database, runId).length, 1, "不因补收据再 create");
    assert.equal(after.outputRevisions.length, 1);
    await runtime.worker!.pollOnce();
    assert.equal(runtime.service.getRun("local-owner", runId).outputRevisions.length, 1, "重复轮询不重复发布");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); closeStub(stub); }
});

it("T6-14：重启停止一次消费多条已有完整收据，保留部分结果且不启动后续操作", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-r1b-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  const hub = new FakeRealtimeHub({ mode: "hang", audioSeconds: 1 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 250 });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "重启恢复配音" }).conversation;
    const [narration] = await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "两段旁白的完整结果都应保留。" }]);
    const intent = singleSpeechIntent(narration!, speechBindingOf(runtime.database));
    const first = intent.operations[0]!;
    intent.operations.push({ ...first, operationId: "speech-2", outputSlot: "speech-2" },
      { ...first, operationId: "speech-3", outputSlot: "speech-3" });
    intent.finalOutput = { operationId: "speech-3", outputSlot: "speech-3" };
    intent.maxSpend.amountMinor = 105;
    const runId = await acceptIntent(runtime, conversation.id, intent);
    await runtime.worker!.pollOnce();
    // 隔离故障夹具：两条提交后观测遗失，后续第三条尚未创建；不修改用户库或伪造业务认可。
    runtime.database.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES(?,?,?,1,?,'observed','unknown',35)")
      .run("att-g1-second", runId, "speech-2", "request-g1-second");
    const port = new OpenAISpeechPort(runtime.database, runtime.production!.blobs, staticClock, {
      resolve: binding => resolveOpenAISpeechBinding(runtime.database, binding), workRoot: path.join(directory, "media-work"), transportFactory: hub.factory,
    });
    for (const current of attemptsFor(runtime.database, runId)) {
      const attemptDir = path.join(directory, "media-work", current.id);
      mkdirSync(attemptDir, { recursive: true });
      await makeMp3(path.join(attemptDir, "speech.mp3"), 1, 24000);
      const direct = await port.query({ kind: "provider", runId, operationId: current.operation_id, accountBinding: speechBindingOf(runtime.database),
        attemptId: current.id, providerTaskId: null, requestIdentity: current.request_identity });
      assert.equal(direct.state, "succeeded", "每条真实端口收据均已齐全");
    }
    const beforeStop = runtime.service.getRun("local-owner", runId);
    runtime.service.cancelRun("local-owner", runId, { commandId: cmd(), expectedRevision: beforeStop.revision });
    await runtime.close();
    // 重启同一数据目录：worker 经自身网关与冻结绑定路由消费同一收据。
    const reopened = await buildGraphRuntime(directory, stub.base, hub, undefined, { sessionTimeoutMs: 250 });
    try {
      await reopened.worker!.pollOnce();
      const after = reopened.service.getRun("local-owner", runId);
      assert.equal(after.state, "cancelled", "第三条未开始，整条run如实停止");
      assert.equal(after.outputRevisions.length, 2, "F01：同轮消费全部已有完整结果，不能在首条observe时提前终态");
      assert.equal(attemptsFor(reopened.database, runId).length, 2, "不二次 create，也不启动第三条");
      assert.equal(after.issue, null);
      assert.equal(after.finance.state, "pending_reconciliation");
      await reopened.worker!.pollOnce();
      assert.equal(reopened.service.getRun("local-owner", runId).outputRevisions.length, 2);
      assert.equal(hub.sessions.length, 1, "恢复与停止不再创建供应商会话");
    } finally { await reopened.close(); }
  } finally { closeStub(stub); await rm(directory, { recursive: true, force: true }); }
});

it("T6-07a：点击停止能终止正在执行的有声拼接子进程", async () => {
  const assets = await prepareLocalAssets();
  const startedFile = path.join(assets.directory, "started");
  const wrapper = path.join(assets.directory, "slow-ffmpeg.cjs");
  writeFileSync(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'started');\nsetTimeout(() => process.exit(1), 3000);\n`);
  chmodSync(wrapper, 0o755);
  const runtime = await buildLocalRuntime(assets.directory, (blobs, db) =>
    new LocalRenderPort(db, blobs, staticClock, { workRoot: path.join(assets.directory, "media-work"), ffmpegPath: wrapper }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "停止有声拼接" }).conversation;
    const runId = await acceptIntent(runtime, conversation.id, narratedIntent(
      [mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200)],
      mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs)));
    const pending = runtime.worker!.pollOnce();
    for (let i = 0; i < 100 && !existsSync(startedFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(startedFile), true, "子进程已启动后才发停止请求");
    const current = runtime.service.getRun("local-owner", runId);
    runtime.service.cancelRun("local-owner", runId, { commandId: cmd(), expectedRevision: current.revision });
    await runtime.worker!.pollOnce();
    await pending;
    const attempt = attemptsFor(runtime.database, runId).at(-1)!;
    const receipt = runtime.database.prepare("SELECT exit_kind FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id) as { exit_kind: string };
    assert.equal(receipt.exit_kind, "terminated");
    const result = runtime.service.getRun("local-owner", runId);
    assert.equal(result.state, "cancelled");
    assert.equal(result.outputRevisions.length, 0);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-07b：文件完成而业务未提交的窗口——重启后只发布一次 ——

it("T6-07b：成片落盘而收据未写的窗口，重启恢复恰好发布一次", async () => {
  const assets = await prepareLocalAssets();
  const blackHole = (): MediaExecutionPort => ({
    submit: async input => ({ observationId: "obs-t6-blackhole", attemptId: input.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程在拼接后崩溃。", billing: null }),
    query: async query => ({ observationId: "obs-t6-blackhole", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程未恢复。", billing: null }),
    cancel: async query => ({ observationId: "obs-t6-blackhole", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程未恢复。", billing: null }),
  });
  const inputs = (runtime: AgentRuntime, conversationId: string) => [
    mediaRevision(runtime, conversationId, assets.clipA, "video/mp4", 1200),
    mediaRevision(runtime, conversationId, assets.narrationShort, "audio/mpeg", assets.shortMs),
  ];
  const first = await buildLocalRuntime(assets.directory);
  let second: AgentRuntime | null = null, third: AgentRuntime | null = null;
  try {
    // 先用真实端口跑通一次，得到一份与窗口运行同输入的合规成品。
    const goodConversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "成品来源" }).conversation;
    const goodRefs = inputs(first, goodConversation.id);
    const goodRunId = await acceptIntent(first, goodConversation.id, narratedIntent([goodRefs[0]!], goodRefs[1]!));
    const goodRun = await drive(first, goodRunId);
    assert.equal(goodRun.state, "succeeded");
    const goodFile = await outputFileOf(first, goodRunId, workRootOf(assets.directory));
    await first.close();
    // 窗口运行：黑洞端口把尝试停在 unknown。
    second = await buildLocalRuntime(assets.directory, blackHole);
    const windowConversation = second.service.createConversation("local-owner", { commandId: cmd(), title: "窗口验证" }).conversation;
    const windowRefs = inputs(second, windowConversation.id);
    const windowRunId = await acceptIntent(second, windowConversation.id, narratedIntent([windowRefs[0]!], windowRefs[1]!));
    await second.worker!.pollOnce();
    const attempt = attemptsFor(second.database, windowRunId).at(-1)!;
    assert.equal(attempt.state, "unknown");
    await second.close();
    // 模拟“文件已完整落盘但业务收据未写”。
    const attemptDir = path.join(assets.directory, "media-work", attempt.id);
    await cp(goodFile, path.join(attemptDir, "output.mp4"));
    // 重启：真实端口按确定性位置恢复，只发布一次。
    third = await buildLocalRuntime(assets.directory);
    for (let i = 0; i < 3; i++) await third.worker!.pollOnce();
    const recovered = third.service.getRun("local-owner", windowRunId);
    assert.equal(recovered.state, "succeeded", "确定性位置的完整成品应被采纳");
    assert.equal(recovered.outputRevisions.length, 1);
    await third.worker!.pollOnce(); await third.worker!.pollOnce();
    assert.equal(third.service.getRun("local-owner", windowRunId).outputRevisions.length, 1, "后续轮询不得重复发布");
  } finally {
    if (first.database.open) await first.close();
    if (second?.database.open) await second.close();
    if (third?.database.open) await third.close();
    await rm(assets.directory, { recursive: true, force: true });
  }
});

// —— T6-08：后台制作时另聊话题，不抢焦点；成片有声 ——

it("T6-08：有声拼接在后台执行时另聊话题不受影响，成片含声可读", async () => {
  const assets = await prepareLocalAssets();
  const startedFile = path.join(assets.directory, "started");
  const wrapper = path.join(assets.directory, "slow-ffmpeg.sh");
  writeFileSync(wrapper, `#!/bin/sh\nprintf 'started\\n' > ${JSON.stringify(startedFile)}\nsleep 5\nexec ffmpeg "$@"\n`);
  chmodSync(wrapper, 0o755);
  const runtime = await buildLocalRuntime(assets.directory, (blobs, db) =>
    new LocalRenderPort(db, blobs, staticClock, { workRoot: path.join(assets.directory, "media-work"), ffmpegPath: wrapper }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "后台与闲聊" }).conversation;
    const runId = await acceptIntent(runtime, conversation.id, narratedIntent(
      [mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200), mediaRevision(runtime, conversation.id, assets.clipB, "video/mp4", 800)],
      mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs)));
    const pending = runtime.worker!.pollOnce();
    for (let i = 0; i < 100 && !existsSync(startedFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
    // 制作进行中另聊话题：聊天照常完成，不打断也不被制作阻塞。
    runtime.host.faux?.setResponses([fauxAssistantMessage("天气不错，适合出行。")]);
    await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "顺便聊聊天气", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
    await waitForRequest(runtime, conversation.id);
    assert.match(JSON.stringify(runtime.service.snapshot("local-owner", conversation.id).messages.items), /天气不错，适合出行。/, "闲聊请求照常完成并收到回复");
    assert.ok(["running", "unknown"].includes(runtime.service.getRun("local-owner", runId).state), "闲聊期间制作仍在后台执行");
    await pending;
    const result = await drive(runtime, runId, 2);
    assert.equal(result.state, "succeeded");
    const content = await outputRevisionOf(runtime, result);
    assert.equal(content.mimeType, "video/mp4");
    const blob = runtime.database.prepare("SELECT mime_type FROM production_blobs WHERE id=?").get(content.blobId) as { mime_type: string };
    assert.equal(blob.mime_type, "video/mp4", "成片 blob 可按归属读取下载");
    const facts = await probeVideoFile(await outputFileOf(runtime, runId, workRootOf(assets.directory)));
    assert.equal(facts.hasAudio, true, "成片必须含旁白音轨");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-09：70s+70s 在旁白收费前拒绝，重复引用照次数计时 ——

it("T6-09：已知 70s+70s 组合在旁白付费前拒绝，重复引用逐次计时", async () => {
  const assets = await prepareLocalAssets();
  const longClip = path.join(assets.directory, "long.mp4");
  await makeClip(longClip, "green", 6, 70);
  const runtime = await buildGraphRuntime(assets.directory, "http://127.0.0.1:1", new FakeRealtimeHub()); // 地址不重要：本轮不应有任何付费提交
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "时长上界" }).conversation;
    const narrationText = (await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "七十秒的风景。" }]))[0]!;
    const clip70 = mediaRevision(runtime, conversation.id, readFileSync(longClip), "video/mp4", 70_000);
    const speechBinding = speechBindingOf(runtime.database);
    const over: ProductionIntent = {
      workId: null, title: "超限组合",
      inputRevisions: [clip70, narrationText].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
      operations: [
        { operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBinding,
          inputs: [{ kind: "artifact_revision", artifactId: narrationText.artifactId, revisionId: narrationText.revisionId, digest: narrationText.digest }], maxCreateAttempts: 1,
          parameters: { voiceId: "marin", format: "mp3" } },
        renderOp([
          { kind: "artifact_revision", artifactId: clip70.artifactId, revisionId: clip70.revisionId, digest: clip70.digest },
          { kind: "artifact_revision", artifactId: clip70.artifactId, revisionId: clip70.revisionId, digest: clip70.digest },
          { kind: "operation_output", producerOperationId: "speech-1", outputSlot: "speech-1" },
        ], { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24, videoInputSlots: [0, 1], narrationInputSlot: 2, durationPolicy: "preserve_all" }),
      ],
      finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 796 },
    };
    await assert.rejects(runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: over }),
      (error: { code?: string; message?: string }) => error.code === "INVALID_INPUT" && /140s/.test(error.message ?? "") && /120s/.test(error.message ?? ""));
    // 同一条 70s 素材只引用一次时在界限内（70+待生成旁白上界 120s 恰为 120s），可正常准备。
    const within = structuredClone(over);
    within.operations[1]!.inputs = [within.operations[1]!.inputs[0]!, within.operations[1]!.inputs[2]!];
    if (within.operations[1]!.kind === "render" && within.operations[1]!.parameters.assembly === "narrated_concat") {
      within.operations[1]!.parameters = { ...within.operations[1]!.parameters, videoInputSlots: [0], narrationInputSlot: 1 };
    }
    const { proposal } = await prepareIntent(runtime, conversation.id, within);
    assert.equal(proposal.state, "ready", "重复引用按次数计时：一次引用不超限");
    // 旁白还是待生成文本：画面已核实也不披露“预计成片”（成片时长受旁白实际生成影响）。
    assert.doesNotMatch(proposal.priceDisclosure, /按当前输入预计成片约/);
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
    // 已核实的素材组合（真实 70s 画面 + 真实旁白 mp3）才如实披露预计成片时长。
    const narrationAudio = mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs);
    const verifiedSpec: ProductionIntent = {
      workId: null, title: "已核实时长组合",
      inputRevisions: [clip70, narrationAudio].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
      operations: [renderOp([
        { kind: "artifact_revision", artifactId: clip70.artifactId, revisionId: clip70.revisionId, digest: clip70.digest },
        { kind: "artifact_revision", artifactId: narrationAudio.artifactId, revisionId: narrationAudio.revisionId, digest: narrationAudio.digest },
      ], { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24, videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" })],
      finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 796 },
    };
    const { proposal: verifiedProposal } = await prepareIntent(runtime, conversation.id, verifiedSpec);
    assert.match(verifiedProposal.priceDisclosure, /按当前输入预计成片约 70\.0 秒（.*不做裁剪）/);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// 单个生成片段允许帧级时长容差；重复使用后，真实总时长仍须满足 120s 成片限制。
it("T6-09b：生成后实际时长超过上界时拒绝有声成片，不裁剪", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-actual-limit-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 121 / 24);
  const stub = await startGraphStub(readFileSync(video));
  const hub = new FakeRealtimeHub({ audioSeconds: 1 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "实际时长限制" }).conversation;
    const refs = await deliverTexts(runtime, conversation.id, [{ title: "镜头", text: "山路。" }, { title: "旁白", text: "清晨。" }]);
    const spec = graphIntent(refs[0]!, refs[1]!, arkConfigOf(stub.base), speechBindingOf(runtime.database));
    const concat = renderOp([{ kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" },
      ...Array.from({ length: 23 }, () => ({ kind: "operation_output" as const, producerOperationId: "shot-1", outputSlot: "video-1" }))],
      { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 });
    concat.operationId = "silent-concat"; concat.outputSlot = "silent";
    const final = spec.operations[2]!;
    final.inputs[0] = { kind: "operation_output", producerOperationId: "silent-concat", outputSlot: "silent" };
    spec.operations.splice(2, 0, concat);
    const { proposal } = await prepareIntent(runtime, conversation.id, spec);
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const result = await drive(runtime, admitted.run.id);
    assert.equal(result.state, "failed");
    assert.match(result.issue?.message ?? "", /120s/);
    assert.equal(result.outputRevisions.length, 3, "保留已完成的原片、旁白、无声拼接；不发布超限有声成片");
    assert.equal(stub.state.arkPosts.length, 1); assert.equal(hub.sessions.length, 1);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); closeStub(stub); }
});

// —— T13/F07：timed_narrated_concat 验收夹具（S3-04 固定顺序，真实 FFmpeg） ——
// 源片逐秒换色构成可辨认的源时间标记：A 截 1–7s、B 截 2–8s、图片停 8s，共 20s；
// A 含 1300Hz 原声（成片不得残留），旁白 440Hz（短于 20s 补尾静音）。
// 仅辨认 A/B 不足以证明非零起点裁切，输出帧必须对应源片的正确秒位。

type TimedParameters = Extract<RenderParameters, { assembly: "timed_narrated_concat" }>;
type TimedFootage = { kind: "video" | "image"; ref: Ref; startMs?: number; durationMs: number };

const TIMED_COLORS = {
  a: ["white", "red", "green", "blue", "yellow", "magenta", "cyan", "gray"],
  b: ["black", "silver", "maroon", "olive", "0x0080FF", "0x8000FF", "purple", "teal"],
} as const;
const RGB: Record<string, [number, number, number]> = {
  white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], magenta: [255, 0, 255], cyan: [0, 255, 255], gray: [128, 128, 128],
  black: [0, 0, 0], silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0],
  "0x0080FF": [0, 128, 255], "0x8000FF": [128, 0, 255], purple: [128, 0, 128], teal: [0, 128, 128],
  chocolate: [210, 105, 30],
};
const near = (rgb: [number, number, number], expect: [number, number, number]) =>
  Math.abs(rgb[0]! - expect[0]) < 30 && Math.abs(rgb[1]! - expect[1]) < 30 && Math.abs(rgb[2]! - expect[2]) < 30;

async function makeTimedClip(file: string, colors: readonly string[], toneHz?: number): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  colors.forEach(color => args.push("-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=24:d=1`));
  if (toneHz) args.push("-f", "lavfi", "-i", `sine=frequency=${toneHz}:duration=${colors.length}`);
  args.push("-filter_complex", `${colors.map((_, index) => `[${index}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`);
  if (toneHz) args.push("-map", "[v]", "-map", `${colors.length}:a`, "-c:a", "aac", "-shortest");
  else args.push("-map", "[v]");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", file);
  await run("ffmpeg", args);
}

async function makeTimedImage(file: string, color: string): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:d=1`, "-frames:v", "1", file]);
}

// 指定音频滤波后的窗口最大音量（dB）：区分 440Hz 旁白与 1300Hz 原声是否进入成片。
async function bandVolumeDb(file: string, fromSeconds: number, seconds: number, filter: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(fromSeconds), "-t", String(seconds), "-i", file,
    "-map", "0:a:0", "-af", `${filter},volumedetect`, "-f", "null", "-"], { timeout: 60_000 });
  const match = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, "volumedetect 应输出 max_volume");
  return Number(match[1]);
}

interface TimedAssets { directory: string; clipA: Buffer; clipB: Buffer; image: Buffer }

async function prepareTimedAssets(): Promise<TimedAssets> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t13-"));
  const clipA = path.join(directory, "timed-a.mp4"), clipB = path.join(directory, "timed-b.mp4"), image = path.join(directory, "timed-i.png");
  await makeTimedClip(clipA, TIMED_COLORS.a, 1300);
  await makeTimedClip(clipB, TIMED_COLORS.b);
  await makeTimedImage(image, "chocolate");
  return { directory, clipA: readFileSync(clipA), clipB: readFileSync(clipB), image: readFileSync(image) };
}

// A 截 1–7s、B 截 2–8s、图片 8s：输出 0–6s=A[1..7]、6–12s=B[2..8]、12–20s=图片。
const timedFootage = (assets: TimedAssets, runtime: AgentRuntime, conversationId: string): TimedFootage[] => [
  { kind: "video", ref: mediaRevision(runtime, conversationId, assets.clipA, "video/mp4", 8000), startMs: 1000, durationMs: 6000 },
  { kind: "video", ref: mediaRevision(runtime, conversationId, assets.clipB, "video/mp4", 8000), startMs: 2000, durationMs: 6000 },
  { kind: "image", ref: mediaRevision(runtime, conversationId, assets.image, "image/png", 0), durationMs: 8000 },
];

function timedRenderOp(footage: TimedFootage[], narrationInput: ProductionIntent["operations"][number]["inputs"][number]): ProductionIntent["operations"][number] {
  if (!footage.length) throw new Error("timed 至少一个画面片段");
  // 槽位按片段顺序 0..n-1，旁白槽在最后。
  const segments = footage.map((item, index) => item.kind === "video"
    ? { kind: "video" as const, inputSlot: index, startMs: item.startMs!, durationMs: item.durationMs }
    : { kind: "image" as const, inputSlot: index, durationMs: item.durationMs });
  const parameters = { assembly: "timed_narrated_concat" as const, format: "mp4" as const, width: 1280 as const, height: 720 as const, fps: 24 as const,
    segments: segments as TimedParameters["segments"], narrationInputSlot: footage.length };
  return renderOp([
    ...footage.map(item => ({ kind: "artifact_revision" as const, artifactId: item.ref.artifactId, revisionId: item.ref.revisionId, digest: item.ref.digest })),
    narrationInput,
  ] as unknown as ProductionIntent["operations"][number]["inputs"], parameters);
}

// 已有真实旁白修订的 timed 图：只有 render 一个操作。
function timedIntent(footage: TimedFootage[], narration: Ref): ProductionIntent {
  const refs = [...footage.map(item => item.ref), narration];
  return { workId: null, title: "有限剪辑成片",
    inputRevisions: refs.map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [timedRenderOp(footage, { kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest })],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

// 待生成配音的 timed 图：speech+render 两个操作（免费素材，配音付费）。
function timedSpeechIntent(footage: TimedFootage[], narrationText: Ref, speechBinding: ModelBinding): ProductionIntent {
  return { workId: null, title: "待配音有限剪辑",
    inputRevisions: [...footage.map(item => item.ref), narrationText].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [
      { operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBinding,
        inputs: [{ kind: "artifact_revision", artifactId: narrationText.artifactId, revisionId: narrationText.revisionId, digest: narrationText.digest }], maxCreateAttempts: 1,
        parameters: { voiceId: "marin", format: "mp3" } },
      timedRenderOp(footage, { kind: "operation_output", producerOperationId: "speech-1", outputSlot: "speech-1" }),
    ],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 40 } };
}

// T13-a：已有 17s 旁白 + 真实 FFmpeg 成 20s 片；非零起点裁切、图片静帧、尾静音、原声替换逐项验证。
it("T13-a/F07a：已有 17s 旁白按冻结片段裁切成 20s，源时间标记/图片/尾静音/原声替换全部成立", async () => {
  const assets = await prepareTimedAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "有限剪辑" }).conversation;
    const narration = path.join(assets.directory, "narration.mp3");
    await makeMp3(narration, 17);
    const narrationMs = (await probeAudioFile(narration)).durationMs;
    const footage = timedFootage(assets, runtime, conversation.id);
    const run = await drive(runtime, await acceptIntent(runtime, conversation.id, timedIntent(footage, mediaRevision(runtime, conversation.id, readFileSync(narration), "audio/mpeg", narrationMs))));
    assert.equal(run.state, "succeeded");
    const file = await outputFileOf(runtime, run.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.width, 1280); assert.equal(facts.height, 720); assert.equal(Math.round(facts.frameRate ?? 0), 24);
    assert.ok(facts.hasAudio, "成片含旁白音轨");
    assert.ok(Math.abs(facts.durationMs - 20_000) <= 250, `成片时长 ${facts.durationMs}ms 应≈20000ms（片段之和）`);
    // 非零起点裁切：输出秒位必须对应源片正确秒位，而不是从 0 起的错位画面。
    assert.ok(near(await frameColor(file, 0.5), RGB.red!), "0.5s 应为 A 源第 2 秒（red），证明从 1s 起裁");
    assert.ok(!near(await frameColor(file, 3.0), RGB.blue!), "3.0s 不得是 A 源第 4 秒（blue）的零起点错位");
    assert.ok(near(await frameColor(file, 3.0), RGB.yellow!), "3.0s 应为 A 源第 5 秒（yellow）＝1s 起点 + 3s");
    assert.ok(near(await frameColor(file, 6.2), RGB.maroon!), "6.2s 应为 B 源第 3 秒（maroon）＝2s 起点 + 0.2s");
    assert.ok(near(await frameColor(file, 9.0), RGB["0x8000FF"]!), "9.0s 应为 B 源第 6 秒（0x8000FF）＝2s 起点 + 7s");
    assert.ok(near(await frameColor(file, 16.5), RGB.chocolate!), "16.5s 应为指定图片（chocolate）静帧");
    // 原声 1300Hz 不得残留；440Hz 旁白保留；尾部补静音。
    // 阈值依据实测：纯 440Hz 旁白经 mp3→aac 后在 1300Hz 频带仍留约 -31dB 编码噪声，
    // 而满幅 1300Hz 原声若泄漏会 ≥ -10dB；-20dB 居中可判别两者。
    assert.ok(await bandVolumeDb(file, 0, 20, "bandpass=f=1300:w=3") < -20, "A 源 1300Hz 原声不得进入成片");
    assert.ok(await bandVolumeDb(file, 0.5, 1.0, "bandpass=f=440:w=3") > -35, "440Hz 旁白应保留");
    assert.ok(await maxVolumeDb(file, 17.6, 2.0) < -60, "旁白结束后应补静音到 20s");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// T13-b（F07 主线）：待生成旁白不能拿配音通道 120s 上界当实际时长提前拒绝；
// 真实目录上限 + Realtime 替身返回 17s，一次开始后成片，配音恰好一次创建、无图片/视频供应商调用。
it("T13-b/F07：待生成旁白的 20s timed 提案可准备；替身返回 17s 后一次成片，只付一次配音", async () => {
  const assets = await prepareTimedAssets();
  const stub = await startGraphStub(assets.clipA);
  const hub = new FakeRealtimeHub({ audioSeconds: 17 });
  const runtime = await buildGraphRuntime(assets.directory, stub.base, hub);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "待生成配音" }).conversation;
    const narrationText = (await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "二十秒的城市漫步，从天桥开始。" }]))[0]!;
    const footage = timedFootage(assets, runtime, conversation.id);
    const intent = timedSpeechIntent(footage, narrationText, speechBindingOf(runtime.database));
    const { proposal } = await prepareIntent(runtime, conversation.id, intent);
    // 待生成旁白先披露固定长短策略；成片时长只由冻结片段决定，可如实披露 20s。
    assert.match(proposal.priceDisclosure, /按方案裁切片段并用旁白替换原声；旁白不足补静音，超过画面总长则如实失败，不加速、不剪词、不延长画面/);
    assert.match(proposal.priceDisclosure, /按当前输入预计成片约 20\.0 秒（时长取冻结片段之和，按片段顺序裁切）/);
    assert.equal(proposal.spec.operations.map(op => op.kind).join(","), "speech,render", "免费素材只允许配音付费：操作只有 speech+render");
    assert.equal(hub.sessions.length, 0, "未明确开始前零生成调用");
    assert.equal(stub.state.arkPosts.length, 0);
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const result = await drive(runtime, admitted.run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(hub.sessions.length, 1, "配音恰好一次创建，不重试");
    assert.equal(hub.sessions[0]!.sent.filter(event => event.type === "response.create").length, 1);
    assert.equal(stub.state.arkPosts.length, 0, "不得有任何图片/视频供应商创建");
    assert.equal(attemptsFor(runtime.database, admitted.run.id).length, 2, "speech+render 各一次尝试");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.ok(Math.abs(facts.durationMs - 20_000) <= 250, `成片时长 ${facts.durationMs}ms 应≈20000ms`);
    assert.ok(await maxVolumeDb(file, 17.6, 2.0) < -60, "17s 旁白后补尾静音到 20s");
    assert.ok(await bandVolumeDb(file, 0.5, 1.0, "bandpass=f=440:w=3") > -35, "旁白进入成片");
    // 同 T13-a 的实测依据：-20dB 区分编码噪声（约 -31dB）与泄漏原声（≥ -10dB）。
    assert.ok(await bandVolumeDb(file, 0, 20, "bandpass=f=1300:w=3") < -20, "素材原声不残留");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); closeStub(stub); }
});

it("R5 连续旅程：Pi 采用聊天原文、暂停、原批次素材、交付方案、HTTP 一次制作、真实 FFmpeg、同文件定稿", async () => {
  const assets = await prepareTimedAssets();
  const stub = await startGraphStub(assets.clipA);
  const hub = new FakeRealtimeHub({ audioSeconds: 17 });
  let searches = 0;
  const pexelsFetch: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.includes("/videos/search")) {
      searches++;
      return Response.json({ videos: [101, 202, 303].map(id => ({ id, width: 1280, height: 720, duration: 8,
        url: `https://www.pexels.com/video/${id}/`, image: `https://images.pexels.com/videos/${id}.jpg`,
        user: { name: `作者 ${id}`, url: `https://www.pexels.com/@${id}/` },
        video_files: [{ id, file_type: "video/mp4", quality: "hd", width: 1280, height: 720, link: `https://videos.pexels.com/${id}.mp4` }],
      })) });
    }
    if (url.pathname.includes("/v1/search")) {
      searches++;
      return Response.json({ photos: [{ id: 404, width: 1280, height: 720, alt: "夜景静帧",
        url: "https://www.pexels.com/photo/404/", photographer: "作者 404", photographer_url: "https://www.pexels.com/@404/",
        src: { original: "https://images.pexels.com/photos/404/original.png" } }] });
    }
    const bytes = url.host === "images.pexels.com" ? assets.image : url.pathname.includes("101") ? assets.clipA : assets.clipB;
    return new Response(new Uint8Array(bytes), { headers: { "content-type": url.host === "images.pexels.com" ? "image/png" : "video/mp4" } });
  };
  const runtime = await buildGraphRuntime(assets.directory, stub.base, hub, { stockFetch: pexelsFetch });
  const origin = "http://127.0.0.1:4415";
  const app = buildFrameApp({ agent: { service: runtime.service, resolveOwner: () => "local-owner", uiOrigin: origin } });
  const headers = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
  try {
    savePexelsServiceSettings(runtime.database, staticClock, "local-owner", { commandId: cmd(), expectedRevision: 0, enabled: true, apiKey: "local-fixture-only" });
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "完整创作旅程" }).conversation;
    const snapshot = () => runtime.service.snapshot("local-owner", conversation.id);
    const send = async (text: string, stageConfirmation?: unknown) => {
      const response = await app.inject({ method: "POST", url: `/api/agent/v1/conversations/${conversation.id}/messages`, headers,
        payload: { commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
          ...(stageConfirmation ? { stageConfirmation } : {}) } });
      assert.equal(response.statusCode, 202, response.body);
      await waitForRequest(runtime, conversation.id);
      assert.equal(snapshot().activeRequestId, null);
      assert.ok(!snapshot().messages.items.some(message => message.state === "failed"), JSON.stringify(snapshot().messages.items.filter(message => message.state === "failed" || message.role === "system_notice")));
    };
    const lastTool = <T,>(context: TranscriptContext): T => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
      assert.equal(result.isError, false, text);
      return JSON.parse(text.slice(text.indexOf("{"))) as T;
    };
    const script = "从城市天桥开始，走进树荫，最后留在夜色里。";
    runtime.host.faux!.setResponses([fauxAssistantMessage(script)]);
    await send("先给我一个视频 Prompt，不开始做。");
    assert.equal(snapshot().works.length, 0); assert.equal(snapshot().artifacts.items.length, 0);
    const message = snapshot().messages.items.find(item => item.role === "assistant")!;
    const content = { kind: "message_text" as const, messageId: message.id, text: message.text };
    runtime.host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("start_work", { title: "城市 A" })]), fauxAssistantMessage("先确认内容，随时可以聊别的。")]);
    await send("正式开始城市 A，采用刚才那段内容。");
    const workId = snapshot().works[0]!.id;
    await send("只认可，暂不继续。", { workId, action: "approve_content", subject: content });
    assert.equal(searches, 0); assert.equal(hub.sessions.length, 0);
    assert.equal(snapshot().artifacts.items.length, 0, "采用原文不创建稿件副本");
    let batch!: MaterialSearchResult;
    runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("search_materials", { workId, kind: "video", query: "城市", limit: 3 })]),
      context => { batch = lastTool<MaterialSearchResult>(context); return fauxAssistantMessage("找到三段素材，请先看。") },
    ]);
    await send("认可并继续。", { workId, action: "approve_content_continue", subject: content });
    assert.equal(batch.results.length, 3); assert.equal(snapshot().proposals.items.length, 0);
    // 下一轮读取原批次，再采用前两段；不是读取“最近一次搜索”。
    const adopted: MaterialImportResult[] = [];
    let proposalRef!: { proposalId: string; digest: string };
    runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("read_material_batch", { batchId: batch.batchId })]),
      context => { assert.equal(lastTool<MaterialSearchResult>(context).results[1]!.candidateId, batch.results[1]!.candidateId);
        return fauxAssistantMessage([fauxToolCall("import_material", { workId, candidateId: batch.results[0]!.candidateId })]); },
      context => { adopted.push(lastTool<MaterialImportResult>(context)); return fauxAssistantMessage([fauxToolCall("import_material", { workId, candidateId: batch.results[1]!.candidateId })]); },
      context => { adopted.push(lastTool<MaterialImportResult>(context)); return fauxAssistantMessage([fauxToolCall("search_materials", { workId, kind: "image", query: "夜景", limit: 1 })]); },
      context => fauxAssistantMessage([fauxToolCall("import_material", { workId, candidateId: lastTool<MaterialSearchResult>(context).results[0]!.candidateId })]),
      context => {
        adopted.push(lastTool<MaterialImportResult>(context));
        const intent: ProductionIntent = { workId, title: "城市 A 配音成片", inputRevisions: [], maxSpend: { currency: "CNY", amountMinor: 40 },
          operations: [{ operationId: "speech", outputSlot: "audio", kind: "speech", model: speechBindingOf(runtime.database),
            inputs: [{ kind: "text", text: script }], parameters: { voiceId: "marin", format: "mp3" }, maxCreateAttempts: 1 },
          renderOp([{ kind: "blob", blobId: adopted[0]!.blobId, digest: adopted[0]!.digest }, ...adopted.slice(1).map(item => ({ kind: "blob" as const, blobId: item.blobId, digest: item.digest })), { kind: "operation_output", producerOperationId: "speech", outputSlot: "audio" }],
            { assembly: "timed_narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24,
              segments: [{ kind: "video", inputSlot: 0, startMs: 1000, durationMs: 6000 }, { kind: "video", inputSlot: 1, startMs: 2000, durationMs: 6000 }, { kind: "image", inputSlot: 2, durationMs: 8000 }], narrationInputSlot: 3 })],
          finalOutput: { operationId: "render", outputSlot: "final" } };
        return fauxAssistantMessage([fauxToolCall("prepare_production", { spec: toolIntentOf(intent) } as never)]);
      },
      context => {
        const prepared = lastTool<{ proposalId: string; digest: string }>(context);
        proposalRef = { proposalId: prepared.proposalId, digest: prepared.digest };
        return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "城市 A 画面与声音", kind: "script", content: { format: "markdown", text: "两段各截取六秒，静帧八秒；旁白短了补静音，长了停下讨论。", narrationText: script } }],
          stageDrafts: [{ workId, stage: "plan", itemIndex: 0, source: content, proposalRef }] } as never)]);
      },
      context => { lastTool(context); return fauxAssistantMessage("方案已交付，等你看完再开始。"); },
    ]);
    await send("用原批次前两段，加一张图，准备配音方案。");
    assert.equal(snapshot().works[0]!.stages.plan.proposalId, proposalRef.proposalId);
    const plan = snapshot().works[0]!.stages.plan.draft!;
    await send("认可方案，但先不制作。", { workId, action: "approve_plan", subject: plan });
    assert.equal(hub.sessions.length, 0); assert.equal(snapshot().runs.items.length, 0);
    const accepted = await app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposalRef.proposalId}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposalRef.digest } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    runtime.host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("record_work_feedback", { workId, artifactId: null, baseRevisionId: null })]),
      fauxAssistantMessage([fauxToolCall("start_work", { title: "咖啡 B" })]), fauxAssistantMessage("A 意见留到下一版，B 先聊内容。")]);
    await send("A 下版结尾静一点。我们也开始聊咖啡 B。");
    assert.equal(snapshot().works.length, 2);
    assert.equal(snapshot().messages.items.find(item => item.text.startsWith("A 下版"))!.feedback!.disposition, "next_version");
    const result = await drive(runtime, accepted.json().run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(hub.sessions.length, 1); assert.equal(stub.state.arkPosts.length, 0);
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    assert.ok(Math.abs((await probeVideoFile(file)).durationMs - 20_000) < 250);
    assert.equal((await outputAudioFacts(file)).codec, "aac");
    const video = snapshot().works.find(work => work.id === workId)!.stages.video.draft!;
    await send("这版定稿。", { workId, action: "finalize_video", subject: video });
    assert.equal(snapshot().runs.items.length, 1, "定稿不产生第二次制作");
    assert.equal(attemptsFor(runtime.database, result.id).length, 2, "配音与真实本地合成各一次");
    assert.deepEqual(snapshot().works.find(work => work.id === workId)!.stages.video.approved, video);
  } finally { await app.close(); await runtime.close(); closeStub(stub); await rm(assets.directory, { recursive: true, force: true }); }
});

// T13-c：替身返回 22s 超过画面总长：speech 只创建一次、音频与费用事实保留、render 如实失败不产成片、不补收费。
it("T13-c/F07：生成后旁白 22s 超过 20s 画面：保留已付音频，render 失败，不重试不补收费", async () => {
  const assets = await prepareTimedAssets();
  const stub = await startGraphStub(assets.clipA);
  const hub = new FakeRealtimeHub({ audioSeconds: 22 });
  const runtime = await buildGraphRuntime(assets.directory, stub.base, hub);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "超长旁白" }).conversation;
    const narrationText = (await deliverTexts(runtime, conversation.id, [{ title: "旁白文本", text: "这段旁白实际会比画面长。" }]))[0]!;
    const footage = timedFootage(assets, runtime, conversation.id);
    const { proposal } = await prepareIntent(runtime, conversation.id, timedSpeechIntent(footage, narrationText, speechBindingOf(runtime.database)));
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const result = await drive(runtime, admitted.run.id);
    assert.equal(result.state, "failed");
    assert.match(result.issue?.message ?? "", /旁白约 22\.0s，超过画面总长 20\.0s/);
    assert.match(result.issue?.message ?? "", /不加速、不剪词、不延长画面/);
    assert.equal(hub.sessions.length, 1, "配音只创建一次，不为凑时长再调供应商");
    assert.equal(stub.state.arkPosts.length, 0);
    // 已付音频保留为可读产出；render 不产成片。
    assert.equal(result.outputRevisions.length, 1, "只发布配音产出，无成片");
    const speech = await outputRevisionOf(runtime, result);
    assert.equal(speech.mimeType, "audio/mpeg");
    assert.ok((speech.durationMs ?? 0) > 21_000, "保留的是真实 22s 音频与费用事实");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); closeStub(stub); }
});

// T13-d：已核实的真实长旁白（21s > 20s 画面）仍在付费前拒绝——上界只对“待生成”让路。
it("T13-d/F07：已有真实 21s 旁白超过 20s 画面，prepare 在付费前拒绝", async () => {
  const assets = await prepareTimedAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "已知超长" }).conversation;
    const narration = path.join(assets.directory, "narration.mp3");
    await makeMp3(narration, 21);
    const narrationMs = (await probeAudioFile(narration)).durationMs;
    const footage = timedFootage(assets, runtime, conversation.id);
    await assert.rejects(prepareIntent(runtime, conversation.id, timedIntent(footage, mediaRevision(runtime, conversation.id, readFileSync(narration), "audio/mpeg", narrationMs))),
      (error: { code?: string; message?: string }) => error.code === "INVALID_INPUT" && /旁白约 21\.0s，超过画面总长 20\.0s/.test(error.message ?? ""));
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0, "不产生运行");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— T6-10：整批交付关闭本请求；下一明确请求才 prepare；一次确认授权全图 ——

it("T6-10：整批交付结束后同请求不得 prepare，下一请求才可准备，一次确认授权全部操作", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t6-delivery-"));
  const video = path.join(directory, "shot.mp4");
  await makeClip(video, "green", 24, 5);
  const stub = await startGraphStub(readFileSync(video));
  const hub = new FakeRealtimeHub({ audioSeconds: 3 });
  const runtime = await buildGraphRuntime(directory, stub.base, hub);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "交付关闭" }).conversation;
    const work = stageWork(runtime, conversation.id, "交付关闭视频");
    const spec = () => {
      const artifacts = runtime.service.snapshot("local-owner", conversation.id).artifacts.items;
      const prompt = artifacts.find(item => item.title === "山路镜头")!;
      const narrationArtifact = artifacts.find(item => item.title === "旁白文本")!;
      const promptRevision = runtime.service.readRevision("local-owner", prompt.id, prompt.revisionId);
      const narrationRevision = runtime.service.readRevision("local-owner", narrationArtifact.id, narrationArtifact.revisionId);
      const intent = graphIntent({ artifactId: prompt.id, revisionId: prompt.revisionId, digest: promptRevision.digest },
        { artifactId: narrationArtifact.id, revisionId: narrationArtifact.revisionId, digest: narrationRevision.digest },
        arkConfigOf(stub.base), speechBindingOf(runtime.database));
      return { ...intent, workId: work.workId };
    };
    // 第一条请求：整批交付两份文本后，同请求内再 prepare 被拒绝（A-18/T6-10）。
    runtime.host.faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "山路镜头", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } },
        { mode: "create", title: "旁白文本", kind: "prompt", content: { format: "markdown", text: "清晨的山脊铺满阳光。" } },
      ] })]),
      () => fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(spec()))) })]),
      fauxAssistantMessage("本请求已交付，等待你的下一条指示。"),
    ]);
    await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "给我镜头和旁白", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
    await waitForRequest(runtime, conversation.id);
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n, 0, "交付关闭后同请求不得准备提案");
    const invocation = runtime.database.prepare("SELECT state FROM tool_invocations WHERE tool_name='prepare_production'").get() as { state: string } | undefined;
    assert.equal(invocation?.state, "registered", "被拒的 prepare 没有业务提交回执");
    // 下一条明确请求才 prepare；一次确认授权全部三个操作。
    runtime.host.faux?.setResponses([
      () => fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(spec()))) })]),
      fauxAssistantMessage("提案已就绪，请确认。"),
    ]);
    await runtime.service.sendMessage("local-owner", conversation.id, { commandId: cmd(), text: "按这两份准备有声短片", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
    await waitForRequest(runtime, conversation.id);
    const proposalRow = runtime.database.prepare("SELECT id, digest FROM proposals").get() as { id: string; digest: string };
    const proposal = (await runtime.service.readProposal("local-owner", proposalRow.id)) as Proposal;
    assert.equal(proposal.state, "ready");
    bindPreparedPlan(runtime.database, staticClock(), scopeOf(conversation.id), proposal, work);
    runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM authorizations").get() as { n: number }).n, 1, "一次确认授权全图，不按操作重复确认");
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 1);
    assert.equal(stub.state.arkPosts.length + hub.sessions.length, 0, "确认只建运行，付费提交属于执行阶段");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); closeStub(stub); }
});

// —— T6-11：videoInputSlots=[1,0] 按实际画面顺序署名、旁白独立角色、刷新一致 ——

it("T6-11：videoInputSlots=[1,0] 按画面顺序署名，旁白独立角色，刷新后一致，不串未用输入", async () => {
  const assets = await prepareLocalAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  const source = (assetId: string): MediaProvenance => ({
    provider: "pexels", assetId, sourceUrl: `https://www.pexels.com/video/${assetId}/`, creatorName: assetId,
    creatorUrl: "https://www.pexels.com/@a/", licenseUrl: "https://www.pexels.com/license/", acquiredAt: staticClock(),
  });
  const recordSource = (db: AgentDatabase, ref: Ref, assetId: string) => {
    const row = db.prepare("SELECT content_json FROM artifact_revisions WHERE id=?").get(ref.revisionId) as { content_json: string };
    const blobId = (JSON.parse(row.content_json) as { blobId: string }).blobId;
    recordBlobSources(db, blobId, [source(assetId)]);
  };
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "画面顺序署名" }).conversation;
    const a = mediaRevision(runtime, conversation.id, assets.clipA, "video/mp4", 1200);
    const b = mediaRevision(runtime, conversation.id, assets.clipB, "video/mp4", 800);
    const narration = mediaRevision(runtime, conversation.id, assets.narrationShort, "audio/mpeg", assets.shortMs);
    await makeClip(path.join(assets.directory, "c.mp4"), "green", 24, 0.4);
    const unused = mediaRevision(runtime, conversation.id, readFileSync(path.join(assets.directory, "c.mp4")), "video/mp4", 400);
    for (const [ref, assetId] of [[a, "A"], [b, "B"], [narration, "N"], [unused, "C"]] as const) recordSource(runtime.database, ref, assetId);
    const result = await drive(runtime, await acceptIntent(runtime, conversation.id, narratedIntent([a, b], narration, { videoInputSlots: [1, 0] })));
    assert.equal(result.state, "succeeded");
    const content = await outputRevisionOf(runtime, result);
    assert.deepEqual(content.sources?.map(item => item.assetId), ["B", "A", "N"], "署名按实际画面顺序 B→A 聚合，旁白作为独立角色在最后");
    assert.deepEqual(blobSources(runtime.database, content.blobId).map(item => item.assetId), ["B", "A", "N"]);
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    assert.ok(isBlue(await frameColor(file, 0.2)), "画面顺序应是 B 在前");
    assert.ok(isRed(await frameColor(file, 1.6)), "A 在后");
    // 刷新（重启装配）后来源仍一致。
    await runtime.close();
    const reopened = await buildLocalRuntime(assets.directory);
    try {
      const output = reopened.service.getRun("local-owner", result.id).outputRevisions.at(-1)!;
      const revision = reopened.service.readRevision("local-owner", output.artifactId, output.revisionId);
      assert.equal(revision.content.format, "media");
      if (revision.content.format === "media") {
        assert.deepEqual(revision.content.sources?.map(item => item.assetId), ["B", "A", "N"], "刷新后来源顺序不变");
        assert.deepEqual(blobSources(reopened.database, revision.content.blobId).map(item => item.assetId), ["B", "A", "N"]);
      }
    } finally { await reopened.close(); }
  } finally { if (runtime.database.open) await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— B2.4/V4：成片运行按方案分段只读投影；指向片段的意见走公开入口核对 ——
// 全程用真实内核：事项、分段内容主稿、认可并继续、提案、分段方案关联、受理，均经公开入口；
// 媒体输入是既有修订（复用素材），片段投影不依赖执行，受理后即可核对。
it("B2.4 分段方案把成片运行投影为可指向片段；无 segmentIds 不虚构联动", async () => {
  const assets = await prepareTimedAssets();
  const runtime = await buildLocalRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "分段投影" }).conversation;
    const scope = scopeOf(conversation.id), db = runtime.database, now = staticClock();
    const work = createWork(db, now, scope, "分段投影");
    const contentReceipt = deliverStageDrafts(db, now, scope, {
      items: [{ mode: "create", title: "分段内容", kind: "script", content: { format: "markdown", text: "全局说明。",
        sections: [
          { id: "sec-open", title: "开场", text: "清晨山脊。" },
          { id: "sec-walk", title: "行进", text: "沿山脊向上。" },
          { id: "sec-night", title: "收尾", text: "夜色收束。" },
        ] } }],
      stageDrafts: [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }],
    });
    const seeded = runtime.service.snapshot("local-owner", conversation.id).works.find(item => item.id === work.id)!;
    const content = seeded.stages.content.draft!;
    assert.ok(content.kind === "artifact_revision", "内容主稿应是分段产物修订");
    recordStageConfirmation(db, now, scope, {
      workId: work.id, action: "approve_content_continue", subject: content,
      sourceKind: "user_message", sourceId: contentReceipt.requestId,
    });

    // 冻结视觉输入（既有真实素材修订）：两段视频 + 一张静帧；旁白是既有配音修订。
    const footage = timedFootage(assets, runtime, conversation.id);
    const narrationFile = path.join(assets.directory, "b2seg-narration.mp3");
    await makeMp3(narrationFile, 15);
    const narration = mediaRevision(runtime, conversation.id, readFileSync(narrationFile), "audio/mpeg", (await probeAudioFile(narrationFile)).durationMs);
    const inputs = [...footage.map(item =>
      ({ kind: "artifact_revision" as const, artifactId: item.ref.artifactId, revisionId: item.ref.revisionId, digest: item.ref.digest })),
      { kind: "artifact_revision" as const, artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }] as unknown as ProductionIntent["operations"][number]["inputs"];
    const intent: ProductionIntent = { workId: work.id, title: "分段成片",
      inputRevisions: [...footage.map(item => ({ artifactId: item.ref.artifactId, revisionId: item.ref.revisionId })),
        { artifactId: narration.artifactId, revisionId: narration.revisionId }] as unknown as ProductionIntent["inputRevisions"],
      operations: [renderOp(inputs, { assembly: "timed_narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24,
        segments: [{ kind: "video", inputSlot: 0, startMs: 1000, durationMs: 6000 }, { kind: "video", inputSlot: 1, startMs: 2000, durationMs: 6000 }, { kind: "image", inputSlot: 2, durationMs: 8000 }],
        narrationInputSlot: 3, segmentIds: ["seg-open", "seg-walk", "seg-night"] })],
      finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
    const { proposal } = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: intent });
    deliverStageDrafts(db, now, scope, {
      items: [{ mode: "create", title: "分段方案", kind: "script", content: { format: "markdown", text: "整体节奏。",
        sections: [
          { id: "seg-open", title: "开场镜头", text: "固定镜头六秒。", sourceSectionIds: ["sec-open"] },
          { id: "seg-walk", title: "行进镜头", text: "跟拍六秒。", sourceSectionIds: ["sec-walk"] },
          { id: "seg-night", title: "收尾镜头", text: "夜景静帧八秒。", sourceSectionIds: ["sec-night"] },
        ] } }],
      stageDrafts: [{ workId: work.id, stage: "plan", itemIndex: 0, source: content,
        proposalRef: { proposalId: proposal.id, digest: proposal.digest } }],
    });
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const run = runtime.service.getRun("local-owner", admitted.run.id);
    const planDraft = runtime.service.snapshot("local-owner", conversation.id).works.find(item => item.id === work.id)!.stages.plan.draft!;
    assert.ok(planDraft.kind === "artifact_revision");

    const blobOf = (ref: Ref) =>
      (JSON.parse((db.prepare("SELECT content_json FROM artifact_revisions WHERE id = ?").get(ref.revisionId) as { content_json: string }).content_json) as { blobId: string }).blobId;
    const segments = run.segments;
    assert.equal(segments.length, 3, "三个方案段落对应三个片段");
    assert.deepEqual(segments.map(segment => segment.segmentId), ["seg-open", "seg-walk", "seg-night"]);
    assert.deepEqual(segments.map(segment => segment.title), ["开场镜头", "行进镜头", "收尾镜头"]);
    const [opening, walking, night] = segments;
    // 画面事实从冻结 render 输入读取：复用素材的段落带出原媒体与来源修订。
    assert.deepEqual(opening!.revision, { artifactId: footage[0]!.ref.artifactId, revisionId: footage[0]!.ref.revisionId });
    assert.equal(opening!.media?.blobId, blobOf(footage[0]!.ref));
    assert.equal(opening!.media?.mimeType, "video/mp4");
    assert.equal(opening!.startMs, 1000);
    assert.equal(opening!.durationMs, 6000);
    assert.equal(walking!.media?.blobId, blobOf(footage[1]!.ref));
    assert.equal(walking!.startMs, 2000);
    assert.equal(night!.media?.mimeType, "image/png");
    assert.equal(night!.startMs, null, "静帧段没有裁切起点");
    assert.equal(night!.durationMs, 8000);
    for (const segment of segments) {
      assert.equal(segment.state, "succeeded", "既有素材的段落已可播放");
      assert.deepEqual(segment.plan, { artifactId: planDraft.artifactId, revisionId: planDraft.revisionId });
      assert.deepEqual(segment.content, content, "段落带出它引用的内容主稿来源");
    }
    assert.deepEqual(opening!.sourceSectionIds, ["sec-open"]);

    // 指向片段的意见经公开入口核对；运行在途，意见留到下一版。
    const noted = runtime.service.addFeedback("local-owner", conversation.id, {
      commandId: cmd(), text: "第二段再紧一点。",
      target: { artifactId: planDraft.artifactId, revisionId: planDraft.revisionId, workId: work.id,
        segment: { runId: run.id, segmentId: "seg-walk" } },
    });
    assert.equal(noted.receipt.disposition, "next_version");
    const notedMessage = runtime.service.readMessage("local-owner", noted.receipt.messageId);
    assert.deepEqual(notedMessage.target?.segment, { runId: run.id, segmentId: "seg-walk" }, "片段指向原样保留");
    assert.throws(() => runtime.service.addFeedback("local-owner", conversation.id, {
      commandId: cmd(), text: "意见",
      target: { artifactId: planDraft.artifactId, revisionId: planDraft.revisionId, workId: work.id,
        segment: { runId: run.id, segmentId: "seg-gone" } },
    }), /不在这份运行的片段列表里/);

    // render 未带 segmentIds：不虚构联动。
    const plain = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "无分段" }).conversation;
    const plainClips = [mediaRevision(runtime, plain.id, assets.clipA, "video/mp4", 8000),
      mediaRevision(runtime, plain.id, assets.clipB, "video/mp4", 8000)];
    const plainRunId = await acceptIntent(runtime, plain.id, orderedIntent(plainClips));
    assert.deepEqual(runtime.service.getRun("local-owner", plainRunId).segments, [], "无 segmentIds 时片段为空");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});
