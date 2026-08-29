import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StudioTrendCandidate,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTrendSource,
} from "../shared/api.js";
import { buildTrendSourceCatalog } from "./provider-catalog.js";
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
    const now = this.options.now().getTime();
    if (!options.forceRefresh && this.candidateCache) {
      if (this.candidateCache.expiresAt <= now && !this.candidateLoading && now >= this.nextAutomaticRefreshAt) {
        this.nextAutomaticRefreshAt = now + AUTOMATIC_REFRESH_RETRY_MS;
        void this.startCandidateLoad(false).catch(() => undefined);
      }
      return this.candidateCache.values;
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

  private async startCandidateLoad(forceRefresh: boolean): Promise<StudioTrendCandidate[]> {
    const loading = this.loadCandidates();
    this.candidateLoading = loading;
    this.candidateLoadingForced = forceRefresh;
    try {
      const values = await loading;
      const cachedAt = this.options.now().toISOString();
      this.candidateCache = { expiresAt: Date.parse(cachedAt) + (this.options.cacheTtlMs ?? DAILY_CACHE_TTL_MS), values };
      this.nextAutomaticRefreshAt = 0;
      await this.persistCache({ schemaVersion: 1, cachedAt, values });
      return values;
    } finally {
      if (this.candidateLoading === loading) {
        this.candidateLoading = undefined;
        this.candidateLoadingForced = false;
      }
    }
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
  schemaVersion: 1;
  cachedAt: string;
  values: StudioTrendCandidate[];
}

function isPersistedCandidateCache(value: unknown): value is PersistedCandidateCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.cachedAt === "string"
    && Number.isFinite(Date.parse(record.cachedAt))
    && Array.isArray(record.values);
}
