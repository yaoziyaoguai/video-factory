import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StudioCaseDetail,
  StudioCaseMetric,
  StudioCaseSourceId,
  StudioCaseSummary,
  StudioCaseTranscript,
} from "../shared/api.js";
import { ExternalPageFetcher, type HostLookup, type PinnedRequester } from "./external-page.js";

// 案例源接线：真实外部内容，不是夹具。
//
// 已核实的取数事实（2026-09-16 实测）：
// - TED：列表来自 https://www.ted.com/topics/<slug> 的 __NEXT_DATA__.props.pageProps.talks，
//   正文来自谈论页同位置的 transcriptData.translation.paragraphs[].cues[].text —— 是原站
//   自己发布的逐字稿，无需任何凭据。TED 的 ?page / ?sort / ?q / ?language 参数都是客户端
//   渲染，服务端只对 /topics/<slug> 返回可变内容，所以目录靠"话题货架"扩量而不是翻页。
// - 哔哩哔哩：https://api.bilibili.com/x/web-interface/ranking/v2 无需登录即返回真实条目与
//   公开指标；但字幕接口在未登录时返回空数组（subtitles: []），所以 B 站只提供视频案例，
//   拿不到正文。这个区别必须在界面上如实标出，不能把"仅有视频信息"写成"已获取脚本"。

const NEXT_DATA_PATTERN = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

// 话题货架是"浏览配置"，不是内容：真正的内容永远来自当次请求。跨行业取样，
// 避免把案例库钉死在某一个垂类上。
const TED_TOPIC_SHELVES = ["ai", "science", "storytelling", "psychology", "business", "design"] as const;

export const TED_USAGE_NOTE = "TED 演讲依 CC BY-NC-ND 4.0 发布：可注明出处并链接原站分享，不得商用，不得剪辑、改写或改编。此处仅作创作参考，不作为成片素材。";
export const BILIBILI_USAGE_NOTE = "内容版权归原作者与哔哩哔哩所有，此处只保存公开元数据并链接原站，未下载、未转载、未改写；如需使用请自行取得授权。";
const BILIBILI_TRANSCRIPT_REASON = "哔哩哔哩的字幕接口在未登录时返回空字幕列表，本工具不绕过登录或访问控制，因此无法自动取得该视频的正文字幕。";

export interface CaseSourceOptions {
  fetcher?: ExternalPageFetcher;
  lookup?: HostLookup;
  request?: PinnedRequester;
  now?: () => Date;
  /** 单次列表抓取的总预算；超过即如实报告部分结果。 */
  listTimeoutMs?: number;
  /** 同一来源两次请求之间的最小间隔，避免把对方站点当成无限资源。 */
  minRequestIntervalMs?: number;
}

export interface CaseListResult {
  items: StudioCaseSummary[];
  /** 来源级失败原因；成功时为空。一个来源失败不得影响其它来源。 */
  failure?: string;
}

export interface CaseSource {
  readonly sourceId: StudioCaseSourceId;
  readonly label: string;
  list(options?: { signal?: AbortSignal }): Promise<CaseListResult>;
  readDetail(item: StudioCaseSummary, options?: { signal?: AbortSignal; force?: boolean }): Promise<StudioCaseDetail>;
}

export class TedCaseSource implements CaseSource {
  readonly sourceId = "ted" as const;
  readonly label = "TED";
  private readonly fetcher: ExternalPageFetcher;
  private readonly now: () => Date;
  private readonly listTimeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private lastRequestAt = 0;

