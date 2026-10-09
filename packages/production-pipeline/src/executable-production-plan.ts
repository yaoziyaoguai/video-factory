import {
  compileTimeline,
  assertDurationCommitment,
  parseDurationBounds,
  type CompiledCut,
  type DurationBounds,
  type DurationRange,
  type ExecutableDuration,
} from "./executable-timeline.js";

export const EXECUTABLE_PRODUCTION_PLAN_VERSION = "video-factory/executable-plan-v1" as const;
export const CONTENT_LED_PRODUCTION_PLAN_VERSION = "video-factory/executable-plan-v2" as const;

export interface ExecutablePlanScene {
  position: number;
  duration: number;
  beatId?: string;
}

export interface ExecutablePlanShot {
  scenePosition: number;
  reuseFromScenePosition?: number;
  sourceInSeconds?: number;
  temporalBeats: Array<{
    startSeconds: number;
    endSeconds: number;
    action: string;
  }>;
}

interface ExecutableProductionPlanBody {
  treatmentArtifactId?: string;
  scriptArtifactId: string;
  directorArtifactId: string;
  candidateArtifactIds: string[];
  fps: 30;
  totalFrames: number;
  cuts: CompiledCut[];
}

export type ExecutableProductionPlan = ExecutableProductionPlanBody & (
  | { version: typeof EXECUTABLE_PRODUCTION_PLAN_VERSION; durationPolicy?: undefined; durationRange: DurationRange }
  | { version: typeof CONTENT_LED_PRODUCTION_PLAN_VERSION; durationPolicy: "content-led-v1"; durationRange?: DurationBounds }
);

interface CompileExecutableProductionPlanBody {
  treatmentArtifactId?: string;
  scriptArtifactId: string;
  directorArtifactId: string;
  candidateArtifactIds?: readonly string[];
  scenes: readonly ExecutablePlanScene[];
  shots: readonly ExecutablePlanShot[];
}

export type CompileExecutableProductionPlanInput = CompileExecutableProductionPlanBody & ExecutableDuration;

export function compileExecutableProductionPlan(
  input: CompileExecutableProductionPlanInput,
): ExecutableProductionPlan {
  if (input.durationPolicy !== undefined && input.durationPolicy !== "content-led-v1") {
    throw new Error("Executable production plan durationPolicy is invalid.");
  }
  const scriptArtifactId = artifactId(input.scriptArtifactId, "scriptArtifactId");
  const directorArtifactId = artifactId(input.directorArtifactId, "directorArtifactId");
  const treatmentArtifactId = input.treatmentArtifactId === undefined
    ? undefined
    : artifactId(input.treatmentArtifactId, "treatmentArtifactId");
  const candidateArtifactIds = [...(input.candidateArtifactIds ?? [])]
    .map((id, index) => artifactId(id, `candidateArtifactIds[${index}]`));
  if (new Set(candidateArtifactIds).size !== candidateArtifactIds.length) {
    throw new Error("candidateArtifactIds must not contain duplicates.");
  }

  const shotsByPosition = new Map<number, ExecutablePlanShot>();
  for (const shot of input.shots) {
    if (!Number.isInteger(shot.scenePosition) || shotsByPosition.has(shot.scenePosition)) {
      throw new Error("Script scenes and director shots must use the same scene positions exactly once.");
    }
    shotsByPosition.set(shot.scenePosition, shot);
  }
  if (input.scenes.length !== input.shots.length) {
    throw new Error("Script scenes and director shots must use the same scene positions exactly once.");
  }

  const rootByPosition = new Map<number, number>();
  const resolveRoot = (scenePosition: number, visiting: Set<number>): number => {
    const cached = rootByPosition.get(scenePosition);
    if (cached !== undefined) return cached;
    const shot = shotsByPosition.get(scenePosition);
    if (!shot) throw new Error("Script scenes and director shots must use the same scene positions exactly once.");
    const reuseFrom = shot.reuseFromScenePosition;
    if (reuseFrom === undefined) {
      rootByPosition.set(scenePosition, scenePosition);
      return scenePosition;
    }
    if (!Number.isInteger(reuseFrom) || reuseFrom >= scenePosition || visiting.has(reuseFrom)) {
      throw new Error(`Director reuse route for scene ${scenePosition} is invalid.`);
    }
    visiting.add(scenePosition);
    const root = resolveRoot(reuseFrom, visiting);
    rootByPosition.set(scenePosition, root);
    return root;
  };

  const cutInputs = input.scenes.map((scene, index) => {
    const shot = shotsByPosition.get(scene.position);
    if (!shot || scene.position !== index + 1) {
      throw new Error("Script scenes and director shots must use the same contiguous scene positions.");
    }
    const lastBeat = shot.temporalBeats.at(-1);
    if (!lastBeat || Math.abs(lastBeat.endSeconds - scene.duration) > 1e-6) {
      throw new Error(`Director timing for scene ${scene.position} must cover the accepted ${scene.duration}s script cut.`);
    }
    const beatId = scene.beatId?.trim() || `legacy-scene-${scene.position}`;
    return {
      scenePosition: scene.position,
      beatId,
      assetKey: `asset-scene-${resolveRoot(scene.position, new Set())}`,
      durationSeconds: scene.duration,
      sourceInSeconds: shot.sourceInSeconds ?? 0,
    };
  });
  const timeline = input.durationPolicy === "content-led-v1"
    ? compileTimeline(cutInputs, input.durationRange, input.durationPolicy)
    : compileTimeline(cutInputs, input.durationRange);

  const identity = {
    ...(treatmentArtifactId ? { treatmentArtifactId } : {}),
    scriptArtifactId,
    directorArtifactId,
    candidateArtifactIds,
  };
  const frames = {
    fps: timeline.fps,
    totalFrames: timeline.totalFrames,
    cuts: timeline.cuts.map((cut) => ({ ...cut })),
  };
  return "durationPolicy" in timeline ? {
    version: CONTENT_LED_PRODUCTION_PLAN_VERSION, ...identity, durationPolicy: timeline.durationPolicy,
    ...(timeline.durationRange ? { durationRange: { ...timeline.durationRange } } : {}), ...frames,
  } : {
    version: EXECUTABLE_PRODUCTION_PLAN_VERSION, ...identity, durationRange: { ...timeline.durationRange }, ...frames,
  };
}

