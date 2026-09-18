import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { WorkerArtifactDescriptor, WorkerResponse } from "./python-worker-client.js";
import type {
  VideoAspectRatio,
  VideoGenerationAdapter,
  VideoGenerationProgress,
  VideoGenerationRequest,
} from "./video-generation.js";
import type {
  ImageGenerationAdapter,
  ImageGenerationProgress,
} from "./image-generation.js";
import { ProviderRequestRejectedError } from "./provider-request-error.js";
import type { AssetPilotReviewer } from "./asset-pilot-review.js";
import { visualReviewBlocksContinuation } from "./codex-visual-review.js";
import { quantizeDurationsToFrames } from "./executable-timeline.js";

interface WorkerClient {
  run(request: Record<string, unknown>): Promise<WorkerResponse>;
}

export interface VideoGenerationAdapterBinding {
  adapter: VideoGenerationAdapter;
  estimatedCnyPerClip: number;
  modelPrices?: Record<string, number>;
  defaultModelId?: string;
  modelProfiles?: Record<string, VideoGenerationRuntimeProfile>;
}

export interface VideoGenerationRuntimeProfile {
  taskTypes: Array<"text-to-video" | "image-to-video">;
  resolutions: string[];
  aspectRatios?: VideoAspectRatio[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  supportsAudio: boolean;
  allowedDurationsSeconds?: number[];
  estimatedCnyPerSecond?: number;
  estimatedCnyPerSecondByResolution?: Record<string, number>;
  estimatedCnyByResolutionAndDuration?: Record<string, Record<string, number>>;
}

export type VideoGenerationDurationBounds = Pick<
  VideoGenerationRuntimeProfile,
  "minDurationSeconds" | "maxDurationSeconds" | "allowedDurationsSeconds"
>;

export interface ImageGenerationAdapterBinding {
  adapter: ImageGenerationAdapter;
  estimatedCnyPerImage: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ResolveHost = (hostname: string) => Promise<readonly string[]>;

interface ValidatedMediaTarget {
  url: string;
  hostname: string;
  addresses: readonly string[];
}

export interface GenerativeAssetWorkerClientOptions {
  fallback: WorkerClient;
  adapters: VideoGenerationAdapterBinding[];
  imageAdapters?: ImageGenerationAdapterBinding[];
  runsRoot?: string;
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
  probeGeneratedMedia?: GeneratedMediaProbe;
  pilotReviewer?: AssetPilotReviewer;
}

export interface GeneratedMediaMetadata {
  width: number;
  height: number;
  durationSeconds?: number;
}

export type GeneratedMediaProbe = (
  mediaPath: string,
  mediaType: "image" | "video",
) => Promise<GeneratedMediaMetadata>;

interface ScriptScene {
  position: number;
  duration: number;
  visualStrategy: string;
  visualPrompt: string;
}

const METERED_CREATE_ATTEMPTED = Symbol("meteredCreateAttempted");

/** BG-05：返工携带的 reference/身份证明无法核验时抛出——run 停在素材检查点，
 * 列出缺证明的母片；新媒体 create 必须为 0，等用户补证或确认重生成。 */
class ReworkEvidenceRequiredError extends Error {
  constructor(readonly scenePositions: number[]) {
    super(
      "以下母片的继承证明无法核验（reference SHA/来源与实际继承源不一致）：镜头 "
      + scenePositions.join("、")
      + "。请先补证或调整返工范围；确认重新生成后再继续，本次未产生任何新购买。",
    );
    this.name = "ReworkEvidenceRequiredError";
  }
}
class AssetPilotReviewError extends Error {
  /** true = 试片审查本身没跑成（服务/输出故障，无裁决）；false = 审查给出了否定裁决。 */
  reviewIncomplete = false;
}

/**
 * 试片审查腿没跑出结论（复核服务不可用、模型输出不可用等）。这类故障没有任何裁决，
 * 调用方应把制作转入暂停等人，而不是判死——主动权在用户，审查只能提供建议。
 */
export function isSourceReviewIncompleteError(error: unknown): boolean {
  return error instanceof AssetPilotReviewError && error.reviewIncomplete;
}

/** 测试接缝：构造与生产审查腿同型的「审查未完成」错误，供注入 provider/transport 替身。 */
export function sourceReviewIncompleteError(message: string): Error {
  const error = new AssetPilotReviewError(message);
  error.reviewIncomplete = true;
  return error;
}

interface GenerationJob {
  scenePosition: number;
  providerId: string;
  taskId?: string;
  status: VideoGenerationProgress["status"];
  estimatedCostCny: number;
  actualCostCny?: number;
  actualCostSource?: "configured_rate";
  mediaType: "image" | "video";
  modelId?: string;
  videoUrl?: string;
  imageUrl?: string;
  carriedForward?: boolean;
  [METERED_CREATE_ATTEMPTED]?: boolean;
  error?: string;
  pilotReview?: "approved" | "rejected" | "unavailable";
}

export type PaidAssetItemState =
  | "prepared"
  | "submitted"
  | "provider_succeeded"
  | "materialized"
  | "terminal_failed"
  | "unknown";

export function paidAssetLedgerLeaves<T extends {
  itemRequestId: string;
  carriedForwardFromItemRequestId?: string;
}>(items: readonly T[]): T[] {
  const supersededItemIds = new Set(items.flatMap((item) => (
    item.carriedForwardFromItemRequestId ? [item.carriedForwardFromItemRequestId] : []
  )));
  return items.filter((item) => !supersededItemIds.has(item.itemRequestId));
}

interface PaidAssetOperationItem {
  itemRequestId: string;
  quoteItemId: string;
  inputFingerprint: string;
  scenePosition: number;
  executorProviderId: string;
  providerId: string;
  modelId: string;
  sourceFingerprint: string;
  parameters: Record<string, string | number | boolean>;
  state: PaidAssetItemState;
  estimatedCostCny: number;
  taskId?: string;
  resultUrl?: string;
  localPath?: string;
  sha256?: string;
  sizeBytes?: number;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  carriedForwardFromItemRequestId?: string;
  error?: string;
  manualReconciliationRequired?: boolean;
}

interface PaidAssetOperationLedger {
  version: "video-factory/paid-operation-v2";
  operationId: string;
  completed: boolean;
  items: PaidAssetOperationItem[];
}

interface RoutedShot {
  scenePosition: number;
  preferredProviderId: string;
  providerIds: string[];
  deliveryType?: string;
  reuseFromScenePosition?: number;
  referenceFromScenePosition?: number;
  query: string;
  generationPrompt: string;
  subject?: string;
  environment?: string;
  visibleAction?: string;
  temporalBeats: string[];
  sourceInSeconds: number;
  shotSize?: string;
  camera?: string;
  lighting?: string;
  negativeConstraints: string[];
  successCriteria: string[];
}

interface ResolvedAssetBinding {
  mediaType: "image" | "video";
  supportsReferenceImage?: boolean;
  estimatedCnyPerAsset: number;
  resolveRequest(
    scene: ScriptScene,
    compiledPrompt: string,
    reference?: { scenePosition: number; imageSha256?: string },
  ): ResolvedAssetExecutionRequest;
  estimateCny(request: ResolvedAssetExecutionRequest): number;
  modelId?: string;
  generate(
    request: ResolvedAssetExecutionRequest,
    onProgress: (progress: VideoGenerationProgress | ImageGenerationProgress) => Promise<void>,
    referenceImages?: [string, ...string[]],
  ): Promise<{ taskId: string; url: string }>;
  reconcile?(
    taskId: string,
    request: ResolvedAssetExecutionRequest,
    onProgress: (progress: VideoGenerationProgress | ImageGenerationProgress) => Promise<void>,
  ): Promise<{ taskId: string; url: string }>;
}

export interface ResolvedAssetExecutionRequest {
  providerId: string;
  modelId: string;
  compiledPrompt: string;
  mediaType: "image" | "video";
  durationSeconds: number;
  ratio: "9:16";
  resolution?: VideoGenerationRequest["resolution"];
  generateAudio?: boolean;
  referenceFromScenePosition?: number;
  referenceImageSha256?: string;
  executionDigest: string;
}

/** 逐镜路由解析出的付费素材条目：执行期与花费报价预测共用的中间形态。 */
interface DirectorGeneratedRoute {
  route: RoutedShot;
  scene: ScriptScene;
  providerId: string;
  modelId?: string;
  binding: ResolvedAssetBinding;
  requiredUseDurationSeconds: number;
  resolvedRequest: ResolvedAssetExecutionRequest;
}

/**
 * 花费报价预测的入参：nodeDirectory 让预测读到该节点历次操作的付费台账，
 * 从而判断"这一镜会不会按输入身份被携带复用"。
 */
export interface PaidAssetSpendForecastRequest {
  input: Record<string, unknown>;
  parameters: Record<string, unknown>;
  nodeDirectory: string;
}

export interface PaidAssetSpendForecast {
  /** 本次执行不会新增花费的素材键（quoteItemId）。 */
  reusableQuoteItemIds: string[];
  /** 本次执行按台账推算的新增花费（元），口径与执行期的 createCostCny 相同。 */
  createCostCny: number;
}

const KNOWN_METERED_ASSET_PROVIDERS = new Set([
  "seedream-image-v1",
  "seedance-video-v1",
  "hailuo-video-v1",
  "wan-video-v1",
]);

const KNOWN_FREE_ASSET_PROVIDERS = new Set([
  "local-editorial-v1",
  "pexels-stock-v1",
  "pixabay-stock-v1",
]);

export class GenerativeAssetWorkerClient implements WorkerClient {
  private readonly adapters = new Map<string, VideoGenerationAdapterBinding>();
  private readonly imageAdapters = new Map<string, ImageGenerationAdapterBinding>();
  private readonly fetch: FetchLike | undefined;
  private readonly resolveHost: ResolveHost;
  private readonly maxDownloadBytes: number;
  private readonly downloadTimeoutMs: number;
  private readonly probeGeneratedMedia: GeneratedMediaProbe | undefined;

  constructor(private readonly options: GenerativeAssetWorkerClientOptions) {
    for (const binding of options.adapters) {
      if (!Number.isFinite(binding.estimatedCnyPerClip) || binding.estimatedCnyPerClip <= 0) {
        throw new Error(`Adapter '${binding.adapter.providerId}' must have a positive estimatedCnyPerClip.`);
      }
      for (const [modelId, price] of Object.entries(binding.modelPrices ?? {})) {
        if (!modelId.trim() || !Number.isFinite(price) || price <= 0) {
          throw new Error(`Adapter '${binding.adapter.providerId}' has an invalid price for model '${modelId}'.`);
        }
      }
      for (const [modelId, profile] of Object.entries(binding.modelProfiles ?? {})) {
        validateVideoRuntimeProfile(binding.adapter.providerId, modelId, profile);
        if (binding.modelPrices && binding.modelPrices[modelId] === undefined) {
          throw new Error(`Adapter '${binding.adapter.providerId}' is missing a price for model '${modelId}'.`);
        }
      }
      if (this.adapters.has(binding.adapter.providerId)) {
        throw new Error(`Adapter '${binding.adapter.providerId}' is already configured.`);
      }
      this.adapters.set(binding.adapter.providerId, binding);
    }
    for (const binding of options.imageAdapters ?? []) {
      if (!Number.isFinite(binding.estimatedCnyPerImage) || binding.estimatedCnyPerImage <= 0) {
        throw new Error(`Adapter '${binding.adapter.providerId}' must have a positive estimatedCnyPerImage.`);
      }
      if (this.adapters.has(binding.adapter.providerId) || this.imageAdapters.has(binding.adapter.providerId)) {
        throw new Error(`Adapter '${binding.adapter.providerId}' is already configured.`);
      }
      this.imageAdapters.set(binding.adapter.providerId, binding);
    }
    this.fetch = options.fetch;
    this.resolveHost = options.resolveHost ?? resolveMediaHostname;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 200 * 1024 * 1024;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 60_000;
    this.probeGeneratedMedia = options.probeGeneratedMedia;
    if (!Number.isInteger(this.downloadTimeoutMs) || this.downloadTimeoutMs <= 0) {
      throw new Error("downloadTimeoutMs must be a positive integer.");
    }
  }

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    if (request.capability !== "asset.prepare") {
      return this.options.fallback.run(request);
    }
    const parameters = requiredRecord(request.parameters, "Worker parameters");
    const providerId = requiredString(parameters.providerId, "Worker providerId");
    if (providerId === "ai-shot-router-v1") {
      return this.runDirectorRoutes(request, parameters);
    }
    const modelSelections = optionalStringRecord(parameters.modelSelections, "modelSelections");
    const modelId = modelSelections[providerId];
    const binding = this.resolveBinding(providerId, modelId);
    if (!binding) {
      if (KNOWN_METERED_ASSET_PROVIDERS.has(providerId)) {
        throw new Error(`Metered asset provider '${providerId}' is not configured in this worker.`);
      }
      const response = await this.options.fallback.run(request);
      if (response.status === "succeeded") await assertCompletedWorkerResponse(request, response);
      return response;
    }

    const maxCostCny = boundedNumber(parameters.maxCostCny, "maxCostCny", 0, 100_000);
    const itemCreateBudgets = optionalNumberRecord(parameters.itemCreateBudgets, "itemCreateBudgets");
    const unavailableReview = this.pilotReviewUnavailable(request, parameters);
    if (unavailableReview) return unavailableReview;
    const input = requiredRecord(request.input, "Worker input");
    const scriptPath = requiredString(input.scriptPath, "scriptPath");
    const outputDir = requiredString(request.outputDir, "outputDir");
    const script = requiredRecord(JSON.parse(await readFile(scriptPath, "utf8")), "Script");
    const allScenes = parseScenes(script.scenes);
    if (allScenes.some((scene) => scene.visualStrategy === "local")) {
      throw new Error(
        "Direct local scenes require an explicit director route selecting local-editorial-v1 + editorial_card.",
      );
    }
    const scenes = allScenes;
    const operationId = requiredString(request.commandId, "commandId");
    const sourceFingerprint = await paidAssetSourceFingerprint([scriptPath]);
    const resolvedRequests = new Map(scenes.map((scene) => {
      const resolved = binding.resolveRequest(scene, compileDirectGenerationPrompt(scene));
      return [scene.position, resolved] as const;
    }));
    const baseItems = scenes.map((scene) => createPaidAssetOperationItem(
      operationId,
      scene,
      providerId,
      resolvedRequests.get(scene.position)!,
      binding,
      sourceFingerprint,
    ));
    const preparedOperation = scenes.length
      ? await preparePaidAssetOperation(path.dirname(outputDir), operationId, baseItems)
      : undefined;
    const priorCreateAttemptsByQuoteItem = preparedOperation?.priorCreateAttemptsByQuoteItem ?? {};
    const estimatedCost = preparedOperation?.createCostCny ?? 0;
    if (estimatedCost > 0 && maxCostCny <= 0) {
      throw new Error("Paid asset execution requires a positive spend authorization.");
    }
    if (estimatedCost > maxCostCny) {
      return insufficientAssetAuthorizationFailure(request, estimatedCost, maxCostCny);
    }
    await mkdir(outputDir, { recursive: true });
    const directPlanPath = path.join(outputDir, "direct_generation_plan.json");
    await writeJsonAtomically(directPlanPath, {
      version: "video-factory/director-plan-v1",
      shots: scenes.map((scene) => ({
        scenePosition: scene.position,
        preferredProviderId: providerId,
        alternativeProviderIds: [],
        deliveryType: binding.mediaType === "image" ? "generated_image" : "generated_video",
        query: scene.visualPrompt,
        generationPrompt: scene.visualPrompt,
      })),
    });
    const baselineRequest = structuredClone(request);
    baselineRequest.input = {
      ...input,
      directorPlanPath: directPlanPath,
    };
    baselineRequest.parameters = {
      ...parameters,
      provider: "ai-router",
    };
    const baseline = await this.options.fallback.run(baselineRequest);
    if (baseline.status !== "succeeded") {
      return zeroMeteredAttemptFailure(baseline);
    }
    const planPath = requiredString(baseline.output?.assetPlanPath, "assetPlanPath");
    const plan = requiredRecord(JSON.parse(await readFile(planPath, "utf8")), "Asset plan");
    const assets = Array.isArray(plan.scene_assets) ? plan.scene_assets : [];
    const jobsPath = path.join(outputDir, "generation_jobs.json");
    const ledgerPath = preparedOperation?.ledgerPath;
    const jobs: GenerationJob[] = [];
    const mediaArtifacts: WorkerArtifactDescriptor[] = [];
    const approvedPilotGroups = new Set<string>();

    const preparedItems = preparedOperation?.items ?? [];
    const openedLedger = ledgerPath
      ? await openGenerationOperation(ledgerPath, operationId, preparedItems)
      : undefined;

