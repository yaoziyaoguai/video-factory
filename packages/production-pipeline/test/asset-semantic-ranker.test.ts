import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileRoleAgentLoopCheckpoint } from "../src/role-agent-checkpoint.js";
import { summarizeJointPlanningExecution } from "../src/production-pipeline.js";
import {
  CodexAssetSemanticRanker,
  CodexBridgeError,
  deterministicAssetRanking,
  parseAssetCandidateReport,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexPreparedOperation,
  type CodexTaskRequestOptions,
  validateAssetSemanticRanking,
  type AssetCandidateReport,
} from "../src/index.js";

const rawReport = {
  version: "video-factory/asset-candidates-v1",
  scene_candidates: [{
    scene_position: 1,
    intent: { subject: "早餐摊", visible_action: "蒸汽上升" },
    query: "Chinese breakfast steam",
    candidates: [
      candidate("pexels", "first", 80, 1080, 1920),
      candidate("pixabay", "second", 90, 720, 1280),
    ],
  }],
};

describe("asset semantic ranking", () => {
  it("returns a settled advisory ranking without declaring its audit passed or repeating it", async () => {
    const report = parseAssetCandidateReport(rawReport);
    let saved: unknown;
    let calls = 0;
    const checkpoint = { key: "advisory-ranking", load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
    const repair = { ...passingAudit(), verdict: "repair", score: 50,
      assessments: passingAudit().assessments.map(a => ({ ...a, dimensions: a.dimensions.map(d => ({ ...d, score: 50 })) })),
      issues: [{ severity: "blocking", criterion: "说明", evidence: "不够充分", repairInstruction: "说明依据" }], repairInstructions: ["说明依据"],
    };
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), client: {
      runTask: async () => { throw new Error("use audited transport"); },
      runTaskDetailed: async kind => { calls++; return { output: kind === "role-audit" ? repair
        : { ...deterministicAssetRanking(report), source: "model", summary: `candidate ${calls}` } }; },
    } });
    const result = await ranker.rankDetailed(report, checkpoint);
    assert.notEqual(result.agentLoop?.status, "passed");
    assert.equal(result.output.visualEvidence?.reviewed.length, 0);
    assert.equal(result.output.scenes[0]!.candidates[0]!.locked, false);
    const settledCalls = calls;
    assert.deepEqual(await ranker.rankDetailed(report, checkpoint), result);
    assert.equal(calls, settledCalls);
  });
  for (const phase of ["primary", "supplement"] as const) {
    it(`settles an unchanged late repair producer in ${phase} using a real checkpoint`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "vf-unchanged-deadline-"));
      try {
        const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{ ...rawReport.scene_candidates[0],
          candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `unchanged-${i}`, 80, 1080, 1920)),
        }] });
        const checkpoint = () => fileRoleAgentLoopCheckpoint(path.join(directory, "rank.json"), "unchanged");
        let calls = 0;
        let downloads = 0;
        let observations = 0;
        const stopAt = phase === "primary" ? 3 : 5;
        const repair = { ...passingAudit(), verdict: "repair", score: 50,
          assessments: passingAudit().assessments.map(a => ({ ...a, dimensions: a.dimensions.map(d => ({ ...d, score: 50 })) })),
          issues: [{ severity: "blocking", criterion: "证据", evidence: "缺少证据", repairInstruction: "补齐证据" }], repairInstructions: ["补齐证据"],
        };
        const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => { downloads++; return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
          client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload, requestId, _session, options) => {
            const operation = preparedOperation(kind, payload, requestId!);
            operation.taskFact = "accepted_unknown";
            await options?.beforeSubmit?.(operation);
            calls++;
            if (calls === stopAt) throw new Error("accepted unchanged producer interrupted");
            return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" }
              : calls === stopAt - 1 ? repair : passingAudit() };
          }, observePrepared: async operation => {
            observations++;
            return { output: { ...deterministicAssetRanking(operation.envelope.payload as AssetCandidateReport), source: "model" } };
          } },
        });
        await assert.rejects(ranker.rankDetailed(report, checkpoint()), /accepted unchanged producer interrupted/);
        const saved = await checkpoint().load() as { assetRankBatch: { deadlineAt: number } };
        saved.assetRankBatch.deadlineAt = 0;
        await checkpoint().save(saved);
        const result = await ranker.rankDetailed(report, checkpoint());
        assert.equal(result.output.visualEvidence?.stopReason, "deadline");
        assert.equal(result.output.visualEvidence?.reviewed.length, phase === "primary" ? 0 : 12);
        assert.notEqual(result.agentLoop?.status, "passed");
        const beforeDownloads = downloads;
        for (let i = 0; i < 2; i++) assert.deepEqual(await ranker.rankDetailed(report, checkpoint()), result);
        assert.equal(downloads, beforeDownloads);
        assert.equal(calls, stopAt);
        assert.equal(observations, 1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }

  for (const iteration of [1, 3]) for (const outcome of ["pass", "repair", "failure", "unknown"] as const) {
    it(`settles primary late audit ${outcome} at quality iteration ${iteration} without restarting its budget`, async () => {
      const report = parseAssetCandidateReport(rawReport);
      let saved: unknown;
      let calls = 0;
      let observations = 0;
      const checkpoint = { key: `primary-${iteration}-${outcome}`, load: async () => structuredClone(saved),
        save: async (value: unknown) => { saved = structuredClone(value); } };
      const repair = { ...passingAudit(), verdict: "repair", score: 50,
        assessments: passingAudit().assessments.map(a => ({ ...a, dimensions: a.dimensions.map(d => ({ ...d, score: 50 })) })),
        issues: [{ severity: "blocking", criterion: "核验理由", evidence: "缺少证据", repairInstruction: "补齐证据" }], repairInstructions: ["补齐证据"],
      };
      const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload, requestId, _session, options) => {
          const operation = preparedOperation(kind, payload, requestId!);
          operation.taskFact = "accepted_unknown";
          await options?.beforeSubmit?.(operation);
          calls++;
          if (calls === iteration * 2) throw new Error("accepted interrupted");
          return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(report), source: "model", summary: `candidate ${calls}` } : repair };
        }, observePrepared: async () => {
          observations++;
          if (outcome === "failure") throw new CodexBridgeError("terminal", false, "completed_failure", 502, "model_provider_no_output");
          if (outcome === "unknown") throw new Error("still unknown");
          return { output: outcome === "pass" ? passingAudit() : repair };
        } },
      });
      await assert.rejects(ranker.rankDetailed(report, checkpoint), /accepted interrupted/);
      (saved as { assetRankBatch: { deadlineAt: number } }).assetRankBatch.deadlineAt = 0;
      if (outcome === "unknown") {
        await assert.rejects(ranker.rankDetailed(report, checkpoint), /still unknown/);
        assert.equal((saved as { assetRankBatch: { finished?: unknown } }).assetRankBatch.finished, undefined);
      } else {
        const result = await ranker.rankDetailed(report, checkpoint);
        assert.equal(result.output.visualEvidence?.stopReason, "deadline");
        assert.equal(result.output.visualEvidence?.reviewed.length, outcome === "pass" ? 2 : 0);
        assert.equal(result.agentLoop?.status === "passed", outcome === "pass");
        assert.deepEqual(await ranker.rankDetailed(report, checkpoint), result);
      }
      assert.equal(calls, iteration * 2);
      assert.equal(observations, 1);
    });
  }

  for (const boundary of ["beforeSubmit", "producerResult", "finished"] as const) {
    it(`recovers a supplementary ${boundary} persistence failure without duplicate accepted work`, async () => {
      const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{ ...rawReport.scene_candidates[0],
        candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `persist-${i}`, 80, 1080, 1920)),
      }] });
      let saved: unknown;
      let diskFailed = false;
      let inject = true;
      let calls = 0;
      const accepted = new Map<string, unknown>();
      const checkpoint = { key: `persist-${boundary}`, load: async () => structuredClone(saved), save: async (value: unknown) => {
        const state = value as { pendingOperation?: unknown; pendingCandidate?: unknown; assetRankBatch?: { phase: string; finished?: unknown } };
        if (inject && state.assetRankBatch?.phase === "supplement"
          && (boundary === "beforeSubmit" ? state.pendingOperation : boundary === "producerResult" ? state.pendingCandidate : state.assetRankBatch.finished)) diskFailed = true;
        if (diskFailed) throw new Error("disk unavailable");
        saved = structuredClone(value);
      } };
      const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload, requestId, _session, options) => {
          await options?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
          assert.equal(accepted.has(requestId!), false, "already accepted work must only be observed");
          calls++;
          const output = kind === "asset-rank" ? { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" } : passingAudit();
          accepted.set(requestId!, output);
          return { output };
        }, observePrepared: async operation => {
          assert.ok(accepted.has(operation.requestId));
          return { output: accepted.get(operation.requestId) };
        } },
      });
      await assert.rejects(ranker.rankDetailed(report, checkpoint), /disk unavailable/);
      assert.equal(calls, boundary === "beforeSubmit" ? 2 : boundary === "producerResult" ? 3 : 4);
      diskFailed = false;
      inject = false;
      const result = await ranker.rankDetailed(report, checkpoint);
      assert.equal(result.output.visualEvidence?.reviewed.length, 24);
      assert.equal(calls, 4);
      assert.equal(result.agentLoop?.modelCallCount, 4);
      assert.deepEqual(await ranker.rankDetailed(report, checkpoint), result);
      assert.equal(calls, 4);
    });
  }

  for (const outcome of ["paused", "deadline-pass", "deadline-repair", "deadline-failure"] as const) {
    it(`settles supplementary pending results safely for ${outcome}`, async () => {
      const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{ ...rawReport.scene_candidates[0],
        candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `terminal-${i}`, 80, 1080, 1920)),
      }] });
      let saved: unknown;
      let calls = 0;
      let observations = 0;
      let paused = false;
      const checkpoint = { key: outcome, load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
      const repairAudit = { ...passingAudit(), verdict: "repair", score: 50,
        assessments: passingAudit().assessments.map(a => ({ ...a, dimensions: a.dimensions.map(d => ({ ...d, score: 50 })) })),
        issues: [{ severity: "blocking", criterion: "核验理由", evidence: "核验理由需要补齐", repairInstruction: "补齐理由" }], repairInstructions: ["补齐理由"],
      };
      const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload, requestId, _session, options) => {
          const operation = preparedOperation(kind, payload, requestId!);
          operation.taskFact = "accepted_unknown";
          await options?.beforeSubmit?.(operation);
          calls++;
          if (calls === (outcome === "paused" ? 3 : 4)) throw new Error("accepted interrupted");
          return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" } : passingAudit() };
        }, observePrepared: async op => {
          observations++;
          if (outcome === "deadline-failure") throw new CodexBridgeError("terminal failure", false, "completed_failure", 502, "model_provider_no_output");
          return { output: op.kind === "asset-rank" ? { ...deterministicAssetRanking(op.envelope.payload as AssetCandidateReport), source: "model" }
            : outcome === "deadline-repair" ? repairAudit : passingAudit() };
        } },
      });
      await assert.rejects(ranker.rankDetailed(report, checkpoint), /accepted interrupted/);
      const before = calls;
      if (outcome === "paused") {
        paused = true;
        await assert.rejects(ranker.rankDetailed(report, checkpoint, undefined, async () => !paused), /暂停/);
        assert.equal(calls, before);
        paused = false;
        await ranker.rankDetailed(report, checkpoint, undefined, async () => !paused);
        assert.equal(calls, 4);
      } else {
        (saved as { assetRankBatch: { deadlineAt: number } }).assetRankBatch.deadlineAt = 0;
        if (outcome === "deadline-failure") {
          const stopped = await ranker.rankDetailed(report, checkpoint);
          assert.equal(stopped.output.visualEvidence?.stopReason, "deadline");
        } else {
          const result = await ranker.rankDetailed(report, checkpoint);
          assert.equal(result.output.visualEvidence?.reviewed.length, outcome === "deadline-pass" ? 24 : 12);
          assert.equal(result.agentLoop?.modelCallCount, 4);
          assert.deepEqual(await ranker.rankDetailed(report, checkpoint), result);
        }
        assert.equal(calls, before);
      }
      assert.equal(observations, 1);
    });
  }

  it("refuses to use the unaudited compatibility route from the detailed production entry", async () => {
    let calls = 0;
    await assert.rejects(new CodexAssetSemanticRanker({ client: { runTask: async () => { calls++; return {}; } } })
      .rankDetailed(parseAssetCandidateReport(rawReport)), /refusing unaudited/);
    assert.equal(calls, 0);
  });

  it("rejects an oversized audit context before spending a producer call", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const intent = report.scenes[0]!.intent;
    while (Buffer.byteLength(JSON.stringify(report.scenes)) < 194000) intent[`padding${Object.keys(intent).length}`] = "x".repeat(1900);
    intent.finalPadding = "";
    intent.finalPadding = "x".repeat(196480 - Buffer.byteLength(JSON.stringify(report.scenes)));
    let calls = 0;
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => undefined,
      client: { runTask: async () => ({}), runTaskDetailed: async kind => {
        calls++;
        return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(report), source: "model" } : passingAudit() };
      } },
    });
    await assert.rejects(ranker.rankDetailed(report), /context/);
    assert.equal(calls, 0);
  });

  it("keeps a reserved supplement paused across restart and resumes only after permission returns", async () => {
    const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{ ...rawReport.scene_candidates[0],
      candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `pause-${i}`, 80, 1080, 1920)),
    }] });
    let saved: unknown;
    let crash = true;
    let calls = 0;
    const checkpoint = { key: "reserved-pause", load: async () => structuredClone(saved), save: async (value: unknown) => {
      saved = structuredClone(value);
      const state = value as { version?: string; assetRankBatch?: { phase: string } };
      if (crash && state.assetRankBatch?.phase === "supplement" && !state.version) {
        crash = false;
        throw new Error("crash after supplement reservation");
      }
    } };
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload) => {
        calls++;
        return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" } : passingAudit() };
      } },
    });
    await assert.rejects(ranker.rankDetailed(report, checkpoint), /crash after supplement/);
    await assert.rejects(ranker.rankDetailed(report, checkpoint, undefined, async () => false), /暂停/);
    assert.equal(calls, 2);
    const result = await ranker.rankDetailed(report, checkpoint, undefined, async () => true);
    assert.equal(calls, 4);
    assert.equal(result.output.visualEvidence?.reviewed.length, 24);
    assert.equal(result.agentLoop?.modelCallCount, 4);
  });

  it("supplements only blocked scenes once and replays the completed batch without new calls", async () => {
    const report = { ...parseAssetCandidateReport({
      version: rawReport.version,
      scene_candidates: [12, 12, 6, 18, 12].map((count, scene) => ({
        scene_position: scene + 1, intent: { subject: "可见主体" }, query: "stock",
        candidates: Array.from({ length: count }, (_, i) => candidate("pexels", `${scene + 1}-${i + 1}`, 80, 1080, 1920)),
      })),
    }), planningIntent: { rankingIntent: { planContract: { visualBible: ["保持自然色调"] }, shots: [
      { scenePosition: 1, visibleAction: "远处海平线，保持参考色调" },
      { scenePosition: 4, visibleAction: "海浪整体移动" }, { scenePosition: 5, visibleAction: "平静海面，不强制方向", referenceFromScenePosition: 1 },
    ] } } };
    type TestPayload = AssetCandidateReport & { thumbnails: Array<{ scenePosition: number; assetId: string }> };
    const calls: Array<{ kind: string; payload: unknown }> = [];
    let saved: unknown;
    const checkpoint = { key: "bounded-supplement", load: async () => saved, save: async (value: unknown) => { saved = structuredClone(value); } };
    const ranker = new CodexAssetSemanticRanker({
      fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: {
        runTask: async () => { throw new Error("must use audited route"); },
        runTaskDetailed: async (kind, payload) => {
          calls.push({ kind, payload });
          if (kind === "role-audit") return { output: passingAudit() };
          const batch = payload as typeof report & { thumbnails: Array<{ scenePosition: number; assetId: string }> };
          const output = deterministicAssetRanking(batch);
          output.source = "model";
          for (const scene of output.scenes) for (const item of scene.candidates) {
            const visible = batch.thumbnails.some(t => t.scenePosition === scene.scenePosition && t.assetId === item.assetId);
            item.semanticScore = visible && (scene.scenePosition !== 5 || item.assetId === "5-4") ? 80 : 10;
          }
          return { output };
        },
      },
    });
    const first = await ranker.rankDetailed(report, checkpoint);
    assert.deepEqual(calls.map(call => call.kind), ["asset-rank", "role-audit", "asset-rank", "role-audit"]);
    assert.deepEqual((calls[2]!.payload as TestPayload).scenes.map(scene => scene.scenePosition), [5]);
    assert.equal((calls[0]!.payload as TestPayload).thumbnails.length, 12);
    assert.equal((calls[2]!.payload as TestPayload).thumbnails.length, 10);
    const context = JSON.parse((calls[2]!.payload as TestPayload).scenes[0]!.intent.rankingContext!);
    assert.deepEqual(context.director.planContract.visualBible, ["保持自然色调"]);
    assert.equal(context.director.shots.at(-1).visibleAction, "平静海面，不强制方向");
    assert.ok(context.director.shots.some((shot: { scenePosition: number }) => shot.scenePosition === 1), "non-adjacent references must be explicit in the supplementary context");
    assert.equal(context.neighbors[0].scenePosition, 4);
    assert.equal(Object.hasOwn(calls[2]!.payload as object, "planningIntent"), false);
    assert.equal(first.output.scenes[4]!.candidates[0]!.assetId, "5-4");
    assert.equal(first.output.scenes[4]!.candidates[0]!.semanticScore, 80);
    assert.equal(first.output.scenes.length, 5);
    assert.equal(first.output.visualEvidence?.supplementaryBatches, 1);
    assert.equal(first.output.visualEvidence?.reviewed.length, 22);
    assert.deepEqual(first.output.scenes.map(scene => scene.candidates.length), [12, 12, 6, 18, 12]);
    const replay = await ranker.rankDetailed(report, checkpoint);
    assert.equal(calls.length, 4);
    assert.deepEqual(replay, first);
  });

  for (const interruptedKind of ["asset-rank", "role-audit"] as const) {
    it(`resumes a persisted supplementary ${interruptedKind} without re-fetching or re-submitting`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "vf-rank-batches-"));
      try {
        const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{
          ...rawReport.scene_candidates[0], candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `item-${i}`, 80, 1080, 1920)),
        }] });
        const calls: string[] = [];
        const observed: string[] = [];
        let fetches = 0;
        let interrupt = true;
        const modelOutput = (payload: unknown) => {
          const input = payload as AssetCandidateReport;
          return { ...deterministicAssetRanking(input), source: "model" as const };
        };
        const client = {
          runTask: async () => { throw new Error("unexpected unaudited route"); },
          runTaskDetailed: async (kind: CodexTaskKind, payload: unknown, requestId?: string, _session?: unknown, options?: CodexTaskRequestOptions): Promise<CodexTaskExecution> => {
            calls.push(requestId!);
            await options?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
            if (calls.length >= 3 && kind === interruptedKind && interrupt) {
              throw new Error("supplement interrupted");
            }
            return { output: kind === "asset-rank" ? modelOutput(payload) : passingAudit() };
          },
          observePrepared: async (operation: CodexPreparedOperation) => {
            observed.push(operation.requestId);
            return { output: operation.kind === "asset-rank" ? modelOutput(operation.envelope.payload) : passingAudit() };
          },
        };
        const ranker = new CodexAssetSemanticRanker({ client, fetchThumbnail: async () => { fetches++; return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); } });
        let migrated = false;
        const checkpoint = () => fileRoleAgentLoopCheckpoint(path.join(directory, `runs/run-1/nodes/creative-planning/agent-loop-checkpoints/${migrated ? "new" : "rank"}.json`), migrated ? "new-batch" : "original-batch", {
          recoverOwnedPending: true,
          recoveryOwner: { runId: "run-1", nodeId: "creative-planning", workflowOperationRequestId: "operation-1" },
        });
        await assert.rejects(ranker.rankDetailed(report, checkpoint()), /supplement interrupted/);
        const interruptedId = calls.at(-1);
        interrupt = false;
        migrated = true;
        const result = await ranker.rankDetailed(report, checkpoint());
        assert.deepEqual(observed, [interruptedId]);
        assert.equal(calls.length, 4, "two producers and two audits; recovery only observes the original submission");
        assert.equal(new Set(calls).size, 4);
        assert.equal(fetches, 24, "both snapshots are read from disk on recovery");
        assert.deepEqual(await ranker.rankDetailed(report, checkpoint()), result);
        assert.deepEqual(await ranker.rankDetailed(report, checkpoint()), result);
        assert.equal(calls.length, 4, "migration must preserve the finished batch through repeated reloads");
        assert.equal(result.output.visualEvidence?.reviewed.length, 24);
        assert.equal(result.agentLoop?.modelCallCount, 4);
        const receipt = await summarizeJointPlanningExecution(path.join(directory, "runs"), "run-1", "operation-1");
        assert.equal(receipt?.modelCallCount, 4, "production accounting must include the primary batch overwritten by the supplement");
        assert.equal(receipt?.producerModelCallCount, 2);
        assert.equal(receipt?.auditModelCallCount, 2);
        assert.ok(result.output.scenes[0]!.candidates.every(item => item.semanticScore < 40));
        const replay = await ranker.rankDetailed(report, checkpoint());
        assert.deepEqual(replay, result);
        assert.equal(calls.length, 4, "no third batch even when every candidate still fails");
        await assert.rejects(ranker.rankDetailed({ ...report, scenes: report.scenes.map(scene => ({ ...scene, query: "changed" })) }, checkpoint()), /does not match/);
        assert.equal(calls.length, 4);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("backfills failed thumbnails while preserving the 12-image and 24-attempt limits", async () => {
    const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{
      ...rawReport.scene_candidates[0], candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `item-${i}`, 80, 1080, 1920)),
    }] });
    let attempts = 0;
    let sent: unknown;
    const ranker = new CodexAssetSemanticRanker({
      fetchThumbnail: async () => ++attempts <= 5 ? undefined : Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async (_kind, payload) => { sent = payload; return deterministicAssetRanking(report); } },
    });
    await ranker.rank(report);
    assert.equal(attempts, 17);
    assert.equal((sent as { thumbnails: unknown[] }).thumbnails.length, 12);
    let failures = 0;
    await new CodexAssetSemanticRanker({ fetchThumbnail: async () => { failures++; return undefined; },
      client: { runTask: async () => deterministicAssetRanking(report) },
    }).rank(report);
    assert.equal(failures, 24);
  });

  it("does not submit any model task if the snapshot cannot be saved", async () => {
    let calls = 0;
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async () => { calls++; }, runTaskDetailed: async () => { calls++; return { output: {} }; } },
    });
    await assert.rejects(ranker.rankDetailed(parseAssetCandidateReport(rawReport), {
      key: "save-failure", load: async () => undefined, save: async () => { throw new Error("disk full"); },
    }), /disk full/);
    assert.equal(calls, 0);
  });

  it("honors a pause before supplementing and never downloads or submits that extra batch", async () => {
    const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{
      ...rawReport.scene_candidates[0], candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `item-${i}`, 80, 1080, 1920)),
    }] });
    let calls = 0;
    let downloads = 0;
    const ranker = new CodexAssetSemanticRanker({
      fetchThumbnail: async () => { downloads++; return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
      client: { runTask: async () => ({}), runTaskDetailed: async kind => {
        calls++;
        return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(report), source: "model" } : passingAudit() };
      } },
    });
    await assert.rejects(ranker.rankDetailed(report, undefined, undefined, async () => calls < 2), /暂停/);
    assert.equal(calls, 2);
    assert.equal(downloads, 12);
  });

  it("does not let model-claimed visual evidence make unseen candidates automatically usable", async () => {
    const report = parseAssetCandidateReport(rawReport);
    let audits = 0;
    const output = deterministicAssetRanking(report);
    output.source = "model";
    output.scenes[0]!.candidates[0]!.semanticScore = 90;
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => undefined, maxReviewIterations: 1,
      client: { runTask: async () => output, runTaskDetailed: async (kind) => {
        if (kind === "role-audit") { audits++; return { output: passingAudit() }; }
        return { output: { ...output, visualEvidence: { reviewed: [{ provider: "pixabay", assetId: "second" }] } } };
      } },
    });
    await assert.rejects(ranker.rankDetailed(report), /Unseen candidates|结构|validation/i);
    assert.equal(audits, 0);
  });

  it("stops new submissions when the persisted total deadline expires", async () => {
    const report = parseAssetCandidateReport(rawReport);
    let saved: unknown;
    let calls = 0;
    const checkpoint = { key: "deadline", load: async () => saved, save: async (value: unknown) => { saved = structuredClone(value); } };
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async () => ({}), runTaskDetailed: async () => { calls++; throw new Error("before acceptance failure"); } },
    });
    await assert.rejects(ranker.rankDetailed(report, checkpoint), /before acceptance failure/);
    const snapshot = saved as { assetRankBatch: { deadlineAt: number } };
    snapshot.assetRankBatch.deadlineAt = 0;
    const stopped = await ranker.rankDetailed(report, checkpoint);
    assert.equal(stopped.output.visualEvidence?.stopReason, "deadline");
    assert.ok(stopped.output.scenes.every(scene => scene.candidates.every(c => c.semanticScore < 40)));
    assert.equal(calls, 1);
    assert.deepEqual(await ranker.rankDetailed(report, checkpoint), stopped);
    assert.equal(calls, 1);
  });

  it("settles a late supplement producer into an honest user stop without submitting or counting an audit", async () => {
    const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [{ ...rawReport.scene_candidates[0],
      candidates: Array.from({ length: 24 }, (_, i) => candidate("pexels", `late-${i}`, 80, 1080, 1920)),
    }] });
    let saved: unknown;
    let calls = 0;
    let observations = 0;
    const checkpoint = { key: "late-stop", load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value); } };
    const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async () => ({}), runTaskDetailed: async (kind, payload, requestId, _session, options) => {
        calls++;
        const operation = preparedOperation(kind, payload, requestId!);
        operation.taskFact = "accepted_unknown";
        await options?.beforeSubmit?.(operation);
        if (calls === 3) throw new Error("late producer");
        return { output: kind === "asset-rank" ? { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" } : passingAudit() };
      }, observePrepared: async op => {
        observations++;
        return { output: { ...deterministicAssetRanking(op.envelope.payload as AssetCandidateReport), source: "model" } };
      } },
    });
    await assert.rejects(ranker.rankDetailed(report, checkpoint), /late producer/);
    (saved as { assetRankBatch: { deadlineAt: number } }).assetRankBatch.deadlineAt = 0;
    const result = await ranker.rankDetailed(report, checkpoint);
    assert.equal(result.output.visualEvidence?.stopReason, "deadline");
    assert.equal(result.output.visualEvidence?.reviewed.length, 12, "the unaudited late images must not become accepted evidence");
    assert.equal(result.agentLoop?.modelCallCount, 3);
    assert.equal(result.agentLoop?.auditModelCallCount, 1);
    assert.equal(calls, 3);
    assert.equal(observations, 1);
    assert.deepEqual(await ranker.rankDetailed(report, checkpoint), result);
    assert.equal(calls, 3);
  });

  it("repairs a semantic ranking after independent contract audit", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    let rankAttempt = 0;
    const client = {
      runTask: async () => deterministicAssetRanking(report),
      runTaskDetailed: async (kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> => {
        calls.push({ kind, payload });
        if (kind === "asset-rank") {
          rankAttempt += 1;
          const ranking = deterministicAssetRanking(report);
          ranking.source = "model";
          ranking.providerId = "codex-asset-ranker-v1";
          ranking.modelId = "codex-default";
          ranking.scenes[0]!.candidates[0]!.rationale = rankAttempt === 1
            ? "这个素材 ID 看起来更合适。"
            : "缩略图显示蒸汽动作清楚，且竖屏主体完整。";
          return { output: ranking };
        }
        const auditScore = rankAttempt === 1 ? 55 : 90;
        return { output: {
          version: "video-factory/role-audit-v2",
          rubricVersion: "video-factory/role-quality-rubric-v1",
          assessments: [{
            targetPath: "",
            dimensions: [
              {
                dimension: "evidence",
                score: auditScore,
                evidence: rankAttempt === 1
                  ? "首选理由只依赖素材 ID，没有可核对的缩略图证据。"
                  : "排序理由逐条对应缩略图可见内容。",
              },
              { dimension: "coverage", score: auditScore, evidence: "评估覆盖本轮的全部候选。" },
              { dimension: "consistency", score: auditScore, evidence: "评分与 issues 的严重度一致。" },
              { dimension: "actionability", score: auditScore, evidence: "返修要求可落到具体候选的理由。" },
            ],
          }],
          verdict: rankAttempt === 1 ? "repair" : "pass",
          score: auditScore,
          summary: rankAttempt === 1 ? "首选理由依赖素材 ID 臆测。" : "排序理由诚实反映证据边界。",
          issues: rankAttempt === 1 ? [{
            severity: "blocking",
            criterion: "不得根据素材 ID 臆测",
            evidence: "理由写明‘素材 ID 看起来更合适’。",
            repairInstruction: "删除 ID 推断并明确缩略图证据缺失。",
          }] : [],
          repairInstructions: rankAttempt === 1 ? ["按可见证据重写理由。"] : [],
        } };
      },
    };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
    const ranker = new CodexAssetSemanticRanker({ client, fetchThumbnail: async () => jpeg, maxReviewIterations: 2 });

    const execution = await ranker.rankDetailed(report);

    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.match(execution.output.scenes[0]!.candidates[0]!.rationale, /缩略图/);
    assert.deepEqual(calls.map((call) => call.kind), ["asset-rank", "role-audit", "asset-rank", "role-audit"]);
    assert.equal("revision" in (calls[2]!.payload as Record<string, unknown>), true);
    const auditImages = (calls[1]!.payload as { images: Array<Record<string, unknown>> }).images;
    const auditCriteria = (calls[1]!.payload as { criteria: string[] }).criteria;
    assert.match(auditCriteria.join("\n"), /核心主体、物体和动作.*诚实标记无匹配/);
    const auditContract = (calls[1]!.payload as {
      context: { currentRoleContract: Record<string, unknown> };
    }).context.currentRoleContract;
    assert.equal(auditContract.automaticUseMinimumSemanticScore, 40);
    assert.match(String(auditContract.noMatchPolicy), /排序结果本身可以通过审计/);
    assert.equal(auditImages.length, 2);
    assert.deepEqual(auditImages.map((image) => [image.imageIndex, image.provider, image.assetId]), [[1, "pexels", "first"], [2, "pixabay", "second"]]);
    assert.equal(typeof auditImages[0]?.jpegBase64, "string");
  });

  it("parses bounded public candidate metadata and never requires download URLs", () => {
    const report = parseAssetCandidateReport(rawReport);
    assert.equal(report.scenes[0]?.candidates[0]?.assetId, "first");
    assert.equal(Object.hasOwn(report.scenes[0]?.candidates[0] ?? {}, "downloadUrl"), false);
  });

  it("provides a deterministic inspectable fallback", () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranking = deterministicAssetRanking(report, "test fallback");
    assert.equal(ranking.source, "fallback");
    assert.deepEqual(ranking.scenes[0]?.candidates.map((item) => item.assetId), ["second", "first"]);
    assert.deepEqual(ranking.scenes[0]?.candidates.map((item) => item.semanticScore), [0, 0]);
    assert.match(ranking.scenes[0]?.summary ?? "", /语义未验证/);
    assert.equal(ranking.fallbackReason, "test fallback");
  });

  it("rejects model output that silently removes a candidate", () => {
    const report = parseAssetCandidateReport(rawReport);
    assert.throws(() => validateAssetSemanticRanking({
      version: "video-factory/asset-ranking-v1",
      source: "model",
      providerId: "codex-asset-ranker-v1",
      modelId: "codex-default",
      summary: "ranked",
      scenes: [{
        scenePosition: 1,
        summary: "only one",
        candidates: [{
          provider: "pexels", assetId: "first", originalRank: 1, rank: 1,
          semanticScore: 80, rationale: "matches", locked: false,
        }],
      }],
    }, report), /cover every candidate/);
  });

  it("rejects duplicate scene identities instead of letting a local merge hide a missing scene", () => {
    const report = parseAssetCandidateReport({ ...rawReport, scene_candidates: [rawReport.scene_candidates[0], {
      ...rawReport.scene_candidates[0], scene_position: 2,
    }] });
    const output = deterministicAssetRanking(report);
    output.scenes[1] = structuredClone(output.scenes[0]!);
    assert.throws(() => validateAssetSemanticRanking(output, report), /unknown scene/);
  });

  it("reserves candidate locks for human overrides and preserves original ranks", () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranking = deterministicAssetRanking(report);
    ranking.scenes[0]!.candidates[0]!.locked = true;

    assert.throws(() => validateAssetSemanticRanking(ranking, report), /cannot lock candidates/);
    assert.equal(validateAssetSemanticRanking(ranking, report, { allowLocks: true }).scenes[0]?.candidates[0]?.locked, true);
    ranking.scenes[0]!.candidates[0]!.originalRank = 1;
    assert.throws(() => validateAssetSemanticRanking(ranking, report, { allowLocks: true }), /invalid originalRank/);
  });

  it("pins provider and model evidence to the configured ranker", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranker = new CodexAssetSemanticRanker({
      providerId: "codex-asset-ranker-v1",
      modelId: "configured-codex",
      client: {
        runTask: async () => ({
          version: "video-factory/asset-ranking-v1",
          source: "model",
          providerId: "codex-asset-ranker-v1",
          modelId: "configured-codex",
          summary: "语义排序完成",
          scenes: [{
            scenePosition: 1,
            summary: "第二项动作更明确",
            candidates: [
              { provider: "pixabay", assetId: "second", originalRank: 2, rank: 1, semanticScore: 86, rationale: "动作匹配", locked: false },
              { provider: "pexels", assetId: "first", originalRank: 1, rank: 2, semanticScore: 62, rationale: "信息不足", locked: false },
            ],
          }],
        }),
      },
      fetchThumbnail: async () => undefined,
    });
    const ranking = await ranker.rank(report);
    assert.equal(ranking.modelId, "configured-codex");
    assert.equal(ranking.scenes[0]?.candidates[0]?.assetId, "second");
  });

  it("sends bounded candidate thumbnails with an explicit scene and asset mapping", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const seen: unknown[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
    const ranker = new CodexAssetSemanticRanker({
      client: {
        runTask: async (_kind, payload) => {
          seen.push(payload);
          return deterministicAssetRanking(report);
        },
      },
      fetchThumbnail: async () => jpeg,
    });
    await ranker.rank(report);
    const payload = seen[0] as { thumbnails: Array<Record<string, unknown>> };
    assert.equal(payload.thumbnails.length, 2);
    assert.deepEqual(
      payload.thumbnails.map((item) => [item.scenePosition, item.provider, item.assetId]),
      [[1, "pexels", "first"], [1, "pixabay", "second"]],
    );
    assert.equal(typeof payload.thumbnails[0]?.jpegBase64, "string");
  });

  it("keeps checkpoint-only planning intent out of the broker asset-rank payload", async () => {
    const report = {
      ...parseAssetCandidateReport(rawReport),
      planningIntent: {
        semanticIntentVersion: "video-factory/ranking-semantic-intent-v1",
        rankingIntent: { subject: "同一部手机", action: "比较三个动作" },
      },
    };
    const seen: Array<Record<string, unknown>> = [];
    const ranker = new CodexAssetSemanticRanker({
      client: {
        runTask: async (_kind, payload) => {
          seen.push(payload as Record<string, unknown>);
          return deterministicAssetRanking(report);
        },
      },
      fetchThumbnail: async () => undefined,
    });

    await ranker.rank(report);

    assert.deepEqual(Object.keys(seen[0] ?? {}).sort(), ["scenes", "thumbnails", "version"]);
    assert.equal(Object.hasOwn(seen[0] ?? {}, "planningIntent"), false);
  });

  it("drops thumbnails larger than the broker per-image boundary before sending", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const seen: unknown[] = [];
    const oversized = Buffer.alloc(256 * 1024 + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    const ranker = new CodexAssetSemanticRanker({
      client: {
        runTask: async (_kind, payload) => {
          seen.push(payload);
          return deterministicAssetRanking(report);
        },
      },
      fetchThumbnail: async () => oversized,
    });

    await ranker.rank(report);

    const payload = seen[0] as { thumbnails: unknown[] };
    assert.deepEqual(payload.thumbnails, []);
  });

  it("resumes the saved ranking request and reuses its thumbnail snapshot", async () => {
    const report = parseAssetCandidateReport(rawReport);
    let stored: unknown;
    let interruptProducer = true;
    let producerCalls = 0;
    let thumbnailFetches = 0;
    const observed: string[] = [];
    const ranking = deterministicAssetRanking(report);
    ranking.source = "model";
    ranking.providerId = "codex-asset-ranker-v1";
    ranking.modelId = "codex-default";
    const checkpoint = {
      key: "asset-rank-recovery",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => ranking,
      runTaskDetailed: async (
        kind: CodexTaskKind,
        payload: unknown,
        requestId?: string,
        _session?: unknown,
        requestOptions?: CodexTaskRequestOptions,
      ): Promise<CodexTaskExecution> => {
        if (kind === "asset-rank") {
          producerCalls += 1;
          if (interruptProducer) {
            await requestOptions?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
            throw new Error("ranking response interrupted");
          }
          return { output: ranking };
        }
        return { output: passingAudit() };
      },
      observePrepared: async (operation: CodexPreparedOperation): Promise<CodexTaskExecution> => {
        observed.push(operation.requestId);
        return { output: ranking };
      },
    };
    const ranker = new CodexAssetSemanticRanker({
      client,
      fetchThumbnail: async () => {
        thumbnailFetches += 1;
        return Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
      },
    });

    await assert.rejects(() => ranker.rankDetailed(report, checkpoint), /ranking response interrupted/);
    assert.ok((stored as { pendingOperation?: unknown }).pendingOperation);
    interruptProducer = false;
    const execution = await ranker.rankDetailed(report, checkpoint);

    assert.equal(execution.agentLoop?.status, "passed");
    assert.equal(producerCalls, 1);
    assert.equal(observed.length, 1);
    assert.equal(thumbnailFetches, 2, "recovery must reuse the original two thumbnails instead of downloading them again");
  });

  it("recovers a saved ranking whose thumbnails are real JPEG sizes", async () => {
    const report = parseAssetCandidateReport(rawReport);
    let stored: unknown;
    let interruptProducer = true;
    // 真实缩略图 30–80 KB。上面那条恢复用例用的是 5 字节的假图，base64 只有 8 个字符，
    // 所以读回侧的 2_000 字符上限一直被绕过：写入侧收下 256 KiB，恢复侧只认 1_500 字节，
    // 于是"存得进去、读不回来"，每一次恢复已存盘的 asset-rank 操作都必然失败。
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(60 * 1024, 0x41),
      Buffer.from([0xff, 0xd9]),
    ]);
    const ranking = deterministicAssetRanking(report);
    ranking.source = "model";
    ranking.providerId = "codex-asset-ranker-v1";
    ranking.modelId = "codex-default";
    const checkpoint = {
      key: "asset-rank-real-size",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => ranking,
      runTaskDetailed: async (
        kind: CodexTaskKind,
        payload: unknown,
        requestId?: string,
        _session?: unknown,
        requestOptions?: CodexTaskRequestOptions,
      ): Promise<CodexTaskExecution> => {
        if (kind === "asset-rank") {
          if (interruptProducer) {
            await requestOptions?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
            throw new Error("ranking response interrupted");
          }
          return { output: ranking };
        }
        return { output: passingAudit() };
      },
      observePrepared: async (): Promise<CodexTaskExecution> => ({ output: ranking }),
    };
    const ranker = new CodexAssetSemanticRanker({ client, fetchThumbnail: async () => jpeg });

    await assert.rejects(() => ranker.rankDetailed(report, checkpoint), /ranking response interrupted/);
    const savedThumbnails = (stored as {
      pendingOperation?: { operation?: { envelope?: { payload?: { thumbnails?: Array<{ jpegBase64?: string }> } } } };
    }).pendingOperation?.operation?.envelope?.payload?.thumbnails;
    assert.ok(
      typeof savedThumbnails?.[0]?.jpegBase64 === "string" && savedThumbnails[0].jpegBase64.length > 2_000,
      "回归前提：存盘的缩略图 base64 必须超过旧的 2_000 字符上限，否则这条用例测不到 F10",
    );

    interruptProducer = false;
    const execution = await ranker.rankDetailed(report, checkpoint);

    assert.equal(execution.agentLoop?.status, "passed");
  });

  it("rejects a recovered thumbnail whose base64 is not a JPEG", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const notJpeg = Buffer.alloc(60 * 1024, 0x41);
    const checkpoint = {
      key: "asset-rank-not-jpeg",
      load: async () => ({
        pendingOperation: {
          operation: preparedOperation("asset-rank", {
            version: report.version,
            scenes: report.scenes,
            thumbnails: [{
              scenePosition: 1,
              provider: "pexels",
              assetId: "first",
              sha256: "a".repeat(64),
              jpegBase64: notJpeg.toString("base64"),
            }],
          }, "agent-not-jpeg"),
        },
      }),
      save: async () => {},
    };
    const ranker = new CodexAssetSemanticRanker({
      client: {
        runTask: async () => deterministicAssetRanking(report),
        // 没有 runTaskDetailed 时 rankDetailed 会直接走 rank()，根本走不到恢复路径。
        // 这里让它一旦被调用就失败，确保上面那句 rejection 只可能来自载荷校验。
        runTaskDetailed: async () => { throw new Error("recovery should have rejected before any model call"); },
      },
      fetchThumbnail: async () => undefined,
    });

    // 读取侧必须和写入侧一样核对 JPEG 魔数：长度对了不代表这串 base64 真是一张图。
    await assert.rejects(
      () => ranker.rankDetailed(report, checkpoint),
      /saved asset-rank jpegBase64 is invalid/,
    );
  });
});

