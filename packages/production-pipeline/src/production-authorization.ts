import { createHash } from "node:crypto";

// C1：制作范围授权（production scope）与逐请求执行凭证的决策核心。
// scope 是“用户确认方案时一次性批准的制作许可”：整数分的最高金额、许可的素材及其模型、
// 每个素材的有限修复次数。它是 run 级业务许可，不替代逐请求 ledger——每个新媒体调用仍
// 先查复用/原任务、核验范围与余额、持久化预留、再发起调用。所有判定都是确定性纯函数，
// 由可信宿主（ProductionPipeline）调用；客户端不能自报已花金额、余额或质量合同。

export const PRODUCTION_AUTHORIZATION_VERSION = "video-factory/production-authorization-v1" as const;

// 质量合同 digest 的 canonical 投影：只覆盖"改变即必须重新确认方案"的质量承诺字段——
// 观众承诺锚（angle/audience/visualProof/visualPlan/editorial）、时长范围与导演档案。
// 宿主在接受与自动继续两侧用同一函数计算并核对；executable plan bytes 不含这些字段，
// 不能只靠 plan digest 代替质量合同身份。
export function canonicalQualityContractDigest(quality: {
  angle: string;
  audience: string;
  durationRange: { minSeconds: number; maxSeconds: number };
  directorProfileId: string;
  visualProof?: string;
  visualPlanDigest?: string;
  editorial?: { verdict: string; reasons: string[]; guardrails: string[] };
}): string {
  return createHash("sha256").update(JSON.stringify({
    angle: quality.angle,
    audience: quality.audience,
    durationRange: quality.durationRange,
    directorProfileId: quality.directorProfileId,
    ...(quality.visualProof ? { visualProof: quality.visualProof } : {}),
    ...(quality.visualPlanDigest ? { visualPlanDigest: quality.visualPlanDigest } : {}),
    ...(quality.editorial ? { editorial: quality.editorial } : {}),
  })).digest("hex");
}

/** 当前制作效果的业务身份；与具体 Provider 请求 identity 分离。 */
export function canonicalProductionAssetIntentDigest(acceptedPlanDigest: string, assetKey: string): string {
  return createHash("sha256").update(JSON.stringify({
    version: "video-factory/production-asset-intent-v1",
    acceptedPlanDigest,
    assetKey,
  })).digest("hex");
}

export interface ProductionAuthorizationScope {
  version: typeof PRODUCTION_AUTHORIZATION_VERSION;
  id: string;
  runId: string;
  /** 接受该授权时的 run revision（CAS：过期 revision 的授权不接受）。 */
  approvalRevision: number;
  /** 用户确认的制作方案 digest（executable plan 绑定）。 */
  acceptedPlanDigest: string;
  /** 质量合同 digest：观众承诺、事实/实拍要求、画面目标与最低技术规格——不是整份文件 bytes。 */
  qualityContractDigest: string;
  /** 最高授权金额，整数分。 */
  approvedAmountCents: number;
  approvedBy: string;
  approvedAt: string;
  permittedAssets: Array<{
    assetKey: string;
    intentDigest: string;
    models: Array<{ providerId: string; modelId: string }>;
    maxCreateAttempts: number;
  }>;
  /** 追加授权替代的旧授权 id（delta 链）。 */
  supersedesAuthorizationId?: string;
}

export interface ProductionSpendState {
  /** 已结算金额（整数分）。 */
  settledCents: number;
  /** 在途预留（含已受理未知结果的保守占用）。 */
  reservedCents: number;
  /** 结果未知且尚未能保守定价的占用（按保守报价计入）。 */
  pendingUnknownCents: number;
  attemptsByAsset: Record<string, number>;
}

export interface ProductionSpendRequest {
  assetKey: string;
  intentDigest: string;
  providerId: string;
  modelId: string;
  quoteCents: number;
  attempt: number;
}

export interface ProductionLedgerItem {
  itemRequestId: string;
  quoteItemId: string;
  state: "prepared" | "submitted" | "provider_succeeded" | "materialized" | "terminal_failed" | "unknown";
  estimatedCostCny: number;
  actualCostCny?: number;
  taskId?: string;
  carriedForwardFromItemRequestId?: string;
}

