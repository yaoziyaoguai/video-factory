import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench } from "../src/client/agent/AgentWorkbench.js";
import { loadReadingView, saveReadingView } from "../src/client/agent/workspace-state.js";
import { MarkdownText } from "../src/client/agent/markdown.js";
import { ProposalCard, RunCard } from "../src/client/agent/ProductionCards.js";
import type {
  ArtifactHead, ArtifactRevision, AudioSummary, Bootstrap, ContentSource, Conversation, InputRef, LibraryVideo, MaterialBatch, MaterialBatchIndexItem, Message, MessageInput, Proposal, ReviewItem, Run, RunSegment, Snapshot, Work,
} from "../src/shared/agent/generated/contracts.js";

// R2 组审阅工作台：works.reviewGroups 的组页签与事项卡、认可按钮走 MessageInput.reviewConfirmation、
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

// 文本模型未配置：继续下一组需要文本模型，但纯认可仍可用。
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
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] }, kind: "chat", feedback: null, librarySelections: [], ...options,
  };
}

// 旧固定三阶段的夹具入口映射为审阅组：content/plan/video 各成一组，组名沿用原页签名；
// stage 表示默认活动组（排在第一），与旧“当前阶段”语义一致。
const GROUP_META = {
  content: { groupId: "group-content", title: "内容草稿", itemId: "item-content", label: "内容草稿", role: "content" },
  plan: { groupId: "group-plan", title: "画面与声音", itemId: "item-plan", label: "画面与声音", role: "plan" },
  video: { groupId: "group-video", title: "视频初稿", itemId: "item-video", label: "视频初稿", role: "video" },
} as const;
type StageName = keyof typeof GROUP_META;

interface ItemOptions {
  draft?: ContentSource | null;
  approved?: ContentSource | null;
  finalizedSource?: ContentSource | null;
  approvedAt?: string | null;
  confirmationId?: string | null;
}

function workFixture(options: {
  id: string; title: string; stage?: StageName; revision?: number; updatedAt?: string;
  content?: ItemOptions; plan?: ItemOptions; video?: ItemOptions;
}): Work {
  const provided = (["content", "plan", "video"] as const).filter(name => options[name] != null);
  const ordered = options.stage && provided.includes(options.stage)
    ? [options.stage, ...provided.filter(name => name !== options.stage)] : provided;
  return {
    id: options.id, title: options.title, revision: options.revision ?? 1,
    reviewGroups: ordered.map(name => {
      const meta = GROUP_META[name];
      const item = options[name]!;
      return {
        id: meta.groupId, title: meta.title, revision: 1, nextIntent: null,
        items: [{
          id: meta.itemId, label: meta.label, role: meta.role, required: true,
          draft: item.draft ?? null, approved: item.approved ?? null,
          finalizedSource: item.finalizedSource ?? null,
          confirmationId: item.confirmationId ?? null, approvedAt: item.approvedAt ?? null,
        }],
      };
    }),
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
    id, conversationId: "conv-w", digest: "a".repeat(64), revision: 1, state: "ready", acceptedRunId: null, acceptanceBlocker: null,
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
    id, conversationId: "conv-w", workId: "work-1", snapshotId: `snap-${id}`, origin: { kind: "proposal", proposalId: `proposal-${id}` }, revision: 1, state, title,
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

// 组审阅工作台路由：snapshot 提供 works/materialBatches；works 与批次按 id 读取。
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
  // 本套件覆盖单件审阅，从该作品的持久阅读位置进入；首次进入的多作品总览单独覆盖。
  if (options.works?.[0] && !loadReadingView(conversation.id)) saveReadingView(conversation.id, { entry: "work", workId: options.works[0].id, artifactId: null, revisionId: null, runId: null, batchId: null });
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
const canvas = () => within(screen.getByRole("region", { name: "草稿与修改" }));
const findCanvasText = async (text: string) => within(await screen.findByRole("region", { name: "草稿与修改" })).findByText(text);
const switchWork = async (title: string) => {
  const select = await screen.findByRole("combobox", { name: "切换作品" });
  await userEvent.selectOptions(select, within(select).getByRole("option", { name: title }));
};

it("PC 首次打开定位待审组，后续交付不会抢走未点击过页签的阅读位置", async () => {
  const draft = { kind: "message_text" as const, messageId: "source", text: "当前脚本", author: "user" as const };
  const harness = installStageRoutes({ works: [workFixture({ id: "reading-work", title: "阅读位置", content: { draft } })] });
  renderAt("/agent/conv-w");
  await findCanvasText("当前脚本");
  harness.snapshot.works[0] = workFixture({ id: "reading-work", title: "阅读位置", stage: "plan", revision: 2,
    content: { draft, approved: draft }, plan: { draft: { ...draft, messageId: "new-plan", text: "新方案" } } });
  FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "next-group", kind: "work.changed", entityId: "reading-work", entityVersion: 2 });
  await screen.findByRole("option", { name: /画面与声音/ });
  expect(screen.getByRole("option", { name: /内容草稿/ })).toHaveProperty("selected", true);
  expect(canvas().queryByText("新方案")).toBeNull();
});

it("PC 继续在排队期间保持禁用，刷新恢复处理状态且不锁另一作品", async () => {
  const source = { kind: "message_text" as const, messageId: "approved-message", text: "已认可脚本", author: "user" as const };
  const a = workFixture({ id: "work-a", title: "作品 A", content: { draft: source, approved: source } });
  const b = workFixture({ id: "work-b", title: "作品 B", content: { draft: source, approved: source } });
  let accepted = false;
  const harness = installStageRoutes({ works: [a, b], onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) {
      accepted = true;
      harness.snapshot.messages.items = [messageFixture({ id: "continue-message", requestId: "continue-request", role: "user", state: "queued", text: "继续作品 A", reviewContext: { workId: a.id, groupId: "group-content", intent: "continue" } })];
      return { status: 202, body: { requestId: "continue-request", messageId: "continue-message", state: "queued", replayed: false, runId: null } };
    }
    return null;
  } });
  const first = renderAt("/agent/conv-w");
  await userEvent.click(await screen.findByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ }));
  await waitFor(() => expect(accepted).toBe(true));
  expect(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ })).toBeDisabled();
  expect(await screen.findByText("已加入队列，等待前面的请求完成。")).toBeInTheDocument();
  first.unmount(); renderAt("/agent/conv-w");
  expect(await screen.findByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ })).toBeDisabled();
  await switchWork("作品 B");
  expect(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ })).toBeEnabled();
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

it("PC 比较准确两版，选择审阅组不发送命令，聚焦审片保留聊天与稿旁意见", async () => {
  const draft = { kind: "artifact_revision" as const, artifactId: "script", revisionId: "script-rev-2", digest: "sha256:v2" };
  const harness = installStageRoutes({ works: [workFixture({ id: "work-compare", title: "山路", content: { draft }, plan: { draft: null } })] });
  renderAt("/agent/conv-w");
  await findCanvasText("script 正文 script-rev-2");
  await userEvent.click(screen.getByRole("button", { name: "比较版本" }));
  expect(await within(screen.getByRole("region", { name: "上一版内容" })).findByText("script 正文 script-rev-1")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "当前查看版本" })).getByText("script 正文 script-rev-2")).toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "聊天草稿");
  await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
  await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "稿旁意见");
  await userEvent.click(screen.getByRole("button", { name: "展开作品区" }));
  await userEvent.click(await screen.findByRole("button", { name: "返回聊天与作品" }));
  expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("聊天草稿");
  expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("稿旁意见");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "审阅组" }), screen.getByRole("option", { name: /画面与声音/ }));
  expect(screen.getByRole("option", { name: /画面与声音/ })).toHaveProperty("selected", true);
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

