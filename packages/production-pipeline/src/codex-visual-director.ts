import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution } from "./codex-chat.js";
import {
  assetReuseSourceScenePosition,
  normalizeVideoGenerationDurationSeconds,
} from "./generative-asset-worker.js";
import {
  VISUAL_DIRECTOR_PROFILES,
  validateVisualDirectorPlan,
  type VisualAssetDeliveryType,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type VisualDirectorPlan,
  type VisualDirectorPlanValidation,
} from "./visual-director.js";
import { runRoleAgentLoop, type RoleAgentValidationContext } from "./role-agent-loop.js";

export interface CodexVisualDirectorAgentOptions {
  client?: CodexBridgeClient;
  auditClient?: Pick<CodexBridgeClient, "runTaskDetailed">;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReviewIterations?: number;
  modelId?: string;
  sessionMode?: "stateful" | "stateless";
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_DIRECTOR_TIMEOUT_MS = 660_000;
const DEFAULT_DIRECTOR_MAX_ATTEMPTS = 2;
export const VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION = "director-v25|role-audit-v3|director-validator-v5|visual-plan-v2";

// id 保持 api-visual-director-v1：历史 run 的 brief 持久化了该 id，ProductionPipeline.createRegistry 按 id 匹配 provider。
export class CodexVisualDirectorAgent implements VisualDirectorAgent {
  readonly id = "api-visual-director-v1";
  readonly modelId: string;
  private readonly client: CodexBridgeClient;
  private readonly auditClient: Pick<CodexBridgeClient, "runTaskDetailed"> | undefined;
  private readonly maxReviewIterations: number;
  private readonly sessionMode: "stateful" | "stateless";

  constructor(options: CodexVisualDirectorAgentOptions) {
    this.modelId = options.modelId?.trim() || "codex-default";
    this.auditClient = options.auditClient;
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
    this.sessionMode = options.sessionMode ?? "stateful";
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.socketPath) {
        throw new Error("CodexVisualDirectorAgent requires a CodexBridgeClient or a socketPath.");
      }
      this.client = new CodexBridgeClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_DIRECTOR_TIMEOUT_MS,
        maxAttempts: options.maxAttempts ?? DEFAULT_DIRECTOR_MAX_ATTEMPTS,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      });
    }
  }

  // 模型输出为 unknown：先经 validateVisualDirectorPlan 硬校验，malformed/不合法直接抛错，没有任何 fallback。
  async plan(input: VisualDirectorAgentInput): Promise<VisualDirectorPlan> {
    this.assertSelectedModel(input.selectedModelId);
    const {
      agentLoopCheckpoint: _checkpoint,
      selectedModelId: _selectedModelId,
      wallClockDeadlineAtMs,
      ...directorInput
    } = input;
    const rawPlan = await this.client.runTask("director-plan", {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...directorInputForModel(directorInput),
    }, undefined, requestOptionsForDeadline(wallClockDeadlineAtMs));
    return validateDirectorCandidate(rawPlan, input);
  }

  async planDetailed(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<VisualDirectorPlan>> {
    this.assertSelectedModel(input.selectedModelId);
    const {
      agentLoopCheckpoint,
      selectedModelId: _selectedModelId,
      wallClockDeadlineAtMs,
      ...directorInput
    } = input;
    const basePayload = {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...directorInputForModel(directorInput),
    };
    const auditClient = this.auditClient ?? this.client;
    return runRoleAgentLoop({
      role: "导演",
      contractVersion: VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
      criteria: [
        "视觉圣经与题材、模板和参考语法一致；输入含编剧 viewerPromise 时必须逐字保留，narrativeArc 与每个 scene purpose 必须原样进入导演判断，不能另起观众承诺",
        "上游画面方案中的观众收益与视觉论证意图得到兑现；方案可以按 Provider 能力重规划，但不能被模板通用镜头机械覆盖，也不能被当作已经验证的事实",
        "每镜头的动作、逐秒节拍、构图、声音设计与验收条件可真实执行；脚本 onScreenText 与 soundCue 由下游继承，不得要求导演重复输出不存在的字段",
        "素材 Provider、交付类型和能力约束完全匹配；方案费用可真实报价，费用反馈用于优先降低成本，无法达到目标时仍须给出可执行方案供创作者决定",
        "付费前必须核对画幅与时长可交付、禁文字要求、每镜成功条件和跨镜一致性；要求同一主体或单变量对照时必须有可执行的复用或参考图依据，不能把独立文生视频的相似提示当作一致性保证；应在方案阶段缩小或改写不可控的视觉承诺",
        "当观众承诺或核心论证依赖精确跨镜身份，而现有 Provider 没有一致性能力时，不能降为 advisory 后继续付费；必须作为 blocking 阻断，并要求导演重规划可执行叙事，使观众无需假定对象未更换",
        "相邻镜头连续性成立，生成式画面不被伪装为现实因果、真实实验、产品效果或事件证据",
        "系列视觉母题、角色/声音锚点、canon 与前后集连续性得到保持",
        "返工时 visualDirectionInstruction 与 assetInstruction 都是人工授权且必须落实的修改要求；允许据此改变 visualBible、逐镜 Provider、交付类型、复用路由、query 和 generationPrompt，不得把 assetInstruction 驱动的改动判为越权，同时保留真正未受影响的镜头",
        "返工 findings 只追踪分配给 visual-direction 的 findingId；当前节点可以说明已落实修改，但不得宣称问题已经复验通过",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session }) => this.client.runTaskDetailed("director-plan", {
        ...basePayload,
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, requestOptionsForDeadline(wallClockDeadlineAtMs)),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId }) => auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: visualDirectorAuditContext(directorInput, candidate),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      // 当前候选与上一轮审计已经完整随请求发送，独立审计不继承历史以免输入随轮次翻倍。
      }, requestId, undefined, requestOptionsForDeadline(wallClockDeadlineAtMs)),
      validate: (value, context) => validateDirectorCandidate(value, input, context),
      ...(agentLoopCheckpoint ? { checkpoint: agentLoopCheckpoint } : {}),
    });
  }

  private assertSelectedModel(selectedModelId: string | undefined): void {
    if (selectedModelId && selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${selectedModelId}' is not available for visual direction.`);
    }
  }
}

