import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import type { MessageInput, ProductionIntent } from "../src/shared/agent/generated/contracts.js";
import { inlineSchema } from "../src/server/agent/pi-tools.js";

test("Pi 原生工具入口执行 canonical 正反例，业务层不重复解析同一结构", async () => {
  const examples: { name: string; schema: string; valid: boolean; value: JsonObject }[] = JSON.parse(
    await readFile(new URL("../../../contracts/agent/v1/examples.json", import.meta.url), "utf8"),
  );
  const toolSchemas = new Set(["ToolReadArtifact", "ToolReadProposal", "ToolReadRun", "ToolListProduction", "ToolSearchMaterials", "ToolReadTrends", "ToolImportMaterial", "ToolDelivery", "ToolPrepareProposal"]);
  for (const example of examples.filter(item => toolSchemas.has(item.schema))) {
    const validate = () => validateToolArguments(
      { name: example.schema, description: "工具契约边界", parameters: inlineSchema(example.schema) },
      { type: "toolCall", id: "contract-check", name: example.schema, arguments: example.value },
    );
    if (example.valid) assert.doesNotThrow(validate, example.name);
    else assert.throws(validate, /Validation failed/, example.name);
  }
});

const origin = "http://127.0.0.1:4398";
const input = (text: string, extra: Partial<MessageInput> = {}): MessageInput => ({
  commandId: `cmd-${crypto.randomUUID()}`, text, target: null, skillId: null, proposalRef: null,
  mode: "new", steerRequestId: null, ...extra,
});
const deliver = (title: string) => fauxAssistantMessage([fauxToolCall("deliver_artifacts", {
  items: [{ mode: "create", title, kind: "prompt", content: { format: "markdown", text: title } }],
})]);
async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < until, "condition timed out"); await new Promise(r => setTimeout(r, 10)); }
}
function latch() {
  let release!: () => void;
  const ready = new Promise<void>(r => { release = r; });
  return { ready, release };
}
async function fixture(t: TestContext, options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-audit-"));
  const a = await assembleOfflineAgent({ dataDir, uiOrigin: origin, ...options });
  t.after(async () => { await a.close(); await rm(dataDir, { recursive: true, force: true }); });
  return a;
}
function create(a: OfflineAgentAssembly, title: string) {
  return a.service.createConversation("local-owner", { commandId: `cmd-${crypto.randomUUID()}`, title }).conversation.id;
}
const snap = (a: OfflineAgentAssembly, id: string) => a.service.snapshot("local-owner", id);
async function done(a: OfflineAgentAssembly, id: string) {
  await waitFor(() => !a.database.prepare("SELECT id FROM requests WHERE conversation_id=? AND state IN ('queued','running')").get(id));
}

test("Pi 严格合同：SDK 自动转换数字或删除可选 null 后，不得执行业务工具", async t => {
  const a = await fixture(t); const id = create(a, "strict tool boundary");
  let blocked = 0;
  for (const malformed of [
    { name: "deliver_artifacts", args: { items: [{ mode: "create", title: 42, kind: "prompt", content: { format: "markdown", text: "test" } }] } },
    { name: "read_trends", args: { limit: 5, sourceIds: null } },
  ]) {
    a.faux!.setResponses([fauxAssistantMessage([fauxToolCall(malformed.name, malformed.args)]), context => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1);
      assert.equal(result?.role === "toolResult" && result.isError, true);
      assert.match(JSON.stringify(result), /不能隐式转换或删除字段/);
      blocked++;
      return fauxAssistantMessage("请改正输入类型。");
    }]);
    await a.service.sendMessage("local-owner", id, input("提交严格类型测试")); await done(a, id);
    assert.equal(snap(a, id).artifacts.items.length, 0, "错误输入不得被转换后写入产物");
  }
  assert.equal(blocked, 2);
  a.faux!.setResponses([deliver("有效产物"), fauxAssistantMessage("done")]);
  await a.service.sendMessage("local-owner", id, input("提交正常产物")); await done(a, id);
  assert.deepEqual(snap(a, id).artifacts.items.map(item => item.title), ["有效产物"]);
});

