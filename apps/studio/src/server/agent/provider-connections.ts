import { readProviderDirectory } from "./provider-directory.js";
import type { Bootstrap, AvailableProviderModels, ConnectionModel, ImportedSettings, ModelBinding, ProviderConnection, ProviderConnectionSettings, SaveProviderConnection, SaveProviderConnectionReceipt } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { validatorFor } from "./validate.js";
import { canonicalJson, newAgentId, systemClock, type AgentClock } from "./util.js";
import { checkCommandReceipt, storeCommandReceipt } from "./conversation-store.js";
import { insertEvent } from "./event-log.js";
import { normalizeApiKey, normalizeBaseUrl, readTextModelView, textBindingOf, textModelsView, type TextExecutionConfig, type TextSettingsView } from "./text-model-settings.js";
import { findOpenAIChatModel, resolveThinkingLevel, thinkingCapabilityOf } from "./text-model.js";
import { readArkVideoCurrent } from "./ark-video-settings.js";
import {
  DEFAULT_ARK_VIDEO_PROFILE, mediaBinding, MINIMAX_SPEECH_MODEL_IDS, MINIMAX_VIDEO_MODEL_IDS, WAN_VIDEO_MODEL_IDS, minimaxSpeechCatalogEntry, minimaxSpeechModelView,
  isWanMediaBaseUrl, minimaxRegionOf, minimaxSpeechBinding, minimaxSpeechProfile, minimaxVideoBinding, minimaxVideoProfile, imageBinding, openaiImageProfile, seedreamImageProfile,
  openaiSpeechBinding, openaiSpeechProfile, OPENAI_IMAGE_MODEL_IDS, OPENAI_SPEECH_MODEL_IDS, wanVideoBinding, wanVideoProfile,
  type MiniMaxSpeechProfile, type MiniMaxVideoProfile, type ImageProfile, type OpenAISpeechProfile, type WanVideoProfile,
} from "./media-config.js";
import { ADDITIONAL_MEDIA_CHANNEL_KIND, insertAdditionalMediaVersion, readAdditionalMediaCurrent, type AdditionalMediaChannel } from "./additional-media-settings.js";
import type { QuoteCatalog } from "./artifact-store.js";

// 连接保存当前地址与凭据；执行表仅保存不可变快照，已受理请求继续解析原版本。
export function readProviderConnections(db: AgentDatabase): ProviderConnectionSettings {
  const row = db.prepare("SELECT revision FROM provider_connection_settings WHERE id=1").get() as { revision: number };
  const connections = (db.prepare("SELECT configuration_json FROM provider_connections ORDER BY rowid").all() as { configuration_json: string }[])
    .map(item => JSON.parse(item.configuration_json) as ProviderConnection);
  return { revision: row.revision, connections, modelStatuses: connections.flatMap(connection => connection.models.map(model => ({
    modelEntryId: model.id,
    unavailableReason: modelUnavailableReason(connection, model),
    // 只读能力：非文本、非 OpenAI 连接与未核实身份都是 null，不解释成“明确不支持推理”。
    thinking: model.kind === "text"
      ? thinkingCapabilityOf(connection.protocol === "openai" ? findOpenAIChatModel(model.modelId, model.baseUrl ?? connection.baseUrl) : null)
      : null,
  }))) };
}

// 配置保存和只读能力状态共用协议地址规则；端口只追加自己的正式路径。
function providerEndpointReason(protocol: ProviderConnection["protocol"], baseUrl: string): string | null {
  if (protocol === "minimax" && minimaxRegionOf(baseUrl) === null) {
    return "MiniMax 接口地址应为中国站或国际站 API 根地址，例如 https://api.minimax.cn；不要附加 /v1 或完整端点。";
  }
  if (protocol === "wan" && !isWanMediaBaseUrl(baseUrl)) {
    return "万相接口地址应为工作空间媒体 API 根地址，例如 https://工作空间.cn-beijing.maas.aliyuncs.com；不要附加 /v1 或完整端点。";
  }
  return null;
}

