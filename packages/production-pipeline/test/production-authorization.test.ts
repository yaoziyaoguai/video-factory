import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessProductionSpendPlan,
  canonicalProductionAssetIntentDigest,
  canonicalQualityContractDigest,
  foldProductionSpendLedger,
  parseProductionAuthorizationScope,
  resolveProductionSpendDecision,
  scopeCoversSpendPlan,
  type ProductionAuthorizationScope,
  type ProductionSpendState,
} from "../src/production-authorization.js";

// ---------------------------------------------------------------------------
// C1：制作范围授权与逐请求执行凭证。
// - scope 是 run 级业务许可（整数分），不是逐请求 ledger 的替代；
// - resolveProductionSpendDecision 是纯函数：复用优先、未知先查原任务、能力/质量不满足
//   先 needs_replan，只有明确新请求才比较范围/次数/余额；
// - 覆盖判断只由服务端核验，不信任客户端自报。
// ---------------------------------------------------------------------------

function baseScope(overrides: Partial<ProductionAuthorizationScope> = {}): ProductionAuthorizationScope {
  return {
    version: "video-factory/production-authorization-v1",
    id: "auth-1",
    runId: "run-1",
    approvalRevision: 3,
    acceptedPlanDigest: "a".repeat(64),
    qualityContractDigest: "b".repeat(64),
    approvedAmountCents: 100_000,
    approvedBy: "owner",
    approvedAt: "2026-09-10T00:00:00.000Z",
    permittedAssets: [{
      assetKey: "scene-1",
      intentDigest: "c".repeat(64),
      models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }],
      maxCreateAttempts: 2,
    }],
    ...overrides,
  };
}

function spentState(overrides: Partial<ProductionSpendState> = {}): ProductionSpendState {
  return {
    settledCents: 0,
    reservedCents: 0,
    pendingUnknownCents: 0,
    attemptsByAsset: {},
    ...overrides,
  };
}

describe("production authorization scope contract", () => {
  it("accepts a valid scope and rejects structural violations with field-level errors", () => {
    const scope = baseScope();
    assert.equal(parseProductionAuthorizationScope(scope).id, "auth-1");

    assert.throws(() => parseProductionAuthorizationScope({ ...scope, version: "v2" }), /version/);
    assert.throws(() => parseProductionAuthorizationScope({ ...scope, approvedAmountCents: 100.5 }), /approvedAmountCents.*integer/i);
    assert.throws(() => parseProductionAuthorizationScope({ ...scope, approvedAmountCents: 0 }), /approvedAmountCents/);
    assert.throws(() => parseProductionAuthorizationScope({ ...scope, approvedBy: " " }), /approvedBy/);
    assert.throws(() => parseProductionAuthorizationScope({ ...scope, acceptedPlanDigest: "zz" }), /acceptedPlanDigest/);
    assert.throws(() => parseProductionAuthorizationScope({ ...scope, permittedAssets: [{ ...scope.permittedAssets[0]!, maxCreateAttempts: 0 }] }), /maxCreateAttempts/);
    // 追加链的跨字段一致性（supersedes 指向的旧授权属于同一 run）由宿主在接受时核验，
    // parse 只负责结构合同。
    assert.equal(
      parseProductionAuthorizationScope({ ...scope, supersedesAuthorizationId: "auth-0" }).supersedesAuthorizationId,
      "auth-0",
    );
  });
});

