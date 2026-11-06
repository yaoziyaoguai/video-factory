import type { FastifyInstance, FastifyRequest } from "fastify";
import { StudioMaintenanceError, type Admission, type MaintenanceGate } from "./maintenance-gate.js";
import { runWithMaintenanceAdmission } from "@video-factory/production-pipeline/maintenance";

const MAINTENANCE_EXEMPT_ROUTES = /^\/api\/(?:auth|health)(?:\/|$)/;
const MAINTENANCE_WORK_GET_ROUTES = /^\/api\/(?:series|cases|candidate-inbox)(?:\/|$)/;

// 新入口与既有 API 复用同一准入边界，不引入旧流水线的恢复或角色装配。
export function registerHttpMaintenance(app: FastifyInstance, maintenanceGate?: MaintenanceGate): void {
  let closing = false;
  app.addHook("preClose", async () => { closing = true; });

  if (maintenanceGate) {
    const pendingAdmissions = new Set<Promise<Admission>>();
    app.addHook("preClose", async () => {
      if (pendingAdmissions.size === 0) return;
      // 断连时准入可能仍在等共享锁；必须接住随后返回的 token 并完成释放。
      const keepAlive = setInterval(() => undefined, 1_000);
      try {
        while (pendingAdmissions.size > 0) await Promise.allSettled([...pendingAdmissions]);
      } finally { clearInterval(keepAlive); }
    });
    // ALS 必须包住实际 handler；仅在异步 onRequest 中 enter/run 不能保证后继 hook 继承。
    app.addHook("onRoute", (route) => {
      const handler = route.handler;
      route.handler = function (request, reply) {
        const token = (request as FastifyRequest & { maintenanceAdmission?: Admission }).maintenanceAdmission;
        if (!token) return handler.call(this, request, reply);
        if (reply.raw.destroyed) return reply;
        return runWithMaintenanceAdmission(token, () => {
          const running = Promise.resolve(handler.call(this, request, reply));
          token.hold(running);
          return running;
        });
      };
    });
    app.addHook("onRequest", async (request, reply) => {
      const routeUrl = request.routeOptions.url ?? "";
      if (!routeUrl || MAINTENANCE_EXEMPT_ROUTES.test(routeUrl)) return;
      const method = request.method.toUpperCase();
      const isWork = (method !== "GET" && method !== "HEAD") || MAINTENANCE_WORK_GET_ROUTES.test(routeUrl);
      if (!isWork) return;
      if (closing) return reply.code(503).send({ error: "服务正在关闭，请稍后重试。" });
      let token: Admission;
      const admitting = maintenanceGate.admit(routeUrl);
      pendingAdmissions.add(admitting);
      try {
        token = await admitting;
      } catch (error) {
        if (error instanceof StudioMaintenanceError) {
          // agent 路由按契约 Error 形状拒绝；其余沿用旧 {error} 结构。
          if (routeUrl.startsWith("/api/agent/")) {
            reply.header("retry-after", "30");
            return await reply.code(503).send({
              code: "TEMPORARILY_UNAVAILABLE",
              message: "系统维护进行中，工作台操作暂缓；已受理的工作不受影响。",
              requestId: "maintenance",
              retryAction: "wait",
              currentRevisionId: null,
            });
          }
          reply.header("retry-after", "30");
          return await reply.code(503).send({
            error: `系统维护进行中（${error.state === "draining" ? "正在排空在途工作" : "已冻结写入"}），新操作暂缓；已受理的工作不受影响，稍后会自动恢复。`,
            maintenance: { state: error.state, owner: error.owner },
          });
        }
        throw error;
      } finally { pendingAdmissions.delete(admitting); }
      if (closing || reply.raw.destroyed) {
        await maintenanceGate.release(token);
        return reply.code(503).send({ error: "服务正在关闭，请稍后重试。" });
      }
      (request as FastifyRequest & { maintenanceAdmission?: Admission }).maintenanceAdmission = token;
      // 断连也结束 HTTP 所有权；handler 与动态登记的后台链仍由 token.hold 保留。
      reply.raw.once("close", () => {
        void maintenanceGate.release(token).catch(() => app.log.error("Maintenance admission release failed; drain remains blocked."));
      });
    });
    app.addHook("onResponse", async (request) => {
      const token = (request as FastifyRequest & { maintenanceAdmission?: Admission }).maintenanceAdmission;
      if (token) await maintenanceGate.release(token);
    });
  }

}
