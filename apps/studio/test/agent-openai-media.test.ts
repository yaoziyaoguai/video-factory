import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import { ImageGenerationPort } from "../src/server/agent/image-generation.js";
import { OpenAISpeechPort } from "../src/server/agent/openai-speech.js";
import { ArkMediaPort, RealMediaGateway } from "../src/server/agent/ark-media.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { imageBinding, openaiImageProfile, openaiSpeechBinding, openaiSpeechProfile } from "../src/server/agent/media-config.js";
import { additionalMediaCatalog, resolveImageBinding } from "../src/server/agent/additional-media-settings.js";
import { initializeProviderConnections, saveProviderConnection } from "../src/server/agent/provider-connections.js";
import { initializeTextModelSettings } from "../src/server/agent/text-model-settings.js";
import { resolveArkBinding } from "../src/server/agent/ark-video-settings.js";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { issueSubmitPermit } from "../src/server/agent/submit-permit.js";
import { attemptOutput } from "../src/server/agent/production-store.js";
import { FakeRealtimeHub } from "./helpers/agent-openai-media.js";
import type { ExecutionInput, ModelBinding, OperationSpec, RecoveryQuery } from "../src/shared/agent/generated/contracts.js";

// B1/B2 OpenAI 图片与配音端口的执行语义逐项验证：冻结 payload、三分终态（明确拒绝/failed/
// unknown/cancelled）、signal 语义、转写不符不发布 blob、无 task ID 的本地收据恢复、零自动重发。
// 图片走本地 HTTP 桩（成品是本地 ffmpeg 生成的真实 PNG/JPEG，经端口自身探测验收）；配音走
// FakeRealtimeHub 进程内对演（PCM 经端口自身真实 FFmpeg 转 MP3 再探测）。全程不触真实外网。

const runCommand = promisify(execFile);
const staticClock = () => "2026-10-31T00:00:00.000Z";
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const IMAGE_MODEL = "gpt-image-2.5-flare";
const SPEECH_MODEL = "gpt-realtime-2.1-mini";
const IMAGE_PROMPT = "雪山下笔直的公路";
const SPEECH_TEXT = "欢迎收看本期节目。";

