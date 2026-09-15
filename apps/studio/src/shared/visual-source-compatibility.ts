import type { StudioProvider, StudioTemplate } from "./api.js";

type TemplateWithShotSlots = Pick<StudioTemplate, "shotSlots">;
type VisualSource = Pick<StudioProvider, "deliveryTypes">;

export interface VisualSourceCompatibilityIssue {
  missingSlotCount: number;
  missingCapabilities: string[];
  message: string;
}

export function visualSourceCompatibilityIssue(
  _template: TemplateWithShotSlots | undefined,
  sources: VisualSource[],
): VisualSourceCompatibilityIssue | undefined {
  const available = new Set(sources.flatMap((source) => capabilitiesFor(source.deliveryTypes ?? [])));
  if (available.has("asset.prepare")) return undefined;
  return {
    missingSlotCount: 0,
    missingCapabilities: ["asset.prepare"],
    message: "当前素材池没有任何可用画面来源。请至少启用一种真实可执行的图库、生成或正式卡片来源。",
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
