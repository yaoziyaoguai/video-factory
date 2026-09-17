import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeError, RoleAgentLoopError, runRoleAgentLoop, validateRoleAudit } from "../src/index.js";
import type { ModelProviderFailureCategory } from "../src/codex-chat.js";

describe("role agent loop audit boundary", () => {
  it("rejects more than 16 audit criteria before submitting a model task", async () => {
    let modelCalls = 0;
    await assert.rejects(() => runRoleAgentLoop({
      role: "视觉审片员",
      contractVersion: "visual-review-contract",
      criteria: Array.from({ length: 17 }, (_, index) => `审片标准 ${index + 1}`),
      maxIterations: 1,
      produce: async () => {
        modelCalls += 1;
        return { output: { title: "不应调用" } };
      },
      audit: async () => {
        modelCalls += 1;
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    }), /must contain 1 to 16 non-empty rules/);
    assert.equal(modelCalls, 0);
  });

  // 上限两侧都要钉住：只证明 17 被拒不证明 16 仍可用，容量被悄悄收紧时不会有测试变红。
  it("accepts exactly 16 audit criteria and runs the loop", async () => {
    let auditCalls = 0;
    const execution = await runRoleAgentLoop<{ title: string }>({
      role: "视觉审片员",
      contractVersion: "visual-review-contract",
      criteria: Array.from({ length: 16 }, (_, index) => `审片标准 ${index + 1}`),
      maxIterations: 1,
      produce: async () => ({ output: { title: "满额标准候选" } }),
      audit: async () => {
        auditCalls += 1;
        return { output: passingAudit(REPORT_AUDIT_DIMENSIONS) };
      },
      validate: titleCandidate,
    });
    assert.equal(execution.output.title, "满额标准候选");
    assert.equal(auditCalls, 1);
  });

  it("does not count queue rejection as audit execution and preserves the producer on retry", async () => {
    let stored: unknown;
    let rejectAudit = true;
    let produces = 0;
    const execute = () => runRoleAgentLoop({
      role: "编剧", contractVersion: "audit-queue", criteria: ["清楚"], maxIterations: 1,
      checkpoint: { key: "audit-queue", load: async () => stored, save: async (value) => { stored = structuredClone(value); } },
      produce: async () => { produces++; return { output: { title: "保留的稿件" } }; },
      audit: async () => {
        if (rejectAudit) throw new CodexBridgeError("Codex broker backlog is full.", true, "not_accepted", 503);
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    });
    await assert.rejects(execute, (error: unknown) => {
      assert.ok(error instanceof RoleAgentLoopError);
      assert.equal(error.agentLoop.producerModelCallCount, 1);
      assert.equal(error.agentLoop.auditModelCallCount, 0);
      return true;
    });
    rejectAudit = false;
    const result = await execute();
    assert.equal(produces, 1);
    assert.equal(result.agentLoop?.producerModelCallCount, 1);
    assert.equal(result.agentLoop?.auditModelCallCount, 1);
  });
  const producerHandle = `vfs_${"p".repeat(32)}`;
  const auditHandle = `vfs_${"a".repeat(32)}`;

  function changedContractFailedAuditFixture(
    oldFailureKind: "model_provider_transient" | "model_provider_no_output",
    currentOutcomes: Array<"pass" | "completed_failure" | "uncertain">,
  ) {
    let stored: unknown;
    let originalAuditRequestId = "";
    let seedOldAudit = true;
    let produceCalls = 0;
    let oldAuditObservations = 0;
    let currentAuditSubmissions = 0;
    let currentAuditObservations = 0;
    const execute = (contractVersion: string, criteria: string[], resumeRequestId?: string) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion,
      criteria,
      maxIterations: 3,
      checkpoint: {
        key: "changed-contract-failed-audit",
        ...(resumeRequestId ? { resumeCompletedFailureRequestId: resumeRequestId } : {}),
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "保留的候选" } };
      },
      audit: async (operation) => {
        if (operation.preparedOperation) {
          const payload = operation.preparedOperation.envelope.payload as { contract?: unknown };
          if (payload.contract === "old") {
            oldAuditObservations += 1;
            throw new CodexBridgeError("old audit failed", false, "completed_failure", 502, oldFailureKind);
          }
          currentAuditObservations += 1;
          return { output: passingAudit() };
        }
        if (seedOldAudit) {
          seedOldAudit = false;
          originalAuditRequestId = operation.requestId;
          const prepared = preparedOperation(operation, "role-audit");
          prepared.envelope.payload = { contract: "old" };
          await operation.requestOptions.beforeSubmit?.(prepared);
          throw new CodexBridgeError("old audit reply lost", false, "uncertain");
        }
        currentAuditSubmissions += 1;
        const prepared = preparedOperation(operation, "role-audit");
        prepared.envelope.payload = { contract: "current" };
        await operation.requestOptions.beforeSubmit?.(prepared);
        const outcome = currentOutcomes.shift() ?? "pass";
        if (outcome === "completed_failure") {
          throw new CodexBridgeError("current audit failed", false, "completed_failure", 502, "model_provider_transient");
        }
        if (outcome === "uncertain") {
          throw new CodexBridgeError("current audit reply lost", false, "uncertain");
        }
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    });
    return {
      execute,
      originalRequestId: () => originalAuditRequestId,
      counts: () => ({ produceCalls, oldAuditObservations, currentAuditSubmissions, currentAuditObservations }),
      stored: () => stored,
    };
  }

  it("stops after a bounded number of session rebuilds when every produce request is rejected as not accepted", async () => {
    // C5/CG-06：已确证未受理允许安全换会话，但重建必须有持久化上界——连续 409 不能
    // 形成无界请求循环。上限 2 次受控重建后停止并保留原因。
    let stored: unknown;
    let produceCalls = 0;
    const requestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-rebuild-bound-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: "rebuild-bound",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, { requestId }) => {
        produceCalls += 1;
        requestIds.push(requestId);
        throw new CodexBridgeError(
          "Codex bridge returned HTTP 409. Codex role session is unknown or belongs to a different production role.",
          false,
          "not_accepted",
          409,
        );
      },
      audit: async () => ({ output: passingAudit() }),
      validate: (value) => value as { title: string },
    });

    // 第 1、2 次未受理允许受控重建（每次 requestId 都不同）；第 3 次触达上界并停止。
    let firstFailure: unknown;
    await assert.rejects(
      execute,
      (error: unknown) => {
        firstFailure = error;
        return error instanceof Error && /会话被连续拒绝/.test(error.message);
      },
    );
    assert.equal(firstFailure instanceof RoleAgentLoopError ? firstFailure.agentLoop.modelCallCount : -1, 0);
    assert.equal(firstFailure instanceof RoleAgentLoopError ? firstFailure.agentLoop.producerModelCallCount : -1, 0);
    assert.equal(firstFailure instanceof RoleAgentLoopError ? firstFailure.agentLoop.auditModelCallCount : -1, 0);
    assert.equal(produceCalls, 3);
    assert.equal(new Set(requestIds).size, 3, "each rebuild must use a fresh request identity");

    // 重建预算持久化在 checkpoint：新进程恢复后不重置预算，再一次 409 立即停止。
    produceCalls = 0;
    requestIds.length = 0;
    await assert.rejects(execute, /会话被连续拒绝/);
    assert.equal(produceCalls, 1);
  });

  it("rejects a low-score pass even when the broker is bypassed", () => {
    assert.throws(() => validateRoleAudit({
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      verdict: "pass",
      score: 79,
      assessments: auditAssessments(CREATIVE_AUDIT_DIMENSIONS, 79),
      summary: "错误放行",
      issues: [],
      repairInstructions: [],
    }), /score >= 80/);
  });

  it("resumes from a persisted candidate without repeating completed model work", async () => {
    let stored: unknown;
    let produceCalls = 0;
    let auditCalls = 0;
    let failFirstAudit = true;
    const requestIds: string[] = [];
    const execute = (contractVersion = "screenwriter-v1", criteria = ["标题具体"]) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion,
      criteria,
      maxIterations: 3,
      checkpoint: {
        key: "same-input",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        produceCalls += 1;
        requestIds.push(`produce:${operation.requestId}`);
        return { output: { title: "具体标题" } };
      },
      audit: async ({ requestId }) => {
        auditCalls += 1;
        requestIds.push(`audit:${requestId}`);
        if (failFirstAudit) {
          failFirstAudit = false;
          throw new Error("审计服务暂时中断");
        }
        return {
          output: {
            version: "video-factory/role-audit-v2",
            rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass",
            score: 92,
            assessments: auditAssessments(CREATIVE_AUDIT_DIMENSIONS, 92),
            summary: "可以进入下游",
            issues: [],
            repairInstructions: [],
          },
        };
      },
      validate: (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)
          || typeof (value as { title?: unknown }).title !== "string") {
          throw new Error("candidate invalid");
        }
        return { title: (value as { title: string }).title };
      },
    });

    await assert.rejects(execute, /审计服务暂时中断/);
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 1);

    const resumed = await execute();
    assert.deepEqual(resumed.output, { title: "具体标题" });
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 2);

    const replayed = await execute();
    assert.deepEqual(replayed.output, { title: "具体标题" });
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 2);
    assert.equal(requestIds[1], requestIds[2]);

    const afterContractChange = await execute("screenwriter-v2");
    assert.deepEqual(afterContractChange.output, { title: "具体标题" });
    assert.equal(produceCalls, 2);
    assert.equal(auditCalls, 3);
    assert.notEqual(requestIds[0], requestIds[3]);

    await execute("screenwriter-v2", ["标题具体", "不得夸张"]);
    assert.equal(produceCalls, 3);
    assert.equal(auditCalls, 4);
    assert.notEqual(requestIds[3], requestIds[5]);
  });

  it("reports real producer, audit, validation, and retry timings", async () => {
    let clock = 0;
    let produceCalls = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-timing-v1",
      criteria: ["标题具体"],
      maxIterations: 1,
      now: () => clock++,
      produce: async () => ({
        output: ++produceCalls === 1 ? { invalid: true } : { title: "具体标题" },
      }),
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    assert.equal(produceCalls, 2);
    assert.equal(result.agentLoop?.producerMs, 2);
    assert.equal(result.agentLoop?.auditMs, 1);
    assert.equal(result.agentLoop?.validationMs, 4);
    assert.equal(result.agentLoop?.retryCount, 1);
    assert.equal(result.agentLoop?.modelCallCount, 3);
    assert.equal(result.agentLoop?.producerModelCallCount, 2);
    assert.equal(result.agentLoop?.auditModelCallCount, 1);
    assert.equal(result.agentLoop?.structuredRepairModelCallCount, 1);
    assert.equal("inferenceMs" in (result.agentLoop ?? {}), false);
    assert.equal("ttftMs" in (result.agentLoop ?? {}), false);
  });

  it("never rotates an accepted request with an uncertain broker outcome", async () => {
    let stored: unknown;
    const failedRequestIds = new Set<string>();
    const requestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"] as string[],
      maxIterations: 3,
      checkpoint: {
        key: "cached-audit-failure",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => ({ output: { title: "具体标题" } }),
      audit: async ({ requestId }) => {
        requestIds.push(requestId);
        if (requestIds.length === 1) failedRequestIds.add(requestId);
        if (failedRequestIds.has(requestId)) {
          throw new CodexBridgeError("HTTP 409: accepted task outcome is uncertain", false);
        }
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    });

    // C5/CG-08：uncertain 结果的创作者文案必须引导核对原请求，不得建议重试/换模型。
    await assert.rejects(execute, /结果未知[^"]*核对原有任务/);
    await assert.rejects(execute, /结果未知[^"]*核对原有任务/);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
  });

  it("observes an accepted pending operation before applying a changed role contract", async () => {
    let stored: unknown;
    let interrupted = true;
    const submitted: string[] = [];
    const observed: string[] = [];
    const execute = (contractVersion: string, criteria: string[]) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion,
      criteria,
      maxIterations: 3,
      checkpoint: {
        key: "accepted-input",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        if (operation.preparedOperation) {
          observed.push(operation.preparedOperation.requestId);
          throw new CodexBridgeError("original task is still running", false, "uncertain");
        }
        submitted.push(operation.requestId);
        await operation.requestOptions.beforeSubmit?.({
          version: "video-factory/codex-prepared-operation-v1",
          requestId: operation.requestId,
          kind: "script-draft",
          envelope: { payload: { title: "原输入" } },
          serializedEnvelope: '{"payload":{"title":"原输入"}}',
          binding: { requestDigest: "a".repeat(64) } as never,
          brokerBinding: {} as never,
          route: { socketPath: "/tmp/not-connected.sock" },
          taskFact: "accepted_unknown",
        });
        if (interrupted) {
          interrupted = false;
          throw new CodexBridgeError("accepted but observation interrupted", false, "uncertain");
        }
        return { output: { title: "unexpected new request" } };
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await assert.rejects(() => execute("screenwriter-old", ["标题具体"]), /结果未知/);
    const originalRequestId = (stored as { pendingOperation: { operation: { requestId: string } } }).pendingOperation.operation.requestId;
    await assert.rejects(() => execute("screenwriter-new", ["标题具体且动作可见"]), /结果未知/);

    assert.deepEqual(submitted, [originalRequestId]);
    assert.deepEqual(observed, [originalRequestId]);
    assert.equal((stored as { phaseAttempts: { produce: number } }).phaseAttempts.produce, 1, "pure observation must not consume another model call");
  });

  it("retires a verified transient terminal failure and creates one new generation only on explicit recovery", async () => {
    let stored: unknown;
    let first = true;
    const submitted: string[] = [];
    const observed: string[] = [];
    const baseCheckpoint = {
      key: "terminal-recovery",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const execute = (resumeCompletedFailure: boolean) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-current",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: { ...baseCheckpoint, resumeCompletedFailure },
      produce: async (_revision, operation) => {
        if (operation.preparedOperation) {
          observed.push(operation.preparedOperation.requestId);
          throw new CodexBridgeError("provider unavailable", false, "completed_failure", 422, "model_provider_transient");
        }
        submitted.push(operation.requestId);
        await operation.requestOptions.beforeSubmit?.({
          version: "video-factory/codex-prepared-operation-v1",
          requestId: operation.requestId,
          kind: "script-draft",
          envelope: { payload: { title: "输入" } },
          serializedEnvelope: '{"payload":{"title":"输入"}}',
          binding: { requestDigest: "b".repeat(64) } as never,
          brokerBinding: {} as never,
          route: { socketPath: "/tmp/not-connected.sock" },
          taskFact: "accepted_unknown",
        });
        if (first) {
          first = false;
          throw new CodexBridgeError("accepted but interrupted", false, "uncertain");
        }
        return { output: { title: "恢复后的新成果" } };
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await assert.rejects(() => execute(false), /结果未知/);
    const originalRequestId = submitted[0]!;
    const result = await execute(true);

    assert.equal(result.output.title, "恢复后的新成果");
    assert.deepEqual(observed, [originalRequestId]);
    assert.equal(submitted.length, 2, "one explicit recovery may create exactly one next-generation request");
    assert.notEqual(submitted[1], originalRequestId, "the terminal physical request id must never be reused");
    assert.equal(result.agentLoop?.producerModelCallCount, 2);
    assert.equal(result.agentLoop?.iterations.length, 1, "terminal infrastructure failure does not spend a quality audit round");
  });

  // 失败文案不得自相矛盾：语义/合同类失败必须先修正，不能同时告诉运营方"可直接重试"。
  it("only tells the operator to retry unchanged when the failure is retryable without a correction", async () => {
    const cases: Array<{ category: ModelProviderFailureCategory; reasonCode: string; fieldPath: string | undefined; retryAsIs: boolean; expected: RegExp }> = [
      { category: "invalid_output", reasonCode: "visual_failed_rework", fieldPath: "output.findings[1].nextAction", retryAsIs: false, expected: /可执行的返修方向/ },
      { category: "invalid_output", reasonCode: "visual_approval_score", fieldPath: "output.recommendation", retryAsIs: false, expected: /五项评分中有低于 75 的项/ },
      { category: "invalid_request", reasonCode: "invalid_request_error", fieldPath: "input.images", retryAsIs: false, expected: /请求合同需要修正/ },
      { category: "rate_limited", reasonCode: "1308", fieldPath: undefined, retryAsIs: true, expected: /稍后重试/ },
    ];
    for (const { category, reasonCode, fieldPath, retryAsIs, expected } of cases) {
      let stored: unknown;
      const failure = await runRoleAgentLoop<{ title: string }>({
        role: "编剧",
        contractVersion: `screenwriter-retry-copy-${reasonCode}`,
        criteria: ["标题具体"],
        maxIterations: 3,
        checkpoint: {
          key: `retry-copy-${reasonCode}`,
          load: async () => stored,
          save: async (value: unknown) => { stored = structuredClone(value); },
        },
        produce: async () => {
          // 与 completedFailureError 的真实构造一致：failureKind 只承载 provider 侧
          // 瞬态/无输出两类，语义类信息一律走 failureDetails。
          throw new CodexBridgeError("bridge completed with failure", false, "completed_failure", 422, undefined, {
            category,
            reasonCode,
            providerId: "deepseek",
            modelId: "deepseek-flash",
            ...(fieldPath ? { fieldPath } : {}),
            queueWaitMs: 0,
            providerWaitMs: 989_138,
          });
        },
        audit: async () => ({ output: passingAudit() }),
        validate: titleCandidate,
      }).then(() => null, (error: unknown) => error as Error);

      assert.ok(failure, `${reasonCode} must fail the loop`);
      assert.match(failure.message, /尚未消耗质量审计轮次/);
      assert.match(failure.message, expected);
      assert.equal(
        /可直接重试/.test(failure.message),
        retryAsIs,
        `${reasonCode} retry hint must match whether a plain retry can succeed`,
      );
    }
  });

  it("persists the creator-facing failure reason alongside the machine diagnostics", async () => {
    let stored: unknown;
    const failure = await runRoleAgentLoop<{ title: string }>({
      role: "内容简报",
      contractVersion: "brief-failure-summary-v1",
      criteria: ["结论具体"],
      maxIterations: 1,
      checkpoint: {
        key: "brief-failure-summary",
        load: async () => stored,
        save: async (value: unknown) => { stored = structuredClone(value); },
      },
      produce: async () => {
        throw new CodexBridgeError("socket hang up", true, "uncertain", undefined, undefined, {
          category: "network",
          reasonCode: "connection_failed",
          providerId: "deepseek",
          modelId: "deepseek-flash",
          queueWaitMs: 0,
          providerWaitMs: 155_751,
        });
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    }).then(() => null, (error: unknown) => error as Error);

    assert.ok(failure);
    const persisted = (stored as { failure?: { stage?: string; summary?: string } }).failure;
    assert.equal(persisted?.stage, "uncertain");
    // failure 里原来只有 stage/statusCode/failureKind/details —— 都是给操作员定位用的机器字段。
    // 节点失败拖垮整条 run 时中文原因会走 run.failure，可节点活下来接着往下走时（现在每条路径
    // 都可能如此）checkpoint 是唯一通道：中文说明不落盘，界面上就只剩"请查看失败原因"这句空指。
    assert.match(persisted?.summary ?? "", /连接中断|结果未知/);
  });

  it("consumes a produce recovery grant on the verified request and stops on the next completed failure", async () => {
    let stored: unknown;
    let setup = true;
    let originalRequestId = "";
    const submitted: string[] = [];
    const observed: string[] = [];
    const execute = (resumeRequestId?: string) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-recovery-scope-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: "produce-recovery-scope",
        ...(resumeRequestId ? { resumeCompletedFailureRequestId: resumeRequestId } : {}),
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        if (operation.preparedOperation) {
          observed.push(operation.preparedOperation.requestId);
        } else {
          submitted.push(operation.requestId);
          await operation.requestOptions.beforeSubmit?.(preparedOperation(operation, "script-draft"));
        }
        if (setup) {
          setup = false;
          originalRequestId = operation.requestId;
          throw new CodexBridgeError("accepted but interrupted", false, "uncertain");
        }
        throw new CodexBridgeError("provider unavailable", false, "completed_failure", 502, "model_provider_transient");
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await assert.rejects(() => execute(), /结果未知/);
    await assert.rejects(() => execute(originalRequestId), /内容生成暂时失败/);

    assert.deepEqual(observed, [originalRequestId]);
    assert.equal(submitted.length, 2, "one grant creates one replacement request only");
    assert.notEqual(submitted[1], originalRequestId);
    assert.equal((stored as { completed: unknown[] }).completed.length, 0);
    assert.equal((stored as { status: string }).status, "failed");
  });

  it("consumes an audit recovery grant without repeating produce or leaking it into a later phase", async () => {
    let stored: unknown;
    let setup = true;
    let originalAuditRequestId = "";
    let produceCalls = 0;
    const auditSubmissions: string[] = [];
    const auditObservations: string[] = [];
    const execute = (resumeRequestId?: string) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-audit-recovery-scope-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: "audit-recovery-scope",
        ...(resumeRequestId ? { resumeCompletedFailureRequestId: resumeRequestId } : {}),
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "保留的候选" } };
      },
      audit: async (operation) => {
        if (operation.preparedOperation) {
          auditObservations.push(operation.preparedOperation.requestId);
        } else {
          auditSubmissions.push(operation.requestId);
          await operation.requestOptions.beforeSubmit?.(preparedOperation(operation, "role-audit"));
        }
        if (setup) {
          setup = false;
          originalAuditRequestId = operation.requestId;
          throw new CodexBridgeError("accepted audit interrupted", false, "uncertain");
        }
        throw new CodexBridgeError("audit provider unavailable", false, "completed_failure", 502, "model_provider_transient");
      },
      validate: titleCandidate,
    });

    await assert.rejects(() => execute(), /结果未知/);
    await assert.rejects(() => execute(originalAuditRequestId), /独立审计暂时失败/);

    assert.equal(produceCalls, 1);
    assert.deepEqual(auditObservations, [originalAuditRequestId]);
    assert.equal(auditSubmissions.length, 2);
    assert.deepEqual((stored as { pendingCandidate: { candidate: unknown } }).pendingCandidate.candidate, { title: "保留的候选" });
  });

  it("does not let a produce recovery grant authorize a new audit failure", async () => {
    let stored: unknown;
    let setup = true;
    let originalProduceRequestId = "";
    let produceSubmissions = 0;
    let auditSubmissions = 0;
    const execute = (resumeRequestId?: string) => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-phase-isolation-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: "phase-isolation",
        ...(resumeRequestId ? { resumeCompletedFailureRequestId: resumeRequestId } : {}),
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        if (!operation.preparedOperation) {
          produceSubmissions += 1;
          await operation.requestOptions.beforeSubmit?.(preparedOperation(operation, "script-draft"));
        }
        if (setup) {
          setup = false;
          originalProduceRequestId = operation.requestId;
          throw new CodexBridgeError("accepted produce interrupted", false, "uncertain");
        }
        if (operation.preparedOperation) {
          throw new CodexBridgeError("old produce failed", false, "completed_failure", 502, "model_provider_transient");
        }
        return { output: { title: "恢复后的候选" } };
      },
      audit: async (operation) => {
        auditSubmissions += 1;
        throw new CodexBridgeError("new audit failed", false, "completed_failure", 502, "model_provider_transient");
      },
      validate: titleCandidate,
    });

    await assert.rejects(() => execute(), /结果未知/);
    await assert.rejects(() => execute(originalProduceRequestId), /独立审计暂时失败/);

    assert.equal(produceSubmissions, 2);
    assert.equal(auditSubmissions, 1, "a grant for the old produce request must not retry audit");
    assert.deepEqual((stored as { pendingCandidate: { candidate: unknown } }).pendingCandidate.candidate, { title: "恢复后的候选" });
  });

  it("does not let a recovery grant from an earlier role authorize a later role request", async () => {
    let laterRoleCalls = 0;
    await assert.rejects(
      () => runRoleAgentLoop<{ title: string }>({
        role: "导演",
        contractVersion: "director-role-isolation-v1",
        criteria: ["逐镜可执行"],
        maxIterations: 3,
        checkpoint: {
          key: "later-role",
          resumeCompletedFailureRequestId: "earlier-screenwriter-request",
          load: async () => undefined,
          save: async () => undefined,
        },
        produce: async () => {
          laterRoleCalls += 1;
          throw new CodexBridgeError("director provider unavailable", false, "completed_failure", 502, "model_provider_transient");
        },
        audit: async () => ({ output: passingAudit() }),
        validate: titleCandidate,
      }),
      /内容生成暂时失败/,
    );
    assert.equal(laterRoleCalls, 1);
  });

  for (const changedContract of [
    { name: "contractVersion", contractVersion: "screenwriter-contract-v2", criteria: ["标题具体"] },
    { name: "criteria", contractVersion: "screenwriter-contract-v1", criteria: ["标题具体", "事实有来源"] },
  ]) {
    it(`settles an old pending audit but re-audits after a ${changedContract.name} change and survives another interruption`, async () => {
      let stored: unknown;
      let firstAudit = true;
      let currentAuditInterrupted = true;
      let produceCalls = 0;
      let oldAuditObservations = 0;
      let currentAuditSubmissions = 0;
      let currentAuditObservations = 0;
      const execute = (contractVersion: string, criteria: string[]) => runRoleAgentLoop<{ title: string }>({
        role: "编剧",
        contractVersion,
        criteria,
        maxIterations: 3,
        checkpoint: {
          key: "pending-audit-contract-change",
          load: async () => stored,
          save: async (value) => { stored = structuredClone(value); },
        },
        produce: async () => {
          produceCalls += 1;
          return { output: { title: "沿用的候选" } };
        },
        audit: async (operation) => {
          if (operation.preparedOperation) {
            const payload = operation.preparedOperation.envelope.payload as { contract?: unknown };
            if (payload.contract === "old") oldAuditObservations += 1;
            else currentAuditObservations += 1;
            return { output: passingAudit() };
          }
          if (firstAudit) {
            firstAudit = false;
            const prepared = preparedOperation(operation, "role-audit");
            prepared.envelope.payload = { contract: "old" };
            await operation.requestOptions.beforeSubmit?.(prepared);
            throw new CodexBridgeError("old audit reply lost", false, "uncertain");
          }
          currentAuditSubmissions += 1;
          const prepared = preparedOperation(operation, "role-audit");
          prepared.envelope.payload = { contract: "current" };
          await operation.requestOptions.beforeSubmit?.(prepared);
          if (currentAuditInterrupted) {
            currentAuditInterrupted = false;
            throw new CodexBridgeError("current audit reply lost", false, "uncertain");
          }
          return { output: passingAudit() };
        },
        validate: titleCandidate,
      });

      await assert.rejects(() => execute("screenwriter-contract-v1", ["标题具体"]), /结果未知/);
      await assert.rejects(() => execute(changedContract.contractVersion, changedContract.criteria), /结果未知/);
      const result = await execute(changedContract.contractVersion, changedContract.criteria);

      assert.equal(produceCalls, 1, "contract-only changes retain the candidate");
      assert.equal(oldAuditObservations, 1);
      assert.equal(currentAuditSubmissions, 1);
      assert.equal(currentAuditObservations, 1);
      assert.equal(result.agentLoop?.status, "passed");
      assert.equal(result.agentLoop?.contractVersion, changedContract.contractVersion);
    });
  }

  for (const changedContract of [
    {
      name: "contractVersion with transient old failure",
      contractVersion: "screenwriter-combined-v2",
      criteria: ["标题具体"],
      failureKind: "model_provider_transient" as const,
    },
    {
      name: "criteria with no-output old failure",
      contractVersion: "screenwriter-combined-v1",
      criteria: ["标题具体", "事实有来源"],
      failureKind: "model_provider_no_output" as const,
    },
  ]) {
    it(`accepts the first current audit after ${changedContract.name}`, async () => {
      const fixture = changedContractFailedAuditFixture(changedContract.failureKind, ["pass"]);
      await assert.rejects(() => fixture.execute("screenwriter-combined-v1", ["标题具体"]), /结果未知/);

      const result = await fixture.execute(
        changedContract.contractVersion,
        changedContract.criteria,
        fixture.originalRequestId(),
      );

      assert.equal(result.agentLoop?.status, "passed");
      assert.deepEqual(fixture.counts(), {
        produceCalls: 1,
        oldAuditObservations: 1,
        currentAuditSubmissions: 1,
        currentAuditObservations: 0,
      });
    });
  }

  it("stops when the first current audit fails after settling an old-contract failure", async () => {
    const fixture = changedContractFailedAuditFixture("model_provider_transient", ["completed_failure"]);
    await assert.rejects(() => fixture.execute("screenwriter-combined-v1", ["标题具体"]), /结果未知/);
    await assert.rejects(
      () => fixture.execute("screenwriter-combined-v2", ["标题具体"], fixture.originalRequestId()),
      /独立审计暂时失败/,
    );

    assert.deepEqual(fixture.counts(), {
      produceCalls: 1,
      oldAuditObservations: 1,
      currentAuditSubmissions: 1,
      currentAuditObservations: 0,
    });
    assert.equal((fixture.stored() as { status: string }).status, "failed");
    assert.deepEqual(
      (fixture.stored() as { pendingCandidate: { candidate: unknown } }).pendingCandidate.candidate,
      { title: "保留的候选" },
    );
  });

  it("observes the current audit after interruption without repeating the producer", async () => {
    const fixture = changedContractFailedAuditFixture("model_provider_no_output", ["uncertain"]);
    await assert.rejects(() => fixture.execute("screenwriter-combined-v1", ["标题具体"]), /结果未知/);
    await assert.rejects(
      () => fixture.execute("screenwriter-combined-v1", ["标题具体", "事实有来源"], fixture.originalRequestId()),
      /结果未知/,
    );
    const result = await fixture.execute("screenwriter-combined-v1", ["标题具体", "事实有来源"]);

    assert.equal(result.agentLoop?.status, "passed");
    assert.deepEqual(fixture.counts(), {
      produceCalls: 1,
      oldAuditObservations: 1,
      currentAuditSubmissions: 1,
      currentAuditObservations: 1,
    });
  });

  it("opens a fresh bounded session with full repair context when the broker loses an old handle", async () => {
    const revisions: Array<{ mode?: string } | undefined> = [];
    const sessions: Array<{ key: string; handle?: string }> = [];
    let producerCalls = 0;
    let auditCalls = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-session-recovery-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      produce: async (revision, operation) => {
        producerCalls += 1;
        revisions.push(revision ? { mode: revision.mode } : undefined);
        sessions.push(structuredClone(operation.session));
        if (producerCalls === 2) {
          throw new CodexBridgeError(
            "Codex bridge returned HTTP 409. Codex role session is unknown or belongs to a different production role.",
            false,
            "not_accepted",
            409,
          );
        }
        return {
          output: { title: producerCalls === 1 ? "第一版标题" : "修订后的具体标题" },
          session: { key: operation.session.key, handle: `vfs_${(producerCalls === 1 ? "p" : "n").repeat(32)}` },
        };
      },
      audit: async ({ session }) => {
        auditCalls += 1;
        return {
          output: auditCalls === 1 ? repairingAudit() : passingAudit(),
          session: { key: session.key, handle: `vfs_${"a".repeat(32)}` },
        };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(revisions.map((revision) => revision?.mode), [undefined, "repair-delta", "repair-bootstrap"]);
    assert.match(sessions[1]?.handle ?? "", /^vfs_p/);
    assert.equal(sessions[2]?.handle, undefined);
    assert.deepEqual(result.output, { title: "修订后的具体标题" });
    assert.equal(result.agentLoop?.producerModelCallCount, 2);
    assert.equal(result.agentLoop?.auditModelCallCount, 2);
    assert.equal(result.agentLoop?.modelCallCount, 4);
  });

  it("stops an exhausted checkpoint at the user instead of failing it, until the caller supplies a new key", async () => {
    let stored: unknown;
    let produceCalls = 0;
    let auditCalls = 0;
    const requestIds: string[] = [];
    const execute = (checkpointKey = "three-round-cycle") => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: checkpointKey,
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (_revision, { requestId }) => {
        produceCalls += 1;
        requestIds.push(requestId);
        return { output: { title: `候选 ${produceCalls}` } };
      },
      audit: async () => {
        auditCalls += 1;
        return {
          output: produceCalls <= 3 ? repairingAudit() : passingAudit(),
        };
      },
      validate: titleCandidate,
    });

    // 三轮自动重做都没过审计，作品也不算失败：第三版连审计一起交还给用户裁决。
    const stopped = await execute();
    assert.equal(stopped.agentLoop?.status, "awaiting_user");
    assert.deepEqual(stopped.output, { title: "候选 3" });
    assert.equal(produceCalls, 3);
    assert.equal(auditCalls, 3);

    // 同一个 key 上它已是终态：不会背着用户又去重做一轮。
    const again = await execute();
    assert.equal(again.agentLoop?.status, "awaiting_user");
    assert.deepEqual(again.output, { title: "候选 3" });
    assert.equal(produceCalls, 3);
    assert.equal(auditCalls, 3);

    const restarted = await execute("three-round-cycle:new-input");

    assert.deepEqual(restarted.output, { title: "候选 4" });
    assert.equal(produceCalls, 4);
    assert.equal(auditCalls, 4);
    assert.notEqual(requestIds[0], requestIds[3]);
  });

  it("does not share operation request ids between checkpoint-free loop invocations", async () => {
    const requestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 1,
      produce: async (_revision, { requestId }) => {
        requestIds.push(requestId);
        return { output: { title: "具体标题" } };
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await execute();
    await execute();
    assert.notEqual(requestIds[0], requestIds[1]);
  });

  it("carries the previous audit into the next review so the standard cannot move between rounds", async () => {
    const previousAudits: Array<unknown> = [];
    let produced = 0;
    const firstAudit = repairingAudit();
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 2,
      produce: async () => ({ output: { title: `候选 ${++produced}` } }),
      audit: async ({ previousAudit }) => {
        previousAudits.push(previousAudit);
        return { output: previousAudit ? passingAudit() : firstAudit };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(result.output, { title: "候选 2" });
    assert.deepEqual(previousAudits, [undefined, firstAudit]);
  });

  it("keeps one producer session and one isolated audit session for the whole role loop", async () => {
    let stored: unknown;
    const producerSessions: Array<{ key: string; handle?: string }> = [];
    const auditSessions: Array<{ key: string; handle?: string }> = [];
    const producerRevisions: unknown[] = [];
    let produced = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 2,
      checkpoint: {
        key: "run-1:script",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (revision, { session }) => {
        producerRevisions.push(structuredClone(revision));
        producerSessions.push({ ...session });
        produced += 1;
        return {
          output: { title: `候选 ${produced}` },
          session: { key: session.key, handle: session.handle ?? producerHandle },
        };
      },
      audit: async ({ session }) => {
        auditSessions.push({ ...session });
        return {
          output: auditSessions.length === 1 ? repairingAudit() : passingAudit(),
          session: { key: session.key, handle: session.handle ?? auditHandle },
        };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(result.output, { title: "候选 2" });
    assert.equal(producerSessions[0]?.handle, undefined);
    assert.equal(producerSessions[1]?.handle, producerHandle);
    assert.equal(auditSessions[0]?.handle, undefined);
    assert.equal(auditSessions[1]?.handle, auditHandle);
    assert.equal(producerSessions[0]?.key, producerSessions[1]?.key);
    assert.equal(auditSessions[0]?.key, auditSessions[1]?.key);
    assert.notEqual(producerSessions[0]?.key, auditSessions[0]?.key);
    assert.equal(producerRevisions[0], undefined);
    assert.deepEqual(producerRevisions[1], {
      mode: "repair-delta",
      candidateHash: (producerRevisions[1] as { candidateHash: string }).candidateHash,
      audit: {
        summary: "仍需修改",
        issues: [{ severity: "blocking", criterion: "标题具体", evidence: "仍然抽象", repairInstruction: "改成具体动作" }],
        repairInstructions: ["改成具体动作"],
      },
    });
    assert.equal("candidate" in (producerRevisions[1] as Record<string, unknown>), false);
  });

  it("fails fast on completed infrastructure errors without consuming a semantic audit round", async () => {
    let stored: unknown;
    let auditCalls = 0;
    const requestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      initialCandidate: { title: "已生成候选" },
      checkpoint: {
        key: "completed-audit-infrastructure-failure",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => {
        throw new Error("pending candidate must be reused");
      },
      audit: async ({ requestId }) => {
        requestIds.push(requestId);
        auditCalls += 1;
        if (auditCalls === 1) throw new CodexBridgeError("broker timed out", true, "completed_failure");
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    });

    await assert.rejects(execute, /独立审计暂时失败.*尚未消耗质量审计轮次/);
    assert.equal(auditCalls, 1);
    assert.equal((stored as { status?: string }).status, "failed");
    assert.equal((stored as { phaseAttempts?: { audit: number } }).phaseAttempts?.audit, 1);
    assert.deepEqual((stored as { pendingCandidate?: { candidate: unknown } }).pendingCandidate?.candidate, { title: "已生成候选" });

    const result = await execute();
    assert.deepEqual(result.output, { title: "已生成候选" });
    assert.equal(auditCalls, 2);
    assert.equal(new Set(requestIds).size, 2);
    assert.equal(result.agentLoop?.iterations.length, 1);
  });

  it("repairs invalid producer and auditor output in the same bounded role sessions", async () => {
    let stored: unknown;
    const producerOperations: Array<{ requestId: string; session: { key: string; handle?: string } }> = [];
    const auditOperations: Array<{ requestId: string; session: { key: string; handle?: string } }> = [];
    let produceCalls = 0;
    let auditCalls = 0;
    const producerRevisions: unknown[] = [];
    const auditValidationFailures: unknown[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 3,
      checkpoint: {
        key: "atomic-role-session",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async (revision, operation) => {
        producerRevisions.push(structuredClone(revision));
        producerOperations.push({
          requestId: operation.requestId,
          session: structuredClone(operation.session),
        });
        produceCalls += 1;
        return {
          output: produceCalls === 1 ? { invalid: true } : { title: "通过校验的候选" },
          session: { key: operation.session.key, handle: producerHandle },
        };
      },
      audit: async ({ requestId, session, validationFailure }) => {
        auditValidationFailures.push(structuredClone(validationFailure));
        auditOperations.push({ requestId, session: structuredClone(session) });
        auditCalls += 1;
        return {
          output: auditCalls === 1 ? { invalid: true } : passingAudit(),
          session: { key: session.key, handle: auditHandle },
        };
      },
      validate: titleCandidate,
    });

    const result = await execute();
    assert.deepEqual(result.output, { title: "通过校验的候选" });
    assert.notEqual(producerOperations[0]?.requestId, producerOperations[1]?.requestId);
    assert.equal(producerOperations[0]?.session.handle, undefined);
    assert.equal(producerOperations[1]?.session.handle, producerHandle);
    assert.deepEqual(producerRevisions[1], {
      mode: "validation-repair",
      invalidCandidate: { invalid: true },
      invalidCandidateHash: (producerRevisions[1] as { invalidCandidateHash: string }).invalidCandidateHash,
      validationError: "candidate invalid",
    });
    assert.notEqual(auditOperations[0]?.requestId, auditOperations[1]?.requestId);
    assert.equal(auditOperations[0]?.session.handle, undefined);
    assert.equal(auditOperations[1]?.session.handle, auditHandle);
    assert.deepEqual(auditValidationFailures[0], undefined);
    assert.deepEqual(auditValidationFailures[1], {
      invalidCandidate: { invalid: true },
      invalidCandidateHash: (auditValidationFailures[1] as { invalidCandidateHash: string }).invalidCandidateHash,
      validationError: "Role audit version is invalid.",
    });
    assert.deepEqual((stored as { sessions: Record<string, unknown> }).sessions, {
      produce: { key: producerOperations[1]!.session.key, handle: producerHandle },
      audit: { key: auditOperations[1]!.session.key, handle: auditHandle },
    });
  });

  it("does not spend a semantic audit round on malformed repair output", async () => {
    let produceCalls = 0;
    let auditCalls = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "导演",
      contractVersion: "director-v7",
      criteria: ["逐镜可执行"],
      maxIterations: 3,
      produce: async () => {
        produceCalls += 1;
        if (produceCalls === 2) return { output: { invalid: true } };
        return { output: { title: `候选 ${produceCalls}` } };
      },
      audit: async () => {
        auditCalls += 1;
        return { output: auditCalls < 3 ? repairingAudit() : passingAudit() };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(result.output, { title: "候选 4" });
    assert.equal(produceCalls, 4);
    assert.equal(auditCalls, 3);
    assert.equal(result.agentLoop?.iterations.length, 3);
  });

  it("records a failed checkpoint when structured output retries are exhausted and resumes it", async () => {
    let stored: unknown;
    let produceCalls = 0;
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "导演",
      contractVersion: "director-structured-failure-v1",
      criteria: ["逐镜可执行"],
      maxIterations: 3,
      checkpoint: {
        key: "structured-failure-terminal-state",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => ({
        output: ++produceCalls <= 2 ? { invalid: true } : { title: "恢复后的完整候选" },
      }),
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await assert.rejects(execute, /本轮质量审计尚未消耗/);
    assert.equal((stored as { status?: string }).status, "failed");

    const resumed = await execute();
    assert.deepEqual(resumed.output, { title: "恢复后的完整候选" });
    assert.equal(produceCalls, 3);
  });

  it("reactivates an older checkpoint that mistook malformed output for semantic exhaustion", async () => {
    let stored: unknown;
    let produceCalls = 0;
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "导演",
      contractVersion: "director-v7",
      criteria: ["逐镜可执行"],
      maxIterations: 3,
      checkpoint: {
        key: "legacy-malformed-exhaustion",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => {
        produceCalls += 1;
        if (produceCalls <= 2) return { output: { invalid: true } };
        assert.equal((stored as { status?: string }).status, "running");
        return { output: { title: "恢复后的完整候选" } };
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    });

    await assert.rejects(execute, /本轮质量审计尚未消耗/);
    (stored as { status: string }).status = "exhausted";

    const resumed = await execute();
    assert.deepEqual(resumed.output, { title: "恢复后的完整候选" });
    assert.equal(resumed.agentLoop?.iterations.length, 1);
  });

  it("migrates an interrupted v3 checkpoint without repeating its completed candidate", async () => {
    let produceCalls = 0;
    let stored: unknown = {
      version: "video-factory/agent-loop-checkpoint-v3",
      key: "legacy-run:script",
      contractDigest: "placeholder",
      role: "编剧",
      maxIterations: 1,
      cycle: 0,
      status: "running",
      completed: [],
      pendingCandidate: { iteration: 1, candidate: { title: "旧检查点候选" } },
      operationGenerations: {},
      failedOperationRequestIds: {},
      attemptedRequestIds: [],
    };
    const baseOptions = {
      role: "编剧",
      contractVersion: "screenwriter-v1",
      criteria: ["标题具体"],
      maxIterations: 1,
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "不应重新生成" } };
      },
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    };
    // Digest 由合同生成；先用一次空 checkpoint 取出稳定值，模拟真实旧文件。
    let seeded: unknown;
    await runRoleAgentLoop({
      ...baseOptions,
      initialCandidate: { title: "seed" },
      checkpoint: {
        key: "legacy-run:script",
        load: async () => undefined,
        save: async (value) => { seeded = structuredClone(value); },
      },
    });
    (stored as { contractDigest: string }).contractDigest = (seeded as { contractDigest: string }).contractDigest;

    const result = await runRoleAgentLoop({
      ...baseOptions,
      checkpoint: {
        key: "legacy-run:script",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
    });

    assert.deepEqual(result.output, { title: "旧检查点候选" });
    assert.equal(produceCalls, 0);
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v9");
  });

  it("migrates v5 checkpoints so historical infrastructure failures do not exhaust semantic rounds", async () => {
    let stored: unknown;
    const seedOptions = {
      role: "导演",
      contractVersion: "director-v7",
      criteria: ["逐镜可执行"],
      maxIterations: 3,
      initialCandidate: { title: "保留的导演候选" },
      produce: async () => ({ output: { title: "不应重做" } }),
      audit: async () => ({ output: passingAudit() }),
      validate: titleCandidate,
    };
    await runRoleAgentLoop({
      ...seedOptions,
      checkpoint: {
        key: "director-v5-timeout",
        load: async () => undefined,
        save: async (value) => { stored = structuredClone(value); },
      },
    });
    const legacy = structuredClone(stored) as Record<string, unknown>;
    legacy.version = "video-factory/agent-loop-checkpoint-v5";
    legacy.status = "running";
    legacy.completed = [];
    legacy.pendingCandidate = { iteration: 1, candidate: { title: "保留的导演候选" } };
    legacy.phaseAttempts = { produce: 0, audit: 3 };
    stored = legacy;

    const result = await runRoleAgentLoop({
      ...seedOptions,
      checkpoint: {
        key: "director-v5-timeout",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
    });

    assert.deepEqual(result.output, { title: "保留的导演候选" });
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v9");
  });

  it("audits an existing human candidate before asking the producer to repair it", async () => {
    let produceCalls = 0;
    let auditCalls = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "系列总编",
      contractVersion: "episode-greenlight-v1",
      criteria: ["遵守最新正史"],
      maxIterations: 3,
      initialCandidate: { title: "人工确认的标题" },
      produce: async (revision) => {
        produceCalls += 1;
        assert.equal(revision?.mode, "repair-bootstrap");
        return { output: { title: `${revision.mode === "repair-bootstrap" ? revision.candidate.title : "未知"}（修订）` } };
      },
      audit: async () => {
        auditCalls += 1;
        return { output: passingAudit(REPORT_AUDIT_DIMENSIONS) };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(result.output, { title: "人工确认的标题" });
    assert.equal(produceCalls, 0);
    assert.equal(auditCalls, 1);
    assert.equal(result.agentLoop?.iterations.length, 1);
  });

  it("stops on an audit-declared source gap with the candidate preserved and replays without new calls", async () => {
    let stored: unknown;
    let produceCalls = 0;
    let auditCalls = 0;
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "编剧",
      planningRole: true,
      contractVersion: "screenwriter-planning-disposition-v1",
      criteria: ["真实实验承诺必须有来源"],
      maxIterations: 3,
      checkpoint: {
        key: "planning-needs-source",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "展示真实实验结果" } };
      },
      audit: async () => {
        auditCalls += 1;
        return { output: {
          version: "video-factory/role-audit-v2",
          rubricVersion: "video-factory/role-quality-rubric-v1",
          verdict: "repair",
          score: 55,
          assessments: auditAssessments(CREATIVE_AUDIT_DIMENSIONS, 55),
          summary: "缺少实验记录",
          issues: [{
            severity: "blocking",
            criterion: "事实来源",
            evidence: "当前输入没有受控实验记录或采集能力",
            repairInstruction: "补充真实记录，或由用户确认改变承诺",
          }],
          repairInstructions: ["补充真实记录"],
          planningDisposition: { action: "needs_source", issueIndexes: [0] },
        } };
      },
      validate: titleCandidate,
    });

    // 来源缺口不再拦下整条制作：候选与那一轮独立审计原样留在 checkpoint，循环按"等创作者裁决"
    // 收口，缺口由调用方从 iterations[].audit.planningDisposition 取出，作为建议标签继续传递。
    const result = await execute();
    assert.equal(result.agentLoop?.status, "awaiting_user");
    assert.deepEqual(result.output, { title: "展示真实实验结果" });
    assert.equal(result.agentLoop?.iterations.length, 1);
    const disposition = result.agentLoop?.iterations[0]?.audit.planningDisposition;
    assert.equal(disposition?.action, "needs_source");
    assert.equal(result.agentLoop?.modelCallCount, 2);
    assert.equal(result.agentLoop?.producerModelCallCount, 1);
    assert.equal(result.agentLoop?.auditModelCallCount, 1);
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 1);
    const replayed = await execute();
    assert.equal(replayed.agentLoop?.status, "awaiting_user");
    assert.equal(produceCalls, 1, "restart must not create another producer task for the same unresolved input");
    assert.equal(auditCalls, 1, "restart must replay the persisted result without another audit");
  });

  it("delivers a passing candidate with the host source gap kept as advice and replays without new calls", async () => {
    let stored: unknown;
    let produceCalls = 0;
    let auditCalls = 0;
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "导演前期构思",
      planningRole: true,
      contractVersion: "creative-treatment-v2",
      criteria: ["构思质量与制作前提分别核对"],
      maxIterations: 3,
      checkpoint: {
        key: "host-needs-source",
        load: async () => stored,
        save: async (value) => { stored = structuredClone(value); },
      },
      assessPlanningReadiness: () => ({
        status: "needs_source",
        issues: [{
          id: "missing-private-record",
          target: "source",
          beatIds: ["evidence"],
          scenePositions: [],
          reason: "用户要求展示专属真实记录，但当前没有绑定材料。",
          requiredChange: "上传真实记录，或明确改为不声称实证的示意表达。",
          evidenceArtifactIds: [],
        }],
      }),
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "构思本身完整" } };
      },
      audit: async ({ hostReadiness }) => {
        auditCalls += 1;
        assert.equal(hostReadiness?.status, "needs_source");
        return { output: { ...passingAudit(), planningDisposition: null } };
      },
      validate: titleCandidate,
    });

    // 宿主门槛只出建议，没有权力拦下制作：独立审计已判 pass，这里就带着来源建议照常交付，
    // 缺口留在 iterations[].hostReadiness 里，由调用方转成创作者能看到的建议标签。
    const result = await execute();
    assert.equal(result.agentLoop?.status, "passed");
    assert.deepEqual(result.output, { title: "构思本身完整" });
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 1);
    assert.equal(result.agentLoop?.iterations[0]?.audit.verdict, "pass");
    assert.equal(result.agentLoop?.iterations[0]?.hostReadiness?.status, "needs_source");
    const replayed = await execute();
    assert.equal(replayed.agentLoop?.status, "passed");
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 1);
  });

  it("requires explicit and valid planning dispositions only for planning roles", () => {
    assert.throws(
      () => validateRoleAudit(passingAudit(), { planningRole: true }),
      /must set planningDisposition to null/,
    );
    assert.deepEqual(
      validateRoleAudit({ ...passingAudit(), planningDisposition: null }, { planningRole: true }).planningDisposition,
      null,
    );
    assert.throws(
      () => validateRoleAudit({ ...repairingAudit(), planningDisposition: { action: "needs_source", issueIndexes: [1] } }, { planningRole: true }),
      /does not identify an existing issue/,
    );
    assert.throws(
      () => validateRoleAudit({ ...repairingAudit(), planningDisposition: { action: "needs_source", issueIndexes: [0] } }),
      /Non-planning role audits cannot route/,
    );
    // 非规划角色的审计 payload 里没有字段说明它是不是规划角色，模型只能顺着 repair 语境填一个
    // revise_here。它的语义与 verdict: repair 完全重合、不含越权路由，所以不该作废整轮审计——
    // 实测 deepseek-flash 在选题总编上就这么填了一次，代价是一整轮五分钟的审计被丢掉重跑。
    assert.equal(
      validateRoleAudit({ ...repairingAudit(), planningDisposition: { action: "revise_here", issueIndexes: [0] } }).planningDisposition,
      null,
    );
  });

  it("lets an independent audit send a misclassified source issue back to the same role without bypassing revalidation", async () => {
    let produceCalls = 0;
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "导演前期构思",
      contractVersion: "treatment-host-correction-v1",
      criteria: ["示意路线符合当前能力"],
      planningRole: true,
      maxIterations: 2,
      produce: async (revision) => {
        produceCalls += 1;
        assert.equal(produceCalls === 1 ? revision : undefined, undefined);
        if (produceCalls === 2) {
          assert.match(JSON.stringify(revision), /改用已允许的生成路线/);
          assert.doesNotMatch(JSON.stringify(revision), /上传专属真实材料/);
        }
        return { output: { title: produceCalls === 1 ? "误选图库" : "改用生成" } };
      },
      assessPlanningReadiness: (candidate) => candidate.title === "误选图库"
        ? {
          status: "needs_source",
          issues: [{
            id: "route-1",
            target: "source",
            beatIds: ["beat-1"],
            scenePositions: [],
            reason: "纯示意被候选错误标成必须补图库来源。",
            requiredChange: "请用户上传专属真实材料。",
            evidenceArtifactIds: [],
          }],
        }
        : { status: "ready", issues: [] },
      audit: async ({ iteration }) => ({ output: iteration === 1 ? {
        ...repairingAudit(),
        issues: [{
          severity: "blocking" as const,
          criterion: "示意路线",
          evidence: "这不是事实取证镜头。",
          repairInstruction: "改用已允许的生成路线。",
        }],
        repairInstructions: ["改用已允许的生成路线。"],
        planningDisposition: { action: "revise_here", issueIndexes: [0] },
        hostReadinessReview: { misclassifiedIssueIds: ["route-1"] },
      } : { ...passingAudit(), planningDisposition: null } }),
      validate: titleCandidate,
    });

    assert.equal(result.output.title, "改用生成");
    assert.equal(produceCalls, 2);
    assert.equal(result.agentLoop?.iterations[0]?.hostReadiness?.status, "needs_source");
    assert.deepEqual(result.agentLoop?.iterations[0]?.audit.hostReadinessReview?.misclassifiedIssueIds, ["route-1"]);
  });

  it("does not let a partial or unknown host correction hide a real source blocker", async () => {
    const readiness = {
      status: "needs_source" as const,
      issues: ["source-1", "source-2"].map((id) => ({
        id,
        target: "source" as const,
        beatIds: ["beat-1"],
        scenePositions: [],
        reason: `${id} 仍缺用户专属事实材料。`,
        requiredChange: "补齐真实来源。",
        evidenceArtifactIds: [],
      })),
    };
    const result = await runRoleAgentLoop<{ title: string }>({
      role: "导演前期构思",
      contractVersion: "treatment-host-partial-v1",
      criteria: ["真实来源完整"],
      planningRole: true,
      maxIterations: 2,
      produce: async () => ({ output: { title: "仍需实证" } }),
      assessPlanningReadiness: () => readiness,
      audit: async () => ({ output: {
        ...repairingAudit(),
        planningDisposition: { action: "revise_here", issueIndexes: [0] },
        hostReadinessReview: { misclassifiedIssueIds: ["source-1"] },
      } }),
      validate: titleCandidate,
    });
    // 只纠正了一半不算纠正：未被审计认领的 source-2 必须原样留在建议里，不能被一次局部更正
    // 悄悄抹掉——它现在只是不再拦下这条制作，作为标签该在的还在。
    assert.equal(result.agentLoop?.status, "awaiting_user");
    const hostReadiness = result.agentLoop?.iterations[0]?.hostReadiness;
    assert.equal(hostReadiness?.status, "needs_source");
    assert.deepEqual(hostReadiness?.issues.map((issue) => issue.id), ["source-1", "source-2"]);
    assert.throws(() => validateRoleAudit({
      ...repairingAudit(),
      planningDisposition: { action: "revise_here", issueIndexes: [0] },
      hostReadinessReview: { misclassifiedIssueIds: ["not-present"] },
    }, { planningRole: true, hostReadiness: readiness }), /unknown host issue/);
  });

  it("can persist a validated draft without running its independent audit", async () => {
    let saved: unknown;
    let produceCalls = 0;
    let auditCalls = 0;
    const checkpoint = {
      key: "draft-before-confirmation",
      load: async () => saved,
      save: async (value: unknown) => { saved = structuredClone(value); },
    };
    const options = {
      role: "导演前期构思",
      contractVersion: "draft-before-confirmation-v1",
      criteria: ["当前草稿可在确认时独立检查"],
      maxIterations: 1,
      deferAudit: true,
      checkpoint,
      produce: async () => {
        produceCalls += 1;
        return { output: { title: "等待用户讨论的初稿" } };
      },
      audit: async () => {
        auditCalls += 1;
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    };

    const first = await runRoleAgentLoop(options);
    const restored = await runRoleAgentLoop(options);

    assert.equal(first.output.title, "等待用户讨论的初稿");
    assert.equal(restored.output.title, first.output.title);
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 0);
    assert.equal((saved as { pendingCandidate?: unknown }).pendingCandidate !== undefined, true);
  });

  // 审片候选由外部证据校验（报告绑定产出当时那批证据帧），而证据快照不在 contractDigest 里。
  // 证据被重新生成后旧结论不再成立：恢复时必须重跑这一轮，不能回放旧结论，
  // 也不能把校验错误当成本轮结果抛给上层去冒充服务故障。
  function evidenceBoundLoop() {
    let saved: unknown;
    let evidence = "旧证据帧";
    let produceCalls = 0;
    let auditCalls = 0;
    const produceRequestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "视觉审片员",
      contractVersion: "visual-review-evidence",
      criteria: ["每条问题必须由对应时间码的画面证据支持"],
      maxIterations: 1,
      checkpoint: {
        key: "evidence-bound-candidate",
        load: async () => saved,
        save: async (value: unknown) => { saved = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        produceCalls += 1;
        produceRequestIds.push(operation.requestId);
        return { output: { title: `审片结论-${evidence}` } };
      },
      audit: async () => {
        auditCalls += 1;
        return { output: passingAudit(REPORT_AUDIT_DIMENSIONS) };
      },
      validate: (value) => {
        const candidate = titleCandidate(value);
        if (candidate.title !== `审片结论-${evidence}`) {
          throw new Error("Visual review finding evidence frame is invalid.");
        }
        return candidate;
      },
    });
    return {
      execute,
      useNewEvidence: () => { evidence = "新证据帧"; },
      stored: () => saved as Record<string, unknown>,
      counts: () => ({ produceCalls, auditCalls }),
      produceRequestIds: () => [...produceRequestIds],
    };
  }

  it("re-runs a restored candidate whose evidence was regenerated instead of replaying it", async () => {
    const loop = evidenceBoundLoop();
    const first = await loop.execute();
    assert.equal(first.output.title, "审片结论-旧证据帧");
    assert.equal(loop.counts().produceCalls, 1);

    loop.useNewEvidence();
    const second = await loop.execute();
    assert.equal(second.output.title, "审片结论-新证据帧");
    assert.deepEqual(loop.counts(), { produceCalls: 2, auditCalls: 2 });
    assert.equal(second.agentLoop?.status, "passed");
    // 重跑要开新 cycle，物理请求身份必须随之改变，否则会与已结清的历史任务撞身份。
    assert.equal(loop.stored().cycle, 1);
    const [firstRequestId, secondRequestId] = loop.produceRequestIds();
    assert.notEqual(secondRequestId, firstRequestId);
  });

  it("keeps an accepted pending operation instead of restarting past it", async () => {
    const loop = evidenceBoundLoop();
    await loop.execute();
    loop.useNewEvidence();
    const stored = loop.stored();
    stored.pendingOperation = {
      phase: "audit",
      iteration: 2,
      operationKey: "0:2:audit",
      generation: 0,
      contractDigest: stored.contractDigest,
      operation: {
        version: "video-factory/codex-prepared-operation-v1",
        requestId: "agent-pending-audit",
        kind: "role-audit",
        envelope: { requestId: "agent-pending-audit", kind: "role-audit", payload: {} },
        serializedEnvelope: '{"payload":{}}',
        binding: {},
        brokerBinding: {},
        route: { socketPath: "/tmp/not-connected.sock" },
      },
    };

    await assert.rejects(loop.execute(), /Visual review finding evidence frame is invalid\./);
    assert.equal(loop.counts().produceCalls, 1);
  });

  it("issues a new request identity after the broker reports an identity conflict", async () => {
    let saved: unknown;
    let conflicted = true;
    const requestIds: string[] = [];
    const execute = () => runRoleAgentLoop<{ title: string }>({
      role: "视觉审片员",
      contractVersion: "identity-conflict",
      criteria: ["同一身份冲突不得让后续重试永久撞同一条记录"],
      maxIterations: 1,
      checkpoint: {
        key: "identity-conflict",
        load: async () => saved,
        save: async (value: unknown) => { saved = structuredClone(value); },
      },
      produce: async (_revision, operation) => {
        requestIds.push(operation.requestId);
        if (conflicted) {
          throw new CodexBridgeError(
            "Codex requestId is already bound to different task data.",
            false,
            "conflict",
            409,
            "binding_conflict",
          );
        }
        return { output: { title: "重跑后的审片结论" } };
      },
      audit: async () => ({ output: passingAudit(REPORT_AUDIT_DIMENSIONS) }),
      validate: titleCandidate,
    });

    await assert.rejects(execute(), (error: unknown) => {
      assert.ok(error instanceof RoleAgentLoopError);
      assert.match(error.message, /请求身份与已有任务记录冲突/);
      assert.ok(error.sourceError instanceof CodexBridgeError);
      assert.equal(error.sourceError.failureKind, "binding_conflict");
      return true;
    });
    conflicted = false;
    const result = await execute();
    assert.equal(result.output.title, "重跑后的审片结论");
    assert.equal(requestIds.length, 2);
    assert.notEqual(requestIds[1], requestIds[0]);
  });
});

