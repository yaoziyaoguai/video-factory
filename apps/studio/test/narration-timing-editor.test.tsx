import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioArtifact, StudioNarrationPlanPreview, StudioNode, StudioRunDetail } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { NarrationTimingEditor } from "../src/client/components/NarrationTimingEditor.js";

const v2Plan = {
  version: "video-factory/narration-plan-v2",
  mode: "continuous_groups",
  script: { sha256: "a".repeat(64) },
  visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 },
  source: { normalization: "narration-text-v1", sourceContextId: "sc-timing-test", canonicalSourceSha256: "c".repeat(64) },
  edgeTrim: "none",
  subtitleMode: "provider_sentence",
  silences: [{ id: "ns-user-90-150", startFrame: 90, endFrame: 150, source: "user" }],
  groups: [
    { id: "ng-1", sourceRange: { baseGroupId: "nb-1", startCodePoint: 0, endCodePoint: 6 },
      sourceScenePositions: [1], text: "第一句。", window: { startFrame: 0, endFrame: 90 },
      placement: { anchor: "start", offsetFrames: 0 } },
    { id: "ng-2", sourceRange: { baseGroupId: "nb-1", startCodePoint: 6, endCodePoint: 12 },
      sourceScenePositions: [1, 2], text: "第二句。", window: { startFrame: 150, endFrame: 600 },
      placement: { anchor: "start", offsetFrames: 0 } },
  ],
};

const artifacts: StudioArtifact[] = [
  { id: "art-plan", kind: "voiceover_plan", sha256: "p".repeat(64), sizeBytes: 10, contentType: "application/json", producerNodeId: "voice", createdAt: "" },
  { id: "art-audio", kind: "voiceover", sha256: "q".repeat(64), sizeBytes: 20, contentType: "audio/mp4", producerNodeId: "voice", createdAt: "" },
];

const voiceNode: StudioNode = {
  id: "voice", label: "声音", status: "needs_human", artifactIds: ["art-plan", "art-audio"],
  qualityGateResults: [],
  output: { layoutKey: "layout-current", voiceOperationId: "tts-original-op",
    conflict: undefined },
  outputState: { effectiveVersionId: "version-voice-1", stale: false, versions: [
    { id: "version-voice-1", artifactIds: ["art-plan", "art-audio"], schemaVersion: "video-factory/voiceover-plan-v3" },
  ] },
} as unknown as StudioNode;

function previewFixture(): StudioNarrationPlanPreview {
  return { expectedRunRevision: 7, confirmed: true, sourceContextId: "sc-timing-test",
    plan: structuredClone(v2Plan) as never,
    editorContext: {
      mode: "voice_stop",
      defaultPlan: {
        version: "video-factory/narration-plan-v1", mode: "continuous_groups",
        script: { sha256: "a".repeat(64) }, visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 },
        edgeTrim: "none", subtitleMode: "provider_sentence", silences: [],
        groups: [{ id: "narration-1", sourceScenePositions: [1, 2], text: "第一句。第二句。",
          window: { startFrame: 0, endFrame: 600 }, placement: { anchor: "start", offsetFrames: 0 } }],
      },
      baseGroups: [{ baseGroupId: "nb-1", text: "第一句。第二句。", endCodePoint: 8,
        frameRange: { startFrame: 0, endFrame: 600 }, allowedBoundaries: [4] }],
      savedPlanStatus: "current",
    } };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function renderEditor(overrides: { voiceNode?: StudioNode; revision?: number } = {}) {
  return render(<NarrationTimingEditor runId="run-timing" revision={overrides.revision ?? 7}
    voiceNode={overrides.voiceNode ?? voiceNode} artifacts={artifacts}
    interventionId="intervention-active" disabled={false} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it("explains an untracked legacy voice before offering an unusable timing control", async () => {
  const preview = previewFixture();
  preview.plan = preview.editorContext!.defaultPlan!;
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(preview);
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
  renderEditor({ voiceNode: { ...voiceNode, output: { trackPath: "/legacy.m4a" } } });
  await screen.findByText(/这版声音没有可核对的排轨来源/);
  expect(screen.queryByLabelText("第 1 段留空秒")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "应用时间调整并重新试听" })).not.toBeInTheDocument();
  expect(screen.getByText(/原声音仍可试听与采用/)).toBeInTheDocument();
  expect(dispatch).not.toHaveBeenCalled();
});

