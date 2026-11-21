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
import { AgentError } from "../src/server/agent/errors.js";

// R8 长会话作品可达：快照只载最新 50 件时，更早作品通过 worksNextCursor 续拉到达，
// 50 不再被当作总数——搜索目标（最早作品）必须可达，游标按会话+集合拒绝越权。

test("R8：作品分页——快照 50 件 + worksNextCursor 续拉到最早作品，游标越权拒绝", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-works-page-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const hub = new EventHub();
  let moment = "2026-11-01T01:00:00.000Z";
  const service = new AgentService(offlineServiceOptions({ db, hub, clock: () => moment }));
  const owner = "local-owner";
  const conversation = service.createConversation(owner, { commandId: "cmd-works-page", title: "五十一件作品" }).conversation;
  const id = conversation.id;

  const total = 53;
  db.transaction(() => {
    for (let index = 1; index <= total; index += 1) createWork(db, moment, { conversationId: id, ownerId: owner }, `城市记录 ${index}`);
  })();

  // 快照首页：最新 50 件（旧→新排列与原行为一致），更早 3 件由 worksNextCursor 指引。
  const snap = service.snapshot(owner, id);
  assert.equal(snap.works.length, 50);
  assert.ok(snap.worksNextCursor, "超过 50 件时快照应给出续拉游标");
  assert.equal(snap.works[0]!.title, "城市记录 4", "首页从第 4 件（最新 50 件中最旧）开始");
  assert.equal(snap.works[49]!.title, "城市记录 53");
  assert.ok(!snap.works.some(work => work.title === "城市记录 1"), "最早 3 件不在首页");

  // 续拉：一页取回更早 3 件，含最早的“城市记录 1”，之后 nextCursor 归空。
  const older = service.listWorks(owner, id, snap.worksNextCursor!, undefined);
  assert.equal(older.items.length, 3);
  assert.equal(older.items[0]!.title, "城市记录 1", "最早作品通过续拉可达");
  assert.equal(older.items[2]!.title, "城市记录 3");
  assert.equal(older.nextCursor, null, "没有更早时 nextCursor 为空");
  const all = new Set([...snap.works, ...older.items].map(work => work.id));
  assert.equal(all.size, total, "两页合并无重复、总数完整");

  // 不足 51 件的会话：没有续拉游标，行为与旧快照一致。
  const small = service.createConversation(owner, { commandId: "cmd-small", title: "三件作品" }).conversation;
  db.transaction(() => {
    for (let index = 1; index <= 3; index += 1) createWork(db, moment, { conversationId: small.id, ownerId: owner }, `短会话 ${index}`);
  })();
  const smallSnap = service.snapshot(owner, small.id);
  assert.equal(smallSnap.works.length, 3);
  assert.equal(smallSnap.worksNextCursor, null);

  // 越权：作品游标不能用于别的会话（集合归属在解码层拒绝）。
  assert.throws(() => service.listWorks(owner, small.id, snap.worksNextCursor!, undefined), (error: unknown) => error instanceof AgentError && error.code === "FORBIDDEN");
  // 归属：他人直接列这个会话的作品被拒绝。
  assert.throws(() => service.listWorks("other-owner", id, undefined, undefined), (error: unknown) => error instanceof AgentError && error.code === "NOT_FOUND");
});
