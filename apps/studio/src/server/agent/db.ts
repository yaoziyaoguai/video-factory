import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// A 增量业务库：一个 SQLite 连接责任边界。WAL + FULL + 外键 + busy_timeout，
// 短事务；模型与网络调用一律在事务外。库不可用时直接抛错，不回退内存/JSON。
export type AgentDatabase = Database.Database;

// 版本化 DDL：可重复执行；已应用版本跳过，重复迁移不毁数据。
// MIGRATIONS 同时是测试 fixture 的事实来源（按历史版本截取构建 C1 形状库），不另建第二份 SQL。
export const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
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
];

export function openAgentDatabase(dataDir: string): AgentDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, "agent.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
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
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      insert.run(migration.version, new Date().toISOString());
    });
    run();
  }
}
