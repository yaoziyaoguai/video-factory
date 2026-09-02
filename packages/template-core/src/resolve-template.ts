import { parseProductionTemplate } from "./template-parser.js";
import type {
  ProductionBlueprint,
  ProductionBlueprintPatch,
  ProductionTemplateSnapshot,
  ResolveTemplateSnapshotInput,
  TemplateLayer,
  TemplateLayerReceipt,
} from "./types.js";

const PRODUCTION_BLUEPRINT_FIELDS: readonly (keyof ProductionBlueprint)[] = [
  "platform",
  "durationSeconds",
  "automationLevel",
  "storyStructure",
  "shotSlots",
  "visualSystem",
  "soundSystem",
  "qualityRules",
  "capabilityRequirements",
];

export function resolveTemplateSnapshot(input: ResolveTemplateSnapshotInput): ProductionTemplateSnapshot {
  if (Number.isNaN(Date.parse(input.resolvedAt))) throw new Error("resolvedAt must be an ISO timestamp.");
  const template = parseProductionTemplate(input.template);
  const templateBlueprint: ProductionBlueprintPatch = {
    durationSeconds: template.durationSeconds,
    automationLevel: template.automationLevel,
    storyStructure: clone(template.storyStructure),
    shotSlots: clone(template.shotSlots),
    visualSystem: clone(template.visualSystem),
    soundSystem: clone(template.soundSystem),
    qualityRules: clone(template.qualityRules),
    capabilityRequirements: clone(template.capabilityRequirements),
  };
  const layers: Array<{ layer: TemplateLayer; sourceId: string; patch: ProductionBlueprintPatch | undefined }> = [
    { layer: "system", sourceId: "system-defaults", patch: input.systemDefaults },
    { layer: "platform", sourceId: "platform-profile", patch: input.platformProfile },
    { layer: "template", sourceId: `${template.id}@${template.version}`, patch: templateBlueprint },
    { layer: "series", sourceId: "series-bible", patch: input.seriesBible },
    { layer: "run", sourceId: "run-overrides", patch: input.runOverrides },
  ];
  const resolved: ProductionBlueprintPatch = {};
  const sourceLayers: TemplateLayerReceipt[] = [];
  const fieldSources: Record<string, TemplateLayer> = {};

  for (const item of layers) {
    if (!item.patch) continue;
    const appliedFields = PRODUCTION_BLUEPRINT_FIELDS.filter((field) => item.patch![field] !== undefined);
    if (appliedFields.length === 0) continue;
    for (const field of appliedFields) {
      const value = item.patch[field as keyof ProductionBlueprint];
      (resolved as Record<string, unknown>)[field] = clone(value);
      fieldSources[field] = item.layer;
    }
    sourceLayers.push({ layer: item.layer, sourceId: item.sourceId, appliedFields });
  }

  const resolvedBlueprint = validateResolvedBlueprint(resolved, template.id, template.version, input.resolvedAt);
  return deepFreeze({
    templateId: template.id,
    templateVersion: template.version,
    resolvedAt: input.resolvedAt,
    resolvedBlueprint,
    ...(template.modelDefaults ? { modelDefaults: clone(template.modelDefaults) } : {}),
    sourceLayers,
    fieldSources,
  });
}

function validateResolvedBlueprint(
  value: ProductionBlueprintPatch,
  templateId: string,
  templateVersion: number,
  timestamp: string,
): ProductionBlueprint {
  const required: Array<keyof ProductionBlueprint> = [
    "platform",
    "durationSeconds",
    "automationLevel",
    "storyStructure",
    "shotSlots",
    "visualSystem",
    "soundSystem",
    "qualityRules",
    "capabilityRequirements",
  ];
  const missing = required.filter((field) => value[field] === undefined);
  if (missing.length > 0) throw new Error(`Template resolution is missing required fields: ${missing.join(", ")}.`);
  const blueprint = value as ProductionBlueprint;
  const parsed = parseProductionTemplate({
    id: templateId,
    version: templateVersion,
    status: "draft",
    name: "Resolved template",
    description: "Validated production blueprint.",
    category: "resolved",
    platforms: [blueprint.platform],
    durationSeconds: blueprint.durationSeconds,
    automationLevel: blueprint.automationLevel,
    storyStructure: blueprint.storyStructure,
    shotSlots: blueprint.shotSlots,
    visualSystem: blueprint.visualSystem,
    soundSystem: blueprint.soundSystem,
    qualityRules: blueprint.qualityRules,
    capabilityRequirements: blueprint.capabilityRequirements,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    platform: parsed.platforms[0]!,
    durationSeconds: parsed.durationSeconds,
    automationLevel: parsed.automationLevel,
    storyStructure: clone(parsed.storyStructure),
    shotSlots: clone(parsed.shotSlots),
    visualSystem: clone(parsed.visualSystem),
    soundSystem: clone(parsed.soundSystem),
    qualityRules: clone(parsed.qualityRules),
    capabilityRequirements: clone(parsed.capabilityRequirements),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
