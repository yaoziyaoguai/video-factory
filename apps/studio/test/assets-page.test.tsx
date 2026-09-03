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
      totalItems: 3,
      needsReviewCount: 1,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 1, voice: 1, font: 0, document: 1, other: 0 },
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 3,
        duplicateUses: 1,
        reusableCount: 1,
        needsReviewCount: 0,
        facets: {
          mediaKinds: { video: 1, audio: 1, document: 1 },
          origins: { stock: 1, voice_synthesis: 1, production_document: 1 },
          providers: { "pexels-stock-v1": 1, "minimax-tts-v1": 1, "codex-screenwriter-v1": 1 },
          reuseStatuses: { ready: 1, not_reusable: 2 },
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
          {
            key: "sha256:orphan-document",
            mediaKind: "document",
            origin: "production_document",
            reuseStatus: "not_reusable",
            category: "document",
            kind: "script",
            providerId: "codex-screenwriter-v1",
            tags: ["未归属"],
            commercialUse: "self_owned",
            attributionRequirement: "not_required",
            reviewStatus: "recorded",
            useCount: 0,
            usages: [],
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

    expect(await screen.findByRole("heading", { level: 3, name: "清晨饮水 · 镜头 2" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.getByText("MiniMax 中文配音")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /历史制作.*窗边一杯水/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: /历史制作.*窗边一杯水/ }));
    expect(screen.getByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("窗边一杯水 · 镜头 1 预览")).toHaveAttribute("src", "/api/runs/run-1/artifacts/render/content#t=0.1");
    expect(screen.getByText("镜头 2")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /制作 · 1 项素材/ })).toHaveLength(3);
    expect(screen.queryByRole("heading", { level: 2, name: "未归属项目" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "按资产" }));
    expect(screen.queryByRole("button", { name: /制作 · 1 项素材/ })).not.toBeInTheDocument();
    expect(screen.getByText("已用于 2 个镜头")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /声音/ }));
    expect(await screen.findByRole("heading", { level: 3, name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "成片与记录" }));
    expect(screen.getByRole("heading", { level: 3, name: "制作文档" })).toBeInTheDocument();
    expect(screen.getAllByText("未归属").length).toBeGreaterThan(0);
    expect(screen.queryByText(/作品素材包/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "夜晚书房" })).not.toBeInTheDocument();
  });
});