function directorInputForModel(
  input: Omit<VisualDirectorAgentInput, "agentLoopCheckpoint" | "selectedModelId" | "wallClockDeadlineAtMs">,
): typeof input {
  const rework = input.brief.rework;
  if (!rework?.previousDirectorPlan || rework.affectedScenePositions === undefined) return input;
  const affectedScenes = new Set(rework.affectedScenePositions);
  assertNoUnauthorizedConfigurationDrift(
    affectedScenes,
    rework.previousDirectorPlan,
    validationFor(input),
  );
  if (affectedScenes.size >= input.scenes.length) return input;
  const previousShots = rawPlanShotsByPosition(rework.previousDirectorPlan, "Director previous plan");
  return {
    ...input,
    brief: {
      ...input.brief,
      rework: {
        ...rework,
        affectedScenePositions: [...affectedScenes].sort((left, right) => left - right),
        previousDirectorPlan: {
          ...rework.previousDirectorPlan,
          // 未受影响镜头由宿主程序逐字继承，生产模型无需重复读取或重写；
          // 合并后的完整方案仍会经过同一业务校验和独立审计。
          shots: [...affectedScenes].sort((left, right) => left - right).map((position) => {
            const shot = previousShots.get(position);
            if (!shot) throw new Error(`Director previous plan is missing the affected shot for scene ${position}.`);
            return shot;
          }),
        },
      },
    },
  };
}

