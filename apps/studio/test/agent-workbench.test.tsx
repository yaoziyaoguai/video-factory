import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench } from "../src/client/agent/AgentWorkbench.js";
import { ProposalCard } from "../src/client/agent/AgentWorkbench.js";
import { MarkdownText } from "../src/client/agent/markdown.js";
import { MediaPreview, RunCard } from "../src/client/agent/ProductionCards.js";
import {
  appendNotice, clearDraft, draftStorageKey, loadDraft, loadPanelLayout, mergeArtifacts,
  mergeMessages, mergeProposals, saveDraft, savePanelLayout,
} from "../src/client/agent/workspace-state.js";
import type {
  ArtifactDraft, ArtifactHead, ArtifactRevision, Bootstrap, Conversation, MaterialBatch, Message, MessageInput, Snapshot, Proposal, Run, SkillPackagesView,
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
    ...options,
  };
}

function artifactFixture(id: string, title: string, revisionId: string, revisionNumber: number): ArtifactHead {
  return { id, title, kind: "script", revisionId, revisionNumber, workId: null, updatedAt: "2026-01-01T00:00:00.000Z" };
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
    materialBatches: [],
  };
}

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

function productionFixture(conversation: Conversation): { proposal: Proposal; run: Run; snapshot: Snapshot; bootstrap: Bootstrap } {
  const proposal: Proposal = { id: "proposal-b", conversationId: conversation.id, digest: "a".repeat(64), revision: 1, state: "ready", acceptedRunId: null,
    expiresAt: "2099-01-01T00:00:00Z", priceDisclosure: "模拟媒体 12 元，无真实扣费", spec: { workId: null, title: "模拟短片", inputRevisions: [{ artifactId: "art-1", revisionId: "rev-1" }],
      operations: [{ operationId: "op-1", outputSlot: "video", inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest: "a".repeat(64) }],
        kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1,
        quotePerAttempt: { currency: "CNY", amountMinor: 1200 }, priceKind: "bounded" }], finalOutput: { operationId: "op-1", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 1200 } } };
  const run: Run = { id: "run-b", conversationId: conversation.id, workId: "work-b", snapshotId: "snapshot-b", proposalId: proposal.id, revision: 1, state: "queued", title: "模拟短片",
    finance: { state: "reserved", currency: "CNY", reservedMinor: 1200, pendingUnknownMinor: 0, settledMinor: 0, priceKind: "bounded" }, inputRevisions: proposal.spec.inputRevisions,
    outputRevisions: [], operations: [{ operationId: "op-1", kind: "video", state: "pending", media: null }], segments: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", issue: null };
  const snapshot = snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "原 Prompt", "rev-1", 1)], messages: [messageFixture({ id: "proposal-message", role: "assistant", text: "提案准备好了。", references: { artifacts: [], proposalIds: [proposal.id], runIds: [], materialBatchIds: [] } })] });
  snapshot.proposals.items = [proposal];
  const bootstrap: Bootstrap = { ...BOOTSTRAP, models: [...BOOTSTRAP.models, { ...BOOTSTRAP.models[0]!, kind: "video", features: ["offline-fixture"] }] };
  return { proposal, run, snapshot, bootstrap };
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
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(""));
  const command = calls.find(c => c.method === "POST" && c.url.endsWith("/messages"))!.body as Record<string, unknown>;
  expect(command.proposalRef).toEqual({ proposalId: f.proposal.id, digest: f.proposal.digest });
  expect(command.text).toBe("开始制作？"); expect(command.target).toBeNull(); expect(command.skillId).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "我们聊点别的");
  f.run = { ...f.run, revision: 3, state: "succeeded", finance: { ...f.run.finance, state: "settled", settledMinor: 1200, reservedMinor: 0 }, outputRevisions: [{ artifactId: "video-b", revisionId: "video-rev" }] };
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
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
    expect(loadDraft("c1")).toEqual({ text: "再短一点", targetArtifactId: "art-1", targetRevisionId: "rev-1" });
    window.localStorage.setItem(draftStorageKey("c2"), "{oops");
    expect(loadDraft("c2")).toBeNull();
    clearDraft("c1");
    expect(loadDraft("c1")).toBeNull();
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