test("A-12 simultaneous tool calls retain their own conversation context", async t => {
  const a = await fixture(t);
  const first = create(a, "first"), second = create(a, "second");
  const gateA = latch(), gateB = latch();
  let enteredA = false, enteredB = false;
  a.faux!.setResponses([
    async () => { enteredA = true; await gateA.ready; return deliver("output A"); },
    async () => { enteredB = true; await gateB.ready; return deliver("output B"); },
    fauxAssistantMessage("A done"), fauxAssistantMessage("B done"),
  ]);
  try {
    await a.service.sendMessage("local-owner", first, input("produce A"));
    await waitFor(() => enteredA);
    await a.service.sendMessage("local-owner", second, input("produce B"));
    await waitFor(() => enteredB);
    gateA.release(); await done(a, first);
    gateB.release(); await done(a, second);
    assert.deepEqual(snap(a, first).artifacts.items.map(x => x.title), ["output A"]);
    assert.deepEqual(snap(a, second).artifacts.items.map(x => x.title), ["output B"]);
  } finally { gateA.release(); gateB.release(); }
});

test("A-30 explicit skillId expands the installed Pi Skill for this request", async t => {
  const a = await fixture(t); const id = create(a, "skill");
  let userContent = "";
  a.faux!.setResponses([context => {
    assert.match(JSON.stringify(context.messages.filter(message => message.role === "system")), /<available_skills>/);
    userContent = JSON.stringify(context.messages.filter(x => x.role === "user"));
    return fauxAssistantMessage("done");
  }]);
  await a.service.sendMessage("local-owner", id, input("请给三个方向", { skillId: "travel-prompt-kit" }));
  await done(a, id);
  assert.match(userContent, /<skill name=|<skill>/);
  assert.match(userContent, /travel-prompt-kit/);
});

test("审计 F4：指定 Skill 加载期间停止，不再进入 Pi prompt；下一条请求正常", async t => {
  const a = await fixture(t); const id = create(a, "stop skill load");
  const gate = latch(), entered = latch(); let calls = 0;
  const list = a.host.listSkills.bind(a.host);
  a.host.listSkills = async () => { entered.release(); await gate.ready; return list(); };
  a.faux!.setResponses([() => { calls++; return fauxAssistantMessage("只应属于后续请求"); }]);
  try {
    const sent = await a.service.sendMessage("local-owner", id, input("指定 Skill", { skillId: "travel-prompt-kit" }));
    await entered.ready;
    a.service.stopRequest("local-owner", sent.receipt.requestId!, { commandId: "stop-during-skill" });
    gate.release(); await done(a, id);
    assert.equal(calls, 0, "停止后的请求不得重新调用模型");
    assert.equal((a.database.prepare("SELECT state FROM requests WHERE id=?").get(sent.receipt.requestId) as { state: string }).state, "stopped");
    await a.service.sendMessage("local-owner", id, input("换个话题")); await done(a, id);
    assert.equal(calls, 1);
  } finally { gate.release(); a.host.listSkills = list; }
});

test("A-28 committed delivery already has a durable message reference before Pi gets its result", async t => {
  let atCommit: unknown;
  const a = await fixture(t, { crashPoint: (point: string) => {
    if (point === "after-deliver-commit") atCommit = snap(a, id).messages.items.find(x => x.role === "assistant")?.references;
  } });
  const id = create(a, "receipt");
  a.faux!.setResponses([deliver("a"), fauxAssistantMessage("done")]);
  await a.service.sendMessage("local-owner", id, input("produce")); await done(a, id);
  assert.ok(atCommit && (atCommit as { artifacts: unknown[] }).artifacts.length === 1);
});

test("A-31 all snapshot initial pages share its event watermark", async t => {
  const a = await fixture(t); const id = create(a, "watermarks");
  a.faux!.setResponses([deliver("one"), fauxAssistantMessage("done")]);
  await a.service.sendMessage("local-owner", id, input("produce")); await done(a, id);
  const snapshot = snap(a, id);
  for (const page of [snapshot.messages, snapshot.artifacts, snapshot.proposals, snapshot.runs]) assert.equal(page.watermark, snapshot.eventCursor);
});

