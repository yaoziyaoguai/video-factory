import { ConversationCache, RevisionCache } from "../src/client/agent/reading-cache.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench } from "../src/client/agent/AgentWorkbench.js";
import { agentApi } from "../src/client/agent/api.js";
import { ProposalCard } from "../src/client/agent/AgentWorkbench.js";
import { MarkdownText } from "../src/client/agent/markdown.js";
import { FilePreview, MediaPreview, ProjectPreview, RunCard } from "../src/client/agent/ProductionCards.js";
import {
  appendNotice, clearDraft, draftStorageKey, loadDraft, loadPanelLayout, mergeArtifacts, mergeLibraryPicks, mergeMessages, mergeProposals, saveDraft, savePanelLayout,
  type LibraryPick,
} from "../src/client/agent/workspace-state.js";
import type {
  ArtifactDraft, ArtifactHead, ArtifactRevision, Bootstrap, Conversation, LegacyProductionSpec, LibraryVideo, MaterialBatch, Message, MessageInput, ProductionSpec, Snapshot, Proposal, Run, SkillPackagesView, UploadAttachment, UploadReceipt, Work,
} from "../src/shared/agent/generated/contracts.js";

// 工作台纯逻辑（合并/预览策略/草稿/布局）+ 组件冒烟：API 与 SSE 全部打桩，浏览器端真实交互留给 A6 手工验证。

// —— fetch / EventSource 打桩 ——

type RouteResult = { status: number; body: unknown } | null;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  cache: RequestCache | undefined;
}

function installFetch(handler: (url: string, call: FetchCall) => RouteResult | Promise<RouteResult>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call: FetchCall = { url, method: init?.method ?? "GET", headers, body, cache: init?.cache };
    calls.push(call);
    const result = await handler(url, call);
    if (!result) throw new Error(`测试未模拟的请求：${call.method} ${url}`);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: { data: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
    });
  }
}

// —— 夹具（形状来自生成契约） ——

const BOOTSTRAP: Bootstrap = {
  ownerId: "owner-1",
  displayName: "本地用户",
  models: [{
    binding: { providerId: "pi-faux", modelId: "faux-text-1", connectionId: "conn-1", configurationRevisionId: "cfg-1" },
    name: "本地离线模型（Faux）",
    kind: "text",
    features: [],
    availability: "configured",
    verificationNote: "离线验证：模型响应来自 Faux，不产生真实模型调用。",
    isDefault: true,
  }],
  skills: [],
};

function conversationFixture(id: string, title: string, revision = 1): Conversation {
  return { id, title, revision, updatedAt: "2026-01-01T00:00:00.000Z" };
}

const fixtureMessageSequences = new Map<string, number>();
function messageFixture(options: Partial<Message> & Pick<Message, "id" | "role" | "text">): Message {
  const sequence = fixtureMessageSequences.get(options.id) ?? fixtureMessageSequences.size + 1;
  fixtureMessageSequences.set(options.id, sequence);
  return {
    requestId: null,
    state: "completed",
    revision: 1,
    target: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdSequence: sequence,
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] },
    kind: "chat",
    feedback: null,
    librarySelections: [],
    ...options,
  };
}

function artifactFixture(id: string, title: string, revisionId: string, revisionNumber: number): ArtifactHead {
  return { id, title, kind: "script", revisionId, revisionNumber, workId: null, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function libraryVideoFixture(options: Partial<LibraryVideo> = {}): LibraryVideo {
  return {
    video: { artifactId: "art-lib-video", revisionId: "rev-lib-video" },
    workId: "work-lib",
    conversationId: "conv-lib-src",
    title: "山路定稿",
    finalizedAt: "2026-02-01T00:00:00.000Z",
    plan: null,
    content: null,
    originMessageId: "msg-src",
    narrationText: null,
    projectFiles: [{ project: { artifactId: "art-lib-proj", revisionId: "rev-lib-proj" }, relativePath: "main.cjs", mimeType: "text/javascript", blobId: "blob-lib-code", sizeBytes: 57 }],
    project: { artifactId: "art-lib-proj", revisionId: "rev-lib-proj" },
    materials: [{ source: { artifactId: "art-lib-mat", revisionId: "rev-lib-mat" }, label: "山路", kind: "prompt", provenance: [] }],
    reviewSources: [],
    provenanceStatus: "recorded",
    ...options,
  };
}

function snapshotFixture(conversation: Conversation, options: {
  messages?: Message[];
  artifacts?: ArtifactHead[];
} = {}): Snapshot {
  return {
    conversation,
    eventCursor: `cursor-${conversation.id}`,
    messages: { items: options.messages ?? [], nextCursor: null, watermark: "wm-1" },
    artifacts: { items: options.artifacts ?? [], nextCursor: null, watermark: "wm-1" },
    runs: { items: [], nextCursor: null, watermark: "wm-1" },
    activeRequestId: null,
    proposals: { items: [], nextCursor: null, watermark: "wm-1" },
    works: [],
    worksNextCursor: null,
    materialBatches: [],
  };
}

it("PC 断线补读失败后，网络恢复自动重连并保留草稿", async () => {
  const conversation = conversationFixture("reconnect", "连接恢复");
  let fail = false;
  installWorkbenchRoutes({ conversations: [conversation], onRequest: url => fail && url.endsWith("/snapshot")
    ? { status: 503, body: { code: "UNAVAILABLE", message: "离线中", retryAction: "retry" } } : null });
  const rendered = renderAt("/agent/reconnect");
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "这句还没发");
  fail = true;
  act(() => FakeEventSource.instances.find(source => !source.closed)!.onerror?.());
  await screen.findByText("离线中");
  expect(FakeEventSource.instances.every(source => source.closed)).toBe(true);
  fail = false;
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("这句还没发");
  const count = FakeEventSource.instances.length;
  rendered.unmount(); act(() => window.dispatchEvent(new Event("online")));
  expect(FakeEventSource.instances).toHaveLength(count);
});

it("PC 左侧导航往返设置和当前会话，保留草稿且不新建会话", async () => {
  const conversation = conversationFixture("sidebar-nav", "已有创作对话");
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation) } });
  renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("heading", { name: conversation.title });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先保留这条意见");
  const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
  await userEvent.click(navigation.getByRole("button", { name: "打开模型配置" }));
  // 点击才触发设置模块的动态导入，等待该次导入完成后验证用户看到的页面。
  await act(async () => { await vi.dynamicImportSettled(); });
  await screen.findByRole("region", { name: "模型配置" });
  await userEvent.click(navigation.getByRole("button", { name: "返回当前对话" }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先保留这条意见");
  await userEvent.click(navigation.getByRole("button", { name: "展开会话列表" }));
  await userEvent.click(navigation.getByRole("button", { name: "打开个人设置" }));
  await screen.findByRole("region", { name: "用户页" });
  await userEvent.click(within(screen.getByRole("navigation", { name: "会话列表" })).getByRole("button", { name: conversation.title }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(conversation.title);
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先保留这条意见");
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
});

it("Oracle P2-01 SSE 仍连接时局部补读失败不禁用停止", async () => {
  const conversation = conversationFixture("partial-read", "局部同步失败");
  const request = messageFixture({ id: "active-user", role: "user", text: "仍在制作", requestId: "active-request", state: "running" });
  const snapshot = snapshotFixture(conversation, { messages: [request] }); snapshot.activeRequestId = request.requestId;
  let fail = false;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/messages/active-user")) return fail ? {status:503,body:{code:"UNAVAILABLE",message:"实体读取失败"}} : { status: 200, body: request };
    if (fail && url.endsWith("/snapshot")) return { status: 503, body: { code: "UNAVAILABLE", message: "一次快照读取失败" } };
    if (call.method === "POST" && url.endsWith("/stop")) { fail = false; request.state = "stopped"; request.revision++; snapshot.activeRequestId = null; return { status: 202, body: { requestId: request.requestId, state: "stopped" } }; }
    return null;
  } });
  renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("button", { name: "停止本轮" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  const stream = FakeEventSource.instances.find(source => !source.closed)!;
  fail = true;
  stream.emit("business", { eventId: "partial-read", kind: "message.changed", entityId: request.id, entityVersion: 1 });
  await screen.findByText("一次快照读取失败");
  expect(stream.closed).toBe(false);
  expect(screen.getByRole("button", { name: "停止本轮" })).toBeEnabled();
  expect(screen.queryByText("进展暂未同步")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "停止本轮" })).toBeNull());
  expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/stop"))).toHaveLength(1);
});

it("PC 多个业务事件合并快照，流式新答复替换前文且进展只显示实际步骤", async () => {
  const conversation = conversationFixture("progress", "制作进展");
  const message = messageFixture({ id: "progress-user", requestId: "progress-request", role: "user", text: "继续制作", state: "running" });
  const snapshot = snapshotFixture(conversation, { messages: [message] }); snapshot.activeRequestId = message.requestId;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { progress: snapshot }, onRequest: url => url.endsWith(`/messages/${message.id}`)
    ? { status: 200, body: message } : null });
  renderAt("/agent/progress");
  await screen.findByText("继续制作");
  await waitFor(() => expect(FakeEventSource.instances.some(item => !item.closed)).toBe(true));
  const source = FakeEventSource.instances.find(item => !item.closed)!;
  const snapshotsBefore = calls.filter(call => call.url.endsWith("/snapshot")).length;
  for (let index = 0; index < 12; index++) source.emit("business", { eventId: `change-${index}`, kind: "message.changed", entityId: message.id, entityVersion: index + 2 });
  await waitFor(() => expect(calls.filter(call => call.url.endsWith(`/messages/${message.id}`)).length).toBe(12));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  expect(snapshotsBefore).toBe(1);
  expect(calls.filter(call => call.url.endsWith("/snapshot"))).toHaveLength(1);
  source.emit("request.progress", { requestId: message.requestId, sequence: 1, phase: "tool_running", label: "搜索素材", updatedAt: new Date().toISOString() });
  expect(await screen.findByText("正在搜索素材")).toBeInTheDocument();
  const activity = screen.getByRole("region", { name: "当前进展" });
  expect(activity.closest(".agent-messages")).toBeNull();
  source.emit("request.progress", { requestId: message.requestId, sequence: 2, phase: "thinking", label: "等待模型响应", updatedAt: new Date().toISOString(),
    steps: [{ id: "read", label: "核对作品版本", state: "completed", updatedAt: new Date().toISOString() }] });
  expect(screen.getByText("正在等待模型响应")).toBeInTheDocument();
  const disclosure = activity.querySelector("details")!;
  expect(disclosure.open).toBe(false);
  await userEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure.open).toBe(true);
  expect(within(activity).getByRole("list", { name: "最近执行步骤" })).toHaveTextContent("核对作品版本已完成");
  // JSDOM 不实现 summary 的原生键盘默认动作；Enter/Space 在实际浏览器验证。
  await userEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure.open).toBe(false);
  source.emit("context.status", { requestId: message.requestId, sequence: 0, phase: "compacting", reason: "threshold", willRetry: null });
  expect(within(activity).getByText("正在整理会话历史")).toBeInTheDocument();
  expect(within(activity).getByRole("button", { name: "停止本轮" })).toBeEnabled();
  source.emit("context.status", { requestId: message.requestId, sequence: 1, phase: "compacted", reason: "threshold", willRetry: false });
  expect(within(activity).getByText("正在等待模型响应")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "排队发送" })).toHaveAttribute("title", "等待当前请求完成后处理");
  source.emit("text.delta", { requestId: message.requestId, messageId: "answer", sequence: 1, text: "先前说明", replace: true });
  await within(await screen.findByTestId("streaming-message")).findByText("先前说明");
  source.emit("text.delta", { requestId: message.requestId, messageId: "answer", sequence: 2, text: "最终答复", replace: true });
  await within(screen.getByTestId("streaming-message")).findByText("最终答复");
  expect(screen.queryByText("先前说明")).toBeNull();
  source.emit("request.progress", { requestId: message.requestId, sequence: 0, phase: "thinking", label: "旧步骤", updatedAt: new Date().toISOString() });
  expect(screen.queryByText("正在旧步骤")).toBeNull();
  message.state = "completed"; message.revision = 8; snapshot.activeRequestId = null;
  message.execution = { startedAt: message.createdAt, endedAt: new Date().toISOString(), completionReason: "finished", progress: {
    requestId: message.requestId!, sequence: 3, phase: "thinking", label: "生成回复", updatedAt: new Date().toISOString(),
    steps: [{ id: "read", label: "核对作品版本", state: "completed", updatedAt: new Date().toISOString() }],
  } };
  source.emit("business", { eventId: "request-finished", kind: "message.changed", entityId: message.id, entityVersion: 8 });
  const record = await screen.findByLabelText("查看本轮执行记录：已完成");
  expect(record.closest(".agent-messages")).not.toBeNull();
  await userEvent.click(record);
  expect(screen.getByRole("list", { name: "本轮实际执行步骤" })).toHaveTextContent("核对作品版本已完成");
  await waitFor(() => expect(screen.queryByRole("region", { name: "当前进展" })).toBeNull());
});

const REVISION_FIXTURE: ArtifactRevision = {
  artifactId: "art-1",
  revisionId: "rev-1",
  revisionNumber: 1,
  baseRevisionId: null,
  requestId: "req-1",
  runId: null,
  digest: "sha256:fixture",
  content: { format: "markdown", text: "# 第一版\n\n这是交付内容。" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

it("同一条助手消息连续三次变更共用补读，与交付并行时每份产物只读一次", async () => {
  const conversation = conversationFixture("three-deliveries", "一次交付三份稿件");
  const heads = [1, 2, 3].map(i => artifactFixture(`script-${i}`, `脚本 ${i}`, `script-${i}-v1`, 1));
  const refs = () => heads.map(head => ({ artifactId: head.id, revisionId: head.revisionId }));
  const answer = messageFixture({ id: "three-scripts", role: "assistant", text: "本轮已交付三份稿件", revision: 3,
    references: { artifacts: refs(), proposalIds: [], runIds: [], materialBatchIds: [] } });
  let releaseHeads!: () => void, releaseAnswer!: () => void;
  const headsPending = new Promise<void>(resolve => { releaseHeads = resolve; });
  const answerPending = new Promise<void>(resolve => { releaseAnswer = resolve; });
  const calls = installWorkbenchRoutes({ conversations: [conversation], onRequest: async url => {
    if (url.endsWith("/messages/three-scripts")) { await answerPending; return { status: 200, body: answer }; }
    const head = heads.find(item => url.endsWith("/artifacts/" + item.id));
    if (head) { await headsPending; return { status: 200, body: head }; }
    const exact = heads.find(item => url.endsWith("/revisions/" + item.revisionId));
    if (exact) return { status: 200, body: { ...REVISION_FIXTURE, artifactId: exact.id, revisionId: exact.revisionId, revisionNumber: exact.revisionNumber } };
    return null;
  } });
  renderAt("/agent/" + conversation.id);
  await waitFor(() => expect(FakeEventSource.instances.some(item => !item.closed)).toBe(true));
  const source = FakeEventSource.instances.find(item => !item.closed)!;
  for (const head of heads) source.emit("business", { eventId: head.id, kind: "artifact.delivered", entityId: head.id, entityVersion: 1, notification: "new_output" });
  const change = (version: number) => source.emit("business", { eventId: "answer-" + version, kind: "message.changed", entityId: answer.id, entityVersion: version });
  change(1); change(2); change(3);
  await act(async () => releaseAnswer());
  expect(calls.filter(call => call.url.endsWith("/messages/three-scripts"))).toHaveLength(1);
  for (const head of heads) expect(calls.filter(call => call.url.endsWith("/artifacts/" + head.id))).toHaveLength(1);
  await act(async () => releaseHeads());
  await screen.findByText(answer.text);
  for (const head of heads) expect(calls.filter(call => call.url.endsWith("/revisions/" + head.revisionId))).toHaveLength(1);

  heads[0] = artifactFixture("script-1", "修改后的开场", "script-1-v2", 2);
  answer.text = "开场已更新"; answer.revision = 4; answer.references.artifacts = refs();
  change(4);
  await screen.findByText(answer.text);
  expect(await screen.findByText("现名：修改后的开场", { selector: ".agent-references small" })).toBeInTheDocument();
  expect(calls.filter(call => call.url.endsWith("/messages/three-scripts"))).toHaveLength(2);
  expect(heads.map(head => calls.filter(call => call.url.endsWith("/artifacts/" + head.id)).length)).toEqual([2, 1, 1]);
});

it("助手补读已经取到旧响应时，后到的版本会再读并显示最新正文", async () => {
  const conversation = conversationFixture("later-message", "按消息版本追上");
  const answer = messageFixture({ id: "still-changing", role: "assistant", text: "第一段", revision: 1 });
  const readers: Array<(response: RouteResult) => void> = [];
  installWorkbenchRoutes({ conversations: [conversation], onRequest: url => url.endsWith("/messages/still-changing")
    ? new Promise<RouteResult>(resolve => { readers.push(resolve); }) : null });
  renderAt("/agent/" + conversation.id);
  await waitFor(() => expect(FakeEventSource.instances.some(item => !item.closed)).toBe(true));
  const source = FakeEventSource.instances.find(item => !item.closed)!;
  const change = (version: number) => source.emit("business", { eventId: "answer-" + version, kind: "message.changed", entityId: answer.id, entityVersion: version });
  change(1); change(2); change(3);
  expect(readers).toHaveLength(1);
  await act(async () => readers[0]!({ status: 200, body: answer }));
  await screen.findByText("第一段");
  expect(readers).toHaveLength(2);
  await act(async () => readers[1]!({ status: 200, body: { ...answer, revision: 3, text: "完整第三段" } }));
  await screen.findByText("完整第三段");
  expect(readers).toHaveLength(2);
  source.emit("business", { eventId: "late-version-two", kind: "message.changed", entityId: answer.id, entityVersion: 2 });
  expect(readers).toHaveLength(2);
});

function productionFixture(conversation: Conversation): { proposal: Proposal; run: Run; snapshot: Snapshot; bootstrap: Bootstrap; spec: LegacyProductionSpec } {
  // 旧形状 spec 夹具：专门覆盖 LegacyProductionSpec 读取路径（ProductionSpec 见 read-tools/audit 侧测试）。
  const spec: LegacyProductionSpec = { workId: null, title: "模拟短片", inputRevisions: [{ artifactId: "art-1", revisionId: "rev-1" }],
    operations: [{ operationId: "op-1", outputSlot: "video", inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest: "a".repeat(64) }],
      kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1,
      quotePerAttempt: { currency: "CNY", amountMinor: 1200 }, priceKind: "bounded" }], finalOutput: { operationId: "op-1", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 1200 } };
  const proposal: Proposal = { id: "proposal-b", conversationId: conversation.id, digest: "a".repeat(64), revision: 1, state: "ready", acceptedRunId: null, acceptanceBlocker: null,
    expiresAt: "2099-01-01T00:00:00Z", priceDisclosure: "模拟媒体 12 元，无真实扣费", spec };
  const run: Run = { id: "run-b", conversationId: conversation.id, workId: "work-b", snapshotId: "snapshot-b", origin: { kind: "proposal", proposalId: proposal.id }, revision: 1, state: "queued", title: "模拟短片",
    finance: { state: "reserved", currency: "CNY", reservedMinor: 1200, pendingUnknownMinor: 0, settledMinor: 0, priceKind: "bounded" }, inputRevisions: spec.inputRevisions,
    outputRevisions: [], operations: [{ operationId: "op-1", kind: "video", state: "pending", media: null }], segments: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", issue: null };
  const snapshot = snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "原 Prompt", "rev-1", 1)], messages: [messageFixture({ id: "proposal-message", role: "assistant", text: "提案准备好了。", references: { artifacts: [], proposalIds: [proposal.id], runIds: [], materialBatchIds: [] } })] });
  snapshot.proposals.items = [proposal];
  const bootstrap: Bootstrap = { ...BOOTSTRAP, models: [...BOOTSTRAP.models, { ...BOOTSTRAP.models[0]!, kind: "video", features: ["offline-fixture"] }] };
  return { proposal, run, snapshot, bootstrap, spec };
}

it("B 确认响应丢失后使用原 commandId 重试；成功后输入锁定，草稿与阅读保持", async () => {
  const conversation = conversationFixture("conv-b", "制作验收");
  const f = productionFixture(conversation);
  const commands: unknown[] = [];
  let fail = true;
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-b": f.snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: f.bootstrap };
    if (url.endsWith("/acceptances")) {
      commands.push(call.body);
      if (fail) { fail = false; throw new Error("lost response"); }
      f.snapshot.proposals.items = [{ ...f.proposal, state: "accepted", revision: 2, acceptedRunId: f.run.id }];
      f.snapshot.runs.items = [f.run];
      return { status: 202, body: { receiptId: "receipt-b", replayed: true, run: f.run } };
    }
    return null;
  } });
  renderAt("/agent/conv-b");
  await userEvent.click(await screen.findByRole("button", { name: "原 Prompt" }));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先保留我的草稿");
  await userEvent.click(screen.getAllByRole("button", { name: "确认制作" })[0]!);
  await screen.findByRole("alert");
  await userEvent.click(screen.getAllByRole("button", { name: "确认制作" })[0]!);
  expect(await screen.findByRole("button", { name: "制作中 · 输入已锁定" })).toBeDisabled();
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]);
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先保留我的草稿");
  expect(screen.getByRole("heading", { name: "原 Prompt" })).toBeInTheDocument();
});

it("只有文本模型时仍可确认纯本地混音提案，由服务端核对实际制作能力", async () => {
  const conversation = conversationFixture("conv-local-mix", "本地混音");
  const f = productionFixture(conversation);
  f.bootstrap = BOOTSTRAP;
  f.proposal = { ...f.proposal, priceDisclosure: "仅本地重合成", spec: { ...f.proposal.spec, inputRevisions: [],
    operations: [{ kind: "render", operationId: "mix", outputSlot: "film", model: null, maxCreateAttempts: 1,
      quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded", inputs: [{ kind: "blob", blobId: "visual", digest: "b".repeat(64) }],
      parameters: { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
        segments: [{ kind: "video", inputSlot: 0, startMs: 0, durationMs: 3000, originalGain: 1 }], segmentIds: ["shot"] } }],
    finalOutput: { operationId: "mix", outputSlot: "film" }, maxSpend: { currency: "CNY", amountMinor: 0 } } };
  f.snapshot.proposals.items = [f.proposal];
  const commands: unknown[] = [];
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: f.snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: f.bootstrap };
    if (url.endsWith("/acceptances")) { commands.push(call.body); return { status: 409, body: { code: "CAPABILITY_UNAVAILABLE", message: "本地编码能力已停用，请重新准备。", retryAction: "none" } }; }
    return null;
  } });
  renderAt(`/agent/${conversation.id}`);
  const confirm = (await screen.findAllByRole("button", { name: "确认制作" }))[0]!;
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await screen.findByText("本地编码能力已停用，请重新准备。");
  expect(commands).toHaveLength(1);
});

