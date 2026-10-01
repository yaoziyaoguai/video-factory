import { fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioNarrationPlan, StudioNarrationPlanPreview, StudioRunDetail } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { NarrationPlanEditor } from "../src/client/components/NarrationPlanEditor.js";

const v1Plan: StudioNarrationPlan = {
  version: "video-factory/narration-plan-v1", mode: "continuous_groups", script: { sha256: "a".repeat(64) },
  visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 }, edgeTrim: "none", subtitleMode: "provider_sentence",
  silences: [{ id: "silence-2", startFrame: 300, endFrame: 420, source: "legacy_silent_scene" }],
  groups: [{ id: "narration-1", sourceScenePositions: [1], text: "先停一下。", window: { startFrame: 0, endFrame: 300 },
    placement: { anchor: "start", offsetFrames: 0 } }],
};
const preview: StudioNarrationPlanPreview = {
  expectedRunRevision: 5,
  confirmed: false,
  sourceContextId: "sc-plan-editor-v1",
  plan: v1Plan,
  editorContext: {
    mode: "pre_generation",
    defaultPlan: v1Plan,
    baseGroups: [{ baseGroupId: "nb-1", text: "先停一下。", endCodePoint: 5,
      frameRange: { startFrame: 0, endFrame: 300 }, allowedBoundaries: [] }],
    savedPlanStatus: "none",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

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

it("protects the unsaved v1 placement before reloading and only discards with explicit consent", async () => {
  const load = vi.spyOn(studioApi, "narrationPlan").mockImplementation(async () => structuredClone(preview));
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlan");
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2");
  const confirmV2 = vi.spyOn(studioApi, "confirmNarrationPlanV2");
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByLabelText("第 1 组落点");
  fireEvent.change(screen.getByLabelText("第 1 组落点"), { target: { value: "end" } });
  const reload = screen.getByRole("button", { name: "重新查看旁白方案" });
  reload.focus();
  fireEvent.click(reload);
  const dialog = screen.getByRole("alertdialog", { name: "放弃旁白草稿并重新查看" });
  expect(load).toHaveBeenCalledOnce();
  const keep = within(dialog).getByRole("button", { name: "返回继续编辑" });
  expect(keep).toHaveFocus();
  fireEvent.click(keep);
  expect(screen.getByLabelText("第 1 组落点")).toHaveValue("end");
  fireEvent.click(reload);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(reload).toHaveFocus();
  expect(screen.getByLabelText("第 1 组落点")).toHaveValue("end");
  expect(load).toHaveBeenCalledOnce();
  fireEvent.click(reload);
  fireEvent.click(within(screen.getByRole("alertdialog"))
    .getByRole("button", { name: "放弃草稿并重新查看" }));
  await waitFor(() => expect(screen.getByLabelText("第 1 组落点")).toHaveValue("start"));
  expect(load).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(previewV2).not.toHaveBeenCalled();
  expect(confirmV2).not.toHaveBeenCalled();
});

// 旁白方案采用点必须给出字数与画面的密度事实，避免配音后才首次发现长空档。
it("shows per-group text density against the picture window before adoption", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue({ ...structuredClone(preview),
    plan: { ...structuredClone(v1Plan), groups: [{
      id: "narration-1", sourceScenePositions: [1], text: "先停一下，等光再挪一段。",
      window: { startFrame: 0, endFrame: 450 }, placement: { anchor: "start", offsetFrames: 0 } }] } });
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下，等光再挪一段。");
  expect(screen.getByText(/10 字/)).toBeInTheDocument();
  expect(screen.getByText(/15.0 秒/)).toBeInTheDocument();
  expect(screen.getByText(/每秒 3–5 字/)).toBeInTheDocument();
});

// §4/S5 生成前“分段与留白”：默认折叠、句界候选、v2 票据预览/知情保存；不自动代替素材确认。
it("keeps segmentation collapsed by default and saves a v2 candidate only through a ticket with informed unknown quote", async () => {
  const twoSentencePreview = { ...structuredClone(preview), sourceContextId: "sc-plan-editor-v2",
    plan: { ...structuredClone(v1Plan), groups: [{ ...structuredClone(v1Plan.groups[0]!),
      text: "先停一下。再看看。" }] },
    editorContext: { ...structuredClone(preview.editorContext),
      baseGroups: [{ baseGroupId: "nb-1", text: "先停一下。再看看。", endCodePoint: 9,
        frameRange: { startFrame: 0, endFrame: 300 }, allowedBoundaries: [5] }] } };
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(twoSentencePreview);
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2")
    .mockResolvedValue({
      expectedRunRevision: 5, sourceContextId: "sc-plan-editor-v2", editorSessionId: "editor-run-example",
      editSequence: 1, candidateId: "nc-candidate", ticketId: "npt-ticket", planSha256: "d".repeat(64),
      plan: structuredClone(v2PlanForSegmentation()), providerConfigDigest: "digest",
      quote: { status: "unavailable", source: "configured_rate" },
    } as never);
  const confirmV2 = vi.spyOn(studioApi, "confirmNarrationPlanV2").mockResolvedValue({
    receipt: { accepted: true, replay: false, current: true, requestId: "save-1", planSha256: "d".repeat(64),
      artifactId: "art-plan", inputVersionId: "iv-1", expectedRunRevision: 5, resultingRunRevision: 6 },
    run: { revision: 6 },
  } as never);
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findAllByText("先停一下。再看看。");
  const section = screen.getByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  expect(section.open).toBe(false);
  fireEvent.click(section.querySelector("summary")!);
  expect(section.open).toBe(true);
  const boundary = await screen.findByLabelText(/在「先停一下。」后分段/);
  fireEvent.click(boundary);
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await waitFor(() => expect(previewV2).toHaveBeenCalledOnce());
  const candidate = previewV2.mock.calls.at(-1)?.[1].candidate as Record<string, unknown>;
  const candidateGroups = candidate.groups as Array<{ sourceRange: { startCodePoint: number; endCodePoint: number } }>;
  expect(candidateGroups[0]?.sourceRange.endCodePoint).toBe(5);
  expect(candidateGroups[1]?.sourceRange.startCodePoint).toBe(5);
  await screen.findByText(/核价不可得/);
  fireEvent.click(screen.getByRole("button", { name: "保存旁白计划" }));
  await waitFor(() => expect(confirmV2).not.toHaveBeenCalled(), { timeout: 300 });
  fireEvent.click(screen.getByLabelText(/知情确认按未知价格保存/));
  fireEvent.click(screen.getByRole("button", { name: "保存旁白计划" }));
  await waitFor(() => expect(confirmV2).toHaveBeenCalledOnce());
  expect(confirmV2.mock.calls[0]?.[1].acknowledgeQuoteUnavailable).toBe(true);
  expect((await screen.findAllByText(/尚未开始配音/)).length).toBeGreaterThan(0);
  expect(window.localStorage.getItem("vf:narration-plan-draft:run-example")).toBeNull();
  view.unmount();
});

function v2PlanForSegmentation() {
  return { version: "video-factory/narration-plan-v2", groups: [
    { id: "ng-1", sourceRange: { baseGroupId: "nb-1", startCodePoint: 0, endCodePoint: 5 },
      sourceScenePositions: [1], text: "先停一下。", window: { startFrame: 0, endFrame: 300 },
      placement: { anchor: "start", offsetFrames: 0 } }] };
}

function editablePreview(): StudioNarrationPlanPreview {
  return {
    ...structuredClone(preview),
    sourceContextId: "sc-editable",
    plan: { ...structuredClone(v1Plan), groups: [{ ...structuredClone(v1Plan.groups[0]!), text: "先停一下。再看看。" }] },
    editorContext: {
      ...structuredClone(preview.editorContext),
      baseGroups: [{ baseGroupId: "nb-1", text: "先停一下。再看看。", endCodePoint: 9,
        frameRange: { startFrame: 0, endFrame: 300 }, allowedBoundaries: [5] }],
    },
  };
}

function ticket(editSequence: number) {
  return {
    expectedRunRevision: 5, sourceContextId: "sc-editable", editorSessionId: "editor-run-example",
    editSequence, candidateId: `candidate-${editSequence}`, ticketId: `ticket-${editSequence}`,
    planSha256: "d".repeat(64), plan: v2PlanForSegmentation(), providerConfigDigest: "digest",
    quote: { status: "estimated", source: "configured_rate", estimatedCostCny: 0.03,
      maxCostCny: 0.03, unitPriceCny: "2.00", items: [] },
  } as never;
}

async function openAdvancedEditor() {
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  const section = await screen.findByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  await screen.findByText(/正文只读/);
  return section;
}

it.each([
  { scenario: "new source", changeSource: true, cleanupFails: false },
  { scenario: "same source with failed cleanup", changeSource: false, cleanupFails: true },
])("protects the advanced draft and ticket on reload of $scenario", async ({ changeSource, cleanupFails }) => {
  const next = editablePreview();
  if (changeSource) {
    next.expectedRunRevision = 6;
    next.sourceContextId = "sc-new-source";
  }
  const load = vi.spyOn(studioApi, "narrationPlan").mockResolvedValueOnce(editablePreview()).mockResolvedValue(next);
  const quote = vi.spyOn(studioApi, "narrationPlanPreviewV2").mockResolvedValue(ticket(1));
  const save = vi.spyOn(studioApi, "confirmNarrationPlanV2");
  const v1Save = vi.spyOn(studioApi, "confirmNarrationPlan");
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  const key = "vf:narration-plan-draft:run-example";
  const oldStored = window.localStorage.getItem(key);
  view.rerender(<NarrationPlanEditor runId="run-example" runRevision={next.expectedRunRevision} disabled={false} />);
  const reload = screen.getByRole("button", { name: "重新查看旁白方案" });
  reload.focus();
  fireEvent.click(reload);
  const dialog = screen.getByRole("alertdialog", { name: "放弃旁白草稿并重新查看" });
  expect(load).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole("button", { name: "返回继续编辑" }));
  expect(screen.getByLabelText("第 1 段窗口结束秒")).toHaveValue("9");
  expect(screen.getByRole("button", { name: "保存旁白计划" })).toBeInTheDocument();
  expect(window.localStorage.getItem(key)).toBe(oldStored);
  fireEvent.click(reload);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(reload).toHaveFocus();
  expect(screen.getByLabelText("第 1 段窗口结束秒")).toHaveValue("9");
  if (cleanupFails) vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("cleanup failed"); });
  fireEvent.click(reload);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃草稿并重新查看" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(reload).toBeEnabled());
  const section = screen.getByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  if (!section.open) fireEvent.click(section.querySelector("summary")!);
  expect(await screen.findByLabelText("第 1 段窗口结束秒")).toHaveValue("10");
  expect(screen.queryByRole("button", { name: "保存旁白计划" })).not.toBeInTheDocument();
  if (cleanupFails) {
    expect(screen.getByText(/本机旧草稿未能清理.*本页不再恢复/)).toBeInTheDocument();
    expect(window.localStorage.getItem(key)).toBe(oldStored);
  }
  fireEvent.click(reload);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(reload).toBeEnabled());
  const reread = screen.getByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  if (!reread.open) fireEvent.click(reread.querySelector("summary")!);
  expect(await screen.findByLabelText("第 1 段窗口结束秒")).toHaveValue("10");
  expect(quote).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(v1Save).not.toHaveBeenCalled();
});

