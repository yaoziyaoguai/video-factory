import type {
  StudioCandidateInbox,
  StudioCandidateAdoptionInput,
  StudioCandidateInboxItem,
  StudioCandidateInboxQuery,
  StudioCandidateVerification,
  StudioOpportunity,
  StudioOpportunityEvidence,
  StudioOpportunityInput,
  StudioTrendCandidate,
} from "../shared/api.js";
import type { OpportunityStudio } from "./opportunity-studio.js";
import type { SeriesStudio } from "./series-studio.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { classifyTopicCategory, topicFreshness, topicRiskLevel } from "./topic-taxonomy.js";
import { decideEditorialFormat } from "./editorial-decision.js";

export interface CandidateInboxStudioOptions {
  trends: { listCandidates(): Promise<StudioTrendCandidate[]> };
  series: Pick<SeriesStudio, "listCandidates" | "advanceEpisode">;
  opportunities: Pick<OpportunityStudio, "list" | "create">;
  now?: () => Date;
}

const TREND_CANDIDATE_RETENTION_MS = 15 * 60 * 1000;

export class CandidateInboxStudio {
  private readonly now: () => Date;
  private readonly recentTrendCandidates = new Map<string, { candidate: StudioCandidateInboxItem; expiresAt: number }>();

  constructor(private readonly options: CandidateInboxStudioOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(query: StudioCandidateInboxQuery): Promise<StudioCandidateInbox> {
    const includeTrends = !query.origins?.length || query.origins.includes("trend");
    const includeSeries = !query.origins?.length || query.origins.includes("series");
    const [trendCandidates, seriesCandidates, adoptedOpportunities] = await Promise.all([
      includeTrends ? this.options.trends.listCandidates() : Promise.resolve([]),
      includeSeries ? this.options.series.listCandidates() : Promise.resolve([]),
      this.options.opportunities.list(),
    ]);
    const adoptedIds = new Set(adoptedOpportunities.map((item) => item.id));
    const normalizedTrends = trendCandidates.map((candidate) => this.normalizeTrend(candidate));
    this.rememberTrendCandidates(normalizedTrends);
    const available = [
      ...normalizedTrends,
      ...seriesCandidates.map((candidate) => ({
        ...candidate,
        editorialDecision: candidate.editorialDecision ?? decideEditorialFormat(candidate),
      })),
    ].filter((candidate) => !adoptedIds.has(candidate.id));
    const facets = buildFacets(available);
    const filtered = available
      .filter((item) => !query.origins?.length || query.origins.includes(item.origin))
      .filter((item) => !query.categories?.length || query.categories.includes(item.category))
      .filter((item) => !query.platforms?.length || query.platforms.includes(item.platform))
      .filter((item) => !query.verdicts?.length || query.verdicts.includes(item.editorialDecision.verdict))
      .sort((left, right) => right.score.final - left.score.final || left.title.localeCompare(right.title, "zh-CN"));
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 100)));
    return { items: filtered.slice(0, limit), facets, generatedAt: this.now().toISOString() };
  }

  async adopt(candidateId: string, adoptionInput: StudioCandidateAdoptionInput): Promise<StudioOpportunity> {
    const requestedOrigins = [adoptionInput.origin];
    const matches = (await this.list({ origins: requestedOrigins, limit: 200 })).items.filter((item) => item.id === candidateId);
    const rememberedTrend = requestedOrigins.includes("trend") ? this.recentTrendCandidate(candidateId) : undefined;
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
      scores,
      verification: candidate.verification.status === "review_required"
        ? { ...candidate.verification, status: "verified", reasons: ["已由创作者查看原始证据并确认核验。"] }
        : candidate.verification,
      editorialDecision: candidate.editorialDecision,
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

  private normalizeTrend(candidate: StudioTrendCandidate): StudioCandidateInboxItem {
    const collectedAt = candidate.evidence
      .map((item) => item.collectedAt)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    const category = candidate.category ?? classifyTopicCategory(candidate.title, candidate.track);
    const freshness = candidate.freshness ?? topicFreshness(collectedAt, this.now());
    const risk = candidate.risk ?? topicRiskLevel(candidate.title);
    const verification = candidateVerification(risk, candidate.evidence);
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
      editorialDecision: candidate.editorialDecision ?? decideEditorialFormat(normalized),
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

function candidateVerification(
  risk: StudioCandidateInboxItem["risk"],
  evidence: StudioCandidateInboxItem["evidence"],
): StudioCandidateVerification {
  const independentSources = new Set(evidence.map(evidenceIdentity).filter(Boolean)).size;
  const linkedSources = new Set(
    evidence.filter((item) => item.evidenceUrl).map(evidenceIdentity).filter(Boolean),
  ).size;
  if (risk === "high" && (independentSources < 2 || linkedSources < 2)) {
    return {
      status: "blocked",
      independentSources,
      requiredSources: 2,
      reasons: ["高风险热点至少需要 2 个独立来源和可打开的原始链接。"],
    };
  }
  if (risk === "high" || risk === "review") {
    return {
      status: "review_required",
      independentSources,
      requiredSources: risk === "high" ? 2 : 1,
      reasons: ["采用前需要人工查看原始来源，确认标题与开场没有超出证据。"],
    };
  }
  return {
    status: "ready",
    independentSources,
    requiredSources: 1,
    reasons: ["常规风险候选，可进入制作区继续核验。"],
  };
}

function evidenceIdentity(evidence: StudioOpportunityEvidence): string {
  if (evidence.evidenceUrl) {
    try {
      return new URL(evidence.evidenceUrl).hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    } catch {
      // 非标准链接继续使用发布平台，不能退回聚合器名称制造虚假的独立性。
    }
  }
  return evidence.platform.trim().toLowerCase() || evidence.source.trim().toLowerCase();
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