it("B 回复提案携带精确引用，保留问号；后台新结果不抢预览或草稿", async () => {
  const conversation = conversationFixture("conv-b", "制作验收");
  const f = productionFixture(conversation);
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-b": f.snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: f.bootstrap };
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { receiptId: "reply", requestId: "req-b", messageId: "msg-b", state: "completed", replayed: false, runId: null } };
    if (url.endsWith("/runs/run-b")) return { status: 200, body: f.run };
    if (url.endsWith("/artifacts/video-b")) return { status: 200, body: { ...artifactFixture("video-b", "新视频", "video-rev", 1), kind: "video" } };
    return null;
  } });
  renderAt("/agent/conv-b");
  await userEvent.click(await screen.findByRole("button", { name: "原 Prompt" }));
  await userEvent.click(screen.getAllByRole("button", { name: "回复这份提案" })[0]!);
  expect(screen.getByText(/制作请发送「确认制作」，也可继续讨论/)).toHaveTextContent("模拟短片");
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("");
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "开始制作？");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(""));
  const command = calls.find(c => c.method === "POST" && c.url.endsWith("/messages"))!.body as Record<string, unknown>;
  expect(command.proposalRef).toEqual({ proposalId: f.proposal.id, digest: f.proposal.digest });
  expect(command.text).toBe("开始制作？"); expect(command.target).toBeNull(); expect(command.skillId).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "我们聊点别的");
  f.run = { ...f.run, revision: 3, state: "succeeded", finance: { state: "settled", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 1200, priceKind: "bounded" }, outputRevisions: [{ artifactId: "video-b", revisionId: "video-rev" }] };
  f.snapshot.runs.items = [f.run];
  f.snapshot.artifacts.items.push({ ...artifactFixture("video-b", "新视频", "video-rev", 1), kind: "video" });
  FakeEventSource.instances.find(s => !s.closed)!.emit("business", { eventId: "completed", kind: "run.changed", entityId: "run-b", entityVersion: 3, notification: "quiet" });
  await screen.findByRole("button", { name: /新视频/ });
  expect(screen.getByRole("heading", { name: "原 Prompt" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("我们聊点别的");
  expect(screen.getByRole("button", { name: /新视频/ })).toHaveTextContent("有更新");
});

function installWorkbenchRoutes(options: {
  conversations: Conversation[];
  snapshots?: Record<string, Snapshot>;
  onRequest?: (url: string, call: FetchCall) => RouteResult | Promise<RouteResult>;
  onCreate?: (title: string) => { status: number; body: Conversation };
  onRename?: (id: string, call: FetchCall) => { status: number; body: unknown };
}) {
  const calls = installFetch(async (url, call) => {
    const intercepted = await options.onRequest?.(url, call);
    if (intercepted) return intercepted;
    if (call.method === "GET" && url.endsWith("/api/agent/v1/bootstrap")) return { status: 200, body: BOOTSTRAP };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/settings/model-connections")) return { status: 200, body: { revision: 0, connections: [], modelStatuses: [] } };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/profile")) return { status: 200, body: { revision: 1, displayName: "本地用户", bio: "" } };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/conversations")) {
      return { status: 200, body: { items: options.conversations, nextCursor: null, watermark: "wm-1" } };
    }
    if (call.method === "POST" && url.endsWith("/api/agent/v1/conversations")) {
      const title = (call.body as { title: string }).title;
      return options.onCreate?.(title) ?? { status: 201, body: conversationFixture("conv-new", title) };
    }
    const renameMatch = /\/api\/agent\/v1\/conversations\/([^/]+)$/.exec(url);
    if (call.method === "GET" && renameMatch) {
      const value = options.conversations.find(conversation => conversation.id === renameMatch[1]);
      return value ? {status: 200, body: value} : {status: 404, body:{message:"对话不存在"}};
    }
    if (call.method === "PATCH" && renameMatch) {
      return options.onRename?.(renameMatch[1]!, call) ?? { status: 200, body: conversationFixture(renameMatch[1]!, "已改名") };
    }
    const snapshotMatch = /\/api\/agent\/v1\/conversations\/([^/]+)\/snapshot$/.exec(url);
    if (call.method === "GET" && snapshotMatch) {
      const id = snapshotMatch[1]!;
      const snapshot = options.snapshots?.[id] ?? snapshotFixture(conversationFixture(id, "会话"));
      return { status: 200, body: snapshot };
    }
    const revisionMatch = /\/api\/agent\/v1\/artifacts\/([^/]+)\/revisions\/([^/]+)$/.exec(url);
    if (call.method === "GET" && revisionMatch) return { status: 200, body: REVISION_FIXTURE };
    return null;
  });
  return calls;
}

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[state === undefined ? path : { pathname: path, state }]}>
      <Routes>
        <Route path="/agent" element={<AgentWorkbench />} />
        <Route path="/agent/:conversationId" element={<AgentWorkbench />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("R45-CLOSE-1 旧继续缓存缺少组目标时不发送，保留原命令并提示核对", async () => {
  const conversation = conversationFixture("legacy-continue", "创作对话");
  const snapshot = snapshotFixture(conversation);
  const source = { kind: "artifact_revision" as const, artifactId: "art-1", revisionId: "rev-1", digest: "sha256:fixture" };
  snapshot.artifacts.items = [artifactFixture("art-1", "脚本", "rev-1", 1)];
  snapshot.works = [{
    id: "work-b", title: "城市动画", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    reviewGroups: [{ id: "group-content", title: "内容草稿", revision: 1, nextIntent: null,
      items: [{ id: "item-content", label: "脚本", role: "content", required: true,
        draft: source, approved: source, finalizedSource: null, confirmationId: "conf-b", approvedAt: "2026-01-01T00:00:00Z" }] }],
  }];
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshot }, onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) {
      return { status: 202, body: { requestId: "req-continue", messageId: "msg-continue", state: "completed", replayed: false, runId: null } };
    }
    return null;
  } });
  const storageKey = `vf:agent-review:${conversation.id}:work-b:group-content:continue`;
  const saved = JSON.stringify({ commandId: "pre-r45-pending-continue", text: "「内容草稿」这一组可以了，请继续。",
    target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, reviewConfirmation: null }, null, 2);
  localStorage.setItem(storageKey, saved);
  renderAt(`/agent/${conversation.id}`);
  await userEvent.click(await screen.findByRole("button", { name: `审阅${snapshot.works[0]!.title}` }));
  await screen.findByRole("button", { name: "继续下一步" });
  await userEvent.click(screen.getByRole("button", { name: "继续下一步" }));
  expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))).toHaveLength(0);
  expect(localStorage.getItem(storageKey)).toBe(saved);
  expect(await screen.findByRole("alert")).toHaveTextContent("这是旧版留下的继续操作");
  expect(screen.getByRole("button", { name: "继续下一步" })).toBeEnabled();
});

// —— 纯逻辑 ——

describe("workspace 状态合并与预览策略", () => {
  it("Markdown 不产生脚本节点，只放行 http(s) 链接", () => {
    const { container } = render(
      <MarkdownText text={"<script>alert(1)</script>\n\n[危险](javascript:alert(1)) 与 [安全](https://example.com/a?b=1)"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link", { name: "危险" })).toBeNull();
    // script 标签被整段按纯文本呈现（DOM 里是转义文本，不是元素）
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    const safe = screen.getByRole("link", { name: "安全" });
    expect(safe).toHaveAttribute("href", "https://example.com/a?b=1");
    expect(safe).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("消息按 id+revision 合并：旧版本晚到不覆盖新版本", () => {
    const newer = messageFixture({ id: "m1", role: "assistant", text: "第二版内容", revision: 2 });
    const older = messageFixture({ id: "m1", role: "assistant", text: "第一版内容", revision: 1 });
    const merged = mergeMessages([newer], [older, messageFixture({ id: "m2", role: "user", text: "新消息" })]);
    const m1 = merged.find(message => message.id === "m1")!;
    expect(m1.text).toBe("第二版内容");
    expect(merged.some(message => message.id === "m2")).toBe(true);
    // 相同 revision 的重复投递不产生重复条目
    expect(mergeMessages(merged, [older])).toHaveLength(2);
  });

  it("同一毫秒的消息按服务端创建顺序排列，旧页晚到不反转对话", () => {
    const first = { ...messageFixture({ id: "msg-z", role: "user", text: "先发的消息" }), createdSequence: 1 };
    const second = { ...messageFixture({ id: "msg-a", role: "assistant", text: "后面的回复" }), createdSequence: 2 };
    expect(first.createdAt).toBe(second.createdAt);
    expect(mergeMessages([second], [first]).map(message => message.id)).toEqual(["msg-z", "msg-a"]);
    expect(mergeMessages([first, second], [{ ...first, revision: 2 }]).map(message => message.id)).toEqual(["msg-z", "msg-a"]);
  });

  it("产物与提案各自按版本合并", () => {
    const merged = mergeArtifacts(
      [artifactFixture("a1", "旧标题", "rev-1", 1)],
      [artifactFixture("a1", "新标题", "rev-2", 2)],
    );
    expect(merged[0]!.revisionNumber).toBe(2);
    const staleFirst = mergeArtifacts([artifactFixture("a1", "新标题", "rev-2", 2)], [artifactFixture("a1", "旧标题", "rev-1", 1)]);
    expect(staleFirst[0]!.revisionNumber).toBe(2);
  });

  it("新产出提示按会话去重累积", () => {
    let notices = { byConversation: new Map<string, string[]>() };
    notices = appendNotice(notices, "c1", "art-9");
    notices = appendNotice(notices, "c1", "art-9"); // 去重
    notices = appendNotice(notices, "c1", "art-10");
    notices = appendNotice(notices, "c2", "art-11");
    expect(notices.byConversation.get("c1")).toEqual(["art-9", "art-10"]);
    expect(notices.byConversation.get("c2")).toEqual(["art-11"]);
  });

  it("草稿持久化：文本与修改目标一起保存、可恢复、可清除，坏数据返回 null", () => {
    expect(loadDraft("c1")).toBeNull();
    saveDraft("c1", { text: "再短一点", targetArtifactId: "art-1", targetRevisionId: "rev-1" });
    expect(loadDraft("c1")).toEqual({ text: "再短一点", targetArtifactId: "art-1", targetRevisionId: "rev-1", targetWorkId: null, targetSegment: null });
    window.localStorage.setItem(draftStorageKey("c2"), "{oops");
    expect(loadDraft("c2")).toBeNull();
    clearDraft("c1");
    expect(loadDraft("c1")).toBeNull();
  });

  it("G4-2 库选材草稿持久化与合并：坏条目丢弃，同一定稿下同一素材/文件去重", () => {
    const pick = (label: string, selection: LibraryPick["selection"]): LibraryPick => ({ label, selection });
    const material = pick("山路（Prompt）", { sourceVideo: { artifactId: "art-v", revisionId: "rev-v" }, source: { kind: "artifact_revision", artifactId: "art-src", revisionId: "rev-src" } });
    const file = pick("main.cjs", { sourceVideo: { artifactId: "art-v", revisionId: "rev-v" }, source: { kind: "project_file", project: { artifactId: "art-p", revisionId: "rev-p" }, relativePath: "main.cjs" } });
    saveDraft("c1", { text: "改编", targetArtifactId: null, targetRevisionId: null, librarySelections: [material] });
    expect(loadDraft("c1")?.librarySelections).toEqual([material]);
    // 同一素材重复带入不重复；同一定稿下另一文件、另一条定稿下的同名素材都保留
    expect(mergeLibraryPicks([material], [material, file])).toEqual([material, file]);
    const otherVideo = pick("山路（Prompt）", { sourceVideo: { artifactId: "art-v", revisionId: "rev-v2" }, source: { kind: "artifact_revision", artifactId: "art-src", revisionId: "rev-src" } });
    expect(mergeLibraryPicks([material], [otherVideo])).toEqual([material, otherVideo]);
    // 旧草稿无字段照常读出；坏条目（缺 label/selection 结构）只丢弃该条
    expect(loadDraft("c-noold")?.librarySelections).toBeUndefined();
    window.localStorage.setItem(draftStorageKey("c3"), JSON.stringify({ text: "x", targetArtifactId: null, targetRevisionId: null, librarySelections: [material, { label: "坏" }, { label: 1 }] }));
    expect(loadDraft("c3")?.librarySelections).toEqual([material]);
  });

  it("面板布局持久化：存取往返，非法值被过滤", () => {
    expect(loadPanelLayout()).toBeNull();
    savePanelLayout({ "agent-chat": 62.5, "agent-preview": 37.5 });
    expect(loadPanelLayout()).toEqual({ "agent-chat": 62.5, "agent-preview": 37.5 });
    window.localStorage.setItem("vf:agent-panel-layout:frame", JSON.stringify({ "agent-chat": 0, "agent-preview": -3, "bogus": "x", "agent-chat-2": 120 }));
    expect(loadPanelLayout()).toBeNull(); // 全部无效 → 无布局，回到默认
    window.localStorage.setItem("vf:agent-panel-layout:frame", JSON.stringify({ "agent-chat": 40, "bad": 999 }));
    expect(loadPanelLayout()).toEqual({ "agent-chat": 40 }); // 部分无效只丢弃无效项
  });
});

// —— 组件冒烟 ——
// UIUX-01/06 的样式契约断言（读 CSS 文件）已移至 test/agent-static-contracts.test.ts（server 侧工程）。

describe("AgentWorkbench", () => {
  it("没有当前文本模型也能编辑草稿，去配置再回来不会丢失或误发", async () => {
    let models: Bootstrap["models"] = [];
    const calls = installWorkbenchRoutes({ conversations: [], onRequest: url =>
      url.endsWith("/bootstrap") ? { status: 200, body: { ...BOOTSTRAP, models } } : null });
    const page = renderAt("/agent");
    const example = "我想做一条视频，先一起聊聊想法";
    await userEvent.click(screen.getByRole("button", { name: example }));
    const input = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(input, "{End}。{Enter}先聊结尾。");
    const draft = example + "。\n先聊结尾。";
    expect(input).toHaveValue(draft);
    expect(screen.getByRole("button", { name: /^(排队)?发送$/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "配置文本模型" }));
    expect(await screen.findByText("添加你的第一个模型连接")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "返回对话" }));
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(draft);
    page.unmount();
    models = BOOTSTRAP.models;
    renderAt("/agent");
    await waitFor(() => expect(screen.getByRole("button", { name: /^(排队)?发送$/ })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(draft);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  });

  it("渲染三栏骨架：模型状态如实展示、会话列表来自 API、预览列表列出产物", async () => {
    const snapshot = snapshotFixture(conversationFixture("conv-1", "旅行视频讨论"), {
      messages: [
        messageFixture({ id: "m1", role: "user", text: "帮我写一个开场" }),
        messageFixture({
          id: "m2", role: "assistant", text: "已交付第一版。",
          references: { artifacts: [{ artifactId: "art-1", revisionId: "rev-1" }], proposalIds: [], runIds: [], materialBatchIds: [] },
        }),
      ],
      artifacts: [artifactFixture("art-1", "开场脚本", "rev-1", 1)],
    });
    installWorkbenchRoutes({ conversations: [conversationFixture("conv-1", "旅行视频讨论")], snapshots: { "conv-1": snapshot } });

    renderAt("/agent/conv-1");

    expect(await screen.findByText("本地离线模型（Faux）")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开模型配置" }));
    expect(await screen.findByText("添加你的第一个模型连接")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "旅行视频讨论" }));
    expect(screen.getByRole("heading", { name: "旅行视频讨论" })).toBeInTheDocument();
    expect(screen.getByText("帮我写一个开场")).toBeInTheDocument();
    // 没有阅读记录时，已有产出直接展示，不要求再点一次卡片。
    expect(await screen.findByRole("heading", { name: "开场脚本" })).toBeInTheDocument();
    expect(screen.getByText("已交付第一版。")).toBeInTheDocument();
    // 分栏骨架：真实 Group + 两个 Panel + 分隔条
    expect(screen.getByRole("separator", { name: "调整对话与预览的宽度" })).toBeInTheDocument();
  });

  it("UIUX-01 上滚离底后新消息提示悬浮在滚动区内，不侵入输入区", async () => {
    const conversation = conversationFixture("unseen", "新消息提示");
    const first = messageFixture({ id: "m1", role: "user", text: "开头一句" });
    const late = messageFixture({ id: "m2", role: "assistant", text: "稍后到达的答复" });
    installWorkbenchRoutes({
      conversations: [conversation],
      snapshots: { unseen: snapshotFixture(conversation, { messages: [first] }) },
      onRequest: url => url.endsWith("/messages/m2") ? { status: 200, body: late } : null,
    });
    renderAt("/agent/unseen");
    await screen.findByText("开头一句");
    await waitFor(() => expect(FakeEventSource.instances.some(item => !item.closed)).toBe(true));

    // jsdom 无真实布局：直接给定滚动几何，模拟用户滚离底部（>80px 阈值），再投递新消息业务事件。
    const scroller = document.querySelector<HTMLElement>(".agent-messages")!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    FakeEventSource.instances.find(item => !item.closed)!.emit("business", { eventId: "m2-event", kind: "message.changed", entityId: "m2", entityVersion: 1 });

    const button = await screen.findByRole("button", { name: "回到最新消息 ↓" });
    const anchor = button.closest(".agent-new-messages-anchor");
    expect(anchor).not.toBeNull();
    // 锚点紧跟消息滚动区且先于输入区：按钮只向滚动区内悬浮，输入框再高也不会被盖住。
    expect(anchor!.previousElementSibling).toBe(scroller);
    const composer = document.querySelector(".agent-composer")!;
    expect(anchor!.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.contains(anchor!)).toBe(false);

    await userEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: "回到最新消息 ↓" })).toBeNull());
  });

  it("创建会话走变更安全头并导航到新会话；改名冲突如实报错", async () => {
    const conversations = [conversationFixture("conv-1", "旅行视频讨论")];
    const user = userEvent.setup();
    const calls = installWorkbenchRoutes({
      conversations,
      snapshots: { "conv-2": snapshotFixture(conversationFixture("conv-2", "新的会话")) },
      onCreate: title => {
        const created = conversationFixture("conv-2", title);
        conversations.push(created);
        return { status: 201, body: created };
      },
      onRename: () => ({
        status: 409,
        body: { code: "STALE_REVISION", message: "会话已被其他窗口修改，请刷新后重试。", requestId: "req-x", retryAction: "same_command", currentRevisionId: null },
      }),
    });

    renderAt("/agent");

    await userEvent.click(await screen.findByRole("button", { name: "＋ 新的会话" }));
    await screen.findByText("新的会话", { selector: ".agent-conversation-heading h1" });
    // 创建之后会请求新会话快照，证明前端已切换到 /agent/conv-2
    await waitFor(() => {
      expect(calls.some(call => call.url.includes("/conversations/conv-2/snapshot"))).toBe(true);
    });
    // 变更请求携带工作台安全头与 commandId
    const createCall = calls.find(call => call.url.endsWith("/api/agent/v1/conversations") && call.method === "POST");
    expect(createCall).toBeDefined();
    expect(createCall!.headers["x-video-factory-request"]).toBe("studio");
    expect(createCall!.body).toMatchObject({ title: "新的会话", commandId: expect.any(String) });

    // 改名冲突（409 STALE_REVISION）要如实浮出，不静默
    await userEvent.click(screen.getAllByRole("button", { name: "改名" })[0]!);
    const renameInput = screen.getByRole("textbox", { name: "会话名称" });
    await userEvent.clear(renameInput);
    await userEvent.type(renameInput, "被抢先改名{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("会话已被其他窗口修改，请刷新后重试。");
  });

  it("离开的在途会话只提示新产出，不占用第二条 SSE 或切换当前预览（A-34）", async () => {
    const a = conversationFixture("conv-1", "旅行视频讨论"), b = conversationFixture("conv-2", "咖啡闲聊");
    const snapshots = { "conv-1": { ...snapshotFixture(a), activeRequestId: "running" }, "conv-2": snapshotFixture(b) };
    installWorkbenchRoutes({ conversations: [a, b], snapshots });
    renderAt("/agent/conv-1");
    await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "咖啡闲聊" }));
    await screen.findByRole("heading", { name: "咖啡闲聊" });
    snapshots["conv-1"] = { ...snapshotFixture(a, { artifacts: [artifactFixture("art-1", "旅行产物", "rev-1", 1)] }), activeRequestId: null! };
    await waitFor(() => expect(screen.getByTitle("有新产出")).toBeInTheDocument(), { timeout: 3500 });
    expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "旅行产物" })).toBeNull();
    expect(screen.getByRole("heading", { name: "咖啡闲聊" })).toBeInTheDocument();
  });

  it("发送前校验草稿绑定的修改目标是否过期（A-04 客户端守卫）", async () => {
    const user = userEvent.setup();
    const artifact = artifactFixture("art-1", "开场脚本", "rev-1", 1);
    const calls = installWorkbenchRoutes({
      conversations: [conversationFixture("conv-1", "旅行视频讨论")],
      snapshots: { "conv-1": snapshotFixture(conversationFixture("conv-1", "旅行视频讨论"), { artifacts: [artifact] }) },
    });
    // 预置草稿：绑定的是旧 revisionId
    window.localStorage.setItem(draftStorageKey("conv-1"), JSON.stringify({ text: "再改短一点", targetArtifactId: "art-1", targetRevisionId: "rev-stale" }));

    renderAt("/agent/conv-1");
    await screen.findByText("再改短一点");
    expect(screen.getByText(/针对：开场脚本/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("绑定的修改目标已过期");
    expect(calls.some(call => call.url.endsWith("/conversations/conv-1/messages"))).toBe(false);
  });

  it("提案卡在制作能力接入前禁用确认入口", () => {
    const binding = { providerId: "pi-faux", modelId: "faux-speech-1", connectionId: "conn-1", configurationRevisionId: "cfg-1" };
    render(<ProposalCard proposal={{
      id: "prop-1", conversationId: "conv-1", digest: "sha256:x",
      spec: {
        workId: null, title: "开场视频", inputRevisions: [{ artifactId: "art-1", revisionId: "rev-1" }],
        operations: [{
          operationId: "op-1", outputSlot: "voice",
          inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest: "sha256:a" }],
          maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
          kind: "speech", model: binding, parameters: { voiceId: "voice-1", format: "mp3" },
        }],
        finalOutput: { operationId: "op-1", outputSlot: "voice" }, maxSpend: { currency: "CNY", amountMinor: 0 },
      },
      state: "ready", priceDisclosure: "预计 0.00 元（离线验证，不产生真实支出）", expiresAt: "2099-01-01T00:00:00.000Z",
      acceptedRunId: null, revision: 1, acceptanceBlocker: null,
    }} />);
    expect(screen.getByRole("button", { name: "确认制作" })).toBeDisabled();
  });
});

