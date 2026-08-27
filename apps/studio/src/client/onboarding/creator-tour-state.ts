export const CREATOR_TOUR_VERSION = "creator-canvas-v2";
export const CREATOR_TOUR_STORAGE_KEY = "videofactory.creator-tour";

type CreatorTourStorage = Pick<Storage, "getItem" | "setItem">;

export function hasCompletedCreatorTour(storage?: CreatorTourStorage): boolean {
  const target = storage ?? browserStorage();
  if (!target) return false;
  try {
    return target.getItem(CREATOR_TOUR_STORAGE_KEY) === CREATOR_TOUR_VERSION;
  } catch {
    return false;
  }
}

export function completeCreatorTour(storage?: CreatorTourStorage): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.setItem(CREATOR_TOUR_STORAGE_KEY, CREATOR_TOUR_VERSION);
  } catch {
    // 隐私模式或浏览器策略可能禁用存储，导览本身仍应可用。
  }
}

function browserStorage(): CreatorTourStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
