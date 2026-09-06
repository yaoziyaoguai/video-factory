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
  VideoGenerationAdapter,
  VideoGenerationProgress,
  VideoGenerationRequest,
} from "./video-generation.js";
import type {
  ImageGenerationAdapter,
  ImageGenerationProgress,
} from "./image-generation.js";
import { ProviderRequestRejectedError } from "./provider-request-error.js";

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
  minDurationSeconds: number;
  maxDurationSeconds: number;
  supportsAudio: boolean;
  estimatedCnyPerSecond?: number;
  estimatedCnyPerSecondByResolution?: Record<string, number>;
}

export type VideoGenerationDurationBounds = Pick<
  VideoGenerationRuntimeProfile,
  "minDurationSeconds" | "maxDurationSeconds"
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
}

interface ScriptScene {
  position: number;
  duration: number;
  visualStrategy: string;
  visualPrompt: string;
}

const METERED_CREATE_ATTEMPTED = Symbol("meteredCreateAttempted");

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
}

export type PaidAssetItemState =
  | "prepared"
  | "submitted"
  | "provider_succeeded"
  | "materialized"
  | "terminal_failed"
  | "unknown";

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
  actualCostSource?: "configured_rate";
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
  estimateCny(scene: ScriptScene): number;
  modelId?: string;
  generate(
    scene: ScriptScene,
    prompt: string,
    onProgress: (progress: VideoGenerationProgress | ImageGenerationProgress) => Promise<void>,
    referenceImages?: [string, ...string[]],
  ): Promise<{ taskId: string; url: string }>;
  reconcile?(
    taskId: string,
    scene: ScriptScene,
    prompt: string,
    onProgress: (progress: VideoGenerationProgress | ImageGenerationProgress) => Promise<void>,
  ): Promise<{ taskId: string; url: string }>;
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
    const baseItems = scenes.map((scene) => createPaidAssetOperationItem(
      operationId,
      scene,
      providerId,
      providerId,
      binding,
      scene.visualPrompt,
      sourceFingerprint,
    ));
    const preparedOperation = scenes.length
      ? await preparePaidAssetOperation(outputDir, operationId, baseItems)
      : undefined;
    const estimatedCost = preparedOperation?.createCostCny ?? 0;
    if (estimatedCost > 0 && maxCostCny <= 0) {
      throw new Error("Paid asset execution requires a positive spend authorization.");
    }
    if (estimatedCost > maxCostCny) {
      throw new Error(`Estimated cost ¥${estimatedCost} exceeds the authorized maximum ¥${maxCostCny}.`);
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

    const preparedItems = preparedOperation?.items ?? [];
    const openedLedger = ledgerPath
      ? await openGenerationOperation(ledgerPath, operationId, preparedItems)
      : undefined;

    for (const scene of scenes) {
      const sceneCost = binding.estimateCny(scene);
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
        const prompt = compileDirectGenerationPrompt(scene);
        const resumedExistingTask = isExistingPaidTask(ledgerItem);
        if (resumedExistingTask || ledgerItem?.carriedForwardFromItemRequestId) {
          job.carriedForward = true;
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        const generated = ledgerItem?.state === "provider_succeeded" && ledgerItem.resultUrl
          ? acceptedResultFromLedger(ledgerItem)
          : ledgerItem?.state === "materialized"
            ? acceptedResultFromLedger(ledgerItem)
            : await generatePaidAssetItem({
                binding,
                scene,
                prompt,
                job,
                jobs,
                jobsPath,
                sceneCost,
                ledgerPath,
                ledger: openedLedger?.ledger,
                ledgerItem,
                allowCreate: openedLedger?.created !== false,
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
          replaceSceneAsset(plan, assets, scene, generated.taskId, materialized.path, providerId, binding.mediaType);
          mediaArtifacts.push(await describeFile(
            materialized.path,
            "media_asset",
            materialized.contentType,
            providerId,
            request,
            `AI-generated ${binding.mediaType}; review provider terms, likeness rights, and AIGC disclosure before publishing.`,
          ));
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
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        replaceSceneAsset(plan, assets, scene, generated.taskId, media.path, providerId, binding.mediaType);
        mediaArtifacts.push(await describeFile(
          media.path,
          "media_asset",
          media.contentType,
          providerId,
          request,
          `AI-generated ${binding.mediaType}; review provider terms, likeness rights, and AIGC disclosure before publishing.`,
        ));
      } catch (error) {
        job.status = "failed";
        job.error = safeGenerationDiagnostic(error);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (ledgerPath && openedLedger && ledgerItem) {
          if (!isManuallyReconciledTerminalItem(ledgerItem)) {
            ledgerItem.error = job.error;
            if (ledgerItem.resultUrl && ledgerItem.taskId) {
              ledgerItem.state = "provider_succeeded";
            }
          }
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        if (openedLedger?.created === false) continue;
        break;
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
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
        status: "failed",
        output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
        artifacts: [planArtifact, jobsArtifact],
        error: {
          code: "ASSET_GENERATION_FAILED",
          message: `Scene ${failedJob.scenePosition} generation failed: ${failedJob.error ?? "unknown provider error"}`,
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
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
      artifacts: [
        ...retainedFinalAssetArtifacts(baseline.artifacts, planPath, assets),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics,
    };
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
    const script = requiredRecord(JSON.parse(await readFile(scriptPath, "utf8")), "Script");
    const scenes = parseScenes(script.scenes);
    const sceneByPosition = new Map(scenes.map((scene) => [scene.position, scene]));
    const directorPlan = requiredRecord(JSON.parse(await readFile(directorPlanPath, "utf8")), "Director plan");
    const routedShots = parseRoutedShots(directorPlan.shots);
    assertExactScenePositions("Director plan", routedShots.map((shot) => shot.scenePosition), scenes);
    const modelSelections = optionalStringRecord(parameters.modelSelections, "modelSelections");
    const byScenePosition = new Map(routedShots.map((route) => [route.scenePosition, route]));
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
      return [{ route, scene, providerId, ...(modelId ? { modelId } : {}), binding }];
    }).sort((left, right) => left.scene.position - right.scene.position);
    const generatedRouteByPosition = new Map(generatedRoutes.map((entry) => [entry.scene.position, entry]));
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
    const baseItems = generatedRoutes.map(({ route, scene, binding, providerId }) => createPaidAssetOperationItem(
      operationId,
      scene,
      "ai-shot-router-v1",
      providerId,
      binding,
      compileGenerationPrompt(providerId, route, scene),
      sourceFingerprint,
      route.referenceFromScenePosition === undefined
        ? undefined
        : { scenePosition: route.referenceFromScenePosition },
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
      ? await preparePaidAssetOperation(outputDir, operationId, baseItems, reworkCarryForwardItems)
      : undefined;
    const estimatedCost = preparedOperation?.createCostCny ?? 0;
    if (estimatedCost > 0 && maxCostCny <= 0) {
      throw new Error("Paid asset execution requires a positive spend authorization.");
    }
    if (estimatedCost > maxCostCny) {
      throw new Error(`Estimated cost ¥${estimatedCost} exceeds the authorized maximum ¥${maxCostCny}.`);
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

    for (const { route, scene, binding, providerId } of generatedRoutes) {
      const sceneCost = binding.estimateCny(scene);
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
        const prompt = compileGenerationPrompt(providerId, route, scene);
        let referenceImages: [string, ...string[]] | undefined;
        if (route.referenceFromScenePosition !== undefined && ledgerItem?.state !== "materialized") {
          if (!openedLedger || !ledgerPath || !ledgerItem) {
            throw new Error(`Scene ${scene.position} reference image operation ledger is unavailable.`);
          }
          const reference = await materializedReferenceImage(
            openedLedger.ledger,
            route.referenceFromScenePosition,
          );
          const referencedItem = createPaidAssetOperationItem(
            operationId,
            scene,
            "ai-shot-router-v1",
            providerId,
            binding,
            prompt,
            sourceFingerprint,
            { scenePosition: route.referenceFromScenePosition, imageSha256: reference.sha256 },
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
        const generated = ledgerItem?.state === "provider_succeeded" && ledgerItem.resultUrl
          ? acceptedResultFromLedger(ledgerItem)
          : ledgerItem?.state === "materialized"
            ? acceptedResultFromLedger(ledgerItem)
            : await generatePaidAssetItem({
                binding,
                scene,
                prompt,
                job,
                jobs,
                jobsPath,
                sceneCost,
                ledgerPath,
                ledger: openedLedger?.ledger,
                ledgerItem,
                allowCreate: openedLedger?.created !== false,
                ...(referenceImages ? { referenceImages } : {}),
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
          replaceSceneAsset(plan, assets, scene, generated.taskId, materialized.path, providerId, binding.mediaType);
          mediaArtifacts.push(await describeFile(
            materialized.path,
            "media_asset",
            materialized.contentType,
            providerId,
            request,
            `AI-generated ${binding.mediaType} selected by the director plan; review terms, likeness rights, and AIGC disclosure.`,
          ));
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
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        replaceSceneAsset(plan, assets, scene, generated.taskId, media.path, providerId, binding.mediaType);
        mediaArtifacts.push(await describeFile(
          media.path,
          "media_asset",
          media.contentType,
          providerId,
          request,
          `AI-generated ${binding.mediaType} selected by the director plan; review terms, likeness rights, and AIGC disclosure.`,
        ));
      } catch (error) {
        job.status = "failed";
        job.error = safeGenerationDiagnostic(error);
        if (job.carriedForward) {
          delete job.actualCostCny;
          delete job.actualCostSource;
        }
        await writeJobs(jobsPath, jobs);
        if (ledgerPath && openedLedger && ledgerItem) {
          if (!isManuallyReconciledTerminalItem(ledgerItem)) {
            ledgerItem.error = job.error;
            if (ledgerItem.resultUrl && ledgerItem.taskId) ledgerItem.state = "provider_succeeded";
          }
          await writeGenerationLedger(ledgerPath, openedLedger.ledger);
        }
        if (openedLedger?.created === false) continue;
        break;
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
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
        status: "failed",
        output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
        artifacts: [planArtifact, jobsArtifact],
        error: {
          code: "ASSET_GENERATION_FAILED",
          message: `Scene ${failedJob.scenePosition} generation failed: ${failedJob.error ?? "unknown provider error"}`,
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
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
      artifacts: [
        ...retainedFinalAssetArtifacts(baseline.artifacts, planPath, assets),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics,
    };
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
      return {
        mediaType: "video",
        estimatedCnyPerAsset,
        estimateCny: (scene) => estimateVideoGenerationCostCny(
          scene.duration,
          estimatedCnyPerAsset,
          profile,
        ),
        ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
        generate: async (scene, prompt, onProgress) => {
          const result = await video.adapter.generate({
            ...generationRequest(scene, prompt, profile),
            ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
          }, onProgress);
          return { taskId: result.taskId, url: result.videoUrl };
        },
        ...(video.adapter.reconcile
          ? {
              reconcile: async (taskId, scene, prompt, onProgress) => {
                const result = await video.adapter.reconcile!(taskId, {
                  ...generationRequest(scene, prompt, profile),
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
        estimateCny: () => image.estimatedCnyPerImage,
        ...(modelId ? { modelId } : {}),
        generate: async (_scene, prompt, onProgress, referenceImages) => {
          const result = await image.adapter.generate({
            prompt,
            ratio: "9:16",
            ...(referenceImages ? { referenceImages } : {}),
          }, onProgress);
          return { taskId: result.taskId, url: result.imageUrl };
        },
      };
    }
    return undefined;
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

// 导演节点与素材执行器共用的唯一影响闭包：结构化范围、finding 定位、无定位保守全片、
// script 逐镜差异和 previous/current 方案中的 reference/REUSE 传递依赖都在这里展开，
// 下游不得再用另一套自然语言规则推导范围。
export function reworkAffectedScenePositions(scope: ReworkAffectedSceneScope): number[] {
  const currentSceneRecords = positionedRecords(scope.currentScenes, "position");
  const validPositions = new Set(currentSceneRecords.keys());
  if (validPositions.size === 0) return [];
  const visualFindings = (Array.isArray(scope.findings) ? scope.findings : []).filter((finding) => (
    isRecord(finding)
    && Array.isArray(finding.targetNodeIds)
    && finding.targetNodeIds.some((target) => target === "visual-direction" || target === "assets")
  ));
  const affected = new Set<number>();
  for (const finding of visualFindings) {
    const position = Number(finding.scenePosition);
    if (!Number.isInteger(finding.scenePosition) || finding.scenePosition === undefined) {
      // 无法定位的返工问题保守按全片处理。
      return [...validPositions].sort((left, right) => left - right);
    }
    if (position > 0) affected.add(position);
  }
  const previousSceneRecords = positionedRecords(scope.previousScenes, "position");
  if (previousSceneRecords.size > 0) {
    for (const [position, scene] of currentSceneRecords) {
      if (!isDeepStrictEqual(scene, previousSceneRecords.get(position))) affected.add(position);
    }
  }
  // 自由文本只描述“怎么改”，不再决定付费范围。旧 run 缺少结构化字段时，
  // 任何局部推断都可能漏掉应重做镜头，因此 fail closed 为全部当前镜头。
  if (scope.affectedScenePositions === undefined) {
    for (const position of validPositions) affected.add(position);
  } else {
    for (const position of scope.affectedScenePositions) {
      if (Number.isInteger(position) && position > 0) affected.add(position);
    }
  }
  expandAffectedDependencies(affected, scope.previousShots);
  expandAffectedDependencies(affected, scope.currentShots);
  return [...affected].filter((position) => validPositions.has(position)).sort((left, right) => left - right);
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
  if (typeof shot.query !== "string") return undefined;
  return assetReuseSourceScenePosition({ query: shot.query });
}

async function findReworkCarryForwardItems(
  options: Partial<Pick<ReworkCarryForwardInspection, "runsRoot">>
    & Omit<ReworkCarryForwardInspection, "runsRoot">,
): Promise<PaidAssetOperationItem[]> {
  if (!options.runsRoot || !isRecord(options.input.rework)) return [];
  const rework = options.input.rework;
  const sourceRunId = optionalString(rework.sourceRunId);
  if (!sourceRunId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceRunId)
    || !isRecord(rework.previousScript)
    || !isRecord(rework.previousDirectorPlan)) {
    return [];
  }

  const routedShots = parseRoutedShots(options.currentDirectorPlan.shots);
  // 与导演节点使用同一套统一影响闭包；结构化 affectedScenePositions 决定用户选择，
  // 旧 run 缺少该字段时由闭包保守按全片处理。
  const affectedScenes = new Set<number>(reworkAffectedScenePositions({
    findings: rework.findings,
    previousScenes: rework.previousScript.scenes,
    previousShots: rework.previousDirectorPlan.shots,
    currentScenes: options.currentScript.scenes,
    currentShots: options.currentDirectorPlan.shots,
    ...(Array.isArray(rework.affectedScenePositions)
      ? { affectedScenePositions: rework.affectedScenePositions.map(Number) }
      : {}),
  }));
  if (Array.isArray(rework.affectedScenePositions)) {
    for (const value of rework.affectedScenePositions) {
      const position = Number(value);
      if (Number.isInteger(position) && position > 0) affectedScenes.add(position);
    }
  }
  const currentScenes = positionedRecords(options.currentScript.scenes, "position");
  const previousScenes = positionedRecords(rework.previousScript.scenes, "position");
  // 为什么不用整条 shot deepEqual：estimatedCostCny、confidence、rationale 等字段只影响
  // 展示与估算，费率调整会让执行语义完全相同的镜头被判为不可复用并重复付费生成；
  // 因此这里改用执行语义指纹比较——即 parseRoutedShots 提取的字段（Provider 路由与
  // 交付类型、query 与 generationPrompt、节拍/构图/光线等生成参数、reuse/reference 依赖），
  // 而 script 场景内容仍按整场景严格比较，账本身份门禁（provider/model/source
  // fingerprint/media type/duration/reference）仍由 preparePaidAssetOperation 把守。
  const previousExecutionShots = previousExecutionShotsByPosition(rework.previousDirectorPlan);
  const reusableScenes = new Set(routedShots.flatMap((shot) => {
    if (affectedScenes.has(shot.scenePosition)
      || !isDeepStrictEqual(currentScenes.get(shot.scenePosition), previousScenes.get(shot.scenePosition))
      || !isDeepStrictEqual(shot, previousExecutionShots.get(shot.scenePosition))) {
      return [];
    }
    return [shot.scenePosition];
  }));
  if (reusableScenes.size === 0) return [];

  const sourceItems = await effectiveSourcePaidAssetItems(options.runsRoot, sourceRunId);
  return safelyCarriableReworkItems(sourceItems, reusableScenes, routedShots, options.modelSelections);
}

// previous 计划若缺少执行语义必需字段则无法证明任何镜头可安全继承，fail closed 按新生成报价。
function previousExecutionShotsByPosition(previousDirectorPlan: Record<string, unknown>): Map<number, RoutedShot> {
  try {
    return new Map(parseRoutedShots(previousDirectorPlan.shots).map((shot) => [shot.scenePosition, shot]));
  } catch {
    return new Map();
  }
}

// 参考图生成的母片与独立生成母片一样可以跨 run 继承，但必须能证明引用链身份：
// 引用源镜头同样可安全继承且为 materialized image，source item 记录的 referenceImageSha256
// 与实际继承源的 SHA-256 一致，且与当前路由声明的 referenceFromScenePosition 相同。
// 任何一项无法证明时 fail closed，按新生成报价。
function safelyCarriableReworkItems(
  sourceItems: PaidAssetOperationItem[],
  reusableScenes: Set<number>,
  routedShots: RoutedShot[],
  modelSelections: Readonly<Record<string, string>>,
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
  return carried;
}

async function effectiveSourcePaidAssetItems(runsRoot: string, sourceRunId: string): Promise<PaidAssetOperationItem[]> {
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
  if (!Array.isArray(sourceRun.nodeRuns)) return [];
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
  const rate = perSecond ?? profile?.estimatedCnyPerSecond;
  return roundMoney(rate ? durationSeconds * rate : estimatedCnyPerClip);
}

function optionalStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const input = requiredRecord(value, field);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}.${key} must be a non-empty string.`);
    return [key, item.trim()];
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

function generationRequest(
  scene: ScriptScene,
  prompt = scene.visualPrompt,
  profile?: VideoGenerationRuntimeProfile,
): VideoGenerationRequest {
  const resolution = preferredResolution(profile?.resolutions);
  return {
    prompt,
    durationSeconds: normalizeVideoGenerationDurationSeconds(scene.duration, profile),
    ratio: "9:16",
    ...(resolution ? { resolution } : {}),
    ...(profile ? { generateAudio: false } : {}),
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
  return Math.max(minimum, Math.min(maximum, Math.round(sceneDurationSeconds)));
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
    || !Number.isInteger(profile.minDurationSeconds)
    || !Number.isInteger(profile.maxDurationSeconds)
    || profile.minDurationSeconds < 2
    || profile.maxDurationSeconds > 15
    || profile.minDurationSeconds > profile.maxDurationSeconds
    || typeof profile.supportsAudio !== "boolean") {
    throw new Error(`Adapter '${providerId}' has an invalid runtime profile for model '${modelId}'.`);
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
  route: { reuseFromScenePosition?: number; query: string },
): number | undefined {
  if (route.reuseFromScenePosition !== undefined) return route.reuseFromScenePosition;
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
    const usesLocalCard = asset.provider === "local" || asset.source_url === "local://video-factory/card";
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
    meteredFailedAttemptCount: submittedJobs.filter((job) => job.status === "failed").length,
  };
}

// 就本地证据而言，Provider 结果已知当且仅当 ledger 中不存在任何停留在 unknown
// （create 边界断连，结果可能已被受理）或 submitted（在途）状态的条目。
function ledgerProviderOutcomeKnown(ledger: PaidAssetOperationLedger | undefined): boolean {
  if (!ledger) return true;
  return ledger.items.every((item) => item.state !== "unknown" && item.state !== "submitted");
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
    const preferredProviderId = requiredString(shot.preferredProviderId, `Director shot ${index + 1} preferredProviderId`);
    const reuseFromScenePosition = shot.reuseFromScenePosition === undefined
      ? undefined
      : boundedInteger(shot.reuseFromScenePosition, `Director shot ${index + 1} reuseFromScenePosition`, 1, 10_000);
    const referenceFromScenePosition = shot.referenceFromScenePosition === undefined
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
      temporalBeats: optionalStringArray(shot.temporalBeats, `Director shot ${index + 1} temporalBeats`),
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
    const { source_url: _previousSourceUrl, ...existingFields } = existing ?? {};
    const next = {
      ...existingFields,
      scene_position: scenePosition,
      provider: providerId,
      asset_id: taskId,
      media_type: mediaType,
      width: mediaType === "video" ? 720 : 1440,
      height: mediaType === "video" ? 1280 : 2560,
      duration: existing?.duration ?? scene.duration,
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
      if (!location) throw new Error(`Generated ${mediaType} redirect did not include a location.`);
      if (redirects === 5) throw new Error(`Generated ${mediaType} download exceeded the redirect limit.`);
      currentTarget = await validatedMediaTarget(new URL(location, currentTarget.url).toString(), resolveHost);
    }
    if (!response) throw new Error(`Generated ${mediaType} download did not return a response.`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Generated ${mediaType} download failed with status ${response.status}.`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Generated ${mediaType} exceeds the ${maxBytes}-byte download limit.`);
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
    throw new Error("Generated media URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Generated media URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || isBlockedMediaHost(url.hostname)) {
    throw new Error("Generated media URL points to a private or unsafe network destination.");
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
    throw new Error("Generated media URL points to a private or unsafe network destination.");
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
  if (!response.body) throw new Error(`Generated ${mediaType} download returned an empty body.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Generated ${mediaType} exceeds the ${maxBytes}-byte download limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function validatedMediaContentType(mediaType: "image" | "video", value: string | undefined): string {
  if (mediaType === "video") {
    if (value && !["video/mp4", "application/mp4", "audio/mp4", "application/octet-stream"].includes(value)) {
      throw new Error(`Generated video returned unsupported content type '${value}'.`);
    }
    return "video/mp4";
  }
  if (value && value !== "application/octet-stream" && !["image/jpeg", "image/webp", "image/png"].includes(value)) {
    throw new Error(`Generated image returned unsupported content type '${value}'.`);
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
  providerId: string,
  binding: ResolvedAssetBinding,
  prompt: string,
  sourceFingerprint: string,
  reference?: { scenePosition: number; imageSha256?: string },
): PaidAssetOperationItem {
  const parameters = {
    mediaType: binding.mediaType,
    durationSeconds: binding.mediaType === "video" ? generationRequest(scene, prompt).durationSeconds : 1,
    ratio: "9:16",
    ...(reference ? { referenceFromScenePosition: reference.scenePosition } : {}),
    ...(reference?.imageSha256 ? { referenceImageSha256: reference.imageSha256 } : {}),
  };
  const modelId = binding.modelId ?? providerId;
  const inputFingerprint = createHash("sha256").update(JSON.stringify({
    scenePosition: scene.position,
    providerId,
    modelId,
    prompt,
    sourceFingerprint,
    parameters,
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
    providerId,
    modelId,
    sourceFingerprint,
    parameters,
    state: "prepared",
    estimatedCostCny: binding.estimateCny(scene),
  };
}

async function preparePaidAssetOperation(
  outputDir: string,
  operationId: string,
  items: PaidAssetOperationItem[],
  reworkCarryForwardItems: PaidAssetOperationItem[] = [],
): Promise<{
  ledgerPath: string;
  items: PaidAssetOperationItem[];
  existing: boolean;
  createCostCny: number;
}> {
  const ledgerPath = generationLedgerPath(outputDir, operationId);
  try {
    const persisted = parsePaidAssetOperationLedger(JSON.parse(await readFile(ledgerPath, "utf8")), operationId);
    if (!paidOperationInputsMatch(persisted.items, items)) {
      throw new Error("This paid generation operation no longer matches its persisted item inputs.");
    }
    return { ledgerPath, items: persisted.items, existing: true, createCostCny: 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const previousItems = await previousPaidAssetItems(path.dirname(ledgerPath), operationId);
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
    const reusable = candidates.find((candidate) => candidate.state === "materialized")
      ?? candidates.find((candidate) => (
        candidate.state === "provider_succeeded"
        && Boolean(candidate.taskId)
        && Boolean(candidate.resultUrl)
      ));
    if (reusable) {
      const carriedBase = reworkCandidates.includes(reusable)
        ? item
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
  return {
    ledgerPath,
    items: carriedItems,
    existing: false,
    createCostCny: roundMoney(carriedItems.reduce(
      (sum, item) => sum + (item.carriedForwardFromItemRequestId ? 0 : item.estimatedCostCny),
      0,
    )),
  };
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
    && candidate.parameters.mediaType === prepared.parameters.mediaType
    && candidate.parameters.durationSeconds === prepared.parameters.durationSeconds
    && candidate.parameters.ratio === prepared.parameters.ratio;
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
    || candidate.sourceFingerprint !== prepared.sourceFingerprint) {
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
    if (value.version !== "video-factory/paid-operation-v2" || !Array.isArray(value.items)) continue;
    items.push(...value.items as PaidAssetOperationItem[]);
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
  actualCostSource?: "configured_rate";
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
      continue;
    }
    for (const item of record.items as PaidAssetOperationItem[]) {
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
      && candidate.scenePosition === item.scenePosition
      && candidate.executorProviderId === item.executorProviderId
      && candidate.providerId === item.providerId
      && candidate.modelId === item.modelId
      && candidate.sourceFingerprint === item.sourceFingerprint;
  });
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
  scene: ScriptScene;
  prompt: string;
  job: GenerationJob;
  jobs: GenerationJob[];
  jobsPath: string;
  sceneCost: number;
  ledgerPath: string | undefined;
  ledger: PaidAssetOperationLedger | undefined;
  ledgerItem: PaidAssetOperationItem | undefined;
  allowCreate: boolean;
  referenceImages?: [string, ...string[]];
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
        options.scene,
        options.prompt,
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
      options.scene,
      options.prompt,
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

function acceptedResultFromLedger(item: PaidAssetOperationItem): { taskId: string; url: string } {
  if (!item.taskId || !item.resultUrl) {
    throw new Error(`Paid item '${item.itemRequestId}' is missing its accepted task result.`);
  }
  return { taskId: item.taskId, url: item.resultUrl };
}

async function verifyMaterializedItem(
  item: PaidAssetOperationItem,
): Promise<{ path: string; contentType: string }> {
  if (!item.localPath || !item.sha256 || item.sizeBytes === undefined) {
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

function generationLedgerPath(outputDir: string, operationId: string): string {
  return path.join(path.dirname(outputDir), ".generation-operations", `${createHash("sha256").update(operationId).digest("hex")}.json`);
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
