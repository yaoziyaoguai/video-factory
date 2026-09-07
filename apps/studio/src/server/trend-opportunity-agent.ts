import { createHash } from "node:crypto";
import path from "node:path";
import {
  CodexBridgeClient,
  fileRoleAgentLoopCheckpoint,
  roleAgentCheckpointKey,
  runRoleAgentLoop,
} from "@video-factory/production-pipeline";
import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type {
  StudioTrendCandidate,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTopicCategory,
  StudioTopicStrategy,
  StudioVisualPlan,
} from "../shared/api.js";
import { parseStudioVisualPlan } from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import { classifyTopicCategory, topicRiskLevel } from "./topic-taxonomy.js";

const TOPIC_EDITOR_AGENT_CONTRACT_VERSION = "topic-editor-v5|role-audit-v1|topic-ideas-validator-v3|complete-role-scope-v1|canonical-signal-groups-v1|downstream-source-gate-v1|visual-plan-v1";

export interface TrendSignalPort {
  listSignals(input: StudioTrendSignalQuery): Promise<StudioTrendSignal[]>;
}

export interface TrendModelIdea {
  signalId: string;
  title: string;
  track: string;
  audience: string;
  painPoint: string;
  hook: string;
  rationale: string;
  visualProof?: string;
  visualPlan?: StudioVisualPlan;
  visualFeasibility?: number;
  productionCostEfficiency?: number;
  novelty: number;
  seriesPotential: number;
  monetization: number;
}

export interface TrendModelSignal extends StudioTrendSignal {
  relatedSignals: StudioTrendSignal[];
}

export interface TrendIdeaModel {
  id: string;
  generate(signals: TrendModelSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]>;
}

export interface TrendOpportunityAgentOptions {
  signals: TrendSignalPort;
  model?: TrendIdeaModel;
  now?: () => Date;
  strategy?: () => Promise<StudioTopicStrategy>;
}

// 候选台是总编做过取舍的短名单，不是把聚合榜单换一种样式全部搬进来。
const TREND_CANDIDATE_LIMIT = 12;

export class TrendOpportunityAgent {
  private readonly now: () => Date;

