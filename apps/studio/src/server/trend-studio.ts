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
    const now = this.options.now().getTime();
    if (!options.forceRefresh && this.candidateCache && this.candidateCache.expiresAt > now) return this.candidateCache.values;
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
      this.candidateCache = { expiresAt: this.options.now().getTime() + 5 * 60 * 1000, values };
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
}
