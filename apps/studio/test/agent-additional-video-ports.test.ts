import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it, type TestContext } from "node:test";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { issueSubmitPermit } from "../src/server/agent/submit-permit.js";
import { attemptOutput } from "../src/server/agent/production-store.js";
import { probeAudioFile, probeVideoFile } from "../src/server/agent/media-probe.js";
import {
  MINIMAX_SPEECH_VOICE, minimaxSpeechBinding, minimaxSpeechProfile, minimaxVideoBinding, minimaxVideoProfile,
  timedNarratedRenderCatalogEntry, wanVideoBinding, wanVideoProfile,
  type MiniMaxSpeechProfile, type MiniMaxVideoProfile, type WanVideoProfile,
} from "../src/server/agent/media-config.js";
import { additionalMediaCatalog, insertAdditionalMediaVersion, readAdditionalMediaCurrent, resolveMinimaxSpeechBinding, resolveMinimaxVideoBinding, resolveWanVideoBinding } from "../src/server/agent/additional-media-settings.js";
import { saveProviderConnection, readProviderConnections } from "../src/server/agent/provider-connections.js";
import { initializeTextModelSettings } from "../src/server/agent/text-model-settings.js";
import { RealMediaGateway } from "../src/server/agent/ark-media.js";
import { MiniMaxVideoPort } from "../src/server/agent/minimax-video.js";
import { WanVideoPort } from "../src/server/agent/wan-video.js";
import { MiniMaxSpeechPort } from "../src/server/agent/minimax-speech.js";
import { bindPreparedPlan, ensurePlanStageWork } from "./helpers/creative-work-fixture.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import type {
  ExecutionInput, ModelBinding, OperationSpec, ProductionIntent, RecoveryQuery,
} from "../src/shared/agent/generated/contracts.js";

// M2 三端口本地 HTTP 替身验收（§11.3 出口）：每协议覆盖 payload、身份、成功、明确失败、
// 已发送未知、原 task 查询、结果保存、当前切换后 frozen routing；配音用真实音频字节解码；
// Wan 断言 prompt 原样 + prompt_extend=false；MiniMax 停止不发 DELETE；Wan PENDING 取消与
// RUNNING 拒绝后查询原任务。全程不触真实外网，媒体字节由本地 ffmpeg 生成。

const run = promisify(execFile);
const staticClock = () => "2026-11-01T00:00:00.000Z";

// —— 媒体夹具（真实可 probe 字节） ——

async function makeClip(file: string, seconds: number, withAudio: boolean, audioSeconds = seconds): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=teal:s=1280x720:r=24:d=${seconds}`];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=220:duration=${audioSeconds}`, "-map", "0:v", "-map", "1:a", "-c:a", "aac");
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", file);
  await run("ffmpeg", args);
}

async function makeMp3(file: string, seconds: number, sampleRateHz = 32_000): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ar", String(sampleRateHz), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", file]);
}

