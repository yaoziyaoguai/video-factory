import type { CodexTaskExecution, ModelCandidateAttempt } from "./codex-chat.js";
import type { ScreenwriterAgent, ScreenwriterAgentInput } from "./codex-screenwriter.js";
import {
  failedModelCandidateAttempt,
  isModelProviderFailure,
  isTransientRoleAuditProviderFailure,
  publicModelFailure,
} from "./model-fallback.js";
import type { AgentLoopTrace } from "./codex-chat.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { VisualDirectorAgent, VisualDirectorAgentInput } from "./visual-director.js";

interface RoleCandidate<TAgent> {
  agent: TAgent;
  providerId: string;
}

export interface FallbackScreenwriterAgentOptions {
  candidates: Array<RoleCandidate<ScreenwriterAgent>>;
}

export interface FallbackVisualDirectorAgentOptions {
  candidates: Array<RoleCandidate<VisualDirectorAgent>>;
}

export class ModelCandidatesExhaustedError extends Error {
  readonly attempts: ModelCandidateAttempt[];

  constructor(readonly failures: Array<{ modelId: string; providerId: string; error: unknown }>) {
    super(
      `${failures.length} 个候选模型均未能完成：`
      + failures.map((failure, index) => `${index + 1}. ${failure.modelId} ${publicModelFailure(failure.error)}`).join("；")
      + "。",
      failures.at(-1)?.error instanceof Error ? { cause: failures.at(-1)!.error } : undefined,
    );
    this.name = "ModelCandidatesExhaustedError";
    this.attempts = failures.map((failure) => failedModelCandidateAttempt(
      failure.error,
      failure.modelId,
      failure.providerId,
    ));
  }
}

export class FallbackScreenwriterAgent implements ScreenwriterAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: FallbackScreenwriterAgentOptions) {
    const first = validateCandidates(options.candidates, "screenwriter");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
  }

  async draft(input: ScreenwriterAgentInput): Promise<unknown> {
    return (await this.draftDetailed(input)).output;
  }

  async draftDetailed(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>> {
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      input,
      (agent, candidateInput) => agent.draftDetailed
        ? agent.draftDetailed(candidateInput)
        : agent.draft(candidateInput).then((output) => ({ output })),
    );
  }
}

export class FallbackVisualDirectorAgent implements VisualDirectorAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: FallbackVisualDirectorAgentOptions) {
    const first = validateCandidates(options.candidates, "visual director");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
  }

  async plan(input: VisualDirectorAgentInput): Promise<unknown> {
    return (await this.planDetailed(input)).output;
  }

  async planDetailed(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<unknown>> {
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      input,
      (agent, candidateInput) => agent.planDetailed
        ? agent.planDetailed(candidateInput)
        : agent.plan(candidateInput).then((output) => ({ output })),
    );
  }
}

async function runCandidates<
  TAgent extends { id: string; modelId?: string },
  TInput extends {
    selectedModelId?: string;
    agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
    agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  },
>(
  candidates: Array<RoleCandidate<TAgent>>,
  selectedModelId: string | undefined,
  input: TInput,
  execute: (agent: TAgent, input: TInput) => Promise<CodexTaskExecution<unknown>>,
): Promise<CodexTaskExecution<unknown>> {
  const ordered = orderCandidates(candidates, selectedModelId);
  const failures: Array<{ modelId: string; providerId: string; error: unknown }> = [];
  let resumeFrom: AgentLoopTrace | undefined;
  for (const [position, candidate] of ordered.entries()) {
    const modelId = requiredModelId(candidate.agent);
    const candidateInput = inputForCandidate(input, modelId, position, resumeFrom);
    try {
      const execution = await execute(candidate.agent, candidateInput);
      if (!execution.trace) {
        throw new Error(`Model candidate '${modelId}' completed without an immutable execution trace.`);
      }
      const recoveredAuditTrace = resumeFrom
        ? execution.agentLoop?.iterations.at(-1)?.auditTrace
        : undefined;
      const resultTrace = recoveredAuditTrace ?? execution.trace;
      const actualModelIds = resultTrace.attemptedModelIds ?? [resultTrace.modelId];
      return {
        ...execution,
        trace: {
          ...resultTrace,
          ...(position > 0 ? {
            fallbackFromModelId: requiredModelId(ordered[0]!.agent),
            fallbackReason: resumeFrom
              ? "首选模型的独立审计暂时失败，已保留候选并切换兼容审计模型。"
              : `前 ${position} 个候选模型调用失败，已自动切换。`,
          } : {}),
          attemptedModelIds: [...new Set([
            ...failures.map((failure) => failure.modelId),
            ...actualModelIds,
          ])],
          modelCandidateAttempts: [
            ...failures.map((failure) => failedModelCandidateAttempt(
              failure.error,
              failure.modelId,
              failure.providerId,
            )),
            {
              modelId: resultTrace.modelId,
              providerId: resultTrace.providerId,
              outcome: "succeeded" as const,
            },
          ],
        },
      };
    } catch (error) {
      failures.push({ modelId: requiredModelId(candidate.agent), providerId: candidate.providerId, error });
      if (isTransientRoleAuditProviderFailure(error)) {
        resumeFrom = error.agentLoop;
        if (position === ordered.length - 1) throw new ModelCandidatesExhaustedError(failures);
        continue;
      }
      if (!isModelProviderFailure(error)) {
        if (failures.length > 1) throw new ModelCandidatesExhaustedError(failures);
        throw error;
      }
      if (position === ordered.length - 1) throw new ModelCandidatesExhaustedError(failures);
    }
  }
  throw new ModelCandidatesExhaustedError(failures);
}

