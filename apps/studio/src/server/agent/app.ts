import Fastify from "fastify";
import { StudioAuthenticator, type StudioAuthOptions } from "../auth.js";
import { registerHttpMaintenance } from "../http-maintenance.js";
import type { MaintenanceGate } from "../maintenance-gate.js";
import { agentRoutes, type AgentPluginOptions } from "./routes.js";

export function buildFrameApp(options: { agent: AgentPluginOptions; auth?: StudioAuthOptions; maintenanceGate?: MaintenanceGate; logger?: boolean }) {
  // 反代场景只信任显式配置的代理追加的 X-Forwarded-For，使 request.ip 是真实客户端地址，
  // 避免外部扫描者用伪造头把管理员锁出登录限流。默认按裸机/systemd 直反代取环回；
  // Docker Compose 发布端口时容器内对端是网桥网关，需经 STUDIO_TRUST_PROXY 显式放行对应网段。
  const trustProxy = process.env.STUDIO_TRUST_PROXY?.trim() || "127.0.0.1";
  const app = Fastify({ logger: options.logger ?? false, trustProxy });
  const auth = options.auth ? new StudioAuthenticator(options.auth) : undefined;
  registerHttpMaintenance(app, options.maintenanceGate);
  app.get("/api/auth/session", async request => {
    if (!auth) return { enabled: false, authenticated: true };
    const username = auth.authenticatedUsername(request.headers.cookie);
    return username ? { enabled: true, authenticated: true, username } : { enabled: true, authenticated: false };
  });
  app.post("/api/auth/login", async (request, reply) => {
    if (!auth) return { enabled: false, authenticated: true };
    const input = request.body as { username?: unknown; password?: unknown } | null;
    if (!input || typeof input.username !== "string" || typeof input.password !== "string" || !input.username.trim() || !input.password || input.username.length > 128 || input.password.length > 512) {
      return reply.code(400).send({ error: "请输入有效的用户名和密码。" });
    }
    const result = await auth.authenticate(input.username.trim(), input.password, request.ip);
    if (result === "limited") return reply.code(429).send({ error: "登录尝试过多，请稍后再试。" });
    if (result === "rejected") return reply.code(401).send({ error: "用户名或密码不正确。" });
    reply.header("set-cookie", auth.createSessionCookie());
    return { enabled: true, authenticated: true, username: input.username.trim() };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    if (auth && !auth.authenticatedUsername(request.headers.cookie)) return reply.code(401).send({ error: "请先登录。" });
    if (request.headers["x-video-factory-request"] !== "studio") return reply.code(403).send({ error: "请求缺少安全校验。" });
    if (auth) {
      auth.revokeSession(request.headers.cookie);
      reply.header("set-cookie", auth.clearSessionCookie());
    }
    return reply.code(204).send();
  });
  app.register(agentRoutes, { prefix: "/api/agent/v1", ...options.agent,
    resolveOwner: request => auth ? auth.authenticatedUsername(request.headers.cookie) : options.agent.resolveOwner(request), localOwnerOnly: !auth,
  });
  app.get("/api/health", async () => ({ status: "ok", product: "frame", runtime: "pi", ...(process.env.RELEASE_SHA ? { release: process.env.RELEASE_SHA } : {}) }));
  return app;
}
