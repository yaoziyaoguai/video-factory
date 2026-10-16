import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProductionQueue } from "../src/client/components/ProductionQueue.js";
import type { StudioRunSummary } from "../src/shared/api.js";

const rejectedRun: StudioRunSummary = {
  id: "run-1",
  title: "被打回的作品",
  status: "rejected",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-09-01T08:00:00.000Z",
  currentNodeId: "final-review",
};

function expectTodoCount(value: string): void {
  expect(screen.getByText("待你处理", { selector: ".project-edition span" }).closest("div")).toHaveTextContent(value);
}

describe("ProductionQueue rejected follow-up", () => {
  it("clears an empty combined filter without treating the archive as empty", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ProductionQueue runs={[rejectedRun, { ...rejectedRun, id: "archived", title: "归档作品", archivedAt: "2026-09-02T00:00:00Z" }]} loading={false} onCreate={() => undefined} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "筛选：制作中" }));
    await user.type(screen.getByRole("textbox", { name: "搜索制作记录" }), "不存在的标题");
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("textbox", { name: "搜索制作记录" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "筛选：重点" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(rejectedRun.title)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "归档 1" }));
    await user.type(screen.getByRole("textbox", { name: "搜索制作记录" }), "不存在的标题");
    expect(screen.queryByText("归档还是空的")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("归档作品")).toBeVisible();
    expect(screen.getByRole("button", { name: "归档 1" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a rejected run in the creator to-do with the existing rework path as its CTA", async () => {
    const user = userEvent.setup();
    const newerCompleted = Array.from({ length: 6 }, (_, index) => ({
      ...rejectedRun,
      id: `run-done-${index + 1}`,
      title: `完成品 ${index + 1}`,
      status: "succeeded" as const,
      startedAt: new Date(Date.parse("2026-09-05T08:00:00.000Z") + index * 3_600_000).toISOString(),
    }));
    render(
      <MemoryRouter>
        <ProductionQueue runs={[...newerCompleted, rejectedRun]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expectTodoCount("1");
    const cta = screen.getByRole("link", { name: "调整方案后重新制作：被打回的作品" });
    expect(cta).toHaveAttribute("href", "/projects/run-1");
    expect(screen.getByText("被打回的作品")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "筛选：待你处理" }));
    expect(screen.getByText("被打回的作品")).toBeInTheDocument();
    for (const run of newerCompleted) expect(screen.queryByText(run.title)).not.toBeInTheDocument();
  });

  it("stops counting a rejected run as to-do once the creator archives it", () => {
    const archived = {
      ...rejectedRun,
      id: "run-0",
      title: "已归档的打回作品",
      startedAt: "2026-09-06T08:00:00.000Z",
      archivedAt: "2026-09-06T09:00:00.000Z",
    };
    render(
      <MemoryRouter>
        <ProductionQueue runs={[archived]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expectTodoCount("0");
    expect(screen.queryByRole("link", { name: /调整方案后重新制作/ })).not.toBeInTheDocument();
  });

  it("presents an unsupported legacy review as history instead of a pending review", async () => {
    const user = userEvent.setup();
    const legacyReview: StudioRunSummary = {
      ...rejectedRun,
      status: "needs_human",
      title: "旧版待审记录",
      currentNodeId: "final-review",
      continuation: {
        supported: false,
        reason: "这条制作来自旧版工作流，只能查看现有结果。",
      },
    };
    render(
      <MemoryRouter>
        <ProductionQueue runs={[legacyReview]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expectTodoCount("0");
    expect(screen.getByText("历史只读")).toBeInTheDocument();
    expect(screen.queryByText("等你审片")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前工序：人工终审")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "基于这版重新制作：旧版待审记录" })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.queryByRole("link", { name: /进入审片/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "筛选：待你处理" }));
    expect(screen.queryByText("旧版待审记录")).not.toBeInTheDocument();
  });

  it("does not count an unsupported legacy run as active production", async () => {
    const user = userEvent.setup();
    const legacyRunning: StudioRunSummary = {
      ...rejectedRun,
      status: "running",
      title: "旧版进行中记录",
      currentNodeId: "script",
      continuation: {
        supported: false,
        reason: "这条制作来自旧版工作流，只能查看现有结果。",
      },
    };
    render(
      <MemoryRouter>
        <ProductionQueue runs={[legacyRunning]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expect(screen.getByText("制作中", { selector: ".project-edition span" }).closest("div")).toHaveTextContent("0");
    expect(screen.queryByLabelText("当前工序：脚本")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "筛选：制作中" }));
    expect(screen.queryByText("旧版进行中记录")).not.toBeInTheDocument();
  });

  it("labels an explicitly tagged test run without hiding its operational state", () => {
    render(
      <MemoryRouter>
        <ProductionQueue runs={[{ ...rejectedRun, runPurpose: "test" }]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/测试记录 · 抖音 · 9:16/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "调整方案后重新制作：被打回的作品" })).toBeInTheDocument();
  });
});