function passingAudit() {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    assessments: [{
      targetPath: "",
      dimensions: [
        { dimension: "evidence", score: 92, evidence: "排序理由都能对应到缩略图证据。" },
        { dimension: "coverage", score: 92, evidence: "覆盖了本轮全部候选画面。" },
        { dimension: "consistency", score: 92, evidence: "评分与 issues 的严重度一致。" },
        { dimension: "actionability", score: 92, evidence: "结论可直接用于后续选片。" },
      ],
    }],
    verdict: "pass",
    score: 92,
    summary: "排序候选与证据一致。",
    issues: [],
    repairInstructions: [],
  };
}

function preparedOperation(kind: CodexTaskKind, payload: unknown, requestId: string): CodexPreparedOperation {
  const envelope = { protocolVersion: "video-factory/codex-bridge-v2", requestId, kind, payload };
  const brokerBinding = {
    version: "video-factory/task-binding-v1" as const,
    storeId: `vfs_store_${"a".repeat(32)}`,
    providerId: "openai",
    modelId: "codex-default",
  };
  return {
    version: "video-factory/codex-prepared-operation-v1",
    requestId,
    kind,
    envelope,
    serializedEnvelope: JSON.stringify(envelope),
    binding: {
      ...brokerBinding,
      requestDigest: "b".repeat(64),
      kind,
      contractDigest: "c".repeat(64),
      sessionDigest: "d".repeat(64),
    },
    brokerBinding,
    route: { socketPath: "/tmp/asset-rank.sock" },
    taskFact: "not_submitted",
  };
}

function candidate(provider: string, assetId: string, score: number, width: number, height: number) {
  return {
    provider,
    provider_id: `${provider}-stock-v1`,
    asset_id: assetId,
    media_type: "video",
    width,
    height,
    duration: 5,
    preview_url: `https://images.${provider}.com/${assetId}.jpg`,
    source_url: `https://www.${provider}.com/${assetId}`,
    creator: "Creator",
    license_note: "Free stock license",
    query: "Chinese breakfast steam",
    score,
  };
}
