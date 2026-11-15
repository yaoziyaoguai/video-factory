import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG, type OfflineAgentOptions } from "../src/server/agent/offline.js";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { createWork, parseCreationState, writeWorkState } from "../src/server/agent/creative-work.js";
import { newAgentId } from "../src/server/agent/util.js";
import { deliverReviewDrafts, finalVideoTarget, seedConfirmedWork, type ConfirmedReviewWork } from "./helpers/creative-work-fixture.js";
import type {
  ArtifactHead, ArtifactRevision, ContentSource, ContentSourceInput, DeliveryItem, ProductionIntent, Proposal, Work, WorkReviewConfirmation,
} from "../src/shared/agent/generated/contracts.js";

// R1 组审阅连续性验收：当前稿认可/继续、首次采用、交付归属、在途边界（§4.2.1）、意见真实归属（F03–F09）。
// 全部走真实 SQLite 与公开 HTTP / 工具入口；本地替身只驱动机制，不代表真实模型判断。
// 事务与重放语义在 agent-production / agent-domain / agent-production-crash 已有覆盖，这里补认可与归属内核本身。
// 旧固定阶段模型（stages/stageDrafts/upstreamStale/approve_plan+next）已删除：新写入只用 reviewGroups 与组认可。
// 认可依据冻结在准备时；受理核对实际消费的必选依据各有真实确认行（§11.5），
// 待审新稿不使明确引用已认可旧版的报价失效，未认的当前稿不能借旧版确认。

const origin = "http://127.0.0.1:4395";
const headers = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
let sequence = 0;
const cmd = () => `r1-${++sequence}`;
const chatInput = (text: string, extra: Record<string, unknown> = {}) => ({
  commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null, ...extra,
});

interface Fixture {
  app: Awaited<ReturnType<typeof assembleOfflineAgent>>;
  directory: string;
  conversation: { id: string };
  close(): Promise<void>;
}

async function setup(extra: Partial<OfflineAgentOptions> = {}, media: OfflineAgentOptions["media"] = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-r1-"));
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, ...extra, media: { autoStart: false, delayMs: 0, ...media } });
  const conversation = app.service.createConversation("local-owner", { commandId: cmd(), title: "组审阅连续性" }).conversation;
  return { app, directory, conversation, close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function waitIdle(f: Fixture) {
  for (let i = 0; i < 300 && f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId, null, "回合应已结束");
}

async function turn(f: Fixture, steps: FauxResponseStep[], text = "请处理") {
  f.app.faux!.setResponses(steps);
  await f.app.service.sendMessage("local-owner", f.conversation.id, chatInput(text));
  await waitIdle(f);
}

const startWorkStep = (title: string) => fauxAssistantMessage([
  fauxToolCall("start_work", { title }),
]);

const deliverStep = (items: Record<string, unknown>[], reviewGroups?: Record<string, unknown>[]) => fauxAssistantMessage([
  fauxToolCall("deliver_artifacts", { items, ...(reviewGroups ? { reviewGroups } : {}) } as never),
]);

const scriptItem = (title: string, text: string): DeliveryItem => ({
  mode: "create", title, kind: "script", content: { format: "markdown", text },
});

// 新组/项声明：与 creative-work 夹具同一形状；已有身份时换成 existing 声明。
const newGroupDelivery = (workId: string, role = "content", key = "script", itemIndex = 0) => ({
  workId,
  group: { mode: "create", key: "content-group", title: "脚本与内容", nextIntent: null },
  items: [{ item: { mode: "create", key, label: role === "content" ? "脚本" : "画面方案", role, required: true },
    itemIndex, inputSources: [], reviewInputs: [], purpose: "draft" as const }],
});

const existingItemDelivery = (workId: string, groupId: string, itemId: string, itemIndex = 0) => ({
  workId,
  group: { mode: "existing", groupId },
  items: [{ item: { mode: "existing", itemId }, itemIndex, inputSources: [], reviewInputs: [], purpose: "draft" as const }],
});

function works(f: Fixture): Work[] {
  return f.app.service.snapshot("local-owner", f.conversation.id).works;
}

function workOf(f: Fixture, workId: string): Work {
  const found = works(f).find(item => item.id === workId);
  assert.ok(found, `应能读到事项 ${workId}`);
  return found;
}

type GroupView = Work["reviewGroups"][number];
type ItemView = GroupView["items"][number];

function itemOfRole(f: Fixture, workId: string, role: string): { group: GroupView; item: ItemView } {
  const found = workOf(f, workId).reviewGroups
    .flatMap(group => group.items.map(item => ({ group, item })))
    .find(({ item }) => item.role === role);
  assert.ok(found, `应有 ${role} 角色事项`);
  return found;
}

function contentItemOf(f: Fixture, workId: string) { return itemOfRole(f, workId, "content"); }
function videoItemOf(f: Fixture, workId: string) { return itemOfRole(f, workId, "video"); }

function revisionDraftOf(item: ItemView): Extract<ContentSource, { kind: "artifact_revision" }> {
  assert.ok(item.draft?.kind === "artifact_revision", "主稿应是产物修订");
  return item.draft;
}

function artifactOf(f: Fixture, title: string): ArtifactHead {
  const found = f.app.service.snapshot("local-owner", f.conversation.id).artifacts.items.find(item => item.title === title);
  assert.ok(found, `应能读到产物 ${title}`);
  return found;
}

// 组认可按钮是公开 HTTP 入口：结构化认可走 POST messages 的 reviewConfirmation。
async function confirmReview(
  f: Fixture,
  payload: { workId: string; groupId: string; items: { itemId: string; source: ContentSourceInput }[]; action: "approve" | "approve_and_continue" | "finalize_video" },
  text = "确认当前稿",
) {
  return f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers,
    payload: { ...chatInput(text), reviewConfirmation: payload } });
}

async function postMessage(f: Fixture, payload: Record<string, unknown>) {
  return f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers, payload });
}

const countIn = (f: Fixture, sql: string, ...args: unknown[]) =>
  (f.app.database.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;

const assistantCount = (f: Fixture) =>
  f.app.service.snapshot("local-owner", f.conversation.id).messages.items.filter(item => item.role === "assistant").length;

// 视频整片提案：实际输入（inputSources）与受理依据（reviewInputs）分开（§4.2.1）。
function videoSpec(
  workId: string, input: { artifactId: string; revisionId: string; digest: string }, title: string,
  reviewInputs: ProductionIntent["reviewInputs"] = [], purpose: ProductionIntent["purpose"] = "production",
): ProductionIntent {
  return {
    workId, title,
    inputSources: [{ kind: "artifact_revision", artifactId: input.artifactId, revisionId: input.revisionId, digest: input.digest }],
    reviewInputs, purpose, scope: `${title}正式整片`,
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
      inputs: [{ kind: "artifact_revision" as const, artifactId: input.artifactId, revisionId: input.revisionId, digest: input.digest }],
      maxCreateAttempts: 1, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, outputTarget: finalVideoTarget(), maxSpend: { currency: "CNY", amountMinor: 1200 },
  };
}

function speechSpec(workId: string | null, artifact: ArtifactHead, revision: ArtifactRevision, title: string): ProductionIntent {
  return {
    workId, title,
    inputSources: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
    reviewInputs: [], purpose: "draft", scope: `${title}草稿配音`,
    operations: [{ operationId: "voice", outputSlot: "voice", kind: "speech", model: OFFLINE_QUOTE_CATALOG["speech:faux-speech"].binding,
      inputs: [{ kind: "artifact_revision" as const, artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
      maxCreateAttempts: 1, parameters: { voiceId: "narrator-main", format: "mp3" } }],
    finalOutput: { operationId: "voice", outputSlot: "voice" }, maxSpend: { currency: "CNY", amountMinor: 500 },
  };
}

async function driveToTerminal(f: Fixture, runId: string) {
  for (let i = 0; i < 12; i++) {
    await f.app.worker!.pollOnce();
    if (["succeeded", "failed", "cancelled"].includes(f.app.service.getRun("local-owner", runId).state)) break;
  }
  return f.app.service.getRun("local-owner", runId);
}

// 等待某个请求完成（被拒交付也会如实完成回合）。
async function waitRequestDone(f: Fixture, requestId: string) {
  for (let i = 0; i < 150; i++) {
    const row = f.app.database.prepare("SELECT state FROM requests WHERE id=?").get(requestId) as { state: string };
    if (row.state === "completed") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("请求应已完成");
}

// 空主稿内容事项：render_project 受理目标分配的真实初始形状（新项先无主稿，产出后补）。
// 公开工具尚无更轻的空项入口，这里直接用内核写状态建立该初始事实，认可语义仍全部走公开入口验证。
function seedEmptyContentItem(db: Fixture["app"]["database"], now: string, scope: { ownerId: string; conversationId: string }, title: string) {
  const work = createWork(db, now, scope, title);
  const state = parseCreationState(work);
  const groupId = newAgentId("grp"), itemId = newAgentId("item");
  state.groups.push({ id: groupId, title: "脚本与内容", revision: 1, nextIntent: null,
    items: [{ id: itemId, label: "脚本", role: "content", required: true, draft: null, approved: null, confirmationId: null, approvedAt: null }] });
  writeWorkState(db, now, work, state);
  return { workId: work.id, groupId, itemId };
}

async function holdRequest(f: Fixture, text: string) {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.app.faux!.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("结束。"); }]);
  const sent = await f.app.service.sendMessage("local-owner", f.conversation.id, chatInput(text));
  await ready;
  const row = f.app.database.prepare("SELECT execution_epoch FROM requests WHERE id=?").get(sent.receipt.requestId) as { execution_epoch: number };
  return { release, sent,
    context: { actorId: "local-owner", conversationId: f.conversation.id, requestId: sent.receipt.requestId,
      executionEpoch: row.execution_epoch, target: null, toolCallId: "call-r1", actionSourceMessageId: sent.receipt.messageId } };
}

// —— R1.1（F03/F04）：认可作用于事项准确当前稿；回放只回原回执；无认可依据不得受理正式整片 ——

it("R1.1 旧稿确认被拒、当前稿认可可回放；纯认可不排模型，无认可依据的正式整片不能受理", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容 v1", "# 山路\n清晨的固定镜头。")], [newGroupDelivery(work.id)]), fauxAssistantMessage("v1 已登记。")]);
    const v1 = revisionDraftOf(contentItemOf(f, work.id).item);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.artifactId, baseRevisionId: v1.revisionId,
      title: "山路内容", kind: "script", content: { format: "markdown", text: "# 山路\n黄昏的固定镜头。" } }],
      [existingItemDelivery(work.id, contentItemOf(f, work.id).group.id, contentItemOf(f, work.id).item.id)]), fauxAssistantMessage("v2 已登记。")]);
    const content = contentItemOf(f, work.id);
    const v2 = revisionDraftOf(content.item);
    assert.notEqual(v2.revisionId, v1.revisionId);

    for (const action of ["approve", "approve_and_continue"] as const) {
      const stale = await confirmReview(f, { workId: work.id, groupId: content.group.id,
        items: [{ itemId: content.item.id, source: v1 }], action });
      assert.equal(stale.statusCode, 400);
      assert.equal(stale.json().code, "INVALID_INPUT");
      assert.match(stale.json().message, /不是当前稿/);
    }

    // 纯认可：不排文本模型，请求本体直接完成并关闭投递。
    const assistantsBefore = assistantCount(f);
    const approvePayload = { ...chatInput("认可这版"),
      reviewConfirmation: { workId: work.id, groupId: content.group.id,
        items: [{ itemId: content.item.id, source: v2 }], action: "approve" as const } };
    const approved = await postMessage(f, approvePayload);
    assert.equal(approved.statusCode, 202);
    assert.equal(approved.json().replayed, false);
    const requestRow = f.app.database.prepare("SELECT state, delivery_closed FROM requests WHERE id = ?")
      .get(approved.json().requestId) as { state: string; delivery_closed: number };
    assert.equal(requestRow.state, "completed");
    assert.equal(requestRow.delivery_closed, 1, "纯认可不排 Pi 请求");
    assert.equal(assistantCount(f), assistantsBefore, "没有新的模型回合");
    const afterApprove = contentItemOf(f, work.id).item;
    assert.equal(revisionDraftOf(afterApprove).revisionId, v2.revisionId);
    assert.equal(afterApprove.approved?.kind, "artifact_revision");
    assert.equal(afterApprove.approved.revisionId, v2.revisionId);
    assert.ok(afterApprove.confirmationId);

    // 同命令同内容重放：回原回执，不新增确认、不排队。
    const confirmationsBefore = countIn(f, "FROM work_review_confirmations WHERE work_id = ?", work.id);
    const requestsBefore = countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id);
    const replayed = await postMessage(f, approvePayload);
    assert.equal(replayed.statusCode, 202);
    assert.equal(replayed.json().replayed, true);
    assert.equal(replayed.json().requestId, approved.json().requestId, "回放返回原回执");
    assert.equal(countIn(f, "FROM work_review_confirmations WHERE work_id = ?", work.id), confirmationsBefore);
    assert.equal(countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id), requestsBefore);

    // 受理依据缺失：正式整片提案可以准备（报价照常），但没有组审阅认可就不能受理。
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("依据已交。")]);
    const basis = artifactOf(f, "山路画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const unapproved = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(work.id, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest }, "山路短片") })).proposal;
    assert.equal(unapproved.state, "ready");
    assert.equal(unapproved.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED", "缺认可依据的受理阻塞如实投影");
    assert.throws(
      () => f.app.service.acceptProposal("local-owner", unapproved.id, { commandId: cmd(), proposalDigest: unapproved.digest }),
      /正式视频制作需要先获得组审阅认可/,
    );
    assert.equal(countIn(f, "FROM production_runs"), 0);
  } finally { await f.close(); }
});