describe("R2 组审阅工作台", () => {
  it("DG-R1 独立脚本只认当前准确版且保留聊天草稿；v2 草稿与已认 v1 在刷新后各自读取", async () => {
    const v1: ArtifactRevision = { ...revisionFixture("standalone", "script-v1", 1, ""), content: {
      format: "markdown", text: "", sections: [
        { id: "opening", title: "开场", text: "独立脚本第一版" },
        { id: "middle", title: "发展", text: "第一版中段：雨落在窗台。" },
        { id: "ending", title: "结尾", text: "第一版结尾：灯还亮着。" },
      ],
    } };
    const v2: ArtifactRevision = { ...revisionFixture("standalone", "script-v2", 2, "", "script-v1"), content: {
      format: "markdown", text: "", sections: [
        { id: "opening", title: "开场", text: "独立脚本第二版" },
        { id: "middle", title: "发展", text: "第二版中段：风吹开了门。" },
        { id: "ending", title: "结尾", text: "第二版结尾：天色渐明。" },
      ],
    } };
    const script = artifactFixture("standalone", "独立脚本文稿", "script-v1", 1, "script", null);
    const prompt = artifactFixture("prompt", "普通提示词", "prompt-v1", 1, "prompt", null);
    let headOutsidePage: ArtifactHead | null = null;
    const confirmationMessage = messageFixture({ id: "approved-script", role: "user", text: "认可独立脚本这一版。",
      references: { artifacts: [{ artifactId: "standalone", revisionId: "script-v1" }], proposalIds: [], runIds: [], materialBatchIds: [] } });
    const harness = installStageRoutes({ artifacts: [script, prompt], bootstrap: NO_TEXT_BOOTSTRAP,
      onRequest: (url, call) => {
        if (url.endsWith("/artifacts/standalone/revisions/script-v1")) return { status: 200, body: v1 };
        if (url.endsWith("/artifacts/standalone/revisions/script-v2")) return { status: 200, body: v2 };
        if (url.endsWith("/artifacts/standalone")) return { status: 200, body: harness.snapshot.artifacts.items[0] ?? headOutsidePage };
        if (url.endsWith("/messages/approved-script")) return { status: 200, body: harness.snapshot.messages.items[0] ?? confirmationMessage };
        if (call.method === "POST" && url.endsWith("/messages")) {
          const command = call.body as MessageInput;
          expect(command.reviewConfirmation).toEqual({ kind: "standalone_artifact", artifactId: "standalone",
            revisionId: harness.snapshot.artifacts.items[0]!.revisionId, action: "approve" });
          return { status: 202, body: { requestId: "approve-script", messageId: "approved-script", state: "completed", replayed: false, runId: null } };
        }
        return null;
      } });
    let page = renderAt("/agent/conv-w");
    await userEvent.click(await screen.findByRole("button", { name: "普通提示词" }));
    expect(screen.queryByRole("button", { name: "认可这一版" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "独立脚本文稿" }));
    await within(screen.getByRole("region", { name: "草稿与修改" })).findByText("独立脚本第一版");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先留着我的聊天草稿");
    await userEvent.click(screen.getByRole("button", { name: "认可这一版" }));
    const command = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as MessageInput;
    expect(command).toMatchObject({ target: null, skillId: null, proposalRef: null, mode: "new", reviewContext: null });
    expect(command.librarySelections).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("button", { name: "认可这一版" })).toBeEnabled());

    harness.snapshot.artifacts.items[0] = { ...script, standaloneApproval: { confirmationId: "confirm-v1", revisionId: "script-v1", approvedAt: "2026-01-02T00:00:00Z" } };
    harness.snapshot.messages.items = [confirmationMessage];
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "approve-v1", kind: "message.changed", entityId: "approved-script", entityVersion: 1 });
    await within(screen.getByRole("region", { name: "已确认成果" })).findByText("独立脚本第一版");
    expect(screen.queryByText("有更新")).toBeNull();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先留着我的聊天草稿");

    harness.snapshot.artifacts.items[0] = { ...harness.snapshot.artifacts.items[0]!, revisionId: "script-v2", revisionNumber: 2 };
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "draft-v2", kind: "artifact.delivered", entityId: "standalone", entityVersion: 2 });
    await waitFor(() => expect(screen.getByRole("button", { name: "独立脚本文稿", pressed: true })).toHaveTextContent("有更新"));
    expect(screen.queryByRole("button", { name: "认可这一版" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "独立脚本文稿", pressed: true }));
    await within(screen.getByRole("region", { name: "草稿与修改" })).findByText("独立脚本第二版");
    expect(within(screen.getByRole("region", { name: "已确认成果" })).getByText("独立脚本第一版")).toBeInTheDocument();
    page.unmount();
    page = renderAt("/agent/conv-w");
    const draftAfterReload = within(await screen.findByRole("region", { name: "草稿与修改" }));
    expect(await draftAfterReload.findByText("独立脚本第二版")).toBeVisible();
    expect(draftAfterReload.getByText("第二版中段：风吹开了门。")).toBeVisible();
    expect(draftAfterReload.queryByText("第一版中段：雨落在窗台。")).toBeNull();
    const approvedAfterReload = within(screen.getByRole("region", { name: "已确认成果" }));
    expect(await approvedAfterReload.findByText("独立脚本第一版")).toBeVisible();
    expect(approvedAfterReload.getByText("第一版中段：雨落在窗台。")).toBeVisible();
    expect(approvedAfterReload.getByText("第一版结尾：灯还亮着。")).toBeVisible();
    expect(approvedAfterReload.queryByText("独立脚本第二版")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "认可这一版" }));
    headOutsidePage = { ...harness.snapshot.artifacts.items[0]!, standaloneApproval: { confirmationId: "confirm-v2", revisionId: "script-v2", approvedAt: "2026-01-03T00:00:00Z" } };
    harness.snapshot.artifacts.items = [];
    harness.snapshot.messages.items = [{ ...confirmationMessage, revision: 2, references: { ...confirmationMessage.references, artifacts: [{ artifactId: "standalone", revisionId: "script-v2" }] } }];
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "approve-v2", kind: "message.changed", entityId: "approved-script", entityVersion: 2 });
    await within(screen.getByRole("region", { name: "已确认成果" })).findByText("独立脚本第二版");
    expect(approvedAfterReload.getByText("第二版中段：风吹开了门。")).toBeVisible();
    expect(approvedAfterReload.getByText("第二版结尾：天色渐明。")).toBeVisible();
    expect(approvedAfterReload.queryByText("第一版中段：雨落在窗台。")).toBeNull();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先留着我的聊天草稿");
    expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(harness.snapshot.works).toEqual([]);
    expect(harness.snapshot.proposals.items).toEqual([]);
    expect(harness.snapshot.runs.items).toEqual([]);
  });

  it("DG-R1 当前视频预览一次提交准确 adopt_preview，旧版不可采用且普通 clip 认可仍独立", async () => {
    const oldSource = { kind: "artifact_revision" as const, artifactId: "clip", revisionId: "clip-v1", digest: "old" };
    const source = { ...oldSource, revisionId: "clip-v2", digest: "current" };
    const work = workFixture({ id: "work-1", title: "溪流短片", content: { draft: source, approved: oldSource } });
    const item = work.reviewGroups[0]!.items[0]!;
    item.role = "clip"; item.label = "流水预览"; item.required = false;
    let finishAdoption: (() => void) | undefined;
    const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("clip", "流水预览", "clip-v2", 2, "video")],
      onRequest: async (url, call) => {
        if (url.endsWith("/revisions/clip-v2")) return { status: 200, body: { ...videoRevisionFixture("clip", "clip-v2", "original-run", "original-blob"), revisionNumber: 2, baseRevisionId: "clip-v1" } };
        if (url.endsWith("/revisions/clip-v1")) return { status: 200, body: videoRevisionFixture("clip", "clip-v1", "old-run", "old-blob") };
        if (call.method === "POST" && url.endsWith("/messages")) {
          const confirmation = (call.body as MessageInput).reviewConfirmation;
          if (confirmation && "kind" in confirmation && confirmation.kind === "adopt_preview") {
            await new Promise<void>(resolve => { finishAdoption = resolve; });
            return { status: 202, body: { requestId: "adopt-preview", messageId: "adopted-preview", state: "completed", replayed: false, runId: null } };
          }
        }
        return null;
      } });
    renderAt("/agent/conv-w");
    const draft = within(await screen.findByRole("region", { name: "草稿与修改" }));
    await draft.findByLabelText("视频预览");
    await userEvent.click(draft.getByRole("button", { name: "看上一版" }));
    await waitFor(() => expect(draft.getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/old-blob/content"));
    expect(draft.queryByRole("button", { name: "以这版「流水预览」定稿并入库" })).toBeNull();
    await userEvent.click(draft.getByRole("button", { name: "查看最新稿" }));
    await waitFor(() => expect(draft.getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/original-blob/content"));
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "保留这段没发送的想法");
    const adopt = draft.getByRole("button", { name: "以这版「流水预览」定稿并入库" });
    await userEvent.click(adopt);
    expect(adopt).toBeDisabled();
    await userEvent.click(adopt);
    const posts = harness.calls.filter(call => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as MessageInput).reviewConfirmation).toEqual({ kind: "adopt_preview", workId: "work-1", groupId: "group-content", itemId: "item-content",
      source: { artifactId: "clip", revisionId: "clip-v2" }, action: "finalize_video" });
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("保留这段没发送的想法");
    expect(screen.queryByText(/后台制作中|等待制作|正在处理/)).toBeNull();
    finishAdoption!();
    await waitFor(() => expect(adopt).toBeEnabled());
    expect(work.reviewGroups[0]!.items[0]!.approved).toEqual(oldSource);
    await userEvent.click(draft.getByRole("button", { name: "认可「流水预览」" }));
    const approval = harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput;
    expect(approval.reviewConfirmation).toEqual({ workId: "work-1", groupId: "group-content", action: "approve", items: [{ itemId: "item-content", source }] });
  });

  it("组页签呈现当前稿与组级认可；认可走 reviewConfirmation 且不动聊天草稿", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    expect(await screen.findByRole("heading", { name: "城市短片" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "未确认" })).getByText("1 项")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "审阅组" })).toBeNull();
    await findCanvasText("art-script 正文 art-script-rev-2");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "我还没想好，先留着");
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    const command = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as Record<string, unknown>;
    // subject 只按输入合同组装：artifact_revision 变体按输入合同组 subject，不展开服务端输出对象。
    expect(command.reviewConfirmation).toEqual({
      workId: "work-1", groupId: "group-content", action: "approve",
      items: [{ itemId: "item-content", source: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } }],
    });
    expect(command.mode).toBe("new");
    // 认可按钮独立构造请求，不清空用户未发送的聊天草稿
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("我还没想好，先留着");
  });

  it("整组认可后仍有普通继续入口：继续是不带认可命令的一次普通消息，不动聊天草稿", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: source, approved: source, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-1" },
    });
    const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    expect(await screen.findByRole("button", { name: "继续下一步" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认可整组" })).toBeNull();
    expect(screen.queryByRole("button", { name: "认可并继续" })).toBeNull();
    expect(screen.getByRole("button", { name: "继续下一步" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "先聊两句别的");
    await userEvent.click(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ }));
    const command = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect(command.reviewConfirmation).toBeNull();
    expect(command.mode).toBe("new");
    expect(command.text).toContain("请继续");
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("先聊两句别的");
  });

  it("V1 认可与定稿分离：已认可未定稿显示可定稿并一键入库；定稿后才标已定稿，新 v2 不继承定稿", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "video", revisionId: "video-rev-1", digest: "v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "video", revisionId: "video-rev-2", digest: "v2" };
    const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "video",
      video: { draft: v1, approved: v1, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-approve" } })],
      artifacts: [artifactFixture("video", "视频初稿", "video-rev-1", 1, "video")] });
    renderAt("/agent/conv-w");
    // 普通认可不等于定稿：状态如实说“已认可，可定稿”，仍保留一键定稿入口。
    expect(await screen.findByText("已认可，可定稿")).toBeInTheDocument();
    expect(screen.queryByText("已定稿")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "以这版「视频初稿」定稿并入库" }));
    let command = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect(command.reviewConfirmation).toMatchObject({ action: "finalize_video",
      items: [{ itemId: "item-video", source: { kind: "artifact_revision", artifactId: "video", revisionId: "video-rev-1", digest: "v1" } }] });

    // 定稿记录到达（finalizedSource 投影指向该版）：才显示已定稿，入口收起。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "城市短片", stage: "video", revision: 2,
      video: { draft: v1, approved: v1, finalizedSource: v1, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-approve" } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "finalized", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    expect(await screen.findByText("已定稿并入库")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "以这版「视频初稿」定稿并入库" })).toBeNull();

    // 新 v2 草稿到达：定稿不继承，回到待认可并重新给出一键定稿。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "城市短片", stage: "video", revision: 3,
      video: { draft: v2, approved: v1, finalizedSource: v1, approvedAt: "2026-01-01T00:00:00.000Z", confirmationId: "conf-approve" } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "v2", kind: "work.changed", entityId: "work-1", entityVersion: 3 });
    await userEvent.click(await screen.findByRole("button", { name: "查看最新稿" }));
    expect(await screen.findByText("新稿待确认")).toBeInTheDocument();
    // v1 仍留在右侧已确认区；新的待确认 v2 在左侧独立出现。
    expect(within(screen.getByRole("region", { name: "已确认成果" })).getByText("video 正文 video-rev-1")).toBeInTheDocument();
    await findCanvasText("video 正文 video-rev-2");
    await waitFor(() => expect(screen.getByRole("button", { name: "以这版「视频初稿」定稿并入库" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "以这版「视频初稿」定稿并入库" }));
    command = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect(command.reviewConfirmation).toMatchObject({ action: "finalize_video",
      items: [{ itemId: "item-video", source: { kind: "artifact_revision", revisionId: "video-rev-2", digest: "v2" } }] });
  });

  it("V1 出背景新稿时继续看旧稿：整组认可被禁用并指出原因，单项仍可认；回最新稿后整组只提交准确当前稿", async () => {
    const char = { kind: "artifact_revision" as const, artifactId: "art-char", revisionId: "char-rev-1", digest: "c1" };
    const sceneV1 = { kind: "artifact_revision" as const, artifactId: "art-scene", revisionId: "scene-rev-1", digest: "s1" };
    const sceneV2 = { kind: "artifact_revision" as const, artifactId: "art-scene", revisionId: "scene-rev-2", digest: "s2" };
    const work: Work = {
      id: "work-1", title: "城市短片", revision: 1,
      reviewGroups: [{
        id: "group-visual", title: "视觉方向", revision: 1, nextIntent: null,
        items: [
          { id: "item-char", label: "人物", role: "character", required: true, draft: char, approved: null, finalizedSource: null, confirmationId: null, approvedAt: null },
          { id: "item-scene", label: "背景", role: "scene", required: true, draft: sceneV2, approved: sceneV1, finalizedSource: null, confirmationId: "conf-scene-old", approvedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const harness = installStageRoutes({ works: [work],
      artifacts: [artifactFixture("art-char", "人物", "char-rev-1", 1), artifactFixture("art-scene", "背景", "scene-rev-2", 2)] });
    renderAt("/agent/conv-w");
    await userEvent.click(await screen.findByRole("button", { name: "审阅背景 v2" }));
    await findCanvasText("art-scene 正文 scene-rev-2");
    // 背景停留在旧版阅读：整组动作禁用并说明原因，人物单项认可不受影响。
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await findCanvasText("art-scene 正文 art-scene-rev-1");
    expect(screen.getByText("「背景」正在看旧版")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认可整组" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "认可并继续" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "审阅人物 v1" }));
    expect(screen.getByRole("button", { name: "认可「人物」" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "认可「人物」" }));
    await waitFor(() => expect(harness.calls.some(call => call.method === "POST" && call.url.endsWith("/messages"))).toBe(true));

    // 人物认可落库、背景回到最新稿后：整组恢复，且只提交背景的准确当前稿 v2。
    harness.snapshot.works[0] = { ...work, revision: 2, reviewGroups: [{ ...work.reviewGroups[0]!, revision: 2,
      items: [
        { ...work.reviewGroups[0]!.items[0]!, approved: char, confirmationId: "conf-char", approvedAt: "2026-01-01T00:00:00.000Z" },
        work.reviewGroups[0]!.items[1]!,
      ] }] };
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "char-ok", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await userEvent.click(screen.getByRole("button", { name: "审阅背景 v2" }));
    await findCanvasText("art-scene 正文 scene-rev-2");
    expect(screen.getByRole("button", { name: "认可整组" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    const command = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect(command.reviewConfirmation).toMatchObject({ action: "approve",
      items: [{ itemId: "item-scene", source: { kind: "artifact_revision", revisionId: "scene-rev-2", digest: "s2" } }] });
  });

  it("V1 当前稿未加载时整组认可同样被禁用；单项路径不依赖整组", async () => {
    const char = { kind: "artifact_revision" as const, artifactId: "art-char", revisionId: "char-rev-1", digest: "c1" };
    const sceneV2 = { kind: "artifact_revision" as const, artifactId: "art-scene", revisionId: "scene-rev-2", digest: "s2" };
    const work: Work = {
      id: "work-1", title: "城市短片", revision: 1,
      reviewGroups: [{
        id: "group-visual", title: "视觉方向", revision: 1, nextIntent: null,
        items: [
          { id: "item-char", label: "人物", role: "character", required: true, draft: char, approved: null, finalizedSource: null, confirmationId: null, approvedAt: null },
          { id: "item-scene", label: "背景", role: "scene", required: true, draft: sceneV2, approved: null, finalizedSource: null, confirmationId: null, approvedAt: null },
        ],
      }],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    installStageRoutes({ works: [work],
      artifacts: [artifactFixture("art-char", "人物", "char-rev-1", 1)],
      onRequest: url => url.endsWith("/revisions/scene-rev-2")
        ? new Promise<RouteResult>(() => { /* 当前稿悬停未加载 */ }) : null });
    renderAt("/agent/conv-w");
    await findCanvasText("art-char 正文 char-rev-1");
    expect(screen.getByText("「背景」的最新稿还没打开")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认可整组" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "认可「人物」" })).toBeEnabled();
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
    await findCanvasText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("button", { name: "认可整组" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "继续下一步" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    await waitFor(() => expect(harness.calls.some(call => call.method === "POST" && call.url.endsWith("/messages"))).toBe(true));
    const item = work.reviewGroups[0]!.items[0]!;
    harness.snapshot.works[0] = { ...work, revision: 2, reviewGroups: [{ ...work.reviewGroups[0]!, items: [{ ...item, approved: item.draft }] }] };
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "approval", kind: "work.changed", entityId: work.id, entityVersion: 2 });
    expect(await screen.findByRole("button", { name: "继续下一步" })).toBeDisabled();
    expect(screen.getByText("继续需要可用的文本模型")).toBeInTheDocument();
  });

  it("查看旧版本时不能确认；回到最新稿后恢复确认入口", async () => {
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } },
    });
    installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2)] });
    renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await findCanvasText("art-script 正文 art-script-rev-1");
    expect(screen.getByText("正在看旧版本，不能在这里确认；请回到最新稿。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认可「内容草稿」" })).toBeNull();
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveAttribute("readonly");
    expect(screen.getByText("旧稿意见仅供查看，可以复制后继续讨论。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await findCanvasText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("button", { name: "认可「内容草稿」" })).toBeEnabled();
  });

  it("读稿失败有重试；新组到达和 A/B 切换保留阅读组与未发送意见", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const a = workFixture({ id: "work-1", title: "城市短片", content: { draft } });
    const b = workFixture({ id: "work-2", title: "咖啡短片" });
    let failRead = true;
    const harness = installStageRoutes({ works: [a, b], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)],
      onRequest: url => url.endsWith(`/revisions/${draft.revisionId}`) && failRead
        ? { status: 503, body: { code: "UNAVAILABLE", message: "暂不可读" } } : null });
    renderAt("/agent/conv-w");
    await switchWork("城市短片");
    await screen.findByText("草稿读取失败。");
    failRead = false;
    await userEvent.click(screen.getByRole("button", { name: "重试读取草稿" }));
    await findCanvasText("art-script 正文 art-script-rev-2");
    expect(screen.getByRole("region", { name: "已确认成果" })).toBeVisible();
    // 唯一组无需选择器；新组到达也不能抢走正在看的事项。
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "结尾我还在想");
    harness.snapshot.works[0] = workFixture({ id: a.id, title: a.title, revision: 2, stage: "plan",
      content: { draft, approved: draft, confirmationId: "conf-content" },
      plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "plan-rev-1", digest: "p" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "plan-arrived", kind: "work.changed", entityId: a.id, entityVersion: 2 });
    await waitFor(() => expect(screen.getByRole("option", { name: /画面与声音/ })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /内容草稿/ })).toHaveProperty("selected", true);
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
    await switchWork("咖啡短片");
    await switchWork("城市短片");
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
    await userEvent.click(screen.getByRole("button", { name: "全部作品 2 件" }));
    await userEvent.click(screen.getByRole("button", { name: "审阅城市短片" }));
    expect(screen.queryByRole("button", { name: "回到创作" })).toBeNull();
    expect(screen.getByRole("region", { name: "草稿与修改" })).toBeVisible();
    expect(screen.getByRole("region", { name: "已确认成果" })).toBeVisible();
    expect(screen.getByRole("option", { name: /内容草稿/ })).toHaveProperty("selected", true);
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾我还在想");
  });

  it("旧版成品保留在成果区；未定稿的新视频只在草稿区预览", async () => {
    const source = { kind: "message_text" as const, messageId: "old-user-message", text: "采用的确切内容，不需要重新读取原消息", author: "user" as const };
    const video = { kind: "artifact_revision" as const, artifactId: "video", revisionId: "video-rev-2", digest: "v2" };
    installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "video",
      content: { draft: source, approved: source },
      video: { draft: video, approved: { ...video, revisionId: "video-rev-1", digest: "v1" } } })],
      artifacts: [artifactFixture("video", "视频初稿", "video-rev-2", 2, "video")],
      onRequest: url => /revisions\/video-rev-[12]$/.test(url) ? { status: 200, body: {
        ...revisionFixture("video", url.endsWith("1") ? "video-rev-1" : "video-rev-2", url.endsWith("1") ? 1 : 2, "", null),
        content: { format: "media", blobId: url.endsWith("1") ? "file-approved" : "file-real", mimeType: "video/mp4", durationMs: 3000, width: 640, height: 360, sources: [] },
      } } : null });
    renderAt("/agent/conv-w");
    await waitFor(() => expect(screen.getByRole("button", { name: "以这版「视频初稿」定稿并入库" })).toBeEnabled());
    await waitFor(() => expect(within(screen.getByRole("region", { name: "草稿与修改" })).getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/file-real/content"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "审阅组" }), screen.getByRole("option", { name: /内容草稿/ }));
    expect(await within(screen.getByRole("region", { name: "已确认成果" })).findByText(source.text)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "已确认成果" }).querySelector("video")).toBeInTheDocument());
    // 成果区保留已认可内容与上一版定稿视频；新版未定稿不进成果区
    expect(screen.getByRole("region", { name: "已确认成果" }).querySelector("video")).toHaveAttribute("src", "/api/agent/v1/blobs/file-approved/content#t=0.1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "审阅组" }), screen.getByRole("option", { name: /视频初稿/ }));
    expect(within(screen.getByRole("region", { name: "草稿与修改" })).getByLabelText("视频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/file-real/content");
    expect(screen.getByRole("region", { name: "已确认成果" }).querySelector("video")).toHaveAttribute("src", "/api/agent/v1/blobs/file-approved/content#t=0.1");
  });

  it("受理门槛由服务端推导：受阻提案只显示原因，不出现确认入口", async () => {
    const source = { kind: "message_text" as const, messageId: "m", text: "内容", author: "user" as const };
    const blocked = { ...proposalFixture("proposal-blocked", "等待认可的制作", "work-1"),
      acceptanceBlocker: { code: "INPUT_APPROVAL_REQUIRED" as const, message: "还需认可「画面与声音」后才能开始制作。", action: "review_inputs" as const } };
    installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source } })],
      proposals: [blocked], messages: [messageFixture({ id: "m-plan", role: "assistant", text: "先准备了提案。",
        references: { artifacts: [], proposalIds: [blocked.id], runIds: [], materialBatchIds: [] } })] });
    renderAt("/agent/conv-w");
    await screen.findByText("先准备了提案。");
    expect(screen.getByText("还需认可「画面与声音」后才能开始制作。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认制作" })).toBeNull();
  });

  it("认可后新组可查看但不抢阅读位置；只有明确继续才发继续命令", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({
      id: "work-1", title: "城市短片", stage: "content",
      content: { draft: source },
    });
    const harness = installStageRoutes({
      works: [work], artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2), artifactFixture("art-plan", "画面方案", "art-plan-rev-1", 1)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          harness.snapshot.works = [workFixture({
            id: "work-1", title: "城市短片", stage: "plan", revision: 2, updatedAt: "2026-01-02T00:00:00.000Z",
            content: { draft: source, approved: source, approvedAt: "2026-01-02T00:00:00.000Z", confirmationId: "conf-2" },
            plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-1", digest: "sha256:art-plan-rev-1" } },
          })];
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "认可「内容草稿」" }));
    const command = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/messages"))!.body as Record<string, unknown>;
    expect(command.reviewConfirmation).toMatchObject({
      workId: "work-1", groupId: "group-content", action: "approve",
      items: [{ itemId: "item-content", source: { kind: "artifact_revision", artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" } }],
    });
    // 新组到达后仍保留原内容和未发送意见，认可不隐式发起制作。
    expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "未确认" })).getByText("1 项")).toBeInTheDocument());
    const planTab = screen.getByRole("option", { name: /画面与声音/ });
    expect(screen.getByRole("option", { name: /内容草稿/ })).toHaveProperty("selected", true);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "审阅组" }), planTab);
    await findCanvasText("art-plan 正文 art-plan-rev-1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "审阅组" }), screen.getByRole("option", { name: /内容草稿/ }));
    expect(screen.getByRole("button", { name: "继续下一步" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "继续下一步" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "继续下一步" }));
    const continued = harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput;
    expect(continued.reviewConfirmation).toBeNull();
    expect(continued.reviewContext).toEqual({ workId: "work-1", groupId: "group-content", intent: "continue" });
    // 成功后命令持久被清理，不留下重放痕迹
    expect(window.localStorage.getItem("vf:agent-review:conv-w:work-1:group-content:approve_and_continue:art-script:art-script-rev-2")).toBeNull();
  });

  it("提案确认走准确受理端点；已受理提案不再出现确认入口", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const ready = proposalFixture("proposal-bound", "城市短片制作", "work-1");
    const accepted = { ...proposalFixture("proposal-done", "旧一次制作", "work-1"), digest: "c".repeat(64), state: "accepted" as const, acceptedRunId: "run-done" };
    const harness = installStageRoutes({
      works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
        content: { draft: source, approved: source },
        plan: { draft: { kind: "artifact_revision", artifactId: "art-plan", revisionId: "art-plan-rev-2", digest: "sha256:art-plan-rev-2" } } })],
      proposals: [ready, accepted],
      bootstrap: { ...BOOTSTRAP, models: [...BOOTSTRAP.models, { ...BOOTSTRAP.models[0]!, kind: "video", features: ["offline-fixture"] }] },
      artifacts: [artifactFixture("art-script", "城市短片脚本", "art-script-rev-2", 2), artifactFixture("art-plan", "画面方案", "art-plan-rev-2", 2)],
      messages: [messageFixture({ id: "m-proposals", role: "assistant", text: "独立提案与旧提案保留各自引用。",
        references: { artifacts: [], proposalIds: [ready.id, accepted.id], runIds: [], materialBatchIds: [] } })],
      onRequest: (url, call) => call.method === "POST" && url.endsWith("/acceptances")
        ? { status: 409, body: { code: "PROPOSAL_STALE", message: "已捕获本次提案引用，测试不启动制作。" } } : null,
    });
    renderAt("/agent/conv-w");
    await screen.findByText("独立提案与旧提案保留各自引用。");
    const chat = document.querySelector(".agent-messages") as HTMLElement;
    const readyCard = within(chat).getByText(ready.spec.title).closest(".frame-production-proposal") as HTMLElement;
    expect(within(readyCard).getByRole("button", { name: "确认制作" })).toBeEnabled();
    const doneCard = within(chat).getByText(accepted.spec.title).closest(".frame-production-proposal") as HTMLElement;
    expect(within(doneCard).queryByRole("button", { name: "确认制作" })).toBeNull();
    expect(within(doneCard).getByRole("button", { name: "已受理" })).toBeDisabled();
    expect(harness.calls.filter(call => call.url.endsWith("/acceptances"))).toHaveLength(0);
    await userEvent.click(within(readyCard).getByRole("button", { name: "确认制作" }));
    await screen.findByRole("alert");
    const accepts = harness.calls.filter(call => call.url.endsWith("/acceptances"));
    expect(accepts).toHaveLength(1);
    expect(accepts[0]!.url).toContain(`/proposals/${ready.id}/acceptances`);
    expect(accepts[0]!.body).toMatchObject({ proposalDigest: ready.digest });
  });

  it("整组认可立即进入成果区，且不动聊天草稿", async () => {
    const source = { kind: "message_text" as const, messageId: "content-message", text: "已确认的内容", author: "user" as const };
    const plan = { kind: "artifact_revision" as const, artifactId: "plan", revisionId: "plan-rev-1", digest: "sha256:plan-rev-1" };
    const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source }, plan: { draft: plan } })],
      artifacts: [artifactFixture("plan", "画面与声音方案", plan.revisionId, 1)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          const body = call.body as MessageInput;
          if (body.reviewConfirmation) {
            harness.snapshot.works[0] = workFixture({ id: "work-1", title: "城市短片", stage: "plan", revision: 2,
              content: { draft: source, approved: source }, plan: { draft: plan, approved: plan, approvedAt: "2026-01-02T00:00:00.000Z", confirmationId: "plan-confirmed" } });
          }
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await findCanvasText("plan 正文 plan-rev-1");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "这句先不发送");
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    const result = screen.getByRole("region", { name: "已确认成果" });
    expect(await within(result).findByText("plan 正文 plan-rev-1")).toBeInTheDocument();
    const commands = harness.calls.filter(call => call.method === "POST").map(call => call.body as MessageInput);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.reviewConfirmation).toMatchObject({ action: "approve", groupId: "group-plan" });
    expect(commands[0]!.target).toBeNull();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("这句先不发送");

    const nextPlan = { ...plan, revisionId: "plan-rev-2", digest: "sha256:plan-rev-2" };
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "城市短片", stage: "plan", revision: 3,
      content: { draft: source, approved: source }, plan: { draft: nextPlan, approved: plan, confirmationId: "plan-confirmed" } });
    harness.snapshot.artifacts.items[0] = artifactFixture("plan", "画面与声音方案", nextPlan.revisionId, 2);
    FakeEventSource.instances.find(eventSource => !eventSource.closed)!.emit("business", { eventId: "narration-updated", kind: "work.changed", entityId: "work-1", entityVersion: 3 });
    await userEvent.click(await screen.findByRole("button", { name: "查看最新稿" }));
    expect(await within(screen.getByRole("region", { name: "草稿与修改" })).findByText("plan 正文 plan-rev-2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "已确认成果" })).getByText("plan 正文 plan-rev-1")).toBeInTheDocument();
  });

  it("认可结果未知重试沿用原命令，成功后明确继续使用独立命令", async () => {
    const source = { kind: "message_text" as const, messageId: "content-message", text: "已确认的内容", author: "user" as const };
    const plan = { kind: "artifact_revision" as const, artifactId: "plan", revisionId: "plan-rev-1", digest: "sha256:plan-rev-1" };
    let postCount = 0;
    const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "城市短片", stage: "plan",
      content: { draft: source, approved: source }, plan: { draft: plan } })],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          postCount += 1;
          if (postCount < 3) return { status: 502, body: { code: "UNAVAILABLE", message: "结果未知" } };
          if ((call.body as MessageInput).reviewConfirmation) harness.snapshot.works[0] = workFixture({ id: "work-1", title: "城市短片", stage: "plan", revision: 2,
            content: { draft: source, approved: source }, plan: { draft: plan, approved: plan } });
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await findCanvasText("plan 正文 plan-rev-1");
    const approve = () => screen.getByRole("button", { name: "认可「画面与声音」" });
    await userEvent.click(approve());
    await screen.findByRole("alert");
    const first = harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput;
    expect(first.reviewConfirmation).toMatchObject({ action: "approve", workId: "work-1", groupId: "group-plan" });
    await waitFor(() => expect(approve()).toBeEnabled());
    await userEvent.click(approve());
    await waitFor(() => expect(postCount).toBe(2));
    expect((harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput).commandId).toBe(first.commandId);
    await waitFor(() => expect(approve()).toBeEnabled());
    await userEvent.click(approve());
    const next = await screen.findByRole("button", { name: "继续下一步" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    const continued = harness.calls.filter(call => call.method === "POST").at(-1)!.body as MessageInput;
    expect(continued.commandId).not.toBe(first.commandId);
    expect(continued.reviewConfirmation).toBeNull();
    expect(continued.reviewContext).toEqual({ workId: "work-1", groupId: "group-plan", intent: "continue" });
    expect(postCount).toBe(4);
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
    await userEvent.click(within(row).getByRole("button", { name: /雨后街道/ }));
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
    await findCanvasText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见");
    await userEvent.type(screen.getByRole("textbox", { name: "消息输入" }), "聊天草稿还在");
    harness.snapshot.works[1] = workFixture({ id: "work-b", title: "事项B", revision: 2, updatedAt: "2026-01-04T00:00:00.000Z" });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "b-updated", kind: "work.changed", entityId: "work-b", entityVersion: 2 });
    // 页签顺序确实换成了 B 在前，但正在看的仍是 A。
    await waitFor(() => {
      const tabs = within(screen.getByRole("combobox", { name: "切换作品" })).getAllByRole("option");
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
    await findCanvasText("art-script 正文 art-script-rev-2");
    harness.snapshot.works[0] = workFixture({ id: "work-a", title: "事项A", revision: 2,
      content: { draft: { ...draft, revisionId: "art-script-rev-3", digest: "sha256:art-script-rev-3" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "a-new-draft", kind: "work.changed", entityId: "work-a", entityVersion: 2 });
    await screen.findByText("待认可");
    expect(await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。")).toBeInTheDocument();
    expect(canvas().getByText("art-script 正文 art-script-rev-2")).toBeInTheDocument();
    await switchWork("事项B");
    await switchWork("事项A");
    expect(canvas().getByText("art-script 正文 art-script-rev-2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await findCanvasText("art-script 正文 art-script-rev-3");
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
    await findCanvasText("art-video-1 正文 video-rev-1");
    // 新一版制作输出是另一个产物：正在看的 v1 不被抢走，也不把旧修订号配到新产物上。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "夜景短片", stage: "video", revision: 2,
      video: { draft: { kind: "artifact_revision", artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "v-new-output", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    expect(canvas().getByText("art-video-1 正文 video-rev-1")).toBeInTheDocument();
    expect(screen.queryByText(/草稿读取失败|视频读取失败/)).not.toBeInTheDocument();
    expect(harness.calls.some(call => call.url.endsWith("/artifacts/art-video-2/revisions/video-rev-1"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await findCanvasText("art-video-2 正文 video-rev-2");
  });

  it("U05/B03 A/B 各自的稿旁意见跨刷新保留；未发送不产生服务端反馈记录", async () => {
    const draftA = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-2", digest: "sha256:a2" };
    const draftB = { kind: "artifact_revision" as const, artifactId: "art-b", revisionId: "art-b-rev-1", digest: "sha256:b1" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft: draftA } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-02T00:00:00.000Z", content: { draft: draftB } });
    const harness = installStageRoutes({ works: [a, b],
      artifacts: [artifactFixture("art-a", "A 内容", "art-a-rev-2", 2), artifactFixture("art-b", "B 内容", "art-b-rev-1", 1)] });
    renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见：结尾留两秒");
    await switchWork("事项B");
    await findCanvasText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "B 的意见：换配乐");
    // 刷新（卸载重挂载，localStorage 保留）：恢复到最后在看的 B，再回 A；各自文字与准确目标仍在。
    cleanup(); renderAt("/agent/conv-w");
    await findCanvasText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("B 的意见：换配乐");
    await switchWork("事项A");
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
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
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "A 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await screen.findByRole("alert");
    // A 失败保留；期间 B 的意见成功：只清 B。
    await switchWork("事项B");
    await findCanvasText("art-b 正文 art-b-rev-1");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "B 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue(""));
    // 回到 A：意见框仍开着，失败后的文字原样保留；重试沿用原命令。
    await switchWork("事项A");
    await findCanvasText("art-a 正文 art-a-rev-2");
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("A 的意见");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue(""));
    const posts = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/feedback"));
    expect(posts).toHaveLength(3);
    expect((posts[0]!.body as { commandId: string }).commandId).toBe((posts[2]!.body as { commandId: string }).commandId);
  });

  it("U06/B03 事项卡不离开双区，明确选择旧稿后刷新保留原修订", async () => {
    const draft = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "art-script-rev-2", digest: "sha256:art-script-rev-2" };
    const work = workFixture({ id: "work-1", title: "城市短片", content: { draft } });
    installStageRoutes({ works: [work], artifacts: [artifactFixture("art-script", "城市内容", draft.revisionId, 2)] });
    renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 art-script-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await findCanvasText("art-script 正文 art-script-rev-1");
    await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
    await findCanvasText("art-script 正文 art-script-rev-2");
    expect(screen.queryByRole("button", { name: "回到创作" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
    await findCanvasText("art-script 正文 art-script-rev-1");
    expect(screen.getByRole("region", { name: "创作：城市短片" })).toBeInTheDocument();
    // 刷新：回到最后真实视图（组审阅工作台 + 原修订），不重新弹出独立产物。
    cleanup(); renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 art-script-rev-1");
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
    const work = workFixture({ id: "work-1", title: "片段阅读", stage: "video", video: { draft: v1 } });
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
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "片段阅读", stage: "video", revision: 2, video: { draft: v2 } });
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
    const work = workFixture({ id: "work-1", title: "片段补读", stage: "video", video: { draft: v1 } });
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

  it("旧画面上的片段意见仍可记录：主目标是该事项当前稿，片段指旧 run；整稿意见维持只读", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" };
    const plan = { kind: "artifact_revision" as const, artifactId: "art-plan", revisionId: "plan-rev-2", digest: "sha256:p2" };
    const work = workFixture({ id: "work-1", title: "片段意见", stage: "video", plan: { draft: plan }, video: { draft: v1 } });
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
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "片段意见", stage: "video", revision: 2, plan: { draft: plan }, video: { draft: v2 } });
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
    // 主目标是该事项当前稿（新制作输出），不是正在看的旧视频修订；片段指正在看的那次运行。
    expect(posted.target).toEqual({ workId: "work-1", artifactId: "art-video-2", revisionId: "video-rev-2", segment: { runId: "run-1", segmentId: "seg-1" } });
    // 取消针对后：整稿意见在旧稿上维持只读，不给旧稿确认入口。
    await userEvent.click(screen.getByRole("button", { name: "取消针对该片段" }));
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "记录意见" })).toBeDisabled();
    expect(screen.getByText("旧稿意见仅供查看，可以复制后继续讨论。")).toBeInTheDocument();
  });

  it("视频事项草稿前进时，未发送的片段意见文字带到新稿；提交主目标为新稿、片段为原 run", async () => {
    // 同一视频产物的修订前进（重做交付新修订）：carryForward 仅覆盖同作品同片段；
    // 跨产物新稿的迁移由下方 D1 用例单独覆盖。
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-2", digest: "sha256:v2" };
    const work = workFixture({ id: "work-1", title: "意见跟随", stage: "video", video: { draft: v1 } });
    const run1 = runFixture("run-1", "第一次制作", "art-video-1", "video-rev-1", [segmentFixture("seg-1", "旧版片段", "clip-1")]);
    const harness = installStageRoutes({
      works: [work],
      artifacts: [artifactFixture("art-video-1", "夜景成片", "video-rev-2", 2, "video")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-1", "run-1", "whole-1") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video-1/revisions/video-rev-2")) return { status: 200, body: videoRevisionFixture("art-video-1", "video-rev-2", "run-1", "whole-2") };
        if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { disposition: "next_version" } };
        return null;
      },
    });
    harness.snapshot.runs.items = [run1];
    renderAt("/agent/conv-w");
    await screen.findByRole("button", { name: /旧版片段/ });
    await userEvent.click(screen.getByRole("button", { name: /旧版片段/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "换一个更亮的结尾镜头");
    // 视频事项草稿前进（重做交付同产物新修订）：未发送文字保留到新稿键，不留在旧键里丢失。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "意见跟随", stage: "video", revision: 2, video: { draft: v2 } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "video-new", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    // 先等只存在于更新后的锚点：SSE 监听是异步的，直接等输入框值会被更新前的旧 DOM 空洞满足。
    await screen.findByText("旧版画面不能认可；片段意见会记录到当前稿。");
    expect(screen.getByText(/正在查看 v.*的片段，意见记录到/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("换一个更亮的结尾镜头"));
    expect(screen.getByRole("button", { name: "记录意见" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    const posted = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/feedback"))!.body as { target: unknown };
    expect(posted.target).toEqual({ workId: "work-1", artifactId: "art-video-1", revisionId: "video-rev-2", segment: { runId: "run-1", segmentId: "seg-1" } });
  });

  it("D1 跨产物新稿：未发送的片段意见文字带到新产物的当前稿；提交主目标为新产物、片段为原 run", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video-1", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video-2", revisionId: "video-rev-2", digest: "sha256:v2" };
    const work = workFixture({ id: "work-1", title: "跨产物意见", stage: "video", video: { draft: v1 } });
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
        if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { disposition: "next_version" } };
        return null;
      },
    });
    harness.snapshot.runs.items = [run1];
    renderAt("/agent/conv-w");
    await screen.findByRole("button", { name: /旧版片段/ });
    await userEvent.click(screen.getByRole("button", { name: /旧版片段/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "结尾换一个更亮的镜头");
    // 新制作输出是另一条产物（art-video-2）：同作品同片段的未发送意见仍带到新稿键。
    harness.snapshot.works[0] = workFixture({ id: "work-1", title: "跨产物意见", stage: "video", revision: 2, video: { draft: v2 } });
    harness.snapshot.runs.items = [run1, run2];
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "video-new-artifact", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByText("旧版画面不能认可；片段意见会记录到当前稿。");
    expect(screen.getByText(/正在查看 v.*的片段，意见记录到/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("结尾换一个更亮的镜头"));
    expect(screen.getByRole("button", { name: "记录意见" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    const posted = harness.calls.find(call => call.method === "POST" && call.url.endsWith("/feedback"))!.body as { target: unknown };
    expect(posted.target).toEqual({ workId: "work-1", artifactId: "art-video-2", revisionId: "video-rev-2", segment: { runId: "run-1", segmentId: "seg-1" } });
  });

  it("D1 片段针对按作品/组/事项隔离：切到另一作品不开片段框；回来仍可提交原片段意见", async () => {
    const videoDraft = { kind: "artifact_revision" as const, artifactId: "art-va", revisionId: "va-rev-1", digest: "sha256:va1" };
    const contentDraft = { kind: "artifact_revision" as const, artifactId: "art-cb", revisionId: "cb-rev-1", digest: "sha256:cb1" };
    const a = workFixture({ id: "work-a", title: "视频创作", updatedAt: "2026-01-03T00:00:00.000Z", video: { draft: videoDraft } });
    const b = workFixture({ id: "work-b", title: "图文创作", updatedAt: "2026-01-02T00:00:00.000Z", content: { draft: contentDraft } });
    const runA = runFixture("run-a", "视频制作", "art-va", "va-rev-1", [segmentFixture("seg-1", "开场片段", "clip-a")]);
    const harness = installStageRoutes({
      works: [a, b],
      artifacts: [artifactFixture("art-va", "视频成片", "va-rev-1", 1, "video", "work-a"), artifactFixture("art-cb", "图文稿", "cb-rev-1", 1, "script", "work-b")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/runs/run-a")) return { status: 200, body: runA };
        if (call.method === "GET" && url.endsWith("/artifacts/art-va/revisions/va-rev-1")) return { status: 200, body: videoRevisionFixture("art-va", "va-rev-1", "run-a", "whole-a") };
        if (call.method === "POST" && url.endsWith("/feedback")) return { status: 201, body: { disposition: "noted" } };
        return null;
      },
    });
    harness.snapshot.runs.items = [runA];
    renderAt("/agent/conv-w");
    await screen.findByRole("button", { name: /开场片段/ });
    // A：针对片段提意见并留有未发送文字。
    await userEvent.click(screen.getByRole("button", { name: /开场片段/ }));
    expect(screen.getByText(/针对：片段 1/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "开场太暗");
    // 切到 B：B 的意见框不带 A 的片段针对。
    await switchWork("图文创作");
    await findCanvasText("art-cb 正文 cb-rev-1");
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    expect(screen.queryByText(/针对：片段/)).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "B 的整稿意见");
    // 回到 A：片段针对仍在，文字保留，可直接提交原片段意见。
    await switchWork("视频创作");
    await screen.findByRole("button", { name: /开场片段/ });
    expect(screen.getByText(/针对：片段 1/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("开场太暗");
    await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
    const posted = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/feedback")).at(-1)!.body as { target: unknown };
    expect(posted.target).toEqual({ workId: "work-a", artifactId: "art-va", revisionId: "va-rev-1", segment: { runId: "run-a", segmentId: "seg-1" } });
  });

  it("D2 组在途只禁本组：A 认可在途时 A 的动作禁用、B 照常；完成后恢复", async () => {
    const draftA = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-2", digest: "sha256:a2" };
    const draftB = { kind: "artifact_revision" as const, artifactId: "art-b", revisionId: "art-b-rev-1", digest: "sha256:b1" };
    const a = workFixture({ id: "work-a", title: "事项A", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft: draftA } });
    const b = workFixture({ id: "work-b", title: "事项B", updatedAt: "2026-01-02T00:00:00.000Z", content: { draft: draftB } });
    let release!: (value: RouteResult) => void;
    const gate = new Promise<RouteResult>(resolve => { release = resolve; });
    const harness = installStageRoutes({
      works: [a, b],
      artifacts: [artifactFixture("art-a", "A 内容", "art-a-rev-2", 2), artifactFixture("art-b", "B 内容", "art-b-rev-1", 1)],
      onRequest: (url, call) => {
        if (call.method === "POST" && url.endsWith("/messages")) {
          const body = call.body as { reviewConfirmation?: { workId: string } | null };
          if (body.reviewConfirmation?.workId === "work-a") return gate;
        }
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    // A 在途：A 的单项认可禁用。
    await waitFor(() => expect(screen.getByRole("button", { name: "认可「内容草稿」" })).toBeDisabled());
    // B 不受影响：其单项认可可用并成功提交。
    await switchWork("事项B");
    await findCanvasText("art-b 正文 art-b-rev-1");
    expect(screen.getByRole("button", { name: "认可「内容草稿」" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "认可「内容草稿」" }));
    await waitFor(() => {
      const bCall = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages"))
        .find(call => (call.body as { reviewConfirmation?: { workId: string } }).reviewConfirmation?.workId === "work-b");
      expect(bCall).toBeTruthy();
    });
    release({ status: 202, body: { requestId: "req-a", messageId: "msg-a", state: "completed", replayed: false, runId: null } });
    // A 完成：动作恢复。
    await switchWork("事项A");
    await waitFor(() => expect(screen.getByRole("button", { name: "认可「内容草稿」" })).toBeEnabled());
  });

  it("D3 组指引说明认可后的继续动作，认可本身不自动推进", async () => {
    const nextIntent = "认可后我会准备画面与声音方案";
    const pending = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "rev-1", digest: "sha256:r1" };
    const approved = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "rev-1", digest: "sha256:r1" };
    const base = workFixture({ id: "work-1", title: "指引节奏" });
    const groupOf = (item: typeof pending | null, extra: Partial<ReviewItem> = {}) => [{
      id: "group-content", title: "内容草稿", revision: 1, nextIntent,
      items: [{ id: "item-content", label: "内容草稿", role: "content" as const, required: true,
        draft: item, approved: extra.approved ?? null, finalizedSource: extra.finalizedSource ?? null,
        confirmationId: extra.confirmationId ?? null, approvedAt: extra.approvedAt ?? null }],
    }];
    const harness = installStageRoutes({
      works: [{ ...base, reviewGroups: groupOf(pending) }],
      artifacts: [artifactFixture("art-script", "脚本", "rev-1", 1)],
    });
    renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 rev-1");
    expect(screen.getByText(nextIntent)).toBeInTheDocument();
    // 全部认可后仍说明下一步；等待用户明确继续。
    harness.snapshot.works[0] = { ...base, revision: 2, reviewGroups: groupOf(pending, { approved, approvedAt: "2026-01-02T00:00:00.000Z", confirmationId: "conf-1" }) };
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: "approved", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await screen.findByRole("button", { name: "继续下一步" });
    expect(screen.getByText(nextIntent)).toBeInTheDocument();
  });

  it("D3 视频定稿后指引隐藏并标已定稿；新未认可稿到达后指引恢复", async () => {
    const nextIntent = "定稿后我会整理入库信息";
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-video", revisionId: "video-rev-1", digest: "sha256:v1" };
    const v2 = { kind: "artifact_revision" as const, artifactId: "art-video", revisionId: "video-rev-2", digest: "sha256:v2" };
    const base = workFixture({ id: "work-1", title: "定稿节奏" });
    const videoGroup = (draft: typeof v1 | null, approved: typeof v1 | null, finalizedSource: typeof v1 | null) => [{
      id: "group-video", title: "视频初稿", revision: 1, nextIntent,
      items: [{ id: "item-video", label: "视频初稿", role: "video" as const, required: true,
        draft, approved, finalizedSource, confirmationId: approved ? "conf-v" : null, approvedAt: approved ? "2026-01-02T00:00:00.000Z" : null }],
    }];
    const run1 = runFixture("run-1", "视频制作", "art-video", "video-rev-1", []);
    const run2 = runFixture("run-2", "视频重制", "art-video", "video-rev-2", []);
    const harness = installStageRoutes({
      works: [{ ...base, reviewGroups: videoGroup(v1, v1, v1) }],
      artifacts: [artifactFixture("art-video", "成片", "video-rev-1", 1, "video")],
      onRequest: (url, call) => {
        if (call.method === "GET" && url.endsWith("/runs/run-1")) return { status: 200, body: run1 };
        if (call.method === "GET" && url.endsWith("/runs/run-2")) return { status: 200, body: run2 };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video/revisions/video-rev-1")) return { status: 200, body: videoRevisionFixture("art-video", "video-rev-1", "run-1", "whole-1") };
        if (call.method === "GET" && url.endsWith("/artifacts/art-video/revisions/video-rev-2")) return { status: 200, body: videoRevisionFixture("art-video", "video-rev-2", "run-2", "whole-2") };
        return null;
      },
    });
    renderAt("/agent/conv-w");
    await screen.findByText("已定稿");
    expect(screen.getByText("已定稿并入库")).toBeInTheDocument();
    expect(screen.queryByText(nextIntent)).toBeNull();
    // 定稿后出现新的未认可草稿：指引恢复，状态回到新稿待确认。
    harness.snapshot.works[0] = { ...base, revision: 2, reviewGroups: videoGroup(v2, v1, v1) };
    harness.snapshot.runs.items = [run1, run2];
    // 首屏内容可先于 SSE effect 出现；等订阅建立后再模拟新稿事件。
    const source = await waitFor(() => {
      const current = FakeEventSource.instances.find(item => !item.closed);
      expect(current).toBeDefined();
      return current!;
    });
    source.emit("business", { eventId: "video-v2", kind: "work.changed", entityId: "work-1", entityVersion: 2 });
    await userEvent.click(await screen.findByRole("button", { name: "查看最新稿" }));
    await screen.findByText(nextIntent);
    expect(screen.getByText("新稿待确认")).toBeInTheDocument();
  });

  it("C2 继续按钮随消息带准确 reviewContext：点B继续发B的组；认可命令不带 reviewContext", async () => {
    const source = { kind: "artifact_revision" as const, artifactId: "art-script", revisionId: "rev-1", digest: "sha256:r1" };
    const a = workFixture({ id: "work-a", title: "山路短片", updatedAt: "2026-01-03T00:00:00.000Z", content: { draft: source } });
    const b = workFixture({ id: "work-b", title: "城市动画", updatedAt: "2026-01-02T00:00:00.000Z",
      content: { draft: source, approved: source, approvedAt: "2026-01-02T00:00:00.000Z", confirmationId: "conf-b" } });
    const harness = installStageRoutes({ works: [a, b], artifacts: [artifactFixture("art-script", "脚本", "rev-1", 1)] });
    renderAt("/agent/conv-w");
    await findCanvasText("art-script 正文 rev-1");
    // 双作品同名组：点 B 的继续，消息必须指向 B 的（作品, 组），不靠服务端猜。
    await switchWork("城市动画");
    await screen.findByRole("button", { name: "继续下一步" });
    await userEvent.click(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ }));
    const continued = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect(continued.reviewContext).toEqual({ workId: "work-b", groupId: "group-content", intent: "continue" });
    expect(continued.reviewConfirmation).toBeNull();
    // 认可命令走互斥的另一侧：带确认、不带 reviewContext。
    await switchWork("山路短片");
    await findCanvasText("art-script 正文 rev-1");
    await userEvent.click(screen.getByRole("button", { name: "认可整组" }));
    const confirmed = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/messages")).at(-1)!.body as Record<string, unknown>;
    expect((confirmed.reviewConfirmation as { workId: string }).workId).toBe("work-a");
    expect(confirmed.reviewContext).toBeNull();
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
      id: "proposal-timed", conversationId: "conv-w", digest: "b".repeat(64), revision: 1, state: "ready", acceptedRunId: null, acceptanceBlocker: null,
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
      id: "proposal-e3", conversationId: "conv-w", digest: "c".repeat(64), revision: 1, state: "ready", acceptedRunId: null, acceptanceBlocker: null,
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

  const run = { ...runFixture("mixed-run", "只换音乐", "video", "video-rev-1", []), origin: { kind: "proposal" as const, proposalId: proposal.id }, audioSummary: MUSIC_SOUND_SUMMARY };
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
    expect(await screen.findByText("所属作品：作品 A")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "作品 B" })).toBeNull();
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
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("textbox",{name:"意见"}));
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

  it("Q3 点B的事项产物后刷新，仍在B的双区", async () => {
    const draftA={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    const draftB={kind:"artifact_revision" as const,artifactId:"art-b",revisionId:"art-b-rev-2",digest:"sha256:b2"};
    installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",updatedAt:"2026-01-03T00:00:00.000Z",content:{draft:draftA}}),
      workFixture({id:"work-b",title:"事项B",updatedAt:"2026-01-01T00:00:00.000Z",content:{draft:draftB}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2),artifactFixture("art-b","B 内容","art-b-rev-2",2)]});
    renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-2");
    await switchWork("事项B");
    await findCanvasText("art-b 正文 art-b-rev-2");
    await userEvent.click(screen.getByRole("button",{name:"全部作品 2 件"}));
    await userEvent.click(screen.getByRole("button",{name:"审阅事项B"}));
    await findCanvasText("art-b 正文 art-b-rev-2");
    cleanup();renderAt("/agent/conv-w");
    await findCanvasText("art-b 正文 art-b-rev-2");
    expect(screen.queryByRole("button",{name:"回到创作"})).toBeNull();
    expect(screen.getByRole("region",{name:"创作：事项B"})).toBeInTheDocument();
  });

  it("Q4 旧稿的未发送意见刷新后仍能看见并复制", async () => {
    const draft={kind:"artifact_revision" as const,artifactId:"art-a",revisionId:"art-a-rev-2",digest:"sha256:a2"};
    const harness=installStageRoutes({works:[workFixture({id:"work-a",title:"事项A",content:{draft}})],
      artifacts:[artifactFixture("art-a","A 内容","art-a-rev-2",2)]});
    renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-2");
    await userEvent.click(screen.getByRole("textbox",{name:"意见"}));
    await userEvent.type(screen.getByRole("textbox",{name:"意见"}),"未发送的旧稿意见");
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"事项A",revision:2,content:{draft:{...draft,revisionId:"art-a-rev-3",digest:"sha256:a3"}}});
    FakeEventSource.instances.find(x=>!x.closed)!.emit("business",{eventId:"new-head",kind:"work.changed",entityId:"work-a",entityVersion:2});
    await screen.findByText("正在看旧版本，不能在这里确认；请回到最新稿。");
    cleanup();renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-2");
    const box=screen.queryByRole("textbox",{name:"意见"});
    if(!box){
      const trigger=screen.getByRole("textbox",{name:"意见"});
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
    await findCanvasText("art-a 正文 art-a-rev-2");
    cleanup();
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"事项A",revision:2,content:{draft:{...draft,revisionId:"art-a-rev-3",digest:"sha256:a3"}}});
    renderAt("/agent/conv-w");
    await waitFor(()=>expect(canvas().queryByText("art-a 正文 art-a-rev-2")).toBeInTheDocument());
  });
});


