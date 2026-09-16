import { ArrowRight, Check, ExternalLink, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { STUDIO_CASE_BORROW_AXES } from "../../shared/api.js";
import type {
  StudioCaseCatalog,
  StudioCaseDetail,
  StudioCaseSelection,
  StudioCaseSummary,
  StudioCreatorSettings,
  StudioProductionInput,
  StudioProvider,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { NewRunDialog } from "../components/NewRunDialog.js";

// 借鉴方式是给人选的固定几项，不是模型生成的建议：它只说明"这条参考的哪个方面值得学"，
// 不影响用户自己的主题与观点。选项表与服务端共用一份，避免两边漂移。
const BORROW_OPTIONS = STUDIO_CASE_BORROW_AXES;

type CaseView = "transcript" | "video_only";

export function CasesPage() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<StudioCaseCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [view, setView] = useState<CaseView | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<StudioCaseDetail>();
  const latestDetailRef = useRef<string | undefined>(undefined);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [selection, setSelection] = useState<StudioCaseSelection>();
  const [intent, setIntent] = useState("");
  const [borrowIntent, setBorrowIntent] = useState<string[]>([]);
  const [selectionError, setSelectionError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [creatorSettings, setCreatorSettings] = useState<StudioCreatorSettings>();
  const [providersLoading, setProvidersLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string>();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    try {
      setCatalog(await studioApi.cases(refresh ? { refresh: "1" } : {}));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "案例来源暂时不可用。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 原地重读创作设置：读不到就不开工，避免用错声音、平台或时长。
  const retrySettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(undefined);
    try {
      setCreatorSettings(await studioApi.settings());
    } catch (caught: unknown) {
      setSettingsError(caught instanceof Error ? caught.message : "读取创作设置失败。");
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void studioApi.caseSelection()
      .then((value) => { if (active) setSelection(value); })
      .catch(() => undefined);
    void studioApi.providers()
      .then((value) => { if (active) setProviders(value); })
      .catch(() => undefined)
      .finally(() => { if (active) setProvidersLoading(false); });
    void retrySettings();
    return () => { active = false; };
  }, [retrySettings]);

  const items = useMemo(() => filterItems(catalog?.items ?? [], {
    keyword,
    view,
    sourceFilter,
    topicFilter,
    languageFilter,
  }), [catalog, keyword, view, sourceFilter, topicFilter, languageFilter]);

  async function openDetail(item: StudioCaseSummary, force = false) {
    // 正文是按需向来源方取的，可能几张卡片的请求同时在飞。用最后点的那个 id 做闸门：
    // 先点的慢响应回来后不能把详情面板倒回去，否则"用它开始创作"会存下用户已经离开的那条参考。
    latestDetailRef.current = item.id;
    setSelectedId(item.id);
    setDetailError(undefined);
    if (detail?.item.id !== item.id) setDetail(undefined);
    if (!force && detail?.item.id !== item.id) {
      const cached = catalog?.items.find((candidate) => candidate.id === item.id);
      if (cached) setDetail({ item: cached, transcript: { state: "unavailable", paragraphs: [], truncated: false, usageNote: item.usageNote, reason: "" } });
    }
    setDetailLoading(true);
    try {
      const value = await studioApi.caseDetail(item.id, force);
      if (latestDetailRef.current !== item.id) return;
      setDetail(value);
      // 读到正文后目录里的内容状态会变，用返回值同步一次，避免列表和详情各说一套。
      setCatalog((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.id === value.item.id ? value.item : candidate),
      } : current);
    } catch (caught) {
      if (latestDetailRef.current !== item.id) return;
      setDetailError(caught instanceof Error ? caught.message : "读取这条参考内容失败。");
    } finally {
      if (latestDetailRef.current === item.id) setDetailLoading(false);
    }
  }

  async function saveSelection() {
    if (!detail) return;
    setSaving(true);
    setSelectionError(undefined);
    try {
      setSelection(await studioApi.selectCase({ caseId: detail.item.id, intent, borrowIntent }));
      setDialogOpen(true);
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "保存参考内容失败。");
    } finally {
      setSaving(false);
    }
  }

  async function removeSelection() {
    setSelectionError(undefined);
    try {
      await studioApi.clearCaseSelection();
      setSelection(undefined);
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "移除参考内容失败。");
    }
  }

  async function startProduction(input: StudioProductionInput) {
    const result = await studioApi.start(input);
    setDialogOpen(false);
    navigate(`/projects/${result.runId}`);
  }

  const facets = catalog?.facets;

  return (
    <main className="cases-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">从案例 / 脚本开始</p>
          <h1>发现值得借鉴的视频和脚本</h1>
          <p className="page-summary">
            这里的内容来自外部平台的真实公开页面：脚本文本取自来源方自己发布的逐字稿，视频案例只保存公开信息并链接原站。
            它们只作为创作参考，不是成片素材，也不会进入热点选题候选。
          </p>
        </div>
        <button className="button" type="button" onClick={() => void load(true)} disabled={loading}>
          {loading ? <Loader2 aria-hidden="true" size={16} className="spin" /> : <RefreshCw aria-hidden="true" size={16} />}
          刷新
        </button>
      </header>

      {catalog?.sources?.length ? (
        <ul className="case-source-strip">
          {catalog.sources.map((source) => (
            <li key={source.sourceId} className={`case-source-item is-${source.state}`}>
              <strong>{source.label}</strong>
              <span>{source.detail}</span>
              {source.fetchedAt ? <small>取得时间 {formatTime(source.fetchedAt)}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {selection ? (
        <section className="case-selection-banner" aria-label="当前参考">
          <div>
            <p className="eyebrow">本次参考</p>
            <strong>{selection.title}</strong>
            <span>{selection.sourceLabel} · {selection.contentTypeLabel}{selection.borrowIntent.length ? ` · 借鉴${selection.borrowIntent.join("、")}` : ""}</span>
            <small>这次想做什么：{selection.intent}</small>
          </div>
          <div className="case-selection-actions">
            <button className="button" type="button" onClick={() => {
              const record = selection;
              setSelectedId(record.caseId);
              setIntent(record.intent);
              setBorrowIntent(record.borrowIntent);
              const item = catalog?.items.find((candidate) => candidate.id === record.caseId);
              if (item) void openDetail(item);
              else setDialogOpen(true);
            }}>修改</button>
            <button className="button" type="button" onClick={() => void removeSelection()}>移除</button>
          </div>
        </section>
      ) : null}

      <section className="case-toolbar" aria-label="筛选">
        <label className="case-search">
          <Search aria-hidden="true" size={16} />
          <input
            type="search"
            value={keyword}
            placeholder="搜索标题、作者或话题"
            onChange={(event) => setKeyword(event.target.value)}
          />
          {keyword ? <button type="button" aria-label="清空搜索" onClick={() => setKeyword("")}><X aria-hidden="true" size={14} /></button> : null}
        </label>
        <div className="case-views" role="tablist">
          {([["all", "全部"], ["transcript", "脚本参考"], ["video_only", "视频案例"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              className={view === value ? "is-active" : ""}
              onClick={() => setView(value)}
            >{label}</button>
          ))}
        </div>
        <div className="case-filters">
          {/* 筛选项只列真实出现过的取值：没有数据的维度不显示，也不用"未知"占位。 */}
          <FacetSelect label="来源" value={sourceFilter} values={facets?.sources} onChange={setSourceFilter} />
          <FacetSelect label="话题" value={topicFilter} values={facets?.topics} onChange={setTopicFilter} />
          <FacetSelect label="语言" value={languageFilter} values={facets?.languages} onChange={setLanguageFilter} />
        </div>
      </section>

      {error ? <p className="case-error">{error}</p> : null}
      {settingsError ? (
        <p className="case-error">
          未能读取你的创作设置，为避免用错声音、平台或时长，暂未进入制作。{settingsError}
          <button className="button button-secondary" type="button" onClick={() => void retrySettings()}><RefreshCw aria-hidden="true" size={16} />重新读取</button>
        </p>
      ) : null}

      <div className="case-workspace">
        <section className="case-list" aria-label="案例列表">
          {loading && !catalog ? <p className="case-hint"><Loader2 aria-hidden="true" size={14} className="spin" /> 正在从来源平台取回真实内容，首次需要一点时间。</p> : null}
          {!loading && items.length === 0 ? (
            <p className="case-hint">
              {catalog?.items.length ? "没有符合条件的参考内容，换一个关键词或筛选项试试。" : "暂时没有取到内容，请查看上方来源状态。"}
            </p>
          ) : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`case-card${selectedId === item.id ? " is-selected" : ""}`}
              onClick={() => void openDetail(item)}
            >
              <span className={`case-state is-${item.contentState}`}>{item.contentTypeLabel}</span>
              <strong>{item.title}</strong>
              <span className="case-meta">
                {item.sourceLabel}
                {item.author ? ` · ${item.author}` : ""}
                {item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : ""}
                {item.publishedAt ? ` · ${formatDate(item.publishedAt)}` : ""}
              </span>
              {item.summary ? <small>{item.summary}</small> : null}
              <span className="case-metric-line">
                {item.metrics.length
                  ? item.metrics.slice(0, 3).map((metric) => `${metric.label} ${formatNumber(metric.value)}`).join(" · ")
                  : "来源未公开可读指标"}
              </span>
            </button>
          ))}
        </section>

        <section className="case-detail" aria-label="参考详情">
          {!selectedId ? <p className="case-hint">从左侧选一条参考内容，这里会显示它的正文或可用信息。</p> : null}
          {detailError ? <p className="case-error">{detailError}</p> : null}
          {detail ? (
            <article>
              <header>
                <span className={`case-state is-${detail.item.contentState}`}>{detail.item.contentTypeLabel}</span>
                <h2>{detail.item.title}</h2>
                <p className="case-meta">
                  {detail.item.sourceLabel}
                  {detail.item.author ? ` · ${detail.item.author}` : ""}
                  {detail.item.language ? ` · 语言 ${detail.item.language}` : ""}
                </p>
                <a href={detail.item.originalUrl} target="_blank" rel="noreferrer noopener">
                  查看原站页面<ExternalLink aria-hidden="true" size={14} />
                </a>
                {detail.item.metrics.length ? (
                  <p className="case-metric-line">
                    {detail.item.metrics.map((metric) => `${metric.label} ${formatNumber(metric.value)}`).join(" · ")}
                    <small>（取得时间 {formatTime(detail.item.metricsFetchedAt)}）</small>
                  </p>
                ) : null}
                <p className="case-usage">{detail.item.usageNote}</p>
              </header>

              {detailLoading ? <p className="case-hint"><Loader2 aria-hidden="true" size={14} className="spin" /> 正在读取来源方正文…</p> : null}

              {!detailLoading && detail.transcript.state === "unavailable" ? (
                <div className="case-transcript-missing">
                  <p>{detail.transcript.reason ?? "这条内容没有可读取的正文。"}</p>
                  {detail.item.contentState === "unread" ? (
                    <button className="button" type="button" onClick={() => void openDetail(detail.item, true)}>重新读取正文</button>
                  ) : null}
                </div>
              ) : null}

              {detail.transcript.paragraphs.length ? (
                <div className="case-transcript">
                  <p className="case-transcript-note">
                    {detail.transcript.language ? `语言 ${detail.transcript.language} · ` : ""}
                    取得时间 {detail.transcript.fetchedAt ? formatTime(detail.transcript.fetchedAt) : "未知"}
                    {detail.transcript.truncated ? " · 内容较长，这里只展示前一部分" : ""}
                  </p>
                  {detail.transcript.paragraphs.map((paragraph) => (
                    <p key={paragraph.id}>{paragraph.text}</p>
                  ))}
                </div>
              ) : null}

              <footer className="case-create">
                <label>
                  <span>这次想做什么</span>
                  <textarea
                    rows={3}
                    value={intent}
                    placeholder="用自己的话写这次的选题与角度，参考内容不会改变它"
                    onChange={(event) => setIntent(event.target.value)}
                  />
                </label>
                <fieldset>
                  <legend>希望借鉴什么</legend>
                  {BORROW_OPTIONS.map((option) => {
                    const active = borrowIntent.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={active}
                        className={active ? "is-active" : ""}
                        onClick={() => setBorrowIntent((current) => active
                          ? current.filter((item) => item !== option)
                          : [...current, option])}
                      >
                        {active ? <Check aria-hidden="true" size={13} /> : null}
                        {option}
                      </button>
                    );
                  })}
                </fieldset>
                {selectionError ? <p className="case-error">{selectionError}</p> : null}
                <button
                  className="button button-primary"
                  type="button"
                  disabled={saving || !intent.trim() || Boolean(settingsError)}
                  onClick={() => void saveSelection()}
                >
                  {saving ? <Loader2 aria-hidden="true" size={16} className="spin" /> : <ArrowRight aria-hidden="true" size={16} />}
                  用它开始创作
                </button>
                <small>接下来会打开已有的制作准备表单，主题、角度和参考都可以在那一步继续修改。</small>
              </footer>
            </article>
          ) : null}
        </section>
      </div>

      {detail && selection && selection.caseId === detail.item.id ? (
        <NewRunDialog
          open={dialogOpen}
          providers={providers}
          initialDataReady={!providersLoading && !settingsLoading && !settingsError}
          {...(creatorSettings ? { creatorSettings } : {})}
          {...(settingsError ? { settingsError } : {})}
          onRetrySettings={() => void retrySettings()}
          initialValues={{
            title: selection.intent,
            angle: selection.intent,
            ...(creatorSettings?.productionDefaults.platform ? { platform: creatorSettings.productionDefaults.platform } : {}),
            ...(creatorSettings?.productionDefaults.durationSeconds ? { durationSeconds: creatorSettings.productionDefaults.durationSeconds } : {}),
            creationContext: { origin: "case", opportunityId: "", caseSelectionId: selection.caseId },
          }}
          onClose={() => setDialogOpen(false)}
          onSubmit={startProduction}
        />
      ) : null}
    </main>
  );
}

function FacetSelect({ label, value, values, onChange }: {
  label: string;
  value: string;
  values: Record<string, number> | undefined;
  onChange: (value: string) => void;
}) {
  const entries = Object.entries(values ?? {}).sort((left, right) => right[1] - left[1]);
  if (entries.length < 2) return null;
  return (
    <label className="case-facet">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部</option>
        {entries.map(([key, count]) => <option key={key} value={key}>{key}（{count}）</option>)}
      </select>
    </label>
  );
}

function filterItems(items: StudioCaseSummary[], filter: {
  keyword: string;
  view: CaseView | "all";
  sourceFilter: string;
  topicFilter: string;
  languageFilter: string;
}): StudioCaseSummary[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.view === "transcript" && item.contentState === "video_only") return false;
    if (filter.view === "video_only" && item.contentState !== "video_only") return false;
    if (filter.sourceFilter && item.sourceLabel !== filter.sourceFilter) return false;
    if (filter.topicFilter && !item.topics.includes(filter.topicFilter)) return false;
    if (filter.languageFilter && item.language !== filter.languageFilter) return false;
    if (!keyword) return true;
    return [item.title, item.summary ?? "", item.author ?? "", item.sourceLabel, ...item.topics]
      .join(" ").toLowerCase().includes(keyword);
  });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : String(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
