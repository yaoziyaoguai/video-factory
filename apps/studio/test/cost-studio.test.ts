import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CostStudio } from "../src/server/cost-studio.js";
import { projectCheckpointExecutions } from "../../../packages/production-pipeline/src/model-execution-facts.js";

describe("CostStudio", () => {
  it("counts the current human wait beyond the runner's per-pass finishedAt", async () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const pausedAt = "2026-01-01T00:00:10.000Z";
    const studio = new CostStudio(async () => [{ id: "run-open-wait", status: "needs_human",
      startedAt, finishedAt: pausedAt, interventions: [{ id: "gate", createdAt: pausedAt }], decisions: [],
      nodeRuns: [{ nodeId: "brief", status: "needs_human", intervention: { id: "gate" } }],
      executionReceipts: [], spendAuthorizations: [] }]);
    const timing = (await studio.runDetail("run-open-wait"))?.timing;
    assert.ok(timing);
    assert.equal(timing.wallElapsedMs, Date.parse(timing.observedAt) - Date.parse(startedAt));
    assert.equal(timing.humanWaitMs, Date.parse(timing.observedAt) - Date.parse(pausedAt));
  });
  it("separates elapsed wall time and overlapping human stops without inventing recovery time", async () => {
    const run = { id: "timed", status: "succeeded", startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:01:00Z",
      interventions: [{ id: "one", createdAt: "2026-09-27T00:00:10Z" }, { id: "two", createdAt: "2026-09-27T00:00:15Z" }],
      decisions: [{ interventionId: "one", createdAt: "2026-09-27T00:00:20Z" }, { interventionId: "two", createdAt: "2026-09-27T00:00:30Z" }], nodeRuns: [] };
    const original = structuredClone(run);
    const studio = new CostStudio(async () => [run]);
    const result = await studio.runDetail("timed");
    assert.equal(result?.timing?.wallElapsedMs, 60_000);
    assert.equal(result?.timing?.humanWaitMs, 20_000, "重叠停点求并集，不相加为25秒");
    assert.equal(result?.timing?.recoveryMs, null, "没有本次恢复起止证据不推算");
    assert.deepEqual(run, original, "统计不可写回运行状态");
    const legacy = new CostStudio(async () => [{ ...run, interventions: undefined, decisions: undefined }]);
    assert.equal((await legacy.runDetail("timed"))?.timing?.humanWaitMs, null);
    const unmatched = new CostStudio(async () => [{ ...run, decisions: [] }]);
    assert.equal((await unmatched.runDetail("timed"))?.timing?.humanWaitMs, null, "未闭合的历史停点不能猜成0");
  });

  it("uses physical facts, not legacy cumulative snapshots or checkpoint-invented free bills", async () => {
    const facts = projectCheckpointExecutions("creative-planning", {
      key: "loop", cycle: 0, attemptedRequestIds: ["p", "a1", "a2", "a3"],
      requestOwners: { p: "old", a1: "old", a2: "old", a3: "old" },
      requestPhases: { p: { phase: "produce", iteration: 1 }, a1: { phase: "audit", iteration: 1 }, a2: { phase: "audit", iteration: 2 }, a3: { phase: "audit", iteration: 3 } },
      completed: [1, 2, 3].map((iteration) => ({ iteration,
        auditTrace: { providerId: "provider", modelId: "model", modelAttemptCount: 1 },
        ...(iteration === 1 ? { candidateTrace: { providerId: "provider", modelId: "model", modelAttemptCount: 1 } } : {}),
      })),
    }, "loop.json");
    const snapshot = (count: number, index: number, linked: boolean) => ({
      nodeId: "creative-planning", providerId: "provider", modelId: "model", billing: "subscription",
      startedAt: `2026-09-27T00:00:0${index}Z`, parameters: { modelCallCount: count },
      ...(linked ? { requestId: "old" } : {}),
    });
    for (const linked of [true, false]) {
      const run = { id: "facts", nodeRuns: [], executionReceipts: [2, 4, 4].map((count, i) => snapshot(count, i, linked)) };
      const original = structuredClone(run);
      const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
        async () => ({ facts, issues: [], currentOperationIds: { "creative-planning": "resume" } }));
      const detail = await studio.runDetail(run.id);
      assert.equal(detail?.totals.verifiedBrokerRequests, 4);
      assert.equal(detail?.totals.verifiedModelAttempts, 4);
      assert.equal(detail?.totals.countExact, linked);
      assert.equal(detail?.totals.legacyUnattributedReceipts, linked ? 0 : 3);
      assert.equal(detail?.totals.newBrokerRequestsThisAttempt, linked ? 0 : null);
      assert.equal(detail?.totals.newModelAttemptsThisAttempt, linked ? 0 : null);
      if (!linked) {
        const evidenceOnly = detail!.lines.filter((line) => line.accountingSource === "execution_fact");
        assert.equal(evidenceOnly.length, 4);
        assert.ok(evidenceOnly.every((line) => line.billing === "unverified" && line.actualPending && line.estimatedCostCny === null));
      }
      assert.deepEqual(run, original);
      assert.deepEqual((await studio.runDetail(run.id))?.totals, detail?.totals);
      assert.equal((await studio.dashboard()).totals.verifiedModelAttempts, 4);
    }
  });

  it("does not call a workflow receipt requestId a verified broker task without broker evidence", async () => {
    const studio = new CostStudio(async () => [{ id: "only-workflow", executionReceipts: [{
      nodeId: "script", requestId: "workflow-op", providerId: "text", modelId: "m", billing: "subscription",
      startedAt: "2026-09-27T00:00:00Z", parameters: { modelCallCount: 4 },
    }] }]);
    const detail = await studio.runDetail("only-workflow");
    assert.equal(detail?.totals.verifiedBrokerRequests, 0);
    assert.equal(detail?.totals.verifiedModelAttempts, 0);
    assert.equal(detail?.totals.countExact, false);
  });

  it("merges cumulative attempts by physical request without losing independent provider requests", async () => {
    const receipt = { nodeId: "visual-review", providerId: "openai", modelId: "model-a", billing: "subscription",
      requestId: "physical-one", status: "succeeded", startedAt: "2026-09-27T00:00:00Z" };
    const studio = new CostStudio(async () => [{ id: "physical-counts", nodeRuns: [], executionReceipts: [
      { ...receipt, parameters: { modelCallCount: 1 } },
      { ...receipt, parameters: { modelCallCount: 3 } },
      { ...receipt, parameters: { modelCallCount: 3 } },
      { ...receipt, requestId: "independent", parameters: { modelCallCount: 2 } },
    ] }]);
    const detail = await studio.runDetail("physical-counts");
    assert.equal(detail?.totals.subscriptionCalls, 5, "同请求1→3→3计3次，独立请求2次另计");
    assert.equal(detail?.lines.length, 2);
    const namespaces = new CostStudio(async () => [{ id: "provider-namespaces", nodeRuns: [], executionReceipts: [
      { ...receipt, parameters: { modelCallCount: 3 } },
      { ...receipt, providerId: "anthropic", parameters: { modelCallCount: 2 } },
    ] }]);
    const separate = await namespaces.runDetail("provider-namespaces");
    assert.equal(separate?.lines.length, 2, "两家供应方可独立生成同名请求ID");
    assert.equal(separate?.totals.subscriptionCalls, 5);
  });

  it("never clears an established conflict when later unrelated fields differ", async () => {
    const receipt = { id: "receipt-a", nodeId: "voice", providerId: "minimax", modelId: "speech", billing: "metered",
      requestId: "original", status: "succeeded", startedAt: "2026-09-27T00:00:00Z", actualCostCny: 1 };
    const studio = new CostStudio(async () => [{ id: "conflict-sticky", nodeRuns: [], executionReceipts: [
      receipt, { ...receipt, actualCostCny: 2, finishedAt: "2026-09-27T00:00:20Z", parameters: { observed: "again" } },
      { ...receipt, id: "receipt-c", modelId: "different-model" },
    ] }]);
    const detail = await studio.runDetail("conflict-sticky");
    assert.equal(detail?.totals.countConflicts, 1);
    assert.equal(detail?.totals.countExact, false);
    assert.equal(detail?.lines[0]?.actualCostCny, 1);
  });

  it("keeps conflicting authoritative cash receipts visible instead of letting the last one win", async () => {
    const receipt = { nodeId: "voice", providerId: "minimax", modelId: "speech", billing: "metered",
      requestId: "original", status: "succeeded", startedAt: "2026-09-27T00:00:00Z" };
    const studio = new CostStudio(async () => [{ id: "cash-conflict", nodeRuns: [], executionReceipts: [receipt] }],
      undefined, async () => [ { ...receipt, actualCostCny: 1, actualCostSource: "provider_reported" },
        { ...receipt, actualCostCny: 2, actualCostSource: "provider_reported" } ]);
    const detail = await studio.runDetail("cash-conflict");
    assert.equal(detail?.lines[0]?.actualCostCny, 1);
    assert.equal(detail?.totals.countConflicts, 1);
  });

  it("projects recovered paid ledger evidence once without rewriting stored receipts", async () => {
    const receipt = {
      nodeId: "assets", providerId: "wan", modelId: "wan3", billing: "metered",
      startedAt: "2026-09-26T01:00:00Z", requestId: "original", actualCostCny: 0, meteredAttemptCount: 0,
    };
    const run = { id: "recovered-spend", nodeRuns: [], executionReceipts: [receipt, {
      ...receipt, requestId: "remainder", actualCostCny: 6, meteredAttemptCount: 1,
    }] };
    const original = structuredClone(run);
    const studio = new CostStudio(async () => [run], undefined, async () => [
      { ...receipt, actualCostCny: 6, meteredAttemptCount: 1, actualCostSource: "configured_rate" },
    ]);
    const detail = await studio.runDetail(run.id);
    assert.equal(detail?.totals.actualCostCny, 12);
    assert.equal(detail?.totals.meteredCalls, 2);
    assert.equal(detail?.lines.length, 2);
    assert.deepEqual((await studio.runDetail(run.id))?.totals, detail?.totals);
    assert.deepEqual(run, original);
  });

  it("uses verified cumulative asset-ledger costs across same-operation recovery snapshots", async () => {
    const receipt = { nodeId: "assets", providerId: "wan", modelId: "wan3", billing: "metered",
      requestId: "same-operation", status: "needs_human", startedAt: "2026-10-07T00:00:00Z",
      actualCostCny: 3, actualCostSource: "configured_rate", meteredAttemptCount: 1, meteredFailedAttemptCount: 0 };
    for (const addedCost of [0, 0.75]) {
      const current = { ...receipt, actualCostCny: addedCost, meteredAttemptCount: addedCost ? 3 : 0 };
      const run = { id: "pilot-recovery", nodeRuns: [{ nodeId: "assets", executionReceipt: current }],
        executionReceipts: [receipt, current] };
      const original = structuredClone(run);
      const projection = { ...receipt, actualCostCny: 3 + addedCost, meteredAttemptCount: addedCost ? 4 : 1,
        parameters: { paidAssetLedgerCumulative: true } };
      const studio = new CostStudio(async () => [run], undefined, async () => [projection]);
      const detail = await studio.runDetail(run.id);
      assert.equal(detail?.totals.actualCostCny, 3 + addedCost);
      assert.equal(detail?.totals.meteredCalls, addedCost ? 4 : 1);
      assert.equal(detail?.totals.countConflicts, 0);
      assert.equal(detail?.lines.length, 1);
      assert.deepEqual(run, original, "只读投影不得回写任何旧回执");
    }
  });

  it("uses the bound quote rather than the catalog estimate and exposes running authorization", async () => {
    const run = { id: "run-quote", initialInput: {}, nodeRuns: [{ nodeId: "assets", status: "running", operationRequestId: "op", spendAuthorizationId: "spend", startedAt: "2026-09-26T01:00:00Z", spendPlan: { id: "quote", providerId: "wan", modelId: "wan3", estimatedCostCny: 12 } }],
      spendAuthorizations: [{ id: "spend", nodeId: "assets", spendPlanId: "quote", providerId: "wan", modelId: "wan3", maxCostCny: 12 }], executionReceipts: [] as Record<string, unknown>[],
    };
    const studio = new CostStudio(async () => [run]);
    assert.equal((await studio.runDetail(run.id))?.totals.authorizedCostCny, 12);
    assert.equal((await studio.runDetail(run.id))?.totals.meteredCalls, 0, "授权不代表已调用");
    run.executionReceipts.push({ nodeId: "assets", providerId: "wan", modelId: "wan3", billing: "metered", startedAt: "2026-09-26T01:00:00Z", requestId: "op", spendAuthorizationId: "spend", estimatedCostCny: 1.2, actualCostCny: 6 });
    assert.equal((await studio.runDetail(run.id))?.totals.estimatedCostCny, 12);
  });

  it("includes checkpoint-only brief and late planning calls once without inventing a cash bill", async () => {
    const run = { id: "run-checkpoints", initialInput: { title: "恢复调用" }, nodeRuns: [], executionReceipts: [
      { nodeId: "creative-planning", providerId: "deepseek", modelId: "deepseek-flash", billing: "subscription", startedAt: "2026-09-26T01:00:00Z", requestId: "old-operation", parameters: { modelCallCount: 7 } },
    ] };
    const studio = new CostStudio(async () => [run], async () => [
      { nodeId: "brief", providerId: "deepseek", modelId: "deepseek-flash", modelCallCount: 2 },
      { nodeId: "creative-planning", providerId: "deepseek", modelId: "deepseek-flash", modelCallCount: 8 },
    ]);
    const detail = await studio.runDetail(run.id);
    assert.equal(detail?.totals.subscriptionCalls, 7, "checkpoint不能推断计费方式为订阅");
    assert.equal(detail?.lines.find((line) => line.nodeId === "brief")?.modelCallCount, 2);
    assert.equal(detail?.lines.find((line) => line.id === "checkpoint:creative-planning")?.modelCallCount, 1);
    assert.equal(detail?.lines.find((line) => line.id === "checkpoint:brief")?.estimatedCostCny, null);
    assert.equal(detail?.totals.actualPendingCount, 2);
    assert.equal(detail?.totals.countExact, false, "旧聚合计数缺物理身份，不能认作精确总数");
    assert.equal(detail?.lines.find((line) => line.id === "checkpoint:brief")?.actualCostCny, undefined);
    assert.deepEqual((await studio.runDetail(run.id))?.totals, detail?.totals);
    assert.equal(run.executionReceipts.length, 1, "成本投影不得改写历史回执");
  });

  it("keeps test-run spend in the ledger while separating billing types", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-1",
      initialInput: { title: "第一条付费成片", runPurpose: "test" },
      nodeRuns: [
        { nodeId: "script", role: "编剧", status: "succeeded" },
        { nodeId: "assets", role: "素材导演", status: "succeeded" },
        { nodeId: "render", role: "剪辑师", status: "succeeded" },
      ],
      executionReceipts: [
        { id: "receipt-1", nodeId: "script", capability: "script.draft", providerId: "openai-codex", modelId: "codex", billing: "subscription", status: "succeeded", startedAt: "2026-08-27T10:00:00.000Z", finishedAt: "2026-08-27T10:00:02.000Z", estimatedCostCny: 0 },
        { id: "receipt-2", nodeId: "assets", capability: "asset.generate.video", providerId: "minimax-video", modelId: "MiniMax-Hailuo", billing: "metered", status: "succeeded", spendAuthorizationId: "spend-1", startedAt: "2026-08-27T10:01:00.000Z", finishedAt: "2026-08-27T10:03:00.000Z", estimatedCostCny: 5, actualCostCny: 4.2, actualCostSource: "configured_rate", meteredAttemptCount: 1, meteredFailedAttemptCount: 0 },
        { id: "receipt-3", nodeId: "render", capability: "video.render", providerId: "python-ffmpeg-v1", modelId: "ffmpeg", billing: "free", status: "succeeded", startedAt: "2026-08-27T10:04:00.000Z", finishedAt: "2026-08-27T10:04:10.000Z", estimatedCostCny: 0 },
      ],
      spendAuthorizations: [
        { id: "spend-1", nodeId: "assets", providerId: "minimax-video", modelId: "MiniMax-Hailuo", maxCostCny: 6, maxAttempts: 1, approvedAt: "2026-08-27T10:00:50.000Z" },
      ],
    }]));

    const dashboard = await studio.dashboard();
    assert.deepEqual(dashboard.totals, {
      estimatedCostCny: 5,
      authorizedCostCny: 6,
      actualCostCny: 4.2,
      actualPendingCount: 0,
      meteredCalls: 1,
      subscriptionCalls: 1,
      freeCalls: 1,
      failedMeteredCalls: 0,
      verifiedModelAttempts: 0,
      verifiedBrokerRequests: 0,
      legacyUnattributedReceipts: 0,
      countExact: false,
      countConflicts: 0,
      newBrokerRequestsThisAttempt: null,
      newModelAttemptsThisAttempt: null,
      cumulativeProviderMs: null,
      cumulativeQueueMs: null,
      cumulativeRequestMs: null,
      requestWallUnionMs: null,
    });
    assert.equal(dashboard.byProvider.find((item) => item.providerId === "minimax-video")?.actualCostCny, 4.2);
    assert.equal(dashboard.runs[0]?.title, "第一条付费成片");
    assert.equal((await studio.runDetail("run-1"))?.lines[1]?.authorizedCostCny, 6);
    assert.equal((await studio.runDetail("run-1"))?.lines[1]?.actualCostSource, "configured_rate");
  });

  it("keeps unknown actual spend pending and counts failed metered retries", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-2",
      initialInput: { title: "失败重试" },
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "failed" }],
      executionReceipts: [
        { id: "receipt-4", nodeId: "assets", capability: "asset.generate.video", providerId: "provider-x", modelId: "video-x", billing: "metered", startedAt: "2026-08-27T11:00:00.000Z", finishedAt: "2026-08-27T11:00:01.000Z", estimatedCostCny: 3, status: "failed" },
      ],
      spendAuthorizations: [],
    }]));

    const dashboard = await studio.dashboard();
    assert.equal(dashboard.totals.actualCostCny, 0);
    assert.equal(dashboard.totals.actualPendingCount, 1);
    assert.equal(dashboard.totals.meteredCalls, 0);
    assert.equal(dashboard.totals.failedMeteredCalls, 0);
  });

  it("keeps an interrupted authorized provider request visible while its actual cost is unknown", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-uncertain-paid",
      initialInput: { title: "中断的付费生成" },
      nodeRuns: [{
        nodeId: "assets",
        role: "素材导演",
        status: "failed",
        startedAt: "2026-08-27T11:00:00.000Z",
        outcomeUncertain: true,
        operationRequestId: "provider-operation-1",
        spendAuthorizationId: "authorization-uncertain",
        spendPlan: {
          providerId: "minimax-video",
          modelId: "MiniMax-Hailuo",
          estimatedCostCny: 2.4,
        },
      }],
      executionReceipts: [],
      spendAuthorizations: [{
        id: "authorization-uncertain",
        nodeId: "assets",
        providerId: "minimax-video",
        modelId: "MiniMax-Hailuo",
        maxCostCny: 3,
      }],
    }]));

    const detail = await studio.runDetail("run-uncertain-paid");

    assert.equal(detail?.lines.length, 1);
    assert.equal(detail?.totals.authorizedCostCny, 3);
    assert.equal(detail?.totals.actualCostCny, 0);
    assert.equal(detail?.totals.actualPendingCount, 1);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.lines[0]?.status, "unknown");
    assert.equal(detail?.lines[0]?.actualPending, true);
  });

  it("keeps an interrupted automatic voice request visible without inventing an actual charge", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-uncertain-voice",
      initialInput: { title: "中断的自动配音" },
      executionPlan: [{
        nodeId: "voice",
        capability: "voice.synthesize",
        providerId: "minimax-tts-v1",
        modelId: "speech-2.8-hd",
        billing: "metered",
        estimatedCostCny: 0.08,
      }],
      nodeRuns: [{
        nodeId: "voice",
        role: "声音导演",
        status: "failed",
        startedAt: "2026-08-27T11:10:00.000Z",
        outcomeUncertain: true,
        operationRequestId: "voice-operation-uncertain",
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-uncertain-voice");

    assert.equal(detail?.lines.length, 1);
    assert.equal(detail?.lines[0]?.providerId, "minimax-tts-v1");
    assert.equal(detail?.lines[0]?.capability, "voice.synthesize");
    assert.equal(detail?.lines[0]?.estimatedCostCny, 0.08);
    assert.equal(detail?.lines[0]?.actualCostCny, undefined);
    assert.equal(detail?.lines[0]?.actualPending, true);
    assert.equal(detail?.totals.meteredCalls, 1);
  });

  it("does not report a pending bill when the provider rejected before task submission", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-definitive-rejection",
      initialInput: { title: "提交前被拒绝" },
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        outcomeUncertain: true,
        operationRequestId: "provider-operation-rejected",
        executionReceipt: {
          id: "receipt-rejected",
          nodeId: "assets",
          capability: "asset.prepare",
          providerId: "seedream-image-v1",
          modelId: "doubao-seedream-test",
          billing: "metered",
          status: "failed",
          requestId: "provider-operation-rejected",
          startedAt: "2026-08-27T11:00:00.000Z",
          finishedAt: "2026-08-27T11:00:01.000Z",
          estimatedCostCny: 1.75,
          actualCostCny: 0,
          actualCostSource: "configured_rate",
          meteredAttemptCount: 0,
          meteredFailedAttemptCount: 0,
        },
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-definitive-rejection");

    assert.equal(detail?.totals.actualCostCny, 0);
    assert.equal(detail?.totals.actualPendingCount, 0);
    assert.equal(detail?.totals.meteredCalls, 0);
    assert.equal(detail?.lines[0]?.actualPending, false);
  });

  it("counts every producer and auditor call in an agent loop", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-agent-loop",
      executionReceipts: [{
        id: "script-loop",
        nodeId: "script",
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        billing: "subscription",
        status: "succeeded",
        startedAt: "2026-08-27T11:00:00.000Z",
        parameters: { agentLoopIterations: 3, modelCallCount: 6 },
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-agent-loop");

    assert.equal(detail?.totals.subscriptionCalls, 6);
    assert.equal(detail?.lines[0]?.subscriptionCallCount, 6);
    assert.equal((await studio.dashboard()).byProvider[0]?.calls, 6);
  });

  it("infers legacy metered attempts only from accepted-request evidence", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-legacy-evidence",
      executionReceipts: [
        { id: "actual-cost", nodeId: "image", providerId: "provider-a", modelId: "image-a", billing: "metered", status: "succeeded", startedAt: "2026-08-27T11:01:00.000Z", estimatedCostCny: 1, actualCostCny: 0.8 },
        { id: "accepted-request", nodeId: "video", providerId: "provider-b", modelId: "video-b", billing: "metered", status: "unknown", requestId: "request-123", startedAt: "2026-08-27T11:02:00.000Z", estimatedCostCny: 3 },
        { id: "estimate-only", nodeId: "voice", providerId: "provider-c", modelId: "voice-c", billing: "metered", status: "succeeded", startedAt: "2026-08-27T11:03:00.000Z", estimatedCostCny: 0.2 },
      ],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-legacy-evidence");

    assert.equal(detail?.totals.meteredCalls, 2);
    assert.equal(detail?.totals.actualCostCny, 0.8);
    assert.equal(detail?.totals.actualPendingCount, 2);
    assert.equal(detail?.lines.find((line) => line.id === "estimate-only")?.meteredAttemptCount, undefined);
  });

  it("keeps historical retries while deduplicating the current node receipt", async () => {
    const first = { nodeId: "assets", capability: "asset.prepare", providerId: "hailuo-video-v1", modelId: "MiniMax-Hailuo", billing: "metered", startedAt: "2026-08-27T11:00:00.000Z", estimatedCostCny: 3, meteredAttemptCount: 1, meteredFailedAttemptCount: 0 };
    const second = { ...first, startedAt: "2026-08-27T11:05:00.000Z" };
    const studio = new CostStudio(async () => ([{
      id: "run-3",
      nodeRuns: [{ nodeId: "assets", status: "succeeded", executionReceipt: second }],
      executionReceipts: [first, second],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-3");
    assert.equal(detail?.lines.length, 2);
    assert.equal(detail?.totals.meteredCalls, 2);
    assert.equal(detail?.totals.estimatedCostCny, 6);
  });

  it("counts an interrupted operation only once when its original provider task is resumed", async () => {
    const first = {
      id: "interrupted-attempt",
      nodeId: "assets",
      capability: "asset.prepare",
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo",
      billing: "metered",
      status: "failed",
      requestId: "stable-operation-1",
      startedAt: "2026-08-27T11:00:00.000Z",
      estimatedCostCny: 2.4,
      actualCostCny: 2.4,
      meteredAttemptCount: 1,
      meteredFailedAttemptCount: 1,
    };
    const resumed = {
      ...first,
      id: "resumed-attempt",
      status: "succeeded",
      startedAt: "2026-08-27T11:05:00.000Z",
      meteredFailedAttemptCount: 0,
    };
    const studio = new CostStudio(async () => ([{
      id: "run-resumed-operation",
      nodeRuns: [{ nodeId: "assets", status: "succeeded", executionReceipt: resumed }],
      executionReceipts: [first, resumed],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-resumed-operation");

    assert.equal(detail?.lines.length, 1);
    assert.equal(detail?.lines[0]?.status, "succeeded");
    assert.equal(detail?.totals.actualCostCny, 2.4);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.totals.failedMeteredCalls, 0);
    assert.equal(detail?.totals.countConflicts, 0, "恢复后已结清，较早的本地失败快照不是新的服务商终态冲突");
  });

  it("keeps the authorized baseline after a paid node is replaced by a human version", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-human-revision",
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "succeeded" }],
      executionReceipts: [{
        id: "paid-attempt",
        nodeId: "assets",
        providerId: "minimax",
        modelId: "video",
        billing: "metered",
        status: "succeeded",
        startedAt: "2026-08-27T11:00:00.000Z",
        estimatedCostCny: 2.1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-human-revision");
    assert.equal(detail?.totals.authorizedCostCny, 2.1);
    assert.equal(detail?.totals.meteredCalls, 0);
  });

  it("prefers the immutable receipt authorization over mutable run state", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-receipt-authorization",
      executionReceipts: [{
        id: "paid-attempt",
        nodeId: "assets",
        providerId: "minimax",
        modelId: "video",
        billing: "metered",
        status: "succeeded",
        spendAuthorizationId: "authorization-retired",
        authorizedCostCny: 3,
        startedAt: "2026-08-27T11:00:00.000Z",
        estimatedCostCny: 2.1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-receipt-authorization");
    assert.equal(detail?.totals.authorizedCostCny, 3);
    assert.equal(detail?.lines[0]?.spendAuthorizationId, "authorization-retired");
  });

  it("counts one authorization across retries and trusts receipt status over the current node", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-4",
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "failed" }],
      executionReceipts: [
        { id: "attempt-1", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "succeeded", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:00:00.000Z", estimatedCostCny: 2, actualCostCny: 1.8, meteredAttemptCount: 1, meteredFailedAttemptCount: 0 },
        { id: "attempt-2", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "failed", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:01:00.000Z", estimatedCostCny: 2, meteredAttemptCount: 1, meteredFailedAttemptCount: 1 },
      ],
      spendAuthorizations: [{ id: "authorization-1", nodeId: "assets", providerId: "minimax", modelId: "video", maxCostCny: 5 }],
    }]));

    const detail = await studio.runDetail("run-4");
    assert.equal(detail?.totals.authorizedCostCny, 5);
    assert.deepEqual(detail?.lines.map((line) => line.status), ["succeeded", "failed"]);
    assert.equal(detail?.totals.failedMeteredCalls, 1);
  });

  it("counts nested metered attempts even when the asset node succeeds through a free fallback", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-fallback",
      executionReceipts: [{
        id: "asset-router",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "seedance",
        billing: "metered",
        status: "succeeded",
        startedAt: "2026-08-28T11:00:00.000Z",
        estimatedCostCny: 8,
        actualCostCny: 8,
        actualCostSource: "configured_rate",
        meteredAttemptCount: 1,
        meteredFailedAttemptCount: 1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-fallback");
    assert.equal(detail?.totals.actualCostCny, 8);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.totals.failedMeteredCalls, 1);
    assert.equal(detail?.lines[0]?.meteredFailedAttemptCount, 1);
  });

  it("attributes a routed media charge to the provider and model that actually generated it", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-routed-seedream",
      executionReceipts: [{
        id: "asset-router",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "router-v1",
        actualModelIds: ["doubao-seedream-4-0-250828"],
        billing: "metered",
        status: "succeeded",
        spendAuthorizationId: "authorization-routed",
        startedAt: "2026-08-28T12:00:00.000Z",
        estimatedCostCny: 1.75,
        authorizedCostCny: 2,
        actualCostCny: 1.75,
        actualCostSource: "configured_rate",
        meteredAttemptCount: 1,
      }],
      spendAuthorizations: [{
        id: "authorization-routed",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "router-v1",
        maxCostCny: 2,
      }],
    }]));

    const dashboard = await studio.dashboard();
    const detail = await studio.runDetail("run-routed-seedream");

    assert.equal(dashboard.byProvider.find((item) => item.providerId === "seedream-image-v1")?.actualCostCny, 1.75);
    assert.equal(dashboard.byProvider.some((item) => item.providerId === "ai-shot-router-v1"), false);
    assert.equal(detail?.lines[0]?.providerId, "seedream-image-v1");
    assert.equal(detail?.lines[0]?.modelId, "doubao-seedream-4-0-250828");
    assert.equal(detail?.totals.actualCostCny, 1.75);
    assert.equal(detail?.totals.authorizedCostCny, 2);
    assert.equal(detail?.totals.meteredCalls, 1);
  });

  it("attributes a legacy routed MiniMax receipt from its recorded model while keeping unknown cost pending", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-routed-legacy-minimax",
      executionReceipts: [{
        id: "legacy-asset-router",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "MiniMax-Hailuo-2.3",
        billing: "metered",
        status: "succeeded",
        requestId: "command-legacy-minimax",
        startedAt: "2026-08-28T12:00:00.000Z",
        estimatedCostCny: 2.4,
      }],
      spendAuthorizations: [],
    }]));

    const dashboard = await studio.dashboard();
    const detail = await studio.runDetail("run-routed-legacy-minimax");

    assert.equal(detail?.lines[0]?.providerId, "hailuo-video-v1");
    assert.equal(detail?.lines[0]?.modelId, "MiniMax-Hailuo-2.3");
    assert.equal(detail?.lines[0]?.actualCostCny, undefined);
    assert.equal(detail?.lines[0]?.actualPending, true);
    assert.equal(dashboard.byProvider.find((item) => item.providerId === "hailuo-video-v1")?.actualPendingCount, 1);
    assert.equal(dashboard.byProvider.some((item) => item.providerId === "ai-shot-router-v1"), false);
  });

  it("keeps legacy routed receipts on the router when their model cannot identify one provider", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-routed-legacy-unknown",
      executionReceipts: [{
        id: "legacy-asset-router",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "custom-router-selection",
        billing: "metered",
        status: "succeeded",
        requestId: "command-legacy-unknown",
        startedAt: "2026-08-28T12:00:00.000Z",
        estimatedCostCny: 2.4,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-routed-legacy-unknown");

    assert.equal(detail?.lines[0]?.providerId, "ai-shot-router-v1");
    assert.equal(detail?.lines[0]?.modelId, "custom-router-selection");
  });

  it("does not let independent document commands cancel missing checkpoint usage or look free", async () => {
    const original = { nodeId: "reference-grammar", requestId: "initial", providerId: "text", modelId: "m",
      billing: "subscription", startedAt: "2026-09-27T01:00:00Z", parameters: { modelCallCount: 1 } };
    const command = { nodeId: "reference-grammar", requestId: "doc-1", providerId: "text", modelId: "m",
      billing: "subscription", startedAt: "2026-09-27T01:01:00Z",
      parameters: { accountingSource: "document_operation", modelCallCount: 2, billingPending: true } };
    const studio = new CostStudio(async () => [{ id: "run-commands", executionReceipts: [original, command] }],
      async () => [{ nodeId: "reference-grammar", providerId: "text", modelId: "m", modelCallCount: 3 }]);
    const detail = await studio.runDetail("run-commands");
    assert.equal(detail?.totals.subscriptionCalls, 3, "仅原回执声明的订阅计数，checkpoint不能新增订阅事实");
    assert.equal(detail?.totals.unverifiedModelCalls, 2, "checkpoint补充和独立主动操作都保留");
    assert.equal(detail?.totals.actualPendingCount, 2, "没有账单不能当成免费");
    assert.equal(detail?.lines.find((line) => line.accountingSource === "document_operation")?.actualCostCny, undefined);
  });

  it("keeps unverified API billing separate from free and subscription usage while counting real attempts", async () => {
    const studio = new CostStudio(async () => [{ id: "unverified", executionReceipts: [{
      nodeId: "publish-package", requestId: "doc-api", providerId: "api-provider", modelId: "api-model",
      billing: "unverified", status: "failed", startedAt: "2026-09-27T01:00:00Z",
      parameters: { accountingSource: "document_operation", modelCallCount: 2, billingPending: true },
    }] }]);
    const detail = await studio.runDetail("unverified");
    assert.equal(detail?.lines[0]?.billing, "unverified");
    assert.equal(detail?.totals.freeCalls, 0);
    assert.equal(detail?.totals.subscriptionCalls, 0);
    assert.equal(detail?.totals.unverifiedModelCalls, 2);
    assert.equal(detail?.totals.actualPendingCount, 1);
    assert.equal(detail?.lines[0]?.actualCostCny, undefined);
  });

  it("does not infer a historical receipt failure from the node's latest status", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-5",
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        executionReceipt: { providerId: "minimax", modelId: "video", billing: "metered", startedAt: "2026-08-27T13:00:00.000Z" },
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-5");
    assert.equal(detail?.lines[0]?.status, "unknown");
    assert.equal(detail?.totals.failedMeteredCalls, 0);
  });

  it("keeps a resumed operation pending when part of its actual cost is already known", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-partial-voice",
      nodeRuns: [{
        nodeId: "voice",
        status: "failed",
        outcomeUncertain: true,
        operationRequestId: "voice-operation-1",
        executionReceipt: {
          id: "voice-operation-1",
          nodeId: "voice",
          providerId: "minimax-tts-v1",
          modelId: "speech-2.8-hd",
          billing: "metered",
          status: "failed",
          requestId: "voice-operation-1",
          startedAt: "2026-08-27T14:00:00.000Z",
          actualCostCny: 0.1,
          actualCostSource: "configured_rate",
          meteredAttemptCount: 1,
        },
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-partial-voice");
    assert.equal(detail?.totals.actualCostCny, 0.1);
    assert.equal(detail?.totals.actualPendingCount, 1);
    assert.equal(detail?.lines[0]?.actualPending, true);
  });

  // T04/F06：同一 loop 的多份旧累计快照（2、4、4）不得相加成 10，也不能按 max 宣称精确；
  // 权威计数来自 checkpoint（4），旧快照折叠为一份未归属桶并如实标注。
  it("folds legacy cumulative snapshots instead of summing them, with the checkpoint count as authority", async () => {
    const snapshot = (modelCallCount: number, startedAt: string) => ({
      nodeId: "creative-planning", providerId: "deepseek", modelId: "deepseek-flash",
      billing: "subscription", status: "succeeded", startedAt,
      parameters: { modelCallCount },
    });
    const studio = new CostStudio(async () => ([{
      id: "run-legacy-snapshots",
      nodeRuns: [],
      executionReceipts: [snapshot(2, "2026-08-27T10:00:00.000Z"), snapshot(4, "2026-08-27T10:05:00.000Z"), snapshot(4, "2026-08-27T10:09:00.000Z")],
      spendAuthorizations: [],
    }]), async () => ([
      { nodeId: "creative-planning", providerId: "deepseek", modelId: "deepseek-flash", modelCallCount: 4 },
    ]));

    const detail = await studio.runDetail("run-legacy-snapshots");
    assert.equal(detail?.totals.subscriptionCalls, 0, "旧快照不逐份计费；checkpoint没有订阅账单");
    assert.equal(detail?.totals.unverifiedModelCalls, 4);
    assert.equal(detail?.totals.verifiedModelAttempts, 0, "仅有聚合数还没有物理请求证据");
    assert.equal(detail?.totals.legacyUnattributedReceipts, 3);
    assert.equal(detail?.totals.countExact, false);
    const folded = detail?.lines.filter((line) => line.legacyUnattributed === true);
    assert.equal(folded?.length, 1, "同一节点的旧快照折叠为一份未归属桶");
    assert.equal(folded?.[0]?.legacySnapshotCount, 3);
    assert.equal(folded?.[0]?.subscriptionCallCount, undefined);
    assert.equal(detail?.lines.find((line) => line.id === "checkpoint:creative-planning")?.modelCallCount, 4);
  });

  // AC-06b：同请求两个互斥实付保留先到账并显式冲突；合法推进（unknown→终态、待核→实付）不冲突。
  it("keeps the first observed cost and flags a conflict instead of overwriting, while legal progressions stay clean", async () => {
    const base = { nodeId: "assets", providerId: "wan", modelId: "wan3", billing: "metered", status: "succeeded", requestId: "op-conflict-1", startedAt: "2026-08-27T11:00:00.000Z" };
    const legalBase = { nodeId: "voice", providerId: "minimax-tts-v1", modelId: "speech-2.8", billing: "metered", status: "unknown", requestId: "op-recovered-1", startedAt: "2026-08-27T12:00:00.000Z", meteredAttemptCount: 1 };
    const studio = new CostStudio(async () => ([{
      id: "run-conflicts",
      nodeRuns: [],
      executionReceipts: [
        { ...base, actualCostCny: 2.0 },
        { ...base, actualCostCny: 9.9, startedAt: "2026-08-27T11:00:05.000Z" },
        legalBase,
      ],
      spendAuthorizations: [],
    }]), undefined, async () => ([
      { ...legalBase, status: "succeeded", actualCostCny: 0.5, actualCostSource: "provider_reported" },
    ]));

    const detail = await studio.runDetail("run-conflicts");
    const conflicted = detail?.lines.find((line) => line.requestId === "op-conflict-1");
    assert.equal(conflicted?.actualCostCny, 2.0, "先到账保留，不被后写覆盖");
    assert.equal(conflicted?.countConflict, true);
    assert.equal(detail?.totals.countConflicts, 1);
    assert.equal(detail?.totals.countExact, false);
    const recovered = detail?.lines.find((line) => line.requestId === "op-recovered-1");
    assert.equal(recovered?.status, "succeeded", "unknown→终态是合法推进");
    assert.equal(recovered?.actualCostCny, 0.5, "待核→实付是合法更正（现金账本权威）");
    assert.equal(recovered?.countConflict, undefined);
  });
});
