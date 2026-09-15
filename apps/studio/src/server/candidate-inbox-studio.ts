import type {
  StudioCandidateInbox,
  StudioCandidateAdoptionInput,
  StudioCandidateInboxItem,
  StudioCandidateInboxQuery,
  StudioCandidateSourcesInput,
  StudioCandidateVerification,
  StudioOpportunity,
  StudioOpportunityEvidence,
  StudioOpportunityInput,
  StudioTopicStrategy,
  StudioTrendCandidate,
} from "../shared/api.js";
import { isRoutableSourceHostname, parseStudioCandidateSourcesInput } from "../shared/api.js";
import type { OpportunityStudio } from "./opportunity-studio.js";
import type { SeriesStudio } from "./series-studio.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { classifyTopicCategory, topicFreshness, topicRiskLevel } from "./topic-taxonomy.js";
import { decideEditorialFormat, type EditorialTemplateOption } from "./editorial-decision.js";

export interface CandidateInboxStudioOptions {
  trends: {
    listCandidates(): Promise<StudioTrendCandidate[]>;
    appendCandidateSources?(candidateId: string, evidenceUrls: string[]): Promise<StudioTrendCandidate>;
  };
  series: Pick<SeriesStudio, "listCandidates" | "productionContextFor" | "advanceEpisode" | "appendEpisodeSources">;
  opportunities: Pick<OpportunityStudio, "list" | "create">;
  topicStrategy?: () => Promise<StudioTopicStrategy>;
  publishedTemplates?: () => Promise<readonly EditorialTemplateOption[]>;
  now?: () => Date;
}

const TREND_CANDIDATE_RETENTION_MS = 15 * 60 * 1000;

