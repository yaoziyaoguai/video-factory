import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { ProductionPipeline } from "../../src/index.js";
import type { FileRunStore } from "../../src/run-store.js";

const [workspaceRoot, runId, token, cut] = process.argv.slice(2);
if (!workspaceRoot || !runId || !token || !["save", "delete"].includes(cut ?? "") || !process.send) {
  throw new Error("crash child requires workspace, run, token, cut and IPC");
}
process.on("message", () => { /* keep the controlled child alive until its parent terminates it */ });
const subject = new ProductionPipeline({ workspaceRoot, worker: { run: async () => {
  process.send!({ kind: "provider-started" });
  throw new Error("provider must not start before the crash boundary");
} } });
const hold = async () => {
  process.send!({ kind: "cut", cut, status: (await subject.loadPersisted(runId)).status });
  await new Promise<void>(() => { /* parent kills this exact child after recording the durable state */ });
};
if (cut === "save") {
  const store = (subject as unknown as { store: FileRunStore }).store;
  const save = store.save.bind(store);
  store.save = async (...args) => { await save(...args); await hold(); };
} else {
  const remove = fs.rm;
  fs.rm = async (...args) => {
    await remove(...args);
    if (args[0] === path.join(workspaceRoot, "runs", runId, ".pause-request.json")) await hold();
  };
  syncBuiltinESMExports();
}
await subject.dispatchRetryFailedNode(runId, "script", undefined, { pauseRequestId: token });
throw new Error("the parent should kill the child before dispatch returns");
