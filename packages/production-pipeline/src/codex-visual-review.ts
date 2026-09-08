import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentLoopTrace, CodexBridgeClient, CodexTaskExecution, ModelCandidateAttempt } from "./codex-chat.js";
import {
  failedModelCandidateAttempt,
  fallbackRequestId,
  isModelProviderFailure,
  isTransientRoleAuditProviderFailure,
  publicModelFailure,
} from "./model-fallback.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export const VISUAL_REVIEW_AGENT_CONTRACT_VERSION = "visual-review-v11|role-audit-v1|visual-review-validator-v4|evidence-state-v2|pilot-scope-v2";

export interface VisualReviewFramePayload {
  timecodeMs: number;
  sha256: string;
  jpegBase64: string;
  scenePosition?: number;
  phase?: "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe";
}

export interface VisualReviewMediaPayload {
  durationMs: number;
  frames: VisualReviewFramePayload[];
  sampling?: {
    mode: "scene_triplets" | "scene_sequence" | "hook_and_scene_midpoints" | "scene_change_keyframes";
    sceneCount?: number;
    coveredScenePositions?: number[];
    missingScenePositions?: number[];
  };
  reviewContext?: Record<string, unknown>;
}

export interface VisualReviewAgentInput {
  videoPath?: string;
  assetPlanPath?: string;
  reviewStage?: "source_assets" | "rendered_video";
  scenePositions?: number[];
  runRoot: string;
  scriptPath?: string;
  directorPlanPath?: string;
  renderManifestPath?: string;
  requestId?: string;
  selectedModelId?: string;
  preparedMedia?: VisualReviewMediaPayload;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  independentReviewCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
}

export interface IndependentVisualReviewExecution {
  providerId: string;
  modelId: string;
  output: VisualReviewReport;
  trace?: CodexTaskExecution<VisualReviewReport>["trace"];
  agentLoop?: AgentLoopTrace;
}

export interface VisualReviewMediaPreprocessor {
  prepare(input: {
    videoPath?: string;
    assetPlanPath?: string;
    runRoot: string;
    renderManifestPath?: string;
    scenePositions?: number[];
    scriptPath?: string;
  }): Promise<VisualReviewMediaPayload>;
}

export type VisualReviewExecution = CodexTaskExecution<VisualReviewReport> & {
  requestId?: string;
  inspectedDurationMs?: number;
  evidenceSnapshotId?: string;
  sampling?: VisualReviewMediaPayload["sampling"];
  executedProviderId?: string;
  executedProviderLabel?: string;
  executedModelId?: string;
  fallbackFromProviderId?: string;
  fallbackReason?: string;
  attemptedModelIds?: string[];
  independentReviews?: IndependentVisualReviewExecution[];
};

export interface VisualReviewFinding {
  timecodeMs: number;
  startTimecodeMs: number;
  endTimecodeMs: number;
  scenePosition?: number;
  targetNodeId?: "script" | "visual-direction" | "assets";
  evidenceStatus: "satisfied" | "failed" | "not_observed" | "not_applicable";
  evidenceFrameSha256: string | null;
  nextAction: "inspect_existing_media" | "replan_upstream" | "rework_asset" | "none";
  category: "composition" | "continuity" | "pacing" | "legibility" | "safety" | "other";
  severity: "info" | "warning" | "critical";
  description: string;
  suggestion: string;
}

export interface VisualReviewReport {
  version: "video-factory/visual-review-v1";
  summary: string;
  scores: { composition: number; continuity: number; pacing: number; legibility: number; safety: number };
  findings: VisualReviewFinding[];
  confidence: number;
  recommendation: "approve" | "revise" | "reject";
  reviewScope?: VisualReviewScope;
  independentReviews?: Array<{
    providerId: string;
    modelId: string;
    report: VisualReviewReport;
  }>;
}

export interface VisualReviewScope {
  reviewStage: "source_assets" | "rendered_video";
  evidenceId: string;
  sourceNodeIds: string[];
  sourceArtifactIds: string[];
  scenePositions: number[];
  timelineDurationMs: number;
  actualModels: Array<{
    providerId: string;
    modelId: string;
    evidenceId?: string;
    producerContractDigest?: string;
    auditContractDigest?: string;
    producerCompleted?: boolean;
    auditCompleted?: boolean;
  }>;
  current?: boolean;
}

export interface VisualReviewAgent {
  id: string;
  modelId: string;
  review(input: VisualReviewAgentInput): Promise<VisualReviewReport>;
  reviewDetailed?(input: VisualReviewAgentInput): Promise<VisualReviewExecution>;
}

export interface CodexVisualReviewAgentOptions {
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed">>;
  auditClient?: Pick<CodexBridgeClient, "runTaskDetailed">;
  media: VisualReviewMediaPreprocessor;
  providerId?: string;
  modelId?: string;
  maxReviewIterations?: number;
  producerSessionMode?: "stateful" | "stateless";
  maxProducerCalls?: number;
}

