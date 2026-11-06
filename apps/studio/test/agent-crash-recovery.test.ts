import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { OFFLINE_QUOTE_CATALOG } from "../src/server/agent/offline.js";
import { systemClock } from "../src/server/agent/util.js";

// F7（A-26..A-29）：业务事务提交后、Pi 会话保存工具结果前杀死子进程；
// 重启后同一调用取回原回执，不出现第二份提案或第二版本；中断诚实标注并保留安全历史。

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

// 固定端口会被失败运行遗留的子进程占用；先占后放选端口，失败也在 after 里兜底清理。
const children = new Set<ChildProcess>();

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function studioHeaders(base: string): Record<string, string> {
  return { "content-type": "application/json", origin: base, "x-video-factory-request": "studio" };
}

interface ChildHandle {
  process: ChildProcess;
  port: number;
  waitForCrashPoint(): Promise<string>;
  close(): Promise<void>;
}

const helperPath = path.join(repositoryRoot, "apps/studio/test/helpers/agent-crash-child.ts");

async function startChild(options: { scenario: string; crashPoint: string; dataDir: string; port: number }): Promise<ChildHandle> {
  const child = spawn(process.execPath, ["--import", "tsx", helperPath,
    "--scenario", options.scenario, "--crash-point", options.crashPoint,
    "--data-dir", options.dataDir, "--port", String(options.port)],
    { cwd: repositoryRoot, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  const lines: string[] = [];
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    for (const line of buffer.split("\n")) {
      if (line.trim().startsWith("{")) lines.push(line.trim());
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });

  const waitForLine = async (predicate: (line: string) => boolean, timeoutMs = 30_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = lines.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`child line not found; events: ${lines.slice(-8).join("\n")}; stderr: ${stderr.slice(0, 800)}`);
  };

  const listening = JSON.parse(await waitForLine(line => line.includes('"listening"')));
  return {
    process: child,
    port: listening.port as number,
    waitForCrashPoint: () => waitForLine(line => line.includes('"crash-point"')).then(line => JSON.parse(line).point as string),
    close: async () => {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
    },
  };
}

