import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexBridgeError } from "../src/codex-chat.js";
import { ModelCandidatesExhaustedError } from "../src/fallback-role-agents.js";
import { classifyCreativeConsultationError } from "../src/creative-discussion-facts.js";

it("RF3 preserves every candidate fact through an outer role error", () => {
  const error = new ModelCandidatesExhaustedError([
    { providerId: "provider-a", modelId: "model-a", error: new CodexBridgeError("accepted failure", false, "completed_failure") },
    { providerId: "provider-b", modelId: "model-b", error: new CodexBridgeError("not accepted", true, "not_accepted") },
  ]);
  assert.deepEqual(classifyCreativeConsultationError(new Error("role wrapper", { cause: error })),
    classifyCreativeConsultationError(error));
  assert.equal(classifyCreativeConsultationError(error).fact, "failed");
});

it("RF3 retains wrapped unknown and unaccepted candidates without inventing attempts", () => {
  for (const firstStage of ["uncertain", "not_accepted"] as const) {
    const aggregate = new ModelCandidatesExhaustedError([
      { providerId: "a", modelId: "a", error: new Error("candidate wrapper", { cause: new CodexBridgeError("first", firstStage === "not_accepted", firstStage) }) },
      { providerId: "b", modelId: "b", error: new CodexBridgeError("second", true, "not_accepted") },
    ]);
    const actual = classifyCreativeConsultationError(new Error("outer", { cause: new Error("inner", { cause: aggregate }) }));
    assert.equal(actual.fact, firstStage === "uncertain" ? "unknown" : "not_accepted");
    assert.deepEqual(actual.candidates.map(entry => entry.modelId), ["a", "b"]);
    assert.equal(actual.candidates[0]!.state, firstStage === "uncertain" ? "unknown" : "not_accepted");
  }
});

it("RF3 bounds cyclic and deep causes and trusts the nearest evidence", () => {
  const cyclic = new Error("cycle");
  cyclic.cause = cyclic;
  assert.equal(classifyCreativeConsultationError(cyclic).fact, "unknown");
  let deep: Error = new CodexBridgeError("cannot reach safely", true, "not_accepted");
  for (let depth = 0; depth < 8; depth += 1) deep = new Error("wrapper", { cause: deep });
  assert.equal(classifyCreativeConsultationError(deep).fact, "unknown");
  const nearest = new CodexBridgeError("conflict", false, "conflict");
  nearest.cause = new CodexBridgeError("old not accepted", true, "not_accepted");
  assert.equal(classifyCreativeConsultationError(new Error("wrapper", { cause: nearest })).reason, "identity_conflict");
});
