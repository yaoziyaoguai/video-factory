export type VideoAspectRatio = "9:16" | "16:9" | "1:1" | "3:4" | "4:3";

export interface VideoGenerationRequest {
  prompt: string;
  durationSeconds: number;
  ratio: VideoAspectRatio;
  modelId?: string;
  resolution?: "480p" | "720p" | "1080p" | "480P" | "720P" | "768P" | "1080P" | "2K";
  generateAudio?: boolean;
}

export interface VideoGenerationResult {
  providerId: string;
  taskId: string;
  videoUrl: string;
}

export interface VideoGenerationProgress {
  providerId: string;
  taskId: string;
  status: "submitted" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  error?: string;
}

export interface VideoGenerationAdapter {
  readonly providerId: string;
  generate(
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

interface AsyncAdapterOptions {
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface SeedanceVideoAdapterOptions extends AsyncAdapterOptions {
  baseUrl?: string;
  allowedModels?: string[];
}

export class SeedanceVideoAdapter implements VideoGenerationAdapter {
  readonly providerId = "seedance-video-v1";
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: SeedanceVideoAdapterOptions) {
    validateOptions(options);
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3");
  }

  async generate(
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult> {
    validateRequest(request);
    const model = resolveRequestedModel(request.modelId, this.options.model, this.options.allowedModels);
    const submitted = await requestJson(this.fetch, `${this.baseUrl}/contents/generations/tasks`, {
      method: "POST",
      headers: authHeaders(this.options.apiKey),
      body: JSON.stringify({
        model,
        content: [{ type: "text", text: request.prompt }],
        ratio: request.ratio,
        duration: request.durationSeconds,
        watermark: false,
        generate_audio: request.generateAudio ?? false,
        ...(request.resolution ? { resolution: request.resolution } : {}),
      }),
    });
    const taskId = requiredString(submitted.id, "Seedance task id");
    await onProgress?.({ providerId: this.providerId, taskId, status: "submitted" });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.timeoutMs) {
      const task = await requestJson(this.fetch, `${this.baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        headers: authHeaders(this.options.apiKey),
      });
      const status = requiredString(task.status, "Seedance task status");
      if (status === "succeeded") {
        const content = requiredRecord(task.content, "Seedance task content");
        const videoUrl = requiredHttpUrl(content.video_url, "Seedance video URL");
        await onProgress?.({ providerId: this.providerId, taskId, status: "succeeded", videoUrl });
        return { providerId: this.providerId, taskId, videoUrl };
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        const message = providerError(task.error, `Seedance task ended with status '${status}'.`);
        await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
        throw new Error(message);
      }
      await onProgress?.({ providerId: this.providerId, taskId, status: "running" });
      await this.sleep(this.pollIntervalMs);
    }
    const message = `Seedance task '${taskId}' timed out after ${this.timeoutMs}ms.`;
    await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
    throw new Error(message);
  }
}

function resolveRequestedModel(requested: string | undefined, fallback: string, allowed: string[] | undefined): string {
  const model = requested?.trim() || fallback;
  if (allowed && !allowed.includes(model)) {
    throw new Error(`Video model '${model}' is not allowed for this provider.`);
  }
  return model;
}

export interface MiniMaxVideoAdapterOptions extends AsyncAdapterOptions {
  baseUrl?: string;
  modelProtocols?: Record<string, "v1" | "v2">;
}

export class MiniMaxVideoAdapter implements VideoGenerationAdapter {
  readonly providerId = "hailuo-video-v1";
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly apiRoot: string;

  constructor(private readonly options: MiniMaxVideoAdapterOptions) {
    validateOptions(options);
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.apiRoot = miniMaxApiRoot(options.baseUrl ?? "https://api.minimaxi.com");
  }

  async generate(
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult> {
    validateRequest(request);
    const model = resolveMiniMaxModel(request.modelId, this.options.model, this.options.modelProtocols);
    return this.options.modelProtocols?.[model] === "v2"
      ? this.generateV2(model, request, onProgress)
      : this.generateV1(model, request, onProgress);
  }

  private async generateV1(
    model: string,
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult> {
    const submitted = await requestJson(this.fetch, `${this.apiRoot}/v1/video_generation`, {
      method: "POST",
      headers: authHeaders(this.options.apiKey),
      body: JSON.stringify({
        model,
        prompt: miniMaxPrompt(request),
        duration: request.durationSeconds,
        resolution: normalizeMiniMaxResolution(request.resolution ?? "768P"),
        prompt_optimizer: true,
        aigc_watermark: false,
      }),
    });
    assertMiniMaxSuccess(submitted);
    const taskId = requiredString(submitted.task_id, "MiniMax task id");
    await onProgress?.({ providerId: this.providerId, taskId, status: "submitted" });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.timeoutMs) {
      const queryUrl = new URL(`${this.apiRoot}/v1/query/video_generation`);
      queryUrl.searchParams.set("task_id", taskId);
      const task = await requestJson(this.fetch, queryUrl.toString(), { headers: authHeaders(this.options.apiKey) });
      assertMiniMaxSuccess(task);
      const status = requiredString(task.status, "MiniMax task status");
      if (status === "Success") {
        const fileId = requiredString(task.file_id, "MiniMax file id");
        const fileUrl = new URL(`${this.apiRoot}/v1/files/retrieve`);
        fileUrl.searchParams.set("file_id", fileId);
        const retrieved = await requestJson(this.fetch, fileUrl.toString(), { headers: authHeaders(this.options.apiKey) });
        assertMiniMaxSuccess(retrieved);
        const file = requiredRecord(retrieved.file, "MiniMax file");
        const videoUrl = requiredHttpUrl(file.download_url, "MiniMax video URL");
        await onProgress?.({ providerId: this.providerId, taskId, status: "succeeded", videoUrl });
        return { providerId: this.providerId, taskId, videoUrl };
      }
      if (status === "Fail") {
        const message = miniMaxError(task, `MiniMax task '${taskId}' failed.`);
        await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
        throw new Error(message);
      }
      await onProgress?.({ providerId: this.providerId, taskId, status: "running" });
      await this.sleep(this.pollIntervalMs);
    }
    const message = `MiniMax task '${taskId}' timed out after ${this.timeoutMs}ms.`;
    await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
    throw new Error(message);
  }

  private async generateV2(
    model: string,
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult> {
    const submitted = await requestJson(this.fetch, `${this.apiRoot}/v2/video_generation`, {
      method: "POST",
      headers: authHeaders(this.options.apiKey),
      body: JSON.stringify({
        model,
        content: [{ type: "text", text: request.prompt }],
        resolution: normalizeMiniMaxResolution(request.resolution ?? "768P"),
        duration: request.durationSeconds,
        ratio: request.ratio,
        aigc_watermark: false,
      }),
    });
    const taskId = requiredString(submitted.task_id, "MiniMax H3 task id");
    await onProgress?.({ providerId: this.providerId, taskId, status: "submitted" });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.timeoutMs) {
      const response = await requestJson(
        this.fetch,
        `${this.apiRoot}/v2/query/video_generation/${encodeURIComponent(taskId)}`,
        { headers: authHeaders(this.options.apiKey) },
      );
      const task = requiredRecord(response.task, "MiniMax H3 task");
      const status = requiredString(task.status, "MiniMax H3 task status");
      if (status === "succeeded") {
        const content = requiredRecord(task.content, "MiniMax H3 task content");
        const videoUrl = requiredHttpUrl(content.url, "MiniMax H3 video URL");
        await onProgress?.({ providerId: this.providerId, taskId, status: "succeeded", videoUrl });
        return { providerId: this.providerId, taskId, videoUrl };
      }
      if (status === "failed" || status === "cancelled") {
        const message = providerError(task.error, `MiniMax H3 task '${taskId}' ended with status '${status}'.`);
        await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
        throw new Error(message);
      }
      await onProgress?.({ providerId: this.providerId, taskId, status: "running" });
      await this.sleep(this.pollIntervalMs);
    }
    const message = `MiniMax H3 task '${taskId}' timed out after ${this.timeoutMs}ms.`;
    await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
    throw new Error(message);
  }
}

export interface WanVideoAdapterOptions extends AsyncAdapterOptions {
  workspaceId: string;
  baseUrl?: string;
  allowedModels?: string[];
}

export class WanVideoAdapter implements VideoGenerationAdapter {
  readonly providerId = "wan-video-v1";
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: WanVideoAdapterOptions) {
    validateOptions(options);
    if (!options.workspaceId.trim()) {
      throw new Error("Wan workspaceId is required.");
    }
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? `https://${encodeURIComponent(options.workspaceId)}.cn-beijing.maas.aliyuncs.com`,
    );
  }

  async generate(
    request: VideoGenerationRequest,
    onProgress?: (progress: VideoGenerationProgress) => Promise<void> | void,
  ): Promise<VideoGenerationResult> {
    validateRequest(request);
    const model = resolveRequestedModel(request.modelId, this.options.model, this.options.allowedModels);
    const submitted = await requestJson(
      this.fetch,
      `${this.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
      {
        method: "POST",
        headers: { ...authHeaders(this.options.apiKey), "X-DashScope-Async": "enable" },
        body: JSON.stringify({
          model,
          input: { prompt: request.prompt },
          parameters: {
            resolution: "720P",
            ratio: request.ratio,
            duration: request.durationSeconds,
            ...(model.startsWith("wan3.0-") ? {} : { prompt_extend: true }),
            watermark: false,
          },
        }),
      },
    );
    const submittedOutput = requiredRecord(submitted.output, "Wan task output");
    const taskId = requiredString(submittedOutput.task_id, "Wan task id");
    await onProgress?.({ providerId: this.providerId, taskId, status: "submitted" });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.timeoutMs) {
      const task = await requestJson(this.fetch, `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: authHeaders(this.options.apiKey),
      });
      const output = requiredRecord(task.output, "Wan task output");
      const status = requiredString(output.task_status, "Wan task status");
      if (status === "SUCCEEDED") {
        const videoUrl = requiredHttpUrl(output.video_url, "Wan video URL");
        await onProgress?.({ providerId: this.providerId, taskId, status: "succeeded", videoUrl });
        return { providerId: this.providerId, taskId, videoUrl };
      }
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        const message = providerError(output, `Wan task ended with status '${status}'.`);
        await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
        throw new Error(message);
      }
      await onProgress?.({ providerId: this.providerId, taskId, status: "running" });
      await this.sleep(this.pollIntervalMs);
    }
    const message = `Wan task '${taskId}' timed out after ${this.timeoutMs}ms.`;
    await onProgress?.({ providerId: this.providerId, taskId, status: "failed", error: message });
    throw new Error(message);
  }
}

