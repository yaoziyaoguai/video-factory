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

const valid = {
  version: "video-factory/creative-treatment-v1",
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
  evidenceRequirements: [{ beatId: "evidence", claim: "原材料中的陈述", requirement: "factual_support", suppliedSourceIds: ["source-1"] }],
  feasibilityQuestions: [{ beatId: "evidence", question: "来源画面是否可读且有使用依据" }],
};

test("合法构思接受并保留观众承诺", () => {
  assert.equal(parseCreativeTreatment(valid, ["source-1"]).viewerPromise, valid.viewerPromise);
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
    evidenceRequirements: [{ beatId: "evidence", claim: "原材料中的陈述", requirement: "factual_support", suppliedSourceIds: [] }],
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
  assert.throws(() => parseCreativeTreatment({ ...valid, version: "video-factory/creative-treatment-v2" }, ["source-1"]), /version/);
  assert.throws(() => parseCreativeTreatment({
    ...valid,
    evidenceRequirements: [{ beatId: "evidence", claim: "陈述", requirement: "verified", suppliedSourceIds: ["source-1"] }],
  }, ["source-1"]), /requirement/);
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
  version: "video-factory/role-audit-v1",
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
  const client = new ControlledTreatmentClient("zai-bigmodel-api", "glm-5.3", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "glm-5.3" });
  const execution = await agent.treatDetailed(agentInput());

  assert.deepEqual(client.calls.map((call) => call.kind), ["creative-treatment", "role-audit"]);
  const producePayload = client.calls[0]?.payload as { brief: Record<string, unknown>; suppliedSources: unknown };
  assert.equal(producePayload.brief.title, "资料结论怎么核对");
  assert.deepEqual(producePayload.suppliedSources, [{ sourceId: "source-1", label: "原始报道" }]);
  assert.equal(execution.output.version, "video-factory/creative-treatment-v1");
  assert.equal(execution.output.progression.length, 3);
  assert.equal(execution.agentLoop?.status, "passed");
});

test("宿主锁定承诺时 producer 覆盖输出且把锁定值传给模型", async () => {
  const client = new ControlledTreatmentClient("zai-bigmodel-api", "glm-5.3", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    if (kind === "role-audit") return passingAudit;
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "glm-5.3" });
  const treatment = await agent.treat(agentInput({ lockedViewerPromise: "系列已定的观众承诺" }));

  assert.equal(treatment.viewerPromise, "系列已定的观众承诺");
  const producePayload = client.calls[0]?.payload as { brief: Record<string, unknown> };
  assert.equal(producePayload.brief.lockedViewerPromise, "系列已定的观众承诺");
});

test("producer 拒绝引用越界来源的候选并指出字段", async () => {
  const client = new ControlledTreatmentClient("zai-bigmodel-api", "glm-5.3", (kind) => {
    if (kind === "creative-treatment") return structuredClone(valid);
    throw new Error(`Unexpected task ${kind}`);
  });
  const agent = new CodexCreativeTreatmentAgent({ client, modelId: "glm-5.3" });
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
