import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  StartRunResponse,
  StudioArtifactResource,
  StudioCandidateAdoptionInput,
  StudioCandidateInbox,
  StudioCandidateInboxQuery,
  StudioCreatorSettings,
  StudioCreatorSettingsPatch,
  StudioDecisionInput,
  StudioHealth,
  StudioLocalCapability,
  StudioOpportunity,
  StudioOpportunityInput,
  StudioOpportunityStatus,
  StudioProvider,
  StudioPublishBatch,
  StudioPublishInput,
  StudioPublishReadiness,
  StudioRunDetail,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesInput,
  StudioTrendCandidate,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTrendSource,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";
import { CapabilityStudio } from "./capability-studio.js";
import { CandidateInboxStudio } from "./candidate-inbox-studio.js";
import { JsonCreatorSettingsStore, type CreatorSettingsRepository } from "./creator-settings-store.js";
import type { LocalCapabilityService } from "./local-capabilities.js";
import { OpportunityStudio } from "./opportunity-studio.js";
import { JsonOpportunityStore, type StudioOpportunityRepository } from "./opportunity-store.js";
import { ProductionStudio, type StudioPipelinePort } from "./production-studio.js";
import { buildPublishTargetCatalog, PublishingStudio, type PlatformPublisher } from "./publishing-studio.js";
import { SeriesStudio } from "./series-studio.js";
import { JsonSeriesStore, type StudioSeriesRepository } from "./series-store.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendOpportunityAgent } from "./trend-opportunity-agent.js";
import { TrendStudio } from "./trend-studio.js";

export { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
export type { StudioPipelinePort } from "./production-studio.js";

export interface StudioServiceOptions {
  workspaceRoot: string;
  repositoryRoot?: string;
  pipeline: StudioPipelinePort;
  opportunities?: StudioOpportunityRepository;
  environment?: NodeJS.ProcessEnv;
  commandAvailable?: (command: string) => Promise<boolean>;
  now?: () => Date;
  createId?: () => string;
  localCapabilities?: Pick<LocalCapabilityService, "report" | "listVoices" | "preview">;
  trendGateway?: Pick<TrendGateway, "listServices" | "listSignals">;
  trendAgent?: Pick<TrendOpportunityAgent, "listCandidates">;
  series?: StudioSeriesRepository;
  createSeriesId?: () => string;
  creatorSettings?: CreatorSettingsRepository;
  publishers?: PlatformPublisher[];
}

/**
 * 稳定的 Studio 外部入口。领域行为分别收拢在四个深模块中，路由层不需要知道其组装方式。
 */
export class StudioService {
  private readonly capabilities: CapabilityStudio;
  private readonly trends: TrendStudio;
  private readonly opportunities: OpportunityStudio;
  private readonly series: SeriesStudio;
  private readonly candidateInbox: CandidateInboxStudio;
  private readonly production: ProductionStudio;
  private readonly publishing: PublishingStudio;
  private readonly creatorSettings: CreatorSettingsRepository;

  constructor(options: StudioServiceOptions) {
    const repositoryRoot = options.repositoryRoot ?? process.cwd();
    const environment = options.environment ?? process.env;
    const now = options.now ?? (() => new Date());
    this.capabilities = new CapabilityStudio({
      repositoryRoot,
      workspaceRoot: options.workspaceRoot,
      environment,
      ...(options.commandAvailable ? { commandAvailable: options.commandAvailable } : {}),
      ...(options.localCapabilities ? { localCapabilities: options.localCapabilities } : {}),
    });
    this.trends = new TrendStudio({
      repositoryRoot,
      environment,
      now,
      ...(options.trendGateway ? { trendGateway: options.trendGateway } : {}),
      ...(options.trendAgent ? { trendAgent: options.trendAgent } : {}),
    });
    this.opportunities = new OpportunityStudio({
      opportunities: options.opportunities
        ?? new JsonOpportunityStore(path.join(options.workspaceRoot, "opportunities", "opportunities.json")),
      now,
      ...(options.createId ? { createId: options.createId } : {}),
    });
    this.series = new SeriesStudio({
      series: options.series ?? new JsonSeriesStore(path.join(options.workspaceRoot, "series", "series.json")),
      now,
      ...(options.createSeriesId ? { createId: options.createSeriesId } : {}),
    });
    this.candidateInbox = new CandidateInboxStudio({
      trends: this.trends,
      series: this.series,
      opportunities: this.opportunities,
      now,
    });
    this.production = new ProductionStudio({
      workspaceRoot: options.workspaceRoot,
      pipeline: options.pipeline,
      listProviders: () => this.capabilities.listProviders(),
    });
    this.publishing = new PublishingStudio({
      workspaceRoot: options.workspaceRoot,
      getRun: (runId) => this.production.get(runId),
      loadPublishPackage: async (run) => {
        if (!run.publishPackageArtifactId) return undefined;
        const resource = await this.production.resolveArtifact(run.id, run.publishPackageArtifactId);
        if (!resource) return undefined;
        return JSON.parse(await readFile(resource.path, "utf8")) as unknown;
      },
      targets: buildPublishTargetCatalog(),
      ...(options.publishers ? { publishers: options.publishers } : {}),
      now,
    });
    this.creatorSettings = options.creatorSettings
      ?? new JsonCreatorSettingsStore(path.join(options.workspaceRoot, "settings", "creator-settings.json"));
  }

  health(): Promise<StudioHealth> { return this.capabilities.health(); }
  listProviders(): Promise<StudioProvider[]> { return this.capabilities.listProviders(); }
  listLocalCapabilities(): Promise<StudioLocalCapability[]> { return this.capabilities.listLocalCapabilities(); }
  listVoices(): Promise<StudioVoiceProfile[]> { return this.capabilities.listVoices(); }
  previewVoice(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined> {
    return this.capabilities.previewVoice(input);
  }
  getCreatorSettings(): Promise<StudioCreatorSettings> { return this.creatorSettings.get(); }
  updateCreatorSettings(input: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings> {
    return this.creatorSettings.update(input);
  }

  listTrendSources(): Promise<StudioTrendSource[]> { return this.trends.listSources(); }
  listTrendServices(): Promise<StudioTrendService[]> { return this.trends.listServices(); }
  listTrendSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]> { return this.trends.listSignals(input); }
  listTrendCandidates(): Promise<StudioTrendCandidate[]> { return this.trends.listCandidates(); }
  refreshTrendCandidates(): Promise<StudioTrendCandidate[]> { return this.trends.listCandidates({ forceRefresh: true }); }
  listCandidateInbox(input: StudioCandidateInboxQuery): Promise<StudioCandidateInbox> {
    return this.candidateInbox.list(input);
  }
  adoptCandidate(candidateId: string, input: StudioCandidateAdoptionInput): Promise<StudioOpportunity> {
    return this.candidateInbox.adopt(candidateId, input);
  }

  listSeries(): Promise<StudioSeries[]> { return this.series.list(); }
  createSeries(input: StudioSeriesInput): Promise<StudioSeries> { return this.series.create(input); }

  listOpportunities(): Promise<StudioOpportunity[]> { return this.opportunities.list(); }
  getOpportunity(opportunityId: string): Promise<StudioOpportunity | undefined> { return this.opportunities.get(opportunityId); }
  createOpportunity(input: StudioOpportunityInput): Promise<StudioOpportunity> { return this.opportunities.create(input); }
  updateOpportunityStatus(opportunityId: string, status: StudioOpportunityStatus): Promise<StudioOpportunity> {
    return this.opportunities.updateStatus(opportunityId, status);
  }

  listRuns(): Promise<StudioRunSummary[]> { return this.production.list(); }
  getRun(runId: string): Promise<StudioRunDetail | undefined> { return this.production.get(runId); }
  startRun(input: unknown): Promise<StartRunResponse> { return this.production.start(input); }
  decide(runId: string, input: StudioDecisionInput): Promise<StudioRunDetail> { return this.production.decide(runId, input); }
  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void {
    return this.production.subscribe(runId, listener);
  }
  resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined> {
    return this.production.resolveArtifact(runId, artifactId);
  }
  publishReadiness(runId: string): Promise<StudioPublishReadiness> { return this.publishing.readiness(runId); }
  publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    return this.publishing.publish(runId, input);
  }
}
