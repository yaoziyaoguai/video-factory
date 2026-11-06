import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { agentRoutes } from "../src/server/agent/routes.js";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";

// A 增量读取与恢复（HTTP + DB）：
// 快照-SSE 缺口补齐、游标过期/重置、心跳、反馈可重读、提案到期（注入时钟）、
// 未认证拒绝、离线入口有界关闭。浏览器侧行为在工作台测试覆盖。

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
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

describe("agent read & recovery", () => {
  let assembly: OfflineAgentAssembly;
  let baseUrl: string;
  let directory: string;
  const headers: Record<string, string> = {};

  const json = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${baseUrl}${url}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const messageInput = (commandId: string, text: string, extra: Record<string, unknown> = {}) => ({
    commandId, text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, ...extra,
  });

  const waitFor = async (check: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(false, "condition not met before timeout");
  };

  // 读取一条 SSE 流，直到满足条件或超时；返回原始文本。
  const readStream = async (url: string, until: (chunk: string) => boolean, timeoutMs: number): Promise<string> => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), Math.max(1, deadline - Date.now()))),
      ]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (until(text)) break;
    }
    await reader.cancel().catch(() => {});
    return text;
  };

  const deliverStep = (title: string) => fauxAssistantMessage([
    fauxToolCall("deliver_artifacts", {
      items: [{ mode: "create", title, kind: "prompt", content: { format: "markdown", text: `# ${title}\n内容` } }],
    }),
  ]);

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vf-agent-read-"));
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    Object.assign(headers, studioHeaders(baseUrl));
    assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: baseUrl });
    await assembly.app.listen({ port, host: "127.0.0.1" });
  });

  after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await assembly.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("快照与 SSE 之间的缺口被补齐：不丢、不重、序列递增（A-31）", async () => {
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-g0", title: "缺口补齐" });
    const conversationId = created.body.id;

    // 第一回合建立基线事件，取快照游标。
    assembly.faux?.setResponses([
      deliverStep("基线产物"),
      fauxAssistantMessage("基线交付。"),
    ]);
    await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-g1", "先来一份基线"));
    await waitFor(async () => {
      const snap = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant" && item.text.includes("基线交付"));
    });
    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const cursor = snapshot.body.eventCursor;
    const eventCountAtCursor = assembly.database.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?",
    ).get(conversationId) as { n: number };

    // 快照之后、SSE 之前提交新交付。
    assembly.faux?.setResponses([
      deliverStep("缺口产物"),
      fauxAssistantMessage("缺口交付。"),
    ]);
    await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-g2", "再来一份"));
    await waitFor(async () => {
      const snap = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant" && item.text.includes("缺口交付"));
    });

    const stream = await readStream(
      `${baseUrl}/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(cursor)}`,
      text => text.split("event: business").length - 1 >= 4, 10_000,
    );
    const events = [...stream.matchAll(/^data: (.+)$/gm)]
      .map(match => JSON.parse(match[1]!) as { eventId: string; cursor: string; kind: string; notification: string })
      .filter(event => typeof event.eventId === "string" && typeof event.cursor === "string");
    assert.ok(events.length >= 2, `SSE 至少补齐快照后的业务事件，实际 ${events.length}`);
    const seqOf = (event: { cursor: string }): number =>
      (JSON.parse(Buffer.from(event.cursor, "base64url").toString("utf8")) as { s: number }).s;
    const seqs = events.map(seqOf);
    assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), "序列严格递增且不重复");
    const ids = events.map(event => event.eventId);
    assert.equal(new Set(ids).size, ids.length, "事件 ID 不重复");
    // 快照时已有的事件计数 = SSE 只补快照之后的。
    const totalAfter = assembly.database.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?",
    ).get(conversationId) as { n: number };
    assert.equal(events.length, totalAfter.n - eventCountAtCursor.n, "补齐数量恰好等于缺口");
    assert.ok(events.some(event => event.kind === "artifact.delivered" && event.notification === "new_output"));
  });

  it("事件保留缺口：连接前 410 CURSOR_EXPIRED，流中 reset_required（A-33）", async () => {
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-h0", title: "游标缺口" });
    const conversationId = created.body.id;
    assembly.faux?.setResponses([
      deliverStep("缺口前产物"),
      fauxAssistantMessage("缺口前交付。"),
    ]);
    await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-h1", "建立事件"));
    await waitFor(async () => {
      const snap = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant");
    });
    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const cursor = snapshot.body.eventCursor;
    const ownerRow = assembly.database.prepare("SELECT owner_id FROM conversations WHERE id = ?").get(conversationId) as { owner_id: string };
    const insertEvent = (seq: number) => assembly.database.prepare(
      "INSERT INTO events(seq, event_id, conversation_id, owner_id, kind, entity_id, entity_version, notification, created_at) VALUES (?, ?, ?, ?, 'message.changed', ?, 1, 'quiet', ?)",
    ).run(seq, `evt-synthetic-${seq}`, conversationId, ownerRow.owner_id, conversationId, new Date().toISOString());

    // 连接前缺口：删除游标及更早事件，仅保留更高的孤立事件 → 410。
    const cursorSeq = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).s as number;
    assembly.database.prepare("DELETE FROM events WHERE conversation_id = ? AND seq <= ?").run(conversationId, cursorSeq);
    insertEvent(cursorSeq + 3);
    const expired = await json("GET", `/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, "CURSOR_EXPIRED");

    // 流中缺口：以当前最新游标连接（此时仍连续），随后把最低水位抬到游标之上 → reset_required。
    const fresh = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const freshCursor = fresh.body.eventCursor;
    const streamPromise = readStream(
      `${baseUrl}/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(freshCursor)}`,
      text => text.includes("event: reset_required"), 12_000,
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    const freshSeq = JSON.parse(Buffer.from(freshCursor, "base64url").toString("utf8")).s as number;
    insertEvent(freshSeq + 4);
    assembly.database.prepare("DELETE FROM events WHERE conversation_id = ? AND seq <= ?").run(conversationId, freshSeq);
    const stream = await streamPromise;
    assert.ok(stream.includes("event: reset_required"), "缺口在流中被明确重置而不是静默跳过");
  });

  it("空闲 SSE 有心跳注释保活（A-33 保活）", async () => {
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-b0", title: "心跳" });
    const conversationId = created.body.id;
    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const stream = await readStream(
      `${baseUrl}/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(snapshot.body.eventCursor)}`,
      text => text.includes(": heartbeat"), 18_000,
    );
    assert.ok(stream.includes(": heartbeat"), "15 秒空闲后发出心跳注释");
    assert.ok(stream.startsWith("retry: 3000"), "连接建立时给出重连建议");
  });

  it("反馈落库后可经 GET/list/snapshot 重读；重试不重复（A-36）", async () => {
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-f0", title: "反馈重读" });
    const conversationId = created.body.id;
    assembly.faux?.setResponses([
      deliverStep("反馈对象"),
      fauxAssistantMessage("对象交付。"),
    ]);
    await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-f1", "给我对象"));
    await waitFor(async () => {
      const snap = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant");
    });
    const artifact = (await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`)).body.artifacts.items[0];

    const feedback = await json("POST", `/api/agent/v1/conversations/${conversationId}/feedback`, {
      commandId: "cmd-f2",
      target: { artifactId: artifact.id, revisionId: artifact.revisionId, workId: null },
      text: "这里收一下。",
    });
    assert.equal(feedback.status, 201);
    const messageId = feedback.body.messageId;

    const single = await json("GET", `/api/agent/v1/messages/${messageId}`);
    assert.equal(single.status, 200);
    assert.equal(single.body.kind, "feedback");
    assert.equal(single.body.text, "这里收一下。");
    assert.equal(single.body.feedback.applied, false);

    const list = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`);
    const inList = list.body.items.find((item: any) => item.id === messageId);
    assert.ok(inList, "list 能找到反馈消息");
    const snapshotMessage = (await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`))
      .body.messages.items.find((item: any) => item.id === messageId);
    assert.ok(snapshotMessage, "snapshot 能找到反馈消息");

    const retry = await json("POST", `/api/agent/v1/conversations/${conversationId}/feedback`, {
      commandId: "cmd-f2",
      target: { artifactId: artifact.id, revisionId: artifact.revisionId, workId: null },
      text: "这里收一下。",
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.messageId, messageId);
    const after = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`);
    assert.equal(after.body.items.filter((item: any) => item.kind === "feedback").length, 1);
  });

  it("提案到期用注入时钟推进：状态升版并发事件，GET 不写库（A-37）", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const scopedHeaders = studioHeaders(base);
    const scoped: OfflineAgentAssembly = await assembleOfflineAgent({
      dataDir: directory, uiOrigin: base, clock,
    });
    await scoped.app.listen({ port, host: "127.0.0.1" });
    const scopedJson = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}${url}`, {
        method, headers: scopedHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    const created = await scopedJson("POST", "/api/agent/v1/conversations", { commandId: "cmd-x0", title: "到期" });
    const conversationId = created.body.id;
    scoped.faux?.setResponses([
      deliverStep("到期输入"),
      fauxAssistantMessage("输入交付。"),
    ]);
    await scopedJson("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-x1", "给我输入"));
    await waitFor(async () => {
      const snap = await scopedJson("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snap.body.messages.items.some((item: any) => item.role === "assistant");
    });
    const artifact = (await scopedJson("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`)).body.artifacts.items[0];
    const revision = (await scopedJson("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`)).body;
    const intent = {
      workId: null, title: "到期提案",
      inputRevisions: [{ artifactId: artifact.id, revisionId: artifact.revisionId }],
      operations: [{
        operationId: "opV", outputSlot: "v",
        inputs: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
        maxCreateAttempts: 1, kind: "speech",
        model: { providerId: "fixture-text", modelId: "faux-speech", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
        parameters: { voiceId: "narrator-main", format: "mp3" },
      }],
      finalOutput: { operationId: "opV", outputSlot: "v" },
      maxSpend: { currency: "CNY", amountMinor: 500 },
    };
    const prepared = await scopedJson("POST", `/api/agent/v1/conversations/${conversationId}/proposals`, { commandId: "cmd-x2", spec: intent });
    assert.equal(prepared.status, 201);
    assert.equal(prepared.body.state, "ready");

    // TTL 30 分钟：推进 31 分钟后手动清扫，状态必须变成 expired。
    now += 31 * 60 * 1000;
    scoped.service.sweepProposals();

    const expired = await scopedJson("GET", `/api/agent/v1/proposals/${prepared.body.id}`);
    assert.equal(expired.status, 200);
    assert.equal(expired.body.state, "expired");
    assert.ok(expired.body.revision > prepared.body.revision, "状态变更升版本");
    const events = scoped.database.prepare(
      "SELECT kind FROM events WHERE conversation_id = ? AND entity_id = ?",
    ).all(conversationId, prepared.body.id) as { kind: string }[];
    assert.ok(events.some(event => event.kind === "proposal.changed"), "到期发了事件");

    // GET 不写库：重复读版本不变。
    const again = await scopedJson("GET", `/api/agent/v1/proposals/${prepared.body.id}`);
    assert.equal(again.body.revision, expired.body.revision);
    await scoped.close();
  });

  it("未认证请求在进入业务前被拒（A-38 部分）", async () => {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const app = Fastify({ logger: false });
    await app.register(agentRoutes, {
      prefix: "/api/agent/v1",
      service: assembly.service,
      resolveOwner: () => null,
      uiOrigin: base,
      localOwnerOnly: true,
    });
    await app.listen({ port, host: "127.0.0.1" });
    const unauthenticated = await fetch(`${base}/api/agent/v1/bootstrap`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, "UNAUTHENTICATED");
    const mutation = await fetch(`${base}/api/agent/v1/conversations`, {
      method: "POST", headers: studioHeaders(base), body: JSON.stringify({ commandId: "cmd-u1", title: "x" }),
    });
    assert.equal(mutation.status, 401);
    await app.close();
  });

  it("离线入口子进程：SIGTERM 有界关闭、端口释放（A-39）", async () => {
    const port = await reservePort();
    const dataDir = path.join(directory, "lifecycle");
    const mainPath = path.join(repositoryRoot, "apps/studio/src/server/agent/offline-main.ts");
    const child = spawn(process.execPath, ["--import", "tsx", mainPath], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, AGENT_PORT: String(port), AGENT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout! });
    const listening = new Promise<void>(resolve => {
      lines.on("line", (line: string) => {
        if (line.includes("agent-offline-listening")) resolve();
      });
    });
    await Promise.race([
      listening,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`入口未在限时内启动：${stderr.slice(0, 400)}`)), 30_000)),
    ]);

    // 打开一条 SSE 连接后发 SIGTERM：有界关闭必须结束进程而不是悬挂。
    const endpoint = `http://127.0.0.1:${port}`;
    const created = await fetch(`${endpoint}/api/agent/v1/conversations`, { method: "POST", headers: studioHeaders(endpoint), body: JSON.stringify({ commandId: "cmd-lifecycle", title: "lifecycle" }) }).then(response => response.json()) as { id: string };
    const snapshot = await fetch(`${endpoint}/api/agent/v1/conversations/${created.id}/snapshot`).then(response => response.json()) as { eventCursor: string };
    const stream = await fetch(`${endpoint}/api/agent/v1/conversations/${created.id}/events?cursor=${encodeURIComponent(snapshot.eventCursor)}`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
    const reader = stream.body!.getReader(); await reader.read();
    child.kill("SIGTERM");
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SIGTERM 后未在有界时间内退出")), 15_000)),
    ]);
    assert.equal(code, 0, "正常退出码");
    assert.equal((await reader.read()).done, true);
    children.delete(child);
    // 端口已释放：能再次绑定。
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    probe.close();
  });
});
