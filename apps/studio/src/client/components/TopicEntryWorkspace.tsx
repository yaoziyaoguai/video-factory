import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  Clock3,
  FileInput,
  Flame,
  LibraryBig,
  PenLine,
  Plus,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  StudioCandidateInbox,
  StudioCandidateInboxItem,
  StudioCandidateOrigin,
  StudioSeries,
  StudioTopicCategory,
} from "../../shared/api.js";
import { platformLabel, proposalSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";
import { CandidateVerificationDialog } from "./CandidateVerificationDialog.js";

type EntryMode = StudioCandidateOrigin | "custom";

interface TopicEntryWorkspaceProps {
  inbox?: StudioCandidateInbox;
  series: StudioSeries[];
  loading: Partial<Record<StudioCandidateOrigin, boolean>>;
  error?: Partial<Record<StudioCandidateOrigin, string>>;
  adoptingId?: string;
  trendMeta: { platformCount: number; candidateCount: number; collectedAt?: string; generatedAt?: string };
  onRetry: (origin: StudioCandidateOrigin) => void;
  onRefreshTrends: () => void;
  onAdopt: (candidate: StudioCandidateInboxItem, verificationConfirmed?: boolean) => Promise<void>;
  onCreateSeries: () => void;
  onManual: () => void;
  onImport: () => void;
}

const CATEGORY_ORDER = Object.keys(TOPIC_CATEGORY_LABELS) as StudioTopicCategory[];

export function TopicEntryWorkspace(props: TopicEntryWorkspaceProps) {
  const [mode, setMode] = useState<EntryMode>("trend");
  const [category, setCategory] = useState<StudioTopicCategory | "all">("all");
  const [platform, setPlatform] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>();
  const [verificationCandidate, setVerificationCandidate] = useState<StudioCandidateInboxItem>();

  const modeItems = useMemo(() => (props.inbox?.items ?? []).filter((item) => item.origin === mode), [mode, props.inbox]);
  const seriesItems = mode === "series" && selectedSeriesId
    ? modeItems.filter((item) => item.seriesId === selectedSeriesId)
    : modeItems;
  const categoryCounts = countCategories(seriesItems);
  const platforms = [...new Set(seriesItems.map((item) => item.platform))];
  const visibleItems = seriesItems
    .filter((item) => category === "all" || item.category === category)
    .filter((item) => platform === "all" || item.platform === platform);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
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
    setSelectedId(undefined);
  }, [mode, selectedSeriesId]);

  useEffect(() => {
    if (!selectedSeriesId && props.series[0]) setSelectedSeriesId(props.series[0].id);
    if (selectedSeriesId && !props.series.some((item) => item.id === selectedSeriesId)) {
      setSelectedSeriesId(props.series[0]?.id);
    }
  }, [props.series, selectedSeriesId]);

  return (
    <section className="topic-entry-workspace" data-tour="topic-inbox" aria-labelledby="topic-entry-title">
      <header className="topic-entry-header">
        <div>
          <p className="eyebrow">选题台</p>
          <h2 id="topic-entry-title">从哪里开始这条内容</h2>
        </div>
        <span>{props.inbox?.facets.total ?? 0} 条待判断候选</span>
      </header>
      <div className="topic-entry-tabs" role="tablist" aria-label="选题入口">
        <EntryTab active={mode === "trend"} icon={<Flame aria-hidden="true" size={17} />} label="热点机会" note="从实时信号找角度" onClick={() => setMode("trend")} />
        <EntryTab active={mode === "series"} icon={<LibraryBig aria-hidden="true" size={17} />} label="系列选题" note="继续长期内容栏目" onClick={() => setMode("series")} />
        <EntryTab active={mode === "custom"} icon={<PenLine aria-hidden="true" size={17} />} label="自定义创作" note="从自己的观察出发" onClick={() => setMode("custom")} />
      </div>

      {mode === "custom" ? <CustomEntry onManual={props.onManual} onImport={props.onImport} /> : (
        <div className="candidate-inbox">
          <header className="candidate-inbox-heading">
            <div>
              <p className="eyebrow">{mode === "trend" ? "实时信号" : "系列策划"}</p>
              <h2>{mode === "trend" ? "热点候选收件箱" : "系列选题台"}</h2>
              <p>{mode === "trend" ? "信号已经过本地 Agent 转译；先筛选，再核验证据。" : "每个系列保留长期承诺，策划器只生成接下来的可制作集数。"}</p>
            </div>
            {mode === "trend" ? (
              <div className="trend-refresh-status" aria-label="热点更新状态">
                <span><i aria-hidden="true" />{modeLoading ? "正在更新" : "自动更新"}</span>
                <small>{trendStatusText(props.trendMeta)}</small>
                <button className="icon-button" type="button" aria-label="立即刷新热点" title="立即刷新热点" disabled={modeLoading} onClick={props.onRefreshTrends}><RefreshCw aria-hidden="true" size={16} /></button>
              </div>
            ) : mode === "series" ? (
              <div className="series-controls">
                {props.series.length > 0 ? <label><span>当前系列</span><select aria-label="选择系列" value={selectedSeriesId ?? ""} onChange={(event) => setSelectedSeriesId(event.target.value)}>{props.series.map((item) => <option key={item.id} value={item.id}>{item.name} · 下一集 {String(item.nextEpisodeNumber).padStart(2, "0")}</option>)}</select></label> : null}
                <button className="button button-secondary" type="button" onClick={props.onCreateSeries}><Plus aria-hidden="true" size={16} />新建系列</button>
              </div>
            ) : null}
          </header>

          {modeError ? (
            <div className="candidate-error" role="alert"><AlertCircle aria-hidden="true" size={20} /><div><strong>{mode === "trend" ? "热点候选暂时不可用" : "系列候选暂时不可用"}</strong><span>{modeError}</span></div><button className="button button-secondary" type="button" onClick={() => props.onRetry(candidateMode)}><RefreshCw aria-hidden="true" size={15} />重试</button></div>
          ) : modeLoading && modeItems.length === 0 ? (
            <div className="candidate-loading"><RadioTower aria-hidden="true" size={24} /><div><h2>{mode === "trend" ? "正在生成今日提案" : "正在读取系列选题"}</h2><p>{mode === "trend" ? "Codex 正在阅读热点并形成提案，通常需要 1–3 分钟；系列和自定义创作仍可立即使用。" : "系列策划通常几秒内就会出现。"}</p></div>{mode === "trend" ? <button className="button button-secondary" type="button" onClick={props.onManual}>录入自己的选题</button> : null}</div>
          ) : mode === "series" && props.series.length === 0 ? (
            <div className="series-empty"><LibraryBig aria-hidden="true" size={28} /><div><h3>先创建一个可持续的系列</h3><p>定义受众、栏目承诺和内容支柱后，系统会给出连续编号的下一集候选。</p></div><button className="button button-primary" type="button" onClick={props.onCreateSeries}>创建第一个系列</button></div>
          ) : mode === "trend" && modeItems.length === 0 ? (
            <div className="series-empty"><RadioTower aria-hidden="true" size={28} /><div><h3>趋势源尚未配置</h3><p>连接趋势采集器，或先录入你已经确认来源的研究结果。</p></div><button className="button button-primary" type="button" onClick={props.onManual}>手动录入</button><button className="button button-secondary" type="button" onClick={props.onImport}>导入 JSON</button></div>
          ) : (
            <>
              <div className="candidate-filters" aria-label="候选筛选">
                <div className="category-filter" aria-label="内容分类">
                  <button type="button" className={category === "all" ? "is-active" : ""} onClick={() => setCategory("all")}>全部 <span>{seriesItems.length}</span></button>
                  {(mode === "trend" ? CATEGORY_ORDER : CATEGORY_ORDER.filter((item) => categoryCounts[item])).map((item) => (
                    <button key={item} type="button" className={category === item ? "is-active" : ""} disabled={!categoryCounts[item]} onClick={() => setCategory(item)}>{TOPIC_CATEGORY_LABELS[item]} <span>{categoryCounts[item] ?? 0}</span></button>
                  ))}
                </div>
                <label className="platform-filter"><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="all">全部平台</option>{platforms.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></label>
              </div>
              {visibleItems.length > 0 ? (
                <div className="candidate-inbox-body">
                  <div className="candidate-list" aria-label="候选提案列表">
                    {visibleItems.map((item, index) => (
                      <button key={item.id} type="button" className={`candidate-row${selected?.id === item.id ? " is-active" : ""}`} aria-label={`查看${item.title}`} onClick={() => setSelectedId(item.id)}>
                        <span className="candidate-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="candidate-row-copy"><small>{TOPIC_CATEGORY_LABELS[item.category]} · {platformLabel(item.platform)}</small><strong>{item.title}</strong><span>{item.hook}</span></span>
                        <span className="candidate-score">{item.score.final}</span>
                      </button>
                    ))}
                  </div>
                  {selected ? <CandidateDetail item={selected} adopting={props.adoptingId === selected.id} disabled={props.adoptingId !== undefined} onAdopt={() => adopt(selected)} /> : null}
                </div>
              ) : <div className="filtered-empty"><BookOpenText aria-hidden="true" size={22} /><span>当前筛选下没有候选，换一个分类或平台看看。</span></div>}
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

function EntryTab({ active, icon, label, note, onClick }: { active: boolean; icon: React.ReactNode; label: string; note: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick}>{icon}<span><strong>{label}</strong><small>{note}</small></span></button>;
}

function CandidateDetail({ item, adopting, disabled, onAdopt }: { item: StudioCandidateInboxItem; adopting: boolean; disabled: boolean; onAdopt: () => Promise<void> }) {
  const blocked = item.verification.status === "blocked";
  return (
    <article className="candidate-detail" aria-labelledby="candidate-detail-title">
      <header><span>{item.origin === "series" ? `${item.seriesName} · 第 ${item.episodeNumber} 集` : `${TOPIC_CATEGORY_LABELS[item.category]}观察`}</span><strong aria-label={`候选评分 ${item.score.final}`}>{item.score.final}</strong></header>
      <h3 id="candidate-detail-title">{item.title}</h3>
      <blockquote>{item.hook}</blockquote>
      <p>{item.rationale}</p>
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
      <button className="button button-primary candidate-adopt" data-tour="candidate-adopt" type="button" aria-label={`采用候选 ${item.title}`} disabled={disabled || blocked} onClick={() => void onAdopt()}>{adopting ? "正在采用..." : blocked ? "等待补充来源" : item.verification.status === "review_required" ? "核验后采用" : "采用到制作区"}<ArrowRight aria-hidden="true" size={16} /></button>
    </article>
  );
}

function CustomEntry({ onManual, onImport }: { onManual: () => void; onImport: () => void }) {
  return (
    <div className="custom-entry">
      <div><p className="eyebrow">自主选题</p><h2>自定义创作</h2><p>不追热点也完全成立。把自己的观察、系列外灵感或已经核验的研究直接送进同一套制作流程。</p></div>
      <div className="custom-entry-actions">
        <button className="custom-entry-action" type="button" onClick={onManual}><PenLine aria-hidden="true" size={22} /><span><strong>手动录入</strong><small>填写标题、受众、痛点和开场钩子</small></span><ArrowRight aria-hidden="true" size={17} /></button>
        <button className="custom-entry-action" type="button" onClick={onImport}><FileInput aria-hidden="true" size={22} /><span><strong>导入 JSON</strong><small>接入外部研究或其他 Agent 的结构化结果</small></span><ArrowRight aria-hidden="true" size={17} /></button>
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

function trendStatusText(meta: TopicEntryWorkspaceProps["trendMeta"]): string {
  const updatedAt = meta.collectedAt ?? meta.generatedAt;
  const time = updatedAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(updatedAt)) : "--:--";
  return `采集 ${time} · ${meta.platformCount} 个平台 · ${meta.candidateCount} 条`;
}
