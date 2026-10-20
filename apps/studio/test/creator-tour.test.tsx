import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Config } from "driver.js";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AppShell } from "../src/client/components/AppShell.js";
import {
  CREATOR_TOUR_STORAGE_KEY,
  CREATOR_TOUR_VERSION,
  completeCreatorTour,
  hasCompletedCreatorTour,
} from "../src/client/onboarding/creator-tour-state.js";

const driverMock = vi.hoisted(() => {
  const instance = {
    destroy: vi.fn(),
    drive: vi.fn(),
    getActiveStep: vi.fn(),
    getState: vi.fn(),
    isActive: vi.fn(() => false),
    moveNext: vi.fn(),
  };
  return { factory: vi.fn((_config?: Config) => instance), instance };
});

vi.mock("driver.js", () => ({ driver: driverMock.factory }));

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
  };
}

describe("creator tour state", () => {
  it("only accepts the current version and persists completion", () => {
    const empty = memoryStorage();
    const stale = memoryStorage("creator-canvas-v0");
    const current = memoryStorage(CREATOR_TOUR_VERSION);

    expect(hasCompletedCreatorTour(empty)).toBe(false);
    expect(hasCompletedCreatorTour(stale)).toBe(false);
    expect(hasCompletedCreatorTour(current)).toBe(true);

    completeCreatorTour(empty);
    expect(empty.setItem).toHaveBeenCalledWith(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    expect(hasCompletedCreatorTour(empty)).toBe(true);
  });

  it("degrades safely when browser storage is unavailable", () => {
    const broken = {
      getItem: vi.fn(() => { throw new Error("storage denied"); }),
      setItem: vi.fn(() => { throw new Error("storage denied"); }),
    };

    expect(hasCompletedCreatorTour(broken)).toBe(false);
    expect(() => completeCreatorTour(broken)).not.toThrow();
  });
});

describe("creator tour routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    window.localStorage.clear();
    driverMock.factory.mockClear();
    driverMock.instance.drive.mockClear();
    driverMock.instance.destroy.mockClear();
    driverMock.instance.getActiveStep.mockReset();
    driverMock.instance.getState.mockReset();
    driverMock.instance.isActive.mockReturnValue(false);
    driverMock.instance.moveNext.mockClear();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts automatically once on the creator home and remembers dismissal", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><div data-tour="topic-inbox">选题入口</div></AppShell>
      </MemoryRouter>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.factory).toHaveBeenCalledOnce();
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();

    const config = driverMock.factory.mock.calls[0]?.[0];
    expect(config?.steps?.some((step) => step.element === '[data-tour="candidate-adopt"]:not(:disabled)')).toBe(false);
    (config?.onDestroyed as (() => void) | undefined)?.();
    expect(window.localStorage.getItem(CREATOR_TOUR_STORAGE_KEY)).toBe(CREATOR_TOUR_VERSION);
    unmount();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><div data-tour="topic-inbox">选题入口</div></AppShell>
      </MemoryRouter>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.factory).toHaveBeenCalledOnce();
  });

  it("still auto-starts once under React StrictMode", async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell><div data-tour="topic-inbox">选题入口</div></AppShell>
        </MemoryRouter>
      </StrictMode>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.factory).toHaveBeenCalledOnce();
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
  });

  it("destroys a stale overlay on route change without marking the full tour complete", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, "stale-version");
    driverMock.instance.isActive.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<Link to="/resources">前往资源</Link>} />
            <Route path="/resources" element={<div>资源页</div>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const config = driverMock.factory.mock.calls[0]?.[0];

    fireEvent.click(screen.getByRole("link", { name: "前往资源" }));
    expect(driverMock.instance.destroy).toHaveBeenCalledOnce();
    (config?.onDestroyed as (() => void) | undefined)?.();
    expect(window.localStorage.getItem(CREATOR_TOUR_STORAGE_KEY)).toBe("stale-version");
  });

  it("opens a persistent guide and returns home only for the complete walkthrough", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/resources"]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<div data-tour="topic-inbox">今日机会页</div>} />
            <Route path="/resources" element={<div>资源页</div>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    expect(screen.getByRole("dialog", { name: "创作向导" })).toHaveTextContent("挑选题定方案跑制作做审片导出交付看复盘");
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    expect(screen.getByText("今日机会页")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
  });

  it("returns a manually started full tour to its launcher after returning home", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(<MemoryRouter initialEntries={["/resources"]}><AppShell>
      <div data-tour="topic-inbox">选题入口</div>
    </AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const config = driverMock.factory.mock.calls[0]?.[0];
    // driver 在 onDestroyed 之后仍会把焦点归还到其记录的旧元素。
    (config?.onDestroyed as (() => void) | undefined)?.();
    document.getElementById("main-content")?.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(launcher).toHaveFocus();
  });

  it("keeps project and review pages unobstructed until the user opens the guide", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/projects"]}>
        <AppShell><div data-tour="project-queue">项目队列</div></AppShell>
      </MemoryRouter>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.queryByRole("dialog", { name: "创作向导" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    expect(screen.getByRole("dialog", { name: "创作向导" })).toHaveTextContent("到了制作记录，接下来这样做");
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));

    expect(screen.getByText("项目队列")).toBeInTheDocument();
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
    const config = driverMock.factory.mock.calls[0]?.[0];
    expect(config?.steps?.some((step) => step.element === '[data-tour="project-queue"]')).toBe(true);
  });

  it("explains the assets page using its existing source and filter controls", () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(<MemoryRouter initialEntries={["/assets"]}><AppShell>
      <section aria-label="素材库概况">已保存素材</section><section aria-label="素材筛选">来源筛选</section>
    </AppShell></MemoryRouter>);
    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
    const config = driverMock.factory.mock.calls[0]?.[0];
    expect(config?.steps?.map(step => step.element)).toEqual(['[aria-label="素材库概况"]', '[aria-label="素材筛选"]']);
  });

  it("explains how to recover a failed run in the page tour", () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/projects/run-1"]}>
        <AppShell><div data-tour="run-header">失败的制作</div></AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));

    const config = driverMock.factory.mock.calls[0]?.[0];
    const runHeader = config?.steps?.find((step) => step.element === '[data-tour="run-header"]');
    expect(runHeader?.popover?.description).toMatch(/失败时先查看恢复方式/);
    expect(runHeader?.popover?.description).toMatch(/不要直接重复创建任务/);
  });

  it("includes the real candidate adoption action in the complete walkthrough", () => {
    expect(driverMock.factory).not.toHaveBeenCalled();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><button data-tour="candidate-adopt">采用到制作区</button></AppShell>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));

    const config = driverMock.factory.mock.calls[0]?.[0];
    const adoptionStep = config?.steps?.find((step) => step.element === '[data-tour="candidate-adopt"]:not(:disabled)');
    expect(adoptionStep).toMatchObject({
      disableActiveInteraction: false,
      onHighlightStarted: expect.any(Function),
    });
  });

  it("advances action steps when the highlighted control is clicked during its animation", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><button data-tour="candidate-adopt">采用到制作区</button></AppShell>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));

    const config = driverMock.factory.mock.calls[0]?.[0];
    const adoptionStep = config?.steps?.find((step) => step.element === '[data-tour="candidate-adopt"]:not(:disabled)');
    const target = screen.getByRole("button", { name: "采用到制作区" });
    expect(adoptionStep?.onHighlightStarted).toBeTypeOf("function");

    driverMock.instance.getActiveStep.mockReturnValue(adoptionStep);
    driverMock.instance.getState.mockReturnValueOnce(() => undefined).mockReturnValue(undefined);
    adoptionStep?.onHighlightStarted?.(
      target,
      adoptionStep!,
      { config: { duration: 240 }, driver: driverMock.instance } as never,
    );
    fireEvent.click(target);

    expect(driverMock.instance.moveNext).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(260); });
    expect(driverMock.instance.moveNext).toHaveBeenCalledOnce();
  });

  it("adds an explicit early-exit control to every tour popover", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><div data-tour="topic-inbox">选题入口</div></AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    const config = driverMock.factory.mock.calls[0]?.[0];
    const footer = document.createElement("footer");
    const footerButtons = document.createElement("div");
    footer.append(footerButtons);
    const closeButton = document.createElement("button");
    config?.onPopoverRender?.({ footer, footerButtons, closeButton } as never, { driver: driverMock.instance } as never);

    const endButton = footer.querySelector<HTMLButtonElement>(".tour-end-button");
    expect(endButton).toHaveTextContent("提前结束");
    endButton?.click();
    expect(driverMock.instance.destroy).toHaveBeenCalledOnce();
    expect(closeButton).toHaveAttribute("aria-label", "提前结束引导");
  });

  it("returns a same-page tour to its launcher on the next frame after completion", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(<MemoryRouter initialEntries={["/projects"]}><AppShell><div data-tour="project-queue">项目队列</div></AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));

    const config = driverMock.factory.mock.calls.at(-1)?.[0];
    (config?.onDestroyed as (() => void) | undefined)?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(launcher).toHaveFocus();
  });

  it("still returns focus to the opener when the guide is collapsed without a tour", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(<MemoryRouter initialEntries={["/projects"]}><AppShell><div>项目队列</div></AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    fireEvent.click(screen.getByRole("button", { name: "收起创作向导" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(launcher).toHaveFocus();
  });

  it("does not steal focus on the new page when a route change destroys an active tour", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    driverMock.instance.isActive.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<Link to="/resources">前往资源</Link>} />
            <Route path="/resources" element={<button type="button">资源页控件</button>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    const config = driverMock.factory.mock.calls.at(-1)?.[0];

    fireEvent.click(screen.getByRole("link", { name: "前往资源" }));
    expect(driverMock.instance.destroy).toHaveBeenCalledOnce();
    // driver 1.8.0 在 onDestroyed 之后还有内部回焦；路由清理必须既不排归还帧，也不覆盖新页面焦点。
    (config?.onDestroyed as (() => void) | undefined)?.();
    const pageControl = screen.getByRole("button", { name: "资源页控件" });
    pageControl.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(pageControl).toHaveFocus();
  });

  it("does not steal focus when the app unmounts mid-tour", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    driverMock.instance.isActive.mockReturnValue(true);
    const { unmount } = render(<MemoryRouter initialEntries={["/"]}><AppShell><div data-tour="topic-inbox">选题入口</div></AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    const config = driverMock.factory.mock.calls.at(-1)?.[0];

    unmount();
    expect(driverMock.instance.destroy).toHaveBeenCalledOnce();
    expect(() => (config?.onDestroyed as (() => void) | undefined)?.()).not.toThrow();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.body).toHaveFocus();
  });

  it("cancels a pending restore frame when a new tour replaces the old one", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    driverMock.instance.isActive.mockReturnValue(true);
    render(<MemoryRouter initialEntries={["/"]}><AppShell><div data-tour="topic-inbox">选题入口</div></AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
    const pageTourConfig = driverMock.factory.mock.calls.at(-1)?.[0];

    // 旧导览已结束、归还帧已排队，但尚未到来
    (pageTourConfig?.onDestroyed as (() => void) | undefined)?.();
    // 新完整导览在同一页替换它：旧归还帧必须被取消
    fireEvent.click(launcher);
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    expect(driverMock.factory).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(launcher).not.toHaveFocus();
  });

  it("cancels a completed tour's pending focus restore when the route changes", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/projects"]}>
        <AppShell>
          <Routes>
            <Route path="/projects" element={<><div data-tour="project-queue">项目队列</div><Link to="/resources">前往资源</Link></>} />
            <Route path="/resources" element={<button type="button">资源页控件</button>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
    const config = driverMock.factory.mock.calls.at(-1)?.[0];

    // 导览自然结束后 active lifecycle 已清空，但下一帧的焦点归还仍在等待。
    (config?.onDestroyed as (() => void) | undefined)?.();
    fireEvent.click(screen.getByRole("link", { name: "前往资源" }));
    const pageControl = screen.getByRole("button", { name: "资源页控件" });
    pageControl.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(pageControl).toHaveFocus();
  });

  it("cancels a queued cross-route walkthrough when the user starts a page tour", async () => {
    render(
      <MemoryRouter initialEntries={["/resources"]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<div data-tour="topic-inbox">今日机会页</div>} />
            <Route path="/resources" element={<div>资源页</div>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    expect(screen.getByText("今日机会页")).toBeInTheDocument();

    // 首页的650ms重放尚未发生；用户明确选择当前页导览，旧请求必须失效。
    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
  });

  it("does not let the pending first-visit auto tour replace a manually selected page tour", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell><div data-tour="topic-inbox">选题入口</div></AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
  });

  it("does not replay an abandoned cross-route walkthrough after returning home later", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(
      <MemoryRouter initialEntries={["/resources"]}>
        <AppShell>
          <Routes>
            <Route path="/" element={<Link to="/projects">离开首页</Link>} />
            <Route path="/projects" element={<Link to="/">返回首页</Link>} />
            <Route path="/resources" element={<div>资源页</div>} />
          </Routes>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    fireEvent.click(screen.getByRole("link", { name: "离开首页" }));
    fireEvent.click(screen.getByRole("link", { name: "返回首页" }));

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).not.toHaveBeenCalled();
  });

  it("does not fabricate a return target for the automatic tour", async () => {
    render(<MemoryRouter initialEntries={["/"]}><AppShell><div data-tour="topic-inbox">选题入口</div></AppShell></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();

    const before = document.activeElement;
    const config = driverMock.factory.mock.calls.at(-1)?.[0];
    (config?.onDestroyed as (() => void) | undefined)?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).toBe(before);
  });

  it("degrades safely when the recorded launcher is unmounted before the tour ends", async () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    render(<MemoryRouter initialEntries={["/projects"]}><AppShell><div data-tour="project-queue">项目队列</div></AppShell></MemoryRouter>);
    const launcher = screen.getAllByRole("button", { name: "打开创作向导" })[0]!;
    launcher.focus();
    fireEvent.click(launcher);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));

    launcher.remove();
    const config = driverMock.factory.mock.calls.at(-1)?.[0];
    expect(() => (config?.onDestroyed as (() => void) | undefined)?.()).not.toThrow();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.body).toHaveFocus();
  });

  it("disables tour animation under reduced motion", () => {
    window.localStorage.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: query.includes("prefers-reduced-motion"),
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<MemoryRouter initialEntries={["/projects"]}><AppShell><div data-tour="project-queue">项目队列</div></AppShell></MemoryRouter>);
      fireEvent.click(screen.getAllByRole("button", { name: "打开创作向导" })[0]!);
      fireEvent.click(screen.getByRole("button", { name: "讲解当前页面" }));
      const config = driverMock.factory.mock.calls.at(-1)?.[0];
      expect(config?.animate).toBe(false);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
