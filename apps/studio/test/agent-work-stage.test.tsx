import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench } from "../src/client/agent/AgentWorkbench.js";
import { MarkdownText } from "../src/client/agent/markdown.js";
import { ProposalCard, RunCard } from "../src/client/agent/ProductionCards.js";
import type {
  ArtifactHead, ArtifactRevision, AudioSummary, Bootstrap, Conversation, InputRef, LibraryVideo, MaterialBatch, MaterialBatchIndexItem, Message, MessageInput, Proposal, Run, RunSegment, Snapshot, Work, WorkStage, WorkStageView,
} from "../src/shared/agent/generated/contracts.js";

// R2 阶段工作台：works/materialBatches 的三阶段呈现、认可按钮走 MessageInput.stageConfirmation、
// 素材批次按原始顺序展示。API 与 SSE 打桩；完整真实旅程留给正式 /agent 浏览器验收。

type RouteResult = { status: number; body: unknown } | null;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(handler: (url: string, call: FetchCall) => RouteResult | Promise<RouteResult>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call: FetchCall = { url, method: init?.method ?? "GET", headers, body };
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
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
    });
  }
}

// —— 夹具 ——

const BOOTSTRAP: Bootstrap = {
  ownerId: "owner-1",
  displayName: "本地用户",
  models: [{
    binding: { providerId: "pi-faux", modelId: "faux-text-1", connectionId: "conn-1", configurationRevisionId: "cfg-1" },
    name: "本地离线模型（Faux）", kind: "text", features: [], availability: "configured",
    verificationNote: "离线验证。", isDefault: true,
  }],
  skills: [],
};

const MUSIC_SOUND_SUMMARY: AudioSummary = {
  original: [
    { segmentId: "scene-a", gain: 0.5, sourceText: "可追溯的原声 L1。", textCoverage: "unknown" },
    { segmentId: "scene-b", gain: 0, sourceText: "静音片段的来源文字", textCoverage: "muted" },
    { segmentId: "scene-c", gain: 0.4, sourceText: "源片段 L1 的完整台词。", textCoverage: "source_excerpt" },
  ],
  music: {
    source: { provider: "freetouse", assetId: "frozen-track", title: "雨停主题曲", creatorName: "作者甲、作者乙", creatorUrl: null,
      sourceUrl: "https://freetouse.com/music/frozen-track", licenseUrl: "https://freetouse.com/license", licenseName: "FreeToUse Non-Premium",
      licenseVersion: null, acquiredAt: "2026-01-01T00:00:00Z", usageScope: "个人社交平台 UGC，需署名",
      attributionText: "雨停主题曲 by 作者甲、作者乙 — https://freetouse.com/music" },
    sourceStartMs: 10000, sourceDurationMs: 20000, timelineStartMs: 0, playDurationMs: 9000,
    repeat: false, gain: 0.2, fadeInMs: 500, fadeOutMs: 1000, duckUnderNarration: true,
  },
  narration: { text: "独立配音 L2。", providerName: "MiniMax", modelName: "speech-2.8-turbo", voiceName: "温润男声", timelineStartMs: 1000, gain: 1 },
};

// 文本模型未配置：继续画面需要文本模型，但纯确认仍可用。
const NO_TEXT_BOOTSTRAP: Bootstrap = {
  ...BOOTSTRAP,
  models: [{ ...BOOTSTRAP.models[0]!, availability: "unverified" }],
};

function conversationFixture(id: string, title: string): Conversation {
  return { id, title, revision: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function messageFixture(options: Partial<Message> & Pick<Message, "id" | "role" | "text">): Message {
  return {
    requestId: null, state: "completed", revision: 1, target: null, createdAt: "2026-01-01T00:00:00.000Z", createdSequence: 1,
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] }, kind: "chat", feedback: null, ...options,
  };
}

function stageView(stage: WorkStage, options: Partial<WorkStageView> = {}): WorkStageView {
  return { stage, draft: null, approved: null, approvedAt: null, confirmationId: null, upstreamStale: false, proposalId: null, runId: null, confirmationAction: null, ...options };
}

