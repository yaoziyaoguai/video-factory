import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG, type OfflineAgentOptions } from "../src/server/agent/offline.js";
import { BusinessTools } from "../src/server/agent/pi-tools.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { bindPreparedPlan, deliverPlanDraft, seedPlanStageWork } from "./helpers/creative-work-fixture.js";
import type {
  ArtifactHead, ArtifactRevision, ContentSource, ContentSourceInput, ProductionIntent, Proposal, Work,
} from "../src/shared/agent/generated/contracts.js";

// R1 阶段连续性验收：当前稿认可/继续、采用后修订、在途冻结与意见真实归属（F03–F06/F08/F09）。
// 全部走真实 SQLite 与公开 HTTP / 工具入口；本地替身只驱动机制，不代表真实模型判断。
// 事务与重放语义在 agent-production / agent-domain / agent-production-crash 已有覆盖，这里补阶段内核本身。

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
  const conversation = app.service.createConversation("local-owner", { commandId: cmd(), title: "阶段连续性" }).conversation;
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

const deliverStep = (items: Record<string, unknown>[], stageDrafts?: Record<string, unknown>[]) => fauxAssistantMessage([
  fauxToolCall("deliver_artifacts", { items, ...(stageDrafts ? { stageDrafts } : {}) } as never),
]);

const scriptItem = (title: string, text: string) => ({
  mode: "create", title, kind: "script", content: { format: "markdown", text },
});

function revisionDraftOf(f: Fixture, workId: string): Extract<ContentSource, { kind: "artifact_revision" }> {
  const draft = workOf(f, workId).stages.content.draft;
  assert.ok(draft && draft.kind === "artifact_revision", "内容主稿应是产物修订");
  return draft;
}

function works(f: Fixture): Work[] {
  return f.app.service.snapshot("local-owner", f.conversation.id).works;
}

function workOf(f: Fixture, workId: string): Work {
  const found = works(f).find(item => item.id === workId);
  assert.ok(found, `应能读到事项 ${workId}`);
  return found;
}

function artifactOf(f: Fixture, title: string): ArtifactHead {
  const found = f.app.service.snapshot("local-owner", f.conversation.id).artifacts.items.find(item => item.title === title);
  assert.ok(found, `应能读到产物 ${title}`);
  return found;
}

// 按钮是公开 HTTP 入口：结构化阶段认可走 POST messages 的 stageConfirmation。
async function confirmButton(f: Fixture, payload: Record<string, unknown>) {
  return f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers,
    payload: { ...chatInput("确认当前稿"), stageConfirmation: payload } });
}

async function postMessage(f: Fixture, payload: Record<string, unknown>) {
  return f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers, payload });
}

const countIn = (f: Fixture, sql: string, ...args: unknown[]) =>
  (f.app.database.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;

function speechSpec(workId: string | null, artifact: ArtifactHead, revision: ArtifactRevision, title: string): ProductionIntent {
  return {
    workId, title, inputRevisions: [{ artifactId: artifact.id, revisionId: artifact.revisionId }],
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

// —— R1.1（F03/F04）：当前稿才可认可/继续；旧命令回放只回原回执 ——

it("R1.1 旧稿确认被拒、当前稿认可可回放；纯认可后下游仍不放行", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    // v1：本轮新写的内容主稿（source=null）。
    await turn(f, [deliverStep([scriptItem("山路内容 v1", "# 山路\n清晨的固定镜头。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v1 已登记。")]);
    const v1 = revisionDraftOf(f, work.id);
    // v2：再写一版，内容当前稿前进。
    await turn(f, [deliverStep([scriptItem("山路内容 v2", "# 山路\n黄昏的固定镜头。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v2 已登记。")]);
    const v2 = revisionDraftOf(f, work.id);
    assert.notEqual(v2.revisionId, v1.revisionId);

    for (const action of ["approve_content", "approve_content_continue"] as const) {
      const stale = await confirmButton(f, { workId: work.id, action,
        subject: { kind: "artifact_revision", artifactId: v1.artifactId, revisionId: v1.revisionId, digest: v1.digest } });
      assert.equal(stale.statusCode, 400);
      assert.equal(stale.json().code, "INVALID_INPUT");
      assert.match(stale.json().message, /当前稿已更新/);
    }
    const confirmationsBefore = countIn(f, "FROM work_stage_confirmations WHERE work_id = ?", work.id);

    const approvePayload = { ...chatInput("认可这版"),
      stageConfirmation: { workId: work.id, action: "approve_content",
        subject: { kind: "artifact_revision", artifactId: v2.artifactId, revisionId: v2.revisionId, digest: v2.digest } } };
    const approved = await postMessage(f, approvePayload);
    assert.equal(approved.statusCode, 202);
    assert.equal(approved.json().replayed, false);
    const afterApprove = workOf(f, work.id);
    assert.equal(afterApprove.stages.content.confirmationAction, "approve_content", "确认动作只读投影");
    const approvedSubject = afterApprove.stages.content.approved;
    assert.ok(approvedSubject && approvedSubject.kind === "artifact_revision");
    assert.equal(approvedSubject.revisionId, v2.revisionId);

    // 同命令同内容重放：回原回执，不新增确认、不排队。
    const requestsBefore = countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id);
    const replayed = await postMessage(f, approvePayload);
    assert.equal(replayed.statusCode, 202);
    assert.equal(replayed.json().replayed, true);
    assert.equal(replayed.json().requestId, approved.json().requestId, "回放返回原回执");
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE work_id = ?", work.id), confirmationsBefore + 1);
    assert.equal(countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id), requestsBefore);

    // 尚无方案时，暂停不能借讨论修订的例外首次进入画面阶段。
    await turn(f, [deliverStep([scriptItem("首次方案", "山路画面")],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: v2, proposalRef: null }]), fauxAssistantMessage("请先明确继续。")]);
    assert.equal(workOf(f, work.id).stages.plan.draft, null);
    assert.equal(workOf(f, work.id).stages.content.confirmationId, afterApprove.stages.content.confirmationId);

    // 纯认可（暂停）不放行任何下游制作准备。
    const prompt = artifactOf(f, "山路内容 v2");
    const revision = f.app.service.readRevision("local-owner", prompt.id, prompt.revisionId);
    await assert.rejects(
      () => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") }),
      /不能先准备画面素材/,
    );
  } finally { await f.close(); }
});

it("R1.1 认可并继续后改稿：下游被拦，仅再认可不放行，明确继续才放行", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("内容 v1", "# 内容\n第一版。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v1 已登记。")]);
    const v1 = revisionDraftOf(f, work.id);

    // v1 明确继续 → 进入方案阶段。
    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    const continued = await confirmButton(f, { workId: work.id, action: "approve_content_continue",
      subject: { kind: "artifact_revision", artifactId: v1.artifactId, revisionId: v1.revisionId, digest: v1.digest } });
    assert.equal(continued.statusCode, 202);
    await waitIdle(f);
    assert.equal(workOf(f, work.id).stage, "plan");
    assert.equal(workOf(f, work.id).stages.content.confirmationAction, "approve_content_continue");

    // v2 改稿：认可历史保留，但下游需要重新明确继续。
    await turn(f, [deliverStep([scriptItem("内容 v2", "# 内容\n第二版。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v2 已登记。")]);
    const v2 = revisionDraftOf(f, work.id);
    const prompt = artifactOf(f, "内容 v2");
    const revision = f.app.service.readRevision("local-owner", prompt.id, prompt.revisionId);
    await assert.rejects(
      () => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") }),
      /内容主稿已更新/,
    );
    await turn(f, [deliverStep([scriptItem("画面方案", "# 方案\n镜头顺序。")],
      [{ workId: work.id, stage: "plan", itemIndex: 0,
         source: { kind: "artifact_revision" as const, artifactId: v2.artifactId, revisionId: v2.revisionId, digest: v2.digest }, proposalRef: null }]),
      fauxAssistantMessage("方案被拦下了。")]);
    assert.equal(workOf(f, work.id).stages.plan.draft, null, "未明确继续时方案主稿不得登记");

    // 仅认可 v2：仍暂停。
    const v2Payload = { kind: "artifact_revision" as const, artifactId: v2.artifactId, revisionId: v2.revisionId, digest: v2.digest };
    const paused = await confirmButton(f, { workId: work.id, action: "approve_content", subject: v2Payload });
    assert.equal(paused.statusCode, 202);
    assert.equal(workOf(f, work.id).stages.content.confirmationAction, "approve_content");
    await assert.rejects(
      () => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") }),
      /未明确继续/,
    );

    // 明确继续 v2：下游放行。
    f.app.faux!.setResponses([fauxAssistantMessage("继续画面阶段。")]);
    const resumed = await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: v2Payload });
    assert.equal(resumed.statusCode, 202);
    await waitIdle(f);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") })).proposal;
    assert.equal(proposal.state, "ready");
    assert.equal(proposal.spec.workId, work.id);
  } finally { await f.close(); }
});

