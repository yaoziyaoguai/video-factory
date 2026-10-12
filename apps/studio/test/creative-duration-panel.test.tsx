import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDurationPanel } from "../src/client/components/CreativeDurationPanel.js";
import type { StudioCreativeReviewSnapshot } from "../src/shared/api.js";

function durationReview(overrides: Partial<StudioCreativeReviewSnapshot> = {}): StudioCreativeReviewSnapshot {
  return {
    runId: "run-duration-summary", runRevision: 8, stage: "script", reviewRevision: 3,
    draftSha256: "a".repeat(64), draftVersionId: "script-v2", draftArtifactId: "script-draft-1",
    phase: "waiting_user", allowedActions: ["confirm", "update_duration"], returnTargets: [],
    draft: { scenes: [{ id: "scene-1", position: 1, duration: 12, narration: "当前稿件正文。" }] },
    messages: [], proposals: [], effectiveUserInstructions: [], blockingIssues: [],
    duration: { policy: "content-led-v1", briefSha256: "b".repeat(64), referenceSeconds: 24,
      proposal: { versionId: "script-v2", totalFrames: 360, totalSeconds: 12,
        scenes: [{ position: 1, frameCount: 360, durationSeconds: 12 }] } },
    ...overrides,
  };
}

beforeEach(() => window.sessionStorage.clear());

describe("compact early duration summary", () => {
  it("keeps the proposed duration, explicit range and adoption/cost boundary visible while collapsing calculation details", () => {
    render(<CreativeDurationPanel review={durationReview()} onSave={vi.fn(async () => true)} />);
    const panel = screen.getByRole("region", { name: "本版时长" });
    expect(within(panel).getByText("建议成片约 12 秒，共 1 镜")).toBeVisible();
    expect(within(panel).getByText(/参考目标：24 秒.*未设硬性范围/)).toBeVisible();
    expect(within(panel).getByText(/采用本版时一并确认时长.*费用待方案核价.*不授权素材购买/)).toBeVisible();
    expect(within(panel).getByRole("button", { name: "修改时长要求" })).toBeVisible();
    const calculation = within(panel).getByText(/以当前脚本的 360 帧计算/);
    const details = calculation.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(calculation).not.toBeVisible();
    expect(within(panel).getByText(/第 1 镜：12 秒/)).not.toBeVisible();
  });

  it("shows hard limits, changed-version consequences and actual conflicts without opening details", () => {
    const current = durationReview();
    current.duration!.commitment = { maxSeconds: 10 };
    current.duration!.previouslyAdopted = { versionId: "script-v1", totalSeconds: 9, totalFrames: 270,
      scenes: [{ position: 1, frameCount: 270, durationSeconds: 9 }] };
    current.conflicts = [{ code: "duration_commitment_conflict", scenePositions: [1], detail: "本稿12秒超过最多10秒" }];
    render(<CreativeDurationPanel review={current} onSave={vi.fn(async () => true)} />);
    expect(screen.getByText(/你明确设置的时长要求：最多 10 秒/)).toBeVisible();
    expect(screen.getByText(/时长变化：原 9 秒 → 建议 12 秒/)).toBeVisible();
    expect(screen.getByText(/素材覆盖、声音安排及报价需要按新版本核对/)).toBeVisible();
    expect(screen.getByText(/本稿12秒超过最多10秒/)).toBeVisible();
    expect(screen.getByText(/可修改脚本，或修改、取消时长要求/)).toBeVisible();
  });

  it("does not save or adopt when opening details and preserves single-sided explicit save", async () => {
    const onSave = vi.fn(async () => true);
    const onAdopt = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<CreativeDurationPanel review={durationReview()} onSave={onSave} onAdopt={onAdopt} />);
    const summary = screen.getByText("查看 1 镜时长明细");
    fireEvent.click(summary);
    expect(screen.getByText(/以当前脚本的 360 帧计算/)).toBeVisible();
    expect(screen.getByText(/第 1 镜：12 秒/)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.type(screen.getByLabelText("最多秒数（可不填）"), "30");
    await user.click(screen.getByRole("button", { name: "仅保存时长要求" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ expectedBriefSha256: "b".repeat(64), range: { maxSeconds: 30 } });
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("retains unavailable and legacy requirements rather than implying a confirmed proposal", () => {
    render(<CreativeDurationPanel review={durationReview({ duration: { policy: "legacy", referenceSeconds: 24,
      briefSha256: "b".repeat(64), commitment: { minSeconds: 20, maxSeconds: 34 }, unavailableReason: "尚未取得当前稿的可执行时长。" } })} />);
    expect(screen.getByText("尚未取得当前稿的可执行时长。")).toBeVisible();
    expect(screen.getByText(/沿用旧版时长约束：至少 20 秒，最多 34 秒/)).toBeVisible();
    expect(screen.queryByText(/建议成片约/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改时长要求" })).not.toBeInTheDocument();
  });
});
