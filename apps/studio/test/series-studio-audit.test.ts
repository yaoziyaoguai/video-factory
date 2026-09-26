import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { JsonSeriesStore } from "../src/server/series-store.js";
import { SeriesStudio } from "../src/server/series-studio.js";

it("coalesces concurrent audits of one series version but permits a later explicit re-audit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-series-current-audit-"));
  const series = new JsonSeriesStore(path.join(root, "series.json"));
  let calls = 0;
  const studio = new SeriesStudio({
    series,
    planningAgent: {
      reviewEpisode: async (_current, episode) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          draft: {
            episodeNumber: episode.episodeNumber,
            pillar: episode.pillar,
            title: episode.title,
            viewerPromise: episode.viewerPromise,
            hook: episode.hook,
            payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious],
            toNext: [...episode.continuity.toNext],
          },
          planning: { ...episode.planning, auditStatus: "passed" as const, auditIterations: 1 },
        };
      },
    },
  });
  const created = await studio.create({
    name: "测试系列", premise: "每集验证一个真实问题", audience: "普通观众", platform: "douyin",
    category: "technology", track: "test", pillars: ["真实验证"], tone: "清楚", visualStyle: "纪实",
  });
  const [first, duplicate] = await Promise.all([
    studio.auditEpisodeCurrent(created.id, 1, created.revision),
    studio.auditEpisodeCurrent(created.id, 1, created.revision),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.revision, duplicate.revision);
  const again = await studio.auditEpisodeCurrent(created.id, 1, first.revision);
  assert.equal(calls, 2);
  assert.equal(again.revision, first.revision + 1);
});

it("revises one series episode without auditing or adopting it, then adopts that exact unaudited version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-series-revise-once-"));
  let revisions = 0;
  let audits = 0;
  const studio = new SeriesStudio({
    series: new JsonSeriesStore(path.join(root, "series.json")),
    planningAgent: {
      reviseEpisode: async (_series, episode, instruction) => {
        revisions += 1;
        assert.equal(instruction, "把开场写成一个具体问题");
        return { draft: {
          episodeNumber: episode.episodeNumber, pillar: episode.pillar, title: episode.title,
          viewerPromise: episode.viewerPromise, hook: "开场先问观众会遇到的具体问题", payoff: episode.payoff,
          fromPrevious: [...episode.continuity.fromPrevious], toNext: [...episode.continuity.toNext],
        }, planning: {
          source: "agent" as const, role: "系列总编", auditRole: "独立质量复核", auditStatus: "not_audited" as const,
          auditIterations: 0, providerId: "fixture", modelId: "fixture-model", promptVersion: "series-revise-v1",
        } };
      },
      reviewEpisode: async () => { audits += 1; throw new Error("adoption must not audit"); },
    },
  });
  const created = await studio.create({
    name: "单集修订", premise: "逐集解决具体问题", audience: "普通观众", platform: "douyin",
    category: "education", track: "series-revise-once", pillars: ["验证"], tone: "具体", visualStyle: "纪实", targetEpisodeCount: 1,
  });
  const before = created.episodes[0]!;
  const revised = await studio.reviseEpisodeCurrent(created.id, 1, created.revision, "把开场写成一个具体问题");
  const after = revised.episodes[0]!;
  assert.equal(revisions, 1);
  assert.equal(audits, 0);
  assert.equal(after.status, "planned");
  assert.notEqual(after.contentVersionId, before.contentVersionId);
  assert.equal(after.versionHistory?.[0]?.hook, before.hook);
  assert.equal(after.versionHistory?.at(-1)?.hook, "开场先问观众会遇到的具体问题");
  assert.equal(after.auditHistory?.some((audit) => audit.targetVersionId === after.contentVersionId), false);
  const adopted = await studio.advanceEpisode(created.id, 1);
  assert.equal(audits, 0, "adopting an unaudited revision must not silently run a model check");
  assert.equal(adopted.episodes[0]?.adoption?.targetVersionId, after.contentVersionId);
  assert.equal(adopted.episodes[0]?.adoption?.auditId, null);
});

it("coalesces identical in-flight episode revisions and rejects a conflicting instruction before another model call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-series-revision-race-"));
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const studio = new SeriesStudio({
    series: new JsonSeriesStore(path.join(root, "series.json")),
    planningAgent: {
      reviewEpisode: async () => { throw new Error("revision must not audit"); },
      reviseEpisode: async (_series, episode) => {
        calls += 1;
        await hold;
        return {
          draft: {
            episodeNumber: episode.episodeNumber, pillar: episode.pillar, title: episode.title,
            viewerPromise: episode.viewerPromise, hook: "新开场", payoff: episode.payoff,
            fromPrevious: [...episode.continuity.fromPrevious], toNext: [...episode.continuity.toNext],
          },
          planning: {
            source: "agent" as const, role: "系列总编", auditRole: "独立质量复核",
            auditStatus: "not_audited" as const, auditIterations: 0,
            providerId: "fixture", modelId: "fixture", promptVersion: "fixture",
          },
        };
      },
    },
  });
  const created = await studio.create({
    name: "并发系列", premise: "每集解答一个问题", audience: "普通观众", platform: "douyin",
    category: "education", track: "series-race", pillars: ["验证"], tone: "具体", visualStyle: "纪实", targetEpisodeCount: 1,
  });
  const first = studio.reviseEpisodeCurrent(created.id, 1, created.revision, "改开场");
  const same = studio.reviseEpisodeCurrent(created.id, 1, created.revision, "改开场");
  await assert.rejects(() => studio.reviseEpisodeCurrent(created.id, 1, created.revision, "换主题"), /已有不同的修改意见/);
  release();
  const [a, b] = await Promise.all([first, same]);
  assert.equal(calls, 1);
  assert.equal(a.revision, b.revision);
});
