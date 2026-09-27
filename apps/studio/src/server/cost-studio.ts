import { isDeepStrictEqual } from "node:util";
import { summarizeModelExecutionFacts, type ModelExecutionProjection } from "@video-factory/production-pipeline";
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
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  interventions?: unknown;
  decisions?: unknown;
  initialInput?: unknown;
  nodeRuns?: unknown;
  executionPlan?: unknown;
  executionReceipts?: unknown;
  spendAuthorizations?: unknown;
}

interface NodeModelUsage {
  nodeId: string;
  providerId: string;
  modelId: string;
  modelCallCount: number;
}

// T04：行直接携带请求身份（公开字段），用于按物理执行归并、去重计数与旧快照折叠。
type CostLineBuild = StudioCostLine;

export class CostStudio {
  constructor(
    private readonly listRuns: () => Promise<CostRunSource[]>,
    private readonly readModelUsage?: (runId: string) => Promise<NodeModelUsage[]>,
    private readonly readPaidReceipts?: (runId: string) => Promise<unknown[]>,
    private readonly readDocumentReceipts?: (runId: string) => Promise<unknown[]>,
    private readonly readExecutionFacts?: (runId: string) => Promise<ModelExecutionProjection>,
  ) {}

  async dashboard(): Promise<StudioCostDashboard> {
    const details = await Promise.all((await this.listRuns()).map((run) => this.detail(run)));
    const lines = details.flatMap((detail) => detail.lines);
    return {
      currency: "CNY",
      totals: { ...totals(lines), ...aggregateExecutionTotals(details.map((detail) => detail.totals)) },
      byProvider: group(lines, (line) => line.providerId).map((item) => ({ ...item, providerId: item.id })),
      byNode: group(lines, (line) => line.nodeId).map((item) => ({ ...item, nodeId: item.id })),
      runs: details.map(({ lines: _lines, ...summary }) => summary),
    };
  }

  async runDetail(runId: string): Promise<StudioCostRunDetail | undefined> {
    const run = (await this.listRuns()).find((candidate) => candidate.id === runId);
    return run ? this.detail(run) : undefined;
  }

  private async detail(run: CostRunSource): Promise<StudioCostRunDetail> {
    const paidReceipts = await this.readPaidReceipts?.(run.id) ?? [];
    const documentReceipts = await this.readDocumentReceipts?.(run.id) ?? [];
    const projection = await this.readExecutionFacts?.(run.id);
    const usageList = projection ? [] : await this.readModelUsage?.(run.id) ?? [];
    const usageByNode = new Map(usageList.map((usage) => [usage.nodeId, usage]));
    const detail = { ...toRunDetail(run, usageByNode, paidReceipts, documentReceipts), timing: runTiming(run) };
    if (projection) return withExecutionFacts(detail, projection);
    for (const usage of usageList) {
      const recorded = detail.lines.filter((line) => line.nodeId === usage.nodeId && line.accountingSource !== "document_operation")
        .reduce((sum, line) => sum + (line.subscriptionCallCount ?? 0), 0);
      const missing = usage.modelCallCount - recorded;
      if (missing <= 0) continue;
      const node = Array.isArray(run.nodeRuns) ? run.nodeRuns.find((value) => isRecord(value) && value.nodeId === usage.nodeId) : undefined;
      // checkpoint 是实际调用的补充证据，不是额外执行，更不能凭调用数杜撰现金账单。
      detail.lines.push({
        id: `checkpoint:${usage.nodeId}`, runId: run.id, runTitle: detail.title,
        nodeId: usage.nodeId, capability: "model.execute", providerId: usage.providerId, modelId: usage.modelId,
        billing: "unverified", status: "unknown", estimatedCostCny: null,
        modelCallCount: missing, actualPending: true, callCountPending: true,
        startedAt: isRecord(node) ? text(node.startedAt) : "",
      });
    }
    return { ...detail, totals: totals(detail.lines) };
  }
}

