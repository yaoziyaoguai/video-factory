import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import type { MessageRow } from "./conversation-store.js";
import { canonicalJson, newAgentId } from "./util.js";
import type { WorkFeedbackView } from "../../shared/agent/ports.js";
import type {
  ContentSource, ContentSourceInput, Proposal, Target, Work, WorkStage, WorkStageView,
} from "../../shared/agent/generated/contracts.js";

// 视频创作事项：三个阶段（内容、画面/声音方案、视频初稿）的最小持久事实。
// 只在用户正式开始一条视频时建立；普通聊天和独立文稿不创建事项。
// 阶段认可保存“认可了哪份不可变对象”与“本次真实用户动作来源”，不把两者混为一个字段。

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

export interface StageState {
  draft: ContentSource | null;
  approved: ContentSource | null;
  approvedAt: string | null;
  confirmationId: string | null;
  proposalId: string | null;
  runId: string | null;
}

export interface CreationState {
  stage: WorkStage;
  content: StageState;
  plan: StageState;
  video: StageState;
}

export interface CreationBinding {
  workId: string;
  stage: WorkStage;
  source: ContentSource | null;
  proposalRef: { proposalId: string; digest: string } | null;
}

export type StageConfirmationAction = "approve_content" | "approve_content_continue" | "approve_plan" | "finalize_video";

const emptyStage = (): StageState => ({
  draft: null, approved: null, approvedAt: null, confirmationId: null, proposalId: null, runId: null,
});

export function emptyCreationState(): CreationState {
  return { stage: "content", content: emptyStage(), plan: emptyStage(), video: emptyStage() };
}

