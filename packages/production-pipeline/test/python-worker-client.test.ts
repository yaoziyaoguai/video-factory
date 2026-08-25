import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PythonWorkerClient } from "../src/index.js";

describe("PythonWorkerClient", () => {
  it("exchanges one versioned JSON request and response with the real Python worker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-worker-client-"));
    const repositoryRoot = process.cwd();
    const client = new PythonWorkerClient({
      command: ["python3", "-m", "video_factory.worker"],
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") },
      timeoutMs: 10_000,
    });

    const response = await client.run({
      protocolVersion: "video-factory/worker-v1",
      commandId: "command-real-worker",
      runId: "run-real-worker",
      nodeRunId: "script",
      attempt: 1,
      capability: "script.draft",
      input: {
        brief: {
          protocolVersion: "video-factory/brief-v1",
          title: "做决定前，先避开这 3 个坑",
          angle: "低风险、可收藏的生活清单",
          audience: "有决策压力的普通上班族",
          nicheSlug: "life-avoidance",
          durationSeconds: 30,
          platform: "douyin",
        },
      },
      parameters: { providerId: "python-template-v1" },
      outputDir: path.join(root, "script"),
    });

    assert.equal(response.status, "succeeded");
    assert.equal(response.commandId, "command-real-worker");
    assert.ok(Array.isArray(response.artifacts));
  });

  it("rejects malformed stdout instead of treating a successful process as a successful node", async () => {
    const client = new PythonWorkerClient({
      command: [process.execPath, "-e", "process.stdout.write('not-json')"],
      timeoutMs: 2_000,
    });

    await assert.rejects(
      () => client.run({ protocolVersion: "video-factory/worker-v1", commandId: "bad-response" }),
      /valid JSON/,
    );
  });

  it("rejects malformed artifact descriptors at the protocol boundary", async () => {
    const response = JSON.stringify({
      protocolVersion: "video-factory/worker-v1",
      commandId: "bad-artifact",
      status: "succeeded",
      output: {},
      artifacts: [{ kind: "render" }],
    });
    const client = new PythonWorkerClient({
      command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(response)})`],
      timeoutMs: 2_000,
    });

    await assert.rejects(
      () => client.run({ protocolVersion: "video-factory/worker-v1", commandId: "bad-artifact" }),
      /artifact 0 uri/i,
    );
  });

  it("terminates worker descendants when the worker times out", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-worker-tree-"));
    const pidPath = path.join(root, "child.pid");
    const scriptPath = path.join(root, "worker.cjs");
    await writeFile(
      scriptPath,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "writeFileSync(process.argv[2], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const client = new PythonWorkerClient({
      command: [process.execPath, scriptPath, pidPath],
      timeoutMs: 300,
    });

    await assert.rejects(
      () => client.run({ protocolVersion: "video-factory/worker-v1", commandId: "timeout" }),
      /timed out/,
    );
    const childPid = Number(await readFile(pidPath, "utf8"));
    try {
      assert.equal(await waitForProcessExit(childPid), true, `Descendant process ${childPid} is still running.`);
    } finally {
      if (isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });
});

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
