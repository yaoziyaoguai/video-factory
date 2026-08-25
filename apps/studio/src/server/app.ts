import { createReadStream } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { StudioAuthenticator, type StudioAuthOptions } from "./auth.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-service.js";
import {
  StudioInputError,
  parseStudioCandidateAdoptionInput,
  parseStudioCreatorSettingsPatch,
  parseStudioSeriesInput,
  parseStudioOpportunityInput,
  parseStudioOpportunityStatusInput,
  parseStudioDecisionInput,
  parseStudioPublishInput,
  parseStudioVoicePreviewInput,
  type StartRunResponse,
  type StudioArtifactResource,
  type StudioCandidateInbox,
  type StudioCandidateAdoptionInput,
  type StudioCandidateInboxQuery,
  type StudioCreatorSettings,
  type StudioCreatorSettingsPatch,
  type StudioDecisionInput,
  type StudioHealth,
  type StudioLocalCapability,
  type StudioOpportunity,
  type StudioOpportunityInput,
  type StudioOpportunityStatus,
  type StudioProvider,
  type StudioPublishBatch,
  type StudioPublishInput,
  type StudioPublishReadiness,
  type StudioVoicePreviewInput,
  type StudioVoiceProfile,
  type StudioTrendSource,
  type StudioTrendService,
  type StudioTrendSignal,
  type StudioTrendSignalQuery,
  type StudioTrendCandidate,
  type StudioRunDetail,
  type StudioRunSummary,
  type StudioSeries,
  type StudioSeriesInput,
  type StudioTopicCategory,
  type StudioCandidateOrigin,
} from "../shared/api.js";

