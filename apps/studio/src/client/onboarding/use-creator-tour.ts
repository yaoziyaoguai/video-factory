import { driver, type Driver, type DriveStep, type PopoverDOM } from "driver.js";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { completeCreatorTour, hasCompletedCreatorTour } from "./creator-tour-state.js";
import { FULL_CREATOR_TOUR_STEPS, pageTourSteps } from "./creator-tour-steps.js";

const AUTO_START_DELAY_MS = 650;

interface CreatorTourControls {
  startFullTour: () => void;
  startPageTour: () => void;
}

export function useCreatorTour(): CreatorTourControls {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTourRef = useRef<{ tour: Driver; rememberCompletion: boolean } | undefined>(undefined);
  const replayPendingRef = useRef(false);
  const autoStartCheckedRef = useRef(false);

  const runTour = useCallback((steps: DriveStep[], rememberCompletion: boolean) => {
    if (activeTourRef.current?.tour.isActive()) {
      activeTourRef.current.rememberCompletion = false;
      activeTourRef.current.tour.destroy();
    }
    let lifecycle: { tour: Driver; rememberCompletion: boolean };
    const tour = driver({
      steps,
      animate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      duration: 240,
      overlayColor: "#11131a",
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
      },
    });
    lifecycle = { tour, rememberCompletion };
    activeTourRef.current = lifecycle;
    tour.drive();
  }, []);

  const startFullTour = useCallback(() => {
    if (location.pathname !== "/") {
      replayPendingRef.current = true;
      navigate("/");
      return;
    }
    runTour(FULL_CREATOR_TOUR_STEPS, true);
  }, [location.pathname, navigate, runTour]);

  const startPageTour = useCallback(() => {
    runTour(pageTourSteps(location.pathname), false);
  }, [location.pathname, runTour]);

  useEffect(() => {
    if (location.pathname !== "/") return;
    const replayRequested = replayPendingRef.current;
    const shouldAutoStart = !autoStartCheckedRef.current && !hasCompletedCreatorTour();
    if (!replayRequested && !shouldAutoStart) return;

    const timer = window.setTimeout(() => {
      if (replayPendingRef.current) {
        replayPendingRef.current = false;
        runTour(FULL_CREATOR_TOUR_STEPS, true);
        return;
      }
      if (autoStartCheckedRef.current || hasCompletedCreatorTour()) return;
      autoStartCheckedRef.current = true;
      runTour(FULL_CREATOR_TOUR_STEPS, true);
    }, AUTO_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [location.pathname, runTour]);

  useEffect(() => {
    const active = activeTourRef.current;
    if (!active?.tour.isActive()) return;
    active.rememberCompletion = false;
    active.tour.destroy();
  }, [location.pathname]);

  useEffect(() => () => {
    const active = activeTourRef.current;
    if (!active?.tour.isActive()) return;
    active.rememberCompletion = false;
    active.tour.destroy();
  }, []);

  return { startFullTour, startPageTour };
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