export function parseCreationState(row: Pick<WorkRow, "creation_state_json">): CreationState {
  if (!row.creation_state_json) return emptyCreationState();
  const stored = JSON.parse(row.creation_state_json) as Partial<CreationState>;
  return {
    stage: stored.stage ?? "content",
    content: { ...emptyStage(), ...stored.content },
    plan: { ...emptyStage(), ...stored.plan },
    video: { ...emptyStage(), ...stored.video },
  };
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
  const state = emptyCreationState();
  db.prepare(
    "INSERT INTO works(id, owner_id, conversation_id, title, creation_state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(id, scope.ownerId, scope.conversationId, title, canonicalJson(state), now, now);
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
  role: "content" | "plan" | "video",
): ContentSource {
  if (source.kind === "message_text") {
    if (role !== "content") throw new AgentError("INVALID_INPUT", "方案与成片认可只能指向真实产物修订。");
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

function revisionBinding(db: AgentDatabase, artifactId: string, revisionId: string): CreationBinding | null {
  const row = db.prepare("SELECT creation_binding_json FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
    .get(artifactId, revisionId) as { creation_binding_json: string | null } | undefined;
  return row?.creation_binding_json ? JSON.parse(row.creation_binding_json) as CreationBinding : null;
}

function requireWorkRevision(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  workId: string,
  source: ContentSource,
  stage: WorkStage,
): void {
  if (source.kind !== "artifact_revision") throw new AgentError("INVALID_INPUT", "方案与成片认可只能指向真实产物修订。");
  const binding = revisionBinding(db, source.artifactId, source.revisionId);
  if (!binding || binding.workId !== workId || binding.stage !== stage) {
    throw new AgentError("INVALID_INPUT", `这份修订不是该视频的${stage === "plan" ? "画面/声音方案" : "视频初稿"}主稿。`);
  }
  const artifact = db.prepare("SELECT kind FROM artifacts WHERE id = ? AND owner_id = ? AND conversation_id = ?")
    .get(source.artifactId, scope.ownerId, scope.conversationId) as { kind: string } | undefined;
  if (!artifact) throw new AgentError("NOT_FOUND", "引用的产物不存在。");
  if (stage === "video" && artifact.kind !== "video") throw new AgentError("INVALID_INPUT", "定稿只能指向真实视频产物。");
  if (stage === "plan" && !["script", "analysis", "prompt"].includes(artifact.kind)) throw new AgentError("INVALID_INPUT", "方案主稿必须是文本产物。");
}

export interface StageConfirmationInput {
  workId: string;
  action: StageConfirmationAction;
  subject: ContentSourceInput;
  sourceKind: "user_message" | "proposal_accept";
  sourceId: string;
}

// Pi 工具、按钮与制作受理共用的认可内核。只记录用户已经表达的认可，
// 不推进未明确要求的下一阶段工作，也不产生制作运行。
export function recordStageConfirmation(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  input: StageConfirmationInput,
): { confirmationId: string; work: WorkRow; duplicate: boolean } {
  const work = requireWork(db, scope.ownerId, scope.conversationId, input.workId);
  const state = parseCreationState(work);
  const stage: WorkStage = input.action === "approve_plan" ? "plan" : input.action === "finalize_video" ? "video" : "content";
  if (input.action === "approve_plan" && state.stage === "content") {
    throw new AgentError("INVALID_INPUT", "内容尚未认可并进入画面阶段，不能先认可方案。");
  }
  if (input.action === "finalize_video" && state.stage !== "video") {
    throw new AgentError("INVALID_INPUT", "还没有可定稿的视频初稿。");
  }
  const subject = resolveContentSource(db, scope, input.subject, stage);
  if (stage === "content") {
    if (subject.kind === "artifact_revision") {
      const binding = revisionBinding(db, subject.artifactId, subject.revisionId);
      const artifact = db.prepare("SELECT kind FROM artifacts WHERE id = ?").get(subject.artifactId) as { kind: string } | undefined;
      if (!artifact || !["script", "prompt", "analysis"].includes(artifact.kind)) throw new AgentError("INVALID_INPUT", "内容认可必须指向文本稿件或聊天原文。");
      if (binding && (binding.workId !== work.id || binding.stage !== "content")) throw new AgentError("INVALID_INPUT", "这份修订属于其他视频或阶段，不能作为本条视频的内容。");
    }
  } else {
    requireWorkRevision(db, scope, work.id, subject, stage);
  }
  const prior = db.prepare(
    "SELECT * FROM work_stage_confirmations WHERE work_id = ? AND stage = ? AND action = ? AND subject_json = ? AND source_kind = ? AND source_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(work.id, stage, input.action, canonicalJson(subject), input.sourceKind, input.sourceId) as { id: string } | undefined;
  if (prior) return { confirmationId: prior.id, work, duplicate: true };

  // 在途冻结：受理后该事项不再接受新的阶段认可，意见经 record_work_feedback 留到下一版。
  // 受理事务先记录认可再创建 queued run（ProductionService.admit），不会拦住自身。
  if (workInFlight(db, work.id)) {
    throw new AgentError("RUN_BUSY", "这条视频正在制作中，本版内容已冻结；修改意见会保留到下一版。");
  }
  const stageState = state[stage];
  // 认可作用于该阶段准确当前稿：已有当前稿时旧版本或其他来源一律拒绝，当前引用不倒退。
  // 内容阶段尚无当前稿时，首次明确采用（含较早的真实消息/独立稿）在这里建立来源。
  if (stageState.draft && !sameContentSource(stageState.draft, subject)) {
    throw new AgentError("INVALID_INPUT", stage === "content"
      ? "内容当前稿已更新，不能认可或继续旧版本；请基于当前稿操作。"
      : `这份${stage === "plan" ? "方案" : "视频"}主稿不是当前稿，请认可当前版本。`);
  }
  if (!stageState.draft && stage !== "content") {
    throw new AgentError("INVALID_INPUT", stage === "plan" ? "还没有可认可的方案主稿。" : "还没有可定稿的视频初稿。");
  }
  if (stage === "plan" && subject.kind === "artifact_revision") {
    requireContentContinued(db, work);
    const binding = revisionBinding(db, subject.artifactId, subject.revisionId);
    if (!sameContentSource(binding?.source ?? null, state.content.draft)) {
      throw new AgentError("INVALID_INPUT", "内容主稿已更新，请先按当前内容更新方案再认可。");
    }
  }
  const confirmationId = newAgentId("confirm");
  db.prepare(
    `INSERT INTO work_stage_confirmations(id, owner_id, conversation_id, work_id, stage, action, subject_json, source_kind, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(confirmationId, scope.ownerId, scope.conversationId, work.id, stage, input.action, canonicalJson(subject), input.sourceKind, input.sourceId, now);

  stageState.approved = subject;
  stageState.approvedAt = now;
  stageState.confirmationId = confirmationId;
  if (!stageState.draft) stageState.draft = subject;
  if (input.action === "approve_content_continue" && state.stage === "content") state.stage = "plan";
  if (input.action === "finalize_video") state.stage = "video";
  const updated = writeWorkState(db, now, work, state);
  return { confirmationId, work: updated, duplicate: false };
}

// 制作受理在同一事务记录方案认可与运行关联；按钮一次动作完成“认可 + 开始”。
export function markPlanProduced(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  workId: string,
  planSource: ContentSource,
  proposalId: string,
  runId: string,
  confirmationId: string,
): WorkRow {
  const work = requireWork(db, scope.ownerId, scope.conversationId, workId);
  const state = parseCreationState(work);
  state.stage = "video";
  state.plan.approved = planSource;
  state.plan.approvedAt = now;
  state.plan.confirmationId = confirmationId;
  state.plan.proposalId = proposalId;
  state.video.proposalId = proposalId;
  state.video.runId = runId;
  return writeWorkState(db, now, work, state);
}

export function setStageDraft(
  db: AgentDatabase,
  now: string,
  work: WorkRow,
  stage: "content" | "plan",
  source: ContentSource,
  proposalId: string | null,
): WorkRow {
  const state = parseCreationState(work);
  state[stage].draft = source;
  if (stage === "plan") state.plan.proposalId = proposalId;
  return writeWorkState(db, now, work, state);
}

export function setVideoOutput(
  db: AgentDatabase,
  now: string,
  work: WorkRow,
  source: ContentSource,
  proposalId: string | null,
  runId: string | null,
): WorkRow {
  const state = parseCreationState(work);
  state.stage = "video";
  state.video.draft = source;
  state.video.proposalId = proposalId;
  state.video.runId = runId;
  return writeWorkState(db, now, work, state);
}

// 下游（素材检索/采用、首次方案或提案绑定、prepare、受理）的继续许可：当前内容稿存在、approved 与
// draft 一致，且最新相关确认就是这份准确 subject 上的 approve_content_continue。当前讨论方案的纯修订单独核对来源。
// stage 字段只是展示位置；仅认可、或最新动作改回暂停，都不放行新下游。
export function requireContentContinued(db: AgentDatabase, work: WorkRow): void {
  const state = parseCreationState(work);
  if (state.stage === "content") {
    throw new AgentError("INVALID_INPUT", "内容稿尚未认可并进入画面阶段，不能先准备画面素材或制作方案。");
  }
  const draft = state.content.draft;
  if (!draft || !sameContentSource(state.content.approved, draft)) {
    throw new AgentError("INVALID_INPUT", "内容主稿已更新，请先认可当前稿并明确继续，再准备画面素材或制作方案。");
  }
  const confirmation = state.content.confirmationId
    ? db.prepare("SELECT action, subject_json FROM work_stage_confirmations WHERE id = ?")
      .get(state.content.confirmationId) as { action: StageConfirmationAction; subject_json: string } | undefined
    : undefined;
  if (!confirmation || confirmation.action !== "approve_content_continue"
    || canonicalJson(draft) !== confirmation.subject_json) {
    throw new AgentError("INVALID_INPUT", "内容当前稿只获得认可、未明确继续；明确继续后才能准备画面素材或制作方案。");
  }
}

// B3：内容“明确继续”是否已有准确对应的方案草稿——该方案修订的采用来源正是这份内容。
// 有它时按钮只补记认可并展示这份方案，不再排一次文本模型请求。
export function hasPlanDraftForContent(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  workId: string,
  subject: ContentSourceInput,
): boolean {
  const work = requireWork(db, scope.ownerId, scope.conversationId, workId);
  const draft = parseCreationState(work).plan.draft;
  if (!draft || draft.kind !== "artifact_revision") return false;
  const source = resolveContentSource(db, scope, subject, "content");
  const binding = revisionBinding(db, draft.artifactId, draft.revisionId);
  return binding?.workId === workId && binding.stage === "plan"
    && sameContentSource(binding.source ?? null, source);
}

// 按真实当前引用解析产物归属：不依赖 artifacts.work_id 或采用前的 revision binding。
// 视频产物不允许聊天改写；同一产物被多个事项（或同事项多个阶段）引用时无法唯一推导，
// 要求本次显式 stageDrafts，不任取第一项、不做跨作品级联。
export function artifactWorkOwnership(
  db: AgentDatabase,
  artifact: { id: string; conversation_id: string },
  explicit?: { workId: string; stage: WorkStage },
): { workId: string; stage: "content" | "plan" } | null {
  const works = db.prepare("SELECT * FROM works WHERE conversation_id = ?").all(artifact.conversation_id) as WorkRow[];
  const matches: { workId: string; stage: "content" | "plan" }[] = [];
  for (const work of works) {
    const state = parseCreationState(work);
    if (state.video.draft?.kind === "artifact_revision" && state.video.draft.artifactId === artifact.id) {
      throw new AgentError("INVALID_INPUT", "制作产出的视频初稿不能在聊天里直接改写；修改请准备下一版。");
    }
    for (const stage of ["plan", "content"] as const) {
      const draft = state[stage].draft;
      if (draft?.kind === "artifact_revision" && draft.artifactId === artifact.id) matches.push({ workId: work.id, stage });
    }
  }
  if (matches.length === 0) return null;
  if (explicit) {
    const match = matches.find(item => item.workId === explicit.workId && item.stage === explicit.stage);
    if (!match) throw new AgentError("INVALID_INPUT", "不能把已有主稿改挂到其他视频或阶段。");
    return match;
  }
  if (matches.length > 1) {
    throw new AgentError("INVALID_INPUT", "这份稿件同时被多条视频创作引用，修改时请在 stageDrafts 里明确本次归属。");
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

function stageView(db: AgentDatabase, stage: WorkStage, state: StageState, upstreamStale: boolean): WorkStageView {
  let proposalId = state.proposalId;
  if (stage === "plan" && proposalId) {
    const proposal = db.prepare("SELECT state FROM proposals WHERE id = ?").get(proposalId) as Pick<Proposal, "state"> | undefined;
    if (proposal?.state !== "ready") proposalId = null;
  }
  // confirmationAction 是确认记录的只读派生投影，无额外持久字段。
  let confirmationAction: WorkStageView["confirmationAction"] = null;
  if (state.confirmationId) {
    const row = db.prepare("SELECT action FROM work_stage_confirmations WHERE id = ?")
      .get(state.confirmationId) as { action: WorkStageView["confirmationAction"] } | undefined;
    confirmationAction = row?.action ?? null;
  }
  return {
    stage,
    draft: state.draft,
    approved: state.approved,
    approvedAt: state.approvedAt,
    confirmationId: state.confirmationId,
    confirmationAction,
    upstreamStale,
    proposalId,
    runId: state.runId,
  };
}

export function workProjection(db: AgentDatabase, row: WorkRow): Work {
  const state = parseCreationState(row);
  const planBinding = state.plan.draft?.kind === "artifact_revision"
    ? revisionBinding(db, state.plan.draft.artifactId, state.plan.draft.revisionId) : null;
  const videoBinding = state.video.draft?.kind === "artifact_revision"
    ? revisionBinding(db, state.video.draft.artifactId, state.video.draft.revisionId) : null;
  // 待更新只从不可变上游关联比较，不双写 approved/stale 布尔。
  const planStale = planBinding?.source != null && !sameContentSource(planBinding.source, state.content.draft);
  const videoStale = videoBinding?.source != null && !sameContentSource(videoBinding.source, state.plan.draft);
  return {
    id: row.id,
    title: row.title,
    stage: state.stage,
    revision: row.revision,
    stages: {
      content: stageView(db, "content", state.content, false),
      plan: stageView(db, "plan", state.plan, planStale),
      video: stageView(db, "video", state.video, videoStale),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkRows(db: AgentDatabase, conversationId: string, limit: number): WorkRow[] {
  return (db.prepare("SELECT * FROM works WHERE conversation_id = ? AND creation_state_json IS NOT NULL ORDER BY rowid DESC LIMIT ?")
    .all(conversationId, limit) as WorkRow[]).reverse();
}
// 提案与方案主稿的准确关联现由 proposals.plan_source_json 持久承载（§10.1），
// 读取入口是 artifact-store.ts 的 proposalPlanSource；此处不再保留历史修订反查。

export function revisionCreationBinding(db: AgentDatabase, artifactId: string, revisionId: string): CreationBinding | null {
  return revisionBinding(db, artifactId, revisionId);
}

export function isWorkPlanDraftCurrent(db: AgentDatabase, work: WorkRow, source: ContentSource): boolean {
  if (source.kind !== "artifact_revision") return false;
  const state = parseCreationState(work);
  return state.plan.draft?.kind === "artifact_revision"
    && state.plan.draft.artifactId === source.artifactId
    && state.plan.draft.revisionId === source.revisionId;
}