function validateDirectorCandidate(
  value: unknown,
  input: VisualDirectorAgentInput,
  context?: RoleAgentValidationContext,
): VisualDirectorPlan {
  const validation = validationFor(input);
  const rework = input.brief.rework;
  if (!rework?.previousDirectorPlan || rework.affectedScenePositions === undefined) {
    return validateVisualDirectorPlan(value, validation);
  }
  // scoped rework 先合并再校验：存在结构化 affected 集合时直接合并，
  // 不再以中文是否包含“保留未受影响”作为保留开关；即将被替换的旧 shot
  // 与即将被覆盖的 candidate shot 都不做提前完整校验，只做安全索引所需的最小结构检查。
  // 合并范围只由当前脚本的权威 expected positions（validation.scenePositions）决定，
  // 不得用 candidate/previous 的键并集隐式扩大覆盖；合并后仍只做一次完整校验。
  const merged = mergeReworkCandidateShots(
    value,
    rework.previousDirectorPlan,
    new Set(rework.affectedScenePositions),
    validation.scenePositions,
  );
  return validateVisualDirectorPlan(merged, validation);
}

// scoped merge 前建立 previous 到 current execution configuration 的差异闭包：
// previous shot 依赖的 Provider 已从当前允许目录移除、不再被允许、不再兼容当前交付类型
// 或参考图能力，或其 REUSE_ONLY 母片在当前所选 model 的时长边界下不再可行时，
// 合并保留下来的 previous shot 无法通过完整 plan validation，会把返工卡成永久校验失败。
// 这些镜头必须在模型调用前触发范围冲突，等用户重新确认；不能由模型静默扩大返工范围。
// director plan 的 shot 不持久化 model 身份；用户更换 model 的执行后果
// 经当前时长边界（selectedVideoModelDurationBounds）进入闭包。
function previousToCurrentConfigurationDrift(
  affectedScenes: Set<number>,
  previousPlan: Record<string, unknown>,
  validation: VisualDirectorPlanValidation,
): Set<number> {
  const allowed = new Set(validation.allowedProviderIds);
  const currentScenePositions = new Set(validation.scenePositions);
  const previousShots = rawPlanShotsByPosition(previousPlan, "Director previous plan");
  for (const [position, shot] of previousShots) {
    if (affectedScenes.has(position) || !currentScenePositions.has(position)) continue;
    if (previousShotConfigurationDrifted(shot, previousShots, allowed, validation)) {
      affectedScenes.add(position);
    }
  }
  return affectedScenes;
}

function assertNoUnauthorizedConfigurationDrift(
  authorizedScenes: Set<number>,
  previousPlan: Record<string, unknown>,
  validation: VisualDirectorPlanValidation,
): void {
  const drifted = previousToCurrentConfigurationDrift(
    new Set(authorizedScenes),
    previousPlan,
    validation,
  );
  const unauthorized = [...drifted]
    .filter((position) => !authorizedScenes.has(position))
    .sort((left, right) => left - right);
  if (unauthorized.length > 0) {
    throw new Error(`Director rework scope must be confirmed again because scenes ${unauthorized.join(", ")} are no longer executable with the current Provider or model configuration.`);
  }
}

function previousShotConfigurationDrifted(
  shot: Record<string, unknown>,
  previousShots: ReadonlyMap<number, Record<string, unknown>>,
  allowed: Set<string>,
  validation: VisualDirectorPlanValidation,
): boolean {
  const preferredProviderId = typeof shot.preferredProviderId === "string" ? shot.preferredProviderId : undefined;
  const alternatives = Array.isArray(shot.alternativeProviderIds)
    ? shot.alternativeProviderIds.filter((id): id is string => typeof id === "string")
    : [];
  const deliveryType = typeof shot.deliveryType === "string" ? shot.deliveryType : undefined;
  if (preferredProviderId === undefined) return true;
  for (const providerId of [preferredProviderId, ...alternatives]) {
    if (!allowed.has(providerId)) return true;
    if (deliveryType !== undefined) {
      const supported = validation.providerDeliveryTypes?.[providerId];
      if (supported && !supported.includes(deliveryType as VisualAssetDeliveryType)) return true;
    }
  }
  if (typeof shot.referenceFromScenePosition === "number") {
    // 与 validateVisualDirectorPlan 同口径：引用参考图时 preferred 和所有 alternative
    // 都必须属于 referenceImageProviderIds，任一失效即判漂移，交由 candidate 替换。
    const referenceCapable = new Set(validation.referenceImageProviderIds ?? []);
    for (const providerId of [preferredProviderId, ...alternatives]) {
      if (!referenceCapable.has(providerId)) return true;
    }
  }
  return previousReuseDurationInfeasible(shot, previousShots, validation);
}