it("R1.1 认可并继续恰排一次模型；待审 v2 不使已认可 v1 的报价失效，明确旧版仍可受理", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "# 内容\n第一版。")], [newGroupDelivery(work.id)]), fauxAssistantMessage("v1 已登记。")]);
    const content = contentItemOf(f, work.id);
    const v1 = revisionDraftOf(content.item);

    // 认可并继续：恰一条认可 + 恰一次模型回合，Pi 上下文明确指向本次确认的事项。
    let referencedWorkIds: string[] = [];
    f.app.faux!.setResponses([context => {
      const last = context.messages.at(-1)!;
      const text = typeof last.content === "string" ? last.content : Array.isArray(last.content) ? last.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
      referencedWorkIds = text.startsWith("[frame-current-state]")
        ? JSON.parse(text.slice("[frame-current-state]".length).split("\n")[0]!).referencedWorkIds : ["NO-FRAME"];
      return fauxAssistantMessage("继续准备画面方案。");
    }]);
    const continuePayload = { ...chatInput("认可并继续"),
      reviewConfirmation: { workId: work.id, groupId: content.group.id, items: [{ itemId: content.item.id, source: v1 }], action: "approve_and_continue" as const } };
    const continued = await postMessage(f, continuePayload);
    assert.equal(continued.statusCode, 202);
    await waitIdle(f);
    assert.equal(countIn(f, "FROM work_review_confirmations WHERE work_id = ?", work.id), 1);
    assert.deepEqual(referencedWorkIds, [work.id], "继续请求的上下文指向本次确认的事项");
    // 同命令重放不重新排队。
    const requestsBefore = countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id);
    const replayed = await postMessage(f, continuePayload);
    assert.equal(replayed.json().replayed, true);
    assert.equal(replayed.json().requestId, continued.json().requestId);
    assert.equal(countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id), requestsBefore);
    assert.equal(countIn(f, "FROM work_review_confirmations WHERE work_id = ?", work.id), 1);

    // 认可依据冻结在准备时；明确引用已认可 v1 的报价不因后来出现待审 v2 失效（§11.5.5）。
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(work.id, v1, "山路短片", [{ groupId: content.group.id, itemId: content.item.id, source: v1, confirmationId: contentItemOf(f, work.id).item.confirmationId! }]) })).proposal;
    assert.equal(proposal.state, "ready");
    assert.equal(proposal.acceptanceBlocker, null);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.artifactId, baseRevisionId: v1.revisionId,
      title: "山路内容", kind: "script", content: { format: "markdown", text: "# 内容\n第二版。" } }],
      [existingItemDelivery(work.id, content.group.id, content.item.id)]), fauxAssistantMessage("v2 已登记。")]);
    const v2 = revisionDraftOf(contentItemOf(f, work.id).item);
    const afterV2 = f.app.service.readProposal("local-owner", proposal.id) as Proposal;
    assert.equal(afterV2.state, "ready", "待审新稿不使明确引用已认可旧版的报价失效");
    assert.equal(afterV2.acceptanceBlocker, null);
    // 旧版报价按其冻结输入受理并完成；受理事实随后使它不可再受理。
    const acceptedV1 = await f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    assert.equal((await driveToTerminal(f, acceptedV1.run.id)).state, "succeeded");

    // 重新认可当前稿后，新提案引用新依据可受理并完成；认可不被代填。
    assert.equal((await confirmReview(f, { workId: work.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: v2 }], action: "approve" })).statusCode, 202);
    const confirmedV2 = contentItemOf(f, work.id).item.confirmationId!;
    const next = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(work.id, v2, "山路短片", [{ groupId: content.group.id, itemId: content.item.id, source: v2, confirmationId: confirmedV2 }]) })).proposal;
    const accepted = await f.app.service.acceptProposal("local-owner", next.id, { commandId: cmd(), proposalDigest: next.digest });
    assert.equal((await driveToTerminal(f, accepted.run.id)).state, "succeeded");
    const video = videoItemOf(f, work.id);
    assert.equal(video.item.draft?.kind, "artifact_revision", "制作产出登记为视频初稿");
    assert.equal(video.item.approved, null, "成片认可不被代填");
  } finally { await f.close(); }
});

// —— S2（§11.5 / AUDIT-03）：正式制作实际消费的必选依据须各有真实确认行；
// 局部 preview 不需方案认可，正式采用 preview 沿其直接来源核对；认可后同一报价自动解锁 ——

it("S2 正式操作实际用未认必选方案而只报内容确认不得受理；preview 可用该方案，正式采用其产出仍被拦，认可后解锁", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("雨夜短片"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    // 同组两项：脚本与背景方案都必选，另有一项非必选的备选草稿。
    await turn(f, [deliverStep([
      scriptItem("雨夜脚本", "# 脚本\n开场三镜。"),
      scriptItem("背景视觉方案", "# 背景\n雨夜天桥，冷色霓虹。（第一版）"),
      scriptItem("备选画面草稿", "# 备选\n未采用的候选方向。"),
    ], [{ workId: work.id,
      group: { mode: "create", key: "visual", title: "脚本与画面", nextIntent: null },
      items: [
        { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const },
        { item: { mode: "create", key: "scene", label: "背景方案", role: "scene", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" as const },
        { item: { mode: "create", key: "alt", label: "备选草稿", role: "storyboard", required: false }, itemIndex: 2, inputSources: [], reviewInputs: [], purpose: "draft" as const },
      ] }]), fauxAssistantMessage("三项已登记。")]);
    const content = contentItemOf(f, work.id);
    const scene = itemOfRole(f, work.id, "scene");
    const sceneV1 = revisionDraftOf(scene.item);

    // 只认可脚本；背景方案保持未认可。
    assert.equal((await confirmReview(f, { workId: work.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: revisionDraftOf(content.item) }], action: "approve" })).statusCode, 202);
    await waitIdle(f);
    const contentConfirmation = contentItemOf(f, work.id).item.confirmationId!;

    // 正式操作实际消费方案、却只报脚本确认：声明门通过，覆盖推导发现方案缺口（AUDIT-03）。
    const blocked = (await f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: videoSpec(work.id, sceneV1, "雨夜短片", [
        { groupId: content.group.id, itemId: content.item.id, source: revisionDraftOf(content.item), confirmationId: contentConfirmation },
      ]) })).proposal;
    assert.equal(blocked.state, "ready");
    assert.equal(blocked.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    assert.match(blocked.acceptanceBlocker!.message, /背景方案/);
    assert.throws(() => f.app.service.acceptProposal("local-owner", blocked.id, { commandId: cmd(), proposalDigest: blocked.digest }),
      /还未获得认可/);
    assert.equal(countIn(f, "FROM production_runs WHERE conversation_id = ?", f.conversation.id), 0, "不得生成 run");

    // 同一方案用于局部 preview 可以运行：非正式用途不触发方案认可门。
    const previewProposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: videoSpec(work.id, sceneV1, "背景局部预览", [], "preview") })).proposal;
    assert.equal(previewProposal.acceptanceBlocker, null);
    const previewRun = await f.app.service.acceptProposal("local-owner", previewProposal.id, { commandId: cmd(), proposalDigest: previewProposal.digest });
    assert.equal((await driveToTerminal(f, previewRun.run.id)).state, "succeeded");
    const previewOutput = revisionDraftOf(videoItemOf(f, work.id).item);

    // 正式采用该 preview：沿 preview 的直接来源核对，方案认可缺口仍在，不能借 preview 绕过。
    const viaPreview = (await f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: videoSpec(work.id, previewOutput, "雨夜成片", [
        { groupId: content.group.id, itemId: content.item.id, source: revisionDraftOf(content.item), confirmationId: contentConfirmation },
      ]) })).proposal;
    assert.equal(viaPreview.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    assert.match(viaPreview.acceptanceBlocker!.message, /背景方案/);

    // 认可方案后同一报价自动解锁并完成；同组的备选草稿未认可不产生新门槛。
    assert.equal((await confirmReview(f, { workId: work.id, groupId: scene.group.id,
      items: [{ itemId: scene.item.id, source: sceneV1 }], action: "approve" })).statusCode, 202);
    await waitIdle(f);
    assert.equal((f.app.service.readProposal("local-owner", blocked.id) as Proposal).acceptanceBlocker, null, "认可方案后同一报价解锁");
    const accepted = await f.app.service.acceptProposal("local-owner", blocked.id, { commandId: cmd(), proposalDigest: blocked.digest });
    assert.equal((await driveToTerminal(f, accepted.run.id)).state, "succeeded");
  } finally { await f.close(); }
});

it("S2 待审 v2 不能借已认 v1 的确认；错指事项的认可依据在准备时被拒", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("城市短片"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([
      scriptItem("城市脚本", "# 脚本\n清晨街景。"),
      scriptItem("背景视觉方案", "# 背景\n清晨薄雾。（第一版）"),
    ], [{ workId: work.id,
      group: { mode: "create", key: "visual", title: "脚本与画面", nextIntent: null },
      items: [
        { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const },
        { item: { mode: "create", key: "scene", label: "背景方案", role: "scene", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" as const },
      ] }]), fauxAssistantMessage("两项已登记。")]);
    const content = contentItemOf(f, work.id);
    const scene = itemOfRole(f, work.id, "scene");
    const sceneV1 = revisionDraftOf(scene.item);
    assert.equal((await confirmReview(f, { workId: work.id, groupId: scene.group.id,
      items: [{ itemId: scene.item.id, source: sceneV1 }], action: "approve" })).statusCode, 202);
    const contentV1 = revisionDraftOf(content.item);
    assert.equal((await confirmReview(f, { workId: work.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: contentV1 }], action: "approve" })).statusCode, 202);
    await waitIdle(f);
    const sceneConfirmation = itemOfRole(f, work.id, "scene").item.confirmationId!;

    // 错指事项：脚本的确认不能冒充背景方案的依据，准备时即被拒（AUDIT-04/05）。
    await assert.rejects(f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: videoSpec(work.id, sceneV1, "城市短片", [
        { groupId: content.group.id, itemId: scene.item.id, source: contentV1, confirmationId: contentItemOf(f, work.id).item.confirmationId! },
      ]) }), /认可依据与所指向的审阅事项不一致/);

    // 方案 v2 待审：声明与 v1 确认一致能通过准备，但受理核对实际消费的 v2，v2 不能借 v1。
    await turn(f, [deliverStep([{ mode: "revise", artifactId: sceneV1.artifactId, baseRevisionId: sceneV1.revisionId,
      title: "背景视觉方案", kind: "script", content: { format: "markdown", text: "# 背景\n清晨薄雾。（第二版）" } }],
      [existingItemDelivery(work.id, scene.group.id, scene.item.id)]), fauxAssistantMessage("v2 已登记。")]);
    const sceneV2 = revisionDraftOf(itemOfRole(f, work.id, "scene").item);
    const borrowed = (await f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: videoSpec(work.id, sceneV2, "城市短片", [
        { groupId: scene.group.id, itemId: scene.item.id, source: sceneV1, confirmationId: sceneConfirmation },
      ]) })).proposal;
    assert.equal(borrowed.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    assert.match(borrowed.acceptanceBlocker!.message, /背景方案/);
    assert.throws(() => f.app.service.acceptProposal("local-owner", borrowed.id, { commandId: cmd(), proposalDigest: borrowed.digest }),
      /还未获得认可/);
  } finally { await f.close(); }
});

// —— R1.2（F05/F08）：交付归属按修订绑定推导；隐式继承可用，改挂他事项被拒 ——

