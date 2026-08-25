import { CodexBridgeClient } from "./codex-chat.js";
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

// 330s > broker 285s 任务 deadline：broker 先终止 codex，客户端拿到带上下文的终态错误且不重放。
const DEFAULT_DIRECTOR_TIMEOUT_MS = 330_000;
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
}

// VisualDirectorAgentInput 不携带 generative 标记；evidence 镜头禁用生成式 Provider 的硬门禁
// 仍由 directorNode 基于完整 capability 目录执行，这里负责结构、Provider 白名单、场景覆盖与预算校验。
function validationFor(input: VisualDirectorAgentInput): VisualDirectorPlanValidation {
  return {
    scenePositions: input.scenes.map((scene) => scene.position),
    allowedProviderIds: input.assetProviders.map((provider) => provider.id),
    generativeProviderIds: [],
    estimatedCnyPerClip: Object.fromEntries(
      input.assetProviders.map((provider): [string, number] => [provider.id, provider.estimatedCnyPerClip]),
    ),
    economics: input.economics,
  };
}