function workFixture(options: {
  id: string; title: string; stage?: WorkStage; revision?: number; updatedAt?: string;
  content?: Partial<WorkStageView>; plan?: Partial<WorkStageView>; video?: Partial<WorkStageView>;
}): Work {
  return {
    id: options.id, title: options.title, stage: options.stage ?? "content", revision: options.revision ?? 1,
    stages: {
      content: stageView("content", options.content),
      plan: stageView("plan", options.plan),
      video: stageView("video", options.video),
    },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: options.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function artifactFixture(id: string, title: string, revisionId: string, revisionNumber: number, kind: ArtifactHead["kind"] = "script", workId: string | null = "work-1"): ArtifactHead {
  return { id, title, kind, revisionId, revisionNumber, workId, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function revisionFixture(artifactId: string, revisionId: string, revisionNumber: number, text: string, baseRevisionId: string | null = null): ArtifactRevision {
  return { artifactId, revisionId, revisionNumber, baseRevisionId, requestId: "req-1", runId: null, digest: `sha256:${revisionId}`, content: { format: "markdown", text }, createdAt: "2026-01-01T00:00:00.000Z" };
}

function batchIndexFixture(batchId: string, query: string, kind: "image" | "video", resultCount: number): MaterialBatchIndexItem {
  return { batchId, requestId: "req-1", messageId: "msg-search", query: { provider: "pexels", kind, query, limit: 10 }, retrievedAt: "2026-01-01T00:00:00.000Z", resultCount };
}

function batchFixture(batchId: string, query: string, results: MaterialBatch["results"]): MaterialBatch {
  return { batchId, revision: 1, requestId: "req-1", toolCallId: "call-1", query: { provider: "pexels", kind: "video", query, limit: 10 }, retrievedAt: "2026-01-01T00:00:00.000Z", results, messageId: "msg-search" };
}

function candidateFixture(candidateId: string, title: string, kind: "image" | "video"): MaterialBatch["results"][number] {
  return {
    candidateId, provider: "pexels", providerAssetId: `px-${candidateId}`, kind, title,
    sourceUrl: `https://www.pexels.com/video/${candidateId}/`, creatorName: "作者甲", creatorUrl: "https://www.pexels.com/@author/",
    previewUrl: `https://images.pexels.com/${candidateId}.jpg`, width: 1920, height: 1080, durationMs: kind === "video" ? 8300 : null,
    licenseUrl: `https://www.pexels.com/license/${candidateId}/`,
  };
}

function proposalFixture(id: string, title: string, workId: string | null): Proposal {
  return {
    id, conversationId: "conv-w", digest: "a".repeat(64), revision: 1, state: "ready", acceptedRunId: null,
    expiresAt: "2099-01-01T00:00:00Z", priceDisclosure: "模拟媒体 12 元，无真实扣费",
    spec: {
      workId, title, inputRevisions: [{ artifactId: "art-script", revisionId: "art-script-rev-2" }],
      operations: [{
        operationId: "op-1", outputSlot: "video", inputs: [{ kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "a".repeat(64) }],
        kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1,
        quotePerAttempt: { currency: "CNY", amountMinor: 1200 }, priceKind: "bounded",
      }],
      finalOutput: { operationId: "op-1", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 1200 },
    },
  };
}

// E1 片段阅读身份：run 的 segments 按冻结方案顺序给出，video 修订经 runId 绑定产出它的制作。
function runFixture(id: string, title: string, videoArtifactId: string, videoRevisionId: string, segments: RunSegment[], state: Run["state"] = "succeeded"): Run {
  return {
    id, conversationId: "conv-w", workId: "work-1", snapshotId: `snap-${id}`, proposalId: `proposal-${id}`, revision: 1, state, title,
    finance: { state: "settled", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 0, priceKind: "bounded" },
    inputRevisions: [], outputRevisions: [{ artifactId: videoArtifactId, revisionId: videoRevisionId }], operations: [],
    segments, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", issue: null,
  };
}

function segmentFixture(segmentId: string, title: string, blobId: string | null, state: RunSegment["state"] = "succeeded"): RunSegment {
  return {
    segmentId, title, plan: { artifactId: "art-plan", revisionId: "plan-rev-2" }, content: null, sourceSectionIds: [],
    media: blobId ? { format: "media", blobId, mimeType: "video/mp4", durationMs: 3000 } : null,
    revision: null, state, startMs: null, durationMs: null,
  };
}

function videoRevisionFixture(artifactId: string, revisionId: string, runId: string, wholeBlobId: string): ArtifactRevision {
  return { ...revisionFixture(artifactId, revisionId, 1, ""), runId, content: { format: "media", blobId: wholeBlobId, mimeType: "video/mp4", durationMs: 3000 } };
}

// 方案稿按段落给出：片段意见的 segmentStillCurrent 对照这里的段 id。
function planRevisionFixture(artifactId: string, revisionId: string, sectionIds: [string, ...string[]]): ArtifactRevision {
  const sections = sectionIds.map((id, index) => ({ id, title: `段${index + 1}`, text: "段正文" }));
  return { ...revisionFixture(artifactId, revisionId, Number(/(\d+)$/.exec(revisionId)![1]), ""),
    content: { format: "markdown", text: "方案正文", sections: [sections[0]!, ...sections.slice(1)] } };
}

// 阶段工作台路由：snapshot 提供 works/materialBatches；works 与批次按 id 读取。
function installStageRoutes(options: {
  conversation?: Conversation;
  works?: Work[];
  materialBatches?: MaterialBatchIndexItem[];
  batchDetails?: Record<string, MaterialBatch>;
  messages?: Message[];
  artifacts?: ArtifactHead[];
  proposals?: Proposal[];
  bootstrap?: Bootstrap;
  onRequest?: (url: string, call: FetchCall) => RouteResult | Promise<RouteResult>;
} = {}) {
  const conversation = options.conversation ?? conversationFixture("conv-w", "创作对话");
  const snapshot: Snapshot = {
    conversation,
    eventCursor: `cursor-${conversation.id}`,
    messages: { items: options.messages ?? [], nextCursor: null, watermark: "wm-1" },
    artifacts: { items: options.artifacts ?? [], nextCursor: null, watermark: "wm-1" },
    runs: { items: [], nextCursor: null, watermark: "wm-1" },
    activeRequestId: null,
    proposals: { items: options.proposals ?? [], nextCursor: null, watermark: "wm-1" },
    works: options.works ?? [],
    materialBatches: options.materialBatches ?? [],
  };
  const batchDetails = options.batchDetails ?? {};
  const calls = installFetch(async (url, call) => {
    const intercepted = await options.onRequest?.(url, call);
    if (intercepted) return intercepted;
    if (call.method === "GET" && url.endsWith("/api/agent/v1/bootstrap")) return { status: 200, body: options.bootstrap ?? BOOTSTRAP };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/settings/model-connections")) return { status: 200, body: { revision: 0, connections: [], modelStatuses: [] } };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/profile")) return { status: 200, body: { revision: 1, displayName: "本地用户", bio: "" } };
    if (call.method === "GET" && url.endsWith("/api/agent/v1/conversations")) return { status: 200, body: { items: [conversation], nextCursor: null, watermark: "wm-1" } };
    if (call.method === "GET" && url.endsWith(`/conversations/${conversation.id}/snapshot`)) return { status: 200, body: snapshot };
    const workMatch = /\/api\/agent\/v1\/works\/([^/]+)$/.exec(url);
    if (call.method === "GET" && workMatch) return { status: 200, body: snapshot.works.find(item => item.id === workMatch[1]) ?? null };
    const batchMatch = /\/api\/agent\/v1\/material-batches\/([^/]+)$/.exec(url);
    if (call.method === "GET" && batchMatch) return { status: 200, body: batchDetails[batchMatch[1]!] ?? null };
    const revisionMatch = /\/api\/agent\/v1\/artifacts\/([^/]+)\/revisions\/([^/]+)$/.exec(url);
    if (call.method === "GET" && revisionMatch) {
      const artifactId = revisionMatch[1]!, revisionId = revisionMatch[2]!;
      const number = Number(/(\d+)$/.exec(revisionId)?.[1] ?? 1);
      return { status: 200, body: revisionFixture(artifactId, revisionId, number, `${artifactId} 正文 ${revisionId}`, number > 1 ? `${artifactId}-rev-${number - 1}` : null) };
    }
    const headMatch = /\/api\/agent\/v1\/artifacts\/([^/]+)$/.exec(url);
    if (call.method === "GET" && headMatch) return { status: 200, body: artifactFixture(headMatch[1]!, `作品 ${headMatch[1]!}`, `${headMatch[1]!}-rev-2`, 2) };
    if (call.method === "GET" && url.endsWith("/messages/msg-search")) return { status: 200, body: options.messages?.find(item => item.id === "msg-search") ?? null };
    if (call.method === "POST" && url.endsWith("/messages")) return { status: 202, body: { requestId: "req-confirm", messageId: "msg-confirm", state: "completed", replayed: false, runId: null } };
    return null;
  });
  return { calls, snapshot };
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

const workPane = () => document.querySelector(".agent-work") as HTMLElement;

describe("R2 阶段工作台", () => {
  it("内容阶段呈现当前稿与两个认可按钮；认可走 stageConfirmation 且不动聊天草稿", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    expect(await screen.findByRole("heading", { name: "城市短片" })).toBeInTheDocument();
    expect(screen.getByText("内容待确认")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /内容草稿/ })).toBeEnabled();
    expect(screen.getByRole("tab", { name: /画面与声音/ })).toBeDisabled();
    expect(screen.getByRole("tab", { name: /视频初稿/ })).toBeDisabled();
    await screen.findByText("art-script 正文 art-script-rev-2");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "我还没想好，先留着");
    await userEvent.click(screen.getByRole("button", { name: "认可，暂不继续" }));
    const command = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as Record<string, unknown>;
    // subject 只按输入合同组装：artifact_revision 变体按输入合同组 subject，不展开服务端输出对象。
    expect(command.stageConfirmation).toEqual({
      workId: "work-1", action: "approve_content",
      subject: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" },
    });
    expect(command.mode).toBe("new");
    // 阶段按钮独立构造请求，不清空用户未发送的聊天草稿
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("我还没想好，先留着");
  });

  it("纯认可后显示暂停态：不再出现暂不继续按钮，只保留继续入口", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: source, approved: source, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-1", confirmationAction: "approve_content" as const },
    });
    installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    expect(await screen.findByText("已认可，暂停中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认可，暂不继续" })).toBeNull();
    expect(screen.getByRole("button", { name: "认可并继续画面" })).toBeEnabled();
  });

  it("无可用文本模型时：纯认可仍可用，继续禁用并给出受控说明", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    const harness = installStageRoutes({
      works: [work], bootstrap: NO_TEXT_BOOTSTRAP,
      artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)],
    });
    renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("button", { name: "认可，暂不继续" })).toBeEnabled();
    const continueButton = screen.getByRole("button", { name: "认可并继续画面" });
    expect(continueButton).toBeDisabled();
    expect(screen.getByText("继续画面需要可用的文本模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "认可，暂不继续" }));
    await waitFor(() => expect(harness.calls.some(call => call.method === "POST" && call.url.endsWith("/messages"))).toBe(true));
  });

  it("查看旧版本时不能确认；回到最新稿后恢复确认入口", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await screen.findByText("art-script 正文 art-script-rev-1");
    expect(screen.getByText("正在看旧版本，不能在这里确认；请回到最新稿。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认可，暂不继续" })).toBeNull();
    expect(screen.queryByRole("button", { name: "认可并继续画面" })).toBeNull();
    expect(screen.getByRole("button", { name: "提意见" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await screen.findByText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("button", { name: "认可，暂不继续" })).toBeEnabled();
  });

  it("读稿失败有重试；新阶段和 A/B 切换保留阅读阶段与未发送意见", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const a = workFixture({ id: "work-1", title: "城市短片", content: { draft } });
    const b = workFixture({ id: "work-2", title: "咖啡短片" });
    let failRead = true;
    const harness = installStageRoutes({ works: [a, b], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)],
      onRequest: url => url.endsWith(`/revisions/${draft.revisionId}`) && failRead
        ? { status: 503, body: { code: "UNAVAILABLE", message: "暂不可读" } } : null });
    renderAt("/agent/conv-w");
    await userEvent.click(await screen.findByRole("tab", { name: /城市短片/ }));
    await screen.findByText("草稿读取失败。");
    failRead = false;
    await userEvent.click(screen.getByRole("button", { name: "重试读取草稿" }));
    await screen.findByText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("separator", { name: "调整草稿与成果大小" })).toHaveAttribute("tabindex", "0");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "结尾我还在想");
    harness.snapshot.works[0] = workFixture({ id: a.id, title: a.title, revision: 2, stage: "plan",
      content: { draft, approved: draft, confirmationAction: "approve_content_continue" },
      plan: { draft: { kind: "artifact_revision", artifactId: "plan", revisionId: "plan-rev-1", digest: "p" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "plan-arrived", kind: "work.changed", entityId: a.id, entityVersion: 2 });
    await waitFor(() => expect(screen.getByRole("tab", { name: /画面与声音/ })).toBeEnabled());
    expect(screen.getByRole("tab", { name: /内容草稿/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
    await userEvent.click(screen.getByRole("tab", { name: /咖啡短片/ }));
    await userEvent.click(screen.getByRole("tab", { name: /城市短片/ }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
    await userEvent.click(within(screen.getByLabelText("当前会话产物")).getByRole("button", { name: "城市内容" }));
    expect(screen.queryByRole("button", { name: "回到创作" })).toBeNull();
    expect(screen.getByRole("region", { name: "草稿与修改" })).toBeVisible();
    expect(screen.getByRole("region", { name: "已确认成果" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /内容草稿/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
  });

  it("旧版成品保留在成果区；未定稿的新视频只在草稿区预览", async () => {
    const source = { kind: "message_text" as const, messageId: "old-user-message", text: "采用的确切内容，不需要重新读取原消息", author: "user" as const };
    const video = { kind: "artifact_revision" as const, artifactId: "video", revisionId: "video-rev-2", digest: "v2" };
    installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "video",
      content: { draft: source, approved: source, confirmationAction: "approve_content_continue" },
      video: { draft: video, approved: { ...video, revisionId: "video-rev-1", digest: "v1" }, confirmationAction: "finalize_video" } })],
      artifacts: [artifactFixture("video", "视频初稿", "video-rev-2", 2, "video")],
      onRequest: url => /revisions\/video-rev-[12]$/.test(url) ? { status: 200, body: {
        ...revisionFixture("video", url.endsWith("1") ? "video-rev-1" : "video-rev-2", url.endsWith("1") ? 1 : 2, "", null),
        content: { format: "media", blobId: url.endsWith("1") ? "file-approved" : "file-real", mimeType: "video/mp4", durationMs: 3000, width: 640, height: 360, sources: [] },
      } } : null });
    renderAt("/agent/conv-w");
    expect(await screen.findByRole("button", { name: "以这版定稿" })).toBeEnabled();
    expect(screen.getByText("初稿可看")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "草稿与修改" })).getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/file-real/content"));
    await userEvent.click(screen.getByRole("tab", { name: /内容草稿/ }));
    expect(await screen.findByText(source.text)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "已确认成果" })).queryByLabelText("视频预览")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: /视频初稿/ }));
    expect(within(screen.getByRole("region", { name: "已确认成果" })).getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/file-approved/content");
  });

  it("尚未绑定交付的 work 提案在聊天和全局列表都没有开始按钮", async () => {
    const source = { kind: "message_text" as const, messageId: "m", text: "内容", author: "user" as const };
    const unbound = proposalFixture("proposal-unbound", "未交付方案", "work-1");
    installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source, confirmationAction: "approve_content_continue" } })],
      proposals: [unbound], messages: [messageFixture({ id: "m-plan", role: "assistant", text: "先准备了提案。",
        references: { artifacts: [], proposalIds: [unbound.id], runIds: [], materialBatchIds: [] } })] });
    renderAt("/agent/conv-w");
    await screen.findByText("先准备了提案。");
    expect(screen.queryByText(/制作提案 · 1/)).toBeNull();
    expect(screen.queryByRole("button", { name: "确认制作" })).toBeNull();
  });

  it("认可并继续后事项推进到方案阶段；认可命令按（事项,动作）持久可重放", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: source },
    });
    const harness = installStageRoutes({
      works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          harness.snapshot.works = [workFixture({
            id: "work-1", title: "城市短片", stage: "plan", revision: 2, updatedAt: "2026-01-02T00:00:00.000Z",
            content: { draft: source, approved: source, approvedAt: "2026-01-02T00:00:00.000Z", confirmationId: "conf-2", confirmationAction: "approve_content_continue" as const },
            plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-1", digest: "sha256:art-plan-rev-1" } },
          })];
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "认可并继续画面" }));
    const command = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as Record<string, unknown>;
    expect((command.stageConfirmation as Record<string, unknown>).action).toBe("approve_content_continue");
    expect((command.stageConfirmation as Record<string, unknown>).subject).toEqual({
      kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2",
    });
    // 快照合并后：阶段推进到方案，内容页签显示已认可并继续
    await waitFor(() => expect(screen.getByText("方案待确认")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /画面与声音/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("tab", { name: /内容草稿/ }));
    expect(await screen.findByText("已认可并继续")).toBeInTheDocument();
    expect(screen.getByText("已认可并继续画面阶段；改稿后会重新等待确认。")).toBeInTheDocument();
    // 成功后命令持久被清理，不留下重放痕迹
    expect(window.localStorage.getItem("vf:agent-stage:conv-w:work-1:approve_content_continue")).toBeNull();
  });

  it("方案只对当前绑定提供制作；读旧稿无当前稿动作，聊天独立提案不受影响，回最新提交准确提案", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const bound = proposalFixture("proposal-bound", "城市短片制作", "work-1");
    const old = { ...proposalFixture("proposal-old", "城市旧提案", "work-1"), digest: "c".repeat(64) };
    const standalone = { ...proposalFixture("proposal-free", "独立小合成", null), digest: "b".repeat(64) };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-1", confirmationAction: "approve_content_continue" as const },
      plan: {
        draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-2", digest: "sha256:art-plan-rev-2" },
        approved: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-2", digest: "sha256:art-plan-rev-2" },
        confirmationAction: "approve_plan", proposalId: bound.id,
      },
    });
    const harness = installStageRoutes({
      works: [work], proposals: [bound, old, standalone],
      bootstrap: { ...BOOTSTRAP, models: [...BOOTSTRAP.models, { ...BOOTSTRAP.models[0]!, kind: "video", features: ["offline-fixture"] }] },
      artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2), artifactFixture("art-plan", "画面方案", "art-plan-rev-2", 2)],
      messages: [messageFixture({ id: "m-proposals", role: "assistant", text: "独立提案与旧提案保留各自引用。",
        references: { artifacts: [], proposalIds: [old.id, standalone.id], runIds: [], materialBatchIds: [] } })],
      onRequest: (url, call) => call.method === "POST" && url.endsWith("/acceptances")
        ? { status: 409, body: { code: "PROPOSAL_STALE", message: "已捕获本次提案引用，测试不启动制作。" } } : null,
    });
    renderAt("/agent/conv-w");
    await screen.findByText("费用已列在制作提案中，确认一次即可开始。");
    const pane = workPane();
    expect(within(pane).getByText("城市短片制作")).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "确认制作" })).toBeEnabled();
    expect(within(pane).queryByText("独立小合成")).toBeNull();
    await userEvent.click(await within(pane).findByRole("button", { name: "看上一版" }));
    await screen.findByText("art-plan 正文 art-plan-rev-1");
    expect(within(pane).queryByRole("button", { name: "确认制作" })).toBeNull();
    expect(within(pane).queryByTitle("制作能力尚未接入")).toBeNull();
    const chat = document.querySelector(".agent-messages") as HTMLElement;
    const standaloneCard = within(chat).getByText(standalone.spec.title).closest(".frame-production-proposal") as HTMLElement;
    expect(within(standaloneCard).getByRole("button", { name: "确认制作" })).toBeEnabled();
    const historicalCard = within(chat).getByText(old.spec.title).closest(".frame-production-proposal") as HTMLElement;
    expect(within(historicalCard).queryByRole("button", { name: "确认制作" })).toBeNull();
    expect(harness.calls.filter(call => call.url.endsWith("/acceptances"))).toHaveLength(0);
    await userEvent.click(within(pane).getByRole("button", { name: "查看最新稿" }));
    await screen.findByText("art-plan 正文 art-plan-rev-2");
    await userEvent.click(within(pane).getByRole("button", { name: "确认制作" }));
    await screen.findByRole("alert");
    const accepts = harness.calls.filter(call => call.url.endsWith("/acceptances"));
    expect(accepts).toHaveLength(1);
    expect(accepts[0]!.url).toContain(`/proposals/${bound.id}/acceptances`);
    expect(accepts[0]!.body).toMatchObject({ proposalDigest: bound.digest });
    expect(screen.queryByText(/制作提案 · 3/)).toBeNull();

    // 原方案已受理、视频已定稿后，回看不催开工；同作品的新绑定仍可开始。
    harness.snapshot.proposals.items[0] = { ...bound, revision: 2, state: "accepted", acceptedRunId: "run-done" };
    const video = { kind: "artifact_revision" as const, artifactId: "art-video", revisionId: "art-video-rev-1", digest: "sha256:video" };
    harness.snapshot.works[0] = { ...work, revision: 2, stage: "video", stages: { ...work.stages,
      video: stageView("video", { draft: video, approved: video, confirmationAction: "finalize_video", runId: "run-done" }),
    } };
    cleanup();
    renderAt("/agent/conv-w");
    await screen.findByRole("heading", { name: "城市短片" });
    await waitFor(() => expect(screen.queryByText("费用已列在制作提案中，确认一次即可开始。")).toBeNull());
    expect(within(workPane()).queryByRole("button", { name: "确认制作" })).toBeNull();

    const next = { ...bound, id: "proposal-next", digest: "d".repeat(64) };
    const nextPlan = { kind: "artifact_revision" as const, artifactId: "art-plan", revisionId: "art-plan-rev-3", digest: "sha256:art-plan-rev-3" };
    harness.snapshot.proposals.items.push(next);
    harness.snapshot.works[0] = { ...harness.snapshot.works[0]!, revision: 3, stage: "plan", stages: {
      ...harness.snapshot.works[0]!.stages, plan: { ...work.stages.plan, draft: nextPlan, approved: nextPlan, proposalId: next.id },
    } };
    cleanup();
    renderAt("/agent/conv-w");
    await userEvent.click(await screen.findByRole("button", { name: "查看最新稿" }));
    expect(await screen.findByText("费用已列在制作提案中，确认一次即可开始。")).toBeInTheDocument();
    expect(within(workPane()).getByRole("button", { name: "确认制作" })).toBeEnabled();
  });

  it("只认可方案立即进入成果区，随后准备费用沿用原方案且不动聊天草稿", async () => {
    const source = { kind: "message_text" as const, messageId: "content-message", text: "已确认的内容", author: "user" as const };
    const plan = { kind: "artifact_revision" as const, artifactId: "plan", revisionId: "plan-rev-1", digest: "sha256:plan-rev-1" };
    const proposal = proposalFixture("current-quote", "按已认可方案制作", "work-1");
    const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source, confirmationAction: "approve_content_continue" }, plan: { draft: plan } })],
      artifacts: [artifactFixture("plan", "画面与声音方案", plan.revisionId, 1)],
      onRequest: (url, call) => {
        if (/revisions\/plan-rev-[12]$/.test(url)) {
          const revisionId = url.endsWith("1") ? "plan-rev-1" : "plan-rev-2";
          return { status: 200, body: { ...revisionFixture("plan", revisionId, url.endsWith("1") ? 1 : 2, `plan 正文 ${revisionId}`),
            content: { format: "markdown", text: `plan 正文 ${revisionId}`, narrationText: url.endsWith("1") ? "雨停之前，先喝一杯咖啡。" : "窗外下雨，杯里回暖。" } } };
        }
        if (call.method === "POST" && url.endsWith("/messages")) {
          const body = call.body as MessageInput;
          const work = harness.snapshot.works[0]!;
          if (body.stageConfirmation) {
            work.stages.plan = { ...work.stages.plan, approved: plan, confirmationId: "plan-confirmed", confirmationAction: "approve_plan" };
          } else {
            work.stages.plan.proposalId = proposal.id;
            harness.snapshot.proposals.items = [proposal];
          }
          work.revision++;
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("plan 正文 plan-rev-1");
    expect(within(screen.getByRole("region", { name: "草稿与修改" })).getByText("雨停之前，先喝一杯咖啡。")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "这句先不发送");
    await userEvent.click(screen.getByRole("button", { name: "认可方案，暂不制作" }));
    const result = screen.getByRole("region", { name: "已确认成果" });
    expect(await within(result).findByText("plan 正文 plan-rev-1")).toBeInTheDocument();
    expect(within(result).queryByText(source.text)).toBeNull();
    expect(within(screen.getByRole("region", { name: "草稿与修改" })).queryByText("plan 正文 plan-rev-1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "准备制作" }));
    await screen.findByText(proposal.spec.title);
    const commands = harness.calls.filter(call => call.method === "POST").map(call => call.body as MessageInput);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.stageConfirmation?.action).toBe("approve_plan");
    expect(commands[1]!.stageConfirmation).toBeUndefined();
    expect(commands[1]!.proposalRef).toBeNull();
    expect(commands[1]!.target).toEqual({ artifactId: plan.artifactId, revisionId: plan.revisionId, workId: "work-1" });
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("这句先不发送");
    expect(harness.snapshot.works[0]!.stages.plan.draft).toEqual(plan);
    expect(within(result).getByText("雨停之前，先喝一杯咖啡。")).toBeInTheDocument();

    const nextPlan = { ...plan, revisionId: "plan-rev-2", digest: "sha256:plan-rev-2" };
    harness.snapshot.works[0]!.stages.plan.draft = nextPlan;
    harness.snapshot.works[0]!.revision++;
    harness.snapshot.artifacts.items[0] = artifactFixture("plan", "画面与声音方案", nextPlan.revisionId, 2);
    FakeEventSource.instances.find(eventSource => !eventSource.closed)!.emit("business", { eventId: "narration-updated", kind: "work.changed", entityId: "work-1", entityVersion: harness.snapshot.works[0]!.revision });
    await userEvent.click(await screen.findByRole("button", { name: "查看最新稿" }));
    expect(await within(screen.getByRole("region", { name: "草稿与修改" })).findByText("窗外下雨，杯里回暖。")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "已确认成果" })).getByText("雨停之前，先喝一杯咖啡。")).toBeInTheDocument();
  });

  it("V1 认可并继续制作一次完成认可与报价请求；结果未知重试沿用原命令，纯认可命令不串用", async () => {
    const source = { kind: "message_text" as const, messageId: "content-message", text: "已确认的内容", author: "user" as const };
    const plan = { kind: "artifact_revision" as const, artifactId: "plan", revisionId: "plan-rev-1", digest: "sha256:plan-rev-1" };
    let postCount = 0;
    const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source, confirmationAction: "approve_content_continue" }, plan: { draft: plan } })],
      artifacts: [artifactFixture("plan", "画面与声音方案", plan.revisionId, 1)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          // 每次发送都结果未知：认可不落库，按钮保留，可观察重试与另一按钮的命令。
          postCount += 1;
          return { status: 502, body: { code: "UNAVAILABLE", message: "结果未知" } };
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("plan 正文 plan-rev-1");
    expect(screen.getByRole("button", { name: "认可并继续制作" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "认可方案，暂不制作" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "认可并继续制作" }));
    await screen.findByRole("alert");
    const firstCommand = (harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput);
    expect(firstCommand.stageConfirmation).toMatchObject({ workId: "work-1", action: "approve_plan", next: "prepare_production",
      subject: { kind: "artifact_revision", artifactId: "plan", revisionId: "plan-rev-1" } });
    expect(firstCommand.text).toContain("准备制作");
    expect(firstCommand.text).toContain("现在先不提交生成");

    // 结果未知后重试同一意图：沿用原 commandId 原请求，不生成第二条命令。
    await userEvent.click(screen.getByRole("button", { name: "认可并继续制作" }));
    await screen.findByRole("alert");
    const retriedCommand = (harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput);
    expect(retriedCommand.commandId).toBe(firstCommand.commandId);
    expect(retriedCommand.stageConfirmation?.next).toBe("prepare_production");

    // 另一按钮是独立意图：新命令、不带 next，不串用准备请求的缓存命令。
    await userEvent.click(screen.getByRole("button", { name: "认可方案，暂不制作" }));
    await screen.findByRole("alert");
    const plainCommand = (harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput);
    expect(plainCommand.commandId).not.toBe(firstCommand.commandId);
    expect(plainCommand.stageConfirmation).toMatchObject({ workId: "work-1", action: "approve_plan" });
    expect(plainCommand.stageConfirmation?.next).toBeUndefined();
    expect(postCount).toBe(3);
  });

  it("上游待更新时方案页签如实提示，不提供开始入口", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source },
      plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-1", digest: "sha256:art-plan-rev-1" }, upstreamStale: true },
    });
    installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2), artifactFixture("art-plan", "画面方案", "art-plan-rev-1", 1)],
    });
    renderAt("/agent/conv-w");
    await screen.findByText("art-plan 正文 art-plan-rev-1");
    expect(screen.getByText("方案待更新")).toBeInTheDocument();
    expect(screen.getByText("内容主稿已更新，这份方案待更新；确认新内容并继续后再准备。")).toBeInTheDocument();
  });

  it("素材批次按消息引用点开：原始顺序、署名来源许可、空批次如实说明", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    const searchMessage = messageFixture({
      id: "msg-search", role: "assistant", text: "按第二镜找了夜景素材。",
      references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: ["batch-1", "batch-2"] },
    });
    const harness = installStageRoutes({
      works: [work], messages: [searchMessage],
      materialBatches: [batchIndexFixture("batch-1", "城市夜景", "video", 3), batchIndexFixture("batch-2", "雨后街道", "image", 0)],
      batchDetails: {
        "batch-1": batchFixture("batch-1", "城市夜景", [
          { ...candidateFixture("c-2", "夜景天桥", "video"), width: 1920, height: 1080, dimensionsKind: "download" },
          { ...candidateFixture("c-1", "路灯人流", "image"), provider: "pixabay", width: 2883, height: 1754, dimensionsKind: "source" },
          { ...candidateFixture("c-0", "未知尺寸", "image"), width: null, height: null },
        ]),
        "batch-2": batchFixture("batch-2", "雨后街道", []),
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("按第二镜找了夜景素材。");
    const row = document.querySelector('[data-message-id="msg-search"]')! as HTMLElement;
    const chip = within(row).getByRole("button", { name: /城市夜景/ });
    expect(chip).toHaveTextContent("素材批次 · 3 项");
    await userEvent.click(chip);
    // 详情按批次原始顺序展示，不按标题重排
    const items = await screen.findAllByRole("listitem");
    const titles = items.map(item => item.textContent ?? "");
    expect(titles.findIndex(value => value.includes("夜景天桥"))).toBeLessThan(titles.findIndex(value => value.includes("路灯人流")));
    expect(screen.getByText(/可采用尺寸 1920×1080/)).toBeInTheDocument();
    expect(screen.getByText(/来源图 2883×1754/)).toBeInTheDocument();
    expect(items.find(item => item.textContent?.includes("未知尺寸"))).not.toHaveTextContent("×");
    expect(screen.getAllByText(/作者甲/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "原素材" }).some(link => link.getAttribute("href")?.includes("pexels.com/video/c-2"))).toBe(true);
    expect(screen.getAllByRole("link", { name: "许可" }).some(link => link.getAttribute("href")?.includes("pexels.com/license"))).toBe(true);
    // 空批次保留并如实说明
    await userEvent.click(within(workPane()).getByText("雨后街道"));
    await screen.findByText("这次搜索没有结果，批次仍保留在这里。");
    expect(harness.calls.filter(call => call.url.endsWith("/material-batches/batch-1")).length).toBeGreaterThanOrEqual(1);
  });

  // —— R7：阅读位置、素材详情与意见草稿（审计 B01/B02/B03 + A10 剩余）——

  it("U01/B01 不先点击作品：B 的后台更新把排序换到第一，仍在看最初的 A，输入与意见不丢", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-01T00:00:00.000Z" });
    const harness = installStageRoutes({ works: [a, b], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)] });
    renderAt("/agent/conv-w");
    await waitFor(() => expect(screen.getByRole("region", { name: "创作：事项A" })).toBeInTheDocument());
    await screen.findByText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "聊天草稿还在");
    harness.snapshot.works[1] = workFixture({ id: "work-b", title: "事项B", revision: 2, updatedAt: "2026-01-04T00:00:00.000Z" });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "b-updated", kind: "work.changed", entityId: "work-b", entityVersion: 2 });
    // 页签顺序确实换成了 B 在前，但正在看的仍是 A。
    await waitFor(() => {
      const tabs = screen.getAllByRole("tab").filter(tab => /事项A|事项B/.test(tab.textContent ?? ""));
      expect(tabs[0]?.textContent ?? "").toContain("事项B");
    });
    expect(screen.getByRole("region", { name: "创作：事项A" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("A 的意见");
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("聊天草稿还在");
    expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(0);
  });

  it("U02 正在看 A 内容 v2；新稿 v3 到达、切 B 再回 A：仍看原修订，明确点击最新才跟随", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-01T00:00:00.000Z" });
    const harness = installStageRoutes({ works: [a, b], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)] });
    renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-2");
    harness.snapshot.works[0] = workFixture({ id: "work-a", title: "事项A", revision: 2,
      content: { draft: { ...draft, revisionId: "art-script-rev-3", digest: "sha256:art-script-rev-3" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "a-new-draft", kind: "work.changed", entityId: "work-a", entityVersion: 2 });
    await screen.findByText("有新稿待确认");
    expect(await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。")).toBeInTheDocument();
    expect(screen.getByText("art-script 正文 art-script-rev-2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /事项B/ }));
    await userEvent.click(screen.getByRole("tab", { name: /事项A/ }));
    expect(screen.getByText("art-script 正文 art-script-rev-2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await screen.findByText("art-script 正文 art-script-rev-3");
  });

  it("U02b 跨产物新稿（新制作输出是新产物）：仍读旧产物修订，不出现读取失败；明确点击才跟新产物", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const work = workFixture({ id: "work-1", title: "夜景短片", stage: "video", video: { draft: v1 } });
    const known: Record<string, string> = { "art-video-1/video-rev-1": "art-video-1 正文 video-rev-1", "art-video-2/video-rev-2": "art-video-2 正文 video-rev-2" };
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video"), artifactFixture("art-video-2", "夜景成片 v2", "video-rev-2", 1, "video")],
      // 真实服务端只认“产物＋修订”对：错误配对应 404，不用万能回放掩盖。
      onRequest: (url, call) => {
        const match = /\/api\/agent\/v1\/artifacts\/([^/]+)\/revisions\/([^/]+)$/.exec(url);
        if (call.method === "GET" && match) {
          const text = known[`${match[1]}/${match[2]}`];
          return text ? { status: 200, body: revisionFixture(match[1]!, match[2]!, Number(/(\d+)$/.exec(match[2]!)![1]), text) }
            : { status: 404, body: { code: "NOT_FOUND", message: "没有这份修订。" } };
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("art-video-1 正文 video-rev-1");
    // 新一版制作输出是另一个产物：正在看的 v1 不被抢走，也不把旧修订号配到新产物上。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "夜景短片", stage: "video", revision: 2,
      video: { draft: { kind: "artifact_revision", artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "v-new-output", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    expect(screen.getByText("art-video-1 正文 video-rev-1")).toBeInTheDocument();
    expect(screen.queryByText(/草稿读取失败|视频读取失败/)).not.toBeInTheDocument();
    expect(harness.calls.some(call => call.url.endsWith("/artifacts/art-video-2/revisions/video-rev-1"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await screen.findByText("art-video-2 正文 video-rev-2");
  });

  it("U05/B03 A/B 各自的稿旁意见跨刷新保留；未发送不产生服务端反馈记录", async () => {
    const draftA = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-2", digest: "sha256:a2" };
    const draftB = { kind: "artifact_revision" as const, artifactId: "art-b", revisionId: "art-b-rev-1", digest: "sha256:b1" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft: draftA } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-02T00:00:00.000Z", content: { draft: draftB } });
    const harness = installStageRoutes({ works: [a, b],
      artifacts: [artifactFixture("art-a", "A 内容", "art-a-rev-2", 2), artifactFixture("art-b", "B 内容", "art-b-rev-1", 1)] });
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见：结尾留两秒");
    await userEvent.click(screen.getByRole("tab", { name: /事项B/ }));
    await screen.findByText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "B 的意见：换配乐");
    // 刷新（卸载重挂载，localStorage 保留）：恢复到最后在看的 B，再回 A；各自文字与准确目标仍在。
    cleanup(); renderAt("/agent/conv-w");
    await screen.findByText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("B 的意见：换配乐");
    await userEvent.click(screen.getByRole("tab", { name: /事项A/ }));
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("A 的意见：结尾留两秒");
    expect(harness.calls.filter(call => call.url.endsWith("/feedback"))).toHaveLength(0);
  });

  it("U08/B03 成功只清对应意见；失败保留文本与原命令，重试沿用同一 commandId", async () => {
    const draftA = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-2", digest: "sha256:a2" };
    const draftB = { kind: "artifact_revision" as const, artifactId: "art-b", revisionId: "art-b-rev-1", digest: "sha256:b1" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft: draftA } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-02T00:00:00.000Z", content: { draft: draftB } });
    let failFirst = true;
    const harness = installStageRoutes({ works: [a, b],
      artifacts: [artifactFixture("art-a", "A 内容", "art-a-rev-2", 2), artifactFixture("art-b", "B 内容", "art-b-rev-1", 1)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/feedback")) {
          if (failFirst) { failFirst = false; return { status: 500, body: { code: "INTERNAL", message: "保存失败" } }; }
          return { status: 201, body: { disposition: "noted" } };
        }
        return null;
      } });
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await screen.findByRole("alert");
    // A 失败保留；期间 B 的意见成功：只清 B。
    await userEvent.click(screen.getByRole("tab", { name: /事项B/ }));
    await screen.findByText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "B 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue(""));
    await userEvent.click(screen.getByRole("tab", { name: /事项A/ }));
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "提意见" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("A 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue(""));
    const posts = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/feedback"));
    expect(posts).toHaveLength(3);
    expect((posts[0]!.body as { commandId: string }).commandId).toBe((posts[2]!.body as { commandId: string }).commandId);
  });

  it("U06/B03 阶段卡片不离开双区，明确选择旧稿后刷新保留原修订", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({ id: "work-1", title: "城市短片", content: { draft } });
    installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)] });
    renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await screen.findByText("art-script 正文 art-script-rev-1");
    await userEvent.click(within(screen.getByLabelText("当前会话产物")).getByRole("button", { name: "城市内容" }));
    await screen.findByText("art-script 正文 art-script-rev-2");
    expect(screen.queryByRole("button", { name: "回到创作" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await screen.findByText("art-script 正文 art-script-rev-1");
    expect(screen.getByRole("region", { name: "创作：城市短片" })).toBeInTheDocument();
    // 刷新：回到最后真实视图（阶段工作台 + 原修订），不重新弹出独立产物。
    cleanup(); renderAt("/agent/conv-w");
    await screen.findByText("art-script 正文 art-script-rev-1");
    expect(screen.queryByRole("heading", { name: "城市内容" })).toBeNull();
    expect(screen.getByText("正在看旧版本，不能在这里确认；请回到最新稿。")).toBeInTheDocument();
  });

  it("U04/B02 索引外历史批次点开仍按 ID 读取渲染；失败重试只读同批次", async () => {
    const work = workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } } });
    const searchMessage = messageFixture({ id: "msg-old-search", role: "assistant", text: "这是当时的素材。",
      references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: ["batch-old"] } });
    let fail = true;
    const harness = installStageRoutes({ works: [work], messages: [searchMessage],
      materialBatches: [batchIndexFixture("batch-new", "新搜索", "video", 1)],
      batchDetails: { "batch-old": batchFixture("batch-old", "当时的搜索", [candidateFixture("c-old", "旧素材甲", "video")]) },
      onRequest: url => url.endsWith("/material-batches/batch-old") && fail
        ? { status: 503, body: { code: "UNAVAILABLE", message: "暂不可读" } } : null });
    renderAt("/agent/conv-w");
    await screen.findByText("这是当时的素材。");
    const row = document.querySelector('[data-message-id="msg-old-search"]')! as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /素材/ }));
    await screen.findByText("读取失败");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("旧素材甲");
    const batchReads = harness.calls.filter(call => call.url.includes("/material-batches/"));
    expect(batchReads.map(call => call.url)).toEqual(["/api/agent/v1/material-batches/batch-old", "/api/agent/v1/material-batches/batch-old"]);
  });
});

