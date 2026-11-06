import type { MaterialProvider } from "../../shared/agent/generated/contracts.js";

// 候选与已采用媒体沿用同一来源显示名，未知来源不猜作 Pexels。
export const MATERIAL_PROVIDER_LABELS: Record<MaterialProvider, string> = {
  pexels: "Pexels", pixabay: "Pixabay", unsplash: "Unsplash", coverr: "Coverr",
  wikimedia: "Wikimedia Commons", nasa: "NASA", met: "The Met", cleveland: "Cleveland", archive: "Internet Archive", freetouse: "FreeToUse", incompetech: "Incompetech",
};