  constructor(private readonly options: TrendOpportunityAgentOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async listCandidates(): Promise<StudioTrendCandidate[]> {
    const signals = await this.options.signals.listSignals({ limit: 160 });
    const strategy = await this.options.strategy?.().catch(() => undefined);
    const signalGroups = groupEquivalentSignals(signals)
      .filter((group) => !strategyExcludesSignal(strategy, group[0]!));
    const modelSignals = signalGroups.map((group): TrendModelSignal => ({
      ...group[0]!,
      relatedSignals: group.slice(1),
    }));
    if (this.options.model) {
      try {
        const ideas = await generateModelIdeas(this.options.model, modelSignals, strategy);
        const modelCandidates = new Map<string, StudioTrendCandidate>();
        for (const idea of ideas) {
          const group = signalGroups.find((items) => items[0]?.id === idea.signalId);
          if (group && !modelCandidates.has(idea.signalId)) {
            const candidate = this.fromModelIdea(idea, group);
            if (candidate) modelCandidates.set(idea.signalId, candidate);
          }
        }
        // 模型成功返回（含合法空短名单与全部被事实校验拒绝）就是总编本轮的最终取舍；
        // 此时不再回填规则候选，否则未经独立复核的内容会混进推荐。
        const selectedByModel = [...modelCandidates.values()].sort(byFinalScore).slice(0, 8);
        return selectCandidatePortfolio(selectedByModel, [], TREND_CANDIDATE_LIMIT);
      } catch {
        // 只有模型执行真正失败时，才退回可追溯的规则候选保底。
      }
    }
    return selectCandidatePortfolio(
      [],
      signalGroups.map((group) => this.fromSignal(group, strategy))
        .sort((left, right) => byStrategyThenFinal(left, right, strategy)),
      TREND_CANDIDATE_LIMIT,
    );
  }

  private fromModelIdea(idea: TrendModelIdea, signals: StudioTrendSignal[]): StudioTrendCandidate | null {
    const signal = signals[0]!;
    const grounded = groundModelIdea(idea, signals);
    // 含原始信号不支持的数字、引语、英文专名或 clickbait 的 idea 被拒绝，
    // 不用机械标题顶替后绕过独立复核。
    if (!grounded) return null;
    const scores = [idea.novelty, idea.seriesPotential, idea.monetization].map(normalizePercent);
    const allZero = scores.every((value) => value === 0);
    return this.buildCandidate({
      signal,
      relatedSignals: signals,
      title: grounded.title,
      track: grounded.track,
      audience: grounded.audience,
      painPoint: grounded.painPoint,
      hook: grounded.hook,
      rationale: grounded.rationale,
      ...(grounded.visualProof ? { visualProof: grounded.visualProof } : {}),
      ...(grounded.visualPlan ? { visualPlan: grounded.visualPlan } : {}),
      providerId: this.options.model!.id,
      ...(idea.visualFeasibility === undefined ? {} : {
        visualFeasibility: idea.visualProof !== undefined && !grounded.visualProof
          ? 45
          : normalizePercent(idea.visualFeasibility),
      }),
      ...(idea.productionCostEfficiency === undefined ? {} : { productionCostEfficiency: normalizePercent(idea.productionCostEfficiency) }),
      novelty: allZero ? 64 : scores[0]!,
      seriesPotential: allZero ? 72 : scores[1]!,
      monetization: allZero ? 52 : scores[2]!,
    });
  }

  private fromSignal(signals: StudioTrendSignal[], strategy?: StudioTopicStrategy): StudioTrendCandidate {
    const signal = signals[0]!;
    const risk = complianceRisk(signal.title);
    const track = inferTrack(signal.title);
    return this.buildCandidate({
      signal,
      relatedSignals: signals,
      title: risk >= 60 ? groundedEditorialTitle(signal.title, track) : signal.title,
      track,
      audience: strategy?.targetAudience?.trim() || audienceFor(track),
      painPoint: strategy?.positioning?.trim()
        ? `热点信息很多，需要按照“${strategy.positioning.trim()}”筛出真正值得讲的部分`
        : "热点信息很多，但缺少一个与普通人直接相关的解释角度",
      hook: risk >= 60
        ? `${signal.title}正在上榜。先不猜结论，只核验可靠来源已经确认了什么？`
        : `“${signal.title}”正在上升，它到底与你有什么关系？`,
      rationale: risk >= 60
        ? risk >= 72
          ? `该热点涉及高风险公共事件；系统未扩写事实，只保留原始信号与核验问题。`
          : `该热点涉及需要核验的公共议题；系统未扩写事实，只保留原始信号与核验问题。`
        : `${platformLabel(signal.platform)}榜单排名 ${signal.rank}，采用零成本规则评分并保留原始证据。`,
      providerId: "trend-heuristic-v1",
      novelty: risk >= 60 ? 40 : track === "breaking-news" ? 48 : 72,
      monetization: risk >= 60 ? 25 : track === "ai-daily-life" ? 76 : 55,
      seriesPotential: risk >= 60 ? 38 : track === "breaking-news" ? 45 : 78,
    });
  }

  private buildCandidate(input: {
    signal: StudioTrendSignal;
    relatedSignals: StudioTrendSignal[];
    title: string;
    track: string;
    audience: string;
    painPoint: string;
    hook: string;
    rationale: string;
    visualProof?: string;
    visualPlan?: StudioVisualPlan;
    providerId: string;
    novelty: number;
    monetization: number;
    seriesPotential: number;
    visualFeasibility?: number;
    productionCostEfficiency?: number;
  }): StudioTrendCandidate {
    const strength = Math.max(20, Math.min(100, 100 - input.signal.rank));
    const risk = complianceRisk(input.signal.title);
    const candidate = scoreTopicCandidate(candidateId(input.signal.id, input.title), {
      platform: input.signal.platform,
      track: input.track,
      audience: input.audience,
      painPoint: input.painPoint,
      hook: input.hook,
      evidence: input.relatedSignals.map((signal) => ({
        source: signal.sourceId,
        platform: signal.platform,
        keyword: signal.title,
        strength: Math.max(20, Math.min(100, 100 - signal.rank)),
        ...(signal.url ? { evidenceUrl: signal.url } : {}),
        collectedAt: signal.collectedAt,
      })),
      audienceReach: input.signal.heat ? Math.min(100, 65 + Math.log10(Math.max(1, input.signal.heat)) * 4.5) : strength,
      visualFeasibility: risk >= 60 ? 52 : normalizePercent(input.visualFeasibility ?? 82),
      productionCostEfficiency: risk >= 60 ? 58 : normalizePercent(input.productionCostEfficiency ?? 88),
      novelty: input.novelty,
      monetization: input.monetization,
      seriesPotential: input.seriesPotential,
      complianceRisk: risk,
    });
    const title = clean(input.title, input.signal.title);
    const hook = clean(input.hook, `这条热点，真正影响的是普通人的选择。`);
    return {
      id: candidate.id,
      title,
      platform: candidate.platform,
      track: clean(input.track, "general-trend"),
      audience: clean(input.audience, "中文短视频用户"),
      painPoint: clean(input.painPoint, "需要快速理解热点与自己的关系"),
      hook,
      rationale: clean(input.rationale, "来自本地热点网关的可追溯候选。", RATIONALE_TEXT_LIMIT),
      ...(input.visualProof ? { visualProof: clean(input.visualProof, "", VISUAL_PROOF_TEXT_LIMIT) } : {}),
      providerId: input.providerId,
      generatedAt: this.now().toISOString(),
      evidence: candidate.evidence,
      score: candidate.score,
      category: classifyTopicCategory(title, input.track, input.relatedSignals.map((item) => item.title)),
      visualPlan: structuredClone(input.visualPlan ?? planVisualDirection({ title, hook })),
    };
  }
}

async function generateModelIdeas(model: TrendIdeaModel, signals: TrendModelSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]> {
  try {
    // 空短名单是模型的合法结论（本轮无值得推荐），不触发第二次调用。
    return await model.generate(signals.slice(0, 24), strategy);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return model.generate(signals.slice(0, 12), strategy);
  }
}

// providerId 保持 api-topic-editor-v1，与 provider catalog 及既有候选记录兼容。
export class CodexTopicIdeaModel implements TrendIdeaModel {
  readonly id = "api-topic-editor-v1";
  private readonly client: CodexBridgeClient;

