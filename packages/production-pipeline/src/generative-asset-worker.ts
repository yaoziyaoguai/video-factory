import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
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
}

export interface ImageGenerationAdapterBinding {
  adapter: ImageGenerationAdapter;
  estimatedCnyPerImage: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GenerativeAssetWorkerClientOptions {
  fallback: WorkerClient;
  adapters: VideoGenerationAdapterBinding[];
  imageAdapters?: ImageGenerationAdapterBinding[];
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
  mediaType: "image" | "video";
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
  generate(
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

export class GenerativeAssetWorkerClient implements WorkerClient {
  private readonly adapters = new Map<string, VideoGenerationAdapterBinding>();
  private readonly imageAdapters = new Map<string, ImageGenerationAdapterBinding>();
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
    for (const binding of options.imageAdapters ?? []) {
      if (!Number.isFinite(binding.estimatedCnyPerImage) || binding.estimatedCnyPerImage <= 0) {
        throw new Error(`Adapter '${binding.adapter.providerId}' must have a positive estimatedCnyPerImage.`);
      }
      if (this.adapters.has(binding.adapter.providerId) || this.imageAdapters.has(binding.adapter.providerId)) {
        throw new Error(`Adapter '${binding.adapter.providerId}' is already configured.`);
      }
      this.imageAdapters.set(binding.adapter.providerId, binding);
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
    const binding = this.resolveBinding(providerId);
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
      };
      jobs.push(job);
      try {
        const generated = await binding.generate(
          scene,
          scene.visualPrompt,
          async (progress) => {
            applyProgress(job, progress);
            await writeJobs(jobsPath, jobs);
          },
        );
        const media = await downloadGeneratedAsset(
          this.fetch,
          generated.url,
          path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${providerId}`),
          binding.mediaType,
          this.maxDownloadBytes,
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
    plan.scene_assets = assets;
    plan.generation = {
      providerId,
      maxPaidShots,
      attemptedScenes: jobs.length,
      generatedScenes,
      fallbackScenes,
      estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerAsset),
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
        estimatedCostCny: roundMoney(jobs.length * binding.estimatedCnyPerAsset),
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
      const providerId = route.providerIds.find((candidate) => this.resolveBinding(candidate));
      const binding = providerId ? this.resolveBinding(providerId) : undefined;
      if (!providerId || !binding) {
        const hasLocalFallback = route.providerIds.some((candidate) => !KNOWN_METERED_ASSET_PROVIDERS.has(candidate));
        const unconfiguredMetered = route.providerIds.find((candidate) => KNOWN_METERED_ASSET_PROVIDERS.has(candidate));
        if (unconfiguredMetered && !hasLocalFallback) {
          throw new Error(`AI director selected unconfigured metered provider '${unconfiguredMetered}'.`);
        }
        return [];
      }
      const scene = sceneByPosition.get(route.scenePosition);
      if (!scene) throw new Error(`AI director selected unknown script scene ${route.scenePosition}.`);
      return [{ route, scene, binding, providerId }];
    });
    if (generatedRoutes.length > maxPaidShots) {
      throw new Error(`AI director selected ${generatedRoutes.length} paid shots, exceeding the limit ${maxPaidShots}.`);
    }
    const estimatedCost = roundMoney(generatedRoutes.reduce((sum, item) => sum + item.binding.estimatedCnyPerAsset, 0));
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

    for (const { route, scene, binding, providerId } of generatedRoutes) {
      const job: GenerationJob = {
        scenePosition: scene.position,
        providerId,
        status: "submitted",
        estimatedCostCny: binding.estimatedCnyPerAsset,
        mediaType: binding.mediaType,
      };
      jobs.push(job);
      try {
        const generated = await binding.generate(
          scene,
          compileGenerationPrompt(providerId, route, scene),
          async (progress) => {
            applyProgress(job, progress);
            await writeJobs(jobsPath, jobs);
          },
        );
        const media = await downloadGeneratedAsset(
          this.fetch,
          generated.url,
          path.join(outputDir, `scene_${String(scene.position).padStart(2, "0")}_${providerId}`),
          binding.mediaType,
          this.maxDownloadBytes,
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

  private resolveBinding(providerId: string): ResolvedAssetBinding | undefined {
    const video = this.adapters.get(providerId);
    if (video) {
      return {
        mediaType: "video",
        estimatedCnyPerAsset: video.estimatedCnyPerClip,
        generate: async (scene, prompt, onProgress) => {
          const result = await video.adapter.generate(generationRequest(scene, prompt), onProgress);
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

function applyProgress(job: GenerationJob, progress: VideoGenerationProgress | ImageGenerationProgress): void {
  job.taskId = progress.taskId;
  job.status = progress.status;
  if ("videoUrl" in progress && progress.videoUrl) job.videoUrl = progress.videoUrl;
  if ("imageUrl" in progress && progress.imageUrl) job.imageUrl = progress.imageUrl;
  if (progress.error) job.error = progress.error;
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
  fetcher: FetchLike,
  url: string,
  destinationStem: string,
  mediaType: "image" | "video",
  maxBytes: number,
): Promise<{ path: string; contentType: string }> {
  let currentUrl = validatedMediaUrl(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetcher(currentUrl, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error(`Generated ${mediaType} redirect did not include a location.`);
    if (redirects === 5) throw new Error(`Generated ${mediaType} download exceeded the redirect limit.`);
    currentUrl = validatedMediaUrl(new URL(location, currentUrl).toString());
  }
  if (!response) throw new Error(`Generated ${mediaType} download did not return a response.`);
  if (!response.ok) {
    throw new Error(`Generated ${mediaType} download failed with status ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Generated ${mediaType} exceeds the ${maxBytes}-byte download limit.`);
  }
  const bytes = await readLimitedBody(response, mediaType, maxBytes);
  const rawContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentType = validatedMediaContentType(mediaType, rawContentType);
  const extension = mediaType === "video" ? "mp4" : imageExtension(contentType);
  const destination = `${destinationStem}.${extension}`;
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return { path: destination, contentType };
}

function validatedMediaUrl(value: string): string {
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
  return url.toString();
}

function isBlockedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || first! >= 224
      || first === 169 && second === 254
      || first === 172 && second! >= 16 && second! <= 31
      || first === 192 && (second === 0 || second === 168)
      || first === 198 && (second === 18 || second === 19)
      || first === 100 && second! >= 64 && second! <= 127;
  }
  if (isIP(host) === 6) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
      || /^fe[89ab]/.test(host) || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.");
  }
  return false;
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
    if (value && value !== "video/mp4" && value !== "application/octet-stream") {
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