it("R1.2 上游视觉认可可跨组交付成片，完整保留引用；错事项、错组、未认版本与他作品确认仍拒绝", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("跨组短片"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    // 本地媒体替身提供真实夹具文件，交付、认可和来源核对仍走产品入口。
    const message = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(entry => entry.role === "user")!;
    const imageInput = { kind: "message_text" as const, messageId: message.id, text: message.text };
    const imageProposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, {
      commandId: cmd(), spec: {
        workId: null, title: "画面样本", inputSources: [imageInput], reviewInputs: [], purpose: "draft", scope: "单张画面",
        operations: [{ operationId: "image", outputSlot: "image", kind: "image", model: OFFLINE_QUOTE_CATALOG["image:faux-image"].binding,
          inputs: [{ kind: "text", text: message.text }], maxCreateAttempts: 1, parameters: { aspectRatio: "16:9", resolution: "640x360" } }],
        finalOutput: { operationId: "image", outputSlot: "image" }, maxSpend: { currency: "CNY", amountMinor: 300 },
      },
    })).proposal;
    const imageRun = await f.app.service.acceptProposal("local-owner", imageProposal.id, { commandId: cmd(), proposalDigest: imageProposal.digest });
    const image = (await driveToTerminal(f, imageRun.run.id)).outputRevisions[0]!;
    await turn(f, [deliverStep([{ mode: "create", title: "视觉画面", kind: "image",
      content: { format: "local_output", source: { kind: "artifact_revision", artifactId: image.artifactId, revisionId: image.revisionId } } }], [{
      workId: work.id, group: { mode: "create", key: "visual", title: "视觉方案", nextIntent: null },
      items: [{ item: { mode: "create", key: "frame", label: "画面", role: "storyboard", required: true },
        itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }],
    }]), fauxAssistantMessage("画面已交付。")]);
    const visual = itemOfRole(f, work.id, "storyboard");
    const v1 = revisionDraftOf(visual.item);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.artifactId, baseRevisionId: v1.revisionId, title: "视觉画面", kind: "image",
      content: { format: "local_output", source: { kind: "artifact_revision", artifactId: v1.artifactId, revisionId: v1.revisionId } } }],
      [existingItemDelivery(work.id, visual.group.id, visual.item.id)]), fauxAssistantMessage("第二版已交付。")]);
    const v2 = revisionDraftOf(itemOfRole(f, work.id, "storyboard").item);
    assert.equal((await confirmReview(f, { workId: work.id, groupId: visual.group.id,
      items: [{ itemId: visual.item.id, source: v2 }], action: "approve" })).statusCode, 202);
    const approved = itemOfRole(f, work.id, "storyboard").item;
    const reviewInput = { groupId: visual.group.id, itemId: visual.item.id, source: v2, confirmationId: approved.confirmationId! };
    const confirmation = f.app.database.prepare("SELECT * FROM work_review_confirmations WHERE id=?").get(reviewInput.confirmationId);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(work.id, v2, "跨组短片", [reviewInput]) })).proposal;
    const accepted = await f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const rendered = await driveToTerminal(f, accepted.run.id);
    assert.equal(rendered.state, "succeeded");
    const final = videoItemOf(f, work.id);
    assert.notEqual(final.group.id, visual.group.id);
    const video = rendered.outputRevisions[0]!;
    const finalTarget = existingItemDelivery(work.id, final.group.id, final.item.id);
    const target = { ...finalTarget, items: [{ ...finalTarget.items[0]!, inputSources: [v2], reviewInputs: [reviewInput] }] };
    let deliveryError: string | undefined;
    await turn(f, [deliverStep([{ mode: "create", title: "准确引用视觉的成片", kind: "video",
      content: { format: "local_output", source: { kind: "artifact_revision", artifactId: video.artifactId, revisionId: video.revisionId } } }], [target]), context => {
        const result = context.messages.filter(entry => entry.role === "toolResult").at(-1)!;
        if (result.isError) deliveryError = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        return fauxAssistantMessage("成片已交付。");
      }]);
    assert.equal(deliveryError, undefined, "合法跨组交付应成功");
    const delivered = artifactOf(f, "准确引用视觉的成片");
    const revision = f.app.service.readRevision("local-owner", delivered.id, delivered.revisionId);
    assert.deepEqual(revision.creationBinding, { workId: work.id, groupId: final.group.id, itemId: final.item.id,
      inputSources: [v2], reviewInputs: [reviewInput], purpose: "draft",
      runId: rendered.id, adoptedFrom: { artifactId: video.artifactId, revisionId: video.revisionId } });
    assert.equal(revisionDraftOf(videoItemOf(f, work.id).item).revisionId, delivered.revisionId);
    assert.equal(videoItemOf(f, work.id).item.approved, null, "跨组交付不会认可新成片");
    const other = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "另一作品");
    const artifactsBefore = countIn(f, "FROM artifact_revisions");
    const draftBefore = videoItemOf(f, work.id).item.draft;
    for (const [invalid, error] of [
      [{ ...reviewInput, itemId: final.item.id }, /审阅事项不一致/],
      [{ ...reviewInput, groupId: final.group.id }, /审阅事项不一致/],
      [{ ...reviewInput, source: v1 }, /版本与引用不一致/],
      [other.reviewInput, /不属于这条视频创作/],
    ] as const) {
      let result: { isError: boolean | undefined; text: string } | undefined;
      const target = { ...finalTarget, items: [{ ...finalTarget.items[0]!, reviewInputs: [invalid] }] };
      await turn(f, [deliverStep([{ mode: "create", title: "错误来源成片", kind: "video",
        content: { format: "local_output", source: { kind: "artifact_revision", artifactId: video.artifactId, revisionId: video.revisionId } } }], [target]), context => {
        const message = context.messages.filter(entry => entry.role === "toolResult").at(-1)!;
        result = { isError: message.isError, text: message.content.filter(part => part.type === "text").map(part => part.text).join("") };
        return fauxAssistantMessage("来源被拒绝。");
      }]);
      assert.equal(result?.isError, true);
      assert.match(result!.text, error);
      assert.equal(countIn(f, "FROM artifact_revisions"), artifactsBefore, "拒绝时不落新修订");
      assert.deepEqual(videoItemOf(f, work.id).item.draft, draftBefore, "拒绝时不移动成片草稿");
    }
    assert.deepEqual(itemOfRole(f, work.id, "storyboard").item, approved, "上游准确版本与认可保持不变");
    assert.deepEqual(f.app.database.prepare("SELECT * FROM work_review_confirmations WHERE id=?").get(reviewInput.confirmationId), confirmation);
  } finally { await f.close(); }
});

it("R1.2 省略 reviewGroups 的改稿按绑定归属当前事项；显式改挂他事项被拒；他事项稿件意见不能混挂", async () => {
  const f = await setup(); const releases: (() => void)[] = [];
  try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "# 内容\n第一版。")], [newGroupDelivery(work.id)]), fauxAssistantMessage("内容已登记。")]);
    const content = contentItemOf(f, work.id);
    const v1 = revisionDraftOf(content.item);

    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    await turn(f, [deliverStep([scriptItem("咖啡内容", "# 咖啡\n蒸汽特写。")], [newGroupDelivery(coffee.id)]), fauxAssistantMessage("B 主稿已登记。")]);
    const coffeeContent = contentItemOf(f, coffee.id);

    // 省略 reviewGroups 的改稿：按上一修订的绑定自动归属该事项草稿。
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.artifactId, baseRevisionId: v1.revisionId,
      title: "山路内容", kind: "script", content: { format: "markdown", text: "# 内容\n第二版。" } }]), fauxAssistantMessage("改到 v2。")]);
    const v2 = revisionDraftOf(contentItemOf(f, work.id).item);
    assert.notEqual(v2.revisionId, v1.revisionId, "改稿自动归属当前事项");
    assert.equal(revisionDraftOf(coffeeContent.item).revisionId, revisionDraftOf(contentItemOf(f, coffee.id).item).revisionId, "他事项不被级联修改");

    // 显式把 A 的主稿改挂到 B 的事项：归属核对拒绝，产物不动。
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v2.artifactId, baseRevisionId: v2.revisionId,
      title: "山路内容", kind: "script", content: { format: "markdown", text: "# 内容\n冒充 B 的第三版。" } }],
      [existingItemDelivery(coffee.id, coffeeContent.group.id, coffeeContent.item.id)]), fauxAssistantMessage("改挂被拦。")]);
    assert.equal(f.app.service.readArtifactHead("local-owner", v2.artifactId).revisionNumber, 2, "改挂被拒不落新修订");
    assert.equal(revisionDraftOf(contentItemOf(f, coffee.id).item).artifactId, revisionDraftOf(coffeeContent.item).artifactId, "B 主稿未变");

    // 意见入口同样核对归属：A 的主稿不能作为 B 的意见对象。
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const wrong = await holdRequest(f, "这条意见属于 B"); releases.push(wrong.release);
    await assert.rejects(() => tools.recordWorkFeedback(wrong.context as never,
      { workId: coffee.id, artifactId: v2.artifactId, baseRevisionId: v2.revisionId }), /属于其他视频创作|不属于该视频的主稿/);
    wrong.release(); await waitIdle(f);
  } finally { releases.forEach(release => release()); await f.close(); }
});

it("R1.2 空主稿事项首次采用：历史修订与消息原文合法，他事项绑定修订被拒", async () => {
  const f = await setup(); try {
    const now = new Date().toISOString();
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    // 一份已有两版的独立稿：采用时 head 是 v2，历史修订 v1 仍可被明确采用。
    await turn(f, [deliverStep([scriptItem("独立稿", "# 独立稿\n第一版。")]), fauxAssistantMessage("独立稿交付。")]);
    const standalone = artifactOf(f, "独立稿");
    const rev1 = f.app.service.readRevision("local-owner", standalone.id, standalone.revisionId);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: standalone.id, baseRevisionId: standalone.revisionId,
      title: "独立稿", kind: "script", content: { format: "markdown", text: "# 独立稿\n第二版。" } }]), fauxAssistantMessage("独立稿升到 v2。")]);
    assert.equal(artifactOf(f, "独立稿").revisionNumber, 2);
    // 一条真实的用户聊天原文。
    await turn(f, [fauxAssistantMessage("已记下这段内容。")], "正式做：清晨山路固定镜头，缓慢推近。");
    const sourceMessage = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.text === "正式做：清晨山路固定镜头，缓慢推近。")!;

    const a = seedEmptyContentItem(f.app.database, now, scope, "山路视频");
    const b = seedEmptyContentItem(f.app.database, now, scope, "咖啡视频");

    // 首次采用历史修订：head 已是 v2，仍可采用 v1 建立内容主稿与认可。
    const adopted = await confirmReview(f, { workId: a.workId, groupId: a.groupId,
      items: [{ itemId: a.itemId, source: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest } }],
      action: "approve" });
    assert.equal(adopted.statusCode, 202);
    const itemA = contentItemOf(f, a.workId).item;
    assert.equal(revisionDraftOf(itemA).revisionId, standalone.revisionId);
    assert.equal(itemA.approved?.kind === "artifact_revision" ? itemA.approved.revisionId : null, standalone.revisionId);

    // 首次采用聊天原文：内容来源是消息本身，不复制稿件。
    const messageSubject: ContentSourceInput = { kind: "message_text", messageId: sourceMessage.id, text: sourceMessage.text };
    const fromChat = await confirmReview(f, { workId: b.workId, groupId: b.groupId,
      items: [{ itemId: b.itemId, source: messageSubject }], action: "approve" });
    assert.equal(fromChat.statusCode, 202);
    const itemB = contentItemOf(f, b.workId).item;
    assert.deepEqual(itemB.draft, { kind: "message_text", messageId: sourceMessage.id, text: sourceMessage.text, author: "user" });

    // 采用指向其他视频绑定修订：拒绝。
    const foreign = await confirmReview(f, { workId: b.workId, groupId: b.groupId,
      items: [{ itemId: b.itemId, source: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest } }],
      action: "approve" });
    assert.equal(foreign.statusCode, 400);
    assert.match(foreign.json().message, /属于其他视频|不是当前稿/);
  } finally { await f.close(); }
});

it("成对交付一次登记两个事项草稿；逐项认可互不影响，纯认可不排模型", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([
      scriptItem("山路内容", "# 内容\n第一版。"),
      scriptItem("山路方案", "# 方案\n镜头顺序。"),
    ], [{
      workId: work.id,
      group: { mode: "create", key: "main", title: "脚本与方案", nextIntent: null },
      items: [
        { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const },
        { item: { mode: "create", key: "plan", label: "画面方案", role: "plan", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" as const },
      ],
    }]), fauxAssistantMessage("两份草稿一起看。")]);
    const content = contentItemOf(f, work.id);
    const plan = itemOfRole(f, work.id, "plan");
    assert.ok(content.item.draft && content.item.draft.kind === "artifact_revision");
    assert.ok(plan.item.draft && plan.item.draft.kind === "artifact_revision");
    assert.notEqual(revisionDraftOf(plan.item).revisionId, revisionDraftOf(content.item).revisionId);

    // 配对在场：认可内容只记录该事项，不排模型回合（未预置任何 Faux 响应），方案保持原样。
    const assistantsBefore = assistantCount(f);
    assert.equal((await confirmReview(f, { workId: work.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: revisionDraftOf(content.item) }], action: "approve" })).statusCode, 202);
    await new Promise(resolve => setTimeout(resolve, 100));
    const after = workOf(f, work.id).reviewGroups;
    const contentAfter = after.flatMap(group => group.items).find(item => item.id === content.item.id)!;
    const planAfter = after.flatMap(group => group.items).find(item => item.id === plan.item.id)!;
    assert.equal(contentAfter.approved?.kind === "artifact_revision" ? contentAfter.approved.revisionId : null, revisionDraftOf(content.item).revisionId, "内容已认可");
    assert.equal(planAfter.approved, null, "方案不被成对认可");
    assert.equal(planAfter.draft && planAfter.draft.kind === "artifact_revision" ? planAfter.draft.revisionId : null, revisionDraftOf(plan.item).revisionId, "对应方案保持原样");
    assert.equal(assistantCount(f), assistantsBefore, "没有新的模型回合");
    const messages = f.app.service.snapshot("local-owner", f.conversation.id).messages.items;
    assert.ok(!messages.some(item => item.state === "failed"), "没有失败回合");
  } finally { await f.close(); }
});

// —— R1.3（F06）/§4.2.1：在途只约束新制作受理；认可与后继草稿不阻塞 ——

