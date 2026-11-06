import type { MaterialCandidate, MaterialProvider } from "../../shared/agent/generated/contracts.js";
import { FREE_SERVICE_LABELS, type CapturedStockConfig } from "./free-service-settings.js";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "./material-store.js";
import { PexelsClient, PEXELS_MEDIA_HOSTS } from "./pexels-client.js";
import { cachedPixabayResponse } from "./stock-cache.js";
import {
  downloadWithinBounds, fetchApiJson, StockKindUnsupportedError, StockUnavailableError, stockValueHelpers, type HttpFetch,
} from "./stock-http.js";

// 免费素材来源注册表：每个来源只声明自己真实适配的类型、固定媒体域名与解析事实；
// 解析规则移植自旧版 VideoFactory 的对应 provider（stock_assets/wikimedia/open_stock/archive_stock），
// 只开放本管线能真实处理的封装（JPEG/PNG 图片、MP4/WebM 视频、MP3 音频）。

const { asUrl, asPositiveInt, asPositiveSeconds, asText, asHtmlText } = stockValueHelpers;

export type StockKind = MaterialCandidate["kind"];

/** FreeToUse 采用时核对的详情；必要事实随该候选首次采用保存，不保留整份供应商响应。 */
export interface StockImportDetails {
  candidate: Omit<MaterialCandidate, "candidateId">;
  downloadUrl: string;
  sourceFacts: {
    isPremium: false;
    artists: [number, { id: string; name: string }][];
    lyrics: string | null;
    durationSeconds: number;
    instrumentalTag: boolean;
  };
}

/** 服务端私有的可采用候选：下载地址只存在 material_candidates，不进入模型可见结构。 */
export interface StockCandidateInput {
  candidateId: string;
  candidate: MaterialCandidate;
  downloadUrl: string;
  /** Unsplash 采用追踪地址；只在采用时调用，不随候选进入模型可见输出。 */
  trackingUrl?: string;
}

export interface StockAdapterContext {
  apiKey: string | null;
  fetchImpl: HttpFetch;
  cacheRoot: string | null;
}

export interface StockProviderAdapter {
  id: MaterialProvider;
  label: string;
  kinds: readonly StockKind[];
  keyed: boolean;
  mediaHosts: ReadonlySet<string>;
  /** Internet Archive 的官方下载节点在 archive.org 子域上，另给固定判定规则。 */
  isAllowedHost?: (host: string) => boolean;
  search(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]>;
  /** 采用前核对详情或执行 Unsplash 追踪；失败则不下载媒体。 */
  prepareImport?(input: { providerAssetId: string; trackingUrl: string | undefined }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockImportDetails | void>;
}

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

function requireKind(adapter: { label: string; kinds: readonly StockKind[] }, kind: StockKind): void {
  if (!adapter.kinds.includes(kind)) {
    const supported = adapter.kinds.map(item => item === "image" ? "图片" : item === "video" ? "视频" : "音频").join("和");
    throw new StockKindUnsupportedError(`${adapter.label} 只提供${supported}素材。`);
  }
}

async function getJson(url: string, label: string, ctx: StockAdapterContext, headers: Record<string, string> | undefined, signal?: AbortSignal): Promise<unknown> {
  return fetchApiJson({ url, label, headers, fetchImpl: ctx.fetchImpl, signal });
}

// —— Pixabay（Keyed；图片+视频；API 响应按条款缓存 24h） ——

// 图片的 largeImageURL/webformatURL 现由 pixabay.com 主域直出（官方 get 链接），视频与预览仍在 cdn。
const PIXABAY_MEDIA_HOSTS = new Set(["cdn.pixabay.com", "pixabay.com"]);

async function searchPixabay(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({ key: ctx.apiKey!, q: req.query, per_page: String(Math.max(req.limit, 3)), safesearch: "true" });
  if (req.kind === "image") params.set("image_type", "photo");
  const url = req.kind === "image" ? `https://pixabay.com/api/?${params}` : `https://pixabay.com/api/videos/?${params}`;
  const payload = await cachedPixabayResponse(url, () => getJson(url, "Pixabay", ctx, { accept: "application/json" }, signal), ctx.cacheRoot);
  const hits = (payload as Record<string, unknown>).hits;
  if (!Array.isArray(hits)) throw new StockUnavailableError("Pixabay 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  for (const item of hits) {
    if (!item || typeof item !== "object") continue;
    const hit = item as Record<string, unknown>;
    const id = asText(String(hit.id ?? ""), 100);
    if (!id || !/^[1-9][0-9]*$/.test(id)) continue;
    const sourceUrl = asUrl(hit.pageURL);
    const creatorName = asText(hit.user, 200);
    if (!sourceUrl || !creatorName) continue;
    const candidateId = req.newCandidateId();
    if (req.kind === "image") {
      const webformatUrl = asUrl(hit.webformatURL);
      const webformatWidth = asPositiveInt(hit.webformatWidth);
      const webformatHeight = asPositiveInt(hit.webformatHeight);
      // 保留既有 large 档位；webformat 的尺寸不能成为降档理由，也不能冒充 large 的实测值。
      const downloadUrl = asUrl(hit.largeImageURL) ?? webformatUrl;
      const useWebformat = downloadUrl === webformatUrl && webformatWidth !== null && webformatHeight !== null;
      const previewUrl = asUrl(hit.previewURL);
      const width = useWebformat ? webformatWidth : asPositiveInt(hit.imageWidth);
      const height = useWebformat ? webformatHeight : asPositiveInt(hit.imageHeight);
      if (!downloadUrl || !previewUrl) continue;
      out.push({
        candidateId,
        candidate: {
          candidateId, provider: "pixabay", providerAssetId: id, kind: "image",
          title: asText(hit.tags, 300) ?? `Pixabay 图片 ${id}`,
          sourceUrl, creatorName, creatorUrl: null, previewUrl,
          // 原图尺寸只说明来源；只有 API 给出该 webformat 的完整尺寸对才标为可采用尺寸。
          ...(width !== null && height !== null
            ? { width, height, dimensionsKind: useWebformat ? "download" as const : "source" as const }
            : { width: null, height: null }),
          durationMs: null, licenseUrl: "https://pixabay.com/service/license-summary/",
        },
        downloadUrl,
      });
    } else {
      const variants = hit.videos as Record<string, unknown> | undefined;
      const best = pickPixabayVideo(variants);
      if (!best) continue;
      const duration = asPositiveInt(hit.duration);
      out.push({
        candidateId,
        candidate: {
          candidateId, provider: "pixabay", providerAssetId: id, kind: "video",
          title: asText(hit.tags, 300) ?? `Pixabay 视频 ${id}`,
          sourceUrl, creatorName, creatorUrl: null, previewUrl: best.thumbnail,
          width: best.width, height: best.height, dimensionsKind: "download", durationMs: duration !== null ? duration * 1000 : null,
          licenseUrl: "https://pixabay.com/service/license-summary/",
        },
        downloadUrl: best.url,
      });
    }
    if (out.length >= req.limit) break;
  }
  return out;
}

/** 供应商返回的同片多档转码里选像素最大的一档；预览用同片官方缩略图。 */
function pickPixabayVideo(value: unknown): { url: string; width: number; height: number; thumbnail: string | null } | null {
  if (!value || typeof value !== "object") return null;
  let best: { url: string; width: number; height: number; thumbnail: string | null } | null = null;
  for (const rendition of Object.values(value)) {
    if (!rendition || typeof rendition !== "object") continue;
    const file = rendition as Record<string, unknown>;
    const url = asUrl(file.url);
    const width = asPositiveInt(file.width);
    const height = asPositiveInt(file.height);
    if (!url || !width || !height) continue;
    if (!best || width * height > best.width * best.height) best = { url, width, height, thumbnail: asUrl(file.thumbnail) };
  }
  return best;
}

// —— Unsplash（Keyed；仅图片；采用时上报 download_location） ——

const UNSPLASH_MEDIA_HOSTS = new Set(["images.unsplash.com"]);

function unsplashReferral(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("utm_source", "videofactory");
  parsed.searchParams.set("utm_medium", "referral");
  return parsed.toString();
}

async function searchUnsplash(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({ query: req.query, per_page: String(Math.min(Math.max(req.limit, 1), 30)), content_filter: "high" });
  const payload = await getJson(`https://api.unsplash.com/search/photos?${params}`, "Unsplash", ctx, {
    authorization: `Client-ID ${ctx.apiKey}`, "accept-version": "v1",
  }, signal);
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) throw new StockUnavailableError("Unsplash 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const photo = item as Record<string, unknown>;
    const id = asText(photo.id, 100);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const width = asPositiveInt(photo.width);
    const height = asPositiveInt(photo.height);
    const user = photo.user as Record<string, unknown> | undefined;
    const links = photo.links as Record<string, unknown> | undefined;
    const urls = photo.urls as Record<string, unknown> | undefined;
    const creatorName = asText(user?.name, 200);
    const creatorPage = asUrl(user?.links && (user.links as Record<string, unknown>).html);
    const sourcePage = asUrl(links?.html);
    const previewUrl = asUrl(urls?.small);
    const downloadUrl = asUrl(urls?.regular);
    const trackingUrl = asUrl(links?.download_location);
    if (!creatorName || !creatorPage || !sourcePage || !previewUrl || !downloadUrl || !trackingUrl) continue;
    if (new URL(trackingUrl).host !== "api.unsplash.com" || new URL(trackingUrl).pathname !== `/photos/${id}/download`) continue;
    if (new URL(downloadUrl).host !== "images.unsplash.com") continue;
    const candidateId = req.newCandidateId();
    out.push({
      candidateId,
      candidate: {
        candidateId, provider: "unsplash", providerAssetId: id, kind: "image",
        title: asText(photo.alt_description, 300) ?? `Unsplash 图片 ${id}`,
        sourceUrl: unsplashReferral(sourcePage), creatorName, creatorUrl: unsplashReferral(creatorPage),
        // width/height 描述原作，regular 的 URL 参数不作为实际变体像素证据。
        previewUrl,
        ...(width !== null && height !== null
          ? { width, height, dimensionsKind: "source" as const }
          : { width: null, height: null }),
        durationMs: null, licenseUrl: "https://unsplash.com/license",
      },
      downloadUrl,
      trackingUrl,
    });
    if (out.length >= req.limit) break;
  }
  return out;
}

