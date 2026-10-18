import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";
import { TodayPage } from "../src/client/pages/TodayPage.js";
import { TopicEntryWorkspace } from "../src/client/components/TopicEntryWorkspace.js";
import type { StudioCandidateInboxItem, StudioCreatorSettings, StudioIndexedAsset, StudioLocalCapability, StudioOpportunity, StudioResourceManifest, StudioSeries } from "../src/shared/api.js";

const settings: StudioCreatorSettings = {
  voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  defaultRecipeId: "free-stock", roleProviderDefaults: {}, modelDefaults: {},
  topicStrategy: { customInstruction: "" },
  productionDefaults: {  reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
};

function savedSettings(patch: Parameters<typeof studioApi.updateSettings>[0]): StudioCreatorSettings {
  return { ...settings, ...patch,
    productionDefaults: { ...settings.productionDefaults, ...patch.productionDefaults },
    topicStrategy: { ...settings.topicStrategy, ...patch.topicStrategy } };
}

function capability(id: string, state: StudioLocalCapability["state"]): StudioLocalCapability {
  return { id, label: id, category: "runtime", state, evidence: "受控状态" };
}

function mockSettings(capabilities: StudioLocalCapability[]) {
  vi.spyOn(studioApi, "settings").mockResolvedValue(settings);
  vi.spyOn(studioApi, "providers").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
  vi.spyOn(studioApi, "voices").mockResolvedValue([]);
  vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
  vi.spyOn(studioApi, "localCapabilities").mockResolvedValue(capabilities);
  vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(manifest([]));
}

function asset(index: number): StudioIndexedAsset {
  return {
    key: `asset-${index}`, mediaKind: "image", origin: index % 2 ? "ai_generated" : "stock", category: "visual",
    kind: "media_asset", providerId: index % 2 ? "ai-shot-router-v1" : "pexels-stock-v1", query: `素材 ${index}`,
    reuseStatus: index === 0 ? "review_required" : "ready", commercialUse: "provider_terms",
    attributionRequirement: "provider_terms", reviewStatus: "recorded", tags: [], useCount: 0, usages: [],
    contentUrl: `/media/local-image-${index}.png`,
  };
}

function manifest(assets: StudioIndexedAsset[]): StudioResourceManifest {
  return {
    generatedAt: "2026-10-11T00:00:00Z", totalItems: assets.length, needsReviewCount: assets.length ? 1 : 0,
    legacyRunsWithoutManifest: 0, reconstructedRunCount: 0, unreadableManifestCount: 0,
    truncatedRunCount: 0, truncatedItemCount: 0, categories: { visual: assets.length, voice: 0, font: 0, document: 0, other: 0 }, items: [],
    assetIndex: { version: "video-factory/asset-index-v1", totalAssets: assets.length, duplicateUses: 0,
      reusableCount: Math.max(0, assets.length - 1), needsReviewCount: assets.length ? 1 : 0,
      facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets },
  };
}

const saved: StudioOpportunity = {
  id: "saved-manual", origin: "manual", title: "雨天里的一杯咖啡", platform: "douyin", track: "ordinary-life",
  audience: "城市通勤者", concept: "雨天里的一杯咖啡。\n\n不总结，只拍回家路上几个安静的瞬间。", painPoint: "", hook: "", status: "draft", evidence: [],
  score: { audienceReach: 0, visualFeasibility: 0, productionCostEfficiency: 0, novelty: 0, monetization: 0, seriesPotential: 0, complianceRisk: 0, final: 0 },
  scoreProvenance: { source: "受控人工草稿", scoredAt: "2026-10-11T00:00:00Z" },
  createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("UI/UX page refinements", () => {
  it("collapses candidate filters without hiding source facts, applied conditions, or zero-result recovery", async () => {
    const user = userEvent.setup();
    const lifestyle: StudioCandidateInboxItem = {
      ...saved, id: "candidate-lifestyle", origin: "trend", category: "lifestyle", freshness: "today", risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: [] },
      editorialDecision: { verdict: "produce_video", score: 80, pendingEditorReview: true, reasons: ["规则保底，尚未审计"], guardrails: [] },
      providerId: "rules", generatedAt: saved.createdAt, rationale: "让生活观察先出现",
    };
    const technology: StudioCandidateInboxItem = { ...lifestyle, id: "candidate-technology", title: "修好一盏旧台灯", category: "technology" };
    const callbacks = {
      selectedSeriesId: undefined, series: [], historicalRuns: [], loading: {},
      trendMeta: { platformCount: 1, candidateCount: 2 },
      onRetry: vi.fn(), onRefreshTrends: vi.fn(), onAdopt: vi.fn(), onCreateSeries: vi.fn(), onSelectSeries: vi.fn(),
      onUpdateSeriesEpisode: vi.fn(), onLinkLegacyRun: vi.fn(), onRescanSeries: vi.fn(), onViewProductionRecords: vi.fn(), onManual: vi.fn(), onImport: vi.fn(),
    } satisfies ComponentProps<typeof TopicEntryWorkspace>;
    const workspace = (items: StudioCandidateInboxItem[]) => <MemoryRouter><TopicEntryWorkspace {...callbacks} inbox={{
      items, generatedAt: saved.createdAt, refreshing: false,
      facets: { total: items.length, origins: {}, categories: {}, platforms: {}, verdicts: {} },
    }} /></MemoryRouter>;
    const { rerender } = render(workspace([lifestyle, technology]));
    const toggle = screen.getByText("筛选候选");
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/本轮热点由本地规则保底生成/)).toBeVisible();
    expect(screen.getByText(/来源采集时间未记录/)).toBeVisible();
    expect(screen.getByRole("button", { name: `查看${lifestyle.title}` })).toBeVisible();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "生活 1" }));
    await user.click(toggle);
    expect(screen.getByLabelText("当前候选筛选")).toHaveTextContent("内容分类：生活");
    expect(screen.getByLabelText("当前候选筛选")).toBeVisible();
    expect(screen.getByRole("button", { name: "清除筛选" })).toBeVisible();
    rerender(workspace([technology]));
    expect(screen.getByLabelText("当前候选筛选")).toHaveTextContent("内容分类：生活");
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("当前筛选下没有候选。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.queryByLabelText("当前候选筛选")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `查看${technology.title}` })).toBeVisible();
    expect(callbacks.onAdopt).not.toHaveBeenCalled();
    expect(callbacks.onRefreshTrends).not.toHaveBeenCalled();
  });

  it("keeps all settings sections and unsaved values when opening the compact connection overview", async () => {
    mockSettings([capability("ffmpeg", "missing"), capability("minimax-tts", "ready")]);
    const update = vi.spyOn(studioApi, "updateSettings");
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const duration = await screen.findByRole("spinbutton", { name: "默认视频时长" });
    await user.clear(duration);
    await user.type(duration, "42");

    const overview = screen.getByText("查看服务连接概况");
    const defaultsSection = screen.getByRole("heading", { name: "新建制作默认值" }).closest("section");
    expect(defaultsSection).toContainElement(overview);
    expect(screen.getByRole("heading", { name: "创作设置" })).toBeVisible();
    await user.click(overview);
    expect(overview.closest("details")).toHaveAttribute("open");
    await user.click(overview);
    expect(overview.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("成片合成不可用").closest("details")).toBeNull();
    expect(screen.getByText(/保存默认值不是购买授权/).closest("label")).toContainElement(screen.getByRole("combobox", { name: "默认画面来源策略" }));

    const links = within(screen.getByRole("navigation", { name: "配置分区" })).getAllByRole("link");
    expect(links).toHaveLength(9);
    expect(within(links[0]!).getByLabelText("有未保存修改")).toBeInTheDocument();
    for (const link of links) {
      await user.click(link);
      expect(link).toHaveAttribute("aria-current", "page");
      expect(window.location.hash).toBe(link.getAttribute("href"));
    }
    await user.click(links[0]!);
    expect(screen.getByRole("spinbutton", { name: "默认视频时长" })).toBe(duration);
    expect(duration).toHaveValue(42);
    expect(screen.getByText("有未保存的创作默认值")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(studioApi.settings).toHaveBeenCalledOnce();
    window.history.replaceState(null, "", "/");
  });

  it("keeps edits made while creator defaults are saving, without claiming those edits were saved", async () => {
    mockSettings([]);
    let finish!: (value: StudioCreatorSettings) => void;
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const duration = await screen.findByRole("spinbutton", { name: "默认视频时长" });
    await user.clear(duration);
    await user.type(duration, "42");
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    await user.clear(duration);
    await user.type(duration, "60");
    await user.clear(screen.getByRole("textbox", { name: "账号内容定位" }));
    await user.type(screen.getByRole("textbox", { name: "账号内容定位" }), "等待期间的新定位");
    const submitted = update.mock.calls[0]![0];
    expect(submitted.productionDefaults?.durationSeconds).toBe(42);
    await act(async () => finish(savedSettings(submitted)));
    expect(duration).toHaveValue(60);
    expect(screen.getByRole("textbox", { name: "账号内容定位" })).toHaveValue("等待期间的新定位");
    expect(screen.getByText("有未保存的创作默认值")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存创作默认" })).toBeEnabled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("preserves the latest defaults after a delayed save failure and only saves again on user action", async () => {
    mockSettings([]);
    let fail!: (error: Error) => void;
    const update = vi.spyOn(studioApi, "updateSettings")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementation(async (patch) => savedSettings(patch));
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const duration = await screen.findByRole("spinbutton", { name: "默认视频时长" });
    await user.clear(duration);
    await user.type(duration, "42");
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    await user.clear(duration);
    await user.type(duration, "60");
    await act(async () => fail(new Error("受控保存失败")));
    expect(await screen.findByText("保存失败：受控保存失败")).toHaveAttribute("role", "alert");
    expect(duration).toHaveValue(60);
    expect(update).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    expect(update.mock.calls[1]![0].productionDefaults?.durationSeconds).toBe(60);
    expect(await screen.findByText("当前默认值已保存")).toBeInTheDocument();
    expect(duration).toHaveValue(60);
  });

  it("preserves later strategy text while accepting normalized values for an unchanged submitted group", async () => {
    mockSettings([]);
    let finish!: (value: StudioCreatorSettings) => void;
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    await screen.findByRole("spinbutton", { name: "默认视频时长" });
    for (const name of ["账号内容定位", "核心观众", "优先题材", "避开题材"]) {
      await user.clear(screen.getByRole("textbox", { name }));
      await user.type(screen.getByRole("textbox", { name }), "  原始内容  ");
    }
    await user.click(screen.getByRole("button", { name: "保存总编规则" }));
    const submitted = update.mock.calls[0]![0];
    const positioning = screen.getByRole("textbox", { name: "账号内容定位" });
    await user.clear(positioning);
    await user.type(positioning, "新的定位");
    await act(async () => finish(savedSettings(submitted)));
    expect(positioning).toHaveValue("新的定位");
    expect(screen.getByRole("button", { name: "保存总编规则" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保存总编规则" }));
    const latest = update.mock.calls[1]![0];
    await act(async () => finish(savedSettings(latest)));
    expect(positioning).toHaveValue("新的定位");
    expect(screen.getByRole("textbox", { name: "核心观众" })).toHaveValue("原始内容");
  });

  it("refreshes capabilities without replacing unsaved creator defaults", async () => {
    mockSettings([capability("ffmpeg", "ready")]);
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(async (patch) => savedSettings(patch));
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    await screen.findByRole("list", { name: "制作环境状态" });
    const duration = screen.getByRole("spinbutton", { name: "默认视频时长" });
    await user.clear(duration);
    await user.type(duration, "42");
    await user.selectOptions(screen.getByRole("combobox", { name: "默认画面来源策略" }), "keyshot-ai");
    await user.click(screen.getByRole("button", { name: "刷新能力状态" }));
    await waitFor(() => expect(studioApi.localCapabilities).toHaveBeenCalledTimes(2));
    expect(duration).toHaveValue(42);
    expect(screen.getByRole("combobox", { name: "默认画面来源策略" })).toHaveValue("keyshot-ai");
    expect(studioApi.settings).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    expect(update).toHaveBeenCalledWith({
      defaultRecipeId: "keyshot-ai", productionDefaults: { ...settings.productionDefaults, durationSeconds: 42 },
    });
  });

  it("allows a failed initial settings read to recover on capability refresh", async () => {
    mockSettings([]);
    vi.mocked(studioApi.settings).mockRejectedValueOnce(new Error("受控读取失败"));
    const user = userEvent.setup();
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    await screen.findByText("创作默认值读取失败");
    await user.click(screen.getByRole("button", { name: "刷新能力状态" }));
    expect(await screen.findByRole("spinbutton", { name: "默认视频时长" })).toHaveValue(24);
    expect(studioApi.settings).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("创作默认值读取失败")).not.toBeInTheDocument();
  });

  it("separates missing local voice from configured cloud voice and never implies a successful paid call", async () => {
    mockSettings([capability("python", "ready"), capability("ffmpeg", "ready"), capability("macos-voices", "missing"), capability("minimax-tts", "ready")]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const status = await screen.findByRole("list", { name: "制作环境状态" });
    expect(within(status).getByText("画面与字幕处理已就绪").closest("li")).toHaveAttribute("data-state", "ready");
    expect(within(status).getByText("成片合成已就绪")).toBeInTheDocument();
    expect(within(status).getByText("本机中文配音不可用").closest("li")).toHaveAttribute("data-state", "unavailable");
    expect(within(status).getByText("云端配音已配置").closest("li")).toHaveAttribute("data-state", "configured");
    expect(screen.getByText(/仅表示已配置；实际调用与账户额度尚未验证/)).toBeInTheDocument();
    expect(screen.getByText(/使用云端配音会按量计费，不会自动替换本机音色/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "默认画面来源策略" })).toHaveValue("free-stock");
    expect(document.body.textContent).not.toContain("制作环境已就绪：");
  });

  it("does not invent readiness when the capability report is empty", async () => {
    mockSettings([]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    expect(await screen.findByText(/制作环境状态未知/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "制作环境状态" })).not.toBeInTheDocument();
  });

  it("reports unavailable cloud voice without hiding a ready local voice or claiming unrelated capabilities", async () => {
    mockSettings([capability("macos-voices", "ready"), capability("minimax-tts", "missing")]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const status = await screen.findByRole("list", { name: "制作环境状态" });
    expect(within(status).getByText("本机中文配音已就绪")).toBeInTheDocument();
    expect(within(status).getByText("云端配音未配置或不可用")).toBeInTheDocument();
    expect(within(status).queryByText("成片合成已就绪")).not.toBeInTheDocument();
    expect(screen.getByText(/保存默认值不是购买授权/)).toBeInTheDocument();
  });

  it.each([1, 12, 40])("keeps search and license status visible for %i assets while low-frequency filters are collapsed", async (count) => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(manifest(Array.from({ length: count }, (_, index) => asset(index))));
    render(<MemoryRouter><AssetsPage /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: "去确认授权：授权待确认 1 项" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "搜索素材" })).toBeVisible();
    const details = screen.getByText("更多筛选").closest("details");
    expect(details).not.toHaveAttribute("open");
    await waitFor(() => expect(document.querySelectorAll(".asset-card")).toHaveLength(count));
  });

  it("keeps applied filters visible and removable outside the collapsed drawer", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(manifest(Array.from({ length: 12 }, (_, index) => asset(index))));
    render(<MemoryRouter><AssetsPage /></MemoryRouter>);
    await user.click(await screen.findByText("更多筛选"));
    await user.selectOptions(screen.getByRole("combobox", { name: "素材来源类型" }), "stock");
    await user.selectOptions(screen.getByRole("combobox", { name: "素材提供方" }), "pexels-stock-v1");
    await user.click(screen.getByText("更多筛选 · 2 项"));
    expect(screen.getByRole("button", { name: "移除来源筛选：授权素材" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^移除提供方筛选：Pexels/ })).toBeVisible();
    expect(document.querySelectorAll(".asset-card")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "移除来源筛选：授权素材" }));
    await user.click(screen.getByRole("button", { name: "清除全部筛选" }));
    expect(document.querySelectorAll(".asset-card")).toHaveLength(12);
  });

  it("lets the user open preparation for the just-saved draft without starting production or changing its source", async () => {
    const user = userEvent.setup();
    const other = { ...saved, id: "older-manual", title: "另一条已保存的想法" };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([other]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(settings);
    const create = vi.spyOn(studioApi, "createOpportunity").mockResolvedValue(saved);
    const start = vi.spyOn(studioApi, "start");
    render(<MemoryRouter initialEntries={["/topics?mode=custom"]}><TodayPage /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "写下新想法" }));
    await user.type(screen.getByLabelText("选题标题"), saved.title);
    await user.type(screen.getByLabelText("目标受众"), saved.audience);
    await user.type(screen.getByLabelText("创作想法"), saved.concept!);
    await user.click(screen.getByRole("button", { name: "保存创作草稿" }));
    const next = await screen.findByRole("button", { name: "继续制作准备" });
    expect(next.closest('[role="status"]')).toHaveTextContent(saved.title);
    expect(next.closest('[role="status"]')).toHaveTextContent("保存不会生成视频或授权付费");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ origin: "manual", title: saved.title, concept: saved.concept, evidence: [] });
    await user.click(screen.getByRole("button", { name: new RegExp(other.title) }));
    await user.click(next);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("视频标题")).toHaveValue(saved.title);
    expect(within(dialog).getByLabelText("内容角度")).toHaveValue(saved.concept);
    expect(start).not.toHaveBeenCalled();
    // 未配置能力的准备表单仍沿用原先的开工约束，快捷入口不能绕过。
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "开始前期构思" })).toBeDisabled());
  });

  it("links the adopted trend and its source to preparation without automatically creating a run", async () => {
    const user = userEvent.setup();
    const proposal: StudioCandidateInboxItem = {
      ...saved, id: "trend-candidate", origin: "trend", category: "society", freshness: "live", risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: [] },
      editorialDecision: { verdict: "produce_video", score: 80, reasons: [], guardrails: [] },
      providerId: "api-topic-editor-v1", generatedAt: "2026-10-11T00:00:00Z", rationale: "有实际来源的测试候选",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "雨天", strength: 80, evidenceUrl: "https://example.test/source" }],
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(settings);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue({
      items: [proposal], generatedAt: "2026-10-11T00:00:00Z", refreshing: false,
      facets: { total: 1, origins: { trend: 1 }, categories: { society: 1 }, platforms: { douyin: 1 }, verdicts: { produce_video: 1 } },
    });
    const adopted = { ...saved, id: proposal.id, origin: "trend" as const, evidence: proposal.evidence };
    vi.spyOn(studioApi, "adoptCandidate").mockResolvedValue(adopted);
    const start = vi.spyOn(studioApi, "start");
    render(<MemoryRouter initialEntries={["/topics?mode=trend"]}><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "热点候选收件箱" })).toBeInTheDocument();
    expect(screen.queryByText("实时信号")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: `采用候选 ${proposal.title}` }));
    const next = await screen.findByRole("button", { name: "继续制作准备" });
    expect(next.closest('[role="status"]')).toHaveTextContent("来自热点候选");
    expect(next.closest('[role="status"]')).toHaveTextContent(proposal.title);
    expect(studioApi.adoptCandidate).toHaveBeenCalledOnce();
    await user.click(next);
    expect(within(await screen.findByRole("dialog")).getByLabelText("视频标题")).toHaveValue(adopted.title);
    expect(start).not.toHaveBeenCalled();
  });

  it("continues an adopted series episode into preparation with its series context but zero production starts", async () => {
    const user = userEvent.setup();
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...matchMedia(query), matches: query === "(max-width: 700px)" }));
    const series: StudioSeries = {
      id: "series-coffee", name: "下班观察室", premise: "从下班路上观察城市生活", audience: saved.audience,
      platform: "douyin", category: "lifestyle", track: saved.track, pillars: ["生活观察"], tone: "自然", visualStyle: "生活实拍",
      status: "active", revision: 1, currentSeason: { number: 1, title: "第一季", arc: "普通人的下班路" },
      bible: { rules: ["保留普通生活的真实细节"], recurringElements: [], forbiddenChanges: [] }, canon: { revision: 0, facts: [] },
      episodes: [{
        id: "series-coffee-e1", seriesId: "series-coffee", episodeNumber: 1, seasonNumber: 1, arc: "普通人的下班路", pillar: "生活观察",
        title: saved.title, concept: "看见雨天温暖的一面",
        canonBaseRevision: 0, status: "planned", continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
        planning: { source: "rules", role: "系列总编", auditRole: "独立质量审计", auditStatus: "passed", auditIterations: 1, providerId: "rules", modelId: "deterministic", promptVersion: "test" },
        createdAt: saved.createdAt, updatedAt: saved.updatedAt,
      }], nextEpisodeNumber: 1, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
    };
    const proposal: StudioCandidateInboxItem = {
      ...saved, id: "series-coffee-e1", origin: "series", category: "lifestyle", freshness: "evergreen", risk: "low",
      seriesId: series.id, seriesName: series.name, episodeNumber: 1, seriesSequence: { status: "ready" },
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: [] },
      editorialDecision: { verdict: "produce_video", score: 80, reasons: [], guardrails: [] },
      providerId: "series-planner-v1", generatedAt: saved.createdAt, rationale: "第一集的受控采用验证",
    };
    const adopted: StudioOpportunity = { ...saved, id: proposal.id, origin: "series", seriesId: series.id, seriesName: series.name, episodeNumber: 1 };
    let adoptedOnServer = false;
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(settings);
    vi.spyOn(studioApi, "series").mockImplementation(async () => adoptedOnServer
      ? [{ ...series, episodes: [{ ...series.episodes[0]!, status: "selected", opportunityId: adopted.id }] }]
      : [series]);
    vi.spyOn(studioApi, "candidateInbox").mockImplementation(async () => ({
      items: adoptedOnServer ? [] : [proposal], generatedAt: saved.createdAt, refreshing: false,
      facets: { total: adoptedOnServer ? 0 : 1, origins: { series: adoptedOnServer ? 0 : 1 }, categories: {}, platforms: {}, verdicts: {} },
    }));
    const adopt = vi.spyOn(studioApi, "adoptCandidate").mockImplementation(async () => { adoptedOnServer = true; return adopted; });
    const start = vi.spyOn(studioApi, "start");
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /E01/ }));
    await waitFor(() => expect(screen.getByRole("article", { name: "单集详情" })).toHaveFocus());
    expect(start).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "采用本集并进入制作" }));
    const next = await screen.findByRole("button", { name: "继续制作准备" });
    expect(next.closest('[role="status"]')).toHaveTextContent(`来自系列《${series.name}》第 1 集`);
    expect(next.closest('[role="status"]')).toHaveTextContent("采用不会生成视频或授权付费");
    expect(adopt).toHaveBeenCalledExactlyOnceWith(proposal.id, { origin: "series" });
    expect(start).not.toHaveBeenCalled();
    await user.click(next);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("视频标题")).toHaveValue(adopted.title);
    expect(within(dialog).getByLabelText("目标受众")).toHaveValue(adopted.audience);
    expect(within(dialog).getByLabelText("内容角度")).toHaveValue(adopted.concept ?? [adopted.painPoint, adopted.hook].filter(Boolean).join("\n\n"));
    expect(start).not.toHaveBeenCalled();
  });
});
