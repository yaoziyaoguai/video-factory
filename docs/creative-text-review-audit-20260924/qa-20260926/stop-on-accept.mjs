// W3 的有界故障注入：必须先看到新增物理请求和真实 running，再终止指定测试 Studio。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const studioPid = Number(process.argv[2]);
const afterSequence = Number(process.argv[3]);
const runPath = "/tmp/vf-qa/studio-workspace/runs/run-45465ebc-f8be-40ca-ae72-94a75af178c3/run.json";
for (let i = 0; i < 300; i += 1) {
  const stats = await fetch("http://127.0.0.1:4390/stats").then(r => r.json());
  const sequence = stats.pending.find(item => item > afterSequence);
  if (sequence) {
    const run = JSON.parse(await readFile(runPath, "utf8"));
    assert.equal(run.status, "running");
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "stop-studio-before-provider-result", studioPid,
      sequence, runStatus: run.status, command: run.creativeReviewOperations.at(-1) }));
    process.kill(studioPid, "SIGKILL");
    await fetch("http://127.0.0.1:4390/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ release: sequence }) });
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "provider-released-while-studio-offline", sequence }));
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw new Error("No accepted pending Provider request within the bounded injection window.");