    for (const scene of scenes) {
      const resolvedRequest = resolvedRequests.get(scene.position)!;
      const sceneCost = binding.estimateCny(resolvedRequest);
      const ledgerItem = openedLedger?.ledger.items.find((item) => item.scenePosition === scene.position);
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId,
        status: "submitted",
        estimatedCostCny: sceneCost,
        mediaType: binding.mediaType,
        ...(binding.modelId ? { modelId: binding.modelId } : {}),
      };
      jobs.push(job);
      try {
        const resumedExistingTask = isExistingPaidTask(ledgerItem);
        if (resumedExistingTask || ledgerItem?.carriedForwardFromItemRequestId) {
          job.carriedForward = true;
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        const generated = ledgerItem?.state === "materialized"
          ? acceptedResultFromLedger(ledgerItem)
          : await generatePaidAssetItem({
              binding,
              request: resolvedRequest,
              job,
              jobs,
              jobsPath,
              sceneCost,
              ledgerPath,
              ledger: openedLedger?.ledger,
              ledgerItem,
              allowCreate: openedLedger?.created !== false,
              ...(Object.keys(itemCreateBudgets).length ? {
                itemCreateBudgets,
                priorCreateAttempts: priorCreateAttemptsByQuoteItem[`scene-${scene.position}`],
              } : {}),
            });
        applyAcceptedTask(job, generated.taskId, sceneCost);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (ledgerItem?.state === "materialized") {
          const materialized = await materializeCarriedAsset(
            ledgerItem,
            outputDir,
            scene.position,
            providerId,
            binding.mediaType,
          );
          if (ledgerPath && openedLedger) await writeGenerationLedger(ledgerPath, openedLedger.ledger);
          applySucceeded(job, generated.taskId, generated.url);
          const mediaMetadata = await this.validateGeneratedMedia(materialized.path, binding.mediaType, scene.duration);
          replaceSceneAsset(plan, assets, scene, generated.taskId, materialized.path, providerId, binding.mediaType, mediaMetadata);
          mediaArtifacts.push(await describeFile(
            materialized.path,
            "media_asset",
            materialized.contentType,
            providerId,
            request,
            `AI-generated ${binding.mediaType}; review provider terms, likeness rights, and AIGC disclosure before publishing.`,
            scene.position,
            "Inherited verified materialized media from an earlier paid operation.",
          ));
          await this.reviewPilot({ request, parameters, plan, planPath, ledgerItem, job, approvedPilotGroups, mediaArtifacts });
          continue;
        }
        const media = await downloadGeneratedAsset(
          this.fetch,
          generated.url,
          path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${providerId}`),
          binding.mediaType,
          this.maxDownloadBytes,
          this.resolveHost,
          this.downloadTimeoutMs,
        );
        const mediaMetadata = await this.validateGeneratedMedia(media.path, binding.mediaType, scene.duration);
        applySucceeded(job, generated.taskId, generated.url);
        await writeJobs(jobsPath, jobs);
        if (ledgerPath && openedLedger && ledgerItem) {
          const descriptor = await fileIdentity(media.path);
          Object.assign(ledgerItem, {
            state: "materialized" as const,
            localPath: media.path,
            sha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
          });
          delete ledgerItem.error;
          // 下载物化成功即解除此前的逐项人工核账标记（含 reconcile 刷新 URL 后恢复的同一 task）。
          delete ledgerItem.manualReconciliationRequired;
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        replaceSceneAsset(plan, assets, scene, generated.taskId, media.path, providerId, binding.mediaType, mediaMetadata);
        mediaArtifacts.push(await describeFile(
          media.path,
          "media_asset",
          media.contentType,
          providerId,
          request,
          `AI-generated ${binding.mediaType}; review provider terms, likeness rights, and AIGC disclosure before publishing.`,
          scene.position,
        ));
        await this.reviewPilot({ request, parameters, plan, planPath, ledgerItem, job, approvedPilotGroups, mediaArtifacts });
      } catch (error) {
        job.status = "failed";
        job.error = safeGenerationDiagnostic(error);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (!(error instanceof AssetPilotReviewError) && ledgerPath && openedLedger && ledgerItem) {
          if (!isManuallyReconciledTerminalItem(ledgerItem)) {
            ledgerItem.error = job.error;
            if (ledgerItem.resultUrl && ledgerItem.taskId) {
              ledgerItem.state = error instanceof GeneratedMediaContractError ? "terminal_failed" : "provider_succeeded";
              // 永久下载失败（403/404、非法/不安全 URL、超限）保留 task、URL、费用与错误证据，
              // 但标记逐项人工核账可操作；普通网络/超时错误不标记，继续按原任务恢复。
              if (error instanceof UnrecoverableGeneratedAssetDownloadError) {
                ledgerItem.manualReconciliationRequired = true;
              }
            }
          }
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        if (!(error instanceof AssetPilotReviewError) && openedLedger?.created === false) continue;
        break;
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded" || job.pilotReview !== undefined).length;
    const failedJob = jobs.find((job) => job.status === "failed");
    const fallbackScenes = 0;
    const accountedCostCny = configuredCost(jobs);
    plan.scene_assets = assets;
    plan.generation = {
      providerId,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: estimatedCost,
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate",
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
      jobsPath,
      ...(failedJob ? { failedScenes: jobs.filter((job) => job.status === "failed").length } : {}),
    };
    if (!failedJob) assertCompletedAssetPlan(plan, scenes, undefined, jobs);
    await writeJsonAtomically(planPath, plan);
    await writeJobs(jobsPath, jobs);
    if (ledgerPath && openedLedger) {
      if (failedJob) closeUnsubmittedItemsAfterTerminalOperation(openedLedger.ledger, failedJob.error);
      openedLedger.ledger.completed = openedLedger.ledger.items.every((item) => item.state === "materialized");
      await writeGenerationLedger(ledgerPath, openedLedger.ledger);
    }
    const planArtifact = await describeFile(
      planPath,
      "asset_plan",
      "application/json",
      providerId,
      request,
      "AI-generated asset plan with per-scene provenance.",
    );
    const jobsArtifact = await describeFile(
      jobsPath,
      "generation_jobs",
      "application/json",
      providerId,
      request,
      "External task IDs and validated successful result URLs retained for audit.",
    );
    const diagnostics = {
      ...(baseline.diagnostics ?? {}),
      providerId,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: estimatedCost,
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate" as const,
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
    };
    if (failedJob) {
      return {
        ...baseline,
        commandId: requiredString(request.commandId, "commandId"),
        status: failedJob.pilotReview === "rejected" ? "rejected" : "failed",
        output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath,
          ...(plan.sourceVisualReview ? { sourceVisualReview: plan.sourceVisualReview } : {}),
        },
        artifacts: [planArtifact, jobsArtifact, ...mediaArtifacts],
        error: {
          code: failedJob.pilotReview ? "ASSET_PILOT_REVIEW_FAILED" : "ASSET_GENERATION_FAILED",
          message: failedJob.pilotReview ? failedJob.error! : `Scene ${failedJob.scenePosition} generation failed: ${failedJob.error ?? "unknown provider error"}`,
        },
        diagnostics: {
          ...diagnostics,
          // 回执不得仍装成零次尝试：结果未知时由 WorkflowRunner 保留 outcomeUncertain，
          // 交由人工核账闭环而不是解锁重试。
          providerOutcomeKnown: ledgerProviderOutcomeKnown(openedLedger?.ledger),
        },
      };
    }
    return {
      ...baseline,
      commandId: requiredString(request.commandId, "commandId"),
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath,
        ...(plan.sourceVisualReview ? { sourceVisualReview: plan.sourceVisualReview } : {}),
      },
      artifacts: [
        ...retainedFinalAssetArtifacts(baseline.artifacts, planPath, assets),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics,
    };
  }

  /**
   * 逐镜路由到付费素材请求的唯一构造点。执行期与花费报价预测都必须走这里：
   * 报价要判断"这一镜会不会被携带复用"，只能拿执行期同一份已解析请求去比对，
   * 各自算一遍迟早会分叉（一边说不用买、一边真去买）。
   */
  private async planDirectorRoutes(options: {
    scriptPath: string;
    directorPlanPath: string;
    modelSelections: Record<string, string>;
  }): Promise<{
    script: Record<string, unknown>;
    scenes: ScriptScene[];
    directorPlan: Record<string, unknown>;
    routedShots: RoutedShot[];
    generatedRoutes: DirectorGeneratedRoute[];
  }> {
    const script = requiredRecord(JSON.parse(await readFile(options.scriptPath, "utf8")), "Script");
    const scenes = parseScenes(script.scenes);
    const sceneByPosition = new Map(scenes.map((scene) => [scene.position, scene]));
    const directorPlan = requiredRecord(JSON.parse(await readFile(options.directorPlanPath, "utf8")), "Director plan");
    const routedShots = parseRoutedShots(directorPlan.shots);
    assertExactScenePositions("Director plan", routedShots.map((shot) => shot.scenePosition), scenes);
    const modelSelections = options.modelSelections;
    const byScenePosition = new Map(routedShots.map((route) => [route.scenePosition, route]));
    const requiredDurationByRoot = requiredGeneratedAssetDurationSecondsByRoot(scenes, routedShots);
    const generatedRoutes = routedShots.flatMap((route) => {
      const reuseFrom = assetReuseSourceScenePosition(route);
      const referenceFrom = route.referenceFromScenePosition;
      if (reuseFrom !== undefined && referenceFrom !== undefined) {
        throw new Error(`Scene ${route.scenePosition} cannot both reuse and reference another scene.`);
      }
      if (reuseFrom !== undefined) {
        if (reuseFrom >= route.scenePosition || !byScenePosition.has(reuseFrom)) {
          throw new Error(`Scene ${route.scenePosition} must reuse an earlier director scene, received ${reuseFrom}.`);
        }
        return [];
      }
      const providerId = route.preferredProviderId;
      if (providerId === "local-editorial-v1") {
        if (referenceFrom !== undefined) {
          throw new Error(`Scene ${route.scenePosition} reference image requires a generated image route.`);
        }
        if (route.deliveryType !== "editorial_card") {
          throw new Error(
            `Scene ${route.scenePosition} may use local-editorial-v1 only with deliveryType editorial_card.`,
          );
        }
        return [];
      }
      if (KNOWN_FREE_ASSET_PROVIDERS.has(providerId)) {
        if (referenceFrom !== undefined) {
          throw new Error(`Scene ${route.scenePosition} reference image requires a generated image route.`);
        }
        return [];
      }
      if (!KNOWN_METERED_ASSET_PROVIDERS.has(providerId)) {
        throw new Error(`Provider '${providerId}' is not a recognized asset source.`);
      }
      const scene = sceneByPosition.get(route.scenePosition);
      if (!scene) throw new Error(`AI director selected unknown script scene ${route.scenePosition}.`);
      const modelId = modelSelections[providerId];
      const binding = this.resolveBinding(providerId, modelId);
      if (!binding) {
        throw new Error(`Provider '${providerId}' is not configured.`);
      }
      const compiledPrompt = compileGenerationPrompt(providerId, route, scene);
      const requiredUseDurationSeconds = requiredDurationByRoot.get(route.scenePosition)!;
      const requestScene = binding.mediaType === "video"
        ? { ...scene, duration: requiredUseDurationSeconds }
        : scene;
      return [{
        route,
        scene,
        providerId,
        ...(modelId ? { modelId } : {}),
        binding,
        requiredUseDurationSeconds,
        resolvedRequest: binding.resolveRequest(
          requestScene,
          compiledPrompt,
          route.referenceFromScenePosition === undefined
            ? undefined
            : { scenePosition: route.referenceFromScenePosition },
        ),
      }];
    }).sort((left, right) => left.scene.position - right.scene.position);
    return { script, scenes, directorPlan, routedShots, generatedRoutes };
  }

  /**
   * 花费报价预测：回答"这次执行到底会不会向 provider 发起新的付费 create"。
   * 与执行期共用 planDirectorRoutes 与 preparePaidAssetOperation，因此结论与执行一致；
   * 计价只读——不落账、不下载、不调用 provider。任何无法证明可复用的条目都留在报价里
   * （fail closed：宁可多问一次授权，也不在报价里少算钱）。
   * 预测用的操作 id 是合成值，因此本次操作自己的历史台账也会参与比对：对一次新的节点执行，
   * 这正是执行期会发生的事。
   */
  async forecastPaidAssetSpend(request: PaidAssetSpendForecastRequest): Promise<PaidAssetSpendForecast | undefined> {
    if (optionalString(request.parameters.providerId) !== "ai-shot-router-v1") return undefined;
    const scriptPath = optionalString(request.input.scriptPath);
    const directorPlanPath = optionalString(request.input.directorPlanPath);
    if (!scriptPath || !directorPlanPath) return undefined;
    const operationId = "spend-forecast";
    try {
      const modelSelections = optionalStringRecord(request.parameters.modelSelections, "modelSelections");
      const { script, directorPlan, generatedRoutes } = await this.planDirectorRoutes({
        scriptPath,
        directorPlanPath,
        modelSelections,
      });
      if (generatedRoutes.length === 0) return { reusableQuoteItemIds: [], createCostCny: 0 };
      const sourceFingerprint = await paidAssetSourceFingerprint([scriptPath, directorPlanPath]);
      const baseItems = generatedRoutes.map(({ scene, binding, resolvedRequest }) => createPaidAssetOperationItem(
        operationId,
        scene,
        "ai-shot-router-v1",
        resolvedRequest,
        binding,
        sourceFingerprint,
      ));
      const reworkCarryForwardItems = await findReworkCarryForwardItems({
        ...(this.options.runsRoot ? { runsRoot: this.options.runsRoot } : {}),
        input: request.input,
        currentScript: script,
        currentDirectorPlan: directorPlan,
        modelSelections: Object.fromEntries(generatedRoutes.map(({ providerId, binding }) => (
          [providerId, binding.modelId ?? providerId]
        ))),
      });
      const prepared = await preparePaidAssetOperation(
        request.nodeDirectory,
        operationId,
        baseItems,
        reworkCarryForwardItems,
      );
      return {
        reusableQuoteItemIds: prepared.items
          .filter((item) => prepared.existing || item.carriedForwardFromItemRequestId !== undefined)
          .map((item) => item.quoteItemId),
        createCostCny: prepared.createCostCny,
      };
    } catch {
      // 预测本身不可得时退回原有报价口径，由花费闸门照常向操作员要授权。
      return undefined;
    }
  }

  private async runDirectorRoutes(
    request: Record<string, unknown>,
    parameters: Record<string, unknown>,
  ): Promise<WorkerResponse> {
    const input = requiredRecord(request.input, "Worker input");
    const scriptPath = requiredString(input.scriptPath, "scriptPath");
    const directorPlanPath = requiredString(input.directorPlanPath, "directorPlanPath");
    const outputDir = requiredString(request.outputDir, "outputDir");
    const maxCostCny = boundedNumber(parameters.maxCostCny, "maxCostCny", 0, 100_000);
    const itemCreateBudgets = optionalNumberRecord(parameters.itemCreateBudgets, "itemCreateBudgets");
    const modelSelections = optionalStringRecord(parameters.modelSelections, "modelSelections");
    const { script, scenes, directorPlan, routedShots, generatedRoutes } = await this.planDirectorRoutes({
      scriptPath,
      directorPlanPath,
      modelSelections,
    });
    const generatedRouteByPosition = new Map(generatedRoutes.map((entry) => [entry.scene.position, entry]));
    if (generatedRoutes.length) {
      const unavailableReview = this.pilotReviewUnavailable(request, parameters);
      if (unavailableReview) return unavailableReview;
    }
    for (const entry of generatedRoutes) {
      const referenceFrom = entry.route.referenceFromScenePosition;
      if (referenceFrom === undefined) continue;
      if (entry.binding.mediaType !== "image") {
        throw new Error(`Scene ${entry.scene.position} reference image requires an image generation provider.`);
      }
      if (!entry.binding.supportsReferenceImage) {
        throw new Error(`Scene ${entry.scene.position} selected image provider does not support reference images.`);
      }
      const source = generatedRouteByPosition.get(referenceFrom);
      if (referenceFrom >= entry.scene.position || !source || source.binding.mediaType !== "image") {
        throw new Error(
          `Scene ${entry.scene.position} must reference an earlier generated image scene, received ${referenceFrom}.`,
        );
      }
    }
    const operationId = requiredString(request.commandId, "commandId");
    const sourceFingerprint = await paidAssetSourceFingerprint([scriptPath, directorPlanPath]);
    const baseItems = generatedRoutes.map(({ scene, binding, resolvedRequest }) => createPaidAssetOperationItem(
      operationId,
      scene,
      "ai-shot-router-v1",
      resolvedRequest,
      binding,
      sourceFingerprint,
    ));
    const reworkCarryForwardItems = await findReworkCarryForwardItems({
      ...(this.options.runsRoot ? { runsRoot: this.options.runsRoot } : {}),
      input,
      currentScript: script,
      currentDirectorPlan: directorPlan,
      modelSelections: Object.fromEntries(generatedRoutes.map(({ providerId, binding }) => (
        [providerId, binding.modelId ?? providerId]
      ))),
    });
    const preparedOperation = generatedRoutes.length
      ? await preparePaidAssetOperation(path.dirname(outputDir), operationId, baseItems, reworkCarryForwardItems)
      : undefined;
    const priorCreateAttemptsByQuoteItem = preparedOperation?.priorCreateAttemptsByQuoteItem ?? {};
    const estimatedCost = preparedOperation?.createCostCny ?? 0;
    if (estimatedCost > 0 && maxCostCny <= 0) {
      throw new Error("Paid asset execution requires a positive spend authorization.");
    }
    if (estimatedCost > maxCostCny) {
      return insufficientAssetAuthorizationFailure(request, estimatedCost, maxCostCny);
    }

    const baseline = await this.options.fallback.run(structuredClone(request));
    if (baseline.status !== "succeeded") {
      return zeroMeteredAttemptFailure(baseline);
    }
    if (generatedRoutes.length === 0) {
      await assertCompletedWorkerResponse(request, baseline);
      return {
        ...baseline,
        diagnostics: {
          ...(baseline.diagnostics ?? {}),
          providerId: "ai-shot-router-v1",
          attemptedScenes: 0,
          generatedScenes: 0,
          fallbackScenes: 0,
          estimatedCostCny: 0,
          actualCostCny: 0,
          actualCostSource: "configured_rate",
          meteredAttemptCount: 0,
          meteredFailedAttemptCount: 0,
        },
      };
    }

    const planPath = requiredString(baseline.output?.assetPlanPath, "assetPlanPath");
    const plan = requiredRecord(JSON.parse(await readFile(planPath, "utf8")), "Asset plan");
    const assets = Array.isArray(plan.scene_assets) ? plan.scene_assets : [];
    const jobsPath = path.join(outputDir, "generation_jobs.json");
    const ledgerPath = preparedOperation?.ledgerPath;
    const jobs: GenerationJob[] = [];
    const mediaArtifacts: WorkerArtifactDescriptor[] = [];

    const preparedItems = preparedOperation?.items ?? [];
    const openedLedger = ledgerPath
      ? await openGenerationOperation(ledgerPath, operationId, preparedItems)
      : undefined;

    const approvedPilotGroups = new Set<string>();
    const pilotPositions = new Set<number>();
    if (this.options.pilotReviewer) {
      const candidates = [...generatedRoutes].filter(({ route }) => route.referenceFromScenePosition === undefined)
        .sort((a, b) => b.route.temporalBeats.length - a.route.temporalBeats.length
          || b.route.successCriteria.length - a.route.successCriteria.length
          || a.scene.position - b.scene.position);
      const groups = new Set<string>();
      for (const candidate of candidates) {
        const key = `${candidate.providerId}:${candidate.binding.modelId ?? ""}`;
        if (groups.has(key)) continue;
        groups.add(key);
        pilotPositions.add(candidate.scene.position);
      }
    }
    // 先试动作节拍/验收条件最多的独立镜头；参考图子镜仍按母片先行的原顺序执行。
    const executionRoutes = [...generatedRoutes].sort((a, b) => Number(pilotPositions.has(b.scene.position)) - Number(pilotPositions.has(a.scene.position)));
    for (const { route, scene, binding, providerId, requiredUseDurationSeconds, resolvedRequest: baseResolvedRequest } of executionRoutes) {
      let resolvedRequest = baseResolvedRequest;
      let sceneCost = binding.estimateCny(resolvedRequest);
      let ledgerItem = openedLedger?.ledger.items.find((item) => item.scenePosition === scene.position);
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId,
        status: "submitted",
        estimatedCostCny: sceneCost,
        mediaType: binding.mediaType,
        ...(binding.modelId ? { modelId: binding.modelId } : {}),
      };
      jobs.push(job);
      try {
        let referenceImages: [string, ...string[]] | undefined;
        if (route.referenceFromScenePosition !== undefined && ledgerItem?.state !== "materialized") {
          if (!openedLedger || !ledgerPath || !ledgerItem) {
            throw new Error(`Scene ${scene.position} reference image operation ledger is unavailable.`);
          }
          const reference = await materializedReferenceImage(
            openedLedger.ledger,
            route.referenceFromScenePosition,
          );
          resolvedRequest = binding.resolveRequest(scene, baseResolvedRequest.compiledPrompt, {
            scenePosition: route.referenceFromScenePosition,
            imageSha256: reference.sha256,
          });
          sceneCost = binding.estimateCny(resolvedRequest);
          const referencedItem = createPaidAssetOperationItem(
            operationId,
            scene,
            "ai-shot-router-v1",
            resolvedRequest,
            binding,
            sourceFingerprint,
          );
          ledgerItem = await bindReferenceImageToLedger(
            ledgerPath,
            openedLedger.ledger,
            ledgerItem,
            referencedItem,
          );
          referenceImages = [reference.dataUrl];
        }
        const resumedExistingTask = isExistingPaidTask(ledgerItem);
        if (resumedExistingTask || ledgerItem?.carriedForwardFromItemRequestId) {
          job.carriedForward = true;
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        const generated = ledgerItem?.state === "materialized"
          ? acceptedResultFromLedger(ledgerItem)
          : await generatePaidAssetItem({
              binding,
              request: resolvedRequest,
              job,
              jobs,
              jobsPath,
              sceneCost,
              ledgerPath,
              ledger: openedLedger?.ledger,
              ledgerItem,
              allowCreate: openedLedger?.created !== false,
              ...(referenceImages ? { referenceImages } : {}),
              ...(Object.keys(itemCreateBudgets).length ? {
                itemCreateBudgets,
                priorCreateAttempts: priorCreateAttemptsByQuoteItem[`scene-${scene.position}`],
              } : {}),
            });
        applyAcceptedTask(job, generated.taskId, sceneCost);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (ledgerItem?.state === "materialized") {
          const materialized = await materializeCarriedAsset(
            ledgerItem,
            outputDir,
            scene.position,
            providerId,
            binding.mediaType,
          );
          if (ledgerPath && openedLedger) await writeGenerationLedger(ledgerPath, openedLedger.ledger);
          applySucceeded(job, generated.taskId, generated.url);
          const mediaMetadata = await this.validateGeneratedMedia(materialized.path, binding.mediaType, requiredUseDurationSeconds);
          replaceSceneAsset(plan, assets, scene, generated.taskId, materialized.path, providerId, binding.mediaType, mediaMetadata);
          mediaArtifacts.push(await describeFile(
            materialized.path,
            "media_asset",
            materialized.contentType,
            providerId,
            request,
            `AI-generated ${binding.mediaType} selected by the director plan; review terms, likeness rights, and AIGC disclosure.`,
            scene.position,
            "Inherited verified materialized media from the rework source run.",
          ));
          await this.reviewPilot({ request, parameters, plan, planPath, ledgerItem, job, approvedPilotGroups, mediaArtifacts });
          continue;
        }
        const media = await downloadGeneratedAsset(
          this.fetch,
          generated.url,
          path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${providerId}`),
          binding.mediaType,
          this.maxDownloadBytes,
          this.resolveHost,
          this.downloadTimeoutMs,
        );
        const mediaMetadata = await this.validateGeneratedMedia(media.path, binding.mediaType, requiredUseDurationSeconds);
        applySucceeded(job, generated.taskId, generated.url);
        await writeJobs(jobsPath, jobs);
        if (ledgerPath && openedLedger && ledgerItem) {
          const descriptor = await fileIdentity(media.path);
          Object.assign(ledgerItem, {
            state: "materialized" as const,
            localPath: media.path,
            sha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
          });
          delete ledgerItem.error;
          // 下载物化成功即解除此前的逐项人工核账标记（含 reconcile 刷新 URL 后恢复的同一 task）。
          delete ledgerItem.manualReconciliationRequired;
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        replaceSceneAsset(plan, assets, scene, generated.taskId, media.path, providerId, binding.mediaType, mediaMetadata);
        mediaArtifacts.push(await describeFile(
          media.path,
          "media_asset",
          media.contentType,
          providerId,
          request,
          `AI-generated ${binding.mediaType} selected by the director plan; review terms, likeness rights, and AIGC disclosure.`,
          scene.position,
        ));
        await this.reviewPilot({ request, parameters, plan, planPath, ledgerItem, job, approvedPilotGroups, mediaArtifacts });
      } catch (error) {
        job.status = "failed";
        job.error = safeGenerationDiagnostic(error);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (!(error instanceof AssetPilotReviewError) && ledgerPath && openedLedger && ledgerItem) {
          if (!isManuallyReconciledTerminalItem(ledgerItem)) {
            ledgerItem.error = job.error;
            if (ledgerItem.resultUrl && ledgerItem.taskId) {
              ledgerItem.state = error instanceof GeneratedMediaContractError ? "terminal_failed" : "provider_succeeded";
              // 同 direct 路径：永久下载失败接通逐项人工核账，暂时失败仍按原任务恢复。
              if (error instanceof UnrecoverableGeneratedAssetDownloadError) {
                ledgerItem.manualReconciliationRequired = true;
              }
            }
          }
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        if (!(error instanceof AssetPilotReviewError) && openedLedger?.created === false) continue;
        break;
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded" || job.pilotReview !== undefined).length;
    const failedJob = jobs.find((job) => job.status === "failed");
    const fallbackScenes = 0;
    const accountedCostCny = configuredCost(jobs);
    plan.scene_assets = assets;
    plan.generation = {
      providerId: "ai-shot-router-v1",
      directorPlanPath,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: estimatedCost,
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate",
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
      jobsPath,
      ...(failedJob ? { failedScenes: jobs.filter((job) => job.status === "failed").length } : {}),
    };
    if (!failedJob) assertCompletedAssetPlan(plan, scenes, routedShots, jobs);
    await writeJsonAtomically(planPath, plan);
    await writeJobs(jobsPath, jobs);
    if (ledgerPath && openedLedger) {
      if (failedJob) closeUnsubmittedItemsAfterTerminalOperation(openedLedger.ledger, failedJob.error);
      openedLedger.ledger.completed = openedLedger.ledger.items.every((item) => item.state === "materialized");
      await writeGenerationLedger(ledgerPath, openedLedger.ledger);
    }
    const planArtifact = await describeFile(
      planPath,
      "asset_plan",
      "application/json",
      "ai-shot-router-v1",
      request,
      "AI-directed per-shot asset plan with actual provider provenance.",
    );
    const jobsArtifact = await describeFile(
      jobsPath,
      "generation_jobs",
      "application/json",
      "ai-shot-router-v1",
      request,
      "External generation task IDs retained for audit.",
    );
    const diagnostics = {
      ...(baseline.diagnostics ?? {}),
      providerId: "ai-shot-router-v1",
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: estimatedCost,
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate" as const,
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
    };
    if (failedJob) {
      return {
        ...baseline,
        commandId: requiredString(request.commandId, "commandId"),
        status: failedJob.pilotReview === "rejected" ? "rejected" : "failed",
        output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath,
          ...(plan.sourceVisualReview ? { sourceVisualReview: plan.sourceVisualReview } : {}),
        },
        artifacts: [planArtifact, jobsArtifact, ...mediaArtifacts],
        error: {
          code: failedJob.pilotReview ? "ASSET_PILOT_REVIEW_FAILED" : "ASSET_GENERATION_FAILED",
          message: failedJob.pilotReview ? failedJob.error! : `Scene ${failedJob.scenePosition} generation failed: ${failedJob.error ?? "unknown provider error"}`,
        },
        diagnostics: {
          ...diagnostics,
          // 回执不得仍装成零次尝试：结果未知时由 WorkflowRunner 保留 outcomeUncertain，
          // 交由人工核账闭环而不是解锁重试。
          providerOutcomeKnown: ledgerProviderOutcomeKnown(openedLedger?.ledger),
        },
      };
    }
    return {
      ...baseline,
      commandId: requiredString(request.commandId, "commandId"),
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath,
        ...(plan.sourceVisualReview ? { sourceVisualReview: plan.sourceVisualReview } : {}),
      },
      artifacts: [
        ...retainedFinalAssetArtifacts(baseline.artifacts, planPath, assets),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics,
    };
  }

  private pilotReviewUnavailable(request: Record<string, unknown>, parameters: Record<string, unknown>): WorkerResponse | undefined {
    try {
      this.options.pilotReviewer?.assertAvailable(optionalString(parameters.reviewProviderId), optionalString(parameters.reviewModelId));
      return undefined;
    } catch (error) {
      return {
        protocolVersion: "video-factory/worker-v1",
        commandId: requiredString(request.commandId, "commandId"),
        status: "failed",
        artifacts: [],
        error: { code: "ASSET_PILOT_REVIEW_UNAVAILABLE", message: safeGenerationDiagnostic(error) },
        diagnostics: { providerOutcomeKnown: true, meteredAttemptCount: 0, meteredFailedAttemptCount: 0, actualCostCny: 0 },
      };
    }
  }

  private async reviewPilot(options: {
    request: Record<string, unknown>;
    parameters: Record<string, unknown>;
    plan: Record<string, unknown>;
    planPath: string;
    ledgerItem: PaidAssetOperationItem | undefined;
    job: GenerationJob;
    approvedPilotGroups: Set<string>;
    mediaArtifacts: WorkerArtifactDescriptor[];
  }): Promise<void> {
    const reviewer = this.options.pilotReviewer;
    if (!reviewer) return;
    const { request, parameters, plan, planPath, ledgerItem: item, job } = options;
    if (!item?.sha256) throw new Error("Pilot review requires a materialized asset identity.");
    // 每个方案内，不同模型和参考图生成路线分别试片；先审首个镜头再提交后续付费任务。
    const group = JSON.stringify([item.providerId, item.modelId, item.parameters.mediaType,
      item.parameters.ratio, item.parameters.referenceFromScenePosition !== undefined]);
    if (options.approvedPilotGroups.has(group)) return;
    const input = requiredRecord(request.input, "Worker input");
    const scriptPath = requiredString(input.scriptPath, "scriptPath");
    const outputDir = requiredString(request.outputDir, "outputDir");
    await writeJsonAtomically(planPath, plan);
    try {
      const result = await reviewer.review({
        runRoot: this.options.runsRoot
          ? path.join(this.options.runsRoot, requiredString(request.runId, "runId"))
          : path.dirname(scriptPath),
        outputDir,
        assetPlanPath: planPath,
        scriptPath,
        ...(optionalString(input.directorPlanPath) ? { directorPlanPath: String(input.directorPlanPath) } : {}),
        scenePosition: item.scenePosition,
        inputFingerprint: item.inputFingerprint,
        mediaSha256: item.sha256,
        ...(optionalString(parameters.reviewProviderId) ? { reviewProviderId: String(parameters.reviewProviderId) } : {}),
        ...(optionalString(parameters.reviewModelId) ? { reviewModelId: String(parameters.reviewModelId) } : {}),
      });
      options.mediaArtifacts.push(await describeFile(result.reportPath, "review_report", "application/json",
        optionalString(parameters.reviewProviderId) ?? "source-asset-pilot-review", request,
        "Pilot source review before subsequent paid generation.", item.scenePosition));
      const report = result.execution.output;
      plan.sourceVisualReview = report;
      // 本闸门只为"是否继续为同方案其余镜头付费"负责，放行判据见 visualReviewBlocksContinuation：
      // 提示词要求模型诚实记录无法核验项，若把该咨询项当作阻断条件，任何未覆盖项都会永久停掉付费生成。
      if (visualReviewBlocksContinuation(report)) {
        job.pilotReview = "rejected";
        throw new AssetPilotReviewError(`镜头 ${item.scenePosition} 试片未通过，已停止后续付费生成。已保留试片与审查报告。${report.summary} ${report.findings.map((finding) => finding.suggestion).join(" ")} 请调整对应方案后重新报价；已生成素材不会自动重买。`);
      }
      job.pilotReview = "approved";
      options.approvedPilotGroups.add(group);
    } catch (error) {
      if (error instanceof AssetPilotReviewError) throw error;
      job.pilotReview = "unavailable";
      const incomplete = new AssetPilotReviewError(`镜头 ${item.scenePosition} 已生成，但试片审查暂未完成，后续付费生成已停止。重试时会复用该镜头并恢复审查。${safeGenerationDiagnostic(error)}`);
      incomplete.reviewIncomplete = true;
      throw incomplete;
    }
  }

  private resolveBinding(providerId: string, modelId?: string): ResolvedAssetBinding | undefined {
    const video = this.adapters.get(providerId);
    if (video) {
      const effectiveModelId = modelId ?? video.defaultModelId;
      const estimatedCnyPerAsset = effectiveModelId
        ? video.modelPrices?.[effectiveModelId]
        : video.estimatedCnyPerClip;
      if (estimatedCnyPerAsset === undefined) {
        throw new Error(`Provider '${providerId}' does not expose model '${effectiveModelId}'.`);
      }
      const profile = effectiveModelId ? video.modelProfiles?.[effectiveModelId] : undefined;
      if (video.modelProfiles && effectiveModelId && !profile) {
        throw new Error(`Provider '${providerId}' does not expose a runtime profile for model '${effectiveModelId}'.`);
      }
      if (profile && !profile.taskTypes.includes("text-to-video")) {
        throw new Error(`Video model '${effectiveModelId}' does not support text-to-video generation.`);
      }
      if (profile?.aspectRatios && !profile.aspectRatios.includes("9:16")) {
        throw new Error(`Video model '${effectiveModelId}' does not support the required 9:16 aspect ratio.`);
      }
      return {
        mediaType: "video",
        estimatedCnyPerAsset,
        resolveRequest: (scene, compiledPrompt, reference) => resolveAssetExecutionRequest({
          scene,
          providerId,
          modelId: effectiveModelId ?? providerId,
          compiledPrompt,
          mediaType: "video",
          ...(profile ? { profile } : {}),
          ...(reference ? { reference } : {}),
        }),
        estimateCny: (request) => estimateResolvedVideoGenerationCostCny(
          request,
          estimatedCnyPerAsset,
          profile,
        ),
        ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
        generate: async (request, onProgress) => {
          const result = await video.adapter.generate({
            prompt: request.compiledPrompt,
            durationSeconds: request.durationSeconds,
            ratio: request.ratio,
            ...(request.resolution ? { resolution: request.resolution } : {}),
            ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}),
            ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
          }, onProgress);
          return { taskId: result.taskId, url: result.videoUrl };
        },
        ...(video.adapter.reconcile
          ? {
              reconcile: async (taskId, request, onProgress) => {
                const result = await video.adapter.reconcile!(taskId, {
                  prompt: request.compiledPrompt,
                  durationSeconds: request.durationSeconds,
                  ratio: request.ratio,
                  ...(request.resolution ? { resolution: request.resolution } : {}),
                  ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}),
                  ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
                }, onProgress);
                return { taskId: result.taskId, url: result.videoUrl };
              },
            }
          : {}),
      };
    }
    const image = this.imageAdapters.get(providerId);
    if (image) {
      const modelId = optionalString(image.adapter.modelId);
      return {
        mediaType: "image",
        supportsReferenceImage: image.adapter.supportsReferenceImage ?? false,
        estimatedCnyPerAsset: image.estimatedCnyPerImage,
        resolveRequest: (scene, compiledPrompt, reference) => resolveAssetExecutionRequest({
          scene,
          providerId,
          modelId: modelId ?? providerId,
          compiledPrompt,
          mediaType: "image",
          ...(reference ? { reference } : {}),
        }),
        estimateCny: () => image.estimatedCnyPerImage,
        ...(modelId ? { modelId } : {}),
        generate: async (request, onProgress, referenceImages) => {
          const result = await image.adapter.generate({
            prompt: request.compiledPrompt,
            ratio: request.ratio,
            ...(referenceImages ? { referenceImages } : {}),
          }, onProgress);
          return { taskId: result.taskId, url: result.imageUrl };
        },
      };
    }
    return undefined;
  }

  private async validateGeneratedMedia(
    mediaPath: string,
    mediaType: "image" | "video",
    plannedUseDurationSeconds: number,
  ): Promise<GeneratedMediaMetadata | undefined> {
    if (!this.probeGeneratedMedia) return undefined;
    const metadata = await this.probeGeneratedMedia(mediaPath, mediaType);
    if (!Number.isInteger(metadata.width) || metadata.width <= 0
      || !Number.isInteger(metadata.height) || metadata.height <= 0
      || (mediaType === "video"
        && (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds! <= 0))) {
      throw new GeneratedMediaContractError(`Generated ${mediaType} has invalid probed media metadata.`);
    }
    const actualRatio = metadata.width / metadata.height;
    const requiredRatio = 9 / 16;
    if (Math.abs(actualRatio - requiredRatio) > 0.02) {
      throw new GeneratedMediaContractError(
        `Generated ${mediaType} is ${metadata.width}x${metadata.height}, which does not satisfy the required 9:16 aspect ratio.`,
      );
    }
    // ffprobe 的容器时长可能与最后一帧相差一个很小的时间基单位；保留约两个常见视频帧的余量。
    if (mediaType === "video" && metadata.durationSeconds! + 0.1 < plannedUseDurationSeconds) {
      throw new GeneratedMediaContractError(
        `Generated video is ${metadata.durationSeconds}s, shorter than the planned ${plannedUseDurationSeconds}s use.`,
      );
    }
    return metadata;
  }
}

