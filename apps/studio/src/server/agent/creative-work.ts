import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import { missingApprovalText, missingRequiredApprovals } from "./artifact-store.js";
import { getMessageRow, type MessageRow } from "./conversation-store.js";
import { canonicalJson, newAgentId } from "./util.js";
import type { WorkFeedbackView } from "../../shared/agent/ports.js";
import type {
  ArtifactHead, ContentSource, ContentSourceInput, CreationBinding, ReviewConfirmation, ReviewRole, RevisionRef,
  StandaloneArtifactConfirmation, Target, Work, WorkReviewConfirmation,
} from "../../shared/agent/generated/contracts.js";

// 视频创作事项：审阅组（角色/背景/分镜…）与组内事项的最小持久事实。
// 只在用户正式开始一条视频时建立；普通聊天和独立文稿不创建事项。
// 认可保存“认可了哪份不可变对象”与“本次真实用户动作来源”，不把两者混为一个字段。

export interface WorkRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  title: string;
  creation_state_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

// 存储形状与契约 ReviewGroup/ReviewItem 同构；approved 三字段同空同有。
export interface StoredReviewItem {
  id: string;
  label: string;
  role: ReviewRole;
  required: boolean;
  draft: ContentSource | null;
  approved: ContentSource | null;
  confirmationId: string | null;
  approvedAt: string | null;
}

export interface StoredReviewGroup {
  id: string;
  title: string;
  revision: number;
  items: StoredReviewItem[];
  nextIntent: string | null;
}

export interface CreationState {
  groups: StoredReviewGroup[];
}

export function emptyCreationState(): CreationState {
  return { groups: [] };
}

export function parseCreationState(row: Pick<WorkRow, "creation_state_json">): CreationState {
  if (!row.creation_state_json) return emptyCreationState();
  const stored = JSON.parse(row.creation_state_json) as Partial<CreationState>;
  return { groups: Array.isArray(stored.groups) ? stored.groups : [] };
}

export function getWorkRow(db: AgentDatabase, ownerId: string, workId: string): WorkRow | undefined {
  return db.prepare("SELECT * FROM works WHERE id = ? AND owner_id = ? AND creation_state_json IS NOT NULL").get(workId, ownerId) as WorkRow | undefined;
}

export function requireWork(db: AgentDatabase, ownerId: string, conversationId: string, workId: string): WorkRow {
  const row = getWorkRow(db, ownerId, workId);
  if (!row || row.conversation_id !== conversationId) throw new AgentError("NOT_FOUND", "没有找到这条视频创作。");
  return row;
}