it("R1.1 同版继续后明确暂停：旧继续命令回放不重新放行、不重新排队", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("内容 v1", "# 内容\n唯一一版。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v1 已登记。")]);
    const v1 = revisionDraftOf(f, work.id);
    const subject = { kind: "artifact_revision" as const, artifactId: v1.artifactId, revisionId: v1.revisionId, digest: v1.digest };

    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    const continuePayload = { ...chatInput("认可并继续"),
      stageConfirmation: { workId: work.id, action: "approve_content_continue", subject } };
    const continued = await postMessage(f, continuePayload);
    assert.equal(continued.statusCode, 202);
    await waitIdle(f);
    assert.equal(workOf(f, work.id).stages.content.confirmationAction, "approve_content_continue");

    // 同版明确暂停。
    const paused = await confirmButton(f, { workId: work.id, action: "approve_content", subject });
    assert.equal(paused.statusCode, 202);
    assert.equal(workOf(f, work.id).stages.content.confirmationAction, "approve_content");

    const prompt = artifactOf(f, "内容 v1");
    const revision = f.app.service.readRevision("local-owner", prompt.id, prompt.revisionId);
    await assert.rejects(
      () => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") }),
      /未明确继续/,
    );

    // 旧继续命令重放：回原回执，认可状态仍是暂停，也不重新排队。
    const confirmations = countIn(f, "FROM work_stage_confirmations WHERE work_id = ?", work.id);
    const requests = countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id);
    const replayed = await postMessage(f, continuePayload);
    assert.equal(replayed.statusCode, 202);
    assert.equal(replayed.json().replayed, true);
    assert.equal(replayed.json().requestId, continued.json().requestId);
    assert.equal(workOf(f, work.id).stages.content.confirmationAction, "approve_content", "回放不改变最新认可状态");
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE work_id = ?", work.id), confirmations);
    assert.equal(countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id), requests);
    await assert.rejects(
      () => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") }),
      /未明确继续/,
    );

    // 新命令的明确继续才重新放行。
    f.app.faux!.setResponses([fauxAssistantMessage("再次进入画面阶段。")]);
    const resumed = await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject });
    assert.equal(resumed.statusCode, 202);
    await waitIdle(f);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: speechSpec(work.id, prompt, revision, "山路配音") })).proposal;
    assert.equal(proposal.state, "ready");
    assert.equal(proposal.spec.workId, work.id);
  } finally { await f.close(); }
});

// —— R1.2（F05/F08）：首次采用旧版合法；独立稿改写自动归属并使旧提案失效 ——

it("R1.2 首采历史修订合法；省 stageDrafts 改稿归属当前事项并使旧提案失效；多引用要求显式归属", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([scriptItem("独立稿", "# 独立稿\n第一版。")]), fauxAssistantMessage("独立稿交付。")]);
    const standalone = artifactOf(f, "独立稿");
    await turn(f, [deliverStep([{ mode: "revise", artifactId: standalone.id, baseRevisionId: standalone.revisionId,
      title: "独立稿", kind: "script", content: { format: "markdown", text: "# 独立稿\n第二版。" } }]), fauxAssistantMessage("独立稿升到 v2。")]);
    const head2 = artifactOf(f, "独立稿");
    assert.equal(head2.revisionNumber, 2);
    const rev1 = f.app.service.readRevision("local-owner", standalone.id, standalone.revisionId);

    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;

    // 首采旧版：head 已是 v2，仍可采用历史修订 v1 建立内容主稿。
    const adopted = await confirmButton(f, { workId: work.id, action: "approve_content",
      subject: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest } });
    assert.equal(adopted.statusCode, 202);
    assert.equal(revisionDraftOf(f, work.id).revisionId, standalone.revisionId);

    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    const continued = await confirmButton(f, { workId: work.id, action: "approve_content_continue",
      subject: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest } });
    assert.equal(continued.statusCode, 202);
    await waitIdle(f);

    // 与内容无关的输入另备一份，提案过期只由方案主稿关联触发。
    await turn(f, [deliverStep([scriptItem("配音底稿", "# 底稿\n旁白文本。")]), fauxAssistantMessage("底稿交付。")]);
    const narration = artifactOf(f, "配音底稿");
    const narrationRevision = f.app.service.readRevision("local-owner", narration.id, narration.revisionId);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: speechSpec(work.id, narration, narrationRevision, "山路配音") })).proposal;
    await turn(f, [deliverStep([scriptItem("画面方案", "# 方案\n镜头顺序。")],
      [{ workId: work.id, stage: "plan", itemIndex: 0,
         source: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest },
         proposalRef: { proposalId: proposal.id, digest: proposal.digest } }]), fauxAssistantMessage("方案已关联提案。")]);
    assert.equal(workOf(f, work.id).stages.plan.proposalId, proposal.id);

    // 省略 stageDrafts 的独立稿改写：自动归属当前事项的内容阶段，不需模型显式指定。
    await turn(f, [deliverStep([{ mode: "revise", artifactId: head2.id, baseRevisionId: head2.revisionId,
      title: "独立稿", kind: "script", content: { format: "markdown", text: "# 独立稿\n第三版。" } }]), fauxAssistantMessage("改到 v3。")]);
    const head3 = artifactOf(f, "独立稿");
    assert.equal(head3.revisionNumber, 3);
    const afterRevise = workOf(f, work.id);
    assert.equal(revisionDraftOf(f, work.id).revisionId, head3.revisionId, "改稿自动归属该事项内容主稿");
    const approved = afterRevise.stages.content.approved;
    assert.ok(approved && approved.kind === "artifact_revision");
    assert.equal(approved.revisionId, standalone.revisionId, "认可历史保留");
    assert.equal(afterRevise.stages.content.confirmationAction, "approve_content_continue");
    assert.equal(afterRevise.stages.plan.upstreamStale, true, "方案主稿上游待更新");
    assert.equal(workOf(f, work.id).stages.plan.proposalId, null, "失效提案不再挂靠");
    assert.equal((f.app.service.readProposal("local-owner", proposal.id) as Proposal).state, "stale", "旧提案失效");

    // 同一产物被两个事项引用后，隐式改写无法唯一推导，必须显式 stageDrafts。
    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    const first = await confirmButton(f, { workId: coffee.id, action: "approve_content",
      subject: { kind: "artifact_revision", artifactId: standalone.id, revisionId: standalone.revisionId, digest: rev1.digest } });
    assert.equal(first.statusCode, 202, "未绑定的历史修订可被第二条事项首次采用");
    await turn(f, [deliverStep([{ mode: "revise", artifactId: head3.id, baseRevisionId: head3.revisionId,
      title: "独立稿", kind: "script", content: { format: "markdown", text: "# 独立稿\n第四版。" } }]), fauxAssistantMessage("改写被拦。")]);
    assert.equal(artifactOf(f, "独立稿").revisionNumber, 3, "归属不唯一时改写被拒，产物不动");
    await turn(f, [deliverStep([{ mode: "revise", artifactId: head3.id, baseRevisionId: head3.revisionId,
      title: "独立稿", kind: "script", content: { format: "markdown", text: "只更新 A 的第四版。" } }],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("A 已更新。")]);
    assert.equal(artifactOf(f, "独立稿").revisionNumber, 4, "显式指定真实归属后可以修改");
    assert.equal(revisionDraftOf(f, coffee.id).revisionId, standalone.revisionId, "B 不被级联修改");
  } finally { await f.close(); }
});

