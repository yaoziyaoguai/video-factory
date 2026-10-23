import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import type { NarrationVisualTimingAdjustment } from "../src/client/components/NarrationTimingEditor.js";
import type { StudioRunDetail } from "../src/shared/api.js";

// 原声长度的计算由声音工具与服务端测试覆盖；此处验证用户建议进入既有决定合同。
vi.mock("../src/client/components/NarrationTimingEditor.js", () => ({
  NarrationTimingEditor: ({ onAdjustVisualTiming }: { onAdjustVisualTiming?: (value: NarrationVisualTimingAdjustment) => void }) =>
    onAdjustVisualTiming ? <button onClick={() => onAdjustVisualTiming({ groupId: "narration-1", sourceScenePositions: [2, 3], plannedSeconds: 10, requiredSeconds: 7 })}>查看本段画面时长建议</button> : null,
}));

function voiceRun(): StudioRunDetail {
  return { id: "voice-timing-run", revision: 4, title: "一段连贯旁白", status: "needs_human", currentNodeId: "voice",
    platform: "douyin", durationSeconds: 24, angle: "日常", audience: "", nicheSlug: "daily", reviewMode: "manual", startedAt: "2026-10-23T10:00:00Z",
    durationIntent: { policy: "content-led-v1", briefSha256: "a".repeat(64), referenceSeconds: 24 },
    voiceTimingPlan: { versionId: "timeline-v1", planSha256: "b".repeat(64), totalFrames: 450,
      cuts: [{ scenePosition: 1, frameCount: 150 }, { scenePosition: 2, frameCount: 150 }, { scenePosition: 3, frameCount: 150 }] },
    nodes: [{ id: "voice", label: "声音", role: "配音", status: "needs_human", artifactIds: [], qualityGateResults: [], output: { duration: 15 } }],
    activeIntervention: { id: "voice-stop", nodeId: "voice", boundary: "node-complete", reason: "请试听", options: ["approve", "reject"], createdAt: "2026-10-23T10:00:00Z" },
    artifacts: [], decisions: [],
  };
}

describe("voice window reduction confirmation", () => {
  it("requires an explicit scene choice and sends only the selected shorter duration with the captured revision", () => {
    const decide = vi.fn(async () => {});
    render(<RunWorkbench run={voiceRun()} decisionPending={false} onDecision={decide} />);
    fireEvent.click(screen.getByRole("button", { name: "查看本段画面时长建议" }));
    expect(screen.getByRole("dialog", { name: "缩短画面空档" })).toBeVisible();
    const confirm = screen.getByRole("button", { name: "接受新时长并继续制作" });
    expect(confirm).toBeDisabled();
    const select = screen.getByLabelText("选择要缩短的镜头");
    expect(select).toHaveValue("");
    expect(screen.queryByRole("option", { name: /镜头 1/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "3" } });
    expect(screen.getByLabelText("镜头 3 时长（秒）")).toHaveValue(2);
    expect(screen.getByText(/整片时长：原 15 秒/)).toHaveTextContent("建议 12 秒");
    fireEvent.click(confirm);
    expect(decide).toHaveBeenCalledExactlyOnceWith({ action: "request_changes", expectedRunRevision: 4,
      interventionId: "voice-stop", reviewEvidenceId: null, voiceTiming: { groupId: "narration-1", scenePosition: 3, durationSeconds: 2 } });
  });

  it("retains an open duration draft but rejects it after a newer timeline or stop arrives", () => {
    const run = voiceRun();
    const decide = vi.fn(async () => {});
    const props = { decisionPending: false, onDecision: decide };
    const { rerender } = render(<RunWorkbench run={run} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "查看本段画面时长建议" }));
    fireEvent.change(screen.getByLabelText("选择要缩短的镜头"), { target: { value: "2" } });
    rerender(<RunWorkbench run={{ ...run, revision: 5, voiceTimingPlan: { ...run.voiceTimingPlan!, planSha256: "c".repeat(64) } }} {...props} />);
    expect(screen.getByLabelText("镜头 2 时长（秒）")).toHaveValue(2);
    expect(screen.getByRole("button", { name: "接受新时长并继续制作" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("当前方案或时长要求已更新");
    expect(decide).not.toHaveBeenCalled();
  });

  it("does not expose shortening at another stop or for native audio", () => {
    const run = voiceRun();
    const props = { decisionPending: false, onDecision: vi.fn() };
    const { rerender } = render(<RunWorkbench run={{ ...run, audioMode: "native_av" }} {...props} />);
    expect(screen.queryByRole("button", { name: "查看本段画面时长建议" })).not.toBeInTheDocument();
    rerender(<RunWorkbench run={{ ...run, currentNodeId: "final-review", activeIntervention: { ...run.activeIntervention!, nodeId: "final-review" } }} {...props} />);
    expect(screen.queryByRole("button", { name: "查看本段画面时长建议" })).not.toBeInTheDocument();
  });
});