describe("草稿成为成果", () => {
  it("未确认的脚本只在草稿区；确认后的准确版本进入成果区，新草稿不替换成果", async () => {
    const v1 = { kind: "artifact_revision" as const, artifactId: "art-a", revisionId: "art-a-rev-1", digest: "sha256:a1" };
    const harness = installStageRoutes({works:[workFixture({id:"work-a",title:"城市短片",content:{draft:v1}})],
      artifacts:[artifactFixture("art-a","脚本",v1.revisionId,1)]});
    renderAt("/agent/conv-w");
    await findCanvasText("art-a 正文 art-a-rev-1");
    expect(within(screen.getByRole("region",{name:"已确认成果"})).queryByText("art-a 正文 art-a-rev-1")).toBeNull();
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"城市短片",revision:2,content:{draft:v1,approved:v1,confirmationId:"conf-1"}});
    FakeEventSource.instances.find(x=>!x.closed)!.emit("business",{eventId:"approve",kind:"work.changed",entityId:"work-a",entityVersion:2});
    await waitFor(()=>expect(within(screen.getByRole("region",{name:"已确认成果"})).getByText("art-a 正文 art-a-rev-1")).toBeInTheDocument());
    const v2={...v1,revisionId:"art-a-rev-2",digest:"sha256:a2"};
    harness.snapshot.works[0]=workFixture({id:"work-a",title:"城市短片",revision:3,content:{draft:v2,approved:v1,confirmationId:"conf-1"}});
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

it("PC 时间点意见绑定当前准确视频，记录意见不会自动定稿", async () => {
  const video = { kind: "artifact_revision" as const, artifactId: "timed-video", revisionId: "timed-rev-1", digest: "timed" };
  const harness = installStageRoutes({ works: [workFixture({ id: "timed-work", title: "审片意见", stage: "video", video: { draft: video } })],
    onRequest: (url, call) => call.method === "POST" && url.endsWith("/feedback") ? { status: 201, body: { messageId: "feedback-time", disposition: "recorded", replayed: false } }
      : url.endsWith("/revisions/timed-rev-1") ? { status: 200, body: { ...revisionFixture(video.artifactId, video.revisionId, 1, ""),
      content: { format: "media", blobId: "timed-blob", mimeType: "video/mp4", durationMs: 90000 } } } : null });
  renderAt("/agent/conv-w");
  const player = await screen.findByLabelText<HTMLVideoElement>("视频预览");
  act(() => { player.currentTime = 65.2; player.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await userEvent.click(screen.getByRole("button", { name: "对此时刻提意见" }));
  expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("[01:05] ");
  await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "转场慢一点");
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
  await screen.findByText("意见已记录。");
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(harness.calls.find(call => call.url.endsWith("/feedback"))?.body).toMatchObject({ text: "[01:05] 转场慢一点", target: { artifactId: video.artifactId, revisionId: video.revisionId, workId: "timed-work" } });
});

it("Oracle P1-01 已认可视频的历史阅读经过总览和刷新仍可回到准确最新稿定稿", async () => {
  const source = { kind: "artifact_revision" as const, artifactId: "movie", revisionId: "movie-rev-3", digest: "v3" };
  installStageRoutes({ works: [workFixture({ id: "history-work", title: "历史审片", video: { draft: source, approved: source } })] });
  let ui = renderAt("/agent/conv-w");
  await userEvent.click(await screen.findByRole("button", { name: "审阅已确认视频初稿" }));
  await userEvent.click(await screen.findByRole("button", { name: "看上一版" }));
  await within(screen.getByRole("region", { name: "草稿与修改" })).findByText("movie 正文 movie-rev-2");
  await userEvent.click(screen.getByRole("button", { name: "全部作品 1 件" }));
  await userEvent.click(screen.getByRole("button", { name: "审阅历史审片" }));
  expect(screen.getByRole("button", { name: "查看最新稿" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "以这版「视频初稿」定稿并入库" })).toBeDisabled();
  ui.unmount(); ui = renderAt("/agent/conv-w");
  await screen.findByRole("button", { name: "查看最新稿" });
  await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "以这版「视频初稿」定稿并入库" })).toBeEnabled());
  expect(within(screen.getByRole("region", { name: "已确认成果" })).getByText("movie 正文 movie-rev-3")).toBeVisible();
});

