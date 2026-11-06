import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent, type EventHub } from "./event-log.js";
import { canonicalJson, digestOf, newAgentId } from "./util.js";
import type { Conversation, Message, MessageReferences, RequestReceipt, Target } from "../../shared/agent/generated/contracts.js";

// 会话、请求队列与消息的持久操作。全部为短事务内可调用的同步函数；
// 策略（确认短句、目标绑定、限额）在 AgentService，不在这里。

export interface ConversationRow {
  id: string;
  owner_id: string;
  title: string;
  revision: number;
  created_seq: number;
  epoch: number;
  pi_session_id: string;
  pi_checkpoint_json: string | null;
  pi_needs_recovery: number;
  created_at: string;
  updated_at: string;
}

export interface RequestRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  command_id: string;
  text: string;
  target_json: string | null;
  skill_id: string | null;
  model_id: string | null;
  model_binding_json: string | null;
  mode: "new";
  queue_seq: number;
  state: "queued" | "running" | "completed" | "stopped" | "failed";
  execution_epoch: number | null;
  stop_requested: number;
  delivery_closed: number;
  message_id: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  request_id: string | null;
  role: "user" | "assistant" | "system_notice";
  kind: "chat" | "feedback" | "notice";
  state: "queued" | "running" | "completed" | "stopped" | "failed";
  revision: number;
  text: string;
  target_json: string | null;
  references_json: string;
  feedback_json: string | null;
  created_seq: number;
  created_at: string;
  updated_at: string;
}

export function rowToConversation(row: ConversationRow): Conversation {
  return { id: row.id, title: row.title, revision: row.revision, updatedAt: row.updated_at };
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    requestId: row.request_id,
    role: row.role,
    text: row.text,
    state: row.state,
    revision: row.revision,
    target: row.target_json ? (JSON.parse(row.target_json) as Target) : null,
    createdAt: row.created_at,
    createdSequence: row.created_seq,
    references: { ...emptyReferences(), ...JSON.parse(row.references_json) as MessageReferences },
    kind: row.kind,
    feedback: row.feedback_json ? (JSON.parse(row.feedback_json) as Message["feedback"]) : null,
  };
}

export function emptyReferences(): MessageReferences {
  return { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] };
}

export function getConversation(db: AgentDatabase, ownerId: string, conversationId: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ? AND owner_id = ?").get(conversationId, ownerId) as ConversationRow | undefined;
}

export function requireConversation(db: AgentDatabase, ownerId: string, conversationId: string): ConversationRow {
  const row = getConversation(db, ownerId, conversationId);
  // 归属之外的会话一律 404，不泄漏存在性。
  if (!row) throw new AgentError("NOT_FOUND", "没有找到这个会话。");
  return row;
}

export function nextSeq(db: AgentDatabase, table: "messages" | "artifacts" | "proposals" | "conversations", conversationId?: string): number {
  if (table === "conversations") {
    const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM conversations WHERE owner_id = ?").get(conversationId!) as { seq: number };
    return row.seq + 1;
  }
  const row = db.prepare(`SELECT COALESCE(MAX(created_seq), 0) AS seq FROM ${table} WHERE conversation_id = ?`).get(conversationId!) as { seq: number };
  return row.seq + 1;
}

export function insertConversation(
  db: AgentDatabase,
  now: string,
  row: { id: string; ownerId: string; title: string; createdSeq: number; piSessionId: string },
): void {
  db.prepare(
    `INSERT INTO conversations(id, owner_id, title, revision, created_seq, epoch, pi_session_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)`,
  ).run(row.id, row.ownerId, row.title, row.createdSeq, row.piSessionId, now, now);
}

export function renameConversationRow(
  db: AgentDatabase,
  now: string,
  ownerId: string,
  conversationId: string,
  title: string,
  expectedRevision: number,
): ConversationRow {
  const conversation = requireConversation(db, ownerId, conversationId);
  if (conversation.revision !== expectedRevision) {
    throw new AgentError("STALE_REVISION", "会话已更新，请刷新后重试。", { currentRevisionId: null });
  }
  const info = db.prepare("UPDATE conversations SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
    .run(title, now, conversationId, expectedRevision);
  if (info.changes !== 1) throw new AgentError("STALE_REVISION", "会话已更新，请刷新后重试。", { currentRevisionId: null });
  insertEvent(db, now, {
    conversationId, ownerId, kind: "conversation.changed", entityId: conversationId, entityVersion: expectedRevision + 1,
  });
  return getConversation(db, ownerId, conversationId)!;
}

export function touchConversation(db: AgentDatabase, now: string, conversationId: string): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
}

