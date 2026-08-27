import type {
  CapabilityRequirement,
  ProductionTemplate,
  ProductionTemplateInput,
  QualityRuleTemplate,
  ShotSlotTemplate,
  StoryBeatTemplate,
} from "./types.js";

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function parseProductionTemplate(value: unknown): ProductionTemplate {
  const input = record(value, "template");
  const template: ProductionTemplateInput = {
    id: templateId(input.id),
    version: positiveInteger(input.version, "version"),
    status: templateStatus(input.status),
    name: text(input.name, "name"),
    description: text(input.description, "description"),
    category: text(input.category, "category"),
    platforms: uniqueStrings(input.platforms, "platforms"),
    durationSeconds: boundedNumber(input.durationSeconds, "durationSeconds", 10, 600),
    automationLevel: automationLevel(input.automationLevel),
    storyStructure: storyBeats(input.storyStructure),
    shotSlots: shotSlots(input.shotSlots),
    visualSystem: visualSystem(input.visualSystem),
    soundSystem: soundSystem(input.soundSystem),
    qualityRules: qualityRules(input.qualityRules),
    capabilityRequirements: capabilityRequirements(input.capabilityRequirements),
    costPolicy: costPolicy(input.costPolicy),
    createdAt: isoTimestamp(input.createdAt, "createdAt"),
    updatedAt: isoTimestamp(input.updatedAt, "updatedAt"),
  };

  validateReferences(template);
  return template.status === "published" ? deepFreeze(template) : template;
}

function storyBeats(value: unknown): StoryBeatTemplate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("storyStructure must be a non-empty array.");
  const beats = value.map((item, index) => {
    const beat = record(item, `storyStructure[${index}]`);
    if (typeof beat.required !== "boolean") throw new Error(`storyStructure[${index}].required must be a boolean.`);
    return {
      id: text(beat.id, `storyStructure[${index}].id`),
      label: text(beat.label, `storyStructure[${index}].label`),
      purpose: text(beat.purpose, `storyStructure[${index}].purpose`),
      required: beat.required,
    };
  });
  requireUnique(beats.map((beat) => beat.id), "storyStructure ids");
  return beats;
}

function shotSlots(value: unknown): ShotSlotTemplate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("shotSlots must be a non-empty array.");
  const slots = value.map((item, index) => {
    const slot = record(item, `shotSlots[${index}]`);
    if (typeof slot.manualReplacement !== "boolean") {
      throw new Error(`shotSlots[${index}].manualReplacement must be a boolean.`);
    }
    return {
      id: text(slot.id, `shotSlots[${index}].id`),
      beatId: text(slot.beatId, `shotSlots[${index}].beatId`),
      purpose: text(slot.purpose, `shotSlots[${index}].purpose`),
      durationSeconds: boundedNumber(slot.durationSeconds, `shotSlots[${index}].durationSeconds`, 0.25, 120),
      allowedCapabilities: uniqueStrings(slot.allowedCapabilities, `shotSlots[${index}].allowedCapabilities`),
      manualReplacement: slot.manualReplacement,
    };
  });
  requireUnique(slots.map((slot) => slot.id), "shotSlots ids");
  return slots;
}

function qualityRules(value: unknown): QualityRuleTemplate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("qualityRules must be a non-empty array.");
  const allowed = new Set(["factual", "copyright", "platform", "technical", "artistic"]);
  const rules = value.map((item, index) => {
    const rule = record(item, `qualityRules[${index}]`);
    const dimension = text(rule.dimension, `qualityRules[${index}].dimension`);
    if (!allowed.has(dimension)) throw new Error(`qualityRules[${index}].dimension is invalid.`);
    if (typeof rule.required !== "boolean") throw new Error(`qualityRules[${index}].required must be a boolean.`);
    return {
      id: text(rule.id, `qualityRules[${index}].id`),
      label: text(rule.label, `qualityRules[${index}].label`),
      dimension: dimension as QualityRuleTemplate["dimension"],
      required: rule.required,
      threshold: boundedNumber(rule.threshold, `qualityRules[${index}].threshold`, 0, 100),
    };
  });
  requireUnique(rules.map((rule) => rule.id), "qualityRules ids");
  return rules;
}

