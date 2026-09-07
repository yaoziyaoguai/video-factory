import type {
  StudioCandidateFreshness,
  StudioCandidateOrigin,
  StudioCandidateRisk,
  StudioCandidateVerification,
  StudioEditorialDecision,
  StudioOpportunityEvidence,
  StudioOpportunityScore,
  StudioTemplateRecommendation,
  StudioTopicCategory,
} from "../shared/api.js";

export interface EditorialTemplateOption {
  id: string;
  name: string;
}

export interface EditorialDecisionInput {
  origin: StudioCandidateOrigin;
  providerId?: string;
  title: string;
  track: string;
  category: StudioTopicCategory;
  freshness: StudioCandidateFreshness;
  risk: StudioCandidateRisk;
  verification: StudioCandidateVerification;
  score: StudioOpportunityScore;
  audience?: string;
  painPoint?: string;
  hook?: string;
  evidence?: Array<Pick<StudioOpportunityEvidence, "source" | "evidenceUrl">>;
}

const STATIC_UPDATE_PATTERN = /通报|公告|回应|声明|会议(?:召开|举行|通报|决定)|发布会|任免|判决|调查进展|数据公布|逝世|去世|政策发布|外交|冲突|伤亡|事故|地震|台风|暴雨|救灾/;
const PUBLIC_UPDATE_ACTOR_PATTERN = /(?:警方|法院|检察院|政府|官方|部门|机构|公司|企业|平台|学校|医院|当事人).{0,12}(?:通报|公告|回应|声明|发布会|任免|判决|调查进展|数据公布)/;
const PUBLIC_EVENT_CONTEXT_PATTERN = /社会事件|公共安全|外交|国际|战争|灾害|伤亡|遇难|失联|地震|台风|暴雨|救灾/;
const EVERYDAY_GUIDANCE_PATTERN = /亲子|孩子|家长|家庭|厨房|做饭|居家|同事|沟通|相处|如何|怎么|三步|方法|教程|化解|避免|预防|防止/;
const ACTION_PATTERN = /实测|实验|挑战|教程|方法|对比|体验|探店|旅行|美食|运动|比赛|改造|制作|开箱|测评|操作|演示|工作流|如何|三步|一天|化解|回应|避免|预防/;
const COMPARISON_PATTERN = /对比|横评|测评|谁更适合|怎么选|选哪个|\bA\s*(?:还是|vs\.?)\s*B\b/i;
const HOOK_PATTERN = /[？?]|\d|为什么|如何|到底|能不能|不是.+而是|别.+先|实测|对比|横评|省下|少花|多赚|变化/;
const GENERIC_AUDIENCE_PATTERN = /^(所有人|大家|普通人|用户|年轻人|成年人)$/;
const GENERIC_TOPIC_PATTERN = /^(?:(?:今天|今日|本周|最新|实时|全网|平台)?(?:热搜|热点|话题|新闻|资讯|消息|榜单|大事)(?:来了|来袭|更新|速递|盘点|汇总|上榜|第一)?)$/;

export function decideEditorialFormat(
  input: EditorialDecisionInput,
  publishedTemplates: readonly EditorialTemplateOption[],
): StudioEditorialDecision {
  const decision = decideProductionPotential(input, publishedTemplates);
  if (input.verification.status !== "blocked") return decision;
  return {
    ...decision,
    guardrails: [
      `开工门槛：${input.verification.reasons[0] ?? "当前证据未达到生产标准。"}`,
      ...decision.guardrails,
    ],
  };
}

