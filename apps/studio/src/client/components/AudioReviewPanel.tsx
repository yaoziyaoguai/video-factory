import { AUDIO_REVIEW_CHECKS, validateAudioReviewReport } from "@video-factory/production-pipeline/audio-review";

const LABELS = { pronunciation: "发音与读法", performance: "语气与情绪", pauses: "语速与停顿", noise: "杂音与失真", balance: "人声与配乐音量", audiovisual_alignment: "音画配合" };
const RESULTS = { pass: "未发现问题", issue: "有调整建议", not_observed: "证据不足", not_applicable: "不适用" };

export function AudioReviewPanel({ value }: { value: unknown }) {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (item?.status !== "completed") return <section className="independent-review-panel" aria-label="声音审片">
    <strong>声音审片 · {item?.status === "uncertain" ? "结果待核实" : item?.status === "failed" ? "未完成" : "未审听"}</strong>
    <p>{typeof item?.reason === "string" ? item.reason : "这份报告没有真实音轨审听证据；视觉意见不能证明声音质量。"}</p>
    <small>{item?.status === "uncertain" ? "请查询原声音请求，原声音结果与费用仍待核；是否能进入人工终审，请以当前步骤提供的操作为准。现有成片仍可查看，不会重复购买。" : "是否继续由你决定；不会自动重新购买或生成素材。"}</small>
  </section>;
  try {
    const report = validateAudioReviewReport(item.report, String(item.audioSha256), Number(item.durationMs));
    const hasAudibleObservation = AUDIO_REVIEW_CHECKS.filter((key) => key !== "audiovisual_alignment")
      .some((key) => report.checks[key] === "pass" || report.checks[key] === "issue");
    const coverage = item.observationCoverage && typeof item.observationCoverage === "object"
      ? item.observationCoverage as { observed?: unknown; total?: unknown } : undefined;
    const coverageLabel = coverage && typeof coverage.observed === "number" && typeof coverage.total === "number"
      ? ` · 有效观察 ${coverage.observed}/${coverage.total} 项` : "";
    return <section className="independent-review-panel" aria-label="声音审片">
      <header><strong>声音审片 · {hasAudibleObservation ? "报告已返回" : "未完成有效审听"}</strong><small>{String(item.modelLabel ?? item.modelId ?? "模型身份未记录")}{coverageLabel}</small></header>
      <p>{report.summary}</p>
      <dl>{AUDIO_REVIEW_CHECKS.map((key) => <div key={key}><dt>{LABELS[key]}</dt><dd>{RESULTS[report.checks[key]]}</dd></div>)}</dl>
      {report.findings.length ? <ul>{report.findings.map((finding, index) => <li key={index}>
        <strong>{(finding.startMs / 1000).toFixed(1)}–{(finding.endMs / 1000).toFixed(1)} 秒 · {LABELS[finding.category]}</strong>
        <p>{finding.observation}</p><p>建议：{finding.suggestion}</p>
      </li>)}</ul> : null}
      <small>{hasAudibleObservation ? "检查依据是本版成片混合音轨及抽帧，不代表逐帧口型已核实。" : "报告已保存，但没有可用的听觉观察，不能据此认定声音质量已检查。"}采纳意见与继续制作由你决定。</small>
    </section>;
  } catch {
    return <section className="independent-review-panel" aria-label="声音审片"><strong>声音报告不可验证</strong><p>音轨绑定或时间范围不合法，不能据此认定声音通过。</p></section>;
  }
}
