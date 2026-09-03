import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { StudioTrendCandidate } from "../src/shared/api.js";
import { TrendStudio } from "../src/server/trend-studio.js";

describe("TrendStudio", () => {
  it("reuses an in-flight refresh and exposes success without starting a second Agent run", async () => {
    let resolveRefresh: ((value: StudioTrendCandidate[]) => void) | undefined;
    let calls = 0;
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      environment: {},
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      createRefreshId: () => "refresh-1",
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: { listCandidates: () => {
        calls += 1;
        return new Promise((resolve) => { resolveRefresh = resolve; });
      } },
    });

    const first = await studio.requestCandidateRefresh();
    const second = await studio.requestCandidateRefresh();
    assert.deepEqual(first, { refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T12:00:00.000Z" });
    assert.deepEqual(second, { refreshId: "refresh-1", status: "already_running", requestedAt: "2026-08-30T12:00:00.000Z" });
    assert.equal(calls, 1);
    assert.equal(studio.candidateRefreshStatus("refresh-1")?.state, "running");

    resolveRefresh!([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(studio.candidateRefreshStatus("refresh-1"), {
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:00.000Z",
      candidateCount: 0,
    });
  });

  it("reports a terminal error for a failed background refresh", async () => {
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      environment: {},
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      createRefreshId: () => "refresh-failed",
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: { listCandidates: async () => { throw new Error("upstream unavailable"); } },
    });

    await studio.requestCandidateRefresh();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(studio.candidateRefreshStatus("refresh-failed"), {
      refreshId: "refresh-failed",
      state: "failed",
      requestedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:00.000Z",
      error: "热点来源或选题总编暂时不可用，请稍后手动重试。",
    });
  });

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

  it("keeps the last non-empty cache when an explicit refresh returns no candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-empty-trend-refresh-"));
    const cachePath = path.join(root, "candidates.json");
    const cached = [{ id: "trend-last-known", title: "上一版可用热点" }] as StudioTrendCandidate[];
    try {
      const seed = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-30T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => cached },
      });
      await seed.listCandidates();

      const restarted = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-30T20:00:00.000Z"),
        createRefreshId: () => "refresh-empty",
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => [] },
      });
      assert.deepEqual(await restarted.listCandidates(), cached);
      await restarted.requestCandidateRefresh();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(restarted.candidateRefreshStatus("refresh-empty")?.state, "failed");
      assert.deepEqual(await restarted.listCandidates(), cached);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
