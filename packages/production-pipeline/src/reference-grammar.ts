import type { CodexBridgeClient, CodexPreparedOperation, CodexTaskExecution } from "./codex-chat.js";
import type { VisualReviewMediaPayload, VisualReviewMediaPreprocessor } from "./codex-visual-review.js";
import { pendingRoleAgentOperation } from "./role-agent-checkpoint.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export interface ReferenceGrammarBeat {
  startMs: number;
  endMs: number;
  narrativeFunction: string;
  shotSize: string;
  composition: string;
  cameraMovement: string;
  subjectMovement: string;
  lighting: string;
  color: string;
  transitionIn: string;
  soundRole: string;
}

export interface ShotGrammar {
  version: "video-factory/shot-grammar-v1";
  summary: string;
  durationMs: number;
  pacing: string;
  composition: string;
  camera: string;
  color: string;
  transitions: string;
  sound: string;
  beats: ReferenceGrammarBeat[];
  reusableRules: string[];
  avoidCopying: string[];
  confidence: number;
  fallbackReason?: string;
}

export interface ReferenceGrammarAgentInput {
  videoPath: string;
  runRoot: string;
  sourceLabel: string;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
}

export interface ReferenceGrammarExecution extends CodexTaskExecution<ShotGrammar> {
  inspectedDurationMs?: number;
}

export interface ReferenceGrammarAgent {
  readonly id: string;
  readonly modelId: string;
  analyze(input: ReferenceGrammarAgentInput): Promise<ShotGrammar>;
  analyzeDetailed?(input: ReferenceGrammarAgentInput): Promise<ReferenceGrammarExecution>;
}

export interface CodexReferenceGrammarAgentOptions {
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">>;
  media: VisualReviewMediaPreprocessor;
  providerId?: string;
  modelId?: string;
  maxReviewIterations?: number;
}

export const REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION = "reference-grammar-v2|role-audit-v3|shot-grammar-validator-v1";

export class CodexReferenceGrammarAgent implements ReferenceGrammarAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: CodexReferenceGrammarAgentOptions) {
    this.id = options.providerId ?? "codex-reference-grammar-v1";
    this.modelId = options.modelId ?? "codex-default";
  }

  async analyze(input: ReferenceGrammarAgentInput): Promise<ShotGrammar> {
    const payload = await this.payload(input);
    return validateShotGrammar(await this.options.client.runTask("reference-grammar", payload), payload.durationMs);
  }

  async analyzeDetailed(input: ReferenceGrammarAgentInput): Promise<ReferenceGrammarExecution> {
    const client = this.options.client;
    if (typeof client.runTaskDetailed !== "function") {
      const payload = await this.payload(input);
      return { output: validateShotGrammar(await client.runTask("reference-grammar", payload), payload.durationMs), inspectedDurationMs: payload.durationMs };
    }
    const runTaskDetailed = client.runTaskDetailed.bind(client);
    const observePrepared = typeof client.observePrepared === "function" ? client.observePrepared.bind(client) : undefined;
    const pendingOperation = await pendingRoleAgentOperation(input.agentLoopCheckpoint, ["reference-grammar", "role-audit"]);
    let resolvedPayload = pendingOperation ? recoveredReferenceGrammarPayload(pendingOperation, input.sourceLabel) : undefined;
    const payload = async (): Promise<VisualReviewMediaPayload & { sourceLabel: string }> => (
      resolvedPayload ??= await this.payload(input)
    );
    const execution = await runRoleAgentLoop<ShotGrammar>({
      role: "参考片分析师",
      contractVersion: REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION,
      criteria: [
        "节拍时间有序、互不重叠，并覆盖被观察视频的主要叙事结构",
        "静帧不能证明的连续运动和声音被明确降置信，而不是写成确定事实",
        "只提炼节奏、构图、运镜、色彩、转场与声音功能等抽象语法",
        "avoidCopying 明确排除人物身份、对白、品牌、独特情节和标志性资产",
      ],
      maxIterations: this.options.maxReviewIterations ?? 3,
      produce: async (revision, { requestId, session, requestOptions, preparedOperation }) => {
        if (preparedOperation) {
          if (!observePrepared) throw new Error("Codex reference grammar cannot recover a prepared operation with this client.");
          return observePrepared(preparedOperation, requestOptions);
        }
        const taskPayload = await payload();
        return runTaskDetailed("reference-grammar", {
          ...taskPayload,
          ...(revision ? { revision } : {}),
        }, requestId, session, requestOptions);
      },
      audit: async ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => {
        if (preparedOperation) {
          if (!observePrepared) throw new Error("Codex reference grammar cannot recover a prepared audit with this client.");
          return observePrepared(preparedOperation, requestOptions);
        }
        const taskPayload = await payload();
        return runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["summary", "pacing", "composition", "camera", "color", "transitions", "sound", "beats", "reusableRules", "avoidCopying", "confidence"],
            doesNotOwn: ["新视频脚本", "新视频镜头方案", "参考视频版权结论"],
          },
          upstreamFacts: {
            durationMs: taskPayload.durationMs,
            sourceLabel: taskPayload.sourceLabel,
            frames: taskPayload.frames.map((frame, index) => ({
              imageIndex: index + 1,
              timecodeMs: frame.timecodeMs,
              sha256: frame.sha256,
              ...(frame.scenePosition !== undefined ? { scenePosition: frame.scenePosition } : {}),
              ...(frame.phase ? { phase: frame.phase } : {}),
            })),
          },
          currentRoleContract: { evidenceType: "sampled_keyframes", continuousMotionAndAudioAreNotProven: true },
          downstreamBoundary: "只提炼可复用的抽象风格规则，不得复刻人物、对白、品牌、独特情节或要求后续画面已经生成。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
        images: taskPayload.frames.map((frame, index) => ({
          imageIndex: index + 1,
          timecodeMs: frame.timecodeMs,
          sha256: frame.sha256,
          jpegBase64: frame.jpegBase64,
          ...(frame.scenePosition !== undefined ? { scenePosition: frame.scenePosition } : {}),
          ...(frame.phase ? { phase: frame.phase } : {}),
        })),
        }, requestId, session, requestOptions);
      },
      validate: (value) => validateShotGrammar(value, resolvedPayload?.durationMs ?? grammarDuration(value)),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
    return {
      output: execution.output,
      inspectedDurationMs: resolvedPayload?.durationMs ?? execution.output.durationMs,
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    };
  }

  private async payload(input: ReferenceGrammarAgentInput): Promise<VisualReviewMediaPayload & { sourceLabel: string }> {
    const media = await this.options.media.prepare({ videoPath: input.videoPath, runRoot: input.runRoot });
    return { durationMs: media.durationMs, frames: media.frames, sourceLabel: input.sourceLabel };
  }
}

