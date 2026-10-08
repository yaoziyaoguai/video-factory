import type { StudioIntervention, StudioRunDetail } from "../../shared/api.js";

/**
 * 决定栏的输入只来自结构化干预字段（nodeId/kind/boundary/reviewStatus/continuationScope）
 * 与真实下游节点，不从按钮文案或错误字符串反推费用（CLOUD-02 / 执行包 P1.2）。
 */
export interface DecisionConsequenceFacts {
  nodeId: string;
  kind?: StudioIntervention["kind"];
  boundary?: StudioIntervention["boundary"];
  reviewStatus?: StudioIntervention["reviewStatus"];
  continuationScope?: StudioIntervention["continuationScope"];
  /** 图里是否真的存在 publish-package 下游节点；终审批准后的文案费用说明以此为准。 */
  hasPublishPackageNode: boolean;
  audioMode?: StudioRunDetail["audioMode"];
}

export interface DecisionConsequenceView {
  /** 本次主动作的一句话后果说明。 */
  consequence: string;
  /** 「是否重跑」一栏。 */
  rerunNote: string;
  /** 「费用影响」一栏；不编造报价，也不把全部历史费用说成 0。 */
  costNote: string;
}

/**
 * 按停点/主动作表驱动输出说明。每行只承诺结构化事实能证明的内容：
 * 生成 unknown 的停点不能套用“可选审片可直接采用”的说明；终审后可能生成
 * 发布文案的费用与“采用原片零新增调用”是两种不同后果，不能互相冒充。
 *
 * 分类顺序按证据域/节点/动作，而不是先看 reviewStatus：真实 Pipeline 的成片续看、
 * 可选审片未决与人工终审停点本身就携带 reviewStatus=incomplete（CR1/AP1、AP1b），
 * 若 incomplete 先行返回，会把它们错误替换成素材预检的“后续配音、渲染仍计费”话术。
 * 只有素材预检（kind=source_review_retry 或 asset-source-review 节点）的 incomplete
 * 才使用预检计费说明；其余无法识别的 incomplete 停点落入保守兜底。
 */
export function decisionConsequenceView(facts: DecisionConsequenceFacts): DecisionConsequenceView {
  if (facts.reviewStatus === "unknown_or_unsafe") {
    return {
      consequence: "付费、来源或媒体事实不明确，只能按页面提供的查询/核对动作处理，或终止制作。",
      rerunNote: "不自动重发；按页面提供的补查/终止动作",
      costNote: "不自动新增费用",
    };
  }
  if (facts.nodeId === "visual-review" && facts.continuationScope === "rendered_video_optional_review") {
    return {
      consequence: "采用是复用这份已核实的成片进入人工终审；不会重买素材、重做配音、重新渲染，也不会重发原来的审片请求。终审仍由你独立完成。",
      rerunNote: "不重跑渲染与配音；沿用当前成片",
      costNote: "本次采用不新增素材、配音或渲染费用；原审片请求与费用仍按原记录独立待核，不代表已结清",
    };
  }
  if (facts.nodeId === "final-review") {
    return facts.hasPublishPackageNode
      ? {
        consequence: "确认内部定版不会重做现有画面与配音；随后会准备发布文案与发布包，配置的文案模型可能产生新的调用费用，文案内容仍需你确认，不会自动发布到外部平台。",
        rerunNote: "不重做现有音画",
        costNote: "现有音画不重跑；后续文案生成按配置的文案模型计费，生成后仍需确认",
      }
      : {
        consequence: "确认内部定版不会重做现有画面与配音；本制作没有发布包步骤，确认后制作到此定版。",
        rerunNote: "不重做现有音画",
        costNote: "现有音画不重跑；无后续自动费用",
      };
  }
  if (facts.reviewStatus === "incomplete" && (facts.kind === "source_review_retry" || facts.nodeId === "asset-source-review")) {
    return {
      consequence: "接受后只继续后续制作，保留“审查未完成、无评分”事实；复用已生成的画面，不会重新购买已成功素材。",
      rerunNote: "可只重试审查",
      costNote: facts.audioMode === "native_av"
        ? "已有费用授权不扩大；本地准备视频原声，不另买配音；审片等模型调用按已选服务计费"
        : "已有费用授权不扩大；后续配音、渲染仍按已选服务规则计费",
    };
  }
  if (facts.nodeId === "publish-package") {
    return {
      consequence: "这是发布资料的采用，不是新的成片终审签字。按现有节点约定采用这一版；不会自动发布到外部平台。",
      rerunNote: "不重跑当前节点",
      costNote: "采用现有文案版本，不新增模型调用；历史费用事实按原记录保留",
    };
  }
  if (facts.boundary === "node-complete") {
    return {
      consequence: "放行后进入下一节点，不会重跑当前节点。",
      rerunNote: "不重跑当前节点",
      costNote: facts.audioMode === "native_av"
        ? "原生视频按既有流程报价；原声准备为本地处理，不另买配音；其它模型调用按已选服务计费"
        : "付费画面按既有流程报价；自动按量配音和模型依已选服务规则计费",
    };
  }
  return {
    consequence: "你的决定会被记录，已生成的版本和费用事实会保留。",
    rerunNote: "请查看本次动作说明",
    costNote: "后续服务按现有授权与配置计费",
  };
}