async function withVideoAssets<T>(fn: (native: Buffer, silent: Buffer, wrongDuration: Buffer) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-m2-clips-"));
  await makeClip(path.join(directory, "native.mp4"), 6, true, 6.056); // 原声 AAC 尾部不改变冻结的视频轨时段
  await makeClip(path.join(directory, "silent.mp4"), 6, false);
  await makeClip(path.join(directory, "wrong.mp4"), 5, true);
  try {
    return await fn(readFileSync(path.join(directory, "native.mp4")), readFileSync(path.join(directory, "silent.mp4")), readFileSync(path.join(directory, "wrong.mp4")));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function withSpeechAssets<T>(fn: (mp3: Buffer, wrongRate: Buffer) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-m2-speech-assets-"));
  const mp3 = path.join(directory, "narration.mp3"), wrong = path.join(directory, "wrong.mp3");
  await makeMp3(mp3, 2);
  await makeMp3(wrong, 2, 44_100);
  try { return await fn(readFileSync(mp3), readFileSync(wrong)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// —— 端口级播种：run/operation/attempt 一次落库，端口直接消费 ——

function seedProviderAttempt(db: AgentDatabase, operation: OperationSpec, binding: ModelBinding, attemptId = "attempt"):
{ input: ExecutionInput; query: Extract<RecoveryQuery, { kind: "provider" }> } {
  // 同一 db 多次播种：operation id 按 attempt 唯一化，避免 (run_id, id) 冲突。
  const seeded: OperationSpec = { ...operation, operationId: `${operation.operationId}-${attemptId}` };
  const time = staticClock();
  db.transaction(() => {
    // 同一 db 多次播种：会话/run 等共享行只建一次，operation/attempt 每次新增。
    if (!db.prepare("SELECT 1 FROM conversations WHERE id='conversation'").get()) {
      db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conversation','owner','端口级',1,'s1',?,?)").run(time, time);
      db.prepare("INSERT INTO works(id,owner_id,conversation_id) VALUES('work','owner','conversation')").run();
      db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('snapshot','{}','digest-snapshot',?)").run(time);
      db.prepare("INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,created_seq,created_at,updated_at) VALUES('proposal','conversation','owner','digest-proposal','{}','ready','公开',?,1,?,?)").run(time, time, time);
      db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,created_seq,created_at,updated_at) VALUES('run','owner','conversation','work','snapshot','proposal','端口级','running',1,?,?)").run(time, time);
    }
    db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state) VALUES('run',?,?,'pending')").run(seeded.operationId, JSON.stringify(seeded));
    db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES(?,'run',?,1,?,'submit_started','running',0)")
      .run(attemptId, seeded.operationId, `request-${attemptId}`);
  })();
  return {
    input: { runId: "run", snapshotId: "snapshot", operationId: seeded.operationId, attemptId, requestIdentity: `request-${attemptId}`, operation: seeded, resolvedInputs: [] },
    query: { runId: "run", operationId: seeded.operationId, attemptId, requestIdentity: `request-${attemptId}`, providerTaskId: null, accountBinding: binding, kind: "provider" },
  };
}

interface PortFixture { db: AgentDatabase; blobs: ProductionBlobs; workRoot: string }

async function openFixture(t: TestContext, prefix: string): Promise<PortFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  return { db, blobs: new ProductionBlobs(db, directory, staticClock), workRoot: path.join(directory, "work") };
}

/** 当前选择持有者：retire() 模拟当前已切到其他连接，冻结绑定不再被解析。 */
function resolverFor<P>(profile: P, apiKey: string): { resolve: (binding: ModelBinding) => { profile: P; apiKey: string } | null; retire: () => void } {
  const state = { active: true };
  return {
    resolve: () => (state.active ? { profile, apiKey } : null),
    retire: () => { state.active = false; },
  };
}

function videoOperation(binding: ModelBinding, parameters: { durationSeconds: number; resolution: string; audioMode: "none" | "native" }, text: string): OperationSpec {
  return { operationId: "shot", outputSlot: "shot", kind: "video", model: binding,
    inputs: [{ kind: "text", text }], maxCreateAttempts: 1,
    quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "estimate",
    parameters: { ...parameters, aspectRatio: "16:9" } } as OperationSpec;
}

function speechOperation(binding: ModelBinding, text: string): OperationSpec {
  return { operationId: "speech", outputSlot: "speech", kind: "speech", model: binding,
    inputs: [{ kind: "text", text }], maxCreateAttempts: 1,
    quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "estimate",
    parameters: { voiceId: MINIMAX_SPEECH_VOICE, format: "mp3" } } as OperationSpec;
}

const billingOf = (db: AgentDatabase, attemptId: string) =>
  (db.prepare("SELECT billing_json FROM production_attempts WHERE id=?").get(attemptId) as { billing_json: string | null }).billing_json;

const closeServer = (server: http.Server) => { server.closeAllConnections(); server.close(); };

// —— MiniMax H3 视频桩：v2 create/query wire 形状按官方页 ——

interface MiniMaxStubState {
  createStatus: number;
  taskStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  queryStatus: number;
  downloadPath: string;
  posts: { auth: string | undefined; body: any }[];
  gets: number;
  deletes: number;
  downloads: number;
}

async function startMiniMaxStub(native: Buffer, wrong: Buffer): Promise<{ server: http.Server; baseUrl: string; state: MiniMaxStubState }> {
  const state: MiniMaxStubState = { createStatus: 200, taskStatus: "running", queryStatus: 200, downloadPath: "/dl/native.mp4",
    posts: [], gets: 0, deletes: 0, downloads: 0 };
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const readBody = (then: (body: any) => void) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => then(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
    };
    if (request.method === "POST" && url === "/v2/video_generation") {
      const entry = { auth: request.headers.authorization, body: null as unknown };
      state.posts.push(entry);
      readBody(body => {
        entry.body = body;
        if (state.createStatus !== 200) {
          response.writeHead(state.createStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: { code: "invalid_request_error", message: `invalid Authorization: ${entry.auth}` } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ task_id: "task-mm-1" }));
      });
      return;
    }
    if (request.method === "GET" && url === "/v2/query/video_generation/task-mm-1") {
      state.gets += 1;
      if (state.queryStatus !== 200) {
        response.writeHead(state.queryStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { code: "not_found", message: "task not found" } }));
        return;
      }
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const content = state.taskStatus === "succeeded" ? { url: `${origin}${state.downloadPath}` } : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task: { status: state.taskStatus, content } }));
      return;
    }
    if (request.method === "DELETE" && url.startsWith("/v2/video_generation/")) {
      state.deletes += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.method === "GET" && url === "/dl/native.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(native); return; }
    if (request.method === "GET" && url === "/dl/wrong.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(wrong); return; }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { code: "not_found", message: "no such path" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

describe("MiniMax H3 video port (M2)", () => {
  const TEXT = "黄昏山谷，镜头缓慢推近。";

  async function openPort(t: TestContext, stubUrl: string) {
    const fixture = await openFixture(t, "vf-m2-mm-");
    const profile: MiniMaxVideoProfile = { ...minimaxVideoProfile("MiniMax-H3", "https://api.minimax.cn")!, baseUrl: stubUrl };
    const binding = minimaxVideoBinding(profile, "conn-mm-video");
    const current = resolverFor(profile, "M2-KEY-mm-video");
    const port = new MiniMaxVideoPort(fixture.db, fixture.blobs, staticClock, { resolve: current.resolve, workRoot: fixture.workRoot });
    return { ...fixture, binding, port, current };
  }

  it("payload/身份/成功：请求映射原样、结果下载发布并保存收据", async t => {
    await withVideoAssets(async native => {
      const stub = await startMiniMaxStub(native, native);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding);
      const submitted = await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      assert.equal(submitted.state, "running");
      assert.equal(submitted.providerTaskId, "task-mm-1");
      const post = stub.state.posts[0]!;
      assert.equal(post.auth, "Bearer M2-KEY-mm-video");
      assert.equal(post.body.model, "MiniMax-H3");
      assert.deepEqual(post.body.content, [{ type: "text", text: TEXT }]);
      assert.equal(post.body.resolution, "768P");
      assert.equal(post.body.ratio, "16:9");
      assert.equal(post.body.duration, 6);
      assert.ok(!("audio" in post.body) && !("generate_audio" in post.body), "官方 create 页无静音字段：不猜 audio 开关");

      stub.state.taskStatus = "queued";
      assert.equal((await ctx.port.query(query)).state, "running");
      stub.state.taskStatus = "succeeded";
      const done = await ctx.port.query(query);
      assert.equal(done.state, "succeeded");
      assert.equal(done.blob?.mimeType, "video/mp4");
      assert.equal(billingOf(ctx.db, input.attemptId), null, "未取得账单前费用不落 settled");

      const receipt = attemptOutput(ctx.db, input.attemptId)!;
      assert.equal(receipt.provider_task_id, "task-mm-1");
      assert.ok(receipt.blob_id && receipt.digest);
      const blob = ctx.blobs.get("owner", receipt.blob_id);
      assert.equal(blob.digest, receipt.digest);
      const file = path.join(ctx.workRoot, input.attemptId, "download.mp4");
      assert.ok(existsSync(file), "成片落在确定性位置");
      const facts = await probeVideoFile(file);
      assert.ok(Math.abs(facts.durationMs - 6000) <= 100, "按冻结 6 秒验收时长");
      assert.equal(facts.hasAudio, true, "原生音画必须有音轨");
      assert.ok(!JSON.stringify(done).includes("M2-KEY-mm-video"), "观测不回显 Key");
      assert.equal(stub.state.posts.length, 1, "整个生命周期恰好一次 create");
    });
  });

  it("明确失败（create 4xx）是提交前失败；已发送未知（5xx）保留核对、不重发；404 按保留期稳定 unknown", async t => {
    const stub = await startMiniMaxStub(Buffer.alloc(0), Buffer.alloc(0));
    t.after(() => closeServer(stub.server));
    const ctx = await openPort(t, stub.baseUrl);
    stub.state.createStatus = 400;
    const refused = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding, "attempt-refused");
    const refusedObservation = await ctx.port.submit(refused.input, issueSubmitPermit("attempt-refused", 1));
    assert.equal(refusedObservation.state, "failed");
    assert.match(refusedObservation.message ?? "", /供应商明确拒绝创建任务/);
    assert.equal(refusedObservation.providerTaskId, null);

    stub.state.createStatus = 503;
    const unknown = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding, "attempt-unknown");
    const unknownObservation = await ctx.port.submit(unknown.input, issueSubmitPermit("attempt-unknown", 1));
    assert.equal(unknownObservation.state, "unknown");
    assert.match(unknownObservation.message ?? "", /创建请求结果未核实/);
    const afterUnknown = await ctx.port.query(unknown.query);
    assert.equal(afterUnknown.state, "unknown");
    assert.match(afterUnknown.message ?? "", /缺少供应商任务身份/);
    assert.equal(stub.state.posts.length, 2, "两次提交各一次 create，未知不重发");

    stub.state.createStatus = 200;
    stub.state.queryStatus = 503;
    const sent = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding, "attempt-sent");
    await ctx.port.submit(sent.input, issueSubmitPermit("attempt-sent", 1));
    const transient = await ctx.port.query(sent.query);
    assert.equal(transient.state, "unknown");
    assert.match(transient.message ?? "", /查询暂时失败/);
    assert.equal(transient.providerTaskId, "task-mm-1", "已发送未知的任务身份保留");

    stub.state.queryStatus = 404;
    const expired = await ctx.port.query(sent.query);
    assert.equal(expired.state, "unknown");
    assert.match(expired.message ?? "", /保留期约 7 天/);
    assert.equal(expired.observationId, (await ctx.port.query(sent.query)).observationId, "稳定 unknown 幂等");
    assert.equal(stub.state.posts.length, 3);
  });

  it("重启后只查询原任务：GET 继续而 POST 不增加，成品只下载发布一次", async t => {
    await withVideoAssets(async native => {
      const stub = await startMiniMaxStub(native, native);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding);
      await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      await ctx.port.query(query);
      assert.equal(stub.state.posts.length, 1);
      const getsBefore = stub.state.gets;

      // 模拟重启：同一数据目录上的新端口实例，只凭收据恢复查询。
      const reopened = new MiniMaxVideoPort(ctx.db, ctx.blobs, staticClock, { resolve: ctx.current.resolve, workRoot: ctx.workRoot });
      stub.state.taskStatus = "succeeded";
      const done = await reopened.query(query);
      assert.equal(done.state, "succeeded");
      assert.ok(stub.state.gets > getsBefore, "重启后继续 GET 原任务");
      assert.equal(stub.state.posts.length, 1, "重启不重新创建");
      assert.equal(stub.state.downloads, 1);
      const again = await reopened.query(query);
      assert.equal(again.observationId, done.observationId, "收据复用：不再下载");
      assert.equal(stub.state.downloads, 1);
    });
  });

  it("停止不发 DELETE：queued 时停止，任务随后完成，原结果保留", async t => {
    await withVideoAssets(async native => {
      const stub = await startMiniMaxStub(native, native);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding);
      await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      stub.state.taskStatus = "queued";
      const stopped = await ctx.port.cancel(query);
      assert.equal(stopped.state, "running");
      assert.match(stopped.message ?? "", /排队中/);
      assert.equal(stub.state.deletes, 0, "普通 Stop 不调用 DELETE");

      stub.state.taskStatus = "succeeded";
      const after = await ctx.port.cancel(query);
      assert.equal(after.state, "succeeded", "停止后任务完成仍保留原结果");
      assert.ok(after.blob?.id);
      assert.equal(stub.state.deletes, 0);
      assert.equal(stub.state.posts.length, 1);
      assert.equal(billingOf(ctx.db, input.attemptId), null, "未知费用不清零、不虚构");
    });
  });

  it("时长不符的成品是非合规 failed 收据，不再重新获取同一无效文件", async t => {
    await withVideoAssets(async (native, _silent, wrong) => {
      const stub = await startMiniMaxStub(native, wrong);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding);
      await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      stub.state.taskStatus = "succeeded";
      stub.state.downloadPath = "/dl/wrong.mp4";
      const bad = await ctx.port.query(query);
      assert.equal(bad.state, "failed");
      assert.match(bad.message ?? "", /输出时长.*不符/);
      const receipt = attemptOutput(ctx.db, input.attemptId)!;
      assert.equal(receipt.exit_kind, "failed");
      assert.equal(receipt.provider_task_id, "task-mm-1");
      const getsAfterFailure = stub.state.gets;
      const retried = await ctx.port.query(query);
      assert.equal(retried.state, "failed");
      assert.equal(retried.observationId, bad.observationId, "失败收据幂等复述");
      assert.equal(stub.state.gets, getsAfterFailure, "不重新查询/获取同一无效文件");
      assert.equal(stub.state.posts.length, 1);
    });
  });

  it("当前切换后 frozen routing：旧绑定不再解析为稳定 unknown，不重建", async t => {
    const stub = await startMiniMaxStub(Buffer.alloc(0), Buffer.alloc(0));
    t.after(() => closeServer(stub.server));
    const ctx = await openPort(t, stub.baseUrl);
    const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "768P", audioMode: "native" }, TEXT), ctx.binding);
    await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
    const getsBefore = stub.state.gets;
    ctx.current.retire(); // 当前已切到其他连接：冻结绑定不再被解析
    const drifted = await ctx.port.query(query);
    assert.equal(drifted.state, "unknown");
    assert.match(drifted.message ?? "", /账号配置已变化/);
    assert.equal(drifted.providerTaskId, "task-mm-1", "原任务身份保留");
    assert.equal(stub.state.posts.length, 1, "不用当前配置重建");
    assert.equal(stub.state.gets, getsBefore, "不拿当前凭据查询旧任务");
  });
});

