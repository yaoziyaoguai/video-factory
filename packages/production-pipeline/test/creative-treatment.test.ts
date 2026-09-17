import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexTaskExecution, CodexTaskKind } from "../src/codex-chat.js";
import { CodexBridgeClient } from "../src/codex-chat.js";
import {
  parseCreativeTreatment,
  lockCreativeTreatmentViewerPromise,
  type CreativeTreatment,
} from "../src/creative-treatment.js";
import { CodexCreativeTreatmentAgent } from "../src/codex-creative-treatment.js";
import { assessTreatmentReadiness } from "../src/treatment-readiness.js";
import {
  summarizeProductionCapabilities,
  type ProductionCapabilities,
} from "../src/production-capabilities.js";

const valid = {
  version: "video-factory/creative-treatment-v2",
  viewerPromise: "学会识别资料支持的结论边界",
  hook: { narrationIntent: "提出一个具体判断", visualIntent: "展示原始资料的关键差异" },
  progression: [
    { beatId: "question", purpose: "建立问题", viewerGain: "知道要核对什么" },
    { beatId: "evidence", purpose: "核对资料", viewerGain: "区分事实与推测" },
    { beatId: "payoff", purpose: "兑现判断", viewerGain: "知道下一步如何判断" },
  ],
  payoff: "给出有条件的结论及下一步",
  visualPrinciples: ["来源画面优先"],
  soundPrinciples: ["自然语速、清楚停顿"],
  evidenceRequirements: [{ beatId: "evidence", claim: "原材料中的陈述", requirement: "factual_support", suppliedSourceIds: ["source-1"], critical: true, acquisition: "supplied", retrievalProviderId: null }],
  feasibilityQuestions: [{ beatId: "evidence", question: "来源画面是否可读且有使用依据" }],
};

test("合法构思接受并保留观众承诺", () => {
  assert.equal(parseCreativeTreatment(valid, ["source-1"]).viewerPromise, valid.viewerPromise);
});

test("配音能力按真实 Provider 投影且不虚构音乐或音效轨", () => {
  const providers = [{
    id: "stock-ready",
    deliveryTypes: ["stock_video"],
    strengths: [],
    constraints: [],
  }];
  assert.deepEqual(summarizeProductionCapabilities(providers, "macos-say-v1").audio, {
    narration: true,
    pauseControl: "punctuation",
    musicTrack: false,
    soundEffectsTrack: false,
  });
  assert.deepEqual(summarizeProductionCapabilities(providers, "minimax-tts-v1").audio, {
    narration: true,
    pauseControl: "text_hint",
    musicTrack: false,
    soundEffectsTrack: false,
  });
  assert.deepEqual(summarizeProductionCapabilities(providers, "kokoro-local-v1").audio, {
    narration: true,
    pauseControl: "unsupported",
    musicTrack: false,
    soundEffectsTrack: false,
  });
  assert.deepEqual(summarizeProductionCapabilities(providers).audio, {
    narration: false,
    pauseControl: "unsupported",
    musicTrack: false,
    soundEffectsTrack: false,
  });
});

test("越界来源必须报告具体字段而非悄悄接受", () => {
  assert.throws(() => parseCreativeTreatment(valid, []), /suppliedSourceIds/);
});

test("不存在的beat引用不能进入规划", () => {
  const changed = { ...valid, feasibilityQuestions: [{ beatId: "missing", question: "能否执行" }] };
  assert.throws(() => parseCreativeTreatment(changed, ["source-1"]), /beatId/);
});

test("重复beat和空承诺拒绝", () => {
  assert.throws(() => parseCreativeTreatment({ ...valid, progression: [valid.progression[0], valid.progression[0]] }, ["source-1"]), /beatId/);
  assert.throws(() => parseCreativeTreatment({ ...valid, viewerPromise: " " }, ["source-1"]), /viewerPromise/);
});

test("所有文本输出为 trim 后的规范文本", () => {
  const padded = {
    ...valid,
    viewerPromise: "  学会识别资料支持的结论边界  ",
    hook: { narrationIntent: " 提出一个具体判断", visualIntent: "展示原始资料的关键差异 " },
    progression: valid.progression.map((beat) => ({
      beatId: ` ${beat.beatId} `,
      purpose: ` ${beat.purpose} `,
      viewerGain: `${beat.viewerGain} `,
    })),
    visualPrinciples: [" 来源画面优先 "],
    evidenceRequirements: [{
      beatId: " evidence ",
      claim: " 原材料中的陈述 ",
      requirement: "factual_support",
      suppliedSourceIds: [" source-1 "],
      critical: true,
      acquisition: "supplied",
      retrievalProviderId: null,
    }],
  };
  const parsed = parseCreativeTreatment(padded, ["source-1"]);
  assert.equal(parsed.viewerPromise, "学会识别资料支持的结论边界");
  assert.equal(parsed.hook.narrationIntent, "提出一个具体判断");
  assert.equal(parsed.progression[0]?.beatId, "question");
  assert.equal(parsed.progression[0]?.purpose, "建立问题");
  assert.equal(parsed.visualPrinciples[0], "来源画面优先");
  assert.equal(parsed.evidenceRequirements[0]?.beatId, "evidence");
  assert.equal(parsed.evidenceRequirements[0]?.suppliedSourceIds[0], "source-1");
});

