import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { briefAuditContext, briefAuditProjection } from "../src/codex-brief-audit.js";
import type { ProductionBrief } from "../src/contracts.js";

function briefWith(overrides: Partial<ProductionBrief>): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "下班后，给自己半分钟看海",
    angle: "纯海浪与海岸，免费实拍素材。30到45秒竖屏，中文轻声旁白字幕，不需人物或特定地点。",
    audience: "下班后想短暂放松的普通成年人",
    nicheSlug: "ordinary-life",
    durationSeconds: 30,
    platform: "douyin",
    reviewMode: "manual",
    runPurpose: "production",
    providers: {},
    ...overrides,
  } as ProductionBrief;
}

describe("brief audit keeps user requirements without a generated plan", () => {
  it("preserves the user's words and creates no narrative scaffold", () => {
    const projection = briefAuditProjection(briefWith({ visualIntent: "纯海浪与海岸，不需人物" }));
    assert.equal(projection.visualIntent, "纯海浪与海岸，不需人物");
    assert.equal(projection.angle, briefWith({}).angle);
    assert.equal(projection.visualPlan, undefined);
    assert.equal(projection.visualPlanProvenance, undefined);
    const context = briefAuditContext(projection);
    assert.deepEqual(context.brief, projection);
  });
});
