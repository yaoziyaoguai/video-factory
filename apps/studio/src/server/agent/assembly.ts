import { initializeProviderConnections } from "./provider-connections.js";
import { initializeTextModelSettings } from "./text-model-settings.js";
import { SkillPackages } from "./skill-packages.js";
import path from "node:path";
import { openAgentDatabase, type AgentDatabase } from "./db.js";
import { EventHub } from "./event-log.js";
import { PiRuntimeHost, type PiHostOptions } from "./pi-runtime.js";
import { BusinessTools, buildAgentTools, type CrashPointHook } from "./pi-tools.js";
import { AgentService } from "./agent-service.js";
import { ConversationRunnerRegistry } from "./executor.js";
import { systemClock, type AgentClock } from "./util.js";
import type { ModelBinding, Bootstrap, ImportedSettings } from "../../shared/agent/generated/contracts.js";
import type { PiTextRegistration } from "./text-model-settings.js";
import type { QuoteCatalog } from "./artifact-store.js";
import type { MediaExecutionPort } from "../../shared/agent/ports.js";
import { ProductionBlobs } from "./production-blobs.js";
import { ProductionService } from "./production-service.js";
import { ProductionWorker, type ProductionWorkerOptions } from "./production-worker.js";

export interface AgentRuntimeOptions {
  providerConnections?: boolean;
  importedSettings?: ImportedSettings;
  dataDir: string;
  skillsRoot: string;
  host: Pick<PiHostOptions, "faux" | "fauxContextWindow" | "compaction">;
  /** 隔离/离线装配的静态目录（Faux 文本条目等）；真实文本目录由文本工厂动态提供。 */
  models: Bootstrap["models"];
  /** 静态默认型号（Faux 装配）；有文本工厂时新请求绑定由工厂提供。 */
  defaultModelId: string;
  /** 无媒体工厂时的执行目录；有媒体工厂时目录由工厂提供。每次读取时调用（Bootstrap/每回合 context/prepare/受理共用同一事实）。 */
  catalog?: () => QuoteCatalog;
  clock?: AgentClock;
  crashPoint?: CrashPointHook;
  limits?: { turnMs: number; maxToolCalls: number };
  /** 免费素材替身 fetch 注入口；仅测试用于完整 Pi 链的可控回源。 */
  materials?: { stockFetch?: typeof fetch; cacheRoot?: string | null };
  displayName?: string;
  onHostReady?: (host: PiRuntimeHost) => void;
  /** 文本工厂：在已有 db 上先完成设置初始化（先于 worker 与 Pi 恢复），再返回动态目录与绑定解析。 */
  text?: {
    factory: (db: AgentDatabase) => TextChannel | Promise<TextChannel>;
  };
  media?: {
    /** 媒体工厂：在已有 db/blobs 上先完成设置初始化（先于 worker 与 Pi 恢复），再返回执行端口与同步 current 读取函数。 */
    factory: (db: AgentDatabase, blobs: ProductionBlobs) => MediaChannel;
    pollMs?: number;
    leaseMs?: number;
    crash?: ProductionWorkerOptions["crash"];
    autoStart?: boolean;
  };
}

/** 工厂返回的媒体接线：执行端口 + 当前目录/模型投影。 */
export interface MediaChannel {
  port: MediaExecutionPort;
  /** 当前媒体目录（含 render 条目）；有媒体工厂时它就是全部执行目录。 */
  catalog: () => QuoteCatalog;
  /** 当前媒体目录条目（Bootstrap 与每回合 context 用）；空数组表示媒体不出现在公开目录。 */
  models: () => Bootstrap["models"];
}

/** 工厂返回的文本接线：动态目录、新请求默认绑定与冻结绑定解析、设置读写。 */
export interface TextChannel {
  /** 当前文本目录条目（Bootstrap 与设置投影同一事实源）。 */
  models: () => Bootstrap["models"];
  /** 新消息接收事务冻结的默认绑定；null 表示尚未配置可用文本模型。 */
  defaultBinding: () => ModelBinding | null;
  /** 按冻结绑定解析 Pi 注册事实（版本缺失、缺密钥或退役协议返回 null）。 */
  resolve: (binding: ModelBinding) => PiTextRegistration | null;
}