function runTiming(run: CostRunSource): NonNullable<StudioCostRunDetail["timing"]> {
  const time = (value: unknown): number | null => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const observedAt = new Date().toISOString();
  const started = time(run.startedAt);
  const ongoing = ["running", "needs_human", "awaiting_spend_approval", "approval_invalidated"].includes(String(run.status));
  // runner 在每次到达人工停点时也写 finishedAt，它不是整次制作的终止时间。
  const ended = ongoing ? Date.parse(observedAt) : time(run.finishedAt);
  const wallElapsedMs = started !== null && ended !== null && ended >= started ? ended - started : null;
  const base = { observedAt, wallElapsedMs, humanWaitMs: null, recoveryMs: null };
  if (wallElapsedMs === null || !Array.isArray(run.interventions) || !Array.isArray(run.decisions)) return base;
  const intervals: Array<[number, number]> = [];
  for (const value of run.interventions) {
    if (!isRecord(value) || typeof value.id !== "string") return base;
    const from = time(value.createdAt);
    const replies = run.decisions.filter((decision) => isRecord(decision) && decision.interventionId === value.id);
    const times = replies.map((decision) => time((decision as Record<string, unknown>).createdAt));
    if (times.some((timestamp) => timestamp === null)) return base;
    const active = ongoing && Array.isArray(run.nodeRuns) && run.nodeRuns.some((node) => isRecord(node)
      && node.status === "needs_human" && isRecord(node.intervention) && node.intervention.id === value.id);
    const to = times.length ? Math.min(...times as number[]) : active ? ended : null;
    // 无法闭合的旧停点明确未知，不将总时长减模型时间伪装成人工/网络等待。
    if (from === null || to === null || from < started! || to < from || to > ended!) return base;
    intervals.push([from, to]);
  }
  let humanWaitMs = 0, cursor = -Infinity;
  for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
    humanWaitMs += Math.max(0, to - Math.max(from, cursor));
    cursor = Math.max(cursor, to);
  }
  return { ...base, humanWaitMs };
}

function withExecutionFacts(detail: StudioCostRunDetail, projection: ModelExecutionProjection): StudioCostRunDetail {
  const covered = new Set<string>();
  const lines = detail.lines.map((line) => {
    if (!isModelLine(line)) return line;
    const related = projection.facts.filter((fact) => fact.nodeId === line.nodeId && fact.providerId === line.providerId
      && !!line.requestId && (fact.requestId === line.requestId || fact.operationId === line.requestId));
    if (!related.length) return { ...line, legacyUnattributed: true as const, legacySnapshotCount: 1 };
    related.forEach((fact) => covered.add(fact.executionKey));
    return { ...line, executionKeys: related.map((fact) => fact.executionKey) };
  });
  for (const fact of projection.facts) {
    if (covered.has(fact.executionKey) || fact.accepted === false) continue;
    // 没有原账单的独立声音/文字请求保留待核金额，不从调用数或provider名字推断免费。
    lines.push({ id: `execution:${fact.executionKey}`, runId: detail.runId, runTitle: detail.title,
      nodeId: fact.nodeId, capability: "model.execute", providerId: fact.providerId, modelId: fact.modelId,
      requestId: fact.requestId, accountingSource: "execution_fact", executionKeys: [fact.executionKey],
      billing: "unverified", status: fact.state === "completed" ? "succeeded" : fact.state === "completed_failure" ? "failed" : "unknown",
      estimatedCostCny: null, actualPending: true, startedAt: fact.startedAt ?? "",
      modelCallCount: fact.modelAttemptCount ?? 0, callCountPending: fact.modelAttemptCount === null,
    });
  }
  const summary = summarizeModelExecutionFacts(projection.facts, projection.issues, projection.currentOperationIds);
  const cash = totals(lines);
  const countExact = summary.countExact && (cash.legacyUnattributedReceipts ?? 0) === 0 && (cash.countConflicts ?? 0) === 0;
  return { ...detail, lines, executionFacts: projection.facts, totals: {
    ...cash, ...summary, legacyUnattributedReceipts: cash.legacyUnattributedReceipts ?? 0,
    countConflicts: (cash.countConflicts ?? 0) + summary.countConflicts, countExact,
    newBrokerRequestsThisAttempt: countExact ? summary.newBrokerRequestsThisAttempt : null,
    newModelAttemptsThisAttempt: countExact ? summary.newModelAttemptsThisAttempt : null,
  } };
}

