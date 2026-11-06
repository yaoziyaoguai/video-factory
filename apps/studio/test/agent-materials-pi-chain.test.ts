import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { realRenderValidator } from "../src/server/agent/media-config.js";
import { saveKeyedServiceSettings, saveKeylessServiceSettings, saveNewsNowServiceSettings, savePexelsServiceSettings } from "../src/server/agent/free-service-settings.js";
import { systemClock } from "../src/server/agent/util.js";
import { seedPlanStageWork, bindPreparedPlan } from "./helpers/creative-work-fixture.js";
import { toolIntentOf } from "./helpers/tool-args.js";
import type { ArtifactRevision, MaterialBatch, MaterialImportResult, MaterialSearchResult, ProductionIntent, TrendReadResult } from "../src/shared/agent/generated/contracts.js";

// §0.3 完整 Pi 链验收：Faux 模型经真实 Pi SDK 队列调用素材/资讯/交付/提案工具，
// 证据落在服务端事实（artifacts/request_deliveries/material_*/production_*）与模型可见回执上。
// Pexels 回源走注入替身 fetch；NewsNow 一律真实 fetch 指向本地 HTTP 桩（T3-12）。

const run = promisify(execFile);
const origin = "http://127.0.0.1:4399";
const httpHeaders = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
let sequence = 0;
const cmd = () => `pi-${++sequence}`;
const input = (text: string) => ({ commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < until, "条件等待超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const activeRequests = (assembly: { database: OfflineAgentAssembly["database"] }, conversationId: string) =>
  assembly.database.prepare("SELECT id FROM requests WHERE conversation_id=? AND state IN ('queued','running')").all(conversationId).length;
async function done(assembly: OfflineAgentAssembly, conversationId: string): Promise<void> {
  await waitFor(() => activeRequests(assembly, conversationId) === 0);
}

function imageBytes(codec: "png" | "mjpeg", width: number, height: number): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=1`,
    "-frames:v", "1", "-c:v", codec, "-f", "image2pipe", "pipe:1"]);
}

async function makeClip(file: string, color: "red" | "blue", rate: number, seconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=${rate}:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
}

interface PexelsCall { url: string; init: RequestInit | undefined }

const photoEntry = (id: number, name: string) => ({
  id, width: 1280, height: 720, url: `https://www.pexels.com/photo/${id}/`, alt: `${name} photo`,
  photographer: `${name} Author`, photographer_url: `https://www.pexels.com/@${id}/`,
  src: { original: `https://images.pexels.com/photos/${id}/o.jpg` },
});

const videoEntry = (id: number, name: string, file: string) => ({
  id, width: 640, height: 360, duration: 1.2, url: `https://www.pexels.com/video/${id}/`,
  user: { name: `${name} Author`, url: `https://www.pexels.com/@${id}/` },
  image: `https://images.pexels.com/videos/${id}.jpg`,
  video_files: [{ id: 1, file_type: "video/mp4", quality: "sd", width: 640, height: 360, link: `https://videos.pexels.com/${id}/${file}` }],
});

// faux 上下文 → 工具结果（本套件的模型脚本用它把动态 candidateId/blobId 串进下一步）。
// 结果形状由对应工具的 canonical 合同保证；faux 回传与契约同形的普通 JSON。
type ToolMessage = { role: string; toolName: string; content: Array<{ type: string; text?: string }>; isError: boolean };
function lastToolResult(context: { messages: unknown[] }): ToolMessage {
  const all = context.messages.filter(message => (message as ToolMessage).role === "toolResult") as ToolMessage[];
  const message = all.at(-1)!;
  assert.ok(message, "faux 上下文里应有工具结果");
  assert.equal(message.isError, false, "意外的工具错误");
  return message;
}
function toolResults(context: { messages: unknown[] }, toolName: string): ToolMessage[] {
  const messages = context.messages.filter(message => {
    const tool = message as ToolMessage;
    return tool.role === "toolResult" && tool.toolName === toolName;
  }) as ToolMessage[];
  assert.ok(messages.length > 0, `faux 上下文里应有 ${toolName} 结果`);
  return messages;
}
const toolJson = <T>(message: ToolMessage): T => JSON.parse(message.content.find(part => part.type === "text")!.text!) as T;
const lastToolJson = <T>(context: { messages: unknown[] }): T => toolJson<T>(lastToolResult(context));
const toolJsons = <T>(context: { messages: unknown[] }, toolName: string): T[] => toolResults(context, toolName).map(message => toolJson<T>(message));

// prepare_production 的结果是带前缀的人读摘要；提案本体用 readProposal 按 id 读取。
function preparedSummary(context: { messages: unknown[] }): { proposalId: string; state: string } {
  const text = lastToolResult(context).content.find(part => part.type === "text")!.text!;
  const prefix = "提案已准备：";
  assert.ok(text.startsWith(prefix), "prepare 结果应带提案摘要");
  return JSON.parse(text.slice(prefix.length)) as { proposalId: string; state: string };
}

