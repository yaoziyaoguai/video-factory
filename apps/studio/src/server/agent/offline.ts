import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildFrameApp } from "./app.js";
import type { FastifyInstance } from "fastify";
import type { FauxProviderHandle, FauxResponseStep } from "@earendil-works/pi-ai";
import { type AgentDatabase } from "./db.js";
import { createAgentRuntime } from "./assembly.js";
import { offlineScenarioFactory } from "./offline-scenario.js";
import { PiRuntimeHost } from "./pi-runtime.js";
import { type CrashPointHook } from "./pi-tools.js";
import { AgentService } from "./agent-service.js";
import { type AgentClock } from "./util.js";
import { systemClock } from "./util.js";
import { FauxMediaPort, type FauxMediaOptions } from "./faux-media.js";
import { initializeArkVideoSettings } from "./ark-video-settings.js";
import type { ProductionService, ProductionCrashHook } from "./production-service.js";
import type { ProductionWorker } from "./production-worker.js";

// 离线装配：真实 HTTP + SQLite + Pi SDK 纵向路径；Faux 只替换模型响应。
// 不读取 .env、不继承 ~/.pi、不注册任何真实供应商；单用户仅限环回地址。

export const FAUX_PROVIDER = "fixture-text";
export const FAUX_TEXT_MODEL = "faux-text";

// tsx 源码与 tsc 的 dist/server/server/agent 输出多一层；两者共用 Studio 的技能和静态资源。
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const studioRoot = existsSync(path.join(sourceRoot, "package.json")) ? sourceRoot : path.dirname(sourceRoot);
export const defaultSkillsRoot = path.join(studioRoot, "skills");

