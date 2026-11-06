import { createHash, randomBytes } from "node:crypto";

// A 增量的可注入时钟：业务时间统一走这里，测试可注入边界场景（提案到期等）。
export type AgentClock = () => string;

export function systemClock(): string {
  return new Date().toISOString();
}

// 契约 Id 形如 ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$；前缀区分记录族，随机部分用 Crockford base32。
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_RANDOM_BYTES = 16;

export function newAgentId(prefix: string): string {
  const bytes = randomBytes(ID_RANDOM_BYTES);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${prefix}-${suffix}`;
}

// 规范化 JSON：对象键按字典序递归排序后序列化，用于摘要与幂等正文比较。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