  constructor(options: CaseSourceOptions = {}) {
    this.fetcher = options.fetcher ?? new ExternalPageFetcher(sharedFetcherOptions(options));
    this.now = options.now ?? (() => new Date());
    this.listTimeoutMs = options.listTimeoutMs ?? 60_000;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 250;
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<CaseListResult> {
    const deadline = Date.now() + this.listTimeoutMs;
    // 主列表 + 话题货架：任一个失败都只丢自己那一部分，不整体失败。
    const targets = ["https://www.ted.com/talks", ...TED_TOPIC_SHELVES.map((topic) => `https://www.ted.com/topics/${topic}`)];
    const seen = new Map<string, StudioCaseSummary>();
    const failures: string[] = [];
    for (const url of targets) {
      if (Date.now() >= deadline) {
        failures.push("TED 列表抓取超过本次时间预算，只返回了已取得的部分。");
        break;
      }
      try {
        const talks = await this.fetchTalks(url, deadline, options.signal);
        for (const talk of talks) {
          if (!seen.has(talk.id)) seen.set(talk.id, talk);
        }
      } catch (error) {
        failures.push(`${url.replace("https://www.ted.com/", "")}：${errorMessage(error)}`);
      }
    }
    return {
      items: [...seen.values()],
      ...(failures.length > 0 && seen.size === 0 ? { failure: failures.join("；") } : {}),
    };
  }

  async readDetail(item: StudioCaseSummary, options: { signal?: AbortSignal } = {}): Promise<StudioCaseDetail> {
    const slug = item.id.replace(/^ted:/, "");
    const url = `https://www.ted.com/talks/${slug}`;
    try {
      const page = await this.fetchPage(url, Date.now() + this.listTimeoutMs, options.signal);
      const payload = nextDataPayload(page);
      const transcript = tedTranscript(payload);
      if (!transcript) {
        return {
          item: { ...item, contentState: "video_only", contentTypeLabel: "仅视频信息" },
          transcript: { state: "unavailable", paragraphs: [], truncated: false, reason: "该谈论页没有提供原站逐字稿。", usageNote: TED_USAGE_NOTE },
        };
      }
      const language = transcript.language;
      const enriched: StudioCaseSummary = {
        ...item,
        contentState: "transcript",
        contentTypeLabel: "原站逐字稿",
        ...(language ? { language } : {}),
      };
      return {
        item: enriched,
        transcript: {
          state: transcript.truncated ? "partial" : "read",
          ...(language ? { language } : {}),
          fetchedAt: this.now().toISOString(),
          paragraphs: transcript.paragraphs,
          truncated: transcript.truncated,
          usageNote: TED_USAGE_NOTE,
        },
      };
    } catch (error) {
      return {
        item,
        transcript: {
          state: "unavailable",
          paragraphs: [],
          truncated: false,
          reason: `未能读取原站逐字稿：${errorMessage(error)}`,
          usageNote: TED_USAGE_NOTE,
        },
      };
    }
  }

  private async fetchTalks(url: string, deadline: number, signal?: AbortSignal): Promise<StudioCaseSummary[]> {
    const payload = nextDataPayload(await this.fetchPage(url, deadline, signal));
    const talks = (payload.props as { pageProps?: { talks?: unknown } } | undefined)?.pageProps?.talks;
    if (!Array.isArray(talks)) throw new Error("页面结构里没有谈论列表。");
    const fetchedAt = this.now().toISOString();
    return talks.flatMap((talk) => {
      const summary = tedSummary(talk, fetchedAt);
      return summary ? [summary] : [];
    });
  }

  private async fetchPage(url: string, deadline: number, signal?: AbortSignal): Promise<string> {
    const wait = this.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const page = await this.fetcher.fetch(url, { deadline, accept: "text/html", signal });
    return page.body;
  }
}

export class BilibiliCaseSource implements CaseSource {
  readonly sourceId = "bilibili" as const;
  readonly label = "哔哩哔哩";
  private readonly fetcher: ExternalPageFetcher;
  private readonly now: () => Date;
  private readonly listTimeoutMs: number;
  private lastRequestAt = 0;
  private readonly minRequestIntervalMs: number;

  constructor(options: CaseSourceOptions = {}) {
    this.fetcher = options.fetcher ?? new ExternalPageFetcher(sharedFetcherOptions(options));
    this.now = options.now ?? (() => new Date());
    this.listTimeoutMs = options.listTimeoutMs ?? 30_000;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 400;
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<CaseListResult> {
    try {
      const page = await this.fetchJson(
        "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
        Date.now() + this.listTimeoutMs,
        options.signal,
      );
      const list = (page as { data?: { list?: unknown } }).data?.list;
      if (!Array.isArray(list)) throw new Error("接口没有返回排行榜列表。");
      const fetchedAt = this.now().toISOString();
      const items = list.flatMap((entry) => {
        const summary = bilibiliSummary(entry, fetchedAt);
        return summary ? [summary] : [];
      });
      if (items.length === 0) throw new Error("排行榜返回了 0 条可用条目。");
      return { items };
    } catch (error) {
      return { items: [], failure: `哔哩哔哩排行榜暂时不可用：${errorMessage(error)}` };
    }
  }

  // B 站没有可自动取得的正文（未登录字幕为空），这里不假装去取一次再失败：
  // 直接如实说明拿不到，并把条目保持为"仅有视频信息"。
  async readDetail(item: StudioCaseSummary): Promise<StudioCaseDetail> {
    const transcript: StudioCaseTranscript = {
      state: "unavailable",
      paragraphs: [],
      truncated: false,
      reason: BILIBILI_TRANSCRIPT_REASON,
      usageNote: BILIBILI_USAGE_NOTE,
    };
    return { item: { ...item, contentState: "video_only", contentTypeLabel: "仅视频信息" }, transcript };
  }

  private async fetchJson(url: string, deadline: number, signal?: AbortSignal): Promise<unknown> {
    const wait = this.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const page = await this.fetcher.fetch(url, {
      deadline,
      accept: "application/json",
      allowContentTypes: ["application/json", "text/plain"],
      signal,
    });
    const parsed = JSON.parse(page.body) as { code?: number; message?: string };
    if (typeof parsed.code === "number" && parsed.code !== 0) {
      throw new Error(`接口返回 code=${parsed.code}${parsed.message ? `（${parsed.message}）` : ""}`);
    }
    return parsed;
  }
}

function sharedFetcherOptions(options: CaseSourceOptions): ConstructorParameters<typeof ExternalPageFetcher>[0] {
  return {
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.request ? { request: options.request } : {}),
    userAgent: "VideoFactoryCaseReader/1.0",
  };
}

function nextDataPayload(html: string): Record<string, unknown> {
  const match = html.match(NEXT_DATA_PATTERN);
  if (!match) throw new Error("页面里没有可解析的数据块。");
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    throw new Error("页面数据块不是合法 JSON。");
  }
}

