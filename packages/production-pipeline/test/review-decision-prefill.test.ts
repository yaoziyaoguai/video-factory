import assert from "node:assert/strict";
import { it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { reviewDecisionBasis, reviewDecisionPrefill } from "../src/review-decision-prefill.js";

function fixture(): WorkflowRun<unknown> {
  return {
    id: "run-test", revision: 4, status: "needs_human", initialInput: {},
    artifacts: ["voice", "render", "visual-review"].map((id) => ({ id: `${id}-artifact`, sha256: "a".repeat(64) })),
    nodeRuns: ["voice", "render", "visual-review"].map((nodeId) => ({ nodeId, status: "succeeded", artifactIds: [],
      outputState: { effectiveVersionId: `${nodeId}-version`, stale: false, versions: [{ id: `${nodeId}-version`,
        artifactIds: [`${nodeId}-artifact`], inputVersionIds: [], output: nodeId === "visual-review"
          ? { report: { reviewScope: { reviewStage: "rendered_video", evidenceId: "b".repeat(64) }, findings: [{ description: "慢节奏" }] } }
          : { layoutKey: "retained-layout" } }] } })),
    decisions: [],
  } as unknown as WorkflowRun<unknown>;
}

it("only prefills saved same-actor decisions with complete current media and audit identity", () => {
  const run = fixture();
  const basis = reviewDecisionBasis(run);
  assert.match(basis ?? "", /^[a-f0-9]{64}$/);
  const dispositions = [{ itemKey: "c".repeat(64), decision: "accept_risk" as const }];
  run.decisions.push({ id: "accepted", action: "approve", actor: "creator", interventionId: "previous-gate",
    createdAt: "2026-09-28T00:00:00Z", reviewEvidenceId: "b".repeat(64), reviewDispositions: dispositions,
    reviewDispositionBasis: basis } as WorkflowRun<unknown>["decisions"][number]);
  assert.deepEqual(reviewDecisionPrefill(run, "creator").dispositions, dispositions);
  assert.equal(reviewDecisionPrefill(run, "creator").sourceDecisionId, "accepted");
  assert.deepEqual(reviewDecisionPrefill(run, "someone-else").dispositions, []);
  for (const id of ["voice", "render", "visual-review"]) {
    const changed = structuredClone(run);
    const state = changed.nodeRuns.find(node => node.nodeId === id)!.outputState!;
    const version = structuredClone(state.versions[0]!);
    version.id += "-new-same-bytes";
    state.versions.push(version);
    state.effectiveVersionId = version.id;
    assert.deepEqual(reviewDecisionPrefill(changed, "creator").dispositions, [], id);
    state.stale = true;
    assert.equal(reviewDecisionBasis(changed), undefined);
  }
  const changedAudio = structuredClone(run);
  changedAudio.artifacts[0]!.sha256 = "d".repeat(64);
  assert.deepEqual(reviewDecisionPrefill(changedAudio, "creator").dispositions, []);
  const newAudit = structuredClone(run);
  newAudit.nodeRuns.find(node => node.nodeId === "visual-review")!.executionReceipt = {
    requestId: "new-audit-same-report", providerId: "test-review", providerLabel: "Test review",
    modelId: "test-model", transport: "http_api", billing: "subscription", status: "succeeded",
  } as NonNullable<WorkflowRun<unknown>["nodeRuns"][number]["executionReceipt"]>;
  assert.deepEqual(reviewDecisionPrefill(newAudit, "creator").dispositions, [], "新一次审查不能沿用旧表态，即使报告内容未变");
  const staleInput = structuredClone(run);
  staleInput.nodeRuns[0]!.inputState = { nodeId: "voice", effectiveVersionId: "new-input", stale: true, versions: [] };
  assert.equal(reviewDecisionBasis(staleInput), undefined, "声音输入已失效时旧输出不足以签字");
  const legacy = structuredClone(run);
  delete (legacy.decisions[0] as unknown as Record<string, unknown>).reviewDispositionBasis;
  assert.deepEqual(reviewDecisionPrefill(legacy, "creator").dispositions, [], "旧记录不补造签字身份");
});