export class CandidateInboxStudio {
  private readonly now: () => Date;
  private readonly recentTrendCandidates = new Map<string, { candidate: StudioCandidateInboxItem; expiresAt: number }>();
  private readonly candidateMutations = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CandidateInboxStudioOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(query: StudioCandidateInboxQuery): Promise<StudioCandidateInbox> {
    const includeTrends = !query.origins?.length || query.origins.includes("trend");
    const includeSeries = !query.origins?.length || query.origins.includes("series");
    const [trendCandidates, seriesCandidates, adoptedOpportunities, topicStrategy, publishedTemplates] = await Promise.all([
      includeTrends ? this.options.trends.listCandidates() : Promise.resolve([]),
      includeSeries ? this.options.series.listCandidates() : Promise.resolve([]),
      this.options.opportunities.list(),
      includeTrends ? this.options.topicStrategy?.().catch(() => undefined) : Promise.resolve(undefined),
      this.options.publishedTemplates?.() ?? Promise.resolve([]),
    ]);
    const adoptedIds = new Set(adoptedOpportunities.map((item) => item.id));
    const normalizedTrends = trendCandidates.map((candidate) => this.normalizeTrend(candidate, publishedTemplates, topicStrategy?.sourcePolicy));
    this.rememberTrendCandidates(normalizedTrends);
    const available = [
      ...normalizedTrends,
      ...seriesCandidates.map((candidate) => {
        const recommendation = decideEditorialFormat(candidate, publishedTemplates);
        if (candidate.editorialDecision.verdict === "skip" || candidate.seriesSequence?.status === "blocked") {
          return {
            ...candidate,
            editorialDecision: {
              verdict: candidate.editorialDecision.verdict,
              score: candidate.editorialDecision.score,
              reasons: candidate.editorialDecision.reasons,
              guardrails: candidate.editorialDecision.guardrails,
            },
          };
        }
        return {
          ...candidate,
          editorialDecision: recommendation,
        };
      }),
    ].filter((candidate) => !adoptedIds.has(candidate.id));
    const facets = buildFacets(available);
    const filtered = available
      .filter((item) => !query.origins?.length || query.origins.includes(item.origin))
      .filter((item) => !query.categories?.length || query.categories.includes(item.category))
      .filter((item) => !query.platforms?.length || query.platforms.includes(item.platform))
      .filter((item) => !query.verdicts?.length || query.verdicts.includes(item.editorialDecision.verdict))
      .sort((left, right) => Number(isShortlisted(right)) - Number(isShortlisted(left))
        || right.editorialDecision.score - left.editorialDecision.score
        || left.title.localeCompare(right.title, "zh-CN"));
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 100)));
    return { items: filtered.slice(0, limit), facets, generatedAt: this.now().toISOString() };
  }

  // 候选人工补充来源的唯一入口：由 origin 决定写入热点缓存还是系列单集计划。
  // 热点与系列共用同一套“写入→重算门禁与建议→返回最新候选”的链路，不另存派生决策。
  async supplementCandidateSources(candidateId: string, input: StudioCandidateSourcesInput): Promise<StudioCandidateInboxItem> {
    if (input.origin === "series") {
      return this.queueCandidateMutation(candidateId, () => this.supplementSeriesCandidateSourcesUnlocked(candidateId, input));
    }
    return this.queueCandidateMutation(candidateId, () => this.supplementTrendCandidateSourcesUnlocked(candidateId, input));
  }

  // 保留旧入口名，供既有热点补充流程与测试直接调用。
  async supplementTrendCandidateSources(candidateId: string, input: StudioCandidateSourcesInput): Promise<StudioCandidateInboxItem> {
    return this.supplementCandidateSources(candidateId, input);
  }

  private async supplementSeriesCandidateSourcesUnlocked(candidateId: string, input: StudioCandidateSourcesInput): Promise<StudioCandidateInboxItem> {
    // 刻意不读取 trends.appendCandidateSources：相同 candidateId 只能写回自己所属的入口。
    // 这里统一走同一套解析（规范化+可路由校验），保证与 HTTP 入口语义一致。
    const parsed = parseStudioCandidateSourcesInput({ evidenceUrls: input.evidenceUrls });
    const before = (await this.list({ origins: ["series"], limit: 200 })).items
      .find((item) => item.id === candidateId && item.origin === "series");
    if (!before) throw new StudioNotFoundError("这条系列单集候选不存在或已被采用，请刷新候选收件箱。");
    if (!before.seriesId || !before.episodeNumber) {
      throw new StudioConflictError("候选来源与当前创作入口不一致，请刷新后重试。");
    }
    await this.options.series.appendEpisodeSources(before.seriesId, before.episodeNumber, parsed.evidenceUrls);
    // list() 会用最新持久化补充重算 verification 与 decideEditorialFormat，直接取回同一条候选。
    const updated = (await this.list({ origins: ["series"], limit: 200 })).items
      .find((item) => item.id === candidateId && item.origin === "series");
    if (!updated) throw new StudioNotFoundError("这条系列单集候选不存在或已被采用，请刷新候选收件箱。");
    return updated;
  }

  private async supplementTrendCandidateSourcesUnlocked(candidateId: string, input: StudioCandidateSourcesInput): Promise<StudioCandidateInboxItem> {
    const appendCandidateSources = this.options.trends.appendCandidateSources;
    if (!appendCandidateSources) {
      throw new StudioNotFoundError("当前环境没有启用热点候选来源补充。");
    }
    if ((await this.options.opportunities.list()).some((item) => item.id === candidateId)) {
      throw new StudioNotFoundError("这条候选已被采用或已经失效，请刷新候选收件箱。");
    }
    const updated = await appendCandidateSources.call(this.options.trends, candidateId, input.evidenceUrls);
    const [topicStrategy, publishedTemplates] = await Promise.all([
      this.options.topicStrategy?.().catch(() => undefined),
      this.options.publishedTemplates?.() ?? Promise.resolve([]),
    ]);
    const normalized = this.normalizeTrend(updated, publishedTemplates, topicStrategy?.sourcePolicy);
    this.rememberTrendCandidates([normalized]);
    return normalized;
  }

  async adopt(candidateId: string, adoptionInput: StudioCandidateAdoptionInput): Promise<StudioOpportunity> {
    return this.queueCandidateMutation(candidateId, () => this.adoptUnlocked(candidateId, adoptionInput));
  }

  private async adoptUnlocked(candidateId: string, adoptionInput: StudioCandidateAdoptionInput): Promise<StudioOpportunity> {
    const requestedOrigins = [adoptionInput.origin];
    let matches = (await this.list({ origins: requestedOrigins, limit: 200 })).items.filter((item) => item.id === candidateId);
    if (adoptionInput.origin === "series") {
      if (matches.length > 1) throw new StudioConflictError("候选编号同时出现在多个入口，请从原入口重新采用。");
      const beforeReview = matches[0];
      if (!beforeReview) throw new StudioNotFoundError("这条候选已被采用或已经失效，请刷新候选收件箱。");
      if (beforeReview.origin !== "series" || !beforeReview.seriesId || !beforeReview.episodeNumber) {
        throw new StudioConflictError("候选来源与当前创作入口不一致，请刷新后重试。");
      }
      if (beforeReview.seriesSequence?.status === "blocked") {
        throw new StudioConflictError(`请先完成第 ${beforeReview.seriesSequence.blockedByEpisodeNumber} 集，再推进当前单集。`);
      }
      await this.options.series.productionContextFor(beforeReview.seriesId, beforeReview.episodeNumber);
      matches = (await this.list({ origins: requestedOrigins, limit: 200 })).items.filter((item) => item.id === candidateId);
    }
    let rememberedTrend = requestedOrigins.includes("trend") ? this.recentTrendCandidate(candidateId) : undefined;
    if (rememberedTrend && !matches.some((item) => item.origin === "trend")) {
      const [topicStrategy, publishedTemplates] = await Promise.all([
        this.options.topicStrategy?.().catch(() => undefined),
        this.options.publishedTemplates?.() ?? Promise.resolve([]),
      ]);
      const {
        category: _category,
        freshness: _freshness,
        risk: _risk,
        verification: _verification,
        editorialDecision: _editorialDecision,
        ...rememberedCandidate
      } = rememberedTrend;
      rememberedTrend = this.normalizeTrend(rememberedCandidate, publishedTemplates, topicStrategy?.sourcePolicy);
    }
    const candidates = rememberedTrend && !matches.some((item) => item.origin === "trend")
      ? [...matches, rememberedTrend]
      : matches;
    if (candidates.length > 1) throw new StudioConflictError("候选编号同时出现在多个入口，请从原入口重新采用。");
    const candidate = candidates[0];
    if (!candidate) throw new StudioNotFoundError("这条候选已被采用或已经失效，请刷新候选收件箱。");
    if (candidate.origin !== adoptionInput.origin) {
      throw new StudioConflictError("候选来源与当前创作入口不一致，请刷新后重试。");
    }
    if (candidate.verification.status === "blocked") {
      throw new StudioConflictError(candidate.verification.reasons[0] ?? "这条候选尚未达到可采用的证据标准。");
    }
    if (candidate.editorialDecision.verdict === "skip") {
      throw new StudioConflictError(candidate.editorialDecision.reasons[0] ?? "这条候选当前不值得进入生产。");
    }
    if (candidate.seriesSequence?.status === "blocked") {
      throw new StudioConflictError(`请先完成第 ${candidate.seriesSequence.blockedByEpisodeNumber} 集，再推进当前单集。`);
    }
    if (candidate.verification.status === "review_required" && !adoptionInput.verificationConfirmed) {
      throw new StudioConflictError("请先查看原始证据并确认核验，再采用这条候选。");
    }
    const { final: _final, ...scores } = candidate.score;
    const input: StudioOpportunityInput = {
      candidateId: candidate.id,
      origin: candidate.origin,
      category: candidate.category,
      title: candidate.title,
      platform: candidate.platform,
      track: candidate.track,
      audience: candidate.audience,
      painPoint: candidate.painPoint,
      hook: candidate.hook,
      evidence: candidate.evidence,
      ...(candidate.articleSources?.length ? { articleSources: structuredClone(candidate.articleSources) } : {}),
      ...(candidate.articleFacts?.length ? { articleFacts: structuredClone(candidate.articleFacts) } : {}),
      ...(candidate.articleUncertainties?.length ? { articleUncertainties: [...candidate.articleUncertainties] } : {}),
      scores,
      verification: candidate.verification.status === "review_required"
        ? { ...candidate.verification, status: "verified", reasons: ["已由创作者查看原始证据并确认核验。"] }
        : candidate.verification,
      editorialDecision: candidate.editorialDecision,
      ...(candidate.visualProof ? { visualProof: candidate.visualProof } : {}),
      ...(candidate.visualPlan ? { visualPlan: candidate.visualPlan } : {}),
      ...(candidate.seriesId ? { seriesId: candidate.seriesId } : {}),
      ...(candidate.seriesName ? { seriesName: candidate.seriesName } : {}),
      ...(candidate.episodeNumber ? { episodeNumber: candidate.episodeNumber } : {}),
    };
    if (candidate.origin === "series" && candidate.seriesId && candidate.episodeNumber) {
      await this.options.series.advanceEpisode(candidate.seriesId, candidate.episodeNumber);
    }
    const existing = (await this.options.opportunities.list()).find((item) => item.id === candidate.id);
    if (existing && existing.origin !== candidate.origin) {
      throw new StudioConflictError("候选编号已被另一个创作入口使用，请刷新后重新选择。");
    }
    const opportunity = existing ?? await this.options.opportunities.create(input);
    this.recentTrendCandidates.delete(candidateId);
    return opportunity;
  }

  private queueCandidateMutation<T>(candidateId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.candidateMutations.get(candidateId) ?? Promise.resolve();
    const queued = previous.then(operation, operation);
    this.candidateMutations.set(candidateId, queued);
    return queued.finally(() => {
      if (this.candidateMutations.get(candidateId) === queued) this.candidateMutations.delete(candidateId);
    });
  }

  private normalizeTrend(
    candidate: StudioTrendCandidate,
    publishedTemplates: readonly EditorialTemplateOption[],
    sourcePolicy?: StudioTopicStrategy["sourcePolicy"],
  ): StudioCandidateInboxItem {
    const collectedAt = latestOriginalEvidenceTime(candidate.evidence);
    // category 是派生值：缓存里的旧分类可能是过时 taxonomy 的产物，读取时用当前规则重算。
    const category = classifyTopicCategory(
      candidate.title,
      candidate.track,
      candidate.evidence.map((item) => item.keyword),
    );
    const freshness = candidate.freshness ?? topicFreshness(collectedAt, this.now());
    const risk = candidate.risk ?? topicRiskLevel(candidate.title);
    const verification = candidateVerification(risk, candidate.evidence, sourcePolicy);
    const normalized = {
      ...candidate,
      origin: "trend" as const,
      category,
      freshness,
      risk,
      verification,
    };
    return {
      ...normalized,
      editorialDecision: decideEditorialFormat(normalized, publishedTemplates),
    };
  }

  private rememberTrendCandidates(candidates: StudioCandidateInboxItem[]): void {
    const now = this.now().getTime();
    for (const [id, entry] of this.recentTrendCandidates) {
      if (entry.expiresAt <= now) this.recentTrendCandidates.delete(id);
    }
    for (const candidate of candidates) {
      this.recentTrendCandidates.set(candidate.id, {
        candidate: structuredClone(candidate),
        expiresAt: now + TREND_CANDIDATE_RETENTION_MS,
      });
    }
  }

  private recentTrendCandidate(candidateId: string): StudioCandidateInboxItem | undefined {
    const entry = this.recentTrendCandidates.get(candidateId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now().getTime()) {
      this.recentTrendCandidates.delete(candidateId);
      return undefined;
    }
    return structuredClone(entry.candidate);
  }
}