export function listConversations(db: AgentDatabase, ownerId: string, limit: number, beforeSeq?: number): ConversationRow[] {
  const sql = beforeSeq === undefined
    ? "SELECT * FROM conversations WHERE owner_id = ? ORDER BY created_seq DESC LIMIT ?"
    : "SELECT * FROM conversations WHERE owner_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?";
  return (beforeSeq === undefined
    ? db.prepare(sql).all(ownerId, limit)
    : db.prepare(sql).all(ownerId, beforeSeq, limit)) as ConversationRow[];
}

export function maxConversationSeq(db: AgentDatabase, ownerId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM conversations WHERE owner_id = ?").get(ownerId) as { seq: number };
  return row.seq;
}

// —— 请求队列 ——

export function pendingRequestCount(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE conversation_id = ? AND state = 'queued'").get(conversationId) as { count: number };
  return row.count;
}

export function nextQueueSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(queue_seq), 0) AS seq FROM requests WHERE conversation_id = ?").get(conversationId) as { seq: number };
  return row.seq + 1;
}

export function insertQueuedRequest(
  db: AgentDatabase,
  now: string,
  input: {
    id: string; conversationId: string; ownerId: string; commandId: string; text: string;
    target: Target | null; skillId: string | null; modelId: string | null; queueSeq: number;
    messageId: string;
  },
): void {
  db.prepare(
    `INSERT INTO requests(id, conversation_id, owner_id, command_id, text, target_json, skill_id, model_id, mode,
      queue_seq, state, execution_epoch, stop_requested, delivery_closed, message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, 'queued', NULL, 0, 0, ?, ?, ?)`,
  ).run(input.id, input.conversationId, input.ownerId, input.commandId, input.text,
    input.target ? JSON.stringify(input.target) : null, input.skillId, input.modelId, input.queueSeq, input.messageId, now, now);
}

// 领取下一个排队请求并建立 executionEpoch；同一会话同一时刻至多一个 running。
export interface ClaimedRequest {
  row: RequestRow;
  epoch: number;
}

