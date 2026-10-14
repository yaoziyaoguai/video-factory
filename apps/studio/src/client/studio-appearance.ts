import { useEffect, useState } from "react";

export type StudioAppearance = "light" | "dark";
const storageKey = "videofactory.studio.appearance";

function savedAppearance(): StudioAppearance {
  try {
    return localStorage.getItem(storageKey) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function initializeStudioAppearance(): StudioAppearance {
  const appearance = savedAppearance();
  document.documentElement.dataset.appearance = appearance;
  return appearance;
}

export function useStudioAppearance() {
  const [appearance, setAppearance] = useState<StudioAppearance>(savedAppearance);
  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    try {
      localStorage.setItem(storageKey, appearance);
    } catch {
      // 浏览器禁用存储时仍允许当前页面切换外观。
    }
  }, [appearance]);
  return [appearance, setAppearance] as const;
}