export function candidateVerification(
  risk: StudioCandidateInboxItem["risk"],
  evidence: StudioCandidateInboxItem["evidence"],
  sourcePolicy?: StudioTopicStrategy["sourcePolicy"],
): StudioCandidateVerification {
  const effectiveSourcePolicy = sourcePolicy ?? "primary_or_two_independent";
  const policyRequiredSources = effectiveSourcePolicy === "primary_or_two_independent" ? 2 : 1;
  const independentSources = new Set(evidence.map(traceableEvidenceIdentity).filter(Boolean)).size;
  const linkedSources = independentSources;
  if (effectiveSourcePolicy === "primary_or_two_independent" && (independentSources < 2 || linkedSources < 2)) {
    return {
      status: "blocked",
      independentSources,
      requiredSources: 2,
      reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接，补齐前不会进入制作推荐。"],
    };
  }
  if (effectiveSourcePolicy === "traceable_source" && linkedSources < 1) {
    return {
      status: "blocked",
      independentSources,
      requiredSources: 1,
      reasons: ["当前总编规则要求至少 1 个格式有效的原始来源链接，补齐前不会进入制作推荐。"],
    };
  }
  if (risk === "high" && (independentSources < 2 || linkedSources < 2)) {
    return {
      status: "blocked",
      independentSources,
      requiredSources: 2,
      reasons: ["高风险热点至少需要 2 个不同域名的有效原始来源链接。"],
    };
  }
  if (risk === "high" || risk === "review") {
    return {
      status: "review_required",
      independentSources,
      requiredSources: Math.max(policyRequiredSources, risk === "high" ? 2 : 1),
      reasons: ["采用前需要人工查看原始来源，确认标题与开场没有超出证据。"],
    };
  }
  return {
    status: "ready",
    independentSources,
    requiredSources: policyRequiredSources,
    reasons: ["常规风险候选，可进入制作区继续核验。"],
  };
}