// ToolCall 参数按 JSON 值约束；类型化的 spec 剥掉服务端定价字段后按契约形状传入，严格校验仍在工具边界执行。
const prepareProductionArgs = (spec: ProductionIntent) => ({ spec: toolIntentOf(spec) }) as unknown as Parameters<typeof fauxToolCall>[1];

function count(db: OfflineAgentAssembly["database"] | AgentRuntime["database"], table: string, where = "1=1"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

test("M1 Pi原生工具：音频搜索→闲聊→原批次第二首→采用与音频草稿，保持普通聊天", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-audio-"));
  const audioFile = path.join(directory, "local-signal.mp3");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", audioFile]);
  const audio = readFileSync(audioFile);
  const tracks = ["one", "two"].map(id => ({ id, title: `Local fixture ${id}`, is_premium: false, duration: 2,
    artists: [[0, { id: "artist-a", name: "本地作者A" }], [1, { id: "artist-b", name: "本地作者B" }]], lyrics: id === "two" ? "en" : null,
    files: { mp3: `https://eu.data.freetouse.com/${id}.mp3` } }));
  const calls: string[] = [];
  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, stockFetch: async (url) => {
    calls.push(String(url));
    const target = new URL(String(url));
    if (target.host === "eu.data.freetouse.com") return new Response(new Uint8Array(audio));
    return new Response(JSON.stringify({ ok: true, data: target.pathname.endsWith("/search") ? tracks : tracks.find(track => target.pathname.endsWith(`/${track.id}`)) }));
  } });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });
  saveKeylessServiceSettings(a.database, systemClock, "local-owner", "freetouse", { commandId: "enable-audio-fixture", expectedRevision: 0, enabled: true });
  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "Pi音频本地夹具" }).conversation.id;
  let original!: MaterialSearchResult;
  let adopted!: MaterialImportResult;
  a.faux!.setResponses([
    context => {
      const search = getCurrentTools(context.messages).find(tool => tool.name === "search_materials");
      assert.ok(search && JSON.stringify(search.parameters).includes('"audio"'), "Pi实际获得扩展后的同一工具schema");
      return fauxAssistantMessage([fauxToolCall("search_materials", { kind: "audio", query: "quiet", limit: 2 })]);
    },
    context => { original = lastToolJson<MaterialSearchResult>(context); return fauxAssistantMessage("两首候选已返回，尚未采用。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("找两首音乐，先不做视频"));
  await done(a, conversationId);
  assert.equal(original.results[1]!.vocalKind, "song");
  a.faux!.setResponses([fauxAssistantMessage("我们也可以先聊别的。")]);
  await a.service.sendMessage("local-owner", conversationId, input("先聊一会儿天气"));
  await done(a, conversationId);
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("read_material_batch", { batchId: original.batchId })]),
    context => {
      const batch = lastToolJson<MaterialBatch>(context);
      assert.equal(batch.results[1]!.candidateId, original.results[1]!.candidateId);
      return fauxAssistantMessage([fauxToolCall("import_material", { candidateId: batch.results[1]!.candidateId, usage: "personal_social_ugc" })]);
    },
    context => {
      adopted = lastToolJson<MaterialImportResult>(context);
      return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "第二首音乐草稿", kind: "audio", content: { format: "media_reference", blobId: adopted.blobId } }] })]);
    },
    fauxAssistantMessage("已采用第二首，音频仍是草稿。"),
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("用刚才第二首，用于我个人社交账号自制视频"));
  await done(a, conversationId);
  const snapshot = a.service.snapshot("local-owner", conversationId);
  const artifact = snapshot.artifacts.items.find(item => item.kind === "audio")!;
  assert.ok(artifact);
  const revision = a.service.readRevision("local-owner", artifact.id, artifact.revisionId);
  assert.equal(revision.content.format === "media" && revision.content.blobId, adopted.blobId);
  assert.equal(adopted.provenance.creatorName, "本地作者A; 本地作者B");
  assert.ok(adopted.durationMs! >= 2000);
  assert.equal(snapshot.works.length, 0);
  assert.equal(count(a.database, "production_runs"), 0);
  assert.deepEqual(calls.filter(url => new URL(url).host === "eu.data.freetouse.com"), ["https://eu.data.freetouse.com/two.mp3"]);
  const playback = await a.app.inject({ method: "GET", url: `/api/agent/v1/blobs/${adopted.blobId}/content`, headers: httpHeaders });
  assert.equal(playback.statusCode, 200); assert.ok(playback.rawPayload.equals(audio));
  const refreshed = await a.app.inject({ method: "GET", url: `/api/agent/v1/material-batches/${original.batchId}`, headers: httpHeaders });
  assert.equal(refreshed.statusCode, 200); assert.deepEqual(refreshed.json().results, original.results);
});