function recoveredReferenceGrammarPayload(
  operation: CodexPreparedOperation,
  fallbackSourceLabel: string,
): (VisualReviewMediaPayload & { sourceLabel: string }) | undefined {
  const envelopePayload = record(operation.envelope.payload, "saved reference-grammar payload");
  const source = operation.kind === "reference-grammar"
    ? envelopePayload
    : record(record(envelopePayload.context, "saved reference audit context").upstreamFacts, "saved reference audit facts");
  const rawFrames = operation.kind === "reference-grammar" ? source.frames : envelopePayload.images;
  if (!Array.isArray(rawFrames)) return undefined;
  const durationMs = integer(source.durationMs, "saved reference durationMs", 1, Number.MAX_SAFE_INTEGER);
  const frames = rawFrames.map((value, index) => {
    const frame = record(value, `saved reference frame ${index}`);
    const phase = frame.phase;
    if (phase !== undefined && !["opening", "middle", "closing", "hook", "midpoint", "keyframe"].includes(String(phase))) {
      throw new Error("Saved reference frame phase is invalid.");
    }
    return {
      timecodeMs: integer(frame.timecodeMs, `saved reference frame ${index} timecodeMs`, 0, durationMs),
      sha256: text(frame.sha256, `saved reference frame ${index} sha256`),
      jpegBase64: text(frame.jpegBase64, `saved reference frame ${index} jpegBase64`),
      ...(frame.scenePosition === undefined ? {} : {
        scenePosition: integer(frame.scenePosition, `saved reference frame ${index} scenePosition`, 1, Number.MAX_SAFE_INTEGER),
      }),
      ...(phase === undefined ? {} : { phase: phase as "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe" }),
    };
  });
  return {
    durationMs,
    frames,
    sourceLabel: typeof source.sourceLabel === "string" && source.sourceLabel.trim()
      ? source.sourceLabel.trim()
      : fallbackSourceLabel,
  };
}