export function reviewTrendOpportunityAgainstCurrentPolicy(
  opportunity: StudioOpportunity,
  sourcePolicy?: StudioTopicStrategy["sourcePolicy"],
  publishedTemplates: readonly EditorialTemplateOption[] = [],
  now = new Date(),
): StudioOpportunity {
  if (opportunity.origin !== "trend") return opportunity;
  const collectedAt = latestOriginalEvidenceTime(opportunity.evidence);
  const risk = topicRiskLevel(opportunity.title);
  const currentVerification = candidateVerification(risk, opportunity.evidence, sourcePolicy);
  const verification = currentVerification.status === "review_required" && opportunity.verification?.status === "verified"
    ? { ...currentVerification, status: "verified" as const, reasons: opportunity.verification.reasons }
    : currentVerification;
  const category = classifyTopicCategory(
    opportunity.title,
    opportunity.track,
    opportunity.evidence.map((item) => item.keyword),
  );
  return {
    ...opportunity,
    category,
    verification,
    editorialDecision: decideEditorialFormat({
      origin: "trend",
      title: opportunity.title,
      track: opportunity.track,
      category,
      freshness: topicFreshness(collectedAt, now),
      risk,
      verification,
      score: opportunity.score,
      audience: opportunity.audience,
      painPoint: opportunity.painPoint,
      hook: opportunity.hook,
      evidence: opportunity.evidence,
    }, publishedTemplates),
  };
}

