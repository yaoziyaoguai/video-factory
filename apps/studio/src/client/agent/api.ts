import type { ProviderConnectionSettings, SaveProviderConnection, SaveProviderConnectionReceipt, AvailableProviderModels } from "../../shared/agent/generated/contracts.js";
import { notifyAuthenticationLoss } from "../auth-api.js";
import type {
  ArtifactDraft, ArtifactHead, ArtifactRevision, Bootstrap, Conversation, ConversationPage, FeedbackInput, FeedbackReceipt,
  Message, MessageInput, MessagePage, Proposal, RequestReceipt, Snapshot, Target, ContextStatus,
  Error as ContractError, BusinessEvent, TextDelta, ArtifactPage, ProposalPage, Run, RunPage, AdmissionReceipt, AcceptProposal, CancelReceipt, CancelRun,
  LibraryVideo, LibraryVideoPage,
  Work, MaterialBatch,
  UserProfile, SaveUserProfile, SaveUserProfileReceipt,
  PexelsSettings, NewsNowSettings, KeyedMaterialSettings, KeylessMaterialSettings,
  SavePexelsSettings, SaveNewsNowSettings, SaveKeylessServiceSettings, SaveFreeServiceSettingsReceipt,
  SkillPackagesView, InstallSkillPackage, RemoveSkillPackage,
} from "../../shared/agent/generated/contracts.js";

// /api/agent/v1 的浏览器客户端：类型全部来自生成契约，不手写第二份 DTO。
// 变更请求带工作台安全头；错误按契约 Error 形状归一。SSE 用原生 EventSource（GET 无需头）。

export type AgentErrorPayload = ContractError & { status: number };

// 免费服务标识与读写形状：合同层没有单一枚举，按各 settings 的 serviceId 判别。
export type FreeServiceId = FreeServiceSettings["serviceId"];
export type FreeServiceSettings = PexelsSettings | KeyedMaterialSettings | KeylessMaterialSettings | NewsNowSettings;
export type SaveFreeServiceSettingsInput = SavePexelsSettings | SaveKeylessServiceSettings | SaveNewsNowSettings;

export class AgentApiError extends Error {
  constructor(readonly payload: AgentErrorPayload) {
    super(payload.message);
    this.name = "AgentApiError";
  }
}

async function requestJson<T>(method: string, url: string, body?: unknown, cache?: RequestCache): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(cache ? { cache } : {}),
    // GET/HEAD 不需要也不带安全头；变更必须可识别来源。
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" || method === "HEAD" ? {} : { "x-video-factory-request": "studio" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new Error("连接暂不可用，请检查服务后重试。"); });
  notifyAuthenticationLoss(url, response.status);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new AgentApiError({
      code: parsed?.code ?? "TEMPORARILY_UNAVAILABLE",
      message: parsed?.message ?? "请求失败。",
      requestId: parsed?.requestId ?? "",
      retryAction: parsed?.retryAction ?? "wait",
      currentRevisionId: parsed?.currentRevisionId ?? null,
      status: response.status,
    });
  }
  return parsed as T;
}

function newCommandId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `cmd-${Date.now().toString(36)}-${random}`;
}