test("T3-06 Pi 链：prompt+采用图片正式交付，PC 来源与刷新一致；候选原作和采用实测分开；视频同样保留", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t306-"));
  const calls: PexelsCall[] = [];
  const jpeg = imageBytes("mjpeg", 1280, 720);
  const regularJpeg = imageBytes("mjpeg", 1080, 720);
  await makeClip(path.join(directory, "clip.mp4"), "red", 12, 1);
  const clip = readFileSync(path.join(directory, "clip.mp4"));
  const pexelsFetch: typeof fetch = (async (request, init) => {
    const url = String(request);
    calls.push({ url, init });
    const target = new URL(url);
    if (target.host === "api.unsplash.com" && target.pathname === "/search/photos") return new Response(JSON.stringify({ results: [{
      id: "rain-42", width: 5472, height: 3648, alt_description: "Rain",
      user: { name: "Rain Author", links: { html: "https://unsplash.com/@rain" } },
      links: { html: "https://unsplash.com/photos/rain-42", download_location: "https://api.unsplash.com/photos/rain-42/download" },
      urls: { small: "https://images.unsplash.com/rain-42?w=400", regular: "https://images.unsplash.com/rain-42?w=1080&fit=max" },
    }] }), { status: 200 });
    if (target.host === "api.unsplash.com" && target.pathname === "/photos/rain-42/download") {
      return new Response(JSON.stringify({ url: "https://images.unsplash.com/rain-42" }), { status: 200 });
    }
    if (target.host === "images.unsplash.com") return new Response(new Uint8Array(regularJpeg), { status: 200 });
    if (target.pathname.includes("/videos/search")) return new Response(JSON.stringify({ videos: [videoEntry(5566, "Road", "clip.mp4")] }), { status: 200 });
    if (target.pathname.endsWith("/search")) return new Response(JSON.stringify({ photos: [photoEntry(2018293, "Rainy")] }), { status: 200 });
    if (target.host === "images.pexels.com") return new Response(new Uint8Array(jpeg), { status: 200 });
    if (target.host === "videos.pexels.com") return new Response(new Uint8Array(clip), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, stockFetch: pexelsFetch });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });
  savePexelsServiceSettings(a.database, systemClock, "local-owner", { commandId: "enable", expectedRevision: 0, enabled: true, apiKey: "secret-key" });
  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "素材交付" }).conversation.id;

  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "mountain road", kind: "image", limit: 3 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: lastToolJson<MaterialSearchResult>(context).results[0]!.candidateId })]),
    context => fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "配图思路", kind: "prompt", content: { format: "markdown", text: "用这张图开场。" } },
      { mode: "create", title: "山路配图", kind: "image", content: { format: "media_reference", blobId: lastToolJson<MaterialImportResult>(context).blobId } },
    ] })]),
    fauxAssistantMessage("已交付。"),
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("找一张山路图并交付"));
  await done(a, conversationId);

  const imageArtifact = a.service.snapshot("local-owner", conversationId).artifacts.items.find(item => item.kind === "image")!;
  assert.ok(imageArtifact, "图片产物应已交付");
  const revision = a.service.readRevision("local-owner", imageArtifact.id, imageArtifact.revisionId);
  assert.equal(revision.content.format, "media");
  if (revision.content.format !== "media") return;
  assert.equal(revision.content.mimeType, "image/jpeg");
  assert.deepEqual(
    revision.content.sources?.map(source => [source.provider, source.assetId, source.creatorName]),
    [["pexels", "2018293", "Rainy Author"]],
  );

  // PC 视角走真实 HTTP：同一修订两次读取（刷新）给同一事实；预览 URL 不带任何查询串。
  const revisionUrl = `/api/agent/v1/artifacts/${imageArtifact.id}/revisions/${imageArtifact.revisionId}`;
  const first = await a.app.inject({ method: "GET", url: revisionUrl, headers: httpHeaders });
  const refreshed = await a.app.inject({ method: "GET", url: revisionUrl, headers: httpHeaders });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(refreshed.json(), first.json(), "刷新后署名来源保持一致");
  assert.deepEqual(refreshed.json().content.sources, revision.content.sources);

  const blobUrl = `/api/agent/v1/blobs/${encodeURIComponent(revision.content.blobId)}/content`;
  assert.equal(new URL(blobUrl, origin).search, "", "完整预览 URL 不携带查询串");
  const blobResponse = await a.app.inject({ method: "GET", url: blobUrl, headers: httpHeaders });
  assert.equal(blobResponse.statusCode, 200);
  assert.ok(blobResponse.rawPayload.equals(jpeg), "PC 下载到采用的原字节");
  assert.ok(!blobResponse.rawPayload.toString().includes("secret-key"));

  // 同一 Pi 工具链分别读到来源尺寸和首次采用实测，不从 regular URL 推算像素。
  saveKeyedServiceSettings(a.database, systemClock, "local-owner", "unsplash", { commandId: "enable-unsplash", expectedRevision: 0, enabled: true, apiKey: "unsplash-key" });
  let search!: MaterialSearchResult, batch!: MaterialBatch, imported!: MaterialImportResult, replay!: MaterialImportResult;
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { provider: "unsplash", query: "rain", kind: "image", limit: 1 })]),
    context => {
      search = lastToolJson<MaterialSearchResult>(context);
      return fauxAssistantMessage([fauxToolCall("read_material_batch", { batchId: search.batchId })]);
    },
    context => {
      batch = lastToolJson<MaterialBatch>(context);
      return fauxAssistantMessage([fauxToolCall("import_material", { candidateId: batch.results[0]!.candidateId })]);
    },
    context => {
      imported = lastToolJson<MaterialImportResult>(context);
      return fauxAssistantMessage([fauxToolCall("import_material", { candidateId: batch.results[0]!.candidateId })]);
    },
    context => { replay = lastToolJson<MaterialImportResult>(context); return fauxAssistantMessage("已读取候选与采用文件的尺寸。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("找 Unsplash 雨景，说明来源图和采用文件的尺寸"));
  await done(a, conversationId);
  assert.deepEqual([search.results[0]!.width, search.results[0]!.height, search.results[0]!.dimensionsKind], [5472, 3648, "source"]);
  assert.deepEqual(batch.results, search.results, "模型搜索和读回批次时的尺寸含义一致");
  assert.deepEqual(imported.dimensions, { width: 1080, height: 720 }, "模型看到的采用回执是实际像素");
  assert.deepEqual(replay, imported, "模型重复采用仍读到首次实测");
  assert.equal(calls.filter(call => new URL(call.url).host === "images.unsplash.com").length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/photos/rain-42/download").length, 1);
  const batchUrl = `/api/agent/v1/material-batches/${search.batchId}`;
  const pcBatch = await a.app.inject({ method: "GET", url: batchUrl, headers: httpHeaders });
  const refreshedBatch = await a.app.inject({ method: "GET", url: batchUrl, headers: httpHeaders });
  assert.equal(pcBatch.statusCode, 200);
  assert.deepEqual(pcBatch.json().results, search.results, "PC 与 Pi 取得相同候选语义");
  assert.deepEqual(refreshedBatch.json(), pcBatch.json(), "PC 刷新不混入采用尺寸");

  // 视频路径同样保留：搜索→采用→交付 video 修订可读、来源仍在。
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "mountain", kind: "video", limit: 3 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: lastToolJson<MaterialSearchResult>(context).results[0]!.candidateId })]),
    context => fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "山路片段", kind: "video", content: { format: "media_reference", blobId: lastToolJson<MaterialImportResult>(context).blobId } },
    ] })]),
    fauxAssistantMessage("已交付。"),
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("再要一段山路视频"));
  await done(a, conversationId);
  const videoArtifact = a.service.snapshot("local-owner", conversationId).artifacts.items.find(item => item.kind === "video")!;
  assert.ok(videoArtifact, "视频产物应已交付");
  const videoRevision = a.service.readRevision("local-owner", videoArtifact.id, videoArtifact.revisionId);
  if (videoRevision.content.format !== "media") { assert.fail("视频修订应为媒体内容"); return; }
  assert.equal(videoRevision.content.mimeType, "video/mp4");
  assert.ok((videoRevision.content.durationMs ?? 0) > 0);
  assert.equal(videoRevision.content.sources?.[0]?.assetId, "5566");
  const videoBlob = await a.app.inject({ method: "GET", url: `/api/agent/v1/blobs/${encodeURIComponent(videoRevision.content.blobId)}/content`, headers: httpHeaders });
  assert.equal(videoBlob.statusCode, 200);
  assert.equal(videoBlob.headers["content-type"], "video/mp4");

  // Authorization 只发固定 API 入口；媒体域名回源不携带 Key。
  for (const call of calls) {
    const host = new URL(call.url).host;
    const authorization = (call.init?.headers as Record<string, string> | undefined)?.authorization;
    if (host === "images.pexels.com" || host === "videos.pexels.com" || host === "images.unsplash.com") {
      assert.equal(authorization, undefined, `媒体下载不得携带 Key：${call.url}`);
    } else if (host === "api.unsplash.com") assert.equal(authorization, "Client-ID unsplash-key");
    else assert.equal(authorization, "secret-key");
  }
});

