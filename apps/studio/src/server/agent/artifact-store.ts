import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import type { RequestRow } from "./conversation-store.js";
import { canonicalJson, digestOf, newAgentId } from "./util.js";
import type {
  ArtifactHead, ArtifactRevision, AudioSummary, ContentSource, DeliveryItem, DeliveryReceipt, FeedbackNote, MarkdownContent, MediaContent, MediaProvenance,
  ModelBinding, OperationRequest, OperationSpec, ProductionIntent, ProductionSpec, Proposal, StageDraft, Target,
  ToolDelivery, VideoParameters, RevisionRef, ProposalRef, InputRef,
} from "../../shared/agent/generated/contracts.js";
import { blobSources, mergeSources, resolveMediaReference, readAdoptedAudioSource } from "./material-store.js";
import { speechText, markdownSectionMap, markdownTotalLength } from "../../shared/agent/markdown.js";
import {
  artifactWorkOwnership, getWorkRow, parseCreationState, requireContentContinued, requireWork,
  resolveContentSource, sameContentSource, setStageDraft, workInFlight, revisionCreationBinding, writeWorkState,
  type CreationBinding, type WorkRow,
} from "./creative-work.js";

// 产物、修订、整批交付事务、工具调用登记与提案的持久操作。
// 交付/提案都是“单事务提交全部或全部拒绝”，禁止部分落库。

export interface ArtifactRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  title: string;
  kind: ArtifactHead["kind"];
  work_id: string | null;
  head_revision_id: string | null;
  head_revision_number: number;
  created_seq: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRevisionRow {
  id: string;
  artifact_id: string;
  revision_number: number;
  base_revision_id: string | null;
  request_id: string | null;
  run_id: string | null;
  digest: string;
  content_json: string;
  creation_binding_json: string | null;
  created_at: string;
}

export function rowToArtifactHead(row: ArtifactRow): ArtifactHead {
  return {
    id: row.id, title: row.title, kind: row.kind,
    revisionId: row.head_revision_id!, revisionNumber: row.head_revision_number,
    workId: row.work_id, updatedAt: row.updated_at,
  };
}

export function rowToArtifactRevision(row: ArtifactRevisionRow): ArtifactRevision {
  return {
    artifactId: row.artifact_id, revisionId: row.id, revisionNumber: row.revision_number,
    baseRevisionId: row.base_revision_id, requestId: row.request_id, runId: row.run_id,
    digest: row.digest, content: JSON.parse(row.content_json) as ArtifactRevision["content"],
    createdAt: row.created_at,
  };
}

export function listArtifactRows(db: AgentDatabase, conversationId: string, limit: number, beforeSeq?: number): ArtifactRow[] {
  const sql = beforeSeq === undefined
    ? "SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_seq DESC LIMIT ?"
    : "SELECT * FROM artifacts WHERE conversation_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?";
  return (beforeSeq === undefined
    ? db.prepare(sql).all(conversationId, limit)
    : db.prepare(sql).all(conversationId, beforeSeq, limit)) as ArtifactRow[];
}

export function maxArtifactSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM artifacts WHERE conversation_id = ?").get(conversationId) as { seq: number };
  return row.seq;
}

export function getArtifactRow(db: AgentDatabase, ownerId: string, artifactId: string): ArtifactRow | undefined {
  return db.prepare("SELECT * FROM artifacts WHERE id = ? AND owner_id = ?").get(artifactId, ownerId) as ArtifactRow | undefined;
}

export function getRevisionRow(db: AgentDatabase, artifactId: string, revisionId: string): ArtifactRevisionRow | undefined {
  return db.prepare("SELECT * FROM artifact_revisions WHERE artifact_id = ? AND id = ?").get(artifactId, revisionId) as ArtifactRevisionRow | undefined;
}

// —— 工具调用登记（F7 回执窗口） ——

export interface ToolInvocationRow {
  owner_id: string;
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  args_digest: string;
  args_json: string;
  state: "registered" | "committed";
  result_json: string | null;
  proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

// 业务事务前的短事务登记；同键同参幂等，同键异参是冲突。
export function registerInvocation(
  db: AgentDatabase, now: string,
  input: { ownerId: string; requestId: string; toolCallId: string; toolName: string; args: unknown },
): { argsDigest: string } {
  const argsDigest = digestOf(input.args);
  const existing = db.prepare("SELECT args_digest, tool_name FROM tool_invocations WHERE owner_id = ? AND request_id = ? AND tool_call_id = ?")
    .get(input.ownerId, input.requestId, input.toolCallId) as { args_digest: string; tool_name: string } | undefined;
  if (existing && (existing.args_digest !== argsDigest || existing.tool_name !== input.toolName)) {
    throw new AgentError("IDEMPOTENCY_CONFLICT", "同一工具调用 ID 已绑定不同参数。");
  }
  if (!existing) {
    db.prepare(
      `INSERT INTO tool_invocations(owner_id, request_id, tool_call_id, tool_name, args_digest, args_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?)`,
    ).run(input.ownerId, input.requestId, input.toolCallId, input.toolName, argsDigest, canonicalJson(input.args), now, now);
  }
  return { argsDigest };
}

export function getInvocation(db: AgentDatabase, ownerId: string, requestId: string, toolCallId: string): ToolInvocationRow | undefined {
  return db.prepare("SELECT * FROM tool_invocations WHERE owner_id = ? AND request_id = ? AND tool_call_id = ?")
    .get(ownerId, requestId, toolCallId) as ToolInvocationRow | undefined;
}

// 只在业务事务内调用：工具回执与业务事实同事务提交。
export function commitInvocationResult(db: AgentDatabase, now: string, row: { ownerId: string; requestId: string; toolCallId: string }, result: unknown, proposalId?: string): void {
  db.prepare("UPDATE tool_invocations SET state = 'committed', result_json = ?, proposal_id = ?, updated_at = ? WHERE owner_id = ? AND request_id = ? AND tool_call_id = ?")
    .run(canonicalJson(result), proposalId ?? null, now, row.ownerId, row.requestId, row.toolCallId);
}

// —— 整批交付 ——

export interface DeliveryContext {
  request: RequestRow;
  epoch: number;
}

interface StoredDelivery {
  batch_digest: string;
  receipt_json: string;
}

// 完整交付摘要：stageDrafts 出现时纳入影响结果的关联字段；省略时保持旧 items-only 形状，
// 既有收据仍可重放。Pi 工具请求级重放与交付事务共用这一个规则。
export function deliveryDigest(input: ToolDelivery): string {
  return digestOf(input.stageDrafts === undefined
    ? { tool: "deliver_artifacts", items: input.items }
    : { tool: "deliver_artifacts", items: input.items, stageDrafts: input.stageDrafts });
}

// 单事务：作用域/CAS 校验 → 修订落库 → 头推进 → 阶段关联 → 交付关闭 → 回执 → 提案失效 → 事件。
// 任何一步失败整体回滚；重放按规范化批次摘要比对，不只看 toolCallId。
export function applyDelivery(
  db: AgentDatabase,
  now: string,
  ctx: DeliveryContext,
  input: ToolDelivery,
): { receipt: DeliveryReceipt; replayed: boolean } {
  const { request } = ctx;
  const items = input.items;
  const stageDrafts = input.stageDrafts ?? [];
  if (input.stageDrafts !== undefined && stageDrafts.length === 0) {
    throw new AgentError("INVALID_INPUT", "stageDrafts 出现时不能为空。");
  }
  const batchDigest = deliveryDigest(input);
  const stored = db.prepare("SELECT batch_digest, receipt_json FROM request_deliveries WHERE request_id = ?").get(request.id) as StoredDelivery | undefined;
  if (stored) {
    // 已交付的请求只剩重放一条路；参数不同说明请求已被关闭后想再改，拒绝。
    if (stored.batch_digest !== batchDigest) throw new AgentError("DELIVERY_CLOSED", "本请求已完成正式交付，修改请发起新的明确修改请求。");
    return { receipt: { ...JSON.parse(stored.receipt_json) as DeliveryReceipt, replayed: true }, replayed: true };
  }
  if (request.delivery_closed) throw new AgentError("DELIVERY_CLOSED", "本请求已完成正式交付，修改请发起新的明确修改请求。");
  if (request.state !== "running" || request.execution_epoch !== ctx.epoch || request.stop_requested) {
    throw new AgentError("REQUEST_NOT_RUNNING", "请求已结束或被停止，不能再交付。");
  }
  const target = request.target_json ? (JSON.parse(request.target_json) as Target) : null;
  const scope = { ownerId: request.owner_id, conversationId: request.conversation_id };

  // 阶段主稿关联先核对完整形状：一个事项每阶段至多一个主稿，同批允许 A/B 各自主稿。
  const stageDraftByItem = new Map<number, StageDraft>();
  const stageDraftSources = new Map<number, ContentSource | null>();
  // 成对修订（B3）：plan.source 用 delivery_item 指向本批 content 主稿，插入后解析为真实修订。
  const pairedContentItem = new Map<number, number>();
  const seenWorkStages = new Set<string>();
  for (const draft of stageDrafts) {
    if (draft.itemIndex >= items.length) throw new AgentError("INVALID_INPUT", "阶段主稿引用的交付项不存在。");
    if (stageDraftByItem.has(draft.itemIndex)) throw new AgentError("INVALID_INPUT", "同一交付项不能关联多个阶段主稿。");
    const key = `${draft.workId}:${draft.stage}`;
    if (seenWorkStages.has(key)) throw new AgentError("INVALID_INPUT", "同一视频的同一阶段只能指定一个主稿。");
    seenWorkStages.add(key);
    const item = items[draft.itemIndex]!;
    if (item.content.format !== "markdown") throw new AgentError("INVALID_INPUT", "内容与方案主稿必须是文本产物。");
    const work = getWorkRow(db, request.owner_id, draft.workId);
    if (!work || work.conversation_id !== request.conversation_id) throw new AgentError("NOT_FOUND", "阶段主稿引用的视频创作不存在或不属于当前会话。");
    if (draft.stage === "plan") {
      if (draft.source.kind === "delivery_item") {
        // 成对修订是讨论稿：不得携带提案引用；仅能指向本批同 work 的 content 主稿。
        if (draft.proposalRef) throw new AgentError("INVALID_INPUT", "成对修订的方案是讨论稿，不能关联制作提案。");
        const contentDraft = stageDraftByItem.get(draft.source.itemIndex);
        if (!contentDraft || contentDraft.stage !== "content" || contentDraft.workId !== draft.workId) {
          throw new AgentError("INVALID_INPUT", "delivery_item 只能指向同一次交付中同一视频的内容主稿。");
        }
        pairedContentItem.set(draft.itemIndex, draft.source.itemIndex);
        stageDraftSources.set(draft.itemIndex, null);
      } else {
        const source = resolveContentSource(db, scope, draft.source, "content");
        stageDraftSources.set(draft.itemIndex, source);
        validatePlanSectionCitations(db, item.content, source);
        if (!draft.proposalRef) {
          // 没有显式有效提案关联时保存为不可开始的讨论稿。
        } else {
          const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND owner_id = ? AND conversation_id = ?")
            .get(draft.proposalRef.proposalId, request.owner_id, request.conversation_id) as ProposalRow | undefined;
          if (!proposal || proposal.state !== "ready" || proposal.digest !== draft.proposalRef.digest) {
            throw new AgentError("INVALID_INPUT", "方案主稿关联的提案不存在、已失效或摘要不一致。");
          }
          const spec = JSON.parse(proposal.spec_json) as ProductionSpec;
          if (spec.workId !== draft.workId) throw new AgentError("INVALID_INPUT", "提案不属于这条视频创作。");
          // 关系一旦建立不可改绑另一稿：按提案持久来源拒绝（§10.1），不再扫描修订 JSON。
          if (proposal.plan_source_json) throw new AgentError("INVALID_INPUT", "该提案已关联另一份方案主稿，请重新准备提案。");
        }
      }
    } else {
      if (item.content.format === "markdown" && item.content.sections?.some(section => section.sourceSectionIds)) {
        throw new AgentError("INVALID_INPUT", "内容稿段落不能携带 sourceSectionIds；只有方案段落可以引用内容段落。");
      }
      stageDraftSources.set(draft.itemIndex, null);
    }
    stageDraftByItem.set(draft.itemIndex, draft);
  }

  // 分段文稿的交付边界核对（B2.1）：总量沿用 64000、段 id 唯一；引用对应性已按阶段上方核对。
  for (let index = 0; index < items.length; index++) {
    const content = items[index]!.content;
    if (content.format !== "markdown") continue;
    if (markdownTotalLength(content) > 64_000) {
      throw new AgentError("INVALID_INPUT", "完整正文（全局说明＋全部段落＋旁白）超过 64000 字符上限。");
    }
    if (!content.sections) continue;
    if (new Set(content.sections.map(section => section.id)).size !== content.sections.length) {
      throw new AgentError("INVALID_INPUT", "同一次交付的段落 id 不能重复。");
    }
    if (!stageDraftByItem.has(index) && content.sections.some(section => section.sourceSectionIds)) {
      throw new AgentError("INVALID_INPUT", "普通文稿段落不能携带 sourceSectionIds；只有方案主稿可以引用内容段落。");
    }
  }

  const revisedObjects = new Set<string>();
  for (const item of items) {
    if (item.mode === "create") continue;
    // 显式目标仍精确尊重；没有预绑定 target 时按真实对象与基准版本核对，
    // 不把 target=null 本身当成未授权，也不把 revise 失败降级成 create。
    if (target && (item.artifactId !== target.artifactId || item.baseRevisionId !== target.revisionId)) {
      throw new AgentError("TARGET_SCOPE_MISMATCH", "修改对象与请求绑定的目标不一致，请按用户明确指定的对象与基准版本修改。");
    }
    if (revisedObjects.has(item.artifactId)) throw new AgentError("TARGET_SCOPE_MISMATCH", "同一批次内每个对象至多一次修订。");
    revisedObjects.add(item.artifactId);
  }

  // 素材 create 分支先把受控 media_reference 解析为真实 MediaContent（必须来自同会话已完成
  // 的采用且 kind 一致），再交给同一 insertRevision；模型不能上交任意媒体或 URL 冒充生成。
  const resolvedContents = new Map<number, MarkdownContent | MediaContent>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const content = item.content;
    if (content.format !== "media_reference") {
      resolvedContents.set(index, content);
      continue;
    }
    // media_reference 只出现在 image/video 的 create 分支；revise 与文本 create 不会携带。
    const resolved = resolveMediaReference(db, {
      ownerId: request.owner_id, conversationId: request.conversation_id,
    }, content.blobId, item.kind as "image" | "video");
    if (!resolved) throw new AgentError("TARGET_SCOPE_MISMATCH", "引用的媒体不是本会话已采用的素材，不能作为产物交付。");
    resolvedContents.set(index, resolved);
  }

