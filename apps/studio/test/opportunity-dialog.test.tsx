import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OpportunityDialog } from "../src/client/components/OpportunityDialog.js";

describe("opportunity draft protection", () => {
  it("keeps both input modes and cancels only the discard prompt with Escape", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<OpportunityDialog open onClose={close} onSubmit={vi.fn()} />);
    await user.type(screen.getByLabelText("选题标题"), "保留手动稿");
    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByLabelText(/^机会数据/), { target: { value: '{"title":"导入草稿"}' } });
    await user.click(screen.getByRole("tab", { name: "手动录入" }));
    expect(screen.getByLabelText("选题标题")).toHaveValue("保留手动稿");
    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    expect(screen.getByLabelText(/^机会数据/)).toHaveValue('{"title":"导入草稿"}');
    await user.keyboard("{Escape}{Escape}");
    expect(screen.queryByRole("heading", { name: "要放弃本次填写吗？" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^机会数据/)).toHaveFocus();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes pristine and reverted forms without warning and reopens empty", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const props = { onClose: close, onSubmit: vi.fn() };
    const { rerender } = render(<OpportunityDialog open {...props} />);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("选题标题"), "删除的想法");
    await user.clear(screen.getByLabelText("选题标题"));
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(2);
    await user.type(screen.getByLabelText("选题标题"), "放弃的想法");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "放弃并关闭" }));
    rerender(<OpportunityDialog open={false} {...props} />);
    rerender(<OpportunityDialog open {...props} />);
    expect(screen.getByLabelText("选题标题")).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("blocks close during a save and retains values on rejection", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    let reject!: (error: Error) => void;
    const submit = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
    render(<OpportunityDialog open onClose={close} onSubmit={submit} />);
    for (const label of ["选题标题", "目标受众", "核心痛点", "开场钩子"]) await user.type(screen.getByLabelText(label), "要保留的内容");
    await user.click(screen.getByRole("button", { name: "保存机会" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(close).not.toHaveBeenCalled();
    reject(new Error("保存暂不可用"));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存暂不可用");
    expect(screen.getByLabelText("选题标题")).toHaveValue("要保留的内容");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "返回填写" })).toBeVisible();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["close", "cancel", "backdrop", "escape"])("protects unsaved input through %s", async (entry) => {
    const user = userEvent.setup();
    const close = vi.fn();
    const submit = vi.fn();
    render(<OpportunityDialog open onClose={close} onSubmit={submit} />);
    await user.type(screen.getByLabelText("选题标题"), "我的未保存想法");
    if (entry === "close") await user.click(screen.getByRole("button", { name: "关闭" }));
    if (entry === "cancel") await user.click(screen.getByRole("button", { name: "取消" }));
    if (entry === "backdrop") await user.click(screen.getByRole("dialog").parentElement!);
    if (entry === "escape") await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "要放弃本次填写吗？" })).toBeVisible();
    expect(screen.getByRole("button", { name: "返回填写" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "返回填写" }));
    expect(screen.getByLabelText("选题标题")).toHaveValue("我的未保存想法");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "放弃并关闭" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});

// DG-UX-02（新前端 Dogfood 修复执行包 R3）：手动想法的来源表达必须真实——
// 没填参考链接就是零来源（origin manual + evidence []），不能伪造占位信号。

describe("manual opportunity source honesty (DG-UX-02)", () => {
  it("saves a manual idea with zero sources unless a reference link is actually provided", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_input: import("../src/shared/api.js").StudioOpportunityInput) => undefined);
    const props = { onClose: vi.fn(), onSubmit };
    const view = render(<OpportunityDialog open {...props} />);
    await user.type(screen.getByLabelText("选题标题"), "窗边三分钟，找回注意力");
    await user.type(screen.getByLabelText("目标受众"), "注意力分散的上班族");
    await user.type(screen.getByLabelText("核心痛点"), "工作间隙刷不掉的走神");
    await user.type(screen.getByLabelText("开场钩子"), "先放下手机看窗边三分钟");
    await user.click(screen.getByRole("button", { name: "保存机会" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const withoutLink = onSubmit.mock.calls[0]![0];
    expect(withoutLink.origin).toBe("manual");
    expect(withoutLink.evidence).toEqual([]);

    onSubmit.mockClear();
    view.unmount();
    render(<OpportunityDialog open {...props} />);
    await user.type(screen.getByLabelText("选题标题"), "带参考链接的想法");
    await user.type(screen.getByLabelText("目标受众"), "注意力分散的上班族");
    await user.type(screen.getByLabelText("核心痛点"), "工作间隙刷不掉的走神");
    await user.type(screen.getByLabelText("开场钩子"), "先放下手机看窗边三分钟");
    await user.click(screen.getByText("可选：补充参考来源"));
    await user.type(screen.getByLabelText("参考链接"), "https://qa-reference.invalid/article");
    await user.click(screen.getByRole("button", { name: "保存机会" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const withLink = onSubmit.mock.calls[0]![0];
    expect(withLink.origin).toBe("manual");
    expect(withLink.evidence).toHaveLength(1);
    expect(withLink.evidence[0]).toMatchObject({
      source: "manual-supplement",
      platform: "manual",
      evidenceUrl: "https://qa-reference.invalid/article",
    });
  });
});