export interface ReworkCarryForwardInspection {
  runsRoot: string;
  input: Record<string, unknown>;
  currentScript: Record<string, unknown>;
  currentDirectorPlan: Record<string, unknown>;
  modelSelections: Readonly<Record<string, string>>;
}

export async function inspectReworkCarriedAssetScenePositions(
  options: ReworkCarryForwardInspection,
): Promise<number[]> {
  const items = await findReworkCarryForwardItems(options);
  return [...new Set(items.map((item) => item.scenePosition))].sort((left, right) => left - right);
}

export interface ReworkAffectedSceneScope {
  findings: unknown;
  previousScenes?: unknown;
  previousShots?: unknown;
  currentScenes: unknown;
  currentShots?: unknown;
  // 新版 Studio 由创作者显式确认该范围；旧 run 缺少字段时无法可靠还原用户意图，
  // 因此保守按全片处理。
  affectedScenePositions?: readonly number[];
}

// 人工确认的结构化范围是执行上界。审片定位、脚本差异或 reference/REUSE 依赖若在
// 确认后扩大，必须回到确认页更新范围，不能在素材执行阶段静默扩大付费工作。
export function reworkAffectedScenePositions(scope: ReworkAffectedSceneScope): number[] {
  const currentSceneRecords = positionedRecords(scope.currentScenes, "position");
  const validPositions = new Set(currentSceneRecords.keys());
  if (validPositions.size === 0) return [];
  if (scope.affectedScenePositions === undefined) {
    return [...validPositions].sort((left, right) => left - right);
  }
  const approved = new Set(scope.affectedScenePositions.filter((position) => (
    Number.isInteger(position) && position > 0 && validPositions.has(position)
  )));
  if (approved.size !== scope.affectedScenePositions.length) {
    throw new Error("返工镜头范围与当前脚本不一致，请重新确认返工范围。");
  }
  const findings = Array.isArray(scope.findings) ? scope.findings : [];
  const visualFindings = findings.filter((finding) => (
    isRecord(finding)
    && Array.isArray(finding.targetNodeIds)
    && finding.targetNodeIds.some((target) => target === "visual-direction" || target === "assets")
    && finding.action !== "inspect_existing_media"
    && finding.nextAction !== "inspect_existing_media"
  ));
  const required = new Set<number>();
  for (const finding of visualFindings) {
    const position = Number(finding.scenePosition);
    if (!Number.isInteger(finding.scenePosition) || finding.scenePosition === undefined) {
      for (const validPosition of validPositions) required.add(validPosition);
      continue;
    }
    if (position > 0 && !validPositions.has(position)) {
      throw new Error(`返工 finding 指向镜头 ${position}，但当前脚本中不存在该镜头，请修正问题定位或重新确认返工范围。`);
    }
    if (position > 0) required.add(position);
  }
  const previousSceneRecords = positionedRecords(scope.previousScenes, "position");
  if (previousSceneRecords.size > 0) {
    for (const [position, scene] of currentSceneRecords) {
      if (!isDeepStrictEqual(
        scriptVisualIntent(scene),
        scriptVisualIntent(previousSceneRecords.get(position)),
      )) required.add(position);
    }
  }
  const requiredClosure = reworkSceneDependencyClosure([...required], scope.previousShots, scope.currentShots);
  const approvedClosure = reworkSceneDependencyClosure([...approved], scope.previousShots, scope.currentShots);
  const outsideApproval = [...new Set([...requiredClosure, ...approvedClosure])]
    .filter((position) => validPositions.has(position) && !approved.has(position));
  if (outsideApproval.length > 0) {
    throw new Error(`返工影响范围新增了镜头 ${outsideApproval.sort((left, right) => left - right).join("、")}，请重新确认返工范围。`);
  }
  return [...approved].sort((left, right) => left - right);
}

