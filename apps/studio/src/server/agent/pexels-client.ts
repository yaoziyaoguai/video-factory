import type { MaterialCandidate } from "../../shared/agent/generated/contracts.js";
import { PEXELS_API_ENDPOINT } from "./free-service-settings.js";
import { downloadWithinBounds, fetchApiJson, StockUnavailableError, stockValueHelpers } from "./stock-http.js";
import type { StockCandidateInput } from "./stock-providers.js";

// Pexels API 的边界适配：响应在这里一次性解析为受控类型，之后只传 typed 数据。
// Authorization 只发往固定 API 入口；媒体下载走固定域名集合（含重定向），不携带 Key。
// 传输纪律与其它免费素材来源共用 stock-http；本文件只保留 Pexels 的解析事实。

/** 服务端私有的可采用候选：下载地址只存在 material_candidates，不进入模型可见结构。 */
export type PexelsCandidateInput = StockCandidateInput;

const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";
const TARGET_PIXELS = 1280 * 720;
/** 官方 API 文档所示文件/预览域名；重定向仍逐跳校验，不开放任意下载地址。 */
export const PEXELS_MEDIA_HOSTS = new Set(["images.pexels.com", "videos.pexels.com", "static-videos.pexels.com", "player.vimeo.com"]);

interface HttpFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface CapturedPexelsClientConfig {
  enabled: boolean;
  apiKey: string | null;
}

export class PexelsClient {
  constructor(
    private readonly config: CapturedPexelsClientConfig,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  private requireEnabled(): string {
    if (!this.config.enabled || this.config.apiKey == null) {
      throw new StockUnavailableError("Pexels 素材服务未启用，请在设置里配置并启用。");
    }
    return this.config.apiKey;
  }

  async search(input: { query: string; kind: "image" | "video"; limit: number; newCandidateId: () => string }, signal?: AbortSignal): Promise<PexelsCandidateInput[]> {
    const apiKey = this.requireEnabled();
    const query = `query=${encodeURIComponent(input.query)}&per_page=${input.limit}&page=1`;
    const payload = await fetchApiJson({
      url: `${PEXELS_API_ENDPOINT}${input.kind === "image" ? "/search" : "/videos/search"}?${query}`,
      label: "Pexels", headers: { authorization: apiKey }, fetchImpl: this.fetchImpl, signal,
    });
    const items = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)[input.kind === "image" ? "photos" : "videos"] : undefined;
    if (!Array.isArray(items)) throw new StockUnavailableError("Pexels 响应格式不可识别。");
    return items.slice(0, input.limit).flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      return input.kind === "image" ? photoCandidate(item as Record<string, unknown>, input.newCandidateId)
        : videoCandidate(item as Record<string, unknown>, input.newCandidateId);
    });
  }

  /** 受控下载：固定媒体域名（含每次重定向）、字节上限、回调式落盘。 */
  async download(url: string, maxBytes: number, sink: (stream: ReadableStream<Uint8Array>, response: Response) => Promise<void>, signal?: AbortSignal): Promise<void> {
    return downloadWithinBounds({ url, rules: { mediaHosts: PEXELS_MEDIA_HOSTS }, maxBytes, fetchImpl: this.fetchImpl, signal }, sink);
  }
}

// —— 供应商响应 → 受控候选（一次边界校验） ——

const { asUrl, asPositiveInt, asText } = stockValueHelpers;

function photoCandidate(photo: Record<string, unknown>, newCandidateId: () => string): PexelsCandidateInput[] {
  const id = typeof photo.id === "number" ? String(photo.id) : null;
  const src = photo.src as Record<string, unknown> | undefined;
  const downloadUrl = asUrl(src?.original);
  const sourceUrl = asUrl(photo.url);
  const creatorName = asText(photo.photographer, 200);
  const creatorUrl = asUrl(photo.photographer_url);
  const previewUrl = asUrl(src?.medium) ?? asUrl(src?.small) ?? downloadUrl;
  const width = asPositiveInt(photo.width);
  const height = asPositiveInt(photo.height);
  if (!id || !downloadUrl || !sourceUrl || !creatorName || !creatorUrl || !previewUrl || !width || !height) return [];
  const candidateId = newCandidateId();
  return [{
    candidateId,
    candidate: {
      candidateId, provider: "pexels", providerAssetId: id, kind: "image",
      title: asText(photo.alt, 300) ?? `Pexels 图片 ${id}`,
      sourceUrl, creatorName, creatorUrl, previewUrl, width, height, durationMs: null,
      licenseUrl: PEXELS_LICENSE_URL,
    },
    downloadUrl,
  }];
}

function videoCandidate(video: Record<string, unknown>, newCandidateId: () => string): PexelsCandidateInput[] {
  const id = typeof video.id === "number" ? String(video.id) : null;
  const sourceUrl = asUrl(video.url);
  const user = video.user as Record<string, unknown> | undefined;
  const creatorName = asText(user?.name, 200);
  const creatorUrl = asUrl(user?.url);
  const previewUrl = asUrl(video.image);
  const durationSeconds = typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0
    ? Math.round(video.duration * 1000) : null;
  if (!id || !sourceUrl || !creatorName || !creatorUrl || !previewUrl || !durationSeconds) return [];
  const variant = selectVideoFile(video.video_files);
  if (!variant) return [];
  const candidateId = newCandidateId();
  return [{
    candidateId,
    candidate: {
      candidateId, provider: "pexels", providerAssetId: id, kind: "video",
      title: `Pexels 视频 ${id}`,
      sourceUrl, creatorName, creatorUrl, previewUrl,
      width: variant.width, height: variant.height, durationMs: durationSeconds,
      licenseUrl: PEXELS_LICENSE_URL,
    },
    downloadUrl: variant.link,
  }];
}

interface EligibleVideoFile { link: string; width: number; height: number }

/** 真正的 mp4（排除 HLS 列表）、长边≤1920/短边≤1080、域名在固定集合内，最接近 1280×720 像素量。 */
function selectVideoFile(value: unknown): EligibleVideoFile | null {
  if (!Array.isArray(value)) return null;
  let best: EligibleVideoFile | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    if (item.file_type !== "video/mp4") continue;
    const link = asUrl(item.link);
    const width = asPositiveInt(item.width);
    const height = asPositiveInt(item.height);
    if (!link || !width || !height) continue;
    if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) continue;
    const url = new URL(link);
    if (url.protocol !== "https:" || !PEXELS_MEDIA_HOSTS.has(url.host)) continue;
    const distance = Math.abs(width * height - TARGET_PIXELS);
    if (distance < bestDistance) { bestDistance = distance; best = { link, width, height }; }
  }
  return best;
}