it("shows the current v2 groups, quantizes seconds on blur, and keeps invalid input with a message", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  renderEditor();
  await screen.findByText("第一句。");
  expect(screen.getByText(/复用原配音/)).toBeTruthy();
  expect(screen.getByLabelText("留白 1 开始秒")).toHaveValue("3");
  expect(screen.getByLabelText("留白 1 结束秒")).toHaveValue("5");
  const startInput = screen.getByLabelText("第 1 段窗口开始秒") as HTMLInputElement;
  fireEvent.change(startInput, { target: { value: "2" } });
  fireEvent.blur(startInput);
  await waitFor(() => expect(screen.getByLabelText("第 1 段窗口开始秒")).toHaveValue("2"));
  fireEvent.change(startInput, { target: { value: "-1" } });
  fireEvent.blur(startInput);
  expect(screen.getByRole("alert").textContent).toMatch(/非负十进制秒/);
  expect(screen.getByLabelText("第 1 段窗口开始秒")).toHaveValue("-1");
});

it("sends a relayout apply bound to the current voice version and stop, then reports the listening stop", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({
    nodes: [{ id: "voice", status: "needs_human" }],
  } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "d".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const input = dispatch.mock.calls[0]?.[1] as Record<string, any>;
  expect(input.action).toBe("relayout_narration");
  expect(input.interventionId).toBe("intervention-active");
  expect(input.source.kind).toBe("voice_version");
  expect(input.source.voiceVersionId).toBe("version-voice-1");
  expect(input.source.voicePlanArtifactId).toBe("art-plan");
  expect(input.source.expectedLayoutKey).toBe("layout-current");
  expect(input.source.sourceVoiceOperationId).toBe("tts-original-op");
  expect(input.layout.groups.map((group: any) => group.groupId)).toEqual(["ng-1", "ng-2"]);
  expect(input.layout.groups[1].placement.anchor).toBe("end");
  await screen.findByText(/未重新购买/);
});

it("reconciles its applied request when the current voice arrives before the POST response", async () => {
  const next = previewFixture();
  next.expectedRunRevision = 8;
  next.plan.groups[1]!.placement.anchor = "end";
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValueOnce(previewFixture()).mockResolvedValue(next);
  const pendingPost = deferred<StudioRunDetail>();
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockReturnValue(pendingPost.promise);
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "d".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const request = dispatch.mock.calls[0]![1];
  if (request.action !== "relayout_narration") throw new Error("Expected relayout request.");
  const requestId = request.requestId;
  const changedVoice = structuredClone(voiceNode);
  changedVoice.outputState!.effectiveVersionId = "version-voice-2";
  changedVoice.outputState!.versions.push({ id: "version-voice-2", artifactIds: ["art-plan", "art-audio"],
    schemaVersion: "video-factory/voiceover-plan-v3" } as never);
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  await screen.findByText(/未重新购买/);
  expect(query).toHaveBeenCalledWith("run-timing", requestId);
  expect(screen.queryByText("时间草稿尚未生效。")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续此时间调整" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
  expect(screen.getByRole("button", { name: "应用时间调整并重新试听" })).toBeEnabled();
  expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toBeNull();
  await act(async () => pendingPost.resolve({ nodes: [] } as unknown as StudioRunDetail));
  expect(dispatch).toHaveBeenCalledOnce();
});

it.each(["request", "version", "superseded"])("keeps its draft when the current-voice receipt has a %s mismatch", async (mismatch) => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const pendingPost = deferred<StudioRunDetail>();
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockReturnValue(pendingPost.promise);
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId: mismatch === "request" ? "other-request" : requestId, state: "applied", requestDigest: "d".repeat(64),
    resultVoiceVersionId: mismatch === "version" ? "other-version" : "version-voice-2", isCurrent: mismatch !== "superseded" }));
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const original = window.localStorage.getItem("vf:narration-timing-draft:run-timing");
  const changedVoice = structuredClone(voiceNode);
  changedVoice.outputState!.effectiveVersionId = "version-voice-2";
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  await screen.findByText(/旧草稿保持只读/);
  const request = dispatch.mock.calls[0]![1];
  if (request.action !== "relayout_narration") throw new Error("Expected relayout request.");
  expect(query).toHaveBeenCalledWith("run-timing", request.requestId);
  expect(screen.queryByText(/未重新购买/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "继续此时间调整" })).toBeDisabled();
  expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toBe(original);
  await act(async () => pendingPost.resolve({ nodes: [] } as unknown as StudioRunDetail));
  expect(dispatch).toHaveBeenCalledOnce();
});

