import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ProductionArticleSourceSnapshot } from "@video-factory/production-pipeline";
import {
  canonicalExternalUrl,
  DEFAULT_MAX_BODY_BYTES,
  ExternalPageFetcher,
  type HostLookup,
  type PinnedRequester,
} from "./external-page.js";

const EXTRACTOR_VERSION = "readability-v1";
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;
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
  lookup?: HostLookup;
  request?: PinnedRequester;
  timeoutMs?: number;
  batchTimeoutMs?: number;
}

export class TrendArticleReader {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly batchTimeoutMs: number;
  private readonly fetcher: ExternalPageFetcher;
  private readonly inFlight = new Map<string, Promise<TrendArticleSnapshot>>();

  constructor(private readonly options: TrendArticleReaderOptions) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 60_000;
    // 出网防护（DNS 固定、内网段拦截、逐跳重定向复检、解压后体积上限）由共享内核提供，
    // 案例源与原文本阅读器共用同一份实现，不回退成两套各自演化的安全代码。
    this.fetcher = new ExternalPageFetcher({
      ...(options.lookup ? { lookup: options.lookup } : {}),
      ...(options.request ? { request: options.request } : {}),
    });
  }

  async read(
    input: { sourceId: string; url: string; title?: string },
    force = false,
    signal?: AbortSignal,
  ): Promise<TrendArticleSnapshot> {
    const canonical = canonicalExternalUrl(input.url);
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
      const response = await this.fetchHtml(originalUrl, Date.now() + this.timeoutMs, signal);
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

  private async fetchHtml(url: string, deadline: number, signal?: AbortSignal): Promise<{ finalUrl: string; html: string }> {
    const page = await this.fetcher.fetch(url, {
      deadline,
      maxBytes: MAX_BODY_BYTES,
      accept: "text/html,text/plain;q=0.8",
      signal,
    });
    return { finalUrl: page.finalUrl, html: page.body };
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
