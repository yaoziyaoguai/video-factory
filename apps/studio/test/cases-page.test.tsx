import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { CasesPage } from "../src/client/pages/CasesPage.js";
import type { StudioCaseCatalog, StudioCaseDetail, StudioCreatorSettings } from "../src/shared/api.js";

const settings: StudioCreatorSettings = {
  productionDefaults: { platform: "douyin", durationSeconds: 24 },
} as StudioCreatorSettings;

const transcriptItem = {
  id: "ted:one",
  sourceId: "ted" as const,
  sourceLabel: "TED",
  title: "一条有逐字稿的谈论",
  originalUrl: "https://www.ted.com/talks/one",
  author: "某位讲者",
  language: "en",
  topics: ["science"],
  contentState: "transcript" as const,
  contentTypeLabel: "原站逐字稿",
  metrics: [{ label: "播放量", value: 46677589 }],
  metricsFetchedAt: "2026-09-16T00:00:00.000Z",
  usageNote: "来源标注 CC BY-NC-ND 4.0：署名并链接原站，不商用、不改编。",
};

const videoItem = {
  id: "bilibili:BV1",
  sourceId: "bilibili" as const,
  sourceLabel: "哔哩哔哩",
  title: "一条只有视频信息的案例",
  originalUrl: "https://www.bilibili.com/video/BV1",
  author: "某位 UP 主",
  topics: ["科技"],
  contentState: "video_only" as const,
  contentTypeLabel: "仅视频信息",
  metrics: [],
  metricsFetchedAt: "2026-09-16T00:00:00.000Z",
  usageNote: "只保存公开信息并链接原站。",
};

const catalog: StudioCaseCatalog = {
  items: [transcriptItem, videoItem],
  facets: {
    sources: { TED: 1, 哔哩哔哩: 1 },
    topics: { science: 1, 科技: 1 },
    languages: { en: 1 },
    contentStates: { transcript: 1, video_only: 1 },
  },
  sources: [
    { sourceId: "ted", label: "TED", state: "ready", itemCount: 1, detail: "已取得 1 条真实内容。", fetchedAt: "2026-09-16T00:00:00.000Z" },
    { sourceId: "bilibili", label: "哔哩哔哩", state: "failed", itemCount: 1, detail: "哔哩哔哩排行榜暂时不可用：接口返回 code=-352（-352）；下面显示的仍是上次取得的 1 条，本轮没有更新。", fetchedAt: "2026-09-16T00:00:00.000Z" },
  ],
  generatedAt: "2026-09-16T00:00:00.000Z",
  loading: false,
};

const detail: StudioCaseDetail = {
  item: transcriptItem,
  transcript: {
    state: "read",
    language: "en",
    fetchedAt: "2026-09-16T00:00:00.000Z",
    paragraphs: [{ id: "p1", text: "原站逐字稿的第一段正文。" }, { id: "p2", text: "原站逐字稿的第二段正文。" }],
    truncated: false,
    usageNote: transcriptItem.usageNote,
  },
};

// 只公开视频信息的那条：来源方就是没有正文可读，不能靠详情接口"变"出正文来。
const videoDetail: StudioCaseDetail = {
  item: videoItem,
  transcript: {
    state: "unavailable",
    paragraphs: [],
    truncated: false,
    reason: "该平台只公开视频信息，没有可自动取得的正文。",
    usageNote: videoItem.usageNote,
  },
};

function mockApi(overrides: Partial<Record<keyof typeof studioApi, unknown>> = {}) {
  vi.spyOn(studioApi, "cases").mockResolvedValue(catalog);
  vi.spyOn(studioApi, "caseDetail").mockImplementation(async (caseId: string) => {
    const found = caseId === videoItem.id ? videoDetail : detail;
    return found;
  });
  vi.spyOn(studioApi, "caseSelection").mockResolvedValue(undefined);
  vi.spyOn(studioApi, "selectCase").mockImplementation(async (input: { caseId: string; intent: string; borrowIntent: string[] }) => ({
    caseId: input.caseId,
    sourceId: "ted",
    sourceLabel: "TED",
    title: transcriptItem.title,
    originalUrl: transcriptItem.originalUrl,
    contentState: "transcript",
    contentTypeLabel: "原站逐字稿",
    borrowIntent: input.borrowIntent,
    intent: input.intent,
    selectedAt: "2026-09-16T00:00:00.000Z",
  }));
  vi.spyOn(studioApi, "clearCaseSelection").mockResolvedValue(undefined);
  vi.spyOn(studioApi, "providers").mockResolvedValue([]);
  vi.spyOn(studioApi, "settings").mockResolvedValue(settings);
  // studioApi 的方法签名各不相同，按名字索引会把它们的联合类型撑爆，这里只看"有个异步方法"这一层。
  const target = studioApi as unknown as Record<string, () => Promise<unknown>>;
  for (const [name, value] of Object.entries(overrides)) {
    vi.spyOn(target, name).mockImplementation(async () => value);
  }
}

