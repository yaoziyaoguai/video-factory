import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreativeDraftReader } from "../src/client/components/CreativeDraftReader.js";

describe("CreativeDraftReader", () => {
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

  it("explains sound capability tokens without rewriting the creator's draft or hiding its original", () => {
    const soundPrinciples = [
      "保持轻声解说；narration=true，pauseControl=text_hint；musicTrack/soundEffectsTrack=false。",
      "原声模式 audio.narration=false；continuousNarrationGroups=false；不要删掉雨声意图。",
      "仅在转折处留白，句尾自然收住。",
      "当前无音乐轨与音效轨（musicTrack、soundEffectsTrack 均为 false），因此不做配乐与音效设计。",
    ];
    const value = { soundPrinciples };
    const before = JSON.stringify(value);
    render(<CreativeDraftReader stage="treatment" value={value} />);
    expect(screen.getByText(/保持轻声解说；独立旁白：启用/)).toBeVisible();
    expect(screen.getByText(/停顿：通过文字提示表达/)).toBeVisible();
    expect(screen.getAllByText(/独立音乐与音效轨：未接入/)).toHaveLength(2);
    expect(screen.getByText("当前无音乐轨与音效轨（独立音乐与音效轨：未接入），因此不做配乐与音效设计。")).toBeVisible();
    expect(screen.getByText(/原声模式 独立旁白：不单独合成/)).toBeVisible();
    expect(screen.getByText(/原声模式 独立旁白.*不要删掉雨声意图/)).toBeVisible();
    expect(screen.getAllByText(soundPrinciples[2]!)[0]).toBeVisible();
    const original = screen.getByText(soundPrinciples[0]!).closest("details");
    expect(original).not.toHaveAttribute("open");
    expect(within(original!).getByText("查看声音方向原文")).toBeVisible();
    expect(JSON.stringify(value)).toBe(before);
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
    expect(screen.getByText("第二段正文")).toBeInTheDocument();
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => notifyResize?.());
    expect(animations[0]!.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "阅读第 3 段" }));
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("第三段正文")).toBeInTheDocument();
    media.matches = true;
    act(() => { for (const listener of listeners) listener(); });
    expect(animations[1]!.cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "阅读第 1 段" }));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(screen.getByText("第一段正文")).toBeInTheDocument();
    media.matches = false;
    fireEvent.click(screen.getByRole("button", { name: "阅读第 2 段" }));
    unmount();
    expect(animations[2]!.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stage: "treatment" as const, value: { viewerPromise: "全片承诺", payoff: "结尾兑现", progression: [
      { beatId: "opening", purpose: "提出问题", viewerGain: "先看到问题" },
      { beatId: "answer", purpose: "给出答案", viewerGain: "得到具体方法" },
    ] }, button: "阅读内容推进 2", first: "提出问题：先看到问题", second: "给出答案：得到具体方法", context: "全片承诺" },
    { stage: "director" as const, value: { visualBible: { pacing: "先快后慢" }, shots: [
      { scenePosition: 3, visibleAction: "开场人物动作", deliveryType: "stock_video" },
      { scenePosition: 8, visibleAction: "结尾人物动作", deliveryType: "image" },
    ] }, button: "阅读镜头 8", first: "开场人物动作", second: "结尾人物动作", context: /先快后慢/ },
    { stage: "script" as const, value: { narrativeArc: "全片结构", scenes: [
      { position: 3, narration: "无ID第一段" },
      { position: 8, narration: "无ID第二段" },
    ] }, button: "阅读第 8 段", first: "无ID第一段", second: "无ID第二段", context: "全片结构" },
  ])("uses the real $stage structure for segment reading and retains whole-draft context", ({ stage, value, button, first, second, context }) => {
    render(<CreativeDraftReader stage={stage} value={value} />);
    const reader = screen.getByRole("region", { name: "稿件阅读" });
    expect(within(reader).getByText(first)).toBeInTheDocument();
    expect(within(reader).queryByText(second)).not.toBeInTheDocument();
    fireEvent.click(within(reader).getByRole("button", { name: button }));
    expect(within(reader).getByText(second)).toBeInTheDocument();
    expect(within(reader).queryByText(first)).not.toBeInTheDocument();
    expect(within(reader).getByText(context)).toBeInTheDocument();
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
    { stage: "treatment" as const, value: { progression: ["第一份正文", "第二份正文"] } },
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
    expect(screen.getByText("第二份正文")).toBeInTheDocument();
  });
});
