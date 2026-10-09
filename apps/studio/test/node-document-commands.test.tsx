import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { NodeDocumentCommands } from "../src/client/components/NodeDocumentCommands.js";
import { studioApi } from "../src/client/api.js";
import { RunCostDetailPanel } from "../src/client/components/CostDashboard.js";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function setup(overrides: Partial<Parameters<typeof NodeDocumentCommands>[0]> = {}) {
  const props: Parameters<typeof NodeDocumentCommands>[0] = {
    nodeId: "publish-package",
    runRevision: 7,
    effectiveVersionId: "publish-v1",
    contentReview: { status: "has_suggestions", summary: "初稿审计：标题可以更具体。", suggestions: ["标题写出“少做一个决定”这个动作。", "描述补充具体收益。"] },
    busy: false,
    onRevise: async () => undefined,
    onAudit: async () => undefined,
    ...overrides,
  };
  render(<NodeDocumentCommands {...props} />);
  return props;
}

describe("NodeDocumentCommands", () => {
  it.each(["revise", "audit"] as const)("distinguishes a not-accepted %s from a failed model execution", async action => {
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([{
      commandId: `refused-${action}`, action, state: "failed", expectedRunRevision: 7, expectedVersionId: "publish-v1",
      ...(action === "revise" ? { instruction: "保留未受理的意见" } : {}),
      failureStage: "not_accepted", error: "模型服务未受理", createdAt: "now", updatedAt: "now", billingPending: true,
    }]);
    const onRevise = vi.fn(async () => undefined);
    const onAudit = vi.fn(async () => undefined);
    setup({ runId: "refused-document", onRevise, onAudit });
    expect(await screen.findByText(`${action === "audit" ? "文字审计" : "稿件修订"} · 未受理`)).toBeInTheDocument();
    expect(screen.queryByText(/执行失败.*已核清/)).not.toBeInTheDocument();
    expect(screen.getByText(/当前稿仍保留/)).toBeInTheDocument();
    expect(onRevise).not.toHaveBeenCalled();
    expect(onAudit).not.toHaveBeenCalled();
  });

  it("shows a settled failure's original instruction and charge uncertainty after a fresh mount", async () => {
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([{
      commandId: "failed-original", action: "revise", state: "failed", expectedRunRevision: 6, expectedVersionId: "publish-v1",
      instruction: "原意见：保留结尾的留白", error: "模型未能完成这次修订", createdAt: "now", updatedAt: "now", billingPending: true,
    }]);
    const onRevise = vi.fn(async () => undefined);
    const onAudit = vi.fn(async () => undefined);
    setup({ runId: "failed-document", onRevise, onAudit, completed: true });
    expect(await screen.findByText("原意见：保留结尾的留白")).toBeInTheDocument();
    expect(screen.getByText(/执行失败.*已核清/)).toBeInTheDocument();
    expect(screen.getByText("模型未能完成这次修订")).toBeInTheDocument();
    expect(screen.getByText(/费用仍待核/)).toBeInTheDocument();
    const reviseSection = screen.getByText("继续修改（会形成新版本）").closest("details")!;
    expect(reviseSection).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("继续修改（会形成新版本）"));
    expect(reviseSection).toHaveAttribute("open");
    expect(screen.getByRole("textbox", { name: "修订意见" })).toBeVisible();
    expect(onRevise).not.toHaveBeenCalled();
    expect(onAudit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "取回原操作结果" })).not.toBeInTheDocument();
  });

  it("does not describe unverified API charges as free, subscription or a zero-price estimate", () => {
    render(<RunCostDetailPanel detail={{ runId: "r", title: "待核账",
      totals: { estimatedCostCny: 0, authorizedCostCny: 0, actualCostCny: 0, actualPendingCount: 1,
        meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0, unverifiedModelCalls: 2 },
      lines: [{ id: "doc", runId: "r", runTitle: "待核账", nodeId: "publish-package", providerId: "api", modelId: "m",
        capability: "model.execute", status: "failed", billing: "unverified", modelCallCount: 2,
        actualPending: true, estimatedCostCny: 0, startedAt: "now" }],
    }} />);
    expect(screen.getByText(/2 次已确认模型调用.*收费方式与金额待核账/)).toBeInTheDocument();
    expect(screen.getByText("金额未核实")).toBeInTheDocument();
    expect(screen.queryByText(/免费\/本地|订阅额度|预估 ¥0/)).not.toBeInTheDocument();
  });
  it("finds a pending server command after refresh and recovers its original identity and instruction", async () => {
    let settled = false;
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => [{
      commandId: "saved-command", action: "revise", state: settled ? "applied" : "pending", expectedRunRevision: 6,
      expectedVersionId: "earlier-version", instruction: "用户原修改意见", createdAt: "now", updatedAt: "now", billingPending: true,
    }]);
    const onRevise = vi.fn(async () => { settled = true; });
    setup({ runId: "run-one", onRevise });
    const recover = await screen.findByRole("button", { name: "取回原操作结果" });
    expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeDisabled();
    fireEvent.click(recover);
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith("publish-package", {
      commandId: "saved-command", expectedRunRevision: 6, expectedVersionId: "earlier-version", instruction: "用户原修改意见",
    }));
    expect(await screen.findByText(/原修订结果已记录/)).toBeInTheDocument();
  });

  it.each(["pending", "completed"] as const)("can recover a server-confirmed %s command even when the local pointer is corrupt", async state => {
    const command = { commandId: "server-original", action: "revise" as const, state,
      expectedRunRevision: 6, expectedVersionId: "publish-v1", instruction: "服务端保存的原意见",
      createdAt: "now", updatedAt: "now", billingPending: true };
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([command]);
    localStorage.setItem("vf:document-command:corrupt-pointer:publish-package", "{broken-json");
    const onRevise = vi.fn(async () => undefined);
    setup({ runId: "corrupt-pointer", onRevise });
    const recover = await screen.findByRole("button", { name: "取回原操作结果" });
    expect(recover).toBeEnabled();
    fireEvent.click(recover);
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith("publish-package", {
      commandId: command.commandId, expectedRunRevision: 6, expectedVersionId: "publish-v1", instruction: command.instruction,
    }));
  });

  it("keeps known server recovery usable when local pointer reads are denied, without allowing new calls", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([{
      commandId: "server-audit", action: "audit", state: "pending", expectedRunRevision: 7,
      expectedVersionId: "publish-v1", createdAt: "now", updatedAt: "now", billingPending: true,
    }]);
    const onAudit = vi.fn(async () => undefined);
    setup({ runId: "denied-pointer", onAudit });
    const recover = await screen.findByRole("button", { name: "取回原操作结果" });
    expect(recover).toBeEnabled();
    expect(screen.getByRole("button", { name: /重新审计当前版本/ })).toBeDisabled();
    fireEvent.click(recover);
    await waitFor(() => expect(onAudit).toHaveBeenCalledWith("publish-package", {
      commandId: "server-audit", expectedRunRevision: 7, expectedVersionId: "publish-v1",
    }));
  });

  it.each(["server-empty", "server-unavailable"] as const)("does not assume a corrupt local pointer is unaccepted when %s", async mode => {
    localStorage.setItem("vf:document-command:unresolved-pointer:publish-package", "{broken-json");
    const lookup = vi.spyOn(studioApi, "documentCommands");
    if (mode === "server-empty") lookup.mockResolvedValue([]); else lookup.mockRejectedValue(new Error("offline"));
    const onAudit = vi.fn(async () => undefined);
    setup({ runId: "unresolved-pointer", onAudit });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /重新审计当前版本/ })).toBeDisabled();
    expect(onAudit).not.toHaveBeenCalled();
  });

  it("does not attach an old recovery error to another run after navigation", async () => {
    let rejectPending!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectPending = reject; });
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async (runId) => runId === "old-run" ? [{
      commandId: "old-command", action: "revise", state: "pending", expectedRunRevision: 7,
      expectedVersionId: "v1", instruction: "旧片修改意见", createdAt: "now", updatedAt: "now", billingPending: true,
    }] : []);
    const props = { runId: "old-run", nodeId: "publish-package", runRevision: 7, effectiveVersionId: "v1", busy: false,
      contentReview: { status: "not_audited", summary: "", suggestions: [] },
      onRevise: () => pending, onAudit: async () => undefined };
    const { rerender } = render(<NodeDocumentCommands {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "取回原操作结果" }));
    rerender(<NodeDocumentCommands {...props} runId="new-run" />);
    rejectPending(new Error("旧片的连接错误"));
    await waitFor(() => expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeEnabled());
    expect(screen.queryByText("旧片的连接错误")).not.toBeInTheDocument();
    expect(screen.queryByText(/原操作结果已取回/)).not.toBeInTheDocument();
  });

  it("does not call a late audit receipt the current unaudited version's success", async () => {
    let finish!: () => void;
    let submitted: { commandId: string; expectedRunRevision: number; expectedVersionId: string } | undefined;
    const onAudit = vi.fn<Parameters<typeof NodeDocumentCommands>[0]["onAudit"]>(async (_nodeId, input) => {
      if (!input.commandId) throw new Error("Expected the UI to bind its original command ID.");
      submitted = { ...input, commandId: input.commandId };
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const lookup = vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => submitted ? [{ ...submitted,
      action: "audit", state: "applied", createdAt: "now", updatedAt: "now", billingPending: true }] : []);
    const props = { runId: "late-audit", nodeId: "publish-package", runRevision: 1, effectiveVersionId: "a", busy: false,
      contentReview: { status: "not_audited", summary: "本版未审", suggestions: [] }, onRevise: vi.fn(), onAudit };
    const view = render(<NodeDocumentCommands {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "审计当前版本（会调用模型）" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "审计当前版本（会调用模型）" }));
    await waitFor(() => expect(onAudit).toHaveBeenCalledTimes(1));
    view.rerender(<NodeDocumentCommands {...props} runRevision={2} effectiveVersionId="b" />);
    finish();
    await waitFor(() => expect(lookup.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "审计当前版本（会调用模型）" })).toBeEnabled());
    expect(screen.queryByText(/已记录本版审计结论/)).not.toBeInTheDocument();
    expect(await screen.findByText(/原审计结果已记录.*对应的版本/)).toBeInTheDocument();
  });

  it.each(["unchanged", "stale", "completed"] as const)("uses the original revision's %s record instead of promising a new current draft", async state => {
    let submitted: { commandId: string; expectedRunRevision: number; expectedVersionId: string; instruction: string } | undefined;
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => submitted ? [{ ...submitted,
      action: "revise", state, createdAt: "now", updatedAt: "now", billingPending: true }] : []);
    setup({ runId: `result-${state}`, onRevise: async (_nodeId, input) => {
      if (!input.commandId) throw new Error("Expected the UI to bind its original command ID.");
      submitted = { ...input, commandId: input.commandId };
    } });
    const textbox = screen.getByRole("textbox", { name: "修订意见" });
    await waitFor(() => expect(textbox).toBeEnabled());
    fireEvent.change(textbox, { target: { value: "原意见不丢" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await screen.findByText(`稿件修订 · ${state === "unchanged" ? "已完成 · 稿件未改动" : state === "stale" ? "旧版结果已归档" : "结果已生成 · 等待写入"}`);
    expect(screen.queryByText(/新稿是未审版本/)).not.toBeInTheDocument();
    if (state !== "unchanged") expect(textbox).toHaveValue("原意见不丢");
  });

  it("acknowledges a verified revision after its normal A-to-new-B transition without misclassifying success", async () => {
    let completed: import("../src/shared/api.js").StudioDocumentCommand | undefined;
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => completed ? [completed] : []);
    const props = { runId: "successful-revision", nodeId: "publish-package", runRevision: 1, effectiveVersionId: "a", busy: false,
      contentReview: { status: "not_audited", summary: "本版未审", suggestions: [] }, onAudit: vi.fn(async () => undefined),
      onRevise: async (_nodeId: string, input: Parameters<Parameters<typeof NodeDocumentCommands>[0]["onRevise"]>[1]) => {
        if (!input.commandId) throw new Error("Expected the UI to bind its original command ID.");
        completed = { ...input, commandId: input.commandId, action: "revise", state: "applied", createdAt: "now", updatedAt: "now", billingPending: true };
        view.rerender(<NodeDocumentCommands {...props} runRevision={2} effectiveVersionId="b" />);
      } };
    const view = render(<NodeDocumentCommands {...props} />);
    const textbox = screen.getByRole("textbox", { name: "修订意见" });
    await waitFor(() => expect(textbox).toBeEnabled());
    fireEvent.change(textbox, { target: { value: "原意见已成功形成新稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    expect(await screen.findByText(/原修订结果已记录/)).toBeInTheDocument();
    expect(textbox).toHaveValue("");
    expect(screen.queryByText(/旧版结果已归档/)).not.toBeInTheDocument();
  });

  it("does not claim success or clear sent feedback if its receipt cannot be read", async () => {
    let returned = false;
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => { if (returned) throw new Error("offline"); return []; });
    setup({ runId: "unverified-receipt", onRevise: async () => { returned = true; } });
    const textbox = screen.getByRole("textbox", { name: "修订意见" });
    await waitFor(() => expect(textbox).toBeEnabled());
    fireEvent.change(textbox, { target: { value: "还没核清，不要删除" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await screen.findByText(/暂时无法核对原文字操作/);
    expect(textbox).toHaveValue("还没核清，不要删除");
    expect(screen.queryByText(/原修订结果已记录/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    expect(localStorage.getItem("vf:document-command:unverified-receipt:publish-package")).not.toBeNull();
  });

  it("does not let an old callback delete another command's local pointer or replacement feedback", async () => {
    let finish!: () => void;
    let submitted: { commandId: string; expectedRunRevision: number; expectedVersionId: string; instruction: string } | undefined;
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => submitted ? [{ ...submitted,
      action: "revise", state: "applied", createdAt: "now", updatedAt: "now", billingPending: true }] : []);
    const onRevise = vi.fn<Parameters<typeof NodeDocumentCommands>[0]["onRevise"]>(async (_nodeId, input) => {
      if (!input.commandId) throw new Error("Expected the UI to bind its original command ID.");
      submitted = { ...input, commandId: input.commandId };
      await new Promise<void>(resolve => { finish = resolve; });
    });
    setup({ runId: "replacement-feedback", onRevise });
    const textbox = screen.getByRole("textbox", { name: "修订意见" });
    await waitFor(() => expect(textbox).toBeEnabled());
    fireEvent.change(textbox, { target: { value: "已发送的意见" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    const key = "vf:document-command:replacement-feedback:publish-package";
    localStorage.setItem(key, JSON.stringify({ commandId: "another-command", action: "audit", state: "created", expectedRunRevision: 8,
      expectedVersionId: "publish-v2", createdAt: "later", updatedAt: "later", billingPending: true }));
    // 注入后续输入变化，模拟异步回调抵达时已经保留了另一份意见；不视为用户绕过禁用控件。
    fireEvent.change(textbox, { target: { value: "后来的意见不能被清掉" } });
    finish();
    await screen.findByText("稿件修订 · 已完成");
    expect(textbox).toHaveValue("后来的意见不能被清掉");
    expect(JSON.parse(localStorage.getItem(key)!).commandId).toBe("another-command");
  });

  it("does not send a new model command when durable browser storage fails", async () => {
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([]);
    const onRevise = vi.fn(async () => undefined);
    setup({ runId: "run-storage", onRevise });
    await waitFor(() => expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeEnabled());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.change(screen.getByLabelText("修订意见"), { target: { value: "保留这段完整意见" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    expect(await screen.findByText(/尚未发送给模型/)).toBeInTheDocument();
    expect(onRevise).not.toHaveBeenCalled();
    expect(screen.getByLabelText("修订意见")).toHaveValue("保留这段完整意见");
  });

  it("uses a new command identity only when the user intentionally audits again", async () => {
    const onAudit = vi.fn<Parameters<typeof NodeDocumentCommands>[0]["onAudit"]>(async () => undefined);
    setup({ onAudit });
    fireEvent.click(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ }));
    await waitFor(() => expect(onAudit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ }));
    await waitFor(() => expect(onAudit).toHaveBeenCalledTimes(2));
    expect(onAudit.mock.calls[0]?.[1].commandId).not.toEqual(onAudit.mock.calls[1]?.[1].commandId);
  });

  it("appends selected suggestions to the existing instruction without overwriting or sending", async () => {
    setup();
    const box = screen.getByLabelText("修订意见") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的原始意见：标题再短一点。" } });
    fireEvent.click(screen.getByLabelText("标题写出“少做一个决定”这个动作。"));
    fireEvent.click(screen.getByLabelText("描述补充具体收益。"));
    fireEvent.click(screen.getByRole("button", { name: "加入修改意见（2）" }));
    expect(box.value).toBe("我的原始意见：标题再短一点。\n标题写出“少做一个决定”这个动作。\n描述补充具体收益。");
    // 追加不发送：没有触发任何调用，复选清空避免二次追加。
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeInTheDocument();
  });

  it("sends the instruction bound to the seen revision and version", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setup({
      onRevise: async (_nodeId, input) => { calls.push({ ...input }); },
    });
    fireEvent.change(screen.getByLabelText("修订意见"), { target: { value: "标题改得更具体。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ instruction: "标题改得更具体。", expectedRunRevision: 7, expectedVersionId: "publish-v1" });
    // 没有 runId/耐久回执的回调只能证明发起，不得宣称已生成新稿。
    expect(screen.queryByText(/新稿是未审版本/)).not.toBeInTheDocument();
  });

  it("blocks sending when the instruction exceeds 4000 characters and keeps the full draft", () => {
    setup();
    const box = screen.getByLabelText("修订意见") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "改".repeat(4001) } });
    const send = screen.getByRole("button", { name: "发送修订意见" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/超过 4000 字/)).toBeInTheDocument();
    expect(box.value).toHaveLength(4001);
  });

  it("audits the current exact version without producing a draft", async () => {
    const audits: Array<Record<string, unknown>> = [];
    setup({
      onAudit: async (_nodeId, input) => { audits.push({ ...input }); },
    });
    fireEvent.click(screen.getByRole("button", { name: /审计当前版本（会调用模型）/ }));
    await waitFor(() => expect(audits).toHaveLength(1));
    expect(audits[0]).toMatchObject({ expectedRunRevision: 7, expectedVersionId: "publish-v1" });
  });

  it("shows revision failures instead of pretending the draft was sent", async () => {
    setup({
      onRevise: async () => { throw new Error("这条制作已被其他操作更新，请刷新后重新发送修订意见。"); },
    });
    fireEvent.change(screen.getByLabelText("修订意见"), { target: { value: "标题改得更具体。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    expect(await screen.findByText(/已被其他操作更新/)).toBeInTheDocument();
    expect(screen.queryByText(/已提交修订/)).not.toBeInTheDocument();
    // 草稿保留，方便用户刷新后重发。
    expect((screen.getByLabelText("修订意见") as HTMLTextAreaElement).value).toBe("标题改得更具体。");
  });

  it("does not revive unsent feedback after A-to-B-to-A and does not stale it on same-target refresh", async () => {
    const onRevise = vi.fn(async () => undefined);
    const props = { nodeId: "publish-package", runRevision: 1, effectiveVersionId: "a", busy: false,
      contentReview: { status: "not_audited", summary: "本版未审", suggestions: [] }, onRevise, onAudit: vi.fn(async () => undefined) };
    const view = render(<NodeDocumentCommands {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "修订意见" }), { target: { value: "A的未发送意见" } });
    view.rerender(<NodeDocumentCommands {...props} runRevision={2} />);
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeEnabled();
    view.rerender(<NodeDocumentCommands {...props} runRevision={3} effectiveVersionId="b" />);
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    view.rerender(<NodeDocumentCommands {...props} runRevision={4} />);
    expect(screen.getByRole("textbox", { name: "修订意见" })).toHaveValue("A的未发送意见");
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "将这些意见用于当前稿" }));
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeEnabled();
    expect(onRevise).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith("publish-package", expect.objectContaining({ expectedRunRevision: 4, expectedVersionId: "a", instruction: "A的未发送意见" })));
  });

  it("keeps an unsent instruction with its original version until the user explicitly retargets it", async () => {
    let sent = 0;
    const props = {
      nodeId: "reference-grammar", runRevision: 7, effectiveVersionId: "v1", busy: false,
      contentReview: { status: "has_suggestions", summary: "旧版意见", suggestions: ["旧版的改法"] },
      onRevise: async () => { sent += 1; }, onAudit: async () => undefined,
    };
    const { rerender } = render(<NodeDocumentCommands {...props} />);
    fireEvent.change(screen.getByLabelText("修订意见"), { target: { value: "我对旧稿的意见" } });
    fireEvent.click(screen.getByLabelText("旧版的改法"));
    rerender(<NodeDocumentCommands {...props} runRevision={8} effectiveVersionId="v2"
      contentReview={{ status: "has_suggestions", summary: "新版意见", suggestions: ["新版的改法"] }} />);
    expect(screen.getByLabelText("新版的改法")).not.toBeChecked();
    expect(screen.getByLabelText("修订意见")).toHaveValue("我对旧稿的意见");
    expect(screen.getByRole("button", { name: "发送修订意见" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "将这些意见用于当前稿" }));
    fireEvent.click(screen.getByRole("button", { name: "发送修订意见" }));
    await waitFor(() => expect(sent).toBe(1));
  });
});
