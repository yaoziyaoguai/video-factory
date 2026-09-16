import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Clapperboard,
  Clock3,
  FileInput,
  LibraryBig,
  LockKeyhole,
  PenLine,
  PencilLine,
  Plus,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  StudioCandidateInbox,
  StudioCandidateInboxItem,
  StudioCandidateOrigin,
  StudioEditorialVerdict,
  StudioOpportunity,
  StudioRunSummary,
  StudioSeries,
  StudioSeriesEpisodePlanInput,
  StudioTopicCategory,
  StudioTopicGenerationReceipt,
} from "../../shared/api.js";
import { creatorFacingTechnicalText, reasoningEffortLabel } from "../presentation.js";
import { platformLabel, proposalSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";
import { CandidateVerificationDialog } from "./CandidateVerificationDialog.js";
import { SeriesEpisodeDialog } from "./SeriesEpisodeDialog.js";

type EntryMode = StudioCandidateOrigin | "custom";
type TrendDeskView = "all" | "produce_video" | "produce_image_story" | "not_recommended" | "pending_editor" | "source_short";

interface TopicEntryWorkspaceProps {
  initialMode?: EntryMode;
  initialSelectedId?: string;
  selectedSeriesId: string | undefined;
  inbox?: StudioCandidateInbox;
  series: StudioSeries[];
  historicalRuns: StudioRunSummary[];
  loading: Partial<Record<StudioCandidateOrigin, boolean>>;
  error?: Partial<Record<StudioCandidateOrigin, string>>;
  adoptingId?: string;
  trendMeta: { platformCount: number; candidateCount: number; collectedAt?: string; generatedAt?: string; refreshedAt?: string };
  seriesAuditReady?: boolean;
  onRetry: (origin: StudioCandidateOrigin) => void;
  onRefreshTrends: () => void;
  onAdopt: (candidate: StudioCandidateInboxItem, verificationConfirmed?: boolean) => Promise<void>;
  onSupplementSources?: (candidate: StudioCandidateInboxItem) => void;
  onCreateSeries: () => void;
  onSelectSeries: (seriesId: string) => void;
  onUpdateSeriesEpisode: (seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput) => Promise<void>;
  onLinkLegacyRun: (seriesId: string, episodeNumber: number, runId: string) => Promise<void>;
  onRescanSeries: () => Promise<void>;
  onViewProductionRecords: () => void;
  onManual: () => void;
  onImport: () => void;
  trendRefreshPending?: boolean;
  /** 热点候选正在后台生成：此时收件箱里的 items 只是缓存快照，空集合并不等于"没有候选"。 */
  trendRefreshing?: boolean;
  sourceBlockedOpportunities?: StudioOpportunity[];
  onFocusSourceBlocked?: (opportunityId: string) => void;
}

const CATEGORY_ORDER = Object.keys(TOPIC_CATEGORY_LABELS) as StudioTopicCategory[];

export function TopicEntryWorkspace(props: TopicEntryWorkspaceProps) {
  const mode = props.initialMode ?? "trend";
  const [category, setCategory] = useState<StudioTopicCategory | "all">("all");
  const [platform, setPlatform] = useState("all");
  const [deskView, setDeskView] = useState<TrendDeskView>("all");
  const [selectedId, setSelectedId] = useState(props.initialSelectedId ?? "");
  const [verificationCandidate, setVerificationCandidate] = useState<StudioCandidateInboxItem>();

  const modeItems = useMemo(() => (props.inbox?.items ?? []).filter((item) => item.origin === mode), [mode, props.inbox]);
  const seriesItems = mode === "series" && props.selectedSeriesId
    ? modeItems.filter((item) => item.seriesId === props.selectedSeriesId)
    : modeItems;
  const deskItems = seriesItems.filter((item) => matchesDeskView(item, deskView));
  const categoryCounts = countCategories(deskItems);
  const verdictCounts = countVerdicts(seriesItems);
  const platforms = [...new Set(seriesItems.map((item) => item.platform))];
  const sourceShortCount = seriesItems.filter((item) => item.verification.status === "blocked").length;
  // "总编不建议"必须是总编说的：规则保底候选的 skip 是本地规则算出来的，
  // 把它们算进这一格，会让从未评估过的候选显示成"总编不建议"。
  const notRecommendedCount = seriesItems.filter((item) => item.editorialDecision.verdict === "skip" && item.editorialDecision.pendingEditorReview !== true).length;
  // 规则保底（未经总编评估）与来源不足是独立维度：来源不足的候选同样可能是"待总编评估"。
  const ruleBaselineCount = seriesItems.filter((item) => item.editorialDecision.pendingEditorReview === true).length;
  // "总编这轮没给建议"必须连带原因一起说，否则用户只看到一堆规则候选，无从判断是配额、超时还是输出被合同拦下。
  const editorFailureReason = ruleBaselineCount > 0
    ? seriesItems.find((item) => item.generationFallback)?.generationFallback?.reason
    : undefined;
  // 总编这轮真跑了、但独立复核没判通过时，审计的建议必须跟着候选一起出现。
  const auditAdvice = mode === "trend" ? topicAuditAdvice(props.inbox?.topicGeneration) : undefined;
  const clearCount = seriesItems.filter(isClearForProduction).length;
  const visibleItems = deskItems
    .filter((item) => category === "all" || item.category === category)
    .filter((item) => platform === "all" || item.platform === platform)
    .sort((left, right) => candidateScoreValue(right) - candidateScoreValue(left) || left.title.localeCompare(right.title, "zh-CN"));
  const hasActiveFilters = category !== "all" || platform !== "all" || deskView !== "all";
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const selectedSeries = props.series.find((item) => item.id === props.selectedSeriesId) ?? props.series[0];
  const candidateMode = mode === "trend" || mode === "series" ? mode : "trend";
  const modeLoading = props.loading[candidateMode] === true;
  // 读取已返回但生成仍在后台推进：这期间必须继续显示"正在生成"，不能落到空结果文案。
  const modeGenerating = candidateMode === "trend" && props.trendRefreshing === true;
  const modeBusy = modeLoading || modeGenerating;
  const modeError = props.error?.[candidateMode];
  const sourceBlockedOpportunities = props.sourceBlockedOpportunities ?? [];

  async function adopt(item: StudioCandidateInboxItem) {
    if (item.verification.status === "review_required") {
      setVerificationCandidate(item);
      return;
    }
    await props.onAdopt(item);
  }

  useEffect(() => {
    setCategory("all");
    setPlatform("all");
    setDeskView("all");
    setSelectedId(props.initialSelectedId ?? "");
  }, [mode, props.initialSelectedId, props.selectedSeriesId]);

  useEffect(() => {
    if (deskView !== "source_short" || sourceShortCount > 0) return;
    setCategory("all");
    setPlatform("all");
    setDeskView("all");
  }, [deskView, sourceShortCount]);

  return (
    <section className="topic-entry-workspace" data-tour="topic-inbox" aria-label={mode === "trend" ? "热点选题" : mode === "series" ? "系列选题" : "自定义创作"}>
      {mode === "custom" ? <CustomEntry onManual={props.onManual} onImport={props.onImport} /> : (
        <div className="candidate-inbox">
          <header className="candidate-inbox-heading">
            <div>
              <p className="eyebrow">{mode === "trend" ? "实时信号" : "系列策划"}</p>
              <h2>{mode === "trend" ? "热点候选收件箱" : "系列选题台"}</h2>
              <p>{mode === "trend"
                ? ruleBaselineCount > 0 && ruleBaselineCount >= modeItems.length
                  ? "本轮热点由本地规则保底生成，还没有经过选题总编转译；先筛选，再核验证据。"
                  : "热点信号已经过选题总编转译；先筛选，再核验证据。"
                : "每个系列保留长期承诺，策划器只生成接下来的可制作集数。"}</p>
            </div>
            {mode === "trend" ? (
              <div className="trend-refresh-status" aria-label="热点更新状态">
                <span><i aria-hidden="true" />{modeBusy ? (modeItems.length > 0 ? "正在更新，当前仍可使用" : "正在生成今日提案") : "每日缓存"}</span>
                <small>{trendStatusText(props.trendMeta)}</small>
                {/* 判据必须是 modeBusy 而不是 modeLoading：读取返回后这一轮生成仍在后台推进，
                    此时再点一次不会"插队"，只会排到 broker 的唯一队列里等上几分钟才开始。 */}
                <button className="icon-button" type="button" aria-label="立即刷新热点" title="立即刷新热点" disabled={modeBusy || props.trendRefreshPending === true} onClick={props.onRefreshTrends}><RefreshCw aria-hidden="true" size={16} /></button>
              </div>
            ) : mode === "series" ? (
              <div className="series-controls">
                {props.series.length > 0 ? <label><span>当前系列</span><select aria-label="选择系列" value={props.selectedSeriesId ?? ""} onChange={(event) => props.onSelectSeries(event.target.value)}>{props.series.map((item) => <option key={item.id} value={item.id}>{item.name} · 下一集 {String(item.nextEpisodeNumber).padStart(2, "0")}</option>)}</select></label> : null}
                <button className="button button-secondary" type="button" onClick={props.onCreateSeries}><Plus aria-hidden="true" size={16} />新建系列</button>
              </div>
            ) : null}
          </header>

          {modeError && modeItems.length > 0 ? <div className="candidate-cache-warning" role="status"><AlertCircle aria-hidden="true" size={17} /><span>本次更新失败，继续展示上次缓存：{modeError}</span></div> : null}
          {auditAdvice ? <div className="candidate-audit-advice" role="note"><ShieldAlert aria-hidden="true" size={17} /><span>{auditAdvice}</span></div> : null}
          {modeError && modeItems.length === 0 ? (
            <div className="candidate-error" role="alert"><AlertCircle aria-hidden="true" size={20} /><div><strong>{mode === "trend" ? "热点候选暂时不可用" : "系列候选暂时不可用"}</strong><span>{modeError}</span></div><button className="button button-secondary" type="button" onClick={() => props.onRetry(candidateMode)}><RefreshCw aria-hidden="true" size={15} />重试</button></div>
          ) : modeBusy && modeItems.length === 0 ? (
            <div className="candidate-loading"><RadioTower aria-hidden="true" size={24} /><div><h2>{mode === "trend" ? "正在生成今日提案" : "正在读取系列选题"}</h2><p>{mode === "trend" ? "AI 选题总编正在分析热点并形成提案，通常需要几分钟；页面会自动更新，系列和自定义创作仍可立即使用。" : "系列策划通常几秒内就会出现。"}</p></div>{mode === "trend" ? <button className="button button-secondary" type="button" onClick={props.onManual}>录入自己的选题</button> : null}</div>
          ) : mode === "series" && props.series.length === 0 ? (
            <div className="series-empty"><LibraryBig aria-hidden="true" size={28} /><div><h3>先创建一个可持续的系列</h3><p>定义受众、栏目承诺和内容支柱后，系统会给出连续编号的下一集候选。</p></div><button className="button button-primary" type="button" onClick={props.onCreateSeries}>创建第一个系列</button></div>
          ) : mode === "trend" && clearCount === 0 && deskView === "all" ? (
            <TrendRecoveryPanel
              evaluatedCount={modeItems.length}
              notRecommendedCount={notRecommendedCount}
              pendingEditorCount={ruleBaselineCount}
              {...(editorFailureReason !== undefined ? { editorFailureReason } : {})}
              sourceShortCount={sourceShortCount}
              historicalSourceBlockedCount={sourceBlockedOpportunities.length}
              refreshing={modeBusy}
              refreshPending={props.trendRefreshPending === true}
              onRefresh={props.onRefreshTrends}
              onManual={props.onManual}
              onShowNotRecommended={() => setDeskView("not_recommended")}
              onShowSourceShort={() => setDeskView("source_short")}
              onShowSourceBlocked={() => {
                const firstSourceBlocked = sourceBlockedOpportunities[0];
                if (firstSourceBlocked) props.onFocusSourceBlocked?.(firstSourceBlocked.id);
              }}
            />
          ) : mode === "series" && selectedSeries ? (
            <SeriesRoadmap
              series={selectedSeries}
              candidates={seriesItems}
              historicalRuns={props.historicalRuns}
              selectedId={selectedId}
              {...(props.adoptingId ? { adoptingId: props.adoptingId } : {})}
              onSelect={setSelectedId}
              onAdopt={adopt}
              onUpdate={props.onUpdateSeriesEpisode}
              onLinkLegacyRun={props.onLinkLegacyRun}
              onRescan={props.onRescanSeries}
              onViewProductionRecords={props.onViewProductionRecords}
              {...(props.onSupplementSources ? { onSupplementSources: props.onSupplementSources } : {})}
              {...(props.seriesAuditReady === undefined ? {} : { seriesAuditReady: props.seriesAuditReady })}
            />
          ) : (
            <>
              <div className="candidate-filters" aria-label="候选筛选">
                <div className="verdict-filter" aria-label="生产建议">
                  <button type="button" className={deskView === "all" ? "is-active" : ""} onClick={() => setDeskView("all")}>全部 <span>{seriesItems.length}</span></button>
                  {(["produce_video", "produce_image_story"] as const).map((item) => (
                    <button key={item} type="button" className={deskView === item ? "is-active" : ""} disabled={!verdictCounts[item]} onClick={() => setDeskView(item)}>{editorialVerdictLabel(item)} <span>{verdictCounts[item] ?? 0}</span></button>
                  ))}
                  <button type="button" className={deskView === "not_recommended" ? "is-active" : ""} disabled={!notRecommendedCount} onClick={() => setDeskView("not_recommended")}>总编不建议 <span>{notRecommendedCount}</span></button>
                  <button type="button" className={deskView === "pending_editor" ? "is-active" : ""} disabled={!ruleBaselineCount} onClick={() => setDeskView("pending_editor")}>待总编评估 <span>{ruleBaselineCount}</span></button>
                  <button type="button" className={deskView === "source_short" ? "is-active" : ""} disabled={!sourceShortCount} onClick={() => setDeskView("source_short")}>来源不足 <span>{sourceShortCount}</span></button>
                </div>
                <div className="category-filter" aria-label="内容分类">
                  <button type="button" className={category === "all" ? "is-active" : ""} onClick={() => setCategory("all")}>全部 <span>{deskItems.length}</span></button>
                  {(mode === "trend" ? CATEGORY_ORDER : CATEGORY_ORDER.filter((item) => categoryCounts[item])).map((item) => (
                    <button key={item} type="button" className={category === item ? "is-active" : ""} disabled={!categoryCounts[item]} onClick={() => setCategory(item)}>{TOPIC_CATEGORY_LABELS[item]} <span>{categoryCounts[item] ?? 0}</span></button>
                  ))}
                </div>
                <label className="platform-filter"><span>热点来源平台</span><select aria-label="热点来源平台" value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="all">全部来源平台</option>{platforms.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></label>
                {hasActiveFilters ? <button className="candidate-clear-filters" type="button" onClick={() => { setCategory("all"); setPlatform("all"); setDeskView("all"); }}>清除筛选</button> : null}
              </div>
              {visibleItems.length > 0 ? (
                <div className="candidate-inbox-body">
                  <div className="candidate-list" aria-label="候选提案列表">
                    {visibleItems.map((item, index) => (
                      <button key={item.id} type="button" className={`candidate-row${selected?.id === item.id ? " is-active" : ""}`} aria-label={`查看${item.title}`} onClick={() => setSelectedId(item.id)}>
                        <span className="candidate-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="candidate-row-copy"><small>{TOPIC_CATEGORY_LABELS[item.category]} · {platformLabel(item.platform)} · {candidateStatusLabel(item)}</small><strong>{item.title}</strong><span>{item.hook}</span></span>
                        <span className="candidate-score">{item.verification.status === "blocked"
                          ? <><small>内容潜力</small>{Math.round(item.score.final)}</>
                          : item.editorialDecision.pendingEditorReview
                            ? <small>待总编评估</small>
                            : <><small>总编评分</small>{Math.round(item.editorialDecision.score)}</>}</span>
                      </button>
                    ))}
                  </div>
                  {selected ? <CandidateDetail item={selected} adopting={props.adoptingId === selected.id} disabled={props.adoptingId !== undefined} onAdopt={() => adopt(selected)} {...(props.onSupplementSources ? { onSupplementSources: props.onSupplementSources } : {})} /> : null}
                </div>
              ) : <div className="filtered-empty"><BookOpenText aria-hidden="true" size={22} /><span>当前筛选下没有候选。</span>{hasActiveFilters ? <button className="button button-secondary" type="button" onClick={() => { setCategory("all"); setPlatform("all"); setDeskView("all"); }}>清除筛选</button> : null}</div>}
            </>
          )}
        </div>
      )}
      <CandidateVerificationDialog
        {...(verificationCandidate ? { candidate: verificationCandidate } : {})}
        pending={verificationCandidate?.id === props.adoptingId}
        onClose={() => setVerificationCandidate(undefined)}
        onConfirm={async () => {
          if (!verificationCandidate) return;
          await props.onAdopt(verificationCandidate, true);
          setVerificationCandidate(undefined);
        }}
      />
    </section>
  );
}

function SeriesRoadmap({
  series,
  candidates,
  historicalRuns,
  selectedId,
  adoptingId,
  onSelect,
  onAdopt,
  onUpdate,
  onLinkLegacyRun,
  onRescan,
  onViewProductionRecords,
  onSupplementSources,
  seriesAuditReady,
}: {
  series: StudioSeries;
  candidates: StudioCandidateInboxItem[];
  historicalRuns: StudioRunSummary[];
  selectedId: string;
  adoptingId?: string;
  onSelect: (id: string) => void;
  onAdopt: (candidate: StudioCandidateInboxItem) => Promise<void>;
  onUpdate: (seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput) => Promise<void>;
  onLinkLegacyRun: (seriesId: string, episodeNumber: number, runId: string) => Promise<void>;
  onRescan: () => Promise<void>;
  onViewProductionRecords: () => void;
  onSupplementSources?: (candidate: StudioCandidateInboxItem) => void;
  seriesAuditReady?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [legacyRunId, setLegacyRunId] = useState("");
  const [showAllLegacyRuns, setShowAllLegacyRuns] = useState(false);
  const [legacyPending, setLegacyPending] = useState(false);
  const [legacyError, setLegacyError] = useState<string>();
  const detailRef = useRef<HTMLElement>(null);
  const episodes = [...series.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
  const selectedEpisode = episodes.find((episode) => episode.id === selectedId) ?? episodes[0];
  const selectedCandidate = selectedEpisode
    ? candidates.find((candidate) => candidate.id === selectedEpisode.id)
    : undefined;
  const blockedBy = selectedCandidate?.seriesSequence?.blockedByEpisodeNumber;
  // 来源不足只是提醒，不再参与解锁判断；集序与开拍审计由服务端强制，客户端如实镜像。
  const sourceBlocked = selectedEpisode?.status === "planned"
    && selectedCandidate?.verification.status === "blocked";
  const mayAdopt = selectedEpisode?.status === "planned"
    && selectedCandidate?.seriesSequence?.status === "ready";
  const needsGreenlight = selectedEpisode?.planning.auditStatus !== "passed";
  const auditAvailabilityPending = needsGreenlight && seriesAuditReady === undefined;
  const auditUnavailable = needsGreenlight && seriesAuditReady === false;
  const unsupportedProductionPlatform = !isProductionPlatform(series.platform);
  const linkedRunIds = new Set(series.episodes.flatMap((episode) => episode.runId ? [episode.runId] : []));
  const allLegacyCandidates = historicalRuns.filter((run) => run.status === "succeeded" && !linkedRunIds.has(run.id));
  const likelyLegacyCandidates = selectedEpisode
    ? allLegacyCandidates.filter((run) => likelyHistoricalMatch(run, series, selectedEpisode))
    : [];
  const legacyCandidates = showAllLegacyRuns ? allLegacyCandidates : likelyLegacyCandidates;

  function selectEpisode(episodeId: string) {
    onSelect(episodeId);
    if (typeof window === "undefined" || !window.matchMedia?.("(max-width: 700px)").matches) return;
    window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function linkLegacyRun() {
    if (!selectedEpisode || !legacyRunId) return;
    setLegacyPending(true);
    setLegacyError(undefined);
    try {
      await onLinkLegacyRun(series.id, selectedEpisode.episodeNumber, legacyRunId);
      setLegacyRunId("");
    } catch (error) {
      setLegacyError(error instanceof Error ? error.message : String(error));
    } finally {
      setLegacyPending(false);
    }
  }

  return (
    <div className="series-roadmap">
      <section className="series-season-summary" aria-label="本季策划摘要">
          <div><span>第 {series.currentSeason.number} 季 · {seasonPlanLabel(series)}</span><strong>{series.currentSeason.title}</strong><p>{series.currentSeason.arc}</p></div>
        <dl>
          <div><dt>栏目承诺</dt><dd>{series.premise}</dd></div>
          <div><dt>已定版内容</dt><dd>第 {series.canon.revision} 版 · {series.canon.facts.length} 条后续可依赖事实</dd></div>
          <div><dt>固定规则</dt><dd>{series.bible.rules.slice(0, 2).join("；")}</dd></div>
        </dl>
      </section>

      {unsupportedProductionPlatform ? (
        <p className="series-lock-note" role="alert"><ShieldAlert aria-hidden="true" size={15} />这个历史系列使用的首发平台已不再支持新制作。请点击右上角“新建系列”，选择抖音、小红书或哔哩哔哩后迁移内容；原路线图仍可查看。</p>
      ) : null}

      <div className="series-roadmap-body">
        <ol className="series-episode-list" aria-label="本季单集路线图">
          {episodes.map((episode) => {
            const candidate = candidates.find((item) => item.id === episode.id);
            const locked = candidate?.seriesSequence?.status === "blocked";
            return (
              <li key={episode.id}>
                <button type="button" className={`${selectedEpisode?.id === episode.id ? "is-active" : ""}${locked ? " is-locked" : ""}`} onClick={() => selectEpisode(episode.id)}>
                  <span className="series-episode-index">E{String(episode.episodeNumber).padStart(2, "0")}</span>
                  <span className="series-episode-copy"><small>{episode.pillar}</small><strong>{seriesEpisodeTitle(episode)}</strong><span>{episode.viewerPromise}</span></span>
                  <span className={`series-episode-status is-${episode.status}`}>{locked ? <LockKeyhole aria-hidden="true" size={13} /> : episode.status === "ready" || episode.status === "published" ? <CheckCircle2 aria-hidden="true" size={13} /> : <Clapperboard aria-hidden="true" size={13} />}{seriesEpisodeStatusLabel(episode, locked)}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {selectedEpisode ? (
          <article ref={detailRef} className="series-episode-detail">
            <header><span>第 {selectedEpisode.episodeNumber} 集 · {selectedEpisode.arc}</span><strong>{seriesEpisodeStatusLabel(selectedEpisode, Boolean(blockedBy))}</strong></header>
            <h3>{seriesEpisodeTitle(selectedEpisode)}</h3>
            <p className="series-viewer-promise">{selectedEpisode.viewerPromise}</p>
            <div className="series-continuity-grid">
              <section><span>前集定版交接</span><p>{(selectedEpisode.continuity.inheritedFromPrevious ?? []).join("；") || "暂无前集定版交接。"}</p></section>
              <section><span>本集承接要求</span><p>{selectedEpisode.continuity.fromPrevious.join("；") || "没有额外创作约束。"}</p></section>
              <section><span>本集兑现</span><p>{seriesEpisodePayoff(selectedEpisode)}</p></section>
              <section><span>留给下一集</span><p>{selectedEpisode.continuity.toNext.join("；")}</p></section>
            </div>
            <section className="series-agent-route" aria-label="本集智能制作与质量复核流程">
              <div><Sparkles aria-hidden="true" size={16} /><span><strong>路线图策划记录</strong><small>{creatorFacingTechnicalText(selectedEpisode.planning.role)} · {creatorFacingTechnicalText(selectedEpisode.planning.auditRole)}</small></span></div>
              <dl>
                <div><dt>生成</dt><dd>{planningSourceLabel(selectedEpisode.planning)}</dd></div>
                <div><dt>复核</dt><dd>{planningAuditLabel(selectedEpisode.planning)}</dd></div>
                <div><dt>推理</dt><dd>{planningReasoningLabel(selectedEpisode.planning)}</dd></div>
              </dl>
              {selectedEpisode.planning.auditSummary ? <p><strong>复核结论：</strong>{creatorFacingTechnicalText(selectedEpisode.planning.auditSummary)}{selectedEpisode.planning.auditScore !== undefined ? `（${selectedEpisode.planning.auditScore} 分）` : ""}</p> : null}
              {selectedEpisode.planning.fallbackReason ? <p>{creatorFacingTechnicalText(selectedEpisode.planning.fallbackReason)}</p> : null}
            </section>
            {auditUnavailable ? <p className="series-lock-note"><ShieldAlert aria-hidden="true" size={15} />开拍前独立质量复核尚未就绪，仍然可以进入制作；配置系列主理人后可拿到复核建议。<Link to="/resources#production-roles">去配置系列主理人</Link></p> : null}
            {blockedBy ? <p className="series-lock-note"><LockKeyhole aria-hidden="true" size={15} />第 {blockedBy} 集尚未定版；完成审片后，本集会自动继承最新已确认内容再解锁。</p> : null}
            {sourceBlocked && selectedCandidate ? <p className="series-lock-note" role="note"><ShieldAlert aria-hidden="true" size={15} />来源提醒（不影响你开工）：{selectedCandidate.verification.reasons[0]}</p> : null}
            {selectedEpisode.status === "planned" ? (
              <div className="series-episode-actions">
                <button className="button button-secondary" type="button" disabled={adoptingId !== undefined} onClick={() => setEditing(true)}><PencilLine aria-hidden="true" size={16} />编辑路线图</button>
                <button className="button button-primary" type="button" disabled={!mayAdopt || adoptingId !== undefined || unsupportedProductionPlatform} onClick={() => selectedCandidate && void onAdopt(selectedCandidate)}>{adoptingId === selectedEpisode.id ? "正在复核..." : unsupportedProductionPlatform ? "请先迁移到支持的平台" : blockedBy ? `完成第 ${blockedBy} 集后解锁` : auditAvailabilityPending ? "正在确认复核能力" : auditUnavailable ? "复核未就绪，仍然进入制作" : needsGreenlight ? "先复核，再进入制作" : sourceBlocked ? "仍然进入制作" : "采用本集并进入制作"}<ArrowRight aria-hidden="true" size={16} /></button>
                {sourceBlocked && selectedCandidate && onSupplementSources ? (
                  <button className="button button-secondary" type="button" disabled={adoptingId !== undefined} onClick={() => onSupplementSources(selectedCandidate)}><ShieldAlert aria-hidden="true" size={16} />补充原始来源</button>
                ) : null}
              </div>
            ) : isMigrationPendingEpisode(selectedEpisode) ? (
              <section className="series-legacy-recovery" aria-label="恢复历史单集">
                <p>{seriesEpisodeProgressNote(selectedEpisode)}</p>
                <label><span>选择对应的已完成成片</span><select value={legacyRunId} onChange={(event) => setLegacyRunId(event.target.value)}><option value="">请选择历史制作记录</option>{legacyCandidates.map((run) => <option key={run.id} value={run.id}>{run.title} · {new Date(run.startedAt).toLocaleDateString("zh-CN")}</option>)}</select></label>
                <div><button className="button button-secondary" type="button" disabled={legacyPending} onClick={() => void onRescan()}><RefreshCw aria-hidden="true" size={15} />重新扫描</button><button className="button button-ghost" type="button" onClick={onViewProductionRecords}>查看制作记录</button><button className="button button-primary" type="button" disabled={!legacyRunId || legacyPending} onClick={() => void linkLegacyRun()}>{legacyPending ? "正在关联..." : "确认关联并解锁"}</button></div>
                {!showAllLegacyRuns && likelyLegacyCandidates.length === 0 && allLegacyCandidates.length > 0 ? <button className="series-legacy-show-all" type="button" onClick={() => setShowAllLegacyRuns(true)}>没有找到高可信匹配，显示全部已完成记录</button> : null}
                {showAllLegacyRuns ? <small>现在显示全部已完成记录。请只选择你确认属于这一集的成片，系统不会根据标题自行猜测。</small> : null}
                {allLegacyCandidates.length === 0 ? <small>当前没有可关联的已完成成片。可以先查看制作记录，确认旧任务是否仍在。</small> : null}
                {legacyError ? <small className="is-error" role="alert">{legacyError}</small> : null}
              </section>
            ) : <p className="series-progress-note">{seriesEpisodeProgressNote(selectedEpisode)}</p>}
            <SeriesEpisodeDialog
              key={`${selectedEpisode.id}-${series.revision}`}
              open={editing}
              series={series}
              episode={selectedEpisode}
              onClose={() => setEditing(false)}
              onSubmit={async (input) => {
                await onUpdate(series.id, selectedEpisode.episodeNumber, input);
                setEditing(false);
              }}
            />
          </article>
        ) : null}
      </div>
    </div>
  );
}

function planningAuditLabel(planning: StudioSeries["episodes"][number]["planning"]): string {
  if (planning.auditStatus === "passed") return `独立复核 ${planning.auditIterations}/3 轮通过`;
  // 不说"通过"：轮次跑完仍没判 pass 时审计明确要求过修复，只是它无权否决，交给你裁决。
  if (planning.auditStatus === "awaiting_user") return `独立复核 ${planning.auditIterations}/3 轮未通过 · 建议已附上`;
  if (planning.auditStatus === "stale") return "已定版内容更新 · 采用时先重审";
  if (planning.auditStatus === "human_override") return "人工修订 · 待后续复核";
  return "规则保底";
}

function planningSourceLabel(planning: StudioSeries["episodes"][number]["planning"]): string {
  if (planning.source === "human") return "人工 / 手工编辑";
  if (planning.source === "rules") return "规则策划 / 确定性保底";
  return "AI 系列总编";
}

function planningReasoningLabel(planning: StudioSeries["episodes"][number]["planning"]): string {
  if (planning.source === "human") return "人工决定";
  if (planning.source === "rules") return "固定规则";
  return reasoningEffortLabel(planning.reasoningEffort);
}

function seriesEpisodeStatusLabel(episode: StudioSeries["episodes"][number], locked = false): string {
  if (locked) return "等待前集";
  if (isMigrationPendingEpisode(episode)) return "待关联旧记录";
  return {
    planned: "待采用",
    selected: "已采用",
    in_production: "制作中",
    ready: "已定版",
    published: "已发布",
    paused: "已暂停",
  }[episode.status];
}

function seriesEpisodeProgressNote(episode: StudioSeries["episodes"][number]): string {
  if (isMigrationPendingEpisode(episode)) return "这是迁移前采用的单集。你可以重新扫描，或人工选择对应的旧成片；确认前系统不会重复生产。";
  return {
    planned: "本集仍在路线图中。",
    selected: "本集已进入制作区，可以继续确认配方并启动生产。",
    in_production: "本集正在制作；需要语义判断的内容会接受独立质量复核。",
    ready: "本集已通过审片并成为后续可依赖的定版内容，可以推进下一集。",
    published: "本集已经完成外部分发。",
    paused: "本集已经暂停，不会继续进入生产。",
  }[episode.status];
}

function seasonPlanLabel(series: StudioSeries): string {
  const cadence = {
    weekly: "每周 1 集",
    biweekly: "每两周 1 集",
    monthly: "每月 1 集",
    flexible: "灵活更新",
  }[series.currentSeason.releaseCadence ?? "weekly"];
  const target = series.currentSeason.targetEpisodeCount ?? 12;
  const completed = series.episodes.filter((episode) => episode.status === "ready" || episode.status === "published").length;
  return `${series.currentSeason.planningPeriod ?? "本季"} · ${cadence} · ${completed}/${target} 已定版`;
}

function isMigrationPendingEpisode(episode: StudioSeries["episodes"][number]): boolean {
  return episode.status === "paused" && !episode.runId && episode.planning.providerId === "series-store-migration-v2";
}

function isProductionPlatform(platform: string): boolean {
  return platform === "douyin" || platform === "xiaohongshu" || platform === "bilibili";
}

function seriesEpisodeTitle(episode: StudioSeries["episodes"][number]): string {
  return isMigrationPendingEpisode(episode)
    ? `第 ${episode.episodeNumber} 集 · 历史成片待恢复`
    : episode.title;
}

function seriesEpisodePayoff(episode: StudioSeries["episodes"][number]): string {
  return isMigrationPendingEpisode(episode)
    ? "确认对应的历史成片后，恢复本集定版状态并解锁下一集。"
    : episode.payoff;
}

function likelyHistoricalMatch(
  run: StudioRunSummary,
  series: StudioSeries,
  episode: StudioSeries["episodes"][number],
): boolean {
  if (run.opportunityId && [episode.id, episode.opportunityId].includes(run.opportunityId)) return true;
  const normalizedRunTitle = normalizeMatchText(run.title);
  const normalizedSeriesName = normalizeMatchText(series.name);
  const normalizedEpisodeTitle = normalizeMatchText(episode.title.replace(/历史已采用单集/g, ""));
  return (normalizedSeriesName.length >= 4 && normalizedRunTitle.includes(normalizedSeriesName))
    || (normalizedEpisodeTitle.length >= 6 && normalizedRunTitle.includes(normalizedEpisodeTitle));
}

function normalizeMatchText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function CandidateDetail({ item, adopting, disabled, onAdopt, onSupplementSources }: { item: StudioCandidateInboxItem; adopting: boolean; disabled: boolean; onAdopt: () => Promise<void>; onSupplementSources?: (candidate: StudioCandidateInboxItem) => void }) {
  const adviceSkip = item.editorialDecision.verdict === "skip";
  const sourceShort = item.verification.status === "blocked";
  // 规则保底候选未经总编评估：内容潜力继续作为参考分展示，不把“尚未评估”投影成“总编评分 0”。
  const pendingEditor = item.editorialDecision.pendingEditorReview === true;
  // 系列与热点共用同一个“补充原始来源”恢复动作；补齐后由服务端重算来源与建议。
  const canSupplementSources = sourceShort && onSupplementSources !== undefined;
  // 内容潜力（信号强度与制作可行性）与建议分开呈现：来源不足不等于选题质量为零。
  const scoreLabel = sourceShort || pendingEditor ? "内容潜力" : "总编评分";
  const scoreValue = Math.round(candidateScoreValue(item));
  const verdictLabel = editorialVerdictLabel(item.editorialDecision.verdict);
  // 提醒只标注、不拦人：每条候选都能采用，这里把"为什么建议先别做"说清楚。
  const advice = sourceShort
    ? `来源不足：${item.verification.reasons[0] ?? "有效来源还没达到当前标准。"}`
    // 规则保底候选的 skip 是本地规则算出来的，不是总编的判断：
    // 写成"总编不建议生产"等于替总编表态，用户会以为已经有人看过这条。
    : pendingEditor
      ? `总编本轮没有评估这条：${item.editorialDecision.reasons[0] ?? "未经选题总编判断。"}`
      : adviceSkip
        ? `总编不建议生产：${item.editorialDecision.reasons[0] ?? "未给出理由。"}`
        : undefined;
  return (
    <article className="candidate-detail" aria-labelledby="candidate-detail-title">
      <header><span>{item.origin === "series" ? `${item.seriesName} · 第 ${item.episodeNumber} 集` : `${TOPIC_CATEGORY_LABELS[item.category]}观察`}</span><strong aria-label={`${scoreLabel} ${scoreValue} 分`}><small>{scoreLabel}</small>{scoreValue}</strong></header>
      <h3 id="candidate-detail-title">{item.title}</h3>
      <blockquote>{item.hook}</blockquote>
      <p>{item.rationale}</p>
      {item.visualProof ? <p className="candidate-visual-proof"><small>可见画面</small>{item.visualProof}</p> : null}
      <div className={`editorial-decision is-${item.editorialDecision.verdict}`}>
        <span>总编建议</span>
        <strong>{pendingEditor ? "尚未评估 · 当前只有规则保底" : `${verdictLabel} · ${item.editorialDecision.score} 分`}</strong>
        <p>{item.editorialDecision.reasons[0]}</p>
        <small>{item.editorialDecision.guardrails[0]}</small>
      </div>
      <div className="candidate-meta">
        <span><Clock3 aria-hidden="true" size={13} />{item.freshness === "live" ? "实时" : item.freshness === "today" ? "今日" : "常青"}</span>
        <span className={item.risk === "high" ? "is-risk" : ""}><ShieldAlert aria-hidden="true" size={13} />{item.risk === "high" ? "高风险核验" : item.risk === "review" ? "需要核验" : "常规核验"}</span>
        <span title={proposalSourceLabel(item.providerId)}><Sparkles aria-hidden="true" size={13} />{proposalSourceLabel(item.providerId)}</span>
      </div>
      <details className="candidate-score-explainer">
        <summary>{scoreLabel}依据 · {scoreValue} 分</summary>
        <div>
          {item.score.audienceDemand === undefined ? null : <span>观众需求 {Math.round(item.score.audienceDemand)}</span>}
          <span>受众 {Math.round(item.score.audienceReach)}</span>
          <span>画面 {Math.round(item.score.visualFeasibility)}</span>
          <span>成本 {Math.round(item.score.productionCostEfficiency)}</span>
          <span>新鲜 {Math.round(item.score.novelty)}</span>
          <span>系列 {Math.round(item.score.seriesPotential)}</span>
          <span>风险 {Math.round(item.score.complianceRisk)}</span>
        </div>
        <p>{sourceShort
          ? "内容潜力分只反映选题机会与制作可行性；来源不足只是提醒，是否开工由你决定。证据强度表示当前信号热度或排名，不等同于事实可信度。"
          : "总分以观众需求为主：它回答“具体是谁、在什么场景下会因为什么点开”，由选题总编单独判断，热度不参与。风险分越低越安全。证据强度表示当前信号热度或排名，不等同于事实可信度。"}</p>
      </details>
      <div className="candidate-evidence"><span>来源线索</span>{item.evidence.slice(0, 2).map((evidence, index) => evidence.evidenceUrl ? <a key={`${item.id}-${index}`} href={evidence.evidenceUrl} target="_blank" rel="noreferrer"><strong>{isManualEvidence(evidence) ? "用户补充来源" : evidence.keyword}</strong><small>{isManualEvidence(evidence) ? "用户补充 · 不作为热度信号" : `${platformLabel(evidence.platform)} · 榜单热度或排名信号 ${evidence.strength}`}</small></a> : <div key={`${item.id}-${index}`}><strong>{evidence.keyword}</strong><small>{platformLabel(evidence.platform)} · 榜单热度或排名信号 {evidence.strength}</small></div>)}</div>
      {item.origin === "trend" && item.articleSources?.length ? <details className="candidate-score-explainer candidate-article-reading">
        <summary>原文阅读与事实依据</summary>
        <div>{item.articleSources.map((source, index) => <span key={source.sourceId}>{index + 1}. {articleReadStatusLabel(source.readStatus)} · {source.pageTitle || source.finalUrl}{source.readStatus === "failed" ? "。读取服务未能完成，不代表文章没有事实依据。" : null}</span>)}</div>
        {item.articleFacts?.map((fact, index) => {
          const origin = factOriginLabel(item, fact);
          return <p key={`${fact.sourceId}-${index}`}>已读事实：{fact.statement}{origin ? <small>（{origin}）</small> : null}</p>;
        })}
        {item.articleUncertainties?.map((uncertainty, index) => <p key={index}>仍待核验：{uncertainty}</p>)}
        {!item.articleFacts?.length ? <p>当前没有可作为正文事实引用的内容；标题和热度只用于选题线索。</p> : null}
      </details> : null}
      {advice ? <p className="candidate-advisory" role="note"><ShieldAlert aria-hidden="true" size={15} />{advice}（只是建议，不影响你采用）</p> : null}
      <div className={`candidate-verification is-${item.verification.status}`}><ShieldAlert aria-hidden="true" size={15} /><span><strong>{sourceShort
        ? "来源不足 · 仍可由你决定开工"
        : item.verification.status === "review_required"
          ? "建议采用前先核验"
          : "来源已达标"}</strong><small>{item.verification.reasons[0]}</small></span><output>{item.evidence.length} 条来源线索 · {item.verification.independentSources} 个有效来源域名（需 {item.verification.requiredSources} 个）</output></div>
      <div className="candidate-actions">
        {canSupplementSources ? (
          <button className="button button-secondary" type="button" aria-label={`补充来源 ${item.title}`} disabled={disabled} onClick={() => onSupplementSources?.(item)}>保存来源并重新评估</button>
        ) : null}
        <button className="button button-primary candidate-adopt" data-tour="candidate-adopt" type="button" aria-label={`采用候选 ${item.title}`} disabled={disabled} onClick={() => void onAdopt()}>{adopting ? "正在采用..." : advice ? "仍然采用" : item.verification.status === "review_required" ? "核验后采用" : "采用到制作区"}<ArrowRight aria-hidden="true" size={16} /></button>
      </div>
    </article>
  );
}

function articleReadStatusLabel(status: NonNullable<StudioCandidateInboxItem["articleSources"]>[number]["readStatus"]): string {
  return {
    read: "已读取正文",
    partial: "已读取部分正文",
    title_only: "仅有标题",
    blocked: "原文受限",
    failed: "原文读取失败",
  }[status];
}

// 事实出处写给读者看：sourceId 和 p1 是内部标识，用户看不动它们。改用上面来源列表的序号
// 加"第几段"——序号能在同一块界面里对回具体文章，段落位置让用户能自己去原文核对。
// 解析不出时不显示括号，也不退回机器 id。
function factOriginLabel(
  item: StudioCandidateInboxItem,
  fact: NonNullable<StudioCandidateInboxItem["articleFacts"]>[number],
): string | undefined {
  const sourceIndex = item.articleSources?.findIndex((source) => source.sourceId === fact.sourceId) ?? -1;
  if (sourceIndex < 0) return undefined;
  const source = item.articleSources![sourceIndex]!;
  const paragraphs = fact.paragraphIds
    .map((id) => source.paragraphs.findIndex((paragraph) => paragraph.id === id))
    .filter((position) => position >= 0)
    .map((position) => `第 ${position + 1} 段`);
  return [`来源 ${sourceIndex + 1}`, ...paragraphs].join(" · ");
}

// 没有闸门，只有"这条候选是否已经明确到可以一路做完"：来源达标且系列顺序没轮到它等。
function isClearForProduction(item: StudioCandidateInboxItem): boolean {
  return item.verification.status !== "blocked"
    && item.seriesSequence?.status !== "blocked";
}

// 审计只出建议，但建议不能只存在于服务端：复核没判通过时把它的原话摆出来，
// 否则用户面对一屏真模型候选，无从知道审计正要修哪里。
function topicAuditAdvice(receipt: StudioTopicGenerationReceipt | undefined): string | undefined {
  if (receipt?.auditStatus !== "awaiting_user") return undefined;
  const advice = (receipt.auditRepairInstructions ?? []).slice(0, 3);
  return [
    "选题总编这轮独立复核未判通过，候选仍然可以直接进入制作；这是复核建议修复的点：",
    receipt.auditSummary,
    ...advice,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

// 排序必须用界面上显示的那个分，否则列表顺序会和行上显示的数字自相矛盾。
function candidateScoreValue(item: StudioCandidateInboxItem): number {
  return item.verification.status === "blocked" || item.editorialDecision.pendingEditorReview
    ? item.score.final
    : item.editorialDecision.score;
}

function matchesDeskView(item: StudioCandidateInboxItem, view: TrendDeskView): boolean {
  if (view === "all") return true;
  if (view === "source_short") return item.verification.status === "blocked";
  if (view === "pending_editor") return item.editorialDecision.pendingEditorReview === true;
  if (view === "not_recommended") return item.editorialDecision.verdict === "skip" && item.editorialDecision.pendingEditorReview !== true;
  return item.editorialDecision.verdict === view;
}

function candidateStatusLabel(item: StudioCandidateInboxItem): string {
  if (item.verification.status === "blocked") return "来源不足";
  return item.editorialDecision.pendingEditorReview ? "待总编评估" : editorialVerdictLabel(item.editorialDecision.verdict);
}

function isManualEvidence(evidence: { source: string; platform: string }): boolean {
  return evidence.source === "manual-supplement" || evidence.platform === "manual";
}

function editorialVerdictLabel(verdict: StudioEditorialVerdict): string {
  return {
    produce_video: "建议做视频",
    produce_image_story: "建议做图文成片",
    skip: "总编不建议",
  }[verdict];
}

function TrendRecoveryPanel({
  evaluatedCount,
  notRecommendedCount,
  pendingEditorCount,
  editorFailureReason,
  sourceShortCount,
  historicalSourceBlockedCount,
  refreshing,
  refreshPending,
  onRefresh,
  onManual,
  onShowNotRecommended,
  onShowSourceShort,
  onShowSourceBlocked,
}: {
  evaluatedCount: number;
  notRecommendedCount: number;
  pendingEditorCount: number;
  /** 本轮总编没能给出建议的原因；有它就说明候选为什么是规则保底，而不是让用户去猜。 */
  editorFailureReason?: string | undefined;
  sourceShortCount: number;
  historicalSourceBlockedCount: number;
  refreshing: boolean;
  refreshPending: boolean;
  onRefresh: () => void;
  onManual: () => void;
  onShowNotRecommended: () => void;
  onShowSourceShort: () => void;
  onShowSourceBlocked: () => void;
}) {
  return (
    <section className="trend-recovery" aria-label="热点恢复路径" data-tour="trend-recovery">
      <div className="trend-recovery-copy">
        <h3>{evaluatedCount === 0 ? "本轮还没有热点候选" : "本轮候选都附带提醒，但都能开工"}</h3>
        <p>{evaluatedCount === 0
          ? "本轮收件箱还没有任何热点候选。"
          : pendingEditorCount >= evaluatedCount
            ? `本轮 ${evaluatedCount} 条热点候选由规则保底生成，还没有经过选题总编评估；它们不会按“总编评分 0”对待。`
            : `选题总编本轮评估了 ${evaluatedCount - pendingEditorCount} 条热点候选，其中 ${notRecommendedCount} 条建议不做。建议只作参考，是否开工由你决定。`}</p>
        {/* 服务端的失败叙述可能通篇都是机器诊断，滤完就空了：那种情况只留断句没有意义，整条不显示。 */}
        {pendingEditorCount > 0 && creatorFacingTechnicalText(editorFailureReason)
          ? <p className="trend-recovery-blocked" role="note">总编本轮没能给出建议的原因：{creatorFacingTechnicalText(editorFailureReason)}</p>
          : null}
        {sourceShortCount > 0 ? <p className="trend-recovery-blocked">本轮另有 {sourceShortCount} 条候选的来源还没达到当前采用标准；补齐来源只是建议，不影响你直接开工。</p> : null}
        {historicalSourceBlockedCount > 0 ? <p className="trend-recovery-blocked">另有 {historicalSourceBlockedCount} 条历史选题来源不足，同样只是提醒。</p> : null}
      </div>
      <div className="trend-recovery-actions">
        <button className="button button-primary" type="button" disabled={refreshing || refreshPending} onClick={onRefresh}><RefreshCw aria-hidden="true" size={16} />重新刷新热点</button>
        <button className="button button-secondary" type="button" onClick={onManual}><PenLine aria-hidden="true" size={16} />录入自己的选题</button>
        <Link className="button button-secondary" to="/topics?mode=series"><LibraryBig aria-hidden="true" size={16} />继续已有系列</Link>
        {sourceShortCount > 0 ? <button className="button button-secondary" type="button" onClick={onShowSourceShort}><ShieldAlert aria-hidden="true" size={16} />查看来源不足的候选（{sourceShortCount} 条）</button> : null}
        {historicalSourceBlockedCount > 0 ? <button className="button button-secondary" type="button" onClick={onShowSourceBlocked}><ShieldAlert aria-hidden="true" size={16} />查看缺来源的选题</button> : null}
      </div>
      {notRecommendedCount > 0 ? <button className="trend-recovery-secondary" type="button" onClick={onShowNotRecommended}>查看总编不建议的（{notRecommendedCount} 条）</button> : null}
    </section>
  );
}

function CustomEntry({ onManual, onImport }: { onManual: () => void; onImport: () => void }) {
  return (
    <div className="custom-entry">
      <div><p className="eyebrow">自主选题</p><h2>自定义创作</h2><p>不追热点也完全成立。把自己的观察、系列外灵感或已经核验的研究直接送进同一套制作流程。</p></div>
      <div className="custom-entry-actions">
        <button className="custom-entry-action" type="button" onClick={onManual}><PenLine aria-hidden="true" size={22} /><span><strong>手动录入</strong><small>填写标题、受众、痛点和开场钩子</small></span><ArrowRight aria-hidden="true" size={17} /></button>
        <button className="custom-entry-action" type="button" onClick={onImport}><FileInput aria-hidden="true" size={22} /><span><strong>导入 JSON</strong><small>接入外部研究或其他 AI 工具的结构化结果</small></span><ArrowRight aria-hidden="true" size={17} /></button>
      </div>
    </div>
  );
}

function countCategories(items: StudioCandidateInboxItem[]): Partial<Record<StudioTopicCategory, number>> {
  return items.reduce<Partial<Record<StudioTopicCategory, number>>>((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
}

function countVerdicts(items: StudioCandidateInboxItem[]): Partial<Record<StudioEditorialVerdict, number>> {
  return items.reduce<Partial<Record<StudioEditorialVerdict, number>>>((counts, item) => {
    counts[item.editorialDecision.verdict] = (counts[item.editorialDecision.verdict] ?? 0) + 1;
    return counts;
  }, {});
}

function trendStatusText(meta: TopicEntryWorkspaceProps["trendMeta"]): string {
  const updatedAt = meta.collectedAt ?? meta.generatedAt;
  const time = updatedAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(updatedAt)) : "--:--";
  const refreshed = meta.refreshedAt
    ? ` · 本页刷新 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(meta.refreshedAt))}`
    : "";
  return `源数据 ${time}${refreshed} · ${meta.platformCount} 个平台 · ${meta.candidateCount} 条`;
}
