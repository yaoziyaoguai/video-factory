import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  JsonSeriesStore,
  SeriesStoreConflictError,
  type SeriesRecord,
} from "../src/server/series-store.js";

const record: SeriesRecord = {
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
  nextEpisodeNumber: 1,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
};

describe("JsonSeriesStore", () => {
  it("persists series and advances an episode exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));

    await store.create(record);
    const advanced = await store.advanceEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");

    assert.equal(advanced.nextEpisodeNumber, 2);
    assert.equal((await store.list())[0]?.name, "AI 下班实验室");
    await assert.rejects(
      () => store.advanceEpisode("series-1", 1, "2026-08-24T09:01:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /已经推进/.test(error.message),
    );
  });

  it("recovers monotonically when opportunity persistence gets ahead of the series cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-recovery-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));

    await store.create(record);
    const recovered = await store.advancePastEpisode("series-1", 2, "2026-08-24T09:00:00.000Z");
    const repeated = await store.advancePastEpisode("series-1", 1, "2026-08-24T09:01:00.000Z");

    assert.equal(recovered.nextEpisodeNumber, 3);
    assert.equal(repeated.nextEpisodeNumber, 3);
  });
});
