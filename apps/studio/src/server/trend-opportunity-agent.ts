import { createHash } from "node:crypto";
import { scoreTopicCandidate } from "@video-factory/workflow-core";
import type {
  StudioTrendCandidate,
  StudioTrendSignal,
  StudioTrendSignalQuery,
  StudioTopicCategory,
} from "../shared/api.js";
import { planVisualDirection } from "../shared/visual-plan.js";
import { classifyTopicCategory, topicRiskLevel } from "./topic-taxonomy.js";

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
  novelty: number;
  seriesPotential: number;
  monetization: number;
}

export interface TrendIdeaModel {
  id: string;
  generate(signals: StudioTrendSignal[]): Promise<TrendModelIdea[]>;
}

export interface TrendOpportunityAgentOptions {
  signals: TrendSignalPort;
  model?: TrendIdeaModel;
  now?: () => Date;
}

const TREND_CANDIDATE_LIMIT = 60;

export class TrendOpportunityAgent {
  private readonly now: () => Date;

  constructor(private readonly options: TrendOpportunityAgentOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async listCandidates(): Promise<StudioTrendCandidate[]> {
    const signals = await this.options.signals.listSignals({ limit: 160 });
    const signalGroups = groupEquivalentSignals(signals);
    const primarySignals = signalGroups.map((group) => group[0]!);
    if (this.options.model) {
      try {
        const ideas = await generateModelIdeas(this.options.model, primarySignals);
        const modelCandidates = new Map<string, StudioTrendCandidate>();
        for (const idea of ideas) {
          const group = signalGroups.find((items) => items[0]?.id === idea.signalId);
          if (group && !modelCandidates.has(idea.signalId)) {
            modelCandidates.set(idea.signalId, this.fromModelIdea(idea, group));
          }
        }
        if (modelCandidates.size > 0) {
          const selectedByModel = [...modelCandidates.values()].sort(byFinalScore).slice(0, 8);
          const selectedSignalIds = new Set(modelCandidates.keys());
          const ruleCandidates = signalGroups
            .filter((group) => !selectedSignalIds.has(group[0]!.id))
            .map((group) => this.fromSignal(group))
            .sort(byFinalScore);
          return selectCandidatePortfolio(selectedByModel, ruleCandidates, TREND_CANDIDATE_LIMIT);
        }
      } catch {
        // 本地模型是增强节点；不可用时仍需稳定输出可追溯的规则候选。
      }
    }
    return selectCandidatePortfolio([], signalGroups.map((group) => this.fromSignal(group)).sort(byFinalScore), TREND_CANDIDATE_LIMIT);
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
      rationale: grounded.rationale,
      providerId: this.options.model!.id,
      novelty: allZero ? 64 : scores[0]!,
      seriesPotential: allZero ? 72 : scores[1]!,
      monetization: allZero ? 52 : scores[2]!,
    });
  }

  private fromSignal(signals: StudioTrendSignal[]): StudioTrendCandidate {
    const signal = signals[0]!;
    const risk = complianceRisk(signal.title);
    const track = inferTrack(signal.title);
    return this.buildCandidate({
      signal,
      relatedSignals: signals,
      title: risk >= 60 ? groundedEditorialTitle(signal.title, track) : signal.title,
      track,
      audience: audienceFor(track),
      painPoint: `热点信息很多，但缺少一个与普通人直接相关的解释角度`,
      hook: risk >= 60
        ? `${signal.title}正在上榜。先不猜结论，只核验可靠来源已经确认的信息。`
        : `“${signal.title}”正在上升，但真正值得讲的是它与你有什么关系。`,
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
      visualFeasibility: risk >= 60 ? 52 : 82,
      productionCostEfficiency: risk >= 60 ? 58 : 88,
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

async function generateModelIdeas(model: TrendIdeaModel, signals: StudioTrendSignal[]): Promise<TrendModelIdea[]> {
  try {
    const ideas = await model.generate(signals.slice(0, 24));
    return ideas.length > 0 ? ideas : model.generate(signals.slice(0, 12));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return model.generate(signals.slice(0, 12));
  }
}

export interface OllamaTrendIdeaModelOptions {
  endpoint?: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class OllamaTrendIdeaModel implements TrendIdeaModel {
  readonly id: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaTrendIdeaModelOptions = {}) {
    this.id = options.model ?? "qwen3:4b";
    this.endpoint = (options.endpoint ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async generate(signals: StudioTrendSignal[]): Promise<TrendModelIdea[]> {
    const response = await this.fetcher(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.id,
        stream: false,
        think: false,
        format: ideaSchema,
        options: { temperature: 0.35, top_p: 0.85, num_predict: 1600 },
        messages: [
          { role: "system", content: "你是严谨的中文短视频选题总编。只输出符合 JSON Schema 的内容。不得编造原始热点中不存在的引语、人物表态、百分比、因果或采访素材；证据不足就使用问题句或观察角度。避免把灾害、伤亡、政治突发娱乐化。优先选择能长期连载、免费素材可覆盖、对普通人有具体价值的角度。" },
          { role: "user", content: `从以下实时热点中提出最多 8 个原创短视频角度。signalId 必须原样引用；track 必须是小写英文 slug，例如 sports-context；title 必须是编辑命题，不能原样复述热搜；hook 要在 2 秒内建立冲突，但只能使用输入中可验证的信息，不得假装有采访或独家画面。novelty、seriesPotential、monetization 必须填写 0-100 的整数。\n${JSON.stringify(signals.map((item) => ({ id: item.id, platform: item.platform, rank: item.rank, title: item.title, heat: item.heat ?? null })))}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const body = await response.json() as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? "{}") as { ideas?: unknown[] };
    return (parsed.ideas ?? []).flatMap(parseModelIdea);
  }
}

const ideaSchema = {
  type: "object",
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["signalId", "title", "track", "audience", "painPoint", "hook", "rationale", "novelty", "seriesPotential", "monetization"],
        properties: {
          signalId: { type: "string" }, title: { type: "string" }, track: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
          audience: { type: "string" }, painPoint: { type: "string" }, hook: { type: "string" }, rationale: { type: "string" },
          novelty: { type: "number", minimum: 0, maximum: 100 },
          seriesPotential: { type: "number", minimum: 0, maximum: 100 },
          monetization: { type: "number", minimum: 0, maximum: 100 },
        },
      },
    },
  },
} as const;

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
  const bodyUnsafe = sensitive || [idea.audience, idea.painPoint, idea.hook, idea.rationale]
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
      ? `${signal.title}正在上榜。先不猜结论，只看哪些问题能够被证据支持。`
      : clean(idea.hook, `先核验“${signal.title}”中真正影响普通人的部分。`),
    rationale: sensitive
      ? riskLevel === "high"
        ? `该热点涉及高风险公共事件；系统未采用模型扩写，只保留基于原始信号的核验问题。`
        : `该热点涉及需要核验的公共议题；系统未采用模型扩写，只保留基于原始信号的核验问题。`
      : bodyUnsafe || titleUnsafe
      ? `模型提出“${title}”角度；系统已移除原始信号不支持的数字、引语或采访假设，进入选题池前仍需人工核验。`
      : `模型提出“${title}”角度；系统仅保留原始榜单能够支持的 hook，进入选题池前仍需人工核验。`,
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
  for (const candidate of remaining) {
    const category = candidate.category ?? "lifestyle";
    if (selected.length >= limit) break;
    if ((categoryCounts.get(category) ?? 0) >= 10 || (platformCounts.get(candidate.platform) ?? 0) >= 5) continue;
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
