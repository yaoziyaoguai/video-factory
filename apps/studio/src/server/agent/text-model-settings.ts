import type {
  ModelBinding, ModelEntry, SaveUserProfile, SaveUserProfileReceipt, ThinkingLevel, UserProfile,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { checkCommandReceipt, storeCommandReceipt } from "./conversation-store.js";
import { validatorFor } from "./validate.js";
import { canonicalJson, digestOf, newAgentId, type AgentClock } from "./util.js";

// 文本执行配置的持久化与读取：settings 单例 + 展示条目 + 不可变执行版本（同 SQLite）。
// version 的 configuration_json 只存执行字段；name/features 只由 entries 供给。
// 公开配置入口只有统一连接保存（saveProviderConnection 投影生成执行版本），旧独立 CRUD 已随 0.1.20 删除。
// Key 持久化只进私有库；写回执与模型目录不带 Key。

export interface TextExecutionConfig {
  protocol: "openai-responses";
  baseUrl: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** 本版本冻结的实际推理档位。 */
  thinkingLevel: ThinkingLevel;
}

/**
 * 磁盘上的历史快照可能是退役协议（旧 OpenAI 兼容/Anthropic）或缺少 thinkingLevel；
 * 只在 textRegistrationOf 边界解释一次，退役协议不在本部署可执行。
 */
export interface StoredTextExecutionConfig {
  protocol: string;
  baseUrl: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  thinkingLevel?: ThinkingLevel;
}

export interface TextVersionRow {
  configuration_revision_id: string;
  binding_json: string;
  configuration_json: string;
  api_key: string | null;
  created_at: string;
}

export interface TextEntryRow {
  id: string;
  name: string;
  features_json: string;
  current_configuration_revision_id: string;
  created_at: string;
}

/** Pi 注册所需的全部执行事实；由冻结绑定解析得到，秘密只在服务端内传递。 */
export interface PiTextRegistration {
  providerId: string;
  modelId: string;
  protocol: "openai-responses";
  baseUrl: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  thinkingLevel: ThinkingLevel;
  apiKey: string;
}

// Pi 的内部 providerId 使用配置修订唯一 ID：同一 vendor/model 换 Key 不会覆盖在途请求的注册。
export function textConfigurationRevisionId(execution: TextExecutionConfig, connectionId: string): string {
  return `cfg-${digestOf({ ...execution, connectionId }).slice(0, 24)}`;
}

export function textBindingOf(execution: TextExecutionConfig, connectionId: string): ModelBinding {
  const configurationRevisionId = textConfigurationRevisionId(execution, connectionId);
  return { providerId: configurationRevisionId, modelId: execution.modelId, connectionId, configurationRevisionId };
}

function readSettingsRow(db: AgentDatabase): { revision: number; default_entry_id: string | null } | null {
  return (db.prepare("SELECT revision, default_entry_id FROM text_model_settings WHERE id=1").get() as
    { revision: number; default_entry_id: string | null } | undefined) ?? null;
}

function readVersion(db: AgentDatabase, configurationRevisionId: string): TextVersionRow | undefined {
  return db.prepare("SELECT * FROM text_model_versions WHERE configuration_revision_id=?")
    .get(configurationRevisionId) as TextVersionRow | undefined;
}

export interface TextSettingsView {
  revision: number;
  defaultEntryId: string | null;
  entries: { entry: TextEntryRow; version: TextVersionRow }[];
}

export function readTextModelView(db: AgentDatabase): TextSettingsView {
  const settings = readSettingsRow(db);
  if (!settings) throw new Error("text_model_settings 未初始化。");
  const entries = (db.prepare(
    "SELECT e.id AS entry_id, e.name, e.features_json, e.current_configuration_revision_id, e.created_at, v.configuration_revision_id, v.binding_json, v.configuration_json, v.api_key, v.created_at AS version_created_at FROM text_model_entries e JOIN text_model_versions v ON v.configuration_revision_id = e.current_configuration_revision_id ORDER BY e.created_at ASC, e.id ASC",
  ).all() as (TextEntryRow & TextVersionRow & { entry_id: string; version_created_at: string })[])
    .map(row => ({
      entry: { id: row.entry_id, name: row.name, features_json: row.features_json, current_configuration_revision_id: row.current_configuration_revision_id, created_at: row.created_at },
      version: { configuration_revision_id: row.configuration_revision_id, binding_json: row.binding_json, configuration_json: row.configuration_json, api_key: row.api_key, created_at: row.version_created_at },
    }));
  return { revision: settings.revision, defaultEntryId: settings.default_entry_id, entries };
}

// 首启动只建设置行；不再从旧 C1 文本配置文件或环境导入（B3：旧供应商不因启动回填复活）。
export function initializeTextModelSettings(db: AgentDatabase, clock: AgentClock): void {
  db.transaction(() => {
    if (readSettingsRow(db)) return;
    db.prepare("INSERT INTO text_model_settings(id,revision,default_entry_id,updated_at) VALUES(1,0,NULL,?)").run(clock());
  })();
}

// —— 公开投影 ——

/** Bootstrap 的文本目录条目；与连接配置投影同一事实源。 */
export function textModelsView(db: AgentDatabase): ModelEntry[] {
  const view = readTextModelView(db);
  return view.entries.map(({ entry, version }) => {
    const execution = JSON.parse(version.configuration_json) as StoredTextExecutionConfig;
    const binding = JSON.parse(version.binding_json) as ModelBinding;
    const features = JSON.parse(entry.features_json) as string[];
    const credentialConfigured = version.api_key !== null;
    return {
      binding, name: entry.name, kind: "text" as const, features,
      availability: credentialConfigured ? "configured" as const : "unavailable" as const,
      verificationNote: credentialConfigured
        ? `网页配置连接，未做真实调用验证；上下文窗口 ${execution.contextWindowTokens.toLocaleString("en-US")} tokens。`
        : "尚未保存 API Key，不能用于新消息。",
      isDefault: entry.id === view.defaultEntryId,
    };
  });
}

/** 新请求冻结的默认绑定；默认条目缺凭据时为 null（发送门拒绝）。 */
export function defaultTextBindingOf(db: AgentDatabase): ModelBinding | null {
  const view = readTextModelView(db);
  if (!view.defaultEntryId) return null;
  const current = view.entries.find(item => item.entry.id === view.defaultEntryId);
  if (!current || current.version.api_key === null) return null;
  return JSON.parse(current.version.binding_json) as ModelBinding;
}

/** 冻结绑定解析：按原版本找回执行配置与原 Key；找不到说明绑定已不在本部署历史中。 */
export function resolveTextBinding(db: AgentDatabase, binding: ModelBinding): { execution: StoredTextExecutionConfig; apiKey: string | null } | null {
  const version = readVersion(db, binding.configurationRevisionId);
  if (!version || version.binding_json !== canonicalJson(binding)) return null;
  return { execution: JSON.parse(version.configuration_json), apiKey: version.api_key };
}

export function textRegistrationOf(db: AgentDatabase, binding: ModelBinding): PiTextRegistration | null {
  const resolved = resolveTextBinding(db, binding);
  if (!resolved || resolved.apiKey === null) return null;
  // 退役协议（旧 OpenAI 兼容/Anthropic 文本快照）不能在新版本执行；在途请求按原绑定
  // 如实失败并提示重发，不静默改投 OpenAI，也不把旧档位解释成新协议能力。
  if (resolved.execution.protocol !== "openai-responses") return null;
  return {
    protocol: "openai-responses",
    baseUrl: resolved.execution.baseUrl,
    modelId: resolved.execution.modelId,
    contextWindowTokens: resolved.execution.contextWindowTokens,
    maxOutputTokens: resolved.execution.maxOutputTokens,
    thinkingLevel: resolved.execution.thinkingLevel ?? "off",
    providerId: binding.providerId,
    apiKey: resolved.apiKey,
  };
}

// —— 保存共用工具 ——

export function normalizeApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key || /[\s\x00-\x1f\x7f]/.test(key)) {
    throw new AgentError("INVALID_INPUT", "API Key 不能为空、含内部空白或控制字符；留空表示保留已保存的 Key。");
  }
  return key;
}

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new AgentError("INVALID_INPUT", "接口地址不是有效的 URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new AgentError("INVALID_INPUT", "接口地址必须是无用户名、密码或查询参数的 HTTPS 地址。");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) {
    throw new AgentError("INVALID_INPUT", "请填写公开模型服务的域名地址。");
  }
  return url.toString().replace(/\/$/, "");
}

