import { readFileSync } from "node:fs";
import type { Bootstrap, ModelBinding } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import {
  arkVideoCatalogEntry, arkVideoModelEntry, arkVideoUnavailableReason, DEFAULT_ARK_VIDEO_PROFILE,
  mediaBinding, parseAgentMediaConfig, narratedRenderCatalogEntry, renderCatalogEntry, timedNarratedRenderCatalogEntry, mixedRenderCatalogEntry,
  type AgentMediaConfig, type ArkVideoProfile, type LocalRenderFacts,
} from "./media-config.js";
import { NARRATED_CATALOG_KEY, RENDER_CATALOG_KEY, TIMED_NARRATED_CATALOG_KEY, type QuoteCatalog } from "./artifact-store.js";
import { canonicalJson, newAgentId, type AgentClock } from "./util.js";

// Ark 当前执行投影由统一连接保存维护；不可变版本继续服务已受理运行和首次旧配置导入。
export interface ArkVideoVersionRow {
  configuration_revision_id: string;
  binding_json: string;
  profile_json: string;
  api_key: string | null;
  created_at: string;
}

export interface ArkVideoCurrent {
  revision: number;
  displayName: string;
  version: ArkVideoVersionRow;
}

export function readArkVideoCurrent(db: AgentDatabase): ArkVideoCurrent | null {
  const row = db.prepare("SELECT revision, display_name, current_configuration_revision_id FROM ark_video_settings WHERE id=1")
    .get() as { revision: number; display_name: string; current_configuration_revision_id: string } | undefined;
  if (!row) return null;
  const version = db.prepare("SELECT * FROM ark_video_configuration_versions WHERE configuration_revision_id=?")
    .get(row.current_configuration_revision_id) as ArkVideoVersionRow | undefined;
  if (!version) throw new Error("ark_video_settings 引用的配置版本缺失。");
  return { revision: row.revision, displayName: row.display_name, version };
}

function insertVersion(db: AgentDatabase, now: string, profile: ArkVideoProfile, connectionId: string, apiKey: string | null): ArkVideoVersionRow {
  const binding = mediaBinding(profile, connectionId);
  const version: ArkVideoVersionRow = {
    configuration_revision_id: binding.configurationRevisionId,
    binding_json: canonicalJson(binding),
    profile_json: canonicalJson(profile),
    api_key: apiKey,
    created_at: now,
  };
  db.prepare("INSERT INTO ark_video_configuration_versions(configuration_revision_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?)")
    .run(version.configuration_revision_id, version.binding_json, version.profile_json, version.api_key, now);
  return version;
}

export interface ArkVideoInitOptions {
  clock: AgentClock;
  /** 显式旧部署配置（AGENT_MEDIA_CONFIG_FILE）；凭据读取由调用方在装配层完成授权判断后传入。 */
  legacy?: { config: AgentMediaConfig; apiKey?: string | undefined } | undefined;
}

// 先判定迁移资格，再读取指定秘密；统一设置建立后不再依赖旧文件。
export function readLegacyArkConfig(db: AgentDatabase, file: string, authorized: boolean): ArkVideoInitOptions["legacy"] {
  if (db.prepare("SELECT 1 FROM provider_connection_settings WHERE id=1").get()) return undefined;
  const existing = readArkVideoCurrent(db);
  if (existing && (!authorized || !db.prepare("SELECT 1 FROM ark_video_configuration_versions WHERE api_key IS NULL LIMIT 1").get())) return undefined;
  const config = parseAgentMediaConfig(JSON.parse(readFileSync(file, "utf8")));
  if (existing && !db.prepare("SELECT 1 FROM ark_video_configuration_versions WHERE binding_json=? AND api_key IS NULL")
    .get(canonicalJson(mediaBinding(config, config.connectionId)))) return undefined;
  if (!authorized) return { config };
  const apiKey = readFileSync(config.credentialFile, "utf8").trim();
  if (!apiKey) throw new Error(`媒体凭据文件为空：${config.credentialFile}`);
  return { config, apiKey };
}

