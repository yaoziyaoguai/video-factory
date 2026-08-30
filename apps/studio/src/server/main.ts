import { access } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import fastifyStatic from "@fastify/static";
import {
  CodexBridgeClient,
  CodexAssetSemanticRanker,
  CodexReferenceGrammarAgent,
  CodexPublishCopyWriter,
  CodexScreenwriterAgent,
  CodexVisualReviewAgent,
  CodexVisualDirectorAgent,
  ProductionPipeline,
} from "@video-factory/production-pipeline";
import { buildStudioApp } from "./app.js";
import { readStudioAuthEnvironment } from "./auth.js";
import {
  readCodexProviderSettings,
  readZaiCodexProviderSettings,
  resolveZaiVisualReviewModelId,
} from "./codex-provider-settings.js";
import { JsonCreatorSettingsStore } from "./creator-settings-store.js";
import { JsonOpportunityStore } from "./opportunity-store.js";
import {
  buildDirectorAssetProviders,
  buildProductionProviderRuntimeMetadata,
  buildProductionWorker,
  resolveProductionPython,
} from "./production-worker.js";
import { PythonReviewMediaPreprocessor } from "./review-media-preprocessor.js";
import { CodexSeriesPlanningAgent } from "./series-planning-agent.js";
import { StudioService } from "./studio-service.js";
import { TrendGateway } from "./trend-gateway.js";
import { CodexTopicIdeaModel, TrendOpportunityAgent } from "./trend-opportunity-agent.js";

const repositoryRoot = await findRepositoryRoot(process.cwd());
loadLocalEnvironment(repositoryRoot);
// BigModel 凭据只属于宿主机 broker；新旧变量即使误放进 Studio 环境也立即移除。
delete process.env.ZAI_BIGMODEL_API_KEY;
delete process.env.ZAI_API_KEY;
const workspaceRoot = path.resolve(
  process.env.VIDEO_FACTORY_WORKSPACE ?? path.join(repositoryRoot, "workspace", "factory"),
);
const creatorSettings = new JsonCreatorSettingsStore(path.join(workspaceRoot, "settings", "creator-settings.json"));
const pythonPath = process.env.PYTHONPATH
  ? `${path.join(repositoryRoot, "src")}${path.delimiter}${process.env.PYTHONPATH}`
  : path.join(repositoryRoot, "src");
const worker = buildProductionWorker({ repositoryRoot, pythonPath, environment: process.env });
// 启动时探测一次宿主机 Codex bridge；不可用时不创建任何 agent，保持规则与模板行为。
const [codexSettings, zaiCodexSettings] = await Promise.all([
  readCodexProviderSettings(process.env),
  readZaiCodexProviderSettings(process.env),
]);
const codexModelId = codexSettings.modelId || process.env.VIDEO_FACTORY_CODEX_MODEL?.trim() || "codex-default";
const zaiVisualReviewModelId = zaiCodexSettings.modelId || resolveZaiVisualReviewModelId(process.env);
// 单并发 broker 中，21 分钟覆盖一个 10 分钟在途任务、一个完整执行和传输余量；
// 生产任务会插队尚未开始的热点任务，客户端仍不重放已受理任务。
const codexClient = codexSettings.available
  ? new CodexBridgeClient({ socketPath: codexSettings.socketPath, timeoutMs: 1_260_000 })
  : undefined;
const zaiCodexClient = zaiCodexSettings.available
  ? new CodexBridgeClient({ socketPath: zaiCodexSettings.socketPath, timeoutMs: 1_260_000 })
  : undefined;
