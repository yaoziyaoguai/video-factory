import type {
  KeyedMaterialSettings, KeylessMaterialSettings, MaterialProvider, NewsNowSettings, PexelsSettings,
  SaveFreeServiceSettingsReceipt, SaveKeylessServiceSettings, SaveNewsNowSettings, SavePexelsSettings,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { checkCommandReceipt, storeCommandReceipt } from "./conversation-store.js";
import { validatorFor } from "./validate.js";
import { canonicalJson, type AgentClock } from "./util.js";

// 免费服务（素材来源与 NewsNow 聚合）的当前配置：每服务一行，只存当前事实，无执行版本历史。
// 读取工具在调用开始时捕获配置；保存不触发任何外部请求。Key 明文只存服务端私有库。

export type KeyedServiceId = "pexels" | "pixabay" | "unsplash" | "coverr";
export type KeylessServiceId = KeylessMaterialSettings["serviceId"];
export type FreeServiceId = KeyedServiceId | KeylessServiceId | "newsnow";

const KEYED_SERVICES: readonly KeyedServiceId[] = ["pexels", "pixabay", "unsplash", "coverr"];
const KEYLESS_STOCK: readonly Extract<KeylessServiceId, MaterialProvider>[] = ["wikimedia", "nasa", "met", "cleveland", "archive", "freetouse", "incompetech"];

/** 工具与保存错误共用的服务名；素材适配器注册表同用这一份。 */
export const FREE_SERVICE_LABELS: Readonly<Record<FreeServiceId, string>> = {
  pexels: "Pexels", pixabay: "Pixabay", unsplash: "Unsplash", coverr: "Coverr",
  wikimedia: "Wikimedia Commons", nasa: "NASA", met: "The Met", cleveland: "Cleveland",
  archive: "Internet Archive", freetouse: "FreeToUse", incompetech: "Incompetech", newsnow: "NewsNow",
  "douyin-music": "抖音热歌榜", "tiktok-sounds": "TikTok 热门原声",
};

export const PEXELS_API_ENDPOINT = "https://api.pexels.com/v1";

/** 工具调用开始时捕获的单个素材来源配置；enabled 且（Key 服务）已配 Key 才可用。 */
export interface CapturedStockConfig {
  enabled: boolean;
  apiKey: string | null;
}

/** 工具调用开始时捕获的 NewsNow 配置；null 表示未启用或配置不完整。 */
export interface CapturedNewsNowConfig {
  enabled: boolean;
  endpoint: string;
  sourceIds: string[];
  topics: string[];
}

interface ServiceRow {
  service_id: string;
  revision: number;
  config_json: string;
  api_key: string | null;
}

export function freeServiceIdOf(serviceId: string): FreeServiceId {
  if (serviceId === "newsnow" || isKeyedService(serviceId as FreeServiceId) || isKeylessService(serviceId as FreeServiceId)) {
    return serviceId as FreeServiceId;
  }
  throw new AgentError("NOT_FOUND", "没有这个免费服务。");
}

function isKeyedService(id: FreeServiceId): id is KeyedServiceId {
  return (KEYED_SERVICES as readonly string[]).includes(id);
}

function isKeylessService(id: FreeServiceId): id is KeylessServiceId {
  return id === "douyin-music" || id === "tiktok-sounds" || (KEYLESS_STOCK as readonly string[]).includes(id);
}

function readRow(db: AgentDatabase, serviceId: FreeServiceId): ServiceRow | undefined {
  return db.prepare("SELECT * FROM free_service_settings WHERE service_id=?").get(serviceId) as ServiceRow | undefined;
}

export function readFreeServiceSettings(
  db: AgentDatabase, serviceId: FreeServiceId, includeApiKey = true,
): PexelsSettings | KeyedMaterialSettings | KeylessMaterialSettings | NewsNowSettings {
  const row = readRow(db, serviceId);
  const revision = row?.revision ?? 0;
  if (serviceId === "newsnow") {
    const config = row
      ? JSON.parse(row.config_json) as { enabled: boolean; endpoint: string | null; sourceIds: string[]; topics: string[] }
      : { enabled: false, endpoint: null, sourceIds: [], topics: [] };
    return {
      serviceId: "newsnow", revision, enabled: config.enabled,
      endpoint: config.endpoint, sourceIds: config.sourceIds, topics: config.topics,
    };
  }
  const config = row ? JSON.parse(row.config_json) as { enabled: boolean } : { enabled: false };
  if (serviceId === "pexels") {
    return {
      serviceId: "pexels", revision, enabled: config.enabled,
      credentialConfigured: row?.api_key != null,
      ...(includeApiKey ? { apiKey: row?.api_key ?? null } : {}),
      endpoint: PEXELS_API_ENDPOINT, writeUnavailableReason: null,
    };
  }
  if (isKeyedService(serviceId)) {
    return {
      serviceId, revision, enabled: config.enabled,
      credentialConfigured: row?.api_key != null,
      ...(includeApiKey ? { apiKey: row?.api_key ?? null } : {}),
      writeUnavailableReason: null,
    };
  }
  return { serviceId, revision, enabled: config.enabled, writeUnavailableReason: null };
}

/** 工具调用开始时一次性捕获全部素材来源配置；本次请求内不受后续设置修改影响。 */
export function captureStockConfigs(db: AgentDatabase): Partial<Record<MaterialProvider, CapturedStockConfig>> {
  const configs: Partial<Record<MaterialProvider, CapturedStockConfig>> = {};
  for (const serviceId of [...KEYED_SERVICES, ...KEYLESS_STOCK]) {
    const row = readRow(db, serviceId);
    if (!row) continue;
    const config = JSON.parse(row.config_json) as { enabled: boolean };
    configs[serviceId] = { enabled: config.enabled, apiKey: row.api_key };
  }
  return configs;
}

export function captureNewsNowConfig(db: AgentDatabase): CapturedNewsNowConfig | null {
  const row = readRow(db, "newsnow");
  if (!row) return null;
  const config = JSON.parse(row.config_json) as CapturedNewsNowConfig;
  if (!config.enabled || !config.endpoint || config.sourceIds.length === 0) return null;
  return config;
}

// —— 保存 ——

function requireRevision(current: number, expected: number): void {
  if (expected !== current) throw new AgentError("STALE_REVISION", "设置已被其他页面修改，请读取最新状态后重试。");
}

interface NormalizedNewsNow {
  enabled: boolean;
  endpoint: string | null;
  sourceIds: string[];
  topics: string[];
}

function normalizeNewsNow(input: SaveNewsNowSettings): NormalizedNewsNow {
  // sourceIds 的 pattern/去重已由契约 Schema 在边界校验；这里只做跨字段一致性。
  const sourceIds = input.sourceIds;
  const topics: string[] = [];
  for (const item of input.topics) {
    const topic = item.trim();
    if (!topic) throw new AgentError("INVALID_INPUT", "关注主题不能是纯空白。");
    if (!topics.includes(topic)) topics.push(topic);
  }
  const endpoint = input.endpoint === null ? null : normalizeNewsNowEndpoint(input.endpoint);
  if (endpoint === null && sourceIds.length > 0) {
    throw new AgentError("INVALID_INPUT", "未填写服务地址时不能保留来源列表。");
  }
  if (input.enabled && (endpoint === null || sourceIds.length === 0)) {
    throw new AgentError("INVALID_INPUT", "启用 NewsNow 需要服务地址和 1–5 个来源 ID。");
  }
  return { enabled: input.enabled, endpoint, sourceIds, topics };
}

// 自托管实例地址由用户明确填写；但用户名、查询或锚点不属于实例地址，不接受。
function normalizeNewsNowEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new AgentError("INVALID_INPUT", "NewsNow 服务地址不是有效的 URL。"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new AgentError("INVALID_INPUT", "NewsNow 服务地址必须是不带用户名、查询参数或锚点的 http(s) 地址。");
  }
  return url.toString().replace(/\/$/, "");
}

