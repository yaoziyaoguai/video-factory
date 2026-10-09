import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import type { StudioDecisionInput, StudioRunDetail } from "../src/shared/api.js";

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
  it("does not label an unregistered audit request as unaccepted or offer an unusable query", () => {
    const { taskRecovery: _recovery, failure: _failure, ...base } = failedRun("accepted_unknown");
    const query = vi.fn();
    const run: StudioRunDetail = { ...base, status: "needs_human", optionalReviewTasks: [{
      nodeId: "creative-planning", purpose: "creative_audit", operationId: "audit-without-request",
      targetVersionId: "script-A", requestState: "not_submitted", resultState: "absent", summary: "原操作事实保留。",
    }] };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} onQueryOriginalTextTask={query} /></MemoryRouter>);
    const original = screen.getByRole("region", { name: "原审计与费用待核" });
    expect(within(original).getByText(/未登记可查询的原请求/)).toBeVisible();
    expect(original).toHaveTextContent("不代表没有发生调用或费用");
    expect(within(original).queryByText(/未提交或未受理/)).toBeNull();
    expect(within(original).queryByRole("button", { name: "查询原文字审计" })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("downloads only the adopted publish package without publishing or approving a draft", () => {
    const { taskRecovery: _recovery, failure: _failure, ...base } = failedRun("completed_failure");
    const decide = vi.fn();
    const publish = vi.fn();
    const run: StudioRunDetail = { ...base, status: "succeeded", publishPackageArtifactId: "package-current",
      artifacts: [
        { id: "package-current", kind: "publish_package", contentType: "application/json", contentUrl: "/api/current-package", createdAt: base.startedAt },
        { id: "package-old", kind: "publish_package", contentType: "application/json", contentUrl: "/api/old-package", createdAt: base.startedAt },
      ] };
    const props = { decisionPending: false, onDecision: decide, onOpenPublish: publish };
    const { rerender } = render(<MemoryRouter><RunWorkbench run={run} {...props} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "下载发布包" })).toHaveAttribute("href", "/api/current-package");
    expect(screen.getByRole("link", { name: "下载发布包" })).toHaveAttribute("download", "恢复测试__package-current.json");
    expect(publish).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    for (const changed of [
      { ...run, status: "needs_human" as const },
      { ...run, publishPackageArtifactId: "missing" },
      { ...run, artifacts: run.artifacts.map(a => ({ ...a, kind: "script" })) },
      { ...run, publishPackageArtifactId: "../invalid", artifacts: [{ ...run.artifacts[0]!, id: "../invalid" }] },
    ]) {
      rerender(<MemoryRouter><RunWorkbench run={changed} {...props} /></MemoryRouter>);
      expect(screen.queryByRole("link", { name: "下载发布包" })).toBeNull();
    }
  });

  it("puts the playable film before original-review details while keeping uncertainty and queries visible", async () => {
    const { taskRecovery: _taskRecovery, failure: _failure, ...base } = failedRun("accepted_unknown");
    const query = vi.fn(async () => undefined);
    const decide = vi.fn(async () => undefined);
    const run: StudioRunDetail = { ...base, status: "succeeded", videoArtifactId: "film-current",
      artifacts: [{ id: "film-current", kind: "render", contentUrl: "/media/film.mp4", contentType: "video/mp4",
        createdAt: "2026-10-02T00:00:00Z", producerNodeId: "render" }],
      optionalReviewTasks: [{ nodeId: "visual-review", purpose: "audio_review", operationId: "original-audio",
        requestId: "original-audio-request", targetVersionId: "render-current", requestState: "unknown", resultState: "absent", summary: "原声音审片结果仍待核。" }],
    };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} onQueryOriginalTextTask={query} /></MemoryRouter>);
    const film = screen.getByRole("region", { name: "成片预览" });
    const original = screen.getByRole("region", { name: "原审计与费用待核" });
    expect(film.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("1 项原审计的结果与费用待核；费用未核实不表示免费。" )).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "查看原请求与查询" }));
    expect(original).toHaveFocus();
    expect(query).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    await userEvent.click(within(original).getByRole("button", { name: "查询原声音审片" }));
    expect(query).toHaveBeenCalledWith({ nodeId: "visual-review", purpose: "audio_review", operationId: "original-audio" });
  });

  it("keeps recorded and unknown fees visible with details collapsed and reachable from the workspace link", async () => {
    const run = failedRun("completed_failure");
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()}
      costDetail={{ runId: run.id, title: run.title, lines: [], totals: {
        estimatedCostCny: 4, authorizedCostCny: 4, actualCostCny: 1.25, actualPendingCount: 2,
        meteredCalls: 1, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0,
      } }} /></MemoryRouter>);
    const summary = screen.getByText("本片调用与费用").closest("summary")!;
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveTextContent("已记录 ¥1.25");
    expect(summary).toHaveTextContent("2 笔待确认是否扣费");
    expect(screen.getByRole("heading", { name: "调用与费用明细" })).not.toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "调用与费用" }));
    expect(details).toHaveAttribute("open");
    expect(summary).toHaveFocus();
    expect(screen.getByRole("heading", { name: "调用与费用明细" })).toBeVisible();
    await userEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
  });

  it.each([true, false])("prioritizes preservation over retry only when restoration is available (taskRecovery=%s)", async (taskRecovery) => {
    const base = failedRun("completed_failure");
    if (!taskRecovery) delete base.taskRecovery;
    const target = { nodeId: "creative-planning" as const, stage: "script" as const,
      targetArtifactId: "draft-A", targetVersionId: "version-A", targetSha256: "a".repeat(64) };
    const retry = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => undefined);
    const props = { decisionPending: false, onDecision: vi.fn(), onRetryFailedNode: retry, onPrepareReviewContinuation: prepare };
    const { rerender } = render(<MemoryRouter><RunWorkbench run={{ ...base, reviewContinuationTargets: [target] }} {...props} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "恢复当前稿，继续处理" })).toHaveClass("button-primary");
    expect(screen.getByRole("button", { name: "重试失败步骤" })).toHaveClass("button-secondary");
    expect(screen.getByRole("button", { name: "重试失败步骤" })).not.toHaveClass("button-primary");
    await userEvent.click(screen.getByRole("button", { name: "重试失败步骤" }));
    expect(retry).toHaveBeenCalledWith("script");
    expect(prepare).not.toHaveBeenCalled();
    rerender(<MemoryRouter><RunWorkbench run={base} {...props} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "重试失败步骤" })).toHaveClass("button-primary");
  });

  it.each([true, false])("separates completed delivery from optional review and external publication (approved=%s)", (approved) => {
    const { taskRecovery: _taskRecovery, failure: _failure, ...base } = failedRun("completed_failure");
    const run: StudioRunDetail = { ...base, status: "succeeded",
      nodes: [{ id: "visual-review", label: "视觉审片", status: "succeeded", outcomeUncertain: true, artifactIds: [], qualityGateResults: [] }],
      ...(approved ? { finalReviewOutcome: "approved" as const } : {}), videoArtifactId: "film",
      artifacts: [{ id: "film", kind: "render", producerNodeId: "render", createdAt: base.startedAt,
        contentType: "video/mp4", contentUrl: "/api/film" }] };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()}
      paidNodeSummary={{ nodeId: "visual-review", requiresManualReconciliation: true, failureKind: "unknown_outcome", items: [] }} /></MemoryRouter>);
    const review = screen.getByRole("status", { name: "机器审片状态" });
    expect(review).toHaveTextContent("机器视觉审片尚无完整结论");
    expect(review).not.toHaveTextContent("正式发布已通过");
    expect(review).not.toHaveTextContent("可播放首版");
    if (approved) expect(review).toHaveTextContent("人工终审已确认");
    else expect(review).not.toHaveTextContent("人工终审已确认");
    expect(screen.getByText(/制作已完成，发布包可以下载使用/)).toHaveTextContent("外部平台发布仍需你自行操作");
    expect(screen.getByRole("link", { name: "下载成片" })).toHaveAttribute("href", "/api/film");
    const fee = screen.getByRole("region", { name: "付费任务证据" });
    expect(fee).not.toHaveTextContent("系统已经停住");
    expect(fee).toHaveTextContent("原请求不会自动重试或重新提交");
    expect(fee).toHaveTextContent("这次请求是否扣费还不确定");
  });

  for (const [safe, uncertainNodeId] of [[true, "visual-review"], [undefined, "visual-review"], [undefined, "voice"]] as const) {
    it(`allows local draft editing only with the host optional-review safety fact (${safe}/${uncertainNodeId})`, async () => {
      const { taskRecovery: _taskRecovery, failure: _failure, ...base } = failedRun("accepted_unknown");
      const run: StudioRunDetail = { ...base, status: "needs_human", currentNodeId: "final-review",
        ...(safe ? { optionalReviewUncertaintySafe: true as const } : {}),
        nodes: [{ id: "brief", label: "内容简报", status: "succeeded", artifactIds: [], qualityGateResults: [],
          output: { title: "保留的简报", angle: "窗边观察", audience: "创作者", durationSeconds: 20, platform: "douyin" } },
        { id: uncertainNodeId, label: "待核原请求", status: "succeeded", outcomeUncertain: true, artifactIds: [], qualityGateResults: [] }],
      };
      const override = vi.fn(async () => undefined);
      const decide = vi.fn(async () => undefined);
      render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} onOverrideNode={override} /></MemoryRouter>);
      const brief = document.getElementById("node-workspace-brief")!;
      await userEvent.click(brief.querySelector(":scope > summary")!);
      if (safe) {
        await userEvent.click(within(brief).getByRole("button", { name: "编辑交付" }));
        expect(within(brief).getByRole("button", { name: "保存为人工版本" })).toBeEnabled();
        await userEvent.click(within(brief).getByRole("button", { name: /^取消$/ }));
      } else {
        expect(within(brief).queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
      }
      expect(override).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
    });
  }
  for (const [nodeId, buttonLabel] of [["render", "查看渲染结果"], ["technical-review", "查看机器质检"]] as const) {
    it(`opens the current ${nodeId} delivery with focus at an optional-review stop`, async () => {
      const base = failedRun("accepted_unknown");
      const run: StudioRunDetail = { ...base, status: "needs_human", currentNodeId: "visual-review",
        nodes: [{ id: nodeId, label: nodeId === "render" ? "渲染" : "机器质检", status: "succeeded",
          artifactIds: [], qualityGateResults: [], output: { status: "passed", checks: [{ name: "可解码", passed: true }] } }],
      };
      const decide = vi.fn(async () => undefined);
      render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} /></MemoryRouter>);
      await userEvent.click(screen.getByRole("button", { name: buttonLabel }));
      const delivery = document.getElementById(`node-workspace-${nodeId}`);
      expect(delivery).toBeInstanceOf(HTMLDetailsElement);
      expect(delivery).toHaveAttribute("open");
      await waitFor(() => expect(delivery?.querySelector(":scope > summary")).toHaveFocus());
      expect(within(delivery!).queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
      expect(decide).not.toHaveBeenCalled();
    });
  }
  it("prepares a preserved failed draft only after explicit confirmation and keeps the frozen target", async () => {
    const prepare = vi.fn(async () => undefined);
    const target = { nodeId: "creative-planning" as const, stage: "script" as const,
      targetArtifactId: "draft-A", targetVersionId: "version-A", targetSha256: "a".repeat(64) };
    render(<MemoryRouter><RunWorkbench run={{ ...failedRun("accepted_unknown"), reviewContinuationTargets: [target] }}
      decisionPending={false} onDecision={async () => undefined} onPrepareReviewContinuation={prepare} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "恢复当前稿，继续处理" }));
    await userEvent.keyboard("{Escape}");
    expect(prepare).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "恢复当前稿，继续处理" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("不会采用或签字");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认恢复工作台" }));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ ...target, commandId: expect.any(String), expectedRunRevision: 4 }));
  });

  it("keeps every original optional review queryable after internal delivery without a retrieve action", async () => {
    const { taskRecovery: _taskRecovery, ...baseRun } = failedRun("accepted_unknown");
    const run: StudioRunDetail = { ...baseRun, status: "succeeded",
      optionalReviewTasks: ["visual_review", "audio_review"].map((purpose, index) => ({ nodeId: "visual-review",
        purpose: purpose as "visual_review" | "audio_review", operationId: `original-${index}`, requestId: `original-request-${index}`, targetVersionId: "render-A",
        requestState: "unknown", resultState: "absent", summary: "作品已采用；原审片结果与费用待核，查询不会重发。" })) };
    const query = vi.fn(async () => undefined);
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined}
      onQueryOriginalTextTask={query} /></MemoryRouter>);
    const buttons = screen.getAllByRole("button", { name: /查询原.*审片/ });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(query).toHaveBeenCalledWith({ nodeId: "visual-review", purpose: "audio_review", operationId: "original-1" });
    expect(screen.queryByRole("button", { name: "取回结果并继续" })).not.toBeInTheDocument();
  });

  for (const nodeId of ["visual-review", "final-review"]) it(`offers a scoped unknown risk decision at ${nodeId} with a stable independent command`, async () => {
    const { taskRecovery: _taskRecovery, ...baseRun } = failedRun("accepted_unknown");
    const run: StudioRunDetail = { ...baseRun, status: "needs_human",
      currentNodeId: nodeId, activeIntervention: { id: `stop-${nodeId}`, nodeId, reason: "原审计仍待核", options: ["approve", "reject"],
        reviewStatus: "incomplete", providerOutcomeKnown: false, continuationScope: "rendered_video_optional_review",
        evidenceId: "a".repeat(64), createdAt: "2026-10-02T00:00:00Z" },
      nodes: [{ id: nodeId, label: "审看", status: "needs_human", artifactIds: [], qualityGateResults: [],
        output: { reviewStatus: "incomplete", providerOutcomeKnown: false } }] };
    const decide = vi.fn(async (_input: StudioDecisionInput) => undefined);
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={decide} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: nodeId === "visual-review" ? "接受未复核风险，进入人工终审" : "接受未复核风险并内部定版" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: nodeId === "visual-review" ? "确认继续到人工终审" : "确认承担风险并内部定版" }));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ commandId: expect.any(String), action: "approve",
      reviewEvidenceId: "a".repeat(64), acceptIncomplete: true, expectedRunRevision: 4 }));
    const original = decide.mock.calls[0]![0];
    await userEvent.click(within(dialog).getByRole("button", { name: nodeId === "visual-review" ? "确认继续到人工终审" : "确认承担风险并内部定版" }));
    expect(decide.mock.calls[1]![0]).toEqual(original);
  });

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
