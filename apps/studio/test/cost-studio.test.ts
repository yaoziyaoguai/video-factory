import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPlanningMaintenanceIntegrity, readPlanningOperations } from "../src/server/planning-operations.js";
import { taskBinding } from "../../../packages/production-pipeline/src/codex-task-binding.js";
import { CostStudio } from "../src/server/cost-studio.js";
import { projectRequestExecution, projectCheckpointExecutions } from "../../../packages/production-pipeline/src/model-execution-facts.js";
import { ProductionPipeline as ProductionPipelineSource } from "../../../packages/production-pipeline/src/production-pipeline.js";
import { summarizeJointPlanningExecution as summarizeJointPlanningExecutionSource } from "../../../packages/production-pipeline/src/production-pipeline.js";

describe("planning maintenance integrity", () => {
  function stoppedCheckpoint(key: string, kind: "series" | "topic" = "topic") {
    const requestId = `planning-${key.slice(0, 8)}`;
    const brokerBinding = { version: "video-factory/task-binding-v1" as const, storeId: `vfs_store_${"c".repeat(32)}`, providerId: "test", modelId: "test" };
    const taskKind = kind === "series" ? "series-roadmap" as const : "topic-ideas" as const;
    const envelope = { protocolVersion: "video-factory/codex-bridge-v2", requestId, kind: taskKind, brokerBinding,
      payload: kind === "series" ? { series: { id: "series-original", name: "原系列", pillars: ["主题"] }, planningWindow: { startEpisodeNumber: 1, count: 2 } }
        : { signals: [{ title: "选题" }] } };
    const operation = { version: "video-factory/codex-prepared-operation-v1", requestId, kind: taskKind,
      envelope, serializedEnvelope: JSON.stringify(envelope), brokerBinding,
      binding: taskBinding({ request: envelope, broker: brokerBinding, kind: taskKind }), route: { socketPath: "/isolated/broker.sock" }, taskFact: "accepted_unknown" };
    return { version: "video-factory/agent-loop-checkpoint-v9", key,
      planningOwner: { kind, id: kind === "series" ? "series-original" : "topic-original", title: "原操作", action: "generate" },
      status: "failed", completed: [], attemptedRequestIds: [requestId], failure: { stage: "uncertain" },
      pendingOperation: { phase: "produce", iteration: 1, generation: 0, operationKey: "produce:1", operation },
      requestExecutions: { [requestId]: { state: "unknown" } } };
  }

  it("blocks malformed, unassigned, active and invalid-status checkpoints without changing their bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "planning-maintenance-invalid-"));
    try {
      for (const directoryName of ["topic-editor", "series-showrunner"] as const) {
        const directory = path.join(root, "checkpoints", directoryName);
        await mkdir(directory, { recursive: true });
        const kind = directoryName === "series-showrunner" ? "series" : "topic";
        const brokenKey = "a".repeat(64);
        const unassigned = stoppedCheckpoint("b".repeat(64), kind) as Record<string, unknown>;
        delete unassigned.planningOwner; delete unassigned.pendingOperation;
        const samples = [
          [brokenKey, "{broken"],
          ["b".repeat(64), JSON.stringify(unassigned)],
          ["d".repeat(64), JSON.stringify({ ...stoppedCheckpoint("d".repeat(64), kind), status: "running" })],
          ["e".repeat(64), JSON.stringify({ ...stoppedCheckpoint("e".repeat(64), kind), status: "idle" })],
        ] as const;
        for (const [key, bytes] of samples) await writeFile(path.join(directory, `${key}.json`), bytes);
        const result = await readPlanningMaintenanceIntegrity(root);
        assert.equal(result.complete, false);
        for (const [key, bytes] of samples) {
          assert.ok(result.issues.some((issue) => issue.runId === `planning:${directoryName}:${key}`));
          assert.equal(await readFile(path.join(directory, `${key}.json`), "utf8"), bytes);
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps stopped unknown identity intact, including verified legacy ownership without baseRevision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "planning-maintenance-stopped-"));
    try {
      for (const [name, key, kind] of [["topic-editor", "a".repeat(64), "topic"], ["series-showrunner", "b".repeat(64), "series"]] as const) {
        const directory = path.join(root, "checkpoints", name);
        await mkdir(directory, { recursive: true });
        const checkpoint = stoppedCheckpoint(key, kind) as Record<string, unknown>;
        if (kind === "series") delete checkpoint.planningOwner;
        const bytes = JSON.stringify(checkpoint);
        const file = path.join(directory, `${key}.json`);
        await writeFile(file, bytes);
        assert.equal((await readPlanningMaintenanceIntegrity(root)).complete, true);
        assert.equal(await readFile(file, "utf8"), bytes);
      }
      const operations = await readPlanningOperations(root);
      const legacy = operations.find((operation) => operation.owner.kind === "series");
      assert.ok(legacy?.evidenceIssue, "missing baseRevision is a read-only legacy limitation, not an active writer");
      assert.equal(legacy.baseRevision, undefined);
      const topicFile = path.join(root, "checkpoints", "topic-editor", `${"a".repeat(64)}.json`);
      const tampered = stoppedCheckpoint("a".repeat(64));
      tampered.pendingOperation.operation.binding.requestDigest = "f".repeat(64);
      await writeFile(topicFile, JSON.stringify(tampered));
      assert.equal((await readPlanningMaintenanceIntegrity(root)).complete, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks unverifiable pending identity and unreadable checkpoint directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "planning-maintenance-unreadable-"));
    try {
      assert.deepEqual(await readPlanningMaintenanceIntegrity(root), { complete: true, issues: [] });
      const directory = path.join(root, "checkpoints", "topic-editor");
      await mkdir(directory, { recursive: true });
      const key = "a".repeat(64);
      const checkpoint = stoppedCheckpoint(key);
      checkpoint.attemptedRequestIds = ["unrelated-request"];
      await writeFile(path.join(directory, `${key}.json`), JSON.stringify(checkpoint));
      assert.equal((await readPlanningMaintenanceIntegrity(root)).issues[0]?.problem, "planning_unknown_operation_unbound");
      await writeFile(path.join(root, "checkpoints", "series-showrunner"), "not a directory");
      const result = await readPlanningMaintenanceIntegrity(root);
      assert.equal(result.complete, false);
      assert.ok(result.issues.some((issue) => issue.problem === "planning_state_unreadable"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("CostStudio", () => {
  it("includes pre-production requests without inventing runs or paid amounts", async () => {
    const facts = projectCheckpointExecutions("series.planning", {
      key: "loop", attemptedRequestIds: ["produce"], requestPhases: { produce: { phase: "produce", iteration: 1 } },
      pendingCandidate: { iteration: 1, candidateTrace: { providerId: "deepseek", modelId: "test", modelAttemptCount: 2 } },
    }, "planning:loop");
    const operation = { id: "loop", owner: { kind: "series" as const, id: "series-1", title: "系列" }, action: "generate" as const, state: "failed", executionFacts: facts };
    const studio = new CostStudio(async () => [], undefined, undefined, undefined, undefined, async () => [operation]);
    const dashboard = await studio.dashboard();
    assert.equal(dashboard.runs.length, 0);
    assert.equal(dashboard.planningOperations?.[0]?.owner.id, "series-1");
    assert.equal(dashboard.totals.verifiedBrokerRequests, 1);
    assert.equal(dashboard.totals.verifiedModelAttempts, 2);
    assert.equal(dashboard.totals.actualPendingCount, 1);
    assert.equal(dashboard.totals.actualCostCny, 0);
    assert.equal((await studio.dashboard()).totals.verifiedModelAttempts, 2);
    assert.equal(dashboard.byProvider[0]?.calls, 2);
    assert.equal(dashboard.byNode[0]?.actualPendingCount, 1);
    assert.equal(dashboard.planningOperations?.[0]?.executionFacts[0]?.usageComplete, false);
  });
  it("keeps unassigned and unreadable planning evidence visible without guessing usage or business ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "planning-cost-"));
    const directory = path.join(root, "checkpoints", "topic-editor");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${"a".repeat(64)}.json`), JSON.stringify({
        key: "legacy", attemptedRequestIds: ["original"], requestPhases: { original: { phase: "produce", iteration: 1 } },
        pendingCandidate: { iteration: 1, candidateTrace: { providerId: "test", modelId: "test", modelAttemptCount: 2, totalTokens: 50, prompt: "must stay private" } },
      }));
      await writeFile(path.join(directory, `${"b".repeat(64)}.json`), "{broken");
      const studio = new CostStudio(async () => [], undefined, undefined, undefined, undefined, () => readPlanningOperations(root));
      const dashboard = await studio.dashboard();
      assert.equal(dashboard.planningOperations?.length, 2);
      assert.ok(dashboard.planningOperations?.every((operation) => operation.owner.kind === "unassigned" && operation.evidenceIssue));
      assert.equal(dashboard.totals.countExact, false);
      assert.equal(dashboard.totals.actualPendingCount, 1);
      assert.equal(dashboard.totals.actualCostCny, 0);
      const fact = dashboard.planningOperations?.find((operation) => operation.executionFacts.length)?.executionFacts[0];
      assert.equal(fact?.modelAttemptCount, 2);
      assert.equal(fact?.usageComplete, false);
      assert.equal(fact?.modelAttempts, undefined);
      assert.doesNotMatch(JSON.stringify(dashboard), /must stay private/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
      // postdogfood B1：requestId只等于facts的operationId时是「已归属操作但次数待核」，
      // 不能取得覆盖权，也不得让countExact变精确；快照无论link与否都保留为待核行。
      assert.equal(detail?.totals.countExact, false);
      assert.equal(detail?.totals.legacyUnattributedReceipts, linked ? 1 : 3,
        "link时三份同请求快照合并为一份待核；未link时是三份独立未归属回执");
      assert.equal(detail?.totals.newBrokerRequestsThisAttempt, null);
      assert.equal(detail?.totals.newModelAttemptsThisAttempt, null);
      const evidenceOnly = detail!.lines.filter((line) => line.accountingSource === "execution_fact");
      assert.equal(evidenceOnly.length, 4, "逐请求事实必须全部保持可见");
      assert.ok(evidenceOnly.every((line) => line.billing === "unverified" && line.actualPending && line.estimatedCostCny === null));
      const attributed = detail!.lines.find((line) => line.accountingSource !== "execution_fact");
      assert.equal(attributed?.callCountPending, linked ? true : undefined,
        "link时为次数待核行；未link时是旧累计未归属行");
      assert.equal(attributed?.legacyUnattributed, linked ? undefined : true);
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
  it("reports an incomplete run scan instead of presenting healthy-subset totals as complete", async () => {
    const run = { id: "run-healthy", status: "succeeded", startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:01:00Z",
      interventions: [], decisions: [], nodeRuns: [], executionReceipts: [], spendAuthorizations: [] };
    const scan = { runs: [run], complete: false, issues: [
      { runId: "run-corrupt", problem: "invalid_json", detail: "Unexpected end of JSON input" },
      { runId: "run-formal", problem: "missing_run_json" },
    ] };
    const studio = new CostStudio(async () => [run], undefined, undefined, undefined, undefined, undefined, async () => scan);
    const dashboard = await studio.dashboard();

    assert.equal(dashboard.runs.length, 1);
    assert.equal(dashboard.totals.countExact, false, "不完整扫描不得当作完整合计");
    assert.equal(dashboard.runScan?.complete, false);
    assert.deepEqual(dashboard.runScan?.issues.map((issue) => issue.runId), ["run-corrupt", "run-formal"]);
    // 系统读取错误保留为明确失败，不能以旧列表代替本次扫描。
    const inaccessible = Object.assign(new Error("EACCES: runs root unreadable"), { code: "EACCES" });
    const failedScan = new CostStudio(async () => { throw new Error("must not fall back to another scan"); },
      undefined, undefined, undefined, undefined, undefined, async () => { throw inaccessible; });
    await assert.rejects(() => failedScan.dashboard(), (error) => error === inaccessible);
  });
  it("keeps a complete scan absent from the dashboard payload", async () => {
    const run = { id: "run-ok", status: "succeeded", startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:01:00Z",
      interventions: [], decisions: [], nodeRuns: [], executionReceipts: [], spendAuthorizations: [] };
    let scans = 0;
    const studio = new CostStudio(async () => { throw new Error("must use the scanned run set"); },
      undefined, undefined, undefined, undefined, undefined,
      async () => { scans += 1; return { runs: [run], complete: true, issues: [] }; });
    const dashboard = await studio.dashboard();
    assert.equal(dashboard.runScan, undefined);
    assert.equal(dashboard.totals.countExact, true);
    assert.equal(scans, 1);
    assert.deepEqual(dashboard.runs.map((item) => item.runId), [run.id]);
  });
});


it("uses physical request facts to absorb an explicitly identified planning summary without inventing a bill", async () => {
  const run = { id: "summary-run", initialInput: { title: "新的制作" }, nodeRuns: [], executionReceipts: [
    { id: "summary", nodeId: "creative-planning", providerId: "creative-treatment-v1", modelId: "deepseek-flash",
      billing: "subscription", startedAt: "2026-10-17T12:00:00Z", requestId: "planning-operation",
      parameters: { accountingSource: "execution_summary", modelCallCount: 2 } },
  ] };
  const facts = ["request-1", "request-2"].map(requestId => projectRequestExecution({ nodeId: "creative-planning",
    requestId, purpose: "produce", state: "completed", operationId: "planning-operation", evidenceSource: "checkpoint",
    trace: { providerId: "deepseek", modelId: "deepseek-flash", modelAttemptCount: 1 } }));
  const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
    async () => ({ facts, issues: [], currentOperationIds: { "creative-planning": "planning-operation" } }));
  const result = await studio.runDetail(run.id);
  assert.equal(result?.lines.length, 2);
  assert.equal(result?.totals.legacyUnattributedReceipts, 0);
  assert.equal(result?.totals.verifiedModelAttempts, 2);
  assert.equal(result?.totals.actualPendingCount, 2, "真实金额仍待核，不能把汇总0元当作免费");
  facts.pop();
  const incomplete = await studio.runDetail(run.id);
  assert.equal(incomplete?.totals.legacyUnattributedReceipts, 1, "无法完整归属时保留汇总证据");
  assert.equal(run.executionReceipts.length, 1, "只读投影不能删除账本");
});

// postdogfood B1：summary消去需要「精确覆盖+无未知/冲突+读取完整+无独立金额」同时成立；
// 零调用没有正面证据、普通回执只有operationId、独立实付金额都不能让证据消失或计数变精确。
describe("CostStudio execution-summary coverage (postdogfood B1)", () => {
  const summaryReceipt = () => ({
    id: "summary", nodeId: "creative-planning", providerId: "creative-treatment-v1", modelId: "deepseek-flash",
    billing: "subscription", startedAt: "2026-10-17T12:00:00Z", requestId: "planning-operation",
    parameters: { accountingSource: "execution_summary", modelCallCount: 2 },
  });
  const fact = (requestId: string, overrides: Record<string, unknown> = {}) => projectRequestExecution({
    nodeId: "creative-planning", requestId, purpose: "produce", state: "completed",
    operationId: "planning-operation", evidenceSource: "checkpoint",
    trace: { providerId: "deepseek", modelId: "deepseek-flash", modelAttemptCount: 1 }, ...overrides,
  });
  const build = async (facts: ReturnType<typeof fact>[], issues: string[] = [], receipt: Record<string, unknown> = summaryReceipt()) => {
    const run = { id: "summary-coverage", initialInput: { title: "汇总覆盖" }, nodeRuns: [],
      executionReceipts: [structuredClone(receipt)] };
    const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
      async () => ({ facts: structuredClone(facts), issues: structuredClone(issues),
        currentOperationIds: { "creative-planning": "planning-operation" } }));
    return await studio.runDetail(run.id);
  };

  it("keeps the summary pending unless exact per-request facts fully cover it", async () => {
    const exact = await build([fact("request-1"), fact("request-2")]);
    assert.equal(exact?.lines.some((line) => line.id === "summary"), false, "精确覆盖时只移除汇总行");
    assert.equal(exact?.totals.verifiedModelAttempts, 2);
    assert.equal(exact?.totals.countExact, true);

    const missingOne = await build([fact("request-1")]);
    const retained = missingOne?.lines.find((line) => line.id === "summary");
    assert.ok(retained, "缺一份逐请求证据时保留汇总行待核");
    assert.equal(retained?.callCountPending, true);
    assert.equal(retained?.legacyUnattributed, undefined, "新失败汇总不得被标注成历史旧累计");
    assert.equal(missingOne?.totals.countExact, false);
    assert.equal(missingOne?.totals.legacyUnattributedReceipts, 1, "待核汇总仍计入待核份数");
    assert.equal(missingOne?.totals.verifiedModelAttempts, 1);

    const unknownCount = await build([fact("request-1"),
      fact("request-2", { trace: { providerId: "deepseek", modelId: "deepseek-flash" } })]);
    assert.ok(unknownCount?.lines.some((line) => line.id === "summary"), "尝试次数未知时保留汇总行");

    const conflicted = await build([fact("request-1"),
      fact("request-2", { trace: { providerId: "deepseek", modelId: "deepseek-flash", modelAttemptCount: 1, brokerRequestIdHash: "deadbeef" } })]);
    assert.ok(conflicted?.lines.some((line) => line.id === "summary"), "证据冲突时保留汇总行");
    assert.equal(conflicted?.totals.countExact, false);

    const withIssue = await build([fact("request-1"), fact("request-2")], ["checkpoint unreadable"]);
    assert.ok(withIssue?.lines.some((line) => line.id === "summary"), "投影读取不完整时保守保留汇总行");
    assert.equal(withIssue?.totals.countExact, false);

    const wrongOperation = await build([fact("request-1"), fact("request-2", { operationId: "other-operation" })]);
    assert.ok(wrongOperation?.lines.some((line) => line.id === "summary"), "事实必须归属同一操作才可能覆盖");
  });

  it("never drops a zero-count summary without positive coverage evidence", async () => {
    const zeroReceipt = { ...summaryReceipt(), parameters: { accountingSource: "execution_summary", modelCallCount: 0 } };
    const noFacts = await build([], [], zeroReceipt);
    const retained = noFacts?.lines.find((line) => line.id === "summary");
    assert.ok(retained, "0次汇总没有逐请求证据时必须保留待核");
    assert.equal(retained?.callCountPending, true);
    assert.equal(noFacts?.totals.countExact, false);
    assert.equal(noFacts?.totals.legacyUnattributedReceipts, 1);
  });

  it("does not count a zero-call operation with explicitly rejected requests as a pending model bill", async () => {
    const rejected = fact("rejected-before-model", { state: "not_accepted", trace: undefined });
    const receipt = { ...summaryReceipt(), parameters: { accountingSource: "execution_summary", modelCallCount: 0 } };
    const result = await build([rejected], [], receipt);
    assert.equal(result?.totals.verifiedModelAttempts, 0);
    assert.equal(result?.totals.actualPendingCount, 0, "确定未受理的零调用操作不是待核模型金额");
    assert.equal(result?.totals.legacyUnattributedReceipts, 0);
    assert.equal(result?.totals.countExact, true);
    assert.equal(result?.executionFacts?.[0]?.state, "not_accepted", "原拒收事实仍可追踪");
  });

  it("does not turn a fully recorded zero-call human stop into a pending model bill", async () => {
    const receipt = { ...summaryReceipt(), status: "needs_human", finishedAt: "2026-10-17T12:00:01Z",
      parameters: { accountingSource: "execution_summary", modelCallCount: 0, producerModelCallCount: 0,
        auditModelCallCount: 0, discussionModelCallCount: 0, structuredRepairModelCallCount: 0,
        unknownModelExecutionCount: 0 } };
    const result = await build([], [], receipt);
    assert.equal(result?.totals.actualPendingCount, 0, "完整零调用的人工作业不新增模型账单疑项");
    assert.equal(result?.totals.legacyUnattributedReceipts, 0);
    assert.equal(result?.totals.verifiedModelAttempts, 0);
    assert.equal(result?.totals.countExact, true);
    assert.equal(result?.lines.some(line => line.id === "summary"), false);
    assert.equal(receipt.parameters.modelCallCount, 0, "只读投影不修改原回执");
  });

  it("keeps incomplete, unknown, unassigned and conflicting zero-call evidence pending", async () => {
    const zero = { ...summaryReceipt(), status: "needs_human", finishedAt: "2026-10-17T12:00:01Z",
      parameters: { accountingSource: "execution_summary", modelCallCount: 0, producerModelCallCount: 0,
        auditModelCallCount: 0, discussionModelCallCount: 0, structuredRepairModelCallCount: 0,
        unknownModelExecutionCount: 0 } };
    const incomplete = { ...zero, parameters: { ...zero.parameters, unknownModelExecutionCount: undefined } };
    const rejected = fact("rejected", { state: "not_accepted", trace: undefined });
    const unknown = fact("uncertain", { state: "accepted_unknown",
      trace: { providerId: "deepseek", modelId: "deepseek-flash", modelAttemptCount: 0 } });
    const { operationId: _unassigned, ...unowned } = unknown;
    const scenarios = [
      { label: "缺分类不能猜零", receipt: incomplete, facts: [], issues: [] },
      { label: "未知次数非零", receipt: { ...zero, parameters: { ...zero.parameters, unknownModelExecutionCount: 1 } }, facts: [], issues: [] },
      { label: "原摘要待核", receipt: { ...zero, parameters: { ...zero.parameters, executionSummaryPending: true } }, facts: [], issues: [] },
      { label: "仍在执行", receipt: { ...zero, status: "running" }, facts: [], issues: [] },
      { label: "未结束", receipt: { ...zero, finishedAt: undefined }, facts: [], issues: [] },
      { label: "缺操作身份", receipt: { ...zero, requestId: "" }, facts: [], issues: [] },
      { label: "缺读档证据", receipt: zero, facts: [], issues: ["checkpoint unreadable"] },
      { label: "同操作真实未知", receipt: zero, facts: [unknown], issues: [] },
      { label: "未归属物理请求", receipt: zero, facts: [unowned], issues: [] },
      { label: "拒收事实冲突", receipt: zero, facts: [{ ...rejected, conflict: true as const }], issues: [] },
      { label: "回执冲突", receipt: { ...zero, countConflict: true }, facts: [], issues: [] },
      { label: "其它操作拒收不能结清本操作", receipt: { ...summaryReceipt(), parameters: { accountingSource: "execution_summary", modelCallCount: 0 } },
        facts: [{ ...rejected, operationId: "different-operation" }], issues: [] },
    ];
    for (const scenario of scenarios) {
      const result = await build(scenario.facts, scenario.issues, scenario.receipt);
      assert.equal(result?.lines.find(line => line.id === "summary")?.callCountPending, true, scenario.label);
      assert.equal(result?.totals.countExact, false, scenario.label);
      assert.ok((result?.totals.actualPendingCount ?? 0) > 0, scenario.label);
    }
    const run = { id: "no-reader", nodeRuns: [], executionReceipts: [zero] };
    const noProjection = await new CostStudio(async () => [run]).runDetail(run.id);
    assert.equal(noProjection?.totals.countExact, false, "没有事实读取器不推断计数完整");
    assert.ok(noProjection?.lines.some(line => line.id === "summary"), "没有读取器保留原汇总");
  });

  it("keeps independent money and unrelated unknown requests when a zero-call operation is settled", async () => {
    const zero = { ...summaryReceipt(), status: "needs_human", finishedAt: "2026-10-17T12:00:01Z",
      parameters: { accountingSource: "execution_summary", modelCallCount: 0, producerModelCallCount: 0,
        auditModelCallCount: 0, discussionModelCallCount: 0, structuredRepairModelCallCount: 0,
        unknownModelExecutionCount: 0 } };
    for (const actualCostSource of ["configured_rate", "provider_reported", "manual_reconciled"] as const) {
      for (const facts of [[], [fact("rejected", { state: "not_accepted", trace: undefined })]]) {
        const result = await build(facts, [], { ...zero, actualCostCny: 7, actualCostSource });
        assert.equal(result?.totals.actualCostCny, 7);
        assert.equal(result?.lines.find(line => line.id === "summary")?.actualCostSource, actualCostSource);
      }
    }
    const unrelated = fact("earlier-unknown", { operationId: "earlier-operation", state: "accepted_unknown",
      trace: { providerId: "deepseek", modelId: "deepseek-flash" } });
    const result = await build([unrelated], [], zero);
    assert.equal(result?.lines.some(line => line.id === "summary"), false, "当前完整零调用不增加历史请求疑项");
    assert.equal(result?.totals.actualPendingCount, 1, "旧操作真正未知请求仍待核");
    assert.equal(result?.totals.countExact, false);
    assert.equal(result?.executionFacts?.[0]?.state, "accepted_unknown");
  });

  it("projects mixed completed, rejected and manual operations consistently in detail and dashboard", async () => {
    const paidFacts = Array.from({ length: 9 }, (_, index) => fact(`physical-${index}`, { operationId: "generated" }));
    const rejectedFacts = Array.from({ length: 4 }, (_, index) => fact(`rejected-${index}`, {
      operationId: `rejected-operation-${index}`, state: "not_accepted", trace: undefined,
    }));
    const manual = { ...summaryReceipt(), id: "manual", requestId: "manual-operation", status: "needs_human",
      finishedAt: "2026-10-17T12:00:01Z", parameters: { accountingSource: "execution_summary", modelCallCount: 0,
        producerModelCallCount: 0, auditModelCallCount: 0, discussionModelCallCount: 0,
        structuredRepairModelCallCount: 0, unknownModelExecutionCount: 0 } };
    const run = { id: "mixed-operations", nodeRuns: [], executionReceipts: [
      { ...summaryReceipt(), id: "generated", requestId: "generated",
        parameters: { accountingSource: "execution_summary", modelCallCount: 9 } },
      ...rejectedFacts.map(item => ({ ...summaryReceipt(), id: item.operationId!, requestId: item.operationId!,
        parameters: { accountingSource: "execution_summary", modelCallCount: 0 } })), manual,
    ] };
    const facts = [...paidFacts, ...rejectedFacts];
    const before = JSON.stringify({ run, facts });
    const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
      async () => ({ facts, issues: [], currentOperationIds: { "creative-planning": "manual-operation" } }));
    for (const totals of [(await studio.runDetail(run.id))!.totals, (await studio.dashboard()).totals]) {
      assert.equal(totals.verifiedBrokerRequests, 9);
      assert.equal(totals.verifiedModelAttempts, 9);
      assert.equal(totals.actualPendingCount, 9, "只有九条已受理物理请求的金额待核，不再加四拒收和一次手编");
      assert.equal(totals.legacyUnattributedReceipts, 0);
      assert.equal(totals.countExact, true, "次数完整不代表现金已核");
      assert.equal(totals.actualCostCny, 0, "不编造实付金额；仍有九笔actualPending");
    }
    const detail = (await studio.runDetail(run.id))!;
    assert.equal(detail.executionFacts?.length, 13, "四拒收事实没有被改写或删除");
    assert.equal(detail.lines.length, 9);
    assert.equal(JSON.stringify({ run, facts }), before);
    assert.equal(JSON.stringify(detail).includes("zeroCallSummaryIds"), false, "内部零调用判据不扩充API");
  });

  it("keeps an independently settled amount on a summary even when counts are covered", async () => {
    const paid = { ...summaryReceipt(), actualCostCny: 7, actualCostSource: "provider_reported" };
    const result = await build([fact("request-1"), fact("request-2")], [], paid);
    const retained = result?.lines.find((line) => line.id === "summary");
    assert.ok(retained, "汇总带独立实付金额时不得因计数相等被消去");
    assert.equal(retained?.actualCostCny, 7);
    assert.equal(retained?.actualPending, false, "金额已核，不得伪装成金额待核");
    assert.equal(result?.totals.actualCostCny, 7, "独立实付不因投影消去");
  });

  it("does not let an operation-attributed receipt hide physical facts of the same operation", async () => {
    const plainReceipt = {
      id: "plain", nodeId: "creative-planning", providerId: "deepseek", modelId: "deepseek-flash",
      billing: "subscription", startedAt: "2026-10-17T12:00:00Z", requestId: "planning-operation",
      parameters: { modelCallCount: 0 },
    };
    const run = { id: "operation-receipt", initialInput: { title: "操作回执" }, nodeRuns: [],
      executionReceipts: [plainReceipt] };
    const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
      async () => ({ facts: [fact("request-1"), fact("request-2"), fact("request-3")], issues: [],
        currentOperationIds: { "creative-planning": "planning-operation" } }));
    const detail = await studio.runDetail(run.id);
    assert.equal(detail?.lines.filter((line) => line.accountingSource === "execution_fact").length, 3,
      "同操作的每个物理请求都要保持可见");
    const receiptLine = detail?.lines.find((line) => line.id === "plain");
    assert.ok(receiptLine, "回执本身也保留为一行");
    assert.equal(receiptLine?.callCountPending, true, "回执计数待核，不得宣称0次");
    assert.equal(receiptLine?.legacyUnattributed, undefined, "有操作归属，不是历史旧累计");
    assert.equal(detail?.totals.verifiedModelAttempts, 3);
    assert.equal(detail?.totals.subscriptionCalls, 0, "计数待核的回执不并入订阅精确总数");
    assert.equal(detail?.totals.countExact, false);
  });

  it("keeps cost line ids stable across inserts, reordering and repeated reads", async () => {
    const receipt = (startedAt: string, extra: Record<string, unknown> = {}) => ({
      nodeId: "script", providerId: "openai-codex", modelId: "codex", billing: "subscription",
      status: "succeeded", startedAt, parameters: { modelCallCount: 1 }, ...extra,
    });
    const run = { id: "stable-ids", initialInput: { title: "稳定行身份" }, nodeRuns: [],
      executionReceipts: [receipt("2026-10-17T10:00:00Z", { requestId: "request-a" }),
        receipt("2026-10-17T11:00:00Z", { requestId: "request-b" })] };
    const studio = new CostStudio(async () => [run]);
    const first = await studio.runDetail(run.id);
    const ids = first?.lines.map((line) => line.id) ?? [];
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, "两个不同物理请求必须是不同的行");
    // 插入更早回执 + 重排序 + 状态/金额补齐，已有行ID保持不变。
    run.executionReceipts = [receipt("2026-10-17T09:00:00Z", { requestId: "request-c" }),
      receipt("2026-10-17T11:00:00Z", { requestId: "request-b", status: "unknown", actualCostCny: 0.5 }),
      receipt("2026-10-17T10:00:00Z", { requestId: "request-a" })];
    const second = await studio.runDetail(run.id);
    const secondIds = new Set(second?.lines.map((line) => line.id) ?? []);
    assert.equal(second?.lines.length, 3);
    for (const id of ids) assert.ok(secondIds.has(id), `行 ${id} 应保持稳定`);
    assert.deepEqual((await studio.runDetail(run.id))?.lines.map((line) => line.id),
      second?.lines.map((line) => line.id), "反复读取行ID不变");
  });
});

// R2-04/R2-05：pending 汇总不得被默认计数伪装成精确覆盖；reader 读取不完整必须浮出为
// issue/pending；同一物理请求的回执与事实必须合并成同一口径。场景由 round2 cost-probe
// 迁移为期待正确行为的正式回归（探针断言缺陷存在，修后应失败）。
describe("execution summary pending and same-request fact merge (round2 R2-04/R2-05)", () => {
  const pendingReceipt = (parameters: Record<string, unknown> = {}) => ({
    id: "summary", nodeId: "creative-planning", providerId: "creative-treatment-v1", modelId: "deepseek-flash",
    billing: "subscription", startedAt: "2026-10-19T12:00:00Z", requestId: "planning-operation",
    parameters: { accountingSource: "execution_summary", ...parameters },
  });
  const fact = (requestId: string, overrides: Record<string, unknown> = {}) => projectRequestExecution({
    nodeId: "creative-planning", requestId, purpose: "produce", state: "completed",
    operationId: "planning-operation", evidenceSource: "checkpoint",
    trace: { providerId: "deepseek-flash", modelId: "deepseek-flash", modelAttemptCount: 1 }, ...overrides,
  });
  const project = async (receipt: Record<string, unknown>, facts: ReturnType<typeof fact>[], issues: string[] = []) => {
    const run = { id: "pending-summary", initialInput: { title: "待核汇总" }, nodeRuns: [],
      executionReceipts: [structuredClone(receipt)] };
    const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
      async () => ({ facts: structuredClone(facts), issues: structuredClone(issues),
        currentOperationIds: { "creative-planning": "planning-operation" } }));
    return (await studio.runDetail(run.id))!;
  };

  it("keeps an executionSummaryPending summary unknown instead of defaulting it to one call", async () => {
    const noFacts = await project(pendingReceipt({ executionSummaryPending: true }), []);
    const retained = noFacts.lines.find((line) => line.id === "summary");
    assert.ok(retained, "pending 汇总必须保留待核");
    assert.equal(retained?.subscriptionCallCount, undefined, "缺登记数不得默认成 1 次");
    assert.equal(retained?.callCountPending, true);
    assert.equal(retained?.executionSummaryPending, true);
    assert.equal(noFacts.totals.subscriptionCalls, 0, "缺数不并入订阅精确总数");
    assert.equal(noFacts.totals.countExact, false);

    const oneFact = await project(pendingReceipt({ executionSummaryPending: true }), [fact("request-1")]);
    assert.ok(oneFact.lines.some((line) => line.id === "summary"),
      "恰好的子集事实不能把 pending 汇总伪装成精确覆盖");
    assert.equal(oneFact.totals.verifiedModelAttempts, 1, "已核实子集仍可见");
    assert.equal(oneFact.totals.countExact, false);
    assert.equal(oneFact.totals.legacyUnattributedReceipts, 1);
  });

  it("distinguishes an explicitly registered zero from an unknown count", async () => {
    const zero = await project(pendingReceipt({ modelCallCount: 0 }), []);
    const zeroLine = zero.lines.find((line) => line.id === "summary");
    assert.ok(zeroLine);
    assert.equal(zeroLine?.subscriptionCallCount, 0, "明确登记 0 保持数字 0");
    const missing = await project(pendingReceipt(), []);
    const missingLine = missing.lines.find((line) => line.id === "summary");
    assert.ok(missingLine);
    assert.equal(missingLine?.subscriptionCallCount, undefined, "缺数保持未知，不得默认成 1 或 0");
    assert.equal(missingLine?.callCountPending, true);
  });

  it("keeps a settled amount dimension on a pending count summary", async () => {
    const paid = { ...pendingReceipt({ executionSummaryPending: true }), actualCostCny: 7, actualCostSource: "provider_reported" };
    const result = await project(paid, [fact("request-1")]);
    const line = result.lines.find((line) => line.id === "summary");
    assert.ok(line, "计数待核不因一份事实消去汇总行");
    assert.equal(line?.actualCostCny, 7);
    assert.equal(line?.actualPending, false);
    assert.equal(result.totals.actualCostCny, 7);
  });

  it("keeps pending subscription counts out of totals when no projection is available", async () => {
    const run = { id: "no-projection", initialInput: { title: "无投影" }, nodeRuns: [],
      executionReceipts: [pendingReceipt({ executionSummaryPending: true })] };
    const studio = new CostStudio(async () => [run]);
    const detail = (await studio.runDetail(run.id))!;
    const line = detail.lines.find((line) => line.id === "summary");
    assert.equal(line?.subscriptionCallCount, undefined);
    assert.equal(line?.callCountPending, true);
    assert.equal(detail.totals.subscriptionCalls, 0, "无投影路径同样不得用默认 1 造数");
  });

  it("merges the same physical request into one visible count instead of hiding the fact", async () => {
    for (const modelCallCount of [0, 1]) {
      const receipt = { id: "same-request", nodeId: "creative-planning", providerId: "deepseek-flash",
        modelId: "deepseek-flash", billing: "subscription", startedAt: "2026-10-19T12:00:00Z",
        requestId: "request-1", parameters: { modelCallCount } };
      const merged = await project(receipt, [fact("request-1")]);
      assert.equal(merged.lines.length, 1, "正常0→1进展和1/1同事实都合并为一行");
      assert.equal(merged.lines[0]?.subscriptionCallCount, 1, "不得显示占位0或把1+1相加");
      assert.equal(merged.lines[0]?.callCountPending, undefined);
      assert.equal(merged.totals.verifiedModelAttempts, 1);
      assert.equal(merged.totals.subscriptionCalls, 1);
      assert.equal(merged.totals.countExact, true, "明细与总计同口径才可精确");
    }
  });

  it("keeps same-request pending counts incomplete in run and dashboard totals without changing recorded money", async () => {
    for (const actualCostSource of ["configured_rate", "provider_reported", "manual_reconciled"] as const) {
      const receipt = { id: "registered-two", nodeId: "publish-package", providerId: "deepseek-flash",
        modelId: "deepseek-flash", billing: "unverified", status: "succeeded", startedAt: "2026-10-19T12:00:00Z",
        requestId: "request-1", actualCostCny: 7, actualCostSource,
        parameters: { accountingSource: "document_operation", modelCallCount: 2, modelCallCountKnown: true } };
      const run = { id: "pending-physical-count", nodeRuns: [], executionReceipts: [receipt] };
      const studio = new CostStudio(async () => [run], undefined, undefined, undefined,
        async () => ({ facts: [fact("request-1", { nodeId: "publish-package" })], issues: [],
          currentOperationIds: { "publish-package": "later-operation" } }));
      const detail = (await studio.runDetail(run.id))!;
      assert.equal(detail.lines.length, 1, "同一物理请求仍合并为一行");
      assert.equal(detail.lines[0]?.modelCallCount, 2, "保留原登记数，不用子集覆盖");
      assert.equal(detail.lines[0]?.callCountPending, true);
      assert.equal(detail.lines[0]?.actualCostSource, actualCostSource, "次数待核不改变金额权威来源");
      assert.equal(detail.lines[0]?.actualCostCny, 7);
      assert.equal(detail.lines[0]?.actualPending, false, "次数与金额待核彼此独立");
      const dashboard = await studio.dashboard();
      for (const totals of [detail.totals, dashboard.runs[0]!.totals, dashboard.totals]) {
        assert.equal(totals.verifiedModelAttempts, 1, "已核实子集仍可见");
        assert.equal(totals.verifiedBrokerRequests, 1);
        assert.equal(totals.countExact, false, "行级次数待核必须贯通所有总计");
        assert.equal(totals.newModelAttemptsThisAttempt, null, "未知不能因旧操作被推为本次新增0");
        assert.equal(totals.newBrokerRequestsThisAttempt, null);
        assert.equal(totals.actualCostCny, 7, "不改变或重复累计已登记金额");
      }
    }
  });

  it("does not label a subscription receipt precise when the physical request was not accepted", async () => {
    const receipt = { id: "registered-one", nodeId: "creative-planning", providerId: "deepseek-flash",
      modelId: "deepseek-flash", billing: "subscription", startedAt: "2026-10-19T12:00:00Z",
      requestId: "request-1", parameters: { modelCallCount: 1 } };
    const result = await project(receipt, [fact("request-1", { state: "not_accepted" })]);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0]?.subscriptionCallCount, 1, "只保留登记，不擅自改写为0次");
    assert.equal(result.lines[0]?.callCountPending, true);
    assert.equal(result.totals.subscriptionCalls, 0, "待核登记不能冒充已确认订阅调用");
    assert.equal(result.totals.verifiedModelAttempts, 0, "未受理的请求没有已核实模型尝试");
    assert.equal(result.totals.verifiedBrokerRequests, 0);
    assert.equal(result.totals.countExact, false);
    assert.equal(result.totals.newModelAttemptsThisAttempt, null);
    assert.equal(result.totals.newBrokerRequestsThisAttempt, null);
  });

  it("keeps the count pending when merged facts are unknown or conflicting", async () => {
    const receipt = { id: "zero-registered", nodeId: "creative-planning", providerId: "deepseek-flash",
      modelId: "deepseek-flash", billing: "subscription", startedAt: "2026-10-19T12:00:00Z",
      requestId: "request-1", parameters: { modelCallCount: 0 } };
    const unknown = await project(receipt,
      [fact("request-1", { trace: { providerId: "deepseek-flash", modelId: "deepseek-flash" } })]);
    assert.equal(unknown.lines[0]?.callCountPending, true, "次数未知的 fact 不能把计数定死");
    assert.equal(unknown.totals.countExact, false);

    const conflict = await project(receipt,
      [fact("request-1", { trace: { providerId: "deepseek-flash", modelId: "deepseek-flash", modelAttemptCount: 1, brokerRequestIdHash: "deadbeef" } })]);
    assert.equal(conflict.lines[0]?.callCountPending, true, "冲突证据不消除待核");
    assert.equal(conflict.totals.countExact, false);
  });

  it("surfaces unreadable reader records as issues instead of pretending completeness", async () => {
    // 真实 reader + 真实文件：损坏记录必须上报（issue/pending），合法子集数字仍返回。
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vf-r2-cost-readers-"));
    try {
      const checkpointDir = path.join(fixtureRoot, "runs", "reader-run", "nodes", "creative-planning", "agent-loop-checkpoints");
      const discussionDir = path.join(fixtureRoot, "runs", "reader-run", "nodes", "creative-planning", "discussion-executions");
      await mkdir(checkpointDir, { recursive: true });
      await mkdir(discussionDir, { recursive: true });
      await writeFile(path.join(checkpointDir, "broken.json"), "{not-json");
      const checkpointIssues: string[] = [];
      const checkpointOnly = await summarizeJointPlanningExecutionSource(path.join(fixtureRoot, "runs"), "reader-run", "op",
        (issue) => checkpointIssues.push(issue));
      assert.equal(checkpointOnly, undefined, "无合法记录时不编造数字");
      assert.ok(checkpointIssues.some((issue) => issue.includes("checkpoint:broken.json:unreadable")),
        JSON.stringify(checkpointIssues));

      await writeFile(path.join(discussionDir, "good.json"), JSON.stringify({
        version: "video-factory/creative-discussion-execution-v1", workflowOperationRequestId: "op",
        commandId: "command-1", requestId: "physical-1", stage: "treatment", state: "completed",
        trace: { providerId: "deepseek", modelId: "deepseek", modelAttemptCount: 1 },
      }));
      await writeFile(path.join(discussionDir, "broken.json"), "{not-json");
      const mixedIssues: string[] = [];
      const mixed = await summarizeJointPlanningExecutionSource(path.join(fixtureRoot, "runs"), "reader-run", "op",
        (issue) => mixedIssues.push(issue));
      assert.equal(mixed?.modelCallCount, 1, "合法记录的数字照常返回");
      assert.ok(mixedIssues.some((issue) => issue.includes("discussion:broken.json:unreadable")),
        JSON.stringify(mixedIssues));

      const pipeline = new ProductionPipelineSource({ workspaceRoot: fixtureRoot,
        worker: { run: async () => { throw new Error("cost projection must not execute worker"); } } as never });
      const runFile = path.join(fixtureRoot, "runs", "reader-run", "run.json");
      const projectionRun = { id: "reader-run", status: "failed", startedAt: "2026-10-19T00:00:00Z",
        revision: 1, initialInput: { title: "读取不完整" }, nodeRuns: [], executionReceipts: [pendingReceipt({ executionSummaryPending: true })] };
      await writeFile(runFile, JSON.stringify(projectionRun));
      const projection = await pipeline.readModelExecutionFacts("reader-run");
      assert.ok(projection.issues.some((issue) => issue.startsWith("creative-planning:discussion:")),
        JSON.stringify(projection.issues));
      assert.equal(projection.facts.length, 1, "合法 fact 保留");
      const studio = new CostStudio(async () => [projectionRun], undefined, undefined, undefined,
        async () => projection);
      const detail = (await studio.runDetail("reader-run"))!;
      assert.equal(detail.totals.countExact, false, "读取不完整不得声称精确");
      assert.ok(detail.lines.some((line) => line.id === "summary"), "pending 汇总保留");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("presents one consistent count when a document finishes between the two reads", async () => {
    // document 回执在两次独立读取之间完成（确定性允许交错）：同响应内明细与总计必须同口径。
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vf-r2-doc-race-"));
    try {
      const docDir = path.join(fixtureRoot, "runs", "doc-race", "nodes", "publish-package", "document-commands");
      await mkdir(docDir, { recursive: true });
      const run = { id: "doc-race", status: "succeeded", startedAt: "2026-10-19T00:00:00Z", revision: 1,
        initialInput: { title: "文档竞态" },
        nodeRuns: [{ nodeId: "publish-package", status: "succeeded" }], executionReceipts: [] };
      await writeFile(path.join(fixtureRoot, "runs", "doc-race", "run.json"), JSON.stringify(run));
      const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const identity = { action: "audit", actor: "test", input: { expectedRunRevision: 1, expectedVersionId: "v1" } };
      const documentCommand = { version: "video-factory/document-command-v1", commandId: "document-1",
        requestDigest: digest(identity), ...identity, state: "pending",
        createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
        prepared: { requestId: "doc-physical-1", brokerBinding: { providerId: "deepseek", modelId: "deepseek" } } };
      const docPath = path.join(docDir, `${digest(documentCommand.commandId)}.json`);
      await writeFile(docPath, JSON.stringify(documentCommand));
      const pipeline = new ProductionPipelineSource({ workspaceRoot: fixtureRoot,
        worker: { run: async () => { throw new Error("cost projection must not execute worker"); } } as never });
      const studio = new CostStudio(async () => [run], undefined, undefined,
        async (id) => {
          const before = await pipeline.readDocumentExecutionReceipts(id);
          await writeFile(docPath, JSON.stringify({ ...documentCommand, state: "completed",
            execution: { trace: { providerId: "deepseek", modelId: "deepseek", modelAttemptCount: 1 } },
            completedAt: "2026-10-19T00:00:01Z" }));
          return before;
        },
        async (id) => pipeline.readModelExecutionFacts(id));
      const detail = (await studio.runDetail("doc-race"))!;
      assert.equal(detail.lines.length, 1);
      assert.equal(detail.lines[0]?.modelCallCount, 1, "完成的物理请求次数必须并入明细");
      assert.equal(detail.lines[0]?.callCountPending, undefined);
      assert.equal(detail.lines[0]?.status, "succeeded");
      assert.equal(detail.totals.verifiedModelAttempts, 1);
      assert.equal(detail.totals.countExact, true, "明细与总计同口径");
      assert.equal(detail.totals.actualPendingCount, 1, "金额维度独立保持待核");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