export interface FallbackVisualReviewAgentOptions {
  primary: VisualReviewAgent;
  primaryProviderId: string;
  backups: Array<{ agent: VisualReviewAgent; label?: string; providerId: string }>;
  shouldFallback?: (error: unknown) => boolean;
}

export interface IndependentDualVisualReviewAgentOptions {
  primary: VisualReviewAgent;
  secondary: VisualReviewAgent;
  media: VisualReviewMediaPreprocessor;
  sourceAgent?: VisualReviewAgent;
}

export class VisualReviewFallbackError extends Error {
  readonly attempts: ModelCandidateAttempt[];

  constructor(readonly failures: Array<{ modelId: string; providerId: string; error: unknown }>) {
    super(
      `视觉审片的 ${failures.length} 个候选模型均未能完成：`
      + failures.map((failure, index) => `${index + 1}. ${failure.modelId} ${publicModelFailure(failure.error)}`).join("；")
      + "。",
      failures.at(-1)?.error instanceof Error ? { cause: failures.at(-1)!.error } : undefined,
    );
    this.name = "VisualReviewFallbackError";
    this.attempts = failures.map((failure) => failedModelCandidateAttempt(
      failure.error,
      failure.modelId,
      failure.providerId,
    ));
  }
}

export class FallbackVisualReviewAgent implements VisualReviewAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: FallbackVisualReviewAgentOptions) {
    if (options.backups.length === 0) throw new Error("Visual review fallback requires at least one backup candidate.");
    if (![options.primaryProviderId, ...options.backups.map(({ providerId }) => providerId)].every((providerId) => providerId.trim())) {
      throw new Error("Visual review candidates must include an explicit broker provider id.");
    }
    if (new Set([options.primary.modelId, ...options.backups.map(({ agent }) => agent.modelId)]).size !== options.backups.length + 1) {
      throw new Error("Visual review fallback candidates must use distinct models.");
    }
    this.id = options.primary.id;
    this.modelId = options.primary.modelId;
  }

  async review(input: VisualReviewAgentInput): Promise<VisualReviewReport> {
    return (await this.reviewDetailed(input)).output;
  }

  async reviewDetailed(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
    const configuredCandidates = [
      {
        agent: this.options.primary,
        providerId: this.options.primaryProviderId,
      },
      ...this.options.backups,
    ];
    const candidates = orderVisualReviewCandidates(configuredCandidates, input.selectedModelId);
    const failures: Array<{ modelId: string; providerId: string; error: unknown }> = [];
    let resumeFrom: AgentLoopTrace | undefined;
    for (const [position, candidate] of candidates.entries()) {
      const candidateInput = visualReviewInputForCandidate(input, candidate.agent.modelId, position, resumeFrom);
      try {
        const execution = await runVisualReviewAgent(candidate.agent, candidateInput);
        if (!execution.trace) {
          throw new Error(`Visual review model candidate '${candidate.agent.modelId}' completed without an immutable execution trace.`);
        }
        const recoveredAuditTrace = resumeFrom
          ? execution.agentLoop?.iterations.at(-1)?.auditTrace
          : undefined;
        if (resumeFrom && !recoveredAuditTrace) {
          throw new Error(`Visual review audit fallback model '${candidate.agent.modelId}' completed without an immutable audit trace.`);
        }
        const resultTrace = recoveredAuditTrace ?? execution.trace;
        const executedProviderId = resultTrace.providerId ?? candidate.agent.id;
        const executedModelId = resultTrace.modelId ?? candidate.agent.modelId;
        const modelCandidateAttempts = [
          ...failures.map((failure) => failedModelCandidateAttempt(
            failure.error,
            failure.modelId,
            failure.providerId,
          )),
          ...(resultTrace.modelCandidateAttempts ?? [{
            modelId: executedModelId,
            providerId: executedProviderId,
            outcome: "succeeded" as const,
          }]),
        ];
        const attemptedModelIds = [...new Set([
          ...failures.map((failure) => failure.modelId),
          ...(resultTrace.attemptedModelIds ?? [executedModelId]),
        ])];
        return {
          ...execution,
          executedProviderId,
          ...(candidate.label ? { executedProviderLabel: candidate.label } : {}),
          executedModelId,
          ...(position > 0 ? {
            fallbackFromProviderId: candidates[0]!.providerId,
            fallbackReason: resumeFrom
              ? `独立审计暂时失败，已保留审片候选并切换到 ${executedModelId}。`
              : `前 ${position} 个候选模型调用失败，已自动切换到 ${executedModelId}。`,
          } : {}),
          attemptedModelIds,
          trace: {
            ...resultTrace,
            ...(position > 0 ? {
              fallbackFromModelId: candidates[0]!.agent.modelId,
              fallbackReason: resumeFrom
                ? "首选模型的独立审计暂时失败，已保留审片候选并切换兼容审计模型。"
                : `前 ${position} 个候选模型调用失败，已自动切换。`,
            } : {}),
            attemptedModelIds,
            modelCandidateAttempts,
          },
        };
      } catch (error) {
        failures.push({ modelId: candidate.agent.modelId, providerId: candidate.providerId, error });
        if (isTransientRoleAuditProviderFailure(error)) {
          if (this.options.shouldFallback && !this.options.shouldFallback(error)) throw error;
          resumeFrom = error.agentLoop;
          if (position === candidates.length - 1) throw new VisualReviewFallbackError(failures);
          continue;
        }
        if (!(this.options.shouldFallback ?? isModelProviderFailure)(error)) throw error;
        if (position === candidates.length - 1) throw new VisualReviewFallbackError(failures);
      }
    }
    throw new VisualReviewFallbackError(failures);
  }
}

