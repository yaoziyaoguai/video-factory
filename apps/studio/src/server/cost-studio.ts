import type {
  StudioBillingType,
  StudioCostDashboard,
  StudioCostGroup,
  StudioCostLine,
  StudioCostRunDetail,
  StudioCostTotals,
} from "../shared/api.js";

interface CostRunSource {
  id: string;
  initialInput?: unknown;
  nodeRuns?: unknown;
  executionReceipts?: unknown;
  spendAuthorizations?: unknown;
}

export class CostStudio {
  constructor(private readonly listRuns: () => Promise<CostRunSource[]>) {}

  async dashboard(): Promise<StudioCostDashboard> {
    const details = (await this.listRuns()).map((run) => toRunDetail(run));
    const lines = details.flatMap((detail) => detail.lines);
    return {
      currency: "CNY",
      totals: totals(lines),
      byProvider: group(lines, (line) => line.providerId).map((item) => ({ ...item, providerId: item.id })),
      byNode: group(lines, (line) => line.nodeId).map((item) => ({ ...item, nodeId: item.id })),
      runs: details.map(({ lines: _lines, ...summary }) => summary),
    };
  }

  async runDetail(runId: string): Promise<StudioCostRunDetail | undefined> {
    const run = (await this.listRuns()).find((candidate) => candidate.id === runId);
    return run ? toRunDetail(run) : undefined;
  }
}