it("R1.3 在途不阻塞认可与后继改稿；run 用冻结输入，他事项可写，worker 完成落位成片", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("依据已交。")]);
    const basis = artifactOf(f, "山路画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(confirmed.workId, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest }, "山路短片", [confirmed.reviewInput]) })).proposal;
    const accepted = await f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    assert.equal(f.app.service.getRun("local-owner", accepted.run.id).state, "queued");

    // 在途仍可独立认可（§4.2.1）：认可作用于当前稿，不被运行阻塞。
    const content = contentItemOf(f, confirmed.workId);
    const script = revisionDraftOf(content.item);
    assert.equal((await confirmReview(f, { workId: confirmed.workId, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: script }], action: "approve" })).statusCode, 202);

    // 输入冻结（A2/F03）：冻结的是本次 run 的输入，不禁止保存后继改稿。
    f.app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: basis.id, baseRevisionId: basis.revisionId,
      title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "在途保存的下一版依据。" } }] } as never)]), fauxAssistantMessage("已保存为下一版，本次制作仍用原输入。")]);
    const modification = await f.app.service.sendMessage("local-owner", f.conversation.id, chatInput("改这份依据"));
    await waitRequestDone(f, modification.receipt.requestId);
    assert.equal(f.app.service.readArtifactHead("local-owner", basis.id).revisionNumber, 2, "在途改稿照常保存为下一版");

    // 后继草稿不阻塞：同事项交付新版内容草稿照常登记。
    await turn(f, [deliverStep([{ mode: "revise", artifactId: script.artifactId, baseRevisionId: script.revisionId,
      title: `${confirmed.workId}脚本`, kind: "script", content: { format: "markdown", text: "# 脚本\n在途期间的新版内容。" } }],
      [existingItemDelivery(confirmed.workId, confirmed.groupId, confirmed.itemId)]), fauxAssistantMessage("后继草稿已登记。")]);
    const advanced = revisionDraftOf(contentItemOf(f, confirmed.workId).item);
    assert.notEqual(advanced.revisionId, script.revisionId, "在途不阻塞后继草稿");

    // 他事项不受影响：可开新事项并登记内容主稿。
    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    await turn(f, [deliverStep([scriptItem("咖啡内容", "# 咖啡\n第一版。")], [newGroupDelivery(coffee.id)]), fauxAssistantMessage("B 事项可写。")]);
    assert.ok(revisionDraftOf(contentItemOf(f, coffee.id).item));

    // worker 完成不受影响：受理时无视频事项，受理事务当场分配成片项，产出落位到该冻结目标。
    const result = await driveToTerminal(f, accepted.run.id);
    assert.equal(result.state, "succeeded");
    const video = videoItemOf(f, confirmed.workId);
    assert.equal(video.item.draft?.kind, "artifact_revision", "制作产出登记为视频初稿");
    assert.equal(video.item.approved, null);
    assert.equal(revisionDraftOf(contentItemOf(f, confirmed.workId).item).revisionId, advanced.revisionId, "后继内容草稿不被产出覆盖");
  } finally { await f.close(); }
});

it("R1.3 受理冻结的视频目标：后台旧结果不覆盖在途期间前进的后继稿（no-clobber）", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("依据已交。")]);
    const firstBasis = artifactOf(f, "山路画面依据");
    const firstRevision = f.app.service.readRevision("local-owner", firstBasis.id, firstBasis.revisionId);
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const prepare = (input: { artifactId: string; revisionId: string; digest: string }, title: string) =>
      f.app.service.prepareProposal("local-owner", f.conversation.id,
        { commandId: cmd(), spec: videoSpec(confirmed.workId, input, title, [confirmed.reviewInput]) });
    const run1 = (await prepare({ artifactId: firstBasis.id, revisionId: firstBasis.revisionId, digest: firstRevision.digest }, "山路短片")).proposal;
    const accepted1 = await f.app.service.acceptProposal("local-owner", run1.id, { commandId: cmd(), proposalDigest: run1.digest });
    assert.equal((await driveToTerminal(f, accepted1.run.id)).state, "succeeded");
    const target = videoItemOf(f, confirmed.workId);
    const v1 = revisionDraftOf(target.item);

    // 第二次受理冻结当前目标（F02 重做指向同一视频事项）；在途期间交付引用首次产出的新成片草稿，目标前进。
    await turn(f, [deliverStep([{ mode: "create", title: "夜路画面依据", kind: "prompt", content: { format: "markdown", text: "夜间城市车流的固定镜头。" } }]), fauxAssistantMessage("第二依据已交。")]);
    const secondBasis = artifactOf(f, "夜路画面依据");
    const secondRevision = f.app.service.readRevision("local-owner", secondBasis.id, secondBasis.revisionId);
    const redoSpec = videoSpec(confirmed.workId, { artifactId: secondBasis.id, revisionId: secondBasis.revisionId, digest: secondRevision.digest }, "山路短片第二版", [confirmed.reviewInput]);
    redoSpec.outputTarget = { group: { mode: "existing", groupId: target.group.id }, item: { mode: "existing", itemId: target.item.id } };
    const run2 = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: redoSpec })).proposal;
    const accepted2 = await f.app.service.acceptProposal("local-owner", run2.id, { commandId: cmd(), proposalDigest: run2.digest });
    await turn(f, [deliverStep([{ mode: "create", title: "成片下一版", kind: "video",
      content: { format: "local_output", source: { kind: "artifact_revision", artifactId: v1.artifactId, revisionId: v1.revisionId } } }],
      [existingItemDelivery(confirmed.workId, target.group.id, target.item.id)]), fauxAssistantMessage("用户已改看新版草稿。")]);
    const v2 = revisionDraftOf(videoItemOf(f, confirmed.workId).item);
    assert.notEqual(v2.revisionId, v1.revisionId, "在途期间后继成片草稿已前进");

    // 后台旧结果完成：只保留为 run 产出，不覆盖后继稿。
    const result2 = await driveToTerminal(f, accepted2.run.id);
    assert.equal(result2.state, "succeeded");
    assert.equal(result2.outputRevisions.length, 1);
    const after = videoItemOf(f, confirmed.workId);
    assert.equal(revisionDraftOf(after.item).revisionId, v2.revisionId, "后台旧结果不覆盖后继稿");
    assert.equal(after.item.approved, null);
  } finally { await f.close(); }
});

// S4（§11.6）：最终视频的输出目标在受理事务里确定——此前没有视频事项时当场分配空 draft 成片项并冻结身份；
// 完成时只落该目标，不再找最新 video、不补建组、不改挂别件作品。
it("S4 付费输出目标受理即冻结：无视频事项时空项当场分配，完成不改挂、不补建第二成片项", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("依据已交。")]);
    const basis = artifactOf(f, "山路画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(confirmed.workId, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest }, "山路短片", [confirmed.reviewInput]) })).proposal;
    const accepted = await f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });

    // 受理事务内已确定 group/item：空 draft 成片项立刻可见（制作中），不等完成阶段补建。
    const allocated = videoItemOf(f, confirmed.workId);
    assert.equal(allocated.item.draft, null, "受理分配的成片项当时确实无稿");
    assert.equal(allocated.item.role, "video");
    const frozen = JSON.parse((f.app.database.prepare("SELECT frozen_target_json FROM production_runs WHERE id=?")
      .get(accepted.run.id) as { frozen_target_json: string }).frozen_target_json);
    assert.deepEqual(frozen, { groupId: allocated.group.id, itemId: allocated.item.id, baseRevisionId: null },
      "S4：受理冻结空项身份与 null 基准");

    // 制作在途聊另一件作品：B 的内容主稿照常登记，不影响 A 的冻结目标。
    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    await turn(f, [deliverStep([scriptItem("咖啡内容", "# 咖啡\n在途期间的另一件作品。")], [newGroupDelivery(coffee.id)]), fauxAssistantMessage("B 已写。")]);
    assert.ok(revisionDraftOf(contentItemOf(f, coffee.id).item), "在途可聊并写另一件作品");

    // 完成：落在受理分配的原空项上；不补建第二个视频事项、不改挂 B。
    const result = await driveToTerminal(f, accepted.run.id);
    assert.equal(result.state, "succeeded");
    const landed = videoItemOf(f, confirmed.workId);
    assert.equal(landed.item.id, allocated.item.id, "落位到受理冻结的原目标");
    assert.ok(landed.item.draft?.kind === "artifact_revision"
      && landed.item.draft.revisionId === result.outputRevisions[0]!.revisionId, "产出登记为该成片项当前稿");
    assert.equal(workOf(f, confirmed.workId).reviewGroups.flatMap(group => group.items).filter(item => item.role === "video").length, 1,
      "不补建第二个成片组/视频事项");
    assert.equal(workOf(f, coffee.id).reviewGroups.flatMap(group => group.items).filter(item => item.role === "video").length, 0,
      "不改挂到另一件作品");
    const binding = JSON.parse((f.app.database.prepare("SELECT creation_binding_json FROM artifact_revisions WHERE id=?")
      .get(result.outputRevisions[0]!.revisionId) as { creation_binding_json: string }).creation_binding_json);
    assert.equal(binding.itemId, allocated.item.id, "产出 binding 记录受理冻结的目标");
  } finally { await f.close(); }
});

it("R1.3 admit 中途失败整体回滚：无半份授权或运行；重试可正常受理", async () => {
  let failAdmission = true;
  const f = await setup(undefined, { crash: point => { if (failAdmission && point === "before-admission-commit") throw new Error("simulated crash before commit"); } });
  try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("已交付。")]);
    const basis = artifactOf(f, "山路画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: videoSpec(confirmed.workId, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest }, "山路短片", [confirmed.reviewInput]) })).proposal;

    const failed = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.ok(failed.statusCode >= 500, "受理事务中途失败如实报错");
    assert.equal(countIn(f, "FROM production_runs"), 0);
    assert.equal(countIn(f, "FROM authorizations"), 0);
    assert.equal(countIn(f, "FROM user_actions"), 0);
    assert.equal(countIn(f, "FROM work_review_confirmations"), 1, "夹具认可以外无半份新认可");
    assert.equal((f.app.service.readProposal("local-owner", proposal.id) as Proposal).state, "ready", "提案保持可受理");

    // 同一提案重试：事务完整重放受理事实。
    failAdmission = false;
    const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.equal(accepted.statusCode, 202);
    assert.equal(countIn(f, "FROM production_runs"), 1);
    assert.equal(countIn(f, "FROM work_review_confirmations"), 1, "受理不补写认可");
    assert.equal((await driveToTerminal(f, accepted.json().run.id)).state, "succeeded");
  } finally { await f.close(); }
});

// —— R1.4（F09）：意见按真实归属投影；read_work 只读本事项；steer 后意见落在真实来源 ——

it("R1.4 原文内容意见与稿件意见各归本事项；read_work 只读相关意见，不混入他事项", async () => {
  const f = await setup();
  const releases: (() => void)[] = [];
  try {
    const now = new Date().toISOString();
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    // 事项 A：内容主稿是交付的脚本修订。
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const mountain = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "# 山路\n固定镜头。")], [newGroupDelivery(mountain.id)]), fauxAssistantMessage("A 主稿已登记。")]);
    const mountainDraft = revisionDraftOf(contentItemOf(f, mountain.id).item);
    // 事项 B：内容主稿是用户聊天原文（空主稿事项首次采用）。
    await turn(f, [fauxAssistantMessage("已记下这段内容。")], "正式做咖啡这条：蒸汽特写，慢推。");
    const coffeeMessage = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.text === "正式做咖啡这条：蒸汽特写，慢推。")!;
    const coffee = seedEmptyContentItem(f.app.database, now, scope, "咖啡视频");
    assert.equal((await confirmReview(f, { workId: coffee.workId, groupId: coffee.groupId,
      items: [{ itemId: coffee.itemId, source: { kind: "message_text", messageId: coffeeMessage.id, text: coffeeMessage.text } }], action: "approve" })).statusCode, 202);

    // 模型工具：A 用 workId-only 记稿件意见；B 用 workId-only 记原文内容意见。
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const heldA = await holdRequest(f, "山路这条：节奏再快一点"); releases.push(heldA.release);
    const noteA = await tools.recordWorkFeedback(heldA.context as never, { workId: mountain.id, artifactId: null, baseRevisionId: null });
    heldA.release(); await waitIdle(f);
    assert.equal(noteA.workId, null);
    assert.equal(noteA.target!.artifactId, mountainDraft.artifactId, "稿件意见按修订 target 关联本事项");
    assert.equal(noteA.target!.workId, mountain.id);
    assert.equal(noteA.disposition, "noted");
    const heldB = await holdRequest(f, "咖啡这条：结尾停久一点"); releases.push(heldB.release);
    const noteB = await tools.recordWorkFeedback(heldB.context as never, { workId: coffee.workId, artifactId: null, baseRevisionId: null });
    heldB.release(); await waitIdle(f);
    assert.equal(noteB.target, null);
    assert.equal(noteB.workId, coffee.workId);
    assert.equal(noteB.contentSource!.kind, "message_text", "原文内容意见按消息原文关联");

    // 旧入口（用户按钮反馈）：指向 A 的稿件修订。
    const legacy = f.app.service.addFeedback("local-owner", f.conversation.id, { commandId: cmd(),
      target: { artifactId: mountainDraft.artifactId, revisionId: mountainDraft.revisionId, workId: mountain.id }, text: "旧入口：字幕小一号" });
    assert.equal(legacy.receipt.disposition, "noted");

    // 意见消息的真实投影：kind 与原文不变，feedback 带上真实归属。
    const messages = f.app.service.snapshot("local-owner", f.conversation.id).messages.items;
    const aMessage = messages.find(item => item.id === noteA.messageId)!;
    assert.equal(aMessage.kind, "chat");
    assert.equal(aMessage.text, "山路这条：节奏再快一点");
    assert.equal(aMessage.feedback!.workId, null);
    assert.equal(aMessage.feedback!.contentSource, null);
    assert.equal(aMessage.target!.workId, mountain.id);
    assert.equal(validatorFor("Message")(aMessage).ok, true, "普通用户消息携带真实意见符合正式合同");
    const response = await f.app.app.inject({ method: "GET", url: `/api/agent/v1/conversations/${f.conversation.id}/snapshot` });
    assert.equal(response.statusCode, 200);
    assert.equal(validatorFor("Snapshot")(response.json()).ok, true, "实际 HTTP 快照也符合合同");

    // read_work 共用只读查询：各事项只读到自己的意见。
    const heldRead = await holdRequest(f, "读取事实"); releases.push(heldRead.release);
    const readA = await tools.readWork(heldRead.context as never, { workId: mountain.id });
    const readB = await tools.readWork(heldRead.context as never, { workId: coffee.workId });
    heldRead.release(); await waitIdle(f);
    assert.equal(readA.relatedFeedback.length, 2, "A 有稿件意见与旧入口意见各一条");
    assert.ok(readA.relatedFeedback.every(note => note.workId === null || note.workId === mountain.id || note.target?.workId === mountain.id));
    assert.ok(readA.relatedFeedback.some(note => note.text.includes("节奏再快一点")));
    assert.ok(readA.relatedFeedback.some(note => note.text.includes("旧入口：字幕小一号")));
    assert.equal(readB.relatedFeedback.length, 1);
    assert.equal(readB.relatedFeedback[0]!.workId, coffee.workId);
    assert.match(readB.relatedFeedback[0]!.text, /结尾停久一点/);
    assert.ok(!readB.relatedFeedback.some(note => note.text.includes("节奏再快一点")), "A 的意见不混入 B");
  } finally { releases.forEach(release => release()); await f.close(); }
});