test("无来源但明确待核验的构思可以规划，缺口不被伪造成证据", () => {
  const withGap = {
    ...valid,
    evidenceRequirements: [{ beatId: "evidence", claim: "原材料中的陈述", requirement: "factual_support", suppliedSourceIds: [], critical: true, acquisition: "supplied", retrievalProviderId: null }],
  };
  const parsed = parseCreativeTreatment(withGap, []);
  assert.deepEqual(parsed.evidenceRequirements[0]?.suppliedSourceIds, []);
  assert.equal(parsed.evidenceRequirements[0]?.requirement, "factual_support");
});

test("progression 数量与 beat 唯一性边界", () => {
  const thirteenBeats = Array.from({ length: 13 }, (_, index) => ({
    beatId: `beat-${index}`,
    purpose: `推进 ${index}`,
    viewerGain: `收益 ${index}`,
  }));
  assert.throws(() => parseCreativeTreatment({ ...valid, progression: thirteenBeats }, ["source-1"]), /progression/);
  assert.throws(() => parseCreativeTreatment({ ...valid, progression: [] }, ["source-1"]), /progression/);
});

test("画面与声音原则各 1 到 8 项", () => {
  const nine = Array.from({ length: 9 }, (_, index) => `原则 ${index}`);
  assert.throws(() => parseCreativeTreatment({ ...valid, visualPrinciples: nine }, ["source-1"]), /visualPrinciples/);
  assert.throws(() => parseCreativeTreatment({ ...valid, soundPrinciples: [] }, ["source-1"]), /soundPrinciples/);
});

test("版本与 requirement 枚举由合同固定", () => {
  assert.throws(() => parseCreativeTreatment({ ...valid, version: "video-factory/creative-treatment-v1" }, ["source-1"]), /version/);
  assert.throws(() => parseCreativeTreatment({
    ...valid,
    evidenceRequirements: [{ beatId: "evidence", claim: "陈述", requirement: "verified", suppliedSourceIds: ["source-1"], critical: true, acquisition: "supplied", retrievalProviderId: null }],
  }, ["source-1"]), /requirement/);
  assert.throws(() => parseCreativeTreatment({
    ...valid,
    evidenceRequirements: [{ ...valid.evidenceRequirements[0], acquisition: "pipeline_retrievable", retrievalProviderId: null }],
  }, ["source-1"]), /retrievalProviderId/);
  assert.throws(() => parseCreativeTreatment({
    ...valid,
    evidenceRequirements: [{ ...valid.evidenceRequirements[0], acquisition: "external_required", retrievalProviderId: "stock-ready" }],
  }, ["source-1"]), /retrievalProviderId/);
  assert.throws(() => parseCreativeTreatment({
    ...valid,
    evidenceRequirements: [{ ...valid.evidenceRequirements[0], acquisition: "not_needed", retrievalProviderId: null }],
  }, ["source-1"]), /factual_support.*not_needed/);
});