describe("E1 片段阅读身份（AUD-01）", () => {
  it("阅读旧成片时新版到达：整片、片段条、制作记录仍为所看修订的那次制作；查看最新稿后一起切换", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" };
    const work = workFixture({ id: "work-1", title: "片段阅读", stage: "video", video: { draft: v1, runId: "run-1" } });
    const run1 = runFixture("run-1", "第一次制作", "art-video-1", "video-rev-1", [segmentFixture("seg-1", "旧版片段", "clip-1")]);
    const run2 = runFixture("run-2", "第二次制作", "art-video-2", "video-rev-2", [segmentFixture("seg-1", "新版片段", "clip-2")]);
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video"), artifactFixture("art-video-2", "夜景成片 v2", "video-rev-2", 1, "video")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/runs/run-1")) return { status: 200, body: run1 };
        if (call.method === "GET" && url.endsWith("/runs/run-2")) return { status: 200, body: run2 };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-1", "run-1", "whole-1") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-2/revisions/video-rev-2")) return { status: 200, body: videoRevisionFixture("art-video-2", "video-rev-2", "run-2", "whole-2") };
        return null;
      },
    });
    harness.snapshot.runs.items = [run1];
    renderAt("/agent/conv-w");
    // 回归等的是正确的那次制作的片段，不是“新版片段出现”。
    await screen.findByRole("button", { name: /旧版片段/ });
    expect(document.querySelector(".agent-stage-body video")?.getAttribute("src")).toContain("whole-1");
    expect(document.querySelector(".agent-segment-card video")?.getAttribute("src")).toContain("clip-1");
    // 第二版成片到达：整片与片段的阅读身份仍是 v1 修订绑定的 run-1。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "片段阅读", stage: "video", revision: 2, video: { draft: v2, runId: "run-2" } });
    harness.snapshot.runs.items = [run1, run2];
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "v2-done", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    expect(screen.queryByRole("button", { name: /新版片段/ })).not.toBeInTheDocument();
    expect(document.querySelector(".agent-stage-body video")?.getAttribute("src")).toContain("whole-1");
    expect(document.querySelector(".agent-segment-card video")?.getAttribute("src")).toContain("clip-1");
    // 制作记录打开的是所看 v1 对应的那次制作，不是最新 run。
    await userEvent.click(screen.getByRole("button", { name: "查看制作记录" }));
    await screen.findByRole("heading", { name: "制作记录" });
    expect(screen.getByText("第一次制作")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回到作品" }));
    await screen.findByRole("button", { name: /旧版片段/ });
    // 明确查看最新稿后，整片与片段一起切到 v2。
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await screen.findByRole("button", { name: /新版片段/ });
    expect(document.querySelector(".agent-stage-body video")?.getAttribute("src")).toContain("whole-2");
    expect(document.querySelector(".agent-segment-card video")?.getAttribute("src")).toContain("clip-2");
    expect(screen.queryByRole("button", { name: /旧版片段/ })).not.toBeInTheDocument();
  });

  it("所看 run 不在已加载列表：按 ID 补读合入且不跳页；失败一次停住，重试后仍回同一次制作", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    // 快照只带回最新 run-2；正在看的 v1 修订属于更早的 run-1，不在任何消息引用里。
    const work = workFixture({ id: "work-1", title: "片段补读", stage: "video", video: { draft: v1, runId: "run-2" } });
    const run1 = runFixture("run-1", "第一次制作", "art-video-1", "video-rev-1", [segmentFixture("seg-1", "旧版片段", "clip-1")]);
    const run2 = runFixture("run-2", "第二次制作", "art-video-2", "video-rev-2", [segmentFixture("seg-1", "最新片段", "clip-2")]);
    let runReadFails = true;
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video"), artifactFixture("art-video-2", "夜景成片 v2", "video-rev-2", 1, "video")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/runs/run-1")) {
          return runReadFails ? { status: 503, body: { code: "UNAVAILABLE", message: "暂不可读" } } : { status: 200, body: run1 };
        }
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-1", "run-1", "whole-1") };
        return null;
      },
    });
    harness.snapshot.runs.items = [run2];
    renderAt("/agent/conv-w");
    await screen.findByText("这份制作的片段读取失败，视频本身不受影响。");
    // 失败后不自动循环重试，也不拿别次运行的片段顶替，页面仍在作品工作台。
    expect(screen.queryByRole("button", { name: /最新片段|旧版片段/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "创作：片段补读" })).toBeInTheDocument();
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "nudge", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await waitFor(() => expect(harness.calls.filter(call => call.url.endsWith("/works/work-1"))).toHaveLength(1));
    expect(harness.calls.filter(call => call.url.endsWith("/runs/run-1"))).toHaveLength(1);
    runReadFails = false;
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: /旧版片段/ });
    expect(document.querySelector(".agent-stage-body video")?.getAttribute("src")).toContain("whole-1");
    expect(screen.queryByRole("button", { name: /最新片段/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "制作记录" })).not.toBeInTheDocument();
  });

  it("初次制作尚无成片：仍看在途制作的片段；已生成段可预览，未完成段如实占位", async () => {
    const work = workFixture({ id: "work-1", title: "初次制作", stage: "video", video: { draft: null, runId: "run-live" } });
    const live = runFixture("run-live", "在途制作", "art-video-1", "video-rev-1", [
      segmentFixture("seg-1", "第一段", "clip-live-1"),
      segmentFixture("seg-2", "第二段", null, "running"),
    ], "running");
    const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video")] });
    harness.snapshot.runs.items = [live];
    renderAt("/agent/conv-w");
    await screen.findByText("还没有视频初稿。");
    await screen.findByRole("button", { name: /第一段/ });
    expect(document.querySelectorAll(".agent-segment-card video")).toHaveLength(1);
    expect(document.querySelector(".agent-segment-card video")?.getAttribute("src")).toContain("clip-live-1");
    const secondCard = document.querySelectorAll(".agent-segment-card")[1]!;
    expect(secondCard.querySelector(".agent-segment-placeholder")?.textContent).toBe("制作中");
    expect(screen.queryByText("正在读取这份制作的片段…")).not.toBeInTheDocument();
  });

  it("旧画面上的片段意见仍可记录：主目标是当前方案草稿，片段指旧 run；整稿意见维持只读", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" };
    const plan = { kind: "artifact_revision" as const, artifactId: "art-plan", revisionId: "plan-rev-2", digest: "sha256:p2" };
    const work = workFixture({ id: "work-1", title: "片段意见", stage: "video", plan: { draft: plan }, video: { draft: v1, runId: "run-1" } });
    const run1 = runFixture("run-1", "第一次制作", "art-video-1", "video-rev-1", [segmentFixture("seg-1", "旧版片段", "clip-1")]);
    const run2 = runFixture("run-2", "第二次制作", "art-video-2", "video-rev-2", [segmentFixture("seg-1", "新版片段", "clip-2")]);
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video"), artifactFixture("art-video-2", "夜景成片 v2", "video-rev-2", 1, "video"), artifactFixture("art-plan", "画面方案", "plan-rev-2", 2, "script")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/runs/run-1")) return { status: 200, body: run1 };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-1", "run-1", "whole-1") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-2/revisions/video-rev-2")) return { status: 200, body: videoRevisionFixture("art-video-2", "video-rev-2", "run-2", "whole-2") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-plan/revisions/plan-rev-2")) return { status: 200, body: planRevisionFixture("art-plan", "plan-rev-2", ["seg-1"]) };
        if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { disposition: "noted" } };
        return null;
      },
    });
    harness.snapshot.runs.items = [run1];
    renderAt("/agent/conv-w");
    await screen.findByRole("button", { name: /旧版片段/ });
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "片段意见", stage: "video", revision: 2, plan: { draft: plan }, video: { draft: v2, runId: "run-2" } });
    harness.snapshot.runs.items = [run1, run2];
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "v2-done", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    // 在旧画面上点片段提意见：意见框可用，不因 viewingOld 整体只读。
    await userEvent.click(screen.getByRole("button", { name: /旧版片段/ }));
    const box = screen.getByRole("textbox", { name: "意见" });
    expect(box).not.toHaveAttribute("readonly");
    await userEvent.type(box, "第二段节奏太慢");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    const posted = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/feedback"))!.body as { target: unknown };
    // 主目标是当前方案草稿，不是旧视频修订；片段指正在看的那次运行。
    expect(posted.target).toEqual({ workId: "work-1", artifactId: "art-plan", revisionId: "plan-rev-2", segment: { runId: "run-1", segmentId: "seg-1" } });
    // 取消针对后：整稿意见在旧稿上维持只读，不给旧稿确认入口。
    await userEvent.click(screen.getByRole("button", { name: "取消针对该片段" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "记录意见" })).toBeDisabled();
    expect(screen.getByText("这是旧稿的未发送意见，可以复制后继续讨论。")).toBeInTheDocument();
  });

  it("方案草稿前进时，未发送的片段意见文字带到新方案；提交主目标为新方案、片段为原 run", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const work = workFixture({ id: "work-1", title: "意见跟随", stage: "video",
      plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "plan-rev-2", digest: "sha256:p2" } },
      video: { draft: v1, runId: "run-1" } });
    const run1 = runFixture("run-1", "第一次制作", "art-video-1", "video-rev-1", [segmentFixture("seg-1", "旧版片段", "clip-1")]);
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片 v1", "video-rev-1", 1, "video"), artifactFixture("art-plan", "画面方案", "plan-rev-2", 2, "script")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-1", "run-1", "whole-1") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-plan/revisions/plan-rev-2")) return { status: 200, body: planRevisionFixture("art-plan", "plan-rev-2", ["seg-1"]) };
        if (call.method === "GET" && url.endsWith("/artifacts/art-plan/revisions/plan-rev-3")) return { status: 200, body: planRevisionFixture("art-plan", "plan-rev-3", ["seg-1"]) };
        if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { disposition: "next_version" } };
        return null;
      },
    });
    harness.snapshot.runs.items = [run1];
    renderAt("/agent/conv-w");
    await screen.findByRole("button", { name: /旧版片段/ });
    await userEvent.click(screen.getByRole("button", { name: /旧版片段/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "换一个更亮的结尾镜头");
    // 方案草稿前进：未发送文字保留到新方案键，不留在旧键里丢失。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "意见跟随", stage: "video", revision: 2,
      plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "plan-rev-3", digest: "sha256:p3" } },
      video: { draft: v1, runId: "run-1" } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "plan-new", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("换一个更亮的结尾镜头"));
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    const posted = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/feedback"))!.body as { target: unknown };
    expect(posted.target).toEqual({ workId: "work-1", artifactId: "art-plan", revisionId: "plan-rev-3", segment: { runId: "run-1", segmentId: "seg-1" } });
  });
});

