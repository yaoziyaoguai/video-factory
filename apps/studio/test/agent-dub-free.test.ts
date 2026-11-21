import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import {
  captureEdgeTtsConfig, edgeTtsPythonCommand, readFreeServiceSettings, saveEdgeTtsServiceSettings,
} from "../src/server/agent/free-service-settings.js";
import { systemClock } from "../src/server/agent/util.js";
import {
  insertConversation, insertMessage, insertQueuedRequest, claimNextRequest, emptyReferences, nextSeq,
} from "../src/server/agent/conversation-store.js";
import { getArtifactRow, getRevisionRow, insertRevision } from "../src/server/agent/artifact-store.js";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { validatorFor } from "../src/server/agent/validate.js";
import type { DubFreeResult, EdgeTtsSettings, MediaContent, MediaProvenance, ToolDelivery } from "../src/shared/agent/generated/contracts.js";

// G3-2 免费配音（edge-tts 维护版客户端）：
// - 设置行为（保存/重放/冲突/边界拒绝）与解释器命令的环境变量解析离线验证；
// - 工具链路用“桩解释器 + 真实 FFmpeg 探测”验证（桩只替代外部语音服务，落库/探测/边界映射全部真实）；
// - 真实 edge-tts 调用由 FRAME_EDGE_TTS_PYTHON 门控，未设置时跳过，不假装真实供应商验证。

interface TestCtx { after: (fn: () => Promise<void> | void) => void }

// Node 22 的 node:test 尚无 mock.env：直接改 process.env，测试结束恢复原值。
function useInterpreter(t: TestCtx, command: string | undefined): void {
  const previous = process.env.AGENT_EDGE_TTS_PYTHON;
  if (command === undefined) delete process.env.AGENT_EDGE_TTS_PYTHON;
  else process.env.AGENT_EDGE_TTS_PYTHON = command;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_EDGE_TTS_PYTHON;
    else process.env.AGENT_EDGE_TTS_PYTHON = previous;
  });
}

interface DubFixture {
  db: AgentDatabase;
  directory: string;
  tools: BusinessTools;
  context: (toolCallId: string) => Parameters<BusinessTools["dubFree"]>[0];
}

async function dubFixture(t: TestCtx): Promise<DubFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-dub-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => { if (db.open) db.close(); });
  insertConversation(db, systemClock(), { id: "conv-dub", ownerId: "local-owner", title: "配音", createdSeq: 1, piSessionId: "s-dub" });
  insertMessage(db, systemClock(), {
    id: "msg-dub-1", conversationId: "conv-dub", ownerId: "local-owner", requestId: "req-dub",
    role: "user", kind: "chat", state: "queued", text: "配音", target: null,
    createdSeq: nextSeq(db, "messages", "conv-dub"), references: emptyReferences(),
  });
  insertQueuedRequest(db, systemClock(), {
    id: "req-dub", conversationId: "conv-dub", ownerId: "local-owner", commandId: "cmd-dub",
    text: "配音", target: null, skillId: null, modelId: null, queueSeq: 1, messageId: "msg-dub-1",
  });
  const claimed = claimNextRequest(db, systemClock(), "conv-dub")!;
  const tools = new BusinessTools(db, systemClock, () => ({}), undefined, new ProductionBlobs(db, directory, systemClock));
  const context = (toolCallId: string) => ({
    actorId: "local-owner", conversationId: "conv-dub", requestId: "req-dub",
    executionEpoch: claimed.epoch, target: null, toolCallId,
  }) as Parameters<BusinessTools["dubFree"]>[0];
  return { db, directory, tools, context };
}

function smallMp3(): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
    "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"]);
}

async function rejection(action: () => Promise<unknown>): Promise<any> {
  try { await action(); } catch (error) { return error; }
  assert.fail("应当被拒绝");
}

// 桩解释器：与真 python 客户端同形（stdin JSON → stdout JSON / stderr+非零退出），
// 并把收到的请求原样写到 requestFile 供断言 voice/rate 透传。
async function writeStubInterpreter(
  directory: string, requestFile: string,
  payload: { audioB64: string; boundaries: unknown[] } | { failStderr: string; failCode: number },
): Promise<string> {
  const file = path.join(directory, `stub-${path.basename(requestFile, ".json")}.mjs`);
  const action = "failStderr" in payload
    ? `process.stderr.write(${JSON.stringify(payload.failStderr)}); process.exit(${payload.failCode});`
    : `process.stdout.write(JSON.stringify({ audioB64: ${JSON.stringify(payload.audioB64)}, boundaries: ${JSON.stringify(payload.boundaries)} }));`;
  await writeFile(file, `#!/usr/bin/env node
const fs = await import("node:fs");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, Buffer.concat(chunks));
  ${action}
});
`, { mode: 0o755 });
  return file;
}

