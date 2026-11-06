import { randomUUID } from "node:crypto";
import { holdMaintenanceWork } from "@video-factory/production-pipeline/maintenance";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StudioTrendCandidate,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTrendSource,
  StudioTrendRefreshReceipt,
  StudioTrendRefreshStatus,
  StudioTopicGenerationReceipt,
} from "../shared/api.js";
import { canonicalizeSourceUrl, manualSupplementEvidence, StudioInputError } from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendOpportunityAgent } from "./trend-opportunity-agent.js";

export interface TrendStudioOptions {
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  cachePath?: string;
  trendGateway?: Pick<TrendGateway, "listServices" | "listSignals">;
  trendAgent?: Pick<TrendOpportunityAgent, "listCandidates"> & Partial<Pick<TrendOpportunityAgent, "generationReceipt" | "reviseCandidate">>;
  createRefreshId?: () => string;
  /** C3-E02：“换一批”的生成身份来源（默认随机 UUID）。 */
  createGenerationNonce?: () => string;
}

export interface TrendCandidateReadOptions {
  forceRefresh?: boolean;
}

export class TrendStudio {
  private readonly gateway: Pick<TrendGateway, "listServices" | "listSignals">;
  private readonly agent: (Pick<TrendOpportunityAgent, "listCandidates"> & Partial<Pick<TrendOpportunityAgent, "generationReceipt" | "reviseCandidate">>) | undefined;
  private candidateCache: { cachedAt: string; values: StudioTrendCandidate[] } | undefined;
  private candidateLoading: Promise<StudioTrendCandidate[]> | undefined;
  private cacheHydration: Promise<void> | undefined;
  private readonly candidateRefreshes = new Map<string, StudioTrendRefreshStatus>();
  private activeRefreshId: string | undefined;
  private lastGenerationReceipt: StudioTopicGenerationReceipt | undefined;
  // 人工补充来源与候选缓存分开持久化：后台刷新只重写缓存，补充永不丢失，也不延长缓存 TTL。
  private readonly sourceSupplements = new Map<string, { evidenceUrls: string[]; updatedAt: string }>();
  private supplementsHydration: Promise<void> | undefined;
  private fileMutations: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TrendStudioOptions) {
    this.gateway = options.trendGateway ?? new TrendGateway({ environment: options.environment });
    this.agent = options.trendAgent;
  }

  async listSources(): Promise<StudioTrendSource[]> {
    return buildTrendSourceCatalog(this.options.environment, await this.gateway.listServices());
  }

  listServices(): Promise<StudioTrendService[]> {
    return this.gateway.listServices();
  }

  listSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]> {
    return this.gateway.listSignals(input);
  }

  async listCandidates(options: TrendCandidateReadOptions = {}): Promise<StudioTrendCandidate[]> {
    if (!options.forceRefresh) return this.snapshotCandidates();
    if (this.options.cachePath) await this.hydrateCache();
    if (this.sourceSupplementsPath()) await this.hydrateSupplements();
    return this.candidateLoading ?? this.startCandidateLoad();
  }

  // 页面读取不是收费授权：空缓存返回空集合，过期缓存仍可查看和采用。
  // 只有用户显式刷新才调用模型；已有刷新进行中时，读取也不追加或等待新请求。
  async snapshotCandidates(): Promise<StudioTrendCandidate[]> {
    if (this.options.cachePath) await this.hydrateCache();
    if (this.sourceSupplementsPath()) await this.hydrateSupplements();
    return this.candidateCache ? this.mergeCandidateSupplements(this.candidateCache.values) : [];
  }

  isRefreshing(): boolean {
    return Boolean(this.candidateLoading);
  }

  /** 维护排空口径：共享的热点抓取链路 settle 后才解除占用（R3）。 */
  activeWork(): Promise<unknown> {
    return this.candidateLoading ?? Promise.resolve();
  }

  async requestCandidateRefresh(): Promise<StudioTrendRefreshReceipt> {
    if (this.options.cachePath) await this.hydrateCache();
    const active = this.activeRefreshId ? this.candidateRefreshes.get(this.activeRefreshId) : undefined;
    if (active?.state === "running") {
      return { refreshId: active.refreshId, status: "already_running", requestedAt: active.requestedAt };
    }

    const requestedAt = this.options.now().toISOString();
    const refreshId = (this.options.createRefreshId ?? randomUUID)();
    const status: StudioTrendRefreshStatus = { refreshId, state: "running", requestedAt };
    this.recordRefresh(status);
    this.activeRefreshId = refreshId;

    // 多个显式刷新入口只跟踪并复用当前任务，不追加第二套昂贵 Agent Loop。
    const alreadyRunning = Boolean(this.candidateLoading);
    const loading = this.candidateLoading ?? this.startCandidateLoad();
    void loading.then((values) => {
      this.finishRefresh(refreshId, { state: "succeeded", candidateCount: values.length });
    }).catch(() => {
      this.finishRefresh(refreshId, {
        state: "failed",
        error: "热点来源或选题总编暂时不可用，请稍后手动重试。",
      });
    });
    return { refreshId, status: alreadyRunning ? "already_running" : "started", requestedAt };
  }

  candidateRefreshStatus(refreshId: string): StudioTrendRefreshStatus | undefined {
    return this.candidateRefreshes.get(refreshId);
  }

  latestGenerationReceipt(): StudioTopicGenerationReceipt | undefined {
    return this.lastGenerationReceipt ? structuredClone(this.lastGenerationReceipt) : undefined;
  }

  // 人工补充来源：只追加、不覆盖原 evidence；与候选已有 URL 幂等去重；
  // 写入必须等原子写成功才返回，不延长候选缓存的 cachedAt/TTL。
  async appendCandidateSources(candidateId: string, evidenceUrls: string[]): Promise<StudioTrendCandidate> {
    if (this.sourceSupplementsPath()) await this.hydrateSupplements();
    if (!this.candidateCache) await this.listCandidates();
    return this.queueFileMutation(async () => {
      const candidate = this.candidateCache?.values.find((item) => item.id === candidateId);
      if (!candidate) {
        throw new StudioNotFoundError("这条候选已被采用或已经失效，请刷新候选收件箱。");
      }
      const existing = new Set(candidate.evidence
        .map((item) => canonicalEvidenceKey(item.evidenceUrl))
        .filter(Boolean));
      const previous = this.sourceSupplements.get(candidateId);
      for (const url of previous?.evidenceUrls ?? []) existing.add(url);
      const additions = [...new Set(evidenceUrls.map((url) => canonicalizeSourceUrl(url)))]
        .filter((url) => !existing.has(url));
      if (additions.length === 0) {
        // 与候选已有证据或既往补充幂等重复：不重写文件，直接返回当前合并结果。
        return this.mergeCandidateSupplements([candidate])[0]!;
      }
      const merged = [...(previous?.evidenceUrls ?? []), ...additions];
      const updatedAt = this.options.now().toISOString();
      // 整个读改写都在同一队列内；先落盘再更新内存，失败绝不返回假成功。
      const next = new Map(this.sourceSupplements);
      next.set(candidateId, { evidenceUrls: merged, updatedAt });
      await this.persistSupplements(next);
      this.sourceSupplements.clear();
      for (const [id, entry] of next) this.sourceSupplements.set(id, entry);
      return this.mergeCandidateSupplements([{ ...candidate }])[0]!;
    });
  }

  // 修订候选只产稿：调用模型的单次修订（零审计），修订稿以「本版未审」身份追加进收件箱，
  // 原候选与其审计状态保持不变。必须绑定用户看到的候选包版本，刷新后旧目标失效。
  async reviseCandidate(candidateId: string, expectedGenerationId: string, instruction: string): Promise<StudioTrendCandidate> {
    if (this.options.cachePath) await this.hydrateCache();
    if (this.sourceSupplementsPath()) await this.hydrateSupplements();
    const trimmed = typeof instruction === "string" ? instruction.trim() : "";
    if (!trimmed || [...trimmed].length > 4_000) {
      throw new StudioInputError("修订意见需要 1 到 4000 字；超长时请删减后再发送，原文字不会被截断。");
    }
    if (!this.agent?.reviseCandidate) {
      throw new StudioConflictError("当前没有可用的候选修订模型；原候选保持不变。");
    }
    const current = this.candidateCache?.values.find((item) => item.id === candidateId);
    if (!current) {
      throw new StudioNotFoundError("这条候选已经不在收件箱中，请刷新候选列表后再试。");
    }
    if (current.generationId !== expectedGenerationId) {
      throw new StudioConflictError("候选列表已经刷新，你看到的这版候选已被替换；请刷新后对最新候选重新发送修订意见。");
    }
    const revised = await this.agent.reviseCandidate({ candidate: current, instruction: trimmed });
    const entry: StudioTrendCandidate = {
      ...revised,
      generationId: `topic-rev-${(this.options.createGenerationNonce ?? randomUUID)()}`,
      auditStatus: "not_audited",
      revisedFrom: { candidateId, generationId: expectedGenerationId, instruction: trimmed },
    };
    // 缓存写盘与读取共用同一队列：先持久化整包，成功后才把修订候选发布进内存缓存。
    await this.queueFileMutation(async () => {
      const cache = this.candidateCache;
      if (!cache) return;
      const next = { ...cache, values: [...cache.values, entry] };
      await this.persistCache({
        schemaVersion: CANDIDATE_CACHE_SCHEMA_VERSION,
        cachedAt: cache.cachedAt,
        values: next.values,
        ...(this.lastGenerationReceipt ? { generationReceipt: this.lastGenerationReceipt } : {}),
      });
      this.candidateCache = next;
    });
    return entry;
  }

  private mergeCandidateSupplements(values: StudioTrendCandidate[]): StudioTrendCandidate[] {
    if (this.sourceSupplements.size === 0) return values;
    return values.map((candidate) => {
      const supplement = this.sourceSupplements.get(candidate.id);
      if (!supplement) return candidate;
      const known = new Set(candidate.evidence
        .map((item) => canonicalEvidenceKey(item.evidenceUrl))
        .filter(Boolean));
      const additions = supplement.evidenceUrls
        .filter((url) => !known.has(canonicalizeSourceUrl(url)))
        .map((url) => manualSupplementEvidence(url, supplement.updatedAt));
      if (additions.length === 0) return candidate;
      return { ...candidate, evidence: [...candidate.evidence, ...additions] };
    });
  }

  private sourceSupplementsPath(): string | undefined {
    if (!this.options.cachePath) return undefined;
    return this.options.cachePath.replace(/\.json$/, "-sources.json");
  }

  private hydrateSupplements(): Promise<void> {
    if (!this.supplementsHydration) this.supplementsHydration = this.readPersistedSupplements();
    return this.supplementsHydration;
  }

  private async readPersistedSupplements(): Promise<void> {
    const supplementsPath = this.sourceSupplementsPath();
    if (!supplementsPath) return;
    try {
      const parsed = JSON.parse(await readFile(supplementsPath, "utf8")) as unknown;
      if (!isPersistedSourceSupplements(parsed)) {
        throw new Error("人工补充来源记录的数据格式不正确。");
      }
      for (const [id, entry] of Object.entries(parsed.supplements)) {
        this.sourceSupplements.set(id, { evidenceUrls: [...entry.evidenceUrls], updatedAt: entry.updatedAt });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`人工补充来源记录无法读取，已停止继续写入：${detail}`);
    }
  }

  private async persistSupplements(supplements: Map<string, { evidenceUrls: string[]; updatedAt: string }>): Promise<void> {
    const supplementsPath = this.sourceSupplementsPath();
    if (!supplementsPath) return;
    const directory = path.dirname(supplementsPath);
    const temporaryPath = `${supplementsPath}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      const file: PersistedSourceSupplements = {
        version: 1,
        supplements: Object.fromEntries([...supplements].map(([id, entry]) => [id, { ...entry }])),
      };
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(temporaryPath, supplementsPath);
    } catch (error) {
      // 人工来源写入失败必须向上抛出，让调用方看到保存失败而不是假成功。
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private queueFileMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.fileMutations.then(operation, operation);
    this.fileMutations = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private finishRefresh(
    refreshId: string,
    result: Pick<StudioTrendRefreshStatus, "state" | "candidateCount" | "error">,
  ): void {
    const current = this.candidateRefreshes.get(refreshId);
    if (!current || current.state !== "running") return;
    this.candidateRefreshes.set(refreshId, {
      ...current,
      ...result,
      finishedAt: this.options.now().toISOString(),
    });
    if (this.activeRefreshId === refreshId) this.activeRefreshId = undefined;
  }

  private recordRefresh(status: StudioTrendRefreshStatus): void {
    this.candidateRefreshes.set(status.refreshId, status);
    while (this.candidateRefreshes.size > 20) {
      const oldest = this.candidateRefreshes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.candidateRefreshes.delete(oldest);
    }
  }

  private startCandidateLoad(): Promise<StudioTrendCandidate[]> {
    const work = (async () => {
      // C3-E02：只有显式刷新（换一批）能到这里，同信号下使用新的生成身份。
      const values = await this.loadCandidates((this.options.createGenerationNonce ?? randomUUID)());
      const cachedAt = this.options.now().toISOString();
      const generationReceipt = this.agent?.generationReceipt?.()
        ?? generationReceiptFromCandidates(values, cachedAt, this.agent
          ? undefined
          : "选题总编任务在本次启动时没有就绪，本轮只生成了本地规则保底线索。");
      const versionedValues = values.map((candidate) => ({
        ...candidate,
        generationId: generationReceipt.generationId,
        ...(generationReceipt.auditStatus ? { auditStatus: generationReceipt.auditStatus } : {}),
      }));
      // 缓存写入与人工来源写入共用同一进程内文件队列，避免两套原子写交错。
      await this.queueFileMutation(() => this.persistCache({ schemaVersion: CANDIDATE_CACHE_SCHEMA_VERSION, cachedAt, values: versionedValues, generationReceipt }));
      // 只有持久化生命周期结束后才发布新缓存，避免调用方看到新值时后台仍在改文件。
      this.candidateCache = { cachedAt, values: versionedValues };
      this.lastGenerationReceipt = generationReceipt;
      return this.mergeCandidateSupplements(versionedValues);
    })();
    const loading = work.finally(() => {
      if (this.candidateLoading === loading) {
        this.candidateLoading = undefined;
      }
    });
    // candidateLoading 代表“生成、持久化并发布”完整生命周期，调用方等待后即可安全读取刷新状态。
    this.candidateLoading = loading;
    holdMaintenanceWork(loading);
    return loading;
  }

  private async loadCandidates(generationNonce?: string): Promise<StudioTrendCandidate[]> {
    if (this.agent) return this.agent.listCandidates({ ...(generationNonce ? { generationNonce } : {}) });
    return new TrendOpportunityAgent({ signals: this.gateway }).listCandidates(
      { ...(generationNonce ? { generationNonce } : {}) },
    );
  }

  private hydrateCache(): Promise<void> {
    if (!this.cacheHydration) this.cacheHydration = this.readPersistedCache();
    return this.cacheHydration;
  }

  private async readPersistedCache(): Promise<void> {
    if (!this.options.cachePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.options.cachePath, "utf8")) as unknown;
      if (!isPersistedCandidateCache(parsed)) return;
      this.candidateCache = {
        cachedAt: parsed.cachedAt,
        values: parsed.values,
      };
      this.lastGenerationReceipt = parsed.generationReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }

  private async persistCache(cache: PersistedCandidateCache): Promise<void> {
    if (!this.options.cachePath) return;
    const directory = path.dirname(this.options.cachePath);
    const temporaryPath = `${this.options.cachePath}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.options.cachePath);
    } catch {
      // 缓存持久化失败不应让在线候选不可用，内存缓存仍然生效。
    }
  }
}


