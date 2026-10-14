import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";
import type { StudioIndexedAsset, StudioResourceManifest } from "../src/shared/api.js";

function asset(overrides: Partial<StudioIndexedAsset> = {}): StudioIndexedAsset {
  return {
    key: "city-scene",
    mediaKind: "video",
    origin: "stock",
    reuseStatus: "review_required",
    category: "visual",
    kind: "scene_video",
    providerId: "wikimedia-stock-v1",
    creator: "画面作者",
    licenseNote: "CC BY-SA 4.0：改编须按相同许可分享",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:City.webm",
    contentUrl: "/api/runs/one/artifacts/city/content",
    query: "城市清晨",
    width: 1080,
    height: 1920,
    tags: ["清晨"],
    commercialUse: "provider_terms",
    attributionRequirement: "provider_terms",
    reviewStatus: "needs_review",
    useCount: 1,
    usages: [{
      runId: "one", runTitle: "清晨的街道", itemId: "city", providerId: "wikimedia-stock-v1",
      commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review", scenePosition: 2,
    }],
    ...overrides,
  };
}

function manifest(assets: StudioIndexedAsset[]): StudioResourceManifest {
  return {
    generatedAt: "2026-10-14T00:00:00.000Z", totalItems: assets.length, needsReviewCount: 1,
    legacyRunsWithoutManifest: 0, reconstructedRunCount: 0, unreadableManifestCount: 0, truncatedRunCount: 0, truncatedItemCount: 0,
    categories: { visual: assets.length, voice: 0, font: 0, document: 0, other: 0 }, items: [],
    assetIndex: { version: "video-factory/asset-index-v1", totalAssets: assets.length, duplicateUses: 0, reusableCount: 0, needsReviewCount: 1,
      facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets },
  };
}

function renderAssets(assets: StudioIndexedAsset[]) {
  vi.spyOn(studioApi, "runs").mockResolvedValue([]);
  vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(manifest(assets));
  return render(<MemoryRouter><AssetsPage /></MemoryRouter>);
}

