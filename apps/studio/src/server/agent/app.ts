import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { StudioAuthenticator, type StudioAuthOptions } from "../auth.js";
import { agentRoutes, mutationOriginError, type AgentPluginOptions } from "./routes.js";

export function buildFrameApp(options: { agent: AgentPluginOptions; auth?: StudioAuthOptions; logger?: boolean }) {
  // 反代场景只信任显式配置的代理追加的 X-Forwarded-For，使 request.ip 是真实客户端地址，
  // 避免外部扫描者用伪造头把管理员锁出登录限流。默认按裸机/systemd 直反代取环回；
  // Docker Compose 发布端口时容器内对端是网桥网关，需经 STUDIO_TRUST_PROXY 显式放行对应网段。
  const trustProxy = process.env.STUDIO_TRUST_PROXY?.trim() || "127.0.0.1";
  const app = Fastify({ logger: options.logger ?? false, trustProxy });
  const accounts=options.agent.service.accounts;
  if(options.auth) accounts.bootstrap(options.auth.username,options.auth.passwordHash);
  const auth=options.auth ? new StudioAuthenticator({...options.auth,findAccount:name=>accounts.find(name)}) : undefined;
  app.get("/api/auth/session", async request => {
    if (!auth) return { enabled: false, authenticated: true };
    const account = auth.authenticatedAccount(request.headers.cookie);
    return account ? { enabled: true, authenticated: true, username: account.username, ownerId: account.id }
      : { enabled: true, authenticated: false };
  });
  const publicUrl = new URL(options.agent.uiOrigin);
  const publicHosts = new Set([publicUrl.host]);
  if (!publicUrl.port) publicHosts.add(publicUrl.hostname + (publicUrl.protocol === "https:" ? ":443" : ":80"));
  const checkOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    const rejection = mutationOriginError(request, options.agent.uiOrigin);
    if (rejection) return reply.code(rejection.statusCode).send({ code: rejection.code, error: rejection.message });
    const host = request.headers.host;
    if (!host || !publicHosts.has(host.toLowerCase())) return reply.code(403).send({ code: "FORBIDDEN", error: "请从已配置的工作台地址登录或退出。" });
  };
  app.post("/api/auth/login", { onRequest: checkOrigin }, async (request, reply) => {
    if (!auth) return { enabled: false, authenticated: true };
    const input = request.body as { username?: unknown; password?: unknown } | null;
    if (!input || typeof input.username !== "string" || typeof input.password !== "string" || !input.username.trim() || !input.password || input.username.length > 128 || input.password.length > 512) {
      return reply.code(400).send({ error: "请输入有效的用户名和密码。" });
    }
    const result = await auth.authenticate(input.username.trim(), input.password, request.ip);
    if (result === "limited") return reply.code(429).send({ error: "登录尝试过多，请稍后再试。" });
    if (result === "rejected") return reply.code(401).send({ error: "用户名或密码不正确。" });
    reply.header("set-cookie", auth.createSessionCookie(result));
    return { enabled: true, authenticated: true, username: result.username, ownerId: result.id };
  });
  app.post("/api/auth/logout", { onRequest: checkOrigin }, async (request, reply) => {
    if (auth && !auth.authenticatedAccount(request.headers.cookie)) return reply.code(401).send({ error: "请先登录。" });
    if (auth) {
      auth.revokeSession(request.headers.cookie);
      reply.header("set-cookie", auth.clearSessionCookie());
    }
    return reply.code(204).send();
  });
  app.register(agentRoutes, { prefix: "/api/agent/v1", ...options.agent,
    resolveOwner: request => {
      if(!auth) return options.agent.resolveOwner(request);
      return auth.authenticatedAccount(request.headers.cookie)?.id;
    },isAdmin:ownerId=>!auth || options.agent.service.accounts.isAdmin(ownerId), localOwnerOnly: !auth,
    sessionAuthorization: auth ? { expiresAtMs: request => auth.sessionExpiryMs(request.headers.cookie), nowMs: () => auth.nowMs() } : undefined,
  });
  app.get("/api/health", async (_request, reply) => {
    const health = await options.agent.service.health();
    return reply.code(health.status === "ok" ? 200 : 503).send(health);
  });
  return app;
}
