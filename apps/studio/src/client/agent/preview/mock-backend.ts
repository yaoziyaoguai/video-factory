import { candidates, initialSkills } from "./preview-content.js";
import type {
  ArtifactHead, ArtifactRevision, AvailableProviderModels, Bootstrap, BusinessEvent, Conversation, ConversationPage, FeedbackReceipt, LibraryVideo,
  MaterialBatch, MaterialBatchIndexItem, Message, MessageInput, MessagePage, Proposal, RequestProgress, RequestReceipt, Run,
  SaveFreeServiceSettingsReceipt, SaveProviderConnectionReceipt, SaveUserProfile, SaveUserProfileReceipt, SkillPackagesView, Snapshot, TextDelta,
  UserProfile, Work,
} from "../../../shared/agent/generated/contracts.js";
import type { FreeServiceId, FreeServiceSettings, SaveFreeServiceSettingsInput } from "../api.js";

// 预览页的内存 Mock 后端：接管真实工作台的 fetch 与 EventSource，播放固定剧本。
// 组件、状态合并与交互全部走生产代码，只有 API 边界是假的（审计第三阶段：合并重复前端原型）。
// 媒体字节不经 fetch（<video>/<img> 直连 /api/agent/v1/blobs/*），由 vite.config.ts 的
// 预览中间件按固定 blobId 提供文件；文本工程文件在本路由内直接返回字符串。

const NOW = "2026-11-21T09:30:00.000Z";
const binding = (modelId: string) => ({ providerId: "pi-faux", modelId, connectionId: "conn-faux", configurationRevisionId: "cfg-faux" });

const BOOTSTRAP: Bootstrap = {
  ownerId: "preview-owner",
  displayName: "预览用户",
  models: [
    { binding: binding("faux-text-1"), name: "本地离线模型（Faux）", kind: "text", features: [], availability: "configured",
      verificationNote: "预览剧本：响应来自固定脚本，不产生真实模型调用。", isDefault: true },
    { binding: binding("faux-video-1"), name: "模拟视频模型（Faux）", kind: "video", features: ["模拟媒体"], availability: "configured",
      verificationNote: "预览剧本：制作结果来自示例素材。", isDefault: true },
    { binding: binding("faux-speech-1"), name: "模拟配音模型（Faux）", kind: "speech", features: ["模拟媒体"], availability: "configured",
      verificationNote: "预览剧本：配音来自示例音频。", isDefault: false },
  ],
  skills: initialSkills.map(skill => ({ id: `skill-${skill.id}`, name: skill.name, description: skill.description })),
};

interface MockState {
  conversation: Conversation;
  messages: Message[];
  artifacts: ArtifactHead[];
  works: Work[];
  runs: Run[];
  proposals: Proposal[];
  materialBatches: MaterialBatchIndexItem[];
  activeRequestId: string | null;
}
const states = new Map<string, MockState>();
const revisions = new Map<string, ArtifactRevision>();
const materialBatchBodies = new Map<string, MaterialBatch>();
const blobTexts = new Map<string, string>([
  ["preview-blob-project", "// 预览工程文件：真实工作台按原字节读回渲染。\nconsole.log(\"frame preview\");\n"],
]);
let eventSequence = 0;
let commandSequence = 0;
let createdSequence = 40;

const nextId = (prefix: string): string => `${prefix}-${++commandSequence}`;
const message = (options: Partial<Message> & Pick<Message, "id" | "role" | "text">): Message => ({
  requestId: null, state: "completed", revision: 1, target: null, createdAt: NOW, createdSequence: ++createdSequence,
  references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] }, kind: "chat", feedback: null,
  librarySelections: [], ...options,
});
const registerRevision = (artifactId: string, revisionId: string, revisionNumber: number, content: ArtifactRevision["content"]): void => {
  revisions.set(`${artifactId}:${revisionId}`, {
    artifactId, revisionId, revisionNumber, baseRevisionId: null, requestId: "req-seed", runId: null,
    digest: `sha256:${revisionId}${"0".repeat(Math.max(0, 56 - revisionId.length))}`.slice(0, 71), content, createdAt: NOW,
  });
};

