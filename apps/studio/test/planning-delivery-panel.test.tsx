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
  it("does not promise unused stock candidate deliveries in native audio mode", async () => {
    vi.spyOn(studioApi, "resourceJson").mockResolvedValue({ viewerPromise: "原声逐镜生成" });
    const props = { runId: "native-plan", versionId: "v1", artifactIds: ["treatment"], artifacts: [artifact("treatment", "creative_treatment")], publicationExpected: true };
    const view = render(<PlanningDeliveryPanel {...props} nativeAudio />);
    expect(await screen.findByText("原声逐镜生成")).toBeInTheDocument();
    expect(screen.getByLabelText("规划产物目录").querySelectorAll("button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /候选素材|选材排序/ })).not.toBeInTheDocument();
    view.rerender(<PlanningDeliveryPanel {...props} />);
    expect(screen.getByLabelText("规划产物目录").querySelectorAll("button")).toHaveLength(6);
  });

  it("uses the readable script view for a preserved stage draft", () => {
    render(<PlanningDeliveryPanel runId="run-draft" versionId="node-v2" artifactIds={[]} artifacts={[]}
      publicationExpected={false} creativeReview={{ stages: { script: {
        phase: "waiting_user", currentDraft: { versionId: "draft-v1", sha256: "a".repeat(64) },
        currentDocument: { scenes: [{ position: 1, narration: "窗边的光慢慢挪过桌面。", duration: 7,
          visual_strategy: "generated", visual_prompt: "窗边的编辑示意卡" }] },
      } } }} />);
    expect(screen.getByRole("button", { name: /脚本.*待确认/ })).toBeInTheDocument();
    expect(screen.getByText("查看完整业务内容").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("position")).not.toBeVisible();
    expect(screen.getAllByText("窗边的光慢慢挪过桌面。").some(node => !node.closest("details"))).toBe(true);
  });

  it("does not present a stale stage draft or a different-version confirmation as adopted", async () => {
    const creativeReview = { stages: { treatment: { phase: "confirmed",
      currentDraft: { versionId: "draft-v2", sha256: "b".repeat(64) }, currentDocument: { viewerPromise: "本次保存稿" },
      confirmation: { versionId: "draft-v1", draftSha256: "b".repeat(64) } } } };
    const view = render(<PlanningDeliveryPanel runId="run-stale" versionId="node-v2" artifactIds={[]} artifacts={[]}
      publicationExpected={false} creativeReview={creativeReview} />);
    expect(screen.getByRole("button", { name: /前期构思.*待确认/ })).toBeInTheDocument();
    view.rerender(<PlanningDeliveryPanel runId="run-stale" versionId="node-v2" artifactIds={[]} artifacts={[]}
      publicationExpected={false} creativeReview={creativeReview} stale />);
    expect(screen.getByRole("button", { name: /前期构思.*待更新/ })).toBeInTheDocument();
    expect(screen.getByText("上次保存版本 · 待更新 · 只读")).toBeInTheDocument();
    expect(screen.queryByText(/当前阶段稿.*已采用/)).not.toBeInTheDocument();
  });

  it("keeps an unreadable formal artifact explicit instead of replacing it with a stage draft", async () => {
    vi.spyOn(studioApi, "resourceJson").mockRejectedValue(new Error("unreadable"));
    render(<PlanningDeliveryPanel runId="run-formal" versionId="node-v2" artifactIds={["formal"]}
      artifacts={[artifact("formal", "creative_treatment")]} publicationExpected creativeReview={{ stages: { treatment: {
        currentDraft: { versionId: "draft-v1", sha256: "a".repeat(64) }, currentDocument: { viewerPromise: "不能冒充正式产物" },
      } } }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("正文暂时无法核验或读取");
    expect(screen.queryByText("不能冒充正式产物")).not.toBeInTheDocument();
  });

  it("describes a generated route as a capability rather than acquired or paid media", async () => {
    vi.spyOn(studioApi, "resourceJson").mockResolvedValue({ evidenceRequirements: [{
      claim: "虚构的杯中星河", requirement: "illustration_only", acquisition: "pipeline_generated",
    }] });
    render(<PlanningDeliveryPanel runId="run-generated" versionId="version-one" artifactIds={["treatment-generated"]}
      artifacts={[artifact("treatment-generated", "creative_treatment")]} publicationExpected />);
    expect(await screen.findByText("可由 AI 生成，制作前需确认报价")).toBeInTheDocument();
    expect(screen.queryByText("pipeline_generated")).not.toBeInTheDocument();
  });

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

describe("PlanningDeliveryPanel D19", () => {
  it("falls back to the registered effective version when stage verification is empty", async () => {
    vi.spyOn(studioApi, "resourceJson").mockResolvedValue({ viewerPromise: "当前采用稿正文" });
    render(<PlanningDeliveryPanel runId="run-d19" versionId="version-current" artifactIds={["treatment-current"]}
      artifacts={[artifact("treatment-current", "creative_treatment")]} publicationExpected={false} />);
    expect(await screen.findByText("当前采用稿正文")).toBeInTheDocument();
    expect(screen.queryByText(/正式规划尚未交付/)).not.toBeInTheDocument();
  });
});