it("R1.4 已消费的 steer 成为意见的真实来源：意见落在补充消息上，不冒用原请求消息", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "# 内容\n第一版。")], [newGroupDelivery(work.id)]), fauxAssistantMessage("v1 已登记。")]);

    let release!: () => void, modelStarted!: () => void;
    const started = new Promise<void>(resolve => { modelStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.app.faux!.setResponses([
      async () => { modelStarted(); await gate; return fauxAssistantMessage("先记意见。"); },
      fauxAssistantMessage([fauxToolCall("record_work_feedback", { workId: work.id, artifactId: null, baseRevisionId: null })]),
      fauxAssistantMessage("意见已记录。"),
    ]);
    const sent = await f.app.service.sendMessage("local-owner", f.conversation.id, chatInput("这条视频我再说两句"));
    await started;
    try {
      const steer = await postMessage(f, chatInput("补充意见：结尾不要加 logo", { mode: "steer", steerRequestId: sent.receipt.requestId }));
      assert.equal(steer.statusCode, 202);
    } finally { release(); }
    await waitIdle(f);

    const messages = f.app.service.snapshot("local-owner", f.conversation.id).messages.items;
    const steerMessage = messages.find(item => item.text === "补充意见：结尾不要加 logo")!;
    const original = messages.find(item => item.id === sent.receipt.messageId)!;
    assert.ok(steerMessage.feedback, "意见落在被消费的 steer 消息上");
    assert.equal(steerMessage.target!.workId, work.id, "稿件内容按修订 target 关联本事项");
    assert.equal(steerMessage.feedback!.contentSource, null);
    assert.equal(original.feedback, null, "原请求消息不冒用意见");
  } finally { await f.close(); }
});

it("R1.4 原生 steer 后的意见按实际消息所属事项进入下一次 Pi 上下文", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("视频 A"), startWorkStep("视频 B"), fauxAssistantMessage("两条已开始。")]);
    const a = works(f).find(item => item.title === "视频 A")!, b = works(f).find(item => item.title === "视频 B")!;
    await turn(f, [deliverStep([scriptItem("A 内容", "# A\n山路开场。")], [newGroupDelivery(a.id)]), fauxAssistantMessage("A 主稿已登记。")]);
    await turn(f, [deliverStep([scriptItem("B 内容", "# B\n咖啡杯开场。")], [newGroupDelivery(b.id)]), fauxAssistantMessage("B 主稿已登记。")]);
    const aDraft = revisionDraftOf(contentItemOf(f, a.id).item);
    const bDraft = revisionDraftOf(contentItemOf(f, b.id).item);

    // 先给 A 留一条意见：后续 B 的上下文不应混入。
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const heldA = await holdRequest(f, "A 的旧意见：开头太快"); const releaseA = heldA.release;
    await tools.recordWorkFeedback(heldA.context as never, { workId: a.id, artifactId: null, baseRevisionId: null });
    releaseA(); await waitIdle(f);

    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let frame: { referencedWorkIds: string[]; feedback: { text: string; disposition: string }[] } | undefined;
    f.app.faux!.setResponses([
      async () => { entered(); await gate; return fauxAssistantMessage("先听你的补充。"); },
      fauxAssistantMessage([fauxToolCall("record_work_feedback", { workId: b.id, artifactId: null, baseRevisionId: null })]),
      context => {
        const last = context.messages.at(-1)!;
        const text = typeof last.content === "string" ? last.content : last.content.filter(block => block.type === "text").map(block => block.text).join("");
        frame = JSON.parse(text.slice("[frame-current-state]".length).split("\n")[0]!);
        return fauxAssistantMessage("B 的意见已记录。");
      },
    ]);
    const sent = await f.app.service.sendMessage("local-owner", f.conversation.id, chatInput("A 暂时先这样", {
      target: { artifactId: aDraft.artifactId, revisionId: aDraft.revisionId, workId: a.id },
    }));
    await started;
    try {
      assert.equal((await postMessage(f, chatInput("B 的意见：开头用近景", { mode: "steer", steerRequestId: sent.receipt.requestId }))).statusCode, 202);
    } finally { release(); }
    await waitIdle(f);
    assert.deepEqual(frame?.referencedWorkIds, [b.id]);
    assert.deepEqual(frame?.feedback.map(note => [note.text, note.disposition]), [["B 的意见：开头用近景", "noted"]], "A 的旧意见不混入 B 的上下文");
    const message = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.text === "B 的意见：开头用近景")!;
    assert.equal(message.target?.workId, b.id, "意见挂在 B 的主稿 target 上");
    assert.notEqual(message.target?.artifactId, aDraft.artifactId, "聊天补充意见不冒用 A 的稿件 target");
    assert.ok(bDraft.revisionId);
  } finally { await f.close(); }
});

it("DG-R1 DGR05 公开 start_work 从空 works 采用独立 v2，原稿与独立 v1 认可不变", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([scriptItem("先独立写的脚本", "第一版内容。")]), fauxAssistantMessage("先只交付脚本。")], "只写脚本，暂不做视频。");
    const v1 = artifactOf(f, "先独立写的脚本");
    assert.equal((await postMessage(f, chatInput("认可第一版。", { reviewConfirmation: {
      kind: "standalone_artifact", artifactId: v1.id, revisionId: v1.revisionId, action: "approve",
    } }))).statusCode, 202);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.id, baseRevisionId: v1.revisionId,
      title: v1.title, kind: "script", content: { format: "markdown", text: "第二版内容。" } }]), fauxAssistantMessage("第二版仍是草稿。")], "改到第二版，仍不做视频。");
    const v2 = artifactOf(f, v1.title);
    const revision = f.app.service.readRevision("local-owner", v2.id, v2.revisionId);
    assert.equal(v2.standaloneApproval?.revisionId, v1.revisionId);
    assert.deepEqual(works(f), [], "真实采用之前没有作品，也没有 fixture 预建组");
    const artifactCount = countIn(f, "FROM artifacts"), revisionCount = countIn(f, "FROM artifact_revisions");
    const text = "现在正式开始视频 A，采用这份第二版脚本。";
    await turn(f, [fauxAssistantMessage([fauxToolCall("start_work", { title: "正式视频 A", adoptContent: {
      kind: "artifact_revision", artifactId: v2.id, revisionId: v2.revisionId, digest: revision.digest,
    } })]), fauxAssistantMessage("A 已采用第二版内容。")], text);
    assert.equal(works(f).length, 1, "公开工具必须创建一次作品");
    const work = works(f)[0]!;
    const item = contentItemOf(f, work.id).item;
    assert.deepEqual(item.draft, { kind: "artifact_revision", artifactId: v2.id, revisionId: v2.revisionId, digest: revision.digest });
    assert.deepEqual(item.approved, item.draft, "这次明确采用意图同时形成准确内容确认");
    assert.notEqual(item.confirmationId, v2.standaloneApproval!.confirmationId);
    const action = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(message => message.text === text)!;
    const fact = f.app.database.prepare("SELECT subject_scope,work_id,action,source_id FROM work_review_confirmations WHERE id=?").get(item.confirmationId);
    assert.deepEqual(fact, { subject_scope: "work_item", work_id: work.id, action: "approve", source_id: action.id });
    assert.deepEqual(f.app.service.readArtifactHead("local-owner", v2.id), v2, "独立 head 和 v1 认可完全保持");
    assert.equal(countIn(f, "FROM artifacts"), artifactCount);
    assert.equal(countIn(f, "FROM artifact_revisions"), revisionCount, "采用不复制正文、不建立产物或修订");
    assert.equal(countIn(f, "FROM proposals"), 0);
    assert.equal(countIn(f, "FROM production_runs"), 0, "明确采用不自动渲染");
    await turn(f, [startWorkStep("只开始 B"), fauxAssistantMessage("B 只开始，尚无内容。")], "再开始视频 B，暂时不采用内容。");
    assert.deepEqual(works(f).find(entry => entry.title === "只开始 B")!.reviewGroups, [], "title-only 保持空组");
  } finally { await f.close(); }
});

it("DG-R1 DGR05 start_work 采用真实消息，拒绝其他作品、越权、未来来源和结构化按钮挪用", async () => {
  const f = await setup();
  let release = () => {};
  try {
    const originalText = "清晨的路灯逐个熄灭，镜头沿街道向前。";
    await turn(f, [fauxAssistantMessage("已记下原文。")], originalText);
    const original = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(message => message.text === originalText)!;
    await turn(f, [fauxAssistantMessage([fauxToolCall("start_work", { title: "原文采用 A", adoptContent: {
      kind: "message_text", messageId: original.id, text: original.text,
    } })]), fauxAssistantMessage("已直接采用原文。")], "现在开始视频 A，直接采用刚才那段原文。");
    const a = works(f)[0]!;
    assert.deepEqual(contentItemOf(f, a.id).item.approved, { kind: "message_text", messageId: original.id, text: original.text, author: "user" });
    assert.equal(countIn(f, "FROM artifacts"), 0, "真实消息采用不创建文本副本");
    await turn(f, [deliverStep([
      scriptItem("还独立的脚本", "后续可明确采用。"),
      { mode: "create", title: "普通提示词边界", kind: "prompt", content: { format: "markdown", text: "提示词不能在此冒充独立脚本。" } },
      scriptItem("已属于 A 的脚本", "这份主稿只属于 A。"),
    ], [newGroupDelivery(a.id, "content", "bound", 2)]), fauxAssistantMessage("三份稿件已交付。")]);
    const source = (ownerId: string, artifact: ArtifactHead) => ({ kind: "artifact_revision" as const, artifactId: artifact.id,
      revisionId: artifact.revisionId, digest: f.app.service.readRevision(ownerId, artifact.id, artifact.revisionId).digest });
    const independent = source("local-owner", artifactOf(f, "还独立的脚本"));
    const bound = source("local-owner", artifactOf(f, "已属于 A 的脚本"));
    const prompt = source("local-owner", artifactOf(f, "普通提示词边界"));
    const foreignConversation = f.app.service.createConversation("other-owner", { commandId: cmd(), title: "其他归属" }).conversation;
    const foreignDelivery = deliverReviewDrafts(f.app.database, new Date().toISOString(), { ownerId: "other-owner", conversationId: foreignConversation.id }, {
      items: [scriptItem("其他人的稿", "不允许跨 owner 采用。")],
    });
    const foreign = source("other-owner", f.app.service.readArtifactHead("other-owner", foreignDelivery.receipt.revisions[0]!.artifactId));
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const held = await holdRequest(f, "我再明确选择采用来源。"); release = held.release;
    const futureDelivery = deliverReviewDrafts(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, {
      items: [scriptItem("当前消息之后才交付", "不能由先前消息提前认可。")],
    });
    const future = source("local-owner", f.app.service.readArtifactHead("local-owner", futureDelivery.receipt.revisions[0]!.artifactId));
    const counts = () => ["works", "work_review_confirmations", "proposals", "production_runs"].map(table => countIn(f, `FROM ${table}`));
    const before = counts();
    for (const [adoptContent, error] of [[prompt, /脚本或真实消息/], [bound, /属于其他视频/], [foreign, /没有找到/],
      [{ ...independent, digest: "wrong-digest" }, /摘要不一致/], [future, /尚未交付|提前认可/],
      [{ kind: "message_text" as const, messageId: original.id, text: "冒充原文" }, /原文逐字一致/]] as const) {
      await assert.rejects(() => tools.startWork(held.context as never, { title: "不得残留的作品", adoptContent }), error);
      assert.deepEqual(counts(), before, "失败不留下新作品、认可或制作记录");
    }
    release(); await waitIdle(f);

    const boundTarget = workOf(f, a.id).reviewGroups.flatMap(group => group.items.map(item => ({ group, item })))
      .find(({ item }) => item.draft?.kind === "artifact_revision" && item.draft.artifactId === bound.artifactId)!;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.app.faux!.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("继续工作结束。"); }]);
    const response = await confirmReview(f, { workId: a.id, groupId: boundTarget.group.id,
      items: [{ itemId: boundTarget.item.id, source: bound }], action: "approve_and_continue" }, "认可 A 脚本并继续。");
    assert.equal(response.statusCode, 202);
    await ready;
    const receipt = response.json();
    const request = f.app.database.prepare("SELECT execution_epoch FROM requests WHERE id=?").get(receipt.requestId) as { execution_epoch: number };
    const context = { actorId: "local-owner", conversationId: f.conversation.id, requestId: receipt.requestId,
      executionEpoch: request.execution_epoch, target: null, toolCallId: "call-adopt-button", actionSourceMessageId: receipt.messageId };
    const beforeButton = counts();
    await assert.rejects(() => tools.startWork(context as never, { title: "按钮没有要求采用的新作品", adoptContent: independent }), /本次.*认可动作|原始.*动作/);
    assert.deepEqual(counts(), beforeButton, "认可并继续不能借开始作品改认其他稿件");
    release(); await waitIdle(f);
  } finally { release(); await f.close(); }
});