async function makeFrame(name: string, args: string[]): Promise<Buffer> {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-media-art-"));
  try {
    const file = path.join(directory, name);
    await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2b6cb0:s=1536x864", "-frames:v", "1", ...args, file]);
    return readFileSync(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface ImageStub {
  server: http.Server;
  baseUrl: string;
  posts: { url: string; auth: string | undefined; body: any }[];
}

type ImageStubMode = "ok" | "okSmall" | "okJpeg" | "multi" | "badB64" | "status400" | "status500" | "hang";

async function startImageStub(mode: ImageStubMode, goodPng: Buffer, smallPng: Buffer, jpeg: Buffer): Promise<ImageStub> {
  const posts: ImageStub["posts"] = [];
  const server = http.createServer((request, response) => {
    const entry = { url: request.url ?? "", auth: request.headers.authorization, body: null as unknown };
    posts.push(entry);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const imageOf = (bytes: Buffer) => ({ b64_json: bytes.toString("base64") });
      if (mode === "hang") return; // 请求已受理但永不响应
      if (mode === "status400" || mode === "status500") {
        response.writeHead(mode === "status400" ? 400 : 500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "stub failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (mode === "multi") { response.end(JSON.stringify({ data: [imageOf(goodPng), imageOf(goodPng)] })); return; }
      if (mode === "badB64") { response.end(JSON.stringify({ data: [{ b64_json: "###not-base64###" }] })); return; }
      const bytes = mode === "okSmall" ? smallPng : mode === "okJpeg" ? jpeg : goodPng;
      response.end(JSON.stringify({ data: [imageOf(bytes)] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`, posts };
}

// 最小运行事实：会话/事项/快照/提案/运行/操作/尝试各一行，仅满足端口读写的外键与联查。
function seedProviderAttempt(db: AgentDatabase, operation: OperationSpec, binding: ModelBinding): { input: ExecutionInput; query: Extract<RecoveryQuery, { kind: "provider" }> } {
  const time = staticClock();
  db.transaction(() => {
    db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conversation','owner','端口级',1,'s1',?,?)").run(time, time);
    db.prepare("INSERT INTO works(id,owner_id,conversation_id) VALUES('work','owner','conversation')").run();
    db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('snapshot','{}','digest-snapshot',?)").run(time);
    db.prepare("INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,created_seq,created_at,updated_at) VALUES('proposal','conversation','owner','digest-proposal','{}','ready','公开',?,1,?,?)").run(time, time, time);
    db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,created_seq,created_at,updated_at) VALUES('run','owner','conversation','work','snapshot','proposal','端口级','running',1,?,?)").run(time, time);
    db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state) VALUES('run',?,?,'pending')").run(operation.operationId, JSON.stringify(operation));
    db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES('attempt','run',?,1,'request-1','submit_started','running',0)").run(operation.operationId);
  })();
  return {
    input: { runId: "run", snapshotId: "snapshot", operationId: operation.operationId, attemptId: "attempt", requestIdentity: "request-1", operation, resolvedInputs: [] },
    query: { runId: "run", operationId: operation.operationId, attemptId: "attempt", requestIdentity: "request-1", providerTaskId: null, accountBinding: binding, kind: "provider" },
  };
}

function imageOperation(binding: ModelBinding): Extract<OperationSpec, { kind: "image" }> {
  return {
    operationId: "op-image", outputSlot: "still", inputs: [{ kind: "text", text: IMAGE_PROMPT }],
    maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 13 }, priceKind: "estimate",
    kind: "image", model: binding, parameters: { aspectRatio: "16:9", resolution: "1536x864" },
  };
}

function speechOperation(binding: ModelBinding): OperationSpec {
  return {
    operationId: "op-speech", outputSlot: "narration", inputs: [{ kind: "text", text: SPEECH_TEXT }],
    maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 35 }, priceKind: "estimate",
    kind: "speech", model: binding, parameters: { voiceId: "marin", format: "mp3" },
  };
}

async function imageCase(t: { after: (fn: () => Promise<void> | void) => void }, mode: ImageStubMode, art: { goodPng: Buffer; smallPng: Buffer; jpeg: Buffer },
  policy: "ok" | "drift" | "no-key" = "ok") {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-image-port-"));
  const stub = await startImageStub(mode, art.goodPng, art.smallPng, art.jpeg);
  t.after(async () => {
    stub.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => stub.server.close(error => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  });
  const db = openAgentDatabase(directory);
  t.after(() => { db.close(); });
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const profile = openaiImageProfile(IMAGE_MODEL, stub.baseUrl);
  const binding = imageBinding(profile, "conn-image");
  const resolve: () => { profile: typeof profile; apiKey: string | null } | null
    = policy === "ok" ? () => ({ profile, apiKey: "sk-image" }) : policy === "drift" ? () => null : () => ({ profile, apiKey: null });
  const port = new ImageGenerationPort(db, blobs, staticClock, { resolve, workRoot: path.join(directory, "work") });
  const { input, query } = seedProviderAttempt(db, imageOperation(binding), binding);
  return { db, blobs, port, input, query, stub, directory, binding, profile };
}

type SpeechResolve = (binding: ModelBinding) => { profile: ReturnType<typeof openaiSpeechProfile>; apiKey: string | null } | null;

async function speechCase(t: { after: (fn: () => Promise<void> | void) => void }, hub: FakeRealtimeHub,
  options: { resolve?: SpeechResolve; sessionTimeoutMs?: number; ffmpegPath?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-speech-port-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openAgentDatabase(directory);
  t.after(() => { db.close(); });
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const profile = openaiSpeechProfile(SPEECH_MODEL, "https://api.openai.com/v1");
  const binding = openaiSpeechBinding(profile, "conn-speech");
  const port = new OpenAISpeechPort(db, blobs, staticClock, {
    resolve: options.resolve ?? (() => ({ profile, apiKey: "sk-speech" })),
    workRoot: path.join(directory, "work"),
    transportFactory: hub.factory,
    ...(options.sessionTimeoutMs !== undefined ? { sessionTimeoutMs: options.sessionTimeoutMs } : {}),
    ...(options.ffmpegPath !== undefined ? { ffmpegPath: options.ffmpegPath } : {}),
  });
  const { input, query } = seedProviderAttempt(db, speechOperation(binding), binding);
  return { db, blobs, port, input, query, hub, directory, binding, profile };
}

const blobCount = (db: AgentDatabase): number => (db.prepare("SELECT COUNT(*) AS n FROM production_blobs").get() as { n: number }).n;

// —— 图片端口 ——

it("Seedream 从共用连接报价，用冻结的型号和规格生成单张 JPEG，切走后仍能回读", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-seedream-"));
  const db = openAgentDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  initializeTextModelSettings(db, staticClock);
  initializeProviderConnections(db, []);
  const connection = { id: "test-ark", name: "方舟", protocol: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "test-key", enabled: true, models: [{ id: "flash", kind: "image", name: "Seedream Flash", modelId: "doubao-seedream-5-0-flash-260915",
      features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: true }] };
  saveProviderConnection(db, staticClock, "owner", { commandId: "choose", expectedRevision: 0, connection });
  const key = "image:" + connection.models[0]!.modelId;
  const quote = additionalMediaCatalog(db, true)[key]!;
  assert.equal(quote.quoteMinor, 12);
  const binding = quote.binding!;
  saveProviderConnection(db, staticClock, "owner", { commandId: "remove", expectedRevision: 1, connection: { ...connection, models: [] } });
  assert.equal(additionalMediaCatalog(db, true)[key], undefined);
  const op = imageOperation(binding);
  op.parameters.resolution = "2560x1440";
  op.quotePerAttempt.amountMinor = quote.quoteMinor;
  const { input, query } = seedProviderAttempt(db, op, binding);
  const jpeg = await makeFrame("frame.jpg", ["-vf", "scale=2560:1440", "-q:v", "2"]);
  const blobs = new ProductionBlobs(db, dir, staticClock);
  const port = new ImageGenerationPort(db, blobs, staticClock, {
    resolve: model => resolveImageBinding(db, model), workRoot: dir,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), connection.baseUrl + "/images/generations");
      assert.deepEqual(JSON.parse(String(init!.body)), { model: binding.modelId, prompt: IMAGE_PROMPT, size: "2560x1440",
        response_format: "b64_json", output_format: "jpeg", watermark: true });
      return Response.json({ data: [{ b64_json: jpeg.toString("base64") }] });
    },
  });
  const result = await port.submit(input, issueSubmitPermit("attempt", 1));
  assert.equal(result.blob?.mimeType, "image/jpeg", result.message ?? "");
  assert.deepEqual((await port.query(query)).blob, result.blob);
});

it("image: 请求体冻结为单图 low PNG，成功解码验收并登记 blob", async t => {
  const goodPng = await makeFrame("good.png", []);
  const smallPng = await makeFrame("small.png", ["-vf", "scale=640:360"]);
  const jpeg = await makeFrame("frame.jpg", ["-q:v", "2"]);
  const { db, port, input, stub, directory } = await imageCase(t, "ok", { goodPng, smallPng, jpeg });

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "succeeded");
  assert.equal(observation.billing, null);
  assert.equal(observation.blob?.mimeType, "image/png");
  assert.equal(stub.posts.length, 1);
  const post = stub.posts[0]!;
  assert.equal(post.url, "/v1/images/generations");
  assert.equal(post.auth, "Bearer sk-image");
  // 冻结 payload：恰这六个键，无 response_format 等旧字段。
  assert.deepEqual(post.body, { model: IMAGE_MODEL, prompt: IMAGE_PROMPT, n: 1, size: "1536x864", quality: "low", output_format: "png" });
  const receipt = attemptOutput(db, "attempt");
  assert.equal(receipt?.blob_id, observation.blob?.id);
  assert.equal(receipt?.digest, observation.blob?.digest);
  assert.ok(existsSync(path.join(directory, "work", "attempt", "image.png")));
  assert.ok(!existsSync(path.join(directory, "work", "attempt", "image.part")));
});

it("image: 4xx 是明确拒绝 → failed 收据，单次请求", async t => {
  const art = { goodPng: Buffer.alloc(0), smallPng: Buffer.alloc(0), jpeg: Buffer.alloc(0) };
  const { db, port, input, stub, directory } = await imageCase(t, "status400", art);

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "failed");
  assert.match(observation.message ?? "", /供应商明确拒绝创建图片：HTTP 400/);
  assert.equal(attemptOutput(db, "attempt")?.exit_kind, "failed");
  assert.equal(stub.posts.length, 1);
  assert.ok(!existsSync(path.join(directory, "work", "attempt")));
});

it("image: 5xx 无法证明未受理 → unknown，不写收据、零重试", async t => {
  const art = { goodPng: Buffer.alloc(0), smallPng: Buffer.alloc(0), jpeg: Buffer.alloc(0) };
  const { db, port, input, stub } = await imageCase(t, "status500", art);

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "unknown");
  assert.match(observation.message ?? "", /未核实/);
  assert.equal(attemptOutput(db, "attempt"), undefined);
  assert.equal(stub.posts.length, 1);
});

it("image: 请求发出后本地停止 → unknown；发出前停止 → cancelled 且零请求", async t => {
  const art = { goodPng: await makeFrame("good.png", []), smallPng: Buffer.alloc(0), jpeg: Buffer.alloc(0) };
  const hang = await imageCase(t, "hang", art);
  const controller = new AbortController();
  const pending = hang.port.submit(hang.input, issueSubmitPermit("attempt", 1), controller.signal);
  await sleep(50);
  controller.abort();
  const midStop = await pending;
  assert.equal(midStop.state, "unknown");
  assert.match(midStop.message ?? "", /请求已发出后本地停止/);
  assert.equal(hang.stub.posts.length, 1);
  assert.equal(attemptOutput(hang.db, "attempt"), undefined);

  const early = await imageCase(t, "hang", art);
  const before = new AbortController();
  before.abort();
  const observation = await early.port.submit(early.input, issueSubmitPermit("attempt", 1), before.signal);
  assert.equal(observation.state, "cancelled");
  assert.match(observation.message ?? "", /停止请求发生在请求发出之前/);
  assert.equal(early.stub.posts.length, 0);
});

it("image: 多图、坏 base64、错画幅、非 PNG 都是确定 failed，不发布 blob", async t => {
  const goodPng = await makeFrame("good.png", []);
  const smallPng = await makeFrame("small.png", ["-vf", "scale=640:360"]);
  const jpeg = await makeFrame("frame.jpg", ["-q:v", "2"]);
    for (const [mode, pattern] of [
    ["multi", /返回 2 张图片，与单图合同不符/],
    ["badB64", /不是有效的 base64/],
    ["okSmall", /画幅 640x360 与冻结参数 1536x864 不符/],
    ["okJpeg", /输出不是 PNG 单图/],
  ] as const) {
    const seeded = await imageCase(t, mode, { goodPng, smallPng, jpeg });
    const observation = await seeded.port.submit(seeded.input, issueSubmitPermit("attempt", 1));
    assert.equal(observation.state, "failed", mode);
    assert.match(observation.message ?? "", pattern);
    assert.equal(attemptOutput(seeded.db, "attempt")?.exit_kind, "failed");
    assert.equal(blobCount(seeded.db), 0, mode);
  }
});

it("image: 绑定漂移与凭据未启用是提交前失败", async t => {
  const art = { goodPng: Buffer.alloc(0), smallPng: Buffer.alloc(0), jpeg: Buffer.alloc(0) };
  const drift = await imageCase(t, "ok", art, "drift");
  const driftObservation = await drift.port.submit(drift.input, issueSubmitPermit("attempt", 1));
  assert.equal(driftObservation.state, "failed");
  assert.match(driftObservation.message ?? "", /账号配置已变化/);
  assert.equal(drift.stub.posts.length, 0);

  const noKey = await imageCase(t, "ok", art, "no-key");
  const keyObservation = await noKey.port.submit(noKey.input, issueSubmitPermit("attempt", 1));
  assert.equal(keyObservation.state, "failed");
  assert.match(keyObservation.message ?? "", /图片凭据未启用/);
  assert.equal(noKey.stub.posts.length, 0);
});

it("image: 连接阶段失败（请求从未写出）是确定 failed；其余网络失败仍 unknown", async t => {
  const caseFor = async (code: string): Promise<{ port: ImageGenerationPort; input: ExecutionInput }> => {
    const directory = await mkdtemp(path.join(tmpdir(), "openai-image-connect-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const db = openAgentDatabase(directory);
    t.after(() => { db.close(); });
    const blobs = new ProductionBlobs(db, directory, staticClock);
    const profile = openaiImageProfile(IMAGE_MODEL, "https://api.openai.com/v1");
    const binding = imageBinding(profile, "conn-image");
    const port = new ImageGenerationPort(db, blobs, staticClock, {
      resolve: () => ({ profile, apiKey: "sk-image" }), workRoot: path.join(directory, "work"),
      fetchImpl: (() => {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });
        return Promise.reject(error);
      }) as typeof fetch,
    });
    const { input } = seedProviderAttempt(db, imageOperation(binding), binding);
    return { port, input };
  };

  const refused = await caseFor("ECONNREFUSED");
  const refusedObservation = await refused.port.submit(refused.input, issueSubmitPermit("attempt", 1));
  assert.equal(refusedObservation.state, "failed");
  assert.match(refusedObservation.message ?? "", /图片创建请求未发出（ECONNREFUSED）；供应商未收到任何生成指令/);

  const reset = await caseFor("ECONNRESET"); // 不在可证明“未写出”的码集内：仍按未知处理
  const resetObservation = await reset.port.submit(reset.input, issueSubmitPermit("attempt", 1));
  assert.equal(resetObservation.state, "unknown");
  assert.match(resetObservation.message ?? "", /结果未核实/);
});

it("image: query 复用成功收据；收据缺失但有完成文件时重验补发布且只发布一次", async t => {
  const goodPng = await makeFrame("good.png", []);
  const smallPng = Buffer.alloc(0);
  const jpeg = Buffer.alloc(0);
    const seeded = await imageCase(t, "ok", { goodPng, smallPng, jpeg });
  const submitted = await seeded.port.submit(seeded.input, issueSubmitPermit("attempt", 1));
  const afterSubmit = blobCount(seeded.db);

  // 收据仍在：query/cancel 都直接复用同一 blob，不产生新事实。
  const queried = await seeded.port.query(seeded.query);
  assert.equal(queried.state, "succeeded");
  assert.equal(queried.blob?.id, submitted.blob?.id);
  const cancelled = await seeded.port.cancel(seeded.query);
  assert.equal(cancelled.state, "succeeded");
  assert.equal(cancelled.observationId, queried.observationId);
  assert.equal(blobCount(seeded.db), afterSubmit);

  // 落盘与登记之间中断：删除收据，完成文件仍在 → 按冻结参数重验后补收据（同字节同 blob）。
  seeded.db.prepare("DELETE FROM production_attempt_outputs WHERE attempt_id='attempt'").run();
  const recovered = await seeded.port.query(seeded.query);
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.blob?.id, submitted.blob?.id);
  assert.equal(attemptOutput(seeded.db, "attempt")?.blob_id, submitted.blob?.id);
  assert.equal(blobCount(seeded.db), afterSubmit);
});

it("image: query 对失败收据复读终态，对部分文件与无证据稳定 unknown", async t => {
  const art = { goodPng: Buffer.alloc(0), smallPng: Buffer.alloc(0), jpeg: Buffer.alloc(0) };
  const rejected = await imageCase(t, "status400", art);
  await rejected.port.submit(rejected.input, issueSubmitPermit("attempt", 1));
  const failed = await rejected.port.query(rejected.query);
  assert.equal(failed.state, "failed");
  assert.match(failed.message ?? "", /HTTP 400/);

  const partial = await imageCase(t, "ok", art);
  mkdirSync(path.join(partial.directory, "work", "attempt"), { recursive: true });
  writeFileSync(path.join(partial.directory, "work", "attempt", "image.part"), Buffer.from("partial"));
  const partialObservation = await partial.port.query(partial.query);
  assert.equal(partialObservation.state, "unknown");
  assert.match(partialObservation.message ?? "", /只取得部分响应文件/);

  const empty = await imageCase(t, "ok", art);
  const none = await empty.port.query(empty.query);
  assert.equal(none.state, "unknown");
  assert.match(none.message ?? "", /没有可查询的任务身份/);
  const again = await empty.port.query(empty.query);
  assert.equal(again.observationId, none.observationId);
});

// —— 配音端口 ——

it("speech: wire 冻结（wss/Authorization/marin/pcm24k/4096/low），成功转码验收并带实际用量", async t => {
  const hub = new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 });
  const { db, port, input, directory, profile } = await speechCase(t, hub);

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "succeeded");
  assert.equal(observation.blob?.mimeType, "audio/mpeg");
  assert.equal(observation.billing, null);
  assert.match(observation.message ?? "", /音频 1\.0 秒/);
  assert.match(observation.message ?? "", /输入 55 \/ 输出 176 token/);
  const receipt = attemptOutput(db, "attempt");
  assert.equal(receipt?.blob_id, observation.blob?.id);
  assert.match(receipt?.detail ?? "", /实际用量：输入 55 \/ 输出 176/);
  assert.ok(existsSync(path.join(directory, "work", "attempt", "speech.mp3")));
  assert.ok(!existsSync(path.join(directory, "work", "attempt", "narration.pcm")));

  const session = hub.sessions[0]!;
  assert.equal(session.url, `wss://api.openai.com/v1/realtime?model=${SPEECH_MODEL}`);
  assert.equal(session.authorization, "Bearer sk-speech");
  assert.equal(session.itemText, SPEECH_TEXT);
  const update = session.sent.find(event => event.type === "session.update") as { session: Record<string, unknown> };
  const audio = update.session.audio as { output: { voice: string; format: { type: string; rate: number } } };
  assert.equal(audio.output.voice, profile.speech.voice);
  assert.equal(audio.output.format.type, "audio/pcm");
  assert.equal(audio.output.format.rate, 24_000);
  assert.equal(update.session.max_output_tokens, 4_096);
  assert.deepEqual(update.session.reasoning, { effort: "low" });
  assert.equal(session.sent.filter(event => event.type === "response.create").length, 1);
});

it("speech: 转写不符 → 内容未通过，不发布 blob、不落文件", async t => {
  const hub = new FakeRealtimeHub({ mode: "transcriptMismatch", audioSeconds: 1 });
  const { db, port, input, directory } = await speechCase(t, hub);

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "failed");
  assert.match(observation.message ?? "", /内容未通过：供应商转写与旁白不一致/);
  assert.equal(attemptOutput(db, "attempt")?.exit_kind, "failed");
  assert.equal(blobCount(db), 0);
  assert.ok(!existsSync(path.join(directory, "work", "attempt")));
});

it("speech: incomplete / 会话内 error / 握手 401 各归确定 failed", async t => {
  const cases: Array<[FakeRealtimeHub, RegExp]> = [
    [new FakeRealtimeHub({ mode: "incomplete", audioSeconds: 1 }), /供应商响应未完成（status=incomplete）.*费用待核/],
    [new FakeRealtimeHub({ mode: "serverError", audioSeconds: 1 }), /供应商明确拒绝创建配音.*会话错误/],
    [new FakeRealtimeHub({ mode: "handshake401", audioSeconds: 1 }), /供应商明确拒绝创建配音：HTTP 401/],
  ];
  for (const [hub, pattern] of cases) {
    const { db, port, input } = await speechCase(t, hub);
    const observation = await port.submit(input, issueSubmitPermit("attempt", 1));
    assert.equal(observation.state, "failed", String(pattern));
    assert.match(observation.message ?? "", pattern);
    assert.equal(attemptOutput(db, "attempt")?.exit_kind, "failed");
    assert.equal(blobCount(db), 0);
  }
});

it("speech: 中途断连与超时截止是 unknown，不自动重开会话", async t => {
  const dropped = await speechCase(t, new FakeRealtimeHub({ mode: "closeMidResponse", audioSeconds: 2 }));
  const dropObservation = await dropped.port.submit(dropped.input, issueSubmitPermit("attempt", 1));
  assert.equal(dropObservation.state, "unknown");
  assert.match(dropObservation.message ?? "", /连接在响应完成前关闭/);

  const hung = await speechCase(t, new FakeRealtimeHub({ mode: "hang", audioSeconds: 2 }), { sessionTimeoutMs: 250 });
  const hungObservation = await hung.port.submit(hung.input, issueSubmitPermit("attempt", 1));
  assert.equal(hungObservation.state, "unknown");
  assert.match(hungObservation.message ?? "", /会话超过.*截止/);
  assert.equal(hung.hub.sessions.length, 1); // 没有第二次连接
});

it("speech: 生成指令未发出的连接失败是确定 failed，不落 unknown", async t => {
  const connectFail = await speechCase(t, new FakeRealtimeHub({ mode: "connectFail", audioSeconds: 1 }));
  const connectObservation = await connectFail.port.submit(connectFail.input, issueSubmitPermit("attempt", 1));
  assert.equal(connectObservation.state, "failed");
  assert.match(connectObservation.message ?? "", /生成请求未发出（连接错误）；供应商未收到任何生成指令/);
  assert.equal(connectFail.hub.sessions[0]!.sent.length, 0); // wire 证据：客户端零发送
  assert.equal(attemptOutput(connectFail.db, "attempt")?.exit_kind, "failed");
  assert.equal(blobCount(connectFail.db), 0);

  const closedEarly = await speechCase(t, new FakeRealtimeHub({ mode: "closeBeforeAny", audioSeconds: 1 }));
  const closeObservation = await closedEarly.port.submit(closedEarly.input, issueSubmitPermit("attempt", 1));
  assert.equal(closeObservation.state, "failed");
  assert.match(closeObservation.message ?? "", /连接在请求发出前关闭；未提交生成请求/);
  assert.equal(closedEarly.hub.sessions[0]!.sent.length, 0);
});

it("speech: 生成中停止 → 已发 cancel 并立即结束本地等待（结果未确认，不等 180 秒截止）；发送前停止 → cancelled 零请求", async t => {
  const mid = await speechCase(t, new FakeRealtimeHub({ mode: "waitCancel", audioSeconds: 2 }));
  const controller = new AbortController();
  const pending = mid.port.submit(mid.input, issueSubmitPermit("attempt", 1), controller.signal);
  await sleep(50); // 会话已建立、response.create 已发出、首个音频分片已到
  const startedAt = Date.now();
  controller.abort();
  const observation = await pending;
  // 停止后本地等待立即结束（对端是否回 done 不再影响本地），没有已知终态就如实落 unknown。
  assert.ok(Date.now() - startedAt < 2_000, "停止后应立即结束本地等待，不等会话截止");
  assert.equal(observation.state, "unknown");
  assert.match(observation.message ?? "", /本地已停止等待并请求远端停止/);
  assert.equal(mid.hub.sessions[0]!.cancelled, true, "取消指令已发出");
  assert.equal(blobCount(mid.db), 0);
  assert.ok(!existsSync(path.join(mid.directory, "work", "attempt")));

  const early = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 }));
  const before = new AbortController();
  const earlyPending = early.port.submit(early.input, issueSubmitPermit("attempt", 1), before.signal);
  before.abort();
  const earlyObservation = await earlyPending;
  assert.equal(earlyObservation.state, "cancelled");
  assert.match(earlyObservation.message ?? "", /停止请求发生在请求发出之前/);
  assert.equal(early.hub.sessions[0]!.sent.length, 0);
});

it("speech: 零音频与超时长音频是确定 failed", async t => {
  const silent = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 0 }));
  const silentObservation = await silent.port.submit(silent.input, issueSubmitPermit("attempt", 1));
  assert.equal(silentObservation.state, "failed");
  assert.match(silentObservation.message ?? "", /供应商未返回任何音频/);

  const overlong = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 121 }));
  const longObservation = await overlong.port.submit(overlong.input, issueSubmitPermit("attempt", 1));
  assert.equal(longObservation.state, "failed");
  assert.match(longObservation.message ?? "", /超过本配置 120s 验收上限/);
});

