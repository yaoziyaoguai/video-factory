import type { StudioProvider, StudioTemplate } from "./api.js";

type TemplateWithShotSlots = Pick<StudioTemplate, "shotSlots">;
type VisualSource = Pick<StudioProvider, "deliveryTypes">;

export interface VisualSourceCompatibilityIssue {
  missingSlotCount: number;
  missingCapabilities: string[];
  message: string;
}

export function visualSourceCompatibilityIssue(
  template: TemplateWithShotSlots | undefined,
  sources: VisualSource[],
): VisualSourceCompatibilityIssue | undefined {
  if (!template) return undefined;
  const available = new Set(sources.flatMap((source) => capabilitiesFor(source.deliveryTypes ?? [])));
  const missingSlots = template.shotSlots.filter((slot) => (
    !slot.allowedCapabilities.some((capability) => available.has(capability))
  ));
  if (missingSlots.length === 0) return undefined;
  const missingCapabilities = [...new Set(missingSlots.flatMap((slot) => slot.allowedCapabilities))];
  const requirementLabels = missingCapabilities.map(capabilityLabel);
  return {
    missingSlotCount: missingSlots.length,
    missingCapabilities,
    message: `当前素材池无法执行模板中的 ${missingSlots.length} 个镜头（缺少：${requirementLabels.join("、")}）。请启用与这些镜头匹配的画面来源，或更换模板。`,
  };
}

function capabilitiesFor(deliveryTypes: NonNullable<StudioProvider["deliveryTypes"]>): string[] {
  const capabilities = new Set<string>();
  if (deliveryTypes.length > 0) capabilities.add("asset.prepare");
  if (deliveryTypes.some((type) => type === "stock_video" || type === "stock_image")) capabilities.add("asset.search");
  if (deliveryTypes.includes("generated_image")) capabilities.add("asset.generate.image");
  if (deliveryTypes.includes("generated_video")) capabilities.add("asset.generate.video");
  if (deliveryTypes.some((type) => type === "generated_image" || type === "generated_video")) capabilities.add("asset.generate");
  return [...capabilities];
}

function capabilityLabel(capability: string): string {
  if (capability === "asset.search") return "素材库";
  if (capability === "asset.generate.image") return "图片生成";
  if (capability === "asset.generate.video") return "视频生成";
  if (capability === "asset.generate") return "AI 生成画面";
  if (capability === "asset.prepare") return "任一画面来源";
  return capability;
}
