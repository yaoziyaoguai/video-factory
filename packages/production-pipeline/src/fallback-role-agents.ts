import type { CodexTaskExecution, ModelCandidateAttempt } from "./codex-chat.js";
import type { ScreenwriterAgent, ScreenwriterAgentInput } from "./codex-screenwriter.js";
import {
  failedModelCandidateAttempt,
  isModelProviderFailure,
  isProviderAccountFailure,
  isTransientRoleAuditProviderFailure,
  publicModelFailure,
} from "./model-fallback.js";
import type { AgentLoopTrace } from "./codex-chat.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import { RoleAgentPlanningHaltError } from "./role-agent-loop.js";
import type { CreativeTreatment } from "./creative-treatment.js";
import type { CreativeTreatmentAgent, CreativeTreatmentAgentInput } from "./codex-creative-treatment.js";
import type { BriefAuditAgent, BriefAuditAgentInput, BriefAuditCandidate } from "./codex-brief-audit.js";
import type { VisualDirectorAgent, VisualDirectorAgentInput } from "./visual-director.js";
import type { CreativeDiscussionAgentInput } from "./codex-creative-discussion.js";
import type { CreativeDiscussionResult } from "./creative-review.js";

interface RoleCandidate<TAgent> {
  agent: TAgent;
  providerId: string;
}

export interface FallbackScreenwriterAgentOptions {
  candidates: Array<RoleCandidate<ScreenwriterAgent>>;
  /**
   * 兼容保留的旧字段名：它只控制“新阶段准入窗口”，不是整个角色的硬 wall-clock 总耗时。
   * 默认 45 分钟仅在启动新候选/新 agent-loop stage 之前被检查；已交给 durable broker 的请求仍按
   * 客户端单次超时继续等待，不会被 Abort 强杀，也不会因此切换 Provider（at-most-once 优先）。
   */
  totalTimeoutMs?: number;
  now?: () => number;
}

export interface FallbackVisualDirectorAgentOptions {
  candidates: Array<RoleCandidate<VisualDirectorAgent>>;
  /**
   * 兼容保留的旧字段名：它只控制“新阶段准入窗口”，不是整个角色的硬 wall-clock 总耗时。
   * 默认 45 分钟仅在启动新候选/新 agent-loop stage 之前被检查；已交给 durable broker 的请求仍按
   * 客户端单次超时继续等待，不会被 Abort 强杀，也不会因此切换 Provider（at-most-once 优先）。
   */
  totalTimeoutMs?: number;
  now?: () => number;
}

export interface FallbackBriefAuditAgentOptions {
  candidates: Array<RoleCandidate<BriefAuditAgent>>;
  /** 与其它角色同义：只控制“新阶段准入窗口”，不截断已交给 durable broker 的同一 requestId。 */
  totalTimeoutMs?: number;
  now?: () => number;
}

export interface FallbackCreativeTreatmentAgentOptions {
  candidates: Array<RoleCandidate<CreativeTreatmentAgent>>;
  /**
   * 兼容保留的旧字段名：它只控制“新阶段准入窗口”，不是整个角色的硬 wall-clock 总耗时。
   * 默认 45 分钟仅在启动新候选/新 agent-loop stage 之前被检查；已交给 durable broker 的请求仍按
   * 客户端单次超时继续等待，不会被 Abort 强杀，也不会因此切换 Provider（at-most-once 优先）。
   */
  totalTimeoutMs?: number;
  now?: () => number;
}

// 默认的新阶段准入窗口（stage admission window）：只在启动新候选/新 agent-loop stage 前检查。
// xhigh/max 强推理的多轮生产+独立审计实测单轮即可达 4-6 分钟，660s 会把第二轮返修/审计挡在门外，
// 因此默认放宽到 45 分钟（2,700,000ms），覆盖多轮质量循环的整体启动预算。
// 它不截断已经交给 durable broker 的同一 requestId，也不是硬 SLA；真实耗时优化留给后续 trace 决策。
const DEFAULT_TEXT_AGENT_STAGE_ADMISSION_WINDOW_MS = 2_700_000;

export class ModelCandidatesExhaustedError extends Error {
  readonly attempts: ModelCandidateAttempt[];

