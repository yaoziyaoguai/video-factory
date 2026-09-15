import type { CreativeTreatment } from "./creative-treatment.js";
import type { PlanningIssue } from "./creative-planning.js";
import type { ProductionCapabilities } from "./production-capabilities.js";

export interface TreatmentReadiness {
  status: "ready" | "revise_here" | "needs_source";
  issues: PlanningIssue[];
}

interface SuppliedTreatmentSource {
  sourceId: string;
}

export function assessTreatmentReadiness(
  treatment: CreativeTreatment,
  suppliedSources: readonly SuppliedTreatmentSource[],
  capabilities: ProductionCapabilities,
): TreatmentReadiness {
  const suppliedSourceIds = new Set(suppliedSources.map((source) => source.sourceId.trim()));
  const issues: PlanningIssue[] = [];

  treatment.evidenceRequirements.forEach((requirement, index) => {
    const missingBoundSources = requirement.acquisition === "supplied"
      && (requirement.suppliedSourceIds.length === 0
        || requirement.suppliedSourceIds.some((sourceId) => !suppliedSourceIds.has(sourceId)));
    const retrievableProvider = requirement.retrievalProviderId === null
      ? undefined
      : capabilities.assetProviders.find((provider) => (
        provider.id === requirement.retrievalProviderId
        && provider.deliveryTypes.includes("stock_video")
      ));
    const invalidRetrieval = requirement.acquisition === "pipeline_retrievable"
      && (requirement.requirement !== "illustration_only" || !retrievableProvider);
    const unavailableExternalSource = requirement.acquisition === "external_required";

    if (!requirement.critical || (!missingBoundSources && !invalidRetrieval && !unavailableExternalSource)) return;

    const reason = unavailableExternalSource
      ? `核心兑现“${requirement.claim}”依赖当前流水线无法取得的外部材料。`
      : missingBoundSources
        ? `核心兑现“${requirement.claim}”声明已有来源，但当前输入没有可证明的来源绑定。`
        : requirement.requirement === "factual_support"
          ? `核心事实“${requirement.claim}”不能由通用图库或生成画面代替证据。`
          : `核心示意“${requirement.claim}”指定的图库来源当前不可用或不支持视频检索。`;
    const routeCanBeRevised = invalidRetrieval && requirement.requirement === "illustration_only";
    issues.push({
      id: `treatment-readiness-${index + 1}`,
      target: routeCanBeRevised ? "director" : "source",
      beatIds: [requirement.beatId],
      scenePositions: [],
      reason,
      requiredChange: unavailableExternalSource
        ? "请补充所需的专属材料，或明确调整本片承诺。"
        : missingBoundSources
          ? "请补充并绑定支持该主张的来源材料。"
          : routeCanBeRevised
            ? "请在当前允许且已就绪的生成或正式卡片能力中重选示意路线，不要向用户索要专属材料。"
            : "请为核心事实补充真实来源，不能用图库或生成画面代证。",
      evidenceArtifactIds: [...requirement.suppliedSourceIds],
    });
  });

  const status = issues.some((issue) => issue.target === "source" || issue.target === "user")
    ? "needs_source"
    : issues.length > 0 ? "revise_here" : "ready";
  return { status, issues };
}
