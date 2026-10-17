import {
  type ProductionTemplateInput,
} from "@video-factory/template-core";
import type {
  StudioTemplate,
  StudioTemplateCatalog,
  StudioTemplateCloneInput,
  StudioTemplateCreateInput,
  StudioTemplateDeletion,
  StudioTemplateMutation,
} from "../shared/api.js";
import { JsonTemplateStore } from "./template-store.js";
import { StudioInputError } from "../shared/api.js";
import { BUILTIN_TEMPLATES } from "./template-catalog.js";

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
      productionTemplates: snapshot.publishedTemplates.map((template) => this.toDto(template)),
      deletedBuiltIns: snapshot.deletedBuiltIns.map((template) => this.toDto(template)),
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
    }, input.expectedRevision, input.catalogVisibility ?? "production");
    return { storeRevision: result.storeRevision, template: this.toDto(result.template) };
  }

  async revise(id: string, expectedRevision: number): Promise<StudioTemplateMutation> {
    const result = await this.store.revise(id, expectedRevision);
    return { storeRevision: result.storeRevision, template: this.toDto(result.template) };
  }

  async delete(id: string, expectedRevision: number): Promise<StudioTemplateDeletion> {
    const result = await this.store.delete(id, expectedRevision);
    const deletedBuiltIn = BUILTIN_TEMPLATES.find((template) => template.id === id);
    return {
      storeRevision: result.storeRevision,
      ...(deletedBuiltIn ? { deletedBuiltIn: this.toDto(deletedBuiltIn) } : {}),
    };
  }

  async restoreBuiltIn(id: string, expectedRevision: number): Promise<StudioTemplateMutation> {
    const result = await this.store.restoreBuiltIn(id, expectedRevision);
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

  private toDto(template: ProductionTemplateInput): StudioTemplate {
    return {
      ...structuredClone(template),
      builtIn: BUILTIN_TEMPLATES.some((candidate) => candidate.id === template.id),
    };
  }
}
