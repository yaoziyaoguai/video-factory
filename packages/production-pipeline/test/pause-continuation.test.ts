import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { ProductionPipeline, PauseRequestConflictError, type WorkerResponse } from "../src/index.js";
import type { FileRunStore } from "../src/run-store.js";

const brief = {
  protocolVersion: "video-factory/brief-v1", title: "暂停与恢复", angle: "受控测试", audience: "",
  nicheSlug: "life-avoidance", durationSeconds: 30, platform: "douyin", reviewMode: "manual", runPurpose: "test",
  providers: { script: "python-template-v1", assets: "local-editorial-v1", voice: "macos-say-v1",
    render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
  voiceDirection: { profileId: "macos:Sandy (中文（中国大陆）)", rate: 178, pauseScale: 1.25, masteringPreset: "intimate" },
} as const;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class SequenceWorker {
  readonly stages = [0, 1].map(() => ({ entered: gate(), release: gate() }));
  calls = 0;
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    if (capability === "script.draft") {
      const index = this.calls++;
      const stage = this.stages[index]!;
      stage.entered.resolve();
      await stage.release.promise;
      if (index === 0) throw new Error("controlled initial failure");
    }
    const dir = String(request.outputDir);
    await mkdir(dir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(dir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(dir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(dir, "voiceover_plan.json"), trackPath: path.join(dir, "narration.m4a") },
      "video.render": { videoPath: path.join(dir, "final.mp4"), renderManifestPath: path.join(dir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(dir, "review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `unexpected capability ${capability}`);
    const script = { scenes: [1, 2].map(position => ({ position,
      narration: `第${position}幕`, duration: 5, visual_strategy: "stock", visual_prompt: "城市早餐摊",
      on_screen_text: "早餐", sound_cue: "环境声" })) };
    const artifacts = await Promise.all(Object.values(output).filter(value => typeof value === "string").map(async uri => {
      const content = capability === "script.draft" ? script : uri === output.renderManifestPath
        ? { duration_target: 10, slides: [1, 2].map(position => ({ position, duration: 5 })) } : { capability };
      const bytes = Buffer.from(JSON.stringify(content));
      await writeFile(String(uri), bytes);
      return { kind: capability.replace(".", "_"), uri: String(uri),
        sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
        contentType: "application/json", provenance: { providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId), attempt: Number(request.attempt), licenseNote: "controlled fixture" } };
    }));
    return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded",
      output, artifacts };
  }
  releaseAll() { this.stages.forEach(stage => stage.release.resolve()); }
}

type Internals = {
  withPauseControlLock<T>(runId: string, action: () => Promise<T>): Promise<T>;
  store: FileRunStore;
};

it("serializes a retry with a pause that already holds the lock and has read the old revision", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-read-write-"));
  const worker = new SequenceWorker();
  const subject = new ProductionPipeline({ workspaceRoot, worker });
  const internal = subject as unknown as Internals;
  const enteredRead = gate(), returnRead = gate(), retryEnteredLock = gate();
  const originalLock = internal.withPauseControlLock.bind(subject);
  const originalLoad = internal.store.load.bind(internal.store);
  let insidePauseLock = false, captured = false, retrying = false;
  internal.withPauseControlLock = (id, action) => {
    if (retrying) retryEnteredLock.resolve();
    return originalLock(id, async () => {
      insidePauseLock = true;
      try { return await action(); } finally { insidePauseLock = false; }
    });
  };
  internal.store.load = async <TInitialInput>(runId: string) => {
    const value = await originalLoad<TInitialInput>(runId);
    if (insidePauseLock && !captured) {
      captured = true;
      enteredRead.resolve();
      await returnRead.promise;
    }
    return value;
  };
  let first: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  let second: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  try {
    first = await subject.dispatch(brief);
    await worker.stages[0]!.entered.promise;
    const pause = subject.requestPause(first.runId);
    await enteredRead.promise;
    worker.stages[0]!.release.resolve();
    const failed = await first.completion;
    assert.equal(failed.status, "failed");
    retrying = true;
    const retry = subject.dispatchRetryFailedNode(first.runId, "script");
    const outcome = retry.then(value => { second = value; return "started"; }, error => error);
    // 实际磁盘锁内读取屏障，不替换暂停/恢复规则；旧实现无标记快路径会先启动 provider。
    await Promise.race([retryEnteredLock.promise, worker.stages[1]!.entered.promise]);
    const callsWhileLocked = worker.calls;
    returnRead.resolve();
    await pause;
    const result = await outcome;
    worker.stages[1]!.release.resolve();
    if (second) await second.completion;
    assert.equal(callsWhileLocked, 1, "持锁的旧暂停尚未完成时不得启动后一次 provider");
    assert.ok(result instanceof PauseRequestConflictError, "未提交匹配暂停身份的恢复应拒绝");
    assert.equal((await subject.loadPersisted(first.runId)).revision, failed.revision);
    assert.ok(await subject.readPauseRequest(first.runId));
  } finally {
    returnRead.resolve();
    worker.releaseAll();
    if (first) await first.completion.catch(() => undefined);
    if (second) await second.completion.catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("keeps an old pause outside the entire first-revision write even when no marker exists yet", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-first-save-"));
  const worker = new SequenceWorker();
  const subject = new ProductionPipeline({ workspaceRoot, worker });
  const internal = subject as unknown as Internals;
  const firstSave = gate(), releaseSave = gate();
  const originalSave = internal.store.save.bind(internal.store);
  const originalLock = internal.withPauseControlLock.bind(subject);
  let retrying = false;
  internal.store.save = async (...args) => {
    if (retrying) { firstSave.resolve(); await releaseSave.promise; }
    return originalSave(...args);
  };
  let second: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  try {
    const first = await subject.dispatch(brief);
    await worker.stages[0]!.entered.promise;
    // 暂停先读 running 旧轮次，再排队取锁；它不能在恢复已取锁但尚未落盘时写标记。
    const pauseReady = gate(), enterPauseLock = gate();
    internal.withPauseControlLock = (id, action) => {
      if (!retrying) {
        pauseReady.resolve();
        return enterPauseLock.promise.then(() => originalLock(id, action));
      }
      return originalLock(id, action);
    };
    const pause = subject.requestPause(first.runId);
    const pauseOutcome = pause.then(() => undefined, error => error);
    await pauseReady.promise;
    worker.stages[0]!.release.resolve();
    const failed = await first.completion;
    retrying = true;
    const retry = subject.dispatchRetryFailedNode(first.runId, "script");
    await firstSave.promise;
    // 切入真实文件锁等待；先保证请求发起，再解除保存屏障。
    enterPauseLock.resolve();
    releaseSave.resolve();
    second = await retry;
    const error = await pauseOutcome;
    assert.ok(error instanceof PauseRequestConflictError);
    assert.equal((await subject.loadPersisted(first.runId)).revision, failed.revision + 1);
    assert.equal(await subject.readPauseRequest(first.runId), undefined);
    worker.stages[1]!.release.resolve();
    assert.equal((await second.completion).status, "needs_human");
  } finally {
    releaseSave.resolve();
    worker.releaseAll();
    if (second) await second.completion.catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

for (const fault of ["save-before-write", "save-after-write", "delete", "checkpoint-before-write", "checkpoint-after-write"] as const) {
  it(`retains a recoverable stop and starts no provider when continuation ${fault} fails`, async (t) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-fault-"));
    const worker = new SequenceWorker();
    const subject = new ProductionPipeline({ workspaceRoot, worker });
    const internal = subject as unknown as Internals;
    const originalSave = internal.store.save.bind(internal.store);
    const originalCheckpoint = internal.store.checkpoint.bind(internal.store);
    const originalRm = fs.rm;
    const failure = new Error(`controlled ${fault} failure`);
    let second: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
    try {
      const first = await subject.dispatch(brief);
      await worker.stages[0]!.entered.promise;
      await subject.requestPause(first.runId);
      const token = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
      worker.stages[0]!.release.resolve();
      const failed = await first.completion;
      const markerPath = path.join(workspaceRoot, "runs", first.runId, ".pause-request.json");
      const markerBytes = await readFile(markerPath, "utf8");
      let injected = false;
      if (fault.startsWith("save-")) {
        internal.store.save = async (...args) => {
          if (injected) return originalSave(...args);
          injected = true;
          if (fault === "save-after-write") await originalSave(...args);
          throw failure;
        };
      } else if (fault === "delete") {
        t.mock.method(fs, "rm", async (...args: Parameters<typeof rm>) => {
          if (!injected && args[0] === markerPath) { injected = true; throw failure; }
          return originalRm(...args);
        });
        syncBuiltinESMExports();
      } else {
        internal.store.checkpoint = async (...args) => {
          if (injected) return originalCheckpoint(...args);
          injected = true;
          if (fault === "checkpoint-after-write") await originalCheckpoint(...args);
          throw failure;
        };
      }
      await assert.rejects(subject.dispatchRetryFailedNode(first.runId, "script", undefined, { pauseRequestId: token }), error => error === failure);
      assert.equal(injected, true);
      assert.equal(worker.calls, 1, "失败的恢复不得启动 provider");
      const retained = await subject.loadPersisted(first.runId);
      assert.equal(retained.status, "failed", "不得留下没有执行者的 running");
      assert.deepEqual(retained.nodeRuns, failed.nodeRuns, "原停点、错误和产物不被转换覆盖");
      assert.equal(await readFile(markerPath, "utf8"), markerBytes, "原 token 字节保留或恢复");
      assert.equal(retained.revision, failed.revision + (fault === "save-before-write" ? 0 : 1));
      internal.store.save = originalSave;
      internal.store.checkpoint = originalCheckpoint;
      t.mock.restoreAll(); syncBuiltinESMExports();
      second = await subject.dispatchRetryFailedNode(first.runId, "script", undefined, { pauseRequestId: token });
      worker.stages[1]!.release.resolve();
      assert.equal((await second.completion).status, "needs_human", "存储恢复后同一停点可重新显式继续");
      assert.equal(await subject.readPauseRequest(first.runId), undefined);
      assert.equal(worker.calls, 2);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      internal.store.save = originalSave;
      internal.store.checkpoint = originalCheckpoint;
      worker.releaseAll();
      if (second) await second.completion.catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

it("serializes a real second-process pause with retry and permits a later matching-token continuation", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-two-process-"));
  const worker = new SequenceWorker();
  const subject = new ProductionPipeline({ workspaceRoot, worker });
  const first = await subject.dispatch(brief);
  await worker.stages[0]!.entered.promise;
  const child = fork(fileURLToPath(new URL("./helpers/pause-process.ts", import.meta.url)), [workspaceRoot, first.runId], {
    execArgv: ["--import", "tsx"],
    env: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exit = once(child, "exit");
  const errors: string[] = [];
  child.stderr?.on("data", chunk => errors.push(String(chunk)));
  let resumed: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  try {
    const [held] = await once(child, "message");
    assert.equal(held.kind, "locked-read");
    worker.stages[0]!.release.resolve();
    const failed = await first.completion;
    assert.equal(failed.status, "failed");
    const internal = subject as unknown as Internals;
    const lockEntered = gate();
    const lock = internal.withPauseControlLock.bind(subject);
    internal.withPauseControlLock = (id, action) => { lockEntered.resolve(); return lock(id, action); };
    const retry = subject.dispatchRetryFailedNode(first.runId, "script");
    const rejected = retry.then(value => { resumed = value; return undefined; }, error => error);
    await Promise.race([lockEntered.promise, worker.stages[1]!.entered.promise]);
    const callsWhileLocked = worker.calls;
    const completedMessage = once(child, "message");
    child.send("release");
    const [completed] = await completedMessage;
    assert.equal(completed.kind, "completed", errors.join(""));
    assert.deepEqual(await exit, [0, null], errors.join(""));
    assert.ok(await rejected instanceof PauseRequestConflictError);
    assert.equal(callsWhileLocked, 1);
    assert.equal((await subject.loadPersisted(first.runId)).revision, held.revision);
    const token = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
    resumed = await subject.dispatchRetryFailedNode(first.runId, "script", undefined, { pauseRequestId: token });
    worker.stages[1]!.release.resolve();
    assert.equal((await resumed.completion).status, "needs_human");
    assert.equal(await subject.readPauseRequest(first.runId), undefined);
    assert.equal(worker.calls, 2);
  } finally {
    worker.releaseAll();
    if (child.connected) child.send("release");
    if (child.exitCode === null) child.kill();
    await exit;
    await first.completion.catch(() => undefined);
    if (resumed) await resumed.completion.catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("notifies after unlocking and preserves a new pause requested by the first durable notification", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-notification-"));
  const worker = new SequenceWorker();
  const subject = new ProductionPipeline({ workspaceRoot, worker });
  let resumed: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  try {
    const first = await subject.dispatch(brief);
    await worker.stages[0]!.entered.promise;
    await subject.requestPause(first.runId);
    const oldToken = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
    worker.stages[0]!.release.resolve();
    await first.completion;
    let newToken: string | undefined;
    resumed = await subject.dispatchRetryFailedNode(first.runId, "script", async run => {
      if (run.status === "running" && !newToken) {
        // 此请求需要同一暂停短锁；listener 若仍在锁内便无法返回。
        await subject.requestPause(first.runId);
        newToken = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
      }
    }, { pauseRequestId: oldToken });
    worker.stages[1]!.release.resolve();
    assert.equal((await resumed.completion).status, "paused");
    assert.ok(newToken);
    assert.notEqual(newToken, oldToken);
    assert.equal((await subject.readPauseRequest(first.runId))!.pauseRequestId, newToken);
    assert.equal(worker.calls, 2, "新暂停在当前节点完成的安全边界生效，不能被后续 checkpoint 解除");
    resumed = await subject.dispatchResumePaused(first.runId, undefined, { pauseRequestId: newToken });
    worker.stages[1]!.release.resolve();
    assert.equal((await resumed.completion).status, "needs_human");
  } finally {
    worker.releaseAll();
    if (resumed) await resumed.completion.catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("preserves the original error and pause intent when both checkpoint and rollback fail", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-double-fault-"));
  const worker = new SequenceWorker();
  const subject = new ProductionPipeline({ workspaceRoot, worker });
  const internal = subject as unknown as Internals;
  const checkpoint = internal.store.checkpoint.bind(internal.store);
  let resumed: Awaited<ReturnType<ProductionPipeline["dispatch"]>> | undefined;
  try {
    const first = await subject.dispatch(brief);
    await worker.stages[0]!.entered.promise;
    await subject.requestPause(first.runId);
    const token = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
    worker.stages[0]!.release.resolve();
    await first.completion;
    const failure = new Error("controlled checkpoint storage failure");
    const rollbackFailure = new Error("controlled rollback storage failure");
    let calls = 0;
    internal.store.checkpoint = async () => { throw ++calls === 1 ? failure : rollbackFailure; };
    await assert.rejects(subject.dispatchRetryFailedNode(first.runId, "script", undefined, { pauseRequestId: token }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, failure);
      assert.deepEqual(error.errors, [failure, rollbackFailure]);
      return true;
    });
    assert.equal(worker.calls, 1);
    assert.equal((await subject.loadPersisted(first.runId)).status, "failed", "预保存停点在两次失败下仍然有效");
    assert.equal((await subject.readPauseRequest(first.runId))!.pauseRequestId, token);
    internal.store.checkpoint = checkpoint;
    resumed = await subject.dispatchRetryFailedNode(first.runId, "script", undefined, { pauseRequestId: token });
    worker.stages[1]!.release.resolve();
    assert.equal((await resumed.completion).status, "needs_human");
  } finally {
    internal.store.checkpoint = checkpoint;
    worker.releaseAll();
    if (resumed) await resumed.completion.catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("recovers real process exits after staged save and marker deletion with zero new provider calls", { timeout: 60_000 }, async () => {
  const fixtures: Array<{
    workspaceRoot: string; subject: ProductionPipeline; worker: SequenceWorker; runId: string;
    token: string; child: ReturnType<typeof fork>; exit: Promise<unknown[]>;
  }> = [];
  try {
    // 两个独立工作区同时等待真实锁过期，既不删锁也不改mtime，不把异常抛出当进程崩溃。
    for (const cut of ["save", "delete"] as const) {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), `vf-pause-crash-${cut}-`));
      const worker = new SequenceWorker();
      const subject = new ProductionPipeline({ workspaceRoot, worker });
      const first = await subject.dispatch(brief);
      await worker.stages[0]!.entered.promise;
      await subject.requestPause(first.runId);
      const token = (await subject.readPauseRequest(first.runId))!.pauseRequestId;
      worker.stages[0]!.release.resolve();
      const failed = await first.completion;
      const child = fork(fileURLToPath(new URL("./helpers/pause-continuation-crash-process.ts", import.meta.url)),
        [workspaceRoot, first.runId, token, cut], {
          execArgv: ["--import", "tsx"],
          env: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      const exit = once(child, "exit");
      fixtures.push({ workspaceRoot, subject, worker, runId: first.runId, token, child, exit });
      let childProviderCalls = 0;
      child.on("message", message => { if ((message as { kind?: string }).kind === "provider-started") childProviderCalls++; });
      const [boundary] = await once(child, "message");
      assert.equal(boundary.kind, "cut");
      assert.equal(boundary.status, "failed");
      assert.equal(boundary.cut, cut);
      child.kill("SIGKILL");
      assert.deepEqual(await exit, [null, "SIGKILL"]);
      const stopped = await subject.loadPersisted(first.runId);
      assert.equal(stopped.status, "failed");
      assert.equal(stopped.revision, failed.revision + 1);
      assert.deepEqual(stopped.nodeRuns, failed.nodeRuns);
      assert.equal(Boolean(await subject.readPauseRequest(first.runId)), cut === "save");
      assert.equal(childProviderCalls, 0);
    }
    await new Promise(resolve => setTimeout(resolve, 31_100));
    for (const { subject, worker, runId, token } of fixtures) {
      const resumed = await subject.dispatchRetryFailedNode(runId, "script", undefined, { pauseRequestId: token });
      worker.stages[1]!.release.resolve();
      assert.equal((await resumed.completion).status, "needs_human");
      assert.equal(worker.calls, 2);
      assert.equal(await subject.readPauseRequest(runId), undefined);
    }
  } finally {
    for (const fixture of fixtures) {
      fixture.worker.releaseAll();
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL");
      await fixture.exit;
      await rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  }
});