test("宿主制作前提区分外部核心材料、真实绑定与可取得的普通示意", () => {
  const capabilities: ProductionCapabilities = {
    assetProviders: [{
      id: "stock-ready",
      deliveryTypes: ["stock_video"],
      supportsReferenceImage: false,
      strengths: [],
      constraints: [],
    }],
    editing: { sourceRangeReuse: true, staticEditorialCard: true },
    audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
  };
  const treatment = parseCreativeTreatment(valid, ["source-1"]);
  assert.equal(assessTreatmentReadiness(treatment, [{ sourceId: "source-1" }], capabilities).status, "ready");
  assert.equal(assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{ ...treatment.evidenceRequirements[0]!, acquisition: "external_required", retrievalProviderId: null }],
  }, [{ sourceId: "source-1" }], capabilities).status, "needs_source");
  assert.equal(assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{
      ...treatment.evidenceRequirements[0]!,
      requirement: "illustration_only",
      suppliedSourceIds: [],
      acquisition: "pipeline_retrievable",
      retrievalProviderId: "stock-ready",
    }],
  }, [], capabilities).status, "ready");
  assert.equal(assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{
      ...treatment.evidenceRequirements[0]!,
      suppliedSourceIds: [],
      acquisition: "pipeline_retrievable",
      retrievalProviderId: "stock-ready",
    }],
  }, [], capabilities).status, "needs_source");
  const misroutedIllustration = assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{
      ...treatment.evidenceRequirements[0]!,
      requirement: "illustration_only",
      suppliedSourceIds: [],
      acquisition: "pipeline_retrievable",
      retrievalProviderId: "missing-stock-provider",
    }],
  }, [], capabilities);
  assert.equal(misroutedIllustration.status, "revise_here");
  assert.equal(misroutedIllustration.issues[0]?.target, "director");
  assert.equal(assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{
      ...treatment.evidenceRequirements[0]!,
      suppliedSourceIds: ["source-1", "source-2"],
      acquisition: "supplied",
      retrievalProviderId: null,
    }],
  }, [{ sourceId: "source-1" }], capabilities).status, "needs_source");
  assert.equal(assessTreatmentReadiness({
    ...treatment,
    evidenceRequirements: [{
      ...treatment.evidenceRequirements[0]!,
      requirement: "illustration_only",
      suppliedSourceIds: [],
      acquisition: "not_needed",
      retrievalProviderId: null,
    }],
  }, [], capabilities).status, "ready");
});

test("必填顶层数组缺失被拒绝，显式空数组仍然合法", () => {
  const { evidenceRequirements: _evidence, ...withoutEvidence } = valid;
  assert.throws(() => parseCreativeTreatment(withoutEvidence, ["source-1"]), /evidenceRequirements/);
  const { feasibilityQuestions: _feasibility, ...withoutFeasibility } = valid;
  assert.throws(() => parseCreativeTreatment(withoutFeasibility, ["source-1"]), /feasibilityQuestions/);
  assert.deepEqual(parseCreativeTreatment({ ...valid, evidenceRequirements: [] }, ["source-1"]).evidenceRequirements, []);
  assert.deepEqual(parseCreativeTreatment({ ...valid, feasibilityQuestions: [] }, ["source-1"]).feasibilityQuestions, []);
});

test("宿主锁定的观众承诺覆盖模型输出，未锁定时保留生成值", () => {
  const parsed = parseCreativeTreatment(valid, ["source-1"]);
  const locked = lockCreativeTreatmentViewerPromise(parsed, "用户已确认的本季承诺");
  assert.equal(locked.viewerPromise, "用户已确认的本季承诺");
  assert.notEqual(locked, parsed);
  assert.equal(parsed.viewerPromise, valid.viewerPromise);
});

const passingAudit = {
  version: "video-factory/role-audit-v2",
  rubricVersion: "video-factory/role-quality-rubric-v1",
  assessments: [{
    targetPath: "",
    dimensions: [
      { dimension: "attention", score: 95, evidence: "开场提出一个具体判断。" },
      { dimension: "progression", score: 95, evidence: "抽查逐步展开资料核对。" },
      { dimension: "payoff", score: 95, evidence: "结尾给出有条件的结论。" },
      { dimension: "expression", score: 95, evidence: "承诺表述自然可读。" },
    ],
  }],
  verdict: "pass",
  score: 95,
  summary: "构思满足合同。",
  issues: [],
  repairInstructions: [],
};

class ControlledTreatmentClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    private readonly respond: (kind: CodexTaskKind) => unknown,
  ) {
    super({ socketPath: "/nonexistent/vf-creative-treatment-test.sock", sleep: async () => {} });
  }

  override async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
  ): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload });
    return {
      output: this.respond(kind),
      trace: {
        taskKind: kind,
        promptVersion: `test/${kind}`,
        prompt: `prompt:${kind}`,
        providerId: this.providerId,
        modelId: this.modelId,
      },
    };
  }
}

function agentInput(overrides: Record<string, unknown> = {}) {
  return {
    brief: {
      title: "资料结论怎么核对",
      angle: "教普通人识别结论边界",
      audience: "刚开始独立生活的观众",
      nicheSlug: "evidence-basics",
      platform: "douyin",
      durationSeconds: 30,
      durationRange: { minSeconds: 24, maxSeconds: 40 },
      ...overrides,
    },
    suppliedSources: [{ sourceId: "source-1", label: "原始报道" }],
  };
}