describe("resolveProductionSpendDecision", () => {
  it("prefers an existing materialized artifact over any new execution", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 1 },
      reusableArtifactId: "artifact-9",
    });
    assert.deepEqual(decision, { action: "reuse", artifactId: "artifact-9" });
  });

  it("resumes an accepted task with unknown outcome instead of creating a new request", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 1 },
      existingAcceptedItemRequestId: "item-req-1",
    });
    assert.deepEqual(decision, { action: "resume_existing", itemRequestId: "item-req-1" });
  });

  it("requests replanning when the requested asset is outside the permitted scope", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-9", intentDigest: "d".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "needs_replan", reason: "scene-9 is not covered by the approved production scope" });
  });

  it("requests replanning when the model or intent changed for a permitted asset", () => {
    const modelChanged = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "other-model", quoteCents: 240, attempt: 1 },
    });
    assert.equal(modelChanged.action, "needs_replan");

    const intentChanged = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "e".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 1 },
    });
    assert.equal(intentChanged.action, "needs_replan");
  });

  it("blocks execution and reports the exact missing amount when funds are short", () => {
    // 已批 1000 元（100_000 分）、已花 250、在途 200、新报价 600 → 缺 50 元，Provider 调用为 0。
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ settledCents: 25_000, reservedCents: 20_000 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 60_000, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "request_approval", reason: "amount", additionalCents: 5_000 });
  });

  it("executes with an explicit reservation when the scope covers the quote", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ settledCents: 25_000, reservedCents: 20_000 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 55_000, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "execute", reserveCents: 55_000 });
  });

  it("treats unknown-outcome reservations as occupied, never releasable into new spends", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ pendingUnknownCents: 60_000 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 50_000, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "request_approval", reason: "amount", additionalCents: 10_000 });
  });

  it("requires approval when the per-asset attempt budget is exhausted even with funds left", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ attemptsByAsset: { "scene-1": 2 } }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 3 },
    });
    assert.deepEqual(decision, { action: "request_approval", reason: "attempts", additionalCents: 0 });
  });

  it("executes when the quote exactly exhausts the remaining balance", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope({ approvedAmountCents: 100_000 }),
      state: spentState({ settledCents: 25_000, reservedCents: 15_000 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 60_000, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "execute", reserveCents: 60_000 });
  });

  it("requests exactly the one-cent shortfall", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope({ approvedAmountCents: 100_000 }),
      state: spentState({ settledCents: 25_000, reservedCents: 15_001 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 60_000, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "request_approval", reason: "amount", additionalCents: 1 });
  });

  it("sees the first request's reservation when evaluating a second concurrent request", () => {
    const scope = baseScope({
      approvedAmountCents: 100_000,
      permittedAssets: [
        ...baseScope().permittedAssets,
        {
          assetKey: "scene-2",
          intentDigest: "c".repeat(64),
          models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }],
          maxCreateAttempts: 2,
        },
      ],
    });
    const base = { intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", attempt: 1 } as const;
    const first = resolveProductionSpendDecision({ scope, state: spentState(), request: { ...base, assetKey: "scene-1", quoteCents: 60_000 } });
    assert.equal(first.action, "execute");
    // 第二个请求必须看到第一个的预留（同 run lease 内串行落账后状态已更新）。
    const second = resolveProductionSpendDecision({
      scope,
      state: spentState({ reservedCents: 60_000 }),
      request: { ...base, assetKey: "scene-2", quoteCents: 50_000 },
    });
    assert.equal(second.action, "request_approval");
    const shortfall = (second as { additionalCents?: number }).additionalCents;
    assert.equal(shortfall, 10_000, "scene-2 must see scene-1's reservation and request the exact shortfall");
  });

  it("never approves a new spend without a scope", () => {
    const decision = resolveProductionSpendDecision({
      scope: undefined,
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 240, attempt: 1 },
    });
    assert.equal(decision.action, "request_approval");
  });

  it("reports the total increment required when historic spend already exceeds the approval", () => {
    // approved 1000、已占用 1100、新请求 100：追加 100 只补到 0，完成本次请求共需 200。
    const decision = resolveProductionSpendDecision({
      scope: baseScope({ approvedAmountCents: 1000 }),
      state: spentState({ settledCents: 1100 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 1 },
    });
    assert.deepEqual(decision, { action: "request_approval", reason: "amount", additionalCents: 200 });
  });
});

describe("scope coverage of concrete spend plans", () => {
  it("does not let prototype keys bypass the attempt ceiling", () => {
    const scope = baseScope({
      permittedAssets: [{ assetKey: "constructor", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 1 }],
    });
    const covered = scopeCoversSpendPlan({
      scope,
      state: spentState(),
      plan: {
        items: [
          { assetKey: "constructor", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 1 },
          { assetKey: "constructor", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 2 },
        ],
      },
    });
    assert.equal(covered, false, "the second constructor-key create must see the first attempt's increment, not an inherited function");
  });

  it("rejects invalid attempt counters in the spend state", () => {
    const decision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ attemptsByAsset: { "scene-1": Number.NaN } }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 1 },
    });
    assert.equal(decision.action, "needs_replan");
  });

  it("rejects a plan whose items each fit individually but exceed the aggregate budget", () => {
    const scope = baseScope({
      approvedAmountCents: 50_000,
      permittedAssets: [
        ...baseScope().permittedAssets,
        { assetKey: "scene-2", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 },
      ],
    });
    const covered = scopeCoversSpendPlan({
      scope,
      state: spentState(),
      plan: {
        items: [
          { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 30_000, attempt: 1 },
          { assetKey: "scene-2", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 30_000, attempt: 1 },
        ],
      },
    });
    assert.equal(covered, false, "two 30k items against a 50k scope must be rejected in aggregate");
  });

  it("accepts the same items when the aggregate budget covers their sum", () => {
    const scope = baseScope({
      approvedAmountCents: 60_000,
      permittedAssets: [
        ...baseScope().permittedAssets,
        { assetKey: "scene-2", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 },
      ],
    });
    const covered = scopeCoversSpendPlan({
      scope,
      state: spentState(),
      plan: {
        items: [
          { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 30_000, attempt: 1 },
          { assetKey: "scene-2", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 30_000, attempt: 1 },
        ],
      },
    });
    assert.equal(covered, true);
  });

  it("rejects multi-attempt aggregation that exhausts a per-asset attempt budget across plan items", () => {
    const scope = baseScope({ permittedAssets: [{ assetKey: "scene-1", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 }] });
    const covered = scopeCoversSpendPlan({
      scope,
      state: spentState({ attemptsByAsset: { "scene-1": 1 } }),
      plan: {
        items: [
          { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 2 },
          { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 3 },
        ],
      },
    });
    assert.equal(covered, false, "the second same-asset item must see the first item's attempt increment");
  });

  it("fails closed on NaN or unsafe quote amounts instead of comparing to execute", () => {
    const nanDecision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: Number.NaN, attempt: 1 },
    });
    assert.equal(nanDecision.action, "needs_replan");
    const unsafeDecision = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState(),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: Number.MAX_SAFE_INTEGER + 1, attempt: 1 },
    });
    assert.equal(unsafeDecision.action, "needs_replan");
    const negativeState = resolveProductionSpendDecision({
      scope: baseScope(),
      state: spentState({ reservedCents: -1 }),
      request: { assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 100, attempt: 1 },
    });
    assert.equal(negativeState.action, "needs_replan");
  });

  it("covers a plan only when every item is permitted, modeled, and within funds", () => {
    const scope = baseScope({ approvedAmountCents: 50_000 });
    assert.equal(scopeCoversSpendPlan({
      scope,
      state: spentState(),
      plan: {
        items: [{ assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 24_000, attempt: 1 }],
      },
    }), true);
    assert.equal(scopeCoversSpendPlan({
      scope,
      state: spentState({ settledCents: 30_000 }),
      plan: {
        items: [{ assetKey: "scene-1", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 24_000, attempt: 1 }],
      },
    }), false);
    assert.equal(scopeCoversSpendPlan({
      scope,
      state: spentState(),
      plan: {
        items: [{ assetKey: "scene-2", intentDigest: "c".repeat(64), providerId: "seedance-video-v1", modelId: "seedance-v1", quoteCents: 24_000, attempt: 1 }],
      },
    }), false);
  });
});