// 单一业务装配：生产 Studio、隔离入口和测试仅注入不同模型/身份，不复制会话逻辑。
export interface AgentRuntime {
  service: AgentService;
  host: PiRuntimeHost;
  database: AgentDatabase;
  registry: ConversationRunnerRegistry;
  production?: ProductionService;
  worker?: ProductionWorker;
  close(): Promise<void>;
}

export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const db = openAgentDatabase(options.dataDir);
  const clock = options.clock ?? systemClock;
  const hub = new EventHub();
  const blobs = new ProductionBlobs(db, options.dataDir, clock);
  // 工厂内完成设置初始化：先于 host 初始化与队列恢复，新消息绑定与 Pi 注册都读同一事实。
  const textChannel = options.text ? await options.text.factory(db) : undefined;
  const channel = options.media?.factory(db, blobs);
  if (options.providerConnections) {
    // 无文本工厂的隔离装配也要先建设置行，连接初始化才能读取文本视图（真实装配在文本工厂内完成）。
    if (!options.text) initializeTextModelSettings(db, clock);
    initializeProviderConnections(db, options.importedSettings ?? [], clock);
  }
  const port = channel?.port;
  const catalog = channel?.catalog ?? options.catalog ?? (() => ({}));
  const production = new ProductionService(db, clock, hub, catalog, blobs, options.media?.crash, Boolean(port));
  const worker = port ? new ProductionWorker(db, clock, hub, blobs, port, {
    ...(options.media?.pollMs !== undefined ? { pollMs: options.media.pollMs } : {}),
    ...(options.media?.leaseMs !== undefined ? { leaseMs: options.media.leaseMs } : {}),
    ...(options.media?.crash ? { crash: options.media.crash } : {}),
  }) : undefined;
  const skillsRoot = options.skillsRoot;
  const skillPackages = new SkillPackages(options.dataDir, skillsRoot);
  await skillPackages.initialize();
  const host = new PiRuntimeHost({ dataDir: options.dataDir, skillsRoot, skillPackages, ...options.host,
    ...(textChannel ? { textVersions: textChannel.resolve } : {}) });
  await host.init();
  options.onHostReady?.(host);

  // 素材/资讯工具总是装配：未启用时如实 CAPABILITY_UNAVAILABLE，不隐藏工具。
  const businessTools = new BusinessTools(db, clock, catalog, options.crashPoint, blobs, {
    workRoot: path.join(options.dataDir, "material-work"),
    // Pixabay 服务条款要求缓存 API 响应 24h；缓存放在数据目录，不进用户媒体库。
    cacheRoot: options.materials?.cacheRoot ?? path.join(options.dataDir, "stock-cache"),
    ...(options.materials?.stockFetch ? { stockFetch: options.materials.stockFetch } : {}),
  });
  const registry = new ConversationRunnerRegistry({
    db, clock, hub, host,
    ...(channel ? { mediaModels: channel.models } : {}),
    productionAvailable: Boolean(port),
    toolFactory: holder => buildAgentTools(holder, businessTools, skillsRoot, () => skillPackages.resources().skills.map(skill => skill.baseDir)),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.crashPoint ? { crashPoint: options.crashPoint } : {}),
  });

  const service = new AgentService({
    providerConnections: options.providerConnections ?? false,
    importedSettings: options.importedSettings ?? [],
    db, clock, hub, host, registry,
    catalog,
    models: options.models,
    defaultTextBinding: textChannel?.defaultBinding
      ?? (() => options.models.find(model => model.kind === "text" && model.availability === "configured" && model.binding.modelId === options.defaultModelId)?.binding ?? null),
    ...(textChannel ? { textModels: textChannel.models } : {}),
    ...(channel ? { mediaModels: channel.models } : {}),
    skills: () => skillPackages.summaries(),
    skillPackages,
    displayName: options.displayName ?? "本地创作者",
    crashPoint: options.crashPoint,
    ...(production ? { production } : {}),
  });
  service.recover();
  service.startBackground();
  if (options.media?.autoStart !== false) worker?.start();

  return { service, host, database: db, registry, ...(production ? { production } : {}), ...(worker ? { worker } : {}),
    close: async () => { await worker?.close(); await service.close(); await port?.close?.(); if (db.open) db.close(); },
  };
}
