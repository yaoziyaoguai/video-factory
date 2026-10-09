export interface DurationRange {
  minSeconds: number;
  maxSeconds: number;
}

/** 只记录用户明确给出的端点；缺一端不补另一端。旧版DurationRange仍为双端合同。 */
export interface DurationBounds {
  minSeconds?: number;
  maxSeconds?: number;
}

export interface DurationAmendment {
  expectedBriefSha256: string;
  range: DurationBounds | null;
}

export function parseDurationAmendment(value: unknown): DurationAmendment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Duration amendment must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "expectedBriefSha256" && key !== "range")
    || typeof record.expectedBriefSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.expectedBriefSha256)
    || !Object.hasOwn(record, "range") || record.range === undefined) {
    throw new Error("Duration amendment requires the current brief SHA and an explicit range or null.");
  }
  return { expectedBriefSha256: record.expectedBriefSha256,
    range: record.range === null ? null : parseDurationBounds(record.range)! };
}

export type DurationIntent =
  | { durationPolicy?: undefined; durationSeconds: number; durationRange?: DurationRange }
  | { durationPolicy: "content-led-v1"; durationSeconds: number; durationRange?: DurationBounds };

export type ExecutableDuration =
  | { durationPolicy?: undefined; durationRange: DurationRange }
  | { durationPolicy: "content-led-v1"; durationRange?: DurationBounds };

export function executableDurationFor(input: DurationIntent): ExecutableDuration {
  if (input.durationPolicy === "content-led-v1") {
    const bounds = validateContentLedDurationIntent(input);
    return { durationPolicy: input.durationPolicy, ...(bounds ? { durationRange: bounds } : {}) };
  }
  if (!input.durationRange) throw new Error("Legacy executable planning requires a durationRange.");
  return { durationRange: { ...input.durationRange } };
}

/** 投影角色输入时保留语义标记和缺省端点，不能把单端承诺重建为双端范围。 */
export function durationIntentFor(input: DurationIntent): DurationIntent {
  return input.durationPolicy === "content-led-v1"
    ? { durationPolicy: input.durationPolicy, durationSeconds: input.durationSeconds,
      ...(input.durationRange ? { durationRange: { ...input.durationRange } } : {}) }
    : { durationSeconds: input.durationSeconds,
      ...(input.durationRange ? { durationRange: { ...input.durationRange } } : {}) };
}

export function validateContentLedDurationIntent(input: Extract<DurationIntent, { durationPolicy: string }>): DurationBounds | undefined {
  if (typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new PlanContractError("INVALID_RANGE", [], "参考时长须为正有限数；它不限制模型提案总长。");
  }
  return parseDurationBounds(input.durationRange);
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

export interface ContentLedTimeline extends Omit<CompiledTimeline, "durationRange"> {
  durationPolicy: "content-led-v1";
  durationRange?: DurationBounds;
}

export type PlanErrorCode =
  | "INVALID_RANGE"
  | "INVALID_CUT"
  | "OUTSIDE_DURATION_RANGE"
  | "duration_commitment_conflict"
  | "execution_capability_conflict"
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

// Number最短十进制即Host JSON中的数值含义。用整数有理数计算，不能用epsilon放宽承诺。
function decimalFrameBoundary(seconds: number, direction: "ceil" | "floor"): bigint {
  const [coefficient, exponentText] = seconds.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  let numerator = BigInt(whole! + fraction) * BigInt(FPS);
  const scale = fraction.length - Number(exponentText ?? 0);
  if (scale <= 0) return numerator * 10n ** BigInt(-scale);
  const denominator = 10n ** BigInt(scale);
  if (direction === "ceil") numerator += denominator - 1n;
  return numerator / denominator;
}

export function parseDurationBounds(value: unknown): DurationBounds | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanContractError("INVALID_RANGE", [], "时长承诺须包含至少一个明确的正数边界。");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => key !== "minSeconds" && key !== "maxSeconds")
    || keys.some(key => typeof input[key] !== "number" || !Number.isFinite(input[key]) || Number(input[key]) <= 0)) {
    throw new PlanContractError("INVALID_RANGE", [], "时长承诺只能包含正有限的minSeconds或maxSeconds。");
  }
  const bounds: DurationBounds = {
    ...(Object.hasOwn(input, "minSeconds") ? { minSeconds: Number(input.minSeconds) } : {}),
    ...(Object.hasOwn(input, "maxSeconds") ? { maxSeconds: Number(input.maxSeconds) } : {}),
  };
  if (bounds.minSeconds !== undefined && bounds.maxSeconds !== undefined && bounds.minSeconds > bounds.maxSeconds) {
    throw new PlanContractError("INVALID_RANGE", [], "时长下限不能大于上限。");
  }
  const min = bounds.minSeconds === undefined ? 1n : decimalFrameBoundary(bounds.minSeconds, "ceil");
  const max = bounds.maxSeconds === undefined ? BigInt(Number.MAX_SAFE_INTEGER) : decimalFrameBoundary(bounds.maxSeconds, "floor");
  if (max < 1n || min > max || min > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PlanContractError("INVALID_RANGE", [], "该时长承诺没有可执行的正整数帧，请修改时长边界。");
  }
  return bounds;
}

