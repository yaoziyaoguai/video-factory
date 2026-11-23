import type { MaterialCandidate, MediaProvenance } from "../../shared/agent/generated/contracts.js";

// 候选与已采用媒体沿用同一来源显示名，未知来源不猜作 Pexels。
export const MATERIAL_PROVIDER_LABELS: Record<MediaProvenance["provider"], string> = {
  user_upload: "用户上传",
  pexels: "Pexels", pixabay: "Pixabay", unsplash: "Unsplash", coverr: "Coverr",
  wikimedia: "Wikimedia Commons", nasa: "NASA", met: "The Met", cleveland: "Cleveland", archive: "Internet Archive", freetouse: "FreeToUse", incompetech: "Incompetech",
};

export const MATERIAL_UNITS = { image: "张图片", video: "段视频", audio: "首音乐" } satisfies Record<MaterialCandidate["kind"], string>;
export const MATERIAL_DEFAULT_TITLES = { image: "未命名图片", video: "未命名视频", audio: "未命名音乐" } satisfies Record<MaterialCandidate["kind"], string>;
