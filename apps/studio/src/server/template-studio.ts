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
  StudioTemplateCreateInput,
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

  async create(input: StudioTemplateCreateInput): Promise<StudioTemplateMutation> {
    const timestamp = this.now().toISOString();
    const result = await this.store.create({
      id: input.id,
      version: 1,
      status: "draft",
      name: input.name,
      description: input.description?.trim() || "描述这个模板适合制作什么内容，以及希望观众看完获得什么。",
      category: "custom",
      platforms: ["douyin"],
      durationSeconds: 30,
      automationLevel: "assisted",
      storyStructure: [
        { id: "hook", label: "开场钩子", purpose: "在前三秒建立问题、冲突或好奇心。", required: true },
        { id: "development", label: "内容展开", purpose: "用清晰证据与画面推进核心观点。", required: true },
        { id: "payoff", label: "价值收束", purpose: "给出可记住、可行动的结论。", required: true },
      ],
      shotSlots: [
        { id: "hook-shot", beatId: "hook", purpose: "建立第一视觉信号", durationSeconds: 4, allowedCapabilities: ["asset.search", "asset.generate"], manualReplacement: true },
        { id: "development-shot", beatId: "development", purpose: "承载事实与叙事推进", durationSeconds: 20, allowedCapabilities: ["asset.search", "asset.generate"], manualReplacement: true },
        { id: "payoff-shot", beatId: "payoff", purpose: "完成情绪或观点收束", durationSeconds: 6, allowedCapabilities: ["asset.search", "asset.generate"], manualReplacement: true },
      ],
      visualSystem: { composition: "主体明确，镜头之间保持视觉连续性。", colorIntent: "根据内容情绪建立主色与强调色。", subtitleDensity: "medium", pacing: "measured" },
      soundSystem: { voiceIntent: "自然、可信，像一个真正理解内容的人在表达。", pace: "medium", musicIntent: "辅助情绪与节奏，不压过旁白。" },
      qualityRules: [
        { id: "factual", label: "事实与表达准确", dimension: "factual", required: true, threshold: 80 },
        { id: "artistic", label: "视听表达完整", dimension: "artistic", required: true, threshold: 75 },
        { id: "technical", label: "成片技术规格合格", dimension: "technical", required: true, threshold: 90 },
      ],
      capabilityRequirements: [
        { capability: "script.draft", required: true },
        { capability: "storyboard.plan", required: true },
        { capability: "asset.prepare", required: true },
        { capability: "voice.synthesize", required: true },
        { capability: "video.render", required: true },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }, input.expectedRevision);
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
