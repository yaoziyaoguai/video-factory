import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioModelProfile, StudioProvider, StudioResourceManifest } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";

describe("ResourcesPage source and rights section", () => {
  it("retains Coverr official credit and Commons reuse terms in the saved materials ledger", async () => {
    stubResourcePage({ ...emptyResourceManifest(), totalItems: 2, categories: { visual: 2, voice: 0, font: 0, document: 0, other: 0 },
      items: [
        { id: "coverr", runId: "run-stock", runTitle: "库存验证", category: "visual", kind: "media_asset", providerId: "coverr-stock-v1", creator: "Coverr creator", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
        { id: "commons", runId: "run-stock", runTitle: "库存验证", category: "visual", kind: "media_asset", providerId: "wikimedia-stock-v1", creator: "Commons creator", licenseNote: "CC BY-SA 4.0：改编须按相同许可分享", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
      ],
    });
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    const runs = await screen.findByLabelText("按视频整理的素材记录");
    fireEvent.click(within(runs).getByText("库存验证", { selector: "summary strong" }));
    expect(within(runs).getByRole("link", { name: "Coverr" })).toHaveAttribute("href", "https://coverr.co");
    expect(within(runs).getByRole("link", { name: "Wikimedia Commons" })).toBeInTheDocument();
    expect(within(runs).getByText(/改编须按相同许可分享/)).toBeInTheDocument();
  });
  beforeEach(() => { vi.spyOn(studioApi, "models").mockResolvedValue({ models: [] }); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps production documents out of the material review queue", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-04T00:00:00.000Z",
      totalItems: 3,
      needsReviewCount: 1,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 1, voice: 1, font: 0, document: 1, other: 0 },
      items: [
        { id: "image", runId: "run-1", runTitle: "示例视频", category: "visual", kind: "media_asset", providerId: "seedream-image-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
        { id: "voice", runId: "run-1", runTitle: "示例视频", category: "voice", kind: "voiceover", providerId: "minimax-tts-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded" },
        { id: "audit", runId: "run-1", runTitle: "示例视频", category: "document", kind: "agent_loop_trace", providerId: "openai", commercialUse: "review_required", attributionRequirement: "unknown", reviewStatus: "needs_review" },
      ],
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const heading = await screen.findByRole("heading", { name: "素材来源与授权" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    expect(within(section!).getByText("2 项素材 · 1 项待确认")).toBeInTheDocument();
    const materialRuns = within(section!).getByLabelText("按视频整理的素材记录");
    const materialRun = within(materialRuns).getByText("示例视频", { selector: "summary strong" }).closest("details");
    expect(materialRun).not.toHaveAttribute("open");
    await user.click(within(materialRuns).getByText("示例视频", { selector: "summary strong" }));
    expect(materialRun).toHaveAttribute("open");
    expect(within(materialRun!).getByLabelText("素材来源与授权明细")).toHaveTextContent("Seedream 图片生成");
    const records = within(section!).getByText("制作过程记录", { selector: "summary strong" }).closest("details");
    expect(records).not.toHaveAttribute("open");

    await user.click(within(section!).getByText("制作过程记录", { selector: "summary strong" }));
    expect(records).toHaveAttribute("open");
    expect(within(section!).getByLabelText("按视频整理的制作记录")).toHaveTextContent("制作文档");
    expect(within(section!).getByLabelText("制作记录明细")).toHaveTextContent("制作记录");
  });

  it("separates text-model selection from paid visual approval", async () => {
    stubResourcePage(emptyResourceManifest());

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const rolesLink = await screen.findByRole("link", { name: "制作分工" });
    fireEvent.click(rolesLink);
    expect(screen.getByText("文本模型在新建或返工时选择；只有付费图片、视频会在执行前逐镜报价并确认")).toBeInTheDocument();
  });

  it("groups model defaults by capability and saves one change without dropping the other defaults", async () => {
    const providers: StudioProvider[] = [
      modelProvider("writer-v1", "编剧模型", "script.draft", ["text"], ["writer-a", "writer-b"]),
      modelProvider("reviewer-v1", "多模态审片", "quality.review.visual", ["visual-review"], ["reviewer-a"]),
      modelProvider("image-v1", "图片生成", "asset.prepare", ["text-to-image"], ["image-a"]),
      modelProvider("video-v1", "视频生成", "asset.prepare", ["text-to-video"], ["video-a"]),
      modelProvider("voice-v1", "声音生成", "voice.synthesize", ["text"], ["voice-a"]),
    ];
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: { "video-v1": "video-a" },
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(emptyResourceManifest());
    const update = vi.spyOn(studioApi, "updateSettings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: { "writer-v1": "writer-b", "video-v1": "video-a" },
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await screen.findByRole("heading", { name: "模型设置" });
    for (const category of ["文本生成", "内容生成", "内容理解"]) {
      expect(screen.getByRole("button", { name: category })).toBeInTheDocument();
    }
    expect(within(screen.getByLabelText("全局模型目录")).queryByRole("combobox")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "编剧默认模型" }), { target: { value: "writer-b" } });
    fireEvent.click(screen.getByRole("button", { name: "保存角色配置" }));
    expect(update).toHaveBeenCalledWith({ modelDefaults: { "writer-v1": "writer-b", "video-v1": "video-a" } });
  });

  it("groups materials by video and reveals additional video records in batches", async () => {
    const user = userEvent.setup();
    const items: StudioResourceManifest["items"] = Array.from({ length: 9 }, (_, index) => ({
      id: `image-${index + 1}`,
      runId: `run-${index + 1}`,
      runTitle: `视频 ${index + 1}`,
      category: "visual" as const,
      kind: "media_asset",
      providerId: "seedream-image-v1",
      commercialUse: "provider_terms" as const,
      attributionRequirement: "provider_terms" as const,
      reviewStatus: "needs_review" as const,
    }));
    stubResourcePage({
      generatedAt: "2026-09-04T00:00:00.000Z",
      totalItems: items.length,
      needsReviewCount: items.length,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: items.length, voice: 0, font: 0, document: 0, other: 0 },
      items,
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const runs = await screen.findByLabelText("按视频整理的素材记录");
    expect(within(runs).getAllByRole("group")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "显示更多素材视频（还剩 1 条）" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示更多素材视频（还剩 1 条）" }));
    expect(within(runs).getAllByRole("group")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /显示更多素材视频/ })).not.toBeInTheDocument();
  });

  it("pages production records independently from material videos", async () => {
    const user = userEvent.setup();
    const materialItems: StudioResourceManifest["items"] = Array.from({ length: 9 }, (_, index) => ({
      id: `image-${index + 1}`,
      runId: `material-run-${index + 1}`,
      runTitle: `素材视频 ${index + 1}`,
      category: "visual" as const,
      kind: "media_asset",
      providerId: "seedream-image-v1",
      commercialUse: "provider_terms" as const,
      attributionRequirement: "provider_terms" as const,
      reviewStatus: "needs_review" as const,
    }));
    const recordItems: StudioResourceManifest["items"] = Array.from({ length: 9 }, (_, index) => ({
      id: `document-${index + 1}`,
      runId: `record-run-${index + 1}`,
      runTitle: `制作记录 ${index + 1}`,
      category: "document" as const,
      kind: "production_document",
      providerId: "openai",
      commercialUse: "review_required" as const,
      attributionRequirement: "unknown" as const,
      reviewStatus: "recorded" as const,
    }));
    const items = [...materialItems, ...recordItems];
    stubResourcePage({
      generatedAt: "2026-09-04T00:00:00.000Z",
      totalItems: items.length,
      needsReviewCount: materialItems.length,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: materialItems.length, voice: 0, font: 0, document: recordItems.length, other: 0 },
      items,
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const materialRuns = await screen.findByLabelText("按视频整理的素材记录");
    expect(within(materialRuns).getAllByRole("group")).toHaveLength(8);
    await user.click(screen.getByText("制作过程记录", { selector: "summary strong" }));
    const recordRuns = screen.getByLabelText("按视频整理的制作记录");
    expect(within(recordRuns).getAllByRole("group")).toHaveLength(8);

    await user.click(screen.getByRole("button", { name: "显示更多制作记录（还剩 1 条）" }));
    expect(within(recordRuns).getAllByRole("group")).toHaveLength(9);
    expect(within(materialRuns).getAllByRole("group")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "显示更多素材视频（还剩 1 条）" })).toBeInTheDocument();
  });

  it("dismisses a successful settings notice after a delay and when changing sections", async () => {
    stubResourcePage(emptyResourceManifest());
    vi.spyOn(studioApi, "updateSettings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "bilibili", durationSeconds: 24 },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    fireEvent.change(await screen.findByRole("combobox", { name: "默认目标平台" }), { target: { value: "bilibili" } });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存创作默认" }));
      await Promise.resolve();
    });
    expect(screen.getByText(/创作默认值已保存/)).toBeInTheDocument();

    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByText(/创作默认值已保存/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "默认目标平台" }), { target: { value: "douyin" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存创作默认" }));
      await Promise.resolve();
    });
    expect(screen.getByText(/创作默认值已保存/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "热点信号" }));
    expect(screen.queryByText(/创作默认值已保存/)).not.toBeInTheDocument();
  });

  it("keeps a failed settings notice visible instead of timing it out", async () => {
    stubResourcePage(emptyResourceManifest());
    vi.spyOn(studioApi, "updateSettings").mockRejectedValue(new Error("网络暂不可用"));

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    fireEvent.change(await screen.findByRole("combobox", { name: "默认目标平台" }), { target: { value: "bilibili" } });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存创作默认" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败：网络暂不可用");

    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败：网络暂不可用");
  });

  it("numbers collected signals by page order while preserving their source rank", async () => {
    stubResourcePage(emptyResourceManifest());
    vi.mocked(studioApi.trendSignals).mockResolvedValue([
      { id: "douyin-1", sourceId: "newsnow", platform: "douyin", title: "热点一", rank: 1, collectedAt: "2026-09-07T00:00:00.000Z" },
      { id: "weibo-1", sourceId: "dailyhot", platform: "weibo", title: "热点二", rank: 1, collectedAt: "2026-09-07T00:00:00.000Z" },
      { id: "bilibili-7", sourceId: "rsshub", platform: "bilibili", title: "热点三", rank: 7, collectedAt: "2026-09-07T00:00:00.000Z" },
    ]);

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await screen.findByText("热点一");
    const signalList = screen.getByLabelText("已采集热点信号");
    const rows = within(signalList).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(":scope > span")?.textContent)).toEqual(["01", "02", "03"]);
    expect(rows[0]).toHaveTextContent("原榜第 1");
    expect(rows[1]).toHaveTextContent("原榜第 1");
    expect(rows[2]).toHaveTextContent("原榜第 7");
  });

  it("distinguishes same-title productions and labels each material with its scene", async () => {
    stubResourcePage({
      ...emptyResourceManifest(),
      totalItems: 2,
      needsReviewCount: 2,
      categories: { visual: 2, voice: 0, font: 0, document: 0, other: 0 },
      items: [
        { id: "image-1", runId: "vf-production-alpha1234", runTitle: "同名视频", category: "visual", kind: "media_asset", providerId: "seedream-image-v1", contentUrl: "/api/runs/alpha/artifacts/image-1/content", contentType: "image/png", scenePosition: 1, commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
        { id: "video-2", runId: "vf-production-beta5678", runTitle: "同名视频", category: "visual", kind: "media_asset", providerId: "pexels-stock-v1", contentUrl: "/api/runs/beta/artifacts/video-2/content", contentType: "video/mp4", scenePosition: 2, commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
      ],
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const runs = await screen.findByLabelText("按视频整理的素材记录");
    const summaries = within(runs).getAllByText("同名视频", { selector: "summary strong" });
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.closest("summary")).toHaveTextContent("制作编号 alpha1234");
    expect(summaries[1]?.closest("summary")).toHaveTextContent("制作编号 beta5678");
    expect(summaries[0]?.closest("summary")).toHaveAccessibleName("查看“同名视频”（制作编号 alpha1234）的素材明细");
    expect(summaries[1]?.closest("summary")).toHaveAccessibleName("查看“同名视频”（制作编号 beta5678）的素材明细");

    fireEvent.click(summaries[0]!);
    fireEvent.click(summaries[1]!);
    expect(within(runs).getByText("第 1 镜 · 图片画面")).toBeInTheDocument();
    expect(within(runs).getByText("第 2 镜 · 视频画面")).toBeInTheDocument();
    expect(within(runs).getByRole("img", { name: "第 1 镜素材缩略图" })).toHaveAttribute("src", "/api/runs/alpha/artifacts/image-1/content");
    expect(within(runs).getByLabelText("第 2 镜素材缩略图")).toHaveAttribute("src", "/api/runs/beta/artifacts/video-2/content#t=0.1");
  });

  it("marks the voice direction as creator-customized when saving it from settings", async () => {
    const user = userEvent.setup();
    const manifest: StudioResourceManifest = {
      generatedAt: "2026-09-04T00:00:00.000Z",
      totalItems: 0,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
      items: [],
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
    };
    stubResourcePage(manifest);
    vi.mocked(studioApi.voices).mockResolvedValue([{
      id: "macos:Tingting",
      providerId: "macos-say-v1",
      label: "Tingting",
      locale: "zh-CN",
      engine: "macos",
      curated: true,
    }]);
    const update = vi.spyOn(studioApi, "updateSettings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 190, pauseScale: 1, masteringPreset: "natural" },
      voiceDirectionCustomized: true,
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: /高级微调/ }));
    fireEvent.change(screen.getByRole("slider", { name: "语速" }), { target: { value: "190" } });
    await user.click(screen.getByRole("button", { name: "设为制作默认" }));

    expect(update).toHaveBeenCalledWith({
      voiceDirection: { profileId: "macos:Tingting", rate: 190, pauseScale: 1, masteringPreset: "natural" },
    });
  });

  it("confirms or rejects pending rights and links rejected items back to production", async () => {
    const user = userEvent.setup();
    const base: StudioResourceManifest = {
      reviewRevision: 3,
      generatedAt: "2026-09-04T00:00:00.000Z", totalItems: 2, needsReviewCount: 2,
      legacyRunsWithoutManifest: 0, reconstructedRunCount: 0, unreadableManifestCount: 0, truncatedRunCount: 0, truncatedItemCount: 0,
      categories: { visual: 2, voice: 0, font: 0, document: 0, other: 0 },
      items: ["confirm", "reject"].map((id) => ({ id, runId: "run-1", runTitle: "示例视频", category: "visual" as const, kind: "media_asset", providerId: "seedream-image-v1", commercialUse: "provider_terms" as const, attributionRequirement: "provider_terms" as const, reviewStatus: "needs_review" as const })),
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
    };
    stubResourcePage(base);
    const review = vi.spyOn(studioApi, "reviewResource").mockImplementation(async (input) => ({
      ...base,
      reviewRevision: input.expectedRevision + 1,
      needsReviewCount: 1,
      items: base.items.map((item) => item.id === input.itemId ? { ...item, reviewStatus: input.action === "confirmed" ? "recorded" as const : "needs_review" as const, reviewDecision: { action: input.action, reviewedAt: "2026-09-04T01:00:00.000Z", reviewedBy: "owner", ...(input.note ? { note: input.note } : {}) } } : item),
    }));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);
    await user.click(await screen.findByText("示例视频", { selector: "summary strong" }));
    const ledger = screen.getByLabelText("素材来源与授权明细");
    expect(within(ledger).getByText("未定位镜头 · 素材标识 CONFIRM")).toBeInTheDocument();
    expect(within(ledger).getByText("未定位镜头 · 素材标识 REJECT")).toBeInTheDocument();
    const confirmButton = screen.getAllByRole("button", { name: "确认已核对授权信息" })[0]!;
    const rejectButton = screen.getAllByRole("button", { name: "驳回" })[0]!;
    expect(confirmButton).toHaveClass("button", "button-secondary");
    expect(rejectButton).toHaveClass("button", "button-danger-ghost");
    await user.click(confirmButton);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ itemId: "confirm", expectedRevision: 3, action: "confirmed" }));

    await user.click(screen.getByRole("button", { name: "驳回" }));
    await user.type(screen.getByRole("textbox", { name: "驳回原因" }), "缺少商用授权");
    await user.click(screen.getByRole("button", { name: "确认驳回" }));
    expect(await screen.findByRole("link", { name: "打开原制作，点击“基于这版重新制作”" })).toHaveAttribute("href", "/projects/run-1");
  });

  it("keeps administrator-only trend setup instructions off the creator settings page", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([
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
        description: "官方热点权限可作为后续数据源；当前版本尚未实现自动采集适配器。",
        cadence: "约 2 小时",
        requirement: "需要获批 hotsearch scope、配置授权，并实现官方热点采集适配器",
      },
      {
        id: "dailyhot-import",
        label: "DailyHotApi",
        kind: "import",
        status: "needs_config",
        description: "本地统一 JSON / RSS 热榜接口，补充抖音、微博、快手、百度和垂类榜单。",
        cadence: "建议 30-60 分钟",
        requirement: "运行 make setup-local-trends",
      },
      {
        id: "newrank-import",
        label: "新榜数据",
        kind: "commercial",
        status: "manual_only",
        description: "在商业数据合同确定前，以 CSV/JSON 导入保存来源边界。",
        cadence: "按购买方案",
        requirement: "需要商业数据授权",
      },
    ]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([
      { id: "ffmpeg", label: "FFmpeg 音视频引擎", category: "runtime", state: "missing", evidence: "需要 ffmpeg 与 ffprobe" },
      { id: "minimax-tts", label: "MiniMax 云端声音演员", category: "voice", state: "missing", evidence: "需要 MINIMAX_API_KEY" },
    ]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await screen.findByText("抖音官方热点");
    expect(screen.getAllByText("该热点源尚未由管理员接入，请联系管理员")).toHaveLength(2);
    expect(screen.getByText("需要商业数据授权")).toBeInTheDocument();
    expect(screen.getAllByText("尚未接入")).toHaveLength(2);
    const pageText = document.body.textContent ?? "";
    expect(pageText).not.toMatch(/\bmake\b/i);
    expect(pageText).not.toMatch(/\bscope\b/i);
    expect(pageText).not.toContain("适配器");
    expect(pageText).not.toContain("环境变量");
    expect(pageText).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9_]+)+\b/);
    const environmentSummary = screen.getByText(/制作环境有 2 处未就绪/);
    expect(environmentSummary).toHaveTextContent("成片合成、云端配音暂不可用或受限");
    expect(environmentSummary).toHaveTextContent("无法自行解决时请联系管理员");
    expect(screen.queryByText(/运行底座/)).not.toBeInTheDocument();
  });
});

