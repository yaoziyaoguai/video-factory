// 免费素材来源的共享传输纪律：API Key 只发各自固定 API 入口（重定向即拒），
// 媒体下载只走各来源的固定域名（含逐跳重定向复核）、声明长度预检与流式字节上限。
// 响应在这里一次性解析为受控类型；之后只传 typed 数据。

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

const API_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/** 免费素材来源暂时不可用（限流、网络、响应不可识别）；由工具层映射为对应错误码。 */
export class StockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockUnavailableError";
  }
}

/** 来源不支持请求的素材类型；属于输入错误而非暂时故障。 */
export class StockKindUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockKindUnsupportedError";
  }
}

function asUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function asPositiveInt(value: unknown, max = 100_000): number | null {
  // 部分来源（Archive 的宽高、Wikimedia 的文件字节数）把整数表达为数字字符串，边界一并接受。
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

/** 秒数：数字或小数字符串（Coverr 时长、Archive length 都是字符串）。 */
function asPositiveSeconds(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

/** 供应商元数据里混入的 HTML（如 Commons 的 Artist 字段）剥成纯文本。 */
function asHtmlText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  return asText(stripped, max);
}

export const stockValueHelpers = { asUrl, asPositiveInt, asPositiveSeconds, asText, asHtmlText };

/** 固定 API 入口的 JSON GET：不跟随重定向（Key 不能发往其它地址）、429 单列限流语义。 */
export async function fetchApiJson(input: {
  url: string; label: string; headers?: Record<string, string> | undefined; fetchImpl: HttpFetch; signal?: AbortSignal | undefined;
}): Promise<unknown> {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  try {
    const response = await input.fetchImpl(input.url, {
      ...(input.headers ? { headers: input.headers } : {}),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      redirect: "manual",
    });
    // 凭据只发固定 API 入口；入口出现重定向时不带 Key 跟随，直接拒绝。
    if (response.status >= 300 && response.status < 400) {
      throw new StockUnavailableError(`${input.label} API 入口出现重定向，本次不跟随。`);
    }
    if (response.status === 429) throw new StockUnavailableError(`${input.label} 暂时限流，请稍后重试。`);
    if (!response.ok) throw new StockUnavailableError(`${input.label} 请求失败（HTTP ${response.status}）。`);
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof StockUnavailableError) throw error;
    if (input.signal?.aborted) throw error;
    throw new StockUnavailableError(`${input.label} 暂时不可用，请稍后重试。`);
  }
}

export interface StockDownloadRules {
  /** 默认按固定域名集合逐跳校验；Internet Archive 这类官方节点下载另给判定函数。 */
  mediaHosts?: ReadonlySet<string> | undefined;
  isAllowedHost?: ((host: string) => boolean) | undefined;
}

/** 受控下载：域名逐跳复核（含每次重定向）、content-length 预检、流式字节上限、回调式落盘。 */
export async function downloadWithinBounds(input: {
  url: string; rules: StockDownloadRules; maxBytes: number; fetchImpl: HttpFetch; signal?: AbortSignal | undefined;
}, sink: (stream: ReadableStream<Uint8Array>, response: Response) => Promise<void>): Promise<void> {
  const allowed = (host: string): boolean => input.rules.isAllowedHost ? input.rules.isAllowedHost(host)
    : (input.rules.mediaHosts?.has(host) ?? false);
  let current = input.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== "https:" || !allowed(target.host)) {
      throw new StockUnavailableError("素材下载地址不在该来源允许的媒体域名内。");
    }
    let received = 0;
    try {
      const response = await input.fetchImpl(current, { ...(input.signal ? { signal: input.signal } : {}), redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new StockUnavailableError("素材重定向缺少目标地址。");
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok || !response.body) throw new StockUnavailableError(`素材下载失败（HTTP ${response.status}）。`);
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isSafeInteger(declared) && declared > input.maxBytes) throw new StockUnavailableError("素材文件超过大小上限。");
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller2) {
          received += chunk.byteLength;
          if (received > input.maxBytes) controller2.error(new StockUnavailableError("素材文件超过大小上限。"));
          else controller2.enqueue(chunk);
        },
      }));
      await sink(body as ReadableStream<Uint8Array>, response);
      return;
    } catch (error) {
      if (error instanceof StockUnavailableError) throw error;
      if (input.signal?.aborted) throw error;
      throw new StockUnavailableError("素材下载暂时不可用，请稍后重试。");
    }
  }
  throw new StockUnavailableError("素材下载重定向次数过多。");
}