test("A-23 malformed JSON returns the v1 INVALID_INPUT error", async t => {
  const a = await fixture(t);
  const response = await a.app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers: {
    origin, "content-type": "application/json", "x-video-factory-request": "studio",
  }, payload: '{"title":' });
  assert.equal(response.statusCode, 400); assert.equal(response.json().code, "INVALID_INPUT");
});

test("A-17 terminal request replays the same batch with a new toolCallId", async t => {
  const a = await fixture(t), id = create(a, "replay");
  a.faux!.setResponses([deliver("one"), fauxAssistantMessage("done")]);
  const { receipt } = await a.service.sendMessage("local-owner", id, input("produce")); await done(a, id);
  const { BusinessTools } = await import("../src/server/agent/pi-tools.js");
  const { OFFLINE_QUOTE_CATALOG } = await import("../src/server/agent/offline.js");
  const row = a.database.prepare("SELECT * FROM tool_invocations WHERE request_id=? AND tool_name='deliver_artifacts'").get(receipt.requestId) as { args_json: string };
  const request = a.database.prepare("SELECT execution_epoch FROM requests WHERE id=?").get(receipt.requestId) as { execution_epoch: number };
  const context = { actorId: "local-owner", conversationId: id, requestId: receipt.requestId, executionEpoch: request.execution_epoch, target: null, toolCallId: "call-new" };
  const tools = new BusinessTools(a.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
  const result = await tools.deliverArtifacts(context as never, JSON.parse(row.args_json));
  assert.equal(result.replayed, true);
  assert.equal(snap(a, id).artifacts.items.length, 1);
  await assert.rejects(tools.deliverArtifacts({ ...context, toolCallId: "call-different" } as never, { items: [{ mode: "create", title: "other", kind: "prompt", content: { format: "markdown", text: "different" } }] }), (e: any) => e.code === "DELIVERY_CLOSED");
});

test("A-19 one bad reference rejects the entire batch without consuming delivery", async t => {
  const a = await fixture(t), id = create(a, "atomic");
  const good = { mode: "create", title: "valid", kind: "prompt", content: { format: "markdown", text: "valid" } };
  a.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [good, { mode: "revise", artifactId: "missing-artifact", baseRevisionId: "missing-revision", content: { format: "markdown", text: "bad" } }, { ...good, title: "also valid" }] })]),
    () => { assert.equal(snap(a, id).artifacts.items.length, 0); assert.equal((a.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries").get() as { n: number }).n, 0); return deliver("retry valid"); },
    fauxAssistantMessage("done"),
  ]);
  await a.service.sendMessage("local-owner", id, input("produce")); await done(a, id);
  assert.deepEqual(snap(a, id).artifacts.items.map(item => item.title), ["retry valid"]);
});

test("A-24 controlled Skill reader rejects escape, symlink and oversized files, accepts native SDK paths", async t => {
  const { buildAgentTools, BusinessTools } = await import("../src/server/agent/pi-tools.js");
  const a = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "frame-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = path.join(root, "skills"); await mkdir(skills);
  await writeFile(path.join(root, "outside.txt"), "private fixture");
  await writeFile(path.join(skills, "ok.txt"), "approved");
  await writeFile(path.join(skills, "large.txt"), "a".repeat(262145));
  await symlink(path.join(root, "outside.txt"), path.join(skills, "link.txt"));
  const definitions = buildAgentTools({ current: null }, new BusinessTools(a.database, () => new Date().toISOString(), () => ({})), skills);
  // S2 新增视频创作事项与素材批次读取工具；白名单随合同同步，不额外暴露其他能力。
  assert.deepEqual(definitions.map(tool => tool.name).sort(), [
    "confirm_stage", "deliver_artifacts", "import_material", "list_production", "prepare_production",
    "read_artifact", "read_material_batch", "read_proposal", "read_run", "read_skill_file",
    "read_trends", "read_work", "record_work_feedback", "search_materials", "start_work",
  ]);
  const reader = definitions.find(tool => tool.name === "read_skill_file")!;
  for (const file of ["../outside.txt", "link.txt", "large.txt", "."]) await assert.rejects(reader.execute("call", { path: file }, undefined, undefined, {} as never));
  for (const file of ["ok.txt", path.join(skills, "ok.txt")]) assert.match(JSON.stringify(await reader.execute("call", { path: file }, undefined, undefined, {} as never)), /approved/);
});

