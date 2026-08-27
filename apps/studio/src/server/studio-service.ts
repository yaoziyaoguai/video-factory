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
  StudioCostDashboard,
  StudioCostRunDetail,
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
  StudioPublishTarget,
  StudioRunDetail,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesInput,
  StudioTrendCandidate,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTrendSource,
  StudioTemplate,
  StudioTemplateCatalog,
  StudioTemplateCloneInput,
  StudioTemplateMutation,
  StudioProductionInput,
  StudioNodeInputOverrideInput,
  StudioNodeOverrideInput,
  StudioSpendAuthorizationInput,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";
import { StudioInputError } from "../shared/api.js";
import { CapabilityStudio } from "./capability-studio.js";
import { CandidateInboxStudio } from "./candidate-inbox-studio.js";
import { CostStudio } from "./cost-studio.js";
import { JsonCreatorSettingsStore, type CreatorSettingsRepository } from "./creator-settings-store.js";
import type { LocalCapabilityService } from "./local-capabilities.js";
import { OpportunityStudio } from "./opportunity-studio.js";
import { JsonOpportunityStore, type StudioOpportunityRepository } from "./opportunity-store.js";
import { ProductionStudio, type StudioPipelinePort } from "./production-studio.js";
import type { CodexCatalogAvailability } from "./provider-catalog.js";
import { buildPublishTargetCatalog, PublishingStudio, type PlatformPublisher } from "./publishing-studio.js";
import { SeriesStudio } from "./series-studio.js";
import { JsonSeriesStore, type StudioSeriesRepository } from "./series-store.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendOpportunityAgent } from "./trend-opportunity-agent.js";
import { TrendStudio } from "./trend-studio.js";
import { BUILTIN_TEMPLATES } from "./template-catalog.js";
import { JsonTemplateStore, TemplateRevisionConflictError } from "./template-store.js";
import { TemplateStudio } from "./template-studio.js";

export { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { StudioConflictError } from "./studio-errors.js";
export type { StudioPipelinePort } from "./production-studio.js";

export interface StudioServiceOptions {
  workspaceRoot: string;
  repositoryRoot?: string;
  pipeline: StudioPipelinePort;
  opportunities?: StudioOpportunityRepository;
  environment?: NodeJS.ProcessEnv;
  commandAvailable?: (command: string) => Promise<boolean>;
  codexAvailability?: CodexCatalogAvailability;
  zaiCodexAvailability?: CodexCatalogAvailability;
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
  private readonly templates: TemplateStudio;
  private readonly costs: CostStudio;

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
      ...(options.codexAvailability ? { codexAvailability: options.codexAvailability } : {}),
      ...(options.zaiCodexAvailability ? { zaiCodexAvailability: options.zaiCodexAvailability } : {}),
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
    this.templates = new TemplateStudio(
      new JsonTemplateStore(path.join(options.workspaceRoot, "templates", "templates.json"), BUILTIN_TEMPLATES),
      now,
    );
    this.production = new ProductionStudio({
      workspaceRoot: options.workspaceRoot,
      pipeline: options.pipeline,
      listProviders: () => this.capabilities.listProviders(),
      maxRunCostCny: positiveNumber(environment.VIDEO_FACTORY_MAX_RUN_COST_CNY, 20),
      resolveTemplateSnapshot: async (input, brief) => {
        const rawTemplate = isRecord(input) ? input.template : undefined;
        return this.templates.resolveForRun({
          ...brief,
          ...(rawTemplate !== undefined ? { template: rawTemplate } : {}),
        } as StudioProductionInput);
      },
    });
    this.costs = new CostStudio(() => options.pipeline.list());
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
  listTemplates(): Promise<StudioTemplateCatalog> { return this.templates.list(); }
  getTemplate(id: string, version?: number): Promise<StudioTemplate | undefined> { return this.templates.get(id, version); }
  cloneTemplate(input: StudioTemplateCloneInput): Promise<StudioTemplateMutation> {
    return this.templateMutation(() => this.templates.clone(input));
  }
  saveTemplateDraft(input: StudioTemplate, expectedRevision: number): Promise<StudioTemplateMutation> {
    const { builtIn: _builtIn, ...template } = input;
    return this.templateMutation(() => this.templates.saveDraft(template, expectedRevision));
  }
  publishTemplate(id: string, expectedRevision: number): Promise<StudioTemplateMutation> {
    return this.templateMutation(() => this.templates.publish(id, expectedRevision));
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
  costDashboard(): Promise<StudioCostDashboard> { return this.costs.dashboard(); }
  runCostDetail(runId: string): Promise<StudioCostRunDetail | undefined> { return this.costs.runDetail(runId); }
  startRun(input: unknown, idempotencyKey?: string): Promise<StartRunResponse> {
    return this.production.start(input, idempotencyKey);
  }
  decide(runId: string, input: StudioDecisionInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.decide(runId, input, actor);
  }
  applyNodeOverride(runId: string, nodeId: string, input: StudioNodeOverrideInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.applyNodeOverride(runId, nodeId, input, actor);
  }
  applyNodeInputOverride(runId: string, nodeId: string, input: StudioNodeInputOverrideInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.applyNodeInputOverride(runId, nodeId, input, actor);
  }
  authorizeSpend(runId: string, nodeId: string, input: StudioSpendAuthorizationInput, approvedBy = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.authorizeSpend(runId, nodeId, input, approvedBy);
  }
  resumeStale(runId: string): Promise<StudioRunDetail> { return this.production.resumeStale(runId); }
  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void {
    return this.production.subscribe(runId, listener);
  }
  resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined> {
    return this.production.resolveArtifact(runId, artifactId);
  }
  publishReadiness(runId: string): Promise<StudioPublishReadiness> { return this.publishing.readiness(runId); }
  async listPublishTargets(): Promise<StudioPublishTarget[]> { return this.publishing.listTargets(); }
  publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    return this.publishing.publish(runId, input);
  }

  private async templateMutation(operation: () => Promise<StudioTemplateMutation>): Promise<StudioTemplateMutation> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TemplateRevisionConflictError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("模板已被其他操作更新，请刷新后重试。");
      }
      if (error instanceof StudioInputError || (error instanceof Error && isTemplateInputError(error.message))) {
        throw error instanceof StudioInputError ? error : new StudioInputError(`模板参数不正确：${error.message}`);
      }
      throw error;
    }
  }
}

function isTemplateInputError(message: string): boolean {
  return /^(template |id |version |status |name |description |category |platforms |durationSeconds |automationLevel |storyStructure|shotSlots|visualSystem|soundSystem|qualityRules|capabilityRequirements|costPolicy)|Template '.+' (was not found|already exists)|A built-in template|Only a draft template|Draft template/.test(message);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