function decideProductionPotential(
  input: EditorialDecisionInput,
  publishedTemplates: readonly EditorialTemplateOption[],
): StudioEditorialDecision {
  const readinessIssues = viralReadinessIssues(input);
  if (readinessIssues.length > 0) {
    return {
      verdict: "skip",
      score: 0,
      reasons: [`选题尚未达到视频生产门槛：${readinessIssues.join("；")}。`],
      guardrails: ["先补齐明确受众、具体痛点、两秒开场承诺和可追溯证据，再重新评估制作形式。"],
    };
  }

  if (input.providerId === "trend-heuristic-v1") {
    return {
      verdict: "skip",
      score: 0,
      reasons: ["当前只是热点规则保底候选，还没有经过选题总编形成具体、可拍的创作角度。"],
      guardrails: ["等待选题总编恢复，或由创作者补齐明确受众、观看收益、两秒钩子和可执行视频形态后再评估。"],
    };
  }

  const topicText = `${input.title} ${input.track}`;
  const staticUpdate = isPublicStaticUpdate(input, topicText);
  const comparison = COMPARISON_PATTERN.test(topicText);
  const hasAction = comparison || ACTION_PATTERN.test(topicText);
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
    const recommendedTemplate = templateRecommendation(
      publishedTemplates,
      "photo-story",
      "来源画面与数据证据驱动的图解视频",
      "公共议题缺少可安全生成的连续现场，采用来源画面、数据和少量获授权实景更可信。",
    );
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
      ...(recommendedTemplate ? { recommendedTemplate } : {}),
    };
  }

  const clearsVideoGate = input.score.audienceReach >= 60
    && input.score.visualFeasibility >= 68
    && input.score.novelty >= 55
    && input.score.complianceRisk <= 45
    && (hasAction || input.score.visualFeasibility >= 78);
  if (videoValue < 60 || !clearsVideoGate) {
    return {
      verdict: "skip",
      score: clamp(videoValue),
      reasons: ["受众价值、视觉动作、创意增量或风险控制没有同时越过视频准入线，热度不足以抵消短板。"],
      guardrails: ["重写为可验证的行动实验，补齐独特画面或明确受众收益后再进入生产。"],
    };
  }

  const recommendedTemplate = recommendMotionTemplate(input, hasAction, comparison, publishedTemplates);
  const audience = input.audience!.trim();
  const painPoint = input.painPoint!.trim();
  const evidenceSources = (input.evidence ?? []).map((item) => item.source.trim()).filter(Boolean).join("、") || "补齐后的原始来源";
  return {
    verdict: "produce_video",
    score: clamp(videoValue),
    reasons: [hasAction
      ? `面向${audience}，用可见行动解决“${painPoint}”，视频能提供文字无法替代的观看价值。`
      : `面向${audience}，围绕“${painPoint}”的画面可行性和创作增量达到视频生产门槛。`],
    guardrails: [`前两秒兑现钩子“${input.hook!.trim()}”；事实与结果必须回到${evidenceSources}，热度本身不能替代内容价值。`],
    ...(recommendedTemplate ? { recommendedTemplate } : {}),
  };
}

function recommendMotionTemplate(
  input: EditorialDecisionInput,
  hasAction: boolean,
  comparison: boolean,
  publishedTemplates: readonly EditorialTemplateOption[],
): StudioTemplateRecommendation | undefined {
  if (comparison) {
    return templateRecommendation(publishedTemplates, "ranked-comparison", "统一标准、同条件测试与条件结论构成的横评视频", "题材的核心承诺是帮助观众做选择，必须先公开标准，再用同条件证据给出分人群结论。");
  }
  if (hasAction) {
    return templateRecommendation(publishedTemplates, "product-demo", "问题、关键动作与结果证据构成的实测视频", "题材的观看价值来自过程和结果，必须让观众看见真实操作而不是听口播描述。");
  }
  if (input.category === "society" || input.freshness === "live") {
    return templateRecommendation(publishedTemplates, "trend-fact-brief", "事实钩子、证据语境与影响判断构成的热点短片", "时效型选题需要先建立可核验事实，再用画面解释它为何与观众相关。");
  }
  if (input.category === "local-culture" || input.category === "parenting" || input.category === "agriculture-rural") {
    return templateRecommendation(publishedTemplates, "human-mini-doc", "人物行动、环境细节与真实阻力驱动的观察短片", "这类题材的差异化来自具体人物和现场关系，微纪录比通用解说更有记忆点。");
  }
  return templateRecommendation(publishedTemplates, "knowledge-explainer", "问题、因果模型与生活验证构成的解释视频", "题材需要把抽象信息变成可理解、可复述且可验证的因果链。");
}

function isPublicStaticUpdate(input: EditorialDecisionInput, topicText: string): boolean {
  if (!STATIC_UPDATE_PATTERN.test(topicText)) return false;
  const hasPublicEventContext = PUBLIC_UPDATE_ACTOR_PATTERN.test(topicText) || PUBLIC_EVENT_CONTEXT_PATTERN.test(topicText);
  if (EVERYDAY_GUIDANCE_PATTERN.test(topicText) && !hasPublicEventContext) return false;
  return hasPublicEventContext || input.category === "society" || input.risk !== "low";
}

function viralReadinessIssues(input: EditorialDecisionInput): string[] {
  const audience = input.audience?.trim() ?? "";
  const painPoint = input.painPoint?.trim() ?? "";
  const hook = input.hook?.trim() ?? "";
  const title = input.title.trim().replace(/[\s\p{P}\p{S}]+/gu, "");
  const issues: string[] = [];
  if (!title || GENERIC_TOPIC_PATTERN.test(title)) issues.push("标题没有形成可判断的具体问题");
  if (!audience || GENERIC_AUDIENCE_PATTERN.test(audience)) issues.push("受众仍然过于宽泛");
  if (painPoint.length < 8) issues.push("痛点或具体收益不清楚");
  if (!hook || !HOOK_PATTERN.test(hook)) issues.push("开场没有足够具体的停留理由");
  return issues;
}

function templateRecommendation(
  publishedTemplates: readonly EditorialTemplateOption[],
  id: string,
  format: string,
  rationale: string,
): StudioTemplateRecommendation | undefined {
  const template = publishedTemplates.find((candidate) => candidate.id === id);
  if (!template) return undefined;
  return { id, name: template.name, format, rationale };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}
