import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { RoleAgentHostStop, runRoleAgentLoop, type RoleAgentOperation } from "../src/role-agent-loop.js";
import { fileRoleAgentLoopCheckpoint } from "../src/role-agent-checkpoint.js";
import { summarizeJointPlanningExecution } from "../src/production-pipeline.js";
import type { CodexTaskExecution, CodexTaskKind } from "../src/codex-chat.js";

const audit = {
  version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
  verdict: "pass", score: 92, summary: "核验通过", issues: [], repairInstructions: [],
  assessments: [{ targetPath: "", dimensions: ["evidence", "coverage", "consistency", "actionability"]
    .map(dimension => ({ dimension, score: 92, evidence: "已核对本轮证据" })) }],
};

it("retains structured repair ownership and unallocated timing across owner changes and nested primary checkpoints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-repair-ownership-"));
  const pathname = path.join(root, "r", "nodes", "creative-planning", "agent-loop-checkpoints", "rank.json");
  let calls = 0;
  let observations = 0;
  let clock = 0;
  const owner = (workflowOperationRequestId: string) => ({ runId: "r", nodeId: "creative-planning", workflowOperationRequestId });
  const checkpoint = (id: string) => fileRoleAgentLoopCheckpoint(pathname, "key", { recoveryOwner: owner(id), recoverPendingOwner: owner("A") });
  const run = (id: string) => runRoleAgentLoop({ role: "候选画面复核", contractVersion: "v1", criteria: ["合法结构"], maxIterations: 3, now: () => ++clock,
    checkpoint: checkpoint(id), validate: value => { if (!(value as { ok?: boolean }).ok) throw new Error("invalid"); return value; },
    produce: async (_revision, op) => {
      if (op.preparedOperation) { observations++; return { output: { ok: true } }; }
      calls++;
      await op.requestOptions.beforeSubmit?.({ version: "video-factory/codex-prepared-operation-v1", requestId: op.requestId, kind: "asset-rank",
        envelope: { requestId: op.requestId, kind: "asset-rank", payload: {}, session: op.session }, serializedEnvelope: "{}",
        binding: {} as never, brokerBinding: {} as never, route: { socketPath: "/tmp/unused.sock" }, taskFact: "accepted_unknown" });
      if (calls === 2) throw new Error("accepted repair interrupted");
      return { output: {} };
    }, audit: async op => {
      calls++;
      await op.requestOptions.beforeSubmit?.({ version: "video-factory/codex-prepared-operation-v1", requestId: op.requestId, kind: "role-audit",
        envelope: { requestId: op.requestId, kind: "role-audit", payload: {}, session: op.session }, serializedEnvelope: "{}",
        binding: {} as never, brokerBinding: {} as never, route: { socketPath: "/tmp/unused.sock" }, taskFact: "accepted_unknown" });
      return { output: audit };
    },
  });
  try {
    await assert.rejects(run("A"), /accepted repair interrupted/);
    await run("B");
    await run("B");
    assert.equal(calls, 3);
    assert.equal(observations, 1);
    const verify = async () => {
      const summary = await summarizeJointPlanningExecution(root, "r", "B");
      assert.equal(summary?.modelCallCount, 1);
      assert.equal(summary?.previousModelCallCount, 2);
      assert.equal(summary?.structuredRepairModelCallCount, 0);
      assert.equal(summary?.previousStructuredRepairModelCallCount, 1);
      assert.ok(Number(summary?.unattributedProducerMs) > 0);
      return summary;
    };
    const first = await verify();
    const state = await checkpoint("B").load() as Record<string, unknown>;
    await checkpoint("B").save({ ...state, attemptedRequestIds: [], requestPhases: {}, requestOwners: {}, completed: [],
      phaseAttempts: { produce: 0, audit: 0 }, phaseDurationsMs: { produce: 0, audit: 0 }, validationMs: 0, structuredRepairModelCallCount: 0,
      assetRankBatch: { version: "asset-rank-batches-v1", phase: "supplement", primaryCheckpoint: state },
    });
    assert.deepEqual(await verify(), first);
    const legacy = { ...state, structuredRepairRequestIds: [] };
    await checkpoint("B").save(legacy);
    const legacySummary = await summarizeJointPlanningExecution(root, "r", "B");
    assert.equal(legacySummary?.unattributedStructuredRepairModelCallCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports unmappable owned legacy requests as unknown instead of silently losing them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-legacy-accounting-"));
  try {
    const checkpoint = fileRoleAgentLoopCheckpoint(path.join(root, "r", "nodes", "creative-planning", "agent-loop-checkpoints", "legacy.json"), "migrated", {
      recoveryOwner: { runId: "r", nodeId: "creative-planning", workflowOperationRequestId: "new" },
    });
    await checkpoint.save({ version: "video-factory/agent-loop-checkpoint-v9", key: "migrated", contractDigest: "new", cycle: 1,
      maxIterations: 3, operationGenerations: {}, attemptedRequestIds: ["old-unmappable"], requestOwners: { "old-unmappable": "old" },
      phaseAttempts: { produce: 1, audit: 0 },
    });
    const result = await summarizeJointPlanningExecution(root, "r", "new");
    assert.equal(result?.modelCallCount, 0);
    assert.equal(result?.previousUnknownModelExecutionCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const reason of ["paused", "deadline", "payload_limit"] as const) {
  it(`preserves prior physical structured repair counts when recovery is stopped by ${reason}`, async () => {
    let saved: unknown;
    let stopped = false;
    let calls = 0;
    const checkpoint = { key: "repair-stop", load: async () => saved, save: async (value: unknown) => { saved = structuredClone(value); } };
    const run = () => runRoleAgentLoop({ role: "候选画面复核", contractVersion: "v1", criteria: ["正确结构"], maxIterations: 3, checkpoint,
      produce: async () => { if (stopped) throw new RoleAgentHostStop(reason, "host stop"); calls++; return { output: {} }; },
      audit: async () => ({ output: audit }), validate: () => { throw new Error("invalid candidate"); },
    });
    await assert.rejects(run(), /连续两次/);
    assert.equal(calls, 2);
    assert.equal((saved as { structuredRepairModelCallCount: number }).structuredRepairModelCallCount, 1);
    stopped = true;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(run(), /host stop/);
      assert.equal(calls, 2);
      assert.equal((saved as { structuredRepairModelCallCount: number }).structuredRepairModelCallCount, 1);
      assert.equal((saved as { phaseAttempts: { produce: number } }).phaseAttempts.produce, 2);
    }
  });
}

it("recovers a settled checkpoint if migration to the new path fails, including a changed workflow owner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-checkpoint-migration-"));
  const oldPath = path.join(directory, "old.json");
  const newPath = path.join(directory, "new.json");
  const owner = { runId: "r", nodeId: "n", workflowOperationRequestId: "old-operation" };
  const currentOwner = { ...owner, workflowOperationRequestId: "new-operation" };
  try {
    const old = fileRoleAgentLoopCheckpoint(oldPath, "old", { recoveryOwner: owner });
    await old.save({ version: "video-factory/agent-loop-checkpoint-v9", key: "old", pendingOperation: { requestId: "accepted" } });
    const create = () => fileRoleAgentLoopCheckpoint(newPath, "new", { recoveryOwner: currentOwner, recoverPendingOwner: owner });
    const recovered = create();
    const pending = await recovered.load();
    await recovered.save(pending);
    assert.ok((await create().load() as { pendingOperation?: unknown })?.pendingOperation, "saving under a new execution owner must not hide the old pending request");
    await fs.mkdir(newPath);
    const settled = { version: "video-factory/agent-loop-checkpoint-v9", key: "new", pendingCandidate: { output: "preserved" } };
    await assert.rejects(recovered.save(settled), { code: "EISDIR" });
    await fs.rmdir(newPath);
    const restarted = create();
    assert.equal((await restarted.load() as { pendingCandidate: { output: string } }).pendingCandidate.output, "preserved");
    await restarted.save(settled);
    assert.equal((await create().load() as { pendingCandidate: { output: string } }).pendingCandidate.output, "preserved");
    await assert.rejects(fs.stat(oldPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const phase of ["produce", "audit"] as const) {
  for (const change of ["contract", "key"] as const) {
    it(`accepts the original ${phase} session after ${change} changes without resubmission`, async () => {
      const runsRoot = await mkdtemp(path.join(tmpdir(), "vf-session-recovery-"));
      const directory = path.join(runsRoot, "run-recovery", "nodes", "creative-planning", "agent-loop-checkpoints");
      try {
        const submitted: string[] = [];
        const observed: string[] = [];
        let interrupt = true;
        let interruptObservation = true;
        const execute = async (kind: CodexTaskKind, op: RoleAgentOperation): Promise<CodexTaskExecution> => {
          if (op.preparedOperation) {
            observed.push(op.preparedOperation.requestId);
            if (interruptObservation) { interruptObservation = false; throw new Error("observation still unknown"); }
            return { output: kind === "role-audit" ? audit : { title: "保留候选" },
              session: { ...(op.preparedOperation.envelope.session as { key: string }), handle: `vfs_${"a".repeat(32)}` } };
          }
          submitted.push(op.requestId);
          const envelope = { protocolVersion: "video-factory/codex-bridge-v2", requestId: op.requestId,
            kind, payload: {}, session: op.session };
          await op.requestOptions.beforeSubmit?.({ version: "video-factory/codex-prepared-operation-v1",
            requestId: op.requestId, kind, envelope, serializedEnvelope: JSON.stringify(envelope),
            binding: {} as never, brokerBinding: {} as never, route: { socketPath: "/tmp/unused.sock" }, taskFact: "accepted_unknown" });
          if (interrupt && (kind === "role-audit") === (phase === "audit")) {
            interrupt = false;
            throw new Error("accepted response interrupted");
          }
          return { output: kind === "role-audit" ? audit : { title: "保留候选" },
            session: { ...op.session, handle: `vfs_${"a".repeat(32)}` } };
        };
        const run = (changed: boolean) => runRoleAgentLoop<{ title: string }>({
          role: "候选画面复核", contractVersion: changed && change === "contract" ? "new" : "old",
          criteria: ["可验证"], maxIterations: 1,
          checkpoint: fileRoleAgentLoopCheckpoint(path.join(directory, changed && change === "key" ? "new.json" : "old.json"), changed && change === "key" ? "new-key" : "old-key", {
            recoverPendingOwner: { runId: "run-recovery", nodeId: "creative-planning", workflowOperationRequestId: "old-owner" },
            recoveryOwner: { runId: "run-recovery", nodeId: "creative-planning", workflowOperationRequestId: changed ? "new-owner" : "old-owner" },
          }),
          produce: (_revision, op) => execute("asset-rank", op),
          audit: op => execute("role-audit", op),
          validate: value => value as { title: string },
        });
        await assert.rejects(run(false), /accepted response interrupted/);
        const originalId = submitted.at(-1);
        await assert.rejects(run(true), /observation still unknown/);
        const result = await run(true);
        assert.equal(result.output.title, "保留候选");
        assert.deepEqual(observed, [originalId, originalId]);
        assert.equal(new Set(submitted).size, submitted.length);
        assert.equal(submitted.length, phase === "audit" && change === "contract" ? 3 : 2);
        const callsAfterRecovery = submitted.length;
        assert.deepEqual((await run(true)).output, result.output);
        assert.equal(submitted.length, callsAfterRecovery, "replaying the migrated completed checkpoint must not recreate the producer");
        assert.equal(observed.length, 2, "the old file must not retain a pending request after migration");
        const summary = await summarizeJointPlanningExecution(runsRoot, "run-recovery", "new-owner");
        const oldCalls = phase === "produce" ? 1 : 2;
        assert.equal(summary?.previousModelCallCount, oldCalls);
        assert.equal(summary?.modelCallCount, submitted.length - oldCalls);
      } finally {
        await rm(runsRoot, { recursive: true, force: true });
      }
    });
  }
}

it("still rejects an unrelated session on a recovered request", async () => {
  let saved: unknown;
  const checkpoint = { key: "wrong-session", load: async () => saved, save: async (value: unknown) => { saved = structuredClone(value); } };
  const execute = () => runRoleAgentLoop({ role: "候选画面复核", contractVersion: "v1", criteria: ["证据"], maxIterations: 1,
    checkpoint, validate: value => value,
    produce: async (_revision, op) => {
      if (op.preparedOperation) return { output: {}, session: { key: "unrelated" } };
      const envelope = { session: op.session };
      await op.requestOptions.beforeSubmit?.({ version: "video-factory/codex-prepared-operation-v1",
        requestId: op.requestId, kind: "asset-rank", envelope, serializedEnvelope: JSON.stringify(envelope),
        binding: {} as never, brokerBinding: {} as never, route: { socketPath: "/tmp/unused.sock" }, taskFact: "accepted_unknown" });
      throw new Error("interrupted");
    }, audit: async () => ({ output: audit }),
  });
  await assert.rejects(execute, /interrupted/);
  await assert.rejects(execute, /mismatched task session key/);
});