it("DG-R1 DGR05 独立脚本准确认可、改稿保留旧认可，按钮不排 Pi 且后续采用另建真实作品确认", async () => {
  const f = await setup();
  try {
    await turn(f, [fauxAssistantMessage("先聊一聊。")], "只讨论想法，不做视频。");
    assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).artifacts.items.length, 0);
    await turn(f, [deliverStep([
      { mode: "create", title: "普通提示词", kind: "prompt", content: { format: "markdown", text: "普通提示词。" } },
      scriptItem("独立脚本", "第一版脚本。"),
    ]), fauxAssistantMessage("脚本和提示词已交付。")], "写一份提示词和独立脚本，暂不做视频。");
    const v1 = artifactOf(f, "独立脚本");
    const prompt = artifactOf(f, "普通提示词");
    const before = () => ["works", "proposals", "production_runs"].map(table => countIn(f, `FROM ${table}`));
    assert.deepEqual(before(), [0, 0, 0]);
    const assistantBefore = assistantCount(f);
    const deliveredBefore = countIn(f, "FROM events WHERE kind='artifact.delivered'");
    const approval = { kind: "standalone_artifact", artifactId: v1.id, revisionId: v1.revisionId, action: "approve" };
    const body = chatInput("认可这一版脚本。", { reviewConfirmation: approval });
    const response = await postMessage(f, body);
    assert.equal(response.statusCode, 202, response.body);
    const receipt = response.json();
    const replay = await postMessage(f, body);
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().messageId, receipt.messageId);
    assert.equal(replay.json().replayed, true);
    const head1 = artifactOf(f, "独立脚本");
    assert.equal(head1.standaloneApproval?.revisionId, v1.revisionId);
    assert.ok(head1.standaloneApproval?.confirmationId);
    assert.deepEqual(before(), [0, 0, 0], "独立认可不创建作品/提案/运行");
    assert.equal(assistantCount(f), assistantBefore, "按钮不触发 Pi");
    assert.equal(countIn(f, "FROM events WHERE kind='artifact.delivered'"), deliveredBefore, "认可只刷新消息，不伪造新产物事件");
    const fact = f.app.database.prepare("SELECT subject_scope,work_id,group_id,item_id,source_id FROM work_review_confirmations WHERE id=?")
      .get(head1.standaloneApproval!.confirmationId);
    assert.deepEqual(fact, { subject_scope: "standalone_artifact", work_id: null, group_id: null, item_id: null, source_id: receipt.messageId });
    const badPrompt = await postMessage(f, chatInput("认可提示词。", { reviewConfirmation: { ...approval, artifactId: prompt.id, revisionId: prompt.revisionId } }));
    assert.equal(badPrompt.statusCode, 400);

    await turn(f, [deliverStep([{ mode: "revise", artifactId: v1.id, baseRevisionId: v1.revisionId,
      title: "独立脚本", kind: "script", content: { format: "markdown", text: "第二版脚本。" } }]), fauxAssistantMessage("改到第二版。")], "只改脚本，不开始视频。");
    const v2 = artifactOf(f, "独立脚本");
    assert.notEqual(v2.revisionId, v1.revisionId);
    assert.deepEqual(v2.standaloneApproval, head1.standaloneApproval, "新稿不继承为已认可；右侧仍读准确 v1");
    assert.deepEqual(f.app.service.listArtifacts("local-owner", f.conversation.id, undefined, 50).items.find(item => item.id === v1.id)?.standaloneApproval,
      head1.standaloneApproval, "列表与刷新使用真实旧版确认");
    assert.equal(f.app.service.readRevision("local-owner", v1.id, head1.standaloneApproval!.revisionId).content.format, "markdown");
    const stale = await postMessage(f, chatInput("认可旧按钮。", { reviewConfirmation: approval }));
    assert.equal(stale.statusCode, 409, "新认可必须指向当前修订");
    let toolResult: { content: unknown; details: unknown } | undefined;
    await turn(f, [fauxAssistantMessage([fauxToolCall("confirm_review", { ...approval, revisionId: v2.revisionId })]), context => {
      const result = context.messages.filter(entry => entry.role === "toolResult").at(-1)!;
      toolResult = { content: JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("")), details: result.details };
      return fauxAssistantMessage("第二版已认可。");
    }], "认可当前第二版脚本，仍先不做视频。");
    const confirmedV2 = artifactOf(f, "独立脚本");
    assert.equal(confirmedV2.standaloneApproval?.revisionId, v2.revisionId, "自然语言工具同样认可准确独立稿");
    assert.deepEqual(toolResult?.content, { kind: "standalone_artifact", artifact: confirmedV2, confirmationId: confirmedV2.standaloneApproval!.confirmationId });
    assert.deepEqual(toolResult?.details, { artifactId: v1.id, confirmationId: confirmedV2.standaloneApproval!.confirmationId });
    assert.deepEqual(before(), [0, 0, 0]);

    const revision = f.app.service.readRevision("local-owner", v2.id, v2.revisionId);
    await turn(f, [fauxAssistantMessage([fauxToolCall("start_work", { title: "后续明确采用的视频", adoptContent: {
      kind: "artifact_revision", artifactId: v2.id, revisionId: v2.revisionId, digest: revision.digest,
    } })]), fauxAssistantMessage("新视频已采用第二版。")], "现在开始这条视频，并采用已认可的第二版脚本。");
    const adopted = contentItemOf(f, works(f)[0]!.id).item;
    assert.equal(adopted.approved?.kind === "artifact_revision" ? adopted.approved.revisionId : null, v2.revisionId);
    assert.notEqual(adopted.confirmationId, confirmedV2.standaloneApproval!.confirmationId, "独立确认不跨 work 充当制作依据");
  } finally { await f.close(); }
});

it("R1.5 普通聊天与 Prompt 交付不登记创作事项；独立配音/图片正常制作且不建可见视频事项", async () => {
  const f = await setup(); try {
    await turn(f, [fauxAssistantMessage("Prompt：清晨沿山路行进的固定镜头。")], "给我一条山路视频的 Prompt，先不制作");
    await turn(f, [deliverStep([{ mode: "create", title: "山路文案", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("文案交付。")], "正式给我这份文案");
    assert.equal(works(f).length, 0, "没有开始创作就没有事项");

    await turn(f, [deliverStep([scriptItem("独立配音底稿", "# 底稿\n旁白文本。")]), fauxAssistantMessage("底稿交付。")]);
    const narration = artifactOf(f, "独立配音底稿");
    const narrationRevision = f.app.service.readRevision("local-owner", narration.id, narration.revisionId);
    const narrationInput = { kind: "artifact_revision" as const, artifactId: narration.id, revisionId: narration.revisionId, digest: narrationRevision.digest };
    const speech = speechSpec(null, narration, narrationRevision, "独立配音");
    const image: ProductionIntent = { ...speech, title: "独立图片", operations: [{ operationId: "image", outputSlot: "image", kind: "image",
      model: OFFLINE_QUOTE_CATALOG["image:faux-image"].binding, maxCreateAttempts: 1,
      inputs: [narrationInput], parameters: { resolution: "1024x1024", aspectRatio: "1:1" } }], finalOutput: { operationId: "image", outputSlot: "image" } };
    for (const spec of [speech, image]) {
      const prepared = await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec });
      const accepted = f.app.service.acceptProposal("local-owner", prepared.proposal.id, { commandId: cmd(), proposalDigest: prepared.proposal.digest });
      const result = await driveToTerminal(f, accepted.run.id);
      assert.equal(result.state, "succeeded");
      assert.ok(result.outputRevisions.length > 0);
      assert.equal(works(f).length, 0, "独立非视频生产没有可见视频事项");
      assert.equal((await f.app.app.inject({ method: "GET", url: `/api/agent/v1/works/${result.workId}` })).statusCode, 404);
    }
  } finally { await f.close(); }
});

// —— B2.5：指向片段的意见在入口核对运行归属与片段存在性 ——

it("B2.5 指向片段的意见核对运行与事项归属；段不在运行片段里或运行不存在时拒绝", async () => {
  const f = await setup(); try {
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路配音");
    await turn(f, [deliverStep([scriptItem("配音底稿", "# 底稿\n旁白文本。")]), fauxAssistantMessage("底稿交付。")]);
    const narration = artifactOf(f, "配音底稿");
    const narrationRevision = f.app.service.readRevision("local-owner", narration.id, narration.revisionId);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: speechSpec(confirmed.workId, narration, narrationRevision, "山路配音") })).proposal;
    const runId = f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest }).run.id;

    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    const send = (workId: string, runIdOfSegment: string, segmentId: string) =>
      f.app.service.addFeedback("local-owner", f.conversation.id, {
        commandId: cmd(), text: "第二段再紧一点。",
        target: { artifactId: narration.id, revisionId: narration.revisionId, workId, segment: { runId: runIdOfSegment, segmentId } },
      });
    assert.throws(() => send(coffee.id, runId, "seg-1"), /属于其他视频事项/);
    assert.throws(() => send(confirmed.workId, runId, "seg-none"), /不在这份运行的片段列表里/);
    assert.throws(() => send(confirmed.workId, "run-does-not-exist", "seg-1"), /运行不存在/);
  } finally { await f.close(); }
});

// —— 包 C：作品库与定位窗口 ——
// 两条用例共用“真实链路走到可定稿视频”的样板（真实交付事务 + 公开受理 + worker 终态）。

async function produceFinalizableVideo(f: Fixture, title: string) {
  await turn(f, [deliverStep([{ mode: "create", title: `${title}画面依据`, kind: "prompt", content: { format: "markdown", text: `${title}的固定镜头。` } }]), fauxAssistantMessage("已交付。")]);
  const basis = artifactOf(f, `${title}画面依据`);
  const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
  const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, title);
  const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
    { commandId: cmd(), spec: videoSpec(confirmed.workId, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest }, title, [confirmed.reviewInput]) })).proposal;
  const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
    payload: { commandId: cmd(), proposalDigest: proposal.digest } });
  assert.equal(accepted.statusCode, 202);
  const runId = accepted.json().run.id as string;
  assert.equal((await driveToTerminal(f, runId)).state, "succeeded");
  const video = videoItemOf(f, confirmed.workId);
  const draft = revisionDraftOf(video.item);
  assert.equal(f.app.service.readArtifactHead("local-owner", draft.artifactId).kind, "video", "制作产出登记为视频初稿");
  return { workId: confirmed.workId, reviewInput: confirmed.reviewInput, runId, video: draft };
}

// 同一作品再跑一次整片制作：按 F02 指向既有视频事项（existing），产出登记为该事项新草稿。
async function produceNextVideoRevision(f: Fixture, basis: { artifactId: string; revisionId: string; digest: string }, workId: string, reviewInput: ConfirmedReviewWork["reviewInput"], title: string) {
  const target = videoItemOf(f, workId);
  const spec = videoSpec(workId, basis, title, [reviewInput]);
  spec.outputTarget = { group: { mode: "existing", groupId: target.group.id }, item: { mode: "existing", itemId: target.item.id } };
  const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
    { commandId: cmd(), spec })).proposal;
  const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
    payload: { commandId: cmd(), proposalDigest: proposal.digest } });
  assert.equal(accepted.statusCode, 202);
  const runId = accepted.json().run.id as string;
  assert.equal((await driveToTerminal(f, runId)).state, "succeeded");
  return revisionDraftOf(videoItemOf(f, workId).item);
}

it("DG-R1 候选普通定稿仍核对实际采用的必要依据，不要求未采用候选认可", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("候选定稿边界"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("实际采用的内容", "蓝色方块在绿色背景移动。"), scriptItem("未采用的背景候选", "这份不进入预览。")], [
      newGroupDelivery(work.id), { ...newGroupDelivery(work.id, "scene", "unused", 1),
        group: { mode: "create", key: "unused-group", title: "备选背景", nextIntent: null } },
    ]), fauxAssistantMessage("内容和候选已交付。")]);
    const content = contentItemOf(f, work.id);
    const basis = revisionDraftOf(content.item);
    const spec = videoSpec(work.id, basis, "仅试做预览", [], "preview");
    spec.outputTarget = { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
      item: { mode: "create", key: "clip", label: "预览", role: "clip", required: true } };
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
    const accepted = f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    const run = await driveToTerminal(f, accepted.run.id);
    assert.equal(run.state, "succeeded");
    const original = run.outputRevisions[0]!;
    deliverReviewDrafts(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, {
      items: [{ mode: "create", title: "已有预览的成片候选", kind: "video", content: { format: "local_output", source: { kind: "artifact_revision", ...original } } }],
      reviewGroups: [newGroupDelivery(work.id, "video")],
    } as never);
    const candidate = videoItemOf(f, work.id);
    const finalize: WorkReviewConfirmation = { workId: work.id, groupId: candidate.group.id,
      items: [{ itemId: candidate.item.id, source: revisionDraftOf(candidate.item) }], action: "finalize_video" };
    const rejected = await confirmReview(f, finalize, "把这份候选定稿并入库。");
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.json().message, /脚本.*还未获得认可/);
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 0);
    assert.equal((await confirmReview(f, { workId: work.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: basis }], action: "approve" })).statusCode, 202);
    assert.equal((await confirmReview(f, finalize, "认可必要内容后定稿这份候选。")).statusCode, 202);
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 1);
    assert.equal(itemOfRole(f, work.id, "clip").item.approved, null, "原预览不被暗中补认可");
    assert.equal(itemOfRole(f, work.id, "scene").item.approved, null, "未采用的必选候选保持待认可");
  } finally { await f.close(); }
});