it.each(["success", "failure"] as const)("isolates a late %s quote after explicit reload consent even when the draft is restored", async (outcome) => {
  let finishQuote!: (value: any) => void;
  let failQuote!: (error: Error) => void;
  const pendingQuote = new Promise<any>((resolve, reject) => { finishQuote = resolve; failQuote = reject; });
  let finishLoad!: (value: StudioNarrationPlanPreview) => void;
  const pendingLoad = new Promise<StudioNarrationPlanPreview>((resolve) => { finishLoad = resolve; });
  const load = vi.spyOn(studioApi, "narrationPlan").mockResolvedValueOnce(editablePreview())
    .mockImplementationOnce(() => pendingLoad);
  const quote = vi.spyOn(studioApi, "narrationPlanPreviewV2").mockImplementationOnce(() => pendingQuote);
  const save = vi.spyOn(studioApi, "confirmNarrationPlanV2");
  const v1Save = vi.spyOn(studioApi, "confirmNarrationPlan");
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  expect(quote).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "10" } });
  const reload = screen.getByRole("button", { name: "重新查看旁白方案" });
  fireEvent.click(reload);
  const dialog = screen.getByRole("alertdialog", { name: "放弃旁白草稿并重新查看" });
  expect(load).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole("button", { name: "返回继续编辑" }));
  expect(screen.getByLabelText("第 1 段窗口结束秒")).toHaveValue("10");
  view.rerender(<NarrationPlanEditor runId="run-example" runRevision={6} disabled={false} />);
  fireEvent.click(reload);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃草稿并重新查看" }));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    if (outcome === "success") finishQuote(ticket(1));
    else failQuote(new Error("旧核价错误"));
  });
  expect(reload).toBeDisabled();
  expect(screen.queryByText("旧核价错误")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存旁白计划" })).not.toBeInTheDocument();
  const current = editablePreview();
  current.expectedRunRevision = 6;
  current.sourceContextId = "sc-next-quote";
  await act(async () => finishLoad(current));
  const section = screen.getByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  expect(await screen.findByLabelText("第 1 段窗口结束秒")).toHaveValue("10");
  const nextTicket = structuredClone(ticket(2)) as unknown as Record<string, unknown>;
  nextTicket.sourceContextId = current.sourceContextId;
  nextTicket.expectedRunRevision = 6;
  quote.mockResolvedValueOnce(nextTicket as never);
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  expect(quote.mock.calls.map((call) => call[1].editSequence)).toEqual([1, 2]);
  expect(quote.mock.calls[1]![1].sourceContextId).toBe("sc-next-quote");
  expect(quote.mock.calls[1]![1].expectedRunRevision).toBe(6);
  expect(save).not.toHaveBeenCalled();
  expect(v1Save).not.toHaveBeenCalled();
});

