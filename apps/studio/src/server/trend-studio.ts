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
    if (this.candidateLoading) return this.candidateLoading;
    const loading = this.loadCandidates();
    this.candidateLoading = loading;
    try {
      const values = await loading;
      this.candidateCache = { expiresAt: now + 5 * 60 * 1000, values };
      return values;
    } finally {
      if (this.candidateLoading === loading) this.candidateLoading = undefined;
    }
  }

  private async loadCandidates(): Promise<StudioTrendCandidate[]> {
    if (this.agent) return this.agent.listCandidates();
    return new TrendOpportunityAgent({ signals: this.gateway }).listCandidates();
  }
}
