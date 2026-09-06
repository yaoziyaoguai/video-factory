import { isDeepStrictEqual } from "node:util";
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
import { runRoleAgentLoop } from "./role-agent-loop.js";

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
export const VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION = "director-v14|role-audit-v2|director-validator-v2";

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
      ...directorInput,
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
      ...directorInput,
    };
    const auditClient = this.auditClient ?? this.client;
    return runRoleAgentLoop({
      role: "导演",
      contractVersion: VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
      criteria: [
        "视觉圣经与题材、观众承诺、模板和参考语法一致",
        "每镜头的动作、逐秒节拍、构图、声音与验收条件可真实执行",
        "素材 Provider、交付类型和能力约束完全匹配；方案费用可真实报价，费用反馈用于优先降低成本，无法达到目标时仍须给出可执行方案供创作者决定",
        "相邻镜头连续性成立，生成式画面不被伪装为事实证据",
        "系列视觉母题、角色/声音锚点、canon 与前后集连续性得到保持",
        "返工时 visualDirectionInstruction 与 assetInstruction 都是人工授权且必须落实的修改要求；允许据此改变 visualBible、逐镜 Provider、交付类型、复用路由、query 和 generationPrompt，不得把 assetInstruction 驱动的改动判为越权，同时保留真正未受影响的镜头",
        "返工 findings 只追踪分配给 visual-direction 的 findingId；当前节点可以说明已落实修改，但不得宣称问题已经复验通过",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session }) => this.client.runTaskDetailed("director-plan", {
        ...basePayload,
        ...(revision ? { revision } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, requestOptionsForDeadline(wallClockDeadlineAtMs)),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId, session }) => auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: visualDirectorAuditContext(directorInput, candidate),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
      }, requestId, this.sessionMode === "stateless" ? undefined : session, requestOptionsForDeadline(wallClockDeadlineAtMs)),
      validate: (value) => validateDirectorCandidate(value, input),
      ...(agentLoopCheckpoint ? { checkpoint: agentLoopCheckpoint } : {}),
    });
  }

  private assertSelectedModel(selectedModelId: string | undefined): void {
    if (selectedModelId && selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${selectedModelId}' is not available for visual direction.`);
    }
  }
}

function validateDirectorCandidate(value: unknown, input: VisualDirectorAgentInput): VisualDirectorPlan {
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
    previousToCurrentConfigurationDrift(
      new Set(rework.affectedScenePositions),
      rework.previousDirectorPlan,
      validation,
    ),
    validation.scenePositions,
  );
  return validateVisualDirectorPlan(merged, validation);
}

// scoped merge 前建立 previous 到 current execution configuration 的差异闭包：
// previous shot 依赖的 Provider 已从当前允许目录移除、不再被允许、不再兼容当前交付类型
// 或参考图能力，或其 REUSE_ONLY 母片在当前所选 model 的时长边界下不再可行时，
// 合并保留下来的 previous shot 无法通过完整 plan validation，会把返工卡成永久校验失败。
// 这些镜头必须自动加入 affected scene positions，改用 candidate 的合法替换；
// 最终仍走完整校验，绝不绕过 allowed-provider 门禁。
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
  if (typeof shot.referenceFromScenePosition === "number"
    && !(validation.referenceImageProviderIds ?? []).includes(preferredProviderId)) {
    return true;
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
  const merged = { ...(isRecord(candidate) ? candidate : {}) };
  const scopedToEveryScene = expectedPositions.every((position) => affectedScenes.has(position));
  if (!scopedToEveryScene
    && merged.visualBible !== undefined
    && isRecord(previous)
    && isRecord(previous.visualBible)
    && !isDeepStrictEqual(merged.visualBible, previous.visualBible)) {
    // partial scoped merge 不得无条件采用新的顶层 visualBible 却保留旧 shots/母片：
    // 作用域不是全片时，顶层视觉体系必须与 previous 完全一致；候选更改顶层体系时
    // 明确拒绝并交回既有 agent loop 修正（保持 previous 体系，或把作用域扩为全片），
    // 绝不返回“新 visualBible + 旧未受影响 shot”。
    throw new Error(
      "Director rework candidate changes the top-level visualBible while the rework scope is not the whole script; "
      + "keep the previous visualBible unchanged or rework every scene.",
    );
  }
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
        requestedProfileId: brief.requestedProfileId,
        ...(brief.editorial ? { editorial: brief.editorial } : {}),
        ...(brief.rework ? { rework: brief.rework } : {}),
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
      })),
      economics: input.economics,
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
    downstreamBoundary: "审查镜头计划是否能被已声明 Provider 执行；不得要求当前节点提供尚未生成或下载的真实画面。AIGC 标识、内容声明、文件标记与平台披露由渲染与发布链路负责，不得成为视觉圣经或逐镜计划的通过条件。",
  };
}

function isDownstreamDisclosureConstraint(value: string): boolean {
  return /AIGC|(?:AI\s*生成|AI\s*内容|人工智能生成|生成式镜头).*(?:标识|声明|披露)|平台(?:声明|披露)|文件(?:标记|标识)|成片.*(?:标识|声明|披露)|水印.*(?:保留|清晰|裁切|遮挡|移除)/i.test(value);
}

function validationFor(input: VisualDirectorAgentInput): VisualDirectorPlanValidation {
  return {
    scenePositions: input.scenes.map((scene) => scene.position),
    sceneDurations: Object.fromEntries(input.scenes.map((scene) => [scene.position, scene.duration])),
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
    economics: input.economics,
  };
}