function scriptVisualIntent(scene: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!scene) return undefined;
  return {
    visualStrategy: scene.visual_strategy,
    visualPrompt: scene.visual_prompt,
  };
}

export function reworkSceneDependencyClosure(
  scenePositions: readonly number[],
  ...shotSets: unknown[]
): number[] {
  const affected = new Set(scenePositions.filter((position) => Number.isInteger(position) && position > 0));
  // 旧版与新版方案的依赖边必须一起求不动点。逐份求闭包会漏掉
  // “新方案 2→1、旧方案 3→2”这类跨集合传播。
  let expanded = true;
  while (expanded) {
    const sizeBefore = affected.size;
    for (const shots of shotSets) expandAffectedDependencies(affected, shots);
    expanded = affected.size !== sizeBefore;
  }
  return [...affected].sort((left, right) => left - right);
}

function expandAffectedDependencies(affected: Set<number>, shots: unknown): void {
  if (!Array.isArray(shots)) return;
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const shot of shots) {
      if (!isRecord(shot)) continue;
      const position = Number(shot.scenePosition);
      const dependency = shotDependencyPosition(shot);
      if (!Number.isInteger(position) || position < 1
        || dependency === undefined || !affected.has(dependency) || affected.has(position)) continue;
      affected.add(position);
      expanded = true;
    }
  }
}

function shotDependencyPosition(shot: Record<string, unknown>): number | undefined {
  const reference = Number(shot.referenceFromScenePosition);
  if (Number.isInteger(reference) && reference >= 1) return reference;
  const reuse = Number(shot.reuseFromScenePosition);
  return assetReuseSourceScenePosition({
    query: typeof shot.query === "string" ? shot.query : "",
    ...(Number.isInteger(reuse) && reuse >= 1 ? { reuseFromScenePosition: reuse } : {}),
  });
}

async function findReworkCarryForwardItems(
  options: Partial<Pick<ReworkCarryForwardInspection, "runsRoot">>
    & Omit<ReworkCarryForwardInspection, "runsRoot">,
): Promise<PaidAssetOperationItem[]> {
  if (!options.runsRoot || !isRecord(options.input.rework)) return [];
  const rework = options.input.rework;
  const sourceRunId = optionalString(rework.sourceRunId);
  const sourceRunRevision = rework.sourceRunRevision;
  if (!sourceRunId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceRunId)
    || !Number.isSafeInteger(sourceRunRevision)
    || !isRecord(rework.previousScript)
    || !isRecord(rework.previousDirectorPlan)) {
    return [];
  }

  const routedShots = parseRoutedShots(options.currentDirectorPlan.shots);
  // 与导演节点使用同一套统一影响闭包；结构化 affectedScenePositions 决定用户选择，
  // 旧 run 缺少该字段时由闭包保守按全片处理。
  const explicitlyRejectedMedia = new Set<number>(
    Array.isArray(rework.findings)
      ? rework.findings.flatMap((finding) => (
          isRecord(finding)
          && Array.isArray(finding.targetNodeIds)
          && finding.targetNodeIds.includes("assets")
          && finding.action !== "inspect_existing_media"
          && Number.isInteger(finding.scenePosition)
            ? [Number(finding.scenePosition)]
            : []
        ))
      : [],
  );
  // 人工批准的重做范围（affectedScenePositions）是显式重生成意图：范围内镜头不再继承
  // 旧母片；空范围表示"全部保留"；旧 run 缺字段时保守按全片重做（不继承）。范围外镜头
  // 仍可携带，再由 safelyCarriableReworkItems 的执行身份/引用证明逐项核验淘汰。
  const regenerationScope = new Set<number>(
    rework.affectedScenePositions === undefined || !Array.isArray(rework.affectedScenePositions)
      ? routedShots.map((route) => route.scenePosition)
      : rework.affectedScenePositions.filter((position) => Number.isInteger(position) && Number(position) > 0),
  );
  // 先保留所有未被明确判定为素材不合格、也不在批准重做范围内的候选，再以当前归一化
  // 请求逐项比较。script/director 责任变化本身不等于媒体请求变化；真实 effect/request
  // 改变仍由 safelyCarriableReworkItems 的执行身份核验淘汰。
  const reusableScenes = new Set(routedShots.flatMap((shot) => (
    explicitlyRejectedMedia.has(shot.scenePosition) || regenerationScope.has(shot.scenePosition)
      ? []
      : [shot.scenePosition]
  )));
  if (reusableScenes.size === 0) return [];

  const sourceItems = await effectiveSourcePaidAssetItems(
    options.runsRoot,
    sourceRunId,
    Number(sourceRunRevision),
  );
  return safelyCarriableReworkItems(sourceItems, reusableScenes, routedShots, options.modelSelections, regenerationScope);
}

// previous 计划若缺少执行语义必需字段则无法证明任何镜头可安全继承，fail closed 按新生成报价。
// 参考图生成的母片与独立生成母片一样可以跨 run 继承，但必须能证明引用链身份：
// 引用源镜头同样可安全继承且为 materialized image，source item 记录的 referenceImageSha256
// 与实际继承源的 SHA-256 一致，且与当前路由声明的 referenceFromScenePosition 相同。
// 任何一项无法证明时 fail closed，按新生成报价。
function safelyCarriableReworkItems(
  sourceItems: PaidAssetOperationItem[],
  reusableScenes: Set<number>,
  routedShots: RoutedShot[],
  modelSelections: Readonly<Record<string, string>>,
  regenerationScope?: Set<number>,
): PaidAssetOperationItem[] {
  const routedByPosition = new Map(routedShots.map((route) => [route.scenePosition, route]));
  const carried: PaidAssetOperationItem[] = [];
  const pending: PaidAssetOperationItem[] = [];
  for (const item of sourceItems) {
    if (!reusableScenes.has(item.scenePosition)) continue;
    if (modelSelections[item.providerId] !== item.modelId) continue;
    if (item.parameters.referenceFromScenePosition === undefined) {
      carried.push(item);
      continue;
    }
    pending.push(item);
  }
  const carriedByPosition = new Map(carried.map((item) => [item.scenePosition, item]));
  // 多级引用链（1 -> 2 -> 3）按依赖可见顺序反复消化 pending reference items：
  // 每成功继承一项就立即加入 carriedByPosition，让下一层可以看到刚被证明安全的源；
  // 直到没有新进展为止。循环、缺失源或身份无法证明的条目最终留在 deferred 中不被继承，
  // fail closed 按新生成报价，不得猜测。
  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: PaidAssetOperationItem[] = [];
    let progressed = false;
    for (const item of remaining) {
      const referenceFrom = Number(item.parameters.referenceFromScenePosition);
      const referenceSha256 = item.parameters.referenceImageSha256;
      const source = carriedByPosition.get(referenceFrom);
      if (typeof referenceSha256 !== "string"
        || !Number.isInteger(referenceFrom) || referenceFrom < 1
        || routedByPosition.get(item.scenePosition)?.referenceFromScenePosition !== referenceFrom
        || !source
        || source.parameters.mediaType !== "image"
        || source.sha256 !== referenceSha256) {
        deferred.push(item);
        continue;
      }
      carried.push(item);
      carriedByPosition.set(item.scenePosition, item);
      progressed = true;
    }
    if (!progressed) break;
    remaining = deferred;
  }
  // BG-05：证明失败且未被人工批准重生成的母片进入 needs_evidence——不得静默转购买。
  const needsEvidence = remaining
    .filter((item) => !regenerationScope?.has(item.scenePosition))
    .map((item) => item.scenePosition)
    .sort((left, right) => left - right);
  if (needsEvidence.length > 0) {
    throw new ReworkEvidenceRequiredError([...new Set(needsEvidence)]);
  }
  return carried;
}

