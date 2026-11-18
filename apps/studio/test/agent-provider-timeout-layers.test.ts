import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { buildFrameApp } from "../src/server/agent/app.js";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { turnDiagnostics, type TurnDiagnostic } from "../src/server/agent/turn-diagnostics.js";
import { defaultTextBindingOf, initializeTextModelSettings, textModelsView, textRegistrationOf } from "../src/server/agent/text-model-settings.js";
import type { AgentDatabase } from "../src/server/agent/db.js";
import type { ConnectionModel, ProviderConnection } from "../src/shared/agent/generated/contracts.js";

// R2（执行包）：长会话 10.5s 失败的截止层受控复现矩阵。
// 复用 T2 的装配缝：真实 Pi SDK → OpenAI 官方 client → resolver 内部 seam 改道 transport；
// 与生产同走 PiRuntimeHost.settingsManager（retry.provider.timeoutMs=120s，重试 0）。
// 断言面：requests.state、system_notice 文本（executor noticeFor 的精确映射——
// “文本模型请求超时”仅在 providerError === "Request timed out." 全等时出现）、回合 elapsed。
//  - M1 连接拒绝：立即失败，连接类通知。
//  - M2 连接黑洞（TLS 握手无应答）：≈10s 失败且通知为超时类——DF20 10.504s 签名的层定位复现
//    （undici 默认 10s connect timeout 覆盖 TCP+TLS 建立，被 openai SDK 归一为 "Request timed out."）。
//    本机实测 10.255.255.1 立即 ENETUNREACH（连接类、<1s），不可用作黑洞；改用环回静默 TCP：
//    https 指向只 accept 不应答的本地端口，TLS 握手挂起触发同一 L7 连接超时，零外发包。
//  - M3 首字节慢 15s：成功（证明链路无 ≤15s 隐藏期限，慢响应不误判）。
//  - M4 首字节慢 130s：~120s 处失败于 provider 超时层（pi-runtime 120s 设置生效证据）。
//  - M5 流中途停顿 20s：成功；停顿后断流：失败。
//  - M6 hold 期间停止：stopped，已落库事实不变。
//  - M7 第一次助手响应执行真实作品工具，第二次返回失败：保留两条响应及中间工具的原生时长。
//  - M8 prompt 抛错：整轮结束，报告脱敏异常及已观测的阶段。
// 环境依赖：M2 用环回静默 TLS 服务器，无外发包；M4 真实等待 ~120s。

const staticClock = () => "2026-11-18T00:00:00.000Z";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const OWNER = "local-owner";