function sameLedgerItemFact(left: ProductionLedgerItem, right: ProductionLedgerItem): boolean {
  return left.itemRequestId === right.itemRequestId
    && left.quoteItemId === right.quoteItemId
    && left.state === right.state
    && left.estimatedCostCny === right.estimatedCostCny
    && left.actualCostCny === right.actualCostCny
    && left.taskId === right.taskId
    && left.carriedForwardFromItemRequestId === right.carriedForwardFromItemRequestId;
}

function checkedAddCents(sum: number, addend: number): number {
  const next = sum + addend;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new Error("Paid ledger aggregation overflowed the safe integer cent range.");
  }
  return next;
}

/**
 * 将逐请求账本折叠为授权决策状态；alias 只代表同一物理请求，不重复计费或计次。
 * 折叠与文件/行遍历顺序无关：每个物理请求组的结算与占用事实由条目内容决定，不是"数组最后一行"。
 * 生成失败不证明未收费：已有受理 task（taskId）但未定价的 terminal 请求按组内最高报价保守占用；
 * 只有明确未受理（无 task、无实际费用）的 terminal 请求才不占用、不计次。
 */
export function foldProductionSpendLedger(items: readonly ProductionLedgerItem[]): ProductionSpendState {
  const byId = new Map<string, ProductionLedgerItem>();
  for (const item of items) {
    const existing = byId.get(item.itemRequestId);
    if (existing && !sameLedgerItemFact(existing, item)) {
      throw new Error(`Paid ledger contains conflicting records for item request '${item.itemRequestId}'.`);
    }
    byId.set(item.itemRequestId, item);
  }
  const deduped = [...byId.values()];
  const physicalId = (item: ProductionLedgerItem): string => {
    const visited = new Set<string>();
    let current = item;
    while (current.carriedForwardFromItemRequestId) {
      if (visited.has(current.itemRequestId)) throw new Error("Paid ledger carry-forward lineage contains a cycle.");
      visited.add(current.itemRequestId);
      const parent = byId.get(current.carriedForwardFromItemRequestId);
      if (!parent) throw new Error(`Paid ledger carry-forward parent '${current.carriedForwardFromItemRequestId}' is missing.`);
      current = parent;
    }
    return current.itemRequestId;
  };
  const groups = new Map<string, ProductionLedgerItem[]>();
  for (const item of deduped) {
    const id = physicalId(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  let settledCents = 0;
  let reservedCents = 0;
  let pendingUnknownCents = 0;
  const attemptsByAsset: Record<string, number> = Object.create(null);
  for (const group of groups.values()) {
    const physical = group.find((item) => !item.carriedForwardFromItemRequestId) ?? group[0]!;
    // 顺序无关的事实选择：结算取组内最高实际费用；未结清占用取组内最高估价（保守）。
    const pricedCentsList = group
      .filter((item) => item.actualCostCny !== undefined)
      .map((item) => moneyToCents(item.actualCostCny!));
    const maxEstimateCents = Math.max(...group.map((item) => moneyToCents(item.estimatedCostCny)));
    const acceptedTask = group.some((item) => Boolean(item.taskId));
    const states = new Set(group.map((item) => item.state));
    const hasMaterialized = states.has("materialized");
    const hasTerminalFailure = states.has("terminal_failed");
    if (pricedCentsList.length > 0 && (hasMaterialized || hasTerminalFailure)) {
      // 已有计价证据且请求已到达终态：结算为最高实际费用（alias 携带的旧价格不能覆盖真实结算）。
      settledCents = checkedAddCents(settledCents, Math.max(...pricedCentsList));
    } else if (hasMaterialized) {
      // 物化成功但未记录实际费用：按估价结算（历史条目的既有合同）。
      settledCents = checkedAddCents(settledCents, maxEstimateCents);
    } else if (states.has("unknown")) {
      pendingUnknownCents = checkedAddCents(pendingUnknownCents, maxEstimateCents);
    } else if (states.has("submitted") || states.has("provider_succeeded")
      || (hasTerminalFailure && acceptedTask)) {
      // 已受理未结清（含受理后失败但计费未定）：按最高报价保守占用，不归零。
      reservedCents = checkedAddCents(reservedCents, maxEstimateCents);
    } else if (states.has("prepared")) {
      // 预留已持久化但尚未受理：占用预留，不算 create。
      reservedCents = checkedAddCents(reservedCents, maxEstimateCents);
    }
    // 明确未受理（terminal_failed 且无 task、无实际费用）不占用也不计次；
    // 其余任一条目出现 create 事实（受理/成功/物化/未知）计一次 create。
    const createAttempted = group.some((item) => {
      const actualCents = item.actualCostCny === undefined ? undefined : moneyToCents(item.actualCostCny);
      return item.state === "submitted"
        || item.state === "provider_succeeded"
        || item.state === "materialized"
        || item.state === "unknown"
        || (item.state === "terminal_failed" && (Boolean(item.taskId) || actualCents !== undefined));
    });
    if (createAttempted) {
      attemptsByAsset[physical.quoteItemId] = (attemptsByAsset[physical.quoteItemId] ?? 0) + 1;
    }
  }
  return { settledCents, reservedCents, pendingUnknownCents, attemptsByAsset };
}

export type ProductionSpendDecision =
  | { action: "reuse"; artifactId: string }
  | { action: "resume_existing"; itemRequestId: string }
  | { action: "execute"; reserveCents: number }
  | { action: "request_approval"; reason: "amount" | "scope" | "attempts"; additionalCents: number }
  | { action: "needs_replan"; reason: string };

export function parseProductionAuthorizationScope(value: unknown): ProductionAuthorizationScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Production authorization scope must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== PRODUCTION_AUTHORIZATION_VERSION) {
    throw new Error(`Production authorization version must equal ${PRODUCTION_AUTHORIZATION_VERSION}.`);
  }
  const id = requiredText(record.id, "id");
  const runId = requiredText(record.runId, "runId");
  const approvedBy = requiredText(record.approvedBy, "approvedBy");
  const approvedAt = requiredText(record.approvedAt, "approvedAt");
  if (typeof record.approvalRevision !== "number" || !Number.isInteger(record.approvalRevision) || record.approvalRevision < 0) {
    throw new Error("Production authorization approvalRevision must be a non-negative integer.");
  }
  const approvalRevision: number = record.approvalRevision;
  if (typeof record.approvedAmountCents !== "number" || !Number.isSafeInteger(record.approvedAmountCents) || record.approvedAmountCents <= 0) {
    throw new Error("Production authorization approvedAmountCents must be a positive integer of cents.");
  }
  const approvedAmountCents: number = record.approvedAmountCents;
  const acceptedPlanDigest = requiredSha256(record.acceptedPlanDigest, "acceptedPlanDigest");
  const qualityContractDigest = requiredSha256(record.qualityContractDigest, "qualityContractDigest");
  if (!Array.isArray(record.permittedAssets) || record.permittedAssets.length === 0) {
    throw new Error("Production authorization permittedAssets must be a non-empty array.");
  }
  if (record.permittedAssets.length > 200) {
    throw new Error("Production authorization permittedAssets must not exceed 200 entries.");
  }
  const permittedAssets = record.permittedAssets.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`permittedAssets[${index}] must be an object.`);
    }
    const asset = entry as Record<string, unknown>;
    if (typeof asset.maxCreateAttempts !== "number" || !Number.isInteger(asset.maxCreateAttempts) || asset.maxCreateAttempts < 1 || asset.maxCreateAttempts > 6) {
      throw new Error(`permittedAssets[${index}].maxCreateAttempts must be an integer between 1 and 6.`);
    }
    const maxCreateAttempts: number = asset.maxCreateAttempts;
    const models = asset.models;
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`permittedAssets[${index}].models must be a non-empty array.`);
    }
    return {
      assetKey: requiredText(asset.assetKey, `permittedAssets[${index}].assetKey`),
      intentDigest: requiredSha256(asset.intentDigest, `permittedAssets[${index}].intentDigest`),
      models: models.map((model, modelIndex) => {
        if (typeof model !== "object" || model === null || Array.isArray(model)) {
          throw new Error(`permittedAssets[${index}].models[${modelIndex}] must be an object.`);
        }
        const modelRecord = model as Record<string, unknown>;
        return {
          providerId: requiredText(modelRecord.providerId, `permittedAssets[${index}].models[${modelIndex}].providerId`),
          modelId: requiredText(modelRecord.modelId, `permittedAssets[${index}].models[${modelIndex}].modelId`),
        };
      }),
      maxCreateAttempts,
    };
  });
  const supersedes = record.supersedesAuthorizationId;
  if (supersedes !== undefined && (typeof supersedes !== "string" || !supersedes.trim())) {
    throw new Error("supersedesAuthorizationId must be a non-empty string when provided.");
  }
  return {
    version: PRODUCTION_AUTHORIZATION_VERSION,
    id,
    runId,
    approvalRevision,
    acceptedPlanDigest,
    qualityContractDigest,
    approvedAmountCents,
    approvedBy,
    approvedAt,
    permittedAssets,
    ...(supersedes !== undefined ? { supersedesAuthorizationId: supersedes } : {}),
  };
}