test("G3-2 设置：默认缺省、非法形状拒绝、保存/重放/冲突（零网络）", async t => {
  const a = await dubFixture(t);
  useInterpreter(t, undefined);
  // 未配置：默认投影恒带语音，捕获为 null（工具据此报 CAPABILITY_UNAVAILABLE）；解释器命令不进读取形状。
  const initial = readFreeServiceSettings(a.db, "edge-tts") as EdgeTtsSettings;
  assert.deepEqual([initial.serviceId, initial.revision, initial.enabled, initial.voice],
    ["edge-tts", 0, false, "zh-CN-XiaoxiaoNeural"]);
  assert.equal("pythonCommand" in initial, false, "读取形状不应再携带解释器命令");
  assert.equal(captureEdgeTtsConfig(a.db), null);

  // 语音形状由契约在边界拒绝（FreeServiceId 分发先于本测试存在前，非法语音根本无法保存）
  await assert.rejects(async () => saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-dub-1", expectedRevision: 0, enabled: true, voice: "随便一个声音",
  }), (error: any) => error.code === "INVALID_INPUT");

  const saved = saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-dub-1", expectedRevision: 0, enabled: true, voice: "zh-CN-YunxiNeural",
  });
  assert.equal(saved.replayed, false);
  assert.deepEqual(saved.settings, {
    serviceId: "edge-tts", revision: 1, enabled: true, voice: "zh-CN-YunxiNeural",
  } satisfies EdgeTtsSettings);
  // 解释器命令来自服务端环境变量：未设置时落到镜像 PATH 缺省 python3。
  assert.deepEqual(captureEdgeTtsConfig(a.db), { enabled: true, voice: "zh-CN-YunxiNeural", pythonCommand: "python3" });

  // 同命令同体幂等重放：不递增 revision
  const replay = saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-dub-1", expectedRevision: 0, enabled: true, voice: "zh-CN-YunxiNeural",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.settings.revision, 1);

  // 旧 revision 保存冲突
  await assert.rejects(async () => saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-dub-2", expectedRevision: 0, enabled: false, voice: "zh-CN-YunxiNeural",
  }), (error: any) => error.code === "STALE_REVISION");

  // 停用后捕获为 null，但配置保留
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-dub-3", expectedRevision: 1, enabled: false, voice: "zh-CN-YunxiNeural",
  });
  assert.equal(captureEdgeTtsConfig(a.db), null);
  assert.equal((readFreeServiceSettings(a.db, "edge-tts") as EdgeTtsSettings).voice, "zh-CN-YunxiNeural");
});

test("G3-2 解释器命令：只认服务端环境变量，控制字符拒绝", async t => {
  useInterpreter(t, undefined);
  assert.equal(edgeTtsPythonCommand(), "python3", "未设置时用镜像 PATH 缺省");
  assert.equal(edgeTtsPythonCommand({ AGENT_EDGE_TTS_PYTHON: " /opt/frame-tts/bin/python3 " }), "/opt/frame-tts/bin/python3", "去除首尾空白");
  assert.throws(() => edgeTtsPythonCommand({ AGENT_EDGE_TTS_PYTHON: "python3\n-c bad" }), /控制字符/);
  const a = await dubFixture(t);
  useInterpreter(t, "/opt/venv/bin/python3");
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-env", expectedRevision: 0, enabled: true, voice: "zh-CN-YunxiNeural",
  });
  assert.equal(captureEdgeTtsConfig(a.db)?.pythonCommand, "/opt/venv/bin/python3", "捕获时按当前环境解析");
});