describe("AgentWorkbench", () => {
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
    await userEvent.click(screen.getByRole("button", { name: "模型配置" }));
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
    await screen.findByText("新的会话", { selector: ".agent-chat-header h1" });
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
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

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
      state: "ready", priceDisclosure: "预计 0.00 元（离线验证，不产生真实支出）", expiresAt: "2026-01-01T01:00:00.000Z",
      acceptedRunId: null, revision: 1,
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
  await userEvent.click((await screen.findAllByRole("button", { name: "脚本" }))[0]!);
  expect(await screen.findByText("正文 rev-1")).toBeInTheDocument();
  // 历史修订统一只读：不暴露会被服务端拒绝的旧稿意见/修改入口。
  expect(screen.getByText("历史版本仅阅读")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "只记录意见" })).toBeNull();
  expect(screen.queryByRole("button", { name: "提意见" })).toBeNull();
  head = artifactFixture("art-1", "脚本", "rev-3", 3);
  const source = FakeEventSource.instances.find(item => !item.closed)!;
  source.emit("business", { eventId: "event-new", kind: "artifact.delivered", entityId: "art-1", entityVersion: 3 });
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
  expect(commands[0]!.stageConfirmation).toBeUndefined();
  const link = await screen.findByRole("link", { name: "「雨后音乐」原批次第 2 首「未标声乐的曲目」" });
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
  await userEvent.type(text, "原来的要求"); await userEvent.click(screen.getByRole("button", { name: "发送" }));
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
    await userEvent.type(text, "正常发送"); await userEvent.click(screen.getByRole("button", { name: "发送" }));
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
  await userEvent.type(text, "结尾再安静一点"); await userEvent.click(screen.getByRole("button", { name: "干预本轮" }));
  await waitFor(() => expect(text).toHaveValue(""));
  expect(calls.find(call => call.method === "POST")?.body).toMatchObject({ mode: "steer", target, steerRequestId: "active-request" });
});

it.each([false, true])("审计 F5：末次费用事件补读失败保留重连入口，历史页=%s", async outsideFirstPage => {
  const conv = conversationFixture("billing-resync", "费用同步"), f = productionFixture(conv);
  const run = { ...f.run, state: "succeeded" as const, finance: { ...f.run.finance, state: "pending_reconciliation" as const, reservedMinor: 0, pendingUnknownMinor: 1200 } };
  f.snapshot.runs.items = [run];
  f.snapshot.messages.items.push(messageFixture({ id: "finished-run", role: "system_notice", text: "执行结束，费用待核", references: { artifacts: [], proposalIds: [], runIds: [run.id], materialBatchIds: [] } }));
  let failReads = 0;
  let latest: Run = run;
  installWorkbenchRoutes({ conversations: [conv], snapshots: { [conv.id]: f.snapshot }, onRequest: url => {
    if (url.endsWith(`/runs/${run.id}`)) { if (failReads > 0) { failReads--; throw new TypeError("once offline"); } return { status: 200, body: latest }; }
    return null;
  } });
  renderAt(`/agent/${conv.id}`); await screen.findByRole("heading", { name: "费用同步" });
  await userEvent.click(screen.getByRole("button", { name: "制作记录 · 1" }));
  await screen.findByText(/供应商账单待核对/);
  await waitFor(() => expect(FakeEventSource.instances.some(s => !s.closed)).toBe(true));
  failReads = outsideFirstPage ? 2 : 1;
  latest = { ...run, revision: 2, finance: { ...run.finance, state: "settled", pendingUnknownMinor: 0, settledMinor: 1200 } };
  f.snapshot.runs.items = outsideFirstPage ? [] : [latest];
  FakeEventSource.instances.find(s => !s.closed)!.emit("business", { eventId: "last-billing", kind: "run.changed", entityId: run.id, entityVersion: 2 });
  await userEvent.click(await screen.findByRole("button", { name: "重新连接" }));
  if (outsideFirstPage) {
    await screen.findByText(/部分最新状态尚未同步/);
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
  source.emit("text.delta", { requestId: "r1", sequence: 1, text: "临时流式文本" });
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
  FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "old-update", kind: "artifact.delivered", entityId: "old", entityVersion: 3 });
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
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))).toHaveLength(1));
  expect(calls.find(call => call.url.endsWith("/messages"))?.body).toMatchObject({ text: "先聊聊想法，暂时不要制作", target: null, proposalRef: null });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue(""));
  expect(calls.filter(call => call.url.includes("acceptances"))).toHaveLength(0);
});

