import { CodexBridgeClient, type CodexTaskExecution } from "./codex-chat.js";
import {
  VISUAL_DIRECTOR_PROFILES,
  validateVisualDirectorPlan,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type VisualDirectorPlan,
  type VisualDirectorPlanValidation,
} from "./visual-director.js";
import { runRoleAgentLoop } from "./role-agent-loop.js";

export interface CodexVisualDirectorAgentOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReviewIterations?: number;
  modelId?: string;
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_DIRECTOR_TIMEOUT_MS = 660_000;
const DEFAULT_DIRECTOR_MAX_ATTEMPTS = 2;
export const VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION = "director-v11|role-audit-v2|director-validator-v2";

// id 保持 api-visual-director-v1：历史 run 的 brief 持久化了该 id，ProductionPipeline.createRegistry 按 id 匹配 provider。
export class CodexVisualDirectorAgent implements VisualDirectorAgent {
  readonly id = "api-visual-director-v1";
  readonly modelId: string;
  private readonly client: CodexBridgeClient;
  private readonly maxReviewIterations: number;

  constructor(options: CodexVisualDirectorAgentOptions) {
    this.modelId = options.modelId?.trim() || "codex-default";
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
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
    const { agentLoopCheckpoint: _checkpoint, ...directorInput } = input;
    const rawPlan = await this.client.runTask("director-plan", {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...directorInput,
    });
    return validateVisualDirectorPlan(rawPlan, validationFor(input));
  }

  async planDetailed(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<VisualDirectorPlan>> {
    const { agentLoopCheckpoint, ...directorInput } = input;
    const basePayload = {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...directorInput,
    };
    return runRoleAgentLoop({
      role: "导演",
      contractVersion: VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION,
      criteria: [
        "视觉圣经与题材、观众承诺、模板和参考语法一致",
        "每镜头的动作、逐秒节拍、构图、声音与验收条件可真实执行",
        "素材 Provider、交付类型和能力约束完全匹配；方案费用可真实报价，费用反馈只作为重规划偏好",
        "相邻镜头连续性成立，生成式画面不被伪装为事实证据",
        "系列视觉母题、角色/声音锚点、canon 与前后集连续性得到保持",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session }) => this.client.runTaskDetailed("director-plan", {
        ...basePayload,
        ...(revision ? { revision } : {}),
      }, requestId, session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId, session }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: visualDirectorAuditContext(directorInput, candidate),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
      }, requestId, session),
      validate: (value) => validateVisualDirectorPlan(value, validationFor(input)),
      ...(agentLoopCheckpoint ? { checkpoint: agentLoopCheckpoint } : {}),
    });
  }
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
          "复用保持相同媒体内容，不会产生新的动作、光线变化或画面状态。",
        ],
      },
      assetProviders: input.assetProviders.map((provider) => ({
        id: provider.id,
        label: provider.label,
        billing: provider.billing,
        deliveryTypes: provider.deliveryTypes,
        strengths: provider.strengths,
        constraints: provider.constraints,
        estimatedCnyPerClip: provider.estimatedCnyPerClip,
      })),
      economics: input.economics,
    },
    downstreamBoundary: "审查镜头计划是否能被已声明 Provider 执行；不得要求当前节点提供尚未生成或下载的真实画面。",
  };
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
    estimatedCnyPerClip: Object.fromEntries(
      input.assetProviders.map((provider): [string, number] => [provider.id, provider.estimatedCnyPerClip]),
    ),
    economics: input.economics,
  };
}
