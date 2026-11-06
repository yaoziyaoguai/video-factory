import type { AgentDatabase } from "../../src/server/agent/db.js";
import { applyDelivery, productionNarrationText } from "../../src/server/agent/artifact-store.js";
import {
  emptyReferences, finalizeRequestMessages, getRequestRow, insertMessage, insertQueuedRequest, markRequestTerminal,
  nextQueueSeq, nextSeq,
} from "../../src/server/agent/conversation-store.js";
import { createWork, parseCreationState, recordStageConfirmation, type WorkRow } from "../../src/server/agent/creative-work.js";
import { newAgentId } from "../../src/server/agent/util.js";
import type { ContentSource, DeliveryReceipt, ProductionSpec, ToolDelivery } from "../../src/shared/agent/generated/contracts.js";

// 阶段边界夹具：用产品自己的内核（createWork / recordStageConfirmation / applyDelivery）把一条视频
// 推进到“内容已认可、方案主稿已与提案关联”，让渲染与制作套件专注自身语义，而不是各自重写阶段规则。
// 不直接手写 creation_binding_json，关联一律经真实交付事务写入。

export interface PlanStageWork {
  workId: string;
  content: ContentSource;
}

export function seedPlanStageWork(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  title = "测试视频",
): PlanStageWork {
  const work = createWork(db, now, scope, title);
  const messageId = newAgentId("msg"), text = `正式做一条视频：${title}`;
  insertMessage(db, now, {
    id: messageId, conversationId: scope.conversationId, ownerId: scope.ownerId, requestId: null,
    role: "user", kind: "chat", state: "completed", text, target: null,
    createdSeq: nextSeq(db, "messages", scope.conversationId), references: emptyReferences(),
  });
  recordStageConfirmation(db, now, scope, {
    workId: work.id, action: "approve_content_continue",
    subject: { kind: "message_text", messageId, text }, sourceKind: "user_message", sourceId: messageId,
  });
  return { workId: work.id, content: { kind: "message_text", messageId, text, author: "user" } };
}

// 按真实交付事务在会话里交付任意 items/stageDrafts：建立一条 running 请求 → applyDelivery →
// 收尾。分段投影等需要自定义稿件内容的用例与方案阶段夹具共用这一入口，不各自重写请求样板。
export function deliverStageDrafts(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  delivery: ToolDelivery,
): DeliveryReceipt {
  const requestId = newAgentId("req"), messageId = newAgentId("msg"), text = "把这一批稿件交付给我";
  insertMessage(db, now, {
    id: messageId, conversationId: scope.conversationId, ownerId: scope.ownerId, requestId,
    role: "user", kind: "chat", state: "running", text, target: null,
    createdSeq: nextSeq(db, "messages", scope.conversationId), references: emptyReferences(),
  });
  insertQueuedRequest(db, now, {
    id: requestId, conversationId: scope.conversationId, ownerId: scope.ownerId, commandId: requestId,
    text, target: null, skillId: null, modelId: null,
    queueSeq: nextQueueSeq(db, scope.conversationId), messageId,
  });
  db.prepare("UPDATE requests SET state='running', execution_epoch=1 WHERE id=?").run(requestId);
  const request = getRequestRow(db, scope.ownerId, requestId)!;
  const { receipt } = applyDelivery(db, now, { request, epoch: 1 }, delivery);
  // 真实回合在交付后由执行器收尾；夹具同样把请求与消息落到终态，不留悬挂的 running。
  markRequestTerminal(db, now, request, "completed");
  finalizeRequestMessages(db, now, request, "completed");
  return receipt;
}

// 方案主稿按真实交付事务写入：建立一条 running 请求，整批交付一份文本方案并关联该提案。
export function deliverPlanDraft(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  work: PlanStageWork,
  proposal: { id: string; digest: string } | null,
  title = "画面声音方案",
): DeliveryReceipt {
  const prepared = proposal ? db.prepare("SELECT spec_json FROM proposals WHERE id = ?").get(proposal.id) as { spec_json: string } | undefined : undefined;
  const narrationText = prepared ? productionNarrationText(db, JSON.parse(prepared.spec_json) as ProductionSpec) : null;
  return deliverStageDrafts(db, now, scope, {
    items: [{ mode: "create", title, kind: "script", content: { format: "markdown", text: `# ${title}\n\n镜头顺序与旁白安排。`,
      ...(narrationText !== null ? { narrationText } : {}) } }],
    stageDrafts: [{ workId: work.workId, stage: "plan", itemIndex: 0, source: work.content,
      proposalRef: proposal ? { proposalId: proposal.id, digest: proposal.digest } : null }],
  });
}

// 一条已推进到方案阶段、并把方案主稿关联到给定提案的视频。
export function bindPreparedPlan(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  proposal: { id: string; digest: string },
  existing?: PlanStageWork,
): PlanStageWork {
  const work = existing ?? seedPlanStageWork(db, now, scope, proposal.id);
  deliverPlanDraft(db, now, scope, work, proposal);
  return work;
}

// 需要“同一个会话里已有可准备视频的事项”的套件用这个：已有进入方案阶段的事项就直接复用，
// 否则按真实内核新建一条；跨重启读同一行，不重复塞入第二条创作事项。
export function ensurePlanStageWork(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  title = "测试视频",
): PlanStageWork {
  const rows = db.prepare("SELECT * FROM works WHERE conversation_id = ? AND owner_id = ? ORDER BY rowid DESC")
    .all(scope.conversationId, scope.ownerId) as WorkRow[];
  for (const row of rows) {
    const state = parseCreationState(row);
    if (state.stage !== "content" && state.content.draft) return { workId: row.id, content: state.content.draft };
  }
  return seedPlanStageWork(db, now, scope, title);
}
