import { useState } from "react";
import type { RevisionRef, SubtitleStyle } from "../../shared/agent/generated/contracts.js";

export const subtitleStyles = {
  clean_bottom: "底部简洁", social_pop_center: "居中醒目", cinema_bilingual: "电影双语",
} satisfies Record<SubtitleStyle, string>;

export function subtitleDownloadUrl(ref: RevisionRef, format: "srt" | "vtt") {
  return `/api/agent/v1/artifacts/${encodeURIComponent(ref.artifactId)}/revisions/${encodeURIComponent(ref.revisionId)}/subtitles?format=${format}`;
}

// 工作台实例拥有编辑中的缓冲。编辑键包含精确修订，打开其他作品和往返历史版本不会把编辑串版。
export type ReviewBuffers = Map<string, unknown>;
export function useReviewEdit<T>(buffers: ReviewBuffers, key: string, initial: T) {
  const [value, setValue] = useState<T>(() => buffers.has(key) ? buffers.get(key) as T : initial);
  return {
    value, dirty: buffers.has(key),
    change(next: T) { buffers.set(key, next); setValue(next); },
    clear() { buffers.delete(key); setValue(initial); },
  };
}
