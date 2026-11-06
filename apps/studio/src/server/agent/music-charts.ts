import { JSDOM } from "jsdom";
import type { TrendItem, TrendSnapshot } from "../../shared/agent/generated/contracts.js";
import { MUSIC_CHART_URLS } from "../../shared/agent/music-charts.js";
import { digestOf } from "./util.js";

export async function readMusicChart(
  sourceId: keyof typeof MUSIC_CHART_URLS, limit: number, fetchImpl: typeof fetch = fetch, signal?: AbortSignal,
): Promise<TrendSnapshot> {
  const chartUrl = MUSIC_CHART_URLS[sourceId];
  const douyin = sourceId === "douyin-music";
  const linkKind = douyin ? "platform_search" : "platform_sound";
  const unavailable = (error: string): TrendSnapshot => ({ sourceId, chartUrl, linkKind, status: "unavailable", items: [], sourceUpdatedAt: null, error });
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetchImpl(douyin ? chartUrl.slice(0, -1) + ".md" : chartUrl, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: douyin ? "text/markdown" : "text/html" },
    });
    if (!response.ok) return unavailable(`榜单来源返回 HTTP ${response.status}。`);
    const text = await response.text();
    const items: TrendItem[] = [];
    let timestamp: string | undefined;
    if (douyin) {
      const date = text.match(/读取于\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})（北京时间）/);
      if (date) timestamp = `${date[1]}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}T${date[4]!.padStart(2, "0")}:${date[5]}:00+08:00`;
      for (const match of text.matchAll(/^\|\s*([1-9]\d*)\s*\|\s*\[(.+?)\]\((https:\/\/www\.douyin\.com\/search\/[^\s|]+)\)\s*\|/gm)) {
        const [, rank, title, url] = match;
        items.push({ id: digestOf(url), rank: Number(rank), title: title!.slice(0, 300), url: url!, publishedAt: null });
        if (items.length === limit) break;
      }
    } else {
      const page = JSDOM.fragment(text);
      timestamp = page.querySelector("time[datetime]")?.getAttribute("datetime") ?? undefined;
      // 只取公开表格里能点到具体原声的行，不读取登录后解锁的曲目。
      for (const row of page.querySelectorAll<HTMLTableRowElement>("table tbody tr")) {
        const url = row.querySelector("a[href]")?.getAttribute("href") ?? "";
        const soundId = /^https:\/\/www\.tiktok\.com\/music\/[^/?#]+-(\d+)$/u.exec(url)?.[1];
        const rank = Number(row.cells[0]?.textContent);
        const title = row.cells[1]?.textContent.trim();
        if (!soundId || !title || !Number.isInteger(rank) || rank < 1) continue;
        const artist = row.cells[2]?.textContent.trim();
        items.push({ id: soundId, rank, title: title.slice(0, 300), ...(artist ? { artist: artist.slice(0, 300) } : {}), url, publishedAt: null });
        if (items.length === Math.min(limit, 5)) break;
      }
    }
    if (!items.length) return unavailable("来源未返回可识别的公开榜单条目。");
    const time = timestamp ? Date.parse(timestamp) : NaN;
    return { sourceId, chartUrl, linkKind, status: "success", items, sourceUpdatedAt: Number.isFinite(time) ? new Date(time).toISOString() : null, error: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailable("暂时读不到这张榜单，请稍后再试。");
  }
}
