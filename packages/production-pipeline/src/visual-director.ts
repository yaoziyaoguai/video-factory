import {
  type ProductionArticleSourceSnapshot,
  type ProductionRecipeId,
  type ProductionReworkFinding,
  type ProductionSeriesContext,
  type ProductionSpendFeedbackReason,
} from "./contracts.js";
import { PlanContractError, quantizeDurationsToFrames, type DurationIntent } from "./executable-timeline.js";
import type { CodexTaskExecution } from "./codex-chat.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ShotGrammar } from "./reference-grammar.js";
import type { VideoAspectRatio } from "./video-generation.js";
import type { CreativeTreatment } from "./creative-treatment.js";
import type { CharacterDialogueTurn, ScriptCharacter, PresentationMode } from "./character-script.js";
import type { PlanningIssue } from "./creative-planning.js";
import type { ProductionCapabilities } from "./production-capabilities.js";
import type { CreativeDiscussionAgentInput } from "./codex-creative-discussion.js";
import type { CreativeDiscussionResult, CreativeDraftConflict } from "./creative-review.js";
import {
  assetReuseSourceScenePosition,
  normalizeVideoGenerationDurationSeconds,
  type VideoGenerationDurationBounds,
} from "./generative-asset-worker.js";

export const DIRECTOR_PLAN_VERSION = "video-factory/director-plan-v1" as const;
export const CHARACTER_DIRECTOR_PLAN_VERSION = "video-factory/director-plan-v2" as const;

export type ShotAuthenticityPolicy = "evidence" | "illustrative" | "expressive";
export type VisualAssetDeliveryType =
  | "editorial_card"
  | "stock_video"
  | "stock_image"
  | "generated_image"
  | "generated_video";

