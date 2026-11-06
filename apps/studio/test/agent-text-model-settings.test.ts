import { readFileSync } from "node:fs";
import { validatorFor } from "../src/server/agent/validate.js";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { buildFrameApp } from "../src/server/agent/app.js";
import { agentRoutes } from "../src/server/agent/routes.js";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { defaultTextBindingOf, initializeTextModelSettings, textModelsView, textRegistrationOf } from "../src/server/agent/text-model-settings.js";
import { canonicalJson } from "../src/server/agent/util.js";
import type { AgentDatabase } from "../src/server/agent/db.js";
import type { ConnectionModel, ProviderConnection } from "../src/shared/agent/generated/contracts.js";

// T2（OpenAI 收敛后）：统一连接入口的文本执行生命周期——冻结绑定、换 Key、重启恢复、
// steer、原生压缩、秘密边界与退役协议如实失败。供应商交互经本地 Responses SSE 替身：
// 公开配置仍是官方 HTTPS 地址，请求只在文本工厂的 resolver 内部 seam 改道。

const openapi = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../contracts/agent/v1/openapi.json"), "utf8"));

const staticClock = () => "2026-10-27T00:00:00.000Z";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const OWNER = "local-owner";
const KEY_MARKER = "T2KEYMARKER-7f3a-no-leak";

function responsesSse(text: string, usage: { input_tokens: number; output_tokens: number }): string {
  const events = [
    { type: "response.created", response: { id: "resp_stub" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_stub", status: "completed", usage } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

interface StubCall { authorization?: string | undefined; body: any }

interface ResponsesStub {
  server: http.Server;
  baseUrl: string;
  calls: StubCall[];
  manual: boolean;
  holds: Array<() => void>;
  error: { status: number; body: string } | null;
  replyText: string | null;
  usage: { input_tokens: number; output_tokens: number };
  release: () => void;
}

// OpenAI Responses 协议替身：真实 Pi SDK → OpenAI 官方 client → 本地 SSE。
async function startResponsesStub(): Promise<ResponsesStub> {
  const stub: ResponsesStub = { server: null!, baseUrl: "", calls: [], manual: false, holds: [], error: null, replyText: null, usage: { input_tokens: 24, output_tokens: 6 }, release: () => {} };
  stub.server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const call: StubCall = { authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
      stub.calls.push(call);
      const reply = () => {
        if (stub.error) {
          const { status, body } = stub.error; stub.error = null;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body);
          return;
        }
        const text = stub.replyText ?? "收到。";
        stub.replyText = null;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.end(responsesSse(text, stub.usage));
      };
      if (stub.manual) void new Promise<void>(resolve => stub.holds.push(resolve)).then(reply);
      else reply();
    });
  });
  await new Promise<void>(resolve => stub.server.listen(0, "127.0.0.1", resolve));
  stub.baseUrl = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  stub.release = () => stub.holds.shift()?.();
  return stub;
}

interface TextAssembly { app: FastifyInstance; runtime: Awaited<ReturnType<typeof createAgentRuntime>>; db: AgentDatabase; close(): Promise<void> }