// —— 万相桩：DashScope 异步 wire 形状按官方页 ——

interface WanStubState {
  createStatus: number;
  taskStatus: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
  cancelMode: "ok" | "reject";
  downloadPath: string;
  posts: { auth: string | undefined; asyncHeader: string | undefined; body: any }[];
  gets: number;
  cancels: number;
  downloads: number;
}

async function startWanStub(native: Buffer, silent: Buffer): Promise<{ server: http.Server; baseUrl: string; state: WanStubState }> {
  const state: WanStubState = { createStatus: 200, taskStatus: "RUNNING", cancelMode: "ok", downloadPath: "/dl/native.mp4",
    posts: [], gets: 0, cancels: 0, downloads: 0 };
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const readBody = (then: (body: any) => void) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => then(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
    };
    if (request.method === "POST" && url === "/api/v1/services/aigc/video-generation/video-synthesis") {
      const entry = { auth: request.headers.authorization, asyncHeader: request.headers["x-dashscope-async"] as string | undefined, body: null as unknown };
      state.posts.push(entry);
      readBody(body => {
        entry.body = body;
        if (state.createStatus !== 200) {
          response.writeHead(state.createStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "InvalidParameter", message: `invalid Authorization: ${entry.auth}` }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output: { task_id: "task-wan-1", task_status: "PENDING" }, request_id: "req-create" }));
      });
      return;
    }
    if (request.method === "GET" && url === "/api/v1/tasks/task-wan-1") {
      state.gets += 1;
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const output: Record<string, unknown> = { task_status: state.taskStatus };
      if (state.taskStatus === "SUCCEEDED") output.video_url = `${origin}${state.downloadPath}`;
      if (state.taskStatus === "FAILED") output.code = "InternalError";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output, request_id: "req-query" }));
      return;
    }
    if (request.method === "POST" && url === "/api/v1/tasks/task-wan-1/cancel") {
      state.cancels += 1;
      if (state.cancelMode === "reject") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "UnsupportedOperation", message: "only PENDING tasks can be cancelled" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ request_id: "req-cancel" }));
      return;
    }
    if (request.method === "GET" && url === "/dl/native.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(native); return; }
    if (request.method === "GET" && url === "/dl/silent.mp4") { state.downloads += 1; response.writeHead(200, { "content-type": "video/mp4" }); response.end(silent); return; }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "NotFound", message: "no such path" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

describe("Wan video port (M2)", () => {
  const TEXT = "山路弯弯，\n保持「原样」不改写。";

  async function openPort(t: TestContext, stubUrl: string) {
    const fixture = await openFixture(t, "vf-m2-wan-");
    const profile: WanVideoProfile = { ...wanVideoProfile("wan3.0-video", "https://ws.cn-beijing.maas.aliyuncs.com")!, baseUrl: stubUrl };
    const binding = wanVideoBinding(profile, "conn-wan-video");
    const current = resolverFor(profile, "M2-KEY-wan");
    const port = new WanVideoPort(fixture.db, fixture.blobs, staticClock, { resolve: current.resolve, workRoot: fixture.workRoot });
    return { ...fixture, binding, port, current };
  }

  it("payload/身份/prompt 原样：prompt_extend=false、X-DashScope-Async、原生音画成功链", async t => {
    await withVideoAssets(async native => {
      const stub = await startWanStub(native, native);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "native" }, TEXT), ctx.binding);
      assert.equal((await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1))).providerTaskId, "task-wan-1");
      const post = stub.state.posts[0]!;
      assert.equal(post.auth, "Bearer M2-KEY-wan");
      assert.equal(post.asyncHeader, "enable", "异步头只在 create 请求上");
      assert.equal(post.body.model, "wan3.0-video");
      assert.equal(post.body.input.prompt, TEXT, "prompt 原样传入，不改写");
      assert.equal(post.body.parameters.prompt_extend, false, "显式关闭额外改写");
      assert.equal(post.body.parameters.audio, true);
      assert.equal(post.body.parameters.duration, 6);
      assert.equal(post.body.parameters.resolution, "720P");
      assert.equal(post.body.parameters.ratio, "16:9");

      stub.state.taskStatus = "SUCCEEDED";
      const done = await ctx.port.query(query);
      assert.equal(done.state, "succeeded");
      assert.ok(done.blob?.id);
      const receipt = attemptOutput(ctx.db, input.attemptId)!;
      assert.equal(receipt.provider_task_id, "task-wan-1");
      assert.ok(receipt.blob_id);
      const facts = await probeVideoFile(path.join(ctx.workRoot, input.attemptId, "download.mp4"));
      assert.equal(facts.hasAudio, true);
      assert.equal(stub.state.posts.length, 1, "除 create 外不增任何改写/生成调用");
    });
  });

  it("audioMode none 传 audio=false 且无声成品验收通过", async t => {
    await withVideoAssets(async (native, silent) => {
      const stub = await startWanStub(native, silent);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "none" }, TEXT), ctx.binding);
      await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      assert.equal(stub.state.posts[0]!.body.parameters.audio, false);
      stub.state.taskStatus = "SUCCEEDED";
      stub.state.downloadPath = "/dl/silent.mp4";
      const done = await ctx.port.query(query);
      assert.equal(done.state, "succeeded", done.message ?? "no message");
      assert.equal((await probeVideoFile(path.join(ctx.workRoot, input.attemptId, "download.mp4"))).hasAudio, false, "冻结无声必须无声");
    });
  });

  it("PENDING 取消成功记远端取消；RUNNING 拒绝后查询原任务，均无第二次 create", async t => {
    await withVideoAssets(async native => {
      const stub = await startWanStub(native, native);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const pending = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "native" }, TEXT), ctx.binding, "attempt-pending");
      await ctx.port.submit(pending.input, issueSubmitPermit("attempt-pending", 1));
      stub.state.taskStatus = "PENDING";
      const cancelled = await ctx.port.cancel(pending.query);
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.providerTaskId, "task-wan-1");
      assert.match(cancelled.message ?? "", /供应商已取消排队中的任务/);
      assert.equal(stub.state.cancels, 1);
      assert.equal(stub.state.posts.length, 1);

      const running = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "native" }, TEXT), ctx.binding, "attempt-running");
      await ctx.port.submit(running.input, issueSubmitPermit("attempt-running", 1));
      stub.state.taskStatus = "RUNNING";
      stub.state.cancelMode = "reject";
      const stop = await ctx.port.cancel(running.query);
      assert.equal(stop.state, "running", "拒绝取消落回原任务查询，不把本地停止当远端取消");
      assert.match(stop.message ?? "", /任务执行中/);
      assert.equal(stub.state.cancels, 2);
      assert.equal(stub.state.posts.length, 2, "每个任务各一次 create，取消拒绝不重发");
      assert.equal(billingOf(ctx.db, "attempt-running"), null, "未知费用不清零");

      stub.state.taskStatus = "SUCCEEDED";
      const finished = await ctx.port.cancel(running.query);
      assert.equal(finished.state, "succeeded", "原任务结果保留");
      assert.ok(finished.blob?.id);
      assert.equal(stub.state.posts.length, 2);
    });
  });

  it("明确失败/已发送未知/UNKNOWN：不判失败后重发，身份保留", async t => {
    const stub = await startWanStub(Buffer.alloc(0), Buffer.alloc(0));
    t.after(() => closeServer(stub.server));
    const ctx = await openPort(t, stub.baseUrl);
    stub.state.createStatus = 400;
    const refused = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "none" }, TEXT), ctx.binding, "attempt-refused");
    const refusedObservation = await ctx.port.submit(refused.input, issueSubmitPermit("attempt-refused", 1));
    assert.equal(refusedObservation.state, "failed");
    assert.match(refusedObservation.message ?? "", /供应商明确拒绝创建任务/);

    stub.state.createStatus = 503;
    const unknown = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "none" }, TEXT), ctx.binding, "attempt-unknown");
    const unknownObservation = await ctx.port.submit(unknown.input, issueSubmitPermit("attempt-unknown", 1));
    assert.equal(unknownObservation.state, "unknown");
    assert.match(unknownObservation.message ?? "", /创建请求结果未核实/);
    assert.equal(stub.state.posts.length, 2);

    stub.state.createStatus = 200;
    stub.state.taskStatus = "UNKNOWN";
    const sent = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "none" }, TEXT), ctx.binding, "attempt-unknown-status");
    await ctx.port.submit(sent.input, issueSubmitPermit("attempt-unknown-status", 1));
    const unknownStatus = await ctx.port.query(sent.query);
    assert.equal(unknownStatus.state, "unknown");
    assert.match(unknownStatus.message ?? "", /任务状态未知/);
    assert.equal(unknownStatus.providerTaskId, "task-wan-1");
    assert.equal((await ctx.port.query(sent.query)).observationId, unknownStatus.observationId, "UNKNOWN 稳定幂等");
    assert.equal(stub.state.posts.length, 3, "UNKNOWN 不触发重发");

    stub.state.taskStatus = "FAILED";
    const failed = await ctx.port.query(sent.query);
    assert.equal(failed.state, "failed");
    assert.match(failed.message ?? "", /InternalError/);
  });

  it("当前切换后 frozen routing：旧绑定解析为空时稳定 unknown，不重建", async t => {
    const stub = await startWanStub(Buffer.alloc(0), Buffer.alloc(0));
    t.after(() => closeServer(stub.server));
    const ctx = await openPort(t, stub.baseUrl);
    const { input, query } = seedProviderAttempt(ctx.db, videoOperation(ctx.binding, { durationSeconds: 6, resolution: "720P", audioMode: "none" }, TEXT), ctx.binding);
    await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
    const getsBefore = stub.state.gets;
    ctx.current.retire();
    const drifted = await ctx.port.query(query);
    assert.equal(drifted.state, "unknown");
    assert.match(drifted.message ?? "", /账号配置已变化/);
    assert.equal(stub.state.posts.length, 1);
    assert.equal(stub.state.gets, getsBefore);
  });
});

