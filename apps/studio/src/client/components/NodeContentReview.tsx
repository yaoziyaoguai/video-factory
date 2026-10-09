interface NodeContentReviewValue {
  status: "passed" | "has_suggestions" | "not_audited";
  summary: string;
  suggestions: string[];
  auditId?: string;
  history?: NodeContentReviewValue[];
}

export function NodeContentReview({ value }: { value: NodeContentReviewValue }) {
  const title = value.status === "not_audited" ? "本版未审" : value.status === "passed" ? "本版已审计" : "本版有内容建议";
  // 只按明确的审计身份去重；不同轮次即使文字相同，也各自保留原文。
  const seen = new Set(value.auditId ? [value.auditId] : []);
  const previous = (value.history ?? []).filter(entry => {
    if (!entry.auditId) return true;
    if (seen.has(entry.auditId)) return false;
    seen.add(entry.auditId);
    return true;
  });
  const reports = [...previous, value].filter(entry => entry.auditId || entry.status !== "not_audited");
  return <section className="node-content-review" aria-label="本版内容审计">
    <strong>{title}</strong>
    {value.status === "not_audited" ? <p>{value.summary}</p> : null}
    {value.suggestions.length > 0 ? <p>本版有 {value.suggestions.length} 条建议，请查看后决定采用或修改；建议不会自动改稿。</p> : null}
    {reports.length > 0 ? <details>
      <summary>本版审计记录（{reports.length} 次）</summary>
      <ol>{reports.map((entry, index) => <li key={entry.auditId ?? index}>
        {entry === value && value.status === "not_audited" ? null : <p>{entry.summary}</p>}
        {entry.suggestions.length > 0 ? <ul>{entry.suggestions.map((suggestion, suggestionIndex) => <li key={suggestionIndex}>{suggestion}</li>)}</ul> : null}
      </li>)}</ol>
    </details> : null}
  </section>;
}

export function nodeContentReview(value: unknown): NodeContentReviewValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const review = (value as Record<string, unknown>).contentReview;
  const current = parseReview(review);
  if (!current) return undefined;
  const history = (review as Record<string, unknown>).history;
  return { ...current, ...(Array.isArray(history) ? {
    history: history.map(parseReview).filter((entry): entry is NodeContentReviewValue => entry !== undefined),
  } : {}) };
}

function parseReview(value: unknown): NodeContentReviewValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "passed" && candidate.status !== "has_suggestions" && candidate.status !== "not_audited") return undefined;
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.suggestions)) return undefined;
  return {
    status: candidate.status,
    summary: candidate.summary,
    suggestions: candidate.suggestions.filter((item): item is string => typeof item === "string"),
    ...(typeof candidate.auditId === "string" ? { auditId: candidate.auditId } : {}),
  };
}