  const touchedArtifacts: ArtifactRow[] = [];
  const newRevisions: (ArtifactRevisionRow | undefined)[] = new Array(items.length);
  // 阶段注册统一延后：content 主稿先落，plan 主稿后落（成对修订的 source 才能指向本批新内容修订）。
  const pendingRegistrations: { binding: CreationBinding; revision: ArtifactRevisionRow; paired: boolean }[] = [];
  const insertItem = (index: number, binding: CreationBinding | null): { revision: ArtifactRevisionRow; binding: CreationBinding | null } => {
    const item = items[index]!;
    const explicitDraft = stageDraftByItem.get(index);
    if (item.mode === "create") {
      const artifactId = newAgentId("art");
      const seq = nextArtifactSeq(db, request.conversation_id);
      db.prepare(
        `INSERT INTO artifacts(id, conversation_id, owner_id, title, kind, work_id, head_revision_id, head_revision_number, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      ).run(artifactId, request.conversation_id, request.owner_id, item.title, item.kind, seq, now, now);
      const artifact = getArtifactRow(db, request.owner_id, artifactId)!;
      const revision = insertRevision(db, now, artifact, null, { title: item.title, kind: item.kind, content: resolvedContents.get(index)! }, request.id, binding);
      touchedArtifacts.push(artifact);
      return { revision, binding };
    }
    const artifact = getArtifactRow(db, request.owner_id, item.artifactId);
    if (!artifact || artifact.conversation_id !== request.conversation_id) {
      throw new AgentError("TARGET_SCOPE_MISMATCH", "修改对象不存在或不属于当前会话。");
    }
    if (artifact.kind !== item.kind) throw new AgentError("TARGET_SCOPE_MISMATCH", "修订不能改变产物类型。");
    if (hasProductionLock(db, artifact.id)) throw new AgentError("RUN_BUSY", "这份内容正在制作中，暂不能改稿；可以记录下一版意见。");
    if (artifact.head_revision_id !== item.baseRevisionId) {
      throw new AgentError("STALE_REVISION", "产物已更新，请基于当前最新版本重新发起修改。", { currentRevisionId: artifact.head_revision_id });
    }
    const previous = getRevisionRow(db, artifact.id, item.baseRevisionId);
    const previousBinding = previous?.creation_binding_json ? JSON.parse(previous.creation_binding_json) as CreationBinding : null;
    // 先按真实当前引用解析归属，再比较显式关联：旧 binding 为空也不能把 A 的当前稿改挂到 B。
    const ownership = artifactWorkOwnership(db, artifact, explicitDraft);
    if (explicitDraft) {
      const attributed = previousBinding ?? ownership;
      if (attributed && (attributed.workId !== explicitDraft.workId || attributed.stage !== explicitDraft.stage)) {
        throw new AgentError("INVALID_INPUT", "不能把已有主稿改挂到其他视频或阶段。");
      }
    }
    // 隐式改稿继承真实归属；有效 binding 一律延后登记——当前引用更新与继续许可核对都发生在那里。
    const effective = binding ?? inheritedBinding(previousBinding, ownership);
    const revision = insertRevision(db, now, artifact, item.baseRevisionId, { title: item.title, kind: item.kind, content: item.content }, request.id, effective);
    touchedArtifacts.push(getArtifactRow(db, request.owner_id, artifact.id)!);
    return { revision, binding: effective };
  };

  // 第一阶段：非成对项照常插入（含普通 plan 主稿，source 指向既有内容修订/消息原文）。
  for (let index = 0; index < items.length; index++) {
    if (pairedContentItem.has(index)) continue;
    const draft = stageDraftByItem.get(index);
    const inserted = insertItem(index, draft ? deliveryBinding(draft, stageDraftSources.get(index) ?? null) : null);
    newRevisions[index] = inserted.revision;
    if (inserted.binding) pendingRegistrations.push({ binding: inserted.binding, revision: inserted.revision, paired: false });
  }
  // 第二阶段：成对 plan 主稿——先取本批 content 主稿的真实修订作 source，再插入并登记。
  for (const index of [...pairedContentItem.keys()]) {
    const contentRevision = newRevisions[pairedContentItem.get(index)!];
    if (!contentRevision) throw new AgentError("INVALID_INPUT", "成对修订引用的内容主稿未能落库。");
    const source: ContentSource = {
      kind: "artifact_revision", artifactId: contentRevision.artifact_id, revisionId: contentRevision.id, digest: contentRevision.digest,
    };
    const item = items[index]!;
    if (item.content.format === "markdown") validatePlanSectionCitations(db, item.content, source);
    const draft = stageDraftByItem.get(index)!;
    const binding = deliveryBinding(draft, source);
    const inserted = insertItem(index, binding);
    newRevisions[index] = inserted.revision;
    pendingRegistrations.push({ binding, revision: inserted.revision, paired: true });
  }
  // 注册顺序：content 先于 plan，保证成对方案注册时 work.content.draft 已指向新内容修订。
  for (const pass of [false, true] as const) {
    for (const job of pendingRegistrations) {
      if ((job.binding.stage === "plan") === pass) registerStageDraft(db, now, job.binding, job.revision, job.paired);
    }
  }

  const receipt: DeliveryReceipt = {
    receiptId: newAgentId("dlv"),
    requestId: request.id,
    replayed: false,
    revisions: newRevisions.filter((revision): revision is ArtifactRevisionRow => revision !== undefined)
      .map(r => ({ artifactId: r.artifact_id, revisionId: r.id })) as [DeliveryReceipt["revisions"][number], ...DeliveryReceipt["revisions"]],
    deliveryClosed: true,
  };
  db.prepare("UPDATE requests SET delivery_closed = 1, updated_at = ? WHERE id = ?").run(now, request.id);
  db.prepare("INSERT INTO request_deliveries(request_id, batch_digest, receipt_id, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(request.id, batchDigest, receipt.receiptId, canonicalJson(receipt), now);

  for (const revision of newRevisions.filter((row): row is ArtifactRevisionRow => row !== undefined)) {
    insertEvent(db, now, {
      conversationId: request.conversation_id, ownerId: request.owner_id,
      kind: "artifact.delivered", entityId: revision.artifact_id,
      entityVersion: revision.revision_number, notification: "new_output",
    });
  }
  expireProposalsOnRevisions(db, now, request.conversation_id, request.owner_id, touchedArtifacts);
  return { receipt, replayed: false };
}

function deliveryBinding(draft: StageDraft, source: ContentSource | null): CreationBinding {
  return {
    workId: draft.workId,
    stage: draft.stage,
    source,
    proposalRef: draft.proposalRef ? { proposalId: draft.proposalRef.proposalId, digest: draft.proposalRef.digest } : null,
  };
}

// 方案段落的 sourceSectionIds 必须指向它准确 source 内容修订的真实段落（B2.1）：
// source 是 artifact_revision 时按该修订 sections 核对；消息原文没有分段结构，不允许引用。
function validatePlanSectionCitations(db: AgentDatabase, content: MarkdownContent, source: ContentSource): void {
  if (content.format !== "markdown" || !content.sections) return;
  const citing = content.sections.filter(section => section.sourceSectionIds && section.sourceSectionIds.length > 0);
  if (citing.length === 0) return;
  if (source.kind !== "artifact_revision") {
    throw new AgentError("INVALID_INPUT", "方案段落引用内容段落时，source 必须是分段的内容修订。");
  }
  const row = getRevisionRow(db, source.artifactId, source.revisionId);
  if (!row) throw new AgentError("NOT_FOUND", "引用的产物修订不存在或不属于当前会话。");
  const sourceContent = JSON.parse(row.content_json) as MarkdownContent;
  if (sourceContent.format !== "markdown" || !sourceContent.sections) {
    throw new AgentError("INVALID_INPUT", "方案段落引用的内容修订没有分段，不能按段落引用。");
  }
  const known = markdownSectionMap(sourceContent);
  for (const section of citing) {
    for (const id of section.sourceSectionIds!) {
      if (!known.has(id)) throw new AgentError("INVALID_INPUT", `方案段落引用的内容段落 ${id} 不在所采用的内容修订里。`);
    }
  }
}

// 已有主稿的普通改稿即使漏传 stageDrafts，也按真实归属（revision binding 或 work 当前引用）
// 更新当前引用；方案的新修订不静默继承旧提案，除非本次显式关联有效新提案。
function inheritedBinding(
  previous: CreationBinding | null,
  ownership: { workId: string; stage: "content" | "plan" } | null,
): CreationBinding | null {
  if (previous) {
    return { ...previous, proposalRef: previous.stage === "plan" ? null : previous.proposalRef };
  }
  return ownership ? { workId: ownership.workId, stage: ownership.stage, source: null, proposalRef: null } : null;
}

function registerStageDraft(db: AgentDatabase, now: string, binding: CreationBinding, revision: ArtifactRevisionRow, paired = false): void {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(binding.workId) as WorkRow | undefined;
  if (!work) return;
  // 在途冻结覆盖同一事项全部主稿写入口（create/revise/隐式归属推导），不只锁原 artifact；
  // worker 的完成登记走 setVideoOutput，不经此处，不会被拦住。
  if (workInFlight(db, binding.workId)) {
    throw new AgentError("RUN_BUSY", "这条视频正在制作中，本版主稿已冻结；修改意见会保留到下一版。");
  }
  // 当前方案的纯讨论修订不推进阶段；首次方案与绑定提案仍要求用户明确继续。
  // 成对修订（B3）沿用已有认可内容与方案的门槛，认可和受理不借此放宽。
  if (binding.stage === "plan") {
    const state = parseCreationState(work);
    const currentPlan = state.plan.draft;
    const revisingCurrentPlan = !binding.proposalRef && currentPlan?.kind === "artifact_revision"
      && currentPlan.artifactId === revision.artifact_id && currentPlan.revisionId === revision.base_revision_id
      && sameContentSource(revisionCreationBinding(db, currentPlan.artifactId, currentPlan.revisionId)?.source ?? null, binding.source);
    if (paired) {
      if (!state.content.approved || !state.plan.approved) {
        throw new AgentError("INVALID_INPUT", "内容初次认可前不能同时交付内容与方案；请先交付并认可内容。");
      }
    } else if (!revisingCurrentPlan) {
      requireContentContinued(db, work);
    }
    if (!sameContentSource(binding.source, state.content.draft)) {
      throw new AgentError("INVALID_INPUT", "方案必须基于该视频当前的内容主稿；上游已更新时请重新准备方案。");
    }
  }
  const source: ContentSource = {
    kind: "artifact_revision", artifactId: revision.artifact_id, revisionId: revision.id, digest: revision.digest,
  };
  if (binding.stage === "plan" && binding.proposalRef) {
    // 先交付后关联的旧入口：提案最终 render 若带 segmentIds，这里就是方案↔提案关联的建立点，
    // 按本修订段落核对一次（prepare + planSource 主入口在 applyPrepareProposal 核对）。
    const proposal = db.prepare("SELECT spec_json FROM proposals WHERE id = ?").get(binding.proposalRef.proposalId) as { spec_json: string } | undefined;
    const spec = proposal ? JSON.parse(proposal.spec_json) as ProductionSpec : null;
    if (spec) validatePlanNarration(db, source, spec);
    const final = spec?.operations.find(op => op.operationId === spec.finalOutput.operationId);
    if (final?.kind === "render" && final.parameters.segmentIds) {
      const content = JSON.parse(revision.content_json) as MarkdownContent;
      if (content.format !== "markdown" || !content.sections) {
        throw new AgentError("INVALID_INPUT", "片段 ID 只能指向分段方案的段落。");
      }
      const known = markdownSectionMap(content);
      for (const id of final.parameters.segmentIds) {
        if (!known.has(id)) throw new AgentError("INVALID_INPUT", `片段 ID ${id} 未指向本方案的一个段落。`);
      }
    }
    // 交付事务把提案的准确方案修订来源写入持久关系（§10.1 唯一写入者之一）；同事务生效。
    db.prepare("UPDATE proposals SET plan_source_json = ?, updated_at = ? WHERE id = ?")
      .run(canonicalJson(source), now, binding.proposalRef.proposalId);
  }
  setStageDraft(db, now, work, binding.stage === "plan" ? "plan" : "content", source, binding.proposalRef?.proposalId ?? null);
}

function insertRevision(
  db: AgentDatabase, now: string, artifact: ArtifactRow, baseRevisionId: string | null,
  item: { title: string; kind: string; content: MarkdownContent | MediaContent }, requestId: string,
  binding: CreationBinding | null = null,
): ArtifactRevisionRow {
  const revisionId = newAgentId("rev");
  const revisionNumber = artifact.head_revision_number + 1;
  const content = item.content;
  db.prepare(
    `INSERT INTO artifact_revisions(id, artifact_id, revision_number, base_revision_id, request_id, run_id, digest, content_json, creation_binding_json, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(revisionId, artifact.id, revisionNumber, baseRevisionId, requestId, digestOf(content), canonicalJson(content),
    binding ? canonicalJson(binding) : null, now);
  // 媒体修订与 blob 关联同事务写入；文本修订没有 blob。
  if (content.format === "media") {
    db.prepare("INSERT INTO revision_blob_links(revision_id,blob_id) VALUES(?,?)").run(revisionId, content.blobId);
  }
  db.prepare("UPDATE artifacts SET title = ?, work_id = COALESCE(?, work_id), head_revision_id = ?, head_revision_number = ?, updated_at = ? WHERE id = ?")
    .run(item.title, binding?.workId ?? null, revisionId, revisionNumber, now, artifact.id);
  const row = getRevisionRow(db, artifact.id, revisionId);
  if (!row) throw new AgentError("TEMPORARILY_UNAVAILABLE", "修订写入失败。");
  return row;
}

// 输入修订被超过、或方案主稿与提案的真实关联被替换后，ready 提案转 stale（同事务、升版、发事件）。
function expireProposalsOnRevisions(db: AgentDatabase, now: string, conversationId: string, ownerId: string, artifacts: ArtifactRow[]): void {
  if (artifacts.length === 0) return;
  const readyProposals = db.prepare(
    "SELECT id, spec_json, revision, plan_source_json FROM proposals WHERE conversation_id = ? AND state = 'ready'",
  ).all(conversationId) as { id: string; spec_json: string; revision: number; plan_source_json: string | null }[];
  for (const proposal of readyProposals) {
    const spec = JSON.parse(proposal.spec_json) as ProductionSpec;
    let stale = spec.inputRevisions.some(ref =>
      artifacts.some(a => a.id === ref.artifactId && a.head_revision_id !== ref.revisionId));
    if (!stale && spec.workId) {
      const bound = proposal.plan_source_json ? JSON.parse(proposal.plan_source_json) as ContentSource : null;
      const work = getWorkRow(db, ownerId, spec.workId);
      if (!bound || bound.kind !== "artifact_revision") {
        // prepare 后尚未交付的新提案保持 ready 等待本轮交付；只有本批确实改动了该事项方案主稿时才失效。
        const state = work ? parseCreationState(work) : null;
        const touchedPlan = artifacts.some(a => a.work_id === spec.workId
          && state?.plan.draft?.kind === "artifact_revision" && state.plan.draft.artifactId === a.id);
        if (touchedPlan) stale = true;
      } else if (!work) {
        stale = true;
      } else {
        // 已关联提案按同一持久来源核对：当前方案主稿被换（含 inputRevisions 为空的提案），
        // 或方案所基于的上游内容已变，都不得再以旧稿冒充。
        const state = parseCreationState(work);
        const current = state.plan.draft;
        const revision = getRevisionRow(db, bound.artifactId, bound.revisionId);
        const binding = revision?.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding : null;
        if (!revision || !current || current.kind !== "artifact_revision"
          || current.artifactId !== bound.artifactId || current.revisionId !== bound.revisionId) stale = true;
        else if (binding?.source && !sameContentSource(binding.source, state.content.draft)) stale = true;
      }
    }
    if (!stale) continue;
    db.prepare("UPDATE proposals SET state = 'stale', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, proposal.id);
    insertEvent(db, now, {
      conversationId, ownerId, kind: "proposal.changed",
      entityId: proposal.id, entityVersion: proposal.revision + 1,
    });
  }
}

function nextArtifactSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM artifacts WHERE conversation_id = ?").get(conversationId) as { seq: number };
  return row.seq + 1;
}

// —— 提案 ——

export interface ProposalRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  digest: string;
  spec_json: string;
  state: Proposal["state"];
  price_disclosure: string;
  expires_at: string;
  accepted_run_id: string | null;
  revision: number;
  created_seq: number;
  created_at: string;
  updated_at: string;
  // 该提案绑定的方案主稿修订来源（ContentSource，§10.1 私有事实）；
  // 唯一写入者是交付事务与 prepare 的原样重提继承，受理后不可变。null＝尚未绑定。
  plan_source_json: string | null;
}

// 提案与方案主稿的准确关系读取入口：受理、失效、发布共用的唯一直接事实来源。
// 返回 null 表示该提案尚未绑定方案主稿。
export function proposalPlanSource(
  db: AgentDatabase,
  ownerId: string,
  conversationId: string,
  proposalId: string,
): { source: ContentSource; binding: CreationBinding; proposalDigest: string } | null {
  const row = db.prepare("SELECT digest, plan_source_json FROM proposals WHERE id=? AND owner_id=? AND conversation_id=?")
    .get(proposalId, ownerId, conversationId) as { digest: string; plan_source_json: string | null } | undefined;
  if (!row?.plan_source_json) return null;
  const source = JSON.parse(row.plan_source_json) as ContentSource;
  if (source.kind !== "artifact_revision") return null;
  const revision = getRevisionRow(db, source.artifactId, source.revisionId);
  if (!revision || revision.digest !== source.digest) return null;
  const binding = revision.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding : null;
  return binding ? { source, binding, proposalDigest: row.digest } : null;
}

// 宿主从 SQLite 解析出的可信输入事实：修订内容格式、blob 元数据、依赖产出类型。
// 只描述冻结事实本身，模型自报的引用 JSON 形状不进入这里。
export type TrustedOperationInput =
  | { kind: "text" }
  | { kind: "artifact_revision"; content: { format: "markdown" } | { format: "media"; blobId: string; mimeType: string } }
  | { kind: "blob"; blobId: string; mimeType: string }
  | { kind: "operation_output"; producerKind: OperationRequest["kind"] };

// 付费前对已有渲染输入文件的探测结果（按 blobId 索引）；T6 起按槽位角色区分视频/音频事实。
export type RenderFileProbe =
  | { ok: true; kind: "video"; width: number; height: number; durationMs: number; videoDurationMs: number; hasAudio: boolean }
  | { ok: true; kind: "audio"; durationMs: number }
  | { ok: true; kind: "image"; width: number; height: number }
  | { ok: false; reason: string };

export interface CatalogValidationContext {
  trusted: Map<string, TrustedOperationInput[]>;
  // 只有真实 render 目录要求在准备提案前探测已有文件。
  renderFileProbes?: Map<string, RenderFileProbe>;
  /** prepare 已验证的冻结旁白码点数，报价直接复用，不重新读取或校验结构。 */
  textCodepoints?: Map<string, number>;
}

// 目录条目校验：核对参数组合、输入形状与尝试次数；不一致抛 AgentError（INVALID_INPUT/CAPABILITY_UNAVAILABLE）。
// 外部请求已通过 Schema；这里只核对已启用能力和可信输入事实。
// 受理是新的能力判断时点；省略 inputs/ctx 时只复核当前参数能力，不重验不可变输入。
export type OperationValidator = (op: OperationRequest, inputs?: TrustedOperationInput[], ctx?: CatalogValidationContext) => void;

export const RENDER_CATALOG_KEY = "render:ordered_concat";
export const NARRATED_CATALOG_KEY = "render:narrated_concat";
export const TIMED_NARRATED_CATALOG_KEY = "render:timed_narrated_concat";
export const MIXED_CATALOG_KEY = "render:mixed_concat";

export interface QuoteCatalogEntry {
  /** 本地 render 能力为 null；供应商模型为具体绑定，参与受理时的配置一致性比较。 */
  binding: ModelBinding | null;
  quoteMinor: number;
  /** 参数化报价：视频用冻结时长/分辨率，配音可用已取得的冻结文本码点数。 */
  quoteMinorFor?: (op: OperationSpec, textCodepoints?: number) => number;
  priceKind: "bounded" | "estimate";
  /** 供应商 estimate 条目的估价来源说明（profile 采价事实）；本地 render 不设。 */
  estimateNote?: string;
  /** 通道固定的单操作创建次数；模型侧工具不接受该参数，由宿主按目录补齐内部 intent。 */
  maxCreateAttempts?: number;
  validate?: OperationValidator;
  /** 为 true 时准备提案前必须对已有渲染输入文件做 ffprobe（真实本地 render）；测试 fixture 不设。 */
  probeRenderInputs?: boolean;
  /** 待生成输出的冻结时长上界（ms）：视频通道按冻结 durationSeconds 计算，配音通道固定 120s；prepare 据此判断成片上限。 */
  outputDurationBoundMs?: number;
}

/** 单一口径的每次尝试报价：参数化条目按操作参数计算，其余用定值。prepare 与 accept 共用。
 * 报价只读 kind/parameters；prepare 的 intent 操作尚未带报价字段，受理的冻结操作带齐，两者同口径。 */
export type QuotePricedOperation = OperationSpec | Omit<OperationSpec, "quotePerAttempt" | "priceKind">;
export function operationQuoteMinor(entry: QuoteCatalogEntry, op: QuotePricedOperation, textCodepoints?: number): number {
  return entry.quoteMinorFor ? entry.quoteMinorFor(op as OperationSpec, textCodepoints) : entry.quoteMinor;
}

// 目录条目来自装配时核实的能力（A 离线 fixture、C1 真实配置或本地 render）；生产没有条目即 CAPABILITY_UNAVAILABLE。
export type QuoteCatalog = Record<string, QuoteCatalogEntry>;

export function rowToProposal(row: ProposalRow, db: AgentDatabase): Proposal {
  const spec = JSON.parse(row.spec_json) as ProductionSpec;
  const runOrder = row.accepted_run_id ? (db.prepare("SELECT rowid AS ordinal FROM production_runs WHERE id=?").get(row.accepted_run_id) as { ordinal: number }).ordinal : Number.MAX_SAFE_INTEGER;
  const audioSummary = productionAudioFacts(db, spec, runOrder).audioSummary;
  return {
    id: row.id, conversationId: row.conversation_id, digest: row.digest,
    spec, state: row.state, ...(audioSummary ? { audioSummary } : {}),
    priceDisclosure: row.price_disclosure, expiresAt: row.expires_at,
    acceptedRunId: row.accepted_run_id, revision: row.revision,
  };
}

export function getProposalRow(db: AgentDatabase, ownerId: string, proposalId: string): ProposalRow | undefined {
  return db.prepare("SELECT * FROM proposals WHERE id = ? AND owner_id = ?").get(proposalId, ownerId) as ProposalRow | undefined;
}

export function listProposalRows(db: AgentDatabase, conversationId: string, limit: number, beforeSeq?: number): ProposalRow[] {
  const sql = beforeSeq === undefined
    ? "SELECT * FROM proposals WHERE conversation_id = ? ORDER BY created_seq DESC LIMIT ?"
    : "SELECT * FROM proposals WHERE conversation_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?";
  return (beforeSeq === undefined
    ? db.prepare(sql).all(conversationId, limit)
    : db.prepare(sql).all(conversationId, beforeSeq, limit)) as ProposalRow[];
}

export function maxProposalSeq(db: AgentDatabase, conversationId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(created_seq), 0) AS seq FROM proposals WHERE conversation_id = ?").get(conversationId) as { seq: number };
  return row.seq;
}

interface AudioEvidence {
  texts: string[];
  unknown: boolean;
  speech: AudioSummary["narration"];
  hasSpeech: boolean;
  hasMusic: boolean;
}

// 提案核对、运行与作品库共用原run声音事实；未知原声与已知独立配音分别保留。
// 只沿已有生产引用追溯，不读当前方案/默认型号，也不自动转写外部媒体。
export function productionAudioFacts(db: AgentDatabase, spec: ProductionIntent | ProductionSpec, runOrder = Number.MAX_SAFE_INTEGER): {
  narrationText: string | null; knownNarrationText: string | null; audioSummary?: AudioSummary;
  speechInMusic: boolean; stackedMusic: boolean;
} {
  let audioSummary: AudioSummary | undefined;
  let speechInMusic = false;
  let stackedMusic = false;
  const empty: AudioEvidence = { texts: [], unknown: false, speech: null, hasSpeech: false, hasMusic: false };
  const unknown: AudioEvidence = { ...empty, unknown: true };
  const readInput = (input: InputRef, source: ProductionIntent | ProductionSpec, beforeRun: number): AudioEvidence => {
    if (input.kind === "operation_output") return readOperation(source, input.producerOperationId, beforeRun);
    if (input.kind === "text") return { ...empty, texts: [input.text] };
    let blobId: string;
    let sourceRunId: string | null = null;
    if (input.kind === "artifact_revision") {
      const revision = getRevisionRow(db, input.artifactId, input.revisionId);
      if (!revision) return unknown;
      const content = JSON.parse(revision.content_json) as ArtifactRevision["content"];
      if (content.format === "markdown") return { ...empty, texts: [speechText(content)] };
      blobId = content.blobId;
      sourceRunId = revision.run_id;
    } else blobId = input.blobId;
    // 精确修订绑定原run；裸blob只接受此前一致的生产证据，不能挑最新同字节记录。
    const producers = db.prepare(`SELECT o.id, r.rowid AS run_order, s.spec_json FROM production_operations o
      JOIN production_runs r ON r.id = o.run_id JOIN production_snapshots s ON s.id = r.snapshot_id
      WHERE o.output_blob_id = ? AND r.rowid < ? AND (? IS NULL OR r.id = ?)`)
      .all(blobId, beforeRun, sourceRunId, sourceRunId) as { id: string; run_order: number; spec_json: string }[];
    const evidence = producers.map(producer => readOperation(JSON.parse(producer.spec_json) as ProductionSpec, producer.id, producer.run_order));
    if (evidence.length === 0) return unknown;
    const first = evidence[0]!;
    if (!evidence.every(item => canonicalJson({ texts: item.texts, unknown: item.unknown }) === canonicalJson({ texts: first.texts, unknown: first.unknown }))) {
      return { ...unknown, hasSpeech: evidence.some(item => item.hasSpeech), hasMusic: evidence.some(item => item.hasMusic) };
    }
    return { ...first, speech: evidence.every(item => canonicalJson(item.speech) === canonicalJson(first.speech)) ? first.speech : null };
  };
  const readOperation = (source: ProductionIntent | ProductionSpec, id: string, beforeRun: number): AudioEvidence => {
    const operation = source.operations.find(item => item.operationId === id)!;
    if (operation.kind === "speech") {
      const text = readInput(operation.inputs[0]!, source, beforeRun).texts.join("\n") || null;
      return { ...empty, texts: text ? [text] : [], unknown: text === null, hasSpeech: true,
        speech: { text, providerName: operation.model.providerId === "minimax" ? "MiniMax" : operation.model.providerId === "openai" ? "OpenAI" : null,
          modelName: operation.model.modelId,
          voiceName: operation.model.providerId === "minimax" && operation.parameters.voiceId === "Chinese (Mandarin)_Gentleman" ? "温润男声" : operation.parameters.voiceId,
          timelineStartMs: 0, gain: 1 } };
    }
    if (operation.kind === "image") return empty;
    if (operation.kind === "video") return operation.parameters.audioMode === "none" ? empty : unknown;
    const parameters = operation.parameters;
    if (parameters.assembly === "narrated_concat" || parameters.assembly === "timed_narrated_concat") {
      return readInput(operation.inputs[parameters.narrationInputSlot]!, source, beforeRun);
    }
    if (parameters.assembly === "ordered_concat") {
      if (parameters.audioMode !== "preserve") return empty;
      const parts = operation.inputs.map(input => readInput(input, source, beforeRun));
      return { texts: parts.flatMap(part => part.texts), unknown: parts.some(part => part.unknown),
        speech: parts.length === 1 ? parts[0]!.speech : null, hasSpeech: parts.some(part => part.hasSpeech), hasMusic: parts.some(part => part.hasMusic) };
    }
    let originalHasMusic = false;
    let originalHasSpeech = false;
    const originals = parameters.segments.map((segment, index): AudioSummary["original"][number] => {
      const input = operation.inputs[segment.inputSlot]!;
      const evidence = segment.kind === "image" || segment.originalGain === 0 ? empty : readInput(input, source, beforeRun);
      const gain = segment.kind === "image" || (!evidence.unknown && evidence.texts.length === 0 && !evidence.hasMusic) ? 0 : segment.originalGain ?? 1;
      if (gain > 0) { originalHasMusic ||= evidence.hasMusic; originalHasSpeech ||= evidence.hasSpeech; }
      if (gain > 0 && evidence.hasMusic && parameters.music && parameters.music.gain > 0) stackedMusic = true;
      let sourceDurationMs = 0;
      if (segment.kind === "video" && !evidence.unknown && gain > 0) {
        if (input.kind === "blob") sourceDurationMs = (db.prepare("SELECT duration_ms FROM production_blobs WHERE id=?").get(input.blobId) as { duration_ms: number | null } | undefined)?.duration_ms ?? 0;
        else if (input.kind === "artifact_revision") {
          const revision = getRevisionRow(db, input.artifactId, input.revisionId);
          const media = revision ? JSON.parse(revision.content_json) as ArtifactRevision["content"] : null;
          if (media?.format === "media") sourceDurationMs = media.durationMs ?? 0;
        } else if (input.kind === "operation_output") {
          const producer = source.operations.find(item => item.operationId === input.producerOperationId)!;
          if (producer.kind === "video") sourceDurationMs = producer.parameters.durationSeconds * 1000;
        }
      }
      return { segmentId: parameters.segmentIds[index]!, gain, sourceText: gain > 0 ? evidence.texts.join("\n") || null : null,
        // 裁切只给来源台词，不推断哪些字仍被保留。
        textCoverage: gain === 0 ? "muted" : evidence.unknown ? "unknown"
          : segment.kind === "video" && segment.startMs === 0 && sourceDurationMs > 0 && segment.durationMs >= sourceDurationMs ? "full_source" : "source_excerpt" };
    });
    const narration = parameters.narration && parameters.narration.gain > 0
      ? readInput(operation.inputs[parameters.narration.inputSlot]!, source, beforeRun) : null;
    const music = parameters.music && parameters.music.gain > 0
      ? readInput(operation.inputs[parameters.music.inputSlot]!, source, beforeRun) : null;
    if (music?.hasSpeech) speechInMusic = true;
    const musicSource = (operation as Extract<OperationSpec, { kind: "render" }>).musicSource;
    if (source === spec && id === spec.finalOutput.operationId) {
      audioSummary = {
        original: originals,
        music: parameters.music && musicSource ? { source: musicSource,
          sourceStartMs: parameters.music.sourceStartMs, sourceDurationMs: parameters.music.sourceDurationMs,
          timelineStartMs: parameters.music.timelineStartMs, playDurationMs: parameters.music.playDurationMs,
          repeat: parameters.music.repeat, gain: parameters.music.gain, fadeInMs: parameters.music.fadeInMs,
          fadeOutMs: parameters.music.fadeOutMs, duckUnderNarration: parameters.music.duckUnderNarration } : null,
        narration: parameters.narration ? { text: narration?.texts.join("\n") || null,
          providerName: narration?.speech?.providerName ?? null, modelName: narration?.speech?.modelName ?? null,
          voiceName: narration?.speech?.voiceName ?? null, timelineStartMs: parameters.narration.timelineStartMs, gain: parameters.narration.gain } : null,
      };
    }
    return { texts: narration ? narration.texts : originals.flatMap(item => item.sourceText ? [item.sourceText] : []),
      unknown: narration ? narration.unknown : originals.some(item => item.textCoverage === "unknown"),
      speech: narration?.speech ?? null, hasSpeech: Boolean(narration?.hasSpeech) || originalHasSpeech,
      hasMusic: music !== null || originalHasMusic };
  };
  const final = spec.operations.find(operation => operation.operationId === spec.finalOutput.operationId)!;
  const evidence = readOperation(spec, final.operationId, runOrder);
  const knownNarrationText = final.kind === "video" || final.kind === "render" ? evidence.texts.join("\n") || null : null;
  return { narrationText: evidence.unknown ? null : knownNarrationText,
    knownNarrationText, ...(audioSummary ? { audioSummary } : {}), speechInMusic, stackedMusic };
}

export function productionNarrationText(db: AgentDatabase, spec: ProductionIntent | ProductionSpec, runOrder = Number.MAX_SAFE_INTEGER): string | null {
  return productionAudioFacts(db, spec, runOrder).narrationText;
}

// 两个合法绑定点共用：首次报价与先 prepare 后交付，均不得把新台词绑到旧方案。
export function validatePlanNarration(db: AgentDatabase, plan: ContentSource, spec: ProductionSpec): void {
  const actual = productionAudioFacts(db, spec).knownNarrationText;
  if (actual === null || plan.kind !== "artifact_revision") return;
  const content = JSON.parse(getRevisionRow(db, plan.artifactId, plan.revisionId)!.content_json) as MarkdownContent;
  let expected = content.narrationText;
  if (expected === undefined) {
    // 旧修订仅沿自身已有的唯一冻结输入继承，多个不同台词不能按时间猜一个。
    const prior = db.prepare("SELECT spec_json FROM proposals WHERE plan_source_json = ?").all(canonicalJson(plan)) as { spec_json: string }[];
    const texts = new Set(prior.map(row => productionNarrationText(db, JSON.parse(row.spec_json) as ProductionSpec)).filter(text => text !== null));
    if (texts.size === 1) expected = [...texts][0]!;
  }
  if (expected === undefined) throw new AgentError("PROPOSAL_STALE", "这份方案尚未明确唯一的逐字旁白；请交付带旁白原文的新方案，再准备费用。");
  if (actual !== expected) throw new AgentError("PROPOSAL_STALE", "实际配音与方案旁白原文不一致；换词请交付新方案，再关联本次报价。");
}

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

// prepare_production 单事务：校验输入修订 → 服务端解析报价 → 落库提案 → 事件。
// 供 Pi 工具与 HTTP prepareProposal 共用；调用方负责自己的幂等键。
// probes 由调用方在事务外用 ffprobe 预先取得（付费前探测已有渲染输入文件）。
export function applyPrepareProposal(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  intent: ProductionIntent,
  catalog: QuoteCatalog,
  probes?: Map<string, RenderFileProbe>,
  planSource?: RevisionRef,
  replacesProposal?: ProposalRef,
): { proposal: ProposalRow; replayed: boolean } {
  const work = intent.workId === null ? null : requireWork(db, scope.ownerId, scope.conversationId, intent.workId);
  const revisions = new Map<string, string>();
  for (const ref of intent.inputRevisions) {
    const artifact = getArtifactRow(db, scope.ownerId, ref.artifactId);
    const revision = artifact ? getRevisionRow(db, ref.artifactId, ref.revisionId) : undefined;
    if (!artifact || !revision || artifact.conversation_id !== scope.conversationId) throw new AgentError("INVALID_INPUT", "输入修订不存在或不属于当前会话。");
    revisions.set(`${ref.artifactId}:${ref.revisionId}`, revision.digest);
  }
  const operations = new Map(intent.operations.map(op => [op.operationId, op]));
  if (operations.size !== intent.operations.length) throw new AgentError("INVALID_INPUT", "操作 ID 不能重复。");
  if (new Set(intent.operations.map(op => op.outputSlot)).size !== intent.operations.length) throw new AgentError("INVALID_INPUT", "输出槽位不能重复。");
  const used = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const trusted = new Map<string, TrustedOperationInput[]>();
  const textCodepoints = new Map<string, number>();
  const operationSources = new Map<string, MediaProvenance[]>();
  const musicSources = new Map<string, MediaProvenance>();
  const mixedParametersById = new Map<string, Extract<OperationSpec, { kind: "render" }>["parameters"]>();
  // 自底向上的输出时长上界（ms）：已有文件取真实时长，待生成输出取通道冻结上界；narrated 据此拒绝已知超限。
  const durationBounds = new Map<string, number>();
  // 上界是否全部来自已核实的素材时长（blob/探测）；通道上界只作守卫，不进披露句。
  const durationVerified = new Map<string, boolean>();
  // 槽位真实时长：prepare 探测优先，退回 blob 行持久时长（采用/生成媒体都落真实 duration）。
  const blobDurationMs = (blobId: string): number => {
    const probe = probes?.get(blobId);
    if (probe?.ok && probe.kind === "video") return probe.videoDurationMs;
    if (probe?.ok && probe.kind === "audio") return probe.durationMs;
    return (db.prepare("SELECT duration_ms FROM production_blobs WHERE id=?").get(blobId) as { duration_ms: number | null } | undefined)?.duration_ms ?? 0;
  };
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new AgentError("INVALID_INPUT", "操作依赖不能循环。");
    visiting.add(id);
    const op = operations.get(id)!;
    const facts: TrustedOperationInput[] = [];
    const sources: MediaProvenance[][] = [];
    const durations: number[] = [];
    const slotVerified: boolean[] = [];
    const parameters = op.kind === "render" ? op.parameters : null;
    const narratedParameters = parameters?.assembly === "narrated_concat" ? parameters : null;
    const narrated = narratedParameters !== null;
    const timedParameters = parameters?.assembly === "timed_narrated_concat" ? parameters : null;
    const mixedParameters = parameters?.assembly === "mixed_concat" ? parameters : null;
    const timelineParameters = timedParameters ?? mixedParameters;
    const narrationSlot = timedParameters?.narrationInputSlot ?? mixedParameters?.narration?.inputSlot;
    const audioSlots = new Set<number>();
    const videoSlots = new Set<number>();
    const imageSlots = new Set<number>();
    let timedTargetMs = 0;
    if (parameters?.segmentIds) {
      // 长度一致性在准备边界核对一次，随后随快照冻结（B2.3）；语义引用在 boundPlan 确定后核对。
      const visualCount = timelineParameters ? timelineParameters.segments.length
        : narratedParameters ? narratedParameters.videoInputSlots.length
        : op.inputs.length;
      if (parameters.segmentIds.length !== visualCount) {
        throw new AgentError("INVALID_INPUT", "片段 ID 数量与 render 的画面时间线不一致。");
      }
    }
    if (narratedParameters) {
      // 槽位覆盖完整且互不重复是后续按下标取 sources/durations 的内部前提（固定参数已由 canonical 入口验证）。
      const slots = [...narratedParameters.videoInputSlots, narratedParameters.narrationInputSlot];
      if (new Set(slots).size !== slots.length || slots.length !== op.inputs.length || slots.some(slot => slot >= op.inputs.length)) {
        throw new AgentError("INVALID_INPUT", "有声拼接的槽位引用与输入数量不一致。");
      }
      audioSlots.add(narratedParameters.narrationInputSlot);
      for (const slot of narratedParameters.videoInputSlots) videoSlots.add(slot);
    }
    if (timelineParameters) {
      const slotKinds = new Map<number, "video" | "image">();
      for (const segment of timelineParameters.segments) {
        const existing = slotKinds.get(segment.inputSlot);
        if (existing && existing !== segment.kind) throw new AgentError("INVALID_INPUT", "同一输入槽不能同时作为视频与图片。");
        slotKinds.set(segment.inputSlot, segment.kind);
      }
      const audio = [...(narrationSlot === undefined ? [] : [narrationSlot]), ...(mixedParameters?.music ? [mixedParameters.music.inputSlot] : [])];
      if (new Set(audio).size !== audio.length || audio.some(slot => slotKinds.has(slot))) {
        throw new AgentError("INVALID_INPUT", "音乐、配音与视觉槽位不能互相重叠。");
      }
      const usedSlots = new Set([...slotKinds.keys(), ...audio]);
      if (usedSlots.size !== op.inputs.length || [...usedSlots].some(slot => slot >= op.inputs.length)) {
        throw new AgentError("INVALID_INPUT", "时间线槽位必须完整覆盖全部输入且不引用不存在的输入。");
      }
      for (const slot of audio) audioSlots.add(slot);
      for (const [slot, kind] of slotKinds) (kind === "video" ? videoSlots : imageSlots).add(slot);
      timedTargetMs = timelineParameters.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
      if (timedTargetMs > 120_000) throw new AgentError("INVALID_INPUT", "成片总长超过本配置 120s 上限；请缩短片段。");
    }
    for (const [slot, input] of op.inputs.entries()) {
      const audio = audioSlots.has(slot);
      const image = imageSlots.has(slot);
      if (input.kind === "blob") {
        const blob = db.prepare("SELECT mime_type FROM production_blobs WHERE id=? AND digest=? AND owner_id=? AND conversation_id=?").get(input.blobId, input.digest, scope.ownerId, scope.conversationId) as { mime_type: string } | undefined;
        if (!blob) throw new AgentError("INVALID_INPUT", "媒体输入不存在或不属于当前会话。");
        if (op.kind === "render") {
          const accepted = audio ? blob.mime_type === "audio/mpeg" : image ? blob.mime_type.startsWith("image/") : blob.mime_type === "video/mp4" || blob.mime_type === "video/webm";
          if (!accepted) {
            throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受音频素材。" : image ? "图片片段只接受图片素材。" : narrated ? "视频画面槽只接受视频片段。" : "有序拼接只接受视频片段。");
          }
        }
        facts.push({ kind: "blob", blobId: input.blobId, mimeType: blob.mime_type });
        if (op.kind === "render") sources.push(blobSources(db, input.blobId));
        const duration = image ? 0 : blobDurationMs(input.blobId);
        durations.push(duration);
        const probe = probes?.get(input.blobId);
        slotVerified.push(image ? (!probes || probe?.ok === true && probe.kind === "image") : duration > 0);
        continue;
      }
      if (input.kind === "text" || input.kind === "artifact_revision") {
        if (input.kind === "artifact_revision") {
          const key = `${input.artifactId}:${input.revisionId}`;
          if (revisions.get(key) !== input.digest) throw new AgentError("INVALID_INPUT", "操作引用必须在输入清单中且摘要一致。");
          used.add(key);
        }
        const content = input.kind === "text" ? { format: "markdown" as const, text: input.text }
          : rowToArtifactRevision(getRevisionRow(db, input.artifactId, input.revisionId)!).content;
        if (op.kind === "speech") {
          // §9.3：TrustedOperationInput 只有元数据；实际文本在 prepare 这里读一次并判断 1–1000 码点，
          // 冻结原文原样发送（不删标题/改写/截断），accept 与适配器不再重复结构校验。
          // 分段文稿按同一序列化取完整正文：报价所计字符与实际发送文本一致（B2）。
          if (content.format !== "markdown") throw new AgentError("INVALID_INPUT", "配音只接受一份旁白文本。");
          const codepoints = [...speechText(content)].length;
          textCodepoints.set(op.operationId, codepoints);
          if (codepoints < 1 || codepoints > 1000) {
            throw new AgentError("INVALID_INPUT", `旁白文本须为 1–1000 个 Unicode 码点，当前 ${codepoints}。`);
          }
        }
        if (op.kind === "render") {
          if (content.format !== "media") throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受音频修订。" : image ? "图片片段只接受图片修订。" : "视频片段只接受视频修订。");
          const accepted = audio ? content.mimeType === "audio/mpeg" : image ? content.mimeType.startsWith("image/") : content.mimeType === "video/mp4" || content.mimeType === "video/webm";
          if (!accepted) throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受音频修订。" : image ? "图片片段只接受图片修订。" : narrated ? "视频画面槽只接受视频修订。" : "有序拼接只接受视频片段。");
          sources.push(blobSources(db, content.blobId));
          const duration = image ? 0 : blobDurationMs(content.blobId);
          durations.push(duration);
          const probe = probes?.get(content.blobId);
          slotVerified.push(image ? (!probes || probe?.ok === true && probe.kind === "image") : duration > 0);
        }
        facts.push(input.kind === "text" ? { kind: "text" } : content.format === "media"
          ? { kind: "artifact_revision", content: { format: "media", blobId: content.blobId, mimeType: content.mimeType } }
          : { kind: "artifact_revision", content: { format: "markdown" } });
      } else {
        const producer = operations.get(input.producerOperationId);
        if (!producer || producer.outputSlot !== input.outputSlot) throw new AgentError("INVALID_INPUT", "操作输出引用不存在。");
        if (op.kind === "render") {
          const accepted = audio ? producer.kind === "speech" : image ? producer.kind === "image" : producer.kind === "video" || producer.kind === "render";
          if (!accepted) {
            throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受配音输出。" : image ? "图片片段只接受图片生成输出。" : narrated ? "视频画面槽不能引用图片或配音输出。" : "有序拼接不能把图片或配音当作视频片段。");
          }
        }
        facts.push({ kind: "operation_output", producerKind: producer.kind });
        visit(producer.operationId);
        if (op.kind === "render") sources.push(operationSources.get(producer.operationId)!);
        durations.push(image ? 0 : durationBounds.get(producer.operationId) ?? 0);
        slotVerified.push(image ? true : durationVerified.get(producer.operationId) ?? false);
      }
    }
    if (timelineParameters) {
      // 视频裁切必须落在源文件真实时长内；图片只接受实际可解码的图片。
      for (const segment of timelineParameters.segments) {
        if (segment.kind !== "video") continue;
        const available = durations[segment.inputSlot] ?? 0;
        if (available < segment.startMs + segment.durationMs) {
          throw new AgentError("INVALID_INPUT", `片段从 ${(segment.startMs / 1000).toFixed(1)}s 起取 ${(segment.durationMs / 1000).toFixed(1)}s，超出该视频可用时长 ${(available / 1000).toFixed(1)}s。`);
        }
      }
      const narration = narrationSlot === undefined ? 0 : durations[narrationSlot] ?? 0;
      const narrationStart = mixedParameters?.narration?.timelineStartMs ?? 0;
      // F07：只有已核实的真实旁白时长才能在付费前拒绝；待生成输出只有通道冻结上界
      // （如配音 120s），不是“已知超长”。待生成提案放行并披露固定长短策略，
      // 实际长度生成后由渲染期探测处理（超长则保留音频与费用事实并如实失败）。
      if (narrationSlot !== undefined && slotVerified[narrationSlot] === true && narrationStart + narration > timedTargetMs) {
        throw new AgentError("INVALID_INPUT", `旁白约 ${(narration / 1000).toFixed(1)}s，超过画面总长 ${(timedTargetMs / 1000).toFixed(1)}s；本策略不加速、不剪词、不延长画面，请修改方案。`);
      }
    }
    if (mixedParameters) {
      if (mixedParameters.narration && mixedParameters.narration.timelineStartMs >= timedTargetMs) {
        throw new AgentError("INVALID_INPUT", "配音开始位置必须在画面时长内，且完整配音不能超出画面。");
      }
      if (mixedParameters.music) {
        const music = mixedParameters.music;
        const fact = facts[music.inputSlot]!;
        const blobId = fact.kind === "blob" ? fact.blobId
          : fact.kind === "artifact_revision" && fact.content.format === "media" ? fact.content.blobId : null;
        if (!blobId) throw new AgentError("INVALID_INPUT", "音乐槽须引用本会话已经采用的音频文件。");
        const source = readAdoptedAudioSource(db, scope, music.candidateId, blobId);
        if (music.sourceStartMs + music.sourceDurationMs > durations[music.inputSlot]!) {
          throw new AgentError("INVALID_INPUT", "音乐选区超出实际音频时长。");
        }
        if ((!music.repeat && music.playDurationMs > music.sourceDurationMs) || music.timelineStartMs + music.playDurationMs > timedTargetMs) {
          throw new AgentError("INVALID_INPUT", "音乐播放超出选区或画面时长；不足时请明确是否循环，不自动循环或延长画面。");
        }
        if (music.fadeInMs + music.fadeOutMs > music.playDurationMs) {
          throw new AgentError("INVALID_INPUT", "音乐淡入与淡出总长不能超过播放时长。");
        }
        const frozenSource = { ...source,
          ...(source.attributionText ? { attributionText: `${source.attributionText}\n本视频对音乐进行了选段、音量调整与混音。` } : {}) };
        musicSources.set(id, frozenSource);
        sources[music.inputSlot] = music.gain > 0 ? [frozenSource] : [];
      }
      mixedParametersById.set(id, { ...mixedParameters,
        segments: mixedParameters.segments.map(segment => {
          if (segment.kind === "image") return segment;
          const fact = facts[segment.inputSlot]!;
          const blobId = fact.kind === "blob" ? fact.blobId
            : fact.kind === "artifact_revision" && fact.content.format === "media" ? fact.content.blobId : null;
          const probe = blobId ? probes?.get(blobId) : null;
          const input = op.inputs[segment.inputSlot]!;
          const producer = input.kind === "operation_output" ? operations.get(input.producerOperationId) : null;
          const silent = probe?.ok && probe.kind === "video" && !probe.hasAudio
            || producer?.kind === "video" && producer.parameters.audioMode === "none";
          return { ...segment, originalGain: silent ? 0 : segment.originalGain ?? 1 };
        }) as typeof mixedParameters.segments,
        ...(mixedParameters.music ? { music: { ...mixedParameters.music,
          duckUnderNarration: mixedParameters.music.duckUnderNarration && (mixedParameters.narration?.gain ?? 0) > 0 } } : {}) });
    }
    // 视觉来源按片段顺序，音乐采用准确候选的冻结来源；音量0不声称使用该独立音轨。
    if (op.kind === "render") {
      operationSources.set(id, mergeSources(timelineParameters
        ? [...timelineParameters.segments.map(segment => sources[segment.inputSlot]!),
          ...(mixedParameters?.music ? [sources[mixedParameters.music.inputSlot]!] : []),
          ...(narrationSlot === undefined || mixedParameters?.narration?.gain === 0 ? [] : [sources[narrationSlot]!])]
        : narratedParameters
          ? [...narratedParameters.videoInputSlots.map(slot => sources[slot]!), sources[narratedParameters.narrationInputSlot]!]
          : sources));
    } else {
      operationSources.set(id, []);
    }
    if (op.kind === "video" || op.kind === "speech") {
      // 待生成输出的时长未知；通道上界只作守卫，不视为已核实。视频按冻结时长参数取上界。
      const boundEntry = catalog[`${op.kind}:${op.model.modelId}`];
      durationBounds.set(id, op.kind === "video"
        ? op.parameters.durationSeconds * 1000
        : boundEntry?.outputDurationBoundMs ?? 0);
      durationVerified.set(id, false);
    } else if (op.kind === "render") {
      const allSlotsVerified = slotVerified.length > 0 && slotVerified.every(Boolean);
      const bound = timelineParameters
        ? timedTargetMs
        : narratedParameters
          ? Math.max(narratedParameters.videoInputSlots.reduce((sum, slot) => sum + durations[slot]!, 0), durations[narratedParameters.narrationInputSlot]!)
          : durations.reduce((sum, value) => sum + value, 0);
      // §10：已知超限（含重复引用逐次计时）在任何新付费 POST 前拒绝；preserve_all 不靠裁剪过关。
      if ((narrated || timelineParameters) && bound > 120_000) {
        throw new AgentError("INVALID_INPUT", `已知输入组合的成片时长上界约 ${(bound / 1000).toFixed(0)}s，超过本配置 120s 上限；请先缩短画面或旁白。`);
      }
      durationBounds.set(id, bound);
      // timed 的成片时长由冻结片段之和决定，与旁白实际长度无关（过长会在渲染时如实失败）。
      durationVerified.set(id, timelineParameters
        ? timelineParameters.segments.every(segment => slotVerified[segment.inputSlot] === true)
        : allSlotsVerified);
    }
    trusted.set(id, facts);
    visiting.delete(id); visited.add(id);
  };
  for (const op of intent.operations) visit(op.operationId);
  if (used.size !== revisions.size) throw new AgentError("INVALID_INPUT", "输入清单中存在未使用的修订。");
  const final = operations.get(intent.finalOutput.operationId);
  if (!final || final.outputSlot !== intent.finalOutput.outputSlot) throw new AgentError("INVALID_INPUT", "最终输出不存在。");
  // 新视频与视频 render 必须落在已正式开始的视频创作内，且内容已认可并明确继续；
  // 不能以 workId=null / 空 inputRevisions / 纯 text 绕过阶段规则。
  if ((final.kind === "video" || final.kind === "render") && !work) throw new AgentError("INVALID_INPUT", "视频制作必须关联已正式开始的视频创作；请先开始一条视频并完成内容认可。");
  if (work) requireContentContinued(db, work);
  const spec = resolveSpec(intent, catalog, { trusted, textCodepoints, ...(probes ? { renderFileProbes: probes } : {}) });
  for (const operation of spec.operations) {
    if (operation.kind !== "render" || operation.parameters.assembly !== "mixed_concat") continue;
    operation.parameters = mixedParametersById.get(operation.operationId)!;
    const musicSource = musicSources.get(operation.operationId);
    if (musicSource) operation.musicSource = musicSource;
    const audio = productionAudioFacts(db, { ...spec, finalOutput: { operationId: operation.operationId, outputSlot: operation.outputSlot } });
    if (audio.speechInMusic) throw new AgentError("INVALID_INPUT", "已知配音不能放进音乐槽；请作为独立配音使用并核对方案原文。");
    if (audio.stackedMusic) throw new AgentError("INVALID_INPUT", "该片段已混入旧音乐；换音乐请读回原运行，复用原始视觉片段和既有配音，不叠加旧曲。");
  }
  const digest = digestOf(spec);
  // 优先引用已交付方案；旧入口的同内容重提仍继承准确关联。两者都不修改文稿或认可。
  let boundPlan: ContentSource | null = null;
  const state = work ? parseCreationState(work) : null;
  if (planSource) {
    if (!work || !state) throw new AgentError("INVALID_INPUT", "请指定这份方案所属的视频。");
    const draft = state.plan.draft;
    if (workInFlight(db, work.id)) throw new AgentError("RUN_BUSY", "当前版本正在制作，不能更换制作提案。");
    if (draft?.kind !== "artifact_revision" || draft.artifactId !== planSource.artifactId || draft.revisionId !== planSource.revisionId
      || !sameContentSource(revisionCreationBinding(db, draft.artifactId, draft.revisionId)?.source ?? null, state.content.draft)) {
      throw new AgentError("PROPOSAL_STALE", "请使用当前内容对应的最新画面与声音方案。");
    }
    // 准备制作直接引用已有方案；报价不写回创作文稿，也不改变用户的认可。
    boundPlan = draft;
  } else if ((final.kind === "video" || final.kind === "render") && work && state) {
    if (!workInFlight(db, work.id) && state.plan.draft?.kind === "artifact_revision") {
      const draft = state.plan.draft;
      const originBinding = revisionCreationBinding(db, draft.artifactId, draft.revisionId);
      const originId = state.plan.proposalId ?? originBinding?.proposalRef?.proposalId ?? null;
      const origin = originId
        ? db.prepare("SELECT spec_json FROM proposals WHERE id = ? AND owner_id = ? AND conversation_id = ?")
          .get(originId, scope.ownerId, scope.conversationId) as { spec_json: string } | undefined
        : undefined;
      const originSpec = origin ? JSON.parse(origin.spec_json) as ProductionSpec : null;
      // 只比较结构字段：除 maxSpend.amountMinor（新授权上限单独披露、另行明确开始）外一律精确相等。
      const normalized = (value: ProductionSpec): string =>
        canonicalJson({ ...value, maxSpend: { ...value.maxSpend, amountMinor: 0 } });
      if (originSpec && originSpec.workId === intent.workId
        && originBinding!.source && sameContentSource(originBinding!.source, state.content.draft)
        && normalized(spec) === normalized(originSpec)) {
        boundPlan = draft;
      }
    }
  }
  if (boundPlan) validatePlanNarration(db, boundPlan, spec);
  let replaced: ProposalRow | undefined;
  if (replacesProposal) {
    replaced = getProposalRow(db, scope.ownerId, replacesProposal.proposalId);
    if (!replaced || replaced.conversation_id !== scope.conversationId || replaced.digest !== replacesProposal.digest) {
      throw new AgentError("PROPOSAL_STALE", "替换目标不存在、不属于当前会话或摘要已变化；没有撤销任何报价。");
    }
    if (replaced.state !== "ready" || replaced.accepted_run_id || replaced.expires_at <= now) {
      throw new AgentError("PROPOSAL_STALE", "只能明确替换仍待确认的有效报价；已受理事实保持不变。");
    }
    const previous = JSON.parse(replaced.spec_json) as ProductionSpec;
    const productionScope = (value: ProductionSpec) => canonicalJson({ workId: value.workId,
      inputRevisions: value.inputRevisions, finalOutput: value.finalOutput,
      operations: value.operations.map(({ quotePerAttempt: _quote, priceKind: _price, ...operation }) => operation) });
    if (productionScope(previous) !== productionScope(spec) || replaced.plan_source_json !== (boundPlan ? canonicalJson(boundPlan) : null)) {
      throw new AgentError("PROPOSAL_STALE", "替换报价必须属于同一事项、准确方案和制作范围；不同作品或方案请准备独立报价。");
    }
  }
  // 命令/工具调用层已经保证幂等。新的明确准备产生新提案，不能被过期的同内容提案吸收。
  // segmentIds 的段落引用核对：绑定方案后每个 ID 必须指向该方案修订的一个段落（B2.3）。
  if (boundPlan && final.kind === "render" && final.parameters.segmentIds) {
    const planRevision = getRevisionRow(db, boundPlan.artifactId, boundPlan.revisionId);
    const planContent = planRevision ? JSON.parse(planRevision.content_json) as MarkdownContent : null;
    if (!planContent || planContent.format !== "markdown" || !planContent.sections) {
      throw new AgentError("INVALID_INPUT", "片段 ID 只能指向分段方案的段落。");
    }
    const known = markdownSectionMap(planContent);
    for (const id of final.parameters.segmentIds) {
      if (!known.has(id)) throw new AgentError("INVALID_INPUT", `片段 ID ${id} 未指向本方案的一个段落。`);
    }
  }
  const expiresAt = new Date(new Date(now).getTime() + PROPOSAL_TTL_MS).toISOString();
  const proposalId = newAgentId("prp");
  const seq = maxProposalSeq(db, scope.conversationId) + 1;
  // 生成类型把 render 分支的 amountMinor 标成可选（const 0 叠加索引签名的产物）；
  // 运行时 Schema 保证必填，这里按 0 兜底只影响展示文案。
  const totalMinor = spec.operations.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
  const estimate = spec.operations.some(op => op.priceKind === "estimate");
  // 估价来源按提案实际使用的目录条目说明（B2）：不写死任何通道的单价文案。
  const estimateNotes = [...new Set(spec.operations
    .filter(op => (op.kind === "image" || op.kind === "speech") && op.model !== null)
    .map(op => catalog[`${op.kind}:${op.model?.modelId}`]?.estimateNote)
    .filter((note): note is string => typeof note === "string"))].join("");
  // 仅当最终拼接的全部输入时长都已核实（blob/探测真实时长）才如实披露预计成片时长；
  // 待生成内容的通道上界只用于守卫（T6-09），写进“预计成片”会对用户虚报时长。
  const finalDurationBound = final.kind === "render" && durationVerified.get(final.operationId) === true
    ? durationBounds.get(final.operationId) ?? 0 : 0;
  // 声音方案人话：拼接成片按分支说明输出音轨（§11.4 与 PC 制作范围同口径）。
  const hasOrderedRender = spec.operations.some(op => op.kind === "render" && op.parameters.assembly === "ordered_concat");
  const orderedPreserve = spec.operations.some(op => op.kind === "render" && op.parameters.assembly === "ordered_concat"
    && (op.parameters as Extract<typeof op.parameters, { assembly: "ordered_concat" }>).audioMode === "preserve");
  const audioPlanNote = spec.operations.some(op => op.kind === "render" && op.parameters.assembly === "mixed_concat")
    ? "按冻结方案混音，原声、音乐与独立配音的实际选择见声音摘要；画面不延长、配音不剪词。" + (spec.operations.every(op => op.kind === "render") ? "本次仅本地重合成，复用已有媒体；render不产生媒体供应商费用。" : "新生成的配音或画面单独计费。")
    : spec.operations.some(op => op.kind === "render" && op.parameters.assembly === "timed_narrated_concat")
    ? "按方案裁切片段并用旁白替换原声；旁白不足补静音，超过画面总长则如实失败，不加速、不剪词、不延长画面。"
    : spec.operations.some(op => op.kind === "render" && op.parameters.assembly === "narrated_concat")
    ? "使用旁白替换原声；保留完整内容，必要时停留尾帧/补静音。"
    : orderedPreserve
    ? "按画面顺序拼接并保留各镜头原声，无音轨片段补等长静音。"
    : hasOrderedRender ? "按画面顺序拼接并输出全片静音，不保留镜头原声。" : "";
  const insufficientReplacement = replaced !== undefined && totalMinor > spec.maxSpend.amountMinor;
  const disclosure = `${insufficientReplacement ? "旧报价已撤，本次报价未就绪：授权额度不足以覆盖制作，请按所需费用重新准备。" : ""}${spec.operations.length} 个操作，${estimate ? "估算" : "报价"} ${(totalMinor / 100).toFixed(2)} CNY；本次授权 ${(spec.maxSpend.amountMinor / 100).toFixed(2)} CNY。${estimate ? "估算不代表供应商账单封顶。" : ""}${estimateNotes}${audioPlanNote}${finalDurationBound > 0 ? `按当前输入预计成片约 ${(finalDurationBound / 1000).toFixed(1)} 秒（${spec.operations.some(op => op.kind === "render" && (op.parameters.assembly === "timed_narrated_concat" || op.parameters.assembly === "mixed_concat")) ? "时长取冻结片段之和，按片段顺序裁切" : "拼接完整保留素材与旁白长度，不做裁剪"}）。` : ""}${spec.operations.some(op => op.model?.providerId === "fixture-text") ? "模拟媒体，仅验证流程，不发生真实扣费。" : ""}`;
  if (replaced) {
    db.prepare("UPDATE proposals SET state = 'stale', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, replaced.id);
    insertEvent(db, now, { ownerId: scope.ownerId, conversationId: scope.conversationId,
      kind: "proposal.changed", entityId: replaced.id, entityVersion: replaced.revision + 1 });
  }
  db.prepare(
    `INSERT INTO proposals(id, conversation_id, owner_id, digest, spec_json, state, price_disclosure, expires_at, accepted_run_id, revision, created_seq, created_at, updated_at, plan_source_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
  ).run(proposalId, scope.conversationId, scope.ownerId, digest, canonicalJson(spec), insufficientReplacement ? "stale" : "ready", disclosure, expiresAt, seq, now, now,
    boundPlan ? canonicalJson(boundPlan) : null);
  if (boundPlan && work && state) {
    // 当前方案主稿未变：只把可制作提案指针移到新提案（页面据此显示开始入口）；
    // 认可记录与草稿修订不动。
    state.plan.proposalId = proposalId;
    writeWorkState(db, now, work, state);
  }
  const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId) as ProposalRow;
  insertEvent(db, now, {
    conversationId: scope.conversationId, ownerId: scope.ownerId,
    kind: "proposal.changed", entityId: proposalId, entityVersion: 1, notification: "new_output",
  });
  return { proposal: row, replayed: false };
}

// 服务端解析：报价与能力都来自本地核实目录；render 也必须有显式条目，不存在“model=null 即免费可用”。
// 准备时校验能力并派生报价；受理仅复核当时的目录/绑定/报价，不重验冻结结构。
export function resolveSpec(
  intent: ProductionIntent,
  catalog: QuoteCatalog,
  ctx: CatalogValidationContext,
): ProductionSpec {
  return {
    workId: intent.workId,
    title: intent.title,
    inputRevisions: intent.inputRevisions,
    operations: intent.operations.map((op): OperationSpec => {
      // render 目录键按冻结 assembly 分支路由（§10）：prepare 与 accept 必须落到同一条目。
      const key = op.model === null ? `render:${op.parameters.assembly}` : `${op.kind}:${op.model.modelId}`;
      const entry = catalog[key];
      if (!entry) throw new AgentError("CAPABILITY_UNAVAILABLE", "该能力没有本地可信目录条目，不能准备制作提案。");
      if (op.model === null ? entry.binding !== null : !entry.binding || canonicalJson(entry.binding) !== canonicalJson(op.model)) {
        throw new AgentError("CAPABILITY_UNAVAILABLE", "模型绑定与本地目录不一致，不能准备制作提案。");
      }
      entry.validate?.(op, ctx.trusted.get(op.operationId)!, ctx);
      if (op.kind === "render") return { ...op, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded" };
      return {
        ...op,
        quotePerAttempt: { currency: "CNY" as const, amountMinor: operationQuoteMinor(entry, op, ctx.textCodepoints?.get(op.operationId)) },
        priceKind: entry.priceKind,
      };
    }) as [OperationSpec, ...OperationSpec[]],
    finalOutput: intent.finalOutput,
    maxSpend: intent.maxSpend,
  };
}

// 后台清理：ready→expired，升版并发事件；accepted 不受过期影响。
export function sweepExpiredProposals(db: AgentDatabase, now: string): { conversationId: string }[] {
  const rows = db.prepare("SELECT id, conversation_id, owner_id, revision FROM proposals WHERE state = 'ready' AND expires_at <= ?").all(now) as {
    id: string; conversation_id: string; owner_id: string; revision: number;
  }[];
  for (const row of rows) {
    db.prepare("UPDATE proposals SET state = 'expired', revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'ready'").run(now, row.id);
    insertEvent(db, now, {
      conversationId: row.conversation_id, ownerId: row.owner_id,
      kind: "proposal.changed", entityId: row.id, entityVersion: row.revision + 1,
    });
  }
  return rows.map(row => ({ conversationId: row.conversation_id }));
}

// 启动时只检查仍待确认的旧单，已受理快照和历史方案绝不回写。
export function invalidateLegacyNarrationProposals(db: AgentDatabase, now: string): { conversationId: string }[] {
  const legacy = db.prepare(`SELECT p.* FROM proposals p JOIN artifact_revisions r
    ON r.id = json_extract(p.plan_source_json, '$.revisionId')
    WHERE p.state = 'ready' AND p.expires_at > ?`).all(now) as ProposalRow[];
  const touched: { conversationId: string }[] = [];
  for (const row of legacy) {
    try {
      validatePlanNarration(db, JSON.parse(row.plan_source_json!) as ContentSource, JSON.parse(row.spec_json) as ProductionSpec);
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== "PROPOSAL_STALE") throw error;
      db.prepare("UPDATE proposals SET state = 'stale', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      insertEvent(db, now, { conversationId: row.conversation_id, ownerId: row.owner_id,
        kind: "proposal.changed", entityId: row.id, entityVersion: row.revision + 1 });
      touched.push({ conversationId: row.conversation_id });
    }
  }
  return touched;
}

// —— 反馈 ——

// artifact 意见的默认 note：不携带 work/内容来源关联（消息原文内容意见由 recordWorkFeedback 另写）。
export function feedbackNote(disposition: FeedbackNote["disposition"] = "noted"): FeedbackNote {
  return { applied: false, disposition, workId: null, contentSource: null };
}

export function hasProductionLock(db: AgentDatabase, artifactId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM production_input_locks WHERE artifact_id=? LIMIT 1").get(artifactId));
}