it("Oracle P1-01 混合组第四项已确认视频可精确打开并定稿，未读取前不发送", async () => {
  const work = workFixture({ id: "mixed", title: "混合交付", content: {} });
  work.reviewGroups[0]!.items = Array.from({ length: 4 }, (_, index) => {
    const source = { kind: "artifact_revision" as const, artifactId: `mix-${index}`, revisionId: `mix-${index}-rev-1`, digest: `v${index}` };
    return { id: `mix-item-${index}`, label: index === 3 ? "第四项视频" : `文字${index}`, role: index === 3 ? "video" as const : "content" as const,
      required: true, draft: source, approved: source, finalizedSource: null, approvedAt: "2026-01-01T00:00:00Z", confirmationId: `confirm-${index}` };
  });
  const harness = installStageRoutes({ works: [work] });
  renderAt("/agent/conv-w");
  await userEvent.click(await screen.findByRole("button", { name: "审阅已确认第四项视频" }));
  const finalize = await screen.findByRole("button", { name: "以这版「第四项视频」定稿并入库" });
  await waitFor(() => expect(finalize).toBeEnabled());
  await waitFor(() => expect(document.getElementById("review-item-mixed-group-content-mix-item-3")).toHaveFocus());
  await userEvent.click(finalize);
  const command = harness.calls.find(call => call.method === "POST")!.body as MessageInput;
  expect(command.reviewConfirmation).toMatchObject({ workId: "mixed", groupId: "group-content", action: "finalize_video", items: [{ itemId: "mix-item-3", source: { artifactId: "mix-3", revisionId: "mix-3-rev-1" } }] });
});