  constructor(
    client: CodexBridgeClient,
    private readonly maxReviewIterations = 3,
    private readonly checkpointDirectory?: string,
  ) {
    this.client = client;
  }

  async generate(signals: TrendModelSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]> {
    const request = {
      signals: signals.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        platform: item.platform,
        rank: item.rank,
        title: item.title,
        heat: item.heat ?? null,
        ...(item.url ? { url: item.url } : {}),
        collectedAt: item.collectedAt,
        relatedSignals: item.relatedSignals.map((related) => ({
          id: related.id,
          sourceId: related.sourceId,
          platform: related.platform,
          rank: related.rank,
          title: related.title,
          heat: related.heat ?? null,
          ...(related.url ? { url: related.url } : {}),
          collectedAt: related.collectedAt,
        })),
      })),
      ...(strategy ? { strategy: formatTopicStrategy(strategy) } : {}),
    };
    const execution = await runRoleAgentLoop<{ ideas: TrendModelIdea[] }>({
      role: "选题总编",
      contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION,
      criteria: [
        "每个选题都可追溯到一个输入热点，不增加原信号没有的事实、数字、引语或因果",
        "角度对普通观众有明确收益，且不是对热搜标题的简单改写",
        "视觉可表现性、证据可得性、制作成本、合规风险和系列潜力得到实际权衡",
        "钩子能在两秒内建立具体问题或反差，但不夸张、不消费灾害伤亡或政治突发",
        "榜单排名、热度与链接只是来源线索，不得把热度当作事实或结论引用",
        "先评内容潜力与适合的视频形态；来源数量门槛由下游执行，不得仅因来源暂时不足删除有潜力且可补源的角度",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session }) => this.client.runTaskDetailed("topic-ideas", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId, session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId, session }) => this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["ideas.signalId", "ideas.track", "ideas.title", "ideas.audience", "ideas.painPoint", "ideas.hook", "ideas.rationale", "ideas.visualProof", "ideas.visualPlan", "ideas scores"],
            doesNotOwn: ["热点原始事实", "新闻核验结果", "脚本与成片"],
          },
          upstreamFacts: request,
          currentRoleContract: {
            maxIdeas: 8,
            emptyIdeasMeansNoRecommendation: true,
            signalLinksAreLeadsOnly: true,
            everyIdeaMustReferenceOneSignal: true,
            everyIdeaMustExplainVisibleEvidence: true,
            everyIdeaMustProvideSpecificVisualPlan: true,
            scoresAreIntegersFromZeroToOneHundred: true,
            sourceGateAppliedDownstream: true,
            sourceBlockedIdeasRemainVisibleForSupplement: true,
            emptyIdeasCannotBeJustifiedSolelyByMissingSourceCount: true,
          },
          downstreamBoundary: "只提出可生产的原创角度并推荐合适的视频形态；不得补写热点中不存在的事实，也不得要求脚本或成片已经生成。来源开工门槛由下游执行，来源不足但有内容与视觉潜力的角度必须保留为可补源候选。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
      }, requestId, session),
      validate: parseTopicIdeasOutput,
      ...(this.checkpointDirectory ? {
        checkpoint: fileRoleAgentLoopCheckpoint(
          path.join(this.checkpointDirectory, `${roleAgentCheckpointKey({ request, contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION })}.json`),
          roleAgentCheckpointKey({ request, contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION }),
        ),
      } : {}),
    });
    return execution.output.ideas;
  }
}