interface PersistedCandidateCache {
  // schema 6：选题总编新合同增加 audienceDemand（观众需求）评分，旧候选没有这个分，
  // 复用会让一整屏"看起来评过"的候选缺掉本轮唯一判断"有没有人看"的维度。
  schemaVersion: typeof CANDIDATE_CACHE_SCHEMA_VERSION;
  cachedAt: string;
  values: StudioTrendCandidate[];
  generationReceipt?: StudioTopicGenerationReceipt;
}

const CANDIDATE_CACHE_SCHEMA_VERSION = 6;

interface PersistedSourceSupplements {
  version: 1;
  supplements: Record<string, { evidenceUrls: string[]; updatedAt: string }>;
}

function isPersistedSourceSupplements(value: unknown): value is PersistedSourceSupplements {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.supplements !== "object" || record.supplements === null) return false;
  return Object.values(record.supplements).every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const supplement = entry as Record<string, unknown>;
    return Array.isArray(supplement.evidenceUrls)
      && supplement.evidenceUrls.every((url) => typeof url === "string")
      && typeof supplement.updatedAt === "string";
  });
}

function canonicalEvidenceKey(evidenceUrl: string | undefined): string {
  if (!evidenceUrl) return "";
  try {
    return canonicalizeSourceUrl(evidenceUrl);
  } catch {
    // 历史证据里可能存有不完全合法的链接；保留原样但不当成可去重键。
    return "";
  }
}