function validateOptions(options: AsyncAdapterOptions): void {
  if (!options.apiKey.trim()) {
    throw new Error("Video generation apiKey is required.");
  }
  if (!options.model.trim()) {
    throw new Error("Video generation model is required.");
  }
  if (options.pollIntervalMs !== undefined && (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 0)) {
    throw new Error("pollIntervalMs must be a non-negative integer.");
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error("timeoutMs must be a positive integer.");
  }
}

function validateRequest(request: VideoGenerationRequest): void {
  if (!request.prompt.trim()) {
    throw new Error("Video generation prompt is required.");
  }
  if (!Number.isInteger(request.durationSeconds) || request.durationSeconds < 2 || request.durationSeconds > 15) {
    throw new Error("Video generation durationSeconds must be an integer between 2 and 15.");
  }
}

function miniMaxPrompt(request: VideoGenerationRequest): string {
  const composition = request.ratio === "9:16" ? "竖屏 9:16 构图。" : `${request.ratio} 构图。`;
  return `${composition}${request.prompt}`;
}

function resolveMiniMaxModel(
  requested: string | undefined,
  fallback: string,
  protocols: Record<string, "v1" | "v2"> | undefined,
): string {
  const model = requested?.trim() || fallback;
  if (protocols && protocols[model] === undefined) {
    throw new Error(`Video model '${model}' is not allowed for MiniMax.`);
  }
  return model;
}

