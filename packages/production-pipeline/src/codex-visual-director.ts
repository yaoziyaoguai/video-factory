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
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_DIRECTOR_TIMEOUT_MS = 660_000;
const DEFAULT_DIRECTOR_MAX_ATTEMPTS = 2;
export const VISUAL_DIRECTOR_AGENT_CONTRACT_VERSION = "director-v6|role-audit-v1|director-validator-v1";

// id 保持 api-visual-director-v1：历史 run 的 brief 持久化了该 id，ProductionPipeline.createRegistry 按 id 匹配 provider。
export class CodexVisualDirectorAgent implements VisualDirectorAgent {
  readonly id = "api-visual-director-v1";
  private readonly client: CodexBridgeClient;
  private readonly maxReviewIterations: number;

  constructor(options: CodexVisualDirectorAgentOptions) {
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
        "素材 Provider、交付类型、能力约束和成本上限完全匹配",
        "相邻镜头连续性成立，生成式画面不被伪装为事实证据",
        "系列视觉母题、角色/声音锚点、canon 与前后集连续性得到保持",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId }) => this.client.runTaskDetailed("director-plan", {
        ...basePayload,
        ...(revision ? { revision } : {}),
      }, requestId),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"],
            doesNotOwn: ["素材实际下载结果", "生成模型最终画面", "配音成品", "渲染与审片结果"],
          },
          upstreamFacts: {
            brief: directorInput.brief,
            scenes: directorInput.scenes,
          },
          currentRoleContract: {
            directorProfiles: VISUAL_DIRECTOR_PROFILES,
            assetProviders: directorInput.assetProviders,
            economics: directorInput.economics,
          },
          downstreamBoundary: "审查镜头计划是否能被已声明 Provider 执行；不得要求当前节点提供尚未生成或下载的真实画面。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
      }, requestId),
      validate: (value) => validateVisualDirectorPlan(value, validationFor(input)),
      ...(agentLoopCheckpoint ? { checkpoint: agentLoopCheckpoint } : {}),
    });
  }
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