function grammarDuration(value: unknown): number {
  return integer(record(value, "shot grammar").durationMs, "shot grammar durationMs", 1, Number.MAX_SAFE_INTEGER);
}

export function validateShotGrammar(value: unknown, durationMs: number): ShotGrammar {
  const grammar = record(value, "shot grammar");
  if (grammar.version !== "video-factory/shot-grammar-v1") throw new Error("Shot grammar version is invalid.");
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("Shot grammar duration is invalid.");
  if (!Array.isArray(grammar.beats) || grammar.beats.length < 1 || grammar.beats.length > 24) throw new Error("Shot grammar beats are invalid.");
  let previousEnd = 0;
  const beats = grammar.beats.map((item, index): ReferenceGrammarBeat => {
    const beat = record(item, `shot grammar beat ${index}`);
    const startMs = integer(beat.startMs, `shot grammar beat ${index} startMs`, 0, durationMs);
    const endMs = integer(beat.endMs, `shot grammar beat ${index} endMs`, 1, durationMs);
    if (endMs <= startMs || startMs < previousEnd) throw new Error("Shot grammar beats must be ordered and non-overlapping.");
    previousEnd = endMs;
    return {
      startMs,
      endMs,
      narrativeFunction: text(beat.narrativeFunction, "narrativeFunction"),
      shotSize: text(beat.shotSize, "shotSize"),
      composition: text(beat.composition, "composition"),
      cameraMovement: text(beat.cameraMovement, "cameraMovement"),
      subjectMovement: text(beat.subjectMovement, "subjectMovement"),
      lighting: text(beat.lighting, "lighting"),
      color: text(beat.color, "color"),
      transitionIn: text(beat.transitionIn, "transitionIn"),
      soundRole: text(beat.soundRole, "soundRole"),
    };
  });
  const confidence = grammar.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Shot grammar confidence is invalid.");
  return {
    version: "video-factory/shot-grammar-v1",
    summary: text(grammar.summary, "summary"),
    durationMs,
    pacing: text(grammar.pacing, "pacing"),
    composition: text(grammar.composition, "composition"),
    camera: text(grammar.camera, "camera"),
    color: text(grammar.color, "color"),
    transitions: text(grammar.transitions, "transitions"),
    sound: text(grammar.sound, "sound"),
    beats,
    reusableRules: stringArray(grammar.reusableRules, "reusableRules", 1, 12),
    avoidCopying: stringArray(grammar.avoidCopying, "avoidCopying", 1, 12),
    confidence,
    ...(typeof grammar.fallbackReason === "string" && grammar.fallbackReason.trim()
      ? { fallbackReason: text(grammar.fallbackReason, "fallbackReason") }
      : {}),
  };
}

export function fallbackShotGrammar(durationMs: number, reason: string): ShotGrammar {
  const safeDurationMs = Number.isInteger(durationMs) && durationMs > 0 ? durationMs : 15_000;
  return validateShotGrammar({
    version: "video-factory/shot-grammar-v1",
    summary: "参考视频分析暂不可用，使用保守的短视频基础节奏。",
    durationMs: safeDurationMs,
    pacing: "开场直接提出问题，中段稳定解释，结尾收束行动。",
    composition: "主体清晰、竖屏安全区优先，避免复杂遮挡。",
    camera: "以稳定镜头为主，只使用轻微推进和直接切换。",
    color: "自然对比度与可读性优先。",
    transitions: "使用直接切换，避免依赖参考作品的特征转场。",
    sound: "旁白优先，环境声只作轻量铺底。",
    beats: [{
      startMs: 0,
      endMs: safeDurationMs,
      narrativeFunction: "完成一个清晰的信息单元",
      shotSize: "中近景",
      composition: "主体位于竖屏安全区",
      cameraMovement: "稳定或轻微推进",
      subjectMovement: "单一可读动作",
      lighting: "自然柔和光",
      color: "自然低饱和",
      transitionIn: "直接切入",
      soundRole: "旁白承载信息",
    }],
    reusableRules: ["每个镜头只表达一个重点", "优先保证字幕和主体可读"],
    avoidCopying: ["不复制参考作品的人物、对白、情节和标志性镜头"],
    confidence: 0.25,
    fallbackReason: reason.slice(0, 500),
  }, safeDurationMs);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw new Error(`Shot grammar ${label} is invalid.`);
  return value.trim();
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function stringArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Shot grammar ${label} is invalid.`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}
