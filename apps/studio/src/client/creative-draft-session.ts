// 双标签未保存稿保护（DG-UX-01）：编辑文字与意见按“标签会话”保存在 sessionStorage。
// - 槽位 key 不包含稿件版本：别的标签保存新版本后，本标签未保存文字仍可找回；
// - sessionStorage 每标签独立：B 标签的保存/放弃只清理 B 自己的记录；
// - 同标签刷新、路由往返仍在；关闭标签即结束，不承诺跨设备恢复。
// 旧实现把草稿写进按版本号的 localStorage key（各标签共享），既会被别的标签保存
// 成功时清掉，也会在版本变化后因 key 改变而读不回。这里对旧 key 只做一次性只读
// 导入：复制进本标签会话槽，共享旧 key 始终只读；处理标记仅属于本标签。

export interface CreativeDraftSessionBase {
  runId: string;
  stage: string;
  purposeKey: string;
  versionId?: string;
  artifactId?: string;
  draftSha256?: string;
}

export interface CreativeEditedDocument {
  baseKey: string;
  document: Record<string, unknown>;
}

export interface CreativeDraftSessionRecord {
  base: CreativeDraftSessionBase;
  document?: CreativeEditedDocument;
  message?: string;
  updatedAt: string;
}

export type CreativeSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function creativeSessionSlotKey(runId: string, stage: string, purposeKey: string): string {
  return `vf:creative-session:${runId}:${stage}:${purposeKey}`;
}

/** C5：组件读取入口——合并内存与持久（内存清理标记/最新值优先）。 */
export function readCreativeSessionSlot(storage: CreativeSessionStorage, key: string): CreativeDraftSessionRecord | null {
  return readMergedRecord(storage, key);
}

export function readCreativeSessionRecord(storage: CreativeSessionStorage, key: string): CreativeDraftSessionRecord | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<CreativeDraftSessionRecord>;
    if (typeof record.base !== "object" || record.base === null) return null;
    return record as CreativeDraftSessionRecord;
  } catch {
    return null;
  }
}