describe("agent crash recovery (F7 receipt window)", () => {
  let directory: string;

  const messageInput = (commandId: string, text: string, extra: Record<string, unknown> = {}) => ({
    commandId, text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, ...extra,
  });

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vf-agent-crash-"));
  });

  after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  it("A-28 交付提交后崩溃：重启取回原回执，不产生第二版本", async t => {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const headers = studioHeaders(base);
    const json = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    const child = await startChild({ scenario: "deliver", crashPoint: "after-deliver-commit", dataDir: directory, port });
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-c1", title: "崩溃恢复" });
    assert.equal(created.status, 201);
    const conversationId = created.body.id;

    const sent = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-m1", "写一个开场"));
    assert.equal(sent.status, 202);
    assert.equal(await child.waitForCrashPoint(), "after-deliver-commit");
    await child.close();

    // 重启：同一数据目录新进程，recover() 标记中断，保留 Pi 先前历史并从安全位置分支。
    const restarted = await startChild({ scenario: "continue", crashPoint: "", dataDir: directory, port });
    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.artifacts.items.length, 1, "交付事实在重启后可读");

    assert.ok(snapshot.body.messages.items.some((item: any) => item.references.artifacts.some((ref: any) => ref.artifactId === snapshot.body.artifacts.items[0].id)), "提交事务内已保存正式消息引用");
    const notice = snapshot.body.messages.items.find((item: any) => item.role === "system_notice");
    assert.ok(notice, "中断系统通知已落库");
    assert.ok(notice.text.includes("中断"));

    const db = openAgentDatabase(directory);
    const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(sent.body.requestId) as any;
    assert.equal(request.state, "failed");
    const conversation = db.prepare("SELECT pi_session_id FROM conversations WHERE id = ?").get(conversationId) as any;
    assert.equal(conversation.pi_session_id, "s1", "保留原 Pi 历史，以安全分支续接");

    // 同一工具调用重放（原 toolCallId + 原参数）：返回原回执，不再产生第二个修订。
    const tools = new BusinessTools(db, systemClock, () => OFFLINE_QUOTE_CATALOG);
    const invocation = db.prepare(
      "SELECT args_json FROM tool_invocations WHERE request_id = ? AND tool_call_id = ?",
    ).get(sent.body.requestId, "call-deliver-1") as { args_json: string };
    const artifact = snapshot.body.artifacts.items[0];
    const replay = await tools.deliverArtifacts({
      actorId: "local-owner", conversationId,
      requestId: sent.body.requestId,
      executionEpoch: request.execution_epoch,
      target: null, toolCallId: "call-deliver-1",
    } as never, JSON.parse(invocation.args_json));
    assert.equal(replay.replayed, true, "重放返回原回执而非二次交付");
    assert.equal(replay.revisions[0]!.artifactId, artifact.id);
    const revisionCount = (db.prepare("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?").get(artifact.id) as any).n;
    assert.equal(revisionCount, 1, "没有产生第二个修订");
    t.diagnostic(JSON.stringify({ point: "after-deliver-commit", exitSignal: child.process.signalCode, conversationId,
      requestId: sent.body.requestId, artifactId: artifact.id, revisionId: artifact.revisionId,
      replayRevisionId: replay.revisions[0]!.revisionId, revisionCount, persistentMessageReference: true }));
    db.close();

    // 保留历史的会话可以继续新话题。
    const resumed = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-m2", "继续聊点别的"));
    assert.equal(resumed.status, 202);
    await waitFor(async () => {
      const snap = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant" && item.state === "completed" && item.text.includes("恢复后"));
    });
    await restarted.close();
  });

  it("A-27 提案提交后崩溃：同 proposalId 可读，不再产生第二份提案", async t => {
    const port2 = await reservePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const child = await startChild({ scenario: "prepare", crashPoint: "after-prepare-commit", dataDir: directory, port: port2 });
    const headers2 = studioHeaders(base2);
    const create = await fetch(`${base2}/api/agent/v1/conversations`, { method: "POST", headers: headers2, body: JSON.stringify({ commandId: "cmd-p0", title: "提案崩溃" }) });
    const conversationId = (await create.json()).id;

    // 第一轮：交付草稿（正常完成）。
    const first = await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers2, body: JSON.stringify(messageInput("cmd-p1", "先给我一份草稿")) });
    assert.equal(first.status, 202);
    await waitFor(async () => {
      const snap = await (await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/snapshot`)).json();
      return snap.artifacts.items.length === 1;
    });

    // 第二轮：prepare 提交后崩溃。
    const second = await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers2, body: JSON.stringify(messageInput("cmd-p2", "准备制作方案")) });
    assert.equal(second.status, 202);
    const secondReceipt = await second.json();
    assert.equal(await child.waitForCrashPoint(), "after-prepare-commit");
    await child.close();

    const restarted = await startChild({ scenario: "continue", crashPoint: "", dataDir: directory, port: port2 });
    const proposals = await (await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/proposals`)).json();
    assert.equal(proposals.items.length, 1, "提案在重启后可读");
    const proposal = proposals.items[0];
    assert.equal(proposal.state, "ready");
    assert.ok(proposal.priceDisclosure.includes("模拟媒体"));
    const snapshot = await (await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/snapshot`)).json();
    assert.ok(snapshot.messages.items.some((item: any) => item.references.proposalIds.includes(proposal.id)), "崩溃前的提案消息引用已同事务保存");

    // 同一调用重放 prepare（原 toolCallId + 原参数）：返回同一提案，不新增。
    const db = openAgentDatabase(directory);
    const request = db.prepare("SELECT * FROM requests WHERE command_id = ?").get("cmd-p2") as any;
    const invocation = db.prepare(
      "SELECT args_json FROM tool_invocations WHERE request_id = ? AND tool_call_id = ?",
    ).get(secondReceipt.requestId, "call-prepare-1") as { args_json: string };
    const tools = new BusinessTools(db, systemClock, () => OFFLINE_QUOTE_CATALOG);
    const replay = await tools.prepareProduction({
      actorId: "local-owner", conversationId, requestId: secondReceipt.requestId,
      executionEpoch: request.execution_epoch, target: null, toolCallId: "call-prepare-1",
    } as never, JSON.parse(invocation.args_json));
    db.close();
    assert.equal(replay.id, proposal.id, "重放返回同一提案");

    const after = await (await fetch(`${base2}/api/agent/v1/conversations/${conversationId}/proposals`)).json();
    assert.equal(after.items.length, 1, "没有产生第二份提案");
    t.diagnostic(JSON.stringify({ point: "after-prepare-commit", exitSignal: child.process.signalCode, conversationId,
      requestId: secondReceipt.requestId, proposalId: proposal.id, replayProposalId: replay.id,
      proposalCount: after.items.length, persistentMessageReference: true }));
    await restarted.close();
  });

  it("A-26 发送提交后崩溃：同 commandId 取回原回执，排队请求重启后继续执行", async t => {
    const port3 = await reservePort();
    const base3 = `http://127.0.0.1:${port3}`;
    const child = await startChild({ scenario: "send", crashPoint: "after-send-commit", dataDir: directory, port: port3 });
    const headers3 = studioHeaders(base3);
    const create = await fetch(`${base3}/api/agent/v1/conversations`, { method: "POST", headers: headers3, body: JSON.stringify({ commandId: "cmd-s0", title: "发送崩溃" }) });
    const conversationId = (await create.json()).id;

    // 崩溃点在回执事务之后、响应送达之前：fetch 会一直挂着等响应，
    // 必须与崩溃标记并行等待，SIGKILL 后连接重置，fetch 以拒绝收场。
    const sentOutcome = fetch(`${base3}/api/agent/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers3, body: JSON.stringify(messageInput("cmd-s1", "写一个开场")) })
      .then(async response => ({ status: response.status, body: await response.json().catch(() => null) }),
        () => null);
    assert.equal(await child.waitForCrashPoint(), "after-send-commit");
    await child.close();
    const sent = await sentOutcome;
    assert.ok(sent === null || sent.status === 202, "响应未送达或送达 202 都合法；事实以重放回执为准");

    const restarted = await startChild({ scenario: "continue", crashPoint: "", dataDir: directory, port: port3 });
    // 同 commandId 重放：返回原回执（replayed），请求仍是同一条。
    const replay = await fetch(`${base3}/api/agent/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers3, body: JSON.stringify(messageInput("cmd-s1", "写一个开场")) });
    assert.equal(replay.status, 202);
    const receipt = await replay.json();
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.state, "queued");
    t.diagnostic(JSON.stringify({ point: "after-send-commit", exitSignal: child.process.signalCode, conversationId,
      commandId: "cmd-s1", requestId: receipt.requestId, replayed: receipt.replayed, state: receipt.state }));

    // 排队请求在重启后继续执行完成（不自动重发提示，而是原请求跑完）。
    await waitFor(async () => {
      const snap = await (await fetch(`${base3}/api/agent/v1/conversations/${conversationId}/snapshot`)).json();
      return snap.activeRequestId === null
        && snap.messages.items.some((item: any) => item.role === "assistant" && item.state === "completed" && item.text.includes("恢复后"));
    });
    await restarted.close();
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(false, "condition not met before timeout");
}