function titleCandidate(value: unknown): { title: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || typeof (value as { title?: unknown }).title !== "string") {
    throw new Error("candidate invalid");
  }
  return { title: (value as { title: string }).title };
}

function preparedOperation(
  operation: { requestId: string },
  kind: "script-draft" | "role-audit",
) {
  return {
    version: "video-factory/codex-prepared-operation-v1" as const,
    requestId: operation.requestId,
    kind,
    envelope: { payload: { contract: "current" } },
    serializedEnvelope: '{"payload":{"contract":"current"}}',
    binding: { requestDigest: "f".repeat(64) } as never,
    brokerBinding: {} as never,
    route: { socketPath: "/tmp/not-connected.sock" },
    taskFact: "accepted_unknown" as const,
  };
}

const CREATIVE_AUDIT_DIMENSIONS = ["attention", "progression", "payoff", "expression"] as const;
const REPORT_AUDIT_DIMENSIONS = ["evidence", "coverage", "consistency", "actionability"] as const;

// 宿主按角色决定维度集合，审计必须按同一版本标准给每个维度分；这里让全部分数相等，
// 好让各用例原本断言的 score 保持成立（score 归约成最低维度分）。
function auditAssessments(dimensions: readonly string[], score: number) {
  return [{
    targetPath: "",
    dimensions: dimensions.map((dimension) => ({ dimension, score, evidence: "本轮维度依据已核对。" })),
  }];
}

function passingAudit(dimensions: readonly string[] = CREATIVE_AUDIT_DIMENSIONS) {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    verdict: "pass",
    score: 92,
    assessments: auditAssessments(dimensions, 92),
    summary: "可以进入下游",
    issues: [],
    repairInstructions: [],
    hostReadinessReview: null,
  } as const;
}

function repairingAudit(dimensions: readonly string[] = CREATIVE_AUDIT_DIMENSIONS) {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    verdict: "repair",
    score: 60,
    assessments: auditAssessments(dimensions, 60),
    summary: "仍需修改",
    issues: [{ severity: "blocking", criterion: "标题具体", evidence: "仍然抽象", repairInstruction: "改成具体动作" }],
    repairInstructions: ["改成具体动作"],
    hostReadinessReview: null,
  } as const;
}