// —— R1.3（F06）：受理后同事项写入口全部冻结；他事项可写；worker 仍可完成 ——

it("R1.3 受理冻结同事项认可/新稿/改稿三个写入口；他事项可写，制作正常完成", async () => {
  const f = await setup(); try {
    // 既有 Prompt 输入 + 一条已进入方案阶段的事项，沿用制作套件的真实内核夹具。
    await turn(f, [deliverStep([{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("已交付。")]);
    const input = artifactOf(f, "山路");
    const inputRevision = f.app.service.readRevision("local-owner", input.id, input.revisionId);
    const planWork = seedPlanStageWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const spec: ProductionIntent = { workId: planWork.workId, title: "山路短片",
      inputRevisions: [{ artifactId: input.id, revisionId: input.revisionId }],
      operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [{ kind: "artifact_revision", artifactId: input.id, revisionId: input.revisionId, digest: inputRevision.digest }],
        maxCreateAttempts: 1, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
      finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, maxSpend: { currency: "CNY", amountMinor: 1200 } };
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
    bindPreparedPlan(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, proposal, planWork);

    // 公开 HTTP 受理：认可先于 queued run 写入，admit 不被自身在途状态拦截。
    const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.equal(accepted.statusCode, 202);
    const runId = accepted.json().run.id as string;
    assert.equal(f.app.service.getRun("local-owner", runId).state, "queued");

    // 入口一（消息认可）：在途后同事项的阶段认可被拒。
    const seedContent = planWork.content;
    assert.ok(seedContent.kind === "message_text");
    const busy = await confirmButton(f, { workId: planWork.workId, action: "approve_content_continue",
      subject: { kind: "message_text", messageId: seedContent.messageId, text: seedContent.text } });
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, "RUN_BUSY");

    // 入口二（新写主稿）：create + stageDrafts 被整体拒绝，不留半份产物。
    const artifactsBefore = countIn(f, "FROM artifacts WHERE conversation_id = ?", f.conversation.id);
    await turn(f, [deliverStep([scriptItem("山路内容改写", "# 山路\n新的内容。")],
      [{ workId: planWork.workId, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("新稿被拦。")]);
    assert.equal(workOf(f, planWork.workId).stages.content.draft!.kind, "message_text", "内容主稿未变");
    assert.equal(countIn(f, "FROM artifacts WHERE conversation_id = ?", f.conversation.id), artifactsBefore, "被拒交付不落半份产物");

    // 入口三（改写主稿）：方案主稿被输入锁拦下。
    const planArtifact = f.app.service.snapshot("local-owner", f.conversation.id).artifacts.items
      .find(item => item.title === "画面声音方案")!;
    assert.ok(planArtifact, "夹具应已登记方案主稿");
    await turn(f, [deliverStep([{ mode: "revise", artifactId: planArtifact.id, baseRevisionId: planArtifact.revisionId,
      title: "画面声音方案", kind: "script", content: { format: "markdown", text: "# 方案\n被冻结的改写。" } }]), fauxAssistantMessage("改稿被拦。")]);
    assert.equal(f.app.service.readArtifactHead("local-owner", planArtifact.id).revisionNumber, 1, "方案主稿不动");

    // 他事项不受冻结：可开新事项并登记内容主稿。
    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    await turn(f, [deliverStep([scriptItem("咖啡内容 v1", "# 咖啡\n第一版。")],
      [{ workId: coffee.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("B 事项可写。")]);
    assert.equal(workOf(f, coffee.id).stages.content.draft!.kind, "artifact_revision");

    // worker 完成不受写入口冻结影响。
    const result = await driveToTerminal(f, runId);
    assert.equal(result.state, "succeeded");
    const finished = workOf(f, planWork.workId);
    assert.equal(finished.stage, "video");
    assert.ok(finished.stages.video.draft, "制作产出登记为视频初稿");
  } finally { await f.close(); }
});

it("R1.3 admit 中途失败整体回滚：无半份认可、授权或运行；重试可正常受理", async () => {
  let failAdmission = true;
  const f = await setup(undefined, { crash: point => { if (failAdmission && point === "before-admission-commit") throw new Error("simulated crash before commit"); } });
  try {
    await turn(f, [deliverStep([{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("已交付。")]);
    const input = artifactOf(f, "山路");
    const inputRevision = f.app.service.readRevision("local-owner", input.id, input.revisionId);
    const planWork = seedPlanStageWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, "山路短片");
    const spec: ProductionIntent = { workId: planWork.workId, title: "山路短片",
      inputRevisions: [{ artifactId: input.id, revisionId: input.revisionId }],
      operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [{ kind: "artifact_revision", artifactId: input.id, revisionId: input.revisionId, digest: inputRevision.digest }],
        maxCreateAttempts: 1, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
      finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, maxSpend: { currency: "CNY", amountMinor: 1200 } };
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
    bindPreparedPlan(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: f.conversation.id }, proposal, planWork);

    const failed = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.ok(failed.statusCode >= 500, "受理事务中途失败如实报错");
    assert.equal(countIn(f, "FROM production_runs"), 0);
    assert.equal(countIn(f, "FROM authorizations"), 0);
    assert.equal(countIn(f, "FROM user_actions"), 0);
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE action = 'approve_plan'"), 0, "无半份方案认可");
    assert.equal((f.app.service.readProposal("local-owner", proposal.id) as Proposal).state, "ready", "提案保持可受理");

    // 同一提案重试：事务重放完整认可与授权。
    failAdmission = false;
    const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: proposal.digest } });
    assert.equal(accepted.statusCode, 202);
    assert.equal(countIn(f, "FROM production_runs"), 1);
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE action = 'approve_plan'"), 1);
    assert.equal(workOf(f, planWork.workId).stages.plan.confirmationAction, "approve_plan");
  } finally { await f.close(); }
});

// —— V1（A1）：方案认可并准备制作 = 同一事务一次认可 + 一次准备请求；预算确认前不产生制作 ——

it("V1 认可并准备制作：一次按钮恰记一次方案认可并排一次请求，target 指向这份方案；重放不重复", async () => {
  const f = await setup(); try {
    const now = new Date().toISOString();
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const seeded = seedPlanStageWork(f.app.database, now, scope, "山路短片");
    deliverPlanDraft(f.app.database, now, scope, seeded, null);
    const planDraft = workOf(f, seeded.workId).stages.plan.draft;
    assert.ok(planDraft && planDraft.kind === "artifact_revision", "方案主稿应是产物修订");
    assert.equal(workOf(f, seeded.workId).stages.plan.confirmationAction, null, "方案尚未认可");

    const payload = { ...chatInput("这份方案我认可了。请按这份方案准备制作：列出本次费用让我确认；方案内容不变，不需要重新交稿或认可；现在先不提交生成。"),
      stageConfirmation: { workId: seeded.workId, action: "approve_plan", next: "prepare_production",
        subject: { kind: "artifact_revision", artifactId: planDraft.artifactId, revisionId: planDraft.revisionId, digest: planDraft.digest } } };
    f.app.faux!.setResponses([fauxAssistantMessage("本次费用约 ¥12，确认后开始制作。")]);
    const sent = await postMessage(f, payload);
    assert.equal(sent.statusCode, 202);
    await waitIdle(f);

    // 一次按钮：恰一条方案认可 + 恰一次准备请求；请求 target 就是这份准确方案修订。
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE work_id = ? AND action = 'approve_plan'", seeded.workId), 1);
    const approved = workOf(f, seeded.workId);
    assert.equal(approved.stages.plan.confirmationAction, "approve_plan");
    const requestRow = f.app.database.prepare("SELECT state, target_json FROM requests WHERE id = ?")
      .get(sent.json().requestId) as { state: string; target_json: string };
    assert.equal(requestRow.state, "completed");
    assert.deepEqual(JSON.parse(requestRow.target_json!), { artifactId: planDraft.artifactId, revisionId: planDraft.revisionId, workId: seeded.workId });
    // 报价与授权仍由提案确认完成：预算确认前不受理任何制作。
    assert.equal(countIn(f, "FROM production_runs"), 0, "预算确认前不新增 run");
    assert.equal(countIn(f, "FROM proposals"), 0, "准备阶段只是报价对话，不落制作提案");

    // 同命令重放只回原回执，不新增认可或请求。
    const requestsBefore = countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id);
    const replayed = await postMessage(f, payload);
    assert.equal(replayed.statusCode, 202);
    assert.equal(replayed.json().replayed, true);
    assert.equal(replayed.json().requestId, sent.json().requestId);
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE work_id = ? AND action = 'approve_plan'", seeded.workId), 1);
    assert.equal(countIn(f, "FROM requests WHERE conversation_id = ?", f.conversation.id), requestsBefore);
  } finally { await f.close(); }
});

it("V1 纯方案认可（不带 next）不进文本模型：请求本体直接完成并关闭投递", async () => {
  const f = await setup(); try {
    const now = new Date().toISOString();
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const seeded = seedPlanStageWork(f.app.database, now, scope, "夜航短片");
    deliverPlanDraft(f.app.database, now, scope, seeded, null);
    const planDraft = workOf(f, seeded.workId).stages.plan.draft!;
    assert.ok(planDraft.kind === "artifact_revision");
    const sent = await confirmButton(f, { workId: seeded.workId, action: "approve_plan",
      subject: { kind: "artifact_revision", artifactId: planDraft.artifactId, revisionId: planDraft.revisionId, digest: planDraft.digest } });
    assert.equal(sent.statusCode, 202);
    assert.equal(workOf(f, seeded.workId).stages.plan.confirmationAction, "approve_plan");
    const requestRow = f.app.database.prepare("SELECT state, delivery_closed, target_json FROM requests WHERE id = ?")
      .get(sent.json().requestId) as { state: string; delivery_closed: number; target_json: string | null };
    assert.equal(requestRow.state, "completed");
    assert.equal(requestRow.delivery_closed, 1, "纯认可不排 Pi 请求");
    assert.equal(requestRow.target_json, null);
    assert.equal(countIn(f, "FROM production_runs"), 0);
  } finally { await f.close(); }
});

// —— R1.4（F09）：意见按真实归属投影；read_work 只读本事项；steer 后意见落在真实来源 ——

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

it("R1.4 原文内容意见与稿件意见各归本事项；read_work 只读相关意见，不混入他事项", async () => {
  const f = await setup();
  const releases: (() => void)[] = [];
  try {
    // 事项 A：内容主稿是用户消息原文（真实按钮采用）。
    f.app.faux!.setResponses([fauxAssistantMessage("收到，先按这份内容。")]);
    const adoption = await f.app.service.sendMessage("local-owner", f.conversation.id,
      chatInput("正式做：清晨山路固定镜头，缓慢推近。"));
    await waitIdle(f);
    const sourceMessage = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.id === adoption.receipt.messageId)!;
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const mountain = works(f)[0]!;
    const messageSubject = { kind: "message_text", messageId: sourceMessage.id, text: sourceMessage.text };
    const adopted = await confirmButton(f, { workId: mountain.id, action: "approve_content", subject: messageSubject });
    assert.equal(adopted.statusCode, 202);
    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    const continued = await confirmButton(f, { workId: mountain.id, action: "approve_content_continue", subject: messageSubject });
    assert.equal(continued.statusCode, 202);
    await waitIdle(f);

    // 事项 B：内容主稿是本轮新写的稿件。
    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    await turn(f, [deliverStep([scriptItem("咖啡内容 v1", "# 咖啡\n蒸汽特写。")],
      [{ workId: coffee.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("B 主稿已登记。")]);
    const coffeeDraft = revisionDraftOf(f, coffee.id);

    // 新入口（模型工具）：A 用 workId-only 记原文内容意见；B 显式指向自己的主稿修订。
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const heldA = await holdRequest(f, "山路这条：节奏再快一点"); releases.push(heldA.release);
    const noteA = await tools.recordWorkFeedback(heldA.context as never, { workId: mountain.id, artifactId: null, baseRevisionId: null });
    heldA.release(); await waitIdle(f);
    assert.equal(noteA.target, null);
    assert.equal(noteA.workId, mountain.id);
    assert.equal(noteA.contentSource!.kind, "message_text");
    assert.equal(noteA.disposition, "noted");
    const heldB = await holdRequest(f, "咖啡这条：结尾停久一点"); releases.push(heldB.release);
    const noteB = await tools.recordWorkFeedback(heldB.context as never,
      { workId: coffee.id, artifactId: coffeeDraft.artifactId, baseRevisionId: coffeeDraft.revisionId });
    heldB.release(); await waitIdle(f);
    assert.equal(noteB.workId, null);
    assert.equal(noteB.target!.artifactId, coffeeDraft.artifactId);

    // 旧入口（用户按钮反馈）：指向 B 的稿件修订。
    const legacy = f.app.service.addFeedback("local-owner", f.conversation.id, { commandId: cmd(),
      target: { artifactId: coffeeDraft.artifactId, revisionId: coffeeDraft.revisionId, workId: coffee.id }, text: "旧入口：字幕小一号" });
    assert.equal(legacy.receipt.disposition, "noted");

    // 意见消息的真实投影：kind 与原文不变，feedback 带上真实归属。
    const messages = f.app.service.snapshot("local-owner", f.conversation.id).messages.items;
    const aMessage = messages.find(item => item.id === noteA.messageId)!;
    assert.equal(aMessage.kind, "chat");
    assert.equal(aMessage.text, "山路这条：节奏再快一点");
    assert.equal(aMessage.feedback!.workId, mountain.id);
    assert.equal(aMessage.feedback!.contentSource!.kind, "message_text");
    assert.equal(validatorFor("Message")(aMessage).ok, true, "普通用户消息携带真实意见符合正式合同");
    const response = await f.app.app.inject({ method: "GET", url: `/api/agent/v1/conversations/${f.conversation.id}/snapshot` });
    assert.equal(response.statusCode, 200);
    assert.equal(validatorFor("Snapshot")(response.json()).ok, true, "实际 HTTP 快照也符合合同");

    // read_work 共用只读查询：各事项只读到自己的意见（新旧行为各一次）。
    const heldRead = await holdRequest(f, "读取事实"); releases.push(heldRead.release);
    const readA = await tools.readWork(heldRead.context as never, { workId: mountain.id });
    const readB = await tools.readWork(heldRead.context as never, { workId: coffee.id });
    heldRead.release(); await waitIdle(f);
    assert.equal(readA.relatedFeedback.length, 1);
    assert.equal(readA.relatedFeedback[0]!.workId, mountain.id);
    assert.match(readA.relatedFeedback[0]!.text, /节奏再快一点/);
    const bTexts = readB.relatedFeedback.map(note => note.text);
    assert.equal(readB.relatedFeedback.length, 2, "B 有稿件意见与旧入口意见各一条");
    assert.ok(bTexts.some(text => text.includes("结尾停久一点")));
    assert.ok(bTexts.some(text => text.includes("旧入口：字幕小一号")));
    assert.ok(!bTexts.some(text => text.includes("节奏再快一点")), "A 的意见不混入 B");
    assert.equal(readA.stages.content.confirmationAction, "approve_content_continue", "read_work 仍带只读认可投影");
  } finally { releases.forEach(release => release()); await f.close(); }
});

it("R1.4 已消费的 steer 成为意见的真实来源：意见落在补充消息上，不冒用原请求消息", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("内容 v1", "# 内容\n第一版。")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("v1 已登记。")]);

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

it("R1.5 普通聊天与 Prompt 交付不登记创作事项", async () => {
  const f = await setup(); try {
    await turn(f, [fauxAssistantMessage("Prompt：清晨沿山路行进的固定镜头。")], "给我一条山路视频的 Prompt，先不制作");
    await turn(f, [deliverStep([{ mode: "create", title: "山路文案", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }]), fauxAssistantMessage("文案交付。")], "正式给我这份文案");
    assert.equal(works(f).length, 0, "没有开始创作就没有事项");
    assert.equal(countIn(f, "FROM works"), 0);
  } finally { await f.close(); }
});

it("R1 暂停后可显式或隐式修当前方案，认可和制作仍遵守继续许可与准确来源", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("内容", "第一版内容")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("请看草稿。")]);
    const content = revisionDraftOf(f, work.id);
    f.app.faux!.setResponses([fauxAssistantMessage("开始准备方案。")]);
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: content })).statusCode, 202);
    await waitIdle(f);
    await turn(f, [deliverStep([scriptItem("方案", "第一版方案")],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: content, proposalRef: null }]), fauxAssistantMessage("请看方案。")]);
    let plan = artifactOf(f, "方案");
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content", subject: content })).statusCode, 202);
    const pausedContent = workOf(f, work.id).stages.content;
    const confirmations = countIn(f, "FROM work_stage_confirmations");
    const revisePlan = () => turn(f, [deliverStep([{ mode: "revise", artifactId: plan.id, baseRevisionId: plan.revisionId,
      title: "方案", kind: "script", content: { format: "markdown", text: "放低机位，缓慢前推" } }]), fauxAssistantMessage("镜头已改，仍暂停。")], "把当前镜头放低，慢一点推进，先不继续");
    await revisePlan();
    assert.equal(f.app.service.readArtifactHead("local-owner", plan.id).revisionNumber, 2, "暂停时可隐式修当前讨论方案");
    plan = artifactOf(f, "方案");
    await turn(f, [deliverStep([{ mode: "revise", artifactId: plan.id, baseRevisionId: plan.revisionId,
      title: "方案", kind: "script", content: { format: "markdown", text: "保留低机位，再放慢前推" } }],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: content, proposalRef: null }]), fauxAssistantMessage("新方案可继续讨论。")], "再放慢一点，仍然先别继续");
    plan = artifactOf(f, "方案");
    assert.equal(plan.revisionNumber, 3, "显式阶段关联与隐式继承遵循相同暂停改稿语义");
    assert.deepEqual(workOf(f, work.id).stages.content, pausedContent, "内容修订、认可身份及暂停动作原样保留");
    assert.equal(countIn(f, "FROM work_stage_confirmations"), confirmations, "镜头修改不补写继续认可");
    assert.equal(countIn(f, "FROM proposals"), 0);
    assert.equal(countIn(f, "FROM production_runs"), 0);
    const planSource = workOf(f, work.id).stages.plan.draft!;
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_plan", subject: planSource })).statusCode, 400);
    await turn(f, [deliverStep([scriptItem("另一份方案", "新建方案")],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: content, proposalRef: null }]), fauxAssistantMessage("请先继续。")]);
    assert.equal(workOf(f, work.id).stages.plan.draft?.kind, "artifact_revision");
    assert.deepEqual(workOf(f, work.id).stages.plan.draft, planSource, "暂停改稿例外不允许 create 代替当前方案");

    const assistantBeforeContinue = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.filter(message => message.role === "assistant").length;
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: content })).statusCode, 202);
    await waitIdle(f);
    assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).messages.items.filter(message => message.role === "assistant").length,
      assistantBeforeContinue, "已有对应方案时明确继续无需新模型回合");
    assert.deepEqual(workOf(f, work.id).stages.plan.draft, planSource);

    await turn(f, [deliverStep([scriptItem("内容 v2", "第二版内容")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("请确认新内容。")]);
    const nextContent = revisionDraftOf(f, work.id);
    f.app.faux!.setResponses([fauxAssistantMessage("按新内容继续。")]);
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: nextContent })).statusCode, 202);
    await waitIdle(f);
    await revisePlan();
    assert.equal(f.app.service.readArtifactHead("local-owner", plan.id).revisionId, plan.revisionId, "以当前 base 修稿仍不能隐式沿用旧内容来源");
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_plan", subject: planSource })).statusCode, 400);
    await turn(f, [deliverStep([{ mode: "revise", artifactId: plan.id, baseRevisionId: plan.revisionId,
      title: "方案", kind: "script", content: { format: "markdown", text: "按新内容改写方案" } }],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: nextContent, proposalRef: null }]), fauxAssistantMessage("新版方案已交。")]);
    assert.equal(f.app.service.readArtifactHead("local-owner", plan.id).revisionNumber, 4, "显式使用已继续的新内容可以改稿");
  } finally { await f.close(); }
});