test("T3-12 Pi 链：read_trends 无内部 ID 读配置榜单；读取中改配置本次沿快照、下次用新值；全部失败非空 unavailable 榜", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t312-"));
  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });

  const updatedTime = "2026-10-27T08:00:00Z";
  let failAll = false;
  let reconfigured = false;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    const id = url.searchParams.get("id");
    if (url.pathname !== "/api/s" || !id || failAll) { response.destroy(); return; }
    if (id === "github") {
      // 首次读取进行中改配置：本次调用已捕获旧快照，下一次调用才会用新值。
      if (!reconfigured) {
        reconfigured = true;
        saveNewsNowServiceSettings(a.database, systemClock, "local-owner", {
          commandId: "swap", expectedRevision: 1, enabled: true, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sourceIds: ["weibo"], topics: [],
        });
      }
      response.end(JSON.stringify({ status: "success", id: "github", updatedTime, items: [
        { id: "g1", title: "某项目发布 1.0", url: "https://github.com/a/b" },
        { id: "g2", title: "第二条", url: "https://github.com/a/c" },
      ] }));
      return;
    }
    response.end(JSON.stringify({ status: "cache", id: "weibo", updatedTime, items: [{ id: "w1", title: "热搜一条", url: "https://weibo.example/hot" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  saveNewsNowServiceSettings(a.database, systemClock, "local-owner", { commandId: "init", expectedRevision: 0, enabled: true, endpoint, sourceIds: ["github"], topics: ["科技"] });

  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "热点" }).conversation.id;
  let firstBoard!: TrendReadResult, secondBoard!: TrendReadResult, failedBoard!: TrendReadResult;
  a.faux!.setResponses([
    // 用户不提供内部 sourceId：省略即读当前配置集合。
    fauxAssistantMessage([fauxToolCall("read_trends", { limit: 2 })]),
    context => { firstBoard = lastToolJson<TrendReadResult>(context); return fauxAssistantMessage("读到了。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("现在有什么热点？"));
  await done(a, conversationId);
  assert.deepEqual(firstBoard.sources.map((source: any) => [source.sourceId, source.status]), [["github", "success"]], "本次沿调用开始时的快照");
  assert.equal(firstBoard.topics.length, 1);
  assert.equal(firstBoard.sources[0].items.length, 2);

  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("read_trends", { limit: 2 })]),
    context => { secondBoard = lastToolJson<TrendReadResult>(context); return fauxAssistantMessage("换了一批。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("再读一次"));
  await done(a, conversationId);
  assert.deepEqual(secondBoard.sources.map((source: any) => [source.sourceId, source.status]), [["weibo", "cache"]], "下次调用使用新配置");
  assert.deepEqual(secondBoard.topics, []);

  failAll = true;
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("read_trends", { limit: 2 })]),
    context => { failedBoard = lastToolJson<TrendReadResult>(context); return fauxAssistantMessage("来源暂时不可用。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("再试一次"));
  await done(a, conversationId);
  assert.equal(failedBoard.sources.length, 1, "全部失败也不是空榜");
  assert.equal(failedBoard.sources[0].status, "unavailable");
  assert.ok(failedBoard.sources[0].error, "unavailable 快照带原因");
  assert.deepEqual(failedBoard.sources[0].items, []);
});

test("T3-13a Pi 链：默认超过两分钟不中断下载，用户 stop 仍生效；下一消息正常执行", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t313a-"));
  let downloadStarted = false;
  let downloadSignal: AbortSignal | null = null;
  const pexelsFetch: typeof fetch = (async (request, init) => {
    const target = new URL(String(request));
    if (target.pathname.endsWith("/search")) return new Response(JSON.stringify({ photos: [photoEntry(7, "Seven")] }), { status: 200 });
    if (target.host === "images.pexels.com") {
      downloadStarted = true;
      downloadSignal = init?.signal ?? null;
      // 可控挂起流：只在原取消 signal 上退出，模拟真实 fetch 的中止行为。
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("download aborted")), { once: true });
        },
      }), { status: 200, headers: { "content-length": "4096" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, stockFetch: pexelsFetch });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });
  savePexelsServiceSettings(a.database, systemClock, "local-owner", { commandId: "enable", expectedRevision: 0, enabled: true, apiKey: "key" });
  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "停止采用" }).conversation.id;

  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "seven", kind: "image", limit: 3 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: lastToolJson<MaterialSearchResult>(context).results[0]!.candidateId })]),
    // 若停止未贯穿工具，这一步会执行并被登记：断言其从未发生。
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "迟到交付", kind: "prompt", content: { format: "markdown", text: "不应出现" } },
    ] })]),
    fauxAssistantMessage("不应到达"),
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const sent = await a.service.sendMessage("local-owner", conversationId, input("采用这张图"));
  const startedDeadline = Date.now() + 10_000;
  while (!downloadStarted && Date.now() < startedDeadline) {
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!downloadStarted) t.mock.timers.reset();
  assert.ok(downloadStarted);
  t.mock.timers.tick(120_001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((downloadSignal as AbortSignal | null)?.aborted, false, "正常下载没有被宿主取消");
  assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(sent.receipt.requestId) as { state: string }).state, "running", "正常工具等待不受整个回合两分钟截断");
  assert.ok(!a.service.snapshot("local-owner", conversationId).messages.items.some(message => message.text?.includes("时间上限")));
  t.mock.timers.reset();
  a.service.stopRequest("local-owner", sent.receipt.requestId!, { commandId: "stop-1" });
  await done(a, conversationId);

  assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(sent.receipt.requestId) as { state: string }).state, "stopped");
  assert.equal(count(a.database, "production_blobs"), 0, "截止后不登记采用");
  assert.equal(count(a.database, "material_blob_sources"), 0);
  assert.equal((a.database.prepare("SELECT imported_blob_id IS NULL AS pending FROM material_candidates").get() as { pending: number }).pending, 1);
  assert.equal(count(a.database, "artifacts"), 0, "无迟到交付");
  assert.equal(count(a.database, "request_deliveries"), 0);
  assert.equal(count(a.database, "tool_invocations", "tool_name='deliver_artifacts'"), 0, "交付调用从未发生");

  a.faux!.setResponses([fauxAssistantMessage("我们继续聊。")]);
  const next = await a.service.sendMessage("local-owner", conversationId, input("继续聊"));
  await done(a, conversationId);
  assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(next.receipt.requestId) as { state: string }).state, "completed");
  const messages = a.service.snapshot("local-owner", conversationId).messages.items;
  assert.ok(messages.some(message => message.role === "assistant" && message.text === "我们继续聊。"));
});

