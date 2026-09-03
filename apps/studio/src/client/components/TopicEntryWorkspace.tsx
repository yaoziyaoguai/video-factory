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
  StudioRunSummary,
  StudioSeries,
  StudioSeriesEpisodePlanInput,
  StudioTopicCategory,
} from "../../shared/api.js";
import { reasoningEffortLabel } from "../presentation.js";
import { platformLabel, proposalSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";
import { CandidateVerificationDialog } from "./CandidateVerificationDialog.js";
import { SeriesEpisodeDialog } from "./SeriesEpisodeDialog.js";

type EntryMode = StudioCandidateOrigin | "custom";

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
  onCreateSeries: () => void;
  onSelectSeries: (seriesId: string) => void;
  onUpdateSeriesEpisode: (seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput) => Promise<void>;
  onLinkLegacyRun: (seriesId: string, episodeNumber: number, runId: string) => Promise<void>;
  onRescanSeries: () => Promise<void>;
  onViewProductionRecords: () => void;
  onManual: () => void;
  onImport: () => void;
}

const CATEGORY_ORDER = Object.keys(TOPIC_CATEGORY_LABELS) as StudioTopicCategory[];

export function TopicEntryWorkspace(props: TopicEntryWorkspaceProps) {
  const mode = props.initialMode ?? "trend";
  const [category, setCategory] = useState<StudioTopicCategory | "all">("all");
  const [platform, setPlatform] = useState("all");
  const [verdict, setVerdict] = useState<StudioEditorialVerdict | "all">("all");
  const [selectedId, setSelectedId] = useState(props.initialSelectedId ?? "");
  const [verificationCandidate, setVerificationCandidate] = useState<StudioCandidateInboxItem>();

  const modeItems = useMemo(() => (props.inbox?.items ?? []).filter((item) => item.origin === mode), [mode, props.inbox]);
  const seriesItems = mode === "series" && props.selectedSeriesId
    ? modeItems.filter((item) => item.seriesId === props.selectedSeriesId)
    : modeItems;
  const categoryCounts = countCategories(seriesItems);
  const verdictCounts = countVerdicts(seriesItems);
  const platforms = [...new Set(seriesItems.map((item) => item.platform))];
  const visibleItems = seriesItems
    .filter((item) => category === "all" || item.category === category)
    .filter((item) => platform === "all" || item.platform === platform)
    .filter((item) => verdict === "all" || item.editorialDecision.verdict === verdict);
  const hasActiveFilters = category !== "all" || platform !== "all" || verdict !== "all";
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const selectedSeries = props.series.find((item) => item.id === props.selectedSeriesId) ?? props.series[0];
  const candidateMode = mode === "trend" || mode === "series" ? mode : "trend";
  const modeLoading = props.loading[candidateMode] === true;
  const modeError = props.error?.[candidateMode];

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
    setVerdict("all");
    setSelectedId(props.initialSelectedId ?? "");
  }, [mode, props.initialSelectedId, props.selectedSeriesId]);

  return (
    <section className="topic-entry-workspace" data-tour="topic-inbox" aria-label={mode === "trend" ? "热点选题" : mode === "series" ? "系列选题" : "自定义创作"}>
      {mode === "custom" ? <CustomEntry onManual={props.onManual} onImport={props.onImport} /> : (
        <div className="candidate-inbox">
          <header className="candidate-inbox-heading">
            <div>
              <p className="eyebrow">{mode === "trend" ? "实时信号" : "系列策划"}</p>
              <h2>{mode === "trend" ? "热点候选收件箱" : "系列选题台"}</h2>
              <p>{mode === "trend" ? "热点信号已经过选题总编转译；先筛选，再核验证据。" : "每个系列保留长期承诺，策划器只生成接下来的可制作集数。"}</p>
            </div>
            {mode === "trend" ? (
              <div className="trend-refresh-status" aria-label="热点更新状态">
                <span><i aria-hidden="true" />{modeLoading ? (modeItems.length > 0 ? "正在更新，当前仍可使用" : "正在读取") : "每日缓存"}</span>
                <small>{trendStatusText(props.trendMeta)}</small>
                <button className="icon-button" type="button" aria-label="立即刷新热点" title="立即刷新热点" disabled={modeLoading} onClick={props.onRefreshTrends}><RefreshCw aria-hidden="true" size={16} /></button>
              </div>
            ) : mode === "series" ? (
              <div className="series-controls">
                {props.series.length > 0 ? <label><span>当前系列</span><select aria-label="选择系列" value={props.selectedSeriesId ?? ""} onChange={(event) => props.onSelectSeries(event.target.value)}>{props.series.map((item) => <option key={item.id} value={item.id}>{item.name} · 下一集 {String(item.nextEpisodeNumber).padStart(2, "0")}</option>)}</select></label> : null}
                <button className="button button-secondary" type="button" onClick={props.onCreateSeries}><Plus aria-hidden="true" size={16} />新建系列</button>
              </div>
            ) : null}
          </header>

          {modeError && modeItems.length > 0 ? <div className="candidate-cache-warning" role="status"><AlertCircle aria-hidden="true" size={17} /><span>本次更新失败，继续展示上次缓存：{modeError}</span></div> : null}
          {modeError && modeItems.length === 0 ? (
            <div className="candidate-error" role="alert"><AlertCircle aria-hidden="true" size={20} /><div><strong>{mode === "trend" ? "热点候选暂时不可用" : "系列候选暂时不可用"}</strong><span>{modeError}</span></div><button className="button button-secondary" type="button" onClick={() => props.onRetry(candidateMode)}><RefreshCw aria-hidden="true" size={15} />重试</button></div>
          ) : modeLoading && modeItems.length === 0 ? (
            <div className="candidate-loading"><RadioTower aria-hidden="true" size={24} /><div><h2>{mode === "trend" ? "正在生成今日提案" : "正在读取系列选题"}</h2><p>{mode === "trend" ? "Codex 正在阅读热点并形成提案，通常需要 1–3 分钟；系列和自定义创作仍可立即使用。" : "系列策划通常几秒内就会出现。"}</p></div>{mode === "trend" ? <button className="button button-secondary" type="button" onClick={props.onManual}>录入自己的选题</button> : null}</div>
          ) : mode === "series" && props.series.length === 0 ? (
            <div className="series-empty"><LibraryBig aria-hidden="true" size={28} /><div><h3>先创建一个可持续的系列</h3><p>定义受众、栏目承诺和内容支柱后，系统会给出连续编号的下一集候选。</p></div><button className="button button-primary" type="button" onClick={props.onCreateSeries}>创建第一个系列</button></div>
          ) : mode === "trend" && modeItems.length === 0 ? (
            <div className="series-empty"><RadioTower aria-hidden="true" size={28} /><div><h3>当前没有可用热点候选</h3><p>可能是热点来源暂时离线、还没有缓存，或选题总编没有发现真正值得制作的内容。可手动刷新，或录入已确认来源的研究结果。</p></div><button className="button button-primary" type="button" onClick={props.onManual}>手动录入</button><button className="button button-secondary" type="button" onClick={props.onImport}>导入 JSON</button></div>
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
              {...(props.seriesAuditReady === undefined ? {} : { seriesAuditReady: props.seriesAuditReady })}
            />
          ) : (
            <>
              <div className="candidate-filters" aria-label="候选筛选">
                <div className="verdict-filter" aria-label="生产建议">
                  <button type="button" className={verdict === "all" ? "is-active" : ""} onClick={() => setVerdict("all")}>全部建议 <span>{seriesItems.length}</span></button>
                  {(["produce_video", "produce_image_story", "skip"] as const).map((item) => (
                    <button key={item} type="button" className={verdict === item ? "is-active" : ""} disabled={!verdictCounts[item]} onClick={() => setVerdict(item)}>{editorialVerdictLabel(item)} <span>{verdictCounts[item] ?? 0}</span></button>
                  ))}
                </div>
                <div className="category-filter" aria-label="内容分类">
                  <button type="button" className={category === "all" ? "is-active" : ""} onClick={() => setCategory("all")}>全部 <span>{seriesItems.length}</span></button>
                  {(mode === "trend" ? CATEGORY_ORDER : CATEGORY_ORDER.filter((item) => categoryCounts[item])).map((item) => (
                    <button key={item} type="button" className={category === item ? "is-active" : ""} disabled={!categoryCounts[item]} onClick={() => setCategory(item)}>{TOPIC_CATEGORY_LABELS[item]} <span>{categoryCounts[item] ?? 0}</span></button>
                  ))}
                </div>
                <label className="platform-filter"><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="all">全部平台</option>{platforms.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></label>
                {hasActiveFilters ? <button className="candidate-clear-filters" type="button" onClick={() => { setCategory("all"); setPlatform("all"); setVerdict("all"); }}>清除筛选</button> : null}
              </div>
              {visibleItems.length > 0 ? (
                <div className="candidate-inbox-body">
                  <div className="candidate-list" aria-label="候选提案列表">
                    {visibleItems.map((item, index) => (
                      <button key={item.id} type="button" className={`candidate-row${selected?.id === item.id ? " is-active" : ""}`} aria-label={`查看${item.title}`} onClick={() => setSelectedId(item.id)}>
                        <span className="candidate-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="candidate-row-copy"><small>{TOPIC_CATEGORY_LABELS[item.category]} · {platformLabel(item.platform)} · {editorialVerdictLabel(item.editorialDecision.verdict)}</small><strong>{item.title}</strong><span>{item.hook}</span></span>
                        <span className="candidate-score"><small>制作潜力</small>{Math.round(item.score.final)}</span>
                      </button>
                    ))}
                  </div>
                  {selected ? <CandidateDetail item={selected} adopting={props.adoptingId === selected.id} disabled={props.adoptingId !== undefined} onAdopt={() => adopt(selected)} /> : null}
                </div>
              ) : <div className="filtered-empty"><BookOpenText aria-hidden="true" size={22} /><span>当前筛选下没有候选。</span>{hasActiveFilters ? <button className="button button-secondary" type="button" onClick={() => { setCategory("all"); setPlatform("all"); setVerdict("all"); }}>清除筛选</button> : null}</div>}
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
  const mayAdopt = selectedEpisode?.status === "planned"
    && selectedCandidate?.seriesSequence?.status === "ready";
  const needsGreenlight = selectedEpisode?.planning.auditStatus !== "passed";
  const auditAvailabilityPending = needsGreenlight && seriesAuditReady === undefined;
  const auditUnavailable = needsGreenlight && seriesAuditReady === false;
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
            <section className="series-agent-route" aria-label="本集智能制作与审计流程">
              <div><Sparkles aria-hidden="true" size={16} /><span><strong>路线图策划记录</strong><small>{selectedEpisode.planning.role} · {selectedEpisode.planning.auditRole}</small></span></div>
              <dl>
                <div><dt>生成</dt><dd>{planningSourceLabel(selectedEpisode.planning)}</dd></div>
                <div><dt>审计</dt><dd>{planningAuditLabel(selectedEpisode.planning)}</dd></div>
                <div><dt>推理</dt><dd>{planningReasoningLabel(selectedEpisode.planning)}</dd></div>
              </dl>
              {selectedEpisode.planning.auditSummary ? <p><strong>审计结论：</strong>{selectedEpisode.planning.auditSummary}{selectedEpisode.planning.auditScore !== undefined ? `（${selectedEpisode.planning.auditScore} 分）` : ""}</p> : null}
              {selectedEpisode.planning.fallbackReason ? <p>{selectedEpisode.planning.fallbackReason}</p> : null}
            </section>
            {auditUnavailable ? <p className="series-lock-note"><ShieldAlert aria-hidden="true" size={15} />开拍前独立质量审计尚未就绪。<Link to="/resources#production-roles">去配置系列主理人</Link></p> : null}
            {blockedBy ? <p className="series-lock-note"><LockKeyhole aria-hidden="true" size={15} />第 {blockedBy} 集尚未定版；完成审片后，本集会自动继承最新已确认内容再解锁。</p> : null}
            {selectedEpisode.status === "planned" ? (
              <div className="series-episode-actions">
                <button className="button button-secondary" type="button" disabled={adoptingId !== undefined} onClick={() => setEditing(true)}><PencilLine aria-hidden="true" size={16} />编辑路线图</button>
                <button className="button button-primary" type="button" disabled={!mayAdopt || adoptingId !== undefined || auditAvailabilityPending || auditUnavailable} onClick={() => selectedCandidate && void onAdopt(selectedCandidate)}>{adoptingId === selectedEpisode.id ? "正在复核..." : blockedBy ? `完成第 ${blockedBy} 集后解锁` : auditAvailabilityPending ? "正在确认复核能力" : auditUnavailable ? "开拍前复核未就绪" : needsGreenlight ? "先复核，再进入制作" : "采用本集并进入制作"}<ArrowRight aria-hidden="true" size={16} /></button>
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
  if (planning.auditStatus === "passed") return `独立审计 ${planning.auditIterations}/3 轮通过`;
  if (planning.auditStatus === "stale") return "已定版内容更新 · 采用时先重审";
  if (planning.auditStatus === "human_override") return "人工修订 · 待后续审计";
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
    in_production: "本集正在制作；需要语义判断的内容会接受独立质量审计。",
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

function CandidateDetail({ item, adopting, disabled, onAdopt }: { item: StudioCandidateInboxItem; adopting: boolean; disabled: boolean; onAdopt: () => Promise<void> }) {
  const skipped = item.editorialDecision.verdict === "skip";
  const blocked = item.verification.status === "blocked" || skipped;
  return (
    <article className="candidate-detail" aria-labelledby="candidate-detail-title">
      <header><span>{item.origin === "series" ? `${item.seriesName} · 第 ${item.episodeNumber} 集` : `${TOPIC_CATEGORY_LABELS[item.category]}观察`}</span><strong aria-label={`制作潜力 ${Math.round(item.score.final)} 分`}><small>制作潜力</small>{Math.round(item.score.final)}</strong></header>
      <h3 id="candidate-detail-title">{item.title}</h3>
      <blockquote>{item.hook}</blockquote>
      <p>{item.rationale}</p>
      <div className={`editorial-decision is-${item.editorialDecision.verdict}`}>
        <span>总编建议</span>
        <strong>{editorialVerdictLabel(item.editorialDecision.verdict)} · {item.editorialDecision.score} 分</strong>
        <p>{item.editorialDecision.reasons[0]}</p>
        <small>{item.editorialDecision.guardrails[0]}</small>
        {item.editorialDecision.recommendedTemplate ? (
          <div className="candidate-template-recommendation">
            <span>推荐形态</span>
            <strong>{item.editorialDecision.recommendedTemplate.name}</strong>
            <p>{item.editorialDecision.recommendedTemplate.format}</p>
            <small>{item.editorialDecision.recommendedTemplate.rationale}</small>
          </div>
        ) : null}
      </div>
      <div className="candidate-meta">
        <span><Clock3 aria-hidden="true" size={13} />{item.freshness === "live" ? "实时" : item.freshness === "today" ? "今日" : "常青"}</span>
        <span className={item.risk === "high" ? "is-risk" : ""}><ShieldAlert aria-hidden="true" size={13} />{item.risk === "high" ? "高风险核验" : item.risk === "review" ? "需要核验" : "常规核验"}</span>
        <span title={item.providerId}><Sparkles aria-hidden="true" size={13} />{proposalSourceLabel(item.providerId)}</span>
      </div>
      <details className="candidate-score-explainer">
        <summary>这条候选为什么是 {Math.round(item.score.final)} 分</summary>
        <div>
          <span>受众 {Math.round(item.score.audienceReach)}</span>
          <span>画面 {Math.round(item.score.visualFeasibility)}</span>
          <span>成本 {Math.round(item.score.productionCostEfficiency)}</span>
          <span>新鲜 {Math.round(item.score.novelty)}</span>
          <span>系列 {Math.round(item.score.seriesPotential)}</span>
          <span>风险 {Math.round(item.score.complianceRisk)}</span>
        </div>
        <p>总分综合内容机会与制作可行性；风险分越低越安全。证据强度表示当前信号热度或排名，不等同于事实可信度。</p>
      </details>
      <div className="candidate-evidence"><span>原始证据</span>{item.evidence.slice(0, 2).map((evidence) => evidence.evidenceUrl ? <a key={`${evidence.source}-${evidence.keyword}`} href={evidence.evidenceUrl} target="_blank" rel="noreferrer"><strong>{evidence.keyword}</strong><small>{evidence.source} · 强度 {evidence.strength}</small></a> : <div key={`${evidence.source}-${evidence.keyword}`}><strong>{evidence.keyword}</strong><small>{evidence.source} · 强度 {evidence.strength}</small></div>)}</div>
      <div className={`candidate-verification is-${item.verification.status}`}><ShieldAlert aria-hidden="true" size={15} /><span><strong>{blocked ? "证据不足，暂不可采用" : item.verification.status === "review_required" ? "采用前需要你核验" : "可进入制作区"}</strong><small>{item.verification.reasons[0]}</small></span><output>{item.evidence.length} 条证据 · {item.verification.independentSources} 个独立源（需 {item.verification.requiredSources} 个）</output></div>
      <button className="button button-primary candidate-adopt" data-tour="candidate-adopt" type="button" aria-label={`采用候选 ${item.title}`} disabled={disabled || blocked} onClick={() => void onAdopt()}>{adopting ? "正在采用..." : skipped ? "当前不建议生产" : item.verification.status === "blocked" ? "等待补充来源" : item.verification.status === "review_required" ? "核验后采用" : "采用到制作区"}<ArrowRight aria-hidden="true" size={16} /></button>
    </article>
  );
}

function editorialVerdictLabel(verdict: StudioEditorialVerdict): string {
  return {
    produce_video: "建议视频",
    produce_image_story: "建议图文成片",
    skip: "暂不生产",
  }[verdict];
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
