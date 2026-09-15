import type {
  StudioCandidateFreshness,
  StudioCandidateOrigin,
  StudioCandidateRisk,
  StudioCandidateVerification,
  StudioEditorialDecision,
  StudioOpportunityEvidence,
  StudioOpportunityScore,
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
  visualProof?: string;
  visualPlan?: {
    strategy: string;
    beats: Array<{ role: string; description: string; searchQuery?: string }>;
  };
  audience?: string;
  painPoint?: string;
  hook?: string;
  evidence?: Array<Pick<StudioOpportunityEvidence, "source" | "evidenceUrl">>;
}

const STATIC_UPDATE_PATTERN = /通报|公告|回应|声明|会议(?:召开|举行|通报|决定)|发布会|任免|判决|调查进展|数据公布|逝世|去世|政策发布|外交|冲突|伤亡|事故|地震|台风|暴雨|救灾/;
const PUBLIC_UPDATE_ACTOR_PATTERN = /(?:警方|法院|检察院|政府|官方|部门|机构|公司|企业|平台|学校|医院|当事人).{0,12}(?:通报|公告|回应|声明|发布会|任免|判决|调查进展|数据公布)/;
const PUBLIC_EVENT_CONTEXT_PATTERN = /社会事件|公共安全|外交|国际|战争|灾害|伤亡|遇难|失联|地震|台风|暴雨|救灾/;
const EVERYDAY_CONTEXT_PATTERN = /亲子|孩子|家长|家庭|厨房|做饭|居家|同事|沟通|相处/;
const GUIDANCE_METHOD_PATTERN = /如何|怎么|三步|方法|教程|化解|避免|预防|防止|检查/;

export function decideEditorialFormat(
  input: EditorialDecisionInput,
  _publishedTemplates: readonly EditorialTemplateOption[],
): StudioEditorialDecision {
  const decision = decideProductionPotential(input);
  // 规则保底候选的所有结论都没有经过选题总编：无论走哪个分支，都要如实标记等待评估，
  // 避免把"尚未评估"投影成"总编评分 0 · 暂不生产"。
  const marked = input.providerId === "trend-heuristic-v1"
    ? { ...decision, pendingEditorReview: true }
    : decision;
  if (input.verification.status !== "blocked") return marked;
  return {
    ...marked,
    guardrails: [
      `开工门槛：${input.verification.reasons[0] ?? "当前证据未达到生产标准。"}`,
      ...marked.guardrails,
    ],
  };
}

function decideProductionPotential(
  input: EditorialDecisionInput,
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
  const videoValue = Math.round(
    input.score.visualFeasibility * 0.34
    + input.score.novelty * 0.2
    + input.score.audienceReach * 0.18
    + input.score.productionCostEfficiency * 0.16
    + input.score.seriesPotential * 0.12
    - input.score.complianceRisk * 0.22
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

  const clearsVideoGate = input.score.audienceReach >= 60
    && input.score.visualFeasibility >= 68
    && input.score.novelty >= 55
    && input.score.complianceRisk <= 45;
  if (!clearsVideoGate) {
    return {
      verdict: "skip",
      score: clamp(videoValue),
      reasons: ["受众价值、视觉动作、创意增量或风险控制没有同时越过视频准入线，热度不足以抵消短板。"],
      guardrails: ["重写为可验证的行动实验，补齐独特画面或明确受众收益后再进入生产。"],
    };
  }

  const audience = input.audience!.trim();
  const painPoint = input.painPoint!.trim();
  const evidenceSources = (input.evidence ?? []).map((item) => item.source.trim()).filter(Boolean).join("、") || "补齐后的原始来源";
  return {
    verdict: "produce_video",
    score: clamp(videoValue),
    reasons: [`面向${audience}，围绕“${painPoint}”的画面可行性和创作增量达到视频生产门槛。`],
    guardrails: [`前两秒兑现钩子“${input.hook!.trim()}”；事实与结果必须回到${evidenceSources}，热度本身不能替代内容价值。`],
  };
}

function isPublicStaticUpdate(input: EditorialDecisionInput, topicText: string): boolean {
  if (!STATIC_UPDATE_PATTERN.test(topicText)) return false;
  const hasPublicEventContext = PUBLIC_UPDATE_ACTOR_PATTERN.test(topicText) || PUBLIC_EVENT_CONTEXT_PATTERN.test(topicText);
  if (isEverydayGuidance(topicText) && !hasPublicEventContext) return false;
  return hasPublicEventContext || input.category === "society" || input.risk !== "low";
}

function isEverydayGuidance(text: string): boolean {
  return EVERYDAY_CONTEXT_PATTERN.test(text) && GUIDANCE_METHOD_PATTERN.test(text);
}

function viralReadinessIssues(input: EditorialDecisionInput): string[] {
  const audience = input.audience?.trim() ?? "";
  const painPoint = input.painPoint?.trim() ?? "";
  const hook = input.hook?.trim() ?? "";
  const issues: string[] = [];
  if (!input.title.trim()) issues.push("标题为空");
  if (!audience) issues.push("受众为空");
  if (!painPoint) issues.push("观看收益为空");
  if (!hook) issues.push("开场承诺为空");
  return issues;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}