test("T3-13b Pi 链：短 turnMs 截止挂起下载，不登记采用、不正式交付；下一消息正常执行", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t313b-"));
  let downloadStarted = false;
  const pexelsFetch: typeof fetch = (async (request, init) => {
    const target = new URL(String(request));
    if (target.pathname.endsWith("/search")) return new Response(JSON.stringify({ photos: [photoEntry(9, "Nine")] }), { status: 200 });
    if (target.host === "images.pexels.com") {
      downloadStarted = true;
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("download aborted")), { once: true });
        },
      }), { status: 200, headers: { "content-length": "4096" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, stockFetch: pexelsFetch, limits: { turnMs: 600, maxToolCalls: 32 } });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });
  savePexelsServiceSettings(a.database, systemClock, "local-owner", { commandId: "enable", expectedRevision: 0, enabled: true, apiKey: "key" });
  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "超时采用" }).conversation.id;

  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "nine", kind: "image", limit: 3 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: lastToolJson<MaterialSearchResult>(context).results[0]!.candidateId })]),
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "迟到交付", kind: "prompt", content: { format: "markdown", text: "不应出现" } },
    ] })]),
    fauxAssistantMessage("不应到达"),
  ]);
  const sent = await a.service.sendMessage("local-owner", conversationId, input("采用这张图"));
  await waitFor(() => downloadStarted);
  await done(a, conversationId);

  assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(sent.receipt.requestId) as { state: string }).state, "completed");
  assert.ok(a.service.snapshot("local-owner", conversationId).messages.items.some(message => message.text?.includes("时间上限")), "超时通知如实呈现");
  assert.equal(count(a.database, "production_blobs"), 0, "截止后不登记采用");
  assert.equal(count(a.database, "artifacts"), 0, "无迟到交付");
  assert.equal(count(a.database, "request_deliveries"), 0);
  assert.equal(count(a.database, "tool_invocations", "tool_name='deliver_artifacts'"), 0);

  a.faux!.setResponses([fauxAssistantMessage("我们继续聊。")]);
  const next = await a.service.sendMessage("local-owner", conversationId, input("继续聊"));
  await done(a, conversationId);
  assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(next.receipt.requestId) as { state: string }).state, "completed");
});