// 最终成片由两个不同模型各自完成首评和独立审计；这里只做确定性汇总，不引入第三个融合模型。
export class IndependentDualVisualReviewAgent implements VisualReviewAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: IndependentDualVisualReviewAgentOptions) {
    if (options.primary.id === options.secondary.id || options.primary.modelId === options.secondary.modelId) {
      throw new Error("Independent visual review requires two distinct providers and models.");
    }
    this.id = options.primary.id;
    this.modelId = options.primary.modelId;
  }

  async review(input: VisualReviewAgentInput): Promise<VisualReviewReport> {
    return (await this.reviewDetailed(input)).output;
  }

  async reviewDetailed(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
    if (input.reviewStage === "source_assets") {
      return runVisualReviewAgent(this.options.sourceAgent ?? this.options.primary, input);
    }
    const preparedMedia = input.preparedMedia ?? await this.options.media.prepare(input);
    const evidenceSnapshotId = visualEvidenceSnapshotId(preparedMedia);
    const agents = [this.options.primary, this.options.secondary];
    const settled = await Promise.allSettled(agents.map(async (agent) => {
      const resultCheckpoint = input.independentReviewCheckpointForModel?.(agent.modelId);
      const cached = resultCheckpoint
        ? cachedIndependentVisualReview(
            await resultCheckpoint.load(),
            agent,
            evidenceSnapshotId,
            preparedMedia,
            input.scenePositions,
          )
        : undefined;
      if (cached) return cached;
      const execution = await runVisualReviewAgent(agent, {
        ...input,
        preparedMedia,
        selectedModelId: agent.modelId,
        ...(input.requestId ? { requestId: `${input.requestId}:${agent.id}` } : {}),
        ...(input.agentLoopCheckpointForModel
          ? { agentLoopCheckpoint: input.agentLoopCheckpointForModel(agent.modelId) }
          : {}),
      });
      const validated = {
        ...execution,
        output: validateVisualReviewReport(
          execution.output,
          preparedMedia.durationMs,
          input.scenePositions,
          preparedMedia.frames,
        ),
      };
      await resultCheckpoint?.save({
        version: "video-factory/independent-visual-review-result-v1",
        contractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
        providerId: agent.id,
        modelId: agent.modelId,
        evidenceSnapshotId,
        execution: validated,
      });
      return validated;
    }));
    const failures = settled.flatMap((result, index) => result.status === "rejected"
      ? [{ providerId: agents[index]!.id, modelId: agents[index]!.modelId, error: result.reason }]
      : []);
    const completedReviews = settled.flatMap((result, index): IndependentVisualReviewExecution[] => {
      if (result.status !== "fulfilled") return [];
      return [{
        providerId: result.value.executedProviderId ?? result.value.trace?.providerId ?? agents[index]!.id,
        modelId: result.value.executedModelId ?? result.value.trace?.modelId ?? agents[index]!.modelId,
        output: result.value.output,
        ...(result.value.trace ? { trace: result.value.trace } : {}),
        ...(result.value.agentLoop ? { agentLoop: result.value.agentLoop } : {}),
      }];
    });
    if (failures.length) {
      throw new IndependentVisualReviewError(failures, completedReviews);
    }
    const executions = settled.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Independent visual review branch did not complete.");
      return result.value;
    });
    const independentReviews = executions.map((execution, index): IndependentVisualReviewExecution => ({
      providerId: execution.executedProviderId ?? execution.trace?.providerId ?? agents[index]!.id,
      modelId: execution.executedModelId ?? execution.trace?.modelId ?? agents[index]!.modelId,
      output: execution.output,
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    }));
    if (new Set(independentReviews.map((review) => review.providerId)).size !== 2
      || new Set(independentReviews.map((review) => review.modelId)).size !== 2) {
      throw new IndependentVisualReviewError([
        {
          providerId: independentReviews[1]?.providerId ?? agents[1]!.id,
          modelId: independentReviews[1]?.modelId ?? agents[1]!.modelId,
          error: new Error("最终审片的两个分支落到了同一个实际 Provider 或模型，不能作为独立双审。"),
        },
      ], independentReviews);
    }
    return {
      output: mergeIndependentVisualReviews(independentReviews),
      inspectedDurationMs: preparedMedia.durationMs,
      evidenceSnapshotId,
      ...(preparedMedia.sampling ? { sampling: preparedMedia.sampling } : {}),
      attemptedModelIds: independentReviews.map((review) => review.modelId),
      independentReviews,
    };
  }
}

