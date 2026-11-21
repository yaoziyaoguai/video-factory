import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { AgentService } from "../src/server/agent/agent-service.js";
import { EventHub } from "../src/server/agent/event-log.js";
import { createWork } from "../src/server/agent/creative-work.js";
import { offlineServiceOptions } from "./helpers/agent-service-options.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import { encodeEventCursor } from "../src/server/agent/paging.js";

// R6 慢连接拼错进行中回复 + R7 重连事件流重复读取作品状态 的路由级验收。
// 手法沿用审计取证（output/audits/…/evidence/local-probes.mjs）：hook raw.write 让首帧
// delta 真实写入后返回 false（模拟套接字高水位），hook db.prepare / service.snapshot 计数。
// 修复后的正确行为：
//  - R6：暂态帧写不进时立即收流（连接结束，不再静默丢帧后继续送“甲丙”式残缺文本）；
//  - R7：SSE 握手只做归属核对，不再全量组装快照（0 次快照、0 次逐作品定稿查询）。
test("R6/R7：慢读时暂态增量写不进即收流；SSE 握手不再重复组装快照", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-stream-fix-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const hub = new EventHub();
  let moment = "2026-11-01T01:00:00.000Z";
  const service = new AgentService(offlineServiceOptions({ db, clock: () => moment, hub }));
  const owner = "local-owner";

  const conversation = service.createConversation(owner, { commandId: "cmd-stream", title: "慢读核对" }).conversation;
  const id = conversation.id;
  db.transaction(() => {
    for (let index = 1; index <= 51; index += 1) createWork(db, moment, { conversationId: id, ownerId: owner }, `测试作品 ${index}`);
  })();

  let finalizeQueries = 0;
  let snapCalls = 0;
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.includes("SELECT item_id, subject_json") && sql.includes("action = 'finalize_video'")) finalizeQueries += 1;
    return prepare(sql);
  };
  const snapshot = service.snapshot.bind(service);
  (service as unknown as { snapshot: (...args: unknown[]) => unknown }).snapshot = (...args: unknown[]) => {
    snapCalls += 1;
    return (snapshot as (...rest: unknown[]) => unknown)(...args);
  };

  const fresh = service.snapshot(owner, id);
  assert.equal(fresh.works.length, 50, "对照：快照仍只给最新 50 件（作品分页由 R8 另行处理）");
  const finalizeAfterSnapshot = finalizeQueries;

  let raw: { write: (...args: unknown[]) => boolean; end: () => void } | undefined;
  let blockFirstDelta = true;
  let announceSubscribed: (() => void) | undefined;
  const subscribed = new Promise<void>(resolve => { announceSubscribed = resolve; });
  const subscribeDeltas = hub.subscribeDeltas.bind(hub);
  (hub as unknown as { subscribeDeltas: typeof hub.subscribeDeltas }).subscribeDeltas = (...args: Parameters<typeof hub.subscribeDeltas>) => {
    const unsubscribe = subscribeDeltas(...args);
    announceSubscribed?.();
    return unsubscribe;
  };

  const app = buildFrameApp({ agent: { service, resolveOwner: () => owner, uiOrigin: "http://127.0.0.1" } });
  t.after(async () => { await app.close(); });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.includes("/events?")) return;
    raw = reply.raw as unknown as { write: (...args: unknown[]) => boolean; end: () => void };
    const write = reply.raw.write.bind(reply.raw);
    (reply.raw as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
      const result = write(...(args as Parameters<typeof write>));
      // 首帧 delta 真实写入后谎报高水位：模拟慢客户端把套接字缓冲写满。
      if (blockFirstDelta && String(args[0]).startsWith("event: text.delta")) { blockFirstDelta = false; return false; }
      return result;
    };
  });

  // 归属核对仍生效：不存在的会话（游标属主正确）握手直接 404。
  const missing = await app.inject({ url: `/api/agent/v1/conversations/cnv-missing/events?cursor=${encodeURIComponent(encodeEventCursor("cnv-missing", 0))}` });
  assert.equal(missing.statusCode, 404, "归属/存在性核对仍拒绝未知会话");

  const baselineSnapshots = snapCalls;
  const subscription = app.inject({ url: `/api/agent/v1/conversations/${id}/events?cursor=${encodeURIComponent(fresh.eventCursor)}` });
  await Promise.race([subscribed, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE 订阅未建立")), 3_000))]);

  // R7：握手只做归属核对——没有第二次完整快照，也没有逐作品定稿查询。
  assert.equal(snapCalls - baselineSnapshots, 0, "SSE 握手不再全量组装快照");
  assert.equal(finalizeQueries - finalizeAfterSnapshot, 0, "SSE 握手不再逐作品查询定稿信息");

  const emit = (sequence: number, text: string) =>
    hub.emitDelta(id, { requestId: "offline-stream", messageId: "msg-offline-stream", sequence, text });
  emit(0, "甲");
  emit(1, "乙");
  emit(2, "丙");
  const result = await subscription;
  const frames = [...result.body.matchAll(/event: text\.delta\ndata: ([^\n]+)/g)].map(match => JSON.parse(match[1] as string) as { text: string; sequence: number });
  // R6：首帧真实写入后遇高水位 → 立即收流。连接正常结束（客户端将重连取新快照），
  // 后续帧不再进入这条流；绝不允许“甲丙”式静默丢帧后继续拼接。
  assert.equal(frames.map(frame => frame.text).join(""), "甲");
  assert.equal(result.statusCode, 200);
});