export interface StudioServicePort {
  health(): Promise<StudioHealth>;
  listProviders(): Promise<StudioProvider[]>;
  listLocalCapabilities(): Promise<StudioLocalCapability[]>;
  listVoices(): Promise<StudioVoiceProfile[]>;
  previewVoice(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined>;
  getCreatorSettings(): Promise<StudioCreatorSettings>;
  updateCreatorSettings(input: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings>;
  listTrendSources(): Promise<StudioTrendSource[]>;
  listTrendServices(): Promise<StudioTrendService[]>;
  listTrendSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]>;
  listTrendCandidates(): Promise<StudioTrendCandidate[]>;
  refreshTrendCandidates(): Promise<StudioTrendCandidate[]>;
  listCandidateInbox(input: StudioCandidateInboxQuery): Promise<StudioCandidateInbox>;
  adoptCandidate(candidateId: string, input: StudioCandidateAdoptionInput): Promise<StudioOpportunity>;
  listSeries(): Promise<StudioSeries[]>;
  createSeries(input: StudioSeriesInput): Promise<StudioSeries>;
  listOpportunities(): Promise<StudioOpportunity[]>;
  getOpportunity(opportunityId: string): Promise<StudioOpportunity | undefined>;
  createOpportunity(input: StudioOpportunityInput): Promise<StudioOpportunity>;
  updateOpportunityStatus(opportunityId: string, status: StudioOpportunityStatus): Promise<StudioOpportunity>;
  listRuns(): Promise<StudioRunSummary[]>;
  getRun(runId: string): Promise<StudioRunDetail | undefined>;
  startRun(input: unknown): Promise<StartRunResponse>;
  decide(runId: string, input: StudioDecisionInput): Promise<StudioRunDetail>;
  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void;
  resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined>;
  publishReadiness(runId: string): Promise<StudioPublishReadiness>;
  publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch>;
}

export interface BuildStudioAppOptions {
  service: StudioServicePort;
  logger?: boolean;
  auth?: StudioAuthOptions;
}

const SAFE_ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function buildStudioApp(options: BuildStudioAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const auth = options.auth ? new StudioAuthenticator(options.auth) : undefined;

  app.get("/api/auth/session", async (request) => {
    if (!auth) return { enabled: false, authenticated: true };
    const username = auth.authenticatedUsername(request.headers.cookie);
    return username
      ? { enabled: true, authenticated: true, username }
      : { enabled: true, authenticated: false };
  });
  app.post("/api/auth/login", async (request, reply) => {
    if (!auth) return { enabled: false, authenticated: true };
    const input = parseLoginInput(request.body);
    const result = auth.authenticate(input.username, input.password, request.ip);
    if (result === "limited") {
      return reply.code(429).send({ error: "登录尝试过多，请稍后再试。" });
    }
    if (result === "rejected") {
      return reply.code(401).send({ error: "用户名或密码不正确。" });
    }
    reply.header("set-cookie", auth.createSessionCookie());
    return { enabled: true, authenticated: true, username: input.username };
  });
  app.post("/api/auth/logout", async (_request, reply) => {
    if (auth) reply.header("set-cookie", auth.clearSessionCookie());
    return reply.code(204).send();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!auth || !request.url.startsWith("/api/")) return;
    const pathname = request.url.split("?", 1)[0];
    if (pathname === "/api/health" || pathname === "/api/auth/session" || pathname === "/api/auth/login") return;
    if (!auth.authenticatedUsername(request.headers.cookie)) {
      return reply.code(401).send({ error: "请先登录 VideoFactory。" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers["x-video-factory-request"] !== "studio") {
      return reply.code(403).send({ error: "请求缺少安全校验，请刷新页面后重试。" });
    }
  });

  app.get("/api/health", async () => options.service.health());
  app.get("/api/providers", async () => options.service.listProviders());
  app.get("/api/local-capabilities", async () => options.service.listLocalCapabilities());
  app.get("/api/voices", async () => options.service.listVoices());
  app.get("/api/settings", async () => options.service.getCreatorSettings());
  app.patch("/api/settings", async (request) => {
    return options.service.updateCreatorSettings(parseStudioCreatorSettingsPatch(request.body));
  });
  app.get("/api/trend-sources", async () => options.service.listTrendSources());
  app.get("/api/trend-services", async () => options.service.listTrendServices());
  app.get<{ Querystring: { platforms?: string; limit?: string } }>("/api/trend-signals", async (request) => {
    const platforms = request.query.platforms?.split(",").map((value) => value.trim()).filter(Boolean);
    const requestedLimit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    return options.service.listTrendSignals({
      ...(platforms?.length ? { platforms } : {}),
      ...(requestedLimit !== undefined && Number.isFinite(requestedLimit) ? { limit: requestedLimit } : {}),
    });
  });
  app.get("/api/trend-candidates", async () => options.service.listTrendCandidates());
  app.post("/api/trend-candidates/refresh", async () => options.service.refreshTrendCandidates());
  app.get<{ Querystring: { origins?: string; categories?: string; platforms?: string; limit?: string } }>(
    "/api/candidate-inbox",
    async (request) => options.service.listCandidateInbox(parseCandidateInboxQuery(request.query)),
  );
  app.post<{ Params: { candidateId: string } }>("/api/candidate-inbox/:candidateId/adopt", async (request, reply) => {
    requireSafeRouteId(request.params.candidateId, "候选编号");
    return reply.code(201).send(await options.service.adoptCandidate(
      request.params.candidateId,
      parseStudioCandidateAdoptionInput(request.body),
    ));
  });
  app.get("/api/series", async () => options.service.listSeries());
  app.post("/api/series", async (request, reply) => {
    return reply.code(201).send(await options.service.createSeries(parseStudioSeriesInput(request.body)));
  });
  app.get("/api/opportunities", async () => options.service.listOpportunities());
  app.get("/api/runs", async () => options.service.listRuns());

  app.post("/api/voices/preview", async (request, reply) => {
    const input = parseStudioVoicePreviewInput(request.body);
    const resource = await options.service.previewVoice(input);
    if (!resource) {
      return reply.code(404).send({ error: "没有找到这个试听音色。" });
    }
    reply.header("content-type", resource.contentType);
    reply.header("content-length", resource.sizeBytes);
    reply.header("cache-control", "private, max-age=86400");
    return reply.send(createReadStream(resource.path));
  });

  app.post("/api/opportunities", async (request, reply) => {
    const input = parseStudioOpportunityInput(request.body);
    return reply.code(201).send(await options.service.createOpportunity(input));
  });

  app.get<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId", async (request, reply) => {
    requireSafeRouteId(request.params.opportunityId, "机会编号");
    const opportunity = await options.service.getOpportunity(request.params.opportunityId);
    if (!opportunity) {
      return reply.code(404).send({ error: "没有找到这条机会。" });
    }
    return opportunity;
  });

  app.patch<{ Params: { opportunityId: string } }>(
    "/api/opportunities/:opportunityId/status",
    async (request) => {
      requireSafeRouteId(request.params.opportunityId, "机会编号");
      const input = parseStudioOpportunityStatusInput(request.body);
      return options.service.updateOpportunityStatus(request.params.opportunityId, input.status);
    },
  );