export interface VisualBible {
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
  reuseFromScenePosition?: number;
  referenceFromScenePosition?: number;
  narrativeRole: string;
  authenticityPolicy: ShotAuthenticityPolicy;
  preferredProviderId: string;
  deliveryType: VisualAssetDeliveryType;
  alternativeProviderIds: string[];
  subject?: string;
  environment?: string;
  visibleAction?: string;
  temporalBeats?: ShotTemporalBeat[];
  sourceInSeconds?: number;
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

export interface ShotTemporalBeat {
  startSeconds: number;
  endSeconds: number;
  action: string;
}

export function reuseSourceEndFrame(
  scenePosition: number,
  sourceInSeconds: number,
  sceneDurations: Readonly<Record<number, number>>,
): number | undefined {
  const orderedPositions = Object.keys(sceneDurations)
    .map(Number)
    .sort((left, right) => left - right);
  const sceneIndex = orderedPositions.indexOf(scenePosition);
  if (sceneIndex < 0) return undefined;
  const frameCounts = quantizeDurationsToFrames(
    orderedPositions.map((position) => sceneDurations[position]!),
  );
  return Math.round(sourceInSeconds * 30) + frameCounts[sceneIndex]!;
}

export interface NarrationVisualDirectorPlan {
  version: typeof DIRECTOR_PLAN_VERSION;
  visualBible: VisualBible;
  shots: ShotDecision[];
}

export interface CharacterSceneBinding {
  characterIds: string[];
  speakingTurnIds: string[];
}
export interface CharacterVisualDirectorPlan extends Omit<NarrationVisualDirectorPlan, "version" | "shots"> {
  version: typeof CHARACTER_DIRECTOR_PLAN_VERSION;
  shots: Array<ShotDecision & CharacterSceneBinding>;
}
export type VisualDirectorPlan = NarrationVisualDirectorPlan | CharacterVisualDirectorPlan;

export interface VisualDirectorPlanValidation {
  presentationMode?: "narration" | "character_drama";
  characterSceneBindings?: Record<number, CharacterSceneBinding>;
  scenePositions: number[];
  sceneDurations?: Record<number, number>;
  sceneVisualStrategies?: Record<number, "stock" | "image" | "generated" | "local">;
  allowedProviderIds: string[];
  generativeProviderIds: string[];
  providerDeliveryTypes?: Record<string, VisualAssetDeliveryType[]>;
  referenceImageProviderIds?: string[];
  estimatedCnyPerClip: Record<string, number>;
  selectedVideoModelDurationBounds?: Record<string, VideoGenerationDurationBounds>;
  selectedVideoModelAspectRatios?: Record<string, VideoAspectRatio[]>;
  requiredAspectRatio?: VideoAspectRatio;
  economics: VisualDirectorEconomics;
}

export interface VisualDirectorEconomics {
  recipeId?: ProductionRecipeId;
  allowMeteredProviders: boolean;
}

interface DirectorSceneVisual {
  position: number;
  purpose?: string;
  duration: number;
  visualPrompt: string;
  visualStrategy: "stock" | "image" | "generated" | "local";
  visibleAction: string;
  onScreenText?: string;
  soundCue?: string;
  successCriteria: string[];
  failureConditions: string[];
  searchTerms: string[];
}
export type VisualDirectorScene = DirectorSceneVisual & (
  { narration: string } | { characterIds: string[]; dialogue: CharacterDialogueTurn[] }
);

export function directorCharacterBindings(scenes: VisualDirectorScene[]): Record<number, CharacterSceneBinding> {
  return Object.fromEntries(scenes.map((scene) => {
    if (!("dialogue" in scene)) throw new Error("角色导演输入必须保留 dialogue，不能使用单旁白投影。");
    return [scene.position, { characterIds: [...scene.characterIds], speakingTurnIds: scene.dialogue.map((turn) => turn.id) }];
  }));
}

export interface VisualDirectorAgentInput {
  brief: DurationIntent & {
    presentationMode?: PresentationMode;
    characters?: ScriptCharacter[];
    title: string;
    angle: string;
    audience: string;
    platform: string;
    budgetIntentionCny?: number;
    editorial?: {
      verdict: "produce_video" | "produce_image_story";
      reasons: string[];
      guardrails: string[];
    };
    visualProof?: string;
    visualIntent?: string;
    referenceGrammar?: ShotGrammar;
    seriesContext?: ProductionSeriesContext;
    articleSources?: ProductionArticleSourceSnapshot[];
    creativeTreatment?: CreativeTreatment;
    planningIssues?: PlanningIssue[];
    planningRevision?: {
      previousPlan: VisualDirectorPlan;
      previousPlanDigest: string;
      affectedScenePositions: number[];
      availabilityHistory: Array<{
        identityDigest: string;
        reasonCode?: string;
        scenePositions?: number[];
        beatIds?: string[];
        evidence: NonNullable<PlanningIssue["availabilityBlocker"]>["evidence"];
      }>;
    };
    productionCapabilities?: ProductionCapabilities;
    voiceTiming?: {
      rate: number;
      pauseScale: number;
    };
    rework?: {
      sourceRunId: string;
      visualDirectionInstruction: string;
      assetInstruction: string;
      findings: ProductionReworkFinding[];
      affectedScenePositions?: number[];
      previousDirectorPlan?: Record<string, unknown>;
    };
  };
  scenes: VisualDirectorScene[];
  assetProviders: Array<{
    id: string;
    label: string;
    billing: "free" | "metered";
    modes: string[];
    deliveryTypes: VisualAssetDeliveryType[];
    supportsReferenceImage?: boolean;
    strengths: string[];
    constraints: string[];
    estimatedCnyPerClip: number;
    selectedModelId?: string;
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    aspectRatios?: VideoAspectRatio[];
  }>;
  economics: VisualDirectorEconomics;
  selectedModelId?: string;
  /** 正式 joint creative-planning 开启机器可读的非局部审计处置。 */
  planningMode?: boolean;
  costFeedback?: Array<{
    reason: ProductionSpendFeedbackReason;
    previousEstimatedCostCny: number;
    targetEstimatedCostCny?: number;
    note?: string;
  }>;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  wallClockDeadlineAtMs?: number;
  /** R11 创作确认：初稿只生成；确认时只审传入的当前稿。 */
  /** OA-01：check 携带持久化的审计操作身份（进装配层 checkpoint key，恢复/新操作可区分）。 */
  creativeReviewExecution?: { mode: "draft" } | { mode: "check"; candidate: VisualDirectorPlan; auditOperationId: string };
}

export interface VisualAssetProviderCapability {
  id: string;
  label: string;
  billing: "free" | "metered";
  modes: string[];
  deliveryTypes: VisualAssetDeliveryType[];
  supportsReferenceImage?: boolean;
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
  discussDetailed?(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>>;
}

export function validateVisualDirectorPlan(value: unknown, options: VisualDirectorPlanValidation): VisualDirectorPlan {
  return validateDirectorDocument(value, options, false);
}

/** 规划草稿保留完整的能力冲突；采用和执行仍使用严格校验，不把冲突当坏JSON重生成。 */
export function validateVisualDirectorDraft(value: unknown, options: VisualDirectorPlanValidation): VisualDirectorPlan {
  return validateDirectorDocument(value, options, true);
}

function validateDirectorDocument(value: unknown, options: VisualDirectorPlanValidation, draftOnly: boolean): VisualDirectorPlan {
  const input = record(value, "Director plan");
  const expectedVersion = options.presentationMode === "character_drama" ? CHARACTER_DIRECTOR_PLAN_VERSION : DIRECTOR_PLAN_VERSION;
  if (input.version !== expectedVersion) {
    throw new Error(`Director plan version must be '${expectedVersion}'.`);
  }
  const visualBibleInput = record(input.visualBible, "visualBible");
  const visualBible: VisualBible = {
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
    if (expectedVersion === DIRECTOR_PLAN_VERSION && ("characterIds" in shot || "speakingTurnIds" in shot)) {
      throw new Error("Director plan v1 cannot contain character bindings.");
    }
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
    if (deliveryType === "generated_video" && options.requiredAspectRatio) {
      const unsupportedProvider = [preferredProviderId, ...alternativeProviderIds].find((id) => {
        const ratios = options.selectedVideoModelAspectRatios?.[id];
        return ratios !== undefined && !ratios.includes(options.requiredAspectRatio!);
      });
      if (unsupportedProvider) {
        throw new Error(
          `Director plan provider '${unsupportedProvider}' does not support the required ${options.requiredAspectRatio} aspect ratio.`,
        );
      }
    }
    const generatedDelivery = deliveryType === "generated_image" || deliveryType === "generated_video";
    if (options.economics.recipeId === "free-stock"
      && (generatedDelivery || [preferredProviderId, ...alternativeProviderIds].some(id => generative.has(id)))) {
      throw new Error(`免费画面模式不能使用生图或生视频：第 ${scenePosition} 镜。`);
    }
    if (options.economics.recipeId === "generated-only"
      && (!generatedDelivery || [preferredProviderId, ...alternativeProviderIds].some(id => !generative.has(id)))) {
      throw new Error(`全部生成模式要求每镜使用生成图片或视频（可复用生成母片）：第 ${scenePosition} 镜。`);
    }
    const authenticityPolicy = authenticity(shot.authenticityPolicy, `shots[${index}].authenticityPolicy`);
    if (authenticityPolicy === "evidence" && [preferredProviderId, ...alternativeProviderIds].some((id) => generative.has(id))) {
      throw new Error(`Director plan evidence shot ${scenePosition} cannot use a generative provider.`);
    }
    const beats = parseTemporalBeats(shot.temporalBeats, `shots[${index}].temporalBeats`);
    const sceneDuration = options.sceneDurations?.[scenePosition];
    if (sceneDuration !== undefined) {
      validateTemporalBeats(beats, sceneDuration, `shots[${index}].temporalBeats`, deliveryType);
    }
    const visibleAction = optionalText(shot.visibleAction, `shots[${index}].visibleAction`);
    const sourceInSeconds = optionalNonNegativeNumber(shot.sourceInSeconds, `shots[${index}].sourceInSeconds`) ?? 0;
    if ((deliveryType === "stock_image" || deliveryType === "generated_image" || deliveryType === "editorial_card")
      && sourceInSeconds !== 0) {
      throw new Error(`shots[${index}].sourceInSeconds must be 0 for static media.`);
    }
    const generationPrompt = text(shot.generationPrompt, `shots[${index}].generationPrompt`);
    const successCriteria = optionalStringArray(shot.successCriteria, `shots[${index}].successCriteria`);
    if (deliveryType === "editorial_card") {
      assertStaticEditorialCard(
        [visibleAction, ...(beats ?? []).map(({ action }) => action), generationPrompt, ...(successCriteria ?? [])],
        `shots[${index}]`,
      );
    }
    const rationale = text(shot.rationale, `shots[${index}].rationale`);
    assertSelectedProviderIsExecutable(rationale, `shots[${index}].rationale`);
    const query = text(shot.query, `shots[${index}].query`);
    const reuseFromScenePosition = optionalInteger(shot.reuseFromScenePosition, `shots[${index}].reuseFromScenePosition`);
    const referenceFromScenePosition = optionalInteger(
      shot.referenceFromScenePosition,
      `shots[${index}].referenceFromScenePosition`,
    );
    const reuseSource = assetReuseSourceScenePosition({
      ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
      query,
    });
    if (referenceFromScenePosition !== undefined && reuseSource !== undefined) {
      throw new Error(`Director plan scene ${scenePosition} cannot reference and reuse another scene at the same time.`);
    }
    if (referenceFromScenePosition !== undefined) {
      if (referenceFromScenePosition >= scenePosition) {
        throw new Error(
          `Director plan scene ${scenePosition} must reference an earlier scene, received ${referenceFromScenePosition}.`,
        );
      }
      if (deliveryType !== "generated_image") {
        throw new Error(`Director plan scene ${scenePosition} can only use a reference image with generated_image.`);
      }
      const referenceCapableProviders = new Set(options.referenceImageProviderIds ?? []);
      const unsupportedProvider = [preferredProviderId, ...alternativeProviderIds]
        .find((id) => !referenceCapableProviders.has(id));
      if (unsupportedProvider) {
        throw new Error(
          `Director plan scene ${scenePosition} provider '${unsupportedProvider}' does not support reference-image generation.`,
        );
      }
    }
    // 编剧的 visual_strategy 是获取路线建议，不等于用户锁定的真实性合同。真正需要实证的
    // 镜头已由 authenticityPolicy=evidence 与允许 Provider 池共同约束；普通 illustrative 镜头
    // 可以由视觉导演在用户启用的路线内从图库改为生成，避免图库无候选时形成不可执行死路。
    return {
      scenePosition,
      ...(reuseFromScenePosition !== undefined ? { reuseFromScenePosition } : {}),
      ...(referenceFromScenePosition !== undefined ? { referenceFromScenePosition } : {}),
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
      sourceInSeconds,
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
      estimatedCostCny: reuseSource === undefined
        ? serverCost(preferredProviderId, options.estimatedCnyPerClip)
        : 0,
    };
  }).sort((left, right) => left.scenePosition - right.scenePosition);

