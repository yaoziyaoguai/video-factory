import multipart from "@fastify/multipart";
import { uploadLimits } from "./conversation-uploads.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentService } from "./agent-service.js";
import { AgentError } from "./errors.js";
import { decodeEventCursor } from "./paging.js";
import { maxEventSeq, minEventSeq } from "./event-log.js";
import { requireConversation } from "./conversation-store.js";
import { newAgentId } from "./util.js";
import { createReadStream } from "node:fs";
import { extractVideoFrames, InvalidVideoFile } from "./media-probe.js";

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
  isAdmin?: (ownerId:string)=>boolean;
  /**
   * 已验签会话的过期信息。SSE 握手由 requireOwner 全量验签后，逐帧只做过期时间戳
   * 比对（时钟与会话判定共用），吊销仍由周期性全量复核收敛。本地模式无会话则缺省。
   */
  sessionAuthorization?: {
    expiresAtMs: (request: FastifyRequest) => number | null;
    nowMs: () => number;
  } | undefined;
}

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;
const inlineMedia = new Map([
  ["video/mp4", "mp4"], ["video/webm", "webm"], ["audio/mpeg", "mp3"], ["audio/wav", "wav"],
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"],
]);

declare module "fastify" {
  interface FastifyContextConfig { frameUpload?: boolean }
  interface FastifyRequest {
    agentOwnerId?: string;
  }
}

export function mutationOriginError(request: FastifyRequest, uiOrigin: string): AgentError | undefined {
  if (request.headers.origin !== uiOrigin) return new AgentError("FORBIDDEN", "请求来源不受信任，请从工作台页面操作。");
  if (request.headers["x-video-factory-request"] !== "studio") return new AgentError("FORBIDDEN", "请求缺少安全校验，请刷新页面后重试。");
}