async function prepareUnsplashImport(input: { providerAssetId: string; trackingUrl: string | undefined }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<void> {
  if (!input.trackingUrl) throw new StockUnavailableError("Unsplash 采用追踪失败，本次不下载媒体。");
  const tracking = new URL(input.trackingUrl);
  if (tracking.host !== "api.unsplash.com" || tracking.pathname !== `/photos/${input.providerAssetId}/download`) {
    throw new StockUnavailableError("Unsplash 采用追踪失败，本次不下载媒体。");
  }
  // 只在采用素材时上报下载；预览/搜索不计。失败不跳过也不重复上报。
  try {
    const receipt = await fetchApiJson({
      url: tracking.toString(), label: "Unsplash", headers: { authorization: `Client-ID ${ctx.apiKey}`, "accept-version": "v1" },
      fetchImpl: ctx.fetchImpl, signal,
    });
    if (typeof receipt !== "object" || receipt === null || typeof (receipt as Record<string, unknown>).url !== "string") {
      throw new Error("invalid receipt");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new StockUnavailableError("Unsplash 采用追踪失败，本次不下载媒体。");
  }
}

// —— Coverr（Keyed；仅视频；跳过 AI 生成与付费内容，签名链接不外露） ——

const COVERR_MEDIA_HOSTS = new Set(["cdn.coverr.co", "storage.coverr.co"]);
const COVERR_PUBLIC_HOSTS = new Set(["coverr.co", "cdn.coverr.co", "storage.coverr.co"]);

function coverrSignedFreeUrl(value: unknown): string | null {
  // 签名链接不能公开，也不能删掉签名假装它仍可访问；带查询/锚点的缩略图只保留来源。
  const url = asUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !COVERR_PUBLIC_HOSTS.has(parsed.host) || parsed.search || parsed.hash) return null;
  return url;
}

async function searchCoverr(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const pageSize = Math.min(50, Math.max(20, req.limit * 3));
  const found = new Map<string, StockCandidateInput>();
  // Demo 额度有限：每次检索最多两页，过滤后补齐但不无限翻页。
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({ query: req.query, page_size: String(pageSize), page: String(page), urls: "true" });
    const payload = await getJson(`https://api.coverr.co/videos?${params}`, "Coverr", ctx, {
      authorization: `Bearer ${ctx.apiKey}`, accept: "application/json",
    }, signal);
    const hits = (payload as Record<string, unknown>).hits;
    if (!Array.isArray(hits)) throw new StockUnavailableError("Coverr 响应格式不可识别。");
    for (const item of hits) {
      if (!item || typeof item !== "object") continue;
      const hit = item as Record<string, unknown>;
      // 公开 API 也会返回 AI 与付费内容；免费实拍库存不能混入这两类结果。
      if (hit.is_ai_generated === true || hit.is_premium === true) continue;
      const id = asText(String(hit.id ?? ""), 100);
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
      if (found.has(id)) continue;
      const width = asPositiveInt(hit.max_width);
      const height = asPositiveInt(hit.max_height);
      const durationSeconds = asPositiveSeconds(hit.duration);
      const urls = hit.urls as Record<string, unknown> | undefined;
      const downloadUrl = asUrl(urls?.mp4_download);
      if (!width || !height || !durationSeconds || !downloadUrl) continue;
      const downloadHost = new URL(downloadUrl);
      if (downloadHost.protocol !== "https:" || !COVERR_MEDIA_HOSTS.has(downloadHost.host)) continue;
      const slugRaw = asText(String(hit.slug ?? ""), 200);
      const slug = slugRaw && /^[A-Za-z0-9_-]+$/.test(slugRaw) ? slugRaw : id;
      const previewUrl = coverrSignedFreeUrl(hit.thumbnail) ?? coverrSignedFreeUrl(hit.poster);
      const contributor = asText(hit.contributor_name, 200) ?? "Coverr";
      const contributorUrl = coverrSignedFreeUrl(hit.contributor_url);
      const candidateId = req.newCandidateId();
      found.set(id, {
        candidateId,
        candidate: {
          candidateId, provider: "coverr", providerAssetId: id, kind: "video",
          title: asText(hit.description, 300) ?? `Coverr 视频 ${id}`,
          sourceUrl: `https://coverr.co/videos/${slug}`, creatorName: contributor, creatorUrl: contributorUrl,
          previewUrl, width, height, dimensionsKind: "source", durationMs: Math.round(durationSeconds * 1000),
          licenseUrl: "https://coverr.co/license",
        },
        downloadUrl,
      });
      if (found.size >= req.limit) break;
    }
    if (found.size >= req.limit || hits.length < pageSize) break;
  }
  return [...found.values()];
}

