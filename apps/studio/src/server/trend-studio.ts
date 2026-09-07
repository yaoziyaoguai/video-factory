import { randomUUID } from "node:crypto";
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
} from "../shared/api.js";
import { canonicalizeSourceUrl, manualSupplementEvidence } from "../shared/api.js";
import { buildTrendSourceCatalog } from "./provider-catalog.js";
import { StudioNotFoundError } from "./studio-errors.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendOpportunityAgent } from "./trend-opportunity-agent.js";

export interface TrendStudioOptions {
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  cachePath?: string;
  cacheTtlMs?: number;
  trendGateway?: Pick<TrendGateway, "listServices" | "listSignals">;
  trendAgent?: Pick<TrendOpportunityAgent, "listCandidates">;
  createRefreshId?: () => string;
}

export interface TrendCandidateReadOptions {
  forceRefresh?: boolean;
}

export class TrendStudio {
  private readonly gateway: Pick<TrendGateway, "listServices" | "listSignals">;
  private readonly agent: Pick<TrendOpportunityAgent, "listCandidates"> | undefined;
  private candidateCache: { expiresAt: number; values: StudioTrendCandidate[] } | undefined;
  private candidateLoading: Promise<StudioTrendCandidate[]> | undefined;
  private candidateLoadingForced = false;
  private queuedRefresh: Promise<StudioTrendCandidate[]> | undefined;
  private cacheHydration: Promise<void> | undefined;
  private nextAutomaticRefreshAt = 0;
  private readonly candidateRefreshes = new Map<string, StudioTrendRefreshStatus>();
  private activeRefreshId: string | undefined;
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
    if (this.options.cachePath) await this.hydrateCache();
    if (this.sourceSupplementsPath()) await this.hydrateSupplements();
    const now = this.options.now().getTime();
    if (!options.forceRefresh && this.candidateCache) {
      if (this.candidateCache.expiresAt <= now && !this.candidateLoading && now >= this.nextAutomaticRefreshAt) {
        this.nextAutomaticRefreshAt = now + AUTOMATIC_REFRESH_RETRY_MS;
        void this.startCandidateLoad(false).catch(() => undefined);
      }
      return this.mergeCandidateSupplements(this.candidateCache.values);
    }
    if (this.candidateLoading) {
      if (!options.forceRefresh || this.candidateLoadingForced) return this.candidateLoading;
      if (this.queuedRefresh) return this.queuedRefresh;
      const current = this.candidateLoading;
      const queued = current.catch(() => undefined).then(() => this.startCandidateLoad(true));
      this.queuedRefresh = queued;
      try {
        return await queued;
      } finally {
        if (this.queuedRefresh === queued) this.queuedRefresh = undefined;
      }
    }
    return this.startCandidateLoad(Boolean(options.forceRefresh));
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

    // 手动刷新如果撞上自动刷新，只跟踪并复用当前任务，不再追加第二套昂贵 Agent Loop。
    const alreadyRunning = Boolean(this.candidateLoading || this.queuedRefresh);
    const loading = this.candidateLoading ?? this.queuedRefresh ?? this.startCandidateLoad(true);
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

  private startCandidateLoad(forceRefresh: boolean): Promise<StudioTrendCandidate[]> {
    const work = (async () => {
      const values = await this.loadCandidates();
      const cachedAt = this.options.now().toISOString();
      // 缓存写入与人工来源写入共用同一进程内文件队列，避免两套原子写交错。
      await this.queueFileMutation(() => this.persistCache({ schemaVersion: CANDIDATE_CACHE_SCHEMA_VERSION, cachedAt, values }));
      // 只有持久化生命周期结束后才发布新缓存，避免调用方看到新值时后台仍在改文件。
      this.candidateCache = { expiresAt: Date.parse(cachedAt) + (this.options.cacheTtlMs ?? DAILY_CACHE_TTL_MS), values };
      this.nextAutomaticRefreshAt = 0;
      return this.mergeCandidateSupplements(values);
    })();
    const loading = work.finally(() => {
      if (this.candidateLoading === loading) {
        this.candidateLoading = undefined;
        this.candidateLoadingForced = false;
      }
    });
    // candidateLoading 代表“生成、持久化并发布”完整生命周期，调用方等待后即可安全读取刷新状态。
    this.candidateLoading = loading;
    this.candidateLoadingForced = forceRefresh;
    return loading;
  }

  private async loadCandidates(): Promise<StudioTrendCandidate[]> {
    if (this.agent) return this.agent.listCandidates();
    return new TrendOpportunityAgent({ signals: this.gateway }).listCandidates();
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
        expiresAt: Date.parse(parsed.cachedAt) + (this.options.cacheTtlMs ?? DAILY_CACHE_TTL_MS),
        values: parsed.values,
      };
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

const DAILY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const AUTOMATIC_REFRESH_RETRY_MS = 60 * 60 * 1000;

interface PersistedCandidateCache {
  // schema 5：选题总编接收 canonical topic 的关联报道，且来源数量门槛改由下游执行。
  // 旧合同可能留下错误空短名单，不能继续复用。
  schemaVersion: typeof CANDIDATE_CACHE_SCHEMA_VERSION;
  cachedAt: string;
  values: StudioTrendCandidate[];
}

const CANDIDATE_CACHE_SCHEMA_VERSION = 5;

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
    && Array.isArray(record.values);
}
