import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { StudioCandidateInbox, StudioCandidateInboxItem, StudioOpportunity, StudioTopicGenerationReceipt } from "../src/shared/api.js";
import {
  beijingDateTime,
  evidenceGroupCountLabel,
  groupDisplayEvidence,
  trendStatusText,
} from "../src/client/presentation.js";
import { TopicEntryWorkspace } from "../src/client/components/TopicEntryWorkspace.js";
import { OpportunityFocus } from "../src/client/components/OpportunityFocus.js";

function trendCandidate(index: number, overrides: Partial<StudioCandidateInboxItem> = {}): StudioCandidateInboxItem {
  return {
    id: `trend-${index}`,
    origin: "trend",
    category: "technology",
    freshness: "live",
    risk: "low",
    verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
    editorialDecision: {
      verdict: "produce_video", score: 80, reasons: ["适合视频表达。"], guardrails: ["逐镜核验。"],
    },
    title: `候选提案 ${index}`,
    platform: "douyin",
    track: "daily-observer",
    audience: "中文短视频用户",
    painPoint: "信息很多但缺少判断",
    hook: `第 ${index} 条开场钩子。`,
    rationale: "来自语义模型与真实热点。",
    providerId: "api-topic-editor-v1",
    generatedAt: "2026-10-04T02:00:00.000Z",
    evidence: [{ source: "dailyhot", platform: "douyin", keyword: `候选 ${index}`, strength: 90 }],
    score: { audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80, novelty: 80, monetization: 60, seriesPotential: 80, complianceRisk: 10, final: 78 },
    ...overrides,
  };
}

function buildInbox(items: StudioCandidateInboxItem[], topicGeneration?: StudioTopicGenerationReceipt): StudioCandidateInbox {
  return {
    items,
    facets: { total: items.length, origins: { trend: items.length }, categories: { technology: items.length }, platforms: { douyin: items.length }, verdicts: { produce_video: items.length } },
    generatedAt: "2026-10-04T02:00:00.000Z",
    refreshing: false,
    ...(topicGeneration ? { topicGeneration } : {}),
  };
}

const auditReceipt: StudioTopicGenerationReceipt = {
  generationId: "topic-audit-batch",
  generatedAt: "2026-10-04T01:00:00.000Z",
  modelInvoked: true,
  source: "editor-model",
  candidateCount: 6,
  auditStatus: "awaiting_user",
  auditSummary: "本轮复核建议关注八个选题里的证据链完整性，多条候选的事实来源仍偏单一，建议补充跨平台印证后再进入制作，避免单源断言被当成已核事实；另有若干候选的标题使用了绝对化表述，需要在正式制作前收紧为可核验的说法，并确认画面依据与事实主张一一对应，这些都不改变候选的可用性，只影响采信程度。",
  auditSuggestions: ["建议一：补充第二来源的原始链接。", "建议二：区分热度信号与事实可信度。", "建议三：为高风险主题补充反例。", "建议四：收紧标题里的绝对化表述。"],
  auditRepairInstructions: ["建议一：补充第二来源的原始链接。", "修复说明：重新绑定 sourceId。"],
};

function renderTrendWorkspace(inbox: StudioCandidateInbox, trendMeta: Parameters<typeof trendStatusText>[0]) {
  return render(<MemoryRouter><TopicEntryWorkspace
    initialMode="trend"
    selectedSeriesId={undefined}
    inbox={inbox}
    series={[]}
    historicalRuns={[]}
    loading={{}}
    trendMeta={trendMeta}
    onRetry={() => undefined}
    onRefreshTrends={() => undefined}
    onAdopt={async () => undefined}
    onCreateSeries={() => undefined}
    onSelectSeries={() => undefined}
    onUpdateSeriesEpisode={async () => undefined}
    onLinkLegacyRun={async () => undefined}
    onRescanSeries={async () => undefined}
    onViewProductionRecords={() => undefined}
    onManual={() => undefined}
    onImport={() => undefined}
  /></MemoryRouter>);
}

