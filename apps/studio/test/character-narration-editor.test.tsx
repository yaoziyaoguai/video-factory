import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioNarrationPlanPreview, StudioNarrationPreviewTicketV2, StudioNarrationConfirmV2Result } from "../src/shared/api.js";
import { NarrationPlanEditor } from "../src/client/components/NarrationPlanEditor.js";
import { studioApi } from "../src/client/api.js";
const plan: StudioNarrationPlanPreview["plan"] = {
  version: "video-factory/narration-plan-v3", mode: "character_turns", script: { sha256: "a".repeat(64) },
  visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 }, source: { sourceContextId: "ctx", canonicalSourceSha256: "c".repeat(64) },
  edgeTrim: "none", subtitleMode: "provider_sentence", audioStrategy: "external_tts",
  groups: [{ id: "turn-1", turnId: "turn-1", speakerId: "speaker-1", voiceProfileId: "minimax:female-shaonv",
    sourceScenePositions: [1], text: "钥匙找到了。", window: { startFrame: 0, endFrame: 180 }, placement: { anchor: "start", offsetFrames: 0 } }],
  silences: [],
};
const preview: StudioNarrationPlanPreview = { expectedRunRevision: 1, confirmed: false, plan, sourceContextId: "ctx",
  editorContext: { mode: "pre_generation", defaultPlan: plan, baseGroups: [], savedPlanStatus: "none",
    characters: [{ id: "speaker-1", name: "学生", voiceProfileId: "minimax:female-shaonv" }] } };
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });
it("keeps the missing-voice error next to a character edit action, without submitting a voice plan", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockRejectedValue(new Error("请先为角色‘学生’选择可用音色。"));
  const edit = vi.fn();
  const save = vi.spyOn(studioApi, "confirmNarrationPlanV2");
  render(<NarrationPlanEditor runId="missing-voice-ui" runRevision={1} disabled={false} characterDrama onEditCharacters={edit} />);
  fireEvent.click(screen.getByRole("button", { name: "查看角色配音方案" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("学生");
  fireEvent.click(screen.getByRole("button", { name: "修改角色、台词或音色" }));
  expect(edit).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});
it("previews the default per-turn plan and saves a v3 ticket without any v1 adoption or cross-speaker segmentation", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(preview);
  const legacy = vi.spyOn(studioApi, "confirmNarrationPlan");
  const quote = vi.spyOn(studioApi, "narrationPlanPreviewV2").mockImplementation(async (_id, input) => ({
    ticketId: "ticket-1", candidateId: "candidate-1", planSha256: "d".repeat(64), providerConfigDigest: "e".repeat(64),
    sourceContextId: "ctx", expectedRunRevision: 1, editorSessionId: input.editorSessionId,
    editSequence: input.editSequence, plan, quote: { status: "unavailable", source: "configured_rate" },
  } as StudioNarrationPreviewTicketV2));
  const save = vi.spyOn(studioApi, "confirmNarrationPlanV2").mockResolvedValue({
    receipt: { accepted: true }, run: { revision: 2 },
  } as StudioNarrationConfirmV2Result);
  render(<NarrationPlanEditor runId="role-voice-ui" runRevision={1} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: /查看.*方案/ }));
  fireEvent.click(await screen.findByText("台词与留白", { selector: "summary" }));
  expect(screen.queryByText(/取消高级分段/)).not.toBeInTheDocument();
  expect(await screen.findByText(/学生.*音色/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览台词并核价" }));
  await waitFor(() => expect(quote).toHaveBeenCalledOnce());
  expect(quote.mock.calls[0]![1]).toMatchObject({ version: plan.version, candidate: {
    version: plan.version, groups: [{ turnId: "turn-1", window: { startFrame: 0, endFrame: 180 } }],
  } });
  expect(JSON.stringify(quote.mock.calls[0]![1].candidate)).not.toMatch(/sourceRange|voiceProfileId|speakerId|钥匙/);
  fireEvent.click(screen.getByLabelText("知情确认按未知价格保存"));
  fireEvent.click(screen.getByRole("button", { name: "保存角色配音计划" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![1]).toMatchObject({ version: plan.version, acknowledgeQuoteUnavailable: true, ticketId: "ticket-1" });
  expect(legacy).not.toHaveBeenCalled();
});