function modelUnavailableReason(connection: ProviderConnection, model: ConnectionModel): string | null {
  if (!connection.enabled) return "连接已停用";
  if (!model.enabled) return "型号已停用";
  if (!connection.apiKey) return "尚未配置 API Key";
  const baseUrl = model.baseUrl ?? connection.baseUrl;
  const endpointReason = providerEndpointReason(connection.protocol, baseUrl);
  if (endpointReason) return endpointReason;
  if (model.kind === "video") {
    // OpenAI 视频服务已官方停用，不为 /models 残留名称接入；视频按协议分发到三家供应商。
    if (connection.protocol === "openai") return "OpenAI 连接不承载视频；视频保留原供应商连接。";
    if (connection.protocol === "ark") {
      return model.modelId === DEFAULT_ARK_VIDEO_PROFILE.modelId && baseUrl === DEFAULT_ARK_VIDEO_PROFILE.baseUrl
        ? null : "已登记；此型号的媒体执行参数与报价尚未接入";
    }
    if (connection.protocol === "minimax") {
      return MINIMAX_VIDEO_MODEL_IDS.has(model.modelId) && minimaxVideoProfile(model.modelId, baseUrl) !== null
        ? null : "已登记；此型号的媒体执行参数与报价尚未接入";
    }
    if (connection.protocol === "wan") {
      return WAN_VIDEO_MODEL_IDS.has(model.modelId) && wanVideoProfile(model.modelId, baseUrl) !== null
        ? null : "已登记；此型号的媒体执行参数与报价尚未接入";
    }
    // 历史兼容协议连接只读：其视频型号不再接入新执行。
    return "已登记；此型号的媒体执行参数与报价尚未接入";
  }
  if (model.kind === "image" && connection.protocol === "ark") {
    return seedreamImageProfile(model.modelId, baseUrl) ? null : "此火山图片型号或接口地址尚未接入。";
  }
  if (model.kind === "speech" && connection.protocol === "minimax") {
    // MiniMax 配音只接已核实的 2.8 系列与已核实站点；两地域 Key 不是通用 Key。
    return MINIMAX_SPEECH_MODEL_IDS.has(model.modelId) && minimaxSpeechProfile(model.modelId, baseUrl) !== null
      ? null : "已登记；此配音型号的媒体执行参数与报价尚未接入";
  }
  if (connection.protocol !== "openai") {
    const kindLabel = model.kind === "text" ? "文本" : model.kind === "image" ? "图片" : "配音";
    return `${kindLabel}型号不能配置在此连接。`;
  }
  if (model.kind === "text") {
    const known = findOpenAIChatModel(model.modelId, baseUrl);
    if (!known) return "此型号在当前 Pi 目录中没有精确能力，暂不支持";
    if (!model.contextWindowTokens || !model.maxOutputTokens) return "请填写型号的上下文窗口和最大输出";
    const capability = thinkingCapabilityOf(known);
    const level = resolveThinkingLevel(known, model.thinkingLevel);
    if (capability && !capability.levels.includes(level)) return `型号不支持“${level}”推理档位；请改回默认或选择支持的档位。`;
    return null;
  }
  // 图片/配音执行按冻结型号集合判定（B1）；未知新型号可登记为备选，不冒充可执行当前型号。
  if (model.kind === "image") {
    return OPENAI_IMAGE_MODEL_IDS.has(model.modelId) ? null : "已登记；此图片型号的媒体执行参数与报价尚未接入";
  }
  return OPENAI_SPEECH_MODEL_IDS.has(model.modelId) ? null : "已登记；此配音型号的媒体执行参数与报价尚未接入";
}

export function connectedTextModels(db: AgentDatabase) {
  const view = readProviderConnections(db);
  const enabled = new Set(view.modelStatuses.filter(item => item.unavailableReason === null).map(item => item.modelEntryId));
  const ids = readTextModelView(db).entries.filter(item => enabled.has(item.entry.id)).map(item => item.version.configuration_revision_id);
  return textModelsView(db).filter(model => ids.includes(model.binding.configurationRevisionId));
}

export function connectedMediaEnabled(db: AgentDatabase, kind: "video" | "image" | "speech"): boolean {
  return readProviderConnections(db).connections.some(connection => connection.models.some(model => model.kind === kind && model.isDefault && modelUnavailableReason(connection, model) === null));
}