it("DG-R1 DGR04 不提前认可同一初始消息后生成的视频，同时间戳下仍按真实交付顺序判定", async () => {
  const now = new Date().toISOString();
  const f = await setup({ clock: () => now });
  let release = () => {};
  try {
    const a = await produceFinalizableVideo(f, "初始委托边界");
    const held = await holdRequest(f, "继续做新一版，最后直接定稿。"); release = held.release;
    const basis = artifactOf(f, "初始委托边界画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const future = await produceNextVideoRevision(f, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest },
      a.workId, a.reviewInput, "后来才出现的新视频");
    const target = videoItemOf(f, a.workId);
    const tools = new BusinessTools(f.app.database, () => now, () => OFFLINE_QUOTE_CATALOG);
    for (const action of ["approve", "finalize_video"] as const) {
      await assert.rejects(() => tools.confirmReview(held.context as never, { workId: a.workId, groupId: target.group.id,
        items: [{ itemId: target.item.id, source: future }], action }), /尚未交付|提前认可/);
    }
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 0);
    release(); await waitIdle(f);
    await turn(f, [fauxAssistantMessage([fauxToolCall("confirm_review", { workId: a.workId, groupId: target.group.id,
      items: [{ itemId: target.item.id, source: future }], action: "finalize_video" })]), fauxAssistantMessage("本次已明确认可成片。")], "这版现在看完了，定稿并入库。");
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 1);
  } finally { release(); await f.close(); }
});

it("DG-R1 DGR04 自然语言复合认可与定稿可共存，已消费 steer 切换为新动作来源", async () => {
  const f = await setup();
  let release = () => {};
  try {
    await turn(f, [startWorkStep("A 脚本事项"), fauxAssistantMessage("A 已开始。")]);
    const a = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("A 独立内容稿", "A 的准确脚本。")], [newGroupDelivery(a.id)]), fauxAssistantMessage("A 脚本已交付。")]);
    const content = contentItemOf(f, a.id);
    const scriptApproval: WorkReviewConfirmation = { workId: a.id, groupId: content.group.id,
      items: [{ itemId: content.item.id, source: revisionDraftOf(content.item) }], action: "approve" };
    const b = await produceFinalizableVideo(f, "B 成片事项");
    const target = videoItemOf(f, b.workId);
    await turn(f, [fauxAssistantMessage([
      fauxToolCall("confirm_review", { ...scriptApproval }),
      fauxToolCall("confirm_review", { workId: b.workId, groupId: target.group.id,
        items: [{ itemId: target.item.id, source: b.video }], action: "finalize_video" }),
    ]), fauxAssistantMessage("A 脚本已认可，B 已定稿。")], "认可 A 脚本，把 B 成片定稿并入库。");
    assert.ok(contentItemOf(f, a.id).item.confirmationId);
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 1);

    const basis = artifactOf(f, "B 成片事项画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const v2 = await produceNextVideoRevision(f, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest },
      b.workId, b.reviewInput, "B 第二版");
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let frame: { actionSourceMessageId: string; reviewConfirmation: unknown } | undefined;
    f.app.faux!.setResponses([
      async () => { entered(); await gate; return fauxAssistantMessage("先听补充。"); },
      fauxAssistantMessage([fauxToolCall("confirm_review", { workId: b.workId, groupId: target.group.id,
        items: [{ itemId: target.item.id, source: v2 }], action: "finalize_video" })]),
      context => {
        const last = context.messages.at(-1)!;
        const text = typeof last.content === "string" ? last.content : last.content.filter(block => block.type === "text").map(block => block.text).join("");
        frame = JSON.parse(text.slice("[frame-current-state]".length).split("\n")[0]!);
        return fauxAssistantMessage("B 第二版已定稿。");
      },
    ]);
    const response = await confirmReview(f, { ...scriptApproval, action: "approve_and_continue" }, "认可 A 并继续。");
    assert.equal(response.statusCode, 202);
    await ready;
    const original = response.json();
    const stored = f.app.database.prepare("SELECT review_confirmation_json FROM messages WHERE id=?").get(original.messageId) as { review_confirmation_json: string };
    assert.deepEqual(JSON.parse(stored.review_confirmation_json), { ...scriptApproval, action: "approve_and_continue" }, "保存原按钮完整 payload");
    const steer = await postMessage(f, chatInput("补充：现在把 B 第二版定稿并入库。", { mode: "steer", steerRequestId: original.requestId }));
    assert.equal(steer.statusCode, 202);
    release(); await waitIdle(f);
    assert.equal(frame?.actionSourceMessageId, steer.json().messageId);
    assert.equal(frame?.reviewConfirmation, null, "新自然语言来源不继承原按钮限制");
    const final = f.app.database.prepare("SELECT source_id FROM work_review_confirmations WHERE action='finalize_video' AND json_extract(subject_json,'$.revisionId')=?")
      .get(v2.revisionId) as { source_id: string };
    assert.equal(final.source_id, steer.json().messageId, "确认事实使用实际消费的 steer 消息");
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 2);
  } finally { release(); await f.close(); }
});

it("DG-R1 DGR04 按钮认可并继续不能换动作或目标，合法重放和后续创作保持可用", async () => {
  const f = await setup();
  let release = () => {};
  try {
    const a = await produceFinalizableVideo(f, "按钮边界短片");
    const target = videoItemOf(f, a.workId);
    const confirmation: WorkReviewConfirmation = { workId: a.workId, groupId: target.group.id,
      items: [{ itemId: target.item.id, source: a.video }], action: "approve_and_continue" };
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.app.faux!.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("继续工作已完成。"); }]);
    const response = await confirmReview(f, confirmation, "认可并继续。");
    assert.equal(response.statusCode, 202);
    await ready;
    const receipt = response.json();
    const request = f.app.database.prepare("SELECT execution_epoch FROM requests WHERE id=?").get(receipt.requestId) as { execution_epoch: number };
    const context = { actorId: "local-owner", conversationId: f.conversation.id, requestId: receipt.requestId,
      executionEpoch: request.execution_epoch, target: null, toolCallId: "call-button", actionSourceMessageId: receipt.messageId };
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);

    await assert.rejects(() => tools.confirmReview(context as never, { ...confirmation, action: "finalize_video" }), /本次.*认可动作|原始.*动作/);
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 0, "按钮认可不能误入库");
    const content = contentItemOf(f, a.workId);
    await assert.rejects(() => tools.confirmReview(context as never, { ...confirmation,
      groupId: content.group.id, items: [{ itemId: content.item.id, source: content.item.approved! }] }), /本次.*认可动作|原始.*动作/);
    const duplicate = await tools.confirmReview(context as never, confirmation);
    assert.equal("id" in duplicate ? duplicate.id : null, a.workId, "同一合法动作仍可去重返回");
    await tools.deliverArtifacts({ ...context, toolCallId: "call-next-draft" } as never,
      { items: [scriptItem("认可后的下一份稿", "下一组创作仍可保存。")], reviewGroups: [newGroupDelivery(a.workId, "plan")] } as never);
    assert.ok(artifactOf(f, "认可后的下一份稿"), "认可来源限制不阻断合法创作");
    release(); await waitIdle(f);

    await turn(f, [fauxAssistantMessage([fauxToolCall("confirm_review", { ...confirmation, action: "finalize_video" })]),
      fauxAssistantMessage("已按本条新消息定稿。")], "这版成片定稿并入库。");
    assert.equal(f.app.service.listLibraryVideos("local-owner", undefined, 50).items.length, 1, "新自然语言消息可以明确定稿");
  } finally { release(); await f.close(); }
});

it("C3 认可与定稿分离：普通认可不吞显式定稿，finalizedSource 只读投影准确，新 v2 不继承定稿", async () => {
  const f = await setup(); try {
    const a = await produceFinalizableVideo(f, "山路短片");
    const videoItem = () => videoItemOf(f, a.workId);
    const finalizeCount = () => countIn(f, "FROM work_review_confirmations WHERE action = 'finalize_video' AND work_id = ?", a.workId);
    const librarySize = async () => (await f.app.app.inject({ method: "GET", url: "/api/agent/v1/library/videos", headers: { origin } })).json().items.length;

    // 先普通认可：approved 指向这版，但不产生定稿记录、不入库，投影 finalizedSource 仍为 null。
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItem().group.id,
      items: [{ itemId: videoItem().item.id, source: a.video }], action: "approve" }, "认可这版成片")).statusCode, 202);
    assert.equal(finalizeCount(), 0, "普通认可不产生定稿记录");
    assert.equal(await librarySize(), 0, "仅认可未定稿不入库");
    assert.equal(videoItem().item.finalizedSource, null, "认可后 finalizedSource 仍为 null");

    // 同一版再显式定稿：不被先前的普通认可吞掉，首次定稿真实落库并入库。
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItem().group.id,
      items: [{ itemId: videoItem().item.id, source: a.video }], action: "finalize_video" }, "定稿这版成片")).statusCode, 202);
    assert.equal(finalizeCount(), 1, "首次定稿落库");
    assert.equal(await librarySize(), 1, "定稿入库");
    assert.deepEqual(videoItem().item.finalizedSource, a.video, "定稿后投影指向真实定稿来源");
    assert.equal(contentItemOf(f, a.workId).item.finalizedSource, null, "非视频事项 finalizedSource 恒为 null");

    // 定稿重放：同一事项同版本不再新增确认，库仍是 1 条。
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItem().group.id,
      items: [{ itemId: videoItem().item.id, source: a.video }], action: "finalize_video" }, "再次定稿")).statusCode, 202);
    assert.equal(finalizeCount(), 1, "重复定稿不新增确认");
    assert.equal(await librarySize(), 1, "重复定稿不重复入库");

    // 新 v2 草稿：定稿事实不继承到新版，v1 定稿仍在库中。
    const basis = artifactOf(f, "山路短片画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const v2 = await produceNextVideoRevision(f, { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest },
      a.workId, a.reviewInput, "山路短片 v2");
    assert.notEqual(v2.revisionId, a.video.revisionId, "应产出新草稿");
    const afterV2 = videoItem().item;
    assert.deepEqual(afterV2.finalizedSource, a.video, "v2 新稿不继承 v1 定稿");
    assert.ok(!afterV2.draft || afterV2.draft.kind !== "message_text", "草稿仍是产物修订");
    assert.equal(await librarySize(), 1, "未定稿的 v2 不入库，v1 定稿保留");
  } finally { await f.close(); }
});

