import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { StudioNarrationPlanPreview, StudioNarrationPreviewTicketV2, StudioNarrationConfirmV2Result, StudioRunDetail } from "../src/shared/api.js";
import { NarrationPlanEditor } from "../src/client/components/NarrationPlanEditor.js";
import { RunPage } from "../src/client/pages/RunPage.js";
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });
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
  fireEvent.click(await screen.findByRole("button", { name: "预览台词并核价" }));
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

it("adopts the saved character plan run before the next risk decision when SSE is silent", async () => {
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  const initial: StudioRunDetail = {
    id: "role-plan-next", title: "角色计划后继续", status: "needs_human", platform: "douyin", durationSeconds: 20,
    startedAt: "2026-10-07T00:00:00Z", currentNodeId: "asset-source-review", nextAction: "review", revision: 1,
    angle: "验证保存后继续", audience: "内部试用", nicheSlug: "story", reviewMode: "manual",
    presentationMode: "character_drama", continuation: { supported: true }, artifacts: [], decisions: [],
    nodes: [
      { id: "asset-source-review", label: "生成画面预检", status: "needs_human", artifactIds: [], qualityGateResults: [] },
      { id: "voice", label: "配音", status: "pending", artifactIds: [], qualityGateResults: [],
        plannedExecution: { providerId: "minimax-tts-v1", providerLabel: "MiniMax", modelId: "speech-2.8-hd",
          transport: "http_api", billing: "metered", snapshotSource: "created" } },
    ],
    activeIntervention: { id: "source-stop", nodeId: "asset-source-review", reason: "素材质量由你决定",
      options: ["approve", "reject"], createdAt: "2026-10-07T00:00:00Z" },
  };
  const saved = { ...initial, revision: 2 };
  // 模拟缺失/迟到的只读通知；保存响应才是此次写入的权威快照。
  vi.spyOn(studioApi, "run").mockResolvedValue(initial);
  vi.spyOn(studioApi, "runCosts").mockRejectedValue(new Error("no cost fixture"));
  vi.spyOn(studioApi, "providers").mockResolvedValue([]);
  vi.spyOn(studioApi, "creativeReviewHistory").mockRejectedValue(new Error("no history fixture"));
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(preview);
  vi.spyOn(studioApi, "narrationPlanPreviewV2").mockImplementation(async (_id, input) => ({
    ticketId: "page-ticket", candidateId: "candidate", planSha256: "d".repeat(64), providerConfigDigest: "e".repeat(64),
    sourceContextId: "ctx", expectedRunRevision: 1, editorSessionId: input.editorSessionId,
    editSequence: input.editSequence, plan, quote: { status: "unavailable", source: "configured_rate" },
  } as StudioNarrationPreviewTicketV2));
  const save = vi.spyOn(studioApi, "confirmNarrationPlanV2").mockResolvedValue({
    receipt: { accepted: true }, run: saved,
  } as StudioNarrationConfirmV2Result);
  const decide = vi.spyOn(studioApi, "decide").mockResolvedValue(saved);
  render(<MemoryRouter initialEntries={["/projects/role-plan-next"]}><Routes>
    <Route path="/projects/:runId" element={<RunPage />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "查看角色配音方案" }));
  fireEvent.click(await screen.findByText("台词与留白", { selector: "summary" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览台词并核价" }));
  fireEvent.click(await screen.findByLabelText("知情确认按未知价格保存"));
  fireEvent.click(screen.getByRole("button", { name: "保存角色配音计划" }));
  await waitFor(() => expect(screen.getByText("已保存角色配音方案；尚未开始配音，请继续确认当前素材步骤。")).toBeInTheDocument());
  expect(decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "接受当前素材风险，继续制作" }));
  fireEvent.click(screen.getByRole("button", { name: "确认承担并继续" }));
  await waitFor(() => expect(decide).toHaveBeenCalledOnce());
  expect(decide.mock.calls[0]).toEqual([initial.id, expect.objectContaining({
    action: "approve", interventionId: "source-stop", expectedRunRevision: 2,
  })]);
  expect(save).toHaveBeenCalledOnce();
});
