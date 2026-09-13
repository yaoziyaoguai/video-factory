import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileExecutableProductionPlan,
  parseExecutableProductionPlan,
  type CompileExecutableProductionPlanInput,
} from "../src/executable-production-plan.js";

const range = { minSeconds: 20, maxSeconds: 34 };

function input(): CompileExecutableProductionPlanInput {
  return {
    scriptArtifactId: "artifact-script",
    directorArtifactId: "artifact-director",
    candidateArtifactIds: ["artifact-candidates"],
    durationRange: range,
    scenes: [
      { position: 1, duration: 15, beatId: "opening" },
      { position: 2, duration: 16.5, beatId: "payoff" },
    ],
    shots: [
      {
        scenePosition: 1,
        temporalBeats: [
          { startSeconds: 0, endSeconds: 6, action: "建立问题" },
          { startSeconds: 6, endSeconds: 12, action: "推进动作" },
        ],
        sourceInSeconds: 0,
      },
      {
        scenePosition: 2,
        reuseFromScenePosition: 1,
        temporalBeats: [
          { startSeconds: 0, endSeconds: 6, action: "展示结果" },
          { startSeconds: 6, endSeconds: 12, action: "收束结论" },
        ],
        sourceInSeconds: 0,
      },
    ],
  };
}

describe("compileExecutableProductionPlan", () => {
  it("blocks mismatched role timing instead of letting a director score replace the script timeline", () => {
    assert.throws(() => compileExecutableProductionPlan(input()), /director timing.*scene 1.*15s/i);

    const accepted = input();
    accepted.shots[0]!.temporalBeats[1]!.endSeconds = 15;
    accepted.shots[1]!.temporalBeats[1]!.endSeconds = 16.5;
    const plan = compileExecutableProductionPlan(accepted);

    assert.equal(plan.version, "video-factory/executable-plan-v1");
    assert.equal(plan.totalFrames, 945);
    assert.equal(plan.fps, 30);
    assert.deepEqual(plan.durationRange, range);
    assert.equal(plan.scriptArtifactId, "artifact-script");
    assert.equal(plan.directorArtifactId, "artifact-director");
    assert.deepEqual(plan.candidateArtifactIds, ["artifact-candidates"]);
    assert.deepEqual(plan.cuts.map((cut) => cut.startFrame), [0, 450]);
    assert.equal(plan.cuts[0]!.assetKey, plan.cuts[1]!.assetKey);
  });

  it("uses legacy beat ids without claiming a treatment artifact", () => {
    const accepted = input();
    delete accepted.scenes[0]!.beatId;
    delete accepted.scenes[1]!.beatId;
    accepted.shots[0]!.temporalBeats[1]!.endSeconds = 15;
    accepted.shots[1]!.temporalBeats[1]!.endSeconds = 16.5;

    const plan = compileExecutableProductionPlan(accepted);
    assert.deepEqual(plan.cuts.map((cut) => cut.beatId), ["legacy-scene-1", "legacy-scene-2"]);
    assert.equal("treatmentArtifactId" in plan, false);
  });

  it("rejects missing parents, duplicate candidates, invalid routes, and a fixed 24-second range", () => {
    const accepted = input();
    accepted.shots[0]!.temporalBeats[1]!.endSeconds = 15;
    accepted.shots[1]!.temporalBeats[1]!.endSeconds = 16.5;

    assert.throws(() => compileExecutableProductionPlan({ ...accepted, scriptArtifactId: "" }), /scriptArtifactId/);
    assert.throws(() => compileExecutableProductionPlan({ ...accepted, candidateArtifactIds: ["same", "same"] }), /candidateArtifactIds/);
    assert.throws(() => compileExecutableProductionPlan({ ...accepted, shots: accepted.shots.slice(0, 1) }), /same scene positions/);
    assert.throws(() => compileExecutableProductionPlan({
      ...accepted,
      durationRange: { minSeconds: 24, maxSeconds: 24 },
    }), /不在.*范围/);
  });

  it("parses a persisted plan and rejects corrupt frame totals", () => {
    const accepted = input();
    accepted.shots[0]!.temporalBeats[1]!.endSeconds = 15;
    accepted.shots[1]!.temporalBeats[1]!.endSeconds = 16.5;
    const plan = compileExecutableProductionPlan(accepted);

    assert.deepEqual(parseExecutableProductionPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.throws(() => parseExecutableProductionPlan({ ...plan, totalFrames: 944 }), /totalFrames/);
  });

  it("round-trips escaped identifiers and rejects empty or duplicate scene sets", () => {
    const accepted = input();
    accepted.scenes[0]!.beatId = "opening-\"quoted\"\nline";
    accepted.shots[0]!.temporalBeats[1]!.endSeconds = 15;
    accepted.shots[1]!.temporalBeats[1]!.endSeconds = 16.5;
    const plan = compileExecutableProductionPlan(accepted);

    assert.equal(parseExecutableProductionPlan(JSON.parse(JSON.stringify(plan))).cuts[0]?.beatId, accepted.scenes[0]!.beatId);
    assert.throws(() => compileExecutableProductionPlan({ ...accepted, scenes: [], shots: [] }), /时间轴不能为空/);
    assert.throws(() => compileExecutableProductionPlan({
      ...accepted,
      scenes: [accepted.scenes[0]!, { ...accepted.scenes[1]!, position: 1 }],
    }), /contiguous scene positions/);
  });
});
