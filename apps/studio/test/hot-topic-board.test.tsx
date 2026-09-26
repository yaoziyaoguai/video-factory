import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HotTopicBoard } from "../src/client/components/HotTopicBoard.js";
import { decideEditorialFormat } from "../src/server/editorial-decision.js";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";
import type { StudioCandidateInboxItem, StudioTopicGenerationReceipt } from "../src/shared/api.js";

const verification = {
  status: "ready" as const,
  independentSources: 1,
  requiredSources: 1,
  reasons: ["常规风险候选。"],
};

const score = {
  audienceReach: 90,
  visualFeasibility: 88,
  productionCostEfficiency: 90,
  novelty: 84,
  monetization: 72,
  audienceDemand: 70,
  seriesPotential: 88,
  complianceRisk: 12,
  final: 86,
};

// 用生产同一条决策函数生成 editorialDecision：规则线索的"待总编评估"标记不是测试自己编的，
// 否则这条测试只能证明组件会读一个假字段。
function boardItem(providerId: string): StudioCandidateInboxItem {
  const candidate = {
    id: "trend-1",
    title: "AI 模型开始进入普通人的工作流",
    platform: "douyin",
    track: "ai-daily-life",
    audience: "普通上班族",
    painPoint: "工具很多但不知道是否真省时间",
    hook: "别先看演示，先看它能不能替你完成一件真任务。",
    rationale: "来自可追溯热点信号。",
    providerId,
    generatedAt: "2026-08-24T08:05:00.000Z",
    evidence: [{
      source: "技术媒体 A",
      platform: "douyin",
      keyword: "AI 工作流",
      strength: 96,
      evidenceUrl: "https://example.com/ai-workflow",
      collectedAt: "2026-08-24T08:00:00.000Z",
    }],
    score,
    category: "technology" as const,
  };
  return {
    ...candidate,
    origin: "trend",
    freshness: "live",
    risk: "low",
    verification,
    editorialDecision: decideEditorialFormat({
      origin: "trend",
      providerId,
      title: candidate.title,
      track: candidate.track,
      category: candidate.category,
      freshness: "live",
      risk: "low",
      verification,
      score,
      audience: candidate.audience,
      painPoint: candidate.painPoint,
      hook: candidate.hook,
      evidence: [{ source: "技术媒体 A", evidenceUrl: "https://example.com/ai-workflow" }],
    }, BUILTIN_TEMPLATES),
  };
}

const receipt: StudioTopicGenerationReceipt = {
  generationId: "generation-1",
  generatedAt: "2026-09-16T09:00:00.000Z",
  modelInvoked: true,
  source: "editor-model",
  candidateCount: 1,
};

const noop = async () => undefined;

describe("hot topic board", () => {
  it("shows the editor's real angle when the round came from the editor model", () => {
    render(<HotTopicBoard candidates={[boardItem("api-topic-editor-v1")]} topicGeneration={receipt} onAdopt={noop} />);

    const board = screen.getByRole("region", { name: /热点/ });
    expect(board).toHaveTextContent("别先看演示，先看它能不能替你完成一件真任务。");
    expect(board).toHaveTextContent("每个热点已给出可用方向");
    expect(board).not.toHaveTextContent("本轮总编没有给出选题建议");
  });

  it("says the round has no editor advice instead of dressing rule leads as directions", () => {
    const item = boardItem("trend-heuristic-v1");
    render(
      <HotTopicBoard
        candidates={[item]}
        topicGeneration={{ ...receipt, modelInvoked: false, source: "rule-fallback", failureCategory: "model_unavailable", failureReason: "总编任务未就绪。" }}
        onAdopt={noop}
        onRetry={() => undefined}
      />,
    );

    const board = screen.getByRole("region", { name: /热点/ });
    expect(board).toHaveTextContent("本轮总编没有给出选题建议");
    expect(board).toHaveTextContent("总编模型当前不可用。原因：总编任务未就绪。");
    // 规则线索的 hook 是模板套出来的问句，不能当"总编给的方向"印出来。
    expect(board).toHaveTextContent("总编本轮没有为这条给出创作角度。");
    expect(board).not.toHaveTextContent(item.hook);
    expect(board).not.toHaveTextContent("每个热点已给出可用方向");
    // 也绝不能替总编表态说它不建议生产，或把线索数说成方向数。
    expect(board).toHaveTextContent("待总编评估");
    expect(board).not.toHaveTextContent("总编不建议生产");
    expect(board).toHaveTextContent("1 条线索");
    expect(board).not.toHaveTextContent("个方向");
  });

  it("still names the board as rule leads when the receipt is missing from a restored cache", () => {
    render(<HotTopicBoard candidates={[boardItem("trend-heuristic-v1")]} onAdopt={noop} />);

    const board = screen.getByRole("region", { name: /热点/ });
    expect(board).toHaveTextContent("本轮总编没有给出选题建议");
    expect(board).toHaveTextContent("没有经过选题总编");
    expect(board).not.toHaveTextContent("每个热点已给出可用方向");
  });
});

// 「初稿审一次」合同 S4：候选修订入口——只产未审修订稿，不自动审计、不自动发送。
describe("HotTopicBoard candidate revision", () => {
  it("sends the revision instruction bound to the candidate and surfaces the unaudited outcome", async () => {
    const calls: Array<{ candidateId: string; instruction: string }> = [];
    const revisions = render(
      <HotTopicBoard
        candidates={[boardItem("api-topic-editor-v1")]}
        onAdopt={async () => undefined}
        onReviseCandidate={async (candidate, instruction) => {
          calls.push({ candidateId: candidate.id, instruction });
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /修订/ }));
    fireEvent.change(screen.getByLabelText("修订意见"), { target: { value: "标题给出可执行的核对动作。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(calls).toEqual([{ candidateId: "trend-1", instruction: "标题给出可执行的核对动作。" }]));
    expect(await screen.findByText(/未审/)).toBeInTheDocument();
  });

  it("keeps the send button disabled while the instruction is blank", () => {
    render(
      <HotTopicBoard
        candidates={[boardItem("api-topic-editor-v1")]}
        onAdopt={async () => undefined}
        onReviseCandidate={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /修订/ }));
    const send = screen.getByRole("button", { name: "发送修订意见" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});

describe("HotTopicBoard unaudited revision labeling", () => {
  it("labels revised unaudited candidates on the direction row", () => {
    const item = { ...boardItem("api-topic-editor-v1"), auditStatus: "not_audited" as const, revisedFrom: { candidateId: "trend-1", generationId: "gen-1", instruction: "改标题" } };
    render(
      <HotTopicBoard
        candidates={[item]}
        onAdopt={async () => undefined}
        onReviseCandidate={async () => undefined}
      />,
    );
    expect(screen.getAllByText(/修订稿 · 本版未审/).length).toBeGreaterThan(0);
  });
});