it("A-34 A 的迟到快照与旧流不会覆盖 B 的预览和输入", async () => {
  const a = conversationFixture("a", "旅行 A"), b = conversationFixture("b", "咖啡 B");
  let release!: (value: RouteResult) => void;
  const delayed = new Promise<RouteResult>(resolve => { release = resolve; });
  installWorkbenchRoutes({ conversations: [a, b], snapshots: { b: snapshotFixture(b) },
    onRequest: url => url.endsWith("/a/snapshot") ? delayed : null,
  });
  renderAt("/agent/a");
  await userEvent.click(await screen.findByRole("button", { name: "咖啡 B" }));
  await screen.findByRole("heading", { name: "咖啡 B" });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "B 的未发送想法");
  await act(async () => release({ status: 200, body: snapshotFixture(a, { messages: [messageFixture({ id: "late-a", role: "assistant", text: "A 的迟到回复" })] }) }));
  expect(screen.getByRole("heading", { name: "咖啡 B" })).toBeInTheDocument();
  expect(screen.queryByText("A 的迟到回复")).toBeNull();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("B 的未发送想法");
  expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1);
});

// —— R3 后台补读最小复现矩阵（execution-pack R3 表六行）——
// 观测面：GET /conversations/{id}/snapshot 的调用计数（每 2s interval 一次）；
// 迟到覆盖/单 SSE/断网恢复由既有 A-34(:669/:724)、A-33/35(:1015)、PC(:156) 用例承载。

const snapshotGetCount = (calls: FetchCall[], id: string) =>
  calls.filter(call => call.method === "GET" && call.url.endsWith(`/conversations/${id}/snapshot`)).length;

it("R3-1 静止会话（无 active/queued、run 终态且账务结清）离开后不持续轮询", async () => {
  const a = conversationFixture("quiet", "已收尾"), b = conversationFixture("busy-b", "进行中");
  const f = productionFixture(a);
  f.snapshot.activeRequestId = null;
  f.snapshot.runs.items = [{ ...f.run, state: "succeeded", revision: 2, finance: { state: "settled", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 1200, priceKind: "bounded" } }];
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { quiet: f.snapshot, "busy-b": snapshotFixture(b) } });
  renderAt("/agent/quiet");
  await screen.findByRole("heading", { name: "已收尾" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "进行中" }));
  await screen.findByRole("heading", { name: "进行中" });
  const initial = snapshotGetCount(calls, "quiet");
  expect(initial).toBeGreaterThanOrEqual(1);
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(snapshotGetCount(calls, "quiet")).toBe(initial);
}, 15_000);

it("R3-2 真正在途的会话有界跟踪，事实完成后停止", async () => {
  const a = conversationFixture("live", "在途会话"), b = conversationFixture("watch-b", "旁观会话");
  let finished = false;
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { "watch-b": snapshotFixture(b) }, onRequest: url => {
    if (url.endsWith("/live/snapshot")) return { status: 200, body: { ...snapshotFixture(a), activeRequestId: finished ? null : "req-live" } };
    return null;
  } });
  renderAt("/agent/live");
  await screen.findByRole("heading", { name: "在途会话" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  finished = true;
  await userEvent.click(screen.getByRole("button", { name: "旁观会话" }));
  await screen.findByRole("heading", { name: "旁观会话" });
  await waitFor(() => expect(snapshotGetCount(calls, "live")).toBeGreaterThanOrEqual(2), { timeout: 3500 });
  const stabilized = snapshotGetCount(calls, "live");
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(snapshotGetCount(calls, "live")).toBe(stabilized);
}, 15_000);

it("R3-3 终态 run 待账务核实时保留查询，settled 后停止且不靠单实体读刷量", async () => {
  const a = conversationFixture("billing", "待结算"), b = conversationFixture("peer-b", "同伴会话");
  const f = productionFixture(a);
  const unsettled = { ...f.run, state: "succeeded" as const, revision: 1, finance: { state: "pending_reconciliation" as const, currency: "CNY" as const, reservedMinor: 0, pendingUnknownMinor: 1200, settledMinor: 0, priceKind: "bounded" as const } };
  const settled = { ...unsettled, revision: 2, finance: { state: "settled" as const, currency: "CNY" as const, reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 1200, priceKind: "bounded" as const } };
  let done = false;
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { "peer-b": snapshotFixture(b) }, onRequest: url => {
    if (url.endsWith("/billing/snapshot")) {
      const snapshot = { ...f.snapshot, activeRequestId: null as string | null };
      snapshot.runs.items = [done ? settled : unsettled];
      return { status: 200, body: snapshot };
    }
    return null;
  } });
  renderAt("/agent/billing");
  await screen.findByRole("heading", { name: "待结算" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "同伴会话" }));
  await screen.findByRole("heading", { name: "同伴会话" });
  await waitFor(() => expect(snapshotGetCount(calls, "billing")).toBeGreaterThanOrEqual(2), { timeout: 3500 });
  done = true;
  await waitFor(() => expect(snapshotGetCount(calls, "billing")).toBeGreaterThanOrEqual(3), { timeout: 3500 });
  const stabilized = snapshotGetCount(calls, "billing");
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(snapshotGetCount(calls, "billing")).toBe(stabilized);
  // 账务事实在快照首页内：不应退化为每 tick 单实体读 run。
  expect(calls.filter(call => call.url.endsWith(`/runs/${f.run.id}`))).toHaveLength(0);
}, 20_000);

it("R3-4 旧 queued 消息离开最新快照页后取得真实终态，不永久轮询（修前缺陷）", async () => {
  const a = conversationFixture("stale", "离页排队"), b = conversationFixture("fresh-b", "新会话");
  const queued = messageFixture({ id: "msg-stale", role: "user", state: "queued", requestId: "req-stale", text: "还在排队" });
  const completed = messageFixture({ id: "msg-stale", role: "user", state: "completed", requestId: "req-stale", text: "还在排队", revision: 2 });
  let left = false;
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { "fresh-b": snapshotFixture(b) }, onRequest: url => {
    if (url.endsWith("/stale/snapshot")) {
      return { status: 200, body: left ? { ...snapshotFixture(a), activeRequestId: null } : { ...snapshotFixture(a, { messages: [queued] }), activeRequestId: "req-stale" } };
    }
    if (url.endsWith("/messages/msg-stale")) return { status: 200, body: completed };
    return null;
  } });
  renderAt("/agent/stale");
  await screen.findByRole("heading", { name: "离页排队" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  left = true;
  await userEvent.click(screen.getByRole("button", { name: "新会话" }));
  await screen.findByRole("heading", { name: "新会话" });
  // 离页 queued 只能靠单实体读取取回真实终态（复用 message.changed 的合并缝）。
  await waitFor(() => expect(calls.some(call => call.url.endsWith("/messages/msg-stale"))).toBe(true), { timeout: 6500 });
  const stabilized = snapshotGetCount(calls, "stale");
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(snapshotGetCount(calls, "stale")).toBe(stabilized);
  expect(calls.filter(call => call.url.endsWith("/messages/msg-stale"))).toHaveLength(1);
}, 20_000);

it("R3-7 A→B→A 快速往返：在途离页补读不被代际守卫吞掉，真实终态回到列表（修前缺陷）", async () => {
  const a = conversationFixture("race", "竞态会话"), b = conversationFixture("race-b", "落脚会话");
  const queued = messageFixture({ id: "msg-race", role: "user", state: "queued", requestId: "req-race", text: "排队中的那句" });
  const completed = messageFixture({ id: "msg-race", role: "user", state: "completed", requestId: "req-race", text: "排队中的那句", revision: 2 });
  type Deferred = (value: RouteResult) => void;
  const deferreds: Deferred[] = [];
  let left = false;
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { "race-b": snapshotFixture(b) }, onRequest: url => {
    if (url.endsWith("/race/snapshot")) {
      return { status: 200, body: left ? { ...snapshotFixture(a), activeRequestId: null } : { ...snapshotFixture(a, { messages: [queued] }), activeRequestId: "req-race" } };
    }
    if (url.endsWith("/messages/msg-race")) return new Promise<RouteResult>(resolve => { deferreds.push(resolve); });
    return null;
  } });
  vi.useFakeTimers();
  // 假时钟下 user-event 的指针延时会挂起；fireEvent 无定时器依赖。
  const click = (name: string | RegExp) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
  try {
    renderAt("/agent/race");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("heading", { name: "竞态会话" })).toBeInTheDocument();
    expect(screen.getByText("排队中的那句")).toBeInTheDocument();
    left = true;
    await click("落脚会话");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("heading", { name: "落脚会话" })).toBeInTheDocument();
    // 离开后首个 tick：快照显示 msg-race 已离页 → 记录 queuedOffPage 并发起单实体补读（挂起）。
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(deferreds).toHaveLength(1);
    // 补读在途时快速切回 A：latest 重建丢掉 messages 里的 queued 条目，代际 +1。
    // 推进超过一个轮询周期，确保重建落定，尚未返回的补读也没有被重复发出。
    await click(/竞态会话/);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("heading", { name: "竞态会话" })).toBeInTheDocument();
    // 重建后消息列表不再有该条，但请求仍在排队条以「已等待」显示——等待补读给真实终态。
    expect(screen.getByText(/已等待/)).toBeInTheDocument();
    // 补读此刻返回真实终态。修前：代际守卫吞掉合并 → 排队条永久「已等待」，消息不回列表且无重试路径。
    await act(async () => { deferreds[0]!({ status: 200, body: completed }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("排队中的那句")).toBeInTheDocument();
    // 合并触发的批量快照（120ms 节流）落定后，排队条消失、无「已排队」状态残留。
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText(/已等待/)).toBeNull();
    expect(screen.queryByText("已排队")).toBeNull();
    // 终态稳定：不再对该会话轮询或重复补读。
    const stabilized = snapshotGetCount(calls, "race");
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(snapshotGetCount(calls, "race")).toBe(stabilized);
    expect(deferreds).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
}, 20_000);

it("R3-8 离页消息补读失败后重新出现在快照中仍排队，读到终态才停止补读", async () => {
  const a = conversationFixture("r3-retry-a", "后台重试 A"), b = conversationFixture("r3-retry-b", "当前对话 B");
  const queued = messageFixture({ id: "r3-retry-message", role: "user", requestId: "r3-retry-request", state: "queued", text: "A 的排队请求" });
  const terminal: Message = { ...queued, state: "stopped", revision: 2 };
  const latest = messageFixture({ id: "r3-retry-latest", role: "assistant", text: "A 的最新消息" });
  const bMessage = messageFixture({ id: "r3-retry-peer", role: "assistant", text: "B 的对话消息" });
  const onPage = snapshotFixture(a, { messages: [queued, latest] });
  const snapshots = { [a.id]: onPage, [b.id]: snapshotFixture(b, { messages: [bMessage] }) };
  const messageUrl = `/api/agent/v1/messages/${queued.id}`;
  let attempts = 0;
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots, onRequest: url => {
    if (url !== messageUrl) return null;
    if (++attempts === 1) return { status: 503, body: { code: "UNAVAILABLE", message: "消息暂时不可读取" } };
    return { status: 200, body: terminal };
  } });
  const messageReads = () => calls.filter(call => call.method === "GET" && call.url === messageUrl).length;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const switchTo = (title: string) => act(async () => { fireEvent.click(within(screen.getByRole("navigation", { name: "会话列表" })).getByRole("button", { name: title })); });

  vi.useFakeTimers();
  try {
    renderAt(`/agent/${a.id}`);
    await advance(0);
    expect(screen.getByText("已排队")).toBeInTheDocument();
    const initialAStream = FakeEventSource.instances[0]!;
    expect(initialAStream.url).toBe(`/api/agent/v1/conversations/${a.id}/events?cursor=cursor-${a.id}`);
    await switchTo(b.title);
    const bStream = FakeEventSource.instances.at(-1)!;
    expect(initialAStream.closed).toBe(true);
    expect(bStream.url).toBe(`/api/agent/v1/conversations/${b.id}/events?cursor=cursor-${b.id}`);
    fireEvent.change(screen.getByRole("textbox", { name: "消息输入" }), { target: { value: "B 的草稿" } });

    snapshots[a.id] = snapshotFixture(a, { messages: [latest] });
    await advance(2000);
    expect(snapshotGetCount(calls, a.id)).toBe(2);
    expect(messageReads()).toBe(1);
    snapshots[a.id] = onPage;
    await advance(2000);
    expect(snapshotGetCount(calls, a.id)).toBe(3);
    expect(messageReads(), "仍然 queued 的快照不能取消上次失败的定向读取").toBe(2);

    await advance(6000);
    expect(messageReads()).toBe(2);
    expect(snapshotGetCount(calls, a.id)).toBe(3);
    expect(FakeEventSource.instances).toEqual([initialAStream, bStream]);
    expect(bStream.closed).toBe(false);
    expect(screen.getByText(bMessage.text)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("B 的草稿");
    expect(screen.queryByText(queued.text)).toBeNull();
    expect(screen.queryByText(latest.text)).toBeNull();
    expect(screen.queryByText("消息暂时不可读取")).toBeNull();

    // 切回 A 时最新窗口重建，返回的快照仍带较旧的 queued 修订。
    await switchTo(a.title);
    expect(snapshotGetCount(calls, a.id)).toBe(4);
    expect(screen.getByRole("region", { name: "本轮结果" })).toHaveTextContent("本轮已停止");
    expect(screen.getByText(queued.text).closest("[data-message-id]")).toHaveTextContent("已停止");
  } finally {
    vi.useRealTimers();
  }
});

it("R3-9 切回后重连采用快照游标，迟到的旧页和消息事件不覆盖补读终态", async () => {
  const a = conversationFixture("r3-cursor-a", "重连对话 A"), b = conversationFixture("r3-cursor-b", "临时对话 B");
  const history = messageFixture({ id: "r3-cursor-history", role: "assistant", text: "A 的更早消息" });
  const queued = messageFixture({ id: "r3-cursor-message", role: "user", requestId: "r3-cursor-request", state: "queued", text: "A 的待处理消息" });
  const running: Message = { ...queued, state: "running", revision: 2 };
  const terminal: Message = { ...queued, state: "stopped", revision: 3 };
  const latest = messageFixture({ id: "r3-cursor-latest", role: "assistant", text: "A 的当前页消息" });
  const offPage = snapshotFixture(a, { messages: [latest] });
  offPage.messages.nextCursor = "history-page / 2";
  let aResponse: RouteResult = { status: 200, body: snapshotFixture(a, { messages: [queued] }) };
  let finishMessage!: (value: RouteResult) => void, finishOldRead!: (value: RouteResult) => void, finishPage!: (value: RouteResult) => void;
  const messageResult = new Promise<RouteResult>(resolve => { finishMessage = resolve; });
  const oldReadResult = new Promise<RouteResult>(resolve => { finishOldRead = resolve; });
  const pageResult = new Promise<RouteResult>(resolve => { finishPage = resolve; });
  const messageUrl = `/api/agent/v1/messages/${queued.id}`;
  const pageUrl = `/api/agent/v1/conversations/${a.id}/messages?cursor=history-page%20%2F%202`;
  let messageReads = 0;
  const calls = installWorkbenchRoutes({ conversations: [a, b], onRequest: url => {
    if (url.endsWith(`/${a.id}/snapshot`)) return aResponse;
    if (url === pageUrl) return pageResult;
    if (url === messageUrl) {
      messageReads++;
      if (messageReads === 1) return messageResult;
      if (messageReads === 2) return oldReadResult;
    }
    return null;
  } });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });

  vi.useFakeTimers();
  try {
    renderAt(`/agent/${a.id}`);
    await advance(0);
    expect(screen.getByText("已排队")).toBeInTheDocument();
    await click(b.title);
    aResponse = { status: 200, body: offPage };
    await advance(2000);
    expect(messageReads).toBe(1);

    await click(a.title);
    const interrupted = FakeEventSource.instances.at(-1)!;
    expect(interrupted.url).toBe(`/api/agent/v1/conversations/${a.id}/events?cursor=cursor-${a.id}`);
    expect(screen.getByText(latest.text)).toBeInTheDocument();
    expect(screen.getByText("1 条请求排队")).toBeInTheDocument();
    expect(screen.queryByText("已排队")).toBeNull();
    await click("加载更早的消息");
    expect(calls.filter(call => call.method === "GET" && call.url === pageUrl)).toHaveLength(1);
    aResponse = { status: 503, body: { code: "UNAVAILABLE", message: "SSE 重连暂不可用" } };
    interrupted.emit("reset_required", { reason: "cursor_expired" });
    await advance(0);
    expect(screen.getByText("SSE 重连暂不可用")).toBeInTheDocument();
    expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(0);
    aResponse = { status: 200, body: { ...offPage, eventCursor: "resume/A + 17" } };
    await act(async () => { window.dispatchEvent(new Event("online")); });
    const resumed = FakeEventSource.instances.at(-1)!;
    expect(FakeEventSource.instances.filter(source => !source.closed)).toEqual([resumed]);
    expect(resumed.url).toBe(`/api/agent/v1/conversations/${a.id}/events?cursor=resume%2FA%20%2B%2017`);
    const streamCount = FakeEventSource.instances.length;

    const olderEvent = { eventId: "r3-old-event", cursor: "older-event", conversationId: a.id, kind: "message.changed", entityId: queued.id, entityVersion: 1, notification: "quiet", createdAt: queued.createdAt };
    resumed.emit("business", olderEvent);
    expect(messageReads).toBe(2);
    // 当前的 A 流使用真实游标，在 B 发起的补读此时才返回。
    await act(async () => { finishMessage({ status: 200, body: terminal }); });
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(streamCount);
    expect(resumed.closed).toBe(false);

    interrupted.emit("business", { ...olderEvent, eventId: "r3-retired-stream-event" });
    expect(messageReads).toBe(2);
    await act(async () => { finishOldRead({ status: 200, body: running }); });
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByText("处理中")).toBeNull();

    await act(async () => { finishPage({ status: 200, body: { items: [history, queued], nextCursor: null, watermark: "history-watermark" } }); });
    await advance(120);
    expect(screen.getByText(history.text)).toBeInTheDocument();
    expect(screen.getAllByText(queued.text)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "加载更早的消息" })).toBeNull();
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByText("已排队")).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(streamCount);
    expect(resumed.closed).toBe(false);

    await click(b.title);
    const stable = snapshotGetCount(calls, a.id);
    await advance(6000);
    expect(messageReads).toBe(2);
    expect(snapshotGetCount(calls, a.id)).toBe(stable);
  } finally {
    vi.useRealTimers();
  }
});

