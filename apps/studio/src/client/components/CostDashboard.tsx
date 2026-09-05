import { CircleDollarSign, Clock3, Gauge, ReceiptText, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioCostDashboard, StudioCostGroup, StudioCostRunDetail, StudioCostTotals } from "../../shared/api.js";
import { providerLabel, runNodeLabel } from "../presentation.js";

export function CostDashboard({ dashboard }: { dashboard: StudioCostDashboard }) {
  return (
    <section className="cost-dashboard" aria-labelledby="cost-dashboard-title">
      <header className="section-heading"><div><p className="eyebrow">费用记录</p><h2 id="cost-dashboard-title">每一笔费用都能追到制作步骤</h2></div><span>人民币 CNY</span></header>
      <CostMetrics totals={dashboard.totals} />
      <div className="cost-dashboard-grid">
        <CostRanking title="按实际服务" groups={dashboard.byProvider} kind="provider" />
        <CostRanking title="按制作步骤" groups={dashboard.byNode} kind="node" />
      </div>
      <div className="cost-run-table">
        <header><strong>视频明细</strong><span>{dashboard.runs.length} 条制作</span></header>
        {dashboard.runs.length ? dashboard.runs.map((run) => <Link to={`/projects/${run.runId}`} key={run.runId}><span><strong>{run.title}</strong><small>{run.totals.meteredCalls} 次按量调用 · {run.totals.failedMeteredCalls} 次明确失败 · {run.totals.actualPendingCount} 笔待确认是否扣费</small></span><b>{actualCostLabel(run.totals)}</b></Link>) : <p>产生制作调用后，这里会按视频汇总。</p>}
      </div>
    </section>
  );
}

export function RunCostDetailPanel({ detail }: { detail: StudioCostRunDetail }) {
  const lines = groupCostLines(detail.lines);
  return (
    <section className="run-cost-detail" aria-labelledby="run-cost-title">
      <header className="section-heading"><div><p className="eyebrow">本片费用</p><h2 id="run-cost-title">费用明细</h2></div><ReceiptText aria-hidden="true" size={19} /></header>
      <CostMetrics totals={detail.totals} compact />
      <details className="cost-call-details">
        <summary><span><strong>逐角色消费明细</strong><small>报价不等于消费；只有外部任务结果不明确时才需确认是否扣费</small></span><b>{lines.length} 项</b></summary>
        <div className="cost-line-list">
          {lines.length ? lines.map((line) => <article key={line.id}><span><strong>{line.role ?? runNodeLabel(line.nodeId)}</strong><small>{line.nodeId === "assets" ? "实际生成：" : ""}{capabilityLabel(line)}</small></span><span><small>{line.callCount > 1 ? `${line.callCount} 次执行 · ` : ""}{costLineLabel(line)}</small><b>{line.actualPending ? `待确认是否扣费 · 预估 ¥${line.estimatedCostCny.toFixed(2)}` : `¥${(line.actualCostCny ?? 0).toFixed(2)}`}</b></span></article>) : <p>本片尚未产生可计量调用。</p>}
        </div>
      </details>
    </section>
  );
}

type GroupedCostLine = StudioCostRunDetail["lines"][number] & { callCount: number };

function groupCostLines(lines: StudioCostRunDetail["lines"]): GroupedCostLine[] {
  const grouped = new Map<string, GroupedCostLine>();
  for (const line of lines) {
    const key = [line.role ?? line.nodeId, line.providerId, line.modelId, line.billing, line.status, line.actualPending, line.actualCostSource].join("|");
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...line, callCount: 1 });
      continue;
    }
    current.callCount += 1;
    current.estimatedCostCny += line.estimatedCostCny;
    current.authorizedCostCny = (current.authorizedCostCny ?? 0) + (line.authorizedCostCny ?? 0);
    current.actualCostCny = (current.actualCostCny ?? 0) + (line.actualCostCny ?? 0);
    current.meteredAttemptCount = (current.meteredAttemptCount ?? 0) + (line.meteredAttemptCount ?? 0);
    current.meteredFailedAttemptCount = (current.meteredFailedAttemptCount ?? 0) + (line.meteredFailedAttemptCount ?? 0);
  }
  return [...grouped.values()];
}

function CostMetrics({ totals, compact = false }: { totals: StudioCostTotals; compact?: boolean }) {
  return <div className={compact ? "cost-metrics is-compact" : "cost-metrics"}>
    <article><CircleDollarSign aria-hidden="true" size={17} /><span>实际消费</span><strong>{actualCostLabel(totals)}</strong></article>
    <article title="历史所有已确认报价的总额，不是费用上限，也不代表实际消费"><Gauge aria-hidden="true" size={17} /><span>已批准报价合计</span><strong>¥{totals.authorizedCostCny.toFixed(2)}</strong></article>
    <article><Clock3 aria-hidden="true" size={17} /><span>待确认是否扣费</span><strong>{totals.actualPendingCount}</strong></article>
    <article><RotateCcw aria-hidden="true" size={17} /><span>付费服务失败</span><strong>{totals.failedMeteredCalls}</strong></article>
  </div>;
}

function CostRanking({ title, groups, kind }: { title: string; groups: StudioCostGroup[]; kind: "provider" | "node" }) {
  const max = Math.max(...groups.map((group) => group.actualCostCny || group.estimatedCostCny), 1);
  return <section className="cost-ranking"><header><strong>{title}</strong><span>{groups.length} 项</span></header>{groups.length ? groups.map((group) => {
    const amount = group.actualCostCny || group.estimatedCostCny;
    const label = kind === "provider" ? providerLabel(group.id) ?? group.label : runNodeLabel(group.id);
    return <div key={group.id}><span><b>{label}</b><small>{group.calls} 次执行</small></span><i><span style={{ width: `${Math.max(4, amount / max * 100)}%` }} /></i><strong>{group.actualPendingCount > 0 ? `¥${group.actualCostCny.toFixed(2)} + ${group.actualPendingCount} 笔待确认` : `¥${group.actualCostCny.toFixed(2)}`}</strong></div>;
  }) : <p>暂无调用数据</p>}</section>;
}

function capabilityLabel(line: StudioCostRunDetail["lines"][number]): string {
  const provider = providerLabel(line.providerId) ?? "自动制作能力";
  if (!line.modelId || line.modelId === "inline" || line.modelId === line.providerId) return provider;
  return `${provider} · ${line.modelId}`;
}

function actualCostLabel(totals: StudioCostTotals): string {
  return totals.actualPendingCount > 0
    ? `¥${totals.actualCostCny.toFixed(2)} 已核算 + ${totals.actualPendingCount} 笔待确认`
    : `¥${totals.actualCostCny.toFixed(2)}`;
}

function costLineLabel(line: StudioCostRunDetail["lines"][number]): string {
  if ((line.meteredFailedAttemptCount ?? 0) > 0) {
    return line.meteredAttemptCount === undefined
      ? `${line.meteredFailedAttemptCount} 次计费调用明确失败`
      : `${line.meteredFailedAttemptCount} / ${line.meteredAttemptCount} 次计费调用失败`;
  }
  if (line.status === "failed" && line.billing === "subscription") return "订阅任务失败 · 不产生按量费用";
  if (line.status === "failed") return "任务失败";
  if (line.actualCostSource === "configured_rate") return "按配置单价核算";
  if (line.actualCostSource === "provider_reported") return "供应商账单回填";
  if (line.billing === "metered") return "按量付费";
  if (line.billing === "subscription") return "订阅额度";
  return "免费/本地";
}
