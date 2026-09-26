import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CreativeReviewHistoryPanel } from "../src/client/components/CreativeReviewHistoryPanel.js";
import type { StudioCreativeReviewHistory } from "../src/shared/api.js";

describe("CreativeReviewHistoryPanel", () => {
  it("shows each archived full draft with its own audit and decision, never a confirmation button", () => {
    const history: StudioCreativeReviewHistory = {
      runId: "run-history", legacyIncomplete: false,
      entries: [
        { stage: "treatment", versionId: "treatment#v1", document: { viewerPromise: "理解第一版", payoff: "第一版结尾" },
          audits: [{ auditId: "audit-1", status: "repair", summary: "开场还不清楚", suggestions: ["先给出问题"] }] },
        { stage: "treatment", versionId: "treatment#v2", document: { viewerPromise: "理解第二版", payoff: "第二版结尾" },
          audits: [], confirmation: { actor: "creator", confirmedAt: "2026-09-24T00:00:00.000Z", unauditedAdoption: true, auditId: null } },
      ],
    };
    render(<CreativeReviewHistoryPanel history={history} />);
    const panel = screen.getByRole("region", { name: "创作版本记录" });
    expect(within(panel).getByText("第一版结尾")).toBeInTheDocument();
    expect(within(panel).getByText("第二版结尾")).toBeInTheDocument();
    expect(within(panel).getByText("先给出问题")).toBeInTheDocument();
    expect(within(panel).getAllByText(/未审采用/)).toHaveLength(2);
    expect(within(panel).queryByRole("button", { name: /采用|确认/ })).not.toBeInTheDocument();
  });
});
