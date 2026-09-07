import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import { ProductionStrip } from "../src/client/components/ProductionStrip.js";
import { ExperimentsPage } from "../src/client/pages/ExperimentsPage.js";
import type { StudioRunSummary } from "../src/shared/api.js";

const legacyReview: StudioRunSummary = {
  id: "legacy-review",
  title: "旧版待审制作",
  status: "needs_human",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-09-01T08:00:00.000Z",
  currentNodeId: "final-review",
  nextAction: "review",
  continuation: {
    supported: false,
    reason: "这条制作来自旧版工作流，只能查看现有结果。",
  },
};

afterEach(() => vi.restoreAllMocks());

describe("historical read-only production UI", () => {
  it("does not present a legacy review as the current production", () => {
    render(<MemoryRouter><ProductionStrip runs={[legacyReview]} /></MemoryRouter>);

    expect(screen.queryByLabelText("当前生产")).not.toBeInTheDocument();
    expect(screen.queryByText("旧版待审制作")).not.toBeInTheDocument();
  });

  it("uses a supported run when a legacy review is also present", () => {
    const current: StudioRunSummary = {
      ...legacyReview,
      id: "current-run",
      title: "当前制作",
      status: "running",
      currentNodeId: "script",
      continuation: { supported: true },
    };
    render(<MemoryRouter><ProductionStrip runs={[legacyReview, current]} /></MemoryRouter>);

    expect(screen.getByLabelText("当前生产")).toHaveTextContent("当前制作");
    expect(screen.queryByText("旧版待审制作")).not.toBeInTheDocument();
  });

  it("keeps a historical read-only running run out of the home active count and continue slot", async () => {
    const historicalRunning: StudioRunSummary = {
      ...legacyReview,
      id: "historical-running",
      title: "旧版进行中制作",
      status: "running",
      currentNodeId: "assets",
      continuation: { supported: false, reason: "这条制作来自旧版工作流，只能查看现有结果。" },
    };
    const live: StudioRunSummary = {
      ...legacyReview,
      id: "live-run",
      title: "当前真实制作",
      status: "running",
      currentNodeId: "script",
      continuation: { supported: true },
    };
    vi.spyOn(studioApi, "runs").mockResolvedValue([historicalRunning, live]);

    render(<MemoryRouter><HomePage /></MemoryRouter>);

    // 历史只读 running 不计入“自动制作”，也不把继续工作位让给旧版运行。
    expect(await screen.findByText("当前真实制作")).toBeInTheDocument();
    expect(screen.getByText("自动制作").closest("span")).toHaveTextContent("1");
    expect(screen.queryByText("旧版进行中制作")).not.toBeInTheDocument();
  });

  it("does not count or list a legacy review as waiting for the creator", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([legacyReview]);
    vi.spyOn(studioApi, "templateExperiments").mockResolvedValue([]);

    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);

    const metrics = await screen.findByLabelText("制作统计");
    const reviewMetric = within(metrics).getByText("等你审片").closest("article");
    expect(reviewMetric).not.toBeNull();
    expect(within(reviewMetric!).getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("旧版待审制作")).not.toBeInTheDocument();
  });

  it("does not let test productions change creator learning metrics", async () => {
    const testRun: StudioRunSummary = {
      ...legacyReview,
      id: "test-run",
      title: "云端付费验收",
      status: "rejected",
      currentNodeId: "final-review",
      finalReviewOutcome: "rejected",
      continuation: { supported: true },
      runPurpose: "test",
    };
    vi.spyOn(studioApi, "runs").mockResolvedValue([testRun]);
    vi.spyOn(studioApi, "templateExperiments").mockResolvedValue([]);

    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);

    const metrics = await screen.findByLabelText("制作统计");
    expect(within(metrics).getByText("终审通过率").closest("article")).toHaveTextContent("待样本");
    expect(within(metrics).getByText("已打回返工").closest("article")).toHaveTextContent("0");
    expect(screen.queryByText("云端付费验收")).not.toBeInTheDocument();
  });
});
