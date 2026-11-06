import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentService } from "./agent-service.js";
import { AgentError } from "./errors.js";
import { decodeEventCursor } from "./paging.js";
import { maxEventSeq, minEventSeq } from "./event-log.js";
import { newAgentId } from "./util.js";
import { createReadStream } from "node:fs";

// /api/agent/v1 的路由与传输层：自鉴权（不依赖旧 app.ts 的 {error} 钩子）、
// 契约 Error 形状、Origin/安全头校验、SSE 事件流。所有策略都在 AgentService。

export interface AgentPluginOptions {
  service: AgentService;
  /** 认证入口：返回 ownerId；null/undefined 表示未认证。 */
  resolveOwner: (request: FastifyRequest) => string | null | undefined;
  /** 允许发起变更的 UI 来源（Origin 精确匹配）。 */
  uiOrigin: string;
  /** 显式本地单用户模式：仅允许环回地址访问。 */
  localOwnerOnly?: boolean;
}

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;

declare module "fastify" {
  interface FastifyRequest {
    agentOwnerId?: string;
  }
}

export async function agentRoutes(app: FastifyInstance, options: AgentPluginOptions): Promise<void> {
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of [...streams]) close(); });
  const requireOwner = (request: FastifyRequest): string => {
    const ownerId = options.resolveOwner(request);
    if (!ownerId) throw new AgentError("UNAUTHENTICATED", "请先完成认证再使用工作台。");
    if (options.localOwnerOnly && !isLoopback(request.ip)) {
      throw new AgentError("FORBIDDEN", "本地单用户模式只允许本机访问。");
    }
    return ownerId;
  };

  const guardMutation = (request: FastifyRequest): void => {
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new AgentError("INVALID_INPUT", "请使用 application/json 请求正文。");
    const origin = request.headers.origin;
    if (!origin || origin !== options.uiOrigin) {
      throw new AgentError("FORBIDDEN", "请求来源不受信任，请从工作台页面操作。");
    }
    if (request.headers["x-video-factory-request"] !== "studio") {
      throw new AgentError("FORBIDDEN", "请求缺少安全校验，请刷新页面后重试。");
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") {
      requireOwner(request);
      return;
    }
    guardMutation(request);
    requireOwner(request);
    void reply;
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = newAgentId("req");
    if (error instanceof AgentError) {
      return reply.code(error.statusCode).send({ ...error.toPayload(), requestId });
    }
    const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415) {
      return reply.code(400).send({ ...new AgentError("INVALID_INPUT", "请求正文不是有效的 JSON 或超过允许大小。").toPayload(), requestId });
    }
    request.log.error(error, "agent route failure");
    return reply.code(503).send({
      code: "TEMPORARILY_UNAVAILABLE",
      message: "服务暂时不可用，请稍后重试。",
      requestId,
      retryAction: "wait",
      currentRevisionId: null,
    });
  });

  const service = options.service;

  app.get("/bootstrap", async request => service.bootstrap(requireOwner(request)));

  app.get("/settings/model-connections", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.readProviderConnections();
  });
  app.post("/settings/model-connections", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.saveProviderConnection(requireOwner(request), request.body);
  });
  app.get<{ Params: { connectionId: string } }>("/settings/model-connections/:connectionId/models", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.listAvailableProviderModels(request.params.connectionId);
  });

  app.get("/settings/skills", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.readSkillPackages();
  });
  app.post("/settings/skills/install", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.installSkillPackage(body(request));
  });
  app.post("/settings/skills/remove", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.removeSkillPackage(body(request));
  });

  app.get("/settings/imported", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.readImportedSettings(requireOwner(request));
  });

  app.get("/settings/services/:serviceId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = request.params as { serviceId: string };
    return service.readFreeServiceSettingsRow(requireOwner(request), params.serviceId);
  });

  app.patch("/settings/services/:serviceId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = request.params as { serviceId: string };
    return service.saveFreeServiceSettings(requireOwner(request), params.serviceId, body(request));
  });

  app.get("/profile", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.readUserProfileRow(requireOwner(request));
  });

  app.patch("/profile", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.saveUserProfile(requireOwner(request), body(request));
  });

  app.post("/conversations", async (request, reply) => {
    const result = service.createConversation(requireOwner(request), body(request));
    return reply.code(result.replayed ? 200 : 201).send(result.conversation);
  });

  app.get("/conversations", async request => {
    const query = pageQuery(request);
    return service.listConversations(requireOwner(request), query.cursor, query.limit);
  });

  app.get("/library/videos", async request => {
    const query = pageQuery(request);
    return service.listLibraryVideos(requireOwner(request), query.cursor, query.limit);
  });

  app.patch("/conversations/:conversationId", async (request, reply) => {
    const params = request.params as { conversationId: string };
    return reply.send(service.renameConversation(requireOwner(request), params.conversationId, body(request)));
  });

  app.get("/conversations/:conversationId/snapshot", async request => {
    const params = request.params as { conversationId: string };
    return service.snapshot(requireOwner(request), params.conversationId);
  });

  app.post("/conversations/:conversationId/messages", async (request, reply) => {
    const params = request.params as { conversationId: string };
    const result = await service.sendMessage(requireOwner(request), params.conversationId, body(request));
    return reply.code(result.status).send(result.receipt);
  });

  app.get("/conversations/:conversationId/messages", async request => {
    const params = request.params as { conversationId: string };
    const query = pageQuery(request);
    const anchor = (request.query as { anchorMessageId?: string }).anchorMessageId;
    return service.listMessages(requireOwner(request), params.conversationId, query.cursor, query.limit, anchor);
  });

  app.get("/conversations/:conversationId/artifacts", async request => {
    const params = request.params as { conversationId: string };
    const query = pageQuery(request);
    return service.listArtifacts(requireOwner(request), params.conversationId, query.cursor, query.limit);
  });

  app.get("/conversations/:conversationId/runs", async request => {
    const params = request.params as { conversationId: string };
    const query = pageQuery(request);
    return service.listRuns(requireOwner(request), params.conversationId, query.cursor, query.limit);
  });

  app.post("/requests/:requestId/stop", async (request, reply) => {
    const params = request.params as { requestId: string };
    return reply.send(service.stopRequest(requireOwner(request), params.requestId, body(request)));
  });

  app.get("/artifacts/:artifactId/revisions/:revisionId", async request => {
    const params = request.params as { artifactId: string; revisionId: string };
    return service.readRevision(requireOwner(request), params.artifactId, params.revisionId);
  });

  app.get("/artifacts/:artifactId", async request => {
    const params = request.params as { artifactId: string };
    return service.readArtifactHead(requireOwner(request), params.artifactId);
  });

  app.post("/conversations/:conversationId/feedback", async (request, reply) => {
    const params = request.params as { conversationId: string };
    const result = service.addFeedback(requireOwner(request), params.conversationId, body(request));
    return reply.code(result.replayed ? 200 : 201).send({ ...result.receipt, replayed: result.replayed });
  });

  app.post("/conversations/:conversationId/proposals", async (request, reply) => {
    const params = request.params as { conversationId: string };
    const result = await service.prepareProposal(requireOwner(request), params.conversationId, body(request));
    return reply.code(result.replayed ? 200 : 201).send(result.proposal);
  });

  app.get("/conversations/:conversationId/proposals", async request => {
    const params = request.params as { conversationId: string };
    const query = pageQuery(request);
    return service.listProposals(requireOwner(request), params.conversationId, query.cursor, query.limit);
  });

  app.get("/proposals/:proposalId", async request => {
    const params = request.params as { proposalId: string };
    return service.readProposal(requireOwner(request), params.proposalId);
  });

  app.post("/proposals/:proposalId/acceptances", async (request, reply) => {
    const params = request.params as { proposalId: string };
    return reply.code(202).send(service.acceptProposal(requireOwner(request), params.proposalId, body(request)));
  });

  app.get("/runs/:runId", async (request, reply) => {
    const params = request.params as { runId: string };
    return reply.send(service.getRun(requireOwner(request), params.runId));
  });

  app.post("/runs/:runId/cancellations", async (request, reply) => {
    const params = request.params as { runId: string };
    return reply.code(202).send(service.cancelRun(requireOwner(request), params.runId, body(request)));
  });

  app.get("/blobs/:blobId/content", async (request, reply) => {
    const params = request.params as { blobId: string };
    const blob = service.readBlob(requireOwner(request), params.blobId);
    reply.header("accept-ranges", "bytes").header("cache-control", "private, no-store").type(blob.mime_type);
    reply.header("content-disposition", `inline; filename="${blob.id}.${blob.mime_type === "audio/mpeg" ? "mp3" : blob.mime_type.split("/")[1]}"`);
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, blob.size_bytes - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), blob.size_bytes - 1) : blob.size_bytes - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start < 0 || start > end || start >= blob.size_bytes) return reply.code(416).header("content-range", `bytes */${blob.size_bytes}`).send();
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${blob.size_bytes}`).header("content-length", end - start + 1).send(createReadStream(blob.path, { start, end }));
    }
    return reply.header("content-length", blob.size_bytes).send(createReadStream(blob.path));
  });

  app.get("/works/:workId", async request => {
    const params = request.params as { workId: string };
    return service.readWork(requireOwner(request), params.workId);
  });

  app.get("/material-batches/:batchId", async request => {
    const params = request.params as { batchId: string };
    return service.readMaterialBatch(requireOwner(request), params.batchId);
  });

  app.get("/messages/:messageId", async request => {
    const params = request.params as { messageId: string };
    return service.readMessage(requireOwner(request), params.messageId);
  });

  app.get("/conversations/:conversationId/events", async (request, reply) => {
    const params = request.params as { conversationId: string };
    const ownerId = requireOwner(request);
    const cursorParam = request.headers["last-event-id"] as string | undefined ?? (request.query as { cursor?: string }).cursor;
    if (!cursorParam) throw new AgentError("INVALID_INPUT", "缺少 cursor 查询参数。");
    return streamEvents(service, ownerId, params.conversationId, cursorParam, request, reply, () => requireOwner(request) === ownerId, streams);
  });
}

function body(request: FastifyRequest): never {
  // 类型安全占位：每个路由按契约类型收窄；这里只负责把 unknown 交给 service 校验。
  return request.body as never;
}

function pageQuery(request: FastifyRequest): { cursor: string | undefined; limit: number | undefined } {
  const query = request.query as { cursor?: string; limit?: string };
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && !Number.isSafeInteger(limit)) {
    throw new AgentError("INVALID_INPUT", "limit 必须是整数。");
  }
  return { cursor: query.cursor, limit };
}

function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// —— SSE ——

async function streamEvents(
  service: AgentService, ownerId: string, conversationId: string, cursorParam: string,
  request: FastifyRequest, reply: FastifyReply, authorized: () => boolean, streams: Set<() => void>,
): Promise<FastifyReply> {
  // 打开连接前做归属与游标检查；保留缺口返回 410 CURSOR_EXPIRED。
  decodeEventCursor(cursorParam, conversationId);
  const db = service.database();
  service.snapshot(ownerId, conversationId); // 归属检查 + 确保会话存在
  const afterSeq = decodeEventCursor(cursorParam, conversationId);
  const minimum = minEventSeq(db, conversationId);
  if (afterSeq > 0 && minimum !== null && minimum > afterSeq + 1) {
    throw new AgentError("CURSOR_EXPIRED", "事件保留缺口，请重新获取快照。");
  }

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.write("retry: 3000\n\n");

  let current = cursorParam;
  let closed = false;
  const hub = service.hub();
  const write = (chunk: string): void => {
    if (!closed) {
      try { if (!authorized()) { raw.end(); return; } } catch { raw.end(); return; }
      raw.write(chunk);
    }
  };

  const pump = (): void => {
    if (closed) return;
    try {
      if (!authorized()) { raw.end(); return; }
      const minimumNow = minEventSeq(db, conversationId);
      const currentSeq = decodeEventCursor(current, conversationId);
      if (currentSeq > 0 && minimumNow !== null && minimumNow > currentSeq + 1) {
        write(`event: reset_required\ndata: ${JSON.stringify({ reason: "cursor_expired" })}\n\n`);
        raw.end();
        return;
      }
      const batch = service.eventsAfter(ownerId, conversationId, current, 200);
      for (const event of batch.events) {
        write(`id: ${event.cursor}\nevent: business\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (batch.events.length > 0) current = batch.nextCursor;
      if (batch.events.length === 200) queueMicrotask(pump);
    } catch { raw.end(); }
  };

  const unsubscribeDeltas = hub.subscribeDeltas(conversationId, delta => {
    write(`event: text.delta\ndata: ${JSON.stringify(delta)}\n\n`);
  });
  // 暂态事件没有持久 id，也不推进游标；断线重连后自然消失。
  const unsubscribeDrafts = hub.subscribeDrafts(conversationId, draft => {
    write(`event: artifact.draft\ndata: ${JSON.stringify(draft)}\n\n`);
  });
  const unsubscribeContext = hub.subscribeContextStatus(conversationId, status => {
    write(`event: context.status\ndata: ${JSON.stringify(status)}\n\n`);
  });
  const unsubscribe = hub.subscribe(conversationId, pump);
  const poll = setInterval(pump, POLL_MS);
  const heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeDeltas();
    unsubscribeDrafts();
    unsubscribeContext();
    streams.delete(closeStream);
  };
  const closeStream = (): void => { shutdown(); raw.end(); };
  streams.add(closeStream);
  raw.once("close", shutdown);

  pump();
  return reply;
}
