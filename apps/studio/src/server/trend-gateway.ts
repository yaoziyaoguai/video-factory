import { createHash } from "node:crypto";
import type { StudioTrendService, StudioTrendSignal } from "../shared/api.js";

const DEFAULT_PLATFORMS = [
  "douyin",
  "kuaishou",
  "weibo",
  "baidu",
  "toutiao",
  "zhihu",
  "bilibili",
  "thepaper",
  "36kr",
  "ithome",
  "sspai",
  "hupu",
  "tieba",
  "guokr",
];

export interface TrendGatewayOptions {
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
}

interface ListSignalOptions {
  platforms?: string[];
  limit?: number;
}

interface ServiceDefinition {
  id: StudioTrendService["id"];
  label: string;
  kind: StudioTrendService["kind"];
  baseUrl: string;
  healthPath: string;
}

export class TrendGateway {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly services: ServiceDefinition[];

  constructor(options: TrendGatewayOptions = {}) {
    const environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.services = [
      service("trendradar", "TrendRadar", "collector", configuredUrl(environment.VIDEO_FACTORY_TRENDRADAR_URL, "http://127.0.0.1:8080"), "/"),
      service("newsnow", "NewsNow", "aggregator", configuredUrl(environment.VIDEO_FACTORY_NEWSNOW_URL, "http://127.0.0.1:4444"), "/api/s?id=weibo"),
      service("dailyhot", "DailyHotApi", "aggregator", configuredUrl(environment.VIDEO_FACTORY_DAILYHOT_URL, "http://127.0.0.1:6688"), "/douyin"),
      service("rsshub", "RSSHub", "feed", configuredUrl(environment.VIDEO_FACTORY_RSSHUB_URL, "http://127.0.0.1:1200"), "/"),
    ];
  }

  async listServices(): Promise<StudioTrendService[]> {
    return Promise.all(this.services.map(async (definition) => {
      const lastCheckedAt = this.now().toISOString();
      try {
        const response = await this.request(new URL(definition.healthPath, definition.baseUrl));
        if (!response.ok) {
          return statusFrom(definition, "degraded", lastCheckedAt, `HTTP ${response.status}`);
        }
        const itemCount = await responseItemCount(response);
        return {
          ...statusFrom(definition, "ready", lastCheckedAt, "健康检查通过"),
          ...(itemCount === undefined ? {} : { itemCount }),
        };
      } catch (error) {
        return statusFrom(definition, "stopped", lastCheckedAt, errorMessage(error));
      }
    }));
  }

  async listSignals(options: ListSignalOptions = {}): Promise<StudioTrendSignal[]> {
    const platforms = sanitizePlatforms(options.platforms ?? DEFAULT_PLATFORMS);
    const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
    const dailyHot = this.definition("dailyhot");
    const newsNow = this.definition("newsnow");
    const requests = [
      ...platforms.map((platform) => this.readDailyHot(dailyHot, platform)),
      ...platforms.map((platform) => this.readNewsNow(newsNow, platform)),
    ];
    const settled = await Promise.allSettled(requests);
    const signals = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const deduplicated = new Map<string, StudioTrendSignal>();
    for (const signal of signals) {
      const key = `${signal.sourceId}:${signal.platform}:${normalizedTitle(signal.title)}`;
      if (!deduplicated.has(key)) deduplicated.set(key, signal);
    }
    return [...deduplicated.values()]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, limit);
  }

  private async readDailyHot(definition: ServiceDefinition, platform: string): Promise<StudioTrendSignal[]> {
    const response = await this.request(new URL(`/${platform}`, definition.baseUrl));
    if (!response.ok) throw new Error(`DailyHot ${platform}: HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (body.code !== undefined && Number(body.code) !== 200) return [];
    const collectedAt = timestamp(body.updateTime, this.now());
    return array(body.data).flatMap((item, index) => {
      const record = object(item);
      const title = string(record?.title);
      if (!record || !title) return [];
      const url = string(record.url) ?? string(record.mobileUrl);
      const heat = finiteNumber(record.hot);
      return [{
        id: signalId("dailyhot", platform, record.id ?? title),
        sourceId: "dailyhot" as const,
        platform,
        title,
        rank: index + 1,
        collectedAt,
        ...(url ? { url } : {}),
        ...(heat === undefined ? {} : { heat }),
      }];
    });
  }

  private async readNewsNow(definition: ServiceDefinition, platform: string): Promise<StudioTrendSignal[]> {
    const url = new URL("/api/s", definition.baseUrl);
    url.searchParams.set("id", platform);
    const response = await this.request(url);
    if (!response.ok) throw new Error(`NewsNow ${platform}: HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    const collectedAt = timestamp(body.updatedTime, this.now());
    return array(body.items).flatMap((item, index) => {
      const record = object(item);
      const title = string(record?.title);
      if (!record || !title) return [];
      const url = string(record.url) ?? string(record.mobileUrl);
      return [{
        id: signalId("newsnow", platform, record.id ?? title),
        sourceId: "newsnow" as const,
        platform,
        title,
        rank: index + 1,
        collectedAt,
        ...(url ? { url } : {}),
      }];
    });
  }

  private definition(id: StudioTrendService["id"]): ServiceDefinition {
    return this.services.find((candidate) => candidate.id === id)!;
  }

  private request(url: URL): Promise<Response> {
    return this.fetcher(url, {
      headers: { accept: "application/json, text/plain;q=0.8, text/html;q=0.5" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

function configuredUrl(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function service(
  id: ServiceDefinition["id"],
  label: string,
  kind: ServiceDefinition["kind"],
  baseUrl: string,
  healthPath: string,
): ServiceDefinition {
  return { id, label, kind, baseUrl: baseUrl.replace(/\/$/, ""), healthPath };
}

function statusFrom(
  definition: ServiceDefinition,
  status: StudioTrendService["status"],
  lastCheckedAt: string,
  detail: string,
): StudioTrendService {
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    status,
    baseUrl: definition.baseUrl,
    lastCheckedAt,
    detail,
  };
}

async function responseItemCount(response: Response): Promise<number | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  const body = await response.json() as Record<string, unknown>;
  const items = Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : undefined;
  return items?.length;
}

function timestamp(value: unknown, fallback: Date): string {
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function signalId(source: string, platform: string, value: unknown): string {
  return `${source}-${createHash("sha1").update(`${platform}:${String(value)}`).digest("hex").slice(0, 14)}`;
}

function normalizedTitle(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sanitizePlatforms(platforms: string[]): string[] {
  return [...new Set(platforms.map((platform) => platform.trim().toLowerCase()).filter((platform) => /^[a-z0-9-]+$/.test(platform)))];
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
