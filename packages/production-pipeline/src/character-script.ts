import type { ScriptScene } from "./codex-screenwriter.js";
import { assertDurationCommitment, quantizeDurationsToFrames, validateContentLedDurationIntent, type DurationIntent } from "./executable-timeline.js";

export const CHARACTER_SCRIPT_VERSION = "video-factory/character-script-v1";
export type PresentationMode = "narration" | "character_drama";
export interface CharacterVoiceProfile { id: string; providerId: string; label: string }
export interface ScriptCharacter {
  id: string;
  name: string;
  kind: "character" | "narrator";
  appearance: string;
  personality: string;
  voice_intent: string;
  voice_profile_id: string | null;
}
export interface CharacterDialogueTurn {
  id: string;
  speaker_id: string;
  text: string;
  delivery: string;
  after_pause_frames: number;
}
export interface CharacterScriptScene extends Omit<ScriptScene, "narration"> {
  character_ids: string[];
  dialogue: CharacterDialogueTurn[];
}
export interface CharacterScript {
  version: typeof CHARACTER_SCRIPT_VERSION;
  viewerPromise?: string;
  narrativeArc?: string;
  canonFacts?: string[];
  characters: ScriptCharacter[];
  scenes: CharacterScriptScene[];
}

export function isCharacterScript(value: unknown): value is CharacterScript {
  return typeof value === "object" && value !== null && "version" in value
    && value.version === CHARACTER_SCRIPT_VERSION;
}

/** 仅用于展示、审计和下游文字任务；禁止将此投影写回剧本或作为配音输入。 */
export function scriptSceneText(scene: ScriptScene | CharacterScriptScene): string {
  return "dialogue" in scene
    ? scene.dialogue.map((turn) => turn.text).join(" ") || scene.visible_action || scene.purpose || scene.visual_prompt
    : scene.narration;
}