// —— Wikimedia Commons（免 Key；图片、视频与音乐录音；逐件许可校验，只收可核实的 CC/PD） ——

const WIKIMEDIA_UPLOAD_HOSTS = new Set(["upload.wikimedia.org"]);
const WIKIMEDIA_SOURCE_HOSTS = new Set(["commons.wikimedia.org"]);
const WIKIMEDIA_PREVIEW_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);

interface WikimediaExtMetadata {
  [key: string]: { value?: unknown } | undefined;
}

function extText(metadata: WikimediaExtMetadata, key: string): string | null {
  return asHtmlText(metadata[key]?.value, 2000);
}

/** 与旧版一致的许可白名单：CC BY/BY-SA 指定版本、CC0、按文件页声明的公有领域；许可复核分类直接拒绝。 */
function wikimediaLicenseUrl(metadata: WikimediaExtMetadata, sourceUrl: string): string | null {
  const name = extText(metadata, "LicenseShortName") ?? "";
  let url = extText(metadata, "LicenseUrl") ?? "";
  if (url.startsWith("http://creativecommons.org/")) url = `https://${url.slice("http://".length)}`;
  url = url.replace(/\/deed(?:\.[a-zA-Z-]+)?\/?$/, "").replace(/\/+$/, "");
  const categories = (extText(metadata, "Categories") ?? "").toLowerCase();
  if (/licen[cs]e review (needed|failed)|copyright violations?|disputed|no machine-readable licen[cs]e|deletion requests/.test(categories)) return null;
  const ccMatch = /^CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)$/.exec(name);
  if (ccMatch?.[1] && ccMatch[2]) {
    const expected = `https://creativecommons.org/licenses/${ccMatch[1].toLowerCase()}/${ccMatch[2]}`;
    return url === expected ? `${expected}/` : null;
  }
  if ((name === "CC0" || name === "CC0 1.0") && url === "https://creativecommons.org/publicdomain/zero/1.0") return `${url}/`;
  if (name === "Public domain" && (
    url === "https://creativecommons.org/publicdomain/mark/1.0"
    || (!url && (extText(metadata, "License") ?? "").toLowerCase() === "pd" && (extText(metadata, "Copyrighted") ?? "").toLowerCase() === "false")
  )) {
    return url ? `${url}/` : sourceUrl;
  }
  return null;
}

function wikimediaTitle(page: Record<string, unknown>, pageid: number, kind: string): string {
  const raw = asText(page.title, 320);
  const stripped = raw?.replace(/^File:\s*/i, "") ?? null;
  return (stripped && asText(stripped, 300)) ?? `Wikimedia ${kind} ${pageid}`;
}

async function searchWikimedia(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({
    action: "query", generator: "search", gsrnamespace: "6",
    gsrsearch: `${req.query} ${req.kind === "audio" ? "music filetype:audio" : req.kind === "image" ? "filetype:bitmap" : "filetype:video"}`,
    gsrlimit: String(Math.min(20, Math.max(6, req.limit * 3))),
    iiprop: "url", iiurlwidth: "640", format: "json", formatversion: "2",
  });
  if (req.kind === "image") {
    params.set("prop", "imageinfo");
    params.set("iiprop", "url|size|mime|mediatype|extmetadata");
  } else {
    params.set("prop", req.kind === "audio" ? "videoinfo" : "videoinfo|imageinfo");
    params.set("viprop", "url|size|mime|mediatype|derivatives|extmetadata");
  }
  const payload = await getJson(`${WIKIMEDIA_API}?${params}`, "Wikimedia Commons", ctx, { accept: "application/json" }, signal);
  const response = payload as { batchcomplete?: boolean; query?: unknown; error?: unknown };
  if (response.batchcomplete && !response.query && !response.error) return [];
  const query = response.query;
  const pages = typeof query === "object" && query !== null ? (query as Record<string, unknown>).pages : undefined;
  if (!Array.isArray(pages)) throw new StockUnavailableError("Wikimedia 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  for (const item of pages) {
    if (!item || typeof item !== "object") continue;
    const page = item as Record<string, unknown>;
    const pageid = asPositiveInt(page.pageid, 2_147_483_647);
    if (!pageid) continue;
    const candidate = req.kind === "image" ? wikimediaImageCandidate(page, pageid, req.newCandidateId)
      : req.kind === "audio" ? wikimediaAudioCandidate(page, pageid, req.newCandidateId)
      : wikimediaVideoCandidate(page, pageid, req.newCandidateId);
    if (candidate) out.push(candidate);
    if (out.length >= req.limit) break;
  }
  return out;
}

function wikimediaImageCandidate(page: Record<string, unknown>, pageid: number, newCandidateId: () => string): StockCandidateInput | null {
  const infos = page.imageinfo;
  const info = Array.isArray(infos) && infos[0] && typeof infos[0] === "object" ? infos[0] as Record<string, unknown> : null;
  if (!info) return null;
  // 本管线只真实处理 JPEG/PNG 图片；Commons 的 WebP/TIFF 不进入候选。
  if (info.mime !== "image/jpeg" && info.mime !== "image/png") return null;
  const width = asPositiveInt(info.width);
  const height = asPositiveInt(info.height);
  const size = asPositiveInt(info.size, MAX_IMAGE_BYTES);
  const downloadUrl = asUrl(info.url);
  const sourceUrl = asUrl(info.descriptionurl);
  const previewUrl = asUrl(info.thumburl);
  if (!width || !height || !size || !downloadUrl || !sourceUrl || !previewUrl) return null;
  if (Math.min(width, height) < 720) return null;
  if (new URL(downloadUrl).host !== "upload.wikimedia.org" || new URL(sourceUrl).host !== "commons.wikimedia.org") return null;
  if (!WIKIMEDIA_PREVIEW_HOSTS.has(new URL(previewUrl).host)) return null;
  const metadata = info.extmetadata as WikimediaExtMetadata | undefined;
  const creatorName = metadata ? extText(metadata, "Artist") : null;
  const licenseUrl = metadata ? wikimediaLicenseUrl(metadata, sourceUrl) : null;
  if (!metadata || !creatorName || !licenseUrl) return null;
  const candidateId = newCandidateId();
  return {
    candidateId,
    candidate: {
      candidateId, provider: "wikimedia", providerAssetId: String(pageid), kind: "image",
      title: wikimediaTitle(page, pageid, "图片"),
      sourceUrl, creatorName, creatorUrl: sourceUrl, previewUrl, width, height, dimensionsKind: "download", durationMs: null, licenseUrl,
    },
    downloadUrl,
  };
}

