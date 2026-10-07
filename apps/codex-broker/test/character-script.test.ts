import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateTaskPayload } from "../src/codex-executor.js";
import { outputValidationErrorFor, providerOutputSchemaFor } from "../src/task-definitions.js";
import { summarizeProductionCapabilities } from "../../../packages/production-pipeline/src/production-capabilities.js";
const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/character-drama-cases.json", import.meta.url), "utf8"));
test("MC-A05 selects director-v2 and retains character bindings in the broker input", () => {
  const schema = providerOutputSchemaFor("director-plan", "character_drama");
  assert.equal((schema.properties as Record<string, { const?: string }>).version!.const, "video-factory/director-plan-v2");
  const brief = { title: "找钥匙", angle: "四人对白", audience: "青年", platform: "douyin", durationSeconds: 24,
    presentationMode: "character_drama", characters: fixture.script.characters, productionCapabilities: summarizeProductionCapabilities([]) };
  const task = validateTaskPayload("director-plan", { directorProfiles: [], brief, scenes: fixture.script.scenes,
    assetProviders: [], economics: { allowMeteredProviders: false } });
  if (task.kind !== "director-plan") throw new Error("wrong task");
  assert.deepEqual(task.payload.brief, brief);
  assert.deepEqual(task.payload.scenes, fixture.script.scenes);
  assert.throws(() => validateTaskPayload("director-plan", { directorProfiles: [], brief: { ...brief, presentationMode: "wrong" },
    scenes: [], assetProviders: [], economics: { allowMeteredProviders: false } }), /presentationMode/);
});

test("MC-A05 strict provider receives one selected root schema rather than a root union", () => {
  for (const mode of ["narration", "character_drama"] as const) {
    const schema = providerOutputSchemaFor("script-draft", mode);
    assert.equal(schema.type, "object");
    assert.equal(schema.anyOf, undefined);
    assert.equal(schema.additionalProperties, false);
    assert.equal((schema.required as string[]).includes("characters"), mode === "character_drama");
  }
});

test("MC-A05 Broker retains the exact supplied mode and system voice catalog", () => {
  const brief = { title: "找钥匙", angle: "四人轮流对白", audience: "年轻观众", nicheSlug: "life", platform: "douyin", durationSeconds: 24,
    presentationMode: "character_drama", characterVoiceProfiles: [{ id: "minimax:female-chengshu", label: "成熟女声", providerId: "minimax-tts-v1" }],
    productionCapabilities: summarizeProductionCapabilities([]) };
  const task = validateTaskPayload("script-draft", { brief });
  if (task.kind !== "script-draft") throw new Error("wrong task");
  assert.equal(task.payload.brief.presentationMode, "character_drama");
  assert.deepEqual(task.payload.brief.characterVoiceProfiles, brief.characterVoiceProfiles);
  assert.throws(() => validateTaskPayload("script-draft", { brief: { ...brief, presentationMode: "invented" } }), /presentationMode/);
});

test("MC-A05 Broker accepts a saved character script for discussion without inventing narration", () => {
  const task = validateTaskPayload("creative-discussion", { stage: "script", requestMode: "discuss",
    currentDocument: fixture.script, context: {}, message: "把店主说的话改得更自然。", recentMessages: [] });
  assert.equal(task.kind, "creative-discussion");
  if (task.kind !== "creative-discussion") throw new Error("wrong task");
  assert.deepEqual(task.payload.currentDocument, fixture.script);
});

test("MC-A05 character production and revision output schemas preserve speaker identities", () => {
  const script = structuredClone(fixture.script);
  for (const scene of script.scenes) Object.assign(scene, { on_screen_text: "", sound_cue: "自然对白", success_criteria: ["角色动作清楚"], failure_conditions: ["角色被删去"] });
  assert.equal(outputValidationErrorFor("script-draft", script), undefined);
  assert.equal(outputValidationErrorFor("creative-discussion", { stage: "script", intent: "revise", reply: "已修改台词。",
    changeSummary: ["店主用短句表达。"], script, treatment: null, director: null, upstreamRequest: null }), undefined);
  script.scenes[0].dialogue[0].speaker_id = "missing";
  assert.notEqual(outputValidationErrorFor("script-draft", script), undefined);
  assert.notEqual(outputValidationErrorFor("creative-discussion", { stage: "script", intent: "revise", reply: "修订。",
    changeSummary: [], script, treatment: null, director: null, upstreamRequest: null }), undefined);
});