  if (shots.length !== expectedPositions.length || shots.some((shot, index) => shot.scenePosition !== expectedPositions[index])) {
    throw new Error("Director plan must cover every script scene exactly once.");
  }

  const shotsByPosition = new Map(shots.map((shot) => [shot.scenePosition, shot]));
  // 跨镜主体是否构成叙事依赖是整份方案的语义判断，由既有独立导演审计负责；这里仅
  // 校验可执行的 reuse/reference 关系。自由文本不能用关键词在 parser 阶段提前误杀。
  for (const shot of shots) {
    if (shot.referenceFromScenePosition !== undefined) {
      const source = shotsByPosition.get(shot.referenceFromScenePosition);
      if (!source) {
        throw new Error(
          `Director plan scene ${shot.scenePosition} has missing reference source scene ${shot.referenceFromScenePosition}.`,
        );
      }
      if (source.deliveryType !== "generated_image" || assetReuseSourceScenePosition(source) !== undefined) {
        throw new Error(
          `Director plan scene ${shot.scenePosition} must reference an earlier generated_image scene that is not itself reused.`,
        );
      }
    }
    const reuseFrom = assetReuseSourceScenePosition(shot);
    if (reuseFrom === undefined) continue;
    const { root, links } = resolveReuseRoot(shot, shotsByPosition);
    const invalidLink = links.find(({ scene, source }) => source.scenePosition >= scene.scenePosition);
    if (invalidLink) {
      throw new Error(
        `Director plan scene ${invalidLink.scene.scenePosition} must reuse an earlier scene, `
        + `received ${invalidLink.source.scenePosition}.`,
      );
    }
    shot.reuseFromScenePosition = root.scenePosition;
  }