// A 的测试报价 fixture：明确写出，不冒充真实服务免费。render 是显式本地能力条目（模拟执行，不要求 ffmpeg），
// 与真实装配的 render:ordered_concat 同键；媒体模型描述符只含 video/image/speech，render 不作为模型暴露。
export const OFFLINE_QUOTE_CATALOG = {
  "video:faux-video": { binding: { providerId: FAUX_PROVIDER, modelId: "faux-video", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" }, quoteMinor: 1200, priceKind: "bounded" },
  "image:faux-image": { binding: { providerId: FAUX_PROVIDER, modelId: "faux-image", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" }, quoteMinor: 300, priceKind: "bounded" },
  "speech:faux-speech": { binding: { providerId: FAUX_PROVIDER, modelId: "faux-speech", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" }, quoteMinor: 200, priceKind: "bounded" },
  "render:ordered_concat": { binding: null, quoteMinor: 0, priceKind: "bounded" },
  // 离线旅程的 speech+render：narrated 键与真实装配同键，执行仍是样片回放，不代表真实拼接语义。
  "render:narrated_concat": { binding: null, quoteMinor: 0, priceKind: "bounded" },
  // 仅供离线界面/协议旅程回放；真实混音证据由LocalRenderPort测试提供。
  "render:mixed_concat": { binding: null, quoteMinor: 0, priceKind: "bounded" },
} as const;

export interface OfflineAgentOptions {
  limits?: { turnMs: number; maxToolCalls: number };
  dataDir: string;
  uiOrigin: string;
  skillsRoot?: string;
  crashPoint?: CrashPointHook;
  ownerId?: string;
  displayName?: string;
  /** 注入 Faux 输出速率（token/秒），默认瞬时；仅测试用于打开 steer/stop 时间窗。 */
  fauxTokensPerSecond?: number;
  /** 注入 Faux 模型上下文窗口；测试用小窗口触发真实压缩路径。 */
  fauxContextWindow?: number;
  /** 注入压缩参数覆盖（reserveTokens/keepRecentTokens）；enabled 始终开启。 */
  compaction?: { reserveTokens?: number; keepRecentTokens?: number };
  /** 注入业务时钟；测试用于推进提案到期等时间边界。 */
  clock?: AgentClock;
  /** 装配期预装的 Faux 响应；必须在 recover() 唤醒排队请求之前注入，避免空队列竞态。 */
  fauxResponses?: FauxResponseStep[];
  /** 免费素材替身 fetch；仅测试用于完整 Pi 链的可控回源。 */
  stockFetch?: typeof fetch;
  /** 离线入口默认体验：装一个永不枯竭的场景工厂（明确标识测试回放，见 offline-scenario.ts）。 */
  fauxScenario?: boolean;
  media?: Omit<FauxMediaOptions, "fixtureRoot"> & { autoStart?: boolean; leaseMs?: number; crash?: ProductionCrashHook };
}

export interface OfflineAgentAssembly {
  app: FastifyInstance;
  service: AgentService;
  host: PiRuntimeHost;
  faux: FauxProviderHandle | null;
  database: AgentDatabase;
  production?: ProductionService;
  worker?: ProductionWorker;
  close(): Promise<void>;
}

export async function assembleOfflineAgent(options: OfflineAgentOptions): Promise<OfflineAgentAssembly> {
  const runtime = await createAgentRuntime({
    dataDir: options.dataDir, skillsRoot: options.skillsRoot ?? defaultSkillsRoot,
    // 隔离装配同样启用连接设置：模型页走真实初始化/保存事务；文本执行仍用 Faux，不接真实供应商。
    providerConnections: true, importedSettings: [],
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL],
      ...(options.fauxTokensPerSecond === undefined ? {} : { tokensPerSecond: options.fauxTokensPerSecond }) },
      ...(options.fauxContextWindow === undefined ? {} : { fauxContextWindow: options.fauxContextWindow }),
      ...(options.compaction ? { compaction: options.compaction } : {}) },
    models: [{ binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
      name: "Faux 文本模型（离线）", kind: "text", features: ["chat", "tools", "offline-fixture"], availability: "configured",
      verificationNote: "离线 Faux 模型，仅用于流程验证；不读取真实凭据，不发起真实调用。", isDefault: true }],
    defaultModelId: FAUX_TEXT_MODEL, catalog: () => OFFLINE_QUOTE_CATALOG,
    ...(options.clock ? { clock: options.clock } : {}), ...(options.limits ? { limits: options.limits } : {}),
    ...(options.crashPoint ? { crashPoint: options.crashPoint } : {}),
    ...(options.stockFetch ? { materials: { stockFetch: options.stockFetch } } : {}),
    ...(options.media ? { media: {
      ...(options.media.leaseMs !== undefined ? { leaseMs: options.media.leaseMs } : {}),
      ...(options.media.crash ? { crash: options.media.crash } : {}),
      ...(options.media.autoStart !== undefined ? { autoStart: options.media.autoStart } : {}),
      factory: (db, blobs) => {
        // 模型页保存事务只投影视频当前行（v11 后无旧图片/配音通道初始化）；执行仍走 Faux 端口。
        initializeArkVideoSettings(db, { clock: options.clock ?? systemClock });
        return {
          port: new FauxMediaPort(options.dataDir, db, blobs, options.clock ?? systemClock,
            { ...options.media, fixtureRoot: path.join(studioRoot, "fixtures/agent") }),
          catalog: () => OFFLINE_QUOTE_CATALOG,
          models: () => Object.entries(OFFLINE_QUOTE_CATALOG)
            .filter(([, entry]) => entry.binding !== null)
            .map(([key, entry]) => ({ binding: entry.binding!, kind: key.split(":")[0] as "video" | "image" | "speech",
              name: "模拟媒体", features: ["offline-fixture"], availability: "configured" as const, verificationNote: "固定本地样片，仅验证执行与恢复，无真实扣费。", isDefault: false })),
        };
      },
    } } : {}),
    onHostReady: host => {
      // 两套注入都在 recover() 之前完成：测试预装的 fauxResponses 优先于默认场景工厂。
      if (options.fauxResponses && host.faux) {
        host.faux.setResponses(options.fauxResponses);
      } else if (options.fauxScenario && host.faux) {
        // 场景工厂每次被消费前把自己补回队列（种子两份应对并发会话）。
        const factory = offlineScenarioFactory({ selfAppend: () => host.faux?.appendResponses([factory]) });
        host.faux.setResponses([factory, factory]);
      }
    },
  });
  const { service, host, database: db } = runtime;
  const ownerId = options.ownerId ?? "local-owner";
  const app = buildFrameApp({ agent: { service, resolveOwner: () => ownerId, uiOrigin: options.uiOrigin, localOwnerOnly: true } });
  app.addHook("onClose", runtime.close);

  return {
    app, service, host, faux: host.faux, database: db, ...(runtime.production ? { production: runtime.production } : {}), ...(runtime.worker ? { worker: runtime.worker } : {}),
    close: async () => {
      await app.close();
    },
  };
}
