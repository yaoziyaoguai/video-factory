import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

describe("production package entrypoint", () => {
  it("is importable from its workspace package name after build", async () => {
    const production = await import("@video-factory/production-pipeline");

    assert.equal(typeof production.ProductionPipeline, "function");
    assert.equal(typeof production.PythonWorkerClient, "function");
    assert.equal(typeof production.runCli, "function");
  });

  it("runs the built CLI help entrypoint", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "packages/production-pipeline/dist/cli.js",
      "--help",
    ]);

    assert.match(stdout, /factory run <brief\.json>/);
  });
});
