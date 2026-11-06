import type { ToolReadTrends } from "./generated/contracts.js";

export const MUSIC_CHART_URLS = {
  "douyin-music": "https://dataxapi.com/zh/tools/hot-search/douyin/music/",
  "tiktok-sounds": "https://kabo.sh/tools/trending-tiktok-sounds",
} as const satisfies Record<NonNullable<ToolReadTrends["musicChart"]>, string>;