it("keeps the draft and offers discard when the local adjustment fails", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision")
    .mockRejectedValueOnce(new Error("时间调整没有完成：分段仍需要 240 帧，当前窗口只有 100 帧。原有效声音、草稿与当前停点保持不变。"));
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockResolvedValue({
    requestId: "relayout-failed", state: "failed", isCurrent: false,
    failureReason: "分段仍需要 240 帧，当前窗口只有 100 帧。" });
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await screen.findByText(/时间调整没有完成/);
  expect(screen.getByLabelText("第 1 段窗口开始秒")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销这次未生效的修改" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  expect((dispatch.mock.calls[1]?.[1] as Record<string, any>).intent).toBe("discard_unapplied");
});

it("surfaces first-fit conflict facts and offers original audio playback through artifact content URLs", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const conflicted = structuredClone(voiceNode) as unknown as StudioNode;
  (conflicted.output as Record<string, unknown>).conflict = {
    code: "NARRATION_GROUP_DOES_NOT_FIT_V2", groupId: "ng-1", requiredFrames: 2700, availableFrames: 90 };
  renderEditor({ voiceNode: conflicted });
  await screen.findByText(/需要 2700 帧，当前窗口只有 90 帧/);
  const audio = screen.getByRole("region", { name: "只调整配音时间" }).querySelector("audio");
  expect(audio?.getAttribute("src")).toBe("/api/runs/run-timing/artifacts/art-audio/content");
});

it("edits an existing user silence from 90–150 to 135–195 and sends the complete v2 layout", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "a".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  renderEditor();
  await screen.findByText("第一句。");
  const start = screen.getByLabelText("留白 1 开始秒");
  fireEvent.change(start, { target: { value: "4.5" } });
  fireEvent.blur(start);
  const end = screen.getByLabelText("留白 1 结束秒");
  fireEvent.change(end, { target: { value: "6.5" } });
  fireEvent.blur(end);
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect((dispatch.mock.calls[0]?.[1] as any).layout.userSilences).toEqual([{ startFrame: 135, endFrame: 195 }]);
});

