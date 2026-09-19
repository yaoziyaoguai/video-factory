import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
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
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const button = screen.getByRole("button", { name: "返回前期构思" });
    await userEvent.click(button);
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(button);
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
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

    // 复核是"提议"不是"否决"：按钮可用，但默认不承担，直接点不会推走流程。
    await userEvent.click(confirmButton);
    expect(confirmSpy).toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();

    // 显式承担后才放行，并带上 acknowledgeRepair 让这次放行可追溯。
    confirmSpy.mockReturnValue(true);
    await userEvent.click(confirmButton);
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
