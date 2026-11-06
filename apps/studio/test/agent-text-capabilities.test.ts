import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { calculateCost, InMemoryCredentialStore, type Model, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiRuntimeHost } from "../src/server/agent/pi-runtime.js";
import type { PiTextRegistration } from "../src/server/agent/text-model-settings.js";
import { defaultTextBindingOf, initializeTextModelSettings, textModelsView, textRegistrationOf } from "../src/server/agent/text-model-settings.js";
import { readProviderConnections } from "../src/server/agent/provider-connections.js";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { findOpenAIChatModel, openaiChatCatalog, resolveThinkingLevel, thinkingCapabilityOf } from "../src/server/agent/text-model.js";

// 阶段一（OpenAI Responses 收敛）的文本能力验收：目录精确匹配、推理档位三分支、
// Pi 原生 openai-responses 真实序列化与冻结执行。所有 HTTP 由本地替身承接，
// SDK、SQLite、会话持久化都是真实实现。

const staticClock = () => "2026-10-29T00:00:00.000Z";
const skillsRoot = path.resolve(import.meta.dirname, "../skills");
const OPENAI = "https://api.openai.com/v1";

test("M1 精确目录查询沿用 URL 规范化；网关地址、错误路径与其他型号不冒充能力", () => {
  assert.equal(findOpenAIChatModel("gpt-6.1-sol", OPENAI)?.id, "gpt-6.1-sol");
  assert.equal(findOpenAIChatModel("gpt-6.1-sol", "https://API.OPENAI.COM:443/v1/")?.id, "gpt-6.1-sol");
  for (const [modelId, baseUrl] of [
    ["gpt-6.1-sol", "https://gateway.example.test/v1"],
    ["gpt-6.1-sol", "https://api.openai.com/v2"],
    ["sol", OPENAI],
    ["gpt-realtime-2.1", OPENAI],
    ["gpt-5.3-codex", OPENAI],
  ] as const) assert.equal(findOpenAIChatModel(modelId, baseUrl), null, `${modelId}@${baseUrl}`);
  // Realtime 是语音会话出口、Codex 是订阅专用路由，都不进入文本目录。
  assert.equal(openaiChatCatalog().has("gpt-6.1-sol"), true);
  assert.equal(openaiChatCatalog().has("gpt-realtime-2.1"), false);
  assert.equal(openaiChatCatalog().has("gpt-5.3-codex"), false);
});

test("R02 推理能力三分支与精确身份：已知推理/已知非推理/未核实", () => {
  const capabilityOf = (modelId: string, baseUrl = OPENAI) => thinkingCapabilityOf(findOpenAIChatModel(modelId, baseUrl));
  // Sol 无 off/minimal；Luna 有 off；medium 都是原生默认。
  assert.deepEqual(capabilityOf("gpt-6.1-sol"), { levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" });
  assert.deepEqual(capabilityOf("gpt-6-luna"), { levels: ["off", "low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" });
  // 默认 medium 不受支持时向上夹取到第一个可用档，不静默降档。
  assert.deepEqual(capabilityOf("gpt-5-pro"), { levels: ["high"], defaultLevel: "high" });
  // 已知非推理是原生 [off]，不是“未核实”。
  assert.deepEqual(capabilityOf("gpt-4o"), { levels: ["off"], defaultLevel: "off" });
  assert.equal(capabilityOf("gpt-6.1-sol", "https://gateway.example.test/v1"), null, "网关地址未核实");
  assert.equal(capabilityOf("local-model"), null, "目录外型号");
});

test("R07 原生新会话默认与薄映射一致，medium 不受支持时按实际列表夹取", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-r07-default-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  await runtime.setRuntimeApiKey("openai", "sk-synthetic-r07");
  for (const [id, expected] of [
    ["gpt-6.1-sol", "medium"],
    ["gpt-6-luna", "medium"],
    ["gpt-5-pro", "high"],
    ["gpt-4o", "off"],
  ] as const) {
    const model = runtime.getModel("openai", id)!;
    assert.equal(resolveThinkingLevel(model as Model<"openai-responses">, "default"), expected, `${id} 薄映射`);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "仅用于本地默认档位验证。" });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: model as Model<"openai-responses">,
      resourceLoader, sessionManager: SessionManager.inMemory(directory), settingsManager, tools: [] });
    try { assert.equal(session.thinkingLevel, expected, `${id} 原生默认`); }
    finally { session.dispose(); }
  }
});

