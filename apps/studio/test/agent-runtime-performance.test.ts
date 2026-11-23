import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, parseStreamingJson, type FauxResponseStep } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { ArtifactDraftStream } from "../src/server/agent/artifact-drafts.js";
import { HistoryImageCache, resizeImageForModel } from "../src/server/agent/image-projection.js";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { createWork } from "../src/server/agent/creative-work.js";
import { productionHarness } from "./helpers/production-harness.js";
import type { ArtifactDraft } from "../src/shared/agent/generated/contracts.js";

async function directory(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "frame-runtime-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function countReads(t: TestContext, db: Database.Database, onRead: (sql: string) => void) {
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Database.Statement;
  for (const method of ["get", "all", "iterate"] as const) {
    const call = proto[method];
    t.mock.method(proto, method, function(this: Database.Statement, ...args: unknown[]) {
      onRead(this.source); return Reflect.apply(call, this, args);
    });
  }
}

test("ISS-14 八千字流式脚本在 200ms 窗口内合并解析，完稿和清空仍即时", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const times: number[] = [];
  const frames: ArtifactDraft[] = [];
  let now = 0;
  const stream = new ArtifactDraftStream("req-throttle", draft => frames.push(draft), raw => { times.push(now); return parseStreamingJson(raw); });
  const tool = fauxToolCall("deliver_artifacts", {}, { id: "tool-draft" });
  const partial = fauxAssistantMessage(tool);
  const args = { items: [{ title: "长脚本", kind: "script", content: { format: "markdown", text: "画".repeat(8000) } }] };
  const raw = JSON.stringify(args);
  for (let i = 0; i < raw.length; i += 4) {
    stream.accept({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, partial, delta: raw.slice(i, i + 4) } });
    now++; t.mock.timers.tick(1);
  }
  stream.accept({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial, toolCall: { ...tool, arguments: args } } });
  assert.equal(frames.at(-1)?.items[0]?.text.length, 8000);
  assert.ok(frames.some(frame => frame.items[0]?.text.length && frame.items[0].text.length < 8000));
  assert.ok(times.length > 0 && times.length < raw.length / 40);
  assert.ok(times.every((at, i) => i === 0 || at - times[i - 1]! >= 200));
  stream.close(); t.mock.timers.tick(200);
  assert.equal(frames.at(-1)?.state, "cleared");
  t.diagnostic(JSON.stringify({ deltaCount: Math.ceil(raw.length / 4), parseCount: times.length, times }));
});

test("OPT-02 十张不同参考图十次真实 Pi 缩放与逐步历史投影的 CPU 对照", async t => {
  const root = await directory(t);
  execFileSync("ffmpeg", ["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=1920x1080:rate=10","-frames:v","10","-threads","1","-q:v","3",path.join(root,"image-%02d.jpg")]);
  const blocks = await Promise.all(Array.from({ length: 10 }, async (_, i) => ({ mimeType: "image/jpeg", data:
    (await readFile(path.join(root, `image-${String(i + 1).padStart(2,"0")}.jpg`))).toString("base64") })));
  await resizeImageForModel(Buffer.from(blocks[0]!.data, "base64"), "image/jpeg");
  async function time(run: (block: typeof blocks[number]) => ReturnType<typeof resizeImageForModel>) {
    const start = process.cpuUsage();
    for (let step = 0; step < 10; step++) for (const block of blocks) {
      const output = await run({ ...block });
      assert.ok(output.data.length <= 256 * 1024 && output.width <= 1280);
    }
    const used = process.cpuUsage(start); return used.user + used.system;
  }
  const before = await time(block => resizeImageForModel(Buffer.from(block.data,"base64"), block.mimeType));
  let resizes = 0;
  const cache = new HistoryImageCache((data, mime) => { resizes++; return resizeImageForModel(data, mime); });
  const after = await time(block => cache.read(block));
  assert.equal(resizes, 10);
  t.diagnostic(JSON.stringify({ beforeCpuMs: before / 1000, afterCpuMs: after / 1000, reduction: 1 - after / before }));
  assert.ok(after < before * 0.15);
});