function upsertConfig(db: AgentDatabase, serviceId: FreeServiceId, revision: number, configJson: string, apiKey: string | null, now: string): void {
  // 只有 Key 服务携带凭据列；Keyless 与 NewsNow 恒为 null，不覆盖也无可覆盖。
  db.prepare(`INSERT INTO free_service_settings(service_id,revision,config_json,api_key,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(service_id) DO UPDATE SET revision=revision+1, config_json=excluded.config_json,
      api_key=CASE WHEN ? THEN excluded.api_key ELSE free_service_settings.api_key END, updated_at=excluded.updated_at`)
    .run(serviceId, revision + 1, configJson, apiKey, now, isKeyedService(serviceId) ? 1 : 0);
}

// Key 服务（Pexels/Pixabay/Unsplash/Coverr）共用同一保存形状：Key 只写不读回执，留空保留已存 Key。
export function savePexelsServiceSettings(db: AgentDatabase, clock: AgentClock, ownerId: string, input: SavePexelsSettings): SaveFreeServiceSettingsReceipt {
  return saveKeyedServiceSettings(db, clock, ownerId, "pexels", input);
}

export function saveKeyedServiceSettings(
  db: AgentDatabase, clock: AgentClock, ownerId: string, serviceId: KeyedServiceId, input: SavePexelsSettings,
): SaveFreeServiceSettingsReceipt {
  const verdict = validatorFor("SavePexelsSettings")(input);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
  const label = FREE_SERVICE_LABELS[serviceId];
  const apiKey = input.apiKey === null ? null : input.apiKey.trim();
  if (apiKey !== null && (!apiKey || /[\s\x00-\x1f\x7f]/.test(apiKey))) {
    throw new AgentError("INVALID_INPUT", `${label} API Key 不能为空或含内部空白、控制字符；留空表示保留已保存的 Key。`);
  }
  const key = { ownerId, operation: "saveFreeServiceSettings", targetId: serviceId, commandId: input.commandId };
  return db.transaction(() => {
    const replayBody = { ...input, ...(apiKey !== null ? { apiKey } : {}) };
    const replay = checkCommandReceipt<SaveFreeServiceSettingsReceipt>(db, key, replayBody);
    if (replay.kind === "replay") return { ...replay.receipt, replayed: true };
    const row = readRow(db, serviceId);
    requireRevision(row?.revision ?? 0, input.expectedRevision);
    const effectiveKey = apiKey ?? row?.api_key ?? null;
    if (input.enabled && effectiveKey == null) throw new AgentError("INVALID_INPUT", `首次启用 ${label} 需要填写 API Key。`);
    const now = clock();
    const configJson = canonicalJson({ enabled: input.enabled });
    const changed = !row
      || canonicalJson(JSON.parse(row.config_json)) !== configJson
      || (apiKey !== null && apiKey !== row.api_key);
    if (changed) upsertConfig(db, serviceId, row?.revision ?? 0, configJson, effectiveKey, now);
    const payload: SaveFreeServiceSettingsReceipt = { settings: readFreeServiceSettings(db, serviceId, false), replayed: false };
    storeCommandReceipt(db, now, key, replayBody, payload);
    return payload;
  })();
}