// 决策顺序（固定，纯函数）：
// 1. 已物化可复用素材 → reuse（不花钱）；
// 2. 已受理结果未知 → resume_existing（查原任务，绝不新建请求双跑）；
// 3. 请求不在许可范围（assetKey/intent/model/次数）→ needs_replan 或 request_approval(scope/attempts)；
// 4. 明确新请求才比较余额：可用 = 已批 - 已结算 - 在途预留 - 未知保守占用；
//    够 → execute（携带精确预留）；不够 → request_approval(amount, 差额)。
export function resolveProductionSpendDecision(options: {
  scope: ProductionAuthorizationScope | undefined;
  state: ProductionSpendState;
  request: ProductionSpendRequest;
  reusableArtifactId?: string;
  existingAcceptedItemRequestId?: string;
}): ProductionSpendDecision {
  const { scope, state, request } = options;
  // 金额与次数的 fail-closed 数值合同：非有限/非安全整数/负值直接拒绝，NaN 不得因
  // 比较语义静默落入 execute。
  if (!isValidCents(request.quoteCents)) {
    return { action: "needs_replan", reason: `quote for ${request.assetKey} is not a finite non-negative integer of cents` };
  }
  if (!isValidCents(state.settledCents) || !isValidCents(state.reservedCents) || !isValidCents(state.pendingUnknownCents)) {
    return { action: "needs_replan", reason: "production spend state carries invalid cent amounts" };
  }
  if (options.reusableArtifactId !== undefined) {
    return { action: "reuse", artifactId: options.reusableArtifactId };
  }
  if (options.existingAcceptedItemRequestId !== undefined) {
    return { action: "resume_existing", itemRequestId: options.existingAcceptedItemRequestId };
  }
  if (!scope) {
    return { action: "request_approval", reason: "amount", additionalCents: request.quoteCents };
  }
  const permitted = scope.permittedAssets.find((asset) => asset.assetKey === request.assetKey);
  if (!permitted) {
    return { action: "needs_replan", reason: `${request.assetKey} is not covered by the approved production scope` };
  }
  if (permitted.intentDigest !== request.intentDigest) {
    return { action: "needs_replan", reason: `${request.assetKey} changed its intent after approval; the effect needs re-confirmation` };
  }
  const modelPermitted = permitted.models.some((model) => (
    model.providerId === request.providerId && model.modelId === request.modelId
  ));
  if (!modelPermitted) {
    return { action: "needs_replan", reason: `${request.assetKey} is not permitted on ${request.providerId}/${request.modelId}` };
  }
  // 原型键防御：attempt 计数用 Map 读取（has/get），"constructor" 一类 parser 合法键
  // 不得从 Object.prototype 读到继承值绕过次数上限。
  const usedAttempts = state.attemptsByAsset instanceof Map
    ? (state.attemptsByAsset.get(request.assetKey) ?? 0)
    : (Object.hasOwn(state.attemptsByAsset, request.assetKey) ? state.attemptsByAsset[request.assetKey] : 0);
  if (!Number.isSafeInteger(usedAttempts) || usedAttempts < 0) {
    return { action: "needs_replan", reason: `attempt counter for ${request.assetKey} is invalid` };
  }
  if (usedAttempts >= permitted.maxCreateAttempts) {
    return { action: "request_approval", reason: "attempts", additionalCents: 0 };
  }
  const availableCents = scope.approvedAmountCents
    - state.settledCents
    - state.reservedCents
    - state.pendingUnknownCents;
  if (request.quoteCents > availableCents) {
    // 总增量口径：可用为负（历史占用已超授权）时，追加额必须覆盖请求本身加上超占用回补，
    // 不能只报告"还差到 0"的差额——那会误导用户以为追加后足够完成本次请求。
    if (!Number.isSafeInteger(availableCents)) {
      return { action: "needs_replan", reason: "production spend state overflows the safe integer cent range" };
    }
    return { action: "request_approval", reason: "amount", additionalCents: request.quoteCents - availableCents };
  }
  return { action: "execute", reserveCents: request.quoteCents };
}