beforeEach(() => {
  // jsdom 不播放媒体；只替换浏览器媒体方法，Dialog 与焦点行为使用真实实现。
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("asset full viewer", () => {
  it("opens a read-only dialog without nesting card controls and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const item = asset();
    renderAssets([item]);
    const trigger = await screen.findByRole("button", { name: "完整查看：城市清晨" });
    const inlineVideo = screen.getByLabelText("城市清晨 预览") as HTMLVideoElement;
    expect(inlineVideo.closest("button")).toBeNull();
    expect(trigger.closest("article")?.querySelector("button button, button a, button video")).toBeNull();
    inlineVideo.currentTime = 4;
    fireEvent.play(inlineVideo);
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "城市清晨" });
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(inlineVideo);
    expect(inlineVideo.currentTime).toBe(4);
    expect(dialog.closest(".studio-overlay-root")).not.toBeNull();
    expect(dialog.closest(".studio-v3")).toBeNull();
    expect(within(dialog).getByText(/只读预览/)).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "Wikimedia Commons" })).toBeVisible();
    expect(within(dialog).getByText(/改编须按相同许可分享/)).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "去确认授权" })).toHaveAttribute("href", "/resources#resource-manifest");
    expect(within(dialog).getByRole("link", { name: "清晨的街道" })).toHaveAttribute("href", "/projects/one");
    const video = within(dialog).getByLabelText("城市清晨 预览") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", `${item.contentUrl}#t=0.1`);
    expect(video).toHaveAttribute("controls");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video.muted).toBe(false);
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    for (let index = 0; index < 8; index += 1) {
      await user.tab();
      // Base UI 在下一帧把守卫上的焦点送回弹层；验证最终焦点而非帧间状态。
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    }
    fireEvent.play(video);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(video);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(inlineVideo.currentTime).toBe(4);
  });

  it("stops viewer audio on close and opens the next asset without auto playback", async () => {
    const user = userEvent.setup();
    const audio = asset({ key: "voice", mediaKind: "audio", query: "清晨旁白", contentUrl: "/api/runs/one/artifacts/voice/content" });
    renderAssets([audio, asset({ key: "image", mediaKind: "image", query: "清晨照片", contentUrl: "/api/runs/one/artifacts/photo/content" })]);
    const audioTrigger = await screen.findByRole("button", { name: "完整查看：清晨旁白" });
    await user.click(audioTrigger);
    const audioDialog = await screen.findByRole("dialog", { name: "清晨旁白" });
    const fullAudio = within(audioDialog).getByLabelText("清晨旁白 试听");
    expect(fullAudio).toHaveAttribute("src", audio.contentUrl);
    expect(fullAudio).toHaveAttribute("controls");
    expect(fullAudio).not.toHaveAttribute("autoplay");
    fireEvent.play(fullAudio);
    await user.click(within(audioDialog).getByRole("button", { name: "关闭素材预览" }));
    await waitFor(() => expect(audioTrigger).toHaveFocus());
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(fullAudio);
    await user.click(screen.getByRole("button", { name: "完整查看：清晨照片" }));
    const imageDialog = await screen.findByRole("dialog", { name: "清晨照片" });
    expect(within(imageDialog).getByRole("img", { name: "清晨照片 素材" })).toHaveAttribute("src", "/api/runs/one/artifacts/photo/content");
    expect(imageDialog.querySelector("audio, video")).toBeNull();
  });

  it("keeps all work-specific voice versions and rights after a failed full preview", async () => {
    const user = userEvent.setup();
    const voice = asset({ mediaKind: "audio", query: "共同旁白", providerId: "minimax-tts-v1", origin: "voice_synthesis", usages: [
      { runId: "one", runTitle: "作品一", itemId: "old", providerId: "minimax-tts-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded", voiceVersionInfo: { artifactId: "old", operation: "synthesis", versions: [{ versionId: "version-one", state: "historical" }] } },
      { runId: "two", runTitle: "作品二", itemId: "current", providerId: "minimax-tts-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded", voiceVersionInfo: { artifactId: "current", operation: "relayout", versions: [{ versionId: "version-two", state: "current" }] } },
      { runId: "three", runTitle: "作品三", itemId: "legacy", providerId: "minimax-tts-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded" },
    ] });
    renderAssets([voice]);
    await user.click(await screen.findByRole("button", { name: "按资产" }));
    await user.click(screen.getByRole("button", { name: "完整查看：共同旁白" }));
    const dialog = await screen.findByRole("dialog", { name: "共同旁白" });
    expect(within(dialog).getByRole("link", { name: "作品一" }).closest("li")).toHaveTextContent("历史声音版本 · 配音生成");
    expect(within(dialog).getByRole("link", { name: "作品二" }).closest("li")).toHaveTextContent("当前声音版本 · 配音时间调整");
    expect(within(dialog).getByRole("link", { name: "作品三" }).closest("li")).toHaveTextContent("版本归属未核实");
    expect(dialog).not.toHaveTextContent("已入当前成片");
    fireEvent.error(within(dialog).getByLabelText("共同旁白 试听"));
    expect(within(dialog).getByRole("status")).toHaveTextContent("预览未能加载");
    expect(within(dialog).getByRole("link", { name: "去确认授权" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "关闭素材预览" })).toBeVisible();
  });

  it("keeps conflicting sources scoped to each work instead of selecting an aggregate source", async () => {
    const user = userEvent.setup();
    const sources = ["https://source.example/a", "https://source.example/b", "https://source.example/a"];
    const conflicted = asset({
      provenanceConflict: true,
      useCount: sources.length,
      usages: sources.map((sourceUrl, index) => ({
        ...asset().usages[0]!, runId: `work-${index}`, runTitle: `作品 ${index + 1}`, itemId: `usage-${index}`, sourceUrl,
      })),
    });
    delete conflicted.sourceUrl;
    renderAssets([conflicted]);
    await user.click(await screen.findByRole("button", { name: "按资产" }));
    expect(screen.queryByRole("link", { name: /查看素材原始来源/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完整查看：城市清晨" }));
    const dialog = await screen.findByRole("dialog", { name: "城市清晨" });
    expect(within(dialog).queryByRole("link", { name: "查看原始来源" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "去确认授权" })).toBeVisible();
    sources.forEach((source, index) => {
      const usage = within(dialog).getByRole("link", { name: `作品 ${index + 1}` }).closest("li")!;
      expect(within(usage).getByRole("link", { name: "本次使用的来源" })).toHaveAttribute("href", source);
    });
  });

  it("uses the allowed Unsplash CDN and does not turn unsafe source metadata into links or media", async () => {
    const user = userEvent.setup();
    renderAssets([asset({ mediaKind: "image", providerId: "unsplash-stock-v1", sourceUrl: "javascript:alert(1)", previewUrl: "https://images.unsplash.com/photo-city?w=1200", creatorUrl: "javascript:alert(2)", usages: [] })]);
    await user.click(await screen.findByRole("button", { name: "完整查看：城市清晨" }));
    const dialog = await screen.findByRole("dialog", { name: "城市清晨" });
    expect(within(dialog).getByRole("img", { name: "城市清晨 素材" })).toHaveAttribute("src", "https://images.unsplash.com/photo-city?w=1200");
    expect(dialog.querySelector('[href^="javascript:"]')).toBeNull();
    expect(within(dialog).queryByRole("link", { name: "查看原始来源" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    cleanup();
    renderAssets([asset({ mediaKind: "image", contentUrl: "https://unapproved.example/asset.png", sourceUrl: "http://localhost:8080/private" })]);
    await user.click(await screen.findByRole("button", { name: "完整查看：城市清晨" }));
    const unavailable = await screen.findByRole("dialog", { name: "城市清晨" });
    expect(unavailable.querySelector("img, video, audio")).toBeNull();
    expect(within(unavailable).getByText("没有可用的预览内容")).toBeVisible();
    expect(within(unavailable).queryByRole("link", { name: "查看原始来源" })).not.toBeInTheDocument();
  });
});