it("reopens the saved v2 split, windows, placement and explicit silence from GET without an empty preview POST", async () => {
  const current = editablePreview();
  current.confirmed = true;
  current.editorContext.savedPlanStatus = "current";
  current.plan = {
    version: "video-factory/narration-plan-v2", mode: "continuous_groups",
    script: { sha256: "a".repeat(64) }, visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 300 },
    source: { normalization: "narration-text-v1", sourceContextId: "sc-editable", canonicalSourceSha256: "c".repeat(64) },
    edgeTrim: "none", subtitleMode: "provider_sentence",
    silences: [{ id: "ns-user-135-195", startFrame: 135, endFrame: 195, source: "user" }],
    groups: [
      { id: "ng-a", sourceRange: { baseGroupId: "nb-1", startCodePoint: 0, endCodePoint: 5 },
        sourceScenePositions: [1], text: "先停一下。", window: { startFrame: 0, endFrame: 135 },
        placement: { anchor: "start", offsetFrames: 0 } },
      { id: "ng-b", sourceRange: { baseGroupId: "nb-1", startCodePoint: 5, endCodePoint: 9 },
        sourceScenePositions: [1], text: "再看看。", window: { startFrame: 195, endFrame: 300 },
        placement: { anchor: "end", offsetFrames: 3 } },
    ],
  } as never;
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(current);
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2");
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  const section = await screen.findByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  expect(await screen.findByLabelText(/在「先停一下。」后分段/)).toBeChecked();
  expect(await screen.findByLabelText("第 1 段窗口结束秒")).toHaveValue("4.5");
  expect(screen.getByLabelText("第 2 段窗口开始秒")).toHaveValue("6.5");
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
  expect(screen.getByLabelText("留白 1 开始秒")).toHaveValue("4.5");
  expect(previewV2).not.toHaveBeenCalled();
});

