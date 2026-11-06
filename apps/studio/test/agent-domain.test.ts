import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import type { DeliveryItem } from "../src/shared/agent/generated/contracts.js";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import { systemClock } from "../src/server/agent/util.js";

// A 增量领域规则（HTTP + SQLite + Pi Faux 纵向路径）：
// 交付/修订/CAS/关闭、反馈不自动修改、幂等与队列、串行与隔离、steer/stop、
// 提案边界、游标与身份、迁移幂等。浏览器相关项在工作台测试覆盖。

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const LONG_TEXT = "这是一段较长的回答，用来拉长 Faux 的流式输出时间，给 steer 与 stop 留出可观察的窗口。".repeat(6);

describe("agent domain rules", () => {
  let assembly: OfflineAgentAssembly;
  let otherAssembly: OfflineAgentAssembly;
  let baseUrl: string;
  let directory: string;
  const headers: Record<string, string> = {};

  const json = async (method: string, url: string, body?: unknown, extra?: Record<string, string>): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const messageInput = (commandId: string, text: string, extra: Record<string, unknown> = {}) => ({
    commandId, text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, ...extra,
  });

  const createConversation = async (commandId: string, title: string): Promise<string> => {
    const created = await json("POST", "/api/agent/v1/conversations", { commandId, title });
    assert.equal(created.status, 201);
    return created.body.id as string;
  };

  const send = async (conversationId: string, commandId: string, text: string, extra: Record<string, unknown> = {}) =>
    json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput(commandId, text, extra));

  const snapshotOf = async (conversationId: string) =>
    (await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`)).body;

  const waitFor = async (check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(false, "condition not met before timeout");
  };

  const assistantTexts = async (conversationId: string): Promise<string[]> =>
    (await snapshotOf(conversationId)).messages.items
      .filter((item: any) => item.role === "assistant")
      .map((item: any) => item.text);

  const deliverStep = (items: DeliveryItem[], id?: string) => fauxAssistantMessage([
    fauxToolCall("deliver_artifacts", { items } as unknown as ToolCall["arguments"], id ? { id } : undefined),
  ]);

  const promptItem = (title: string, text: string): DeliveryItem => ({
    mode: "create", title, kind: "prompt", content: { format: "markdown", text },
  });

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vf-agent-domain-"));
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    headers["content-type"] = "application/json";
    headers.origin = baseUrl;
    headers["x-video-factory-request"] = "studio";
    // 低速 Faux：为 steer/stop 打开可观察的流式窗口。
    assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: baseUrl, fauxTokensPerSecond: 50 });
    await assembly.app.listen({ port, host: "127.0.0.1" });
  });

  after(async () => {
    await assembly.close();
    await otherAssembly?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("一批交付三个独立产物：一份 delivery，各有修订（A-02）", async () => {
    const conversationId = await createConversation("cmd-d0", "批量交付");
    assembly.faux?.setResponses([
      deliverStep([
        promptItem("方向一", "# 方向一\n清晨的巷口"),
        promptItem("方向二", "# 方向二\n正午的市场"),
        promptItem("方向三", "# 方向三\n傍晚的海堤"),
      ]),
      fauxAssistantMessage("三个方向都在这里了。"),
    ]);

    const sent = await send(conversationId, "cmd-d1", "给我三个不同方向的脚本，先不要制作");
    assert.equal(sent.status, 202);
    // 产物在回合中段落库；引用与 assistant 消息要等回合收尾，等最终文本最稳。
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("三个方向都在这里了")));

    const snapshot = await snapshotOf(conversationId);
    assert.equal(snapshot.artifacts.items.length, 3);
    for (const artifact of snapshot.artifacts.items) assert.equal(artifact.revisionNumber, 1);
    const assistant = snapshot.messages.items.find((item: any) => item.role === "assistant");
    assert.equal(assistant.references.artifacts.length, 3);
    const deliveries = assembly.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries WHERE request_id = ?").get(sent.body.requestId) as { n: number };
    assert.equal(deliveries.n, 1, "只有一份 delivery");
  });

  it("绑定目标只修订指定对象；排队中的同基准请求 CAS 失败且不产生半批（A-03/A-21）", async () => {
    const conversationId = await createConversation("cmd-r0", "修订规则");
    assembly.faux?.setResponses([
      deliverStep([promptItem("开场", "# 开场\n原来的语气")]),
      fauxAssistantMessage("初稿交付。"),
    ]);
    const first = await send(conversationId, "cmd-r1", "先写一版开场");
    assert.equal(first.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("初稿交付")));
    const artifact = (await snapshotOf(conversationId)).artifacts.items[0];

    // req2 修订 r1 成 r2 后，在第二次模型调用上闸住（交付已提交、回合未收尾）；
    // req3 此时入队且绑定同一 r1：req2 收尾后它的基准必然过期。
    let releaseHold = (): void => {};
    const gate = new Promise<void>(resolve => { releaseHold = resolve; });
    const target = { artifactId: artifact.id, revisionId: artifact.revisionId, workId: null };
    assembly.faux?.setResponses([
      deliverStep([{ mode: "revise", artifactId: artifact.id, baseRevisionId: target.revisionId, kind: "prompt", title: "开场", content: { format: "markdown", text: "# 开场\n安静的语气" } }]),
      async () => {
        await gate;
        return fauxAssistantMessage("修订完成。");
      },
      deliverStep([{ mode: "revise", artifactId: artifact.id, baseRevisionId: target.revisionId, kind: "prompt", title: "开场", content: { format: "markdown", text: "# 开场\n迟到者的版本" } }]),
      fauxAssistantMessage("基准已过期，需要基于最新版本重新发起。"),
    ]);
    const second = await send(conversationId, "cmd-r2", "保留意思，语气安静一点", { target });
    assert.equal(second.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === second.body.requestId);
    const stale = await send(conversationId, "cmd-r3", "也按那份旧版本改一版", { target });
    assert.equal(stale.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).artifacts.items[0].revisionNumber === 2);
    releaseHold();
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("基准已过期")));

    const snap = await snapshotOf(conversationId);
    assert.equal(snap.artifacts.items[0].revisionNumber, 2, "没有第三个修订");
    const revisions = assembly.database.prepare("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?").get(artifact.id) as { n: number };
    assert.equal(revisions.n, 2);
    const secondDeliveries = assembly.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries WHERE request_id = ?").get(second.body.requestId) as { n: number };
    assert.equal(secondDeliveries.n, 1);
    const staleDeliveries = assembly.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries WHERE request_id = ?").get(stale.body.requestId) as { n: number };
    assert.equal(staleDeliveries.n, 0, "失败批次没有 delivery");
    const staleRequest = assembly.database.prepare("SELECT delivery_closed FROM requests WHERE id = ?").get(stale.body.requestId) as { delivery_closed: number };
    assert.equal(staleRequest.delivery_closed, 0, "失败批次不消耗交付槽");
  });

  // 原 A-20 断言“target=null 必拒绝修订”，已由 S2-02/T02 决定替换：
  // 没有预绑定 target 时按用户文字指名与真实 head 解析对象即可改稿；显式绑定仍精确限制范围。
  it("没有预绑定时按真实对象改稿；绑定目标的批次仍可包含新建产物（S2-02/T02）", async () => {
    const conversationId = await createConversation("cmd-s0", "越界规则");
    assembly.faux?.setResponses([
      deliverStep([promptItem("对象A", "# 对象A")]),
      fauxAssistantMessage("对象A就绪。"),
    ]);
    await send(conversationId, "cmd-s1", "先建一个对象A");
    await waitFor(async () => (await snapshotOf(conversationId)).artifacts.items.length === 1);
    const artifact = (await snapshotOf(conversationId)).artifacts.items[0];
    const revision = await json("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`);
    assert.equal(revision.status, 200);

    // target=null 但用户明确指名对象：按真实对象与当前 head 生成新修订，不新建同题 v1。
    assembly.faux?.setResponses([
      deliverStep([{ mode: "revise", artifactId: artifact.id, baseRevisionId: artifact.revisionId, kind: "prompt", title: "对象A", content: { format: "markdown", text: "# 对象A 改" } }]),
      fauxAssistantMessage("已改对象A。"),
    ]);
    const noTarget = await send(conversationId, "cmd-s2", "顺手把对象A也改了");
    assert.equal(noTarget.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("已改对象A")));
    const revised = (await snapshotOf(conversationId)).artifacts.items;
    assert.equal(revised.length, 1, "没有因为没有 target 就偷建第二份同题产物");
    assert.equal(revised[0].revisionNumber, 2, "改稿落在原对象的新修订");

    // 契约允许同一请求既修改已绑定目标，又新建独立产物；target 限制修订范围。
    const head = (await snapshotOf(conversationId)).artifacts.items[0];
    assembly.faux?.setResponses([
      deliverStep([{ mode: "revise", artifactId: artifact.id, baseRevisionId: head.revisionId, kind: "prompt", title: "对象A", content: { format: "markdown", text: "# 对象A 新版" } }, promptItem("对象B", "# 对象B")]),
      fauxAssistantMessage("已修改 A 并新建 B。"),
    ]);
    const bound = await send(conversationId, "cmd-s3", "改对象A，再新建对象B", { target: { artifactId: artifact.id, revisionId: head.revisionId, workId: null } });
    assert.equal(bound.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("已修改 A 并新建 B")));
    assert.equal((await snapshotOf(conversationId)).artifacts.items.length, 2);
    assert.equal((await snapshotOf(conversationId)).artifacts.items.find((x: any) => x.id === artifact.id).revisionNumber, 3);
  });

  it("同批同内容重放取原回执；交付后不同内容与提案都被关闭（A-17/A-18）", async () => {
    const conversationId = await createConversation("cmd-c0", "关闭规则");
    const items = [promptItem("唯一交付", "# 唯一交付")];
    assembly.faux?.setResponses([
      deliverStep(items, "call-a"),
      deliverStep(items, "call-b"),
      deliverStep([promptItem("第二批", "# 第二批")], "call-c"),
      fauxAssistantMessage("重放与关闭都验证过了。"),
    ]);
    const sent = await send(conversationId, "cmd-c1", "交付一份，然后模型重试与越界都会被挡住");
    assert.equal(sent.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("重放与关闭")));

    const invocations = assembly.database.prepare(
      "SELECT tool_call_id, state FROM tool_invocations WHERE request_id = ? ORDER BY created_at",
    ).all(sent.body.requestId) as { tool_call_id: string; state: string }[];
    const byId = new Map(invocations.map(row => [row.tool_call_id, row.state]));
    assert.equal(byId.get("call-a"), "committed");
    assert.equal(byId.get("call-b"), "committed", "新 toolCallId 同内容取原回执也算提交");
    assert.equal(byId.get("call-c"), "registered", "不同内容被拒绝且不落提交");
    const deliveries = assembly.database.prepare("SELECT COUNT(*) AS n FROM request_deliveries WHERE request_id = ?").get(sent.body.requestId) as { n: number };
    assert.equal(deliveries.n, 1, "仍只有一份 delivery");
    const artifacts = (await snapshotOf(conversationId)).artifacts.items;
    assert.equal(artifacts.length, 1, "没有第二批产物");
    const proposals = await json("GET", `/api/agent/v1/conversations/${conversationId}/proposals`);
    assert.equal(proposals.body.items.length, 0, "交付关闭后同请求不能准备提案");
  });

  it("反馈只记录不修改；重放不重复；显式修改请求才产生新修订（A-05/A-06）", async () => {
    const conversationId = await createConversation("cmd-f0", "反馈规则");
    assembly.faux?.setResponses([
      deliverStep([promptItem("草稿", "# 草稿\n第一版")]),
      fauxAssistantMessage("草稿在这里。"),
    ]);
    await send(conversationId, "cmd-f1", "给我一版草稿");
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("草稿在这里")));
    const artifact = (await snapshotOf(conversationId)).artifacts.items[0];

    const target = { artifactId: artifact.id, revisionId: artifact.revisionId, workId: null };
    const feedback = await json("POST", `/api/agent/v1/conversations/${conversationId}/feedback`, {
      commandId: "cmd-fb1", target, text: "结尾再收一下，别拖。",
    });
    assert.equal(feedback.status, 201);
    assert.equal(feedback.body.applied, false);
    assert.equal(feedback.body.disposition, "noted");

    const replay = await json("POST", `/api/agent/v1/conversations/${conversationId}/feedback`, {
      commandId: "cmd-fb1", target, text: "结尾再收一下，别拖。",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.messageId, feedback.body.messageId);

    const messages = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items;
    const notes = messages.filter((item: any) => item.kind === "feedback");
    assert.equal(notes.length, 1, "重放不产生第二条反馈");
    assert.equal(notes[0].feedback.applied, false);
    assert.equal((await snapshotOf(conversationId)).artifacts.items[0].revisionNumber, 1, "反馈不自动修改产物");

    // 用户明确要求按意见修改并绑定目标：必须真的产生修订。
    assembly.faux?.setResponses([
      deliverStep([{ mode: "revise", artifactId: artifact.id, baseRevisionId: artifact.revisionId, kind: "prompt", title: "草稿", content: { format: "markdown", text: "# 草稿\n第一版\n（结尾已收束）" } }]),
      fauxAssistantMessage("按你的意见改好了。"),
    ]);
    const revise = await send(conversationId, "cmd-f2", "按刚才的意见修改", { target });
    assert.equal(revise.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).artifacts.items[0].revisionNumber === 2);
  });

  it("同 commandId 异内容 409；待处理超限 429 后恢复（A-10/A-11）", async () => {
    const conversationId = await createConversation("cmd-q0", "幂等与队列");
    let firstModelCalls = 0;
    assembly.faux?.setResponses([() => { firstModelCalls++; return fauxAssistantMessage("第一句。"); }]);
    const [first, duplicate] = await Promise.all([
      send(conversationId, "cmd-q1", "第一句"), send(conversationId, "cmd-q1", "第一句"),
    ]);
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 202);
    assert.equal(first.body.requestId, duplicate.body.requestId);
    assert.equal(Number(first.body.replayed) + Number(duplicate.body.replayed), 1);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("第一句")));
    assert.equal(firstModelCalls, 1);

    const conflict = await send(conversationId, "cmd-q1", "同命令不同内容");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");

    // 队列上限：先占住前台，再堆满 20 条排队，下一条必须 429。
    let releaseHold = (): void => {};
    const gate = new Promise<void>(resolve => { releaseHold = resolve; });
    assembly.faux?.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("闸门回合完成。");
      },
      ...Array.from({ length: 20 }, () => fauxAssistantMessage("排队消化。")),
    ]);
    const held = await send(conversationId, "cmd-q2", "占住前台");
    assert.equal(held.status, 202);
    let rejected: { status: number; body: any } | null = null;
    let accepted = 0;
    for (let index = 0; index < 24; index += 1) {
      const attempt = await send(conversationId, `cmd-q3-${index}`, `排队${index}`);
      if (attempt.status === 429) { rejected = attempt; break; }
      assert.equal(attempt.status, 202);
      accepted += 1;
    }
    // 计数只算 queued：1 条 running + 20 条 queued 之内不应拒绝，第 21 条排队时 429。
    assert.ok(rejected, "队列满必须得到 429");
    assert.equal(rejected.status, 429);
    assert.equal(rejected.body.code, "QUEUE_FULL");
    assert.equal(accepted, 20);

    const acceptedReplay = await send(conversationId, "cmd-q1", "第一句");
    assert.equal(acceptedReplay.status, 202, "队列满仍可重放已接收命令");
    assert.equal(acceptedReplay.body.requestId, first.body.requestId);
    assert.equal(acceptedReplay.body.replayed, true);

    releaseHold();
    await waitFor(async () => {
      const row = assembly.database.prepare(
        "SELECT COUNT(*) AS n FROM requests WHERE conversation_id = ? AND state IN ('queued','running')",
      ).get(conversationId) as { n: number };
      return row.n === 0;
    }, 60_000);
  });

  it("同会话串行、跨会话不串历史（A-12）", async () => {
    const leftId = await createConversation("cmd-x0", "会话左");
    const rightId = await createConversation("cmd-x1", "会话右");

    let releaseLeft = (): void => {};
    const gate = new Promise<void>(resolve => { releaseLeft = resolve; });
    assembly.faux?.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("左侧回合完成。");
      },
      fauxAssistantMessage("右侧独立回答。"),
    ]);
    const left = await send(leftId, "cmd-x2", "左侧话题");
    assert.equal(left.status, 202);
    const right = await send(rightId, "cmd-x3", "右侧话题");
    assert.equal(right.status, 202);
    await waitFor(async () => (await assistantTexts(rightId)).some(text => text.includes("右侧独立回答")));

    const leftTexts = await assistantTexts(leftId);
    assert.ok(leftTexts.every(text => !text.includes("右侧")), "右侧回答没有进入左侧历史");
    const rightMessages = (await json("GET", `/api/agent/v1/conversations/${rightId}/messages`)).body.items;
    assert.ok(rightMessages.every((item: any) => !JSON.stringify(item).includes("左侧")), "左侧内容没有进入右侧历史");
    releaseLeft();
    await waitFor(async () => (await assistantTexts(leftId)).some(text => text.includes("左侧回合完成")));
  });

  it("steer 只作用于运行中的回合（A-13/A-14）", async () => {
    const conversationId = await createConversation("cmd-t0", "steer");
    let releaseFirst!: () => void;
    let modelStarted = false;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    // 用可控制的模型窗口承接干预，避免靠轮询碰中一段短暂的流式文本。
    assembly.faux?.setResponses([
      async () => { modelStarted = true; await gate; return fauxAssistantMessage("第一段回答。"); },
      context => {
        assert.ok(JSON.stringify(context.messages).includes("补充：语气再轻松一点"), "干预真实进入 SDK 的当前回合上下文");
        return fauxAssistantMessage("收到补充，按轻松语气继续。");
      },
    ]);
    const sent = await send(conversationId, "cmd-t1", "开始一个长回答");
    assert.equal(sent.status, 202);
    await waitFor(async () => modelStarted);
    assert.equal((await snapshotOf(conversationId)).activeRequestId, sent.body.requestId);

    try {
      const steer = await send(conversationId, "cmd-t2", "补充：语气再轻松一点", {
        mode: "steer", steerRequestId: sent.body.requestId,
      });
      assert.equal(steer.status, 202);
    } finally { releaseFirst(); }
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === null);

    const messages = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items;
    assert.ok(messages.some((item: any) => item.text === "补充：语气再轻松一点" && item.requestId === sent.body.requestId && item.state === "completed"),
      "steer 文本已落库且绑定同一请求");
    assert.ok(messages.some((item: any) => item.role === "assistant" && item.text.includes("收到补充")));

    // 已完成的请求再 steer：拒绝，不偷偷排队。
    const late = await send(conversationId, "cmd-t3", "迟到的干预", {
      mode: "steer", steerRequestId: sent.body.requestId,
    });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "REQUEST_NOT_RUNNING");

    // 回合结束瞬间的 steer 竞态由同步检查兜底：下一话题不会被注入旧干预。
    assembly.faux?.setResponses([fauxAssistantMessage("新话题回答。")]);
    const next = await send(conversationId, "cmd-t4", "换个新话题");
    assert.equal(next.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("新话题回答")));
    const after = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items;
    assert.ok(!after.some((item: any) => item.text === "迟到的干预"), "被拒 steer 不落库也不进入后续回合");
  });

  it("stop：排队立即停止、流式中止有系统通知；迟到写入被拒（A-15）", async () => {
    const conversationId = await createConversation("cmd-p0", "stop");
    // 第一回合闸在第一次模型调用上：请求 running 但回合不推进，用来验证排队请求的立即停止。
    let releaseHold = (): void => {};
    const gate = new Promise<void>(resolve => { releaseHold = resolve; });
    assembly.faux?.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("占位回合。");
      },
    ]);
    const held = await send(conversationId, "cmd-p1", "占住前台");
    assert.equal(held.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === held.body.requestId);

    // 排队请求：立即停止。
    const queued = await send(conversationId, "cmd-p2", "排队的这条不要了");
    assert.equal(queued.status, 202);
    const stopQueued = await json("POST", `/api/agent/v1/requests/${queued.body.requestId}/stop`, { commandId: "cmd-p3" });
    assert.equal(stopQueued.status, 200);
    assert.equal(stopQueued.body.state, "stopped");

    // 闸门回合正常收尾后，用流式中的长回合验证中止。
    releaseHold();
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === null);
    assembly.faux?.setResponses([fauxAssistantMessage(LONG_TEXT)]);
    const streaming = await send(conversationId, "cmd-p4", "开始一个长回答然后我会停掉它");
    assert.equal(streaming.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === streaming.body.requestId);
    const stopRunning = await json("POST", `/api/agent/v1/requests/${streaming.body.requestId}/stop`, { commandId: "cmd-p5" });
    assert.equal(stopRunning.status, 200);
    await waitFor(async () => {
      const snap = await snapshotOf(conversationId);
      return snap.activeRequestId === null
        && snap.messages.items.some((item: any) => item.role === "system_notice" && item.text.includes("停止"));
    });

    // 迟到的工具写入：请求已结束后同调用不再生效。
    const tools = new BusinessTools(assembly.database, systemClock, () => OFFLINE_QUOTE_CATALOG);
    await assert.rejects(
      () => tools.deliverArtifacts({
        actorId: "local-owner", conversationId, requestId: streaming.body.requestId,
        executionEpoch: 1, target: null, toolCallId: "late-write",
      } as never, { items: [promptItem("迟到写入", "# 迟到")] as [DeliveryItem] }),
      (error: any) => error.code === "REQUEST_NOT_RUNNING",
    );
    assert.equal((await snapshotOf(conversationId)).artifacts.items.length, 0, "迟到写入没有产生产物");
  });

  it("连接失败提示准确：无假回复、事实保留、可继续（A-16 部分）", async () => {
    const conversationId = await createConversation("cmd-e0", "提供方失败");
    assembly.faux?.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." })]);
    const sent = await send(conversationId, "cmd-e1", "这条会失败");
    assert.equal(sent.status, 202);
    await waitFor(async () => (await snapshotOf(conversationId)).activeRequestId === null, 60_000);
    const messages = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items;
    assert.ok(!messages.some((item: any) => item.role === "assistant"), "失败回合不落假助手回复");
    const request = assembly.database.prepare("SELECT state FROM requests WHERE id = ?").get(sent.body.requestId) as { state: string };
    assert.equal(request.state, "failed");
    assert.equal(messages.find((item: any) => item.role === "system_notice")?.text,
      "暂时无法连接文本模型，消息已保留；请稍后重试。");

    assembly.faux?.setResponses([fauxAssistantMessage("恢复后的回答。")]);
    const next = await send(conversationId, "cmd-e2", "继续聊");
    assert.equal(next.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("恢复后的回答")));
  });

  it("提案准备、重放、确认与受理边界（A-09）", async () => {
    const conversationId = await createConversation("cmd-pr0", "提案");
    assembly.faux?.setResponses([
      deliverStep([promptItem("提案输入", "# 提案输入")]),
      fauxAssistantMessage("输入就绪。"),
    ]);
    await send(conversationId, "cmd-pr1", "先交付一份输入");
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("输入就绪")));
    const artifact = (await snapshotOf(conversationId)).artifacts.items[0];
    const revision = (await json("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`)).body;

    const intent = {
      workId: null,
      title: "开场配音",
      inputRevisions: [{ artifactId: artifact.id, revisionId: artifact.revisionId }],
      operations: [{
        operationId: "opVoice", outputSlot: "voiceTrack",
        inputs: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
        maxCreateAttempts: 1, kind: "speech",
        model: { providerId: "fixture-text", modelId: "faux-speech", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
        parameters: { voiceId: "narrator-main", format: "mp3" },
      }],
      finalOutput: { operationId: "opVoice", outputSlot: "voiceTrack" },
      maxSpend: { currency: "CNY", amountMinor: 500 },
    };
    const prepared = await json("POST", `/api/agent/v1/conversations/${conversationId}/proposals`, { commandId: "cmd-pr2", spec: intent });
    assert.equal(prepared.status, 201);
    assert.equal(prepared.body.state, "ready");
    assert.ok(prepared.body.priceDisclosure.includes("报价"));
    assert.ok(prepared.body.priceDisclosure.includes("模拟媒体"));

    const replayed = await json("POST", `/api/agent/v1/conversations/${conversationId}/proposals`, { commandId: "cmd-pr2", spec: intent });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.id, prepared.body.id);

    const reread = await json("GET", `/api/agent/v1/proposals/${prepared.body.id}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.id, prepared.body.id);

    // 精确确认短语 + 有效 proposalRef：A 明确不可受理，且不排队任何回合。
    const beforeMessages = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items.length;
    const confirm = await send(conversationId, "cmd-pr3", "确认制作", {
      proposalRef: { proposalId: prepared.body.id, digest: prepared.body.digest },
    });
    assert.equal(confirm.status, 503);
    assert.equal(confirm.body.code, "CAPABILITY_UNAVAILABLE");
    const afterMessages = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items.length;
    assert.equal(afterMessages, beforeMessages, "确认被拒时不落任何消息");

    // 非确认短语的引用：普通聊天，消息带提案引用。
    assembly.faux?.setResponses([fauxAssistantMessage("这份提案的报价是测试值，先聊聊。")]);
    const discuss = await send(conversationId, "cmd-pr4", "这个方案听起来如何", {
      proposalRef: { proposalId: prepared.body.id, digest: prepared.body.digest },
    });
    assert.equal(discuss.status, 202);
    await waitFor(async () => (await assistantTexts(conversationId)).some(text => text.includes("测试值")));
    const withRef = (await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`)).body.items
      .find((item: any) => item.role === "user" && item.text.includes("这个方案听起来如何"));
    assert.deepEqual(withRef.references.proposalIds, [prepared.body.id]);

    // 坏 digest 的 proposalRef：拒绝。
    const badDigest = await send(conversationId, "cmd-pr5", "确认制作", {
      proposalRef: { proposalId: prepared.body.id, digest: "0".repeat(64) },
    });
    assert.equal(badDigest.status, 400);

    const accept = await json("POST", `/api/agent/v1/proposals/${prepared.body.id}/acceptances`, {
      commandId: "cmd-pr6", proposalDigest: prepared.body.digest,
    });
    assert.equal(accept.status, 503);
    assert.equal(accept.body.code, "CAPABILITY_UNAVAILABLE");
    const runs = await json("GET", `/api/agent/v1/conversations/${conversationId}/runs`);
    assert.equal(runs.body.items.length, 0, "受理被拒不产生 run");
  });

  it("会话改名 CAS 与重放；游标与未知字段的边界（A-22/A-23/A-24 部分）", async () => {
    const conversationId = await createConversation("cmd-n0", "改名前");
    const renamed = await json("PATCH", `/api/agent/v1/conversations/${conversationId}`, { commandId: "cmd-n1", title: "改名后", expectedRevision: 1 });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.revision, 2);
    const renameReplay = await json("PATCH", `/api/agent/v1/conversations/${conversationId}`, { commandId: "cmd-n1", title: "改名后", expectedRevision: 1 });
    assert.equal(renameReplay.status, 200);
    const stale = await json("PATCH", `/api/agent/v1/conversations/${conversationId}`, { commandId: "cmd-n2", title: "再次改名", expectedRevision: 1 });
    assert.equal(stale.status, 409);

    // 事件游标：跨会话 403，畸形 400。
    const otherId = await createConversation("cmd-n3", "另一个会话");
    const otherSnapshot = await snapshotOf(otherId);
    const swapped = await json("GET", `/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(otherSnapshot.eventCursor)}`);
    assert.equal(swapped.status, 403);
    assert.equal(swapped.body.code, "FORBIDDEN");
    const malformed = await json("GET", `/api/agent/v1/conversations/${conversationId}/events?cursor=%21%21not-base64`);
    assert.equal(malformed.status, 400);

    // 未知字段：契约校验拒绝。
    const unknownField = await send(conversationId, "cmd-n4", "带未知字段", { extraField: 1 });
    assert.equal(unknownField.status, 400);
  });

  it("跨 owner 一律 404，不泄漏存在性（A-22）", async () => {
    const conversationId = await createConversation("cmd-o0", "别人的会话");
    assembly.faux?.setResponses([
      deliverStep([promptItem("别人的产物", "# 别人的产物")]),
      fauxAssistantMessage("交付完成。"),
    ]);
    await send(conversationId, "cmd-o1", "交付一份");
    await waitFor(async () => (await snapshotOf(conversationId)).artifacts.items.length === 1);
    const artifact = (await snapshotOf(conversationId)).artifacts.items[0];

    const port = await reservePort();
    const otherBase = `http://127.0.0.1:${port}`;
    otherAssembly = await assembleOfflineAgent({
      dataDir: directory, uiOrigin: otherBase, ownerId: "someone-else",
    });
    await otherAssembly.app.listen({ port, host: "127.0.0.1" });
    const otherHeaders = { "content-type": "application/json", origin: otherBase, "x-video-factory-request": "studio" };
    const otherJson = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${otherBase}${url}`, {
        method, headers: otherHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    const snapshot = await otherJson("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    assert.equal(snapshot.status, 404);
    const message = await otherJson("POST", `/api/agent/v1/conversations/${conversationId}/messages`, messageInput("cmd-o2", "越权发送"));
    assert.equal(message.status, 404);
    const revision = await otherJson("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`);
    assert.equal(revision.status, 404);
    const listed = await otherJson("GET", "/api/agent/v1/conversations");
    assert.equal(listed.body.items.length, 0, "看不到别人的会话列表");
    await otherAssembly.close();
  });

  it("重复打开同一数据目录：迁移幂等、数据完好（A-25 部分）", async () => {
    const before = assembly.database.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
    const applied = assembly.database.prepare("SELECT version FROM agent_schema_migrations ORDER BY version").all();
    const reopened = openAgentDatabase(directory);
    const after = reopened.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
    assert.equal(after.n, before.n, "重复迁移不毁数据");
    assert.deepEqual(reopened.prepare("SELECT version FROM agent_schema_migrations ORDER BY version").all(), applied, "重开不重复执行迁移");
    reopened.close();
  });
});