it("speech: PCM 确定转码失败 → failed 并清理现场", async t => {
  const { db, port, input, directory } = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 }), { ffmpegPath: "/usr/bin/false" });

  const observation = await port.submit(input, issueSubmitPermit("attempt", 1));

  assert.equal(observation.state, "failed");
  assert.match(observation.message ?? "", /PCM 音频无法转码为 MP3/);
  assert.equal(attemptOutput(db, "attempt")?.exit_kind, "failed");
  assert.ok(!existsSync(path.join(directory, "work", "attempt", "narration.pcm")));
  assert.ok(!existsSync(path.join(directory, "work", "attempt", "speech.mp3.part")));
});

it("speech: query 复用收据与用量明细；收据缺失但有成品文件时重验补发布", async t => {
  const seeded = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 }));
  const submitted = await seeded.port.submit(seeded.input, issueSubmitPermit("attempt", 1));
  const afterSubmit = blobCount(seeded.db);

  const queried = await seeded.port.query(seeded.query);
  assert.equal(queried.state, "succeeded");
  assert.equal(queried.blob?.id, submitted.blob?.id);
  assert.match(queried.message ?? "", /输入 55 \/ 输出 176/);
  assert.equal(blobCount(seeded.db), afterSubmit);

  seeded.db.prepare("DELETE FROM production_attempt_outputs WHERE attempt_id='attempt'").run();
  const recovered = await seeded.port.query(seeded.query);
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.blob?.id, submitted.blob?.id);
  assert.equal(attemptOutput(seeded.db, "attempt")?.blob_id, submitted.blob?.id);
  assert.equal(blobCount(seeded.db), afterSubmit);

  const empty = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 }));
  const none = await empty.port.query(empty.query);
  assert.equal(none.state, "unknown");
  assert.match(none.message ?? "", /没有可查询的任务身份/);
});