describe("R2 制作范围与 Markdown", () => {
  it("分镜表逐段流入时，未完成的管道行先按正文显示而不阻塞", () => {
    const ui = render(<MarkdownText text="|" />);
    expect(screen.getByText("|")).toBeInTheDocument();
    for (const text of ["| 镜头 | 时长 |", "| 镜头 | 时长 |\n| -", "前言\n| 镜头 | 时长 |\n| --- | --- |\n| 1 | 3s |"] ) {
      ui.rerender(<MarkdownText text={text} />);
      expect(ui.container.textContent).toContain("镜头");
    }
    expect(ui.container.querySelectorAll("td")).toHaveLength(2);
    expect(screen.getByText("前言")).toBeInTheDocument();
  });
  it("timed 分支按 segments 表达镜头区间与静帧时长，旁白单独标注", () => {
    render(<ProposalCard proposal={{
      id: "proposal-timed", conversationId: "conv-w", digest: "b".repeat(64), revision: 1, state: "ready", acceptedRunId: null,
      expiresAt: "2099-01-01T00:00:00Z", priceDisclosure: "模拟媒体 12 元",
      spec: {
        workId: "work-1", title: "定时成片", inputRevisions: [],
        operations: [
          { operationId: "seg-a", outputSlot: "video", inputs: [{ kind: "artifact_revision", artifactId: "art-1", revisionId: "rev-1", digest: "a".repeat(64) }], kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded" },
          { operationId: "join", outputSlot: "final",
            inputs: [{ kind: "operation_output", producerOperationId: "seg-a", outputSlot: "video" }, { kind: "artifact_revision", artifactId: "art-still", revisionId: "rev-1", digest: "a".repeat(64) }, { kind: "text", text: "夜色慢慢压下来。" }],
            kind: "render", model: null, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
            parameters: { format: "mp4", width: 1280, height: 720, fps: 24, assembly: "timed_narrated_concat", segments: [{ kind: "video", inputSlot: 0, startMs: 1000, durationMs: 2500 }, { kind: "image", inputSlot: 1, durationMs: 3000 }], narrationInputSlot: 2 } },
        ],
        finalOutput: { operationId: "join", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 },
      },
    }} artifacts={[artifactFixture("art-1", "夜景片段", "rev-1", 1), artifactFixture("art-still", "静帧图", "rev-1", 1, "image")]} />);
    const order = screen.getByText(/镜头顺序/);
    expect(order).toHaveTextContent("视频 1.0s 起 2.5s（重做 · 本次视频产出）");
    expect(order).toHaveTextContent("静帧 3.0s（保留 · 静帧图 · v1）");
    expect(order).toHaveTextContent("旁白：夜色慢慢压下来。");
    expect(screen.getByText("1280×720 · 24 fps · MP4 · 旁白定时成片 · 旁白替换原声")).toBeInTheDocument();
    // 静帧图是视觉槽上的已有画面修订：timed 按 segments 出现读取，算保留段。
    expect(screen.getByText("保留 1 段 · 重做 1 段")).toBeInTheDocument();
  });

  it("Markdown 表格按行列渲染；图片只放行 http(s) 直链", () => {
    const { container } = render(<MarkdownText text={[
      "| 镜头 | 时长 | 说明 |",
      "| --- | --- | --- |",
      "| 1 | 2.5s | 夜景天桥 |",
      "| 2 | 3s | 路灯人流 |",
      "",
      "![安全图](https://img.example.com/a.png)",
      "",
      "![危险图](data:text/html;base64,xx)",
    ].join("\n")} />);
    const table = container.querySelector("table")!;
    expect(Array.from(table.querySelectorAll("th"), cell => cell.textContent)).toEqual(["镜头", "时长", "说明"]);
    expect(Array.from(table.querySelectorAll("td"), cell => cell.textContent)).toEqual(["1", "2.5s", "夜景天桥", "2", "3s", "路灯人流"]);
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "https://img.example.com/a.png");
    expect(image).toHaveAttribute("alt", "安全图");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByText("危险图")).toBeInTheDocument();
  });
});

