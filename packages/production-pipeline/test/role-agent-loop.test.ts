import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeError, RoleAgentLoopError, runRoleAgentLoop, validateRoleAudit } from "../src/index.js";

describe("role agent loop audit boundary", () => {
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
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 79,
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
            version: "video-factory/role-audit-v1",
            verdict: "pass",
            score: 92,
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

  it("keeps an exhausted checkpoint terminal until the caller supplies a new key", async () => {
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

    await assert.rejects(execute, /仍未通过独立审计/);
    assert.equal(produceCalls, 3);
    assert.equal(auditCalls, 3);

    await assert.rejects(execute, /仍未通过独立审计/);
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
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v8");
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
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v8");
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
        return { output: passingAudit() };
      },
      validate: titleCandidate,
    });

    assert.deepEqual(result.output, { title: "人工确认的标题" });
    assert.equal(produceCalls, 0);
    assert.equal(auditCalls, 1);
    assert.equal(result.agentLoop?.iterations.length, 1);
  });

  it("persists a planning source halt before another producer call and replays it after restart", async () => {
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
          version: "video-factory/role-audit-v1",
          verdict: "repair",
          score: 55,
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

    let haltFailure: unknown;
    await assert.rejects(execute, (error: unknown) => {
      haltFailure = error;
      return error instanceof Error
        && error.name === "RoleAgentPlanningHaltError"
        && /尚未具备的来源/.test(error.message);
    });
    assert.equal(haltFailure instanceof RoleAgentLoopError ? haltFailure.agentLoop.modelCallCount : -1, 2);
    assert.equal(haltFailure instanceof RoleAgentLoopError ? haltFailure.agentLoop.producerModelCallCount : -1, 1);
    assert.equal(haltFailure instanceof RoleAgentLoopError ? haltFailure.agentLoop.auditModelCallCount : -1, 1);
    assert.equal(produceCalls, 1);
    assert.equal(auditCalls, 1);
    await assert.rejects(execute, (error: unknown) => error instanceof Error && error.name === "RoleAgentPlanningHaltError");
    assert.equal(produceCalls, 1, "restart must not create another producer task for the same unresolved input");
    assert.equal(auditCalls, 1, "restart must replay the persisted halt without another audit");
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

function passingAudit() {
  return {
    version: "video-factory/role-audit-v1",
    verdict: "pass",
    score: 92,
    summary: "可以进入下游",
    issues: [],
    repairInstructions: [],
  } as const;
}

function repairingAudit() {
  return {
    version: "video-factory/role-audit-v1",
    verdict: "repair",
    score: 60,
    summary: "仍需修改",
    issues: [{ severity: "blocking", criterion: "标题具体", evidence: "仍然抽象", repairInstruction: "改成具体动作" }],
    repairInstructions: ["改成具体动作"],
  } as const;
}