// 一份具体报价计划是否完全被当前范围覆盖（宿主用它决定 awaiting_spend_approval 能否
// 凭 scope 自动继续）。任何一项不许可、次数超限或余额不足都返回 false——需要用户决定。
export function scopeCoversSpendPlan(options: {
  scope: ProductionAuthorizationScope;
  state: ProductionSpendState;
  plan: {
    items: Array<{
      assetKey: string;
      intentDigest: string;
      providerId: string;
      modelId: string;
      quoteCents: number;
      attempt: number;
    }>;
  };
}): boolean {
  return assessProductionSpendPlan(options).action === "execute";
}

// C1-R5：结构化覆盖评估。coverage 不再压成 bool：每个被阻断素材保留可区分原因
// （amount/scope/attempts/quality/evidence）、精确金额与缺失目标，供宿主持久化和 C2 展示。
export interface ProductionSpendPlanAssessment {
  /** execute：整份计划可凭当前范围自动继续。request_approval：需要用户决定。 */
  action: "execute" | "request_approval";
  /** request_approval 的首个可区分原因；amount 之外的类别加钱不能解决。 */
  reason?: "amount" | "scope" | "attempts" | "quality" | "evidence";
  approvedAmountCents: number;
  settledCents: number;
  reservedCents: number;
  pendingUnknownCents: number;
  /** 整份计划的最高占用（fold 后逐项 execute 的合计预留）。 */
  requestedMaximumCents: number;
  /** 追加到"恰好覆盖整份计划"所需的精确金额（仅 reason=amount 时非零）。 */
  additionalCents: number;
  /** 追加后的累计授权上限（approved + additional）。 */
  resultingMaximumCents: number;
  /** 逐项判定结果（含成功项），供宿主投影 blocked 资产与保留成果。 */
  items: Array<{ assetKey: string; decision: ProductionSpendDecision }>;
  /** 无法在当前范围内继续的素材键（缺失目标）。 */
  blockedAssets: Array<{ assetKey: string; reason: string }>;
}

