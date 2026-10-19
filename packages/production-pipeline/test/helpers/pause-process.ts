import { ProductionPipeline } from "../../src/index.js";

// 独立进程运行正式 requestPause，只在磁盘读取边界加屏障；锁由生产实现实际取得。
const [workspaceRoot, runId] = process.argv.slice(2);
if (!workspaceRoot || !runId || !process.send) throw new Error("pause child requires workspace, run and IPC");
const subject = new ProductionPipeline({ workspaceRoot, worker: { run: async () => { throw new Error("pause must not start providers"); } } });
const internal = subject as unknown as {
  withPauseControlLock<T>(id: string, action: () => Promise<T>): Promise<T>;
  store: { load: ProductionPipeline["loadPersisted"] };
};
const originalLock = internal.withPauseControlLock.bind(subject);
const originalLoad = internal.store.load.bind(internal.store);
let locked = false, captured = false;
let release!: () => void;
const released = new Promise<void>(resolve => { release = resolve; });
process.on("message", message => { if (message === "release") release(); });
internal.withPauseControlLock = (id, action) => originalLock(id, async () => {
  locked = true;
  try { return await action(); } finally { locked = false; }
});
internal.store.load = async (...args) => {
  const run = await originalLoad(...args);
  if (locked && !captured) {
    captured = true;
    process.send!({ kind: "locked-read", revision: run.revision });
    await released;
  }
  return run;
};
try {
  await subject.requestPause(runId);
  process.send({ kind: "completed", marker: await subject.readPauseRequest(runId) });
} catch (error) {
  process.send({ kind: "failed", name: error instanceof Error ? error.name : "Error", message: String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
