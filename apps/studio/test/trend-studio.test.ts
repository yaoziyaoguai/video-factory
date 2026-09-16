import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { StudioTopicGenerationReceipt, StudioTrendCandidate } from "../src/shared/api.js";
import { TrendStudio } from "../src/server/trend-studio.js";

describe("TrendStudio", () => {
  it("gives an explicit refresh a fresh generation nonce while ordinary reads generate none", async () => {
    // C3-E02：换一批必须有新的生成身份；普通读取/自动刷新不触发新一轮生成。
    const nonces: Array<string | undefined> = [];
    let nonceCounter = 0;
    let batch = 0;
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      environment: {},
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      createGenerationNonce: () => `nonce-${nonceCounter += 1}`,
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: { listCandidates: (options?: { generationNonce?: string }) => {
        nonces.push(options?.generationNonce);
        batch += 1;
        return Promise.resolve<StudioTrendCandidate[]>([]);
      } },
    });
    assert.equal(batch, 0);

    // 普通读取：不带 nonce（命中缓存/既有 checkpoint，不重复生成）。
    await studio.listCandidates();
    assert.deepEqual(nonces, [undefined]);

    // 显式换一批：携带全新的生成身份。
    await studio.listCandidates({ forceRefresh: true });
    assert.deepEqual(nonces, [undefined, "nonce-1"]);

    // 再换一批：身份必须不同。
    await studio.listCandidates({ forceRefresh: true });
    assert.deepEqual(nonces, [undefined, "nonce-1", "nonce-2"]);
  });

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
    const generationReceipt: StudioTopicGenerationReceipt = {
      generationId: "generation-cached-1",
      generatedAt: "2026-08-26T08:00:00.000Z",
      modelInvoked: true,
      source: "editor-model",
      candidateCount: 1,
      providerId: "openai-codex",
      modelId: "gpt-5.4",
    };
    let firstCalls = 0;
    try {
      const first = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: {
          listCandidates: async () => { firstCalls += 1; return cached; },
          generationReceipt: () => generationReceipt,
        },
      });
      assert.deepEqual(await first.listCandidates(), cached);
      assert.equal(firstCalls, 1);
      const persisted = JSON.parse(await readFile(cachePath, "utf8"));
      assert.equal(persisted.schemaVersion, 6);
      assert.deepEqual(persisted.generationReceipt, generationReceipt);

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
      assert.deepEqual(restarted.latestGenerationReceipt(), generationReceipt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names why the topic editor never ran when no agent was wired at startup", async () => {
    // 没有 trendAgent 就说明选题总编任务在启动时没就绪。这条路径不会产生 generationFallback，
    // 不补原因的话用户只看到一堆规则候选，无从知道总编为什么没给建议。
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-trend-no-editor-"));
    try {
      const studio = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath: path.join(root, "candidates.json"),
        environment: {},
        now: () => new Date("2026-08-30T12:00:00.000Z"),
        trendGateway: {
          listServices: async () => [],
          listSignals: async () => [{
            id: "signal-guokr-1",
            sourceId: "dailyhot" as const,
            platform: "guokr",
            title: "被用了几千年的铜，怎么突然成了AI时代的新宠？",
            rank: 1,
            collectedAt: "2026-08-30T11:00:00.000Z",
            url: "https://www.guokr.com/article/470243",
          }],
        },
      });

      const candidates = await studio.listCandidates();
      const receipt = studio.latestGenerationReceipt();
      assert.equal(receipt?.source, "rule-fallback");
      assert.equal(receipt?.modelInvoked, false);
      assert.equal(receipt?.failureCategory, "model_unavailable");
      assert.match(receipt?.failureReason ?? "", /总编/);
      // 线索文案写给用户看：平台标识和"零成本规则评分"这类内部口径都不能出现。
      for (const candidate of candidates) {
        assert.doesNotMatch(candidate.rationale ?? "", /guokr|零成本规则评分/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects caches written by an older candidate contract", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-old-trend-cache-"));
    const cachePath = path.join(root, "candidates.json");
    const refreshed = [{ id: "trend-current", title: "当前规则候选" }] as StudioTrendCandidate[];
    try {
      // schema 4 可能持久化了总编因看不到关联报道而返回的错误空短名单；
      // 新合同必须让这类旧空缓存失效并重新生成。
      await writeFile(cachePath, JSON.stringify({
        schemaVersion: 4,
        cachedAt: "2026-08-26T08:00:00.000Z",
        values: [],
      }), "utf8");
      let calls = 0;
      const studio = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-26T09:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => { calls += 1; return refreshed; } },
      });

      assert.deepEqual(await studio.listCandidates(), refreshed);
      assert.equal(calls, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists manually supplemented sources across restarts and refreshes without extending the cache ttl", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-trend-sources-"));
    const cachePath = path.join(root, "candidates.json");
    const sourcesPath = path.join(root, "candidates-sources.json");
    const cached: StudioTrendCandidate[] = [{
      id: "trend-supplemented",
      title: "来源待补热点",
      platform: "douyin",
      track: "daily-observer",
      audience: "普通上班族",
      painPoint: "不知道消息真假",
      hook: "先看可靠来源说了什么。",
      rationale: "适合逐条核验。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-09-07T04:00:00.000Z",
      evidence: [{
        source: "dailyhot",
        platform: "douyin",
        keyword: "来源待补热点",
        strength: 96,
        evidenceUrl: "https://first.example.cn/a",
        collectedAt: "2026-09-07T04:00:00.000Z",
      }],
      score: { audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80, novelty: 70, monetization: 50, seriesPotential: 70, complianceRisk: 16, final: 72 },
    }];
    try {
      const seed = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-09-07T05:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => cached },
      });
      await seed.listCandidates();
      const beforeCache = JSON.parse(await readFile(cachePath, "utf8")) as { cachedAt: string };

      // 追加两条人工来源：返回值立即包含补充，且只追加、不覆盖原 evidence。
      const appended = await seed.appendCandidateSources("trend-supplemented", [
        "https://news.example.org/report#detail",
        "https://news.example.org/report",
      ]);
      assert.equal(appended.evidence.length, 2);
      assert.equal(appended.evidence[1]?.source, "manual-supplement");
      assert.equal(appended.evidence[1]?.evidenceUrl, "https://news.example.org/report");
      assert.equal(appended.evidence[0]?.evidenceUrl, "https://first.example.cn/a");

      // 幂等：重复提交同一 URL 不再追加，也不重写补充文件。
      const persisted = await readFile(sourcesPath, "utf8");
      const again = await seed.appendCandidateSources("trend-supplemented", ["https://news.example.org/report"]);
      assert.equal(again.evidence.length, 2);
      assert.equal(await readFile(sourcesPath, "utf8"), persisted);

      // 两个同时到达的人工追加必须取并集，不能让后写入的一次覆盖前一次。
      await Promise.all([
        seed.appendCandidateSources("trend-supplemented", ["https://second.example.com/report"]),
        seed.appendCandidateSources("trend-supplemented", ["https://third.example.net/report"]),
      ]);
      const afterConcurrentAppend = (await seed.listCandidates())[0]!;
      assert.deepEqual(
        new Set(afterConcurrentAppend.evidence.map((item) => item.evidenceUrl)),
        new Set([
          "https://first.example.cn/a",
          "https://news.example.org/report",
          "https://second.example.com/report",
          "https://third.example.net/report",
        ]),
      );

      // 人工追加不延长候选缓存生命周期：candidates.json 的 cachedAt 保持不变。
      const afterCache = JSON.parse(await readFile(cachePath, "utf8")) as { cachedAt: string };
      assert.equal(afterCache.cachedAt, beforeCache.cachedAt);

      // 重启后：即使后台刷新返回新版本候选，人工补充仍被合并回来，不会被覆盖。
      const refreshed: StudioTrendCandidate[] = [{
        ...cached[0]!,
        title: "刷新后的同一条热点",
        evidence: [cached[0]!.evidence[0]!],
      }];
      const restarted = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-09-07T05:30:00.000Z"),
        createRefreshId: () => "refresh-with-supplements",
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => refreshed },
      });
      assert.equal((await restarted.listCandidates())[0]?.evidence.length, 4);
      await restarted.requestCandidateRefresh();
      await restarted.listCandidates({ forceRefresh: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(restarted.candidateRefreshStatus("refresh-with-supplements")?.state, "succeeded");
      const afterRefresh = (await restarted.listCandidates())[0]!;
      assert.equal(afterRefresh.title, "刷新后的同一条热点");
      assert.equal(afterRefresh.evidence.length, 4);
      assert.equal(afterRefresh.evidence.some((item) => item.source === "manual-supplement"), true);

      await assert.rejects(
        () => seed.appendCandidateSources("trend-missing", ["https://news.example.org/x"]),
        /已被采用或已经失效/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when supplement persistence cannot complete instead of faking success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-trend-sources-readonly-"));
    const cachePath = path.join(root, "candidates.json");
    const cached: StudioTrendCandidate[] = [{
      id: "trend-readonly",
      title: "只读目录热点",
      platform: "douyin",
      track: "daily-observer",
      audience: "普通上班族",
      painPoint: "不知道消息真假",
      hook: "先看可靠来源说了什么。",
      rationale: "适合逐条核验。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-09-07T04:00:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "只读目录热点", strength: 96, evidenceUrl: "https://first.example.cn/a", collectedAt: "2026-09-07T04:00:00.000Z" }],
      score: { audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80, novelty: 70, monetization: 50, seriesPotential: 70, complianceRisk: 16, final: 72 },
    }];
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      cachePath,
      environment: {},
      now: () => new Date("2026-09-07T05:00:00.000Z"),
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: { listCandidates: async () => cached },
    });
    await studio.listCandidates();
    await chmod(root, 0o500);
    try {
      await assert.rejects(() => studio.appendCandidateSources("trend-readonly", ["https://news.example.org/b"]));
      // 写失败后内存不落地：后续读取仍是原 evidence，没有假成功。
      assert.equal((await studio.listCandidates())[0]?.evidence.length, 1);
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an unreadable supplement file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-corrupt-trend-sources-"));
    const cachePath = path.join(root, "candidates.json");
    const sourcesPath = path.join(root, "candidates-sources.json");
    const cached = [{ id: "trend-corrupt-sources", title: "补源记录损坏测试" }] as StudioTrendCandidate[];
    try {
      const seed = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-09-07T05:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => cached },
      });
      await seed.listCandidates();
      const corrupt = "{not-valid-json";
      await writeFile(sourcesPath, corrupt, "utf8");

      const restarted = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-09-07T05:30:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => cached },
      });
      await assert.rejects(
        () => restarted.appendCandidateSources("trend-corrupt-sources", ["https://news.cn/report"]),
        /无法读取，已停止继续写入/,
      );
      assert.equal(await readFile(sourcesPath, "utf8"), corrupt);
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

  it("answers a cold-cache snapshot immediately instead of blocking on generation", async () => {
    // 收件箱读取接口不能等待一次完整生成：冷缓存时先返回空快照 + refreshing，
    // 客户端据此继续轮询；生成在后台推进，落地后同一次读取就能看到候选。
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-snapshot-trend-"));
    const cachePath = path.join(root, "candidates.json");
    const generated = [{ id: "trend-generated", title: "本轮生成的热点" }] as StudioTrendCandidate[];
    let resolveGeneration: ((value: StudioTrendCandidate[]) => void) | undefined;
    try {
      const studio = new TrendStudio({
        repositoryRoot: "/repo",
        cachePath,
        environment: {},
        now: () => new Date("2026-08-24T08:00:00.000Z"),
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: () => new Promise((resolve) => { resolveGeneration = resolve; }) },
      });

      assert.deepEqual(await studio.snapshotCandidates(), []);
      assert.equal(studio.isRefreshing(), true, "冷缓存快照必须报告后台生成仍在进行");
      assert.ok(resolveGeneration, "冷缓存快照必须已在后台启动一次生成");

      resolveGeneration(generated);
      let current: StudioTrendCandidate[] = [];
      for (let attempt = 0; attempt < 20 && current.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        current = await studio.snapshotCandidates();
      }
      assert.deepEqual(current, generated);
      assert.equal(studio.isRefreshing(), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a valid empty shortlist instead of reviving the previous candidates", async () => {
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
      assert.deepEqual(await restarted.listCandidates({ forceRefresh: true }), []);

      assert.deepEqual(restarted.candidateRefreshStatus("refresh-empty"), {
        refreshId: "refresh-empty",
        state: "succeeded",
        requestedAt: "2026-08-30T20:00:00.000Z",
        finishedAt: "2026-08-30T20:00:00.000Z",
        candidateCount: 0,
      });
      assert.deepEqual(await restarted.listCandidates(), []);
      assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).values, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the previous shortlist when an explicit refresh throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-failed-trend-refresh-"));
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
        createRefreshId: () => "refresh-failed-with-cache",
        trendGateway: { listServices: async () => [], listSignals: async () => [] },
        trendAgent: { listCandidates: async () => { throw new Error("upstream unavailable"); } },
      });
      assert.deepEqual(await restarted.listCandidates(), cached);
      await restarted.requestCandidateRefresh();
      await assert.rejects(() => restarted.listCandidates({ forceRefresh: true }), /upstream unavailable/);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(restarted.candidateRefreshStatus("refresh-failed-with-cache")?.state, "failed");
      assert.deepEqual(await restarted.listCandidates(), cached);
      assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).values, cached);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
