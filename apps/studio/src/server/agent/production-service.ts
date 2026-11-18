import type {
  AcceptProposal, AdmissionReceipt, CancelReceipt, CancelRun, FrozenReviewTarget,
  LocalCreationReceipt, LocalCreationSpec, LocalRenderOperation, MessageInput, OperationRequest, RequestReceipt, Run,
  ToolRenderProject,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { type EventHub, insertEvent } from "./event-log.js";
import {
  acceptanceBlockerFor, finalOutputIsVideo, getArtifactRow, getProposalRow, getRevisionRow, missingApprovalText, missingRequiredApprovals,
  normalizeOperationInputs, validateProductionAudio, verifyReviewInput, type QuoteCatalog, type RenderFileProbe,
} from "./artifact-store.js";
import {
  parseCreationState, requireWork, resolveContentSource, workInFlight, writeWorkState,
  type StoredReviewGroup, type StoredReviewItem,
} from "./creative-work.js";
import { checkCommandReceipt, emptyReferences, insertMessage, insertQueuedRequest, nextQueueSeq, nextSeq, requireConversation, storeCommandReceipt, touchConversation } from "./conversation-store.js";
import { canonicalJson, digestOf, newAgentId, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";
import { ProductionBlobs } from "./production-blobs.js";
import { runRow, terminal, toRun, type RunRow } from "./production-store.js";

export type ProductionCrashPoint = "before-admission-commit" | "after-admission-commit" | "after-attempt-prepared" | "after-submit-started" | "before-result-commit" | "after-result-commit";
export type ProductionCrashHook = (point: ProductionCrashPoint) => void;

export class ProductionService {
  constructor(private readonly db: AgentDatabase, private readonly clock: AgentClock, private readonly hub: EventHub,
    private readonly catalog: () => QuoteCatalog, readonly blobs: ProductionBlobs,
    private readonly crash: ProductionCrashHook = () => {}, private readonly enabled = true) {}

  accept(ownerId: string, proposalId: string, input: AcceptProposal): AdmissionReceipt {
    const check = validatorFor("AcceptProposal")(input);
    if (!check.ok) throw new AgentError("INVALID_INPUT", check.message);
    const result = this.db.transaction(() => {
      this.requireProposal(ownerId, proposalId);
      const key = { ownerId, operation: "acceptProposal", targetId: proposalId, commandId: input.commandId };
      const prior = checkCommandReceipt<AdmissionReceipt>(this.db, key, input);
      if (prior.kind === "replay") return { ...prior.receipt, replayed: true };
      const { run, replayed } = this.admit(ownerId, proposalId, input.proposalDigest, "proposal_button", input);
      if (!replayed) this.announceAdmission(run);
      const receipt: AdmissionReceipt = { receiptId: newAgentId("rcp"), replayed, run: toRun(this.db, run) };
      storeCommandReceipt(this.db, this.clock(), key, input, receipt);
      this.crash("before-admission-commit");
      return receipt;
    })();
    this.crash("after-admission-commit");
    this.hub.notifyCommitted(result.run.conversationId);
    return result;
  }

  acceptMessage(ownerId: string, conversationId: string, input: MessageInput): RequestReceipt {
    const result = this.db.transaction(() => {
      requireConversation(this.db, ownerId, conversationId);
      const proposal = this.requireProposal(ownerId, input.proposalRef!.proposalId);
      if (proposal.conversation_id !== conversationId) throw new AgentError("NOT_FOUND", "当前会话中没有这个提案。");
      const key = { ownerId, operation: "sendMessage", targetId: conversationId, commandId: input.commandId };
      const prior = checkCommandReceipt<RequestReceipt>(this.db, key, input);
      if (prior.kind === "replay") return { ...prior.receipt, replayed: true };
      const { run, replayed } = this.admit(ownerId, proposal.id, input.proposalRef!.digest, "bound_confirmation_message", input);
      const now = this.clock(), requestId = newAgentId("req"), messageId = newAgentId("msg");
      insertMessage(this.db, now, { id: messageId, ownerId, conversationId, requestId, role: "user", kind: "chat", state: "completed",
        text: input.text, target: null, createdSeq: nextSeq(this.db, "messages", conversationId),
        references: { ...emptyReferences(), proposalIds: [proposal.id], runIds: [run.id] } });
      insertQueuedRequest(this.db, now, { id: requestId, ownerId, conversationId, commandId: input.commandId, text: input.text,
        target: null, skillId: null, modelId: null, queueSeq: nextQueueSeq(this.db, conversationId), messageId });
      this.db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(requestId);
      if (!replayed) this.announceAdmission(run);
      const receipt: RequestReceipt = { receiptId: newAgentId("rcp"), requestId, messageId, state: "completed", replayed: false, runId: run.id };
      storeCommandReceipt(this.db, now, key, input, receipt);
      this.crash("before-admission-commit");
      return receipt;
    })();
    this.crash("after-admission-commit");
    this.hub.notifyCommitted(conversationId);
    return result;
  }

  // 两种可信用户入口共用这个事务内核。Pi 只有 prepare 工具，拿不到此受理入口。
  private admit(ownerId: string, proposalId: string, digest: string, source: string, action: unknown): { run: RunRow; replayed: boolean } {
    const proposal = this.requireProposal(ownerId, proposalId);
    if (proposal.digest !== digest) throw new AgentError("PROPOSAL_STALE", "提案内容不一致，请重新查看。");
    if (proposal.accepted_run_id) return { run: this.requireRun(ownerId, proposal.accepted_run_id), replayed: true };
    if (!this.enabled) throw new AgentError("CAPABILITY_UNAVAILABLE", "制作能力尚未接入，暂不能受理这份提案。");
    const now = this.clock();
    if (proposal.state !== "ready" || proposal.expires_at <= now) throw new AgentError("PROPOSAL_STALE", "提案已失效，请重新准备。");
    const spec = JSON.parse(proposal.spec_json) as import("../../shared/agent/generated/contracts.js").ProductionSpec
      | import("../../shared/agent/generated/contracts.js").LegacyProductionSpec;
    // 受理前置条件与投影同一推导（G1-1）：能力/报价漂移、输入漂移、必要认可缺口在此拒绝；
    // blob 存在性、预算复核与目标冻结仍属本受理事务。
    const blocker = acceptanceBlockerFor(this.db, ownerId, proposal, this.catalog());
    if (blocker) throw new AgentError("PROPOSAL_STALE", blocker.message);
    const modern = "type" in spec;
    const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId && op.outputSlot === spec.finalOutput.outputSlot);
    if (!final) throw new AgentError("PROPOSAL_STALE", "提案的最终输出已失效，请重新准备。");
    const finalIsVideo = finalOutputIsVideo(final);
    // 快照里声明的实际输入修订与媒体 blob：受理只复核仍可用的冻结事实，不读最新稿。
    // 新付费 spec 核对准确修订的 digest（冻结版本可用即可，新稿不阻断在途运行）；
    // 旧 spec 沿原 head 一致性（其受理语义建立在“内容仍是最新版”上）。
    if (modern) {
      for (const source of spec.inputSources) {
        if (source.kind !== "artifact_revision") continue;
        const artifact = getArtifactRow(this.db, ownerId, source.artifactId);
        const revision = artifact ? getRevisionRow(this.db, source.artifactId, source.revisionId) : undefined;
        if (!artifact || artifact.conversation_id !== proposal.conversation_id || !revision || revision.digest !== source.digest) {
          throw new AgentError("PROPOSAL_STALE", "输入内容已更新，请重新准备提案。");
        }
        const content = JSON.parse(revision.content_json) as import("../../shared/agent/generated/contracts.js").ArtifactRevision["content"];
        if (content.format === "media") this.blobs.verify(this.blobs.get(ownerId, content.blobId));
      }
    } else {
      for (const ref of spec.inputRevisions) {
        const artifact = getArtifactRow(this.db, ownerId, ref.artifactId);
        if (!artifact || artifact.conversation_id !== proposal.conversation_id || artifact.head_revision_id !== ref.revisionId) throw new AgentError("PROPOSAL_STALE", "输入内容已更新，请重新准备提案。");
        const revision = getRevisionRow(this.db, ref.artifactId, ref.revisionId)!;
        const content = JSON.parse(revision.content_json) as import("../../shared/agent/generated/contracts.js").ArtifactRevision["content"];
        if (content.format === "media") this.blobs.verify(this.blobs.get(ownerId, content.blobId));
      }
    }
    for (const op of spec.operations) for (const input of op.inputs) {
      if (input.kind === "project_revision") {
        // code_project 的工程数据输入：核对冻结修订仍可用；执行语义在端口内展开。
        const revision = getRevisionRow(this.db, input.projectRevision.artifactId, input.projectRevision.revisionId);
        if (!revision || revision.digest !== input.digest) throw new AgentError("PROPOSAL_STALE", "工程输入已更新，请重新准备提案。");
        continue;
      }
      if (input.kind !== "blob") continue;
      const blob = this.blobs.get(ownerId, input.blobId);
      if (blob.digest !== input.digest || blob.conversation_id !== proposal.conversation_id) throw new AgentError("PROPOSAL_STALE", "媒体输入已失效。");
      this.blobs.verify(blob);
    }
    const total = spec.operations.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
    if (total > spec.maxSpend.amountMinor) throw new AgentError("BUDGET_INSUFFICIENT", "授权金额不足以覆盖提案内的操作与尝试次数。");
    // 视频制作只能受理已正式开始的视频创作；新组模型的认可依据在 prepare 已核对（blocker）。
    if (finalIsVideo && spec.workId === null) throw new AgentError("PROPOSAL_STALE", "视频制作必须关联已正式开始的视频创作，请重新准备提案。");
    // 独立图片/配音只保留既有运行归属，不创建审阅事项。
    const workId = spec.workId ?? newAgentId("work");
    if (!spec.workId) this.db.prepare("INSERT INTO works(id,owner_id,conversation_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(workId, ownerId, proposal.conversation_id, spec.title, now, now);
    let frozenTarget: FrozenReviewTarget | null = null;
    if (spec.workId) {
      const work = requireWork(this.db, ownerId, proposal.conversation_id, workId);
      if (workInFlight(this.db, workId)) throw new AgentError("RUN_BUSY", "这件作品已经在制作中。");
      // 输出目标按提案声明在受理时冻结（F02）：existing 读受理时真实当前 draft 作基准；
      // create 在本事务一次分配身份（不写占位草稿）；非视频输出不冻结任何审阅事项，
      // 后继草稿不因受理被覆盖（§4.2.1）。目标存在性在本事务复核一次，不重验整份声明。
      if (modern && finalIsVideo) {
        const declared = spec.outputTarget ?? null;
        if (!declared) throw new AgentError("PROPOSAL_STALE", "需要明确交付位置，请重新准备。");
        const state = parseCreationState(work);
        const existingGroupId = declared.group.mode === "existing" ? declared.group.groupId : null;
        let group = existingGroupId != null
          ? state.groups.find(entry => entry.id === existingGroupId) : undefined;
        if (declared.group.mode === "create") {
          group = { id: newAgentId("grp"), title: declared.group.title, revision: 1, items: [], nextIntent: declared.group.nextIntent ?? null };
          state.groups.push(group);
        }
        if (!group) throw new AgentError("PROPOSAL_STALE", "报价的交付目标组已不存在，请重新准备提案。");
        let itemId = declared.item.mode === "existing" ? declared.item.itemId : null;
        if (declared.item.mode === "create") {
          const item: StoredReviewItem = { id: newAgentId("item"), label: declared.item.label, role: declared.item.role, required: declared.item.required,
            draft: null, approved: null, confirmationId: null, approvedAt: null };
          group.items.push(item);
          group.revision += 1;
          itemId = item.id;
        }
        const item = group.items.find(item => item.id === itemId);
        if (!item) throw new AgentError("PROPOSAL_STALE", "报价的交付目标事项已不存在，请重新准备提案。");
        if (declared.group.mode === "create" || declared.item.mode === "create") writeWorkState(this.db, now, work, state);
        frozenTarget = { groupId: group.id, itemId: item.id,
          baseRevisionId: item.draft?.kind === "artifact_revision" ? item.draft.revisionId : null };
      }
    }
    // 事务顺序：核对 → 本次可信 user_action → 授权/run/locks。后续任何失败整体回滚。
    const runId = newAgentId("run"), snapshotId = newAgentId("snp"), actionId = newAgentId("act");
    this.db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES(?,?,?,?)").run(snapshotId, proposal.spec_json, digestOf(spec), now);
    this.db.prepare("INSERT INTO user_actions(id,owner_id,proposal_id,source,body_json,created_at) VALUES(?,?,?,?,?,?)").run(actionId, ownerId, proposalId, source, canonicalJson(action), now);
    this.db.prepare("INSERT INTO authorizations(id,proposal_id,action_id,run_id,max_minor) VALUES(?,?,?,?,?)").run(newAgentId("auth"), proposalId, actionId, runId, spec.maxSpend.amountMinor);
    const seq = (this.db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM production_runs WHERE conversation_id=?").get(proposal.conversation_id) as { n: number }).n;
    this.db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,source_request_id,title,frozen_target_json,state,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?,'queued',?,?,?)")
      .run(runId, ownerId, proposal.conversation_id, workId, snapshotId, proposalId, spec.title, frozenTarget ? canonicalJson(frozenTarget) : null, seq, now, now);
    const lockedArtifacts = modern
      ? spec.inputSources.flatMap(source => source.kind === "artifact_revision" ? [source.artifactId] : [])
      : spec.inputRevisions.map(ref => ref.artifactId);
    for (const op of spec.operations) for (const input of op.inputs) {
      if (input.kind === "project_revision") lockedArtifacts.push(input.projectRevision.artifactId);
    }
    for (const artifactId of lockedArtifacts) this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)").run(runId, artifactId);
    for (const op of spec.operations) this.db.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES(?,?,?)").run(runId, op.operationId, canonicalJson(op));
    this.db.prepare("UPDATE proposals SET state='accepted', accepted_run_id=?, revision=revision+1, updated_at=? WHERE id=?").run(runId, now, proposalId);
    insertEvent(this.db, now, { ownerId, conversationId: proposal.conversation_id, kind: "proposal.changed", entityId: proposalId, entityVersion: proposal.revision + 1 });
    insertEvent(this.db, now, { ownerId, conversationId: proposal.conversation_id, kind: "run.changed", entityId: runId, entityVersion: 1 });
    return { run: runRow(this.db, runId), replayed: false };
  }

  // render_project 的本地受理（§4.2.1）：免费动作不建提案/授权/账单；真实请求来源由调用方从
  // 当前请求注入。目标在同一事务内解析或分配并随操作冻结，新事项尚无草稿、只展示“制作中”。
  admitLocalRender(ownerId: string, conversationId: string, request: { requestId: string; messageId: string }, intent: ToolRenderProject, probes?: Map<string, RenderFileProbe>): LocalCreationReceipt {
    if (!this.enabled) throw new AgentError("CAPABILITY_UNAVAILABLE", "制作能力尚未接入，暂不能受理这次本地制作。");
    return this.db.transaction(() => {
      requireConversation(this.db, ownerId, conversationId);
      const work = requireWork(this.db, ownerId, conversationId, intent.workId);
      if (workInFlight(this.db, work.id)) throw new AgentError("RUN_BUSY", "这件作品已经在制作中。");
      const scope = { ownerId, conversationId };
      const inputSources = intent.inputSources.map(source => resolveContentSource(this.db, scope, source));
      const reviewInputs = intent.reviewInputs.map(input => verifyReviewInput(this.db, scope, input, { workId: work.id }));
      const lastOperation = intent.operations[intent.operations.length - 1]!;
      // 认可门覆盖整个受理批次：视频输出不在最后一项时（如成片后追加封面图）同样受正式认可约束。
      if (intent.purpose === "production" && intent.operations.some(op => op.parameters.assembly !== "code_project" || op.parameters.expectedMediaKind === "video")) {
        if (reviewInputs.length === 0) {
          throw new AgentError("INVALID_INPUT", "正式视频制作需要先获得组审阅认可，再发起这次渲染。");
        }
        // 覆盖核对与付费受理同一推导（§11.5.4）：实际消费的必选依据各要有真实确认行。
        const missing = missingRequiredApprovals(this.db, scope, work.id, {
          revisions: [
            ...inputSources.flatMap(source => source.kind === "artifact_revision" ? [{ artifactId: source.artifactId, revisionId: source.revisionId }] : []),
            ...intent.operations.flatMap(op => op.inputs.flatMap(input =>
              input.kind === "artifact_revision" ? [{ artifactId: input.artifactId, revisionId: input.revisionId }] : [])),
          ],
          projects: intent.operations.flatMap(op => [
            ...(op.parameters.assembly === "code_project" ? [{ artifactId: op.parameters.projectRevision.artifactId, revisionId: op.parameters.projectRevision.revisionId }] : []),
            ...op.inputs.flatMap(input => input.kind === "project_revision"
              ? [{ artifactId: input.projectRevision.artifactId, revisionId: input.projectRevision.revisionId }] : []),
          ]),
        });
        if (missing.length > 0) {
          throw new AgentError("INVALID_INPUT", `正式渲染采用的「${missingApprovalText(missing).join("」「")}」这一版还未获得认可，请先认可实际采用的版本。`);
        }
      }
      // 目标解析/分配：existing 必须已存在；create 的 key 只在本次受理内分配一次并写入作品状态。
      const state = parseCreationState(work);
      const createdGroups = new Map<string, StoredReviewGroup>();
      const createdItems = new Map<string, { groupId: string; itemId: string }>();
      const metadataChanged = new Set<StoredReviewGroup>();
      const resolveTarget = (operation: ToolRenderProject["operations"][number]): FrozenReviewTarget => {
        const groupDecl = operation.target.group;
        let group = groupDecl.mode === "existing"
          ? state.groups.find(group => group.id === groupDecl.groupId)
          : createdGroups.get(groupDecl.key);
        if (!group && groupDecl.mode === "create") {
          group = { id: newAgentId("grp"), title: groupDecl.title, revision: 1, items: [], nextIntent: groupDecl.nextIntent };
          state.groups.push(group);
          createdGroups.set(groupDecl.key, group);
        }
        if (!group) throw new AgentError("NOT_FOUND", "渲染目标所属的审阅组不存在。");
        if (groupDecl.mode === "existing") {
          if (groupDecl.title !== undefined && groupDecl.title !== group.title) { group.title = groupDecl.title; metadataChanged.add(group); }
          if (groupDecl.nextIntent !== undefined && groupDecl.nextIntent !== group.nextIntent) { group.nextIntent = groupDecl.nextIntent; metadataChanged.add(group); }
        }
        const itemDecl = operation.target.item;
        let itemId = itemDecl.mode === "existing" ? itemDecl.itemId : createdItems.get(itemDecl.key)?.itemId;
        const existingItem = itemId ? group.items.find(item => item.id === itemId) : undefined;
        // 基准从受理时真实 item.draft 冻结（§11.6 S4）：调用者省略 baseRevisionId 不当作“此前无稿”；
        // 显式给出的已读基准与当前事实不同时如实拒绝，不悄悄接受后覆盖后继稿。
        let baseRevisionId: string | null = null;
        if (itemDecl.mode === "existing") {
          if (!existingItem) throw new AgentError("NOT_FOUND", "渲染目标事项不存在。");
          // 事项呈现属性允许同次受理内更新；成员/required 变化随组版本对用户可见。
          if (itemDecl.label !== undefined && itemDecl.label !== existingItem.label) { existingItem.label = itemDecl.label; metadataChanged.add(group); }
          if (itemDecl.role !== undefined && itemDecl.role !== existingItem.role) { existingItem.role = itemDecl.role; metadataChanged.add(group); }
          if (itemDecl.required !== undefined && itemDecl.required !== existingItem.required) { existingItem.required = itemDecl.required; metadataChanged.add(group); }
          baseRevisionId = existingItem.draft?.kind === "artifact_revision" ? existingItem.draft.revisionId : null;
          if (operation.baseRevisionId !== undefined && operation.baseRevisionId !== baseRevisionId) {
            throw new AgentError("STALE_REVISION", `渲染目标「${existingItem.label}」的草稿已不是给出的基准版本，请基于当前版本重新发起渲染。`);
          }
        }
        if (itemDecl.mode === "create" && !itemId) {
          const item: StoredReviewItem = { id: newAgentId("item"), label: itemDecl.label, role: itemDecl.role, required: itemDecl.required,
            draft: null, approved: null, confirmationId: null, approvedAt: null };
          group.items.push(item);
          group.revision += 1;
          itemId = item.id;
          createdItems.set(itemDecl.key, { groupId: group.id, itemId });
        }
        if (!itemId || !group.items.some(item => item.id === itemId)) throw new AgentError("INVALID_INPUT", "渲染目标事项与审阅组不一致。");
        return { groupId: group.id, itemId, baseRevisionId };
      };
      const catalog = this.catalog();
      const requestedOperations: Extract<OperationRequest, { kind: "render" }>[] = intent.operations.map(operation => ({
        operationId: operation.operationId, outputSlot: operation.outputSlot, inputs: operation.inputs,
        kind: "render", model: null, maxCreateAttempts: 1, parameters: operation.parameters,
      }));
      const { validation, renderParameters, musicSources } = normalizeOperationInputs(this.db, scope, inputSources, requestedOperations, catalog, probes);
      const operations: LocalRenderOperation[] = [];
      const projectArtifactIds: string[] = [];
      for (const operation of intent.operations) {
        const parameters = renderParameters.get(operation.operationId)!;
        if (parameters.assembly === "code_project") {
          projectArtifactIds.push(parameters.projectRevision.artifactId);
        } else {
          const entry = catalog[`render:${parameters.assembly}`];
          if (!entry || entry.binding !== null) throw new AgentError("CAPABILITY_UNAVAILABLE", "本地合成能力尚未启用，不能受理这次渲染。");
          const requested = requestedOperations.find(op => op.operationId === operation.operationId)!;
          entry.validate?.(requested, validation.trusted.get(operation.operationId), validation);
        }
        const musicSource = musicSources.get(operation.operationId);
        operations.push({ operationId: operation.operationId, outputSlot: operation.outputSlot, inputs: operation.inputs,
          kind: "render", model: null, parameters, ...(musicSource ? { musicSource } : {}), target: resolveTarget(operation) });
      }
      const spec: LocalCreationSpec = { type: "local_creation", workId: work.id, title: intent.title,
        requestSource: { requestId: request.requestId, messageId: request.messageId },
        scope: intent.scope, purpose: intent.purpose, inputSources, reviewInputs,
        operations: operations as LocalCreationSpec["operations"],
        finalOutput: { operationId: lastOperation.operationId, outputSlot: lastOperation.outputSlot } };
      validateProductionAudio(this.db, spec);
      // 元数据实际变化才升组版本；同一受理内同组只升一次（新事项沿既有直接提升）。
      for (const changed of metadataChanged) changed.revision += 1;
      writeWorkState(this.db, this.clock(), work, state);
      const now = this.clock();
      const runId = newAgentId("run"), snapshotId = newAgentId("snp");
      this.db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES(?,?,?,?)").run(snapshotId, canonicalJson(spec), digestOf(spec), now);
      const seq = (this.db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM production_runs WHERE conversation_id=?").get(conversationId) as { n: number }).n;
      this.db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,source_request_id,title,frozen_target_json,state,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?,NULL,'queued',?,?,?)")
        .run(runId, ownerId, conversationId, work.id, snapshotId, request.requestId, intent.title, seq, now, now);
      for (const source of inputSources) if (source.kind === "artifact_revision") {
        this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)").run(runId, source.artifactId);
      }
      for (const artifactId of projectArtifactIds) this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)")
        .run(runId, artifactId);
      for (const operation of operations) this.db.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES(?,?,?)")
        .run(runId, operation.operationId, canonicalJson(operation));
      insertEvent(this.db, now, { ownerId, conversationId, kind: "run.changed", entityId: runId, entityVersion: 1 });
      const run = runRow(this.db, runId);
      return { run: toRun(this.db, run),
        reviewTargets: operations.map(op => ({ operationId: op.operationId, groupId: op.target.groupId, itemId: op.target.itemId })) as LocalCreationReceipt["reviewTargets"] };
    })();
  }

  // 两个入口都在受理事务中发布；绑定确认先保存用户消息，再追加受理通知。
  private announceAdmission(run: RunRow): void {
    const now = this.clock();
    insertMessage(this.db, now, { id: newAgentId("msg"), ownerId: run.owner_id, conversationId: run.conversation_id, requestId: null,
      role: "system_notice", kind: "notice", state: "completed",
      text: `“${run.title}”已受理，输入版本已锁定。制作在后台继续，你可以聊其他话题。`, target: null,
      createdSeq: nextSeq(this.db, "messages", run.conversation_id),
      references: { ...emptyReferences(), proposalIds: [run.proposal_id!], runIds: [run.id] } });
    touchConversation(this.db, now, run.conversation_id);
  }

  get(ownerId: string, id: string): Run { return toRun(this.db, this.requireRun(ownerId, id)); }
  requireRun(ownerId: string, id: string): RunRow {
    const row = runRow(this.db, id);
    if (row.owner_id !== ownerId) throw new AgentError("NOT_FOUND", "没有找到这个运行。");
    return row;
  }
  private requireProposal(ownerId: string, id: string) {
    const proposal = getProposalRow(this.db, ownerId, id);
    if (!proposal) throw new AgentError("NOT_FOUND", "没有找到这个提案。");
    return proposal;
  }

  cancel(ownerId: string, id: string, input: CancelRun): CancelReceipt {
    const check = validatorFor("CancelRun")(input);
    if (!check.ok) throw new AgentError("INVALID_INPUT", check.message);
    const receipt = this.db.transaction(() => {
      const run = this.requireRun(ownerId, id);
      const key = { ownerId, operation: "cancelRun", targetId: id, commandId: input.commandId };
      const prior = checkCommandReceipt<CancelReceipt>(this.db, key, input);
      if (prior.kind === "replay") return { ...prior.receipt, replayed: true };
      if (input.expectedRevision !== run.revision) throw new AgentError("STALE_REVISION", "制作状态已更新，请刷新后重试。");
      const ended = terminal(run.state);
      if (!ended && run.state !== "cancel_requested") {
        this.db.prepare("UPDATE production_runs SET state='cancel_requested',revision=revision+1,updated_at=? WHERE id=?").run(this.clock(), id);
        insertEvent(this.db, this.clock(), { ownerId, conversationId: run.conversation_id, kind: "run.changed", entityId: id, entityVersion: run.revision + 1 });
      }
      const result: CancelReceipt = { receiptId: newAgentId("rcp"), replayed: false, run: this.get(ownerId, id), cancellation: ended ? "already_terminal" : "requested" };
      storeCommandReceipt(this.db, this.clock(), key, input, result);
      return result;
    })();
    this.hub.notifyCommitted(receipt.run.conversationId);
    return receipt;
  }
}