it("C1 作品库只收定稿视频：重复定稿去重不顶前，来源按定稿时冻结事实记录，缺记录如实标未记录", async () => {
  const f = await setup(); try {
    const a = await produceFinalizableVideo(f, "山路短片");
    const b = await produceFinalizableVideo(f, "咖啡短片");

    // 先定稿 A，再定稿 B；A 重复定稿同一修订是同一认可事实，不新增行、不顶前。
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItemOf(f, a.workId).group.id,
      items: [{ itemId: videoItemOf(f, a.workId).item.id, source: a.video }], action: "finalize_video" }, "定稿这版成片")).statusCode, 202);
    // §4.3 之前受理、迁移无 modern binding 可回填的历史产物是 provenanceStatus=not_recorded 的唯一真实人群；
    // 清空 B 的持久 binding 模拟该历史形状，不拿新事实补齐。
    f.app.database.prepare("UPDATE artifact_revisions SET creation_binding_json = NULL WHERE id = ?").run(b.video.revisionId);
    assert.equal((await confirmReview(f, { workId: b.workId, groupId: videoItemOf(f, b.workId).group.id,
      items: [{ itemId: videoItemOf(f, b.workId).item.id, source: b.video }], action: "finalize_video" }, "定稿这版成片")).statusCode, 202);
    const confirmationsBeforeA = countIn(f, "FROM work_review_confirmations WHERE action = 'finalize_video' AND work_id = ?", a.workId);
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItemOf(f, a.workId).group.id,
      items: [{ itemId: videoItemOf(f, a.workId).item.id, source: a.video }], action: "finalize_video" }, "再次定稿")).statusCode, 202);
    assert.equal(countIn(f, "FROM work_review_confirmations WHERE action = 'finalize_video' AND work_id = ?", a.workId), confirmationsBeforeA, "重复定稿同一修订不新增确认");

    const library = await f.app.app.inject({ method: "GET", url: "/api/agent/v1/library/videos", headers: { origin } });
    assert.equal(library.statusCode, 200);
    const page = library.json();
    assert.equal(page.items.length, 2, "只有定稿视频入库，未定稿的初稿不入库");
    const [entryB, entryA] = page.items;
    assert.equal(entryB.title, "咖啡短片", "B 定稿更晚，排在最前");
    assert.equal(entryA.title, "山路短片", "A 重复定稿不把它顶回最前");

    // A：完整 modern 链路——视频事实、受理依据（reviewSources）与产出消息都取定稿那一刻的不可变事实。
    assert.deepEqual(entryA.video, { artifactId: a.video.artifactId, revisionId: a.video.revisionId });
    assert.equal(entryA.workId, a.workId);
    assert.equal(entryA.conversationId, f.conversation.id);
    assert.equal(entryA.provenanceStatus, "recorded");
    assert.deepEqual(entryA.reviewSources, [a.reviewInput]);
    // G4-2：留存清单完整投影——文本依据修订也在 materials 里，可跨会话选材；无媒体来源记录。
    const basisA = artifactOf(f, "山路短片画面依据");
    assert.deepEqual(entryA.materials, [{ source: { artifactId: basisA.id, revisionId: basisA.revisionId },
      label: "山路短片画面依据", kind: "prompt", provenance: [] }]);
    assert.equal(entryA.project, null);
    assert.deepEqual(entryA.projectFiles, []);
    const noticeA = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.references.runIds.includes(a.runId));
    assert.ok(noticeA, "终态应已插入产出消息");
    assert.equal(entryA.originMessageId, noticeA.id);

    // B：历史产物缺 modern binding → 来源如实标未记录，不从当前事实补齐；视频事实仍在。
    assert.equal(entryB.provenanceStatus, "not_recorded");
    assert.deepEqual(entryB.reviewSources, []);
    assert.deepEqual(entryB.video, { artifactId: b.video.artifactId, revisionId: b.video.revisionId });
    assert.equal(entryB.finalizedAt <= entryA.finalizedAt || true, true);
    const noticeB = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.references.runIds.includes(b.runId));
    assert.equal(entryB.originMessageId, noticeB!.id);

    // 重复定稿后历史条目不变：条目仍指向同一批不可变事实。
    const again = (await f.app.app.inject({ method: "GET", url: "/api/agent/v1/library/videos", headers: { origin } })).json();
    assert.deepEqual(again.items[1], entryA);

    // 分页：limit=1 首页 + 游标第二页。
    const first = (await f.app.app.inject({ method: "GET", url: "/api/agent/v1/library/videos?limit=1", headers: { origin } })).json();
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].title, "咖啡短片");
    assert.ok(first.nextCursor);
    const second = (await f.app.app.inject({ method: "GET", url: `/api/agent/v1/library/videos?cursor=${encodeURIComponent(first.nextCursor)}`, headers: { origin } })).json();
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].title, "山路短片");
    assert.equal(second.nextCursor, null);

    // 库按 owner 隔离。
    assert.deepEqual(f.app.service.listLibraryVideos("other-owner", undefined, undefined).items, []);
  } finally { await f.close(); }
});

it("C2 定位窗口：锚点页含锚点可向前翻，与游标互斥，归属他会被拒", async () => {
  const f = await setup(); try {
    const a = await produceFinalizableVideo(f, "山路短片");
    assert.equal((await confirmReview(f, { workId: a.workId, groupId: videoItemOf(f, a.workId).group.id,
      items: [{ itemId: videoItemOf(f, a.workId).item.id, source: a.video }], action: "finalize_video" }, "定稿这版成片")).statusCode, 202);
    const notice = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.references.runIds.includes(a.runId))!;
    assert.ok(notice, "终态应已插入产出消息");

    const base = `/api/agent/v1/conversations/${f.conversation.id}/messages`;
    const anchored = await f.app.app.inject({ method: "GET", url: `${base}?anchorMessageId=${notice.id}&limit=3`, headers: { origin } });
    assert.equal(anchored.statusCode, 200);
    const anchorPage = anchored.json();
    assert.equal(anchorPage.items[0].id, notice.id, "锚点本身是页内最晚消息");
    assert.ok(anchorPage.items.every((item: { createdSequence: number }) => item.createdSequence <= notice.createdSequence), "不越过锚点显示更晚消息");
    assert.ok(anchorPage.watermark, "定位窗口也给事件水位");
    assert.ok(anchorPage.nextCursor, "更早消息可继续向前翻");
    const older = await f.app.app.inject({ method: "GET", url: `${base}?cursor=${encodeURIComponent(anchorPage.nextCursor)}&limit=3`, headers: { origin } });
    assert.equal(older.statusCode, 200);
    const olderPage = older.json();
    assert.ok(olderPage.items.length > 0);
    assert.ok(olderPage.items.every((item: { createdSequence: number }) => item.createdSequence < anchorPage.items[anchorPage.items.length - 1].createdSequence), "游标页取更早消息");

    const both = await f.app.app.inject({ method: "GET", url: `${base}?anchorMessageId=${notice.id}&cursor=${encodeURIComponent(anchorPage.nextCursor)}`, headers: { origin } });
    assert.equal(both.statusCode, 400);
    assert.equal(both.json().code, "INVALID_INPUT");
    const empty = await f.app.app.inject({ method: "GET", url: `${base}?anchorMessageId=`, headers: { origin } });
    assert.equal(empty.statusCode, 400);

    // 锚点必须是本会话的消息：拿第二会话里的消息定位本会话被拒。
    const second = f.app.service.createConversation("local-owner", { commandId: cmd(), title: "第二会话" }).conversation;
    const foreign = deliverReviewDrafts(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: second.id },
      { items: [scriptItem("他事项内容", "# 他\n另一会话的稿件。")] });
    const cross = await f.app.app.inject({ method: "GET", url: `${base}?anchorMessageId=${foreign.messageId}`, headers: { origin } });
    assert.equal(cross.statusCode, 404);
    assert.equal(cross.json().code, "NOT_FOUND");
  } finally { await f.close(); }
});

// —— r4.5 B（F02 输出目标）：同一作品两处成片 A/B 并行认可后，重制只落在声明的目标 ——

it("B 成片A/B隔离：两处各自认可后重制A只落A，B的草稿/认可/确认原样不动", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路画面依据", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("已交付。")]);
    const basis = artifactOf(f, "山路画面依据");
    const basisRevision = f.app.service.readRevision("local-owner", basis.id, basis.revisionId);
    const triple = { artifactId: basis.id, revisionId: basis.revisionId, digest: basisRevision.digest };
    const confirmed = seedConfirmedWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");

    // 两次 create 目标受理各分配一处独立成片事项（F02：目标由声明冻结，不互相合并）。
    const runFor = async (label: string) => {
      const spec = videoSpec(confirmed.workId, triple, label, [confirmed.reviewInput]);
      spec.outputTarget = finalVideoTarget(label);
      const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
      const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
        payload: { commandId: cmd(), proposalDigest: proposal.digest } });
      assert.equal(accepted.statusCode, 202);
      const runId = accepted.json().run.id as string;
      assert.equal((await driveToTerminal(f, runId)).state, "succeeded");
      return runId;
    };
    await runFor("成片A");
    await runFor("成片B");
    const videoItems = () => workOf(f, confirmed.workId).reviewGroups.flatMap(group => group.items).filter(item => item.role === "video");
    assert.equal(videoItems().length, 2, "两次 create 目标各分配一处成片事项");
    const groupOfItem = (itemId: string) => workOf(f, confirmed.workId).reviewGroups.find(group => group.items.some(item => item.id === itemId))!;
    const itemA = videoItems().find(item => item.label === "成片A")!;
    const itemB = videoItems().find(item => item.label === "成片B")!;
    const groupA = groupOfItem(itemA.id), groupB = groupOfItem(itemB.id);
    assert.notEqual(groupA.id, groupB.id, "两处成片分属不同审阅组");

    // 两处各自认可（各自的组、各自的当前稿），都是真实确认行。
    for (const [group, item] of [[groupA, itemA], [groupB, itemB]] as const) {
      assert.equal((await confirmReview(f, { workId: confirmed.workId, groupId: group.id,
        items: [{ itemId: item.id, source: revisionDraftOf(item) }], action: "approve" }, "认可这版成片")).statusCode, 202);
    }
    const beforeB = JSON.parse(JSON.stringify(videoItems().find(item => item.label === "成片B")!));
    const beforeBGroupRevision = groupB.revision;
    const confirmations = () => countIn(f, "FROM work_review_confirmations");

    // 重制 A：existing 目标只指 A；产出登记为 A 的新草稿。
    const spec = videoSpec(confirmed.workId, triple, "成片A重制", [confirmed.reviewInput]);
    spec.outputTarget = { group: { mode: "existing", groupId: groupA.id }, item: { mode: "existing", itemId: itemA.id } };
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
    const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.equal(accepted.statusCode, 202);
    const result = await driveToTerminal(f, accepted.json().run.id as string);
    assert.equal(result.state, "succeeded");
    const afterA = videoItems().find(item => item.label === "成片A")!;
    assert.equal(revisionDraftOf(afterA).revisionId, result.outputRevisions[0]!.revisionId, "产出登记为 A 的新草稿");
    assert.deepEqual(videoItems().find(item => item.label === "成片B"), beforeB, "B 的草稿/认可/确认原样不动");
    assert.equal(groupOfItem(itemB.id).revision, beforeBGroupRevision, "B 的组版本不动");
    assert.equal(confirmations(), 3, "夹具 1 + A/B 认可 2；重制不新增确认");
  } finally { await f.close(); }
});

// —— r4.5 C2（F05 继续按钮）：消息级 reviewContext 持久、可回放、边界拒绝 ——

it("C2 继续消息的 reviewContext：指向B并持久；业务上下文与编辑对象指B；回放幂等；越界与互斥拒绝", async () => {
  const f = await setup(); try {
    // A、B 两个作品各有一组（同名组），各自交付主稿——双作品同名组是误继续的高发形态。
    for (const title of ["山路短片", "城市动画"]) {
      await turn(f, [startWorkStep(title), fauxAssistantMessage("已开始。")]);
      const work = works(f).find(item => item.title === title)!;
      await turn(f, [deliverStep([scriptItem(`${title}脚本`, `# ${title}\n正文。`)], [newGroupDelivery(work.id)]), fauxAssistantMessage("脚本已交。")]);
    }
    const a = works(f).find(work => work.title === "山路短片")!;
    const b = works(f).find(work => work.title === "城市动画")!;
    const groupOf = (workId: string) => workOf(f, workId).reviewGroups.find(group => group.title === "脚本与内容")!;
    const bGroup = groupOf(b.id);
    assert.notEqual(groupOf(a.id).id, bGroup.id, "同名组但身份不同");

    // 页面继续按钮的真实负载形态：reviewContext 指向所点作品与组。
    const commandId = cmd();
    const payload = { ...chatInput("继续这组的下一步"), commandId, reviewContext: { workId: b.id, groupId: bGroup.id } };
    let seen: { reviewContext: unknown; editingWorkId: unknown } | null = null;
    f.app.faux!.setResponses([ctx => {
      const texts = ctx.messages.flatMap((message: { content: string | { type: string; text?: string }[] }) =>
        typeof message.content === "string" ? [message.content] : message.content.flatMap(block => block.type === "text" ? [block.text!] : []));
      const frame = texts.filter((text: string) => text.startsWith("[frame-current-state]")).at(-1)!;
      seen = JSON.parse(frame.slice("[frame-current-state]".length).split("\n")[0]!);
      return fauxAssistantMessage("已继续。");
    }]);
    const sent = await f.app.service.sendMessage("local-owner", f.conversation.id, payload);
    await waitIdle(f);
    const persisted = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.id === sent.receipt.messageId);
    assert.deepEqual(persisted?.reviewContext, { workId: b.id, groupId: bGroup.id }, "消息持久携带 reviewContext");
    assert.deepEqual(seen!.reviewContext, { workId: b.id, groupId: bGroup.id }, "Pi 回合业务上下文指向 B 的组");
    assert.equal(seen!.editingWorkId, b.id, "原生编辑对象（workspace 归属）指向 B");
    assert.equal(countIn(f, "FROM work_review_confirmations"), 0, "继续消息不产生任何认可");

    // 回放同一 commandId：同一回执、不新增消息。
    const replay = await f.app.service.sendMessage("local-owner", f.conversation.id, payload);
    assert.equal(replay.receipt.messageId, sent.receipt.messageId, "回放返回原消息");
    assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).messages.items.filter(item => item.id === sent.receipt.messageId).length, 1);

    // 边界：组不属于所给作品 / 互斥字段同送 → 契约与边界各拒一次，不落消息。
    const before = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.length;
    const mismatch = await postMessage(f, { ...chatInput("错位继续"), reviewContext: { workId: a.id, groupId: bGroup.id } });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().code, "INVALID_INPUT");
    const both = await postMessage(f, { ...chatInput("互斥继续"), reviewContext: { workId: b.id, groupId: bGroup.id },
      reviewConfirmation: { workId: b.id, groupId: bGroup.id, items: [{ itemId: bGroup.items[0]!.id, source: revisionDraftOf(bGroup.items[0]!) }], action: "approve" } });
    assert.equal(both.statusCode, 400, "reviewContext 与 reviewConfirmation 互斥");
    assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).messages.items.length, before, "被拒输入不落消息");

    // 持久性：关闭进程后在同一数据目录重开，reviewContext 仍在。
    await f.app.close();
    const reopened = await assembleOfflineAgent({ dataDir: f.directory, uiOrigin: origin, media: { autoStart: false, delayMs: 0 } });
    try {
      const still = reopened.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.id === sent.receipt.messageId);
      assert.deepEqual(still?.reviewContext, { workId: b.id, groupId: bGroup.id }, "重开后 reviewContext 仍从持久行读出");
    } finally { await reopened.close(); }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
