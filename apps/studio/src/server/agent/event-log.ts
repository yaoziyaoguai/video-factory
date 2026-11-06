import type { AgentDatabase } from "./db.js";
import { newAgentId } from "./util.js";

export type BusinessEventKind = "message.changed" | "artifact.delivered" | "proposal.changed" | "run.changed" | "conversation.changed"
  | "work.changed" | "material.changed";

interface EventRow {
  seq: number;
  event_id: string;
  conversation_id: string;
  owner_id: string;
  kind: BusinessEventKind;
  entity_id: string;
  entity_version: number;
  notification: "quiet" | "new_output";
  created_at: string;
}

const insertStatement = (db: AgentDatabase) => db.prepare(
  `INSERT INTO events(event_id, conversation_id, owner_id, kind, entity_id, entity_version, notification, created_at)
   VALUES (@event_id, @conversation_id, @owner_id, @kind, @entity_id, @entity_version, @notification, @created_at)`,
);

export interface EventDraft {
  conversationId: string;
  ownerId: string;
  kind: BusinessEventKind;
  entityId: string;
  entityVersion: number;
  notification?: "quiet" | "new_output";
}

// 只在业务事务内调用；事件随业务提交落库，提交后再由 EventHub 广播。
export function insertEvent(db: AgentDatabase, now: string, draft: EventDraft): number {
  const row: EventRow = {
    seq: 0,
    event_id: newAgentId("ev"),
    conversation_id: draft.conversationId,
    owner_id: draft.ownerId,
    kind: draft.kind,
    entity_id: draft.entityId,
    entity_version: draft.entityVersion,
    notification: draft.notification ?? "quiet",
    created_at: now,
  };
  const info = insertStatement(db).run(row);
  return Number(info.lastInsertRowid);
}

export function readEventsAfter(db: AgentDatabase, conversationId: string, afterSeq: number, limit: number): EventRow[] {
  return db.prepare(
    `SELECT seq, event_id, conversation_id, owner_id, kind, entity_id, entity_version, notification, created_at
     FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  ).all(conversationId, afterSeq, limit) as EventRow[];
}

export function minEventSeq(db: AgentDatabase, conversationId: string): number | null {
  const row = db.prepare("SELECT MIN(seq) AS seq FROM events WHERE conversation_id = ?").get(conversationId) as { seq: number | null };
  return row.seq;
}

export function maxEventSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM events WHERE conversation_id = ?").get(conversationId) as { seq: number | null };
  return row.seq ?? 0;
}

export function toBusinessEventPayload(row: EventRow, cursor: string): {
  eventId: string;
  cursor: string;
  conversationId: string;
  kind: BusinessEventKind;
  entityId: string;
  entityVersion: number;
  notification: "quiet" | "new_output";
  createdAt: string;
} {
  return {
    eventId: row.event_id,
    cursor,
    conversationId: row.conversation_id,
    kind: row.kind,
    entityId: row.entity_id,
    entityVersion: row.entity_version,
    notification: row.notification,
    createdAt: row.created_at,
  };
}

export type TransientDelta = { requestId: string; messageId: string; sequence: number; text: string };

// 两种暂态事件（artifact.draft / context.status）：没有持久 ID、不落库、不推进游标，
// 只描述“正在发生的回合内过程”；正式事实仍由业务事务产生的持久事件承载。
export type TransientDraft = import("../../shared/agent/generated/contracts.js").ArtifactDraft;
export type TransientContextStatus = import("../../shared/agent/generated/contracts.js").ContextStatus;

// 进程内广播器：DB 是事件权威，这里只负责“提交后尽快推送”与暂态通道。
// SSE 连接同时依赖低频轮询兜底，hub 丢失不丢业务事实。
export class EventHub {
  private readonly subscribers = new Map<string, Set<() => void>>();
  private readonly deltaListeners = new Map<string, Set<(delta: TransientDelta) => void>>();
  private readonly draftListeners = new Map<string, Set<(draft: TransientDraft) => void>>();
  private readonly contextListeners = new Map<string, Set<(status: TransientContextStatus) => void>>();
  private closed = false;

  subscribe(conversationId: string, notify: () => void): () => void {
    const set = this.subscribers.get(conversationId) ?? new Set();
    set.add(notify);
    this.subscribers.set(conversationId, set);
    return () => {
      set.delete(notify);
      if (set.size === 0) this.subscribers.delete(conversationId);
    };
  }

  // 事务提交后调用；同一会话的订阅者自行回读增量，避免二次转发覆盖。
  notifyCommitted(conversationId: string): void {
    if (this.closed) return;
    for (const notify of this.subscribers.get(conversationId) ?? []) notify();
  }

  // 暂态增量没有持久 ID；只分发给订阅 delta 的连接，不触发持久事件轮询。
  emitDelta(conversationId: string, delta: TransientDelta): void {
    if (this.closed) return;
    for (const listener of this.deltaListeners.get(conversationId) ?? []) listener(delta);
  }

  subscribeDeltas(conversationId: string, listener: (delta: TransientDelta) => void): () => void {
    const set = this.deltaListeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.deltaListeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.deltaListeners.delete(conversationId);
    };
  }

  emitDraft(conversationId: string, draft: TransientDraft): void {
    if (this.closed) return;
    for (const listener of this.draftListeners.get(conversationId) ?? []) listener(draft);
  }

  subscribeDrafts(conversationId: string, listener: (draft: TransientDraft) => void): () => void {
    const set = this.draftListeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.draftListeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.draftListeners.delete(conversationId);
    };
  }

  emitContextStatus(conversationId: string, status: TransientContextStatus): void {
    if (this.closed) return;
    for (const listener of this.contextListeners.get(conversationId) ?? []) listener(status);
  }

  subscribeContextStatus(conversationId: string, listener: (status: TransientContextStatus) => void): () => void {
    const set = this.contextListeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.contextListeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.contextListeners.delete(conversationId);
    };
  }

  close(): void {
    this.closed = true;
    this.subscribers.clear();
    this.deltaListeners.clear();
    this.draftListeners.clear();
    this.contextListeners.clear();
  }
}
