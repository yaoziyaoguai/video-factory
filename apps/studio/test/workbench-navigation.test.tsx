import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StudioRunDetail } from "../src/shared/api.js";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import { revealNodeWorkspace } from "../src/client/components/NodeWorkspace.js";

function runFixture(film = false): StudioRunDetail {
  return {
    id: "navigation-run", revision: 1, title: "给生活留一点空白", status: "needs_human", platform: "douyin",
    durationSeconds: 24, startedAt: "2026-10-17T00:00:00Z", angle: "日常观察", audience: "创作者",
    nicheSlug: "daily", reviewMode: "manual", currentNodeId: film ? "final-review" : "brief",
    nodes: [
      { id: "brief", label: "内容简报", status: "succeeded", artifactIds: [], qualityGateResults: [],
        output: { title: "给生活留一点空白", angle: "日常观察", audience: "创作者", durationSeconds: 24, platform: "douyin" } },
      { id: "assets", label: "画面", status: "pending", artifactIds: [], qualityGateResults: [] },
      { id: "render", label: "渲染", status: film ? "succeeded" : "pending", artifactIds: film ? ["film"] : [], qualityGateResults: [] },
    ],
    artifacts: film ? [{ id: "film", kind: "render", producerNodeId: "render", contentUrl: "/film.mp4", contentType: "video/mp4", createdAt: "2026-10-17T00:00:00Z" }] : [],
    ...(film ? { videoArtifactId: "film" } : {}), decisions: [],
    activeIntervention: { id: "stop", nodeId: film ? "final-review" : "brief", boundary: "node-complete", reason: "请核对当前交付", options: ["approve", "reject"], createdAt: "2026-10-17T00:00:00Z" },
  };
}
const clickTab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("task-first workbench navigation", () => {
  it("shows only the current delivery before media exists and explains future stages", () => {
    const decide = vi.fn();
    render(<RunWorkbench run={runFixture()} decisionPending={false} onDecision={decide} />);
    expect(screen.getByRole("region", { name: "当前步骤产物" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "审片" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("成片预览")).not.toBeInTheDocument();
    clickTab("制作流程");
    fireEvent.click(within(screen.getByRole("navigation", { name: "制作阶段" })).getByRole("button", { name: /画面/ }));
    expect(screen.getByText("这个阶段还没有开始")).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认当前步骤，进入下一步" })).not.toBeInTheDocument();
    clickTab("当前任务");
    expect(screen.getByRole("region", { name: "当前步骤产物" })).toBeVisible();
    expect(decide).not.toHaveBeenCalled();
  });

  it("retains an editor draft and the chosen historical stage through tabs and a new run snapshot", async () => {
    const user = userEvent.setup();
    const run = runFixture(true);
    const save = vi.fn();
    const props = { decisionPending: false, onDecision: vi.fn(), onOverrideNode: save };
    const { rerender } = render(<RunWorkbench run={run} {...props} />);
    clickTab("制作流程");
    fireEvent.click(within(screen.getByRole("navigation", { name: "制作阶段" })).getByRole("button", { name: /内容简报/ }));
    await user.click(screen.getByRole("button", { name: "编辑交付" }));
    const title = screen.getByLabelText("标题");
    await user.clear(title);
    await user.type(title, "保留这份未保存的草稿");
    clickTab("设置与费用");
    expect(title).not.toBeVisible();
    rerender(<RunWorkbench run={{ ...run, revision: 2 }} {...props} />);
    clickTab("制作流程");
    expect(title).toBeVisible();
    expect(title).toHaveValue("保留这份未保存的草稿");
    expect(within(screen.getByRole("navigation", { name: "制作阶段" })).getByRole("button", { name: /内容简报/ })).toHaveAttribute("aria-current", "step");
    expect(save).not.toHaveBeenCalled();
  });

  it("opens the selected delivery on entering the process view without collapsing the current task", () => {
    const run = runFixture();
    run.nodes[1] = { ...run.nodes[1]!, status: "succeeded", output: { scenes: [{ scenePosition: 1, description: "已保存的镜头" }] } };
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    const brief = document.getElementById("node-workspace-brief")!;
    expect(brief).toHaveAttribute("open");
    clickTab("制作流程");
    fireEvent.click(within(screen.getByRole("navigation", { name: "制作阶段" })).getByRole("button", { name: /画面/ }));
    const assets = document.getElementById("node-workspace-assets")!;
    expect(assets).toHaveAttribute("open");
    clickTab("当前任务");
    expect(brief).toBeVisible();
    expect(brief).toHaveAttribute("open");
    clickTab("制作流程");
    expect(assets).toBeVisible();
    expect(assets).toHaveAttribute("open");
  });

  it("pauses hidden media while retaining the same player and playback position", () => {
    render(<RunWorkbench run={runFixture(true)} decisionPending={false} onDecision={vi.fn()} />);
    const video = screen.getByTitle("成片预览") as HTMLVideoElement;
    const pause = vi.fn();
    Object.defineProperty(video, "paused", { value: false });
    Object.defineProperty(video, "pause", { value: pause });
    video.currentTime = 8;
    clickTab("制作流程");
    expect(pause).toHaveBeenCalledOnce();
    expect(video).not.toBeVisible();
    clickTab("当前任务");
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(video.currentTime).toBe(8);
  });

  it("opens the real node from an existing reveal action and keeps history selected on refresh", () => {
    const run = runFixture(true);
    const { rerender } = render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "制作流程" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "制作阶段" })).getByRole("button", { name: /内容简报/ }));
    clickTab("当前任务");
    act(() => { revealNodeWorkspace("brief"); });
    expect(screen.getByRole("region", { name: "制作流程" })).toBeVisible();
    rerender(<RunWorkbench run={{ ...run, revision: 2 }} decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.getByRole("region", { name: "制作流程" })).toBeVisible();
    expect(document.getElementById("node-workspace-brief")).toBeVisible();
  });

  it("falls back to the current task when a refreshed snapshot no longer exposes a film", () => {
    const run = runFixture(true);
    const props = { decisionPending: false, onDecision: vi.fn() };
    const { rerender } = render(<RunWorkbench run={run} {...props} />);
    clickTab("审片");
    rerender(<RunWorkbench run={runFixture()} {...props} />);
    expect(screen.getByRole("button", { name: "当前任务" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "当前步骤产物" })).toBeVisible();
  });

  it("keeps the current creative draft in focus when an older film still exists", () => {
    const run = runFixture(true);
    run.currentNodeId = "creative-planning";
    render(<RunWorkbench run={run} creativeDiscussion={<section aria-label="当前创作稿">正在修改的脚本</section>}
      decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.getByRole("region", { name: "当前创作稿" })).toBeVisible();
    expect(screen.getByTitle("成片预览")).not.toBeVisible();
    clickTab("审片");
    expect(screen.getByTitle("成片预览")).toBeVisible();
    expect(screen.getByText("正在修改的脚本")).not.toBeVisible();
  });

  it("shows the preserved source media during the source review without generating new assets", () => {
    const run = runFixture();
    run.currentNodeId = "asset-source-review";
    run.activeIntervention = { ...run.activeIntervention!, nodeId: "asset-source-review" };
    run.nodes[1] = { ...run.nodes[1]!, status: "succeeded", artifactIds: ["source"] };
    run.nodes.push({ id: "asset-source-review", label: "生成画面预检", status: "needs_human", artifactIds: [],
      qualityGateResults: [], output: { report: { summary: "核对已有画面", findings: [] } } });
    run.artifacts = [{ id: "source", kind: "media_asset", producerNodeId: "assets", scenePosition: 1,
      contentType: "image/jpeg", contentUrl: "/source.jpg", createdAt: run.startedAt }];
    const decide = vi.fn();
    render(<RunWorkbench run={run} decisionPending={false} onDecision={decide} />);
    const current = screen.getByRole("region", { name: "当前步骤产物" });
    expect(within(current).getByRole("img", { name: "镜头 1 画面预览" })).toHaveAttribute("src", "/source.jpg");
    expect(decide).not.toHaveBeenCalled();
  });

  it("offers current files without silently mixing historical versions", () => {
    const run = runFixture(true);
    run.artifacts.push({ ...run.artifacts[0]!, id: "old-film", contentUrl: "/old-film.mp4" });
    run.nodes[2]!.outputState = { generatedVersionId: "v2", effectiveVersionId: "v2", stale: false, versions: [
      { id: "v1", source: "generated", output: {}, inputVersionIds: [], artifactIds: ["old-film"], createdAt: run.startedAt, createdBy: "renderer", schemaVersion: "1" },
      { id: "v2", source: "generated", output: {}, inputVersionIds: [], artifactIds: ["film"], createdAt: run.startedAt, createdBy: "renderer", schemaVersion: "1" },
    ] };
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    clickTab("文案与文件");
    const files = screen.getByRole("region", { name: "文案与文件" });
    expect(within(files).getAllByRole("link")).toHaveLength(1);
    expect(within(files).getByRole("link")).toHaveAttribute("href", "/film.mp4");
  });
});