describe("E3 复用画面判定（AUD-03）", () => {
  function proposalWith(spec: Proposal["spec"], artifacts: ArtifactHead[] = []) {
    return <ProposalCard proposal={{
      id: "proposal-e3", conversationId: "conv-w", digest: "c".repeat(64), revision: 1, state: "ready", acceptedRunId: null,
      expiresAt: "2099-01-01T00:00:00Z", priceDisclosure: "模拟媒体", spec,
    }} artifacts={artifacts} />;
  }
  // 只重做第 2 段：final render 视觉槽依次为 保留输入 / 重做的视频产出 / 保留输入。
  function orderedSpec(keptFirst: InputRef, keptLast: InputRef): Proposal["spec"] {
    return {
      workId: "work-1", title: "只重做第 2 段", inputRevisions: [],
      operations: [
        { operationId: "seg-b", outputSlot: "video", inputs: [{ kind: "text", text: "雨夜路口的第二版镜头" }], kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 120 }, priceKind: "bounded" },
        { operationId: "join", outputSlot: "final",
          inputs: [keptFirst, { kind: "operation_output", producerOperationId: "seg-b", outputSlot: "video" }, keptLast],
          kind: "render", model: null, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
          parameters: { format: "mp4", width: 1280, height: 720, fps: 24, assembly: "ordered_concat", audioMode: "none" } },
      ],
      finalOutput: { operationId: "join", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 120 },
    };
  }

  it.each([
    ["blob", { kind: "blob" as const, blobId: "clip-a", digest: "a".repeat(64) }, { kind: "blob" as const, blobId: "clip-c", digest: "c".repeat(64) }, [] as ArtifactHead[], "保留 · 已有素材 1 → 重做 · 本次视频产出 → 保留 · 已有素材 2"],
    ["媒体修订", { kind: "artifact_revision" as const, artifactId: "art-clip-a", revisionId: "clip-rev-1", digest: "a".repeat(64) }, { kind: "artifact_revision" as const, artifactId: "art-clip-c", revisionId: "clip-rev-1", digest: "c".repeat(64) },
      [artifactFixture("art-clip-a", "夜景片段", "clip-rev-1", 2, "video"), artifactFixture("art-clip-c", "路灯人流", "clip-rev-1", 3, "video")], "保留 · 夜景片段 · v2 → 重做 · 本次视频产出 → 保留 · 路灯人流 · v3"],
  ])("final 视觉槽上是 %s 时：摘要“保留 2 段 · 重做 1 段”，标签逐段如实", (_name, keptFirst, keptLast, artifacts, orderText) => {
    render(proposalWith(orderedSpec(keptFirst, keptLast), artifacts));
    expect(screen.getByText("保留 2 段 · 重做 1 段")).toBeInTheDocument();
    expect(screen.getByText(/最终产出：视频成片 · 重新合成/)).toBeInTheDocument();
    expect(screen.getByText(content => content.includes(orderText))).toBeInTheDocument();
  });

  it("同一 blob 两次引用仍是两个时间线片段，不去重", () => {
    const sameBlob = { kind: "blob" as const, blobId: "clip-a", digest: "a".repeat(64) };
    render(proposalWith({
      workId: "work-1", title: "同素材重复使用", inputRevisions: [],
      operations: [
        { operationId: "join", outputSlot: "final",
          inputs: [sameBlob, { ...sameBlob }],
          kind: "render", model: null, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
          parameters: { format: "mp4", width: 1280, height: 720, fps: 24, assembly: "ordered_concat", audioMode: "none" } },
      ],
      finalOutput: { operationId: "join", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 },
    }));
    expect(screen.getByText("保留 2 段 · 重做 0 段")).toBeInTheDocument();
    expect(screen.getByText(/保留 · 已有素材 1 → 保留 · 已有素材 1/)).toBeInTheDocument();
  });

  it("视频生成操作引用脚本文稿不算复用画面：无摘要行、无“重新合成”", () => {
    render(proposalWith({
      workId: "work-1", title: "全新三段", inputRevisions: [],
      operations: [
        { operationId: "seg-a", outputSlot: "video", inputs: [{ kind: "artifact_revision", artifactId: "art-script", revisionId: "script-rev-1", digest: "s".repeat(64) }], kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 120 }, priceKind: "bounded" },
        { operationId: "join", outputSlot: "final",
          inputs: [{ kind: "operation_output", producerOperationId: "seg-a", outputSlot: "video" }],
          kind: "render", model: null, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
          parameters: { format: "mp4", width: 1280, height: 720, fps: 24, assembly: "ordered_concat", audioMode: "none" } },
      ],
      finalOutput: { operationId: "join", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 120 },
    }, [artifactFixture("art-script", "三段脚本", "script-rev-1", 1)]));
    expect(screen.getByText(/最终产出：视频成片/)).not.toHaveTextContent("重新合成");
    expect(screen.queryByText(/保留 \d+ 段/)).toBeNull();
    expect(screen.queryByText(/重新合成/)).toBeNull();
    expect(screen.getByText(/拼接顺序：本次视频产出/)).toBeInTheDocument();
  });

  it("画面全部重做但保留旁白时，仍单列复用旁白", () => {
    const generated = { kind: "operation_output" as const, producerOperationId: "seg-b", outputSlot: "video" };
    const spec = orderedSpec(generated, generated);
    spec.operations = [spec.operations[0]!, {
      ...spec.operations[1]!, kind: "render", model: null,
      maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
      inputs: [generated, { kind: "blob", blobId: "prior-narration", digest: "d".repeat(64) }],
      parameters: { format: "mp4", width: 1280, height: 720, fps: 24,
        assembly: "narrated_concat", videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" },
    }];
    render(proposalWith(spec));
    expect(screen.getByText("保留 0 段 · 重做 1 段 · 复用旁白")).toBeInTheDocument();
  });

  it("narrated 按 videoInputSlots 读视觉槽：旁白槽的配音产出不算画面段，计为重做旁白", () => {
    render(proposalWith({
      workId: "work-1", title: "旁白成片", inputRevisions: [],
      operations: [
        { operationId: "narration", outputSlot: "audio", inputs: [{ kind: "text", text: "新的旁白" }], kind: "speech", model: BOOTSTRAP.models[0]!.binding, parameters: { voiceId: "zh-anchor", format: "mp3" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 20 }, priceKind: "bounded" },
        { operationId: "seg-b", outputSlot: "video", inputs: [{ kind: "text", text: "第二段重做" }], kind: "video", model: BOOTSTRAP.models[0]!.binding, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 120 }, priceKind: "bounded" },
        { operationId: "join", outputSlot: "final",
          inputs: [{ kind: "operation_output", producerOperationId: "narration", outputSlot: "audio" }, { kind: "blob", blobId: "clip-a", digest: "a".repeat(64) }, { kind: "operation_output", producerOperationId: "seg-b", outputSlot: "video" }],
          kind: "render", model: null, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
          parameters: { format: "mp4", width: 1280, height: 720, fps: 24, assembly: "narrated_concat", videoInputSlots: [1, 2], narrationInputSlot: 0, durationPolicy: "preserve_all" } },
      ],
      finalOutput: { operationId: "join", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 140 },
    }));
    expect(screen.getByText("保留 1 段 · 重做 1 段 · 重做旁白")).toBeInTheDocument();
    expect(screen.getByText(/画面顺序：保留 · 已有素材 1 → 重做 · 本次视频产出/)).toBeInTheDocument();
  });
});