it("Oracle P2-02 隐藏详情不读取新增事项或提前固定版本，重新打开使用最新稿", async () => {
  const harness = installStageRoutes({ works: [workFixture({ id: "hidden-a", title: "作品甲", content: {} }), workFixture({ id: "shown-b", title: "作品乙", content: {} })] });
  renderAt("/agent/conv-w");
  await screen.findByRole("heading", { name: "作品甲" });
  await userEvent.click(screen.getByRole("button", { name: "全部作品 2 件" }));
  await userEvent.type(screen.getByRole("textbox", { name: "搜索作品和交付内容" }), "作品乙");
  const update = (version: number) => {
    harness.snapshot.works[0] = workFixture({ id: "hidden-a", title: "作品甲", revision: version + 1, content: { draft: {
      kind: "artifact_revision", artifactId: "unseen", revisionId: `unseen-rev-${version}`, digest: `v${version}` } } });
    FakeEventSource.instances.find(source => !source.closed)!.emit("business", { eventId: `hidden-${version}`, kind: "work.changed", entityId: "hidden-a", entityVersion: version + 1 });
  };
  update(1);
  await waitFor(() => expect(harness.calls.some(call => call.url.endsWith("/works/hidden-a"))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  update(2);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
  expect(harness.calls.some(call => call.url.includes("/revisions/unseen-rev-"))).toBe(false);
  await userEvent.clear(screen.getByRole("textbox", { name: "搜索作品和交付内容" }));
  await userEvent.click(screen.getByRole("button", { name: "审阅作品甲" }));
  expect(await findCanvasText("unseen 正文 unseen-rev-2")).toBeVisible();
  expect(harness.calls.some(call => call.url.endsWith("/revisions/unseen-rev-1"))).toBe(false);
});

it("Oracle 隐藏审片暂停播放，保留播放位置及稿旁意见", async () => {
  const source = { kind: "artifact_revision" as const, artifactId: "pause-video", revisionId: "pause-rev-1", digest: "v1" };
  installStageRoutes({ works: [workFixture({ id: "pause-work", title: "暂停审片", video: { draft: source } })], onRequest: url => url.endsWith("/revisions/pause-rev-1")
    ? { status: 200, body: { ...revisionFixture(source.artifactId, source.revisionId, 1, ""), content: { format: "media", blobId: "pause-blob", mimeType: "video/mp4", durationMs: 90000 } } } : null });
  renderAt("/agent/conv-w");
  const player = await screen.findByLabelText<HTMLVideoElement>("视频预览");
  let playing = true;
  Object.defineProperty(player, "paused", { configurable: true, get: () => !playing });
  vi.spyOn(player, "pause").mockImplementation(() => { playing = false; });
  player.currentTime = 12;
  await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
  await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "保持这条草稿");
  await userEvent.click(screen.getByRole("button", { name: "全部作品 1 件" }));
  expect(player.paused).toBe(true); expect(player.isConnected).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "审阅暂停审片" }));
  expect(player.currentTime).toBe(12); expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("保持这条草稿");
  playing = true;
  await userEvent.click(screen.getByRole("button", { name: "打开模型配置" }));
  expect(player.paused).toBe(true);
});

