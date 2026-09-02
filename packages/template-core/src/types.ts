export type TemplateStatus = "draft" | "published" | "archived";
export type AutomationLevel = "automatic" | "assisted" | "manual";
export type TemplateLayer = "system" | "platform" | "template" | "series" | "run" | "node";

export interface StoryBeatTemplate {
  id: string;
  label: string;
  purpose: string;
  required: boolean;
}

export interface ShotSlotTemplate {
  id: string;
  beatId: string;
  purpose: string;
  durationSeconds: number;
  allowedCapabilities: string[];
  manualReplacement: boolean;
}

export interface VisualSystemTemplate {
  composition: string;
  colorIntent: string;
  subtitleDensity: "low" | "medium" | "high";
  pacing: "calm" | "measured" | "dynamic";
}

export interface SoundSystemTemplate {
  voiceIntent: string;
  pace: "slow" | "medium" | "fast";
  musicIntent: string;
}

export interface QualityRuleTemplate {
  id: string;
  label: string;
  dimension: "factual" | "copyright" | "platform" | "technical" | "artistic";
  required: boolean;
  threshold: number;
}

export interface CapabilityRequirement {
  capability: string;
  required: boolean;
}

/**
 * 仅用于读取历史模板。费用控制已经移到每次真实报价后的人工授权，
 * 因此这个字段不会进入解析后的模板或生产蓝图。
 */
export interface TemplateCostPolicy {
  currency: "CNY";
  maxCost: number;
  maxPaidShots: number;
}

export interface ProductionTemplateInput {
  id: string;
  version: number;
  status: TemplateStatus;
  name: string;
  description: string;
  category: string;
  platforms: string[];
  durationSeconds: number;
  automationLevel: AutomationLevel;
  storyStructure: StoryBeatTemplate[];
  shotSlots: ShotSlotTemplate[];
  visualSystem: VisualSystemTemplate;
  soundSystem: SoundSystemTemplate;
  qualityRules: QualityRuleTemplate[];
  capabilityRequirements: CapabilityRequirement[];
  /** @deprecated 仅兼容旧模板输入；解析后会丢弃。 */
  costPolicy?: TemplateCostPolicy;
  modelDefaults?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type ProductionTemplate = Readonly<Omit<ProductionTemplateInput, "costPolicy">>;

export interface ProductionBlueprint {
  platform: string;
  durationSeconds: number;
  automationLevel: AutomationLevel;
  storyStructure: StoryBeatTemplate[];
  shotSlots: ShotSlotTemplate[];
  visualSystem: VisualSystemTemplate;
  soundSystem: SoundSystemTemplate;
  qualityRules: QualityRuleTemplate[];
  capabilityRequirements: CapabilityRequirement[];
}

export type ProductionBlueprintPatch = Partial<ProductionBlueprint>;

export interface TemplateLayerReceipt {
  layer: TemplateLayer;
  sourceId: string;
  appliedFields: string[];
}

export interface ProductionTemplateSnapshot {
  templateId: string;
  templateVersion: number;
  resolvedAt: string;
  resolvedBlueprint: ProductionBlueprint;
  modelDefaults?: Record<string, string>;
  sourceLayers: TemplateLayerReceipt[];
  fieldSources: Record<string, TemplateLayer>;
}

export interface ResolveTemplateSnapshotInput {
  template: ProductionTemplateInput;
  resolvedAt: string;
  systemDefaults: ProductionBlueprintPatch;
  platformProfile?: ProductionBlueprintPatch;
  seriesBible?: ProductionBlueprintPatch;
  runOverrides?: ProductionBlueprintPatch;
}