function aggregateExecutionTotals(items: StudioCostTotals[]): Partial<StudioCostTotals> {
  const knownSum = (field: "newBrokerRequestsThisAttempt" | "newModelAttemptsThisAttempt" | "cumulativeProviderMs" | "cumulativeQueueMs" | "cumulativeRequestMs") =>
    items.every((item) => typeof item[field] === "number") ? sum(items, (item) => item[field] as number) : null;
  return {
    verifiedBrokerRequests: sum(items, (item) => item.verifiedBrokerRequests ?? 0),
    verifiedModelAttempts: sum(items, (item) => item.verifiedModelAttempts ?? 0),
    countExact: items.every((item) => item.countExact === true),
    countConflicts: sum(items, (item) => item.countConflicts ?? 0),
    legacyUnattributedReceipts: sum(items, (item) => item.legacyUnattributedReceipts ?? 0),
    newBrokerRequestsThisAttempt: knownSum("newBrokerRequestsThisAttempt"),
    newModelAttemptsThisAttempt: knownSum("newModelAttemptsThisAttempt"),
    cumulativeProviderMs: knownSum("cumulativeProviderMs"), cumulativeQueueMs: knownSum("cumulativeQueueMs"),
    cumulativeRequestMs: knownSum("cumulativeRequestMs"),
    // 各run的并集不能直接相加充当全局墙钟；明细里才有同run的区间证据。
    requestWallUnionMs: null,
  };
}

function isModelLine(line: StudioCostLine): boolean {
  return ["subscription", "unverified"].includes(line.billing) || line.capability === "model.execute";
}

function toRunDetail(
  run: CostRunSource,
  usageByNode: Map<string, NodeModelUsage> = new Map(),
  paidReceipts: unknown[] = [],
  documentReceipts: unknown[] = [],
): StudioCostRunDetail {
  const title = runTitle(run.initialInput);
  const nodes = nodeMap(run.nodeRuns);
  const authorizations = Array.isArray(run.spendAuthorizations) ? run.spendAuthorizations : [];
  const nestedReceipts = Array.isArray(run.nodeRuns)
    ? run.nodeRuns.flatMap((value) => isRecord(value) && isRecord(value.executionReceipt)
      ? [{ ...value.executionReceipt, nodeId: value.nodeId, spendAuthorizationId: value.spendAuthorizationId }]
      : [])
    : [];
  const uncertainReceipts = Array.isArray(run.nodeRuns)
    ? run.nodeRuns.flatMap((value) => uncertainReceipt(value, authorizations, run.executionPlan, run.executionReceipts))
    : [];
  const receipts = mergeReceipts(
    [...nestedReceipts, ...uncertainReceipts],
    Array.isArray(run.executionReceipts) ? run.executionReceipts : [],
    [...paidReceipts, ...documentReceipts],
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
    const actualCostSource = receipt.actualCostSource === "provider_reported" || receipt.actualCostSource === "configured_rate" || receipt.actualCostSource === "manual_reconciled"
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
    const documentOperation = parameters?.accountingSource === "document_operation";
    const subscriptionCallCount = billing === "subscription"
      ? nonNegativeInteger(parameters?.modelCallCount) ?? 1
      : undefined;
    const quoteNode = Array.isArray(run.nodeRuns) ? run.nodeRuns.find((node) => isRecord(node) && node.nodeId === nodeId) : undefined;
    const boundQuote = isRecord(quoteNode) && isRecord(quoteNode.spendPlan)
      && isRecord(authorization) && authorization.spendPlanId === quoteNode.spendPlan.id ? quoteNode.spendPlan : undefined;
    const estimatedCostCny = nonNegativeNumber(boundQuote?.estimatedCostCny) ?? nonNegativeNumber(receipt.estimatedCostCny) ?? 0;
    const currentNode = nodes.get(nodeId);
    const definitiveNoSubmission = !documentOperation && billing === "metered" && receipt.authorizationOnly !== true
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
    const lineRequestId = text(receipt.requestId);
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
      ...(billing === "unverified" ? { modelCallCount: nonNegativeInteger(parameters?.modelCallCount) ?? 0 } : {}),
      ...(documentOperation ? { accountingSource: "document_operation" as const,
        ...(parameters?.modelCallCountKnown === false ? { callCountPending: true } : {}) } : {}),
      ...(receipt.countConflict === true ? { countConflict: true } : {}),
      ...(lineRequestId ? { requestId: lineRequestId } : {}),
      actualPending: billing === "unverified" && actualCost === undefined || documentOperation && parameters?.billingPending === true || billing === "metered"
        && !definitiveNoSubmission
        && (actualCost === undefined || currentOperationPending),
      startedAt,
      ...(text(receipt.finishedAt) ? { finishedAt: text(receipt.finishedAt) } : {}),
    }];
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const attributedLines = foldLegacySubscriptionSnapshots(lines, usageByNode);
  return { runId: run.id, title, totals: totals(attributedLines), lines: attributedLines };
}