it("R3-10 切回 A 后在途离页补读失败一次，留在 A 自动取回终态", async () => {
  const a = conversationFixture("retry-return-a", "原对话 A"), b = conversationFixture("retry-return-b", "临时对话 B");
  const queued = messageFixture({ id: "retry-return-message", role: "user", requestId: "retry-return-request", state: "queued", text: "A 留在上一页的请求" });
  const completed: Message = { ...queued, state: "completed", revision: 2 };
  const bMessage = messageFixture({ id: "retry-return-peer", role: "assistant", text: "B 的独立回复" });
  const snapshots = { [a.id]: snapshotFixture(a, { messages: [queued] }), [b.id]: snapshotFixture(b, { messages: [bMessage] }) };
  const messageUrl = `/api/agent/v1/messages/${queued.id}`;
  const responses: ((value: RouteResult) => void)[] = [];
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots, onRequest: url => url === messageUrl
    ? new Promise<RouteResult>(resolve => { responses.push(resolve); }) : null });
  const messageReads = () => calls.filter(call => call.method === "GET" && call.url === messageUrl).length;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const switchTo = (title: string) => act(async () => { fireEvent.click(within(screen.getByRole("navigation", { name: "会话列表" })).getByRole("button", { name: title })); });

  vi.useFakeTimers();
  try {
    renderAt(`/agent/${a.id}`);
    await advance(0);
    const composer = () => screen.getByRole("textbox", { name: "消息输入" });
    fireEvent.change(composer(), { target: { value: "A 的草稿" } });
    await switchTo(b.title);
    fireEvent.change(composer(), { target: { value: "B 的草稿" } });
    snapshots[a.id] = snapshotFixture(a);
    await advance(2000);
    expect(messageReads()).toBe(1);

    await switchTo(a.title);
    expect(screen.getByText(/已等待/)).toBeInTheDocument();
    expect(composer()).toHaveValue("A 的草稿");
    const stream = FakeEventSource.instances.at(-1)!;
    const snapshotCount = snapshotGetCount(calls, a.id);
    await advance(4000);
    expect(messageReads()).toBe(1);
    await act(async () => { responses[0]!({ status: 503, body: { code: "UNAVAILABLE", message: "暂不可读取" } }); });
    await advance(2000);
    expect(messageReads()).toBe(2);
    expect(snapshotGetCount(calls, a.id)).toBe(snapshotCount);
    await advance(4000);
    expect(messageReads()).toBe(2);
    await act(async () => { responses[1]!({ status: 200, body: completed }); });
    expect(screen.queryByText(/已等待/)).toBeNull();
    expect(screen.getByText(queued.text).closest("[data-message-id]")).toHaveAttribute("data-state", "completed");
    await advance(120);
    const settledSnapshots = snapshotGetCount(calls, a.id);
    await advance(6000);
    expect(messageReads()).toBe(2);
    expect(snapshotGetCount(calls, a.id)).toBe(settledSnapshots);
    expect(FakeEventSource.instances.filter(source => !source.closed)).toEqual([stream]);

    await switchTo(b.title);
    expect(composer()).toHaveValue("B 的草稿");
    expect(screen.getByText(bMessage.text)).toBeInTheDocument();
    expect(screen.queryByText(queued.text)).toBeNull();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("R3-11 刷新直达历史消息时，最新快照游标跨过的终态仍可按消息 ID 补读", async () => {
  const conversation = conversationFixture("retry-anchor", "定位旧请求");
  const queued = messageFixture({ id: "retry-anchor-message", role: "user", requestId: "retry-anchor-request", state: "queued", text: "定位的旧请求" });
  const completed: Message = { ...queued, state: "completed", revision: 2 };
  const newer = messageFixture({ id: "retry-anchor-newer", role: "assistant", text: "定位窗口以后的回复" });
  const messageUrl = `/api/agent/v1/messages/${queued.id}`;
  const anchorUrl = `/api/agent/v1/conversations/${conversation.id}/messages?anchorMessageId=${queued.id}`;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation, { messages: [newer] }) }, onRequest: url => {
    if (url === anchorUrl) return { status: 200, body: { items: [queued], nextCursor: null, watermark: "anchor-before-completion" } };
    if (url === messageUrl) return { status: 200, body: completed };
    return null;
  } });

  vi.useFakeTimers();
  try {
    renderAt(`/agent/${conversation.id}?anchor=${queued.id}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const row = screen.getByText(queued.text).closest("[data-message-id]");
    expect(row).toHaveAttribute("data-anchor", "true");
    expect(row).toHaveAttribute("data-state", "queued");
    const stream = FakeEventSource.instances.at(-1)!;
    await act(async () => { await vi.advanceTimersByTimeAsync(2120); });
    expect(row).toHaveAttribute("data-state", "completed");
    expect(screen.queryByText(newer.text)).toBeNull();
    expect(FakeEventSource.instances.filter(source => !source.closed)).toEqual([stream]);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(calls.filter(call => call.method === "GET" && call.url === messageUrl)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("R3-5 后台补读单次>2s：不叠加请求、不被序号饿死、最新有效结果进缓存（修前缺陷）", async () => {
  const a = conversationFixture("slow", "慢响应"), b = conversationFixture("fast-b", "快会话");
  type Deferred = (value: RouteResult) => void;
  const deferreds: Deferred[] = [];
  let armed = false;
  const activeSnapshot = () => ({ ...snapshotFixture(a), activeRequestId: "req-slow" as string | null });
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { slow: activeSnapshot(), "fast-b": snapshotFixture(b) }, onRequest: url => {
    if (armed && url.endsWith("/slow/snapshot")) return new Promise<RouteResult>(resolve => { deferreds.push(resolve); });
    return null;
  } });
  vi.useFakeTimers();
  // 假时钟下 user-event 的指针延时会挂起；fireEvent 无定时器依赖。
  const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
  try {
    renderAt("/agent/slow");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("heading", { name: "慢响应" })).toBeInTheDocument();
    armed = true;
    await click("快会话");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("heading", { name: "快会话" })).toBeInTheDocument();
    // 4 个 tick 全部在途未返回：同一会话只允许 1 个在途补读（修前：每 tick 叠加到 4）。
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(deferreds).toHaveLength(1);
    // 慢响应携带新产物返回时必须被接受（修前：更新序号已发出，本响应被丢弃，通知永不出现）。
    const art1 = artifactFixture("art-slow-1", "迟到产物一", "rev-1", 1);
    await act(async () => { deferreds[0]!({ status: 200, body: { ...snapshotFixture(a, { artifacts: [art1] }), activeRequestId: "req-slow" } }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTitle("有新产出")).toBeInTheDocument();
    // 上一响应落地后下一 tick 才补新请求；结果依次进缓存，不饿死。
    const before = snapshotGetCount(calls, "slow");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(snapshotGetCount(calls, "slow")).toBe(before + 1);
    const art2 = artifactFixture("art-slow-2", "迟到产物二", "rev-1", 1);
    await act(async () => { deferreds.at(-1)!({ status: 200, body: { ...snapshotFixture(a, { artifacts: [art1, art2] }), activeRequestId: "req-slow" } }); await vi.advanceTimersByTimeAsync(0); });
    // 终态响应（activeRequestId=null）接受后轮询停止。
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(deferreds.length).toBe(3);
    await act(async () => { deferreds.at(-1)!({ status: 200, body: { ...snapshotFixture(a, { artifacts: [art1, art2] }), activeRequestId: null } }); await vi.advanceTimersByTimeAsync(0); });
    const stopped = snapshotGetCount(calls, "slow");
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(snapshotGetCount(calls, "slow")).toBe(stopped);
    // 切回后能看到缓存里的最新有效结果（迟到产物已进 cache，由恢复入口重建视图）。
    // 徽标在按钮内部，可访问名变为「慢响应 有新产出」，用部分匹配定位。
    armed = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /慢响应/ })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole("heading", { name: "迟到产物一" })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
}, 20_000);

it("R3-6 组件卸载后不再发起后台补读", async () => {
  const a = conversationFixture("gone", "卸载会话"), b = conversationFixture("stay-b", "留守会话");
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: {
    gone: { ...snapshotFixture(a), activeRequestId: "req-gone" }, "stay-b": snapshotFixture(b),
  } });
  const ui = renderAt("/agent/gone");
  await screen.findByRole("heading", { name: "卸载会话" });
  await waitFor(() => expect(FakeEventSource.instances.some(source => !source.closed)).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "留守会话" }));
  await screen.findByRole("heading", { name: "留守会话" });
  const before = snapshotGetCount(calls, "gone");
  ui.unmount();
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(snapshotGetCount(calls, "gone")).toBe(before);
}, 15_000);

it("A-07/32 历史引用固定版本；新 head 不改阅读；历史稿只读，意见只对最新稿（B03/A10）", async () => {
  const conversation = conversationFixture("a", "版本讨论");
  let head = artifactFixture("art-1", "脚本", "rev-2", 2);
  const oldMessage = messageFixture({ id: "old-message", role: "assistant", text: "历史交付", references: { artifacts: [{ artifactId: "art-1", revisionId: "rev-1" }], proposalIds: [], runIds: [], materialBatchIds: [] } });
  const calls = installWorkbenchRoutes({ conversations: [conversation], onRequest: (url, call) => {
    if (url.endsWith("/a/snapshot")) return { status: 200, body: snapshotFixture(conversation, { artifacts: [head], messages: [oldMessage] }) };
    if (url.endsWith("/artifacts/art-1")) return { status: 200, body: head };
    if (url.includes("/revisions/")) { const revisionId = url.split("/").at(-1)!; return { status: 200, body: { ...REVISION_FIXTURE, revisionId, revisionNumber: Number(revisionId.at(-1)), content: { format: "markdown", text: `正文 ${revisionId}` } } }; }
    if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { messageId: "feedback-1" } };
    return null;
  } });
  renderAt("/agent/a");
  await userEvent.click((await screen.findAllByRole("button", { name: "脚本 · v1，现名：脚本" }))[0]!);
  expect(await screen.findByText("正文 rev-1")).toBeInTheDocument();
  // 历史修订统一只读：不暴露会被服务端拒绝的旧稿意见/修改入口。
  expect(screen.getByText("历史版本仅阅读")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "只记录意见" })).toBeNull();
  expect(screen.queryByRole("button", { name: "提意见" })).toBeNull();
  head = artifactFixture("art-1", "脚本", "rev-3", 3);
  const source = FakeEventSource.instances.find(item => !item.closed)!;
  source.emit("business", { eventId: "event-new", kind: "artifact.delivered", notification: "new_output", entityId: "art-1", entityVersion: 3 });
  await userEvent.click(screen.getByText("脚本 v1", { selector: "summary" }));
  await screen.findByRole("button", { name: "查看最新 v3" });
  expect(screen.getByText("正文 rev-1")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "查看最新 v3" }));
  expect(await screen.findByText("正文 rev-3")).toBeInTheDocument();
  // 最新稿可记录意见；提交目标就是当前最新修订。
  await userEvent.click(screen.getByRole("button", { name: "只记录意见" }));
  await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "对最新版的意见");
  await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
  await waitFor(() => expect(calls.find(call => call.method === "POST" && call.url.endsWith("/feedback"))?.body).toMatchObject({ target: { revisionId: "rev-3" }, text: "对最新版的意见" }));
});

// R4/A11：历史引用卡主识别用「类型·准确版本」；产物改名升版后当前名只作补充说明，点击仍开原修订。
it("R4 产物改名并升到 v3 后：历史引用卡主识别仍是「脚本 · v1」，现名只是补充，点击打开 v1 原文", async () => {
  const conversation = conversationFixture("rename", "改名回看");
  const oldMessage = messageFixture({ id: "old-message", role: "assistant", text: "当时的交付", references: { artifacts: [{ artifactId: "art-1", revisionId: "rev-1" }], proposalIds: [], runIds: [], materialBatchIds: [] } });
  const calls = installWorkbenchRoutes({ conversations: [conversation], onRequest: url => {
    if (url.endsWith("/rename/snapshot")) return { status: 200, body: snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "定稿方案", "rev-3", 3)], messages: [oldMessage] }) };
    if (url.endsWith("/artifacts/art-1")) return { status: 200, body: artifactFixture("art-1", "定稿方案", "rev-3", 3) };
    if (url.includes("/revisions/")) { const revisionId = url.split("/").at(-1)!; return { status: 200, body: { ...REVISION_FIXTURE, revisionId, revisionNumber: Number(revisionId.at(-1)), content: { format: "markdown", text: `正文 ${revisionId}` } } }; }
    return null;
  } });
  renderAt("/agent/rename");
  const row = (await screen.findByText("当时的交付")).closest("[data-message-id]") as HTMLElement;
  const card = within(row).getByRole("button", { name: "脚本 · v1，现名：定稿方案" });
  expect(within(card).getByText("脚本 · v1").tagName).toBe("STRONG");
  expect(within(card).getByText("现名：定稿方案")).toBeInTheDocument();
  await userEvent.click(card);
  expect(await screen.findByText("正文 rev-1")).toBeInTheDocument();
  expect(screen.queryByText("正文 rev-3")).toBeNull();
  expect(calls.filter(call => call.url.endsWith("/revisions/rev-1"))).toHaveLength(1);
});

it("重新打开已有对话时，保留已阅读的旧版本，不自动换成最新产出", async () => {
  const conversation = conversationFixture("a", "恢复阅读");
  localStorage.setItem("vf:agent-reading:a", JSON.stringify({ artifactId: "art-1", revisionId: "rev-1" }));
  installWorkbenchRoutes({ conversations: [conversation], snapshots: {
    a: snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "脚本", "rev-2", 2)] }),
  }, onRequest: url => url.includes("/revisions/") ? { status: 200, body: {
    ...REVISION_FIXTURE, revisionId: url.split("/").at(-1)!,
    content: { format: "markdown", text: `恢复正文 ${url.split("/").at(-1)}` },
  } } : null });
  renderAt("/agent/a");
  expect(await screen.findByText("恢复正文 rev-1")).toBeInTheDocument();
  expect(screen.queryByText("恢复正文 rev-2")).toBeNull();
});

it("U03/B02 无创作事项的普通聊天点开素材消息：准确批次独立预览，不建事项不重搜", async () => {
  const conversation = conversationFixture("conv-m", "素材闲聊");
  const message = messageFixture({ id: "msg-m", role: "assistant", text: "帮你找了几张参考。",
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: ["batch-solo"] } });
  const calls = installWorkbenchRoutes({ conversations: [conversation], onRequest: url => {
    if (url.endsWith("/conv-m/snapshot")) return { status: 200, body: snapshotFixture(conversation, { messages: [message] }) };
    if (url.endsWith("/material-batches/batch-solo")) return { status: 200, body: {
      batchId: "batch-solo", revision: 1, requestId: "req-m", toolCallId: "call-m",
      query: { kind: "image", query: "城市街景", limit: 6 }, retrievedAt: "2026-01-01T00:00:00.000Z", messageId: "msg-m",
      results: [{ candidateId: "c-m", provider: "pexels", providerAssetId: "px-c-m", kind: "image", title: "街景参考甲",
        sourceUrl: "https://www.pexels.com/photo/c-m/", creatorName: "作者乙", creatorUrl: "https://www.pexels.com/@b/",
        previewUrl: "https://images.pexels.com/c-m.jpg", width: 1920, height: 1280, durationMs: null,
        licenseUrl: "https://www.pexels.com/license/c-m/" }],
    } };
    return null;
  } });
  renderAt("/agent/conv-m");
  await screen.findByText("帮你找了几张参考。");
  const row = document.querySelector('[data-message-id="msg-m"]')! as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: /素材/ }));
  expect(await screen.findByTestId("standalone-batch")).toBeInTheDocument();
  expect(await screen.findByText("街景参考甲")).toBeInTheDocument();
  expect(screen.getByText("城市街景")).toBeInTheDocument();
  // 只读取该批次详情一次；不创建事项、不重发搜索、无任何写请求。
  expect(calls.filter(call => call.method === "GET" && call.url.endsWith("/material-batches/batch-solo"))).toHaveLength(1);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  expect(calls.filter(call => call.url.includes("/works"))).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await waitFor(() => expect(screen.queryByTestId("standalone-batch")).toBeNull());
});

it("音乐候选保留原批次顺序，采用第二首用准确引用且重试不丢聊天草稿", async () => {
  const conversation = conversationFixture("conv-music", "音乐闲聊");
  const snapshot = snapshotFixture(conversation, { messages: [messageFixture({ id: "music-search", role: "assistant", text: "这是先前的两首候选。",
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: ["audio-old"] } })] });
  snapshot.materialBatches = [{ batchId: "audio-new", requestId: "new-search", messageId: null,
    query: { provider: "freetouse", kind: "audio", query: "新的音乐搜索", limit: 2 }, retrievedAt: "2026-01-02T00:00:00Z", resultCount: 2 }];
  const batch: MaterialBatch = {
    batchId: "audio-old", revision: 1, requestId: "old-search", toolCallId: "music-call", messageId: "music-search",
    query: { provider: "freetouse", kind: "audio", query: "雨后音乐", limit: 2 }, retrievedAt: "2026-01-01T00:00:00Z",
    results: [
      { candidateId: "old-song-1", provider: "freetouse", providerAssetId: "track-1", kind: "audio", title: "After Rain", creatorName: "作者甲、作者乙", creatorUrl: null,
        sourceUrl: "https://freetouse.com/music/track-1", previewUrl: "https://cdn.example.com/preview.mp3", width: null, height: null, durationMs: 124000,
        licenseUrl: "https://freetouse.com/license", licenseName: "FreeToUse Non-Premium", usageScope: "个人社交平台 UGC，需署名", attributionText: "After Rain by 作者甲、作者乙 — https://freetouse.com/music", vocalKind: "song", lyricsLanguage: "en" },
      { candidateId: "old-song-2", provider: "freetouse", providerAssetId: "track-2", kind: "audio", title: "未标声乐的曲目", creatorName: null, creatorUrl: null,
        sourceUrl: "https://freetouse.com/music/track-2", previewUrl: null, width: null, height: null, durationMs: null, licenseUrl: "https://freetouse.com/license" },
    ],
  };
  let attempts = 0;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-music": snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/material-batches/audio-old")) return { status: 200, body: batch };
    if (call.method === "POST" && url.endsWith("/messages")) {
      if (++attempts === 1) {
        snapshot.messages.items.push(messageFixture({ id: "music-adopt", role: "user", text: (call.body as MessageInput).text }));
        throw new TypeError("response lost");
      }
      return { status: 202, body: { requestId: "music-request", messageId: "music-adopt", state: "completed", replayed: true, runId: null } };
    }
    return null;
  } });
  renderAt("/agent/conv-music");
  const input = await screen.findByRole("textbox", { name: "消息输入" });
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, "下一条还没发的想法");
  const message = document.querySelector('[data-message-id="music-search"]') as HTMLElement;
  await userEvent.click(within(message).getByRole("button", { name: /素材/ }));
  const pane = await screen.findByTestId("standalone-batch");
  await within(pane).findByText("After Rain");
  expect(Array.from(pane.querySelectorAll("ol > li strong"), item => item.textContent)).toEqual(["After Rain", "未标声乐的曲目"]);
  expect(within(pane).getByText(/124 秒 · 歌曲（来源标注） · 歌词语言：en/)).toBeInTheDocument();
  expect(within(pane).getByText("时长未知 · 声乐未知")).toBeInTheDocument();
  expect(within(pane).getByText(/采用后试听/)).toBeInTheDocument();
  expect(within(pane).getByRole("textbox", { name: "发布署名" })).toHaveValue(batch.results[0]!.attributionText);
  expect(pane.querySelectorAll("audio")).toHaveLength(1);
  expect(pane.querySelector("audio")).toHaveAttribute("src", "https://cdn.example.com/preview.mp3");
  expect(pane.querySelector("audio")).not.toHaveAttribute("autoplay");
  expect(pane.querySelector("img")).toBeNull();
  const adopt = within(pane).getByRole("button", { name: "采用「未标声乐的曲目」" });
  await userEvent.click(adopt);
  await screen.findByText("连接暂不可用，请检查服务后重试。");
  expect(input).toHaveValue("下一条还没发的想法");
  await userEvent.click(adopt);
  await waitFor(() => expect(attempts).toBe(2));
  const commands = calls.filter(call => call.method === "POST").map(call => call.body as MessageInput);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({ target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  expect(commands[0]!.text).toContain("/material-batches/audio-old#candidate=old-song-2");
  expect(commands[0]!.text).not.toContain("audio-new");
  expect(commands[0]!.text).not.toContain("personal_social_ugc");
  expect(commands[0]!.text).toContain("用途不明且影响许可时请先向我澄清");
  expect(commands[0]!.reviewConfirmation).toBeUndefined();
  const link = await screen.findByRole("link", { name: "「雨后音乐」原批次第 2 首音乐「未标声乐的曲目」" });
  expect(link.getAttribute("href")).toContain("/material-batches/audio-old#candidate=old-song-2");
  expect(document.querySelector('[data-message-id="music-adopt"]')).not.toHaveTextContent("old-song-2");
  expect(input).toHaveValue("下一条还没发的想法");
  expect(screen.queryByRole("tab", { name: /内容草稿/ })).toBeNull();
  expect(calls.filter(call => call.url.includes("/material-batches/")).map(call => call.url)).toEqual(["/api/agent/v1/material-batches/audio-old"]);
});

it("S1-08 恢复首页外旧修订时，不能丢弃快于快照的 head 读取", async () => {
  const conv = conversationFixture("restore-old", "分页后恢复阅读");
  localStorage.setItem("vf:agent-reading:restore-old", JSON.stringify({ artifactId: "old-art", revisionId: "old-v1" }));
  let release!: (value: RouteResult) => void;
  const pendingSnapshot = new Promise<RouteResult>(resolve => { release = resolve; });
  installWorkbenchRoutes({ conversations: [conv], onRequest: url => {
    if (url.endsWith("/snapshot")) return pendingSnapshot;
    if (url.endsWith("/artifacts/old-art")) return { status: 200, body: artifactFixture("old-art", "首页之外的旧作品", "old-v3", 3) };
    if (url.endsWith("/revisions/old-v1")) return { status: 200, body: { ...REVISION_FIXTURE, artifactId: "old-art", revisionId: "old-v1", content: { format: "markdown", text: "刷新后仍是第一版正文" } } };
    return null;
  } });
  renderAt("/agent/restore-old");
  await screen.findByRole("button", { name: "分页后恢复阅读" });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { release({ status: 200, body: snapshotFixture(conv, { artifacts: [artifactFixture("new-art", "较新作品", "new-v1", 1)] }) }); });
  expect(await screen.findByRole("heading", { name: "首页之外的旧作品" })).toBeInTheDocument();
  expect(screen.getByText("刷新后仍是第一版正文")).toBeInTheDocument();
  expect(screen.getByText("查看最新 v3")).toBeInTheDocument();
});

it("A-10 HTTP 回执丢失重试原 commandId，保留后来输入的草稿", async () => {
  const a = conversationFixture("a", "重试讨论"); let posts = 0;
  const calls = installWorkbenchRoutes({ conversations: [a], snapshots: { a: snapshotFixture(a) }, onRequest: (url, call) => {
    if (call.method !== "POST" || !url.endsWith("/messages")) return null;
    if (++posts === 1) throw new TypeError("response lost");
    return { status: 200, body: { requestId: "same-request", replayed: true } };
  } });
  renderAt("/agent/a"); await screen.findByRole("heading", { name: "重试讨论" });
  const text = screen.getByRole("textbox", { name: "消息输入" });
  await userEvent.type(text, "原来的要求"); await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  const retry = await screen.findByRole("button", { name: "重试上次发送（保留原请求）" });
  await userEvent.clear(text); await userEvent.type(text, "后来的草稿"); await userEvent.click(retry);
  await waitFor(() => expect(posts).toBe(2));
  const commands = calls.filter(call => call.method === "POST").map(call => call.body);
  expect(commands[1]).toEqual(commands[0]);
  expect(text).toHaveValue("后来的草稿");
});

it.each(["artifact", "proposal"] as const)("审计 F6：旧发送重试不清除同文字但改绑 %s 的新草稿", async kind => {
  const conv = conversationFixture("retry-binding", "重试绑定");
  const f = productionFixture(conv), snap = f.snapshot;
  const originalTarget = { artifactId: "art-1", revisionId: "rev-1", workId: null };
  const old = { commandId: "original-command", text: "把结尾改短一些", mode: "new", steerRequestId: null, skillId: null,
    target: kind === "artifact" ? originalTarget : null, proposalRef: kind === "proposal" ? { proposalId: "previous-proposal", digest: "b".repeat(64) } : null };
  const newArtifact = artifactFixture("art-2", "第二份作品", "rev-2", 1);
  snap.artifacts.items.push(newArtifact);
  localStorage.setItem(`vf:agent-send:${conv.id}`, JSON.stringify(old));
  saveDraft(conv.id, { text: old.text, targetArtifactId: null, targetRevisionId: null });
  const calls = installWorkbenchRoutes({ conversations: [conv], snapshots: { [conv.id]: snap }, onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 200, body: { replayed: true } };
    return null;
  } });
  renderAt(`/agent/${conv.id}`);
  if (kind === "artifact") {
    await userEvent.click(await screen.findByRole("button", { name: "第二份作品" }));
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
  } else await userEvent.click((await screen.findAllByRole("button", { name: "回复这份提案" }))[0]!);
  const before = loadDraft(conv.id);
  await userEvent.click(await screen.findByRole("button", { name: "重试上次发送（保留原请求）" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试上次发送（保留原请求）" })).toBeNull());
  expect(calls.find(call => call.method === "POST")?.body).toEqual(old);
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(old.text);
  expect(loadDraft(conv.id)).toEqual(before);
});

it("审计 F7：存储清理失败不能把服务端已成功的发送当作失败", async () => {
  const conv = conversationFixture("storage", "存储不可用"); let posts = 0;
  installWorkbenchRoutes({ conversations: [conv], snapshots: { storage: snapshotFixture(conv) }, onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) { posts++; return { status: 200, body: { replayed: false } }; }
    return null;
  } });
  renderAt("/agent/storage"); await screen.findByRole("heading", { name: "存储不可用" });
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });
  try {
    const text = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(text, "正常发送"); await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
    await waitFor(() => expect(text).toHaveValue(""));
    expect(posts).toBe(1); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试上次发送（保留原请求）" })).toBeNull();
  } finally { remove.mockRestore(); }
});

it("审计 F6 回归：无显式绑定的首次干预继承当前目标，未改动的草稿正常清空", async () => {
  const conv = conversationFixture("steer-draft", "干预当前制作前的改稿");
  const target = { artifactId: "art-1", revisionId: "rev-1", workId: null };
  const snap = snapshotFixture(conv, { messages: [messageFixture({ id: "active", role: "user", text: "改这份", requestId: "active-request", state: "running", target })] });
  snap.activeRequestId = "active-request";
  const calls = installWorkbenchRoutes({ conversations: [conv], snapshots: { [conv.id]: snap }, onRequest: (url, call) => call.method === "POST" && url.endsWith("/messages") ? { status: 200, body: { replayed: false } } : null });
  renderAt(`/agent/${conv.id}`); await screen.findByRole("heading", { name: conv.title });
  const text = screen.getByRole("textbox", { name: "消息输入" });
  await userEvent.type(text, "结尾再安静一点"); await userEvent.click(screen.getByRole("button", { name: "补充当前请求" }));
  await waitFor(() => expect(text).toHaveValue(""));
  expect(calls.find(call => call.method === "POST")?.body).toMatchObject({ mode: "steer", target, steerRequestId: "active-request" });
});

it.each([false, true])("审计 F5：末次费用事件补读失败保留重连入口，历史页=%s", async outsideFirstPage => {
  const conv = conversationFixture("billing-resync", "费用同步"), f = productionFixture(conv);
  const run = { ...f.run, state: "succeeded" as const, finance: { state: "pending_reconciliation" as const, currency: "CNY" as const, reservedMinor: 0, pendingUnknownMinor: 1200, settledMinor: 0, priceKind: "bounded" as const } };
  f.snapshot.runs.items = [run];
  f.snapshot.messages.items.push(messageFixture({ id: "finished-run", role: "system_notice", text: "执行结束，费用待核", references: { artifacts: [], proposalIds: [], runIds: [run.id], materialBatchIds: [] } }));
  let failReads = false;
  let latest: Run = run;
  installWorkbenchRoutes({ conversations: [conv], snapshots: { [conv.id]: f.snapshot }, onRequest: url => {
    if (url.endsWith(`/runs/${run.id}`)) { if (failReads) throw new TypeError("offline until restored"); return { status: 200, body: latest }; }
    return null;
  } });
  renderAt(`/agent/${conv.id}`); await screen.findByRole("heading", { name: "费用同步" });
  await userEvent.click(screen.getByRole("button", { name: "制作记录 · 1" }));
  await screen.findByText(/供应商账单待核对/);
  await waitFor(() => expect(FakeEventSource.instances.some(s => !s.closed)).toBe(true));
  // 自动补读与手动重连可交错；按网络状态失败，不假定谁先消耗第几次读取。
  failReads = true;
  latest = { ...run, revision: 2, finance: { state: "settled", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 1200, priceKind: "bounded" } };
  f.snapshot.runs.items = outsideFirstPage ? [] : [latest];
  FakeEventSource.instances.find(s => !s.closed)!.emit("business", { eventId: "last-billing", kind: "run.changed", entityId: run.id, entityVersion: 2 });
  const reconnect = await screen.findByRole("button", { name: "重新连接" });
  if (!outsideFirstPage) failReads = false;
  await userEvent.click(reconnect);
  if (outsideFirstPage) {
    await screen.findByText(/部分最新状态尚未同步/);
    failReads = false;
    await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
  }
  expect(await screen.findByText(/费用已核对/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
});

it("A-33/35 断流清掉临时字，重新快照且保留草稿，旧连接迟到内容不再进入", async () => {
  const a = conversationFixture("a", "连接恢复");
  let failNextSnapshot = false;
  const calls = installWorkbenchRoutes({ conversations: [a], snapshots: { a: snapshotFixture(a) }, onRequest: url => {
    if (failNextSnapshot && url.endsWith("/snapshot")) { failNextSnapshot = false; throw new TypeError("network offline"); }
    return null;
  } });
  renderAt("/agent/a"); await screen.findByRole("heading", { name: "连接恢复" });
  await waitFor(() => expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1));
  const source = FakeEventSource.instances[0]!;
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "保留草稿");
  source.emit("text.delta", { requestId: "r1", sequence: 0, text: "临时流式" });
  source.emit("text.delta", { requestId: "r1", sequence: 1, text: "文本" });
  expect(await screen.findByText("临时流式文本")).toBeInTheDocument();
  failNextSnapshot = true;
  act(() => source.onerror?.());
  expect(screen.queryByText("临时流式文本")).toBeNull();
  await screen.findByText("连接暂不可用。已保留当前阅读和草稿。", {}, { timeout: 2500 });
  await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
  expect(screen.queryByText("连接暂不可用。已保留当前阅读和草稿。")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  source.emit("text.delta", { requestId: "r1", sequence: 2, text: "已关闭连接的迟到内容" });
  expect(screen.queryByText("已关闭连接的迟到内容")).toBeNull();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留草稿");
  expect(calls.filter(call => call.url.endsWith("/snapshot"))).toHaveLength(3);
});

// R6 慢连接拼错进行中回复的客户端守卫：未见本轮第 0 帧、也非新段开头（replace）的
// 流中段增量不拼接；第 0 帧或 replace 帧到达后正常恢复显示。
it("R6 流中段增量不拼接，第 0 帧或新段开头到达后恢复", async () => {
  const a = conversationFixture("a", "慢读恢复");
  installWorkbenchRoutes({ conversations: [a], snapshots: { a: snapshotFixture(a) } });
  renderAt("/agent/a"); await screen.findByRole("heading", { name: "慢读恢复" });
  await waitFor(() => expect(FakeEventSource.instances.filter(source => !source.closed)).toHaveLength(1));
  const source = FakeEventSource.instances[0]!;
  source.emit("text.delta", { requestId: "r9", sequence: 3, text: "流中段缺上文" });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(screen.queryByText(/流中段缺上文/)).toBeNull();
  source.emit("text.delta", { requestId: "r9", sequence: 0, text: "从第 0 帧开始" });
  expect(await screen.findByText("从第 0 帧开始")).toBeInTheDocument();
  source.emit("text.delta", { requestId: "r9", sequence: 4, text: "新段开头", replace: true });
  expect(await screen.findByText("新段开头")).toBeInTheDocument();
  expect(screen.queryByText(/从第 0 帧开始/)).toBeNull();
});

it("A-32 首屏之外的产物按事件 ID 读取；旧分页晚到不覆盖新版本", async () => {
  const a = conversationFixture("a", "许多产物");
  const artifacts = Array.from({ length: 50 }, (_, i) => artifactFixture(`art-${i + 1}`, `产物 ${i + 1}`, `rev-${i + 1}`, 1));
  const snapshot = snapshotFixture(a, { artifacts }); snapshot.artifacts.nextCursor = "older-page";
  let resolvePage!: (value: RouteResult) => void;
  const page = new Promise<RouteResult>(resolve => { resolvePage = resolve; });
  const calls = installWorkbenchRoutes({ conversations: [a], snapshots: { a: snapshot }, onRequest: url => {
    if (url.includes("/artifacts?cursor=")) return page;
    if (url.endsWith("/artifacts/old")) return { status: 200, body: artifactFixture("old", "早先的产物", "old-v3", 3) };
    if (url.endsWith("/revisions/old-v3")) return { status: 200, body: { ...REVISION_FIXTURE, artifactId: "old", revisionId: "old-v3", revisionNumber: 3, content: { format: "markdown", text: "旧产物的最新正文" } } };
    return null;
  } });
  renderAt("/agent/a");
  await userEvent.click(await screen.findByRole("button", { name: "产物 1" }));
  await screen.findByRole("heading", { name: "产物 1" });
  await userEvent.click(screen.getByRole("button", { name: "更多产物" }));
  FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "old-update", kind: "artifact.delivered", notification: "new_output", entityId: "old", entityVersion: 3 });
  await waitFor(() => expect(calls.some(call => call.url.endsWith("/artifacts/old"))).toBe(true));
  await screen.findByRole("button", { name: /早先的产物/ });
  await act(async () => resolvePage({ status: 200, body: { items: [artifactFixture("old", "早先的产物", "old-v1", 1)], nextCursor: null, watermark: "old-page-watermark" } }));
  expect(screen.getByRole("heading", { name: "产物 1" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /早先的产物/ }));
  expect(await screen.findByText("旧产物的最新正文")).toBeInTheDocument();
  expect(calls.some(call => call.url.endsWith("/revisions/old-v1"))).toBe(false);
});

it("A-07/32 改名刷新首屏后保留已加载的旧会话和翻页位置", async () => {
  let latest = conversationFixture("a", "最近会话");
  const older = conversationFixture("b", "较早会话");
  installWorkbenchRoutes({ conversations: [], onRequest: (url, call) => {
    if (call.method !== "GET") return null;
    if (url.endsWith("/conversations")) return { status: 200, body: { items: [latest], nextCursor: "older", watermark: "wm" } };
    if (url.includes("/conversations?cursor=")) return { status: 200, body: { items: [older], nextCursor: null, watermark: "wm" } };
    return null;
  }, onRename: () => {
    latest = conversationFixture("a", "改好的会话", 2);
    return { status: 200, body: latest };
  } });
  renderAt("/agent");
  await userEvent.click(await screen.findByRole("button", { name: "更多会话" }));
  await screen.findByRole("button", { name: "较早会话" });
  await userEvent.click(screen.getAllByRole("button", { name: "改名" })[0]!);
  await userEvent.clear(screen.getByRole("textbox", { name: "会话名称" }));
  await userEvent.type(screen.getByRole("textbox", { name: "会话名称" }), "改好的会话{Enter}");
  await screen.findByRole("button", { name: "改好的会话" });
  expect(screen.getByRole("button", { name: "较早会话" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更多会话" })).toBeNull();
});

it("Frame 首页可直接发送，创建会话后沿用该请求且不自动开始制作", async () => {
  const created = conversationFixture("conv-new", "新的会话");
  const calls = installWorkbenchRoutes({ conversations: [], snapshots: { "conv-new": snapshotFixture(created) }, onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { requestId: "new-request" } };
    return null;
  } });
  renderAt("/agent");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toBeEnabled());
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先聊聊想法，暂时不要制作");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))).toHaveLength(1));
  expect(calls.find(call => call.url.endsWith("/messages"))?.body).toMatchObject({ text: "先聊聊想法，暂时不要制作", target: null, proposalRef: null });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(""));
  expect(calls.filter(call => call.url.includes("acceptances"))).toHaveLength(0);
});

it("§11.7 来源8/10 输入框“从作品库选择”：勾选并入草稿可移除，new 携带、steer 不消耗，发送后消息可回看", async () => {
  const conversation = conversationFixture("conv-lib", "跨片改编");
  const snap = snapshotFixture(conversation);
  snap.activeRequestId = "req-live";
  const entry = libraryVideoFixture();
  let posted = 0;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-lib": snap }, onRequest: (url, call) => {
    if (url.endsWith("/library/videos")) return { status: 200, body: { items: [entry], nextCursor: null } };
    if (call.method === "POST" && url.endsWith("/messages")) {
      posted += 1;
      if (posted === 2) snap.messages.items.push(messageFixture({ id: "msg-sent", role: "user", text: "用这份方案做改编",
        librarySelections: [{ sourceVideo: entry.video, source: { kind: "artifact_revision", artifactId: "art-lib-mat", revisionId: "rev-lib-mat" } }] }));
      return { status: 202, body: { requestId: "req-back" } };
    }
    return null;
  } });
  renderAt("/agent/conv-lib");
  await screen.findByRole("textbox", { name: "消息输入" });
  // 弹层只并入当前草稿：取消不发送、选择可移除，正文与阅读位置不动。
  await userEvent.click(screen.getByRole("button", { name: "从作品库选择" }));
  await userEvent.click(await screen.findByRole("button", { name: /山路定稿/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /山路/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /main\.cjs/ }));
  await userEvent.click(screen.getByRole("button", { name: /加入输入框（2）/ }));
  expect(await screen.findByText(/作品库 · 山路（Prompt）/)).toBeInTheDocument();
  expect(screen.getByText(/作品库 · main\.cjs/)).toBeInTheDocument();
  expect(loadDraft("conv-lib")?.librarySelections).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "移除 main.cjs" }));
  expect(screen.queryByText(/main\.cjs/)).toBeNull();
  expect(loadDraft("conv-lib")?.librarySelections).toHaveLength(1);
  // steer 是对在途请求的补充说明：不携带库选材，也不消耗 chips。
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "这轮先保持原方案");
  await userEvent.click(screen.getByRole("button", { name: "补充当前请求" }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))).toHaveLength(1));
  let command = calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as Record<string, unknown>;
  expect(command.mode).toBe("steer");
  expect(command.librarySelections).toBeUndefined();
  await waitFor(() => expect(screen.getByText(/作品库 · 山路（Prompt）/)).toBeInTheDocument());
  // new 请求携带准确 selection（不含展示 label）；发送成功后 chips 消费、已发送消息可回看来源。
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "用这份方案做改编");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))).toHaveLength(2));
  command = calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))[1]!.body as Record<string, unknown>;
  expect(command.mode).toBe("new");
  expect(command.librarySelections).toEqual([{ sourceVideo: entry.video, source: { kind: "artifact_revision", artifactId: "art-lib-mat", revisionId: "rev-lib-mat" } }]);
  await waitFor(() => expect(screen.queryByText(/作品库 · 山路（Prompt）/)).toBeNull());
  expect(await screen.findByText("作品库 · 素材")).toBeInTheDocument();
  expect(loadDraft("conv-lib")).toBeNull();
});

it("DG-R1 库中 3 个 raw 视频与旧修订可分别预览下载选择，刷新草稿后仅发送才携带准确来源", async () => {
  const conversation = conversationFixture("conv-raw", "素材讨论");
  const entry = libraryVideoFixture({ project: null, projectFiles: [], materials: [
    { label: "原始片段一", kind: "video", source: { kind: "run_input", runId: "source-run", operationId: "assemble", inputIndex: 0, blobId: "raw-one" }, provenance: [] },
    { label: "原始片段二", kind: "video", source: { kind: "run_input", runId: "source-run", operationId: "assemble", inputIndex: 1, blobId: "raw-two" }, provenance: [] },
    { label: "原始片段三", kind: "video", source: { kind: "run_input", runId: "source-run", operationId: "assemble", inputIndex: 2, blobId: "raw-three" }, provenance: [] },
    { label: "留存视频", kind: "video", source: { artifactId: "retained-video", revisionId: "used-v1" }, provenance: [] },
    { label: "原始文稿", kind: "script", source: { artifactId: "retained-script", revisionId: "text-v1" }, provenance: [] },
  ] });
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation) },
    onRequest: (url, call) => {
      if (url.endsWith("/library/videos")) return { status: 200, body: { items: [entry], nextCursor: null } };
      if (url.endsWith("/artifacts/retained-video/revisions/used-v1")) return { status: 200, body: { ...REVISION_FIXTURE, artifactId: "retained-video", revisionId: "used-v1",
        content: { format: "media", blobId: "used-video-v1", mimeType: "video/mp4", durationMs: 3000 } } };
      if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { requestId: "discuss-raw", messageId: "sent-raw", state: "completed", replayed: false, runId: null } };
      return null;
    } });
  let page = renderAt("/agent/conv-raw?page=library");
  await userEvent.click(await screen.findByRole("button", { name: /山路定稿/ }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  for (const [label, blob] of [["原始片段一", "raw-one"], ["原始片段二", "raw-two"], ["原始片段三", "raw-three"], ["留存视频", "used-video-v1"]]) {
    const row = within(screen.getByRole("checkbox", { name: new RegExp(label!) }).closest("li")!);
    await userEvent.click(row.getByText("预览与下载"));
    await waitFor(() => expect(row.getByLabelText("视频预览")).toHaveAttribute("src", `/api/agent/v1/blobs/${blob}/content`));
    expect(row.getByRole("link", { name: "下载文件" })).toHaveAttribute("href", `/api/agent/v1/blobs/${blob}/content`);
  }
  await userEvent.click(screen.getByRole("checkbox", { name: /原始片段二/ }));
  expect(screen.getByRole("checkbox", { name: /原始片段一/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /原始片段三/ })).not.toBeChecked();
  await userEvent.click(screen.getByRole("checkbox", { name: /留存视频/ }));
  await userEvent.click(screen.getByRole("button", { name: "带入当前对话（2）" }));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先看看素材，暂不制作");
  expect(calls.filter(call => call.method === "POST")).toEqual([]);
  page.unmount();
  page = renderAt("/agent/conv-raw");
  expect(await screen.findByText("作品库 · 原始片段二（视频）")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先看看素材，暂不制作");
  await userEvent.click(screen.getByRole("button", { name: "从作品库选择" }));
  await userEvent.click(await screen.findByRole("button", { name: /山路定稿/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /原始片段二/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /原始片段三/ }));
  await userEvent.click(screen.getByRole("button", { name: "加入输入框（2）" }));
  expect(screen.getAllByText("作品库 · 原始片段二（视频）")).toHaveLength(1);
  expect(screen.getByText("作品库 · 原始片段三（视频）")).toBeInTheDocument();
  expect(calls.filter(call => call.method === "POST")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST")).toHaveLength(1));
  const sent = calls.find(call => call.method === "POST")!.body as MessageInput;
  expect(sent.librarySelections).toEqual([
    { sourceVideo: { artifactId: "art-lib-video", revisionId: "rev-lib-video" }, source: { kind: "run_input", runId: "source-run", operationId: "assemble", inputIndex: 1, blobId: "raw-two" } },
    { sourceVideo: { artifactId: "art-lib-video", revisionId: "rev-lib-video" }, source: { kind: "artifact_revision", artifactId: "retained-video", revisionId: "used-v1" } },
    { sourceVideo: { artifactId: "art-lib-video", revisionId: "rev-lib-video" }, source: { kind: "run_input", runId: "source-run", operationId: "assemble", inputIndex: 2, blobId: "raw-three" } },
  ]);
  expect(sent).toMatchObject({ text: "先看看素材，暂不制作", target: null, proposalRef: null });
  expect(sent.reviewConfirmation).toBeUndefined();
  expect(calls.some(call => call.url.endsWith("/artifacts/retained-video"))).toBe(false);
});

it("§11.7 来源9 库详情带入当前对话：并入该会话草稿回到输入框，来源对话保持独立入口", async () => {
  const conversation = conversationFixture("conv-lib9", "正在改编");
  const source = conversationFixture("conv-lib-src", "原片会话");
  const entry = libraryVideoFixture();
  installWorkbenchRoutes({ conversations: [conversation, source], snapshots: { "conv-lib9": snapshotFixture(conversation), "conv-lib-src": snapshotFixture(source) },
    onRequest: url => (url.endsWith("/library/videos") ? { status: 200, body: { items: [entry], nextCursor: null } } : null) });
  renderAt("/agent/conv-lib9?page=library");
  await userEvent.click(await screen.findByRole("button", { name: /山路定稿/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /山路/ }));
  // 回到来源对话是详情页上的独立入口，带入后回输入框，不再依赖该按钮存在。
  expect(screen.getByRole("button", { name: "回到来源对话" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "带入当前对话（1）" }));
  expect(await screen.findByRole("textbox", { name: "消息输入" })).toBeVisible();
  expect(await screen.findByText(/作品库 · 山路（Prompt）/)).toBeInTheDocument();
  expect(loadDraft("conv-lib9")?.librarySelections).toHaveLength(1);
});

it("§11.7 来源9 无当前会话时“带入新对话”：并入新对话草稿，首条消息携带选材", async () => {
  const entry = libraryVideoFixture();
  const created = conversationFixture("conv-lib-new", "新的会话");
  const calls = installWorkbenchRoutes({ conversations: [], snapshots: { "conv-lib-new": snapshotFixture(created) }, onCreate: () => ({ status: 201, body: created }), onRequest: (url, call) => {
    if (url.endsWith("/library/videos")) return { status: 200, body: { items: [entry], nextCursor: null } };
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { requestId: "req-new" } };
    return null;
  } });
  renderAt("/agent?page=library");
  await userEvent.click(await screen.findByRole("button", { name: /山路定稿/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /main\.cjs/ }));
  await userEvent.click(screen.getByRole("button", { name: "带入新对话（1）" }));
  expect(await screen.findByText(/作品库 · main\.cjs/)).toBeInTheDocument();
  expect(loadDraft("new")?.librarySelections).toHaveLength(1);
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "用这个工程文件做参考");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  const sent = await waitFor(() => {
    const call = calls.find(item => item.method === "POST" && item.url.endsWith("/messages"));
    expect(call).toBeTruthy();
    return call!;
  });
  const command = sent.body as Record<string, unknown>;
  expect(command.librarySelections).toEqual([{ sourceVideo: entry.video, source: { kind: "project_file", project: { artifactId: "art-lib-proj", revisionId: "rev-lib-proj" }, relativePath: "main.cjs" } }]);
});

it("§11.7 来源5 文件卡：文本类读回原文渲染，二进制只给事实与下载", async () => {
  installFetch(async url => ({ status: 200, body: url.includes("blob-txt") ? "console.log('hi')" : "" }));
  const textual = render(<FilePreview content={{ format: "file", blobId: "blob-txt", mimeType: "text/javascript", path: "assets/main.js" }} />);
  expect(await within(textual.container).findByText(/console\.log/)).toBeInTheDocument();
  const sourceDownload = within(textual.container).getByRole("link", { name: "下载文件" });
  expect(sourceDownload).toHaveAttribute("href", "/api/agent/v1/blobs/blob-txt/content?download=1");
  expect(sourceDownload).toHaveAttribute("download", "main.js");
  const binary = render(<FilePreview content={{ format: "file", blobId: "blob-bin", mimeType: "application/octet-stream", path: "assets/model.bin" }} />);
  expect(await within(binary.container).findByText("assets/model.bin")).toBeInTheDocument();
  expect(within(binary.container).getByText(/二进制文件不在页面内解释/)).toBeInTheDocument();
  expect(within(binary.container).getByRole("link", { name: "下载文件" })).toHaveAttribute("href", "/api/agent/v1/blobs/blob-bin/content?download=1");
});

it("ISS-06 旧工程仅在展开后取源码，按 UTF-8 字节截断即中止完整响应，标签保持原文", async () => {
  const limit = 256 * 1024;
  const prefix = "<script>example()</script>";
  const source = prefix + "a".repeat(limit - prefix.length - 1) + "汉" + "不得显示";
  const cancelled = vi.fn();
  const fetchFile = vi.fn(async (_url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get("range")).toBe(`bytes=0-${limit}`);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(source)); }, cancel: cancelled }));
  });
  vi.stubGlobal("fetch", fetchFile);
  const project = render(<ProjectPreview content={{ format: "project", files: [{ relativePath: "src/main.cjs", blobId: "blob-old-source", digest: "a".repeat(64), purpose: "source" }],
    entrypoint: { argv: ["node", "src/main.cjs"] }, runtimeImage: "frame", sourceRevisions: [], timelineFiles: [], dependencyLocks: [] }} />);
  expect(fetchFile).not.toHaveBeenCalled();
  await userEvent.click(within(project.container).getByText("src/main.cjs"));
  await within(project.container).findByText(/仅显示前 256 KiB/);
  expect(fetchFile).toHaveBeenCalledTimes(1);
  expect(fetchFile.mock.calls[0]![0]).toBe("/api/agent/v1/blobs/blob-old-source/content");
  expect(cancelled).toHaveBeenCalledOnce();
  expect(project.container.querySelector("pre")!.textContent).toBe(source.slice(0, limit - 1));
  expect(project.container.querySelector("script")).toBeNull();
  const download = within(project.container).getByRole("link", { name: "下载文件" });
  expect(download).toHaveAttribute("download", "main.cjs");
  expect(download).toHaveAttribute("href", "/api/agent/v1/blobs/blob-old-source/content?download=1");
  await userEvent.click(within(project.container).getByText("src/main.cjs"));
  await waitFor(() => expect(project.container.querySelector("pre")).toBeNull());
  expect(fetchFile.mock.calls[0]![1].signal?.aborted).toBe(true);
});

it("ISS-06 工程关闭时撤销在途源码请求，另一个路径读回自己的原文", async () => {
  let started: AbortSignal | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/blob-next/content")) return new Response("第二个文件", { status: 206 });
    const signal = options.signal!;
    started = signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }));
  const project = render(<ProjectPreview content={{ format: "project", files: [
    { relativePath: "first.py", blobId: "blob-wait", digest: "a".repeat(64), purpose: "source", mimeType: "text/x-python" },
    { relativePath: "next.py", blobId: "blob-next", digest: "b".repeat(64), purpose: "source", mimeType: "text/x-python" },
  ], entrypoint: { argv: ["python3", "first.py"] }, runtimeImage: "frame", sourceRevisions: [], timelineFiles: [], dependencyLocks: [] }} />);
  const first = within(project.container).getByText("first.py");
  await userEvent.click(first);
  await within(project.container).findByText("正在读取…");
  await userEvent.click(first);
  await waitFor(() => expect(started?.aborted).toBe(true));
  await userEvent.click(within(project.container).getByText("next.py"));
  expect(await within(project.container).findByText("第二个文件")).toBeVisible();
});

it("Frame 三个设置入口独立，往返保留预览、目标和草稿，不打开旧资源页", async () => {
  const conversation = conversationFixture("frame-nav", "随时接着聊");
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { "frame-nav": snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "我的 Prompt", "rev-1", 1)] }) } });
  renderAt("/agent/frame-nav");
  await userEvent.click(await screen.findByRole("button", { name: "我的 Prompt" }));
  await userEvent.click(await screen.findByRole("button", { name: "提意见" }));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "结尾再安静一点");
  await userEvent.click(screen.getByRole("button", { name: "打开模型配置" }));
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  await userEvent.click(screen.getByRole("button", { name: "打开免费服务" }));
  expect(screen.getByRole("tab", { name: "视频选题" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "打开个人设置" }));
  expect(screen.getByLabelText("显示名称")).toHaveValue("本地用户");
  await userEvent.click(within(screen.getByRole("navigation", { name: "会话列表" })).getByRole("button", { name: "随时接着聊" }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("结尾再安静一点");
  expect(screen.getByText(/针对：我的 Prompt/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "我的 Prompt" })).toBeInTheDocument();
  expect(document.querySelector('a[href="/resources"]')).toBeNull();
});

it("S1-13/14 多调用草稿和压缩结束可单独到达；clear、断线、终态后不能复活，不抢旧阅读", async () => {
  // 本用例验证流式草稿与阅读保持，按宽屏布局断言；DECISION-05 起视口基线即 1440×900。
  const conv = conversationFixture("streaming", "边看边聊");
  const snap = snapshotFixture(conv, { artifacts: [artifactFixture("art-1", "正在看的旧稿", "rev-1", 1)], messages: [messageFixture({ id: "msg-live", role: "assistant", text: "", state: "running", requestId: "req-live" })] });
  snap.activeRequestId = "req-live";
  installWorkbenchRoutes({ conversations: [conv], snapshots: { streaming: snap }, onRequest: (url) => url.endsWith("/messages/msg-live") ? { status: 200, body: snap.messages.items[0] } : null });
  renderAt("/agent/streaming");
  await screen.findByRole("heading", { name: "正在看的旧稿" });
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "继续聊别的");
  const source = FakeEventSource.instances.at(-1)!;
  const draft = (draftId: string, sequence: number, text: string): ArtifactDraft => ({ requestId: "req-live", messageId: "msg-live", draftId, sequence, state: "streaming", items: [{ itemIndex: 0, title: "待交付", kind: "prompt", text }] });
  source.emit("artifact.draft", draft("one", 1, "第一份草稿"));
  source.emit("artifact.draft", draft("two", 50, "第二份草稿"));
  expect(screen.getAllByTestId("artifact-draft")).toHaveLength(2);
  source.emit("artifact.draft", { ...draft("one", 2, ""), state: "cleared", items: [] });
  source.emit("artifact.draft", draft("one", 99, "迟到的旧稿"));
  source.emit("artifact.draft", draft("two", 49, "倒序帧"));
  expect(screen.queryByText("迟到的旧稿")).toBeNull(); expect(screen.queryByText("倒序帧")).toBeNull();
  expect(screen.getByText("第二份草稿")).toBeInTheDocument();
  expect(within(screen.getByTestId("artifact-draft")).queryByRole("button", { name: "提意见" })).toBeNull();
  source.emit("context.status", { requestId: "req-live", sequence: 4, phase: "compacted", reason: "threshold", willRetry: false });
  expect(screen.getByTestId("context-status")).toHaveTextContent("上下文已整理");
  expect(screen.getByRole("button", { name: "停止本轮" })).toBeInTheDocument();
  act(() => source.onerror?.());
  source.emit("artifact.draft", draft("three", 51, "断线后的迟到稿"));
  expect(screen.queryByTestId("artifact-draft")).toBeNull();
  expect(screen.queryByTestId("context-status")).toBeNull();
  expect(screen.getByRole("heading", { name: "正在看的旧稿" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("继续聊别的");
  await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 2000 });
  snap.activeRequestId = null; snap.messages.items[0] = { ...snap.messages.items[0]!, state: "completed", revision: 2, text: "完成，等你看。" };
  const current = FakeEventSource.instances.at(-1)!;
  current.emit("business", { eventId: "done", kind: "message.changed", entityId: "msg-live", entityVersion: 2, notification: "quiet" });
  await screen.findByText("完成，等你看。");
  current.emit("artifact.draft", draft("four", 60, "终态后的迟到稿"));
  current.emit("text.delta", { requestId: "req-live", messageId: "msg-live", sequence: 1, text: "过期答复" });
  expect(screen.queryByTestId("artifact-draft")).toBeNull(); expect(screen.queryByText("过期答复")).toBeNull();
});

it("S1-12 草稿随底部阅读位置滚动，用户翻看旧消息后不再跟随", async () => {
  const conv = conversationFixture("follow", "草稿跟随");
  const snap = snapshotFixture(conv, { messages: [messageFixture({ id: "msg-live", requestId: "req-live", role: "user", text: "继续写", state: "running" })] });
  snap.activeRequestId = "req-live";
  installWorkbenchRoutes({ conversations: [conv], snapshots: { follow: snap } });
  renderAt("/agent/follow");
  await screen.findByRole("heading", { name: "草稿跟随" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const chat = document.querySelector(".agent-messages")! as HTMLDivElement;
  let height = 1000;
  Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(chat, "clientHeight", { configurable: true, value: 300 });
  chat.scrollTop = 700; fireEvent.scroll(chat);
  height = 1300;
  const draft: ArtifactDraft = { requestId: "req-live", messageId: "msg-live", draftId: "draft-1", sequence: 1, state: "streaming", items: [{ itemIndex: 0, kind: "analysis", title: "分析", text: "生成中的正文" }] };
  FakeEventSource.instances[0]!.emit("artifact.draft", draft);
  await waitFor(() => expect(chat.scrollTop).toBeGreaterThanOrEqual(1000));
  chat.scrollTop = 50; fireEvent.scroll(chat);
  height = 1600;
  FakeEventSource.instances[0]!.emit("artifact.draft", { ...draft, sequence: 2, items: [{ ...draft.items[0]!, text: "继续生成正文" }] });
  expect(screen.getByText("继续生成正文")).toBeInTheDocument();
  expect(chat.scrollTop).toBe(50);
});

it("S1-08/09 旧页补齐精确修订及系统通知引用；单项404可重试且不抹掉其他卡片", async () => {
  const conv = conversationFixture("history", "历史引用");
  const f = productionFixture(conv);
  const snap = snapshotFixture(conv, { artifacts: [artifactFixture("art-1", "当前阅读", "rev-1", 1)] });
  snap.messages.nextCursor = "old-page";
  snap.runs.items = [{ ...f.run, id: "newer-run", title: "较新制作", createdAt: "2026-02-01T00:00:00Z" }];
  const oldHead = artifactFixture("old-art", "早前作品", "old-v3", 3);
  const oldRevision = { ...REVISION_FIXTURE, artifactId: "old-art", revisionId: "old-v1", content: { format: "markdown" as const, text: "这是早前第一版正文" } };
  const notice = messageFixture({ id: "old-notice", role: "system_notice", text: "早前已受理", references: { artifacts: [{ artifactId: "old-art", revisionId: "old-v1" }, { artifactId: "old-art", revisionId: "old-v1" }], proposalIds: [f.proposal.id, "missing-proposal"], runIds: [f.run.id], materialBatchIds: [] } });
  let missing = true;
  const calls = installWorkbenchRoutes({ conversations: [conv], snapshots: { history: snap }, onRequest: url => {
    if (url.includes("/messages?")) return { status: 200, body: { items: [notice], nextCursor: null, watermark: "page-watermark-is-not-sse" } };
    if (url.endsWith("/artifacts/old-art")) return { status: 200, body: oldHead };
    if (url.endsWith("/revisions/old-v1")) return { status: 200, body: oldRevision };
    if (url.endsWith(`/proposals/${f.proposal.id}`)) return { status: 200, body: { ...f.proposal, state: "accepted", acceptedRunId: f.run.id } };
    if (url.endsWith(`/runs/${f.run.id}`)) return { status: 200, body: f.run };
    if (url.endsWith("/proposals/missing-proposal")) return missing ? { status: 404, body: { code: "NOT_FOUND", message: "不可读取" } } : { status: 200, body: { ...f.proposal, id: "missing-proposal", spec: { ...f.proposal.spec, title: "重试可见的提案" } } };
    return null;
  } });
  renderAt("/agent/history");
  await userEvent.click(await screen.findByRole("button", { name: "加载更早的消息" }));
  await screen.findByText("制作提案 · 暂不可读");
  expect(screen.getByText("早前已受理")).toBeInTheDocument();
  const row = document.querySelector('[data-message-id="old-notice"]')! as HTMLElement;
  expect(within(row).getAllByRole("button", { name: "脚本 · v1，现名：早前作品" })[0]).toHaveTextContent("v1");
  await userEvent.click(within(row).getAllByRole("button", { name: "脚本 · v1，现名：早前作品" })[0]!);
  await screen.findByText("这是早前第一版正文");
  expect(screen.getByText("查看最新 v3")).toBeInTheDocument();
  expect(calls.filter(call => call.url.endsWith("/artifacts/old-art"))).toHaveLength(1);
  expect(calls.filter(call => call.url.endsWith("/revisions/old-v1"))).toHaveLength(1);
  expect(FakeEventSource.instances[0]!.url).toContain("cursor-history");
  expect(FakeEventSource.instances).toHaveLength(1);
  await userEvent.click(within(row).getByRole("button", { name: /模拟短片\s*制作记录/ }));
  expect(await screen.findByText("回看原提案：模拟短片")).toBeInTheDocument();
  expect(document.querySelectorAll(".agent-paper .agent-run")).toHaveLength(1);
  expect(document.querySelector(".agent-paper .agent-run")).toHaveTextContent("模拟短片");
  missing = false;
  await userEvent.click(within(row).getByRole("button", { name: "重试读取" }));
  await screen.findAllByText("重试可见的提案");
  expect(screen.queryByText("制作提案 · 暂不可读")).toBeNull();
});

it("S1-09 A→B→A 后旧分页响应被丢弃；同一页并发只请求一次", async () => {
  const a = conversationFixture("a", "对话 A"), b = conversationFixture("b", "对话 B");
  const snap = snapshotFixture(a, { artifacts: [artifactFixture("art-1", "保留的阅读", "rev-1", 1)] }); snap.messages.nextCursor = "page-2";
  let finish!: (value: RouteResult) => void;
  const pending = new Promise<RouteResult>(resolve => { finish = resolve; });
  const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { a: snap, b: snapshotFixture(b) }, onRequest: url => url.includes("/messages?") ? pending : null });
  renderAt("/agent/a");
  const load = await screen.findByRole("button", { name: "加载更早的消息" });
  await userEvent.dblClick(load);
  expect(calls.filter(c => c.url.includes("/messages?"))).toHaveLength(1);
  const nav = within(screen.getByRole("navigation", { name: "会话列表" }));
  await userEvent.click(nav.getByRole("button", { name: "对话 B" }));
  await userEvent.click(nav.getByRole("button", { name: "对话 A" }));
  await screen.findByRole("heading", { name: "保留的阅读" });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "保留的输入");
  await act(async () => finish({ status: 200, body: { items: [messageFixture({ id: "late", role: "assistant", text: "上一代的旧响应" })], nextCursor: null, watermark: "late-watermark" } }));
  expect(screen.queryByText("上一代的旧响应")).toBeNull();
  expect(screen.getByRole("button", { name: "加载更早的消息" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "保留的阅读" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留的输入");
});

it("S1-08 旧提案可打开首页之外的受理记录，不依赖对应通知也在消息页里", async () => {
  const conv = conversationFixture("old-proposal", "旧提案");
  const f = productionFixture(conv);
  f.proposal = { ...f.proposal, state: "accepted", revision: 2, acceptedRunId: f.run.id };
  f.snapshot.proposals.items = [f.proposal];
  const calls = installWorkbenchRoutes({ conversations: [conv], snapshots: { "old-proposal": f.snapshot }, onRequest: url => {
    if (url.endsWith(`/runs/${f.run.id}`)) return { status: 200, body: { ...f.run, state: "failed", issue: { code: "PROVIDER_FAILED", message: "这一条制作未完成" } } };
    return null;
  } });
  renderAt("/agent/old-proposal");
  await userEvent.click((await screen.findAllByRole("button", { name: "查看制作记录" }))[0]!);
  expect(await screen.findByRole("heading", { name: "制作记录" })).toBeInTheDocument();
  expect(screen.getByText("这一条制作未完成")).toBeInTheDocument();
  expect(calls.filter(call => call.url.endsWith(`/runs/${f.run.id}`))).toHaveLength(1);
});

it("S1-08/09 重连核对首页之外已加载对象的新状态，同时保留正在读的旧版", async () => {
  const conv = conversationFixture("resync-history", "重连历史");
  const f = productionFixture(conv);
  const snap = snapshotFixture(conv);
  snap.messages.nextCursor = "older";
  let changed = false;
  const oldMessage = messageFixture({ id: "old-delivery", role: "assistant", text: "早前交付", references: { artifacts: [{ artifactId: "art-1", revisionId: "rev-1" }], proposalIds: [f.proposal.id], runIds: [], materialBatchIds: [] } });
  installWorkbenchRoutes({ conversations: [conv], snapshots: { "resync-history": snap }, onRequest: url => {
    if (url.includes("/messages?")) return { status: 200, body: { items: [oldMessage], nextCursor: null, watermark: "old-page" } };
    if (url.endsWith("/artifacts/art-1")) return { status: 200, body: artifactFixture("art-1", "早前作品", changed ? "rev-2" : "rev-1", changed ? 2 : 1) };
    if (url.endsWith(`/proposals/${f.proposal.id}`)) return { status: 200, body: changed ? { ...f.proposal, state: "stale", revision: 2 } : f.proposal };
    return null;
  } });
  renderAt("/agent/resync-history");
  await userEvent.click(await screen.findByRole("button", { name: "加载更早的消息" }));
  const row = document.querySelector('[data-message-id="old-delivery"]')! as HTMLElement;
  await userEvent.click(await within(row).findByRole("button", { name: "脚本 · v1，现名：早前作品" }));
  await screen.findByText("这是交付内容。");
  await screen.findAllByText("待确认");
  changed = true;
  act(() => FakeEventSource.instances.find(source => !source.closed)!.onerror?.());
  await userEvent.click(await screen.findByRole("button", { name: "重新连接" }));
  expect(await screen.findByText("查看最新 v2")).toBeInTheDocument();
  expect(screen.getByText("这是交付内容。")).toBeInTheDocument();
  expect(within(row).getByText("需重新准备")).toBeInTheDocument();
});

it("S1-09 制作记录读取晚到时，不抢回用户新选择的作品", async () => {
  const conv = conversationFixture("run-intent", "阅读选择");
  const f = productionFixture(conv);
  f.snapshot.proposals.items = [{ ...f.proposal, state: "accepted", acceptedRunId: f.run.id }];
  let finish!: (value: RouteResult) => void;
  const pending = new Promise<RouteResult>(resolve => { finish = resolve; });
  installWorkbenchRoutes({ conversations: [conv], snapshots: { "run-intent": f.snapshot }, onRequest: url => url.endsWith(`/runs/${f.run.id}`) ? pending : null });
  renderAt("/agent/run-intent");
  await userEvent.click((await screen.findAllByRole("button", { name: "查看制作记录" }))[0]!);
  await userEvent.click(screen.getByRole("button", { name: "原 Prompt" }));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先讨论这一份");
  await act(async () => finish({ status: 200, body: f.run }));
  expect(screen.getByRole("heading", { name: "原 Prompt" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "制作记录" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先讨论这一份");
});

it("提案展示本次冻结的聊天原文，不要求先打开 Prompt 作品", async () => {
  const f = productionFixture(conversationFixture("chat-text", "从聊天制作"));
  const text = "山谷的清晨。\n缓慢推进，不添加旁白。";
  f.spec.inputRevisions = [];
  f.proposal.spec.operations[0]!.inputs = [{ kind: "text", text }];
  render(<ProposalCard proposal={f.proposal} onAccept={() => {}} />);
  await userEvent.click(screen.getByText("查看制作范围 · 1 项操作"));
  expect(screen.getByText("山谷的清晨。 缓慢推进，不添加旁白。").textContent).toBe(text);
  expect(screen.getByText("本次使用的文字")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /原 Prompt/ })).toBeNull();
});

it("R2 费用摘要来自冻结报价，推导按需展开且声音与模拟事实默认可见", async () => {
  const f = productionFixture(conversationFixture("cost-summary", "费用摘要"));
  const proposal = structuredClone(f.proposal);
  proposal.spec.operations[0]!.model!.providerId = "fixture-text";
  const binding = proposal.spec.operations[0]!.model!;
  proposal.priceDisclosure = "供应商单价与 token 推导，USD→CNY 采价说明；模拟媒体，仅验证流程，不发生真实扣费。";
  proposal.spec.operations.push(
    { kind: "image", operationId: "cover", outputSlot: "image", inputs: [{ kind: "text", text: "清晨" }], model: binding,
      parameters: { aspectRatio: "16:9", resolution: "1536x864" }, quotePerAttempt: { currency: "CNY", amountMinor: 125 }, priceKind: "estimate", maxCreateAttempts: 2 },
    { kind: "speech", operationId: "voice", outputSlot: "audio", inputs: [{ kind: "text", text: "山谷的清晨。" }], model: binding,
      parameters: { voiceId: "marin", format: "mp3" }, quotePerAttempt: { currency: "CNY", amountMinor: 35 }, priceKind: "estimate", maxCreateAttempts: 1 },
    { kind: "render", operationId: "join", outputSlot: "final", inputs: [{ kind: "operation_output", producerOperationId: "op-1", outputSlot: "video" }, { kind: "operation_output", producerOperationId: "voice", outputSlot: "audio" }], model: null,
      parameters: { assembly: "narrated_concat", width: 1280, height: 720, fps: 24, format: "mp4", videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" }, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded", maxCreateAttempts: 1 },
  );
  proposal.spec.finalOutput = { operationId: "join", outputSlot: "final" };
  proposal.spec.maxSpend.amountMinor = 2000;
  const before = JSON.stringify(proposal);
  const ui = render(<ProposalCard proposal={proposal} onAccept={vi.fn()} />);
  expect(screen.getByText(/估算 ¥14.85/)).toHaveTextContent("本次授权 ¥20.00");
  expect(screen.getByText(/估算不代表实际账单/)).toBeVisible();
  expect(screen.getByText(/声音：/)).toHaveTextContent("旁白替换原声");
  expect(screen.getByText("模拟媒体，仅验证流程，不发生真实扣费。", { exact: true })).toBeVisible();
  const explanation = screen.getByText("费用说明").closest("details")!;
  expect(explanation).not.toHaveAttribute("open");
  expect(within(explanation).getByText(proposal.priceDisclosure)).not.toBeVisible();
  await userEvent.click(screen.getByText("费用说明"));
  expect(within(explanation).getByText(proposal.priceDisclosure)).toBeVisible();
  expect(JSON.stringify(proposal)).toBe(before);
  const preserve = structuredClone(proposal);
  preserve.spec.operations[preserve.spec.operations.length - 1]!.parameters = { assembly: "ordered_concat", format: "mp4", width: 640, height: 360, fps: 24, audioMode: "preserve" };
  ui.rerender(<ProposalCard proposal={preserve} onAccept={vi.fn()} />);
  expect(screen.getByText(/声音：/)).toHaveTextContent("保留镜头原声");
});

it("B6 交付位置来自传入的作品投影，卡内不重复推导也不吞掉目标", () => {
  const f = productionFixture(conversationFixture("target-line", "交付位置"));
  const digest = "a".repeat(64);
  const spec: ProductionSpec = {
    workId: "work-b", title: "城市成片", type: "paid_production", purpose: "production", scope: "成片",
    requestSource: { requestId: "req-1", messageId: "msg-1" },
    inputSources: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest }],
    reviewInputs: [{ groupId: "grp-1", itemId: "item-1", source: { kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest }, confirmationId: "confirm-1" }],
    operations: [f.spec.operations[0]!],
    finalOutput: { operationId: "op-1", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 1200 },
    outputTarget: { group: { mode: "existing", groupId: "grp-1" }, item: { mode: "create", key: "final", label: "成片", role: "clip", required: true } },
  };
  const works: Work[] = [{ id: "work-b", title: "城市动画", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    reviewGroups: [{ id: "grp-1", title: "脚本与内容", revision: 1, nextIntent: null, items: [] }] }];
  render(<ProposalCard proposal={{ ...f.proposal, spec }} works={works} onAccept={vi.fn()} />);
  expect(screen.getByText(/交付到：/)).toHaveTextContent("脚本与内容 · 成片");
});

it("S1-09 查看制作记录期间，原作品的旧修订仍可完成读取", async () => {
  const conv = conversationFixture("reading-run", "保留原阅读");
  const f = productionFixture(conv);
  const acceptedSpec: LegacyProductionSpec = { ...f.spec, inputRevisions: [{ artifactId: "art-1", revisionId: "rev-2" }], operations: [{ ...f.spec.operations[0]!,
    inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-2", digest: "a".repeat(64) }],
  }] };
  f.proposal = { ...f.proposal, state: "accepted", acceptedRunId: f.run.id, spec: acceptedSpec };
  f.snapshot.proposals.items = [f.proposal];
  f.snapshot.artifacts.items = [artifactFixture("art-1", "原 Prompt", "rev-2", 2)];
  f.run.inputRevisions = acceptedSpec.inputRevisions;
  localStorage.setItem(`vf:agent-reading:${conv.id}`, JSON.stringify({ artifactId: "art-1", revisionId: "rev-1" }));
  let finish!: (value: RouteResult) => void;
  const pending = new Promise<RouteResult>(resolve => { finish = resolve; });
  const calls = installWorkbenchRoutes({ conversations: [conv], snapshots: { "reading-run": f.snapshot }, onRequest: url => {
    if (url.endsWith("/revisions/rev-1")) return pending;
    if (url.endsWith("/revisions/rev-2")) return { status: 200, body: { ...REVISION_FIXTURE, revisionId: "rev-2", revisionNumber: 2 } };
    if (url.endsWith(`/runs/${f.run.id}`)) return { status: 200, body: f.run };
    return null;
  } });
  renderAt("/agent/reading-run");
  await waitFor(() => expect(calls.some(call => call.url.endsWith("/revisions/rev-1"))).toBe(true));
  await userEvent.click((await screen.findAllByRole("button", { name: "查看制作记录" }))[0]!);
  await screen.findByRole("heading", { name: "制作记录" });
  await act(async () => finish({ status: 200, body: REVISION_FIXTURE }));
  await userEvent.click(screen.getByRole("button", { name: "回到作品" }));
  expect(await screen.findByText("这是交付内容。")).toBeInTheDocument();
  expect(screen.getByText("查看最新 v2")).toBeInTheDocument();
});

it("S1-10/11 制作范围展示真实顺序、全部操作和旧版本；受理及结束仍可回看", async () => {
  const f = productionFixture(conversationFixture("scope", "范围"));
  const proposal = structuredClone(f.proposal);
  const video = proposal.spec.operations[0]!;
  proposal.spec.operations = [
    { ...video, operationId: "A" }, { ...video, operationId: "B" },
    { kind: "render", operationId: "join", outputSlot: "final", inputs: [{ kind: "operation_output", producerOperationId: "A", outputSlot: "video" }, { kind: "operation_output", producerOperationId: "B", outputSlot: "video" }, { kind: "operation_output", producerOperationId: "A", outputSlot: "video" }], model: null,
      parameters: { width: 640, height: 360, fps: 24, format: "mp4", assembly: "ordered_concat" }, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded", maxCreateAttempts: 1 },
  ];
  proposal.spec.finalOutput = { operationId: "join", outputSlot: "final" };
  const props = { artifacts: [artifactFixture("art-1", "确认时的稿", "rev-new", 3)], revisions: { "art-1:rev-1": REVISION_FIXTURE }, onOpen: vi.fn(), onAccept: vi.fn() };
  const ui = render(<ProposalCard proposal={proposal} {...props} />);
  expect(screen.getByText(/拼接顺序/)).toHaveTextContent("本次视频 1产出 → 本次视频 2产出 → 本次视频 1产出");
  expect(screen.getByText(/最终产出/)).toHaveTextContent("视频成片");
  await userEvent.click(screen.getByText("查看制作范围 · 3 项操作"));
  // 输入只在各自操作下列出（A、B 各一次）；不再重复整份 inputRevisions 清单，也不展示原始 JSON。
  expect(screen.getAllByText("确认时的稿 · v1")).toHaveLength(2);
  expect(screen.queryByText("技术详情")).toBeNull();
  expect(screen.getByText("640×360 · 24 fps · MP4 · 顺序拼接 · 全片静音")).toBeInTheDocument();
  const reversed = structuredClone(proposal); reversed.spec.operations[2]!.inputs = [proposal.spec.operations[2]!.inputs[1]!, proposal.spec.operations[2]!.inputs[0]!];
  ui.rerender(<ProposalCard proposal={{ ...reversed, state: "accepted", acceptedRunId: f.run.id }} {...props} />);
  expect(screen.getByText(/拼接顺序/)).toHaveTextContent("本次视频 2产出 → 本次视频 1产出");
  expect(screen.getByRole("button", { name: "已受理" })).toBeDisabled();
  expect(screen.queryByText("已开始")).toBeNull();
  ui.rerender(<RunCard run={{ ...f.run, state: "failed", operations: f.run.operations.map(op => ({ ...op, state: "failed" })), finance: { state: "pending_reconciliation", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 900, settledMinor: 300, priceKind: "bounded" } }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
  await userEvent.click(screen.getByText("回看原提案：模拟短片"));
  expect(screen.getByText(/拼接顺序/)).toHaveTextContent("本次视频 1产出 → 本次视频 2产出 → 本次视频 1产出");
  expect(screen.getByText(/供应商账单待核对/)).toHaveTextContent("已核对 ¥3.00，待核对部分估算 ¥9.00");
  expect(screen.queryByText(/100%/)).toBeNull();
  expect(screen.getByText(/已完成 0/)).toBeInTheDocument();
  ui.rerender(<RunCard run={{ ...f.run, state: "succeeded", operations: f.run.operations.map(op => ({ ...op, state: "succeeded" })) }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
  expect(screen.getByText(/100%/)).toBeInTheDocument();
  ui.rerender(<RunCard run={{ ...f.run, state: "running", operations: f.run.operations.map(op => ({ ...op, state: "succeeded" })), finance: { state: "pending_reconciliation", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 900, settledMinor: 0, priceKind: "bounded" } }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
  expect(screen.queryByText(/100%/)).toBeNull();
  expect(screen.getByText(/供应商账单待核对/)).not.toHaveTextContent("已入账 ¥0.00");
});

it("F4 采用图片展示实际来源与加载像素，不把 NASA 标为 Pexels", () => {
  render(<MediaPreview simulated={false} content={{ format: "media", mimeType: "image/jpeg", blobId: "blob-nasa", durationMs: null, sources: [{
    provider: "nasa", assetId: "blue-marble", creatorName: "NASA / GSFC", creatorUrl: null, acquiredAt: "2026-11-05T00:00:00.000Z",
    sourceUrl: "https://images.nasa.gov/details/blue-marble", licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
  }] }} />);
  expect(screen.getByLabelText("素材来源")).toHaveTextContent("NASA · NASA / GSFC");
  expect(screen.getByLabelText("素材来源")).not.toHaveTextContent("Pexels");
  const image = screen.getByAltText("图片产出");
  Object.defineProperties(image, { naturalWidth: { value: 8000 }, naturalHeight: { value: 8000 } });
  fireEvent.load(image);
  expect(screen.getByText("实际尺寸 8000×8000")).toBeInTheDocument();
});

it("K1.2 指定 Skill 只用于下一条：结果未知保留选择与原命令重试，明确接收后恢复自动", async () => {
  const conversation = conversationFixture("conv-skill", "Skill 验收");
  const bootstrap: Bootstrap = { ...BOOTSTRAP, skills: [{ id: "travel-prompt-kit", name: "旅行 Prompt 套件", description: "旅行主题 Prompt" }] };
  const commands: Record<string, unknown>[] = [];
  let unknownResult = true;
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-skill": snapshotFixture(conversation) }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: bootstrap };
    if (call.method === "POST" && url.endsWith("/messages")) {
      commands.push(call.body as Record<string, unknown>);
      if (unknownResult) { unknownResult = false; return { status: 502, body: { code: "TEMPORARILY_UNAVAILABLE", message: "网关结果未知" } }; }
      return { status: 202, body: { receiptId: "receipt-skill", requestId: "req-skill", messageId: "msg-skill", state: "completed", replayed: false, runId: null } };
    }
    return null;
  } });
  renderAt("/agent/conv-skill");
  const select = await screen.findByRole("combobox", { name: "指定 Skill" });
  await userEvent.selectOptions(select, "travel-prompt-kit");
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "来一份周末城市漫步 Prompt");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await screen.findByRole("alert");
  // 结果未知：不消费指定，原 commandId + 原 skillId 可整体重试。
  expect(select).toHaveValue("travel-prompt-kit");
  await userEvent.click(await screen.findByRole("button", { name: /重试上次发送/ }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]!.skillId).toBe("travel-prompt-kit");
  expect(commands[1]!.commandId).toBe(commands[0]!.commandId);
  expect(commands[1]!.skillId).toBe("travel-prompt-kit");
  // new 被明确接收后恢复自动选择。
  await waitFor(() => expect(select).toHaveValue(""));
  expect(screen.queryByRole("button", { name: /重试上次发送/ })).toBeNull();
});

it("K1.2 steer 只干预当前轮：不带 Skill，也不消费已指定的选择", async () => {
  const conversation = conversationFixture("conv-steer", "干预验收");
  const snapshot = snapshotFixture(conversation, { messages: [messageFixture({ id: "msg-live", role: "user", text: "正在处理的请求", requestId: "req-live", state: "running" })] });
  snapshot.activeRequestId = "req-live";
  const bootstrap: Bootstrap = { ...BOOTSTRAP, skills: [{ id: "travel-prompt-kit", name: "旅行 Prompt 套件", description: "旅行主题 Prompt" }] };
  const commands: Record<string, unknown>[] = [];
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { "conv-steer": snapshot }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: bootstrap };
    if (call.method === "POST" && url.endsWith("/messages")) {
      commands.push(call.body as Record<string, unknown>);
      return { status: 202, body: { receiptId: "receipt-steer", requestId: "req-live", messageId: "msg-live", state: "running", replayed: false, runId: null } };
    }
    return null;
  } });
  renderAt("/agent/conv-steer");
  const select = await screen.findByRole("combobox", { name: "指定 Skill" });
  await userEvent.selectOptions(select, "travel-prompt-kit");
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "语气再克制一点");
  await userEvent.click(screen.getByRole("button", { name: "补充当前请求" }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]!.mode).toBe("steer");
  expect(commands[0]!.skillId).toBeNull();
  expect(commands[0]!.steerRequestId).toBe("req-live");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(""));
  expect(select).toHaveValue("travel-prompt-kit");
});

// P3c 使用既有工作台装配与 fetch seam；这里只验证 UI 合同和交互，不替代原生安装验收。
const SKILL_PACKAGES: SkillPackagesView = {
  packages: [
    { id: "builtin", source: "builtin", name: "内置创作", origin: "builtin", skillIds: ["builtin-writing"], status: "ready", diagnostics: [], runtimeStatus: "ready", runtimeMissing: [] },
    { id: "local-kit", source: "/srv/skills/travel-kit", name: "周末创作包", origin: "installed", skillIds: ["weekend-prompt", "weekend-script"], status: "ready", diagnostics: [], runtimeStatus: "ready", runtimeMissing: [] },
  ],
  skills: [
    { id: "builtin-writing", name: "内置写作", description: "梳理创作思路" },
    { id: "weekend-prompt", name: "周末 Prompt", description: "为城市漫步整理镜头 Prompt" },
    { id: "weekend-script", name: "周末脚本", description: "把行程写成短旁白" },
  ],
  mutation: null,
};
const BUILTIN_SKILLS: SkillPackagesView = { packages: [SKILL_PACKAGES.packages[0]!], skills: [SKILL_PACKAGES.skills[0]!], mutation: null };

it("P3c 侧栏与 skills 路由：安装后原对话立即指定，一次性复位；整包卸载清选择并保留草稿", async () => {
  const conversation = conversationFixture("skills-flow", "继续原对话");
  let packages = BUILTIN_SKILLS;
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation) }, onRequest: (url, call) => {
    if (url.endsWith("/bootstrap")) return { status: 200, body: { ...BOOTSTRAP, skills: packages.skills } };
    if (url.endsWith("/settings/skills")) return { status: 200, body: packages };
    if (url.endsWith("/settings/skills/install")) { packages = SKILL_PACKAGES; return { status: 200, body: packages }; }
    if (url.endsWith("/settings/skills/remove")) { packages = BUILTIN_SKILLS; return { status: 200, body: packages }; }
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { requestId: "skill-message" } };
    return null;
  } });
  const rendered = renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("heading", { name: conversation.title });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "接着聊旅行");
  await userEvent.click(screen.getByRole("button", { name: "打开 Skill 管理" }));
  await screen.findByRole("article", { name: "内置创作" });
  expect(screen.queryByRole("button", { name: "卸载 内置创作" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  const installDialog = screen.getByRole("dialog", { name: "安装 Skill" });
  expect(within(installDialog).getByLabelText("包来源")).toHaveFocus();
  expect(installDialog).toHaveTextContent("本机路径指服务端已有的目录，不会从浏览器上传文件");
  await userEvent.type(within(installDialog).getByLabelText("包来源"), "  /srv/skills/travel-kit  ");
  await userEvent.click(within(installDialog).getByRole("button", { name: "安装" }));
  const installed = await screen.findByRole("article", { name: "周末创作包" });
  expect(installed).toHaveTextContent("周末 Prompt"); expect(installed).toHaveTextContent("周末脚本");
  expect(installed).toHaveTextContent("为城市漫步整理镜头 Prompt");
  expect(within(installed).getByText("可用", { exact: true })).toBeVisible();
  const install = calls.find(call => call.url.endsWith("/skills/install"))!;
  expect(install.body).toEqual({ source: "/srv/skills/travel-kit" });
  expect(install.headers["x-video-factory-request"]).toBe("studio"); expect(install.cache).toBe("no-store");
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  const select = screen.getByRole("combobox", { name: "指定 Skill" });
  await waitFor(() => expect(within(select).getByRole("option", { name: "周末 Prompt" })).toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("接着聊旅行");
  await userEvent.selectOptions(select, "weekend-prompt");
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  await waitFor(() => expect(select).toHaveValue(""));
  expect(calls.find(call => call.url.endsWith("/messages"))?.body).toMatchObject({ skillId: "weekend-prompt", text: "接着聊旅行" });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "保留下一条想法");
  await userEvent.selectOptions(select, "weekend-script");
  await userEvent.click(screen.getByRole("button", { name: "打开 Skill 管理" }));
  await userEvent.click(await screen.findByRole("button", { name: "卸载 周末创作包" }));
  const removeDialog = screen.getByRole("dialog", { name: "卸载 Skill 包" });
  expect(removeDialog).toHaveTextContent("周末 Prompt"); expect(removeDialog).toHaveTextContent("周末脚本");
  expect(removeDialog).toHaveTextContent("仅解除注册，不删除源文件");
  expect(removeDialog).toHaveTextContent("已有聊天、作品与生成记录会保留");
  await userEvent.click(within(removeDialog).getByRole("button", { name: "确认卸载" }));
  await waitFor(() => expect(screen.queryByRole("article", { name: "周末创作包" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  expect(select).toHaveValue("");
  expect(within(select).queryByRole("option", { name: "周末脚本" })).toBeNull();
  expect(screen.getByText(/已选 Skill 已不在当前目录/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留下一条想法");
  expect(loadDraft(conversation.id)?.text).toBe("保留下一条想法");
  expect(calls.find(call => call.url.endsWith("/skills/remove"))?.body).toEqual({ packageId: "local-kit" });
  expect(calls.filter(call => call.url.endsWith("/settings/skills")).every(call => call.cache === "no-store")).toBe(true);
  rendered.unmount();
  renderAt(`/agent/${conversation.id}?page=skills`);
  await screen.findByRole("article", { name: "内置创作" });
  expect(screen.queryByRole("article", { name: "周末创作包" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留下一条想法");
  expect(screen.getByRole("combobox", { name: "指定 Skill" })).toHaveValue("");
});

it("P3c 目录按服务端状态展示零 Skill、解析诊断与只读内置，不把配置来源视为可用", async () => {
  const packages: SkillPackagesView = {
    ...BUILTIN_SKILLS,
    packages: [...BUILTIN_SKILLS.packages, { ...BUILTIN_SKILLS.packages[0]!, id: "sound-kit", name: "配音工具", origin: "installed", runtimeStatus: "unavailable", runtimeMissing: ["python:wave"] },
      { id: "empty", source: "npm:empty-skill-package", name: "空包", origin: "installed", skillIds: [], status: "no_skills", diagnostics: ["未发现 SKILL.md"], runtimeStatus: "unchecked", runtimeMissing: [] },
      { id: "broken", source: "https://example.test/broken.git", name: "错误包", origin: "installed", skillIds: [], status: "invalid", diagnostics: ["Skill frontmatter 缺少 description"], runtimeStatus: "unchecked", runtimeMissing: [] },
    ],
  };
  installWorkbenchRoutes({ conversations: [], onRequest: url => url.endsWith("/settings/skills") ? { status: 200, body: packages } : null });
  renderAt("/agent?page=skills");
  const empty = await screen.findByRole("article", { name: "空包" });
  expect(screen.getByRole("article", { name: "配音工具" })).toHaveTextContent("运行依赖未就绪");
  expect(screen.getByRole("article", { name: "配音工具" })).toHaveTextContent("python:wave");
  expect(screen.getByRole("article", { name: "内置创作" })).toHaveTextContent("运行依赖已就绪");
  expect(empty).toHaveTextContent("npm:empty-skill-package");
  expect(within(empty).getByText("未发现 Skill", { exact: true })).toBeVisible();
  expect(empty).toHaveTextContent("未发现 SKILL.md");
  expect(within(empty).queryByText("可用", { exact: true })).toBeNull();
  const broken = screen.getByRole("article", { name: "错误包" });
  expect(within(broken).getByText("不可用", { exact: true })).toBeVisible();
  expect(broken).toHaveTextContent("Skill frontmatter 缺少 description");
  expect(screen.getByRole("article", { name: "内置创作" })).toHaveTextContent("内置 · 只读");
});

it("P3c 来源草稿与键盘：空来源不提交，失败后保留草稿，关闭后重新打开仍可修改", async () => {
  const calls = installWorkbenchRoutes({ conversations: [], onRequest: url => {
    if (url.endsWith("/settings/skills")) return { status: 200, body: { packages: [], skills: [], mutation: null } satisfies SkillPackagesView };
    if (url.endsWith("/skills/install")) return { status: 400, body: { code: "INVALID_INPUT", message: "无法解析这个包来源。", requestId: "r", retryAction: "none", currentRevisionId: null } };
    return null;
  } });
  renderAt("/agent?page=skills");
  const trigger = await screen.findByRole("button", { name: "安装第一个 Skill" });
  await userEvent.click(trigger);
  const dialog = screen.getByRole("dialog");
  const close = within(dialog).getByRole("button", { name: "关闭 Skill 面板" });
  const submit = within(dialog).getByRole("button", { name: "安装" });
  close.focus(); await userEvent.tab({ shift: true }); expect(submit).toHaveFocus();
  await userEvent.tab(); expect(close).toHaveFocus();
  await userEvent.click(submit);
  expect(within(dialog).getByRole("alert")).toHaveTextContent("请填写 npm、Git 或服务器本机包目录来源");
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  await userEvent.type(within(dialog).getByLabelText("包来源"), "git:bad-source");
  await userEvent.click(submit);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("无法解析这个包来源");
  expect(within(dialog).getByLabelText("包来源")).toHaveValue("git:bad-source");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  expect(screen.getByLabelText("包来源")).toHaveValue("git:bad-source");
  expect(screen.getByLabelText("包来源")).toHaveFocus();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

it("P3c 响应丢失只读确认：不自动重发，刷新展示 mutation，完成后来源草稿仍保留", async () => {
  let packages = BUILTIN_SKILLS;
  const calls = installWorkbenchRoutes({ conversations: [], onRequest: url => {
    if (url.endsWith("/settings/skills")) return { status: 200, body: packages };
    if (url.endsWith("/bootstrap")) return { status: 200, body: { ...BOOTSTRAP, skills: packages.skills } };
    if (url.endsWith("/skills/install")) { packages = { ...BUILTIN_SKILLS, mutation: { action: "install", source: "npm:weekend-kit" } }; throw new TypeError("response lost"); }
    return null;
  } });
  renderAt("/agent?page=skills");
  await screen.findByRole("article", { name: "内置创作" });
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  const dialog = screen.getByRole("dialog");
  const source = within(dialog).getByLabelText("包来源");
  await userEvent.type(source, "npm:weekend-kit");
  await userEvent.click(within(dialog).getByRole("button", { name: "安装" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("结果待确认");
  expect(source).toHaveValue("npm:weekend-kit"); expect(source).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "安装" })).toBeDisabled();
  fireEvent.submit(dialog.querySelector("form")!);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新列表" }));
  expect(await within(dialog).findByRole("status")).toHaveTextContent("正在安装 Skill 包");
  expect(within(dialog).getByRole("button", { name: "安装" })).toBeDisabled();
  packages = SKILL_PACKAGES;
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(source).toBeEnabled());
  expect(source).toHaveValue("npm:weekend-kit");
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("article", { name: "周末创作包" })).toBeVisible();
});

it("P3c 503 明确失败先回读，刷新失败继续保留草稿，不能通过提交重发", async () => {
  let failRead = false;
  const calls = installWorkbenchRoutes({ conversations: [], onRequest: url => {
    if (url.endsWith("/settings/skills")) { if (failRead) throw new TypeError("offline"); return { status: 200, body: BUILTIN_SKILLS }; }
    if (url.endsWith("/skills/install")) return { status: 503, body: { code: "TEMPORARILY_UNAVAILABLE", message: "目录刷新失败，配置可能已保存。", retryAction: "reload", requestId: "r", currentRevisionId: null } };
    return null;
  } });
  renderAt("/agent?page=skills");
  await screen.findByRole("article", { name: "内置创作" });
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("包来源"), "/srv/skills/draft");
  await userEvent.click(within(dialog).getByRole("button", { name: "安装" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("目录刷新失败，配置可能已保存");
  expect(within(dialog).getByRole("button", { name: "安装" })).toBeDisabled();
  failRead = true;
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(2));
  fireEvent.submit(dialog.querySelector("form")!);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(within(dialog).getByLabelText("包来源")).toHaveValue("/srv/skills/draft");
  failRead = false;
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "安装" })).toBeEnabled());
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

it("P3c 安装中可关闭与离页，目录忙态保留聊天草稿，后台完成同步同会话选择", async () => {
  const conversation = conversationFixture("background-skill", "原有聊天");
  let packages = BUILTIN_SKILLS;
  let finish!: (value: RouteResult) => void;
  const pending = new Promise<RouteResult>(resolve => { finish = resolve; });
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation) }, onRequest: url => {
    if (url.endsWith("/settings/skills")) return { status: 200, body: packages };
    if (url.endsWith("/bootstrap")) return { status: 200, body: { ...BOOTSTRAP, skills: packages.skills } };
    if (url.endsWith("/skills/install")) { packages = { ...BUILTIN_SKILLS, mutation: { action: "install", source: "/srv/skills/travel-kit" } }; return pending; }
    return null;
  } });
  renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("heading", { name: conversation.title });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "目录更新后再发送");
  await userEvent.click(screen.getByRole("button", { name: "打开 Skill 管理" }));
  await screen.findByRole("article", { name: "内置创作" });
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  await userEvent.type(screen.getByLabelText("包来源"), "/srv/skills/travel-kit");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "安装" }));
  expect(await within(screen.getByRole("dialog")).findByRole("status")).toHaveTextContent("关闭面板不会取消操作");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "刷新列表" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("目录更新后再发送");
  expect(screen.getByRole("button", { name: /^(排队)?发送$/ })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "消息输入" }), { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Skill 目录正在更新");
  expect(calls.filter(call => call.url.endsWith("/messages"))).toHaveLength(0);
  packages = SKILL_PACKAGES;
  await act(async () => finish({ status: 200, body: packages }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^(排队)?发送$/ })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("目录更新后再发送");
  expect(within(screen.getByRole("combobox", { name: "指定 Skill" })).getByRole("option", { name: "周末 Prompt" })).toBeInTheDocument();
  expect(screen.queryByText(/已取消/)).toBeNull();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

it("P3c 管理与发送 RUN_BUSY/409/wait：如实显示等待，原来源、消息、Skill 选择均保留", async () => {
  const conversation = conversationFixture("skill-busy", "忙态聊天");
  const busy = { status: 409, body: { code: "RUN_BUSY", message: "当前对话还在处理，完成后再操作。", requestId: "r", retryAction: "wait", currentRevisionId: null } };
  const calls = installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshotFixture(conversation) }, onRequest: (url, call) => {
    if (url.endsWith("/settings/skills")) return { status: 200, body: SKILL_PACKAGES };
    if (url.endsWith("/bootstrap")) return { status: 200, body: { ...BOOTSTRAP, skills: SKILL_PACKAGES.skills } };
    if (call.method === "POST" && (url.endsWith("/skills/install") || url.endsWith("/messages"))) return busy;
    return null;
  } });
  renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("heading", { name: conversation.title });
  const select = screen.getByRole("combobox", { name: "指定 Skill" });
  await userEvent.selectOptions(select, "weekend-script");
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "等目录空闲后发送");
  await userEvent.click(screen.getByRole("button", { name: "打开 Skill 管理" }));
  await screen.findByRole("article", { name: "周末创作包" });
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  await userEvent.type(screen.getByLabelText("包来源"), "npm:keep-draft");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "安装" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请等待完成后再操作");
  expect(screen.getByLabelText("包来源")).toHaveValue("npm:keep-draft");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  await userEvent.click(screen.getByRole("button", { name: /^(排队)?发送$/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前对话还在处理");
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("等目录空闲后发送");
  expect(select).toHaveValue("weekend-script");
  expect(screen.queryByRole("button", { name: /重试上次发送/ })).toBeNull();
  expect(localStorage.getItem(`vf:agent-send:${conversation.id}`)).toBeNull();
  expect(calls.filter(call => call.url.endsWith("/messages"))).toHaveLength(1);
});

it("状态同步断开仍可通过停止接口取消，停止失败可重试", async () => {
  const conversation = conversationFixture("stop-disconnected", "停止仍可用");
  const request = messageFixture({ id: "stoppable-user", role: "user", text: "继续核对", requestId: "stoppable-request", state: "running" });
  const snapshot = snapshotFixture(conversation, { messages: [request] }); snapshot.activeRequestId = request.requestId;
  let attempts = 0;
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { [conversation.id]: snapshot }, onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/stop")) {
      if (++attempts === 1) return { status: 503, body: { code: "UNAVAILABLE", message: "停止暂未成功" } };
      request.state = "stopped"; request.revision++; snapshot.activeRequestId = null;
      return { status: 202, body: { requestId: request.requestId, state: "stopped" } };
    }
    return null;
  } });
  renderAt(`/agent/${conversation.id}`);
  await screen.findByRole("button", { name: "停止本轮" });
  const stream = await waitFor(() => { const value = FakeEventSource.instances.find(source => !source.closed); expect(value).toBeDefined(); return value!; });
  act(() => stream.onerror?.());
  await screen.findByText("进展暂未同步");
  expect(screen.getByRole("button", { name: "停止本轮" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
  await screen.findByText("停止暂未成功");
  await waitFor(() => expect(screen.getByRole("button", { name: "停止本轮" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
  await screen.findByText("本轮已停止，已完成的内容保留。");
  expect(attempts).toBe(2);
});

it("ISS-16 分镜稿的标题、引用、斜体、嵌套链接与语言围栏以安全 React 节点排版", () => {
  const {container} = render(<MarkdownText text={'#### 第一幕\n##### 近景\n###### 景别\n> *缓缓打开*\n---\n**[参考镜头](https://example.test/scene)** 和 _慢推_\n```json\n{"shot":1}\n```\n[不可执行](javascript:denied)'} />);
  for (const [heading, level] of [["第一幕",4],["近景",5],["景别",6]] as const) expect(screen.getByRole("heading",{name:heading,level})).toBeInTheDocument();
  expect(container.querySelector("blockquote em")).toHaveTextContent("缓缓打开");
  expect(container.querySelector("strong a")).toHaveAttribute("href","https://example.test/scene");
  expect(container.querySelectorAll("em")).toHaveLength(2);
  expect(screen.getByRole("separator")).toBeInTheDocument();
  expect(container.querySelector("pre code")).toHaveTextContent('{"shot":1}');
  expect(container.querySelector("pre span")).toHaveTextContent("json");
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.textContent).not.toMatch(/[#*\x60]/);
});

it("ISS-14 会话 LRU 保留最近十个视图，审阅中的修订与最近两百个跨会话修订可用", () => {
  const views = new ConversationCache<string>();
  views.set("current","当前阅读位置");
  views.activate("current");
  for (let i=0; i<10; i++) views.set(String(i),String(i));
  expect(views.size).toBe(10);
  expect(views.has("0")).toBe(false);
  expect(views.get("current")).toBe("当前阅读位置");
  views.activate("1");
  views.set("10","10");
  expect(views.has("1")).toBe(true);
  const revisions = new RevisionCache();
  revisions.activate("current");
  for (let i=0; i<220; i++) {
    const id = String(i);
    revisions.remember("current", {["current:"+id]: {...REVISION_FIXTURE, revisionId:id}});
    revisions.remember("other", {["other:"+id]: {...REVISION_FIXTURE, revisionId:id}});
    if (i===180) revisions.touch("other:0");
  }
  expect(Object.keys(revisions.values)).toHaveLength(420);
  expect(revisions.values["current:0"]).toBeDefined();
  expect(revisions.values["other:0"]).toBeDefined();
  expect(revisions.values["other:1"]).toBeUndefined();
  revisions.activate("new");
  expect(Object.keys(revisions.values)).toHaveLength(200);
});

describe("本地素材与冻结画面参考", () => {
  const attachment: UploadAttachment = {
    source: { artifactId: "art-upload", revisionId: "rev-upload" }, blobId: "blob-upload", mimeType: "video/mp4", durationMs: 3900,
    facts: { fileName: "实拍.mp4", sizeBytes: 1400, rights: "owned_or_licensed", width: 1280, height: 720,
      firstFrame: { blobId: "blob-first", digest: "2".repeat(64), width: 1280, height: 720 } },
  };
  const stage = (name = attachment.facts.fileName) => fireEvent.change(screen.getByLabelText("选择本地素材"), {
    target: { files: [new File(["camera"], name, { type: "video/mp4" })] },
  });
  afterEach(() => vi.restoreAllMocks());

  it("授权前不上传；真实进度、切换会话时的回执、仅附件发送及历史首帧", async () => {
    const a = conversationFixture("u-a", "剪辑会话"), b = conversationFixture("u-b", "另一会话");
    const snap = snapshotFixture(a);
    const message = messageFixture({ id: "msg-up", role: "user", text: "", uploads: [attachment] });
    const calls = installWorkbenchRoutes({ conversations: [a, b], snapshots: { [a.id]: snap, [b.id]: snapshotFixture(b) }, onRequest: (url, call) => {
      if (url.endsWith("/messages") && call.method === "POST") return { status: 202, body: { messageId: message.id, requestId: "req-u" } };
      if (url.endsWith("/messages/msg-up")) return { status: 200, body: message };
      return null;
    } });
    let reply!: (receipt: UploadReceipt) => void;
    let progress!: (value: number) => void;
    const upload = vi.spyOn(agentApi, "uploadFile").mockImplementation((_id, _form, _signal, notify) => {
      progress = notify; return new Promise(resolve => { reply = resolve; });
    });
    renderAt("/agent/u-a");
    await screen.findByRole("heading", { name: a.title });
    stage();
    const consent = await screen.findByRole("button", { name: /确认拥有或获准使用/ });
    expect(upload).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await userEvent.click(consent);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]!.slice(0, 2)).toEqual([a.id, expect.objectContaining({ expectedRevision: 1, rights: "owned_or_licensed" })]);
    act(() => progress(.42)); expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.42");
    act(() => progress(1)); expect(screen.getByText("已传输，正在检查素材")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: b.title }));
    await screen.findByRole("heading", { name: b.title });
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "B 的草稿");
    await act(async () => reply({ conversation: { ...a, revision: 2 }, attachment }));
    expect(screen.queryByText(attachment.facts.fileName)).toBeNull();
    expect(loadDraft(b.id)?.text).toBe("B 的草稿");
    expect(loadDraft(a.id)?.uploads).toEqual([attachment]);
    await userEvent.click(screen.getByRole("button", { name: a.title }));
    await screen.findByRole("heading", { name: a.title });
    expect(await screen.findByRole("button", { name: "移除 实拍.mp4" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    const history = await screen.findByRole("list", { name: "消息附件" });
    expect(within(history).getByRole("button", { name: "查看附件 实拍.mp4" })).toHaveTextContent("1280×720");
    expect(history.querySelector("img")).toHaveAttribute("src", "/api/agent/v1/blobs/blob-first/content");
    expect(calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))?.body).toMatchObject({ mode: "new", text: "", uploads: [attachment.source] });
    expect(loadDraft(a.id)).toBeNull();
  });

  it("补充当前请求只发文本，已上传附件继续留给下一条 new 消息", async () => {
    const a = conversationFixture("u-steer", "补充说明"), snap = snapshotFixture(a);
    snap.activeRequestId = "req-active";
    saveDraft(a.id, { text: "先改一句旁白", targetArtifactId: null, targetRevisionId: null, uploads: [attachment] });
    const msg = messageFixture({ id: "msg-steer", role: "user", text: "先改一句旁白" });
    const calls = installWorkbenchRoutes({ conversations: [a], snapshots: { [a.id]: snap }, onRequest: (url, call) => {
      if (url.endsWith("/messages") && call.method === "POST") return { status: 202, body: { messageId: msg.id, requestId: snap.activeRequestId } };
      if (url.endsWith("/messages/msg-steer")) return { status: 200, body: msg };
      return null;
    } });
    renderAt("/agent/u-steer");
    await userEvent.click(await screen.findByRole("button", { name: "补充当前请求" }));
    const body = calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))?.body as MessageInput;
    expect(body.mode).toBe("steer"); expect(body.uploads).toBeUndefined();
    await waitFor(() => expect(loadDraft(a.id)).toMatchObject({ text: "", uploads: [attachment] }));
    expect(screen.getByRole("button", { name: "排队发送" })).toBeEnabled();
  });

  it("空会话粘贴文件先取得授权，创建时保留最新草稿；取消会中止传输且不会留下附件", async () => {
    const a = conversationFixture("conv-new", "新草稿");
    const calls = installWorkbenchRoutes({ conversations: [], snapshots: { [a.id]: snapshotFixture(a) } });
    let signal!: AbortSignal;
    const upload = vi.spyOn(agentApi, "uploadFile").mockImplementation((_id, _form, s) => {
      signal = s; return new Promise((_resolve, reject) => s.addEventListener("abort", () => reject(s.reason), { once: true }));
    });
    renderAt("/agent");
    const text = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(text, "保留这句");
    fireEvent.paste(text, { clipboardData: { files: [new File(["sample"], "实拍.mp4", { type: "video/mp4" })] } });
    expect(calls.some(call => call.method === "POST")).toBe(false);
    await userEvent.click(await screen.findByRole("button", { name: /确认拥有或获准使用/ }));
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await userEvent.click(await screen.findByRole("button", { name: "取消上传 实拍.mp4" }));
    expect(signal.aborted).toBe(true); expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留这句");
    expect(loadDraft(a.id)?.uploads).toBeUndefined();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it("响应丢失后拖入文件的重试复用原命令与原始版本；移除只改发送草稿", async () => {
    const a = conversationFixture("u-retry", "上传重试");
    installWorkbenchRoutes({ conversations: [a], snapshots: { [a.id]: snapshotFixture(a) } });
    const upload = vi.spyOn(agentApi, "uploadFile").mockRejectedValueOnce(new Error("上传响应丢失")).mockResolvedValue({ conversation: { ...a, revision: 2 }, attachment });
    renderAt("/agent/u-retry"); await screen.findByRole("heading", { name: a.title });
    const target = screen.getByRole("textbox", { name: "消息输入" });
    fireEvent.drop(target, { dataTransfer: { files: [new File(["sample"], attachment.facts.fileName, { type: "video/mp4" })] } });
    const consent = await screen.findByRole("button", { name: /确认拥有或获准使用/ });
    await userEvent.click(consent); await screen.findByText("上传响应丢失");
    a.revision = 2;
    await userEvent.click(screen.getByRole("button", { name: /确认拥有或获准使用/ }));
    await waitFor(() => expect(loadDraft(a.id)?.uploads).toHaveLength(1));
    expect(upload.mock.calls[0]![1]).toEqual(upload.mock.calls[1]![1]);
    await userEvent.click(screen.getByRole("button", { name: "移除 实拍.mp4" }));
    expect(screen.queryByRole("list", { name: "待发送附件" })).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("首帧和角色取自绑定的 v1，尾帧与上游生成如实展示，编辑中 v3 不替换缩略图", async () => {
    const f = productionFixture(conversationFixture("i2v", "图片参考"));
    const source = { kind: "artifact_revision" as const, artifactId: "art-board", revisionId: "rev-1", digest: "a".repeat(64) };
    const video = f.spec.operations[0]!;
    if (video.kind !== "video") throw new Error("视频提案夹具无效");
    const image = { ...video, operationId: "op-image", kind: "image" as const, outputSlot: "image", parameters: { aspectRatio: "16:9", resolution: "1K" } } as const;
    const spec: ProductionSpec = { workId: "work-b", title: "分镜动起来", type: "paid_production", purpose: "production", scope: "片段",
      requestSource: { requestId: "req-1", messageId: "msg-1" }, inputSources: [source], reviewInputs: [{ groupId: "g", itemId: "i", source, confirmationId: "confirm" }], maxSpend: f.spec.maxSpend, finalOutput: f.spec.finalOutput,
      operations: [image, { ...video, inputs: [source, { kind: "blob", blobId: "blob-tail", digest: source.digest }],
        parameters: { ...video.parameters, firstFrameSlot: 0, lastFrameSlot: 1 } },
        { ...video, operationId: "op-reference", inputs: [{ kind: "operation_output", producerOperationId: image.operationId, outputSlot: "image" }, source],
          parameters: { ...video.parameters, referenceImageSlots: [0, 1] } }] };
    const revision: ArtifactRevision = { ...REVISION_FIXTURE, artifactId: source.artifactId, content: { format: "media", blobId: "frozen-board", mimeType: "image/png", durationMs: null } };
    const head = artifactFixture(source.artifactId, "当前角色设定", "rev-3", 3);
    const works: Work[] = [{ id: "work-b", title: "角色测试", revision: 1, createdAt: head.updatedAt, updatedAt: head.updatedAt,
      reviewGroups: [{ id: "g", title: "角色组", revision: 1, nextIntent: null, items: [{ id: "i", role: "character", label: "分镜 2", required: true,
        draft: { ...source, revisionId: "rev-3" }, approved: source, finalizedSource: null, confirmationId: "confirm", approvedAt: head.updatedAt }] }] }];
    const open = vi.fn();
    render(<ProposalCard proposal={{ ...f.proposal, spec }} artifacts={[head]} revisions={{ "art-board:rev-1": revision }} works={works} onOpen={open} />);
    const first = screen.getByRole("button", { name: "首帧参考：分镜 2 · v1" });
    expect(first.querySelector("img")).toHaveAttribute("src", "/api/agent/v1/blobs/frozen-board/content");
    expect(screen.getByRole("button", { name: "角色参考：分镜 2 · v1" })).toBeVisible();
    const anchors = screen.getByLabelText("镜头 1 参考图");
    expect(anchors).toHaveTextContent("尾帧参考：保留 · 已有素材 1");
    expect(anchors.querySelector('img[src="/api/agent/v1/blobs/blob-tail/content"]')).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "镜头 2 参考图" })).toHaveTextContent("参考图：本次图片产出");
    await userEvent.click(first);
    expect(open).toHaveBeenCalledExactlyOnceWith(source.artifactId, source.revisionId);
  });
});

it.each(["models", "services", "skills", "team"])("创作者从管理深链 %s 回到自己的资料且不触发管理请求", async page => {
  const calls = installWorkbenchRoutes({ conversations: [], onRequest: url => url.endsWith("/bootstrap")
    ? { status: 200, body: { ...BOOTSTRAP, accountRole: "creator" } } : null });
  renderAt("/agent?page=" + page);
  await screen.findByRole("heading", { name: "用户页" });
  expect(await screen.findByRole("textbox", { name: "显示名称" })).toBeVisible();
  for (const name of ["打开模型配置", "打开免费服务", "打开 Skill 管理", "成员与预算", "模型配置", "Skill 管理"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(calls.filter(call => call.url.includes("/settings/"))).toHaveLength(0);
});

it("UIUX-06 窄窗抽屉收起期间的新回复点亮未读：暗栏圆点与顶栏入口一键回到对话", async () => {
  const conv = conversationFixture("conv-unread", "未读提示");
  const work: Work = { id: "work-u", title: "城市动画", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    reviewGroups: [{ id: "grp-u", title: "脚本与内容", revision: 1, nextIntent: null, items: [] }] };
  const snapshot = { ...snapshotFixture(conv), works: [work] };
  const messages: Record<string, Message> = {};
  installWorkbenchRoutes({ conversations: [conv], snapshots: { "conv-unread": snapshot }, onRequest: url => {
    const match = /\/messages\/([^/?]+)$/.exec(url);
    if (match && messages[match[1]!]) return { status: 200, body: messages[match[1]!] };
    return null;
  } });
  // DECISION-05 视口基线 1440×900；本用例显式落到 960px 窄窗档：作品模式即抽屉收起态，顶栏常驻「对话」入口。
  vi.stubGlobal("innerWidth", 960);
  renderAt("/agent/conv-unread");
  const openChat = await screen.findByRole("button", { name: "对话" });
  expect(document.querySelector(".agent-root")!.hasAttribute("data-chat-drawer")).toBe(false);
  const source = () => FakeEventSource.instances.find(item => !item.closed)!;
  // 用户自己的回显不点亮未读。
  messages["msg-echo"] = messageFixture({ id: "msg-echo", role: "user", text: "尽快给我初剪" });
  source().emit("business", { eventId: "echo", kind: "message.changed", entityId: "msg-echo", entityVersion: 1 });
  await screen.findByText("尽快给我初剪");
  expect(screen.queryAllByRole("button", { name: "展开对话（有新回复）" })).toHaveLength(0);
  // Frame 的新回复同时点亮暗栏圆点与顶栏入口。
  messages["msg-reply"] = messageFixture({ id: "msg-reply", role: "assistant", text: "初剪好了，请回到对话确认。" });
  source().emit("business", { eventId: "reply", kind: "message.changed", entityId: "msg-reply", entityVersion: 1 });
  await screen.findByText("初剪好了，请回到对话确认。");
  const unread = screen.getAllByRole("button", { name: "展开对话（有新回复）" });
  expect(unread).toHaveLength(2);
  expect(unread.some(button => button.querySelector(".agent-rail-dot") !== null)).toBe(true);
  expect(openChat.querySelector(".agent-chat-dot")).not.toBeNull();
  // 顶栏入口展开抽屉：圆点清零，暗栏回到「收起对话」。
  await userEvent.click(openChat);
  await waitFor(() => expect(document.querySelector(".agent-root")!.hasAttribute("data-chat-drawer")).toBe(true));
  expect(screen.queryAllByRole("button", { name: "展开对话（有新回复）" })).toHaveLength(0);
  expect(screen.getByRole("button", { name: "收起对话" })).toBeInTheDocument();
  // 收起后同一条消息的后续修订不重复点亮。
  fireEvent.keyDown(document.querySelector(".agent-root")!, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".agent-root")!.hasAttribute("data-chat-drawer")).toBe(false));
  messages["msg-reply"] = { ...messages["msg-reply"]!, revision: 2 };
  source().emit("business", { eventId: "reply-2", kind: "message.changed", entityId: "msg-reply", entityVersion: 2 });
  await waitFor(() => expect(screen.getByText("初剪好了，请回到对话确认。")).toBeVisible());
  expect(screen.queryAllByRole("button", { name: "展开对话（有新回复）" })).toHaveLength(0);
});