// MiniMax备选沿已有连接与不可变版本进入本次选择，不写当前默认或另造设置服务。
export function connectedSpeechChoices(db: AgentDatabase, probeAvailable: boolean): { catalog: QuoteCatalog; models: Bootstrap["models"] } {
  const catalog: QuoteCatalog = {};
  const models: Bootstrap["models"] = [];
  if (!probeAvailable) return { catalog, models };
  const connections = (db.prepare("SELECT configuration_json FROM provider_connections ORDER BY rowid").all() as { configuration_json: string }[])
    .map(row => JSON.parse(row.configuration_json) as ProviderConnection);
  for (const connection of connections) {
    if (connection.protocol !== "minimax" || !connection.enabled || !connection.apiKey) continue;
    for (const model of connection.models) {
      if (model.kind !== "speech" || !model.enabled) continue;
      const profile = minimaxSpeechProfile(model.modelId, model.baseUrl ?? connection.baseUrl);
      if (!profile) continue;
      const version = db.prepare("SELECT binding_json FROM additional_media_versions WHERE channel_id='minimax-speech' AND profile_json=? AND api_key IS ? ORDER BY created_at DESC LIMIT 1")
        .get(canonicalJson(profile), connection.apiKey) as { binding_json: string } | undefined;
      if (!version) continue;
      const binding = JSON.parse(version.binding_json) as ModelBinding;
      const key = `speech:${binding.modelId}`;
      // 目录键沿现有kind:model；当前默认优先，其余同型号沿连接顺序，不改变绑定匹配规则。
      if (catalog[key] && !model.isDefault) continue;
      catalog[key] = minimaxSpeechCatalogEntry(profile, binding);
      const entry = minimaxSpeechModelView(profile, binding, model.name);
      entry.features.push(model.isDefault ? "当前默认配音" : "可按本次选择");
      const index = models.findIndex(item => item.binding.modelId === binding.modelId);
      if (index < 0) models.push(entry); else models[index] = entry;
    }
  }
  return { catalog, models };
}

// 已有供应商的官方接口归属；合并身份还必须同时匹配协议和非空 Key。
// 不按 Key 单独合并任意域名，也不把不同账号合成同一连接。
function providerName(baseUrl: string): string | null {
  const host = new URL(baseUrl).hostname;
  if (host === "dashscope.aliyuncs.com" || host.endsWith(".maas.aliyuncs.com")) return "阿里云百炼";
  if (["api.minimax.cn", "api.minimaxi.com", "api.minimax.io"].includes(host)) return "MiniMax";
  if (host === "api.deepseek.com") return "DeepSeek";
  if (host.startsWith("ark.") && host.endsWith(".volces.com")) return "火山方舟";
  return null;
}

export function consolidateProviderConnections(connections: ProviderConnection[]): ProviderConnection[] {
  const grouped: ProviderConnection[] = [];
  for (const source of connections) {
    const name = providerName(source.baseUrl);
    let target = grouped.find(item => item.protocol === source.protocol && item.apiKey === source.apiKey
      && (item.baseUrl === source.baseUrl || Boolean(source.apiKey && name && providerName(item.baseUrl) === name)));
    if (!target) { target = { ...source, name: name ?? source.name, models: [] }; grouped.push(target); }
    target.enabled ||= source.enabled;
    for (const model of source.models) {
      const baseUrl = model.baseUrl ?? source.baseUrl;
      target.models.push({ ...model, enabled: model.enabled && source.enabled, baseUrl: baseUrl === target.baseUrl ? null : baseUrl });
    }
  }
  return grouped;
}

