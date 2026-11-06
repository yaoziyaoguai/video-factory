import { connectedTextModels, connectedMediaEnabled, connectedSpeechChoices } from "./agent/provider-connections.js";
import { access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { createAgentRuntime } from "./agent/assembly.js";
import { buildFrameApp } from "./agent/app.js";
import {
  defaultTextBindingOf, initializeTextModelSettings, textRegistrationOf, } from "./agent/text-model-settings.js";
import { ArkMediaPort, RealMediaGateway } from "./agent/ark-media.js";
import { MiniMaxSpeechPort } from "./agent/minimax-speech.js";
import { MiniMaxVideoPort } from "./agent/minimax-video.js";
import { WanVideoPort } from "./agent/wan-video.js";
import { localRenderAvailability, LocalRenderPort } from "./agent/local-render.js";
import {
  arkVideoCatalog, arkVideoModelView, initializeArkVideoSettings, readArkVideoCurrent,
  readLegacyArkConfig, resolveArkBinding,
} from "./agent/ark-video-settings.js";
import {
  additionalMediaCatalog, additionalMediaModelViews, resolveMinimaxSpeechBinding, resolveMinimaxVideoBinding,
  resolveImageBinding, resolveOpenAISpeechBinding, resolveWanVideoBinding,
} from "./agent/additional-media-settings.js";
import { ImageGenerationPort } from "./agent/image-generation.js";
import { OpenAISpeechPort } from "./agent/openai-speech.js";
import { validatorFor } from "./agent/validate.js";
import type { ImportedSettings } from "../shared/agent/generated/contracts.js";
import { systemClock } from "./agent/util.js";
import type { AgentDatabase } from "./agent/db.js";
import type { ProductionBlobs } from "./agent/production-blobs.js";
import { readStudioAuthEnvironment } from "./auth.js";
import { MaintenanceGate } from "./maintenance-gate.js";

const repositoryRoot = await findRepositoryRoot(process.cwd());
const development = process.env.STUDIO_DEV === "1";
const port = Number(process.env.STUDIO_PORT ?? (development ? 4318 : 4317));
const host = process.env.STUDIO_HOST ?? "127.0.0.1";
const workspaceRoot = path.resolve(process.env.VIDEO_FACTORY_WORKSPACE ?? path.join(repositoryRoot, "workspace/factory"));
const auth = readStudioAuthEnvironment(process.env, { required: !development, secureCookie: !development });
const maintenanceDirectory = process.env.VIDEO_FACTORY_MAINTENANCE_DIR?.trim();
const maintenanceGate = new MaintenanceGate(maintenanceDirectory ? { directory: maintenanceDirectory } : {});
await maintenanceGate.announceStartup();
// 文本连接由网页设置管理（SQLite）；旧 AGENT_TEXT_CONFIG_FILE 导入已随旧供应商退役移除，
// 不再读取该文件。不扫描个人 Pi 目录或旧项目凭据。
const agentDataDir = process.env.AGENT_DATA_DIR ?? path.join(workspaceRoot, "agent");
const importedFile = path.join(agentDataDir, "imported-settings.json");
const imported: unknown = existsSync(importedFile) ? JSON.parse(readFileSync(importedFile, "utf8")) : [];
if (!validatorFor("ImportedSettings")(imported).ok) throw new Error("导入配置文件格式不符合 ImportedSettings 契约。");
// 供应商端口按已受理的不可变绑定路由；当前能力来自统一连接投影。
// 旧 JSON 仅在统一设置尚未建立时作受控导入源，凭据读取仍须显式授权与精确历史匹配。
const legacyConfigFile = process.env.AGENT_MEDIA_CONFIG_FILE?.trim() || undefined;
const legacyAuthorized = process.env.AGENT_MEDIA_CREDENTIALS_AUTHORIZED === "1";
const render = await localRenderAvailability();
console.log(`[frame] 媒体通道：视频 Ark Seedance/MiniMax/万相，图片 OpenAI/火山 Seedream，配音 OpenAI/MiniMax（当前能力由统一连接选择）；旧配置${legacyConfigFile ? "已指定，是否导入由数据库资格和凭据授权决定" : "未提供"}；本地拼接${render.available ? `可用${render.aacAvailable ? "" : "（无声；缺少 AAC 编码器，有声拼接未启用）"}` : `不可用：${render.reason}`}`);
const workRoot = path.join(agentDataDir, "media-work");
const runtime = await maintenanceGate.withAdmission("agent-startup", () => createAgentRuntime({
  dataDir: agentDataDir,
  providerConnections: true,
  importedSettings: imported as ImportedSettings,
  skillsRoot: path.join(repositoryRoot, "apps/studio/skills"),
  host: {}, models: [], defaultModelId: "unconfigured",
  text: {
    // 初始化先于 host 与队列恢复；执行版本由统一连接保存投影生成，启动不再读取旧文本配置文件。
    factory: async (db: AgentDatabase) => {
      initializeTextModelSettings(db, systemClock);
      return {
        models: () => connectedTextModels(db),
        defaultBinding: () => defaultTextBindingOf(db),
        resolve: binding => textRegistrationOf(db, binding),
      };
    },
  },
  media: {
    factory: (db: AgentDatabase, blobs: ProductionBlobs) => {
      const legacy = legacyConfigFile ? readLegacyArkConfig(db, legacyConfigFile, legacyAuthorized) : undefined;
      initializeArkVideoSettings(db, { clock: systemClock, ...(legacy ? { legacy } : {}) });
      // B1/B2/M2：图片/配音走 OpenAI 或 MiniMax 通道，视频按 Ark/MiniMax/万相冻结绑定路由；
      // 全部通道由统一连接保存投影 additional_media/ark 版本，网关不做“否则就是 Ark”的默认分支。
      const arkPort = new ArkMediaPort(db, blobs, systemClock, { resolve: binding => resolveArkBinding(db, binding), workRoot });
      const imagePort = new ImageGenerationPort(db, blobs, systemClock, { resolve: binding => resolveImageBinding(db, binding), workRoot });
      const openaiSpeechPort = new OpenAISpeechPort(db, blobs, systemClock, { resolve: binding => resolveOpenAISpeechBinding(db, binding), workRoot });
      const minimaxSpeechPort = new MiniMaxSpeechPort(db, blobs, systemClock, { resolve: binding => resolveMinimaxSpeechBinding(db, binding), workRoot });
      const minimaxVideoPort = new MiniMaxVideoPort(db, blobs, systemClock, { resolve: binding => resolveMinimaxVideoBinding(db, binding), workRoot });
      const wanVideoPort = new WanVideoPort(db, blobs, systemClock, { resolve: binding => resolveWanVideoBinding(db, binding), workRoot });
      return {
        port: new RealMediaGateway(
          new LocalRenderPort(db, blobs, systemClock, { workRoot }),
          {
            resolveProviderPort: binding => {
              if (resolveImageBinding(db, binding)) return imagePort;
              if (resolveOpenAISpeechBinding(db, binding)) return openaiSpeechPort;
              if (resolveMinimaxSpeechBinding(db, binding)) return minimaxSpeechPort;
              if (resolveMinimaxVideoBinding(db, binding)) return minimaxVideoPort;
              if (resolveWanVideoBinding(db, binding)) return wanVideoPort;
              if (resolveArkBinding(db, binding)) return arkPort;
              return null;
            },
            clock: systemClock,
          },
        ),
        catalog: () => ({
          ...arkVideoCatalog(connectedMediaEnabled(db, "video") ? readArkVideoCurrent(db) : null, render),
          ...additionalMediaCatalog(db, render.probeAvailable),
          ...connectedSpeechChoices(db, render.probeAvailable).catalog,
        }),
        models: () => {
          const entries = additionalMediaModelViews(db, render.probeAvailable);
          for (const entry of entries) if (entry.kind === "speech") entry.features.push("当前默认配音");
          for (const choice of connectedSpeechChoices(db, render.probeAvailable).models) {
            if (!entries.some(entry => entry.binding.configurationRevisionId === choice.binding.configurationRevisionId)) entries.push(choice);
          }
          const video = readArkVideoCurrent(db);
          if (video && connectedMediaEnabled(db, "video")) entries.unshift(arkVideoModelView(video, render));
          return entries;
        },
      };
    },
  },
}));
const app = buildFrameApp({ logger: true, ...(auth ? { auth } : {}), maintenanceGate,
  agent: {
    service: runtime.service, resolveOwner: () => "local-owner", localOwnerOnly: !auth,
    uiOrigin: process.env.AGENT_UI_ORIGIN ?? `http://127.0.0.1:${port}`,
  },
});
app.addHook("onClose", runtime.close);
const distDir = path.join(repositoryRoot, "apps/studio/dist/client");
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) return reply.code(404).send({ error: "未找到资源。" });
    return reply.sendFile("index.html");
  });
}
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void app.close().catch(() => { process.exitCode = 1; app.log.error("Frame shutdown failed."); });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await app.listen({ port, host });

async function findRepositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try { await access(path.join(current, "apps/studio/package.json")); return current; }
    catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Could not locate the Frame repository above '${start}'.`);
      current = parent;
    }
  }
}