function wikimediaAudioCandidate(page: Record<string, unknown>, pageid: number, newCandidateId: () => string): StockCandidateInput | null {
  const first = Array.isArray(page.videoinfo) ? page.videoinfo[0] as unknown : null;
  const info = first && typeof first === "object" ? first as Record<string, unknown> : null;
  if (info?.mediatype !== "AUDIO") return null;
  const sourceUrl = hostAllowedUrl(info.descriptionurl, WIKIMEDIA_SOURCE_HOSTS);
  const metadata = info.extmetadata as WikimediaExtMetadata | undefined;
  const creatorName = metadata && asHtmlText(metadata.Artist?.value, 200);
  if (!metadata || !sourceUrl || !creatorName) return null;
  const licenseUrl = wikimediaLicenseUrl(metadata, sourceUrl);
  const licenseName = extText(metadata, "LicenseShortName");
  // 视频配乐先收 CC BY、CC0 与明确标为公有领域的录音，不替用户承担相同方式共享的发布条件。
  if (!licenseUrl || !licenseName || licenseName.startsWith("CC BY-SA")) return null;
  const mp3 = info.mime === "audio/mpeg" ? info.url : Array.isArray(info.derivatives)
    ? info.derivatives.find((item: { type?: string } | null) => item?.type === "audio/mpeg")?.src : null;
  const downloadUrl = hostAllowedUrl(mp3, WIKIMEDIA_UPLOAD_HOSTS);
  const seconds = asPositiveSeconds(info.duration);
  if (!downloadUrl || !downloadUrl.startsWith("https:") || !seconds || seconds > 86400) return null;
  const candidateId = newCandidateId();
  const title = wikimediaTitle(page, pageid, "录音");
  return { candidateId, downloadUrl, candidate: {
    candidateId, provider: "wikimedia", providerAssetId: String(pageid), kind: "audio", title,
    sourceUrl, creatorName, creatorUrl: null, previewUrl: downloadUrl, width: null, height: null,
    durationMs: Math.round(seconds * 1000), licenseUrl, licenseName, vocalKind: "unknown",
    attributionText: `${title} — ${creatorName}\n${sourceUrl}\n${licenseName}${licenseUrl === sourceUrl ? "" : " · " + licenseUrl}`,
  } };
}

function wikimediaVideoCandidate(page: Record<string, unknown>, pageid: number, newCandidateId: () => string): StockCandidateInput | null {
  const videoinfos = page.videoinfo;
  const info = Array.isArray(videoinfos) && videoinfos[0] && typeof videoinfos[0] === "object" ? videoinfos[0] as Record<string, unknown> : null;
  if (!info) return null;
  if (info.mediatype !== "VIDEO") return null;
  // 本管线只真实处理 MP4/WebM 容器；Commons 的 Ogg/Theora 不进入候选。
  if (info.mime !== "video/webm" && info.mime !== "video/mp4") return null;
  const durationSeconds = asPositiveSeconds(info.duration);
  const width = asPositiveInt(info.width);
  const height = asPositiveInt(info.height);
  const size = asPositiveInt(info.size, MAX_VIDEO_BYTES);
  if (!durationSeconds || !width || !height || !size) return null;
  const sourceUrl = asUrl(info.descriptionurl);
  if (!sourceUrl || new URL(sourceUrl).host !== "commons.wikimedia.org") return null;
  const metadata = info.extmetadata as WikimediaExtMetadata | undefined;
  const creatorName = metadata ? extText(metadata, "Artist") : null;
  const licenseUrl = metadata ? wikimediaLicenseUrl(metadata, sourceUrl) : null;
  if (!metadata || !creatorName || !licenseUrl) return null;
  // 同片多档转码里选像素最大的一档；原片与转码都必须有真实大小，超过采用上限的不进候选。
  interface Variant { url: string; width: number; height: number; pixels: number; size: number }
  const variants: Variant[] = [];
  const original = asUrl(info.url);
  if (original && new URL(original).host === "upload.wikimedia.org" && Math.min(width, height) >= 720) {
    variants.push({ url: original, width, height, pixels: width * height, size });
  }
  if (Array.isArray(info.derivatives)) {
    for (const item of info.derivatives) {
      if (!item || typeof item !== "object") continue;
      const derivative = item as Record<string, unknown>;
      const mime = typeof derivative.type === "string" ? derivative.type.split(";", 1)[0]!.trim() : "";
      if (mime !== "video/webm" && mime !== "video/mp4") continue;
      const url = asUrl(derivative.src);
      const dw = asPositiveInt(derivative.width);
      const dh = asPositiveInt(derivative.height);
      if (!url || !dw || !dh || new URL(url).host !== "upload.wikimedia.org") continue;
      if (Math.min(dw, dh) < 720) continue;
      const bandwidth = typeof derivative.bandwidth === "number" && Number.isFinite(derivative.bandwidth) && derivative.bandwidth > 0
        ? Math.round(derivative.bandwidth * durationSeconds / 8) : null;
      if (bandwidth === null || bandwidth > MAX_VIDEO_BYTES) continue;
      variants.push({ url, width: dw, height: dh, pixels: dw * dh, size: bandwidth });
    }
  }
  if (variants.length === 0) return null;
  const best = variants.reduce((acc, item) => item.pixels > acc.pixels || (item.pixels === acc.pixels && item.size < acc.size) ? item : acc);
  const imageinfos = page.imageinfo;
  const previewInfo = Array.isArray(imageinfos) && imageinfos[0] && typeof imageinfos[0] === "object" ? imageinfos[0] as Record<string, unknown> : null;
  const previewUrl = previewInfo ? asUrl(previewInfo.thumburl) : null;
  if (previewUrl && !WIKIMEDIA_PREVIEW_HOSTS.has(new URL(previewUrl).host)) return null;
  const candidateId = newCandidateId();
  return {
    candidateId,
    candidate: {
      candidateId, provider: "wikimedia", providerAssetId: String(pageid), kind: "video",
      title: wikimediaTitle(page, pageid, "视频"),
      sourceUrl, creatorName, creatorUrl: sourceUrl, previewUrl,
      width: best.width, height: best.height, dimensionsKind: "download", durationMs: Math.round(durationSeconds * 1000), licenseUrl,
    },
    downloadUrl: best.url,
  };
}

// —— NASA 图像库（免 Key；图片+视频；明示第三方版权或缺 center 的条目不采用） ——

const NASA_MEDIA_HOSTS = new Set(["images-assets.nasa.gov"]);