it("lets accepted generation progress take over the canvas while retaining the prior draft in the DOM", () => {
  const run = runFixture();
  run.status = "running";
  delete run.activeIntervention;
  run.currentNodeId = "creative-planning";
  render(<RunWorkbench run={run} creativeDiscussion={<textarea aria-label="未保存的稿件" defaultValue="我自己的文字" />}
    decisionPending={false} onDecision={vi.fn()} />);
  expect(screen.getByDisplayValue("我自己的文字")).not.toBeVisible();
  expect(screen.getByText("自动制作中")).toBeVisible();
});

it("shows per-scene failures while downloading and resumes a stopped stock task through the retry action", () => {
  const run = runFixture();
  run.status = "running";
  delete run.activeIntervention;
  run.currentNodeId = "assets";
  run.nodes[1] = { ...run.nodes[1]!, status: "running", stockProgress: { phase: "download", totalScenes: 2, updatedAt: run.startedAt,
    scenes: [{ scenePosition: 1, state: "completed", provider: "pexels", candidateCount: 0, failedAttempts: 0 },
      { scenePosition: 2, state: "retrying", provider: "pixabay", candidateCount: 0, failedAttempts: 2 }] } };
  const retry = vi.fn(async () => {});
  const props = { decisionPending: false, onDecision: vi.fn(), onRetryFailedNode: retry };
  const view = render(<RunWorkbench run={run} {...props} />);
  expect(screen.getByText("素材获取 · 已完成 1/2 镜 · 2 次获取失败")).toBeVisible();
  view.rerender(<RunWorkbench run={{ ...run, status: "needs_human", nodes: run.nodes.map(node => node.id === "assets" ? { ...node, status: "needs_human" } : node),
    activeIntervention: { id: "stock-stop", nodeId: "assets", kind: "stock_preparation_retry", reason: "网络未完成，已保留第一镜", options: ["reject"], createdAt: run.startedAt } }} {...props} />);
  expect(screen.queryByRole("region", { name: "当前步骤产物" })).not.toBeInTheDocument();
  expect(screen.queryByText("请查看本次动作说明")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "继续获取素材" }));
  expect(retry).toHaveBeenCalledWith("assets");
  expect(props.onDecision).not.toHaveBeenCalled();
});