  constructor(readonly failures: Array<{ modelId: string; providerId: string; error: unknown }>) {
    super(
      `${failures.length} 个候选模型调用未能完成：`
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
  private readonly stageAdmissionWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FallbackScreenwriterAgentOptions) {
    const first = validateCandidates(options.candidates, "screenwriter");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
    this.stageAdmissionWindowMs = positiveStageAdmissionWindow(options.totalTimeoutMs);
    this.now = options.now ?? Date.now;
  }

  async draft(input: ScreenwriterAgentInput): Promise<unknown> {
    return (await this.draftDetailed(input)).output;
  }

  async draftDetailed(input: ScreenwriterAgentInput): Promise<CodexTaskExecution<unknown>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => agent.draftDetailed
        ? agent.draftDetailed(candidateInput)
        : agent.draft(candidateInput).then((output) => ({ output })),
    );
  }

  async discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => {
        if (!agent.discussDetailed) throw new Error("Screenwriter discussion is not supported by this candidate.");
        return agent.discussDetailed(candidateInput);
      },
    ) as Promise<CodexTaskExecution<CreativeDiscussionResult>>;
  }
}

// 内容简报审计的模型候选路由：与构思/编剧同一 runCandidates 合同——selectedModelId 只改变候选顺序，
// Provider 故障按既有分类切换，schema/业务失败不切换；不新造第二套模型路由器。
// 走 runCandidates 而不是直接调 broker 是硬要求：它在执行没有 trace 时会抛（见下），
// 审计停在 awaiting_user 时同样必须带得回 trace，否则建议会连同执行回执一起丢掉。
export class FallbackBriefAuditAgent implements BriefAuditAgent {
  readonly id: string;
  readonly modelId: string;
  private readonly stageAdmissionWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FallbackBriefAuditAgentOptions) {
    const first = validateCandidates(options.candidates, "brief audit");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
    this.stageAdmissionWindowMs = positiveStageAdmissionWindow(options.totalTimeoutMs);
    this.now = options.now ?? Date.now;
  }

  async auditBrief(input: BriefAuditAgentInput): Promise<CodexTaskExecution<BriefAuditCandidate>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return await runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => agent.auditBrief(candidateInput),
    ) as CodexTaskExecution<BriefAuditCandidate>;
  }
}

// 前期构思的模型候选路由：与编剧/导演同一 runCandidates 合同——selectedModelId 只改变候选顺序，
// Provider 故障按既有分类切换，schema/业务/质量失败不切换；不新造第二套模型路由器。
export class FallbackCreativeTreatmentAgent implements CreativeTreatmentAgent {
  readonly id: string;
  readonly modelId: string;
  private readonly stageAdmissionWindowMs: number;
  private readonly now: () => number;
  private readonly providerIdByAgent: Map<CreativeTreatmentAgent, string>;

  constructor(private readonly options: FallbackCreativeTreatmentAgentOptions) {
    const first = validateCandidates(options.candidates, "creative treatment");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
    this.stageAdmissionWindowMs = positiveStageAdmissionWindow(options.totalTimeoutMs);
    this.now = options.now ?? Date.now;
    this.providerIdByAgent = new Map(options.candidates.map((candidate) => [candidate.agent, candidate.providerId]));
  }

  async treat(input: CreativeTreatmentAgentInput): Promise<CreativeTreatment> {
    return (await this.treatDetailed(input)).output as CreativeTreatment;
  }

  async treatDetailed(input: CreativeTreatmentAgentInput): Promise<CodexTaskExecution<CreativeTreatment>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return await runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => agent.treatDetailed
        ? agent.treatDetailed(candidateInput)
        : agent.treat(candidateInput).then((output: CreativeTreatment) => ({
          output,
          // 本地 treat() 适配没有 broker 侧 prompt 合同可引用；trace 只记录可核验的事实：
          // 该候选的 broker provider 与 model 确实执行了本次构思任务（与失败尝试记录的
          // providerId 同一含义），不伪造 prompt 版本。
          trace: {
            taskKind: "creative-treatment" as const,
            promptVersion: "local-treat-adapter",
            prompt: "",
            providerId: this.providerIdByAgent.get(agent) ?? agent.id,
            modelId: requiredModelId(agent),
          },
        })),
    ) as CodexTaskExecution<CreativeTreatment>;
  }

  async discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => {
        if (!agent.discussDetailed) throw new Error("Treatment discussion is not supported by this candidate.");
        return agent.discussDetailed(candidateInput);
      },
    ) as Promise<CodexTaskExecution<CreativeDiscussionResult>>;
  }
}

