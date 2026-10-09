import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
import { studioApi } from "../src/client/api.js";
import { parseStudioCreativeReviewCommandInput, type StudioCreativeReviewCommandInput, type StudioCreativeReviewCommandReceipt, type StudioCreativeReviewSnapshot } from "../src/shared/api.js";

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
    allowedActions: ["discuss", "revise", "audit_current", "edit_draft", "adopt_proposal", "undo_draft", "confirm", "return_to_stage"],
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

function storedDiscussion(commandId: string, stage: StudioCreativeReviewSnapshot["stage"] = "script"): StudioCreativeReviewCommandInput {
  return { commandId, action: "discuss", stage, expectedRunRevision: 8, expectedReviewRevision: 3,
    baseDraftSha256: sha, message: "原意见" };
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
  // 标签会话草稿（DG-UX-01 修复后的存储位置）同样逐测试隔离。
  const sessionValues = new Map<string, string>();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      clear: vi.fn(() => sessionValues.clear()),
      getItem: vi.fn((key: string) => sessionValues.get(key) ?? null),
      removeItem: vi.fn((key: string) => sessionValues.delete(key)),
      setItem: vi.fn((key: string, value: string) => sessionValues.set(key, value)),
    },
  });
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("early duration decision", () => {
  it("keeps explicit re-audit reachable after a completed audit and removes undo only when no prior draft exists", async () => {
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const current = review({ checkResult: { verdict: "pass", score: 90, summary: "本稿可用", issues: [], checkIdentity: "audit-ready" } });
    const { rerender } = render(<CreativeDiscussionPanel review={current} busy={false} onCommand={onCommand} />);
    expect(screen.queryByRole("button", { name: "撤销本轮修改" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新审计当前版本（会调用模型）" }));
    expect(onCommand.mock.calls[0]![0].action).toBe("audit_current");
    rerender(<CreativeDiscussionPanel review={{ ...current, previousDraft: current.draft }} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("button", { name: "撤销本轮修改" })).toBeEnabled();
  });
  it.each(["running", "unknown", "failed", "not_accepted", "completed"] as const)("shows the durable original request after a fresh mount (%s) without duplicating its completed message", async status => {
    const command = storedDiscussion("durable-original");
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const original = { ...command, message: "请保留办公室预算本的对白" };
    render(<CreativeDiscussionPanel review={review({ consultationOperations: [{ commandId: original.commandId, command: original, status }],
      messages: status === "completed" ? [{ id: "user-message", commandId: original.commandId, role: "user", text: original.message }] : [] })}
      busy={false} onCommand={onCommand} />);
    expect(screen.getAllByText(original.message)).toHaveLength(1);
    expect(screen.getByText(status === "running" || status === "unknown" ? "已提交 · 结果待核" : status === "failed" ? "执行失败 · 已核清" : status === "not_accepted" ? "未受理" : "已完成")).toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
    if (status === "running" || status === "unknown") {
      expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    }
  });

  it("shows proposal conflicts and only sets the chosen proposal as the current draft", async () => {
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ proposals: [{ proposalId: "long-proposal",
      baseDraftSha256: sha, document: { scenes: [{ position: 1, duration: 38, narration: "完整保留的候选台词。" }] },
      duration: { versionId: "proposal-v1", totalSeconds: 38, totalFrames: 1140, scenes: [{ position: 1, durationSeconds: 38, frameCount: 1140 }] },
      changeSummary: ["展开说明"], conflicts: [{ code: "duration_commitment_conflict", scenePositions: [1],
        detail: "建议 38 秒，超出最多 30 秒的要求。" }] }],
      duration: { policy: "content-led-v1", referenceSeconds: 24, briefSha256: "b".repeat(64), commitment: { maxSeconds: 30 } } })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/此备选约 38 秒.*1140 帧.*共 1 镜/)).toBeInTheDocument();
    expect(screen.getByText(/备选仍受当前时长要求约束：最多 30 秒/)).toBeInTheDocument();
    expect(screen.getByText("建议 38 秒，超出最多 30 秒的要求。")).toBeInTheDocument();
    expect(screen.getByText(/不会确认本阶段或开始后续制作/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "设为当前草稿" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "adopt_proposal", proposalId: "long-proposal" });
  });

  function durationReview(overrides: Partial<StudioCreativeReviewSnapshot> = {}) {
    return review({ draftVersionId: "script-v2", allowedActions: [...review().allowedActions, "update_duration"],
      duration: { policy: "content-led-v1", briefSha256: "b".repeat(64), referenceSeconds: 24,
        proposal: { versionId: "script-v2", totalFrames: 360, totalSeconds: 12,
          scenes: [{ position: 1, frameCount: 360, durationSeconds: 12 }] } }, ...overrides });
  }

  it("shows the actual proposal and adopts its version and duration in the existing content decision", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={durationReview()} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("建议成片约 12 秒，共 1 镜")).toBeInTheDocument();
    expect(screen.getByText(/参考目标：24 秒/)).toBeInTheDocument();
    expect(screen.getByText(/费用待方案核价/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 镜：12 秒/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "采用此脚本 · 约12秒（未审计）" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", baseDraftVersionId: "script-v2", acknowledgeUnaudited: true });
    expect(onCommand.mock.calls[0]![0]).not.toHaveProperty("durationAmendment");
  });

  it("saves a single explicit boundary without adopting the script or inventing a minimum", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={durationReview()} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.type(screen.getByLabelText("最多秒数（可不填）"), "30");
    expect(screen.getByRole("button", { name: "采用此脚本 · 约12秒（未审计）" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "仅保存时长要求" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "update_duration", baseDraftVersionId: "script-v2",
      durationAmendment: { expectedBriefSha256: "b".repeat(64), range: { maxSeconds: 30 } } });
    const command = onCommand.mock.calls[0]![0];
    expect(command.action).toBe("update_duration");
    if (command.action !== "update_duration") throw new Error("expected duration command");
    expect(command.durationAmendment.range).not.toHaveProperty("minSeconds");
  });

  it("adopts a conflicting current script with its amended boundary in one explicit unaudited decision", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const current = durationReview();
    current.duration!.commitment = { maxSeconds: 10 };
    current.conflicts = [{ code: "duration_commitment_conflict", scenePositions: [1], detail: "本稿12秒超过最多10秒" }];
    current.checkResult = { verdict: "repair", score: 70, summary: "开头仍有建议", issues: [], checkIdentity: "check-current" };
    render(<CreativeDiscussionPanel review={current} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    const max = screen.getByLabelText("最多秒数（可不填）");
    await user.clear(max);
    await user.type(max, "12");
    expect(screen.getByText(/变更时长要求后，这版稿件未重新审计/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "按新时长要求采用当前脚本（未审计）" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", baseDraftVersionId: "script-v2",
      expectedCheckIdentity: "check-current", acknowledgeRepair: true, acknowledgeUnaudited: true,
      durationAmendment: { expectedBriefSha256: "b".repeat(64), range: { maxSeconds: 12 } } });
  });

  it("keeps unsaved duration input after remount and rejects a newer version with identical text", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const view = render(<CreativeDiscussionPanel review={durationReview()} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.type(screen.getByLabelText("最多秒数（可不填）"), "30");
    view.unmount();
    render(<CreativeDiscussionPanel review={durationReview({ draftVersionId: "script-v3" })} busy={false} onCommand={onCommand} />);
    expect(screen.getByLabelText("最多秒数（可不填）")).toHaveValue("30");
    expect(screen.getByText(/输入已保留但不能覆盖新版本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅保存时长要求" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "按新时长要求采用当前脚本（未审计）" })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "放弃时长修改" }));
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    expect(screen.getByLabelText("最多秒数（可不填）")).toHaveValue("");
  });

  it("clears a commitment explicitly and never bypasses a real capability conflict", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const current = durationReview();
    current.duration!.commitment = { minSeconds: 10, maxSeconds: 15 };
    current.conflicts = [{ code: "execution_capability_conflict", scenePositions: [1], detail: "型号只能供给10秒，本镜需要12秒" }];
    render(<CreativeDiscussionPanel review={current} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.click(screen.getByRole("checkbox", { name: /取消明确时长要求/ }));
    expect(screen.getByRole("button", { name: "按新时长要求采用当前脚本（未审计）" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "仅保存时长要求" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "update_duration", durationAmendment: { range: null } });
  });

  it("rejects an impossible frame range and still-conflicting adoption without losing the typed boundary", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={durationReview()} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    const max = screen.getByLabelText("最多秒数（可不填）");
    await user.type(max, "0.02");
    await user.click(screen.getByRole("button", { name: "仅保存时长要求" }));
    expect(screen.getByRole("alert")).toHaveTextContent("没有可执行的正整数帧");
    expect(max).toHaveValue("0.02");
    await user.clear(max);
    await user.type(max, "10");
    await user.click(screen.getByRole("button", { name: "按新时长要求采用当前脚本（未审计）" }));
    expect(screen.getByRole("alert")).toHaveTextContent("最多10秒冲突");
    expect(max).toHaveValue("10");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("keeps stock-risk consent and freezes the full version and brief when combining adoption", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const current = durationReview({ stage: "director", reviewPurpose: "material_plan", qualityAdvisories: [{ scenePositions: [1], reason: "素材只是示意" }],
      checkResult: { status: "incomplete", summary: "原审计未完成", issues: [], checkIdentity: "d".repeat(64) } });
    const view = render(<CreativeDiscussionPanel review={current} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.type(screen.getByLabelText("最多秒数（可不填）"), "20");
    await user.click(screen.getByRole("button", { name: "按新时长要求采用当前导演方案（未审计）" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("素材风险");
    expect(onCommand).not.toHaveBeenCalled();
    view.rerender(<CreativeDiscussionPanel review={{ ...current, draftVersionId: "same-sha-new-version" }} busy={false} onCommand={onCommand} />);
    await user.click(within(dialog).getByRole("button", { name: "接受素材风险，先制作首版" }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("内容已更新");
    view.rerender(<CreativeDiscussionPanel review={{ ...current, duration: { ...current.duration!, briefSha256: "c".repeat(64) } }} busy={false} onCommand={onCommand} />);
    await user.click(within(dialog).getByRole("button", { name: "接受素材风险，先制作首版" }));
    expect(onCommand).not.toHaveBeenCalled();
    // 回到原身份重新核对；正式提交仍经过共享HTTP parser，旧未完成知情与新未审分开。
    view.rerender(<CreativeDiscussionPanel review={current} busy={false} onCommand={onCommand} />);
    await user.click(within(dialog).getByRole("button", { name: "接受素材风险，先制作首版" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = parseStudioCreativeReviewCommandInput(onCommand.mock.calls[0]![0]);
    expect(command).toMatchObject({ action: "confirm", acknowledgeIncomplete: true, acknowledgeUnaudited: true,
      expectedCheckIdentity: "d".repeat(64), acceptQualityFallback: true, durationAmendment: { range: { maxSeconds: 20 } } });
  });

  it("allows duration saving beside an unknown discussion only with the server's independent-action proof", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    const pending = storedDiscussion("pending-duration");
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify(pending));
    render(<CreativeDiscussionPanel review={durationReview({ pendingConsultation: { commandId: pending.commandId,
      allowedActions: ["update_duration"], targetDraft: { versionId: "script-v2", sha256: sha } } })} busy={false} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "修改时长要求" }));
    await user.type(screen.getByLabelText("最多秒数（可不填）"), "30");
    await user.click(screen.getByRole("button", { name: "仅保存时长要求" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]![0].action).toBe("update_duration");
    expect(window.localStorage.getItem(`vf:creative-consultation-command:run-creative:${pending.commandId}`)).toBe(JSON.stringify(pending));
  });
});

// CLOUD-11/P5.2（V15/V16 UI 面）：人话问题＋折叠技术详情；补齐区只列兼容可用来源、
// 不默认选值；选择写入完整文档随 edit_draft 保存；无兼容来源给真实出口。
describe("evidence retrieval repair UI", () => {
  const badTreatment = {
    version: "video-factory/creative-treatment-v2",
    viewerPromise: "看完能避开三个决策坑",
    hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
    progression: [
      { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
      { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
    ],
    payoff: "低风险决策清单",
    visualPrinciples: ["真实动作"],
    soundPrinciples: ["环境声先行"],
    evidenceRequirements: [
      { beatId: "beat-1", claim: "已提供素材", requirement: "factual_support", suppliedSourceIds: [], critical: true, acquisition: "supplied", retrievalProviderId: null },
      { beatId: "beat-2", claim: "结尾生成画面", requirement: "illustration_only", suppliedSourceIds: [], critical: false, acquisition: "pipeline_generated", retrievalProviderId: null },
    ],
    feasibilityQuestions: [],
  };
  const repairProviders = [
    { id: "seedream-image-v1", capability: "asset.prepare", label: "Seedream 图片生成", available: true, kind: "external", deliveryTypes: ["generated_image"] },
    { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", deliveryTypes: ["stock_video", "stock_image"] },
    { id: "unavailable-gen-v1", capability: "asset.prepare", label: "不可用生成", available: false, kind: "external", deliveryTypes: ["generated_image"] },
    { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
    { id: "minimax-tts-v1", capability: "voice.synthesize", label: "MiniMax 中文配音", available: true, kind: "external" },
  ];

  function treatmentReview(allowedRetrievalProviderIds: string[] = ["seedream-image-v1"]): StudioCreativeReviewSnapshot {
    return review({
      stage: "treatment",
      draft: badTreatment,
      draftValidation: {
        draftArtifactId: "treatment-draft-1",
        draftSha256: sha,
        allowedRetrievalProviderIds,
        issues: [{
          code: "missing_retrieval_provider",
          path: "evidenceRequirements[1].retrievalProviderId",
          index: 1,
          claim: "结尾生成画面",
          acquisition: "pipeline_generated",
          message: "第 2 项素材安排还没选择画面服务，暂不能采用这版。当前稿件和讨论已保留，请在素材安排里补齐后保存。",
          technicalDetail: "Creative treatment evidenceRequirements[1].retrievalProviderId is required for pipeline_generated.",
        }],
      },
    });
  }

  it("shows the human problem with collapsed technical details and lists only compatible sources without defaults", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={treatmentReview()} busy={false} onCommand={onCommand} providers={repairProviders} />);
    expect(screen.getByText(/第 2 项素材安排还没选择画面服务，暂不能采用这版/)).toBeInTheDocument();
    const tech = screen.getByText("技术详情");
    await user.click(tech);
    expect(screen.getByText(/evidenceRequirements\[1\]\.retrievalProviderId is required for pipeline_generated/)).toBeInTheDocument();

    // 展开手动修订：补齐区显示第 2 项的 claim 与取得方式人话；select 只列兼容可用来源。
    await user.click(screen.getByText(/手动修订这份稿件/, { selector: "summary" }));
    expect(screen.getByText(/第 2 项 · 结尾生成画面 · AI 生成画面/)).toBeInTheDocument();
    const select = screen.getByLabelText("第 2 项画面服务") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((option) => option.value);
    expect(optionValues).toEqual(["", "seedream-image-v1"]);
    expect(select.value).toBe("");
    expect(screen.queryByText(/保存被拒绝/)).toBeNull();
  });

  it("saves the full document with the selected provider and preserves other fields", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={treatmentReview()} busy={false} onCommand={onCommand} providers={repairProviders} />);
    await user.click(screen.getByText(/手动修订这份稿件/, { selector: "summary" }));
    await user.selectOptions(screen.getByLabelText("第 2 项画面服务"), "seedream-image-v1");
    await user.click(screen.getByRole("button", { name: /保存修订/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const command = onCommand.mock.calls[0]![0];
    expect(command.action).toBe("edit_draft");
    if (command.action !== "edit_draft") throw new Error("expected edit_draft command");
    expect(command.stage).toBe("treatment");
    const document = command.document as typeof badTreatment;
    expect(document.evidenceRequirements[1]!.retrievalProviderId).toBe("seedream-image-v1");
    expect(document.evidenceRequirements[0]!.retrievalProviderId).toBeNull();
    expect(document.viewerPromise).toBe("看完能避开三个决策坑");
  });

  it("offers a real exit when no compatible source is configured and keeps the draft", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={treatmentReview()} busy={false} onCommand={onCommand} providers={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/本制作没有可选的对应画面服务.*提出修改/);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/选择服务后保存/);
    expect(screen.getByRole("button", { name: "补齐画面服务后再采用" })).toBeDisabled();
    const revise = screen.getByRole("button", { name: "提出修改" });
    expect(revise).toHaveClass("button-primary");
    await user.click(revise);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveFocus());
    expect(onCommand).not.toHaveBeenCalled();
    await user.click(screen.getByText(/手动修订这份稿件/));
    // 无兼容来源：如实说明并给出口，不默认选服务、不改 not_needed。
    expect(screen.getByText(/当前制作未配置可用的对应画面服务/)).toBeInTheDocument();
    expect(screen.queryByLabelText("第 2 项画面服务")).toBeNull();
    expect(screen.queryByText(/可到制作设置配置来源/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("观众看完能得到什么")).toHaveValue("看完能避开三个决策坑");
  });

  // CR3（2026-10-05 复审 AP3 的 UI 面）：补齐候选必须是“本制作已选来源 ∩ 可用目录 ∩
  // 交付类型匹配”。全局目录里可用且类型匹配、但本制作未选择的服务不得出现；缺投影
  // 的来源集合也不默认全开。浏览器禁选不替代服务端核验（服务端拒绝由正式 Pipeline 反例覆盖）。
  it("restricts repair options to this run's configured sources even when the global catalog has more", async () => {
    const user = userEvent.setup();
    // 本制作只配置了 local-editorial（editorial_card，与 generated 不匹配）；
    // seedream 在全局目录可用且类型匹配，但不在本制作集合里。
    render(<CreativeDiscussionPanel review={treatmentReview(["local-editorial-v1"])} busy={false} onCommand={vi.fn(async () => undefined)} providers={[
      ...repairProviders,
      { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑卡片", available: true, kind: "local", deliveryTypes: ["editorial_card"] },
    ]} />);
    await user.click(screen.getByText(/手动修订这份稿件/));
    const select = screen.queryByLabelText("第 2 项画面服务") as HTMLSelectElement | null;
    if (select) {
      expect(Array.from(select.options).map((option) => option.value)).toEqual([""]);
    }
    expect(screen.getByText(/当前制作未配置可用的对应画面服务/)).toBeInTheDocument();
  });

  it("does not promise a selector when the current run has no verified source scope", async () => {
    const current = treatmentReview();
    delete current.draftValidation!.allowedRetrievalProviderIds;
    render(<CreativeDiscussionPanel review={current} busy={false} onCommand={vi.fn(async () => undefined)} providers={repairProviders} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/本制作没有可选的对应画面服务/);
    await userEvent.click(screen.getByText(/手动修订这份稿件/));
    expect(screen.queryByLabelText("第 2 项画面服务")).toBeNull();
    expect(screen.getByRole("button", { name: "提出修改" })).toBeEnabled();
  });
});

describe("CreativeDiscussionPanel", () => {
  it("RF1 does not clear later input even if the creator changed it back to the sent text", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>(done => { resolve = done; });
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => gate);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByRole("textbox", { name: /聊聊你的想法/ });
    fireEvent.change(composer, { target: { value: "同字节但后来输入" } });
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    fireEvent.change(composer, { target: { value: "先改成别的文字" } });
    fireEvent.change(composer, { target: { value: "同字节但后来输入" } });
    await act(async () => resolve());
    expect(composer).toHaveValue("同字节但后来输入");
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  describe.each(["treatment", "script", "director"] as const)("RF1 %s async identity", stage => {
    it.each(["completed", "failed", "not_accepted", "unknown"] as const)("preserves replacement body for a delayed %s receipt", async status => {
      const command = storedDiscussion("A", stage);
      const key = `vf:creative-command:run-creative:${stage}:draft`;
      window.localStorage.setItem(key, JSON.stringify(command));
      let resolve!: (receipt: StudioCreativeReviewCommandReceipt) => void;
      vi.spyOn(studioApi, "creativeReviewCommand").mockImplementation(() => new Promise(done => { resolve = done; }));
      const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
      render(<CreativeDiscussionPanel review={review({ stage })} busy={false} onCommand={onCommand} />);
      await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
      const changedBody = JSON.stringify({ ...command, message: "相同ID但不是原body" });
      window.localStorage.setItem(key, changedBody);
      await act(async () => resolve({ commandId: command.commandId, status, observationUrl: "/A" }));
      expect(onCommand).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(key)).toBe(changedBody);
      expect(screen.getByRole("alert")).toHaveTextContent(/记录.*变化/);
      expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
      expect(screen.queryByText(/上一条操作已完成/)).not.toBeInTheDocument();
    });

    it.each(["success", "commandCompleted"] as const)("does not clean B or later input after submit A ends with %s", async outcome => {
      let resolve!: () => void;
      const gate = new Promise<void>(done => { resolve = done; });
      const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => {
        await gate;
        if (outcome === "commandCompleted") throw Object.assign(new Error("原操作已完成，读取页面失败"), { commandCompleted: true });
      });
      render(<CreativeDiscussionPanel review={review({ stage })} busy={false} onCommand={onCommand} />);
      const composer = screen.getByRole("textbox", { name: /聊聊你的想法/ });
      fireEvent.change(composer, { target: { value: "发送A" } });
      await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
      const key = `vf:creative-command:run-creative:${stage}:draft`;
      const b = JSON.stringify(storedDiscussion("B", stage));
      window.localStorage.setItem(key, b);
      fireEvent.change(composer, { target: { value: "后来输入，不能被A清理" } });
      await act(async () => resolve());
      expect(window.localStorage.getItem(key)).toBe(b);
      expect(composer).toHaveValue("后来输入，不能被A清理");
      expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
      expect(onCommand).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["different-id", "missing-id", "corrupt-slot", "read-failure"])("RF1 refuses a recovery POST for %s after GET", async condition => {
    const command = storedDiscussion("A");
    const key = "vf:creative-command:run-creative:script:draft";
    window.localStorage.setItem(key, JSON.stringify(command));
    let resolve!: (receipt: StudioCreativeReviewCommandReceipt) => void;
    vi.spyOn(studioApi, "creativeReviewCommand").mockImplementation(() => new Promise(done => { resolve = done; }));
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    if (condition === "corrupt-slot") window.localStorage.setItem(key, "{broken");
    if (condition === "read-failure") vi.mocked(window.localStorage.getItem).mockImplementation(() => { throw new Error("unavailable"); });
    const receipt = { status: "unknown", observationUrl: "/A", ...(condition === "missing-id" ? {} : { commandId: condition === "different-id" ? "B" : "A" }) };
    await act(async () => resolve(receipt as StudioCreativeReviewCommandReceipt));
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/无法核对/);
    expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
  });

  it("RF1 cleans only A after its recovery POST returns while B is pending", async () => {
    const command = storedDiscussion("A");
    const key = "vf:creative-command:run-creative:script:draft";
    window.localStorage.setItem(key, JSON.stringify(command));
    vi.spyOn(studioApi, "creativeReviewCommand").mockResolvedValue({ commandId: "A", status: "unknown", observationUrl: "/A" });
    let resolve!: (receipt: StudioCreativeReviewCommandReceipt) => void;
    const onCommand = vi.fn((_command: StudioCreativeReviewCommandInput) => new Promise<StudioCreativeReviewCommandReceipt>(done => { resolve = done; }));
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledExactlyOnceWith(command));
    const b = JSON.stringify(storedDiscussion("B"));
    window.localStorage.setItem(key, b);
    await act(async () => resolve({ commandId: "A", status: "completed", observationUrl: "/A" }));
    expect(window.localStorage.getItem(key)).toBe(b);
    expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["treatment", "script", "director"] as const)("RF1 does not recover another command after a delayed %s receipt", async stage => {
    const command: StudioCreativeReviewCommandInput = { commandId: "original-A", action: "discuss", stage,
      expectedRunRevision: 8, expectedReviewRevision: 3, baseDraftSha256: sha, message: "原意见A" };
    const key = `vf:creative-command:run-creative:${stage}:draft`;
    window.localStorage.setItem(key, JSON.stringify(command));
    let resolve!: (receipt: StudioCreativeReviewCommandReceipt) => void;
    vi.spyOn(studioApi, "creativeReviewCommand").mockImplementation(() => new Promise(done => { resolve = done; }));
    const onCommand = vi.fn(async (_command: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ stage })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    const replacement = JSON.stringify({ ...command, commandId: "new-B", message: "另一标签B" });
    window.localStorage.setItem(key, replacement);
    await act(async () => resolve({ commandId: command.commandId, status: "unknown", observationUrl: "/original-A" }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe(replacement);
    expect(await screen.findByRole("alert")).toHaveTextContent(/记录.*变化/);
  });

  it("puts the decision before the draft and opens revision discussion without losing words or selected advice", async () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      verdict: "pass", score: 90, summary: "开头和结尾都可以调整。", checkIdentity: "c".repeat(64), issues: [
        { severity: "advisory", criterion: "开头", evidence: "开场略慢", repairInstruction: "把结论提前。" },
        { severity: "advisory", criterion: "结尾", evidence: "结尾太满", repairInstruction: "结尾留白。" },
      ],
    } })} busy={false} onCommand={onCommand} />);
    const adopt = screen.getByRole("button", { name: /采用.*（保留审计建议）/ });
    const draft = screen.getByRole("article", { name: "当前脚本" });
    expect(adopt.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: /聊聊你的想法/ });
    fireEvent.change(composer, { target: { value: "我先保留这个开头。" } });
    await userEvent.click(screen.getByRole("checkbox", { name: "把结论提前。" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "结尾留白。" }));
    await userEvent.click(screen.getByRole("button", { name: "提出修改" }));
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue("我先保留这个开头。");
    expect(screen.getByRole("button", { name: "建议与讨论" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "加入修改意见（2）" })).toBeEnabled();
    expect(screen.getByText("全稿建议")).toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it.each<Partial<StudioCreativeReviewSnapshot>>([
    { runId: "another-run" },
    { draftVersionId: "script#v2" },
    { draftArtifactId: "another-artifact" },
    { draftSha256: "b".repeat(64) },
    { reviewPurpose: "direction" },
  ])("resets segment reading for a different draft identity %j but retains it during polling", async (changed) => {
    const initial = review({ draftVersionId: "script#v1", draft: { scenes: [
      { id: "scene-1", position: 1, narration: "当前第一段" },
      { id: "scene-2", position: 2, narration: "当前第二段" },
    ] } });
    const onCommand = vi.fn(async () => undefined);
    const { rerender } = render(<CreativeDiscussionPanel review={initial} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "阅读第 2 段" }));
    rerender(<CreativeDiscussionPanel review={{ ...initial, runRevision: 9, reviewRevision: 4 }} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("button", { name: "阅读第 2 段" })).toHaveAttribute("aria-current", "true");
    rerender(<CreativeDiscussionPanel review={{ ...initial, ...changed }} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("button", { name: "阅读第 1 段" })).toHaveAttribute("aria-current", "true");
    expect(within(screen.getByRole("region", { name: "稿件阅读" })).queryByText("当前第二段")).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("reads one script segment at a time without changing the creator's discussion scope", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ draft: {
      narrativeArc: "问题到答案",
      scenes: [
        { id: "scene-1", position: 1, duration: 8, narration: "先看结果。", visual_prompt: "结果对照" },
        { id: "scene-2", position: 2, duration: 6, narration: "再说明原因。", visual_prompt: "原因示意" },
      ],
    } })} busy={false} onCommand={onCommand} />);
    const reader = screen.getByRole("region", { name: "稿件阅读" });
    expect(within(reader).getByText("先看结果。")).toBeInTheDocument();
    expect(within(reader).queryByText("再说明原因。")).not.toBeInTheDocument();
    await userEvent.click(within(reader).getByRole("button", { name: "阅读第 2 段" }));
    expect(within(reader).getByText("再说明原因。")).toBeInTheDocument();
    expect(within(reader).queryByText("先看结果。")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    expect(screen.getByRole("checkbox", { name: "第 2 段" })).not.toBeChecked();
    await userEvent.type(screen.getByRole("textbox", { name: /聊聊你的想法/ }), "讨论整份脚本");
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({ action: "discuss", message: "讨论整份脚本" });
    expect(onCommand.mock.calls[0]?.[0]).not.toHaveProperty("selection");
    await userEvent.click(within(reader).getByRole("button", { name: "查看整篇" }));
    expect(within(reader).getByText("先看结果。")).toBeInTheDocument();
    expect(within(reader).getByText("再说明原因。")).toBeInTheDocument();
  });

  it("keeps optional suggestions beside the composer and provides a draft-to-advice shortcut without sending", async () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      verdict: "pass", score: 90, summary: "可以采用，也可打磨开头。", checkIdentity: "c".repeat(64),
      issues: [{ severity: "advisory", criterion: "开头", evidence: "开场略慢", repairInstruction: "把结论提前。" }],
    } })} busy={false} onCommand={onCommand} />);
    const draft = screen.getByRole("article", { name: "当前脚本" });
    const discussion = screen.getByRole("region", { name: "与当前角色讨论" });
    expect(within(draft).queryByRole("checkbox", { name: "把结论提前。" })).not.toBeInTheDocument();
    expect(within(discussion).getByRole("checkbox", { name: "把结论提前。" })).toBeInTheDocument();
    await userEvent.click(within(draft).getByRole("button", { name: "查看 1 条建议" }));
    expect(screen.getByRole("button", { name: "建议与讨论" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByRole("heading", { name: "本版建议" })).toHaveFocus());
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /采用.*（保留审计建议）/ })).toBeEnabled();
  });

  it("shows the old plan as current and never offers direct adoption of an out-of-scope proposal", () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review({
      stopDetail: "新方案镜头 1 超出了已批准的范围。",
      scopeConflict: { proposalId: "scope:new-script", sourceRunId: "run-source", requiredScenePositions: [1] },
      proposals: [{ proposalId: "scope:new-script", baseDraftSha256: sha,
        document: { scenes: [{ position: 1, narration: "新旁白", visual_prompt: "越界画面" }] },
        changeSummary: ["镜头 1 超出批准范围"] }],
    })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("越界新稿 · 仅供比较")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设为当前草稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回来源制作，调整返工范围" })).toHaveAttribute("href", "/projects/run-source");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("explains a failed discussion in plain words without leaking raw contract paths", async () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review({
      reviewContinuation: {
        status: "error",
        reasonCode: "discussion_failed",
        detail: "这次讨论/修改没有完成，已保存稿件未改动。你可以继续编辑或采用当前稿；不会自动重试。",
        recordedAt: "2026-10-03T00:00:00.000Z",
      },
    })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("这次讨论或修改没有完成")).toBeInTheDocument();
    expect(screen.getByText(/当前稿件未改动，仍可编辑、讨论或采用/)).toBeInTheDocument();
    // 原始 Bridge 字段路径不出现在普通用户视图。
    expect(screen.queryByText(/payload\.currentDocument/)).not.toBeInTheDocument();
    // 失败不夺走入口：意见框可输入、只讨论可点。
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    fireEvent.change(composer, { target: { value: "换个问法再试" } });
    expect(composer).toHaveValue("换个问法再试");
    expect(screen.getByRole("button", { name: "只讨论" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeEnabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("clears the selected discussion scope when the draft version changes, including same-SHA A-prime (C4)", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const first = review({ draftVersionId: "script-artifact#v1" });
    const { rerender } = render(<CreativeDiscussionPanel review={first} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    await userEvent.click(screen.getByRole("checkbox", { name: "第 1 段" }));
    // 换版本（内容也变）：选择必须清空，发送不得携带旧 selection
    const second = review({ draftVersionId: "script-artifact#v2", draftSha256: "b".repeat(64), reviewRevision: 4,
      draft: { narrativeArc: "问题到答案", scenes: [{ id: "scene-1", position: 1, duration: 8, narration: "第二版旁白。", visual_prompt: "对照" }] } });
    rerender(<CreativeDiscussionPanel review={second} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    expect(screen.getByRole("checkbox", { name: "第 1 段" })).not.toBeChecked();
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "C4 意见" } });
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).not.toHaveProperty("selection");
    // 同 SHA 不同 versionId（A→B→A′）：身份仍前进，选择同样不复活
    rerender(<CreativeDiscussionPanel review={first} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    expect(screen.getByRole("checkbox", { name: "第 1 段" })).not.toBeChecked();
    // 同版普通 rerender（revision 前进、稿件身份不变）不清用户选择
    await userEvent.click(screen.getByRole("checkbox", { name: "第 1 段" }));
    rerender(<CreativeDiscussionPanel review={{ ...first, runRevision: first.runRevision + 1 }} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("checkbox", { name: "第 1 段" })).toBeChecked();
  });

  it("keeps an unsent instruction in the tab session for explicit reuse when the version changes", async () => {
    const onCommand = vi.fn(async () => undefined);
    const first = review({ draftVersionId: "script-artifact#v1" });
    const { rerender } = render(<CreativeDiscussionPanel review={first} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "只针对第一版的修改" } });
    const second = review({ draftVersionId: "script-artifact#v2", draftSha256: "b".repeat(64), reviewRevision: 4 });
    rerender(<CreativeDiscussionPanel review={second} busy={false} onCommand={onCommand} />);
    // 版本更新后旧意见保留给用户显式改写/复用；不自动发送，也不把旧选择绑到新稿。
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("只针对第一版的修改");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("clears scope when artifact or SHA changes even if the version label is unchanged (C4)", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const first = review({ draftVersionId: "script-artifact#v1" });
    const { rerender } = render(<CreativeDiscussionPanel review={first} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "保留这条意见" } });
    await userEvent.click(screen.getByText("指定讨论范围（可选）"));
    for (const changed of [
      { ...first, draftArtifactId: "different-artifact" },
      { ...first, draftArtifactId: "different-artifact", draftSha256: "b".repeat(64) },
    ]) {
      await userEvent.click(screen.getByRole("checkbox", { name: "第 1 段" }));
      rerender(<CreativeDiscussionPanel review={changed} busy={false} onCommand={onCommand} />);
      const scope = screen.getByText(/指定讨论范围/);
      if (!(scope.closest("details") as HTMLDetailsElement).open) await userEvent.click(scope);
      expect(screen.getByRole("checkbox", { name: "第 1 段" })).not.toBeChecked();
      expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("保留这条意见");
    }
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).not.toHaveProperty("selection");
  });

  it("retains an overlong pasted instruction and refuses to send it", () => {
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const longText = "修".repeat(4001);
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).not.toHaveAttribute("maxlength");
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: longText } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue(longText);
    expect(screen.getByRole("alert")).toHaveTextContent("4,000 字");
    expect(onCommand).not.toHaveBeenCalled();
  });
  it("reconciles a pending command without sending a new one", async () => {
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify(storedDiscussion("saved-command")));
    const read = vi.spyOn(studioApi, "creativeReviewCommand")
      .mockResolvedValueOnce({ commandId: "saved-command", status: "unknown", observationUrl: "/pending" })
      .mockResolvedValueOnce({ commandId: "saved-command", status: "completed", observationUrl: "/done" });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    // C1 后：unknown 用保存的原命令走恢复入口（同 commandId 只观察原请求），回执仍
    // unknown 时提示独立处理出口；原命令键保留。
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0].commandId).toBe("saved-command");
    expect(await screen.findByText(/原操作结果仍未确定/)).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByText(/上一条操作已完成。请刷新查看当前方案/)).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    // 第一轮已按 C1 恢复入口提交过原命令一次；completed 分支只读回执，不再新发命令。
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps the original discussion command and later user words when its receipt is unknown", async () => {
    const onCommand = vi.fn(async (input: StudioCreativeReviewCommandInput): Promise<StudioCreativeReviewCommandReceipt> => ({
      commandId: input.commandId, status: "unknown" as const, observationUrl: "/original",
      independentDraftActions: { actions: ["edit_draft", "confirm", "return_to_stage"], targetDraft: { sha256: sha } },
    }));
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "这条讨论尚未完成" } });
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const original = onCommand.mock.calls[0]![0];
    expect(JSON.parse(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")!)).toEqual(original);
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("这条讨论尚未完成");
    expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
  });

  it.each([true, false])("blocks new model requests while a durable consultation is unknown (proof=%s), without blocking draft decisions", async proof => {
    const original: StudioCreativeReviewCommandInput = { commandId: "unknown-discussion", action: "discuss", expectedRunRevision: 7,
      expectedReviewRevision: 2, stage: "script", baseDraftSha256: sha, message: "原讨论" };
    const pendingConsultation: StudioCreativeReviewSnapshot["pendingConsultation"] = { commandId: original.commandId,
      allowedActions: ["edit_draft", "confirm", "return_to_stage"], targetDraft: { sha256: sha } };
    const snapshot = review({
      consultationOperations: [{ commandId: original.commandId, command: original, status: "unknown" }],
      ...(proof ? { pendingConsultation } : {}),
    });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={snapshot} busy={false} onCommand={onCommand} />);
    const composer = screen.getByRole("textbox", { name: /聊聊你的想法/ });
    fireEvent.change(composer, { target: { value: "后写的个人意见保留，不能另投模型" } });
    expect(screen.getByRole("button", { name: "只讨论" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeDisabled();
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(onCommand).not.toHaveBeenCalled();
    expect(composer).toHaveValue("后写的个人意见保留，不能另投模型");
    expect(screen.getByRole("button", { name: "核对原讨论结果" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "返回前期构思" })).toBeEnabled();
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    fireEvent.change(screen.getByLabelText("分镜 1 · 旁白"), { target: { value: "用户明确手改当前稿" } });
    expect(screen.getByRole("button", { name: "保存修订" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0].action).toBe("edit_draft");
  });

  it("clears only a server-proven unaccepted command and leaves the next choice to the user", async () => {
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify({ commandId: "unaccepted-command", action: "confirm",
      stage: "script", expectedRunRevision: 8, expectedReviewRevision: 3, baseDraftSha256: sha }));
    vi.spyOn(studioApi, "creativeReviewCommand").mockResolvedValue({ commandId: "unaccepted-command", status: "not_accepted", observationUrl: "/same-command" });
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByText(/已核实上一条操作未受理/)).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:creative-command:run-creative:script:draft")).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("clears this page's completed pointer when another tab has already removed the shared command", async () => {
    const original: StudioCreativeReviewCommandInput = { commandId: "peer-cleared-discussion", action: "discuss",
      expectedRunRevision: 7, expectedReviewRevision: 2, stage: "script", baseDraftSha256: sha, message: "原讨论" };
    const key = "vf:creative-command:run-creative:script:draft";
    window.localStorage.setItem(key, JSON.stringify(original));
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput): Promise<StudioCreativeReviewCommandReceipt> => ({
      commandId: original.commandId, status: "completed", resultDisposition: "recorded_not_applied", observationUrl: "/original",
    }));
    const { rerender } = render(<CreativeDiscussionPanel review={review({
      consultationOperations: [{ commandId: original.commandId, command: original, status: "unknown" }],
    })} busy={false} onCommand={onCommand} />);
    window.localStorage.removeItem(key); // 另一标签手改完成后仅清理它自己的当前命令指针。
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "后写的意见不会被取回结果清掉" } });
    await userEvent.click(screen.getByRole("button", { name: "核对原讨论结果" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    rerender(<CreativeDiscussionPanel review={review({ consultationOperations: [{
      commandId: original.commandId, command: original, status: "completed", resultDisposition: "recorded_not_applied",
    }] })} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("button", { name: "只讨论" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeEnabled();
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("后写的意见不会被取回结果清掉");
    expect(onCommand.mock.calls[0]![0]).toEqual(original);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it.each(["completed", "failed", "not_accepted"] as const)("clears a restored %s consultation pointer from durable proof without issuing a command", async status => {
    const original: StudioCreativeReviewCommandInput = { commandId: "completed-before-remount", action: "discuss",
      expectedRunRevision: 7, expectedReviewRevision: 2, stage: "script", baseDraftSha256: sha, message: "原讨论" };
    const key = "vf:creative-command:run-creative:script:draft";
    window.localStorage.setItem(key, JSON.stringify(original));
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ consultationOperations: [{
      commandId: original.commandId, command: original, status,
    }] })} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "用户后来写下的意见" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "只讨论" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "核对上一条操作" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("用户后来写下的意见");
    expect(onCommand).not.toHaveBeenCalled();
  });

  for (const status of ["completed", "failed", "not_accepted"] as const)
  it.each(["different-body", "cleanup-failure", "newer-command"])(`does not erase %s while reconciling durable ${status} proof`, async condition => {
    const original: StudioCreativeReviewCommandInput = { commandId: "completed-proof", action: "discuss",
      expectedRunRevision: 7, expectedReviewRevision: 2, stage: "script", baseDraftSha256: sha, message: "原讨论" };
    const key = "vf:creative-command:run-creative:script:draft";
    const saved = condition === "different-body" ? { ...original, message: "同ID却不是原命令" }
      : condition === "newer-command" ? { ...original, commandId: "newer-unresolved", message: "后续原请求仍待核" } : original;
    window.localStorage.setItem(key, JSON.stringify(saved));
    if (condition === "cleanup-failure") vi.mocked(window.localStorage.removeItem).mockImplementation(() => { throw new Error("cleanup unavailable"); });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ consultationOperations: [{
      commandId: original.commandId, command: original, status,
    }] })} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "输入仍保留，不猜测命令已经释放" } });
    expect(screen.getByRole("button", { name: "只讨论" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "核对上一条操作" })).toBeEnabled();
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(saved));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it.each(["audit_current", "revise"] as const)("reconciles a restored %s command without treating unknown generation as optional audit", async action => {
    const key = "vf:creative-command:run-creative:script:draft";
    const command: StudioCreativeReviewCommandInput = action === "audit_current"
      ? { commandId: "original-audit", action, expectedRunRevision: 8, expectedReviewRevision: 3, stage: "script", baseDraftSha256: sha }
      : { commandId: "original-audit", action, expectedRunRevision: 8, expectedReviewRevision: 3, stage: "script", baseDraftSha256: sha, message: "原修订" };
    window.localStorage.setItem(key, JSON.stringify(command));
    const read = vi.spyOn(studioApi, "creativeReviewCommand").mockResolvedValue({ commandId: command.commandId, status: "unknown",
      observationUrl: "/original", independentDraftActionsAllowed: true });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    if (action === "audit_current") {
      expect(await screen.findByText(/原审计结果仍待核/)).toBeInTheDocument();
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(JSON.parse(window.localStorage.getItem("vf:creative-audit-command:run-creative:original-audit")!)).toEqual(command);
      fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "新的明确修订" } });
      await userEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0]).toBeDefined();
    } else {
      expect(await screen.findByText(/原操作结果仍未确定/)).toBeInTheDocument();
      expect(window.localStorage.getItem(key)).toBe(JSON.stringify(command));
      // 恢复观察只发原命令一次；待核时入口与守卫一致，不能呈现可点却拒绝的承诺。
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(onCommand.mock.calls[0]![0].commandId).toBe(command.commandId);
      fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "不准覆盖原生成" } });
      expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
      fireEvent.keyDown(screen.getByPlaceholderText(/为什么这样开场/), { key: "Enter", ctrlKey: true });
      expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("不准覆盖原生成");
      expect(onCommand).toHaveBeenCalledTimes(1);
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending optional audit when its archive cannot be saved", async () => {
    const key = "vf:creative-command:run-creative:script:draft";
    window.localStorage.setItem(key, JSON.stringify({ commandId: "original-audit", action: "audit_current",
      stage: "script", expectedRunRevision: 8, expectedReviewRevision: 3, baseDraftSha256: sha }));
    vi.spyOn(studioApi, "creativeReviewCommand").mockResolvedValue({ commandId: "original-audit", status: "unknown",
      observationUrl: "/original", independentDraftActionsAllowed: true });
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error("storage full"); });
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本机恢复记录未能整理");
    expect(window.localStorage.getItem(key)).not.toBeNull();
    expect(screen.queryByText(/上一条操作已完成/)).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("does not call a completed command unknown when local reconciliation cleanup fails", async () => {
    window.localStorage.setItem("vf:creative-command:run-creative:script:draft", JSON.stringify(storedDiscussion("saved-command")));
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
    await userEvent.click(screen.getByRole("button", { name: /采用.*（复核未完成）/ }));
    expect(confirmSpy).not.toHaveBeenCalled();
    // 按钮自身已是明确风险决定，不再叠加泛化确认弹窗。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acknowledgeIncomplete: true, expectedCheckIdentity: "b".repeat(64), baseDraftSha256: sha });
  });

  it("refuses to confirm when the displayed identity changed while the dialog was open", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review({ stage: "director", qualityAdvisories: [
      { scenePositions: [1], reason: "示意素材尚未核实" },
    ] })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: "采用选材方案（接受素材风险）" }));
    const dialog = screen.getByRole("dialog");
    // 弹窗打开期间服务端换了稿/换了复核。
    rendered.rerender(<CreativeDiscussionPanel review={review({
      stage: "director",
      reviewRevision: 4,
      draftSha256: "c".repeat(64),
      qualityAdvisories: [{ scenePositions: [1], reason: "新的素材风险" }],
    })} busy={false} onCommand={onCommand} />);
    await userEvent.click(within(dialog).getByRole("button", { name: /接受素材风险，先制作首版/ }));
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

  it("keeps the composer usable in memory when the tab session storage fails", () => {
    vi.mocked(window.sessionStorage.getItem).mockImplementation(() => {
      throw new Error("session storage unavailable");
    });
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    fireEvent.change(composer, { target: { value: "存储坏了也能打字" } });
    expect(composer).toHaveValue("存储坏了也能打字");
    expect(screen.getByText(/本机草稿无法保存/)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeDisabled();
    expect(screen.queryByText(/修订已保存。/)).not.toBeInTheDocument();
  });

  it("warns when an unsaved hand edit cannot be cached locally", async () => {
    vi.mocked(window.sessionStorage.setItem).mockImplementation(() => {
      throw new Error("session storage full");
    });
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = screen.getByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "关闭页面前要复制的文字");

    expect(narration).toHaveValue("关闭页面前要复制的文字");
    expect(screen.getByText(/手工修订无法在本机保存.*刷新或关闭可能丢失/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "采用选材方案（接受素材风险）" }));
    // 应用内弹窗出现，先看风险再决定；关闭不发送。
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/本版尚未审计/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "返回查看" }));
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "采用选材方案（接受素材风险）" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /接受素材风险，先制作首版/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acceptQualityFallback: true, acknowledgeUnaudited: true, baseDraftSha256: sha });
  });
  it("preserves unsaved manual edits across a new server draft and refuses to overwrite it", async () => {
    const onCommand = vi.fn(async () => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = await screen.findByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "我还没保存的文字");
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "只讨论" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeDisabled();
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

  it("keeps the input and explicitly reconciles the original command after an uncertain submit failure", async () => {
    const onCommand = vi.fn<(_input: StudioCreativeReviewCommandInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("连接在响应前中断"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(studioApi, "creativeReviewCommand").mockImplementation(async (_runId, commandId) => ({
      commandId, status: "unknown", observationUrl: "/original",
    }));
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    await userEvent.type(composer, "解释这一段");
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));
    await screen.findByRole("alert");
    expect(composer).toHaveValue("解释这一段");
    expect(screen.getByRole("button", { name: "只讨论" })).toBeDisabled();
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(onCommand).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "核对上一条操作" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand.mock.calls[1]?.[0]).toEqual(onCommand.mock.calls[0]?.[0]);
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
    await userEvent.click(screen.getByRole("button", { name: "只讨论" }));

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
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeInTheDocument();
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

    expect(screen.getByText(/有 1 条修改建议，由你决定是否采用/)).toBeInTheDocument();
    expect(screen.getByText("先复查现有素材，再决定是否更换。")).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: /采用.*（保留审计建议）/ });
    expect(confirmButton).toBeEnabled();
    expect(screen.queryByRole("button", { name: "确认当前方案，继续" })).not.toBeInTheDocument();

    // 复核是建议不是否决；按钮文案已经明确告知保留建议，单次点击就是显式决定。
    await userEvent.click(confirmButton);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    // 身份必须跟着一起发：服务端会拿它跟记录里的那一条比对，缺了就直接拒收这条命令。
    // 只有 acknowledgeRepair 而没带编号，"仍然确认"会在服务端变成一条无法送达的命令。
    expect(onCommand.mock.calls[0]![0]).toMatchObject({
      action: "confirm",
      acknowledgeRepair: true,
      expectedCheckIdentity: "c1d1e1f1" + "0".repeat(56),
    });
  });

  it("names a passing audit's optional advice in the adoption action without another modal", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      verdict: "pass", score: 91, summary: "整体可用，开场仍可更直接。",
      checkIdentity: "e".repeat(64),
      issues: [{ severity: "advisory", criterion: "开场", evidence: "首句较慢", repairInstruction: "把问题提前。" }],
    } })} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("button", { name: /采用.*（保留审计建议）/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", expectedCheckIdentity: "e".repeat(64) });
  });

  it("appends several content suggestions to the creator's existing words without sending", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review({
      stage: "director",
      checkResult: {
        verdict: "pass",
        score: 70,
        summary: "可以继续，但有两处可打磨",
        checkIdentity: "c1d1e1f1" + "0".repeat(56),
        issues: [
          { severity: "advisory", criterion: "pacing", evidence: "scene-2.duration=8", repairInstruction: "reduce scene-2 by 2s", creatorTitle: "第二镜等得太久", creatorObservation: "观众等八秒才看到新变化。", creatorAction: "第二镜缩短两秒，保留动作结果。" },
          { severity: "advisory", criterion: "声音", evidence: "结尾旁白盖住环境声", repairInstruction: "结尾留一秒听环境声。" },
        ],
      },
    })} busy={false} onCommand={onCommand} />);

    const composer = screen.getByPlaceholderText(/为什么这样开场/) as HTMLTextAreaElement;
    await userEvent.type(composer, "先保留我原来的开场。\n");
    expect(screen.getByText("第二镜等得太久")).toBeInTheDocument();
    expect(screen.getByText("观众等八秒才看到新变化。")).toBeInTheDocument();
    expect(screen.queryByText("pacing")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /第二镜缩短两秒/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /结尾留一秒听环境声/ }));
    await userEvent.click(screen.getByRole("button", { name: "加入修改意见（2）" }));
    expect(composer.value).toMatch(/^先保留我原来的开场。/);
    expect(composer.value).toContain("第二镜缩短两秒，保留动作结果。");
    expect(composer.value).toContain("结尾留一秒听环境声。");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(screen.getByText("交互记录")).toBeInTheDocument();
    for (const name of ["解释这个安排", "开头不够吸引", "给我另一个方向，但先不要替换"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.type(composer, "\n但不要改第一镜。");
    expect(composer.value).toContain("但不要改第一镜。");
    await userEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "revise", message: expect.stringContaining("但不要改第一镜") })));
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it("does not carry a selected audit suggestion to a new version with identical text", async () => {
    const checked = review({
      draftVersionId: "script-artifact#v1",
      checkResult: {
        verdict: "pass", score: 90, summary: "可以继续", checkIdentity: "c".repeat(64),
        issues: [{ severity: "advisory", criterion: "节奏", evidence: "第二镜略长", repairInstruction: "缩短第二镜。" }],
      },
    });
    const onCommand = vi.fn(async () => undefined);
    const { rerender } = render(<CreativeDiscussionPanel review={checked} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "缩短第二镜。" }));
    expect(screen.getByRole("button", { name: "加入修改意见（1）" })).toBeEnabled();
    rerender(<CreativeDiscussionPanel review={{ ...checked, draftVersionId: "script-artifact#v2", reviewRevision: 4 }} busy={false} onCommand={onCommand} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "加入修改意见（0）" })).toBeDisabled());
    expect(screen.getByRole("checkbox", { name: "缩短第二镜。" })).not.toBeChecked();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("offers a separate current-version audit and explicit unaudited adoption", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("本版未审计")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "audit_current" })));
    onCommand.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /采用.*（未审计）/ }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "confirm", acknowledgeUnaudited: true })));
  });

  it("still offers confirmation while no repair verdict is outstanding", () => {
    render(<CreativeDiscussionPanel review={review({ stage: "director" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("button", { name: /采用.*（未审计）/ })).toBeEnabled();
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
