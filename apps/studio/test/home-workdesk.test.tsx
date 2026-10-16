import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import type { StudioRunSummary } from "../src/shared/api.js";

afterEach(() => vi.restoreAllMocks());

const baseRun: StudioRunSummary = {
  id: "current", title: "制作中的作品", status: "needs_human", nextAction: "review",
  currentNodeId: "creative-planning", platform: "douyin", durationSeconds: 24, startedAt: "2026-10-14T08:00:00.000Z",
};

describe("home workdesk heading and states", () => {
  it("keeps creator-action priority over historical and running records and uses real recent runs", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([
      { ...baseRun, id: "legacy", title: "旧版正在运行的记录", status: "running", continuation: { supported: false } },
      { ...baseRun, id: "automatic", title: "正在制作的另一条", status: "running" },
      { ...baseRun, id: "failed", title: "需要恢复的作品", status: "failed" },
      { ...baseRun, id: "archived", title: "归档的旧作品", status: "succeeded", archivedAt: "2026-10-14T09:00:00.000Z" },
      { ...baseRun, id: "recent", title: "昨天完成的作品", status: "succeeded", startedAt: "2026-10-13T08:00:00.000Z" },
    ]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    const current = await screen.findByRole("region", { name: "需要恢复的作品" });
    expect(within(current).getByRole("link")).toHaveAttribute("href", "/projects/failed");
    expect(within(current).getByText("目标 24 秒")).toBeVisible();
    expect(within(current).getByText("尚无成片")).toBeVisible();
    expect(within(current).getByText("工作室光圈 · 装饰")).toBeVisible();
    expect(current.querySelector("video, img")).toBeNull();
    const recent = screen.getByRole("region", { name: "留在工作台上的" });
    expect(screen.queryByText("旧版正在运行的记录")).not.toBeInTheDocument();
    expect(within(recent).getByRole("link", { name: /正在制作的另一条/ })).toHaveAttribute("href", "/projects/automatic");
    expect(within(recent).getByRole("link", { name: /昨天完成的作品/ })).toHaveAttribute("href", "/projects/recent");
    expect(within(recent).queryByText("归档的旧作品")).not.toBeInTheDocument();
  });

  it("shows a video load failure and retries while retaining the actual review action", async () => {
    const user = userEvent.setup();
    const videoRun = { ...baseRun, title: "等待终审的作品", currentNodeId: "final-review", videoContentUrl: "/api/runs/current/artifacts/video/content" };
    vi.spyOn(studioApi, "runs").mockResolvedValue([videoRun]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    const work = await screen.findByRole("region", { name: videoRun.title });
    const video = within(work).getByLabelText(`${videoRun.title} 预览`);
    fireEvent.error(video);
    expect(within(work).getByRole("status")).toHaveTextContent("视频暂时未能加载");
    expect(within(work).getByRole("link", { name: "进入审片" })).toHaveAttribute("href", "/projects/current");
    expect(work.querySelector("img")).toBeNull();
    await user.click(within(work).getByRole("button", { name: "重新加载预览" }));
    expect(within(work).getByLabelText(`${videoRun.title} 预览`)).toHaveAttribute("src", `${videoRun.videoContentUrl}#t=0.1`);
  });

  it("keeps unknown steps neutral and never claims that an invalidated approval is still valid", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...baseRun, status: "approval_invalidated", nextAction: "confirm_spend", currentNodeId: "unrecognized-step" }]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    const work = await screen.findByRole("region", { name: baseRun.title });
    expect(within(work).getByText("当前步骤")).toBeVisible();
    expect(within(work).getByText("费用确认已失效")).toBeVisible();
    expect(within(work).getByText(/之前的费用确认已失效/)).toBeVisible();
    expect(within(work).getByRole("link", { name: "确认费用" })).toHaveAttribute("href", "/projects/current");
  });
  it("keeps four creation choices readable without presenting them as numbered steps", () => {
    vi.spyOn(studioApi, "runs").mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    const entries = screen.getByRole("region", { name: "你今天从哪里出发？" });
    const buttons = within(entries).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    expect(within(entries).queryByText(/^(01|02|03|04)$/)).not.toBeInTheDocument();
    expect(buttons[0]).toHaveAccessibleName("热点选题 从热点开始");
    expect(buttons[1]).toHaveAccessibleName("系列策划 继续一个系列");
    expect(buttons[2]).toHaveAccessibleName("我的想法 从自己的想法开始");
    expect(buttons[3]).toHaveAccessibleName("参考案例 从案例 / 脚本开始");
    expect(buttons[0]).toHaveAccessibleDescription(/发现值得创作的热点，\s*把握当下的讨论与情绪。/);
  });

  it("does not turn unread counts into zero and shows zero only after an empty result", async () => {
    let resolveRuns: (runs: StudioRunSummary[]) => void = () => undefined;
    vi.spyOn(studioApi, "runs").mockReturnValue(new Promise((resolve) => { resolveRuns = resolve; }));
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    expect(screen.getByRole("status")).toHaveTextContent("正在读取你的作品");
    expect(screen.queryByRole("region", { name: "制作概况" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "你今天从哪里出发？" })).not.toHaveClass("is-new-workspace");
    resolveRuns([]);

    const overview = await screen.findByRole("region", { name: "制作概况" });
    for (const label of ["待你处理", "自动制作", "已完成", "已归档"]) {
      expect(within(overview).getByText(label).closest("span")).toHaveTextContent(`${label}0`);
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("继续上次工作")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "你今天从哪里出发？" })).toHaveClass("is-new-workspace");
  });

  it("keeps the connection failure and retry without inventing production counts", async () => {
    const user = userEvent.setup();
    const runs = vi.spyOn(studioApi, "runs").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent("创作台暂时没有连接到制作服务");
    expect(screen.queryByRole("region", { name: "制作概况" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /从自己的想法开始/ })).toBeEnabled();
    expect(screen.getByRole("region", { name: "你今天从哪里出发？" })).not.toHaveClass("is-new-workspace");
    await user.click(screen.getByRole("button", { name: "重新连接" }));
    expect(await screen.findByRole("region", { name: "制作概况" })).toHaveTextContent("待你处理0");
    expect(runs).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a complete title and real destination without deriving identity from its text", async () => {
    const run: StudioRunSummary = {
      id: "actual-project-id",
      title: "云端复测｜不按分隔符拆分标题：一段很长的中文作品名称与第二部分",
      status: "awaiting_spend_approval",
      nextAction: "confirm_spend",
      currentNodeId: "assets",
      platform: "douyin",
      durationSeconds: 24,
      startedAt: "2026-10-13T08:00:00.000Z",
    };
    vi.spyOn(studioApi, "runs").mockResolvedValue([run]);
    const { container } = render(<MemoryRouter><HomePage /></MemoryRouter>);

    const work = await screen.findByRole("region", { name: run.title });
    expect(within(work).getByRole("heading", { name: run.title })).toHaveTextContent(run.title);
    expect(within(work).getByRole("link", { name: "确认费用" })).toHaveAttribute("href", "/projects/actual-project-id");
    expect(within(work).getByText("下一步会产生费用，正在等你检查前面的内容。")).toBeVisible();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("region", { name: "你今天从哪里出发？" })).not.toHaveClass("is-new-workspace");
  });
});
