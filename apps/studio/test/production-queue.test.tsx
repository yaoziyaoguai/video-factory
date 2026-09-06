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
});