type CharacterScriptValidation = DurationIntent & { requireCanonFacts?: boolean };
export function validateCharacterScript(value: unknown, options: CharacterScriptValidation): CharacterScript {
  return parseCharacterScript(value, options);
}
/** Broker 已保存稿检查无权猜测制作目标时长；实际保存/采用仍由宿主带 brief 复核。 */
export function validateCharacterScriptStructure(value: unknown): CharacterScript {
  return parseCharacterScript(value);
}
function parseCharacterScript(value: unknown, options?: CharacterScriptValidation): CharacterScript {
  const input = object(value, "角色剧本");
  if (input.version !== CHARACTER_SCRIPT_VERSION) throw new Error("不支持的角色剧本版本。");
  if (options?.durationPolicy === "content-led-v1") validateContentLedDurationIntent(options);
  const legacy = options?.durationPolicy === undefined ? options : undefined;
  if (legacy && (!Number.isInteger(legacy.durationSeconds) || legacy.durationSeconds < 20 || legacy.durationSeconds > 180)) {
    throw new Error("Script draft target durationSeconds must be an integer between 20 and 180.");
  }
  const range = legacy ? legacy.durationRange ?? { minSeconds: legacy.durationSeconds * 0.6, maxSeconds: legacy.durationSeconds * 1.4 } : undefined;
  if (legacy?.durationRange && range && (!Number.isInteger(range.minSeconds) || !Number.isInteger(range.maxSeconds)
    || range.minSeconds < 20 || range.maxSeconds > 180 || range.minSeconds > range.maxSeconds
    || legacy.durationSeconds < range.minSeconds || legacy.durationSeconds > range.maxSeconds)) {
    throw new Error("Script draft target durationRange is invalid.");
  }
  const characters = list(input.characters, "characters").map((entry, i): ScriptCharacter => {
    const c = object(entry, "characters[" + i + "]");
    if (c.kind !== "character" && c.kind !== "narrator") throw new Error("角色 kind 必须是 character 或 narrator。");
    return { id: id(c.id, "角色 id"), name: text(c.name, "角色名称"), kind: c.kind,
      appearance: text(c.appearance, "角色外观", c.kind === "narrator"),
      personality: text(c.personality, "角色性格", true), voice_intent: text(c.voice_intent, "声音意图", true),
      voice_profile_id: c.voice_profile_id === null ? null : text(c.voice_profile_id, "音色") };
  });
  const characterMap = new Map(characters.map((c) => [c.id, c]));
  if (characterMap.size !== characters.length) throw new Error("角色 id 不得重复。");
  const turns = new Set<string>();
  const scenes = list(input.scenes, "scenes").map((entry, i): CharacterScriptScene => {
    const s = object(entry, "scenes[" + i + "]");
    if (Object.hasOwn(s, "narration")) throw new Error("角色剧本使用 dialogue，不接受旁白 narration。");
    if (!Number.isSafeInteger(s.position) || Number(s.position) < 1) throw new Error("镜头 position 必须是正整数。");
    if (typeof s.duration !== "number" || !Number.isFinite(s.duration) || s.duration <= 0) throw new Error("镜头时长无效。");
    if (!["stock", "image", "generated", "local"].includes(String(s.visual_strategy))) throw new Error("镜头 visual_strategy 无效。");
    const characterIds = list(s.character_ids, "出场角色").map((v) => id(v, "出场角色 id"));
    if (new Set(characterIds).size !== characterIds.length || characterIds.some((v) => characterMap.get(v)?.kind !== "character")) {
      throw new Error("出场角色必须引用不重复的 character，旁白不能自动出镜。");
    }
    const dialogue = list(s.dialogue, "dialogue").map((entry): CharacterDialogueTurn => {
      const t = object(entry, "台词");
      const turnId = id(t.id, "台词 id");
      if (turns.has(turnId)) throw new Error("台词 id 全稿不得重复。");
      turns.add(turnId);
      const speaker = id(t.speaker_id, "说话角色 id");
      if (!characterMap.has(speaker)) throw new Error("台词引用了不存在的角色：" + speaker);
      if (!Number.isSafeInteger(t.after_pause_frames) || Number(t.after_pause_frames) < 0) throw new Error("台词停顿必须是非负安全整数帧。");
      return { id: turnId, speaker_id: speaker, text: text(t.text, "台词正文"), delivery: text(t.delivery, "表演要求", true), after_pause_frames: Number(t.after_pause_frames) };
    });
    if (dialogue.reduce((n, t) => n + t.after_pause_frames + 1, 0) > Math.floor(s.duration * 30 + 0.5)) {
      throw new Error("镜头放不下台词与停顿，请修改时长或停顿。");
    }
    const terms = strings(s.search_terms, "search_terms", 1);
    if (new Set(terms).size !== terms.length) throw new Error("search_terms 不得重复。");
    const scene: CharacterScriptScene = { position: Number(s.position),
      ...optionalText(s, "purpose"), duration: s.duration,
      visual_strategy: s.visual_strategy as ScriptScene["visual_strategy"], visual_prompt: text(s.visual_prompt, "画面描述"),
      ...optionalText(s, "visible_action"), ...optionalText(s, "on_screen_text", true), ...optionalText(s, "sound_cue"),
      ...(s.success_criteria === undefined ? {} : { success_criteria: strings(s.success_criteria, "success_criteria", 1) }),
      ...(s.failure_conditions === undefined ? {} : { failure_conditions: strings(s.failure_conditions, "failure_conditions", 1) }),
      search_terms: terms, character_ids: characterIds, dialogue };
    return scene;
  }).sort((a, b) => a.position - b.position);
  if (scenes.length < 1 || scenes.length > 24 || scenes.some((s, i) => s.position !== i + 1)) throw new Error("剧本须有1–24个连续编号的镜头。");
  if (options?.durationPolicy === "content-led-v1") {
    const frames = quantizeDurationsToFrames(scenes.map(s => s.duration));
    assertDurationCommitment(frames.reduce((sum, count) => sum + count, 0), options.durationRange, scenes.map(s => s.position));
  }
  const total = scenes.reduce((n, s) => n + s.duration, 0);
  if (range && (total < range.minSeconds || total > range.maxSeconds)) throw new Error("剧本总时长超出目标范围。");
  if (options?.requireCanonFacts && input.canonFacts === undefined) throw new Error("Series script drafts must contain a canonFacts array with at most 8 entries.");
  return { version: CHARACTER_SCRIPT_VERSION, ...optionalText(input, "viewerPromise"), ...optionalText(input, "narrativeArc"),
    ...(input.canonFacts === undefined ? {} : { canonFacts: strings(input.canonFacts, "canonFacts", 0) }), characters, scenes };
}

function object(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(label + " 必须是对象。");
  return v as Record<string, unknown>;
}
function list(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(label + " 必须是数组。");
  return v;
}
function text(v: unknown, label: string, allowEmpty = false): string {
  if (typeof v !== "string" || (!allowEmpty && !v.trim())) throw new Error(label + " 必须是" + (allowEmpty ? "" : "非空") + "字符串。");
  return v.trim();
}
function id(v: unknown, label: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(label + " 格式无效。");
  return v;
}
function strings(v: unknown, label: string, min: number): string[] {
  const values = list(v, label);
  if (values.length < min || values.length > 8) throw new Error(label + " 数量无效。");
  return values.map((v) => text(v, label));
}
function optionalText(v: Record<string, unknown>, key: string, allowEmpty = false): Record<string, string> {
  return v[key] === undefined ? {} : { [key]: text(v[key], key, allowEmpty) };
}