it("Frame 三个设置入口独立，往返保留预览、目标和草稿，不打开旧资源页", async () => {
  const conversation = conversationFixture("frame-nav", "随时接着聊");
  installWorkbenchRoutes({ conversations: [conversation], snapshots: { "frame-nav": snapshotFixture(conversation, { artifacts: [artifactFixture("art-1", "我的 Prompt", "rev-1", 1)] }) } });
  renderAt("/agent/frame-nav");
  await userEvent.click(await screen.findByRole("button", { name: "我的 Prompt" }));
  await userEvent.click(await screen.findByRole("button", { name: "提意见" }));
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "结尾再安静一点");
  await userEvent.click(screen.getByRole("button", { name: "模型配置" }));
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  await userEvent.click(screen.getByRole("button", { name: "免费服务" }));
  expect(screen.getByRole("tab", { name: "热点资讯" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /用户页/ }));
  expect(screen.getByLabelText("显示名称")).toHaveValue("本地用户");
  await userEvent.click(within(screen.getByRole("navigation", { name: "会话列表" })).getByRole("button", { name: "随时接着聊" }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("结尾再安静一点");
  expect(screen.getByText(/针对：我的 Prompt/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "我的 Prompt" })).toBeInTheDocument();
  expect(document.querySelector('a[href="/resources"]')).toBeNull();
});