function visualEvidenceSnapshotId(media: VisualReviewMediaPayload): string {
  return createHash("sha256").update(JSON.stringify({
    contractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
    durationMs: media.durationMs,
    frames: media.frames.map(({ timecodeMs, sha256, scenePosition, phase }, index) => ({
      frameIndex: index + 1,
      timecodeMs,
      sha256,
      ...(scenePosition !== undefined ? { scenePosition } : {}),
      ...(phase ? { phase } : {}),
    })),
    sampling: media.sampling,
    reviewContext: media.reviewContext,
  })).digest("hex");
}

function cachedIndependentVisualReview(
  value: unknown,
  agent: VisualReviewAgent,
  evidenceSnapshotId: string,
  media: VisualReviewMediaPayload,
  scenePositions?: readonly number[],
): VisualReviewExecution | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cache = value as Record<string, unknown>;
  if (cache.version !== "video-factory/independent-visual-review-result-v1"
    || cache.contractVersion !== VISUAL_REVIEW_AGENT_CONTRACT_VERSION
    || cache.providerId !== agent.id
    || cache.modelId !== agent.modelId
    || cache.evidenceSnapshotId !== evidenceSnapshotId
    || typeof cache.execution !== "object"
    || cache.execution === null
    || Array.isArray(cache.execution)) return undefined;
  const execution = cache.execution as VisualReviewExecution;
  try {
    return {
      ...execution,
      output: validateVisualReviewReport(execution.output, media.durationMs, scenePositions, media.frames),
    };
  } catch {
    return undefined;
  }
}

export class IndependentVisualReviewError extends Error {
  constructor(
    readonly failures: Array<{ providerId: string; modelId: string; error: unknown }>,
    readonly completedReviews: IndependentVisualReviewExecution[] = [],
  ) {
    super(
      `最终双模型审片尚未完成：${failures.map((failure) => `${failure.modelId} ${publicModelFailure(failure.error)}`).join("；")}。重试只会继续未完成的模型分支。`,
      failures.at(-1)?.error instanceof Error ? { cause: failures.at(-1)!.error } : undefined,
    );
    this.name = "IndependentVisualReviewError";
  }
}

function mergeIndependentVisualReviews(reviews: IndependentVisualReviewExecution[]): VisualReviewReport {
  const scores = {
    composition: Math.min(...reviews.map((review) => review.output.scores.composition)),
    continuity: Math.min(...reviews.map((review) => review.output.scores.continuity)),
    pacing: Math.min(...reviews.map((review) => review.output.scores.pacing)),
    legibility: Math.min(...reviews.map((review) => review.output.scores.legibility)),
    safety: Math.min(...reviews.map((review) => review.output.scores.safety)),
  };
  const findings = deduplicateVisualReviewFindings(reviews.flatMap((review) => review.output.findings));
  const requestedRecommendation = reviews.some((review) => review.output.recommendation === "reject")
    ? "reject"
    : reviews.some((review) => review.output.recommendation === "revise") ? "revise" : "approve";
  const confidence = Math.min(...reviews.map((review) => review.output.confidence));
  return {
    version: "video-factory/visual-review-v1",
    summary: reviews.map((review) => `${review.modelId}：${review.output.summary}`).join("；"),
    scores,
    findings,
    confidence,
    recommendation: normalizeRecommendation(requestedRecommendation, scores, findings, confidence),
  };
}