it("R1 已采用的独立稿意见不允许挂到另一事项；共享稿件的明确意见仍按事项隔离", async () => {
  const f = await setup(); const releases: (() => void)[] = [];
  try {
    await turn(f, [deliverStep([scriptItem("独立稿", "一个开场")]), fauxAssistantMessage("文案已交。")]);
    const artifact = artifactOf(f, "独立稿");
    const revision = f.app.service.readRevision("local-owner", artifact.id, artifact.revisionId);
    await turn(f, [startWorkStep("视频 A"), startWorkStep("视频 B"), fauxAssistantMessage("两条已开始。")]);
    const a = works(f).find(item => item.title === "视频 A")!, b = works(f).find(item => item.title === "视频 B")!;
    const subject = { kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest };
    assert.equal((await confirmButton(f, { workId: a.id, action: "approve_content", subject })).statusCode, 202);
    const tools = new BusinessTools(f.app.database, () => new Date().toISOString(), () => OFFLINE_QUOTE_CATALOG);
    const wrong = await holdRequest(f, "这条意见属于 B"); releases.push(wrong.release);
    await assert.rejects(() => tools.recordWorkFeedback(wrong.context as never,
      { workId: b.id, artifactId: artifact.id, baseRevisionId: artifact.revisionId }), /不属于|其他|主稿/);
    wrong.release(); await waitIdle(f);
    assert.equal((await confirmButton(f, { workId: b.id, action: "approve_content", subject })).statusCode, 202);
    const held = await holdRequest(f, "只改 B 的结尾"); releases.push(held.release);
    await tools.recordWorkFeedback(held.context as never, { workId: b.id, artifactId: artifact.id, baseRevisionId: artifact.revisionId });
    const readA = await tools.readWork(held.context as never, { workId: a.id });
    const readB = await tools.readWork(held.context as never, { workId: b.id });
    assert.equal(readA.relatedFeedback.length, 0);
    assert.equal(readB.relatedFeedback.length, 1);
    assert.equal(readB.relatedFeedback[0]!.disposition, "noted");
  } finally { releases.forEach(release => release()); await f.close(); }
});

