import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import type { StudioNode, StudioRunDetail } from "../src/shared/api.js";

const node = (id: string, label: string, status: StudioNode["status"], output?: unknown): StudioNode => ({
  id, label, status, artifactIds: [], qualityGateResults: [], ...(output ? { output } : {}),
});
function filmRun(): StudioRunDetail {
  return {
    id: "uiux-film", title: "窗边的一天", status: "needs_human", currentNodeId: "final-review", revision: 5,
    platform: "douyin", durationSeconds: 24, startedAt: "2026-10-11T00:00:00Z",
    angle: "日常观察", audience: "创作者", nicheSlug: "daily", reviewMode: "manual",
    nodes: [node("visual-review", "视觉审片", "succeeded", { report: {
      recommendation: "revise", summary: "保留风险", confidence: 0.8,
      reviewScope: { evidenceId: "a".repeat(64) },
      findings: [{ itemKey: "b".repeat(64), timecodeMs: 1000, scenePosition: 1,
        category: "composition", description: "主体略偏", suggestion: "调整构图", evidenceStatus: "failed" }],
    } })],
    artifacts: [{ id: "film-current", kind: "render", contentUrl: "/film.mp4", contentType: "video/mp4",
      createdAt: "2026-10-11T00:00:00Z", producerNodeId: "render" }],
    videoArtifactId: "film-current", decisions: [],
    activeIntervention: { id: "final-stop", nodeId: "final-review", reason: "请确认本版", options: ["approve", "reject"], createdAt: "2026-10-11T00:00:00Z" },
  };
}

describe("workbench factual UI refinements", () => {
  it("opens the existing series content workspace instead of a second production form", async () => {
    const user = userEvent.setup();
    const { activeIntervention: _stop, ...base } = filmRun();
    const restart = vi.fn();
    render(<RunWorkbench run={{ ...base, status: "succeeded", seriesId: "series-1", seriesRework: { mode: "edit_current" },
      nodes: [node("script", "脚本", "succeeded", { scenes: [{ narration: "已确认的本集旁白" }] }), ...base.nodes] }}
      decisionPending={false} onDecision={vi.fn()} onRestart={restart} onOverrideNode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "基于这版重新制作" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "修改本集内容" }));
    expect(document.getElementById("node-workspace-script")).toHaveAttribute("open");
    expect(restart).not.toHaveBeenCalled();
  });

  it("shows the series dependency restriction before any rework form, without inventing a revision action", () => {
    const { activeIntervention: _stop, ...base } = filmRun();
    render(<RunWorkbench run={{ ...base, status: "succeeded", seriesId: "series-1", seriesRework: {
      mode: "blocked", reason: "第 2 集已经采用或进入制作，不能再直接改写它依赖的第 1 集。" } }}
      decisionPending={false} onDecision={vi.fn()} onRestart={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "基于这版重新制作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改本集内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "本集修改范围" })).toHaveTextContent("第 2 集已经采用");
    expect(screen.queryByRole("button", { name: /正式修订|更正集/ })).not.toBeInTheDocument();
  });

  for (const status of ["pending", "stale"] as const) it(`does not present a superseded review as the current film result (${status})`, () => {
    const run = filmRun();
    const review = run.nodes[0]!;
    review.output = { report: { recommendation: "approve", summary: "旧成片通过", findings: [],
      independentReviews: [{ providerId: "review-a", modelId: "model", report: { recommendation: "approve", summary: "旧版已看", findings: [] } }] },
      audioReview: { status: "completed", summary: "旧声音已经复核", findings: [] } };
    review.status = status;
    review.outputState = { generatedVersionId: "old-review", effectiveVersionId: "old-review", stale: true, versions: [] };
    run.currentNodeId = "render";
    run.activeIntervention = { ...run.activeIntervention!, nodeId: "render" };
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.queryByText("该模型审查同一版成片")).not.toBeInTheDocument();
    expect(screen.queryByText(/旧声音已经复核/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "机器审片状态" })).toHaveTextContent("机器视觉审片尚无完整结论");
  });

  it("reports incomplete machine review as a fact after human approval, without demanding a new audit or inventing a package", () => {
    const { activeIntervention: _stop, ...base } = filmRun();
    render(<RunWorkbench run={{ ...base, status: "succeeded", finalReviewOutcome: "approved" }} decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.getByText(/机器审片尚不完整；不改变已记录的人工终审决定/)).toBeVisible();
    expect(screen.queryByText(/请重新审查当前成片/)).not.toBeInTheDocument();
    const facts = screen.getByRole("region", { name: "交付状态" });
    expect(document.querySelector(".run-header")).toHaveTextContent("内部交付已完成");
    const summary = screen.getByRole("region", { name: "完成范围摘要" });
    expect(summary).toHaveTextContent("发布包尚不可下载");
    expect(summary).toHaveTextContent("机器双审 0/2");
    expect(summary).toHaveTextContent("对外发布仍需你自行操作");
    expect(summary).not.toHaveTextContent("费用待核");
    expect(facts).toHaveTextContent("未取得可下载的发布包");
    expect(facts).toHaveTextContent("外部发布需你自行操作");
    expect(screen.queryByText(/发布包可以下载使用/)).not.toBeInTheDocument();
  });

  it("does not claim human approval or incomplete coverage for two completed review branches", () => {
    const run = filmRun();
    run.nodes[0]!.output = { report: { recommendation: "approve", summary: "意见已齐", findings: [],
      independentReviews: ["review-a", "review-b"].map(providerId => ({ providerId, modelId: "model", report: { recommendation: "approve", summary: "已看", findings: [] } })) } };
    render(<RunWorkbench run={run} decisionPending={false} onDecision={vi.fn()} />);
    expect(screen.queryByText(/不改变已记录的人工终审决定/)).not.toBeInTheDocument();
    expect(screen.queryByText(/缺少 .*独立审片结果/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认本版成片并内部定版" })).toBeEnabled();
  });

  it("cancels confirmation without seeking or approving, and uses distinct risk vs disagreement choices", async () => {
    const user = userEvent.setup();
    const decide = vi.fn();
    render(<RunWorkbench run={filmRun()} decisionPending={false} onDecision={decide} />);
    const trigger = screen.getByRole("button", { name: "接受风险并内部定版" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "不同意这条意见" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "不同意这条意见" }));
    expect(within(dialog).getByRole("button", { name: "确认内部定版并准备文案" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: "不采纳理由" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "先不确认" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(decide).not.toHaveBeenCalled();
  });

  it("lists known retained and stale stages, keeps uncertain reuse explicit, and does not execute when reading impact", () => {
    const { activeIntervention: _stop, ...base } = filmRun();
    const regenerate = vi.fn();
    render(<RunWorkbench run={{ ...base, status: "stale", nodes: [
      node("script", "脚本", "succeeded", { narration: "新旁白" }),
      node("assets", "画面素材", "stale", { count: 2 }),
      node("voice", "配音", "stale", { duration: 24 }),
      node("render", "合成成片", "pending"),
    ] }} decisionPending={false} onDecision={vi.fn()} onRegenerateStale={regenerate} />);
    const impact = screen.getByRole("region", { name: "本次返工影响" });
    expect(within(impact).getByText("当前仍有效").parentElement).toHaveTextContent("脚本");
    expect(within(impact).getByText("已失效，需重新处理").parentElement).toHaveTextContent("画面素材、配音");
    expect(impact).toHaveTextContent("具体镜头、音轨是否复用及新增费用，需重新核对方案与报价");
    expect(impact).not.toHaveTextContent("不会新增费用");
    expect(regenerate).not.toHaveBeenCalled();
  });
});