async function assembleTextApp(directory: string, uiOrigin: string, transport: string): Promise<TextAssembly> {
  const runtime = await createAgentRuntime({
    providerConnections: true,
    importedSettings: [],
    dataDir: directory, skillsRoot: path.resolve(import.meta.dirname, "../skills"),
    host: {}, models: [], defaultModelId: "unconfigured", clock: staticClock,
    text: {
      // 与生产 main.ts 同形：初始化先于 host 与队列恢复；resolver 只替换执行地址（内部 seam）。
      factory: async (db: AgentDatabase) => {
        initializeTextModelSettings(db, staticClock);
        return {
          models: () => textModelsView(db),
          defaultBinding: () => defaultTextBindingOf(db),
          resolve: binding => {
            const registration = textRegistrationOf(db, binding);
            return registration ? { ...registration, baseUrl: transport } : registration;
          },
        };
      },
    },
  });
  const app = buildFrameApp({ agent: { service: runtime.service, resolveOwner: () => OWNER, uiOrigin, localOwnerOnly: true } });
  app.addHook("onClose", runtime.close);
  return { app, runtime, db: runtime.database, close: async () => { await app.close(); } };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const text = (id: string, overrides: Partial<ConnectionModel> = {}): ConnectionModel => ({
  id, kind: "text", name: id, modelId: "gpt-6.1-sol", features: [],
  contextWindowTokens: 272_000, maxOutputTokens: 16_384, enabled: true, isDefault: false, ...overrides,
});
const openaiConnection = (models: ConnectionModel[]): ProviderConnection => ({
  id: "provider-openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-key-A", enabled: true, models,
});

async function waitTerminalVia(db: AgentDatabase, requestId: string): Promise<string> {
  for (let i = 0; i < 600; i++) {
    const row = db.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string } | undefined;
    if (row && row.state !== "queued" && row.state !== "running") return row.state;
    await sleep(50);
  }
  throw new Error(`request ${requestId} did not finish (last=${JSON.stringify(db.prepare("SELECT state,stop_requested FROM requests WHERE id=?").get(requestId))})`);
}

