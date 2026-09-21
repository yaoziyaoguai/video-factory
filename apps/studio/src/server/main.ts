import { access } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import fastifyStatic from "@fastify/static";
import {
  CodexBridgeClient,
  CodexAssetSemanticRanker,
  CodexReferenceGrammarAgent,
  CodexPublishCopyWriter,
  FallbackCodexTaskClient,
  ProductionPipeline,
  type ProductionPipelineOptions,
} from "@video-factory/production-pipeline";
import { buildStudioApp } from "./app.js";
import { readStudioAuthEnvironment } from "./auth.js";
import {
  readCodexProviderSettings,
  readDeepseekCodexProviderSettings,
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
import { buildRoleAgentAssembly } from "./role-agent-assembly.js";
import { CodexSeriesPlanningAgent } from "./series-planning-agent.js";
import { StudioService } from "./studio-service.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendArticleReader } from "./trend-article-reader.js";
import { CodexTopicIdeaModel, TrendOpportunityAgent } from "./trend-opportunity-agent.js";
import { ModelConnections } from "./model-connections.js";
import { AudioReviewService } from "./audio-review-service.js";

const repositoryRoot = await findRepositoryRoot(process.cwd());
loadLocalEnvironment(repositoryRoot);
// 模型供应商凭据只属于宿主机 broker；即使误放进 Studio 环境也立即移除。
delete process.env.DEEPSEEK_API_KEY;
const workspaceRoot = path.resolve(
  process.env.VIDEO_FACTORY_WORKSPACE ?? path.join(repositoryRoot, "workspace", "factory"),
);
const creatorSettings = new JsonCreatorSettingsStore(path.join(workspaceRoot, "settings", "creator-settings.json"));
const pythonPath = process.env.PYTHONPATH
  ? `${path.join(repositoryRoot, "src")}${path.delimiter}${process.env.PYTHONPATH}`
  : path.join(repositoryRoot, "src");
// 启动时探测一次宿主机 Codex bridge；不可用时不创建任何 agent，保持规则与模板行为。
// ChatGPT/Codex 套餐已退役（用户指令 2026-09-18）：不再创建 codex broker 客户端，
// 全部角色只走 DeepSeek broker。codex-* 的 provider id 作为遗留名保留以兼容历史 run。
const [deepseekCodexSettings] = await Promise.all([
  readDeepseekCodexProviderSettings(process.env),
]);
const deepseekCodexClient = deepseekCodexSettings.available
  ? new CodexBridgeClient({ socketPath: deepseekCodexSettings.socketPath, timeoutMs: 2_460_000 })
  : undefined;
const modelConnections = new ModelConnections(deepseekCodexSettings.socketPath);
await modelConnections.refresh().catch(() => { process.stderr.write("Model connection management is unavailable; existing configured models remain in use.\n"); });
// 顺序即首选：DeepSeek 排在最前，所以 `auditedModelFor` 取到的默认模型是它。用户手动配置
// 只影响候选的取舍，不改这里的顺序。
const auditedTaskCandidates = [
  ...(deepseekCodexClient && deepseekCodexSettings.taskKinds.includes("role-audit") ? [{
    client: deepseekCodexClient,
    providerId: "deepseek",
    modelId: deepseekCodexSettings.modelId,
    ...(deepseekCodexSettings.modelCandidates ? { modelCandidates: deepseekCodexSettings.modelCandidates } : {}),
    taskKinds: deepseekCodexSettings.taskKinds,
    sessionMode: "stateless" as const,
    ...(deepseekCodexSettings.taskModels ? { taskModels: deepseekCodexSettings.taskModels } : {}),
  }] : []),
];
const configuredTaskCandidates = () => modelConnections.connections.map(({ model, client }) => ({
  client, providerId: model.id, modelId: model.id, enabled: model.enabled,
  taskKinds: [
    ...(model.capabilities.includes("text") ? ["topic-ideas", "series-roadmap", "creative-treatment", "director-plan", "script-draft", "publish-copy", "creative-discussion"] : []),
    ...(model.capabilities.includes("image") ? ["asset-rank", "reference-grammar", "visual-review"] : []),
    "role-audit",
  ], sessionMode: "stateless" as const,
}));
const auditedTaskClient = new FallbackCodexTaskClient({ candidates: [...auditedTaskCandidates, ...configuredTaskCandidates()] });
const auditedModelFor = (taskKind: string) => {
  const candidate = [...auditedTaskCandidates, ...configuredTaskCandidates().filter((item) => item.enabled)].find((item) => item.taskKinds.includes(taskKind));
  return (candidate && "taskModels" in candidate ? candidate.taskModels?.[taskKind] : undefined) || candidate?.modelId || "codex-default";
};
const publishCopyWriter = new CodexPublishCopyWriter({ client: auditedTaskClient });
const assetSemanticRanker = new CodexAssetSemanticRanker({
  client: auditedTaskClient,
  modelId: auditedModelFor("asset-rank"),
});
const reviewMedia = new PythonReviewMediaPreprocessor({
  repositoryRoot,
  pythonPath,
  pythonCommand: resolveProductionPython(repositoryRoot, process.env),
  environment: process.env,
});
const referenceGrammarAgent = new CodexReferenceGrammarAgent({
  client: auditedTaskClient,
  media: reviewMedia,
  modelId: auditedModelFor("reference-grammar"),
});
const soundReview = new AudioReviewService({ connections: () => modelConnections.connections, media: reviewMedia });
const assembleRoles = () => {
  const assembly = buildRoleAgentAssembly({
  deepseekCodexSettings,
  ...(deepseekCodexClient ? { deepseekCodexClient } : {}),
  reviewMedia,
  environment: process.env,
  connectedModels: modelConnections.connections,
  });
  return { ...assembly, visualReviewAgents: assembly.visualReviewAgents.map((agent) => soundReview.wrap(agent)) };
};
const { screenwriterAgent, directorAgent, visualReviewAgents, treatmentAgents, briefAuditAgents } = assembleRoles();
const pipelineOptions: ProductionPipelineOptions = {
  workspaceRoot,
  worker: buildProductionWorker({
    repositoryRoot,
    pythonPath,
    environment: process.env,
    runsRoot: path.join(workspaceRoot, "runs"),
    visualReviewAgents,
  }),
  ...(screenwriterAgent ? { screenwriterAgent } : {}),
  ...(directorAgent ? { directorAgent } : {}),
  ...(treatmentAgents.length > 0 ? { treatmentAgents } : {}),
  ...(briefAuditAgents.length > 0 ? { briefAuditAgents } : {}),
  ...(publishCopyWriter ? { publishCopyWriter } : {}),
  ...(assetSemanticRanker ? { assetSemanticRanker } : {}),
  ...(referenceGrammarAgent ? { referenceGrammarAgent } : {}),
  referenceVideoRoot: path.join(workspaceRoot, "uploads", "reference-videos"),
  ...(visualReviewAgents.length > 0 ? { visualReviewAgents } : {}),
  assetProviders: buildDirectorAssetProviders({ environment: process.env }),
  providerRuntimeMetadata: buildProductionProviderRuntimeMetadata(process.env),
};
const pipeline = new ProductionPipeline(pipelineOptions);
modelConnections.onChange = () => {
  const assembly = assembleRoles();
  // 保持 worker 持有的数组引用；已开始的角色调用持有自己的候选快照。
  visualReviewAgents.splice(0, visualReviewAgents.length, ...assembly.visualReviewAgents);
  Object.assign(pipelineOptions, assembly, { visualReviewAgents });
  if (!assembly.screenwriterAgent) delete pipelineOptions.screenwriterAgent;
  if (!assembly.directorAgent) delete pipelineOptions.directorAgent;
  auditedTaskClient?.updateCandidates([...auditedTaskCandidates, ...configuredTaskCandidates()]);
};
await pipeline.recoverInterruptedRuns();
const opportunities = new JsonOpportunityStore(path.join(workspaceRoot, "opportunities", "opportunities.json"));
const service = new StudioService({
  registeredModels: () => modelConnections.connections.map(({ model }) => model),
  repositoryRoot,
  workspaceRoot,
  pipeline,
  opportunities,
  codexAvailability: {
    available: false,
    reason: "ChatGPT/Codex 套餐已退役：全部角色改用 DeepSeek 模型。",
    taskKinds: [],
  },
  deepseekCodexAvailability: {
    available: deepseekCodexSettings.available,
    reason: deepseekCodexSettings.reason,
    taskKinds: deepseekCodexSettings.taskKinds,
    modelId: deepseekCodexSettings.modelId,
    ...(deepseekCodexSettings.taskModels ? { taskModels: deepseekCodexSettings.taskModels } : {}),
    ...(deepseekCodexSettings.modelCandidates ? { modelCandidates: deepseekCodexSettings.modelCandidates } : {}),
  },
  ...{
    seriesPlanningAgent: new CodexSeriesPlanningAgent(
      auditedTaskClient,
      3,
      path.join(workspaceRoot, "checkpoints", "series-showrunner"),
      async () => (await creatorSettings.get()).modelDefaults?.["codex-series-showrunner-v1"],
    ),
  },
  ...{
    trendAgent: new TrendOpportunityAgent({
      signals: new TrendGateway({ environment: process.env }),
      articleReader: new TrendArticleReader({ cacheRoot: path.join(workspaceRoot, "cache", "trend-articles") }),
      model: new CodexTopicIdeaModel(
        auditedTaskClient,
        3,
        path.join(workspaceRoot, "checkpoints", "topic-editor"),
        async () => (await creatorSettings.get()).modelDefaults?.["api-topic-editor-v1"],
      ),
      strategy: async () => (await creatorSettings.get()).topicStrategy,
    }),
  },
  creatorSettings,
});
const development = process.env.STUDIO_DEV === "1";
const auth = readStudioAuthEnvironment(process.env, { required: !development, secureCookie: !development });
const app = buildStudioApp({ service, modelConnections, logger: true, ...(auth ? { auth } : {}) });
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
