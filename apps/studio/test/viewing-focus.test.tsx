import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import type { StudioRunDetail } from "../src/shared/api.js";

function filmRun(): StudioRunDetail {
  return {
    id: "run-viewing",
    title: "成片观看测试",
    status: "needs_human",
    platform: "douyin",
    durationSeconds: 30,
    startedAt: "2026-10-03T00:00:00.000Z",
    currentNodeId: "final-review",
    revision: 4,
    angle: "窗边观察",
    audience: "创作者",
    nicheSlug: "viewing",
    reviewMode: "manual",
    nodes: [],
    artifacts: [{ id: "film-current", kind: "render", contentUrl: "/media/current.mp4", contentType: "video/mp4",
      createdAt: "2026-10-03T00:00:00.000Z", producerNodeId: "render" }],
    videoArtifactId: "film-current",
    decisions: [],
    activeIntervention: { id: "final-stop", nodeId: "final-review", reason: "请审看当前成片", options: ["approve", "reject"],
      createdAt: "2026-10-03T00:00:00.000Z" },
    optionalReviewTasks: [{ nodeId: "visual-review", purpose: "audio_review", operationId: "original-audio",
      targetVersionId: "render-current", requestState: "unknown", resultState: "absent", summary: "原声音审片结果仍待核。" }],
  };
}

