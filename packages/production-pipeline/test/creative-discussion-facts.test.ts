import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexBridgeError } from "../src/codex-chat.js";
import { ModelCandidatesExhaustedError } from "../src/fallback-role-agents.js";
import { classifyCreativeConsultationError, creativeConsultationDiagnosticDetail } from "../src/creative-discussion-facts.js";

it("preserves only safe input rejection diagnostics through role wrappers and candidate aggregation", () => {
  const rejection = (fieldPath: string) => new CodexBridgeError("private input and credential text", false, "rejected", 400, "contract_rejected", {
    category: "invalid_request", reasonCode: "input_contract", providerId: "fixture", modelId: "fixture", fieldPath,
  });
  const safe = new Error("wrapper with private text", { cause: rejection("payload.currentDocument.scenes[3].duration") });
  const facts = classifyCreativeConsultationError(safe);
  assert.deepEqual(facts.candidates[0]?.diagnostic, { reasonCode: "input_contract", fieldPath: "payload.currentDocument.scenes[3].duration" });
  assert.match(creativeConsultationDiagnosticDetail(facts), /第 4 镜时长/);
  assert.doesNotMatch(JSON.stringify(facts), /private|credential/);

  const mixed = classifyCreativeConsultationError(new ModelCandidatesExhaustedError([
    { providerId: "a", modelId: "a", error: safe },
    { providerId: "b", modelId: "b", error: new CodexBridgeError("unknown", false, "uncertain") },
  ]));
  assert.equal(mixed.fact, "unknown", "输入拒收不能覆盖另一候选的未知结果");
  assert.equal(mixed.candidates[0]?.diagnostic?.fieldPath, "payload.currentDocument.scenes[3].duration");
  for (const unsafe of ["payload.private\nsecret", "/private/token", "payload." + "x".repeat(250)]) {
    const scrubbed = classifyCreativeConsultationError(rejection(unsafe));
    assert.deepEqual(scrubbed.candidates[0]?.diagnostic, { reasonCode: "input_contract" });
    assert.ok(!JSON.stringify(scrubbed).includes(unsafe));
  }
  const untrusted = new Error("payload.currentDocument.scenes[1].narration invalid");
  assert.equal(creativeConsultationDiagnosticDetail(classifyCreativeConsultationError(untrusted)), "");
});

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
