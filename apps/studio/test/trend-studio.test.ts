import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { StudioTrendCandidate } from "../src/shared/api.js";
import { TrendStudio } from "../src/server/trend-studio.js";

describe("TrendStudio", () => {
  it("queues an explicit refresh behind an ordinary in-flight read", async () => {
    const resolvers: Array<(value: StudioTrendCandidate[]) => void> = [];
    let calls = 0;
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      environment: {},
      now: () => new Date("2026-08-26T12:00:00.000Z"),
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: {
        listCandidates: async () => {
          calls += 1;
          return new Promise<StudioTrendCandidate[]>((resolve) => resolvers.push(resolve));
        },
      },
    });

    const ordinary = studio.listCandidates();
    const forced = studio.listCandidates({ forceRefresh: true });
    assert.equal(calls, 1);
    resolvers.shift()!([]);
    await ordinary;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    resolvers.shift()!([]);
    await forced;
  });

  it("persists a daily candidate cache across service restarts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-trend-cache-"));
    const cachePath = path.join(root, "candidates.json");
    const cached = [{ id: "trend-cached", title: "缓存热点" }] as StudioTrendCandidate[];
    let firstCalls = 0;
    try {
      const first = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => { firstCalls += 1; return cached; } },
      });
      assert.deepEqual(await first.listCandidates(), cached);
      assert.equal(firstCalls, 1);

      let restartedCalls = 0;
      const restarted = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-26T20:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => { restartedCalls += 1; return []; } },
      });
      assert.deepEqual(await restarted.listCandidates(), cached);
      assert.equal(restartedCalls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves a stale cache immediately while refreshing it in the background", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-stale-trend-cache-"));
    const cachePath = path.join(root, "candidates.json");
    const cached = [{ id: "trend-stale", title: "昨日热点" }] as StudioTrendCandidate[];
    const refreshed = [{ id: "trend-new", title: "今日热点" }] as StudioTrendCandidate[];
    try {
      const seed = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-24T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => cached },
      });
      await seed.listCandidates();

      let resolveRefresh: ((value: StudioTrendCandidate[]) => void) | undefined;
      const restarted = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: () => new Promise((resolve) => { resolveRefresh = resolve; }) },
      });

      assert.deepEqual(await restarted.listCandidates(), cached);
      assert.ok(resolveRefresh, "stale read should schedule one background refresh");
      resolveRefresh(refreshed);
      let current = cached;
      for (let attempt = 0; attempt < 20 && current[0]?.id !== refreshed[0]?.id; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        current = await restarted.listCandidates();
      }
      assert.deepEqual(current, refreshed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
