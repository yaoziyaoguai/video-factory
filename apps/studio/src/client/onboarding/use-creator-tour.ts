import { driver, type Driver, type DriveStep, type PopoverDOM } from "driver.js";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { completeCreatorTour, hasCompletedCreatorTour } from "./creator-tour-state.js";
import { FULL_CREATOR_TOUR_STEPS, pageTourSteps } from "./creator-tour-steps.js";

const AUTO_START_DELAY_MS = 650;

interface CreatorTourControls {
  startFullTour: (returnFocus?: HTMLElement | null) => void;
  startPageTour: (returnFocus?: HTMLElement | null) => void;
}

interface TourLifecycle {
  tour: Driver;
  rememberCompletion: boolean;
  /** 本次导览结束后要归还焦点的真实启动控件；自动导览没有 launcher，保持 undefined。 */
  returnFocus?: HTMLElement | null;
  /** 程序化销毁（路由切换/卸载/被新导览替换）不归还焦点，避免抢新页面焦点。 */
  suppressFocusRestore?: boolean;
  /** 已排定的归还帧；新导览或路由清理时必须取消，防止旧导览晚到 focus。 */
  restoreFrame?: number;
}

export function useCreatorTour(): CreatorTourControls {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTourRef = useRef<TourLifecycle | undefined>(undefined);
  const replayPendingRef = useRef(false);
  const autoStartCheckedRef = useRef(false);
  // 跨路由的完整导览：真实 launcher 随 pending 一起穿过 navigate，不回头猜 activeElement。
  const pendingReturnFocusRef = useRef<HTMLElement | null>(null);
  // 自然结束的 tour 会清掉 activeTourRef，但归还帧可能还没到；
  // 新导览/路由清理必须能取消这个“已结束但未归还”的帧。
  const restorePendingRef = useRef<TourLifecycle | undefined>(undefined);

  const clearPendingReplay = useCallback(() => {
    replayPendingRef.current = false;
    pendingReturnFocusRef.current = null;
  }, []);

  const cancelFocusRestore = useCallback(() => {
    const pending = restorePendingRef.current;
    if (pending?.restoreFrame !== undefined) {
      window.cancelAnimationFrame(pending.restoreFrame);
      delete pending.restoreFrame;
    }
    restorePendingRef.current = undefined;
  }, []);

  // driver 1.8.0 的 destroy 在 onDestroyed 之后还会同步执行内部 i.focus()，
  // 因此归还必须排到下一帧：同步回调里的 focus 会被库自己的回焦覆盖。
  const scheduleFocusRestore = useCallback((lifecycle: TourLifecycle) => {
    const target = lifecycle.returnFocus;
    if (!target || lifecycle.suppressFocusRestore) return;
    lifecycle.restoreFrame = window.requestAnimationFrame(() => {
      if (restorePendingRef.current === lifecycle) restorePendingRef.current = undefined;
      delete lifecycle.restoreFrame;
      // 目标已卸载/不可聚焦时安全降级：不抛错、不聚焦隐藏按钮、不伪造别的返回目标。
      if (!target.isConnected || target.hasAttribute("disabled")) return;
      if (typeof target.checkVisibility === "function" && !target.checkVisibility()) return;
      target.focus();
    });
    restorePendingRef.current = lifecycle;
  }, []);

  const destroyActiveTour = useCallback((options: { suppressFocusRestore: boolean }) => {
    cancelFocusRestore();
    const active = activeTourRef.current;
    if (!active?.tour.isActive()) return;
    active.rememberCompletion = false;
    active.suppressFocusRestore = options.suppressFocusRestore;
    active.tour.destroy();
  }, [cancelFocusRestore]);

  const runTour = useCallback((steps: DriveStep[], rememberCompletion: boolean, returnFocus?: HTMLElement | null) => {
    destroyActiveTour({ suppressFocusRestore: true });
    let lifecycle: TourLifecycle;
    const tour = driver({
      steps: availableTourSteps(steps),
      animate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      duration: 240,
      overlayColor: getComputedStyle(document.documentElement).getPropertyValue("--frame").trim() || "#17232d",
      overlayOpacity: 0.72,
      smoothScroll: true,
      allowClose: true,
      allowScroll: true,
      allowKeyboardControl: true,
      stagePadding: 8,
      stageRadius: 8,
      popoverOffset: 12,
      popoverClass: "video-factory-tour",
      showProgress: true,
      progressText: "第 {{current}} 步，共 {{total}} 步",
      prevBtnText: "上一步",
      nextBtnText: "下一步",
      doneBtnText: "完成",
      skipMissingElement: true,
      waitForElement: 3_500,
      onPopoverRender: addEarlyExitControl,
      onDestroyed: () => {
        if (lifecycle.rememberCompletion) completeCreatorTour();
        if (activeTourRef.current === lifecycle) activeTourRef.current = undefined;
        scheduleFocusRestore(lifecycle);
      },
    });
    lifecycle = { tour, rememberCompletion, ...(returnFocus !== undefined ? { returnFocus } : {}) };
    activeTourRef.current = lifecycle;
    tour.drive();
  }, [destroyActiveTour, scheduleFocusRestore]);

  const startFullTour = useCallback((returnFocus?: HTMLElement | null) => {
    // 用户已经主动选择导览；即使首页的首次自动启动计时器仍在等待，也不能再覆盖这次选择。
    autoStartCheckedRef.current = true;
    if (location.pathname !== "/") {
      replayPendingRef.current = true;
      pendingReturnFocusRef.current = returnFocus ?? null;
      navigate("/");
      return;
    }
    clearPendingReplay();
    runTour(FULL_CREATOR_TOUR_STEPS, true, returnFocus);
  }, [clearPendingReplay, location.pathname, navigate, runTour]);

  const startPageTour = useCallback((returnFocus?: HTMLElement | null) => {
    // 用户在导航等待期间显式选择了另一条导览，旧的跨路由请求随即失效。
    autoStartCheckedRef.current = true;
    clearPendingReplay();
    runTour(pageTourSteps(location.pathname), false, returnFocus);
  }, [clearPendingReplay, location.pathname, runTour]);

  useEffect(() => {
    if (location.pathname !== "/") {
      // 已到达首页后又离开，不能在日后返回首页时突然重放旧导览。
      clearPendingReplay();
      return;
    }
    const replayRequested = replayPendingRef.current;
    const shouldAutoStart = !autoStartCheckedRef.current && !hasCompletedCreatorTour();
    if (!replayRequested && !shouldAutoStart) return;

    const timer = window.setTimeout(() => {
      if (replayPendingRef.current) {
        replayPendingRef.current = false;
        const carriedReturnFocus = pendingReturnFocusRef.current;
        pendingReturnFocusRef.current = null;
        runTour(FULL_CREATOR_TOUR_STEPS, true, carriedReturnFocus);
        return;
      }
      if (autoStartCheckedRef.current || hasCompletedCreatorTour()) return;
      autoStartCheckedRef.current = true;
      runTour(FULL_CREATOR_TOUR_STEPS, true);
    }, AUTO_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [clearPendingReplay, location.pathname, runTour]);

  useEffect(() => {
    destroyActiveTour({ suppressFocusRestore: true });
  }, [location.pathname, destroyActiveTour]);

  useEffect(() => () => {
    clearPendingReplay();
    destroyActiveTour({ suppressFocusRestore: true });
  }, [clearPendingReplay, destroyActiveTour]);

  return { startFullTour, startPageTour };
}

const FUTURE_PRODUCTION_TARGETS = new Set([
  '[data-tour="opportunity-focus"]',
  '[data-tour="visual-direction"]',
  '[data-tour="director-panel"]',
  '[data-tour="create-production"]',
  '[data-tour="production-recipes"]',
  '[data-tour="production-start"]',
]);

// 候选被采用后，后续生产控件才会出现；其余不存在的控件直接跳过，避免空状态导览长时间卡住。
function availableTourSteps(steps: DriveStep[]): DriveStep[] {
  const canAdopt = document.querySelector('[data-tour="candidate-adopt"]:not(:disabled)') !== null;
  const hasProductionContext = canAdopt
    || document.querySelector('[data-tour="opportunity-focus"], [data-tour="create-production"], [data-tour="production-recipes"]') !== null;

  return steps.filter((step) => {
    if (!step.element || typeof step.element !== "string") return true;
    if (step.element === '[data-tour="candidate-adopt"]:not(:disabled)') return canAdopt;
    if (FUTURE_PRODUCTION_TARGETS.has(step.element) && hasProductionContext) return true;
    return document.querySelector(step.element) !== null;
  });
}

function addEarlyExitControl(popover: PopoverDOM, { driver: tour }: { driver: Driver }): void {
  popover.closeButton.setAttribute("aria-label", "提前结束引导");
  popover.closeButton.setAttribute("title", "提前结束引导");
  if (popover.footer.querySelector(".tour-end-button")) return;
  const endButton = document.createElement("button");
  endButton.className = "tour-end-button";
  endButton.type = "button";
  endButton.textContent = "提前结束";
  endButton.addEventListener("click", () => tour.destroy());
  popover.footer.insertBefore(endButton, popover.footerButtons);
}
