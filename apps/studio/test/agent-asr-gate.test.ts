import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CreateSubtitleTrack, RevisionRef, SubtitleReceipt } from "../src/shared/agent/generated/contracts.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import { getArtifactRow, insertRevision } from "../src/server/agent/artifact-store.js";
import { nextSeq } from "../src/server/agent/conversation-store.js";
import { requireWork } from "../src/server/agent/creative-work.js";
import { createSubtitle } from "../src/server/agent/subtitle-service.js";
import { seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import { buildLocalRuntime } from "./helpers/native-render.js";

// 离线识音（faster-whisper）的三处边界：同一时刻只放行一个子进程、客户端断开即回收子进程、
// 子进程被信号结束时给出可读的失败原因。真的模型另由实际音轨验证，这里用假的解释器演出各种结局。

// 假的识音解释器：把 pid 与被识别的文件记进 calls.log，再按模式演出一种结局；hang 最多停 8 秒。
const STUB_PYTHON = `#!/bin/sh
echo "$$ $4" >> "$FRAME_TEST_ASR_STUB_DIR/calls.log"
case "$FRAME_TEST_ASR_STUB_MODE" in
  hang) trap 'echo $$ >> "$FRAME_TEST_ASR_STUB_DIR/terminated.log"; exit 143' TERM
        i=0; while [ $i -lt 160 ]; do sleep 0.05; i=$((i+1)); done ;;
  killed) sleep 0.3; kill -9 $$ ;;
  crash) echo "Traceback (most recent call last): boom" >&2; exit 1 ;;
esac
echo '{"words":[{"text":"开场","offsetMs":100,"durationMs":400},{"text":"Frame","offsetMs":520,"durationMs":380}],"starts":[100],"ends":[900]}'
`;
const REFUSED_WHILE_BUSY = "当前已有语音识别任务正在进行，请稍候再试。";

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "frame-asr-gate-"));
  const asrHome = path.join(root, "asr-home"), records = path.join(root, "records");
  await mkdir(path.join(asrHome, "bin"), { recursive: true });
  await mkdir(path.join(asrHome, "model"));
  await mkdir(records);
  await writeFile(path.join(asrHome, "transcribe.py"), "# 由假的 bin/python 代替执行\n");
  await writeFile(path.join(asrHome, "bin", "python"), STUB_PYTHON, { mode: 0o755 });
  const saved = { FRAME_ASR_HOME: process.env.FRAME_ASR_HOME, FRAME_TEST_ASR_STUB_DIR: process.env.FRAME_TEST_ASR_STUB_DIR, FRAME_TEST_ASR_STUB_MODE: process.env.FRAME_TEST_ASR_STUB_MODE };
  Object.assign(process.env, { FRAME_ASR_HOME: asrHome, FRAME_TEST_ASR_STUB_DIR: records });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return rm(root, { recursive: true, force: true });
  });

  const runtime = await buildLocalRuntime(root);
  const owner = "editor", origin = "http://frame-asr-gate.test", clock = () => "2026-11-24T00:00:00.000Z";
  const app = buildFrameApp({ agent: { service: runtime.service, uiOrigin: origin, resolveOwner: () => owner } });
  t.after(async () => { await app.close(); await runtime.close(); });
  const db = runtime.database;
  const conversationId = runtime.service.createConversation(owner, { commandId: "room", title: "识音并发" }).conversation.id;
  const workId = seedConfirmedWork(db, clock(), { ownerId: owner, conversationId }).workId;
  // 没有配音词边界的音频修订才会走离线识音；假的解释器不解码文件内容。
  const audio = path.join(root, "voice.wav");
  await writeFile(audio, "RIFF....WAVEfmt ");
  const blob = await runtime.production!.blobs.persistFromFileAsync(owner, conversationId, audio, "audio/wav", 3000);
  const now = clock();
  db.prepare(
    "INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?)",
  ).run("source-voice", conversationId, owner, "原声", "audio", nextSeq(db, "artifacts", conversationId), now, now);
  const revision = insertRevision(db, now, getArtifactRow(db, owner, "source-voice")!, null,
    { title: "原声", kind: "audio", content: { format: "media", blobId: blob.id, mimeType: "audio/wav", durationMs: 3000 } }, null, "user_upload");
  const voice: RevisionRef = { artifactId: "source-voice", revisionId: revision.id };

  const setMode = (mode: "hang" | "killed" | "crash" | "ok") => { process.env.FRAME_TEST_ASR_STUB_MODE = mode; };
  const log = async (name: string): Promise<string[]> => {
    try { return (await readFile(path.join(records, name), "utf8")).split("\n").filter(Boolean); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const input = (commandId: string): CreateSubtitleTrack => ({
    commandId, expectedRevision: requireWork(db, owner, conversationId, workId).revision, source: voice, stylePreset: "clean_bottom",
  });
  const headers = { origin, "x-video-factory-request": "studio" };
  const trackUrl = `/api/agent/v1/works/${workId}/subtitle-tracks`;
  return {
    app, owner, workId, headers, trackUrl, setMode, input,
    calls: () => log("calls.log"),
    terminated: () => log("terminated.log"),
    /** 直接调服务函数；signal 模拟调用方中止（Pi 工具路径与断连的路由都走这里）。 */
    create: (commandId: string, signal?: AbortSignal) =>
      createSubtitle(db, runtime.production!.blobs, clock, owner, workId, input(commandId), undefined, signal),
    post: (commandId: string) => app.inject({ method: "POST", url: trackUrl, headers, payload: input(commandId) }),
  };
}

test("BUG-05 离线识音：单槽位门控、断连中止与被信号结束时的可读原因", async t => {
  const fx = await setup(t);

  await t.test("同一时刻只放行一个识音任务：第二个请求立即 QUEUE_FULL，不启动第二个进程", async () => {
    fx.setMode("hang");
    const controller = new AbortController();
    const stopped = assert.rejects(fx.create("first", controller.signal), { name: "AbortError" });
    await until(async () => (await fx.calls()).length === 1, "第一个识音进程启动");

    await assert.rejects(fx.create("second"), { code: "QUEUE_FULL", statusCode: 429, retryAction: "wait", message: REFUSED_WHILE_BUSY });
    const overHttp = await fx.post("second-over-http");
    assert.equal(overHttp.statusCode, 429, overHttp.body);
    assert.deepEqual([overHttp.json().code, overHttp.json().retryAction, overHttp.json().message], ["QUEUE_FULL", "wait", REFUSED_WHILE_BUSY]);
    assert.equal((await fx.calls()).length, 1, "被拒的请求不启动第二个识音进程");

    controller.abort();
    await stopped;
    await until(async () => (await fx.terminated()).length === 1, "中止后第一个识音进程被结束");

    fx.setMode("ok");
    const receipt: SubtitleReceipt = await fx.create("third");
    assert.equal(receipt.workId, fx.workId);
    assert.equal((await fx.calls()).length, 2, "名额归还后新的识音照常启动");
  });

  await t.test("客户端中途断开：路由中止识音子进程，名额归还", async () => {
    fx.setMode("hang");
    await fx.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = fx.app.server.address() as AddressInfo;
    const payload = JSON.stringify(fx.input("socket"));
    const socket = await new Promise<Socket>(resolve => {
      const outgoing = httpRequest({
        host: "127.0.0.1", port, method: "POST", path: fx.trackUrl,
        headers: { ...fx.headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      });
      // 请求是故意被掐断的，客户端这一侧的连接错误在所难免。
      outgoing.on("error", () => undefined);
      outgoing.on("socket", resolve);
      outgoing.end(payload);
    });
    await until(async () => (await fx.calls()).length === 3, "识音进程为这次请求启动");
    const pid = (await fx.calls()).at(-1)!.split(" ")[0]!;

    socket.destroy();
    await until(async () => (await fx.terminated()).includes(pid), "断开后识音进程被结束");

    fx.setMode("ok");
    const after = await fx.post("after-disconnect");
    assert.equal(after.statusCode, 201, after.body);
    assert.equal(after.json().workId, fx.workId);
  });

  await t.test("识音进程被强制结束或异常退出：返回 TEMPORARILY_UNAVAILABLE 并说明原因", async () => {
    fx.setMode("killed");
    const killed = await fx.post("oom");
    assert.equal(killed.statusCode, 503, killed.body);
    assert.equal(killed.json().code, "TEMPORARILY_UNAVAILABLE");
    assert.equal(killed.json().retryAction, "wait");
    assert.match(killed.json().message, /内存/);

    fx.setMode("crash");
    const crash = await fx.post("crash");
    assert.equal(crash.statusCode, 503, crash.body);
    assert.equal(crash.json().code, "TEMPORARILY_UNAVAILABLE");
    assert.equal(crash.json().message, "本地语音识别未完成。识别进程退出：1");

    fx.setMode("ok");
    const recovered = await fx.post("after-failures");
    assert.equal(recovered.statusCode, 201, recovered.body);
    assert.equal(recovered.json().workId, fx.workId);
  });
});