it("mixed 制作区分复用画面/配音与新配音费用，提案和运行只读声音摘要", async () => {
  const renderOperation: Extract<Proposal["spec"]["operations"][number], { kind: "render" }> = {
    operationId: "mixed-final", outputSlot: "video", kind: "render", model: null,
    inputs: [
      { kind: "blob", blobId: "music-blob", digest: "m".repeat(64) },
      { kind: "blob", blobId: "visual-blob", digest: "v".repeat(64) },
      { kind: "blob", blobId: "image-blob", digest: "i".repeat(64) },
      { kind: "blob", blobId: "speech-blob", digest: "s".repeat(64) },
    ],
    maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded",
    parameters: { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
      segments: [{ kind: "video", inputSlot: 1, startMs: 0, durationMs: 3000, originalGain: 0.5 },
        { kind: "image", inputSlot: 2, durationMs: 3000 }, { kind: "video", inputSlot: 1, startMs: 3000, durationMs: 3000, originalGain: 0.4 }],
      segmentIds: ["scene-a", "scene-b", "scene-c"],
      music: { inputSlot: 0, candidateId: "frozen-candidate", sourceStartMs: 10000, sourceDurationMs: 20000, timelineStartMs: 0, playDurationMs: 9000,
        repeat: false, gain: 0.2, fadeInMs: 500, fadeOutMs: 1000, duckUnderNarration: true },
      narration: { inputSlot: 3, timelineStartMs: 1000, gain: 1 } },
  };
  const proposal: Proposal = { ...proposalFixture("mixed-proposal", "只换音乐", null), audioSummary: MUSIC_SOUND_SUMMARY,
    spec: { workId: null, title: "只换音乐", inputRevisions: [], operations: [renderOperation], finalOutput: { operationId: "mixed-final", outputSlot: "video" }, maxSpend: { currency: "CNY", amountMinor: 0 } } };
  const ui = render(<ProposalCard proposal={proposal} onAccept={vi.fn()} />);
  expect(screen.getByText("保留 3 段 · 重做 0 段 · 复用配音 · 本地重合成")).toBeInTheDocument();
  expect(screen.getByText(/本地合成 ¥0.00 仅指该操作无媒体供应商费用/)).toBeInTheDocument();
  expect(screen.queryByText(/旁白替换原声/)).toBeNull();
  const summary = screen.getByRole("region", { name: "声音方案" });
  await userEvent.click(within(summary).getByText("片段原声 · 保留 2 段 · 静音 1 段"));
  expect(within(summary).getByText("已知来源台词（其余原声未知）：可追溯的原声 L1。")).toBeVisible();
  expect(within(summary).getByText("来源台词（仅采用其中片段）：源片段 L1 的完整台词。")).toBeVisible();
  expect(within(summary).queryByText("静音片段的来源文字")).toBeNull();
  expect(within(summary).getByText("配音原文：独立配音 L2。")).toBeVisible();
  expect(within(summary).getByText("MiniMax · speech-2.8-turbo · 温润男声")).toBeVisible();
  expect(within(summary).getByText(/选用原曲 10–30 秒；成片 0–9 秒 · 不循环/)).toBeVisible();
  expect(within(summary).getByText(/配音时降低音乐/)).toBeVisible();
  expect(within(summary).getByRole("textbox", { name: "发布署名" })).toHaveValue(MUSIC_SOUND_SUMMARY.music!.source.attributionText);
  expect(summary).not.toHaveTextContent("frozen-candidate");
  expect(screen.getAllByRole("button", { name: "确认制作" })).toHaveLength(1);

  const newProposal: Proposal = { ...proposal, spec: { ...proposal.spec, maxSpend: { currency: "CNY", amountMinor: 50 }, operations: [
    { operationId: "new-speech", outputSlot: "audio", kind: "speech", model: BOOTSTRAP.models[0]!.binding, inputs: [{ kind: "text", text: "独立配音 L2。" }],
      parameters: { voiceId: "voice-1", format: "mp3" }, maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 50 }, priceKind: "estimate" },
    { ...renderOperation, inputs: [renderOperation.inputs[0]!, renderOperation.inputs[1]!, renderOperation.inputs[2]!, { kind: "operation_output", producerOperationId: "new-speech", outputSlot: "audio" }] },
  ] } };
  ui.rerender(<ProposalCard proposal={newProposal} onAccept={vi.fn()} />);
  expect(screen.getByText("保留 3 段 · 重做 0 段 · 新配音 · 本地重合成")).toBeInTheDocument();
  expect(screen.getByText(/本次新配音 ¥0.50；本地合成 ¥0.00/)).toBeInTheDocument();

  const run = { ...runFixture("mixed-run", "只换音乐", "video", "video-rev-1", []), proposalId: proposal.id, audioSummary: MUSIC_SOUND_SUMMARY };
  ui.rerender(<RunCard run={run} proposals={[proposal]} simulated={false} onCancel={vi.fn()} onOpen={vi.fn()} />);
  const actual = screen.getByRole("region", { name: "本次制作的声音" });
  expect(within(actual).getByText("雨停主题曲")).toBeVisible();
  expect(within(actual).getByText("配音原文：独立配音 L2。")).toBeVisible();
});