// —— MiniMax 配音桩：t2a v2 同步 wire 形状按官方页 ——

interface SpeechStubState {
  mode: "ok" | "baseResp" | "status400" | "status503" | "wrongRate" | "invalidSuffix" | "oddHex";
  posts: { auth: string | undefined; body: any }[];
}

async function startSpeechStub(mp3: Buffer, wrongRateMp3: Buffer): Promise<{ server: http.Server; baseUrl: string; state: SpeechStubState }> {
  const state: SpeechStubState = { mode: "ok", posts: [] };
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && (request.url ?? "") === "/v1/t2a_v2") {
      const entry = { auth: request.headers.authorization, body: null as unknown };
      state.posts.push(entry);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (state.mode === "status400" || state.mode === "status503") {
          response.writeHead(state.mode === "status400" ? 400 : 503, { "content-type": "application/json" });
          response.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: `invalid Authorization: ${entry.auth}` } }));
          return;
        }
        if (state.mode === "baseResp") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "text too long" }, data: {}, extra_info: {} }));
          return;
        }
        const audio = state.mode === "wrongRate" ? wrongRateMp3 : mp3;
        response.writeHead(200, { "content-type": "application/json" });
        const hex = audio.toString("hex") + (state.mode === "invalidSuffix" ? "zz" : state.mode === "oddHex" ? "a" : "");
        response.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: hex }, extra_info: { usage_characters: 25 } }));
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