export function assessProductionSpendPlan(options: {
  scope: ProductionAuthorizationScope;
  state: ProductionSpendState;
  plan: {
    items: Array<{
      assetKey: string;
      intentDigest: string;
      providerId: string;
      modelId: string;
      quoteCents: number;
      attempt: number;
    }>;
  };
  /** 整份计划的最高占用（含重试余量）；缺省时按条目报价合计计算。 */
  planMaximumCents?: number;
}): ProductionSpendPlanAssessment {
  // C1-R3/CG-03：整份计划口径的评估。"需要追加多少"与"是否存在加钱解决不了的阻断"
  // 必须独立于条目顺序：非金额阻断（scope/quality/attempts）逐项收集；金额需求按全部
  // 非金额可行条目 + 计划最高占用计算，不受单项首次失败截断。
  // 次数预算仍按 fold 累计（同素材多项共享预算，聚合结果与顺序无关）。
  const folded: ProductionSpendState = {
    settledCents: options.state.settledCents,
    reservedCents: options.state.reservedCents,
    pendingUnknownCents: options.state.pendingUnknownCents,
    // null-prototype 拷贝：fold 写入任意 parser 合法 assetKey 时不落到原型链。
    attemptsByAsset: Object.assign(Object.create(null), options.state.attemptsByAsset),
  };
  const itemResults: ProductionSpendPlanAssessment["items"] = [];
  const nonAmountBlocked: ProductionSpendPlanAssessment["reason"][] = [];
  let feasibleItemTotalCents = 0;
  for (const item of options.plan.items) {
    const decision = resolveProductionSpendDecision({
      scope: options.scope,
      state: folded,
      request: {
        assetKey: item.assetKey,
        intentDigest: item.intentDigest,
        providerId: item.providerId,
        modelId: item.modelId,
        quoteCents: item.quoteCents,
        attempt: item.attempt,
      },
    });
    // 金额不是该项的阻断因素（execute 或纯 amount 不足）：计入整份计划金额需求。
    const amountFeasibleForAttempts = decision.action !== "needs_replan"
      && !(decision.action === "request_approval" && decision.reason === "attempts");
    if (decision.action === "needs_replan") {
      nonAmountBlocked.push(/changed its intent/i.test(decision.reason) ? "quality" : "scope");
    } else if (decision.action === "request_approval" && decision.reason === "attempts") {
      nonAmountBlocked.push("attempts");
    } else {
      feasibleItemTotalCents = checkedAddCents(feasibleItemTotalCents, item.quoteCents);
    }
    if (amountFeasibleForAttempts) {
      const priorAttempts = Object.hasOwn(folded.attemptsByAsset, item.assetKey)
        ? folded.attemptsByAsset[item.assetKey]! : 0;
      folded.attemptsByAsset[item.assetKey] = priorAttempts + 1;
    }
    // 展示用 decision 统一为整份计划口径（单项 execute 不代表整份可执行）。
    itemResults.push({ assetKey: item.assetKey, decision });
  }
  // 整份计划最高金额：条目合计与计划最高占用（含重试余量）取大——顺序无关。
  const requestedMaximumCents = options.planMaximumCents !== undefined
    ? Math.max(feasibleItemTotalCents, options.planMaximumCents)
    : feasibleItemTotalCents;
  // 可用余额可以为负（历史占用已超授权）：负值直接进入缺口计算，追加额覆盖超占用回补。
  const availableCents = options.scope.approvedAmountCents
    - options.state.settledCents
    - options.state.reservedCents
    - options.state.pendingUnknownCents;
  if (!Number.isSafeInteger(availableCents)) {
    throw new Error("Production spend state overflows the safe integer cent range.");
  }
  const additionalCents = Math.max(0, requestedMaximumCents - availableCents);
  const nonAmountReason = nonAmountBlocked[0];
  if (nonAmountReason === undefined && additionalCents === 0) {
    return {
      action: "execute",
      approvedAmountCents: options.scope.approvedAmountCents,
      settledCents: options.state.settledCents,
      reservedCents: options.state.reservedCents,
      pendingUnknownCents: options.state.pendingUnknownCents,
      requestedMaximumCents,
      additionalCents: 0,
      resultingMaximumCents: options.scope.approvedAmountCents,
      items: itemResults,
      blockedAssets: [],
    };
  }
  // 非金额阻断优先：加钱解决不了的问题不得被金额缺口遮盖；金额缺口仍按整份计划如实报告。
  const reason: ProductionSpendPlanAssessment["reason"] = nonAmountReason ?? "amount";
  return {
    action: "request_approval",
    reason,
    approvedAmountCents: options.scope.approvedAmountCents,
    settledCents: options.state.settledCents,
    reservedCents: options.state.reservedCents,
    pendingUnknownCents: options.state.pendingUnknownCents,
    requestedMaximumCents,
    additionalCents,
    resultingMaximumCents: options.scope.approvedAmountCents + additionalCents,
    items: itemResults,
    blockedAssets: itemResults
      .filter((entry) => entry.decision.action !== "execute")
      .map((entry) => ({
        assetKey: entry.assetKey,
        reason: entry.decision.action === "needs_replan"
          ? entry.decision.reason
          : entry.decision.action === "request_approval"
            ? entry.decision.reason === "amount"
              ? `amount: additional ${entry.decision.additionalCents} cents required`
              : entry.decision.reason
            : "blocked before evaluation",
      })),
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Production authorization ${field} must be a non-empty string.`);
  return value.trim();
}

function requiredSha256(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`Production authorization ${field} must be a SHA-256 digest.`);
  return text;
}

function isValidCents(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function moneyToCents(value: number): number {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Paid ledger contains an invalid monetary value.");
  return cents;
}