function isPersistedCandidateCache(value: unknown): value is PersistedCandidateCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === CANDIDATE_CACHE_SCHEMA_VERSION
    && typeof record.cachedAt === "string"
    && Number.isFinite(Date.parse(record.cachedAt))
    && Array.isArray(record.values)
    && (record.generationReceipt === undefined || isTopicGenerationReceipt(record.generationReceipt));
}

function generationReceiptFromCandidates(
  values: StudioTrendCandidate[],
  generatedAt: string,
  unavailableReason?: string,
): StudioTopicGenerationReceipt {
  const modelCandidate = values.find((candidate) => candidate.providerId !== "trend-heuristic-v1");
  const fallback = values.find((candidate) => candidate.generationFallback)?.generationFallback;
  return {
    // 固定时钟下的两次刷新也必须是不同候选包；时间戳不能当不可变版本身份。
    generationId: `topic-${randomUUID()}`,
    generatedAt,
    modelInvoked: Boolean(modelCandidate || fallback),
    source: modelCandidate ? "editor-model" : "rule-fallback",
    candidateCount: values.length,
    ...(modelCandidate ? { providerId: modelCandidate.providerId } : {}),
    // 模型真跑过就会留下 generationFallback；既没有候选也没有 fallback，只剩"任务根本没起来"
    // 这一种解释。不写原因的话，用户看到的只是一屏规则候选，永远不知道总编为什么没给建议。
    ...(fallback
      ? { failureCategory: fallback.category, failureReason: fallback.reason }
      : !modelCandidate && unavailableReason
        ? { failureCategory: "model_unavailable" as const, failureReason: unavailableReason }
        : {}),
  };
}

