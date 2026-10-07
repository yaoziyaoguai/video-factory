import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateCharacterScriptStructure, type CharacterScript } from "./character-script.js";
import { quantizeDurationsToFrames } from "./executable-timeline.js";
import { canonicalJsonV2, rejectSurrogate, NarrationTextV2Error } from "./narration-text.js";

export const CHARACTER_NARRATION_PLAN_VERSION = "video-factory/narration-plan-v3" as const;
interface FrameWindow { startFrame: number; endFrame: number }
interface Placement { anchor: "start" | "end"; offsetFrames: number }
export interface CharacterNarrationPlan {
  version: typeof CHARACTER_NARRATION_PLAN_VERSION;
  mode: "character_turns";
  script: { sha256: string };
  visualPlan: { sha256: string; fps: 30; totalFrames: number };
  source: { sourceContextId: string; canonicalSourceSha256: string };
  edgeTrim: "none";
  subtitleMode: "provider_sentence";
  audioStrategy: "external_tts";
  groups: Array<{ id: string; turnId: string; speakerId: string; voiceProfileId: string;
    sourceScenePositions: [number]; text: string; window: FrameWindow; placement: Placement }>;
  silences: Array<FrameWindow & { id: string; source: "script_pause" | "silent_scene" | "user" }>;
}
export interface CharacterNarrationCandidate {
  version: typeof CHARACTER_NARRATION_PLAN_VERSION;
  groups: Array<{ turnId: string; window: FrameWindow; placement: Placement }>;
  userSilences: FrameWindow[];
}
export interface CharacterNarrationContext {
  script: CharacterScript;
  scriptSha256: string;
  visualSha256: string;
  sourceContextId: string;
}

/** 先保留每句一帧，再按码点加权，用整数余数消除跨端浮点排序差异。 */
export function allocateCharacterTurnFrames(frames: number, turns: Array<{ text: string; after_pause_frames: number }>): number[] {
  integer(frames, 1, "镜头帧数");
  for (const turn of turns) {
    integer(turn.after_pause_frames, 0, "台词停顿");
    if (typeof turn.text !== "string" || !turn.text.trim()) throw new NarrationTextV2Error("台词正文不能为空。");
    rejectSurrogate(turn.text);
  }
  if (!turns.length) return [];
  const available = frames - turns.reduce((n, t) => n + t.after_pause_frames, 0);
  if (available < turns.length) throw new NarrationTextV2Error("镜头放不下台词与停顿，请修改时长。");
  const weights = turns.map((t) => Array.from(t.text).length);
  const sum = weights.reduce((a, b) => a + b, 0);
  const extra = available - turns.length;
  const result = weights.map((w) => 1 + Math.floor(extra * w / sum));
  const order = weights.map((w, i) => ({ i, remainder: extra * w % sum }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = available - result.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) result[order[i]!.i]! += 1;
  return result;
}

export function parseCharacterNarrationCandidate(value: unknown): CharacterNarrationCandidate {
  const input = record(value, ["version", "groups", "userSilences"], "角色声音候选");
  if (input.version !== CHARACTER_NARRATION_PLAN_VERSION) throw new NarrationTextV2Error("角色声音候选版本不正确。");
  if (!Array.isArray(input.groups) || !Array.isArray(input.userSilences)) throw new NarrationTextV2Error("角色声音候选缺少台词或留白列表。");
  return { version: CHARACTER_NARRATION_PLAN_VERSION, groups: input.groups.map((entry) => {
    const group = record(entry, ["turnId", "window", "placement"], "台词时间");
    if (typeof group.turnId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(group.turnId)) throw new NarrationTextV2Error("台词身份无效。");
    const placement = record(group.placement, ["anchor", "offsetFrames"], "台词落点");
    if (placement.anchor !== "start" && placement.anchor !== "end") throw new NarrationTextV2Error("台词落点无效。");
    integer(placement.offsetFrames, 0, "台词偏移");
    return { turnId: group.turnId, window: windowValue(group.window), placement: { anchor: placement.anchor, offsetFrames: placement.offsetFrames } };
  }), userSilences: input.userSilences.map(windowValue) };
}

export function buildCharacterNarrationPlan(input: CharacterNarrationContext, rawCandidate?: CharacterNarrationCandidate): CharacterNarrationPlan {
  const script = validateCharacterScriptStructure(input.script);
  if (![input.scriptSha256, input.visualSha256].every((s) => /^[a-f0-9]{64}$/.test(s))
    || typeof input.sourceContextId !== "string" || !input.sourceContextId.trim()) throw new NarrationTextV2Error("角色声音缺少有效稿件与画面身份。");
  const counts = quantizeDurationsToFrames(script.scenes.map((s) => s.duration));
  const totalFrames = counts.reduce((a, b) => a + b, 0);
  integer(totalFrames, 1, "总帧数");
  if (totalFrames > 5400) throw new NarrationTextV2Error("角色声音超出时长范围。");
  const candidate = rawCandidate === undefined ? undefined : parseCharacterNarrationCandidate(rawCandidate);
  const expectedIds = script.scenes.flatMap((s) => s.dialogue.map((t) => t.id));
  if (candidate && !isDeepStrictEqual(candidate.groups.map((g) => g.turnId), expectedIds)) throw new NarrationTextV2Error("台词列表必须按当前剧本顺序完整保留。");
  const source = { rule: "character-turns-v1", characters: script.characters.map((c) => ({ id: c.id, kind: c.kind, voiceProfileId: c.voice_profile_id ?? "" })),
    scenes: script.scenes.map((s, i) => ({ position: s.position, frames: counts[i]!, characterIds: s.character_ids,
      dialogue: s.dialogue.map((t) => ({ id: t.id, speakerId: t.speaker_id, text: t.text, afterPauseFrames: t.after_pause_frames })) })) };
  const plan: CharacterNarrationPlan = { version: CHARACTER_NARRATION_PLAN_VERSION, mode: "character_turns", audioStrategy: "external_tts",
    script: { sha256: input.scriptSha256 }, visualPlan: { sha256: input.visualSha256, fps: 30, totalFrames },
    source: { sourceContextId: input.sourceContextId, canonicalSourceSha256: digest(source) },
    edgeTrim: "none", subtitleMode: "provider_sentence", groups: [], silences: [] };
  let start = 0;
  let groupIndex = 0;
  for (const [i, scene] of script.scenes.entries()) {
    const end = start + counts[i]!;
    const allocations = allocateCharacterTurnFrames(counts[i]!, scene.dialogue);
    if (!scene.dialogue.length) plan.silences.push({ id: `silent-scene-${scene.position}`, startFrame: start, endFrame: end, source: "silent_scene" });
    let cursor = start;
    for (const [j, turn] of scene.dialogue.entries()) {
      const character = script.characters.find((c) => c.id === turn.speaker_id)!;
      if (!character.voice_profile_id) throw new NarrationTextV2Error(`请先为角色“${character.name}”选择可用音色。`);
      const selected = candidate?.groups[groupIndex++];
      const window = selected?.window ?? { startFrame: cursor, endFrame: cursor + allocations[j]! };
      const placement = selected?.placement ?? { anchor: "start" as const, offsetFrames: 0 };
      if (window.startFrame < cursor || window.endFrame + turn.after_pause_frames > end
        || placement.offsetFrames >= window.endFrame - window.startFrame) throw new NarrationTextV2Error("台词时间越界或重叠，请调整窗口与留白。");
      plan.groups.push({ id: turn.id, turnId: turn.id, speakerId: turn.speaker_id, voiceProfileId: character.voice_profile_id,
        sourceScenePositions: [scene.position], text: turn.text, window: { ...window }, placement: { ...placement } });
      cursor = window.endFrame;
      if (turn.after_pause_frames) {
        plan.silences.push({ id: `pause-${turn.id}`, startFrame: cursor, endFrame: cursor + turn.after_pause_frames, source: "script_pause" });
        cursor += turn.after_pause_frames;
      }
    }
    start = end;
  }
  for (const window of [...(candidate?.userSilences ?? [])].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)) {
    if (window.endFrame > totalFrames || plan.silences.some((s) => overlaps(window, s)) || plan.groups.some((g) => overlaps(window, g.window))) {
      throw new NarrationTextV2Error("用户留白越界或与台词、脚本留白重叠。");
    }
    plan.silences.push({ ...window, id: `silence-user-${window.startFrame}-${window.endFrame}`, source: "user" });
  }
  plan.silences.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  return plan;
}

