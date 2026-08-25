import {
  PRODUCTION_DIRECTOR_PROFILE_IDS,
  type ProductionDirectorProfileId,
  type ProductionEconomics,
} from "./contracts.js";

export const DIRECTOR_PLAN_VERSION = "video-factory/director-plan-v1" as const;

export interface VisualDirectorProfileDefinition {
  id: Exclude<ProductionDirectorProfileId, "auto">;
  narrative: string;
  pacing: string;
  composition: string;
  camera: string;
  color: string;
  sound: string;
  bestFor: string[];
  avoid: string;
}

export const VISUAL_DIRECTOR_PROFILES: readonly VisualDirectorProfileDefinition[] = [
  {
    id: "documentary-observer",
    narrative: "从真实地点、人物行动和可核验证据出发，不用虚构画面替代事实。",
    pacing: "克制推进，给动作和环境留下观察时间。",
    composition: "环境中景与具体细节交替，人物始终处在真实空间中。",
    camera: "自然光、轻微手持、有限运动，保留现场感。",
    color: "接近现场的自然色，不做过度情绪化调色。",
    sound: "优先环境声和真实动作声，音乐只做轻度支撑。",
    bestFor: ["热点解释", "地方文化", "人物观察", "社会议题"],
    avoid: "摆拍式表演、与事实无关的漂亮空镜、AI 生成的证据镜头。",
  },
  {
    id: "quiet-humanism",
    narrative: "从日常动作与人物关系中发现情绪，以留白代替直接煽情。",
    pacing: "平稳、耐心，重要动作前后保留停顿。",
    composition: "固定机位、平视视角、门框和室内层次组织生活空间。",
    camera: "少运动，必要运动也保持缓慢和低存在感。",
    color: "自然光与温和中性色，避免高饱和冲击。",
    sound: "生活环境声、呼吸和细小动作优先。",
    bestFor: ["生活方式", "家庭", "情绪", "慢叙事"],
    avoid: "密集转场、夸张推拉、替人物下结论的煽情配乐。",
  },
  {
    id: "urban-poetic",
    narrative: "用城市碎片、人物感受与时间错位建立情绪，而非按事件流水账讲述。",
    pacing: "短促片段与突然停顿交替，形成记忆感。",
    composition: "偏置构图、前景遮挡、反射和局部近景。",
    camera: "手持跟随、缓慢横移或受控拖影，运动服务人物感受。",
    color: "夜色、综合色温与局部高饱和光源。",
    sound: "城市底噪、近距离呼吸与节奏性音乐形成层次。",
    bestFor: ["都市情绪", "音乐", "时尚", "关系"],
    avoid: "只套霓虹滤镜、无人物动机的空镜堆砌、难以辨认的过度拖影。",
  },
  {
    id: "chromatic-storytelling",
    narrative: "让色彩、空间和群体调度承担叙事信息，关键物件形成视觉母题。",
    pacing: "宽景建立秩序，特写给出冲击，再回到空间关系。",
    composition: "大色块、群体几何、宽景与极近特写对照。",
    camera: "稳定移动或明确的轴线变化，突出空间调度。",
    color: "选择一个主色和一个对照色，保持全片色彩逻辑。",
    sound: "节奏鲜明的动作声与具有仪式感的音乐。",
    bestFor: ["文化", "美食", "节庆", "视觉奇观"],
    avoid: "无叙事理由的多色混杂、每镜不同色调、只靠滤镜制造高级感。",
  },
  {
    id: "geometric-control",
    narrative: "以秩序、重复和微小失衡解释系统或产品，让变化本身成为信息。",
    pacing: "精确、均匀，在关键反差处突然打破节奏。",
    composition: "中心构图、对称、单点透视和明确的图形层级。",
    camera: "稳定推进、平移或完全固定，镜头运动可预测。",
    color: "限制色板，强调材质、线条和明暗秩序。",
    sound: "机械节拍、界面声和克制旁白。",
    bestFor: ["科技", "产品", "建筑", "理性解释"],
    avoid: "随意手持、无目的跳切、装饰性科技蓝。",
  },
  {
    id: "suspense-staging",
    narrative: "通过视点限制、物件线索和信息差制造问题，再用镜头顺序完成揭示。",
    pacing: "建立预期、延迟答案、快速揭示。",
    composition: "主观视角、关键物件特写、视线匹配和反应镜头。",
    camera: "受控推进、窥视角度与明确的视线运动。",
    color: "高可读性的明暗对比，线索物件保持视觉一致。",
    sound: "提示声、停顿和突然静音参与信息控制。",
    bestFor: ["悬疑解释", "避坑", "反转", "故事"],
    avoid: "靠惊吓音效代替铺垫、故意隐瞒必要事实、与内容无关的悬念标题。",
  },
] as const;

