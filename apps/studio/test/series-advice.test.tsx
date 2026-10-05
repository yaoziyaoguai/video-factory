import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TopicEntryWorkspace } from "../src/client/components/TopicEntryWorkspace.js";
import type { StudioCandidateInboxItem, StudioSeries } from "../src/shared/api.js";

const episode: StudioSeries["episodes"][number] = {
  id: "series-advice-episode-2", seriesId: "series-advice", episodeNumber: 2,
  seasonNumber: 1, arc: "回答真实难题", pillar: "复盘", title: "第二集验证边界",
  viewerPromise: "看到上一集方法的适用范围", hook: "从例外开始", payoff: "给出可验证的边界",
  previousEpisodeId: "series-advice-episode-1", canonBaseRevision: 1, status: "planned",
  continuity: { inheritedFromPrevious: ["前集结论已修改"], fromPrevious: ["验证新结论"], toNext: [], canonChecks: [] },
  planning: {
    source: "agent", role: "系列总编", auditRole: "独立复核", auditStatus: "stale", auditIterations: 1,
    auditSummary: "第 1 集的交接已修改，采用本集前需要重新审计。", auditScore: 91,
    providerId: "test-planner", modelId: "test-model", promptVersion: "test-v1",
  },
  createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
};

const series: StudioSeries = {
  id: "series-advice", name: "生活实验室", premise: "回答真实难题", audience: "普通上班族",
  platform: "douyin", category: "lifestyle", track: "daily", pillars: ["复盘"], tone: "具体", visualStyle: "实拍",
  revision: 2, currentSeason: { number: 1, title: "第一季", arc: "回答真实难题" },
  bible: { rules: [], recurringElements: [], forbiddenChanges: [] }, canon: { revision: 1, facts: [] },
  episodes: [episode], status: "active", nextEpisodeNumber: 2,
  createdAt: episode.createdAt, updatedAt: episode.updatedAt,
};

function renderSeries(blockedByPrevious: boolean, planning = episode.planning) {
  const candidate: StudioCandidateInboxItem = {
    id: episode.id, origin: "series", category: "lifestyle", freshness: "evergreen", risk: "low",
    verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: [] },
    editorialDecision: { verdict: "produce_video", score: 80, reasons: [], guardrails: [] },
    seriesId: series.id, seriesName: series.name, episodeNumber: 2,
    seriesSequence: blockedByPrevious ? { status: "blocked", blockedByEpisodeNumber: 1 } : { status: "ready" },
    title: episode.title, platform: "douyin", track: "daily", audience: series.audience,
    painPoint: episode.viewerPromise, hook: episode.hook, rationale: "验证方法的边界", providerId: "test-planner", generatedAt: episode.createdAt, evidence: [],
    score: { audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80, novelty: 80, monetization: 60, seriesPotential: 80, complianceRisk: 10, final: 78 },
  };
  const onAdopt = vi.fn(async () => undefined);
  const onAudit = vi.fn(async () => undefined);
  render(<MemoryRouter><TopicEntryWorkspace initialMode="series" selectedSeriesId={series.id}
    inbox={{ items: [candidate], facets: { total: 1, origins: { series: 1 }, categories: { lifestyle: 1 }, platforms: { douyin: 1 }, verdicts: { produce_video: 1 } }, generatedAt: episode.createdAt, refreshing: false }}
    series={[{ ...series, episodes: [{ ...episode, planning }] }]} historicalRuns={[]} loading={{}} trendMeta={{ platformCount: 0, candidateCount: 0 }}
    onRetry={() => undefined} onRefreshTrends={() => undefined} onAdopt={onAdopt} onCreateSeries={() => undefined} onSelectSeries={() => undefined}
    onUpdateSeriesEpisode={async () => undefined} onAuditSeriesEpisode={onAudit} onLinkLegacyRun={async () => undefined} onRescanSeries={async () => undefined}
    onViewProductionRecords={() => undefined} onManual={() => undefined} onImport={() => undefined}
  /></MemoryRouter>);
  return { onAdopt, onAudit };
}

describe("series audit advice", () => {
  it("presents a persisted stale audit as optional without changing the previous-episode requirement", () => {
    const before = JSON.stringify(episode);
    const { onAdopt, onAudit } = renderSeries(true);
    expect(screen.queryByText(/采用本集前需要重新审计/)).not.toBeInTheDocument();
    expect(screen.getByText(/原复核已过期.*是否重新审计由你决定/)).toBeInTheDocument();
    expect(screen.queryByText(/91 分/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /完成第 1 集后解锁/ })).toBeDisabled();
    expect(onAdopt).not.toHaveBeenCalled();
    expect(onAudit).not.toHaveBeenCalled();
    expect(JSON.stringify(episode)).toBe(before);
  });

  it("allows explicit adoption of a stale-audit episode once its predecessor is ready without auditing", async () => {
    const { onAdopt, onAudit } = renderSeries(false);
    await userEvent.click(screen.getByRole("button", { name: "采用本版（未审或有建议），进入制作" }));
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAudit).not.toHaveBeenCalled();
  });

  it("preserves a current audit's content advice and score", () => {
    renderSeries(false, { ...episode.planning, auditStatus: "passed", auditSummary: "结尾可再补一个反例。" });
    expect(screen.getByText(/结尾可再补一个反例.*91 分/)).toBeInTheDocument();
    expect(screen.queryByText(/原复核已过期/)).not.toBeInTheDocument();
  });
});