async function effectiveSourcePaidAssetItems(
  runsRoot: string,
  sourceRunId: string,
  sourceRunRevision: number,
): Promise<PaidAssetOperationItem[]> {
  let sourceRun: Record<string, unknown>;
  try {
    sourceRun = requiredRecord(
      JSON.parse(await readFile(path.join(runsRoot, sourceRunId, "run.json"), "utf8")),
      "Rework source run",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (sourceRun.revision !== sourceRunRevision || !Array.isArray(sourceRun.nodeRuns)) return [];
  const assetNodes = sourceRun.nodeRuns.filter((value): value is Record<string, unknown> => (
    isRecord(value) && value.nodeId === "assets"
  ));
  if (assetNodes.length !== 1) return [];
  const assetNode = assetNodes[0]!;
  const outputState = isRecord(assetNode.outputState) ? assetNode.outputState : undefined;
  const operationId = optionalString(assetNode.operationRequestId);
  if (!operationId) return [];
  // 只有源 assets 节点存在 outcomeUncertain（恢复流程仍可能改写该账本）时，才禁止
  // 根据不确定账本自动继承。节点已 failed 但结果确定（不存在 outcomeUncertain）时，
  // 不再以整节点 succeeded / 整账本 completed 作为继承前提，改为按 ledger item 独立判定：
  // terminal_failed、unknown、submitted 或真实文件无法通过 SHA-256/size 校验的条目一律不继承。
  if (assetNode.outcomeUncertain === true) return [];
  if (assetNode.status === "succeeded") {
    // 成功节点保留原有输出新鲜度门禁，防止从已被后续版本替代的输出继承。
    if (!outputState
      || outputState.stale !== false
      || typeof outputState.generatedVersionId !== "string"
      || outputState.generatedVersionId !== outputState.effectiveVersionId) {
      return [];
    }
  }
  const ledgerPath = path.join(
    runsRoot,
    sourceRunId,
    "nodes",
    "assets",
    ".generation-operations",
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  let ledger: PaidAssetOperationLedger;
  try {
    ledger = parsePaidAssetOperationLedger(JSON.parse(await readFile(ledgerPath, "utf8")), operationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const verified: PaidAssetOperationItem[] = [];
  for (const item of ledger.items) {
    if (item.state !== "materialized") continue;
    try {
      await verifyMaterializedItem(item);
      verified.push(item);
    } catch {
      // 源文件缺失或身份变化时按新生成报价，不能承诺一次无法兑现的零费用继承。
    }
  }
  const latestSourceRun = requiredRecord(
    JSON.parse(await readFile(path.join(runsRoot, sourceRunId, "run.json"), "utf8")),
    "Rework source run",
  );
  if (latestSourceRun.revision !== sourceRunRevision) return [];
  return verified;
}

function zeroMeteredAttemptFailure(response: WorkerResponse): WorkerResponse {
  // 免费素材预检发生在付费 adapter 之前，没有任何付费 create 被跨越：
  // 显式零次计费 + providerOutcomeKnown=true 让 workflow 能安全清除 outcomeUncertain。
  return {
    ...response,
    diagnostics: {
      ...(response.diagnostics ?? {}),
      actualCostCny: 0,
      actualCostSource: "configured_rate",
      meteredAttemptCount: 0,
      meteredFailedAttemptCount: 0,
      providerOutcomeKnown: true,
    },
  };
}

function insufficientAssetAuthorizationFailure(
  request: Record<string, unknown>,
  estimatedCostCny: number,
  authorizedMaximumCny: number,
): WorkerResponse {
  return {
    protocolVersion: "video-factory/worker-v1",
    commandId: requiredString(request.commandId, "commandId"),
    status: "failed",
    artifacts: [],
    error: {
      code: "ASSET_AUTHORIZATION_INSUFFICIENT",
      message: `Estimated cost ¥${estimatedCostCny} exceeds the authorized maximum ¥${authorizedMaximumCny}.`,
    },
    // 失败发生在本地预算预检，任何媒体 Provider create 都尚未执行。
    diagnostics: {
      providerOutcomeKnown: true,
      meteredAttemptCount: 0,
      meteredFailedAttemptCount: 0,
      actualCostCny: 0,
      actualCostSource: "configured_rate",
    },
  };
}

export function estimateVideoGenerationCostCny(
  sceneDurationSeconds: number,
  estimatedCnyPerClip: number,
  profile?: VideoGenerationRuntimeProfile,
): number {
  const durationSeconds = normalizeVideoGenerationDurationSeconds(sceneDurationSeconds, profile);
  const resolution = preferredResolution(profile?.resolutions);
  const perSecond = resolution
    ? profile?.estimatedCnyPerSecondByResolution?.[resolution]
    : undefined;
  const fixedSpecPrice = resolution
    ? profile?.estimatedCnyByResolutionAndDuration?.[resolution]?.[String(durationSeconds)]
    : undefined;
  const rate = perSecond ?? profile?.estimatedCnyPerSecond;
  return roundMoney(fixedSpecPrice ?? (rate ? durationSeconds * rate : estimatedCnyPerClip));
}

function estimateResolvedVideoGenerationCostCny(
  request: ResolvedAssetExecutionRequest,
  estimatedCnyPerClip: number,
  profile?: VideoGenerationRuntimeProfile,
): number {
  const resolution = request.resolution;
  const fixedSpecPrice = resolution
    ? profile?.estimatedCnyByResolutionAndDuration?.[resolution]?.[String(request.durationSeconds)]
    : undefined;
  const rate = resolution
    ? profile?.estimatedCnyPerSecondByResolution?.[resolution] ?? profile?.estimatedCnyPerSecond
    : profile?.estimatedCnyPerSecond;
  return roundMoney(fixedSpecPrice ?? (rate ? request.durationSeconds * rate : estimatedCnyPerClip));
}

function optionalStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const input = requiredRecord(value, field);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}.${key} must be a non-empty string.`);
    return [key, item.trim()];
  }));
}

function optionalNumberRecord(value: unknown, field: string): Record<string, number> {
  if (value === undefined) return {};
  const input = requiredRecord(value, field);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) {
      throw new Error(`${field}.${key} must be a non-negative integer.`);
    }
    return [key, item];
  }));
}

function parseScenes(value: unknown): ScriptScene[] {
  if (!Array.isArray(value)) {
    throw new Error("Script scenes must be an array.");
  }
  return value.map((entry, index) => {
    const scene = requiredRecord(entry, `Script scene ${index + 1}`);
    return {
      position: boundedInteger(scene.position, `Script scene ${index + 1} position`, 1, 10_000),
      duration: boundedNumber(scene.duration, `Script scene ${index + 1} duration`, 0.1, 180),
      visualStrategy: requiredString(scene.visual_strategy, `Script scene ${index + 1} visual_strategy`),
      visualPrompt: requiredString(scene.visual_prompt, `Script scene ${index + 1} visual_prompt`),
    };
  });
}

export function resolveAssetExecutionRequest(options: {
  scene: ScriptScene;
  providerId: string;
  modelId: string;
  compiledPrompt: string;
  mediaType: "image" | "video";
  profile?: VideoGenerationRuntimeProfile;
  reference?: { scenePosition: number; imageSha256?: string };
}): ResolvedAssetExecutionRequest {
  const durationSeconds = options.mediaType === "video"
    ? normalizeVideoGenerationDurationSeconds(options.scene.duration, options.profile)
    : 1;
  const resolution = options.mediaType === "video"
    ? preferredResolution(options.profile?.resolutions)
    : undefined;
  const identity = {
    providerId: options.providerId,
    modelId: options.modelId,
    compiledPrompt: options.compiledPrompt,
    mediaType: options.mediaType,
    durationSeconds,
    ratio: "9:16" as const,
    ...(resolution ? { resolution } : {}),
    ...(options.mediaType === "video" && options.profile ? { generateAudio: false } : {}),
    ...(options.reference ? { referenceFromScenePosition: options.reference.scenePosition } : {}),
    ...(options.reference?.imageSha256 ? { referenceImageSha256: options.reference.imageSha256 } : {}),
  };
  return {
    ...identity,
    executionDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

export function normalizeVideoGenerationDurationSeconds(
  sceneDurationSeconds: number,
  bounds?: VideoGenerationDurationBounds,
): number {
  if (!Number.isFinite(sceneDurationSeconds) || sceneDurationSeconds <= 0) {
    throw new Error("Video generation scene duration must be a positive number.");
  }
  const minimum = bounds?.minDurationSeconds ?? 4;
  const maximum = bounds?.maxDurationSeconds ?? 15;
  if (!Number.isInteger(minimum)
    || !Number.isInteger(maximum)
    || minimum < 2
    || maximum > 15
    || minimum > maximum) {
    throw new Error("Video generation duration bounds are invalid.");
  }
  const requiredFrames = Math.round(sceneDurationSeconds * 30);
  if (bounds?.allowedDurationsSeconds) {
    const allowed = [...new Set(bounds.allowedDurationsSeconds)].sort((left, right) => left - right);
    if (allowed.length === 0
      || allowed.some((duration) => !Number.isInteger(duration) || duration < minimum || duration > maximum)
      || allowed[0] !== minimum
      || allowed.at(-1) !== maximum) {
      throw new Error("Video generation allowed durations are invalid.");
    }
    const normalized = allowed.find((duration) => duration * 30 >= requiredFrames) ?? maximum;
    if (normalized * 30 < requiredFrames) {
      throw new Error(`Video generation model cannot cover the required ${sceneDurationSeconds}s source range.`);
    }
    return normalized;
  }
  const normalized = Math.max(minimum, Math.ceil(requiredFrames / 30));
  if (normalized > maximum) {
    throw new Error(`Video generation model cannot cover the required ${sceneDurationSeconds}s source range.`);
  }
  return normalized;
}

function preferredResolution(resolutions: string[] | undefined): VideoGenerationRequest["resolution"] | undefined {
  if (!resolutions) return undefined;
  const normalized = resolutions.map((value) => value.toLowerCase());
  const selected = (["768p", "720p", "1080p", "480p", "2k"] as const)
    .find((value) => normalized.includes(value));
  return selected === "768p" ? "768P" : selected === "2k" ? "2K" : selected;
}

function validateVideoRuntimeProfile(providerId: string, modelId: string, profile: VideoGenerationRuntimeProfile): void {
  if (!modelId.trim()
    || !Array.isArray(profile.taskTypes)
    || profile.taskTypes.length === 0
    || profile.taskTypes.some((task) => task !== "text-to-video" && task !== "image-to-video")
    || !Array.isArray(profile.resolutions)
    || profile.resolutions.length === 0
    || (profile.aspectRatios !== undefined && (
      !Array.isArray(profile.aspectRatios)
      || profile.aspectRatios.length === 0
      || profile.aspectRatios.some((ratio) => !["9:16", "16:9", "1:1", "3:4", "4:3"].includes(ratio))
    ))
    || !Number.isInteger(profile.minDurationSeconds)
    || !Number.isInteger(profile.maxDurationSeconds)
    || profile.minDurationSeconds < 2
    || profile.maxDurationSeconds > 15
    || profile.minDurationSeconds > profile.maxDurationSeconds
    || typeof profile.supportsAudio !== "boolean") {
    throw new Error(`Adapter '${providerId}' has an invalid runtime profile for model '${modelId}'.`);
  }
  if (profile.allowedDurationsSeconds) {
    const allowed = [...new Set(profile.allowedDurationsSeconds)].sort((left, right) => left - right);
    if (allowed.length === 0
      || allowed.length !== profile.allowedDurationsSeconds.length
      || allowed.some((duration) => !Number.isInteger(duration)
        || duration < profile.minDurationSeconds
        || duration > profile.maxDurationSeconds)
      || allowed[0] !== profile.minDurationSeconds
      || allowed.at(-1) !== profile.maxDurationSeconds) {
      throw new Error(`Adapter '${providerId}' has invalid allowed durations for model '${modelId}'.`);
    }
  }
  if (profile.estimatedCnyPerSecond !== undefined
    && (!Number.isFinite(profile.estimatedCnyPerSecond) || profile.estimatedCnyPerSecond <= 0)) {
    throw new Error(`Adapter '${providerId}' has an invalid per-second price for model '${modelId}'.`);
  }
  for (const [resolution, price] of Object.entries(profile.estimatedCnyPerSecondByResolution ?? {})) {
    if (!profile.resolutions.includes(resolution) || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Adapter '${providerId}' has an invalid '${resolution}' price for model '${modelId}'.`);
    }
  }
  for (const [resolution, prices] of Object.entries(profile.estimatedCnyByResolutionAndDuration ?? {})) {
    if (!profile.resolutions.includes(resolution) || !isRecord(prices)) {
      throw new Error(`Adapter '${providerId}' has invalid fixed-spec prices for model '${modelId}'.`);
    }
    for (const [duration, price] of Object.entries(prices)) {
      if (!profile.allowedDurationsSeconds?.includes(Number(duration)) || !Number.isFinite(price) || price <= 0) {
        throw new Error(`Adapter '${providerId}' has invalid '${resolution}/${duration}s' price for model '${modelId}'.`);
      }
    }
  }
}

function uniqueActualModelIds(jobs: GenerationJob[]): string[] {
  return [...new Set(
    jobs
      .filter((job) => Boolean(job.taskId?.trim()))
      .map((job) => job.modelId ?? job.providerId),
  )];
}

function actualModelDiagnostics(jobs: GenerationJob[]): { actualModelIds?: string[] } {
  const actualModelIds = uniqueActualModelIds(jobs);
  return actualModelIds.length ? { actualModelIds } : {};
}

function applyAcceptedTask(job: GenerationJob, taskId: string, costCny: number): void {
  job.taskId = taskId;
  if (taskId.trim()) {
    job.actualCostCny = roundMoney(costCny);
    job.actualCostSource = "configured_rate";
  }
}

function configuredCost(jobs: GenerationJob[]): number {
  return roundMoney(jobs.reduce((sum, job) => sum + (job.carriedForward ? 0 : job.actualCostCny ?? 0), 0));
}

export function assetReuseSourceScenePosition(
  route: { reuseFromScenePosition?: number | null; query: string },
): number | undefined {
  // 模型 JSON Schema 用 null 表示“没有复用根”。它必须与字段缺失同义，否则根镜头会在
  // 可执行计划编译时被误判成非法复用；真正的数字仍交给各业务边界校验范围和先后关系。
  if (route.reuseFromScenePosition !== undefined && route.reuseFromScenePosition !== null) {
    return route.reuseFromScenePosition;
  }
  const match = /^REUSE_ONLY\s+scene\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(route.query);
  if (!match) return undefined;
  const token = match[1]?.toLowerCase() ?? "";
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return /^\d+$/.test(token) ? Number(token) : words[token];
}

/**
 * 计算每条独立母片必须覆盖的完整源区间。报价和执行必须共用这一个口径：复用镜头虽然
 * 不会新增购买，但它的 sourceIn + cut 时长可能要求母片生成得更长。
 */
export function requiredGeneratedAssetDurationSecondsByRoot(
  scenes: readonly { position: number; duration: number }[],
  routes: readonly {
    scenePosition: number;
    sourceInSeconds?: number;
    reuseFromScenePosition?: number;
    query: string;
  }[],
): Map<number, number> {
  const sceneByPosition = new Map(scenes.map((scene) => [scene.position, scene] as const));
  const routeByPosition = new Map(routes.map((route) => [route.scenePosition, route] as const));
  if (sceneByPosition.size !== scenes.length || routeByPosition.size !== routes.length) {
    throw new Error("Script scenes and director routes must have unique positions.");
  }
  const orderedScenes = [...scenes].sort((left, right) => left.position - right.position);
  const frameCountsByScenePosition = new Map(
    quantizeDurationsToFrames(orderedScenes.map((scene) => scene.duration))
      .map((frameCount, index) => [orderedScenes[index]!.position, frameCount] as const),
  );
  const durationByRoot = new Map<number, number>();
  for (const route of routes) {
    const frameCount = frameCountsByScenePosition.get(route.scenePosition);
    if (frameCount === undefined) {
      throw new Error(`Director scene ${route.scenePosition} has no matching script scene.`);
    }
    const sourceInSeconds = route.sourceInSeconds ?? 0;
    if (!Number.isFinite(sourceInSeconds) || sourceInSeconds < 0) {
      throw new Error(`Director scene ${route.scenePosition} has an invalid sourceInSeconds.`);
    }
    const visited = new Set<number>([route.scenePosition]);
    let root = route;
    while (true) {
      const reuseFrom = assetReuseSourceScenePosition(root);
      if (reuseFrom === undefined) break;
      const source = routeByPosition.get(reuseFrom);
      if (reuseFrom >= root.scenePosition || !source || visited.has(reuseFrom)) {
        throw new Error(`Scene ${root.scenePosition} must reuse an earlier director scene, received ${reuseFrom}.`);
      }
      visited.add(reuseFrom);
      root = source;
    }
    const requiredFrames = Math.round(sourceInSeconds * 30) + frameCount;
    const currentFrames = Math.round((durationByRoot.get(root.scenePosition) ?? 0) * 30);
    durationByRoot.set(root.scenePosition, Math.max(currentFrames, requiredFrames) / 30);
  }
  return durationByRoot;
}

function retainedFinalAssetArtifacts(
  artifacts: WorkerArtifactDescriptor[],
  assetPlanPath: string,
  assets: unknown[],
): WorkerArtifactDescriptor[] {
  const finalPaths = new Set(
    assets.flatMap((asset) => {
      if (typeof asset !== "object" || asset === null || Array.isArray(asset)) return [];
      const localPath = optionalString((asset as Record<string, unknown>).local_path);
      return localPath ? [localPath] : [];
    }),
  );
  return artifacts.filter((artifact) => (
    artifact.uri !== assetPlanPath
    && (artifact.kind !== "media_asset" || finalPaths.has(artifact.uri))
  ));
}

async function assertCompletedWorkerResponse(
  request: Record<string, unknown>,
  response: WorkerResponse,
  jobs: GenerationJob[] = [],
): Promise<void> {
  const input = requiredRecord(request.input, "Worker input");
  const scriptPath = requiredString(input.scriptPath, "scriptPath");
  const script = requiredRecord(JSON.parse(await readFile(scriptPath, "utf8")), "Script");
  const scenes = parseScenes(script.scenes);
  const directorPlanPath = optionalString(input.directorPlanPath);
  const routedShots = directorPlanPath
    ? parseRoutedShots(requiredRecord(JSON.parse(await readFile(directorPlanPath, "utf8")), "Director plan").shots)
    : undefined;
  const planPath = requiredString(response.output?.assetPlanPath, "assetPlanPath");
  const plan = requiredRecord(JSON.parse(await readFile(planPath, "utf8")), "Asset plan");
  assertCompletedAssetPlan(plan, scenes, routedShots, jobs);
  const finalPaths = new Set((Array.isArray(plan.scene_assets) ? plan.scene_assets : []).flatMap((asset) => {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset)) return [];
    const localPath = optionalString((asset as Record<string, unknown>).local_path);
    return localPath ? [localPath] : [];
  }));
  const obsoleteArtifact = response.artifacts.find((artifact) => artifact.kind === "media_asset" && !finalPaths.has(artifact.uri));
  if (obsoleteArtifact) {
    throw new Error(`Asset plan includes an obsolete media artifact: ${obsoleteArtifact.uri}`);
  }
}

