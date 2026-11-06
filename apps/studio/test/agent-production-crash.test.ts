import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { productionHarness } from "./helpers/production-harness.js";

for (const point of ["before-admission-commit", "after-admission-commit", "after-attempt-prepared", "after-submit-started", "before-result-commit", "after-result-commit", "local-after-result-commit"]) {
  it(`B 崩溃窗口 ${point}：真实 SIGKILL 后恢复身份、占用与输出`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "frame-b-crash-"));
    try {
      const time = "2026-10-26T01:00:00.000Z";
      const local = point.startsWith("local-");
      const crashPoint = local ? "after-result-commit" : point;
      const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers/agent-production-crash-child.ts"), directory, time, crashPoint, local ? "render" : "video"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timed out: ${err}`)); }, 30_000);
        child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
        child.once("error", reject);
      });
      assert.equal(exit.signal, "SIGKILL", err); assert.match(out, new RegExp(`crash:${crashPoint}`));
      const resumed = productionHarness(directory, "2026-10-26T01:02:00.000Z", undefined, local);
      try {
        const count = (table: string) => (resumed.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        assert.equal(count("production_runs"), point === "before-admission-commit" ? 0 : 1);
        const admission = resumed.accept();
        await resumed.worker.pollOnce(); await resumed.worker.pollOnce();
        const run = resumed.service.get("owner", admission.run.id);
        assert.equal(count("production_runs"), 1); assert.equal(count("authorizations"), 1);
        const jobs = (resumed.port.providerDb.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
        if (point === "after-submit-started") {
          // 输入锁同时覆盖 spec 输入与方案主稿：制作期间主稿同样不可改（admit 的有限来源锁定）。
          assert.equal(run.state, "unknown"); assert.equal(jobs, 0, "是否发出不明时不盲目首次/再次 create"); assert.equal(count("production_input_locks"), 2);
        } else {
          assert.equal(run.state, "succeeded"); assert.equal(jobs, local ? 2 : 1); assert.equal(run.outputRevisions.length, local ? 2 : 1);
          assert.equal(run.finance.settledMinor, 1200); assert.equal(run.finance.state, "settled"); assert.equal(count("production_input_locks"), 0);
        }
        assert.equal(count("production_attempts"), local ? 2 : 1);
      } finally { await resumed.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