// D 批次：每镜一行短原因——停止镜给出「已停止 · 图库 · 具体原因」；
it("explains a stopped scene with its last safe failure reason in one line", () => {
  const run = runFixture();
  run.status = "needs_human";
  run.currentNodeId = "assets";
  run.activeIntervention = { id: "stock-stop", nodeId: "assets", kind: "stock_preparation_retry",
    reason: "网络未完成，已保留第一镜", options: ["reject"], createdAt: run.startedAt };
  run.nodes[1] = { ...run.nodes[1]!, status: "needs_human", stockProgress: { phase: "download", totalScenes: 2, updatedAt: run.startedAt,
    scenes: [
      { scenePosition: 1, state: "completed", provider: "pexels", candidateCount: 0, failedAttempts: 0 },
      { scenePosition: 2, state: "stopped", provider: "pexels", candidateCount: 0, failedAttempts: 1,
        lastFailure: { provider: "pexels", stage: "connect", reason: "timeout" } },
    ] } };
  render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
  const stoppedLine = screen.getByText(/镜头 2/).closest("li");
  expect(stoppedLine).toHaveTextContent("镜头 2 · 已停止 · Pexels 图库 · 连接超时");
  // 停止镜不说“尝试其他候选”；仍在获取的镜才保留该措辞。
  expect(screen.queryByText(/尝试其他候选/)).toBeNull();
});

// R2-06/R2-07（round2）：全部来源失败的镜显示「获取失败」而非冒充完成；
// 超时按真实阶段显示（body→正文读取超时），未知阶段统一「请求超时」。
it("labels an all-sources-failed scene as failed with its stage-specific timeout reason", () => {
  const run = runFixture();
  run.status = "running";
  delete run.activeIntervention;
  run.currentNodeId = "assets";
  run.nodes[1] = { ...run.nodes[1]!, status: "running", stockProgress: { phase: "search", totalScenes: 2, updatedAt: run.startedAt,
    scenes: [
      { scenePosition: 1, state: "completed", provider: "pexels", candidateCount: 3, failedAttempts: 0 },
      { scenePosition: 2, state: "failed", provider: "pixabay", candidateCount: 0, failedAttempts: 2,
        lastFailure: { provider: "pixabay", stage: "body", reason: "timeout" } },
    ] } };
  render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
  const failedLine = screen.getByText(/镜头 2/).closest("li");
  expect(failedLine).toHaveTextContent("镜头 2 · 获取失败 · Pixabay 图库 · 正文读取超时");
  expect(failedLine).not.toHaveTextContent("已完成");
  expect(failedLine).not.toHaveTextContent("连接超时");
});

it("shows a generic request-timeout label when the failing stage is unknown", () => {
  const run = runFixture();
  run.status = "running";
  delete run.activeIntervention;
  run.currentNodeId = "assets";
  run.nodes[1] = { ...run.nodes[1]!, status: "running", stockProgress: { phase: "download", totalScenes: 1, updatedAt: run.startedAt,
    scenes: [{ scenePosition: 1, state: "retrying", provider: "pexels", candidateCount: 0, failedAttempts: 1,
      lastFailure: { provider: "pexels", stage: "unknown", reason: "timeout" } }] } };
  render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
  const retryingLine = screen.getByText(/镜头 1/).closest("li");
  expect(retryingLine).toHaveTextContent("镜头 1 · 获取失败，尝试其他候选 · Pexels 图库 · 请求超时");
  expect(retryingLine).not.toHaveTextContent("连接超时");
});
