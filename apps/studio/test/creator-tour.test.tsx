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
    expect(screen.getByRole("dialog", { name: "创作向导" })).toHaveTextContent("选选题定方案跑制作做审片多端发布看复盘");
    fireEvent.click(screen.getByRole("button", { name: "完整流程导览" }));
    expect(screen.getByText("今日机会页")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(driverMock.instance.drive).toHaveBeenCalledOnce();
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
    expect(runHeader?.popover?.description).toMatch(/查看真实原因/);
    expect(runHeader?.popover?.description).toMatch(/选择其他模型或调整配置后重试/);
    expect(runHeader?.popover?.description).toMatch(/待重新生成/);
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
});
