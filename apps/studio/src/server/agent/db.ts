import Database from "better-sqlite3";
import { configureCredentialCipher } from "./credential-cipher.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

// A 增量业务库：一个 SQLite 连接责任边界。WAL + FULL + 外键 + busy_timeout，
// 短事务；模型与网络调用一律在事务外。库不可用时直接抛错，不回退内存/JSON。
export type AgentDatabase = Database.Database;

const statements = new WeakMap<AgentDatabase, Map<string, Database.Statement>>();

export function stmt(db: AgentDatabase, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) { cache = new Map(); statements.set(db, cache); }
  let prepared = cache.get(sql);
  if (!prepared) { prepared = db.prepare(sql); cache.set(sql, prepared); }
  return prepared;
}

// 版本化 DDL：可重复执行；已应用版本跳过，重复迁移不毁数据。
// MIGRATIONS 同时是测试 fixture 的事实来源（按历史版本截取构建 C1 形状库），不另建第二份 SQL。
// foreignKeys:"off" 的迁移（父表重建）在事务外关闭外键约束执行；data 是同事务内的数据改写步骤。
export const MIGRATIONS: readonly {
  version: number;
  statements: readonly string[];
  foreignKeys?: "off";
  data?: (db: AgentDatabase) => void;
}[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE conversations(
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_seq INTEGER NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        pi_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX conversations_owner_seq ON conversations(owner_id, created_seq)`,
      `CREATE TABLE command_receipts(
        owner_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        target_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        body_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, operation, target_id, command_id)
      )`,
      `CREATE TABLE requests(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        text TEXT NOT NULL,
        target_json TEXT,
        skill_id TEXT,
        model_id TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('new')),
        queue_seq INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','completed','stopped','failed')),
        execution_epoch INTEGER,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        delivery_closed INTEGER NOT NULL DEFAULT 0,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX requests_conversation_queue ON requests(conversation_id, queue_seq)`,
      `CREATE INDEX requests_pending ON requests(conversation_id, state, queue_seq)`,
      `CREATE TABLE messages(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL,
        request_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system_notice')),
        kind TEXT NOT NULL CHECK (kind IN ('chat','feedback','notice')),
        state TEXT NOT NULL CHECK (state IN ('queued','running','completed','stopped','failed')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        text TEXT NOT NULL,
        target_json TEXT,
        references_json TEXT NOT NULL,
        feedback_json TEXT,
        created_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX messages_conversation_seq ON messages(conversation_id, created_seq)`,
      `CREATE INDEX messages_request ON messages(request_id)`,
      `CREATE TABLE artifacts(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('prompt','script','analysis','video','image','audio')),
        work_id TEXT,
        head_revision_id TEXT,
        head_revision_number INTEGER NOT NULL DEFAULT 0,
        created_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX artifacts_conversation_seq ON artifacts(conversation_id, created_seq)`,
      `CREATE TABLE artifact_revisions(
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
        base_revision_id TEXT,
        request_id TEXT,
        run_id TEXT,
        digest TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, revision_number)
      )`,
      `CREATE INDEX artifact_revisions_request ON artifact_revisions(request_id)`,
      `CREATE TABLE request_deliveries(
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        batch_digest TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE tool_invocations(
        owner_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        args_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('registered','committed')),
        result_json TEXT,
        proposal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, request_id, tool_call_id)
      )`,
      `CREATE TABLE proposals(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ready','stale','expired','accepted')),
        price_disclosure TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_run_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX proposals_conversation_seq ON proposals(conversation_id, created_seq)`,
      `CREATE TABLE events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message.changed','artifact.delivered','proposal.changed','run.changed','conversation.changed')),
        entity_id TEXT NOT NULL,
        entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
        notification TEXT NOT NULL CHECK (notification IN ('quiet','new_output')),
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX events_conversation_seq ON events(conversation_id, seq)`,
    ],
  },
  { version: 2, statements: [
    "ALTER TABLE conversations ADD COLUMN pi_checkpoint_json TEXT",
    "ALTER TABLE conversations ADD COLUMN pi_needs_recovery INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE requests ADD COLUMN model_binding_json TEXT",
  ] },
  { version: 3, statements: [
    `CREATE TABLE works(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id))`,
    `CREATE TABLE production_snapshots(id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TRIGGER production_snapshot_immutable BEFORE UPDATE ON production_snapshots BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END`,
    `CREATE TABLE user_actions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES proposals(id), source TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE authorizations(id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id), action_id TEXT NOT NULL REFERENCES user_actions(id), run_id TEXT NOT NULL UNIQUE, max_minor INTEGER NOT NULL CHECK(max_minor>=0))`,
    `CREATE TABLE production_runs(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      work_id TEXT NOT NULL REFERENCES works(id), snapshot_id TEXT NOT NULL UNIQUE REFERENCES production_snapshots(id),
      proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id), title TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','unknown','cancel_requested','succeeded','failed','cancelled')),
      revision INTEGER NOT NULL DEFAULT 1, created_seq INTEGER NOT NULL, issue_json TEXT,
      lease_owner TEXT, execution_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, created_seq)
    )`,
    `CREATE UNIQUE INDEX work_in_flight ON production_runs(work_id) WHERE state IN ('queued','running','unknown','cancel_requested')`,
    `CREATE TABLE production_input_locks(run_id TEXT NOT NULL REFERENCES production_runs(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(run_id,artifact_id))`,
    `CREATE TABLE production_blobs(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, digest TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL)`,
    `CREATE TABLE production_operations(
      run_id TEXT NOT NULL REFERENCES production_runs(id), id TEXT NOT NULL, spec_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', output_blob_id TEXT REFERENCES production_blobs(id),
      PRIMARY KEY(run_id,id)
    )`,
    `CREATE TABLE production_attempts(
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, operation_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      request_identity TEXT NOT NULL UNIQUE, phase TEXT NOT NULL CHECK(phase IN ('prepared','submit_started','observed')),
      state TEXT NOT NULL, provider_task_id TEXT, reserve_minor INTEGER NOT NULL,
      billing_json TEXT, billed_minor INTEGER NOT NULL DEFAULT 0, billing_final INTEGER NOT NULL DEFAULT 0,
      billing_conflict INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(run_id,operation_id) REFERENCES production_operations(run_id,id),
      UNIQUE(run_id,operation_id,ordinal)
    )`,
    `CREATE TABLE ledger_observations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES production_attempts(id),
      digest TEXT NOT NULL, observation_json TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
      UNIQUE(attempt_id,digest)
    )`,
    `CREATE TABLE revision_blob_links(revision_id TEXT PRIMARY KEY REFERENCES artifact_revisions(id), blob_id TEXT NOT NULL REFERENCES production_blobs(id))`,
  ] },
  { version: 4, statements: [
    // C1 尝试效果收据：唯一键 attemptId，定位未发布的本地成品与本地执行退出证据。
    // 只记效果身份，不含费用或消费权限；正式发布仍由 worker 原事务绑定输出槽位。
    `CREATE TABLE production_attempt_outputs(
      attempt_id TEXT PRIMARY KEY REFERENCES production_attempts(id),
      provider_task_id TEXT,
      blob_id TEXT REFERENCES production_blobs(id),
      digest TEXT,
      exit_code INTEGER,
      exit_kind TEXT CHECK(exit_kind IS NULL OR exit_kind IN ('completed','failed','terminated')),
      detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ] },
  { version: 5, statements: [
    // C2 视频配置：current 设置行与不可变连接版本分离；版本一旦落库不改，换 Key 只新增版本。
    // api_key 只存在服务端私有库；binding_json/profile_json 均为非秘密执行配置。
    `CREATE TABLE ark_video_configuration_versions(
      configuration_revision_id TEXT PRIMARY KEY,
      binding_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE ark_video_settings(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL REFERENCES ark_video_configuration_versions(configuration_revision_id),
      updated_at TEXT NOT NULL
    )`,
  ] },
  { version: 6, statements: [
    // T2 文本多连接：settings 单例 + 展示条目 + 不可变执行版本分离。
    // configuration_json 只存执行字段；name/features 只由 entries 供给。api_key 明文私有。
    `CREATE TABLE text_model_settings(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      default_entry_id TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE text_model_versions(
      configuration_revision_id TEXT PRIMARY KEY,
      binding_json TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE text_model_entries(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      features_json TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL REFERENCES text_model_versions(configuration_revision_id),
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE user_profiles(
      owner_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ] },
  { version: 7, statements: [
    // T3 免费服务：pexels/newsnow 各一行当前配置；Key 明文只存服务端私有库。
    // material_candidates 是本次请求的候选事实（含服务端私有下载地址），import 后挂 blob；
    // material_blob_sources 记录每个素材 blob 的署名来源。
    `CREATE TABLE free_service_settings(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','newsnow')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE material_candidates(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      request_id TEXT NOT NULL REFERENCES requests(id),
      provider_asset_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','video')),
      download_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      imported_blob_id TEXT REFERENCES production_blobs(id),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX material_candidates_request ON material_candidates(request_id)`,
    `CREATE TABLE material_blob_sources(
      blob_id TEXT PRIMARY KEY REFERENCES production_blobs(id),
      sources_json TEXT NOT NULL
    )`,
  ] },
  { version: 8, statements: [
    // T4/T5 追加真实媒体通道共用的持久规则：每通道一行 current + 不可变版本。
    // channel_id 限定本包两条通道，不是任意 JSON 插件注册平台。
    `CREATE TABLE additional_media_settings(
      channel_id TEXT PRIMARY KEY CHECK (channel_id IN ('ark-image','minimax-speech')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE additional_media_versions(
      configuration_revision_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL CHECK (channel_id IN ('ark-image','minimax-speech')),
      binding_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX additional_media_versions_binding ON additional_media_versions(binding_json)`,
  ] },
  { version: 9, statements: [
    `CREATE TABLE provider_connections(id TEXT PRIMARY KEY, configuration_json TEXT NOT NULL)`,
    `CREATE TABLE provider_connection_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)`,
  ] },
  { version: 10, statements: [
    // 创作事项可在准备期存在；旧行没有阶段状态，读取为空，不补造历史认可。
    `ALTER TABLE works ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE works ADD COLUMN creation_state_json TEXT`,
    `ALTER TABLE works ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE works ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE works ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE artifact_revisions ADD COLUMN creation_binding_json TEXT`,
    `CREATE TABLE work_stage_confirmations(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      work_id TEXT NOT NULL REFERENCES works(id),
      stage TEXT NOT NULL CHECK (stage IN ('content','plan','video')),
      action TEXT NOT NULL CHECK (action IN ('approve_content','approve_content_continue','approve_plan','finalize_video')),
      subject_json TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('user_message','proposal_accept')),
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX work_stage_confirmations_work ON work_stage_confirmations(work_id, stage, created_at)`,
    `CREATE TABLE material_search_batches(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      request_id TEXT NOT NULL REFERENCES requests(id),
      tool_call_id TEXT NOT NULL,
      work_id TEXT,
      query_json TEXT NOT NULL,
      results_json TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX material_search_batches_conversation ON material_search_batches(conversation_id, created_at)`,
    `ALTER TABLE material_candidates ADD COLUMN batch_id TEXT`,
    // 事项与素材批次变化沿用既有事件表；重建 CHECK 以接受新事件类型。
    `CREATE TABLE events_v10(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('message.changed','artifact.delivered','proposal.changed','run.changed','conversation.changed','work.changed','material.changed')),
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
      notification TEXT NOT NULL CHECK (notification IN ('quiet','new_output')),
      created_at TEXT NOT NULL
    )`,
    `INSERT INTO events_v10(seq,event_id,conversation_id,owner_id,kind,entity_id,entity_version,notification,created_at)
      SELECT seq,event_id,conversation_id,owner_id,kind,entity_id,entity_version,notification,created_at FROM events`,
    `DROP TABLE events`,
    `ALTER TABLE events_v10 RENAME TO events`,
    `CREATE INDEX events_conversation_seq ON events(conversation_id, seq)`,
  ] },
  { version: 11, statements: [
    // OpenAI 收敛迁移（执行包 §6 B3）：存量库一次性退役旧文本/图片/配音配置，不复活、不改写历史身份。
    // 1) additional_media 两表重建：当前行只接受 openai-image/openai-speech（旧当前行随 DROP 退役），
    //    版本表保留旧 channel 历史行并接纳新 channel。
    `CREATE TABLE additional_media_settings_v11(
      channel_id TEXT PRIMARY KEY CHECK (channel_id IN ('openai-image','openai-speech')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `DROP TABLE additional_media_settings`,
    `ALTER TABLE additional_media_settings_v11 RENAME TO additional_media_settings`,
    `CREATE TABLE additional_media_versions_v11(
      configuration_revision_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL CHECK (channel_id IN ('ark-image','minimax-speech','openai-image','openai-speech')),
      binding_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `INSERT INTO additional_media_versions_v11(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at)
      SELECT configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at FROM additional_media_versions`,
    `DROP TABLE additional_media_versions`,
    `ALTER TABLE additional_media_versions_v11 RENAME TO additional_media_versions`,
    `CREATE INDEX additional_media_versions_binding ON additional_media_versions(binding_json)`,
    // 2) provider_connections：退役全部 text/image/speech 型号（唯一合法归属是尚不存在的 OpenAI 连接），
    //    只留各连接的 video 型号；型号清空的连接整行删除。混合连接只去退役 kind，视频原样保留。
    `UPDATE provider_connections SET configuration_json = json_set(configuration_json, '$.models',
      (SELECT json_group_array(json(op.value)) FROM json_each(provider_connections.configuration_json, '$.models') op
        WHERE json_extract(op.value, '$.kind') = 'video'))`,
    `DELETE FROM provider_connections WHERE json_array_length(configuration_json, '$.models') = 0`,
    // 3) 旧文本投影条目退役；默认指针指向已删条目时清空（新配置由统一连接保存重建投影）。
    `DELETE FROM text_model_entries WHERE id NOT IN (
      SELECT json_extract(op.value, '$.id') FROM provider_connections pc, json_each(pc.configuration_json, '$.models') op)`,
    `UPDATE text_model_settings SET default_entry_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE default_entry_id IS NOT NULL AND default_entry_id NOT IN (
      SELECT json_extract(op.value, '$.id') FROM provider_connections pc, json_each(pc.configuration_json, '$.models') op)`,
    // 4) 引用退役绑定的未受理提案转 stale（内容保留，重新准备需新选择）；已受理快照不动。
    `UPDATE proposals SET state='stale', revision=revision+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE state='ready' AND accepted_run_id IS NULL AND EXISTS (
        SELECT 1 FROM json_each(proposals.spec_json, '$.operations') op
        WHERE json_extract(op.value, '$.model.providerId') IN (
          SELECT json_extract(binding_json, '$.providerId') FROM additional_media_versions WHERE channel_id IN ('ark-image','minimax-speech')
          UNION
          SELECT json_extract(binding_json, '$.providerId') FROM text_model_versions
            WHERE json_extract(configuration_json, '$.protocol') <> 'openai-responses'))`,
    // 5) 无在途任务引用时，退役通道/退役协议执行版本的明文 Key 清空（历史身份与账务事实不改写）。
    //    在途（queued/running/unknown/cancel_requested）引用的版本保留 Key，供原绑定如实核销。
    `UPDATE additional_media_versions SET api_key = NULL
      WHERE channel_id IN ('ark-image','minimax-speech') AND api_key IS NOT NULL
      AND json_extract(binding_json, '$.providerId') NOT IN (
        SELECT DISTINCT json_extract(op.value, '$.model.providerId') FROM production_runs r
          JOIN production_operations po ON po.run_id = r.id, json_each(po.spec_json, '$.operations') op
        WHERE r.state IN ('queued','running','unknown','cancel_requested')
          AND json_extract(op.value, '$.model.providerId') IS NOT NULL)`,
    `UPDATE text_model_versions SET api_key = NULL
      WHERE api_key IS NOT NULL AND json_extract(configuration_json, '$.protocol') <> 'openai-responses'
      AND json_extract(binding_json, '$.providerId') NOT IN (
        SELECT DISTINCT json_extract(op.value, '$.model.providerId') FROM production_runs r
          JOIN production_operations po ON po.run_id = r.id, json_each(po.spec_json, '$.operations') op
        WHERE r.state IN ('queued','running','unknown','cancel_requested')
          AND json_extract(op.value, '$.model.providerId') IS NOT NULL)`,
  ] },
  { version: 12, statements: [
    // 提案与方案主稿的准确关系（执行包 §10.1）：proposals 增私有可空 plan_source_json，
    // 存该提案绑定的方案修订来源（artifact_revision ContentSource）。唯一写入者是
    // deliver_artifacts 交付事务与 prepare 的原样重提继承；受理后不可变。
    // 历史只回填已有直接绑定能证明的引用（revision creation_binding.proposalRef），
    // 不按标题/时间/相似文本编造关联。
    `ALTER TABLE proposals ADD COLUMN plan_source_json TEXT`,
    `UPDATE proposals SET plan_source_json = (
      SELECT json_object('kind','artifact_revision','artifactId',r.artifact_id,'revisionId',r.id,'digest',r.digest)
      FROM artifact_revisions r JOIN artifacts a ON a.id = r.artifact_id
      WHERE a.conversation_id = proposals.conversation_id
        AND json_extract(r.creation_binding_json, '$.stage') = 'plan'
        AND json_extract(r.creation_binding_json, '$.proposalRef.proposalId') = proposals.id
      LIMIT 1)`,
  ] },
  { version: 13, statements: [
    // 媒体后续包 M1（执行包 §11.2）：重建 additional_media 两表 CHECK，允许 MiniMax
    // speech/video 与万相 video 的当前行及版本。纯 CHECK 扩展，不改任何数据——升级不产生
    // MiniMax/Wan 当前选择、不回填旧 Key；旧退役 minimax-speech 版本行保持原义（v11 的
    // “无在途引用才清空 Key”规则不变），新旧版本按不可变 configurationRevisionId + 完整
    // binding 匹配区分，退役行不被新端口接管。
    `CREATE TABLE additional_media_settings_v13(
      channel_id TEXT PRIMARY KEY CHECK (channel_id IN ('openai-image','openai-speech','minimax-speech','minimax-video','wan-video')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO additional_media_settings_v13(channel_id,revision,display_name,current_configuration_revision_id,updated_at)
      SELECT channel_id,revision,display_name,current_configuration_revision_id,updated_at FROM additional_media_settings`,
    `DROP TABLE additional_media_settings`,
    `ALTER TABLE additional_media_settings_v13 RENAME TO additional_media_settings`,
    `CREATE TABLE additional_media_versions_v13(
      configuration_revision_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL CHECK (channel_id IN ('ark-image','minimax-speech','openai-image','openai-speech','minimax-video','wan-video')),
      binding_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `INSERT INTO additional_media_versions_v13(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at)
      SELECT configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at FROM additional_media_versions`,
    `DROP TABLE additional_media_versions`,
    `ALTER TABLE additional_media_versions_v13 RENAME TO additional_media_versions`,
    `CREATE INDEX additional_media_versions_binding ON additional_media_versions(binding_json)`,
  ] },
  { version: 14, statements: [
    // 免费素材扩容（执行包 §7 D）：重建 free_service_settings CHECK 接受九个素材来源行。
    // 纯 CHECK 扩展，不改任何数据：升级只让新服务行可写，不创建行、不动已有 Pexels/NewsNow 配置。
    `CREATE TABLE free_service_settings_v14(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','pixabay','unsplash','coverr','wikimedia','nasa','met','cleveland','archive','newsnow')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO free_service_settings_v14(service_id,revision,config_json,api_key,updated_at)
      SELECT service_id,revision,config_json,api_key,updated_at FROM free_service_settings`,
    `DROP TABLE free_service_settings`,
    `ALTER TABLE free_service_settings_v14 RENAME TO free_service_settings`,
  ] },
  { version: 15, statements: [
    // 音乐素材：仅扩现有 CHECK，保留候选、原批次、采用关系与设置；不默认启用新来源。
    `CREATE TABLE material_candidates_v15(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      request_id TEXT NOT NULL REFERENCES requests(id),
      provider_asset_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','video','audio')),
      download_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      imported_blob_id TEXT REFERENCES production_blobs(id),
      created_at TEXT NOT NULL,
      batch_id TEXT
    )`,
    `INSERT INTO material_candidates_v15(id,owner_id,conversation_id,request_id,provider_asset_id,kind,download_url,metadata_json,imported_blob_id,created_at,batch_id)
      SELECT id,owner_id,conversation_id,request_id,provider_asset_id,kind,download_url,metadata_json,imported_blob_id,created_at,batch_id FROM material_candidates ORDER BY rowid`,
    `DROP TABLE material_candidates`,
    `ALTER TABLE material_candidates_v15 RENAME TO material_candidates`,
    `CREATE INDEX material_candidates_request ON material_candidates(request_id)`,
    `CREATE TABLE free_service_settings_v15(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','pixabay','unsplash','coverr','wikimedia','nasa','met','cleveland','archive','freetouse','newsnow')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO free_service_settings_v15(service_id,revision,config_json,api_key,updated_at)
      SELECT service_id,revision,config_json,api_key,updated_at FROM free_service_settings`,
    `DROP TABLE free_service_settings`,
    `ALTER TABLE free_service_settings_v15 RENAME TO free_service_settings`,
  ] },
  { version: 16, statements: [
    `CREATE TABLE additional_media_settings_v16(
      channel_id TEXT PRIMARY KEY CHECK (channel_id IN ('openai-image','ark-image','openai-speech','minimax-speech','minimax-video','wan-video')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      display_name TEXT NOT NULL,
      current_configuration_revision_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO additional_media_settings_v16 SELECT * FROM additional_media_settings`,
    `DROP TABLE additional_media_settings`,
    `ALTER TABLE additional_media_settings_v16 RENAME TO additional_media_settings`,
  ] },
  { version: 17, statements: [
    `CREATE TABLE free_service_settings_v17(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','pixabay','unsplash','coverr','wikimedia','nasa','met','cleveland','archive','freetouse','incompetech','newsnow')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO free_service_settings_v17 SELECT service_id,revision,config_json,api_key,updated_at FROM free_service_settings`,
    `DROP TABLE free_service_settings`,
    `ALTER TABLE free_service_settings_v17 RENAME TO free_service_settings`,
  ] },
  { version: 18, statements: [
    `CREATE TABLE free_service_settings_v18(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','pixabay','unsplash','coverr','wikimedia','nasa','met','cleveland','archive','freetouse','incompetech','douyin-music','tiktok-sounds','newsnow')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO free_service_settings_v18 SELECT service_id,revision,config_json,api_key,updated_at FROM free_service_settings`,
    `DROP TABLE free_service_settings`,
    `ALTER TABLE free_service_settings_v18 RENAME TO free_service_settings`,
  ] },
  { version: 19, foreignKeys: "off", statements: [
    // 组审阅模型：消息携带作品库选材；确认事实单表记录；
    // production_runs.proposal_id 改可空并补 source_request_id（免费本地运行），保留全部旧行。
    `ALTER TABLE messages ADD COLUMN library_selections_json TEXT`,
    `CREATE TABLE work_review_confirmations(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      work_id TEXT NOT NULL REFERENCES works(id),
      group_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('approve','approve_and_continue','finalize_video')),
      subject_json TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('user_message','pi_tool')),
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX work_review_confirmations_item ON work_review_confirmations(work_id, item_id, created_at)`,
    `CREATE INDEX work_review_confirmations_owner_action ON work_review_confirmations(owner_id, action)`,
    `CREATE TABLE production_runs_v19(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      work_id TEXT NOT NULL REFERENCES works(id), snapshot_id TEXT NOT NULL UNIQUE REFERENCES production_snapshots(id),
      proposal_id TEXT UNIQUE REFERENCES proposals(id), source_request_id TEXT,
      title TEXT NOT NULL, frozen_target_json TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','running','unknown','cancel_requested','succeeded','failed','cancelled')),
      revision INTEGER NOT NULL DEFAULT 1, created_seq INTEGER NOT NULL, issue_json TEXT,
      lease_owner TEXT, execution_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, created_seq)
    )`,
    `INSERT INTO production_runs_v19(id, owner_id, conversation_id, work_id, snapshot_id, proposal_id, source_request_id, title, frozen_target_json, state, revision, created_seq, issue_json, lease_owner, execution_epoch, lease_until, created_at, updated_at)
      SELECT id, owner_id, conversation_id, work_id, snapshot_id, proposal_id, NULL, title, NULL, state, revision, created_seq, issue_json, lease_owner, execution_epoch, lease_until, created_at, updated_at FROM production_runs`,
    `DROP INDEX work_in_flight`,
    `DROP TABLE production_runs`,
    `ALTER TABLE production_runs_v19 RENAME TO production_runs`,
    `CREATE UNIQUE INDEX work_in_flight ON production_runs(work_id) WHERE state IN ('queued','running','unknown','cancel_requested')`,
    `CREATE INDEX production_runs_source_request ON production_runs(source_request_id)`,
    // 产物类型增加 project：冻结工程修订（publish_project 封存源码/时间线）。重建 CHECK 保留全部旧行。
    `CREATE TABLE artifacts_v19(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('prompt','script','analysis','video','image','audio','project')),
      work_id TEXT,
      head_revision_id TEXT,
      head_revision_number INTEGER NOT NULL DEFAULT 0,
      created_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO artifacts_v19 SELECT * FROM artifacts`,
    `DROP TABLE artifacts`,
    `ALTER TABLE artifacts_v19 RENAME TO artifacts`,
    `CREATE UNIQUE INDEX artifacts_conversation_seq ON artifacts(conversation_id, created_seq)`,
  ], data: db => {
    // 旧固定三阶段状态一次性映射为历史审阅组；未到达且无事实的阶段不建组，不补造认可。
    const legacyStages = [
      { id: "content", title: "内容", role: "content" },
      { id: "plan", title: "方案", role: "plan" },
      { id: "video", title: "成片", role: "video" },
    ] as const;
    const rows = db.prepare("SELECT id, creation_state_json FROM works WHERE creation_state_json IS NOT NULL").all() as { id: string; creation_state_json: string }[];
    const update = db.prepare("UPDATE works SET creation_state_json = ? WHERE id = ?");
    for (const row of rows) {
      let legacy: unknown;
      try { legacy = JSON.parse(row.creation_state_json); } catch { update.run(JSON.stringify({ groups: [] }), row.id); continue; }
      const state = legacy as { stage?: unknown; groups?: unknown; [key: string]: unknown };
      if (Array.isArray(state.groups)) continue; // 已是新形状
      if (typeof state.stage !== "string") { update.run(JSON.stringify({ groups: [] }), row.id); continue; }
      const reached = Math.max(legacyStages.findIndex(stage => stage.id === state.stage), 0);
      const groups = legacyStages.map((def, index) => {
        const stage = (state[def.id] ?? {}) as Record<string, unknown>;
        const hasFacts = stage.draft ?? stage.approved ?? stage.confirmationId ?? null;
        if (index > reached && !hasFacts) return null;
        return {
          id: def.id, title: def.title, revision: 1, nextIntent: null,
          items: [{
            id: def.id, label: def.title, role: def.role, required: true,
            draft: stage.draft ?? null, approved: stage.approved ?? null,
            confirmationId: stage.confirmationId ?? null, approvedAt: stage.approvedAt ?? null,
          }],
        };
      }).filter((group): group is NonNullable<typeof group> => group !== null);
      update.run(JSON.stringify({ groups }), row.id);
    }
  } },
  { version: 20, foreignKeys: "off", statements: [
    // §11.7 来源5/6：产物类型增加 file（作品库二进制/未知类型文件卡，不再冒称 script）；
    // library_input_preparations 记录每个 work 已按来源身份准备过的输入，保证幂等、不覆盖用户已编辑文件。
    `CREATE TABLE artifacts_v20(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('prompt','script','analysis','video','image','audio','project','file')),
      work_id TEXT,
      head_revision_id TEXT,
      head_revision_number INTEGER NOT NULL DEFAULT 0,
      created_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO artifacts_v20 SELECT * FROM artifacts`,
    `DROP TABLE artifacts`,
    `ALTER TABLE artifacts_v20 RENAME TO artifacts`,
    `CREATE UNIQUE INDEX artifacts_conversation_seq ON artifacts(conversation_id, created_seq)`,
    `CREATE TABLE library_input_preparations(
      work_id TEXT NOT NULL REFERENCES works(id),
      source_key TEXT NOT NULL,
      path TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      PRIMARY KEY(work_id, source_key)
    )`,
  ] },
  { version: 21, statements: [
    // G3-2 免费配音：free_service_settings 增加 edge-tts 行（enabled/voice/pythonCommand 存 config_json）。
    `CREATE TABLE free_service_settings_v21(
      service_id TEXT PRIMARY KEY CHECK (service_id IN ('pexels','pixabay','unsplash','coverr','wikimedia','nasa','met','cleveland','archive','freetouse','incompetech','douyin-music','tiktok-sounds','newsnow','edge-tts')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      api_key TEXT,
      updated_at TEXT NOT NULL
    )`,
    `INSERT INTO free_service_settings_v21 SELECT service_id,revision,config_json,api_key,updated_at FROM free_service_settings`,
    `DROP TABLE free_service_settings`,
    `ALTER TABLE free_service_settings_v21 RENAME TO free_service_settings`,
  ] },
  // C2：消息可选携带其指向的视频创作与审阅组（reviewContext）；历史行为 NULL。
  { version: 22, statements: ["ALTER TABLE messages ADD COLUMN review_context_json TEXT"] },
  { version: 23, statements: [
    `ALTER TABLE messages ADD COLUMN review_confirmation_json TEXT`,
    // 沿用同一张认可事实表；旧行按原顺序逐列保留，独立稿不伪造作品或事项。
    `CREATE TABLE work_review_confirmations_v23(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      subject_scope TEXT NOT NULL DEFAULT 'work_item' CHECK(subject_scope IN ('work_item','standalone_artifact')),
      work_id TEXT REFERENCES works(id),
      group_id TEXT,
      item_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('approve','approve_and_continue','finalize_video')),
      subject_json TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('user_message','pi_tool')),
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK((subject_scope = 'work_item' AND work_id IS NOT NULL AND group_id IS NOT NULL AND item_id IS NOT NULL)
        OR (subject_scope = 'standalone_artifact' AND work_id IS NULL AND group_id IS NULL AND item_id IS NULL
          AND action = 'approve' AND json_extract(subject_json, '$.kind') IS 'artifact_revision'))
    )`,
    `INSERT INTO work_review_confirmations_v23(id,owner_id,conversation_id,subject_scope,work_id,group_id,item_id,action,subject_json,source_kind,source_id,created_at)
      SELECT id,owner_id,conversation_id,'work_item',work_id,group_id,item_id,action,subject_json,source_kind,source_id,created_at
      FROM work_review_confirmations ORDER BY rowid`,
    `DROP TABLE work_review_confirmations`,
    `ALTER TABLE work_review_confirmations_v23 RENAME TO work_review_confirmations`,
    `CREATE INDEX work_review_confirmations_item ON work_review_confirmations(work_id, item_id, created_at)`,
    `CREATE INDEX work_review_confirmations_owner_action ON work_review_confirmations(owner_id, action)`,
  ] },
  { version: 24, statements: [
    "ALTER TABLE production_operations ADD COLUMN output_revision_id TEXT REFERENCES artifact_revisions(id)",
  ], data: db => {
    const outputs = db.prepare(`SELECT o.run_id,o.id,o.spec_json,r.owner_id,r.conversation_id,r.work_id,r.frozen_target_json,s.spec_json AS snapshot_json
      FROM production_operations o JOIN production_runs r ON r.id=o.run_id
      JOIN production_snapshots s ON s.id=r.snapshot_id WHERE o.output_blob_id IS NOT NULL`).all() as {
        run_id: string; id: string; spec_json: string; owner_id: string; conversation_id: string; work_id: string;
        frozen_target_json: string | null; snapshot_json: string;
      }[];
    const candidates = db.prepare(`SELECT a.id FROM artifact_revisions a JOIN artifacts h ON h.id=a.artifact_id
      JOIN revision_blob_links l ON l.revision_id=a.id JOIN production_operations o ON o.run_id=a.run_id AND o.output_blob_id=l.blob_id
      WHERE o.run_id=? AND o.id=? AND h.owner_id=? AND h.conversation_id=?
        AND json_extract(a.content_json,'$.format')='media'
        AND (? IS NULL OR (json_extract(a.creation_binding_json,'$.workId')=?
          AND json_extract(a.creation_binding_json,'$.groupId')=? AND json_extract(a.creation_binding_json,'$.itemId')=?))`);
    const update = db.prepare("UPDATE production_operations SET output_revision_id=? WHERE run_id=? AND id=?");
    for (const output of outputs) {
      const operation = JSON.parse(output.spec_json) as { target?: { groupId: string; itemId: string }; outputSlot: string };
      const snapshot = JSON.parse(output.snapshot_json) as { finalOutput: { operationId: string; outputSlot: string } };
      const target = operation.target ?? (snapshot.finalOutput.operationId === output.id && snapshot.finalOutput.outputSlot === operation.outputSlot
        && output.frozen_target_json ? JSON.parse(output.frozen_target_json) as { groupId: string; itemId: string } : null);
      const matches = candidates.all(output.run_id, output.id, output.owner_id, output.conversation_id,
        target?.groupId ?? null, output.work_id, target?.groupId ?? null, target?.itemId ?? null) as { id: string }[];
      // 只补同一运行和媒体、冻结目标下唯一可证的修订；同字节多产出且没有目标的旧记录保留空。
      if (matches.length === 1) update.run(matches[0]!.id, output.run_id, output.id);
    }
  } },
  { version: 25, statements: [
    "ALTER TABLE messages ADD COLUMN execution_json TEXT",
  ] },
  { version: 26, statements: [
    // 审计第二阶段：确认表按 subject_json 内嵌 revisionId/artifactId 的等值关联此前
    // 只能全表逐行 json_extract（listLibrary 的关联子查询为 O(N²)，独立稿审批为每次
    // 读取全表扫描）。表达式索引让这些查找走 B 树；查询中的表达式须与索引一致。
    `CREATE INDEX work_review_confirmations_revision ON work_review_confirmations(json_extract(subject_json, '$.revisionId'))`,
    `CREATE INDEX work_stage_confirmations_revision ON work_stage_confirmations(json_extract(subject_json, '$.revisionId'))`,
    `CREATE INDEX work_review_confirmations_standalone_artifact ON work_review_confirmations(json_extract(subject_json, '$.artifactId')) WHERE subject_scope = 'standalone_artifact' AND action = 'approve'`,
  ] },
  { version: 27, statements: [
    "CREATE INDEX idx_production_blobs_scope_digest ON production_blobs(owner_id, conversation_id, digest)",
    "CREATE INDEX idx_production_blobs_digest ON production_blobs(digest)",
    "CREATE INDEX idx_tool_invocations_request ON tool_invocations(request_id)",
    "CREATE INDEX idx_material_search_batches_request ON material_search_batches(request_id)",
    "CREATE INDEX idx_artifact_revisions_run ON artifact_revisions(run_id) WHERE run_id IS NOT NULL",
    "ALTER TABLE conversations ADD COLUMN causal_seq INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN legacy_message_seq INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN causal_seq INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE artifact_revisions ADD COLUMN created_seq INTEGER NOT NULL DEFAULT 0",
    // 消息原有 created_seq 是公开分页位置。独立的会话时钟只用于比较消息与修订。
    `UPDATE conversations SET
      causal_seq = COALESCE((SELECT MAX(seq) FROM events WHERE conversation_id = conversations.id), 0),
      legacy_message_seq = COALESCE((SELECT MAX(created_seq) FROM messages WHERE conversation_id = conversations.id), 0)`,
    `WITH first_delivery AS MATERIALIZED (
      SELECT owner_id, conversation_id, entity_id, entity_version, MIN(seq) AS seq FROM events
      WHERE kind = 'artifact.delivered' GROUP BY owner_id, conversation_id, entity_id, entity_version)
      UPDATE artifact_revisions AS r SET created_seq = e.seq
      FROM first_delivery e JOIN artifacts a ON a.id = e.entity_id AND a.owner_id = e.owner_id AND a.conversation_id = e.conversation_id
      WHERE r.artifact_id = a.id AND r.revision_number = e.entity_version`,
    `WITH first_message AS MATERIALIZED (
      SELECT owner_id, conversation_id, entity_id, MIN(seq) AS seq FROM events
      WHERE kind = 'message.changed' AND entity_version = 1 GROUP BY owner_id, conversation_id, entity_id)
      UPDATE messages AS m SET causal_seq = e.seq FROM first_message e
      WHERE m.id = e.entity_id AND m.owner_id = e.owner_id AND m.conversation_id = e.conversation_id`,
    // 所有入口（含制作 Worker 的直接 INSERT）在同一写事务内取序。修改消息、再次广播均不重新取序。
    `CREATE TRIGGER assign_message_causal_seq AFTER INSERT ON messages BEGIN
      UPDATE conversations SET causal_seq = causal_seq + 1 WHERE id = NEW.conversation_id;
      UPDATE messages SET causal_seq = (SELECT causal_seq FROM conversations WHERE id = NEW.conversation_id) WHERE id = NEW.id;
    END`,
    `CREATE TRIGGER assign_revision_created_seq AFTER INSERT ON artifact_revisions BEGIN
      UPDATE conversations SET causal_seq = causal_seq + 1 WHERE id = (SELECT conversation_id FROM artifacts WHERE id = NEW.artifact_id);
      UPDATE artifact_revisions SET created_seq = (SELECT c.causal_seq FROM conversations c
        JOIN artifacts a ON a.conversation_id = c.id WHERE a.id = NEW.artifact_id) WHERE id = NEW.id;
    END`,
  ] },
  { version: 28, statements: [
    `ALTER TABLE artifact_revisions ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'delivered'
      CHECK(origin_kind IN ('delivered','library_import','tool_auxiliary','production_output'))`,
    "UPDATE artifact_revisions SET origin_kind='production_output' WHERE run_id IS NOT NULL",
    `UPDATE artifact_revisions SET origin_kind='tool_auxiliary' WHERE request_id IS NOT NULL AND run_id IS NULL
      AND (json_extract(content_json,'$.format')='project' OR json_type(content_json,'$.dub')='object')`,
    // 显式交付可复用配音或封存内容，须按回执中的修订身份区分同字节的独立修订。
    `UPDATE artifact_revisions SET origin_kind='delivered' WHERE (request_id,id,artifact_id) IN
      (SELECT d.request_id,json_extract(ref.value,'$.revisionId'),json_extract(ref.value,'$.artifactId')
       FROM request_deliveries d,json_each(d.receipt_json,'$.revisions') ref)`,
    `UPDATE artifact_revisions SET origin_kind='library_import' WHERE (request_id,id,artifact_id) IN
      (SELECT m.request_id,json_extract(ref.value,'$.revisionId'),json_extract(ref.value,'$.artifactId')
       FROM messages m,json_each(m.references_json,'$.artifacts') ref
       WHERE m.role='user' AND m.library_selections_json IS NOT NULL)`,
    `WITH removed AS MATERIALIZED (
       SELECT m.id,ref.key FROM messages m,json_each(m.references_json,'$.artifacts') ref
       JOIN artifact_revisions r ON r.id=json_extract(ref.value,'$.revisionId')
       WHERE m.role='assistant' AND r.request_id=m.request_id AND r.artifact_id=json_extract(ref.value,'$.artifactId')
         AND r.origin_kind IN ('library_import','tool_auxiliary')
     ) UPDATE messages AS m SET revision=revision+1, references_json=json_set(references_json,'$.artifacts',
       (SELECT json_group_array(json(ref.value) ORDER BY ref.key) FROM json_each(m.references_json,'$.artifacts') ref
        WHERE NOT EXISTS (SELECT 1 FROM removed WHERE removed.id=m.id AND removed.key=ref.key)))
       WHERE id IN (SELECT id FROM removed)`,
  ] },
  { version: 29, statements: [
    "ALTER TABLE production_blobs ADD COLUMN purged_at TEXT",
    "CREATE INDEX production_blobs_live_digest ON production_blobs(digest) WHERE purged_at IS NULL",
    "CREATE INDEX production_blobs_live_owner_age ON production_blobs(owner_id,created_at) WHERE purged_at IS NULL",
    "CREATE TABLE storage_cleanups(owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0))",
    `CREATE TABLE credential_encryption_state(id INTEGER PRIMARY KEY CHECK(id=1),
      verifier TEXT NOT NULL, needs_scrub INTEGER NOT NULL CHECK(needs_scrub IN (0,1)))`,
  ] },
  { version: 30, statements: [
    // 第一版绑定只授权 Responses。历史中已经退役的其它协议不会在升级时重新启用。
    "ALTER TABLE text_model_versions ADD COLUMN binding_format INTEGER NOT NULL DEFAULT 1 CHECK(binding_format IN (1,2))",
  ] },
  { version: 31, statements: [
    "ALTER TABLE artifact_revisions RENAME COLUMN origin_kind TO origin_before_upload",
    `ALTER TABLE artifact_revisions ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'delivered'
      CHECK(origin_kind IN ('delivered','library_import','tool_auxiliary','production_output','user_upload'))`,
    "UPDATE artifact_revisions SET origin_kind=origin_before_upload",
    "ALTER TABLE artifact_revisions DROP COLUMN origin_before_upload",
    "ALTER TABLE messages ADD COLUMN uploads_json TEXT",
  ] },
  { version: 32, statements: [
    "ALTER TABLE production_runs ADD COLUMN remix_of_run_id TEXT REFERENCES production_runs(id)",
  ] },
  { version: 33, statements: [
    "CREATE TABLE studio_users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','creator')), password_hash TEXT NOT NULL)",
    "CREATE TABLE budget_policies(scope TEXT NOT NULL CHECK(scope IN ('user','workspace')),subject_id TEXT NOT NULL,revision INTEGER NOT NULL,conversation_limit INTEGER CHECK(conversation_limit>=0),day_limit INTEGER CHECK(day_limit>=0),month_limit INTEGER CHECK(month_limit>=0),PRIMARY KEY(scope,subject_id))",
    "ALTER TABLE production_attempts ADD COLUMN usage_json TEXT",
    "CREATE TABLE pending_reconciliation(attempt_id TEXT PRIMARY KEY REFERENCES production_attempts(id),due_at TEXT NOT NULL)",
    "CREATE INDEX production_attempts_provider_task ON production_attempts(provider_task_id) WHERE provider_task_id IS NOT NULL",
    "CREATE INDEX pending_reconciliation_due ON pending_reconciliation(due_at,attempt_id)",
    "CREATE INDEX production_runs_budget_owner ON production_runs(owner_id,created_at) WHERE proposal_id IS NOT NULL",
    "INSERT INTO pending_reconciliation(attempt_id,due_at) SELECT a.id,r.updated_at FROM production_attempts a JOIN production_runs r ON r.id=a.run_id JOIN production_operations o ON o.run_id=a.run_id AND o.id=a.operation_id WHERE r.proposal_id IS NOT NULL AND a.phase<>'prepared' AND (a.billing_final=0 OR a.billing_conflict=1) AND a.state IN ('succeeded','failed','cancelled','unknown') AND json_extract(o.spec_json,'$.kind')<>'render'",
  ] },
  { version: 34, statements: [
    "ALTER TABLE studio_users ADD COLUMN disabled_at TEXT",
    "ALTER TABLE studio_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK(session_version>=0)",
    "CREATE TABLE studio_account_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0))",
    "INSERT INTO studio_account_settings SELECT 1,CASE WHEN count(*)=0 THEN 0 ELSE count(*)+1 END FROM studio_users",
    // v33 的创建回执按 rowid 排序，末项是当次创建的账号。保留原密码的加盐校验值以支持重放。
    `UPDATE command_receipts SET receipt_json=json_object(
      'result',json_set(receipt_json,'$.accounts',(
        SELECT json_group_array(json_set(member.value,'$.disabledAt',NULL) ORDER BY member.key)
        FROM json_each(command_receipts.receipt_json,'$.accounts') member)),
      'passwordVerifier',(SELECT password_hash FROM studio_users
        WHERE id=json_extract(command_receipts.receipt_json,'$.accounts[#-1].id')))
      WHERE operation='createStudioAccount'`,
  ] },
];

export function openAgentDatabase(dataDir: string): AgentDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, "agent.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("secure_delete = ON");
  let opened = false;
  try {
    migrate(db);
    configureCredentialCipher(db, process.env.FRAME_CREDENTIAL_SECRET);
    opened = true;
    return db;
  } finally { if (!opened) db.close(); }
}

// 版本化 DDL：可重复执行；已应用版本跳过，重复迁移不毁数据。
function migrate(db: AgentDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_schema_migrations(
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM agent_schema_migrations").all() as { version: number }[]).map(row => row.version),
  );
  const insert = db.prepare("INSERT INTO agent_schema_migrations(version, applied_at) VALUES (?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    // PRAGMA foreign_keys 在事务内是 no-op，父表重建迁移必须在开事务前关闭。
    if (migration.foreignKeys === "off") db.pragma("foreign_keys = OFF");
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      migration.data?.(db);
      insert.run(migration.version, new Date().toISOString());
    });
    try {
      run();
    } finally {
      if (migration.foreignKeys === "off") db.pragma("foreign_keys = ON");
    }
  }
}
