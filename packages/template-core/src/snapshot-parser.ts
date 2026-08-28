import { parseProductionTemplate } from "./template-parser.js";
import type {
  ProductionBlueprint,
  ProductionTemplateSnapshot,
  TemplateLayer,
  TemplateLayerReceipt,
} from "./types.js";

const LAYERS = new Set<TemplateLayer>(["system", "platform", "template", "series", "run", "node"]);

export function parseProductionBlueprint(value: unknown): ProductionBlueprint {
  const input = requireRecord(value, "resolvedBlueprint");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const parsed = parseProductionTemplate({
    id: "resolved-blueprint",
    version: 1,
    status: "draft",
    name: "Resolved blueprint",
    description: "Validated runtime blueprint.",
    category: "resolved",
    platforms: [input.platform],
    durationSeconds: input.durationSeconds,
    automationLevel: input.automationLevel,
    storyStructure: input.storyStructure,
    shotSlots: input.shotSlots,
    visualSystem: input.visualSystem,
    soundSystem: input.soundSystem,
    qualityRules: input.qualityRules,
    capabilityRequirements: input.capabilityRequirements,
    costPolicy: input.costPolicy,
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
    costPolicy: clone(parsed.costPolicy),
  };
}

export function parseProductionTemplateSnapshot(value: unknown): ProductionTemplateSnapshot {
  const input = requireRecord(value, "templateSnapshot");
  const templateId = requireString(input.templateId, "templateSnapshot.templateId");
  const templateVersion = requirePositiveInteger(input.templateVersion, "templateSnapshot.templateVersion");
  const resolvedAt = requireString(input.resolvedAt, "templateSnapshot.resolvedAt");
  if (Number.isNaN(Date.parse(resolvedAt))) throw new Error("templateSnapshot.resolvedAt must be an ISO timestamp.");
  const resolvedBlueprint = parseProductionBlueprint(input.resolvedBlueprint);
  if (!Array.isArray(input.sourceLayers) || input.sourceLayers.length === 0) {
    throw new Error("templateSnapshot.sourceLayers must be a non-empty array.");
  }
  const sourceLayers: TemplateLayerReceipt[] = input.sourceLayers.map((item, index) => {
    const layer = requireRecord(item, `templateSnapshot.sourceLayers[${index}]`);
    if (!LAYERS.has(layer.layer as TemplateLayer)) throw new Error(`templateSnapshot.sourceLayers[${index}].layer is invalid.`);
    return {
      layer: layer.layer as TemplateLayer,
      sourceId: requireString(layer.sourceId, `templateSnapshot.sourceLayers[${index}].sourceId`),
      appliedFields: requireStringArray(layer.appliedFields, `templateSnapshot.sourceLayers[${index}].appliedFields`),
    };
  });
  const rawSources = requireRecord(input.fieldSources, "templateSnapshot.fieldSources");
  const fieldSources: Record<string, TemplateLayer> = {};
  for (const [field, layer] of Object.entries(rawSources)) {
    if (!LAYERS.has(layer as TemplateLayer)) throw new Error(`templateSnapshot.fieldSources.${field} is invalid.`);
    fieldSources[field] = layer as TemplateLayer;
  }
  const modelDefaults = input.modelDefaults === undefined
    ? undefined
    : requireModelDefaults(input.modelDefaults, "templateSnapshot.modelDefaults");
  return deepFreeze({
    templateId,
    templateVersion,
    resolvedAt,
    resolvedBlueprint,
    ...(modelDefaults ? { modelDefaults } : {}),
    sourceLayers,
    fieldSources,
  });
}

function requireModelDefaults(value: unknown, field: string): Record<string, string> {
  const input = requireRecord(value, field);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error(`${field} must not contain more than 32 entries.`);
  return Object.fromEntries(entries.map(([providerId, modelId]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) throw new Error(`${field}.${providerId} is invalid.`);
    const normalized = requireString(modelId, `${field}.${providerId}`);
    if (normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
      throw new Error(`${field}.${providerId} is invalid.`);
    }
    return [providerId, normalized];
  }));
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer.`);
  return Number(value);
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
