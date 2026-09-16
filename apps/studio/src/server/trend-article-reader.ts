import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ProductionArticleSourceSnapshot } from "@video-factory/production-pipeline";

const EXTRACTOR_VERSION = "readability-v1";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 8_000;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 10 * 60 * 1_000;

export type TrendArticleReadStatus = "read" | "partial" | "title_only" | "blocked" | "failed";

export interface TrendArticleSnapshot extends Omit<ProductionArticleSourceSnapshot, "extractorVersion" | "readStatus"> {
  extractorVersion: typeof EXTRACTOR_VERSION;
  readStatus: TrendArticleReadStatus;
}

export interface TrendArticleReaderOptions {
  cacheRoot: string;
  now?: () => Date;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof requestPinned;
  timeoutMs?: number;
  batchTimeoutMs?: number;
}

export class TrendArticleReader {
  private readonly now: () => Date;
  private readonly lookup: NonNullable<TrendArticleReaderOptions["lookup"]>;
  private readonly timeoutMs: number;
  private readonly batchTimeoutMs: number;
  private readonly request: typeof requestPinned;
  private readonly inFlight = new Map<string, Promise<TrendArticleSnapshot>>();

  constructor(private readonly options: TrendArticleReaderOptions) {
    this.now = options.now ?? (() => new Date());
    this.lookup = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 60_000;
    this.request = options.request ?? requestPinned;
  }

