import { CircleDollarSign, Clock3, Gauge, ReceiptText, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioCostDashboard, StudioCostGroup, StudioCostRunDetail, StudioCostTotals, StudioProvider } from "../../shared/api.js";
import { catalogModelLabel, providerLabel, runNodeLabel } from "../presentation.js";

export function CostDashboard({ dashboard }: { dashboard: StudioCostDashboard }) {
  return (
    <section className="cost-dashboard" aria-labelledby="cost-dashboard-title">
      <header className="section-heading"><div><p className="eyebrow">费用记录</p><h2 id="cost-dashboard-title">按服务和制作步骤核对费用</h2></div><span>人民币 CNY</span></header>
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

export function RunCostDetailPanel({ detail, providers }: { detail: StudioCostRunDetail; providers?: StudioProvider[] }) {
  const lines = groupCostLines(detail.lines);
  return (
    <section className="run-cost-detail" aria-labelledby="run-cost-title">
      <header className="section-heading"><div><p className="eyebrow">本片费用</p><h2 id="run-cost-title">调用与费用明细</h2></div><ReceiptText aria-hidden="true" size={19} /></header>
      <CostMetrics totals={detail.totals} compact />
      {detail.timing ? <p className="cost-time-summary">制作经过时间：{durationLabel(detail.timing.wallElapsedMs)}（含人工停点）；其中等待你决定：{durationLabel(detail.timing.humanWaitMs)}。本次恢复耗时：{durationLabel(detail.timing.recoveryMs)}。缺少起止记录时不估算。</p> : null}
      <details className="cost-call-details">
        <summary><span><strong>调用与费用明细</strong><small>报价和授权不等于实际消费；结果不明确的调用要核对是否扣费，按配置费率登记的金额仍需与服务商账单核对。</small></span><b>{lines.length} 项</b></summary>
        <div className="cost-line-list">
          {lines.length ? lines.map((line) => <article key={line.id}><span><strong>{line.role ?? runNodeLabel(line.nodeId)}</strong><small>{line.nodeId === "assets" ? "实际生成：" : ""}{capabilityLabel(line, providers)}</small></span><span><small>{line.callCount > 1 ? `${line.callCount} 份记录 · ` : ""}{costLineLabel(line)}</small><b>{line.billing === "unverified" ? "金额未核实" : line.actualPending ? `待确认是否扣费${line.estimatedCostCny === null ? " · 估价未记录" : ` · 预估 ¥${line.estimatedCostCny.toFixed(2)}`}` : `¥${(line.actualCostCny ?? 0).toFixed(2)}`}</b></span></article>) : <p>本片尚未产生可计量调用。</p>}
        </div>
      </details>
    </section>
  );
}

type GroupedCostLine = StudioCostRunDetail["lines"][number] & { callCount: number };

function groupCostLines(lines: StudioCostRunDetail["lines"]): GroupedCostLine[] {
  const grouped = new Map<string, GroupedCostLine>();
  for (const line of lines) {
    const key = [line.role ?? line.nodeId, line.providerId, line.modelId, line.billing, line.status, line.actualPending, line.actualCostSource, line.legacyUnattributed, line.accountingSource].join("|");
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...line, callCount: 1 });
      continue;
    }
    current.callCount += 1;
    current.estimatedCostCny = current.estimatedCostCny === null || line.estimatedCostCny === null ? null : current.estimatedCostCny + line.estimatedCostCny;
    current.authorizedCostCny = (current.authorizedCostCny ?? 0) + (line.authorizedCostCny ?? 0);
    current.actualCostCny = (current.actualCostCny ?? 0) + (line.actualCostCny ?? 0);
    current.meteredAttemptCount = (current.meteredAttemptCount ?? 0) + (line.meteredAttemptCount ?? 0);
    current.meteredFailedAttemptCount = (current.meteredFailedAttemptCount ?? 0) + (line.meteredFailedAttemptCount ?? 0);
    current.modelCallCount = (current.modelCallCount ?? 0) + (line.modelCallCount ?? 0);
    current.callCountPending = current.callCountPending === true || line.callCountPending === true;
  }
  return [...grouped.values()];
}

