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
} from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import { classifyTopicCategory, topicRiskLevel } from "./topic-taxonomy.js";

const TOPIC_EDITOR_AGENT_CONTRACT_VERSION = "topic-editor-v3|role-audit-v1|topic-ideas-validator-v1|complete-role-scope-v1";

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
  visualFeasibility?: number;
  productionCostEfficiency?: number;
  novelty: number;
  seriesPotential: number;
  monetization: number;
}

export interface TrendIdeaModel {
  id: string;
  generate(signals: StudioTrendSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]>;
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
    const primarySignals = signalGroups.map((group) => group[0]!);
    if (this.options.model) {
      try {
        const ideas = await generateModelIdeas(this.options.model, primarySignals, strategy);
        const modelCandidates = new Map<string, StudioTrendCandidate>();
        for (const idea of ideas) {
          const group = signalGroups.find((items) => items[0]?.id === idea.signalId);
          if (group && !modelCandidates.has(idea.signalId)) {
            modelCandidates.set(idea.signalId, this.fromModelIdea(idea, group));
          }
        }
        if (modelCandidates.size > 0) {
          const selectedByModel = [...modelCandidates.values()].sort(byFinalScore).slice(0, 8);
          // 模型给出的数量就是总编愿意负责的短名单；规则候选不能为了凑数混进推荐。
          return selectCandidatePortfolio(selectedByModel, [], TREND_CANDIDATE_LIMIT);
        }
      } catch {
        // 模型是增强节点；不可用时仍需稳定输出可追溯的规则候选。
      }
    }
    return selectCandidatePortfolio(
      [],
      signalGroups.map((group) => this.fromSignal(group, strategy))
        .sort((left, right) => byStrategyThenFinal(left, right, strategy)),
      TREND_CANDIDATE_LIMIT,
    );
  }

  private fromModelIdea(idea: TrendModelIdea, signals: StudioTrendSignal[]): StudioTrendCandidate {
    const signal = signals[0]!;
    const grounded = groundModelIdea(idea, signal);
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
      rationale: grounded.visualProof
        ? `${grounded.rationale} 可见画面：${grounded.visualProof}`
        : grounded.rationale,
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
      rationale: clean(input.rationale, "来自本地热点网关的可追溯候选。"),
      providerId: input.providerId,
      generatedAt: this.now().toISOString(),
      evidence: candidate.evidence,
      score: candidate.score,
      category: classifyTopicCategory(title, input.track),
      visualPlan: planVisualDirection({ title, hook }),
    };
  }
}

async function generateModelIdeas(model: TrendIdeaModel, signals: StudioTrendSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]> {
  try {
    const ideas = await model.generate(signals.slice(0, 24), strategy);
    return ideas.length > 0 ? ideas : model.generate(signals.slice(0, 12), strategy);
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

  async generate(signals: StudioTrendSignal[], strategy?: StudioTopicStrategy): Promise<TrendModelIdea[]> {
    const request = {
      signals: signals.map((item) => ({
        id: item.id,
        platform: item.platform,
        rank: item.rank,
        title: item.title,
        heat: item.heat ?? null,
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
            owns: ["ideas.signalId", "ideas.track", "ideas.title", "ideas.audience", "ideas.painPoint", "ideas.hook", "ideas.rationale", "ideas.visualProof", "ideas scores"],
            doesNotOwn: ["热点原始事实", "新闻核验结果", "脚本与成片"],
          },
          upstreamFacts: request,
          currentRoleContract: { maxIdeas: 8, everyIdeaMustReferenceOneSignal: true, everyIdeaMustExplainVisibleEvidence: true, scoresAreIntegersFromZeroToOneHundred: true },
          downstreamBoundary: "只提出可生产的原创角度；不得补写热点中不存在的事实，也不得要求脚本或成片已经生成。",
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
      ? "来源标准：至少保留一个格式有效的原始来源链接；高风险事实仍需额外核验。"
      : "来源标准：至少需要两个不同域名的有效原始来源链接才进入制作推荐。",
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
  if (!Array.isArray(ideas) || ideas.length < 1 || ideas.length > 8) throw new Error("Topic ideas output must contain 1 to 8 ideas.");
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

function clean(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 180);
  return normalized || fallback;
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

function groundModelIdea(idea: TrendModelIdea, signal: StudioTrendSignal): TrendModelIdea {
  const sourceNumbers = new Set(numberTokens(signal.title));
  const riskLevel = topicRiskLevel(signal.title);
  const sensitive = riskLevel !== "low";
  const titleUnsafe = unsupportedClaim(idea.title, signal.title, sourceNumbers);
  const bodyUnsafe = sensitive || [idea.audience, idea.painPoint, idea.hook, idea.rationale, idea.visualProof ?? ""]
    .some((value) => unsupportedClaim(value, signal.title, sourceNumbers));
  const title = sensitive || titleUnsafe || !isEditoriallyDistinct(idea.title, signal.title)
    ? groundedEditorialTitle(signal.title, idea.track)
    : clean(idea.title, signal.title);
  return {
    ...idea,
    track: normalizeTrack(idea.track, signal.title),
    title,
    audience: bodyUnsafe ? "关注这一热点与日常生活关系的中文短视频用户" : idea.audience,
    painPoint: bodyUnsafe ? "热点结论很多，但缺少只基于现有证据的解释" : idea.painPoint,
    hook: bodyUnsafe
      ? `${signal.title}正在上榜。先不猜结论，只看哪些问题能够被证据支持？`
      : clean(idea.hook, `先核验“${signal.title}”中真正影响普通人的部分。`),
    rationale: sensitive
      ? riskLevel === "high"
        ? `该热点涉及高风险公共事件；系统未采用模型扩写，只保留基于原始信号的核验问题。`
        : `该热点涉及需要核验的公共议题；系统未采用模型扩写，只保留基于原始信号的核验问题。`
      : bodyUnsafe || titleUnsafe
      ? `模型提出“${title}”角度；系统已移除原始信号不支持的数字、引语或采访假设，进入选题池前仍需人工核验。`
      : `模型提出“${title}”角度；系统仅保留原始榜单能够支持的 hook，进入选题池前仍需人工核验。`,
    visualProof: bodyUnsafe ? "" : clean(idea.visualProof ?? "", ""),
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
  const unsupportedQuote = /[“”"']/.test(value) && !/[“”"']/.test(sourceTitle);
  const sourceTerms = new Set(latinTokens(sourceTitle));
  const unsupportedLatinTerm = latinTokens(value).some((token) => !sourceTerms.has(token));
  const unsupportedClickbait = /内幕|秘密|曝光|真相|首次披露/.test(value) && !/内幕|秘密|曝光|真相|首次披露/.test(sourceTitle);
  return unsupportedNumber || unsupportedAttribution || unsupportedQuote || unsupportedLatinTerm || unsupportedClickbait;
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