test("A-16 timeout ends the turn and the next queued request still completes", async t => {
  const a = await fixture(t, { limits: { turnMs: 20, maxToolCalls: 32 }, fauxTokensPerSecond: 100 });
  const id = create(a, "timeout");
  a.faux!.setResponses([fauxAssistantMessage("long response that must be interrupted"), fauxAssistantMessage("")]);
  await a.service.sendMessage("local-owner", id, input("slow"));
  await a.service.sendMessage("local-owner", id, input("next"));
  await done(a, id);
  assert.match(snap(a, id).messages.items.filter(message => message.role === "system_notice").map(message => message.text).join(" "), /时间上限/);
  assert.equal((a.database.prepare("SELECT state FROM requests WHERE conversation_id=? ORDER BY queue_seq DESC LIMIT 1").get(id) as { state: string }).state, "completed");
});

test("A-16 the 33rd tool cannot execute; no retry or automatic next turn", async t => {
  const a = await fixture(t), id = create(a, "tool limit");
  a.faux!.setResponses([fauxAssistantMessage(Array.from({ length: 33 }, (_, i) => fauxToolCall("read_skill_file", { path: "travel-prompt-kit/SKILL.md" }, { id: `call-${i}` })))]);
  await a.service.sendMessage("local-owner", id, input("many tools")); await done(a, id);
  const handle = await a.host.openConversationSession(id, "s1", undefined, [], await a.host.modelForBinding(a.service.bootstrap("local-owner").models[0]!.binding));
  try {
    const results = handle.session.messages.filter(message => message.role === "toolResult" && !message.isError);
    assert.equal(results.length, 32);
    assert.match(snap(a, id).messages.items.filter(message => message.role === "system_notice").map(message => message.text).join(" "), /工具调用上限/);
    assert.equal((a.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE conversation_id=?").get(id) as { n: number }).n, 1);
  } finally { handle.session.dispose(); }
});

test("A-25 busy/readonly SQLite has no successful receipt or event fallback", async t => {
  const Database = (await import("better-sqlite3")).default;
  const a = await fixture(t);
  const file = a.database.name;
  const blocker = new Database(file); t.after(() => blocker.close());
  a.database.pragma("busy_timeout=20"); blocker.exec("BEGIN IMMEDIATE");
  const payload = { commandId: "cmd-busy", title: "busy" };
  const headers = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
  let result = await a.app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers, payload });
  assert.equal(result.statusCode, 503); assert.equal(result.json().code, "TEMPORARILY_UNAVAILABLE");
  blocker.exec("ROLLBACK");
  a.database.pragma("query_only=ON");
  result = await a.app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers, payload });
  assert.equal(result.statusCode, 503);
  a.database.pragma("query_only=OFF");
  assert.equal((a.database.prepare("SELECT COUNT(*) AS n FROM command_receipts").get() as { n: number }).n, 0);
  assert.equal((a.database.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  result = await a.app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers, payload });
  assert.equal(result.statusCode, 201);
});