describe("text model settings (T2, OpenAI 统一连接)", () => {
  let directory: string;
  let port: number;
  let baseUrl: string;
  let stub: ResponsesStub;
  let assembly: TextAssembly;

  // 应用在用例内 close 后同端口重开，undici 会复用旧实例留下的已死 keep-alive 连接（ECONNRESET）。
  // 请求发到的是死连接，新服务从未收到，网络层失败重试一次即换新连接；命令端点本身也有幂等回执。
  const json = async (method: string, url: string, body?: unknown, headers?: Record<string, string>, retried = false): Promise<{ status: number; body: any }> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${url}`, {
        method, headers: headers ?? { "content-type": "application/json", origin: baseUrl, "x-video-factory-request": "studio" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (retried) throw error;
      return json(method, url, body, headers, true);
    }
    const textBody = await response.text();
    const parsed = textBody ? JSON.parse(textBody) : null;
    if (response.ok && (url.includes("/settings/") || url.endsWith("/profile"))) {
      const route = url.replace("/api/agent/v1", "").replace(/\?.*$/, "");
      const reference = openapi.paths[route][method.toLowerCase()].responses[String(response.status)]?.content["application/json"].schema.$ref;
      assert.ok(reference, `${method} ${route} ${response.status} 必须有响应合同`);
      assert.equal(validatorFor(reference.split("/").at(-1))(parsed).ok, true, `${method} ${route} 实际响应必须符合 OpenAPI`);
    }
    return { status: response.status, body: parsed };
  };
  const getConnections = () => json("GET", "/api/agent/v1/settings/model-connections");
  const saveConnection = (connection: ProviderConnection, expectedRevision: number, commandId: string) =>
    json("POST", "/api/agent/v1/settings/model-connections", { commandId, expectedRevision, connection });

  let commandSequence = 0;
  const cmd = () => `t2-${++commandSequence}`;

  async function createConversation(title = "T2 会话") {
    const result = await json("POST", "/api/agent/v1/conversations", { commandId: cmd(), title });
    assert.equal(result.status, 201);
    return result.body.id as string;
  }

  async function sendMessage(conversationId: string, message: string, overrides: Record<string, unknown> = {}) {
    const result = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: cmd(), text: message, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, ...overrides,
    });
    return { status: result.status, receipt: result.body, body: result.body };
  }

  async function waitProviderCalls(count: number) {
    for (let i = 0; i < 600; i++) {
      if (stub.calls.length >= count) return;
      await sleep(50);
    }
    throw new Error(`provider calls ${stub.calls.length} < ${count}`);
  }

  async function chat(conversationId: string, message: string) {
    const { status, receipt } = await sendMessage(conversationId, message);
    assert.equal(status, 202);
    const state = await waitTerminalVia(assembly.db, receipt.requestId);
    return { receipt, state };
  }

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "frame-t2-text-"));
    stub = await startResponsesStub();
    port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    assembly = await assembleTextApp(directory, baseUrl, stub.baseUrl);
    await assembly.app.listen({ port, host: "127.0.0.1" });
  });

  after(async () => {
    await assembly.close();
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("T2-01 首启动无配置拒绝发送；保存 OpenAI 连接后可聊天；重启不丢配置", async () => {
    const empty = await getConnections();
    assert.equal(empty.status, 200);
    assert.deepEqual({ revision: empty.body.revision, connections: empty.body.connections }, { revision: 0, connections: [] });

    const conversation = await createConversation("先配置再聊天");
    const blocked = await sendMessage(conversation, "还没配置就想聊");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "CAPABILITY_UNAVAILABLE");
    assert.equal((await json("GET", "/api/agent/v1/bootstrap")).body.models.filter((model: any) => model.kind === "text").length, 0);

    const saved = await saveConnection(openaiConnection([{ ...text("sol"), isDefault: true }]), 0, cmd());
    assert.equal(saved.status, 200, `保存统一连接应成功：${JSON.stringify(saved.body)}`);
    assert.equal(saved.body.revision, 1);
    assert.equal(JSON.stringify(saved.body).includes("sk-key-A"), false, "回执不含 Key");

    const boot = await json("GET", "/api/agent/v1/bootstrap");
    const model = boot.body.models.find((entry: any) => entry.kind === "text");
    assert.equal(model.availability, "configured");
    assert.equal(model.isDefault, true);

    const first = await chat(conversation, "你好");
    assert.equal(first.state, "completed");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.authorization, "Bearer sk-key-A");
    assert.equal(stub.calls[0]!.body.model, "gpt-6.1-sol");
    const messages = await json("GET", `/api/agent/v1/conversations/${conversation}/messages`);
    assert.equal(messages.body.items[0]!.text, "收到。", "最新消息是助手答复");

    // 重启：设置与会话保留，仍可聊天。
    await assembly.close();
    assembly = await assembleTextApp(directory, baseUrl, stub.baseUrl);
    await assembly.app.listen({ port, host: "127.0.0.1" });
    const persisted = await getConnections();
    assert.equal(persisted.body.revision, 1);
    assert.equal(persisted.body.connections.length, 1);
    stub.calls.length = 0;
    const again = await chat(conversation, "重启后再聊");
    assert.equal(again.state, "completed");
    assert.deepEqual(stub.calls.map(call => call.authorization), ["Bearer sk-key-A"]);
  });

  it("OpenAI 原生搜索与业务工具并存、按需调用，来源链接保留在对话中", async () => {
    const conversation = await createConversation("联网查资料");
    const answer = "支持域名过滤。[OpenAI 官方说明](https://developers.openai.com/api/docs/guides/tools-web-search)";
    stub.replyText = answer;
    const { state } = await chat(conversation, "联网查一下 OpenAI 搜索是否支持域名过滤，附来源");
    assert.equal(state, "completed");
    const payload = stub.calls.at(-1)!.body;
    assert.deepEqual(payload.tools.filter((tool: { type: string }) => tool.type === "web_search"), [{ type: "web_search" }]);
    assert.ok(payload.tools.some((tool: { type: string; name?: string }) => tool.type === "function" && tool.name === "deliver_artifacts"), "搜索不能覆盖原有业务工具");
    assert.ok(payload.tool_choice === undefined || payload.tool_choice === "auto", "不能强制每次对话搜索");
    const messages = await json("GET", `/api/agent/v1/conversations/${conversation}/messages`);
    assert.equal(messages.body.items[0]!.text, answer, "来源链接必须随回复持久化，供页面展示和后续阅读");
    const workCount = assembly.db.prepare("SELECT COUNT(*) AS n FROM works WHERE conversation_id=?").get(conversation) as { n: number };
    assert.equal(workCount.n, 0, "搜索资料不创建视频事项");
  });

  it("T2-03 A运行/B排队/换默认后 D 新消息分别按原冻结绑定执行", async () => {
    const current = (await getConnections()).body;
    const connection: ProviderConnection = { ...current.connections[0], models: [text("sol", { isDefault: true }), text("luna", { modelId: "gpt-6-luna" })] };
    const saved = await saveConnection(connection, current.revision, cmd());
    assert.equal(saved.status, 200);

    stub.calls.length = 0;
    stub.manual = true;
    const conversation = await createConversation("冻结绑定");
    const a = await sendMessage(conversation, "A 正在跑");
    const b = await sendMessage(conversation, "B 已排队");
    await waitProviderCalls(1);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);

    const switched = await saveConnection({ ...connection, models: connection.models.map(item => ({ ...item, isDefault: item.id === "luna" })) }, saved.body.revision, cmd());
    assert.equal(switched.status, 200);
    const d = await sendMessage(conversation, "D 在换默认之后");
    assert.equal(d.status, 202);

    stub.release();
    await waitProviderCalls(2);
    stub.release();
    await waitProviderCalls(3);
    stub.release();
    stub.manual = false;
    assert.equal(await waitTerminalVia(assembly.db, a.receipt.requestId), "completed");
    assert.equal(await waitTerminalVia(assembly.db, b.receipt.requestId), "completed");
    assert.equal(await waitTerminalVia(assembly.db, d.receipt.requestId), "completed");

    // A、B 接收时默认都是 Sol；D 在切换后接收，用 Luna。
    assert.deepEqual(stub.calls.map(call => call.body.model), ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6-luna"]);
  });

  it("T2-04 编辑 Key 后旧队列与重启恢复仍用旧 Key；换 Key 新执行版本", async () => {
    const current = (await getConnections()).body;
    const connection = current.connections[0] as ProviderConnection;
    const defaultId = (assembly.db.prepare("SELECT default_entry_id FROM text_model_settings WHERE id=1").get() as { default_entry_id: string }).default_entry_id;
    stub.calls.length = 0;
    stub.manual = true;
    const conversation = await createConversation("换 Key 冻结");
    const a = await sendMessage(conversation, "换 Key 前运行");
    const b = await sendMessage(conversation, "换 Key 前排队");
    await waitProviderCalls(1);

    const updated = await saveConnection({ ...connection, apiKey: "sk-key-A2" }, current.revision, cmd());
    assert.equal(updated.status, 200);
    const rows = assembly.db.prepare("SELECT COUNT(*) AS n FROM text_model_versions").pluck().get() as number;
    assert.ok(rows >= 4, "换 Key 为两个型号各生成未来执行版本");

    // 关闭时 A 仍在运行：恢复流程标记 A stopped；B 保留排队，重开后按原冻结版本执行。
    await assembly.close();
    assembly = await assembleTextApp(directory, baseUrl, stub.baseUrl);
    await assembly.app.listen({ port, host: "127.0.0.1" });
    stub.manual = false;
    assert.equal(await waitTerminalVia(assembly.db, b.receipt.requestId), "completed");
    const stateA = assembly.db.prepare("SELECT state FROM requests WHERE id=?").get(a.receipt.requestId) as { state: string };
    assert.equal(stateA.state, "stopped", "干净关闭中断运行中请求，保留已发生事实");
    assert.equal(stub.calls.at(-1)!.authorization, "Bearer sk-key-A", "B 用接收时冻结的旧 Key");
    stub.calls.length = 0;
    const next = await chat(conversation, "换 Key 之后的新消息");
    assert.equal(next.state, "completed");
    assert.deepEqual(stub.calls.map(call => call.authorization), ["Bearer sk-key-A2"]);
    assert.equal((assembly.db.prepare("SELECT default_entry_id FROM text_model_settings WHERE id=1").get() as { default_entry_id: string }).default_entry_id, defaultId, "换 Key 不改变默认条目");
  });

  it("T2-05 steer 沿用原模型；会话身份与历史保持", async () => {
    stub.holds.splice(0).forEach(resolve => resolve());
    stub.calls.length = 0;
    stub.manual = true;
    const conversation = await createConversation("steer 冻结");
    const first = await sendMessage(conversation, "开始一个长回答");
    await waitProviderCalls(1);
    const originalModel = stub.calls[0]!.body.model as string;
    for (let i = 0; i < 100; i++) {
      if (assembly.runtime.registry.for(conversation).session?.isStreaming) break;
      await sleep(20);
    }
    assert.ok(assembly.runtime.registry.for(conversation).session?.isStreaming, "运行中会话应处于流式状态");

    const steered = await sendMessage(conversation, "插入一点补充", { mode: "steer", steerRequestId: first.receipt.requestId });
    assert.equal(steered.status, 202, `steer 应在运行中生效：${JSON.stringify(steered.receipt)}`);

    stub.release();
    stub.manual = false;
    assert.equal(await waitTerminalVia(assembly.db, first.receipt.requestId), "completed");
    await waitProviderCalls(2);
    assert.equal(stub.calls.at(-1)!.body.model, originalModel, "steer 后续请求仍用原模型身份");
    const row = assembly.db.prepare("SELECT pi_session_id FROM conversations WHERE id=?").get(conversation) as { pi_session_id: string };
    assert.equal(row.pi_session_id, "s1");
    const files = await readdir(path.join(directory, "pi-sessions", conversation, "s1"));
    assert.equal(files.filter(file => file.endsWith(".jsonl")).length, 1, "同一会话文件续用");
    const messages = await json("GET", `/api/agent/v1/conversations/${conversation}/messages`);
    const texts = messages.body.items.map((message: any) => message.text);
    assert.ok(texts.includes("开始一个长回答"));
    assert.ok(texts.includes("插入一点补充"), "steer 消息保留在会话历史");
  });

  it("T2-06 小 window 触发 Pi 原生压缩；工具白名单与业务上下文保留", async () => {
    const current = (await getConnections()).body;
    const saved = await saveConnection(openaiConnection([text("small", { contextWindowTokens: 2_048, maxOutputTokens: 256, isDefault: true })]), current.revision, cmd());
    assert.equal(saved.status, 200);
    const conversation = await createConversation("小窗口压缩");
    const statuses: any[] = [];
    const unsubscribe = assembly.runtime.service.hub().subscribeContextStatus(conversation, status => statuses.push(status));
    try {
      // Pi 依据供应商回报的 usage 判断是否整理；回复要足够长，使更早回合落出保留窗口（ctx/4）。
      stub.usage = { input_tokens: 1_900, output_tokens: 120 };
      const longReply = "占位回复，用于把更早的回合推出上下文保留窗口。".repeat(80);
      stub.replyText = longReply;
      await chat(conversation, "第一轮长内容");
      stub.replyText = longReply;
      await chat(conversation, "第二轮触发整理");
      stub.replyText = longReply;
      await chat(conversation, "第三轮确认");
      stub.replyText = null;
      await chat(conversation, "第四轮继续");
    } finally {
      unsubscribe();
      stub.usage = { input_tokens: 24, output_tokens: 6 };
    }

    assert.ok(statuses.length > 0, `期望出现上下文整理事件，实际 ${JSON.stringify(statuses)}`);
    assert.ok(statuses.some(status => status.phase === "compacted"), "整理事件应报告完成");
    // 整理还会在回合结束后触发一次总结请求（同样打到替身）；取真正携带本轮用户消息的请求。
    const lastCall = stub.calls.filter(call => JSON.stringify(call.body.input).includes("第四轮继续")).at(-1);
    assert.ok(lastCall, "第四轮的模型请求应已发出");
    const last = lastCall!.body;
    // 执行地址被 seam 改到本地替身后型号不在 Pi 目录内，走通用兼容序列化：工具在顶层 tools 字段。
    const toolNames: string[] = ((last.tools ?? []) as any[]).map((tool: any) => tool.name);
    for (const name of ["read_skill_file", "read_artifact", "deliver_artifacts", "prepare_production"]) {
      assert.ok(toolNames.includes(name), `压缩后工具白名单缺失 ${name}`);
    }
    const flattened = JSON.stringify(last.input);
    assert.ok(flattened.includes("[frame-current-state]"), "当前业务状态在本次投影末端");
    assert.ok(flattened.includes("第四轮继续"), "压缩后保留最近消息，未被清空");
    assert.equal(flattened.includes("第一轮长内容"), false, "远端历史已被摘要替换");
  });

  it("T2-07 保存零供应商调用；秘密不进公开响应与业务表；供应商错误回显反例映射固定原因", async () => {
    const before = stub.calls.length;
    const current = (await getConnections()).body;
    const renamed = await saveConnection({ ...current.connections[0], name: "改名不换绑定" }, current.revision, cmd());
    assert.equal(renamed.status, 200);
    const profile = await json("PATCH", "/api/agent/v1/profile", { commandId: cmd(), expectedRevision: 0, displayName: "展示名", bio: "个人简介" });
    assert.equal(profile.status, 200);
    assert.equal(stub.calls.length, before, "保存路径零模型调用");

    // 泄漏扫描：带 marker 的 Key 保存后，除两处 Key 存储表（连接现值与冻结版本）外全表与公开响应均无 marker。
    const marked = await saveConnection({ ...current.connections[0], apiKey: KEY_MARKER }, renamed.body.revision, cmd());
    assert.equal(marked.status, 200);
    const tables = assembly.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const table of tables) {
      if (table.name === "text_model_versions" || table.name === "provider_connections") continue;
      const rows = assembly.db.prepare(`SELECT * FROM "${table.name}"`).all();
      assert.equal(JSON.stringify(rows).includes(KEY_MARKER), false, `${table.name} 出现 Key marker`);
    }
    for (const response of [await json("GET", "/api/agent/v1/bootstrap"), await json("GET", "/api/agent/v1/profile")]) {
      assert.equal(JSON.stringify(response.body).includes(KEY_MARKER), false);
    }

    // 反例：供应商 500 报错原文回显 Key。产品消息与进程警告都不得透传原文。
    const conversation = await createConversation("错误回显");
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(String(warning));
    process.on("warning", onWarning);
    try {
      stub.error = { status: 500, body: JSON.stringify({ error: { message: `invalid api key ${KEY_MARKER} rejected` } }) };
      const failed = await chat(conversation, "触发供应商错误");
      assert.equal(failed.state, "failed");
      await sleep(300);
    } finally {
      process.off("warning", onWarning);
      stub.error = null;
    }
    const messageRows = assembly.db.prepare("SELECT text FROM messages ORDER BY created_seq DESC LIMIT 8").all() as { text: string }[];
    assert.equal(JSON.stringify(messageRows).includes(KEY_MARKER), false, "消息与通知不含 Key");
    assert.equal(JSON.stringify(warnings).includes(KEY_MARKER), false, `进程警告泄漏 Key：${JSON.stringify(warnings)}`);
    // 恢复可用默认，避免影响后续用例。
    const latest = (await getConnections()).body;
    await saveConnection({ ...latest.connections[0], apiKey: "sk-key-A" }, latest.revision, cmd());
  });

  it("T2-08 用户资料：读取/保存/刷新同步；bio 不进入模型上下文", async () => {
    const initial = await json("GET", "/api/agent/v1/profile");
    assert.equal(initial.status, 200);

    const saveBody = { commandId: cmd(), expectedRevision: initial.body.revision, displayName: "  山中创作者  ", bio: "第一行\n第二行" };
    const saved = await json("PATCH", "/api/agent/v1/profile", saveBody);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.profile, { revision: initial.body.revision + 1, displayName: "山中创作者", bio: "第一行\n第二行" });

    const boot = await json("GET", "/api/agent/v1/bootstrap");
    assert.equal(boot.body.displayName, "山中创作者", "Bootstrap 与侧栏首字同步");

    const stale = await json("PATCH", "/api/agent/v1/profile", { commandId: cmd(), expectedRevision: 0, displayName: "冲突", bio: "" });
    assert.equal(stale.status, 409);
    const empty = await json("PATCH", "/api/agent/v1/profile", { commandId: cmd(), expectedRevision: saved.body.profile.revision, displayName: "   ", bio: "" });
    assert.equal(empty.status, 400);
    const replayed = await json("PATCH", "/api/agent/v1/profile", saveBody);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.replayed, true, "同 commandId 同正文重放原回执");
    const conflict = await json("PATCH", "/api/agent/v1/profile", { ...saveBody, bio: "不同正文" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");

    // bio 不是 system prompt：保存后新回合的模型请求不包含 bio 内容。
    const conversation = await createConversation("资料不进上下文");
    stub.calls.length = 0;
    await chat(conversation, "资料保存后的普通消息");
    const modelPayload = JSON.stringify(stub.calls.map(call => call.body));
    assert.equal(modelPayload.includes("第一行"), false, "bio 不进入模型请求");

    const messages = await json("GET", `/api/agent/v1/conversations/${conversation}/messages`);
    assert.ok(messages.body.items.length > 0, "保存资料不重建会话");
  });

  it("T2-09 未认证 401 / 错误 Origin 403 / 修订冲突 / 幂等重放与正文冲突", async () => {
    const anonPort = await reservePort();
    const anonApp = Fastify();
    await anonApp.register(agentRoutes, { prefix: "/api/agent/v1", service: assembly.runtime.service, resolveOwner: () => null, uiOrigin: `http://127.0.0.1:${anonPort}` });
    await anonApp.listen({ port: anonPort, host: "127.0.0.1" });
    try {
      const unauth = await fetch(`http://127.0.0.1:${anonPort}/api/agent/v1/settings/model-connections`);
      assert.equal(unauth.status, 401);
      const cross = await fetch(`${baseUrl}/api/agent/v1/settings/model-connections`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", "x-video-factory-request": "studio" },
        body: JSON.stringify({ commandId: cmd(), expectedRevision: 0, connection: openaiConnection([{ ...text("evil"), isDefault: true }]) }),
      });
      assert.equal(cross.status, 403);
    } finally { await anonApp.close(); }

    const current = (await getConnections()).body;
    const stale = await saveConnection(current.connections[0], 0, cmd());
    assert.equal(stale.status, 409);

    const body = { commandId: cmd(), expectedRevision: current.revision, connection: { ...current.connections[0], apiKey: null } };
    const first = await saveConnection(body.connection, current.revision, body.commandId);
    assert.equal(first.status, 200);
    const replayed = await json("POST", "/api/agent/v1/settings/model-connections", body);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.replayed, true);
    assert.equal(replayed.body.revision, first.body.revision, "重放不推进修订");
    const conflict = await saveConnection({ ...body.connection, apiKey: "sk-key-other" }, current.revision, body.commandId);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  });

  it("T2-10 退役协议与缺版本的排队请求如实失败，不发起供应商调用", async () => {
    const conversation = await createConversation("退役绑定");
    const now = staticClock();
    const insertVersion = (revisionId: string, protocol: string, apiKey: string | null) => {
      const binding = { providerId: revisionId, modelId: "claude-haiku-4-5", connectionId: revisionId, configurationRevisionId: revisionId };
      assembly.db.prepare("INSERT INTO text_model_versions(configuration_revision_id,binding_json,configuration_json,api_key,created_at) VALUES(?,?,?,?,?)")
        .run(revisionId, canonicalJson(binding), canonicalJson({ protocol, baseUrl: "https://api.anthropic.com", modelId: "claude-haiku-4-5", contextWindowTokens: 32_000, maxOutputTokens: 4_096, thinkingLevel: "medium" }), apiKey, now);
      return binding;
    };
    const retired = insertVersion("cfg-retired-anthropic", "anthropic-messages", "sk-retired");
    const missingBinding = { providerId: "cfg-not-imported", modelId: "claude-haiku-4-5", connectionId: "cfg-not-imported", configurationRevisionId: "cfg-not-imported" };
    insertQueuedRequest(assembly.db, conversation, "req-retired", "旧协议排队", 90, canonicalJson(retired));
    insertQueuedRequest(assembly.db, conversation, "req-missing", "缺版本", 91, canonicalJson(missingBinding));

    const callsBefore = stub.calls.length;
    assembly.runtime.registry.kickAllWithQueued();
    assert.equal(await waitTerminalVia(assembly.db, "req-retired"), "failed", "退役协议不静默改投 OpenAI");
    assert.equal(await waitTerminalVia(assembly.db, "req-missing"), "failed", "缺版本不用当前配置顶替");
    assert.equal(stub.calls.length, callsBefore, "失败发生在供应商请求前");
    for (const requestId of ["req-retired", "req-missing"]) {
      const notice = assembly.db.prepare("SELECT text FROM messages WHERE request_id=? AND role='system_notice'").get(requestId) as { text: string } | undefined;
      assert.ok(notice, `${requestId} 缺系统通知`);
      assert.match(notice.text, /本回合执行失败/);
    }
  });

  it("离线入口：连接目录可读且为空；profile 读取可用", async () => {
    const offlineDirectory = await mkdtemp(path.join(tmpdir(), "frame-t2-offline-"));
    try {
      const offlinePort = await reservePort();
      const offlineBase = `http://127.0.0.1:${offlinePort}`;
      const offline = await assembleOfflineAgent({ dataDir: offlineDirectory, uiOrigin: offlineBase });
      await offline.app.listen({ port: offlinePort, host: "127.0.0.1" });
      try {
        const connections = await fetch(`${offlineBase}/api/agent/v1/settings/model-connections`, { headers: { origin: offlineBase } });
        assert.equal(connections.status, 200);
        assert.equal(((await connections.json() as any).connections as unknown[]).length, 0);
        const profile = await fetch(`${offlineBase}/api/agent/v1/profile`, { headers: { origin: offlineBase } });
        assert.equal(profile.status, 200);
        assert.equal((await profile.json() as any).displayName, "本地创作者");
      } finally { await offline.close(); }
    } finally {
      await rm(offlineDirectory, { recursive: true, force: true });
    }
  });
});

function insertQueuedRequest(db: AgentDatabase, conversationId: string, requestId: string, message: string, queueSeq: number, bindingJson: string): void {
  const now = staticClock();
  db.prepare(
    `INSERT INTO requests(id,conversation_id,owner_id,command_id,text,target_json,skill_id,model_id,mode,queue_seq,state,message_id,created_at,updated_at,model_binding_json)
     VALUES(?,?,?,?,?,NULL,NULL,'claude-haiku-4-5','new',?,'queued',?,?,?,?)`,
  ).run(requestId, conversationId, OWNER, `cmd-${requestId}`, message, queueSeq, `msg-${requestId}`, now, now, bindingJson);
  const messageSeq = (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM messages WHERE conversation_id=?").get(conversationId) as { n: number }).n;
  db.prepare(
    `INSERT INTO messages(id,conversation_id,owner_id,request_id,role,kind,state,text,references_json,created_seq,created_at,updated_at)
     VALUES(?,?,?,?, 'user','chat','queued',?,'{"artifacts":[],"proposalIds":[],"runIds":[]}',?,?,?)`,
  ).run(`msg-${requestId}`, conversationId, OWNER, requestId, message, messageSeq, now, now);
}
