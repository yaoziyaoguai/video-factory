import {
  CodexBridgeClient,
  CodexBridgeError,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskSession,
  type ModelCandidateAttempt,
} from "./codex-chat.js";
import { ModelCandidatesExhaustedError } from "./fallback-role-agents.js";
import {
  failedModelCandidateAttempt,
  fallbackRequestId,
  isModelProviderFailure,
} from "./model-fallback.js";

export interface FallbackTaskClientCandidate {
  client: CodexBridgeClient;
  providerId: string;
  modelId: string;
  taskKinds: readonly string[];
  taskModels?: Partial<Record<CodexTaskKind, string>>;
  sessionMode?: "stateful" | "stateless";
}

export interface FallbackTaskClientOptions {
  candidates: FallbackTaskClientCandidate[];
}

// 继续继承既有客户端类型，避免每个角色各自实现一遍切换；网络发送始终委托给候选客户端。
export class FallbackCodexTaskClient extends CodexBridgeClient {
  private readonly candidates: FallbackTaskClientCandidate[];
  private readonly sessionAffinity = new Map<string, string>();

  constructor(options: FallbackTaskClientOptions) {
    super({ socketPath: "/fallback-task-client-does-not-send" });
    if (options.candidates.length < 1) throw new Error("Task fallback requires at least one client candidate.");
    if (new Set(options.candidates.map((candidate) => candidate.providerId)).size !== options.candidates.length) {
      throw new Error("Task fallback candidates must use distinct provider ids.");
    }
    this.candidates = [...options.candidates];
  }

  override async runTask(kind: CodexTaskKind, payload: unknown, requestId?: string): Promise<unknown> {
    return (await this.runTaskDetailed(kind, payload, requestId)).output;
  }

  override async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId?: string,
    session?: CodexTaskSession,
  ): Promise<CodexTaskExecution> {
    const available = this.candidates.filter((candidate) => candidate.taskKinds.includes(kind));
    if (available.length === 0) {
      throw new CodexBridgeError(`No healthy model provider supports '${kind}'.`, false, "not_accepted");
    }
    const affinityProviderId = session ? this.sessionAffinity.get(session.key) : undefined;
    const ordered = affinityProviderId
      ? [
          ...available.filter((candidate) => candidate.providerId === affinityProviderId),
          ...available.filter((candidate) => candidate.providerId !== affinityProviderId),
        ]
      : available;
    const failures: Array<{ modelId: string; providerId: string; error: unknown }> = [];
    for (const [position, candidate] of ordered.entries()) {
      const modelId = modelForTask(candidate, kind);
      const candidateRequestId = requestId && position > 0
        ? fallbackRequestId(requestId, `${candidate.providerId}:${modelId}`, position)
        : requestId;
      const candidateSession = session && candidate.sessionMode !== "stateless"
        ? {
            key: session.key,
            ...(affinityProviderId === candidate.providerId && session.handle ? { handle: session.handle } : {}),
          }
        : undefined;
      try {
        const execution = await candidate.client.runTaskDetailed(kind, payload, candidateRequestId, candidateSession);
        if (session) this.rememberAffinity(session.key, candidate.providerId);
        return failures.length > 0 ? withFallbackTrace(execution, failures, modelId, candidate.providerId) : execution;
      } catch (error) {
        failures.push({ modelId, providerId: candidate.providerId, error });
        if (!isModelProviderFailure(error)) {
          if (failures.length > 1) throw new ModelCandidatesExhaustedError(failures);
          throw error;
        }
        if (position === ordered.length - 1) throw new ModelCandidatesExhaustedError(failures);
      }
    }
    throw new ModelCandidatesExhaustedError(failures);
  }

  private rememberAffinity(sessionKey: string, providerId: string): void {
    this.sessionAffinity.set(sessionKey, providerId);
    if (this.sessionAffinity.size > 1_000) {
      this.sessionAffinity.delete(this.sessionAffinity.keys().next().value as string);
    }
  }
}

function modelForTask(candidate: FallbackTaskClientCandidate, kind: CodexTaskKind): string {
  return candidate.taskModels?.[kind]?.trim() || candidate.modelId.trim() || "unknown-model";
}

function withFallbackTrace(
  execution: CodexTaskExecution,
  failures: Array<{ modelId: string; providerId: string; error: unknown }>,
  modelId: string,
  providerId: string,
): CodexTaskExecution {
  if (!execution.trace) return execution;
  const failedAttempts = failures.map((failure) => failedModelCandidateAttempt(
    failure.error,
    failure.modelId,
    failure.providerId,
  ));
  const successfulAttempts: ModelCandidateAttempt[] = execution.trace.modelCandidateAttempts ?? [{
    modelId: execution.trace.modelId || modelId,
    providerId: execution.trace.providerId || providerId,
    outcome: "succeeded",
  }];
  return {
    ...execution,
    trace: {
      ...execution.trace,
      fallbackFromModelId: failures[0]!.modelId,
      fallbackReason: `前 ${failures.length} 个模型服务调用失败，已自动切换。`,
      attemptedModelIds: [...new Set([
        ...failures.map((failure) => failure.modelId),
        ...(execution.trace.attemptedModelIds ?? [execution.trace.modelId || modelId]),
      ])],
      modelCandidateAttempts: [...failedAttempts, ...successfulAttempts],
    },
  };
}
