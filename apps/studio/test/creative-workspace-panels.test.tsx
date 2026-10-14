import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreativeWorkspacePanels } from "../src/client/components/CreativeWorkspacePanels.js";

function viewport(initialWidth: number) {
  let width = initialWidth;
  const queries = new Map<string, { media: MediaQueryList; events: EventTarget }>();
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    if (!queries.has(query)) {
      const events = new EventTarget();
      const max = query.match(/max-width:\s*(\d+)px/);
      const min = query.match(/min-width:\s*(\d+)px/);
      const media: MediaQueryList = {
        media: query,
        get matches() { return Boolean(max || min) && (!max || width <= Number(max[1])) && (!min || width >= Number(min[1])); },
        onchange: null,
        addListener: listener => { if (listener) events.addEventListener("change", listener as EventListener); },
        removeListener: listener => { if (listener) events.removeEventListener("change", listener as EventListener); },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      };
      queries.set(query, { media, events });
    }
    return queries.get(query)!.media;
  });
  return (nextWidth: number) => act(async () => {
    const previous = new Map([...queries].map(([query, { media }]) => [query, media.matches]));
    width = nextWidth;
    for (const [query, { media, events }] of queries) {
      if (previous.get(query) !== media.matches) events.dispatchEvent(new Event("change"));
    }
  });
}

const sheet = new CSSStyleSheet();
sheet.replaceSync(readFileSync(resolve(process.cwd(), "src/client/studio-workspace.css"), "utf8"));
// jsdom 的 Tab 模拟不实现 inert；加载真实 hidden 规则，避免库的行内 display 覆盖隐藏。
const hiddenPanelRule = Array.from(sheet.cssRules).find(rule => rule instanceof CSSStyleRule
  && rule.selectorText === ".studio-v3 .creative-discussion-layout > [data-panel][hidden]")!.cssText;

function Workspace() {
  const [activePane, setActivePane] = useState<"draft" | "discussion">("draft");
  const [discussionOpen, setDiscussionOpen] = useState(true);
  return <div className="studio-v3">
    <style>{hiddenPanelRule}</style>
    <CreativeWorkspacePanels activePane={activePane} onPaneChange={setActivePane} discussionOpen={discussionOpen}
      onDiscussionOpenChange={setDiscussionOpen} messageCount={2}
      draft={<article id="creative-draft" aria-label="当前稿件"><label>手动修订<textarea /></label></article>}
      discussion={<section id="creative-chat" aria-label="当前讨论"><label>未发意见<textarea /></label>
        <button type="button" onClick={() => setDiscussionOpen(false)}>收起讨论</button></section>} />
  </div>;
}

afterEach(() => vi.restoreAllMocks());

