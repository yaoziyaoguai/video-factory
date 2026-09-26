// 只复核已归档的受控 QA 事实，不启动服务、不请求模型、不修改 run。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const receipts = read("W5-fixed-transport-after.json").events;

function verifyRecoveredAudit(prefix, afterFile, commandId, requestId) {
  const before = read(`${prefix}-before.json`);
  const after = read(afterFile);
  const providerBefore = read(`${prefix}-provider-before.json`);
  const providerAfter = read(`${prefix}-provider-after.json`);
  assert.equal(after.status, "needs_human");
  assert.equal(after.activeStage, "treatment");
  assert.deepEqual(after.treatment.currentDraft, before.treatment.currentDraft);
  assert.deepEqual(after.treatment.currentDocument, before.treatment.currentDocument);
  assert.equal(after.treatment.auditHistory.length, before.treatment.auditHistory.length + 1);
  assert.deepEqual(after.treatment.auditHistory.slice(0, -1), before.treatment.auditHistory);
  assert.deepEqual(after.otherNodeStatuses, before.otherNodeStatuses);
  assert.equal(after.decisionCount, before.decisionCount);
  assert.equal(providerAfter.stats["role-audit"], providerBefore.stats["role-audit"] + 1);
  for (const kind of ["creative-treatment", "script-draft", "director-plan", "publish-copy"]) {
    assert.equal(providerAfter.stats[kind], providerBefore.stats[kind]);
  }
  assert.equal(after.operations.find((operation) => operation.commandId === commandId)?.status, "completed");
  assert.deepEqual(after.operations.filter((operation) => operation.commandId !== commandId), before.operations);
  assert.equal(receipts.filter((event) => event.method === "POST" && event.requestId === requestId).length, 1);
}

verifyRecoveredAudit("W3", "W3-after-restart.json", "fd363fff-a3a7-459d-a1c2-283fa8024865",
  "agent-d8fa6b6c86946f9b3063238b120984d01f4d2bd5dbb07906b10eb3e8e75c2095");
const offline = read("W3-offline.json");
assert.equal(offline.status, "running");
assert.equal(offline.operations.at(-1).status, "running");
assert.deepEqual(read("W3-provider-offline-completed.json").stats, read("W3-provider-after.json").stats);
console.log("PASS W3: 停机期间完成，原请求仅一次，重启消费一次并保留人工停点。");

verifyRecoveredAudit("W5-fixed", "W5-fixed-after.json", "257a059a-1ae7-4ca9-b25c-33c6f2bf85df",
  "agent-8f341a2a68efaca4273210006089423297f1627074bd8a07e8f8dcaf3ec87b28");
const recovery = read("W5-fixed-unknown-detail.json").taskRecovery;
assert.equal(recovery.taskState, "accepted_unknown");
assert.deepEqual(recovery.allowedActions, ["query_original_task"]);
assert.ok(receipts.some((event) => event.method === "POST" && event.status === 202 && event.dropped
  && event.requestId === "agent-8f341a2a68efaca4273210006089423297f1627074bd8a07e8f8dcaf3ec87b28"));
const { at: beforeRestartAt, ...beforeRestart } = read("W5-fixed-after.json");
const { at: afterRestartAt, ...afterRestart } = read("W5-fixed-after-restart.json");
assert.deepEqual(afterRestart, beforeRestart);
console.log("PASS W5: 受理回包丢失可观察原任务，未重提；取回后回执完成，重启快照一致。");

const qa3 = read("QA3-run-after.json");
const review = read("QA3-review.json");
const source = read("QA3-source-script.json");
const preparation = read("QA3-preparation.json");
assert.equal(qa3.id, preparation.runId);
assert.equal(qa3.status, "needs_human");
assert.equal(review.stage, "script");
assert.deepEqual(qa3.initialInput.rework.affectedScenePositions, []);
assert.equal(source.scenes.length, 7);
assert.deepEqual(review.draft, source);
assert.equal(review.proposals.length, 1);
assert.equal(review.proposals[0].document.scenes.length, 5);
assert.deepEqual(review.scopeConflict.requiredScenePositions, [1, 2, 3, 4, 5, 6, 7]);
assert.equal(review.scopeConflict.sourceRunId, preparation.sourceRunId);
assert.equal(qa3.creativeReviewOperations.at(-1).status, "completed");
assert.equal(qa3.nodeRuns.some((node) => ["assets", "voice", "render"].includes(node.nodeId) && node.status !== "pending"), false);
assert.equal(qa3.artifacts.some((artifact) => /^(audio|video)\//.test(artifact.contentType ?? "")), false);
assert.equal(preparation.sourceMediaRequests, 0);
assert.equal(preparation.sourceMediaArtifacts, 0);
console.log("PASS QA③: 空范围下保留七镜旧稿，五镜候选仅为提案，媒体尚未启动。");
