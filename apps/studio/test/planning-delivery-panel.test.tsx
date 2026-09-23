import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { PlanningDeliveryPanel } from "../src/client/components/PlanningDeliveryPanel.js";
import type { StudioArtifact } from "../src/shared/api.js";

const artifact = (id: string, kind: string): StudioArtifact => ({
  id, kind, producerNodeId: "creative-planning", createdAt: "2026-09-24T00:00:00.000Z",
  contentType: "application/json", contentUrl: `/api/${id}`, sha256: "a".repeat(64),
});

afterEach(() => vi.restoreAllMocks());

describe("PlanningDeliveryPanel", () => {
  it("reads only the current registered version and keeps all six entries visible", async () => {
    const read = vi.spyOn(studioApi, "resourceJson").mockResolvedValue({ viewerPromise: "让观众学会判断", progression: [{ purpose: "先解释问题" }] });
    render(<PlanningDeliveryPanel runId="run-one" versionId="version-two" artifactIds={["treatment-new"]}
      artifacts={[artifact("treatment-old", "creative_treatment"), artifact("treatment-new", "creative_treatment"), artifact("script-old", "script")]}
      publicationExpected />);
    expect(screen.getByLabelText("规划产物目录").querySelectorAll("button")).toHaveLength(6);
    expect(await screen.findByText("让观众学会判断")).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("/api/treatment-new", expect.any(AbortSignal));
    expect(read).not.toHaveBeenCalledWith("/api/treatment-old", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: /脚本.*未产出/ }));
    expect(screen.getByText("这一项尚未产出，其他已交付内容仍可查看。")).toBeInTheDocument();
  });

  it("reports an unreadable registered document without claiming the plan is empty", async () => {
    vi.spyOn(studioApi, "resourceJson").mockRejectedValue(new Error("integrity mismatch"));
    render(<PlanningDeliveryPanel runId="run-one" versionId="version-one" artifactIds={["treatment-one"]}
      artifacts={[artifact("treatment-one", "creative_treatment")]} publicationExpected />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("交付已登记，但正文暂时无法核验或读取"));
    expect(screen.queryByText(/没有需要人工查看/)).not.toBeInTheDocument();
  });

  it("keeps business content readable while keeping internal identifiers out of the document", async () => {
    vi.spyOn(studioApi, "resourceJson").mockResolvedValue({
      viewerPromise: "看懂判断方法",
      progression: [{ beatId: "internal-beat-1", purpose: "解释差异", viewerGain: "会判断" }],
      evidenceRequirements: [{ claim: "水温不是唯一因素", requirement: "factual_support", acquisition: "external_required" }],
    });
    render(<PlanningDeliveryPanel runId="run-one" versionId="version-one" artifactIds={["treatment-one"]}
      artifacts={[artifact("treatment-one", "creative_treatment")]} publicationExpected />);
    expect(await screen.findByText("看懂判断方法")).toBeInTheDocument();
    expect(screen.getByText("需要真实来源支持")).toBeInTheDocument();
    expect(screen.getByText("需要你提供或核实")).toBeInTheDocument();
    expect(screen.queryByText("internal-beat-1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("查看产物登记信息"));
    expect(screen.getByText("treatment-one")).toBeVisible();
  });
});