it("marks pure window text dirty immediately, invalidates the old ticket, and never submits stale valid frames", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2").mockResolvedValue(ticket(1));
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  const section = await screen.findByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  const end = await screen.findByLabelText("第 1 段窗口结束秒");
  fireEvent.change(end, { target: { value: "9" } });
  expect(screen.getByRole("button", { name: "预览分段并核价" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  fireEvent.change(end, { target: { value: "-1" } });
  expect(screen.queryByRole("button", { name: "保存旁白计划" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent(/非负|结束时间/);
  expect(previewV2).toHaveBeenCalledOnce();
});

it("allocates edit sequences before requests and ignores an old response after the draft changes", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  let resolveFirst: (value: any) => void = () => {};
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2")
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(ticket(2));
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  const section = await screen.findByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  const end = await screen.findByLabelText("第 1 段窗口结束秒");
  fireEvent.change(end, { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  fireEvent.change(end, { target: { value: "8" } });
  await act(async () => resolveFirst(ticket(1)));
  expect(screen.queryByRole("button", { name: "保存旁白计划" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  expect(previewV2.mock.calls.map((call) => call[1].editSequence)).toEqual([1, 2]);
});

it("keeps an invalid silence string visible and invalidates the ticket before it can submit old frames", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  const previewV2 = vi.spyOn(studioApi, "narrationPlanPreviewV2").mockResolvedValue(ticket(1));
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  fireEvent.click(screen.getByRole("button", { name: "添加留白" }));
  fireEvent.change(screen.getByLabelText("留白 1 开始秒"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("留白 1 结束秒"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  fireEvent.change(screen.getByLabelText("留白 1 开始秒"), { target: { value: "-" } });
  expect(screen.getByLabelText("留白 1 开始秒")).toHaveValue("-");
  expect(screen.queryByRole("button", { name: "保存旁白计划" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/非负十进制秒/);
  expect(previewV2).toHaveBeenCalledOnce();
});

it("keeps the pre-generation editor usable when local draft reading fails", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  expect(screen.getByText(/无法读取本机旁白草稿/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  expect(screen.getByLabelText("第 1 段窗口结束秒")).toHaveValue("9");
});

it("keeps the pre-generation draft in memory and warns when local writing fails", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  expect(await screen.findByText(/本机草稿保存失败/)).toBeInTheDocument();
  expect(screen.getByLabelText("第 1 段窗口结束秒")).toHaveValue("9");
});

it("reports a server-side save as successful when local draft cleanup fails", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(editablePreview());
  vi.spyOn(studioApi, "narrationPlanPreviewV2").mockResolvedValue(ticket(1));
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlanV2").mockResolvedValue({
    receipt: { accepted: true, replay: false, current: true, requestId: "save-ticket-1", planSha256: "d".repeat(64),
      artifactId: "art-plan", inputVersionId: "iv-1", expectedRunRevision: 5, resultingRunRevision: 6 },
    run: { revision: 6 },
  } as never);
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  await openAdvancedEditor();
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "预览分段并核价" }));
  await screen.findByRole("button", { name: "保存旁白计划" });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("cleanup failed"); });
  fireEvent.click(screen.getByRole("button", { name: "保存旁白计划" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect((await screen.findAllByText(/尚未开始配音/)).length).toBeGreaterThan(0);
  expect(screen.getByText(/服务端已保存；本机旧草稿未能清理/)).toBeInTheDocument();
});

it("persists a same-source draft locally and cancels advanced mode through the current default plan", async () => {
  const loaded = editablePreview();
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(loaded);
  const confirm = vi.spyOn(studioApi, "confirmNarrationPlan").mockResolvedValue({ revision: 6 } as StudioRunDetail);
  const view = render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  const section = await screen.findByRole("group", { name: "分段与留白" }) as HTMLDetailsElement;
  fireEvent.click(section.querySelector("summary")!);
  fireEvent.change(await screen.findByLabelText("第 1 段窗口结束秒"), { target: { value: "9" } });
  await waitFor(() => expect(window.localStorage.getItem("vf:narration-plan-draft:run-example")).toContain("sc-editable"));
  fireEvent.click(screen.getByRole("button", { name: "取消高级分段，保存默认连续方案" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm.mock.calls[0]?.[1].plan).toEqual(loaded.editorContext.defaultPlan);
  await waitFor(() => expect(window.localStorage.getItem("vf:narration-plan-draft:run-example")).toBeNull());
  view.unmount();
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

// T01 保护：真实组件确认遇到服务端失败时，不显示保存成功，且保留用户当前选择。
it("keeps the creator's placement and hides the saved state when the server rejects a confirm", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(structuredClone(preview));
  vi.spyOn(studioApi, "confirmNarrationPlan").mockRejectedValue(new Error("制作记录已更新，请重新查看旁白方案后再确认。"));
  render(<NarrationPlanEditor runId="run-example" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下。");
  fireEvent.change(screen.getByLabelText("第 1 组落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "采用这份旁白方案" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("制作记录已更新");
  expect(screen.queryByText(/已采用旁白方案/)).not.toBeInTheDocument();
  expect((screen.getByLabelText("第 1 组落点") as HTMLSelectElement).value).toBe("end");
  expect(screen.getByRole("button", { name: "采用这份旁白方案" })).toBeEnabled();
});

// T01 保护：确认请求在途时切换 run，迟到的成功响应不能把旧 run 的保存反馈写进新 run。
it("does not mark the new run saved when an in-flight confirm resolves after switching runs", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(structuredClone(preview));
  let resolveConfirm: (detail: StudioRunDetail) => void = () => {};
  vi.spyOn(studioApi, "confirmNarrationPlan").mockImplementation(
    () => new Promise<StudioRunDetail>((resolve) => { resolveConfirm = resolve; }));
  const view = render(<NarrationPlanEditor runId="run-one" runRevision={5} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看连贯旁白方案" }));
  await screen.findByText("先停一下。");
  fireEvent.click(screen.getByRole("button", { name: "采用这份旁白方案" }));
  view.rerender(<NarrationPlanEditor runId="run-two" runRevision={5} disabled={false} />);
  await act(async () => {
    resolveConfirm({ revision: 6 } as StudioRunDetail);
  });
  expect(screen.queryByText(/已采用旁白方案/)).not.toBeInTheDocument();
  expect(screen.getByText(/制作记录已更新/)).toBeInTheDocument();
});