export async function agentRoutes(app: FastifyInstance, options: AgentPluginOptions): Promise<void> {
  await app.register(multipart, { limits: uploadLimits });
  const streams = new Set<() => void>();
  const posters = new Map<string, Buffer>();
  const pendingPosters = new Map<string, Promise<Buffer>>();
  // 同一个不可变媒体只抽一次，小图逐个生成以给实际渲染留出 CPU。
  let posterQueue = Promise.resolve();
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
    const type = request.routeOptions.config.frameUpload ? "multipart/form-data" : "application/json";
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== type) throw new AgentError("INVALID_INPUT", `请使用 ${type} 请求正文。`);
    const rejection = mutationOriginError(request, options.uiOrigin);
    if (rejection) throw rejection;
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    if (request.url.split("?", 1)[0]!.startsWith("/api/agent/v1/blobs/")) {
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("vary", "Cookie").header("cache-control", "private, no-store");
    }
    if(request.routeOptions.url?.startsWith("/api/agent/v1/settings/") && options.isAdmin && !options.isAdmin(requireOwner(request))) throw new AgentError("FORBIDDEN","只有管理员可以管理团队设置。");
    if (request.method === "GET" || request.method === "HEAD") {
      requireOwner(request);
      return;
    }
    guardMutation(request);
    requireOwner(request);
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.routeOptions.config.frameUpload && (request.raw.aborted || reply.raw.destroyed)) return reply.hijack();
    const requestId = newAgentId("req");
    if (error instanceof AgentError) {
      return reply.code(error.statusCode).send({ ...error.toPayload(), requestId });
    }
    const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415) {
      return reply.code(400).send({ ...new AgentError("INVALID_INPUT", request.routeOptions.config.frameUpload ? "上传字段或文件超出允许范围。" : "请求正文不是有效的 JSON 或超过允许大小。").toPayload(), requestId });
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

  app.get("/bootstrap", async request => {
    const owner=requireOwner(request),info=service.bootstrap(owner);
    const admin=options.isAdmin ? options.isAdmin(owner) : true;
    return {...info,accountRole:admin?"admin":"creator",models:admin?info.models:info.models.filter(model=>model.availability==="configured")};
  });
  const stillAdmin = (request: FastifyRequest, ownerId: string) =>
    () => requireOwner(request) === ownerId && (!options.isAdmin || options.isAdmin(ownerId));
  app.get("/settings/accounts", async (_request, reply) =>
    reply.header("cache-control", "private, no-store").send(service.accounts.list()));
  app.post("/settings/accounts", async (request, reply) => {
    const owner = requireOwner(request);
    return reply.code(201).send(await service.accounts.create(owner, body(request), stillAdmin(request, owner)));
  });
  app.patch<{ Params: { username: string } }>("/settings/accounts/:username", async (request, reply) => {
    const owner = requireOwner(request);
    return reply.header("cache-control", "private, no-store")
      .send(await service.accounts.update(owner, request.params.username, body(request), stillAdmin(request, owner)));
  });
  app.get("/settings/budgets",async()=>service.accounts.budgets());
  app.post("/settings/budgets",async(request)=>service.accounts.saveBudget(requireOwner(request),body(request)));
  app.get<{ Querystring: { conversationId?: string } }>("/profile/budget", async (request, reply) => {
    const owner = requireOwner(request), { conversationId } = request.query;
    if (conversationId !== undefined) {
      if (typeof conversationId !== "string") throw new AgentError("INVALID_INPUT", "请提供一个会话 ID。");
      requireConversation(service.database(), owner, conversationId);
    }
    return reply.header("cache-control", "private, no-store").send(service.accounts.budgetSummary(owner, conversationId ?? null));
  });

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

  app.get<{ Params: { connectionId: string } }>("/settings/model-connections/:connectionId/probe", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.probeProviderConnection(request.params.connectionId);
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

  // 目录快照必须注册在参数路由之前，挂载只发一次请求；单服务读取保留给重试与保存后回读。
  app.get("/settings/services", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.readFreeServiceSettingsDirectory(requireOwner(request));
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

  app.get("/storage", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.storageUsage(requireOwner(request));
  });
  app.post("/storage/cleanup", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.cleanupStorage(requireOwner(request), body(request));
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

  app.get<{ Params: { conversationId: string } }>("/conversations/:conversationId", async request =>
    service.readConversation(requireOwner(request), request.params.conversationId));

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

  app.get("/conversations/:conversationId/works", async request => {
    const params = request.params as { conversationId: string };
    const query = pageQuery(request);
    return service.listWorks(requireOwner(request), params.conversationId, query.cursor, query.limit);
  });

  app.post<{ Params: { conversationId: string } }>("/conversations/:conversationId/uploads", { config: { frameUpload: true } }, async (request, reply) => {
    const controller = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", close);
    try {
      const receipt = await service.uploadMedia(requireOwner(request), request.params.conversationId, request.parts(), controller.signal);
      return reply.code(201).send(receipt);
    } finally { reply.raw.off("close", close); }
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

  // 识音会拉起数百 MB 的 python + ffmpeg 子进程：客户端中途断开（刷新、关页）时立即中止并回收。
  // 断连不是路由故障：连接已不在，不回包也不记错误。
  app.post<{Params:{workId:string}}>("/works/:workId/subtitle-tracks",async(request,reply)=>{
    const controller=new AbortController(),close=()=>{if(!reply.raw.writableEnded)controller.abort();};
    reply.raw.once("close",close);
    try{return reply.code(201).send(await service.createSubtitles(requireOwner(request),request.params.workId,body(request),controller.signal));}
    catch(error){if(controller.signal.aborted)return reply.hijack();throw error;}
    finally{reply.raw.off("close",close);}
  });
  app.post<{Params:{artifactId:string}}>("/artifacts/:artifactId/subtitle-revisions",async(request,reply)=>
    reply.code(201).send(service.saveSubtitleRevision(requireOwner(request),request.params.artifactId,body(request))));
  app.get<{Params:{artifactId:string;revisionId:string};Querystring:{format:string}}>("/artifacts/:artifactId/revisions/:revisionId/subtitles",async(request,reply)=>{
    const format=request.query.format,source=service.downloadSubtitles(requireOwner(request),request.params.artifactId,request.params.revisionId,format);
    return reply.type(format==="vtt"?"text/vtt; charset=utf-8":"application/x-subrip; charset=utf-8")
      .header("cache-control", "private, no-store").header("Content-Disposition","attachment; filename=frame-subtitles."+format).send(source);
  });
  app.get<{Params:{runId:string};Querystring:{revisionId:string}}>("/runs/:runId/remix-timeline",async(request)=>service.remixTimeline(requireOwner(request),request.params.runId,request.query.revisionId));
  app.post<{Params:{runId:string}}>("/runs/:runId/remix-proposals",async(request,reply)=>reply.code(201).send(await service.remix(requireOwner(request),request.params.runId,body(request))));
  app.get<{Params:{artifactId:string;revisionId:string};Querystring:{runId?:string}}>("/artifacts/:artifactId/revisions/:revisionId/archive.zip",async(req,reply)=>{
    const {artifactId,revisionId}=req.params;const stream=service.frozenArchive(requireOwner(req),artifactId,revisionId,req.query.runId);
    reply.raw.once("close",()=>{if(!stream.destroyed)stream.destroy();});
    return reply.type("application/zip").header("Cache-Control","private, no-store").header("Content-Disposition","attachment; filename=frame-project.zip").send(stream);
  });
  app.get<{Params:{runId:string};Querystring:{format:string;revisionId?:string}}>("/runs/:runId/export",async(req,reply)=>{
    const stream=await service.editingArchive(requireOwner(req),req.params.runId,req.query.format,req.query.revisionId);
    reply.raw.once("close",()=>{if(!stream.destroyed)stream.destroy();});
    return reply.type("application/zip").header("Cache-Control","private, no-store").header("Content-Disposition","attachment; filename=frame-"+req.query.format+".zip").send(stream);
  });
  app.get("/runs/:runId", async (request, reply) => {
    const params = request.params as { runId: string };
    return reply.send(service.getRun(requireOwner(request), params.runId));
  });

  app.post("/runs/:runId/cancellations", async (request, reply) => {
    const params = request.params as { runId: string };
    return reply.code(202).send(service.cancelRun(requireOwner(request), params.runId, body(request)));
  });

  app.get("/blobs/:blobId/poster", async (request, reply) => {
    const blob = service.readBlob(requireOwner(request), (request.params as { blobId: string }).blobId);
    if (!blob.mime_type.startsWith("video/")) throw new AgentError("NOT_FOUND", "这份媒体没有视频封面。");
    const etag = `"poster-1-${blob.digest}"`;
    reply.header("cache-control", "private, no-cache").header("etag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    let frame = posters.get(blob.digest);
    if (!frame) {
      let pending = pendingPosters.get(blob.digest);
      if (!pending) {
        pending = posterQueue.then(async () => {
          const time = Math.min(1000, Math.floor((blob.duration_ms ?? 0) / 4));
          let frames: Buffer[];
          try { frames = await extractVideoFrames(blob.path, [time], undefined, "poster"); }
          catch (error) {
            if (!time || !(error instanceof InvalidVideoFile)) throw error;
            frames = await extractVideoFrames(blob.path, [0], undefined, "poster");
          }
          const image = frames[0]!;
          if (posters.size >= 64) posters.delete(posters.keys().next().value!);
          posters.set(blob.digest, image);
          return image;
        }).finally(() => pendingPosters.delete(blob.digest));
        pendingPosters.set(blob.digest, pending);
        posterQueue = pending.then(() => {}, () => {});
      }
      frame = await pending;
    }
    return reply.type("image/jpeg").send(frame);
  });

  app.get("/blobs/:blobId/content", async (request, reply) => {
    const params = request.params as { blobId: string };
    const blob = service.readBlob(requireOwner(request), params.blobId);
    const download = (request.query as { download?: string }).download;
    if (download !== undefined && download !== "1") throw new AgentError("INVALID_INPUT", "下载参数只接受 1。");
    const mime = blob.mime_type.split(";", 1)[0]!.trim().toLowerCase();
    const extension = inlineMedia.get(mime);
    const script = /(?:java|ecma)script$/.test(mime) || mime === "text/html" || mime === "image/svg+xml";
    reply.type(script ? "text/plain; charset=utf-8" : mime);
    // 源文件的原名由工程清单提供。省略生成的附件名，让浏览器使用该清单的下载文件名。
    reply.header("content-disposition", extension && download === undefined
      ? `inline; filename="${blob.id}.${extension}"` : "attachment");
    const etag = `"${blob.digest}"`;
    reply.header("accept-ranges", "bytes").header("etag", etag);
    if (extension) reply.header("cache-control", "private, max-age=86400, immutable");
    const matches = request.headers["if-none-match"]?.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag);
    if (matches) return reply.code(304).send();
    const range = !request.headers["if-range"] || request.headers["if-range"] === etag ? request.headers.range : undefined;
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

  app.get("/works/:workId/groups/:groupId/items/:itemId/latest-feedback", async request => {
    const { workId, groupId, itemId } = request.params as { workId: string; groupId: string; itemId: string };
    return { message: service.latestReviewFeedback(requireOwner(request), workId, groupId, itemId) };
  });

  app.get("/works/:workId/groups/:groupId/items/:itemId/approvals", async request => {
    const params = request.params as { workId: string; groupId: string; itemId: string };
    const query = request.query as { cursor?: string };
    return service.listReviewApprovalHistory(requireOwner(request), params.workId, params.groupId, params.itemId, query.cursor);
  });

  app.get("/material-batches/:batchId/candidates/:candidateId/preview", async (request, reply) => {
    const { batchId, candidateId } = request.params as { batchId: string; candidateId: string };
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const video = await service.previewMaterialVideo(requireOwner(request), batchId, candidateId, controller.signal);
    return reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").type(video.mimeType).send(video.stream);
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
    return streamEvents(service, ownerId, params.conversationId, cursorParam, request, reply,
      () => requireOwner(request) === ownerId, streams,
      options.sessionAuthorization ? options.sessionAuthorization.expiresAtMs(request) : null,
      options.sessionAuthorization?.nowMs ?? (() => Date.now()));
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
  sessionExpiresAtMs: number | null, nowMs: () => number,
): Promise<FastifyReply> {
  // 打开连接前做归属与游标检查；保留缺口返回 410 CURSOR_EXPIRED。
  // 归属核对走 requireConversation 轻量查询——此前这里调 snapshot() 全量组装
  // （P1 重连事件流重复读取作品状态：客户端已取快照，握手又逐作品查 50 次定稿）。
  decodeEventCursor(cursorParam, conversationId);
  const db = service.database();
  requireConversation(db, ownerId, conversationId);
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
    "x-content-type-options": "nosniff",
  });
  raw.write("retry: 3000\n\n");

  let current = cursorParam;
  let closed = false;
  const hub = service.hub();

  // 审计第二阶段：帧写路径不再每帧重做 Cookie HMAC 验签与 JSON 解析。
  // 握手由路由层 requireOwner 全量验签后，这里取已验签负载中的过期时间戳逐帧比对
  // （时钟与会话判定共用，过期收敛与逐帧验签等价）；会话吊销（登出）仍由
  // 每 5 秒一次的全量复核收敛，与吊销的最迟收敛窗口同宽。
  const sessionExpired = (): boolean => sessionExpiresAtMs !== null && nowMs() >= sessionExpiresAtMs;
  let authorizationCheckedAt = 0;
  let authorizationValid = true;
  const authorizedRecently = (): boolean => {
    if (sessionExpired()) return false;
    const currentMs = nowMs();
    if (currentMs - authorizationCheckedAt >= POLL_MS) {
      authorizationCheckedAt = currentMs;
      try { authorizationValid = authorized(); } catch { authorizationValid = false; }
    }
    return authorizationValid;
  };

  // 背压：raw.write 返回 false 后套接字缓冲已过高位线，继续写会在内存里无界堆积。
  // 持久事件由游标重传，遇背压立即收流，客户端按 Last-Event-ID 重连补齐；暂态帧
  // （delta/草稿/进度）没有持久 id，丢失即无法重传——同样收流而不是静默丢帧：
  // 客户端重连后取新快照恢复，进行中预览按序列守卫失效重建，绝不拼接缺字的文字。
  let flowing = true;
  raw.on("drain", () => { flowing = true; });
  const write = (chunk: string): boolean => {
    if (closed || !flowing) return false;
    if (!authorizedRecently()) { closeStream(); return false; }
    if (!raw.write(chunk)) flowing = false;
    return true;
  };

  const pump = (): void => {
    if (closed) return;
    try {
      if (!authorizedRecently()) { closeStream(); return; }
      const minimumNow = minEventSeq(db, conversationId);
      const currentSeq = decodeEventCursor(current, conversationId);
      if (currentSeq > 0 && minimumNow !== null && minimumNow > currentSeq + 1) {
        write(`event: reset_required\ndata: ${JSON.stringify({ reason: "cursor_expired" })}\n\n`);
        raw.end();
        return;
      }
      const batch = service.eventsAfter(ownerId, conversationId, current, 200);
      for (const event of batch.events) {
        if (!write(`id: ${event.cursor}\nevent: business\ndata: ${JSON.stringify(event)}\n\n`)) {
          closeStream();
          return;
        }
        current = event.cursor;
      }
      if (batch.events.length === 200) queueMicrotask(pump);
    } catch { raw.end(); }
  };

  const unsubscribeDeltas = hub.subscribeDeltas(conversationId, delta => {
    if (!write(`event: text.delta\ndata: ${JSON.stringify(delta)}\n\n`)) closeStream();
  });
  // 暂态事件没有持久 id，也不推进游标；断线重连后自然消失。写不进（背压/收流）时
  // 立即收流，让客户端重连取新快照，而不是留下一段拼错的实时预览。
  const unsubscribeDrafts = hub.subscribeDrafts(conversationId, draft => {
    if (!write(`event: artifact.draft\ndata: ${JSON.stringify(draft)}\n\n`)) closeStream();
  });
  const unsubscribeContext = hub.subscribeContextStatus(conversationId, status => {
    if (!write(`event: context.status\ndata: ${JSON.stringify(status)}\n\n`)) closeStream();
  });
  const unsubscribeProgress = hub.subscribeProgress(conversationId, progress => {
    if (!write(`event: request.progress\ndata: ${JSON.stringify(progress)}\n\n`)) closeStream();
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
    unsubscribeProgress();
    streams.delete(closeStream);
  };
  const closeStream = (): void => { shutdown(); raw.end(); };
  streams.add(closeStream);
  raw.once("close", shutdown);

  pump();
  return reply;
}
