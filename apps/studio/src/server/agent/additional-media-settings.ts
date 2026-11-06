import type { ModelBinding } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { canonicalJson } from "./util.js";
import {
  MINIMAX_SPEECH_MODEL_IDS, minimaxSpeechCatalogEntry, minimaxSpeechModelView, minimaxSpeechProfile, minimaxVideoProfile,
  imageCatalogEntry, imageModelView, openaiSpeechCatalogEntry, openaiSpeechModelView,
  rangedVideoCatalogEntry, rangedVideoModelView, wanVideoProfile,
  type MiniMaxSpeechProfile, type MiniMaxVideoProfile, type ImageProfile, type OpenAISpeechProfile, type WanVideoProfile,
} from "./media-config.js";
import type { QuoteCatalog } from "./artifact-store.js";

// 当前选择和不可变执行版本分开保存。旧火山图片和 MiniMax 配音快照按原身份只读。
export type AdditionalMediaChannel = "ark-image" | "openai-image" | "openai-speech" | "minimax-speech" | "minimax-video" | "wan-video";

/** channel → 操作类别（供当前绑定收集与投影清理按类别对齐）。 */
export const ADDITIONAL_MEDIA_CHANNEL_KIND: Record<AdditionalMediaChannel, "image" | "speech" | "video"> = {
  "ark-image": "image", "openai-image": "image", "openai-speech": "speech", "minimax-speech": "speech", "minimax-video": "video", "wan-video": "video",
};

// 追加通道的当前目录/型号视图：按 channel 当前行的 profile 形状分发生成（M2 三家新通道）。
type AdditionalMediaView = ReturnType<typeof imageModelView> | ReturnType<typeof minimaxSpeechModelView> | ReturnType<typeof rangedVideoModelView>;

function additionalChannelCatalogEntry(channel: AdditionalMediaChannel, profile: unknown, binding: ModelBinding): QuoteCatalog[string] {
  switch (channel) {
    case "ark-image":
    case "openai-image": return imageCatalogEntry(profile as ImageProfile, binding);
    case "openai-speech": return openaiSpeechCatalogEntry(profile as OpenAISpeechProfile, binding);
    case "minimax-speech": return minimaxSpeechCatalogEntry(profile as MiniMaxSpeechProfile, binding);
    case "minimax-video": {
      const video = profile as MiniMaxVideoProfile;
      return rangedVideoCatalogEntry(binding, video.video, video.quote, "MiniMax H3");
    }
    default: {
      const video = profile as WanVideoProfile;
      return rangedVideoCatalogEntry(binding, video.video, video.quote, "万相");
    }
  }
}

function additionalChannelModelView(channel: AdditionalMediaChannel, profile: unknown, binding: ModelBinding, displayName: string): AdditionalMediaView {
  switch (channel) {
    case "ark-image":
    case "openai-image": return imageModelView(profile as ImageProfile, binding, displayName);
    case "openai-speech": return openaiSpeechModelView(profile as OpenAISpeechProfile, binding, displayName);
    case "minimax-speech": return minimaxSpeechModelView(profile as MiniMaxSpeechProfile, binding, displayName);
    case "minimax-video": {
      const video = profile as MiniMaxVideoProfile;
      return rangedVideoModelView(binding, displayName, video.video, video.quote, "MiniMax H3");
    }
    default: {
      const video = profile as WanVideoProfile;
      return rangedVideoModelView(binding, displayName, video.video, video.quote, "万相");
    }
  }
}

export interface AdditionalMediaVersionRow {
  configuration_revision_id: string;
  channel_id: string;
  binding_json: string;
  profile_json: string;
  api_key: string | null;
  created_at: string;
}

export interface AdditionalMediaCurrent {
  revision: number;
  displayName: string;
  version: AdditionalMediaVersionRow;
}

export function readAdditionalMediaCurrent(db: AgentDatabase, channelId: AdditionalMediaChannel): AdditionalMediaCurrent | null {
  const row = db.prepare("SELECT revision, display_name, current_configuration_revision_id FROM additional_media_settings WHERE channel_id=?")
    .get(channelId) as { revision: number; display_name: string; current_configuration_revision_id: string } | undefined;
  if (!row) return null;
  const version = db.prepare("SELECT * FROM additional_media_versions WHERE configuration_revision_id=?")
    .get(row.current_configuration_revision_id) as AdditionalMediaVersionRow | undefined;
  if (!version) throw new Error(`additional_media_settings(${channelId}) 引用的配置版本缺失。`);
  return { revision: row.revision, displayName: row.display_name, version };
}

export function insertAdditionalMediaVersion(db: AgentDatabase, now: string,
  channelId: AdditionalMediaChannel, binding: ModelBinding, profile: unknown, apiKey: string): AdditionalMediaVersionRow {
  const version: AdditionalMediaVersionRow = {
    configuration_revision_id: binding.configurationRevisionId,
    channel_id: channelId,
    binding_json: canonicalJson(binding),
    profile_json: canonicalJson(profile),
    api_key: apiKey,
    created_at: now,
  };
  db.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?,?)")
    .run(version.configuration_revision_id, version.channel_id, version.binding_json, version.profile_json, version.api_key, now);
  return version;
}

/** 冻结绑定解析：完整 binding 匹配才认；返回值可能是退役 channel 的历史行（调用方按身份明确分发）。 */
export function resolveAdditionalMediaBinding(db: AgentDatabase, binding: ModelBinding):
  { channelId: AdditionalMediaChannel; profileJson: string; apiKey: string | null } | null {
  const row = db.prepare("SELECT channel_id, binding_json, profile_json, api_key FROM additional_media_versions WHERE configuration_revision_id=?")
    .get(binding.configurationRevisionId) as { channel_id: AdditionalMediaChannel; binding_json: string; profile_json: string; api_key: string | null } | undefined;
  if (!row || row.binding_json !== canonicalJson(binding)) return null;
  return { channelId: row.channel_id, profileJson: row.profile_json, apiKey: row.api_key };
}