function orderCandidates<TAgent extends { modelId?: string }>(
  candidates: Array<RoleCandidate<TAgent>>,
  selectedModelId: string | undefined,
): Array<RoleCandidate<TAgent>> {
  if (!selectedModelId) return [...candidates];
  const selected = candidates.find((candidate) => requiredModelId(candidate.agent) === selectedModelId);
  if (!selected) throw new Error(`Selected model '${selectedModelId}' is not available for this role.`);
  return [selected, ...candidates.filter((candidate) => candidate !== selected)];
}

function validateCandidates<TAgent extends { id: string; modelId?: string }>(
  candidates: Array<RoleCandidate<TAgent>>,
  role: string,
): RoleCandidate<TAgent> {
  const first = candidates[0];
  if (!first) throw new Error(`${role} requires at least one model candidate.`);
  if (candidates.some((candidate) => candidate.agent.id !== first.agent.id)) {
    throw new Error(`${role} model candidates must expose the same role provider id.`);
  }
  if (new Set(candidates.map((candidate) => requiredModelId(candidate.agent))).size !== candidates.length) {
    throw new Error(`${role} model candidates must use distinct model ids.`);
  }
  if (candidates.some((candidate) => !candidate.providerId.trim())) {
    throw new Error(`${role} model candidates must include an explicit broker provider id.`);
  }
  return first;
}

function requiredModelId(agent: { modelId?: string }): string {
  const modelId = agent.modelId?.trim();
  if (!modelId) throw new Error("Model fallback candidate is missing its model id.");
  return modelId;
}

function inputForCandidate<TInput extends {
  selectedModelId?: string;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
}>(input: TInput, modelId: string, position: number, resumeFrom?: AgentLoopTrace): TInput {
  const {
    selectedModelId: _selectedModelId,
    agentLoopCheckpoint: primaryCheckpoint,
    agentLoopCheckpointForModel,
    ...rest
  } = input;
  const baseCheckpoint = agentLoopCheckpointForModel?.(modelId)
    ?? (position === 0 ? primaryCheckpoint : undefined);
  const checkpoint = resumeFrom
    ? auditFallbackCheckpoint(baseCheckpoint, modelId, resumeFrom)
    : baseCheckpoint;
  return {
    ...rest,
    ...(checkpoint ? { agentLoopCheckpoint: checkpoint } : {}),
  } as TInput;
}

function auditFallbackCheckpoint(
  checkpoint: RoleAgentLoopCheckpoint | undefined,
  modelId: string,
  resumeFrom: AgentLoopTrace,
): RoleAgentLoopCheckpoint {
  if (checkpoint) {
    return {
      key: checkpoint.key,
      ...(checkpoint.restartExhausted !== undefined ? { restartExhausted: checkpoint.restartExhausted } : {}),
      resumeFrom,
      load: () => checkpoint.load(),
      save: (value) => checkpoint.save(value),
    };
  }
  let stored: unknown;
  return {
    key: `audit-fallback:${modelId}:${resumeFrom.pendingCandidate!.candidateHash}`,
    resumeFrom,
    load: async () => stored,
    save: async (value) => { stored = structuredClone(value); },
  };
}
