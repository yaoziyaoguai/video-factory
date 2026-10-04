import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { CodexBrokerServer } from "../../../apps/codex-broker/src/broker-server.js";
import type { BrokerTaskExecutor } from "../../../apps/codex-broker/src/codex-executor.js";

const script = path.resolve(import.meta.dirname, "fixtures/review-continuation-child.ts");
async function waitForCrashedLeaseExpiry(root: string, runId: string) {
  const lock = await stat(path.join(root, "runs", runId, ".execution-lease.json.lock"));
  // proper-lockfile 首次探测会把mtime向上取整；从真实锁时间等满夹具的5秒过期窗口，
  // 不用固定5.2秒赌墙钟相位，也不删除锁或重试冲突写入。
  const waitMs = Math.max(0, lock.mtimeMs + 5_000 + 50 - Date.now());
  if (waitMs > 0) await delay(waitMs);
}
async function child(phase: string, mode: string, window: string, root: string, onSpawn?: (process: ChildProcess) => void) {
  return new Promise<{ code: number | null; signal: string | null; pid: number; run?: WorkflowRun; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", script, phase, mode, window, root], { stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(process);
    let stdout = "", stderr = "";
    process.stdout.on("data", chunk => { stdout += chunk; });
    process.stderr.on("data", chunk => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code, signal) => {
      const last = stdout.trim().split("\n").at(-1);
      resolve({ code, signal, pid: process.pid!, ...(last?.startsWith("{") ? JSON.parse(last) : {}), stderr });
    });
  });
}

it("W3 keeps the already accepted publisher identity across real death and startup recovery", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-final-publish-crash-"));
  let crashProcess: ChildProcess | undefined, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const submissions: string[] = [];
  const executor: BrokerTaskExecutor = { identity: { profileId: "openai", providerId: "openai", modelId: "controlled-publisher",
    taskKinds: ["publish-copy", "role-audit"] }, async runTask(task, options) {
    if (!task.expectedContractDigest) throw new Error("Controlled publisher requires the formal request contract digest.");
    submissions.push(task.kind);
    if (task.kind === "publish-copy") { crashProcess!.kill("SIGKILL"); await held; }
    const output = task.kind === "publish-copy" ? { title: "两幕日常", description: "第一幕到第二幕的日常变化。", hashtags: ["日常"] }
      : { version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1", verdict: "pass", score: 90,
        assessments: [{ targetPath: "", dimensions: ["attention", "payoff", "expression"].map(dimension => ({ dimension, score: 90, evidence: "受控文案" })) }],
        summary: "受控文案建议", issues: [], repairInstructions: [], planningDisposition: null, hostReadinessReview: null };
    return { output: JSON.stringify(output), sessionId: options?.sessionId ?? "019c0000-0000-7000-8000-000000000001",
      trace: { taskKind: task.kind, providerId: "openai", modelId: "controlled-publisher",
      promptVersion: "controlled-publisher", contractDigest: task.expectedContractDigest, prompt: "受控外部执行边界" } };
  } };
  const broker = new CodexBrokerServer({ socketPath: path.join(root, "publisher.sock"), executor,
    idempotencyDirectory: path.join(root, "broker-requests"), sessionDirectory: path.join(root, "broker-sessions") });
  await broker.start();
  try {
    const setup = await child("setup", "final", "publisher", root);
    assert.equal(setup.code, 0, setup.stderr);
    assert.equal(submissions.length, 0);
    const beforeEffects = await readFile(path.join(root, "side-effects.jsonl"), "utf8");
    const crash = await child("crash", "final", "publisher", root, process => { crashProcess = process; });
    assert.equal(crash.signal, "SIGKILL", crash.stderr || JSON.stringify(crash.run?.nodeRuns.filter(node => node.status === "failed")));
    release();
    await waitForCrashedLeaseExpiry(root, setup.run!.id);
    const recovered = await child("recover", "final", "publisher", root);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(recovered.run?.status, "needs_human");
    const stop = recovered.run!.nodeRuns.find(node => node.status === "needs_human")!;
    assert.equal(stop.nodeId, "publish-package", "文案仍停用户，不能把终审批准当文案采用");
    assert.deepEqual(submissions, ["publish-copy", "role-audit"], "原文案只生产一次，取回后只执行尚未受理的首次审计");
    assert.equal(await readFile(path.join(root, "side-effects.jsonl"), "utf8"), beforeEffects);
    const receipt = recovered.run!.reviewContinuationOperations!.find(item => item.commandId === "same-command")!;
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.resultInterventionId, stop.intervention!.id);
    const replay = await child("recover", "final", "publisher", root);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(replay.run, recovered.run);
    console.log(JSON.stringify({ window: "publisher-accepted", root, crashPid: crash.pid, recoveryPid: recovered.pid,
      runId: recovered.run!.id, submissions, decisionCount: recovered.run!.decisions.length }));
  } finally { release(); await broker.close(); }
});
for (const [mode, windows] of [["prepare", ["W1", "W2", "W3"]], ["approve", ["W1", "W3"]]] as const) {
  for (const window of windows) it(`recovers ${mode}/${window} after real child death without duplicate requests or decisions`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-continuation-crash-"));
    const setup = await child("setup", mode, window, root);
    assert.equal(setup.code, 0, setup.stderr);
    assert.ok(setup.run);
    const originalVersion = setup.run.nodeRuns.find(node => node.nodeId === "render")!.outputState;
    const beforeEffects = await readFile(path.join(root, "side-effects.jsonl"), "utf8");
    const crash = await child("crash", mode, window, root);
    assert.equal(crash.signal, "SIGKILL", crash.stderr);
    const persisted = JSON.parse(await readFile(path.join(root, "runs", setup.run.id, "run.json"), "utf8")) as WorkflowRun;
    assert.equal(persisted.reviewContinuationOperations?.length, 1);
    // 等真实租约过期，不删除/篡改锁或进程状态。
    await waitForCrashedLeaseExpiry(root, setup.run.id);
    const recovered = await child("recover", mode, window, root);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.ok(recovered.run);
    assert.notEqual(recovered.pid, crash.pid);
    assert.equal(recovered.run.status, "needs_human");
    assert.deepEqual(recovered.run.nodeRuns.find(node => node.nodeId === "render")!.outputState, originalVersion);
    assert.equal(recovered.run.decisions.length, setup.run.decisions.length + (mode === "approve" ? 1 : 0));
    const stop = recovered.run.nodeRuns.find(node => node.status === "needs_human")!;
    assert.equal(stop.nodeId, mode === "approve" ? "final-review" : "visual-review");
    assert.equal(recovered.run.reviewContinuationOperations?.[0]?.resultInterventionId, stop.intervention?.id);
    const afterEffects = (await readFile(path.join(root, "side-effects.jsonl"), "utf8")).split("\n").filter(line => line && !JSON.parse(line).kind.startsWith("kill:")).join("\n") + "\n";
    assert.equal(afterEffects, beforeEffects, "接续只处理本地状态，不增加原审计或媒体发送");
    const replay = await child("recover", mode, window, root);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(replay.run, recovered.run, "已消费命令只返回原身份/最新记录，不复活旧停点");
    console.log(JSON.stringify({ mode, window, root, crashPid: crash.pid, recoveryPid: recovered.pid,
      runId: recovered.run.id, revision: recovered.run.revision, submitDelta: 0, decisionCount: recovered.run.decisions.length }));
  });
}
