import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMediaCoverage,
  assertVoiceFits,
  compileTimeline,
  PlanContractError,
  type CutInput,
  type MaterializedMedia,
  type PlanErrorCode,
} from "../src/executable-timeline.js";

function cuts(durations: number[]): CutInput[] {
  return durations.map((durationSeconds, index) => ({
    scenePosition: index + 1,
    beatId: index < 2 ? "opening" : "payoff",
    assetKey: `asset-${index + 1}`,
    durationSeconds,
    sourceInSeconds: 0,
  }));
}

function hasCode(code: PlanErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof PlanContractError && error.code === code;
}

test("31.5秒在20–34秒区间内有效，不强行压到24秒", () => {
  const timeline = compileTimeline(cuts([4, 6, 3, 3, 3, 4, 7, 1.5]), { minSeconds: 20, maxSeconds: 34 });
  assert.equal(timeline.totalFrames, 945);
  assert.equal(timeline.cuts[7]!.frameCount, 45);
});

test("只有显式固定24秒时才要求720帧", () => {
  assert.equal(compileTimeline(cuts([8, 8, 8]), { minSeconds: 24, maxSeconds: 24 }).totalFrames, 720);
  assert.throws(() => compileTimeline(cuts([10, 10, 11.5]), { minSeconds: 24, maxSeconds: 24 }), hasCode("OUTSIDE_DURATION_RANGE"));
});

test("超出区间或低于下限不隐式归一化", () => {
  for (const durations of [[8, 8, 19], [6, 6, 6]]) {
    assert.throws(() => compileTimeline(cuts(durations), { minSeconds: 20, maxSeconds: 34 }), hasCode("OUTSIDE_DURATION_RANGE"));
  }
});

test("累计量化不产生逐镜取整的帧数漂移", () => {
  const timeline = compileTimeline(cuts([8.01, 8.01, 7.98]), { minSeconds: 20, maxSeconds: 30 });
  assert.equal(timeline.totalFrames, 720);
  assert.deepEqual(timeline.cuts.map((cut) => cut.startFrame), [0, 240, 481]);
  assert.equal(timeline.cuts.reduce((sum, cut) => sum + cut.frameCount, 0), 720);
});

test("两个镜头能属于同一叙事段并复用同一母片的不同区间", () => {
  const inputs = cuts([8, 8, 8]);
  inputs[1] = { ...inputs[1]!, assetKey: "asset-1", sourceInSeconds: 8 };
  const timeline = compileTimeline(inputs, { minSeconds: 20, maxSeconds: 30 });
  const media = new Map<string, MaterializedMedia>([
    ["asset-1", { mediaType: "video", durationSeconds: 16 }],
    ["asset-3", { mediaType: "image" }],
  ]);
  assert.equal(timeline.cuts[1]!.sourceInFrame, 240);
  assert.equal(timeline.cuts[0]!.beatId, timeline.cuts[1]!.beatId);
  assert.doesNotThrow(() => assertMediaCoverage(timeline, media));
});

test("复用源区间越界必须阻断", () => {
  const inputs = cuts([8, 8, 8]);
  inputs[0]!.sourceInSeconds = 4;
  const timeline = compileTimeline(inputs, { minSeconds: 20, maxSeconds: 30 });
  const media = new Map<string, MaterializedMedia>([["asset-1", { mediaType: "video", durationSeconds: 10 }]]);
  assert.throws(() => assertMediaCoverage(timeline, media), hasCode("SOURCE_RANGE_TOO_SHORT"));
});

test("长母片允许使用较短区间，不要求吃完所有采购秒数", () => {
  const timeline = compileTimeline(cuts([8, 8, 8]), { minSeconds: 20, maxSeconds: 30 });
  const media = new Map<string, MaterializedMedia>(timeline.cuts.map((cut) => [cut.assetKey, { mediaType: "video", durationSeconds: 10 }]));
  assert.doesNotThrow(() => assertMediaCoverage(timeline, media));
});