function toRunDetail(run: CostRunSource): StudioCostRunDetail {
  const title = runTitle(run.initialInput);
  const nodes = nodeMap(run.nodeRuns);
  const authorizations = Array.isArray(run.spendAuthorizations) ? run.spendAuthorizations : [];
  const nestedReceipts = Array.isArray(run.nodeRuns)
    ? run.nodeRuns.flatMap((value) => isRecord(value) && isRecord(value.executionReceipt)
      ? [{ ...value.executionReceipt, nodeId: value.nodeId, spendAuthorizationId: value.spendAuthorizationId }]
      : [])
    : [];
  const receipts = mergeReceipts(
    nestedReceipts,
    Array.isArray(run.executionReceipts) ? run.executionReceipts : [],
  );
  const lines = receipts.flatMap((value, index): StudioCostLine[] => {
    const receipt = isRecord(value) ? value : undefined;
    if (!receipt) return [];
    const id = text(receipt.id) || `${text(receipt.nodeId)}:${text(receipt.startedAt)}:${index}`;
    const nodeId = text(receipt.nodeId);
    const providerId = text(receipt.providerId);
    const modelId = text(receipt.modelId) || text(receipt.model) || "unknown";
    const startedAt = text(receipt.startedAt);
    if (!id || !nodeId || !providerId || !startedAt) return [];
    const billing = billingType(receipt.billing);
    const receiptAuthorizationId = text(receipt.spendAuthorizationId);
    const authorization = [...authorizations].reverse().find((value) => {
      if (!isRecord(value)) return false;
      if (receiptAuthorizationId) return value.id === receiptAuthorizationId;
      return value.nodeId === nodeId && value.providerId === providerId && (value.modelId === modelId || value.modelId === undefined);
    });
    const actualCost = nonNegativeNumber(receipt.actualCostCny);
    const status = receipt.status === "failed" ? "failed" : receipt.status === "succeeded" ? "succeeded" : "unknown";
    const estimatedCostCny = nonNegativeNumber(receipt.estimatedCostCny) ?? 0;
    const authorizedCostCny = nonNegativeNumber(receipt.authorizedCostCny)
      ?? (isRecord(authorization) ? nonNegativeNumber(authorization.maxCostCny) : undefined)
      // 旧回执没有固化授权上限；按已执行的预估额恢复保守基线，并沿用旧版去重规则。
      ?? (billing === "metered" && estimatedCostCny > 0 ? estimatedCostCny : undefined);
    const spendAuthorizationId = receiptAuthorizationId || (isRecord(authorization) ? text(authorization.id) : "");
    return [{
      id,
      runId: run.id,
      runTitle: title,
      nodeId,
      ...(nodes.get(nodeId)?.role ? { role: nodes.get(nodeId)!.role } : {}),
      capability: text(receipt.capability) || "unknown",
      providerId,
      modelId,
      billing,
      status,
      estimatedCostCny,
      ...(authorizedCostCny !== undefined
        ? { authorizedCostCny }
        : {}),
      ...(spendAuthorizationId ? { spendAuthorizationId } : {}),
      ...(actualCost !== undefined ? { actualCostCny: actualCost } : {}),
      actualPending: billing === "metered" && actualCost === undefined,
      startedAt,
      ...(text(receipt.finishedAt) ? { finishedAt: text(receipt.finishedAt) } : {}),
    }];
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return { runId: run.id, title, totals: totals(lines), lines };
}

function mergeReceipts(current: unknown[], history: unknown[]): unknown[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const [index, value] of [...current, ...history].entries()) {
    if (!isRecord(value)) continue;
    const key = [value.nodeId, value.startedAt, value.providerId, value.modelId ?? value.model]
      .map(text)
      .filter(Boolean)
      .join(":") || `receipt:${index}`;
    merged.set(key, { ...(merged.get(key) ?? {}), ...value });
  }
  return [...merged.values()];
}

function totals(lines: StudioCostLine[]): StudioCostTotals {
  return {
    estimatedCostCny: money(sum(lines, (line) => line.estimatedCostCny)),
    authorizedCostCny: uniqueAuthorizedCost(lines),
    actualCostCny: money(sum(lines, (line) => line.actualCostCny ?? 0)),
    actualPendingCount: lines.filter((line) => line.actualPending).length,
    meteredCalls: lines.filter((line) => line.billing === "metered").length,
    subscriptionCalls: lines.filter((line) => line.billing === "subscription").length,
    freeCalls: lines.filter((line) => line.billing === "free" || line.billing === "local_compute").length,
    failedMeteredCalls: lines.filter((line) => line.billing === "metered" && line.status === "failed").length,
  };
}

function group(lines: StudioCostLine[], key: (line: StudioCostLine) => string): StudioCostGroup[] {
  const groups = new Map<string, StudioCostLine[]>();
  for (const line of lines) groups.set(key(line), [...(groups.get(key(line)) ?? []), line]);
  return [...groups.entries()].map(([id, items]) => ({
    id,
    label: id,
    calls: items.length,
    estimatedCostCny: money(sum(items, (item) => item.estimatedCostCny)),
    actualCostCny: money(sum(items, (item) => item.actualCostCny ?? 0)),
    actualPendingCount: items.filter((item) => item.actualPending).length,
  })).sort((left, right) => right.actualCostCny - left.actualCostCny || right.estimatedCostCny - left.estimatedCostCny);
}

function uniqueAuthorizedCost(lines: StudioCostLine[]): number {
  const seen = new Set<string>();
  return money(sum(lines, (line) => {
    if (line.authorizedCostCny === undefined) return 0;
    const key = line.spendAuthorizationId ?? `legacy:${line.runId}:${line.nodeId}:${line.providerId}:${line.modelId}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    return line.authorizedCostCny;
  }));
}

function nodeMap(value: unknown): Map<string, { role?: string; status?: string }> {
  const result = new Map<string, { role?: string; status?: string }>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item) || !text(item.nodeId)) continue;
    result.set(text(item.nodeId), {
      ...(text(item.role) ? { role: text(item.role) } : {}),
      ...(text(item.status) ? { status: text(item.status) } : {}),
    });
  }
  return result;
}

function runTitle(value: unknown): string {
  return isRecord(value) && text(value.title) ? text(value.title) : "未命名制作";
}

function billingType(value: unknown): StudioBillingType {
  return value === "subscription" || value === "metered" || value === "local_compute" || value === "human" ? value : "free";
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function money(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