/** 冻结绑定 → 执行端口入参；channel 不匹配（含退役历史行）返回 null，不跨通道借用身份。 */
export function resolveImageBinding(db: AgentDatabase, binding: ModelBinding): { profile: ImageProfile; apiKey: string | null } | null {
  const row = resolveAdditionalMediaBinding(db, binding);
  if (!row || (row.channelId !== "openai-image" && row.channelId !== "ark-image")) return null;
  const profile = JSON.parse(row.profileJson) as ImageProfile;
  // v11 前的退役火山图片快照没有冻结输出格式，继续仅供历史查阅。
  if (row.channelId === "ark-image" && profile.image?.format !== "jpeg") return null;
  return { profile, apiKey: row.apiKey };
}

export function resolveOpenAISpeechBinding(db: AgentDatabase, binding: ModelBinding): { profile: OpenAISpeechProfile; apiKey: string | null } | null {
  const row = resolveAdditionalMediaBinding(db, binding);
  return row?.channelId === "openai-speech" ? { profile: JSON.parse(row.profileJson) as OpenAISpeechProfile, apiKey: row.apiKey } : null;
}

// 旧 2.8 也使用相同型号：历史实际写入 speech.voiceId/format + quote.amountMinor；
// M2 写入 speech.voice/output + quote.perMillionChars。在持久边界按既有形状识别，不改历史 JSON。
export function resolveMinimaxSpeechBinding(db: AgentDatabase, binding: ModelBinding): { profile: MiniMaxSpeechProfile; apiKey: string | null } | null {
  const row = resolveAdditionalMediaBinding(db, binding);
  if (row?.channelId !== "minimax-speech") return null;
  const profile = JSON.parse(row.profileJson) as MiniMaxSpeechProfile;
  return profile.providerId === "minimax" && MINIMAX_SPEECH_MODEL_IDS.has(profile.modelId)
    && typeof profile.speech?.voice === "string" && profile.speech.output?.format === "mp3"
    && typeof profile.quote?.perMillionChars === "number" ? { profile, apiKey: row.apiKey } : null;
}

// minimax-video/wan-video 是 v13 新通道：不存在退役同名版本行，按通道 + providerId 认定。
export function resolveMinimaxVideoBinding(db: AgentDatabase, binding: ModelBinding): { profile: MiniMaxVideoProfile; apiKey: string | null } | null {
  const row = resolveAdditionalMediaBinding(db, binding);
  if (row?.channelId !== "minimax-video") return null;
  const profile = JSON.parse(row.profileJson) as MiniMaxVideoProfile;
  return profile.providerId === "minimax" ? { profile, apiKey: row.apiKey } : null;
}

export function resolveWanVideoBinding(db: AgentDatabase, binding: ModelBinding): { profile: WanVideoProfile; apiKey: string | null } | null {
  const row = resolveAdditionalMediaBinding(db, binding);
  if (row?.channelId !== "wan-video") return null;
  const profile = JSON.parse(row.profileJson) as WanVideoProfile;
  return profile.providerId === "wan" ? { profile, apiKey: row.apiKey } : null;
}

/** 当前 channel 通道的活跃身份（目录条目与 Bootstrap 型号视图共用）；Key 未配置时没有可执行条目。 */
export function activeAdditionalMediaBinding(db: AgentDatabase, channelId: AdditionalMediaChannel): { profile: unknown; binding: ModelBinding } | null {
  const current = readAdditionalMediaCurrent(db, channelId);
  if (!current?.version.api_key) return null;
  return { profile: JSON.parse(current.version.profile_json), binding: JSON.parse(current.version.binding_json) as ModelBinding };
}

// Bootstrap/每回合 context/prepare/admit 共用的当前目录：凭据与探测均就绪才注册各媒体通道；
// 探测能力由装配层核实后传入（与视频通道同一判定）。
export function additionalMediaCatalog(db: AgentDatabase, probeAvailable: boolean): QuoteCatalog {
  const catalog: QuoteCatalog = {};
  if (!probeAvailable) return catalog;
  for (const channel of Object.keys(ADDITIONAL_MEDIA_CHANNEL_KIND) as AdditionalMediaChannel[]) {
    const active = activeAdditionalMediaBinding(db, channel);
    if (!active) continue;
    catalog[`${ADDITIONAL_MEDIA_CHANNEL_KIND[channel]}:${active.binding.modelId}`] = additionalChannelCatalogEntry(channel, active.profile, active.binding);
  }
  return catalog;
}

export function additionalMediaModelViews(db: AgentDatabase, probeAvailable: boolean): AdditionalMediaView[] {
  const views: AdditionalMediaView[] = [];
  if (!probeAvailable) return views;
  for (const channel of Object.keys(ADDITIONAL_MEDIA_CHANNEL_KIND) as AdditionalMediaChannel[]) {
    const active = activeAdditionalMediaBinding(db, channel);
    if (!active) continue;
    views.push(additionalChannelModelView(channel, active.profile, active.binding,
      channel === "ark-image" ? `火山 Seedream（${active.binding.modelId}）`
        : channel === "openai-image" ? `OpenAI 单图（${active.binding.modelId}）`
        : channel === "openai-speech" ? `OpenAI 配音（${active.binding.modelId}）`
        : channel === "minimax-speech" ? `MiniMax 配音（${active.binding.modelId}）`
        : channel === "minimax-video" ? `MiniMax 视频（${active.binding.modelId}）`
        : `万相视频（${active.binding.modelId}）`));
  }
  return views;
}
