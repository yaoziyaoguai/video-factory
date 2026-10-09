import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateScriptDraft } from "../src/codex-screenwriter.js";
import { isCharacterScript } from "../src/character-script.js";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/character-drama-cases.json", import.meta.url), "utf8"));

for (const example of fixture.structurally_valid_semantic_review) test("semantic review, not structural rejection: " + example.name, () => {
  const input = structuredClone(fixture.script);
  let target = input;
  for (const key of example.path.slice(0, -1)) target = target[key];
  target[example.path.at(-1)] = example.value;
  assert.deepEqual(validateScriptDraft(input, { durationSeconds: 24 }), input);
});

test("content-led four-character two-shot script retains all dialogue and reports explicit commitment conflicts", () => {
  const input = structuredClone(fixture.script);
  input.scenes = input.scenes.slice(0, 2);
  input.scenes.forEach((s: typeof input.scenes[number]) => { s.duration = 6; });
  input.scenes[0].dialogue[0].text = "这证明了你是朋友";
  input.scenes[1].dialogue[0].text = "今晚是现场效果最好的一次";
  const options = { durationPolicy: "content-led-v1" as const, durationSeconds: 24 };
  assert.deepEqual(validateScriptDraft(input, options), input);
  assert.deepEqual(validateScriptDraft(input, { ...options, durationRange: { maxSeconds: 12 } }), input);
  assert.throws(() => validateScriptDraft(input, { ...options, durationRange: { maxSeconds: 10 } }),
    (e: unknown) => e instanceof Error && "code" in e && e.code === "duration_commitment_conflict");
});

for (const invalid of fixture.invalid) test("MC-A03 shared invalid: " + invalid.name, () => {
  const input = structuredClone(fixture.script);
  let target = input;
  for (const key of invalid.path.slice(0, -1)) target = target[key];
  target[invalid.path.at(-1)] = invalid.value;
  assert.throws(() => validateScriptDraft(input, { durationSeconds: 24 }));
  assert.deepEqual(fixture.script.scenes[0].dialogue[0].speaker_id, "shopkeeper");
});

for (const count of [1, 3, 4, 6]) test("MC-A02 round-trip " + count + " stable character identities", () => {
  const input = structuredClone(fixture.script);
  input.characters = Array.from({ length: count }, (_, i) => ({ ...input.characters[i % 4], id: "cast_" + i, name: "可重复显示名" }));
  input.scenes.forEach((scene: typeof input.scenes[number], i: number) => {
    scene.character_ids = [input.characters[i % count].id];
    scene.dialogue.forEach((turn: typeof scene.dialogue[number], j: number) => { turn.speaker_id = input.characters[(i * 2 + j) % count].id; });
  });
  const parsed = validateScriptDraft(input, { durationSeconds: 24, presentationMode: "character_drama" });
  assert.deepEqual(parsed, input);
  assert.ok(isCharacterScript(parsed));
  assert.equal(parsed.characters.length, count);
});

test("MC-A04 offscreen speech, narrator, null voice and silent scenes can be saved without invented speech", () => {
  const input = structuredClone(fixture.script);
  input.characters[0].kind = "narrator";
  input.characters[0].appearance = "";
  input.characters[0].voice_profile_id = null;
  input.scenes.forEach((scene: typeof input.scenes[number]) => { scene.character_ids = scene.character_ids.filter((id: string) => id !== "shopkeeper"); });
  input.scenes[1].dialogue = [];
  assert.deepEqual(validateScriptDraft(input, { durationSeconds: 24 }), input);
  input.scenes.forEach((scene: typeof input.scenes[number]) => { scene.dialogue = []; });
  assert.deepEqual(validateScriptDraft(input, { durationSeconds: 24 }), input);
});

test("MC-A03 explicit mode mismatch cannot downgrade either format", () => {
  assert.throws(() => validateScriptDraft(fixture.script, { durationSeconds: 24, presentationMode: "narration" }), /不匹配/);
  assert.throws(() => validateScriptDraft({ scenes: [] }, { durationSeconds: 24, presentationMode: "character_drama" }), /不能退回/);
});

test("MC-A02: formal script parser round-trips four characters and eight turns without pseudo narration", () => {
  const script = validateScriptDraft(fixture.script, { durationSeconds: 24 });
  assert.deepEqual(script, fixture.script);
  assert.ok(script.scenes.every((scene) => !Object.hasOwn(scene, "narration")));
  assert.deepEqual(validateScriptDraft(JSON.parse(JSON.stringify(script)), { durationSeconds: 24 }), script);
});

test("MC-A03: unversioned character data cannot be silently stripped into a narration draft", () => {
  const input = structuredClone(fixture.script);
  delete input.version;
  for (const scene of input.scenes) scene.narration = "这是旧旁白。";
  assert.throws(() => validateScriptDraft(input, { durationSeconds: 24 }), /version|版本/);
});