export function initializeProviderConnections(db: AgentDatabase, imported: ImportedSettings, clock: AgentClock = systemClock): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM provider_connection_settings WHERE id=1").get()) {
      const before = currentMediaBindings(db);
      const now = clock();
      projectExecutionVersions(db, readProviderConnections(db).connections, now);
      invalidateRemovedMediaBindings(db, now, before);
      return;
    }
    const connections: ProviderConnection[] = [];
    const add = (protocol: ProviderConnection["protocol"], baseUrl: string, apiKey: string | null, label: string, model: ConnectionModel) => {
      let connection = connections.find(item => item.protocol === protocol && item.baseUrl === baseUrl && item.apiKey === apiKey);
      if (!connection) { connection = { id: newAgentId("provider"), name: label, protocol, baseUrl, apiKey, enabled: true, models: [] }; connections.push(connection); }
      if (!connection.models.some(item => item.kind === model.kind && item.modelId === model.modelId)) connection.models.push(model);
    };
    // 只有已配置的旧视频连接可进入选择器。
    const video = readArkVideoCurrent(db);
    if (video?.version.api_key) {
      const profile = JSON.parse(video.version.profile_json) as { modelId: string; baseUrl: string };
      add("ark", profile.baseUrl, video.version.api_key, "火山方舟", { id: newAgentId("model"), kind: "video", name: video.displayName, modelId: profile.modelId, features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: true });
    }
    for (const entry of imported) {
      // 缺配置或本地服务的历史条目不冒充当前可用连接；源导入文件仍保留。
      // 旧文本/图片/配音不因启动导入复活（B3）；视频条目按原用途保留。
      if (entry.kind !== "video" || !entry.modelId || !entry.apiKey || !entry.endpoint.startsWith("https://")) continue;
      const protocol = entry.endpoint.includes("volces.com") ? "ark" : "openai-chat-completions";
      add(protocol, entry.endpoint.replace(/\/+$/, ""), entry.apiKey, entry.name, { id: newAgentId("model"), kind: "video", name: entry.name, modelId: entry.modelId, features: entry.details, contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: false });
    }
    for (const connection of consolidateProviderConnections(connections)) db.prepare("INSERT INTO provider_connections(id,configuration_json) VALUES(?,?)").run(connection.id, canonicalJson(connection));
    db.prepare("INSERT INTO provider_connection_settings(id,revision) VALUES(1,0)").run();
  })();
}

// 单个文本型号的执行投影：地址/Key/型号/推理不变时沿用执行版本；返回当前 revisionId。
// 保存与启动归一共同使用这一段，避免归一调用会递增媒体 revision 的全量投影路径。
function projectTextModel(db: AgentDatabase, text: TextSettingsView, connection: ProviderConnection, model: ConnectionModel, now: string): string | null {
  if (modelUnavailableReason(connection, model) !== null) return null;
  const known = findOpenAIChatModel(model.modelId, model.baseUrl ?? connection.baseUrl)!;
  const execution: TextExecutionConfig = {
    protocol: "openai-responses", baseUrl: model.baseUrl ?? connection.baseUrl, modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens!, maxOutputTokens: model.maxOutputTokens!,
    thinkingLevel: resolveThinkingLevel(known, model.thinkingLevel),
  };
  const previous = text.entries.find(item => item.entry.id === model.id);
  let revisionId = previous?.version.configuration_revision_id;
  if (!previous || previous.version.configuration_json !== canonicalJson(execution) || previous.version.api_key !== connection.apiKey) {
    const binding = textBindingOf(execution, newAgentId("conn"));
    revisionId = binding.configurationRevisionId;
    db.prepare("INSERT INTO text_model_versions(configuration_revision_id,binding_json,configuration_json,api_key,created_at) VALUES(?,?,?,?,?)").run(revisionId, canonicalJson(binding), canonicalJson(execution), connection.apiKey, now);
  }
  db.prepare("INSERT INTO text_model_entries(id,name,features_json,current_configuration_revision_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,features_json=excluded.features_json,current_configuration_revision_id=excluded.current_configuration_revision_id").run(model.id, model.name, canonicalJson(model.features), revisionId!, now);
  return revisionId!;
}

// 模型 → 追加媒体通道：协议与用途共同决定；用途不符或历史协议没有通道
// （modelUnavailableReason 与保存矩阵已拦截，这里只服务投影分发）。
function additionalChannelOf(connection: ProviderConnection, model: ConnectionModel): AdditionalMediaChannel | null {
  if (model.kind === "image") return connection.protocol === "ark" ? "ark-image" : "openai-image";
  if (model.kind === "speech") {
    if (connection.protocol === "openai") return "openai-speech";
    return connection.protocol === "minimax" ? "minimax-speech" : null;
  }
  if (model.kind === "video") {
    if (connection.protocol === "minimax") return "minimax-video";
    return connection.protocol === "wan" ? "wan-video" : null;
  }
  return null;
}

