import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planVisualDirection } from "../src/shared/visual-plan.js";

describe("planVisualDirection", () => {
  it("builds a three-beat executable plan for an ordinary-life topic", () => {
    const plan = planVisualDirection({
      title: "下班后什么都不想做，是懒还是耗竭？",
      hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
      category: "lifestyle",
    });

    assert.equal(plan.beats.length, 3);
    assert.deepEqual(plan.beats.map((beat) => beat.duration), ["0-3 秒", "3-14 秒", "14-24 秒"]);
    assert.equal(plan.beats[0]?.source, "creator");
    assert.match(plan.beats[0]?.searchQuery ?? "", /下班后什么都不想做/);
    assert.match(plan.beats[1]?.description ?? "", /环境|动作/);
  });

  it("honors a series visual direction while keeping source choices editable", () => {
    const plan = planVisualDirection({
      title: "AI 下班实验室 04｜真实任务实验",
      hook: "这一集直接验证真实任务。",
      category: "technology",
      visualStyle: "真实桌面操作与生活空镜",
    });

    assert.match(plan.strategy, /真实桌面操作与生活空镜/);
    assert.equal(plan.beats[1]?.source, "screen");
    assert.equal(plan.beats.every((beat) => Boolean(beat.searchQuery)), true);
  });
});