function assertCompletedAssetPlan(
  plan: Record<string, unknown>,
  scenes: ScriptScene[],
  routedShots?: RoutedShot[],
  jobs: GenerationJob[] = [],
): void {
  const assets = Array.isArray(plan.scene_assets) ? plan.scene_assets : [];
  const routes = Array.isArray(plan.director_routing) ? plan.director_routing : [];
  const editorialCards = new Set((routedShots ?? [])
    .filter((shot) => shot.preferredProviderId === "local-editorial-v1" && shot.deliveryType === "editorial_card")
    .map((shot) => shot.scenePosition));
  const assetsByScene = new Map<number, Record<string, unknown>>();
  for (const candidate of assets) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Asset plan includes an invalid scene asset.");
    }
    const asset = candidate as Record<string, unknown>;
    const scenePosition = Number(asset.scene_position);
    if (!Number.isInteger(scenePosition) || scenePosition < 1 || assetsByScene.has(scenePosition)) {
      throw new Error("Asset plan must include exactly one asset per scene.");
    }
    if (!optionalString(asset.local_path)) {
      throw new Error(`Scene ${scenePosition} is still pending generation and cannot be rendered.`);
    }
    const matchingRoute = routes.find((candidate) => (
      typeof candidate === "object"
      && candidate !== null
      && !Array.isArray(candidate)
      && Number((candidate as Record<string, unknown>).scene_position) === scenePosition
    ));
    const usesLocalCard = identifiesLocalEditorialCard(asset, matchingRoute);
    if (usesLocalCard && !editorialCards.has(scenePosition)) {
      throw new Error(`Scene ${scenePosition} resolved to a local card without explicit editorial_card authorization.`);
    }
    assetsByScene.set(scenePosition, asset);
  }
  assertExactScenePositions("Asset plan", [...assetsByScene.keys()], scenes);
  if (routedShots) {
    assertExactScenePositions("Director plan", routedShots.map((shot) => shot.scenePosition), scenes);
    const routePositions = routes.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error("Asset plan includes an invalid director route.");
      }
      return Number((candidate as Record<string, unknown>).scene_position);
    });
    assertExactScenePositions("Asset plan director routes", routePositions, scenes);
  }
  for (const candidate of routes) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Asset plan includes an invalid director route.");
    }
    const route = candidate as Record<string, unknown>;
    const scenePosition = Number(route.scene_position);
    const asset = assetsByScene.get(scenePosition);
    if (!asset) throw new Error(`Asset plan is missing a final asset for scene ${scenePosition}.`);
    if (route.generation_pending === true) {
      throw new Error(`Scene ${scenePosition} is still pending generation and cannot be rendered.`);
    }
  }
  if (jobs.some((job) => job.status !== "succeeded")) {
    throw new Error("Asset plan cannot succeed while a generation job is incomplete or failed.");
  }
}

function identifiesLocalEditorialCard(asset: Record<string, unknown>, route?: unknown): boolean {
  const routeRecord = typeof route === "object" && route !== null && !Array.isArray(route)
    ? route as Record<string, unknown>
    : undefined;
  return asset.provider === "local"
    || asset.provider_id === "local-editorial-v1"
    || routeRecord?.actual_provider_id === "local-editorial-v1"
    || (typeof asset.source_url === "string" && asset.source_url.startsWith("local://video-factory/card"));
}

function assertExactScenePositions(label: string, positions: number[], scenes: ScriptScene[]): void {
  const expected = scenes.map((scene) => scene.position);
  const validPositions = positions.every((position) => Number.isInteger(position) && position > 0);
  const actualSet = new Set(positions);
  const expectedSet = new Set(expected);
  const exact = validPositions
    && positions.length === actualSet.size
    && expected.length === expectedSet.size
    && actualSet.size === expectedSet.size
    && [...expectedSet].every((position) => actualSet.has(position));
  if (!exact) throw new Error(`${label} must exactly cover every script scene once.`);
}

function meteredJobDiagnostics(jobs: GenerationJob[]): {
  meteredAttemptCount: number;
  meteredFailedAttemptCount: number;
} {
  const submittedJobs = jobs.filter((job) => job[METERED_CREATE_ATTEMPTED] === true);
  return {
    meteredAttemptCount: submittedJobs.length,
    meteredFailedAttemptCount: submittedJobs.filter((job) => job.status === "failed" && !job.pilotReview).length,
  };
}

// Provider 已成功但文件尚未物化时，本地仍没有可交付产物，也不能证明重新 create 安全；
// 必须保持 outcomeUncertain，直到同一 task 被物化或人工核账闭环。
function ledgerProviderOutcomeKnown(ledger: PaidAssetOperationLedger | undefined): boolean {
  if (!ledger) return true;
  return ledger.items.every((item) => ![
    "unknown",
    "submitted",
    "provider_succeeded",
  ].includes(item.state));
}

function isManuallyReconciledTerminalItem(item: PaidAssetOperationItem): boolean {
  return item.state === "terminal_failed" && item.error?.startsWith("Manual reconciliation '") === true;
}

function parseRoutedShots(value: unknown): RoutedShot[] {
  if (!Array.isArray(value)) throw new Error("Director plan shots must be an array.");
  return value.map((entry, index) => {
    const shot = requiredRecord(entry, `Director shot ${index + 1}`);
    const subject = optionalString(shot.subject);
    const environment = optionalString(shot.environment);
    const visibleAction = optionalString(shot.visibleAction);
    const shotSize = optionalString(shot.shotSize);
    const camera = optionalString(shot.camera);
    const lighting = optionalString(shot.lighting);
    const deliveryType = optionalString(shot.deliveryType);
    const sourceInSeconds = shot.sourceInSeconds === undefined
      ? 0
      : boundedNumber(shot.sourceInSeconds, `Director shot ${index + 1} sourceInSeconds`, 0, 180);
    if (["stock_image", "generated_image", "editorial_card"].includes(deliveryType ?? "")
      && sourceInSeconds !== 0) {
      throw new Error(`Director shot ${index + 1} sourceInSeconds must be 0 for static media.`);
    }
    const preferredProviderId = requiredString(shot.preferredProviderId, `Director shot ${index + 1} preferredProviderId`);
    const reuseFromScenePosition = shot.reuseFromScenePosition === undefined || shot.reuseFromScenePosition === null
      ? undefined
      : boundedInteger(shot.reuseFromScenePosition, `Director shot ${index + 1} reuseFromScenePosition`, 1, 10_000);
    const referenceFromScenePosition = shot.referenceFromScenePosition === undefined || shot.referenceFromScenePosition === null
      ? undefined
      : boundedInteger(shot.referenceFromScenePosition, `Director shot ${index + 1} referenceFromScenePosition`, 1, 10_000);
    return {
      scenePosition: boundedInteger(shot.scenePosition, `Director shot ${index + 1} scenePosition`, 1, 10_000),
      preferredProviderId,
      providerIds: [
        preferredProviderId,
        ...optionalStringArray(shot.alternativeProviderIds, `Director shot ${index + 1} alternativeProviderIds`),
      ],
      ...(deliveryType ? { deliveryType } : {}),
      ...(reuseFromScenePosition ? { reuseFromScenePosition } : {}),
      ...(referenceFromScenePosition ? { referenceFromScenePosition } : {}),
      query: optionalString(shot.query) ?? "",
      generationPrompt: typeof shot.generationPrompt === "string" && shot.generationPrompt.trim()
        ? shot.generationPrompt.trim()
        : "",
      ...(subject ? { subject } : {}),
      ...(environment ? { environment } : {}),
      ...(visibleAction ? { visibleAction } : {}),
      temporalBeats: temporalBeatStrings(shot.temporalBeats, `Director shot ${index + 1} temporalBeats`),
      sourceInSeconds,
      ...(shotSize ? { shotSize } : {}),
      ...(camera ? { camera } : {}),
      ...(lighting ? { lighting } : {}),
      negativeConstraints: optionalStringArray(shot.negativeConstraints, `Director shot ${index + 1} negativeConstraints`),
      successCriteria: optionalStringArray(shot.successCriteria, `Director shot ${index + 1} successCriteria`),
    };
  });
}

const NO_RENDERED_TEXT_CONSTRAINT = "画面中不得出现任何可读文字、字幕、标题、界面、标牌、徽标、水印、乱码或内部制作术语；所有文字与披露只由后期叠加。";

function compileDirectGenerationPrompt(scene: ScriptScene): string {
  return withNoRenderedTextConstraint(sanitizePrompt(scene.visualPrompt));
}

function withNoRenderedTextConstraint(prompt: string): string {
  return [prompt, NO_RENDERED_TEXT_CONSTRAINT].filter(Boolean).join("\n");
}

function compileGenerationPrompt(providerId: string, route: RoutedShot, scene: ScriptScene): string {
  const hasShotSpec = Boolean(route.subject || route.environment || route.visibleAction || route.temporalBeats.length
    || route.shotSize || route.camera || route.lighting || route.negativeConstraints.length || route.successCriteria.length);
  if (!hasShotSpec) return withNoRenderedTextConstraint(sanitizePrompt(route.generationPrompt || scene.visualPrompt));

  const timeline = route.temporalBeats.map(sanitizePrompt).filter(Boolean);
  const directorExecution = sanitizePrompt(route.generationPrompt);
  const common = [
    promptClause("导演执行描述", directorExecution),
    promptClause("主体", route.subject),
    promptClause("环境", route.environment),
    promptClause("可见动作", route.visibleAction),
    promptClause("景别", route.shotSize),
    promptClause("镜头", route.camera),
    promptClause("光线", route.lighting),
  ].filter(Boolean);
  const negative = route.negativeConstraints.map(sanitizePrompt).filter(Boolean);
  const success = route.successCriteria.map(sanitizePrompt).filter(Boolean);

  if (providerId === "seedance-video-v1") {
    return [
      "竖屏 9:16，动作连续、主体身份与环境连续。",
      ...timeline,
      ...common,
      ...(success.length ? [`必须实现：${success.join("；")}`] : []),
      ...(negative.length ? [`避免：${negative.join("；")}`] : []),
      NO_RENDERED_TEXT_CONSTRAINT,
    ].join("\n");
  }
  if (providerId === "hailuo-video-v1" || providerId === "wan-video-v1") {
    return [
      "竖屏 9:16，电影化写实画面，运动自然，主体连续。",
      ...common,
      ...(timeline.length ? [`动作时间线：${timeline.join("；")}`] : []),
      ...(success.length ? [`画面验收：${success.join("；")}`] : []),
      ...(negative.length ? [`负面约束：${negative.join("；")}`] : []),
      NO_RENDERED_TEXT_CONSTRAINT,
    ].join("\n");
  }
  return [
    "竖屏 9:16，单张关键画面，主体清晰，构图可用于短视频剪辑。",
    ...common,
    ...(success.length ? [`画面验收：${success.join("；")}`] : []),
    ...(negative.length ? [`负面约束：${negative.join("；")}`] : []),
    NO_RENDERED_TEXT_CONSTRAINT,
  ].join("\n");
}

function promptClause(label: string, value: string | undefined): string {
  const safe = sanitizePrompt(value ?? "");
  return safe ? `${label}：${safe}` : "";
}

function sanitizePrompt(value: string): string {
  // AIGC 披露由渲染与发布链路负责，不能反向污染生成模型的画面提示词。
  const forbidden = /审批|预算|版权|工作流|授权|付费|费用|合规|AIGC|(?:AI\s*(?:生成|内容)|人工智能生成|生成式镜头).*(?:标识|声明|披露)|平台(?:声明|披露)|文件(?:标记|标识)|成片.*(?:标识|声明|披露)|(?:Seedream|Seedance|MiniMax|Hailuo|Wanxiang|Provider).*(?:标识|声明|披露)|水印.*(?:保留|清晰|裁切|遮挡|移除)/i;
  return value
    .split(/[。；;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part && !forbidden.test(part))
    .join("；");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function temporalBeatStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry === "string") return requiredString(entry, `${label}[${index}]`);
    const beat = requiredRecord(entry, `${label}[${index}]`);
    const startSeconds = boundedNumber(beat.startSeconds, `${label}[${index}].startSeconds`, 0, 180);
    const endSeconds = boundedNumber(beat.endSeconds, `${label}[${index}].endSeconds`, 0, 180);
    if (endSeconds <= startSeconds) throw new Error(`${label}[${index}] must have a positive duration.`);
    const action = requiredString(beat.action, `${label}[${index}].action`);
    return `[${startSeconds}s-${endSeconds}s] ${action}`;
  });
}

function applyProgress(
  job: GenerationJob,
  progress: VideoGenerationProgress | ImageGenerationProgress,
  configuredCostCny: number,
): void {
  job.taskId = progress.taskId;
  job.status = progress.status;
  if (progress.error) job.error = safeGenerationDiagnostic(progress.error);
  if (progress.taskId.trim()) {
    job.actualCostCny = roundMoney(configuredCostCny);
    job.actualCostSource = "configured_rate";
  }
}

function applySucceeded(job: GenerationJob, taskId: string, url: string): void {
  job.taskId = taskId;
  job.status = "succeeded";
  if (job.mediaType === "video") job.videoUrl = url;
  else job.imageUrl = url;
}

function replaceSceneAsset(
  plan: Record<string, unknown>,
  assets: unknown[],
  scene: ScriptScene,
  taskId: string,
  clipPath: string,
  providerId: string,
  mediaType: "image" | "video",
  mediaMetadata?: GeneratedMediaMetadata,
): void {
  const routingRecords = Array.isArray(plan.director_routing) ? plan.director_routing : [];
  const pending = [scene.position];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const scenePosition = pending.shift()!;
    if (visited.has(scenePosition)) continue;
    visited.add(scenePosition);
    const index = assets.findIndex((asset) => {
      return typeof asset === "object" && asset !== null && !Array.isArray(asset)
        && Number((asset as Record<string, unknown>).scene_position) === scenePosition;
    });
    const existing = index >= 0 && typeof assets[index] === "object" && assets[index] !== null && !Array.isArray(assets[index])
      ? assets[index] as Record<string, unknown>
      : undefined;
    const {
      source_url: _previousSourceUrl,
      width: _previousWidth,
      height: _previousHeight,
      duration: _previousDuration,
      ...existingFields
    } = existing ?? {};
    const next = {
      ...existingFields,
      scene_position: scenePosition,
      provider: providerId,
      asset_id: taskId,
      media_type: mediaType,
      ...(mediaMetadata ? { width: mediaMetadata.width, height: mediaMetadata.height } : {}),
      duration: mediaMetadata?.durationSeconds ?? scene.duration,
      local_path: clipPath,
      creator: providerId,
      license_note: `AI-generated ${mediaType}; provider terms and AIGC disclosure apply.`,
      query: existing?.query ?? scene.visualPrompt,
    };
    if (index >= 0) assets[index] = next;
    else assets.push(next);

    const route = routingRecords.find((entry) => {
      return typeof entry === "object" && entry !== null && !Array.isArray(entry)
        && Number((entry as Record<string, unknown>).scene_position) === scenePosition;
    });
    if (typeof route === "object" && route !== null && !Array.isArray(route)) {
      const routing = route as Record<string, unknown>;
      routing.actual_provider_id = providerId;
      routing.actual_provider = providerId;
      routing.fallback_used = scenePosition === scene.position && routing.preferred_provider_id !== providerId;
      routing.generation_pending = false;
    }
    for (const entry of routingRecords) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const dependent = entry as Record<string, unknown>;
      if (Number(dependent.reuse_from_scene_position) === scenePosition) {
        pending.push(Number(dependent.scene_position));
      }
    }
  }
}

class UnrecoverableGeneratedAssetDownloadError extends Error {}
class GeneratedMediaContractError extends Error {}

async function downloadGeneratedAsset(
  fetcher: FetchLike | undefined,
  url: string,
  destinationStem: string,
  mediaType: "image" | "video",
  maxBytes: number,
  resolveHost: ResolveHost,
  timeoutMs: number,
): Promise<{ path: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentTarget = await validatedMediaTarget(url, resolveHost);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = fetcher
        ? await fetcher(currentTarget.url, { redirect: "manual", signal: controller.signal })
        : await fetchPinnedMedia(currentTarget, controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new UnrecoverableGeneratedAssetDownloadError(
        `Generated ${mediaType} redirect did not include a location.`,
      );
      if (redirects === 5) throw new UnrecoverableGeneratedAssetDownloadError(
        `Generated ${mediaType} download exceeded the redirect limit.`,
      );
      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentTarget.url).toString();
      } catch {
        throw new UnrecoverableGeneratedAssetDownloadError("Generated media URL is invalid.");
      }
      currentTarget = await validatedMediaTarget(redirectUrl, resolveHost);
    }
    if (!response) throw new Error(`Generated ${mediaType} download did not return a response.`);
    if (!response.ok) {
      await response.body?.cancel();
      const message = `Generated ${mediaType} download failed with status ${response.status}.`;
      if (response.status === 403 || response.status === 404) {
        throw new UnrecoverableGeneratedAssetDownloadError(message);
      }
      throw new Error(message);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new UnrecoverableGeneratedAssetDownloadError(
        `Generated ${mediaType} exceeds the ${maxBytes}-byte download limit.`,
      );
    }
    const rawContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    let contentType: string;
    try {
      contentType = validatedMediaContentType(mediaType, rawContentType);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const bytes = await readLimitedBody(response, mediaType, maxBytes);
    const extension = mediaType === "video" ? "mp4" : imageExtension(contentType);
    const destination = `${destinationStem}.${extension}`;
    const temporary = `${destination}.partial`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
    return { path: destination, contentType };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Generated ${mediaType} download timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function validatedMediaTarget(value: string, resolveHost: ResolveHost): Promise<ValidatedMediaTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnrecoverableGeneratedAssetDownloadError("Generated media URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnrecoverableGeneratedAssetDownloadError("Generated media URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || isBlockedMediaHost(url.hostname)) {
    throw new UnrecoverableGeneratedAssetDownloadError(
      "Generated media URL points to a private or unsafe network destination.",
    );
  }
  const hostname = normalizedHost(url.hostname);
  let addresses: readonly string[] = [hostname];
  if (isIP(hostname) === 0) {
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new Error("Generated media URL hostname could not be resolved.");
    }
  }
  addresses = [...new Set(addresses.map(normalizedHost))];
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0 || isBlockedMediaHost(address))) {
    throw new UnrecoverableGeneratedAssetDownloadError(
      "Generated media URL points to a private or unsafe network destination.",
    );
  }
  return { url: url.toString(), hostname, addresses };
}