// 与 validateVisualDirectorPlan 对 REUSE_ONLY 链的时长判定同源：复用 generated_video
// 母片的镜头按根镜头在当前时长边界下能生成的真实长度检查，防止更换 model 后旧复用
// 路由在新边界下永久校验失败。结构不明的链路保守返回不可行，交由完整校验给出准确错误。
function previousReuseDurationInfeasible(
  shot: Record<string, unknown>,
  previousShots: ReadonlyMap<number, Record<string, unknown>>,
  validation: VisualDirectorPlanValidation,
): boolean {
  const scenePosition = Number(shot.scenePosition);
  const visited = new Set<number>([scenePosition]);
  let current = shot;
  while (true) {
    const reuseFrom = assetReuseSourceScenePosition({
      ...(typeof current.reuseFromScenePosition === "number"
        ? { reuseFromScenePosition: current.reuseFromScenePosition }
        : {}),
      query: typeof current.query === "string" ? current.query : "",
    });
    if (reuseFrom === undefined) {
      return current !== shot && reuseDurationExceedsGeneratedLength(current, scenePosition, validation);
    }
    if (visited.has(reuseFrom)) return false;
    const source = previousShots.get(reuseFrom);
    if (!source) return false;
    visited.add(reuseFrom);
    current = source;
  }
}

function reuseDurationExceedsGeneratedLength(
  root: Record<string, unknown>,
  scenePosition: number,
  validation: VisualDirectorPlanValidation,
): boolean {
  if (root.deliveryType !== "generated_video") return false;
  const providerId = typeof root.preferredProviderId === "string" ? root.preferredProviderId : undefined;
  if (!providerId) return false;
  const bounds = validation.selectedVideoModelDurationBounds?.[providerId];
  const rootDuration = validation.sceneDurations?.[Number(root.scenePosition)];
  const targetDuration = validation.sceneDurations?.[scenePosition];
  if (targetDuration === undefined) return false;
  const generatedDuration = rootDuration === undefined
    ? bounds?.maxDurationSeconds
    : normalizeVideoGenerationDurationSeconds(rootDuration, bounds);
  return generatedDuration !== undefined && targetDuration > generatedDuration;
}

function mergeReworkCandidateShots(
  candidate: unknown,
  previous: unknown,
  affectedScenes: Set<number>,
  expectedPositions: number[],
): Record<string, unknown> {
  const candidateShots = rawPlanShotsByPosition(candidate, "Director rework candidate");
  const previousShots = rawPlanShotsByPosition(previous, "Director previous plan");
  const expected = new Set(expectedPositions);
  for (const position of affectedScenes) {
    if (!expected.has(position)) {
      throw new Error(`Director rework affects scene ${position}, which is not part of the current script.`);
    }
  }
  const partialRework = affectedScenes.size < expectedPositions.length;
  const merged = partialRework
    ? { ...(isRecord(previous) ? previous : {}) }
    : { ...(isRecord(candidate) ? candidate : {}) };
  return {
    ...merged,
    shots: expectedPositions.map((position) => {
      if (affectedScenes.has(position)) {
        // 受影响镜头必须精确来自 candidate；缺失即拒绝，禁止回退 previous 假装已重做。
        const candidateShot = candidateShots.get(position);
        if (!candidateShot) {
          throw new Error(`Director rework candidate is missing the affected shot for scene ${position}.`);
        }
        return candidateShot;
      }
      // 未受影响镜头必须精确来自 previous；缺失即拒绝，禁止用 candidate 的未授权漂移补洞。
      const previousShot = previousShots.get(position);
      if (!previousShot) {
        throw new Error(`Director previous plan is missing the unaffected shot for scene ${position}.`);
      }
      return previousShot;
    }),
  };
}