function normalizeMiniMaxResolution(resolution: NonNullable<VideoGenerationRequest["resolution"]>): string {
  return resolution === "2K" ? resolution : resolution.toUpperCase();
}

function miniMaxApiRoot(value: string): string {
  return stripTrailingSlash(value).replace(/\/v[12]$/i, "");
}

function assertMiniMaxSuccess(value: Record<string, unknown>): void {
  if (value.base_resp === undefined) return;
  const baseResponse = requiredRecord(value.base_resp, "MiniMax base response");
  if (baseResponse.status_code !== 0) {
    throw new Error(miniMaxError(value, "MiniMax request failed."));
  }
}

function miniMaxError(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.base_resp === "object" && value.base_resp !== null && !Array.isArray(value.base_resp)) {
    const statusMessage = (value.base_resp as Record<string, unknown>).status_msg;
    if (typeof statusMessage === "string" && statusMessage.trim() && statusMessage !== "success") {
      return statusMessage.trim();
    }
  }
  return providerError(value, fallback);
}

async function requestJson(fetcher: FetchLike, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Video provider returned invalid JSON with status ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(providerError(value, `Video provider request failed with status ${response.status}.`));
  }
  return requiredRecord(value, "Video provider response");
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value.trim();
}

function requiredHttpUrl(value: unknown, label: string): string {
  const url = requiredString(value, label);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return url;
}

function providerError(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "object" && record.error !== null && !Array.isArray(record.error)) {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === "string" && error.message.trim()) {
        return error.message.trim();
      }
    }
  }
  return fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
