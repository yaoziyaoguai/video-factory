export interface ModelTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** attempt 在一个不可变 broker request 内编号；重放不能产生新的编号。 */
export interface ModelAttemptUsage {
  attempt: number;
  usage: ModelTokenUsage | null;
  requestIdHash?: string;
}

const TOKEN_FIELDS = ["promptTokens", "completionTokens", "totalTokens", "reasoningTokens"] as const;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function modelAttemptUsage(attempt: number, diagnostics: ModelTokenUsage & { requestIdHash?: string }): ModelAttemptUsage {
  const usage = Object.fromEntries(TOKEN_FIELDS.flatMap((field) => count(diagnostics[field]) ? [[field, diagnostics[field]]] : []));
  return { attempt, usage: Object.keys(usage).length ? usage : null,
    ...(diagnostics.requestIdHash ? { requestIdHash: diagnostics.requestIdHash } : {}) };
}

export function parseModelAttempts(value: unknown): ModelAttemptUsage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid model attempt usage.");
  return value.map((item, index) => {
    if (!record(item) || item.attempt !== index + 1 || !(item.usage === null || record(item.usage))
      || item.requestIdHash !== undefined && (typeof item.requestIdHash !== "string" || !/^[a-f0-9]{64}$/.test(item.requestIdHash))) {
      throw new Error("Invalid model attempt identity.");
    }
    const usage: ModelTokenUsage = {};
    if (item.usage !== null) for (const field of TOKEN_FIELDS) {
      const value = item.usage[field];
      if (value === undefined) continue;
      if (!count(value)) throw new Error("Invalid model attempt token count.");
      usage[field] = value;
    }
    return { attempt: index + 1, usage: item.usage === null ? null : usage,
      ...(typeof item.requestIdHash === "string" ? { requestIdHash: item.requestIdHash } : {}) };
  });
}

/** 仅汇总已返回的用量；缺失不能以零补齐，也不能反推历史各次尝试。 */
export function summarizeModelAttemptUsage(modelAttempts: readonly ModelAttemptUsage[], expectedCount = modelAttempts.length) {
  const totals: ModelTokenUsage = {};
  for (const field of TOKEN_FIELDS) {
    const values = modelAttempts.flatMap((item) => item.usage?.[field] === undefined ? [] : [item.usage[field]!]);
    if (values.length) totals[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return {
    ...totals,
    modelAttempts: modelAttempts.map((item) => ({ ...item, usage: item.usage ? { ...item.usage } : null })),
    usageComplete: modelAttempts.length === expectedCount && modelAttempts.every((item) =>
      item.usage !== null && [item.usage.promptTokens, item.usage.completionTokens, item.usage.totalTokens].every(count)),
  };
}