it("R1 原生 steer 后聊天原文的意见按实际消息所属事项进入下一次 Pi 上下文", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("视频 A"), startWorkStep("视频 B"), fauxAssistantMessage("B 的开头用咖啡杯。")]);
    const a = works(f).find(item => item.title === "视频 A")!, b = works(f).find(item => item.title === "视频 B")!;
    const sourceMessage = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.text === "B 的开头用咖啡杯。")!;
    assert.equal((await confirmButton(f, { workId: b.id, action: "approve_content", subject: { kind: "message_text", messageId: sourceMessage.id, text: sourceMessage.text } })).statusCode, 202);
    await turn(f, [deliverStep([scriptItem("A 内容", "山路开场")],
      [{ workId: a.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("A 草稿已交。")]);
    const aDraft = revisionDraftOf(f, a.id);
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
    assert.deepEqual(frame?.feedback.map(note => [note.text, note.disposition]), [["B 的意见：开头用近景", "noted"]]);
    const message = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.text === "B 的意见：开头用近景")!;
    assert.equal(message.feedback?.workId, b.id);
    assert.equal(message.target, null, "聊天原文意见不保留 A 的稿件 target");
  } finally { await f.close(); }
});

it("聊天原文认可并继续时，Pi 上下文明确指向本次确认的事项", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("视频 A"), startWorkStep("视频 B"), fauxAssistantMessage("B 的开头用咖啡杯。")]);
    const b = works(f).find(item => item.title === "视频 B")!;
    const source = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.find(item => item.text === "B 的开头用咖啡杯。")!;
    let referencedWorkIds: string[] = [];
    f.app.faux!.setResponses([context => {
      const last = context.messages.at(-1)!;
      const text = typeof last.content === "string" ? last.content : last.content.filter(block => block.type === "text").map(block => block.text).join("");
      referencedWorkIds = JSON.parse(text.slice("[frame-current-state]".length).split("\n")[0]!).referencedWorkIds;
      return fauxAssistantMessage("继续 B 的画面方案。");
    }]);
    assert.equal((await confirmButton(f, { workId: b.id, action: "approve_content_continue", subject: {
      kind: "message_text", messageId: source.id, text: source.text,
    } })).statusCode, 202);
    await waitIdle(f);
    assert.deepEqual(referencedWorkIds, [b.id]);
  } finally { await f.close(); }
});