for (const crashPoint of ["after-claim", "after-auto-compaction"]) {
  it(`S1-07 SIGKILL ${crashPoint} 不借用上一请求检查点且保留已提交事实`, { timeout: 60000 }, async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "frame-s1-crash-"));
    const port = await reservePort(), base = `http://127.0.0.1:${port}`;
    const json = async (method: string, url: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${base}/api/agent/v1${url}`, { method, headers: studioHeaders(base), ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok, `HTTP ${response.status}`); return response.json();
    };
    const input = (text: string) => ({ commandId: `cmd-${crypto.randomUUID()}`, text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
    let child = await startChild({ scenario: "continue", crashPoint: "", dataDir, port });
    t.after(async () => { if (child.process.exitCode === null && child.process.signalCode === null) await child.close(); await rm(dataDir, { recursive: true, force: true }); });
    const conv = await json("POST", "/conversations", { commandId: "create", title: "检查点归属" });
    await json("POST", `/conversations/${conv.id}/messages`, input("保留早先的讨论"));
    await waitFor(async () => !(await json("GET", `/conversations/${conv.id}/snapshot`)).activeRequestId);
    await child.close();
    child = await startChild({ scenario: crashPoint === "after-claim" ? "deliver" : "auto-compact", crashPoint, dataDir, port });
    // after-claim 会同步阻塞 HTTP 回执，先观察崩溃点，再结束该未决连接。
    const sending = json("POST", `/conversations/${conv.id}/messages`, input("本次将被中断")).catch(() => null);
    assert.equal(await child.waitForCrashPoint(), crashPoint);
    await child.close();
    await sending;
    child = await startChild({ scenario: "verify-history", crashPoint: "", dataDir, port });
    const recovered = await json("GET", `/conversations/${conv.id}/snapshot`);
    assert.equal(recovered.artifacts.items.length, crashPoint === "after-claim" ? 0 : 1);
    assert.ok(recovered.messages.items.some((m: any) => m.role === "system_notice" && m.text.includes("中断")));
    await json("POST", `/conversations/${conv.id}/messages`, input("继续之前的话题"));
    await waitFor(async () => !(await json("GET", `/conversations/${conv.id}/snapshot`)).activeRequestId);
    const completed = await json("GET", `/conversations/${conv.id}/snapshot`);
    assert.equal(completed.messages.items.find((m: any) => m.role === "assistant").text, "history-present:true");
    assert.equal(completed.artifacts.items.length, recovered.artifacts.items.length);
  });
}

it("审计 F3：连续 SIGKILL 不清除前一回合未完成的安全恢复义务", { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-double-crash-"));
  const port = await reservePort(), base = `http://127.0.0.1:${port}`;
  const json = async (method: string, url: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}/api/agent/v1${url}`, { method, headers: studioHeaders(base), ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `HTTP ${response.status}`); return response.json();
  };
  const input = (text: string) => ({ commandId: `cmd-${crypto.randomUUID()}`, text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  let child = await startChild({ scenario: "continue", crashPoint: "", dataDir, port });
  t.after(async () => { if (child.process.exitCode === null && child.process.signalCode === null) await child.close(); await rm(dataDir, { recursive: true, force: true }); });
  const conv = await json("POST", "/conversations", { commandId: "create", title: "连续中断" });
  await json("POST", `/conversations/${conv.id}/messages`, input("保留早先的讨论"));
  await waitFor(async () => !(await json("GET", `/conversations/${conv.id}/snapshot`)).activeRequestId);
  await child.close();
  for (const [scenario, crashPoint, text] of [["deliver", "after-deliver-commit", "不得续接的中断回合"], ["continue", "after-claim", "尚未进入模型的回合"]]) {
    child = await startChild({ scenario: scenario!, crashPoint: crashPoint!, dataDir, port });
    const sending = json("POST", `/conversations/${conv.id}/messages`, input(text!)).catch(() => null);
    assert.equal(await child.waitForCrashPoint(), crashPoint);
    await child.close(); await sending;
  }
  child = await startChild({ scenario: "verify-safe-history", crashPoint: "", dataDir, port });
  await json("POST", `/conversations/${conv.id}/messages`, input("继续讨论"));
  await waitFor(async () => !(await json("GET", `/conversations/${conv.id}/snapshot`)).activeRequestId);
  const completed = await json("GET", `/conversations/${conv.id}/snapshot`);
  assert.equal(completed.messages.items.find((m: any) => m.role === "assistant").text, "safe-history:true");
  assert.equal(completed.artifacts.items.length, 1);
  assert.equal(completed.proposals.items.length, 0);
  assert.equal(completed.runs.items.length, 0);
});
