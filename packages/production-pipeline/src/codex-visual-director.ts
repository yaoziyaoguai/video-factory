import { CodexBridgeClient, type CodexTaskExecution } from "./codex-chat.js";
import {
  VISUAL_DIRECTOR_PROFILES,
  validateVisualDirectorPlan,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type VisualDirectorPlan,
  type VisualDirectorPlanValidation,
} from "./visual-director.js";

export interface CodexVisualDirectorAgentOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_DIRECTOR_TIMEOUT_MS = 660_000;
const DEFAULT_DIRECTOR_MAX_ATTEMPTS = 2;

// id 保持 api-visual-director-v1：历史 run 的 brief 持久化了该 id，ProductionPipeline.createRegistry 按 id 匹配 provider。
export class CodexVisualDirectorAgent implements VisualDirectorAgent {
  readonly id = "api-visual-director-v1";
  private readonly client: CodexBridgeClient;

  constructor(options: CodexVisualDirectorAgentOptions) {
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
    const rawPlan = await this.client.runTask("director-plan", {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...input,
    });
    return validateVisualDirectorPlan(rawPlan, validationFor(input));
  }

  async planDetailed(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<VisualDirectorPlan>> {
    const execution = await this.client.runTaskDetailed("director-plan", {
      directorProfiles: VISUAL_DIRECTOR_PROFILES,
      ...input,
    });
    return {
      output: validateVisualDirectorPlan(execution.output, validationFor(input)),
      ...(execution.trace ? { trace: execution.trace } : {}),
    };
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