export function parseExecutableProductionPlan(value: unknown): ExecutableProductionPlan {
  const input = record(value, "Executable production plan");
  if (input.version !== EXECUTABLE_PRODUCTION_PLAN_VERSION && input.version !== CONTENT_LED_PRODUCTION_PLAN_VERSION) {
    throw new Error("Unsupported executable production plan version.");
  }
  const contentLed = input.version === CONTENT_LED_PRODUCTION_PLAN_VERSION;
  if (contentLed ? input.durationPolicy !== "content-led-v1" : input.durationPolicy !== undefined) {
    throw new Error("Executable production plan version and durationPolicy do not match.");
  }
  if (input.fps !== 30) throw new Error("Executable production plan fps must be 30.");
  let legacyRange: DurationRange | undefined;
  const bounds = contentLed ? parseDurationBounds(input.durationRange) : undefined;
  if (!contentLed) {
    const durationRange = record(input.durationRange, "Executable production plan durationRange");
    const minSeconds = integer(durationRange.minSeconds, "durationRange.minSeconds");
    const maxSeconds = integer(durationRange.maxSeconds, "durationRange.maxSeconds");
    if (minSeconds < 20 || maxSeconds > 180 || minSeconds > maxSeconds) {
      throw new Error("Executable production plan durationRange is invalid.");
    }
    legacyRange = { minSeconds, maxSeconds };
  }
  const scriptArtifactId = artifactId(input.scriptArtifactId, "scriptArtifactId");
  const directorArtifactId = artifactId(input.directorArtifactId, "directorArtifactId");
  const treatmentArtifactId = input.treatmentArtifactId === undefined
    ? undefined
    : artifactId(input.treatmentArtifactId, "treatmentArtifactId");
  if (!Array.isArray(input.candidateArtifactIds)) {
    throw new Error("candidateArtifactIds must be an array.");
  }
  const candidateArtifactIds = input.candidateArtifactIds.map((id, index) => (
    artifactId(id, `candidateArtifactIds[${index}]`)
  ));
  if (new Set(candidateArtifactIds).size !== candidateArtifactIds.length) {
    throw new Error("candidateArtifactIds must not contain duplicates.");
  }
  if (!Array.isArray(input.cuts) || input.cuts.length === 0) {
    throw new Error("Executable production plan cuts must be a non-empty array.");
  }
  let nextStartFrame = 0;
  const cuts = input.cuts.map((entry, index): CompiledCut => {
    const cut = record(entry, `cuts[${index}]`);
    const scenePosition = integer(cut.scenePosition, `cuts[${index}].scenePosition`);
    const startFrame = integer(cut.startFrame, `cuts[${index}].startFrame`);
    const frameCount = integer(cut.frameCount, `cuts[${index}].frameCount`);
    const sourceInFrame = integer(cut.sourceInFrame, `cuts[${index}].sourceInFrame`);
    const beatId = text(cut.beatId, `cuts[${index}].beatId`);
    const assetKey = text(cut.assetKey, `cuts[${index}].assetKey`);
    if (scenePosition !== index + 1 || startFrame !== nextStartFrame || frameCount <= 0 || sourceInFrame < 0) {
      throw new Error(`Executable production plan cut ${index + 1} has invalid frame continuity.`);
    }
    nextStartFrame += frameCount;
    if (!Number.isSafeInteger(nextStartFrame)) throw new Error("Executable production plan totalFrames exceeds safe integer frames.");
    return { scenePosition, beatId, assetKey, startFrame, frameCount, sourceInFrame };
  });
  const totalFrames = integer(input.totalFrames, "totalFrames");
  if (totalFrames !== nextStartFrame || totalFrames < 1
    || legacyRange && (totalFrames < legacyRange.minSeconds * 30 || totalFrames > legacyRange.maxSeconds * 30)) {
    throw new Error("Executable production plan totalFrames does not match its cuts and duration range.");
  }
  if (contentLed) assertDurationCommitment(totalFrames, bounds, cuts.map(cut => cut.scenePosition));
  const identity = {
    ...(treatmentArtifactId ? { treatmentArtifactId } : {}),
    scriptArtifactId,
    directorArtifactId,
    candidateArtifactIds,
  };
  const frames = {
    fps: 30 as const,
    totalFrames,
    cuts,
  };
  return contentLed ? {
    version: CONTENT_LED_PRODUCTION_PLAN_VERSION, ...identity, durationPolicy: "content-led-v1",
    ...(bounds ? { durationRange: bounds } : {}), ...frames,
  } : {
    version: EXECUTABLE_PRODUCTION_PLAN_VERSION, ...identity, durationRange: legacyRange!, ...frames,
  };
}

function artifactId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty artifact id.`);
  return value.trim();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer.`);
  return Number(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}
