import { access } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import fastifyStatic from "@fastify/static";
import {
  CodexBridgeClient,
  CodexPublishCopyWriter,
  CodexScreenwriterAgent,
  CodexVisualDirectorAgent,
  ProductionPipeline,
} from "@video-factory/production-pipeline";
import { buildStudioApp } from "./app.js";
import { readStudioAuthEnvironment } from "./auth.js";
import { readCodexProviderSettings } from "./codex-provider-settings.js";
import { JsonOpportunityStore } from "./opportunity-store.js";
import { buildDirectorAssetProviders, buildProductionWorker } from "./production-worker.js";
import { StudioService } from "./studio-service.js";
import { TrendGateway } from "./trend-gateway.js";
import { CodexTopicIdeaModel, TrendOpportunityAgent } from "./trend-opportunity-agent.js";

const repositoryRoot = await findRepositoryRoot(process.cwd());
loadLocalEnvironment(repositoryRoot);
const workspaceRoot = path.resolve(
  process.env.VIDEO_FACTORY_WORKSPACE ?? path.join(repositoryRoot, "workspace", "factory"),
);
const pythonPath = process.env.PYTHONPATH
  ? `${path.join(repositoryRoot, "src")}${path.delimiter}${process.env.PYTHONPATH}`
  : path.join(repositoryRoot, "src");
const worker = buildProductionWorker({ repositoryRoot, pythonPath, environment: process.env });
// 启动时探测一次宿主机 Codex bridge；不可用时不创建任何 agent，保持规则与模板行为。
const codexSettings = await readCodexProviderSettings(process.env);
// 330s 客户端 deadline > broker 285s 任务 deadline：broker 先终止 codex 并返回明确错误，
// 客户端不重放已受理的任务（至多执行一次）。
const codexClient = codexSettings.available
  ? new CodexBridgeClient({ socketPath: codexSettings.socketPath, timeoutMs: 330_000 })
  : undefined;
const directorAgent = codexClient ? new CodexVisualDirectorAgent({ client: codexClient }) : undefined;
const screenwriterAgent = codexClient ? new CodexScreenwriterAgent({ client: codexClient }) : undefined;
const publishCopyWriter = codexClient ? new CodexPublishCopyWriter({ client: codexClient }) : undefined;
const pipeline = new ProductionPipeline({
  workspaceRoot,
  worker,
  ...(screenwriterAgent ? { screenwriterAgent } : {}),
  ...(directorAgent ? { directorAgent } : {}),
  ...(publishCopyWriter ? { publishCopyWriter } : {}),
  assetProviders: buildDirectorAssetProviders({ environment: process.env }),
});
await pipeline.recoverInterruptedRuns();
const opportunities = new JsonOpportunityStore(path.join(workspaceRoot, "opportunities", "opportunities.json"));
const service = new StudioService({
  repositoryRoot,
  workspaceRoot,
  pipeline,
  opportunities,
  codexAvailability: { available: codexSettings.available, reason: codexSettings.reason },
  ...(codexClient ? {
    trendAgent: new TrendOpportunityAgent({
      signals: new TrendGateway({ environment: process.env }),
      model: new CodexTopicIdeaModel(codexClient),
    }),
  } : {}),
});
const development = process.env.STUDIO_DEV === "1";
const auth = readStudioAuthEnvironment(process.env, { required: !development, secureCookie: !development });
const app = buildStudioApp({ service, logger: true, ...(auth ? { auth } : {}) });

if (!development) {
  await app.register(fastifyStatic, {
    root: path.join(repositoryRoot, "apps", "studio", "dist", "client"),
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "API route was not found." });
    }
    if (request.url === "/favicon.ico") {
      return reply.code(204).send();
    }
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.STUDIO_PORT ?? (development ? 4318 : 4317));
const host = process.env.STUDIO_HOST ?? "127.0.0.1";
await app.listen({ host, port });

function loadLocalEnvironment(repositoryRoot: string): void {
  try {
    loadEnvFile(path.join(repositoryRoot, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function findRepositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, "packages", "production-pipeline", "package.json"));
      await access(path.join(current, "src", "video_factory"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not locate the VideoFactory repository above '${start}'.`);
      }
      current = parent;
    }
  }
}
