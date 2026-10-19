import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ProductionPipeline, summarizeJointPlanningExecution } from "../src/production-pipeline.js";
import { summarizeModelExecutionFacts } from "../src/model-execution-facts.js";

async function fixture(t: TestContext, checkpoint: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vf-accounting-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "accounting-reader";
  const nodeRoot = path.join(root, "runs", runId, "nodes", "creative-planning");
  const checkpointRoot = path.join(nodeRoot, "agent-loop-checkpoints");
  await mkdir(checkpointRoot, { recursive: true });
  await mkdir(path.join(nodeRoot, "discussion-executions"), { recursive: true });
  const checkpointPath = path.join(checkpointRoot, "saved.json");
  await writeFile(checkpointPath, JSON.stringify({
    version: "video-factory/agent-loop-checkpoint-v9", key: "saved", storageKey: "saved",
    recoveryOwner: { runId, nodeId: "creative-planning", workflowOperationRequestId: "operation-1" },
    ...checkpoint,
  }));
  await writeFile(path.join(nodeRoot, "discussion-executions", "healthy.json"), JSON.stringify({
    version: "video-factory/creative-discussion-execution-v1", workflowOperationRequestId: "operation-1",
    commandId: "command-one", requestId: "physical-good", stage: "treatment", state: "completed",
    trace: { providerId: "deepseek", modelId: "deepseek", modelAttemptCount: 1 },
  }));
  await writeFile(path.join(root, "runs", runId, "run.json"), JSON.stringify({
    id: runId, revision: 1, status: "failed", startedAt: "2026-10-19T00:00:00Z",
    initialInput: { title: "记账受控验证" },
    nodeRuns: [{ nodeId: "creative-planning", status: "failed", operationRequestId: "operation-1" }],
  }));
  const pipeline = new ProductionPipeline({ workspaceRoot: root, worker: {
    async run() { throw new Error("Accounting reads must not start a worker."); },
  } as never });
  return { root, runId, pipeline, checkpointPath };
}

test("accounting reader flags malformed counters without losing healthy evidence or changing the file", async (t) => {
  const { root, runId, pipeline, checkpointPath } = await fixture(t, {
    attemptedRequestIds: "not-an-array", phaseAttempts: { produce: "not-a-number", audit: 0 },
  });
  const before = await readFile(checkpointPath, "utf8");
  const issues: string[] = [];
  const summary = await summarizeJointPlanningExecution(path.join(root, "runs"), runId, "operation-1", issue => issues.push(issue));
  const projection = await pipeline.readModelExecutionFacts(runId);
  const totals = summarizeModelExecutionFacts(projection.facts, projection.issues, projection.currentOperationIds);
  assert.ok(issues.some(issue => issue.includes("accounting_structure_invalid")));
  assert.ok(projection.issues.some(issue => issue.includes("accounting_structure_invalid")));
  assert.equal(summary?.modelCallCount, 1);
  assert.equal(totals.verifiedModelAttempts, 1);
  assert.equal(totals.countExact, false);
  assert.equal(totals.newModelAttemptsThisAttempt, null);
  assert.equal(await readFile(checkpointPath, "utf8"), before);
});

test("accounting reader reports invalid request attribution and trace shapes, including a primary batch", async (t) => {
  const malformed = [
    { requestOwners: { request: 12 } },
    { requestPhases: { request: { phase: "produce", iteration: "1" } } },
    { completed: [{ iteration: 1, candidateTrace: { modelAttemptCount: "2" } }] },
    { requestExecutions: { request: { state: "completed", trace: { modelAttemptCount: "2" } } } },
    { phaseDurationsMs: { produce: "100" } },
    { operationGenerations: { "0:1:produce": "1" } },
    { pendingOperation: { operation: { requestId: 123 } } },
    { assetRankBatch: { version: "asset-rank-batches-v1", phase: "supplement", primaryCheckpoint: { attemptedRequestIds: "broken" } } },
  ];
  for (const [index, checkpoint] of malformed.entries()) {
    await t.test(`malformed accounting input ${index + 1}`, async (t) => {
      const { pipeline, runId } = await fixture(t, checkpoint);
      const projection = await pipeline.readModelExecutionFacts(runId);
      const totals = summarizeModelExecutionFacts(projection.facts, projection.issues);
      assert.ok(projection.issues.some(issue => issue.includes("accounting_structure_invalid")));
      assert.equal(totals.verifiedModelAttempts, 1);
      assert.equal(totals.countExact, false);
    });
  }
});

test("accounting reader accepts legacy missing fields and keeps genuine unknown requests pending", async (t) => {
  for (const version of ["video-factory/agent-loop-checkpoint-v8", "video-factory/agent-loop-checkpoint-v9"]) {
    await t.test(version, async (t) => {
      const { root, runId, pipeline } = await fixture(t, {
        version, phaseAttempts: { produce: 2, audit: 0 },
        attemptedRequestIds: ["original-unknown"],
        requestOwners: { "original-unknown": "operation-1" },
        requestPhases: { "original-unknown": { phase: "produce", iteration: 1 } },
        requestExecutions: { "original-unknown": { state: "unknown", trace: null } },
      });
      const issues: string[] = [];
      const summary = await summarizeJointPlanningExecution(path.join(root, "runs"), runId, "operation-1", issue => issues.push(issue));
      const projection = await pipeline.readModelExecutionFacts(runId);
      const totals = summarizeModelExecutionFacts(projection.facts, projection.issues);
      assert.deepEqual(issues, []);
      assert.deepEqual(projection.issues, []);
      assert.equal(summary?.modelCallCount, 2);
      assert.equal(projection.facts.find(fact => fact.requestId === "original-unknown")?.state, "unknown");
      assert.equal(totals.countExact, false);
    });
  }
  await t.test("empty legacy accounting shell is not an execution-contract error", async (t) => {
    const { pipeline, runId } = await fixture(t, {});
    const projection = await pipeline.readModelExecutionFacts(runId);
    assert.deepEqual(projection.issues, []);
    assert.equal(summarizeModelExecutionFacts(projection.facts, projection.issues).countExact, true);
  });
});

test("accounting reader keeps bad JSON and foreign-owner files intact and marks the healthy subset incomplete", async (t) => {
  for (const corruption of ["json", "owner"] as const) {
    await t.test(corruption, async (t) => {
      const { runId, pipeline, checkpointPath } = await fixture(t, {});
      const bytes = corruption === "json" ? "{broken" : JSON.stringify({
        version: "video-factory/agent-loop-checkpoint-v9",
        recoveryOwner: { runId: "another-run", nodeId: "creative-planning" },
      });
      await writeFile(checkpointPath, bytes);
      const projection = await pipeline.readModelExecutionFacts(runId);
      const totals = summarizeModelExecutionFacts(projection.facts, projection.issues);
      assert.ok(projection.issues.some(issue => issue.includes(corruption === "json" ? "unreadable" : "owner_unverifiable")));
      assert.equal(totals.verifiedModelAttempts, 1);
      assert.equal(totals.countExact, false);
      assert.equal(await readFile(checkpointPath, "utf8"), bytes);
    });
  }
});