it("speech: 绑定漂移与凭据未启用是提交前失败，不建会话", async t => {
  const drift = await speechCase(t, new FakeRealtimeHub({ mode: "completed", audioSeconds: 1 }), { resolve: () => null });
  const driftObservation = await drift.port.submit(drift.input, issueSubmitPermit("attempt", 1));
  assert.equal(driftObservation.state, "failed");
  assert.match(driftObservation.message ?? "", /账号配置已变化/);
  assert.equal(drift.hub.sessions.length, 0);
});

// —— 网关退役路由（B3：旧供应商绑定不再回落任何通道） ——

it("gateway: 旧供应商绑定的查询走退役稳定 unknown，不触 Ark、不回落新通道", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "openai-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const workRoot = path.join(directory, "work");
  const ark = new ArkMediaPort(db, blobs, staticClock, { resolve: () => { throw new Error("Ark 不应被触达"); }, workRoot });
  const local = new LocalRenderPort(db, blobs, staticClock, { workRoot });
  let resolveCalls = 0;
  const gateway = new RealMediaGateway(local, {
    // 按 main.ts 的装配方式路由：解析链被咨询但不识别退役绑定；Ark 端口的 resolve 若被触达会抛错。
    resolveProviderPort: binding => {
      resolveCalls += 1;
      return resolveArkBinding(db, binding) ? ark : null;
    },
    clock: staticClock,
  });
  const retiredBinding: ModelBinding = { providerId: "ark", modelId: "doubao-seedream-3-0-0827", connectionId: "legacy", configurationRevisionId: "cfg-retired" };
  const { query } = seedProviderAttempt(db, imageOperation(retiredBinding), retiredBinding);

  const observation = await gateway.query(query);
  const again = await gateway.query(query);

  assert.equal(observation.state, "unknown");
  assert.match(observation.message ?? "", /旧媒体通道已退役/);
  assert.equal(observation.providerTaskId, null);
  assert.equal(observation.observationId, again.observationId);
  assert.equal(resolveCalls, 2);
});
