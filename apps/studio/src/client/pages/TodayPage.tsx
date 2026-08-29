import { AlertCircle, CheckCircle2, Plus, RadioTower, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

const TREND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function TodayPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const entryMode = searchParams.get("mode") === "series" ? "series" : searchParams.get("mode") === "manual" ? "custom" : "trend";
  const initialCandidateId = searchParams.get("candidate") ?? undefined;
  const [opportunities, setOpportunities] = useState<StudioOpportunity[]>([]);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [creatorSettings, setCreatorSettings] = useState<StudioCreatorSettings>();
  const [trendInbox, setTrendInbox] = useState<StudioCandidateInbox>();
  const [seriesInbox, setSeriesInbox] = useState<StudioCandidateInbox>();
  const [series, setSeries] = useState<StudioSeries[]>([]);
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
  const [journeyStep, setJourneyStep] = useState<0 | 1 | 2>(0);
  const [nextStepNotice, setNextStepNotice] = useState<string>();
  const adoptedSectionRef = useRef<HTMLElement>(null);
  const trendLoadingRef = useRef(false);
  const lastTrendRefreshAtRef = useRef(0);

  const loadTrendInbox = useCallback(async (forceRefresh = false) => {
    if (trendLoadingRef.current) return;
    trendLoadingRef.current = true;
    setTrendLoading(true);
    setTrendError(undefined);
    try {
      if (forceRefresh) await studioApi.refreshTrendCandidates();
      setTrendInbox(onlyOrigin(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }), "trend"));
      lastTrendRefreshAtRef.current = Date.now();
    } catch (caught) {
      setTrendError(errorMessage(caught));
    } finally {
      trendLoadingRef.current = false;
      setTrendLoading(false);
    }
  }, []);

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
    setOpportunitiesLoading(true);
    setProvidersLoading(true);
    setRunsLoading(true);
    setOpportunitiesError(undefined);
    setProvidersError(undefined);
    setRunsError(undefined);
    await Promise.all([
      studioApi.opportunities().then((nextOpportunities) => {
        setOpportunities(nextOpportunities);
        setSelectedId((current) => current && nextOpportunities.some((item) => item.id === current) ? current : nextOpportunities[0]?.id);
      }).catch((caught: unknown) => setOpportunitiesError(errorMessage(caught))).finally(() => setOpportunitiesLoading(false)),
      studioApi.providers().then(setProviders).catch((caught: unknown) => setProvidersError(errorMessage(caught))).finally(() => setProvidersLoading(false)),
      studioApi.runs().then(setRuns).catch((caught: unknown) => setRunsError(errorMessage(caught))).finally(() => setRunsLoading(false)),
      studioApi.settings().then(setCreatorSettings).catch(() => undefined),
    ]);
  }, []);

  useEffect(() => {
    void load();
    void loadTrendInbox();
    void loadSeriesWorkspace();
  }, [load, loadSeriesWorkspace, loadTrendInbox]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadTrendInbox(true), TREND_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadTrendInbox]);
  useEffect(() => {
    const refreshWhenStale = () => {
      if (Date.now() - lastTrendRefreshAtRef.current >= TREND_REFRESH_INTERVAL_MS) void loadTrendInbox(true);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshWhenStale();
    };
    window.addEventListener("focus", refreshWhenStale);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenStale);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadTrendInbox]);
  const inbox = useMemo(() => mergeInboxes(trendInbox, seriesInbox), [seriesInbox, trendInbox]);
  const trendMeta = useMemo(() => buildTrendMeta(trendInbox), [trendInbox]);
  const selected = useMemo(() => opportunities.find((item) => item.id === selectedId) ?? opportunities[0], [opportunities, selectedId]);
  const dailyStatus = `${inbox?.facets.total ?? 0} 条候选 · ${opportunities.length} 条制作机会 · ${runs.filter((run) => run.status === "succeeded").length} 条已完成`;

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
      const adopted = await studioApi.adoptCandidate(candidate.id, verificationConfirmed ? { verificationConfirmed: true } : {});
      setOpportunities((current) => [adopted, ...current.filter((item) => item.id !== adopted.id)]);
      setSelectedId(adopted.id);
      const updateInbox = (current: StudioCandidateInbox | undefined) => current ? {
        ...current,
        items: current.items.filter((item) => item.id !== candidate.id),
        facets: { ...current.facets, total: Math.max(0, current.facets.total - 1) },
      } : current;
      if (candidate.origin === "trend") setTrendInbox(updateInbox);
      else setSeriesInbox(updateInbox);
      setJourneyStep(1);
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
    setJourneyStep(2);
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
        <div><p className="eyebrow">今日创作</p><h1>今天做哪一条？</h1><p>{dailyStatus}</p></div>
        <button className="button button-secondary" type="button" onClick={() => openOpportunityDialog("manual")}><Plus aria-hidden="true" size={17} />自定义创作</button>
      </header>
      {runsLoading ? <div className="region-loading">正在读取生产状态...</div> : runsError ? (
        <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={18} />生产状态读取失败：{runsError}</div>
      ) : <ProductionStrip runs={runs} />}
      <section className="daily-path" aria-label="今天做一条视频">
        <div className={journeyStep > 0 ? "daily-path-step is-complete" : "daily-path-step is-current"}><span>01</span><div><strong>选择选题</strong><small>热点、系列或自己的观察</small></div></div>
        <div className={journeyStep > 1 ? "daily-path-step is-complete" : journeyStep === 1 ? "daily-path-step is-current" : "daily-path-step"}><span>02</span><div><strong>确认内容</strong><small>核验证据、钩子与制作配方</small></div></div>
        <div className={journeyStep === 2 ? "daily-path-step is-current" : "daily-path-step"}><span>03</span><div><strong>生成与审片</strong><small>看完成片，再决定批准或打回</small></div></div>
      </section>

      <TopicEntryWorkspace initialMode={entryMode} {...(initialCandidateId ? { initialSelectedId: initialCandidateId } : {})} {...(inbox ? { inbox } : {})} series={series} loading={{ trend: trendLoading, series: seriesLoading }} error={{ ...(trendError ? { trend: trendError } : {}), ...(seriesError ? { series: seriesError } : {}) }} trendMeta={trendMeta} {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})} onRetry={(origin) => void (origin === "trend" ? loadTrendInbox(true) : loadSeriesWorkspace())} onRefreshTrends={() => void loadTrendInbox(true)} onAdopt={adoptCandidate} onCreateSeries={() => setSeriesDialogOpen(true)} onManual={() => openOpportunityDialog("manual")} onImport={() => openOpportunityDialog("json")} />
      {candidateActionError ? <div className="inline-error topic-action-error" role="alert"><AlertCircle aria-hidden="true" size={18} />{candidateActionError}</div> : null}
      {nextStepNotice ? <div className="next-step-notice" role="status"><CheckCircle2 aria-hidden="true" size={18} /><strong>{nextStepNotice}</strong><button type="button" onClick={() => setNextStepNotice(undefined)} aria-label="关闭下一步提示">知道了</button></div> : null}

      <section ref={adoptedSectionRef} tabIndex={-1} className="adopted-opportunities" aria-labelledby="adopted-opportunities-title">
        <header><div><p className="eyebrow">待制作</p><h2 id="adopted-opportunities-title">已采用的制作机会</h2></div><span>{opportunities.length} 条</span></header>
        {opportunitiesLoading ? <div className="today-loading"><RadioTower aria-hidden="true" size={22} />正在读取制作机会...</div> : opportunitiesError ? (
          <div className="source-error-state" role="alert"><AlertCircle aria-hidden="true" size={22} /><div><p className="eyebrow">制作机会不可用</p><h2>机会读取失败</h2><p>{opportunitiesError}</p></div><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重试</button></div>
        ) : selected ? (
          <div className="director-workspace">
            <OpportunityRail opportunities={opportunities} selectedId={selected.id} onSelect={(id) => { setSelectedId(id); setJourneyStep(1); }} onCreate={() => openOpportunityDialog("manual")} />
            <OpportunityFocus key={selected.id} opportunity={selected} />
            <DirectorPanel opportunity={selected} providers={providers} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
          </div>
        ) : <div className="awaiting-adoption"><RadioTower aria-hidden="true" size={22} /><span>从上方采用一条候选，它会在这里进入内容确认与制作。</span></div>}
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
      } } : {})} onClose={() => setProductionDialogOpen(false)} onSubmit={startProduction} />
    </main>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function onlyOrigin(inbox: StudioCandidateInbox, origin: StudioCandidateInboxItem["origin"]): StudioCandidateInbox {
  const items = inbox.items.filter((item) => item.origin === origin);
  return { ...inbox, items, facets: buildInboxFacets(items) };
}

function mergeInboxes(...inboxes: Array<StudioCandidateInbox | undefined>): StudioCandidateInbox | undefined {
  const present = inboxes.filter((item): item is StudioCandidateInbox => Boolean(item));
  if (present.length === 0) return undefined;
  const items = [...new Map(present.flatMap((item) => item.items).map((item) => [item.id, item])).values()];
  return { items, facets: buildInboxFacets(items), generatedAt: present.map((item) => item.generatedAt).sort().at(-1)! };
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