test("T3-14 Pi 链：未采用媒体整批拒绝；明确 prepare 可复用已有 blob；合法交付写 revision_blob_links", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t314-"));
  await makeClip(path.join(directory, "a.mp4"), "red", 12, 1.2);
  await makeClip(path.join(directory, "b.mp4"), "blue", 30, 0.8);
  const clipA = readFileSync(path.join(directory, "a.mp4")), clipB = readFileSync(path.join(directory, "b.mp4"));
  const pexelsFetch: typeof fetch = (async (request) => {
    const target = new URL(String(request));
    if (target.pathname.includes("/videos/search")) return new Response(JSON.stringify({ videos: [
      videoEntry(101, "Red", "a.mp4"), videoEntry(202, "Blue", "b.mp4"),
    ] }), { status: 200 });
    if (target.host === "videos.pexels.com") {
      return new Response(new Uint8Array(target.pathname.endsWith("a.mp4") ? clipA : clipB), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const a = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, stockFetch: pexelsFetch, media: { autoStart: false } });
  t.after(async () => { await a.close(); await rm(directory, { recursive: true, force: true }); });
  savePexelsServiceSettings(a.database, systemClock, "local-owner", { commandId: "enable", expectedRevision: 0, enabled: true, apiKey: "key" });
  const conversationId = a.service.createConversation("local-owner", { commandId: cmd(), title: "引用边界" }).conversation.id;

  // 请求 1：采用 A/B 两段视频，只正式交付 A；B 保持“已采用未交付”。
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "road", kind: "video", limit: 5 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: toolJsons<MaterialSearchResult>(context, "search_materials")[0]!.results[0]!.candidateId })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: toolJsons<MaterialSearchResult>(context, "search_materials")[0]!.results[1]!.candidateId })]),
    context => { const [first, second] = toolJsons<MaterialImportResult>(context, "import_material"); return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "片段说明", kind: "prompt", content: { format: "markdown", text: "只交付 A。" } },
      { mode: "create", title: "片段 A", kind: "video", content: { format: "media_reference", blobId: first!.blobId } },
    ] })]); },
    fauxAssistantMessage("已交付 A。"),
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("采用两段，交付 A"));
  await done(a, conversationId);
  const delivered = a.service.snapshot("local-owner", conversationId).artifacts.items.find(item => item.kind === "video")!;
  assert.ok(delivered, "A 应已正式交付");
  const deliveredRevision = a.service.readRevision("local-owner", delivered.id, delivered.revisionId);
  assert.equal(deliveredRevision.content.format, "media");
  assert.equal(count(a.database, "revision_blob_links", `revision_id='${delivered.revisionId}'`), 1, "合法交付登记修订-blob 关联");
  const blobs = a.database.prepare("SELECT id, digest FROM production_blobs ORDER BY rowid").all() as Array<{ id: string; digest: string }>;
  assert.equal(blobs.length, 2);
  const undeliveredBlob = blobs.find(blob => blob.id !== (deliveredRevision.content as { blobId: string }).blobId)!;

  // 请求 2：伪造“交付从未采用的媒体”→ 整批拒绝（S2-04 决定已采用 blob 跨轮可交付，
  // 原“上一请求未交付 blob 不能再交付”反例由该决定替换，见 DOGFOOD-STAGES-1-3-EXECUTION.md S2-04）；
  // 再走明确入口 prepare_production 复用同 owner/conversation 的已有 blob 与已交付修订 → ready 且零制作。
  let deliveryError = "";
  let prepared!: { proposalId: string; state: string };
  const planWork = seedPlanStageWork(a.database, systemClock(), { ownerId: "local-owner", conversationId }, "片段成片");
  const spec: ProductionIntent = {
    workId: planWork.workId, title: "片段成片",
    inputRevisions: [{ artifactId: delivered.id, revisionId: delivered.revisionId }],
    operations: [{ operationId: "render", outputSlot: "final", kind: "render", model: null,
      inputs: [
        { kind: "artifact_revision", artifactId: delivered.id, revisionId: delivered.revisionId, digest: deliveredRevision.digest },
        { kind: "blob", blobId: undeliveredBlob.id, digest: undeliveredBlob.digest },
      ],
      maxCreateAttempts: 1,
      parameters: { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 } }],
    finalOutput: { operationId: "render", outputSlot: "final" },
    maxSpend: { currency: "CNY", amountMinor: 0 },
  };
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "说明", kind: "prompt", content: { format: "markdown", text: "连带交付。" } },
      { mode: "create", title: "片段 B", kind: "video", content: { format: "media_reference", blobId: "blb-never-adopted" } },
    ] })]),
    context => {
      const results = context.messages.filter(message => (message as ToolMessage).role === "toolResult") as ToolMessage[];
      const last = results.at(-1)!;
      assert.equal(last.isError, true, "引用未采用媒体的交付应整体失败");
      deliveryError = JSON.stringify(last.content);
      return fauxAssistantMessage([fauxToolCall("prepare_production", prepareProductionArgs(spec))]);
    },
    context => { prepared = preparedSummary(context); return fauxAssistantMessage("提案已备好，等你确认。"); },
  ]);
  await a.service.sendMessage("local-owner", conversationId, input("把 B 也交付，再准备成片"));
  await done(a, conversationId);

  assert.match(deliveryError, /不能作为产物交付/, "模型看到整批拒绝的真实原因");
  assert.equal(count(a.database, "artifacts"), 2, "整批回滚，无部分交付");
  assert.equal(count(a.database, "request_deliveries"), 1, "只有请求 1 的合法交付");
  assert.equal(prepared.state, "ready", "明确提案可复用同会话已有 blob 与已交付修订");
  assert.equal(a.service.readProposal("local-owner", prepared.proposalId).state, "ready");
  assert.equal(count(a.database, "production_runs"), 0, "确认前零制作");
});