// —— 种子会话：山路短片走完整制作链（脚本 → 审阅 → 成片），咖啡只到脚本。 ——
function seedStates(): void {
  registerRevision("art-trail-script", "rev-trail-script-1", 1, {
    format: "markdown",
    text: "# 沿山径出发\n\n**镜头一** 晨光从山脊后面漫上来，小径先亮起来。\n\n**镜头二** 走进树林，脚步声和鸟鸣叠在一起，风把光斑吹得晃动。\n\n**旁白**\n> 不必赶路。山把风景留给走得慢的人。",
  });
  registerRevision("art-trail-video", "rev-trail-video-1", 1, {
    format: "media", blobId: "preview-blob-trail-video", mimeType: "video/mp4", durationMs: 18_000,
    sources: [{ provider: "pexels", assetId: "trail-ridge", title: "沿山径出发", sourceUrl: "https://www.pexels.com/video/trail-ridge/", creatorName: "预览素材作者", creatorUrl: null, licenseUrl: "https://www.pexels.com/license/", acquiredAt: NOW }],
  });
  registerRevision("art-trail-voice", "rev-trail-voice-1", 1, {
    format: "media", blobId: "preview-blob-trail-voice", mimeType: "audio/mpeg", durationMs: 17_200,
  });
  const scriptSource = { kind: "artifact_revision" as const, artifactId: "art-trail-script", revisionId: "rev-trail-script-1", digest: `sha256:rev-trail-script-1${"0".repeat(42)}` };
  states.set("conv-trail", {
    conversation: { id: "conv-trail", title: "山径慢走短片", revision: 3, updatedAt: NOW },
    messages: [
      message({ id: "msg-trail-1", role: "user", text: "帮我做一条 18 秒的山径短片，节奏慢一点，旁白从感受出发。" }),
      message({ id: "msg-trail-2", role: "assistant", text: "第一版脚本和成片都准备好了：三个镜头从山脊到树林再到停留，配音用低一点的声音。可以直接在预览里看效果，有想调整的地方随时说。",
        references: { artifacts: [{ artifactId: "art-trail-script", revisionId: "rev-trail-script-1" }, { artifactId: "art-trail-video", revisionId: "rev-trail-video-1" }], proposalIds: [], runIds: ["run-trail-1"], materialBatchIds: ["batch-trail-1"] } }),
    ],
    artifacts: [
      { id: "art-trail-script", title: "山径脚本 v1", kind: "script", revisionId: "rev-trail-script-1", revisionNumber: 1, workId: "work-trail", updatedAt: NOW },
      { id: "art-trail-video", title: "山径成片 v1", kind: "video", revisionId: "rev-trail-video-1", revisionNumber: 1, workId: "work-trail", updatedAt: NOW },
    ],
    works: [{
      id: "work-trail", title: "山径慢走短片", revision: 2, createdAt: NOW, updatedAt: NOW,
      reviewGroups: [{
        id: "group-trail-content", title: "内容草稿", revision: 1, nextIntent: null,
        items: [{ id: "item-trail-script", label: "脚本", role: "content", required: true, draft: scriptSource, approved: scriptSource, finalizedSource: scriptSource, confirmationId: "confirm-trail-script", approvedAt: NOW }],
      }],
    }],
    runs: [{
      id: "run-trail-1", conversationId: "conv-trail", workId: "work-trail", snapshotId: "snap-trail-1", revision: 2, state: "succeeded",
      finance: { state: "settled", currency: "CNY", reservedMinor: 0, pendingUnknownMinor: 0, settledMinor: 0, priceKind: "bounded" },
      inputRevisions: [{ artifactId: "art-trail-script", revisionId: "rev-trail-script-1" }],
      outputRevisions: [{ artifactId: "art-trail-video", revisionId: "rev-trail-video-1" }, { artifactId: "art-trail-voice", revisionId: "rev-trail-voice-1" }],
      operations: [{ operationId: "op-trail-video", kind: "video", state: "succeeded", media: null }], segments: [],
      createdAt: NOW, updatedAt: NOW, issue: null, title: "山径慢走短片", origin: { kind: "local_request", requestId: "req-trail-1" },
    }],
    proposals: [],
    materialBatches: [{
      batchId: "batch-trail-1", requestId: "req-trail-search", messageId: "msg-trail-2",
      query: { provider: "pexels", kind: "video", query: "mountain trail forest", limit: 6 }, retrievedAt: NOW, resultCount: candidates.length,
    }],
    activeRequestId: null,
  });
  materialBatchBodies.set("batch-trail-1", {
    batchId: "batch-trail-1", workId: "work-trail", revision: 1, requestId: "req-trail-search", toolCallId: "call-trail-search",
    query: { provider: "pexels", kind: "video", query: "mountain trail forest", limit: 6 }, retrievedAt: NOW,
    results: candidates.map((candidate, index) => ({
      candidateId: `cand-${index + 1}`, provider: "pexels" as const, providerAssetId: `pexels-${index + 1}`,
      kind: candidate.kind, title: candidate.name, sourceUrl: candidate.image, creatorName: "预览素材作者", creatorUrl: null,
      previewUrl: candidate.image, width: 1280, height: 720, durationMs: candidate.kind === "video" ? 6_000 : null,
      licenseUrl: "https://www.pexels.com/license/", licenseName: "Pexels License",
    })), messageId: "msg-trail-2",
  });
  registerRevision("art-coffee-script", "rev-coffee-script-1", 1, {
    format: "markdown",
    text: "# 清晨的咖啡\n\n**镜头一** 水流贴着杯壁转圈，声音先醒过来。\n\n**镜头二** 光落在台面上，杯口的气慢慢散。\n\n**旁白**\n> 一天不必从匆忙开始。",
  });
  states.set("conv-coffee", {
    conversation: { id: "conv-coffee", title: "清晨咖啡小事", revision: 1, updatedAt: NOW },
    messages: [
      message({ id: "msg-coffee-1", role: "user", text: "想做一条清晨咖啡的短视频，先给我一版脚本。" }),
      message({ id: "msg-coffee-2", role: "assistant", text: "脚本初稿写好了：从水流到杯口的气，再落到“一天不必从匆忙开始”。觉得方向对了就说“确认制作”，想改哪一段直接讲。",
        references: { artifacts: [{ artifactId: "art-coffee-script", revisionId: "rev-coffee-script-1" }], proposalIds: [], runIds: [], materialBatchIds: [] } }),
    ],
    artifacts: [{ id: "art-coffee-script", title: "咖啡脚本 v1", kind: "script", revisionId: "rev-coffee-script-1", revisionNumber: 1, workId: null, updatedAt: NOW }],
    works: [], runs: [], proposals: [], materialBatches: [], activeRequestId: null,
  });
}

