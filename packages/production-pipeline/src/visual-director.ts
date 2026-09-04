import {
  PRODUCTION_DIRECTOR_PROFILE_IDS,
  type ProductionDirectorProfileId,
  type ProductionReworkFinding,
  type ProductionSeriesContext,
  type ProductionSpendFeedbackReason,
} from "./contracts.js";
import type { ProductionBlueprint } from "@video-factory/template-core";
import type { CodexTaskExecution } from "./codex-chat.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ShotGrammar } from "./reference-grammar.js";
import { assetReuseSourceScenePosition } from "./generative-asset-worker.js";

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
export type VisualAssetDeliveryType =
  | "editorial_card"
  | "stock_video"
  | "stock_image"
  | "generated_image"
  | "generated_video";

export interface VisualBible {
  viewerPromise?: string;
  narrativeApproach: string;
  motif?: string;
  pacing: string;
  composition: string;
  camera: string;
  color: string;
  continuity: string;
  transitionGrammar?: string;
  sound: string;
  antiPatterns?: string[];
}

export interface ShotDecision {
  scenePosition: number;
  narrativeRole: string;
  authenticityPolicy: ShotAuthenticityPolicy;
  preferredProviderId: string;
  deliveryType: VisualAssetDeliveryType;
  alternativeProviderIds: string[];
  subject?: string;
  environment?: string;
  visibleAction?: string;
  temporalBeats?: string[];
  shotSize?: string;
  camera?: string;
  lighting?: string;
  negativeConstraints?: string[];
  referenceRequirements?: string[];
  successCriteria?: string[];
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
  sceneDurations?: Record<number, number>;
  allowedProviderIds: string[];
  generativeProviderIds: string[];
  providerDeliveryTypes?: Record<string, VisualAssetDeliveryType[]>;
  estimatedCnyPerClip: Record<string, number>;
  economics: VisualDirectorEconomics;
}

export interface VisualDirectorEconomics {
  allowMeteredProviders: boolean;
}

export interface VisualDirectorAgentInput {
  brief: {
    title: string;
    angle: string;
    audience: string;
    platform: string;
    durationSeconds: number;
    requestedProfileId: ProductionDirectorProfileId;
    templateBlueprint?: ProductionBlueprint;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    referenceGrammar?: ShotGrammar;
    seriesContext?: ProductionSeriesContext;
    rework?: {
      sourceRunId: string;
      visualDirectionInstruction: string;
      assetInstruction: string;
      findings: ProductionReworkFinding[];
      previousDirectorPlan?: Record<string, unknown>;
    };
  };
  scenes: Array<{
    position: number;
    narration: string;
    duration: number;
    visualPrompt: string;
    visualStrategy: "stock" | "image" | "generated" | "local";
    visibleAction: string;
    onScreenText?: string;
    soundCue?: string;
    successCriteria: string[];
    failureConditions: string[];
    searchTerms: string[];
  }>;
  assetProviders: Array<{
    id: string;
    label: string;
    billing: "free" | "metered";
    modes: string[];
    deliveryTypes: VisualAssetDeliveryType[];
    strengths: string[];
    constraints: string[];
    estimatedCnyPerClip: number;
  }>;
  economics: VisualDirectorEconomics;
  selectedModelId?: string;
  costFeedback?: Array<{
    reason: ProductionSpendFeedbackReason;
    previousEstimatedCostCny: number;
    targetEstimatedCostCny?: number;
    note?: string;
  }>;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
}

export interface VisualAssetProviderCapability {
  id: string;
  label: string;
  billing: "free" | "metered";
  modes: string[];
  deliveryTypes: VisualAssetDeliveryType[];
  strengths?: string[];
  constraints?: string[];
  estimatedCnyPerClip?: number;
  generative?: boolean;
}

