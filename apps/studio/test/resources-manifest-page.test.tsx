import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioResourceManifest } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";

describe("ResourcesPage source and rights section", () => {
  afterEach(() => vi.restoreAllMocks());

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
      needsReviewCount: 2,
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
    await user.click(screen.getAllByRole("button", { name: "确认可用" })[0]!);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ itemId: "confirm", expectedRevision: 3, action: "confirmed" }));

    await user.click(screen.getByRole("button", { name: "驳回" }));
    await user.type(screen.getByRole("textbox", { name: "驳回原因" }), "缺少商用授权");
    await user.click(screen.getByRole("button", { name: "确认驳回" }));
    expect(await screen.findByRole("link", { name: "打开原制作，点击“基于这版重新制作”" })).toHaveAttribute("href", "/projects/run-1");
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
