import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "../src/client/hooks/useDialogFocus.js";

function Fixture({ open }: { open: boolean }) {
  const ref = useDialogFocus<HTMLDivElement>(open, () => undefined);
  if (!open) return null;
  return <div>
    <button type="button">外面</button>
    <div ref={ref} role="dialog" aria-modal="true" aria-label="确认弹窗">
      <button type="button">第一个</button>
      <details>
        <summary>更多</summary>
        <button type="button">折叠内容里</button>
      </details>
      <div aria-hidden="true">
        <button type="button">隐藏祖先里</button>
      </div>
      <button type="button">最后一个</button>
    </div>
  </div>;
}

describe("useDialogFocus", () => {
  it("skips candidates inside closed details and aria-hidden ancestors when trapping focus", () => {
    render(<Fixture open />);
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "最后一个" });
    first.focus();
    // 从第一个往回 Tab：必须落在"最后一个"，而不是折叠内容或 aria-hidden 祖先里的按钮。
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    // 从最后一个继续 Tab：回绕到"第一个"，隐藏候选不参与循环。
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const onClose = vi.fn();
    function Toggle({ open }: { open: boolean }) {
      const ref = useDialogFocus<HTMLDivElement>(open, onClose);
      if (!open) return null;
      return <div ref={ref} role="dialog" aria-modal="true" aria-label="确认弹窗">
        <button type="button">里面</button>
      </div>;
    }
    const rendered = render(<div><button type="button">触发按钮</button><Toggle open={false} /></div>);
    screen.getByRole("button", { name: "触发按钮" }).focus();
    rendered.rerender(<div><button type="button">触发按钮</button><Toggle open /></div>);
    rendered.rerender(<div><button type="button">触发按钮</button><Toggle open={false} /></div>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "触发按钮" }));
  });

  it("ignores hidden candidates for initial focus and keeps a closed disclosure summary available", () => {
    function HiddenFixture() {
      const ref = useDialogFocus<HTMLDivElement>(true, () => undefined);
      return <div ref={ref} role="dialog" aria-modal="true" aria-label="隐藏候选测试" tabIndex={-1}>
        <button type="button" hidden data-dialog-initial-focus>隐藏初焦</button>
        <button type="button" style={{ display: "none" }}>CSS 隐藏</button>
        <button type="button">可见首项</button>
        <details><summary>高级设置</summary><button type="button">收起内容</button></details>
        <button type="button">可见末项</button>
      </div>;
    }
    render(<HiddenFixture />);
    const first = screen.getByRole("button", { name: "可见首项" });
    const last = screen.getByRole("button", { name: "可见末项" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    expect(screen.getByText("高级设置")).toBeInTheDocument();
  });
});