test("DF44 Edge TTS 配置 GET/PATCH 与 OpenAPI 路径一致", async t => {
  const network = t.mock.method(globalThis, "fetch", async () => assert.fail("设置读写不应联网"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-edge-settings-"));
  const uiOrigin = "http://127.0.0.1:4500";
  const { app, close } = await assembleOfflineAgent({ dataDir, uiOrigin });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = "/api/agent/v1/settings/services/edge-tts";
  const initial = await app.inject({ method: "GET", url });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), {
    serviceId: "edge-tts", revision: 0, enabled: false, voice: "zh-CN-XiaoxiaoNeural",
  } satisfies EdgeTtsSettings);

  const saved = await app.inject({
    method: "PATCH", url, headers: { "content-type": "application/json", origin: uiOrigin, "x-video-factory-request": "studio" },
    payload: { commandId: "edge-settings-df44", expectedRevision: 0, enabled: true, voice: "zh-CN-YunxiNeural" },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(validatorFor("SaveFreeServiceSettingsReceipt")(saved.json()).ok, true);
  const settings = { serviceId: "edge-tts", revision: 1, enabled: true, voice: "zh-CN-YunxiNeural" } satisfies EdgeTtsSettings;
  assert.deepEqual(saved.json(), { replayed: false, settings });

  const reread = await app.inject({ method: "GET", url });
  assert.equal(reread.statusCode, 200);
  assert.equal(validatorFor("FreeServiceSettings")(reread.json()).ok, true);
  assert.deepEqual(reread.json(), settings);
  assert.equal(network.mock.callCount(), 0);
  t.diagnostic(`GET ${initial.statusCode} revision=${initial.json().revision}; PATCH ${saved.statusCode}; GET ${reread.statusCode} revision=${reread.json().revision}; fetch=0`);

  const openapi = JSON.parse(await readFile(new URL("../../../contracts/agent/v1/openapi.json", import.meta.url), "utf8"));
  for (const method of ["get", "patch"] as const) {
    const serviceId = openapi.paths["/settings/services/{serviceId}"][method].parameters.find(
      (parameter: { in: string; name: string }) => parameter.in === "path" && parameter.name === "serviceId",
    );
    assert.ok(serviceId?.schema.enum.includes("edge-tts"), `${method.toUpperCase()} serviceId 包含 edge-tts`);
  }
});

test("G3-2 工具：桩配音生成→正式交付→read_artifact 保留同字节准确修订的元数据", async t => {
  const a = await dubFixture(t);
  const gated = await rejection(() => a.tools.dubFree(a.context("call-1"), { text: "你好" }));
  assert.equal(gated.code, "CAPABILITY_UNAVAILABLE");
  assert.ok(gated.message.includes("免费服务 → 配音"));

  const requestFile = path.join(a.directory, "stub-request-1.json");
  const boundaries = [
    { text: "你好", offsetMs: 0, durationMs: 240 },
    { text: "世界", offsetMs: 240, durationMs: 250 },
  ];
  const audio = smallMp3();
  const stub = await writeStubInterpreter(a.directory, requestFile,
    { audioB64: audio.toString("base64"), boundaries });
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-stub", expectedRevision: 0, enabled: true, voice: "zh-CN-XiaoxiaoNeural",
  });
  // 桩解释器经服务端环境变量注入：设置不再携带可写的解释器命令。
  useInterpreter(t, stub);

  const result: DubFreeResult = await a.tools.dubFree(a.context("call-2"), { text: "你好世界" });
  assert.equal(result.granularity, "word");
  assert.equal(result.boundaryCount, 2);
  assert.equal(result.voice, "zh-CN-XiaoxiaoNeural");
  assert.equal(result.rate, "+0%");
  // 时长来自真实解码，不是桩的口头声明
  assert.ok(result.durationMs >= 250 && result.durationMs <= 400, `探测时长异常：${result.durationMs}`);

  // 桩收到的正是发送形状（文本/语音/语速），无额外字段
  assert.deepEqual(JSON.parse(await readFile(requestFile, "utf8")), { text: "你好世界", voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" });

  // 落库事实：audio 工件 + 修订内嵌 dub 元数据 + blob 关联与时长
  const artifact = a.db.prepare("SELECT * FROM artifacts WHERE id=?").get(result.artifactId) as { kind: string; conversation_id: string };
  assert.deepEqual([artifact.kind, artifact.conversation_id], ["audio", "conv-dub"]);
  const revision = getRevisionRow(a.db, result.artifactId, result.revisionId)!;
  const content = JSON.parse(revision.content_json) as MediaContent;
  assert.equal(content.format, "media");
  assert.equal(content.mimeType, "audio/mpeg");
  assert.equal(content.durationMs, result.durationMs);
  assert.deepEqual(content.dub, { text: "你好世界", voice: "zh-CN-XiaoxiaoNeural", rate: "+0%", granularity: "word", boundaries });
  const blob = a.db.prepare("SELECT * FROM production_blobs WHERE id=?").get(content.blobId) as { duration_ms: number; mime_type: string };
  assert.deepEqual([blob.mime_type, blob.duration_ms], ["audio/mpeg", result.durationMs]);

  // 显式 voice/rate 透传到客户端
  const requestFile2 = path.join(a.directory, "stub-request-2.json");
  const stub2 = await writeStubInterpreter(a.directory, requestFile2,
    { audioB64: audio.toString("base64"), boundaries: [] });
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-stub-2", expectedRevision: 1, enabled: true, voice: "zh-CN-XiaoxiaoNeural",
  });
  useInterpreter(t, stub2);
  const override = await a.tools.dubFree(a.context("call-3"), { text: "Hello", voice: "en-US-AriaNeural", rate: "+10%" });
  assert.deepEqual(JSON.parse(await readFile(requestFile2, "utf8")), { text: "Hello", voice: "en-US-AriaNeural", rate: "+10%" });
  assert.equal(override.granularity, "none");
  assert.equal(override.boundaryCount, 0);
  const overrideContent = (await a.tools.readArtifact(a.context("read-override"), override)).content;
  assert.equal(overrideContent.format, "media");
  if (overrideContent.format !== "media") assert.fail("配音应为媒体修订");
  assert.equal(overrideContent.blobId, content.blobId, "桩返回同一字节，不同修订的台词仍只能按准确修订读取");

  // 合成来源夹具：只模拟已有修订记录，不声称执行过 Wikimedia 下载。
  const sources: MediaProvenance[] = [{ provider: "wikimedia", assetId: "synthetic-dub-source",
    sourceUrl: "https://example.org/synthetic-audio", creatorName: "合成来源夹具", creatorUrl: null,
    licenseUrl: "https://example.org/license", acquiredAt: systemClock() }];
  const sourcedContent: MediaContent = { ...content, sources };
  const sourced = insertRevision(a.db, systemClock(), getArtifactRow(a.db, "local-owner", result.artifactId)!, result.revisionId,
    { title: "带已有来源记录的配音", kind: "audio", content: sourcedContent }, "req-dub");
  const bareContent: MediaContent = { format: "media", blobId: content.blobId, mimeType: content.mimeType, durationMs: content.durationMs };
  const bare = insertRevision(a.db, systemClock(), getArtifactRow(a.db, "local-owner", result.artifactId)!, sourced.id,
    { title: "未记录配音信息的同字节媒体", kind: "audio", content: bareContent }, "req-dub");
  const references = [{ artifactId: result.artifactId, revisionId: sourced.id }, result, override,
    { artifactId: result.artifactId, revisionId: bare.id }];
  const receipt = await a.tools.deliverArtifacts(a.context("deliver-audio"), {
    items: references.map((source, index) => ({ mode: "create" as const, title: `正式配音 ${index + 1}`, kind: "audio" as const,
      content: { format: "local_output" as const, source: { kind: "artifact_revision" as const, artifactId: source.artifactId, revisionId: source.revisionId } } })) as ToolDelivery["items"],
  });
  assert.equal(receipt.revisions.length, 4);
  const expectedContents = [sourcedContent, content, overrideContent, bareContent];
  for (const [index, ref] of receipt.revisions.entries()) {
    const delivered = await a.tools.readArtifact(a.context(`read-delivered-${index}`), ref);
    assert.deepEqual({ artifactId: delivered.artifactId, revisionId: delivered.revisionId }, ref, "read_artifact 返回准确交付修订");
    assert.deepEqual(delivered.content, expectedContents[index], "同字节交付应转交准确来源修订的 dub/sources，不借用其他同 blob 修订");
    assert.ok(a.db.prepare("SELECT 1 FROM revision_blob_links WHERE revision_id=? AND blob_id=?").get(ref.revisionId, content.blobId));
  }
  assert.deepEqual((await a.tools.readArtifact(a.context("read-original"), result)).content, content, "旧配音修订不回填来源或改写台词");
  const blobs = new ProductionBlobs(a.db, a.directory, systemClock);
  assert.deepEqual(await readFile(blobs.filePath(blobs.get("local-owner", content.blobId).digest)), audio, "正式交付仍使用原音频字节");
});

