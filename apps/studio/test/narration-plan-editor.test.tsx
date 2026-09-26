import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioNarrationPlanPreview, StudioRunDetail } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { NarrationPlanEditor } from "../src/client/components/NarrationPlanEditor.js";

const preview: StudioNarrationPlanPreview = { expectedRunRevision: 5, confirmed: false, plan: {
  version: "video-factory/narration-plan-v1", mode: "continuous_groups", script: { sha256: "a".repeat(64) },
  visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 }, edgeTrim: "none", subtitleMode: "provider_sentence",
  silences: [{ id: "silence-2", startFrame: 300, endFrame: 420, source: "legacy_silent_scene" }],
  groups: [{ id: "narration-1", sourceScenePositions: [1], text: "先停一下。", window: { startFrame: 0, endFrame: 300 },
    placement: { anchor: "start", offsetFrames: 0 } }],
} };

afterEach(() => vi.restoreAllMocks());

it("previews without adoption and saves the creator's placement without starting the next node", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(structuredClone(preview));
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlan").mockResolvedValue({ revision: 6 } as StudioRunDetail);
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  expect(studioApi.narrationPlan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下。");
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByText(/10.0.*14.0/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("第 1 组落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "采用这份旁白方案" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm.mock.calls[0]?.[1].plan.groups[0]?.placement.anchor).toBe("end");
  expect(confirm.mock.calls[0]?.[1].expectedRunRevision).toBe(5);
  view.rerender(<NarrationPlanEditor runId="run-example" runRevision={6} disabled={false} />);
  await screen.findByText(/已采用.*未开始配音/);
  view.rerender(<NarrationPlanEditor runId="run-example" runRevision={7} disabled={false} />);
  expect(screen.queryByText(/已采用.*未开始配音/)).not.toBeInTheDocument();
  expect(screen.getByText(/制作记录已更新/)).toBeInTheDocument();
});

it("does not submit a preview after the run changes", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(structuredClone(preview));
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlan");
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下。");
  view.rerender(<NarrationPlanEditor runId="run-example" runRevision={7} disabled={false} />);
  expect((screen.getByRole("button", { name: "采用这份旁白方案" }) as HTMLButtonElement).disabled).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
});

it("does not carry another run's preview into a run with the same revision", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(structuredClone(preview));
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlan");
  const view = render(<NarrationPlanEditor runId="run-one" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下。");
  view.rerender(<NarrationPlanEditor runId="run-two" runRevision={5} disabled={false} />);
  expect(screen.getByRole("button", { name: "采用这份旁白方案" })).toBeDisabled();
  expect(confirm).not.toHaveBeenCalled();
});
