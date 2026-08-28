import {
  resolveTemplateSnapshot,
  type ProductionBlueprintPatch,
  type ProductionTemplateInput,
  type ProductionTemplateSnapshot,
} from "@video-factory/template-core";
import type {
  StudioProductionInput,
  StudioTemplate,
  StudioTemplateCatalog,
  StudioTemplateCloneInput,
  StudioTemplateMutation,
} from "../shared/api.js";
import { JsonTemplateStore } from "./template-store.js";
import { StudioInputError } from "../shared/api.js";

export class TemplateStudio {
  constructor(
    private readonly store: JsonTemplateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<StudioTemplateCatalog> {
    const snapshot = await this.store.list();
    return {
      storeRevision: snapshot.storeRevision,
      templates: snapshot.templates.map((template) => this.toDto(template)),
    };
  }

  async get(id: string, version?: number): Promise<StudioTemplate | undefined> {
    const template = await this.store.get(id, version);
    return template ? this.toDto(template) : undefined;
  }

  async clone(input: StudioTemplateCloneInput): Promise<StudioTemplateMutation> {
    const result = await this.store.clone(input.sourceId, input.newId, input.name, input.expectedRevision);
    return { storeRevision: result.storeRevision, template: this.toDto(result.template) };
  }

  async saveDraft(input: ProductionTemplateInput, expectedRevision: number): Promise<StudioTemplateMutation> {
    const result = await this.store.saveDraft(input, expectedRevision);
    return { storeRevision: result.storeRevision, template: this.toDto(result.template) };
  }

  async publish(id: string, expectedRevision: number): Promise<StudioTemplateMutation> {
    const result = await this.store.publish(id, expectedRevision);
    return { storeRevision: result.storeRevision, template: this.toDto(result.template) };
  }

  async resolveForRun(input: TemplateRunInput): Promise<ProductionTemplateSnapshot> {
    const selection = parseTemplateSelection(input.template);
    const template = await this.store.getPublished(selection.templateId, selection.templateVersion);
    if (!template) {
      const versionLabel = selection.templateVersion === undefined ? "最新发布版本" : `版本 ${selection.templateVersion}`;
      throw new StudioInputError(`没有找到模板“${selection.templateId}”的${versionLabel}。`);
    }
    const runOverrides: ProductionBlueprintPatch = {
      platform: input.platform,
      durationSeconds: selection.runOverrides?.durationSeconds ?? input.durationSeconds,
      ...(selection.runOverrides?.automationLevel ? { automationLevel: selection.runOverrides.automationLevel } : {}),
      costPolicy: {
        currency: "CNY",
        maxCost: input.economics.maxCostCny,
        maxPaidShots: input.economics.maxPaidShots,
      },
    };
    return resolveTemplateSnapshot({
      template,
      resolvedAt: this.now().toISOString(),
      systemDefaults: { platform: input.platform, durationSeconds: input.durationSeconds, automationLevel: "assisted" },
      platformProfile: platformProfile(input.platform),
      runOverrides,
    });
  }

  private toDto(template: ProductionTemplateInput): StudioTemplate {
    return { ...structuredClone(template), builtIn: template.status === "published" && template.version === 1 && BUILTIN_IDS.has(template.id) };
  }
}

interface TemplateRunInput {
  template?: unknown;
  platform: string;
  durationSeconds: number;
  economics: Pick<StudioProductionInput["economics"], "maxCostCny" | "maxPaidShots">;
}

function parseTemplateSelection(value: unknown): NonNullable<StudioProductionInput["template"]> {
  if (value === undefined) return { templateId: "knowledge-explainer" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StudioInputError("模板选择格式不正确。");
  const input = value as Record<string, unknown>;
  if (typeof input.templateId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.templateId)) {
    throw new StudioInputError("模板编号格式不正确。");
  }
  if (input.templateVersion !== undefined && (!Number.isSafeInteger(input.templateVersion) || Number(input.templateVersion) < 1)) {
    throw new StudioInputError("模板版本必须是正整数。");
  }
  let runOverrides: NonNullable<StudioProductionInput["template"]>["runOverrides"];
  if (input.runOverrides !== undefined) {
    if (typeof input.runOverrides !== "object" || input.runOverrides === null || Array.isArray(input.runOverrides)) {
      throw new StudioInputError("模板运行参数格式不正确。");
    }
    const overrides = input.runOverrides as Record<string, unknown>;
    if (overrides.durationSeconds !== undefined
      && (!Number.isSafeInteger(overrides.durationSeconds) || Number(overrides.durationSeconds) < 20 || Number(overrides.durationSeconds) > 180)) {
      throw new StudioInputError("模板成片时长必须是 20 到 180 秒之间的整数。");
    }
    if (overrides.automationLevel !== undefined && !["automatic", "assisted", "manual"].includes(String(overrides.automationLevel))) {
      throw new StudioInputError("模板自动化级别无效。");
    }
    runOverrides = {
      ...(overrides.durationSeconds !== undefined ? { durationSeconds: Number(overrides.durationSeconds) } : {}),
      ...(overrides.automationLevel !== undefined ? { automationLevel: overrides.automationLevel as "automatic" | "assisted" | "manual" } : {}),
    };
  }
  return {
    templateId: input.templateId,
    ...(input.templateVersion !== undefined ? { templateVersion: Number(input.templateVersion) } : {}),
    ...(runOverrides ? { runOverrides } : {}),
  };
}

const BUILTIN_IDS = new Set([
  "trend-fact-brief",
  "knowledge-explainer",
  "photo-story",
  "product-demo",
  "human-mini-doc",
  "ranked-comparison",
]);

function platformProfile(platform: string): ProductionBlueprintPatch {
  if (platform === "bilibili") return { platform, durationSeconds: 60 };
  if (platform === "xiaohongshu") return { platform, durationSeconds: 45 };
  return { platform, durationSeconds: 30 };
}
