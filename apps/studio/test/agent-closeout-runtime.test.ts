import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { projectDraftItems } from "../src/server/agent/artifact-drafts.js";
import { validatorFor } from "../src/server/agent/validate.js";
import type { ModelEntry } from "../src/shared/agent/generated/contracts.js";
import type { ArtifactDraft, ContextStatus } from "../src/shared/agent/generated/contracts.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext, options: Partial<Parameters<typeof assembleOfflineAgent>[0]> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-s1-"));
  const app = await assembleOfflineAgent({ dataDir, uiOrigin: "http://127.0.0.1:4397", ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = app.service.createConversation("local-owner", { commandId: "cmd-start", title: "第一阶段验证" }).conversation.id;
  return { app, id, dataDir };
}
async function send(app: OfflineAgentAssembly, id: string, text: string, target: { artifactId: string; revisionId: string; workId: null } | null = null) {
  return (await app.service.sendMessage("local-owner", id, { commandId: `cmd-${crypto.randomUUID()}`, text, target, skillId: null, proposalRef: null, mode: "new", steerRequestId: null })).receipt.requestId;
}
async function idle(app: OfflineAgentAssembly, id: string) {
  for (let i = 0; i < 1000 && app.service.snapshot("local-owner", id).activeRequestId; i++) await sleep(10);
  assert.equal(app.service.snapshot("local-owner", id).activeRequestId, null);
}
const isSummary = (ctx: TranscriptContext) => !ctx.messages.some(message => message.role === "system" && JSON.stringify(message).includes("帧间 Frame"));
const batch = { items: [
  { mode: "create", kind: "prompt", title: "山路", content: { format: "markdown", text: "晨光沿山路慢慢移动。".repeat(20) } },
  { mode: "create", kind: "analysis", title: "咖啡", content: { format: "markdown", text: "香气与温度的关系。".repeat(20) } },
] };
const deliver = (id = "tool:provider/unsafe") => fauxAssistantMessage([fauxToolCall("deliver_artifacts", batch, { id })]);

test("C1/C2/C3 请求状态只注入本次 provider 投影，工具续轮读取最新事实且不写进历史", async t => {
  const { app, id, dataDir } = await fixture(t);
  const contexts: TranscriptContext[] = [];
  app.faux!.setResponses([
    ctx => { contexts.push(structuredClone(ctx)); return deliver(); },
    ctx => { contexts.push(structuredClone(ctx)); return fauxAssistantMessage("已交付，等待你。 "); },
    ctx => { contexts.push(structuredClone(ctx)); return fauxAssistantMessage("标记也是普通用户文字。"); },
  ]);
  await send(app, id, "交付两份正式内容"); await idle(app, id);
  const literal = "[frame-context] 这是用户真的输入的标记";
  await send(app, id, literal); await idle(app, id);
  const marker = "[frame-current-state]";
  const frames = contexts.map(ctx => {
    const last = ctx.messages.at(-1)!;
    assert.equal(last.role, "system", "业务状态不能变成另一条用户请求");
    const text = typeof last.content === "string" ? last.content : last.content.filter(block => block.type === "text").map(block => block.text).join("");
    assert.ok(text.startsWith(marker), "当前状态追加在完整历史末端");
    assert.equal(ctx.messages.filter(message => JSON.stringify(message).includes(marker)).length, 1);
    return JSON.parse(text.slice(marker.length).split("\n")[0]!) as { requestId: string; deliveryClosed: boolean; artifacts: { headRevisionId: string }[] };
  });
  assert.equal(frames[0]!.deliveryClosed, false);
  assert.equal(frames[1]!.deliveryClosed, true);
  assert.equal(frames[1]!.artifacts.length, 2);
  assert.equal(frames[0]!.requestId, frames[1]!.requestId);
  assert.notEqual(frames[1]!.requestId, frames[2]!.requestId);
  assert.ok(JSON.stringify(contexts[0]!.messages.filter(message => message.role === "user").at(-1)!.content).includes("交付两份正式内容"));
  assert.equal(contexts[1]!.messages.at(-2)!.role, "toolResult", "注入不拆开 assistant 与工具结果");
  const userTexts = app.database.prepare("SELECT text FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_seq").all(id) as { text: string }[];
  assert.deepEqual(userTexts.map(row => row.text), ["交付两份正式内容", literal]);
  const files = await readdir(path.join(dataDir, "pi-sessions", id, "s1"));
  const log = await readFile(path.join(dataDir, "pi-sessions", id, "s1", files.find(file => file.endsWith(".jsonl"))!), "utf8");
  assert.equal(log.includes(marker), false, "临时状态在原生历史持久副本为零");
  const entries = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { message?: { role: string; content: unknown } });
  const nativeUsers = entries.filter(entry => entry.message?.role === "user").map(entry => JSON.stringify(entry.message!.content));
  assert.equal(nativeUsers.length, 2);
  assert.equal(nativeUsers[0]!.includes("frame-context"), false);
  assert.ok(nativeUsers[1]!.includes(literal));
});