it("S1-13/14 多调用草稿和压缩结束可单独到达；clear、断线、终态后不能复活，不抢旧阅读", async () => {
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
  expect(within(row).getAllByRole("button", { name: "早前作品" })[0]).toHaveTextContent("v1");
  await userEvent.click(within(row).getAllByRole("button", { name: "早前作品" })[0]!);
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
  await userEvent.click(await within(row).findByRole("button", { name: "早前作品" }));
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
  f.proposal.spec.inputRevisions = [];
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

it("S1-09 查看制作记录期间，原作品的旧修订仍可完成读取", async () => {
  const conv = conversationFixture("reading-run", "保留原阅读");
  const f = productionFixture(conv);
  f.proposal = { ...f.proposal, state: "accepted", acceptedRunId: f.run.id,
    spec: { ...f.proposal.spec, inputRevisions: [{ artifactId: "art-1", revisionId: "rev-2" }], operations: [{ ...f.proposal.spec.operations[0],
      inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-2", digest: "a".repeat(64) }],
    }] } };
  f.snapshot.proposals.items = [f.proposal];
  f.snapshot.artifacts.items = [artifactFixture("art-1", "原 Prompt", "rev-2", 2)];
  f.run.inputRevisions = f.proposal.spec.inputRevisions;
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
  ui.rerender(<RunCard run={{ ...f.run, state: "failed", operations: f.run.operations.map(op => ({ ...op, state: "failed" })), finance: { ...f.run.finance, state: "pending_reconciliation", settledMinor: 300, pendingUnknownMinor: 900 } }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
  await userEvent.click(screen.getByText("回看原提案：模拟短片"));
  expect(screen.getByText(/拼接顺序/)).toHaveTextContent("本次视频 1产出 → 本次视频 2产出 → 本次视频 1产出");
  expect(screen.getByText(/供应商账单待核对/)).toHaveTextContent("已核对 ¥3.00，待核对部分估算 ¥9.00");
  expect(screen.queryByText(/100%/)).toBeNull();
  expect(screen.getByText(/已完成 0/)).toBeInTheDocument();
  ui.rerender(<RunCard run={{ ...f.run, state: "succeeded", operations: f.run.operations.map(op => ({ ...op, state: "succeeded" })) }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
  expect(screen.getByText(/100%/)).toBeInTheDocument();
  ui.rerender(<RunCard run={{ ...f.run, state: "running", operations: f.run.operations.map(op => ({ ...op, state: "succeeded" })), finance: { ...f.run.finance, state: "pending_reconciliation", settledMinor: 0, pendingUnknownMinor: 900 } }} onCancel={vi.fn()} simulated proposals={[proposal]} {...props} />);
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
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
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
  await userEvent.click(screen.getByRole("button", { name: "干预本轮" }));
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
    { id: "builtin", source: "builtin", name: "内置创作", origin: "builtin", skillIds: ["builtin-writing"], status: "ready", diagnostics: [] },
    { id: "local-kit", source: "/srv/skills/travel-kit", name: "周末创作包", origin: "installed", skillIds: ["weekend-prompt", "weekend-script"], status: "ready", diagnostics: [] },
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
  await userEvent.click(screen.getByRole("button", { name: "Skill 管理" }));
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
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(select).toHaveValue(""));
  expect(calls.find(call => call.url.endsWith("/messages"))?.body).toMatchObject({ skillId: "weekend-prompt", text: "接着聊旅行" });
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "保留下一条想法");
  await userEvent.selectOptions(select, "weekend-script");
  await userEvent.click(screen.getByRole("button", { name: "Skill 管理" }));
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
    packages: [...BUILTIN_SKILLS.packages,
      { id: "empty", source: "npm:empty-skill-package", name: "空包", origin: "installed", skillIds: [], status: "no_skills", diagnostics: ["未发现 SKILL.md"] },
      { id: "broken", source: "https://example.test/broken.git", name: "错误包", origin: "installed", skillIds: [], status: "invalid", diagnostics: ["Skill frontmatter 缺少 description"] },
    ],
  };
  installWorkbenchRoutes({ conversations: [], onRequest: url => url.endsWith("/settings/skills") ? { status: 200, body: packages } : null });
  renderAt("/agent?page=skills");
  const empty = await screen.findByRole("article", { name: "空包" });
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
  await userEvent.click(screen.getByRole("button", { name: "Skill 管理" }));
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
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "消息输入" }), { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Skill 目录正在更新");
  expect(calls.filter(call => call.url.endsWith("/messages"))).toHaveLength(0);
  packages = SKILL_PACKAGES;
  await act(async () => finish({ status: 200, body: packages }));
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
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
  await userEvent.click(screen.getByRole("button", { name: "Skill 管理" }));
  await screen.findByRole("article", { name: "周末创作包" });
  await userEvent.click(screen.getByRole("button", { name: "安装 Skill" }));
  await userEvent.type(screen.getByLabelText("包来源"), "npm:keep-draft");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "安装" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请等待完成后再操作");
  expect(screen.getByLabelText("包来源")).toHaveValue("npm:keep-draft");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: conversation.title }));
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前对话还在处理");
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("等目录空闲后发送");
  expect(select).toHaveValue("weekend-script");
  expect(screen.queryByRole("button", { name: /重试上次发送/ })).toBeNull();
  expect(localStorage.getItem(`vf:agent-send:${conversation.id}`)).toBeNull();
  expect(calls.filter(call => call.url.endsWith("/messages"))).toHaveLength(1);
});
