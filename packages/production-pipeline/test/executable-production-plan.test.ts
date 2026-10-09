import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const shared = JSON.parse(readFileSync(new URL("../../../tests/fixtures/content-led-timeline-cases.json", import.meta.url), "utf8")) as {
    cases: Array<{ id: string; durations: number[]; frames: number[]; range?: unknown; valid: boolean }>;
  };
  for (const item of shared.cases) it(`shares exact content-led decimal and cumulative frame semantics: ${item.id}`, () => {
    const input = {
      durationPolicy: "content-led-v1", scriptArtifactId: "script-v2", directorArtifactId: "director-v2",
      ...(Object.hasOwn(item, "range") ? { durationRange: item.range } : {}),
      scenes: item.durations.map((duration, i) => ({ position: i + 1, duration })),
      shots: item.durations.map((duration, i) => ({ scenePosition: i + 1,
        temporalBeats: [{ startSeconds: 0, endSeconds: duration, action: "完整片段" }] })),
    } as CompileExecutableProductionPlanInput;
    if (!item.valid) {
      assert.throws(() => compileExecutableProductionPlan(input));
      let startFrame = 0;
      const cuts = item.frames.map((frameCount, index) => {
        const cut = { scenePosition: index + 1, beatId: `beat-${index + 1}`, assetKey: `asset-${index + 1}`,
          startFrame, frameCount, sourceInFrame: 0 };
        startFrame += frameCount;
        return cut;
      });
      assert.throws(() => parseExecutableProductionPlan({ version: "video-factory/executable-plan-v2",
        durationPolicy: "content-led-v1", scriptArtifactId: "script-v2", directorArtifactId: "director-v2",
        candidateArtifactIds: [], fps: 30, totalFrames: startFrame, cuts, durationRange: item.range }));
      return;
    }
    const plan = compileExecutableProductionPlan(input);
    assert.deepEqual(plan.cuts.map(cut => cut.frameCount), item.frames);
    assert.equal(plan.totalFrames, item.frames.reduce((sum, value) => sum + value, 0));
    assert.deepEqual(plan.durationRange, item.range);
    assert.deepEqual(parseExecutableProductionPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.throws(() => parseExecutableProductionPlan({ ...plan, version: "video-factory/executable-plan-v1" }));
    assert.throws(() => parseExecutableProductionPlan({ ...plan, durationPolicy: undefined }));
    for (const invalid of [true, NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parseExecutableProductionPlan({ ...plan, totalFrames: invalid }));
    }
    for (const field of ["frameCount", "startFrame", "sourceInFrame"]) {
      for (const invalid of [true, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => parseExecutableProductionPlan({ ...plan, cuts: [
          { ...plan.cuts[0], [field]: invalid }, ...plan.cuts.slice(1),
        ] }));
      }
    }
  });
  it("compiles and reads content-led plan-v2 without inventing a duration range", () => {
    const plan = compileExecutableProductionPlan({
      scriptArtifactId: "script-v2", directorArtifactId: "director-v2", durationPolicy: "content-led-v1",
      scenes: [{ position: 1, duration: 12 }],
      shots: [{ scenePosition: 1, temporalBeats: [{ startSeconds: 0, endSeconds: 12, action: "完整一幕" }] }],
    });
    assert.equal(plan.version, "video-factory/executable-plan-v2");
    assert.equal(plan.durationPolicy, "content-led-v1");
    assert.equal(Object.hasOwn(plan, "durationRange"), false);
    assert.equal(plan.totalFrames, 360);
    assert.deepEqual(parseExecutableProductionPlan(JSON.parse(JSON.stringify(plan))), plan);
  });
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