it("can remove an old user silence, add a new one, and submit only the visible silence", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "a".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.click(screen.getByRole("button", { name: "移除留白" }));
  fireEvent.click(screen.getByRole("button", { name: "添加留白" }));
  fireEvent.change(screen.getByLabelText("留白 1 开始秒"), { target: { value: "4.5" } });
  fireEvent.change(screen.getByLabelText("留白 1 结束秒"), { target: { value: "6.5" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect((dispatch.mock.calls[0]?.[1] as any).layout.userSilences).toEqual([{ startFrame: 135, endFrame: 195 }]);
});

it("preserves the remaining silence values when the first of two silences is removed", async () => {
  const twoSilences = previewFixture();
  (twoSilences.plan as { silences: unknown[] }).silences = [
    { id: "ns-user-90-150", startFrame: 90, endFrame: 150, source: "user" },
    { id: "ns-user-200-260", startFrame: 200, endFrame: 260, source: "user" },
  ];
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(twoSilences);
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "a".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  renderEditor();
  await screen.findByText("第一句。");
  const secondStart = screen.getByLabelText("留白 2 开始秒");
  const secondEnd = screen.getByLabelText("留白 2 结束秒");
  fireEvent.change(secondStart, { target: { value: "7" } });
  fireEvent.change(secondEnd, { target: { value: "8" } });
  const windowInputs = ["第 1 段窗口开始秒", "第 1 段窗口结束秒", "第 2 段窗口开始秒", "第 2 段窗口结束秒", "第 1 段留空秒", "第 2 段留空秒"]
    .map((label) => (screen.getByLabelText(label) as HTMLInputElement).value);

  fireEvent.click(screen.getAllByRole("button", { name: "移除留白" })[0]!);

  expect(screen.queryByLabelText("留白 2 开始秒")).not.toBeInTheDocument();
  expect((screen.getByLabelText("留白 1 开始秒") as HTMLInputElement).value).toBe("7");
  expect((screen.getByLabelText("留白 1 结束秒") as HTMLInputElement).value).toBe("8");
  expect(["第 1 段窗口开始秒", "第 1 段窗口结束秒", "第 2 段窗口开始秒", "第 2 段窗口结束秒", "第 1 段留空秒", "第 2 段留空秒"]
    .map((label) => (screen.getByLabelText(label) as HTMLInputElement).value)).toEqual(windowInputs);

  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect((dispatch.mock.calls[0]?.[1] as any).layout.userSilences).toEqual([{ startFrame: 210, endFrame: 240 }]);
});

it("clears dirty state when the user restores the loaded layout exactly", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  renderEditor();
  await screen.findByText("第一句。");
  const anchor = screen.getByLabelText("第 2 段落点");
  fireEvent.change(anchor, { target: { value: "end" } });
  expect(screen.getByText("时间草稿尚未生效。")).toBeInTheDocument();
  fireEvent.change(anchor, { target: { value: "start" } });
  await waitFor(() => expect(screen.queryByText("时间草稿尚未生效。")).not.toBeInTheDocument());
});

it("keeps the timing editor usable when local draft reading fails", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  renderEditor();
  await screen.findByText("第一句。");
  expect(screen.getByText(/无法读取本机时间草稿/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
});

it("keeps a timing draft in memory and warns when local writing fails", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  renderEditor();
  await screen.findByText("第一句。");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  expect(await screen.findByText(/本机草稿保存失败/)).toBeInTheDocument();
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
});

it("reports an applied server operation as successful when local cleanup fails", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "a".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  renderEditor();
  await screen.findByText("第一句。");
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("cleanup failed"); });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  expect(await screen.findByText(/未重新购买/)).toBeInTheDocument();
  expect(screen.getByText(/服务端已采用新声音；本机旧草稿未能清理/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not revive a discarded same-source draft when local cleanup fails", async () => {
  const load = vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation");
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  const key = "vf:narration-timing-draft:run-timing";
  const oldStored = window.localStorage.getItem(key);
  expect(oldStored).toContain('"anchor":"end"');
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("cleanup failed"); });
  fireEvent.click(screen.getByRole("button", { name: "重新读取当前版本" }));
  fireEvent.click(within(screen.getByRole("alertdialog"))
    .getByRole("button", { name: "放弃草稿并重新读取" }));
  await waitFor(() => expect(screen.getByLabelText("第 2 段落点")).toHaveValue("start"));
  expect(screen.queryByText("时间草稿尚未生效。")).not.toBeInTheDocument();
  expect(screen.getByText(/本机旧草稿未能清理.*本页不再恢复/)).toBeInTheDocument();
  expect(window.localStorage.getItem(key)).toBe(oldStored);
  fireEvent.click(screen.getByRole("button", { name: "重新读取当前版本" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole("button", { name: "重新读取当前版本" })).toBeEnabled());
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("start");
  expect(screen.getByText(/本机旧草稿未能清理.*本页不再恢复/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("第 1 段落点"), { target: { value: "end" } });
  const freshStored = JSON.parse(window.localStorage.getItem(key)!);
  expect(freshStored.groups[0].anchor).toBe("end");
  expect(freshStored.groups[1].anchor).toBe("start");
  expect(dispatch).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it("keeps the original pending request when the operation query returns a different request id", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockResolvedValue({
    requestId: "another-request", state: "applied", requestDigest: "a".repeat(64),
    resultVoiceVersionId: "version-wrong", isCurrent: true,
  });
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/编号与当前未决请求不一致/);
  expect(screen.queryByText(/未重新购买/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "继续此时间调整" })).toBeInTheDocument();
});

