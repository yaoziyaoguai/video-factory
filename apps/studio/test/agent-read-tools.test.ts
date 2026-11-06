import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import { toolIntentOf } from "./helpers/tool-args.js";
import type { ArtifactHead, ArtifactRevision, ProductionIntent, ToolListProduction } from "../src/shared/agent/generated/contracts.js";

// T2 只读事实与上下文索引（S1-02 / S1-03）：三个窄只读工具的范围核对、
// 无副作用、分页发现与 detail 事实；prepare 同请求同 args digest 重放。
// 只读调用前后业务表计数必须不变；失败/费用来自持久事实而不是模型猜测。

const origin = "http://127.0.0.1:4396";
let sequence = 0;
const cmd = () => `test-${++sequence}`;
const input = (text: string) => ({ commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });

function lastToolResult(context: TranscriptContext): string {
  const found = [...context.messages].reverse().find(message => message.role === "toolResult");
  if (!found) return "";
  const content = (found as { content?: { type: string; text?: string }[] }).content;
  return content ? content.map(block => block.text ?? "").join("\n") : JSON.stringify(found);
}

const deliverStep: FauxResponseStep = () => fauxAssistantMessage([
  fauxToolCall("deliver_artifacts", {
    items: [{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }],
  }, { id: "call-deliver-1" }),
]);

interface Fixture {
  app: OfflineAgentAssembly;
  conversation: { id: string };
  artifact: ArtifactHead;
  revision: ArtifactRevision;
  close(): Promise<void>;
}

