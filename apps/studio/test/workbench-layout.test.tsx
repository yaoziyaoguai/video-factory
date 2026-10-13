import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StudioRunDetail } from "../src/shared/api.js";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";

function runFixture(nodeId = "publish-package"): StudioRunDetail {
  return {
    id: "workdesk-layout", revision: 4, title: "海边散步：留一点时间给自己", status: "needs_human",
    platform: "douyin", durationSeconds: 24, startedAt: "2026-10-13T00:00:00Z",
    currentNodeId: nodeId, nextAction: "review", continuation: { supported: true },
    angle: "日常散步", audience: "想休息片刻的人", nicheSlug: "life", reviewMode: "manual",
    nodes: [
      { id: "visual-review", label: "视觉审片", status: "succeeded", artifactIds: [], qualityGateResults: [], output: {
        report: {
          recommendation: "revise", confidence: 0.8, summary: "有一处镜头需确认。", scores: { pacing: 70 },
          findings: [{ timecodeMs: 1000, scenePosition: 1, category: "pacing", description: "开场停留较短。",
            suggestion: "核对节奏。", evidenceStatus: "failed", severity: "warning" }],
          independentReviews: [],
        },
      } },
      { id: nodeId, label: nodeId === "publish-package" ? "发布文案" : "人工终审", status: "needs_human",
        artifactIds: [], qualityGateResults: [], output: { title: "去海边走走" } },
    ],
    artifacts: [{ id: "film-4", kind: "render", producerNodeId: "render", createdAt: "2026-10-13T00:01:00Z",
      contentType: "video/mp4", contentUrl: "/api/artifacts/film-4" }],
    videoArtifactId: "film-4", decisions: [], finalReviewOutcome: "approved",
    activeIntervention: { id: "stop-4", nodeId, reason: "查看这版内容后决定。", options: ["approve", "reject"],
      createdAt: "2026-10-13T00:02:00Z", ...(nodeId === "publish-package" ? { boundary: "node-complete" as const } : {}) },
  };
}