describe("MiniMax speech port (M2)", () => {
  const TEXT = "这段旁白按原文直发，含标点与换行。\n第二句。";

  async function openPort(t: TestContext, stubUrl: string) {
    const fixture = await openFixture(t, "vf-m2-mmspeech-");
    const profile: MiniMaxSpeechProfile = { ...minimaxSpeechProfile("speech-2.8-turbo", "https://api.minimax.cn")!, baseUrl: stubUrl };
    const binding = minimaxSpeechBinding(profile, "conn-mm-speech");
    const current = resolverFor(profile, "M2-KEY-mm-speech");
    const port = new MiniMaxSpeechPort(fixture.db, fixture.blobs, staticClock, { resolve: current.resolve, workRoot: fixture.workRoot });
    return { ...fixture, binding, port, current };
  }

  it("真实音频字节解码：payload 原样、规格验收、usage_characters 只进消息", async t => {
    await withSpeechAssets(async (mp3, wrong) => {
      const stub = await startSpeechStub(mp3, wrong);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding);
      const done = await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      assert.equal(done.state, "succeeded");
      assert.equal(done.blob?.mimeType, "audio/mpeg");
      assert.match(done.message ?? "", /计费字符 25/);
      const post = stub.state.posts[0]!;
      assert.equal(post.auth, "Bearer M2-KEY-mm-speech");
      assert.equal(post.body.model, "speech-2.8-turbo");
      assert.equal(post.body.text, TEXT, "旁白原文直发，不改写不截断");
      assert.equal(post.body.stream, false);
      assert.equal(post.body.output_format, "hex");
      assert.deepEqual(post.body.voice_setting, { voice_id: MINIMAX_SPEECH_VOICE });
      assert.deepEqual(post.body.audio_setting, { sample_rate: 32_000, bitrate: 128_000, format: "mp3", channel: 1 });

      const file = path.join(ctx.workRoot, input.attemptId, "speech.mp3");
      assert.ok(existsSync(file), "解码字节落在确定性位置");
      const facts = await probeAudioFile(file);
      assert.equal(facts.channels, 1);
      assert.equal(facts.sampleRate, 32_000);
      const receipt = attemptOutput(ctx.db, input.attemptId)!;
      assert.ok(receipt.blob_id && receipt.digest);
      assert.equal(billingOf(ctx.db, input.attemptId), null, "计费字符只进消息，不落 settled 账单");

      // 恢复与停止同路：只读本地收据，不再次提交。
      const again = await ctx.port.cancel(query);
      assert.equal(again.state, "succeeded");
      assert.equal(again.observationId, done.observationId);
      assert.equal(stub.state.posts.length, 1);
    });
  });

  it("base_resp 明确拒绝是 failed；HTTP 4xx/5xx 分清；规格不符落非合规收据", async t => {
    await withSpeechAssets(async (mp3, wrong) => {
      const stub = await startSpeechStub(mp3, wrong);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      stub.state.mode = "baseResp";
      const refused = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding, "attempt-baseresp");
      const refusedObservation = await ctx.port.submit(refused.input, issueSubmitPermit("attempt-baseresp", 1));
      assert.equal(refusedObservation.state, "failed");
      assert.match(refusedObservation.message ?? "", /base_resp 1004/);

      stub.state.mode = "status400";
      const rejected = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding, "attempt-400");
      assert.equal((await ctx.port.submit(rejected.input, issueSubmitPermit("attempt-400", 1))).state, "failed");

      stub.state.mode = "status503";
      const unknown = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding, "attempt-503");
      const unknownObservation = await ctx.port.submit(unknown.input, issueSubmitPermit("attempt-503", 1));
      assert.equal(unknownObservation.state, "unknown");
      assert.match(unknownObservation.message ?? "", /配音请求结果未核实/);
      const afterUnknown = await ctx.port.query(unknown.query);
      assert.equal(afterUnknown.state, "unknown");
      assert.match(afterUnknown.message ?? "", /没有可查询的任务身份/);
      assert.equal(stub.state.posts.length, 3, "未知不自动重发");

      stub.state.mode = "wrongRate";
      const nonCompliant = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding, "attempt-wrongrate");
      const bad = await ctx.port.submit(nonCompliant.input, issueSubmitPermit("attempt-wrongrate", 1));
      assert.equal(bad.state, "failed");
      assert.match(bad.message ?? "", /采样率 44100Hz 与冻结规格 32000Hz 不符/);
      assert.equal(attemptOutput(ctx.db, "attempt-wrongrate")!.exit_kind, "failed");
      assert.ok(!existsSync(path.join(ctx.workRoot, "attempt-wrongrate", "speech.mp3")), "不合规音频不保留成品文件");
      for (const mode of ["invalidSuffix", "oddHex"] as const) {
        stub.state.mode = mode;
        const invalid = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding, `attempt-${mode}`);
        const result = await ctx.port.submit(invalid.input, issueSubmitPermit(invalid.input.attemptId, 1));
        assert.equal(result.state, "failed", "F11：完整合法 hex 才能解码，不能静默截断");
        assert.match(result.message ?? "", /完整合法的 hex/);
      }
    });
  });

  it("F05：暂不可 probe 时保留完整文件，恢复工具后同一文件成功且请求仅一次", async t => {
    await withSpeechAssets(async (mp3, wrong) => {
      const stub = await startSpeechStub(mp3, wrong);
      t.after(() => closeServer(stub.server));
      const ctx = await openPort(t, stub.baseUrl);
      const { input, query } = seedProviderAttempt(ctx.db, speechOperation(ctx.binding, TEXT), ctx.binding);
      const originalPath = process.env.PATH;
      let first;
      try {
        process.env.PATH = "/intentionally-no-media-probe";
        first = await ctx.port.submit(input, issueSubmitPermit(input.attemptId, 1));
      } finally { process.env.PATH = originalPath; }
      assert.equal(first.state, "unknown");
      assert.ok(existsSync(path.join(ctx.workRoot, input.attemptId, "speech.mp3")));
      assert.equal(attemptOutput(ctx.db, input.attemptId)?.blob_id ?? null, null, "完整接收不代表已验证发布");
      assert.equal((await ctx.port.query(query)).state, "succeeded");
      assert.equal(stub.state.posts.length, 1);
    });
  });

  it("F02：停止信号贯通在途 HTTP 和响应体；发送前零请求，发送后保留 unknown", async t => {
    const ctx = await openFixture(t, "vf-g1-speech-abort-");
    const profile = minimaxSpeechProfile("speech-2.8-turbo", "https://api.minimax.cn")!;
    const binding = minimaxSpeechBinding(profile, "conn-g1-abort");
    let requests = 0;
    for (const phase of ["request", "body"] as const) {
      const seeded = seedProviderAttempt(ctx.db, speechOperation(binding, TEXT), binding, `attempt-${phase}`);
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let requestSignal: AbortSignal;
      const port = new MiniMaxSpeechPort(ctx.db, ctx.blobs, staticClock, { workRoot: ctx.workRoot, resolve: () => ({ profile, apiKey: "fake-abort-key" }),
        fetchImpl: (async (_url, init) => {
          requests++;
          requestSignal = init!.signal as AbortSignal;
          if (phase === "request") {
            started();
            return new Promise<Response>((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          }
          return new Response(new ReadableStream({ start(controller) {
            started();
            requestSignal.addEventListener("abort", () => controller.error(new Error("aborted body")), { once: true });
          } }));
        }) as typeof fetch });
      const controller = new AbortController();
      const pending = port.submit(seeded.input, issueSubmitPermit(seeded.input.attemptId, 1), controller.signal);
      await ready;
      controller.abort();
      assert.equal((await pending).state, "unknown", "已发送只中止本地等待，不伪造远端取消");
      assert.equal(requestSignal!.aborted, true);
      assert.equal((await port.query(seeded.query)).state, "unknown");
      const before = seedProviderAttempt(ctx.db, speechOperation(binding, TEXT), binding, `attempt-before-${phase}`);
      assert.equal((await port.submit(before.input, issueSubmitPermit(before.input.attemptId, 1), AbortSignal.abort())).state, "cancelled");
    }
    assert.equal(requests, 2, "每个已发送场景仅一次请求；发送前取消和query不外呼");
  });
});