it("独立配音或图片正常制作，不凭空创建三阶段视频事项", async () => {
  const f = await setup(); try {
    await turn(f, [deliverStep([scriptItem("文案", "清晨山路")]), fauxAssistantMessage("文案已交。")]);
    const artifact = artifactOf(f, "文案"), revision = f.app.service.readRevision("local-owner", artifact.id, artifact.revisionId);
    const speech = speechSpec(null, artifact, revision, "独立配音");
    const image: ProductionIntent = { ...speech, title: "独立图片", operations: [{ operationId: "image", outputSlot: "image", kind: "image",
      model: OFFLINE_QUOTE_CATALOG["image:faux-image"].binding, maxCreateAttempts: 1,
      inputs: speech.operations[0]!.inputs, parameters: { resolution: "1024x1024", aspectRatio: "1:1" } }], finalOutput: { operationId: "image", outputSlot: "image" } };
    for (const spec of [speech, image]) {
      const prepared = await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec });
      const accepted = f.app.service.acceptProposal("local-owner", prepared.proposal.id, { commandId: cmd(), proposalDigest: prepared.proposal.digest });
      const result = await driveToTerminal(f, accepted.run.id);
      assert.equal(result.state, "succeeded");
      assert.ok(result.outputRevisions.length > 0);
      assert.equal(works(f).length, 0, "独立非视频生产没有空白视频事项");
      assert.equal((await f.app.app.inject({ method: "GET", url: `/api/agent/v1/works/${result.workId}` })).statusCode, 404);
    }
  } finally { await f.close(); }
});