// 图片/配音/追加视频执行投影（B2/M1）：每个可用型号按冻结 profile 建不可变版本（profile/Key/地址不变则复用）；
// 默认型号写 additional_media_settings 当前行，无默认删当前行；版本历史保留，不原地改名。
// 各用途的通道由 additionalChannelOf 决定；每条执行绑定保留供应商与具体型号。
function projectAdditionalMedia(db: AgentDatabase, connection: ProviderConnection, model: ConnectionModel, channel: AdditionalMediaChannel, now: string): void {
  const baseUrl = model.baseUrl ?? connection.baseUrl;
  const profile = channel === "ark-image" ? seedreamImageProfile(model.modelId, baseUrl)
    : channel === "openai-image" ? openaiImageProfile(model.modelId, baseUrl)
    : model.kind === "speech" ? (channel === "minimax-speech" ? minimaxSpeechProfile(model.modelId, baseUrl) : openaiSpeechProfile(model.modelId, baseUrl))
    : channel === "minimax-video" ? minimaxVideoProfile(model.modelId, baseUrl)
    : channel === "wan-video" ? wanVideoProfile(model.modelId, baseUrl) : null;
  if (!profile) return; // 非已核实站点/型号组合：modelUnavailableReason 已拦截，防御不再投影。
  const profileJson = canonicalJson(profile);
  const existing = db.prepare("SELECT configuration_revision_id, binding_json FROM additional_media_versions WHERE channel_id=? AND profile_json=? AND api_key IS ? ORDER BY created_at DESC LIMIT 1")
    .get(channel, profileJson, connection.apiKey) as { configuration_revision_id: string; binding_json: string } | undefined;
  const binding = existing
    ? JSON.parse(existing.binding_json) as ModelBinding
    : model.kind === "image" ? imageBinding(profile as ImageProfile, newAgentId("conn"))
    : model.kind === "speech" ? (channel === "minimax-speech" ? minimaxSpeechBinding(profile as MiniMaxSpeechProfile, newAgentId("conn")) : openaiSpeechBinding(profile as OpenAISpeechProfile, newAgentId("conn")))
    : channel === "minimax-video" ? minimaxVideoBinding(profile as MiniMaxVideoProfile, newAgentId("conn"))
    : wanVideoBinding(profile as WanVideoProfile, newAgentId("conn"));
  if (!existing) insertAdditionalMediaVersion(db, now, channel, binding, profile, connection.apiKey!);
  if (!model.isDefault) return;
  // 名称与当前版本都没变时不递增 revision（与视频投影同一约定）。
  db.prepare(`INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES(?,0,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET revision=revision+1,display_name=excluded.display_name,current_configuration_revision_id=excluded.current_configuration_revision_id,updated_at=excluded.updated_at
    WHERE additional_media_settings.display_name IS NOT excluded.display_name
       OR additional_media_settings.current_configuration_revision_id IS NOT excluded.current_configuration_revision_id`)
    .run(channel, model.name, binding.configurationRevisionId, now);
}

