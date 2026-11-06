import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, test } from "node:test";
import { MIGRATIONS, openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { initializeTextModelSettings, defaultTextBindingOf, readTextModelView, resolveTextBinding, textRegistrationOf } from "../src/server/agent/text-model-settings.js";
import { initializeArkVideoSettings, readArkVideoCurrent, readLegacyArkConfig, resolveArkBinding } from "../src/server/agent/ark-video-settings.js";
import { additionalMediaCatalog, additionalMediaModelViews, readAdditionalMediaCurrent, resolveAdditionalMediaBinding, resolveMinimaxSpeechBinding } from "../src/server/agent/additional-media-settings.js";
import { connectedMediaEnabled, connectedSpeechChoices, connectedTextModels, initializeProviderConnections, listAvailableProviderModels, readProviderConnections, saveProviderConnection } from "../src/server/agent/provider-connections.js";
import { DEFAULT_ARK_VIDEO_PROFILE, MINIMAX_SPEECH_VOICE } from "../src/server/agent/media-config.js";
import { applyPrepareProposal } from "../src/server/agent/artifact-store.js";
import { ProductionService } from "../src/server/agent/production-service.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { EventHub } from "../src/server/agent/event-log.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { canonicalJson, digestOf } from "../src/server/agent/util.js";
import type { ConnectionModel, ProductionIntent, ProviderConnection } from "../src/shared/agent/generated/contracts.js";

// 阶段一（OpenAI 收敛）的连接边界验收：单一 OpenAI 连接（O15）、保存边界单次校验、
// 文本投影冻结、目录同步分类与 v11 存量收敛（B3）；M1 媒体后续包（§11.2）的
// 用途矩阵、跨供应商唯一当前、v13 迁移与本地已适配目录。

const clock = () => "2026-10-28T06:00:00.000Z";
let dir: string, db: AgentDatabase;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "frame-connections-"));
  db = openAgentDatabase(dir);
  initializeTextModelSettings(db, clock);
  initializeArkVideoSettings(db, { clock });
  initializeProviderConnections(db, []);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const text = (id: string, overrides: Partial<ConnectionModel> = {}): ConnectionModel => ({
  id, kind: "text", name: id, modelId: "gpt-6.1-sol", features: ["工具调用"],
  contextWindowTokens: 272_000, maxOutputTokens: 16_384, enabled: true, isDefault: false, ...overrides,
});
const openai = (models: ConnectionModel[]): ProviderConnection => ({
  id: "provider-openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-synthetic-old", enabled: true, models,
});
const arkVideo = (): ProviderConnection => {
  return { id: "provider-ark", name: "火山方舟", protocol: "ark", baseUrl: DEFAULT_ARK_VIDEO_PROFILE.baseUrl,
    apiKey: "synthetic-ark-video", enabled: true, models: [mediaModel("ark-video", "video", DEFAULT_ARK_VIDEO_PROFILE.modelId, true)] };
};
function save(value: ProviderConnection, commandId = crypto.randomUUID()) {
  return saveProviderConnection(db, clock, "owner", { commandId, expectedRevision: readProviderConnections(db).revision, connection: value });
}
const mediaModel = (id: string, kind: "image" | "speech" | "video", modelId: string, isDefault = false): ConnectionModel => ({
  id, kind, name: id, modelId, features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault,
});
const minimaxConnection = (overrides: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: "provider-minimax", name: "MiniMax", protocol: "minimax", baseUrl: "https://api.minimax.io",
  apiKey: "synthetic-minimax", enabled: true,
  models: [mediaModel("mm-speech", "speech", "speech-2.8-turbo", true), mediaModel("mm-video", "video", "MiniMax-H3", true)],
  ...overrides,
});
const wanConnection = (overrides: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: "provider-wan", name: "万相", protocol: "wan", baseUrl: "https://ws-demo.cn-beijing.maas.aliyuncs.com",
  apiKey: "synthetic-wan", enabled: true,
  models: [mediaModel("wan-video", "video", "wan3.0-video", true)],
  ...overrides,
});

test("O15 单一 OpenAI 连接：第二入口、OpenAI 视频与非 OpenAI 文本都在保存边界拒绝", () => {
  save(openai([{ ...text("sol"), isDefault: true }]));
  // 换 Key 是编辑该连接，不是第二个 OpenAI 连接。
  assert.throws(() => save({ ...openai([{ ...text("sol-2"), isDefault: true }]), id: "provider-openai-b", name: "另一个 OpenAI" }), /已存在 OpenAI 连接/);
  // OpenAI 连接不承载视频（Sora 已停用，视频保留原供应商）。
  assert.throws(() => save(openai([{ ...text("sol"), isDefault: true }, { ...text("sora"), kind: "video", contextWindowTokens: null, maxOutputTokens: null }])), /OpenAI 连接不承载视频/);
  // 连接保存时按当前的供应商与用途矩阵验收。
  assert.throws(() => save({ ...openai([{ ...text("gw"), isDefault: true }]), protocol: "openai-chat-completions", baseUrl: "https://gateway.example.test/v1" }), /不能配置在此视频连接/);
  // 视频仍走原供应商连接（Ark），与 OpenAI 连接并存。
  save(arkVideo());
  const view = readProviderConnections(db);
  assert.equal(view.connections.filter(item => item.protocol === "openai").length, 1);
  assert.equal(view.connections.filter(item => item.protocol === "ark").length, 1);
});

test("文本投影：同 Key 多型号、默认切换、改 Key 冻结旧版本；停用清默认且重启不自动选择", () => {
  const config = openai([{ ...text("sol"), isDefault: true }, text("luna", { modelId: "gpt-6-luna" })]);
  save(config);
  const original = defaultTextBindingOf(db)!;
  assert.equal(connectedTextModels(db).length, 2);
  assert.equal(textRegistrationOf(db, original)!.apiKey, "sk-synthetic-old");

  config.models = config.models.map(model => ({ ...model, isDefault: model.id === "luna" }));
  save(config);
  assert.equal(defaultTextBindingOf(db)!.modelId, "gpt-6-luna");

  const before = connectedTextModels(db).map(item => item.binding);
  config.apiKey = "sk-synthetic-new"; save(config);
  for (const binding of before) assert.equal(resolveTextBinding(db, binding)!.apiKey, "sk-synthetic-old", "旧绑定按原版本解析原 Key");
  for (const entry of connectedTextModels(db)) assert.equal(resolveTextBinding(db, entry.binding)!.apiKey, "sk-synthetic-new");
  assert.equal(resolveTextBinding(db, original)!.apiKey, "sk-synthetic-old");

  save({ ...config, enabled: false });
  assert.equal(defaultTextBindingOf(db), null, "停用连接清默认");
  assert.equal(connectedTextModels(db).length, 0, "停用连接不进新调用目录");
  assert.equal(resolveTextBinding(db, original)!.apiKey, "sk-synthetic-old", "历史版本仍可解析");
  const stored = readProviderConnections(db).connections.find(item => item.id === config.id)!;
  save({ ...stored, enabled: true });
  assert.equal(defaultTextBindingOf(db), null, "重新启用不自动替用户选择默认");
  assert.equal(connectedTextModels(db).length, 2);
});

