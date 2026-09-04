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
  const uncertainReceipts = Array.isArray(run.nodeRuns)
    ? run.nodeRuns.flatMap((value) => uncertainReceipt(value, authorizations))
    : [];
  const receipts = mergeReceipts(
    [...nestedReceipts, ...uncertainReceipts],
    Array.isArray(run.executionReceipts) ? run.executionReceipts : [],
  );
  const lines = receipts.flatMap((value, index): StudioCostLine[] => {
    const receipt = isRecord(value) ? value : undefined;
    if (!receipt) return [];
    const id = text(receipt.id) || `${text(receipt.nodeId)}:${text(receipt.startedAt)}:${index}`;
    const nodeId = text(receipt.nodeId);
    const receiptProviderId = text(receipt.providerId);
    const receiptModelId = text(receipt.modelId) || text(receipt.model) || "unknown";
    const startedAt = text(receipt.startedAt);
    if (!id || !nodeId || !receiptProviderId || !startedAt) return [];
    const { providerId, modelId } = actualMediaAttribution(receipt, receiptProviderId, receiptModelId);
    const billing = billingType(receipt.billing);
    const receiptAuthorizationId = text(receipt.spendAuthorizationId);
    const authorization = [...authorizations].reverse().find((value) => {
      if (!isRecord(value)) return false;
      if (receiptAuthorizationId) return value.id === receiptAuthorizationId;
      return value.nodeId === nodeId
        && value.providerId === receiptProviderId
        && (value.modelId === receiptModelId || value.modelId === undefined);
    });
    const actualCost = nonNegativeNumber(receipt.actualCostCny);
    const actualCostSource = receipt.actualCostSource === "provider_reported" || receipt.actualCostSource === "configured_rate"
      ? receipt.actualCostSource
      : undefined;
    const status = receipt.status === "failed" ? "failed" : receipt.status === "succeeded" ? "succeeded" : "unknown";
    const reportedMeteredAttemptCount = nonNegativeInteger(receipt.meteredAttemptCount);
    const hasAcceptedMeteredRequest = actualCost !== undefined
      || (typeof receipt.requestId === "string" && receipt.requestId.trim().length > 0);
    const meteredAttemptCount = billing === "metered"
      ? reportedMeteredAttemptCount ?? (hasAcceptedMeteredRequest ? 1 : undefined)
      : undefined;
    const reportedFailedAttemptCount = nonNegativeInteger(receipt.meteredFailedAttemptCount);
    const meteredFailedAttemptCount = billing === "metered" && reportedFailedAttemptCount !== undefined
      ? Math.min(reportedFailedAttemptCount, meteredAttemptCount ?? reportedFailedAttemptCount)
      : undefined;
    const parameters = isRecord(receipt.parameters) ? receipt.parameters : undefined;
    const subscriptionCallCount = billing === "subscription"
      ? nonNegativeInteger(parameters?.modelCallCount) ?? 1
      : undefined;
    const estimatedCostCny = nonNegativeNumber(receipt.estimatedCostCny) ?? 0;
    const currentNode = nodes.get(nodeId);
    const definitiveNoSubmission = billing === "metered"
      && reportedMeteredAttemptCount === 0
      && (reportedFailedAttemptCount ?? 0) === 0
      && (actualCost ?? 0) === 0;
    const currentOperationPending = currentNode?.outcomeUncertain === true
      && Boolean(currentNode.operationRequestId)
      && currentNode.operationRequestId === text(receipt.requestId)
      && !definitiveNoSubmission;
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
      ...(actualCostSource !== undefined ? { actualCostSource } : {}),
      ...(meteredAttemptCount !== undefined ? { meteredAttemptCount } : {}),
      ...(meteredFailedAttemptCount !== undefined ? { meteredFailedAttemptCount } : {}),
      ...(subscriptionCallCount !== undefined ? { subscriptionCallCount } : {}),
      actualPending: billing === "metered"
        && !definitiveNoSubmission
        && (actualCost === undefined || currentOperationPending),
      startedAt,
      ...(text(receipt.finishedAt) ? { finishedAt: text(receipt.finishedAt) } : {}),
    }];
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return { runId: run.id, title, totals: totals(lines), lines };
}

function actualMediaAttribution(
  receipt: Record<string, unknown>,
  providerId: string,
  modelId: string,
): { providerId: string; modelId: string } {
  if (providerId !== "ai-shot-router-v1" || !Array.isArray(receipt.actualModelIds)) {
    return { providerId, modelId };
  }
  const actualModelIds = [...new Set(receipt.actualModelIds.map(text).filter(Boolean))];
  const providers = actualModelIds.map(actualMediaProviderId);
  if (actualModelIds.length === 0 || providers.some((value) => value === undefined)) {
    return { providerId, modelId };
  }
  const uniqueProviders = [...new Set(providers as string[])];
  if (uniqueProviders.length !== 1) return { providerId, modelId };
  return { providerId: uniqueProviders[0]!, modelId: actualModelIds.join("、") };
}

