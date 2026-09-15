import { createHash } from "node:crypto";
import path from "node:path";
import {
  CodexBridgeClient,
  CodexBridgeError,
  fileRoleAgentLoopCheckpoint,
  roleAgentCheckpointKey,
  runRoleAgentLoop,
} from "@video-factory/production-pipeline";
import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type {
  StudioArticleFact,
  StudioTrendCandidate,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTopicCategory,
  StudioTopicGenerationReceipt,
  StudioTopicStrategy,
  StudioVisualPlan,
} from "../shared/api.js";
import { parseStudioVisualPlan } from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import { classifyTopicCategory, topicRiskLevel } from "./topic-taxonomy.js";
import { topicIdeasModelPayload } from "./topic-ideas-payload.js";
import type { TrendArticleReader, TrendArticleSnapshot } from "./trend-article-reader.js";

const TOPIC_EDITOR_AGENT_CONTRACT_VERSION = "topic-editor-v9|role-audit-v3|topic-ideas-validator-v7|complete-role-scope-v1|canonical-signal-groups-v1|downstream-source-gate-v1|visual-plan-v2|angle-identity-v1|cited-facts-v2";

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
  facts?: StudioArticleFact[];
  uncertainties?: string[];
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
  articleSources?: TrendArticleSnapshot[];
}

export interface TrendIdeaModel {
  id: string;
  generate(signals: TrendModelSignal[], strategy?: StudioTopicStrategy, generationNonce?: string): Promise<TrendModelIdea[]>;
  lastExecutionIdentity?(): { providerId: string; modelId: string } | undefined;
}

export interface TrendOpportunityAgentOptions {
  signals: TrendSignalPort;
  model?: TrendIdeaModel;
  now?: () => Date;
  strategy?: () => Promise<StudioTopicStrategy>;
  articleReader?: Pick<TrendArticleReader, "readMany">;
}

export interface TrendCandidateGenerationOptions {
  /** C3-E02：“换一批”的生成身份——同一信号+策略下不同 nonce 产生真正的新一批提案。 */
  generationNonce?: string;
}

// 候选台是总编做过取舍的短名单，不是把聚合榜单换一种样式全部搬进来。
const TREND_CANDIDATE_LIMIT = 12;

export class TrendOpportunityAgent {
  private readonly now: () => Date;
  private lastReceipt: StudioTopicGenerationReceipt | undefined;