interface TedTranscript {
  language?: string;
  paragraphs: Array<{ id: string; text: string }>;
  truncated: boolean;
}

// 8000 字既是阅读器的显示上限，也是 articleSources 的合同上限（body evidence 与 readStatus
// 必须一致）。两处用同一个数，摘录进规划时才不会因为超限被拒。
const TED_MAX_TRANSCRIPT_CHARS = 8_000;

function tedTranscript(payload: Record<string, unknown>): TedTranscript | undefined {
  const pageProps = (payload.props as { pageProps?: Record<string, unknown> } | undefined)?.pageProps;
  const transcriptData = pageProps?.transcriptData as { translation?: unknown } | undefined;
  const translation = transcriptData?.translation as
    | { language?: { internalLanguageCode?: unknown }; paragraphs?: unknown }
    | undefined;
  if (!translation || !Array.isArray(translation.paragraphs)) return undefined;
  const paragraphs: Array<{ id: string; text: string }> = [];
  let total = 0;
  let truncated = false;
  for (const paragraph of translation.paragraphs) {
    const cues = (paragraph as { cues?: unknown }).cues;
    if (!Array.isArray(cues)) continue;
    // 原站的一个段落由多条 cue 组成；按段落合并，而不是把每条 cue 当一段——
    // 逐字稿的语义单位是段落，而且 articleSources 的段落数上限是 128。
    const text = cues
      .map((cue) => (typeof (cue as { text?: unknown }).text === "string" ? (cue as { text: string }).text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (total + text.length > TED_MAX_TRANSCRIPT_CHARS) {
      const remaining = TED_MAX_TRANSCRIPT_CHARS - total;
      if (remaining >= 8) paragraphs.push({ id: `p${paragraphs.length + 1}`, text: text.slice(0, remaining) });
      truncated = true;
      break;
    }
    total += text.length;
    paragraphs.push({ id: `p${paragraphs.length + 1}`, text });
  }
  if (paragraphs.length === 0) return undefined;
  const code = translation.language?.internalLanguageCode;
  return {
    ...(typeof code === "string" && code ? { language: code } : {}),
    paragraphs,
    truncated,
  };
}

function tedSummary(value: unknown, metricsFetchedAt: string): StudioCaseSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const talk = value as Record<string, unknown>;
  const slug = typeof talk.slug === "string" ? talk.slug : "";
  const title = typeof talk.title === "string" ? talk.title.trim() : "";
  if (!slug || !title) return undefined;
  const url = typeof talk.canonicalUrl === "string" && talk.canonicalUrl ? talk.canonicalUrl : `https://www.ted.com/talks/${slug}`;
  const topics = Array.isArray((talk.topics as { nodes?: unknown } | undefined)?.nodes)
    ? ((talk.topics as { nodes: Array<{ name?: unknown }> }).nodes)
      .map((node) => (typeof node.name === "string" ? node.name : ""))
      .filter(Boolean)
    : [];
  const author = typeof talk.presenterDisplayName === "string" ? talk.presenterDisplayName.trim() : "";
  const publishedAt = typeof talk.publishedAt === "string" && Number.isFinite(Date.parse(talk.publishedAt)) ? talk.publishedAt : undefined;
  const duration = typeof talk.duration === "number" && Number.isFinite(talk.duration) ? talk.duration : undefined;
  const description = typeof talk.description === "string" ? talk.description.trim() : "";
  return {
    id: `ted:${slug}`,
    sourceId: "ted",
    sourceLabel: "TED",
    title,
    originalUrl: url,
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    topics: topics.slice(0, 4),
    contentState: "unread",
    contentTypeLabel: "未读取正文",
    ...(description ? { summary: description } : {}),
    metrics: metric("播放量", talk.viewedCount),
    metricsFetchedAt,
    usageNote: TED_USAGE_NOTE,
  };
}

function bilibiliSummary(value: unknown, metricsFetchedAt: string): StudioCaseSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const bvid = typeof entry.bvid === "string" ? entry.bvid : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (!bvid || !title) return undefined;
  const owner = (entry.owner as { name?: unknown } | undefined)?.name;
  const stat = (entry.stat ?? {}) as Record<string, unknown>;
  const duration = typeof entry.duration === "number" && Number.isFinite(entry.duration) ? entry.duration : undefined;
  const pubdate = typeof entry.pubdate === "number" && Number.isFinite(entry.pubdate) ? new Date(entry.pubdate * 1000).toISOString() : undefined;
  const description = typeof entry.desc === "string" ? entry.desc.trim() : "";
  const topic = typeof entry.tname === "string" ? entry.tname.trim() : "";
  return {
    id: `bilibili:${bvid}`,
    sourceId: "bilibili",
    sourceLabel: "哔哩哔哩",
    title,
    originalUrl: `https://www.bilibili.com/video/${bvid}`,
    ...(typeof owner === "string" && owner ? { author: owner } : {}),
    ...(pubdate ? { publishedAt: pubdate } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    // 排行榜接口不提供语言字段；这里不猜，留空由正文步骤或界面标注"未标注"。
    topics: topic ? [topic] : [],
    contentState: "video_only",
    contentTypeLabel: "仅视频信息",
    ...(description ? { summary: description } : {}),
    metrics: [
      ...metric("播放量", stat.view),
      ...metric("点赞", stat.like),
      ...metric("弹幕", stat.danmaku),
      ...metric("评论", stat.reply),
      ...metric("收藏", stat.favorite),
      ...metric("分享", stat.share),
    ],
    metricsFetchedAt,
    usageNote: BILIBILI_USAGE_NOTE,
  };
}

// 指标缺失就不出现。补 0 会把"没取到"写成"没有人看"，那是编造出来的结论。
function metric(label: string, value: unknown): StudioCaseMetric[] {
  return typeof value === "number" && Number.isFinite(value) ? [{ label, value }] : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error);
}