function renderPage() {
  return render(<MemoryRouter><CasesPage /></MemoryRouter>);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CasesPage", () => {
  it("keeps existing cases usable and shows elapsed waiting without sending another refresh", async () => {
    mockApi();
    renderPage();
    await screen.findByText(transcriptItem.title);
    let complete!: (value: StudioCaseCatalog) => void;
    vi.mocked(studioApi.cases).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(screen.getByText(/已等待 45 秒/)).toBeInTheDocument();
    expect(screen.getByText(/已加载的列表和当前参考仍可使用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(transcriptItem.title) })).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(studioApi.cases).toHaveBeenCalledTimes(2);
    await act(async () => { complete(catalog); });
    expect(screen.queryByText(/已等待/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
  });
  it("shows the fetched items with their real content type, and says a failed source is failed", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText("一条有逐字稿的谈论")).toBeInTheDocument();
    expect(screen.getByText("一条只有视频信息的案例")).toBeInTheDocument();
    expect(screen.getByText("原站逐字稿")).toBeInTheDocument();
    expect(screen.getByText("仅视频信息")).toBeInTheDocument();
    // 来源级失败要如实说出来，而不是把列表悄悄变短。
    expect(screen.getByText(/code=-352/)).toBeInTheDocument();
    // 没有可读指标时不能显示 0。
    expect(screen.getByText("来源未公开可读指标")).toBeInTheDocument();
    expect(screen.queryByText(/^播放量 0$/)).toBeNull();
  });

  it("never labels a video-only item as an obtained script", async () => {
    mockApi();
    renderPage();
    await screen.findByText("一条只有视频信息的案例");
    fireEvent.click(screen.getByText("一条只有视频信息的案例"));
    // 详情要如实说明这条没有正文，而不是显示一个空的正文区。
    await waitFor(() => expect(screen.getByText(/没有可自动取得的正文/)).toBeInTheDocument());
    expect(screen.getByText("只保存公开信息并链接原站。")).toBeInTheDocument();
    expect(screen.queryByText(/逐字稿的第一段正文/)).toBeNull();
    expect(screen.queryByText(/正在读取来源方正文/)).toBeNull();
  });

  it("filters by keyword and separates the two content views", async () => {
    mockApi();
    renderPage();
    await screen.findByText("一条有逐字稿的谈论");
    fireEvent.change(screen.getByPlaceholderText("搜索标题、作者或话题"), { target: { value: "逐字稿" } });
    expect(screen.getByText("一条有逐字稿的谈论")).toBeInTheDocument();
    expect(screen.queryByText("一条只有视频信息的案例")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("搜索标题、作者或话题"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "视频案例" }));
    expect(screen.queryByText("一条有逐字稿的谈论")).toBeNull();
    expect(screen.getByText("一条只有视频信息的案例")).toBeInTheDocument();
  });

  it("reads the real body text on demand and keeps the source's own usage limits", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByText("一条有逐字稿的谈论"));
    expect(await screen.findByText("原站逐字稿的第一段正文。")).toBeInTheDocument();
    expect(screen.getByText("原站逐字稿的第二段正文。")).toBeInTheDocument();
    expect(studioApi.caseDetail).toHaveBeenCalledWith("ted:one", false);
    expect(screen.getByText(/CC BY-NC-ND 4.0/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看原站页面/ })).toHaveAttribute("href", transcriptItem.originalUrl);
  });

  it("asks only for what this creation is about before handing off", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByText("一条有逐字稿的谈论"));
    await screen.findByText("原站逐字稿的第一段正文。");
    const start = screen.getByRole("button", { name: /用它开始创作/ });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/用自己的话写这次的选题与角度/), { target: { value: "讲清楚这件事为什么重要" } });
    fireEvent.click(screen.getByRole("button", { name: "开场方式" }));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(studioApi.selectCase).toHaveBeenCalledWith({
      caseId: "ted:one",
      intent: "讲清楚这件事为什么重要",
      borrowIntent: ["开场方式"],
    }));
  });

  it("stays on the item the creator opened last even if an earlier read comes back later", async () => {
    mockApi();
    let releaseSlow: (value: StudioCaseDetail) => void = () => undefined;
    vi.spyOn(studioApi, "caseDetail").mockImplementation((caseId: string) => {
      if (caseId === transcriptItem.id) return new Promise<StudioCaseDetail>((resolve) => { releaseSlow = resolve; });
      return Promise.resolve(videoDetail);
    });
    renderPage();
    fireEvent.click(await screen.findByText("一条有逐字稿的谈论"));
    fireEvent.click(screen.getByText("一条只有视频信息的案例"));
    await waitFor(() => expect(screen.getByRole("heading", { name: videoItem.title })).toBeInTheDocument());
    // 慢的那条现在才回来：详情不能倒回上一条，否则"用它开始创作"会存下用户已经离开的那条参考。
    releaseSlow(detail);
    await waitFor(() => expect(screen.getByRole("heading", { name: videoItem.title })).toBeInTheDocument());
    expect(screen.queryByText("原站逐字稿的第一段正文。")).toBeNull();
  });

  it("keeps showing what is there and reports an empty result honestly", async () => {
    mockApi({ cases: { ...catalog, items: [], sources: [], facets: { sources: {}, topics: {}, languages: {}, contentStates: {} } } });
    renderPage();
    expect(await screen.findByText("暂时没有取到内容，请查看上方来源状态。")).toBeInTheDocument();
    // 首次进入不该要求用户先去外面找资料再粘贴回来。
    expect(screen.queryByText(/导入|粘贴/)).toBeNull();
  });

  it("surfaces a catalog failure instead of an empty list", async () => {
    mockApi();
    vi.spyOn(studioApi, "cases").mockRejectedValue(new Error("没有连接到案例来源。"));
    renderPage();
    expect(await screen.findByText("没有连接到案例来源。")).toBeInTheDocument();
  });

  it("blocks the handoff when the creator settings could not be read", async () => {
    mockApi();
    vi.spyOn(studioApi, "settings").mockRejectedValue(new Error("设置服务不可用"));
    renderPage();
    expect(await screen.findByText(/未能读取你的创作设置/)).toBeInTheDocument();
    fireEvent.click(await screen.findByText("一条有逐字稿的谈论"));
    await screen.findByText("原站逐字稿的第一段正文。");
    fireEvent.change(screen.getByPlaceholderText(/用自己的话写这次的选题与角度/), { target: { value: "有效意图" } });
    expect(screen.getByRole("button", { name: /用它开始创作/ })).toBeDisabled();
  });
});

// DG-UX-03（新前端 Dogfood 修复执行包 R4）：搜索框要有稳定可访问名称。
// 键盘/读屏/自动化都按用途识别；仅 placeholder 不算名称。

describe("case search accessible name (DG-UX-03)", () => {
  it("keeps the searchbox named 搜索案例 across empty, filled and cleared states", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText(transcriptItem.title)).toBeInTheDocument());

    const search = screen.getByRole("searchbox", { name: "搜索案例" });
    expect(search).toHaveAttribute("placeholder", "搜索标题、作者或话题");
    fireEvent.change(search, { target: { value: "逐字稿" } });
    expect(screen.getByRole("searchbox", { name: "搜索案例" })).toBe(search);
    expect(screen.getByRole("button", { name: "清空搜索" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("searchbox", { name: "搜索案例" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();
    // 键盘直达：聚焦后输入仍驱动同一筛选。
    search.focus();
    fireEvent.change(search, { target: { value: "不存在的关键词" } });
    await waitFor(() => expect(screen.getByText("没有符合条件的参考内容，换一个关键词或筛选项试试。")).toBeInTheDocument());
  });
});
