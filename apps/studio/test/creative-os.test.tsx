import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AppShell } from "../src/client/components/AppShell.js";
import { DirectorPanel } from "../src/client/components/DirectorPanel.js";
import { OpportunityFocus } from "../src/client/components/OpportunityFocus.js";
import { OpportunityDialog } from "../src/client/components/OpportunityDialog.js";
import { OpportunityRail } from "../src/client/components/OpportunityRail.js";
import { ProductionStrip } from "../src/client/components/ProductionStrip.js";
import { SeriesDialog } from "../src/client/components/SeriesDialog.js";
import { ExperimentsPage } from "../src/client/pages/ExperimentsPage.js";
import { ProductionPage } from "../src/client/pages/ProductionPage.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import { TodayPage } from "../src/client/pages/TodayPage.js";
import type { StudioCandidateInboxItem, StudioOpportunity, StudioProvider, StudioRunSummary, StudioSeries, StudioTemplate, StudioTrendSource } from "../src/shared/api.js";

const opportunity: StudioOpportunity = {
  id: "opportunity-1",
  origin: "trend",
  title: "下班后什么都不想做，是懒还是耗竭？",
  platform: "douyin",
  track: "ordinary-life",
  audience: "普通上班族",
  painPoint: "下班后没有精力",
  hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
  status: "shortlisted",
  evidence: [{
    source: "manual-research",
    platform: "douyin",
    keyword: "下班后什么都不想做",
    strength: 86,
    evidenceUrl: "https://example.com/evidence",
    collectedAt: "2026-08-22T10:00:00.000Z",
  }],
  score: {
    audienceReach: 88,
    visualFeasibility: 90,
    productionCostEfficiency: 84,
    novelty: 78,
    monetization: 62,
    seriesPotential: 91,
    complianceRisk: 18,
    final: 84,
  },
  scoreProvenance: {
    source: "人工维度评分 · topic-intelligence-v1",
    scoredAt: "2026-08-22T10:00:00.000Z",
  },
  createdAt: "2026-08-22T10:00:00.000Z",
  updatedAt: "2026-08-22T10:00:00.000Z",
};

