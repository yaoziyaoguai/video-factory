import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import Fastify from "fastify";
import { MaintenanceGate } from "../src/server/maintenance-gate.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildFrameApp } from "../src/server/agent/app.js";
import { agentRoutes } from "../src/server/agent/routes.js";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { initializeArkVideoSettings, readLegacyArkConfig, readArkVideoCurrent, resolveArkBinding, arkVideoCatalog, arkVideoModelView } from "../src/server/agent/ark-video-settings.js";
import { readProviderConnections, saveProviderConnection } from "../src/server/agent/provider-connections.js";
import { initializeTextModelSettings } from "../src/server/agent/text-model-settings.js";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { applyPrepareProposal } from "../src/server/agent/artifact-store.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { DEFAULT_ARK_VIDEO_PROFILE, type AgentMediaConfig } from "../src/server/agent/media-config.js";
import type { ProductionIntent, ProviderConnection } from "../src/shared/agent/generated/contracts.js";
import { bindPreparedPlan, seedPlanStageWork } from "./helpers/creative-work-fixture.js";

// F13：原 C2 的冻结、失效、事务、权限、Pi 连续性与首次导入行为迁到统一配置入口。
// 旧 CRUD 的固定回执形状和隔离 503 已退役；最终服务对 GET/PATCH 均正常 404。
const clock = () => "2026-11-01T00:00:00.000Z";
const render = { available: true, probeAvailable: true, aacAvailable: true, reason: "测试桩" };
const origin = "http://127.0.0.1:4500";
const headers = { "content-type": "application/json", origin, "x-video-factory-request": "studio" };
let sequence = 0;
const cmd = () => `ark-unified-${++sequence}`;
const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const, verificationNote: "隔离替身", isDefault: true };

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-ark-unified-"));
  const runtime = await createAgentRuntime({ dataDir: directory, skillsRoot: defaultSkillsRoot, providerConnections: true,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL], tokensPerSecond: 100 } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock,
    media: { autoStart: false, factory: db => {
      initializeArkVideoSettings(db, { clock });
      return { port: { submit: async () => { throw new Error("不应发起供应商请求"); }, query: async () => { throw new Error("不应查询"); }, cancel: async () => { throw new Error("不应取消"); } },
        catalog: () => arkVideoCatalog(readArkVideoCurrent(db), render),
        models: () => { const current = readArkVideoCurrent(db); return current ? [arkVideoModelView(current, render)] : []; } };
    } },
  });
  const maintenanceGate = new MaintenanceGate();
  await maintenanceGate.announceStartup();
  const app = buildFrameApp({ maintenanceGate, agent: { service: runtime.service, resolveOwner: () => "local-owner", localOwnerOnly: true, uiOrigin: origin } });
  t.after(async () => { await app.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const connection = (): ProviderConnection => readProviderConnections(runtime.database).connections.find(item => item.protocol === "ark")!;
  const save = (value: ProviderConnection) => runtime.service.saveProviderConnection("local-owner", {
    commandId: cmd(), expectedRevision: readProviderConnections(runtime.database).revision, connection: value,
  });
  const configured = (): ProviderConnection => ({
    id: "test-ark", protocol: "ark", name: "火山方舟", baseUrl: DEFAULT_ARK_VIDEO_PROFILE.baseUrl, apiKey: "synthetic-ark-A", enabled: true,
    models: [{ id: "test-seedance", name: "Seedance", modelId: DEFAULT_ARK_VIDEO_PROFILE.modelId, kind: "video",
      enabled: true, isDefault: true, contextWindowTokens: null, maxOutputTokens: null, features: [] }],
  });
  return { app, runtime, connection, save, configured, directory };
}

it("统一配置 HTTP：响应符合合同，权限/Origin/安全头有效；旧 Ark GET/PATCH 为404且不写库", async t => {
  const f = await setup(t);
  const initial = await f.app.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" });
  assert.equal(initial.statusCode, 200);
  assert.equal(validatorFor("ProviderConnectionSettings")(initial.json()).ok, true);
  const payload = { commandId: cmd(), expectedRevision: initial.json().revision, connection: f.configured() };
  assert.equal((await f.app.inject({ method: "POST", url: "/api/agent/v1/settings/model-connections", headers: { "content-type": "application/json", "x-video-factory-request": "studio" }, payload })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/agent/v1/settings/model-connections", headers: { ...headers, "x-video-factory-request": "other" }, payload })).statusCode, 403);
  const saved = await f.app.inject({ method: "POST", url: "/api/agent/v1/settings/model-connections", headers, payload });
  assert.equal(saved.statusCode, 200);
  assert.equal(validatorFor("SaveProviderConnectionReceipt")(saved.json()).ok, true);
  assert.ok(!saved.body.includes("synthetic-ark-A"), "保存回执不包含凭据");
  const before = f.runtime.database.serialize();
  for (const method of ["GET", "PATCH"] as const) {
    const response = await f.app.inject({ method, url: "/api/agent/v1/settings/ark-video", headers, ...(method === "PATCH" ? { payload: { commandId: cmd(), apiKey: "fake-legacy" } } : {}) });
    assert.equal(response.statusCode, 404);
  }
  assert.deepEqual(f.runtime.database.serialize(), before, "旧接口不再有写入入口");
  const anon = Fastify();
  await anon.register(agentRoutes, { prefix: "/api/agent/v1", service: f.runtime.service, resolveOwner: () => null, uiOrigin: origin, localOwnerOnly: true });
  try {
    assert.equal((await anon.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" })).statusCode, 401);
    assert.equal((await anon.inject({ method: "POST", url: "/api/agent/v1/settings/model-connections", headers, payload })).statusCode, 401);
  } finally { await anon.close(); }
  for (const serviceId of ["pexels", "newsnow"]) {
    const response = await f.app.inject({ method: "GET", url: `/api/agent/v1/settings/services/${serviceId}` });
    assert.equal(response.statusCode, 200);
    assert.equal(validatorFor("FreeServiceSettings")(response.json()).ok, true);
  }
});

it("统一 Ark 保存：改名沿用版本，改Key冻结旧身份，幂等/冲突/原子回滚沿现有命令规则", async t => {
  const f = await setup(t), db = f.runtime.database;
  f.save(f.configured());
  const original = readArkVideoCurrent(db)!;
  const oldBinding = JSON.parse(original.version.binding_json);
  const versionCount = () => db.prepare("SELECT COUNT(*) FROM ark_video_configuration_versions").pluck().get();
  const count = versionCount();
  f.save({ ...f.connection(), models: f.connection().models.map(model => ({ ...model, name: "新名字" })) });
  assert.equal(readArkVideoCurrent(db)!.version.binding_json, original.version.binding_json);
  assert.equal(versionCount(), count, "改名不新建执行版本");
  const body = { commandId: cmd(), expectedRevision: readProviderConnections(db).revision, connection: { ...f.connection(), apiKey: "synthetic-ark-B" } };
  const saved = f.runtime.service.saveProviderConnection("local-owner", body);
  assert.notEqual(readArkVideoCurrent(db)!.version.configuration_revision_id, original.version.configuration_revision_id);
  assert.equal(resolveArkBinding(db, oldBinding)!.apiKey, "synthetic-ark-A");
  assert.equal(f.runtime.service.saveProviderConnection("local-owner", body).replayed, true);
  assert.equal(readProviderConnections(db).revision, saved.revision);
  assert.throws(() => f.runtime.service.saveProviderConnection("local-owner", { ...body, connection: { ...body.connection, apiKey: "other" } }), /同一命令/);
  assert.throws(() => f.runtime.service.saveProviderConnection("local-owner", { ...body, commandId: cmd() }), /配置已更新/);
  db.exec("CREATE TRIGGER unified_abort_receipt BEFORE INSERT ON command_receipts WHEN NEW.operation='saveProviderConnection' BEGIN SELECT RAISE(ABORT, 'unified-abort'); END");
  const rollbackState = db.serialize();
  try { assert.throws(() => f.save({ ...f.connection(), apiKey: "synthetic-ark-C" }), /unified-abort/); }
  finally { assert.deepEqual(db.serialize(), rollbackState, "连接、版本、投影、事件和回执整体回滚"); db.exec("DROP TRIGGER unified_abort_receipt"); }
  assert.equal(resolveArkBinding(db, oldBinding)!.apiKey, "synthetic-ark-A");
});

function prompt(db: AgentDatabase, conversationId: string) {
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev");
  const content = { format: "markdown", text: "山路，固定输入。" };
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,'输入','prompt',?,1,1,?,?)").run(artifactId, conversationId, "local-owner", revisionId, clock(), clock());
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,?,?)").run(revisionId, artifactId, digestOf(content), canonicalJson(content), clock());
  return { artifactId, revisionId, digest: digestOf(content) };
}

it("统一 current 闭合 bootstrap/prepare/admit：换Key使ready失效，已受理重放/原快照与进行中Pi保持", async t => {
  const f = await setup(t), db = f.runtime.database;
  f.save(f.configured());
  const makeProposal = (title: string) => {
    const conversation = f.runtime.service.createConversation("local-owner", { commandId: cmd(), title }).conversation;
    const ref = prompt(db, conversation.id);
    const work = seedPlanStageWork(db, clock(), { ownerId: "local-owner", conversationId: conversation.id }, title);
    const spec: ProductionIntent = { workId: work.workId, title, inputRevisions: [{ artifactId: ref.artifactId, revisionId: ref.revisionId }],
      operations: [{ operationId: "shot", outputSlot: "video", kind: "video", model: JSON.parse(readArkVideoCurrent(db)!.version.binding_json), inputs: [{ kind: "artifact_revision", ...ref }], maxCreateAttempts: 1,
        parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" } }],
      finalOutput: { operationId: "shot", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 755 } };
    const proposal = applyPrepareProposal(db, clock(), { ownerId: "local-owner", conversationId: conversation.id }, spec, arkVideoCatalog(readArkVideoCurrent(db), render)).proposal;
    bindPreparedPlan(db, clock(), { ownerId: "local-owner", conversationId: conversation.id }, proposal, work);
    return { conversation, proposal, spec };
  };
  const ready = makeProposal("待受理"), accepted = makeProposal("已受理");
  const acceptCommand = { commandId: cmd(), proposalDigest: accepted.proposal.digest };
  const admitted = f.runtime.service.acceptProposal("local-owner", accepted.proposal.id, acceptCommand);
  const snapshot = db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").pluck().get(admitted.run.snapshotId);
  f.runtime.host.faux!.setResponses([fauxAssistantMessage("这个话题可以继续聊，配置保存不影响本回合。")]);
  await f.runtime.service.sendMessage("local-owner", ready.conversation.id, { commandId: cmd(), text: "顺便聊天", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  const session = db.prepare("SELECT pi_session_id FROM conversations WHERE id=?").pluck().get(ready.conversation.id);
  f.save({ ...f.connection(), apiKey: "synthetic-ark-B" });
  assert.equal(db.prepare("SELECT state FROM proposals WHERE id=?").pluck().get(ready.proposal.id), "stale");
  assert.equal(db.prepare("SELECT state FROM proposals WHERE id=?").pluck().get(accepted.proposal.id), "accepted");
  assert.equal(f.runtime.service.acceptProposal("local-owner", accepted.proposal.id, acceptCommand).run.id, admitted.run.id);
  assert.equal(db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").pluck().get(admitted.run.snapshotId), snapshot);
  const binding = JSON.parse(readArkVideoCurrent(db)!.version.binding_json);
  assert.equal(f.runtime.service.bootstrap("local-owner").models.find(model => model.kind === "video")!.binding.configurationRevisionId, binding.configurationRevisionId);
  assert.throws(() => f.runtime.service.acceptProposal("local-owner", ready.proposal.id, { commandId: cmd(), proposalDigest: ready.proposal.digest }), /提案已失效/);
  await assert.rejects(f.runtime.service.prepareProposal("local-owner", ready.conversation.id, { commandId: cmd(), spec: ready.spec }), /模型绑定与本地目录不一致/);
  const deadline = Date.now() + 5000;
  while (f.runtime.service.snapshot("local-owner", ready.conversation.id).activeRequestId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.runtime.service.snapshot("local-owner", ready.conversation.id).activeRequestId, null);
  assert.equal(db.prepare("SELECT pi_session_id FROM conversations WHERE id=?").pluck().get(ready.conversation.id), session);
  assert.equal(db.prepare("SELECT COUNT(*) FROM production_runs").pluck().get(), 1);
});

it("首次旧部署导入按资格读取：精确空Key可补；统一设置建立后不读旧文件、不播种或替换历史Key", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-ark-import-"));
  const db = openAgentDatabase(directory);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, "legacy.json"), credentialFile = path.join(directory, "key");
  const config: AgentMediaConfig = { providerId: "ark", connectionId: "legacy-ark", modelId: DEFAULT_ARK_VIDEO_PROFILE.modelId, baseUrl: DEFAULT_ARK_VIDEO_PROFILE.baseUrl, credentialFile,
    video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" }, quote: { amountMinor: 756, kind: "estimate", version: "test", source: "合成旧部署", verifiedAt: "2026-10-27" } };
  await writeFile(file, JSON.stringify(config));
  initializeArkVideoSettings(db, { clock, legacy: readLegacyArkConfig(db, file, false) });
  const original = readArkVideoCurrent(db)!;
  assert.equal(original.version.api_key, null);
  await writeFile(file, JSON.stringify({ ...config, connectionId: "different" }));
  assert.equal(readLegacyArkConfig(db, file, true), undefined, "非精确历史不读取不存在的Key");
  await writeFile(file, JSON.stringify(config));
  await writeFile(credentialFile, "synthetic-import-key");
  initializeArkVideoSettings(db, { clock, legacy: readLegacyArkConfig(db, file, true) });
  assert.equal(readArkVideoCurrent(db)!.version.configuration_revision_id, original.version.configuration_revision_id);
  assert.equal(readArkVideoCurrent(db)!.version.api_key, "synthetic-import-key");
  initializeTextModelSettings(db, clock);
  const { initializeProviderConnections } = await import("../src/server/agent/provider-connections.js");
  initializeProviderConnections(db, [], clock);
  const connection = readProviderConnections(db).connections[0]!;
  saveProviderConnection(db, clock, "local-owner", { commandId: cmd(), expectedRevision: 0,
    connection: { ...connection, apiKey: "synthetic-web-key", models: connection.models.map(model => ({ ...model, isDefault: true })) } });
  const current = readArkVideoCurrent(db)!;
  await rm(file); await rm(credentialFile);
  assert.equal(readLegacyArkConfig(db, file, true), undefined, "资格判断在任何旧文件读取之前");
  initializeArkVideoSettings(db, { clock, legacy: { config, apiKey: "must-not-overwrite" } });
  assert.equal(readArkVideoCurrent(db)!.version.binding_json, current.version.binding_json);
  assert.equal(resolveArkBinding(db, JSON.parse(original.version.binding_json))!.apiKey, "synthetic-import-key");
});
