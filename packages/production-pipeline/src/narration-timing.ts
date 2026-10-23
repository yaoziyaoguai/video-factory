import { isDeepStrictEqual } from "node:util";
import type { SupportedNarrationPlan } from "./narration-plan.js";

export interface NarrationTimingSummary {
  durationSeconds: number;
  sourceAudioSeconds: number;
  explicitSilenceSeconds: number;
  unfilledSeconds: number;
  unfilledRanges: Array<{ startSeconds: number; endSeconds: number }>;
  groups: Array<{
    groupId: string;
    sourceScenePositions: number[];
    audioSeconds: number;
    startSeconds: number;
    endSeconds: number;
    requiredFrames: number;
    availableFrames: number;
  }>;
}

const sampleRate = 44_100;
const samplesPerFrame = 1470;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** 只解释排轨中未被原声覆盖的时间；原声内部停顿须试听，不把它冒充声学静音检测。 */
export function summarizeNarrationTiming(plan: SupportedNarrationPlan, voicePlan: unknown): NarrationTimingSummary | undefined {
  if (!record(voicePlan)) return undefined;
  const totalSamples = plan.visualPlan.totalFrames * samplesPerFrame;
  const renderedGroups = Array.isArray(voicePlan.groups) && isDeepStrictEqual(voicePlan.narrationPlan, plan)
    ? voicePlan.groups : undefined;
  const legacyScenes = voicePlan.version === "video-factory/voiceover-plan-v2" && !voicePlan.narrationPlan
    && Array.isArray(voicePlan.scenes) ? voicePlan.scenes : undefined;
  if ((!renderedGroups || renderedGroups.length !== plan.groups.length) && !legacyScenes) return undefined;
  const audio: Array<{ start: number; end: number }> = [];
  const explicit = plan.silences.map(silence => ({ start: silence.startFrame * samplesPerFrame, end: silence.endFrame * samplesPerFrame }));
  const groups: NarrationTimingSummary["groups"] = [];
  for (const group of plan.groups) {
    const rendered = renderedGroups?.find(item => record(item) && item.id === group.id);
    const legacy = group.id === `legacy-scene-${group.sourceScenePositions[0]}` && group.sourceScenePositions.length === 1
      ? legacyScenes?.find(item => record(item) && item.position === group.sourceScenePositions[0] && typeof item.narration === "string" && item.narration.trim() === group.text)
      : undefined;
    const samples = record(rendered) ? rendered.sourceAudioSamples
      : record(legacy) && typeof legacy.source_speech_duration === "number" && Number.isFinite(legacy.source_speech_duration)
        ? Math.ceil(legacy.source_speech_duration * sampleRate) : undefined;
    if (!integer(samples) || samples < 1) return undefined;
    const windowStart = group.window.startFrame * samplesPerFrame;
    const windowEnd = group.window.endFrame * samplesPerFrame;
    const offset = group.placement.offsetFrames * samplesPerFrame;
    const start = group.placement.anchor === "start" ? windowStart + offset : windowEnd - offset - samples;
    const end = start + samples;
    if (start < windowStart || end > windowEnd || end > totalSamples
      || record(rendered) && (rendered.startSample !== start || rendered.endSample !== end)) return undefined;
    audio.push({ start, end });
    if (offset) explicit.push(group.placement.anchor === "start"
      ? { start: windowStart, end: start } : { start: end, end: windowEnd });
    groups.push({ groupId: group.id, sourceScenePositions: [...group.sourceScenePositions],
      audioSeconds: samples / sampleRate, startSeconds: start / sampleRate, endSeconds: end / sampleRate,
      requiredFrames: Math.ceil(samples / samplesPerFrame) + group.placement.offsetFrames,
      availableFrames: group.window.endFrame - group.window.startFrame });
  }
  const duration = (ranges: Array<{ start: number; end: number }>) => {
    let end = 0;
    let count = 0;
    for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
      if (range.end > end) count += range.end - Math.max(end, range.start);
      end = Math.max(end, range.end);
    }
    return count / sampleRate;
  };
  const unfilledRanges: NarrationTimingSummary["unfilledRanges"] = [];
  let cursor = 0;
  for (const range of [...audio, ...explicit].sort((a, b) => a.start - b.start)) {
    if (range.start > cursor) unfilledRanges.push({ startSeconds: cursor / sampleRate, endSeconds: range.start / sampleRate });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < totalSamples) unfilledRanges.push({ startSeconds: cursor / sampleRate, endSeconds: totalSamples / sampleRate });
  return { durationSeconds: totalSamples / sampleRate, sourceAudioSeconds: duration(audio),
    explicitSilenceSeconds: duration(explicit),
    unfilledSeconds: unfilledRanges.reduce((sum, range) => sum + range.endSeconds - range.startSeconds, 0), unfilledRanges, groups };
}