const providers: StudioProvider[] = [
  { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "本地视觉导演", available: true, kind: "local" },
  { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑卡片", available: true, kind: "local" },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "FFmpeg 渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "技术审片", available: true, kind: "local" },
  { id: "codex-role-auditor-v1", capability: "role.audit", label: "Codex 独立质量审计", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
];

const trendSources: StudioTrendSource[] = [
  {
    id: "manual-research",
    label: "人工研究",
    kind: "native",
    status: "ready",
    description: "录入已经人工核验的热点、搜索词或评论信号。",
    cadence: "随时",
  },
  {
    id: "douyin-hotsearch",
    label: "抖音官方热点",
    kind: "native",
    status: "needs_config",
    description: "读取实时热点词、上升词和关联视频。",
    cadence: "约 2 小时",
    requirement: "需要获批 hotsearch scope",
  },
];

const runningRun: StudioRunSummary = {
  id: "run-1",
  title: "为什么我们越来越不愿意接电话",
  status: "running",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-08-22T10:00:00.000Z",
  currentNodeId: "assets",
  creationOrigin: "trend",
};

function candidate(index: number, category: StudioCandidateInboxItem["category"]): StudioCandidateInboxItem {
  return {
    id: `trend-${index}`,
    origin: "trend",
    category,
    freshness: "live",
    risk: "low",
    verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
    editorialDecision: { verdict: "produce_video", score: 82, reasons: ["适合视频表达。"], guardrails: ["逐镜核验。"] },
    title: `候选提案 ${index}`,
    platform: index % 2 === 0 ? "bilibili" : "douyin",
    track: "daily-observer",
    audience: "中文短视频用户",
    painPoint: "信息很多但缺少判断",
    hook: `这是第 ${index} 条可核验的开场钩子。`,
    rationale: "来自语义模型与真实热点。",
    providerId: "api-topic-editor-v1",
    generatedAt: "2026-08-24T08:05:00.000Z",
    evidence: [{ source: "dailyhot", platform: "douyin", keyword: `候选 ${index}`, strength: 90 }],
    score: {
      audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80,
      novelty: 80, monetization: 60, seriesPotential: 80, complianceRisk: 10, final: 78,
    },
  };
}

function inbox(items: StudioCandidateInboxItem[]) {
  return {
    items,
    facets: {
      total: items.length,
      origins: { trend: items.filter((item) => item.origin === "trend").length },
      categories: {
        technology: items.filter((item) => item.category === "technology").length,
        society: items.filter((item) => item.category === "society").length,
      },
      platforms: { douyin: items.filter((item) => item.platform === "douyin").length },
      verdicts: {
        produce_video: items.filter((item) => item.editorialDecision.verdict === "produce_video").length,
        produce_image_story: items.filter((item) => item.editorialDecision.verdict === "produce_image_story").length,
        skip: items.filter((item) => item.editorialDecision.verdict === "skip").length,
      },
    },
    generatedAt: "2026-08-24T09:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("Creative OS", () => {
  it("treats both manual and custom query aliases as the isolated custom creation entry", async () => {
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    const { unmount } = render(<MemoryRouter initialEntries={["/topics?mode=custom"]}><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自定义创作" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "热点候选收件箱" })).not.toBeInTheDocument();
    unmount();

    render(<MemoryRouter initialEntries={["/topics?mode=manual"]}><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自定义创作" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "热点候选收件箱" })).not.toBeInTheDocument();
  });

  it("keeps already-produced opportunities out of every entry's pending-production area", async () => {
    const pending = { ...opportunity, id: "manual-pending", origin: "manual" as const, title: "仍待制作的自定义选题" };
    const produced = { ...pending, id: "manual-produced", status: "approved" as const, title: "已经投产的自定义选题" };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([produced, pending]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    render(<MemoryRouter initialEntries={["/topics?mode=custom"]}><TodayPage /></MemoryRouter>);

    const pendingHeading = await screen.findByRole("heading", { name: "待制作机会" });
    expect(screen.getByRole("heading", { name: pending.title })).toBeInTheDocument();
    expect(screen.queryByText(produced.title)).not.toBeInTheDocument();
    expect(pendingHeading.closest("header")?.querySelector(":scope > span")).toHaveTextContent("1 条");
  });

  it("uses an existing run as a fallback guard against duplicate production", async () => {
    const pending = { ...opportunity, id: "trend-with-run", title: "状态同步失败但已创建制作" };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([pending]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...runningRun, opportunityId: pending.id }]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "待制作机会" })).toBeInTheDocument();
    expect(screen.queryByText(pending.title)).not.toBeInTheDocument();
    expect(screen.getByText(/已投产内容请到制作记录继续/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看制作记录" })).toHaveAttribute("href", "/projects");
  });

  it("keeps all agent candidates visible beside persisted opportunities and filters by category", async () => {
    const user = userEvent.setup();
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(index + 1, index < 5 ? "technology" : "society"));
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "热点候选收件箱" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /查看候选提案/ })).toHaveLength(8);
    expect(screen.getByRole("heading", { name: opportunity.title })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /科技 5/ }));
    expect(screen.getAllByRole("button", { name: /查看候选提案/ })).toHaveLength(5);
  });

  it("shows broad trend categories and performs an explicit upstream refresh", async () => {
    const user = userEvent.setup();
    const candidates = [candidate(1, "technology"), candidate(2, "society")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1", state: "running", requestedAt: "2026-08-30T10:00:00.000Z",
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    await waitFor(() => expect(screen.getByText(/2 个平台 · 2 条/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "游戏电竞 0" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "汽车 0" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/后台更新已开始/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即刷新热点" })).toBeEnabled();
  });

  it("distinguishes collected trend signals from candidates still waiting for a decision", async () => {
    const user = userEvent.setup();
    const collected = [candidate(1, "technology"), candidate(2, "society")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox")
      .mockResolvedValueOnce(inbox(collected))
      .mockResolvedValue(inbox([collected[0]!]));
    vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:01.000Z",
      candidateCount: 2,
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));

    expect(await screen.findByText("本次采集 2 条，其中 1 条已进入制作区；当前有 1 条待判断。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("does not force-refresh trends when the creator returns to the page", async () => {
    const candidates = [candidate(1, "technology")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findByRole("button", { name: /查看候选提案/ });
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps source selection on the home page instead of asking twice", async () => {
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([candidate(1, "technology")]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "热点候选收件箱" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "选题入口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今天做一条视频" })).not.toBeInTheDocument();
  });

  it("uses the home page only as a source launcher without screening candidates again", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([
      { ...runningRun, id: "run-attention", status: "needs_human", nextAction: "review" },
      runningRun,
      { ...runningRun, id: "run-done", status: "succeeded" },
      { ...runningRun, id: "run-failed", status: "failed" },
    ]);
    const candidateInbox = vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([candidate(1, "technology")]));
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "你今天从哪里出发？" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "先替你筛到三条" })).not.toBeInTheDocument();
    expect(candidateInbox).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("待你处理1");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("自动制作1");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("已完成1");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("需调整1");
  });

  it("creates a durable series from the peer series entry mode", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    const create = vi.spyOn(studioApi, "createSeries").mockResolvedValue({
      id: "series-1",
      name: "AI 下班实验室",
      premise: "每集验证一个普通人真能用上的 AI 方法。",
      audience: "普通上班族",
      platform: "douyin",
      category: "technology",
      track: "series-ab12cd34",
      pillars: ["真实任务实验", "成本与时间复盘"],
      tone: "克制、具体、有结论",
      visualStyle: "真实桌面操作与生活空镜",
      status: "active",
      revision: 1,
      currentSeason: { number: 1, title: "第一季", arc: "验证普通人能用的 AI 方法" },
      bible: { rules: ["保持真实验证"], recurringElements: [], forbiddenChanges: [] },
      canon: { revision: 0, facts: [] },
      episodes: [],
      nextEpisodeNumber: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建系列" }));
    await user.type(screen.getByLabelText("系列名称"), "AI 下班实验室");
    await user.type(screen.getByLabelText("系列承诺"), "每集验证一个普通人真能用上的 AI 方法。");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    await user.click(screen.getByRole("button", { name: "创建系列" }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "AI 下班实验室",
      category: "technology",
      pillars: ["真实问题拆解", "方法与结果复盘"],
      platform: "douyin",
      tone: "克制、具体、有结论",
    }));
    expect(await screen.findByRole("option", { name: /AI 下班实验室/ })).toBeInTheDocument();
  });

  it("exposes the four real workspaces in the primary navigation", async () => {
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(navigation.getByRole("link", { name: /创作台/ })).toHaveAttribute("href", "/");
    expect(navigation.getByRole("link", { name: /制作记录/ })).toHaveAttribute("href", "/projects");
    expect(navigation.getByRole("link", { name: /素材库/ })).toHaveAttribute("href", "/assets");
    expect(navigation.getByRole("link", { name: /模板工坊/ })).toHaveAttribute("href", "/templates");
    expect(navigation.getByRole("link", { name: /总配置/ })).toHaveAttribute("href", "/resources");
    expect(navigation.getByRole("link", { name: /制作复盘/ })).toHaveAttribute("href", "/experiments");
  });

  it("opens an account menu before signing out", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    render(
      <MemoryRouter>
        <AppShell username="creator@example.com" onLogout={onLogout}><div>content</div></AppShell>
      </MemoryRouter>,
    );

    const accountTriggers = screen.getAllByRole("button", { name: /账号菜单/ });
    await user.click(accountTriggers[0]!);

    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "账号菜单" })).toBeInTheDocument();
    expect(screen.getByText("creator@example.com", { selector: ".studio-account-identity strong" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("searches real production records from the global command surface", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...runningRun, title: "窗边一杯水的六秒光影" }]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、模板或功能" }), "窗边一杯水");

    expect(await screen.findByRole("link", { name: /窗边一杯水的六秒光影/ })).toHaveAttribute("href", "/projects/run-1");
  });

  it("closes global search with Escape, clears it, and restores focus", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    const trigger = screen.getByRole("button", { name: "搜索项目、模板或功能" });
    await user.click(trigger);
    const search = screen.getByRole("textbox", { name: "搜索项目、模板或功能" });
    await user.type(search, "模板");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "搜索项目、模板或功能" })).toHaveValue("");
  });

  it("keeps opportunity selection, evidence, and production action in one workspace", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onProduce = vi.fn();
    render(
      <div>
        <OpportunityRail opportunities={[opportunity]} selectedId={opportunity.id} onSelect={onSelect} onCreate={() => undefined} />
        <OpportunityFocus opportunity={opportunity} />
        <DirectorPanel opportunity={opportunity} providers={providers} onProduce={onProduce} />
      </div>,
    );

    expect(screen.getAllByText(opportunity.title).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /manual-research/ })).toHaveAttribute("href", "https://example.com/evidence");
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByLabelText("机会评分维度")).toHaveTextContent("安全82%");
    expect(screen.getAllByText(/人工评分/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "新建制作" }));
    expect(onProduce).toHaveBeenCalledOnce();
  });

  it("describes topic intelligence according to the selected creation origin", () => {
    const topicProviders: StudioProvider[] = [
      ...providers,
      { id: "api-topic-editor-v1", capability: "topic.intelligence", label: "Codex 选题总编", available: true, kind: "external" },
    ];
    const { rerender } = render(<MemoryRouter><DirectorPanel opportunity={{ ...opportunity, origin: "manual" }} providers={topicProviders} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByText("自定义命题复核、机会评分与证据门禁由 Codex 执行")).toBeInTheDocument();

    rerender(<MemoryRouter><DirectorPanel opportunity={{ ...opportunity, origin: "series" }} providers={topicProviders} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByText("系列选题、连续性检查与开拍审计由 Codex 执行")).toBeInTheDocument();
  });

  it("carries the configured default duration into an adopted opportunity", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 45 },
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建制作" }));

    expect(screen.getByRole("combobox", { name: "视频时长" })).toHaveValue("45");
  });

  it("presents an executable visual plan for every topic without fake stock frames", () => {
    render(<OpportunityFocus opportunity={opportunity} />);

    const shotBoard = screen.getByRole("region", { name: "镜头方向示意" });
    expect(shotBoard).toHaveAttribute("data-tour", "visual-direction");
    expect(within(shotBoard).getByText("镜头 01")).toBeInTheDocument();
    expect(within(shotBoard).getByText("镜头 02")).toBeInTheDocument();
    expect(within(shotBoard).getByText("镜头 03")).toBeInTheDocument();
    expect(within(shotBoard).getAllByText(/素材搜索：下班后什么都不想做/)).toHaveLength(3);
    expect(within(shotBoard).queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps successful data regions visible when the opportunity source fails", async () => {
    vi.spyOn(studioApi, "opportunities").mockRejectedValue(new Error("trend adapter timeout"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([runningRun]);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "机会读取失败" })).toBeInTheDocument());
    expect(screen.getByText(runningRun.title)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "当前没有可用热点候选" })).not.toBeInTheDocument();
  });

  it("does not turn failed resource or analytics requests into fake empty metrics", async () => {
    vi.spyOn(studioApi, "providers").mockRejectedValue(new Error("provider registry offline"));
    vi.spyOn(studioApi, "trendSources").mockRejectedValue(new Error("trend registry offline"));
    vi.spyOn(studioApi, "settings").mockRejectedValue(new Error("settings store offline"));
    vi.spyOn(studioApi, "runs").mockRejectedValue(new Error("run store offline"));
    render(<MemoryRouter><ResourcesPage /><ExperimentsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("画面能力状态未知")).toBeInTheDocument());
    expect(screen.getByText("热点源状态未知")).toBeInTheDocument();
    expect(screen.getByText("制作统计未知")).toBeInTheDocument();
    expect(screen.getByText("创作默认值读取失败")).toBeInTheDocument();
    expect(screen.queryByText("当前默认值已保存")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("制作统计")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未配置")).not.toBeInTheDocument();
  });

  it("does not turn a failed project request into an empty queue", async () => {
    vi.spyOn(studioApi, "runs").mockRejectedValue(new Error("run store offline"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    render(<MemoryRouter><ProductionPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "制作记录读取失败" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "还没有制作记录" })).not.toBeInTheDocument();
  });

  it("shows real active production without inventing performance metrics", () => {
    render(<MemoryRouter><ProductionStrip runs={[runningRun]} /></MemoryRouter>);

    expect(screen.getByText("正在制作")).toBeInTheDocument();
    expect(screen.getByText(runningRun.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看生产/ })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.queryByText(/播放量/)).not.toBeInTheDocument();
  });

  it("uses a designed unconfigured state when no trend opportunities exist", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "当前没有可用热点候选" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "手动录入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument();
    expect(screen.getByText(/上游暂时离线/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导入 JSON" }));
    expect(screen.getByRole("tab", { name: "JSON 导入" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: /机会数据/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "录入机会" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 JSON" })).toHaveFocus();
  });

  it("keeps the manual path usable while the local topic model is warming up", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockReturnValue(new Promise(() => undefined));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "正在生成今日提案" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今天做一条视频" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "录入自己的选题" }));
    expect(screen.getByRole("dialog", { name: "录入机会" })).toBeInTheDocument();
  });

  it("shows local series candidates while the trend model is still warming up", async () => {
    const user = userEvent.setup();
    const seriesCandidate: StudioCandidateInboxItem = {
      ...candidate(20, "lifestyle"),
      id: "series-series-1-episode-001",
      origin: "series",
      freshness: "evergreen",
      providerId: "series-planner-v1",
      seriesId: "series-1",
      seriesName: "下班观察室",
      episodeNumber: 1,
    };
    const secondSeriesCandidate: StudioCandidateInboxItem = {
      ...candidate(21, "education"),
      id: "series-series-2-episode-001",
      title: "第二个系列的第一集",
      origin: "series",
      freshness: "evergreen",
      providerId: "series-planner-v1",
      seriesId: "series-2",
      seriesName: "长期学习档案",
      episodeNumber: 1,
    };
    const opportunities = vi.spyOn(studioApi, "opportunities").mockResolvedValue([{
      ...opportunity,
      id: "series-series-1-episode-002",
      origin: "series",
      title: "已采用、尚未开工的第二集",
      seriesId: "series-1",
      episodeNumber: 2,
    }, {
      ...opportunity,
      id: "series-opportunity-finished",
      origin: "series",
      title: "历史成片不应再次制作",
      seriesId: "series-1",
      episodeNumber: 3,
    }]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    const runs = vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    const firstEpisode: StudioSeries["episodes"][number] = {
      id: seriesCandidate.id,
      seriesId: "series-1",
      episodeNumber: 1,
      seasonNumber: 1,
      arc: "回答真实难题",
      pillar: "问题",
      title: seriesCandidate.title,
      viewerPromise: seriesCandidate.painPoint,
      hook: seriesCandidate.hook,
      payoff: "回答一个真实难题",
      canonBaseRevision: 0,
      status: "planned",
      continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: ["留下下一集问题"], canonChecks: ["保持真实"] },
      planning: { source: "agent", role: "系列总编", auditRole: "独立质量审计 Agent", auditStatus: "passed", auditIterations: 2, auditScore: 91, auditSummary: "路线图有独立价值并形成递进。", providerId: "openai", modelId: "codex-default", promptVersion: "video-factory/series-showrunner-v1", reasoningEffort: "xhigh" },
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    };
    const seriesRecord: StudioSeries = {
      id: "series-1", name: "下班观察室", premise: "回答真实难题", audience: "上班族", platform: "douyin",
      category: "lifestyle", track: "after-work", pillars: ["问题", "复盘"], tone: "具体", visualStyle: "生活实拍",
      revision: 1, currentSeason: { number: 1, title: "第一季", arc: "回答真实难题" },
      bible: { rules: ["保持真实"], recurringElements: [], forbiddenChanges: [] }, canon: { revision: 0, facts: [] }, episodes: [firstEpisode, {
        ...firstEpisode,
        id: "series-series-1-episode-002",
        episodeNumber: 2,
        title: "已采用、尚未开工的第二集",
        status: "selected",
        opportunityId: "series-series-1-episode-002",
      }, {
        ...firstEpisode,
        id: "series-series-1-episode-003",
        episodeNumber: 3,
        title: "历史成片不应再次制作",
        status: "ready",
        opportunityId: "series-opportunity-finished",
        runId: "run-finished",
      }],
      status: "active", nextEpisodeNumber: 1, createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T09:00:00.000Z",
    };
    const secondSeriesRecord: StudioSeries = {
      ...seriesRecord,
      id: "series-2",
      name: "长期学习档案",
      track: "learning-journal",
      episodes: [{
        ...seriesRecord.episodes[0]!,
        id: secondSeriesCandidate.id,
        seriesId: "series-2",
        title: secondSeriesCandidate.title,
      }],
    };
    vi.spyOn(studioApi, "series").mockResolvedValue([seriesRecord, secondSeriesRecord]);
    const updateEpisode = vi.spyOn(studioApi, "updateSeriesEpisodePlan").mockImplementation(async (_seriesId, _episodeNumber, input) => ({
      ...seriesRecord,
      revision: 2,
      episodes: seriesRecord.episodes.map((episode) => ({
        ...episode,
        ...input,
        continuity: { ...episode.continuity, fromPrevious: input.fromPrevious, toNext: input.toNext },
        planning: {
          source: "human" as const,
          role: "主创手工改写",
          auditRole: "后续制作节点独立审计",
          auditStatus: "human_override" as const,
          auditIterations: 0,
          providerId: "human",
          modelId: "manual",
          promptVersion: "video-factory/series-episode-edit-v1",
        },
      })),
    }));
    vi.spyOn(studioApi, "candidateInbox").mockImplementation((query) => query?.origins?.includes("trend")
      ? new Promise(() => undefined)
      : Promise.resolve(inbox([seriesCandidate, secondSeriesCandidate])));
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("region", { name: "本季策划摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /E01.*候选提案 20/ })).toBeInTheDocument();
    expect(screen.getByText("openai / codex-default")).toBeInTheDocument();
    expect(screen.getByText("独立审计 2/3 轮通过")).toBeInTheDocument();
    expect(screen.getByText(/路线图有独立价值并形成递进.*91 分/)).toBeInTheDocument();
    expect(screen.getByText("xhigh")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑路线图" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "本集制作准备" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择待制作单集" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "选择待制作单集" })).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /历史成片不应再次制作/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "候选机会" })).not.toBeInTheDocument();
    expect(opportunities).toHaveBeenCalledWith("series");
    expect(runs).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("heading", { name: "正在生成今日提案" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("选择系列"), "series-2");
    expect(screen.getByRole("button", { name: /E01.*第二个系列的第一集/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /E01.*候选提案 20/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("选择系列"), "series-1");

    await user.click(screen.getByRole("button", { name: "编辑路线图" }));
    const dialog = screen.getByRole("dialog", { name: "编辑第 1 集" });
    const title = within(dialog).getByLabelText("单集标题");
    await user.clear(title);
    await user.type(title, "人工确定的第一集");
    await user.click(within(dialog).getByRole("button", { name: "保存人工版本" }));
    await waitFor(() => expect(updateEpisode).toHaveBeenCalledWith("series-1", 1, expect.objectContaining({
      expectedRevision: 1,
      title: "人工确定的第一集",
    })));
    expect(await screen.findByText(/第 1 集路线图已保存为人工版本/)).toBeInTheDocument();
    expect(screen.getByText("人工 / 手工编辑")).toBeInTheDocument();
    expect(screen.getByText("人工决定")).toBeInTheDocument();
    expect(screen.queryByText(/审计结论：/)).not.toBeInTheDocument();
  });

  it("turns local agent candidates into editable opportunities with one explicit action", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const proposal: StudioCandidateInboxItem = {
      id: "trend-1",
      origin: "trend",
      category: "technology",
      freshness: "live",
      risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
      editorialDecision: { verdict: "produce_video", score: 86, reasons: ["适合视频表达。"], guardrails: ["逐镜核验。"] },
      title: "下班后的 AI 时间账本",
      platform: "douyin",
      track: "ai-daily-life",
      audience: "普通上班族",
      painPoint: "工具很多，却没有减少疲惫",
      hook: "真正偷走你下班时间的，可能不是加班。",
      rationale: "热点规模与低成本生活实验相交。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-08-24T08:05:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "AI 时间", strength: 96 }],
      score: {
        audienceReach: 90, visualFeasibility: 88, productionCostEfficiency: 90,
        novelty: 84, monetization: 72, seriesPotential: 88, complianceRisk: 12, final: 86,
      },
    };
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([proposal]));
    const adopt = vi.spyOn(studioApi, "adoptCandidate").mockResolvedValue({ ...opportunity, id: "trend-1", title: "下班后的 AI 时间账本" });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findByRole("heading", { name: "热点候选收件箱" });
    expect(screen.getAllByText("下班后的 AI 时间账本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex 选题总编").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "采用候选 下班后的 AI 时间账本" }));

    expect(adopt).toHaveBeenCalledWith("trend-1", { origin: "trend" });
    expect(screen.getByRole("heading", { name: "下班后的 AI 时间账本" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("下一步：检查证据与镜头计划");
  });

  it("requires explicit evidence confirmation for review candidates and blocks insufficient high-risk candidates", async () => {
    const user = userEvent.setup();
    const reviewCandidate: StudioCandidateInboxItem = {
      ...candidate(31, "society"),
      id: "trend-review",
      title: "警方通报一项社会事件",
      risk: "review",
      verification: { status: "review_required", independentSources: 1, requiredSources: 1, reasons: ["采用前需要人工核验"] },
      evidence: [{ source: "newsnow", platform: "weibo", keyword: "警方通报", strength: 90, evidenceUrl: "https://example.com/report" }],
    };
    const blockedCandidate: StudioCandidateInboxItem = {
      ...candidate(32, "society"),
      id: "trend-blocked",
      title: "台风登陆消息持续更新",
      risk: "high",
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["高风险热点至少需要 2 个独立来源"] },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([reviewCandidate, blockedCandidate]));
    const adopt = vi.spyOn(studioApi, "adoptCandidate").mockResolvedValue({ ...opportunity, id: reviewCandidate.id });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByText("1 条证据 · 1 个独立源（需 1 个）")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: `采用候选 ${reviewCandidate.title}` }));
    expect(screen.getByRole("dialog", { name: "采用前核验证据" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /我已打开原始来源/ }));
    await user.click(screen.getByRole("button", { name: "确认核验并采用" }));
    expect(adopt).toHaveBeenCalledWith(reviewCandidate.id, { origin: "trend", verificationConfirmed: true });

    await user.click(screen.getByRole("button", { name: `查看${blockedCandidate.title}` }));
    expect(screen.getByRole("button", { name: `采用候选 ${blockedCandidate.title}` })).toBeDisabled();
    expect(screen.getByText(/至少需要 2 个独立来源/)).toBeInTheDocument();
  });

  it("shows an actionable error when adopting an agent candidate fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const proposal: StudioCandidateInboxItem = {
      id: "trend-invalid",
      origin: "trend",
      category: "lifestyle",
      freshness: "today",
      risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
      editorialDecision: { verdict: "produce_video", score: 78, reasons: ["适合视频表达。"], guardrails: ["逐镜核验。"] },
      title: "一个待核验的热点角度",
      platform: "douyin",
      track: "ordinary-life",
      audience: "普通上班族",
      painPoint: "信息很多但缺少判断",
      hook: "先看证据，再谈结论。",
      rationale: "来自本地热点信号。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-08-24T08:05:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "热点", strength: 80 }],
      score: {
        audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80,
        novelty: 70, monetization: 50, seriesPotential: 70, complianceRisk: 10, final: 78,
      },
    };
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([proposal]));
    vi.spyOn(studioApi, "adoptCandidate").mockRejectedValue(new Error("选题保存失败"));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "采用候选 一个待核验的热点角度" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("采用候选失败：选题保存失败");
    expect(screen.getByRole("button", { name: "采用候选 一个待核验的热点角度" })).toBeEnabled();
  });

  it("does not mark an opportunity approved when run creation fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [knowledgeTemplate()] });
    const start = vi.spyOn(studioApi, "start").mockRejectedValue(new Error("制作创建失败"));
    const updateStatus = vi.spyOn(studioApi, "updateOpportunityStatus");
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建制作" }));
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("creates a manually scored opportunity with traceable evidence", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("选题标题"), opportunity.title);
    await user.type(screen.getByLabelText("目标受众"), opportunity.audience);
    await user.type(screen.getByLabelText("核心痛点"), opportunity.painPoint);
    await user.type(screen.getByLabelText("开场钩子"), opportunity.hook);
    await user.type(screen.getByLabelText("来源名称"), "manual-research");
    await user.type(screen.getByLabelText("观察关键词"), "下班后什么都不想做");
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: opportunity.title,
      track: "ordinary-life",
      evidence: [expect.objectContaining({ source: "manual-research" })],
      scores: expect.objectContaining({ complianceRisk: 20 }),
    }));

    rerender(<OpportunityDialog open={false} onClose={() => undefined} onSubmit={onSubmit} />);
    rerender(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "保存机会" })).toBeEnabled();
  });

  it("creates a quick opportunity with sensible evidence and score defaults", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("选题标题"), "下班后的十分钟如何真正休息");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    await user.type(screen.getByLabelText("核心痛点"), "下班后无法切换状态");
    await user.type(screen.getByLabelText("开场钩子"), "真正让人恢复的，可能不是继续刷手机。");
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      track: "ordinary-life",
      evidence: [expect.objectContaining({
        source: "manual-research",
        platform: "douyin",
        keyword: "下班后的十分钟如何真正休息",
        strength: 70,
      })],
      scores: expect.objectContaining({ audienceReach: 70, complianceRisk: 20 }),
    }));
  });

  it("explains malformed JSON in Chinese and announces the error", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(screen.getByRole("alert")).toHaveTextContent("JSON 格式不正确");

    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{}" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears JSON errors when returning to manual entry", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));
    expect(screen.getByRole("alert")).toHaveTextContent("JSON 格式不正确");

    await user.click(screen.getByRole("tab", { name: "手动录入" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("内容系列")).not.toBeInTheDocument();
  });

  it("shows visible Chinese validation instead of relying on a browser bubble", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("button", { name: "保存机会" }));
    expect(screen.getByRole("alert")).toHaveTextContent("标题不能为空");

    await user.type(screen.getByLabelText("选题标题"), "继续填写选题");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names the missing series field when creation is incomplete", async () => {
    const user = userEvent.setup();
    render(<SeriesDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("button", { name: "创建系列" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写系列名称");

    await user.type(screen.getByLabelText("系列名称"), "继续填写系列");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("imports a structured opportunity without inventing missing fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { final: _final, ...scores } = opportunity.score;
    const input = {
      title: opportunity.title,
      platform: opportunity.platform,
      track: opportunity.track,
      audience: opportunity.audience,
      painPoint: opportunity.painPoint,
      hook: opportunity.hook,
      evidence: opportunity.evidence,
      scores,
    };
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: JSON.stringify(input) } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(input);
  });

  it("blocks production when a required node capability is unavailable", () => {
    render(<MemoryRouter><DirectorPanel opportunity={opportunity} providers={providers.filter((provider) => provider.capability !== "video.render")} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "新建制作" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "查看缺失能力" })).toHaveAttribute("href", "/resources");
  });

  it("does not count a test provider as formal production readiness", () => {
    const providersWithTestVoice = [
      ...providers.filter((provider) => provider.capability !== "voice.synthesize"),
      { id: "ffmpeg-tone-test-v1", capability: "voice.synthesize", label: "测试音轨", available: true, kind: "test" as const },
    ];
    render(<MemoryRouter><DirectorPanel opportunity={opportunity} providers={providersWithTestVoice} onProduce={() => undefined} /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "新建制作" })).toBeDisabled();
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("shows strategic resource gaps and refuses fabricated platform analytics", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue(trendSources);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    render(<MemoryRouter><ResourcesPage /><ExperimentsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("抖音官方热点")).toBeInTheDocument());
    expect(screen.getAllByText("需要配置").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "平台数据尚未接入" })).toBeInTheDocument();
    expect(screen.queryByText(/播放量/)).not.toBeInTheDocument();
  });

  it("exposes model economics and honest trend connector states in the resource registry", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue([
      ...providers,
      {
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "Seedance 关键镜头",
        available: true,
        kind: "external",
        status: "ready",
        billing: "metered",
        description: "按预算生成少量关键镜头。",
        modes: ["文生视频", "9:16"],
        estimatedCnyPerClip: 8,
      },
      {
        id: "kling-video-v1",
        capability: "asset.prepare",
        label: "Kling 可灵",
        available: false,
        kind: "external",
        status: "planned",
        billing: "metered",
        description: "账号权限确认后启用。",
      },
    ]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue(trendSources);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([{
      id: "newsnow",
      label: "NewsNow",
      kind: "aggregator",
      status: "ready",
      lastCheckedAt: "2026-08-28T10:00:00.000Z",
    }]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const assetSection = (await screen.findByRole("heading", { name: "生成与素材模型" })).closest("section");
    expect(assetSection).not.toBeNull();
    expect(within(assetSection!).getByText("Seedance 关键镜头")).toBeInTheDocument();
    expect(within(assetSection!).getByText("Kling 可灵")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "热点接入" })).toBeInTheDocument();
    expect(screen.getByText("抖音官方热点")).toBeInTheDocument();
    expect(screen.getAllByText("按量计费").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需要配置").length).toBeGreaterThan(0);
    expect(within(within(assetSection!).getByText("Seedance 关键镜头").closest("article")!).getByText("已配置")).toBeInTheDocument();
    expect(screen.getByLabelText("NewsNow 内部服务已连接")).toBeInTheDocument();
  });

  it("loads production configuration even when raw trend signals stall", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-01T00:00:00.000Z",
      totalItems: 0,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
      items: [],
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 0,
        duplicateUses: 0,
        reusableCount: 0,
        needsReviewCount: 0,
        facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
        assets: [],
      },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("combobox", { name: "默认导演角色" })).toBeInTheDocument();
    expect(screen.getAllByText("模板脚本").length).toBeGreaterThan(0);
    expect(screen.queryByText("正在读取创作默认值...")).not.toBeInTheDocument();
  });

  it("keeps the configuration room focused on one editable category at a time", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const defaultsLink = screen.getByRole("link", { name: "创作默认" });
    const rolesLink = screen.getByRole("link", { name: "岗位模型" });
    expect(defaultsLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "新建制作默认值" }).closest("section")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("heading", { name: "按角色配置生产能力" }).closest("section")).not.toHaveAttribute("data-active");

    await user.click(rolesLink);

    expect(rolesLink).toHaveAttribute("aria-current", "page");
    expect(defaultsLink).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#production-roles");
    expect(screen.getByRole("heading", { name: "按角色配置生产能力" }).closest("section")).toHaveAttribute("data-active", "true");
  });

  it("persists voice and visual choices as production defaults", async () => {
    const user = userEvent.setup();
    const readyProviders: StudioProvider[] = [
      ...providers,
      { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" as const, status: "ready" as const, billing: "free" as const },
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external" as const, status: "ready" as const, billing: "free" as const },
      {
        id: "minimax-video-v1",
        capability: "asset.prepare",
        label: "MiniMax 视频生成",
        available: true,
        kind: "external" as const,
        status: "ready" as const,
        billing: "metered" as const,
        defaultModelId: "MiniMax-Hailuo-2.3",
        modelProfiles: [
          { id: "MiniMax-Hailuo-2.3", providerId: "minimax-video-v1", providerFamily: "minimax", label: "MiniMax Hailuo 2.3", description: "经济关键镜头", available: true, recommended: true, taskTypes: ["text-to-video"] },
          { id: "MiniMax-H3", providerId: "minimax-video-v1", providerFamily: "minimax", label: "MiniMax H3", description: "高质量关键镜头", available: true, taskTypes: ["text-to-video"] },
        ],
      },
    ];
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    vi.spyOn(studioApi, "providers").mockResolvedValue(readyProviders);
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(initialSettings);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(async (patch) => ({
      ...initialSettings,
      ...patch,
      productionDefaults: { ...initialSettings.productionDefaults, ...patch.productionDefaults },
    }));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "已是制作默认" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "新建制作默认值" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "发布渠道" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "语速" }), { target: { value: "190" } });
    await user.click(await screen.findByRole("button", { name: "设为制作默认" }));
    expect(update).toHaveBeenCalledWith({ voiceDirection: { ...initialSettings.voiceDirection, rate: 190 } });

    const assetSection = screen.getByRole("heading", { name: "生成与素材模型" }).closest("section");
    expect(assetSection).not.toBeNull();
    const pexelsRow = within(assetSection!).getByText("Pexels 视频").closest("article");
    expect(pexelsRow).not.toBeNull();
    await user.click(within(pexelsRow!).getByRole("button", { name: "设为默认" }));
    expect(update).toHaveBeenLastCalledWith({ defaultAssetProviderId: "pexels-stock-v1" });
    const routerRow = within(assetSection!).getByText("AI 逐镜路由").closest("article");
    expect(routerRow).not.toBeNull();
    await user.click(within(routerRow!).getByRole("button", { name: "设为默认" }));
    expect(update).toHaveBeenLastCalledWith({ defaultAssetProviderId: "ai-shot-router-v1" });

    await user.click(screen.getByRole("link", { name: "画面来源" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "MiniMax 视频生成 默认模型" }), "MiniMax-H3");
    await user.click(screen.getByRole("button", { name: "保存画面模型" }));
    expect(update).toHaveBeenLastCalledWith({ modelDefaults: { "minimax-video-v1": "MiniMax-H3" } });

    await user.selectOptions(screen.getByRole("combobox", { name: "默认导演角色" }), "documentary-observer");
    await user.selectOptions(screen.getByRole("combobox", { name: "默认目标平台" }), "bilibili");
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    expect(update).toHaveBeenLastCalledWith({
      defaultRecipeId: "economy-daily",
      productionDefaults: {
        directorProfileId: "documentary-observer",
        reviewMode: "manual",
        platform: "bilibili",
        durationSeconds: 24,
      },
    });
  });

  it("configures providers and models by production role instead of a flat provider registry", async () => {
    const user = userEvent.setup();
    const roleProviders: StudioProvider[] = [
      ...providers.filter((provider) => provider.id !== "codex-role-auditor-v1"),
      {
        id: "codex-screenwriter-v1",
        capability: "script.draft",
        label: "Codex 编剧",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "gpt-5.6-terra",
        modelProfiles: [
          { id: "gpt-5.6-terra", providerId: "codex-screenwriter-v1", providerFamily: "openai", label: "GPT-5.6 Terra", description: "日常创作", available: true, taskTypes: ["text"] },
          { id: "gpt-5.6-sol", providerId: "codex-screenwriter-v1", providerFamily: "openai", label: "GPT-5.6 Sol", description: "高质量创作", available: true, recommended: true, taskTypes: ["text"] },
        ],
      },
      { id: "codex-role-auditor-v1", capability: "role.audit", label: "Codex 独立质量审计", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol", modes: ["独立会话", "xhigh 推理", "最多三轮"] },
    ];
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      roleProviderDefaults: { script: "python-template-v1" },
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    vi.spyOn(studioApi, "providers").mockResolvedValue(roleProviders);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(initialSettings);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-08-30T00:00:00.000Z",
      totalItems: 0,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
      items: [],
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 0,
        duplicateUses: 0,
        reusableCount: 0,
        needsReviewCount: 0,
        facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
        assets: [],
      },
    });
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(async (patch) => ({
      ...initialSettings,
      ...patch,
      roleProviderDefaults: patch.roleProviderDefaults ?? initialSettings.roleProviderDefaults,
      modelDefaults: patch.modelDefaults ?? initialSettings.modelDefaults,
      productionDefaults: { ...initialSettings.productionDefaults, ...patch.productionDefaults },
    }));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "按角色配置生产能力" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "编剧默认能力" })).toHaveValue("python-template-v1");
    expect(screen.getByRole("link", { name: "去画面来源配置" })).toHaveAttribute("href", "#visual-providers");
    expect(screen.getByRole("link", { name: "去声音演员表配置" })).toHaveAttribute("href", "#voice-casting");
    expect(screen.queryByRole("combobox", { name: "画面执行默认能力" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "配音执行默认能力" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "编剧默认能力" }), "codex-screenwriter-v1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Codex 编剧默认模型" }), "gpt-5.6-sol");
    expect(screen.getByText("独立质量审计")).toBeInTheDocument();
    expect(screen.getByText(/xhigh.*最多三轮/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存角色配置" }));

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      roleProviderDefaults: expect.objectContaining({ script: "codex-screenwriter-v1" }),
      modelDefaults: expect.objectContaining({ "codex-screenwriter-v1": "gpt-5.6-sol" }),
    }));
  });
});

function knowledgeTemplate(): StudioTemplate {
  return {
    id: "knowledge-explainer", version: 2, status: "published", name: "知识解释", description: "讲清一个问题。",
    category: "knowledge", platforms: ["douyin"], durationSeconds: 24, automationLevel: "assisted",
    storyStructure: [
      { id: "hook", label: "开场", purpose: "抓住注意", required: true },
      { id: "body", label: "解释", purpose: "展开内容", required: true },
      { id: "close", label: "收束", purpose: "留下结论", required: true },
    ],
    shotSlots: [{ id: "shot", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
    visualSystem: { composition: "主体清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
    qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
    costPolicy: { currency: "CNY", maxCost: 8, maxPaidShots: 1 },
    createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", builtIn: true,
  };
}
