import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreativeDraftReader } from "../src/client/components/CreativeDraftReader.js";

describe("CreativeDraftReader", () => {
  it("puts the audience's actual script before production reference text", () => {
    render(<CreativeDraftReader stage="script" value={{  scenes: [
      { id: "opening", position: 1, duration: 4, narration: "这是观众先听到的话", visual_prompt: "窗边" },
    ] }} />);
    const spoken = within(screen.getByRole("region", { name: "稿件正文" })).getByText("这是观众先听到的话");
    const reference = screen.getByText("窗边");
    expect(spoken.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete (window as Partial<Window>).matchMedia;
  });

  it("reads a free-form concept as one continuous draft without segment navigation", () => {
    const value = { concept: "看雨落在窗沿。\n停一会儿，然后结束。" };
    render(<CreativeDraftReader stage="treatment" value={value} />);
    expect(screen.getByText(/看雨落在窗沿/)).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "稿件段落" })).not.toBeInTheDocument();
    expect(screen.queryByText("查看整篇")).not.toBeInTheDocument();
    expect(value.concept).toBe("看雨落在窗沿。\n停一会儿，然后结束。");
  });

  it("shows readable director delivery labels in segment and whole-draft views without changing the plan", () => {
    const routes = [
      ["generated_video", "AI 视频"], ["generated_image", "AI 图片"],
      ["stock_video", "素材库视频"], ["stock_image", "素材库图片"],
      ["editorial_card", "图文说明卡"], ["unrecognized_route", "待确认获取方式"],
    ] as const;
    const value = { shots: routes.map(([deliveryType], index) => ({ scenePosition: index + 1, deliveryType, visibleAction: `画面 ${index + 1}` })) };
    const original = JSON.stringify(value);
    render(<CreativeDraftReader stage="director" value={value} />);
    expect(screen.getByText("镜头 1 · AI 视频")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "阅读镜头 2" }));
    expect(screen.getByText("镜头 2 · AI 图片")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看整篇" }));
    routes.forEach(([route, label], index) => {
      expect(screen.getByText(`镜头 ${index + 1} · ${label}`)).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(route))).not.toBeInTheDocument();
    });
    expect(JSON.stringify(value)).toBe(original);
  });

  it("cancels interrupted segment feedback and respects reduced motion without delaying the selected content", () => {
    let notifyResize: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => media) });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(Object.assign([new DOMRect()], {
      item: (index: number) => index === 0 ? new DOMRect() : null,
    }));
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }> = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    const { unmount } = render(<CreativeDraftReader stage="script" value={{ scenes: [
      { id: "one", position: 1, narration: "第一段正文" },
      { id: "two", position: 2, narration: "第二段正文" },
      { id: "three", position: 3, narration: "第三段正文" },
    ] }} />);
    expect(animate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "阅读第 2 段" }));
    expect(within(screen.getByRole("region", { name: "稿件正文" })).getByText("第二段正文")).toBeInTheDocument();
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => notifyResize?.());
    expect(animations[0]!.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "阅读第 3 段" }));
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("region", { name: "稿件正文" })).getByText("第三段正文")).toBeInTheDocument();
    media.matches = true;
    act(() => { for (const listener of listeners) listener(); });
    expect(animations[1]!.cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "阅读第 1 段" }));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("region", { name: "稿件正文" })).getByText("第一段正文")).toBeInTheDocument();
    media.matches = false;
    fireEvent.click(screen.getByRole("button", { name: "阅读第 2 段" }));
    unmount();
    expect(animations[2]!.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stage: "director" as const, value: { visualBible: { pacing: "先快后慢" }, shots: [
      { scenePosition: 3, visibleAction: "开场人物动作", deliveryType: "stock_video" },
      { scenePosition: 8, visibleAction: "结尾人物动作", deliveryType: "image" },
    ] }, button: "阅读镜头 8", first: "开场人物动作", second: "结尾人物动作", context: /先快后慢/ },
    { stage: "script" as const, value: {  scenes: [
      { position: 3, narration: "无ID第一段" },
      { position: 8, narration: "无ID第二段" },
    ] }, button: "阅读第 8 段", first: "无ID第一段", second: "无ID第二段", context: undefined },
  ])("uses the real $stage structure for segment reading and retains whole-draft context", ({ stage, value, button, first, second, context }) => {
    render(<CreativeDraftReader stage={stage} value={value} />);
    const reader = screen.getByRole("region", { name: "稿件阅读" });
    const content = within(screen.getByRole("region", { name: "稿件正文" }));
    expect(content.getByText(first)).toBeInTheDocument();
    expect(content.queryByText(second)).not.toBeInTheDocument();
    fireEvent.click(within(reader).getByRole("button", { name: button }));
    expect(content.getByText(second)).toBeInTheDocument();
    expect(content.queryByText(first)).not.toBeInTheDocument();
    if (context) expect(within(reader).getByText(context)).toBeInTheDocument();
    fireEvent.click(within(reader).getByRole("button", { name: "查看整篇" }));
    expect(within(reader).getByText(first)).toBeInTheDocument();
    expect(within(reader).getByText(second)).toBeInTheDocument();
    fireEvent.click(within(reader).getByRole("button", { name: "返回分段阅读" }));
    expect(within(reader).getByRole("button", { name: button })).toHaveAttribute("aria-current", "true");
  });

  it.each([
    { stage: "script" as const, value: { scenes: [{ id: "same", position: 1, narration: "第一份正文" }, { id: "same", position: 2, narration: "第二份正文" }] } },
    { stage: "script" as const, value: { scenes: [{ narration: "第一份正文" }, { narration: "第二份正文" }] } },
    { stage: "script" as const, value: { scenes: [{ position: 3, narration: "第一份正文" }, { position: 3, narration: "第二份正文" }] } },
    { stage: "director" as const, value: { shots: [{ scenePosition: 4, visibleAction: "第一份正文" }, { scenePosition: 4, visibleAction: "第二份正文" }] } },
  ])("retains the complete $stage draft when segment identity is missing, duplicated, or unstructured", ({ stage, value }) => {
    render(<CreativeDraftReader stage={stage} value={value} />);
    expect(screen.queryByRole("navigation", { name: "稿件段落" })).not.toBeInTheDocument();
    expect(screen.getByText("第一份正文")).toBeInTheDocument();
    expect(screen.getByText("第二份正文")).toBeInTheDocument();
  });

  it("retains the original displayed position for a script segment with an id but no explicit position", () => {
    render(<CreativeDraftReader stage="script" value={{ scenes: [
      { id: "first", narration: "第一份正文" },
      { id: "second", duration: 8, narration: "第二份正文" },
    ] }} />);
    fireEvent.click(screen.getByRole("button", { name: "阅读第 2 段" }));
    expect(screen.getByText("第 2 段 · 8 秒")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "稿件正文" })).getByText("第二份正文")).toBeInTheDocument();
  });
});