export function createWork(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  title: string,
): WorkRow {
  const id = newAgentId("work");
  db.prepare(
    "INSERT INTO works(id, owner_id, conversation_id, title, creation_state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(id, scope.ownerId, scope.conversationId, title, canonicalJson(emptyCreationState()), now, now);
  insertEvent(db, now, {
    conversationId: scope.conversationId, ownerId: scope.ownerId,
    kind: "work.changed", entityId: id, entityVersion: 1,
  });
  return getWorkRow(db, scope.ownerId, id)!;
}

// 状态写入与事件同事务；revision 仅用于现有事件投影。
export function writeWorkState(
  db: AgentDatabase,
  now: string,
  row: WorkRow,
  state: CreationState,
): WorkRow {
  const revision = row.revision + 1;
  db.prepare("UPDATE works SET creation_state_json = ?, revision = ?, updated_at = ? WHERE id = ?")
    .run(canonicalJson(state), revision, now, row.id);
  insertEvent(db, now, {
    conversationId: row.conversation_id, ownerId: row.owner_id,
    kind: "work.changed", entityId: row.id, entityVersion: revision,
  });
  return getWorkRow(db, row.owner_id, row.id)!;
}

export function sameContentSource(left: ContentSource | null, right: ContentSource | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

// 在途制作判定（queued 起即冻结，终结后放行）；与 production_runs 的在途唯一索引同一状态集合。
// 冻结只约束新的制作受理；后继草稿保存与独立认可不因此阻塞（§4.2.1）。
export function workInFlight(db: AgentDatabase, workId: string): boolean {
  return Boolean(db.prepare(
    "SELECT id FROM production_runs WHERE work_id = ? AND state IN ('queued','running','unknown','cancel_requested') LIMIT 1",
  ).get(workId));
}

// 内容来源采用边界：引用真实消息的精确文本（作者由消息推导，模型不能自报），
// 或引用本会话中真实存在的不可变修订及其摘要。
export function resolveContentSource(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  source: ContentSourceInput,
): ContentSource {
  if (source.kind === "message_text") {
    const message = db.prepare("SELECT * FROM messages WHERE id = ? AND owner_id = ?").get(source.messageId, scope.ownerId) as MessageRow | undefined;
    if (!message || message.conversation_id !== scope.conversationId) throw new AgentError("NOT_FOUND", "引用的消息不存在或不属于当前会话。");
    if (message.role !== "user" && message.role !== "assistant") throw new AgentError("INVALID_INPUT", "引用消息必须是一条真实用户或助手消息。");
    if (message.text !== source.text) throw new AgentError("INVALID_INPUT", "采用的文字必须与所引用消息的原文逐字一致。");
    return { kind: "message_text", messageId: message.id, text: message.text, author: message.role };
  }
  const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ? AND owner_id = ? AND conversation_id = ?")
    .get(source.artifactId, scope.ownerId, scope.conversationId);
  const revision = artifact ? db.prepare("SELECT * FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
    .get(source.artifactId, source.revisionId) as { digest: string } | undefined : undefined;
  if (!artifact || !revision) throw new AgentError("NOT_FOUND", "引用的产物修订不存在或不属于当前会话。");
  if (revision.digest !== source.digest) throw new AgentError("INVALID_INPUT", "引用的产物修订摘要不一致。");
  return { kind: "artifact_revision", artifactId: source.artifactId, revisionId: source.revisionId, digest: source.digest };
}

function revisionBindingJson(db: AgentDatabase, artifactId: string, revisionId: string): unknown | null {
  const row = db.prepare("SELECT creation_binding_json FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
    .get(artifactId, revisionId) as { creation_binding_json: string | null } | undefined;
  return row?.creation_binding_json ? JSON.parse(row.creation_binding_json) : null;
}

// 历史修订的旧固定阶段 binding（只读）：受理/失效核对旧提案时使用。
export function legacyRevisionStageBinding(db: AgentDatabase, artifactId: string, revisionId: string): { workId: string; stage: string; source: ContentSource | null } | null {
  const binding = revisionBindingJson(db, artifactId, revisionId);
  if (!binding || typeof binding !== "object" || !("stage" in binding)) return null;
  return binding as { workId: string; stage: string; source: ContentSource | null };
}

export type ConfirmationOrigin =
  | { kind: "user_message"; messageId: string }
  | { kind: "pi_tool"; sourceId: string };

export interface RecordedReviewItem {
  itemId: string;
  confirmationId: string;
  duplicate: boolean;
}

// 只限制这条结构化用户消息授权的认可动作；普通自然语言没有 metadata，仍可表达复合意图。
export function assertReviewActionSource(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  input: ReviewConfirmation,
  origin: ConfirmationOrigin,
): void {
  if (origin.kind !== "user_message") return;
  const message = getMessageRow(db, scope.ownerId, origin.messageId);
  if (!message || message.conversation_id !== scope.conversationId || message.role !== "user") {
    throw new AgentError("NOT_FOUND", "没有找到本次用户认可消息。");
  }
  if (!message.review_confirmation_json) return;
  const original = JSON.parse(message.review_confirmation_json) as ReviewConfirmation;
  let matches = false;
  if ("kind" in original) {
    if (original.kind === "standalone_artifact") {
      matches = "kind" in input && input.kind === "standalone_artifact" && input.action === original.action
        && input.artifactId === original.artifactId && input.revisionId === original.revisionId;
    } else {
      matches = "kind" in input && input.kind === "adopt_preview" && input.action === original.action
        && input.workId === original.workId && input.groupId === original.groupId && input.itemId === original.itemId
        && canonicalJson(input.source) === canonicalJson(original.source);
    }
  } else if (!("kind" in input)) {
    matches = input.action === original.action && input.workId === original.workId && input.groupId === original.groupId
      && input.items.every(entry => original.items.some(allowed => allowed.itemId === entry.itemId
        && canonicalJson(allowed.source) === canonicalJson(entry.source)));
  }
  if (!matches) throw new AgentError("INVALID_INPUT", "本次用户消息的认可动作、目标或版本与原始动作不一致。");
}

// 精确修订必须在本次用户表达前已交付。两个顺序都来自 events；消息领取/完成的后续事件不代表新授权。
export function assertReviewSourceAvailable(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  source: RevisionRef,
  origin: ConfirmationOrigin,
): void {
  if (origin.kind !== "user_message") return;
  const facts = db.prepare(`SELECT
      (SELECT MIN(e.seq) FROM events e WHERE e.conversation_id = a.conversation_id AND e.owner_id = a.owner_id
        AND e.kind = 'message.changed' AND e.entity_id = ?) AS message_seq,
      (SELECT MIN(e.seq) FROM events e WHERE e.conversation_id = a.conversation_id AND e.owner_id = a.owner_id
        AND e.kind = 'artifact.delivered' AND e.entity_id = a.id AND e.entity_version = r.revision_number) AS delivered_seq
    FROM artifact_revisions r JOIN artifacts a ON a.id = r.artifact_id
    WHERE a.id = ? AND r.id = ? AND a.owner_id = ? AND a.conversation_id = ?`)
    .get(origin.messageId, source.artifactId, source.revisionId, scope.ownerId, scope.conversationId) as
      { message_seq: number | null; delivered_seq: number | null } | undefined;
  if (!facts) throw new AgentError("NOT_FOUND", "引用的产物修订不存在或不属于当前会话。");
  if (facts.message_seq === null || facts.delivered_seq === null || facts.delivered_seq >= facts.message_seq) {
    throw new AgentError("INVALID_INPUT", "这份修订在本次用户消息发出前尚未交付，不能提前认可未来产物。");
  }
}

// 按钮与 Pi confirm_review 工具共用的认可内核：只记录用户已经表达的认可，
// 不排模型请求、不推进未明确要求的下一组工作，也不产生制作运行。
// 在途制作不阻塞认可（§4.2.1）；新制作受理由 production_runs 的在途唯一索引约束。
export function recordReviewConfirmation(
  db: AgentDatabase, now: string, scope: { ownerId: string; conversationId: string },
  input: WorkReviewConfirmation, origin: ConfirmationOrigin,
): { items: RecordedReviewItem[]; work: WorkRow };
export function recordReviewConfirmation(
  db: AgentDatabase, now: string, scope: { ownerId: string; conversationId: string },
  input: StandaloneArtifactConfirmation, origin: ConfirmationOrigin,
): { kind: "standalone_artifact"; confirmationId: string };
export function recordReviewConfirmation(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  input: WorkReviewConfirmation | StandaloneArtifactConfirmation,
  origin: ConfirmationOrigin,
): { items: RecordedReviewItem[]; work: WorkRow } | { kind: "standalone_artifact"; confirmationId: string } {
  assertReviewActionSource(db, scope, input, origin);
  if ("kind" in input) {
    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ? AND owner_id = ? AND conversation_id = ?")
      .get(input.artifactId, scope.ownerId, scope.conversationId) as
        { kind: string; work_id: string | null; head_revision_id: string | null } | undefined;
    if (!artifact) throw new AgentError("NOT_FOUND", "没有找到这份独立脚本。");
    if (artifact.kind !== "script" || artifact.work_id !== null) {
      throw new AgentError("INVALID_INPUT", "独立认可只能作用于不属于视频作品的脚本。");
    }
    if (artifact.head_revision_id !== input.revisionId) {
      throw new AgentError("STALE_REVISION", "这份脚本已更新，请认可当前版本。", { currentRevisionId: artifact.head_revision_id });
    }
    assertReviewSourceAvailable(db, scope, input, origin);
    const revision = db.prepare("SELECT digest FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
      .get(input.artifactId, input.revisionId) as { digest: string };
    const subject: ContentSource = { kind: "artifact_revision", artifactId: input.artifactId, revisionId: input.revisionId, digest: revision.digest };
    const existing = db.prepare(`SELECT id FROM work_review_confirmations
      WHERE owner_id = ? AND conversation_id = ? AND subject_scope = 'standalone_artifact' AND action = 'approve' AND subject_json = ?
      ORDER BY rowid DESC LIMIT 1`).get(scope.ownerId, scope.conversationId, canonicalJson(subject)) as { id: string } | undefined;
    const confirmationId = existing?.id ?? newAgentId("confirm");
    if (!existing) {
      db.prepare(`INSERT INTO work_review_confirmations(id,owner_id,conversation_id,subject_scope,work_id,group_id,item_id,action,subject_json,source_kind,source_id,created_at)
        VALUES (?,?,?,'standalone_artifact',NULL,NULL,NULL,'approve',?,?,?,?)`)
        .run(confirmationId, scope.ownerId, scope.conversationId, canonicalJson(subject), origin.kind,
          origin.kind === "user_message" ? origin.messageId : origin.sourceId, now);
    }
    if (origin.kind === "user_message") {
      const message = getMessageRow(db, scope.ownerId, origin.messageId)!;
      const references = JSON.parse(message.references_json) as { artifacts: RevisionRef[] };
      if (!references.artifacts.some(ref => ref.artifactId === input.artifactId && ref.revisionId === input.revisionId)) {
        references.artifacts.push({ artifactId: input.artifactId, revisionId: input.revisionId });
        db.prepare("UPDATE messages SET references_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(canonicalJson(references), now, message.id);
        insertEvent(db, now, { ...scope, kind: "message.changed", entityId: message.id, entityVersion: message.revision + 1 });
      }
    }
    return { kind: "standalone_artifact", confirmationId };
  }
  for (const entry of input.items) {
    if (entry.source.kind === "artifact_revision") {
      assertReviewSourceAvailable(db, scope, entry.source, origin);
    } else if (origin.kind === "user_message") {
      const sourceMessage = getMessageRow(db, scope.ownerId, entry.source.messageId);
      const actionMessage = getMessageRow(db, scope.ownerId, origin.messageId)!;
      if (sourceMessage && sourceMessage.created_seq > actionMessage.created_seq) {
        throw new AgentError("INVALID_INPUT", "本次用户消息发出后才出现的内容不能提前认可。");
      }
    }
  }
  return recordWorkReviewConfirmation(db, now, scope, input, origin);
}

// adopt_preview 已核对原预览及来源后，在同一组合事务中把派生视频交给此内核写定稿事实。
export function recordWorkReviewConfirmation(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  input: WorkReviewConfirmation,
  origin: ConfirmationOrigin,
): { items: RecordedReviewItem[]; work: WorkRow } {
  const work = requireWork(db, scope.ownerId, scope.conversationId, input.workId);
  const state = parseCreationState(work);
  const group = state.groups.find(item => item.id === input.groupId);
  if (!group) throw new AgentError("NOT_FOUND", "没有找到这个审阅组。");
  const sourceKind = origin.kind === "user_message" ? "user_message" : "pi_tool";
  const sourceId = origin.kind === "user_message" ? origin.messageId : origin.sourceId;
  const recorded: RecordedReviewItem[] = [];
  let changed = false;

  for (const entry of input.items) {
    const item = group.items.find(candidate => candidate.id === entry.itemId);
    if (!item) throw new AgentError("NOT_FOUND", `审阅组里没有事项 ${entry.itemId}。`);
    const subject = resolveContentSource(db, scope, entry.source);
    if (input.action === "finalize_video") {
      if (item.role !== "video") throw new AgentError("INVALID_INPUT", "定稿只能作用于视频事项。");
      if (subject.kind !== "artifact_revision") throw new AgentError("INVALID_INPUT", "定稿只能指向真实视频修订。");
      const artifact = db.prepare("SELECT kind FROM artifacts WHERE id = ? AND owner_id = ? AND conversation_id = ?")
        .get(subject.artifactId, scope.ownerId, scope.conversationId) as { kind: string } | undefined;
      if (!artifact || artifact.kind !== "video") throw new AgentError("INVALID_INPUT", "定稿只能指向真实视频产物。");
      if (!item.draft) throw new AgentError("INVALID_INPUT", "还没有可定稿的视频初稿。");
      if (!sameContentSource(item.draft, subject)) throw new AgentError("INVALID_INPUT", "定稿只能指向当前视频草稿。");
      const binding = revisionBindingJson(db, subject.artifactId, subject.revisionId) as CreationBinding | null;
      if (binding && Array.isArray(binding.inputSources)) {
        const missing = missingRequiredApprovals(db, scope, work.id, {
          revisions: binding.inputSources.flatMap(source => source.kind === "artifact_revision" ? [source] : []),
          projects: [binding.projectRevision, ...(binding.projectRevisions ?? [])].filter(ref => ref != null),
        });
        if (missing.length) throw new AgentError("INVALID_INPUT", `定稿前，「${missingApprovalText(missing).join("」「")}」这一版还未获得认可。`);
      }
    } else if (item.draft) {
      // 认可作用于事项准确当前稿：旧版本或其他来源一律拒绝，当前引用不倒退。
      if (!sameContentSource(item.draft, subject)) {
        throw new AgentError("INVALID_INPUT", `这份${item.label}不是当前稿，请认可当前版本。`);
      }
    } else {
      // 尚无当前稿：只有内容事项允许首次明确采用（含较早的真实消息/独立稿）建立来源。
      if (item.role !== "content") throw new AgentError("INVALID_INPUT", `还没有可认可的${item.label}当前稿。`);
      if (subject.kind === "artifact_revision") {
        const artifact = db.prepare("SELECT kind FROM artifacts WHERE id = ?").get(subject.artifactId) as { kind: string } | undefined;
        if (!artifact || !["script", "prompt", "analysis"].includes(artifact.kind)) {
          throw new AgentError("INVALID_INPUT", "内容认可必须指向文本稿件或聊天原文。");
        }
        const binding = revisionBindingJson(db, subject.artifactId, subject.revisionId) as { workId?: string } | null;
        if (binding?.workId && binding.workId !== work.id) throw new AgentError("INVALID_INPUT", "这份修订属于其他视频，不能作为本条视频的内容。");
      }
    }
    // 去重按 action 区分：普通认可看事项已认可的来源；定稿只认确认表里
    // 同事项同版本的既有 finalize_video 行，普通 approve 写入的 approved
    // 状态不能吞掉显式定稿（否则库查询永远查不到 finalize 记录）。
    let duplicateConfirmationId: string | null = null;
    if (input.action === "finalize_video") {
      const existing = db.prepare(
        `SELECT id FROM work_review_confirmations
         WHERE owner_id = ? AND subject_scope = 'work_item' AND work_id = ? AND group_id = ? AND item_id = ? AND action = 'finalize_video' AND subject_json = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(scope.ownerId, work.id, group.id, item.id, canonicalJson(subject)) as { id: string } | undefined;
      duplicateConfirmationId = existing?.id ?? null;
    } else if (sameContentSource(item.approved, subject) && item.confirmationId && item.approvedAt) {
      duplicateConfirmationId = item.confirmationId;
    }
    if (duplicateConfirmationId) {
      recorded.push({ itemId: item.id, confirmationId: duplicateConfirmationId, duplicate: true });
      continue;
    }
    const confirmationId = newAgentId("confirm");
    db.prepare(
      `INSERT INTO work_review_confirmations(id, owner_id, conversation_id, work_id, group_id, item_id, action, subject_json, source_kind, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(confirmationId, scope.ownerId, scope.conversationId, work.id, group.id, item.id, input.action, canonicalJson(subject), sourceKind, sourceId, now);
    item.approved = subject;
    item.approvedAt = now;
    item.confirmationId = confirmationId;
    if (!item.draft) item.draft = subject;
    changed = true;
    recorded.push({ itemId: item.id, confirmationId, duplicate: false });
  }
  const updated = changed ? writeWorkState(db, now, work, state) : work;
  return { items: recorded, work: updated };
}

// 组内事项草稿更新（交付/受理目标注册、运行产出登记共用）。
// 在途不阻塞后继草稿；组版本随草稿变化提升。
export function setReviewItemDraft(
  db: AgentDatabase,
  now: string,
  work: WorkRow,
  target: { groupId: string; itemId: string },
  source: ContentSource,
): WorkRow {
  const state = parseCreationState(work);
  const group = state.groups.find(item => item.id === target.groupId);
  const item = group?.items.find(candidate => candidate.id === target.itemId);
  if (!group || !item) throw new AgentError("NOT_FOUND", "草稿归属的审阅事项不存在。");
  item.draft = source;
  group.revision += 1;
  return writeWorkState(db, now, work, state);
}

// 运行产出登记：按受理冻结的目标事项落位（§4.2.1 no-clobber、§11.6 S4）。完成时不重新选择目标：
// 冻结基准 null 表示受理时该项确实无稿，只在完成时仍为空才落位；准确基准只在当前仍等于该版时更新；
// 省略基准不当作“此前无稿”，与 null 同样只在当前无稿时落位。目标已删除或旧历史运行缺冻结目标时
// 不覆盖、不改挂别项，产出保留为 run 结果。返回是否实际落位为当前草稿。
export function setVideoOutput(
  db: AgentDatabase,
  now: string,
  work: WorkRow,
  source: ContentSource,
  target: { groupId: string; itemId: string; baseRevisionId?: string | null } | null,
): boolean {
  if (!target) return false;
  const state = parseCreationState(work);
  const group = state.groups.find(candidate => candidate.id === target.groupId);
  const item = group?.items.find(candidate => candidate.id === target.itemId);
  if (!group || !item) return false;
  const currentDraft = item.draft?.kind === "artifact_revision" ? item.draft.revisionId : null;
  if (currentDraft !== (target.baseRevisionId ?? null)) return false;
  item.draft = source;
  group.revision += 1;
  writeWorkState(db, now, work, state);
  return true;
}

// 按真实当前引用解析产物归属：不依赖 artifacts.work_id 或交付前的 revision binding。
// 视频产物不允许聊天改写；同一产物被多个事项引用时要求本次显式目标，不任取第一项。
export function artifactWorkOwnership(
  db: AgentDatabase,
  artifact: { id: string; conversation_id: string },
  explicit?: { workId: string; groupId: string; itemId: string },
): { workId: string; groupId: string; itemId: string } | null {
  const works = db.prepare("SELECT * FROM works WHERE conversation_id = ?").all(artifact.conversation_id) as WorkRow[];
  const matches: { workId: string; groupId: string; itemId: string }[] = [];
  for (const work of works) {
    const state = parseCreationState(work);
    for (const group of state.groups) {
      for (const item of group.items) {
        if (item.role === "video" && item.draft?.kind === "artifact_revision" && item.draft.artifactId === artifact.id) {
          throw new AgentError("INVALID_INPUT", "制作产出的视频初稿不能在聊天里直接改写；修改请准备下一版。");
        }
        if (item.draft?.kind === "artifact_revision" && item.draft.artifactId === artifact.id) {
          matches.push({ workId: work.id, groupId: group.id, itemId: item.id });
        }
      }
    }
  }
  if (matches.length === 0) return null;
  if (explicit) {
    const match = matches.find(candidate => candidate.workId === explicit.workId && candidate.groupId === explicit.groupId && candidate.itemId === explicit.itemId);
    if (!match) throw new AgentError("INVALID_INPUT", "不能把已有主稿改挂到其他视频或审阅事项。");
    return match;
  }
  if (matches.length > 1) {
    throw new AgentError("INVALID_INPUT", "这份稿件同时被多条视频创作引用，修改时请在 reviewGroups 里明确本次归属。");
  }
  return matches[0]!;
}

// 相关意见只读查询（executor 上下文与 read_work 工具共用同一 SQL）：
// 先按准确 work/稿件集合过滤再限数，不让其他事项的意见挤掉本事项。
// artifact 意见经消息 target 命中；消息原文内容意见经 feedback 关联命中。
export function relatedWorkFeedback(
  db: AgentDatabase,
  conversationId: string,
  scope: { workIds: readonly string[]; artifactIds: readonly string[] },
  limit = 20,
): WorkFeedbackView[] {
  const workIds = [...new Set(scope.workIds)];
  const artifactIds = [...new Set(scope.artifactIds)];
  if (workIds.length === 0 && artifactIds.length === 0) return [];
  const clauses: string[] = [];
  const args: unknown[] = [conversationId];
  if (workIds.length > 0) {
    clauses.push(`COALESCE(json_extract(feedback_json, '$.workId'), json_extract(target_json, '$.workId')) IN (${workIds.map(() => "?").join(",")})`);
    args.push(...workIds);
  }
  if (artifactIds.length > 0) {
    clauses.push(`(COALESCE(json_extract(feedback_json, '$.workId'), json_extract(target_json, '$.workId')) IS NULL
      AND json_extract(target_json, '$.artifactId') IN (${artifactIds.map(() => "?").join(",")}))`);
    args.push(...artifactIds);
  }
  const rows = db.prepare(
    `SELECT id, text, target_json, feedback_json FROM messages
     WHERE conversation_id = ? AND feedback_json IS NOT NULL AND (${clauses.join(" OR ")})
     ORDER BY created_seq DESC LIMIT ?`,
  ).all(...args, limit) as { id: string; text: string; target_json: string | null; feedback_json: string }[];
  return rows.map(row => {
    // 旧意见没有 workId/contentSource 字段，读回为 null。
    const note = JSON.parse(row.feedback_json) as { workId?: string | null; contentSource?: ContentSource | null; disposition: WorkFeedbackView["disposition"] };
    return {
      messageId: row.id,
      text: row.text,
      target: row.target_json ? JSON.parse(row.target_json) as Target : null,
      workId: note.workId ?? null,
      contentSource: note.contentSource ?? null,
      applied: false as const,
      disposition: note.disposition,
    };
  });
}

export function withStandaloneApproval(db: AgentDatabase, artifact: ArtifactHead): ArtifactHead {
  if (artifact.kind !== "script" || artifact.workId !== null) return artifact;
  const confirmation = db.prepare(`SELECT id, subject_json, created_at FROM work_review_confirmations
    WHERE subject_scope = 'standalone_artifact' AND action = 'approve' AND json_extract(subject_json, '$.artifactId') = ?
    ORDER BY rowid DESC LIMIT 1`).get(artifact.id) as { id: string; subject_json: string; created_at: string } | undefined;
  if (!confirmation) return artifact;
  const subject = JSON.parse(confirmation.subject_json) as Extract<ContentSource, { kind: "artifact_revision" }>;
  return { ...artifact, standaloneApproval: {
    confirmationId: confirmation.id, revisionId: subject.revisionId, approvedAt: confirmation.created_at,
  } };
}

export function workProjection(db: AgentDatabase, row: WorkRow): Work {
  const state = parseCreationState(row);
  // finalizedSource 是只读投影：来自确认表里该事项最近的 finalize_video 行。
  // 非 video 事项没有 finalize 行，自然保持 null。
  const finalizeRows = db.prepare(
    `SELECT item_id, subject_json FROM work_review_confirmations
     WHERE owner_id = ? AND subject_scope = 'work_item' AND work_id = ? AND action = 'finalize_video'
     ORDER BY created_at ASC, rowid ASC`,
  ).all(row.owner_id, row.id) as { item_id: string; subject_json: string }[];
  const finalizedByItem = new Map<string, ContentSource>();
  for (const confirmation of finalizeRows) finalizedByItem.set(confirmation.item_id, JSON.parse(confirmation.subject_json) as ContentSource);
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    reviewGroups: state.groups.map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, finalizedSource: finalizedByItem.get(item.id) ?? null })),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkRows(db: AgentDatabase, conversationId: string, limit: number): WorkRow[] {
  return (db.prepare("SELECT * FROM works WHERE conversation_id = ? AND creation_state_json IS NOT NULL ORDER BY rowid DESC LIMIT ?")
    .all(conversationId, limit) as WorkRow[]).reverse();
}

// 分页页行：works 表没有 created_seq，页位置用插入序 rowid（需显式 SELECT）。取 limit+1 条
// newest-first，多出的一条仅用于判断“还有更早”，返回时剔除并给出下一页位置（页内最小 rowid）。
export function listWorkPageRows(db: AgentDatabase, conversationId: string, limit: number, beforeRowid?: number): { rows: WorkRow[]; nextBeforeRowid: number | null } {
  const rows = (beforeRowid === undefined
    ? db.prepare("SELECT rowid AS paging_rowid, * FROM works WHERE conversation_id = ? AND creation_state_json IS NOT NULL ORDER BY rowid DESC LIMIT ?")
    : db.prepare("SELECT rowid AS paging_rowid, * FROM works WHERE conversation_id = ? AND creation_state_json IS NOT NULL AND rowid < ? ORDER BY rowid DESC LIMIT ?")
  ).all(...(beforeRowid === undefined ? [conversationId, limit + 1] : [conversationId, beforeRowid, limit + 1])) as (WorkRow & { paging_rowid: number })[];
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  // 下一页从页内最旧一条（DESC 结果的第 limit 条）之前继续；多取的那条只用于判断还有更早。
  return { rows: page, nextBeforeRowid: hasMore ? rows[limit - 1]!.paging_rowid : null };
}

// 提案与方案主稿的准确关联现由 proposals.plan_source_json 持久承载（§10.1），
// 读取入口是 artifact-store.ts 的 proposalPlanSource；此处不再保留历史修订反查。

// 新 binding 是组模型 CreationBinding；旧修订的固定阶段 binding 由 legacyRevisionStageBinding 单独读取。
export function revisionCreationBinding<T>(db: AgentDatabase, artifactId: string, revisionId: string): T | null {
  return revisionBindingJson(db, artifactId, revisionId) as T | null;
}
