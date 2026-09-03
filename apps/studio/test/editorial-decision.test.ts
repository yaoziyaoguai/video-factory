import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEditorialFormat } from "../src/server/editorial-decision.js";

const base = {
  origin: "trend" as const,
  title: "普通人开始用 AI 管理下班后的时间",
  track: "ai-daily-life",
  category: "technology" as const,
  freshness: "live" as const,
  risk: "low" as const,
  verification: {
    status: "ready" as const,
    independentSources: 1,
    requiredSources: 1,
    reasons: ["常规风险候选。"],
  },
  score: {
    audienceReach: 86,
    visualFeasibility: 84,
    productionCostEfficiency: 88,
    novelty: 76,
    monetization: 62,
    seriesPotential: 82,
    complianceRisk: 12,
    final: 83,
  },
};

describe("editorial production decision", () => {
  it("recommends motion video when the topic has visual action and creative value", () => {
    const decision = decideEditorialFormat(base);

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.score >= 70, true);
    assert.match(decision.reasons.join(" "), /画面|演示|行动/);
  });

  it("routes static official updates to an evidence-led image story", () => {
    const decision = decideEditorialFormat({
      ...base,
      title: "警方通报一项社会事件调查进展",
      category: "society",
      risk: "review",
      verification: { ...base.verification, status: "review_required" },
      score: { ...base.score, visualFeasibility: 52, novelty: 46, complianceRisk: 60, final: 59 },
    });

    assert.equal(decision.verdict, "produce_image_story");
    assert.match(decision.guardrails.join(" "), /原始来源|虚构|生成/);
  });

  it("skips a high-risk trend when evidence readiness is blocked", () => {
    const decision = decideEditorialFormat({
      ...base,
      title: "重大事故伤亡消息持续更新",
      category: "society",
      risk: "high",
      verification: {
        status: "blocked",
        independentSources: 1,
        requiredSources: 2,
        reasons: ["高风险热点至少需要 2 个独立来源。"],
      },
      score: { ...base.score, complianceRisk: 72, final: 61 },
    });

    assert.equal(decision.verdict, "skip");
    assert.equal(decision.score, 0);
    assert.match(decision.reasons.join(" "), /证据/);
  });

  it("keeps durable series candidates on the video path", () => {
    const decision = decideEditorialFormat({
      ...base,
      origin: "series",
      freshness: "evergreen",
      title: "AI 下班实验室 04｜真实任务实验",
    });

    assert.equal(decision.verdict, "produce_video");
    assert.match(decision.reasons.join(" "), /系列/);
  });

  it("requires every viral-video gate to clear its exact boundary", () => {
    const passing = {
      ...base,
      title: "三步实测 AI 如何减少重复工作",
      freshness: "evergreen" as const,
      score: {
        ...base.score,
        audienceReach: 60,
        visualFeasibility: 68,
        novelty: 55,
        complianceRisk: 45,
        final: 70,
      },
    };
    assert.equal(decideEditorialFormat(passing).verdict, "produce_video");
    for (const score of [
      { audienceReach: 59 },
      { visualFeasibility: 67 },
      { novelty: 54 },
      { complianceRisk: 46 },
    ]) {
      assert.equal(decideEditorialFormat({ ...passing, score: { ...passing.score, ...score } }).verdict, "skip");
    }
    assert.equal(decideEditorialFormat({
      ...passing,
      title: "AI 与普通工作的关系",
      score: { ...passing.score, visualFeasibility: 77 },
    }).verdict, "skip");
  });

  it("maps each motion-video shape to a concrete production template", () => {
    const productDemo = decideEditorialFormat({ ...base, title: "实测 AI 如何整理一份会议记录", freshness: "evergreen" });
    const liveBrief = decideEditorialFormat({ ...base, title: "AI 助手进入普通人的工作", freshness: "live" });
    const miniDoc = decideEditorialFormat({ ...base, title: "乡村青年返乡后的真实工作", category: "agriculture-rural", freshness: "evergreen" });
    const explainer = decideEditorialFormat({ ...base, title: "为什么 AI 会改变普通人的工作分工", freshness: "evergreen" });

    assert.equal(productDemo.recommendedTemplate?.id, "product-demo");
    assert.equal(liveBrief.recommendedTemplate?.id, "trend-fact-brief");
    assert.equal(miniDoc.recommendedTemplate?.id, "human-mini-doc");
    assert.equal(explainer.recommendedTemplate?.id, "knowledge-explainer");
  });
});
