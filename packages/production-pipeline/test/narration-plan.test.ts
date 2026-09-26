import assert from "node:assert/strict";
import { it } from "node:test";
import { buildNarrationPlan, validateNarrationPlan } from "../src/narration-plan.js";

it("joins adjacent speech across cuts, protects explicit silence and only allows confirmed placement edits", () => {
  const scenes = [{ position: 1, duration: 6, narration: "别急，" },
    { position: 2, duration: 6, narration: "先看看。" },
    { position: 3, duration: 2, narration: "……" },
    { position: 4, duration: 6, narration: "然后出发。" }];
  const plan = buildNarrationPlan(scenes, "a".repeat(64), "b".repeat(64));
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups[0]?.text, "别急， 先看看。");
  assert.deepEqual(plan.silences, [{ id: "silence-3", startFrame: 360, endFrame: 420, source: "legacy_silent_scene" }]);
  const edited = structuredClone(plan);
  edited.groups[1]!.placement = { anchor: "end", offsetFrames: 6 };
  assert.deepEqual(validateNarrationPlan(edited, plan), edited);
  edited.groups[0]!.text = "系统偷偷改了稿";
  assert.throws(() => validateNarrationPlan(edited, plan), /旁白|plan/);
  assert.throws(() => validateNarrationPlan(plan, { ...plan, script: { sha256: "c".repeat(64) } }), /旁白|plan/);
});