test("A-06/30 stored feedback enters the next bound prompt, compact does not replace business revisions", async t => {
  // 压缩已启用 SDK 默认保留值；本用例注入小保留窗口让这个短会话可被压缩。
  const a = await fixture(t, { compaction: { reserveTokens: 1024, keepRecentTokens: 512 } }), id = create(a, "feedback context");
  a.faux!.setResponses([deliver("original"), fauxAssistantMessage("Earlier discussion of the creative goal. ".repeat(200))]);
  await a.service.sendMessage("local-owner", id, input("produce")); await done(a, id);
  const art = snap(a, id).artifacts.items[0]!;
  const target = { artifactId: art.id, revisionId: art.revisionId, workId: null };
  a.service.addFeedback("local-owner", id, { commandId: "cmd-feedback", target, text: "unique-feedback-no-voice" });
  let received = "";
  a.faux!.setResponses([ctx => { received = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage("discussed"); }]);
  await a.service.sendMessage("local-owner", id, input("请讨论刚才的意见", { target })); await done(a, id);
  assert.match(received, /unique-feedback-no-voice/);
  const original = a.service.readRevision("local-owner", art.id, art.revisionId);
  const handle = await a.host.openConversationSession(id, "s1", undefined, [], await a.host.modelForBinding(a.service.bootstrap("local-owner").models[0]!.binding));
  try {
    a.faux!.setResponses([fauxAssistantMessage("Summary of prior conversation; business artifact identifiers retained in database.")]);
    const compacted = await handle.session.compact("Preserve goals and artifact IDs.");
    assert.ok(compacted.summary.length > 0);
    assert.deepEqual(a.service.readRevision("local-owner", art.id, art.revisionId), original);
  } finally { handle.session.dispose(); }
});

test("A-09/22/37 proposals validate graph/full model binding; expiry can be prepared again; references stay in their conversation", async t => {
  let now = Date.now();
  const a = await fixture(t, { clock: () => new Date(now).toISOString() }), id = create(a, "proposal");
  a.faux!.setResponses([deliver("source"), fauxAssistantMessage("done")]);
  await a.service.sendMessage("local-owner", id, input("source")); await done(a, id);
  const head = snap(a, id).artifacts.items[0]!;
  const revision = a.service.readRevision("local-owner", head.id, head.revisionId);
  const { OFFLINE_QUOTE_CATALOG } = await import("../src/server/agent/offline.js");
  const spec: ProductionIntent = { workId: null, title: "voice", inputRevisions: [{ artifactId: head.id, revisionId: head.revisionId }],
    operations: [{ operationId: "voice", outputSlot: "audio", inputs: [{ kind: "artifact_revision" as const, artifactId: head.id, revisionId: head.revisionId, digest: revision.digest }], maxCreateAttempts: 2, kind: "speech" as const, model: OFFLINE_QUOTE_CATALOG["speech:faux-speech"].binding, parameters: { voiceId: "voice", format: "mp3" as const } }],
    finalOutput: { operationId: "voice", outputSlot: "audio" }, maxSpend: { currency: "CNY" as const, amountMinor: 500 } };
  const prepare = async (value = spec) => (await a.service.prepareProposal("local-owner", id, { commandId: `cmd-${crypto.randomUUID()}`, spec: value })).proposal;
  const initial = await prepare(); assert.equal(initial.spec.operations[0]!.maxCreateAttempts, 2);
  now += 31 * 60000; a.service.sweepProposals();
  assert.equal(a.service.readProposal("local-owner", initial.id).state, "expired");
  const renewed = await prepare(); assert.notEqual(initial.id, renewed.id); assert.equal(renewed.state, "ready");
  await assert.rejects(() => prepare({ ...spec, finalOutput: { operationId: "missing", outputSlot: "audio" } }));
  await assert.rejects(() => prepare({ ...spec, operations: [{ ...spec.operations[0]!, kind: "speech", parameters: { voiceId: "voice", format: "mp3" }, model: { ...OFFLINE_QUOTE_CATALOG["speech:faux-speech"].binding, connectionId: "unrelated" } }] }));
  await assert.rejects(() => prepare({ ...spec, operations: [{ ...spec.operations[0]!, inputs: [{ kind: "artifact_revision", artifactId: head.id, revisionId: head.revisionId, digest: "0".repeat(64) }] }] }));
  const other = create(a, "other");
  assert.throws(() => a.service.sendMessage("local-owner", other, input("discuss", { proposalRef: { proposalId: renewed.id, digest: renewed.digest } })), (error: any) => error.code === "NOT_FOUND");
  let received = "";
  a.faux!.setResponses([ctx => { received = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage("discussion only"); }]);
  await a.service.sendMessage("local-owner", id, input("只讨论这个提案，不开始", { proposalRef: { proposalId: renewed.id, digest: renewed.digest } })); await done(a, id);
  assert.match(received, new RegExp(renewed.id)); assert.match(received, /referencedProposals/);
});