const directorAgent = codexClient ? new CodexVisualDirectorAgent({ client: codexClient }) : undefined;
const screenwriterAgent = codexClient ? new CodexScreenwriterAgent({ client: codexClient }) : undefined;
const publishCopyWriter = codexClient ? new CodexPublishCopyWriter({ client: codexClient }) : undefined;
const assetSemanticRanker = codexClient ? new CodexAssetSemanticRanker({
  client: codexClient,
  modelId: codexModelId,
}) : undefined;
const reviewMedia = new PythonReviewMediaPreprocessor({
  repositoryRoot,
  pythonPath,
  pythonCommand: resolveProductionPython(repositoryRoot, process.env),
  environment: process.env,
});
const referenceGrammarAgent = codexClient ? new CodexReferenceGrammarAgent({
  client: codexClient,
  media: reviewMedia,
  modelId: codexModelId,
}) : undefined;
const visualReviewAgents = [
  ...(zaiCodexClient ? [new CodexVisualReviewAgent({
      client: zaiCodexClient,
      media: reviewMedia,
      providerId: "glm-visual-review-v1",
      modelId: zaiVisualReviewModelId,
    })] : []),
  ...(codexClient ? [new CodexVisualReviewAgent({
      client: codexClient,
      media: new PythonReviewMediaPreprocessor({
        repositoryRoot,
        pythonPath,
        pythonCommand: resolveProductionPython(repositoryRoot, process.env),
        environment: process.env,
      }),
      providerId: "codex-visual-review-v1",
      modelId: codexModelId,
    })] : []),
];
const pipeline = new ProductionPipeline({
  workspaceRoot,
  worker,
  ...(screenwriterAgent ? { screenwriterAgent } : {}),
  ...(directorAgent ? { directorAgent } : {}),
  ...(publishCopyWriter ? { publishCopyWriter } : {}),
  ...(assetSemanticRanker ? { assetSemanticRanker } : {}),
  ...(referenceGrammarAgent ? { referenceGrammarAgent } : {}),
  referenceVideoRoot: path.join(workspaceRoot, "uploads", "reference-videos"),
  ...(visualReviewAgents.length > 0 ? { visualReviewAgents } : {}),
  assetProviders: buildDirectorAssetProviders({ environment: process.env }),
  providerRuntimeMetadata: buildProductionProviderRuntimeMetadata(process.env),
});
await pipeline.recoverInterruptedRuns();
const opportunities = new JsonOpportunityStore(path.join(workspaceRoot, "opportunities", "opportunities.json"));
const service = new StudioService({
  repositoryRoot,
  workspaceRoot,
  pipeline,
  opportunities,
  codexAvailability: { available: codexSettings.available, reason: codexSettings.reason, taskKinds: codexSettings.taskKinds, modelId: codexSettings.modelId },
  zaiCodexAvailability: { available: zaiCodexSettings.available, reason: zaiCodexSettings.reason, taskKinds: zaiCodexSettings.taskKinds, modelId: zaiCodexSettings.modelId },
  ...(codexClient ? {
    seriesPlanningAgent: new CodexSeriesPlanningAgent(
      codexClient,
      3,
      path.join(workspaceRoot, "checkpoints", "series-showrunner"),
    ),
    trendAgent: new TrendOpportunityAgent({
      signals: new TrendGateway({ environment: process.env }),
      model: new CodexTopicIdeaModel(
        codexClient,
        3,
        path.join(workspaceRoot, "checkpoints", "topic-editor"),
      ),
      strategy: async () => (await creatorSettings.get()).topicStrategy,
    }),
  } : {}),
  creatorSettings,
});
const development = process.env.STUDIO_DEV === "1";
const auth = readStudioAuthEnvironment(process.env, { required: !development, secureCookie: !development });
const app = buildStudioApp({ service, logger: true, ...(auth ? { auth } : {}) });
const interruptedRecoveryTimer = setInterval(() => {
  void pipeline.recoverInterruptedRuns().catch(() => {
    app.log.error("Interrupted production recovery failed; the next recovery cycle will retry.");
  });
}, 30_000);
interruptedRecoveryTimer.unref();
app.addHook("onClose", async () => {
  clearInterval(interruptedRecoveryTimer);
});

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
