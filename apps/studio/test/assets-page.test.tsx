import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";

describe("AssetsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows deduplicated indexed assets and filters without inventing content", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-08-29T08:00:00.000Z",
      totalItems: 2,
      needsReviewCount: 1,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 1, voice: 1, font: 0, document: 0, other: 0 },
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 2,
        duplicateUses: 1,
        reusableCount: 1,
        needsReviewCount: 0,
        facets: {
          mediaKinds: { video: 1, audio: 1 },
          origins: { stock: 1, voice_synthesis: 1 },
          providers: { "pexels-stock-v1": 1, "minimax-tts-v1": 1 },
          reuseStatuses: { ready: 1, not_reusable: 1 },
        },
        assets: [
          {
            key: "sha256:visual",
            mediaKind: "video",
            origin: "stock",
            reuseStatus: "ready",
            category: "visual",
            kind: "scene_video",
            providerId: "pexels-stock-v1",
            contentUrl: "/api/runs/run-1/artifacts/render/content",
            contentType: "video/mp4",
            width: 1080,
            height: 1920,
            aspectRatio: "9:16",
            durationSeconds: 6,
            tags: ["窗边", "水杯"],
            commercialUse: "provider_terms",
            attributionRequirement: "provider_terms",
            reviewStatus: "recorded",
            useCount: 2,
            usages: [
              {
                runId: "run-0",
                runTitle: "清晨饮水",
                itemId: "visual-0",
                providerId: "pexels-stock-v1",
                commercialUse: "provider_terms",
                attributionRequirement: "provider_terms",
                reviewStatus: "recorded",
                scenePosition: 2,
                selectedInFinal: true,
              },
              {
                runId: "run-1",
                runTitle: "窗边一杯水",
                itemId: "visual-1",
                providerId: "pexels-stock-v1",
                commercialUse: "provider_terms",
                attributionRequirement: "provider_terms",
                reviewStatus: "recorded",
                scenePosition: 1,
                selectedInFinal: true,
              },
            ],
          },
          {
            key: "sha256:voice",
            mediaKind: "audio",
            origin: "voice_synthesis",
            reuseStatus: "not_reusable",
            category: "voice",
            kind: "voiceover",
            providerId: "minimax-tts-v1",
            tags: ["夜晚", "书房"],
            commercialUse: "provider_terms",
            attributionRequirement: "provider_terms",
            reviewStatus: "recorded",
            useCount: 1,
            usages: [{
              runId: "run-2",
              runTitle: "夜晚书房",
              itemId: "voice-1",
              providerId: "minimax-tts-v1",
              commercialUse: "provider_terms",
              attributionRequirement: "provider_terms",
              reviewStatus: "recorded",
            }],
          },
        ],
      },
      items: [
        {
          id: "visual-1",
          runId: "run-1",
          runTitle: "窗边一杯水",
          category: "visual",
          kind: "render",
          providerId: "python-ffmpeg-v1",
          contentUrl: "/api/runs/run-1/artifacts/render/content",
          contentType: "video/mp4",
          commercialUse: "provider_terms",
          attributionRequirement: "provider_terms",
          reviewStatus: "needs_review",
        },
        {
          id: "voice-1",
          runId: "run-2",
          runTitle: "夜晚书房",
          category: "voice",
          kind: "voiceover",
          providerId: "minimax-tts-v1",
          commercialUse: "provider_terms",
          attributionRequirement: "provider_terms",
          reviewStatus: "recorded",
        },
      ],
    });

    render(<MemoryRouter><AssetsPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "窗边一杯水 · 镜头 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.getByLabelText("窗边一杯水 · 镜头 1 预览")).toHaveAttribute("src", "/api/runs/run-1/artifacts/render/content#t=0.1");
    expect(screen.getByText("已用于 2 个镜头")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /声音/ }));
    expect(await screen.findByRole("heading", { name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "窗边一杯水 · 镜头 1" })).not.toBeInTheDocument();
  });
});