function formatTopicStrategy(strategy: StudioTopicStrategy): string {
  return [
    strategy.positioning ? `内容定位：${strategy.positioning}` : undefined,
    strategy.targetAudience ? `核心受众：${strategy.targetAudience}` : undefined,
    strategy.preferredDirections ? `优先题材：\n${strategy.preferredDirections}` : undefined,
    strategy.excludedDirections ? `明确避开：\n${strategy.excludedDirections}` : undefined,
    strategy.sourcePolicy === "traceable_source"
      ? "来源工作流：来源开工门槛由下游执行；总编不得按来源数量淘汰角度。来源不足但内容与视觉潜力成立的角度仍须输出，供创作者补充原始来源；下游通常要求至少一个有效原始来源，高风险事实仍需额外核验。"
      : "来源工作流：来源开工门槛由下游执行；总编不得按来源数量淘汰角度。来源不足但内容与视觉潜力成立的角度仍须输出，供创作者补充来源；下游再核对原始来源或两个不同域名的独立来源。",
    strategy.customInstruction ? `补充原则：${strategy.customInstruction}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n\n").slice(0, 6_000);
}

function strategyExcludesSignal(strategy: StudioTopicStrategy | undefined, signal: StudioTrendSignal): boolean {
  if (!strategy?.excludedDirections?.trim()) return false;
  const subject = `${signal.title} ${signal.platform}`.toLowerCase();
  return strategyTerms(strategy.excludedDirections).some((term) => subject.includes(term));
}

function byStrategyThenFinal(
  left: StudioTrendCandidate,
  right: StudioTrendCandidate,
  strategy?: StudioTopicStrategy,
): number {
  const preferred = strategyTerms(strategy?.preferredDirections ?? "");
  const preference = (candidate: StudioTrendCandidate) => {
    const subject = `${candidate.title} ${candidate.track} ${candidate.rationale}`.toLowerCase();
    return preferred.filter((term) => subject.includes(term)).length;
  };
  return preference(right) - preference(left) || byFinalScore(left, right);
}

function strategyTerms(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[\s\n,，、;；。/或与及]+/)
    .map((term) => term.replace(/^(?:只有|无法|消费|未经证实的|只能靠|优先|避免|不要)/, "").trim())
    .filter((term) => term.length >= 2))];
}

function parseTopicIdeasOutput(value: unknown): { ideas: TrendModelIdea[] } {
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
  return [{
    signalId: item.signalId as string,
    title: item.title as string,
    track: item.track as string,
    audience: item.audience as string,
    painPoint: item.painPoint as string,
    hook: item.hook as string,
    rationale: item.rationale as string,
    ...(typeof item.visualProof === "string" && item.visualProof.trim() ? { visualProof: item.visualProof } : {}),
    ...(item.visualPlan === undefined ? {} : { visualPlan: parseStudioVisualPlan(item.visualPlan) }),
    ...(item.visualFeasibility !== undefined ? { visualFeasibility: number(item.visualFeasibility) } : {}),
    ...(item.productionCostEfficiency !== undefined ? { productionCostEfficiency: number(item.productionCostEfficiency) } : {}),
    novelty: number(item.novelty),
    seriesPotential: number(item.seriesPotential),
    monetization: number(item.monetization),
  }];
}

function inferTrack(title: string): string {
  if (/\bAI\b|人工智能|机器人|模型|科技/i.test(title)) return "ai-daily-life";
  if (/职场|上班|下班|工作|工资|就业/.test(title)) return "work-life";
  if (/比赛|冠军|男篮|女篮|足球|篮球|中超|世锦赛/.test(title)) return "sports-context";
  if (/台风|暴雨|地震|救灾|事故|伤亡|去世|死亡/.test(title)) return "breaking-news";
  return "ordinary-life";
}

function audienceFor(track: string): string {
  if (track === "ai-daily-life") return "想把 AI 用进真实生活的普通上班族";
  if (track === "work-life") return "关注工作与生活边界的上班族";
  if (track === "sports-context") return "想快速理解赛事意义的泛体育用户";
  return "关注热点与日常生活关系的中文短视频用户";
}

function complianceRisk(title: string): number {
  const level = topicRiskLevel(title);
  return level === "high" ? 72 : level === "review" ? 60 : 16;
}

function candidateId(signalId: string, title: string): string {
  return `trend-${createHash("sha1").update(`${signalId}:${title}`).digest("hex").slice(0, 14)}`;
}

function clean(value: string, fallback: string, limit = 180): string {
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (normalized.length <= limit) return normalized;
  // 截断只允许落在完整句子边界：优先取上限内最后一个句末标点；
  // 上限内没有句末时延长到下一个句末，避免把 rationale 或可见画面切成半句。
  const within = normalized.slice(0, limit);
  const lastEnd = lastIndexOfAny(within, SENTENCE_END_MARKS);
  if (lastEnd >= MIN_TRUNCATION_KEEP) return normalized.slice(0, lastEnd + 1);
  const nextEnd = indexOfAny(normalized, SENTENCE_END_MARKS, limit);
  if (nextEnd >= 0 && nextEnd <= limit * 2) return normalized.slice(0, nextEnd + 1);
  const lastClause = lastIndexOfAny(within, CLAUSE_END_MARKS);
  if (lastClause >= MIN_TRUNCATION_KEEP) return normalized.slice(0, lastClause);
  return normalized.slice(0, limit);
}

const SENTENCE_END_MARKS = ["。", "！", "？", "!", "?"] as const;
const CLAUSE_END_MARKS = ["，", "、", "；", ";", " "] as const;
const MIN_TRUNCATION_KEEP = 24;
const RATIONALE_TEXT_LIMIT = 320;
const VISUAL_PROOF_TEXT_LIMIT = 240;

function lastIndexOfAny(value: string, marks: readonly string[]): number {
  return Math.max(...marks.map((mark) => value.lastIndexOf(mark)));
}

function indexOfAny(value: string, marks: readonly string[], from: number): number {
  const positions = marks.map((mark) => value.indexOf(mark, from)).filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : -1;
}

function normalizeTrack(value: string, signalTitle: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
    ? normalized
    : inferTrack(`${signalTitle} ${value}`);
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePercent(value: number): number {
  const normalized = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, normalized));
}

// 独立复核通过后只做字段级 claim 校验：
// - 高风险公共事件不再仅因“敏感/高风险”被整组替换；风险标签与来源门禁在下游继续把关，
//   只有实际无法被来源支持的 claim 才退回保守问句版本；
// - 其余题材含原信号不支持的数字、引语、英文专名或 clickbait 的 idea 直接拒绝，
//   不用机械标题顶替后绕过复核。
function groundModelIdea(idea: TrendModelIdea, signals: StudioTrendSignal[]): TrendModelIdea | null {
  const signal = signals[0]!;
  const sourceText = signals.map((item) => item.title).join("；");
  const sourceNumbers = new Set(numberTokens(sourceText));
  const riskLevel = topicRiskLevel(signal.title);
  const bodyUnsafe = [idea.audience, idea.painPoint, idea.hook, idea.rationale, idea.visualProof ?? ""]
    .some((value) => unsupportedClaim(value, sourceText, sourceNumbers)
      || (riskLevel === "high" && unsupportedHighRiskAssertion(value, sourceText)));
  const titleUnsafe = unsupportedClaim(idea.title, sourceText, sourceNumbers)
    || (riskLevel === "high" && unsupportedHighRiskAssertion(idea.title, sourceText))
    || !isEditoriallyDistinct(idea.title, signal.title);
  if (bodyUnsafe || titleUnsafe) {
    if (riskLevel !== "high") return null;
    return conservativeHighRiskIdea(idea, signal);
  }
  return {
    ...idea,
    track: normalizeTrack(idea.track, signal.title),
    title: clean(idea.title, signal.title),
    audience: idea.audience,
    painPoint: idea.painPoint,
    hook: clean(idea.hook, `先核验“${signal.title}”中真正影响普通人的部分。`),
    rationale: clean(idea.rationale, `模型提出“${idea.title}”角度；进入选题池前仍需人工核验。`, RATIONALE_TEXT_LIMIT),
    visualProof: clean(idea.visualProof ?? "", "", VISUAL_PROOF_TEXT_LIMIT),
  };
}

// 只有无法被来源支持的 claim 才进入这里：高风险信号退回只基于原始信号的保守问句，
// 保留安全边际与风险标签，不把模型新增事实带进候选。
function conservativeHighRiskIdea(idea: TrendModelIdea, signal: StudioTrendSignal): TrendModelIdea {
  const { visualPlan: _unsafeVisualPlan, ...safeIdea } = idea;
  return {
    ...safeIdea,
    track: normalizeTrack(idea.track, signal.title),
    title: groundedEditorialTitle(signal.title, idea.track),
    audience: "关注这一热点与日常生活关系的中文短视频用户",
    painPoint: "热点结论很多，但缺少只基于现有证据的解释",
    hook: `${signal.title}正在上榜。先不猜结论，只看哪些问题能够被证据支持？`,
    rationale: "该热点涉及高风险公共事件；系统未采用模型扩写，只保留基于原始信号的核验问题。",
    visualProof: "",
  };
}

function groupEquivalentSignals(signals: StudioTrendSignal[]): StudioTrendSignal[][] {
  const groups: StudioTrendSignal[][] = [];
  for (const signal of signals) {
    const group = groups.find((items) => equivalentTopic(items[0]!, signal)) ?? [];
    if (!group.some((item) => item.sourceId === signal.sourceId && item.platform === signal.platform)) {
      group.push(signal);
      group.sort((left, right) => left.rank - right.rank);
    }
    if (!groups.includes(group)) groups.push(group);
  }
  return groups.sort((left, right) => left[0]!.rank - right[0]!.rank);
}

function equivalentTopic(left: StudioTrendSignal, right: StudioTrendSignal): boolean {
  if (normalizeTopicText(left.title) === normalizeTopicText(right.title)) return true;
  if (left.platform === right.platform) return false;
  const leftNumbers = new Set(numberTokens(left.title));
  const rightNumbers = new Set(numberTokens(right.title));
  if (leftNumbers.size > 0 && rightNumbers.size > 0 && !sameSet(leftNumbers, rightNumbers)) return false;
  const leftTerms = meaningfulTopicTerms(left.title);
  const rightTerms = meaningfulTopicTerms(right.title);
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap >= 2 && overlap / Math.min(leftTerms.size, rightTerms.size) >= 0.4;
}

const TOPIC_STOP_WORDS = new Set([
  "官方", "确认", "最新", "热点", "正在", "开始", "发生", "引发", "背后", "普通人", "为什么",
  "如何", "哪些", "目前", "信息", "结果", "变化", "问题", "关系", "能够", "需要", "真的",
]);

const topicSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

function meaningfulTopicTerms(value: string): Set<string> {
  return new Set([...topicSegmenter.segment(value)]
    .filter((part) => part.isWordLike)
    .map((part) => normalizeTopicText(part.segment))
    .filter((term) => term.length >= 2 && !/^\d+(?:\.\d+)?$/.test(term) && !TOPIC_STOP_WORDS.has(term)));
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function selectCandidatePortfolio(
  anchors: StudioTrendCandidate[],
  candidates: StudioTrendCandidate[],
  limit: number,
): StudioTrendCandidate[] {
  const selected = [...anchors].slice(0, limit);
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const categoryCounts = countBy(selected, (candidate) => candidate.category ?? "lifestyle");
  const platformCounts = countBy(selected, (candidate) => candidate.platform);
  const remaining = candidates.filter((candidate) => !selectedIds.has(candidate.id));
  // 先为新的内容类别保留席位，避免高分但同质的单一热点占满短名单。
  for (const candidate of remaining) {
    const category = candidate.category ?? "lifestyle";
    if (selected.length >= limit) break;
    if (selectedIds.has(candidate.id) || (categoryCounts.get(category) ?? 0) > 0) continue;
    if ((platformCounts.get(candidate.platform) ?? 0) >= 5) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    categoryCounts.set(category, 1);
    platformCounts.set(candidate.platform, (platformCounts.get(candidate.platform) ?? 0) + 1);
  }
  const categoryLimit = Math.max(2, Math.ceil(limit / 4));
  for (const candidate of remaining) {
    const category = candidate.category ?? "lifestyle";
    if (selected.length >= limit) break;
    if (selectedIds.has(candidate.id)) continue;
    if ((categoryCounts.get(category) ?? 0) >= categoryLimit || (platformCounts.get(candidate.platform) ?? 0) >= 5) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    platformCounts.set(candidate.platform, (platformCounts.get(candidate.platform) ?? 0) + 1);
  }
  for (const candidate of remaining) {
    if (selected.length >= limit) break;
    if (selectedIds.has(candidate.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
  return selected.sort(byFinalScore);
}

function countBy<T>(items: T[], key: (item: T) => StudioTopicCategory | string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function isEditoriallyDistinct(value: string, sourceTitle: string): boolean {
  return normalizeTopicText(value) !== normalizeTopicText(sourceTitle);
}

function normalizeTopicText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function groundedEditorialTitle(sourceTitle: string, track: string): string {
  if (/比赛|冠军|男篮|女篮|足球|篮球|中超|世锦赛|电竞|体育/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：这场结果有哪些可核验的看点？`;
  }
  if (/台风|暴雨|地震|天气|灾害/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：现在应该关注哪些可靠信息？`;
  }
  if (/空袭|战争|冲突|外交|制裁/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：目前有哪些信息能够被可靠来源确认？`;
  }
  if (/伤亡|死亡|去世|逝世|病逝|身亡|遇难/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：目前有哪些信息已得到可靠来源确认？`;
  }
  if (/经济|消费|就业|供应链|房价/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：普通人该核验哪些变化？`;
  }
  if (/乡村|留守|教育|社会/.test(`${sourceTitle}${track}`)) {
    return `${sourceTitle}：哪些现实问题值得继续追踪？`;
  }
  return `${sourceTitle}：它与普通人的关系该如何核验？`;
}