test("A-23/38 Studio cookie, maintenance and live SSE auth loss use the real entry guards", async t => {
  const { buildFrameApp } = await import("../src/server/agent/app.js");
  const { StudioAuthenticator, createPasswordHash } = await import("../src/server/auth.js");
  const { validatorFor } = await import("../src/server/agent/validate.js");
  const { MaintenanceGate } = await import("../src/server/maintenance-gate.js");
  const { transitionMaintenanceGate } = await import("@video-factory/production-pipeline/maintenance");
  const a = await fixture(t); let now = Date.now();
  for (const method of ["GET", "POST"] as const) {
    const remote = await a.app.inject({ method, url: method === "GET" ? "/api/agent/v1/bootstrap" : "/api/agent/v1/conversations",
      remoteAddress: "203.0.113.10", headers: { origin, "content-type": "application/json", "x-video-factory-request": "studio" },
      ...(method === "POST" ? { payload: { commandId: "cmd-remote", title: "must not create" } } : {}) });
    assert.equal(remote.statusCode, 403, "无认证本地模式拒绝非环回来源");
    assert.equal(validatorFor("Error")(remote.json()).ok, true);
  }
  const gateDir = await mkdtemp(path.join(tmpdir(), "frame-gate-")); t.after(() => rm(gateDir, { recursive: true, force: true }));
  await transitionMaintenanceGate(gateDir, "open", "test");
  const gate = new MaintenanceGate({ directory: gateDir }); await gate.announceStartup();
  const auth = { username: "cookie-owner", passwordHash: createPasswordHash("test-only", Buffer.from("frame-audit-test-salt")), sessionSecret: "frame-audit-test-session-secret-32-characters", secureCookie: false, sessionTtlSeconds: 1, now: () => now };
  const cookie = new StudioAuthenticator(auth).createSessionCookie();
  const app = buildFrameApp({ auth, maintenanceGate: gate,
    agent: { service: a.service, resolveOwner: () => "must-not-bypass-cookie", uiOrigin: origin } });
  t.after(() => app.close());
  const headers = { cookie, origin, "content-type": "application/json", "x-video-factory-request": "studio" };
  for (const sentCookie of [undefined, "vf_session=forged"]) {
    const response = await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap", headers: sentCookie ? { cookie: sentCookie } : {} });
    assert.equal(response.statusCode, 401); assert.equal(validatorFor("Error")(response.json()).ok, true);
  }
  const bootstrap = await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap", headers });
  assert.equal(bootstrap.json().ownerId, "cookie-owner");
  assert.equal((await app.inject({ method: "GET", url: "/api/providers", headers })).statusCode, 404, "Pi 入口不注册旧业务 API");
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().runtime, "pi");
  const created = await app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers, payload: { commandId: "cmd-cookie", title: "cookie" } });
  assert.equal(created.statusCode, 201);
  await transitionMaintenanceGate(gateDir, "draining", "test");
  const denied = await app.inject({ method: "POST", url: "/api/agent/v1/conversations", headers, payload: { commandId: "cmd-maintenance", title: "denied" } });
  assert.equal(denied.statusCode, 503); assert.equal(validatorFor("Error")(denied.json()).ok, true);
  const id = created.json().id;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  const cursor = a.service.snapshot("cookie-owner", id).eventCursor;
  const stream = await fetch(`http://127.0.0.1:${address.port}/api/agent/v1/conversations/${id}/events?cursor=${encodeURIComponent(cursor)}`, { headers: { cookie } });
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type")!, /event-stream/);
  const reader = stream.body!.getReader(); await reader.read();
  now += 1100; a.service.hub().notifyCommitted(id);
  assert.equal((await reader.read()).done, true);
  const expired = await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap", headers }); assert.equal(expired.statusCode, 401);
});