describe("独立验收反例", () => {
  it("查看 B 时采用 A 的旧音乐候选，消息仍指向 A", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "script-a", revisionId: "script-a-1", digest: "sha256:a1" };
    const batch: MaterialBatch = { ...batchFixture("a-music", "piano", []), workId: "work-a",
      query: { kind: "audio", provider: "incompetech", query: "piano", limit: 1 },
      results: [{ ...candidateFixture("music-a", "钢琴曲", "image"), provider: "incompetech", kind: "audio", width: null, height: null }] };
    const { calls } = installStageRoutes({ works: [workFixture({ id: "work-b", title: "作品 B" }), workFixture({ id: "work-a", title: "作品 A", content: { draft } })],
      messages: [messageFixture({ id: "msg-a", role: "assistant", text: "A 的配乐", references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [batch.batchId] } })],
      batchDetails: { [batch.batchId]: batch } });
    renderAt("/agent/conv-w");
    const row = (await screen.findByText("A 的配乐")).closest("[data-message-id]") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /素材/ }));
    await userEvent.click(await screen.findByRole("button", { name: "采用「钢琴曲」" }));
    const sent = calls.find(item => item.method === "POST" && item.url.endsWith("/messages"))?.body as MessageInput;
    expect(sent.target).toEqual({ workId: "work-a", artifactId: draft.artifactId, revisionId: draft.revisionId });
    expect(sent.text).toContain("/works/work-a");
    expect(sent.text).not.toContain("用途不明");
  });

  it("Q1 连续打开两个独立素材批次应显示第二批候选", async () => {
    const refs=(id:string)=>({artifacts:[],proposalIds:[],runIds:[],materialBatchIds:[id]});
    const harness=installStageRoutes({
      messages:[messageFixture({id:"msg-a",role:"assistant",text:"第一批",references:refs("batch-a")}),
        messageFixture({id:"msg-b",role:"assistant",text:"第二批",createdSequence:2,references:refs("batch-b")})],
      materialBatches:[batchIndexFixture("batch-a","森林素材","video",1),batchIndexFixture("batch-b","海洋素材","video",1)],
      batchDetails:{"batch-a":batchFixture("batch-a","森林素材",[candidateFixture("candidate-a","森林候选甲","video")]),
        "batch-b":batchFixture("batch-b","海洋素材",[candidateFixture("candidate-b","海洋候选乙","video")])},
    });
    renderAt("/agent/conv-w");
    await screen.findByText("第一批");
    await userEvent.click(within(document.querySelector('[data-message-id="msg-a"]')! as HTMLElement).getByRole("button",{name:/素材/}));
    await screen.findByText("森林候选甲");
    await userEvent.click(within(document.querySelector('[data-message-id="msg-b"]')! as HTMLElement).getByRole("button",{name:/素材/}));
    expect(within(screen.getByTestId("standalone-batch")).getByText("海洋素材")).toBeInTheDocument();
    await waitFor(()=>expect(screen.queryByText("海洋候选乙")).toBeInTheDocument());
    expect(screen.queryByText("森林候选甲")).toBeNull();
    expect(harness.calls.filter(c=>c.url.endsWith("/material-batches/batch-b"))).toHaveLength(1);
  });

  it("Q2 意见保存期间同一输入框的新文字不能被成功回执清空", async () => {
    const draft={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    let complete!: (result:RouteResult)=>void;
    const deferred=new Promise<RouteResult>(resolve=>{complete=resolve;});
    installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",content:{draft}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2)],
      onRequest:(url,call)=>call.method==="POST"&&url.endsWith("/feedback")?deferred:null});
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button",{name:"提意见"}));
    const textbox=screen.getByRole("textbox",{name:"意见"});
    await userEvent.type(textbox,"已发送的意见");
    await userEvent.click(screen.getByRole("button",{name:"记录意见"}));
    await screen.findByRole("button",{name:"正在保存…"});
    await userEvent.clear(textbox);
    await userEvent.type(textbox,"保存期间补充的新意见");
    await act(async()=>{complete({status:201,body:{disposition:"noted"}});});
    await screen.findByText("意见已记录。");
    expect(textbox).toHaveValue("保存期间补充的新意见");
  });

  it("Q3 点B的阶段产物后刷新，仍在B的双区", async () => {
    const draftA={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    const draftB={kind:"artifact_revision" as const,artifactId:"art-b",revisionId:"art-b-rev-2",digest:"sha256:b2"};
    installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",updatedAt:"2026-01-03T00:00:00.000Z",content:{draft:draftA}}),
      workFixture({id:"work-b",title:"事项B",updatedAt:"2026-01-01T00:00:00.000Z",content:{draft:draftB}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2),artifactFixture("art-b","B 内容","art-b-rev-2",2)]});
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("tab",{name:/事项B/}));
    await screen.findByText("art-b 正文 art-b-rev-2");
    await userEvent.click(within(screen.getByLabelText("当前会话产物")).getByRole("button",{name:"B 内容"}));
    await screen.findByText("art-b 正文 art-b-rev-2");
    cleanup();renderAt("/agent/conv-w");
    await screen.findByText("art-b 正文 art-b-rev-2");
    expect(screen.queryByRole("button",{name:"回到创作"})).toBeNull();
    expect(screen.getByRole("region",{name:"创作：事项B"})).toBeInTheDocument();
  });

  it("Q4 旧稿的未发送意见刷新后仍能看见并复制", async () => {
    const draft={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    const harness=installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",content:{draft}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2)]});
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button",{name:"提意见"}));
    await userEvent.type(screen.getByRole("textbox",{name:"意见"}),"未发送的旧稿意见");
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"事项A",revision:2,content:{draft:{...draft,revisionId:"art-a-rev-3",digest:"sha256:a3"}}});
    FakeEventSource.instances.find(x=>!x.closed)!.emit("business",{eventId:"new-head",kind:"work.changed",entityId:"work-a",entityVersion:2});
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    cleanup();renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    const box=screen.queryByRole("textbox",{name:"意见"});
    if(!box){
      const trigger=screen.getByRole("button",{name:"提意见"});
      expect(trigger).toBeEnabled();
      await userEvent.click(trigger);
    }
    expect(screen.getByRole("textbox",{name:"意见"})).toHaveValue("未发送的旧稿意见");
  });

  it("Q5 读稿后离开期间出新稿，恢复仍应读原准确修订", async () => {
    const draft={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    const harness=installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",content:{draft}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2)]});
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-2");
    cleanup();
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"事项A",revision:2,content:{draft:{...draft,revisionId:"art-a-rev-3",digest:"sha256:a3"}}});
    renderAt("/agent/conv-w");
    await waitFor(()=>expect(screen.queryByText("art-a 正文 art-a-rev-2")).toBeInTheDocument());
  });
});