export function claimNextRequest(db: AgentDatabase, now: string, conversationId: string): ClaimedRequest | null {
  const next = db.prepare(
    "SELECT * FROM requests WHERE conversation_id = ? AND state = 'queued' ORDER BY queue_seq ASC LIMIT 1",
  ).get(conversationId) as RequestRow | undefined;
  if (!next) return null;
  const epoch = bumpEpoch(db, conversationId);
  db.prepare("UPDATE requests SET state = 'running', execution_epoch = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
    .run(epoch, now, next.id);
  db.prepare("UPDATE messages SET state = 'running', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, next.message_id);
  insertEvent(db, now, {
    conversationId, ownerId: next.owner_id, kind: "message.changed", entityId: next.message_id,
    entityVersion: messageRevision(db, next.message_id),
  });
  return { row: { ...next, state: "running", execution_epoch: epoch }, epoch };
}

function messageRevision(db: AgentDatabase, messageId: string): number {
  const row = db.prepare("SELECT revision FROM messages WHERE id = ?").get(messageId) as { revision: number };
  return row.revision;
}

export function bumpEpoch(db: AgentDatabase, conversationId: string): number {
  db.prepare("UPDATE conversations SET epoch = epoch + 1 WHERE id = ?").run(conversationId);
  return (db.prepare("SELECT epoch FROM conversations WHERE id = ?").get(conversationId) as { epoch: number }).epoch;
}

export function getRequestRow(db: AgentDatabase, ownerId: string, requestId: string): RequestRow | undefined {
  return db.prepare("SELECT * FROM requests WHERE id = ? AND owner_id = ?").get(requestId, ownerId) as RequestRow | undefined;
}

export function runningRequest(db: AgentDatabase, conversationId: string): RequestRow | undefined {
  return db.prepare("SELECT * FROM requests WHERE conversation_id = ? AND state = 'running' ORDER BY queue_seq DESC LIMIT 1")
    .get(conversationId) as RequestRow | undefined;
}

export function activeRequestId(db: AgentDatabase, conversationId: string): string | null {
  return runningRequest(db, conversationId)?.id ?? null;
}

export function markStopRequested(db: AgentDatabase, now: string, requestId: string): void {
  db.prepare("UPDATE requests SET stop_requested = 1, updated_at = ? WHERE id = ?").run(now, requestId);
}

export function stopQueuedRequest(db: AgentDatabase, now: string, request: RequestRow): void {
  db.prepare("UPDATE requests SET state = 'stopped', updated_at = ? WHERE id = ?").run(now, request.id);
  db.prepare("UPDATE messages SET state = 'stopped', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, request.message_id);
  insertEvent(db, now, {
    conversationId: request.conversation_id, ownerId: request.owner_id, kind: "message.changed",
    entityId: request.message_id, entityVersion: messageRevision(db, request.message_id),
  });
}

export function interruptedRunningRequests(db: AgentDatabase): RequestRow[] {
  return db.prepare("SELECT * FROM requests WHERE state = 'running' ORDER BY queue_seq ASC").all() as RequestRow[];
}

export function markRequestTerminal(
  db: AgentDatabase,
  now: string,
  request: RequestRow,
  state: "completed" | "stopped" | "failed",
): void {
  db.prepare("UPDATE requests SET state = ?, updated_at = ? WHERE id = ?").run(state, now, request.id);
}

// —— 消息 ——

export function insertMessage(
  db: AgentDatabase,
  now: string,
  input: {
    id: string; conversationId: string; ownerId: string; requestId: string | null;
    role: MessageRow["role"]; kind: MessageRow["kind"]; state: MessageRow["state"];
    text: string; target: Target | null; references: MessageReferences; createdSeq: number;
    feedback?: Message["feedback"];
  },
): void {
  db.prepare(
    `INSERT INTO messages(id, conversation_id, owner_id, request_id, role, kind, state, revision, text, target_json,
      references_json, feedback_json, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.conversationId, input.ownerId, input.requestId, input.role, input.kind, input.state,
    input.text, input.target ? JSON.stringify(input.target) : null, JSON.stringify(input.references),
    input.feedback ? JSON.stringify(input.feedback) : null, input.createdSeq, now, now);
  insertEvent(db, now, {
    conversationId: input.conversationId, ownerId: input.ownerId, kind: "message.changed",
    entityId: input.id, entityVersion: 1,
  });
}

export function getMessageRow(db: AgentDatabase, ownerId: string, messageId: string): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ? AND owner_id = ?").get(messageId, ownerId) as MessageRow | undefined;
}

export function listMessageRows(db: AgentDatabase, conversationId: string, limit: number, beforeSeq?: number): MessageRow[] {
  const sql = beforeSeq === undefined
    ? "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_seq DESC LIMIT ?"
    : "SELECT * FROM messages WHERE conversation_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?";
  return (beforeSeq === undefined
    ? db.prepare(sql).all(conversationId, limit)
    : db.prepare(sql).all(conversationId, beforeSeq, limit)) as MessageRow[];
}

// 定位窗口：锚点消息及其之前最近的消息（含锚点本身），页大小由调用方约束。
export function listMessageRowsThrough(db: AgentDatabase, conversationId: string, anchorSeq: number, limit: number): MessageRow[] {
  return db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND created_seq <= ? ORDER BY created_seq DESC LIMIT ?")
    .all(conversationId, anchorSeq, limit) as MessageRow[];
}

export function maxMessageSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM messages WHERE conversation_id = ?").get(conversationId) as { seq: number };
  return row.seq;
}

export function finalizeRequestMessages(
  db: AgentDatabase,
  now: string,
  request: RequestRow,
  state: "completed" | "stopped" | "failed",
): void {
  db.prepare("UPDATE messages SET state = ?, revision = revision + 1, updated_at = ? WHERE request_id = ? AND state IN ('queued','running')")
    .run(state, now, request.id);
  for (const row of db.prepare("SELECT id, revision FROM messages WHERE request_id = ?").all(request.id) as { id: string; revision: number }[]) {
    insertEvent(db, now, {
      conversationId: request.conversation_id, ownerId: request.owner_id, kind: "message.changed",
      entityId: row.id, entityVersion: row.revision,
    });
  }
}

export function requestReceipt(row: RequestRow, replayed: boolean, runId: string | null = null): RequestReceipt {
  return {
    receiptId: `rcp-${row.id.slice(row.id.indexOf("-") + 1)}`,
    requestId: row.id,
    messageId: row.message_id,
    state: row.state,
    replayed,
    runId,
  };
}

export function afterCommit(hub: EventHub, conversationIds: Iterable<string>): void {
  for (const conversationId of conversationIds) hub.notifyCommitted(conversationId);
}

// —— 命令回执：唯一键 (owner, operation, target, commandId)，正文为规范化摘要 ——

export type ReplayOutcome<T> = { kind: "replay"; receipt: T } | { kind: "new" };

// 在事务内调用：相同键相同正文回放原回执；不同正文返回幂等冲突。
export function checkCommandReceipt<T>(
  db: AgentDatabase,
  key: { ownerId: string; operation: string; targetId: string; commandId: string },
  body: unknown,
): ReplayOutcome<T> {
  const row = db.prepare(
    "SELECT body_digest, receipt_json FROM command_receipts WHERE owner_id = ? AND operation = ? AND target_id = ? AND command_id = ?",
  ).get(key.ownerId, key.operation, key.targetId, key.commandId) as { body_digest: string; receipt_json: string } | undefined;
  if (!row) return { kind: "new" };
  if (row.body_digest !== digestOf(body)) {
    throw new AgentError("IDEMPOTENCY_CONFLICT", "同一命令 ID 已绑定不同请求内容。");
  }
  return { kind: "replay", receipt: JSON.parse(row.receipt_json) as T };
}

export function storeCommandReceipt(
  db: AgentDatabase,
  now: string,
  key: { ownerId: string; operation: string; targetId: string; commandId: string },
  body: unknown,
  receipt: unknown,
): void {
  db.prepare(
    `INSERT INTO command_receipts(owner_id, operation, target_id, command_id, body_digest, receipt_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(key.ownerId, key.operation, key.targetId, key.commandId, digestOf(body), canonicalJson(receipt), now);
}

// 与交付/提案回执共用事务：即使 Pi 尚未收到 toolResult，网页也能找到正式成果。
export function saveAssistantMessage(db: AgentDatabase, now: string, request: RequestRow, text: string, state: MessageRow["state"]): void {
  const id = `msg-${request.id.slice(4)}`;
  const prior = getMessageRow(db, request.owner_id, id);
  const artifacts = db.prepare("SELECT artifact_id AS artifactId, id AS revisionId FROM artifact_revisions WHERE request_id = ?").all(request.id) as MessageReferences["artifacts"];
  const proposals = db.prepare("SELECT DISTINCT proposal_id FROM tool_invocations WHERE request_id = ? AND proposal_id IS NOT NULL").all(request.id) as { proposal_id: string }[];
  const batches = db.prepare("SELECT id FROM material_search_batches WHERE request_id = ? ORDER BY created_at ASC, rowid ASC").all(request.id) as { id: string }[];
  const references = {
    artifacts, proposalIds: proposals.map(row => row.proposal_id), runIds: [],
    materialBatchIds: batches.map(row => row.id),
  };
  if (!text && !prior && artifacts.length === 0 && proposals.length === 0 && batches.length === 0) return;
  const body = text || prior?.text || "已保存本次成果。";
  // 批次与展示它的助手消息同事务关联，读取方不按最近时间猜。
  db.prepare("UPDATE material_search_batches SET message_id = ? WHERE request_id = ?").run(id, request.id);
  if (prior) {
    db.prepare("UPDATE messages SET text=?, state=?, references_json=?, revision=revision+1, updated_at=? WHERE id=?")
      .run(body, state, JSON.stringify(references), now, id);
    insertEvent(db, now, { conversationId: request.conversation_id, ownerId: request.owner_id, kind: "message.changed", entityId: id, entityVersion: prior.revision + 1 });
  } else {
    insertMessage(db, now, { id, conversationId: request.conversation_id, ownerId: request.owner_id, requestId: request.id,
      role: "assistant", kind: "chat", state, text: body, target: request.target_json ? JSON.parse(request.target_json) as Target : null,
      references, createdSeq: nextSeq(db, "messages", request.conversation_id) });
  }
}