// 环回黑洞：接受 TCP 连接但永不写任何字节——https 指向它时 TLS 握手挂起，
// undici 默认 10s connect timeout（TCP/TLS/CONNECT 建立）到期触发 ConnectTimeoutError。
async function startSilentTlsBlackhole(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/v1`,
    // server.close() 只停止监听，不结束已接受连接；静默 socket 必须显式销毁，否则 teardown 挂起。
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

// openai SDK 的 SSE 迭代器只 yield data: 载荷（core/streaming.js:121），事件类型必须在 data JSON 内部
// （与真实 OpenAI API 及 T2 模板一致：type 同时出现在 event: 行与 data 载荷中）。
type SseEvent = readonly [type: string, data: Record<string, unknown>];
const eventsFor = (text: string): SseEvent[] => [
  ["response.created", { response: { id: "resp_stub" } }],
  ["response.output_item.added", { output_index: 0, item: { type: "message", role: "assistant", content: [] } }],
  ["response.output_text.delta", { output_index: 0, content_index: 0, delta: text }],
  ["response.output_item.done", { output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } }],
  ["response.completed", { response: { id: "resp_stub", status: "completed", usage: { input_tokens: 24, output_tokens: 6 } } }],
];
const sse = ([type, data]: SseEvent) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const fullStream = (text: string) => eventsFor(text).map(sse).join("");

interface StallPlan { stallMs: number; destroy: boolean }

interface ResponsesStub {
  server: http.Server;
  baseUrl: string;
  calls: number;
  manual: boolean;
  holds: Array<() => void>;
  release: () => void;
}

async function startResponsesStub(options: { firstByteDelayMs?: number; stall?: StallPlan | null } = {}): Promise<ResponsesStub> {
  const stub: ResponsesStub = { server: null!, baseUrl: "", calls: 0, manual: false, holds: [], release: () => {} };
  stub.server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      stub.calls += 1;
      const reply = () => {
        if (options.stall) {
          // M5：先发 created+added+delta（前 3 事件），停顿后要么补完、要么直接断流。
          const events = eventsFor("收到。");
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          response.write(events.slice(0, 3).map(sse).join(""));
          setTimeout(() => {
            if (options.stall!.destroy) response.destroy();
            else response.end(events.slice(3).map(sse).join(""));
          }, options.stall!.stallMs);
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.end(fullStream("收到。"));
      };
      if (stub.manual) void new Promise<void>(resolve => stub.holds.push(resolve)).then(reply);
      else if (options.firstByteDelayMs) setTimeout(reply, options.firstByteDelayMs);
      else reply();
    });
  });
  await new Promise<void>(resolve => stub.server.listen(0, "127.0.0.1", resolve));
  stub.baseUrl = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  stub.release = () => stub.holds.shift()?.();
  return stub;
}

interface CaseWorld { baseUrl: string; db: AgentDatabase; registry: AgentRuntime["registry"] }

async function withTextApp(transport: string, run: (world: CaseWorld) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-r2-timeout-"));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime = await createAgentRuntime({
    providerConnections: true,
    importedSettings: [],
    dataDir: directory, skillsRoot: path.resolve(import.meta.dirname, "../skills"),
    host: {}, models: [], defaultModelId: "unconfigured", clock: staticClock,
    text: {
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
  const app: FastifyInstance = buildFrameApp({ agent: { service: runtime.service, resolveOwner: () => OWNER, uiOrigin: baseUrl, localOwnerOnly: true } });
  app.addHook("onClose", runtime.close);
  await app.listen({ port, host: "127.0.0.1" });
  try {
    await run({ baseUrl, db: runtime.database, registry: runtime.registry });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

let commandSequence = 0;
const cmd = () => `r2-${++commandSequence}`;
const headers = (baseUrl: string) => ({ "content-type": "application/json", origin: baseUrl, "x-video-factory-request": "studio" });

async function json(method: string, baseUrl: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method, headers: headers(baseUrl),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function configureConnection(baseUrl: string): Promise<void> {
  const model: ConnectionModel = { id: "sol", kind: "text", name: "sol", modelId: "gpt-6.1-sol", features: [], contextWindowTokens: 272_000, maxOutputTokens: 16_384, enabled: true, isDefault: true };
  const connection: ProviderConnection = { id: "provider-openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-key-A", enabled: true, models: [model] };
  const saved = await json("POST", baseUrl, "/api/agent/v1/settings/model-connections", { commandId: cmd(), expectedRevision: 0, connection });
  assert.equal(saved.status, 200, `连接保存失败: ${JSON.stringify(saved.body)}`);
}

async function sendAndWait(baseUrl: string, db: AgentDatabase, text: string): Promise<{ requestId: string; state: string; elapsedMs: number; notice: string | null }> {
  const conversation = await json("POST", baseUrl, "/api/agent/v1/conversations", { commandId: cmd(), title: "R2" });
  assert.equal(conversation.status, 201);
  const started = Date.now();
  const sent = await json("POST", baseUrl, `/api/agent/v1/conversations/${conversation.body.id}/messages`, { commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
  assert.equal(sent.status, 202, `发送失败: ${JSON.stringify(sent.body)}`);
  const requestId: string = sent.body.requestId;
  for (let i = 0; i < 1200; i++) {
    const row = db.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string } | undefined;
    if (row && row.state !== "queued" && row.state !== "running") {
      const notice = (db.prepare("SELECT text FROM messages WHERE role='system_notice' AND request_id=?").get(requestId) as { text: string } | undefined)?.text ?? null;
      return { requestId, state: row.state, elapsedMs: Date.now() - started, notice };
    }
    await sleep(100);
  }
  throw new Error(`request ${requestId} 未达终态`);
}

describe("provider timeout layers (R2 受控复现矩阵)", () => {
  it("M1 连接拒绝：立即失败，连接类通知（非超时类）", async () => {
    const port = await reservePort(); // 已关闭端口：连接立即被拒
    await withTextApp(`http://127.0.0.1:${port}`, async world => {
      await configureConnection(world.baseUrl);
      const outcome = await sendAndWait(world.baseUrl, world.db, "连接拒绝对照");
      assert.equal(outcome.state, "failed");
      assert.ok(outcome.notice?.includes("暂时无法连接文本模型"), `通知应为连接类: ${outcome.notice}`);
      assert.ok(outcome.elapsedMs < 5000, `连接拒绝应立即失败: ${outcome.elapsedMs}ms`);
    });
  });

  it("M2 连接黑洞≈10s：DF20 10.5s 签名复现（undici 10s connect→SDK 归一超时文本）", { timeout: 60_000 }, async () => {
    const blackhole = await startSilentTlsBlackhole();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.message); };
    process.on("warning", onWarning);
    try {
      await withTextApp(blackhole.url, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "黑洞对照");
        assert.equal(outcome.state, "failed", `state=${outcome.state}`);
        // executor 只有在 providerError === "Request timed out." 全等时才给超时类通知。
        assert.ok(outcome.notice?.includes("文本模型请求超时"), `通知应为超时类: ${outcome.notice}`);
        assert.ok(!outcome.notice?.includes("暂时无法连接"), `不应是连接类: ${outcome.notice}`);
        assert.ok(outcome.elapsedMs >= 9000 && outcome.elapsedMs <= 16000, `黑洞失败应≈10s（10s connect timeout+开销），实际 ${outcome.elapsedMs}ms`);
        // D1 诊断增强（R2 纠偏后口径）：pi-ai 只透传文本（cause 链在 openai-responses.js 的
        // catch 里已丢失）。告警报整轮耗时 turnElapsedMs 与失败前最后原生事件边界 lastEvent/
        // sinceLastEventMs；黑洞发生在任何 assistant 消息到达之前，lastEvent 不得出现
        // message_start:assistant（模型首响应从未到达是可观测事实），但不用时长判连接层/期限。
        const turnWarning = warnings.find(message => message.includes(`agent turn ${outcome.requestId} 失败`));
        assert.ok(turnWarning, `未捕获回合失败告警: ${JSON.stringify(warnings)}`);
        assert.ok(turnWarning!.includes("Request timed out."), `告警应含原始错误文本: ${turnWarning}`);
        assert.ok(turnWarning!.includes("turnElapsedMs="), `告警缺 turnElapsedMs: ${turnWarning}`);
        const elapsed = Number(/turnElapsedMs=(\d+)/.exec(turnWarning!)?.[1]);
        assert.ok(elapsed >= 9000 && elapsed <= 16000, `告警 turnElapsedMs 应≈10s: ${turnWarning}`);
        assert.ok(/lastEvent=[\w:]+/.test(turnWarning!), `告警缺 lastEvent: ${turnWarning}`);
        assert.ok(turnWarning!.includes("sinceLastEventMs="), `告警缺 sinceLastEventMs: ${turnWarning}`);
        assert.ok(!turnWarning!.includes("lastEvent=message_start:assistant"), `黑洞期间不应有模型首响应到达: ${turnWarning}`);
      });
    } finally {
      process.off("warning", onWarning);
      await blackhole.close();
    }
  });

  it("M3 首字节慢 15s：链路无 ≤15s 隐藏期限，回合成功", { timeout: 60_000 }, async () => {
    const stub = await startResponsesStub({ firstByteDelayMs: 15_000 });
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "慢首字节");
        assert.equal(outcome.state, "completed", `notice=${outcome.notice}`);
        assert.equal(outcome.notice, null);
        assert.ok(outcome.elapsedMs >= 15000, `应等待慢首字节后成功: ${outcome.elapsedMs}ms`);
      });
    } finally { stub.server.close(); }
  });

  it("M4 首字节慢 130s：~120s 处失败于 provider 超时层（pi-runtime 120s 生效）", { timeout: 200_000 }, async () => {
    const stub = await startResponsesStub({ firstByteDelayMs: 130_000 });
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "超过120s的首字节");
        assert.equal(outcome.state, "failed", `notice=${outcome.notice}`);
        assert.ok(outcome.notice?.includes("文本模型请求超时"), `通知应为超时类: ${outcome.notice}`);
        assert.ok(outcome.elapsedMs >= 110_000 && outcome.elapsedMs <= 140_000, `应在 ~120s 处被 provider 超时终结，实际 ${outcome.elapsedMs}ms`);
      });
    } finally { stub.server.close(); }
  });

  it("M5a 流中途停顿 20s：bodyTimeout 内正常补完，不误判超时", { timeout: 60_000 }, async () => {
    const stub = await startResponsesStub({ stall: { stallMs: 20_000, destroy: false } });
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "中途停顿");
        assert.equal(outcome.state, "completed", `notice=${outcome.notice}`);
        assert.ok(outcome.elapsedMs >= 20000, `应度过 20s 停顿后成功: ${outcome.elapsedMs}ms`);
      });
    } finally { stub.server.close(); }
  });

  it("M5b 流中途断流：失败且归类为连接/执行失败，不是超时类", { timeout: 30_000 }, async () => {
    const stub = await startResponsesStub({ stall: { stallMs: 3_000, destroy: true } });
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "中途断流");
        assert.equal(outcome.state, "failed", `notice=${outcome.notice}`);
        assert.ok(!outcome.notice?.includes("文本模型请求超时"), `断流不应归类超时: ${outcome.notice}`);
      });
    } finally { stub.server.close(); }
  });

  it("M6 hold 期间停止：stopped、通知为已停止、hold 释放后无failed", { timeout: 30_000 }, async t => {
    const diagnostics: TurnDiagnostic[] = [];
    const collect = (event: unknown) => diagnostics.push(event as TurnDiagnostic);
    turnDiagnostics.subscribe(collect);
    t.after(() => { turnDiagnostics.unsubscribe(collect); });
    const stub = await startResponsesStub();
    stub.manual = true;
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const conversation = await json("POST", world.baseUrl, "/api/agent/v1/conversations", { commandId: cmd(), title: "R2 停止" });
        const sent = await json("POST", world.baseUrl, `/api/agent/v1/conversations/${conversation.body.id}/messages`, { commandId: cmd(), text: "将被停止", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
        assert.equal(sent.status, 202);
        const requestId: string = sent.body.requestId;
        for (let i = 0; i < 300; i++) { if (stub.calls >= 1) break; await sleep(50); }
        assert.ok(stub.calls >= 1, "请求应已到达替身");
        const stopped = await json("POST", world.baseUrl, `/api/agent/v1/requests/${requestId}/stop`, { commandId: cmd() });
        assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
        stub.release();
        let state = "running";
        for (let i = 0; i < 300; i++) {
          const row = world.db.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string } | undefined;
          if (row && row.state !== "queued" && row.state !== "running") { state = row.state; break; }
          await sleep(50);
        }
        assert.equal(state, "stopped");
        const diagnostic = diagnostics.find(event => event.requestId === requestId);
        assert.equal(diagnostic?.outcome, "stopped");
        assert.equal(diagnostic?.abortReason, "stopped_pending");
        assert.ok(diagnostic?.turnElapsedMs != null);
        const notice = (world.db.prepare("SELECT text FROM messages WHERE role='system_notice' AND request_id=?").get(requestId) as { text: string } | undefined)?.text;
        assert.ok(notice?.includes("本回合已停止"), `通知应为已停止: ${notice}`);
      });
    } finally { stub.server.close(); }
  });

  it("M7 多轮模型和工具后失败：收尾事件不覆盖每段计时", { timeout: 60_000 }, async t => {
    const diagnostics: TurnDiagnostic[] = [];
    const collect = (event: unknown) => diagnostics.push(event as TurnDiagnostic);
    turnDiagnostics.subscribe(collect);
    t.after(() => { turnDiagnostics.unsubscribe(collect); });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.message); };
    process.on("warning", onWarning);
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        const call = ++calls;
        if (call === 1) {
          const functionCall = [
            ["response.created", { response: { id: "resp_m7" } }],
            ["response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_m7", call_id: "call_m7", name: "start_work", arguments: "" } }],
            ["response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_m7", call_id: "call_m7", name: "start_work", arguments: JSON.stringify({ title: "诊断样本作品" }) } }],
            ["response.completed", { response: { id: "resp_m7", status: "completed", usage: { input_tokens: 24, output_tokens: 6 } } }],
          ] as SseEvent[];
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          response.end(functionCall.map(sse).join(""));
        } else {
          response.destroy(); // 第二轮模型等待期间连接被销毁 → 抛错路径失败
        }
      });
    });
    let calls = 0;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await withTextApp(baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const outcome = await sendAndWait(world.baseUrl, world.db, "正式开始一条视频，命名为诊断样本作品。");
        assert.equal(outcome.state, "failed", `state=${outcome.state} notice=${outcome.notice}`);
        assert.ok(calls >= 2, `第二轮模型请求应已发出: calls=${calls}`);
        const turnWarning = warnings.find(message => message.includes(`agent turn ${outcome.requestId} 失败`));
        assert.ok(turnWarning, `未捕获回合失败告警: ${JSON.stringify(warnings)}`);
        const elapsed = Number(/turnElapsedMs=(\d+)/.exec(turnWarning!)?.[1]);
        assert.ok(elapsed > 0, `告警应含正的整轮耗时: ${turnWarning}`);
        const diagnostic = diagnostics.find(event => event.requestId === outcome.requestId)!;
        const stored = world.db.prepare("SELECT execution_epoch, message_id, updated_at FROM requests WHERE id=?")
          .get(outcome.requestId) as { execution_epoch: number; message_id: string; updated_at: string };
        assert.equal(diagnostic.epoch, stored.execution_epoch);
        assert.equal(diagnostic.messageId, stored.message_id);
        assert.equal(diagnostic.finalizedAt, stored.updated_at);
        assert.equal(diagnostic.outcome, "failed");
        assert.equal(diagnostic.turnElapsedMs, elapsed);
        const assistants = diagnostic.native.filter(event => event.event === "assistant_end");
        const started = diagnostic.native.find(event => event.event === "tool_execution_start");
        const ended = diagnostic.native.find(event => event.event === "tool_execution_end");
        assert.deepEqual(assistants.map(event => event.stopReason), ["toolUse", "error"]);
        assert.ok(assistants.every(event => event.sdkDurationMs != null));
        assert.ok(started?.event === "tool_execution_start" && ended?.event === "tool_execution_end");
        assert.equal(ended.ordinal, started.ordinal);
        assert.equal(ended.label, "准备作品");
        assert.equal(ended.failed, false);
        assert.ok(ended.sdkDurationMs != null);
        assert.ok(assistants[0]!.offsetMs <= started.offsetMs && ended.offsetMs <= assistants[1]!.offsetMs);
        assert.ok(assistants[1]!.offsetMs <= elapsed);
      });
    } finally {
      process.off("warning", onWarning);
      server.close();
    }
  });

  it("M8 prompt 抛出异常：有结束计时、无错误正文或上一回合的助手时长", async t => {
    const diagnostics: TurnDiagnostic[] = [];
    const collect = (event: unknown) => diagnostics.push(event as TurnDiagnostic);
    turnDiagnostics.subscribe(collect);
    t.after(() => { turnDiagnostics.unsubscribe(collect); });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.message); };
    process.on("warning", onWarning);
    t.after(() => { process.off("warning", onWarning); });
    const stub = await startResponsesStub();
    const privateMarker = "private-r2-prompt-error";
    try {
      await withTextApp(stub.baseUrl, async world => {
        await configureConnection(world.baseUrl);
        const first = await sendAndWait(world.baseUrl, world.db, "正常回答");
        assert.equal(first.state, "completed");
        const { conversation_id: id } = world.db.prepare("SELECT conversation_id FROM requests WHERE id=?").get(first.requestId) as { conversation_id: string };
        const session = world.registry.for(id).session!;
        t.mock.method(session, "prompt", async () => { throw new Error(privateMarker); });
        const sent = await json("POST", world.baseUrl, `/api/agent/v1/conversations/${id}/messages`, { commandId: cmd(), text: "诊断回调异常", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null });
        assert.equal(sent.status, 202);
        const requestId: string = sent.body.requestId;
        for (let i = 0; i < 60 && !diagnostics.some(event => event.requestId === requestId); i++) await sleep(25);
        const diagnostic = diagnostics.find(event => event.requestId === requestId)!;
        assert.equal(diagnostic.outcome, "failed");
        assert.ok(diagnostic.epoch > diagnostics.find(event => event.requestId === first.requestId)!.epoch);
        assert.ok(diagnostic.turnElapsedMs !== null);
        assert.deepEqual(diagnostic.native, []);
        const warning = warnings.find(message => message.includes(requestId))!;
        assert.match(warning, /本回合执行失败.*errorName=Error/);
        assert.doesNotMatch(warning, /private-r2-prompt-error|assistantDurationMs=/);
        assert.equal(stub.calls, 1);
      });
    } finally { stub.server.close(); }
  });
});