function rawPlanShotsByPosition(plan: unknown, label: string): Map<number, Record<string, unknown>> {
  if (!isRecord(plan) || !Array.isArray(plan.shots)) {
    throw new Error(`${label} must contain a shots array before rework merging.`);
  }
  // 安全索引所需的最小结构检查：显式遍历每项，拒绝一切无法索引或歧义的条目。
  const shots = new Map<number, Record<string, unknown>>();
  for (const shot of plan.shots) {
    if (!isRecord(shot)) {
      throw new Error(`${label} contains a shot that is not an object.`);
    }
    const position = shot.scenePosition;
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) {
      throw new Error(`${label} contains a shot whose scenePosition is not a positive safe integer.`);
    }
    if (shots.has(position)) {
      throw new Error(`${label} contains more than one shot for scene ${position}.`);
    }
    shots.set(position, shot);
  }
  return shots;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visualDirectorAuditContext(
  input: Omit<VisualDirectorAgentInput, "agentLoopCheckpoint">,
  candidate: VisualDirectorPlan,
): Record<string, unknown> {
  const { brief } = input;
  const template = brief.templateBlueprint;
  const reference = brief.referenceGrammar;
  const series = brief.seriesContext;
  const reworkForAudit = brief.rework ? {
    sourceRunId: brief.rework.sourceRunId,
    visualDirectionInstruction: brief.rework.visualDirectionInstruction,
    assetInstruction: brief.rework.assetInstruction,
    findings: brief.rework.findings,
    ...(brief.rework.affectedScenePositions !== undefined
      ? { affectedScenePositions: brief.rework.affectedScenePositions }
      : {}),
  } : undefined;
  const selectedDirectorProfile = VISUAL_DIRECTOR_PROFILES.find(({ id }) => id === candidate.resolvedProfileId);
  if (!selectedDirectorProfile) throw new Error(`Director profile '${candidate.resolvedProfileId}' is unavailable.`);
  return {
    roleScope: {
      owns: ["requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"],
      doesNotOwn: ["素材实际下载结果", "生成模型最终画面", "配音成品", "渲染与审片结果"],
    },
    upstreamFacts: {
      brief: {
        title: brief.title,
        angle: brief.angle,
        audience: brief.audience,
        platform: brief.platform,
        durationSeconds: brief.durationSeconds,
        ...(brief.viewerPromise ? { viewerPromise: brief.viewerPromise } : {}),
        ...(brief.narrativeArc ? { narrativeArc: brief.narrativeArc } : {}),
        requestedProfileId: brief.requestedProfileId,
        ...(brief.editorial ? { editorial: brief.editorial } : {}),
        ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
        ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
        ...(reworkForAudit ? { rework: reworkForAudit } : {}),
        ...(brief.rework ? {
          verificationBoundary: "findingId 仅追踪修改要求；只有后续视觉审片的新报告批准后才算 verified，当前导演审计不得宣称已复验。",
        } : {}),
        ...(template ? {
          template: {
            automationLevel: template.automationLevel,
            storyStructure: template.storyStructure.map(({ id, purpose, required }) => ({ id, purpose, required })),
            shotSlots: template.shotSlots.map(({ id, beatId, purpose, durationSeconds, allowedCapabilities }) => ({
              id,
              beatId,
              purpose,
              durationSeconds,
              allowedCapabilities,
            })),
            visualSystem: template.visualSystem,
            soundSystem: template.soundSystem,
            qualityRules: template.qualityRules.map(({ label, dimension, required, threshold }) => ({
              label,
              dimension,
              required,
              threshold,
            })),
          },
        } : {}),
        ...(reference ? {
          referenceGrammar: {
            summary: reference.summary,
            pacing: reference.pacing,
            composition: reference.composition,
            camera: reference.camera,
            color: reference.color,
            transitions: reference.transitions,
            sound: reference.sound,
            reusableRules: reference.reusableRules,
            avoidCopying: reference.avoidCopying,
            confidence: reference.confidence,
          },
        } : {}),
        ...(series ? {
          seriesContinuity: {
            seriesName: series.seriesName,
            episodeNumber: series.episodeNumber,
            premise: series.premise,
            arc: series.arc,
            episode: {
              pillar: series.episode.pillar,
              viewerPromise: series.episode.viewerPromise,
              hook: series.episode.hook,
              payoff: series.episode.payoff,
            },
            bible: series.bible,
            canon: {
              revision: series.canon.revision,
              facts: series.canon.facts.map(({ id, statement, sourceEpisodeId }) => ({ id, statement, sourceEpisodeId })),
            },
            continuity: series.continuity,
          },
        } : {}),
      },
      scenes: input.scenes.map((scene) => ({
        position: scene.position,
        ...(scene.purpose ? { purpose: scene.purpose } : {}),
        narration: scene.narration,
        duration: scene.duration,
        visualStrategy: scene.visualStrategy,
        visualPrompt: scene.visualPrompt,
        visibleAction: scene.visibleAction,
        ...(scene.onScreenText ? { onScreenText: scene.onScreenText } : {}),
        ...(scene.soundCue ? { soundCue: scene.soundCue } : {}),
        successCriteria: scene.successCriteria,
        failureConditions: scene.failureConditions,
      })),
    },
    currentRoleContract: {
      availableDirectorProfileIds: VISUAL_DIRECTOR_PROFILES.map(({ id }) => id),
      selectedDirectorProfile,
      assetReuse: {
        querySyntax: "REUSE_ONLY scene N",
        execution: "下游素材执行器直接复用已解析的更早镜头母片，不会重新搜索、生成或计费。",
        constraints: [
          "N 只能引用更早且可成功解析的导演镜头。",
          "多级复用始终解析到同一个根母片，不能形成循环。",
          "复用从母片开头使用相同媒体内容，不会产生新的动作、光线变化、后续片段或画面状态。",
          "生成视频母片的真实长度按所选模型的最短/最长时长和整数秒规则归一化；复用镜头不得更长。",
        ],
      },
      timelineExecution: {
        temporalBeatsDescribeRenderedSceneDuration: true,
        generatedClipMayBeLongerThanRenderedScene: true,
        extraGeneratedTailIsTrimmed: true,
        rule: "temporalBeats 的结束时间不得超过脚本镜头时长；Provider 最短生成时长更长时，只描述成片实际使用区间，多出的母片尾部由渲染器裁切。",
      },
      inheritedScriptFields: {
        onScreenText: "由下游从脚本逐镜继承；导演只需在构图、负面约束或验收条件中保留字幕安全区，不重复输出该字段。",
        soundCue: "由下游声音设计继承；导演只需让 visualBible.sound 与镜头节奏不冲突，不重复输出该字段。",
      },
      assetReference: {
        field: "referenceFromScenePosition",
        execution: "把更早镜头的图片作为参考输入，再调用支持参考图的图片 Provider 生成新图；这是新的付费生成，不是原样复用。",
        constraints: [
          "只能引用更早的图片镜头，且不得与 reuseFromScenePosition 或 REUSE_ONLY 同时使用。",
          "目标镜头的 deliveryType 必须是 generated_image，Provider 必须明确支持参考图生成。",
        ],
      },
      assetProviders: input.assetProviders.map((provider) => ({
        id: provider.id,
        label: provider.label,
        billing: provider.billing,
        deliveryTypes: provider.deliveryTypes,
        supportsReferenceImage: provider.supportsReferenceImage ?? false,
        strengths: provider.strengths,
        constraints: provider.constraints.filter((constraint) => !isDownstreamDisclosureConstraint(constraint)),
        estimatedCnyPerClip: provider.estimatedCnyPerClip,
        ...(provider.selectedModelId ? { selectedModelId: provider.selectedModelId } : {}),
        ...(provider.minDurationSeconds !== undefined ? { minDurationSeconds: provider.minDurationSeconds } : {}),
        ...(provider.maxDurationSeconds !== undefined ? { maxDurationSeconds: provider.maxDurationSeconds } : {}),
        ...(provider.aspectRatios ? { aspectRatios: provider.aspectRatios } : {}),
      })),
      economics: input.economics,
      spendApprovalBoundary: {
        enabledAssetProvidersAreAuthorizedForPlanning: true,
        selectingMeteredProviderCreatesQuoteOnly: true,
        paidCallOccursOnlyAfterDownstreamHumanApproval: true,
        directorMustChooseOneExecutableRoute: true,
      },
      ...(brief.rework ? {
        reworkAuthorization: {
          requiredInstructions: {
            visualDirection: brief.rework.visualDirectionInstruction,
            assets: brief.rework.assetInstruction,
          },
          permittedPlanChanges: [
            "visualBible",
            "逐镜 Provider 与交付类型",
            "复用/参考图路由与 query",
            "generationPrompt 与镜头验收条件",
          ],
          findingOwnership: "findings 只包含分配给 visual-direction 的 findingId；assetInstruction 无需额外 findingId 即属于本次人工授权范围。",
          affectedScenePositions: brief.rework.affectedScenePositions ?? [],
          preservationRule: "保留真正未受两类指令影响的镜头；不得为了恢复上一版而撤销 assetInstruction 要求的改动。",
          verificationBoundary: "当前导演与独立审计只能确认方案已落实要求，不得宣称后续视觉审片已经验证通过。",
        },
      } : {}),
    },
    downstreamBoundary: "审查镜头计划是否能被已声明 Provider 执行；不得要求当前节点提供尚未生成或下载的真实画面，也不得要求创作者提前批准当前节点提出的付费路线。导演选择 metered Provider 只生成报价，真实调用仍由下游人工费用确认控制。AIGC 标识、内容声明、文件标记与平台披露由渲染与发布链路负责，不得成为视觉圣经或逐镜计划的通过条件。",
  };
}