// T04/AC-06a：同一节点存在 checkpoint 权威计数时，没有请求身份的旧订阅累计快照
// 不能再逐份相加（2/4/4 变 10 的根因）。折叠为每节点一份未归属桶：保留最近一份
// 快照的展示字段，不并入精确总数；权威计数由 checkpoint 补齐行给出。
function foldLegacySubscriptionSnapshots(
  lines: CostLineBuild[],
  usageByNode: Map<string, NodeModelUsage>,
): CostLineBuild[] {
  const bucketKeyOf = (line: CostLineBuild) => `${line.nodeId}:${line.providerId}:${line.modelId}`;
  const isFoldable = (line: CostLineBuild) => line.billing === "subscription"
    && !line.requestId
    && line.accountingSource !== "document_operation"
    && (usageByNode.get(line.nodeId)?.modelCallCount ?? 0) > 0;
  const buckets = new Map<string, CostLineBuild[]>();
  for (const line of lines) {
    if (!isFoldable(line)) continue;
    const key = bucketKeyOf(line);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(line);
    else buckets.set(key, [line]);
  }
  const emitted = new Set<string>();
  const result: CostLineBuild[] = [];
  for (const line of lines) {
    if (!isFoldable(line)) { result.push(line); continue; }
    const key = bucketKeyOf(line);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const bucket = buckets.get(key)!;
    const latest = bucket.reduce((left, right) => left.startedAt.localeCompare(right.startedAt) >= 0 ? left : right);
    const { subscriptionCallCount: _foldedCount, ...withoutCount } = latest;
    result.push({
      ...withoutCount,
      legacyUnattributed: true,
      legacySnapshotCount: bucket.length,
    });
  }
  return result;
}

function actualMediaAttribution(
  receipt: Record<string, unknown>,
  providerId: string,
  modelId: string,
): { providerId: string; modelId: string } {
  if (providerId !== "ai-shot-router-v1") {
    return { providerId, modelId };
  }
  const actualModelIds = Array.isArray(receipt.actualModelIds)
    ? [...new Set(receipt.actualModelIds.map(text).filter(Boolean))]
    : [modelId];
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

function uncertainReceipt(value: unknown, authorizations: unknown[], executionPlan: unknown, history: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || (value.outcomeUncertain !== true && value.status !== "running") || isRecord(value.executionReceipt)) return [];
  const authorizationOnly = value.outcomeUncertain !== true;
  if (authorizationOnly && Array.isArray(history) && history.some((receipt) => isRecord(receipt)
    && receipt.nodeId === value.nodeId && receipt.requestId === value.operationRequestId)) return [];
  const nodeId = text(value.nodeId);
  const authorizationId = text(value.spendAuthorizationId);
  const authorization = authorizations.find((candidate) => isRecord(candidate) && candidate.id === authorizationId);
  const nodePlan = Array.isArray(executionPlan)
    ? executionPlan.find((candidate) => isRecord(candidate) && candidate.nodeId === nodeId)
    : undefined;
  const plan = isRecord(value.spendPlan) ? value.spendPlan : isRecord(nodePlan) ? nodePlan : undefined;
  const automaticVoice = nodeId === "voice"
    && isRecord(plan)
    && plan.capability === "voice.synthesize"
    && plan.billing === "metered";
  if ((!authorizationId || !isRecord(authorization)) && !automaticVoice) return [];
  const startedAt = text(value.startedAt) || (isRecord(authorization) ? text(authorization.approvedAt) : "");
  const providerId = (isRecord(authorization) ? text(authorization.providerId) : "") || text(plan?.providerId);
  const modelId = (isRecord(authorization) ? text(authorization.modelId) : "") || text(plan?.modelId);
  if (!startedAt || !nodeId || !providerId || !modelId) return [];
  const requestId = text(value.operationRequestId);
  return [{
    id: `uncertain:${authorizationId || "automatic"}:${requestId || startedAt}`,
    nodeId,
    providerId,
    modelId,
    capability: text(plan?.capability) || "unknown",
    billing: "metered",
    status: "unknown",
    ...(authorizationId ? { spendAuthorizationId: authorizationId } : {}),
    ...(isRecord(authorization) ? { authorizedCostCny: nonNegativeNumber(authorization.maxCostCny) } : {}),
    estimatedCostCny: nonNegativeNumber(plan?.estimatedCostCny) ?? 0,
    // 正在运行的授权只能证明有额度，不能反推已受理一次付费调用。
    meteredAttemptCount: authorizationOnly ? 0 : 1,
    ...(authorizationOnly ? { authorizationOnly: true } : {}),
    ...(requestId ? { requestId } : {}),
    startedAt,
  }];
}