test("G3-2 工具：客户端失败原样透传真实原因，不落任何工件；坏音频被解码拒绝", async t => {
  const a = await dubFixture(t);
  const requestFile = path.join(a.directory, "stub-request-fail.json");
  const stub = await writeStubInterpreter(a.directory, requestFile, {
    failStderr: "Traceback (most recent call last):\n  ...\nedge_tts.exceptions.NoAudioReceived: 没有收到音频数据\n", failCode: 3,
  });
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-fail", expectedRevision: 0, enabled: true, voice: "zh-CN-XiaoxiaoNeural",
  });
  useInterpreter(t, stub);
  const failure = await rejection(() => a.tools.dubFree(a.context("call-1"), { text: "你好" }));
  assert.equal(failure.code, "TEMPORARILY_UNAVAILABLE");
  assert.ok(failure.message.includes("NoAudioReceived"), `应包含真实原因：${failure.message}`);
  assert.equal((a.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n, 0);
  assert.equal((a.db.prepare("SELECT COUNT(*) AS n FROM production_blobs").get() as { n: number }).n, 0);

  // 空音频：解码层拒绝，不给“看起来成功”的空工件
  const emptyAudioStub = await writeStubInterpreter(a.directory, path.join(a.directory, "stub-request-empty.json"),
    { audioB64: Buffer.alloc(0).toString("base64"), boundaries: [] });
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-empty", expectedRevision: 1, enabled: true, voice: "zh-CN-XiaoxiaoNeural",
  });
  useInterpreter(t, emptyAudioStub);
  const empty = await rejection(() => a.tools.dubFree(a.context("call-2"), { text: "你好" }));
  assert.equal(empty.code, "TEMPORARILY_UNAVAILABLE");
  assert.ok(empty.message.includes("没有返回音频数据"));
  assert.equal((a.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n, 0);
});