export interface CaseContentCacheOptions {
  cacheRoot: string;
  now?: () => Date;
  /** 各来源的缓存时长按来源规则给，不写成永久。 */
  ttlMs?: Record<StudioCaseSourceId, number>;
}

export const DEFAULT_CASE_CACHE_TTL_MS: Record<StudioCaseSourceId, number> = {
  ted: 6 * 60 * 60 * 1_000,
  bilibili: 30 * 60 * 1_000,
};

/** 已读正文的落盘缓存：同一谈论不重复抓取，且让"已有正文"在刷新后仍然成立。 */
export class CaseContentCache {
  private readonly now: () => Date;
  private readonly ttlMs: Record<StudioCaseSourceId, number>;

  constructor(private readonly options: CaseContentCacheOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_CASE_CACHE_TTL_MS;
  }

  async read(sourceId: StudioCaseSourceId, caseId: string): Promise<StudioCaseDetail | undefined> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(sourceId, caseId), "utf8")) as StudioCaseDetail;
      const age = this.now().getTime() - Date.parse(value.transcript.fetchedAt ?? "");
      // 没读到正文的结果不缓存：否则一次网络抖动会被当成"该来源没有正文"长期生效。
      if (value.transcript.state === "unavailable" || !Number.isFinite(age)) return undefined;
      return age >= 0 && age < this.ttlMs[sourceId] ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async write(sourceId: StudioCaseSourceId, caseId: string, value: StudioCaseDetail): Promise<void> {
    if (value.transcript.state === "unavailable") return;
    const target = this.pathFor(sourceId, caseId);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, target);
    } catch {
      // 正文缓存写失败不影响本次阅读；下一次重新抓取即可。
    }
  }

  private pathFor(sourceId: StudioCaseSourceId, caseId: string): string {
    const key = createHash("sha256").update(`${sourceId}:${caseId}`).digest("hex");
    return path.join(this.options.cacheRoot, `${key}.json`);
  }
}

export function caseSources(options: CaseSourceOptions = {}): CaseSource[] {
  return [new TedCaseSource(options), new BilibiliCaseSource(options)];
}