it("F03：MiniMax/Wan 的下载与完整文件恢复均拒绝 1:1 冒充冻结 16:9", async t => {
  const fixture = await openFixture(t, "vf-g2-aspect-");
  const squareFile = path.join(fixture.workRoot, "square.mp4");
  mkdirSync(fixture.workRoot, { recursive: true });
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=teal:s=640x640:r=24:d=6",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:v", "libx264", "-c:a", "aac", squareFile]);
  const square = readFileSync(squareFile);
  for (const provider of ["minimax", "wan"] as const) {
    const stub = provider === "minimax" ? await startMiniMaxStub(square, square) : await startWanStub(square, square);
    t.after(() => closeServer(stub.server));
    const profile = provider === "minimax"
      ? { ...minimaxVideoProfile("MiniMax-H3", "https://api.minimax.cn")!, baseUrl: stub.baseUrl }
      : { ...wanVideoProfile("wan3.0-video", "https://ws.cn-beijing.maas.aliyuncs.com")!, baseUrl: stub.baseUrl };
    const binding = provider === "minimax" ? minimaxVideoBinding(profile as MiniMaxVideoProfile, "conn-aspect-mm")
      : wanVideoBinding(profile as WanVideoProfile, "conn-aspect-wan");
    const port = provider === "minimax"
      ? new MiniMaxVideoPort(fixture.db, fixture.blobs, staticClock, { workRoot: fixture.workRoot, resolve: () => ({ profile: profile as MiniMaxVideoProfile, apiKey: "fake-aspect" }) })
      : new WanVideoPort(fixture.db, fixture.blobs, staticClock, { workRoot: fixture.workRoot, resolve: () => ({ profile: profile as WanVideoProfile, apiKey: "fake-aspect" }) });
    for (const mode of ["download", "recovery"] as const) {
      const seeded = seedProviderAttempt(fixture.db, videoOperation(binding, { durationSeconds: 6, resolution: provider === "minimax" ? "768P" : "720P", audioMode: "native" }, "冻结横屏"), binding, `attempt-aspect-${provider}-${mode}`);
      if (mode === "recovery") {
        const directory = path.join(fixture.workRoot, seeded.input.attemptId);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "download.mp4"), square);
      } else {
        await port.submit(seeded.input, issueSubmitPermit(seeded.input.attemptId, 1));
        if (provider === "minimax") (stub.state as MiniMaxStubState).taskStatus = "succeeded";
        else (stub.state as WanStubState).taskStatus = "SUCCEEDED";
      }
      const bad = await port.query(seeded.query);
      assert.equal(bad.state, "failed");
      assert.match(bad.message ?? "", /640x640.*16:9/);
      assert.equal(attemptOutput(fixture.db, seeded.input.attemptId)?.blob_id ?? null, null);
      assert.equal((await port.query(seeded.query)).observationId, bad.observationId, "失败收据稳定，无重复下载");
    }
    assert.equal(stub.state.posts.length, 1, "本地完整文件恢复无 create");
    assert.equal(stub.state.downloads, 1);
  }
});

