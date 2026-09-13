// 两种文本 executor（OpenAI Codex 与 ZAI/GLM）必须使用同一组合法/非法 fixture，
// 防止各自复制后随时间漂移；production 侧 parser 测试不与本文件跨包耦合。

export function creativeTreatmentRequest(): { protocolVersion: string; kind: string; payload: Record<string, unknown> } {
  return {
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "creative-treatment",
    payload: {
      brief: {
        title: "资料结论怎么核对",
        angle: "教普通人识别结论边界",
        audience: "刚开始独立生活的观众",
        nicheSlug: "evidence-basics",
        platform: "douyin",
        durationSeconds: 30,
        durationRange: { minSeconds: 24, maxSeconds: 40 },
        productionCapabilities: {
          assetProviders: [],
          editing: { sourceRangeReuse: true, staticEditorialCard: false },
        },
      },
      suppliedSources: [{ sourceId: "source-1", label: "原始报道" }],
    },
  };
}

export function legalCreativeTreatmentOutput(): Record<string, unknown> {
  return {
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
}

// schema 合法但语义非法：evidenceRequirements 引用不存在的 beatId，
// 两种 adapter 都必须在字段级拒绝（JSON 解析成功不等于业务合同通过）。
export function ghostBeatCreativeTreatmentOutput(): Record<string, unknown> {
  return {
    ...legalCreativeTreatmentOutput(),
    evidenceRequirements: [{ beatId: "ghost-beat", claim: "原材料中的陈述", requirement: "factual_support", suppliedSourceIds: ["source-1"] }],
  };
}

export interface CreativeTreatmentWhitespaceCase {
  // 错误信息必须点到的字段路径，用于断言字段级拒绝。
  field: string;
  apply(output: Record<string, unknown>): void;
}

// 宿主 parseCreativeTreatment 拒绝、JSON schema minLength 却放行的纯空白矩阵；
// 两套 executor 必须在 semantic 边界给出同样的字段级错误，不能各自复制用例。
export function creativeTreatmentWhitespaceInvalidCases(): CreativeTreatmentWhitespaceCase[] {
  return [
    {
      field: "progression[0].purpose",
      apply: (output) => {
        (output.progression as Array<Record<string, unknown>>)[0]!.purpose = " ";
      },
    },
    {
      field: "progression[0].viewerGain",
      apply: (output) => {
        (output.progression as Array<Record<string, unknown>>)[0]!.viewerGain = " ";
      },
    },
    {
      field: "visualPrinciples[0]",
      apply: (output) => {
        output.visualPrinciples = [" "];
      },
    },
    {
      field: "soundPrinciples[0]",
      apply: (output) => {
        output.soundPrinciples = [" "];
      },
    },
    {
      field: "evidenceRequirements[0].beatId",
      apply: (output) => {
        (output.evidenceRequirements as Array<Record<string, unknown>>)[0]!.beatId = " ";
      },
    },
    {
      field: "feasibilityQuestions[0].beatId",
      apply: (output) => {
        (output.feasibilityQuestions as Array<Record<string, unknown>>)[0]!.beatId = " ";
      },
    },
    {
      field: "evidenceRequirements[0].suppliedSourceIds[0]",
      apply: (output) => {
        (output.evidenceRequirements as Array<Record<string, unknown>>)[0]!.suppliedSourceIds = [" "];
      },
    },
  ];
}

// 宿主会把合法内容的首尾空格 trim 后接受；validator 收紧空白检查时不得误伤这类输出。
export function paddedLegalCreativeTreatmentOutput(): Record<string, unknown> {
  const output = legalCreativeTreatmentOutput();
  const progression = output.progression as Array<Record<string, unknown>>;
  progression[0] = { ...progression[0]!, purpose: " 建立问题 ", viewerGain: " 知道要核对什么 " };
  const evidence = output.evidenceRequirements as Array<Record<string, unknown>>;
  evidence[0] = { ...evidence[0]!, claim: " 原材料中的陈述 ", suppliedSourceIds: [" source-1 "] };
  (output.feasibilityQuestions as Array<Record<string, unknown>>)[0] = { beatId: "evidence", question: " 来源画面是否可读且有使用依据 " };
  return {
    ...output,
    viewerPromise: " 学会识别资料支持的结论边界 ",
    hook: { narrationIntent: " 提出一个具体判断 ", visualIntent: " 展示原始资料的关键差异 " },
    payoff: " 给出有条件的结论及下一步 ",
    visualPrinciples: [" 来源画面优先 "],
    soundPrinciples: [" 自然语速、清楚停顿 "],
  };
}

export type CreativeTreatmentSourceContractOutcome = "accepted" | "payload-rejected" | "output-rejected";

export interface CreativeTreatmentSourceContractCase {
  label: string;
  outcome: CreativeTreatmentSourceContractOutcome;
  suppliedSources: Array<Record<string, unknown>>;
  // 输出 evidenceRequirements[0].suppliedSourceIds 引用的来源 ID 组合。
  suppliedSourceIds: string[];
}

// 来源 ID 的 canonical 合同：宿主按 trim 后的 sourceId 建引用边界，
// Broker 的输入存储、去重与输出引用判断必须落在同一 canonical 值上。
export function creativeTreatmentSourceContractCases(): CreativeTreatmentSourceContractCase[] {
  return [
    {
      label: "canonical input plus padded output reference",
      outcome: "accepted",
      suppliedSources: [{ sourceId: "source-1", label: "原始报道" }],
      suppliedSourceIds: [" source-1 "],
    },
    {
      label: "padded input plus canonical output reference",
      outcome: "accepted",
      suppliedSources: [{ sourceId: " source-1 ", label: "原始报道" }],
      suppliedSourceIds: ["source-1"],
    },
    {
      label: "padded input plus padded output reference",
      outcome: "accepted",
      suppliedSources: [{ sourceId: " source-1 ", label: "原始报道" }],
      suppliedSourceIds: [" source-1 "],
    },
    {
      label: "out-of-set output reference",
      outcome: "output-rejected",
      suppliedSources: [{ sourceId: "source-1", label: "原始报道" }],
      suppliedSourceIds: ["source-2"],
    },
    {
      label: "input sources duplicating after trim",
      outcome: "payload-rejected",
      suppliedSources: [{ sourceId: "source-1" }, { sourceId: " source-1 " }],
      suppliedSourceIds: ["source-1"],
    },
    {
      label: "blank input source id",
      outcome: "payload-rejected",
      suppliedSources: [{ sourceId: "   " }],
      suppliedSourceIds: ["source-1"],
    },
  ];
}

export function legalCreativeTreatmentOutputWithSourceRefs(refs: string[]): Record<string, unknown> {
  const output = legalCreativeTreatmentOutput();
  (output.evidenceRequirements as Array<Record<string, unknown>>)[0]!.suppliedSourceIds = refs;
  return output;
}
