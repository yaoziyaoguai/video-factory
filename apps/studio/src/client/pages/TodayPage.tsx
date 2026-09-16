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
import { CandidateVerificationDialog } from "../components/CandidateVerificationDialog.js";
import { DirectorPanel } from "../components/DirectorPanel.js";
import { HotTopicBoard } from "../components/HotTopicBoard.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { OpportunityDialog } from "../components/OpportunityDialog.js";
import { OpportunityFocus } from "../components/OpportunityFocus.js";
import { OpportunityRail } from "../components/OpportunityRail.js";
import { ProductionStrip } from "../components/ProductionStrip.js";
import { SeriesDialog } from "../components/SeriesDialog.js";
import { SourceSupplementDialog } from "../components/SourceSupplementDialog.js";
import { TopicEntryWorkspace } from "../components/TopicEntryWorkspace.js";
import { opportunityProductionAdvice } from "../presentation.js";

export function TodayPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedMode = searchParams.get("mode");
  const entryMode = requestedMode === "series" ? "series" : requestedMode === "manual" || requestedMode === "custom" ? "custom" : "trend";
  const initialCandidateId = searchParams.get("candidate") ?? undefined;
  // 深链（全局搜索、保存机会后的下一步）用 opportunity 参数直接选中对应机会。
  const initialOpportunityId = searchParams.get("opportunity") ?? undefined;
  const [opportunities, setOpportunities] = useState<StudioOpportunity[]>([]);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [creatorSettings, setCreatorSettings] = useState<StudioCreatorSettings>();
  const [trendInbox, setTrendInbox] = useState<StudioCandidateInbox>();
  const [seriesInbox, setSeriesInbox] = useState<StudioCandidateInbox>();
  const [series, setSeries] = useState<StudioSeries[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialOpportunityId);
  const [opportunityDialogOpen, setOpportunityDialogOpen] = useState(false);
  const [opportunityDialogMode, setOpportunityDialogMode] = useState<"manual" | "json">("manual");
  const [seriesDialogOpen, setSeriesDialogOpen] = useState(false);
  const [productionDialogOpen, setProductionDialogOpen] = useState(false);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(true);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [opportunitiesError, setOpportunitiesError] = useState<string>();
  const [providersError, setProvidersError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [runsError, setRunsError] = useState<string>();
  const [trendError, setTrendError] = useState<string>();
  const [seriesError, setSeriesError] = useState<string>();
  const [candidateActionError, setCandidateActionError] = useState<string>();
  const [adoptingCandidateId, setAdoptingCandidateId] = useState<string>();
  const [boardVerificationCandidate, setBoardVerificationCandidate] = useState<StudioCandidateInboxItem>();
  const [nextStepNotice, setNextStepNotice] = useState<string>();
  const [nextStepNoticeAction, setNextStepNoticeAction] = useState<{ to: string; label: string }>();
  // 提示统一入口：不带跳转动作的提示会清掉旧链接，避免“去查看”指向过期目标。
  const announceNotice = useCallback((text: string) => {
    setNextStepNoticeAction(undefined);
    setNextStepNotice(text);
  }, []);
  const [sourceSupplementTarget, setSourceSupplementTarget] = useState<
    { kind: "candidate"; candidate: StudioCandidateInboxItem } | { kind: "opportunity"; opportunity: StudioOpportunity }
  >();
  const [sourceSupplementPending, setSourceSupplementPending] = useState(false);
  const [sourceSupplementError, setSourceSupplementError] = useState<string>();
  const [trendRefreshFinishedAt, setTrendRefreshFinishedAt] = useState<string>();
  const [trendRefreshPending, setTrendRefreshPending] = useState(false);
  const [trendRefreshing, setTrendRefreshing] = useState(false);
  const adoptedSectionRef = useRef<HTMLElement>(null);
  const trendLoadingRef = useRef(false);
  const trendRefreshPollRef = useRef<number | undefined>(undefined);
  const trendGenerationPollRef = useRef<number | undefined>(undefined);

  const updateTrendInbox = useCallback((next: StudioCandidateInbox) => {
    const scoped = onlyOrigin(next, "trend");
    setTrendInbox(scoped);
    setTrendRefreshing(scoped.refreshing);
    return scoped;
  }, []);

  // 收件箱读取不再等待生成：冷缓存时服务端先返回空快照并标记 refreshing。
  // 这里持续重读，直到后台生成落地，否则界面会停在"暂无候选"而实际仍在生成。
  const scheduleTrendGenerationPoll = useCallback(function poll(attempt: number) {
    if (trendGenerationPollRef.current !== undefined) window.clearTimeout(trendGenerationPollRef.current);
    const step = async () => {
      try {
        const next = updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
        if (next.refreshing && attempt < TREND_GENERATION_POLL_LIMIT) {
          scheduleTrendGenerationPoll(attempt + 1);
          return;
        }
        setTrendError(undefined);
      } catch {
        if (attempt < TREND_GENERATION_POLL_LIMIT) scheduleTrendGenerationPoll(attempt + 1);
      }
    };
    trendGenerationPollRef.current = window.setTimeout(() => void step(), trendRefreshPollDelay(attempt));
  }, [updateTrendInbox]);

  const scheduleTrendRefreshPoll = useCallback((refreshId: string) => {
    if (trendRefreshPollRef.current !== undefined) window.clearTimeout(trendRefreshPollRef.current);
    const poll = async (attempt: number, consecutiveFailures = 0) => {
      let nextFailures = 0;
      try {
        const status = await studioApi.trendCandidateRefreshStatus(refreshId);
        if (status.state === "succeeded") {
          const refreshedInbox = updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
          setTrendError(undefined);
          setTrendRefreshFinishedAt(status.finishedAt ?? new Date().toISOString());
          const collectedCount = status.candidateCount ?? refreshedInbox.items.length;
          const decidedCount = Math.max(0, collectedCount - refreshedInbox.items.length);
          announceNotice(decidedCount > 0
            ? `本次采集 ${collectedCount} 条，其中 ${decidedCount} 条已进入制作区；当前有 ${refreshedInbox.items.length} 条待判断。`
            : `热点候选已更新完成，当前有 ${refreshedInbox.items.length} 条待判断。`);
          setTrendRefreshPending(false);
          return;
        }
        if (status.state === "failed") {
          announceNotice(status.error ?? "热点更新失败，请稍后手动重试。");
          setTrendRefreshPending(false);
          return;
        }
      } catch {
        nextFailures = consecutiveFailures + 1;
        if (nextFailures >= 3) {
          announceNotice("暂时无法确认热点更新状态，当前缓存仍可使用；请稍后再试。");
          setTrendRefreshPending(false);
          return;
        }
      }
      if (attempt >= 39) {
        // 刷新状态轮询放弃后，改由收件箱轮询继续等到生成真正落地，避免这里放弃就彻底停更。
        announceNotice("热点更新仍未完成，当前缓存可以继续使用；稍后可再次查看或手动刷新。");
        setTrendRefreshPending(false);
        scheduleTrendGenerationPoll(0);
        return;
      }
      trendRefreshPollRef.current = window.setTimeout(() => void poll(attempt + 1, nextFailures), trendRefreshPollDelay(attempt));
    };
    trendRefreshPollRef.current = window.setTimeout(() => void poll(0), trendRefreshPollDelay(0));
  }, [scheduleTrendGenerationPoll, updateTrendInbox]);

  useEffect(() => () => {
    if (trendRefreshPollRef.current !== undefined) window.clearTimeout(trendRefreshPollRef.current);
    if (trendGenerationPollRef.current !== undefined) window.clearTimeout(trendGenerationPollRef.current);
  }, []);

  const loadTrendInbox = useCallback(async (forceRefresh = false) => {
    if (trendLoadingRef.current) return;
    trendLoadingRef.current = true;
    setTrendLoading(true);
    setTrendError(undefined);
    try {
      if (forceRefresh) {
        setTrendRefreshPending(true);
        try {
          const receipt = await studioApi.refreshTrendCandidates();
          announceNotice(receipt.status === "already_running"
            ? "热点后台更新已在进行，当前缓存仍可继续选择。"
            : "热点后台更新已开始，当前缓存仍可继续选择。");
          scheduleTrendRefreshPoll(receipt.refreshId);
        } catch (refreshError) {
          setTrendRefreshPending(false);
          throw refreshError;
        }
      }
      const scoped = updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
      // 手动刷新时刷新状态轮询已经在等同一批生成，不重复起第二条轮询。
      if (scoped.refreshing && !forceRefresh) scheduleTrendGenerationPoll(0);
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
    setSettingsLoading(true);
    setRunsLoading(true);
    setOpportunitiesError(undefined);
    setProvidersError(undefined);
    setSettingsError(undefined);
    setRunsError(undefined);
    await Promise.all([
      studioApi.opportunities(origin).then((nextOpportunities) => {
        setOpportunities(nextOpportunities);
        setSelectedId((current) => current && nextOpportunities.some((item) => item.id === current) ? current : nextOpportunities[0]?.id);
      }).catch((caught: unknown) => setOpportunitiesError(errorMessage(caught))).finally(() => setOpportunitiesLoading(false)),
      studioApi.providers().then(setProviders).catch((caught: unknown) => setProvidersError(errorMessage(caught))).finally(() => setProvidersLoading(false)),
      studioApi.runs(entryMode === "series" ? undefined : origin).then(setRuns).catch((caught: unknown) => setRunsError(errorMessage(caught))).finally(() => setRunsLoading(false)),
      // 读取失败必须留下可见错误并阻断开工；成功返回（含未自定义的系统默认）才允许带入默认值。
      studioApi.settings().then(setCreatorSettings).catch((caught: unknown) => setSettingsError(errorMessage(caught))).finally(() => setSettingsLoading(false)),
    ]);
  }, [entryMode]);

  // 原地重读创作设置：成功后用服务端保存值解除阻塞，不要求刷新整页。
  const retrySettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(undefined);
    try {
      setCreatorSettings(await studioApi.settings());
    } catch (caught: unknown) {
      setSettingsError(errorMessage(caught));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (entryMode === "trend") void loadTrendInbox();
    if (entryMode === "series") void loadSeriesWorkspace();
  }, [entryMode, load, loadSeriesWorkspace, loadTrendInbox]);
  const inbox = entryMode === "trend" ? trendInbox : entryMode === "series" ? seriesInbox : undefined;
  // 能力 ready 与最近一次真实生成分开投影；来源只取服务端本轮 receipt，
  // 空候选或混有旧缓存时也不再从候选集合猜测模型是否成功。
  const recentTopicGeneration = trendInbox?.topicGeneration?.source;
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
  // 建议只影响排序与标注：所有待制作机会都能开工，界面不再按建议把机会分流成"可开工/不可开工"。
  const advisedOpportunities = useMemo(
    () => entryMode === "trend"
      ? visibleOpportunities.filter((item) => opportunityProductionAdvice(item) !== undefined)
      : [],
    [entryMode, visibleOpportunities],
  );
  const advisedOpportunityCount = advisedOpportunities.length;
  const displayedOpportunities = useMemo(
    () => advisedOpportunityCount
      ? [...visibleOpportunities.filter((item) => opportunityProductionAdvice(item) === undefined), ...advisedOpportunities]
      : visibleOpportunities,
    [advisedOpportunityCount, advisedOpportunities, visibleOpportunities],
  );
  const sourceBlockedOpportunities = useMemo(
    () => entryMode === "trend"
      ? visibleOpportunities.filter((item) => item.verification?.status === "blocked")
      : [],
    [entryMode, visibleOpportunities],
  );
  const sourceBlockedCount = sourceBlockedOpportunities.length;
  const visibleRuns = useMemo(
    () => runs.filter((run) => matchesEntryOrigin(entryMode, run.creationOrigin)
      && (entryMode !== "series" || !selectedSeriesId || run.seriesId === selectedSeriesId)),
    [entryMode, runs, selectedSeriesId],
  );
  const selected = useMemo(
    () => displayedOpportunities.find((item) => item.id === selectedId) ?? displayedOpportunities[0],
    [displayedOpportunities, selectedId],
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
  const visibleCandidateItems = entryMode === "series" && selectedSeriesId
    ? (inbox?.items.filter((item) => item.seriesId === selectedSeriesId) ?? [])
    : (inbox?.items ?? []);
  const visibleCandidateCount = entryMode === "series" && selectedSeriesId
    ? visibleCandidateItems.length
    : (inbox?.facets.total ?? 0);
  const adoptableCandidateCount = visibleCandidateItems.filter(isAdoptableCandidate).length;
  const completedCount = visibleRuns.filter((run) => run.status === "succeeded").length;
  const dailyStatus = entryMode === "trend"
    ? `${adoptableCandidateCount} 条候选可进入制作 · ${visibleOpportunities.length} 条已进入待制作区${advisedOpportunityCount > 0 ? ` · ${advisedOpportunityText(advisedOpportunityCount, sourceBlockedCount)}` : ""} · ${completedCount} 条已完成`
    : `${visibleCandidateCount} 条候选 · ${visibleOpportunities.length} 条制作机会 · ${completedCount} 条已完成`;
  const seriesAuditReady = providersLoading
    ? undefined
    : !providersError && providers.some((provider) => provider.capability === "series.plan" && provider.available && provider.kind !== "test");

  useEffect(() => {
    // 机会仍在加载时不要重置选中项：深链（?opportunity=）带入的初始 id 必须等到列表就绪后再校验。
    if (opportunitiesLoading) return;
    setSelectedId((current) => current && displayedOpportunities.some((item) => item.id === current)
      ? current
      : displayedOpportunities[0]?.id);
  }, [displayedOpportunities, opportunitiesLoading]);

  async function createOpportunity(input: StudioOpportunityInput) {
    const created = await studioApi.createOpportunity({ ...input, origin: input.origin ?? "manual" });
    setOpportunities((current) => [created, ...current]);
    setSelectedId(created.id);
    setOpportunityDialogOpen(false);
    // 保存成功必须可见、可继续：自定义机会进入「从想法开始」的待制作区，
    // 跨页状态以服务端机会状态为准，这里只负责告诉用户它去了哪里、下一步做什么。
    if (entryMode === "custom") {
      announceNotice(`已保存《${created.title}》。它已进入下方待制作区，可以直接开始制作。`);
      return;
    }
    announceNotice(`已保存《${created.title}》。它已进入「从想法开始」的待制作区，当前入口继续展示热点候选。`);
    setNextStepNoticeAction({ to: `/topics?mode=custom&opportunity=${encodeURIComponent(created.id)}`, label: "去查看并制作" });
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
      announceNotice("已采用。下一步：检查证据与镜头计划，再开始制作。");
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

  // 待制作区的方向按钮：需要人工核验的方向先弹核验弹窗，其余直接采用。
  async function adoptDirection(candidate: StudioCandidateInboxItem) {
    if (candidate.verification.status === "review_required") {
      setBoardVerificationCandidate(candidate);
      return;
    }
    await adoptCandidate(candidate);
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
      announceNotice(`第 ${episodeNumber} 集路线图已保存为人工版本，后续角色会基于这个版本重新审计。`);
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
    announceNotice(`第 ${episodeNumber} 集已关联历史成片，后续单集将按最新已定版内容解锁。`);
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

  function focusSourceBlockedOpportunity(opportunityId: string) {
    setSelectedId(opportunityId);
    window.requestAnimationFrame(() => {
      adoptedSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      adoptedSectionRef.current?.focus({ preventScroll: true });
    });
  }

  // 补充来源保存成功后不做任何乐观解除阻塞：完全重新拉取候选/机会列表，
  // 让来源数、门禁状态、分组和推荐模板都以服务端重算结果为准。
  async function submitSupplementSources(evidenceUrls: string[]) {
    if (!sourceSupplementTarget) return;
    setSourceSupplementPending(true);
    setSourceSupplementError(undefined);
    try {
      if (sourceSupplementTarget.kind === "candidate") {
        const candidate = sourceSupplementTarget.candidate;
        await studioApi.supplementCandidateSources(candidate.id, {
          evidenceUrls,
          // 入口声明让服务端把补充写入对应持久层：热点→候选缓存，系列→单集计划。
          ...(candidate.origin === "series" ? { origin: "series" as const } : { origin: "trend" as const }),
        });
        if (candidate.origin === "series") {
          await loadSeriesWorkspace();
        } else {
          updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
        }
      } else {
        await studioApi.supplementOpportunitySources(sourceSupplementTarget.opportunity.id, { evidenceUrls });
        const origin = entryMode === "custom" ? "manual" : entryMode;
        setOpportunities(await studioApi.opportunities(origin));
      }
      setSourceSupplementTarget(undefined);
      announceNotice("来源已保存；开工门槛与制作建议已按最新来源重算。");
    } catch (caught) {
      setSourceSupplementError(`来源保存失败：${errorMessage(caught)}`);
      throw caught;
    } finally {
      setSourceSupplementPending(false);
    }
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
      {settingsError ? (
        <div className="inline-error" role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>未能读取你的创作设置，为避免用错声音/平台/时长，暂未开工。{settingsError}</span>
          <button className="button button-secondary" type="button" onClick={() => void retrySettings()}><RefreshCw aria-hidden="true" size={16} />重新读取</button>
        </div>
      ) : null}
      <TopicEntryWorkspace initialMode={entryMode} {...(initialCandidateId ? { initialSelectedId: initialCandidateId } : {})} selectedSeriesId={selectedSeriesId} {...(inbox ? { inbox } : {})} series={series} historicalRuns={runs} loading={{ trend: trendLoading, series: seriesLoading }} error={{ ...(trendError ? { trend: trendError } : {}), ...(seriesError ? { series: seriesError } : {}) }} trendMeta={trendMeta} trendRefreshPending={trendRefreshPending} trendRefreshing={trendRefreshing} sourceBlockedOpportunities={sourceBlockedOpportunities} onFocusSourceBlocked={focusSourceBlockedOpportunity} {...(seriesAuditReady === undefined ? {} : { seriesAuditReady })} {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})} onRetry={(origin) => void (origin === "trend" ? loadTrendInbox(true) : loadSeriesWorkspace())} onRefreshTrends={() => void loadTrendInbox(true)} onAdopt={adoptCandidate} onSupplementSources={(candidate) => setSourceSupplementTarget({ kind: "candidate", candidate })} onCreateSeries={() => setSeriesDialogOpen(true)} onSelectSeries={setActiveSeriesId} onUpdateSeriesEpisode={updateSeriesEpisode} onLinkLegacyRun={linkLegacySeriesRun} onRescanSeries={loadSeriesWorkspace} onViewProductionRecords={() => navigate("/projects")} onManual={() => openOpportunityDialog("manual")} onImport={() => openOpportunityDialog("json")} />
      {candidateActionError ? <div className="inline-error topic-action-error" role="alert"><AlertCircle aria-hidden="true" size={18} />{candidateActionError}</div> : null}
      {nextStepNotice ? <div className="next-step-notice" role="status"><CheckCircle2 aria-hidden="true" size={18} /><strong>{nextStepNotice}</strong>{nextStepNoticeAction ? <Link className="button button-secondary" to={nextStepNoticeAction.to}>{nextStepNoticeAction.label}</Link> : null}<button type="button" onClick={() => { setNextStepNotice(undefined); setNextStepNoticeAction(undefined); }} aria-label="关闭下一步提示">知道了</button></div> : null}

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
                {displayedOpportunities.map((item) => <option key={item.id} value={item.id}>E{String(item.episodeNumber ?? 0).padStart(2, "0")} · {item.title}</option>)}
              </select>
            </label>
          ) : <span>{entryMode === "trend"
            ? `${visibleOpportunities.length} 条已进入待制作区${advisedOpportunityCount > 0 ? ` · ${advisedOpportunityText(advisedOpportunityCount, sourceBlockedCount)}` : ""}`
            : `${visibleOpportunities.length} 条`}</span>}
        </header>
        {entryMode === "trend" ? (
          <HotTopicBoard
            candidates={(trendInbox?.items ?? []).filter((item) => !opportunities.some((adopted) => adopted.id === item.id))}
            {...(trendInbox?.topicGeneration ? { topicGeneration: trendInbox.topicGeneration } : {})}
            {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})}
            refreshBusy={trendRefreshPending || trendRefreshing}
            onAdopt={adoptDirection}
            onSupplementSources={(candidate) => setSourceSupplementTarget({ kind: "candidate", candidate })}
            onRetry={() => void loadTrendInbox(true)}
          />
        ) : null}
        {opportunitiesLoading ? <div className="today-loading"><RadioTower aria-hidden="true" size={22} />正在读取制作机会...</div> : opportunitiesError ? (
          <div className="source-error-state" role="alert"><AlertCircle aria-hidden="true" size={22} /><div><p className="eyebrow">制作机会不可用</p><h2>机会读取失败</h2><p>{opportunitiesError}</p></div><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重试</button></div>
        ) : selected ? (
          entryMode === "series" ? (
            <div className="series-production-workspace">
              <OpportunityFocus key={selected.id} opportunity={selected} />
              <DirectorPanel opportunity={selected} providers={providers} {...(recentTopicGeneration ? { recentTopicGeneration } : {})} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          ) : (
            <div className="director-workspace">
              <OpportunityRail opportunities={displayedOpportunities} selectedId={selected.id} onSelect={setSelectedId} onCreate={() => openOpportunityDialog("manual")} />
              <OpportunityFocus key={selected.id} opportunity={selected} {...(selected.origin === "trend" && selected.verification?.status === "blocked" ? { onSupplementSources: () => setSourceSupplementTarget({ kind: "opportunity", opportunity: selected }) } : {})} />
              <DirectorPanel opportunity={selected} providers={providers} {...(recentTopicGeneration ? { recentTopicGeneration } : {})} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          )
        ) : <div className="awaiting-adoption"><RadioTower aria-hidden="true" size={22} /><span>{entryMode === "series" ? "当前没有待制作单集；从路线图采用下一集，或到制作记录继续已有工作。" : "当前没有待制作机会；从上方采用新候选，已开始制作的内容请到制作记录继续。"}</span><Link className="button button-secondary" to="/projects">查看制作记录</Link></div>}
      </section>

      <OpportunityDialog open={opportunityDialogOpen} initialMode={opportunityDialogMode} onClose={() => setOpportunityDialogOpen(false)} onSubmit={createOpportunity} />
      <SourceSupplementDialog
        open={sourceSupplementTarget !== undefined}
        title={sourceSupplementTarget?.kind === "candidate" ? sourceSupplementTarget.candidate.title : sourceSupplementTarget?.opportunity.title ?? ""}
        currentSources={sourceSupplementTarget?.kind === "candidate"
          ? sourceSupplementTarget.candidate.verification.independentSources
          : sourceSupplementTarget?.opportunity.verification?.independentSources ?? 0}
        requiredSources={sourceSupplementTarget?.kind === "candidate"
          ? sourceSupplementTarget.candidate.verification.requiredSources
          : sourceSupplementTarget?.opportunity.verification?.requiredSources ?? 2}
        pending={sourceSupplementPending}
        {...(sourceSupplementError ? { error: sourceSupplementError } : {})}
        onClose={() => {
          if (sourceSupplementPending) return;
          setSourceSupplementTarget(undefined);
          setSourceSupplementError(undefined);
        }}
        onSubmit={submitSupplementSources}
      />
      <CandidateVerificationDialog
        {...(boardVerificationCandidate ? { candidate: boardVerificationCandidate } : {})}
        pending={boardVerificationCandidate?.id === adoptingCandidateId}
        onClose={() => setBoardVerificationCandidate(undefined)}
        onConfirm={async () => {
          if (!boardVerificationCandidate) return;
          await adoptCandidate(boardVerificationCandidate, true);
          setBoardVerificationCandidate(undefined);
        }}
      />
      <SeriesDialog open={seriesDialogOpen} onClose={() => setSeriesDialogOpen(false)} onSubmit={createSeries} />
      <NewRunDialog open={productionDialogOpen} providers={providers} initialDataReady={!providersLoading && !settingsLoading && !settingsError} {...(creatorSettings ? { creatorSettings } : {})} {...(settingsError ? { settingsError } : {})} onRetrySettings={() => void retrySettings()} {...(selected ? { initialValues: {
        title: selected.title,
        angle: selected.hook,
        audience: selected.audience,
        nicheSlug: selected.track,
        platform: selected.origin === "trend"
          ? creatorSettings?.productionDefaults.platform ?? "douyin"
          : selected.platform,
        durationSeconds: creatorSettings?.productionDefaults.durationSeconds ?? 24,
        ...(selected.visualProof ? { visualProof: selected.visualProof } : {}),
        ...(selected.visualPlan ? { visualPlan: selected.visualPlan } : {}),
        // editorial 是"做哪种形态"给编剧/导演用的形态指令，不是总编的意见记录：
        // 总编建议不做（skip）时不该把它塞进这里，否则下游会把它当成形态指令。
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
  // 案例来源的 run 不属于这里的任何一个入口：它从案例页出发，不在选题页的列表里出现。
  origin: "trend" | "series" | "manual" | "case" | undefined,
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
  const selectedSeries = series.find((item) => item.id === selectedSeriesId);
  if (!selectedSeries || !isProductionPlatform(selectedSeries.platform)) return false;
  const episode = selectedSeries.episodes.find((item) => item.episodeNumber === opportunity.episodeNumber);
  return episode?.status === "selected"
    && episode.opportunityId === opportunity.id
    && episode.runId === undefined
    && episode.runReservation === undefined;
}

function isProductionPlatform(platform: string): boolean {
  return platform === "douyin" || platform === "xiaohongshu" || platform === "bilibili";
}

// "可进入制作"只排除系列顺序还没轮到的候选：来源与总编建议都只是提醒，不再构成闸门。
function isAdoptableCandidate(candidate: StudioCandidateInboxItem): boolean {
  return candidate.seriesSequence?.status !== "blocked";
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

// 只用于汇总文案：提醒条数按"建议先补来源"与"总编不建议"分开说，避免把两种建议混成一个数。
function advisedOpportunityText(count: number, sourceBlockedCount: number): string {
  if (sourceBlockedCount > 0 && count > sourceBlockedCount) return `${sourceBlockedCount} 条建议先补来源 · ${count - sourceBlockedCount} 条总编不建议`;
  if (sourceBlockedCount > 0) return `${sourceBlockedCount} 条建议先补来源`;
  return `${count} 条总编不建议`;
}

function onlyOrigin(inbox: StudioCandidateInbox, origin: StudioCandidateInboxItem["origin"]): StudioCandidateInbox {
  const items = inbox.items.filter((item) => item.origin === origin);
  return { ...inbox, items, facets: buildInboxFacets(items) };
}

// 生成可能持续十几分钟；轮询上限只用来兜底，不用于提前判定"没有候选"。
const TREND_GENERATION_POLL_LIMIT = 120;

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
