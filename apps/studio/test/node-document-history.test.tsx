import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { NodeDocumentHistory } from "../src/client/components/NodeDocumentHistory.js";
import type { StudioArtifact, StudioNode } from "../src/shared/api.js";

describe("NodeDocumentHistory", () => {
  it("loads each old full document on demand and shows that version's review without an approval action", async () => {
    const resource = vi.spyOn(studioApi, "resourceJson").mockResolvedValue({ copy: { title: "旧版标题", description: "旧版完整描述", hashtags: ["旧版"] } });
    const versions: NonNullable<StudioNode["outputState"]> = {
      generatedVersionId: "v1", effectiveVersionId: "v2", stale: false, versions: [
        { id: "v1", source: "generated", artifactIds: ["artifact-old"], inputVersionIds: [], createdAt: "2026-09-24T00:00:00Z", createdBy: "agent", schemaVersion: "v1", output: { contentReview: { status: "has_suggestions", summary: "旧版待改", suggestions: ["旧版建议"] } } },
        { id: "v2", source: "human", artifactIds: ["artifact-new"], inputVersionIds: [], createdAt: "2026-09-24T00:01:00Z", createdBy: "creator", schemaVersion: "v1", output: { contentReview: { status: "not_audited", summary: "新版未审", suggestions: [] } } },
      ],
    };
    const artifacts: StudioArtifact[] = [
      { id: "artifact-old", kind: "publish_package", producerNodeId: "publish-package", createdAt: "2026-09-24T00:00:00Z", contentType: "application/json", contentUrl: "/old" },
      { id: "artifact-new", kind: "publish_package", producerNodeId: "publish-package", createdAt: "2026-09-24T00:01:00Z", contentType: "application/json", contentUrl: "/new" },
    ];
    render(<NodeDocumentHistory nodeId="publish-package" outputState={versions} artifacts={artifacts} />);
    const summary = screen.getByText(/第 1 版 · 2026-09-24/);
    expect(summary).not.toHaveTextContent("v1");
    fireEvent.click(summary);
    expect(await screen.findByText("旧版完整描述")).toBeInTheDocument();
    expect(screen.getByText("旧版建议")).toBeInTheDocument();
    expect(resource).toHaveBeenCalledWith("/old", expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: /采用|确认/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("版本诊断信息"));
    expect(screen.getByLabelText("历史版本编号")).toHaveValue("v1");
  });
});
