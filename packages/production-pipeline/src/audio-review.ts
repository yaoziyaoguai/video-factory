export const AUDIO_REVIEW_CHECKS = ["pronunciation", "performance", "pauses", "noise", "balance", "audiovisual_alignment"] as const;
export type AudioReviewCheck = typeof AUDIO_REVIEW_CHECKS[number];
export type AudioReviewCheckResult = "pass" | "issue" | "not_observed" | "not_applicable";
export interface AudioReviewReport {
  audioSha256: string;
  summary: string;
  checks: Record<AudioReviewCheck, AudioReviewCheckResult>;
  findings: Array<{ startMs: number; endMs: number; category: AudioReviewCheck; observation: string; suggestion: string }>;
}
export type AudioReviewResult = {
  status: "completed";
  modelId: string;
  modelLabel: string;
  videoSha256: string;
  audioSha256: string;
  durationMs: number;
  report: AudioReviewReport;
  /** 有效观察覆盖度：全 not_observed/not_applicable 时为 0，不能当作声音通过。 */
  observationCoverage?: { observed: number; total: number };
  trace?: import("./codex-chat.js").CodexTaskTrace;
} | { status: "not_configured" | "not_reviewed" | "failed" | "uncertain"; reason: string };

/** 视觉已结束无结论时携带独立声音事实；不把声音结果伪装成视觉报告。 */
export class VisualReviewWithAudioError extends Error {
  constructor(readonly visualError: unknown, readonly audioReview: AudioReviewResult) {
    super("视觉审片未形成有效结论，声音审片事实已保留。", { cause: visualError });
    this.name = "VisualReviewWithAudioError";
  }
}

export function audioReviewObservationCoverage(report: AudioReviewReport): { observed: number; total: number } {
  const total = AUDIO_REVIEW_CHECKS.length;
  const observed = AUDIO_REVIEW_CHECKS.filter((key) => report.checks[key] === "pass" || report.checks[key] === "issue").length;
  return { observed, total };
}

export function validateAudioReviewReport(value: unknown, audioSha256: string, durationMs: number): AudioReviewReport {
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("声音证据时长无效。");
  if (!value || typeof value !== "object") throw new Error("声音审片结果格式无效。");
  const report = value as AudioReviewReport;
  if (report.audioSha256 !== audioSha256 || !/^[a-f0-9]{64}$/.test(audioSha256)) throw new Error("声音审片结果不属于本次音轨。");
  if (typeof report.summary !== "string" || !report.summary.trim() || report.summary.length > 2000) throw new Error("声音审片摘要无效。");
  if (!report.checks || AUDIO_REVIEW_CHECKS.some((key) => !["pass", "issue", "not_observed", "not_applicable"].includes(report.checks[key]))) throw new Error("声音审片未逐项说明证据覆盖。");
  if (!Array.isArray(report.findings) || report.findings.length > 40) throw new Error("声音审片问题列表无效。");
  for (const finding of report.findings) {
    if (!finding || typeof finding !== "object") throw new Error("声音审片问题格式无效。");
    if (!Number.isInteger(finding.startMs) || !Number.isInteger(finding.endMs) || finding.startMs < 0 || finding.endMs <= finding.startMs || finding.endMs > durationMs
      || !AUDIO_REVIEW_CHECKS.includes(finding.category) || typeof finding.observation !== "string" || !finding.observation.trim() || finding.observation.length > 2000
      || typeof finding.suggestion !== "string" || !finding.suggestion.trim() || finding.suggestion.length > 2000) throw new Error("声音审片缺少有效的时间范围或具体建议。");
    if (report.checks[finding.category] !== "issue") throw new Error("声音问题与逐项结论矛盾。");
  }
  if (AUDIO_REVIEW_CHECKS.some((key) => report.checks[key] === "issue" && !report.findings.some((finding) => finding.category === key))) throw new Error("声音问题必须提供时间定位。");
  return report;
}
