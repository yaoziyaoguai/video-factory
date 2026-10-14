import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import type { StudioRunSummary } from "../src/shared/api.js";

afterEach(() => vi.restoreAllMocks());

describe("home workdesk heading and states", () => {
  it("keeps numbered creation entries readable without adding decorative numbers to their spoken names", () => {
    vi.spyOn(studioApi, "runs").mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    const entries = screen.getByRole("region", { name: "你今天从哪里出发？" });
    const buttons = within(entries).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const [index, button] of buttons.entries()) {
      expect(within(button).getByText(String(index + 1).padStart(2, "0"))).toHaveAttribute("aria-hidden", "true");
    }
    expect(buttons[0]).toHaveAccessibleName("从热点开始发现值得讲的当下话题");
    expect(buttons[1]).toHaveAccessibleName("继续一个系列延续栏目，创作下一集");
    expect(buttons[2]).toHaveAccessibleName("从自己的想法开始写下主题，加入你的参考");
    expect(buttons[3]).toHaveAccessibleName("从案例 / 脚本开始借鉴好作品，写自己的版本");
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