// —— B3/V4：成对交付与“认可内容，查看对应方案” ——
it("B3 成对改稿：内容与对应方案同批交付；配对在场时认可内容只记录，不排文本模型", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "第一版内容")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("内容草稿。")]);
    const contentV1 = revisionDraftOf(f, work.id);
    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: contentV1 })).statusCode, 202);
    await waitIdle(f);
    await turn(f, [deliverStep([scriptItem("山路方案", "第一版方案")],
      [{ workId: work.id, stage: "plan", itemIndex: 0, source: contentV1, proposalRef: null }]), fauxAssistantMessage("方案草稿。")]);
    const planV1 = workOf(f, work.id).stages.plan.draft!;
    assert.ok(planV1 && planV1.kind === "artifact_revision", "方案主稿应是产物修订");
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_plan", subject: planV1 })).statusCode, 202);

    // 成对改稿：内容 v2 与方案 v2 同批交付；方案 source 用 delivery_item 指向本批内容项，不关联提案。
    const contentArtifact = artifactOf(f, "山路内容"), planArtifact = artifactOf(f, "山路方案");
    await turn(f, [deliverStep([
      { mode: "revise", artifactId: contentArtifact.id, baseRevisionId: contentArtifact.revisionId, title: "山路内容", kind: "script",
        content: { format: "markdown", text: "第二版内容" } },
      { mode: "revise", artifactId: planArtifact.id, baseRevisionId: planArtifact.revisionId, title: "山路方案", kind: "script",
        content: { format: "markdown", text: "按新内容改的第二版方案" } },
    ], [
      { workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null },
      { workId: work.id, stage: "plan", itemIndex: 1, source: { kind: "delivery_item", itemIndex: 0 }, proposalRef: null },
    ]), fauxAssistantMessage("两份新稿一起看。")]);

    const paired = workOf(f, work.id);
    const contentV2 = paired.stages.content.draft as Extract<ContentSource, { kind: "artifact_revision" }>;
    const planV2 = paired.stages.plan.draft as Extract<ContentSource, { kind: "artifact_revision" }>;
    assert.notEqual(contentV2.revisionId, contentV1.revisionId, "内容出现成对新稿");
    assert.notEqual(planV2.revisionId, planV1.revisionId, "方案出现成对新稿");
    const approvedContent = paired.stages.content.approved;
    assert.ok(approvedContent?.kind === "artifact_revision" && approvedContent.revisionId === contentV1.revisionId, "成对交付不暗中认可新内容");
    assert.equal(paired.stages.plan.proposalId, null, "成对方案是讨论稿，不挂靠提案");
    assert.equal(paired.stages.plan.upstreamStale, false, "方案来源正是同批新内容");
    const planBinding = JSON.parse((f.app.database.prepare("SELECT creation_binding_json AS binding FROM artifact_revisions WHERE id = ?")
      .get(planV2.revisionId) as { binding: string }).binding) as { source: { revisionId?: string } };
    assert.equal(planBinding.source.revisionId, contentV2.revisionId, "delivery_item 在交付事务里解析为真实内容修订");

    // 配对在场：认可内容并继续只补记认可并展示对应方案，不再排一次文本模型（未预置任何 Faux 响应）。
    const assistantBefore = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.filter(item => item.role === "assistant").length;
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: contentV2 })).statusCode, 202);
    await waitIdle(f);
    const after = workOf(f, work.id);
    const approvedAfter = after.stages.content.approved;
    assert.ok(approvedAfter?.kind === "artifact_revision" && approvedAfter.revisionId === contentV2.revisionId, "新内容已认可并继续");
    assert.equal(after.stages.content.confirmationAction, "approve_content_continue");
    assert.ok(after.stages.plan.draft?.kind === "artifact_revision" && after.stages.plan.draft.revisionId === planV2.revisionId,
      "对应方案保持原样，不重新生成");
    const messages = f.app.service.snapshot("local-owner", f.conversation.id).messages.items;
    assert.equal(messages.filter(item => item.role === "assistant").length, assistantBefore, "没有新的模型回合");
    assert.ok(!messages.some(item => item.state === "failed"), "没有失败回合");
  } finally { await f.close(); }
});

// —— B2.5：指向片段的意见在入口核对运行归属与片段存在性 ——
it("B2.5 指向片段的意见核对运行与事项归属；段不在运行片段里或运行不存在时拒绝", async () => {
  const f = await setup(); try {
    await turn(f, [startWorkStep("山路视频"), fauxAssistantMessage("已开始。")]);
    const work = works(f)[0]!;
    await turn(f, [deliverStep([scriptItem("山路内容", "内容")],
      [{ workId: work.id, stage: "content", itemIndex: 0, source: null, proposalRef: null }]), fauxAssistantMessage("内容草稿。")]);
    const content = revisionDraftOf(f, work.id);
    f.app.faux!.setResponses([fauxAssistantMessage("进入画面阶段。")]);
    assert.equal((await confirmButton(f, { workId: work.id, action: "approve_content_continue", subject: content })).statusCode, 202);
    await waitIdle(f);
    await turn(f, [deliverStep([scriptItem("配音底稿", "旁白文本。")]), fauxAssistantMessage("底稿交付。")]);
    const narration = artifactOf(f, "配音底稿");
    const narrationRevision = f.app.service.readRevision("local-owner", narration.id, narration.revisionId);
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: speechSpec(work.id, narration, narrationRevision, "山路配音") })).proposal;
    const runId = f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest }).run.id;

    await turn(f, [startWorkStep("咖啡视频"), fauxAssistantMessage("第二条已开始。")]);
    const coffee = works(f).find(item => item.title === "咖啡视频")!;
    const send = (workId: string, runIdOfSegment: string, segmentId: string) =>
      f.app.service.addFeedback("local-owner", f.conversation.id, {
        commandId: cmd(), text: "第二段再紧一点。",
        target: { artifactId: narration.id, revisionId: narration.revisionId, workId, segment: { runId: runIdOfSegment, segmentId } },
      });
    assert.throws(() => send(coffee.id, runId, "seg-1"), /属于其他视频事项/);
    assert.throws(() => send(work.id, runId, "seg-none"), /不在这份运行的片段列表里/);
    assert.throws(() => send(work.id, "run-does-not-exist", "seg-1"), /运行不存在/);
  } finally { await f.close(); }
});

// —— 包 C：作品库与定位窗口 ——
// 两条用例共用“真实链路走到可定稿视频”的样板（真实交付事务 + 公开受理 + worker 终态）；
// 方案关联覆盖两种真实入口：准备时显式引用（§10.1）与 R1.3 的交付事务补绑。