it.each([true, false])("Oracle P1-03 片段意见完整恢复并沿用丢失响应的命令（先写文字=%s）", async textFirst => {
  const source = { kind: "artifact_revision" as const, artifactId: "feedback-video", revisionId: "feedback-rev-1", digest: "v1" };
  const run = runFixture("feedback-run", "片段制作", source.artifactId, source.revisionId, [segmentFixture("segment-one", "开场片段", "clip-feedback")]);
  let loseResponse = true;
  const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "意见恢复", video: { draft: source } })], onRequest: (url, call) => {
    if (url.endsWith(`/revisions/${source.revisionId}`)) return { status: 200, body: videoRevisionFixture(source.artifactId, source.revisionId, run.id, "video-feedback") };
    if (call.method === "POST" && url.endsWith("/feedback")) {
      if (loseResponse) { loseResponse = false; throw new TypeError("accepted, response lost"); }
      return { status: 201, body: { messageId: "feedback-receipt", disposition: "recorded", replayed: true } };
    }
    return null;
  } });
  harness.snapshot.runs.items = [run];
  let ui = renderAt("/agent/conv-w");
  await screen.findByRole("button", { name: /开场片段/ });
  if (textFirst) {
    await userEvent.click(screen.getByRole("textbox", { name: "意见" }));
    await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "开场留白再长一点");
  }
  await userEvent.click(screen.getByRole("button", { name: /开场片段/ }));
  if (!textFirst) await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "开场留白再长一点");
  ui.unmount(); ui = renderAt("/agent/conv-w");
  await userEvent.click(await screen.findByRole("textbox", { name: "意见" }));
  expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("开场留白再长一点");
  expect(screen.getByRole("button", { name: "取消针对该片段" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "记录意见" }));
  await screen.findByText("意见已记录。");
  const posts = harness.calls.filter(call => call.method === "POST" && call.url.endsWith("/feedback"));
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
  expect(posts[0]!.body).toMatchObject({ text: "开场留白再长一点", target: { artifactId: source.artifactId, revisionId: source.revisionId, workId: "work-1", segment: { runId: run.id, segmentId: "segment-one" } } });
});

