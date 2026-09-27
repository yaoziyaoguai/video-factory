import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { projectCheckpointExecutions, mergeModelExecutionFacts, summarizeModelExecutionFacts, projectRequestExecution } from "../src/model-execution-facts.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const trace = (requestId: string, attempts = 1) => ({ providerId: "provider", modelId: "model", requestIdHash: hash(requestId), modelAttemptCount: attempts, providerWaitMs: 100, queueWaitMs: 20, structuredRepairCount: 1 });
function checkpoint() {
  return { key: "loop", cycle: 0, recoveryOwner: { workflowOperationRequestId: "original" },
    attemptedRequestIds: ["produce", "audit-1", "audit-2", "audit-3"],
    requestOwners: { produce: "original", "audit-1": "original", "audit-2": "original", "audit-3": "original" },
    requestPhases: { produce: { phase: "produce", iteration: 1 }, "audit-1": { phase: "audit", iteration: 1 }, "audit-2": { phase: "audit", iteration: 2 }, "audit-3": { phase: "audit", iteration: 3 } },
    completed: [ { iteration: 1, candidateTrace: trace("produce"), auditTrace: trace("audit-1") },
      { iteration: 2, auditTrace: trace("audit-2") }, { iteration: 3, auditTrace: trace("audit-3") } ] };
}

describe("read-only model execution facts", () => {
  it("deduplicates changing snapshots and keeps internal repairs inside authoritative attempts", () => {
    const first = projectCheckpointExecutions("creative-planning", checkpoint(), "first.json");
    const later = checkpoint();
    later.completed[0]!.candidateTrace = trace("produce", 3);
    const facts = mergeModelExecutionFacts([...first, ...projectCheckpointExecutions("creative-planning", later, "later.json"), ...first]);
    const summary = summarizeModelExecutionFacts(facts, [], { "creative-planning": "recovery" });
    assert.equal(facts.length, 4);
    assert.equal(summary.verifiedBrokerRequests, 4);
    assert.equal(summary.verifiedModelAttempts, 6, "内部结构修复已含在trace尝试数，不再另加");
    assert.equal(summary.newBrokerRequestsThisAttempt, 0);
    assert.equal(summary.newModelAttemptsThisAttempt, 0);
    assert.equal(summary.cumulativeProviderMs, 400);
    assert.equal(summary.requestWallUnionMs, null, "没有起止时间不能拿累计耗时代替墙钟");
    assert.equal(summary.countExact, true);
  });

  it("keeps independent cycles, audio and document requests instead of a node maximum", () => {
    const facts = projectCheckpointExecutions("creative-planning", checkpoint(), "loop.json");
    for (const purpose of ["audit", "audio", "document"]) facts.push(projectRequestExecution({
      nodeId: "creative-planning", requestId: purpose, purpose, operationId: "second",
      state: "completed", trace: trace(purpose, 2), evidenceSource: purpose,
    }));
    assert.equal(summarizeModelExecutionFacts(mergeModelExecutionFacts(facts)).verifiedBrokerRequests, 7);
    assert.equal(summarizeModelExecutionFacts(facts).verifiedModelAttempts, 10);
  });

  it("does not turn submission, ambiguous trace mapping or missing attempts into model execution", () => {
    const pending = { ...checkpoint(), completed: [], pendingOperation: {
      phase: "audit", operation: { requestId: "audit-3", taskFact: "not_submitted", brokerBinding: { providerId: "provider", modelId: "model" } },
    }, failure: { stage: "not_accepted", details: { requestIdHash: hash("audit-3"), providerId: "provider", modelId: "model", accepted: false } } };
    const summary = summarizeModelExecutionFacts(projectCheckpointExecutions("planning", pending, "pending.json"));
    assert.equal(summary.verifiedBrokerRequests, 0);
    assert.equal(summary.verifiedModelAttempts, 0);
    assert.equal(summary.countExact, false);
    const old = checkpoint();
    delete (old.completed[0]!.candidateTrace as Partial<ReturnType<typeof trace>>).modelAttemptCount;
    const partial = summarizeModelExecutionFacts(projectCheckpointExecutions("planning", old, "old.json"));
    assert.equal(partial.verifiedBrokerRequests, 4);
    assert.equal(partial.verifiedModelAttempts, 3);
    assert.equal(partial.countExact, false);
    assert.equal(partial.newModelAttemptsThisAttempt, null);
  });

  it("does not count a newly observed old result as newly executed and distinguishes parallel wall time", () => {
    const facts = ["one", "two"].map((requestId, index) => projectRequestExecution({
      nodeId: "visual-review", requestId, purpose: "audit", state: "completed", trace: trace(requestId),
      evidenceSource: requestId, operationId: "old", startedAt: `2026-09-27T00:00:0${index}.000Z`,
      finishedAt: `2026-09-27T00:00:0${index + 2}.000Z`,
    }));
    const result = summarizeModelExecutionFacts(facts, [], { "visual-review": "resume" });
    assert.equal(result.cumulativeRequestMs, 4000);
    assert.equal(result.requestWallUnionMs, 3000);
    assert.equal(result.newModelAttemptsThisAttempt, 0);
    const unknownCurrent = summarizeModelExecutionFacts(facts, [], { "visual-review": "old" });
    assert.equal(unknownCurrent.newBrokerRequestsThisAttempt, null, "同operation可能跨恢复；无执行批次证据不猜新增");
  });
});