it("keeps one pending envelope and reuses its request id after remount instead of creating a second intent", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision")
    .mockRejectedValueOnce(new Error("响应中断，结果未知"))
    .mockResolvedValueOnce({ nodes: [] } as unknown as StudioRunDetail);
  let queryCount = 0;
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => {
    queryCount += 1;
    return queryCount < 3
      ? { requestId, state: "reserved", requestDigest: "b".repeat(64), isCurrent: false }
      : { requestId, state: "applied", requestDigest: "b".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true };
  });
  const first = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await screen.findByRole("button", { name: "继续此时间调整" });
  const firstRequestId = (dispatch.mock.calls[0]?.[1] as any).requestId;
  expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toContain(firstRequestId);
  first.unmount();
  renderEditor();
  await screen.findByRole("button", { name: "继续此时间调整" });
  fireEvent.click(screen.getByRole("button", { name: "继续此时间调整" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  expect((dispatch.mock.calls[1]?.[1] as any).requestId).toBe(firstRequestId);
  await screen.findByText(/未重新购买/);
});

it("does not restore a pending envelope into a different revision and voice source", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  vi.spyOn(studioApi, "requestNarrationRevision").mockRejectedValue(new Error("响应中断，结果未知"));
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "reserved", requestDigest: "b".repeat(64), isCurrent: false }));
  const first = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await screen.findByRole("button", { name: "继续此时间调整" });
  first.unmount();

  const changedVoice = structuredClone(voiceNode) as StudioNode;
  changedVoice.outputState!.effectiveVersionId = "version-voice-new";
  changedVoice.outputState!.versions.push({ id: "version-voice-new", artifactIds: ["art-plan", "art-audio"],
    schemaVersion: "video-factory/voiceover-plan-v3" } as never);
  renderEditor({ voiceNode: changedVoice, revision: 8 });
  await screen.findByText("第一句。");
  expect(screen.getByText(/另一版声音来源的本地草稿/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续此时间调整" })).not.toBeInTheDocument();
});

it.each(["success", "failure"] as const)("isolates a late %s response and its finally block after the voice source changes", async (outcome) => {
  const nextLoad = deferred<StudioNarrationPlanPreview>();
  vi.spyOn(studioApi, "narrationPlan")
    .mockResolvedValueOnce(previewFixture())
    .mockImplementationOnce(() => nextLoad.promise);
  const dispatchResult = deferred<StudioRunDetail>();
  vi.spyOn(studioApi, "requestNarrationRevision").mockImplementation(() => dispatchResult.promise);
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation");
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(studioApi.requestNarrationRevision).toHaveBeenCalledOnce());

  const changedVoice = structuredClone(voiceNode) as StudioNode;
  changedVoice.outputState!.effectiveVersionId = "version-voice-new";
  changedVoice.outputState!.versions.push({ id: "version-voice-new", artifactIds: ["art-plan", "art-audio"],
    schemaVersion: "video-factory/voiceover-plan-v3" } as never);
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  if (outcome === "success") {
    await act(async () => dispatchResult.resolve({ nodes: [] } as unknown as StudioRunDetail));
  } else {
    await act(async () => dispatchResult.reject(new Error("旧请求网络错误")));
  }
  expect(query).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "重新读取当前版本" })).toBeDisabled();
  await act(async () => nextLoad.resolve(previewFixture()));
  await screen.findByText(/旧草稿保持只读/);
  expect(screen.queryByText("旧请求网络错误")).not.toBeInTheDocument();
  expect(screen.queryByText(/未重新购买/)).not.toBeInTheDocument();
});

