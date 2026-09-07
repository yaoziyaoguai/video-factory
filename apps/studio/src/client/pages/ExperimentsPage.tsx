import { AlertCircle, BarChart3, CircleCheck, RefreshCw, RotateCcw, ScanSearch, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { StudioCostDashboard as StudioCostDashboardDto, StudioRunSummary, StudioTemplateExperimentScorecard } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { CostDashboard } from "../components/CostDashboard.js";
import { isHistoricalReadOnlyRun, runNodeLabel } from "../presentation.js";

export function ExperimentsPage() {
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [costs, setCosts] = useState<StudioCostDashboardDto>();
  const [costError, setCostError] = useState<string>();
  const [costLoading, setCostLoading] = useState(false);
  const [templates, setTemplates] = useState<StudioTemplateExperimentScorecard[]>([]);
  const [templateError, setTemplateError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setTemplateError(undefined);
    const [runResult, templateResult] = await Promise.allSettled([
      studioApi.runs(),
      studioApi.templateExperiments(),
    ]);
    if (runResult.status === "fulfilled") setRuns(runResult.value);
    else setError(runResult.reason instanceof Error ? runResult.reason.message : String(runResult.reason));
    if (templateResult.status === "fulfilled") setTemplates(templateResult.value);
    else {
      setTemplates([]);
      setTemplateError(templateResult.reason instanceof Error ? templateResult.reason.message : String(templateResult.reason));
    }
    setLoading(false);
  }, []);
  const loadCosts = useCallback(async () => {
    setCostLoading(true);
    setCostError(undefined);
    try {
      setCosts(await studioApi.costs());
    } catch (costRequestError) {
      setCosts(undefined);
      setCostError(costRequestError instanceof Error ? costRequestError.message : String(costRequestError));
    } finally {
      setCostLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const learningRuns = useMemo(() => runs.filter((run) => run.runPurpose !== "test"), [runs]);
  const stats = useMemo(() => {
    const approved = learningRuns.filter((run) => run.finalReviewOutcome === "approved").length;
    const rejected = learningRuns.filter((run) => run.finalReviewOutcome === "rejected").length;
    const reviewed = approved + rejected;
    return {
      rejected,
      needsReview: learningRuns.filter((run) => !isHistoricalReadOnlyRun(run) && run.status === "needs_human" && run.currentNodeId === "final-review").length,
      interrupted: learningRuns.filter((run) => run.status === "failed").length,
      approvalRate: reviewed ? Math.round(approved / reviewed * 100) : undefined,
    };
  }, [learningRuns]);
  const recentLearningRuns = useMemo(() => learningRuns
    .filter((run) => !isHistoricalReadOnlyRun(run) && (run.finalReviewOutcome !== undefined
      || run.status === "failed"
      || (run.status === "needs_human" && run.currentNodeId === "final-review")))
    .slice(0, 6), [learningRuns]);
  const bottleneck = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of learningRuns) {
      if (run.status !== "failed") continue;
      counts.set(run.currentNodeId, (counts.get(run.currentNodeId) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  }, [learningRuns]);

  return (
    <main className="page experiments-page">
      <header className="page-header"><div><p className="eyebrow">内容学习</p><h1>制作复盘</h1><p className="page-summary">先看哪些模板更容易过审、哪里反复返工，再决定下一条怎么改。平台数据接入后，再用完播、互动和涨粉判断爆款表现。</p></div></header>
      {loading ? <div className="region-loading">正在读取制作记录...</div> : error ? (
        <div className="page-error" role="alert"><AlertCircle aria-hidden="true" size={18} /><span><strong>制作统计未知</strong>{error}</span><button className="icon-button" type="button" onClick={() => void load()} title="重试"><RefreshCw aria-hidden="true" size={17} /></button></div>
      ) : <><section className="metric-strip experiment-metric-strip" aria-label="制作统计" data-tour="experiment-metrics">
        <article><CircleCheck aria-hidden="true" size={17} /><span>终审通过率</span><strong>{stats.approvalRate === undefined ? "待样本" : `${stats.approvalRate}%`}</strong></article>
        <article><ScanSearch aria-hidden="true" size={17} /><span>等你审片</span><strong>{stats.needsReview}</strong></article>
        <article><RotateCcw aria-hidden="true" size={17} /><span>已打回返工</span><strong>{stats.rejected}</strong></article>
        <article><TriangleAlert aria-hidden="true" size={17} /><span>制作中断</span><strong>{stats.interrupted}</strong></article>
      </section>
      <section className="learning-focus" aria-labelledby="learning-focus-title">
        <header className="section-heading"><div><p className="eyebrow">下一轮行动</p><h2 id="learning-focus-title">这一轮最该改什么</h2></div><span>来自真实制作记录</span></header>
        <div className="learning-focus-grid">
          <article><strong>{stats.rejected ? `${stats.rejected} 条成片被打回` : "先积累终审样本"}</strong><p>{stats.rejected ? "返工时沿用可用母片，只重做审片明确指出的镜头，并检查建议是否真正进入脚本、导演和画面节点。" : "完成终审后，系统才能比较通过率、返工次数和模板表现。"}</p></article>
          <article><strong>{bottleneck ? `${runNodeLabel(bottleneck[0])}出现 ${bottleneck[1]} 次问题` : "当前没有集中故障步骤"}</strong><p>{bottleneck ? "先解决重复出现的制作阻塞，再扩大选题和模板实验，避免把技术失败误当作内容失败。" : "继续用不同模板完成小样本，优先比较钩子兑现、视觉连续性和终审结果。"}</p></article>
        </div>
      </section>
      <section className="template-learning" aria-labelledby="template-learning-title">
        <header className="section-heading"><div><p className="eyebrow">模板表现</p><h2 id="template-learning-title">哪种讲法更容易过审</h2></div><Link to="/templates">调整模板</Link></header>
        {templateError ? <p className="learning-inline-error">模板表现读取失败：{templateError}</p> : <div className="template-learning-grid">
          {templates.length ? templates.map((template) => <article key={template.templateId}>
            <header><strong>{template.templateName}</strong><span>{template.sampleSize} 条样本</span></header>
            <dl>
              <div><dt>终审通过</dt><dd>{percentLabel(template.metrics.finalApprovalRate)}</dd></div>
              <div><dt>视觉匹配</dt><dd>{scoreLabel(template.metrics.visualMatch)}</dd></div>
              <div><dt>成片完成率</dt><dd>{percentLabel(template.metrics.narrativeCompleteness)}</dd></div>
              <div><dt>人工修订</dt><dd>{template.metrics.manualEditCount} 次</dd></div>
            </dl>
          </article>) : <p className="learning-empty">还没有可比较的模板样本。完成第一条成片后，这里会开始累计真实结果。</p>}
        </div>}
      </section>
      <section className="recent-learning-runs" aria-labelledby="recent-learning-title">
        <header className="section-heading"><div><p className="eyebrow">最近结果</p><h2 id="recent-learning-title">从具体作品继续改</h2></div><Link to="/projects">查看全部</Link></header>
        <div>{recentLearningRuns.length ? recentLearningRuns.map((run) => <Link to={`/projects/${run.id}`} key={run.id}><span><strong>{run.title}</strong><small>{runNodeLabel(run.currentNodeId)} · {new Date(run.finishedAt ?? run.startedAt).toLocaleDateString("zh-CN")}</small></span><b>{runOutcomeLabel(run)}</b></Link>) : <p>还没有可以复盘的制作结果。</p>}</div>
      </section>
      <section className="analytics-empty analytics-empty-compact" aria-labelledby="analytics-empty-title" data-tour="experiment-outcomes">
        <span><BarChart3 aria-hidden="true" size={24} /></span>
        <p className="eyebrow">平台结果连接器</p>
        <h2 id="analytics-empty-title">还不能判断是否成为爆款</h2>
        <p>播放、完播、互动和涨粉尚未接入，所以这里不会编造“爆款分”。当前先用过审、返工和模板质量改进制作，平台导出或授权连接器接入后再补齐传播表现。</p>
      </section>
      <details className="secondary-cost-details" onToggle={(event) => {
        if (event.currentTarget.open && !costs && !costLoading) void loadCosts();
      }}>
        <summary><span><strong>费用与调用记录</strong><small>辅助核对，不作为内容复盘主指标</small></span><b>展开</b></summary>
        {costLoading ? <div className="region-loading">正在读取费用记录...</div> : null}
        {costs ? <CostDashboard dashboard={costs} /> : null}
        {costError ? <div className="page-error" role="alert"><AlertCircle aria-hidden="true" size={18} /><span><strong>费用记录读取失败</strong>{costError}</span><button className="icon-button" type="button" onClick={() => void loadCosts()} title="重新读取费用记录"><RefreshCw aria-hidden="true" size={17} /></button></div> : null}
      </details>
      </>}
    </main>
  );
}

function scoreLabel(score: number | null): string {
  return score === null ? "待采集" : `${score} 分`;
}

function percentLabel(score: number | null): string {
  return score === null ? "待采集" : `${score}%`;
}

function runOutcomeLabel(run: StudioRunSummary): string {
  if (isHistoricalReadOnlyRun(run)) return "历史只读";
  if (run.finalReviewOutcome === "approved") return "已通过";
  if (run.finalReviewOutcome === "rejected") return "已打回";
  return ({
    succeeded: "制作完成",
    rejected: "已停止",
    failed: "制作失败",
    stale: "需要重做",
    needs_human: "等你审片",
    pending: "等待开始",
    running: "制作中",
    paused: "已暂停",
    awaiting_spend_approval: "待确认费用",
    approval_invalidated: "需重新报价",
  })[run.status];
}