function isDownstreamDisclosureConstraint(value: string): boolean {
  return /AIGC|(?:AI\s*生成|AI\s*内容|人工智能生成|生成式镜头).*(?:标识|声明|披露)|平台(?:声明|披露)|文件(?:标记|标识)|成片.*(?:标识|声明|披露)|水印.*(?:保留|清晰|裁切|遮挡|移除)/i.test(value);
}

function validationFor(input: VisualDirectorAgentInput): VisualDirectorPlanValidation {
  return {
    scenePositions: input.scenes.map((scene) => scene.position),
    ...(input.brief.viewerPromise ? { viewerPromise: input.brief.viewerPromise } : {}),
    sceneDurations: Object.fromEntries(input.scenes.map((scene) => [scene.position, scene.duration])),
    sceneVisualStrategies: Object.fromEntries(input.scenes.map((scene) => [scene.position, scene.visualStrategy])),
    allowedProviderIds: input.assetProviders.map((provider) => provider.id),
    generativeProviderIds: input.assetProviders
      .filter((provider) => provider.deliveryTypes.some((type) => type === "generated_image" || type === "generated_video"))
      .map((provider) => provider.id),
    providerDeliveryTypes: Object.fromEntries(
      input.assetProviders.map((provider) => [provider.id, provider.deliveryTypes]),
    ),
    referenceImageProviderIds: input.assetProviders
      .filter((provider) => provider.supportsReferenceImage)
      .map((provider) => provider.id),
    estimatedCnyPerClip: Object.fromEntries(
      input.assetProviders.map((provider): [string, number] => [provider.id, provider.estimatedCnyPerClip]),
    ),
    selectedVideoModelDurationBounds: Object.fromEntries(
      input.assetProviders.flatMap((provider): Array<[string, { minDurationSeconds: number; maxDurationSeconds: number }]> => (
        provider.minDurationSeconds === undefined || provider.maxDurationSeconds === undefined
          ? []
          : [[provider.id, {
              minDurationSeconds: provider.minDurationSeconds,
              maxDurationSeconds: provider.maxDurationSeconds,
            }]]
      )),
    ),
    selectedVideoModelAspectRatios: Object.fromEntries(
      input.assetProviders.flatMap((provider) => provider.aspectRatios
        ? [[provider.id, provider.aspectRatios] as const]
        : []),
    ),
    requiredAspectRatio: "9:16",
    economics: input.economics,
  };
}
