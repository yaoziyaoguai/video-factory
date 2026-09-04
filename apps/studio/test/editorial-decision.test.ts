import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEditorialFormat } from "../src/server/editorial-decision.js";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";

const base = {
  origin: "trend" as const,
  title: "普通人开始用 AI 管理下班后的时间",
  track: "ai-daily-life",
  audience: "每天被重复安排拖累的普通上班族",
  painPoint: "下班后仍要花半小时重复整理待办",
  hook: "同一份下班清单，AI 到底能不能省下 30 分钟？",
  evidence: [{ source: "真实任务记录", evidenceUrl: "https://example.com/ai-workflow" }],
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

  it("does not let a blocked series candidate bypass the evidence gate", () => {
    const decision = decideEditorialFormat({
      ...base,
      origin: "series",
      verification: {
        status: "blocked",
        independentSources: 0,
        requiredSources: 1,
        reasons: ["本集关键结论还没有可核验来源。"],
      },
    });

    assert.equal(decision.verdict, "skip");
    assert.equal(decision.score, 0);
    assert.match(decision.reasons.join(" "), /关键结论|证据/);
  });

  it("rejects a vague trend before production even when its aggregate scores are high", () => {
    const decision = decideEditorialFormat({
      ...base,
      audience: "所有人",
      painPoint: "想变好",
      hook: "聊聊 AI",
      evidence: [],
    });

    assert.equal(decision.verdict, "skip");
    assert.match(decision.reasons.join(" "), /受众|痛点|开场|证据/);
  });

  it("does not let a series label bypass viral readiness, risk, visual feasibility, or the video gate", () => {
    const vague = decideEditorialFormat({
      ...base,
      origin: "series",
      audience: "所有人",
      painPoint: "想变好",
      hook: "聊聊 AI",
      evidence: [],
    });
    const risky = decideEditorialFormat({
      ...base,
      origin: "series",
      risk: "review",
      score: { ...base.score, complianceRisk: 60 },
    });
    const unfilmable = decideEditorialFormat({
      ...base,
      origin: "series",
      score: { ...base.score, visualFeasibility: 50 },
    });
    const belowVideoGate = decideEditorialFormat({
      ...base,
      origin: "series",
      title: "AI 与普通工作的关系",
      score: { ...base.score, audienceReach: 59, visualFeasibility: 77 },
    });

    assert.equal(vague.verdict, "skip");
    assert.equal(risky.verdict, "produce_image_story");
    assert.equal(unfilmable.verdict, "produce_image_story");
    assert.equal(belowVideoGate.verdict, "skip");
  });

  it("keeps qualified series candidates on the shared video gate and selects a template by shape", () => {
    const decision = decideEditorialFormat({
      ...base,
      origin: "series",
      freshness: "evergreen",
      title: "AI 下班实验室 04｜真实任务实验",
    });
    const comparison = decideEditorialFormat({
      ...base,
      origin: "series",
      freshness: "evergreen",
      title: "AI 下班实验室 05｜两款助手横评怎么选",
    });
    const observational = decideEditorialFormat({
      ...base,
      origin: "series",
      freshness: "evergreen",
      title: "下班观察 06｜一个上班族的真实变化",
    });

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.recommendedTemplate?.id, "product-demo");
    assert.equal(comparison.verdict, "produce_video");
    assert.equal(comparison.recommendedTemplate?.id, "ranked-comparison");
    assert.equal(observational.verdict, "produce_video");
    assert.equal(observational.recommendedTemplate?.id, "human-mini-doc");
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

  it("keeps a comparison topic's audience, hook, value, evidence, template, shots, and sound in one intent", () => {
    const comparison = {
      ...base,
      title: "两款 AI 会议助手横评：谁真能省下 30 分钟返工",
      track: "ai-tool-comparison",
      freshness: "evergreen" as const,
      audience: "每周需要整理多场会议纪要的项目经理",
      painPoint: "会议结束后还要反复核对遗漏并返工半小时",
      hook: "同一段录音、同样 10 分钟，两款工具谁会漏掉关键决定？",
      evidence: [
        { source: "同条件测试录像", evidenceUrl: "https://example.com/test-video" },
        { source: "原始会议纪要", evidenceUrl: "https://example.com/source-notes" },
      ],
    };

    const decision = decideEditorialFormat(comparison);
    const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === decision.recommendedTemplate?.id);

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.recommendedTemplate?.id, "ranked-comparison");
    assert.match(decision.reasons.join(" "), /项目经理|返工半小时/);
    assert.match(decision.guardrails.join(" "), /同一段录音|同条件测试录像|原始会议纪要/);
    assert.equal(template?.storyStructure[0]?.id, "stakes");
    assert.match(template?.storyStructure[0]?.purpose ?? "", /选错|损失|必要性/);
    assert.match(template?.shotSlots[0]?.purpose ?? "", /展示选错代价/);
    assert.equal(template?.shotSlots.every((slot) => /展示|公布|完成|放大|揭示|匹配|给出|结束/.test(slot.purpose)), true);
    assert.match(template?.soundSystem.voiceIntent ?? "", /公平|条件式判断|先说标准/);
  });
});
