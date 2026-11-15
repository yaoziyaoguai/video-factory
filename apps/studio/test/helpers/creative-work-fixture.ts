import type { AgentDatabase } from "../../src/server/agent/db.js";
import { applyDelivery } from "../../src/server/agent/artifact-store.js";
import {
  emptyReferences, finalizeRequestMessages, getRequestRow, insertMessage, insertQueuedRequest, markRequestTerminal,
  nextQueueSeq, nextSeq,
} from "../../src/server/agent/conversation-store.js";
import { createWork, parseCreationState, recordReviewConfirmation, type WorkRow } from "../../src/server/agent/creative-work.js";
import { newAgentId } from "../../src/server/agent/util.js";
import type { ContentSource, DeliveryReceipt, ReviewInputInput, ReviewTarget, ToolDelivery } from "../../src/shared/agent/generated/contracts.js";

// 组审阅夹具：用产品自己的内核（createWork / applyDelivery(reviewGroups) / recordReviewConfirmation）
// 把一条视频推进到“脚本组已交付并认可”，让渲染与制作套件直接引用真实认可事实（reviewInputs），
// 而不是各自重写组规则。不直接手写 creation_binding_json，关联一律经真实交付事务写入。

export interface ConfirmedReviewWork {
  workId: string;
  groupId: string;
  itemId: string;
  /** 已认可的脚本修订来源；可直接作为 inputSources 的引用事实。 */
  content: ContentSource;
  /** 可直接放进 ProductionIntent.reviewInputs 的认可依据。 */
  reviewInput: ReviewInputInput;
}

// 正式视频提案的交付目标夹具（F02）：声明新组成片事项，受理时分配身份；准备阶段不写占位草稿。
export function finalVideoTarget(label = "成片"): ReviewTarget {
  return {
    group: { mode: "create", key: "final", title: "成片审阅", nextIntent: null },
    item: { mode: "create", key: "video", label, role: "video", required: true },
  };
}

// 按真实交付事务在会话里交付任意 items/reviewGroups：建立一条 running 请求 → applyDelivery →
// 收尾。分段投影等需要自定义稿件内容的用例与认可夹具共用这一入口，不各自重写请求样板。
export function deliverReviewDrafts(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  delivery: ToolDelivery,
): { receipt: DeliveryReceipt; messageId: string } {
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
  return { receipt, messageId };
}

// 新建一条视频创作并推进到“脚本已认可”：脚本组一个内容事项，草稿为本次交付的脚本修订，
// 认可来源即该修订。制作套件从这里拿到 reviewInputs 需要的真实 confirmationId。
export function seedConfirmedWork(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  title = "测试视频",
): ConfirmedReviewWork {
  const work = createWork(db, now, scope, title);
  const seeded = deliverReviewDrafts(db, now, scope, {
    items: [{ mode: "create", title: `${title}脚本`, kind: "script",
      content: { format: "markdown", text: `# ${title}\n\n镜头顺序与旁白安排。` } }],
    reviewGroups: [{ workId: work.id,
      group: { mode: "create", key: "content", title: "脚本与内容", nextIntent: null },
      items: [{ item: { mode: "create", key: "script", label: "脚本", role: "content", required: true },
        itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "production" }] }],
  });
  const revision = seeded.receipt.revisions[0]!;
  const source = {
    kind: "artifact_revision" as const,
    artifactId: revision.artifactId, revisionId: revision.revisionId,
    digest: (db.prepare("SELECT digest FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
      .get(revision.artifactId, revision.revisionId) as { digest: string }).digest,
  };
  const item = parseCreationState(db.prepare("SELECT * FROM works WHERE id = ?").get(work.id) as WorkRow)
    .groups.flatMap(group => group.items.map(entry => ({ group, entry })))
    .find(({ entry }) => entry.draft?.kind === "artifact_revision" && entry.draft.revisionId === revision.revisionId)!;
  // 认可必须来自交付后的真实用户消息；交稿请求本身不能预先认可尚未出现的修订。
  const approvalMessageId = newAgentId("msg");
  insertMessage(db, now, {
    id: approvalMessageId, conversationId: scope.conversationId, ownerId: scope.ownerId, requestId: null,
    role: "user", kind: "chat", state: "completed", text: "认可这版脚本。", target: null,
    createdSeq: nextSeq(db, "messages", scope.conversationId), references: { ...emptyReferences(), artifacts: [revision] },
  });
  const [recorded] = recordReviewConfirmation(db, now, scope, {
    workId: work.id, groupId: item.group.id, items: [{ itemId: item.entry.id, source }], action: "approve",
  }, { kind: "user_message", messageId: approvalMessageId }).items;
  return {
    workId: work.id, groupId: item.group.id, itemId: item.entry.id, content: source,
    reviewInput: { groupId: item.group.id, itemId: item.entry.id, source, confirmationId: recorded!.confirmationId },
  };
}

// 需要“同一个会话里已有可认可脚本的视频”的套件用这个：已有带认可事实的事项就直接复用，
// 否则按真实内核新建一条；跨重启读同一行，不重复塞入第二条创作。
export function ensureConfirmedWork(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  title = "测试视频",
): ConfirmedReviewWork {
  const rows = db.prepare("SELECT * FROM works WHERE conversation_id = ? AND owner_id = ? ORDER BY rowid DESC")
    .all(scope.conversationId, scope.ownerId) as WorkRow[];
  for (const row of rows) {
    for (const group of parseCreationState(row).groups) {
      const item = group.items.find(candidate => candidate.role === "content"
        && candidate.approved?.kind === "artifact_revision" && candidate.confirmationId);
      if (item && item.approved) return {
        workId: row.id, groupId: group.id, itemId: item.id, content: item.approved,
        reviewInput: { groupId: group.id, itemId: item.id, source: item.approved, confirmationId: item.confirmationId! },
      };
    }
  }
  return seedConfirmedWork(db, now, scope, title);
}
