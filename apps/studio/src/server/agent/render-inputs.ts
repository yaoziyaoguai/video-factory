import type { RenderParameters } from "../../shared/agent/generated/contracts.js";

// 探测、能力校验与worker共用冻结槽位用途；音乐/配音不进入视觉片段列表。
export function renderSlotRole(parameters: RenderParameters, slot: number): "video" | "image" | "audio" | "none" {
  if (parameters.assembly === "narrated_concat") {
    return slot === parameters.narrationInputSlot ? "audio" : "video";
  }
  if (parameters.assembly === "timed_narrated_concat") {
    return slot === parameters.narrationInputSlot ? "audio"
      : parameters.segments.find(segment => segment.inputSlot === slot)?.kind ?? "none";
  }
  if (parameters.assembly === "mixed_concat") {
    if (slot === parameters.music?.inputSlot || slot === parameters.narration?.inputSlot) return "audio";
    return parameters.segments.find(segment => segment.inputSlot === slot)?.kind ?? "none";
  }
  return "video";
}