test("A2/R03 保存边界单次校验：输出上限、推理档位、未知身份与非文本档位", () => {
  const withSol = (model: ConnectionModel) => { save(openai([model])); return readProviderConnections(db); };
  assert.throws(() => withSol(text("too-big", { maxOutputTokens: 200_000, isDefault: true })), /超过该型号上限/);
  assert.throws(() => withSol(text("cap-eq", { contextWindowTokens: 16_384, maxOutputTokens: 16_384, isDefault: true })), /小于上下文窗口/);
  // Sol 无 off：显式不支持档位在保存时拒绝，不静默夹取。
  assert.throws(() => withSol(text("sol-off", { thinkingLevel: "off", isDefault: true })), /不支持“off”推理档位/);
  // 未知身份只接受默认档位。
  assert.throws(() => withSol(text("custom", { modelId: "custom-model", thinkingLevel: "medium", isDefault: true })), /只能选择默认/);
  // Luna 有 off；未知型号无上下文/输出时给“请填写”，不冒充可执行。
  save(openai([text("luna-off", { modelId: "gpt-6-luna", thinkingLevel: "off", isDefault: true }), text("custom-bare", { modelId: "custom-model", contextWindowTokens: null, maxOutputTokens: null })]));
  assert.equal(textRegistrationOf(db, defaultTextBindingOf(db)!)!.thinkingLevel, "off");
  const view = readProviderConnections(db);
  assert.equal(view.modelStatuses.find(item => item.modelEntryId === "custom-bare")!.unavailableReason, "此型号在当前 Pi 目录中没有精确能力，暂不支持");
  assert.equal(view.modelStatuses.find(item => item.modelEntryId === "luna-off")!.unavailableReason, null);
  // 非文本型号不能带具体档位。
  assert.throws(() => save(openai([{ ...text("img"), kind: "image", modelId: "gpt-image-2.5-flare", contextWindowTokens: null, maxOutputTokens: null, thinkingLevel: "medium", isDefault: true }])), /不是文本型号/);
});