function mergeReceipts(current: unknown[], history: unknown[], cash: unknown[] = []): unknown[] {
  const merged = new Map<string, Record<string, unknown>>();
  const put = (value: unknown, index: number, kind: "current" | "history" | "cash") => {
    if (!isRecord(value)) return;
    const requestId = text(value.requestId);
    const key = requestId
      ? `request:${text(value.providerId)}:${requestId}`
      : [value.nodeId, value.startedAt, value.providerId, value.modelId ?? value.model]
        .map(text)
        .filter(Boolean)
        .join(":") || `receipt:${index}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeReceiptPair(existing, value, kind) : { ...value });
  };
  // 宿主当前事实最先入基线；历史执行回执只补缺；现金/文档账本最后到达，
  // 是实付与终态的权威更正（AC-06b：合法更正不是冲突）。
  current.forEach((value, index) => put(value, index, "current"));
  history.forEach((value, index) => put(value, index, "history"));
  cash.forEach((value, index) => put(value, index, "cash"));
  return [...merged.values()];
}

// AC-06b：同身份回执合并保留事实来源权威。终态不倒退（unknown→终态、failed→succeeded
// 是合法推进）；现金账本可更正占位实付；两个互斥实付保留先到账并显式标记冲突。
function mergeReceiptPair(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  kind: "current" | "history" | "cash",
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  const baseObservedAt = Date.parse(text(base.finishedAt) || text(base.startedAt));
  const nextObservedAt = Date.parse(text(next.finishedAt) || text(next.startedAt));
  const olderFailedObservation = kind === "history" && base.status === "succeeded" && next.status === "failed"
    && Number.isFinite(baseObservedAt) && Number.isFinite(nextObservedAt) && nextObservedAt < baseObservedAt;
  const CASH_AUTHORITY_FIELDS = new Set(["actualCostSource", "finishedAt"]);
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined || value === "" || value === null) continue;
    const previous = merged[field];
    if (previous === undefined || previous === "" || previous === null) {
      merged[field] = value;
      continue;
    }
    if (isDeepStrictEqual(previous, value)) continue;
    if (kind === "cash" && CASH_AUTHORITY_FIELDS.has(field) && merged.countConflict !== true) {
      merged[field] = value;
      continue;
    }
    if (field === "parameters" && isRecord(previous) && isRecord(value)) {
      // 同一个物理请求的累计尝试只前进，不把1、3、3相加，也不让旧快照覆盖3。
      merged[field] = { ...value, ...previous };
      const parameters = merged[field] as Record<string, unknown>;
      for (const countKey of ["modelCallCount", "modelAttemptCount"]) {
        const counts = [previous[countKey], value[countKey]].map(nonNegativeInteger)
          .filter((count): count is number => count !== undefined);
        if (counts.length) parameters[countKey] = Math.max(...counts);
      }
      continue;
    }
    if (["meteredAttemptCount", "meteredFailedAttemptCount"].includes(field)) {
      if (field === "meteredFailedAttemptCount") {
        if (olderFailedObservation) continue;
        if (base.status === "failed" && next.status === "succeeded" && nextObservedAt >= baseObservedAt) {
          merged[field] = value;
          continue;
        }
      }
      const counts = [previous, value].map(nonNegativeInteger).filter((count): count is number => count !== undefined);
      if (counts.length) merged[field] = Math.max(...counts);
      continue;
    }
    if (field === "status") {
      if (olderFailedObservation) continue;
      // 终态单调：unknown 让位给任一终态；failed 可因恢复观察推进为 succeeded；
      // 其余方向（如 succeeded→failed）是互斥终态冲突。
      if (previous === "unknown") { merged[field] = value; continue; }
      if (previous === "failed" && value === "succeeded") { merged[field] = value; continue; }
      if (value === "unknown") continue;
      merged.countConflict = true;
      continue;
    }
    if (field === "actualCostCny") {
      const previousCost = nonNegativeNumber(previous);
      const nextCost = nonNegativeNumber(value);
      if (previousCost === undefined) { merged[field] = value; continue; }
      if (nextCost === undefined || nextCost === previousCost) continue;
      const authoritativeBase = base.actualCostSource === "provider_reported" || base.actualCostSource === "manual_reconciled";
      const authoritativeNext = next.actualCostSource === "provider_reported" || next.actualCostSource === "manual_reconciled";
      if (kind === "cash" && !authoritativeBase
        && (authoritativeNext || nonNegativeInteger(base.meteredAttemptCount) === 0 && (nonNegativeInteger(next.meteredAttemptCount) ?? 0) > 0)) {
        merged[field] = value;
        continue;
      }
      // 无更正依据的实付矛盾：保留先到账，显式提示。
      merged.countConflict = true;
      continue;
    }
    // 其余字段：当前事实保留，历史不改写当前值；身份字段矛盾显式提示。
    if (["requestId", "nodeId", "providerId", "modelId", "model"].includes(field)) merged.countConflict = true;
  }
  return merged;
}

function totals(lines: CostLineBuild[]): StudioCostTotals {
  const unverifiedModelCalls = lines.some((line) => line.billing === "unverified")
    ? sum(lines, (line) => line.billing === "unverified" ? line.modelCallCount ?? 0 : 0)
    : undefined;
  const subscriptionCalls = sum(lines, (line) => line.billing === "subscription"
    ? line.legacyUnattributed ? 0 : line.subscriptionCallCount ?? 1
    : 0);
  const meteredCalls = sum(lines, (line) => line.billing === "metered" ? line.meteredAttemptCount ?? 0 : 0);
  const legacyUnattributedReceipts = sum(lines, (line) => line.legacySnapshotCount ?? 0);
  const countConflicts = lines.filter((line) => line.countConflict === true).length;
  // 已核实的 Broker 请求：有明确请求身份的去重计数。checkpoint 补齐行与旧快照
  // 没有请求身份，不计入；此时的精确度由 countExact 表达。
  return {
    estimatedCostCny: money(sum(lines, (line) => line.estimatedCostCny ?? 0)),
    authorizedCostCny: uniqueAuthorizedCost(lines),
    actualCostCny: money(sum(lines, (line) => line.actualCostCny ?? 0)),
    actualPendingCount: lines.filter((line) => line.actualPending).length,
    meteredCalls,
    subscriptionCalls,
    ...(unverifiedModelCalls !== undefined ? { unverifiedModelCalls } : {}),
    freeCalls: lines.filter((line) => line.billing === "free" || line.billing === "local_compute").length,
    failedMeteredCalls: sum(lines, (line) => line.billing === "metered" ? line.meteredFailedAttemptCount ?? 0 : 0),
    // workflow operation和媒体采购编号不是Broker物理请求证据；由只读投影补充精确统计。
    verifiedModelAttempts: 0,
    verifiedBrokerRequests: 0,
    legacyUnattributedReceipts,
    countExact: !lines.some(isModelLine) && legacyUnattributedReceipts === 0 && countConflicts === 0,
    countConflicts,
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
      : item.billing === "unverified" ? item.modelCallCount ?? 0
      : item.billing === "subscription"
        ? item.subscriptionCallCount ?? 1
        : 1),
    estimatedCostCny: money(sum(items, (item) => item.estimatedCostCny ?? 0)),
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

function billingType(value: unknown): StudioBillingType | "unverified" {
  return value === "unverified" || value === "subscription" || value === "metered" || value === "local_compute" || value === "human" ? value : "free";
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