function CostMetrics({ totals, compact = false }: { totals: StudioCostTotals; compact?: boolean }) {
  const hasExecutionDetail = totals.newBrokerRequestsThisAttempt !== undefined
    || totals.cumulativeProviderMs !== undefined || totals.cumulativeRequestMs !== undefined;
  return <><div className={compact ? "cost-metrics is-compact" : "cost-metrics"}>
    <article><CircleDollarSign aria-hidden="true" size={17} /><span>已记录费用<small>含服务商回传和按配置费率登记的金额；部分仍需与账单核对。</small></span><strong>{actualCostLabel(totals)}</strong></article>
    <article><Gauge aria-hidden="true" size={17} /><span>历史累计报价授权额<small>不是实际消费，也不是当前可用额度。</small></span><strong>¥{totals.authorizedCostCny.toFixed(2)}</strong></article>
    <article><Clock3 aria-hidden="true" size={17} /><span>待确认是否扣费</span><strong>{totals.actualPendingCount}</strong></article>
    <article><RotateCcw aria-hidden="true" size={17} /><span>付费服务失败</span><strong>{totals.failedMeteredCalls}</strong></article>
    {/* T04：计数口径按物理执行归并。旧快照未归属时不假装精确，也不把快照相加成总数。 */}
    <article><ReceiptText aria-hidden="true" size={17} /><span>已核实模型调用<small>{totals.countExact !== true
      ? `另有 ${totals.legacyUnattributedReceipts ?? 0} 份旧累计回执尚未归属，或缺少请求尝试证据；总调用数未完全核定。`
      : "按物理请求归并模型尝试，内部修复不重复计数。"}</small></span>
      <strong>{totals.verifiedModelAttempts ?? 0}{(totals.legacyUnattributedReceipts ?? 0) > 0 ? `＋${totals.legacyUnattributedReceipts} 份待核` : ""}</strong></article>
    <article><ReceiptText aria-hidden="true" size={17} /><span>已核实模型请求<small>一个请求可能包含多次模型尝试；不是素材采购次数。</small></span><strong>{totals.verifiedBrokerRequests ?? 0}</strong></article>
  </div>
  {hasExecutionDetail ? <details className="cost-call-details cost-execution-details">
    <summary><span><strong>模型调用与等待时间</strong><small>展开查看新增调用、排队和模型处理；缺少记录时不估算。</small></span></summary>
    {totals.newBrokerRequestsThisAttempt !== undefined ? <p>本次新增：{totals.newBrokerRequestsThisAttempt ?? "未核定"} 个请求 · {totals.newModelAttemptsThisAttempt ?? "未核定"} 次模型尝试。查回旧结果不算新增。</p> : null}
    {totals.cumulativeProviderMs !== undefined ? <p>累计模型处理：{durationLabel(totals.cumulativeProviderMs)}；累计排队：{durationLabel(totals.cumulativeQueueMs)}。仅统计唯一请求，不含人工等待，也不是制作总时长。</p> : null}
    {totals.cumulativeRequestMs !== undefined ? <p>累计请求耗时：{durationLabel(totals.cumulativeRequestMs)}；请求占用的时间跨度（重叠部分只算一次）：{durationLabel(totals.requestWallUnionMs)}。</p> : null}
  </details> : null}
    {(totals.countConflicts ?? 0) > 0 ? <p className="cost-conflict-note" role="status">{totals.countConflicts} 条同请求回执存在金额或状态矛盾；已保留先到账，请与服务商账单核对后再采用。</p> : null}
  </>;
}

function CostRanking({ title, groups, kind }: { title: string; groups: StudioCostGroup[]; kind: "provider" | "node" }) {
  const max = Math.max(...groups.map((group) => group.actualCostCny), 1);
  return <section className="cost-ranking"><header><strong>{title}</strong><span>{groups.length} 项</span></header>{groups.length ? groups.map((group) => {
    const amount = group.actualCostCny;
    const label = kind === "provider" ? providerLabel(group.id) ?? group.label : runNodeLabel(group.id);
    return <div key={group.id}><span><b>{label}</b><small>{group.calls} 次执行</small></span><i><span style={{ width: `${Math.max(4, amount / max * 100)}%` }} /></i><strong>{group.actualPendingCount > 0 ? `¥${group.actualCostCny.toFixed(2)} + ${group.actualPendingCount} 笔待确认` : `¥${group.actualCostCny.toFixed(2)}`}</strong></div>;
  }) : <p>暂无调用数据</p>}</section>;
}

const UNRECORDED_MODEL_LABEL = "模型名称未记录";

function capabilityLabel(line: StudioCostRunDetail["lines"][number], providers?: StudioProvider[]): string {
  const provider = providerLabel(line.providerId) ?? "自动制作能力";
  if (!line.modelId || line.modelId === "inline" || line.modelId === line.providerId) return provider;
  // 主界面始终由 RunWorkbench 注入 Provider 目录；未注入目录的旧调用保留原样展示。
  if (providers === undefined) return `${provider} · ${line.modelId}`;
  const model = catalogModelLabel(providers, line.modelId) ?? `模型名称未收录（${line.modelId}）`;
  return model === provider ? provider : `${provider} · ${model}`;
}

function actualCostLabel(totals: StudioCostTotals): string {
  return totals.actualPendingCount > 0
    ? `¥${totals.actualCostCny.toFixed(2)} 已记录 + ${totals.actualPendingCount} 笔待确认`
    : `¥${totals.actualCostCny.toFixed(2)}`;
}

function costLineLabel(line: StudioCostRunDetail["lines"][number]): string {
  if (line.legacyUnattributed) return "历史累计记录尚未归属，不并入已核实调用总数";
  if (line.billing === "unverified") return `${line.modelCallCount ?? 0} 次已确认模型调用${line.callCountPending ? "（计数尚未完整）" : ""} · 收费方式与金额待核账`;
  if ((line.meteredFailedAttemptCount ?? 0) > 0) {
    return line.meteredAttemptCount === undefined
      ? `${line.meteredFailedAttemptCount} 次计费调用明确失败`
      : `${line.meteredFailedAttemptCount} / ${line.meteredAttemptCount} 次计费调用失败`;
  }
  if (line.status === "failed" && line.billing === "subscription") return "订阅任务失败 · 不产生按量费用";
  if (line.status === "failed") return "任务失败";
  if (line.actualCostSource === "configured_rate") return "按配置费率记录 · 非服务商确认账单";
  if (line.actualCostSource === "manual_reconciled") return "人工核对后登记";
  if (line.actualCostSource === "provider_reported") return "服务商回传费用";
  if (line.billing === "metered") return "按量付费";
  if (line.billing === "subscription") return "订阅额度";
  return "免费/本地";
}

function durationLabel(value: number | null | undefined): string {
  return typeof value === "number" ? `${(value / 1000).toFixed(1)} 秒` : "未记录完整";
}