function registrationOf(overrides: Partial<PiTextRegistration> = {}): PiTextRegistration {
  return {
    providerId: "cfg-openai-sol", protocol: "openai-responses", baseUrl: OPENAI,
    modelId: "gpt-6.1-sol", contextWindowTokens: 272_000, maxOutputTokens: 16_384,
    thinkingLevel: "medium", apiKey: "sk-synthetic-p2-a", ...overrides,
  };
}

function bindingOf(registration: PiTextRegistration) {
  return {
    providerId: registration.providerId, modelId: registration.modelId,
    connectionId: `conn-${registration.providerId}`, configurationRevisionId: registration.providerId,
  };
}

async function hostFor(t: TestContext, registrations: PiTextRegistration[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-p2-capabilities-"));
  const host = new PiRuntimeHost({
    dataDir: directory, skillsRoot,
    textVersions: binding => registrations.find(entry => entry.providerId === binding.providerId) ?? null,
  });
  t.after(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }); });
  await host.init();
  return host;
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function responsesSse(text: string): string {
  const events = [
    { type: "response.created", response: { id: "resp_p2" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_p2", status: "completed", usage: { input_tokens: 12, output_tokens: 6 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function functionCallSse(callId: string, name: string, argumentsJson: string): string {
  const events = [
    { type: "response.created", response: { id: "resp_p2" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: callId, name, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: callId, name, arguments: argumentsJson, status: "completed" } },
    { type: "response.completed", response: { id: "resp_p2", status: "completed", usage: { input_tokens: 12, output_tokens: 9 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

// 拦截官方 client 已序列化的 Request；逻辑 URL 保持原值，不把 localhost 当目录身份。
function captureRequests(t: TestContext): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, any> });
    return new Response(responsesSse("本地替身回复。"), { headers: { "content-type": "text/event-stream" } });
  });
  return calls;
}

/** Responses 请求携带档位的 input 条目（supportsMidConvoEffort 型号的 configuration_update）。 */
function configurationUpdatesOf(call: CapturedRequest) {
  return (call.body.input as Array<Record<string, any>>).filter(item => item.type === "configuration_update");
}

test("业务状态经过真实 OpenAI Responses 序列化仍是系统数据，且不覆盖用户原话", async t => {
  const registration = registrationOf({ providerId: "context-wire" });
  const calls = captureRequests(t);
  const host = await hostFor(t, [registration]);
  const selection = await host.modelForBinding(bindingOf(registration));
  let frame = '[frame-current-state]{"deliveryClosed":false}\n临时业务状态';
  const { session } = await host.openConversationSession("context-wire", "s1", [], [], selection, undefined, () => frame);
  t.after(() => session.dispose());
  await session.prompt("先交内容草稿，等我看完。");
  frame = '[frame-current-state]{"deliveryClosed":true}\n临时业务状态';
  await session.prompt("这版认可，暂不继续。");
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    const input = call.body.input as Array<{ role?: string; content?: unknown }>;
    // Responses 形状：系统指令是字符串 content，用户消息是 input_text 内容块数组。
    const system = input.filter(item => item.role === "developer" || item.role === "system")
      .map(item => item.content as string).join("\n");
    assert.equal(system.split("[frame-current-state]").length - 1, 1);
    assert.ok(system.includes(`"deliveryClosed":${index === 1}`));
    const userTexts = input.filter(item => item.role === "user").map(item =>
      (item.content as Array<{ type: string; text: string }>).filter(block => block.type === "input_text").map(block => block.text).join(""));
    assert.deepEqual(userTexts, ["先交内容草稿，等我看完。", "这版认可，暂不继续。"].slice(0, index + 1));
  }
});

test("M1/M2 注册仅承接精确目录能力，保留冻结身份和窗口/输出预算", async t => {
  const registration = registrationOf();
  const host = await hostFor(t, [registration]);
  const { model, thinkingLevel } = await host.modelForBinding(bindingOf(registration));
  assert.equal(thinkingLevel, "medium");
  const known = openaiChatCatalog().get("gpt-6.1-sol")!;
  assert.deepEqual({ input: model.input, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
    inputLimits: model.inputLimits, compat: model.compat },
  { input: known.input, reasoning: known.reasoning, thinkingLevelMap: known.thinkingLevelMap,
    inputLimits: known.inputLimits, compat: known.compat });
  assert.equal(model.provider, registration.providerId);
  assert.equal(model.id, registration.modelId);
  assert.equal(model.baseUrl, registration.baseUrl);
  assert.equal(model.contextWindow, 272_000);
  assert.equal(model.maxTokens, 16_384);
  assert.equal(model.headers, undefined);
  assert.equal(model.promptCache, undefined);
  assert.equal(model.samplingParams, undefined);
  assert.equal(model.samplingParamsByThinkingLevel, undefined);
  assert.deepEqual(model.cost, known.cost, "精确官方型号保留 Pi 原生价格与缓存/分档");
  const usage: Usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.deepEqual(calculateCost(model, structuredClone(usage)), calculateCost(known, structuredClone(usage)));
  assert.ok(calculateCost(model, structuredClone(usage)).total > 0);
  captureRequests(t);
  const { session, sessionDir } = await host.openConversationSession("cost-estimate", "s1", [], [], { model, thinkingLevel });
  t.after(() => session.dispose());
  await session.prompt("记录本轮用量估价。");
  const log = readFileSync(path.join(sessionDir, (await readdir(sessionDir)).find(name => name.endsWith(".jsonl"))!), "utf8");
  const response = log.trim().split("\n").map(line => JSON.parse(line)).reverse().find(entry => entry.message?.role === "assistant");
  assert.equal(response.message.usage.input, 12);
  assert.deepEqual(response.message.usage.cost, calculateCost(known, structuredClone(usage)), "原生日志是本轮估价，不冒充实收账单");
});

test("M4 未知型号、官方域名其他路径和网关地址均保留通用兼容值", async t => {
  const registrations = [
    registrationOf({ providerId: "cfg-p2-custom-id", modelId: "custom-model" }),
    registrationOf({ providerId: "cfg-p2-custom-path", baseUrl: "https://api.openai.com/custom" }),
    registrationOf({ providerId: "cfg-p2-custom-gateway", baseUrl: "https://gateway.example.test/v1" }),
  ];
  const host = await hostFor(t, registrations);
  for (const registration of registrations) {
    const { model } = await host.modelForBinding(bindingOf(registration));
    assert.equal(model.baseUrl, registration.baseUrl);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.equal(model.inputLimits, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
    assert.deepEqual(model.compat, { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false });
  }
});

test("R10 真实 Pi 序列化：Responses 端点、冻结身份与输出上限；档位按型号族真实生效", { timeout: 30_000 }, async t => {
  const calls = captureRequests(t);
  const registrations = [
    registrationOf({ providerId: "cfg-r10-sol-medium" }),
    registrationOf({ providerId: "cfg-r10-sol-low", thinkingLevel: "low", apiKey: "sk-synthetic-r10-b" }),
    registrationOf({ providerId: "cfg-r10-luna-off", modelId: "gpt-6-luna", thinkingLevel: "off", apiKey: "sk-synthetic-r10-c" }),
    registrationOf({ providerId: "cfg-r10-o3-low", modelId: "o3", thinkingLevel: "low", contextWindowTokens: 200_000, maxOutputTokens: 8_192, apiKey: "sk-synthetic-r10-d" }),
    registrationOf({ providerId: "cfg-r10-4o", modelId: "gpt-4o", thinkingLevel: "off", contextWindowTokens: 128_000, maxOutputTokens: 4_096, apiKey: "sk-synthetic-r10-e" }),
    registrationOf({ providerId: "cfg-r10-unknown", baseUrl: "https://gateway.example.test/v1", modelId: "local-model", contextWindowTokens: 32_000, maxOutputTokens: 2_000, apiKey: "sk-synthetic-r10-f" }),
  ];
  const host = await hostFor(t, registrations);
  const { session } = await host.openConversationSession("r10", "s1", undefined, [], await host.modelForBinding(bindingOf(registrations[0]!)));
  t.after(() => session.dispose());
  for (const registration of registrations) {
    await host.applySessionModel(session, await host.modelForBinding(bindingOf(registration)));
    const before = calls.length;
    await session.prompt(`R10 ${registration.providerId}`);
    assert.equal(calls.length, before + 1, "每轮只执行一份本地替身请求");
    const call = calls.at(-1)!;
    assert.equal(call.url, `${registration.baseUrl}/responses`);
    assert.equal(call.body.model, registration.modelId);
    assert.equal(call.body.max_output_tokens, registration.maxOutputTokens, "实际序列化使用冻结输出上限");
    assert.equal(call.body.store, false);
    assert.equal(call.headers.get("authorization"), `Bearer ${registration.apiKey}`, "实际请求使用冻结身份");
    assert.equal(JSON.stringify(call.body).includes("synthetic-r10"), false, "合成 Key 不进入模型正文");
    if (registration.providerId === "cfg-r10-sol-medium" || registration.providerId === "cfg-r10-sol-low") {
      // supportsMidConvoEffort 型号：顶层 effort 固定 medium，冻结档位由末尾 configuration_update 携带。
      assert.deepEqual(call.body.reasoning, { effort: "medium", summary: "auto" });
      assert.equal(configurationUpdatesOf(call).at(-1)?.reasoning?.effort, registration.thinkingLevel);
    } else if (registration.providerId === "cfg-r10-luna-off") {
      // off 走目录映射 none：无 summary，也无 configuration_update。
      assert.deepEqual(call.body.reasoning, { effort: "none" });
      assert.equal(configurationUpdatesOf(call).length, 0);
    } else if (registration.providerId === "cfg-r10-o3-low") {
      // 旧一代推理型号把档位直接写进 reasoning.effort。
      assert.deepEqual(call.body.reasoning, { effort: "low", summary: "auto" });
      assert.equal(configurationUpdatesOf(call).length, 0);
    } else {
      assert.equal(call.body.reasoning, undefined);
    }
  }
  assert.equal(calls.length, registrations.length);
});

test("R11 必须推理型号：受支持档位正常，旧冻结 off 在无 off 型号上受控失败且不发出请求", { timeout: 30_000 }, async t => {
  const calls = captureRequests(t);
  const sol = registrationOf({ providerId: "cfg-r11-sol" });
  const luna = registrationOf({ providerId: "cfg-r11-luna", modelId: "gpt-6-luna", thinkingLevel: "off", apiKey: "sk-synthetic-r11-b" });
  const host = await hostFor(t, [sol, luna]);
  const { session } = await host.openConversationSession("r11", "s1", undefined, [], await host.modelForBinding(bindingOf(sol)));
  t.after(() => session.dispose());
  for (const registration of [sol, luna]) {
    const selection = await host.modelForBinding(bindingOf(registration));
    assert.equal(selection.thinkingLevel, registration.thinkingLevel);
    await host.applySessionModel(session, selection);
    const before = calls.length;
    await session.prompt(`R11 ${registration.providerId}`);
    assert.equal(calls.length, before + 1);
  }
  const legacy = registrationOf({ providerId: "cfg-r11-sol-legacy", thinkingLevel: "off" as const, apiKey: "sk-synthetic-r11-c" });
  const legacyHost = await hostFor(t, [legacy]);
  await assert.rejects(legacyHost.modelForBinding(bindingOf(legacy)), /不支持“off”推理档位（旧配置）/);
  assert.equal(calls.length, 2, "产品拒绝发生在 provider 请求前");
});

test("R06/R08 冻结档位随请求生效：运行中改档不重新解释已受理请求，旧会话档位不压过新设置", { timeout: 30_000 }, async t => {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  let released!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as Record<string, any>;
    calls.push({ url: request.url, body });
    if (calls.length === 1) await gate;
    // A 首轮先调真实技能读取工具，工具续轮仍用 A 的冻结绑定。
    const events = calls.length === 1
      ? functionCallSse("call_r06", "read_skill_file", "{\"path\":\"travel-prompt-kit/SKILL.md\"}")
      : responsesSse("已按冻结档位处理。");
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-r06-"));
  const runtime = await createAgentRuntime({
    providerConnections: true, dataDir, skillsRoot, host: {}, models: [], defaultModelId: "unconfigured", clock: staticClock,
    text: { factory: (db: Parameters<NonNullable<Parameters<typeof createAgentRuntime>[0]["text"]>["factory"]>[0]) => {
      initializeTextModelSettings(db, staticClock);
      return { models: () => textModelsView(db), defaultBinding: () => defaultTextBindingOf(db), resolve: binding => textRegistrationOf(db, binding) };
    } },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const db = runtime.database;
  const model = { id: "model-r06", kind: "text" as const, name: "Sol", modelId: "gpt-6.1-sol", features: [],
    contextWindowTokens: 200_000, maxOutputTokens: 4_096, enabled: true, isDefault: true, thinkingLevel: "medium" as const };
  const connection = { id: "provider-r06", name: "OpenAI", protocol: "openai" as const,
    baseUrl: OPENAI, apiKey: "sk-synthetic-r06-key", enabled: true, models: [model] };
  runtime.service.saveProviderConnection("local-owner", { commandId: "save-r06-a", expectedRevision: 0, connection });
  const conversation = runtime.service.createConversation("local-owner", { commandId: "conv-r06", title: "R06" }).conversation.id;
  const input = (commandId: string, text: string) => ({ commandId, text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });
  await runtime.service.sendMessage("local-owner", conversation, input("send-r06-a", "先读技能再回答"));
  const deadline = Date.now() + 10_000;
  while (calls.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 1, "A 已进入 provider 请求");
  // A 运行中保存新档位/新输出上限，再受理 B：A 的冻结绑定不被重新解释。
  runtime.service.saveProviderConnection("local-owner", {
    commandId: "save-r06-b", expectedRevision: readProviderConnections(db).revision,
    connection: { ...connection, models: [{ ...model, maxOutputTokens: 8_192, thinkingLevel: "low" }] },
  });
  await runtime.service.sendMessage("local-owner", conversation, input("send-r06-b", "继续"));
  released();
  for (let n = 0; n < 3_000; n++) {
    const pending = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE conversation_id=? AND state IN ('queued','running')").get(conversation) as { n: number };
    if (pending.n === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(calls.map(call => call.body.max_output_tokens), [4_096, 4_096, 8_192]);
  assert.deepEqual(calls.map(call => (call.body.input as any[]).filter((item: any) => item.type === "configuration_update").at(-1)?.reasoning?.effort), ["medium", "medium", "low"]);
  assert.deepEqual(calls.map(call => call.body.model), ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6.1-sol"]);
  assert.equal(runtime.registry.for(conversation).session?.thinkingLevel, "low", "B 已应用新档位");
  // 旧绑定仍按旧档位解析，新绑定解析新档位。
  const bindings = db.prepare("SELECT binding_json FROM text_model_versions ORDER BY rowid").all() as { binding_json: string }[];
  assert.equal(bindings.length, 2);
  const resolved = bindings.map(row => textRegistrationOf(db, JSON.parse(row.binding_json) as { providerId: string; modelId: string; connectionId: string; configurationRevisionId: string })!);
  assert.deepEqual(resolved.map(entry => entry.thinkingLevel), ["medium", "low"]);
  assert.deepEqual(resolved.map(entry => entry.maxOutputTokens), [4_096, 8_192]);
});

test("M3 原生目录 off=null 会实际夹取并发送推理；这是固定 SDK 目录行为", { timeout: 30_000 }, async t => {
  const calls = captureRequests(t);
  const directory = await mkdtemp(path.join(tmpdir(), "frame-p2-native-off-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "仅用于本地 SDK 序列化验证。" });
  await resourceLoader.reload();
  // sk- 前缀走 API Key 路径；非 sk- 凭据在官方地址上会被 SDK 视为 ChatGPT 登录而省略字段。
  await runtime.setRuntimeApiKey("openai", "sk-unit-test-only");
  const sol = runtime.getModel("openai", "gpt-6.1-sol")!;
  const luna = runtime.getModel("openai", "gpt-6-luna")!;
  assert.equal(sol.thinkingLevelMap?.off, null);
  assert.equal(luna.thinkingLevelMap?.off, "none");
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
    model: sol, thinkingLevel: "off", sessionManager: SessionManager.inMemory(directory),
    resourceLoader, settingsManager, tools: [] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  assert.equal(session.thinkingLevel, "low", "Pi 把不支持的 off 夹取到第一个可用档");
  await session.prompt("新建会话的原生行为复现");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${OPENAI}/responses`);
  assert.deepEqual(calls[0]!.body.reasoning, { effort: "medium", summary: "auto" });
  assert.deepEqual(configurationUpdatesOf(calls[0]!), [{ type: "configuration_update", reasoning: { effort: "low" } }]);

  await session.setModel(luna, { persist: false });
  assert.equal(session.thinkingLevel, "low");
  await session.prompt("切模型的原生行为复现");
  await session.reload();
  assert.equal(session.thinkingLevel, "low");
  await session.prompt("reload 后的原生行为复现");
  for (const call of calls.slice(1)) {
    assert.equal(call.url, `${OPENAI}/responses`);
    assert.equal(call.body.model, "gpt-6-luna");
    assert.equal(configurationUpdatesOf(call).at(-1)?.reasoning?.effort, "low");
  }
  assert.equal(calls.length, 3);
  t.diagnostic("Pi 1.4.0 本地实际请求：gpt-6.1-sol off→low（configuration_update 携带）；gpt-6-luna 切换与 reload 保持 low。");
});

test("R09 Skill reload 后就地复用会话并保持本次档位、压缩参数与工具白名单", { timeout: 30_000 }, async t => {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, body: await request.json() as Record<string, any> });
    return new Response(responsesSse("reload 后正常回复。"), { headers: { "content-type": "text/event-stream" } });
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-r09-"));
  const runtime = await createAgentRuntime({
    providerConnections: true, dataDir, skillsRoot, host: {}, models: [], defaultModelId: "unconfigured", clock: staticClock,
    text: { factory: (db: Parameters<NonNullable<Parameters<typeof createAgentRuntime>[0]["text"]>["factory"]>[0]) => {
      initializeTextModelSettings(db, staticClock);
      return { models: () => textModelsView(db), defaultBinding: () => defaultTextBindingOf(db), resolve: binding => textRegistrationOf(db, binding) };
    } },
  });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const db = runtime.database;
  const model = { id: "model-r09", kind: "text" as const, name: "Sol", modelId: "gpt-6.1-sol", features: [],
    contextWindowTokens: 16_384, maxOutputTokens: 4_096, enabled: true, isDefault: true, thinkingLevel: "medium" as const };
  const connection = { id: "provider-r09", name: "OpenAI", protocol: "openai" as const,
    baseUrl: OPENAI, apiKey: "sk-synthetic-r09-key", enabled: true, models: [model] };
  runtime.service.saveProviderConnection("local-owner", { commandId: "save-r09-a", expectedRevision: 0, connection });
  const conversation = runtime.service.createConversation("local-owner", { commandId: "conv-r09", title: "R09" }).conversation.id;
  const input = (commandId: string, text: string) => ({ commandId, text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });
  const settled = async () => {
    for (let n = 0; n < 3_000; n++) {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE conversation_id=? AND state IN ('queued','running')").get(conversation) as { n: number };
      if (pending.n === 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("请求未在期限内结束");
  };
  await runtime.service.sendMessage("local-owner", conversation, input("send-r09-a", "第一轮"));
  await settled();
  assert.equal(calls.length, 1);
  const runner = runtime.registry.for(conversation);
  const session = runner.session!;
  const compactionOf = () => { const value = session.settingsManager.getCompactionSettings(); return { reserveTokens: value.reserveTokens, keepRecentTokens: value.keepRecentTokens }; };
  assert.equal(session.thinkingLevel, "medium");
  assert.deepEqual(compactionOf(), { reserveTokens: 4_096, keepRecentTokens: 4_096 });
  // 同一型号、同一 Key 只改档位；走 Skill 安装/卸载后的 reloadIdleSkills 路径。
  runtime.service.saveProviderConnection("local-owner", { commandId: "save-r09-b", expectedRevision: readProviderConnections(db).revision,
    connection: { ...connection, models: [{ ...model, thinkingLevel: "low" }] } });
  await runtime.registry.reloadIdleSkills();
  assert.equal(runner.session, session, "reload 就地复用 Pi 会话，不新建文件");
  // reload 只恢复会话当时状态（medium）；新档位由下一请求的冻结绑定在 prompt 前显式应用。
  assert.equal(session.thinkingLevel, "medium", "reload 不提前改写会话，旧 JSONL 记录保持原样");
  assert.deepEqual(compactionOf(), { reserveTokens: 4_096, keepRecentTokens: 4_096 }, "reload 后压缩参数仍按小窗口");
  await runtime.service.sendMessage("local-owner", conversation, input("send-r09-b", "reload 后第二轮"));
  await settled();
  assert.equal(calls.length, 2);
  assert.equal(session.thinkingLevel, "low", "下一请求按冻结设置应用新档位");
  assert.equal(calls[1]!.body.max_output_tokens, 4_096);
  assert.equal((calls[1]!.body.input as any[]).filter((item: any) => item.type === "configuration_update").at(-1)?.reasoning?.effort, "low", "下一请求按冻结的新档位序列化");
  // Responses 工具声明在 additional_tools 条目里（supportsAdditionalTools 型号）。
  const toolNames = (calls[1]!.body.input as any[])
    .filter((item: any) => item.type === "additional_tools")
    .flatMap((item: any) => item.tools.map((tool: any) => tool.name));
  for (const name of ["read_skill_file", "read_artifact", "deliver_artifacts", "prepare_production"]) {
    assert.ok(toolNames.includes(name), `reload 后工具白名单缺失 ${name}`);
  }
  const sessionDir = path.join(dataDir, "pi-sessions", conversation, "s1");
  const files = (await readdir(sessionDir)).filter(file => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const entries = readFileSync(path.join(sessionDir, files[0]!), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string });
  const changes = entries.filter(entry => entry.type === "thinking_level_change");
  assert.ok(changes.length >= 2, "档位变化写入原生会话记录");
  assert.ok(JSON.stringify(entries.slice(0, 4)).includes("medium"), "历史保留原 medium 记录，不改写");
});
