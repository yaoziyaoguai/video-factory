import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferVisualCategory } from "../src/shared/visual-plan.js";

describe("选题分类不生成创作结构", () => {
  it("仍按内容分类并忽略明确否认的主题", () => {
    assert.equal(inferVisualCategory("手机系统权限设置"), "technology");
    assert.equal(inferVisualCategory("记录窗边的光，不承诺财经收益。"), "lifestyle");
    assert.equal(inferVisualCategory("亲子绘本"), "parenting");
  });
});