function deduplicateVisualReviewFindings(findings: VisualReviewFinding[]): VisualReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify({
      startTimecodeMs: finding.startTimecodeMs,
      endTimecodeMs: finding.endTimecodeMs,
      scenePosition: finding.scenePosition,
      targetNodeId: finding.targetNodeId,
      evidenceStatus: finding.evidenceStatus,
      evidenceFrameSha256: finding.evidenceFrameSha256,
      category: finding.category,
      description: finding.description,
      suggestion: finding.suggestion,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class CodexVisualReviewAgent implements VisualReviewAgent {
  readonly id: string;
  readonly modelId: string;
  private readonly maxReviewIterations: number;

  constructor(private readonly options: CodexVisualReviewAgentOptions) {
    this.id = options.providerId ?? "codex-visual-review-v1";
    this.modelId = options.modelId ?? "codex-default";
    this.maxReviewIterations = options.maxReviewIterations ?? 3;
  }

  async review(input: VisualReviewAgentInput): Promise<VisualReviewReport> {
    return (await this.reviewDetailed(input)).output;
  }

  async reviewDetailed(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
    if (input.selectedModelId && input.selectedModelId !== this.modelId) {
      throw new Error(`Selected model '${input.selectedModelId}' is not available for visual review.`);
    }
    const { payload, sampling } = await this.preparePayload(input);
    const evidenceSnapshotId = visualEvidenceSnapshotId(payload);
    const client = this.options.client;
    const requestId = normalizedRequestId(input.requestId);
    if (typeof client.runTaskDetailed !== "function") {
      return {
        output: validateVisualReviewReport(
          await client.runTask("visual-review", payload, requestId),
          payload.durationMs,
          input.scenePositions,
          payload.frames,
        ),
        ...(requestId ? { requestId } : {}),
        inspectedDurationMs: payload.durationMs,
        evidenceSnapshotId,
        ...(sampling ? { sampling } : {}),
      };
    }
    const runProducerTask = client.runTaskDetailed.bind(client);
    const runAuditTask = this.options.auditClient
      ? this.options.auditClient.runTaskDetailed.bind(this.options.auditClient)
      : runProducerTask;
    const checkpoint = input.agentLoopCheckpoint ?? requestScopedCheckpoint(requestId);
    const execution = await runRoleAgentLoop<VisualReviewReport>({
      role: "视觉审片员",
      contractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
      criteria: [
        "每条问题必须由对应时间码的画面证据支持；scene_sequence 的相邻时间点可以支持可见状态推进与近似保持时长，稀疏关键帧看不到的声音或连续运动不得当作已证事实",
        "逐项核对脚本可见动作、导演成功条件、镜头时长与渲染清单，不得只凭整体观感打分",
        "核心主体、物体或动作对象与对应镜头要求不符时必须判定返修；环境相似不能代替目标物体，并须定位到具体镜头与 assets 或 visual-direction",
        "先区分真实来源原生文字、正式 editorial_card、render manifest 明确的后期文字，以及生成伪标签/乱码/水印/内部术语；前三类按准确性与可读性审查，后一类必须阻断",
        "模糊不可读且与核心内容无关的痕迹只能标为 not_observed 并补查已有素材，不得凭猜测直接要求付费返工",
        "当 reviewContext.reviewStage=source_assets 时，画面尚未叠加主字幕或 AIGC 披露；正式 editorial_card 和可追溯来源原生文字可以存在，生成伪文字、水印、比例标记或内部工作流术语必须阻断进入渲染",
        "当 reviewContext.pilotScenePositions 存在时，只审这些已生成镜头的主体、动作、构图与禁文字条件；其余镜头尚未付费生成，不得把它们的缺帧判为缺陷，也不得宣称全片连续性或整体节奏已经通过",
        "构图、连续性、节奏、可读性和安全五项评分必须与 findings 的 evidenceStatus、严重程度及 recommendation 自洽；通过门槛为五项均不低于 75 且 confidence 不低于 0.7",
        "每条 finding 必须给出镜号、证据帧或时间范围和下一步；failed 才能进入上游重规划或素材返工，not_observed 只能先补查已有素材",
        "核心论证依赖同一人物、物件或空间，而当前 Provider 无参考图、母片复用等能力无法保证跨镜一致时，必须把方案缺陷指向 visual-direction 或 script 并使用 replan_upstream；上游免责声明不能将其降级为 satisfied，也不得只指向 assets 重复付费",
        "抽样覆盖不足、缺帧或上下文缺失必须降低 confidence 并明确证据边界，不得虚构画面细节",
        "审片报告只判断当前成片并给出可执行修复建议；不得擅自改写脚本、导演方案或掩盖需要人工终审的问题",
      ],
      maxIterations: this.maxReviewIterations,
      ...(this.options.maxProducerCalls ? { maxPhaseAttempts: { produce: this.options.maxProducerCalls } } : {}),
      produce: (revision, operation) => runProducerTask("visual-review", {
        ...payload,
        ...(revision ? { revision } : {}),
      }, operation.requestId, this.options.producerSessionMode === "stateless" ? undefined : operation.session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId: auditRequestId }) => runAuditTask("role-audit", {
        role,
        iteration,
        criteria,
        context: visualReviewAuditContext(payload),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
        images: payload.frames.map((frame, index) => ({
          imageIndex: index + 1,
          sha256: frame.sha256,
          jpegBase64: frame.jpegBase64,
          ...(frame.scenePosition !== undefined ? { scenePosition: frame.scenePosition } : {}),
          ...(frame.timecodeMs !== undefined ? { timecodeMs: frame.timecodeMs } : {}),
          ...(frame.phase ? { phase: frame.phase } : {}),
        })),
      // 审计请求已经自包含候选、证据帧与合同；不要求 Provider 创建可续写会话。
      }, auditRequestId, undefined),
      validate: (value) => validateVisualReviewReport(value, payload.durationMs, input.scenePositions, payload.frames),
      ...(checkpoint ? { checkpoint } : {}),
    });
    return {
      output: execution.output,
      ...(requestId ? { requestId } : {}),
      inspectedDurationMs: payload.durationMs,
      evidenceSnapshotId,
      ...(sampling ? { sampling } : {}),
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    };
  }

  private async preparePayload(input: VisualReviewAgentInput): Promise<{
    payload: VisualReviewMediaPayload;
    sampling?: VisualReviewMediaPayload["sampling"];
  }> {
    const media = input.preparedMedia ?? await this.options.media.prepare(input);
    const { sampling, ...boundedMedia } = media;
    const reviewContext = await buildReviewContext(input, sampling);
    return {
      payload: { ...boundedMedia, ...(reviewContext ? { reviewContext } : {}) },
      ...(sampling ? { sampling } : {}),
    };
  }
}

function requestScopedCheckpoint(requestId: string | undefined): RoleAgentLoopCheckpoint | undefined {
  if (!requestId) return undefined;
  return {
    key: requestId,
    load: async () => undefined,
    save: async () => undefined,
  };
}

function visualReviewAuditContext(payload: VisualReviewMediaPayload): Record<string, unknown> {
  return {
    roleScope: {
      owns: ["summary", "scores", "findings", "confidence", "recommendation"],
      doesNotOwn: ["脚本内容", "导演方案", "素材选择", "配音", "渲染产物"],
    },
    currentRoleContract: "必须区分上游方案不可执行与单次素材偶发未命中。上游免责声明不能把不可执行方案变成可执行方案；前者必须回流 script 或 visual-direction 并 replan_upstream，不得只指向 assets 重复付费。",
    evidence: {
      durationMs: payload.durationMs,
      frames: payload.frames.map(({ jpegBase64: _jpegBase64, ...frame }) => frame),
      ...(payload.reviewContext ? { reviewContext: payload.reviewContext } : {}),
    },
    downstreamBoundary: "独立审计只验证审片报告是否忠于成片证据；即使成片应返修，准确给出 revise 或 reject 的报告仍可通过本角色审计。",
  };
}

function normalizedRequestId(value: string | undefined): string | undefined {
  return value ? `visual-${createHash("sha256").update(value).digest("hex")}` : undefined;
}

async function runVisualReviewAgent(
  agent: VisualReviewAgent,
  input: VisualReviewAgentInput,
): Promise<VisualReviewExecution> {
  return agent.reviewDetailed
    ? agent.reviewDetailed(input)
    : { output: await agent.review(input) };
}

function orderVisualReviewCandidates(
  candidates: Array<{ agent: VisualReviewAgent; label?: string; providerId: string }>,
  selectedModelId: string | undefined,
): Array<{ agent: VisualReviewAgent; label?: string; providerId: string }> {
  if (!selectedModelId) return candidates;
  const selected = candidates.find((candidate) => candidate.agent.modelId === selectedModelId);
  if (!selected) throw new Error(`Selected model '${selectedModelId}' is not available for visual review.`);
  return [selected, ...candidates.filter((candidate) => candidate !== selected)];
}

function visualReviewInputForCandidate(
  input: VisualReviewAgentInput,
  modelId: string,
  position: number,
  resumeFrom?: AgentLoopTrace,
): VisualReviewAgentInput {
  const {
    selectedModelId: _selectedModelId,
    agentLoopCheckpoint: primaryCheckpoint,
    agentLoopCheckpointForModel,
    ...inputWithoutCheckpoint
  } = input;
  const baseCheckpoint = agentLoopCheckpointForModel?.(modelId)
    ?? (position === 0 ? primaryCheckpoint : undefined);
  const checkpoint = resumeFrom
    ? visualReviewAuditFallbackCheckpoint(baseCheckpoint, modelId, resumeFrom)
    : baseCheckpoint;
  return {
    ...inputWithoutCheckpoint,
    ...(input.requestId
      ? { requestId: position === 0 ? input.requestId : fallbackRequestId(input.requestId, modelId, position) }
      : {}),
    ...(checkpoint ? { agentLoopCheckpoint: checkpoint } : {}),
  };
}

function visualReviewAuditFallbackCheckpoint(
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
    key: `visual-audit-fallback:${modelId}:${resumeFrom.pendingCandidate!.candidateHash}`,
    resumeFrom,
    load: async () => stored,
    save: async (value) => { stored = structuredClone(value); },
  };
}

