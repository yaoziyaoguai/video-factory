import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeError, runRoleAgentLoop, validateRoleAudit } from "../src/index.js";

describe("role agent loop audit boundary", () => {
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
      criteria: ["标题具体"],
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
        return { output: { title: `${revision?.candidate.title}（修订）` } };
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