  async read(
    input: { sourceId: string; url: string; title?: string },
    force = false,
    signal?: AbortSignal,
  ): Promise<TrendArticleSnapshot> {
    const canonical = canonicalArticleUrl(input.url);
    const key = `${EXTRACTOR_VERSION}:${canonical}`;
    if (!force) {
      const cached = await this.readCache(key);
      if (cached) return bindSnapshotToSource(cached, input.sourceId);
    }
    const existing = this.inFlight.get(key);
    if (existing) return bindSnapshotToSource(await existing, input.sourceId);
    const operation = this.fetchAndExtract(input.sourceId, canonical, input.title ?? "", signal)
      .then(async (result) => {
        await this.writeCache(key, result);
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return bindSnapshotToSource(await operation, input.sourceId);
  }

  async readMany(inputs: Array<{ sourceId: string; url: string; title?: string }>): Promise<TrendArticleSnapshot[]> {
    const unique = inputs.slice(0, 16);
    const results = new Array<TrendArticleSnapshot>(unique.length);
    let cursor = 0;
    const deadline = Date.now() + this.batchTimeoutMs;
    const controller = new AbortController();
    // 这两个 deadline 定时器都不能 unref：它们是把在途读取判定为超时的唯一凭据。
    // unref 后事件循环可以在定时器触发前退出，await 中的批次就永远不会落定
    // （只剩桩实现、没有真实 socket 的调用方会先撞上这一点）。
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
        while (cursor < unique.length && Date.now() < deadline && !controller.signal.aborted) {
          const index = cursor++;
          const item = unique[index]!;
          try {
            results[index] = await settleBeforeDeadline(this.read(item, false, controller.signal), deadline, controller);
          } catch (error) {
            results[index] = failureSnapshot(item.sourceId, item.url, item.title ?? "", this.now(), error);
          }
        }
      }));
    } finally {
      clearTimeout(deadlineTimer);
    }
    for (let index = 0; index < unique.length; index += 1) {
      if (!results[index]) {
        const item = unique[index]!;
        results[index] = failureSnapshot(item.sourceId, item.url, item.title ?? "", this.now(), new Error("本批原文读取已到总时间上限。"));
      }
    }
    return results;
  }

  private async fetchAndExtract(sourceId: string, originalUrl: string, fallbackTitle: string, signal?: AbortSignal): Promise<TrendArticleSnapshot> {
    try {
      const response = await this.fetchHtml(originalUrl, 0, Date.now() + this.timeoutMs, signal);
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM(response.html, { url: response.finalUrl, virtualConsole });
      const pageTitle = dom.window.document.title.trim() || fallbackTitle;
      const visibleText = dom.window.document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (looksBlocked(pageTitle, visibleText)) {
        return baseSnapshot(sourceId, originalUrl, response.finalUrl, pageTitle, this.now(), "blocked", "页面需要登录、验证或不是可辨认的文章正文。", [], false);
      }
      const article = new Readability(dom.window.document).parse();
      if (!article?.content || (article.textContent?.trim().length ?? 0) < 160) {
        return baseSnapshot(sourceId, originalUrl, response.finalUrl, pageTitle, this.now(), "title_only", "未提取到足以辨认文章的正文。", [], false);
      }
      const articleDom = new JSDOM(article.content, { virtualConsole });
      const rawParagraphs = [...articleDom.window.document.querySelectorAll("p, li")]
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter((text) => text.length >= 8);
      const paragraphs: TrendArticleSnapshot["paragraphs"] = [];
      let total = 0;
      let truncated = false;
      for (const text of rawParagraphs) {
        if (total + text.length > MAX_EXCERPT_CHARS) {
          truncated = true;
          const remaining = MAX_EXCERPT_CHARS - total;
          if (remaining >= 8) paragraphs.push({ id: `p${paragraphs.length + 1}`, text: text.slice(0, remaining) });
          break;
        }
        paragraphs.push({ id: `p${paragraphs.length + 1}`, text });
        total += text.length;
      }
      if (paragraphs.length === 0) {
        return baseSnapshot(sourceId, originalUrl, response.finalUrl, pageTitle, this.now(), "title_only", "正文结构无法形成可引用段落。", [], false);
      }
      const content = paragraphs.map((paragraph) => `${paragraph.id}:${paragraph.text}`).join("\n");
      return {
        ...baseSnapshot(sourceId, originalUrl, response.finalUrl, pageTitle, this.now(), truncated ? "partial" : "read", truncated ? "正文摘录已达到单篇上限。" : undefined, paragraphs, truncated),
        contentSha256: createHash("sha256").update(content).digest("hex"),
      };
    } catch (error) {
      return failureSnapshot(sourceId, originalUrl, fallbackTitle, this.now(), error);
    }
  }

  private async fetchHtml(url: string, redirects: number, deadline: number, signal?: AbortSignal): Promise<{ finalUrl: string; html: string }> {
    if (redirects > 3) throw new Error("原文重定向次数超过 3 次。 ");
    const parsed = new URL(canonicalArticleUrl(url));
    const addresses = await this.lookup(parsed.hostname);
    if (addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry.address))) {
      throw new Error("原文地址解析到不可访问的内部或保留网络。 ");
    }
    const address = addresses[0]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("原文读取超时。 ");
    if (signal?.aborted) throw new Error("本批原文读取已到总时间上限。");
    const response = await this.request(parsed, address, remaining, signal);
    try {
    const statusCode = response.statusCode ?? 0;
    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers.location;
      if (!location) throw new Error("原文重定向缺少目标地址。 ");
      return this.fetchHtml(new URL(location, parsed).toString(), redirects + 1, deadline, signal);
    }
    if (statusCode < 200 || statusCode >= 300) throw new Error(`原文服务返回 ${statusCode || "未知状态"}。`);
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) throw new Error("原文不是可读取的网页文本。 ");
    return { finalUrl: parsed.toString(), html: await readDecodedBody(response, MAX_BODY_BYTES) };
    } finally {
      // 重定向、格式拒绝、解压超限也必须释放原连接，不能只销毁解压后的派生流。
      response.destroy();
    }
  }

  private async readCache(key: string): Promise<TrendArticleSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(this.cachePath(key), "utf8")) as TrendArticleSnapshot;
      const age = this.now().getTime() - Date.parse(value.fetchedAt);
      const ttl = value.readStatus === "read" || value.readStatus === "partial" ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
      return age >= 0 && age < ttl ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, value: TrendArticleSnapshot): Promise<void> {
    await mkdir(this.options.cacheRoot, { recursive: true });
    const target = this.cachePath(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private cachePath(key: string): string {
    return path.join(this.options.cacheRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
}

function canonicalArticleUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("原文 URL 只支持不含凭据的 HTTP/HTTPS。 ");
  if ((url.protocol === "http:" && url.port && url.port !== "80") || (url.protocol === "https:" && url.port && url.port !== "443")) throw new Error("原文 URL 不支持非标准端口。 ");
  url.hash = "";
  return url.toString();
}

function isForbiddenAddress(address: string): boolean {
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

function requestPinned(
  url: URL,
  address: { address: string; family: number },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<http.IncomingMessage> {
  const request = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      headers: { accept: "text/html,text/plain;q=0.8", "user-agent": "VideoFactoryArticleReader/1.0" },
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

async function settleBeforeDeadline<T>(operation: Promise<T>, deadline: number, controller: AbortController): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw new Error("本批原文读取已到总时间上限。");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("本批原文读取已到总时间上限。"));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bindSnapshotToSource(snapshot: TrendArticleSnapshot, sourceId: string): TrendArticleSnapshot {
  return snapshot.sourceId === sourceId ? snapshot : { ...structuredClone(snapshot), sourceId };
}

async function readDecodedBody(response: http.IncomingMessage, maxBytes: number): Promise<string> {
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
      throw new Error("原文解压后超过 2 MiB 上限。 ");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function looksBlocked(title: string, text: string): boolean {
  const sample = `${title} ${text.slice(0, 600)}`.toLowerCase();
  return /(登录|验证码|访问受限|安全验证|sign in|log in|captcha|enable javascript)/i.test(sample) && text.length < 2_000;
}

function baseSnapshot(sourceId: string, originalUrl: string, finalUrl: string, pageTitle: string, now: Date, readStatus: TrendArticleReadStatus, reason: string | undefined, paragraphs: TrendArticleSnapshot["paragraphs"], truncated: boolean): TrendArticleSnapshot {
  return { sourceId, originalUrl, finalUrl, pageTitle, fetchedAt: now.toISOString(), extractorVersion: EXTRACTOR_VERSION, readStatus, ...(reason ? { reason } : {}), paragraphs, truncated };
}

function failureSnapshot(sourceId: string, url: string, title: string, now: Date, error: unknown): TrendArticleSnapshot {
  return baseSnapshot(sourceId, url, url, title, now, "failed", error instanceof Error ? error.message.trim() : String(error), [], false);
}
