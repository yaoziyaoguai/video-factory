import type {
  StartRunResponse,
  StudioDecisionInput,
  StudioCandidateInbox,
  StudioCandidateAdoptionInput,
  StudioCandidateInboxQuery,
  StudioCreatorSettings,
  StudioCreatorSettingsPatch,
  StudioHealth,
  StudioLocalCapability,
  StudioOpportunity,
  StudioOpportunityInput,
  StudioOpportunityStatus,
  StudioProductionInput,
  StudioPublishBatch,
  StudioPublishInput,
  StudioPublishReadiness,
  StudioProvider,
  StudioRunDetail,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesInput,
  StudioTrendSource,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendCandidate,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";

export type StudioAuthSession =
  | { enabled: false; authenticated: true }
  | { enabled: true; authenticated: false }
  | { enabled: true; authenticated: true; username: string };

export const studioApi = {
  authSession: () => requestJson<StudioAuthSession>("/api/auth/session"),
  login: (username: string, password: string) => requestJson<StudioAuthSession>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  }),
  logout: () => requestJson<void>("/api/auth/logout", { method: "POST" }),
  health: () => requestJson<StudioHealth>("/api/health"),
  providers: () => requestJson<StudioProvider[]>("/api/providers"),
  localCapabilities: () => requestJson<StudioLocalCapability[]>("/api/local-capabilities"),
  voices: () => requestJson<StudioVoiceProfile[]>("/api/voices"),
  voicePreview: (input: StudioVoicePreviewInput) => requestObjectUrl("/api/voices/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  settings: () => requestJson<StudioCreatorSettings>("/api/settings"),
  updateSettings: (input: StudioCreatorSettingsPatch) => requestJson<StudioCreatorSettings>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  trendSources: () => requestJson<StudioTrendSource[]>("/api/trend-sources"),
  trendServices: () => requestJson<StudioTrendService[]>("/api/trend-services"),
  trendSignals: (platforms = ["douyin", "kuaishou", "weibo", "baidu", "toutiao", "zhihu", "bilibili", "thepaper", "36kr", "ithome", "sspai", "hupu", "tieba", "guokr"], limit = 160) => {
    const query = new URLSearchParams({ platforms: platforms.join(","), limit: String(limit) });
    return requestJson<StudioTrendSignal[]>(`/api/trend-signals?${query}`);
  },
  trendCandidates: () => requestJson<StudioTrendCandidate[]>("/api/trend-candidates"),
  refreshTrendCandidates: () => requestJson<StudioTrendCandidate[]>("/api/trend-candidates/refresh", { method: "POST" }),
  candidateInbox: (input: StudioCandidateInboxQuery = {}) => {
    const query = new URLSearchParams();
    if (input.origins?.length) query.set("origins", input.origins.join(","));
    if (input.categories?.length) query.set("categories", input.categories.join(","));
    if (input.platforms?.length) query.set("platforms", input.platforms.join(","));
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return requestJson<StudioCandidateInbox>(`/api/candidate-inbox${suffix}`);
  },
  adoptCandidate: (candidateId: string, input: StudioCandidateAdoptionInput = {}) => requestJson<StudioOpportunity>(
    `/api/candidate-inbox/${encodeURIComponent(candidateId)}/adopt`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
  ),
  series: () => requestJson<StudioSeries[]>("/api/series"),
  createSeries: (input: StudioSeriesInput) => requestJson<StudioSeries>("/api/series", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  opportunities: () => requestJson<StudioOpportunity[]>("/api/opportunities"),
  createOpportunity: (input: StudioOpportunityInput) => requestJson<StudioOpportunity>("/api/opportunities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  updateOpportunityStatus: (opportunityId: string, status: StudioOpportunityStatus) => requestJson<StudioOpportunity>(
    `/api/opportunities/${encodeURIComponent(opportunityId)}/status`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
  ),
  runs: () => requestJson<StudioRunSummary[]>("/api/runs"),
  run: (runId: string) => requestJson<StudioRunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
  start: (input: StudioProductionInput) => requestJson<StartRunResponse>("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  decide: (runId: string, input: StudioDecisionInput) => requestJson<StudioRunDetail>(
    `/api/runs/${encodeURIComponent(runId)}/decisions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ),
  publishReadiness: (runId: string) => requestJson<StudioPublishReadiness>(
    `/api/runs/${encodeURIComponent(runId)}/publishing/readiness`,
  ),
  publish: (runId: string, input: StudioPublishInput) => requestJson<StudioPublishBatch>(
    `/api/runs/${encodeURIComponent(runId)}/publishing`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ),
};

export function subscribeToRun(
  runId: string,
  onRun: (run: StudioRunDetail) => void,
  onDisconnect?: () => void,
): () => void {
  const events = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  const receive = (event: MessageEvent<string>) => {
    onRun(JSON.parse(event.data) as StudioRunDetail);
  };
  events.addEventListener("run", receive as EventListener);
  if (onDisconnect) events.addEventListener("error", onDisconnect);
  return () => events.close();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, studioRequest(init));
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) {
    throw new Error(userFacingApiError(body?.error, response.status));
  }
  return body as T;
}

async function requestObjectUrl(url: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, studioRequest(init));
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(userFacingApiError(body?.error, response.status));
  }
  return URL.createObjectURL(await response.blob());
}

function studioRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return undefined;
  const method = init.method?.toUpperCase() ?? "GET";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return init;
  const headers = new Headers(init.headers);
  headers.set("x-video-factory-request", "studio");
  return { ...init, headers };
}

function userFacingApiError(message: string | undefined, status: number): string {
  if (!message || /^Request failed with status/i.test(message)) return `请求失败（${status}），请稍后重试。`;
  if (message === "Internal server error.") return "服务暂时无法完成请求，请稍后重试。";
  return message;
}
