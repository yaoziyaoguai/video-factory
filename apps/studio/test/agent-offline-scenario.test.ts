import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type AssistantMessage, type Message, type ToolCall } from "@earendil-works/pi-ai";
import {
  offlineScenarioFactory, scenarioReply, SCENARIO_DELIVER_BATCH, SCENARIO_PROPOSAL, SCENARIO_REVISE, SCENARIO_WORK_DEMO,
  type DemoMediaAccess,
} from "../src/server/agent/offline-scenario.js";
import type { DemoMediaSeeds } from "../src/server/agent/offline-demo-media.js";

type ScenarioContext = Parameters<ReturnType<typeof offlineScenarioFactory>>[0];
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const state = { target: null, artifacts: [], deliveryClosed: false };
const target = { artifactId: "art-1", revisionId: "rev-1" };
const frame = (payload: unknown): Message => ({ role: "system", content: `[frame-current-state]${JSON.stringify(payload)}\n这是本请求的当前业务状态。`, timestamp: 1 });
function call(messages: Message[], payload?: unknown, demoMedia?: DemoMediaAccess): AssistantMessage {
  return offlineScenarioFactory({ selfAppend: () => {}, ...(demoMedia ? { demoMedia } : {}) })({ messages: payload === undefined ? messages : [...messages, frame(payload)] } as unknown as ScenarioContext,
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

// UIUX-10 演示口令：样片种子替身与状态机；真实落库由 offline-demo-media 的集成测试覆盖。
const DEMO_SEEDS: DemoMediaSeeds = {
  trail: { runId: "run-demo", operationId: "trail", outputSlot: "trail" },
  trailSilent: { runId: "run-demo", operationId: "trail_silent", outputSlot: "trail_silent" },
  coffee: { runId: "run-demo", operationId: "coffee", outputSlot: "coffee" },
  coffeeSilent: { runId: "run-demo", operationId: "coffee_silent", outputSlot: "coffee_silent" },
};
const demoAccess = (options: { plant: boolean } = { plant: true }): DemoMediaAccess & { planted: number } => {
  const state = { planted: 0 };
  return {
    get planted() { return state.planted; },
    seedsOf: conversationId => (conversationId === "conv-demo" && state.planted > 0 ? DEMO_SEEDS : null),
    plant: () => { if (!options.plant) return null; state.planted += 1; return DEMO_SEEDS; },
  };
};

test("UIUX-10 演示口令状态机：三件 start_work，第三件齐后才播种并一次性交付", () => {
  const demo = demoAccess();
  const demoState = { conversationId: "conv-demo", target: null, artifacts: [], deliveryClosed: false };
  const works = [{ id: "w-1", title: "山径晨光", reviewGroups: [] }, { id: "w-2", title: "城市夜色", reviewGroups: [] }, { id: "w-3", title: "咖啡手记", reviewGroups: [] }];
  const first = toolCallOf(call([user(SCENARIO_WORK_DEMO)], { ...demoState, works: [] }, demo));
  assert.equal(first.name, "start_work");
  assert.deepEqual(first.arguments, { title: "山径晨光" });
  assert.equal(demo.planted, 0, "演示旅程中段不播种，种子不得提前落库");

  let chain = [user(SCENARIO_WORK_DEMO), fauxAssistantMessage([first])];
  let latest = first;
  for (const index of [0, 1]) {
    const result = toolResult({ ...latest, id: `sw-${index}` }, JSON.stringify({ id: works[index]!.id, title: works[index]!.title }), false);
    const next = toolCallOf(call([...chain, result], { ...demoState, works: works.slice(0, index + 1) }, demo));
    assert.equal(next.name, "start_work");
    chain = [...chain, result, fauxAssistantMessage([next])];
    latest = next;
  }
  // 第三件成功后进入一次性交付：先播种（底层运行输出，不插顶层产物），5 个交付项 + 3 个审阅组。
  const deliver = toolCallOf(call([...chain, toolResult(latest, JSON.stringify({ id: "w-3", title: "咖啡手记" }), false)], { ...demoState, works }, demo));
  assert.equal(deliver.name, "deliver_artifacts");
  assert.equal(demo.planted, 1, "交付前才种样片运行");
  // 工具入参在类型上是 JsonObject；测试按已知形状一次收窄后断言。
  const deliverArgs = deliver.arguments as unknown as {
    items: unknown[];
    reviewGroups: { workId: string; items: { item: { role: string } }[] }[];
  };
  assert.equal(deliverArgs.items.length, 5);
  assert.equal(deliverArgs.reviewGroups.length, 3);
  assert.deepEqual(deliverArgs.items[3], { mode: "create", title: "山径晨光 · 成片 v1", kind: "video",
    content: { format: "local_output", source: { kind: "run_output", runId: "run-demo", operationId: "trail", outputSlot: "trail" } } });
  assert.deepEqual(deliverArgs.reviewGroups.map(group => group.workId), ["w-1", "w-2", "w-3"]);
  assert.deepEqual(deliverArgs.reviewGroups.map(group => group.items.map(item => item.item.role)),
    [["content", "video"], ["content"], ["content", "video"]]);
  // 交付成功后的收尾说明指向总览与修订链。
  const done = textOf(call([...chain, fauxAssistantMessage([deliver]), toolResult(deliver, "已登记", false)], { ...demoState, works, deliveryClosed: true }, demo));
  assert.match(done, /三件演示作品已建立/); assert.match(done, /总览/);
  // 重复口令（作品已齐且无挂起调用）不再重建。
  assert.match(textOf(call([user(SCENARIO_WORK_DEMO)], { ...demoState, works }, demo)), /已建立过，不再重复创建/);
});

test("UIUX-10 演示口令降级：未装配媒体替身、播种失败、缺帧都如实说明", () => {
  const demoState = { conversationId: "conv-demo", target: null, artifacts: [], works: [], deliveryClosed: false };
  assert.match(textOf(call([user(SCENARIO_WORK_DEMO)], demoState)), /没有启用媒体替身/);
  assert.match(textOf(call([user(SCENARIO_WORK_DEMO)])), /需要宿主业务帧/);
  // 装了替身但播种失败（plant 返回 null）：作品照常建立，交付前如实失败，不交付成片。
  const works = [{ id: "w-1", title: "山径晨光", reviewGroups: [] }, { id: "w-2", title: "城市夜色", reviewGroups: [] }, { id: "w-3", title: "咖啡手记", reviewGroups: [] }];
  const demo = demoAccess({ plant: false });
  let chain = [user(SCENARIO_WORK_DEMO)];
  let latest = toolCallOf(call(chain, { ...demoState, works: [] }, demo));
  assert.equal(latest.name, "start_work");
  for (const index of [0, 1]) {
    const result = toolResult({ ...latest, id: `sw-d-${index}` }, JSON.stringify({ id: works[index]!.id, title: works[index]!.title }), false);
    chain = [...chain, fauxAssistantMessage([latest]), result];
    latest = toolCallOf(call(chain, { ...demoState, works: works.slice(0, index + 1) }, demo));
  }
  // 第三轮结果保留原始调用 id：pendingToolRound 靠 toolCallId 回配，改写会被当成无挂起调用。
  const third = toolResult(latest, JSON.stringify({ id: works[2]!.id, title: works[2]!.title }), false);
  const refused = call([...chain, fauxAssistantMessage([latest]), third], { ...demoState, works }, demo);
  assert.match(textOf(refused), /演示样片未能登记，未交付成片/);
  const blocks = typeof refused.content === "string" ? [] : refused.content;
  assert.equal(blocks.some(block => block.type === "toolCall"), false, "播种失败时不得发起交付调用");
});

test("UIUX-10 视频修订演示：绑定演示成片换静音孪生；无对应样片如实拒绝", () => {
  const cutState = {
    conversationId: "conv-demo", deliveryClosed: false,
    target: { artifactId: "art-cut", revisionId: "rev-cut-1" },
    artifacts: [{ artifactId: "art-cut", title: "山径晨光 · 成片 v1", kind: "video", headRevisionId: "rev-cut-1" }],
  };
  const demo = demoAccess();
  demo.plant("conv-demo");
  const revise = toolCallOf(call([user(SCENARIO_REVISE)], cutState, demo));
  assert.equal(revise.name, "deliver_artifacts");
  // 标题先去掉尾缀版本号再接「· 静音版」，避免「v1 · 静音版」式叠拼。
  assert.deepEqual((revise.arguments as unknown as { items: unknown[] }).items[0], { mode: "revise", artifactId: "art-cut", baseRevisionId: "rev-cut-1",
    title: "山径晨光 · 成片 · 静音版", kind: "video",
    content: { format: "local_output", source: { kind: "run_output", runId: "run-demo", operationId: "trail_silent", outputSlot: "trail_silent" } } });
  // 任意尾缀版本号都先归一再接「· 静音版」。
  const v3State = {
    ...cutState,
    target: { artifactId: "art-cut", revisionId: "rev-cut-3" },
    artifacts: [{ artifactId: "art-cut", title: "咖啡手记 · 成片 v3", kind: "video", headRevisionId: "rev-cut-3" }],
  };
  const v3 = toolCallOf(call([user(SCENARIO_REVISE)], v3State, demo));
  assert.deepEqual((v3.arguments as unknown as { items: unknown[] }).items[0], { mode: "revise", artifactId: "art-cut", baseRevisionId: "rev-cut-3",
    title: "咖啡手记 · 成片 · 静音版", kind: "video",
    content: { format: "local_output", source: { kind: "run_output", runId: "run-demo", operationId: "coffee_silent", outputSlot: "coffee_silent" } } });
  // 未种样片（未跑演示口令）时如实拒绝，只回文本、不发起修订交付。
  const refused = call([user(SCENARIO_REVISE)], cutState);
  assert.match(textOf(refused), /没有对应样片/);
  const refusedBlocks = typeof refused.content === "string" ? [] : refused.content;
  assert.equal(refusedBlocks.some(block => block.type === "toolCall"), false);
});