  if (!draftOnly) {
    const conflict = visualDirectorCapabilityConflicts({ shots }, options)[0];
    if (conflict) throw new PlanContractError(conflict.code, conflict.scenePositions, conflict.detail);
  }

  const paidShots = shots.filter((shot) => shot.estimatedCostCny > 0);
  if (paidShots.length > 0 && !options.economics.allowMeteredProviders) {
    throw new Error("Director plan selected a metered provider while paid providers are disabled.");
  }
  const common = {
    visualBible,
  };
  if (expectedVersion === CHARACTER_DIRECTOR_PLAN_VERSION) {
    const rawShots = new Map(input.shots.map((entry) => {
      const raw = record(entry, "shot");
      return [Number(raw.scenePosition), raw];
    }));
    return { ...common, version: CHARACTER_DIRECTOR_PLAN_VERSION, shots: shots.map((shot) => {
      const expected = options.characterSceneBindings?.[shot.scenePosition];
      if (!expected) throw new Error(`Director plan scene ${shot.scenePosition} has no accepted character binding.`);
      const raw = rawShots.get(shot.scenePosition)!;
      for (const key of ["characterIds", "speakingTurnIds"] as const) {
        const actual = raw[key];
        if (!Array.isArray(actual) || actual.length !== expected[key].length
          || actual.some((id, index) => id !== expected[key][index])) {
          throw new Error(`Director plan scene ${shot.scenePosition} ${key} must match the accepted script exactly.`);
        }
      }
      return { ...shot, characterIds: [...expected.characterIds], speakingTurnIds: [...expected.speakingTurnIds] };
    }) };
  }
  return { ...common, version: DIRECTOR_PLAN_VERSION, shots };
}

/** 对已经通过结构校验的完整稿计算真实单段覆盖，不放大型号能力，也不自动拆镜。 */
export function visualDirectorCapabilityConflicts(
  plan: Pick<VisualDirectorPlan, "shots">,
  options: Pick<VisualDirectorPlanValidation, "sceneDurations" | "selectedVideoModelDurationBounds">,
): CreativeDraftConflict[] {
  if (!options.sceneDurations) return [];
  const shotsByPosition = new Map(plan.shots.map(shot => [shot.scenePosition, shot]));
  const requiredByRoot = new Map<number, { frames: number; consumer: ShotDecision }>();
  for (const shot of plan.shots) {
    const { root } = resolveReuseRoot(shot, shotsByPosition);
    if (root.deliveryType !== "generated_video") continue;
    const frames = reuseSourceEndFrame(shot.scenePosition, shot.sourceInSeconds ?? 0, options.sceneDurations);
    if (frames === undefined) continue;
    if (!requiredByRoot.has(root.scenePosition) || frames > requiredByRoot.get(root.scenePosition)!.frames) {
      requiredByRoot.set(root.scenePosition, { frames, consumer: shot });
    }
  }
  const conflicts: CreativeDraftConflict[] = [];
  for (const [rootPosition, requirement] of requiredByRoot) {
    const root = shotsByPosition.get(rootPosition)!;
    const bounds = options.selectedVideoModelDurationBounds?.[root.preferredProviderId];
    const requiredSeconds = requirement.frames / 30;
    const maximum = bounds?.maxDurationSeconds ?? 15;
    const availableSeconds = requirement.frames > maximum * 30 ? maximum : normalizeVideoGenerationDurationSeconds(requiredSeconds, bounds);
    if (availableSeconds * 30 < requirement.frames) conflicts.push({ code: "execution_capability_conflict",
      scenePositions: [requirement.consumer.scenePosition],
      detail: `Director plan scene ${requirement.consumer.scenePosition} reuses generated video from root scene ${rootPosition}, `
        + `requires source through ${requiredSeconds}s, but that source only produces ${availableSeconds}s.`,
    });
  }
  return conflicts;
}

function resolveReuseRoot(
  shot: ShotDecision,
  shotsByPosition: ReadonlyMap<number, ShotDecision>,
): { root: ShotDecision; links: Array<{ scene: ShotDecision; source: ShotDecision }> } {
  const visited = new Set<number>([shot.scenePosition]);
  const links: Array<{ scene: ShotDecision; source: ShotDecision }> = [];
  let current = shot;
  while (true) {
    const reuseFrom = assetReuseSourceScenePosition(current);
    if (reuseFrom === undefined) return { root: current, links };
    if (visited.has(reuseFrom)) {
      throw new Error(`Director plan contains a reuse cycle involving scene ${reuseFrom}.`);
    }
    const source = shotsByPosition.get(reuseFrom);
    if (!source) {
      throw new Error(`Director plan scene ${current.scenePosition} has missing reuse source scene ${reuseFrom}.`);
    }
    visited.add(reuseFrom);
    links.push({ scene: current, source });
    current = source;
  }
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

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : integer(value, field);
}

function optionalStringArray(value: unknown, field: string, allowEmpty = false): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 10) {
    throw new Error(`${field} must be an array of ${allowEmpty ? "0" : "1"} to 10 strings.`);
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function validateTemporalBeats(
  beats: ShotTemporalBeat[] | undefined,
  duration: number,
  field: string,
  _deliveryType: VisualAssetDeliveryType,
): void {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${field} scene duration is invalid.`);
  if (!beats || beats.length < 1 || beats.length > 10) {
    throw new Error(`${field} must contain 1 to 10 timed beats.`);
  }
  const frameToleranceSeconds = 1 / 30;
  let previousEnd = 0;
  beats.forEach((beat, index) => {
    if (beat.endSeconds <= beat.startSeconds) throw new Error(`${field}[${index}] must end after it starts.`);
    if (beat.startSeconds < previousEnd - frameToleranceSeconds) throw new Error(`${field}[${index}] overlaps or is out of order.`);
    if (Math.abs(beat.startSeconds - previousEnd) > frameToleranceSeconds) throw new Error(`${field} must be continuous without gaps.`);
    if (beat.endSeconds > duration + frameToleranceSeconds) throw new Error(`${field}[${index}] exceeds the ${duration}s scene duration.`);
    previousEnd = beat.endSeconds;
  });
  if (Math.abs(previousEnd - duration) > frameToleranceSeconds) {
    throw new Error(`${field} must cover the complete ${duration}s scene duration.`);
  }
}

function parseTemporalBeats(value: unknown, field: string): ShotTemporalBeat[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error(`${field} must be an array of 1 to 10 structured beats.`);
  }
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      const match = /^\[\s*(\d+(?:\.\d+)?)s\s*-\s*(\d+(?:\.\d+)?)s\s*\]\s*(\S[\s\S]*)$/i.exec(entry);
      if (!match) throw new Error(`${field}[${index}] must use a structured beat or legacy [0s-2s] description.`);
      return {
        startSeconds: Number(match[1]),
        endSeconds: Number(match[2]),
        action: match[3]!.trim(),
      };
    }
    const input = record(entry, `${field}[${index}]`);
    return {
      startSeconds: finiteNumber(input.startSeconds, `${field}[${index}].startSeconds`),
      endSeconds: finiteNumber(input.endSeconds, `${field}[${index}].endSeconds`),
      action: text(input.action, `${field}[${index}].action`),
    };
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

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = finiteNumber(value, field);
  if (parsed < 0) throw new Error(`${field} must be non-negative.`);
  return parsed;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