it("F09：有效 A 受理后先切 B 再首次 submit，三条新通道仍按 A 冻结版本执行/查询/停止", async t => {
  await withSpeechAssets(async (mp3, wrong) => {
    for (const channel of ["minimax-speech", "minimax-video", "wan-video"] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), `vf-g3-frozen-${channel}-`));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const speech = channel === "minimax-speech", wan = channel === "wan-video";
      const protocol = wan ? "wan" as const : "minimax" as const;
      const kind = speech ? "speech" as const : "video" as const;
      const modelA = speech ? "speech-2.8-turbo" : wan ? "wan3.0-video" : "MiniMax-H3";
      const modelB = speech ? "speech-2.8-hd" : wan ? "wan3.0-video-prime" : "MiniMax-H3-Max";
      const baseA = wan ? "https://ws-frozen-a.cn-beijing.maas.aliyuncs.com" : "https://api.minimax.cn";
      const baseB = wan ? "https://ws-frozen-b.cn-beijing.maas.aliyuncs.com" : "https://api.minimax.io";
      const stub = speech ? await startSpeechStub(mp3, wrong) : wan ? await startWanStub(Buffer.alloc(0), Buffer.alloc(0)) : await startMiniMaxStub(Buffer.alloc(0), Buffer.alloc(0));
      t.after(() => closeServer(stub.server));
      const wire: { url: string; key: string | null; method: string }[] = [];
      const routedFetch: typeof fetch = async (input, init) => {
        const original = new URL(String(input));
        wire.push({ url: original.href, key: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
        return fetch(new URL(original.pathname, stub.baseUrl), init);
      };
      const runtime = await createAgentRuntime({ dataDir: directory, skillsRoot: defaultSkillsRoot, providerConnections: true,
        host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
        models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "fixture", configurationRevisionId: "frozen-test" }, name: "Faux", kind: "text", features: [], availability: "configured", verificationNote: "协议测试", isDefault: true }],
        defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
        text: { factory: db => { initializeTextModelSettings(db, staticClock); return { models: () => [], defaultBinding: () => null, resolve: () => null }; } },
        media: { autoStart: false, factory: (db, blobs) => {
          const workRoot = path.join(directory, "work");
          const port = speech ? new MiniMaxSpeechPort(db, blobs, staticClock, { workRoot, fetchImpl: routedFetch, resolve: binding => resolveMinimaxSpeechBinding(db, binding) })
            : wan ? new WanVideoPort(db, blobs, staticClock, { workRoot, fetchImpl: routedFetch, resolve: binding => resolveWanVideoBinding(db, binding) })
            : new MiniMaxVideoPort(db, blobs, staticClock, { workRoot, fetchImpl: routedFetch, resolve: binding => resolveMinimaxVideoBinding(db, binding) });
          return { port: new RealMediaGateway(new LocalRenderPort(db, blobs, staticClock, { workRoot }), { resolveProviderPort: binding => {
            const resolved = speech ? resolveMinimaxSpeechBinding(db, binding) : wan ? resolveWanVideoBinding(db, binding) : resolveMinimaxVideoBinding(db, binding);
            return resolved ? port : null;
          }, clock: staticClock }), catalog: () => additionalMediaCatalog(db, true), models: () => [] };
        } },
      });
      t.after(() => runtime.close());
      const db = runtime.database;
      let sequence = 0;
      const save = (modelId: string, baseUrl: string, apiKey: string) => saveProviderConnection(db, staticClock, "local-owner", {
        commandId: `frozen-${channel}-${++sequence}`, expectedRevision: readProviderConnections(db).revision,
        connection: { id: `conn-${channel}`, name: channel, protocol, baseUrl, apiKey, enabled: true,
          models: [{ id: `model-${channel}`, kind, name: modelId, modelId, features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: true }] },
      });
      save(modelA, baseA, "fake-frozen-key-A");
      const bindingA = JSON.parse(readAdditionalMediaCurrent(db, channel)!.version.binding_json) as ModelBinding;
      const conversation = runtime.service.createConversation("local-owner", { commandId: "create-frozen", title: channel }).conversation;
      const spec: ProductionIntent = { workId: null, title: channel, inputRevisions: [],
        operations: [speech
          ? { operationId: "media", outputSlot: "media", kind: "speech", model: bindingA, inputs: [{ kind: "text", text: "冻结 A 的旁白。" }], maxCreateAttempts: 1, parameters: { voiceId: MINIMAX_SPEECH_VOICE, format: "mp3" } }
          : { operationId: "media", outputSlot: "media", kind: "video", model: bindingA, inputs: [{ kind: "text", text: "冻结 A 的黄昏山谷。" }], maxCreateAttempts: 1,
            parameters: { durationSeconds: 6, resolution: wan ? "720P" : "768P", aspectRatio: "16:9", audioMode: "native" } }],
        finalOutput: { operationId: "media", outputSlot: "media" }, maxSpend: { currency: "CNY", amountMinor: 5000 } };
      const work = ensurePlanStageWork(db, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, channel);
      spec.workId = work.workId;
      const prepared = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: "prepare-A", spec });
      bindPreparedPlan(db, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, prepared.proposal, work);
      const admitted = runtime.service.acceptProposal("local-owner", prepared.proposal.id, { commandId: "accept-A", proposalDigest: prepared.proposal.digest });
      assert.equal(wire.length, 0, "受理不等于已submit");
      save(modelB, baseB, "fake-frozen-key-B");
      await runtime.worker!.pollOnce();
      const afterSubmit = runtime.service.getRun("local-owner", admitted.run.id);
      if (!speech) {
        runtime.service.cancelRun("local-owner", admitted.run.id, { commandId: "stop-A", expectedRevision: afterSubmit.revision });
        if (wan) (stub.state as WanStubState).taskStatus = "PENDING";
        await runtime.worker!.pollOnce();
      } else {
        assert.equal(afterSubmit.state, "succeeded");
        await runtime.worker!.pollOnce();
      }
      assert.ok(wire.length > 0);
      assert.ok(wire.every(request => request.url.startsWith(baseA + "/") && request.key === "Bearer fake-frozen-key-A"), "首次submit以及后续query/cancel均使用有效A，未借当前B");
      const posts = stub.state.posts as { body: any }[];
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.body.model, modelA);
      if (speech) assert.equal(wire.length, 1, "配音停止/query只有本地事实，不增加请求");
      else if (wan) assert.equal((stub.state as WanStubState).cancels, 1);
      else assert.equal((stub.state as MiniMaxStubState).deletes, 0);
      const bindingB = JSON.parse(readAdditionalMediaCurrent(db, channel)!.version.binding_json) as ModelBinding;
      assert.equal(bindingB.modelId, modelB);
      assert.notEqual(bindingB.configurationRevisionId, bindingA.configurationRevisionId);
      const nextSpec = structuredClone(spec); nextSpec.operations[0]!.model = bindingB;
      const next = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: "prepare-B", spec: nextSpec });
      assert.equal(next.proposal.spec.operations[0]!.model?.configurationRevisionId, bindingB.configurationRevisionId, "新提案才使用B");
    }
  });
});