const LIBRARY_VIDEOS: LibraryVideo[] = [{
  video: { artifactId: "art-trail-video", revisionId: "rev-trail-video-1" }, workId: "work-trail", conversationId: "conv-trail",
  title: "山径慢走 · 定稿", finalizedAt: NOW, plan: null,
  content: { kind: "artifact_revision", artifactId: "art-trail-script", revisionId: "rev-trail-script-1", digest: `sha256:rev-trail-script-1${"0".repeat(42)}` },
  originMessageId: "msg-trail-2", narrationText: "不必赶路。山把风景留给走得慢的人。",
  projectFiles: [], project: null, materials: [], reviewSources: [], provenanceStatus: "recorded",
}];

const PROFILE: UserProfile = { revision: 1, displayName: "预览用户", bio: "在预览页里试用 Frame 的完整交互。" };
const freeServices = new Map<FreeServiceId, FreeServiceSettings>([
  ["pexels", { serviceId: "pexels", revision: 0, enabled: true, credentialConfigured: true, endpoint: "https://api.pexels.com/v1", writeUnavailableReason: null }],
  ["pixabay", { serviceId: "pixabay", revision: 0, enabled: false, credentialConfigured: false, writeUnavailableReason: null }],
  ["unsplash", { serviceId: "unsplash", revision: 0, enabled: false, credentialConfigured: false, writeUnavailableReason: null }],
  ["coverr", { serviceId: "coverr", revision: 0, enabled: false, credentialConfigured: false, writeUnavailableReason: null }],
  ["wikimedia", { serviceId: "wikimedia", revision: 0, enabled: true, writeUnavailableReason: null }],
  ["nasa", { serviceId: "nasa", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["met", { serviceId: "met", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["cleveland", { serviceId: "cleveland", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["archive", { serviceId: "archive", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["freetouse", { serviceId: "freetouse", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["incompetech", { serviceId: "incompetech", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["douyin-music", { serviceId: "douyin-music", revision: 0, enabled: true, writeUnavailableReason: null }],
  ["tiktok-sounds", { serviceId: "tiktok-sounds", revision: 0, enabled: false, writeUnavailableReason: null }],
  ["newsnow", { serviceId: "newsnow", revision: 0, enabled: false, endpoint: null, sourceIds: [], topics: [] }],
  ["edge-tts", { serviceId: "edge-tts", revision: 0, enabled: true, voice: "zh-CN-XiaoxiaoNeural" }],
]);

const skillView = (): SkillPackagesView => ({
  packages: [{ id: "pkg-story", source: "内置示例", name: "旅行叙事", origin: "builtin", skillIds: ["skill-story"], status: "ready", diagnostics: [], runtimeStatus: "ready", runtimeMissing: [] }],
  skills: BOOTSTRAP.skills, mutation: null,
});

function snapshotOf(state: MockState): Snapshot {
  return {
    conversation: state.conversation,
    eventCursor: `evt-${++eventSequence}`,
    messages: { items: state.messages, nextCursor: null, watermark: "wm-preview" },
    artifacts: { items: state.artifacts, nextCursor: null, watermark: "wm-preview" },
    runs: { items: state.runs, nextCursor: null, watermark: "wm-preview" },
    proposals: { items: state.proposals, nextCursor: null, watermark: "wm-preview" },
    activeRequestId: state.activeRequestId, works: state.works, materialBatches: state.materialBatches,
  };
}

// —— SSE 剧本 —— 发送消息后按固定节奏推进：进展 → 流式文本 → 定稿消息。 ——
const REPLY_SCRIPT = "收到。这一版的重点我会放在：先固定你要的节奏，再谈画面。你可以直接在预览里看每一步的产出，需要调整的地方随时发消息，草稿和阅读位置都会保留。";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }
  close(): void { this.closed = true; }
  emit(type: string, data: unknown): void {
    if (this.closed) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

const businessEvent = (conversationId: string, kind: BusinessEvent["kind"], entityId: string, entityVersion: number): BusinessEvent => ({
  eventId: `evt-${++eventSequence}`, cursor: `evt-${eventSequence}`, conversationId, kind, entityId, entityVersion,
  notification: kind === "artifact.delivered" ? "new_output" : "quiet", createdAt: new Date().toISOString(),
});

function driveReply(conversationId: string, requestId: string, userMessageId: string): void {
  const state = states.get(conversationId);
  if (!state) return;
  const stream = () => MockEventSource.instances.filter(source => !source.closed && source.url.includes(`/conversations/${conversationId}/events`)).at(-1);
  // 以本条用户消息的运行状态为推进门：被停止（stopped）即冻结；另一条消息抢先发送
  // 只会覆盖 activeRequestId 快照，不应冻结本剧本。
  const stillRunning = () => state.messages.find(item => item.id === userMessageId)?.state === "running";
  const schedule = (delayMs: number, run: () => void) => {
    window.setTimeout(() => {
      if (!stillRunning()) return; // 被停止后剧本不再推进。
      run();
    }, delayMs);
  };
  schedule(250, () => {
    const progress: RequestProgress = { requestId, sequence: 1, phase: "thinking", label: "整理你的要求", updatedAt: new Date().toISOString() };
    stream()?.emit("request.progress", progress);
  });
  const chunks = REPLY_SCRIPT.match(/.{1,12}/gu) ?? [];
  chunks.forEach((chunk, index) => {
    schedule(450 + index * 130, () => {
      const delta: TextDelta = { requestId, messageId: "pending", sequence: index + 1, text: chunk, replace: index === 0 };
      stream()?.emit("text.delta", delta);
    });
  });
  schedule(450 + chunks.length * 130 + 250, () => {
    const replyId = nextId("msg");
    const userEntry = state.messages.find(item => item.id === userMessageId);
    if (userEntry) { userEntry.state = "completed"; userEntry.revision = 2; }
    state.messages = [...state.messages, message({ id: replyId, role: "assistant", requestId, text: REPLY_SCRIPT, revision: 2 })];
    if (state.activeRequestId === requestId) state.activeRequestId = null;
    stream()?.emit("business", businessEvent(conversationId, "message.changed", userMessageId, 2));
    stream()?.emit("business", businessEvent(conversationId, "message.changed", replyId, 2));
  });
}

interface RouteResult { status: number; body: unknown }

function route(method: string, url: string, body: unknown): RouteResult | null {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
  const query = new URLSearchParams(url.split("?")[1] ?? "");
  const stateOf = (id: string): MockState | undefined => states.get(id);
  const ok = (payload: unknown): RouteResult => ({ status: 200, body: payload });
  const notFound = (): RouteResult => ({ status: 404, body: { code: "NOT_FOUND", message: "预览数据里没有这个对象。", requestId: "", retryAction: "wait", currentRevisionId: null } });
  const emptyPage = <T,>(items: T[]): { items: T[]; nextCursor: null; watermark: "wm-preview" } => ({ items, nextCursor: null, watermark: "wm-preview" });

  if (method === "GET" && path === "/api/agent/v1/bootstrap") return ok(BOOTSTRAP);
  if (path === "/api/agent/v1/profile") {
    if (method === "GET") return ok(PROFILE);
    if (method === "PATCH") {
      const input = body as SaveUserProfile;
      PROFILE.displayName = input.displayName; PROFILE.bio = input.bio; PROFILE.revision += 1;
      return ok({ profile: PROFILE, replayed: false } satisfies SaveUserProfileReceipt);
    }
  }
  if (method === "GET" && path === "/api/agent/v1/settings/model-connections") return ok({ revision: 1, connections: [], modelStatuses: [] });
  if (method === "POST" && path === "/api/agent/v1/settings/model-connections") return ok({ revision: 2, replayed: false } satisfies SaveProviderConnectionReceipt);
  if (method === "GET" && /^\/api\/agent\/v1\/settings\/model-connections\/[^/]+\/models$/.test(path)) {
    return ok({ models: [], hasMore: false, syncedAt: new Date().toISOString() } satisfies AvailableProviderModels);
  }
  if (method === "GET" && path === "/api/agent/v1/settings/skills") return ok(skillView());
  if (method === "POST" && (path.endsWith("/settings/skills/install") || path.endsWith("/settings/skills/remove"))) return ok(skillView());
  const serviceMatch = /^\/api\/agent\/v1\/settings\/services\/([^/]+)$/.exec(path);
  if (serviceMatch) {
    const current = freeServices.get(serviceMatch[1] as FreeServiceId);
    if (!current) return notFound();
    if (method === "GET") return ok(current);
    if (method === "PATCH") {
      const input = body as Partial<SaveFreeServiceSettingsInput>;
      const updated = { ...current, ...input, serviceId: current.serviceId, revision: current.revision + 1 } as FreeServiceSettings;
      freeServices.set(current.serviceId, updated);
      return ok({ settings: updated, replayed: false } satisfies SaveFreeServiceSettingsReceipt);
    }
  }
  if (method === "GET" && path === "/api/agent/v1/conversations") {
    return ok({ items: [...states.values()].map(item => item.conversation), nextCursor: null, watermark: "wm-preview" } satisfies ConversationPage);
  }
  if (method === "POST" && path === "/api/agent/v1/conversations") {
    const id = nextId("conv");
    states.set(id, {
      conversation: { id, title: (body as { title: string }).title || "新的会话", revision: 1, updatedAt: new Date().toISOString() },
      messages: [], artifacts: [], works: [], runs: [], proposals: [], materialBatches: [], activeRequestId: null,
    });
    return { status: 201, body: states.get(id)!.conversation };
  }
  const conversationMatch = /^\/api\/agent\/v1\/conversations\/([^/]+)$/.exec(path);
  if (method === "PATCH" && conversationMatch) {
    const state = stateOf(conversationMatch[1]!);
    if (!state) return notFound();
    const input = body as { title: string; expectedRevision: number };
    state.conversation = { ...state.conversation, title: input.title, revision: input.expectedRevision + 1, updatedAt: new Date().toISOString() };
    return ok(state.conversation);
  }
  const subMatch = /^\/api\/agent\/v1\/conversations\/([^/]+)\/(snapshot|messages|events|runs|artifacts|proposals|feedback)$/.exec(path);
  if (subMatch) {
    const id = subMatch[1]!, action = subMatch[2]!;
    const state = stateOf(id);
    if (!state) return notFound();
    if (action === "snapshot" && method === "GET") return ok(snapshotOf(state));
    if (action === "messages" && method === "GET") {
      const anchor = query.get("anchorMessageId");
      if (anchor) {
        const index = state.messages.findIndex(item => item.id === anchor);
        return ok({ items: index >= 0 ? state.messages.slice(0, index + 1) : state.messages, nextCursor: null, watermark: "wm-preview" } satisfies MessagePage);
      }
      return ok({ ...emptyPage(state.messages) });
    }
    if (action === "messages" && method === "POST") {
      const input = body as MessageInput;
      const requestId = nextId("req");
      const userMessageId = nextId("msg");
      state.messages = [...state.messages, message({ id: userMessageId, role: "user", text: input.text, requestId, state: "running", target: input.target })];
      state.activeRequestId = requestId;
      driveReply(id, requestId, userMessageId);
      return { status: 202, body: { receiptId: nextId("receipt"), requestId, messageId: userMessageId, state: "running", replayed: false, runId: null } satisfies RequestReceipt };
    }
    if (action === "feedback" && method === "POST") {
      return { status: 202, body: { target: (body as { target: FeedbackReceipt["target"] }).target, applied: false, disposition: "next_version", replayed: false, messageId: nextId("msg"), messageRevision: 1, workId: null, contentSource: null } satisfies FeedbackReceipt };
    }
    if (action === "runs" && method === "GET") return ok(emptyPage([]));
    if (action === "artifacts" && method === "GET") return ok(emptyPage([]));
    if (action === "proposals" && method === "GET") return ok(emptyPage([]));
  }
  const stopMatch = /^\/api\/agent\/v1\/requests\/([^/]+)\/stop$/.exec(path);
  if (method === "POST" && stopMatch) {
    for (const state of states.values()) {
      const target = state.messages.find(item => item.requestId === stopMatch[1]!);
      if (target) {
        target.state = "stopped";
        target.revision += 1;
        state.activeRequestId = null;
        return { status: 202, body: { receiptId: nextId("receipt"), requestId: stopMatch[1]!, messageId: target.id, state: "stopped", replayed: false, runId: null } satisfies RequestReceipt };
      }
    }
    return notFound();
  }
  const revisionMatch = /^\/api\/agent\/v1\/artifacts\/([^/]+)\/revisions\/([^/]+)$/.exec(path);
  if (method === "GET" && revisionMatch) {
    const revision = revisions.get(`${revisionMatch[1]}:${revisionMatch[2]!}`);
    return revision ? ok(revision) : notFound();
  }
  const blobMatch = /^\/api\/agent\/v1\/blobs\/([^/]+)\/(content|poster)$/.exec(path);
  if (method === "GET" && blobMatch && blobTexts.has(blobMatch[1]!)) {
    return { status: 200, body: blobTexts.get(blobMatch[1]!)! };
  }
  if (method === "GET" && path === "/api/agent/v1/library/videos") return ok({ items: LIBRARY_VIDEOS, nextCursor: null, watermark: "wm-preview" });
  const materialMatch = /^\/api\/agent\/v1\/material-batches\/([^/]+)$/.exec(path);
  if (method === "GET" && materialMatch) {
    const batch = materialBatchBodies.get(materialMatch[1]!);
    return batch ? ok(batch) : notFound();
  }
  // 单实体读取（消息/产物/提案/制作/作品）：从内存状态回放。
  const entityMatch = /^\/api\/agent\/v1\/(messages|artifacts|proposals|runs|works)\/([^/]+)$/.exec(path);
  if (method === "GET" && entityMatch) {
    const kind = entityMatch[1]!, id = entityMatch[2]!;
    for (const state of states.values()) {
      const found = kind === "messages" ? state.messages.find(item => item.id === id)
        : kind === "artifacts" ? state.artifacts.find(item => item.id === id)
        : kind === "proposals" ? state.proposals.find(item => item.id === id)
        : kind === "runs" ? state.runs.find(item => item.id === id)
        : state.works.find(item => item.id === id);
      if (found) return ok(found);
    }
    return notFound();
  }
  const approvalMatch = /^\/api\/agent\/v1\/works\/([^/]+)\/groups\/([^/]+)\/items\/([^/]+)\/(latest-feedback|approvals)$/.exec(path);
  if (method === "GET" && approvalMatch) {
    if (approvalMatch[4] === "latest-feedback") return ok({ message: null });
    return ok({ items: [], nextCursor: null, watermark: "wm-preview" });
  }
  const acceptMatch = /^\/api\/agent\/v1\/proposals\/([^/]+)\/acceptances$/.exec(path);
  if (method === "POST" && acceptMatch) return { status: 202, body: { receiptId: nextId("receipt"), replayed: false } };
  const cancelMatch = /^\/api\/agent\/v1\/runs\/([^/]+)\/cancellations$/.exec(path);
  if (method === "POST" && cancelMatch) return { status: 202, body: { runId: cancelMatch[1]!, state: "cancelled" } };
  return null;
}

/** 安装内存 Mock 后端：接管 window.fetch 与 window.EventSource。预览页只装一次。 */
export function installMockBackend(): void {
  seedStates();
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = route(method, url, body);
    if (result) return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
    if (url.includes("/api/agent/")) {
      return new Response(JSON.stringify({ code: "TEMPORARILY_UNAVAILABLE", message: "预览剧本未覆盖这个请求。", requestId: "", retryAction: "wait", currentRevisionId: null }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
  window.EventSource = MockEventSource as unknown as typeof EventSource;
}