// CLOUD-05/P2.1（V06、V07）：复核建议默认紧凑、全文可展开、批次与列表范围分开。
describe("topic audit advice panel", () => {
  it("explains repair fields without losing content constraints or changing the original receipt", async () => {
    const original = "把标题、hook 与 b6 改成现在能兑现的承诺；b5 标注为官方原文到位后执行。保留 p11/p12/p13 的引用，不写未经核对的数字；按合同留候选。sourceId 仍指向 https://example.com/p11。维生素 B6 与 abc_b5 不是稿件编号。";
    const receipt = { ...auditReceipt, auditRepairInstructions: [original] };
    const before = JSON.stringify(receipt);
    renderTrendWorkspace(buildInbox([trendCandidate(1)], receipt), { platformCount: 1, candidateCount: 1 });
    const panel = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    await userEvent.click(panel.querySelector("summary")!);
    const advice = screen.getByRole("list", { name: "补充内容建议" });
    expect(advice).toHaveTextContent("开场表达");
    expect(advice).toHaveTextContent("画面段落（编号 6）");
    expect(advice).toHaveTextContent("引用段落（编号 11）");
    expect(advice).toHaveTextContent("引用段落（编号 13）");
    expect(advice).toHaveTextContent("官方原文到位后执行");
    expect(advice).toHaveTextContent("不写未经核对的数字");
    expect(advice).toHaveTextContent("按选题要求保留候选");
    expect(advice).toHaveTextContent("https://example.com/p11");
    expect(advice).toHaveTextContent("维生素 B6 与 abc_b5");
    expect(advice).not.toHaveTextContent(/\bhook\b|\bsourceId\b|按合同/);
    const rawSummary = screen.getByText("查看原始复核说明（含技术标识）");
    expect((rawSummary.parentElement as HTMLDetailsElement).open).toBe(false);
    await userEvent.click(rawSummary);
    expect(screen.getByText(original)).toBeVisible();
    expect(JSON.stringify(receipt)).toBe(before);
  });

  it("keeps the advice collapsed by default with a marked excerpt, and expands to the full text and all suggestions", async () => {
    const items = Array.from({ length: 5 }, (_, index) => trendCandidate(index + 1));
    renderTrendWorkspace(buildInbox(items, auditReceipt), { platformCount: 2, candidateCount: 5 });
    const panel = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    expect(panel).not.toBeNull();
    expect(panel.open).toBe(false);
    const summary = panel.querySelector("summary")!;
    expect(summary.textContent).toContain("复核建议不阻止你采用任何候选");
    expect(summary.textContent).toContain("（原文节选）");
    // 折叠时只露节选：完整结尾不可读，且原文“八个选题”保持原话不改写成当前数量。
    expect(summary.textContent).not.toContain("只影响采信程度");

    await userEvent.click(summary);
    expect(panel.open).toBe(true);
    // 原文“八个选题”原样保留在完整摘要里（摘要节选里也含同词，属同一段文字）。
    expect(within(panel).getAllByText(/八个选题/).length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByText(/^复核摘要全文：/)).toBeInTheDocument();
    expect(within(panel).getAllByText(/^建议[一二三四]：/).length).toBe(4);
    // repairInstructions 中与建议相同的文字不重复；不同的补在完整区。
    expect(within(panel).getByRole("list", { name: "补充内容建议" })).toHaveTextContent("修复说明：重新关联来源。");
    expect(within(panel).getByText(/这份意见针对该批次（6 条候选，生成于/)).toBeInTheDocument();
    expect(within(panel).getByText(/现在可见 5 条/)).toBeInTheDocument();
  });

  it("separates batch numbers from the visible list without extracting counts from prose", async () => {
    const items = Array.from({ length: 5 }, (_, index) => trendCandidate(index + 1));
    renderTrendWorkspace(buildInbox(items, { ...auditReceipt, candidateCount: 6 }), { platformCount: 2, candidateCount: 5 });
    const panel = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    await userEvent.click(panel.querySelector("summary")!);
    const scope = within(panel).getByText(/这份意见针对该批次/);
    expect(scope.textContent).toContain("6 条候选");
    expect(scope.textContent).toContain("现在可见 5 条");
    // 不把原文“八”改写，也不把候选数 6 冒充审计覆盖数。
    expect(scope.textContent).not.toMatch(/八/);
  });

  it("still shows advice for a passed batch with suggestions and nothing without receipt or advice", () => {
    const items = [trendCandidate(1)];
    const { rerender } = renderTrendWorkspace(buildInbox(items, { ...auditReceipt, auditStatus: "passed" as const }), { platformCount: 1, candidateCount: 1 });
    expect(document.querySelector("details.candidate-audit-advice")).not.toBeNull();

    rerender(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend" selectedSeriesId={undefined} inbox={buildInbox(items)} series={[]} historicalRuns={[]} loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 1 }} onRetry={() => undefined} onRefreshTrends={() => undefined}
      onAdopt={async () => undefined} onCreateSeries={() => undefined} onSelectSeries={() => undefined}
      onUpdateSeriesEpisode={async () => undefined} onLinkLegacyRun={async () => undefined} onRescanSeries={async () => undefined}
      onViewProductionRecords={() => undefined} onManual={() => undefined} onImport={() => undefined}
    /></MemoryRouter>);
    expect(document.querySelector("details.candidate-audit-advice")).toBeNull();
  });

  it("keeps the fold across same-batch filtering and collapses again for a new batch", async () => {
    const items = Array.from({ length: 5 }, (_, index) => trendCandidate(index + 1));
    const { rerender } = renderTrendWorkspace(buildInbox(items, auditReceipt), { platformCount: 2, candidateCount: 5 });
    const panel = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    await userEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(true);

    // 同一批次（generationId 不变）：筛选改变可见数，折叠状态不重置。
    rerender(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend" selectedSeriesId={undefined} inbox={buildInbox(items, auditReceipt)} series={[]} historicalRuns={[]} loading={{}}
      trendMeta={{ platformCount: 2, candidateCount: 2 }} onRetry={() => undefined} onRefreshTrends={() => undefined}
      onAdopt={async () => undefined} onCreateSeries={() => undefined} onSelectSeries={() => undefined}
      onUpdateSeriesEpisode={async () => undefined} onLinkLegacyRun={async () => undefined} onRescanSeries={async () => undefined}
      onViewProductionRecords={() => undefined} onManual={() => undefined} onImport={() => undefined}
    /></MemoryRouter>);
    const sameBatch = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    expect(sameBatch.open).toBe(true);

    // 新批次重新默认收起。
    rerender(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend" selectedSeriesId={undefined} inbox={buildInbox(items, { ...auditReceipt, generationId: "topic-audit-batch-2" })} series={[]} historicalRuns={[]} loading={{}}
      trendMeta={{ platformCount: 2, candidateCount: 5 }} onRetry={() => undefined} onRefreshTrends={() => undefined}
      onAdopt={async () => undefined} onCreateSeries={() => undefined} onSelectSeries={() => undefined}
      onUpdateSeriesEpisode={async () => undefined} onLinkLegacyRun={async () => undefined} onRescanSeries={async () => undefined}
      onViewProductionRecords={() => undefined} onManual={() => undefined} onImport={() => undefined}
    /></MemoryRouter>);
    const nextBatch = document.querySelector("details.candidate-audit-advice") as HTMLDetailsElement;
    expect(nextBatch.open).toBe(false);
  });
});