async function setup(media?: Parameters<typeof assembleOfflineAgent>[0]["media"], compaction = false): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t2-"));
  // 本场景由供应商显式 overflow 触发恢复，窗口需容纳当前工具声明，避免先被 threshold 压缩抢占响应。
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, ...(media ? { media } : {}), ...(compaction ? { fauxContextWindow: 16000, compaction: { reserveTokens: 3000, keepRecentTokens: 200 } } : {}) });
  const conversation = app.service.createConversation("local-owner", { commandId: cmd(), title: "只读工具" }).conversation;
  app.faux!.setResponses([deliverStep, fauxAssistantMessage("已交付。")]);
  await app.service.sendMessage("local-owner", conversation.id, input("给我 prompt"));
  await waitIdle(app, conversation.id);
  const artifact = app.service.snapshot("local-owner", conversation.id).artifacts.items[0]!;
  assert.ok(artifact, "源产物应已交付");
  const revision = app.service.readRevision("local-owner", artifact.id, artifact.revisionId);
  return { app, conversation, artifact, revision,
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

function speechSpec(artifact: ArtifactHead, revision: ArtifactRevision, title: string): ProductionIntent {
  return {
    workId: null, title, inputRevisions: [{ artifactId: artifact.id, revisionId: artifact.revisionId }],
    operations: [{ operationId: "voice", outputSlot: "voice", kind: "speech", model: OFFLINE_QUOTE_CATALOG["speech:faux-speech"].binding,
      inputs: [{ kind: "artifact_revision" as const, artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
      maxCreateAttempts: 1, parameters: { voiceId: "narrator-main", format: "mp3" } }],
    finalOutput: { operationId: "voice", outputSlot: "voice" }, maxSpend: { currency: "CNY", amountMinor: 500 },
  };
}

async function waitIdle(app: OfflineAgentAssembly, conversationId: string) {
  for (let i = 0; i < 300 && app.service.snapshot("local-owner", conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(app.service.snapshot("local-owner", conversationId).activeRequestId, null, "回合应已结束");
}

it("S1-02 只读工具：范围核对拒绝、无副作用、翻页发现与 detail 当前事实", async () => {
  const f = await setup(); let release = () => {}; try {
    const { app, conversation, artifact, revision } = f;
    const other = app.service.createConversation("local-owner", { commandId: cmd(), title: "另一会话" }).conversation;
    const tools = new BusinessTools(app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const held = await holdRequest(app, conversation.id); release = held.release;
    const context = held.context;

    for (let index = 0; index < 12; index++) {
      await app.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: speechSpec(artifact, revision, `提案 ${index + 1}`) });
    }

    const first = await tools.listProduction(context as never, { kind: "proposals" } as ToolListProduction);
    assert.equal(first.kind, "proposals");
    assert.equal(first.items.length, 10);
    assert.ok(first.nextCursor, "超过一页应有 nextCursor");
    assert.equal(first.items[0]!.title, "提案 12");
    const second = await tools.listProduction(context as never, { kind: "proposals", cursor: first.nextCursor! });
    assert.equal(second.items.length, 2);
    assert.equal(second.items[0]!.title, "提案 2");
    assert.equal(second.nextCursor, null);

    // detail：到期后 state 反映当前事实（不是创建时的快照）。
    const earliestId = second.items[1]!.id;
    app.database.prepare("UPDATE proposals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(earliestId);
    app.service.sweepProposals();
    const detail = await tools.readProposal(context as never, { proposalId: earliestId });
    assert.equal(detail.state, "expired");

    // 范围拒绝：另一会话的对象、另一用户、不存在的 id、伪造/跨集合游标。
    // 另一会话先真实产出再准备，保持事实合法；跨会话读取必须拒绝。
    app.faux!.setResponses([deliverStep, fauxAssistantMessage("另一会话已交付。")]);
    await app.service.sendMessage("local-owner", other.id, input("再给我一份"));
    await waitIdle(app, other.id);
    const otherArtifact = app.service.snapshot("local-owner", other.id).artifacts.items[0]!;
    const otherProposal = (await app.service.prepareProposal("local-owner", other.id, { commandId: cmd(), spec: speechSpec(otherArtifact, app.service.readRevision("local-owner", otherArtifact.id, otherArtifact.revisionId), "别的会话") })).proposal;
    // 所有事实就绪；从这里开始只读，快照基准移到拒绝断言之前。
    const before = tableCounts(app);
    await assert.rejects(tools.readProposal(context as never, { proposalId: otherProposal.id }), (error: { code?: string }) => error.code === "NOT_FOUND");
    await assert.rejects(tools.readProposal({ ...context, actorId: "someone-else" } as never, { proposalId: earliestId }), (error: { code?: string }) => error.code === "REQUEST_NOT_RUNNING");
    await assert.rejects(tools.readRun(context as never, { runId: "run-does-not-exist" }), (error: { code?: string }) => error.code === "NOT_FOUND");
    await assert.rejects(tools.listProduction(context as never, { kind: "runs", cursor: first.nextCursor! }), (error: { code?: string }) => error.code === "FORBIDDEN");
    await assert.rejects(tools.listProduction(context as never, { kind: "proposals", cursor: "not-a-cursor" }), (error: { code?: string }) => error.code === "INVALID_INPUT");
    await assert.rejects(tools.listProduction({ ...context, actorId: "someone-else" } as never, { kind: "proposals" }), (error: { code?: string }) => error.code === "REQUEST_NOT_RUNNING");
    await assert.rejects(tools.readProposal({ ...context, executionEpoch: context.executionEpoch + 1 } as never, { proposalId: earliestId }), (error: { code?: string }) => error.code === "REQUEST_NOT_RUNNING");

    // 无副作用：所有只读断言（分页/detail/拒绝）前后业务表计数完全不变。
    assert.deepEqual(tableCounts(app), before);
    release(); await waitIdle(app, conversation.id);
    await assert.rejects(tools.listProduction(context as never, { kind: "proposals" }), (error: { code?: string }) => error.code === "REQUEST_NOT_RUNNING");
  } finally { release(); await f.close(); }
});

it("S1-03 已终态运行：Agent 通过 read_run 读到 issue 与费用口径，不猜免费", async () => {
  const f = await setup({ autoStart: true, delayMs: 0, outcome: "failed" }); try {
    const { app, conversation, artifact, revision } = f;
    const proposal = (await app.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: speechSpec(artifact, revision, "山路配音") })).proposal;
    const admitted = app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const runId = admitted.run.id;
    for (let i = 0; i < 300; i++) {
      const run = app.service.getRun("local-owner", runId);
      if (["succeeded", "failed", "cancelled"].includes(run.state)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const run = app.service.getRun("local-owner", runId);
    assert.equal(run.state, "failed");
    assert.ok(run.issue, "失败运行应有 issue 事实");

    // 下一回合：模型用 read_run 核对事实后回答；回答内容回显工具结果。
    app.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("read_run", { runId }, { id: "call-read-run" })]),
      (context => fauxAssistantMessage(`制作事实：${lastToolResult(context)}`)) as FauxResponseStep,
    ]);
    await app.service.sendMessage("local-owner", conversation.id, input("刚才的制作怎么了，花了多少钱"));
    await waitIdle(app, conversation.id);
    const messages = app.service.snapshot("local-owner", conversation.id).messages.items;
    // 列表按创建序倒序：第一条 assistant 即最新回答。
    const answer = messages.find(message => message.role === "assistant");
    assert.ok(answer, "应有助手回答");
    assert.match(answer!.text, /failed/);
    assert.match(answer!.text, /pendingUnknownMinor|pending_reconciliation|issue/, "回答应引用失败/费用事实");
    assert.ok(!/免费/.test(answer!.text), "费用未核实时不能声称免费");
  } finally { await f.close(); }
});

it("S1-02 补充：prepare 只在宿主确认的原生恢复中回放，同请求正常新调用仍可新建", async () => {
  const f = await setup(); try {
    const { app, conversation, artifact, revision } = f;
    const tools = new BusinessTools(app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    // 打开一个真实运行中的回合（Faux 响应被门闸挂起），在回合内发起工具调用。
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.faux!.setResponses([async () => { await gate; return fauxAssistantMessage("回合收尾。"); }]);
    const { receipt } = await app.service.sendMessage("local-owner", conversation.id, input("占位回合")) as { status: number; receipt: { requestId: string } };
    for (let i = 0; i < 200 && app.service.snapshot("local-owner", conversation.id).activeRequestId !== receipt.requestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(app.service.snapshot("local-owner", conversation.id).activeRequestId, receipt.requestId, "回合应处于运行中");
    const epoch = (app.database.prepare("SELECT execution_epoch AS epoch FROM requests WHERE id=?").get(receipt.requestId) as { epoch: number }).epoch;
    const context = { actorId: "local-owner", conversationId: conversation.id, requestId: receipt.requestId, executionEpoch: epoch, target: null, toolCallId: "call-1" };
    const spec = speechSpec(artifact, revision, "重放检查");
    const first = await tools.prepareProduction(context as never, { spec });
    // Pi 重试换了 toolCallId、args 相同：回放原提案，不创建第二份。
    const replayed = await tools.prepareProduction({ ...context, toolCallId: "call-2", nativeRecovery: true } as never, { spec });
    assert.equal(replayed.id, first.id);
    assert.equal((app.database.prepare("SELECT COUNT(*) AS n FROM proposals WHERE conversation_id=?").get(conversation.id) as { n: number }).n, 1);
    const normal = await tools.prepareProduction({ ...context, toolCallId: "call-normal" } as never, { spec });
    assert.notEqual(normal.id, first.id, "普通工具循环不能被全请求去重吞掉");
    // args 不同（标题变化）：生成新的提案，而不是回放。
    const variant = await tools.prepareProduction({ ...context, toolCallId: "call-3" } as never, { spec: speechSpec(artifact, revision, "重放检查·改") });
    assert.notEqual(variant.id, first.id);
    release();
    await waitIdle(app, conversation.id);
  } finally { await f.close(); }
});

function tableCounts(app: OfflineAgentAssembly): Record<string, number> {
  const tables = ["proposals", "production_runs", "artifacts", "artifact_revisions", "tool_invocations", "events", "requests", "messages"];
  return Object.fromEntries(tables.map(table => [table, (app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

async function holdRequest(app: OfflineAgentAssembly, conversationId: string) {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.faux!.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("读取结束"); }]);
  const sent = await app.service.sendMessage("local-owner", conversationId, input("读取事实"));
  await ready;
  const requestId = sent.receipt.requestId;
  const row = app.database.prepare("SELECT execution_epoch FROM requests WHERE id=?").get(requestId) as { execution_epoch: number };
  return { release, context: { actorId: "local-owner", conversationId, requestId, executionEpoch: row.execution_epoch, target: null, toolCallId: "call-read" } };
}

it("S1-07 原生 overflow 恢复换 toolCallId，重复准备回放原提案而不受理制作", async () => {
  const f = await setup(undefined, true); try {
    const { app, conversation, artifact, revision } = f;
    const spec = speechSpec(artifact, revision, "原生恢复中的提案");
    const steps = [
      fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(spec))) }, { id: "before-overflow" })]),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
      fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(spec))) }, { id: "after-overflow" })]),
      fauxAssistantMessage("仅准备提案，等待确认。"),
    ];
    let summaries = 0, recovered = false;
    app.service.hub().subscribeContextStatus(conversation.id, e => { if (e.reason === "overflow" && e.phase === "compacted" && e.willRetry) recovered = true; });
    const factory: FauxResponseStep = context => {
      app.faux!.appendResponses([factory]);
      if (!context.messages.some(m => m.role === "system" && JSON.stringify(m).includes("帧间 Frame"))) { summaries++; return fauxAssistantMessage("已准备一份提案，尚未确认制作。"); }
      assert.ok(steps.length); return steps.shift()!;
    };
    app.faux!.setResponses([factory]);
    await app.service.sendMessage("local-owner", conversation.id, input("准备提案后遇到超窗")); await waitIdle(app, conversation.id);
    assert.ok(recovered); assert.ok(summaries > 0);
    const snapshot = app.service.snapshot("local-owner", conversation.id);
    assert.equal(snapshot.proposals.items.length, 1); assert.equal(snapshot.runs.items.length, 0);
    assert.equal(snapshot.messages.items.find(m => m.role === "assistant")!.text, "仅准备提案，等待确认。");
    assert.equal((app.database.prepare("SELECT COUNT(*) AS n FROM tool_invocations WHERE tool_name='prepare_production'").get() as { n: number }).n, 2);
  } finally { await f.close(); }
});
