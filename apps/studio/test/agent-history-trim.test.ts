import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { trimAgentHistory } from "../src/server/agent/history-trim.js";

// 审计第三阶段：裁剪必须按并集保留——时间窗内的全留，窗口外只保留每会话最新 N 条；
// 回执仅按时间窗。被删事件留下的 seq 空洞由 SSE 的 CURSOR_EXPIRED 重同步兜底。
const now = new Date("2026-11-21T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(now.getTime() - days * 86400_000).toISOString();
let conversationSeq = 0;
const insertConversation = (db: AgentDatabase, id: string): void => {
  conversationSeq += 1;
  db.prepare(`INSERT INTO conversations(id, owner_id, title, created_seq, pi_session_id, created_at, updated_at)
    VALUES (?, 'owner-1', 't', ?, 'pi-1', ?, ?)`).run(id, conversationSeq, daysAgo(30), daysAgo(30));
};
const insertEvent = (db: AgentDatabase, conversationId: string, createdAt: string): number =>
  db.prepare(`INSERT INTO events(event_id, conversation_id, owner_id, kind, entity_id, entity_version, notification, created_at)
    VALUES (?, ?, 'owner-1', 'message.changed', 'entity', 1, 'quiet', ?)`).run(
    `ev-${conversationId}-${createdAt}-${Math.random().toString(36).slice(2, 8)}`, conversationId, createdAt).lastInsertRowid as number;
const insertReceipt = (db: AgentDatabase, commandId: string, createdAt: string): void => {
  db.prepare(`INSERT INTO command_receipts(owner_id, operation, target_id, command_id, body_digest, receipt_json, created_at)
    VALUES ('owner-1', 'send', 'target', ?, 'digest', '{}', ?)`).run(commandId, createdAt);
};

test("事件按时间窗与每会话条数并集保留，回执按时间窗", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-trim-"));
  const db = openAgentDatabase(directory);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

  insertConversation(db, "conv-hot");
  insertConversation(db, "conv-cold");
  insertConversation(db, "conv-busy");

  // conv-hot：窗口内 3 条（即便超出每会话条数上限也应保留——时间窗优先）。
  const hot: number[] = [];
  for (let index = 0; index < 3; index += 1) hot.push(insertEvent(db, "conv-hot", daysAgo(1)));
  // conv-cold：窗口外 3 条，仅最新 2 条落在每会话保底内。
  insertEvent(db, "conv-cold", daysAgo(30));
  const coldKept: number[] = [insertEvent(db, "conv-cold", daysAgo(20)), insertEvent(db, "conv-cold", daysAgo(10))];
  // conv-busy：窗口外 5 条，保底 2 条 → 最新 2 条留、最早 3 条删。
  insertEvent(db, "conv-busy", daysAgo(40));
  insertEvent(db, "conv-busy", daysAgo(35));
  insertEvent(db, "conv-busy", daysAgo(30));
  const busyKept: number[] = [insertEvent(db, "conv-busy", daysAgo(25)), insertEvent(db, "conv-busy", daysAgo(15))];

  insertReceipt(db, "receipt-old", daysAgo(30));
  insertReceipt(db, "receipt-new", daysAgo(1));

  const result = trimAgentHistory(db, { now: () => now, retentionMs: 7 * 86400_000, perConversationEvents: 2 });
  assert.equal(result.eventsDeleted, 4);
  assert.equal(result.receiptsDeleted, 1);

  const remaining = (db.prepare("SELECT seq FROM events").all() as { seq: number }[]).map(row => row.seq);
  assert.deepEqual(new Set(remaining), new Set([...hot, ...coldKept, ...busyKept]));

  // 幂等：再次执行不再删除。
  assert.deepEqual(trimAgentHistory(db, { now: () => now, retentionMs: 7 * 86400_000, perConversationEvents: 2 }),
    { eventsDeleted: 0, receiptsDeleted: 0 });
  const receipts = (db.prepare("SELECT command_id FROM command_receipts").all() as { command_id: string }[]).map(row => row.command_id);
  assert.deepEqual(receipts, ["receipt-new"]);
});

test("时间窗内的会话不因条数被裁剪", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-trim-2-"));
  const db = openAgentDatabase(directory);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  insertConversation(db, "conv-live");
  for (let index = 0; index < 5; index += 1) insertEvent(db, "conv-live", daysAgo(1));
  const result = trimAgentHistory(db, { now: () => now, retentionMs: 7 * 86400_000, perConversationEvents: 2 });
  assert.equal(result.eventsDeleted, 0, "活跃会话的事件不受每会话上限影响");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count, 5);
});