// CLOUD-06/P2.2（V08）：同 URL 同标题只显示一组；不同元信息可展开；计数用组数。
describe("evidence display grouping", () => {
  const sameLink = "https://example.com/article";

  it("merges entries sharing a normalized URL and trimmed keyword only", () => {
    const groups = groupDisplayEvidence([
      { source: "hot", platform: "bilibili", keyword: "上海热点", strength: 80, evidenceUrl: sameLink, collectedAt: "2026-09-29T10:43:00.000Z" },
      { source: "hot", platform: "douyin", keyword: " 上海热点 ", strength: 85, evidenceUrl: `${sameLink}?from=hot`, collectedAt: "2026-09-29T11:00:00.000Z" },
      { source: "hot", platform: "douyin", keyword: "另一个说法", strength: 70, evidenceUrl: sameLink, collectedAt: "2026-09-29T11:00:00.000Z" },
      { source: "hot", platform: "douyin", keyword: "无链接信号", strength: 60 },
      { source: "hot", platform: "douyin", keyword: "无链接信号", strength: 60 },
      { source: "hot", platform: "douyin", keyword: "非法链接", strength: 50, evidenceUrl: "not a url" },
    ]);
    // query 不同、无链接（两条独立）、非法链接、同 URL 不同标题都不合并。
    expect(groups.length).toBe(6);
    const first = groups[0]!;
    expect(first.duplicates.length).toBe(0);
    expect(groups.find((group) => group.primary.keyword.trim() === "另一个说法")!.duplicates.length).toBe(0);
    expect(groups.find((group) => group.primary.keyword.trim() === "无链接信号")!.duplicates.length).toBe(0);
    // URL 规范化等价（尾斜杠与主机大小写）才合并。
    const normalized = groupDisplayEvidence([
      { source: "hot", platform: "a", keyword: "同一条", strength: 1, evidenceUrl: "HTTPS://Example.com/article" },
      { source: "hot", platform: "b", keyword: "同一条", strength: 2, evidenceUrl: "https://example.com/article" },
    ]);
    expect(normalized.length).toBe(1);
    expect(normalized[0]!.duplicates.length).toBe(1);
    expect(normalized[0]!.duplicatesShareVisibleMeta).toBe(false);
  });

  it("labels merged counts honestly and keeps zero-source wording", () => {
    expect(evidenceGroupCountLabel([])).toBe("尚未添加参考来源");
    expect(evidenceGroupCountLabel([
      { source: "hot", platform: "douyin", keyword: "单一", strength: 1 },
    ])).toBe("1 条来源线索");
    expect(evidenceGroupCountLabel([
      { source: "hot", platform: "douyin", keyword: "同一条", strength: 1, evidenceUrl: sameLink },
      { source: "hot", platform: "douyin", keyword: "同一条", strength: 2, evidenceUrl: sameLink },
    ])).toBe("1 组来源线索（原始 2 条记录）");
  });

  it("renders one card per group with the other records expandable and domain counts untouched", async () => {
    const candidateWithDuplicate = trendCandidate(9, {
      evidence: [
        { source: "dailyhot", platform: "douyin", keyword: "上海热点", strength: 90, evidenceUrl: sameLink, collectedAt: "2026-09-29T10:43:00.000Z" },
        { source: "dailyhot", platform: "bilibili", keyword: "上海热点", strength: 70, evidenceUrl: sameLink, collectedAt: "2026-09-30T08:00:00.000Z" },
      ],
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
    });
    renderTrendWorkspace(buildInbox([candidateWithDuplicate]), { platformCount: 1, candidateCount: 1 });
    const evidence = screen.getAllByText("上海热点");
    expect(evidence.length).toBe(1);
    expect(screen.getByText("1 组来源线索（原始 2 条记录） · 1 个有效来源域名（需 1 个）")).toBeInTheDocument();
    const others = screen.getByText("同一链接的其他 1 条记录");
    await userEvent.click(others);
    expect(screen.getByText(/哔哩哔哩 · 2026-09-30 16:00 · 信号 70/)).toBeInTheDocument();

    const opportunity: StudioOpportunity = {
      id: "opp-1", title: "机会", painPoint: "痛点", hook: "钩子", status: "draft", platform: "douyin",
      origin: "trend", evidence: [
        { source: "dailyhot", platform: "douyin", keyword: "上海热点", strength: 90, evidenceUrl: sameLink },
        { source: "dailyhot", platform: "douyin", keyword: "上海热点", strength: 90, evidenceUrl: sameLink },
      ],
      score: { audienceReach: 1, visualFeasibility: 1, productionCostEfficiency: 1, novelty: 1, monetization: 1, seriesPotential: 1, complianceRisk: 1, final: 60 },
      scoreProvenance: { source: "rule", scoredAt: "2026-10-04T00:00:00.000Z" },
      createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规"] },
    } as unknown as StudioOpportunity;
    render(<OpportunityFocus opportunity={opportunity} />);
    expect(screen.getAllByText("上海热点").length).toBe(2); // 候选详情 + 机会详情各一份，两处都不重复。
    expect(screen.getByText("合并 2 条相同链接记录")).toBeInTheDocument();
  });
});