export class FallbackVisualDirectorAgent implements VisualDirectorAgent {
  readonly id: string;
  readonly modelId: string;
  private readonly stageAdmissionWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FallbackVisualDirectorAgentOptions) {
    const first = validateCandidates(options.candidates, "visual director");
    this.id = first.agent.id;
    this.modelId = requiredModelId(first.agent);
    this.stageAdmissionWindowMs = positiveStageAdmissionWindow(options.totalTimeoutMs);
    this.now = options.now ?? Date.now;
  }

  async plan(input: VisualDirectorAgentInput): Promise<unknown> {
    return (await this.planDetailed(input)).output;
  }

  async planDetailed(input: VisualDirectorAgentInput): Promise<CodexTaskExecution<unknown>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => agent.planDetailed
        ? agent.planDetailed(candidateInput)
        : agent.plan(candidateInput).then((output) => ({ output })),
    );
  }

  async discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
    const boundedInput = withStageAdmissionDeadline(input, this.stageAdmissionWindowMs, this.now);
    return runCandidates(
      this.options.candidates,
      input.selectedModelId,
      boundedInput,
      (agent, candidateInput) => {
        if (!agent.discussDetailed) throw new Error("Director discussion is not supported by this candidate.");
        return agent.discussDetailed(candidateInput);
      },
    ) as Promise<CodexTaskExecution<CreativeDiscussionResult>>;
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
  const unavailableProviderAccounts = new Set<string>();
  let resumeFrom: AgentLoopTrace | undefined;
  for (const [position, candidate] of ordered.entries()) {
    if (unavailableProviderAccounts.has(candidate.providerId)) continue;
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
      if (isProviderAccountFailure(error)) unavailableProviderAccounts.add(candidate.providerId);
      if (isTransientRoleAuditProviderFailure(error)) {
        // 仅当审计请求能明确归类为可安全切换的瞬时故障（not_accepted 或 completed transient）时，
        // 才允许带 checkpoint 切换审计 Provider；审计请求 outcome uncertain 时同样禁止切换。
        resumeFrom = error.agentLoop;
        if (position === ordered.length - 1) throw new ModelCandidatesExhaustedError(failures);
        continue;
      }
      // isModelProviderFailure 对 stage=uncertain 一律返回 false：请求可能已被 durable broker
      // 受理并仍在执行，绝不能用新的 backup requestId 启动下一个候选（双跑风险），原样上抛。
      // 规划停摆（缺少来源或需用户决定）同样原样上抛：候选已经产出且通过了独立审计，它不是
      // "这个模型没干成"，换模型也不会改变结论；折成候选失败会连同停摆原因一起丢掉整份构思，
      // 调用方 planningRoleHaltUpdate 拿不到它就无法把它转成创作者能处理的问题。
      if (error instanceof RoleAgentPlanningHaltError) throw error;
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

function positiveStageAdmissionWindow(value: number | undefined): number {
  const windowMs = value ?? DEFAULT_TEXT_AGENT_STAGE_ADMISSION_WINDOW_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("Text agent stage admission window (options.totalTimeoutMs) must be a positive integer.");
  }
  return windowMs;
}

// 新阶段准入截止（stage admission deadline）：写入输入的 wallClockDeadlineAtMs 字段（字段名保持不变）。
// 它只在启动新候选/新 agent-loop stage 之前被检查，不截断已交给 durable broker 的同一 requestId。
// deadline 在整个候选池共享：一个候选失败后，后续候选不得重新获得完整准入窗口。
function withStageAdmissionDeadline<TInput extends { wallClockDeadlineAtMs?: number }>(
  input: TInput,
  stageAdmissionWindowMs: number,
  now: () => number,
): TInput {
  const deadline = input.wallClockDeadlineAtMs ?? now() + stageAdmissionWindowMs;
  return { ...input, wallClockDeadlineAtMs: deadline };
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
