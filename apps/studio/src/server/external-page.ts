import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// 从 trend-article-reader 抽出来的共享取数内核：TED / B 站案例源和原文阅读器走同一套
// 出网防护。安全代码一旦有两份，就只有一份会被修——所以这里必须是唯一实现。
//
// 保留的报文文案（"原文 URL…"）是有意的：它既被趋势原文的回归断言钉住，对案例源也成立
// ——相对用户而言，远端那一页就是"原文"。

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export type PinnedAddress = { address: string; family: number };
export type HostLookup = (hostname: string) => Promise<PinnedAddress[]>;

export function canonicalExternalUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("原文 URL 只支持不含凭据的 HTTP/HTTPS。 ");
  if ((url.protocol === "http:" && url.port && url.port !== "80") || (url.protocol === "https:" && url.port && url.port !== "443")) throw new Error("原文 URL 不支持非标准端口。 ");
  url.hash = "";
  return url.toString();
}

export function isForbiddenAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return true;
  const family = net.isIP(address);
  return family === 4
    ? FORBIDDEN_ADDRESSES.check(address, "ipv4")
    : family === 6
      ? FORBIDDEN_ADDRESSES.check(address, "ipv6")
      : true;
}

const FORBIDDEN_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  FORBIDDEN_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:2::", 48], ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as const) {
  FORBIDDEN_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

export function requestPinned(
  url: URL,
  address: PinnedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
  accept = "text/html,text/plain;q=0.8",
  userAgent = "VideoFactoryArticleReader/1.0",
): Promise<http.IncomingMessage> {
  const request = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      headers: { accept, "user-agent": userAgent },
      // DNS 解析结果直接钉进连接：重定向后的每一跳都会重新解析并重新校验，
      // 因此这里固定的是"已校验过的那个地址"，不是"信任过的域名"。
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      servername: url.hostname,
      timeout: timeoutMs,
      signal,
    }, resolve);
    outgoing.once("timeout", () => outgoing.destroy(new Error("原文读取超时。")));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

export type PinnedRequester = typeof requestPinned;

export async function readDecodedBody(response: http.IncomingMessage, maxBytes: number): Promise<string> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  const stream = encoding === "gzip" ? response.pipe(createGunzip())
    : encoding === "deflate" ? response.pipe(createInflate())
      : encoding === "br" ? response.pipe(createBrotliDecompress())
        : response;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new Error(`原文解压后超过 ${maxBytes / (1024 * 1024)} MiB 上限。 `);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface ExternalFetchOptions {
  deadline: number;
  maxBytes?: number;
  accept?: string;
  /** 允许的响应 content-type 前缀；默认只收网页文本。 */
  allowContentTypes?: string[];
  // 显式带上 undefined：本仓库开了 exactOptionalPropertyTypes，调用方透传可选 signal 时
  // 必须允许"给了键、值是 undefined"。
  signal?: AbortSignal | undefined;
}

export interface ExternalPageFetcherOptions {
  lookup?: HostLookup;
  request?: PinnedRequester;
  userAgent?: string;
}

export interface ExternalPage {
  finalUrl: string;
  body: string;
  contentType: string;
}

export class ExternalPageFetcher {
  private readonly lookup: HostLookup;
  private readonly request: PinnedRequester;
  private readonly userAgent: string;

  constructor(options: ExternalPageFetcherOptions = {}) {
    this.lookup = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.request = options.request ?? requestPinned;
    this.userAgent = options.userAgent ?? "VideoFactoryArticleReader/1.0";
  }

  fetch(url: string, options: ExternalFetchOptions): Promise<ExternalPage> {
    return this.fetchWithRedirects(url, 0, options);
  }

  private async fetchWithRedirects(url: string, redirects: number, options: ExternalFetchOptions): Promise<ExternalPage> {
    if (redirects > MAX_REDIRECTS) throw new Error("原文重定向次数超过 3 次。 ");
    const parsed = new URL(canonicalExternalUrl(url));
    const addresses = await this.lookup(parsed.hostname);
    if (addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry.address))) {
      throw new Error("原文地址解析到不可访问的内部或保留网络。 ");
    }
    const address = addresses[0]!;
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error("原文读取超时。 ");
    if (options.signal?.aborted) throw new Error("本批原文读取已到总时间上限。");
    // 超时用调用方给的 deadline 余量，不再叠加一层 timeoutMs：两层预算叠加会让
    // 单篇实际可用时间随批次进度漂移，而 deadline 已经是调用方算好的那个上限。
    const response = await this.request(parsed, address, remaining, options.signal, options.accept, this.userAgent);
    try {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        const location = response.headers.location;
        if (!location) throw new Error("原文重定向缺少目标地址。 ");
        return this.fetchWithRedirects(new URL(location, parsed).toString(), redirects + 1, options);
      }
      if (statusCode < 200 || statusCode >= 300) throw new Error(`原文服务返回 ${statusCode || "未知状态"}。`);
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      const allowed = options.allowContentTypes ?? ["text/html", "text/plain"];
      if (!allowed.some((type) => contentType.includes(type))) throw new Error("原文不是可读取的网页文本。 ");
      return {
        finalUrl: parsed.toString(),
        body: await readDecodedBody(response, options.maxBytes ?? DEFAULT_MAX_BODY_BYTES),
        contentType,
      };
    } finally {
      // 重定向、格式拒绝、解压超限也必须释放原连接，不能只销毁解压后的派生流。
      response.destroy();
    }
  }
}
