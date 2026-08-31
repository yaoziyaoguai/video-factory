import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  JsonSeriesStore,
  SeriesStoreConflictError,
  type SeriesRecord,
} from "../src/server/series-store.js";

const createdAt = "2026-08-24T08:00:00.000Z";

function record(): SeriesRecord {
  return {
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
    bible: {
      rules: ["每集必须验证真实任务"],
      recurringElements: ["工作台俯拍"],
      forbiddenChanges: ["不能把计划当成已经验证的事实"],
    },
    canon: { revision: 0, facts: [] },
    episodes: [episode(1), episode(2, "series-series-1-episode-001")],
    nextEpisodeNumber: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function episode(episodeNumber: number, previousEpisodeId?: string): SeriesRecord["episodes"][number] {
  return {
    id: `series-series-1-episode-${String(episodeNumber).padStart(3, "0")}`,
    seriesId: "series-1",
    episodeNumber,
    seasonNumber: 1,
    arc: "从工具尝鲜走到稳定工作流",
    pillar: episodeNumber === 1 ? "真实任务实验" : "成本与时间复盘",
    title: `第 ${episodeNumber} 集`,
    viewerPromise: "给出可验证的结论",
    hook: "先看真实结果",
    payoff: `完成第 ${episodeNumber} 次验证`,
    ...(previousEpisodeId ? { previousEpisodeId } : {}),
    canonBaseRevision: 0,
    status: "planned",
    continuity: {
      inheritedFromPrevious: previousEpisodeId ? ["上一集留下一个边界问题"] : [],
      fromPrevious: previousEpisodeId ? ["承接上一集"] : [],
      toNext: ["留下一个边界问题"],
      canonChecks: ["每集必须验证真实任务"],
    },
    planning: {
      source: "rules",
      role: "系列总编",
      auditRole: "规则校验",
      auditStatus: "passed",
      auditIterations: 1,
      providerId: "codex-series-planner-v1",
      modelId: "codex-default",
      promptVersion: "video-factory/series-greenlight-v1",
    },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("JsonSeriesStore", () => {
  it("links a creator-confirmed completed legacy run and keeps the migrated episode ready without invented Canon", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-legacy-link-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    const legacy = record();
    legacy.episodes[0] = {
      ...legacy.episodes[0]!,
      status: "paused",
      planning: {
        ...legacy.episodes[0]!.planning,
        providerId: "series-store-migration-v2",
        promptVersion: "video-factory/series-migration-v2",
      },
    };
    legacy.episodes[1] = {
      ...legacy.episodes[1]!,
      status: "selected",
      opportunityId: legacy.episodes[1]!.id,
    };
    await store.create(legacy);

    const linked = await store.linkLegacyRun("series-1", 1, {
      id: "run-old-1",
      status: "succeeded",
      revision: 7,
    }, "2026-08-24T09:00:00.000Z");
    assert.equal(linked.episodes[0]?.status, "ready");
    assert.equal(linked.episodes[0]?.runId, "run-old-1");
    assert.equal(linked.canon.facts.length, 0);

    await store.reconcileRuns([{ id: "run-old-1", status: "succeeded", revision: 8 }], "2026-08-24T09:01:00.000Z");
    const reconciled = await store.get("series-1");
    assert.equal(reconciled?.episodes[0]?.status, "ready");
    assert.match(reconciled?.episodes[0]?.continuity.memorySummary ?? "", /历史成片/);
    await store.reserveRun(
      "series-1",
      legacy.episodes[1]!.id,
      legacy.episodes[1]!.id,
      "reservation-2",
      "2026-08-24T09:02:00.000Z",
    );
  });

  it("rejects linking unfinished or already-owned records into a legacy slot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-legacy-link-reject-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    const legacy = record();
    legacy.episodes[0] = {
      ...legacy.episodes[0]!,
      status: "paused",
      planning: { ...legacy.episodes[0]!.planning, providerId: "series-store-migration-v2" },
    };
    await store.create(legacy);
    await assert.rejects(
      () => store.linkLegacyRun("series-1", 1, { id: "run-live", status: "running", revision: 1 }, createdAt),
      /只能关联已经完成的历史成片/,
    );
  });

  it("keeps episode adoption idempotent and enforces the production order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());

    const adopted = await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    const repeated = await store.adoptEpisode("series-1", 1, "2026-08-24T09:01:00.000Z");

    assert.equal(adopted.episodes[0]?.status, "selected");
    assert.equal(repeated.revision, adopted.revision);
    await assert.rejects(
      () => store.adoptEpisode("series-1", 2, "2026-08-24T09:02:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /先完成第 1 集/.test(error.message),
    );
  });

  it("fails closed when an episode has not passed an independent greenlight audit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-greenlight-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    const unaudited = record();
    unaudited.episodes[0]!.planning = {
      ...unaudited.episodes[0]!.planning,
      auditStatus: "fallback",
      auditIterations: 0,
    };
    await store.create(unaudited);

    await assert.rejects(
      () => store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /独立开拍审计/.test(error.message),
    );
  });

  it("edits only planned episodes with revision protection and preserves human provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-edit-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());

    const updated = await store.updateEpisodePlan("series-1", 1, {
      expectedRevision: 1,
      pillar: "成本与时间复盘",
      title: "下班后 20 分钟，AI 真能整理完报销吗？",
      viewerPromise: "看到完整耗时和失败边界",
      hook: "先展示最终报销表，再倒推过程",
      payoff: "给出可复现步骤与真实耗时",
      fromPrevious: [],
      toNext: ["下一集验证多人协作时是否仍然成立"],
    }, "2026-08-24T08:30:00.000Z");

    assert.equal(updated.revision, 2);
    assert.equal(updated.episodes[0]?.planning.source, "human");
    assert.equal(updated.episodes[0]?.planning.auditStatus, "human_override");
    assert.deepEqual(updated.episodes[1]?.continuity.fromPrevious, ["承接上一集"]);
    assert.deepEqual(updated.episodes[1]?.continuity.inheritedFromPrevious, ["下一集验证多人协作时是否仍然成立"]);
    assert.equal(updated.episodes[1]?.planning.auditStatus, "stale");
    await assert.rejects(
      () => store.updateEpisodePlan("series-1", 1, {
        expectedRevision: 1,
        pillar: "成本与时间复盘",
        title: "过期编辑",
        viewerPromise: "不会保存",
        hook: "不会保存",
        payoff: "不会保存",
        fromPrevious: [],
        toNext: [],
      }, "2026-08-24T08:31:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /已经更新/.test(error.message),
    );

    const editedEpisode = updated.episodes[0]!;
    const humanDraft = {
      episodeNumber: 1,
      pillar: editedEpisode.pillar,
      title: editedEpisode.title,
      viewerPromise: editedEpisode.viewerPromise,
      hook: editedEpisode.hook,
      payoff: editedEpisode.payoff,
      fromPrevious: editedEpisode.continuity.fromPrevious,
      toNext: editedEpisode.continuity.toNext,
    };
    for (const forged of [
      { ...humanDraft, pillar: "真实任务实验" },
      { ...humanDraft, title: "Agent 越权改写的标题" },
      { ...humanDraft, viewerPromise: "Agent 越权改写的承诺" },
      { ...humanDraft, hook: "Agent 越权改写的钩子" },
      { ...humanDraft, payoff: "Agent 越权改写的兑现" },
      { ...humanDraft, toNext: ["Agent 越权改写的后续交接"] },
    ]) {
      await assert.rejects(
        () => store.rebaseEpisodePlan("series-1", 1, updated.revision, updated.canon.revision, forged, {
          ...editedEpisode.planning,
          auditStatus: "passed",
          auditIterations: 1,
        }, "2026-08-24T08:44:00.000Z"),
        /不能改写创作者确认的标题、钩子或本集兑现/,
      );
    }
    assert.equal((await store.get("series-1"))?.episodes[0]?.title, editedEpisode.title);
    const greenlit = await store.rebaseEpisodePlan("series-1", 1, updated.revision, updated.canon.revision, {
      episodeNumber: 1,
      pillar: editedEpisode.pillar,
      title: editedEpisode.title,
      viewerPromise: editedEpisode.viewerPromise,
      hook: editedEpisode.hook,
      payoff: editedEpisode.payoff,
      fromPrevious: editedEpisode.continuity.fromPrevious,
      toNext: editedEpisode.continuity.toNext,
    }, {
      ...editedEpisode.planning,
      auditStatus: "passed",
      auditIterations: 1,
      auditRole: "独立质量审计 Agent",
    }, "2026-08-24T08:45:00.000Z");
    assert.equal(greenlit.episodes[0]?.planning.source, "human");
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await assert.rejects(
      () => store.updateEpisodePlan("series-1", 1, {
        expectedRevision: 4,
        pillar: "成本与时间复盘",
        title: "不能修改",
        viewerPromise: "不能修改",
        hook: "不能修改",
        payoff: "不能修改",
        fromPrevious: [],
        toNext: [],
      }, "2026-08-24T09:01:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /制作节点/.test(error.message),
    );
  });

  it("keeps an interrupted metered run bound until its uncertain provider outcome is reconciled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-uncertain-paid-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    const adopted = await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", adopted.episodes[0]!.id, "run-paid-1", "2026-08-24T09:01:00.000Z");

    await store.reconcileRuns([{
      id: "run-paid-1",
      status: "failed",
      revision: 3,
      seriesId: "series-1",
      episodeNumber: 1,
      opportunityId: adopted.episodes[0]!.id,
      outcomeUncertain: true,
    }], "2026-08-24T09:02:00.000Z");

    const paused = await store.get("series-1");
    assert.equal(paused?.episodes[0]?.status, "paused");
    assert.equal(paused?.episodes[0]?.runId, "run-paid-1");
    assert.match(paused?.episodes[0]?.continuity.memorySummary ?? "", /禁止另起一次付费制作/);
    await assert.rejects(
      () => store.reserveRun("series-1", paused!.episodes[0]!.id, paused!.episodes[0]!.id, "reservation-new", "2026-08-24T09:03:00.000Z"),
      /已经被其他制作占用/,
    );
    await assert.rejects(
      () => store.resumeRun("series-1", 1, "run-paid-1", "2026-08-24T09:04:00.000Z"),
      /状态不允许恢复/,
    );
  });

  it("writes canon only after a run becomes an approved internal master", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-canon-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    const initial = record();
    initial.episodes[1]!.continuity.fromPrevious = ["报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。"];
    await store.create(initial);
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    await assert.rejects(
      () => store.markRunPublished("run-1", "2026-08-24T09:05:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /内部定版/.test(error.message),
    );

    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 7,
      canonProposal: {
        memorySummary: "第 1 集内部定版：报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。",
        statements: ["报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。"],
        sourceOutputVersionIds: ["script-v2", "render-v1"],
      },
    }], "2026-08-24T09:10:00.000Z");
    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 7,
      canonProposal: {
        memorySummary: "第 1 集内部定版：报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。",
        statements: ["报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。"],
        sourceOutputVersionIds: ["script-v2", "render-v1"],
      },
    }], "2026-08-24T09:10:30.000Z");
    const ready = (await store.list())[0]!;

    assert.equal(ready.episodes[0]?.status, "ready");
    assert.equal(ready.canon.revision, 1);
    assert.equal(ready.canon.facts.length, 1);
    assert.equal(ready.canon.facts[0]?.sourceRunRevision, 7);
    assert.deepEqual(ready.canon.facts[0]?.sourceOutputVersionIds, ["script-v2", "render-v1"]);
    assert.equal(ready.episodes[1]?.canonBaseRevision, 0);
    assert.equal(ready.episodes[1]?.planning.auditStatus, "stale");
    assert.deepEqual(ready.episodes[1]?.continuity.fromPrevious, ["报销整理在 20 分钟内可完成，但票据模糊时必须人工复核。"]);
    assert.match(ready.episodes[1]?.continuity.inheritedFromPrevious[0] ?? "", /票据模糊时必须人工复核/);
    await assert.rejects(
      () => store.adoptEpisode("series-1", 2, "2026-08-24T09:11:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /开拍审计/.test(error.message),
    );
    const staleEpisode = ready.episodes[1]!;
    const rebased = await store.rebaseEpisodePlan("series-1", 2, ready.revision, ready.canon.revision, {
      episodeNumber: 2,
      pillar: staleEpisode.pillar,
      title: staleEpisode.title,
      viewerPromise: staleEpisode.viewerPromise,
      hook: staleEpisode.hook,
      payoff: staleEpisode.payoff,
      fromPrevious: staleEpisode.continuity.fromPrevious,
      toNext: staleEpisode.continuity.toNext,
    }, { ...staleEpisode.planning, auditStatus: "passed", auditIterations: 1 }, "2026-08-24T09:11:30.000Z");
    assert.equal(rebased.episodes[1]?.canonBaseRevision, 1);
    assert.equal((await store.adoptEpisode("series-1", 2, "2026-08-24T09:12:00.000Z")).episodes[1]?.status, "selected");

    await store.markRunPublished("run-1", "2026-08-24T10:00:00.000Z");
    const published = (await store.list())[0]!;
    assert.equal(published.episodes[0]?.status, "published");
    assert.equal(published.canon.revision, 1);
    assert.equal(published.canon.facts.length, 1);
  });

  it("invalidates stale canon, blocks the next episode, and requeues failed or missing runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reconcile-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    const succeeded = {
      id: "run-1",
      status: "succeeded" as const,
      revision: 3,
      canonProposal: {
        memorySummary: "第 1 集内部定版：结论 A。",
        statements: ["结论 A"],
        sourceOutputVersionIds: ["script-v1", "render-v1"],
      },
    };
    await store.reconcileRuns([succeeded], "2026-08-24T09:10:00.000Z");
    assert.equal((await store.list())[0]?.canon.facts.length, 1);
    const ready = (await store.list())[0]!;
    const episodeTwo = ready.episodes[1]!;
    await store.rebaseEpisodePlan("series-1", 2, ready.revision, ready.canon.revision, {
      episodeNumber: 2,
      pillar: episodeTwo.pillar,
      title: episodeTwo.title,
      viewerPromise: episodeTwo.viewerPromise,
      hook: episodeTwo.hook,
      payoff: episodeTwo.payoff,
      fromPrevious: episodeTwo.continuity.fromPrevious,
      toNext: episodeTwo.continuity.toNext,
    }, { ...episodeTwo.planning, auditStatus: "passed", auditIterations: 1 }, "2026-08-24T09:10:30.000Z");
    await store.adoptEpisode("series-1", 2, "2026-08-24T09:11:00.000Z");

    const { canonProposal: _proposal, ...withoutProposal } = succeeded;
    await store.reconcileRuns([{ ...withoutProposal, status: "stale", revision: 4 }], "2026-08-24T09:20:00.000Z");
    const stale = (await store.list())[0]!;
    assert.equal(stale.episodes[0]?.status, "in_production");
    assert.equal(stale.canon.facts.length, 0);
    assert.equal(stale.episodes[1]?.continuity.inheritedFromPrevious.some((value) => value.includes("结论 A")), false);
    await assert.rejects(
      () => store.reserveRun("series-1", "series-series-1-episode-002", "series-series-1-episode-002", "reservation-2", "2026-08-24T09:21:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /第 1 集尚未形成有效 Canon/.test(error.message),
    );

    await store.reconcileRuns([{ id: "run-1", status: "failed", revision: 5 }], "2026-08-24T09:30:00.000Z");
    const failed = (await store.list())[0]!;
    assert.equal(failed.episodes[0]?.status, "selected");
    assert.equal(failed.episodes[0]?.runId, undefined);
    assert.deepEqual(failed.episodes[0]?.attemptRunIds, ["run-1"]);

    await store.linkRun("series-1", "series-series-1-episode-001", "run-2", "2026-08-24T09:31:00.000Z");
    await store.reconcileRuns([], "2026-08-24T09:32:00.000Z");
    assert.equal((await store.list())[0]?.episodes[0]?.status, "selected");
  });

  it("reserves a single production slot before dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reserve-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");

    await store.reserveRun("series-1", "series-series-1-episode-001", "series-series-1-episode-001", "reservation-a", "2026-08-24T09:01:00.000Z");
    await assert.rejects(
      () => store.reserveRun("series-1", "series-series-1-episode-001", "series-series-1-episode-001", "reservation-b", "2026-08-24T09:01:01.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /其他制作占用/.test(error.message),
    );
    const confirmed = await store.confirmRunReservation(
      "series-1",
      "series-series-1-episode-001",
      "reservation-a",
      "run-a",
      "2026-08-24T09:02:00.000Z",
    );
    assert.equal(confirmed.episodes[0]?.status, "in_production");
    assert.equal(confirmed.episodes[0]?.runId, "run-a");
    assert.equal(confirmed.episodes[0]?.runReservation, undefined);
  });

  it("recovers only an expired unbound production reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reservation-recovery-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.reserveRun(
      "series-1",
      "series-series-1-episode-001",
      "series-series-1-episode-001",
      "reservation-a",
      "2026-08-24T09:01:00.000Z",
    );

    await store.reconcileRuns([], "2026-08-24T09:10:00.000Z");
    assert.equal((await store.list())[0]?.episodes[0]?.runReservation?.id, "reservation-a");

    await store.reconcileRuns([], "2026-08-24T09:16:00.000Z");
    assert.equal((await store.list())[0]?.episodes[0]?.runReservation, undefined);
    await store.reserveRun(
      "series-1",
      "series-series-1-episode-001",
      "series-series-1-episode-001",
      "reservation-b",
      "2026-08-24T09:17:00.000Z",
    );
  });

  it("prevents cross-process writers from silently overwriting the same series file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-lock-"));
    const filePath = path.join(root, "series.json");
    const store = new JsonSeriesStore(filePath);
    await store.create(record());
    await writeFile(`${filePath}.lock`, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");

    await assert.rejects(
      () => store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /另一个服务更新/.test(error.message),
    );
    assert.equal((await store.list())[0]?.episodes[0]?.status, "planned");
  });

  it("blocks upstream canon edits after a downstream episode starts production", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-upstream-edit-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 2,
      canonProposal: {
        memorySummary: "第 1 集内部定版：结论 A。",
        statements: ["结论 A"],
        sourceOutputVersionIds: ["script-v1", "render-v1"],
      },
    }], "2026-08-24T09:10:00.000Z");
    const ready = (await store.list())[0]!;
    const episodeTwo = ready.episodes[1]!;
    await store.rebaseEpisodePlan("series-1", 2, ready.revision, ready.canon.revision, {
      episodeNumber: 2,
      pillar: episodeTwo.pillar,
      title: episodeTwo.title,
      viewerPromise: episodeTwo.viewerPromise,
      hook: episodeTwo.hook,
      payoff: episodeTwo.payoff,
      fromPrevious: episodeTwo.continuity.fromPrevious,
      toNext: episodeTwo.continuity.toNext,
    }, { ...episodeTwo.planning, auditStatus: "passed", auditIterations: 1 }, "2026-08-24T09:10:30.000Z");
    await store.adoptEpisode("series-1", 2, "2026-08-24T09:11:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-002", "run-2", "2026-08-24T09:12:00.000Z");

    await assert.rejects(
      () => store.assertRunEditable("run-1"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /第 2 集已经采用或进入制作/.test(error.message),
    );
  });

  it("holds downstream production while an upstream edit lease is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-edit-lease-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 2,
      canonProposal: {
        memorySummary: "第 1 集内部定版：结论 A。",
        statements: ["结论 A"],
        sourceOutputVersionIds: ["script-v1", "render-v1"],
      },
    }], "2026-08-24T09:10:00.000Z");
    const ready = (await store.list())[0]!;
    const episodeTwo = ready.episodes[1]!;
    const rebased = await store.rebaseEpisodePlan("series-1", 2, ready.revision, ready.canon.revision, {
      episodeNumber: 2,
      pillar: episodeTwo.pillar,
      title: episodeTwo.title,
      viewerPromise: episodeTwo.viewerPromise,
      hook: episodeTwo.hook,
      payoff: episodeTwo.payoff,
      fromPrevious: episodeTwo.continuity.fromPrevious,
      toNext: episodeTwo.continuity.toNext,
    }, { ...episodeTwo.planning, auditStatus: "passed", auditIterations: 1 }, "2026-08-24T09:10:30.000Z");
    await store.acquireRunEditLease("run-1", "edit-a", "2026-08-24T09:11:00.000Z");
    await assert.rejects(
      () => store.adoptEpisode("series-1", 2, "2026-08-24T09:11:30.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /第 1 集正在修改/.test(error.message),
    );
    await store.releaseRunEditLease("run-1", "edit-a");
    await store.adoptEpisode("series-1", 2, "2026-08-24T09:12:00.000Z");
    const reserved = await store.reserveRun("series-1", episodeTwo.id, episodeTwo.id, "reservation-2", "2026-08-24T09:13:00.000Z");
    assert.equal(reserved.episodes[1]?.runReservation?.id, "reservation-2");
    assert.equal(rebased.episodes[1]?.canonBaseRevision, 1);
  });

  it("never lets an older run snapshot restore invalidated canon", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-monotonic-run-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 7,
      canonProposal: {
        memorySummary: "第 1 集内部定版：旧结论。",
        statements: ["旧结论"],
        sourceOutputVersionIds: ["script-v7"],
      },
    }], "2026-08-24T09:07:00.000Z");
    await store.reconcileRuns([{ id: "run-1", status: "stale", revision: 8 }], "2026-08-24T09:08:00.000Z");
    await store.reconcileRuns([{
      id: "run-1",
      status: "succeeded",
      revision: 7,
      canonProposal: {
        memorySummary: "第 1 集内部定版：旧结论。",
        statements: ["旧结论"],
        sourceOutputVersionIds: ["script-v7"],
      },
    }], "2026-08-24T09:09:00.000Z");

    const current = (await store.list())[0]!;
    assert.equal(current.episodes[0]?.status, "in_production");
    assert.deepEqual(current.episodes[0]?.lastObservedRun, { id: "run-1", revision: 8 });
    assert.equal(current.canon.facts.length, 0);
  });

  it("advances the observed revision even when the approved canon text is unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-same-canon-revision-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-1", "2026-08-24T09:01:00.000Z");
    const proposal = {
      memorySummary: "第 1 集内部定版：结论不变。",
      statements: ["结论不变"],
      sourceOutputVersionIds: ["script-v7"],
    };
    await store.reconcileRuns([{ id: "run-1", status: "succeeded", revision: 7, canonProposal: proposal }], "2026-08-24T09:07:00.000Z");
    await store.reconcileRuns([{ id: "run-1", status: "succeeded", revision: 8, canonProposal: proposal }], "2026-08-24T09:08:00.000Z");
    await store.reconcileRuns([{ id: "run-1", status: "succeeded", revision: 7, canonProposal: {
      ...proposal,
      memorySummary: "第 1 集内部定版：延迟旧结论。",
      statements: ["延迟旧结论"],
    } }], "2026-08-24T09:09:00.000Z");

    const current = (await store.list())[0]!;
    assert.deepEqual(current.episodes[0]?.lastObservedRun, { id: "run-1", revision: 8 });
    assert.equal(current.episodes[0]?.continuity.memorySummary, proposal.memorySummary);
    assert.deepEqual(current.canon.facts.map((fact) => fact.statement), proposal.statements);
  });

  it("binds a recovered dispatch only to its exact production reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-reservation-token-"));
    const store = new JsonSeriesStore(path.join(root, "series.json"));
    await store.create(record());
    await store.adoptEpisode("series-1", 1, "2026-08-24T09:00:00.000Z");
    await store.linkRun("series-1", "series-series-1-episode-001", "run-old", "2026-08-24T09:01:00.000Z");
    await store.reconcileRuns([{ id: "run-old", status: "failed", revision: 2 }], "2026-08-24T09:02:00.000Z");
    await store.reserveRun(
      "series-1",
      "series-series-1-episode-001",
      "series-series-1-episode-001",
      "reservation-new",
      "2026-08-24T09:03:00.000Z",
    );

    await store.reconcileRuns([{
      id: "run-old",
      status: "failed",
      revision: 2,
      seriesId: "series-1",
      episodeNumber: 1,
      opportunityId: "series-series-1-episode-001",
    }], "2026-08-24T09:04:00.000Z");
    assert.equal((await store.list())[0]?.episodes[0]?.runId, undefined);
    assert.equal((await store.list())[0]?.episodes[0]?.runReservation?.id, "reservation-new");

    await store.reconcileRuns([{
      id: "run-new",
      status: "running",
      revision: 0,
      seriesId: "series-1",
      episodeNumber: 1,
      opportunityId: "series-series-1-episode-001",
      productionReservationId: "reservation-new",
    }], "2026-08-24T09:05:00.000Z");
    const recovered = (await store.list())[0]!;
    assert.equal(recovered.episodes[0]?.runId, "run-new");
    assert.equal(recovered.episodes[0]?.runReservation, undefined);
  });

  it("migrates adopted v1 episode numbers into durable historical episode records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-v1-migration-"));
    const filePath = path.join(root, "series.json");
    const legacy = record();
    const { revision: _revision, currentSeason: _season, bible: _bible, canon: _canon, episodes: _episodes, ...v1 } = legacy;
    await writeFile(filePath, `${JSON.stringify({ version: 1, series: [{ ...v1, nextEpisodeNumber: 3 }] })}\n`, "utf8");

    const [migrated] = await new JsonSeriesStore(filePath).list();

    assert.deepEqual(migrated?.episodes.map((item) => [item.episodeNumber, item.status, item.opportunityId]), [
      [1, "paused", "series-series-1-episode-001"],
      [2, "paused", "series-series-1-episode-002"],
    ]);
    assert.equal(migrated?.episodes[1]?.previousEpisodeId, "series-series-1-episode-001");
    assert.equal(migrated?.nextEpisodeNumber, 3);
  });

  it("repairs missing adopted episodes in an early v2 store before unlocking later work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-v2-gap-migration-"));
    const filePath = path.join(root, "series.json");
    const incomplete = record();
    incomplete.nextEpisodeNumber = 2;
    incomplete.episodes = [episode(2)];
    await writeFile(filePath, `${JSON.stringify({ version: 2, series: [incomplete] })}\n`, "utf8");

    const store = new JsonSeriesStore(filePath);
    const [migrated] = await store.list();

    assert.deepEqual(migrated?.episodes.map((item) => [item.episodeNumber, item.status]), [
      [1, "paused"],
      [2, "planned"],
    ]);
    assert.equal(migrated?.episodes[1]?.previousEpisodeId, "series-series-1-episode-001");
    await assert.rejects(
      () => store.adoptEpisode("series-1", 2, "2026-08-24T09:00:00.000Z"),
      (error: unknown) => error instanceof SeriesStoreConflictError && /先完成第 1 集/.test(error.message),
    );
  });

  it("links a migrated episode to one exact historical run instead of producing it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-series-history-link-"));
    const filePath = path.join(root, "series.json");
    const legacy = record();
    const { revision: _revision, currentSeason: _season, bible: _bible, canon: _canon, episodes: _episodes, ...v1 } = legacy;
    await writeFile(filePath, `${JSON.stringify({ version: 1, series: [{ ...v1, nextEpisodeNumber: 2 }] })}\n`, "utf8");
    const store = new JsonSeriesStore(filePath);

    await store.reconcileRuns([{
      id: "legacy-run-1",
      status: "succeeded",
      revision: 4,
      seriesId: "series-1",
      episodeNumber: 1,
      opportunityId: "series-series-1-episode-001",
      canonProposal: {
        memorySummary: "历史第 1 集已恢复。",
        statements: ["历史第 1 集已恢复"],
        sourceOutputVersionIds: ["legacy-script-v4"],
      },
    }], "2026-08-24T10:00:00.000Z");

    const migrated = (await store.list())[0]!;
    assert.equal(migrated.episodes[0]?.runId, "legacy-run-1");
    assert.equal(migrated.episodes[0]?.status, "ready");
    assert.deepEqual(migrated.canon.facts.map((fact) => fact.statement), ["历史第 1 集已恢复"]);
  });
});
