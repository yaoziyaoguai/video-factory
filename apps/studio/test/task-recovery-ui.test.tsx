import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import type { StudioRunDetail } from "../src/shared/api.js";

function failedRun(taskState: NonNullable<StudioRunDetail["taskRecovery"]>["taskState"]): StudioRunDetail {
  return {
    id: "run-recovery",
    title: "恢复测试",
    status: "failed",
    platform: "douyin",
    durationSeconds: 30,
    startedAt: "2026-09-12T10:00:00.000Z",
    finishedAt: "2026-09-12T10:01:00.000Z",
    currentNodeId: "script",
    revision: 4,
    angle: "原任务恢复",
    audience: "创作者",
    nicheSlug: "recovery",
    reviewMode: "manual",
    nodes: [{ id: "script", label: "脚本", status: "failed", artifactIds: [], qualityGateResults: [] }],
    artifacts: [],
    decisions: [],
    failure: {
      nodeId: "script",
      nodeLabel: "脚本",
      category: "infrastructure",
      summary: "模型任务结果未知",
      impact: "前序成果已保留",
      retryable: true,
      recoveryActions: ["查询原任务"],
      savedNodeCount: 1,
    },
    resultAvailability: { kind: "none", usable: false, label: "前序结果已保留", detail: "等待原任务" },
    taskRecovery: {
      nodeId: "script",
      phase: "produce",
      taskState,
      summary: taskState === "completed_success"
        ? "已找到之前任务的结果，无需重新生成。"
        : "暂时无法确认这次任务的结果。系统没有重新提交，请先查询原任务。",
      resultAvailable: taskState === "completed_success",
      allowedActions: taskState === "completed_success"
        ? ["query_original_task", "retrieve_and_continue"]
        : taskState === "completed_failure"
          ? ["query_original_task", "retry_failed_step", "adjust_plan"]
          : ["query_original_task"],
      ...(taskState === "running" ? {
        lastVerifiedAt: "2026-09-12T10:00:00.000Z",
        lastAttemptAt: "2026-09-12T10:05:00.000Z",
        observationError: "本次查询没有取得新状态；原任务的上一次可信状态已保留，请稍后再查。",
      } : {}),
      ...(taskState === "completed_failure" ? { terminalError: "模型服务暂时不可用，请稍后重试。" } : {}),
    },
  };
}

function runningRun(): StudioRunDetail {
  const run = failedRun("running");
  const { finishedAt: _finishedAt, failure: _failure, ...activeRun } = run;
  return {
    ...activeRun,
    status: "running",
    nodes: run.nodes.map((node) => ({ ...node, status: "running" })),
  };
}

describe("text task recovery UI", () => {
  it("keeps a paused local run distinct from an accepted unknown original task", () => {
    const run = { ...failedRun("accepted_unknown"), status: "paused" as const };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const panel = screen.getByRole("status", { name: "原模型任务恢复" });
    expect(panel).toHaveTextContent("本地流程已暂停");
    expect(panel).toHaveTextContent("原任务状态以最近一次核对结果为准");
    expect(panel).not.toHaveTextContent("原任务已取消");
  });

  it("shows the server-authorized query while the run is still active", async () => {
    const query = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench
      run={runningRun()}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={query}
    /></MemoryRouter>);

    expect(screen.getByRole("status", { name: "原模型任务恢复" })).toHaveTextContent("本地流程仍在运行");
    expect(screen.getByRole("status", { name: "原模型任务恢复" })).not.toHaveTextContent("本地流程已停止等待");
    await userEvent.click(screen.getByRole("button", { name: "查询原任务" }));
    expect(query).toHaveBeenCalledOnce();
  });

  it("offers only original-task observation while the result is unknown", async () => {
    const query = vi.fn(async () => undefined);
    const retry = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench
      run={failedRun("accepted_unknown")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={query}
      onRetryFailedNode={retry}
    /></MemoryRouter>);

    expect(screen.getByRole("status", { name: "原模型任务恢复" })).toHaveTextContent("本地流程已停止等待");
    await userEvent.click(screen.getByRole("button", { name: "查询原任务" }));
    expect(query).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取回结果并继续" })).not.toBeInTheDocument();
  });

  it("offers one explicit consume action after the original result is verified", async () => {
    const retrieve = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench
      run={failedRun("completed_success")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
      onRetrieveOriginalTextTask={retrieve}
    /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "取回结果并继续" }));
    expect(retrieve).toHaveBeenCalledOnce();
    expect(screen.getByText("原任务结果可以取回")).toBeVisible();
  });

  it("shows the last verified time separately from the latest failed query", () => {
    render(<MemoryRouter><RunWorkbench
      run={failedRun("running")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
    /></MemoryRouter>);

    expect(screen.getByText(/上次确认：/)).toBeVisible();
    expect(screen.getByText(/本次查询没有取得新状态/)).toBeVisible();
  });

  it("exposes working retry and adjust actions after a terminal transient failure", async () => {
    const retry = vi.fn(async () => undefined);
    const adjust = vi.fn();
    render(<MemoryRouter><RunWorkbench
      run={failedRun("completed_failure")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
      onRetryFailedNode={retry}
      onRestart={adjust}
    /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "重试失败步骤" }));
    await userEvent.click(screen.getByRole("button", { name: "调整方案后重新制作" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(adjust).toHaveBeenCalledOnce();
    expect(screen.getByText(/原任务失败原因/)).toBeVisible();
  });

  it("explains local stop and original-task state as two separate dimensions and queries first", () => {
    render(<MemoryRouter><RunWorkbench
      run={failedRun("running")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
    /></MemoryRouter>);

    const panel = screen.getByRole("status", { name: "原模型任务恢复" });
    // 两个维度分开说清：本地停在哪、远端任务处于什么状态。
    expect(within(panel).getByText(/本地流程已停止/)).toBeVisible();
    expect(within(panel).getByText(/不会重复提交/)).toBeVisible();
    // 唯一推荐动作是查询原任务，它是面板里第一个按钮。
    const firstButton = within(panel).getAllByRole("button")[0]!;
    expect(firstButton).toHaveTextContent("查询原任务");
    // 不能暗示远端已经取消。
    expect(screen.queryByText(/已取消/)).not.toBeInTheDocument();
  });

  it("concentrates local retry and adjust actions in the recovery panel without duplicates", () => {
    render(<MemoryRouter><RunWorkbench
      run={failedRun("completed_failure")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
      onRetryFailedNode={async () => undefined}
      onRestart={() => undefined}
    /></MemoryRouter>);

    const panel = screen.getByRole("status", { name: "原模型任务恢复" });
    // 本地动作迁移进恢复面板，和原任务动作集中在一处。
    expect(within(panel).getByRole("button", { name: "重试失败步骤" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: "调整方案后重新制作" })).toBeVisible();
    // 同一命令全页只允许出现一次。
    expect(screen.getAllByRole("button", { name: "重试失败步骤" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "调整方案后重新制作" })).toHaveLength(1);
  });

  it("does not offer retry or restart while the original outcome is unknown", () => {
    render(<MemoryRouter><RunWorkbench
      run={failedRun("accepted_unknown")}
      decisionPending={false}
      onDecision={async () => undefined}
      onQueryOriginalTextTask={async () => undefined}
      onRetryFailedNode={async () => undefined}
      onRestart={() => undefined}
    /></MemoryRouter>);

    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整方案后重新制作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "基于这版重新制作" })).not.toBeInTheDocument();
  });
});
