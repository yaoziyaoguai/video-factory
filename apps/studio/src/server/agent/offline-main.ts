import path from "node:path";
import { existsSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { assembleOfflineAgent, studioRoot } from "./offline.js";

// 增量 A 本地入口：只环回监听、不加载 .env、不接入旧 broker/恢复链路。
// 数据目录默认在仓库 .local 下，绝不写入个人 Documents 路径。

const port = Number(process.env.AGENT_PORT ?? 4390);
const host = "127.0.0.1";
const dataDir = process.env.AGENT_DATA_DIR ?? path.join(studioRoot, ".local/agent-offline");
const uiOrigin = process.env.AGENT_UI_ORIGIN ?? `http://${host}:${port}`;
// 隔离验收可用 AGENT_DIST_DIR 指向 .local 下的构建产物，不覆盖日常 dist。
const distDir = process.env.AGENT_DIST_DIR ?? path.join(studioRoot, "dist", "client");

// 默认隔离体验：Faux 场景工厂兜底（明确标识测试回放；触发输入见 offline-scenario.ts 头注）。
const assembly = await assembleOfflineAgent({ dataDir, uiOrigin, fauxScenario: true, media: {} });

if (existsSync(distDir)) {
  await assembly.app.register(fastifyStatic, { root: distDir, wildcard: false });
  assembly.app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "未找到资源。" });
    }
    // SPA 回退：/agent 与 /agent/:conversationId 直达。
    return reply.sendFile("index.html");
  });
} else {
  assembly.app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ error: "尚未构建前端；先运行 npm run build。" });
  });
}

await assembly.app.listen({ port, host });
process.stdout.write(`${JSON.stringify({ event: "agent-offline-listening", port, uiOrigin, dataDir })}\n`);

const shutdown = async (): Promise<void> => {
  await assembly.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