function stubResourcePage(resourceManifest: StudioResourceManifest) {
  vi.spyOn(studioApi, "providers").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
  vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
  vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
  vi.spyOn(studioApi, "voices").mockResolvedValue([]);
  vi.spyOn(studioApi, "settings").mockResolvedValue({
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    defaultRecipeId: "economy-daily",
    roleProviderDefaults: {},
    modelDefaults: {},
    topicStrategy: { customInstruction: "" },
    productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
  });
  vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
  vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(resourceManifest);
}

function emptyResourceManifest(): StudioResourceManifest {
  return {
    generatedAt: "2026-09-07T00:00:00.000Z",
    totalItems: 0,
    needsReviewCount: 0,
    legacyRunsWithoutManifest: 0,
    reconstructedRunCount: 0,
    unreadableManifestCount: 0,
    truncatedRunCount: 0,
    truncatedItemCount: 0,
    categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
    items: [],
    assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 0, duplicateUses: 0, reusableCount: 0, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [] },
  };
}

function modelProvider(
  id: string,
  label: string,
  capability: string,
  taskTypes: StudioModelProfile["taskTypes"],
  modelIds: [string, ...string[]],
): StudioProvider {
  return {
    id,
    label,
    capability,
    available: true,
    kind: "external",
    billing: "free",
    defaultModelId: modelIds[0],
    modelProfiles: modelIds.map((modelId, index) => ({
      id: modelId,
      label: modelId,
      providerId: id,
      providerFamily: id,
      available: true,
      ...(index === 0 ? { recommended: true } : {}),
      description: "测试模型",
      taskTypes,
    })),
  };
}