// 每次保存从连接配置生成执行投影；地址/Key/型号不变时沿用执行版本，名称备注不影响绑定。
// 文本按条目投影；视频/图片/配音按默认型号投影当前行，媒体型号先为每个可用型号补齐版本。
// 同类别全局只有一个当前：切换供应商后清掉旧供应商当前行，不残留可见可执行的旧入口。
function projectExecutionVersions(db: AgentDatabase, connections: ProviderConnection[], now: string): void {
  let defaultTextId: string | null = null;
  const text = readTextModelView(db);
  let textChanged = false;
  // 当前行按通道跟踪（不是按类别）：配音在 openai-speech/minimax-speech、视频在 ark/minimax/wan
  // 之间切换时，只有通道级事实才能既写新行又清旧行。
  const channelDefaults = new Set<AdditionalMediaChannel>();
  let arkVideoDefault = false;
  for (const connection of connections) for (const model of connection.models) {
    if (model.kind === "text") {
      const revisionId = projectTextModel(db, text, connection, model, now);
      if (revisionId === null) continue;
      const previous = text.entries.find(item => item.entry.id === model.id)?.entry;
      textChanged ||= !previous || previous.current_configuration_revision_id !== revisionId || previous.name !== model.name || previous.features_json !== canonicalJson(model.features);
      if (model.isDefault) defaultTextId = model.id;
      continue;
    }
    if (modelUnavailableReason(connection, model) !== null) continue;
    if (model.kind === "video" && connection.protocol === "ark") {
      // Ark 视频默认型号仍走单行设置表（存量结构保留）。
      if (!model.isDefault) continue;
      const current = readArkVideoCurrent(db);
      const profile = DEFAULT_ARK_VIDEO_PROFILE;
      let revisionId = current?.version.configuration_revision_id;
      if (!current || current.version.api_key !== connection.apiKey || current.version.profile_json !== canonicalJson(profile)) {
        const existing = db.prepare("SELECT configuration_revision_id FROM ark_video_configuration_versions WHERE profile_json=? AND api_key IS ? ORDER BY created_at DESC LIMIT 1")
          .get(canonicalJson(profile), connection.apiKey) as { configuration_revision_id: string } | undefined;
        if (existing) revisionId = existing.configuration_revision_id;
        else {
          const binding = mediaBinding(profile, newAgentId("conn"));
          revisionId = binding.configurationRevisionId;
          db.prepare("INSERT INTO ark_video_configuration_versions(configuration_revision_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?)").run(revisionId, canonicalJson(binding), canonicalJson(profile), connection.apiKey, now);
        }
      }
      // ON CONFLICT 恢复：视频默认从追加通道切回 Ark 时单行可能已被清理，纯 UPDATE 会丢当前入口。
      db.prepare(`INSERT INTO ark_video_settings(id,revision,display_name,current_configuration_revision_id,updated_at) VALUES(1,0,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=revision+1,display_name=excluded.display_name,current_configuration_revision_id=excluded.current_configuration_revision_id,updated_at=excluded.updated_at
    WHERE ark_video_settings.display_name IS NOT excluded.display_name
       OR ark_video_settings.current_configuration_revision_id IS NOT excluded.current_configuration_revision_id`)
        .run(model.name, revisionId!, now);
      arkVideoDefault = true;
      continue;
    }
    const channel = additionalChannelOf(connection, model);
    if (!channel) continue; // 用途/协议组合不投影（能力判定已拦截）。
    if (model.isDefault) channelDefaults.add(channel);
    projectAdditionalMedia(db, connection, model, channel, now);
  }
  // 该通道没有默认型号时删除当前行（版本历史保留）：用户清空默认、切换供应商
  // （openai↔MiniMax 配音、Ark↔MiniMax/万相 视频）都不残留可见可执行的旧入口，不偷偷回退第一项。
  for (const channel of Object.keys(ADDITIONAL_MEDIA_CHANNEL_KIND) as AdditionalMediaChannel[]) {
    if (channelDefaults.has(channel)) continue;
    db.prepare("DELETE FROM additional_media_settings WHERE channel_id=?").run(channel);
  }
  // 当前视频在追加通道（MiniMax/万相）或没有默认视频时，Ark 单行当前入口一并清空。
  if (!arkVideoDefault) db.prepare("DELETE FROM ark_video_settings WHERE id=1").run();
  if (textChanged || text.defaultEntryId !== defaultTextId) db.prepare("UPDATE text_model_settings SET revision=revision+1,default_entry_id=?,updated_at=? WHERE id=1").run(defaultTextId, now);
}

// 当前全部媒体执行身份（Ark 单行 + 五个追加通道）：行存在即当前（projectExecutionVersions 在同一
// 保存事务里清理失效行），供保存连接时比对被移除的绑定并作废相关未受理提案。
function currentMediaBindings(db: AgentDatabase): { defaults: string[]; speechChoices: string[] } {
  const bindings: string[] = [];
  const video = readArkVideoCurrent(db);
  if (video) bindings.push(video.version.binding_json);
  for (const channel of Object.keys(ADDITIONAL_MEDIA_CHANNEL_KIND) as AdditionalMediaChannel[]) {
    const current = readAdditionalMediaCurrent(db, channel);
    if (current) bindings.push(current.version.binding_json);
  }
  return { defaults: bindings, speechChoices: Object.values(connectedSpeechChoices(db, true).catalog)
    .flatMap(entry => entry.binding ? [canonicalJson(entry.binding)] : []) };
}

