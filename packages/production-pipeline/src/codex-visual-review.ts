import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CodexBridgeClient, CodexTaskExecution, ModelCandidateAttempt } from "./codex-chat.js";
import {
  failedModelCandidateAttempt,
  fallbackRequestId,
  isModelProviderFailure,
  publicModelFailure,
} from "./model-fallback.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export const VISUAL_REVIEW_AGENT_CONTRACT_VERSION = "visual-review-v5|role-audit-v1|visual-review-validator-v1";

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
    mode: "scene_triplets" | "hook_and_scene_midpoints" | "scene_change_keyframes";
    sceneCount?: number;
    coveredScenePositions?: number[];
    missingScenePositions?: number[];
  };
  reviewContext?: Record<string, unknown>;
}

export interface VisualReviewAgentInput {
  videoPath: string;
  runRoot: string;
  scriptPath?: string;
  directorPlanPath?: string;
  renderManifestPath?: string;
  requestId?: string;
  selectedModelId?: string;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
}

export interface VisualReviewMediaPreprocessor {
  prepare(input: {
    videoPath: string;
    runRoot: string;
    renderManifestPath?: string;
  }): Promise<VisualReviewMediaPayload>;
}

export type VisualReviewExecution = CodexTaskExecution<VisualReviewReport> & {
  requestId?: string;
  inspectedDurationMs?: number;
  sampling?: VisualReviewMediaPayload["sampling"];
  executedProviderId?: string;
  executedProviderLabel?: string;
  executedModelId?: string;
  fallbackFromProviderId?: string;
  fallbackReason?: string;
  attemptedModelIds?: string[];
};