async function produceFinalizableVideo(f: Fixture, title: string, planBoundAtPrepare: boolean) {
  await turn(f, [deliverStep([{ mode: "create", title: `${title} 提示`, kind: "prompt", content: { format: "markdown", text: `${title}的固定镜头提示。` } }]), fauxAssistantMessage("已交付。")]);
  const input = artifactOf(f, `${title} 提示`);
  const inputRevision = f.app.service.readRevision("local-owner", input.id, input.revisionId);
  const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
  const work = seedPlanStageWork(f.app.database, new Date().toISOString(), scope, title);
  const spec: ProductionIntent = { workId: work.workId, title,
    inputRevisions: [{ artifactId: input.id, revisionId: input.revisionId }],
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
      inputs: [{ kind: "artifact_revision", artifactId: input.id, revisionId: input.revisionId, digest: inputRevision.digest }],
      maxCreateAttempts: 1, parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, maxSpend: { currency: "CNY", amountMinor: 1200 } };
  let planDraft: Extract<ContentSource, { kind: "artifact_revision" }> | null = null;
  let proposal: Proposal;
  if (planBoundAtPrepare) {
    deliverPlanDraft(f.app.database, new Date().toISOString(), scope, work, null, `${title} 方案`);
    planDraft = workOf(f, work.workId).stages.plan.draft as Extract<ContentSource, { kind: "artifact_revision" }>;
    assert.ok(planDraft, "方案主稿应是产物修订");
    proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec, planSource: { artifactId: planDraft.artifactId, revisionId: planDraft.revisionId } })).proposal;
  } else {
    proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec })).proposal;
    bindPreparedPlan(f.app.database, new Date().toISOString(), scope, proposal, work);
  }
  const accepted = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${proposal.id}/acceptances`, headers,
    payload: { commandId: cmd(), proposalDigest: proposal.digest } });
  assert.equal(accepted.statusCode, 202);
  const runId = accepted.json().run.id as string;
  assert.equal((await driveToTerminal(f, runId)).state, "succeeded");
  const video = workOf(f, work.workId).stages.video.draft;
  assert.ok(video?.kind === "artifact_revision", "制作产出登记为视频初稿");
  return { work, proposal, runId, video, planDraft };
}

const finalizeVideo = (f: Fixture, workId: string, video: Extract<ContentSource, { kind: "artifact_revision" }>) =>
  f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers,
    payload: { ...chatInput("定稿这版成片"), stageConfirmation: { workId, action: "finalize_video", subject: video } } });

it("C1 作品库只收定稿视频：按修订去重不顶前，方案与文稿取定稿时关联，缺关联标未记录", async () => {
  const f = await setup(); try {
    const a = await produceFinalizableVideo(f, "山路短片", true);
    const b = await produceFinalizableVideo(f, "咖啡短片", false);

    // 先定稿 A，再定稿 B；A 定稿两次（不同按钮消息＝不同 sourceId，认可内核会各记一行真实确认）。
    assert.equal((await finalizeVideo(f, a.work.workId, a.video)).statusCode, 202);
    // §10.1 之前受理、且迁移无关系可回填的历史提案是 plan=null 的唯一真实人群；清空 B 的持久关系模拟该历史形状。
    f.app.database.prepare("UPDATE proposals SET plan_source_json = NULL WHERE id = ?").run(b.proposal.id);
    assert.equal((await finalizeVideo(f, b.work.workId, b.video)).statusCode, 202);
    assert.equal((await finalizeVideo(f, a.work.workId, a.video)).statusCode, 202);
    assert.equal(countIn(f, "FROM work_stage_confirmations WHERE action = 'finalize_video'"), 3, "重复认可是真实第二行确认");

    const firstFinalizeA = (f.app.database.prepare(
      "SELECT created_at FROM work_stage_confirmations WHERE action = 'finalize_video' AND json_extract(subject_json, '$.revisionId') = ? ORDER BY rowid LIMIT 1")
      .get(a.video.revisionId) as { created_at: string }).created_at;
    const firstFinalizeB = (f.app.database.prepare(
      "SELECT created_at FROM work_stage_confirmations WHERE action = 'finalize_video' AND json_extract(subject_json, '$.revisionId') = ? ORDER BY rowid LIMIT 1")
      .get(b.video.revisionId) as { created_at: string }).created_at;

    const library = await f.app.app.inject({ method: "GET", url: "/api/agent/v1/library/videos", headers: { origin } });
    assert.equal(library.statusCode, 200);
    const page = library.json();
    assert.equal(page.items.length, 2, "重复定稿只出一条，且未定稿的视频/仅内容认可的事项都不入库");
    const [entryB, entryA] = page.items;
    assert.equal(entryB.title, "咖啡短片", "B 首次定稿晚于 A，排在最前");
    assert.equal(entryA.title, "山路短片", "A 重复定稿不把它顶回最前");
    assert.equal(entryA.finalizedAt, firstFinalizeA, "条目时间取首次定稿，不是最近一次重复认可");
    assert.equal(entryB.finalizedAt, firstFinalizeB);

    // A：完整链路——视频修订、方案修订、文稿来源（聊天原文）与产出消息都指向定稿那一刻的不可变事实。
    assert.deepEqual(entryA.video, { artifactId: a.video.artifactId, revisionId: a.video.revisionId });
    assert.equal(entryA.workId, a.work.workId);
    assert.equal(entryA.conversationId, f.conversation.id);
    assert.deepEqual(entryA.plan, { artifactId: a.planDraft!.artifactId, revisionId: a.planDraft!.revisionId });
    assert.deepEqual(entryA.content, a.work.content);
    const noticeA = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.references.runIds.includes(a.runId));
    assert.ok(noticeA, "终态应已插入产出消息");
    assert.equal(entryA.originMessageId, noticeA.id);

    // B：历史提案缺方案关系 → 方案与文稿如实标未记录，不拿当前稿补齐；视频事实仍在。
    assert.equal(entryB.plan, null);
    assert.equal(entryB.content, null);
    assert.deepEqual(entryB.video, { artifactId: b.video.artifactId, revisionId: b.video.revisionId });
    const noticeB = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(item => item.role === "system_notice" && item.references.runIds.includes(b.runId));
    assert.equal(entryB.originMessageId, noticeB!.id);

    // 重复定稿后历史条目不变：条目仍指向首认时的同一批不可变修订。
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
    const a = await produceFinalizableVideo(f, "山路短片", false);
    assert.equal((await finalizeVideo(f, a.work.workId, a.video)).statusCode, 202);
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
    const otherWork = seedPlanStageWork(f.app.database, new Date().toISOString(), { ownerId: "local-owner", conversationId: second.id }, "他事项");
    const cross = await f.app.app.inject({ method: "GET", url: `${base}?anchorMessageId=${otherWork.content.kind === "message_text" ? otherWork.content.messageId : ""}`, headers: { origin } });
    assert.equal(cross.statusCode, 404);
    assert.equal(cross.json().code, "NOT_FOUND");
  } finally { await f.close(); }
});