export type ShotAuthenticityPolicy = "evidence" | "illustrative" | "expressive";

export interface VisualBible {
  narrativeApproach: string;
  pacing: string;
  composition: string;
  camera: string;
  color: string;
  continuity: string;
  sound: string;
}

export interface ShotDecision {
  scenePosition: number;
  narrativeRole: string;
  authenticityPolicy: ShotAuthenticityPolicy;
  preferredProviderId: string;
  alternativeProviderIds: string[];
  query: string;
  generationPrompt: string;
  rationale: string;
  continuityNote: string;
  confidence: number;
  estimatedCostCny: number;
}

export interface VisualDirectorPlan {
  version: typeof DIRECTOR_PLAN_VERSION;
  requestedProfileId: ProductionDirectorProfileId;
  resolvedProfileId: Exclude<ProductionDirectorProfileId, "auto">;
  profileRationale: string;
  visualBible: VisualBible;
  shots: ShotDecision[];
}

export interface VisualDirectorPlanValidation {
  scenePositions: number[];
  allowedProviderIds: string[];
  generativeProviderIds: string[];
  estimatedCnyPerClip: Record<string, number>;
  economics: ProductionEconomics;
}

export interface VisualDirectorAgentInput {
  brief: {
    title: string;
    angle: string;
    audience: string;
    platform: string;
    durationSeconds: number;
    requestedProfileId: ProductionDirectorProfileId;
  };
  scenes: Array<{
    position: number;
    narration: string;
    duration: number;
    visualPrompt: string;
  }>;
  assetProviders: Array<{
    id: string;
    label: string;
    billing: "free" | "metered";
    modes: string[];
    strengths: string[];
    constraints: string[];
    estimatedCnyPerClip: number;
  }>;
  economics: ProductionEconomics;
}

export interface VisualAssetProviderCapability {
  id: string;
  label: string;
  billing: "free" | "metered";
  modes: string[];
  strengths?: string[];
  constraints?: string[];
  estimatedCnyPerClip?: number;
  generative?: boolean;
}

export interface VisualDirectorAgent {
  id: string;
  plan(input: VisualDirectorAgentInput): Promise<unknown>;
}

