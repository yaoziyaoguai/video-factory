interface NodeContentReviewValue {
  status: "passed" | "has_suggestions" | "not_audited";
  summary: string;
  suggestions: string[];
}

export function NodeContentReview({ value }: { value: NodeContentReviewValue }) {
  const title = value.status === "not_audited" ? "本版未审" : value.status === "passed" ? "本版已审计" : "本版有内容建议";
  return <section className="node-content-review" aria-label="本版内容审计">
    <strong>{title}</strong>
    <p>{value.summary}</p>
    {value.suggestions.length > 0 ? <ul>{value.suggestions.map((suggestion, index) => <li key={`${index}:${suggestion}`}>{suggestion}</li>)}</ul> : null}
  </section>;
}

export function nodeContentReview(value: unknown): NodeContentReviewValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const review = (value as Record<string, unknown>).contentReview;
  if (typeof review !== "object" || review === null || Array.isArray(review)) return undefined;
  const candidate = review as Record<string, unknown>;
  if (candidate.status !== "passed" && candidate.status !== "has_suggestions" && candidate.status !== "not_audited") return undefined;
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.suggestions)) return undefined;
  return {
    status: candidate.status,
    summary: candidate.summary,
    suggestions: candidate.suggestions.filter((item): item is string => typeof item === "string"),
  };
}