test("G3-2 真实 edge-tts 调用：词级边界递增且落在真实时长内（FRAME_EDGE_TTS_PYTHON 门控）", async t => {
  const python = process.env.FRAME_EDGE_TTS_PYTHON;
  if (!python) { t.skip("未设置 FRAME_EDGE_TTS_PYTHON，跳过真实调用（离线桩链路已覆盖其余行为）"); return; }
  const a = await dubFixture(t);
  saveEdgeTtsServiceSettings(a.db, systemClock, "local-owner", {
    commandId: "cmd-real", expectedRevision: 0, enabled: true, voice: "zh-CN-XiaoxiaoNeural",
  });
  useInterpreter(t, python);
  const result = await a.tools.dubFree(a.context("call-real"), { text: "今天天气很好，适合出门散步。" });
  assert.equal(result.granularity, "word");
  // 真实探测：该句返回 7 个词边界（标点不产生事件）；阈值只证明是词级而非句级/整段。
  assert.ok(result.boundaryCount >= 5, `短句词边界数量异常：${result.boundaryCount}`);
  const revision = getRevisionRow(a.db, result.artifactId, result.revisionId)!;
  const content = JSON.parse(revision.content_json) as MediaContent;
  assert.equal(content.dub!.boundaries.length, result.boundaryCount);
  // 边界关联原文：词文本拼接应还原去掉标点的原句。
  assert.equal(content.dub!.boundaries.map(boundary => boundary.text).join(""), "今天天气很好适合出门散步");
  let previousOffset = -1;
  for (const boundary of content.dub!.boundaries) {
    assert.ok(boundary.offsetMs >= previousOffset, `边界 offset 应单调不减：${boundary.offsetMs} < ${previousOffset}`);
    previousOffset = boundary.offsetMs;
  }
  const last = content.dub!.boundaries[content.dub!.boundaries.length - 1]!;
  assert.ok(last.offsetMs + last.durationMs <= result.durationMs + 500,
    `末边界超出真实时长：${last.offsetMs + last.durationMs} > ${result.durationMs}`);
  assert.ok(result.durationMs > 1000 && result.durationMs < 30_000, `真实时长异常：${result.durationMs}`);
});