export function validateVisualDirectorPlan(value: unknown, options: VisualDirectorPlanValidation): VisualDirectorPlan {
  const input = record(value, "Director plan");
  if (input.version !== DIRECTOR_PLAN_VERSION) {
    throw new Error(`Director plan version must be '${DIRECTOR_PLAN_VERSION}'.`);
  }
  const requestedProfileId = profileId(input.requestedProfileId, "requestedProfileId", true);
  const resolvedProfileId = profileId(input.resolvedProfileId, "resolvedProfileId", false) as Exclude<ProductionDirectorProfileId, "auto">;
  const visualBibleInput = record(input.visualBible, "visualBible");
  const visualBible: VisualBible = {
    narrativeApproach: text(visualBibleInput.narrativeApproach, "visualBible.narrativeApproach"),
    pacing: text(visualBibleInput.pacing, "visualBible.pacing"),
    composition: text(visualBibleInput.composition, "visualBible.composition"),
    camera: text(visualBibleInput.camera, "visualBible.camera"),
    color: text(visualBibleInput.color, "visualBible.color"),
    continuity: text(visualBibleInput.continuity, "visualBible.continuity"),
    sound: text(visualBibleInput.sound, "visualBible.sound"),
  };
  if (!Array.isArray(input.shots)) throw new Error("Director plan shots must be an array.");

  const allowed = new Set(options.allowedProviderIds);
  const generative = new Set(options.generativeProviderIds);
  const expectedPositions = [...options.scenePositions].sort((left, right) => left - right);
  const seen = new Set<number>();
  const shots = input.shots.map((entry, index): ShotDecision => {
    const shot = record(entry, `shots[${index}]`);
    const scenePosition = integer(shot.scenePosition, `shots[${index}].scenePosition`);
    if (seen.has(scenePosition)) throw new Error(`Director plan contains duplicate scene ${scenePosition}.`);
    seen.add(scenePosition);
    const preferredProviderId = providerId(shot.preferredProviderId, allowed, `shots[${index}].preferredProviderId`);
    const alternativeProviderIds = stringArray(shot.alternativeProviderIds, `shots[${index}].alternativeProviderIds`)
      .filter((id) => id !== preferredProviderId);
    for (const id of alternativeProviderIds) providerId(id, allowed, `shots[${index}].alternativeProviderIds`);
    const authenticityPolicy = authenticity(shot.authenticityPolicy, `shots[${index}].authenticityPolicy`);
    if (authenticityPolicy === "evidence" && [preferredProviderId, ...alternativeProviderIds].some((id) => generative.has(id))) {
      throw new Error(`Director plan evidence shot ${scenePosition} cannot use a generative provider.`);
    }
    return {
      scenePosition,
      narrativeRole: text(shot.narrativeRole, `shots[${index}].narrativeRole`),
      authenticityPolicy,
      preferredProviderId,
      alternativeProviderIds: [...new Set(alternativeProviderIds)],
      query: text(shot.query, `shots[${index}].query`),
      generationPrompt: text(shot.generationPrompt, `shots[${index}].generationPrompt`),
      rationale: text(shot.rationale, `shots[${index}].rationale`),
      continuityNote: text(shot.continuityNote, `shots[${index}].continuityNote`),
      confidence: bounded(shot.confidence, `shots[${index}].confidence`, 0, 1),
      estimatedCostCny: serverCost(preferredProviderId, options.estimatedCnyPerClip),
    };
  }).sort((left, right) => left.scenePosition - right.scenePosition);

  if (shots.length !== expectedPositions.length || shots.some((shot, index) => shot.scenePosition !== expectedPositions[index])) {
    throw new Error("Director plan must cover every script scene exactly once.");
  }

  const paidShots = shots.filter((shot) => shot.estimatedCostCny > 0);
  const totalCost = roundMoney(paidShots.reduce((sum, shot) => sum + shot.estimatedCostCny, 0));
  if (paidShots.length > 0 && !options.economics.allowMeteredProviders) {
    throw new Error("Director plan selected a metered provider while paid providers are disabled.");
  }
  if (paidShots.length > options.economics.maxPaidShots) {
    throw new Error(`Director plan exceeds the paid-shot limit of ${options.economics.maxPaidShots}.`);
  }
  if (totalCost > options.economics.maxCostCny) {
    throw new Error(`Director plan estimated cost ¥${totalCost} exceeds budget ¥${options.economics.maxCostCny}.`);
  }

  return {
    version: DIRECTOR_PLAN_VERSION,
    requestedProfileId,
    resolvedProfileId,
    profileRationale: text(input.profileRationale, "profileRationale"),
    visualBible,
    shots,
  };
}

function profileId(value: unknown, field: string, allowAuto: boolean): ProductionDirectorProfileId {
  const id = text(value, field);
  if (!(PRODUCTION_DIRECTOR_PROFILE_IDS as readonly string[]).includes(id) || (!allowAuto && id === "auto")) {
    throw new Error(`${field} is not a supported director profile.`);
  }
  return id as ProductionDirectorProfileId;
}

function providerId(value: unknown, allowed: Set<string>, field: string): string {
  const id = text(value, field);
  if (!allowed.has(id)) throw new Error(`${field} '${id}' is not in the enabled asset pool.`);
  return id;
}

function serverCost(providerId: string, costs: Record<string, number>): number {
  const value = costs[providerId] ?? 0;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Server cost for '${providerId}' is invalid.`);
  return roundMoney(value);
}

function authenticity(value: unknown, field: string): ShotAuthenticityPolicy {
  if (value !== "evidence" && value !== "illustrative" && value !== "expressive") {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer.`);
  return Number(value);
}

function bounded(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
