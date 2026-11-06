import type { TrendSnapshot } from "../../shared/agent/generated/contracts.js";
import type { CapturedNewsNowConfig } from "./free-service-settings.js";

// NewsNow 自托管实例的边界适配：固定 /api/s?id= 路径，逐个来源读取。
// 上游真实形状是 {status,id,updatedTime,items:[...]}；数值时间只按已明确的毫秒处理，
// 条目 pubDate 只接受可明确解释的 ISO，无法确定则 null，不猜秒/毫秒。

const SOURCE_TIMEOUT_MS = 15_000;

interface UpstreamItem {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  pubDate?: unknown;
}

export class NewsNowClient {
  constructor(
    private readonly config: CapturedNewsNowConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 逐个读取选定来源；单个失败只标记该来源 unavailable，不影响其他来源。 */
  async readSources(sourceIds: string[], limit: number, signal?: AbortSignal): Promise<TrendSnapshot[]> {
    const snapshots: TrendSnapshot[] = [];
    for (const sourceId of sourceIds) {
      snapshots.push(await this.readOne(sourceId, limit, signal));
    }
    return snapshots;
  }

  private async readOne(sourceId: string, limit: number, signal: AbortSignal | undefined): Promise<TrendSnapshot> {
    const timeout = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.config.endpoint}/api/s?id=${encodeURIComponent(sourceId)}`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "manual",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return unavailable(sourceId, `来源返回 HTTP ${response.status}。`);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("items" in payload) || !Array.isArray(payload.items)) {
        return unavailable(sourceId, "来源响应格式不可识别。");
      }
      const data = payload as Record<string, unknown>;
      const status = data.status === "cache" ? "cache" : data.status === "success" ? "success" : null;
      if (!status) return unavailable(sourceId, "来源响应状态不可识别。");
      const items: unknown[] = payload.items;
      const selected = items.slice(0, limit);
      const parsedItems = selected.flatMap((item, index) => trendItem(item, index));
      if (parsedItems.length !== selected.length) return unavailable(sourceId, "来源条目格式不可识别。");
      const snapshot: TrendSnapshot = {
        sourceId,
        status,
        sourceUpdatedAt: updatedTimeToIso(data.updatedTime),
        items: parsedItems,
        error: null,
      };
      return snapshot;
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable(sourceId, "来源暂时不可用。");
    }
  }
}

function unavailable(sourceId: string, message: string): TrendSnapshot {
  return { sourceId, status: "unavailable", sourceUpdatedAt: null, items: [], error: message };
}

/** 上游支持毫秒数或字符串；字符串只接受明确带时区的 ISO。 */
function updatedTimeToIso(value: unknown): string | null {
  if (typeof value === "string") return isoOrNull(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function trendItem(value: unknown, index: number): import("../../shared/agent/generated/contracts.js").TrendItem[] {
  if (!value || typeof value !== "object") return [];
  const item = value as UpstreamItem;
  const id = typeof item.id === "number" && Number.isSafeInteger(item.id) ? String(item.id) : item.id;
  if (typeof id !== "string" || !id || id.length > 100) return [];
  if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 300) return [];
  if (typeof item.url !== "string" || item.url.length === 0 || item.url.length > 2048) return [];
  let url: URL;
  try { url = new URL(item.url); } catch { return []; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  return [{
    id,
    title: item.title.trim(),
    url: url.toString(),
    // pubDate 只接受可明确解释的 ISO 字符串；数值语义未核实，不猜秒/毫秒。
    publishedAt: isoOrNull(item.pubDate),
    rank: index + 1,
  }];
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
