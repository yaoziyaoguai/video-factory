import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerArtifactDescriptor, WorkerResponse } from "./python-worker-client.js";
import type {
  VideoGenerationAdapter,
  VideoGenerationProgress,
  VideoGenerationRequest,
} from "./video-generation.js";

interface WorkerClient {
  run(request: Record<string, unknown>): Promise<WorkerResponse>;
}

export interface VideoGenerationAdapterBinding {
  adapter: VideoGenerationAdapter;
  estimatedCnyPerClip: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GenerativeAssetWorkerClientOptions {
  fallback: WorkerClient;
  adapters: VideoGenerationAdapterBinding[];
  fetch?: FetchLike;
  maxDownloadBytes?: number;
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
  videoUrl?: string;
  error?: string;
}

interface RoutedShot {
  scenePosition: number;
  providerId: string;
  generationPrompt: string;
}

const KNOWN_METERED_ASSET_PROVIDERS = new Set(["seedance-video-v1", "wan-video-v1"]);

export class GenerativeAssetWorkerClient implements WorkerClient {
  private readonly adapters = new Map<string, VideoGenerationAdapterBinding>();
  private readonly fetch: FetchLike;
  private readonly maxDownloadBytes: number;

  constructor(private readonly options: GenerativeAssetWorkerClientOptions) {
    for (const binding of options.adapters) {
      if (!Number.isFinite(binding.estimatedCnyPerClip) || binding.estimatedCnyPerClip <= 0) {
        throw new Error(`Adapter '${binding.adapter.providerId}' must have a positive estimatedCnyPerClip.`);
      }
      if (this.adapters.has(binding.adapter.providerId)) {
        throw new Error(`Adapter '${binding.adapter.providerId}' is already configured.`);
      }
      this.adapters.set(binding.adapter.providerId, binding);
    }
    this.fetch = options.fetch ?? fetch;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 200 * 1024 * 1024;
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
    const binding = this.adapters.get(providerId);
    if (!binding) {
      if (KNOWN_METERED_ASSET_PROVIDERS.has(providerId)) {
        throw new Error(`Metered asset provider '${providerId}' is not configured in this worker.`);
      }
      return this.options.fallback.run(request);
    }

    const maxPaidShots = boundedInteger(parameters.maxPaidShots, "maxPaidShots", 1, 20);
    const maxCostCny = boundedNumber(parameters.maxCostCny, "maxCostCny", 0.01, 100_000);
    const estimatedCost = roundMoney(maxPaidShots * binding.estimatedCnyPerClip);
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
        estimatedCostCny: binding.estimatedCnyPerClip,
      };
      jobs.push(job);
      try {
        const generated = await binding.adapter.generate(
          generationRequest(scene),
          async (progress) => {
            applyProgress(job, progress);
            await writeJobs(jobsPath, jobs);
          },
        );
        const clipPath = path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${providerId}.mp4`);
        await downloadVideo(this.fetch, generated.videoUrl, clipPath, this.maxDownloadBytes);
        applyProgress(job, {
          providerId,
          taskId: generated.taskId,
          status: "succeeded",
          videoUrl: generated.videoUrl,
        });
        await writeJobs(jobsPath, jobs);
        replaceSceneAsset(assets, scene, generated.taskId, generated.videoUrl, clipPath, providerId);
        mediaArtifacts.push(await describeFile(
          clipPath,
          "media_asset",
          "video/mp4",
          providerId,
          request,
          "AI-generated video; review provider terms, likeness rights, and AIGC disclosure before publishing.",
        ));
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        await writeJobs(jobsPath, jobs);
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
    const fallbackScenes = jobs.length - generatedScenes;
    plan.scene_assets = assets;
    plan.generation = {
      providerId,
      maxPaidShots,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerClip),
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
      "External task IDs and temporary result URLs retained for audit.",
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
        estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerClip),
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
    const generatedRoutes = routedShots.flatMap((route) => {
      const binding = this.adapters.get(route.providerId);
      if (!binding) {
        if (KNOWN_METERED_ASSET_PROVIDERS.has(route.providerId)) {
          throw new Error(`AI director selected unconfigured metered provider '${route.providerId}'.`);
        }
        return [];
      }
      const scene = sceneByPosition.get(route.scenePosition);
      if (!scene) throw new Error(`AI director selected unknown script scene ${route.scenePosition}.`);
      return [{ route, scene, binding }];
    });
    if (generatedRoutes.length > maxPaidShots) {
      throw new Error(`AI director selected ${generatedRoutes.length} paid shots, exceeding the limit ${maxPaidShots}.`);
    }
    const estimatedCost = roundMoney(generatedRoutes.reduce((sum, item) => sum + item.binding.estimatedCnyPerClip, 0));
    if (estimatedCost > maxCostCny) {
      throw new Error(`Estimated cost ¥${estimatedCost} exceeds the production budget ¥${maxCostCny}.`);
    }

    const baseline = await this.options.fallback.run(structuredClone(request));
    if (baseline.status !== "succeeded" || generatedRoutes.length === 0) {
      return baseline;
    }

    const planPath = requiredString(baseline.output?.assetPlanPath, "assetPlanPath");
    const plan = requiredRecord(JSON.parse(await readFile(planPath, "utf8")), "Asset plan");
    const assets = Array.isArray(plan.scene_assets) ? plan.scene_assets : [];
    const jobsPath = path.join(outputDir, "generation_jobs.json");
    const jobs: GenerationJob[] = [];
    const mediaArtifacts: WorkerArtifactDescriptor[] = [];

    for (const { route, scene, binding } of generatedRoutes) {
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId: route.providerId,
        status: "submitted",
        estimatedCostCny: binding.estimatedCnyPerClip,
      };
      jobs.push(job);
      try {
        const generated = await binding.adapter.generate(
          generationRequest(scene, route.generationPrompt),
          async (progress) => {
            applyProgress(job, progress);
            await writeJobs(jobsPath, jobs);
          },
        );
        const clipPath = path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${route.providerId}.mp4`);
        await downloadVideo(this.fetch, generated.videoUrl, clipPath, this.maxDownloadBytes);
        applyProgress(job, {
          providerId: route.providerId,
          taskId: generated.taskId,
          status: "succeeded",
          videoUrl: generated.videoUrl,
        });
        await writeJobs(jobsPath, jobs);
        replaceSceneAsset(assets, scene, generated.taskId, generated.videoUrl, clipPath, route.providerId);
        mediaArtifacts.push(await describeFile(
          clipPath,
          "media_asset",
          "video/mp4",
          route.providerId,
          request,
          "AI-generated video selected by the director plan; review terms, likeness rights, and AIGC disclosure.",
        ));
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        await writeJobs(jobsPath, jobs);
      }
    }

    const generatedScenes = jobs.filter((job) => job.status === "succeeded").length;
    plan.scene_assets = assets;
    plan.generation = {
      providerId: "ai-shot-router-v1",
      directorPlanPath,
      maxPaidShots,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes: jobs.length - generatedScenes,
      estimatedCostCny: estimatedCost,
      jobsPath,
      localBaselinePreserved: true,
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
        fallbackScenes: jobs.length - generatedScenes,
        estimatedCostCny: estimatedCost,
      },
    };
  }
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