export function assertDurationCommitment(totalFrames: number, bounds: DurationBounds | undefined, scenePositions: number[] = []): void {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1) {
    throw new PlanContractError("INVALID_CUT", scenePositions, "总帧数须为可精确表示的正整数。");
  }
  const validated = parseDurationBounds(bounds);
  if (!validated) return;
  if ((validated.minSeconds !== undefined && BigInt(totalFrames) < decimalFrameBoundary(validated.minSeconds, "ceil"))
    || (validated.maxSeconds !== undefined && BigInt(totalFrames) > decimalFrameBoundary(validated.maxSeconds, "floor"))) {
    const description = validated.minSeconds === undefined ? `最多${validated.maxSeconds}秒`
      : validated.maxSeconds === undefined ? `至少${validated.minSeconds}秒` : `${validated.minSeconds}–${validated.maxSeconds}秒`;
    throw new PlanContractError("duration_commitment_conflict", scenePositions,
      `方案为${totalFrames / FPS}秒，与你设定的${description}冲突；可以修改稿件或修改时长承诺。`);
  }
}

export function quantizeDurationsToFrames(durations: readonly number[]): number[] {
  let elapsedSeconds = 0;
  let previousBoundary = 0;
  return durations.map((duration, index) => {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new PlanContractError("INVALID_CUT", [index + 1], "镜头时长须为正有限数。");
    }
    elapsedSeconds += duration;
    const boundary = Math.round(elapsedSeconds * FPS);
    const frameCount = boundary - previousBoundary;
    if (!Number.isSafeInteger(boundary) || !Number.isSafeInteger(frameCount) || frameCount < 1) {
      throw new PlanContractError("INVALID_CUT", [index + 1], "每镜须至少一帧，总帧数须为安全整数。");
    }
    previousBoundary = boundary;
    return frameCount;
  });
}

export function compileTimeline(
  inputs: readonly CutInput[],
  durationRange: DurationRange,
): CompiledTimeline;
export function compileTimeline(
  inputs: readonly CutInput[],
  durationRange: DurationBounds | undefined,
  durationPolicy: "content-led-v1",
): ContentLedTimeline;
export function compileTimeline(
  inputs: readonly CutInput[],
  durationRange: DurationBounds | undefined,
  durationPolicy?: "content-led-v1",
): CompiledTimeline | ContentLedTimeline {
  if (durationPolicy !== undefined && durationPolicy !== "content-led-v1") {
    throw new PlanContractError("INVALID_RANGE", [], "未知的时长合同。");
  }
  const bounds = durationPolicy === "content-led-v1" ? parseDurationBounds(durationRange) : undefined;
  if (durationPolicy === undefined) {
    const { minSeconds, maxSeconds } = durationRange ?? {};
    if (minSeconds === undefined || maxSeconds === undefined
      || !Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds)
      || minSeconds < 20 || maxSeconds > 180 || minSeconds > maxSeconds) {
      throw new PlanContractError("INVALID_RANGE", [], "时长范围须为20–180秒内的有序整数边界。");
    }
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
    const sourceInFrame = Math.round(input.sourceInSeconds * FPS);
    if (!Number.isSafeInteger(frameCount) || frameCount <= 0
      || !Number.isSafeInteger(previousBoundary + frameCount) || !Number.isSafeInteger(sourceInFrame)) {
      throw new PlanContractError("INVALID_CUT", [input.scenePosition], "镜头须至少一帧，全部时间须可精确表示为安全整数帧。");
    }
    const cut: CompiledCut = {
      scenePosition: input.scenePosition,
      beatId: input.beatId,
      assetKey: input.assetKey,
      startFrame: previousBoundary,
      frameCount,
      sourceInFrame,
    };
    previousBoundary += frameCount;
    return cut;
  });
  if (durationPolicy === "content-led-v1") {
    assertDurationCommitment(previousBoundary, bounds, cuts.map(cut => cut.scenePosition));
    return { fps: FPS, durationPolicy, ...(bounds ? { durationRange: bounds } : {}), totalFrames: previousBoundary, cuts };
  }
  const { minSeconds, maxSeconds } = durationRange as DurationRange;
  if (previousBoundary < minSeconds * FPS || previousBoundary > maxSeconds * FPS) {
    throw new PlanContractError(
      "OUTSIDE_DURATION_RANGE",
      cuts.map((cut) => cut.scenePosition),
      `实际${previousBoundary / FPS}秒不在${minSeconds}–${maxSeconds}秒范围内；需要重排方案，不能隐式伸缩。`,
    );
  }
  return { fps: FPS, durationRange: { minSeconds, maxSeconds }, totalFrames: previousBoundary, cuts };
}

export type MaterializedMedia =
  | { mediaType: "image" }
  | { mediaType: "video"; durationSeconds: number };

export function assertMediaCoverage(
  timeline: Pick<CompiledTimeline, "cuts">,
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

export function assertVoiceFits(timeline: Pick<CompiledTimeline, "cuts">, voices: readonly VoiceTiming[]): void {
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
