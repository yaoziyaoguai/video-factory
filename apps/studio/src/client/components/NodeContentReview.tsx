interface NodeContentReviewValue {
  status: "passed" | "has_suggestions" | "not_audited";
  summary: string;
  suggestions: string[];
  auditId?: string;
  history?: NodeContentReviewValue[];
}

export function NodeContentReview({ value }: { value: NodeContentReviewValue }) {
  const title = value.status === "not_audited" ? "本版未审" : value.status === "passed" ? "本版已审计" : "本版有内容建议";
  return <section className="node-content-review" aria-label="本版内容审计">
    <strong>{title}</strong>
    <p>{value.summary}</p>
    {value.suggestions.length > 0 ? <ul>{value.suggestions.map((suggestion, index) => <li key={`${index}:${suggestion}`}>{suggestion}</li>)}</ul> : null}
    {value.history?.length ? <details>
      <summary>本版审计记录（{value.history.length} 次）</summary>
      <ol>{value.history.map((entry, index) => <li key={entry.auditId ?? index}>
        <p>{entry.summary}</p>
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
