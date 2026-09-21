const identifiers = new Set(["runId", "nodeRunId", "commandId", "requestId", "taskKind", "providerId", "modelId", "capability", "status", "errorType", "category", "reasonCode"]);
const measurements = new Set(["attempt", "elapsedMs", "queueWaitMs", "providerWaitMs", "firstOutputEventMs", "validationMs", "modelAttemptCount", "structuredRepairCount", "exitCode", "candidateCount", "bytes", "httpStatus"]);

/** 只接收诊断事实；不展开 trace/payload，避免提示词、密钥或签名 URL 混入公共日志。 */
export function diagnosticEvent(event: string, facts: Record<string, unknown>, sink: (line: string) => void = console.error): void {
  try {
    const safe = Object.fromEntries(Object.entries(facts).filter(([key, value]) =>
      identifiers.has(key) && typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) && !value.startsWith("sk-")
      || measurements.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e15));
    sink(JSON.stringify({ component: "videofactory", event, timestamp: new Date().toISOString(), ...safe }));
  } catch { /* 日志故障不能改变生产执行或收费结果。 */ }
}