// 首次旧部署导入或无凭据能力模板；统一设置形成后，启动不能另造当前选择或补写历史 Key。
export function initializeArkVideoSettings(db: AgentDatabase, options: ArkVideoInitOptions): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM provider_connection_settings WHERE id=1").get()) return;
    const existing = readArkVideoCurrent(db);
    const now = options.clock();
    if (!existing) {
      const profile = options.legacy?.config ?? DEFAULT_ARK_VIDEO_PROFILE;
      const version = insertVersion(db, now, profile, options.legacy?.config.connectionId ?? newAgentId("conn"), options.legacy?.apiKey ?? null);
      db.prepare("INSERT INTO ark_video_settings(id,revision,display_name,current_configuration_revision_id,updated_at) VALUES(1,0,?,?,?)")
        .run(`Seedance 文生视频（${profile.modelId}）`, version.configuration_revision_id, now);
      return;
    }
    const legacy = options.legacy;
    if (!legacy?.apiKey) return;
    // 未建立统一设置的旧部署，只补精确匹配的空 Key，不切 current、不替换非空历史 Key。
    const expected = canonicalJson(mediaBinding(legacy.config, legacy.config.connectionId));
    const match = db.prepare("SELECT configuration_revision_id FROM ark_video_configuration_versions WHERE binding_json=? AND api_key IS NULL")
      .get(expected) as { configuration_revision_id: string } | undefined;
    if (!match) return;
    db.prepare("UPDATE ark_video_configuration_versions SET api_key=? WHERE configuration_revision_id=? AND api_key IS NULL")
      .run(legacy.apiKey, match.configuration_revision_id);
    if (existing.version.configuration_revision_id === match.configuration_revision_id) {
      db.prepare("UPDATE ark_video_settings SET revision=revision+1,updated_at=? WHERE id=1").run(now);
    }
  })();
}

export function arkVideoModelView(current: ArkVideoCurrent, render: LocalRenderFacts): Bootstrap["models"][number] {
  const profile = JSON.parse(current.version.profile_json) as ArkVideoProfile;
  const binding = JSON.parse(current.version.binding_json) as ModelBinding;
  const credentialsConfigured = current.version.api_key !== null;
  return arkVideoModelEntry(profile, binding, current.displayName,
    credentialsConfigured && render.probeAvailable, arkVideoUnavailableReason(credentialsConfigured, render));
}

// Bootstrap/每回合 context/prepare/admit 共用当前投影；render 能力独立。
export function arkVideoCatalog(current: ArkVideoCurrent | null, render: LocalRenderFacts): QuoteCatalog {
  const catalog: QuoteCatalog = {};
  if (current?.version.api_key && render.probeAvailable) {
    const profile = JSON.parse(current.version.profile_json) as ArkVideoProfile;
    const binding = JSON.parse(current.version.binding_json) as ModelBinding;
    catalog[`video:${profile.modelId}`] = arkVideoCatalogEntry(profile, binding);
  }
  if (render.available) catalog[RENDER_CATALOG_KEY] = renderCatalogEntry(render.aacAvailable);
  if (render.available && render.aacAvailable) catalog[NARRATED_CATALOG_KEY] = narratedRenderCatalogEntry();
  if (render.available && render.aacAvailable) catalog[TIMED_NARRATED_CATALOG_KEY] = timedNarratedRenderCatalogEntry();
  if (render.available && render.aacAvailable) catalog["render:mixed_concat"] = mixedRenderCatalogEntry();
  return catalog;
}

// 冻结绑定解析只读原版本与原 Key，不依赖当前选择。
export function resolveArkBinding(db: AgentDatabase, binding: ModelBinding): { profile: ArkVideoProfile; apiKey: string | null } | null {
  const row = db.prepare("SELECT binding_json, profile_json, api_key FROM ark_video_configuration_versions WHERE configuration_revision_id=?")
    .get(binding.configurationRevisionId) as { binding_json: string; profile_json: string; api_key: string | null } | undefined;
  if (!row || row.binding_json !== canonicalJson(binding)) return null;
  return { profile: JSON.parse(row.profile_json), apiKey: row.api_key };
}