export interface VisualDirectorAgent {
  id: string;
  modelId?: string;
  plan(input: VisualDirectorAgentInput): Promise<unknown>;
  planDetailed?(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<unknown>>;
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
    ...(optionalText(visualBibleInput.viewerPromise, "visualBible.viewerPromise") !== undefined
      ? { viewerPromise: optionalText(visualBibleInput.viewerPromise, "visualBible.viewerPromise")! }
      : {}),
    narrativeApproach: text(visualBibleInput.narrativeApproach, "visualBible.narrativeApproach"),
    ...(optionalText(visualBibleInput.motif, "visualBible.motif") !== undefined
      ? { motif: optionalText(visualBibleInput.motif, "visualBible.motif")! }
      : {}),
    pacing: text(visualBibleInput.pacing, "visualBible.pacing"),
    composition: text(visualBibleInput.composition, "visualBible.composition"),
    camera: text(visualBibleInput.camera, "visualBible.camera"),
    color: text(visualBibleInput.color, "visualBible.color"),
    continuity: text(visualBibleInput.continuity, "visualBible.continuity"),
    ...(optionalText(visualBibleInput.transitionGrammar, "visualBible.transitionGrammar") !== undefined
      ? { transitionGrammar: optionalText(visualBibleInput.transitionGrammar, "visualBible.transitionGrammar")! }
      : {}),
    sound: text(visualBibleInput.sound, "visualBible.sound"),
    ...(optionalStringArray(visualBibleInput.antiPatterns, "visualBible.antiPatterns") !== undefined
      ? { antiPatterns: optionalStringArray(visualBibleInput.antiPatterns, "visualBible.antiPatterns")! }
      : {}),
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
    const deliveryType = assetDeliveryType(shot.deliveryType, `shots[${index}].deliveryType`);
    assertProviderDeliveryType(preferredProviderId, deliveryType, options, `shots[${index}].preferredProviderId`);
    const alternativeProviderIds = stringArray(shot.alternativeProviderIds, `shots[${index}].alternativeProviderIds`)
      .filter((id) => id !== preferredProviderId);
    for (const id of alternativeProviderIds) {
      providerId(id, allowed, `shots[${index}].alternativeProviderIds`);
      assertProviderDeliveryType(id, deliveryType, options, `shots[${index}].alternativeProviderIds`);
    }
    const authenticityPolicy = authenticity(shot.authenticityPolicy, `shots[${index}].authenticityPolicy`);
    if (authenticityPolicy === "evidence" && [preferredProviderId, ...alternativeProviderIds].some((id) => generative.has(id))) {
      throw new Error(`Director plan evidence shot ${scenePosition} cannot use a generative provider.`);
    }
    const beats = optionalStringArray(shot.temporalBeats, `shots[${index}].temporalBeats`);
    const sceneDuration = options.sceneDurations?.[scenePosition];
    if (sceneDuration !== undefined) {
      validateTemporalBeats(beats, sceneDuration, `shots[${index}].temporalBeats`);
    }
    const visibleAction = optionalText(shot.visibleAction, `shots[${index}].visibleAction`);
    const generationPrompt = text(shot.generationPrompt, `shots[${index}].generationPrompt`);
    const successCriteria = optionalStringArray(shot.successCriteria, `shots[${index}].successCriteria`);
    if (deliveryType === "editorial_card") {
      assertStaticEditorialCard(
        [visibleAction, ...(beats ?? []), generationPrompt, ...(successCriteria ?? [])],
        `shots[${index}]`,
      );
    }
    const rationale = text(shot.rationale, `shots[${index}].rationale`);
    assertSelectedProviderIsExecutable(rationale, `shots[${index}].rationale`);
    const query = text(shot.query, `shots[${index}].query`);
    return {
      scenePosition,
      narrativeRole: text(shot.narrativeRole, `shots[${index}].narrativeRole`),
      authenticityPolicy,
      preferredProviderId,
      deliveryType,
      alternativeProviderIds: [...new Set(alternativeProviderIds)],
      ...(optionalText(shot.subject, `shots[${index}].subject`) !== undefined
        ? { subject: optionalText(shot.subject, `shots[${index}].subject`)! }
        : {}),
      ...(optionalText(shot.environment, `shots[${index}].environment`) !== undefined
        ? { environment: optionalText(shot.environment, `shots[${index}].environment`)! }
        : {}),
      ...(visibleAction !== undefined
        ? { visibleAction }
        : {}),
      ...(beats !== undefined
        ? { temporalBeats: beats }
        : {}),
      ...(optionalText(shot.shotSize, `shots[${index}].shotSize`) !== undefined
        ? { shotSize: optionalText(shot.shotSize, `shots[${index}].shotSize`)! }
        : {}),
      ...(optionalText(shot.camera, `shots[${index}].camera`) !== undefined
        ? { camera: optionalText(shot.camera, `shots[${index}].camera`)! }
        : {}),
      ...(optionalText(shot.lighting, `shots[${index}].lighting`) !== undefined
        ? { lighting: optionalText(shot.lighting, `shots[${index}].lighting`)! }
        : {}),
      ...(optionalStringArray(shot.negativeConstraints, `shots[${index}].negativeConstraints`) !== undefined
        ? { negativeConstraints: optionalStringArray(shot.negativeConstraints, `shots[${index}].negativeConstraints`)! }
        : {}),
      ...(optionalStringArray(shot.referenceRequirements, `shots[${index}].referenceRequirements`, true) !== undefined
        ? { referenceRequirements: optionalStringArray(shot.referenceRequirements, `shots[${index}].referenceRequirements`, true)! }
        : {}),
      ...(successCriteria !== undefined
        ? { successCriteria }
        : {}),
      query,
      generationPrompt,
      rationale,
      continuityNote: text(shot.continuityNote, `shots[${index}].continuityNote`),
      confidence: bounded(shot.confidence, `shots[${index}].confidence`, 0, 1),
      estimatedCostCny: assetReuseSourceScenePosition({ query }) === undefined
        ? serverCost(preferredProviderId, options.estimatedCnyPerClip)
        : 0,
    };
  }).sort((left, right) => left.scenePosition - right.scenePosition);

  if (shots.length !== expectedPositions.length || shots.some((shot, index) => shot.scenePosition !== expectedPositions[index])) {
    throw new Error("Director plan must cover every script scene exactly once.");
  }

  const paidShots = shots.filter((shot) => shot.estimatedCostCny > 0);
  if (paidShots.length > 0 && !options.economics.allowMeteredProviders) {
    throw new Error("Director plan selected a metered provider while paid providers are disabled.");
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

function assetDeliveryType(value: unknown, field: string): VisualAssetDeliveryType {
  if (
    value !== "editorial_card"
    && value !== "stock_video"
    && value !== "stock_image"
    && value !== "generated_image"
    && value !== "generated_video"
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function assertProviderDeliveryType(
  provider: string,
  deliveryType: VisualAssetDeliveryType,
  options: VisualDirectorPlanValidation,
  field: string,
): void {
  const supported = options.providerDeliveryTypes?.[provider];
  if (supported && !supported.includes(deliveryType)) {
    throw new Error(`${field} '${provider}' cannot deliver '${deliveryType}'.`);
  }
}

const EDITORIAL_ELEMENT_ANIMATION_PATTERNS: RegExp[] = [
  /(逐字|逐项|逐行|单字|每项).{0,16}(出现|显现|渐显|淡入|弹出|勾选|高亮|动画|切换)/,
  /(高亮(?:带)?|边框|状态栏|圆点|对勾|文字|标题|数字|图形|箭头).{0,18}(扫过|横扫|变色|变红|变绿|切换|渐显|淡入|弹出|展开|移动|旋转|跳动|闪烁)/,
  /(灰色|透明|黑色|红色|绿色).{0,12}(变为|切换为|渐变为)/,
  /(同步变为|由透明渐显|元素动画|物件动画)/,
];

function assertStaticEditorialCard(values: Array<string | undefined>, field: string): void {
  const animation = values.find((value) => value && EDITORIAL_ELEMENT_ANIMATION_PATTERNS.some((pattern) => pattern.test(value)));
  if (animation) {
    throw new Error(`${field} uses editorial_card but requests unsupported element animation: ${animation}`);
  }
}

function assertSelectedProviderIsExecutable(rationale: string, field: string): void {
  if (/(当前|所选|该)?\s*Provider.{0,24}(缺少|不支持|无法|不能).{0,20}(能力|动画|生产|交付)|需补充.{0,24}Provider|尚不能生产/.test(rationale)) {
    throw new Error(`${field} admits that the selected provider cannot execute this shot.`);
  }
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

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function optionalStringArray(value: unknown, field: string, allowEmpty = false): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 10) {
    throw new Error(`${field} must be an array of ${allowEmpty ? "0" : "1"} to 10 strings.`);
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function validateTemporalBeats(beats: string[] | undefined, duration: number, field: string): void {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${field} scene duration is invalid.`);
  if (!beats || beats.length < 2) throw new Error(`${field} must contain at least two timed beats.`);
  let previousEnd = 0;
  beats.forEach((beat, index) => {
    const match = /^\[\s*(\d+(?:\.\d+)?)s\s*-\s*(\d+(?:\.\d+)?)s\s*\]\s*\S[\s\S]*$/i.exec(beat);
    if (!match) throw new Error(`${field}[${index}] must use the format [0s-2s] description.`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end <= start) throw new Error(`${field}[${index}] must end after it starts.`);
    if (start < previousEnd) throw new Error(`${field}[${index}] overlaps or is out of order.`);
    if (end > duration) throw new Error(`${field}[${index}] exceeds the ${duration}s scene duration.`);
    previousEnd = end;
  });
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
