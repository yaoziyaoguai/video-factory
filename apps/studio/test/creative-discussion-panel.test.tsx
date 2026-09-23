import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
import { studioApi } from "../src/client/api.js";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot } from "../src/shared/api.js";

const sha = "a".repeat(64);

function review(overrides: Partial<StudioCreativeReviewSnapshot> = {}): StudioCreativeReviewSnapshot {
  return {
    runId: "run-creative",
    runRevision: 8,
    stage: "script",
    reviewRevision: 3,
    draftSha256: sha,
    draftArtifactId: "script-draft-1",
    phase: "waiting_user",
    allowedActions: ["discuss", "edit_draft", "adopt_proposal", "undo_draft", "confirm", "return_to_stage"],
    returnTargets: [{
      stage: "treatment",
      label: "返回前期构思",
      impact: "脚本、导演方案和后续确认会失效；历史稿件与已经可用的素材会保留，重新确认后再生成后续方案。",
    }],
    draft: {
      narrativeArc: "问题到答案",
      scenes: [{ id: "scene-1", position: 1, duration: 8, narration: "先看结果。", visual_prompt: "结果对照" }],
    },
    messages: [],
    proposals: [],
    effectiveUserInstructions: [],
    blockingIssues: [],
    ...overrides,
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(() => values.clear()),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    },
  });
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("CreativeDiscussionPanel", () => {
  it("reconciles a pending command without sending a new one", async () => {
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify({ commandId: "saved-command", action: "discuss" }));
    const read = vi.spyOn(studioApi, "creativeReviewCommand")
      .mockResolvedValueOnce({ commandId: "saved-command", status: "unknown", observationUrl: "/pending" })
      .mockResolvedValueOnce({ commandId: "saved-command", status: "completed", observationUrl: "/done" });
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByText(/结果未确定；请稍后核对/)).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByText(/上一条操作已完成。请刷新查看当前方案/)).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("does not call a completed command unknown when local reconciliation cleanup fails", async () => {
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify({ commandId: "saved-command", action: "discuss" }));
    vi.spyOn(studioApi, "creativeReviewCommand").mockResolvedValue({ commandId: "saved-command", status: "completed", observationUrl: "/done" });
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByText(/上一条操作已完成，但本机恢复记录未清理/)).toBeInTheDocument();
    expect(screen.queryByText(/暂时无法核对上一条操作/)).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("signals only a genuinely new draft in the same run and resets the baseline on run switch", () => {
    vi.useFakeTimers();
    try {
      const onCommand = vi.fn(async () => undefined);
      const first = review();
      const { rerender, unmount } = render(<CreativeDiscussionPanel review={first} busy={false} onCommand={onCommand} />);
      const article = screen.getByRole("article", { name: "当前脚本" });
      expect(article).not.toHaveClass("stage-handoff");
      const second = { ...first, draftArtifactId: "script-draft-2", draftSha256: "b".repeat(64) };
      rerender(<CreativeDiscussionPanel review={second} busy={false} onCommand={onCommand} />);
      act(() => vi.advanceTimersByTime(20));
      expect(screen.getByRole("status", { name: "" })).toHaveTextContent("当前稿件已更新");
      expect(article).toHaveClass("stage-handoff");
      expect(screen.getByRole("article", { name: "当前脚本" })).toBe(article);
      const third = { ...second, draftArtifactId: "script-draft-3", draftSha256: "c".repeat(64) };
      rerender(<CreativeDiscussionPanel review={third} busy={false} onCommand={onCommand} />);
      act(() => vi.advanceTimersByTime(20));
      expect(article).toHaveClass("stage-handoff");
      act(() => vi.advanceTimersByTime(1000));
      expect(article).not.toHaveClass("stage-handoff");
      rerender(<CreativeDiscussionPanel review={{ ...third, reviewRevision: third.reviewRevision + 1 }} busy={false} onCommand={onCommand} />);
      expect(article).not.toHaveClass("stage-handoff");
      rerender(<CreativeDiscussionPanel review={{ ...third, runId: "another-run" }} busy={false} onCommand={onCommand} />);
      expect(article).not.toHaveClass("stage-handoff");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an incomplete review without a score and binds explicit consent to that check", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      status: "incomplete", summary: "请求已结清，但没有有效复核结论", issues: [], checkIdentity: "b".repeat(64),
    } })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("独立复核未完成 · 无评分")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接受复核未完成，采用本版" }));
    // 应用内风险弹窗出现；不再使用 window.confirm。
    const dialog = screen.getByRole("dialog");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    // 关闭（返回查看）不发送命令。
    await userEvent.click(within(dialog).getByRole("button", { name: "返回查看" }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 再次打开并确认：身份一致时才发送，携带看到的复核身份。
    await userEvent.click(screen.getByRole("button", { name: "接受复核未完成，采用本版" }));
    await userEvent.click(screen.getByRole("button", { name: /接受复核未完成的风险并采用本版/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acknowledgeIncomplete: true, expectedCheckIdentity: "b".repeat(64), baseDraftSha256: sha });
  });

  it("refuses to confirm when the displayed identity changed while the dialog was open", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review({ checkResult: {
      status: "incomplete", summary: "请求已结清，但没有有效复核结论", issues: [], checkIdentity: "b".repeat(64),
    } })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "接受复核未完成，采用本版" }));
    const dialog = screen.getByRole("dialog");
    // 弹窗打开期间服务端换了稿/换了复核。
    rendered.rerender(<CreativeDiscussionPanel review={review({
      reviewRevision: 4,
      draftSha256: "c".repeat(64),
      checkResult: { status: "incomplete", summary: "新的复核结论", issues: [], checkIdentity: "d".repeat(64) },
    })} busy={false} onCommand={onCommand} />);
    await userEvent.click(within(dialog).getByRole("button", { name: /接受复核未完成的风险并采用本版/ }));
    // 不能把旧文案当作新身份提交。
    expect(onCommand).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/内容已更新，请重新查看后确认/)).toBeInTheDocument();
  });

  it("keeps the in-app return confirmation bound to the displayed stage and impact", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "返回前期构思" }));
    const dialog = screen.getByRole("dialog");
    expect(confirmSpy).not.toHaveBeenCalled();
    // 弹窗展示原有影响范围与用户看到的稿件身份。
    expect(dialog).toHaveTextContent("脚本、导演方案和后续确认会失效");
    expect(dialog).toHaveTextContent("脚本");
    await userEvent.click(within(dialog).getByRole("button", { name: /仍然返回/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "return_to_stage", targetStage: "treatment", acknowledgeImpact: true });
  });

  it("allows returning from an unchanged checked draft", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      status: "incomplete", summary: "复核尚未完成", issues: [], checkIdentity: "b".repeat(64),
    } })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "返回前期构思" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /仍然返回/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "return_to_stage", targetStage: "treatment" });
  });

  it("does not return from a dialog opened for another run with identical revisions", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const checked = { status: "incomplete" as const, summary: "复核尚未完成", issues: [] as [], checkIdentity: "b".repeat(64) };
    const rendered = render(<CreativeDiscussionPanel review={review({ checkResult: checked })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "返回前期构思" }));
    rendered.rerender(<CreativeDiscussionPanel review={review({ runId: "another-run", checkResult: checked })} busy={false} onCommand={onCommand} />);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /仍然返回/ }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByText(/内容已更新，请重新查看后确认/)).toBeInTheDocument();
  });

  it("keeps the composer usable in memory when reading stored drafts fails", () => {
    vi.mocked(window.localStorage.getItem).mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/本机草稿无法保存/)).toBeInTheDocument();
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    fireEvent.change(composer, { target: { value: "存储坏了也能打字" } });
    expect(composer).toHaveValue("存储坏了也能打字");
  });

  it("does not send a command when the local pending record cannot be written", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "先写下来");
    vi.mocked(window.localStorage.setItem).mockImplementation(() => {
      throw new Error("storage full");
    });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText(/本机存储/)).toBeInTheDocument());
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("keeps a hand-edited draft when its command record cannot be written", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = screen.getByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "不要丢掉这句手写旁白");
    const originalSetItem = vi.mocked(window.localStorage.setItem).getMockImplementation()!;
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => {
      if (key.startsWith("vf:creative-command:")) throw new Error("storage full");
      originalSetItem(key, value);
    });

    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await screen.findByText(/保存未完成，输入仍保留/);
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("不要丢掉这句手写旁白");
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeDisabled();
    expect(screen.queryByText(/修订已保存。/)).not.toBeInTheDocument();
  });

  it("warns when an unsaved hand edit cannot be cached locally", async () => {
    const originalSetItem = vi.mocked(window.localStorage.setItem).getMockImplementation()!;
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => {
      if (key.endsWith(":edit")) throw new Error("storage full");
      originalSetItem(key, value);
    });
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = screen.getByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "关闭页面前要复制的文字");

    expect(narration).toHaveValue("关闭页面前要复制的文字");
    expect(screen.getByText(/手工修订无法在本机保存.*关闭页面前请复制/)).toBeInTheDocument();
  });

  it("reports success when the server accepted but local cleanup failed", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "发送这条");
    vi.mocked(window.localStorage.removeItem).mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    // 服务器已成功：不能谎报"提交失败"诱导用户重发。
    const notice = screen.getByText(/操作已完成，本机恢复记录未清理/);
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).not.toHaveTextContent("再试");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("only sends stock risk consent after showing the risk and receiving confirmation", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<CreativeDiscussionPanel review={review({ stage: "director", qualityAdvisories: [
      { scenePositions: [1], reason: "候选仅得20分，视觉核验未完成" },
    ] })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/候选仅得20分/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接受素材风险，先制作首版" }));
    // 应用内弹窗出现，先看风险再决定；关闭不发送。
    const dialog = screen.getByRole("dialog");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "返回查看" }));
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "接受素材风险，先制作首版" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /接受素材风险，先制作首版/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acceptQualityFallback: true, baseDraftSha256: sha });
  });
  it("preserves unsaved manual edits across a new server draft and refuses to overwrite it", async () => {
    const onCommand = vi.fn(async () => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = await screen.findByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "我还没保存的文字");
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeDisabled();
    rendered.rerender(<CreativeDiscussionPanel review={review({
      draftSha256: "b".repeat(64), reviewRevision: 4,
      draft: { ...review().draft as object, narrativeArc: "服务端的新方案" },
    })} busy={false} onCommand={onCommand} />);
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("我还没保存的文字");
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(screen.getByLabelText("叙事推进")).toHaveValue("服务端的新方案");
  });

  it("restores a manual edit after remount and keeps it when saving fails", async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error("服务端保存失败"));
    const rendered = render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const field = await screen.findByLabelText("分镜 1 · 旁白");
    await userEvent.clear(field);
    await userEvent.type(field, "刷新后仍要保留");
    rendered.unmount();
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    expect(await screen.findByLabelText("分镜 1 · 旁白")).toHaveValue("刷新后仍要保留");
    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await screen.findByText(/保存未完成，输入仍保留/);
    expect(screen.queryByText(/修订已保存。/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("刷新后仍要保留");
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({ action: "edit_draft", expectedRunRevision: 8, baseDraftSha256: sha });
  });

  it("edits director visual rules without changing shot structure or authorizing production", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const document = { visualBible: { continuity: "保持连续性", pacing: "舒缓" }, shots: [{ scenePosition: 1, deliveryType: "stock_video" }] };
    render(<CreativeDiscussionPanel review={review({ stage: "director", draft: document })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const field = await screen.findByLabelText("全片视觉规则 · 节奏");
    await userEvent.clear(field);
    await userEvent.type(field, "加快开场，保留结尾停顿");
    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await screen.findByText(/修订已保存。/);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({ action: "edit_draft", document: { visualBible: { pacing: "加快开场，保留结尾停顿" }, shots: document.shots } });
  });

  it("keeps confirm and send unavailable when the server has not allowed those actions", async () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review({ allowedActions: [] })} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "继续");
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("renders a readable stage, sends a selected scene with Ctrl+Enter, and ignores IME Enter", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("问题到答案")).toBeInTheDocument();
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    await userEvent.click(screen.getByLabelText("第 1 段"));
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "把这一段说得更直接");
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      action: "discuss",
      message: "把这一段说得更直接",
      selection: { kind: "scene", ids: ["scene-1"], scenePositions: [1] },
    });
  });

  it("shows server-computed return impact and only returns after explicit confirmation", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const button = screen.getByRole("button", { name: "返回前期构思" });
    await userEvent.click(button);
    // 应用内确认：先关闭（不发送），再打开并确认。
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "返回查看" }));
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: /仍然返回/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      action: "return_to_stage",
      targetStage: "treatment",
      acknowledgeImpact: true,
    });
  });

  it("keeps the input and reuses the same command id after an uncertain submit failure", async () => {
    const onCommand = vi.fn<(_input: StudioCreativeReviewCommandInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("连接在响应前中断"))
      .mockResolvedValueOnce(undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "解释这一段");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alert");
    expect(composer).toHaveValue("解释这一段");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand.mock.calls[1]?.[0].commandId).toBe(onCommand.mock.calls[0]?.[0].commandId);
  });

  it("does not overwrite an unsent draft when polling refreshes the same run stage", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "我正在写的修改要求");

    rendered.rerender(<CreativeDiscussionPanel review={review({ runRevision: 9, reviewRevision: 4 })} busy={false} onCommand={onCommand} />);

    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("我正在写的修改要求");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("shows an actionable conflict and keeps the draft for the refreshed version", async () => {
    const onCommand = vi.fn<(_input: StudioCreativeReviewCommandInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("当前方案已经更新，请查看最新版后重试。"));
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "保留这段输入");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("当前方案已经更新，请查看最新版后重试。");
    expect(composer).toHaveValue("保留这段输入");
  });

  it("explains unavailable media without inviting the user to repeat the same confirmation", () => {
    render(<CreativeDiscussionPanel review={review({
      stage: "director",
      blockingIssues: [{
        target: "source",
        scenePositions: [1, 2, 3, 4],
        reason: "图库候选不足：没有符合当前方案的素材",
        requiredChange: "补充素材，或告诉导演允许怎样调整画面路线。",
      }],
    })} busy={false} onCommand={vi.fn(async () => undefined)} />);

    expect(screen.getByRole("heading", { name: "当前导演方案需要你决定" })).toBeInTheDocument();
    expect(screen.getByText(/已保留你确认的方案，不会自动改成生成画面/)).toBeInTheDocument();
    expect(screen.getByText(/镜头 1、2、3、4/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改后重新检查" })).toBeInTheDocument();
  });

  it("keeps confirmation available under a repair verdict but only after an explicit acknowledgement", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<CreativeDiscussionPanel review={review({
      stage: "director",
      checkResult: {
        verdict: "repair",
        score: 78,
        summary: "独立复核未通过",
        checkIdentity: "c1d1e1f1" + "0".repeat(56),
        issues: [{
          severity: "blocking",
          criterion: "重新审片条件",
          evidence: "候选镜头仍写成“初次审片”",
          repairInstruction: "先复查现有素材，再决定是否更换。",
        }],
      },
    })} busy={false} onCommand={onCommand} />);

    expect(screen.getByText(/有 1 处需要调整/)).toBeInTheDocument();
    expect(screen.getByText("先复查现有素材，再决定是否更换。")).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "看过意见，仍然确认" });
    expect(confirmButton).toBeEnabled();
    expect(screen.queryByRole("button", { name: "确认当前方案，继续" })).not.toBeInTheDocument();

    // 复核是"提议"不是"否决"：按钮可用，但默认不承担；应用内弹窗先展示意见，关闭不发送。
    await userEvent.click(confirmButton);
    const repairDialog = screen.getByRole("dialog");
    expect(confirmSpy).not.toHaveBeenCalled();
    await userEvent.click(within(repairDialog).getByRole("button", { name: "返回查看" }));
    expect(onCommand).not.toHaveBeenCalled();

    // 显式承担后才放行，并带上 acknowledgeRepair 让这次放行可追溯。
    await userEvent.click(confirmButton);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /看过意见，仍采用本版/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    // 身份必须跟着一起发：服务端会拿它跟记录里的那一条比对，缺了就直接拒收这条命令。
    // 只有 acknowledgeRepair 而没带编号，"仍然确认"会在服务端变成一条无法送达的命令。
    expect(onCommand.mock.calls[0]![0]).toMatchObject({
      action: "confirm",
      acknowledgeRepair: true,
      expectedCheckIdentity: "c1d1e1f1" + "0".repeat(56),
    });
  });

  it("prefills the composer from a check issue so the user does not retype a field-level instruction", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({
      stage: "director",
      checkResult: {
        verdict: "repair",
        score: 70,
        summary: "独立复核未通过",
        checkIdentity: "c1d1e1f1" + "0".repeat(56),
        issues: [{
          severity: "blocking",
          criterion: "声音原则与已声明能力相容",
          evidence: "上游 visualPlan 采用同期环境声",
          repairInstruction: "二选一：写回同期声，或明确接受改为纯旁白。",
        }],
      },
    })} busy={false} onCommand={onCommand} />);

    const composer = screen.getByPlaceholderText(/为什么这样开场/) as HTMLTextAreaElement;
    await userEvent.click(screen.getByRole("button", { name: "按这条意见改" }));
    expect(composer.value).toContain("二选一：写回同期声，或明确接受改为纯旁白。");
    expect(composer.value).toContain("只按下面这一条意见修改，不要扩大改动范围。");
    // 只预填不发送：改不改、怎么改仍由人按下发送键决定。
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "这条我不同意" }));
    expect(composer.value).toContain("这条意见我不接受，理由如下");
  });

  it("still offers confirmation while no repair verdict is outstanding", () => {
    render(<CreativeDiscussionPanel review={review({ stage: "director" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeEnabled();
  });

  it("names each creative stage the way the rest of the studio names it", () => {
    // 停点标题是创作者判断"我现在在确认哪一份东西"的唯一依据，所以三个阶段名逐段钉住：
    // treatment=前期构思、script=脚本、director=导演方案（与 PlanningStagesPanel 一致）。
    // 这里曾经把 treatment 显示成"导演方案"，于是停点说的名字和阶段列表说的名字对不上。
    const headingByStage = { treatment: "前期构思已生成，等你确认", script: "脚本已生成，等你确认", director: "导演方案已生成，等你确认" } as const;
    for (const [stage, heading] of Object.entries(headingByStage)) {
      const { unmount } = render(<CreativeDiscussionPanel review={review({ stage: stage as keyof typeof headingByStage })} busy={false} onCommand={vi.fn(async () => undefined)} />);
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.getByLabelText(`当前${heading.replace("已生成，等你确认", "")}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("saves a hand-edited draft as an edit_draft command carrying the full document", async () => {
    // 人工修订与 AI 修订同一条制度：编辑器只改文字性字段，保存即提交整份修订稿，
    // 由服务端按阶段合同整体校验、随后停点带新复核意见重现。
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);

    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = screen.getByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "第一句就给结果。");

    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const command = onCommand.mock.calls[0]![0];
    expect(command.action).toBe("edit_draft");
    expect(command.baseDraftSha256).toBe(sha);
    expect(command.expectedReviewRevision).toBe(3);
    const document = (command as unknown as { document: { scenes: Array<{ narration: string }> } }).document;
    expect(document.scenes[0]!.narration).toBe("第一句就给结果。");
  });
});