function isTopicGenerationReceipt(value: unknown): value is StudioTopicGenerationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.generationId === "string"
    && typeof receipt.generatedAt === "string" && Number.isFinite(Date.parse(receipt.generatedAt))
    && typeof receipt.modelInvoked === "boolean"
    && (receipt.source === "editor-model" || receipt.source === "rule-fallback")
    && Number.isInteger(receipt.candidateCount) && Number(receipt.candidateCount) >= 0;
}

// 免费趋势数据源目录（自托管/导入类）。原先位于旧供应商目录 provider-catalog.ts，
// 该目录已随旧文本/图片/配音供应商退役删除；这里是它仅存的现行消费者。
export function buildTrendSourceCatalog(
  environment: NodeJS.ProcessEnv,
  localServices: StudioTrendService[] = [],
): StudioTrendSource[] {
  const douyinCredentialsConfigured =
    environment.DOUYIN_HOTSEARCH_ENABLED === "1" && Boolean(environment.DOUYIN_CLIENT_TOKEN);
  const localReady = (id: StudioTrendService["id"]) => localServices.some((service) => service.id === id && service.status === "ready");
  return [
    {
      id: "manual-research",
      label: "人工研究",
      kind: "native",
      status: "ready",
      description: "录入已经人工核验的热点、搜索词或评论信号。",
      cadence: "随时",
    },
    {
      id: "json-import",
      label: "结构化 JSON",
      kind: "import",
      status: "ready",
      description: "批量导入带来源声明、时间和证据链接的结构化信号。",
      cadence: "按需",
    },
    {
      id: "trendradar-import",
      label: "TrendRadar 自托管",
      kind: "import",
      status: localReady("trendradar") ? "ready" : "needs_config",
      description: "本地聚合中文热榜、RSS、排名轨迹与历史 SQLite，并为 Agent 提供 MCP 分析入口。",
      cadence: "建议 30 分钟",
      requirement: localReady("trendradar") ? "本地采集器与 Web 报告已通过健康检查" : "需单独部署旧版 TrendRadar",
      docsUrl: "https://github.com/sansan0/TrendRadar",
    },
    {
      id: "newsnow-import",
      label: "NewsNow 自托管",
      kind: "import",
      status: localReady("newsnow") ? "ready" : "needs_config",
      description: "本地热点快照接口，提供微博、知乎、B 站、财经与中文新闻源。",
      cadence: "建议 30 分钟",
      requirement: localReady("newsnow") ? "本地 API 已接入统一热点网关" : "运行 make setup-local-trends",
      docsUrl: "https://github.com/ourongxing/newsnow",
    },
    {
      id: "dailyhot-import",
      label: "DailyHotApi",
      kind: "import",
      status: localReady("dailyhot") ? "ready" : "needs_config",
      description: "本地统一 JSON / RSS 热榜接口，补充抖音、微博、快手、百度和垂类榜单。",
      cadence: "建议 30-60 分钟",
      requirement: localReady("dailyhot") ? "本地 API 已接入统一热点网关" : "需单独部署 DailyHot",
      docsUrl: "https://github.com/imsyy/DailyHotApi",
    },
    {
      id: "rsshub-import",
      label: "RSSHub 中文世界",
      kind: "import",
      status: localReady("rsshub") ? "ready" : "needs_config",
      description: "补充港台、新马、海外中文媒体和垂直社区，不把新闻更新误当成平台热度。",
      cadence: "按 Feed 更新",
      requirement: localReady("rsshub") ? "本地 RSS 路由服务已通过健康检查" : "需单独部署 RSSHub",
      docsUrl: "https://docs.rsshub.app/deploy/",
    },
    {
      id: "douyin-hotsearch",
      label: "抖音官方热点",
      kind: "native",
      status: "needs_config",
      description: "官方热点权限可作为后续数据源；当前版本尚未实现自动采集适配器。",
      cadence: "约 2 小时",
      requirement: douyinCredentialsConfigured
        ? "已检测到授权配置；仍需实现并验证官方热点采集适配器"
        : "需要获批 hotsearch scope、配置授权，并实现官方热点采集适配器",
      docsUrl: "https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180573594794065975",
    },
    {
      id: "newrank-import",
      label: "新榜数据",
      kind: "commercial",
      status: "manual_only",
      description: "在商业 API 合同确定前，以 CSV/JSON 导入保存来源边界。",
      cadence: "按购买方案",
      requirement: "需要商业数据授权",
      docsUrl: "https://data.newrank.cn/",
    },
    {
      id: "ocean-engine-import",
      label: "巨量算数",
      kind: "import",
      status: "manual_only",
      description: "用于人工研究关键词趋势，暂不假设存在可公开自动调用的 API。",
      cadence: "人工观察",
      docsUrl: "https://www.oceanengine.com/insight/juliang-suanshu-yidongduan",
    },
  ];
}