// 保存和启动纠偏共用同一失效规则；派生投影与 ready 提案在调用方事务中一起提交。
function invalidateRemovedMediaBindings(db: AgentDatabase, now: string, before: ReturnType<typeof currentMediaBindings>): string[] {
  const after = currentMediaBindings(db);
  // 默认切换沿原失效规则；非默认本次选择则在该备选停用/身份变化时失效。
  const removed = [...before.defaults.filter(binding => !after.defaults.includes(binding)),
    ...before.speechChoices.filter(binding => !after.speechChoices.includes(binding))];
  const changedConversations: string[] = [];
  if (!removed.length) return changedConversations;
  const ready = db.prepare("SELECT id,owner_id,revision,conversation_id,spec_json FROM proposals WHERE state='ready' AND accepted_run_id IS NULL")
    .all() as { id: string; owner_id: string; revision: number; conversation_id: string; spec_json: string }[];
  for (const proposal of ready) {
    const spec = JSON.parse(proposal.spec_json) as { operations: { model?: ModelBinding }[] };
    if (!spec.operations.some(op => removed.includes(canonicalJson(op.model)))) continue;
    db.prepare("UPDATE proposals SET state='stale',revision=revision+1,updated_at=? WHERE id=?").run(now, proposal.id);
    insertEvent(db, now, { ownerId: proposal.owner_id, conversationId: proposal.conversation_id, kind: "proposal.changed", entityId: proposal.id, entityVersion: proposal.revision + 1 });
    changedConversations.push(proposal.conversation_id);
  }
  return changedConversations;
}