test("producer 将合同 fixture 转换为 CreativeTreatment 并复用 role-audit", async () => {
  const client = new ControlledTreatmentClient("deepseek", "deepseek-flash", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "deepseek-flash" });
  const execution = await agent.treatDetailed(agentInput());

  assert.deepEqual(client.calls.map((call) => call.kind), ["creative-treatment", "role-audit"]);
  const producePayload = client.calls[0]?.payload as { brief: Record<string, unknown>; suppliedSources: unknown };
  assert.equal(producePayload.brief.title, "资料结论怎么核对");
  assert.deepEqual(producePayload.suppliedSources, [{ sourceId: "source-1", label: "原始报道" }]);
  assert.equal(execution.output.version, "video-factory/creative-treatment-v2");
  assert.equal(execution.output.progression.length, 3);
  assert.equal(execution.agentLoop?.status, "passed");
});

test("构思返工要求同时进入 producer 与独立 audit 上下文", async () => {
  const client = new ControlledTreatmentClient("openai", "gpt-test", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "gpt-test" });
  const reworkInstruction = "改成概念示意，不再要求用户提供受控实验画面。";

  await agent.treatDetailed(agentInput({
    visualIntent: "用无字生成画面表达构图变化。",
    reworkInstruction,
  }));

  const producer = client.calls[0]?.payload as { brief: Record<string, unknown> };
  const audit = client.calls[1]?.payload as { context: { upstreamFacts: Record<string, unknown> } };
  assert.equal(producer.brief.reworkInstruction, reworkInstruction);
  assert.equal(audit.context.upstreamFacts.reworkInstruction, reworkInstruction);
});

test("系列创作事实同时进入构思 producer 与独立 audit", async () => {
  const client = new ControlledTreatmentClient("openai", "gpt-test", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "gpt-test" });
  const seriesContext = {
    seriesName: "下班实验室",
    seasonNumber: 1,
    episodeNumber: 3,
    premise: "每集完成一次可复现验证",
    track: "after-work-lab",
    arc: "从偶然成功走向稳定方法",
    episode: {
      pillar: "真实实验",
      title: "第三集",
      viewerPromise: "看懂失败发生在哪一步",
      hook: "先展示反常结果",
      payoff: "给出可复现检查表",
    },
    bible: {
      rules: ["结论必须来自本集实际内容"],
      recurringElements: ["实验桌"],
      forbiddenChanges: ["不能虚构成功"],
    },
    canon: { revision: 2, facts: [] },
    continuity: {
      inheritedFromPrevious: ["第二集确认了温度变量"],
      fromPrevious: ["沿用同一测量方法"],
      toNext: ["下一集验证时间变量"],
      canonChecks: ["不得推翻温度变量"],
    },
  };

  await agent.treatDetailed(agentInput({ seriesContext }));

  const producer = client.calls[0]?.payload as { brief: Record<string, unknown> };
  const audit = client.calls[1]?.payload as { context: { upstreamFacts: Record<string, unknown> } };
  assert.deepEqual(producer.brief.seriesContext, seriesContext);
  assert.deepEqual(audit.context.upstreamFacts.seriesContext, seriesContext);
});

test("宿主锁定承诺时 producer 覆盖输出且把锁定值传给模型", async () => {
  const client = new ControlledTreatmentClient("deepseek", "deepseek-flash", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "deepseek-flash" });
  const treatment = await agent.treat(agentInput({ lockedViewerPromise: "系列已定的观众承诺" }));

  assert.equal(treatment.viewerPromise, "系列已定的观众承诺");
  const producePayload = client.calls[0]?.payload as { brief: Record<string, unknown> };
  assert.equal(producePayload.brief.lockedViewerPromise, "系列已定的观众承诺");
});

test("producer 拒绝引用越界来源的候选并指出字段", async () => {
  const client = new ControlledTreatmentClient("deepseek", "deepseek-flash", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "deepseek-flash" });
  await assert.rejects(
    () => agent.treat({ ...agentInput(), suppliedSources: [] }),
    /suppliedSourceIds/,
  );
});

test("producer 输入合同：来源与时长边界先于模型调用被校验", async () => {
  const client = new ControlledTreatmentClient("openai", "codex-default", () => {
    throw new Error("model must not be called for invalid input");
  });
  const agent = new CodexCreativeTreatmentAgent({ client });
  await assert.rejects(
    () => agent.treat({
      brief: {
        title: "资料结论怎么核对",
        angle: "教普通人识别结论边界",
        audience: "刚开始独立生活的观众",
        nicheSlug: "evidence-basics",
        platform: "douyin",
        durationSeconds: 30,
      },
      suppliedSources: [
        { sourceId: "dup", label: "第一" },
        { sourceId: "dup", label: "第二" },
      ],
    }),
    /sourceId/,
  );
  assert.deepEqual(client.calls, []);
});