// CLOUD-07/P2.3（V09）：时间表达带日期、分语义、跨时区正确、缺失/非法不炸。
describe("trend time wording", () => {
  it("formats beijing time with full dates and converts UTC correctly", () => {
    // 2026-09-29T10:43Z = 北京时间 18:43。
    expect(beijingDateTime("2026-09-29T10:43:00Z")).toBe("2026-09-29 18:43");
    expect(beijingDateTime("2025-12-31T16:01:00Z")).toBe("2026-01-01 00:01");
    expect(beijingDateTime("not-a-date")).toBeUndefined();
    expect(beijingDateTime(undefined)).toBeUndefined();
  });

  it("prefers collectedAt, falls back to generatedAt with an honest gap note, and never prints Invalid Date", () => {
    expect(trendStatusText({ platformCount: 2, candidateCount: 6, collectedAt: "2026-09-29T10:43:00Z" }))
      .toBe("来源采集 2026-09-29 18:43（北京时间） · 2 个平台 · 6 条");
    expect(trendStatusText({ platformCount: 2, candidateCount: 6, generatedAt: "2026-10-04T01:00:00Z" }))
      .toBe("候选生成 2026-10-04 09:00（北京时间）· 来源采集时间未记录 · 2 个平台 · 6 条");
    expect(trendStatusText({ platformCount: 2, candidateCount: 6 }))
      .toBe("来源采集时间未记录 · 2 个平台 · 6 条");
    expect(trendStatusText({ platformCount: 2, candidateCount: 6, collectedAt: "broken" }))
      .toBe("来源采集时间未记录 · 2 个平台 · 6 条");
  });

  it("reports page refresh separately and keeps old source dates unchanged by refresh", () => {
    expect(trendStatusText({ platformCount: 1, candidateCount: 1, collectedAt: "2026-09-29T10:43:00Z", refreshedAt: "2026-10-04T02:05:00Z" }))
      .toBe("来源采集 2026-09-29 18:43（北京时间） · 本页刷新 2026-10-04 10:05（北京时间） · 1 个平台 · 1 条");
  });

  it("renders the full-date status line in the workspace header", () => {
    renderTrendWorkspace(buildInbox([trendCandidate(1)]), { platformCount: 1, candidateCount: 1, collectedAt: "2026-09-29T10:43:00Z" });
    expect(screen.getByText(/来源采集 2026-09-29 18:43（北京时间）/)).toBeInTheDocument();
  });
});

// 防止未来有人把“选题记录更新”改回“刚刚更新”被误读为来源更新。
describe("opportunity record freshness wording", () => {
  it("labels recent updates as record updates near evidence lists", async () => {
    const { OpportunityRail } = await import("../src/client/components/OpportunityRail.js");
    const opportunity: StudioOpportunity = {
      id: "opp-2", title: "机会", painPoint: "痛点", hook: "钩子", status: "draft", platform: "douyin", origin: "manual",
      evidence: [], updatedAt: new Date(Date.now() - 60_000).toISOString(), createdAt: new Date().toISOString(),
      score: { audienceReach: 1, visualFeasibility: 1, productionCostEfficiency: 1, novelty: 1, monetization: 1, seriesPotential: 1, complianceRisk: 1, final: 60 },
      scoreProvenance: { source: "rule", scoredAt: "2026-10-04T00:00:00.000Z" },
    } as unknown as StudioOpportunity;
    render(<OpportunityRail opportunities={[opportunity]} selectedId="opp-2" onSelect={() => undefined} onCreate={() => undefined} />);
    expect(screen.getByText(/选题记录更新/)).toBeInTheDocument();
    expect(screen.queryByText("刚刚更新")).toBeNull();
  });
});
