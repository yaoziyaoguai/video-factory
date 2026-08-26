import type {
  StudioCandidateFreshness,
  StudioCandidateOrigin,
  StudioCandidateRisk,
  StudioCandidateVerification,
  StudioEditorialDecision,
  StudioOpportunityScore,
  StudioTopicCategory,
} from "../shared/api.js";

export interface EditorialDecisionInput {
  origin: StudioCandidateOrigin;
  title: string;
  track: string;
  category: StudioTopicCategory;
  freshness: StudioCandidateFreshness;
  risk: StudioCandidateRisk;
  verification: StudioCandidateVerification;
  score: StudioOpportunityScore;
}

const STATIC_UPDATE_PATTERN = /通报|公告|回应|声明|会议|发布会|任免|判决|调查进展|数据公布|逝世|去世|政策发布|外交|冲突|伤亡|事故|地震|台风|暴雨|救灾/;
const ACTION_PATTERN = /实测|实验|挑战|教程|方法|对比|体验|探店|旅行|美食|运动|比赛|改造|制作|开箱|测评|操作|演示|工作流|如何|三步|一天/;

export function decideEditorialFormat(input: EditorialDecisionInput): StudioEditorialDecision {
  if (input.origin === "series") {
    return {
      verdict: "produce_video",
      score: clamp(Math.round((input.score.visualFeasibility + input.score.seriesPotential + input.score.productionCostEfficiency) / 3)),
      reasons: ["系列内容有持续叙事承诺，适合用动作、过程和连续镜头建立栏目记忆。"],
      guardrails: ["每集必须提供新的验证、行动或结论，不能只重复栏目模板。"],
    };
  }

  if (input.verification.status === "blocked") {
    return {
      verdict: "skip",
      score: 0,
      reasons: [`证据门槛未满足：${input.verification.reasons[0] ?? "当前证据未达到生产门槛。"}`],
      guardrails: ["补齐独立来源并重新核验前，不生成脚本、图片或视频。"],
    };
  }

  const staticUpdate = STATIC_UPDATE_PATTERN.test(`${input.title} ${input.track}`);
  const hasAction = ACTION_PATTERN.test(`${input.title} ${input.track}`);
  const videoValue = Math.round(
    input.score.visualFeasibility * 0.34
    + input.score.novelty * 0.2
    + input.score.audienceReach * 0.18
    + input.score.productionCostEfficiency * 0.16
    + input.score.seriesPotential * 0.12
    - input.score.complianceRisk * 0.22
    + (hasAction ? 8 : 0)
    - (staticUpdate ? 12 : 0),
  );

  if (input.risk !== "low" || staticUpdate || input.score.visualFeasibility < 62) {
    if (input.score.audienceReach < 42 && input.score.novelty < 42) {
      return {
        verdict: "skip",
        score: clamp(videoValue),
        reasons: ["热点虽有信号，但受众关联和创作增量不足，不值得占用当日生产额度。"],
        guardrails: ["等待出现新的事实、独特解释角度或可验证的视觉材料后再评估。"],
      };
    }
    return {
      verdict: "produce_image_story",
      score: clamp(Math.max(45, videoValue)),
      reasons: [input.risk === "low"
        ? "信息价值高于动作价值，用来源卡、数据卡和少量实景更清楚也更经济。"
        : "公共事件需要以证据为主，图文成片比生成式连续画面更准确。"],
      guardrails: [
        "只使用原始来源截图、获授权素材、数据卡和明确标注的示意画面。",
        "不得用 AI 生成画面虚构现场、当事人行为或未被证实的细节。",
      ],
    };
  }

  if (videoValue < 52) {
    return {
      verdict: "skip",
      score: clamp(videoValue),
      reasons: ["综合画面、创意增量、受众关联和成本后，当前不值得生产视频。"],
      guardrails: ["重写为可验证的行动实验或系列命题后再进入生产。"],
    };
  }

  return {
    verdict: "produce_video",
    score: clamp(videoValue),
    reasons: [hasAction
      ? "题材包含可演示的行动或过程，视频能提供文字无法替代的观看价值。"
      : "画面可行性、受众关联和创作增量达到视频生产门槛。"],
    guardrails: ["逐镜选择最能承担叙事任务的来源，热度本身不能替代内容价值。"],
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}
