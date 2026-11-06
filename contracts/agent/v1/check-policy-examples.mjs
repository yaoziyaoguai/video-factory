import assert from "node:assert/strict";

// 合同的纯规则示例，不是 HTTP 授权、数据库事务或供应商行为的测试。
export function checkPolicyExamples(api) {
  const policy = api["x-confirmation-policy"];
  function matchesConfirmationText(text) {
    let normalized = text.normalize("NFKC").trim();
    if (policy.allowedTerminalPunctuation.some(mark => normalized.endsWith(mark))) normalized = normalized.slice(0, -1);
    return policy.wholeMessageAllowlist.includes(normalized);
  }
  const confirmations = [
    ["开始制作", true], ["按这份开始", true], ["确认制作", true],
    ["开始制作。", true], ["确认制作.", true], ["  按这份开始。  ", true],
    ["开始制作？", false], ["确认制作?", false], ["按这份开始？", false],
    ["如果我说开始制作会怎样", false], ["现在先别开始制作", false],
    ["“开始制作”", false], ["开始制作，但换个模型", false], ["继续", false],
    ["开始制作..", false], ["开始制作  。", false], ["开始制作!", false],
  ];
  for (const [text, expected] of confirmations) assert.equal(matchesConfirmationText(text), expected, text);

  function targetsMatch(target, items) {
    const revisions = items.filter(item => item.mode === "revise");
    return revisions.length <= 1 && revisions.every(item => target !== null && item.artifactId === target.artifactId && item.baseRevisionId === target.revisionId);
  }
  const target = { artifactId: "a", revisionId: "a1" };
  const revise = (artifactId, baseRevisionId) => ({ mode: "revise", artifactId, baseRevisionId });
  const targets = [
    [target, [revise("a", "a1")], true], [target, [revise("b", "b1")], false],
    [target, [revise("a", "a2")], false], [null, [revise("a", "a1")], false],
    [target, [revise("a", "a1"), revise("b", "b1")], false],
    [target, [revise("a", "a1"), revise("a", "a1")], false],
    [null, [{ mode: "create" }], true], [target, [revise("a", "a1"), { mode: "create" }], true],
  ];
  for (const [scope, items, expected] of targets) assert.equal(targetsMatch(scope, items), expected);

  // 只演示账务事实版本选择；身份真实性、金额分配和原子账本必须由实际宿主另行验证。
  function selectBillingFact(current, incoming) {
    if (incoming.kind !== "authoritative") return { decision: "record_only", fact: current };
    if (!current) return { decision: "accept", fact: incoming };
    if (current.billingFactId !== incoming.billingFactId) return { decision: "conflict", fact: current };
    if (BigInt(incoming.sourceRevision) < BigInt(current.sourceRevision)) return { decision: "ignore_old", fact: current };
    if (BigInt(incoming.sourceRevision) === BigInt(current.sourceRevision)) {
      const same = current.netAmount.amountMinor === incoming.netAmount.amountMinor && current.netAmount.currency === incoming.netAmount.currency && current.final === incoming.final;
      return { decision: same ? "replay" : "conflict", fact: current };
    }
    return { decision: "accept", fact: incoming };
  }
  const fact = (sourceRevision, amountMinor, final = true) => ({ kind: "authoritative", billingFactId: "bill_1", sourceRevision, netAmount: { currency: "CNY", amountMinor }, final, evidenceId: "evidence_1" });
  const first = fact("1", 100);
  const corrected = fact("2", 80);
  const billing = [
    [null, first, "accept", 100], [first, first, "replay", 100],
    [first, corrected, "accept", 80], [corrected, first, "ignore_old", 80],
    [corrected, fact("2", 70), "conflict", 80],
    [corrected, { ...corrected, billingFactId: "other_bill" }, "conflict", 80],
    [corrected, { kind: "unverified" }, "record_only", 80],
    [fact("9007199254740993", 100), fact("9007199254740992", 90), "ignore_old", 100],
  ];
  for (const [current, incoming, decision, amount] of billing) {
    const result = selectBillingFact(current, incoming);
    assert.equal(result.decision, decision);
    assert.equal(result.fact.netAmount.amountMinor, amount);
  }
  const accepted = { id: "p1", revision: 2, state: "accepted" };
  const old = { id: "p1", revision: 1, state: "ready" };
  assert.equal((old.revision > accepted.revision ? old : accepted).state, "accepted");
  return { confirmationText: confirmations.length, targetScope: targets.length, billingFactOrdering: billing.length, proposalMerge: 1, scope: "reference predicates only; no service transactions exercised" };
}