function isShortlisted(item: StudioCandidateInboxItem): boolean {
  return item.editorialDecision.verdict !== "skip"
    && item.verification.status !== "blocked"
    && item.seriesSequence?.status !== "blocked";
}

export function traceableEvidenceIdentity(evidence: StudioOpportunityEvidence): string {
  if (!evidence.evidenceUrl) return "";
  try {
    const url = new URL(evidence.evidenceUrl);
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    if (!isRoutableSourceHostname(hostname)) return "";
    const searchPage = hostname === "s.weibo.com"
      || (hostname === "baidu.com" && url.pathname === "/s")
      || hostname === "search.bilibili.com"
      || (hostname === "kuaishou.com" && url.pathname.startsWith("/search/"))
      || hostname === "so.toutiao.com"
      || (hostname === "douyin.com" && url.pathname.startsWith("/search"))
      || (hostname === "zhihu.com" && url.pathname.startsWith("/search"))
      || (hostname === "xiaohongshu.com" && url.pathname.startsWith("/search_result"));
    if (searchPage) return "";
    return hostname;
  } catch {
    return "";
  }
}

function latestOriginalEvidenceTime(evidence: StudioOpportunityEvidence[]): string | undefined {
  return evidence
    .filter((item) => item.source !== "manual-supplement" && item.platform !== "manual")
    .map((item) => item.collectedAt)
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function buildFacets(items: StudioCandidateInboxItem[]): StudioCandidateInbox["facets"] {
  const facets: StudioCandidateInbox["facets"] = { total: items.length, origins: {}, categories: {}, platforms: {}, verdicts: {} };
  for (const item of items) {
    facets.origins[item.origin] = (facets.origins[item.origin] ?? 0) + 1;
    facets.categories[item.category] = (facets.categories[item.category] ?? 0) + 1;
    facets.platforms[item.platform] = (facets.platforms[item.platform] ?? 0) + 1;
    facets.verdicts[item.editorialDecision.verdict] = (facets.verdicts[item.editorialDecision.verdict] ?? 0) + 1;
  }
  return facets;
}
