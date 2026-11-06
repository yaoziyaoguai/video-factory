import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";

// 纵向路径：真实 HTTP + SQLite + Pi SDK 1.4.0；Faux 只替换模型响应。
// 覆盖 A-01（对话可聊任意话题）、A-02/A-03（排队/执行/完成）、A-04（整批交付）、
// A-08（SSE 暂态+持久事件）、A-13（发送幂等重放）的核心路径。

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe("agent vertical (HTTP + SQLite + Pi Faux)", () => {
  let assembly: OfflineAgentAssembly;
  let baseUrl: string;
  let directory: string;
  const headers = {
    "content-type": "application/json",
    origin: "",
    "x-video-factory-request": "studio",
  };

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vf-agent-vertical-"));
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    headers.origin = baseUrl;
    assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: baseUrl });
    await assembly.app.listen({ port, host: "127.0.0.1" });
  });

  after(async () => {
    await assembly.close();
    await rm(directory, { recursive: true, force: true });
  });

  type JsonFetchResult = { status: number; body: any };
  const json = async (method: string, url: string, body?: unknown, extra?: Record<string, string>): Promise<JsonFetchResult> => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const waitFor = async (check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(false, "condition not met before timeout");
  };

  it("bootstrap 暴露离线模型与技能，不出现真实供应商", async () => {
    const result = await json("GET", "/api/agent/v1/bootstrap");
    assert.equal(result.status, 200);
    assert.equal(result.body.models.length, 1);
    assert.equal(result.body.models[0].availability, "configured");
    assert.ok(result.body.models[0].verificationNote.includes("离线"));
    assert.ok(result.body.skills.some((skill: { id: string }) => skill.id === "travel-prompt-kit"));
    assert.equal(result.body.ownerId, "local-owner");
  });

  it("创建会话、发送普通聊天并等待完成（A-01/A-02/A-03）", async () => {
    assembly.faux?.setResponses([fauxAssistantMessage("当然可以，先聊聊你的想法。")]);
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-create-1", title: "闲聊与创作" });
    assert.equal(created.status, 201);
    const conversationId = created.body.id;

    const sent = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-1", text: "今天天气怎么样？", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.state, "queued");
    const requestId = sent.body.requestId;

    await waitFor(async () => {
      const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant");
      return Boolean(assistant && assistant.state === "completed" && assistant.text.includes("先聊聊"));
    });

    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    assert.equal(snapshot.body.activeRequestId, null);
    const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant");
    assert.equal(assistant.requestId, requestId);
    assert.deepEqual(assistant.references, { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] });
  });

  it("第二次请求触发整批交付：产物、引用、事件、新输出提示（A-04/A-08）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;

    assembly.faux?.setResponses([
      fauxAssistantMessage([
        fauxToolCall("deliver_artifacts", {
          items: [{
            mode: "create", title: "旅行开场 Prompt", kind: "prompt",
            content: { format: "markdown", text: "# 旅行开场\n\n- 镜头：清晨的巷口\n- 口播：这条路往海的方向" },
          }],
        }),
      ]),
      fauxAssistantMessage("已交付《旅行开场 Prompt》，看看要不要调整。"),
    ]);

    // 发送前的快照游标：回合（含交付）的全部业务事件必然落在它之后。
    // 发送后再取会与执行竞态——Faux 回合极快，交付事件可能先于快照落库而被游标跳过。
    const preRunSnapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const preRunCursor = preRunSnapshot.body.eventCursor;

    const sent = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-2", text: "帮我写一个旅行视频的开场 Prompt", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(sent.status, 202);
    deliveryRequestId = sent.body.requestId;

    await waitFor(async () => {
      const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snapshot.body.artifacts.items.length === 1;
    });

    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const artifact = snapshot.body.artifacts.items[0];
    assert.equal(artifact.kind, "prompt");
    assert.equal(artifact.revisionNumber, 1);

    const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant" && item.text.includes("已交付"));
    assert.ok(assistant, "assistant 交付说明已落库");
    assert.equal(assistant.references.artifacts.length, 1);
    assert.equal(assistant.references.artifacts[0].revisionId, artifact.revisionId);

    const revision = await json("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`);
    assert.equal(revision.status, 200);
    assert.ok(revision.body.content.text.includes("旅行开场"));

    const events = await collectEvents(conversationId, preRunCursor);
    assert.ok(events.some((event: any) => event.kind === "artifact.delivered" && event.notification === "new_output"));
    assert.ok(events.some((event: any) => event.kind === "message.changed"));
  });

  it("同一 commandId 重放返回原回执且不产生新消息（A-13）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;
    const before = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`, undefined);

    const replay = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-2", text: "帮我写一个旅行视频的开场 Prompt", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.requestId, deliveryRequestId);

    const after = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`, undefined);
    assert.equal(after.body.items.length, before.body.items.length);
  });

  it("缺少 Origin 或安全头的变更请求被拒绝（A-16 边界）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;
    const payload = { commandId: "cmd-origin-1", text: "hi", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null };

    const noOrigin = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-video-factory-request": "studio" }, body: JSON.stringify(payload),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json()).code, "FORBIDDEN");

    const noHeader = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify(payload),
    });
    assert.equal(noHeader.status, 403);
  });

  let deliveryRequestId = "";

  async function collectEvents(conversationId: string, cursor: string): Promise<any[]> {
    const response = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: any[] = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && events.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const dataLine = block.split("\n").find(line => line.startsWith("data: "));
        if (dataLine && block.includes("event: business")) events.push(JSON.parse(dataLine.slice(6)));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
    await reader.cancel();
    return events;
  }
});
