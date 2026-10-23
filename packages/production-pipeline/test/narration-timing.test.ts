import assert from "node:assert/strict";
import { it } from "node:test";
import { buildNarrationPlan } from "../src/narration-plan.js";
import { summarizeNarrationTiming } from "../src/narration-timing.js";

it("separates raw audio, explicit silence and extra gaps including the tail", () => {
  const plan = buildNarrationPlan([
    { position: 1, duration: 5, narration: "第一句。" },
    { position: 2, duration: 3, narration: "……" },
    { position: 3, duration: 6, narration: "下一句。" },
  ], "a".repeat(64), "b".repeat(64));
  plan.groups[1]!.placement = { anchor: "end", offsetFrames: 30 };
  const doc = { narrationPlan: plan, groups: [
    { ...plan.groups[0], sourceAudioSamples: 2 * 44100, startSample: 0, endSample: 2 * 44100 },
    { ...plan.groups[1], sourceAudioSamples: 3 * 44100, startSample: 10 * 44100, endSample: 13 * 44100 },
  ] };
  const summary = summarizeNarrationTiming(plan, doc)!;
  assert.equal(summary.durationSeconds, 14);
  assert.equal(summary.sourceAudioSeconds, 5);
  assert.equal(summary.explicitSilenceSeconds, 4, "显式镜头留白和用户偏移都保留");
  assert.equal(summary.unfilledSeconds, 5);
  assert.deepEqual(summary.unfilledRanges, [{ startSeconds: 2, endSeconds: 5 }, { startSeconds: 8, endSeconds: 10 }]);
  assert.equal(summary.groups[1]!.requiredFrames, 120);
  assert.equal(summarizeNarrationTiming(plan, { ...doc, narrationPlan: { ...plan, visualPlan: { ...plan.visualPlan, sha256: "c".repeat(64) } } }), undefined);
  assert.equal(summarizeNarrationTiming(plan, { ...doc, groups: [doc.groups[0]] }), undefined);
});

it("does not hide leftover time at the end after continuous narration", () => {
  const plan = buildNarrationPlan([{ position: 1, duration: 6, narration: "一句话跨过" },
    { position: 2, duration: 4, narration: "两个镜头。" }], "a".repeat(64), "b".repeat(64));
  const summary = summarizeNarrationTiming(plan, { narrationPlan: plan, groups: [
    { ...plan.groups[0], sourceAudioSamples: 7 * 44100, startSample: 0, endSample: 7 * 44100 },
  ] })!;
  assert.deepEqual(summary.unfilledRanges, [{ startSeconds: 7, endSeconds: 10 }]);
  assert.equal(summary.groups[0]!.requiredFrames, 210);
  assert.equal(summary.groups[0]!.availableFrames, 300);
});

it("supports verified legacy scene plans without guessing missing audio length", () => {
  const plan = buildNarrationPlan([{ position: 1, duration: 4, narration: "一句。" }], "a".repeat(64), "b".repeat(64));
  plan.groups[0]!.id = "legacy-scene-1";
  const doc = { version: "video-factory/voiceover-plan-v2", scenes: [
    { position: 1, narration: "一句。", source_speech_duration: 2.5 },
  ] };
  assert.equal(summarizeNarrationTiming(plan, doc)!.unfilledSeconds, 1.5);
  assert.equal(summarizeNarrationTiming(plan, { ...doc, scenes: [{ position: 1, narration: "一句。" }] }), undefined);
});
