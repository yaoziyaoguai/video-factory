import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodeContentReview, nodeContentReview } from "../src/client/components/NodeContentReview.js";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";
import type { StudioNode } from "../src/shared/api.js";

describe("NodeContentReview", () => {
  it("lets the creator read every audit of this version without showing technical identities", () => {
    const review = nodeContentReview({ contentReview: {
      status: "passed", summary: "当前复核：叙述清楚", suggestions: [], auditId: "audit-current-private",
      history: [
        { status: "has_suggestions", summary: "初审：开头铺垫过长", suggestions: ["提前展示结果"] },
        { status: "passed", summary: "当前复核：叙述清楚", suggestions: [], auditId: "audit-current-private" },
      ],
    } });
    expect(review?.auditId).toBe("audit-current-private");
    render(<NodeContentReview value={review!} />);
    expect(screen.getByText("本版审计记录（2 次）")).toBeInTheDocument();
    expect(screen.getByText("初审：开头铺垫过长")).toBeInTheDocument();
    expect(screen.getByText("提前展示结果")).toBeInTheDocument();
    expect(screen.queryByText("audit-current-private")).not.toBeInTheDocument();
  });
  it("shows creator-facing suggestions even when the first audit passed", () => {
    render(<NodeContentReview value={{ status: "passed", summary: "整体可用", suggestions: ["开场先展示最终画面，再解释做法。"] }} />);
    expect(screen.getByText("本版已审计")).toBeInTheDocument();
    expect(screen.getByText("开场先展示最终画面，再解释做法。")).toBeInTheDocument();
  });

  it("does not present an edited delivery as audited", () => {
    render(<NodeContentReview value={{ status: "not_audited", summary: "人工修改后的本版尚未重新审计。", suggestions: [] }} />);
    expect(screen.getByText("本版未审")).toBeInTheDocument();
    expect(screen.queryByText("本版已审计")).not.toBeInTheDocument();
  });

  it("uses the effective human version rather than the older generated review", () => {
    const generated = { referenceGrammarPath: "/private/old.json", contentReview: { status: "passed", summary: "旧版通过", suggestions: [] } };
    const human = { referenceGrammarPath: "/private/new.json", contentReview: { status: "not_audited", summary: "新版未审", suggestions: [] } };
    const node: StudioNode = {
      id: "reference-grammar", label: "参考片分析", role: "参考片分析师", status: "needs_human", artifactIds: [], qualityGateResults: [], output: generated,
      outputState: { generatedVersionId: "v1", effectiveVersionId: "v2", stale: false, versions: [
        { id: "v1", source: "generated", artifactIds: [], inputVersionIds: [], createdAt: "2026-09-24T00:00:00Z", createdBy: "agent", schemaVersion: "v1", output: generated },
        { id: "v2", source: "human", artifactIds: [], inputVersionIds: [], createdAt: "2026-09-24T00:01:00Z", createdBy: "creator", schemaVersion: "v1", output: human },
      ] },
    };
    render(<NodeWorkspace node={node} runStatus="needs_human" runId="run-review" runRevision={2} acceptedPlanDigest="" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);
    const currentReview = screen.getAllByRole("region", { name: "本版内容审计" })[0]!;
    expect(within(currentReview).getByText("新版未审")).toBeInTheDocument();
    expect(within(currentReview).queryByText("旧版通过")).not.toBeInTheDocument();
  });
});
