import type { CodexBridgeClient, CodexTaskExecution } from "./codex-chat.js";
import type { VisualReviewMediaPayload, VisualReviewMediaPreprocessor } from "./codex-visual-review.js";
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
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed">>;
  media: VisualReviewMediaPreprocessor;
  providerId?: string;
  modelId?: string;
  maxReviewIterations?: number;
}

export const REFERENCE_GRAMMAR_AGENT_CONTRACT_VERSION = "reference-grammar-v1|role-audit-v1|shot-grammar-validator-v1";

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
    const payload = await this.payload(input);
    const client = this.options.client;
    if (typeof client.runTaskDetailed !== "function") {
      return { output: validateShotGrammar(await client.runTask("reference-grammar", payload), payload.durationMs), inspectedDurationMs: payload.durationMs };
    }
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
      produce: (revision, { requestId, session }) => client.runTaskDetailed!("reference-grammar", {
        ...payload,
        ...(revision ? { revision } : {}),
      }, requestId, session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId, session }) => client.runTaskDetailed!("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["summary", "pacing", "composition", "camera", "color", "transitions", "sound", "beats", "reusableRules", "avoidCopying", "confidence"],
            doesNotOwn: ["新视频脚本", "新视频镜头方案", "参考视频版权结论"],
          },
          upstreamFacts: {
            durationMs: payload.durationMs,
            sourceLabel: payload.sourceLabel,
            frames: payload.frames.map((frame, index) => ({
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
        images: payload.frames.map((frame, index) => ({
          imageIndex: index + 1,
          timecodeMs: frame.timecodeMs,
          sha256: frame.sha256,
          jpegBase64: frame.jpegBase64,
          ...(frame.scenePosition !== undefined ? { scenePosition: frame.scenePosition } : {}),
          ...(frame.phase ? { phase: frame.phase } : {}),
        })),
      }, requestId, session),
      validate: (value) => validateShotGrammar(value, payload.durationMs),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
    return {
      output: execution.output,
      inspectedDurationMs: payload.durationMs,
      ...(execution.trace ? { trace: execution.trace } : {}),
      ...(execution.agentLoop ? { agentLoop: execution.agentLoop } : {}),
    };
  }

  private async payload(input: ReferenceGrammarAgentInput): Promise<VisualReviewMediaPayload & { sourceLabel: string }> {
    const media = await this.options.media.prepare({ videoPath: input.videoPath, runRoot: input.runRoot });
    return { durationMs: media.durationMs, frames: media.frames, sourceLabel: input.sourceLabel };
  }
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
