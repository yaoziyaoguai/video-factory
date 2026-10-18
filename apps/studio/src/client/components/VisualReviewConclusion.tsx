import { VISUAL_REVIEW_PASS_MIN_CONFIDENCE, VISUAL_REVIEW_PASS_MIN_SCORE } from "@video-factory/production-pipeline/visual-evidence-boundary";

interface CoverageRequirement {
  id: string;
  scenePosition: number;
  text: string;
  status: "confirmed" | "failed" | "unconfirmed" | "not_applicable";
}

export interface VisualReviewConclusion {
  label: "有具体修改建议" | "仍有未确认内容" | "抽样中未发现问题";
  coverage?: CoverageRequirement[];
  evidenceLimitations: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 标签依据报告的证据与覆盖范围；revise 本身不能证明作品有缺陷。 */
export function visualReviewConclusion(value: unknown): VisualReviewConclusion {
  const report = asRecord(value) ?? {};
  const findings = Array.isArray(report.findings) ? report.findings.map(asRecord).filter(item => item !== undefined) : [];
  const rawCoverage = asRecord(report.coverage);
  const coverage = rawCoverage?.source === "host" && Array.isArray(rawCoverage.requirements)
    ? rawCoverage.requirements.flatMap((value): CoverageRequirement[] => {
        const item = asRecord(value);
        if (!item || typeof item.id !== "string" || typeof item.text !== "string" || !item.text.trim()
          || typeof item.scenePosition !== "number" || !Number.isSafeInteger(item.scenePosition) || item.scenePosition < 1
          || !["confirmed", "failed", "unconfirmed", "not_applicable"].includes(String(item.status))) return [];
        return [{ id: item.id, text: item.text, scenePosition: item.scenePosition, status: item.status as CoverageRequirement["status"] }];
      }) : undefined;
  const scores = asRecord(report.scores);
  const hasDefect = findings.some(item => item.evidenceStatus === "failed" && (item.severity === "warning" || item.severity === "critical"))
    || coverage?.some(item => item.status === "failed");
  const hasUnknown = findings.some(item => item.evidenceStatus === "not_observed")
    || coverage?.some(item => item.status === "unconfirmed")
    || report.recommendation !== "approve"
    || typeof report.confidence !== "number" || !Number.isFinite(report.confidence) || report.confidence < VISUAL_REVIEW_PASS_MIN_CONFIDENCE
    || Object.values(scores ?? {}).some(score => typeof score !== "number" || !Number.isFinite(score) || score < VISUAL_REVIEW_PASS_MIN_SCORE);
  return {
    label: hasDefect ? "有具体修改建议" : hasUnknown ? "仍有未确认内容" : "抽样中未发现问题",
    ...(coverage ? { coverage } : {}),
    evidenceLimitations: [...new Set(findings.flatMap(item => typeof item.evidenceLimitation === "string" && item.evidenceLimitation.trim()
      ? [item.evidenceLimitation] : []))],
  };
}

export function VisualReviewCoverageDetails({ conclusion }: { conclusion: VisualReviewConclusion }) {
  const { coverage, evidenceLimitations } = conclusion;
  if (!coverage?.length && !evidenceLimitations.length) return null;
  const unknown = coverage?.filter(item => item.status === "unconfirmed") ?? [];
  const failedCount = coverage?.filter(item => item.status === "failed").length ?? 0;
  const notApplicableCount = coverage?.filter(item => item.status === "not_applicable").length ?? 0;
  return <details className="review-full-summary">
    <summary>核对范围与未确认内容</summary>
    {coverage?.length ? <p>按本次审片范围核对已采用要求：{coverage.filter(item => item.status === "confirmed").length} 项有对应证据，{unknown.length} 项未确认
      {failedCount ? `，${failedCount} 项报告不符` : ""}{notApplicableCount ? `，${notApplicableCount} 项不适用` : ""}。这是系统对报告覆盖范围的核对，不是额外一次模型审片。</p> : null}
    {unknown.length ? <ul>{unknown.map(item => <li key={item.id}>镜头 {item.scenePosition}：{item.text}</li>)}</ul> : null}
    {evidenceLimitations.map((limitation, index) => <p key={index}>证据限制：{limitation}</p>)}
  </details>;
}