  app.post("/api/runs", async (request, reply) => {
    const response = await options.service.startRun(request.body);
    return reply.code(202).send(response);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    const run = await options.service.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ error: "没有找到这条制作记录。" });
    }
    return run;
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/decisions", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    const input = parseStudioDecisionInput(request.body);
    return options.service.decide(request.params.runId, input);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/publishing/readiness", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    return options.service.publishReadiness(request.params.runId);
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/publishing", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    return options.service.publish(request.params.runId, parseStudioPublishInput(request.body));
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", async (request, reply) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    let buffered: StudioRunDetail | undefined;
    let closed = false;
    let send = (run: StudioRunDetail): void => {
      buffered = run;
    };
    const unsubscribe = options.service.subscribe(request.params.runId, (run) => send(run));
    const current = await options.service.getRun(request.params.runId);
    if (!current && !buffered) {
      unsubscribe();
      return reply.code(404).send({ error: "没有找到这条制作记录。" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };
    send = (run: StudioRunDetail): void => {
      if (closed) {
        return;
      }
      reply.raw.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
      if (isTerminal(run.status)) {
        close();
      }
    };

    request.raw.on("close", close);
    send(buffered ?? current!);
    return reply;
  });

  app.get<{ Params: { runId: string; artifactId: string } }>(
    "/api/runs/:runId/artifacts/:artifactId/content",
    async (request, reply) => {
      requireSafeRouteId(request.params.runId, "制作编号");
      requireSafeRouteId(request.params.artifactId, "产物编号");
      const resource = await options.service.resolveArtifact(request.params.runId, request.params.artifactId);
      if (!resource) {
        return reply.code(404).send({ error: "没有找到这个制作产物。" });
      }

      reply.header("accept-ranges", "bytes");
      reply.header("content-type", resource.contentType);
      const range = parseByteRange(request.headers.range, resource.sizeBytes);
      if (range === "invalid") {
        reply.header("content-range", `bytes */${resource.sizeBytes}`);
        return reply.code(416).send();
      }
      if (range) {
        const contentLength = range.end - range.start + 1;
        reply.header("content-range", `bytes ${range.start}-${range.end}/${resource.sizeBytes}`);
        reply.header("content-length", contentLength);
        return reply.code(206).send(createReadStream(resource.path, range));
      }
      reply.header("content-length", resource.sizeBytes);
      return reply.send(createReadStream(resource.path));
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StudioInputError) {
      void reply.code(400).send({ error: error.message });
      return;
    }
    if (error instanceof StudioNotFoundError) {
      void reply.code(404).send({ error: error.message });
      return;
    }
    if (error instanceof StudioConflictError) {
      void reply.code(409).send({ error: error.message });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({ error: "Internal server error." });
  });

  return app;
}

function parseLoginInput(value: unknown): { username: string; password: string } {
  if (typeof value !== "object" || value === null) throw new StudioInputError("请输入用户名和密码。");
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    throw new StudioInputError("请输入用户名和密码。");
  }
  if (username.length > 128 || password.length > 512) throw new StudioInputError("登录信息格式不正确。");
  return { username: username.trim(), password };
}

const CANDIDATE_ORIGINS = new Set<StudioCandidateOrigin>(["trend", "series"]);
const TOPIC_CATEGORIES = new Set<StudioTopicCategory>([
  "society", "finance-career", "technology", "lifestyle", "health-sports", "education", "entertainment", "local-culture",
  "food", "travel", "gaming", "automotive", "fashion-beauty", "parenting", "agriculture-rural",
]);

function parseCandidateInboxQuery(query: {
  origins?: string;
  categories?: string;
  platforms?: string;
  limit?: string;
}): StudioCandidateInboxQuery {
  const origins = splitQuery(query.origins);
  if (origins.some((value) => !CANDIDATE_ORIGINS.has(value as StudioCandidateOrigin))) {
    throw new StudioInputError("候选来源筛选无效。");
  }
  const categories = splitQuery(query.categories);
  if (categories.some((value) => !TOPIC_CATEGORIES.has(value as StudioTopicCategory))) {
    throw new StudioInputError("内容分类筛选无效。");
  }
  const platforms = splitQuery(query.platforms);
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)) {
    throw new StudioInputError("候选数量必须是 1 到 200 之间的整数。");
  }
  return {
    ...(origins.length ? { origins: origins as StudioCandidateOrigin[] } : {}),
    ...(categories.length ? { categories: categories as StudioTopicCategory[] } : {}),
    ...(platforms.length ? { platforms } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function splitQuery(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function isTerminal(status: StudioRunDetail["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}

function requireSafeRouteId(value: string, label: string): void {
  if (!SAFE_ROUTE_ID.test(value)) throw new StudioInputError(`${label}格式不正确。`);
}

function parseByteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return "invalid";
  }

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    return "invalid";
  }
  return { start, end };
}