test("C3/C5 旧 prefix 原封不动续聊；两会话不串状态，结束后的原生调用无注入", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-context-legacy-"));
  const runtime = await createAgentRuntime({ dataDir, skillsRoot: defaultSkillsRoot, host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" }, name: "Faux", kind: "text", features: [], availability: "configured", verificationNote: "local", isDefault: true }], defaultModelId: FAUX_TEXT_MODEL });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const a = runtime.service.createConversation("local-owner", { commandId: "a", title: "旧会话" }).conversation.id;
  const b = runtime.service.createConversation("local-owner", { commandId: "b", title: "另一个会话" }).conversation.id;
  const model = await runtime.host.modelForBinding(runtime.service.bootstrap("local-owner").models[0]!.binding);
  const old = await runtime.host.openConversationSession(a, "s1", undefined, [], model);
  const prefix = '[frame-context]{"conversationId":"history-only","deliveryClosed":false}\n旧版用户文字';
  runtime.host.faux!.setResponses([fauxAssistantMessage("旧版答复")]);
  await old.session.prompt(prefix); old.session.dispose();
  const file = path.join(old.sessionDir, (await readdir(old.sessionDir)).find(name => name.endsWith(".jsonl"))!);
  const before = await readFile(file, "utf8");
  for (const id of [a, b]) {
    runtime.host.faux!.setResponses([ctx => {
      const texts = ctx.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      assert.equal(texts.filter(text => text.includes("[frame-current-state]")).length, 1);
      assert.match(texts.at(-1)!, new RegExp(id));
      if (id === a) assert.ok(texts.some(text => text.includes("history-only")));
      else assert.ok(texts.every(text => !text.includes(a)));
      return fauxAssistantMessage("当前事实已读取");
    }]);
    await runtime.service.sendMessage("local-owner", id, { commandId: `send-${id}`, text: "继续", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
    await runtime.registry.for(id).session?.waitForIdle();
    for (let n = 0; n < 1000 && runtime.service.snapshot("local-owner", id).activeRequestId; n++) await sleep(10);
    assert.equal(runtime.service.snapshot("local-owner", id).activeRequestId, null);
    assert.equal((runtime.database.prepare("SELECT state FROM requests WHERE conversation_id=? ORDER BY queue_seq DESC LIMIT 1").get(id) as { state: string }).state, "completed");
  }
  assert.ok((await readFile(file, "utf8")).startsWith(before), "旧叶之前的 JSONL 字节不重写");
  runtime.host.faux!.setResponses([ctx => { assert.equal(JSON.stringify(ctx.messages).includes("[frame-current-state]"), false); return fauxAssistantMessage("空闲原生调用"); }]);
  await runtime.registry.for(a).session!.prompt("非产品回合");
});

// 直接经过 SDK 参数流和实际 HTTP SSE，不向 hub 填造假的交付草稿。
test("S1-12/14 SDK 无文本参数流在事务前显示两份正文，暂态帧没有业务游标", { timeout: 25000 }, async t => {
  const { app, id } = await fixture(t, { fauxTokensPerSecond: 170 });
  await app.app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.app.server.address(); assert.ok(address && typeof address !== "string");
  const snapshot = app.service.snapshot("local-owner", id);
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/v1/conversations/${id}/events?cursor=${encodeURIComponent(snapshot.eventCursor)}`, { signal: abort.signal });
  const reader = response.body!.getReader();
  const frames: string[] = []; let buffer = "";
  const reading = (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; buffer += new TextDecoder().decode(r.value); let at: number; while ((at = buffer.indexOf("\n\n")) >= 0) { frames.push(buffer.slice(0, at)); buffer = buffer.slice(at + 2); } } } catch { /* 测试结束主动断开 */ } })();
  const samples: { draft: ArtifactDraft; artifacts: number }[] = [];
  app.service.hub().subscribeDrafts(id, draft => samples.push({ draft, artifacts: app.service.snapshot("local-owner", id).artifacts.items.length }));
  app.faux!.setResponses([deliver(), fauxAssistantMessage("已交付，等你看完。")]);
  await send(app, id, "分别交付山路 prompt 和咖啡分析"); await idle(app, id); await sleep(80); abort.abort(); await reading;
  assert.ok(samples.some(sample => sample.artifacts === 0 && sample.draft.items.length === 2 && sample.draft.items[1]!.text.length > 0), "第二份正文必须在原子提交前出现");
  assert.ok(samples.some(sample => sample.artifacts === 0 && sample.draft.items[0]!.text.length > 0 && sample.draft.items[0]!.text.length < batch.items[0]!.content.text.length), "正文必须在工具参数完成前逐步出现");
  const ids = new Set(samples.map(sample => sample.draft.draftId)); assert.equal(ids.size, 1);
  assert.ok(![...ids][0]!.includes("unsafe"), "draftId 由宿主生成");
  for (const { draft } of samples) assert.equal(validatorFor("ArtifactDraft")(draft).ok, true);
  assert.equal(samples.at(-1)!.draft.state, "cleared");
  assert.equal(app.service.snapshot("local-owner", id).artifacts.items.length, 2);
  const draftFrames = frames.filter(frame => frame.includes("event: artifact.draft")); assert.ok(draftFrames.length > 1);
  assert.ok(draftFrames.every(frame => !/^id:/m.test(frame) && !frame.includes('"cursor":')));
  assert.equal((app.database.prepare("SELECT COUNT(*) AS n FROM events WHERE kind LIKE '%draft%'").get() as { n: number }).n, 0);
  assert.equal((app.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries").get() as { n: number }).n, 1);
});

test("S1-13 白名单、不合法工具后换调用、停止后无迟到草稿或假版本", { timeout: 25000 }, async t => {
  assert.deepEqual(projectDraftItems({ items: [{ kind: "unknown", title: "文档", itemIndex: 7, thinking: "secret", content: { text: "正文" } }, { itemIndex: 7 }] }), [
    { itemIndex: 0, title: "文档", kind: null, text: "正文" }, { itemIndex: 1, title: null, kind: null, text: "" },
  ]);
  const { app, id } = await fixture(t, { fauxTokensPerSecond: 500 });
  const samples: ArtifactDraft[] = [];
  app.service.hub().subscribeDrafts(id, draft => samples.push(draft));
  app.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("deliver_artifacts", { ...batch, unexpected: true }, { id: "bad" })]),
    deliver("good"), fauxAssistantMessage("完成"),
  ]);
  await send(app, id, "交付两份"); await idle(app, id);
  assert.equal(new Set(samples.map(d => d.draftId)).size, 2);
  for (const draftId of new Set(samples.map(d => d.draftId))) assert.equal(samples.filter(d => d.draftId === draftId).at(-1)!.state, "cleared");
  assert.equal(app.service.snapshot("local-owner", id).artifacts.items.length, 2);
  app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ ...batch.items[0], content: { format: "markdown", text: "未完成草稿".repeat(1200) } }] })])]);
  const requestId = await send(app, id, "再写一份");
  const count = samples.length;
  for (let i = 0; samples.length === count && i < 300; i++) await sleep(10);
  app.service.stopRequest("local-owner", requestId!, { commandId: "cmd-stop" }); await idle(app, id);
  const after = samples.length; await sleep(300); assert.equal(samples.length, after);
  assert.equal(samples.at(-1)!.state, "cleared");
  assert.equal(app.service.snapshot("local-owner", id).artifacts.items.length, 2);
});

test("S1-05 原生 threshold 自动压缩后最后答复正确，继续闲聊与单目标改稿", async t => {
  const { app, id, dataDir } = await fixture(t, { fauxContextWindow: 6000, compaction: { reserveTokens: 4800, keepRecentTokens: 200 } });
  const statuses: ContextStatus[] = []; app.service.hub().subscribeContextStatus(id, event => statuses.push(event));
  let summaries = 0, answers = 0;
  const seedSteps = [fauxAssistantMessage("先聊创作节奏。".repeat(25)), fauxAssistantMessage("再聊环境声。".repeat(25)), deliver(), fauxAssistantMessage("交付后请慢慢看。".repeat(60))];
  const seed: FauxResponseStep = ctx => {
    app.faux!.appendResponses([seed]);
    if (isSummary(ctx)) { summaries++; return fauxAssistantMessage("摘要只用于上下文，不能当作用户答复。"); }
    assert.ok(seedSteps.length); return seedSteps.shift()!;
  };
  app.faux!.setResponses([seed]);
  for (const text of ["聊聊创作", "聊聊环境声", "交付两份"]) { await send(app, id, text); await idle(app, id); }
  const respond: FauxResponseStep = ctx => {
    app.faux!.appendResponses([respond]);
    if (isSummary(ctx)) { summaries++; return fauxAssistantMessage("摘要只用于上下文，不能当作用户答复。"); }
    answers++; return fauxAssistantMessage(`第${answers}个正确答复。${"这段讨论不会自动开始制作。".repeat(40)}`);
  };
  app.faux!.setResponses([respond]);
  for (let i = 0; i < 6 && !statuses.some(s => s.phase === "compacted" && s.reason === "threshold"); i++) { await send(app, id, "聊一聊创作方法"); await idle(app, id); }
  assert.ok(statuses.some(s => s.phase === "compacted" && s.reason === "threshold"), JSON.stringify({ statuses, summaries, answers })); assert.ok(summaries > 0, JSON.stringify({ summaries, statuses }));
  assert.ok(app.service.snapshot("local-owner", id).messages.items.filter(m => m.role === "assistant").every(m => !m.text.includes("摘要只用于")));
  const files = await readdir(path.join(dataDir, "pi-sessions", id, "s1"));
  const log = await readFile(path.join(dataDir, "pi-sessions", id, "s1", files.find(f => f.endsWith(".jsonl"))!), "utf8");
  assert.ok(log.split("\n").some(line => line.includes('"type":"compaction"')));
  assert.equal(log.includes("[frame-current-state]"), false, "临时业务帧不进入原生压缩持久记录");
  await send(app, id, "顺便聊聊咖啡"); await idle(app, id);
  const target = app.service.snapshot("local-owner", id).artifacts.items[0]!;
  let received = "";
  app.faux!.setResponses([ctx => { received = JSON.stringify(ctx.messages); return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: target.id, baseRevisionId: target.revisionId, title: target.title, kind: target.kind, content: { format: "markdown", text: "只修改指定作品。" } }] })]); }, fauxAssistantMessage("只改了这一份。"), fauxAssistantMessage("保留最新修订事实。")]);
  await send(app, id, "请修改这份", { artifactId: target.id, revisionId: target.revisionId, workId: null }); await idle(app, id);
  assert.match(received, new RegExp(target.revisionId));
  assert.equal(app.service.readArtifactHead("local-owner", target.id).revisionNumber, 2);
  assert.equal(app.service.snapshot("local-owner", id).artifacts.items.filter(a => a.revisionNumber === 2).length, 1);
});

test("S1-04 未核实身份的文本目录可读但不能发送；绑定解析如实失败", async t => {
  const entry = (availability: ModelEntry["availability"]): ModelEntry => ({
    binding: { providerId: "cfg-unknown", modelId: "custom-model", connectionId: "conn-unknown", configurationRevisionId: "rev-unknown" },
    name: "目录外型号", kind: "text", features: [], availability, verificationNote: "此型号在当前 Pi 目录中没有精确能力", isDefault: true,
  });
  // 公开投影只含绑定与说明，不携带 Key。
  assert.equal(JSON.stringify(entry("unavailable")).includes("apiKey"), false);
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-unknown-capacity-"));
  const runtime = await createAgentRuntime({ dataDir, skillsRoot: path.resolve(import.meta.dirname, "../skills"),
    host: {}, defaultModelId: "custom-model", models: [entry("unavailable")], catalog: () => ({}) });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const conversation = runtime.service.createConversation("local-owner", { commandId: "create", title: "仍能读取" }).conversation;
  assert.equal(runtime.service.snapshot("local-owner", conversation.id).conversation.title, "仍能读取");
  await assert.rejects(() => runtime.host.modelForBinding(entry("unavailable").binding), /模型绑定无法解析/);
  assert.throws(() => runtime.service.sendMessage("local-owner", conversation.id, { commandId: "send", text: "不得发出", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null }), (error: { code?: string }) => error.code === "CAPABILITY_UNAVAILABLE");
});

// 错误发生在交付之后：一次原生恢复更换 toolCallId，仍只有一批正式成果。
test("S1-06 原生 overflow 只恢复一次，新 toolCallId 不重复交付，最终失败如实结束", async t => {
  // 窗口只放大到不被首轮工具清单撑破 threshold：本测验证的是显式超窗错误的恢复语义，
  // 不是容量逼近；threshold 先行会把可压缩内容耗尽，显式 overflow 恢复被静默跳过。
  const { app, id } = await fixture(t, { fauxContextWindow: 40_000, compaction: { reserveTokens: 3000, keepRecentTokens: 200 } });
  const statuses: ContextStatus[] = []; app.service.hub().subscribeContextStatus(id, s => statuses.push(s));
  let summaries = 0;
  const overflow = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" });
  // 响应按消费时新建：预建消息的时间戳早于前置压缩，会被 SDK 当作压缩前旧错误跳过恢复。
  const steps = [() => deliver("first"), overflow, () => deliver("second"), () => fauxAssistantMessage("恢复后的最终答复")];
  const factory: FauxResponseStep = ctx => {
    app.faux!.appendResponses([factory]);
    if (isSummary(ctx)) { summaries++; return fauxAssistantMessage("保留已提交的批次与等待用户的规则。"); }
    assert.ok(steps.length, "不得无界继续"); return steps.shift()!();
  };
  app.faux!.setResponses([factory]);
  await send(app, id, "交付之后遇到超窗"); await idle(app, id);
  assert.ok(statuses.some(s => s.reason === "overflow" && s.phase === "compacted" && s.willRetry));
  assert.ok(summaries > 0, JSON.stringify({ summaries, statuses }));
  assert.equal(app.service.snapshot("local-owner", id).artifacts.items.length, 2);
  assert.equal((app.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries").get() as { n: number }).n, 1);
  assert.equal(app.service.snapshot("local-owner", id).messages.items.find(m => m.role === "assistant")!.text, "恢复后的最终答复");
  // 连续超窗只能再尝试一次，不能由宿主重启整个任务。
  let attempts = 0;
  const failing: FauxResponseStep = ctx => {
    app.faux!.appendResponses([failing]);
    if (isSummary(ctx)) return fauxAssistantMessage("上下文摘要");
    attempts++; return overflow();
  };
  app.faux!.setResponses([failing]);
  const requestId = await send(app, id, "模拟连续超窗"); await idle(app, id);
  assert.equal(attempts, 2);
  assert.equal((app.database.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string }).state, "failed");
  assert.ok(statuses.some(s => s.requestId === requestId && s.phase === "failed" && s.willRetry === false));
});

test("S1-06 threshold 摘要失败保留成功答复与成果，停止摘要不启动新请求", async t => {
  const { app, id } = await fixture(t, { fauxContextWindow: 6000, compaction: { reserveTokens: 4800, keepRecentTokens: 200 } });
  const statuses: ContextStatus[] = []; app.service.hub().subscribeContextStatus(id, s => statuses.push(s));
  let normal = 0;
  const failing: FauxResponseStep = ctx => {
    app.faux!.appendResponses([failing]);
    if (isSummary(ctx)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid summary input" });
    return normal++ === 0 ? deliver() : fauxAssistantMessage("已交付两份，等待你看。".repeat(60));
  };
  app.faux!.setResponses([failing]);
  await send(app, id, "交付后整理失败"); await idle(app, id);
  assert.ok(statuses.some(s => s.phase === "failed"));
  const snapshot = app.service.snapshot("local-owner", id);
  assert.equal(snapshot.artifacts.items.length, 2);
  assert.match(snapshot.messages.items.find(m => m.role === "assistant")!.text, /已交付两份/);
  assert.ok(snapshot.messages.items.some(m => m.role === "system_notice" && m.text.includes("上下文整理未完成")));
  let summaryStarted!: () => void;
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  const stopping: FauxResponseStep = async (ctx, options) => {
    app.faux!.appendResponses([stopping]);
    if (!isSummary(ctx)) return fauxAssistantMessage("继续讨论".repeat(100));
    summaryStarted();
    await new Promise<void>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return fauxAssistantMessage("unreachable");
  };
  app.faux!.setResponses([stopping]);
  const requestId = await send(app, id, "继续讨论"); await started;
  app.service.stopRequest("local-owner", requestId!, { commandId: "stop-summary" }); await idle(app, id);
  assert.ok(statuses.some(s => s.requestId === requestId && s.phase === "cancelled"));
  assert.equal((app.database.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string }).state, "stopped");
});