test("T3-15 Pi 链+真实 FFmpeg：正式交付后明确请求 ordered_concat A/B/A，一次确认生成，来源只 A/B 首现序且刷新保持", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-pi-t315-"));
  await makeClip(path.join(directory, "a.mp4"), "red", 12, 1.2);
  await makeClip(path.join(directory, "b.mp4"), "blue", 30, 0.8);
  const clipA = readFileSync(path.join(directory, "a.mp4")), clipB = readFileSync(path.join(directory, "b.mp4"));
  const pexelsFetch: typeof fetch = (async (request) => {
    const target = new URL(String(request));
    if (target.pathname.includes("/videos/search")) return new Response(JSON.stringify({ videos: [
      videoEntry(101, "Red", "a.mp4"), videoEntry(202, "Blue", "b.mp4"), videoEntry(303, "Unused", "c.mp4"),
    ] }), { status: 200 });
    if (target.host === "videos.pexels.com") {
      return new Response(new Uint8Array(target.pathname.endsWith("a.mp4") ? clipA : clipB), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const clock = () => "2026-10-27T00:00:00.000Z";
  const catalog = () => ({ "render:ordered_concat": { binding: null, quoteMinor: 0, priceKind: "bounded" as const, validate: realRenderValidator, probeRenderInputs: true } });
  const runtime = await createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
      name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
      verificationNote: "离线 Faux 文本", isDefault: true }],
    defaultModelId: FAUX_TEXT_MODEL, clock, materials: { stockFetch: pexelsFetch },
    media: { autoStart: false, factory: (db, blobs) => ({
      port: new LocalRenderPort(db, blobs, clock, { workRoot: path.join(directory, "media-work") }),
      catalog, models: () => [],
    }) },
  });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  savePexelsServiceSettings(runtime.database, clock, "local-owner", { commandId: "enable", expectedRevision: 0, enabled: true, apiKey: "key" });
  const conversationId = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "A/B/A" }).conversation.id;

  // 请求 1：搜索（三个候选）→ 只采用 A/B → 正式交付两段；未采用候选 C 不进任何来源。
  runtime.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("search_materials", { query: "road", kind: "video", limit: 5 })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: toolJsons<MaterialSearchResult>(context, "search_materials")[0]!.results[0]!.candidateId })]),
    context => fauxAssistantMessage([fauxToolCall("import_material", { candidateId: toolJsons<MaterialSearchResult>(context, "search_materials")[0]!.results[1]!.candidateId })]),
    context => { const [first, second] = toolJsons<MaterialImportResult>(context, "import_material"); return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
      { mode: "create", title: "片段 A", kind: "video", content: { format: "media_reference", blobId: first!.blobId } },
      { mode: "create", title: "片段 B", kind: "video", content: { format: "media_reference", blobId: second!.blobId } },
    ] })]); },
    fauxAssistantMessage("两段都已交付。"),
  ]);
  await runtime.service.sendMessage("local-owner", conversationId, input("采用前两段并交付"));
  await waitFor(() => count(runtime.database, "requests", `conversation_id='${conversationId}' AND state IN ('queued','running')`) === 0);
  const artifacts = runtime.service.snapshot("local-owner", conversationId).artifacts.items.filter(item => item.kind === "video");
  assert.equal(artifacts.length, 2);
  // 快照列表顺序不等于交付顺序；按标题定位 A/B，spec 冻结的顺序才是断言对象。
  const clipAArtifact = artifacts.find(item => item.title === "片段 A")!, clipBArtifact = artifacts.find(item => item.title === "片段 B")!;
  assert.ok(clipAArtifact && clipBArtifact);
  const clipARevision = runtime.service.readRevision("local-owner", clipAArtifact.id, clipAArtifact.revisionId);
  const clipBRevision = runtime.service.readRevision("local-owner", clipBArtifact.id, clipBArtifact.revisionId);
  assert.deepEqual((clipARevision.content as { sources?: Array<{ assetId: string }> }).sources?.map(source => source.assetId), ["101"]);

  // 请求 2：明确准备 ordered_concat A/B/A，等待用户确认。
  const planWork = seedPlanStageWork(runtime.database, clock(), { ownerId: "local-owner", conversationId }, "A/B/A 成片");
  const renderSpec = (order: Array<{ artifactId: string; revisionId: string; digest: string }>): ProductionIntent => {
    const revisions = order.map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId }));
    const inputs = order.map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest }));
    return {
      workId: planWork.workId, title: "A/B/A 成片",
      inputRevisions: revisions as ProductionIntent["inputRevisions"],
      operations: [{ operationId: "render", outputSlot: "final", kind: "render", model: null,
        inputs: inputs as ProductionIntent["operations"][number]["inputs"],
        maxCreateAttempts: 1,
        parameters: { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 } }],
      finalOutput: { operationId: "render", outputSlot: "final" },
      maxSpend: { currency: "CNY", amountMinor: 0 },
    };
  };
  let prepared!: { proposalId: string; state: string };
  runtime.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("prepare_production", prepareProductionArgs(renderSpec([
      { artifactId: clipAArtifact.id, revisionId: clipAArtifact.revisionId, digest: clipARevision.digest },
      { artifactId: clipBArtifact.id, revisionId: clipBArtifact.revisionId, digest: clipBRevision.digest },
      { artifactId: clipAArtifact.id, revisionId: clipAArtifact.revisionId, digest: clipARevision.digest },
    ])))]),
    context => { prepared = preparedSummary(context); return fauxAssistantMessage("成片提案已备好。"); },
  ]);
  await runtime.service.sendMessage("local-owner", conversationId, input("按 A/B/A 准备成片"));
  await waitFor(() => count(runtime.database, "requests", `conversation_id='${conversationId}' AND state IN ('queued','running')`) === 0);
  assert.equal(prepared.state, "ready");

  // 一次确认 → 唯一 run → 真实 FFmpeg 渲染。
  const proposal = runtime.service.readProposal("local-owner", prepared.proposalId);
  bindPreparedPlan(runtime.database, clock(), { ownerId: "local-owner", conversationId }, proposal, planWork);
  const accepted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
  assert.equal(count(runtime.database, "production_runs"), 1);
  let finished = runtime.service.getRun("local-owner", accepted.run.id);
  for (let i = 0; i < 40 && !["succeeded", "failed", "cancelled"].includes(finished.state); i++) {
    await runtime.worker!.pollOnce();
    finished = runtime.service.getRun("local-owner", accepted.run.id);
  }
  assert.equal(finished.state, "succeeded");
  const output = finished.outputRevisions.at(-1)!;
  const readOutput = () => runtime.service.readRevision("local-owner", output.artifactId, output.revisionId);
  const outputRevision = readOutput();
  assert.equal(outputRevision.content.format, "media");
  if (outputRevision.content.format !== "media") return;
  assert.equal(outputRevision.content.mimeType, "video/mp4");
  const assetIds = outputRevision.content.sources?.map(source => source.assetId);
  assert.deepEqual(assetIds, ["101", "202"], "来源只 A/B，按首次出现顺序去重");
  assert.ok(!JSON.stringify(outputRevision.content.sources).includes("303"), "未采用候选不混入");
  assert.deepEqual(readOutput().content, outputRevision.content, "再次读取（刷新）来源保持");
});