export function characterCandidateFromPlan(plan: CharacterNarrationPlan): CharacterNarrationCandidate {
  if (!Array.isArray(plan.groups) || !Array.isArray(plan.silences)) throw new NarrationTextV2Error("角色声音计划缺少台词与留白。");
  return parseCharacterNarrationCandidate({ version: plan.version,
    groups: plan.groups.map((g) => ({ turnId: g.turnId, window: g.window, placement: g.placement })),
    userSilences: plan.silences.filter((s) => s.source === "user").map((s) => ({ startFrame: s.startFrame, endFrame: s.endFrame })) });
}
export function validateCharacterNarrationPlan(value: unknown, context: CharacterNarrationContext): CharacterNarrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NarrationTextV2Error("角色声音计划格式无效。");
  const rebuilt = buildCharacterNarrationPlan(context, characterCandidateFromPlan(value as CharacterNarrationPlan));
  if (!isDeepStrictEqual(value, rebuilt)) throw new NarrationTextV2Error("角色声音计划与当前剧本、音色、来源身份或留白不一致。");
  return rebuilt;
}
export function characterCandidateId(candidate: CharacterNarrationCandidate, sourceContextId: string): string {
  if (!sourceContextId.trim()) throw new NarrationTextV2Error("角色声音候选缺少来源身份。");
  return "nc-" + digest({ sourceContextId, candidate: parseCharacterNarrationCandidate(candidate) });
}
export function characterPlanSha256(plan: CharacterNarrationPlan): string { return digest(plan); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJsonV2(value)).digest("hex"); }
function integer(value: unknown, min: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new NarrationTextV2Error(`${label}必须是安全整数。`);
}
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw new NarrationTextV2Error(`${label}字段无效，不能替换正文、角色或音色。`);
  return value as Record<string, unknown>;
}
function windowValue(value: unknown): FrameWindow {
  const w = record(value, ["startFrame", "endFrame"], "时间窗口");
  integer(w.startFrame, 0, "起点"); integer(w.endFrame, w.startFrame + 1, "终点");
  return { startFrame: w.startFrame, endFrame: w.endFrame };
}
function overlaps(a: FrameWindow, b: FrameWindow): boolean { return a.startFrame < b.endFrame && b.startFrame < a.endFrame; }
