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

// DF-02：系统在用户没有填写画面要求时会把选题的自动 visualPlan 带进简报，作为默认方向。
// 审计必须能把它与用户的明确要求区分开：未采用的建议不是必须满足的约束，与标题/角度的
// 分歧不构成“需要人工修复的简报缺陷”。
describe("brief audit projection separates system suggestions from user requirements", () => {
  it("marks a creation-confirmed unadopted visual plan as a system-suggested reference", () => {
    const projection = briefAuditProjection(briefWith({
      visualPlanAdopted: false,
      visualPlan: {
        strategy: "人物近景、生活动作与环境细节。优先使用可验证的素材库实拍。",
        beats: [{ id: "hook", role: "冲突钩子", duration: "0-3 秒", description: "人物特写", searchQuery: "下班后 人物", source: "stock" }],
      },
    }));
    assert.equal(projection.visualPlanProvenance, "system_suggested_reference");
    assert.ok(projection.visualPlan);
  });

  it("does not downgrade a visual plan without adoption evidence or one the user adopted", () => {
    const plan = {
      strategy: "纯海浪与海岸。优先使用可验证的素材库实拍。",
      beats: [{ id: "hook", role: "冲突钩子", duration: "0-3 秒", description: "海浪特写", searchQuery: "海浪 竖屏", source: "stock" as const }],
    };
    // 来源未知（历史 run）：不替用户作降级决定。
    const unknown = briefAuditProjection(briefWith({ visualPlan: plan }));
    assert.equal(unknown.visualPlanProvenance, undefined);
    // 用户明确采用：保留要求身份。
    const adopted = briefAuditProjection(briefWith({ visualPlanAdopted: true, visualPlan: plan }));
    assert.equal(adopted.visualPlanProvenance, undefined);
    // 与用户要求并存但来源未知：同样不降级。
    const withIntent = briefAuditProjection(briefWith({ visualIntent: "纯海浪与海岸，不需人物", visualPlan: plan }));
    assert.equal(withIntent.visualPlanProvenance, undefined);
  });

  it("does not invent a provenance marker when there is no visual plan", () => {
    const projection = briefAuditProjection(briefWith({ visualIntent: "纯海浪与海岸，不需人物" }));
    assert.equal(projection.visualPlan, undefined);
    assert.equal(projection.visualPlanProvenance, undefined);
    assert.equal(projection.visualIntent, "纯海浪与海岸，不需人物");
  });

  it("tells the auditor in scope that unadopted plans are references the user can override", () => {
    const scope = briefAuditContext(briefAuditProjection(briefWith({})));
    const note = JSON.stringify(scope);
    assert.match(String((scope.roleScope as Record<string, unknown>).visualPlan ?? ""), /不是.*要求/);
    assert.match(note, /system_suggested_reference/);
  });
});