// —— 时长衔接（§11.3）：视频裁切上界按冻结 durationSeconds 计算 ——

describe("duration bound (M2 §11.3)", () => {
  it("10 秒视频取后半段的提案可用；8 秒同窗被拒，报价按实际秒数", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-m2-duration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const narrationFile = path.join(directory, "narration.mp3");
    await makeMp3(narrationFile, 2);
    const narrationBuffer = readFileSync(narrationFile);
    const narrationMs = (await probeAudioFile(narrationFile)).durationMs;

    const runtime = await createAgentRuntime({
      dataDir: directory, skillsRoot: defaultSkillsRoot,
      host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
      models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
        name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
        verificationNote: "离线 Faux 文本模型", isDefault: true }],
      defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
      media: { autoStart: false, factory: (db, blobs) => {
        if (!db.prepare("SELECT 1 FROM additional_media_settings WHERE channel_id='wan-video'").get()) {
          const profile = wanVideoProfile("wan3.0-video", "https://ws.cn-beijing.maas.aliyuncs.com")!;
          const binding = wanVideoBinding(profile, newAgentId("conn-wan"));
          insertAdditionalMediaVersion(db, staticClock(), "wan-video", binding, profile, "wan-prepare-key");
          db.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('wan-video',0,?,?,?)")
            .run(`万相视频（${profile.modelId}）`, binding.configurationRevisionId, staticClock());
        }
        return {
          port: new LocalRenderPort(db, blobs, staticClock, { workRoot: path.join(directory, "media-work") }),
          catalog: () => ({ "render:timed_narrated_concat": timedNarratedRenderCatalogEntry(), ...additionalMediaCatalog(db, true) }),
          models: () => [],
        };
      } },
    });
    t.after(() => runtime.close());
    const db = runtime.database;
    const conversation = runtime.service.createConversation("local-owner", { commandId: "m2-dur-1", title: "时长衔接" }).conversation;
    const wanBinding = JSON.parse(readAdditionalMediaCurrent(db, "wan-video")!.version.binding_json) as ModelBinding;

    // 旁白修订：真实 2s MP3，落在 5s 后半段画面内。
    const blob = runtime.production!.blobs.persist("local-owner", conversation.id, narrationBuffer, "audio/mpeg", narrationMs);
    const content = { format: "media" as const, blobId: blob.id, mimeType: "audio/mpeg", durationMs: narrationMs };
    const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = staticClock();
    const seq = (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversation.id) as { n: number }).n;
    db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)")
      .run(artifactId, conversation.id, "local-owner", "旁白", "audio", revisionId, seq, now, now);
    db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,?,?)")
      .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);

    const scope = { ownerId: "local-owner", conversationId: conversation.id };
    const intent = (durationSeconds: number): ProductionIntent => ({
      workId: null, title: "十秒镜头取后半段",
      inputRevisions: [{ artifactId, revisionId }],
      operations: [
        { operationId: "shot", outputSlot: "shot", kind: "video" as const, model: wanBinding,
          inputs: [{ kind: "text" as const, text: "山路全景，缓慢推进。" }], maxCreateAttempts: 1 as const,
          parameters: { durationSeconds, aspectRatio: "16:9" as const, resolution: "720P", audioMode: "native" as const } },
        { operationId: "render", outputSlot: "final", kind: "render" as const, model: null,
          inputs: [{ kind: "operation_output" as const, producerOperationId: "shot", outputSlot: "shot" },
            { kind: "artifact_revision" as const, artifactId, revisionId, digest: digestOf(content) }],
          maxCreateAttempts: 1 as const,
          parameters: { assembly: "timed_narrated_concat" as const, format: "mp4" as const, width: 1280, height: 720, fps: 24,
            segments: [{ kind: "video" as const, inputSlot: 0, startMs: 5_000, durationMs: 5_000 }], narrationInputSlot: 1 } },
      ],
      finalOutput: { operationId: "render", outputSlot: "final" },
      maxSpend: { currency: "CNY" as const, amountMinor: 600 },
    });

    const work = ensurePlanStageWork(db, staticClock(), scope, "十秒镜头");
    const acceptedSpec = intent(10);
    acceptedSpec.workId = work.workId;
    const prepared = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: "m2-dur-2", spec: acceptedSpec });
    bindPreparedPlan(db, staticClock(), scope, prepared.proposal, work);
    const videoOp = prepared.proposal.spec.operations[0] as { quotePerAttempt: { amountMinor: number } };
    assert.equal(videoOp.quotePerAttempt.amountMinor, 600, "报价按 10 秒 × ¥0.60/秒");

    // 对照组：同一后半段窗口对 8 秒视频超出冻结时长，prepare 在付费前拒绝。
    const rejectedSpec = intent(8);
    rejectedSpec.workId = work.workId;
    await assert.rejects(
      runtime.service.prepareProposal("local-owner", conversation.id, { commandId: "m2-dur-3", spec: rejectedSpec }),
      (error: { code?: string; message?: string }) => error.code === "INVALID_INPUT" && /超出该视频可用时长 8\.0s/.test(error.message ?? ""));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0, "拒绝不产生运行");
  });
});
