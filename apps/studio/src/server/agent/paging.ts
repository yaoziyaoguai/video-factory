import { AgentError } from "./errors.js";

// 游标是 opaque 字符串（契约 Cursor：1..512）。两类：
// - 列表游标：绑定 owner 会话、集合与不可变创建序列位置 + 读取时 watermark；
// - 事件游标：绑定会话与 events.seq，供 snapshot→SSE 严格续读。
// 越权（跨会话）拒绝为 FORBIDDEN，伪造/损坏按 INVALID_INPUT。

type ListCursorPayload = { v: 1; c: string; k: string; p: number; w: number };
type EventCursorPayload = { v: 1; c: string; s: number };

export type CollectionKind = "conversations" | "messages" | "artifacts" | "proposals" | "runs" | "library";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AgentError("INVALID_INPUT", "游标格式不正确，请重新获取快照。");
  }
}

export function encodeListCursor(payload: ListCursorPayload): string {
  return encode(payload);
}

export function decodeListCursor(cursor: string, conversationId: string, collection: CollectionKind): ListCursorPayload {
  const value = decode(cursor) as Partial<ListCursorPayload>;
  if (value.v !== 1 || typeof value.c !== "string" || typeof value.k !== "string"
    || typeof value.p !== "number" || typeof value.w !== "number" || !Number.isSafeInteger(value.p) || !Number.isSafeInteger(value.w)) {
    throw new AgentError("INVALID_INPUT", "列表游标格式不正确，请重新获取。");
  }
  if (value.c !== conversationId || value.k !== collection) {
    throw new AgentError("FORBIDDEN", "游标不属于这个会话或集合。");
  }
  return { v: 1, c: value.c, k: value.k, p: value.p, w: value.w };
}

export function encodeEventCursor(conversationId: string, seq: number): string {
  return encode({ v: 1, c: conversationId, s: seq } satisfies EventCursorPayload);
}

export function decodeEventCursor(cursor: string, conversationId: string): number {
  const value = decode(cursor) as Partial<EventCursorPayload>;
  if (value.v !== 1 || typeof value.c !== "string" || typeof value.s !== "number" || !Number.isSafeInteger(value.s) || value.s < 0) {
    throw new AgentError("INVALID_INPUT", "事件游标格式不正确，请重新获取快照。");
  }
  if (value.c !== conversationId) {
    throw new AgentError("FORBIDDEN", "事件游标不属于这个会话。");
  }
  return value.s;
}
