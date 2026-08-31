import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeError, runRoleAgentLoop, validateRoleAudit } from "../src/index.js";

describe("role agent loop audit boundary", () => {
  const producerHandle = `vfs_${"p".repeat(32)}`;
  const auditHandle = `vfs_${"a".repeat(32)}`;
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

    await assert.rejects(execute, /outcome is uncertain/);
    await assert.rejects(execute, /outcome is uncertain/);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
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

    await assert.rejects(execute, /did not pass/);
    assert.equal(produceCalls, 3);
    assert.equal(auditCalls, 3);

    await assert.rejects(execute, /did not pass/);
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

    await assert.rejects(execute, /审计基础设施失败.*尚未消耗语义审计轮次/);
    assert.equal(auditCalls, 1);
    assert.equal((stored as { status?: string }).status, "running");
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
      produce: async (_revision, operation) => {
        producerOperations.push(structuredClone(operation));
        produceCalls += 1;
        return {
          output: produceCalls === 1 ? { invalid: true } : { title: "通过校验的候选" },
          session: { key: operation.session.key, handle: producerHandle },
        };
      },
      audit: async ({ requestId, session }) => {
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
    assert.notEqual(auditOperations[0]?.requestId, auditOperations[1]?.requestId);
    assert.equal(auditOperations[0]?.session.handle, undefined);
    assert.equal(auditOperations[1]?.session.handle, auditHandle);
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

    await assert.rejects(execute, /semantic audit round was not consumed/);
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
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v6");
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
    assert.equal((stored as { version: string }).version, "video-factory/agent-loop-checkpoint-v6");
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
});

function titleCandidate(value: unknown): { title: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || typeof (value as { title?: unknown }).title !== "string") {
    throw new Error("candidate invalid");
  }
  return { title: (value as { title: string }).title };
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
