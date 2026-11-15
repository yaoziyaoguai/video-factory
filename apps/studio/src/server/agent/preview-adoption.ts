import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import { nextSeq } from "./conversation-store.js";
import {
  adoptedCreationBinding, getArtifactRow, insertRevision,
  resolveLocalOutput,
} from "./artifact-store.js";
import {
  assertReviewActionSource, assertReviewSourceAvailable, parseCreationState,
  recordWorkReviewConfirmation, requireWork, writeWorkState,
  type ConfirmationOrigin, type WorkRow,
} from "./creative-work.js";
import { canonicalJson, newAgentId } from "./util.js";
import type { AdoptPreviewConfirmation, ContentSource } from "../../shared/agent/generated/contracts.js";

// 已交付预览的一次明确采用：共享原媒体和制作来源，派生video并定稿在同一事务内完成。
// 不走deliver_artifacts关闭回合，也不改变原clip或建立新的制作运行。
export function adoptPreview(
  db: AgentDatabase, now: string,
  scope: { ownerId: string; conversationId: string },
  input: AdoptPreviewConfirmation, origin: ConfirmationOrigin,
): WorkRow {
  return db.transaction(() => {
    assertReviewActionSource(db, scope, input, origin);
    const work = requireWork(db, scope.ownerId, scope.conversationId, input.workId);
    const sourceId = origin.kind === "user_message" ? origin.messageId : origin.sourceId;
    const sourceKind = origin.kind === "user_message" ? "user_message" : "pi_tool";
    const previous = db.prepare(`SELECT 1 FROM work_review_confirmations c
      JOIN artifact_revisions r ON r.id=json_extract(c.subject_json,'$.revisionId')
      WHERE c.owner_id=? AND c.work_id=? AND c.source_kind=? AND c.source_id=?
        AND c.subject_scope='work_item' AND c.action='finalize_video'
        AND json_extract(r.creation_binding_json,'$.adoptedFrom.artifactId')=?
        AND json_extract(r.creation_binding_json,'$.adoptedFrom.revisionId')=? LIMIT 1`)
      .get(scope.ownerId, work.id, sourceKind, sourceId, input.source.artifactId, input.source.revisionId);
    if (previous) return work;

    const state = parseCreationState(work);
    const group = state.groups.find(entry => entry.id === input.groupId);
    const preview = group?.items.find(entry => entry.id === input.itemId);
    if (!preview || preview.role !== "clip" || preview.draft?.kind !== "artifact_revision"
      || preview.draft.artifactId !== input.source.artifactId || preview.draft.revisionId !== input.source.revisionId) {
      throw new AgentError("INVALID_INPUT", "请采用这个预览事项当前可审阅的准确版本。");
    }
    assertReviewSourceAvailable(db, scope, input.source, origin);
    const original = getArtifactRow(db, scope.ownerId, input.source.artifactId);
    if (!original || original.kind !== "video") throw new AgentError("INVALID_INPUT", "采用对象必须是真实视频预览。");
    const { content } = resolveLocalOutput(db, scope, "video", { kind: "artifact_revision", ...input.source });
    const target = { workId: work.id, groupId: newAgentId("grp"), itemId: newAgentId("item"), purpose: "production" as const };
    const binding = adoptedCreationBinding(db, input.source, target);
    // 原clip自身不必先普通认可；真正采用的依据统一由下方finalize内核核对，失败同事务回滚。
    const message = db.prepare("SELECT request_id FROM messages WHERE id=? AND owner_id=? AND conversation_id=?")
      .get(sourceId, scope.ownerId, scope.conversationId) as { request_id: string | null } | undefined;
    if (!message?.request_id) throw new AgentError("INVALID_INPUT", "定稿必须来自本次真实用户消息。");

    const artifactId = newAgentId("art");
    const title = `${original.title} · 成片`;
    db.prepare(`INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at)
      VALUES(?,?,?,?,'video',?,NULL,0,?,?,?)`)
      .run(artifactId, scope.conversationId, scope.ownerId, title, work.id, nextSeq(db, "artifacts", scope.conversationId), now, now);
    const revision = insertRevision(db, now, getArtifactRow(db, scope.ownerId, artifactId)!, null,
      { title, kind: "video", content }, message.request_id, binding);
    const subject: ContentSource = { kind: "artifact_revision", artifactId, revisionId: revision.id, digest: revision.digest };
    state.groups.push({ id: target.groupId, title: "成片", revision: 1, nextIntent: null,
      items: [{ id: target.itemId, label: "成片", role: "video", required: true, draft: subject,
        approved: null, confirmationId: null, approvedAt: null }] });
    writeWorkState(db, now, work, state);
    const confirmed = recordWorkReviewConfirmation(db, now, scope, {
      workId: work.id, groupId: target.groupId, items: [{ itemId: target.itemId, source: subject }], action: "finalize_video",
    }, origin);
    insertEvent(db, now, { ...scope, kind: "artifact.delivered", entityId: artifactId, entityVersion: revision.revision_number, notification: "new_output" });
    // 库回到对话锚定本次采用消息；references也保留源预览，旧制作run继续由binding追溯。
    const sourceMessage = db.prepare("SELECT references_json, revision FROM messages WHERE id=?").get(sourceId) as { references_json: string; revision: number };
    const references = JSON.parse(sourceMessage.references_json) as { artifacts: { artifactId: string; revisionId: string }[] };
    references.artifacts.push({ artifactId, revisionId: revision.id });
    db.prepare("UPDATE messages SET references_json=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(canonicalJson(references), now, sourceId);
    insertEvent(db, now, { ...scope, kind: "message.changed", entityId: sourceId, entityVersion: sourceMessage.revision + 1 });
    return confirmed.work;
  })();
}
