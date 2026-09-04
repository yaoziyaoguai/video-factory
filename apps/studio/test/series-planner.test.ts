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
  revision: 1,
  currentSeason: { number: 1, title: "第一季", arc: "从工具尝鲜走到稳定工作流" },
  bible: { rules: ["必须验证真实任务"], recurringElements: ["桌面操作"], forbiddenChanges: ["不得虚构结果"] },
  canon: { revision: 0, facts: [] },
  episodes: [],
  nextEpisodeNumber: 1,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
};

describe("SeriesPlanner", () => {
  it("materializes an ordered episode roadmap before projecting candidates", () => {
    const planner = new SeriesPlanner({ now: () => new Date("2026-08-24T09:00:00.000Z") });
    const episodes = planner.planEpisodes(series, 4);
    const candidates = planner.plan({ ...series, episodes }, 4);

    assert.deepEqual(episodes.map((item) => item.episodeNumber), [1, 2, 3, 4]);
    assert.equal(episodes[1]?.previousEpisodeId, episodes[0]?.id);
    assert.equal(episodes.every((item) => item.canonBaseRevision === 0), true);
    assert.equal(episodes.every((item) => item.planning.source === "rules"), true);
    assert.equal(candidates[0]?.seriesSequence?.status, "ready");
    assert.deepEqual(candidates.slice(1).map((item) => item.seriesSequence), [
      { status: "blocked", blockedByEpisodeNumber: 1 },
      { status: "blocked", blockedByEpisodeNumber: 1 },
      { status: "blocked", blockedByEpisodeNumber: 1 },
    ]);
    assert.equal(candidates[0]?.providerId, "series-roadmap-v2");
    assert.match(candidates[0]?.hook ?? "", /第 1 集|可复核结果/);
    assert.equal(candidates[0]?.evidence[0]?.source, "系列路线图「AI 下班实验室」第 1 集");
    assert.equal(
      candidates[0]?.evidence[0]?.evidenceUrl,
      "https://video.wangjinkun333.me/topics?mode=series&candidate=series-series-1-episode-001",
    );
    assert.match(candidates[0]?.visualPlan?.strategy ?? "", /真实桌面操作与生活空镜/);
  });
});