export function saveProviderConnection(db: AgentDatabase, clock: AgentClock, ownerId: string, input: unknown): { receipt: SaveProviderConnectionReceipt; changedConversations: string[] } {
  const valid = validatorFor("SaveProviderConnection")(input);
  if (!valid.ok) throw new AgentError("INVALID_INPUT", valid.message);
  const body = input as SaveProviderConnection;
  const key = { ownerId, operation: "saveProviderConnection", targetId: body.connection.id, commandId: body.commandId };
  return db.transaction(() => {
    const replay = checkCommandReceipt<SaveProviderConnectionReceipt>(db, key, body);
    if (replay.kind === "replay") return { receipt: { ...replay.receipt, replayed: true }, changedConversations: [] };
    const state = readProviderConnections(db);
    if (body.expectedRevision !== state.revision) throw new AgentError("STALE_REVISION", "配置已更新，请重新读取后再保存。");
    const old = state.connections.find(item => item.id === body.connection.id);
    const connection: ProviderConnection = { ...body.connection, name: body.connection.name.trim(), baseUrl: normalizeBaseUrl(body.connection.baseUrl), apiKey: body.connection.apiKey === null ? old?.apiKey ?? null : normalizeApiKey(body.connection.apiKey), models: body.connection.models.map(model => ({ ...model, baseUrl: model.baseUrl ? normalizeBaseUrl(model.baseUrl) : null, name: model.name.trim(), modelId: model.modelId.trim(), features: model.features.map(item => item.trim()).filter(Boolean) })) };
    if (!connection.name || connection.models.some(model => !model.name || !model.modelId)) throw new AgentError("INVALID_INPUT", "连接名称、型号名称与型号 ID 不能为空。");
    for (const baseUrl of new Set([connection.baseUrl, ...connection.models.flatMap(model => model.baseUrl ? [model.baseUrl] : [])])) {
      const reason = providerEndpointReason(connection.protocol, baseUrl);
      if (reason) throw new AgentError("INVALID_INPUT", reason);
    }
    // 一条 OpenAI 连接共享 Key。火山另承载图片，MiniMax 另承载配音。
    // 换 Key 是编辑该连接，不是第二个连接。
    if (connection.protocol === "openai") {
      const existing = state.connections.find(item => item.id !== connection.id && item.protocol === "openai");
      if (existing) throw new AgentError("INVALID_INPUT", `已存在 OpenAI 连接「${existing.name}」；更换 Key 请在该连接里编辑，不能新建第二个。`);
      if (connection.models.some(model => model.kind === "video")) throw new AgentError("INVALID_INPUT", "OpenAI 连接不承载视频；视频保留原供应商连接。");
    } else if (connection.models.some(model => model.kind !== "video" && !(connection.protocol === "minimax" && model.kind === "speech") && !(connection.protocol === "ark" && model.kind === "image"))) {
      throw new AgentError("INVALID_INPUT", connection.protocol === "minimax"
        ? "MiniMax 连接只承载配音与视频。"
        : connection.protocol === "ark" ? "火山方舟连接只承载图片与视频。"
        : "文本、图片、配音型号不能配置在此视频连接。");
    }
    // 推理档位只对文本型号有意义：文本省略归一成明确 default，显式值必须属于该精确身份的能力列表；
    // 未知身份只接受 default，非文本带具体档位直接拒绝。不静默夹取用户选择。
    for (const model of connection.models) {
      if (model.kind !== "text") {
        if (model.thinkingLevel !== undefined && model.thinkingLevel !== "default") {
          throw new AgentError("INVALID_INPUT", `型号“${model.name}”不是文本型号，不能设置推理档位。`);
        }
        delete model.thinkingLevel;
        continue;
      }
      const known = findOpenAIChatModel(model.modelId, model.baseUrl ?? connection.baseUrl);
      const requested = model.thinkingLevel ?? "default";
      if (requested !== "default") {
        const capability = thinkingCapabilityOf(known);
        if (!capability) throw new AgentError("INVALID_INPUT", `型号“${model.name}”的推理能力未核实，只能选择默认。`);
        if (!capability.levels.includes(requested)) {
          throw new AgentError("INVALID_INPUT", `型号“${model.name}”不支持“${requested}”推理档位；请选择默认或其他支持档位。`);
        }
      }
      // 保存边界的输出上限核对（A2）：不得超过该精确型号的最大输出；只在保存时检查一次。
      if (model.maxOutputTokens !== null && known && model.maxOutputTokens > known.maxTokens) {
        throw new AgentError("INVALID_INPUT", `型号“${model.name}”的最大输出 ${model.maxOutputTokens} 超过该型号上限 ${known.maxTokens}。`);
      }
      model.thinkingLevel = requested;
    }
    // 同协议 + 同 Key +（同地址或同一已知官方服务商）视为同一入口；空 Key 不跨官方域合并，
    // 不同账号/协议/自定义网关仍可并存。提示复用已有连接，不自动合并或删除用户数据。
    const duplicate = state.connections.find(item => item.id !== connection.id
      && item.protocol === connection.protocol && item.apiKey === connection.apiKey
      && (item.baseUrl === connection.baseUrl
        || (connection.apiKey !== null && providerName(item.baseUrl) !== null && providerName(item.baseUrl) === providerName(connection.baseUrl))));
    if (duplicate) throw new AgentError("INVALID_INPUT", `已存在同一 Key 的连接「${duplicate.name}」，请在那个连接里“选择型号”，不要重复创建入口。`);
    const allIds = state.connections.filter(item => item.id !== connection.id).flatMap(item => item.models.map(model => model.id));
    for (const model of connection.models) {
      if (allIds.includes(model.id)) throw new AgentError("INVALID_INPUT", "型号条目标识重复。");
      allIds.push(model.id);
      if (model.contextWindowTokens !== null && model.maxOutputTokens !== null && model.maxOutputTokens >= model.contextWindowTokens) throw new AgentError("INVALID_INPUT", "最大输出必须小于上下文窗口。");
      if (model.isDefault && modelUnavailableReason(connection, model) !== null) {
        // 停用可清除默认，不强迫自动换用另一个收费型号。
        if (!connection.enabled || !model.enabled) model.isDefault = false;
        else throw new AgentError("INVALID_INPUT", "默认型号需要完整配置且已接入执行能力。");
      }
    }
    const defaults = connection.models.filter(model => model.isDefault).map(model => model.kind);
    if (new Set(defaults).size !== defaults.length) throw new AgentError("INVALID_INPUT", "同一类型只能指定一个默认型号。");
    const before = currentMediaBindings(db);
    const connections = state.connections.filter(item => item.id !== connection.id).map(item => ({ ...item, models: item.models.map(model => defaults.includes(model.kind) ? { ...model, isDefault: false } : model) }));
    connections.push(connection);
    for (const item of connections) db.prepare("INSERT INTO provider_connections(id,configuration_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET configuration_json=excluded.configuration_json").run(item.id, canonicalJson(item));
    const now = clock();
    projectExecutionVersions(db, connections, now);
    const changedConversations = invalidateRemovedMediaBindings(db, now, before);
    db.prepare("UPDATE provider_connection_settings SET revision=revision+1 WHERE id=1").run();
    const receipt = { revision: state.revision + 1, replayed: false };
    storeCommandReceipt(db, now, key, body, receipt);
    return { receipt, changedConversations };
  })();
}

export async function listAvailableProviderModels(db: AgentDatabase, connectionId: string, fetcher: typeof fetch = fetch): Promise<AvailableProviderModels> {
  const connection = readProviderConnections(db).connections.find(item => item.id === connectionId);
  if (!connection) throw new AgentError("NOT_FOUND", "连接不存在。");
  if (!connection.apiKey) throw new AgentError("INVALID_INPUT", "请先保存 API Key。");
  return readProviderDirectory(connection, fetcher);
}
