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
    vi.spyOn(studioApi, "documentCommands").mockImplementation(async () => settled ? [] : [{
      commandId: "saved-command", action: "revise", state: "pending", expectedRunRevision: 6,
      expectedVersionId: "earlier-version", instruction: "用户原修改意见", createdAt: "now", updatedAt: "now", billingPending: true,
    }]);
    const onRevise = vi.fn(async () => { settled = true; });
    setup({ runId: "run-one", onRevise });
    const recover = await screen.findByRole("button", { name: "取回原操作结果" });
    expect(screen.getByRole("button", { name: "审计当前版本" })).toBeDisabled();
    fireEvent.click(recover);
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith("publish-package", {
      commandId: "saved-command", expectedRunRevision: 6, expectedVersionId: "earlier-version", instruction: "用户原修改意见",
    }));
    expect(await screen.findByText(/原操作结果已取回/)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "审计当前版本" })).toBeEnabled());
    expect(screen.queryByText("旧片的连接错误")).not.toBeInTheDocument();
    expect(screen.queryByText(/原操作结果已取回/)).not.toBeInTheDocument();
  });

  it("does not send a new model command when durable browser storage fails", async () => {
    vi.spyOn(studioApi, "documentCommands").mockResolvedValue([]);
    const onRevise = vi.fn(async () => undefined);
    setup({ runId: "run-storage", onRevise });
    await waitFor(() => expect(screen.getByRole("button", { name: "审计当前版本" })).toBeEnabled());
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
    fireEvent.click(screen.getByRole("button", { name: "审计当前版本" }));
    await waitFor(() => expect(onAudit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "审计当前版本" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "审计当前版本" }));
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
    expect(await screen.findByText(/已提交修订/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "审计当前版本" }));
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
