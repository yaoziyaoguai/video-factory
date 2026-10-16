import type { StudioArticleFact, StudioVisualPlan } from "../shared/api.js";
import { parseStudioVisualPlan } from "../shared/api.js";
import type { TrendModelIdea } from "./trend-opportunity-agent.js";

export const TOPIC_EDITOR_AGENT_CONTRACT_VERSION = "topic-editor-v11|role-audit-v9|topic-ideas-validator-v7|complete-role-scope-v1|canonical-signal-groups-v1|downstream-source-gate-v1|visual-plan-v2|angle-identity-v1|cited-facts-v2|single-initial-audit-v1";

export const TOPIC_REVISION_LOOP_CONTRACT = {
  role: "选题总编", contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION,
  criteria: ["只修订原候选，保持来源绑定。"], maxIterations: 1, deferAudit: true,
};

export function parseTopicIdeasOutput(value: unknown): { ideas: TrendModelIdea[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Topic ideas output must be an object.");
  const ideas = (value as { ideas?: unknown }).ideas;
  // 0 到 8 条都是合法结果：空短名单表示总编认为本轮没有值得推荐的热点。
  if (!Array.isArray(ideas) || ideas.length > 8) throw new Error("Topic ideas output must contain 0 to 8 ideas.");
  const parsed = ideas.flatMap(parseModelIdea);
  if (parsed.length !== ideas.length) throw new Error("Topic ideas output contains an invalid idea.");
  return { ideas: parsed };
}

function parseModelIdea(value: unknown): TrendModelIdea[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  const textKeys = ["signalId", "title", "track", "audience", "painPoint", "hook", "rationale"] as const;
  if (textKeys.some((key) => typeof item[key] !== "string" || !(item[key] as string).trim())) return [];
  if (!Array.isArray(item.facts) || !Array.isArray(item.uncertainties) || item.facts.length > 24 || item.uncertainties.length > 24) return [];
  const facts = item.facts.flatMap(parseArticleFact);
  if (facts.length !== item.facts.length) return [];
  const uncertainties = item.uncertainties
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()) && entry.trim().length <= 500)
    .map((entry) => entry.trim());
  if (uncertainties.length !== item.uncertainties.length) return [];
  // C3/CG-07：角色合同声明 everyIdeaMustProvideSpecificVisualPlan 与 0–100 整数评分，
  // 解析器必须真实执行——缺失的视觉方案不能在通过审计后由展示层默认补齐。
  if (item.visualPlan === undefined) return [];
  let visualPlan: StudioVisualPlan;
  try {
    visualPlan = parseStudioVisualPlan(item.visualPlan);
  } catch {
    return [];
  }
  const scores = {
    novelty: number(item.novelty),
    seriesPotential: number(item.seriesPotential),
    monetization: number(item.monetization),
    audienceDemand: number(item.audienceDemand),
  };
  if (Object.values(scores).some((score) => !Number.isInteger(score) || score < 0 || score > 100)) return [];
  // number() 会把缺失字段折成 0，而“观众需求 0”是一个具体结论；缺字段必须拒收。
  if (typeof item.audienceDemand !== "number") return [];
  return [{
    signalId: item.signalId as string,
    title: item.title as string,
    track: item.track as string,
    audience: item.audience as string,
    painPoint: item.painPoint as string,
    hook: item.hook as string,
    rationale: item.rationale as string,
    facts,
    uncertainties,
    ...(typeof item.visualProof === "string" && item.visualProof.trim() ? { visualProof: item.visualProof } : {}),
    visualPlan,
    ...(item.visualFeasibility !== undefined ? { visualFeasibility: number(item.visualFeasibility) } : {}),
    ...(item.productionCostEfficiency !== undefined ? { productionCostEfficiency: number(item.productionCostEfficiency) } : {}),
    ...scores,
  }];
}

function parseArticleFact(value: unknown): StudioArticleFact[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["statement", "sourceId", "paragraphIds", "uncertainty"].includes(key))) return [];
  if (typeof item.statement !== "string" || !item.statement.trim() || item.statement.trim().length > 500) return [];
  if (typeof item.sourceId !== "string" || !item.sourceId.trim() || item.sourceId.trim().length > 128) return [];
  if (!Array.isArray(item.paragraphIds) || item.paragraphIds.length === 0 || item.paragraphIds.length > 16) return [];
  const paragraphIds = item.paragraphIds
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()) && entry.trim().length <= 64)
    .map((entry) => entry.trim());
  if (paragraphIds.length !== item.paragraphIds.length || new Set(paragraphIds).size !== paragraphIds.length) return [];
  if (item.uncertainty !== undefined && item.uncertainty !== null
    && (typeof item.uncertainty !== "string" || !item.uncertainty.trim() || item.uncertainty.trim().length > 500)) return [];
  return [{
    statement: item.statement.trim(),
    sourceId: item.sourceId.trim(),
    paragraphIds,
    ...(typeof item.uncertainty === "string" ? { uncertainty: item.uncertainty.trim() } : {}),
  }];
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