export function writeCreativeSessionFields(
  storage: CreativeSessionStorage,
  key: string,
  base: CreativeDraftSessionBase,
  fields: Partial<Pick<CreativeDraftSessionRecord, "document" | "message">>,
): boolean {
  writeThroughMemory(storage, key, base, fields);
  try {
    const existing = readMergedRecord(storage, key);
    const next: CreativeDraftSessionRecord = {
      ...(existing ?? { base, updatedAt: new Date().toISOString() }),
      base,
      updatedAt: new Date().toISOString(),
      ...fields,
    };
    storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** 只清理指定字段；记录不再含任何内容时移除整个槽位，不影响同标签其他上下文的槽。 */
export function clearCreativeSessionFields(
  storage: CreativeSessionStorage,
  key: string,
  fields: Array<"document" | "message">,
): boolean {
  clearThroughMemory(storage, key, fields);
  try {
    const existing = readMergedRecord(storage, key);
    if (!existing) return true;
    const next: CreativeDraftSessionRecord = { ...existing };
    let hasContent = false;
    for (const field of ["document", "message"] as const) {
      if (fields.includes(field)) delete next[field];
      else if (next[field] !== undefined && next[field] !== "") hasContent = true;
    }
    if (hasContent) storage.setItem(key, JSON.stringify(next));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * 旧版把意见文字存为按版本号的 localStorage 裸字符串。仅在会话槽没有本字段时导入
 * 一次；共享旧key始终保留，本标签标记防止已处理内容复活。
 */
/**
 * C3（收尾包）：legacy 共享旧 key 只读。导入成功只在**本标签 sessionStorage** 记
 * “已处理”标记（旧key+payload 指纹），不删除/覆盖共享旧值——其它标签仍可导入；
 * 持久导入失败时旧值原样保留；本页仍记处理状态，避免明确放弃的内容复活。
 */
export function importLegacyCreativeMessage(params: {
  session: CreativeSessionStorage;
  legacy: CreativeSessionStorage;
  sessionKey: string;
  base: CreativeDraftSessionBase;
  legacyKey: string;
}): "imported" | "skipped" | "failed" {
  const { session, legacy, sessionKey, base, legacyKey } = params;
  let legacyMessage: string | null = null;
  try {
    legacyMessage = legacy.getItem(legacyKey);
  } catch {
    return "skipped";
  }
  if (!legacyMessage) return "skipped";
  if (legacyProcessedInThisTab(session, legacyKey, legacyMessage)) return persistLegacyProgress(session, sessionKey, legacyKey, legacyMessage) ? "skipped" : "failed";
  const existing = readMergedRecord(session, sessionKey);
  if (existing?.message) return "skipped";
  const saved = writeCreativeSessionFields(session, sessionKey, base, { message: legacyMessage });
  return markLegacyProcessedInThisTab(session, legacyKey, legacyMessage, saved) ? "imported" : "failed";
}

// 本标签已处理标记：key 带指纹，旧 payload 更新后不会被旧标记吞掉；只在标签会话内。
function legacyProcessedKey(legacyKey: string, fingerprint: string): string {
  return `vf:creative-legacy-done:${legacyKey}:${fingerprint}`;
}
function payloadFingerprint(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `${hash}:${value.length}`;
}
const legacyProcessedMemory = new WeakMap<CreativeSessionStorage, Set<string>>();
function legacyProcessedInThisTab(session: CreativeSessionStorage, legacyKey: string, payload: string): boolean {
  const key = legacyProcessedKey(legacyKey, payloadFingerprint(payload));
  if (legacyProcessedMemory.get(session)?.has(key)) return true;
  try {
    return session.getItem(key) === "1";
  } catch {
    return false;
  }
}
function markLegacyProcessedInThisTab(session: CreativeSessionStorage, legacyKey: string, payload: string, saved: boolean): boolean {
  const key = legacyProcessedKey(legacyKey, payloadFingerprint(payload));
  let processed = legacyProcessedMemory.get(session);
  if (!processed) { processed = new Set(); legacyProcessedMemory.set(session, processed); }
  processed.add(key);
  // 先耐久保存/放弃草稿，再写耐久标记；不能让刷新仅剩标记却丢了尚未持久的文字。
  if (!saved) return false;
  try {
    session.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

function persistLegacyProgress(session: CreativeSessionStorage, sessionKey: string, legacyKey: string, payload: string): boolean {
  try {
    const record = readMergedRecord(session, sessionKey);
    if (record && (record.message || record.document)) session.setItem(sessionKey, JSON.stringify(record));
    else session.removeItem(sessionKey);
    return markLegacyProcessedInThisTab(session, legacyKey, payload, true);
  } catch { return false; }
}

/**
 * 旧版编辑草稿存为 `{baseKey, document}`（baseKey 不含 versionId）。导入时若内容与
 * 当前稿完全一致，则把 base 重建为当前身份（可继续编辑）；否则保留原 baseKey，
 * 由编辑器按版本差异标记为旧稿，只能复制/放弃，不能覆盖新稿。
 */
export function importLegacyCreativeEdit(params: {
  session: CreativeSessionStorage;
  legacy: CreativeSessionStorage;
  sessionKey: string;
  base: CreativeDraftSessionBase;
  legacyEditKey: string;
  currentBaseKey: string;
  currentDraft: unknown;
}): "imported" | "skipped" | "failed" {
  const { session, legacy, sessionKey, base, legacyEditKey, currentBaseKey, currentDraft } = params;
  let raw: string | null = null;
  try {
    raw = legacy.getItem(legacyEditKey);
  } catch {
    return "skipped";
  }
  if (!raw) return "skipped";
  let parsed: { baseKey?: unknown; document?: unknown };
  try {
    parsed = JSON.parse(raw) as { baseKey?: unknown; document?: unknown };
  } catch {
    return "skipped";
  }
  if (typeof parsed.baseKey !== "string" || typeof parsed.document !== "object" || parsed.document === null) return "skipped";
  if (legacyProcessedInThisTab(session, legacyEditKey, raw)) return persistLegacyProgress(session, sessionKey, legacyEditKey, raw) ? "skipped" : "failed";
  const existing = readMergedRecord(session, sessionKey);
  if (existing?.document !== undefined) return "skipped";
  // C3：内容相同不等于版本身份相同。只有旧 baseKey 的身份（artifact/sha/version）与
  // 当前稿完全可核一致时才允许绑定为当前 base；否则保留 legacy 身份，由编辑器按
  // stale 处理（可复制/放弃，不能直接保存覆盖当前稿）。
  const parsedBase = parseBaseKeyIdentity(parsed.baseKey);
  const parsedCurrentBase = parseBaseKeyIdentity(currentBaseKey);
  const identityVerifiable = parsedBase !== null
    && parsedCurrentBase !== null
    && parsedBase.stage === parsedCurrentBase.stage
    && typeof parsedBase.draftIdentity === "string"
    && parsedBase.draftIdentity === parsedCurrentBase.draftIdentity
    && JSON.stringify(parsed.document) === JSON.stringify(currentDraft);
  const edited: CreativeEditedDocument = {
    baseKey: identityVerifiable ? currentBaseKey : parsed.baseKey,
    document: parsed.document as Record<string, unknown>,
  };
  const saved = writeCreativeSessionFields(session, sessionKey, base, { document: edited });
  return markLegacyProcessedInThisTab(session, legacyEditKey, raw, saved) ? "imported" : "failed";
}

/** 旧 baseKey 是 JSON.stringify({stage, draftIdentity, draft})；只提取可核身份字段。 */
function parseBaseKeyIdentity(baseKey: string): { stage?: string; draftIdentity?: string } | null {
  try {
    const parsed = JSON.parse(baseKey) as { stage?: unknown; draftIdentity?: unknown };
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      ...(typeof parsed.stage === "string" ? { stage: parsed.stage } : {}),
      ...(typeof parsed.draftIdentity === "string" ? { draftIdentity: parsed.draftIdentity } : {}),
    };
  } catch {
    return null;
  }
}

// C5（收尾包）：每个会话槽的最新内容/清理状态留一份同页面内存副本。sessionStorage
// 读写/删除可能独立失败——失败后本页卸载重挂仍从内存恢复，且旧持久值不倒灌较新内存。
// 只服务当前页面生命周期，不承诺刷新/关闭后仍在（提示如实说）。
interface MemorySlotState {
  base?: CreativeDraftSessionBase;
  document?: CreativeEditedDocument;
  message?: string;
  clearedFields?: Array<"document" | "message">;
}
// 按 storage 实例隔离：真实页面同一 window.sessionStorage → 同页面内存；
// 每个测试替身实例各自独立，不跨实例泄漏。
const memorySlots = new WeakMap<CreativeSessionStorage, Map<string, MemorySlotState>>();

function readMemorySlot(storage: CreativeSessionStorage, sessionKey: string): MemorySlotState {
  let slots = memorySlots.get(storage);
  if (!slots) {
    slots = new Map();
    memorySlots.set(storage, slots);
  }
  let slot = slots.get(sessionKey);
  if (!slot) {
    slot = {};
    slots.set(sessionKey, slot);
  }
  return slot;
}

/** 写入持久层同时更新内存副本；持久失败时内存仍持有最新值并返回 false。 */
function writeThroughMemory(storage: CreativeSessionStorage, sessionKey: string, base: CreativeDraftSessionBase, fields: Partial<Pick<CreativeDraftSessionRecord, "document" | "message">>): boolean {
  const slot = readMemorySlot(storage, sessionKey);
  slot.base = base;
  if (fields.document !== undefined) slot.document = fields.document;
  if (fields.message !== undefined) slot.message = fields.message;
  const cleared = new Set(slot.clearedFields ?? []);
  if (fields.document !== undefined) cleared.delete("document");
  if (fields.message !== undefined) cleared.delete("message");
  if (cleared.size !== (slot.clearedFields?.length ?? 0)) slot.clearedFields = [...cleared];
  return true;
}

/** 清理持久层同时记内存清理标记；持久删除失败也返回内存语义成功（字段已被用户放弃）。 */
function clearThroughMemory(storage: CreativeSessionStorage, sessionKey: string, fields: Array<"document" | "message">): boolean {
  const slot = readMemorySlot(storage, sessionKey);
  const cleared = new Set([...(slot.clearedFields ?? []), ...fields]);
  slot.clearedFields = [...cleared];
  return true;
}

/** 读优先级：内存清理标记 > 内存最新值 > 持久值。防止旧持久值复活已放弃字段或倒灌。 */
function readMergedRecord(
  storage: CreativeSessionStorage,
  sessionKey: string,
): CreativeDraftSessionRecord | null {
  const persisted = readCreativeSessionRecord(storage, sessionKey);
  const slots = memorySlots.get(storage);
  const slot = slots?.get(sessionKey);
  if (!slot) return persisted;
  const cleared = new Set(slot.clearedFields ?? []);
  let merged: CreativeDraftSessionRecord | null = persisted ? structuredClone(persisted) : null;
  const dropCleared = (record: CreativeDraftSessionRecord | null): CreativeDraftSessionRecord | null => {
    if (!record) return null;
    const next = { ...record };
    if (cleared.has("document")) delete next.document;
    if (cleared.has("message")) delete next.message;
    return next;
  };
  merged = dropCleared(merged);
  if (slot.document !== undefined && !cleared.has("document")) {
    merged = merged ?? { base: slot.base ?? persisted?.base ?? { runId: "", stage: "", purposeKey: "" }, updatedAt: new Date().toISOString() };
    merged.document = slot.document;
  }
  if (slot.message !== undefined && !cleared.has("message")) {
    merged = merged ?? { base: slot.base ?? persisted?.base ?? { runId: "", stage: "", purposeKey: "" }, updatedAt: new Date().toISOString() };
    merged.message = slot.message;
  }
  return merged;
}

interface SessionDomain {
  backing?: CreativeSessionStorage;
  storage: CreativeSessionStorage;
}
const sessionDomains = new WeakMap<CreativeSessionStorage, SessionDomain>();
let activeSessionDomain: SessionDomain | undefined;

function createSessionDomain(): SessionDomain {
  const domain: SessionDomain = { storage: {
    getItem: key => liveStorage().getItem(key),
    setItem: (key, value) => liveStorage().setItem(key, value),
    removeItem: key => liveStorage().removeItem(key),
  } };
  function liveStorage(): CreativeSessionStorage {
    const current = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!current || current !== domain.backing) throw new Error("标签会话存储暂不可访问。");
    return current;
  }
  return domain;
}

/** 同页存储门面身份稳定；可用性切换只影响持久层，不切换最新输入的内存域。 */
export function creativeSessionStorage(): { storage: CreativeSessionStorage; durable: boolean } {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (storage) {
      let domain = sessionDomains.get(storage);
      if (!domain) {
        domain = activeSessionDomain && !activeSessionDomain.backing ? activeSessionDomain : createSessionDomain();
        domain.backing = storage;
        sessionDomains.set(storage, domain);
      }
      activeSessionDomain = domain;
      storage.getItem("vf:creative-session:probe");
      return { storage: domain.storage, durable: true };
    }
  } catch {
    // 落到内存副本：页面内卸载/重挂仍可恢复，但不承诺刷新后仍在。
  }
  activeSessionDomain ??= createSessionDomain();
  return { storage: activeSessionDomain.storage, durable: false };
}