async function buildReviewContext(
  input: VisualReviewAgentInput,
  sampling?: VisualReviewMediaPayload["sampling"],
): Promise<Record<string, unknown> | undefined> {
  const entries = await Promise.all([
    input.scriptPath ? readRunJson(input.runRoot, input.scriptPath, "script") : undefined,
    input.directorPlanPath ? readRunJson(input.runRoot, input.directorPlanPath, "director plan") : undefined,
    input.renderManifestPath ? readRunJson(input.runRoot, input.renderManifestPath, "render manifest") : undefined,
    input.assetPlanPath ? readRunJson(input.runRoot, input.assetPlanPath, "asset plan") : undefined,
  ]);
  const [script, directorPlan, renderManifest, assetPlan] = entries;
  if (!script && !directorPlan && !renderManifest && !assetPlan && !sampling && !input.reviewStage) return undefined;
  const context = {
    ...(input.reviewStage ? { reviewStage: input.reviewStage } : {}),
    ...(input.scenePositions ? { pilotScenePositions: input.scenePositions } : {}),
    ...(input.reviewStage === "source_assets" ? { renderConform: {
      policy: "scale_to_fill_center_crop",
      outputAspectRatio: "9:16",
      reviewRule: "A minor source aspect-ratio difference is normalized before render and is not itself an asset defect. Only require asset rework when the deterministic center crop would remove a required subject, action, or text-safe area.",
    } } : {}),
    ...(sampling ? { sampling: {
      ...sampling,
      phases: sampling.mode === "scene_triplets" || sampling.mode === "scene_sequence"
        ? ["opening", "middle", "closing"]
        : sampling.mode === "hook_and_scene_midpoints" ? ["hook", "midpoint"] : ["keyframe"],
      evidenceBoundary: sampling.mode === "scene_triplets"
        ? "Triplets can show state progression; audio and frame-to-frame smoothness are reviewed separately."
        : sampling.mode === "scene_sequence"
          ? "Dense ordered samples can support visible state progression and approximate hold timing; frames between samples, audio, and absolute motion smoothness are reviewed separately."
        : "Sparse samples do not prove per-scene state progression, audio, or frame-to-frame smoothness.",
    } } : {}),
    ...(script ? { script: compactScript(script) } : {}),
    ...(directorPlan ? { directorPlan: compactDirectorPlan(directorPlan) } : {}),
    ...(renderManifest ? { renderManifest: compactRenderManifest(renderManifest) } : {}),
    ...(assetPlan ? { assetPlan: compactAssetPlan(assetPlan) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > 128 * 1024) {
    throw new Error("Visual review context exceeds 131072 bytes after compaction.");
  }
  return context;
}

async function readRunJson(runRoot: string, sourcePath: string, label: string): Promise<Record<string, unknown>> {
  const [root, target] = await Promise.all([realpath(runRoot), realpath(sourcePath)]);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Visual review ${label} is outside the run directory.`);
  }
  const content = await readFile(target, "utf8");
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) {
    throw new Error(`Visual review ${label} exceeds 524288 bytes.`);
  }
  const parsed = JSON.parse(content) as unknown;
  return record(parsed, `visual review ${label}`);
}

function compactScript(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["title", "viewerPromise", "narrativeArc", "hook", "duration_target", "platform_notes", "scenes"]);
}

function compactDirectorPlan(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]);
}

function compactRenderManifest(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["title", "duration_target", "resolution", "slides", "visual_quality", "probe", "aigc"]);
}

function compactAssetPlan(value: Record<string, unknown>): Record<string, unknown> {
  const sceneAssets = Array.isArray(value.scene_assets)
    ? value.scene_assets.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const asset = item as Record<string, unknown>;
      const directorShot = typeof asset.director_shot === "object"
        && asset.director_shot !== null
        && !Array.isArray(asset.director_shot)
        ? pick(asset.director_shot as Record<string, unknown>, [
            "scenePosition", "preferredProviderId", "deliveryType",
          ])
        : undefined;
      return [{
        ...pick(asset, [
          "scene_position", "provider", "provider_id", "asset_id", "media_type", "width", "height",
          "duration", "query", "reuse_from_scene_position", "preferred_provider_id",
        ]),
        ...(directorShot && Object.keys(directorShot).length ? { director_shot: directorShot } : {}),
      }];
    })
    : [];
  const directorRouting = Array.isArray(value.director_routing)
    ? value.director_routing.flatMap((item) => typeof item === "object" && item !== null && !Array.isArray(item)
      ? [pick(item as Record<string, unknown>, [
          "scene_position", "actual_provider_id", "requested_media_type", "query", "reuse_from_scene_position",
        ])]
      : [])
    : [];
  return { scene_assets: sceneAssets, ...(directorRouting.length ? { director_routing: directorRouting } : {}) };
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function validateVisualReviewReport(
  value: unknown,
  durationMs: number,
  scenePositions?: readonly number[],
  evidenceFrames?: readonly VisualReviewFramePayload[],
): VisualReviewReport {
  const report = record(value, "visual review");
  if (report.version !== "video-factory/visual-review-v1") throw new Error("Visual review version is invalid.");
  const scores = record(report.scores, "visual review scores");
  const parsedScores = {
    composition: score(scores.composition, "composition"),
    continuity: score(scores.continuity, "continuity"),
    pacing: score(scores.pacing, "pacing"),
    legibility: score(scores.legibility, "legibility"),
    safety: score(scores.safety, "safety"),
  };
  if (!Array.isArray(report.findings) || report.findings.length > 50) throw new Error("Visual review findings are invalid.");
  const findings = report.findings.map((item, index): VisualReviewFinding => {
    const finding = record(item, `visual review finding ${index}`);
    const timecodeMs = finding.timecodeMs;
    if (!Number.isInteger(timecodeMs) || Number(timecodeMs) < 0 || Number(timecodeMs) > durationMs) throw new Error("Visual review finding timecode is invalid.");
    const startTimecodeMs = finding.startTimecodeMs;
    const endTimecodeMs = finding.endTimecodeMs;
    if (!Number.isInteger(startTimecodeMs) || !Number.isInteger(endTimecodeMs)
      || Number(startTimecodeMs) < 0 || Number(endTimecodeMs) > durationMs
      || Number(startTimecodeMs) > Number(timecodeMs) || Number(timecodeMs) > Number(endTimecodeMs)) {
      throw new Error("Visual review finding time range is invalid.");
    }
    const category = enumValue(finding.category, ["composition", "continuity", "pacing", "legibility", "safety", "other"] as const, "category");
    const severity = enumValue(finding.severity, ["info", "warning", "critical"] as const, "severity");
    const scenePosition = finding.scenePosition;
    if (!Number.isInteger(scenePosition) || Number(scenePosition) < 1) {
      throw new Error("Visual review finding scene position is invalid.");
    }
    if (scenePositions && !scenePositions.includes(Number(scenePosition))) {
      throw new Error("试片报告包含未检查镜头的问题，请重新检查当前试片。");
    }
    const targetNodeId = enumValue(finding.targetNodeId, ["script", "visual-direction", "assets"] as const, "targetNodeId");
    const evidenceStatus = enumValue(
      finding.evidenceStatus,
      ["satisfied", "failed", "not_observed", "not_applicable"] as const,
      "evidenceStatus",
    );
    const nextAction = enumValue(
      finding.nextAction,
      ["inspect_existing_media", "replan_upstream", "rework_asset", "none"] as const,
      "nextAction",
    );
    const evidenceFrameSha256 = finding.evidenceFrameSha256;
    if (evidenceFrameSha256 !== null
      && (typeof evidenceFrameSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidenceFrameSha256))) {
      throw new Error("Visual review finding evidence frame is invalid.");
    }
    if (evidenceFrameSha256 !== null && evidenceFrames) {
      const matchingFrames = evidenceFrames.filter((candidate) => (
        candidate.sha256 === evidenceFrameSha256
        && candidate.timecodeMs === Number(timecodeMs)
        && candidate.scenePosition === Number(scenePosition)
        && candidate.timecodeMs >= Number(startTimecodeMs)
        && candidate.timecodeMs <= Number(endTimecodeMs)
      ));
      if (matchingFrames.length !== 1) {
        throw new Error("Visual review finding evidence frame is invalid.");
      }
    }
    assertFindingEvidenceContract(evidenceStatus, severity, nextAction);
    return {
      timecodeMs: Number(timecodeMs),
      startTimecodeMs: Number(startTimecodeMs),
      endTimecodeMs: Number(endTimecodeMs),
      scenePosition: Number(scenePosition),
      targetNodeId,
      evidenceStatus,
      evidenceFrameSha256,
      nextAction,
      category,
      severity,
      description: text(finding.description, "description"),
      suggestion: text(finding.suggestion, "suggestion"),
    };
  });
  const confidence = report.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Visual review confidence is invalid.");
  const requestedRecommendation = enumValue(
    report.recommendation,
    ["approve", "revise", "reject"] as const,
    "recommendation",
  );
  return {
    version: "video-factory/visual-review-v1",
    summary: text(report.summary, "summary"),
    scores: parsedScores,
    findings,
    confidence,
    recommendation: normalizeRecommendation(requestedRecommendation, parsedScores, findings, confidence),
  };
}

function normalizeRecommendation(
  requested: VisualReviewReport["recommendation"],
  scores: VisualReviewReport["scores"],
  findings: VisualReviewFinding[],
  confidence: number,
): VisualReviewReport["recommendation"] {
  if (requested === "reject" || findings.some((finding) => finding.evidenceStatus === "failed" && finding.severity === "critical")) return "reject";
  const minimumScore = Math.min(...Object.values(scores));
  if (
    requested === "revise"
    || findings.some((finding) => finding.evidenceStatus === "failed" || finding.evidenceStatus === "not_observed")
    || minimumScore < 75
    || confidence < 0.7
  ) return "revise";
  return "approve";
}

function assertFindingEvidenceContract(
  status: VisualReviewFinding["evidenceStatus"],
  severity: VisualReviewFinding["severity"],
  nextAction: VisualReviewFinding["nextAction"],
): void {
  if (status === "failed") {
    if (severity === "info" || (nextAction !== "replan_upstream" && nextAction !== "rework_asset")) {
      throw new Error("Visual review failed evidence must describe actionable rework.");
    }
    return;
  }
  if (status === "not_observed") {
    if (severity !== "info" || nextAction !== "inspect_existing_media") {
      throw new Error("Visual review not_observed evidence must request inspection of existing media.");
    }
    return;
  }
  if (severity !== "info" || nextAction !== "none") {
    throw new Error("Visual review non-failing evidence cannot request rework.");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function score(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) throw new Error(`Visual review ${label} score is invalid.`);
  return Number(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Visual review ${label} is invalid.`);
  return value.trim();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Visual review ${label} is invalid.`);
  return value as T;
}
