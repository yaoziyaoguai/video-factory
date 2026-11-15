import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import type { RequestRow } from "./conversation-store.js";
import { canonicalJson, digestOf, newAgentId } from "./util.js";
import type {
  AcceptanceBlocker, ArtifactHead, ArtifactRevision, AudioSummary, ContentSource, ContentSourceInput, CreationBinding, CreationPurpose,
  CreativeProjectContent, CodeProjectParameters, DeliveryItem, DeliveryReceipt, FeedbackNote, LegacyProductionSpec, LocalCreationSpec, MarkdownContent, MediaContent, MediaProvenance,
  ModelBinding, OperationRequest, OperationSpec, ProductionIntent, ProductionSpec, Proposal, RequestSource, ReviewGroupDelivery, ReviewInput, ReviewInputInput, RenderParameters,
  Target, ToolDelivery, ToolProductionIntent, VideoParameters, RevisionRef, ProposalRef, InputRef,
} from "../../shared/agent/generated/contracts.js";
import { blobSources, mergeSources, resolveMediaReference, readAdoptedAudioSource } from "./material-store.js";
import { CODE_PROJECT_INPUT_EXTENSIONS } from "./creative-runner.js";
import { operationOutputRevision } from "./production-store.js";
import { speechText, markdownSectionMap, markdownTotalLength } from "../../shared/agent/markdown.js";
import {
  artifactWorkOwnership, getWorkRow, legacyRevisionStageBinding, parseCreationState, requireWork,
  resolveContentSource, sameContentSource, setReviewItemDraft, revisionCreationBinding,
  type CreationState, type StoredReviewGroup, type StoredReviewItem, type WorkRow,
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
    ...(row.creation_binding_json ? { creationBinding: JSON.parse(row.creation_binding_json) as CreationBinding } : {}),
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

// —— 认可依据核对（交付与准备共用） ——

// ReviewInputInput → ReviewInput：来源解析为真实对象，认可行必须存在且指向同一版本。
// group/item 核对来源认可所属事项；新产出的交付目标可以属于同一作品的另一组。
export function verifyReviewInput(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  input: ReviewInputInput,
  expect?: { workId?: string },
): ReviewInput {
  const source = resolveContentSource(db, scope, input.source);
  const row = db.prepare(
    "SELECT work_id, group_id, item_id, subject_json FROM work_review_confirmations WHERE id = ? AND owner_id = ? AND conversation_id = ?",
  ).get(input.confirmationId, scope.ownerId, scope.conversationId) as
    { work_id: string; group_id: string; item_id: string; subject_json: string } | undefined;
  if (!row) throw new AgentError("NOT_FOUND", "引用的认可不存在。");
  if (expect?.workId !== undefined && row.work_id !== expect.workId) throw new AgentError("INVALID_INPUT", "认可依据不属于这条视频创作。");
  if (row.group_id !== input.groupId || row.item_id !== input.itemId) {
    throw new AgentError("INVALID_INPUT", "认可依据与所指向的审阅事项不一致。");
  }
  if (canonicalJson(JSON.parse(row.subject_json)) !== canonicalJson(source)) {
    throw new AgentError("INVALID_INPUT", "认可依据指向的版本与引用不一致。");
  }
  return { groupId: input.groupId, itemId: input.itemId, source, confirmationId: input.confirmationId };
}

// —— 必要认可推导（§11.5：实际输入与认可依据闭合） ——

// render 不必然是视频：code_project 的产出类型按冻结的 expectedMediaKind 判定；
// 媒体拼接组装仍只有视频。prepare/受理门/投影共用这一个口径。
export function finalOutputIsVideo(final: { kind: OperationSpec["kind"]; parameters: OperationSpec["parameters"] } | undefined): boolean {
  if (!final) return false;
  if (final.kind === "video") return true;
  if (final.kind !== "render") return false;
  const { parameters } = final;
  if (!("assembly" in parameters)) return true;
  return parameters.assembly === "code_project" ? parameters.expectedMediaKind === "video" : true;
}

// 正式视频实际依赖的必选创作依据必须各有真实确认行（§11.5.2）。依赖集从操作真实
// 消费的 artifact_revision / 工程修订出发，沿被引修订保存的直接 CreationBinding 与工程
// content.sourceRevisions 追溯：preview 自身不必认可，但沿其直接来源核对必选背景/方案。
// 只对本作品 required 审阅事项上的精确修订产生义务；无关草稿、未采用候选、素材与工程
// 内部文件不产生，也不把库引用的其他作品审批义务搬给本次制作。认可事实只查
// work_review_confirmations 真实行，不以模型另报的 reviewInputs 清单代替。
export function missingRequiredApprovals(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  workId: string,
  consumed: { revisions: { artifactId: string; revisionId: string }[]; projects: { artifactId: string; revisionId: string }[] },
): string[] {
  const work = getWorkRow(db, scope.ownerId, workId);
  if (!work || work.conversation_id !== scope.conversationId) return [];
  const state = parseCreationState(work);
  const confirmed = new Set<string>();
  for (const row of db.prepare(
    "SELECT group_id, item_id, subject_json FROM work_review_confirmations WHERE owner_id = ? AND conversation_id = ? AND work_id = ?",
  ).all(scope.ownerId, scope.conversationId, workId) as { group_id: string; item_id: string; subject_json: string }[]) {
    const subject = JSON.parse(row.subject_json) as ContentSource;
    if (subject.kind === "artifact_revision") confirmed.add(`${row.group_id}:${row.item_id}:${subject.artifactId}:${subject.revisionId}`);
  }
  const missing = new Map<string, string>();
  const seenRevisions = new Set<string>();
  const seenProjects = new Set<string>();
  type ApprovedHistory = { artifactId: string; revisionId: string; groupId: string; itemId: string; ancestors: Set<string> };
  const queue: { kind: "revision" | "project"; artifactId: string; revisionId: string; history: ApprovedHistory | undefined }[] = [
    ...consumed.revisions.map(entry => ({ kind: "revision" as const, ...entry, history: undefined })),
    ...consumed.projects.map(entry => ({ kind: "project" as const, ...entry, history: undefined })),
  ];
  const owe = (groupId: string, itemId: string, artifactId: string, revisionId: string, label: string): void => {
    if (confirmed.has(`${groupId}:${itemId}:${artifactId}:${revisionId}`)) return;
    missing.set(`${groupId}:${itemId}:${artifactId}:${revisionId}`, label);
  };
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.kind === "project") {
      const key = `${entry.artifactId}:${entry.revisionId}:${entry.history?.revisionId ?? ""}`;
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      const revision = getRevisionRow(db, entry.artifactId, entry.revisionId);
      if (!revision) continue;
      const content = JSON.parse(revision.content_json) as CreativeProjectContent;
      for (const ref of content.sourceRevisions) queue.push({ kind: "revision", artifactId: ref.artifactId, revisionId: ref.revisionId, history: entry.history });
      continue;
    }
    // 同一修订可能另有独立采用路径；改稿历史的免追讨不能影响该路径。
    const key = `${entry.artifactId}:${entry.revisionId}:${entry.history?.revisionId ?? ""}`;
    if (seenRevisions.has(key)) continue;
    seenRevisions.add(key);
    const revision = getRevisionRow(db, entry.artifactId, entry.revisionId);
    if (!revision) continue;
    const binding = revision.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding | null : null;
    if (!binding) {
      // 无直接绑定的修订只有恰好是本作品必选事项的当前稿时才算依据：这是准确归属事实，不做来源猜测。
      for (const group of state.groups) for (const item of group.items) {
        if (item.required && item.role !== "video" && item.draft?.kind === "artifact_revision"
          && item.draft.artifactId === entry.artifactId && item.draft.revisionId === entry.revisionId) {
          owe(group.id, item.id, entry.artifactId, entry.revisionId, item.label);
        }
      }
      continue;
    }
    let history = entry.history;
    if (binding.workId === workId) {
      const item = state.groups.find(group => group.id === binding.groupId)?.items.find(candidate => candidate.id === binding.itemId);
      if (history && (history.artifactId !== entry.artifactId || history.groupId !== binding.groupId || history.itemId !== binding.itemId)) history = undefined;
      // 成片事项是制作产出目标；其他事项仍按准确版本核对。已认可后继只免追讨同一产物、
      // 同一事项的基准祖先自身，继续展开来源以核对其他必选依据。
      if (item?.required && item.role !== "video") {
        if (!history?.ancestors.has(entry.revisionId)) owe(binding.groupId, binding.itemId, entry.artifactId, entry.revisionId, item.label);
        if (confirmed.has(`${binding.groupId}:${binding.itemId}:${entry.artifactId}:${entry.revisionId}`)) {
          const ancestors = new Set<string>();
          let base = revision.base_revision_id;
          while (base) {
            ancestors.add(base);
            base = getRevisionRow(db, entry.artifactId, base)?.base_revision_id ?? null;
          }
          history = { artifactId: entry.artifactId, revisionId: entry.revisionId, groupId: binding.groupId, itemId: binding.itemId, ancestors };
        }
      }
    } else history = undefined;
    for (const source of binding.inputSources) {
      if (source.kind === "artifact_revision") queue.push({ kind: "revision", artifactId: source.artifactId, revisionId: source.revisionId, history });
    }
    if (binding.projectRevision) {
      queue.push({ kind: "project", artifactId: binding.projectRevision.artifactId, revisionId: binding.projectRevision.revisionId, history });
    }
  }
  return [...missing.values()];
}

