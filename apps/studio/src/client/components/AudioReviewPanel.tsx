import { AUDIO_REVIEW_CHECKS, validateAudioReviewReport } from "@video-factory/production-pipeline/audio-review";

const LABELS = { pronunciation: "发音与读法", performance: "语气与情绪", pauses: "语速与停顿", noise: "杂音与失真", balance: "人声与配乐音量", audiovisual_alignment: "音画配合" };
const RESULTS = { pass: "未发现问题", issue: "有调整建议", not_observed: "证据不足", not_applicable: "不适用" };

export function AudioReviewPanel({ value }: { value: unknown }) {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (item?.status !== "completed") return <section className="independent-review-panel" aria-label="声音审片">
    <strong>声音审片 · {item?.status === "uncertain" ? "结果待核实" : item?.status === "failed" ? "未完成" : "未审听"}</strong>
    <p>{typeof item?.reason === "string" ? item.reason : "这份报告没有真实音轨审听证据；视觉意见不能证明声音质量。"}</p>
    <small>是否继续由你决定；不会自动重新购买或生成素材。</small>
  </section>;
  try {
    const report = validateAudioReviewReport(item.report, String(item.audioSha256), Number(item.durationMs));
    return <section className="independent-review-panel" aria-label="声音审片">
      <header><strong>声音审片 · 报告已返回</strong><small>{String(item.modelLabel ?? item.modelId)}</small></header>
      <p>{report.summary}</p>
      <dl>{AUDIO_REVIEW_CHECKS.map((key) => <div key={key}><dt>{LABELS[key]}</dt><dd>{RESULTS[report.checks[key]]}</dd></div>)}</dl>
      {report.findings.length ? <ul>{report.findings.map((finding, index) => <li key={index}>
        <strong>{(finding.startMs / 1000).toFixed(1)}–{(finding.endMs / 1000).toFixed(1)} 秒 · {LABELS[finding.category]}</strong>
        <p>{finding.observation}</p><p>建议：{finding.suggestion}</p>
      </li>)}</ul> : null}
      <small>检查依据是本版成片混合音轨及抽帧，不代表逐帧口型已核实。采纳意见与继续制作由你决定。</small>
    </section>;
  } catch {
    return <section className="independent-review-panel" aria-label="声音审片"><strong>声音报告不可验证</strong><p>音轨绑定或时间范围不合法，不能据此认定声音通过。</p></section>;
  }
}
