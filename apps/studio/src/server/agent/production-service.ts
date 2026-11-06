import type { AcceptProposal, AdmissionReceipt, CancelReceipt, CancelRun, MessageInput, RequestReceipt, Run } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { type EventHub, insertEvent } from "./event-log.js";
import { getArtifactRow, getProposalRow, getRevisionRow, operationQuoteMinor, proposalPlanSource, validatePlanNarration, type QuoteCatalog } from "./artifact-store.js";
import { speechText } from "../../shared/agent/markdown.js";
import type { MarkdownContent } from "../../shared/agent/generated/contracts.js";
import { checkCommandReceipt, emptyReferences, insertMessage, insertQueuedRequest, nextQueueSeq, nextSeq, requireConversation, storeCommandReceipt, touchConversation } from "./conversation-store.js";
import { canonicalJson, digestOf, newAgentId, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";
import { ProductionBlobs } from "./production-blobs.js";
import { runRow, specFor, terminal, toRun, type RunRow } from "./production-store.js";
import {
  isWorkPlanDraftCurrent, markPlanProduced, parseCreationState,
  recordStageConfirmation, requireContentContinued, requireWork, sameContentSource, workInFlight,
} from "./creative-work.js";

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
    const spec = JSON.parse(proposal.spec_json) as import("../../shared/agent/generated/contracts.js").ProductionSpec;
    // 准备时已校验冻结结构；受理事务读当前目录，只复核现在的能力、账号与报价是否仍然有效。
    const catalog = this.catalog();
    for (const op of spec.operations) {
      // render 按 frozen assembly 路由（§10）：accept 与 prepare 落到同一条目。
      const entry = catalog[op.kind === "render" ? `render:${op.parameters.assembly}` : `${op.kind}:${op.model.modelId}`];
      let textCodepoints: number | undefined;
      if (entry?.quoteMinorFor && op.kind === "speech") {
        // 输入形状在 prepare 已验证；受理只读取同一不可变修订的计价事实，不读最新稿。
        const input = op.inputs[0] as Extract<typeof op.inputs[number], { kind: "text" | "artifact_revision" }>;
        const text = input.kind === "text" ? input.text
          : speechText(JSON.parse(getRevisionRow(this.db, input.artifactId, input.revisionId)!.content_json) as MarkdownContent);
        textCodepoints = [...text].length;
      }
      if (!entry || canonicalJson(entry.binding) !== canonicalJson(op.model)
        || operationQuoteMinor(entry, op, textCodepoints) !== op.quotePerAttempt.amountMinor || entry.priceKind !== op.priceKind) {
        throw new AgentError("PROPOSAL_STALE", "模型配置或价格已变化，请重新准备提案。");
      }
      try { entry.validate?.(op); }
      catch (error) {
        if (error instanceof AgentError) throw new AgentError("PROPOSAL_STALE", "当前能力已不再支持这份提案，请重新准备。");
        throw error;
      }
    }
    for (const ref of spec.inputRevisions) {
      const artifact = getArtifactRow(this.db, ownerId, ref.artifactId);
      if (!artifact || artifact.conversation_id !== proposal.conversation_id || artifact.head_revision_id !== ref.revisionId) throw new AgentError("PROPOSAL_STALE", "输入内容已更新，请重新准备提案。");
      const revision = getRevisionRow(this.db, ref.artifactId, ref.revisionId)!;
      const content = JSON.parse(revision.content_json) as import("../../shared/agent/generated/contracts.js").ArtifactRevision["content"];
      if (content.format === "media") this.blobs.verify(this.blobs.get(ownerId, content.blobId));
    }
    for (const op of spec.operations) for (const input of op.inputs) if (input.kind === "blob") {
      const blob = this.blobs.get(ownerId, input.blobId);
      if (blob.digest !== input.digest || blob.conversation_id !== proposal.conversation_id) throw new AgentError("PROPOSAL_STALE", "媒体输入已失效。");
      this.blobs.verify(blob);
    }
    const total = spec.operations.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
    if (total > spec.maxSpend.amountMinor) throw new AgentError("BUDGET_INSUFFICIENT", "授权金额不足以覆盖提案内的操作与尝试次数。");
    const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId && op.outputSlot === spec.finalOutput.outputSlot);
    if (!final) throw new AgentError("PROPOSAL_STALE", "提案的最终输出已失效，请重新准备。");
    const finalIsVideo = final.kind === "video" || final.kind === "render";
    // 新视频/视频 render 只能受理已正式开始的视频创作，且提案必须与方案主稿有准确关联
    // （proposals.plan_source_json 持久事实，交付事务或原样重提继承写入，§10.1）。
    // 普通 Prompt 或聊天原文可以作为内容来源，但不能以 workId=null / 空输入绕过阶段规则。
    const planDraft = finalIsVideo
      ? proposalPlanSource(this.db, ownerId, proposal.conversation_id, proposalId) : null;
    if (finalIsVideo) {
      if (spec.workId === null) throw new AgentError("PROPOSAL_STALE", "视频制作必须关联已正式开始的视频创作，请重新准备提案。");
      if (!planDraft || planDraft.binding.workId !== spec.workId) throw new AgentError("PROPOSAL_STALE", "方案提案尚未与当前方案主稿关联，请先交付方案或重新准备。");
      const work = requireWork(this.db, ownerId, proposal.conversation_id, spec.workId);
      if (!isWorkPlanDraftCurrent(this.db, work, planDraft.source)) throw new AgentError("PROPOSAL_STALE", "方案主稿已更新，请重新准备提案。");
      if (planDraft.source.kind === "artifact_revision") {
        const content = JSON.parse(getRevisionRow(this.db, planDraft.source.artifactId, planDraft.source.revisionId)!.content_json) as MarkdownContent;
        // 换版前的未受理提案没有新字段，只能按该准确旧稿可证明的冻结来源接受。
        if (content.narrationText === undefined) validatePlanNarration(this.db, planDraft.source, spec);
      }
      const state = parseCreationState(work);
      if (planDraft.binding.source && !sameContentSource(planDraft.binding.source, state.content.draft)) {
        throw new AgentError("PROPOSAL_STALE", "内容主稿已更新，请重新准备方案。");
      }
    }
    // 独立图片/配音只保留既有运行归属，不创建三阶段视频事项。
    const workId = spec.workId ?? newAgentId("work");
    if (!spec.workId) this.db.prepare("INSERT INTO works(id,owner_id,conversation_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(workId, ownerId, proposal.conversation_id, spec.title, now, now);
    if (spec.workId) {
      const work = requireWork(this.db, ownerId, proposal.conversation_id, workId);
      requireContentContinued(this.db, work);
      if (workInFlight(this.db, workId)) throw new AgentError("RUN_BUSY", "这件作品已经在制作中。");
    }
    // 事务顺序：核对 → 本次可信 user_action → 方案认可与 work 登记 → 授权/run/locks。
    // 认可内核带在途冻结检查，先于 queued run 写入才不会拦住自身；后续任何失败整体回滚。
    const runId = newAgentId("run"), snapshotId = newAgentId("snp"), actionId = newAgentId("act");
    this.db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES(?,?,?,?)").run(snapshotId, proposal.spec_json, digestOf(spec), now);
    this.db.prepare("INSERT INTO user_actions(id,owner_id,proposal_id,source,body_json,created_at) VALUES(?,?,?,?,?,?)").run(actionId, ownerId, proposalId, source, canonicalJson(action), now);
    if (planDraft) {
      const scope = { ownerId, conversationId: proposal.conversation_id };
      const confirmation = recordStageConfirmation(this.db, now, scope, {
        workId, action: "approve_plan", subject: planDraft.source,
        sourceKind: "proposal_accept", sourceId: actionId,
      });
      markPlanProduced(this.db, now, scope, workId, planDraft.source, proposalId, runId, confirmation.confirmationId);
    }
    this.db.prepare("INSERT INTO authorizations(id,proposal_id,action_id,run_id,max_minor) VALUES(?,?,?,?,?)").run(newAgentId("auth"), proposalId, actionId, runId, spec.maxSpend.amountMinor);
    const seq = (this.db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM production_runs WHERE conversation_id=?").get(proposal.conversation_id) as { n: number }).n;
    this.db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)")
      .run(runId, ownerId, proposal.conversation_id, workId, snapshotId, proposalId, spec.title, seq, now, now);
    for (const ref of spec.inputRevisions) this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)").run(runId, ref.artifactId);
    if (planDraft) {
      // 真实方案主稿必须锁定；内容来自真实修订时连内容一起锁，消息原文不伪造 artifact 锁。
      if (planDraft.source.kind === "artifact_revision") {
        this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)").run(runId, planDraft.source.artifactId);
      }
      if (planDraft.binding.source?.kind === "artifact_revision") {
        this.db.prepare("INSERT OR IGNORE INTO production_input_locks(run_id,artifact_id) VALUES(?,?)").run(runId, planDraft.binding.source.artifactId);
      }
    }
    for (const op of spec.operations) this.db.prepare("INSERT INTO production_operations(run_id,id,spec_json) VALUES(?,?,?)").run(runId, op.operationId, canonicalJson(op));
    this.db.prepare("UPDATE proposals SET state='accepted', accepted_run_id=?, revision=revision+1, updated_at=? WHERE id=?").run(runId, now, proposalId);
    insertEvent(this.db, now, { ownerId, conversationId: proposal.conversation_id, kind: "proposal.changed", entityId: proposalId, entityVersion: proposal.revision + 1 });
    insertEvent(this.db, now, { ownerId, conversationId: proposal.conversation_id, kind: "run.changed", entityId: runId, entityVersion: 1 });
    return { run: runRow(this.db, runId), replayed: false };
  }

  // 两个入口都在受理事务中发布；绑定确认先保存用户消息，再追加受理通知。
  private announceAdmission(run: RunRow): void {
    const now = this.clock();
    insertMessage(this.db, now, { id: newAgentId("msg"), ownerId: run.owner_id, conversationId: run.conversation_id, requestId: null,
      role: "system_notice", kind: "notice", state: "completed",
      text: `“${run.title}”已受理，输入版本已锁定。制作在后台继续，你可以聊其他话题。`, target: null,
      createdSeq: nextSeq(this.db, "messages", run.conversation_id),
      references: { ...emptyReferences(), proposalIds: [run.proposal_id], runIds: [run.id] } });
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