// 付费快照的必要认可推导入口：实际消费 = inputSources 的修订 + 各操作携带的工程数据输入。
export function specConsumedSources(spec: ProductionSpec): { revisions: { artifactId: string; revisionId: string }[]; projects: { artifactId: string; revisionId: string }[] } {
  return {
    revisions: spec.inputSources.flatMap(source => source.kind === "artifact_revision" ? [{ artifactId: source.artifactId, revisionId: source.revisionId }] : []),
    projects: spec.operations.flatMap(op => op.inputs.flatMap(input =>
      input.kind === "project_revision" ? [{ artifactId: input.projectRevision.artifactId, revisionId: input.projectRevision.revisionId }] : [])),
  };
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

// 完整交付摘要：reviewGroups 出现时纳入影响结果的关联字段；省略时保持旧 items-only 形状，
// 既有收据仍可重放。Pi 工具请求级重放与交付事务共用这一个规则。
export function deliveryDigest(input: ToolDelivery): string {
  return digestOf(input.reviewGroups === undefined
    ? { tool: "deliver_artifacts", items: input.items }
    : { tool: "deliver_artifacts", items: input.items, reviewGroups: input.reviewGroups });
}

// 组审阅交付计划：验证目标、分配新身份、解析来源与认可，草稿登记延后到修订落库之后。
interface ReviewDeliveryPlan {
  work: WorkRow;
  state: CreationState;
  touched: boolean;
  draftJobs: { groupId: string; itemId: string; source: ContentSource }[];
}

interface ResolvedReviewTarget {
  workId: string;
  groupId: string;
  itemId: string;
  itemIndex: number;
  binding: CreationBinding;
}

function roleKindConstraint(role: string): string | null {
  if (role === "voice" || role === "music") return "audio";
  if (role === "clip" || role === "video") return "video";
  return null;
}

function resolveReviewTargets(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  items: readonly DeliveryItem[],
  reviewGroups: readonly ReviewGroupDelivery[],
): { targets: ResolvedReviewTarget[]; plans: Map<string, ReviewDeliveryPlan> } {
  const plans = new Map<string, ReviewDeliveryPlan>();
  const planFor = (workId: string): ReviewDeliveryPlan => {
    const existing = plans.get(workId);
    if (existing) return existing;
    const work = requireWork(db, scope.ownerId, scope.conversationId, workId);
    const plan: ReviewDeliveryPlan = { work, state: parseCreationState(work), touched: false, draftJobs: [] };
    plans.set(workId, plan);
    return plan;
  };
  const usedItemIndexes = new Set<number>();
  const newGroupKeys = new Set<string>();
  const newItemKeys = new Set<string>();
  const targets: ResolvedReviewTarget[] = [];
  for (const delivery of reviewGroups) {
    const plan = planFor(delivery.workId);
    const groupTarget = delivery.group;
    let group = plan.state.groups.find(candidate => candidate.id === (groupTarget.mode === "existing" ? groupTarget.groupId : ""));
    let groupId: string;
    if (groupTarget.mode === "existing") {
      group = plan.state.groups.find(candidate => candidate.id === groupTarget.groupId);
      if (!group) throw new AgentError("NOT_FOUND", `没有找到审阅组 ${groupTarget.groupId}。`);
      groupId = group.id;
      if (groupTarget.title !== undefined && groupTarget.title !== group.title) group.title = groupTarget.title;
      if (groupTarget.nextIntent !== undefined && groupTarget.nextIntent !== group.nextIntent) group.nextIntent = groupTarget.nextIntent;
    } else {
      const key = `${delivery.workId}:${groupTarget.key}`;
      if (newGroupKeys.has(key)) throw new AgentError("INVALID_INPUT", `新组 key ${groupTarget.key} 在本次交付中重复。`);
      newGroupKeys.add(key);
      groupId = newAgentId("grp");
      group = { id: groupId, title: groupTarget.title, revision: 0, items: [], nextIntent: groupTarget.nextIntent };
      plan.state.groups.push(group);
    }
    for (const itemDelivery of delivery.items) {
      if (itemDelivery.itemIndex >= items.length) throw new AgentError("INVALID_INPUT", "审阅目标引用的交付项不存在。");
      if (usedItemIndexes.has(itemDelivery.itemIndex)) throw new AgentError("INVALID_INPUT", "同一交付项不能绑定多个审阅事项。");
      usedItemIndexes.add(itemDelivery.itemIndex);
      const itemTarget = itemDelivery.item;
      const itemKind = items[itemDelivery.itemIndex]!.kind;
      let itemId: string;
      let itemRole: string;
      if (itemTarget.mode === "existing") {
        const item = group!.items.find(candidate => candidate.id === itemTarget.itemId);
        if (!item) throw new AgentError("NOT_FOUND", `审阅组里没有事项 ${itemTarget.itemId}。`);
        if (itemTarget.label !== undefined && itemTarget.label !== item.label) item.label = itemTarget.label;
        if (itemTarget.role !== undefined && itemTarget.role !== item.role) item.role = itemTarget.role;
        if (itemTarget.required !== undefined && itemTarget.required !== item.required) item.required = itemTarget.required;
        itemId = item.id;
        itemRole = item.role;
      } else {
        const key = `${delivery.workId}:${itemTarget.key}`;
        if (newItemKeys.has(key)) throw new AgentError("INVALID_INPUT", `新事项 key ${itemTarget.key} 在本次交付中重复。`);
        newItemKeys.add(key);
        itemId = newAgentId("item");
        itemRole = itemTarget.role;
        group!.items.push({
          id: itemId, label: itemTarget.label, role: itemTarget.role, required: itemTarget.required,
          draft: null, approved: null, confirmationId: null, approvedAt: null,
        });
      }
      // 角色约束交付类型：配音/音乐只收音频，剪辑/成片只收视频。
      const constraint = roleKindConstraint(itemRole);
      if (constraint && itemKind !== constraint) {
        throw new AgentError("INVALID_INPUT", `角色 ${itemRole} 的草稿必须是 ${constraint === "audio" ? "音频" : "视频"}产物。`);
      }
      const inputSources = itemDelivery.inputSources.map(source => resolveContentSource(db, scope, source));
      const reviewInputs = itemDelivery.reviewInputs.map(input =>
        verifyReviewInput(db, scope, input, { workId: delivery.workId }));
      const binding: CreationBinding = {
        workId: delivery.workId, groupId, itemId,
        inputSources, reviewInputs, purpose: itemDelivery.purpose,
        ...(itemDelivery.projectRevision ? { projectRevision: itemDelivery.projectRevision } : {}),
      };
      if (itemDelivery.projectRevision) {
        const artifact = getArtifactRow(db, scope.ownerId, itemDelivery.projectRevision.artifactId);
        const revision = artifact ? getRevisionRow(db, artifact.id, itemDelivery.projectRevision.revisionId) : undefined;
        if (!artifact || artifact.conversation_id !== scope.conversationId || artifact.kind !== "project" || !revision) {
          throw new AgentError("INVALID_INPUT", "工程引用必须是本会话真实的冻结工程修订。");
        }
      }
      targets.push({ workId: delivery.workId, groupId, itemId, itemIndex: itemDelivery.itemIndex, binding });
      plan.touched = true;
    }
  }
  return { targets, plans };
}

// 落库后的草稿登记：每份新修订写到所属事项，组版本随草稿变化提升。
function revisionSource(revision: ArtifactRevisionRow): ContentSource {
  return { kind: "artifact_revision", artifactId: revision.artifact_id, revisionId: revision.id, digest: revision.digest };
}

function writePlanState(db: AgentDatabase, now: string, plan: ReviewDeliveryPlan): void {
  for (const job of plan.draftJobs) {
    const group = plan.state.groups.find(candidate => candidate.id === job.groupId);
    const item = group?.items.find(candidate => candidate.id === job.itemId);
    if (!group || !item) throw new AgentError("INVALID_INPUT", "草稿归属的审阅事项不存在。");
    item.draft = job.source;
    group.revision += 1;
  }
  db.prepare("UPDATE works SET creation_state_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
    .run(canonicalJson(plan.state), now, plan.work.id);
  const row = getWorkRow(db, plan.work.owner_id, plan.work.id)!;
  insertEvent(db, now, {
    conversationId: row.conversation_id, ownerId: row.owner_id,
    kind: "work.changed", entityId: row.id, entityVersion: row.revision,
  });
}

// 单事务：作用域/CAS 校验 → 修订落库 → 头推进 → 审阅组登记 → 交付关闭 → 回执 → 提案失效 → 事件。
// 任何一步失败整体回滚；重放按规范化批次摘要比对，不只看 toolCallId。
export function applyDelivery(
  db: AgentDatabase,
  now: string,
  ctx: DeliveryContext,
  input: ToolDelivery,
): { receipt: DeliveryReceipt; replayed: boolean } {
  const { request } = ctx;
  const items = input.items;
  const reviewGroups = input.reviewGroups ?? [];
  if (input.reviewGroups !== undefined && reviewGroups.length === 0) {
    throw new AgentError("INVALID_INPUT", "reviewGroups 出现时不能为空。");
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

  const { targets: reviewTargets, plans } = resolveReviewTargets(db, scope, items, reviewGroups);
  const targetByIndex = new Map(reviewTargets.map(entry => [entry.itemIndex, entry]));

  // 分段文稿的交付边界核对（B2.1）：总量沿用 64000、段 id 唯一；
  // 引用段落只允许出现在绑定了审阅目标且 inputSources 指向真实分段修订的稿件上。
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
    const citing = content.sections.some(section => section.sourceSectionIds);
    if (!citing) continue;
    const bound = targetByIndex.get(index);
    if (!bound) throw new AgentError("INVALID_INPUT", "普通文稿段落不能携带 sourceSectionIds；只有绑定审阅目标的方案稿可以引用内容段落。");
    const known = new Set<string>();
    for (const source of bound.binding.inputSources) {
      if (source.kind !== "artifact_revision") continue;
      const row = getRevisionRow(db, source.artifactId, source.revisionId);
      const sourceContent = row ? JSON.parse(row.content_json) as MarkdownContent : null;
      if (sourceContent?.format !== "markdown" || !sourceContent.sections) continue;
      for (const section of sourceContent.sections) known.add(section.id);
    }
    for (const section of content.sections) {
      for (const id of section.sourceSectionIds ?? []) {
        if (!known.has(id)) throw new AgentError("INVALID_INPUT", `引用的内容段落 ${id} 不在所采用的来源修订里。`);
      }
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

  // 素材 create 分支先把受控 media_reference / local_output 解析为真实 MediaContent：
  // 前者必须来自同会话已采用的素材，后者必须指向已登记落盘的执行输出或冻结工程修订；
  // 再交给同一 insertRevision；模型不能上交任意媒体或 URL 冒充生成。
  const resolvedContents = new Map<number, MarkdownContent | MediaContent>();
  const resolvedSources = new Map<number, RevisionRef>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const content = item.content;
    if (content.format === "markdown") {
      resolvedContents.set(index, content);
      continue;
    }
    if (content.format === "media_reference") {
      const resolved = resolveMediaReference(db, scope, content.blobId, item.kind as "image" | "video");
      if (!resolved) throw new AgentError("TARGET_SCOPE_MISMATCH", "引用的媒体不是本会话已采用的素材，不能作为产物交付。");
      resolvedContents.set(index, resolved);
      continue;
    }
    const resolved = resolveLocalOutput(db, scope, item.kind as "image" | "video" | "audio", content.source);
    resolvedContents.set(index, resolved.content);
    if (resolved.sourceRevision) resolvedSources.set(index, resolved.sourceRevision);
  }

  const newRevisions: (ArtifactRevisionRow | undefined)[] = new Array(items.length);
  // 没有显式审阅目标、但修订绑定指向具体事项的改稿：落库后按绑定更新该事项草稿。
  const implicitDrafts: { workId: string; groupId: string; itemId: string; itemIndex: number }[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const bound = targetByIndex.get(index);
    if (item.mode === "create") {
      const artifactId = newAgentId("art");
      const seq = nextArtifactSeq(db, request.conversation_id);
      db.prepare(
        `INSERT INTO artifacts(id, conversation_id, owner_id, title, kind, work_id, head_revision_id, head_revision_number, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      ).run(artifactId, request.conversation_id, request.owner_id, item.title, item.kind, seq, now, now);
      const artifact = getArtifactRow(db, request.owner_id, artifactId)!;
      const source = resolvedSources.get(index);
      const binding = bound ? source ? adoptedCreationBinding(db, source, bound.binding) : bound.binding : null;
      const revision = insertRevision(db, now, artifact, null, { title: item.title, kind: item.kind, content: resolvedContents.get(index)! }, request.id, binding);
      if (binding) db.prepare("UPDATE artifacts SET work_id = ? WHERE id = ?").run(binding.workId, artifactId);
      newRevisions[index] = revision;
      continue;
    }
    const artifact = getArtifactRow(db, request.owner_id, item.artifactId);
    if (!artifact || artifact.conversation_id !== request.conversation_id) {
      throw new AgentError("TARGET_SCOPE_MISMATCH", "修改对象不存在或不属于当前会话。");
    }
    if (artifact.kind !== item.kind) throw new AgentError("TARGET_SCOPE_MISMATCH", "修订不能改变产物类型。");
    if (artifact.head_revision_id !== item.baseRevisionId) {
      throw new AgentError("STALE_REVISION", "产物已更新，请基于当前最新版本重新发起修改。", { currentRevisionId: artifact.head_revision_id });
    }
    const previous = getRevisionRow(db, artifact.id, item.baseRevisionId);
    const previousBinding = revisionCreationBinding<CreationBinding>(db, artifact.id, item.baseRevisionId);
    const legacyBinding = previousBinding ? null : legacyRevisionStageBinding(db, artifact.id, item.baseRevisionId);
    // 显式审阅目标按修订绑定或真实当前引用核对归属；没有目标时继承真实归属。
    const explicit = bound ? { workId: bound.workId, groupId: bound.groupId, itemId: bound.itemId } : undefined;
    if (explicit) {
      const attributed = previousBinding ? { workId: previousBinding.workId, groupId: previousBinding.groupId, itemId: previousBinding.itemId }
        : legacyBinding ? { workId: legacyBinding.workId, groupId: legacyBinding.stage, itemId: legacyBinding.stage } : null;
      const ownership = attributed ?? artifactWorkOwnership(db, artifact, explicit);
      if (ownership && (ownership.workId !== explicit.workId || ownership.groupId !== explicit.groupId || ownership.itemId !== explicit.itemId)) {
        throw new AgentError("INVALID_INPUT", "不能把已有主稿改挂到其他视频或审阅事项。");
      }
    } else if (previousBinding) {
      // 已绑定事项的修订在没有显式目标时也更新该事项草稿（在途不阻塞后继草稿，§4.2.1）。
      const plan = plans.get(previousBinding.workId) ?? {
        work: requireWork(db, request.owner_id, request.conversation_id, previousBinding.workId),
        state: parseCreationState(requireWork(db, request.owner_id, request.conversation_id, previousBinding.workId)),
        touched: false, draftJobs: [],
      };
      plans.set(previousBinding.workId, plan);
      implicitDrafts.push({ workId: previousBinding.workId, groupId: previousBinding.groupId, itemId: previousBinding.itemId, itemIndex: index });
    }
    const targetBinding = bound ? bound.binding
      : previousBinding ? previousBinding
      : inheritedBinding(db, artifact, scope);
    const source = resolvedSources.get(index);
    const binding = targetBinding && source ? adoptedCreationBinding(db, source, targetBinding) : targetBinding;
    const revision = insertRevision(db, now, artifact, item.baseRevisionId, { title: item.title, kind: item.kind, content: resolvedContents.get(index)! }, request.id, binding);
    newRevisions[index] = revision;
  }

  // 修订落库后统一登记草稿：显式目标与隐式继承都指向真实新修订。
  for (const draft of implicitDrafts) {
    const plan = plans.get(draft.workId)!;
    plan.draftJobs.push({ groupId: draft.groupId, itemId: draft.itemId, source: revisionSource(newRevisions[draft.itemIndex]!) });
  }
  for (const bound of reviewTargets) {
    const plan = plans.get(bound.workId)!;
    plan.draftJobs.push({ groupId: bound.groupId, itemId: bound.itemId, source: revisionSource(newRevisions[bound.itemIndex]!) });
  }
  for (const plan of plans.values()) {
    if (plan.touched || plan.draftJobs.length > 0) writePlanState(db, now, plan);
  }

  const receipt: DeliveryReceipt = {
    receiptId: newAgentId("dlv"),
    requestId: request.id,
    replayed: false,
    revisions: newRevisions.filter((revision): revision is ArtifactRevisionRow => revision !== undefined)
      .map(r => ({ artifactId: r.artifact_id, revisionId: r.id })) as [DeliveryReceipt["revisions"][number], ...DeliveryReceipt["revisions"]],
    deliveryClosed: true,
    reviewTargets: reviewTargets.map(entry => ({
      workId: entry.workId, groupId: entry.groupId, itemId: entry.itemId, itemIndex: entry.itemIndex,
    })),
  };
  db.prepare("UPDATE requests SET delivery_closed = 1, updated_at = ? WHERE id = ?").run(now, request.id);
  db.prepare("INSERT INTO request_deliveries(request_id, batch_digest, receipt_id, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(request.id, batchDigest, receipt.receiptId, canonicalJson(receipt), now);

  const touchedArtifacts = items
    .filter((item): item is Extract<DeliveryItem, { mode: "revise" }> => item.mode === "revise")
    .map(item => getArtifactRow(db, request.owner_id, item.artifactId)!);
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

// 已登记落盘的真实执行输出或冻结工程产物才可作为正式媒体来源（§3.5）。
export function resolveLocalOutput(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  kind: "image" | "video" | "audio",
  source: { kind: "run_output"; runId: string; operationId: string; outputSlot: string } | { kind: "artifact_revision"; artifactId: string; revisionId: string },
): { content: MediaContent; sourceRevision: RevisionRef | null } {
  let blobId: string;
  let sourceMedia: MediaContent | undefined;
  let sourceRevision: RevisionRef | null = null;
  if (source.kind === "artifact_revision") {
    const artifact = getArtifactRow(db, scope.ownerId, source.artifactId);
    const revision = artifact ? getRevisionRow(db, artifact.id, source.revisionId) : undefined;
    if (!artifact || artifact.conversation_id !== scope.conversationId || !revision) {
      throw new AgentError("INVALID_INPUT", "引用的产物修订不存在或不属于当前会话。");
    }
    const content = JSON.parse(revision.content_json) as ArtifactRevision["content"];
    if (content.format !== "media") throw new AgentError("INVALID_INPUT", "引用的修订不是媒体产物。");
    sourceMedia = content;
    sourceRevision = { artifactId: artifact.id, revisionId: revision.id };
    blobId = content.blobId;
  } else {
    const run = db.prepare("SELECT conversation_id FROM production_runs WHERE id = ? AND owner_id = ?").get(source.runId, scope.ownerId) as { conversation_id: string } | undefined;
    const operation = run ? db.prepare("SELECT output_blob_id,spec_json FROM production_operations WHERE run_id = ? AND id = ?").get(source.runId, source.operationId) as { output_blob_id: string | null; spec_json: string } | undefined : undefined;
    if (!run || run.conversation_id !== scope.conversationId || !operation?.output_blob_id) {
      throw new AgentError("INVALID_INPUT", "引用的运行输出尚未登记落盘，不能作为正式媒体交付。");
    }
    if ((JSON.parse(operation.spec_json) as OperationSpec).outputSlot !== source.outputSlot) {
      throw new AgentError("INVALID_INPUT", "引用的输出槽位与运行冻结记录不一致。");
    }
    const revision = operationOutputRevision(db, source.runId, source.operationId);
    if (revision) {
      sourceRevision = { artifactId: revision.artifact_id, revisionId: revision.id };
      sourceMedia = JSON.parse(revision.content_json) as MediaContent;
    }
    blobId = operation.output_blob_id;
  }
  // 库选材在当前会话建立准确修订与 blob 关联，字节仍登记在原会话；只沿已校验修订共享同 owner 媒体。
  const blob = (source.kind === "artifact_revision"
    ? db.prepare(`SELECT b.mime_type, b.duration_ms FROM production_blobs b
        JOIN revision_blob_links l ON l.blob_id = b.id
        WHERE b.id = ? AND b.owner_id = ? AND l.revision_id = ?`)
      .get(blobId, scope.ownerId, source.revisionId)
    : db.prepare("SELECT mime_type, duration_ms FROM production_blobs WHERE id = ? AND owner_id = ? AND conversation_id = ?")
      .get(blobId, scope.ownerId, scope.conversationId)) as { mime_type: string; duration_ms: number | null } | undefined;
  if (!blob) throw new AgentError("INVALID_INPUT", "引用的输出媒体不存在。");
  const expected = kind === "video" ? ["video/mp4", "video/webm"] : kind === "audio" ? ["audio/mpeg", "audio/wav"] : ["image/png", "image/jpeg"];
  if (!expected.includes(blob.mime_type)) {
    throw new AgentError("INVALID_INPUT", `输出媒体类型 ${blob.mime_type} 与交付类型不一致。`);
  }
  return { content: { format: "media", blobId, mimeType: blob.mime_type as MediaContent["mimeType"], durationMs: blob.duration_ms,
    ...(sourceMedia?.dub ? { dub: sourceMedia.dub } : {}),
    ...(sourceMedia?.sources ? { sources: sourceMedia.sources } : {}),
  }, sourceRevision };
}

// 候选采用与一步定稿共用：只变目标角色，原字节对应的制作/工程/素材来源仍取准确旧修订。
export function adoptedCreationBinding(
  db: AgentDatabase, source: RevisionRef,
  target: Pick<CreationBinding, "workId" | "groupId" | "itemId" | "purpose">,
): CreationBinding {
  const revision = getRevisionRow(db, source.artifactId, source.revisionId);
  if (!revision) throw new AgentError("NOT_FOUND", "采用的预览修订不存在。");
  const parsed = revision.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding : null;
  const binding = parsed && Array.isArray(parsed.inputSources) ? parsed : null;
  return {
    ...binding, workId: target.workId, groupId: target.groupId, itemId: target.itemId, purpose: target.purpose,
    inputSources: binding?.inputSources ?? [],
    reviewInputs: binding?.workId === target.workId ? binding.reviewInputs : [],
    ...(revision.run_id ? { runId: revision.run_id } : {}),
    adoptedFrom: { artifactId: source.artifactId, revisionId: source.revisionId },
  };
}

// 已有主稿的普通改稿即使漏传 reviewGroups，也按真实归属（修订绑定或 work 当前引用）更新事项草稿。
function inheritedBinding(
  db: AgentDatabase,
  artifact: ArtifactRow,
  scope: { ownerId: string; conversationId: string },
): CreationBinding | null {
  const ownership = artifactWorkOwnership(db, artifact);
  if (!ownership) return null;
  return {
    workId: ownership.workId, groupId: ownership.groupId, itemId: ownership.itemId,
    inputSources: [], reviewInputs: [], purpose: "draft",
  };
}

// publish_project 的工程修订与交付修订共用同一落库路径；工程内容由调用方先行冻结与清单校验。
export function insertRevision(
  db: AgentDatabase, now: string, artifact: ArtifactRow, baseRevisionId: string | null,
  item: { title: string; kind: string; content: ArtifactRevision["content"] }, requestId: string,
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
  // 媒体修订与作品库文件卡修订共享 blob、不复制字节；blob 关联同事务写入，文本修订没有 blob。
  if (content.format === "media" || content.format === "file") {
    db.prepare("INSERT INTO revision_blob_links(revision_id,blob_id) VALUES(?,?)").run(revisionId, content.blobId);
  }
  db.prepare("UPDATE artifacts SET title = ?, work_id = COALESCE(?, work_id), head_revision_id = ?, head_revision_number = ?, updated_at = ? WHERE id = ?")
    .run(item.title, binding?.workId ?? null, revisionId, revisionNumber, now, artifact.id);
  const row = getRevisionRow(db, artifact.id, revisionId);
  if (!row) throw new AgentError("TEMPORARILY_UNAVAILABLE", "修订写入失败。");
  return row;
}

// 输入修订被超过后，旧一代 ready 提案转 stale（同事务、升版、发事件）。
// 新组提案的输入是冻结修订：head 被后继稿推进不是失效事实（§11.5.5），明确引用
// 已认可旧版的报价保持 ready；其失效只来自明确替换、受理或过期。旧提案保持旧 plan 关联语义。
function expireProposalsOnRevisions(db: AgentDatabase, now: string, conversationId: string, ownerId: string, artifacts: ArtifactRow[]): void {
  if (artifacts.length === 0) return;
  const readyProposals = db.prepare(
    "SELECT id, spec_json, revision, plan_source_json FROM proposals WHERE conversation_id = ? AND state = 'ready'",
  ).all(conversationId) as { id: string; spec_json: string; revision: number; plan_source_json: string | null }[];
  for (const proposal of readyProposals) {
    const parsed = JSON.parse(proposal.spec_json) as ProductionSpec | LegacyProductionSpec;
    if ("type" in parsed) continue;
    const legacy = parsed as LegacyProductionSpec;
    let stale = legacy.inputRevisions.some(ref =>
      artifacts.some(a => a.id === ref.artifactId && a.head_revision_id !== ref.revisionId));
    if (!stale && legacy.workId) {
        const bound = proposal.plan_source_json ? JSON.parse(proposal.plan_source_json) as ContentSource : null;
        const work = getWorkRow(db, ownerId, legacy.workId);
        if (!bound || bound.kind !== "artifact_revision") {
          // prepare 后尚未交付的新提案保持 ready 等待本轮交付；只有本批确实改动了该事项方案主稿时才失效。
          const state = work ? parseCreationState(work) : null;
          const touchedPlan = artifacts.some(a => a.work_id === legacy.workId
            && state?.groups.some(group => group.items.some(item => item.role === "plan"
              && item.draft?.kind === "artifact_revision" && item.draft.artifactId === a.id)));
          if (touchedPlan) stale = true;
        } else if (!work) {
          stale = true;
        } else {
          // 已关联提案按同一持久来源核对：当前方案主稿被换（含 inputRevisions 为空的提案）不得再以旧稿冒充。
          const state = parseCreationState(work);
          const current = state.groups.flatMap(group => group.items).find(item => item.role === "plan")?.draft ?? null;
          const revision = getRevisionRow(db, bound.artifactId, bound.revisionId);
          if (!revision || !current || current.kind !== "artifact_revision"
            || current.artifactId !== bound.artifactId || current.revisionId !== bound.revisionId) stale = true;
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
  // 该提案绑定的方案主稿修订来源（ContentSource，§10.1 私有事实，仅旧提案）；
  // 唯一写入者是旧交付事务与旧 prepare 的原样重提继承，受理后不可变。null＝尚未绑定。
  plan_source_json: string | null;
}

// 提案与方案主稿的准确关系读取入口：旧提案受理、失效、发布共用的唯一直接事实来源。
// 返回 null 表示该提案尚未绑定方案主稿。新组模型提案不经此路径。
export function proposalPlanSource(
  db: AgentDatabase,
  ownerId: string,
  conversationId: string,
  proposalId: string,
): { source: { kind: "artifact_revision"; artifactId: string; revisionId: string; digest: string }; binding: { workId: string; groupId: string; itemId: string } | null; proposalDigest: string } | null {
  const row = db.prepare("SELECT digest, plan_source_json FROM proposals WHERE id=? AND owner_id=? AND conversation_id=?")
    .get(proposalId, ownerId, conversationId) as { digest: string; plan_source_json: string | null } | undefined;
  if (!row?.plan_source_json) return null;
  const source = JSON.parse(row.plan_source_json) as ContentSource;
  if (source.kind !== "artifact_revision") return null;
  const revision = getRevisionRow(db, source.artifactId, source.revisionId);
  if (!revision || revision.digest !== source.digest) return null;
  const legacy = legacyRevisionStageBinding(db, source.artifactId, source.revisionId);
  const modern = revisionCreationBinding<CreationBinding>(db, source.artifactId, source.revisionId);
  const binding = modern ? { workId: modern.workId, groupId: modern.groupId, itemId: modern.itemId } : legacy ? { workId: legacy.workId, groupId: legacy.stage, itemId: legacy.stage } : null;
  return binding ? { source, binding, proposalDigest: row.digest } : null;
}

// 宿主从 SQLite 解析出的可信输入事实：修订内容格式、blob 元数据、依赖产出类型。
// 只描述冻结事实本身，模型自报的引用 JSON 形状不进入这里。
export type TrustedOperationInput =
  | { kind: "text" }
  | { kind: "artifact_revision"; content: { format: "markdown" } | { format: "media"; blobId: string; mimeType: string } }
  | { kind: "blob"; blobId: string; mimeType: string }
  | { kind: "operation_output"; producerKind: OperationRequest["kind"] }
  | { kind: "project_revision" };

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

// 受理前置条件的同一推导（G1-1）：投影显示与 admit 拒绝共用这一个函数。
// 仅 state=ready 时给出 blocker；blob 存在性与预算复核仍属 admit 的完整受理事务。
export function acceptanceBlockerFor(db: AgentDatabase, ownerId: string, row: ProposalRow, catalog: QuoteCatalog): AcceptanceBlocker | null {
  if (row.state !== "ready") return null;
  const spec = JSON.parse(row.spec_json) as ProductionSpec | LegacyProductionSpec;
  // 能力与报价漂移：与 admit 相同的目录/绑定/报价比较。
  for (const op of spec.operations) {
    const entry = catalog[op.kind === "render" ? `render:${op.parameters.assembly}` : `${op.kind}:${op.model.modelId}`];
    let textCodepoints: number | undefined;
    if (entry?.quoteMinorFor && op.kind === "speech") {
      const input = op.inputs[0] as Extract<typeof op.inputs[number], { kind: "text" | "artifact_revision" }>;
      const text = input.kind === "text" ? input.text
        : speechText(JSON.parse(getRevisionRow(db, input.artifactId, input.revisionId)!.content_json) as MarkdownContent);
      textCodepoints = [...text].length;
    }
    if (!entry || canonicalJson(entry.binding) !== canonicalJson(op.model)
      || operationQuoteMinor(entry, op, textCodepoints) !== op.quotePerAttempt.amountMinor || entry.priceKind !== op.priceKind) {
      return { code: "CAPABILITY_UNAVAILABLE", message: "模型配置或价格已变化，请重新准备提案。", action: "configure_capability" };
    }
    try { entry.validate?.(op); }
    catch {
      return { code: "CAPABILITY_UNAVAILABLE", message: "当前能力已不再支持这份提案，请重新准备。", action: "configure_capability" };
    }
  }
  const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId && op.outputSlot === spec.finalOutput.outputSlot);
  const finalIsVideo = finalOutputIsVideo(final);
  if ("type" in spec) {
    // 输入失效只看冻结修订是否仍存在且摘要一致（§11.5.5）：head 被后继稿推进不是失效事实，
    // 明确引用已认可旧版的报价保持可受理。
    const changed = spec.inputSources.some(source => source.kind === "artifact_revision" && (() => {
      const artifact = getArtifactRow(db, ownerId, source.artifactId);
      const revision = artifact ? getRevisionRow(db, source.artifactId, source.revisionId) : undefined;
      return !artifact || artifact.conversation_id !== row.conversation_id || !revision || revision.digest !== source.digest;
    })());
    if (changed) return { code: "INPUT_CHANGED", message: "输入内容已更新，请重新准备提案。", action: "prepare_again" };
    if (finalIsVideo) {
      // 新目标门（F02）：最终视频提案必须带确切交付目标；existing 目标当前仍存在才可受理，create 受理时分配。
      const declared = spec.outputTarget ?? null;
      if (!declared) {
        return { code: "INPUT_CHANGED", message: "需要明确交付位置，请重新准备并声明输出到哪个审阅事项。", action: "prepare_again" };
      }
      if (declared.group.mode === "existing" && spec.workId !== null) {
        const work = getWorkRow(db, ownerId, spec.workId);
        // 判别 narrowing 不跨回调保留：先取出准确 id 再进查找。
        const groupId = declared.group.groupId;
        const itemId = declared.item.mode === "existing" ? declared.item.itemId : null;
        const group = work ? parseCreationState(work).groups.find(group => group.id === groupId) : undefined;
        const itemMissing = itemId != null && !group?.items.some(item => item.id === itemId);
        if (!group || itemMissing) {
          return { code: "INPUT_CHANGED", message: "报价的交付目标已不存在，请重新准备。", action: "prepare_again" };
        }
      }
    }
    if (finalIsVideo && spec.purpose === "production") {
      if (spec.reviewInputs.length === 0) {
        return { code: "INPUT_APPROVAL_REQUIRED", message: "正式视频制作需要先获得组审阅认可，再准备这份报价。", action: "review_inputs" };
      }
      // 覆盖核对：实际消费的必选依据各要有真实确认行，不能只凭模型报了非空清单（§11.5.1）。
      if (spec.workId !== null) {
        const missing = missingRequiredApprovals(db, { ownerId, conversationId: row.conversation_id }, spec.workId, specConsumedSources(spec));
        if (missing.length > 0) {
          return { code: "INPUT_APPROVAL_REQUIRED", message: `正式制作采用的「${missing.join("」「")}」这一版还未获得认可，请先认可实际采用的版本。`, action: "review_inputs" };
        }
      }
    }
    return null;
  }
  // 旧提案：输入漂移按旧事实推导，不补造认可。
  const legacy = spec as LegacyProductionSpec;
  const changed = legacy.inputRevisions.some(ref => {
    const artifact = getArtifactRow(db, ownerId, ref.artifactId);
    return !artifact || artifact.conversation_id !== row.conversation_id || artifact.head_revision_id !== ref.revisionId;
  });
  if (changed) return { code: "INPUT_CHANGED", message: "输入内容已更新，请重新准备提案。", action: "prepare_again" };
  // 旧最终视频提案没有可证明的输出目标（F02）：统一按缺目标 blocker 指引重新准备；
  // 已受理旧 run 不经此门（accepted 幂等返回在 admit 前段），worker 沿原冻结事实完成。
  if (finalIsVideo) return { code: "INPUT_CHANGED", message: "需要明确交付位置，请重新准备。", action: "prepare_again" };
  return null;
}

export function rowToProposal(row: ProposalRow, db: AgentDatabase, catalog?: QuoteCatalog): Proposal {
  const spec = JSON.parse(row.spec_json) as ProductionSpec;
  const runOrder = row.accepted_run_id ? (db.prepare("SELECT rowid AS ordinal FROM production_runs WHERE id=?").get(row.accepted_run_id) as { ordinal: number }).ordinal : Number.MAX_SAFE_INTEGER;
  const audioSummary = productionAudioFacts(db, spec, runOrder).audioSummary;
  return {
    id: row.id, conversationId: row.conversation_id, digest: row.digest,
    spec, state: row.state, ...(audioSummary ? { audioSummary } : {}),
    priceDisclosure: row.price_disclosure, expiresAt: row.expires_at,
    acceptedRunId: row.accepted_run_id, revision: row.revision,
    acceptanceBlocker: catalog ? acceptanceBlockerFor(db, row.owner_id, row, catalog) : null,
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
// 快照三种形状（付费新/付费旧/本地）在声音通道上同构，走同一遍历。
export type AudioFactsSpec = ProductionIntent | ProductionSpec | LocalCreationSpec | LegacyProductionSpec;
export function productionAudioFacts(db: AgentDatabase, spec: AudioFactsSpec, runOrder = Number.MAX_SAFE_INTEGER): {
  narrationText: string | null; knownNarrationText: string | null; audioSummary?: AudioSummary;
  speechInMusic: boolean; stackedMusic: boolean;
} {
  let audioSummary: AudioSummary | undefined;
  let speechInMusic = false;
  let stackedMusic = false;
  const empty: AudioEvidence = { texts: [], unknown: false, speech: null, hasSpeech: false, hasMusic: false };
  const unknown: AudioEvidence = { ...empty, unknown: true };
  const readInput = (input: InputRef, source: AudioFactsSpec, beforeRun: number): AudioEvidence => {
    if (input.kind === "operation_output") return readOperation(source, input.producerOperationId, beforeRun);
    if (input.kind === "text") return { ...empty, texts: [input.text] };
    let blobId: string;
    let sourceRunId: string | null = null;
    if (input.kind === "artifact_revision") {
      const revision = getRevisionRow(db, input.artifactId, input.revisionId);
      if (!revision) return unknown;
      const content = JSON.parse(revision.content_json) as ArtifactRevision["content"];
      if (content.format === "markdown") return { ...empty, texts: [speechText(content)] };
      // 工程修订的声音事实由代码运行时决定，静态不可追溯。
      if (content.format === "project") return unknown;
      blobId = content.blobId;
      sourceRunId = revision.run_id;
    } else if (input.kind === "blob") {
      blobId = input.blobId;
    } else {
      return unknown;
    }
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
  const readOperation = (source: AudioFactsSpec, id: string, beforeRun: number): AudioEvidence => {
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
    // code_project 的输出由冻结工程运行决定，静态声音事实未知。
    if (parameters.assembly === "code_project") return { ...unknown, hasSpeech: false, hasMusic: false };
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
    const musicSource = "musicSource" in operation ? operation.musicSource : undefined;
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

// 两个合法绑定点共用：首次报价与先交付，均不得把新台词绑到旧方案。
// 旧修订仅沿自身已有的唯一冻结输入继承，多个不同台词不能按时间猜一个。
export function validatePlanNarration(db: AgentDatabase, plan: ContentSource, spec: ProductionSpec | LocalCreationSpec): void {
  const actual = productionAudioFacts(db, spec).knownNarrationText;
  if (actual === null || plan.kind !== "artifact_revision") return;
  const content = JSON.parse(getRevisionRow(db, plan.artifactId, plan.revisionId)!.content_json) as MarkdownContent;
  let expected = content.narrationText;
  if (expected === undefined) {
    const prior = db.prepare("SELECT spec_json FROM proposals WHERE plan_source_json = ?").all(canonicalJson(plan)) as { spec_json: string }[];
    const texts = new Set(prior.map(row => productionNarrationText(db, JSON.parse(row.spec_json) as ProductionSpec)).filter(text => text !== null));
    if (texts.size === 1) expected = [...texts][0]!;
  }
  if (expected === undefined) throw new AgentError("PROPOSAL_STALE", "这份方案尚未明确唯一的逐字旁白；请交付带旁白原文的新方案，再准备费用。");
  if (actual !== expected) throw new AgentError("PROPOSAL_STALE", "实际配音与方案旁白原文不一致；换词请交付新方案，再关联本次报价。");
}

// 两种受理共享声音约束：采用准确旧配音不能变词，也不能把已知配音或已混旧曲伪装成新音乐。
export function validateProductionAudio(db: AgentDatabase, spec: ProductionSpec | LocalCreationSpec): void {
  for (const operation of spec.operations) {
    if (operation.kind !== "render" || operation.parameters.assembly !== "mixed_concat") continue;
    const audio = productionAudioFacts(db, { ...spec, finalOutput: { operationId: operation.operationId, outputSlot: operation.outputSlot } });
    if (audio.speechInMusic) throw new AgentError("INVALID_INPUT", "已知配音不能放进音乐槽；请作为独立配音使用并核对方案原文。");
    if (audio.stackedMusic) throw new AgentError("INVALID_INPUT", "该片段已混入旧音乐；换音乐请读回原运行，复用原始视觉片段和既有配音，不叠加旧曲。");
  }
  for (const reviewInput of spec.reviewInputs) {
    if (reviewInput.source.kind !== "artifact_revision") continue;
    const content = JSON.parse(getRevisionRow(db, reviewInput.source.artifactId, reviewInput.source.revisionId)!.content_json) as MarkdownContent;
    if (content.format === "markdown" && content.narrationText !== undefined) validatePlanNarration(db, reviewInput.source, spec);
  }
}

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

// Pi 工具 intent 不带 maxCreateAttempts：按目录通道补齐为内部完整 intent。
export function normalizeToolIntent(intent: ToolProductionIntent, catalog: QuoteCatalog): ProductionIntent {
  return {
    ...intent,
    operations: intent.operations.map(op => ({
      ...op,
      maxCreateAttempts: catalog[`${op.kind}:${op.model === null ? op.parameters.assembly : op.model.modelId}`]?.maxCreateAttempts ?? 1,
    })) as ProductionIntent["operations"],
  };
}

export function requirePaidProduction(intent: Pick<ProductionIntent | ToolProductionIntent, "operations">): void {
  if (intent.operations.every(operation => operation.kind === "render" && operation.model === null)) {
    throw new AgentError("INVALID_INPUT", "纯本地合成请使用 render_project；prepare_production 只准备含付费媒体操作的整批提案。");
  }
}

// S3：code_project 受理边界的一次性核对（付费/本地共用）。entrypoint 以冻结工程为权威，
// 请求里的副本必须完全一致；outputPath 是本次执行将产生的未来文件，不必预先存在，
// 但不得与封存文件或本操作输入的落位路径同名——否则恢复出的旧文件可以冒充本次产物。
export function validateCodeProjectExecution(parameters: CodeProjectParameters, content: CreativeProjectContent, inputs: readonly InputRef[]): void {
  if (canonicalJson(parameters.entrypoint) !== canonicalJson(content.entrypoint)) {
    throw new AgentError("INVALID_INPUT", "渲染入口与冻结工程不一致；请以工程当前的 entrypoint 重新发起。");
  }
  if (content.files.some(file => file.relativePath === parameters.outputPath)) {
    throw new AgentError("INVALID_INPUT", "工程输出路径与封存文件同名；输出由本次执行产生，请给输出独立路径。");
  }
  for (const [slot, input] of inputs.entries()) {
    if (input.kind === "text" || input.kind === "project_revision") continue;
    // 媒体输入按槽位物化为 inputs/<slot>.<扩展名>；operation_output 的最终 MIME 受理时
    // 未知，按全部合法扩展核对分离。
    for (const extension of CODE_PROJECT_INPUT_EXTENSIONS) {
      if (parameters.outputPath === `inputs/${slot}${extension}`) {
        throw new AgentError("INVALID_INPUT", "工程输出路径与输入文件落位同名；需要已有片段作输入时用输入槽位，请给输出独立路径。");
      }
    }
  }
}

// 付费与本地受理共用冻结输入事实和 render 参数规范化；不产生提案、授权或写库。
export function normalizeOperationInputs(
  db: AgentDatabase,
  scope: { ownerId: string; conversationId: string },
  inputSources: readonly ContentSource[],
  operationRequests: readonly OperationRequest[],
  catalog: QuoteCatalog,
  probes?: Map<string, RenderFileProbe>,
): {
  validation: CatalogValidationContext;
  renderParameters: Map<string, RenderParameters>;
  musicSources: Map<string, MediaProvenance>;
  durationBounds: Map<string, number>;
  durationVerified: Map<string, boolean>;
  hasUnusedRevisions: boolean;
} {
  const revisions = new Map<string, string>();
  for (const source of inputSources) {
    if (source.kind !== "artifact_revision") continue;
    const artifact = getArtifactRow(db, scope.ownerId, source.artifactId);
    if (!artifact || artifact.conversation_id !== scope.conversationId) throw new AgentError("INVALID_INPUT", "输入来源不存在或不属于当前会话。");
    revisions.set(`${source.artifactId}:${source.revisionId}`, source.digest);
  }
  const operations = new Map(operationRequests.map(op => [op.operationId, op]));
  if (operations.size !== operationRequests.length) throw new AgentError("INVALID_INPUT", "操作 ID 不能重复。");
  if (new Set(operationRequests.map(op => op.outputSlot)).size !== operationRequests.length) throw new AgentError("INVALID_INPUT", "输出槽位不能重复。");
  const used = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const trusted = new Map<string, TrustedOperationInput[]>();
  const textCodepoints = new Map<string, number>();
  const operationSources = new Map<string, MediaProvenance[]>();
  const musicSources = new Map<string, MediaProvenance>();
  const renderParameters = new Map<string, RenderParameters>();
  // 同 run 的 code_project 操作各用 run+operation 独立工作区执行（local-render），
  // 不限制输出路径同名；输出与自身封存输入/输入槽的分离由执行边界保证。
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
    const musicSlots = new Set<number>();
    const videoSlots = new Set<number>();
    const imageSlots = new Set<number>();
    let timedTargetMs = 0;
    const codeParameters = parameters?.assembly === "code_project" ? parameters : null;
    if (codeParameters) {
      // code_project：工程修订随参数冻结，输入槽只作数据文件；输出时长由运行决定，不设静态上界。
      const project = getArtifactRow(db, scope.ownerId, codeParameters.projectRevision.artifactId);
      const revision = project ? getRevisionRow(db, project.id, codeParameters.projectRevision.revisionId) : undefined;
      if (!project || project.conversation_id !== scope.conversationId || project.kind !== "project" || !revision) {
        throw new AgentError("INVALID_INPUT", "渲染工程必须引用本会话真实的冻结工程修订。");
      }
      const content = JSON.parse(revision.content_json) as CreativeProjectContent;
      validateCodeProjectExecution(codeParameters, content, op.inputs);
    }
    if (parameters && parameters.assembly !== "code_project" && parameters.segmentIds) {
      // 长度一致性在准备边界核对一次，随后随快照冻结（B2.3）。
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
      if (mixedParameters?.music) musicSlots.add(mixedParameters.music.inputSlot);
      for (const [slot, kind] of slotKinds) (kind === "video" ? videoSlots : imageSlots).add(slot);
      timedTargetMs = timelineParameters.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
      if (timedTargetMs > 120_000) throw new AgentError("INVALID_INPUT", "成片总长超过本配置 120s 上限；请缩短片段。");
    }
    for (const [slot, input] of op.inputs.entries()) {
      const audio = audioSlots.has(slot);
      const music = musicSlots.has(slot);
      const image = imageSlots.has(slot);
      if (input.kind === "blob") {
        const blob = db.prepare("SELECT mime_type FROM production_blobs WHERE id=? AND digest=? AND owner_id=? AND conversation_id=?").get(input.blobId, input.digest, scope.ownerId, scope.conversationId) as { mime_type: string } | undefined;
        if (!blob) throw new AgentError("INVALID_INPUT", "媒体输入不存在或不属于当前会话。");
        if (op.kind === "render" && !codeParameters) {
          // 混音音乐槽额外接受本地登记的 WAV（如冻结工程渲染的程序音乐）；旁白槽仍是供应商 MP3 契约。
          const accepted = music ? blob.mime_type === "audio/mpeg" || blob.mime_type === "audio/wav"
            : audio ? blob.mime_type === "audio/mpeg"
            : image ? blob.mime_type.startsWith("image/") : blob.mime_type === "video/mp4" || blob.mime_type === "video/webm";
          if (!accepted) {
            throw new AgentError("INVALID_INPUT", music ? "音乐槽只接受音频素材。" : audio ? "旁白槽只接受音频素材。" : image ? "图片片段只接受图片素材。" : narrated ? "视频画面槽只接受视频片段。" : "有序拼接只接受视频片段。");
          }
        }
        facts.push({ kind: "blob", blobId: input.blobId, mimeType: blob.mime_type });
        if (op.kind === "render" && !codeParameters) {
          sources.push(blobSources(db, input.blobId));
          const duration = image ? 0 : blobDurationMs(input.blobId);
          durations.push(duration);
          const probe = probes?.get(input.blobId);
          slotVerified.push(image ? (!probes || probe?.ok === true && probe.kind === "image") : duration > 0);
        }
        continue;
      }
      if (input.kind === "project_revision") {
        // 工程修订作为数据输入：核对真实冻结修订；声音事实与时长静态未知。
        const artifact = getArtifactRow(db, scope.ownerId, input.projectRevision.artifactId);
        const revision = artifact ? getRevisionRow(db, artifact.id, input.projectRevision.revisionId) : undefined;
        if (!artifact || artifact.conversation_id !== scope.conversationId || artifact.kind !== "project" || !revision || revision.digest !== input.digest) {
          throw new AgentError("INVALID_INPUT", "工程输入必须引用本会话真实的冻结工程修订。");
        }
        facts.push({ kind: "project_revision" });
        if (op.kind === "render" && !codeParameters) { sources.push([]); durations.push(0); slotVerified.push(false); }
        continue;
      }
      if (input.kind === "text" || input.kind === "artifact_revision") {
        if (input.kind === "artifact_revision") {
          const key = `${input.artifactId}:${input.revisionId}`;
          if (revisions.get(key) !== input.digest) throw new AgentError("INVALID_INPUT", "操作引用必须在输入来源中且摘要一致。");
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
        if (op.kind === "render" && !codeParameters) {
          if (content.format !== "media") throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受音频修订。" : image ? "图片片段只接受图片修订。" : "视频片段只接受视频修订。");
          const accepted = music ? content.mimeType === "audio/mpeg" || content.mimeType === "audio/wav"
            : audio ? content.mimeType === "audio/mpeg"
            : image ? content.mimeType.startsWith("image/") : content.mimeType === "video/mp4" || content.mimeType === "video/webm";
          if (!accepted) throw new AgentError("INVALID_INPUT", music ? "音乐槽只接受音频修订。" : audio ? "旁白槽只接受音频修订。" : image ? "图片片段只接受图片修订。" : narrated ? "视频画面槽只接受视频修订。" : "有序拼接只接受视频片段。");
          sources.push(blobSources(db, content.blobId));
          const duration = image ? 0 : blobDurationMs(content.blobId);
          durations.push(duration);
          const probe = probes?.get(content.blobId);
          slotVerified.push(image ? (!probes || probe?.ok === true && probe.kind === "image") : duration > 0);
        }
        facts.push(input.kind === "text" ? { kind: "text" } : content.format === "media"
          ? { kind: "artifact_revision", content: { format: "media", blobId: content.blobId, mimeType: content.mimeType } }
          : content.format === "project" ? { kind: "project_revision" }
          : { kind: "artifact_revision", content: { format: "markdown" } });
      } else {
        const producer = operations.get(input.producerOperationId);
        if (!producer || producer.outputSlot !== input.outputSlot) throw new AgentError("INVALID_INPUT", "操作输出引用不存在。");
        if (op.kind === "render" && !codeParameters) {
          const accepted = audio ? producer.kind === "speech" : image ? producer.kind === "image" : producer.kind === "video" || producer.kind === "render";
          if (!accepted) {
            throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受配音输出。" : image ? "图片片段只接受图片生成输出。" : narrated ? "视频画面槽不能引用图片或配音输出。" : "有序拼接不能把图片或配音当作视频片段。");
          }
        }
        facts.push({ kind: "operation_output", producerKind: producer.kind });
        visit(producer.operationId);
        if (op.kind === "render" && !codeParameters) sources.push(operationSources.get(producer.operationId)!);
        if (op.kind === "render" && !codeParameters) {
          durations.push(image ? 0 : durationBounds.get(producer.operationId) ?? 0);
          slotVerified.push(image ? true : durationVerified.get(producer.operationId) ?? false);
        }
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
        if (!blobId) throw new AgentError("INVALID_INPUT", "音乐槽必须引用本会话已登记的音频文件。");
        // candidateId 只在音乐来自素材库已采用文件时给出；本地已登记音频（如程序音乐）不带，
        // 来源事实由所引用的音频对象自身携带，不伪造外部候选。
        const source = music.candidateId === undefined ? null : readAdoptedAudioSource(db, scope, music.candidateId, blobId);
        if (music.sourceStartMs + music.sourceDurationMs > durations[music.inputSlot]!) {
          throw new AgentError("INVALID_INPUT", "音乐选区超出实际音频时长。");
        }
        if ((!music.repeat && music.playDurationMs > music.sourceDurationMs) || music.timelineStartMs + music.playDurationMs > timedTargetMs) {
          throw new AgentError("INVALID_INPUT", "音乐播放超出选区或画面时长；不足时请明确是否循环，不自动循环或延长画面。");
        }
        if (music.fadeInMs + music.fadeOutMs > music.playDurationMs) {
          throw new AgentError("INVALID_INPUT", "音乐淡入与淡出总长不能超过播放时长。");
        }
        if (source) {
          const frozenSource = { ...source,
            ...(source.attributionText ? { attributionText: `${source.attributionText}\n本视频对音乐进行了选段、音量调整与混音。` } : {}) };
          musicSources.set(id, frozenSource);
          sources[music.inputSlot] = music.gain > 0 ? [frozenSource] : [];
        } else {
          sources[music.inputSlot] = music.gain > 0 ? sources[music.inputSlot]! : [];
        }
      }
      renderParameters.set(id, { ...mixedParameters,
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
    } else if (codeParameters) {
      // code_project 输出时长由冻结工程运行决定：无静态上界，也不进预计成片披露。
      durationBounds.set(id, 0);
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
    if (parameters && !mixedParameters) renderParameters.set(id, parameters);
    trusted.set(id, facts);
    visiting.delete(id); visited.add(id);
  };
  for (const op of operationRequests) visit(op.operationId);
  return { validation: { trusted, textCodepoints, ...(probes ? { renderFileProbes: probes } : {}) }, renderParameters, musicSources,
    durationBounds, durationVerified, hasUnusedRevisions: used.size !== revisions.size };
}

// prepare_production 单事务：校验输入来源与认可 → 服务端解析报价 → 落库提案 → 事件。
// 供 Pi 工具与 HTTP prepareProposal 共用；调用方负责自己的幂等键与真实 requestSource 注入。
// probes 由调用方在事务外用 ffprobe 预先取得（付费前探测已有渲染输入文件）。
export function applyPrepareProposal(
  db: AgentDatabase,
  now: string,
  scope: { ownerId: string; conversationId: string },
  intent: ProductionIntent,
  catalog: QuoteCatalog,
  requestSource: RequestSource,
  probes?: Map<string, RenderFileProbe>,
  replacesProposal?: ProposalRef,
): { proposal: ProposalRow; replayed: boolean } {
  const work = intent.workId === null ? null : requireWork(db, scope.ownerId, scope.conversationId, intent.workId);
  // 实际输入与必要认可分开解析（§4.2.1）：inputSources 是执行输入清单，reviewInputs 是受理依据。
  const inputSources = intent.inputSources.map(source => resolveContentSource(db, scope, source));
  const reviewInputs = intent.reviewInputs.map(input =>
    verifyReviewInput(db, scope, input, intent.workId === null ? undefined : { workId: intent.workId }));
  const { validation, renderParameters, musicSources, durationBounds, durationVerified, hasUnusedRevisions } = normalizeOperationInputs(db, scope, inputSources, intent.operations, catalog, probes);
  if (hasUnusedRevisions) throw new AgentError("INVALID_INPUT", "输入来源中存在未被使用的修订。");
  const operations = new Map(intent.operations.map(op => [op.operationId, op]));
  const final = operations.get(intent.finalOutput.operationId);
  if (!final || final.outputSlot !== intent.finalOutput.outputSlot) throw new AgentError("INVALID_INPUT", "最终输出不存在。");
  const finalIsVideo = finalOutputIsVideo(final);
  if (finalIsVideo) {
    // 新视频与视频 render 必须落在已正式开始的视频创作内；正式制作还需要组审阅认可（blocker 在投影中共用推导）。
    if (!work) throw new AgentError("INVALID_INPUT", "视频制作必须关联已正式开始的视频创作；请先开始一条视频并完成组审阅。");
    // 最终视频提案必须声明确切交付目标（F02）：目标属于 intent.workId 在准备入口一次核对；
    // create 声明不写占位草稿、受理时才分配身份；非视频制作不带目标。
    if (intent.outputTarget == null) {
      throw new AgentError("INVALID_INPUT", "正式视频制作必须声明交付到哪个审阅事项（spec.outputTarget），不能隐式猜测输出位置。");
    }
    const declared = intent.outputTarget;
    if (declared.group.mode === "existing") {
      const groupId = declared.group.groupId;
      const group = parseCreationState(work).groups.find(entry => entry.id === groupId);
      if (!group) throw new AgentError("INVALID_INPUT", "输出目标所属的审阅组不存在。");
      if (declared.item.mode === "existing") {
        const itemId = declared.item.itemId;
        const item = group.items.find(entry => entry.id === itemId);
        if (!item) throw new AgentError("INVALID_INPUT", "输出目标事项不存在。");
        if (roleKindConstraint(item.role) !== "video") throw new AgentError("INVALID_INPUT", `输出目标「${item.label}」不接收视频成稿。`);
      } else if (roleKindConstraint(declared.item.role) !== "video") {
        throw new AgentError("INVALID_INPUT", `输出目标「${declared.item.label}」不接收视频成稿。`);
      }
    } else if (declared.item.role !== undefined && roleKindConstraint(declared.item.role) !== "video") {
      throw new AgentError("INVALID_INPUT", `输出目标「${declared.item.label}」不接收视频成稿。`);
    }
  } else if (intent.outputTarget != null) {
    throw new AgentError("INVALID_INPUT", "只有最终视频制作才声明输出目标。");
  }
  const spec = resolveSpec(intent, catalog, requestSource, inputSources, reviewInputs, validation);
  for (const operation of spec.operations) {
    if (operation.kind !== "render" || operation.parameters.assembly !== "mixed_concat") continue;
    operation.parameters = renderParameters.get(operation.operationId)!;
    const musicSource = musicSources.get(operation.operationId);
    if (musicSource) operation.musicSource = musicSource;
  }
  validateProductionAudio(db, spec);
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
    const productionScope = (value: ProductionSpec) => canonicalJson({ workId: value.workId, purpose: value.purpose, scope: value.scope,
      inputSources: value.inputSources, reviewInputs: value.reviewInputs, finalOutput: value.finalOutput,
      operations: value.operations.map(({ quotePerAttempt: _quote, priceKind: _price, ...operation }) => operation) });
    if (productionScope(previous) !== productionScope(spec)) {
      throw new AgentError("PROPOSAL_STALE", "替换报价必须属于同一事项、准确方案和制作范围；不同作品或方案请准备独立报价。");
    }
    // 目标单列比较（窄替换例外）：旧报价缺目标且其余范围一致时，允许补入已核对的新目标；
    // 已有目标的替换必须落在同一交付位置，不能借替换换目的地。
    const previousTarget: ProductionSpec["outputTarget"] = "outputTarget" in previous ? previous.outputTarget ?? null : null;
    if (previousTarget != null && canonicalJson(previousTarget) !== canonicalJson(spec.outputTarget ?? null)) {
      throw new AgentError("PROPOSAL_STALE", "替换报价必须落在原报价的同一交付位置；要换输出目标请准备独立报价。");
    }
  }
  // 命令/工具调用层已经保证幂等。新的明确准备产生新提案，不能被过期的同内容提案吸收。
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL)`,
  ).run(proposalId, scope.conversationId, scope.ownerId, digestOf(spec), canonicalJson(spec), insufficientReplacement ? "stale" : "ready", disclosure, expiresAt, seq, now, now);
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
  requestSource: RequestSource,
  inputSources: ContentSource[],
  reviewInputs: ReviewInput[],
  ctx: CatalogValidationContext,
): ProductionSpec {
  return {
    workId: intent.workId,
    title: intent.title,
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
    inputSources,
    reviewInputs,
    purpose: intent.purpose,
    outputTarget: intent.outputTarget ?? null,
    scope: intent.scope,
    type: "paid_production",
    requestSource,
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