function generationRequest(scene: ScriptScene, prompt = scene.visualPrompt): VideoGenerationRequest {
  return {
    prompt,
    durationSeconds: Math.max(4, Math.min(15, Math.round(scene.duration))),
    ratio: "9:16",
  };
}

function parseRoutedShots(value: unknown): RoutedShot[] {
  if (!Array.isArray(value)) throw new Error("Director plan shots must be an array.");
  return value.map((entry, index) => {
    const shot = requiredRecord(entry, `Director shot ${index + 1}`);
    return {
      scenePosition: boundedInteger(shot.scenePosition, `Director shot ${index + 1} scenePosition`, 1, 10_000),
      providerId: requiredString(shot.preferredProviderId, `Director shot ${index + 1} preferredProviderId`),
      generationPrompt: typeof shot.generationPrompt === "string" && shot.generationPrompt.trim()
        ? shot.generationPrompt.trim()
        : "",
    };
  });
}

function applyProgress(job: GenerationJob, progress: VideoGenerationProgress): void {
  job.taskId = progress.taskId;
  job.status = progress.status;
  if (progress.videoUrl) job.videoUrl = progress.videoUrl;
  if (progress.error) job.error = progress.error;
}

function replaceSceneAsset(
  assets: unknown[],
  scene: ScriptScene,
  taskId: string,
  videoUrl: string,
  clipPath: string,
  providerId: string,
): void {
  const next = {
    scene_position: scene.position,
    provider: providerId,
    asset_id: taskId,
    media_type: "video",
    width: 720,
    height: 1280,
    duration: scene.duration,
    local_path: clipPath,
    source_url: videoUrl,
    creator: providerId,
    license_note: "AI-generated video; provider terms and AIGC disclosure apply.",
    query: scene.visualPrompt,
  };
  const index = assets.findIndex((asset) => {
    return typeof asset === "object" && asset !== null && !Array.isArray(asset)
      && Number((asset as Record<string, unknown>).scene_position) === scene.position;
  });
  if (index >= 0) assets[index] = next;
  else assets.push(next);
}

async function downloadVideo(fetcher: FetchLike, url: string, destination: string, maxBytes: number): Promise<void> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Generated video download failed with status ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Generated video exceeds the ${maxBytes}-byte download limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Generated video exceeds the ${maxBytes}-byte download limit.`);
  }
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
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