it.each(["success", "failure"] as const)("isolates a late %s preflight query while continuing the original timing request", async (outcome) => {
  const nextLoad = deferred<StudioNarrationPlanPreview>();
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValueOnce(previewFixture()).mockImplementationOnce(() => nextLoad.promise);
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockRejectedValue(new Error("响应中断，结果未知"));
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_run, requestId) => ({
    requestId, state: "reserved", requestDigest: "b".repeat(64), isCurrent: false }));
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  const resume = await screen.findByRole("button", { name: "继续此时间调整" });
  await waitFor(() => expect(resume).toBeEnabled());
  const stored = window.localStorage.getItem("vf:narration-timing-draft:run-timing");
  const originalRequest = dispatch.mock.calls[0]![1];
  if (originalRequest.action !== "relayout_narration" || originalRequest.intent !== "apply") throw new Error("Expected original relayout apply.");
  const requestId = originalRequest.requestId;
  const preflight = deferred<Awaited<ReturnType<typeof studioApi.narrationRelayoutOperation>>>();
  query.mockImplementationOnce(() => preflight.promise);
  fireEvent.click(resume);
  expect(resume).toBeDisabled();
  fireEvent.click(resume);
  const changedVoice = structuredClone(voiceNode);
  changedVoice.outputState!.effectiveVersionId = "version-voice-new";
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  await act(async () => {
    if (outcome === "success") preflight.resolve({ requestId, state: "applied", isCurrent: true,
      requestDigest: "b".repeat(64), resultVoiceVersionId: "version-voice-2" });
    else preflight.reject(new Error("旧前置查询错误"));
  });
  expect(screen.queryByText(/未重新购买/)).not.toBeInTheDocument();
  expect(screen.queryByText("旧前置查询错误")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新读取当前版本" })).toBeDisabled();
  expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toBe(stored);
  expect(dispatch).toHaveBeenCalledOnce();
  await act(async () => nextLoad.resolve(previewFixture()));
  await screen.findByText(/旧草稿保持只读/);
});

it.each([
  { outcome: "same-source success", changeSource: false, fail: false },
  { outcome: "old-source success", changeSource: true, fail: false },
  { outcome: "old-source failure", changeSource: true, fail: true },
])("occupies one timing intent before digest and isolates $outcome", async ({ changeSource, fail }) => {
  const nextLoad = deferred<StudioNarrationPlanPreview>();
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValueOnce(previewFixture()).mockImplementationOnce(() => nextLoad.promise);
  const digestResult = deferred<ArrayBuffer>();
  const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => digestResult.promise);
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_run, requestId) => ({
    requestId, state: "applied", isCurrent: true, requestDigest: "b".repeat(64), resultVoiceVersionId: "version-voice-2" }));
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  const stored = window.localStorage.getItem("vf:narration-timing-draft:run-timing");
  const apply = screen.getByRole("button", { name: "应用时间调整并重新试听" });
  fireEvent.click(apply);
  expect(apply).toBeDisabled();
  fireEvent.click(apply);
  expect(digest).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  if (changeSource) {
    const changedVoice = structuredClone(voiceNode);
    changedVoice.outputState!.effectiveVersionId = "version-voice-new";
    view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
      artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  }
  await act(async () => {
    if (fail) digestResult.reject(new Error("旧摘要错误"));
    else digestResult.resolve(new Uint8Array(32).buffer);
  });
  if (changeSource) {
    expect(dispatch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toBe(stored);
    expect(screen.queryByText("旧摘要错误")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新读取当前版本" })).toBeDisabled();
    await act(async () => nextLoad.resolve(previewFixture()));
    await screen.findByText(/旧草稿保持只读/);
  } else {
    await screen.findByText(/未重新购买/);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  }
});

it("keeps a dirty draft read-only when the same run changes revision and voice version", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  const changedVoice = structuredClone(voiceNode) as StudioNode;
  changedVoice.outputState!.effectiveVersionId = "version-voice-new";
  changedVoice.outputState!.versions.push({ id: "version-voice-new", artifactIds: ["art-plan", "art-audio"],
    schemaVersion: "video-factory/voiceover-plan-v3" } as never);
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  await screen.findByText(/旧草稿只读/);
  expect(screen.getByRole("button", { name: /应用时间调整|继续此时间调整/ })).toBeDisabled();
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
});