function nasaAssetUrl(value: unknown): string | null {
  // 官方旧清单给 http URL；只把已知 NASA CDN 升级为 HTTPS，绝不接受其它主机。
  // URL 解析顺带把未编码空格编码、保留已有百分号编码，避免二次编码。
  let raw = typeof value === "string" ? value : null;
  if (raw === null) return null;
  if (raw.startsWith("http://images-assets.nasa.gov/")) raw = `https://${raw.slice("http://".length)}`;
  const url = asUrl(raw);
  if (!url || new URL(url).host !== "images-assets.nasa.gov") return null;
  return url;
}

async function searchNasa(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({ q: req.query, media_type: req.kind, page_size: String(Math.min(12, Math.max(3, req.limit * 2))) });
  const payload = await getJson(`https://images-api.nasa.gov/search?${params}`, "NASA", ctx, { accept: "application/json" }, signal);
  const collection = (payload as Record<string, unknown>).collection;
  const items = typeof collection === "object" && collection !== null ? (collection as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) throw new StockUnavailableError("NASA 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const dataList = entry.data;
    const data = Array.isArray(dataList) && dataList[0] && typeof dataList[0] === "object" ? dataList[0] as Record<string, unknown> : null;
    if (!data) continue;
    const assetId = asText(data.nasa_id, 200);
    if (!assetId || seen.has(assetId) || data.media_type !== req.kind) continue;
    seen.add(assetId);
    // 明示第三方版权的内容不按机构的一般媒体使用规则自动采用。
    if (data.copyright != null && data.copyright !== "" || !asText(data.center, 100)) continue;
    const manifest = await getJson(`https://images-api.nasa.gov/asset/${encodeURIComponent(assetId)}`, "NASA", ctx, { accept: "application/json" }, signal);
    const manifestCollection = (manifest as Record<string, unknown>).collection;
    const files = typeof manifestCollection === "object" && manifestCollection !== null
      ? (manifestCollection as Record<string, unknown>).items : undefined;
    if (!Array.isArray(files)) throw new StockUnavailableError("NASA 响应格式不可识别。");
    const variants: [number, string][] = [];
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const url = nasaAssetUrl((file as Record<string, unknown>).href);
      if (!url) continue;
      const suffix = new URL(url).pathname.toLowerCase();
      if (req.kind === "video" && suffix.endsWith(".mp4")) {
        // 预览/手机版不能当正式原片；真实像素、时长下载后核验。
        if (suffix.includes("~preview.") || suffix.includes("~mobile.") || suffix.includes("~small.")) continue;
        variants.push([suffix.includes("~orig.") ? 2 : 1, url]);
      } else if (req.kind === "image" && (suffix.endsWith(".jpg") || suffix.endsWith(".jpeg") || suffix.endsWith(".png")) && suffix.includes("~orig.")) {
        variants.push([1, url]);
      }
    }
    if (variants.length === 0) continue;
    const downloadUrl = variants.reduce((acc, item2) => item2[0] > acc[0] ? item2 : acc)[1];
    let previewUrl: string | null = null;
    if (Array.isArray(entry.links)) {
      for (const link of entry.links) {
        if (!link || typeof link !== "object" || (link as Record<string, unknown>).render !== "image") continue;
        previewUrl = nasaAssetUrl((link as Record<string, unknown>).href);
        if (previewUrl) break;
      }
    }
    const center = asText(data.center, 100)!;
    const candidateId = req.newCandidateId();
    out.push({
      candidateId,
      candidate: {
        candidateId, provider: "nasa", providerAssetId: assetId, kind: req.kind,
        title: asText(data.title, 300) ?? `NASA ${req.kind === "image" ? "图片" : "视频"} ${assetId}`,
        sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(assetId)}`,
        creatorName: asText(data.secondary_creator, 200) ?? `NASA / ${center}`,
        creatorUrl: `https://images.nasa.gov/details/${encodeURIComponent(assetId)}`,
        previewUrl, width: null, height: null, durationMs: null,
        licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      },
      downloadUrl,
    });
    if (out.length >= req.limit) break;
  }
  return out;
}

// —— The Met（免 Key；仅公有领域图片；实际尺寸采用时核验） ——

const MET_MEDIA_HOSTS = new Set(["images.metmuseum.org"]);

function hostAllowedUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  const url = asUrl(value);
  if (!url) return null;
  return hosts.has(new URL(url).host) ? url : null;
}

async function searchMet(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const pageSize = Math.min(12, Math.max(3, req.limit * 2));
  const out: StockCandidateInput[] = [];
  const seen = new Set<number>();
  for (const offset of [0, pageSize]) {
    const params = new URLSearchParams({ q: req.query, isPublicDomain: "true", hasImages: "true", limit: String(pageSize), offset: String(offset) });
    const payload = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?${params}`, "The Met", ctx, { accept: "application/json" }, signal);
    const body = payload as Record<string, unknown>;
    const ids = body.objectIDs;
    if (ids === undefined && body.total === 0) break;
    if (!Array.isArray(ids)) throw new StockUnavailableError("The Met 响应格式不可识别。");
    for (const rawId of ids) {
      const objectId = asPositiveInt(rawId, 2_147_483_647);
      if (!objectId || seen.has(objectId)) continue;
      seen.add(objectId);
      const item = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`, "The Met", ctx, { accept: "application/json" }, signal) as Record<string, unknown>;
      if (item.isPublicDomain !== true || item.objectID !== objectId) continue;
      const downloadUrl = hostAllowedUrl(item.primaryImage, MET_MEDIA_HOSTS);
      const sourceUrl = hostAllowedUrl(item.objectURL, new Set(["www.metmuseum.org", "metmuseum.org"]));
      if (!downloadUrl || !sourceUrl) continue;
      const candidateId = req.newCandidateId();
      out.push({
        candidateId,
        candidate: {
          candidateId, provider: "met", providerAssetId: String(objectId), kind: "image",
          title: asText(item.title, 300) ?? `Met 藏品 ${objectId}`,
          sourceUrl,
          creatorName: asText(item.artistDisplayName, 200) ?? "The Metropolitan Museum of Art（作者未注明）",
          creatorUrl: sourceUrl,
          previewUrl: hostAllowedUrl(item.primaryImageSmall, MET_MEDIA_HOSTS),
          width: null, height: null, durationMs: null, licenseUrl: CC0_URL,
        },
        downloadUrl,
      });
      if (out.length >= req.limit) return out;
    }
    if (ids.length < pageSize) break;
  }
  return out;
}

// —— Cleveland Open Access（免 Key；仅 CC0 图片；print 高清图短边 ≥720） ——

const CLEVELAND_MEDIA_HOSTS = new Set(["openaccess-cdn.clevelandart.org"]);