it("Oracle P2-06 当前修订读取失败时单项认可和混合组定稿都不可用", async () => {
  const work = workFixture({ id: "guard-work", title: "读取守卫", content: {} });
  work.reviewGroups[0]!.items = ["content", "video"].map((role, index) => ({ id: `guard-${index}`, label: `待审${index}`, role: role as "content" | "video", required: true,
    draft: { kind: "artifact_revision", artifactId: `guard-art-${index}`, revisionId: `guard-rev-${index}`, digest: "v1" }, approved: null, finalizedSource: null, confirmationId: null, approvedAt: null }));
  let fail = true;
  const harness = installStageRoutes({ works: [work], onRequest: url => fail && url.includes("/revisions/guard-rev-") ? { status: 503, body: { code: "UNAVAILABLE", message: "读取失败" } } : null });
  renderAt("/agent/conv-w");
  await screen.findAllByText("草稿读取失败。");
  const approve = screen.getByRole("button", { name: "认可「待审0」" });
  expect(approve).toBeDisabled();
  await userEvent.click(approve);
  await userEvent.click(screen.getByRole("button", { name: "审阅待审1" }));
  await screen.findByText("草稿读取失败。");
  const finalize = screen.getByRole("button", { name: "以这版「待审1」定稿并入库" });
  expect(finalize).toBeDisabled();
  await userEvent.click(finalize);
  expect(harness.calls.some(call => call.method === "POST")).toBe(false);
  fail = false;
  for (const retry of screen.getAllByRole("button", { name: "重试读取草稿" })) await userEvent.click(retry);
  await waitFor(() => expect(finalize).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "审阅待审0" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "认可「待审0」" })).toBeEnabled());
});

it.each(["completed", "failed", "stopped"] as const)("Oracle P1-02 历史消息窗口的继续在 %s 后解除忙态，不移动阅读窗口", async state => {
  const source = { kind: "message_text" as const, messageId: "anchor", text: "已确认的文案", author: "assistant" as const };
  const anchor = messageFixture({ id: "anchor", role: "assistant", text: "这是历史阅读位置", createdSequence: 1 });
  const continuing = messageFixture({ id: "later-request", role: "user", requestId: "later", text: "窗口之后的继续请求", state: "queued", createdSequence: 2,
    reviewContext: { workId: "anchor-work", groupId: "group-content", intent: "continue" } });
  const harness = installStageRoutes({ works: [workFixture({ id: "anchor-work", title: "窗口中的作品", content: { draft: source, approved: source } })], messages: [anchor], onRequest: (url, call) => {
    if (url.includes("anchorMessageId=")) return { status: 200, body: { items: [anchor], nextCursor: null, watermark: "anchor" } };
    if (url.endsWith("/messages/later-request")) return { status: 200, body: continuing };
    if (call.method === "POST" && url.endsWith("/messages")) {
      harness.snapshot.messages.items = [anchor, continuing]; harness.snapshot.activeRequestId = "later";
      return { status: 202, body: { requestId: "later", messageId: "later-request", state: "queued", replayed: false, runId: null } };
    }
    return null;
  } });
  renderAt("/agent/conv-w?anchor=anchor");
  await userEvent.click(await screen.findByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ })).toBeDisabled());
  continuing.state = state; continuing.revision = 2; harness.snapshot.activeRequestId = null;
  FakeEventSource.instances.find(item => !item.closed)!.emit("business", { eventId: `finish-${state}`, kind: "message.changed", entityId: continuing.id, entityVersion: 2 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^(继续下一步|已排队|继续处理中)$/ })).toBeEnabled());
  expect(screen.getByText("这是历史阅读位置")).toBeVisible();
  expect(screen.queryByText("窗口之后的继续请求")).toBeNull();
  expect(screen.getByRole("button", { name: "回到最新消息" })).toBeVisible();
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

it("Oracle P1-04 未定位的历史视频保持只读，不挂到最后一个视频事项", async () => {
  const work = workFixture({ id: "work-1", title: "多视频事项", video: { draft: { kind: "artifact_revision", artifactId: "current-one", revisionId: "current-one-rev-1", digest: "v1" } } });
  work.reviewGroups.push({ id: "second-group", title: "另一个视频", revision: 1, nextIntent: null, items: [{ ...work.reviewGroups[0]!.items[0]!, id: "second-video", label: "另一视频事项",
    draft: { kind: "artifact_revision", artifactId: "current-two", revisionId: "current-two-rev-1", digest: "v1" } }] });
  const harness = installStageRoutes({ works: [work], artifacts: [artifactFixture("orphan-video", "历史输出", "orphan-video-rev-1", 1, "video", "work-1")], messages: [messageFixture({ id: "old-output", role: "assistant", text: "早先的第一项视频", references: { artifacts: [{ artifactId: "orphan-video", revisionId: "orphan-video-rev-1" }], proposalIds: [], runIds: [], materialBatchIds: [] } })] });
  renderAt("/agent/conv-w");
  const row = (await screen.findByText("早先的第一项视频")).closest("[data-message-id]") as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: /历史输出/ }));
  expect(await screen.findByText("未能唯一定位这版视频的审阅事项，当前仅供查看。请从作品中选择要讨论的事项。")).toBeVisible();
  expect(screen.queryByRole("button", { name: /定稿并入库/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "只记录意见" })).toBeNull();
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

it("Oracle P2-04 刷新恢复旧制作记录可重试，离开后迟到响应不抢回视图", async () => {
  const run = runFixture("old-audit-run", "以前的制作", "old-audit-video", "old-audit-video-rev-1", []);
  let fail = true, delay = false, resolve!: (value: RouteResult) => void;
  installStageRoutes({ works: [workFixture({ id: "work-1", title: "当前作品", content: {} })], onRequest: url => {
    if (url.endsWith(`/runs/${run.id}`)) return fail ? { status: 503, body: { code: "UNAVAILABLE", message: "暂时读不到" } }
      : delay ? new Promise<RouteResult>(done => { resolve = done; }) : { status: 200, body: run };
    if (url.endsWith(`/proposals/proposal-${run.id}`)) return { status: 200, body: proposalFixture(`proposal-${run.id}`, "以前的提案", "work-1") };
    return null;
  } });
  const restore = () => saveReadingView("conv-w", { entry: "run", workId: "work-1", runId: run.id, artifactId: null, revisionId: null, batchId: null });
  restore(); let ui = renderAt("/agent/conv-w");
  const retry = await screen.findByRole("button", { name: "重试读取制作记录" }); fail = false;
  await userEvent.click(retry);
  await screen.findByText("以前的制作");
  ui.unmount(); delay = true; restore(); ui = renderAt("/agent/conv-w");
  await screen.findByText("正在恢复制作记录…");
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await userEvent.click(screen.getByRole("button", { name: "回到作品" }));
  await act(async () => resolve({ status: 200, body: run }));
  expect(screen.queryByRole("heading", { name: "制作记录" })).toBeNull();
  expect(screen.getByRole("heading", { name: "当前作品" })).toBeVisible();
});

