import { randomUUID } from "node:crypto";
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
  StudioResourceManifest,
  StudioReferenceVideo,
  StudioPublishBatch,
  StudioPublishInput,
  StudioPublishReadiness,
  StudioPublishTarget,
  StudioRunDetail,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesInput,
  StudioSeriesEpisodePlanInput,
  StudioTrendCandidate,
  StudioTrendRefreshReceipt,
  StudioTrendRefreshStatus,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTrendSource,
  StudioTemplate,
  StudioTemplateCatalog,
  StudioTemplateCloneInput,
  StudioTemplateCreateInput,
  StudioTemplateMutation,
  StudioTemplateExperimentScorecard,
  StudioProductionInput,
  StudioProductionRoleBindingKey,
  StudioNodeInputOverrideInput,
  StudioNodeExecutionConfigurationInput,
  StudioNodeOverrideInput,
  StudioPaidNodeSummary,
  StudioPaidReconciliationInput,
  StudioSpendAuthorizationInput,
  StudioSpendRejectionInput,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";
import { StudioInputError } from "../shared/api.js";
import { RunLockedError } from "@video-factory/production-pipeline";
import { CapabilityStudio } from "./capability-studio.js";
import { CandidateInboxStudio } from "./candidate-inbox-studio.js";
import { CostStudio } from "./cost-studio.js";
import { JsonCreatorSettingsStore, type CreatorSettingsRepository } from "./creator-settings-store.js";
import type { LocalCapabilityService } from "./local-capabilities.js";
import { OpportunityStudio } from "./opportunity-studio.js";
import { JsonOpportunityStore, type StudioOpportunityRepository } from "./opportunity-store.js";
import { ProductionStartDispatchedError, ProductionStudio, type StudioPipelinePort } from "./production-studio.js";
import { ReferenceVideoStore } from "./reference-video-store.js";
import { ResourceGovernanceStudio } from "./resource-governance-studio.js";
import { JsonRunArchiveStore, type RunArchiveRepository } from "./run-archive-store.js";
import type { CodexCatalogAvailability } from "./provider-catalog.js";
import { buildPublishTargetCatalog, PublishingStudio, type PlatformPublisher } from "./publishing-studio.js";
import { SeriesStudio } from "./series-studio.js";
import type { SeriesPlanningAgent } from "./series-planning-agent.js";
import { JsonSeriesStore, type SeriesRunSnapshot, type StudioSeriesRepository } from "./series-store.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendOpportunityAgent } from "./trend-opportunity-agent.js";
import { TrendStudio } from "./trend-studio.js";
import { BUILTIN_TEMPLATES } from "./template-catalog.js";
import { JsonTemplateStore, TemplateRevisionConflictError } from "./template-store.js";
import { TemplateStudio } from "./template-studio.js";

const ROLE_CAPABILITIES: Record<StudioProductionRoleBindingKey, string> = {
  script: "script.draft",
  director: "storyboard.plan",
  assets: "asset.prepare",
  voice: "voice.synthesize",
  render: "video.render",
  technicalReview: "quality.review",
  visualReview: "quality.review.visual",
};

export { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
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
  seriesPlanningAgent?: SeriesPlanningAgent;
  createSeriesId?: () => string;
  creatorSettings?: CreatorSettingsRepository;
  runArchive?: RunArchiveRepository;
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
  private readonly referenceVideos: ReferenceVideoStore;
  private readonly resourceGovernance: ResourceGovernanceStudio;

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
      cachePath: path.join(options.workspaceRoot, "trends", "candidate-cache.json"),
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
      ...(options.seriesPlanningAgent ? { planningAgent: options.seriesPlanningAgent } : {}),
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
      archiveStore: options.runArchive ?? new JsonRunArchiveStore(path.join(options.workspaceRoot, "archive", "runs.json")),
      now,
      resolveTemplateSnapshot: async (input, brief) => {
        const rawTemplate = isRecord(input) ? input.template : undefined;
        return this.templates.resolveForRun({
          ...brief,
          ...(rawTemplate !== undefined ? { template: rawTemplate } : {}),
        });
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
      withRunLease: async (runId, action) => {
        try {
          return await options.pipeline.withRunMaintenanceLease([runId], action);
        } catch (error) {
          if (error instanceof RunLockedError || (error instanceof Error && /locked by another writer/.test(error.message))) {
            throw new StudioConflictError("这条制作正在执行、编辑或归档，请等待当前操作结束后再发布。");
          }
          throw error;
        }
      },
      targets: buildPublishTargetCatalog(),
      ...(options.publishers ? { publishers: options.publishers } : {}),
      now,
    });
    this.creatorSettings = options.creatorSettings
      ?? new JsonCreatorSettingsStore(path.join(options.workspaceRoot, "settings", "creator-settings.json"));
    this.referenceVideos = new ReferenceVideoStore(path.join(options.workspaceRoot, "uploads", "reference-videos"), now);
    this.resourceGovernance = new ResourceGovernanceStudio(options.workspaceRoot, () => options.pipeline.list(), now);
  }

  health(): Promise<StudioHealth> { return this.capabilities.health(); }
  listProviders(): Promise<StudioProvider[]> { return this.capabilities.listProviders(); }
  listLocalCapabilities(): Promise<StudioLocalCapability[]> { return this.capabilities.listLocalCapabilities(); }
  listVoices(): Promise<StudioVoiceProfile[]> { return this.capabilities.listVoices(); }
  previewVoice(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined> {
    return this.capabilities.previewVoice(input);
  }
  getCreatorSettings(): Promise<StudioCreatorSettings> { return this.creatorSettings.get(); }
  async updateCreatorSettings(input: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings> {
    const current = await this.creatorSettings.get();
    await this.validateModelDefaults(input.modelDefaults, current.modelDefaults);
    await this.validateRoleProviderDefaults(input.roleProviderDefaults, current.roleProviderDefaults);
    return this.creatorSettings.update(input);
  }
  listTemplates(): Promise<StudioTemplateCatalog> { return this.templates.list(); }
  templateExperiments(): Promise<StudioTemplateExperimentScorecard[]> { return this.resourceGovernance.templateExperiments(); }
  resourceManifest(): Promise<StudioResourceManifest> { return this.resourceGovernance.manifest(); }
  getTemplate(id: string, version?: number): Promise<StudioTemplate | undefined> { return this.templates.get(id, version); }
  cloneTemplate(input: StudioTemplateCloneInput): Promise<StudioTemplateMutation> {
    return this.templateMutation(() => this.templates.clone(input));
  }
  createTemplate(input: StudioTemplateCreateInput): Promise<StudioTemplateMutation> {
    return this.templateMutation(() => this.templates.create(input));
  }
  async saveTemplateDraft(input: StudioTemplate, expectedRevision: number): Promise<StudioTemplateMutation> {
    const { builtIn: _builtIn, ...template } = input;
    const current = await this.templates.get(template.id);
    await this.validateModelDefaults(template.modelDefaults, current?.modelDefaults);
    return this.templateMutation(() => this.templates.saveDraft(template, expectedRevision));
  }
  publishTemplate(id: string, expectedRevision: number): Promise<StudioTemplateMutation> {
    return this.templateMutation(() => this.templates.publish(id, expectedRevision));
  }

  listTrendSources(): Promise<StudioTrendSource[]> { return this.trends.listSources(); }
  listTrendServices(): Promise<StudioTrendService[]> { return this.trends.listServices(); }
  listTrendSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]> { return this.trends.listSignals(input); }
  listTrendCandidates(): Promise<StudioTrendCandidate[]> { return this.trends.listCandidates(); }
  refreshTrendCandidates(): Promise<StudioTrendRefreshReceipt> { return this.trends.requestCandidateRefresh(); }
  async trendCandidateRefreshStatus(refreshId: string): Promise<StudioTrendRefreshStatus> {
    const status = this.trends.candidateRefreshStatus(refreshId);
    if (!status) throw new StudioNotFoundError("没有找到这次热点更新任务。");
    return status;
  }
  listCandidateInbox(input: StudioCandidateInboxQuery): Promise<StudioCandidateInbox> {
    return this.candidateInbox.list(input);
  }
  adoptCandidate(candidateId: string, input: StudioCandidateAdoptionInput): Promise<StudioOpportunity> {
    return this.candidateInbox.adopt(candidateId, input);
  }

  async listSeries(): Promise<StudioSeries[]> {
    await this.reconcileSeriesRuns();
    return this.series.list();
  }
  createSeries(input: StudioSeriesInput): Promise<StudioSeries> { return this.series.create(input); }
  updateSeriesEpisodePlan(seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput): Promise<StudioSeries> {
    return this.series.updateEpisodePlan(seriesId, episodeNumber, input);
  }
  async linkLegacySeriesRun(seriesId: string, episodeNumber: number, runId: string): Promise<StudioSeries> {
    const run = await this.production.get(runId);
    if (!run) throw new StudioNotFoundError("没有找到这条历史制作记录。");
    if (run.seriesId && run.seriesId !== seriesId) {
      throw new StudioConflictError("这条制作记录已经属于另一个系列。");
    }
    const linked = await this.series.linkLegacyRun(seriesId, episodeNumber, {
      id: run.id,
      status: run.status,
      revision: run.revision,
      ...(run.seriesId ? { seriesId: run.seriesId } : {}),
      ...(run.episodeNumber ? { episodeNumber: run.episodeNumber } : {}),
      ...(run.opportunityId ? { opportunityId: run.opportunityId } : {}),
      ...(run.productionReservationId ? { productionReservationId: run.productionReservationId } : {}),
    });
    await this.reconcileSeriesRuns();
    return (await this.series.list()).find((item) => item.id === linked.id) ?? linked;
  }

  async listOpportunities(origin?: "trend" | "series" | "manual"): Promise<StudioOpportunity[]> {
    const opportunities = await this.opportunities.list();
    return origin
      ? opportunities.filter((item) => origin === "manual" ? item.origin === "manual" || item.origin === undefined : item.origin === origin)
      : opportunities;
  }
  getOpportunity(opportunityId: string): Promise<StudioOpportunity | undefined> { return this.opportunities.get(opportunityId); }
  createOpportunity(input: StudioOpportunityInput): Promise<StudioOpportunity> {
    if (input.origin === "series" || input.origin === "trend") {
      throw new StudioInputError("热点与系列机会只能从对应候选入口采用，不能由通用表单伪造来源。");
    }
    return this.opportunities.create(input);
  }
  updateOpportunityStatus(opportunityId: string, status: StudioOpportunityStatus): Promise<StudioOpportunity> {
    return this.opportunities.updateStatus(opportunityId, status);
  }

  async listRuns(origin?: "trend" | "series" | "manual"): Promise<StudioRunSummary[]> {
    const runs = await this.production.list();
    return origin
      ? runs.filter((item) => origin === "manual" ? item.creationOrigin === "manual" || item.creationOrigin === undefined : item.creationOrigin === origin)
      : runs;
  }
  getRun(runId: string): Promise<StudioRunDetail | undefined> { return this.production.get(runId); }
  archiveRuns(runIds: string[]): Promise<void> { return this.production.archive(runIds); }
  restoreRuns(runIds: string[]): Promise<void> { return this.production.restore(runIds); }
  async deleteRun(runId: string): Promise<void> {
    await this.reconcileSeriesRuns();
    await this.series.assertRunDeletable(runId);
    await this.production.remove(runId);
    await this.reconcileSeriesRuns();
  }
  costDashboard(): Promise<StudioCostDashboard> { return this.costs.dashboard(); }
  runCostDetail(runId: string): Promise<StudioCostRunDetail | undefined> { return this.costs.runDetail(runId); }
  async uploadReferenceVideo(input: { label: string; mimeType: string; bytes: Buffer }): Promise<StudioReferenceVideo> {
    try {
      return await this.referenceVideos.upload(input);
    } catch (error) {
      throw new StudioInputError(error instanceof Error ? error.message : "参考视频上传失败。");
    }
  }
  async deleteReferenceVideo(uploadId: string): Promise<void> {
    try {
      await this.referenceVideos.remove(uploadId);
    } catch (error) {
      throw new StudioInputError(error instanceof Error ? error.message : "参考视频删除失败。");
    }
  }
  async startRun(input: unknown, idempotencyKey?: string): Promise<StartRunResponse> {
    const replay = await this.production.replayStart(input, idempotencyKey);
    if (replay) {
      const existing = await this.production.get(replay.runId);
      if (existing?.creationOrigin === "series" || existing?.seriesId) await this.reconcileSeriesRuns();
      return replay;
    }
    const configuredInput = await this.withCreatorDefaults(input);
    if (isRecord(configuredInput) && isRecord(configuredInput.creationContext)
      && configuredInput.creationContext.origin === "series") {
      await this.reconcileSeriesRuns();
    }
    const seriesContext = await this.resolveSeriesProductionContext(configuredInput);
    const opportunityId = seriesContext && isRecord(configuredInput) && isRecord(configuredInput.creationContext)
      ? String(configuredInput.creationContext.opportunityId ?? "")
      : undefined;
    const reservationId = seriesContext ? `series-run-${randomUUID()}` : undefined;
    const trustedInput = seriesContext && reservationId && isRecord(configuredInput)
      ? {
          ...configuredInput,
          title: seriesContext.episode.title,
          angle: `${seriesContext.episode.hook}\n本集必须兑现：${seriesContext.episode.viewerPromise}\n结尾交付：${seriesContext.episode.payoff}`,
          audience: seriesContext.audience,
          nicheSlug: seriesContext.track,
          platform: seriesContext.platform,
          seriesContext: { ...seriesContext, productionReservationId: reservationId },
        }
      : configuredInput;
    if (seriesContext && reservationId && opportunityId) {
      await this.series.reserveRun(seriesContext, opportunityId, reservationId);
    }
    let dispatchedRunId: string | undefined;
    try {
      let started: StartRunResponse;
      if (!isRecord(trustedInput) || !isRecord(trustedInput.referenceVideo)) {
        started = await this.production.start(trustedInput, idempotencyKey, input);
      } else {
        let reference;
        try {
          reference = await this.referenceVideos.resolve(String(trustedInput.referenceVideo.uploadId ?? ""));
        } catch (error) {
          const message = error instanceof Error && error.message.startsWith("参考视频")
            ? error.message
            : "参考视频不存在或已经失效。";
          throw new StudioInputError(message);
        }
        started = await this.production.start({
          ...trustedInput,
          referenceVideo: {
            uploadId: reference.uploadId,
            label: reference.label,
            mimeType: reference.mimeType,
            sizeBytes: reference.sizeBytes,
            sha256: reference.sha256,
            path: reference.path,
          },
        }, idempotencyKey, input);
        this.removeReferenceUploadAfterPersistence(started.runId, reference.uploadId);
      }
      dispatchedRunId = started.runId;
      if (seriesContext && reservationId) {
        await this.series.confirmRunReservation(seriesContext, reservationId, started.runId);
      }
      return started;
    } catch (error) {
      if (error instanceof ProductionStartDispatchedError) dispatchedRunId = error.runId;
      if (seriesContext && reservationId) {
        if (dispatchedRunId) {
          // 已经产生真实任务时保留生产位，并通过可信 run 元数据恢复绑定，避免重复扣费。
          await this.reconcileSeriesRuns().catch(() => undefined);
        } else {
          await this.series.releaseRunReservation(seriesContext, reservationId);
        }
      }
      throw error;
    }
  }

  private async resolveSeriesProductionContext(input: unknown) {
    if (!isRecord(input)) return undefined;
    const creation = isRecord(input.creationContext) ? input.creationContext : undefined;
    if (creation?.origin !== "series" && input.seriesContext !== undefined) {
      throw new StudioInputError("只有系列制作可以携带系列上下文。");
    }
    const opportunityId = typeof creation?.opportunityId === "string" ? creation.opportunityId : "";
    const opportunity = opportunityId ? await this.opportunities.get(opportunityId) : undefined;
    if (creation) {
      if (!opportunity) throw new StudioInputError("没有找到与这次制作对应的机会，请返回入口重新选择。");
      const expectedOrigin = opportunity.origin ?? "manual";
      if (creation.origin !== expectedOrigin) {
        throw new StudioInputError("制作入口与机会的真实来源不一致，请返回对应入口重新开始。");
      }
    }
    if (creation?.origin !== "series") {
      return undefined;
    }
    if (!opportunity || opportunity.origin !== "series" || !opportunity.seriesId || !opportunity.episodeNumber) {
      throw new StudioInputError("没有找到与这次制作对应的系列单集，请返回系列路线图重新采用。");
    }
    return this.series.productionContextFor(opportunity.seriesId, opportunity.episodeNumber);
  }

  private removeReferenceUploadAfterPersistence(runId: string, uploadId: string): void {
    let unsubscribe: () => void = () => undefined;
    let finished = false;
    const inspect = (run: StudioRunDetail | undefined) => {
      if (finished || !run?.nodes.some((node) => node.id === "reference-grammar" && node.status === "succeeded")) return;
      finished = true;
      unsubscribe();
      void this.referenceVideos.remove(uploadId).catch(() => undefined);
    };
    unsubscribe = this.production.subscribe(runId, inspect);
    void this.production.get(runId).then(inspect).catch(() => undefined);
  }

  private async withCreatorDefaults(input: unknown): Promise<unknown> {
    if (!isRecord(input)) return input;
    const settings = await this.creatorSettings.get();
    if (input.providers !== undefined && !isRecord(input.providers)) return input;
    const explicitProviders = isRecord(input.providers) ? input.providers : {};
    const inheritedRoles: StudioCreatorSettings["roleProviderDefaults"] = {};
    const providers = { ...explicitProviders };
    for (const [role, providerId] of Object.entries(settings.roleProviderDefaults ?? {}) as Array<[StudioProductionRoleBindingKey, string]>) {
      const explicit = explicitProviders[role];
      if (typeof explicit === "string" && explicit.trim()) continue;
      providers[role] = providerId;
      inheritedRoles[role] = providerId;
    }
    await this.validateRoleProviderDefaults(inheritedRoles, {});
    const roleConfiguredInput = Object.keys(providers).length ? { ...input, providers } : input;
    if (input.models !== undefined && (
      !isRecord(input.models)
      || Object.values(input.models).some((modelId) => typeof modelId !== "string")
    )) return roleConfiguredInput;
    const explicitModels = (input.models as Record<string, string> | undefined) ?? {};
    const selected = selectedModelProviderIds(roleConfiguredInput);
    const inherited = Object.fromEntries(Object.entries(settings.modelDefaults ?? {}).filter(([providerId]) => selected.has(providerId)));
    const models = { ...inherited, ...explicitModels };
    const modelSelectionSources = Object.fromEntries(Object.keys(models).map((providerId) => [
      providerId,
      providerId in explicitModels ? "run_override" : "global_default",
    ]));
    return {
      ...roleConfiguredInput,
      ...(Object.keys(models).length ? { models, modelSelectionSources } : {}),
    };
  }

  private async validateModelDefaults(
    modelDefaults: Record<string, string> | undefined,
    existingDefaults: Record<string, string> | undefined,
  ): Promise<void> {
    if (!modelDefaults) return;
    const providers = new Map((await this.capabilities.listProviders()).map((provider) => [provider.id, provider]));
    for (const [providerId, modelId] of Object.entries(modelDefaults)) {
      if (existingDefaults?.[providerId] === modelId) continue;
      const provider = providers.get(providerId);
      const model = provider?.modelProfiles?.find((profile) => profile.id === modelId);
      if (!provider || !model) throw new StudioInputError(`模型“${modelId}”不属于能力“${providerId}”。`);
      if (!model.available) throw new StudioInputError(`模型“${modelId}”当前不可用，不能保存为默认值。`);
    }
  }

  private async validateRoleProviderDefaults(
    roleDefaults: StudioCreatorSettingsPatch["roleProviderDefaults"],
    existingDefaults: StudioCreatorSettings["roleProviderDefaults"],
  ): Promise<void> {
    if (!roleDefaults) return;
    const providers = new Map((await this.capabilities.listProviders()).map((provider) => [provider.id, provider]));
    for (const [role, providerId] of Object.entries(roleDefaults) as Array<[StudioProductionRoleBindingKey, string]>) {
      if (existingDefaults?.[role] === providerId) continue;
      const provider = providers.get(providerId);
      if (!provider) throw new StudioInputError(`生产角色“${role}”选择了不存在的能力“${providerId}”。`);
      if (provider.capability !== ROLE_CAPABILITIES[role]) {
        throw new StudioInputError(`能力“${providerId}”不能承担生产角色“${role}”。`);
      }
      if (!provider.available || provider.kind === "test") {
        throw new StudioInputError(`能力“${providerId}”当前不可用于正式生产。`);
      }
    }
  }
  decide(runId: string, input: StudioDecisionInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.decide(runId, input, actor);
  }
  applyNodeOverride(runId: string, nodeId: string, input: StudioNodeOverrideInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.withSeriesRunEditLease(runId, async () => this.production.applyNodeOverride(runId, nodeId, input, actor));
  }
  applyNodeInputOverride(runId: string, nodeId: string, input: StudioNodeInputOverrideInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.withSeriesRunEditLease(runId, async () => this.production.applyNodeInputOverride(runId, nodeId, input, actor));
  }
  applyNodeExecutionConfiguration(runId: string, nodeId: string, input: StudioNodeExecutionConfigurationInput, actor = "studio-owner"): Promise<StudioRunDetail> {
    return this.withSeriesRunEditLease(runId, async () => this.production.applyNodeExecutionConfiguration(runId, nodeId, input, actor));
  }
  authorizeSpend(runId: string, nodeId: string, input: StudioSpendAuthorizationInput, approvedBy = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.authorizeSpend(runId, nodeId, input, approvedBy);
  }
  rejectSpend(runId: string, nodeId: string, input: StudioSpendRejectionInput, rejectedBy = "studio-owner"): Promise<StudioRunDetail> {
    return this.production.rejectSpend(runId, nodeId, input, rejectedBy);
  }
  requestPause(runId: string): Promise<StudioRunDetail> { return this.production.requestPause(runId); }
  resumePaused(runId: string): Promise<StudioRunDetail> { return this.production.resumePaused(runId); }
  resumeStale(runId: string): Promise<StudioRunDetail> { return this.production.resumeStale(runId); }
  async retryFailedNode(runId: string, nodeId: string): Promise<StudioRunDetail> {
    const current = await this.production.get(runId);
    if (!current) throw new StudioNotFoundError("没有找到这条制作记录。");
    if (current.nodes.find((node) => node.id === nodeId)?.outcomeUncertain) {
      throw new StudioConflictError("付费服务可能已经受理这次请求。请先在 Provider 控制台核对任务和账单，系统不会自动再次扣费。");
    }
    if (current.seriesId && current.episodeNumber) {
      await this.series.resumeRun(current.seriesId, current.episodeNumber, runId);
    }
    try {
      const updated = await this.production.retryFailedNode(runId, nodeId);
      if (current.seriesId) await this.reconcileSeriesRuns();
      return updated;
    } catch (error) {
      if (current.seriesId) await this.reconcileSeriesRuns().catch(() => undefined);
      throw error;
    }
  }
  inspectPaidNode(runId: string, nodeId: string): Promise<StudioPaidNodeSummary> {
    return this.production.inspectPaidNode(runId, nodeId);
  }
  async reconcilePaidNode(
    runId: string,
    nodeId: string,
    input: StudioPaidReconciliationInput,
    actor = "studio-owner",
  ): Promise<StudioRunDetail> {
    const current = await this.production.get(runId);
    if (!current) throw new StudioNotFoundError("没有找到这条制作记录。");
    const updated = await this.production.reconcilePaidNode(runId, nodeId, input, actor);
    if (current.seriesId) await this.reconcileSeriesRuns();
    return updated;
  }
  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void {
    return this.production.subscribe(runId, listener);
  }
  resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined> {
    return this.production.resolveArtifact(runId, artifactId);
  }
  publishReadiness(runId: string): Promise<StudioPublishReadiness> { return this.publishing.readiness(runId); }
  async listPublishTargets(): Promise<StudioPublishTarget[]> { return this.publishing.listTargets(); }
  async publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    const batch = await this.publishing.publish(runId, input);
    if (batch.deliveries.some((delivery) => delivery.status === "submitted")) {
      await this.reconcileSeriesRuns();
      await this.series.markRunPublished(runId);
    }
    return batch;
  }

  private async withSeriesRunEditLease(
    runId: string,
    operation: () => Promise<StudioRunDetail>,
  ): Promise<StudioRunDetail> {
    const leaseId = `edit-${randomUUID()}`;
    await this.series.acquireRunEditLease(runId, leaseId);
    try {
      const updated = await operation();
      if (updated.seriesId) await this.reconcileSeriesRuns();
      return updated;
    } finally {
      await this.series.releaseRunEditLease(runId, leaseId);
    }
  }

  private async reconcileSeriesRuns(): Promise<void> {
    const series = await this.series.list();
    const episodesByOpportunity = new Map<string, Array<{ seriesId: string; episodeNumber: number; opportunityId: string }>>();
    for (const item of series) {
      for (const episode of item.episodes) {
        for (const opportunityId of new Set([episode.opportunityId, episode.id].filter((value): value is string => Boolean(value)))) {
          const matches = episodesByOpportunity.get(opportunityId) ?? [];
          matches.push({ seriesId: item.id, episodeNumber: episode.episodeNumber, opportunityId });
          episodesByOpportunity.set(opportunityId, matches);
        }
      }
    }
    const episodesByRun = new Map<string, Array<{ seriesId: string; episodeNumber: number; opportunityId?: string }>>();
    for (const item of series) {
      for (const episode of item.episodes) {
        if (!episode.runId) continue;
        const matches = episodesByRun.get(episode.runId) ?? [];
        matches.push({
          seriesId: item.id,
          episodeNumber: episode.episodeNumber,
          ...(episode.opportunityId ? { opportunityId: episode.opportunityId } : {}),
        });
        episodesByRun.set(episode.runId, matches);
      }
    }
    const summaries: Array<{ summary: StudioRunSummary; seriesId?: string; episodeNumber?: number; opportunityId?: string }> = [];
    for (const summary of await this.production.list()) {
      if (summary.creationOrigin === "series" || summary.seriesId) {
        summaries.push({ summary, ...(summary.seriesId ? { seriesId: summary.seriesId } : {}), ...(summary.episodeNumber ? { episodeNumber: summary.episodeNumber } : {}), ...(summary.opportunityId ? { opportunityId: summary.opportunityId } : {}) });
        continue;
      }
      const linkedMatches = episodesByRun.get(summary.id) ?? [];
      if (linkedMatches.length === 1) {
        summaries.push({ summary, ...linkedMatches[0]! });
        continue;
      }
      const matches = summary.opportunityId ? episodesByOpportunity.get(summary.opportunityId) ?? [] : [];
      if (matches.length === 1) summaries.push({ summary, ...matches[0]! });
    }
    const snapshots: SeriesRunSnapshot[] = await Promise.all(summaries.map(async ({ summary, seriesId, episodeNumber, opportunityId }) => {
      const detail = await this.production.get(summary.id);
      const canonProposal = detail
        ? await canonProposalForRun(detail, (artifactId) => this.production.resolveArtifact(detail.id, artifactId))
        : undefined;
      const outcomeUncertain = detail?.status === "failed" && detail.nodes.some((node) => node.status === "failed"
        && (node.outcomeUncertain === true || (node.interrupted === true
          && (node.executionReceipt?.billing === "metered" || node.plannedExecution?.billing === "metered"))));
      return {
        id: summary.id,
        status: detail?.status ?? summary.status,
        revision: detail?.revision ?? 0,
        ...(seriesId ? { seriesId } : {}),
        ...(episodeNumber ? { episodeNumber } : {}),
        ...(opportunityId ? { opportunityId } : {}),
        ...(summary.productionReservationId ? { productionReservationId: summary.productionReservationId } : {}),
        ...(outcomeUncertain ? { outcomeUncertain: true } : {}),
        ...(canonProposal ? { canonProposal } : {}),
      };
    }));
    await this.series.reconcileRuns(snapshots);
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

async function canonProposalForRun(
  run: StudioRunDetail,
  resolveArtifact: (artifactId: string) => Promise<StudioArtifactResource | undefined>,
): Promise<{
  memorySummary: string;
  statements: string[];
  sourceOutputVersionIds: string[];
} | undefined> {
  if (run.status !== "succeeded" || !run.seriesId || !run.episodeNumber) return undefined;
  const finalReviewIndex = run.nodes.findIndex((node) => node.id === "final-review");
  if (finalReviewIndex < 0 || run.nodes.slice(0, finalReviewIndex + 1).some((node) => node.status !== "succeeded"
    || node.inputState?.stale === true
    || node.outputState?.stale === true)) return undefined;
  const finalReviewNode = run.nodes.find((node) => node.id === "final-review");
  if (finalReviewNode?.status !== "succeeded" || finalReviewNode.outputState?.stale) return undefined;
  const effectiveFinalReview = finalReviewNode.outputState?.versions.find(
    (version) => version.id === finalReviewNode.outputState?.effectiveVersionId,
  )?.output;
  const scriptNode = run.nodes.find((node) => node.id === "script");
  const effectiveScript = scriptNode?.outputState?.versions.find(
    (version) => version.id === scriptNode.outputState?.effectiveVersionId,
  );
  if (!effectiveScript || scriptNode?.outputState?.stale) return undefined;
  const scriptArtifact = effectiveScript.artifactIds
    .map((artifactId) => run.artifacts.find((artifact) => artifact.id === artifactId))
    .find((artifact) => artifact?.kind === "script" && artifact.contentType === "application/json");
  if (!scriptArtifact) return undefined;
  const resource = await resolveArtifact(scriptArtifact.id).catch(() => undefined);
  if (!resource) return undefined;
  let script: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(resource.path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    script = parsed;
  } catch {
    return undefined;
  }
  const statements = Array.isArray(script.canonFacts)
    ? [...new Set(script.canonFacts.map(boundedCanonText).filter((value): value is string => Boolean(value)))].slice(0, 8)
    : [];
  const approvedStatements = isRecord(effectiveFinalReview) && Array.isArray(effectiveFinalReview.canonFacts)
    ? [...new Set(effectiveFinalReview.canonFacts.map(boundedCanonText).filter((value): value is string => Boolean(value)))].slice(0, 8)
    : [];
  const sourceOutputVersionIds = [effectiveScript.id, ...run.nodes
    .filter((node) => node.id === "script" || node.id === "render" || node.id === "visual-review" || node.id === "final-review")
    .map((node) => node.outputState?.effectiveVersionId)
    .filter((value): value is string => Boolean(value))];
  if (statements.length === 0 || JSON.stringify(approvedStatements) !== JSON.stringify(statements)) return undefined;
  return {
    memorySummary: `第 ${run.episodeNumber} 集内部定版事实：${statements.join("；")}`,
    statements,
    sourceOutputVersionIds: [...new Set(sourceOutputVersionIds)],
  };
}

function boundedCanonText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? [...normalized].slice(0, 240).join("") : undefined;
}

function isTemplateInputError(message: string): boolean {
  return /^(template |id |version |status |name |description |category |platforms |durationSeconds |automationLevel |storyStructure|shotSlots|visualSystem|soundSystem|qualityRules|capabilityRequirements|costPolicy)|Template '.+' (was not found|already exists)|A built-in template|Only a draft template|Draft template/.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedModelProviderIds(input: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  if (isRecord(input.providers)) {
    for (const value of Object.values(input.providers)) if (typeof value === "string") selected.add(value);
  }
  if (isRecord(input.director) && Array.isArray(input.director.assetProviderIds)) {
    for (const value of input.director.assetProviderIds) if (typeof value === "string") selected.add(value);
  }
  return selected;
}
