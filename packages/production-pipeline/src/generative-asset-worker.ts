import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
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
}

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
  error?: string;
}

interface RoutedShot {
  scenePosition: number;
  providerIds: string[];
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
  estimatedCnyPerAsset: number;
  modelId?: string;
  generate(
    scene: ScriptScene,
    prompt: string,
    onProgress: (progress: VideoGenerationProgress | ImageGenerationProgress) => Promise<void>,
  ): Promise<{ taskId: string; url: string }>;
}

interface RouteResolutionFailure {
  scenePosition: number;
  providerId: string;
  modelId?: string;
  reason: string;
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
      return this.options.fallback.run(request);
    }

    const maxPaidShots = boundedInteger(parameters.maxPaidShots, "maxPaidShots", 1, 20);
    const maxCostCny = boundedNumber(parameters.maxCostCny, "maxCostCny", 0.01, 100_000);
    const estimatedCost = roundMoney(maxPaidShots * binding.estimatedCnyPerAsset);
    if (estimatedCost > maxCostCny) {
      throw new Error(`Estimated cost ¥${estimatedCost} exceeds the production budget ¥${maxCostCny}.`);
    }

    const baselineRequest = structuredClone(request);
    baselineRequest.parameters = {
      ...parameters,
      providerId: "local-editorial-v1",
      provider: "local",
    };
    const baseline = await this.options.fallback.run(baselineRequest);
    if (baseline.status !== "succeeded") {
      return baseline;
    }

    const input = requiredRecord(request.input, "Worker input");
    const scriptPath = requiredString(input.scriptPath, "scriptPath");
    const outputDir = requiredString(request.outputDir, "outputDir");
    const script = requiredRecord(JSON.parse(await readFile(scriptPath, "utf8")), "Script");
    const scenes = parseScenes(script.scenes).filter((scene) => scene.visualStrategy !== "local").slice(0, maxPaidShots);
    const planPath = requiredString(baseline.output?.assetPlanPath, "assetPlanPath");
    const plan = requiredRecord(JSON.parse(await readFile(planPath, "utf8")), "Asset plan");
    const assets = Array.isArray(plan.scene_assets) ? plan.scene_assets : [];
    const jobsPath = path.join(outputDir, "generation_jobs.json");
    const jobs: GenerationJob[] = [];
    const mediaArtifacts: WorkerArtifactDescriptor[] = [];

    for (const scene of scenes) {
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId,
        status: "submitted",
        estimatedCostCny: binding.estimatedCnyPerAsset,
        mediaType: binding.mediaType,
        ...(binding.modelId ? { modelId: binding.modelId } : {}),
      };
      jobs.push(job);
      try {
        const generated = await binding.generate(
          scene,
          scene.visualPrompt,
          async (progress) => {
            applyProgress(job, progress, binding.estimatedCnyPerAsset);
            await writeJobs(jobsPath, jobs);
          },
        );
        applyAcceptedTask(job, generated.taskId, binding.estimatedCnyPerAsset);
        await writeJobs(jobsPath, jobs);
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
        replaceSceneAsset(assets, scene, generated.taskId, generated.url, media.path, providerId, binding.mediaType);
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
        job.error = error instanceof Error ? error.message : String(error);
        await writeJobs(jobsPath, jobs);
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
    const fallbackScenes = jobs.length - generatedScenes;
    const accountedCostCny = configuredCost(jobs);
    plan.scene_assets = assets;
    plan.generation = {
      providerId,
      maxPaidShots,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerAsset),
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate",
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
      jobsPath,
      localBaselinePreserved: true,
    };
    await writeJsonAtomically(planPath, plan);
    await writeJobs(jobsPath, jobs);
    const planArtifact = await describeFile(
      planPath,
      "asset_plan",
      "application/json",
      providerId,
      request,
      "Mixed local and AI-generated asset plan with per-scene provenance.",
    );
    const jobsArtifact = await describeFile(
      jobsPath,
      "generation_jobs",
      "application/json",
      providerId,
      request,
      "External task IDs and validated successful result URLs retained for audit.",
    );
    return {
      ...baseline,
      commandId: requiredString(request.commandId, "commandId"),
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
      artifacts: [
        ...baseline.artifacts.filter((artifact) => artifact.uri !== planPath),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics: {
        ...(baseline.diagnostics ?? {}),
        providerId,
        attemptedScenes: jobs.length,
        generatedScenes,
        fallbackScenes,
        estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerAsset),
        actualCostCny: accountedCostCny,
        actualCostSource: "configured_rate",
        ...meteredJobDiagnostics(jobs),
        ...actualModelDiagnostics(jobs),
      },
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
    const maxPaidShots = boundedInteger(parameters.maxPaidShots, "maxPaidShots", 0, 20);
    const maxCostCny = boundedNumber(parameters.maxCostCny, "maxCostCny", 0, 100_000);
    const script = requiredRecord(JSON.parse(await readFile(scriptPath, "utf8")), "Script");
    const scenes = parseScenes(script.scenes);
    const sceneByPosition = new Map(scenes.map((scene) => [scene.position, scene]));
    const directorPlan = requiredRecord(JSON.parse(await readFile(directorPlanPath, "utf8")), "Director plan");
    const routedShots = parseRoutedShots(directorPlan.shots);
    const modelSelections = optionalStringRecord(parameters.modelSelections, "modelSelections");
    const freeProviderIds = new Set([
      ...KNOWN_FREE_ASSET_PROVIDERS,
      ...optionalStringArray(parameters.freeProviderIds, "freeProviderIds"),
    ]);
    const resolutionFailures: RouteResolutionFailure[] = [];
    const generatedRoutes = routedShots.flatMap((route) => {
      let selected: { providerId: string; modelId?: string; binding: ResolvedAssetBinding } | undefined;
      let hasLocalFallback = false;
      for (const providerId of route.providerIds) {
        if (!KNOWN_METERED_ASSET_PROVIDERS.has(providerId)) {
          if (freeProviderIds.has(providerId)) {
            hasLocalFallback = true;
            break;
          }
          resolutionFailures.push({
            scenePosition: route.scenePosition,
            providerId,
            reason: `Provider '${providerId}' is not a recognized asset source.`,
          });
          continue;
        }
        const modelId = modelSelections[providerId];
        try {
          const binding = this.resolveBinding(providerId, modelId);
          if (binding) {
            selected = { providerId, ...(modelId ? { modelId } : {}), binding };
            break;
          }
          resolutionFailures.push({
            scenePosition: route.scenePosition,
            providerId,
            ...(modelId ? { modelId } : {}),
            reason: `Provider '${providerId}' is not configured.`,
          });
        } catch (error) {
          resolutionFailures.push({
            scenePosition: route.scenePosition,
            providerId,
            ...(modelId ? { modelId } : {}),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!selected) {
        const failure = [...resolutionFailures].reverse().find((item) => item.scenePosition === route.scenePosition);
        if (failure && !hasLocalFallback) throw new Error(failure.reason);
        return [];
      }
      const scene = sceneByPosition.get(route.scenePosition);
      if (!scene) throw new Error(`AI director selected unknown script scene ${route.scenePosition}.`);
      return [{ route, scene, ...selected }];
    });
    if (generatedRoutes.length > maxPaidShots) {
      throw new Error(`AI director selected ${generatedRoutes.length} paid shots, exceeding the limit ${maxPaidShots}.`);
    }
    const estimatedCost = roundMoney(generatedRoutes.reduce((sum, item) => sum + item.binding.estimatedCnyPerAsset, 0));
    if (estimatedCost > maxCostCny) {
      throw new Error(`Estimated cost ¥${estimatedCost} exceeds the production budget ¥${maxCostCny}.`);
    }

    const baseline = await this.options.fallback.run(structuredClone(request));
    if (baseline.status !== "succeeded") {
      return baseline;
    }
    if (generatedRoutes.length === 0 && resolutionFailures.length === 0) {
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
    const jobs: GenerationJob[] = [];
    const mediaArtifacts: WorkerArtifactDescriptor[] = [];

    for (const { route, scene, binding, providerId } of generatedRoutes) {
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId,
        status: "submitted",
        estimatedCostCny: binding.estimatedCnyPerAsset,
        mediaType: binding.mediaType,
        ...(binding.modelId ? { modelId: binding.modelId } : {}),
      };
      jobs.push(job);
      try {
        const generated = await binding.generate(
          scene,
          compileGenerationPrompt(providerId, route, scene),
          async (progress) => {
            applyProgress(job, progress, binding.estimatedCnyPerAsset);
            await writeJobs(jobsPath, jobs);
          },
        );
        applyAcceptedTask(job, generated.taskId, binding.estimatedCnyPerAsset);
        await writeJobs(jobsPath, jobs);
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
        replaceSceneAsset(assets, scene, generated.taskId, generated.url, media.path, providerId, binding.mediaType);
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
        job.error = error instanceof Error ? error.message : String(error);
        await writeJobs(jobsPath, jobs);
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
    const routedScenePositions = new Set(generatedRoutes.map((item) => item.scene.position));
    const configurationFallbackScenes = new Set(
      resolutionFailures.filter((item) => !routedScenePositions.has(item.scenePosition)).map((item) => item.scenePosition),
    ).size;
    const fallbackScenes = jobs.filter((job) => job.status !== "succeeded").length + configurationFallbackScenes;
    const accountedCostCny = configuredCost(jobs);
    plan.scene_assets = assets;
    plan.generation = {
      providerId: "ai-shot-router-v1",
      directorPlanPath,
      maxPaidShots,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: estimatedCost,
      actualCostCny: accountedCostCny,
      actualCostSource: "configured_rate",
      ...meteredJobDiagnostics(jobs),
      ...actualModelDiagnostics(jobs),
      jobsPath,
      localBaselinePreserved: true,
      ...(resolutionFailures.length ? { skippedRoutes: resolutionFailures } : {}),
    };
    await writeJsonAtomically(planPath, plan);
    await writeJobs(jobsPath, jobs);
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
    return {
      ...baseline,
      commandId: requiredString(request.commandId, "commandId"),
      output: { ...(baseline.output ?? {}), assetPlanPath: planPath, generationJobsPath: jobsPath },
      artifacts: [
        ...baseline.artifacts.filter((artifact) => artifact.uri !== planPath),
        planArtifact,
        jobsArtifact,
        ...mediaArtifacts,
      ],
      diagnostics: {
        ...(baseline.diagnostics ?? {}),
        providerId: "ai-shot-router-v1",
        attemptedScenes: jobs.length,
        generatedScenes,
        fallbackScenes,
        estimatedCostCny: estimatedCost,
        actualCostCny: accountedCostCny,
        actualCostSource: "configured_rate",
        ...meteredJobDiagnostics(jobs),
        ...actualModelDiagnostics(jobs),
        ...(resolutionFailures.length ? { skippedRoutes: resolutionFailures } : {}),
      },
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
        ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
        generate: async (scene, prompt, onProgress) => {
          const result = await video.adapter.generate({
            ...generationRequest(scene, prompt, profile),
            ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
          }, onProgress);
          return { taskId: result.taskId, url: result.videoUrl };
        },
      };
    }
    const image = this.imageAdapters.get(providerId);
    if (image) {
      return {
        mediaType: "image",
        estimatedCnyPerAsset: image.estimatedCnyPerImage,
        generate: async (_scene, prompt, onProgress) => {
          const result = await image.adapter.generate({ prompt, ratio: "9:16" }, onProgress);
          return { taskId: result.taskId, url: result.imageUrl };
        },
      };
    }
    return undefined;
  }
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
  const minimum = profile?.minDurationSeconds ?? 4;
  const maximum = profile?.maxDurationSeconds ?? 15;
  const resolution = preferredResolution(profile?.resolutions);
  return {
    prompt,
    durationSeconds: Math.max(minimum, Math.min(maximum, Math.round(scene.duration))),
    ratio: "9:16",
    ...(resolution ? { resolution } : {}),
    ...(profile ? { generateAudio: false } : {}),
  };
}

function preferredResolution(resolutions: string[] | undefined): VideoGenerationRequest["resolution"] | undefined {
  if (!resolutions) return undefined;
  const normalized = resolutions.map((value) => value.toLowerCase());
  return (["720p", "1080p", "480p"] as const).find((value) => normalized.includes(value));
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
  return roundMoney(jobs.reduce((sum, job) => sum + (job.actualCostCny ?? 0), 0));
}

function meteredJobDiagnostics(jobs: GenerationJob[]): {
  meteredAttemptCount: number;
  meteredFailedAttemptCount: number;
} {
  const submittedJobs = jobs.filter((job) => Boolean(job.taskId?.trim()));
  return {
    meteredAttemptCount: submittedJobs.length,
    meteredFailedAttemptCount: submittedJobs.filter((job) => job.status === "failed").length,
  };
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
    return {
      scenePosition: boundedInteger(shot.scenePosition, `Director shot ${index + 1} scenePosition`, 1, 10_000),
      providerIds: [
        requiredString(shot.preferredProviderId, `Director shot ${index + 1} preferredProviderId`),
        ...optionalStringArray(shot.alternativeProviderIds, `Director shot ${index + 1} alternativeProviderIds`),
      ],
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

function compileGenerationPrompt(providerId: string, route: RoutedShot, scene: ScriptScene): string {
  const hasShotSpec = Boolean(route.subject || route.environment || route.visibleAction || route.temporalBeats.length
    || route.shotSize || route.camera || route.lighting || route.negativeConstraints.length || route.successCriteria.length);
  if (!hasShotSpec) return sanitizePrompt(route.generationPrompt || scene.visualPrompt);

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
    ].join("\n");
  }
  if (providerId === "hailuo-video-v1" || providerId === "wan-video-v1") {
    return [
      "竖屏 9:16，电影化写实画面，运动自然，主体连续。",
      ...common,
      ...(timeline.length ? [`动作时间线：${timeline.join("；")}`] : []),
      ...(success.length ? [`画面验收：${success.join("；")}`] : []),
      ...(negative.length ? [`负面约束：${negative.join("；")}`] : []),
    ].join("\n");
  }
  return [
    "竖屏 9:16，单张关键画面，主体清晰，构图可用于短视频剪辑。",
    ...common,
    ...(success.length ? [`画面验收：${success.join("；")}`] : []),
    ...(negative.length ? [`负面约束：${negative.join("；")}`] : []),
  ].join("\n");
}

function promptClause(label: string, value: string | undefined): string {
  const safe = sanitizePrompt(value ?? "");
  return safe ? `${label}：${safe}` : "";
}

function sanitizePrompt(value: string): string {
  const forbidden = /审批|预算|版权|工作流|授权|付费|费用|合规/;
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
  if (progress.error) job.error = progress.error;
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
  assets: unknown[],
  scene: ScriptScene,
  taskId: string,
  videoUrl: string,
  clipPath: string,
  providerId: string,
  mediaType: "image" | "video",
): void {
  const next = {
    scene_position: scene.position,
    provider: providerId,
    asset_id: taskId,
    media_type: mediaType,
    width: mediaType === "video" ? 720 : 1440,
    height: mediaType === "video" ? 1280 : 2560,
    duration: scene.duration,
    local_path: clipPath,
    source_url: videoUrl,
    creator: providerId,
    license_note: `AI-generated ${mediaType}; provider terms and AIGC disclosure apply.`,
    query: scene.visualPrompt,
  };
  const index = assets.findIndex((asset) => {
    return typeof asset === "object" && asset !== null && !Array.isArray(asset)
      && Number((asset as Record<string, unknown>).scene_position) === scene.position;
  });
  if (index >= 0) assets[index] = next;
  else assets.push(next);
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

async function writeJobs(pathname: string, jobs: GenerationJob[]): Promise<void> {
  await writeJsonAtomically(pathname, { version: "video-factory/generation-jobs-v1", jobs });
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
