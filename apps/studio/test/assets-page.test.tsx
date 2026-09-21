import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";

describe("AssetsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows Coverr logo and Commons share-alike terms for recorded stock, not only pending reviews", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-20T00:00:00Z", totalItems: 2, needsReviewCount: 0,
      legacyRunsWithoutManifest: 0, reconstructedRunCount: 0, unreadableManifestCount: 0,
      truncatedRunCount: 0, truncatedItemCount: 0,
      categories: { visual: 2, voice: 0, font: 0, document: 0, other: 0 }, items: [],
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 2, duplicateUses: 0,
        reusableCount: 2, needsReviewCount: 0, facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
        assets: ["coverr", "wikimedia"].map((provider) => ({
          key: provider, mediaKind: "video", origin: "stock", reuseStatus: "ready", category: "visual",
          kind: "media_asset", providerId: `${provider}-stock-v1`, creator: `${provider} 作者`,
          licenseNote: provider === "wikimedia" ? "CC BY-SA 4.0：改编须按相同许可分享" : "Coverr license",
          contentUrl: `/media/${provider}.webm`, tags: [], commercialUse: "provider_terms",
          attributionRequirement: "provider_terms", reviewStatus: "recorded", useCount: 0, usages: [],
        })),
      },
    });
    render(<MemoryRouter><AssetsPage /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: "Coverr" })).toHaveAttribute("href", "https://coverr.co");
    expect(screen.getByRole("img", { name: "Coverr" })).toHaveAttribute("src", "/media/coverr-logo.svg");
    expect(screen.getByRole("link", { name: "Wikimedia Commons" })).toBeInTheDocument();
    expect(screen.getByText(/改编须按相同许可分享/)).toBeInTheDocument();
  });

  it("displays Unsplash CDN previews with linked photographer credit and a source configuration entry", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-19T00:00:00Z", totalItems: 1, needsReviewCount: 0,
      legacyRunsWithoutManifest: 0, reconstructedRunCount: 0, unreadableManifestCount: 0,
      truncatedRunCount: 0, truncatedItemCount: 0,
      categories: { visual: 1, voice: 0, font: 0, document: 0, other: 0 }, items: [],
      assetIndex: { version: "video-factory/asset-index-v1", totalAssets: 1, duplicateUses: 0,
        reusableCount: 1, needsReviewCount: 0,
        facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} }, assets: [{
          key: "photo", mediaKind: "image", origin: "stock", reuseStatus: "ready", category: "visual",
          kind: "media_asset", providerId: "unsplash-stock-v1", creator: "Photographer",
          creatorUrl: "https://unsplash.com/@photographer?utm_source=videofactory&utm_medium=referral",
          previewUrl: "https://images.unsplash.com/photo-1?w=400&ixid=view",
          contentUrl: "/api/runs/one/artifacts/photo/content", tags: [],
          commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded",
          useCount: 0, usages: [],
        }] },
    });
    render(<MemoryRouter><AssetsPage /></MemoryRouter>);
    const credit = await screen.findByRole("link", { name: "Photographer" });
    expect(credit).toHaveAttribute("href", "https://unsplash.com/@photographer?utm_source=videofactory&utm_medium=referral");
    expect(screen.getByRole("link", { name: "Unsplash" })).toHaveAttribute("href", "https://unsplash.com/?utm_source=videofactory&utm_medium=referral");
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://images.unsplash.com/photo-1?w=400&ixid=view");
    expect(screen.getByRole("link", { name: "配置外部素材来源" })).toHaveAttribute("href", "/resources#visual-providers");
  });

  it("routes pending rights reviews to the official manifest section from both entry points", async () => {
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-06T08:00:00.000Z",
      totalItems: 2,
      needsReviewCount: 1,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 2, voice: 0, font: 0, document: 0, other: 0 },
      items: [],
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 2,
        duplicateUses: 0,
        reusableCount: 1,
        needsReviewCount: 1,
        facets: {
          mediaKinds: { image: 2 },
          origins: { stock: 2 },
          providers: { "pexels-stock-v1": 2 },
          reuseStatuses: { ready: 1, review_required: 1 },
        },
        assets: [
          {
            key: "sha256:pending-rights",
            mediaKind: "image",
            origin: "stock",
            reuseStatus: "review_required",
            category: "visual",
            kind: "media_asset",
            providerId: "pexels-stock-v1",
            sourceUrl: "https://example.com/pending-source",
            query: "授权待确认的图片",
            tags: ["窗边"],
            commercialUse: "provider_terms",
            attributionRequirement: "provider_terms",
            reviewStatus: "needs_review",
            useCount: 1,
            usages: [{
              runId: "run-9",
              runTitle: "使用待确认素材的作品",
              itemId: "image-pending",
              providerId: "pexels-stock-v1",
              commercialUse: "provider_terms",
              attributionRequirement: "provider_terms",
              reviewStatus: "needs_review",
            }],
          },
          {
            key: "sha256:cleared",
            mediaKind: "image",
            origin: "stock",
            reuseStatus: "ready",
            category: "visual",
            kind: "media_asset",
            providerId: "pexels-stock-v1",
            sourceUrl: "https://example.com/cleared-source",
            query: "已确认的图片",
            tags: [],
            commercialUse: "provider_terms",
            attributionRequirement: "provider_terms",
            reviewStatus: "recorded",
            useCount: 1,
            usages: [{
              runId: "run-9",
              runTitle: "使用待确认素材的作品",
              itemId: "image-cleared",
              providerId: "pexels-stock-v1",
              commercialUse: "provider_terms",
              attributionRequirement: "provider_terms",
              reviewStatus: "recorded",
            }],
          },
        ],
      },
    });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);

    render(<MemoryRouter><AssetsPage /></MemoryRouter>);

    const rightsSummaryLink = await screen.findByRole("link", { name: /授权待确认 1 项/ });
    expect(rightsSummaryLink).toHaveAttribute("href", "/resources#resource-manifest");
    expect(await screen.findByRole("link", { name: "去确认授权" })).toHaveAttribute("href", "/resources#resource-manifest");
    expect(screen.getAllByRole("link", { name: "查看作品" })).toHaveLength(2);
    const sourceLinks = screen.getAllByRole("link", { name: "查看素材原始来源" });
    expect(sourceLinks).toHaveLength(2);
    expect(sourceLinks.map((link) => link.getAttribute("href"))).toEqual(
      expect.arrayContaining(["https://example.com/pending-source", "https://example.com/cleared-source"]),
    );
    expect(screen.getAllByText("图片素材").length).toBeGreaterThan(0);
    expect(screen.queryByText(/EPENDING|ECLEARED/)).not.toBeInTheDocument();
  });

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
            providerId: "local-editorial-v1",
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
              {
                runId: "run-1",
                runTitle: "窗边一杯水",
                itemId: "visual-2",
                providerId: "pexels-stock-v1",
                commercialUse: "provider_terms",
                attributionRequirement: "provider_terms",
                reviewStatus: "recorded",
                scenePosition: 2,
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
            providerId: "local",
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
            creator: "studio-owner",
            tags: ["studio-owner", "未归属"],
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
    expect(screen.getByRole("option", { name: "本地编辑画面 · 声音" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "本地编辑画面 · 视频" })).toBeInTheDocument();
    expect(screen.getByLabelText("素材提供方")).not.toHaveTextContent(/local-editorial-v1|\blocal\b/);
    expect(screen.getByRole("button", { name: /历史制作.*窗边一杯水/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: /历史制作.*窗边一杯水/ }));
    expect(screen.getByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 2" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("窗边一杯水 · 镜头 1 预览")).toHaveAttribute("src", "/api/runs/run-1/artifacts/render/content#t=0.1");
    expect(screen.getAllByText("镜头 1、2").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /制作 · 1 项素材/ })).toHaveLength(3);
    expect(screen.queryByRole("heading", { level: 2, name: "未归属项目" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "按资产" }));
    expect(screen.queryByRole("button", { name: /制作 · 1 项素材/ })).not.toBeInTheDocument();
    expect(screen.getByText("已用于 2 个镜头")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /声音/ }));
    expect(await screen.findByRole("heading", { level: 3, name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.getAllByText("声音素材").length).toBeGreaterThan(0);
    expect(screen.queryByText(/VOICE1/)).not.toBeInTheDocument();
    expect(screen.queryByText("已归档")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "窗边一杯水 · 镜头 1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "成片与记录" }));
    expect(screen.getByRole("heading", { level: 3, name: "脚本" })).toBeInTheDocument();
    expect(screen.getByText("AI 编剧 · 由你确认")).toBeInTheDocument();
    expect(screen.queryByText("studio-owner")).not.toBeInTheDocument();
    expect(screen.getAllByText("未归属").length).toBeGreaterThan(0);
    expect(screen.queryByText(/作品素材包/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "夜晚书房" })).not.toBeInTheDocument();
  });

  it("gives every production record a recognizable title, date, and run status", async () => {
    const user = userEvent.setup();
    const records = [
      { kind: "render", providerId: "python-ffmpeg-v1", mediaKind: "video", origin: "final_render" },
      { kind: "script", providerId: "codex-screenwriter-v1", mediaKind: "document", origin: "production_document" },
      { kind: "storyboard", providerId: "api-visual-director-v1", mediaKind: "document", origin: "production_document" },
      { kind: "asset_plan", providerId: "ai-shot-router-v1", mediaKind: "document", origin: "production_document" },
      { kind: "generation_jobs", providerId: "ai-shot-router-v1", mediaKind: "document", origin: "production_document" },
      { kind: "review_report", providerId: "python-technical-review-v1", mediaKind: "document", origin: "production_document" },
      { kind: "review_report", providerId: "codex-visual-review-v1", mediaKind: "document", origin: "production_document" },
      { kind: "publish_package", providerId: "inline:publish-package", mediaKind: "document", origin: "production_document" },
      { kind: "agent_loop_trace", providerId: "openai", mediaKind: "document", origin: "production_document" },
    ] as const;
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-09-07T08:00:00.000Z",
      totalItems: records.length,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 1, voice: 0, font: 0, document: records.length - 1, other: 0 },
      items: [],
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: records.length,
        duplicateUses: 0,
        reusableCount: 0,
        needsReviewCount: 0,
        facets: { mediaKinds: { video: 1, document: records.length - 1 }, origins: { final_render: 1, production_document: records.length - 1 }, providers: {}, reuseStatuses: { not_reusable: records.length } },
        assets: records.map((record, index) => ({
          key: `sha256:record-${index}`,
          ...record,
          category: record.kind === "render" ? "visual" as const : "document" as const,
          tags: [],
          commercialUse: "self_owned" as const,
          attributionRequirement: "not_required" as const,
          reviewStatus: "recorded" as const,
          reuseStatus: "not_reusable" as const,
          useCount: 1,
          usages: [{
            runId: "run-records",
            runTitle: "爆款候选复盘",
            itemId: `record-${index}`,
            providerId: record.providerId,
            commercialUse: "self_owned" as const,
            attributionRequirement: "not_required" as const,
            reviewStatus: "recorded" as const,
          }],
        })),
      },
    });
    vi.spyOn(studioApi, "runs").mockResolvedValue([{
      id: "run-records",
      title: "爆款候选复盘",
      status: "rejected",
      platform: "douyin",
      durationSeconds: 24,
      startedAt: "2026-09-06T08:00:00.000Z",
      finishedAt: "2026-09-06T08:12:00.000Z",
      currentNodeId: "final-review",
    }]);

    render(<MemoryRouter><AssetsPage /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "成片与记录" }));

    for (const title of ["最终成片", "脚本", "导演方案", "画面方案", "画面生成记录", "技术质检报告", "视觉审片报告", "发布包", "制作记录"]) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByText(/2026.*09.*06.*已打回/)).toHaveLength(records.length);
    expect(screen.queryByRole("heading", { level: 3, name: "爆款候选复盘" })).not.toBeInTheDocument();
  });
});