test("媒体状态分类：图片/配音按冻结型号集合接通；thinking 只读投影只对 OpenAI 文本给值", () => {
  save(openai([
    { ...text("sol"), isDefault: true },
    { ...text("flare"), kind: "image", modelId: "gpt-image-2.5-flare", contextWindowTokens: null, maxOutputTokens: null },
    { ...text("marin"), kind: "speech", modelId: "gpt-realtime-2.1-mini", contextWindowTokens: null, maxOutputTokens: null },
  ]));
  const reason = (id: string) => readProviderConnections(db).modelStatuses.find(item => item.modelEntryId === id)!.unavailableReason;
  // B1 冻结型号集合内的图片/配音型号在统一连接上有 Key 即可执行（阶段二端口已装配）。
  assert.equal(reason("flare"), null);
  assert.equal(reason("marin"), null);
  const thinking = (id: string) => readProviderConnections(db).modelStatuses.find(item => item.modelEntryId === id)!.thinking;
  assert.deepEqual(thinking("sol")?.levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(thinking("flare"), null, "非文本不解释推理能力");
  // 集合外新型号只登记为备选，不冒充可执行。
  save(openai([{ ...text("flare"), kind: "image", modelId: "gpt-image-3-proto", contextWindowTokens: null, maxOutputTokens: null }]));
  assert.equal(reason("flare"), "已登记；此图片型号的媒体执行参数与报价尚未接入");
  save(arkVideo());
  const arkTextStatus = readProviderConnections(db).connections.find(item => item.protocol === "ark")!;
  assert.equal(arkTextStatus.models.every(model => model.kind === "video"), true);
});

test("启动播种只保留视频：Ark 视频成连接，文本/图片/配音导入条目不复活（B3）", () => {
  const seedDir = mkdtempSync(path.join(tmpdir(), "frame-seed-"));
  try {
    const seed = openAgentDatabase(seedDir);
    initializeTextModelSettings(seed, clock);
    initializeArkVideoSettings(seed, { clock, legacy: undefined });
    initializeProviderConnections(seed, [
      { id: "old-text", name: "旧文本", kind: "text", endpoint: "https://api.deepseek.com", modelId: "deepseek-v4-pro", apiKey: "synthetic-old-text-key", details: [] },
      { id: "old-image", name: "旧图片", kind: "image", endpoint: "https://ark.cn-beijing.volces.com/api/v3", modelId: "doubao-seedream", apiKey: "synthetic-old-image-key", details: [] },
      { id: "old-video", name: "旧视频", kind: "video", endpoint: "https://ark.cn-beijing.volces.com/api/v3", modelId: "doubao-seedance-1-pro", apiKey: "synthetic-old-video-key", details: ["旧导入"] },
      { id: "local-video", name: "本地", kind: "video", endpoint: "http://localhost:9000", modelId: "wan-video", apiKey: "synthetic-local", details: [] },
    ]);
    const view = readProviderConnections(seed);
    assert.ok(view.connections.every(connection => connection.apiKey), "不播种没有 Key 的视频备选");
    const kinds = view.connections.flatMap(connection => connection.models.map(model => model.kind));
    assert.deepEqual([...new Set(kinds)], ["video"]);
    assert.equal(view.connections.some(connection => connection.protocol === "openai"), false, "OpenAI 连接只能由用户显式创建");
    assert.equal(view.connections.some(connection => connection.models.some(model => model.modelId === "doubao-seedance-1-pro")), true, "合法视频导入保留");
    assert.equal(view.connections.some(connection => connection.models.some(model => model.modelId === "wan-video")), false, "本地地址不冒充可用连接");
    assert.equal(connectedTextModels(seed).length, 0, "旧文本导入不为新部署提供文本能力");
    // 重启幂等：再次初始化不覆盖、不复活。
    initializeProviderConnections(seed, [{ id: "old-text-2", name: "又一条旧文本", kind: "text", endpoint: "https://api.deepseek.com", modelId: "deepseek-flash", apiKey: "another", details: [] }]);
    assert.deepEqual(readProviderConnections(seed).connections, view.connections);
    assert.equal(validatorFor("ProviderConnectionSettings")(view).ok, true);
    seed.close();
  } finally { rmSync(seedDir, { recursive: true, force: true }); }
});

test("保存重试不重复执行、回执不保存 Key；旧 revision 与未知协议在入口拒绝", () => {
  const config = openai([{ ...text("sol"), isDefault: true }]);
  const body = { commandId: "same-command", expectedRevision: 0, connection: config };
  const first = saveProviderConnection(db, clock, "owner", body);
  assert.equal(saveProviderConnection(db, clock, "owner", body).receipt.replayed, true);
  assert.equal(readProviderConnections(db).revision, first.receipt.revision);
  assert.equal(JSON.stringify(db.prepare("SELECT receipt_json FROM command_receipts").all()).includes(config.apiKey!), false, "回执不保存 Key");
  assert.throws(() => saveProviderConnection(db, clock, "owner", { ...body, commandId: "new-command" }), /配置已更新/);
  assert.throws(() => saveProviderConnection(db, clock, "owner", { ...body, commandId: "bad-protocol", connection: { ...config, protocol: "guess" } }));
});

test("OpenAI 目录同步：文本/图片/配音分类、Sora 退役、未知型号不猜能力；凭据不进错误正文", async () => {
  const config = openai([{ ...text("sol"), isDefault: true }]);
  save(config);
  let calls = 0;
  const listing: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${config.apiKey}`);
    return Response.json({ data: [
      { id: "gpt-6.1-sol" },
      { id: "gpt-image-2.5-flare", display_name: "Flare" },
      { id: "gpt-realtime-2.1-mini" },
      { id: "sora-2" },
      { id: "totally-unknown-model" },
    ], has_more: true });
  };
  const result = await listAvailableProviderModels(db, config.id, listing);
  assert.equal(calls, 1);
  const byId = new Map(result.models.map(model => [model.id, model]));
  assert.deepEqual(byId.get("gpt-6.1-sol"), { id: "gpt-6.1-sol", name: "gpt-6.1-sol", kinds: ["text"], status: "listed", contextWindowTokens: 272_000, maxOutputTokens: 128_000 });
  assert.deepEqual(byId.get("gpt-image-2.5-flare")!.kinds, ["image"]);
  assert.deepEqual(byId.get("gpt-realtime-2.1-mini")!.kinds, ["speech"]);
  assert.deepEqual(byId.get("sora-2")!.kinds, []);
  assert.equal(byId.get("sora-2")!.status, "retired");
  assert.deepEqual(byId.get("totally-unknown-model")!.kinds, []);
  assert.equal(byId.get("totally-unknown-model")!.contextWindowTokens, null, "目录外型号不按前缀猜容量");
  assert.equal(result.hasMore, true);
  assert.equal(validatorFor("AvailableProviderModels")(result).ok, true);
  await assert.rejects(listAvailableProviderModels(db, config.id, async () => new Response(config.apiKey!, { status: 401 })), error => error instanceof Error && error.message.includes("401") && !error.message.includes("sk-synthetic-old"));
  await assert.rejects(listAvailableProviderModels(db, config.id, async () => Response.json({ result: [] })), /格式不受支持/);
});

test("非 OpenAI 目录只按视频分类：Seedance 命中、文本/向量不混入、lifecycle 退役", async () => {
  const ark = arkVideo();
  save(ark);
  const result = await listAvailableProviderModels(db, ark.id, async () => Response.json({ data: [
    { id: "doubao-seedance-1-pro", lifecycle: "retired" },
    { id: "ep-20260101/doubao-seedance-2-lite", output_modalities: ["video"] },
    { id: "doubao-embedding-large", output_modalities: ["embedding"] },
    { id: "doubao-seedream-5-0-flash-260915", output_modalities: ["image"] },
    { id: "minimax-hailuo-08b-t2v" },
    { id: "some-chat-model", task_type: ["Chat"] },
  ] }));
  const kinds = new Map(result.models.map(model => [model.id, model.kinds]));
  assert.deepEqual(kinds.get("doubao-seedance-1-pro"), ["video"]);
  assert.equal(result.models.find(model => model.id === "doubao-seedance-1-pro")!.status, "retired");
  assert.deepEqual(kinds.get("ep-20260101/doubao-seedance-2-lite"), ["video"]);
  assert.deepEqual(kinds.get("minimax-hailuo-08b-t2v"), ["video"]);
  assert.deepEqual(kinds.get("doubao-embedding-large"), []);
  assert.deepEqual(kinds.get("doubao-seedream-5-0-flash-260915"), ["image"]);
  assert.deepEqual(kinds.get("some-chat-model"), [], "非 OpenAI 连接不再输出文本分类");
});

test("视频冻结版本与启用状态沿用原语义：改 Key 生成未来版本，旧绑定解析原 Key", () => {
  save(arkVideo());
  const video = JSON.parse(readArkVideoCurrent(db)!.version.binding_json) as { providerId: string; modelId: string; connectionId: string; configurationRevisionId: string };
  assert.equal(connectedMediaEnabled(db, "video"), true);
  save({ ...arkVideo(), apiKey: "synthetic-ark-new" });
  assert.equal(resolveArkBinding(db, video)!.apiKey, "synthetic-ark-video");
  assert.equal(readArkVideoCurrent(db)!.version.api_key, "synthetic-ark-new");
  const stored = readProviderConnections(db).connections.find(item => item.protocol === "ark")!;
  save({ ...stored, enabled: false });
  assert.equal(connectedMediaEnabled(db, "video"), false);
});

// v11 存量收敛（B3）：真实 v1–v10 SQL 构建的旧形状库，一次迁移退役旧文本/图片/配音配置。
test("v11 迁移：旧通道退役、连接只留视频、退役协议不可执行、在途 Key 保留、重启不复活", () => {
  const legacyDir = mkdtempSync(path.join(tmpdir(), "frame-v11-"));
  try {
    const legacyPath = path.join(legacyDir, "agent.db");
    const legacy = new Database(legacyPath);
    legacy.pragma("journal_mode = WAL");
    legacy.pragma("synchronous = FULL");
    legacy.pragma("foreign_keys = ON");
    legacy.exec("CREATE TABLE IF NOT EXISTS agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter(item => item.version <= 10)) {
      legacy.transaction(() => {
        for (const statement of migration.statements) legacy.exec(statement);
        legacy.prepare("INSERT INTO agent_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, clock());
      })();
    }
    const now = clock();
    legacy.prepare(
      `INSERT INTO conversations(id,owner_id,title,revision,created_seq,epoch,pi_session_id,created_at,updated_at)
       VALUES('conv-v11','owner','旧会话',1,1,0,'s1',?,?)`,
    ).run(now, now);
    // 旧 OpenAI 兼容连接（文本两条）+ 混合 Ark 连接（视频 + 文本）。
    const oldTextModel = (id: string, modelId: string) => ({ id, kind: "text", name: id, modelId, features: [], contextWindowTokens: 32_000, maxOutputTokens: 4_096, enabled: true, isDefault: id === "old-glm" });
    legacy.prepare("INSERT INTO provider_connections(id,configuration_json) VALUES(?,?)").run("conn-gw", JSON.stringify({
      id: "conn-gw", name: "旧网关", protocol: "openai-chat-completions", baseUrl: "https://gateway.example.test/v1", apiKey: "old-gw-key", enabled: true,
      models: [oldTextModel("old-glm", "glm-5p3"), oldTextModel("old-second", "glm-5p3x")],
    }));
    legacy.prepare("INSERT INTO provider_connections(id,configuration_json) VALUES(?,?)").run("conn-ark", JSON.stringify({
      id: "conn-ark", name: "混合方舟", protocol: "ark", baseUrl: DEFAULT_ARK_VIDEO_PROFILE.baseUrl, apiKey: "old-ark-key", enabled: true,
      models: [{ id: "old-video", kind: "video", name: "视频", modelId: DEFAULT_ARK_VIDEO_PROFILE.modelId, features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: true }, oldTextModel("old-ark-text", "doubao-pro")],
    }));
    legacy.prepare("INSERT INTO provider_connections(id,configuration_json) VALUES(?,?)").run("conn-text-only", JSON.stringify({
      id: "conn-text-only", name: "只剩文本", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "old-anthropic-key", enabled: true,
      models: [oldTextModel("old-claude", "claude-haiku-4-5")],
    }));
    // 旧文本执行版本（退役协议）与条目/默认指针。
    const retiredBinding = (providerId: string, modelId: string) => ({ providerId, modelId, connectionId: providerId, configurationRevisionId: providerId });
    const retiredExecution = (modelId: string) => ({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", modelId, contextWindowTokens: 32_000, maxOutputTokens: 4_096, thinkingLevel: "medium" });
    for (const [providerId, modelId] of [["cfg-old-claude", "claude-haiku-4-5"], ["cfg-inflight", "claude-haiku-4-5"]] as const) {
      const binding = retiredBinding(providerId, modelId);
      legacy.prepare("INSERT INTO text_model_versions(configuration_revision_id,binding_json,configuration_json,api_key,created_at) VALUES(?,?,?,?,?)")
        .run(binding.configurationRevisionId, canonicalJson(binding), JSON.stringify(retiredExecution(modelId)), `old-key-${providerId}`, now);
    }
    legacy.prepare("INSERT INTO text_model_entries(id,name,features_json,current_configuration_revision_id,created_at) VALUES(?,?,?,?,?)")
      .run("old-claude", "Claude", "[]", "cfg-old-claude", now);
    legacy.prepare("INSERT INTO text_model_settings(id,revision,default_entry_id,updated_at) VALUES(1,3,'old-claude',?)").run(now);
    // 旧图片/配音通道当前行与版本。
    legacy.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('ark-image',2,'旧图片','cfg-old-image',?)").run(now);
    legacy.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('minimax-speech',2,'旧配音','cfg-old-speech',?)").run(now);
    const retiredMediaBinding = (providerId: string) => ({ providerId, modelId: `model-${providerId}`, connectionId: providerId, configurationRevisionId: providerId });
    for (const [revision, channel] of [["cfg-old-image", "ark-image"], ["cfg-old-speech", "minimax-speech"], ["cfg-old-image-inflight", "ark-image"]] as const) {
      const binding = retiredMediaBinding(revision);
      legacy.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?,?)")
        .run(revision, channel, canonicalJson(binding), JSON.stringify({ modelId: binding.modelId }), `old-key-${revision}`, now);
    }
    // 引用退役文本绑定的 ready 提案；以及引用退役图片绑定的在途制作。
    const specOf = (providerId: string) => JSON.stringify({ operations: [{ op: "render", model: retiredBinding(providerId, "claude-haiku-4-5") }] });
    legacy.prepare(`INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,accepted_run_id,revision,created_seq,created_at,updated_at)
      VALUES('prop-stale','conv-v11','owner','d1',?,'ready','{}','2030-01-01T00:00:00.000Z',NULL,1,1,?,?)`).run(specOf("cfg-old-claude"), now, now);
    legacy.prepare(`INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,accepted_run_id,revision,created_seq,created_at,updated_at)
      VALUES('prop-inflight','conv-v11','owner','d2',?,'accepted','{}','2030-01-01T00:00:00.000Z',NULL,1,2,?,?)`).run(JSON.stringify({ operations: [{ op: "render", model: retiredMediaBinding("cfg-old-image-inflight") }] }), now, now);
    legacy.prepare("INSERT INTO works(id,owner_id,conversation_id,title,creation_state_json,revision,created_at,updated_at) VALUES('work-v11','owner','conv-v11','',NULL,1,?,?)").run(now, now);
    legacy.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('snap-v11','{}','d3',?)").run(now);
    legacy.prepare(`INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,revision,created_seq,created_at,updated_at)
      VALUES('run-v11','owner','conv-v11','work-v11','snap-v11','prop-inflight','在途','queued',1,1,?,?)`).run(now, now);
    legacy.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES('run-v11','op-1',?)")
      .run(JSON.stringify({ operations: [{ op: "render", model: retiredMediaBinding("cfg-old-image-inflight") }] }));
    legacy.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES('run-v11','op-2',?)")
      .run(JSON.stringify({ operations: [{ op: "render", model: retiredBinding("cfg-inflight", "claude-haiku-4-5") }] }));
    legacy.close();

    // 打开当前 migrations：v11 在旧形状库上执行收敛。
    const migrated = openAgentDatabase(legacyDir);
    try {
      const connections = JSON.parse(JSON.stringify((migrated.prepare("SELECT id,configuration_json FROM provider_connections ORDER BY id").all() as { id: string; configuration_json: string }[]).map(row => ({ id: row.id, ...JSON.parse(row.configuration_json) }))));
      // 退役全部非视频型号；型号清空的连接整行删除；混合连接只留视频。
      assert.deepEqual(connections.map((item: { id: string }) => item.id), ["conn-ark"]);
      assert.deepEqual(connections[0].models.map((model: ConnectionModel) => model.kind), ["video"]);
      assert.equal(connections[0].models[0]!.modelId, DEFAULT_ARK_VIDEO_PROFILE.modelId);
      // 旧文本条目退役，默认指针清空。
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM text_model_entries").pluck().get() as number, 0);
      assert.equal((migrated.prepare("SELECT default_entry_id FROM text_model_settings WHERE id=1").get() as { default_entry_id: string | null }).default_entry_id, null);
      // 旧媒体当前行退役（新通道尚无当前行）；版本历史保留。
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM additional_media_settings").pluck().get() as number, 0);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM additional_media_versions").pluck().get() as number, 3);
      // 引用退役绑定的 ready 提案转 stale；已受理快照不动。
      assert.equal((migrated.prepare("SELECT state FROM proposals WHERE id='prop-stale'").get() as { state: string }).state, "stale");
      assert.equal((migrated.prepare("SELECT state FROM proposals WHERE id='prop-inflight'").get() as { state: string }).state, "accepted");
      // 无在途引用的退役版本清 Key；在途引用的版本保留原 Key 供如实核销。
      const keyOf = (table: string, revisionId: string) => (migrated.prepare(`SELECT api_key FROM ${table} WHERE configuration_revision_id=?`).get(revisionId) as { api_key: string | null }).api_key;
      assert.equal(keyOf("text_model_versions", "cfg-old-claude"), null);
      assert.equal(keyOf("text_model_versions", "cfg-inflight"), "old-key-cfg-inflight", "在途制作引用的退役文本版本保留 Key");
      assert.equal(keyOf("additional_media_versions", "cfg-old-image"), null);
      assert.equal(keyOf("additional_media_versions", "cfg-old-image-inflight"), "old-key-cfg-old-image-inflight");
      assert.equal(keyOf("additional_media_versions", "cfg-old-speech"), null);
      // 历史身份不改写：resolveTextBinding 仍读得到退役协议行；textRegistrationOf 拒绝执行。
      const resolved = resolveTextBinding(migrated, retiredBinding("cfg-old-claude", "claude-haiku-4-5"))!;
      assert.equal(resolved.execution.protocol, "anthropic-messages");
      assert.equal(resolved.apiKey, null);
      assert.equal(textRegistrationOf(migrated, retiredBinding("cfg-old-claude", "claude-haiku-4-5")), null, "退役协议不可执行");
      assert.equal(readAdditionalMediaCurrent(migrated, "openai-image"), null);
      const oldImage = resolveAdditionalMediaBinding(migrated, retiredMediaBinding("cfg-old-image"))!;
      assert.deepEqual({ channelId: oldImage.channelId, apiKey: oldImage.apiKey }, { channelId: "ark-image", apiKey: null }, "历史身份可读但缺 Key 不执行");
    } finally { migrated.close(); }

    // 重启幂等：不再改动，也不因初始化复活旧通道。
    const reopened = openAgentDatabase(legacyDir);
    try {
      initializeTextModelSettings(reopened, clock);
      initializeArkVideoSettings(reopened, { clock });
      initializeProviderConnections(reopened, [
        { id: "revive-text", name: "旧文本", kind: "text", endpoint: "https://api.deepseek.com", modelId: "deepseek-v4-pro", apiKey: "revive-key", details: [] },
        { id: "revive-image", name: "旧图片", kind: "image", endpoint: "https://ark.cn-beijing.volces.com/api/v3", modelId: "doubao-seedream", apiKey: "revive-key", details: [] },
      ]);
      const view = readProviderConnections(reopened);
      assert.deepEqual(view.connections.flatMap(connection => connection.models.map(model => model.kind)), ["video"]);
      assert.equal(connectedTextModels(reopened).length, 0);
      assert.equal((reopened.prepare("SELECT default_entry_id FROM text_model_settings WHERE id=1").get() as { default_entry_id: string | null }).default_entry_id, null);
    } finally { reopened.close(); }
  } finally { rmSync(legacyDir, { recursive: true, force: true }); }
});

// —— M1（媒体后续包 §11.2）：用途矩阵、跨供应商唯一当前、v13 迁移与本地已适配目录 ——

test("M1 用途矩阵与跨供应商唯一当前：MiniMax 配音+视频、wan 仅视频、切换清旧行且切回可恢复", () => {
  const reason = (id: string) => readProviderConnections(db).modelStatuses.find(item => item.modelEntryId === id)!.unavailableReason;
  // 保存边界矩阵：MiniMax 连接拒绝 text/image，wan 与历史协议连接拒绝一切非 video。
  assert.throws(() => save(minimaxConnection({ models: [...minimaxConnection().models, text("mm-text", { modelId: "abab6.5s" })] })), /MiniMax 连接只承载配音与视频/);
  assert.throws(() => save(minimaxConnection({ models: [...minimaxConnection().models, mediaModel("mm-image", "image", "any-image")] })), /MiniMax 连接只承载配音与视频/);
  assert.throws(() => save(wanConnection({ models: [...wanConnection().models, mediaModel("wan-speech", "speech", "speech-2.8-turbo")] })), /不能配置在此视频连接/);
  assert.throws(() => save(wanConnection({ models: [...wanConnection().models, text("wan-text")] })), /不能配置在此视频连接/);
  // 已核实冻结集合内的 MiniMax/万相型号在对应主机上有 Key 即可执行（端口 M2 装配）。
  save(minimaxConnection());
  save(wanConnection());
  assert.equal(reason("mm-speech"), null);
  assert.equal(reason("mm-video"), null);
  assert.equal(reason("wan-video"), null);
  // 未核实主机/集合外型号只登记为备选，不冒充可执行（默认入口会被保存边界拒绝）。
  assert.throws(() => save(wanConnection({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })), /万相接口地址应为工作空间媒体 API 根地址/);
  save(wanConnection({ models: [mediaModel("wan-video", "video", "wan-future")] }));
  assert.equal(reason("wan-video"), "已登记；此型号的媒体执行参数与报价尚未接入");

  // 跨供应商唯一当前（连接保存事务保证）：配音 OpenAI→MiniMax 撤掉 openai-speech 当前行。
  save(openai([text("sol", { isDefault: true }), { ...text("marin"), kind: "speech", modelId: "gpt-realtime-2.1-mini", contextWindowTokens: null, maxOutputTokens: null, isDefault: true }]));
  assert.notEqual(readAdditionalMediaCurrent(db, "openai-speech"), null);
  save(minimaxConnection());
  assert.equal(readAdditionalMediaCurrent(db, "openai-speech"), null, "跨连接选 MiniMax 配音撤掉 OpenAI 配音当前行");
  assert.notEqual(readAdditionalMediaCurrent(db, "minimax-speech"), null);
  assert.notEqual(readAdditionalMediaCurrent(db, "minimax-video"), null);
  // 视频当前在 MiniMax 时 Ark 单行清除；切回 Ark 恢复当前行（保存投影重建），MiniMax 视频行清除。
  assert.equal(readArkVideoCurrent(db), null);
  save(arkVideo());
  assert.notEqual(readArkVideoCurrent(db), null, "切回 Ark 恢复单行当前入口");
  assert.equal(readAdditionalMediaCurrent(db, "minimax-video"), null);
  // 配音切回 OpenAI：minimax-speech 当前行清除，不残留可见可执行的旧入口。
  save(openai([text("sol", { isDefault: true }), { ...text("marin"), kind: "speech", modelId: "gpt-realtime-2.1-mini", contextWindowTokens: null, maxOutputTokens: null, isDefault: true }]));
  assert.equal(readAdditionalMediaCurrent(db, "minimax-speech"), null);
  assert.notEqual(readAdditionalMediaCurrent(db, "openai-speech"), null);
  // 共享 Key：同协议同 Key 的第二个 MiniMax 连接被拒（同一入口，换 Key 是编辑不是新连接）。
  assert.throws(() => save(minimaxConnection({ id: "provider-minimax-b", name: "另一个 MiniMax" })), /已存在同一 Key 的连接/);
});

test("M3 本次MiniMax备选冻结准确型号和音色，OpenAI默认保留，停用不改已受理快照", () => {
  save(openai([mediaModel("default-speech", "speech", "gpt-realtime-2.1", true)]));
  const minimax = minimaxConnection({ models: [mediaModel("turbo", "speech", "speech-2.8-turbo"), mediaModel("hd", "speech", "speech-2.8-hd")] });
  save(minimax);
  const settings = readProviderConnections(db);
  const openaiDefault = readAdditionalMediaCurrent(db, "openai-speech")!;
  const choices = connectedSpeechChoices(db, true);
  assert.deepEqual(choices.models.map(item => item.binding.modelId), ["speech-2.8-turbo", "speech-2.8-hd"]);
  assert.equal(readAdditionalMediaCurrent(db, "minimax-speech"), null, "本次备选不创建MiniMax当前行");
  assert.deepEqual(readProviderConnections(db), settings, "目录读取不保存或切默认");
  assert.equal(connectedSpeechChoices(db, false).models.length, 0);
  const catalog = () => ({ ...additionalMediaCatalog(db, true), ...connectedSpeechChoices(db, true).catalog });
  const binding = choices.catalog["speech:speech-2.8-turbo"]!.binding!;
  db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('choice-conversation','owner','本次配音',1,'choice-session',?,?)").run(clock(), clock());
  const intent: ProductionIntent = { workId: null, title: "本次MiniMax短句", inputRevisions: [],
    operations: [{ kind: "speech", operationId: "voice", outputSlot: "voice", model: binding, maxCreateAttempts: 1,
      inputs: [{ kind: "text", text: "窗外下雨，杯里回暖。" }], parameters: { voiceId: MINIMAX_SPEECH_VOICE, format: "mp3" } }],
    finalOutput: { operationId: "voice", outputSlot: "voice" }, maxSpend: { currency: "CNY", amountMinor: 100 } };
  const scope = { ownerId: "owner", conversationId: "choice-conversation" };
  const proposal = applyPrepareProposal(db, clock(), scope, intent, catalog()).proposal;
  const waiting = applyPrepareProposal(db, clock(), scope, intent, catalog()).proposal;
  const hub = new EventHub();
  const service = new ProductionService(db, clock, hub, catalog, new ProductionBlobs(db, dir, clock));
  const accepted = service.accept("owner", proposal.id, { commandId: "choice-confirm", proposalDigest: proposal.digest });
  const snapshot = (db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").get(accepted.run.snapshotId) as { spec_json: string }).spec_json;
  const frozen = JSON.parse(snapshot) as ProductionIntent;
  assert.deepEqual(frozen.operations[0]!.model, binding);
  assert.equal(frozen.operations[0]!.kind === "speech" && frozen.operations[0]!.parameters.voiceId, MINIMAX_SPEECH_VOICE);
  save({ ...minimax, enabled: false });
  assert.equal((db.prepare("SELECT state FROM proposals WHERE id=?").get(waiting.id) as { state: string }).state, "stale");
  assert.equal(connectedSpeechChoices(db, true).models.length, 0);
  assert.equal((db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").get(accepted.run.snapshotId) as { spec_json: string }).spec_json, snapshot);
  assert.ok(resolveMinimaxSpeechBinding(db, binding), "已受理操作仍可解析原不可变版本");
  assert.equal(readAdditionalMediaCurrent(db, "openai-speech")!.version.configuration_revision_id, openaiDefault.version.configuration_revision_id);
  hub.close();
});

test("M1 移除默认清空当前且不回退：引用旧绑定的未受理提案在保存事务里失效", () => {
  const now = clock();
  db.prepare(`INSERT INTO conversations(id,owner_id,title,revision,created_seq,epoch,pi_session_id,created_at,updated_at)
    VALUES('conv-m1','owner','M1',1,1,0,'s1',?,?)`).run(now, now);
  save(minimaxConnection());
  const binding = JSON.parse(readAdditionalMediaCurrent(db, "minimax-speech")!.version.binding_json);
  db.prepare(`INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,accepted_run_id,revision,created_seq,created_at,updated_at)
    VALUES('prop-m1','conv-m1','owner','dm1',?,'ready','{}','2030-01-01T00:00:00.000Z',NULL,1,1,?,?)`)
    .run(JSON.stringify({ operations: [{ model: binding }] }), now, now);
  // 保存去掉默认（型号仍登记为备选）：当前行清空、ready 提案转 stale，不偷偷回退第一项。
  const stored = readProviderConnections(db).connections.find(item => item.id === "provider-minimax")!;
  const { changedConversations } = save({ ...stored, models: stored.models.map(model => ({ ...model, isDefault: false })) });
  assert.deepEqual(changedConversations, ["conv-m1"]);
  assert.equal((db.prepare("SELECT state FROM proposals WHERE id='prop-m1'").get() as { state: string }).state, "stale");
  assert.equal(readAdditionalMediaCurrent(db, "minimax-speech"), null);
  assert.equal(readAdditionalMediaCurrent(db, "minimax-video"), null);
});

test("M1 MiniMax/万相目录同步返回本地已适配目录：不猜账号级列表端点、不发网络请求", async () => {
  save(minimaxConnection());
  const minimax = await listAvailableProviderModels(db, "provider-minimax", async () => { throw new Error("不应发起网络请求"); });
  const byId = new Map(minimax.models.map(model => [model.id, model]));
  assert.deepEqual(minimax.models.map(model => model.id).sort(), ["MiniMax-H3", "MiniMax-H3-Max", "speech-2.8-hd", "speech-2.8-turbo"]);
  assert.deepEqual(byId.get("speech-2.8-turbo")!.kinds, ["speech"]);
  assert.deepEqual(byId.get("MiniMax-H3")!.kinds, ["video"]);
  assert.equal(minimax.hasMore, false);
  assert.equal(validatorFor("AvailableProviderModels")(minimax).ok, true);

  save(wanConnection());
  const wan = await listAvailableProviderModels(db, "provider-wan", async () => { throw new Error("不应发起网络请求"); });
  assert.deepEqual(wan.models.map(model => model.id).sort(), ["wan3.0-video", "wan3.0-video-prime"]);
  assert.deepEqual(wan.models.every(model => model.kinds.length === 1 && model.kinds[0] === "video"), true);
  assert.equal(validatorFor("AvailableProviderModels")(wan).ok, true);
});

// v13 存量升级（M1 §11.2）：真实 v1–v12 SQL 构建的旧形状库，纯 CHECK 扩展零数据变更。
test("v13 迁移：追加通道 CHECK 扩展；不产生新当前选择、不回填旧 Key、历史身份不改写、重启稳定", () => {
  const legacyDir = mkdtempSync(path.join(tmpdir(), "frame-v13-"));
  try {
    const legacy = new Database(path.join(legacyDir, "agent.db"));
    legacy.pragma("journal_mode = WAL");
    legacy.pragma("synchronous = FULL");
    legacy.pragma("foreign_keys = ON");
    legacy.exec("CREATE TABLE IF NOT EXISTS agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter(item => item.version <= 12)) {
      legacy.transaction(() => {
        for (const statement of migration.statements) legacy.exec(statement);
        legacy.prepare("INSERT INTO agent_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, clock());
      })();
    }
    const now = clock();
    legacy.prepare(`INSERT INTO conversations(id,owner_id,title,revision,created_seq,epoch,pi_session_id,created_at,updated_at)
      VALUES('conv-v13','owner','旧会话',1,1,0,'s1',?,?)`).run(now, now);
    // OpenAI 配音历史（当前行 + 版本）。
    const openaiSpeechBinding = { providerId: "openai", modelId: "gpt-realtime-2.1-mini", connectionId: "openai", configurationRevisionId: "cfg-v13-openai-speech" };
    legacy.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('openai-speech',5,'OpenAI 配音','cfg-v13-openai-speech',?)").run(now);
    legacy.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?,?)")
      .run("cfg-v13-openai-speech", "openai-speech", canonicalJson(openaiSpeechBinding), JSON.stringify({ modelId: openaiSpeechBinding.modelId }), "old-openai-speech-key", now);
    // 旧退役 minimax-speech 版本：无在途引用（Key 已被 v11 清空）与在途引用（Key 保留）各一条。
    const retiredSpeechBinding = (revisionId: string) => ({ providerId: "minimax", modelId: "speech-2.8-turbo", connectionId: "minimax", configurationRevisionId: revisionId });
    // F14 真实旧写入形状，来源：.local/continuous-audit-20261028/before/.../media-config.ts:275–289。
    const retiredProfile = { providerId: "minimax", modelId: "speech-2.8-turbo", baseUrl: "https://api.minimax.cn/v1",
      speech: { voiceId: "male-qn-qingse", format: "mp3" },
      quote: { amountMinor: 40, kind: "estimate", version: "2026-10-public-pricing", source: "minimax 官方定价页", verifiedAt: "2026-10-27" } };
    legacy.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?,?)")
      .run("cfg-v13-retired", "minimax-speech", canonicalJson(retiredSpeechBinding("cfg-v13-retired")), canonicalJson(retiredProfile), null, now);
    legacy.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?,?)")
      .run("cfg-v13-retired-inflight", "minimax-speech", canonicalJson(retiredSpeechBinding("cfg-v13-retired-inflight")), canonicalJson(retiredProfile), "old-retained-key", now);
    // 旧有效 Ark 冻结运行：版本 + 当前行 + 在途 run 引用同一绑定。
    const arkBinding = { providerId: "ark", modelId: DEFAULT_ARK_VIDEO_PROFILE.modelId, connectionId: "ark", configurationRevisionId: "cfg-v13-ark" };
    legacy.prepare("INSERT INTO ark_video_configuration_versions(configuration_revision_id,binding_json,profile_json,api_key,created_at) VALUES(?,?,?,?,?)")
      .run("cfg-v13-ark", canonicalJson(arkBinding), canonicalJson(DEFAULT_ARK_VIDEO_PROFILE), "old-ark-key", now);
    legacy.prepare("INSERT INTO ark_video_settings(id,revision,display_name,current_configuration_revision_id,updated_at) VALUES(1,4,'方舟视频','cfg-v13-ark',?)").run(now);
    legacy.prepare("INSERT INTO works(id,owner_id,conversation_id,title,creation_state_json,revision,created_at,updated_at) VALUES('work-v13','owner','conv-v13','',NULL,1,?,?)").run(now, now);
    legacy.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('snap-v13','{}','dv13',?)").run(now);
    legacy.prepare(`INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,accepted_run_id,revision,created_seq,created_at,updated_at)
      VALUES('prop-v13','conv-v13','owner','dv13','{}','accepted','{}','2030-01-01T00:00:00.000Z','run-v13',1,1,?,?)`).run(now, now);
    legacy.prepare(`INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,revision,created_seq,created_at,updated_at)
      VALUES('run-v13','owner','conv-v13','work-v13','snap-v13','prop-v13','在途','unknown',1,1,?,?)`).run(now, now);
    legacy.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES('run-v13','op-1',?)")
      .run(JSON.stringify({ operations: [{ model: retiredSpeechBinding("cfg-v13-retired-inflight") }] }));
    const versionSnapshot = JSON.stringify(legacy.prepare(
      "SELECT configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at FROM additional_media_versions ORDER BY configuration_revision_id").all());
    legacy.close();

    const snapshotOf = (database: AgentDatabase) => JSON.stringify(database.prepare(
      "SELECT configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at FROM additional_media_versions ORDER BY configuration_revision_id").all());
    const migrated = openAgentDatabase(legacyDir);
    try {
      assert.equal(migrated.prepare("SELECT 1 FROM agent_schema_migrations WHERE version=13").get() !== undefined, true, "v13 已应用");
      // 升级不产生 MiniMax/万相当前选择；OpenAI 配音历史当前行原样保留。
      assert.deepEqual((migrated.prepare("SELECT channel_id FROM additional_media_settings ORDER BY channel_id").all() as { channel_id: string }[]).map(row => row.channel_id), ["openai-speech"]);
      assert.notEqual(readArkVideoCurrent(migrated), null, "Ark 冻结当前行保留");
      // 版本历史与 Key 零变更（不回填旧 Key、不清在途 Key、不改写身份）。
      assert.equal(snapshotOf(migrated), versionSnapshot, "版本历史逐行零变更");
      const keyOf = (revisionId: string) => (migrated.prepare("SELECT api_key FROM additional_media_versions WHERE configuration_revision_id=?").get(revisionId) as { api_key: string | null }).api_key;
      assert.equal(keyOf("cfg-v13-openai-speech"), "old-openai-speech-key");
      assert.equal(keyOf("cfg-v13-retired"), null, "退役行不回填 Key");
      assert.equal(keyOf("cfg-v13-retired-inflight"), "old-retained-key", "在途引用的退役行保留原 Key");
      // 退役 minimax-speech 历史身份可读但不被新通道接管：没有当前行就没有可执行入口。
      const retired = resolveAdditionalMediaBinding(migrated, retiredSpeechBinding("cfg-v13-retired-inflight"))!;
      assert.deepEqual({ channelId: retired.channelId, apiKey: retired.apiKey }, { channelId: "minimax-speech", apiKey: "old-retained-key" });
      assert.equal(resolveMinimaxSpeechBinding(migrated, retiredSpeechBinding("cfg-v13-retired-inflight")), null, "旧同型号版本不能强转为M2端口");
      assert.equal(readAdditionalMediaCurrent(migrated, "minimax-speech"), null);
      // 新通道行可写入（CHECK 已扩展）：保存 MiniMax 配音默认建立当前行。
      initializeTextModelSettings(migrated, clock);
      initializeArkVideoSettings(migrated, { clock });
      initializeProviderConnections(migrated, []);
      saveProviderConnection(migrated, clock, "owner", {
        commandId: "v13-new-speech", expectedRevision: readProviderConnections(migrated).revision,
        connection: { ...minimaxConnection(), models: [mediaModel("mm-speech", "speech", "speech-2.8-turbo", true)] },
      });
      const currentSpeech = readAdditionalMediaCurrent(migrated, "minimax-speech")!;
      assert.ok(currentSpeech, "v13 后新通道当前行可建立");
      const currentBinding = JSON.parse(currentSpeech.version.binding_json);
      assert.equal(resolveMinimaxSpeechBinding(migrated, currentBinding)!.profile.speech.voice, "Chinese (Mandarin)_Gentleman", "当前M2无新标识合法版本可执行");
      assert.equal(keyOf("cfg-v13-retired"), null);
    } finally { migrated.close(); }

    // 重启稳定：再次打开不改动版本历史、不产生新当前选择（openai-speech 当前行已按跨供应商
    // 唯一当前语义在上方保存事务里清除，新 minimax-speech 版本是该保存的合法新增，不是迁移所为）。
    const reopened = openAgentDatabase(legacyDir);
    try {
      assert.deepEqual((reopened.prepare("SELECT channel_id FROM additional_media_settings ORDER BY channel_id").all() as { channel_id: string }[]).map(row => row.channel_id), ["minimax-speech"]);
      const legacyRows = (snapshot: string) => JSON.parse(snapshot).filter((row: { configuration_revision_id: string }) => row.configuration_revision_id.startsWith("cfg-v13-"));
      assert.deepEqual(legacyRows(snapshotOf(reopened)), legacyRows(versionSnapshot), "三条遗留版本行重启后逐行不变");
      const keyOf = (revisionId: string) => (reopened.prepare("SELECT api_key FROM additional_media_versions WHERE configuration_revision_id=?").get(revisionId) as { api_key: string | null }).api_key;
      assert.equal(keyOf("cfg-v13-retired"), null);
      assert.equal(keyOf("cfg-v13-retired-inflight"), "old-retained-key");
    } finally { reopened.close(); }
  } finally { rmSync(legacyDir, { recursive: true, force: true }); }
});


test("F13 启动以统一选择纠偏：A→MiniMax→Wan→空→Ark，首次纠偏使ready失效、冻结不动、重启幂等", () => {
  save(arkVideo());
  const ark = readArkVideoCurrent(db)!;
  const versionCount = () => db.prepare("SELECT COUNT(*) FROM ark_video_configuration_versions").pluck().get();
  save(minimaxConnection());
  assert.equal(readArkVideoCurrent(db), null);
  // 模拟旧 main 曾错误复活的派生行；统一选择仍为 MiniMax，冻结版本和作品均不改。
  db.prepare("INSERT INTO ark_video_settings(id,revision,display_name,current_configuration_revision_id,updated_at) VALUES(1,0,'多余Ark',?,?)").run(ark.version.configuration_revision_id, clock());
  db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('restart-conv','owner','重启',1,'restart-pi',?,?)").run(clock(), clock());
  for (const [id, state] of [["restart-ready", "ready"], ["restart-accepted", "accepted"]]) {
    db.prepare("INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,created_seq,created_at,updated_at) VALUES(?,'restart-conv','owner',?,?,?,'估算','2030-01-01',?,?,?)")
      .run(id, id, canonicalJson({ operations: [{ model: JSON.parse(ark.version.binding_json) }] }), state, id === "restart-ready" ? 1 : 2, clock(), clock());
  }
  const immutable = canonicalJson(db.prepare("SELECT * FROM ark_video_configuration_versions").all());
  initializeArkVideoSettings(db, { clock });
  assert.equal(readLegacyArkConfig(db, "/must-not-read/legacy.json", true), undefined);
  initializeProviderConnections(db, [], clock);
  assert.equal(readArkVideoCurrent(db), null);
  assert.equal(additionalMediaModelViews(db, true).filter(view => view.kind === "video").length, 1);
  assert.equal(db.prepare("SELECT state FROM proposals WHERE id='restart-ready'").pluck().get(), "stale");
  assert.equal(db.prepare("SELECT state FROM proposals WHERE id='restart-accepted'").pluck().get(), "accepted");
  assert.equal(resolveArkBinding(db, JSON.parse(ark.version.binding_json))!.apiKey, ark.version.api_key);
  assert.equal(canonicalJson(db.prepare("SELECT * FROM ark_video_configuration_versions").all()), immutable);
  const events = db.prepare("SELECT COUNT(*) FROM events WHERE entity_id='restart-ready' AND kind='proposal.changed'").pluck().get();
  const revision = readProviderConnections(db).revision;
  const speech = readAdditionalMediaCurrent(db, "minimax-speech")!;
  initializeProviderConnections(db, [], clock);
  assert.equal(db.prepare("SELECT COUNT(*) FROM events WHERE entity_id='restart-ready' AND kind='proposal.changed'").pluck().get(), events);
  assert.equal(readAdditionalMediaCurrent(db, "minimax-speech")!.revision, speech.revision);
  assert.equal(readProviderConnections(db).revision, revision, "启动不是用户保存");
  save(wanConnection());
  initializeProviderConnections(db, [], clock);
  assert.equal(readArkVideoCurrent(db), null);
  assert.equal(readAdditionalMediaCurrent(db, "minimax-video"), null);
  assert.ok(readAdditionalMediaCurrent(db, "wan-video"));
  const wan = readProviderConnections(db).connections.find(item => item.protocol === "wan")!;
  save({ ...wan, models: wan.models.map(model => ({ ...model, isDefault: false })) });
  initializeProviderConnections(db, [], clock);
  assert.equal(connectedMediaEnabled(db, "video"), false);
  assert.equal(additionalMediaModelViews(db, true).filter(view => view.kind === "video").length, 0);
  const count = versionCount();
  save(arkVideo());
  assert.equal(readArkVideoCurrent(db)!.version.configuration_revision_id, ark.version.configuration_revision_id, "切回沿用相同不可变版本");
  initializeProviderConnections(db, [], clock);
  assert.equal(versionCount(), count);
});

test("F12 保存根地址规则与只读状态同源：错误路径/override拒绝，已存错误配置不可调用且不改冻结", () => {
  assert.throws(() => save(minimaxConnection({ baseUrl: "https://api.minimax.cn/v1" })), /MiniMax 接口地址应为.*根地址/);
  assert.throws(() => save(minimaxConnection({ models: [{ ...mediaModel("mm-speech", "speech", "speech-2.8-turbo", true), baseUrl: "https://api.minimax.io/v1/t2a_v2" }] })), /不要附加/);
  save(minimaxConnection({ baseUrl: " https://api.minimax.cn/ " }));
  const original = readAdditionalMediaCurrent(db, "minimax-speech")!.version;
  const stored = readProviderConnections(db).connections.find(item => item.protocol === "minimax")!;
  const invalid = { ...stored, baseUrl: "https://api.minimax.cn/v1" };
  db.prepare("UPDATE provider_connections SET configuration_json=? WHERE id=?").run(canonicalJson(invalid), invalid.id);
  assert.match(readProviderConnections(db).modelStatuses.find(item => item.modelEntryId === "mm-speech")!.unavailableReason!, /根地址/);
  initializeProviderConnections(db, [], clock);
  assert.equal(connectedMediaEnabled(db, "speech"), false);
  assert.equal(readAdditionalMediaCurrent(db, "minimax-speech"), null);
  assert.equal(resolveMinimaxSpeechBinding(db, JSON.parse(original.binding_json))!.apiKey, original.api_key, "旧冻结原身份不改");
  save({ ...invalid, baseUrl: "https://api.minimax.cn" });
  assert.equal(connectedMediaEnabled(db, "speech"), true);
});

test("F15 实际10/100/1000汉字报价：两输入形式同价，prepare/admit同口径，旧未受理价失效、已受理重放保留", () => {
  save(minimaxConnection({ baseUrl: "https://api.minimax.cn", models: [mediaModel("mm-speech", "speech", "speech-2.8-turbo", true)] }));
  db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('quote-conv','owner','报价',1,'quote-pi',?,?)").run(clock(), clock());
  const binding = JSON.parse(readAdditionalMediaCurrent(db, "minimax-speech")!.version.binding_json);
  const catalog = () => additionalMediaCatalog(db, true);
  const service = new ProductionService(db, clock, new EventHub(), catalog, new ProductionBlobs(db, dir, clock));
  for (const [length, minor] of [[10, 1], [100, 4], [1000, 40]]) {
    const text = "汉".repeat(length!);
    const artifactId = `quote-art-${length}`, revisionId = `quote-rev-${length}`, content = { format: "markdown", text };
    db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,'quote-conv','owner','旁白','script',?,1,?,?,?)").run(artifactId, revisionId, length, clock(), clock());
    db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,?,?)").run(revisionId, artifactId, digestOf(content), canonicalJson(content), clock());
    const intent = (reference: boolean): ProductionIntent => ({ workId: null, title: `旁白${length}`, inputRevisions: reference ? [{ artifactId, revisionId }] : [],
      operations: [{ operationId: "speech", outputSlot: "speech", kind: "speech", model: binding,
        inputs: [reference ? { kind: "artifact_revision", artifactId, revisionId, digest: digestOf(content) } : { kind: "text", text }],
        parameters: { voiceId: "Chinese (Mandarin)_Gentleman", format: "mp3" }, maxCreateAttempts: 1 }],
      finalOutput: { operationId: "speech", outputSlot: "speech" }, maxSpend: { currency: "CNY", amountMinor: 40 } });
    const proposals = [false, true].map(reference => applyPrepareProposal(db, clock(), { ownerId: "owner", conversationId: "quote-conv" }, intent(reference), catalog()).proposal);
    for (const proposal of proposals) {
      const spec = JSON.parse(proposal.spec_json);
      assert.equal(spec.operations[0].quotePerAttempt.amountMinor, minor);
      assert.match(proposal.price_disclosure, /本次冻结文本的实际 Unicode 码点数/);
      assert.doesNotMatch(proposal.price_disclosure, /2000 计费字符/);
      const action = { commandId: crypto.randomUUID(), proposalDigest: proposal.digest };
      const accepted = service.accept("owner", proposal.id, action);
      assert.equal(JSON.parse((db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").get(accepted.run.snapshotId) as { spec_json: string }).spec_json).operations[0].quotePerAttempt.amountMinor, minor);
      assert.equal(service.accept("owner", proposal.id, action).run.id, accepted.run.id);
    }
    if (length === 10) {
      const oldCatalog = catalog();
      const entry = oldCatalog[`speech:${binding.modelId}`]!;
      delete entry.quoteMinorFor;
      const old = applyPrepareProposal(db, clock(), { ownerId: "owner", conversationId: "quote-conv" }, intent(false), oldCatalog).proposal;
      assert.equal(JSON.parse(old.spec_json).operations[0].quotePerAttempt.amountMinor, 40);
      assert.throws(() => service.accept("owner", old.id, { commandId: crypto.randomUUID(), proposalDigest: old.digest }), /模型配置或价格已变化/);
    }
  }
});