it("accepts the new source after the user explicitly discards a dirty old-source draft", async () => {
  const narrationPlan = vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
  const query = vi.spyOn(studioApi, "narrationRelayoutOperation");
  const view = renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  expect(screen.getByText("时间草稿尚未生效。")).toBeInTheDocument();

  const changedVoice = structuredClone(voiceNode) as unknown as StudioNode;
  changedVoice.outputState!.effectiveVersionId = "version-voice-new";
  changedVoice.outputState!.versions.push({ id: "version-voice-new", artifactIds: ["art-plan", "art-audio"],
    schemaVersion: "video-factory/voiceover-plan-v3" } as never);
  view.rerender(<NarrationTimingEditor runId="run-timing" revision={8} voiceNode={changedVoice}
    artifacts={artifacts} interventionId="intervention-new" disabled={false} />);
  await screen.findByText(/旧草稿保持只读/);
  expect(screen.getByRole("button", { name: /应用时间调整|继续此时间调整/ })).toBeDisabled();
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");

  fireEvent.click(screen.getByRole("button", { name: "重新读取当前版本" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "放弃时间草稿并重新读取" }))
    .getByRole("button", { name: "放弃草稿并重新读取" }));

  await waitFor(() => expect(screen.getByLabelText("第 2 段落点")).toHaveValue("start"));
  expect(screen.queryByText(/旧草稿只读/)).not.toBeInTheDocument();
  expect(screen.queryByText(/旧草稿保持只读/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "应用时间调整并重新试听" })).toBeEnabled();
  expect(window.localStorage.getItem("vf:narration-timing-draft:run-timing")).toBeNull();
  expect(narrationPlan).toHaveBeenCalledTimes(3);
  expect(dispatch).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it.each(["v2", "v3"])("uses only receipt-bound group audio at the %s first-fit stop and ignores unrelated raw audio", async (mode) => {
  const preview = previewFixture();
  if (mode === "v3") preview.plan = {
    version: "video-factory/narration-plan-v3", mode: "character_turns", audioStrategy: "external_tts",
    script: v2Plan.script, visualPlan: { ...v2Plan.visualPlan, fps: 30 }, edgeTrim: "none", subtitleMode: "provider_sentence",
    source: { sourceContextId: "sc-timing-test", canonicalSourceSha256: "c".repeat(64) },
    silences: [], groups: v2Plan.groups.map((g, i) => ({ id: g.id, turnId: g.id, speakerId: "speaker-" + i,
      voiceProfileId: "minimax:female-shaonv", sourceScenePositions: [1], text: g.text,
      window: g.window, placement: { anchor: "start", offsetFrames: 0 } })),
  };
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(preview);
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "a".repeat(64), resultVoiceVersionId: "voice-new", isCurrent: true }));
  const conflicted = structuredClone(voiceNode) as unknown as StudioNode;
  delete (conflicted.outputState as { effectiveVersionId?: string }).effectiveVersionId;
  (conflicted.output as Record<string, unknown>).conflict = {
    code: mode === "v3" ? "NARRATION_TURN_DOES_NOT_FIT" : "NARRATION_GROUP_DOES_NOT_FIT_V2", requiredFrames: 135, availableFrames: 90 };
  (conflicted.output as Record<string, unknown>).voiceSourceReceipt = {
    voiceInputVersionId: "input-voice", sourceOperationId: "tts-original-op",
    manifestArtifactId: "manifest", manifestSha256: "m".repeat(64), receiptArtifactId: "receipt",
    groupAudioArtifacts: [{ groupId: "ng-1", artifactId: "raw-a" }, { groupId: "ng-2", artifactId: "raw-b" }],
  };
  const sourceArtifacts: StudioArtifact[] = [
    { id: "manifest", kind: "voice_source_manifest", sha256: "1".repeat(64), sizeBytes: 1, contentType: "application/json", producerNodeId: "voice", createdAt: "" },
    { id: "receipt", kind: "voice_source_receipt", sha256: "2".repeat(64), sizeBytes: 1, contentType: "application/json", producerNodeId: "voice", createdAt: "" },
    ...["raw-a", "raw-b", "raw-unrelated"].map((id) => ({ id, kind: "voiceover_raw", sha256: "3".repeat(64), sizeBytes: 2,
      contentType: "audio/mpeg", producerNodeId: "voice", createdAt: "" } as StudioArtifact)),
  ];
  render(<NarrationTimingEditor runId="run-timing" revision={7} voiceNode={conflicted} artifacts={sourceArtifacts}
    interventionId="intervention-active" disabled={false} />);
  const region = await screen.findByRole("region", { name: "只调整配音时间" });
  await screen.findByText("第一句。");
  expect([...region.querySelectorAll("audio")].map((audio) => audio.getAttribute("src"))).toEqual([
    "/api/runs/run-timing/artifacts/raw-a/content",
    "/api/runs/run-timing/artifacts/raw-b/content",
  ]);
  fireEvent.change(screen.getByLabelText("第 1 段窗口结束秒"), { target: { value: "4.5" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect(dispatch.mock.calls[0]![1]).toMatchObject({ sourceContextId: "sc-timing-test",
    source: { kind: "materialized_operation", sourceVoiceOperationId: "tts-original-op" },
    layout: { narrationPlanVersion: preview.plan.version, groups: [{ groupId: "ng-1", window: { endFrame: 135 } }, {}] } });
});

it.each([true, "relayout"])("uses the adopted voice version when the retained conflict is resolved with %s", async (resolved) => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockResolvedValue({ nodes: [] } as unknown as StudioRunDetail);
  vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => ({
    requestId, state: "applied", requestDigest: "d".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }));
  const recovered = structuredClone(voiceNode);
  recovered.output = { ...(recovered.output as Record<string, unknown>), conflictResolved: resolved,
    conflict: { code: "NARRATION_GROUP_DOES_NOT_FIT_V2", requiredFrames: 135, availableFrames: 90 },
    voiceSourceReceipt: { voiceInputVersionId: "input-old", sourceOperationId: "tts-original-op",
      manifestArtifactId: "manifest", manifestSha256: "m".repeat(64), receiptArtifactId: "receipt",
      groupAudioArtifacts: [{ groupId: "ng-1", artifactId: "raw-old" }] },
  };
  const recoveredArtifacts: StudioArtifact[] = [...artifacts,
    { id: "raw-old", kind: "voiceover_raw", sha256: "3".repeat(64), sizeBytes: 2, contentType: "audio/mpeg", producerNodeId: "voice", createdAt: "" },
  ];
  render(<NarrationTimingEditor runId="run-timing" revision={7} voiceNode={recovered} artifacts={recoveredArtifacts}
    interventionId="intervention-active" disabled={false} />);
  await screen.findByText("第一句。");
  const region = screen.getByRole("region", { name: "只调整配音时间" });
  expect(within(region).queryByText(/上一段放不下/)).toBeNull();
  expect(region.querySelector("audio")?.getAttribute("src")).toBe("/api/runs/run-timing/artifacts/art-audio/content");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  fireEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect((dispatch.mock.calls[0]![1] as any).source.kind).toBe("voice_version");
  expect((dispatch.mock.calls[0]![1] as any).source.voiceVersionId).toBe("version-voice-1");
});

it("keeps keyboard focus in the dirty reload confirmation and Escape returns without losing the draft", async () => {
  vi.spyOn(studioApi, "narrationPlan").mockResolvedValue(previewFixture());
  const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
  renderEditor();
  await screen.findByText("第一句。");
  fireEvent.change(screen.getByLabelText("第 2 段落点"), { target: { value: "end" } });
  const reload = screen.getByRole("button", { name: "重新读取当前版本" });
  reload.focus();
  fireEvent.click(reload);
  const dialog = screen.getByRole("alertdialog", { name: "放弃时间草稿并重新读取" });
  const keep = within(dialog).getByRole("button", { name: "返回继续编辑" });
  const discard = within(dialog).getByRole("button", { name: "放弃草稿并重新读取" });
  expect(keep).toHaveFocus();
  discard.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(keep).toHaveFocus();
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(discard).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(reload).toHaveFocus();
  expect(screen.getByLabelText("第 2 段落点")).toHaveValue("end");
  expect(dispatch).not.toHaveBeenCalled();
});