test("缺失素材和静态图片非法源区间不能假成功", () => {
  const inputs = cuts([8, 8, 8]);
  let timeline = compileTimeline(inputs, { minSeconds: 20, maxSeconds: 30 });
  assert.throws(() => assertMediaCoverage(timeline, new Map()), hasCode("MISSING_MEDIA"));
  inputs[0]!.sourceInSeconds = 1;
  timeline = compileTimeline(inputs, { minSeconds: 20, maxSeconds: 30 });
  assert.throws(() => assertMediaCoverage(timeline, new Map([["asset-1", { mediaType: "image" }]])), hasCode("INVALID_MEDIA"));
});

test("声音超过镜头先返回规划冲突，不暗改timeline", () => {
  const timeline = compileTimeline(cuts([8, 8, 8]), { minSeconds: 20, maxSeconds: 30 });
  const before = JSON.stringify(timeline);
  assert.throws(() => assertVoiceFits(timeline, [
    { scenePosition: 1, requiredSeconds: 8.2 },
    { scenePosition: 2, requiredSeconds: 7 },
    { scenePosition: 3, requiredSeconds: 7 },
  ]), hasCode("VOICE_DOES_NOT_FIT"));
  assert.equal(JSON.stringify(timeline), before);
});

test("区间内调整后声音和已有素材可以再次通过，实际时长可变", () => {
  const timeline = compileTimeline(cuts([8.2, 8, 8]), { minSeconds: 20, maxSeconds: 30 });
  assert.equal(timeline.totalFrames, 726);
  assert.doesNotThrow(() => assertVoiceFits(timeline, [
    { scenePosition: 1, requiredSeconds: 8.2 },
    { scenePosition: 2, requiredSeconds: 7 },
    { scenePosition: 3, requiredSeconds: 0 },
  ]));
  assert.doesNotThrow(() => assertMediaCoverage(timeline, new Map<string, MaterializedMedia>(
    timeline.cuts.map((cut) => [cut.assetKey, { mediaType: "video", durationSeconds: 10 }]),
  )));
});

test("缺失、重复、越界配音镜号拒绝", () => {
  const timeline = compileTimeline(cuts([8, 8, 8]), { minSeconds: 20, maxSeconds: 30 });
  for (const positions of [[1, 2], [1, 1, 3], [1, 2, 4]]) {
    assert.throws(() => assertVoiceFits(timeline, positions.map((scenePosition) => ({ scenePosition, requiredSeconds: 1 }))), hasCode("MISSING_VOICE"));
  }
});

test("不合法范围、非有限时间和镜号不连续拒绝", () => {
  for (const range of [{ minSeconds: 10, maxSeconds: 30 }, { minSeconds: 40, maxSeconds: 30 }, { minSeconds: 20, maxSeconds: 181 }]) {
    assert.throws(() => compileTimeline(cuts([8, 8, 8]), range), hasCode("INVALID_RANGE"));
  }
  for (const badDuration of [NaN, Infinity, -1, 0]) {
    assert.throws(() => compileTimeline(cuts([badDuration, 8, 8]), { minSeconds: 20, maxSeconds: 30 }), hasCode("INVALID_CUT"));
  }
  const inputs = cuts([8, 8, 8]);
  inputs[1]!.scenePosition = 4;
  assert.throws(() => compileTimeline(inputs, { minSeconds: 20, maxSeconds: 30 }), hasCode("INVALID_CUT"));
});

test("多组非领域化分镜均保持连续和精确总帧数", () => {
  for (let count = 3; count <= 24; count += 1) {
    for (const seconds of [20, 24, 31.5, 45, 90, 180]) {
      const inputs = cuts(Array.from({ length: count }, () => seconds / count));
      const timeline = compileTimeline(inputs, { minSeconds: 20, maxSeconds: 180 });
      assert.equal(timeline.totalFrames, Math.round(seconds * 30));
      for (let index = 1; index < timeline.cuts.length; index += 1) {
        const previous = timeline.cuts[index - 1]!;
        assert.equal(timeline.cuts[index]!.startFrame, previous.startFrame + previous.frameCount);
      }
    }
  }
});