describe("workdesk layout preserves decision and media boundaries", () => {
  it("reports media loading failure without replacing the player or triggering a production action", () => {
    const onDecision = vi.fn();
    const run = runFixture("final-review");
    const { rerender } = render(<RunWorkbench run={run} decisionPending={false} onDecision={onDecision} />);
    const video = screen.getByTitle("成片预览");
    expect(screen.getByText("正在读取成片预览…")).toBeVisible();
    fireEvent.error(video);
    expect(screen.getByText(/成片预览读取失败/)).toBeVisible();
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(screen.getByTitle("下载成片")).toBeVisible();
    expect(onDecision).not.toHaveBeenCalled();
    const next = { ...run, artifacts: run.artifacts.map(artifact => ({ ...artifact, contentUrl: "/api/artifacts/film-next" })) };
    rerender(<RunWorkbench run={next} decisionPending={false} onDecision={onDecision} />);
    expect(screen.queryByText(/成片预览读取失败/)).not.toBeInTheDocument();
    expect(screen.getByText("正在读取成片预览…")).toBeVisible();
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    fireEvent.loadedData(video);
    expect(screen.queryByText("正在读取成片预览…")).not.toBeInTheDocument();
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("styles pane-switch controls at the same 1100px breakpoint where they become visible", () => {
    // CSSOM 合同只验证断点与触达区，实际窄屏排版仍由浏览器检查。
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(readFileSync(resolve(process.cwd(), "src/client/studio-workspace.css"), "utf8"));
    const breakpoint = Array.from(sheet.cssRules).find(rule => rule instanceof CSSMediaRule
      && rule.conditionText === "(max-width: 1100px)") as CSSMediaRule;
    const paneSwitchRule = Array.from(breakpoint.cssRules).find(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ".studio-v3 .creative-mobile-tabs button") as CSSStyleRule;
    expect(paneSwitchRule.style.getPropertyValue("min-height")).toBe("44px");
    expect(paneSwitchRule.style.getPropertyValue("background")).toBe("transparent");
    expect(paneSwitchRule.style.getPropertyValue("font-size")).toBe("14px");
    expect(Array.from(breakpoint.cssRules).some(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ".studio-v3 .creative-mobile-tabs button:focus-visible")).toBe(true);
  });

  it("keeps composer explanations readable and only places closed duration details beside the desktop summary", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(readFileSync(resolve(process.cwd(), "src/client/studio-workspace.css"), "utf8"));
    const explanation = Array.from(sheet.cssRules).find(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ".studio-v3 .creative-composer small") as CSSStyleRule;
    expect(explanation.style.getPropertyValue("font-size")).toBe("14px");
    expect(explanation.style.getPropertyValue("line-height")).toBe("1.6");
    const desktop = Array.from(sheet.cssRules).find(rule => rule instanceof CSSMediaRule
      && rule.conditionText === "(min-width: 1101px)") as CSSMediaRule;
    const details = Array.from(desktop.cssRules).find(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ".studio-v3 .creative-duration-panel > .duration-scene-details:not([open])") as CSSStyleRule;
    expect(details.style.getPropertyValue("grid-column")).toBe("2");
    expect(details.style.getPropertyValue("grid-row")).toBe("2 / 4");
    const expanded = Array.from(desktop.cssRules).find(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ".studio-v3 .creative-duration-panel > *") as CSSStyleRule;
    expect(expanded.style.getPropertyValue("grid-column")).toBe("1 / -1");
  });

  it("keeps the no-media decision consequences alongside its actions instead of above the current artifact", () => {
    const run = runFixture("creative-planning");
    run.artifacts = [];
    delete run.videoArtifactId;
    run.nodes = run.nodes.filter(node => node.id !== "visual-review");
    run.activeIntervention!.boundary = "node-complete";
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    const decision = screen.getByRole("status", { name: "当前决定" });
    const side = screen.getByRole("complementary", { name: "审片与产物" });
    expect(side).toContainElement(decision);
    expect(within(decision).getByText("费用影响")).toBeVisible();
    expect(screen.getByRole("region", { name: "当前步骤产物" }).compareDocumentPosition(side)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses only prior film findings at the publish-copy stop and leaves risks and original queries visible", async () => {
    const user = userEvent.setup();
    const run = runFixture();
    run.optionalReviewTasks = [{ nodeId: "visual-review", purpose: "audio_review", operationId: "audio-original",
      requestId: "original-request", targetVersionId: "film-4", requestState: "unknown", resultState: "absent",
      summary: "原声音请求尚未核实。" }];
    const onDecision = vi.fn();
    const onQueryOriginalTextTask = vi.fn();
    render(<RunWorkbench run={run} decisionPending={false} onDecision={onDecision} onQueryOriginalTextTask={onQueryOriginalTextTask} />);
    const summary = screen.getByText("成片审片记录与返工");
    const disclosure = summary.closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(within(disclosure.querySelector("summary")!).getByText(/1 项问题/)).toBeVisible();
    expect(screen.getByText(/缺少 2 个可验证的独立审片结果/)).toBeVisible();
    expect(screen.getByText(/1 项原审计的结果与费用待核/)).toBeVisible();
    expect(screen.getByRole("button", { name: "查询原声音审片" }).closest("details")).toBeNull();
    expect(screen.getByRole("status", { name: "当前决定" }).closest("details")).toBeNull();
    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(within(disclosure).getByText("视觉审片建议修改后再审")).toBeVisible();
    expect(onDecision).not.toHaveBeenCalled();
    expect(onQueryOriginalTextTask).not.toHaveBeenCalled();
  });

  it("keeps consequences available while the creative document is still being read", () => {
    const run = runFixture("creative-planning");
    run.artifacts = [];
    delete run.videoArtifactId;
    run.activeIntervention!.kind = "creative_review";
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.getByText("正在读取当前方案与讨论。读取完成后才能确认此版本。")).toBeVisible();
    expect(screen.getByRole("status", { name: "当前决定" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认当前步骤，进入下一步" })).not.toBeInTheDocument();
  });

  it("does not fold current final-review findings or replace the player when focus mode changes", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(<RunWorkbench run={runFixture("final-review")} decisionPending={false} onDecision={onDecision} />);
    expect(screen.getByText("视觉审片建议修改后再审").closest("details")).toBeNull();
    expect(screen.queryByText("成片审片记录与返工")).not.toBeInTheDocument();
    const video = screen.getByTitle("成片预览") as HTMLVideoElement;
    const bringIntoView = vi.fn();
    Object.defineProperty(video.closest(".video-stage"), "scrollIntoView", { value: bringIntoView });
    video.currentTime = 7.5;
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    expect(bringIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(video.currentTime).toBe(7.5);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(video.currentTime).toBe(7.5);
    expect(screen.getByRole("button", { name: "专注观看" })).toHaveFocus();
    expect(onDecision).not.toHaveBeenCalled();
  });
});
