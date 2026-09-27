import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeError } from "../src/codex-chat.js";
import { RoleAgentHostStop, RoleAgentLoopError, RoleAuditOutputError } from "../src/role-agent-loop.js";
import {
  aggregateReviewDispositions,
  classifyCandidateAttempts,
  classifyReviewDisposition,
  dispositionAllowsHumanStop,
} from "../src/review-disposition.js";

function settledLoop() {
  return {
    version: "video-factory/agent-loop-v1" as const,
    role: "编剧",
    contractVersion: "test-v1",
    criteria: ["忠于事实"],
    status: "failed" as const,
    maxIterations: 1,
    iterations: [],
  };
}

describe("classifyReviewDisposition", () => {
  it("classifies a host-rejected audit as settled and unusable", () => {
    const error = new RoleAgentLoopError(
      "复核已返回，但没有可用的结论；当前内容保留，等待你决定。",
      settledLoop(),
      undefined,
      new RoleAuditOutputError("复核已返回，但没有可用的结论。", "hostReadinessReview validation failed"),
    );
    const disposition = classifyReviewDisposition(error);
    assert.deepEqual(
      { requestState: disposition.requestState, resultState: disposition.resultState, bindingState: disposition.bindingState, reasonCode: disposition.reasonCode },
      { requestState: "settled", resultState: "unusable", bindingState: "verified", reasonCode: "host_audit_rejected" },
    );
    assert.equal(dispositionAllowsHumanStop(disposition), true);
  });

  it("carries the original audit operation id from the cause chain", () => {
    const cause = new RoleAuditOutputError("复核已返回，但没有可用的结论。", "validation failed");
    (cause as Error & { auditOperationId?: string }).auditOperationId = "audit-op-1";
    const error = new RoleAgentLoopError("复核已返回。", settledLoop(), undefined, cause);
    assert.equal(classifyReviewDisposition(error).operationId, "audit-op-1");
  });

  it("maps bridge completed_failure to settled without a new audit", () => {
    const error = new RoleAgentLoopError("包装的终态失败。", settledLoop(), undefined,
      new CodexBridgeError("provider completed without output", false, "completed_failure"));
    const disposition = classifyReviewDisposition(error);
    assert.equal(disposition.requestState, "settled");
    assert.equal(disposition.resultState, "unusable");
    assert.equal(dispositionAllowsHumanStop(disposition), true);
  });

  it("keeps uncertain and conflict outcomes out of the accepted-risk channel", () => {
    const uncertain = classifyReviewDisposition(new CodexBridgeError("超时", false, "uncertain"));
    assert.equal(uncertain.requestState, "unknown");
    assert.equal(dispositionAllowsHumanStop(uncertain), false);
    const conflict = classifyReviewDisposition(new CodexBridgeError("身份冲突", false, "conflict"));
    assert.equal(conflict.requestState, "unknown");
    assert.equal(conflict.resultState, "conflict");
    assert.equal(conflict.bindingState, "conflict");
    assert.equal(dispositionAllowsHumanStop(conflict), false);
  });

  it("does not let an outer rejection hide nested unknown or conflicting request evidence", () => {
    for (const stage of ["uncertain", "conflict"] as const) {
      const cause = new CodexBridgeError("original request is unresolved", false, stage);
      const host = new RoleAuditOutputError("宿主没有可用结论", "rejected output");
      host.cause = cause;
      const outer = new CodexBridgeError("outer completed failure", false, "completed_failure");
      outer.cause = cause;
      for (const error of [host, outer, new RoleAgentLoopError("wrapper", settledLoop(), undefined, host)]) {
        const result = classifyReviewDisposition(error);
        assert.equal(result.requestState, "unknown");
        assert.equal(dispositionAllowsHumanStop(result), false);
      }
    }
  });

  it("does not treat truncated or cyclic evidence as proof that all requests settled", () => {
    const cyclic = new RoleAuditOutputError("宿主拒收", "x");
    cyclic.cause = cyclic;
    let truncated: Error = new CodexBridgeError("unknown", false, "uncertain");
    for (let index = 0; index < 8; index += 1) truncated = new Error("wrapper", { cause: truncated });
    const host = new RoleAuditOutputError("宿主拒收", "x");
    host.cause = truncated;
    for (const error of [cyclic, host]) assert.equal(dispositionAllowsHumanStop(classifyReviewDisposition(error)), false);
  });

  it("treats authoritative non-acceptance as bounded and resubmittable", () => {
    const notAccepted = classifyReviewDisposition(new CodexBridgeError("409 未受理", true, "not_accepted"));
    assert.equal(notAccepted.requestState, "not_accepted");
    assert.equal(notAccepted.bindingState, "verified");
    assert.equal(dispositionAllowsHumanStop(notAccepted), true);
    // 确定性协议拒绝是配置问题：保留原因并停在失败，不进补提交停点（既有产品决定）。
    const rejected = classifyReviewDisposition(new CodexBridgeError("参数被拒绝", false, "rejected"));
    assert.equal(rejected.requestState, "not_accepted");
    assert.equal(rejected.reasonCode, "bridge_rejected");
    assert.equal(dispositionAllowsHumanStop(rejected), false);
  });

  it("maps a host stop before submission to not_submitted", () => {
    const disposition = classifyReviewDisposition(new RoleAgentHostStop("paused", "宿主暂停。"));
    assert.equal(disposition.requestState, "not_submitted");
    assert.equal(disposition.resultState, "absent");
  });

  it("never reclassifies an ordinary technical error as settled", () => {
    const disposition = classifyReviewDisposition(new Error("TypeError: cannot read properties of undefined"));
    assert.equal(disposition.requestState, "unknown");
    assert.equal(disposition.bindingState, "unresolved");
    assert.equal(disposition.reasonCode, "unclassified_technical_error");
    assert.equal(dispositionAllowsHumanStop(disposition), false);
  });

  it("aggregates conservatively: any unknown dominates settled candidates", () => {
    const settled = classifyReviewDisposition(new RoleAuditOutputError("没有可用结论。", "x"));
    const unknown = classifyReviewDisposition(new CodexBridgeError("超时", false, "uncertain"));
    const notAccepted = classifyReviewDisposition(new CodexBridgeError("409", true, "not_accepted"));
    assert.equal(aggregateReviewDispositions([settled, unknown]).requestState, "unknown");
    assert.equal(aggregateReviewDispositions([settled, notAccepted]).requestState, "not_accepted");
    assert.equal(aggregateReviewDispositions([settled, settled]).requestState, "settled");
    assert.equal(aggregateReviewDispositions([]).requestState, "unknown");
  });

  it("classifies transport-level candidate failures as unknown, not settled", () => {
    const disposition = classifyCandidateAttempts([
      { modelId: "a", providerId: "p", outcome: "failed", failureStage: "completed_failure", failureReason: "no output" },
      { modelId: "b", providerId: "q", outcome: "failed", failureStage: "transport", failureReason: "connection reset" },
    ]);
    assert.equal(disposition.requestState, "unknown");
    assert.equal(dispositionAllowsHumanStop(disposition), false);
  });
});