test("A-14 steer losing its streaming window is persisted as failed and cannot enter the next turn", async t => {
  const a = await fixture(t, { fauxTokensPerSecond: 100 }), id = create(a, "steer race");
  const open = a.host.openConversationSession.bind(a.host);
  let session: Awaited<ReturnType<typeof open>>["session"] | undefined;
  t.mock.method(a.host, "openConversationSession", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args); session = handle.session; return handle;
  });
  a.faux!.setResponses([fauxAssistantMessage("A long answer for the stream race. ".repeat(8))]);
  const { receipt } = await a.service.sendMessage("local-owner", id, input("initial"));
  await waitFor(() => Boolean(session?.isStreaming));
  const originalSteer = session!.steer.bind(session!);
  t.mock.method(session!, "steer", async (text: string) => { await session!.abort(); return originalSteer(text); });
  await assert.rejects(async () => a.service.sendMessage("local-owner", id, input("must-not-leak", { mode: "steer", steerRequestId: receipt.requestId })), (error: any) => error.code === "REQUEST_NOT_RUNNING");
  await done(a, id);
  const rejected = snap(a, id).messages.items.find(message => message.text === "must-not-leak");
  assert.equal(rejected?.state, "failed");
  let nextContext = "";
  a.faux!.setResponses([ctx => { nextContext = JSON.stringify(ctx.messages); return fauxAssistantMessage("next"); }]);
  await a.service.sendMessage("local-owner", id, input("new topic")); await done(a, id);
  assert.doesNotMatch(nextContext, /must-not-leak/);
});

test("A-29 missing safe Pi checkpoint fails honestly without regenerating committed output", async t => {
  const a = await fixture(t), id = create(a, "checkpoint");
  a.database.prepare("UPDATE conversations SET pi_needs_recovery=1, pi_checkpoint_json=NULL WHERE id=?").run(id);
  let calls = 0;
  a.faux!.setResponses([() => { calls++; return deliver("must not happen"); }]);
  await a.service.sendMessage("local-owner", id, input("continue")); await done(a, id);
  assert.equal(calls, 0); assert.equal(snap(a, id).artifacts.items.length, 0);
  assert.ok(snap(a, id).messages.items.some(message => message.role === "user" && message.state === "failed"));
});

test("A-08 unconfigured production assembly never substitutes Faux or accepts a request", async t => {
  const { createAgentRuntime } = await import("../src/server/agent/assembly.js");
  const { defaultSkillsRoot } = await import("../src/server/agent/offline.js");
  const directory = await mkdtemp(path.join(tmpdir(), "frame-no-model-"));
  const runtime = await createAgentRuntime({ dataDir: directory, skillsRoot: defaultSkillsRoot, host: {}, models: [], defaultModelId: "unconfigured", catalog: () => ({}) });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const id = runtime.service.createConversation("owner", { commandId: "cmd-no-model", title: "discussion" }).conversation.id;
  assert.equal(runtime.host.faux, null);
  assert.deepEqual(runtime.service.bootstrap("owner").models, []);
  assert.throws(() => runtime.service.sendMessage("owner", id, input("hi")), (error: any) => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n, 0);
});

test("K4 退役供应商与旧审计的配置入口不能从现行入口复活", async t => {
  const a = await fixture(t);
  const headers = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
  // 旧工作台的供应商/模型/配音/本地能力/设置写入口已随旧服务链删除；现行入口对它们只能 404，
  // 不存在兜底恢复或旧目录默认。GET/写方法都核，防止只删了读路由。
  const legacyRoutes = ["/api/providers", "/api/models", "/api/voices", "/api/settings",
    "/api/local-capabilities", "/api/background-music", "/api/reference-videos"];
  for (const url of legacyRoutes) {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      const response = await a.app.inject({ method, url, headers, ...(method === "GET" ? {} : { payload: {} }) });
      assert.equal(response.statusCode, 404, `${method} ${url} 不应存在`);
    }
  }
  // 正对照：现行统一配置面仍可读（文本连接与导入配置；Ark 视频设置由真实装配的专项测试覆盖，
  // 离线装配不含媒体工厂，这里不断言它）。
  for (const url of ["/api/agent/v1/settings/model-connections", "/api/agent/v1/settings/imported"]) {
    const response = await a.app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 200, `${url} 应保持可读`);
  }
});