  constructor(private readonly options: TrendOpportunityAgentOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async listCandidates(options: TrendCandidateGenerationOptions = {}): Promise<StudioTrendCandidate[]> {
    const signals = await this.options.signals.listSignals({ limit: 160 });
    const strategy = await this.options.strategy?.().catch(() => undefined);
    const compareCandidates = topicCandidateComparator(strategy);
    const signalGroups = groupEquivalentSignals(signals);
    const modelSignals = signalGroups.map((group): TrendModelSignal => ({
      ...group[0]!,
      relatedSignals: group.slice(1),
    }));
    const articleSourcesBySignalId = new Map<string, TrendArticleSnapshot[]>();
    if (this.options.articleReader) {
      const selectedUrls = signalGroups.slice(0, 8).flatMap((group) => group
        .filter((signal) => Boolean(signal.url))
        .filter((signal, index, items) => items.findIndex((item) => item.url === signal.url) === index)
        .slice(0, 2)
        .map((signal) => ({ sourceId: signal.id, url: signal.url!, title: signal.title })));
      const articles = await this.options.articleReader.readMany(selectedUrls);
      for (const signal of modelSignals) {
        const ids = new Set([signal.id, ...signal.relatedSignals.map((related) => related.id)]);
        const articleSources = articles.filter((article) => ids.has(article.sourceId));
        if (articleSources.length) {
          signal.articleSources = articleSources;
          articleSourcesBySignalId.set(signal.id, articleSources);
        }
      }
    }
    let modelFallbackDiagnostic: RuleFallbackDiagnostic | undefined;
    if (this.options.model) {
      try {
        const ideas = await generateModelIdeas(this.options.model, modelSignals, strategy, options.generationNonce);
        // C3-E01：同一 canonical 事件允许多个真正不同的创作方向（不同受众/收益/表现方式），
        // 只有重复角度才去重——不能按 signalId 吞掉同事件的其他角度。
        const modelCandidates: StudioTrendCandidate[] = [];
        const angleKeys = new Set<string>();
        let unknownSignalCount = 0;
        let invalidSourceBindingCount = 0;
        let duplicateAngleCount = 0;
        for (const idea of ideas) {
          const group = signalGroups.find((items) => items[0]?.id === idea.signalId);
          if (!group) {
            unknownSignalCount += 1;
            continue;
          }
          const candidate = this.fromModelIdea(idea, group, articleSourcesBySignalId.get(idea.signalId));
          if (!candidate) {
            invalidSourceBindingCount += 1;
            continue;
          }
          const key = editorialAngleKey(candidate);
          if (angleKeys.has(key)) {
            duplicateAngleCount += 1;
            continue;
          }
          angleKeys.add(key);
          modelCandidates.push(candidate);
        }
        // 模型成功返回（含合法空短名单与全部被事实校验拒绝）就是总编本轮的最终取舍；
        // 此时不再回填规则候选，否则未经独立复核的内容会混进推荐。
        const selectedByModel = modelCandidates
          .filter((candidate) => !matchesExcludedDirection(candidate, strategy))
          .sort(compareCandidates)
          .slice(0, 8);
        const selected = selectCandidatePortfolio(selectedByModel, [], TREND_CANDIDATE_LIMIT, compareCandidates);
        const identity = this.options.model.lastExecutionIdentity?.();
        this.lastReceipt = {
          generationId: options.generationNonce ?? `topic-${this.now().getTime()}`,
          generatedAt: this.now().toISOString(),
          modelInvoked: true,
          source: "editor-model",
          candidateCount: selected.length,
          providerId: identity?.providerId ?? this.options.model.id,
          ...(identity?.modelId ? { modelId: identity.modelId } : {}),
          modelCandidateCount: ideas.length,
          unknownSignalCount,
          invalidSourceBindingCount,
          duplicateAngleCount,
          preferenceExcludedCount: modelCandidates.length - modelCandidates.filter(
            (candidate) => !matchesExcludedDirection(candidate, strategy),
          ).length,
        };
        return selected;
      } catch (error) {
        // 模型轮真正失败才退回规则保底；失败必须带结构化诊断，不得静默冒充模型成果。
        modelFallbackDiagnostic = ruleFallbackDiagnostic(error);
      }
    }
    const fallback = this.options.model ? modelFallbackDiagnostic : undefined;
    const selected = selectCandidatePortfolio(
      [],
      signalGroups.map((group) => this.fromSignal(group, strategy, fallback, articleSourcesBySignalId.get(group[0]!.id)))
        .filter((candidate) => !matchesExcludedDirection(candidate, strategy))
        .sort(compareCandidates),
      TREND_CANDIDATE_LIMIT,
      compareCandidates,
    );
    this.lastReceipt = {
      generationId: options.generationNonce ?? `topic-${this.now().getTime()}`,
      generatedAt: this.now().toISOString(),
      modelInvoked: Boolean(this.options.model),
      source: "rule-fallback",
      candidateCount: selected.length,
      ...(modelFallbackDiagnostic ? {
        failureCategory: modelFallbackDiagnostic.category,
        failureReason: modelFallbackDiagnostic.reason,
      } : {}),
    };
    return selected;
  }

  generationReceipt(): StudioTopicGenerationReceipt | undefined {
    return this.lastReceipt ? structuredClone(this.lastReceipt) : undefined;
  }

  private fromModelIdea(
    idea: TrendModelIdea,
    signals: StudioTrendSignal[],
    articleSources?: TrendArticleSnapshot[],
  ): StudioTrendCandidate | null {
    const signal = signals[0]!;
    const grounded = groundModelIdea(idea, signals, articleSources);
    // 宿主只执行可确定验证的来源绑定；事实是否被正文支持由已经完成的独立总编复核判断。
    if (!grounded) return null;
    const scores = [idea.novelty, idea.seriesPotential, idea.monetization].map(normalizePercent);
    return this.buildCandidate({
      signal,
      relatedSignals: signals,
      ...(articleSources?.length ? { articleSources } : {}),
      ...(grounded.facts?.length ? { articleFacts: grounded.facts } : {}),
      ...(grounded.uncertainties?.length ? { articleUncertainties: grounded.uncertainties } : {}),
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
      novelty: scores[0]!,
      seriesPotential: scores[1]!,
      monetization: scores[2]!,
    });
  }

  private fromSignal(
    signals: StudioTrendSignal[],
    strategy?: StudioTopicStrategy,
    fallback?: RuleFallbackDiagnostic,
    articleSources?: TrendArticleSnapshot[],
  ): StudioTrendCandidate {
    const signal = signals[0]!;
    const risk = complianceRisk(signal.title);
    const track = inferTrack(signal.title);
    return this.buildCandidate({
      signal,
      relatedSignals: signals,
      ...(articleSources?.length ? { articleSources } : {}),
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
      ...(fallback ? { generationFallback: fallback } : {}),
      novelty: risk >= 60 ? 40 : track === "breaking-news" ? 48 : 72,
      monetization: risk >= 60 ? 25 : track === "ai-daily-life" ? 76 : 55,
      seriesPotential: risk >= 60 ? 38 : track === "breaking-news" ? 45 : 78,
    });
  }

  private buildCandidate(input: {
    signal: StudioTrendSignal;
    relatedSignals: StudioTrendSignal[];
    articleSources?: TrendArticleSnapshot[];
    articleFacts?: StudioArticleFact[];
    articleUncertainties?: string[];
    title: string;
    track: string;
    audience: string;
    painPoint: string;
    hook: string;
    rationale: string;
    visualProof?: string;
    visualPlan?: StudioVisualPlan;
    providerId: string;
    generationFallback?: RuleFallbackDiagnostic;
    novelty: number;
    monetization: number;
    seriesPotential: number;
    visualFeasibility?: number;
    productionCostEfficiency?: number;
  }): StudioTrendCandidate {
    const strength = Math.max(20, Math.min(100, 100 - input.signal.rank));
    const risk = complianceRisk(input.signal.title);
    const candidate = scoreTopicCandidate(candidateId(input.signal.id, input.title, input.audience, input.track), {
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
      ...(input.generationFallback ? { generationFallback: input.generationFallback } : {}),
      hook,
      rationale: clean(input.rationale, "来自本地热点网关的可追溯候选。", RATIONALE_TEXT_LIMIT),
      ...(input.visualProof ? { visualProof: clean(input.visualProof, "", VISUAL_PROOF_TEXT_LIMIT) } : {}),
      providerId: input.providerId,
      generatedAt: this.now().toISOString(),
      evidence: candidate.evidence,
      ...(input.articleSources?.length ? { articleSources: structuredClone(input.articleSources) } : {}),
      ...(input.articleFacts?.length ? { articleFacts: structuredClone(input.articleFacts) } : {}),
      ...(input.articleUncertainties?.length ? { articleUncertainties: [...input.articleUncertainties] } : {}),
      score: candidate.score,
      category: classifyTopicCategory(title, input.track, input.relatedSignals.map((item) => item.title)),
      visualPlan: structuredClone(input.visualPlan ?? planVisualDirection({ title, hook })),
    };
  }
}


async function generateModelIdeas(model: TrendIdeaModel, signals: TrendModelSignal[], strategy?: StudioTopicStrategy, generationNonce?: string): Promise<TrendModelIdea[]> {
  try {
    // 空短名单是模型的合法结论（本轮无值得推荐），不触发第二次调用。
    return await model.generate(signals.slice(0, 24), strategy, generationNonce);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return model.generate(signals.slice(0, 12), strategy, generationNonce);
  }
}

// providerId 保持 api-topic-editor-v1，与 provider catalog 及既有候选记录兼容。
export class CodexTopicIdeaModel implements TrendIdeaModel {
  readonly id = "api-topic-editor-v1";
  private readonly client: CodexBridgeClient;
  private executionIdentity: { providerId: string; modelId: string } | undefined;

  constructor(
    client: CodexBridgeClient,
    private readonly maxReviewIterations = 3,
    private readonly checkpointDirectory?: string,
  ) {
    this.client = client;
  }

  async generate(signals: TrendModelSignal[], strategy?: StudioTopicStrategy, generationNonce?: string): Promise<TrendModelIdea[]> {
    // canonical payload 只含 signals/strategy；generationNonce 只进入生成身份（checkpoint key）。
    const { payload, generationNonce: identityNonce } = topicIdeasModelPayload(signals, strategy, generationNonce);
    const request = { ...payload, ...(identityNonce ? { generationNonce: identityNonce } : {}) };
    const execution = await runRoleAgentLoop<{ ideas: TrendModelIdea[] }>({
      role: "选题总编",
      contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION,
      criteria: [
        "逐项审查 title、hook、rationale、facts、visualProof 与 visualPlan：事实、数字、引语和因果须由可读正文支持；创作标签、假设演算、受众描述和明确的不确定表达无需原文逐字出现",
        "角度对普通观众有明确收益，且不是对热搜标题的简单改写",
        "视觉可表现性、证据可得性、制作成本、合规风险和系列潜力得到实际权衡",
        "钩子能在两秒内建立具体问题或反差，但不夸张、不消费灾害伤亡或政治突发",
        "榜单排名、热度与链接只是来源线索，不得把热度当作事实或结论引用",
        "先评内容潜力与适合的视频形态；来源数量门槛由下游执行，不得仅因来源暂时不足删除有潜力且可补源的角度",
      ],
      maxIterations: this.maxReviewIterations,
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("topic-ideas", {
        ...payload,
        ...(revision ? { revision } : {}),
      }, requestId, session, requestOptions),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["ideas.signalId", "ideas.track", "ideas.title", "ideas.audience", "ideas.painPoint", "ideas.hook", "ideas.rationale", "ideas.facts", "ideas.uncertainties", "ideas.visualProof", "ideas.visualPlan", "ideas scores"],
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
            everyFactMustCiteReadableArticleParagraphs: true,
            reviewAllCandidateFieldsForUnsupportedFactualClaims: true,
            creativeFramingDoesNotRequireVerbatimSourceText: true,
            scoresAreIntegersFromZeroToOneHundred: true,
            sourceGateAppliedDownstream: true,
            sourceBlockedIdeasRemainVisibleForSupplement: true,
            emptyIdeasCannotBeJustifiedSolelyByMissingSourceCount: true,
          },
          downstreamBoundary: "只提出可生产的原创角度并推荐合适的视频形态；不得补写热点中不存在的事实，也不得要求脚本或成片已经生成。来源开工门槛由下游执行，来源不足但有内容与视觉潜力的角度必须保留为可补源候选。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, session, requestOptions),
      validate: parseTopicIdeasOutput,
      ...(this.checkpointDirectory ? {
        checkpoint: fileRoleAgentLoopCheckpoint(
          path.join(this.checkpointDirectory, `${roleAgentCheckpointKey({ request, contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION })}.json`),
          roleAgentCheckpointKey({ request, contractVersion: TOPIC_EDITOR_AGENT_CONTRACT_VERSION }),
        ),
      } : {}),
    });
    this.executionIdentity = execution.trace
      ? { providerId: execution.trace.providerId, modelId: execution.trace.modelId }
      : undefined;
    return execution.output.ideas;
  }

  lastExecutionIdentity(): { providerId: string; modelId: string } | undefined {
    return this.executionIdentity ? { ...this.executionIdentity } : undefined;
  }
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
  };
  if (Object.values(scores).some((score) => !Number.isInteger(score) || score < 0 || score > 100)) return [];
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

// C3/CG-04：候选 id 与角度去重共用同一身份投影（canonical 事件 + 编辑角度）。
// 同事件同标题不同受众是两个可独立寻址的候选；跨事件的相同标题/受众不会被误合并。
function candidateId(signalId: string, title: string, audience: string, track: string): string {
  return `trend-${createHash("sha1").update(`${signalId}:${title}:${audience}:${track}`).digest("hex").slice(0, 14)}`;
}

// C3-E01：角度身份 = 归一化标题 + 受众 + 题材。同事件下受众或收益不同的方向是
// 不同的 angleId；只有三者全部相同（同一角度重复提交）才去重。
function editorialAngleKey(candidate: StudioTrendCandidate): string {
  return [
    normalizeTopicText(candidate.title),
    normalizeTopicText(candidate.audience),
    normalizeTopicText(candidate.track),
  ].join("|");
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
  return Math.min(100, Math.max(0, value));
}

// 模型候选已经经过独立总编复核；宿主只核对机器可证明的来源身份和正文段落引用。
// 引号、英文、数字与归因动词本身不代表虚构，不能在复核通过后再用词面规则推翻语义判断。
function groundModelIdea(
  idea: TrendModelIdea,
  signals: StudioTrendSignal[],
  articleSources: TrendArticleSnapshot[] | undefined,
): TrendModelIdea | null {
  const signal = signals[0]!;
  const readableSources = new Map((articleSources ?? [])
    .filter((source) => source.readStatus === "read" || source.readStatus === "partial")
    .map((source) => [source.sourceId, source]));
  for (const fact of idea.facts ?? []) {
    const source = readableSources.get(fact.sourceId);
    if (!source) return null;
    const paragraphs = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
    for (const paragraphId of fact.paragraphIds) {
      const paragraph = paragraphs.get(paragraphId);
      if (!paragraph) return null;
    }
  }
  if (!isEditoriallyDistinct(idea.title, signal.title)) return null;
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
  compareCandidates: (left: StudioTrendCandidate, right: StudioTrendCandidate) => number = byFinalScore,
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
  return selected.sort(compareCandidates);
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

function numberTokens(value: string): string[] {
  return value.match(/\d+(?:\.\d+)?%?/g) ?? [];
}

function platformLabel(platform: string): string {
  return ({ douyin: "抖音", weibo: "微博", zhihu: "知乎", bilibili: "B 站" } as Record<string, string>)[platform] ?? platform;
}

function byFinalScore(left: StudioTrendCandidate, right: StudioTrendCandidate): number {
  return right.score.final - left.score.final;
}

function topicCandidateComparator(
  strategy: StudioTopicStrategy | undefined,
): (left: StudioTrendCandidate, right: StudioTrendCandidate) => number {
  return (left, right) => (
    strategyPreferenceRank(right, strategy) - strategyPreferenceRank(left, strategy)
    || byFinalScore(left, right)
  );
}

function strategyPreferenceRank(candidate: StudioTrendCandidate, strategy: StudioTopicStrategy | undefined): number {
  return strategyDirections(strategy?.preferredDirections).some((direction) => directionMatches(candidate, direction)) ? 1 : 0;
}

function matchesExcludedDirection(candidate: StudioTrendCandidate, strategy: StudioTopicStrategy | undefined): boolean {
  return strategyDirections(strategy?.excludedDirections).some((direction) => directionMatches(candidate, direction));
}

function strategyDirections(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function directionMatches(candidate: StudioTrendCandidate, direction: string): boolean {
  const content = [
    candidate.title,
    candidate.track,
    candidate.audience,
    candidate.painPoint,
    candidate.hook,
    candidate.visualProof ?? "",
    candidate.visualPlan?.strategy ?? "",
    ...(candidate.visualPlan?.beats.flatMap((beat) => [beat.role, beat.description, beat.searchQuery]) ?? []),
    ...candidate.evidence.map((item) => item.keyword),
  ].join(" ");
  const normalizedDirection = normalizeTopicText(direction);
  const normalizedContent = normalizeTopicText(content);
  if (!normalizedDirection) return false;
  if (normalizedContent.includes(normalizedDirection)) return true;
  const terms = meaningfulTopicTerms(direction);
  if (terms.size === 0) return false;
  const contentTerms = meaningfulTopicTerms(content);
  return [...terms].every((term) => contentTerms.has(term));
}


export interface RuleFallbackDiagnostic {
  reason: string;
  category: "model_unavailable" | "accepted_unknown" | "contract_rejected" | "model_error";
}

// 规则回退的结构化诊断：把桥接错误分类为可诊断事实，绝不让规则候选冒充模型成果。
function ruleFallbackDiagnostic(error: unknown): RuleFallbackDiagnostic {
  if (error instanceof CodexBridgeError) {
    if (error.stage === "not_accepted") {
      return { category: "model_unavailable", reason: error.creatorMessage };
    }
    if (error.stage === "uncertain") {
      return { category: "accepted_unknown", reason: error.creatorMessage };
    }
    if (error.stage === "rejected") {
      return { category: "contract_rejected", reason: error.message };
    }
    return { category: "model_error", reason: error.creatorMessage };
  }
  return {
    category: "model_error",
    reason: error instanceof Error ? error.message : String(error),
  };
}
