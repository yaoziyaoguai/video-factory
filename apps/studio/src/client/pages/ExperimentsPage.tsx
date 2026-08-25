import { AlertCircle, BarChart3, CircleCheck, FlaskConical, RefreshCw, ScanSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";

export function ExperimentsPage() {
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    await studioApi.runs()
      .then(setRuns)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const stats = useMemo(() => ({
    total: runs.length,
    completed: runs.filter((run) => run.status === "succeeded").length,
    needsReview: runs.filter((run) => run.status === "needs_human").length,
  }), [runs]);

  return (
    <main className="page experiments-page">
      <header className="page-header"><div><p className="eyebrow">制作学习</p><h1>制作复盘</h1><p className="page-summary">先汇总制作结果；平台连接器接入后，再把内容表现纳入复盘。</p></div></header>
      {loading ? <div className="region-loading">正在读取制作记录...</div> : error ? (
        <div className="page-error" role="alert"><AlertCircle aria-hidden="true" size={18} /><span><strong>制作统计未知</strong>{error}</span><button className="icon-button" type="button" onClick={() => void load()} title="重试"><RefreshCw aria-hidden="true" size={17} /></button></div>
      ) : <><section className="metric-strip" aria-label="制作统计" data-tour="experiment-metrics">
        <article><FlaskConical aria-hidden="true" size={17} /><span>已发起制作</span><strong>{stats.total}</strong></article>
        <article><CircleCheck aria-hidden="true" size={17} /><span>已完成</span><strong>{stats.completed}</strong></article>
        <article><ScanSearch aria-hidden="true" size={17} /><span>等你审片</span><strong>{stats.needsReview}</strong></article>
      </section>
      <section className="analytics-empty" aria-labelledby="analytics-empty-title" data-tour="experiment-outcomes">
        <span><BarChart3 aria-hidden="true" size={24} /></span>
        <p className="eyebrow">平台结果连接器</p>
        <h2 id="analytics-empty-title">平台数据尚未接入</h2>
        <p>播放、完播、互动和涨粉需要通过平台导出或授权连接器接入。当前页面只展示制作记录，暂不支持手工录入平台结果。</p>
      </section>
      </>}
    </main>
  );
}