async function searchCleveland(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({ q: req.query, cc0: "1", has_image: "1", limit: String(Math.min(24, Math.max(6, req.limit * 2))) });
  const payload = await getJson(`https://openaccess-api.clevelandart.org/api/artworks/?${params}`, "Cleveland", ctx, { accept: "application/json" }, signal);
  const items = (payload as Record<string, unknown>).data;
  if (!Array.isArray(items)) throw new StockUnavailableError("Cleveland 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const artwork = item as Record<string, unknown>;
    if (artwork.share_license_status !== "CC0") continue;
    const objectId = asPositiveInt(artwork.id, 2_147_483_647);
    if (!objectId || seen.has(objectId)) continue;
    const images = artwork.images as Record<string, unknown> | undefined;
    // print 是官方高清 JPEG；web 是缩略图，full 可能是巨型 TIFF，不能互相冒充。
    const print = images?.print as Record<string, unknown> | undefined;
    const web = images?.web as Record<string, unknown> | undefined;
    if (!images || !print) continue;
    const downloadUrl = hostAllowedUrl(print.url, CLEVELAND_MEDIA_HOSTS);
    const sourceUrl = hostAllowedUrl(artwork.url, new Set(["clevelandart.org", "www.clevelandart.org"]));
    const width = asPositiveInt(print.width);
    const height = asPositiveInt(print.height);
    if (!downloadUrl || !sourceUrl || !width || !height) continue;
    if (!new URL(downloadUrl).pathname.toLowerCase().endsWith(".jpg") && !new URL(downloadUrl).pathname.toLowerCase().endsWith(".jpeg")) continue;
    if (Math.min(width, height) < 720) continue;
    seen.add(objectId);
    const creators = Array.isArray(artwork.creators)
      ? artwork.creators.map(entry => entry && typeof entry === "object" ? asHtmlText((entry as Record<string, unknown>).description, 200) : null).filter((name): name is string => name !== null)
      : [];
    const previewUrl = web ? hostAllowedUrl(web.url, CLEVELAND_MEDIA_HOSTS) : null;
    const candidateId = req.newCandidateId();
    out.push({
      candidateId,
      candidate: {
        candidateId, provider: "cleveland", providerAssetId: String(objectId), kind: "image",
        title: asText(artwork.title, 300) ?? `Cleveland 藏品 ${objectId}`,
        sourceUrl,
        creatorName: creators.length > 0 ? creators.join("; ") : "The Cleveland Museum of Art（作者未注明）",
        creatorUrl: sourceUrl, previewUrl, width, height, dimensionsKind: "download", durationMs: null, licenseUrl: CC0_URL,
      },
      downloadUrl,
    });
    if (out.length >= req.limit) break;
  }
  return out;
}

// —— Internet Archive stock_footage（免 Key；仅视频；集合与逐件许可必须同时满足） ——

function archiveAllowedHost(host: string): boolean {
  // 下载入口是 archive.org，官方会重定向到 archive.org 的下载节点子域；不开放其它任何主机。
  return host === "archive.org" || host.endsWith(".archive.org");
}

function archiveFileUrl(identifier: string, name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0 || name.includes("\\") || [...name].some(ch => ch.charCodeAt(0) < 32)) return null;
  if (name.split("/").some(part => part === "" || part === "." || part === "..")) return null;
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

function archiveRestricted(record: Record<string, unknown>): boolean {
  return ["private", "is_dark", "is_restricted", "access-restricted-item"]
    .some(key => {
      const value = record[key];
      return value !== undefined && value !== null && value !== false && value !== "false" && value !== "0" && value !== 0;
    });
}

/** 上传者声明的 Creative Commons 许可；认不出的许可不能上架。 */
function archiveLicenseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.replace("http://creativecommons.org/", "https://creativecommons.org/").replace(/\/+$/, "") + "/";
  if (url === "https://creativecommons.org/publicdomain/zero/1.0/" || url === "https://creativecommons.org/publicdomain/mark/1.0/") return url;
  if (/^https:\/\/creativecommons\.org\/licenses\/(by|by-sa|by-nc|by-nc-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)\/$/.test(url)) return url;
  return null;
}

async function searchArchive(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  // 引号内的用户搜索词不能改变 collection/mediatype/许可的服务端过滤条件。
  const escaped = req.query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const params = new URLSearchParams({
    q: `collection:stock_footage AND mediatype:movies AND licenseurl:* AND ("${escaped}")`,
    rows: String(Math.min(6, Math.max(3, req.limit * 2))), output: "json",
  });
  params.append("fl[]", "identifier");
  const payload = await getJson(`https://archive.org/advancedsearch.php?${params}`, "Internet Archive", ctx, { accept: "application/json" }, signal);
  const response = (payload as Record<string, unknown>).response;
  const docs = typeof response === "object" && response !== null ? (response as Record<string, unknown>).docs : undefined;
  if (!Array.isArray(docs)) throw new StockUnavailableError("Internet Archive 响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  const seen = new Set<string>();
  for (const item of docs) {
    if (!item || typeof item !== "object") continue;
    const identifier = asText((item as Record<string, unknown>).identifier, 200);
    if (!identifier || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(identifier) || seen.has(identifier)) continue;
    seen.add(identifier);
    const detail = await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, "Internet Archive", ctx, { accept: "application/json" }, signal) as Record<string, unknown>;
    const metadata = detail.metadata as Record<string, unknown> | undefined;
    const files = detail.files;
    if (!metadata || !Array.isArray(files)) throw new StockUnavailableError("Internet Archive 响应格式不可识别。");
    const rawCollections = metadata.collection;
    const collections = Array.isArray(rawCollections) ? rawCollections : typeof rawCollections === "string" ? [rawCollections] : [];
    if (metadata.identifier !== identifier || metadata.mediatype !== "movies" || !collections.includes("stock_footage")) continue;
    if (archiveRestricted(detail) || archiveRestricted(metadata)) continue;
    const licenseUrl = archiveLicenseUrl(metadata.licenseurl);
    const rawCreator = metadata.creator;
    const creatorList = Array.isArray(rawCreator) ? rawCreator : [rawCreator];
    const creatorName = creatorList.map(entry => asHtmlText(entry, 200)).filter((name): name is string => name !== null).join("; ");
    if (!licenseUrl || !creatorName) continue;
    interface ArchiveVariant { url: string; width: number; height: number; durationMs: number; pixels: number; size: number }
    const variants: ArchiveVariant[] = [];
    let previewUrl: string | null = null;
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const record = file as Record<string, unknown>;
      if (archiveRestricted(record)) continue;
      const name = record.name;
      const url = archiveFileUrl(identifier, name);
      if (!url) continue;
      const lowerName = typeof name === "string" ? name.toLowerCase() : "";
      if (record.format === "Thumbnail" && (lowerName.endsWith(".jpg") || lowerName.endsWith(".png")) && previewUrl === null) {
        previewUrl = url;
        continue;
      }
      if (!lowerName.endsWith(".mp4") && !lowerName.endsWith(".webm")) continue;
      const width = asPositiveInt(record.width);
      const height = asPositiveInt(record.height);
      const size = asPositiveInt(record.size, MAX_VIDEO_BYTES);
      const lengthSeconds = asPositiveSeconds(record.length);
      if (!width || !height || !size || !lengthSeconds) continue;
      if (Math.min(width, height) < 720) continue;
      variants.push({ url, width, height, durationMs: Math.round(lengthSeconds * 1000), pixels: width * height, size });
    }
    if (variants.length === 0) continue;
    const best = variants.reduce((acc, item2) => item2.pixels > acc.pixels || (item2.pixels === acc.pixels && item2.size < acc.size) ? item2 : acc);
    const sourceUrl = `https://archive.org/details/${encodeURIComponent(identifier)}`;
    const candidateId = req.newCandidateId();
    out.push({
      candidateId,
      candidate: {
        candidateId, provider: "archive", providerAssetId: identifier, kind: "video",
        title: asText(metadata.title, 300) ?? identifier,
        sourceUrl, creatorName, creatorUrl: sourceUrl, previewUrl,
        width: best.width, height: best.height, dimensionsKind: "download", durationMs: best.durationMs, licenseUrl,
      },
      downloadUrl: best.url,
    });
    if (out.length >= req.limit) break;
  }
  return out;
}

