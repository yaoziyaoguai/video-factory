import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";
import type { StudioIndexedAsset, StudioResourceManifest, StudioRunSummary } from "../src/shared/api.js";

const run: StudioRunSummary = {
  id: "run-current",
  title: "城市醒来之前",
  status: "needs_human",
  nextAction: "review",
  currentNodeId: "final-review",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-10-02T08:00:00.000Z",
  videoContentUrl: "/api/runs/run-current/artifacts/video/content",
};

afterEach(() => vi.restoreAllMocks());

const asset: StudioIndexedAsset = {
  key: "dawn-video",
  mediaKind: "video",
  origin: "stock",
  reuseStatus: "review_required",
  category: "visual",
  kind: "scene_video",
  providerId: "wikimedia-stock-v1",
  creator: "摄影作者",
  sourceUrl: "https://example.com/dawn-source",
  query: "清晨街道",
  contentUrl: "/api/runs/run-current/artifacts/scene/content",
  width: 1920,
  height: 1080,
  durationSeconds: 6,
  tags: ["日出", "街道"],
  commercialUse: "provider_terms",
  attributionRequirement: "provider_terms",
  reviewStatus: "needs_review",
  useCount: 1,
  usages: [{
    runId: run.id,
    runTitle: run.title,
    itemId: "dawn-scene",
    providerId: "wikimedia-stock-v1",
    commercialUse: "provider_terms",
    attributionRequirement: "provider_terms",
    reviewStatus: "needs_review",
    scenePosition: 1,
  }],
};

function manifest(assets: StudioIndexedAsset[]): StudioResourceManifest {
  return {
    generatedAt: "2026-10-02T08:00:00.000Z",
    totalItems: assets.length,
    needsReviewCount: 1,
    legacyRunsWithoutManifest: 0,
    reconstructedRunCount: 0,
    unreadableManifestCount: 0,
    truncatedRunCount: 0,
    truncatedItemCount: 0,
    categories: { visual: assets.length, voice: 0, font: 0, document: 0, other: 0 },
    items: [],
    assetIndex: {
      version: "video-factory/asset-index-v1",
      totalAssets: assets.length,
      duplicateUses: 0,
      reusableCount: 0,
      needsReviewCount: 1,
      facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
      assets,
    },
  };
}

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

describe("artifact-first library surfaces", () => {
  it("explains the initial wait without presenting an empty library or blocking the four entry points", () => {
    vi.spyOn(studioApi, "runs").mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取你的作品");
    expect(screen.getByRole("button", { name: /从热点开始/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /继续一个系列/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /从自己的想法开始/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /从案例 \/ 脚本开始/ })).toBeEnabled();
  });

  it("lets the creator preview the real current video before the overview without approving it", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([run]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    const work = await screen.findByRole("region", { name: run.title });
    const preview = within(work).getByLabelText(`${run.title} 预览`);
    expect(preview).toHaveAttribute("src", `${run.videoContentUrl}#t=0.1`);
    expect(preview).toHaveAttribute("controls");
    expect(preview).not.toHaveAttribute("autoplay");
    expect(within(work).getByRole("link", { name: /审片/ })).toHaveAttribute("href", "/projects/run-current");
    const overview = screen.getByRole("region", { name: "制作概况" });
    expect(work.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps attribution and rights actions visible while revealing optional specifications on request", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "runs").mockResolvedValue([run]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue(manifest([asset]));
    render(<MemoryRouter><AssetsPage /></MemoryRouter>);

    const detailsToggle = await screen.findByText("规格与标签");
    const details = detailsToggle.closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByRole("link", { name: /去确认授权：清晨街道/ })).toBeVisible();
    expect(screen.getByRole("link", { name: "Wikimedia Commons" })).toBeVisible();
    expect(screen.getByRole("link", { name: /查看素材原始来源/ })).toHaveAttribute("href", asset.sourceUrl);
    await user.click(detailsToggle);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("1920 × 1080")).toBeVisible();
    expect(screen.getByText("日出")).toBeVisible();
    await user.click(detailsToggle);
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByRole("link", { name: /查看作品：清晨街道/ })).toBeVisible();
  });

  it("does not invent a video preview for a planning result and keeps the actual next action", async () => {
    const planningRun = { ...run, title: "未拍摄的想法", currentNodeId: "creative-planning" };
    delete planningRun.videoContentUrl;
    vi.spyOn(studioApi, "runs").mockResolvedValue([planningRun]);
    const { container } = render(<MemoryRouter><HomePage /></MemoryRouter>);

    const work = await screen.findByRole("region", { name: "未拍摄的想法" });
    expect(container.querySelector("video")).toBeNull();
    expect(within(work).getByRole("link")).toHaveAttribute("href", "/projects/run-current");
    expect(within(work).getByText(/等待你的判断/)).toBeVisible();
  });

  it.each([
    ["从热点开始", "/topics"],
    ["继续一个系列", "/topics?mode=series"],
    ["从自己的想法开始", "/topics?mode=manual"],
    ["从案例 / 脚本开始", "/cases"],
  ])("keeps the %s creation entry unchanged", async (label, destination) => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    render(<MemoryRouter><HomePage /><CurrentLocation /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: new RegExp(label) }));
    expect(screen.getByLabelText("当前位置")).toHaveTextContent(destination);
  });
});