export interface VisualReviewFinding {
  timecodeMs: number;
  scenePosition?: number;
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
    for (const [position, candidate] of candidates.entries()) {
      const candidateInput = visualReviewInputForCandidate(input, candidate.agent.modelId, position);
      try {
        const execution = await runVisualReviewAgent(candidate.agent, candidateInput);
        if (!execution.trace) {
          throw new Error(`Visual review model candidate '${candidate.agent.modelId}' completed without an immutable execution trace.`);
        }
        const executedProviderId = execution.trace?.providerId ?? candidate.agent.id;
        const executedModelId = execution.trace?.modelId ?? candidate.agent.modelId;
        const modelCandidateAttempts = [
          ...failures.map((failure) => failedModelCandidateAttempt(
            failure.error,
            failure.modelId,
            failure.providerId,
          )),
          ...(execution.trace?.modelCandidateAttempts ?? [{
            modelId: executedModelId,
            providerId: executedProviderId,
            outcome: "succeeded" as const,
          }]),
        ];
        const attemptedModelIds = [...new Set([
          ...failures.map((failure) => failure.modelId),
          ...(execution.trace?.attemptedModelIds ?? [executedModelId]),
        ])];
        return {
          ...execution,
          executedProviderId,
          ...(candidate.label ? { executedProviderLabel: candidate.label } : {}),
          executedModelId,
          ...(position > 0 ? {
            fallbackFromProviderId: candidates[0]!.providerId,
            fallbackReason: `前 ${position} 个候选模型调用失败，已自动切换到 ${executedModelId}。`,
          } : {}),
          attemptedModelIds,
          ...(execution.trace ? {
            trace: {
              ...execution.trace,
              ...(position > 0 ? {
                fallbackFromModelId: candidates[0]!.agent.modelId,
                fallbackReason: `前 ${position} 个候选模型调用失败，已自动切换。`,
              } : {}),
              attemptedModelIds,
              modelCandidateAttempts,
            },
          } : {}),
        };
      } catch (error) {
        failures.push({ modelId: candidate.agent.modelId, providerId: candidate.providerId, error });
        if (!(this.options.shouldFallback ?? isModelProviderFailure)(error)) throw error;
        if (position === candidates.length - 1) throw new VisualReviewFallbackError(failures);
      }
    }
    throw new VisualReviewFallbackError(failures);
  }
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
    const client = this.options.client;
    const requestId = normalizedRequestId(input.requestId);
    if (typeof client.runTaskDetailed !== "function") {
      return {
        output: validateVisualReviewReport(await client.runTask("visual-review", payload, requestId), payload.durationMs),
        ...(requestId ? { requestId } : {}),
        inspectedDurationMs: payload.durationMs,
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
        "每条问题必须由对应时间码的画面证据支持，不得把稀疏关键帧看不到的声音或连续运动当作已证事实",
        "逐项核对脚本可见动作、导演成功条件、镜头时长与渲染清单，不得只凭整体观感打分",
        "构图、连续性、节奏、可读性和安全五项评分必须与 findings 的严重程度及 recommendation 自洽",
        "抽样覆盖不足、缺帧或上下文缺失必须降低 confidence 并明确证据边界，不得虚构画面细节",
        "审片报告只判断当前成片并给出可执行修复建议；不得擅自改写脚本、导演方案或掩盖需要人工终审的问题",
      ],
      maxIterations: this.maxReviewIterations,
      ...(this.options.maxProducerCalls ? { maxPhaseAttempts: { produce: this.options.maxProducerCalls } } : {}),
      produce: (revision, operation) => runProducerTask("visual-review", {
        ...payload,
        ...(revision ? { revision } : {}),
      }, operation.requestId, this.options.producerSessionMode === "stateless" ? undefined : operation.session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId: auditRequestId, session }) => runAuditTask("role-audit", {
        role,
        iteration,
        criteria,
        context: visualReviewAuditContext(payload),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        images: payload.frames.map((frame, index) => ({
          imageIndex: index + 1,
          sha256: frame.sha256,
          jpegBase64: frame.jpegBase64,
          ...(frame.scenePosition !== undefined ? { scenePosition: frame.scenePosition } : {}),
          ...(frame.timecodeMs !== undefined ? { timecodeMs: frame.timecodeMs } : {}),
          ...(frame.phase ? { phase: frame.phase } : {}),
        })),
      }, auditRequestId, session),
      validate: (value) => validateVisualReviewReport(value, payload.durationMs),
      ...(checkpoint ? { checkpoint } : {}),
    });
    return {
      output: execution.output,
      ...(requestId ? { requestId } : {}),
      inspectedDurationMs: payload.durationMs,
      ...(sampling ? { sampling } : {}),
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    };
  }

  private async preparePayload(input: VisualReviewAgentInput): Promise<{
    payload: VisualReviewMediaPayload;
    sampling?: VisualReviewMediaPayload["sampling"];
  }> {
    const media = await this.options.media.prepare(input);
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
): VisualReviewAgentInput {
  const {
    selectedModelId: _selectedModelId,
    agentLoopCheckpoint: primaryCheckpoint,
    agentLoopCheckpointForModel,
    ...inputWithoutCheckpoint
  } = input;
  const checkpoint = agentLoopCheckpointForModel?.(modelId)
    ?? (position === 0 ? primaryCheckpoint : undefined);
  return {
    ...inputWithoutCheckpoint,
    ...(input.requestId
      ? { requestId: position === 0 ? input.requestId : fallbackRequestId(input.requestId, modelId, position) }
      : {}),
    ...(checkpoint ? { agentLoopCheckpoint: checkpoint } : {}),
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
  ]);
  const [script, directorPlan, renderManifest] = entries;
  if (!script && !directorPlan && !renderManifest && !sampling) return undefined;
  const context = {
    ...(sampling ? { sampling: {
      ...sampling,
      phases: sampling.mode === "scene_triplets" ? ["opening", "middle", "closing"] : sampling.mode === "hook_and_scene_midpoints" ? ["hook", "midpoint"] : ["keyframe"],
      evidenceBoundary: sampling.mode === "scene_triplets"
        ? "Triplets can show state progression; audio and frame-to-frame smoothness are reviewed separately."
        : "Sparse samples do not prove per-scene state progression, audio, or frame-to-frame smoothness.",
    } } : {}),
    ...(script ? { script: compactScript(script) } : {}),
    ...(directorPlan ? { directorPlan: compactDirectorPlan(directorPlan) } : {}),
    ...(renderManifest ? { renderManifest: compactRenderManifest(renderManifest) } : {}),
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

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function validateVisualReviewReport(value: unknown, durationMs: number): VisualReviewReport {
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
    const category = enumValue(finding.category, ["composition", "continuity", "pacing", "legibility", "safety", "other"] as const, "category");
    const severity = enumValue(finding.severity, ["info", "warning", "critical"] as const, "severity");
    const scenePosition = finding.scenePosition;
    if (scenePosition !== undefined && (!Number.isInteger(scenePosition) || Number(scenePosition) < 1)) {
      throw new Error("Visual review finding scene position is invalid.");
    }
    return {
      timecodeMs: Number(timecodeMs),
      ...(scenePosition !== undefined ? { scenePosition: Number(scenePosition) } : {}),
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
  if (requested === "reject" || findings.some((finding) => finding.severity === "critical")) return "reject";
  const minimumScore = Math.min(...Object.values(scores));
  if (
    requested === "revise"
    || findings.some((finding) => finding.severity === "warning")
    || minimumScore < 75
    || confidence < 0.7
  ) return "revise";
  return "approve";
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