// 官方网站按 ISRC 展示单曲，检索使用同一份公开曲目目录；不镜像音频。
const INCOMPETECH_MUSIC = "https://incompetech.com/music/royalty-free/";
async function searchIncompetech(req: { query: string; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const tracks = await getJson(`${INCOMPETECH_MUSIC}pieces.json`, "Incompetech", ctx, { accept: "application/json" }, signal);
  if (!Array.isArray(tracks)) throw new StockUnavailableError("Incompetech 曲目目录格式不可识别。");
  const words = req.query.trim().toLowerCase().split(/\s+/);
  const out: StockCandidateInput[] = [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") continue;
    const title = asText(track.title, 300);
    const id = asText(track.isrc, 100);
    const file = asText(track.filename, 300);
    if (!title || !id || !file || !file.toLowerCase().endsWith(".mp3") || file.includes("/")) continue;
    const searchable = [title, track.instruments, track.feel, track.description].join(" ").toLowerCase();
    if (!words.every(word => searchable.includes(word))) continue;
    const time = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(track.length);
    const durationMs = time ? (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000 : null;
    const downloadUrl = `${INCOMPETECH_MUSIC}mp3-royaltyfree/${encodeURIComponent(file)}`;
    const sourceUrl = `${INCOMPETECH_MUSIC}index.html?isrc=${encodeURIComponent(id)}`;
    const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
    const candidateId = req.newCandidateId();
    out.push({ candidateId, downloadUrl, candidate: {
      candidateId, provider: "incompetech", providerAssetId: id, kind: "audio", title,
      sourceUrl, creatorName: "Kevin MacLeod", creatorUrl: "https://incompetech.com/", previewUrl: downloadUrl,
      width: null, height: null, durationMs, vocalKind: "unknown", licenseUrl, licenseName: "CC BY 4.0", licenseVersion: "4.0",
      attributionText: `"${title}" Kevin MacLeod (incompetech.com)\nCC BY 4.0 · ${licenseUrl}\n${sourceUrl}`,
    } });
    if (out.length >= req.limit) break;
  }
  return out;
}

// —— FreeToUse（免 Key；仅 Non-Premium MP3，许可限个人社交 UGC 且必须署名） ——

const FREETOUSE_TRACKS_API = "https://api.freetouse.com/v3/music/tracks";
const FREETOUSE_MEDIA_HOSTS = new Set(["eu.data.freetouse.com"]);

/** 搜索与详情是两个外部边界，复用同一条目解析，缺任一免费/作者/文件事实都不接纳。 */
function parseFreeToUseTrack(value: unknown): StockImportDetails | null {
  if (!value || typeof value !== "object") return null;
  const track = value as Record<string, unknown>;
  if (track.is_premium !== false) return null;
  const id = asText(track.id, 100);
  const title = asText(track.title, 300);
  const durationSeconds = asPositiveSeconds(track.duration);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !title || !durationSeconds || durationSeconds > 86400) return null;
  const durationMs = Math.round(durationSeconds * 1000);
  if (durationMs < 1) return null;
  const artists: StockImportDetails["sourceFacts"]["artists"] = [];
  if (!Array.isArray(track.artists) || track.artists.length === 0) return null;
  for (const entry of track.artists) {
    if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < 0
      || !entry[1] || typeof entry[1] !== "object") return null;
    const artist = entry[1] as Record<string, unknown>;
    const artistId = asText(artist.id, 200);
    const name = asText(artist.name, 200);
    if (!artistId || !name) return null;
    artists.push([entry[0] as number, { id: artistId, name }]);
  }
  artists.sort((a, b) => a[0] - b[0]);
  const creatorName = asText(artists.map(([, artist]) => artist.name).join("; "), 200);
  const files = track.files && typeof track.files === "object" ? track.files as Record<string, unknown> : null;
  const downloadUrl = asUrl(files?.mp3);
  if (!creatorName || !downloadUrl) return null;
  const media = new URL(downloadUrl);
  if (media.protocol !== "https:" || !FREETOUSE_MEDIA_HOSTS.has(media.host) || !media.pathname.toLowerCase().endsWith(".mp3")) return null;
  const lyricsLanguage = asText(track.lyrics, 80);
  // null 只表示未提供语言；官方标签明确 instrumental 时才标纯音乐。
  const instrumentalTag = Array.isArray(track.tags) && track.tags.some(tag => Array.isArray(tag) && tag[1] === "instrumental");
  const sourceUrl = `${FREETOUSE_TRACKS_API}/${id}`;
  return {
    candidate: {
      provider: "freetouse", providerAssetId: id, kind: "audio", title, sourceUrl, creatorName, creatorUrl: null,
      // 当前环境未证明远端 MP3 可播放；不拿封面图或下载地址充当已可用试听。
      previewUrl: null, width: null, height: null, durationMs,
      vocalKind: lyricsLanguage ? "song" : instrumentalTag ? "instrumental" : "unknown", lyricsLanguage,
      licenseUrl: "https://freetouse.com/license", licenseName: "FreeToUse Non-Premium License", licenseVersion: null,
      attributionText: `Music: ${title} by ${creatorName}\nFree To Use: https://freetouse.com/music\nSource: ${sourceUrl}`,
      usageScope: "仅限个人社交平台自制内容 UGC，含平台变现；必须正确署名。禁止品牌、商业宣传、赞助及其他商业用途；不代表已购买许可。",
    },
    downloadUrl,
    sourceFacts: { isPremium: false, artists, lyrics: lyricsLanguage, durationSeconds, instrumentalTag },
  };
}

async function searchFreeToUse(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const params = new URLSearchParams({ query: req.query, limit: String(req.limit) });
  const payload = await getJson(`${FREETOUSE_TRACKS_API}/search?${params}`, "FreeToUse", ctx, { accept: "application/json" }, signal);
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (body?.ok !== true || !Array.isArray(body.data)) throw new StockUnavailableError("FreeToUse 搜索响应格式不可识别。");
  const out: StockCandidateInput[] = [];
  for (const item of body.data) {
    const track = parseFreeToUseTrack(item);
    if (!track) continue;
    const candidateId = req.newCandidateId();
    out.push({ candidateId, candidate: { ...track.candidate, candidateId }, downloadUrl: track.downloadUrl });
    if (out.length >= req.limit) break;
  }
  return out;
}

