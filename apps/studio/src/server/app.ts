import { createReadStream } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { parseProductionTemplate } from "@video-factory/template-core";
import { StudioAuthenticator, type StudioAuthOptions } from "./auth.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-service.js";
import {
  StudioInputError,
  parseStudioCandidateAdoptionInput,
  parseStudioCreatorSettingsPatch,
  parseStudioSeriesInput,
  parseStudioSeriesEpisodePlanInput,
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
  type StudioCostDashboard,
  type StudioCostRunDetail,
  type StudioDecisionInput,
  type StudioHealth,
  type StudioLocalCapability,
  type StudioOpportunity,
  type StudioOpportunityInput,
  type StudioOpportunityStatus,
  type StudioProvider,
  type StudioResourceManifest,
  type StudioReferenceVideo,
  type StudioPublishBatch,
  type StudioPublishInput,
  type StudioPublishReadiness,
  type StudioPublishTarget,
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
  type StudioSeriesEpisodePlanInput,
  type StudioTopicCategory,
  type StudioCandidateOrigin,
  type StudioEditorialVerdict,
  type StudioTemplate,
  type StudioTemplateCatalog,
  type StudioTemplateCloneInput,
  type StudioTemplateCreateInput,
  type StudioTemplateMutation,
  type StudioTemplateExperimentScorecard,
  type StudioNodeInputOverrideInput,
  type StudioNodeOverrideInput,
  type StudioSpendAuthorizationInput,
} from "../shared/api.js";