function capabilityRequirements(value: unknown): CapabilityRequirement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("capabilityRequirements must be a non-empty array.");
  }
  const requirements = value.map((item, index) => {
    const requirement = record(item, `capabilityRequirements[${index}]`);
    if (typeof requirement.required !== "boolean") {
      throw new Error(`capabilityRequirements[${index}].required must be a boolean.`);
    }
    return {
      capability: text(requirement.capability, `capabilityRequirements[${index}].capability`),
      required: requirement.required,
    };
  });
  requireUnique(requirements.map((item) => item.capability), "capabilityRequirements capabilities");
  return requirements;
}

function visualSystem(value: unknown): ProductionTemplateInput["visualSystem"] {
  const input = record(value, "visualSystem");
  const subtitleDensity = text(input.subtitleDensity, "visualSystem.subtitleDensity");
  const pacing = text(input.pacing, "visualSystem.pacing");
  if (!["low", "medium", "high"].includes(subtitleDensity)) throw new Error("visualSystem.subtitleDensity is invalid.");
  if (!["calm", "measured", "dynamic"].includes(pacing)) throw new Error("visualSystem.pacing is invalid.");
  return {
    composition: text(input.composition, "visualSystem.composition"),
    colorIntent: text(input.colorIntent, "visualSystem.colorIntent"),
    subtitleDensity: subtitleDensity as ProductionTemplateInput["visualSystem"]["subtitleDensity"],
    pacing: pacing as ProductionTemplateInput["visualSystem"]["pacing"],
  };
}

function soundSystem(value: unknown): ProductionTemplateInput["soundSystem"] {
  const input = record(value, "soundSystem");
  const pace = text(input.pace, "soundSystem.pace");
  if (!["slow", "medium", "fast"].includes(pace)) throw new Error("soundSystem.pace is invalid.");
  return {
    voiceIntent: text(input.voiceIntent, "soundSystem.voiceIntent"),
    pace: pace as ProductionTemplateInput["soundSystem"]["pace"],
    musicIntent: text(input.musicIntent, "soundSystem.musicIntent"),
  };
}

function costPolicy(value: unknown): ProductionTemplateInput["costPolicy"] {
  const input = record(value, "costPolicy");
  if (input.currency !== "CNY") throw new Error("costPolicy.currency must be 'CNY'.");
  return {
    currency: "CNY",
    maxCost: boundedNumber(input.maxCost, "costPolicy.maxCost", 0, 100_000),
    maxPaidShots: boundedInteger(input.maxPaidShots, "costPolicy.maxPaidShots", 0, 100),
  };
}

function validateReferences(template: ProductionTemplateInput): void {
  const beatIds = new Set(template.storyStructure.map((beat) => beat.id));
  for (const slot of template.shotSlots) {
    if (!beatIds.has(slot.beatId)) throw new Error(`shotSlots '${slot.id}' references unknown beatId '${slot.beatId}'.`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty string array.`);
  const values = value.map((item, index) => text(item, `${field}[${index}]`));
  requireUnique(values, field);
  return values;
}

function requireUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique.`);
}

function templateId(value: unknown): string {
  const id = text(value, "id");
  if (!TEMPLATE_ID.test(id)) throw new Error("id must be a lowercase kebab-case identifier.");
  return id;
}

function positiveInteger(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = boundedNumber(value, field, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${field} must be an integer.`);
  return number;
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function templateStatus(value: unknown): ProductionTemplateInput["status"] {
  if (value !== "draft" && value !== "published" && value !== "archived") throw new Error("status is invalid.");
  return value;
}

function automationLevel(value: unknown): ProductionTemplateInput["automationLevel"] {
  if (value !== "automatic" && value !== "assisted" && value !== "manual") throw new Error("automationLevel is invalid.");
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = text(value, field);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp.`);
  return timestamp;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
