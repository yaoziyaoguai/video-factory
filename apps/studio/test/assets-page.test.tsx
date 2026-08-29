import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AssetsPage } from "../src/client/pages/AssetsPage.js";

describe("AssetsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts with real visual assets and filters the same manifest without inventing content", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-08-29T08:00:00.000Z",
      totalItems: 2,
      needsReviewCount: 1,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      categories: { visual: 1, voice: 1, font: 0, document: 0, other: 0 },
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

    expect(await screen.findByRole("heading", { name: "窗边一杯水" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "夜晚书房" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("窗边一杯水 预览")).toHaveAttribute("src", "/api/runs/run-1/artifacts/render/content#t=0.1");

    await user.click(screen.getByRole("button", { name: /声音/ }));
    expect(await screen.findByRole("heading", { name: "夜晚书房" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "窗边一杯水" })).not.toBeInTheDocument();
  });
});