test("OPT-02 历史图片按内容合并并发读取，命中更新 LRU 顺序，缩放失败可重读", async () => {
  let attempts = 0;
  let failedImage = false;
  const cache = new HistoryImageCache(async (bytes, mimeType) => {
    attempts++;
    if (bytes[0] === 128 && !failedImage) { failedImage = true; throw new Error("invalid test image"); }
    return { data: Buffer.from(bytes).toString("base64"), mimeType,
      originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false };
  });
  const image = (value: number) => ({ data: Buffer.from([value]).toString("base64"), mimeType: "image/png" });
  const results = await Promise.all([cache.read(image(0)), cache.read(image(0))]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(attempts, 1);
  for (let value = 1; value < 64; value++) await cache.read(image(value));
  await cache.read(image(0));
  await cache.read(image(64));
  await cache.read(image(0));
  assert.equal(attempts, 65);
  await cache.read(image(1));
  assert.equal(attempts, 66, "最近访问的 0 保留，较早的 1 被移除");
  await cache.read({ ...image(0), mimeType: "image/jpeg" });
  assert.equal(attempts, 67);
  await assert.rejects(cache.read(image(128)), /invalid test image/);
  await cache.read(image(128));
  assert.equal(attempts, 69);
});

test("OPT-02 二十件作品十次工具调用在真实 Pi context 钩子内逐步计数", async t => {
  const root = await directory(t);
  const app = await assembleOfflineAgent({ dataDir: root, uiOrigin: "http://127.0.0.1:4318", fauxTokensPerSecond: 0 });
  t.after(() => app.close());
  const owner = "local-owner";
  const id = app.service.createConversation(owner, { commandId: "measure-context", title: "二十条短片" }).conversation.id;
  const db = app.database;
  const works = Array.from({ length: 20 }, (_, i) => createWork(db, new Date().toISOString(), { ownerId: owner, conversationId: id }, `短片 ${i}`));
  const selection = await app.host.modelForBinding(app.service.bootstrap(owner).models[0]!.binding);
  const seed = await app.host.openConversationSession(id, "s1", undefined, [], selection);
  execFileSync("ffmpeg", ["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=480x270:rate=10","-frames:v","10","-threads","1",path.join(root,"story-%02d.jpg")]);
  const images = await Promise.all(Array.from({ length: 10 }, async (_, i) => ({ type: "image" as const, mimeType: "image/jpeg",
    data:(await readFile(path.join(root,`story-${String(i+1).padStart(2,"0")}.jpg`))).toString("base64") })));
  seed.session.sessionManager.appendMessage({ role:"user", content:images, timestamp:Date.now() });
  const prior=fauxAssistantMessage("已收到十张不同的参考图。");
  prior.provider=selection.model.provider; prior.model=selection.model.id;
  seed.session.sessionManager.appendMessage(prior); seed.session.dispose();
  const now=new Date().toISOString(), put=db.prepare("INSERT INTO artifacts(id,owner_id,conversation_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,'分镜稿','script',?,?,1,?,?,?)");
  db.transaction(()=>{
    const revision=db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,'{\"format\":\"markdown\",\"text\":\"分镜\"}',?)");
    for (let i=0;i<50;i++) {put.run("art-"+i,owner,id,works[i%20]!.id,"rev-"+i,i+1,now,now);revision.run("rev-"+i,"art-"+i,"digest-"+i,now);}
  })();
  const counts: number[] = [];
  let active = false, count = 0;
  countReads(t, db, () => { if (active) count++; });
  const open = app.host.openConversationSession.bind(app.host);
  t.mock.method(app.host, "openConversationSession", (...args: Parameters<typeof open>) => {
    const context = args[6]!;
    args[6] = () => {
      count = 0; active = true;
      try { const result = context(); assert.ok(result?.includes(works[0]!.id)); return result; }
      finally { active = false; counts.push(count); }
    };
    return open(...args);
  });
  let completedReads = 0;
  let coldUsage: number | undefined;
  const responses: FauxResponseStep[] = works.slice(0,10).map((w,i) =>
    context => {
      const projected = context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []);
      assert.equal(projected.length,10);
      if (i === 1) {
        const previous = context.messages.find(message => message.role === "assistant" && message.usage.totalTokens > 0);
        assert.ok(previous?.role === "assistant");
        coldUsage = previous.usage.totalTokens;
      }
      completedReads++;
      return fauxAssistantMessage(fauxToolCall("read_work", { workId: w.id }, { id: `work-read-${i}` }));
    });
  responses.push(fauxAssistantMessage("已核对十件作品。"));
  app.faux!.setResponses(responses);
  const reply = await app.service.sendMessage(owner, id, { commandId:"long-context-read", text:"逐件读取十件作品", target:null, skillId:null,
    proposalRef:null, mode:"new", steerRequestId:null });
  const state = db.prepare("SELECT state FROM requests WHERE id=?").pluck();
  const started = performance.now();
  while (["queued","running"].includes(state.get(reply.receipt.requestId) as string)) {
    assert.ok(performance.now()-started < 30_000, "长会话没有到达终态"); await delay(10);
  }
  assert.equal(state.get(reply.receipt.requestId), "completed");
  assert.equal(completedReads, 10);
  assert.equal(counts.length, 11);
  assert.ok(counts.every(n => n > 0 && n <= 6));
  t.diagnostic(JSON.stringify({ works: works.length, perModelStep: counts, coldUsage }));
});

test("OPT-03 空队列一天只执行 2880 次巡检查询", async t => {
  const h = productionHarness(await directory(t), new Date().toISOString());
  t.after(() => h.close());
  t.mock.timers.enable({ apis:["setTimeout"] });
  let queries = 0;
  countReads(t, h.db, () => queries++);
  h.worker.start();
  for (let i=0; i<2880; i++) t.mock.timers.tick(i === 0 ? 1 : 30_000);
  assert.equal(queries,2880);
});

test("OPT-03 提案合法受理提交后立即唤醒生产端口", async t => {
  const h = productionHarness(await directory(t), new Date().toISOString());
  t.after(() => h.close());
  h.service.on("work", () => h.worker.poke());
  h.worker.start();
  await delay(15);
  let acceptAt = 0, submitAt = 0;
  const submit = h.port.submit.bind(h.port);
  t.mock.method(h.port, "submit", (...args: Parameters<typeof submit>) => { submitAt = performance.now(); return submit(...args); });
  h.accept(); acceptAt = performance.now();
  while (!submitAt) { assert.ok(performance.now()-acceptAt < 500); await delay(1); }
  t.diagnostic(JSON.stringify({ confirmToSubmitMs: submitAt - acceptAt })); assert.ok(submitAt - acceptAt < 20);
});