// ---------------------------------------------------------------------------
// 宿主接受/读取（真实 ProductionPipeline + FileRunStore；角色全部走本地 worker 替身）。
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { ProductionPipeline, type ProductionBrief, type WorkerResponse } from "../src/index.js";

class AuthWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected capability: ${capability}`);
    const scriptDocument = JSON.stringify({
      viewerPromise: "看完能记住三个要点",
      narrativeArc: "问题-方法-清单",
      canonFacts: ["要点可执行"],
      scenes: [1, 2, 3].map((position) => ({
        position,
        narration: `第${position}段旁白`,
        duration: 8,
        visual_strategy: "stock",
        visual_prompt: `第${position}个真实生活动作`,
        search_terms: [`生活动作 ${position}`],
      })),
    });
    const jsonContent = capability === "script.draft" ? scriptDocument : JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    const primaryContent = capability === "video.render" ? "video" : jsonContent;
    await writeFile(primaryPath, primaryContent);
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "audio");
    if (capability === "video.render") await writeFile(String(output.renderManifestPath), jsonContent);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [{
        kind: capability.replace(".", "_"),
        uri: primaryPath,
        sha256: createHash("sha256").update(primaryContent).digest("hex"),
        sizeBytes: Buffer.byteLength(primaryContent),
        contentType: capability === "video.render" ? "video/mp4" : "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }, ...(capability === "video.render" ? [{
        kind: "render_manifest",
        uri: String(output.renderManifestPath),
        sha256: createHash("sha256").update(jsonContent).digest("hex"),
        sizeBytes: Buffer.byteLength(jsonContent),
        contentType: "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }] : [])],
    };
  }
}

describe("foldProductionSpendLedger", () => {
  const root = {
    itemRequestId: "paid-item-root",
    quoteItemId: "scene-1",
    state: "materialized" as const,
    estimatedCostCny: 9,
    actualCostCny: 9,
    taskId: "task-root",
  };
  const alias = {
    itemRequestId: "paid-item-alias",
    quoteItemId: "scene-1",
    state: "materialized" as const,
    estimatedCostCny: 1,
    taskId: "task-alias",
    carriedForwardFromItemRequestId: "paid-item-root",
  };

  it("folds alias inheritance to the physical request's real settlement regardless of input order", () => {
    // root 实际结算 9 元；alias 只是同一物理请求在新操作中的复用记录，旧估价 1 元
    // 不能覆盖真实结算。两种输入顺序必须得到同一个结果（顺序无关）。
    for (const items of [[root, alias], [alias, root]]) {
      const folded = foldProductionSpendLedger(items);
      assert.equal(folded.settledCents, 900, `order ${items[0]!.itemRequestId} must not change the settlement`);
      // alias 不新增 create：同一物理请求只计一次。
      assert.equal(folded.attemptsByAsset["scene-1"], 1);
    }
  });

  it("keeps a conservative reservation for an accepted task whose pricing never settled", () => {
    // 受理后终止但未定价：生成失败不证明未收费——按最高估价保守占用，不归零。
    const folded = foldProductionSpendLedger([{
      itemRequestId: "paid-item-orphan",
      quoteItemId: "scene-2",
      state: "terminal_failed",
      estimatedCostCny: 9,
      taskId: "task-unknown-billing",
    }]);
    assert.equal(folded.settledCents, 0);
    assert.equal(folded.reservedCents, 900);
    // 受理过的 create 计一次尝试。
    assert.equal(folded.attemptsByAsset["scene-2"], 1);
  });

  it("releases and does not count a request that was explicitly never accepted", () => {
    // 明确未受理（create 前被拒、无 task、无费用）：不占用也不计次，可安全重试。
    const folded = foldProductionSpendLedger([{
      itemRequestId: "paid-item-rejected",
      quoteItemId: "scene-3",
      state: "terminal_failed",
      estimatedCostCny: 2.4,
    }]);
    assert.equal(folded.reservedCents, 0);
    assert.deepEqual(Object.keys(folded.attemptsByAsset), []);
  });

  it("refuses to fold conflicting records for the same item request", () => {
    // 同一 itemRequestId 的冲突记录不能按数组顺序"后行覆盖"。
    const { actualCostCny: _rootActual, taskId: _rootTask, ...rootWithoutPricing } = root;
    assert.throws(() => foldProductionSpendLedger([
      root,
      { ...rootWithoutPricing, state: "prepared" },
    ]), /conflicting records/);
  });

  it("keeps prepared reservations out of the create attempt count", () => {
    const folded = foldProductionSpendLedger([{
      itemRequestId: "paid-item-prepared",
      quoteItemId: "scene-4",
      state: "prepared",
      estimatedCostCny: 2.4,
    }]);
    assert.equal(folded.reservedCents, 240);
    assert.deepEqual(Object.keys(folded.attemptsByAsset), []);
  });

  it("releases unsubmitted prepared reservations after their operation reached a terminal receipt", () => {
    const folded = foldProductionSpendLedger([
      {
        operationId: "operation-rejected",
        itemRequestId: "paid-item-rejected-before-submit",
        quoteItemId: "scene-1",
        state: "prepared",
        estimatedCostCny: 5.5,
      },
      {
        operationId: "operation-failed",
        itemRequestId: "paid-item-failed-before-submit",
        quoteItemId: "scene-1",
        state: "prepared",
        estimatedCostCny: 5.5,
      },
      {
        operationId: "operation-active",
        itemRequestId: "paid-item-active-reservation",
        quoteItemId: "scene-2",
        state: "prepared",
        estimatedCostCny: 3,
      },
    ], {
      terminalOperationIds: new Set(["operation-rejected", "operation-failed"]),
    });

    assert.equal(folded.reservedCents, 300);
    assert.deepEqual(Object.keys(folded.attemptsByAsset), []);
  });

});

describe("assessProductionSpendPlan whole-plan amounts", () => {
  const scope = (approvedAmountCents: number) => baseScope({
    approvedAmountCents,
    permittedAssets: [
      { assetKey: "scene-1", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 },
      { assetKey: "scene-2", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 },
      { assetKey: "scene-3", intentDigest: "c".repeat(64), models: [{ providerId: "seedance-video-v1", modelId: "seedance-v1" }], maxCreateAttempts: 2 },
    ],
  });
  const item = (assetKey: string, quoteCents: number) => ({
    assetKey,
    intentDigest: "c".repeat(64),
    providerId: "seedance-video-v1",
    modelId: "seedance-v1",
    quoteCents,
    attempt: 1,
  });

  it("computes the whole-plan shortfall independent of item order", () => {
    // CG-03：已批 500，两个新项 600+700：整份计划最高需求 1300、追加 800——
    // 不能只报告第一个阻断项的缺口，两种条目顺序必须得到同一结果。
    const first = assessProductionSpendPlan({
      scope: scope(500),
      state: spentState(),
      plan: { items: [item("scene-1", 600), item("scene-2", 700)] },
    });
    const second = assessProductionSpendPlan({
      scope: scope(500),
      state: spentState(),
      plan: { items: [item("scene-2", 700), item("scene-1", 600)] },
    });
    assert.equal(first.action, "request_approval");
    assert.equal(first.reason, "amount");
    assert.equal(first.requestedMaximumCents, 1300);
    assert.equal(first.additionalCents, 800);
    assert.equal(first.resultingMaximumCents, 1300);
    assert.deepEqual(
      { r: first.reason, a: first.additionalCents, m: first.requestedMaximumCents },
      { r: second.reason, a: second.additionalCents, m: second.requestedMaximumCents },
    );
  });

  it("never lets a money shortfall mask a scope or quality blocker", () => {
    // CG-03：scene-1 缺钱、scene-2 效果意图在授权后变化（quality）：原因必须是
    // 非金额类（quality），被阻断素材都要出现在 blockedAssets 里；金额缺口仍如实报告。
    const assessment = assessProductionSpendPlan({
      scope: scope(500),
      state: spentState(),
      plan: {
        items: [
          item("scene-1", 600),
          { ...item("scene-2", 700), intentDigest: "d".repeat(64) },
        ],
      },
    });
    assert.equal(assessment.reason, "quality");
    assert.equal(assessment.blockedAssets.some((entry) => entry.assetKey === "scene-2"), true);
    // 金额缺口只对"当前即可执行"的部分负责：scene-2 需要先重新确认效果，把它的报价
    // 计入"同意追加"会误导用户为仍无法运行的内容付钱。
    assert.equal(assessment.additionalCents, 100);
    assert.equal(assessment.action, "request_approval");
  });

  it("folds the plan retry ceiling into the required maximum", () => {
    // 计划最高占用（含重试余量）1440 分、当前可用 720：追加 720 才能完整授权本计划，
    // 不是只补条目首跑的 0 缺口。planMaximumCents 由宿主传入。
    const assessment = assessProductionSpendPlan({
      scope: scope(720),
      state: spentState(),
      planMaximumCents: 1440,
      plan: { items: [item("scene-1", 240), item("scene-2", 240), item("scene-3", 240)] },
    });
    assert.equal(assessment.reason, "amount");
    assert.equal(assessment.requestedMaximumCents, 1440);
    assert.equal(assessment.additionalCents, 720);
  });
});

const AUTH_BRIEF = {
  protocolVersion: "video-factory/brief-v1",
  title: "制作范围授权验证",
  angle: "授权边界",
  audience: "创作者",
  nicheSlug: "auth",
  durationSeconds: 24,
  durationRange: { minSeconds: 20, maxSeconds: 34 },
  platform: "douyin",
  runPurpose: "test",
  reviewMode: "manual",
  providers: {
    script: "codex-screenwriter-v1",
    director: "api-visual-director-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
  workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1" },
  director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
  economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
  voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
} as unknown as ProductionBrief;

describe("production authorization host acceptance", () => {
  it("accepts a scope atomically and rejects stale revisions, duplicates, and foreign chains", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-accept-"));
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new AuthWorker(),
      treatmentAgents: [{
        providerId: "openai",
        agent: {
          id: "codex-creative-treatment-v1",
          modelId: "treatment-model-a",
          treat: async () => ({
            version: "video-factory/creative-treatment-v2",
            viewerPromise: "看完能记住三个要点",
            hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
            progression: [
              { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
              { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
            ],
            payoff: "低风险决策清单",
            visualPrinciples: ["真实动作"],
            soundPrinciples: ["环境声先行"],
            evidenceRequirements: [],
            feasibilityQuestions: [],
          }),
        },
      }],
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        modelId: "screenwriter-model-one",
        draft: async () => ({
          viewerPromise: "看完能记住三个要点",
          narrativeArc: "问题-方法-清单",
          canonFacts: ["要点可执行"],
          scenes: [1, 2, 3].map((position) => ({
            position,
            narration: `第${position}段旁白`,
            duration: 8,
            visual_strategy: "stock",
            visual_prompt: `第${position}个真实生活动作`,
            search_terms: [`生活动作 ${position}`],
          })),
        }),
      } as never,
      directorAgent: {
        id: "api-visual-director-v1",
        modelId: "director-local-model",
        plan: async (input: { brief: { requestedProfileId: string }; scenes: Array<{ position: number }> }) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "用真实动作解释。",
          visualBible: {
            narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
            camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "local-editorial-v1",
            deliveryType: "editorial_card",
            alternativeProviderIds: [],
            temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
            query: `editorial-${scene.position}`,
            generationPrompt: `第${scene.position}个真实生活动作`,
            rationale: "本地说明卡可以执行。",
            continuityNote: "保持自然色。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      } as never,
      assetProviders: [{ id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] }],
    });
    const run = await pipeline.start(AUTH_BRIEF);
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    // 过期 revision 拒绝。
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: run.revision + 5 })),
      /revision|stale/i,
    );
    // 跨 run 授权拒绝。
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({ approvalRevision: run.revision })),
      /belongs to run/,
    );
    // 正确接受（接受本身使 revision + 1，后续接受以新 revision 对齐）。
    const accepted = await pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: run.revision }));
    assert.equal(accepted.id, run.id);
    const revisionAfterAccept = accepted.revision;
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: revisionAfterAccept })),
      /already been accepted/,
    );
    // 读取：当前有效即该份。
    const active = await pipeline.readProductionAuthorization(run.id);
    assert.equal(active?.id, "auth-1");
    // 追加链：supersedes 必须指向当前 head（不存在的授权不是 head；已非 head 的旧授权也不行）。
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({
        id: "auth-2",
        runId: run.id,
        approvalRevision: revisionAfterAccept,
        supersedesAuthorizationId: "missing-auth",
      })),
      /must supersede the current active/,
    );
    const amended = await pipeline.acceptProductionAuthorization(run.id, baseScope({
      id: "auth-2",
      runId: run.id,
      approvalRevision: revisionAfterAccept,
      approvedAmountCents: 150_000,
      supersedesAuthorizationId: "auth-1",
    }));
    assert.equal(amended.id, run.id);
    const activeAfterAmend = await pipeline.readProductionAuthorization(run.id);
    assert.equal(activeAfterAmend?.id, "auth-2");
    assert.equal(activeAfterAmend?.approvedAmountCents, 150_000);
    // 无授权的 run 读取返回 undefined，不伪造。
    const otherRun = await pipeline.start({ ...AUTH_BRIEF, title: "另一条无授权制作" } as ProductionBrief);
    assert.equal(await pipeline.readProductionAuthorization(otherRun.id), undefined);
  });
});

// ---------------------------------------------------------------------------
// C1 宿主自动继续：scope 覆盖当前报价时派生子凭证继续；不覆盖（方案变化/无授权）保持人工等待。
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";

describe("scope-covered spend approval auto-continues", () => {
  async function meteredAwaitingRun(workspaceRoot: string) {
    const treatment: { providerId: string; agent: import("../src/index.js").CreativeTreatmentAgent } = {
      providerId: "openai",
      agent: {
        id: "codex-creative-treatment-v1",
        modelId: "treatment-model-a",
        treat: async () => ({
          version: "video-factory/creative-treatment-v2",
          viewerPromise: "看完能记住三个要点",
          hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
          progression: [
            { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
            { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
          ],
          payoff: "低风险决策清单",
          visualPrinciples: ["真实动作"],
          soundPrinciples: ["环境声先行"],
          evidenceRequirements: [],
          feasibilityQuestions: [],
        }),
      },
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new AuthWorker(),
      treatmentAgents: [treatment],
      screenwriterAgent: {
        id: "codex-screenwriter-v1",
        modelId: "screenwriter-model-one",
        draft: async () => ({
          viewerPromise: "看完能记住三个要点",
          narrativeArc: "问题-方法-清单",
          canonFacts: ["要点可执行"],
          scenes: [1, 2, 3].map((position) => ({
            position,
            narration: `第${position}段旁白`,
            duration: 8,
            visual_strategy: "generated",
            visual_prompt: `第${position}个生成镜头`,
            search_terms: [`镜头 ${position}`],
          })),
        }),
      } as never,
      directorAgent: {
        id: "api-visual-director-v1",
        modelId: "director-model-one",
        plan: async (input: { brief: { requestedProfileId: string }; scenes: Array<{ position: number; visualPrompt?: string }> }) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "生成镜头交付。",
          visualBible: {
            narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
            camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "seedance-video-v1",
            deliveryType: "generated_video",
            alternativeProviderIds: [],
            temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
            query: `镜头内容 ${scene.position}`,
            generationPrompt: `第${scene.position}个生成镜头`,
            rationale: "生成能力可以交付。",
            continuityNote: "保持自然色。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      } as never,
      assetProviders: [
        { id: "seedance-video-v1", label: "Seedance", billing: "metered" as const, modes: ["文生视频"], deliveryTypes: ["generated_video" as const], estimatedCnyPerClip: 2.4, generative: true },
      ],
      providerRuntimeMetadata: [{
        id: "seedance-video-v1", label: "Seedance", modelId: "seedance-v1", transport: "http_api" as const, billing: "metered" as const, estimatedCostCny: 2.4, maxAttempts: 1,
      }],
    });
    const run = await pipeline.start({
      ...AUTH_BRIEF,
      providers: { ...AUTH_BRIEF.providers, assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    } as ProductionBrief);
    assert.equal(run.status, "awaiting_spend_approval", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    return { pipeline, run };
  }

  async function scopeForCurrentQuote(pipeline: ProductionPipeline, runId: string, overrides: Partial<ProductionAuthorizationScope> = {}) {
    const run = await pipeline.show(runId);
    const assets = run.nodeRuns.find((node) => node.nodeId === "assets")!;
    const plan = assets.spendPlan!;
    const effectiveInput = assets.inputState?.versions.find((v) => v.id === assets.inputState?.effectiveVersionId)?.value as { executablePlanPath?: string };
    assert.ok(effectiveInput?.executablePlanPath, "assets input must reference the executable plan");
    const planDigest = createHash("sha256").update(await readFile(effectiveInput.executablePlanPath!)).digest("hex");
    const runBrief = (run as unknown as { initialInput: Record<string, unknown> }).initialInput as unknown as import("../src/index.js").ProductionBrief;
    return baseScope({
      id: "scope-cover",
      runId,
      approvalRevision: run.revision,
      acceptedPlanDigest: planDigest,
      qualityContractDigest: canonicalQualityContractDigest({
        angle: runBrief.angle,
        audience: runBrief.audience,
        durationRange: runBrief.durationRange ?? { minSeconds: 0, maxSeconds: 0 },
        directorProfileId: runBrief.director?.profileId ?? "",
        ...(runBrief.visualProof ? { visualProof: runBrief.visualProof } : {}),
      }),
      approvedAmountCents: Math.round(plan.maxCostCny * 100) + 10_000,
      permittedAssets: (plan.items ?? []).map((item) => ({
        assetKey: item.id,
        // 与正式 issuer（ProductionStudio 引用同一 helper）一致的逐资产 intent 投影；
        // 旧的 SHA256(item.id) fixture 只保留作拒绝用例。
        intentDigest: canonicalProductionAssetIntentDigest(planDigest, item.id),
        models: [{ providerId: item.providerId, modelId: item.modelId }],
        maxCreateAttempts: 2,
      })),
      ...overrides,
    });
  }

  it("rejects a predecessor-less amendment when an active authorization already exists", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-fork-guard-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    // 无 scope 时保持人工等待（awaiting）；首份授权接受（不覆盖任何报价，仅建立链头）。
    const first = await pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: run.revision }));
    // 第二份无前驱授权必须拒绝：接受会造成双幸存者，读取完整性错误、后续追加全挂。
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({
        id: "auth-orphan",
        runId: run.id,
        approvalRevision: first.revision,
      })),
      /must supersede the current active/,
    );
    const active = await pipeline.readProductionAuthorization(run.id);
    assert.equal(active?.id, "auth-1", "the active authorization must remain the sole survivor");
  });

  it("auto-continues a covered quote with a derived sub-authorization", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-auto-continue-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    const scope = await scopeForCurrentQuote(pipeline, run.id);
    const continued = await pipeline.acceptProductionAuthorization(run.id, scope);
    assert.notEqual(continued.status, "awaiting_spend_approval", "the covered quote must continue automatically");
    const derived = continued.spendAuthorizations?.at(-1);
    assert.ok(derived, "a sub-authorization must be derived from the scope");
    assert.match(derived.approvedBy, /制作范围授权 scope-cover/);
    // 子凭证与当前报价计划经原 exact matcher 逐字段一致：不收窄 maxCostCny/maxAttempts，
    // 也不沿用被收窄的 draft 上限——范围约束在逐素材 create 预算（预留层）执行。
    const assetsPlan = continued.nodeRuns.find((node) => node.nodeId === "assets")!.spendPlan!;
    assert.equal(derived.spendPlanId, assetsPlan.id);
    assert.equal(derived.maxCostCny, assetsPlan.maxCostCny);
    assert.equal(derived.maxAttempts, assetsPlan.maxAttempts);
    assert.deepEqual(derived.inputVersionIds, assetsPlan.inputVersionIds);
    assert.equal(derived.derivedFromScopeId, "scope-cover");
    // 派生成功后等待节点不再保留过期的未覆盖评估。
    const waitingNode = continued.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(waitingNode?.spendAssessment, undefined);
    // 明确终点：素材执行在子凭证下真实推进（不再停在报价等待）。
    const persisted = await pipeline.show(run.id);
    assert.notEqual(persisted.status, "awaiting_spend_approval");
  });

  for (const evidence of ["terminal-unsubmitted", "active-unsubmitted", "terminal-submitted"] as const) {
    it(`evaluates persisted operation reservations through host continuation: ${evidence}`, async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-scope-reservations-"));
      const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
      const plan = run.nodeRuns.find((node) => node.nodeId === "assets")!.spendPlan!;
      const scope = await scopeForCurrentQuote(pipeline, run.id, {
        approvedAmountCents: Math.round(plan.maxCostCny * 100),
      });
      const operationId = `${run.id}-previous-assets-operation`;
      const directory = join(workspaceRoot, "runs", run.id, "nodes", "assets", ".generation-operations");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "previous.json"), JSON.stringify({
        version: "video-factory/paid-operation-v2",
        operationId,
        completed: false,
        items: [{
          itemRequestId: "previous-scene-1",
          quoteItemId: "scene-1",
          inputFingerprint: "a".repeat(64),
          sourceFingerprint: "b".repeat(64),
          scenePosition: 1,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: evidence === "terminal-submitted" ? "submitted" : "prepared",
          estimatedCostCny: 2.4,
          parameters: {},
          ...(evidence === "terminal-submitted" ? { taskId: "accepted-provider-task" } : {}),
        }],
      }));
      // 重启前落盘的终态回执是依据；仅存在账本或已受理任务都不能释放占用。
      if (evidence !== "active-unsubmitted") {
        const runPath = join(workspaceRoot, "runs", run.id, "run.json");
        await writeFile(runPath, JSON.stringify({
          ...run,
          executionReceipts: [...(run.executionReceipts ?? []), {
            nodeId: "assets", role: "素材导演", capability: "asset.prepare",
            providerId: "ai-shot-router-v1", transport: "local_process", billing: "metered",
            status: "rejected", requestId: operationId,
            startedAt: run.startedAt, finishedAt: run.startedAt,
          }],
        }));
      }
      const continued = await pipeline.acceptProductionAuthorization(run.id, scope);
      if (evidence === "terminal-unsubmitted") {
        assert.notEqual(continued.status, "awaiting_spend_approval");
        assert.equal(continued.spendAuthorizations?.length, 1);
        assert.equal(continued.spendAuthorizations[0]!.derivedFromScopeId, scope.id);
        assert.equal(continued.spendAuthorizations[0]!.itemCreateBudgets?.["scene-1"], 2);
        const replayed = await pipeline.resumeCoveredSpendApproval(run.id);
        assert.equal(replayed.spendAuthorizations?.length, 1, "a replay must not issue a second credential");
      } else {
        assert.equal(continued.status, "awaiting_spend_approval");
        assert.equal(continued.spendAuthorizations?.length ?? 0, 0);
        assert.equal(continued.nodeRuns.find((node) => node.nodeId === "assets")?.spendAssessment?.additionalCents, 240);
      }
    });
  }

  it("keeps waiting when the scope still carries the legacy per-item intent hash", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-legacy-intent-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    const staleIntentScope = await scopeForCurrentQuote(pipeline, run.id, {
      permittedAssets: await (async () => {
        const shown = await pipeline.show(run.id);
        const plan = shown.nodeRuns.find((node) => node.nodeId === "assets")!.spendPlan!;
        return (plan.items ?? []).map((item) => ({
          assetKey: item.id,
          // 旧签发投影：只哈希素材键。宿主消费侧已迁移到逐资产 canonical 投影，
          // 旧凭证必须被拒绝而不是静默匹配。
          intentDigest: createHash("sha256").update(item.id).digest("hex"),
          models: [{ providerId: item.providerId, modelId: item.modelId }],
          maxCreateAttempts: 2,
        }));
      })(),
    });
    const after = await pipeline.acceptProductionAuthorization(run.id, staleIntentScope);
    assert.equal(after.status, "awaiting_spend_approval", "a legacy-intent scope must not auto-continue");
    assert.equal(after.spendAuthorizations?.length ?? 0, 0);
    const waitingNode = after.nodeRuns.find((node) => node.nodeId === "assets");
    assert.ok(waitingNode?.spendAssessment, "a structured assessment must be recorded for the uncovered quote");
    assert.equal(waitingNode.spendAssessment?.action, "request_approval");
    assert.equal(waitingNode.spendAssessment?.reason, "quality");
  });

  it("fails closed when accepting a new authorization over a corrupted committed chain", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-corrupt-chain-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    const accepted = await pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: run.revision }));
    // 篡改已提交的 head 授权文件：链完整性破坏。
    const corruptedPath = path.join(workspaceRoot, "runs", run.id, "production-authorization", "auth-1.json");
    await writeFile(corruptedPath, `${JSON.stringify({ id: "auth-1", tampered: true })}\n`, "utf8");
    // 损坏链绝不能被解释成"尚无授权"而接受新的首份授权——读取与接受都 fail closed。
    await assert.rejects(
      () => pipeline.readProductionAuthorization(run.id),
      /integrity validation|corrupted/,
    );
    await assert.rejects(
      () => pipeline.acceptProductionAuthorization(run.id, baseScope({
        id: "auth-after-corruption",
        runId: run.id,
        approvalRevision: accepted.revision,
      })),
      /integrity validation/,
    );
  });

  it("fails closed when a committed chain has a schema-valid but broken predecessor reference", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-broken-pred-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    // 通过正式 API 建立两条链头：A（首份）→ B（supersede A）。
    const first = await pipeline.acceptProductionAuthorization(run.id, baseScope({ runId: run.id, approvalRevision: run.revision }));
    await pipeline.acceptProductionAuthorization(run.id, baseScope({
      id: "auth-2",
      runId: run.id,
      approvalRevision: first.revision,
      supersedesAuthorizationId: "auth-1",
    }));
    // 篡改 auth-2 的 supersedes 指向不存在的 auth-missing，并把 run 里的 artifact 摘要
    // 同步改成篡改后内容的摘要：内容与摘要一致、schema 合法，但前驱缺失——链遍历必须拦截。
    const authPath = path.join(workspaceRoot, "runs", run.id, "production-authorization", "auth-2.json");
    const tamperedScope = {
      ...(JSON.parse(await readFile(path.join(workspaceRoot, "runs", run.id, "production-authorization", "auth-1.json"), "utf8")) as Record<string, unknown>),
      id: "auth-2",
      supersedesAuthorizationId: "auth-missing",
    };
    const tamperedContent = `${JSON.stringify(tamperedScope, null, 2)}\n`;
    await writeFile(authPath, tamperedContent, "utf8");
    const runJsonPath = path.join(workspaceRoot, "runs", run.id, "run.json");
    const runJson = JSON.parse(await readFile(runJsonPath, "utf8")) as { artifacts: Array<{ id: string; sha256: string }> };
    const artifact = runJson.artifacts.find((entry) => entry.id === "production-authorization:auth-2")!;
    artifact.sha256 = createHash("sha256").update(tamperedContent).digest("hex");
    await writeFile(runJsonPath, `${JSON.stringify(runJson, null, 2)}\n`, "utf8");

    // 读取：唯一幸存者仍是 auth-2，但前驱缺失 → 完整性错误（fail closed）。
    await assert.rejects(
      () => pipeline.readProductionAuthorization(run.id),
      /is not committed|integrity validation/,
    );
  });

  it("keeps waiting when the accepted plan digest no longer matches the current plan", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-auto-continue-stale-"));
    const { pipeline, run } = await meteredAwaitingRun(workspaceRoot);
    const scope = await scopeForCurrentQuote(pipeline, run.id, {
      acceptedPlanDigest: "f".repeat(64),
    });
    const after = await pipeline.acceptProductionAuthorization(run.id, scope);
    assert.equal(after.status, "awaiting_spend_approval", "a scope for a different plan must not cover the current quote");
    assert.equal(after.spendAuthorizations?.length ?? 0, 0);
  });

  it("keeps waiting with no accepted scope", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vf-c1-auto-continue-none-"));
    const { run } = await meteredAwaitingRun(workspaceRoot);
    assert.equal(run.status, "awaiting_spend_approval");
  });
});