describe("focused film viewing", () => {
  it.each([true, false])("toggles the viewing layout from the keyboard without replacing or controlling the media (paused=%s)", async (paused) => {
    const user = userEvent.setup();
    const decide = vi.fn(async () => undefined);
    const query = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={decide}
      onQueryOriginalTextTask={query} /></MemoryRouter>);
    const video = screen.getByTitle("成片预览") as HTMLVideoElement;
    video.currentTime = 8.25;
    Object.defineProperty(video, "paused", { configurable: true, value: paused });
    const seek = vi.spyOn(video, "currentTime", "set");
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    const load = vi.spyOn(video, "load").mockImplementation(() => undefined);
    const toggle = screen.getByRole("button", { name: "专注观看" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName("退出专注观看");
    expect(screen.getByRole("main")).toHaveClass("is-viewing-focused");
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(video.currentTime).toBe(8.25);
    expect(video.paused).toBe(paused);
    expect(video).toHaveAttribute("controls");
    expect(video).not.toHaveAttribute("autoplay");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("main")).not.toHaveClass("is-viewing-focused");
    expect(screen.getByTitle("成片预览")).toBe(video);
    expect(video.currentTime).toBe(8.25);
    expect(video.paused).toBe(paused);
    expect(seek).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("exits on Escape from another control and returns keyboard focus to the viewing toggle", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={vi.fn()} /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: "专注观看" });
    await user.click(toggle);
    const download = screen.getByRole("link", { name: "下载成片" });
    download.focus();
    expect(download).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveClass("is-viewing-focused");
  });

  it("lets the open decision dialog consume Escape before leaving focused viewing", async () => {
    const user = userEvent.setup();
    const decide = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={decide} /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: "专注观看" });
    await user.click(toggle);
    const stop = screen.getByRole("button", { name: "终止制作" });
    await user.click(stop);
    expect(screen.getByRole("dialog", { name: "终止这条视频的制作" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(stop).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["run", "artifact", "source", "missing"] as const)("clears viewing mode when the %s identity changes without moving focus", async (change) => {
    const user = userEvent.setup();
    const run = filmRun();
    const props = { decisionPending: false, onDecision: vi.fn() };
    const { rerender } = render(<MemoryRouter><RunWorkbench run={run} {...props} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    const workspaceLink = screen.getByRole("link", { name: "当前步骤与产物" });
    workspaceLink.focus();
    rerender(<MemoryRouter><RunWorkbench run={{ ...run, revision: 5 }} {...props} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "退出专注观看" })).toHaveAttribute("aria-pressed", "true");
    const nextRun: StudioRunDetail = change === "run" ? { ...run, id: "another-run" }
      : change === "artifact" ? { ...run, videoArtifactId: "another-film", artifacts: run.artifacts.map(artifact => ({ ...artifact, id: "another-film" })) }
      : change === "source" ? { ...run, artifacts: run.artifacts.map(artifact => ({ ...artifact, contentUrl: "/media/replaced.mp4" })) }
      : { ...run, artifacts: [] };
    rerender(<MemoryRouter><RunWorkbench run={nextRun} {...props} /></MemoryRouter>);
    expect(screen.getByRole("main")).not.toHaveClass("is-viewing-focused");
    expect(workspaceLink).toHaveFocus();
    if (change === "missing") expect(screen.queryByRole("button", { name: /专注观看/ })).not.toBeInTheDocument();
    else expect(screen.getByRole("button", { name: "专注观看" })).toHaveAttribute("aria-pressed", "false");
    rerender(<MemoryRouter><RunWorkbench run={run} {...props} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "专注观看" })).toHaveAttribute("aria-pressed", "false");
    expect(workspaceLink).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(workspaceLink).toHaveFocus();
  });

  it("keeps focused viewing and dialog focus when a pending decision blocks Escape", async () => {
    const user = userEvent.setup();
    const run = filmRun();
    const decide = vi.fn();
    const { rerender } = render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    await user.click(screen.getByRole("button", { name: "终止制作" }));
    const reason = screen.getByRole("textbox", { name: "终止原因" });
    await user.type(reason, "保留这段草稿");
    rerender(<MemoryRouter><RunWorkbench run={run} decisionPending onDecision={decide} /></MemoryRouter>);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "终止这条视频的制作" })).toBeVisible();
    expect(reason).toHaveFocus();
    expect(reason).toHaveValue("保留这段草稿");
    expect(screen.getByRole("button", { name: "退出专注观看" })).toHaveAttribute("aria-pressed", "true");
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps unknown review costs, explicit decisions, original queries and downloads reachable while media is loading", async () => {
    const user = userEvent.setup();
    const query = vi.fn(async () => undefined);
    const decide = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={decide}
      onQueryOriginalTextTask={query} /></MemoryRouter>);
    const video = screen.getByTitle("成片预览") as HTMLVideoElement;
    expect(video.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    expect(video.closest(".video-frame")).not.toHaveClass("film-reveal-active");
    expect(screen.getByText("1 项原审计的结果与费用待核；费用未核实不表示免费。")).toBeVisible();
    expect(screen.getByRole("status", { name: "机器审片状态" })).toHaveTextContent("机器视觉审片尚无完整结论");
    expect(screen.getByRole("button", { name: "批准进入发布包" })).toBeVisible();
    expect(screen.getByRole("button", { name: "终止制作" })).toBeVisible();
    expect(screen.getByRole("link", { name: "下载成片" })).toHaveAttribute("href", "/media/current.mp4");
    await user.click(screen.getByRole("link", { name: "查看原请求与查询" }));
    const original = screen.getByRole("region", { name: "原审计与费用待核" });
    expect(original).toHaveFocus();
    expect(original).toBeVisible();
    expect(query).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    await user.click(within(original).getByRole("button", { name: "查询原声音审片" }));
    expect(query).toHaveBeenCalledExactlyOnceWith({ nodeId: "visual-review", purpose: "audio_review", operationId: "original-audio" });
    expect(screen.getByRole("button", { name: "退出专注观看" })).toHaveAttribute("aria-pressed", "true");
    expect(decide).not.toHaveBeenCalled();
  });

  it("preserves the current verified subtitle track through viewing mode changes", async () => {
    const user = userEvent.setup();
    const { activeIntervention: _stop, ...base } = filmRun();
    const run: StudioRunDetail = { ...base, status: "succeeded",
      artifacts: [...base.artifacts, { id: "subtitle-current", kind: "narration_vtt", contentUrl: "/media/current.vtt",
        contentType: "text/vtt", sha256: "subtitle-sha", createdAt: base.startedAt, producerNodeId: "voice" }],
      nodes: [
        { id: "voice", label: "配音", status: "succeeded", artifactIds: ["subtitle-current"], qualityGateResults: [],
          outputState: { generatedVersionId: "voice-current", effectiveVersionId: "voice-current", stale: false,
            versions: [{ id: "voice-current", source: "generated", artifactIds: ["subtitle-current"], inputVersionIds: [],
              createdAt: base.startedAt, createdBy: "fixture", schemaVersion: "voice/v1" }] } },
        { id: "render", label: "渲染", status: "succeeded", artifactIds: ["film-current"], qualityGateResults: [],
          outputState: { generatedVersionId: "render-current", effectiveVersionId: "render-current", stale: false,
            versions: [{ id: "render-current", source: "generated", artifactIds: ["film-current"], inputVersionIds: ["voice-current"],
              createdAt: base.startedAt, createdBy: "fixture", schemaVersion: "render/v1",
              output: { subtitleStatus: "verified", subtitleBurnStatus: "not_burned", subtitleVttSha256: "subtitle-sha" } }] } },
      ],
    };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} /></MemoryRouter>);
    const video = screen.getByTitle("成片预览");
    const track = video.querySelector("track");
    expect(track).toHaveAttribute("src", "/media/current.vtt");
    expect(track).toHaveAttribute("label", "同步字幕");
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    expect(screen.getByTitle("成片预览").querySelector("track")).toBe(track);
    await user.keyboard("{Escape}");
    expect(screen.getByTitle("成片预览").querySelector("track")).toBe(track);
  });

  it("cleans up focused viewing on departure without retaining an Escape handler or restoring focus", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={vi.fn()} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "专注观看" }));
    rerender(<MemoryRouter><button type="button">另一个页面</button></MemoryRouter>);
    const otherPage = screen.getByRole("button", { name: "另一个页面" });
    otherPage.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    otherPage.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(otherPage).toHaveFocus();
    rerender(<MemoryRouter><RunWorkbench run={filmRun()} decisionPending={false} onDecision={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "专注观看" })).toHaveAttribute("aria-pressed", "false");
  });
});

// DG-UX-06（新前端 Dogfood 修复执行包 R6）：下载名包含作品标题与真实产物身份。
// <安全标题>__<artifact.id>.mp4；完整文件名 UTF-8 ≤240 字节且不截半个码点；
// 同标题不同产物名不同；非法产物身份不给可点击下载。

describe("download filename (DG-UX-06)", () => {
  it("names the download after the work title and the real artifact identity", () => {
    const decide = vi.fn(async () => undefined);
    const run = { ...filmRun(), title: "窗边三分钟：找回注意力" };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "下载成片" })).toHaveAttribute("download", "窗边三分钟：找回注意力__film-current.mp4");
  });

  it("offers no clickable download when the artifact identity cannot be verified", () => {
    const decide = vi.fn(async () => undefined);
    const run = { ...filmRun(), videoArtifactId: "../not-an-artifact" as string, artifacts: [{ id: "../not-an-artifact", kind: "render" as const, contentUrl: "/media/current.mp4", contentType: "video/mp4", createdAt: "2026-10-03T00:00:00.000Z", producerNodeId: "render" }] };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "下载成片" })).toBeNull();
    expect(screen.getByTitle(/产物身份不可核对/)).toBeInTheDocument();
  });
});
