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
import { ExperimentsPage } from "../src/client/pages/ExperimentsPage.js";
import { ProductionPage } from "../src/client/pages/ProductionPage.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";
import { TodayPage } from "../src/client/pages/TodayPage.js";
import type { StudioCandidateInboxItem, StudioOpportunity, StudioProvider, StudioRunSummary, StudioTemplate, StudioTrendSource } from "../src/shared/api.js";

const opportunity: StudioOpportunity = {
  id: "opportunity-1",
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
});

describe("Creative OS", () => {
  it("keeps all agent candidates visible beside persisted opportunities and filters by category", async () => {
    const user = userEvent.setup();
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(index + 1, index < 5 ? "technology" : "society"));
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

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
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue([]);
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    await waitFor(() => expect(screen.getByText(/2 个平台 · 2 条/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "游戏电竞 0" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "汽车 0" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("refreshes stale trends when the creator returns to the page", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const candidates = [candidate(1, "technology")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue([]);
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await screen.findByRole("button", { name: /查看候选提案/ });
    clock.mockReturnValue(5 * 60 * 1_000 + 2_000);
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
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
      nextEpisodeNumber: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("tab", { name: /系列选题/ }));
    await user.click(screen.getByRole("button", { name: "创建第一个系列" }));
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
    expect(navigation.getByRole("link", { name: /今日机会/ })).toHaveAttribute("href", "/");
    expect(navigation.getByRole("link", { name: /制作记录/ })).toHaveAttribute("href", "/projects");
    expect(navigation.getByRole("link", { name: /总配置/ })).toHaveAttribute("href", "/resources");
    expect(navigation.getByRole("link", { name: /制作复盘/ })).toHaveAttribute("href", "/experiments");
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
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 45 },
    });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "机会读取失败" })).toBeInTheDocument());
    expect(screen.getByText(runningRun.title)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "趋势源尚未配置" })).not.toBeInTheDocument();
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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "趋势源尚未配置" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "手动录入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument();
    expect(screen.getByText(/趋势采集器/)).toBeInTheDocument();
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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "正在生成今日提案" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "今天做一条视频" })).toHaveTextContent("选择选题");
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
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([{
      id: "series-1", name: "下班观察室", premise: "回答真实难题", audience: "上班族", platform: "douyin",
      category: "lifestyle", track: "after-work", pillars: ["问题", "复盘"], tone: "具体", visualStyle: "生活实拍",
      status: "active", nextEpisodeNumber: 1, createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T09:00:00.000Z",
    }]);
    vi.spyOn(studioApi, "candidateInbox").mockImplementation((query) => query?.origins?.includes("trend")
      ? new Promise(() => undefined)
      : Promise.resolve(inbox([seriesCandidate])));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("tab", { name: /系列选题/ }));

    expect(await screen.findByRole("button", { name: /查看候选提案 20/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "正在生成今日提案" })).not.toBeInTheDocument();
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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await screen.findByRole("heading", { name: "热点候选收件箱" });
    expect(screen.getAllByText("下班后的 AI 时间账本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex 选题总编").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "采用候选 下班后的 AI 时间账本" }));

    expect(adopt).toHaveBeenCalledWith("trend-1", {});
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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    expect(await screen.findByText("1 条证据 · 1 个独立源（需 1 个）")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: `采用候选 ${reviewCandidate.title}` }));
    expect(screen.getByRole("dialog", { name: "采用前核验证据" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /我已打开原始来源/ }));
    await user.click(screen.getByRole("button", { name: "确认核验并采用" }));
    expect(adopt).toHaveBeenCalledWith(reviewCandidate.id, { verificationConfirmed: true });

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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

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
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

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
        available: false,
        kind: "external",
        status: "needs_config",
        billing: "metered",
        description: "按预算生成少量关键镜头。",
        modes: ["文生视频", "9:16"],
        requirement: "需要 ARK_API_KEY",
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
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "生成与素材模型" })).toBeInTheDocument());
    expect(screen.getByText("Seedance 关键镜头")).toBeInTheDocument();
    expect(screen.getByText("Kling 可灵")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "热点接入" })).toBeInTheDocument();
    expect(screen.getByText("抖音官方热点")).toBeInTheDocument();
    expect(screen.getAllByText("按量计费").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需要配置").length).toBeGreaterThan(0);
    expect(screen.getByText("需要 ARK_API_KEY")).toBeInTheDocument();
  });

  it("persists voice and visual choices as production defaults", async () => {
    const user = userEvent.setup();
    const readyProviders = [
      ...providers,
      { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" as const, status: "ready" as const, billing: "free" as const },
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external" as const, status: "ready" as const, billing: "free" as const },
    ];
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
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

    const pexelsRow = screen.getByText("Pexels 视频").closest("article");
    expect(pexelsRow).not.toBeNull();
    await user.click(within(pexelsRow!).getByRole("button", { name: "设为默认" }));
    expect(update).toHaveBeenLastCalledWith({ defaultAssetProviderId: "pexels-stock-v1" });
    const routerRow = screen.getByText("AI 逐镜路由").closest("article");
    expect(routerRow).not.toBeNull();
    expect(within(routerRow!).queryByRole("button", { name: "设为默认" })).not.toBeInTheDocument();
    expect(within(routerRow!).getByText("系统路由")).toBeInTheDocument();

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
