import { CircleDollarSign, Clock3, Gauge, ReceiptText, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioCostDashboard, StudioCostGroup, StudioCostRunDetail, StudioCostTotals } from "../../shared/api.js";
import { providerLabel, runNodeLabel } from "../presentation.js";

export function CostDashboard({ dashboard }: { dashboard: StudioCostDashboard }) {
  return (
    <section className="cost-dashboard" aria-labelledby="cost-dashboard-title">
      <header className="section-heading"><div><p className="eyebrow">成本账本</p><h2 id="cost-dashboard-title">每一分钱都能追到节点</h2></div><span>人民币 CNY</span></header>
      <CostMetrics totals={dashboard.totals} />
      <div className="cost-dashboard-grid">
        <CostRanking title="按服务商" groups={dashboard.byProvider} kind="provider" />
        <CostRanking title="按生产节点" groups={dashboard.byNode} kind="node" />
      </div>
      <div className="cost-run-table">
        <header><strong>视频明细</strong><span>{dashboard.runs.length} 条制作</span></header>
        {dashboard.runs.length ? dashboard.runs.map((run) => <Link to={`/projects/${run.runId}`} key={run.runId}><span><strong>{run.title}</strong><small>{run.totals.meteredCalls} 次付费调用 · {run.totals.actualPendingCount} 笔待回填</small></span><b>{actualCostLabel(run.totals)}</b></Link>) : <p>产生制作调用后，这里会按视频汇总。</p>}
      </div>
    </section>
  );
}

export function RunCostDetailPanel({ detail }: { detail: StudioCostRunDetail }) {
  return (
    <section className="run-cost-detail" aria-labelledby="run-cost-title">
      <header className="section-heading"><div><p className="eyebrow">本片成本</p><h2 id="run-cost-title">调用与消费明细</h2></div><ReceiptText aria-hidden="true" size={19} /></header>
      <CostMetrics totals={detail.totals} compact />
      <div className="cost-line-list">
        {detail.lines.length ? detail.lines.map((line) => <article key={line.id}><span><strong>{line.role ? `${line.role} · ` : ""}{line.nodeId}</strong><small>{line.providerId} · {line.modelId}</small></span><span><small>{line.status === "failed" ? "调用失败" : line.billing === "metered" ? "按量付费" : line.billing === "subscription" ? "订阅额度" : "免费/本地"}</small><b>{line.actualPending ? `待回填 · 预估 ¥${line.estimatedCostCny.toFixed(2)}` : `¥${(line.actualCostCny ?? 0).toFixed(2)}`}</b></span></article>) : <p>本片尚未产生可计量调用。</p>}
      </div>
    </section>
  );
}

function CostMetrics({ totals, compact = false }: { totals: StudioCostTotals; compact?: boolean }) {
  return <div className={compact ? "cost-metrics is-compact" : "cost-metrics"}>
    <article><CircleDollarSign aria-hidden="true" size={17} /><span>实际消费</span><strong>{actualCostLabel(totals)}</strong></article>
    <article><Gauge aria-hidden="true" size={17} /><span>授权上限</span><strong>¥{totals.authorizedCostCny.toFixed(2)}</strong></article>
    <article><Clock3 aria-hidden="true" size={17} /><span>待回填</span><strong>{totals.actualPendingCount}</strong></article>
    <article><RotateCcw aria-hidden="true" size={17} /><span>付费失败</span><strong>{totals.failedMeteredCalls}</strong></article>
  </div>;
}

function CostRanking({ title, groups, kind }: { title: string; groups: StudioCostGroup[]; kind: "provider" | "node" }) {
  const max = Math.max(...groups.map((group) => group.actualCostCny || group.estimatedCostCny), 1);
  return <section className="cost-ranking"><header><strong>{title}</strong><span>{groups.length} 项</span></header>{groups.length ? groups.map((group) => {
    const amount = group.actualCostCny || group.estimatedCostCny;
    const label = kind === "provider" ? providerLabel(group.id) ?? group.label : runNodeLabel(group.id);
    return <div key={group.id}><span><b>{label}</b><small>{group.id} · {group.calls} 次</small></span><i><span style={{ width: `${Math.max(4, amount / max * 100)}%` }} /></i><strong>{group.actualPendingCount > 0 ? `¥${group.actualCostCny.toFixed(2)} + ${group.actualPendingCount} 笔待回填` : `¥${group.actualCostCny.toFixed(2)}`}</strong></div>;
  }) : <p>暂无调用数据</p>}</section>;
}

function actualCostLabel(totals: StudioCostTotals): string {
  return totals.actualPendingCount > 0
    ? `¥${totals.actualCostCny.toFixed(2)} 已回填 + ${totals.actualPendingCount} 笔待回填`
    : `¥${totals.actualCostCny.toFixed(2)}`;
}