it("Oracle P2-05 作品中心可直接打开旧提案并翻页，不依赖历史聊天引用", async () => {
  const source = { kind: "artifact_revision" as const, artifactId: "bound-script", revisionId: "bound-script-rev-1", digest: "v1" };
  const harness = installStageRoutes({ works: [workFixture({ id: "work-1", title: "作品", content: { draft: source } })], artifacts: [artifactFixture(source.artifactId, "绑定文稿", source.revisionId, 1)],
    proposals: [proposalFixture("old-proposal-1", "第一份制作提案", "work-1")], onRequest: url => url.includes("/proposals?cursor=")
      ? { status: 200, body: { items: [proposalFixture("old-proposal-2", "第二份制作提案", "work-1")], nextCursor: null, watermark: "p2" } } : null });
  harness.snapshot.proposals.nextCursor = "next-proposal";
  renderAt("/agent/conv-w");
  await userEvent.click(await screen.findByText("制作提案 · 1"));
  expect(await screen.findByText("第一份制作提案")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "更多提案" }));
  expect(await screen.findByText("第二份制作提案")).toBeVisible();
  expect(harness.calls.some(call => call.method === "POST")).toBe(false);
});

it("F2 作品库显示服务端提供的冻结旁白，历史方案不替代它并返回各自原消息", async () => {
  const lines = ["雨停之前，先喝一杯咖啡。", "窗外下雨，杯里回暖。"];
  const entries: LibraryVideo[] = ["初版", "换词版"].map((label, index) => ({
    video: { artifactId: `video-${index}`, revisionId: `video-rev-${index}` }, workId: "work-1", conversationId: "conv-w",
    title: `雨窗${label}`, finalizedAt: "2026-01-01T00:00:00.000Z", plan: { artifactId: "plan", revisionId: "plan-rev-2" },
    content: null, originMessageId: `origin-${index}`, narrationText: lines[index]!,
    project: null, projectFiles: [], materials: [], reviewSources: [], provenanceStatus: "not_recorded",
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
    if (index === 0) await userEvent.click(screen.getByRole("button", { name: "打开作品库" }));
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(entries[index]!.title) }));
    await screen.findByLabelText("定稿视频");
    await userEvent.click(screen.getByText("采用的画面与声音方案"));
    const actual = (await screen.findByText("本次制作旁白")).parentElement!;
    expect(within(actual).getByText(lines[index]!)).toBeInTheDocument();
    expect(within(actual).queryByText(lines[1 - index]!)).toBeNull();
    expect(screen.getByText(`旧方案记录：${lines[0]}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回到来源对话" }));
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
    project: null, projectFiles: [], materials: [], reviewSources: [], provenanceStatus: "not_recorded",
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
  await userEvent.click(screen.getByRole("button", { name: "回到来源对话" }));
  expect(await screen.findByText("这份混音初稿的原消息。")).toBeInTheDocument();
  expect(harness.calls.some(call => call.url.endsWith("/artifacts/plan/revisions/plan-frozen-r2"))).toBe(true);
  expect(harness.calls.filter(call => /\/(runs|proposals)\//.test(call.url))).toHaveLength(0);
});

it("F2 作品库未知音频不从旧方案猜测实际旁白", async () => {
  const entry: LibraryVideo = { video: { artifactId: "video", revisionId: "video-rev-1" }, workId: "work-1", conversationId: "conv-w",
    title: "现成音频成片", finalizedAt: "2026-01-01T00:00:00.000Z", plan: { artifactId: "plan", revisionId: "plan-rev-1" }, content: null, originMessageId: null, narrationText: null,
    project: null, projectFiles: [], materials: [], reviewSources: [], provenanceStatus: "not_recorded" };
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

it("稳定画布：双击认可只记录一次，保留播放器与意见，之后才明确继续", async () => {
  const source: ContentSource = { kind: "artifact_revision", artifactId: "stable-video", revisionId: "stable-v3", digest: "v3" };
  const work = workFixture({ id: "stable-work", title: "稳定审片", stage: "video", video: { draft: source } });
  const harness = installStageRoutes({ works: [work, workFixture({ id: "other-stable-work", title: "另一件作品" })], onRequest: (url, call) => {
    if (url.endsWith("/revisions/stable-v3")) return { status: 200, body: { ...videoRevisionFixture("stable-video", "stable-v3", "unused-run", "stable-file"), runId: null } };
    if (call.method === "POST" && url.endsWith("/messages") && (call.body as MessageInput).reviewConfirmation) {
      harness.snapshot.works[0] = { ...work, revision: 2, reviewGroups: work.reviewGroups.map(group => ({ ...group, items: group.items.map(item => ({ ...item, approved: item.draft, confirmationId: "stable-approved" })) })) };
    }
    return null;
  } });
  renderAt("/agent/conv-w");
  const video = await within(await screen.findByRole("region", { name: "草稿与修改" })).findByLabelText("视频预览") as HTMLVideoElement;
  video.currentTime = 1.25;
  await userEvent.type(screen.getByRole("textbox", { name: "意见" }), "这句留着，稍后再讨论");
  await userEvent.dblClick(screen.getByRole("button", { name: "认可「视频初稿」" }));
  const next = await screen.findByRole("button", { name: "继续下一步" });
  await waitFor(() => expect(next).toBeEnabled());
  expect(canvas().getByLabelText("视频预览")).toBe(video);
  expect(video.currentTime).toBe(1.25);
  expect(screen.getByRole("textbox", { name: "意见" })).toHaveValue("这句留着，稍后再讨论");
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "未确认" })).getByText("暂无待确认内容")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "已确认成果" })).getByRole("button", { name: "审阅已确认视频初稿" })).toBeVisible();
  await userEvent.click(next);
  const commands = harness.calls.filter(call => call.method === "POST").map(call => call.body as MessageInput);
  expect(commands).toHaveLength(2);
  expect(commands[1]!.reviewConfirmation).toBeNull();
  expect(commands[1]!.reviewContext).toEqual({ workId: work.id, groupId: "group-video", intent: "continue" });
  expect(commands[1]!.text).not.toContain("这句留着");
  fireEvent.timeUpdate(video);
  await switchWork("另一件作品");
  await switchWork("稳定审片");
  const returned = await canvas().findByLabelText("视频预览") as HTMLVideoElement;
  Object.defineProperty(returned, "duration", { value: 3, configurable: true });
  fireEvent.loadedMetadata(returned);
  expect(returned.currentTime).toBe(1.25);
});

it("此前认可的聊天原文按准确来源打开，刷新仍保留旧版且不会认可当前新稿", async () => {
  const current: ContentSource = { kind: "message_text", messageId: "current-source", text: "目前的第三版原文", author: "assistant" };
  const prior: ContentSource = { kind: "message_text", messageId: "prior-source", text: "此前实际认可的原文", author: "user" };
  const work = workFixture({ id: "history-work", title: "原文审阅", content: { draft: current, approved: current, confirmationId: "current-approved" } });
  const harness = installStageRoutes({ works: [work], onRequest: (url, call) => call.method === "GET" && url.endsWith("/approvals") ? { status: 200, body: { items: [
    { confirmationId: "current-approved", source: current, revisionNumber: null, action: "approve", approvedAt: "2026-11-17T00:00:00.000Z" },
    { confirmationId: "prior-approved", source: prior, revisionNumber: null, action: "approve", approvedAt: "2026-11-16T00:00:00.000Z" },
  ], nextCursor: null } } : null });
  const first = renderAt("/agent/conv-w");
  await findCanvasText(current.text);
  await userEvent.click(screen.getByText("此前认可记录"));
  await userEvent.click(await screen.findByRole("button", { name: /此前认可 聊天原文/ }));
  expect(await findCanvasText(prior.text)).toBeVisible();
  expect(canvas().queryByText(current.text)).toBeNull();
  expect(screen.queryByRole("button", { name: "认可「内容草稿」" })).toBeNull();
  first.unmount(); renderAt("/agent/conv-w");
  expect(await findCanvasText(prior.text)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "查看最新稿" }));
  expect(await findCanvasText(current.text)).toBeVisible();
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

it("同版本的较早认可保留；历史上一版始终沿所读产物读取", async () => {
  const current: ContentSource = { kind: "artifact_revision", artifactId: "new-video", revisionId: "new-video-rev-2", digest: "new-v2" };
  const prior: ContentSource = { kind: "artifact_revision", artifactId: "old-video", revisionId: "old-video-rev-2", digest: "old-v2" };
  const work = workFixture({ id: "history-video", title: "跨产物历史", stage: "video", video: { draft: current, approved: current, finalizedSource: current, confirmationId: "finalized-current" } });
  const harness = installStageRoutes({ works: [work], onRequest: (url, call) => call.method === "GET" && url.endsWith("/approvals") ? { status: 200, body: { items: [
    { confirmationId: "finalized-current", source: current, revisionNumber: 2, action: "finalize_video", approvedAt: "2026-11-17T00:00:00.000Z" },
    { confirmationId: "approved-current", source: current, revisionNumber: 2, action: "approve", approvedAt: "2026-11-16T00:00:00.000Z" },
    { confirmationId: "approved-prior", source: prior, revisionNumber: 2, action: "approve", approvedAt: "2026-11-15T00:00:00.000Z" },
  ], nextCursor: null } } : null });
  renderAt("/agent/conv-w");
  await findCanvasText("new-video 正文 new-video-rev-2");
  await userEvent.click(screen.getByText("此前认可记录"));
  const entries = await screen.findAllByRole("button", { name: /此前认可 v2/ });
  expect(entries).toHaveLength(2);
  await userEvent.click(entries[1]!);
  await findCanvasText("old-video 正文 old-video-rev-2");
  await userEvent.click(screen.getByRole("button", { name: "看上一版" }));
  await findCanvasText("old-video 正文 old-video-rev-1");
  expect(harness.calls.some(call => call.url.endsWith("/artifacts/new-video/revisions/old-video-rev-1"))).toBe(false);
});

it("双击认可不会跨到另一个待审事项，须单独点击审阅下一项", async () => {
  const source: ContentSource = { kind: "message_text", messageId: "first-item", text: "先查看这一项", author: "assistant" };
  const work = workFixture({ id: "two-items", title: "两个事项", content: { draft: source } });
  const item = work.reviewGroups[0]!.items[0]!;
  work.reviewGroups[0]!.items.push({ ...item, id: "second-item", label: "第二项", draft: { ...source, messageId: "second-source", text: "需要单独查看的另一项" } });
  const harness = installStageRoutes({ works: [work], onRequest: (url, call) => {
    if (call.method === "POST" && url.endsWith("/messages")) harness.snapshot.works[0] = { ...work, revision: 2, reviewGroups: [{ ...work.reviewGroups[0]!, items: [{ ...item, approved: source }, work.reviewGroups[0]!.items[1]!] }] };
    return null;
  } });
  renderAt("/agent/conv-w");
  await findCanvasText(source.text);
  await userEvent.dblClick(screen.getByRole("button", { name: "认可「内容草稿」" }));
  const next = await screen.findByRole("button", { name: "审阅下一项" });
  await waitFor(() => expect(next).toBeEnabled());
  expect(canvas().getByText(source.text)).toBeVisible();
  expect(harness.calls.filter(call => call.method === "POST")).toHaveLength(1);
  await userEvent.click(next);
  expect(await findCanvasText("需要单独查看的另一项")).toBeVisible();
});