export interface StudioServicePort {
  health(): Promise<StudioHealth>;
  listProviders(): Promise<StudioProvider[]>;
  listLocalCapabilities(): Promise<StudioLocalCapability[]>;
  listVoices(): Promise<StudioVoiceProfile[]>;
  previewVoice(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined>;
  getCreatorSettings(): Promise<StudioCreatorSettings>;
  updateCreatorSettings(input: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings>;
  listTemplates(): Promise<StudioTemplateCatalog>;
  templateExperiments(): Promise<StudioTemplateExperimentScorecard[]>;
  resourceManifest(): Promise<StudioResourceManifest>;
  getTemplate(id: string, version?: number): Promise<StudioTemplate | undefined>;
  cloneTemplate(input: StudioTemplateCloneInput): Promise<StudioTemplateMutation>;
  createTemplate(input: StudioTemplateCreateInput): Promise<StudioTemplateMutation>;
  saveTemplateDraft(input: StudioTemplate, expectedRevision: number): Promise<StudioTemplateMutation>;
  publishTemplate(id: string, expectedRevision: number): Promise<StudioTemplateMutation>;
  listTrendSources(): Promise<StudioTrendSource[]>;
  listTrendServices(): Promise<StudioTrendService[]>;
  listTrendSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]>;
  listTrendCandidates(): Promise<StudioTrendCandidate[]>;
  refreshTrendCandidates(): Promise<StudioTrendCandidate[]>;
  listCandidateInbox(input: StudioCandidateInboxQuery): Promise<StudioCandidateInbox>;
  adoptCandidate(candidateId: string, input: StudioCandidateAdoptionInput): Promise<StudioOpportunity>;
  listSeries(): Promise<StudioSeries[]>;
  createSeries(input: StudioSeriesInput): Promise<StudioSeries>;
  updateSeriesEpisodePlan(seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput): Promise<StudioSeries>;
  linkLegacySeriesRun(seriesId: string, episodeNumber: number, runId: string): Promise<StudioSeries>;
  listOpportunities(origin?: "trend" | "series" | "manual"): Promise<StudioOpportunity[]>;
  getOpportunity(opportunityId: string): Promise<StudioOpportunity | undefined>;
  createOpportunity(input: StudioOpportunityInput): Promise<StudioOpportunity>;
  updateOpportunityStatus(opportunityId: string, status: StudioOpportunityStatus): Promise<StudioOpportunity>;
  listRuns(origin?: "trend" | "series" | "manual"): Promise<StudioRunSummary[]>;
  getRun(runId: string): Promise<StudioRunDetail | undefined>;
  archiveRuns(runIds: string[]): Promise<void>;
  restoreRuns(runIds: string[]): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  costDashboard(): Promise<StudioCostDashboard>;
  runCostDetail(runId: string): Promise<StudioCostRunDetail | undefined>;
  startRun(input: unknown, idempotencyKey?: string): Promise<StartRunResponse>;
  uploadReferenceVideo?(input: { label: string; mimeType: string; bytes: Buffer }): Promise<StudioReferenceVideo>;
  deleteReferenceVideo?(uploadId: string): Promise<void>;
  decide(runId: string, input: StudioDecisionInput, actor: string): Promise<StudioRunDetail>;
  applyNodeOverride(runId: string, nodeId: string, input: StudioNodeOverrideInput, actor: string): Promise<StudioRunDetail>;
  applyNodeInputOverride(runId: string, nodeId: string, input: StudioNodeInputOverrideInput, actor: string): Promise<StudioRunDetail>;
  authorizeSpend(runId: string, nodeId: string, input: StudioSpendAuthorizationInput, approvedBy: string): Promise<StudioRunDetail>;
  resumeStale(runId: string): Promise<StudioRunDetail>;
  retryFailedNode(runId: string, nodeId: string): Promise<StudioRunDetail>;
  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void;
  resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined>;
  listPublishTargets(): Promise<StudioPublishTarget[]>;
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
  for (const contentType of ["application/octet-stream", "video/mp4", "video/quicktime", "video/webm"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer", bodyLimit: 30 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  }

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
  app.get("/api/templates", async () => options.service.listTemplates());
  app.get("/api/template-experiments", async () => options.service.templateExperiments());
  app.get("/api/resource-manifest", async () => options.service.resourceManifest());
  app.get<{ Params: { templateId: string }; Querystring: { version?: string } }>("/api/templates/:templateId", async (request, reply) => {
    requireSafeRouteId(request.params.templateId, "模板编号");
    const version = request.query.version === undefined ? undefined : Number(request.query.version);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new StudioInputError("模板版本必须是正整数。");
    const template = await options.service.getTemplate(request.params.templateId, version);
    if (!template) return reply.code(404).send({ error: "没有找到这个模板。" });
    return template;
  });
  app.post("/api/templates/clone", async (request, reply) => {
    return reply.code(201).send(await options.service.cloneTemplate(parseTemplateCloneInput(request.body)));
  });
  app.post("/api/templates", async (request, reply) => {
    return reply.code(201).send(await options.service.createTemplate(parseTemplateCreateInput(request.body)));
  });
  app.put<{ Params: { templateId: string } }>("/api/templates/:templateId/draft", async (request) => {
    requireSafeRouteId(request.params.templateId, "模板编号");
    const body = requireRecord(request.body, "模板请求");
    const expectedRevision = requireNonNegativeInteger(body.expectedRevision, "expectedRevision");
    const template = parseTemplateDraft(body.template);
    if (template.id !== request.params.templateId) throw new StudioInputError("模板编号与请求地址不一致。");
    return options.service.saveTemplateDraft(template, expectedRevision);
  });
  app.post<{ Params: { templateId: string } }>("/api/templates/:templateId/publish", async (request) => {
    requireSafeRouteId(request.params.templateId, "模板编号");
    const body = requireRecord(request.body, "模板请求");
    return options.service.publishTemplate(
      request.params.templateId,
      requireNonNegativeInteger(body.expectedRevision, "expectedRevision"),
    );
  });
  app.get("/api/trend-sources", async () => options.service.listTrendSources());
  app.get("/api/publish-targets", async () => options.service.listPublishTargets());
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
  app.get<{ Querystring: { origins?: string; categories?: string; platforms?: string; verdicts?: string; limit?: string } }>(
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
  app.patch<{ Params: { seriesId: string; episodeNumber: string } }>(
    "/api/series/:seriesId/episodes/:episodeNumber",
    async (request) => {
      requireSafeRouteId(request.params.seriesId, "系列编号");
      const episodeNumber = Number(request.params.episodeNumber);
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) throw new StudioInputError("单集编号必须是正整数。");
      return options.service.updateSeriesEpisodePlan(
        request.params.seriesId,
        episodeNumber,
        parseStudioSeriesEpisodePlanInput(request.body),
      );
    },
  );
  app.post<{ Params: { seriesId: string; episodeNumber: string }; Body: { runId?: unknown } }>(
    "/api/series/:seriesId/episodes/:episodeNumber/legacy-run",
    async (request) => {
      requireSafeRouteId(request.params.seriesId, "系列编号");
      const episodeNumber = Number(request.params.episodeNumber);
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) throw new StudioInputError("单集编号必须是正整数。");
      if (typeof request.body?.runId !== "string") throw new StudioInputError("请选择一条历史制作记录。");
      requireSafeRouteId(request.body.runId, "制作记录编号");
      return options.service.linkLegacySeriesRun(request.params.seriesId, episodeNumber, request.body.runId);
    },
  );
  app.get<{ Querystring: { origin?: string } }>("/api/opportunities", async (request) => {
    return options.service.listOpportunities(parseCreationOrigin(request.query.origin));
  });
  app.get<{ Querystring: { origin?: string } }>("/api/runs", async (request) => {
    return options.service.listRuns(parseCreationOrigin(request.query.origin));
  });
  app.get("/api/costs", async () => options.service.costDashboard());

  app.post<{ Body: Buffer }>("/api/reference-videos", async (request, reply) => {
    if (!options.service.uploadReferenceVideo) throw new StudioInputError("当前环境没有启用参考视频上传。");
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new StudioInputError("参考视频内容为空。");
    const encodedLabel = request.headers["x-video-factory-filename"];
    if (typeof encodedLabel !== "string") throw new StudioInputError("参考视频缺少文件名。");
    let label: string;
    try {
      label = decodeURIComponent(encodedLabel);
    } catch {
      throw new StudioInputError("参考视频文件名编码不正确。");
    }
    const mimeType = String(request.headers["content-type"] ?? "").split(";", 1)[0] ?? "";
    return reply.code(201).send(await options.service.uploadReferenceVideo({ label, mimeType, bytes: request.body }));
  });
  app.delete<{ Params: { uploadId: string } }>("/api/reference-videos/:uploadId", async (request, reply) => {
    requireSafeRouteId(request.params.uploadId, "参考视频编号");
    if (!options.service.deleteReferenceVideo) throw new StudioInputError("当前环境没有启用参考视频删除。");
    await options.service.deleteReferenceVideo(request.params.uploadId);
    return reply.code(204).send();
  });

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
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !SAFE_ROUTE_ID.test(idempotencyKey)) {
      throw new StudioInputError("创建制作必须携带有效的 Idempotency-Key，以避免重复计费。");
    }
    const response = await options.service.startRun(request.body, idempotencyKey);
    return reply.code(202).send(response);
  });

  app.post("/api/runs/archive", async (request, reply) => {
    await options.service.archiveRuns(parseRunBatchInput(request.body));
    return reply.code(204).send();
  });

  app.post("/api/runs/restore", async (request, reply) => {
    await options.service.restoreRuns(parseRunBatchInput(request.body));
    return reply.code(204).send();
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    const run = await options.service.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ error: "没有找到这条制作记录。" });
    }
    return run;
  });

  app.delete<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    await options.service.deleteRun(request.params.runId);
    return reply.code(204).send();
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/costs", async (request, reply) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    const detail = await options.service.runCostDetail(request.params.runId);
    return detail ?? reply.code(404).send({ error: "没有找到这条制作记录的消费明细。" });
  });

  app.put<{ Params: { runId: string; nodeId: string } }>("/api/runs/:runId/nodes/:nodeId/override", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    requireSafeRouteId(request.params.nodeId, "节点编号");
    return options.service.applyNodeOverride(
      request.params.runId,
      request.params.nodeId,
      parseNodeOverrideInput(request.body),
      trustedStudioActor(auth, request.headers.cookie),
    );
  });

  app.put<{ Params: { runId: string; nodeId: string } }>("/api/runs/:runId/nodes/:nodeId/input-override", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    requireSafeRouteId(request.params.nodeId, "节点编号");
    return options.service.applyNodeInputOverride(
      request.params.runId,
      request.params.nodeId,
      parseNodeInputOverrideInput(request.body),
      trustedStudioActor(auth, request.headers.cookie),
    );
  });

  app.post<{ Params: { runId: string; nodeId: string } }>("/api/runs/:runId/nodes/:nodeId/spend-authorizations", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    requireSafeRouteId(request.params.nodeId, "节点编号");
    return options.service.authorizeSpend(
      request.params.runId,
      request.params.nodeId,
      parseSpendAuthorizationInput(request.body),
      trustedStudioActor(auth, request.headers.cookie),
    );
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/regenerate-stale", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    return options.service.resumeStale(request.params.runId);
  });

  app.post<{ Params: { runId: string; nodeId: string } }>("/api/runs/:runId/nodes/:nodeId/retry", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    requireSafeRouteId(request.params.nodeId, "节点编号");
    return options.service.retryFailedNode(request.params.runId, request.params.nodeId);
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/decisions", async (request) => {
    requireSafeRouteId(request.params.runId, "制作编号");
    const input = parseStudioDecisionInput(request.body);
    return options.service.decide(request.params.runId, input, trustedStudioActor(auth, request.headers.cookie));
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
    let heartbeatTimer: NodeJS.Timeout | undefined;
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    if (!closed) {
      const sendHeartbeat = (): void => {
        if (!closed) reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      };
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, 10_000);
      heartbeatTimer.unref();
    }
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
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (statusCode === 413 || code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply.code(413).send({ error: "参考视频不能超过 30 MB。" });
      return;
    }
    if (statusCode === 400 && code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      void reply.code(400).send({ error: "请求内容不是有效的 JSON。" });
      return;
    }
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
const EDITORIAL_VERDICTS = new Set(["produce_video", "produce_image_story", "skip"]);
const TOPIC_CATEGORIES = new Set<StudioTopicCategory>([
  "society", "finance-career", "technology", "lifestyle", "health-sports", "education", "entertainment", "local-culture",
  "food", "travel", "gaming", "automotive", "fashion-beauty", "parenting", "agriculture-rural",
]);