export const agentApi = {
  newCommandId,
  readProviderConnections: () => requestJson<ProviderConnectionSettings>("GET", "/api/agent/v1/settings/model-connections"),
  saveProviderConnection: (input: SaveProviderConnection) => requestJson<SaveProviderConnectionReceipt>("POST", "/api/agent/v1/settings/model-connections", input),
  listAvailableProviderModels: (id: string) => requestJson<AvailableProviderModels>("GET", `/api/agent/v1/settings/model-connections/${encodeURIComponent(id)}/models`),

  bootstrap: () => requestJson<Bootstrap>("GET", "/api/agent/v1/bootstrap"),

  readSkillPackages: () => requestJson<SkillPackagesView>("GET", "/api/agent/v1/settings/skills", undefined, "no-store"),
  installSkillPackage: (input: InstallSkillPackage) => requestJson<SkillPackagesView>("POST", "/api/agent/v1/settings/skills/install", input, "no-store"),
  removeSkillPackage: (input: RemoveSkillPackage) => requestJson<SkillPackagesView>("POST", "/api/agent/v1/settings/skills/remove", input, "no-store"),

  readFreeServiceSettings: (serviceId: FreeServiceId) =>
    requestJson<FreeServiceSettings>("GET", `/api/agent/v1/settings/services/${serviceId}`),

  saveFreeServiceSettings: (serviceId: FreeServiceId, input: SaveFreeServiceSettingsInput) =>
    requestJson<SaveFreeServiceSettingsReceipt>("PATCH", `/api/agent/v1/settings/services/${serviceId}`, input),

  readUserProfile: () => requestJson<UserProfile>("GET", "/api/agent/v1/profile"),

  saveUserProfile: (input: SaveUserProfile) =>
    requestJson<SaveUserProfileReceipt>("PATCH", "/api/agent/v1/profile", input),

  listConversations: (cursor?: string) =>
    requestJson<ConversationPage>("GET", `/api/agent/v1/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),

  createConversation: (title: string) =>
    requestJson<Conversation>("POST", "/api/agent/v1/conversations", { commandId: newCommandId(), title }),

  renameConversation: (conversationId: string, title: string, expectedRevision: number) =>
    requestJson<Conversation>("PATCH", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}`, {
      commandId: newCommandId(), title, expectedRevision,
    }),

  snapshot: (conversationId: string) =>
    requestJson<Snapshot>("GET", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/snapshot`),

  sendMessages: (conversationId: string, input: MessageInput) =>
    requestJson<RequestReceipt>("POST", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/messages`, input),

  stopRequest: (requestId: string) =>
    requestJson<RequestReceipt>("POST", `/api/agent/v1/requests/${encodeURIComponent(requestId)}/stop`, { commandId: newCommandId() }),

  addFeedback: (conversationId: string, input: FeedbackInput) =>
    requestJson<FeedbackReceipt>("POST", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/feedback`, input),

  readRevision: (artifactId: string, revisionId: string) =>
    requestJson<ArtifactRevision>("GET", `/api/agent/v1/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revisionId)}`),

  readMessage: (id: string) => requestJson<Message>("GET", `/api/agent/v1/messages/${encodeURIComponent(id)}`),
  readArtifactHead: (id: string) => requestJson<ArtifactHead>("GET", `/api/agent/v1/artifacts/${encodeURIComponent(id)}`),
  readProposal: (id: string) => requestJson<Proposal>("GET", `/api/agent/v1/proposals/${encodeURIComponent(id)}`),
  readRun: (id: string) => requestJson<Run>("GET", `/api/agent/v1/runs/${encodeURIComponent(id)}`),
  readWork: (id: string) => requestJson<Work>("GET", `/api/agent/v1/works/${encodeURIComponent(id)}`),
  readMaterialBatch: (id: string) => requestJson<MaterialBatch>("GET", `/api/agent/v1/material-batches/${encodeURIComponent(id)}`),
  acceptProposal: (id: string, input: AcceptProposal) => requestJson<AdmissionReceipt>("POST", `/api/agent/v1/proposals/${encodeURIComponent(id)}/acceptances`, input),
  cancelRun: (id: string, input: CancelRun) => requestJson<CancelReceipt>("POST", `/api/agent/v1/runs/${encodeURIComponent(id)}/cancellations`, input),
  loadMoreRuns: (id: string, cursor: string) => requestJson<RunPage>("GET", `/api/agent/v1/conversations/${encodeURIComponent(id)}/runs?cursor=${encodeURIComponent(cursor)}`),
  loadMoreArtifacts: (id: string, cursor: string) => requestJson<ArtifactPage>("GET", `/api/agent/v1/conversations/${encodeURIComponent(id)}/artifacts?cursor=${encodeURIComponent(cursor)}`),
  loadMoreProposals: (id: string, cursor: string) => requestJson<ProposalPage>("GET", `/api/agent/v1/conversations/${encodeURIComponent(id)}/proposals?cursor=${encodeURIComponent(cursor)}`),
  loadMoreMessages: (conversationId: string, cursor: string) =>
    requestJson<MessagePage>("GET", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/messages?cursor=${encodeURIComponent(cursor)}`),
  // 定位窗口首页：锚点及其之前最近一页；nextCursor 仍向前翻更早消息。
  anchorMessages: (conversationId: string, anchorMessageId: string) =>
    requestJson<MessagePage>("GET", `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/messages?anchorMessageId=${encodeURIComponent(anchorMessageId)}`),

  listLibraryVideos: (cursor?: string) =>
    requestJson<LibraryVideoPage>("GET", `/api/agent/v1/library/videos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
};

export function messageInput(text: string, target: Target | null): MessageInput {
  return {
    commandId: newCommandId(), text, target,
    skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
  };
}

export function feedbackInput(target: Target, text: string): FeedbackInput {
  return { commandId: newCommandId(), target, text };
}

// —— SSE —— 业务事件 / 暂态增量 / 缺口重置。断流后重新取快照和游标；
// 重复投递靠客户端按 id+版本合并吸收。

export type { BusinessEvent, TextDelta, ArtifactDraft, ContextStatus };

export interface EventSubscription {
  close(): void;
}

export function subscribeEvents(
  conversationId: string,
  cursor: string,
  handlers: {
    onBusiness: (event: BusinessEvent) => void;
    onDelta: (delta: TextDelta) => void;
    onReset: () => void;
    /** 暂态交付草稿；不持久，断流即失。 */
    onDraft?: (draft: ArtifactDraft) => void;
    /** 暂态上下文压缩状态；不持久，断流即失。 */
    onContextStatus?: (status: ContextStatus) => void;
  },
): EventSubscription {
  const url = `/api/agent/v1/conversations/${encodeURIComponent(conversationId)}/events?cursor=${encodeURIComponent(cursor)}`;
  const source = new EventSource(url);
  source.addEventListener("business", event => handlers.onBusiness(JSON.parse((event as MessageEvent).data as string) as BusinessEvent));
  source.addEventListener("text.delta", event => handlers.onDelta(JSON.parse((event as MessageEvent).data as string) as TextDelta));
  if (handlers.onDraft) source.addEventListener("artifact.draft", event => handlers.onDraft!(JSON.parse((event as MessageEvent).data as string) as ArtifactDraft));
  if (handlers.onContextStatus) source.addEventListener("context.status", event => handlers.onContextStatus!(JSON.parse((event as MessageEvent).data as string) as ContextStatus));
  const reset = () => { source.close(); handlers.onReset(); };
  source.addEventListener("reset_required", reset);
  source.onerror = reset;
  return { close: () => source.close() };
}

export type { ArtifactHead, ArtifactRevision, Bootstrap, Conversation, Message, Proposal, Snapshot, Target, UserProfile, SaveUserProfile, PexelsSettings, NewsNowSettings, KeyedMaterialSettings, KeylessMaterialSettings, SavePexelsSettings, SaveNewsNowSettings, SaveKeylessServiceSettings, SaveFreeServiceSettingsReceipt, Work, MaterialBatch, LibraryVideo };
