import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { holdMaintenanceWork, transitionMaintenanceGate } from "@video-factory/production-pipeline/maintenance";
import { buildStudioApp, type StudioServicePort } from "../../src/server/app.js";
import { MaintenanceGate } from "../../src/server/maintenance-gate.js";
import { installStudioLifecycle } from "../../src/server/server-lifecycle.js";
import type { StudioRunDetail } from "../../src/shared/api.js";

const [directory, mode = "idle"] = process.argv.slice(2);
if (!directory) throw new Error("Lifecycle fixture requires a directory.");
await mkdir(directory, { recursive: true });
const maintenanceDirectory = path.join(directory, "maintenance");
await transitionMaintenanceGate(maintenanceDirectory, "open", "lifecycle-test");
const maintenanceGate = new MaintenanceGate({ directory: maintenanceDirectory });
const report = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
async function waitFor(name: string): Promise<void> {
  for (;;) {
    try { await readFile(path.join(directory!, name)); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // 只有 unref 工作时，退出流程也必须保持进程直到最终写入完成。
    await delay(20, undefined, { ref: false });
  }
}
async function persist(name: string): Promise<void> {
  await writeFile(path.join(directory!, `${name}.tmp`), "complete\n");
  await rename(path.join(directory!, `${name}.tmp`), path.join(directory!, name));
}
if (mode === "admission") {
  const admit = maintenanceGate.admit.bind(maintenanceGate);
  maintenanceGate.admit = async (kind, parent) => {
    report({ event: "admitting" });
    await waitFor("finish-admission");
    return admit(kind, parent);
  };
}
const service = {
  health: async () => ({ status: "ok", runtime: {} }),
  getRun: async () => ({ id: "run-1", status: "needs_human", revision: 1 }) as StudioRunDetail,
  subscribe: () => () => report({ event: "unsubscribed" }),
  updateCreatorSettings: async () => {
    report({ event: "handler" });
    holdMaintenanceWork((async () => {
      await waitFor("finish-work");
      holdMaintenanceWork((async () => { await waitFor("finish-descendant"); await persist("descendant.done"); })());
      await persist("work.done");
    })());
    return {};
  },
} as unknown as StudioServicePort;
const app = buildStudioApp({ service, maintenanceGate });
app.addHook("preClose", async () => { report({ event: "closing" }); });
let recoveryCalls = 0;
installStudioLifecycle({
  app,
  maintenanceGate,
  recoveryIntervalMs: mode === "recovery" ? 20 : 30_000,
  recoverInterruptedRuns: async () => {
    recoveryCalls += 1;
    report({ event: "recovery", count: recoveryCalls });
    await waitFor("finish-recovery");
    await persist("recovery.done");
  },
  activeWork: async () => {
    if (mode !== "service") return;
    report({ event: "service-drain" });
    await waitFor("finish-service");
    await persist("service.done");
  },
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });
report({ event: "ready", address, pid: process.pid });