// —— 用户资料 ——

export function readUserProfile(db: AgentDatabase, ownerId: string, fallbackDisplayName: string): UserProfile {
  const row = db.prepare("SELECT revision, display_name, bio FROM user_profiles WHERE owner_id=?").get(ownerId) as
    { revision: number; display_name: string; bio: string } | undefined;
  if (!row) return { revision: 0, displayName: fallbackDisplayName, bio: "" };
  return { revision: row.revision, displayName: row.display_name, bio: row.bio };
}

export function saveUserProfile(db: AgentDatabase, clock: AgentClock, ownerId: string, input: SaveUserProfile): SaveUserProfileReceipt {
  const verdict = validatorFor("SaveUserProfile")(input);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 80) throw new AgentError("INVALID_INPUT", "显示名称须为 1–80 个非空白字符。");
  const bio = input.bio;
  const key = { ownerId, operation: "saveUserProfile", targetId: "profile", commandId: input.commandId };
  return db.transaction(() => {
    const replay = checkCommandReceipt<SaveUserProfileReceipt>(db, key, { ...input, displayName });
    if (replay.kind === "replay") return { ...replay.receipt, replayed: true };
    const current = db.prepare("SELECT revision, display_name, bio FROM user_profiles WHERE owner_id=?").get(ownerId) as { revision: number; display_name: string; bio: string } | undefined;
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new AgentError("STALE_REVISION", "设置已被其他页面修改，请读取最新状态后重试。");
    const now = clock();
    if (!current || current.display_name !== displayName || current.bio !== bio) db.prepare(`INSERT INTO user_profiles(owner_id,revision,display_name,bio,updated_at) VALUES(?,1,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1, display_name=excluded.display_name, bio=excluded.bio, updated_at=excluded.updated_at`)
      .run(ownerId, displayName, bio, now);
    const payload: SaveUserProfileReceipt = { profile: readUserProfile(db, ownerId, displayName), replayed: false };
    storeCommandReceipt(db, now, key, { ...input, displayName }, payload);
    return payload;
  })();
}
