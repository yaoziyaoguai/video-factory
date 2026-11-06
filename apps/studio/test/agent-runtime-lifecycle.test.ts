import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

for (const signal of ["SIGTERM", "SIGINT", "SIGKILL"] as const) test(`A-35/39/42 ${signal} with a real SSE and active Pi turn: restart from persisted facts`, { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-lifecycle-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers/agent-runtime-child.mjs"), dataDir, String(port)], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exit = once(child, "exit");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  while (!stdout.includes('"listening"')) {
    assert.ok(Date.now() < deadline && child.exitCode === null, stderr || "child did not start");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const base = `http://127.0.0.1:${port}`;
  const post = async (url: string, body: unknown) => {
    const response = await fetch(`${base}${url}`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-video-factory-request": "studio" }, body: JSON.stringify(body) });
    assert.ok(response.ok); return response.json() as Promise<any>;
  };
  const { id } = await post("/api/agent/v1/conversations", { commandId: "cmd-session", title: "lifecycle" });
  const snapshot = await fetch(`${base}/api/agent/v1/conversations/${id}/snapshot`).then(response => response.json()) as any;
  const stream = await fetch(`${base}/api/agent/v1/conversations/${id}/events?cursor=${encodeURIComponent(snapshot.eventCursor)}`);
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type")!, /event-stream/);
  const reader = stream.body!.getReader();
  const receipt = await post(`/api/agent/v1/conversations/${id}/messages`, { commandId: "cmd-stream", text: "stream", target: null, mode: "new", skillId: null, proposalRef: null, steerRequestId: null });
  let chunks = "";
  while (!chunks.includes("event: text.delta")) { const { value, done } = await reader.read(); assert.equal(done, false); chunks += new TextDecoder().decode(value); }
  child.kill(signal);
  const [code, observedSignal] = await exit;
  if (signal === "SIGKILL") assert.equal(observedSignal, "SIGKILL"); else assert.equal(code, 0, stderr);
  await reader.cancel().catch(() => {});
  for (const line of stdout.trim().split("\n")) {
    const evidence = JSON.parse(line);
    assert.deepEqual(evidence.counts, { externalFetch: 0, outboundSockets: 0, secretReads: 0, legacyRuntimeModules: 0 });
  }
  t.diagnostic(JSON.stringify({ signal, exitCode: code, exitSignal: observedSignal,
    conversationId: id, requestId: receipt.requestId, instrumentation: stdout.trim().split("\n").map(line => JSON.parse(line)) }));
  const restarted = await assembleOfflineAgent({ dataDir, uiOrigin: base, fauxResponses: [fauxAssistantMessage("new request after restart")] });
  try {
    const read = restarted.service.snapshot("local-owner", id);
    assert.equal(read.artifacts.items.length, 0);
    const user = read.messages.items.find(message => message.id === receipt.messageId)!;
    assert.equal(user.state, signal === "SIGKILL" ? "failed" : "stopped");
    if (signal === "SIGKILL") assert.equal(read.messages.items.filter(message => message.role === "assistant").length, 0, "transient text must not become persisted output");
    const replay = await restarted.service.sendMessage("local-owner", id, { commandId: "cmd-stream", text: "stream", target: null, mode: "new", skillId: null, proposalRef: null, steerRequestId: null });
    assert.equal(replay.receipt.requestId, receipt.requestId);
    assert.equal((restarted.database.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n, 1);
  } finally { await restarted.close(); }
});