// 免 Key 素材服务只改启停；没有凭据字段可保存。
export function saveKeylessServiceSettings(
  db: AgentDatabase, clock: AgentClock, ownerId: string, serviceId: KeylessServiceId, input: SaveKeylessServiceSettings,
): SaveFreeServiceSettingsReceipt {
  const verdict = validatorFor("SaveKeylessServiceSettings")(input);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
  const key = { ownerId, operation: "saveFreeServiceSettings", targetId: serviceId, commandId: input.commandId };
  return db.transaction(() => {
    const replay = checkCommandReceipt<SaveFreeServiceSettingsReceipt>(db, key, input);
    if (replay.kind === "replay") return { ...replay.receipt, replayed: true };
    const row = readRow(db, serviceId);
    requireRevision(row?.revision ?? 0, input.expectedRevision);
    const now = clock();
    const configJson = canonicalJson({ enabled: input.enabled });
    const changed = !row || canonicalJson(JSON.parse(row.config_json)) !== configJson;
    if (changed) upsertConfig(db, serviceId, row?.revision ?? 0, configJson, null, now);
    const payload: SaveFreeServiceSettingsReceipt = { settings: readFreeServiceSettings(db, serviceId), replayed: false };
    storeCommandReceipt(db, now, key, input, payload);
    return payload;
  })();
}

export function saveNewsNowServiceSettings(db: AgentDatabase, clock: AgentClock, ownerId: string, input: SaveNewsNowSettings): SaveFreeServiceSettingsReceipt {
  const verdict = validatorFor("SaveNewsNowSettings")(input);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
  const normalized = normalizeNewsNow(input);
  const key = { ownerId, operation: "saveFreeServiceSettings", targetId: "newsnow", commandId: input.commandId };
  return db.transaction(() => {
    const replay = checkCommandReceipt<SaveFreeServiceSettingsReceipt>(db, key, { ...input, ...normalized });
    if (replay.kind === "replay") return { ...replay.receipt, replayed: true };
    const row = readRow(db, "newsnow");
    requireRevision(row?.revision ?? 0, input.expectedRevision);
    const now = clock();
    const configJson = canonicalJson(normalized);
    const changed = !row || canonicalJson(JSON.parse(row.config_json)) !== configJson;
    if (changed) upsertConfig(db, "newsnow", row?.revision ?? 0, configJson, null, now);
    const payload: SaveFreeServiceSettingsReceipt = { settings: readFreeServiceSettings(db, "newsnow"), replayed: false };
    storeCommandReceipt(db, now, key, { ...input, ...normalized }, payload);
    return payload;
  })();
}