async function prepareFreeToUseImport(input: { providerAssetId: string; trackingUrl: string | undefined }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockImportDetails> {
  const payload = await getJson(`${FREETOUSE_TRACKS_API}/${encodeURIComponent(input.providerAssetId)}`, "FreeToUse", ctx, { accept: "application/json" }, signal);
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const track = body?.ok === true ? parseFreeToUseTrack(body.data) : null;
  if (!track || track.candidate.providerAssetId !== input.providerAssetId) {
    throw new StockUnavailableError("FreeToUse 详情无法确认该曲目的 Non-Premium、完整作者或 MP3 文件事实，本次不能采用。");
  }
  return track;
}

// —— Pexels 适配（复用 PexelsClient 的既有解析事实） ——

async function searchPexels(req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, ctx: StockAdapterContext, signal?: AbortSignal): Promise<StockCandidateInput[]> {
  const client = new PexelsClient({ enabled: true, apiKey: ctx.apiKey }, ctx.fetchImpl);
  return (await client.search({ ...req, kind: req.kind as "image" | "video" }, signal)).map(item => ({
    ...item, candidate: { ...item.candidate, dimensionsKind: "download" as const },
  }));
}

// —— 注册表与客户端 ——

export const STOCK_PROVIDERS: Readonly<Record<MaterialProvider, StockProviderAdapter>> = {
  pexels: { id: "pexels", label: FREE_SERVICE_LABELS.pexels, kinds: ["image", "video"], keyed: true, mediaHosts: PEXELS_MEDIA_HOSTS, search: searchPexels },
  pixabay: { id: "pixabay", label: FREE_SERVICE_LABELS.pixabay, kinds: ["image", "video"], keyed: true, mediaHosts: PIXABAY_MEDIA_HOSTS, search: searchPixabay },
  unsplash: { id: "unsplash", label: FREE_SERVICE_LABELS.unsplash, kinds: ["image"], keyed: true, mediaHosts: UNSPLASH_MEDIA_HOSTS, search: searchUnsplash, prepareImport: prepareUnsplashImport },
  coverr: { id: "coverr", label: FREE_SERVICE_LABELS.coverr, kinds: ["video"], keyed: true, mediaHosts: COVERR_MEDIA_HOSTS, search: searchCoverr },
  incompetech: { id: "incompetech", label: FREE_SERVICE_LABELS.incompetech, kinds: ["audio"], keyed: false, mediaHosts: new Set(["incompetech.com"]), search: searchIncompetech },
  wikimedia: { id: "wikimedia", label: FREE_SERVICE_LABELS.wikimedia, kinds: ["image", "video", "audio"], keyed: false, mediaHosts: WIKIMEDIA_UPLOAD_HOSTS, search: searchWikimedia },
  nasa: { id: "nasa", label: FREE_SERVICE_LABELS.nasa, kinds: ["image", "video"], keyed: false, mediaHosts: NASA_MEDIA_HOSTS, search: searchNasa },
  met: { id: "met", label: FREE_SERVICE_LABELS.met, kinds: ["image"], keyed: false, mediaHosts: MET_MEDIA_HOSTS, search: searchMet },
  cleveland: { id: "cleveland", label: FREE_SERVICE_LABELS.cleveland, kinds: ["image"], keyed: false, mediaHosts: CLEVELAND_MEDIA_HOSTS, search: searchCleveland },
  archive: { id: "archive", label: FREE_SERVICE_LABELS.archive, kinds: ["video"], keyed: false, mediaHosts: new Set(["archive.org"]), isAllowedHost: archiveAllowedHost, search: searchArchive },
  freetouse: { id: "freetouse", label: FREE_SERVICE_LABELS.freetouse, kinds: ["audio"], keyed: false, mediaHosts: FREETOUSE_MEDIA_HOSTS, search: searchFreeToUse, prepareImport: prepareFreeToUseImport },
};

/** 工具调用期间的免费素材客户端：构造时捕获全部配置，本请求内不受后续设置修改影响。 */
export class StockClient {
  constructor(
    private readonly configs: Readonly<Partial<Record<MaterialProvider, CapturedStockConfig>>>,
    private readonly fetchImpl: HttpFetch = fetch,
    private readonly cacheRoot: string | null = null,
  ) {}

  adapterOf(provider: MaterialProvider): StockProviderAdapter {
    const adapter = STOCK_PROVIDERS[provider];
    if (!adapter) throw new StockUnavailableError("未知的免费素材来源。");
    return adapter;
  }

  /** 设置与采用错误共用的服务名。 */
  labelOf(provider: MaterialProvider): string {
    return this.adapterOf(provider).label;
  }

  /** 服务已启用且（需要凭据时）已配 Key 才算就绪。 */
  ready(provider: MaterialProvider): boolean {
    const adapter = this.adapterOf(provider);
    const config = this.configs[provider];
    if (!config?.enabled) return false;
    return !adapter.keyed || config.apiKey != null;
  }

  /** 能力上下文：只列实际启用且类型已适配的服务。 */
  enabledServices(): { serviceId: MaterialProvider; kinds: StockKind[] }[] {
    return (Object.keys(STOCK_PROVIDERS) as MaterialProvider[])
      .filter(provider => this.ready(provider))
      .map(provider => ({ serviceId: provider, kinds: [...this.adapterOf(provider).kinds] }));
  }

  async search(provider: MaterialProvider, req: { query: string; kind: StockKind; limit: number; newCandidateId: () => string }, signal?: AbortSignal): Promise<StockCandidateInput[]> {
    const adapter = this.adapterOf(provider);
    requireKind(adapter, req.kind);
    if (!this.ready(provider)) {
      throw new StockUnavailableError(`${adapter.label} 素材服务未启用，请在设置里配置并启用。`);
    }
    const config = this.configs[provider]!;
    return adapter.search(req, { apiKey: config.apiKey, fetchImpl: this.fetchImpl, cacheRoot: this.cacheRoot }, signal);
  }

  async download(provider: MaterialProvider, url: string, maxBytes: number, sink: (stream: ReadableStream<Uint8Array>, response: Response) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const adapter = this.adapterOf(provider);
    return downloadWithinBounds({
      url, rules: { mediaHosts: adapter.mediaHosts, isAllowedHost: adapter.isAllowedHost }, maxBytes, fetchImpl: this.fetchImpl, signal,
    }, sink);
  }

  async prepareImport(provider: MaterialProvider, input: { providerAssetId: string; trackingUrl: string | undefined }, signal?: AbortSignal): Promise<StockImportDetails | void> {
    const adapter = this.adapterOf(provider);
    if (!this.ready(provider)) {
      throw new StockUnavailableError(`${adapter.label} 素材服务未启用，不能采用素材。`);
    }
    const config = this.configs[provider]!;
    return adapter.prepareImport?.(input, { apiKey: config.apiKey, fetchImpl: this.fetchImpl, cacheRoot: this.cacheRoot }, signal);
  }
}