function unsupportedClaim(value: string, sourceTitle: string, sourceNumbers: Set<string>): boolean {
  const unsupportedNumber = numberTokens(value).some((token) => !sourceNumbers.has(token));
  const unsupportedAttribution = /透露|表示|宣称|宣布|数据显示|官方数据|调查显示|研究表明|合理估算|据报道|训练日程|内部消息|独家|采访素材/.test(value);
  // 给原信号词组加中文/英文引号不算虚构；只有引住来源里不存在的内容才视为新增引语。
  const unsupportedQuote = quotedSegments(value).some((segment) => !containsPhrase(sourceTitle, segment));
  const sourceTerms = new Set(latinTokens(sourceTitle));
  const unsupportedLatinTerm = latinTokens(value).some((token) => !sourceTerms.has(token));
  const unsupportedClickbait = /内幕|秘密|曝光|真相|首次披露/.test(value) && !/内幕|秘密|曝光|真相|首次披露/.test(sourceTitle);
  return unsupportedNumber || unsupportedAttribution || unsupportedQuote || unsupportedLatinTerm || unsupportedClickbait;
}

// 高风险题材还要拦住没有数字、引语等明显特征的中文新增事实。
// 新增问题、核验角度和观看框架可以保留；带有确定性事实标记且引入来源外实体/状态的陈述必须回退。
function unsupportedHighRiskAssertion(value: string, sourceText: string): boolean {
  const normalized = value.trim();
  if (!normalized || containsPhrase(sourceText, normalized)) return false;
  if (/[？?]|为什么|为何|如何|哪些|什么|是否|能否|该不该|怎么/.test(normalized)) return false;
  if (!/(?:已经|早已|曾|正在|将要|导致|造成|升级|伤亡|病危|传言|网传|网络|数据|未公开|未披露|未确认|已确认|证实|公布|披露)/.test(normalized)) return false;
  const sourceTerms = meaningfulTopicTerms(sourceText);
  return [...meaningfulTopicTerms(normalized)].some((term) => !sourceTerms.has(term) && !HIGH_RISK_EDITORIAL_TERMS.has(term));
}

const HIGH_RISK_EDITORIAL_TERMS = new Set([
  "关注", "核验", "来源", "可靠", "信息", "事实", "问题", "普通人", "观众", "用户", "追踪", "梳理", "解释", "看点",
]);

function quotedSegments(value: string): string[] {
  return [...value.matchAll(/[“"]([^“”"]{1,80})[“”]|'([^']{1,80})'/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter(Boolean);
}

function containsPhrase(source: string, phrase: string): boolean {
  return normalizeTopicText(source).includes(normalizeTopicText(phrase));
}

function numberTokens(value: string): string[] {
  return value.match(/\d+(?:\.\d+)?%?/g) ?? [];
}

function latinTokens(value: string): string[] {
  return (value.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []).map((token) => token.toUpperCase());
}

function platformLabel(platform: string): string {
  return ({ douyin: "抖音", weibo: "微博", zhihu: "知乎", bilibili: "B 站" } as Record<string, string>)[platform] ?? platform;
}

function byFinalScore(left: StudioTrendCandidate, right: StudioTrendCandidate): number {
  return right.score.final - left.score.final;
}