describe("CreativeWorkspacePanels", () => {
  it("keeps the real Group, panels, separator and input nodes mounted across all three viewport layouts", async () => {
    const resize = viewport(1400);
    const user = userEvent.setup();
    const { container } = render(<Workspace />);
    const group = container.querySelector("[data-group]")!;
    const draftPanel = container.querySelector('[data-panel][data-workspace-pane="draft"]')!;
    const discussionPanel = container.querySelector('[data-panel][data-workspace-pane="discussion"]')!;
    const separator = screen.getByRole("separator", { name: "调整稿件与讨论的宽度" });
    expect(group).toHaveAttribute("data-workspace-layout", "split");
    expect(draftPanel.parentElement).toBe(group);
    expect(discussionPanel.parentElement).toBe(group);
    expect(separator.parentElement).toBe(group);
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-controls", draftPanel.id);
    const draft = screen.getByRole("textbox", { name: "手动修订" }) as HTMLTextAreaElement;
    const composer = screen.getByRole("textbox", { name: "未发意见" }) as HTMLTextAreaElement;
    await user.type(draft, "编辑中的段落");
    await user.type(composer, "尚未发送的意见");
    composer.setSelectionRange(2, 5);
    fireEvent.compositionStart(composer);
    await resize(800);
    expect(group).toHaveAttribute("data-workspace-layout", "stacked");
    expect(screen.getByRole("textbox", { name: "未发意见" })).toBe(composer);
    expect(composer).toHaveFocus();
    expect(composer.selectionStart).toBe(2);
    expect(composer.selectionEnd).toBe(5);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(draftPanel).not.toHaveAttribute("inert");
    expect(discussionPanel).not.toHaveAttribute("inert");
    await resize(600);
    expect(group).toHaveAttribute("data-workspace-layout", "mobile");
    expect(screen.queryByRole("textbox", { name: "未发意见" })).not.toBeInTheDocument();
    expect(discussionPanel).toHaveAttribute("inert");
    expect(discussionPanel).toHaveAttribute("aria-hidden", "true");
    expect(discussionPanel).toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "当前方案" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "建议与讨论 · 2" }));
    expect(screen.getByRole("textbox", { name: "未发意见" })).toBe(composer);
    expect(screen.queryByRole("textbox", { name: "手动修订" })).not.toBeInTheDocument();
    expect(draftPanel).toHaveAttribute("inert");
    expect(draftPanel).toHaveAttribute("hidden");
    fireEvent.compositionEnd(composer);
    await resize(1200);
    expect(container.querySelector("[data-group]")).toBe(group);
    expect(container.querySelector('[data-workspace-pane="draft"]')).toBe(draftPanel);
    expect(container.querySelector('[data-workspace-pane="discussion"]')).toBe(discussionPanel);
    expect(screen.getByRole("separator")).toBe(separator);
    expect(screen.getByRole("textbox", { name: "手动修订" })).toBe(draft);
    expect(screen.getByRole("textbox", { name: "未发意见" })).toBe(composer);
    expect(draft).toHaveValue("编辑中的段落");
    expect(composer).toHaveValue("尚未发送的意见");
    expect(screen.getByRole("button", { name: "专注读稿" })).toHaveFocus();
  });

  it("removes collapsed discussion from accessibility and tab order, then restores the same input", async () => {
    viewport(1400);
    const user = userEvent.setup();
    render(<Workspace />);
    const composer = screen.getByRole("textbox", { name: "未发意见" });
    const discussion = composer.closest("[data-panel]")!;
    await user.type(composer, "收起也不能丢失");
    await user.click(screen.getByRole("button", { name: "收起讨论" }));
    const reopen = screen.getByRole("button", { name: "展开建议与讨论" });
    expect(reopen).toHaveFocus();
    expect(reopen).toHaveAttribute("aria-expanded", "false");
    expect(discussion).toHaveAttribute("inert");
    expect(discussion).toHaveAttribute("hidden");
    expect(discussion).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("region", { name: "当前讨论" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "未发意见" })).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "手动修订" })).toHaveFocus();
    await user.tab();
    expect(composer).not.toHaveFocus();
    await user.click(reopen);
    expect(screen.getByRole("textbox", { name: "未发意见" })).toBe(composer);
    expect(composer).toHaveValue("收起也不能丢失");
    expect(discussion).not.toHaveAttribute("inert");
    expect(discussion).not.toHaveAttribute("hidden");
  });

  it("keeps both panels available in the tablet layout and moves separator focus before it is hidden", async () => {
    const resize = viewport(1001);
    const { container } = render(<Workspace />);
    screen.getByRole("separator").focus();
    await resize(1000);
    expect(container.querySelector("[data-group]")).toHaveAttribute("data-workspace-layout", "stacked");
    expect(screen.getByRole("button", { name: "专注读稿" })).toHaveFocus();
    expect(screen.getByRole("article", { name: "当前稿件" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "当前讨论" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "方案与讨论" })).not.toBeInTheDocument();
    await resize(701);
    expect(container.querySelector("[data-group]")).toHaveAttribute("data-workspace-layout", "stacked");
    expect(screen.getByRole("region", { name: "当前讨论" })).toBeInTheDocument();
    await resize(700);
    expect(container.querySelector("[data-group]")).toHaveAttribute("data-workspace-layout", "mobile");
    expect(screen.getByRole("button", { name: "当前方案" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "当前讨论" })).not.toBeInTheDocument();
  });
});
