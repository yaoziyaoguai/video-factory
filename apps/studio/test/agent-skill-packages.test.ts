import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot, OFFLINE_QUOTE_CATALOG, studioRoot } from "../src/server/agent/offline.js";
import { systemClock } from "../src/server/agent/util.js";
import { bindPreparedPlan, seedPlanStageWork } from "./helpers/creative-work-fixture.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { SkillPackages } from "../src/server/agent/skill-packages.js";
import type { SettingsManager, DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { FauxMediaPort } from "../src/server/agent/faux-media.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const command = (text: string, skillId: string | null = null) => ({ commandId: `cmd-${crypto.randomUUID()}`, text, skillId, target: null, proposalRef: null, mode: "new" as const, steerRequestId: null });
function options(dataDir: string) {
  return { dataDir, skillsRoot: defaultSkillsRoot, host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" }, name: "Faux", kind: "text" as const, features: [], availability: "configured" as const, verificationNote: "本地替身", isDefault: true }], defaultModelId: FAUX_TEXT_MODEL };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "frame-skills-"));
  const runtime = await createAgentRuntime(options(path.join(root, "data")));
  t.after(async () => { if (runtime.database.open) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source");
  for (const name of ["local-alpha", "local-beta"]) {
    const directory = path.join(source, "skills", name);
    await mkdir(path.join(directory, "references"), { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 本机测试\n---\n${name} skill body`);
    await writeFile(path.join(directory, "references", "notes.md"), `${name} reference notes`);
  }
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "two-local-skills", pi: { skills: ["./skills"], extensions: ["./extension.mjs"], prompts: ["./prompts"], themes: ["./themes"] } }));
  await writeFile(path.join(source, "extension.mjs"), 'throw new Error("package extension must not load");');
  const app = buildFrameApp({ agent: { service: runtime.service, resolveOwner: () => "local-owner", uiOrigin: "http://frame.test", localOwnerOnly: true } });
  t.after(() => app.close());
  const request = async (method: "GET" | "POST", endpoint: string, payload?: Record<string, unknown>) => app.inject({ method, url: `/api/agent/v1${endpoint}`,
    headers: method === "GET" ? {} : { origin: "http://frame.test", "content-type": "application/json", "x-video-factory-request": "studio" },
    ...(payload === undefined ? {} : { payload }) });
  const conversation = runtime.service.createConversation("local-owner", { commandId: "create", title: "原有会话" }).conversation.id;
  return { root, source, runtime, request, conversation };
}
async function chat(runtime: AgentRuntime, id: string, text: string, skillId: string | null = null) {
  const result = await runtime.service.sendMessage("local-owner", id, command(text, skillId));
  for (let n = 0; n < 1000 && runtime.service.snapshot("local-owner", id).activeRequestId; n++) await sleep(10);
  assert.equal(runtime.service.snapshot("local-owner", id).activeRequestId, null);
  assert.equal((runtime.database.prepare("SELECT state FROM requests WHERE id=?").get(result.receipt.requestId) as { state: string }).state, "completed", "Faux断言或工具链失败不能当成回合通过");
  return result.receipt.requestId;
}

test("S1/S2/S4/S7 native 本地包、合同和原会话即时生效；同包卸载保留历史与源文件", async t => {
  const { root, source, runtime, request, conversation } = await fixture(t);
  runtime.host.faux!.setResponses([fauxAssistantMessage("初始聊天")]);
  await chat(runtime, conversation, "先聊一条");
  const session = runtime.registry.for(conversation).session!;
  const leaf = session.sessionManager.getLeafId();
  const guard = session.agent.beforeToolCall;
  const tools = session.getActiveToolNames();
  const read = await request("GET", "/settings/skills");
  assert.equal(read.statusCode, 200); assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(validatorFor("SkillPackagesView")(read.json()).ok, true);
  const installed = await request("POST", "/settings/skills/install", { source });
  assert.equal(installed.statusCode, 200, installed.body);
  assert.equal(validatorFor("SkillPackagesView")(installed.json()).ok, true);
  assert.deepEqual(runtime.service.bootstrap("local-owner").skills, installed.json().skills);
  const pkg = installed.json().packages.find((entry: { origin: string }) => entry.origin === "installed");
  assert.equal(pkg.name, "two-local-skills"); assert.deepEqual(pkg.skillIds, ["local-alpha", "local-beta"]); assert.equal(pkg.status, "ready");
  assert.equal(runtime.registry.for(conversation).session, session);
  assert.equal(session.sessionManager.getLeafId(), leaf);
  assert.equal(session.agent.beforeToolCall, guard, "reload 保留严格参数 guard，无重复包裹");
  assert.deepEqual(session.getActiveToolNames(), tools);
  assert.ok(!tools.includes("bash") && !tools.includes("write"));
  const reference = path.join(source, "skills/local-alpha/references/notes.md");
  let seen: TranscriptContext | undefined;
  runtime.host.faux!.setResponses([ctx => { seen = ctx; return fauxAssistantMessage([fauxToolCall("read_skill_file", { path: reference })]); }, ctx => {
    assert.match(JSON.stringify(ctx.messages), /local-alpha reference notes/); return fauxAssistantMessage("自然选择完成");
  }]);
  await chat(runtime, conversation, "自然读取新 skill 的参考");
  assert.match(JSON.stringify(seen), /local-alpha/);
  runtime.host.faux!.setResponses([ctx => {
    const input = ctx.messages.at(-2)!;
    const text = typeof input.content === "string" ? input.content : input.content.filter(block => block.type === "text").map(block => block.text).join("");
    assert.match(text, /<skill name="local-alpha"/); return fauxAssistantMessage("显式展开完成");
  }]);
  await chat(runtime, conversation, "按指定 Skill 回答", "local-alpha");
  const again = await request("POST", "/settings/skills/install", { source });
  assert.equal(again.statusCode, 200); assert.equal(again.json().packages.length, 2, "相同来源只回读不重复安装");
  const alias = path.join(root, "source-alias"); await symlink(source, alias);
  const aliased = await request("POST", "/settings/skills/install", { source: alias });
  assert.equal(aliased.statusCode, 200); assert.equal(aliased.json().packages.length, 2, "同一真实根的别名不重复登记");
  const removed = await request("POST", "/settings/skills/remove", { packageId: pkg.id });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().skills.some((s: { id: string }) => s.id === "local-alpha"), false);
  await assert.rejects(async () => runtime.service.sendMessage("local-owner", conversation, command("失效技能", "local-alpha")), /未安装这个技能/);
  runtime.host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("read_skill_file", { path: reference })]), ctx => {
    const result = ctx.messages.at(-2); assert.equal(result?.role, "toolResult");
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /FORBIDDEN/); return fauxAssistantMessage("卸载后拒绝读取");
  }]);
  await chat(runtime, conversation, "不能再读取卸载包");
  assert.match(await readFile(reference, "utf8"), /reference notes/);
  assert.ok(runtime.service.snapshot("local-owner", conversation).messages.items.some(message => message.text === "初始聊天"));
  await runtime.close();
  const restarted = await createAgentRuntime(options(path.join(root, "data")));
  try { assert.equal((await restarted.service.readSkillPackages()).packages.length, 1); }
  finally { await restarted.close(); }
});

test("S1/S6 原生包配置重启保留，GET不隐式安装；无效、零技能、碰撞与读取逃逸如实呈现", async t => {
  const { root, source, runtime, request, conversation } = await fixture(t);
  const first = await request("POST", "/settings/skills/install", { source }); assert.equal(first.statusCode, 200);
  const restarted = await createAgentRuntime(options(path.join(root, "data")));
  try { assert.ok(restarted.service.bootstrap("local-owner").skills.some(skill => skill.id === "local-alpha")); }
  finally { await restarted.close(); }
  const empty = path.join(root, "empty"); await mkdir(empty); await writeFile(path.join(empty, "package.json"), '{"name":"empty","pi":{"skills":[]}}');
  const result = await request("POST", "/settings/skills/install", { source: empty });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().packages.find((entry: { name: string }) => entry.name === "empty").status, "no_skills");
  const collision = path.join(root, "collision"); await mkdir(path.join(collision, "skills/travel-prompt-kit"), { recursive: true });
  await writeFile(path.join(collision, "package.json"), '{"name":"collision","pi":{"skills":["./skills"]}}');
  await writeFile(path.join(collision, "skills/travel-prompt-kit/SKILL.md"), '---\nname: travel-prompt-kit\ndescription: 不应覆盖内置\n---\ncollision body');
  const conflict = await request("POST", "/settings/skills/install", { source: collision });
  const bad = conflict.json().packages.find((entry: { name: string }) => entry.name === "collision");
  assert.equal(bad.status, "invalid"); assert.ok(bad.diagnostics.some((note: string) => note.includes("collision")));
  const badNames = path.join(root, "bad-names");
  await mkdir(path.join(badNames, "skills/bad"), { recursive: true });
  await writeFile(path.join(badNames, "package.json"), '{"name":"bad-names","pi":{"skills":["./skills"]}}');
  await writeFile(path.join(badNames, "skills/bad/SKILL.md"), '---\nname: a b\ndescription: 原生警告但无法指定\n---\nbody');
  const names = await request("POST", "/settings/skills/install", { source: badNames });
  assert.equal(names.json().packages.find((entry: { name: string }) => entry.name === "bad-names").status, "invalid");
  assert.equal(validatorFor("SkillPackagesView")(names.json()).ok, true);
  const invalid = path.join(root, "invalid"); await mkdir(invalid); await writeFile(path.join(invalid, "package.json"), '{broken');
  const broken = await request("POST", "/settings/skills/install", { source: invalid });
  assert.equal(broken.json().packages.find((entry: { source: string }) => entry.source.includes("invalid")).status, "invalid");
  const secret = path.join(root, "outside.md"); await writeFile(secret, "not-a-skill");
  const escape = path.join(source, "skills/local-alpha/references/outside.md");
  await symlink(secret, escape);
  runtime.host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("read_skill_file", { path: escape })]), ctx => {
    const tool = ctx.messages.at(-2); assert.ok(tool?.role === "toolResult" && tool.isError); assert.match(JSON.stringify(tool), /FORBIDDEN/);
    return fauxAssistantMessage("已拒绝越界读取");
  }]);
  await chat(runtime, conversation, "引用文件不能越出 Skill");
  assert.equal((await request("POST", "/settings/skills/remove", { packageId: "builtin-skills" })).statusCode, 403);
  assert.equal((await request("POST", "/settings/skills/remove", { packageId: "not-installed" })).statusCode, 404);
  for (const payload of [{ source: "" }, { source: "x", extra: true }, { source: "https://user:password@host.test/repo" }]) {
    const response = await request("POST", "/settings/skills/install", payload);
    assert.equal(response.statusCode, 400); assert.equal(response.body.includes("password"), false);
  }
});

test("S5 queued/running 阻止管理；管理中消息不入队，连续 reload 后 hooks 和订阅保持", async t => {
  const { runtime, source, request, conversation } = await fixture(t);
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  runtime.host.faux!.setResponses([async () => { start(); await blocked; return fauxAssistantMessage("运行结束"); }]);
  await runtime.service.sendMessage("local-owner", conversation, command("正在运行")); await started;
  const busy = await request("POST", "/settings/skills/install", { source });
  assert.equal(busy.statusCode, 409); assert.equal(busy.json().code, "RUN_BUSY"); assert.equal(busy.json().retryAction, "wait");
  release();
  for (let n = 0; n < 1000 && runtime.service.snapshot("local-owner", conversation).activeRequestId; n++) await sleep(10);
  const kick = t.mock.method(runtime.registry, "kick", () => {});
  const queued = await runtime.service.sendMessage("local-owner", conversation, command("保持排队"));
  assert.equal(queued.receipt.state, "queued");
  assert.equal((await request("POST", "/settings/skills/install", { source })).statusCode, 409);
  runtime.service.stopRequest("local-owner", queued.receipt.requestId!, { commandId: "stop-queued" });
  kick.mock.restore();
  const native = runtime.registry.for(conversation).session!;
  const originalReload = native.reload.bind(native);
  let finish!: () => void;
  let reloadStarted!: () => void;
  const reloading = new Promise<void>(resolve => { reloadStarted = resolve; });
  const resume = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(native, "reload", async () => { reloadStarted(); await resume; await originalReload(); });
  const pending = request("POST", "/settings/skills/install", { source }); await reloading;
  assert.equal((await runtime.service.readSkillPackages()).mutation?.action, "install");
  const before = runtime.database.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number };
  await assert.rejects(async () => runtime.service.sendMessage("local-owner", conversation, command("管理期间的草稿")), /正在管理或读取 Skill/);
  assert.deepEqual(runtime.database.prepare("SELECT COUNT(*) AS n FROM requests").get(), before);
  assert.equal((await request("POST", "/settings/skills/install", { source })).statusCode, 409);
  finish(); assert.equal((await pending).statusCode, 200);
  const installedPackage = (await runtime.service.readSkillPackages()).packages.find(pkg => pkg.origin === "installed")!;
  assert.equal((await request("POST", "/settings/skills/remove", { packageId: installedPackage.id })).statusCode, 200);
  assert.equal((await request("POST", "/settings/skills/install", { source })).statusCode, 200);
  const second = runtime.service.createConversation("local-owner", { commandId: "second", title: "另一个空闲会话" }).conversation.id;
  runtime.host.faux!.setResponses([fauxAssistantMessage("第二会话已打开")]); await chat(runtime, second, "打开第二会话");
  const secondSession = runtime.registry.for(second).session!;
  const secondGuard = secondSession.agent.beforeToolCall;
  assert.equal((await request("POST", "/settings/skills/remove", { packageId: installedPackage.id })).statusCode, 200);
  assert.equal((await request("POST", "/settings/skills/install", { source })).statusCode, 200);
  assert.equal(runtime.registry.for(second).session, secondSession);
  assert.equal(secondSession.agent.beforeToolCall, secondGuard);
  const deltas: unknown[] = []; const unsub = runtime.service.hub().subscribeDeltas(conversation, delta => deltas.push(delta));
  t.after(unsub);
  runtime.host.faux!.setResponses([ctx => {
    assert.equal((JSON.stringify(ctx.messages).match(/\[frame-current-state\]/g) ?? []).length, 1); return fauxAssistantMessage("管理后继续聊天");
  }]);
  await chat(runtime, conversation, "目录已经更新");
  assert.ok(deltas.length);
  runtime.host.faux!.setResponses([ctx => {
    assert.equal((JSON.stringify(ctx.messages).match(/\[frame-current-state\]/g) ?? []).length, 1);
    assert.match(JSON.stringify(ctx.messages.at(-1)), new RegExp(second)); return fauxAssistantMessage("第二会话状态独立");
  }]);
  await chat(runtime, second, "第二会话再次运行", "local-beta");
});

test("S5 已确认后台媒体运行不阻塞 Skill 管理", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "frame-skill-media-"));
  const runtime = await createAgentRuntime({ ...options(root), media: { autoStart: false, factory: (db, blobs) => ({
    port: new FauxMediaPort(root, db, blobs, () => new Date().toISOString(), { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 2000 }),
    catalog: () => OFFLINE_QUOTE_CATALOG, models: () => [],
  }) } });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const id = runtime.service.createConversation("local-owner", { commandId: "create", title: "后台制作" }).conversation.id;
  // B04：视频提案须落在已进入方案阶段的事项内，受理另需方案主稿关联。
  const planWork = seedPlanStageWork(runtime.database, systemClock(), { ownerId: "local-owner", conversationId: id }, "后台制作");
  const { proposal } = await runtime.service.prepareProposal("local-owner", id, { commandId: "prepare", spec: {
    workId: planWork.workId, title: "模拟媒体", inputRevisions: [], operations: [{ operationId: "video", outputSlot: "clip", kind: "video",
      model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding, inputs: [{ kind: "text", text: "模拟镜头" }], maxCreateAttempts: 1,
      parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "video", outputSlot: "clip" }, maxSpend: { currency: "CNY", amountMinor: 1200 },
  } });
  bindPreparedPlan(runtime.database, systemClock(), { ownerId: "local-owner", conversationId: id }, proposal, planWork);
  const { run } = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: "confirm", proposalDigest: proposal.digest });
  assert.equal(run.state, "queued");
  const source = path.join(root, "empty"); await mkdir(source); await writeFile(path.join(source, "package.json"), '{"name":"empty","pi":{"skills":[]}}');
  assert.equal((await runtime.service.installSkillPackage({ source })).packages.some(pkg => pkg.name === "empty"), true);
  assert.equal((runtime.database.prepare("SELECT state FROM production_runs WHERE id=?").get(run.id) as { state: string }).state, "queued");
});

test("S6 reload实际失败清空handle与loader，下一请求同会话重新打开并恢复事件", async t => {
  const { runtime, source, request, conversation } = await fixture(t);
  runtime.host.faux!.setResponses([fauxAssistantMessage("建立旧会话")]); await chat(runtime, conversation, "旧会话");
  const old = runtime.registry.for(conversation).session!;
  t.mock.method(old, "reload", async () => { throw new Error("fixture-reload-failed"); });
  const install = await request("POST", "/settings/skills/install", { source });
  assert.equal(install.statusCode, 503); assert.equal(install.json().retryAction, "reload");
  assert.equal(runtime.registry.for(conversation).session, null);
  assert.ok((await request("GET", "/settings/skills")).json().skills.some((skill: { id: string }) => skill.id === "local-alpha"));
  const changes: unknown[] = []; const unsub = runtime.service.hub().subscribeDeltas(conversation, value => changes.push(value)); t.after(unsub);
  runtime.host.faux!.setResponses([ctx => { assert.match(JSON.stringify(ctx.messages), /建立旧会话/); return fauxAssistantMessage("恢复后的新事件"); }]);
  await chat(runtime, conversation, "同会话下一轮", "local-beta");
  assert.notEqual(runtime.registry.for(conversation).session, old); assert.ok(changes.length);
  assert.equal((runtime.database.prepare("SELECT pi_session_id AS id FROM conversations WHERE id=?").get(conversation) as { id: string }).id, "s1");
});

test("S6 目录刷新失败后 GET 可重读、请求不借旧目录；卸载不依赖失效 catalog", async t => {
  const { source, runtime, request, conversation } = await fixture(t);
  const refresh = SkillPackages.prototype.refresh;
  let failNext = true;
  t.mock.method(SkillPackages.prototype, "refresh", async function (this: SkillPackages) {
    if (failNext) { failNext = false; throw new Error("fixture-directory-failure"); }
    return refresh.call(this);
  });
  const failed = await request("POST", "/settings/skills/install", { source });
  assert.equal(failed.statusCode, 503);
  await assert.rejects(async () => runtime.service.sendMessage("local-owner", conversation, command("不能借旧目录")), /Skill 目录读取未完成/);
  const confirmed = await request("GET", "/settings/skills");
  assert.equal(confirmed.statusCode, 200);
  const pkg = confirmed.json().packages.find((item: { origin: string }) => item.origin === "installed");
  runtime.host.faux!.setResponses([fauxAssistantMessage("重读后可用")]); await chat(runtime, conversation, "目录恢复", "local-alpha");
  // 再现一次目录失败，仍可按已有配置身份卸载；不会被资源 catalog 的失效状态锁死。
  failNext = true;
  assert.equal((await request("POST", "/settings/skills/install", { source })).statusCode, 503);
  assert.equal((await request("POST", "/settings/skills/remove", { packageId: pkg.id })).statusCode, 200);
});

test("S3/S6 包发布过滤宿主自动发现和全局 npm 回退；缺源只诊断不自动安装", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "frame-skills-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = new SkillPackages(path.join(root, "app"), defaultSkillsRoot);
  await skills.initialize();
  const automatic = path.join(skills.directory, ".agents/skills/personal-leak");
  await mkdir(automatic, { recursive: true });
  await writeFile(path.join(automatic, "SKILL.md"), "---\nname: personal-leak\ndescription: 不应进入应用\n---\nprivate");
  const outside = path.join(root, "global-package"); await mkdir(path.join(outside, "skills/global-leak"), { recursive: true });
  await writeFile(path.join(outside, "package.json"), '{"name":"global-package","version":"1.0.0","pi":{"skills":["./skills"]}}');
  await writeFile(path.join(outside, "skills/global-leak/SKILL.md"), "---\nname: global-leak\ndescription: 不应进入应用\n---\nglobal");
  skills.settings.setPackages([{ source: "npm:global-package@1.0.0", extensions: [], prompts: [], themes: [] }, { source: "npm:missing-native-fixture@1.0.0", extensions: [], prompts: [], themes: [] }]);
  await skills.settings.flush();
  const nativePaths = await skills.manager.resolve(async () => "skip");
  assert.ok(nativePaths.skills.some(resource => resource.metadata.origin === "top-level" && resource.path.includes("personal-leak")), "原生自动发现确实会返回宿主目录，本应用不能全量发布");
  const originalPath = skills.manager.getInstalledPath.bind(skills.manager);
  t.mock.method(skills.manager, "getInstalledPath", (source: string, scope: "user" | "project") => source.startsWith("npm:global-package") ? outside : originalPath(source, scope));
  let missingCount = 0;
  t.mock.method(skills.manager, "resolve", async (onMissing: Parameters<DefaultPackageManager["resolve"]>[0]) => {
    assert.equal(await onMissing!("npm:missing-native-fixture@1.0.0"), "skip"); missingCount++;
    return { extensions: [], prompts: [], themes: [], skills: [
      { path: path.join(automatic, "SKILL.md"), enabled: true, metadata: { source: "auto", scope: "project", origin: "top-level" } },
      { path: path.join(outside, "skills/global-leak/SKILL.md"), enabled: true, metadata: { source: "npm:global-package@1.0.0", scope: "user", origin: "package", packageRoot: outside } },
    ] };
  });
  const view = await skills.refresh();
  assert.equal(view.skills.some(skill => ["personal-leak", "global-leak"].includes(skill.id)), false);
  assert.equal(view.packages.find(pkg => pkg.source.startsWith("npm:global-package"))!.status, "invalid");
  assert.equal(view.packages.find(pkg => pkg.source.startsWith("npm:missing-native-fixture"))!.status, "invalid");
  assert.equal(missingCount, 1);
  assert.equal(validatorFor("SkillPackagesView")(view).ok, true);
});

test("S6 native 持久化错误回读实际配置；无效源和缺源不冒充安装成功", async t => {
  const { root, source, runtime, request, conversation } = await fixture(t);
  const missing = await request("POST", "/settings/skills/install", { source: path.join(root, "missing") });
  assert.equal(missing.statusCode, 503); assert.equal(missing.json().retryAction, "reload");
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const originalErrors = SettingsManager.prototype.drainErrors;
  let injected = false;
  t.mock.method(SettingsManager.prototype, "drainErrors", function (this: SettingsManager) {
    if (!injected) { injected = true; return [{ scope: "global" as const, error: new Error("fixture write failed") }]; }
    return originalErrors.call(this);
  });
  const failed = await request("POST", "/settings/skills/install", { source });
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().retryAction, "reload");
  const current = await request("GET", "/settings/skills");
  assert.equal(current.statusCode, 200); assert.equal(current.json().mutation, null);
  assert.ok(current.json().skills.some((skill: { id: string }) => skill.id === "local-alpha"), "已写入原生配置的事实仍回读，错误不声称回滚");
  runtime.host.faux!.setResponses([fauxAssistantMessage("目录可用")]); await chat(runtime, conversation, "按当前事实运行", "local-alpha");
});
