import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
import { NodeDeliveryPreview } from "../src/client/components/NodeDeliveryPreview.js";
import { studioApi } from "../src/client/api.js";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot, StudioVoiceProfile } from "../src/shared/api.js";

const script = JSON.parse(readFileSync("../../tests/fixtures/character-drama-cases.json", "utf8")).script;
const voices: StudioVoiceProfile[] = script.characters.map((c: { name: string; voice_profile_id: string }) => ({
  id: c.voice_profile_id, label: c.name + "音色", providerId: "minimax-tts-v1", engine: "minimax", locale: "zh-CN",
}));
const review = (): StudioCreativeReviewSnapshot => ({
  runId: "run-character-editor", runRevision: 1, stage: "script", reviewRevision: 1,
  draftVersionId: "version-a", draftArtifactId: "artifact-a", draftSha256: "a".repeat(64),
  phase: "waiting_user", allowedActions: ["edit_draft", "confirm", "audit_current", "revise"],
  draft: structuredClone(script), messages: [], proposals: [], effectiveUserInstructions: [], blockingIssues: [], returnTargets: [],
});
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });

it("edits six stable characters and dialogue through the existing save command, without auto audit", async () => {
  vi.spyOn(studioApi, "voices").mockResolvedValue(voices);
  const command = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
  render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={command} />);
  fireEvent.click(screen.getByText(/手动修订这份稿件/));
  const first = await screen.findByLabelText("角色 1 · 名称");
  fireEvent.change(first, { target: { value: "新店主" } });
  expect(screen.getByRole("button", { name: "删除角色 1" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "添加角色" }));
  fireEvent.click(screen.getByRole("button", { name: "添加角色" }));
  fireEvent.change(screen.getByLabelText("角色 6 · 名称"), { target: { value: "第六位" } });
  fireEvent.change(screen.getByLabelText("角色 5 · 外观"), { target: { value: "蓝色帽子，白色外套。" } });
  fireEvent.change(screen.getByLabelText("角色 6 · 外观"), { target: { value: "红色围巾，黑色短发。" } });
  fireEvent.change(screen.getByLabelText("角色 1 · 音色"), { target: { value: voices[1]!.id } });
  fireEvent.change(screen.getByLabelText("镜头 1 · 台词 1 · 说话角色"), { target: { value: "student" } });
  fireEvent.change(screen.getByLabelText("镜头 1 · 台词 1 · 正文"), { target: { value: "我来找。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
  await waitFor(() => expect(command).toHaveBeenCalledOnce());
  const input = command.mock.calls[0]![0] as unknown as { action: string; document: typeof script };
  expect(input.action).toBe("edit_draft");
  expect(input.document.characters).toHaveLength(6);
  expect(input.document.characters[0]).toMatchObject({ id: "shopkeeper", name: "新店主", voice_profile_id: voices[1]!.id });
  expect(input.document.characters[5].voice_profile_id).toBeNull();
  expect(input.document.scenes[0].dialogue[0]).toMatchObject({ id: "turn_01", speaker_id: "student", text: "我来找。" });
  expect(input.document.scenes[0]).not.toHaveProperty("narration");
});

it("retains a character draft across refresh but cannot save it over another version", async () => {
  vi.spyOn(studioApi, "voices").mockResolvedValue(voices);
  const command = vi.fn();
  const current = review();
  const view = render(<CreativeDiscussionPanel review={current} busy={false} onCommand={command} />);
  fireEvent.click(screen.getByText(/手动修订这份稿件/));
  fireEvent.change(await screen.findByLabelText("角色 4 · 名称"), { target: { value: "我的学生" } });
  view.unmount();
  render(<CreativeDiscussionPanel review={{ ...current, runRevision: 2, draftVersionId: "version-b" }} busy={false} onCommand={command} />);
  expect(await screen.findByLabelText("角色 4 · 名称")).toHaveValue("我的学生");
  expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
  expect(command).not.toHaveBeenCalled();
});

it("reads role names and ordered dialogue in historical script deliveries", () => {
  render(<NodeDeliveryPreview nodeId="script" value={script} />);
  expect(screen.getAllByText("店主").length).toBeGreaterThan(0);
  expect(screen.getByText(script.scenes[0].dialogue[0].text)).toBeInTheDocument();
  expect(screen.getByText(script.scenes[3].dialogue[1].text)).toBeInTheDocument();
  expect(screen.queryByText("旁白 · 观众听到的内容")).not.toBeInTheDocument();
});

it("native character editing keeps dialogue and sound intent without promising a TTS voice", async () => {
  const user = userEvent.setup();
  const catalog = vi.spyOn(studioApi, "voices").mockResolvedValue(voices);
  const command = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
  render(<CreativeDiscussionPanel review={{ ...review(), runId: "run-native-character-editor" }} nativeAudio busy={false} onCommand={command} />);
  expect(screen.queryAllByText("已选配音音色")).toHaveLength(0);
  await user.click(screen.getByText(/手动修订这份稿件/));
  const intent = await screen.findByLabelText("角色 1 · 声音要求");
  expect(screen.queryByLabelText("角色 1 · 音色")).not.toBeInTheDocument();
  expect(screen.queryByText(/按角色分别配音/)).not.toBeInTheDocument();
  expect(catalog).not.toHaveBeenCalled();
  await user.clear(intent);
  await user.type(intent, "低声说话，略带着急");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  await waitFor(() => expect(command).toHaveBeenCalledOnce());
  const saved = command.mock.calls[0]![0] as unknown as { action: string; document: typeof script };
  expect(saved.action).toBe("edit_draft");
  expect(saved.document.characters[0]).toMatchObject({ voice_intent: "低声说话，略带着急", voice_profile_id: script.characters[0].voice_profile_id });
  expect(saved.document.scenes).toEqual(script.scenes);
});

it("native script deliveries label pauses as intentions, not verified TTS timing", () => {
  render(<NodeDeliveryPreview nodeId="script" value={script} nativeAudio />);
  expect(screen.queryAllByText("已选配音音色")).toHaveLength(0);
  expect(screen.queryAllByText("尚未选择音色")).toHaveLength(0);
  expect(screen.getAllByText(/停顿意图/).length).toBeGreaterThan(0);
  expect(screen.getByText(script.scenes[0].dialogue[0].text)).toBeInTheDocument();
});
