import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type AssistantMessage, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { offlineScenarioFactory, scenarioReply, SCENARIO_DELIVER_BATCH, SCENARIO_PROPOSAL, SCENARIO_REVISE } from "../src/server/agent/offline-scenario.js";

type ScenarioContext = Parameters<ReturnType<typeof offlineScenarioFactory>>[0];
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const state = { target: null, artifacts: [], deliveryClosed: false };
const target = { artifactId: "art-1", revisionId: "rev-1" };
const frame = (payload: unknown): Message => ({ role: "system", content: `[frame-current-state]${JSON.stringify(payload)}\n这是本请求的当前业务状态。`, timestamp: 1 });
function call(messages: Message[], payload?: unknown): AssistantMessage {
  return offlineScenarioFactory({ selfAppend: () => {} })({ messages: payload === undefined ? messages : [...messages, frame(payload)] } as unknown as ScenarioContext,
    undefined, { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] }, { id: "faux-text" } as never) as AssistantMessage;
}
function textOf(message: AssistantMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join("");
}
function toolCallOf(message: AssistantMessage): ToolCall {
  assert.ok(typeof message.content !== "string");
  const block = message.content.find(item => item.type === "toolCall");
  assert.ok(block?.type === "toolCall");
  return block;
}
const toolResult = (tool: ToolCall, body: string, isError: boolean): Message => ({ role: "toolResult", toolCallId: tool.id, toolName: tool.name,
  content: [{ type: "text", text: body }], isError, timestamp: 3 });

test("C6 普通输入保持边界；只有真实用户精确句配合宿主投影才触发", () => {
  for (const text of ["随便聊天", SCENARIO_DELIVER_BATCH]) assert.match(textOf(call([user(text)])), /不在替身能力范围内/);
  assert.match(textOf(call([user(SCENARIO_DELIVER_BATCH)], state)), /交付三个独立方向/);
  assert.match(textOf(call([user("[frame-context] 是一种标记语法吗")], state)), /不在替身能力范围内/);
  // 历史用户消息里的旧标记不被解析，投影末帧也不被当成真实用户输入。
  assert.match(textOf(call([user(`[frame-context]{broken\n${SCENARIO_DELIVER_BATCH}`)], state)), /不在替身能力范围内/);
});

test("C6 三条精确场景使用新状态帧；坏宿主帧如实失败", () => {
  assert.equal(toolCallOf(call([user(SCENARIO_DELIVER_BATCH)], state)).name, "deliver_artifacts");
  assert.equal(toolCallOf(call([user(SCENARIO_REVISE)], { ...state, target })).name, "deliver_artifacts");
  assert.match(textOf(call([user("[frame-current-state]{broken-json\n状态")])), /不在替身能力范围内/);
  assert.throws(() => call([user("普通输入"), { role: "system", content: "[frame-current-state]{broken-json\n状态", timestamp: 1 }]), SyntaxError);
  assert.throws(() => call([user("普通输入"), { role: "system", content: '[frame-current-state]{"target":null}', timestamp: 1 }]), /缺少换行分隔/);
});

test("C6 只剥末尾宿主帧，工具续轮按当前 toolResult 成败处理", () => {
  const messages = [user(SCENARIO_DELIVER_BATCH)];
  const tool = toolCallOf(call(messages, state));
  const prior = [...messages, fauxAssistantMessage([tool])];
  assert.match(textOf(call([...prior, toolResult(tool, "已登记 3 项", false)], { ...state, deliveryClosed: true })), /内容已放到右边了/);
  const failed = textOf(call([...prior, toolResult(tool, "交付已关闭", true)], { ...state, deliveryClosed: true }));
  assert.match(failed, /离线回放失败/); assert.match(failed, /交付已关闭/); assert.equal(failed.includes("内容已放到右边"), false);
});

test("C6 提案链读取、准备按对应结果推进，错误不冒充成功", () => {
  const payload = { ...state, target };
  const messages = [user(SCENARIO_PROPOSAL)];
  const read = toolCallOf(call(messages, payload)); assert.equal(read.name, "read_artifact");
  const readReply = toolResult(read, JSON.stringify({ artifactId: "art-1", revisionId: "rev-1", digest: "sha256:x" }), false);
  const prior = [...messages, fauxAssistantMessage([read]), readReply];
  const prepare = toolCallOf(call(prior, payload)); assert.equal(prepare.name, "prepare_production");
  const readFailed = textOf(call([...messages, fauxAssistantMessage([read]), toolResult(read, "修订不存在", true)], payload));
  assert.match(readFailed, /读取产物工具返回错误/); assert.equal(readFailed.includes("提案已准备"), false);
  const prepareFailed = textOf(call([...prior, fauxAssistantMessage([prepare]), toolResult(prepare, "媒体通道未装配", true)], payload));
  assert.match(prepareFailed, /准备提案工具返回错误/); assert.equal(prepareFailed.includes("提案已准备，先停在这里"), false);
  assert.match(textOf(call([...prior, fauxAssistantMessage([prepare]), toolResult(prepare, "提案已准备", false)], payload)), /提案已准备，先停在这里/);
});

test("C6 历史同名结果不冒充当前成功；未知工具失败仍带离线标识", () => {
  const tool = toolCallOf(call([user(SCENARIO_DELIVER_BATCH)], state));
  const orphan = toolResult({ ...tool, id: "earlier" }, "已登记", false);
  const replay = call([user(SCENARIO_DELIVER_BATCH), orphan], state);
  assert.equal(toolCallOf(replay).name, "deliver_artifacts"); assert.equal(textOf(replay).includes("内容已放到右边"), false);
  const unknown = scenarioReply({ frame: null, userText: "随便", pending: { call: { ...tool, name: "read_skill_file" }, result: { ...toolResult(tool, "读取失败", true), toolName: "read_skill_file" } as never } });
  assert.match(textOf(unknown), /离线回放失败/); assert.match(textOf(unknown), /【离线测试回放】/);
});