function parseCandidateInboxQuery(query: {
  origins?: string;
  categories?: string;
  platforms?: string;
  verdicts?: string;
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
  const verdicts = splitQuery(query.verdicts);
  if (verdicts.some((value) => !EDITORIAL_VERDICTS.has(value))) {
    throw new StudioInputError("生产建议筛选无效。");
  }
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)) {
    throw new StudioInputError("候选数量必须是 1 到 200 之间的整数。");
  }
  return {
    ...(origins.length ? { origins: origins as StudioCandidateOrigin[] } : {}),
    ...(categories.length ? { categories: categories as StudioTopicCategory[] } : {}),
    ...(platforms.length ? { platforms } : {}),
    ...(verdicts.length ? { verdicts: verdicts as StudioEditorialVerdict[] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function splitQuery(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseTemplateCloneInput(value: unknown): StudioTemplateCloneInput {
  const input = requireRecord(value, "模板请求");
  const sourceId = requireText(input.sourceId, "sourceId");
  const newId = requireText(input.newId, "newId");
  const name = requireText(input.name, "name");
  if (!SAFE_ROUTE_ID.test(sourceId) || !SAFE_ROUTE_ID.test(newId)) throw new StudioInputError("模板编号格式不正确。");
  return {
    sourceId,
    newId,
    name,
    expectedRevision: requireNonNegativeInteger(input.expectedRevision, "expectedRevision"),
  };
}

function parseTemplateCreateInput(value: unknown): StudioTemplateCreateInput {
  const input = requireRecord(value, "模板请求");
  const id = requireText(input.id, "id");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new StudioInputError("模板编号必须使用小写字母、数字和连字符。");
  const description = input.description === undefined ? undefined : requireText(input.description, "description");
  return {
    id,
    name: requireText(input.name, "name"),
    ...(description ? { description } : {}),
    expectedRevision: requireNonNegativeInteger(input.expectedRevision, "expectedRevision"),
  };
}

function parseTemplateDraft(value: unknown): StudioTemplate {
  try {
    return { ...parseProductionTemplate(value), builtIn: false };
  } catch (error) {
    throw new StudioInputError(`模板参数不正确：${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StudioInputError(`${label}格式不正确。`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new StudioInputError(`${field} 不能为空。`);
  return value.trim();
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new StudioInputError(`${field} 必须是非负整数。`);
  return Number(value);
}

function parseNodeOverrideInput(value: unknown): StudioNodeOverrideInput {
  const input = requireRecord(value, "节点修改请求");
  if (input.confirmTerminalEdit !== undefined && typeof input.confirmTerminalEdit !== "boolean") {
    throw new StudioInputError("终态编辑确认必须是布尔值。");
  }
  let document: StudioNodeOverrideInput["document"];
  if (input.document !== undefined) {
    const candidate = requireRecord(input.document, "结构化交付");
    if (!("content" in candidate)) throw new StudioInputError("结构化交付内容不能为空。");
    document = {
      artifactId: requireText(candidate.artifactId, "artifactId"),
      content: candidate.content,
    };
  }
  let authorizedRunFiles: string[] | undefined;
  if (input.authorizedRunFiles !== undefined) {
    if (!Array.isArray(input.authorizedRunFiles) || input.authorizedRunFiles.some((item) => typeof item !== "string" || !item.trim())) {
      throw new StudioInputError("人工替换文件清单格式不正确。");
    }
    authorizedRunFiles = [...new Set(input.authorizedRunFiles.map((item) => item.trim()))];
  }
  return {
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(document ? { document } : {}),
    ...(authorizedRunFiles ? { authorizedRunFiles } : {}),
    ...(input.confirmTerminalEdit === true ? { confirmTerminalEdit: true } : {}),
  };
}

function parseNodeInputOverrideInput(value: unknown): StudioNodeInputOverrideInput {
  const input = requireRecord(value, "节点输入修改请求");
  if (!("input" in input)) throw new StudioInputError("节点输入内容不能为空。");
  if (input.confirmTerminalEdit !== undefined && typeof input.confirmTerminalEdit !== "boolean") {
    throw new StudioInputError("终态编辑确认必须是布尔值。");
  }
  return {
    input: input.input,
    ...(input.confirmTerminalEdit === true ? { confirmTerminalEdit: true } : {}),
  };
}

function parseSpendAuthorizationInput(value: unknown): StudioSpendAuthorizationInput {
  const input = requireRecord(value, "费用授权请求");
  if (!Array.isArray(input.inputVersionIds) || input.inputVersionIds.some((item) => typeof item !== "string" || !item)) {
    throw new StudioInputError("输入版本清单格式不正确。");
  }
  return {
    inputVersionIds: [...input.inputVersionIds] as string[],
    providerId: requireText(input.providerId, "providerId"),
    modelId: requireText(input.modelId, "modelId"),
    maxCostCny: requireNonNegativeNumber(input.maxCostCny, "maxCostCny"),
    maxAttempts: requirePositiveInteger(input.maxAttempts, "maxAttempts"),
  };
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new StudioInputError(`${field} 必须是非负数字。`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new StudioInputError(`${field} 必须是正整数。`);
  return Number(value);
}

function parseRunBatchInput(value: unknown): string[] {
  const input = requireRecord(value, "制作记录整理请求");
  if (!Array.isArray(input.runIds) || input.runIds.length === 0 || input.runIds.length > 100) {
    throw new StudioInputError("制作记录清单必须包含 1 到 100 条记录。");
  }
  if (input.runIds.some((runId) => typeof runId !== "string" || !SAFE_ROUTE_ID.test(runId))) {
    throw new StudioInputError("制作记录编号格式不正确。");
  }
  return [...new Set(input.runIds as string[])];
}

function parseCreationOrigin(value: string | undefined): "trend" | "series" | "manual" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "trend" || value === "series" || value === "manual") return value;
  throw new StudioInputError("创作入口不正确。");
}

function isTerminal(status: StudioRunDetail["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}

function requireSafeRouteId(value: string, label: string): void {
  if (!SAFE_ROUTE_ID.test(value)) throw new StudioInputError(`${label}格式不正确。`);
}

function trustedStudioActor(auth: StudioAuthenticator | undefined, cookie: string | undefined): string {
  return auth?.authenticatedUsername(cookie) ?? "studio-owner";
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
