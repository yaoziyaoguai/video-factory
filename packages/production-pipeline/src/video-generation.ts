export type VideoAspectRatio = "9:16" | "16:9" | "1:1" | "3:4" | "4:3";

export interface VideoGenerationRequest {
  prompt: string;
  durationSeconds: number;
  ratio: VideoAspectRatio;
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
    const submitted = await requestJson(this.fetch, `${this.baseUrl}/contents/generations/tasks`, {
      method: "POST",
      headers: authHeaders(this.options.apiKey),
      body: JSON.stringify({
        model: this.options.model,
        content: [{ type: "text", text: request.prompt }],
        ratio: request.ratio,
        duration: request.durationSeconds,
        watermark: false,
        generate_audio: false,
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

export interface WanVideoAdapterOptions extends AsyncAdapterOptions {
  workspaceId: string;
  baseUrl?: string;
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
    const submitted = await requestJson(
      this.fetch,
      `${this.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
      {
        method: "POST",
        headers: { ...authHeaders(this.options.apiKey), "X-DashScope-Async": "enable" },
        body: JSON.stringify({
          model: this.options.model,
          input: { prompt: request.prompt },
          parameters: {
            resolution: "720P",
            ratio: request.ratio,
            duration: request.durationSeconds,
            prompt_extend: true,
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
