import { AlertCircle, ArrowLeft, CheckCircle2, RadioTower, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type {
  StudioCandidateInbox,
  StudioCandidateInboxItem,
  StudioCreatorSettings,
  StudioOpportunity,
  StudioOpportunityInput,
  StudioProductionInput,
  StudioProvider,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesInput,
  StudioSeriesEpisodePlanInput,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { DirectorPanel } from "../components/DirectorPanel.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { OpportunityDialog } from "../components/OpportunityDialog.js";
import { OpportunityFocus } from "../components/OpportunityFocus.js";
import { OpportunityRail } from "../components/OpportunityRail.js";
import { ProductionStrip } from "../components/ProductionStrip.js";
import { SeriesDialog } from "../components/SeriesDialog.js";
import { TopicEntryWorkspace } from "../components/TopicEntryWorkspace.js";

export function TodayPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedMode = searchParams.get("mode");
  const entryMode = requestedMode === "series" ? "series" : requestedMode === "manual" || requestedMode === "custom" ? "custom" : "trend";
  const initialCandidateId = searchParams.get("candidate") ?? undefined;
  const [opportunities, setOpportunities] = useState<StudioOpportunity[]>([]);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [creatorSettings, setCreatorSettings] = useState<StudioCreatorSettings>();
  const [trendInbox, setTrendInbox] = useState<StudioCandidateInbox>();
  const [seriesInbox, setSeriesInbox] = useState<StudioCandidateInbox>();
  const [series, setSeries] = useState<StudioSeries[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [opportunityDialogOpen, setOpportunityDialogOpen] = useState(false);
  const [opportunityDialogMode, setOpportunityDialogMode] = useState<"manual" | "json">("manual");
  const [seriesDialogOpen, setSeriesDialogOpen] = useState(false);
  const [productionDialogOpen, setProductionDialogOpen] = useState(false);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(true);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [opportunitiesError, setOpportunitiesError] = useState<string>();
  const [providersError, setProvidersError] = useState<string>();
  const [runsError, setRunsError] = useState<string>();
  const [trendError, setTrendError] = useState<string>();
  const [seriesError, setSeriesError] = useState<string>();
  const [candidateActionError, setCandidateActionError] = useState<string>();
  const [adoptingCandidateId, setAdoptingCandidateId] = useState<string>();
  const [nextStepNotice, setNextStepNotice] = useState<string>();
  const [trendRefreshFinishedAt, setTrendRefreshFinishedAt] = useState<string>();
  const adoptedSectionRef = useRef<HTMLElement>(null);
  const trendLoadingRef = useRef(false);
  const trendRefreshPollRef = useRef<number | undefined>(undefined);

  const updateTrendInbox = useCallback((next: StudioCandidateInbox) => {
    const scoped = onlyOrigin(next, "trend");
    setTrendInbox(scoped);
    return scoped;
  }, []);

  const scheduleTrendRefreshPoll = useCallback((refreshId: string) => {
    if (trendRefreshPollRef.current !== undefined) window.clearTimeout(trendRefreshPollRef.current);
    const poll = async (attempt: number, consecutiveFailures = 0) => {
      let nextFailures = 0;
      try {
        const status = await studioApi.trendCandidateRefreshStatus(refreshId);
        if (status.state === "succeeded") {
          const refreshedInbox = updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
          setTrendRefreshFinishedAt(status.finishedAt ?? new Date().toISOString());
          const collectedCount = status.candidateCount ?? refreshedInbox.items.length;
          const decidedCount = Math.max(0, collectedCount - refreshedInbox.items.length);
          setNextStepNotice(decidedCount > 0
            ? `本次采集 ${collectedCount} 条，其中 ${decidedCount} 条已进入制作区；当前有 ${refreshedInbox.items.length} 条待判断。`
            : `热点候选已更新完成，当前有 ${refreshedInbox.items.length} 条待判断。`);
          return;
        }
        if (status.state === "failed") {
          setNextStepNotice(status.error ?? "热点更新失败，请稍后手动重试。");
          return;
        }
      } catch {
        nextFailures = consecutiveFailures + 1;
        if (nextFailures >= 3) {
          setNextStepNotice("暂时无法确认热点更新状态，当前缓存仍可使用；请稍后再试。");
          return;
        }
      }
      if (attempt >= 39) {
        setNextStepNotice("热点更新仍未完成，当前缓存可以继续使用；稍后可再次查看或手动刷新。");
        return;
      }
      trendRefreshPollRef.current = window.setTimeout(() => void poll(attempt + 1, nextFailures), trendRefreshPollDelay(attempt));
    };
    trendRefreshPollRef.current = window.setTimeout(() => void poll(0), trendRefreshPollDelay(0));
  }, [updateTrendInbox]);

  useEffect(() => () => {
    if (trendRefreshPollRef.current !== undefined) window.clearTimeout(trendRefreshPollRef.current);
  }, []);

  const loadTrendInbox = useCallback(async (forceRefresh = false) => {
    if (trendLoadingRef.current) return;
    trendLoadingRef.current = true;
    setTrendLoading(true);
    setTrendError(undefined);
    try {
      if (forceRefresh) {
        const receipt = await studioApi.refreshTrendCandidates();
        setNextStepNotice(receipt.status === "already_running"
          ? "热点后台更新已在进行，当前缓存仍可继续选择。"
          : "热点后台更新已开始，当前缓存仍可继续选择。");
        scheduleTrendRefreshPoll(receipt.refreshId);
      }
      updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
    } catch (caught) {
      setTrendError(errorMessage(caught));
    } finally {
      trendLoadingRef.current = false;
      setTrendLoading(false);
    }
  }, [scheduleTrendRefreshPoll, updateTrendInbox]);

  const loadSeriesWorkspace = useCallback(async () => {
    setSeriesLoading(true);
    setSeriesError(undefined);
    const [seriesResult, inboxResult] = await Promise.allSettled([
      studioApi.series(),
      studioApi.candidateInbox({ origins: ["series"], limit: 100 }),
    ]);
    if (seriesResult.status === "fulfilled") setSeries(seriesResult.value);
    else setSeriesError(`系列读取失败：${errorMessage(seriesResult.reason)}`);
    if (inboxResult.status === "fulfilled") setSeriesInbox(onlyOrigin(inboxResult.value, "series"));
    else setSeriesError(`系列候选读取失败：${errorMessage(inboxResult.reason)}`);
    setSeriesLoading(false);
  }, []);

  const loadSeriesCandidates = useCallback(async () => {
    setSeriesLoading(true);
    setSeriesError(undefined);
    try {
      setSeriesInbox(onlyOrigin(await studioApi.candidateInbox({ origins: ["series"], limit: 100 }), "series"));
    } catch (caught) {
      setSeriesError(`系列候选读取失败：${errorMessage(caught)}`);
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    const origin = entryMode === "custom" ? "manual" : entryMode;
    setOpportunitiesLoading(true);
    setProvidersLoading(true);
    setRunsLoading(true);
    setOpportunitiesError(undefined);
    setProvidersError(undefined);
    setRunsError(undefined);
    await Promise.all([
      studioApi.opportunities(origin).then((nextOpportunities) => {
        setOpportunities(nextOpportunities);
        setSelectedId((current) => current && nextOpportunities.some((item) => item.id === current) ? current : nextOpportunities[0]?.id);
      }).catch((caught: unknown) => setOpportunitiesError(errorMessage(caught))).finally(() => setOpportunitiesLoading(false)),
      studioApi.providers().then(setProviders).catch((caught: unknown) => setProvidersError(errorMessage(caught))).finally(() => setProvidersLoading(false)),
      studioApi.runs(entryMode === "series" ? undefined : origin).then(setRuns).catch((caught: unknown) => setRunsError(errorMessage(caught))).finally(() => setRunsLoading(false)),
      studioApi.settings().then(setCreatorSettings).catch(() => undefined),
    ]);
  }, [entryMode]);

  useEffect(() => {
    void load();
    if (entryMode === "trend") void loadTrendInbox();
    if (entryMode === "series") void loadSeriesWorkspace();
  }, [entryMode, load, loadSeriesWorkspace, loadTrendInbox]);
  const inbox = entryMode === "trend" ? trendInbox : entryMode === "series" ? seriesInbox : undefined;
  const trendMeta = useMemo(() => ({ ...buildTrendMeta(trendInbox), ...(trendRefreshFinishedAt ? { refreshedAt: trendRefreshFinishedAt } : {}) }), [trendInbox, trendRefreshFinishedAt]);
  const initialSeriesId = initialCandidateId
    ? seriesInbox?.items.find((item) => item.id === initialCandidateId)?.seriesId
    : undefined;
  const selectedSeriesId = series.some((item) => item.id === activeSeriesId)
    ? activeSeriesId
    : series.some((item) => item.id === initialSeriesId)
      ? initialSeriesId
      : series[0]?.id;
  const visibleOpportunities = useMemo(
    () => opportunities.filter((item) => matchesEntryOrigin(entryMode, item.origin)
      && isPendingProduction(item, entryMode, series, selectedSeriesId, runs)),
    [entryMode, opportunities, runs, selectedSeriesId, series],
  );
  const visibleRuns = useMemo(
    () => runs.filter((run) => matchesEntryOrigin(entryMode, run.creationOrigin)
      && (entryMode !== "series" || !selectedSeriesId || run.seriesId === selectedSeriesId)),
    [entryMode, runs, selectedSeriesId],
  );
  const selected = useMemo(
    () => visibleOpportunities.find((item) => item.id === selectedId) ?? visibleOpportunities[0],
    [selectedId, visibleOpportunities],
  );
  const selectedSeriesContext = useMemo(() => {
    if (!selected?.seriesId || !selected.episodeNumber) return undefined;
    const selectedSeries = series.find((item) => item.id === selected.seriesId);
    if (!selectedSeries) return undefined;
    const episode = selectedSeries.episodes.find((item) => item.episodeNumber === selected.episodeNumber);
    if (!episode) return undefined;
    return {
      seriesId: selectedSeries.id,
      episodeId: episode.id,
      seriesName: selectedSeries.name,
      seriesRevision: selectedSeries.revision,
      episodeNumber: episode.episodeNumber,
      seasonNumber: episode.seasonNumber,
      canonBaseRevision: episode.canonBaseRevision,
      premise: selectedSeries.premise,
      audience: selectedSeries.audience,
      platform: selectedSeries.platform,
      track: selectedSeries.track,
      arc: episode.arc,
      episode: {
        updatedAt: episode.updatedAt,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        planning: episode.planning,
      },
      bible: selectedSeries.bible,
      canon: selectedSeries.canon,
      continuity: episode.continuity,
    };
  }, [selected, series]);
  const visibleCandidateCount = entryMode === "series" && selectedSeriesId
    ? (inbox?.items.filter((item) => item.seriesId === selectedSeriesId).length ?? 0)
    : (inbox?.facets.total ?? 0);
  const dailyStatus = `${visibleCandidateCount} 条候选 · ${visibleOpportunities.length} 条制作机会 · ${visibleRuns.filter((run) => run.status === "succeeded").length} 条已完成`;
  const seriesAuditReady = providersLoading
    ? undefined
    : !providersError && providers.some((provider) => provider.capability === "series.plan" && provider.available && provider.kind !== "test");

  useEffect(() => {
    setSelectedId((current) => current && visibleOpportunities.some((item) => item.id === current)
      ? current
      : visibleOpportunities[0]?.id);
  }, [visibleOpportunities]);

  async function createOpportunity(input: StudioOpportunityInput) {
    const created = await studioApi.createOpportunity({ ...input, origin: input.origin ?? "manual" });
    setOpportunities((current) => [created, ...current]);
    setSelectedId(created.id);
    setOpportunityDialogOpen(false);
  }

  async function adoptCandidate(candidate: StudioCandidateInboxItem, verificationConfirmed = false) {
    setAdoptingCandidateId(candidate.id);
    setCandidateActionError(undefined);
    try {
      const adopted = await studioApi.adoptCandidate(candidate.id, {
        origin: candidate.origin,
        ...(verificationConfirmed ? { verificationConfirmed: true } : {}),
      });
      setOpportunities((current) => [adopted, ...current.filter((item) => item.id !== adopted.id)]);
      setSelectedId(adopted.id);
      const updateInbox = (current: StudioCandidateInbox | undefined) => current ? {
        ...current,
        items: current.items.filter((item) => item.id !== candidate.id),
        facets: { ...current.facets, total: Math.max(0, current.facets.total - 1) },
      } : current;
      if (candidate.origin === "trend") setTrendInbox(updateInbox);
      else setSeriesInbox(updateInbox);
      setNextStepNotice("已采用。下一步：检查证据与镜头计划，再开始制作。");
      window.requestAnimationFrame(() => {
        adoptedSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        adoptedSectionRef.current?.focus({ preventScroll: true });
      });
      if (candidate.origin === "series") await loadSeriesWorkspace();
    } catch (caught) {
      setCandidateActionError(`采用候选失败：${errorMessage(caught)}`);
    } finally {
      setAdoptingCandidateId(undefined);
    }
  }

  async function createSeries(input: StudioSeriesInput) {
    const created = await studioApi.createSeries(input);
    setSeries((current) => [created, ...current]);
    setSeriesDialogOpen(false);
    await loadSeriesCandidates();
  }

  async function updateSeriesEpisode(seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput) {
    setCandidateActionError(undefined);
    try {
      const updated = await studioApi.updateSeriesEpisodePlan(seriesId, episodeNumber, input);
      setSeries((current) => current.map((item) => item.id === updated.id ? updated : item));
      await loadSeriesCandidates();
      setNextStepNotice(`第 ${episodeNumber} 集路线图已保存为人工版本，后续角色会基于这个版本重新审计。`);
    } catch (caught) {
      const message = `路线图保存失败：${errorMessage(caught)}`;
      setCandidateActionError(message);
      throw new Error(message);
    }
  }

  async function linkLegacySeriesRun(seriesId: string, episodeNumber: number, runId: string) {
    const updated = await studioApi.linkLegacySeriesRun(seriesId, episodeNumber, runId);
    setSeries((current) => current.map((item) => item.id === updated.id ? updated : item));
    await loadSeriesWorkspace();
    setNextStepNotice(`第 ${episodeNumber} 集已关联历史成片，后续单集将按最新已定版内容解锁。`);
  }

  async function startProduction(input: StudioProductionInput) {
    const result = await studioApi.start(input);
    if (selected && (selected.status === "draft" || selected.status === "shortlisted")) {
      try {
        const approved = await studioApi.updateOpportunityStatus(selected.id, "approved");
        setOpportunities((current) => current.map((item) => item.id === approved.id ? approved : item));
      } catch (caught) {
        setCandidateActionError(`制作已创建，但机会状态同步失败：${errorMessage(caught)}`);
      }
    }
    setProductionDialogOpen(false);
    navigate(`/projects/${result.runId}`);
  }

  function openOpportunityDialog(mode: "manual" | "json") {
    setOpportunityDialogMode(mode);
    setOpportunityDialogOpen(true);
  }

  function openProductionDialog() {
    setProductionDialogOpen(true);
  }

  return (
    <main className="today-page">
      <header className="today-header">
        <div><p className="eyebrow">{entryCopy(entryMode).eyebrow}</p><h1>{entryCopy(entryMode).title}</h1><p>{dailyStatus}</p></div>
        <Link className="button button-secondary" to="/"><ArrowLeft aria-hidden="true" size={17} />更换创作入口</Link>
      </header>
      {runsLoading ? <div className="region-loading">正在读取生产状态...</div> : runsError ? (
        <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={18} />生产状态读取失败：{runsError}</div>
      ) : <ProductionStrip runs={visibleRuns} />}
      <TopicEntryWorkspace initialMode={entryMode} {...(initialCandidateId ? { initialSelectedId: initialCandidateId } : {})} selectedSeriesId={selectedSeriesId} {...(inbox ? { inbox } : {})} series={series} historicalRuns={runs} loading={{ trend: trendLoading, series: seriesLoading }} error={{ ...(trendError ? { trend: trendError } : {}), ...(seriesError ? { series: seriesError } : {}) }} trendMeta={trendMeta} {...(seriesAuditReady === undefined ? {} : { seriesAuditReady })} {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})} onRetry={(origin) => void (origin === "trend" ? loadTrendInbox(true) : loadSeriesWorkspace())} onRefreshTrends={() => void loadTrendInbox(true)} onAdopt={adoptCandidate} onCreateSeries={() => setSeriesDialogOpen(true)} onSelectSeries={setActiveSeriesId} onUpdateSeriesEpisode={updateSeriesEpisode} onLinkLegacyRun={linkLegacySeriesRun} onRescanSeries={loadSeriesWorkspace} onViewProductionRecords={() => navigate("/projects")} onManual={() => openOpportunityDialog("manual")} onImport={() => openOpportunityDialog("json")} />
      {candidateActionError ? <div className="inline-error topic-action-error" role="alert"><AlertCircle aria-hidden="true" size={18} />{candidateActionError}</div> : null}
      {nextStepNotice ? <div className="next-step-notice" role="status"><CheckCircle2 aria-hidden="true" size={18} /><strong>{nextStepNotice}</strong><button type="button" onClick={() => setNextStepNotice(undefined)} aria-label="关闭下一步提示">知道了</button></div> : null}

      <section ref={adoptedSectionRef} tabIndex={-1} className="adopted-opportunities" aria-labelledby="adopted-opportunities-title">
        <header>
          <div>
            <p className="eyebrow">{entryMode === "series" ? "本集制作" : "待制作"}</p>
            <h2 id="adopted-opportunities-title">{entryMode === "series" ? "本集制作准备" : "待制作机会"}</h2>
          </div>
          {entryMode === "series" && selected ? (
            <label className="series-production-selector">
              <span>待制作单集</span>
              <select aria-label="选择待制作单集" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                {visibleOpportunities.map((item) => <option key={item.id} value={item.id}>E{String(item.episodeNumber ?? 0).padStart(2, "0")} · {item.title}</option>)}
              </select>
            </label>
          ) : <span>{visibleOpportunities.length} 条</span>}
        </header>
        {opportunitiesLoading ? <div className="today-loading"><RadioTower aria-hidden="true" size={22} />正在读取制作机会...</div> : opportunitiesError ? (
          <div className="source-error-state" role="alert"><AlertCircle aria-hidden="true" size={22} /><div><p className="eyebrow">制作机会不可用</p><h2>机会读取失败</h2><p>{opportunitiesError}</p></div><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重试</button></div>
        ) : selected ? (
          entryMode === "series" ? (
            <div className="series-production-workspace">
              <OpportunityFocus key={selected.id} opportunity={selected} />
              <DirectorPanel opportunity={selected} providers={providers} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          ) : (
            <div className="director-workspace">
              <OpportunityRail opportunities={visibleOpportunities} selectedId={selected.id} onSelect={setSelectedId} onCreate={() => openOpportunityDialog("manual")} />
              <OpportunityFocus key={selected.id} opportunity={selected} />
              <DirectorPanel opportunity={selected} providers={providers} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          )
        ) : <div className="awaiting-adoption"><RadioTower aria-hidden="true" size={22} /><span>{entryMode === "series" ? "当前没有待制作单集；从路线图采用下一集，或到制作记录继续已有工作。" : "当前没有待制作机会；从上方采用新候选，已投产内容请到制作记录继续。"}</span><Link className="button button-secondary" to="/projects">查看制作记录</Link></div>}
      </section>

      <OpportunityDialog open={opportunityDialogOpen} initialMode={opportunityDialogMode} onClose={() => setOpportunityDialogOpen(false)} onSubmit={createOpportunity} />
      <SeriesDialog open={seriesDialogOpen} onClose={() => setSeriesDialogOpen(false)} onSubmit={createSeries} />
      <NewRunDialog open={productionDialogOpen} providers={providers} {...(creatorSettings ? { creatorSettings } : {})} {...(selected ? { initialValues: {
        title: selected.title,
        angle: selected.hook,
        audience: selected.audience,
        nicheSlug: selected.track,
        platform: selected.platform,
        durationSeconds: creatorSettings?.productionDefaults.durationSeconds ?? 24,
        ...(selected.editorialDecision?.verdict !== "skip" && selected.editorialDecision ? {
          editorial: {
            verdict: selected.editorialDecision.verdict,
            reasons: selected.editorialDecision.reasons,
            guardrails: selected.editorialDecision.guardrails,
          },
        } : {}),
        creationContext: {
          origin: selected.origin === "trend" || selected.origin === "series" ? selected.origin : "manual",
          opportunityId: selected.id,
        },
        ...(selectedSeriesContext ? { seriesContext: selectedSeriesContext } : {}),
      } } : {})} onClose={() => setProductionDialogOpen(false)} onSubmit={startProduction} />
    </main>
  );
}

function matchesEntryOrigin(
  mode: "trend" | "series" | "custom",
  origin: "trend" | "series" | "manual" | undefined,
): boolean {
  if (mode === "trend") return origin === "trend";
  if (mode === "series") return origin === "series";
  return origin === "manual";
}

function isPendingSeriesProduction(
  opportunity: StudioOpportunity,
  series: StudioSeries[],
  selectedSeriesId: string | undefined,
): boolean {
  if (!selectedSeriesId || opportunity.seriesId !== selectedSeriesId || !opportunity.episodeNumber) return false;
  const episode = series
    .find((item) => item.id === selectedSeriesId)
    ?.episodes.find((item) => item.episodeNumber === opportunity.episodeNumber);
  return episode?.status === "selected"
    && episode.opportunityId === opportunity.id
    && episode.runId === undefined
    && episode.runReservation === undefined;
}

function isPendingProduction(
  opportunity: StudioOpportunity,
  mode: "trend" | "series" | "custom",
  series: StudioSeries[],
  selectedSeriesId: string | undefined,
  runs: StudioRunSummary[],
): boolean {
  if (mode === "series") return isPendingSeriesProduction(opportunity, series, selectedSeriesId);
  if (opportunity.status !== "draft" && opportunity.status !== "shortlisted") return false;
  return !runs.some((run) => run.opportunityId === opportunity.id);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function onlyOrigin(inbox: StudioCandidateInbox, origin: StudioCandidateInboxItem["origin"]): StudioCandidateInbox {
  const items = inbox.items.filter((item) => item.origin === origin);
  return { ...inbox, items, facets: buildInboxFacets(items) };
}

function buildInboxFacets(items: StudioCandidateInboxItem[]): StudioCandidateInbox["facets"] {
  const facets: StudioCandidateInbox["facets"] = { total: items.length, origins: {}, categories: {}, platforms: {}, verdicts: {} };
  for (const item of items) {
    facets.origins[item.origin] = (facets.origins[item.origin] ?? 0) + 1;
    facets.categories[item.category] = (facets.categories[item.category] ?? 0) + 1;
    facets.platforms[item.platform] = (facets.platforms[item.platform] ?? 0) + 1;
    facets.verdicts[item.editorialDecision.verdict] = (facets.verdicts[item.editorialDecision.verdict] ?? 0) + 1;
  }
  return facets;
}

function entryCopy(mode: "trend" | "series" | "custom"): { eyebrow: string; title: string } {
  if (mode === "series") return { eyebrow: "系列策划", title: "继续你的内容系列" };
  if (mode === "custom") return { eyebrow: "自由创作", title: "从你的想法开始" };
  return { eyebrow: "热点选题", title: "挑一条真正值得做的热点" };
}

function buildTrendMeta(inbox: StudioCandidateInbox | undefined) {
  const timestamps = (inbox?.items ?? []).flatMap((item) => item.evidence.map((evidence) => evidence.collectedAt).filter((value): value is string => Boolean(value)));
  const collectedAt = newestTimestamp(timestamps);
  const generatedAt = newestTimestamp((inbox?.items ?? []).map((item) => item.generatedAt));
  return {
    platformCount: Object.keys(inbox?.facets.platforms ?? {}).length,
    candidateCount: inbox?.items.length ?? 0,
    ...(collectedAt ? { collectedAt } : {}),
    ...(generatedAt ? { generatedAt } : {}),
  };
}

function newestTimestamp(values: string[]): string | undefined {
  return values.filter((value) => Number.isFinite(Date.parse(value))).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function trendRefreshPollDelay(attempt: number): number {
  if (attempt < 5) return 2_000;
  if (attempt < 20) return 5_000;
  return 15_000;
}
