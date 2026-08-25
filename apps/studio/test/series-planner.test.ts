import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SeriesPlanner } from "../src/server/series-planner.js";
import type { SeriesRecord } from "../src/server/series-store.js";

const series: SeriesRecord = {
  id: "series-1",
  name: "AI 下班实验室",
  premise: "每集验证一个普通人下班后真能用上的 AI 方法。",
  audience: "想节省时间的普通上班族",
  platform: "douyin",
  category: "technology",
  track: "ai-after-work",
  pillars: ["真实任务实验", "成本与时间复盘"],
  tone: "克制、具体、有结论",
  visualStyle: "真实桌面操作与生活空镜",
  status: "active",
  nextEpisodeNumber: 4,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
};

describe("SeriesPlanner", () => {
  it("turns a durable series promise into numbered, production-ready candidates", () => {
    const candidates = new SeriesPlanner({ now: () => new Date("2026-08-24T09:00:00.000Z") })
      .plan(series, 4);

    assert.equal(candidates.length, 4);
    assert.deepEqual(candidates.map((item) => item.episodeNumber), [4, 5, 6, 7]);
    assert.equal(candidates[0]?.origin, "series");
    assert.equal(candidates[0]?.category, "technology");
    assert.equal(candidates[0]?.seriesId, "series-1");
    assert.match(candidates[0]?.title ?? "", /AI 下班实验室 04/);
    assert.equal(candidates.every((item) => item.evidence[0]?.source === "series-plan"), true);
    assert.match(candidates[0]?.visualPlan?.strategy ?? "", /真实桌面操作与生活空镜/);
    assert.equal(candidates[0]?.visualPlan?.beats.length, 3);
  });
});
