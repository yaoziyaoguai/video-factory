import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEditorialFormat as decideEditorialFormatWithTemplates } from "../src/server/editorial-decision.js";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";

const decideEditorialFormat = (input: Parameters<typeof decideEditorialFormatWithTemplates>[0]) => (
  decideEditorialFormatWithTemplates(input, BUILTIN_TEMPLATES)
);

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

  it("keeps everyday guidance with ambiguous words on an action-led video format", () => {
    for (const input of [
      { title: "三步化解亲子冲突", category: "parenting" as const },
      { title: "如何回应孩子突然发脾气", category: "parenting" as const },
      { title: "家长如何回应学校的临时安排", category: "parenting" as const },
      { title: "做饭前避免厨房事故的三个检查", category: "food" as const },
    ]) {
      const decision = decideEditorialFormat({
        ...base,
        ...input,
        freshness: "evergreen",
      });

      assert.equal(decision.verdict, "produce_video", input.title);
      assert.equal(decision.recommendedTemplate, undefined, input.title);
    }
  });

  it("still treats a real public-event response as an evidence-led update", () => {
    const decision = decideEditorialFormat({
      ...base,
      title: "警方回应公共安全事故调查进展",
      category: "society",
      risk: "review",
      verification: { ...base.verification, status: "review_required" },
      score: { ...base.score, complianceRisk: 60 },
    });

    assert.equal(decision.verdict, "produce_image_story");
    assert.equal(decision.recommendedTemplate, undefined);
  });

  it("keeps the format recommendation visible while a high-risk trend remains source-blocked", () => {
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

    assert.equal(decision.verdict, "produce_image_story");
    assert.equal(decision.score > 0, true);
    assert.equal(decision.recommendedTemplate, undefined);
    assert.match(decision.guardrails.join(" "), /高风险热点至少需要 2 个独立来源/);
  });

  it("scores a blocked series candidate independently from its evidence gate", () => {
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

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.score > 0, true);
    assert.equal(decision.recommendedTemplate, undefined);
    assert.match(decision.guardrails.join(" "), /本集关键结论还没有可核验来源/);
  });

  it("rejects a vague trend before production even when its aggregate scores are high", () => {
    const decision = decideEditorialFormat({
      ...base,
      audience: "",
      painPoint: "",
      hook: "",
      evidence: [],
    });

    assert.equal(decision.verdict, "skip");
    assert.match(decision.reasons.join(" "), /受众|痛点|开场/);
  });

  it("does not promote an unaudited rule fallback to a production recommendation", () => {
    const decision = decideEditorialFormat({ ...base, providerId: "trend-heuristic-v1" });

    assert.equal(decision.verdict, "skip");
    assert.equal(decision.score, 0);
    assert.match(decision.reasons.join(" "), /规则保底候选|选题总编/);
  });

  it("marks every rule-baseline decision as pending editor review so clients never show a fake zero", () => {
    // 来源不达标（blocked）：规则结论同样没有经过总编。
    const blocked = decideEditorialFormat({
      ...base,
      providerId: "trend-heuristic-v1",
      verification: {
        status: "blocked",
        independentSources: 0,
        requiredSources: 2,
        reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接，补齐前不会进入制作推荐。"],
      },
    });
    assert.equal(blocked.pendingEditorReview, true);

    // 来源已补齐：仍未经过总编，标记必须保留，等待评估不是“总编评分 0”。
    const ready = decideEditorialFormat({ ...base, providerId: "trend-heuristic-v1" });
    assert.equal(ready.pendingEditorReview, true);

    // 有总编产出的候选：不带 pending 标记，分数就是总编口径的结论。
    const modelEvaluated = decideEditorialFormat(base);
    assert.equal(modelEvaluated.pendingEditorReview, undefined);
    assert.equal(modelEvaluated.verdict, "produce_video");
  });

  it("does not let a series label bypass viral readiness, risk, visual feasibility, or the video gate", () => {
    const vague = decideEditorialFormat({
      ...base,
      origin: "series",
      audience: "",
      painPoint: "",
      hook: "",
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

  it("keeps qualified series candidates on the shared video gate without locking a template by shape", () => {
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
      category: "local-culture",
      title: "下班观察 06｜一个上班族的真实变化",
    });
    // 系列入口不再整体锁定在微纪录：非纪实类别回到与热点一致的形态检测。
    const technology = decideEditorialFormat({
      ...base,
      origin: "series",
      freshness: "evergreen",
      title: "下班随想 07｜为什么周末总是过得更快",
    });

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.recommendedTemplate, undefined);
    assert.equal(comparison.verdict, "produce_video");
    assert.equal(comparison.recommendedTemplate, undefined);
    assert.equal(observational.verdict, "produce_video");
    assert.equal(observational.recommendedTemplate, undefined);
    assert.equal(technology.verdict, "produce_video");
    assert.equal(technology.recommendedTemplate, undefined);
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
    }).verdict, "produce_video");
  });

  it("does not change a semantic recommendation because of punctuation or numeral style", () => {
    const poetic = {
      ...base,
      title: "把回家的路，拍成一封寄给未来的信",
      hook: "熟悉的归途总被忽略，想重新感受生活中安静的陪伴",
    };
    const variants = [
      poetic,
      { ...poetic, hook: `${poetic.hook}？` },
      { ...poetic, title: poetic.title.replace("一封", "1封") },
    ].map((input) => decideEditorialFormat(input));

    assert.deepEqual(variants.map((decision) => decision.verdict), ["produce_video", "produce_video", "produce_video"]);
    assert.equal(new Set(variants.map((decision) => decision.score)).size, 1);
  });

  it("keeps motion-video shape detection without imposing a production template", () => {
    const productDemo = decideEditorialFormat({ ...base, title: "实测 AI 如何整理一份会议记录", freshness: "evergreen" });
    const liveBrief = decideEditorialFormat({ ...base, title: "AI 助手进入普通人的工作", freshness: "live" });
    const miniDoc = decideEditorialFormat({ ...base, title: "乡村青年返乡后的真实工作", category: "agriculture-rural", freshness: "evergreen" });
    const explainer = decideEditorialFormat({ ...base, title: "为什么 AI 会改变普通人的工作分工", freshness: "evergreen" });

    for (const decision of [productDemo, liveBrief, miniDoc, explainer]) {
      assert.equal(decision.verdict, "produce_video");
      assert.equal(decision.recommendedTemplate, undefined);
    }
  });

  it("omits a recommendation when the preferred template is not currently published", () => {
    const decision = decideEditorialFormatWithTemplates(
      { ...base, title: "实测 AI 如何整理一份会议记录", freshness: "evergreen" },
      BUILTIN_TEMPLATES.filter((template) => template.id !== "product-demo"),
    );

    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.recommendedTemplate, undefined);
  });

  it("keeps a comparison topic's audience, hook, value, and evidence in one intent without a template", () => {
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
    assert.equal(decision.verdict, "produce_video");
    assert.equal(decision.recommendedTemplate, undefined);
    assert.match(decision.reasons.join(" "), /项目经理|返工半小时/);
    assert.match(decision.guardrails.join(" "), /同一段录音|同条件测试录像|原始会议纪要/);
  });
});