describe("草稿成为成果", () => {
  it("未确认的脚本只在草稿区；确认后的准确版本进入成果区，新草稿不替换成果", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-1", digest: "sha256:a1" };
    const harness = installStageRoutes({works:[workFixture({id:"work-a",title:"城市短片",content:{draft:v1}})],
      artifacts:[artifactFixture("art-a","脚本",v1.revisionId,1)]});
    renderAt("/agent/conv-w");
    await screen.findByText("art-a 正文 art-a-rev-1");
    expect(within(screen.getByRole("region",{name:"已确认成果"})).queryByText("art-a 正文 art-a-rev-1")).toBeNull();
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"城市短片",revision:2,content:{draft:v1,approved:v1,confirmationAction:"approve_content"}});
    FakeEventSource.instances.find(x=>!x.closed)!.emit("business",{eventId:"approve",kind:"work.changed",entityId:"work-a",entityVersion:2});
    await waitFor(()=>expect(within(screen.getByRole("region",{name:"已确认成果"})).getByText("art-a 正文 art-a-rev-1")).toBeInTheDocument());
    const v2={...v1,revisionId:"art-a-rev-2",digest:"sha256:a2"};
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"城市短片",revision:3,content:{draft:v2,approved:v1,confirmationAction:"approve_content"}});
    FakeEventSource.instances.find(x=>!x.closed)!.emit("business",{eventId:"revise",kind:"work.changed",entityId:"work-a",entityVersion:3});
    await screen.findByRole("button",{name:"查看最新稿"});
    await userEvent.click(screen.getByRole("button",{name:"查看最新稿"}));
    expect(await within(screen.getByRole("region",{name:"草稿与修改"})).findByText("art-a 正文 art-a-rev-2")).toBeInTheDocument();
    expect(within(screen.getByRole("region",{name:"已确认成果"})).getByText("art-a 正文 art-a-rev-1")).toBeInTheDocument();
    expect(harness.calls.filter(c=>c.method==="POST")).toHaveLength(0);
  });
});


it("未定稿的视频可在草稿区播放，成果区不冒充成品", async () => {
  const video = { kind: "artifact_revision" as const, artifactId:"art-video",revisionId:"video-rev-1",digest:"v1" };
  installStageRoutes({works:[workFixture({id:"work-video",title:"徒步",stage:"video",video:{draft:video}})],
    onRequest:url=>url.endsWith("/revisions/video-rev-1") ? {status:200,body:{...revisionFixture("art-video","video-rev-1",1,""),content:{format:"media",blobId:"file-video",mimeType:"video/mp4",durationMs:3000,width:1280,height:720,sources:[]}}} : null});
  renderAt("/agent/conv-w");
  await waitFor(()=>expect(within(screen.getByRole("region",{name:"草稿与修改"})).getByLabelText("视频预览")).toBeInTheDocument());
  expect(within(screen.getByRole("region",{name:"已确认成果"})).queryByLabelText("视频预览")).toBeNull();
});

it("F2 作品库显示服务端提供的冻结旁白，历史方案不替代它并返回各自原消息", async () => {
  const lines = ["雨停之前，先喝一杯咖啡。", "窗外下雨，杯里回暖。"];
  const entries: LibraryVideo[] = ["初版", "换词版"].map((label, index) => ({
    video: { artifactId: `video-${index}`, revisionId: `video-rev-${index}` }, workId: "work-1", conversationId: "conv-w",
    title: `雨窗${label}`, finalizedAt: "2026-01-01T00:00:00.000Z", plan: { artifactId: "plan", revisionId: "plan-rev-2" },
    content: null, originMessageId: `origin-${index}`, narrationText: lines[index]!,
  }));
  const harness = installStageRoutes({ onRequest: url => {
    if (url.endsWith("/library/videos")) return { status: 200, body: { items: entries, nextCursor: null } };
    const index = entries.findIndex(entry => url.endsWith(`/revisions/${entry.video.revisionId}`));
    if (index >= 0) {
      const entry = entries[index]!;
      return { status: 200, body: videoRevisionFixture(entry.video.artifactId, entry.video.revisionId, `run-${index}`, `output-${index}`) };
    }
    if (url.endsWith("/revisions/plan-rev-2")) return { status: 200, body: revisionFixture("plan", "plan-rev-2", 2, `旧方案记录：${lines[0]}`) };
    if (url.includes("messages?anchorMessageId=")) return { status: 200, body: {
      items: [messageFixture({ id: url.endsWith("origin-1") ? "origin-1" : "origin-0", role: "assistant", text: url.endsWith("origin-1") ? "换词版原始成片消息" : "初版原始成片消息" })], nextCursor: null, watermark: "wm-anchor",
    } };
    return null;
  } });
  renderAt("/agent/conv-w?page=library");
  for (const index of [1, 0]) {
    if (index === 0) await userEvent.click(screen.getByRole("button", { name: "作品库" }));
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(entries[index]!.title) }));
    await screen.findByLabelText("定稿视频");
    await userEvent.click(screen.getByText("采用的画面与声音方案"));
    const actual = (await screen.findByText("本次制作旁白")).parentElement!;
    expect(within(actual).getByText(lines[index]!)).toBeInTheDocument();
    expect(within(actual).queryByText(lines[1 - index]!)).toBeNull();
    expect(screen.getByText(`旧方案记录：${lines[0]}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回到对话" }));
    expect(await screen.findByText(index === 1 ? "换词版原始成片消息" : "初版原始成片消息")).toBeInTheDocument();
    expect(harness.calls.some(call => call.url.endsWith(`messages?anchorMessageId=origin-${index}`))).toBe(true);
  }
  expect(harness.calls.filter(call => /\/(runs|proposals)\//.test(call.url))).toHaveLength(0);
});

it("作品库声音与署名绑定定稿 revision，沿冻结方案与原消息读取", async () => {
  const entry: LibraryVideo = {
    video: { artifactId: "final-video", revisionId: "video-frozen-r1" }, workId: "work-1", conversationId: "conv-w",
    title: "混音定稿", finalizedAt: "2026-01-01T00:00:00Z", plan: { artifactId: "plan", revisionId: "plan-frozen-r2" },
    content: { kind: "message_text", messageId: "approved-script", author: "assistant", text: "这版采用的脚本。" },
    originMessageId: "frozen-origin", narrationText: MUSIC_SOUND_SUMMARY.narration!.text, audioSummary: MUSIC_SOUND_SUMMARY,
  };
  const harness = installStageRoutes({ onRequest: url => {
    if (url.endsWith("/library/videos")) return { status: 200, body: { items: [entry], nextCursor: null } };
    if (url.endsWith("/revisions/video-frozen-r1")) return { status: 200, body: videoRevisionFixture("final-video", "video-frozen-r1", "frozen-run", "frozen-output") };
    if (url.endsWith("/revisions/plan-frozen-r2")) return { status: 200, body: revisionFixture("plan", "plan-frozen-r2", 2, "这份方案冻结采用旧画面，音乐以本次制作记录为准。") };
    if (url.endsWith("messages?anchorMessageId=frozen-origin")) return { status: 200, body: { items: [messageFixture({ id: "frozen-origin", role: "assistant", text: "这份混音初稿的原消息。" })], nextCursor: null, watermark: "wm-origin" } };
    return null;
  } });
  renderAt("/agent/conv-w?page=library");
  await userEvent.click(await screen.findByRole("button", { name: /混音定稿/ }));
  expect(await screen.findByLabelText("定稿视频")).toHaveAttribute("src", "/api/agent/v1/blobs/frozen-output/content");
  const actual = screen.getByRole("region", { name: "定稿视频的声音" });
  expect(within(actual).getByText("雨停主题曲")).toBeVisible();
  expect(within(actual).getByRole("link", { name: "原素材" })).toHaveAttribute("href", "https://freetouse.com/music/frozen-track");
  expect(within(actual).getByRole("textbox", { name: "发布署名" })).toHaveValue(MUSIC_SOUND_SUMMARY.music!.source.attributionText);
  expect(within(actual).getByText("配音原文：独立配音 L2。")).toBeVisible();
  await userEvent.click(screen.getByText("采用的画面与声音方案"));
  expect(await screen.findByText("这份方案冻结采用旧画面，音乐以本次制作记录为准。")).toBeVisible();
  expect(screen.queryByText("本次制作旁白")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "回到对话" }));
  expect(await screen.findByText("这份混音初稿的原消息。")).toBeInTheDocument();
  expect(harness.calls.some(call => call.url.endsWith("/artifacts/plan/revisions/plan-frozen-r2"))).toBe(true);
  expect(harness.calls.filter(call => /\/(runs|proposals)\//.test(call.url))).toHaveLength(0);
});

it("F2 作品库未知音频不从旧方案猜测实际旁白", async () => {
  const entry: LibraryVideo = { video: { artifactId: "video", revisionId: "video-rev-1" }, workId: "work-1", conversationId: "conv-w",
    title: "现成音频成片", finalizedAt: "2026-01-01T00:00:00.000Z", plan: { artifactId: "plan", revisionId: "plan-rev-1" }, content: null, originMessageId: null, narrationText: null };
  installStageRoutes({ onRequest: url => {
    if (url.endsWith("/library/videos")) return { status: 200, body: { items: [entry], nextCursor: null } };
    if (url.endsWith("/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("video", "video-rev-1", "run-audio", "output") };
    if (url.endsWith("/revisions/plan-rev-1")) return { status: 200, body: revisionFixture("plan", "plan-rev-1", 1, "旧方案写了台词，不能当作现成音频的逐字证据。") };
    return null;
  } });
  renderAt("/agent/conv-w?page=library");
  await userEvent.click(await screen.findByRole("button", { name: /现成音频成片/ }));
  await userEvent.click(screen.getByText("采用的画面与声音方案"));
  expect(await screen.findByText("这次制作没有可核对的逐字旁白记录。")).toBeInTheDocument();
  expect(screen.queryByText("本次制作旁白")).toBeNull();
});