async function fetchPinnedMedia(target: ValidatedMediaTarget, signal: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (const address of target.addresses) {
    try {
      return await fetchPinnedAddress(target, address, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Generated media host '${target.hostname}' could not be reached.`);
}

function fetchPinnedAddress(target: ValidatedMediaTarget, address: string, signal: AbortSignal): Promise<Response> {
  const url = new URL(target.url);
  const secure = url.protocol === "https:";
  const request = secure ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (secure ? 443 : 80),
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, Accept: "*/*" },
      ...(secure ? { servername: target.hostname } : {}),
      signal,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const body = [204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function isBlockedMediaHost(hostname: string): boolean {
  const host = normalizedHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 4) {
    return isBlockedIpv4(host);
  }
  if (isIP(host) === 6) {
    const mapped = mappedIpv4Address(host);
    if (mapped) return isBlockedIpv4(mapped);
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
      || /^fe[89ab]/.test(host) || /^fe[c-f]/.test(host) || host.startsWith("ff") || host.startsWith("2001:db8:")
      || host === "100::" || host.startsWith("100::") || host.startsWith("64:ff9b:");
  }
  return false;
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isBlockedIpv4(host: string): boolean {
  const [first, second, third] = host.split(".").map(Number);
  return first === 0
    || first === 10
    || first === 127
    || first! >= 224
    || first === 169 && second === 254
    || first === 172 && second! >= 16 && second! <= 31
    || first === 192 && (second === 0 || second === 168 || second === 88 && third === 99)
    || first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)
    || first === 203 && second === 0 && third === 113
    || first === 100 && second! >= 64 && second! <= 127;
}

function mappedIpv4Address(host: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

async function resolveMediaHostname(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function readLimitedBody(response: Response, mediaType: "image" | "video", maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new UnrecoverableGeneratedAssetDownloadError(
    `Generated ${mediaType} download returned an empty body.`,
  );
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new UnrecoverableGeneratedAssetDownloadError(
        `Generated ${mediaType} exceeds the ${maxBytes}-byte download limit.`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  if (received === 0) throw new UnrecoverableGeneratedAssetDownloadError(
    `Generated ${mediaType} download returned an empty body.`,
  );
  return Buffer.concat(chunks);
}

function validatedMediaContentType(mediaType: "image" | "video", value: string | undefined): string {
  if (mediaType === "video") {
    if (value && !["video/mp4", "application/mp4", "audio/mp4", "application/octet-stream"].includes(value)) {
      throw new UnrecoverableGeneratedAssetDownloadError(
        `Generated video returned unsupported content type '${value}'.`,
      );
    }
    return "video/mp4";
  }
  if (value && value !== "application/octet-stream" && !["image/jpeg", "image/webp", "image/png"].includes(value)) {
    throw new UnrecoverableGeneratedAssetDownloadError(
      `Generated image returned unsupported content type '${value}'.`,
    );
  }
  return supportedImageContentType(value);
}

function supportedImageContentType(value: string | undefined): string {
  return value === "image/jpeg" || value === "image/webp" || value === "image/png" ? value : "image/png";
}

function imageExtension(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

async function writeJobs(
  pathname: string,
  jobs: GenerationJob[],
): Promise<void> {
  await writeJsonAtomically(pathname, { version: "video-factory/generation-jobs-v1", jobs });
}

function createPaidAssetOperationItem(
  operationId: string,
  scene: ScriptScene,
  executorProviderId: string,
  request: ResolvedAssetExecutionRequest,
  binding: ResolvedAssetBinding,
  sourceFingerprint: string,
): PaidAssetOperationItem {
  const parameters = {
    mediaType: request.mediaType,
    durationSeconds: request.durationSeconds,
    ratio: request.ratio,
    ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}),
    ...(request.referenceFromScenePosition !== undefined
      ? { referenceFromScenePosition: request.referenceFromScenePosition }
      : {}),
    ...(request.referenceImageSha256 ? { referenceImageSha256: request.referenceImageSha256 } : {}),
    compiledPromptSha256: createHash("sha256").update(request.compiledPrompt).digest("hex"),
    executionDigest: request.executionDigest,
  };
  const inputFingerprint = createHash("sha256").update(JSON.stringify({
    scenePosition: scene.position,
    request,
  })).digest("hex");
  const itemRequestId = `paid-item-${createHash("sha256")
    .update(`${operationId}\0${inputFingerprint}`)
    .digest("hex")
    .slice(0, 24)}`;
  return {
    itemRequestId,
    quoteItemId: `scene-${scene.position}`,
    inputFingerprint,
    scenePosition: scene.position,
    executorProviderId,
    providerId: request.providerId,
    modelId: request.modelId,
    sourceFingerprint,
    parameters,
    state: "prepared",
    estimatedCostCny: binding.estimateCny(request),
  };
}

async function preparePaidAssetOperation(
  nodeDirectory: string,
  operationId: string,
  items: PaidAssetOperationItem[],
  reworkCarryForwardItems: PaidAssetOperationItem[] = [],
): Promise<{
  ledgerPath: string;
  items: PaidAssetOperationItem[];
  existing: boolean;
  createCostCny: number;
  /** 历史 create 计数（按素材键）：跨操作叶子条目中真实发生 create 的次数（携带不计数）。 */
  priorCreateAttemptsByQuoteItem: Record<string, number>;
}> {
  const ledgerPath = generationLedgerPathIn(nodeDirectory, operationId);
  // 历次操作的台账都在同一个 .generation-operations 目录里：携带复用正是靠与它们比对。
  const operationsDirectory = path.dirname(ledgerPath);
  try {
    const persisted = parsePaidAssetOperationLedger(JSON.parse(await readFile(ledgerPath, "utf8")), operationId);
    if (!paidOperationInputsMatch(persisted.items, items)) {
      throw new Error("This paid generation operation no longer matches its persisted item inputs.");
    }
    return {
      ledgerPath,
      items: persisted.items,
      existing: true,
      createCostCny: 0,
      priorCreateAttemptsByQuoteItem: await countPriorCreateAttempts(operationsDirectory, operationId),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const previousItems = paidAssetLedgerLeaves(await previousPaidAssetItems(operationsDirectory, operationId));
  const priorCreateAttemptsByQuoteItem = countLocalCreateAttempts(previousItems);
  const carriedItems = await carryForwardPaidAssetItems(operationId, items, previousItems, reworkCarryForwardItems);
  return {
    ledgerPath,
    items: carriedItems,
    existing: false,
    createCostCny: roundMoney(carriedItems.reduce(
      (sum, item) => sum + (item.carriedForwardFromItemRequestId ? 0 : item.estimatedCostCny),
      0,
    )),
    priorCreateAttemptsByQuoteItem,
  };
}

/**
 * 携带复用的唯一判据：执行期落账与花费报价预测共用这一份实现。
 * 判据只认素材请求身份（inputFingerprint）或可证明的引用链身份，不认"脚本文件没变过"——
 * 单镜改素材会让脚本字节变化，但其余镜头的请求身份逐字未变，那些镜头本来就不该再买一次。
 */
async function carryForwardPaidAssetItems(
  operationId: string,
  items: readonly PaidAssetOperationItem[],
  previousItems: readonly PaidAssetOperationItem[],
  reworkCarryForwardItems: readonly PaidAssetOperationItem[] = [],
): Promise<PaidAssetOperationItem[]> {
  const carriedItems: PaidAssetOperationItem[] = [];
  for (const item of items) {
    const previousCandidates = previousItems.filter((candidate) => (
      candidate.inputFingerprint === item.inputFingerprint
      || isMatchingReferencedPaidItem(candidate, item, carriedItems)
    ));
    const reworkCandidates = reworkCarryForwardItems.filter((candidate) => (
      isMatchingReworkCarryForwardItem(candidate, item, carriedItems)
    ));
    const candidates = [...previousCandidates, ...reworkCandidates];
    const reusable = await firstVerifiedMaterializedItem(candidates)
      ?? candidates.find((candidate) => (
        candidate.state === "provider_succeeded"
        && Boolean(candidate.taskId)
        && Boolean(candidate.resultUrl)
      ));
    if (reusable) {
      // N1：跨 run 携带必须保留已核验的实际输入身份（reference SHA、resolved digest、
      // input fingerprint），当前 run 的操作 id 可以变，但内容身份不得退回未解析状态。
      const carriedBase = reworkCandidates.includes(reusable)
        ? paidItemWithReferenceIdentity(operationId, item, reusable)
        : reusable.inputFingerprint === item.inputFingerprint
          ? item
          : paidItemWithReferenceIdentity(operationId, item, reusable);
      carriedItems.push({
        ...carriedBase,
        state: reusable.state,
        ...(reusable.taskId ? { taskId: reusable.taskId } : {}),
        ...(reusable.resultUrl ? { resultUrl: reusable.resultUrl } : {}),
        ...(reusable.localPath ? { localPath: reusable.localPath } : {}),
        ...(reusable.sha256 ? { sha256: reusable.sha256 } : {}),
        ...(reusable.sizeBytes !== undefined ? { sizeBytes: reusable.sizeBytes } : {}),
        ...(reusable.actualCostCny !== undefined ? { actualCostCny: reusable.actualCostCny } : {}),
        ...(reusable.actualCostSource ? { actualCostSource: reusable.actualCostSource } : {}),
        carriedForwardFromItemRequestId: reusable.itemRequestId,
      });
      continue;
    }
    const unresolved = previousCandidates.find((candidate) => (
      candidate.state === "submitted"
      || candidate.state === "provider_succeeded"
      || candidate.state === "unknown"
    ));
    if (unresolved) {
      throw new Error(
        `Paid item '${unresolved.itemRequestId}' still has an unresolved provider outcome and must be reconciled before a new create.`,
      );
    }
    carriedItems.push(item);
  }
  return carriedItems;
}

/** 叶子条目内的 create 事实计数：携带条目是复用不计数，未携带且已发生 create 的计一次。 */
function countLocalCreateAttempts(leafItems: readonly PaidAssetOperationItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of leafItems) {
    if (item.carriedForwardFromItemRequestId) continue;
    const created = item.state === "submitted"
      || item.state === "provider_succeeded"
      || item.state === "materialized"
      || item.state === "unknown"
      || (item.state === "terminal_failed" && (Boolean(item.taskId) || item.actualCostCny !== undefined));
    if (!created) continue;
    counts[item.quoteItemId] = (counts[item.quoteItemId] ?? 0) + 1;
  }
  return counts;
}

async function countPriorCreateAttempts(nodeDirectory: string, operationId: string): Promise<Record<string, number>> {
  try {
    const previousItems = paidAssetLedgerLeaves(await previousPaidAssetItems(nodeDirectory, operationId));
    return countLocalCreateAttempts(previousItems);
  } catch {
    return {};
  }
}

async function firstVerifiedMaterializedItem(
  candidates: readonly PaidAssetOperationItem[],
): Promise<PaidAssetOperationItem | undefined> {
  for (const candidate of candidates) {
    if (candidate.state !== "materialized") continue;
    try {
      await verifyMaterializedItem(candidate);
      return candidate;
    } catch {
      // 文件丢失或身份变化的旧母片不能继续抵扣新一轮报价。
    }
  }
  return undefined;
}

function isMatchingReworkCarryForwardItem(
  candidate: PaidAssetOperationItem,
  prepared: PaidAssetOperationItem,
  carriedItems: PaidAssetOperationItem[],
): boolean {
  const identityMatches = candidate.scenePosition === prepared.scenePosition
    && candidate.executorProviderId === prepared.executorProviderId
    && candidate.providerId === prepared.providerId
    && candidate.modelId === prepared.modelId
    && paidExecutionParametersMatch(candidate.parameters, prepared.parameters);
  if (!identityMatches) return false;
  const preparedReference = prepared.parameters.referenceFromScenePosition;
  const candidateReference = candidate.parameters.referenceFromScenePosition;
  if (preparedReference === undefined) return candidateReference === undefined;
  if (candidateReference !== preparedReference) return false;
  const referenceSha256 = candidate.parameters.referenceImageSha256;
  if (typeof referenceSha256 !== "string") return false;
  // 引用源可以自身是 reference-derived（多级链）；只需它已在 carriedItems 中物化为 image 且 SHA-256 精确匹配。
  return carriedItems.some((item) => (
    item.scenePosition === candidateReference
    && item.state === "materialized"
    && item.parameters.mediaType === "image"
    && item.sha256 === referenceSha256
  ));
}

function paidItemWithReferenceIdentity(
  operationId: string,
  prepared: PaidAssetOperationItem,
  reusable: PaidAssetOperationItem,
): PaidAssetOperationItem {
  const referenceImageSha256 = reusable.parameters.referenceImageSha256;
  if (typeof referenceImageSha256 !== "string") return prepared;
  const inputFingerprint = reusable.inputFingerprint;
  return {
    ...prepared,
    inputFingerprint,
    itemRequestId: `paid-item-${createHash("sha256")
      .update(`${operationId}\0${inputFingerprint}`)
      .digest("hex")
      .slice(0, 24)}`,
    parameters: {
      ...prepared.parameters,
      referenceImageSha256,
      ...(typeof reusable.parameters.executionDigest === "string"
        ? { executionDigest: reusable.parameters.executionDigest }
        : {}),
    },
  };
}

function isMatchingReferencedPaidItem(
  candidate: PaidAssetOperationItem,
  prepared: PaidAssetOperationItem,
  carriedItems: PaidAssetOperationItem[],
): boolean {
  const referenceFromScenePosition = prepared.parameters.referenceFromScenePosition;
  const referenceImageSha256 = candidate.parameters.referenceImageSha256;
  if (typeof referenceFromScenePosition !== "number"
    || typeof referenceImageSha256 !== "string"
    || candidate.parameters.referenceFromScenePosition !== referenceFromScenePosition
    || candidate.scenePosition !== prepared.scenePosition
    || candidate.executorProviderId !== prepared.executorProviderId
    || candidate.providerId !== prepared.providerId
    || candidate.modelId !== prepared.modelId
    || candidate.sourceFingerprint !== prepared.sourceFingerprint
    || !paidExecutionParametersMatch(candidate.parameters, prepared.parameters)) {
    return false;
  }
  return carriedItems.some((source) => (
    source.scenePosition === referenceFromScenePosition
    && source.sourceFingerprint === prepared.sourceFingerprint
    && source.state === "materialized"
    && source.parameters.mediaType === "image"
    && source.sha256 === referenceImageSha256
  ));
}

async function previousPaidAssetItems(directory: string, operationId?: string): Promise<PaidAssetOperationItem[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const currentName = operationId
    ? `${createHash("sha256").update(operationId).digest("hex")}.json`
    : undefined;
  const items: PaidAssetOperationItem[] = [];
  for (const name of names) {
    if (name === currentName) continue;
    const value = requiredRecord(JSON.parse(await readFile(path.join(directory, name), "utf8")), "Paid operation ledger");
    if (typeof value.operationId !== "string") {
      throw new Error(`Paid operation ledger '${name}' is incompatible or corrupted.`);
    }
    items.push(...parsePaidAssetOperationLedger(value, value.operationId).items);
  }
  return items;
}

export async function paidAssetSourceFingerprint(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const pathname of paths) {
    const bytes = await readFile(pathname);
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface PaidAssetLedgerItemSummary {
  operationId: string;
  itemRequestId: string;
  quoteItemId: string;
  inputFingerprint: string;
  sourceFingerprint: string;
  scenePosition: number;
  executorProviderId: string;
  providerId: string;
  modelId: string;
  state: PaidAssetItemState;
  estimatedCostCny: number;
  taskId?: string;
  resultUrl?: string;
  localPath?: string;
  sha256?: string;
  sizeBytes?: number;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  carriedForwardFromItemRequestId?: string;
  error?: string;
  manualReconciliationRequired?: boolean;
}

export async function inspectPaidAssetLedger(
  nodeDirectory: string,
  sourceFingerprint?: string,
): Promise<PaidAssetLedgerItemSummary[]> {
  const directory = path.join(nodeDirectory, ".generation-operations");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const summaries: PaidAssetLedgerItemSummary[] = [];
  for (const name of names) {
    const record = requiredRecord(JSON.parse(await readFile(path.join(directory, name), "utf8")), "Paid operation ledger");
    if (record.version !== "video-factory/paid-operation-v2" || typeof record.operationId !== "string" || !Array.isArray(record.items)) {
      throw new Error(`Paid operation ledger '${name}' is incompatible or corrupted.`);
    }
    const ledger = parsePaidAssetOperationLedger(record, record.operationId);
    for (const item of ledger.items) {
      if (sourceFingerprint && item.sourceFingerprint !== sourceFingerprint) continue;
      summaries.push({
      operationId: record.operationId,
      itemRequestId: item.itemRequestId,
      quoteItemId: item.quoteItemId,
      inputFingerprint: item.inputFingerprint,
      sourceFingerprint: item.sourceFingerprint,
      scenePosition: item.scenePosition,
      executorProviderId: item.executorProviderId,
      providerId: item.providerId,
      modelId: item.modelId,
      state: item.state,
      estimatedCostCny: item.estimatedCostCny,
      ...(item.taskId ? { taskId: item.taskId } : {}),
      ...(item.resultUrl ? { resultUrl: item.resultUrl } : {}),
      ...(item.localPath ? { localPath: item.localPath } : {}),
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.actualCostCny !== undefined ? { actualCostCny: item.actualCostCny } : {}),
      ...(item.actualCostSource ? { actualCostSource: item.actualCostSource } : {}),
      ...(item.carriedForwardFromItemRequestId
        ? { carriedForwardFromItemRequestId: item.carriedForwardFromItemRequestId }
        : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.manualReconciliationRequired ? { manualReconciliationRequired: true } : {}),
      });
    }
  }
  return summaries;
}

async function openGenerationOperation(
  ledgerPath: string,
  operationId: string,
  preparedItems: PaidAssetOperationItem[],
): Promise<{ ledger: PaidAssetOperationLedger; created: boolean }> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const ledger: PaidAssetOperationLedger = {
    version: "video-factory/paid-operation-v2",
    operationId,
    completed: false,
    items: preparedItems,
  };
  try {
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { ledger, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const persisted = parsePaidAssetOperationLedger(JSON.parse(await readFile(ledgerPath, "utf8")), operationId);
  if (!paidOperationInputsMatch(persisted.items, preparedItems)) {
    throw new Error("This paid generation operation no longer matches its persisted item inputs.");
  }
  return { ledger: persisted, created: false };
}

function parsePaidAssetOperationLedger(value: unknown, operationId: string): PaidAssetOperationLedger {
  const record = requiredRecord(value, "Paid operation ledger");
  if (record.version !== "video-factory/paid-operation-v2" || record.operationId !== operationId || !Array.isArray(record.items)) {
    throw new Error("Paid operation ledger is incompatible or corrupted.");
  }
  return record as unknown as PaidAssetOperationLedger;
}

function paidOperationInputsMatch(
  persisted: PaidAssetOperationItem[],
  prepared: PaidAssetOperationItem[],
): boolean {
  return persisted.length === prepared.length && prepared.every((item, index) => {
    const candidate = persisted[index];
    const exact = candidate?.itemRequestId === item.itemRequestId
      && candidate.inputFingerprint === item.inputFingerprint
      && candidate.scenePosition === item.scenePosition
      && candidate.executorProviderId === item.executorProviderId
      && candidate.providerId === item.providerId
      && candidate.modelId === item.modelId
      && candidate.sourceFingerprint === item.sourceFingerprint;
    if (exact) return true;
    if (!candidate || item.parameters.referenceImageSha256 !== undefined) return false;
    return item.parameters.referenceFromScenePosition !== undefined
      && candidate.parameters.referenceFromScenePosition === item.parameters.referenceFromScenePosition
      && paidExecutionParametersMatch(candidate.parameters, item.parameters)
      && candidate.scenePosition === item.scenePosition
      && candidate.executorProviderId === item.executorProviderId
      && candidate.providerId === item.providerId
      && candidate.modelId === item.modelId
      && candidate.sourceFingerprint === item.sourceFingerprint;
  });
}

function paidExecutionParametersMatch(
  left: PaidAssetOperationItem["parameters"],
  right: PaidAssetOperationItem["parameters"],
): boolean {
  const referenceIdentityIsDeferred = left.referenceFromScenePosition !== undefined
    && right.referenceFromScenePosition !== undefined
    && (left.referenceImageSha256 === undefined || right.referenceImageSha256 === undefined);
  if (!referenceIdentityIsDeferred
    && typeof left.executionDigest === "string"
    && typeof right.executionDigest === "string") {
    return left.executionDigest === right.executionDigest;
  }
  const fields = [
    "mediaType",
    "durationSeconds",
    "ratio",
    "resolution",
    "generateAudio",
    "referenceFromScenePosition",
  ] as const;
  if (fields.some((field) => left[field] !== right[field])) return false;
  if (left.referenceImageSha256 !== undefined
    && right.referenceImageSha256 !== undefined
    && left.referenceImageSha256 !== right.referenceImageSha256) return false;
  const leftPrompt = left.compiledPromptSha256;
  const rightPrompt = right.compiledPromptSha256;
  // 旧账本没有保存 Prompt 摘要；其复用仍受脚本、导演执行语义与 source fingerprint 门禁约束。
  return typeof leftPrompt !== "string" || typeof rightPrompt !== "string" || leftPrompt === rightPrompt;
}

async function materializedReferenceImage(
  ledger: PaidAssetOperationLedger,
  scenePosition: number,
): Promise<{ dataUrl: string; sha256: string }> {
  const source = ledger.items.find((item) => item.scenePosition === scenePosition);
  if (!source || source.state !== "materialized" || source.parameters.mediaType !== "image") {
    throw new Error(`Reference scene ${scenePosition} does not have a materialized generated image.`);
  }
  const materialized = await verifyMaterializedItem(source);
  const bytes = await readFile(materialized.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== source.sha256) {
    throw new Error(`Reference scene ${scenePosition} no longer matches its recorded image identity.`);
  }
  return {
    dataUrl: `data:${materialized.contentType};base64,${bytes.toString("base64")}`,
    sha256,
  };
}

async function bindReferenceImageToLedger(
  ledgerPath: string,
  ledger: PaidAssetOperationLedger,
  current: PaidAssetOperationItem,
  referenced: PaidAssetOperationItem,
): Promise<PaidAssetOperationItem> {
  if (current.inputFingerprint === referenced.inputFingerprint) return current;
  if (current.state !== "prepared" || current.taskId || current.resultUrl) {
    throw new Error(
      `Paid item '${current.itemRequestId}' reference image no longer matches its persisted provider request.`,
    );
  }
  const index = ledger.items.indexOf(current);
  if (index < 0) throw new Error(`Paid item '${current.itemRequestId}' is missing from its operation ledger.`);
  ledger.items[index] = referenced;
  await writeGenerationLedger(ledgerPath, ledger);
  return referenced;
}

async function generatePaidAssetItem(options: {
  binding: ResolvedAssetBinding;
  request: ResolvedAssetExecutionRequest;
  job: GenerationJob;
  jobs: GenerationJob[];
  jobsPath: string;
  sceneCost: number;
  ledgerPath: string | undefined;
  ledger: PaidAssetOperationLedger | undefined;
  ledgerItem: PaidAssetOperationItem | undefined;
  allowCreate: boolean;
  referenceImages?: [string, ...string[]];
  /** C1：scope 派生的逐素材 create 预算（assetKey → 允许的总 create 次数）。 */
  itemCreateBudgets?: Record<string, number>;
  /** 本素材在历史操作中已发生的 create 次数（携带不计数）。 */
  priorCreateAttempts?: number;
}): Promise<{ taskId: string; url: string }> {
  const { ledgerItem } = options;
  const recordProgress = async (progress: VideoGenerationProgress | ImageGenerationProgress): Promise<void> => {
    applyProgress(options.job, progress, options.sceneCost);
    await writeJobs(options.jobsPath, options.jobs);
    if (!ledgerItem || !options.ledgerPath || !options.ledger) return;
    delete ledgerItem.manualReconciliationRequired;
    ledgerItem.taskId = progress.taskId;
    ledgerItem.actualCostCny = roundMoney(options.sceneCost);
    ledgerItem.actualCostSource = "configured_rate";
    if (progress.status === "succeeded") {
      const resultUrl = (progress as VideoGenerationProgress).videoUrl
        ?? (progress as ImageGenerationProgress).imageUrl;
      if (resultUrl) ledgerItem.resultUrl = resultUrl;
      ledgerItem.state = "provider_succeeded";
    } else if (progress.status === "failed") {
      ledgerItem.state = "terminal_failed";
      if (progress.error) ledgerItem.error = safeGenerationDiagnostic(progress.error);
    } else {
      ledgerItem.state = "submitted";
    }
    await writeGenerationLedger(options.ledgerPath, options.ledger);
  };
  if (
    ledgerItem
    && (ledgerItem.state === "submitted" || ledgerItem.state === "unknown" || ledgerItem.state === "provider_succeeded")
    && ledgerItem.taskId
    && options.binding.reconcile
  ) {
    let reconciled: { taskId: string; url: string };
    try {
      reconciled = await options.binding.reconcile(
        ledgerItem.taskId,
        options.request,
        recordProgress,
      );
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError) {
        ledgerItem.manualReconciliationRequired = true;
        ledgerItem.error = safeGenerationDiagnostic(error);
        if (options.ledgerPath && options.ledger) await writeGenerationLedger(options.ledgerPath, options.ledger);
      }
      throw error;
    }
    ledgerItem.taskId = reconciled.taskId;
    ledgerItem.resultUrl = reconciled.url;
    ledgerItem.state = "provider_succeeded";
    delete ledgerItem.manualReconciliationRequired;
    delete ledgerItem.error;
    if (options.ledgerPath && options.ledger) await writeGenerationLedger(options.ledgerPath, options.ledger);
    return reconciled;
  }
  if (
    ledgerItem?.state === "provider_succeeded"
    && ledgerItem.taskId
    && ledgerItem.resultUrl
  ) {
    return acceptedResultFromLedger(ledgerItem);
  }
  if (ledgerItem && ledgerItem.state !== "prepared") {
    if (ledgerItem.state === "submitted" || ledgerItem.state === "unknown" || ledgerItem.state === "provider_succeeded") {
      throw new Error(
        `Paid item '${ledgerItem.itemRequestId}' has an unresolved provider outcome and cannot be created again.`,
      );
    }
    if (ledgerItem.state === "terminal_failed") {
      throw new Error(`Paid item '${ledgerItem.itemRequestId}' requires a new spend authorization before another create.`);
    }
  }
  if (ledgerItem && !options.allowCreate) {
    throw new Error(`Paid item '${ledgerItem.itemRequestId}' was prepared but not submitted; a new spend authorization is required.`);
  }
  // C1：逐素材 create 预算（scope 用户批准的每素材次数上限）在越过付费边界前强制执行。
  // 预算耗尽的 create 停在可操作状态，绝不静默超授权重试。
  if (ledgerItem && options.itemCreateBudgets) {
    const budget = options.itemCreateBudgets[ledgerItem.quoteItemId];
    if (budget !== undefined) {
      if (!Number.isSafeInteger(budget) || budget < 0) {
        throw new Error(`Paid item '${ledgerItem.itemRequestId}' carries an invalid create budget.`);
      }
      const priorCreates = options.priorCreateAttempts ?? 0;
      if (priorCreates + 1 > budget) {
        throw new Error(
          `Asset '${ledgerItem.quoteItemId}' has reached its authorized create budget (${priorCreates}/${budget}); a new spend authorization is required before another create.`,
        );
      }
    }
  }
  if (ledgerItem && options.ledgerPath && options.ledger) {
    ledgerItem.state = "unknown";
    delete ledgerItem.manualReconciliationRequired;
    delete ledgerItem.error;
    await writeGenerationLedger(options.ledgerPath, options.ledger);
  }
  // 这是本次 worker 真正越过 create 边界的证据；恢复/查询旧 taskId 不计作新付费尝试。
  options.job[METERED_CREATE_ATTEMPTED] = true;
  try {
    const generated = await options.binding.generate(
      options.request,
      recordProgress,
      options.referenceImages,
    );
    if (ledgerItem && options.ledgerPath && options.ledger) {
      ledgerItem.taskId = generated.taskId;
      ledgerItem.resultUrl = generated.url;
      ledgerItem.state = "provider_succeeded";
      ledgerItem.actualCostCny = roundMoney(options.sceneCost);
      ledgerItem.actualCostSource = "configured_rate";
      delete ledgerItem.error;
      await writeGenerationLedger(options.ledgerPath, options.ledger);
    }
    return generated;
  } catch (error) {
    if (error instanceof ProviderRequestRejectedError && !ledgerItem?.taskId) {
      delete options.job[METERED_CREATE_ATTEMPTED];
    }
    if (ledgerItem && options.ledgerPath && options.ledger) {
      if (error instanceof ProviderRequestRejectedError && !ledgerItem.taskId) {
        ledgerItem.state = "terminal_failed";
        delete ledgerItem.actualCostCny;
        delete ledgerItem.actualCostSource;
      } else if (ledgerItem.state !== "terminal_failed" && ledgerItem.state !== "submitted") {
        ledgerItem.state = "unknown";
      }
      ledgerItem.error = safeGenerationDiagnostic(error);
      await writeGenerationLedger(options.ledgerPath, options.ledger);
    }
    throw error;
  }
}

function isExistingPaidTask(item: PaidAssetOperationItem | undefined): boolean {
  return Boolean(item?.taskId) && (
    item?.state === "submitted"
    || item?.state === "unknown"
    || item?.state === "provider_succeeded"
    || item?.state === "materialized"
  );
}

function closeUnsubmittedItemsAfterTerminalOperation(
  ledger: PaidAssetOperationLedger,
  failure: string | undefined,
): void {
  for (const item of ledger.items) {
    if (item.state !== "prepared") continue;
    item.state = "terminal_failed";
    item.error = `Operation ended before provider submission${failure ? `: ${failure}` : "."}`;
    delete item.actualCostCny;
    delete item.actualCostSource;
  }
}

function acceptedResultFromLedger(item: PaidAssetOperationItem): { taskId: string; url: string } {
  if (!item.taskId || !item.resultUrl) {
    throw new Error(`Paid item '${item.itemRequestId}' is missing its accepted task result.`);
  }
  return { taskId: item.taskId, url: item.resultUrl };
}

async function verifyMaterializedItem(
  item: PaidAssetOperationItem,
): Promise<{ path: string; contentType: string }> {
  if (!item.localPath || !item.sha256 || item.sizeBytes === undefined || item.sizeBytes <= 0) {
    throw new Error(`Paid item '${item.itemRequestId}' is missing its materialized file identity.`);
  }
  const identity = await fileIdentity(item.localPath);
  if (identity.sha256 !== item.sha256 || identity.sizeBytes !== item.sizeBytes) {
    throw new Error(`Paid item '${item.itemRequestId}' materialized file no longer matches its ledger identity.`);
  }
  const mediaType = item.parameters.mediaType;
  return {
    path: item.localPath,
    contentType: mediaType === "video" ? "video/mp4" : mediaContentTypeFromPath(item.localPath),
  };
}

async function materializeCarriedAsset(
  item: PaidAssetOperationItem,
  outputDir: string,
  scenePosition: number,
  providerId: string,
  mediaType: "image" | "video",
): Promise<{ path: string; contentType: string }> {
  const source = await verifyMaterializedItem(item);
  const extension = mediaType === "video" ? "mp4" : imageExtension(source.contentType);
  const target = path.join(outputDir, `scene_${String(scenePosition).padStart(2, "0")}_${providerId}.${extension}`);
  if (path.resolve(source.path) !== path.resolve(target)) {
    await copyFile(source.path, target);
  }
  const identity = await fileIdentity(target);
  if (identity.sha256 !== item.sha256 || identity.sizeBytes !== item.sizeBytes) {
    throw new Error(`Paid item '${item.itemRequestId}' changed while it was carried into this rework.`);
  }
  item.localPath = target;
  return { path: target, contentType: source.contentType };
}

function mediaContentTypeFromPath(value: string): string {
  if (value.endsWith(".jpg") || value.endsWith(".jpeg")) return "image/jpeg";
  if (value.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function fileIdentity(value: string): Promise<{ sha256: string; sizeBytes: number }> {
  const bytes = await readFile(value);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

async function writeGenerationLedger(pathname: string, ledger: PaidAssetOperationLedger): Promise<void> {
  await writeJsonAtomically(pathname, ledger);
}

/** 台账按节点（而非按 attempt）存放：跨 attempt 的携带复用正是靠同一目录的历史叶子比对。 */
function generationLedgerPathIn(nodeDirectory: string, operationId: string): string {
  return path.join(nodeDirectory, ".generation-operations", `${createHash("sha256").update(operationId).digest("hex")}.json`);
}

async function writeJsonAtomically(pathname: string, value: unknown): Promise<void> {
  const temporary = `${pathname}.partial`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, pathname);
}

async function describeFile(
  uri: string,
  kind: string,
  contentType: string,
  providerId: string,
  request: Record<string, unknown>,
  licenseNote: string,
  scenePosition?: number,
  notes?: string,
): Promise<WorkerArtifactDescriptor> {
  const bytes = await readFile(uri);
  return {
    kind,
    uri,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    contentType,
    provenance: {
      providerId,
      producerNodeId: requiredString(request.nodeRunId, "nodeRunId"),
      attempt: boundedInteger(request.attempt, "attempt", 1, 10_000),
      licenseNote,
      ...(scenePosition ? { scenePosition } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

function positionedRecords(value: unknown, positionField: string): Map<number, Record<string, unknown>> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((entry): Array<[number, Record<string, unknown>]> => {
    if (!isRecord(entry) || !Number.isInteger(entry[positionField])) return [];
    return [[Number(entry[positionField]), entry]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = boundedNumber(value, label, minimum, maximum);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeGenerationDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[redacted image data]")
    .trim()
    .slice(0, 2_000);
}