function actualMediaProviderId(modelId: string): string | undefined {
  if (["seedream-image-v1", "seedance-video-v1", "hailuo-video-v1", "wan-video-v1"].includes(modelId)) return modelId;
  const normalized = modelId.toLocaleLowerCase();
  if (normalized.startsWith("doubao-seedream-")) return "seedream-image-v1";
  if (normalized.startsWith("doubao-seedance-") || normalized.includes("seedance")) return "seedance-video-v1";
  if (normalized.startsWith("minimax-hailuo-") || normalized.startsWith("minimax-h3") || normalized.includes("hailuo")) return "hailuo-video-v1";
  if (normalized.startsWith("wan")) return "wan-video-v1";
  return undefined;
}

function uncertainReceipt(value: unknown, authorizations: unknown[]): Record<string, unknown>[] {
  if (!isRecord(value) || value.outcomeUncertain !== true || isRecord(value.executionReceipt)) return [];
  const authorizationId = text(value.spendAuthorizationId);
  const authorization = authorizations.find((candidate) => isRecord(candidate) && candidate.id === authorizationId);
  if (!authorizationId || !isRecord(authorization)) return [];
  const plan = isRecord(value.spendPlan) ? value.spendPlan : undefined;
  const startedAt = text(value.startedAt) || text(authorization.approvedAt);
  const nodeId = text(value.nodeId);
  const providerId = text(authorization.providerId) || text(plan?.providerId);
  const modelId = text(authorization.modelId) || text(plan?.modelId);
  if (!startedAt || !nodeId || !providerId || !modelId) return [];
  return [{
    id: `uncertain:${authorizationId}:${text(value.operationRequestId) || startedAt}`,
    nodeId,
    providerId,
    modelId,
    capability: "unknown",
    billing: "metered",
    status: "unknown",
    spendAuthorizationId: authorizationId,
    authorizedCostCny: nonNegativeNumber(authorization.maxCostCny),
    estimatedCostCny: nonNegativeNumber(plan?.estimatedCostCny) ?? 0,
    meteredAttemptCount: 1,
    ...(text(value.operationRequestId) ? { requestId: text(value.operationRequestId) } : {}),
    startedAt,
  }];
}

function mergeReceipts(current: unknown[], history: unknown[]): unknown[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const [index, value] of [...current, ...history].entries()) {
    if (!isRecord(value)) continue;
    const requestId = text(value.requestId);
    const key = requestId
      ? `request:${text(value.nodeId)}:${requestId}`
      : [value.nodeId, value.startedAt, value.providerId, value.modelId ?? value.model]
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
    meteredCalls: sum(lines, (line) => line.billing === "metered" ? line.meteredAttemptCount ?? 0 : 0),
    subscriptionCalls: sum(lines, (line) => line.billing === "subscription" ? line.subscriptionCallCount ?? 1 : 0),
    freeCalls: lines.filter((line) => line.billing === "free" || line.billing === "local_compute").length,
    failedMeteredCalls: sum(lines, (line) => line.billing === "metered" ? line.meteredFailedAttemptCount ?? 0 : 0),
  };
}

function group(lines: StudioCostLine[], key: (line: StudioCostLine) => string): StudioCostGroup[] {
  const groups = new Map<string, StudioCostLine[]>();
  for (const line of lines) groups.set(key(line), [...(groups.get(key(line)) ?? []), line]);
  return [...groups.entries()].map(([id, items]) => ({
    id,
    label: id,
    calls: sum(items, (item) => item.billing === "metered"
      ? item.meteredAttemptCount ?? 0
      : item.billing === "subscription"
        ? item.subscriptionCallCount ?? 1
        : 1),
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

function nodeMap(value: unknown): Map<string, {
  role?: string;
  status?: string;
  outcomeUncertain?: boolean;
  operationRequestId?: string;
}> {
  const result = new Map<string, {
    role?: string;
    status?: string;
    outcomeUncertain?: boolean;
    operationRequestId?: string;
  }>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item) || !text(item.nodeId)) continue;
    result.set(text(item.nodeId), {
      ...(text(item.role) ? { role: text(item.role) } : {}),
      ...(text(item.status) ? { status: text(item.status) } : {}),
      ...(item.outcomeUncertain === true ? { outcomeUncertain: true } : {}),
      ...(text(item.operationRequestId) ? { operationRequestId: text(item.operationRequestId) } : {}),
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

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
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
