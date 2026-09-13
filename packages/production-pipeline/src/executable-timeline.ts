export interface DurationRange {
  minSeconds: number;
  maxSeconds: number;
}

export interface CutInput {
  scenePosition: number;
  beatId: string;
  assetKey: string;
  durationSeconds: number;
  sourceInSeconds: number;
}

export interface CompiledCut {
  scenePosition: number;
  beatId: string;
  assetKey: string;
  startFrame: number;
  frameCount: number;
  sourceInFrame: number;
}

export interface CompiledTimeline {
  fps: 30;
  durationRange: DurationRange;
  totalFrames: number;
  cuts: CompiledCut[];
}

export type PlanErrorCode =
  | "INVALID_RANGE"
  | "INVALID_CUT"
  | "OUTSIDE_DURATION_RANGE"
  | "MISSING_MEDIA"
  | "INVALID_MEDIA"
  | "SOURCE_RANGE_TOO_SHORT"
  | "MISSING_VOICE"
  | "VOICE_DOES_NOT_FIT";

export class PlanContractError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    readonly scenePositions: number[],
    message: string,
  ) {
    super(message);
    this.name = "PlanContractError";
  }
}

const FPS = 30 as const;
const FRAME_EPSILON = 1e-6;

export function quantizeDurationsToFrames(durations: readonly number[]): number[] {
  let elapsedSeconds = 0;
  let previousBoundary = 0;
  return durations.map((duration) => {
    elapsedSeconds += duration;
    const boundary = Math.round(elapsedSeconds * FPS);
    const frameCount = boundary - previousBoundary;
    previousBoundary = boundary;
    return frameCount;
  });
}

export function compileTimeline(
  inputs: readonly CutInput[],
  durationRange: DurationRange,
): CompiledTimeline {
  const { minSeconds, maxSeconds } = durationRange;
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds)
    || minSeconds < 20 || maxSeconds > 180 || minSeconds > maxSeconds) {
    throw new PlanContractError("INVALID_RANGE", [], "时长范围须为20–180秒内的有序整数边界。");
  }
  if (inputs.length === 0) {
    throw new PlanContractError("INVALID_CUT", [], "时间轴不能为空。");
  }
  for (const [index, input] of inputs.entries()) {
    if (input.scenePosition !== index + 1 || !input.beatId.trim() || !input.assetKey.trim()
      || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0
      || !Number.isFinite(input.sourceInSeconds) || input.sourceInSeconds < 0) {
      throw new PlanContractError("INVALID_CUT", [index + 1], "镜头顺序、关联或时间参数不合法。");
    }
  }
  const frameCounts = quantizeDurationsToFrames(inputs.map((input) => input.durationSeconds));
  let previousBoundary = 0;
  const cuts = inputs.map((input, index): CompiledCut => {
    const frameCount = frameCounts[index]!;
    if (frameCount <= 0) {
      throw new PlanContractError("INVALID_CUT", [input.scenePosition], "镜头量化后不足一帧。");
    }
    const cut: CompiledCut = {
      scenePosition: input.scenePosition,
      beatId: input.beatId,
      assetKey: input.assetKey,
      startFrame: previousBoundary,
      frameCount,
      sourceInFrame: Math.round(input.sourceInSeconds * FPS),
    };
    previousBoundary += frameCount;
    return cut;
  });
  if (previousBoundary < minSeconds * FPS || previousBoundary > maxSeconds * FPS) {
    throw new PlanContractError(
      "OUTSIDE_DURATION_RANGE",
      cuts.map((cut) => cut.scenePosition),
      `实际${previousBoundary / FPS}秒不在${minSeconds}–${maxSeconds}秒范围内；需要重排方案，不能隐式伸缩。`,
    );
  }
  return { fps: FPS, durationRange: { ...durationRange }, totalFrames: previousBoundary, cuts };
}

export type MaterializedMedia =
  | { mediaType: "image" }
  | { mediaType: "video"; durationSeconds: number };

export function assertMediaCoverage(
  timeline: CompiledTimeline,
  media: ReadonlyMap<string, MaterializedMedia>,
): void {
  for (const cut of timeline.cuts) {
    const asset = media.get(cut.assetKey);
    if (!asset) {
      throw new PlanContractError("MISSING_MEDIA", [cut.scenePosition], "该镜头还没有实际素材。");
    }
    if (asset.mediaType === "image") {
      if (cut.sourceInFrame !== 0) {
        throw new PlanContractError("INVALID_MEDIA", [cut.scenePosition], "静态图片没有非零源时间区间。");
      }
      continue;
    }
    if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0) {
      throw new PlanContractError("INVALID_MEDIA", [cut.scenePosition], "视频时长元数据不合法。");
    }
    const availableFrames = Math.floor(asset.durationSeconds * FPS + FRAME_EPSILON);
    if (cut.sourceInFrame + cut.frameCount > availableFrames) {
      throw new PlanContractError(
        "SOURCE_RANGE_TOO_SHORT",
        [cut.scenePosition],
        "实际素材不足以覆盖所选区间；不能循环、变速或定格掩盖。",
      );
    }
  }
}

export interface VoiceTiming {
  scenePosition: number;
  requiredSeconds: number;
}

export function assertVoiceFits(timeline: CompiledTimeline, voices: readonly VoiceTiming[]): void {
  const byPosition = new Map<number, VoiceTiming>();
  for (const voice of voices) {
    if (!Number.isInteger(voice.scenePosition) || !Number.isFinite(voice.requiredSeconds)
      || voice.requiredSeconds < 0 || byPosition.has(voice.scenePosition)) {
      throw new PlanContractError("MISSING_VOICE", [], "配音时间记录重复或不合法。");
    }
    byPosition.set(voice.scenePosition, voice);
  }
  if (byPosition.size !== timeline.cuts.length) {
    throw new PlanContractError("MISSING_VOICE", [], "配音记录与时间轴镜头集合不一致。");
  }
  for (const cut of timeline.cuts) {
    const voice = byPosition.get(cut.scenePosition);
    if (!voice) {
      throw new PlanContractError("MISSING_VOICE", [cut.scenePosition], "缺少对应镜头的配音时间记录。");
    }
    const requiredFrames = Math.ceil(voice.requiredSeconds * FPS - FRAME_EPSILON);
    if (requiredFrames > cut.frameCount) {
      throw new PlanContractError(
        "VOICE_DOES_NOT_FIT",
        [cut.scenePosition],
        "自然配音超出当前镜头；先在时长范围和素材覆盖内调整方案。",
      );
    }
  }
}
