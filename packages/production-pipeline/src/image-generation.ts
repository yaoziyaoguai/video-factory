import { createHash } from "node:crypto";

export type ImageAspectRatio = "9:16" | "16:9" | "1:1" | "3:4" | "4:3";

export interface ImageGenerationRequest {
  prompt: string;
  ratio: ImageAspectRatio;
}

export interface ImageGenerationResult {
  providerId: string;
  taskId: string;
  imageUrl: string;
}

export interface ImageGenerationProgress {
  providerId: string;
  taskId: string;
  status: "submitted" | "running" | "succeeded" | "failed";
  imageUrl?: string;
  error?: string;
}

export interface ImageGenerationAdapter {
  readonly providerId: string;
  generate(
    request: ImageGenerationRequest,
    onProgress?: (progress: ImageGenerationProgress) => Promise<void> | void,
  ): Promise<ImageGenerationResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SeedreamImageAdapterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export class SeedreamImageAdapter implements ImageGenerationAdapter {
  readonly providerId = "seedream-image-v1";
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(private readonly options: SeedreamImageAdapterOptions) {
    if (!options.apiKey.trim()) throw new Error("Image generation apiKey is required.");
    if (!options.model.trim()) throw new Error("Image generation model is required.");
    this.baseUrl = (options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  async generate(
    request: ImageGenerationRequest,
    onProgress?: (progress: ImageGenerationProgress) => Promise<void> | void,
  ): Promise<ImageGenerationResult> {
    if (!request.prompt.trim()) throw new Error("Image generation prompt is required.");
    const response = await this.fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        prompt: request.prompt,
        size: imageSize(request.ratio),
        sequential_image_generation: "disabled",
        response_format: "url",
        watermark: false,
      }),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Seedream returned invalid JSON with status ${response.status}.`);
    }
    const record = requiredRecord(value, "Seedream response");
    if (!response.ok) {
      throw new Error(providerError(record, `Seedream request failed with status ${response.status}.`));
    }
    if (!Array.isArray(record.data) || record.data.length === 0) {
      throw new Error("Seedream image data is missing.");
    }
    const image = requiredRecord(record.data[0], "Seedream image data");
    const imageUrl = requiredHttpUrl(image.url, "Seedream image URL");
    const created = typeof record.created === "number" && Number.isFinite(record.created)
      ? Math.trunc(record.created)
      : Date.now();
    const digest = createHash("sha256").update(`${request.prompt}\0${imageUrl}`).digest("hex").slice(0, 12);
    const taskId = `seedream-${created}-${digest}`;
    await onProgress?.({ providerId: this.providerId, taskId, status: "succeeded", imageUrl });
    return { providerId: this.providerId, taskId, imageUrl };
  }
}

function imageSize(ratio: ImageAspectRatio): string {
  const sizes: Record<ImageAspectRatio, string> = {
    "9:16": "1440x2560",
    "16:9": "2560x1440",
    "1:1": "2048x2048",
    "3:4": "1728x2304",
    "4:3": "2304x1728",
  };
  return sizes[ratio];
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return value.trim();
}

function providerError(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.error === "object" && value.error !== null && !Array.isArray(value.error)) {
    const message = (value.error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return fallback;
}
